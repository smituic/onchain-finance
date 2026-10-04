// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bytesToBase64Url } from "@/lib/real/bytes";
import { RESERVED_HANDLES, canonicalizeHandle } from "@/lib/real/handle";
import type { AccountHandleStore } from "@/lib/real/server/account-handles";
import { readAuthenticatedRealAccount } from "@/lib/real/server/auth";
import { beginBackupEnrollment, prepareBackupStepUp } from "@/lib/real/server/backup-passkey-pipeline";
import type { ChallengePurpose, ChallengeStore } from "@/lib/real/server/challenge-store";
import type { RealServerConfig } from "@/lib/real/server/config";
import { completeHandleClaim, prepareHandleClaim, readAccountProfile, readAccountProfileBestEffort, updateAccountDisplayName } from "@/lib/real/server/handle-claim";
import { ACCOUNT_HANDLE_OWNER_KEY, ACCOUNT_HANDLE_PRIMARY_KEY, type NeonDurableStores } from "@/lib/real/server/neon-store";
import type { RealAccountRegistry } from "@/lib/real/server/registry";
import { createSessionPayload, serializeSession } from "@/lib/real/server/session";
import { buildLoginOptions } from "@/lib/real/server/webauthn";
import { checkDisposableTarget, connectSmokeDb, connectSmokeStores, requireDisposableTargetUrl, type SmokeDb } from "./fixtures/handles-smoke-db";
import { buildAuthenticationResponseJSON, createFixtureAuthenticator, type FixtureAuthenticator } from "./fixtures/webauthn";

/**
 * MANUAL, LIVE-DATABASE runtime/concurrency proof of Account Handles: the
 * REAL application code (prepareHandleClaim, completeHandleClaim,
 * updateAccountDisplayName, the profile reads, beginBackupEnrollment) over the
 * REAL Neon adapters (createNeonDurableStores), against a DISPOSABLE Neon
 * branch whose `public` already carries the Handles migration. WebAuthn
 * ceremonies are answered by fixture authenticators (genuine signatures,
 * verified by the real library); nothing talks to Turnkey or a browser.
 *
 * DISPOSABLE BRANCH ONLY. It never reads DATABASE_URL: the target is
 * NEON_BRANCH_DATABASE_URL, and it refuses to connect unless that endpoint
 * differs from the real database's (.env.local), DATABASE_URL is not exported,
 * and no admin or other smoke gate is set.
 *
 * IT LEAVES ROWS BEHIND, ON PURPOSE. Handle rows can never be deleted — that
 * is the design under test — so the fixture accounts, passkeys, and the
 * handles they claim stay on the branch (all under one run-unique prefix).
 * The branch itself is the cleanup boundary. Nothing here ever updates,
 * deletes, or truncates the registry, or weakens its guard.
 *
 *   REAL_SMOKE_HANDLES_RUNTIME=1 pnpm exec vitest run test/lib/real/handles-runtime.smoke.test.ts
 */
const GATE = "REAL_SMOKE_HANDLES_RUNTIME";
const ALLOWED_GATES = [GATE] as const;
const enabled = process.env[GATE] === "1" && Boolean(process.env.NEON_BRANCH_DATABASE_URL);

const SEEDED_RESERVED = RESERVED_HANDLES.filter((name) => canonicalizeHandle(name).ok).sort();
const ORIGIN = "http://localhost:3000";
const SESSION_SECRET = "7f3c9a1e5b2d4f60a8c7e9b1d3f5a7c90e2b4d6f8a1c3e5b7d9f0a2c4e6b8d0f";
/** No Turnkey value here is ever used: nothing in this file reaches a Turnkey call. */
const config: RealServerConfig = {
  turnkeyApiBaseUrl: "https://turnkey.invalid",
  turnkeyParentOrganizationId: "not-used",
  turnkeyApiPublicKey: "not-used",
  turnkeyApiPrivateKey: "not-used",
  sessionSecret: SESSION_SECRET,
  rpId: "localhost",
  rpName: "ON Chain Finance",
  expectedOrigins: [ORIGIN],
  rpcUrl: "https://rpc.invalid",
  pimlicoApiKey: "not-used",
};

// Offline (never gated): the harness itself.
describe("handles runtime smoke harness", () => {
  const source = readFileSync("test/lib/real/handles-runtime.smoke.test.ts", "utf8");

  it("is gated by its OWN variable and never reads DATABASE_URL", () => {
    expect(source).toContain('const enabled = process.env[GATE] === "1" && Boolean(process.env.NEON_BRANCH_DATABASE_URL);');
    expect(source.match(/process\.env\.DATABASE_URL/g)).toBeNull();
    // No other live suite is enabled by this gate (the migration smoke only names it as a gate it REFUSES to run beside).
    for (const other of ["test/lib/real/neon-smoke.test.ts", "test/lib/real/provisioning-dispatch-migration.smoke.test.ts", "test/lib/real/l2-identity-migration.smoke.test.ts", "test/lib/real/l2-identity-race.smoke.test.ts"]) {
      expect(readFileSync(other, "utf8"), other).not.toContain(GATE);
    }
    expect(readFileSync("test/lib/real/handles-migration.smoke.test.ts", "utf8")).not.toContain(`process.env.${GATE}`);
  });

  it("the target check refuses: no gate, DATABASE_URL exported, any other smoke/admin gate (the migration smoke's included), or the real endpoint", () => {
    const real = 'DATABASE_URL="postgresql://app:secret@ep-real-000001-pooler.us-east-2.aws.neon.tech/neondb"\n';
    const branch = "postgresql://app:secret@ep-branch-000002.us-east-2.aws.neon.tech/neondb";
    const check = (env: Record<string, string | undefined>) => checkDisposableTarget({ env, envLocalText: real, gate: GATE, allowedGates: ALLOWED_GATES });
    expect(check({ [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch })).toEqual({ ok: true });
    for (const env of [
      { NEON_BRANCH_DATABASE_URL: branch },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch, DATABASE_URL: branch },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch, REAL_SMOKE_HANDLES_MIGRATION: "1" },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch, REAL_SMOKE_HANDLES_MIGRATION_PUBLIC: "1" },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch, REAL_ADMIN_RESOLVE_PASSKEY_REVOCATION: "1" },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: "postgresql://app:secret@ep-real-000001.us-east-2.aws.neon.tech/neondb" },
      { [GATE]: "1" },
    ]) {
      expect(check(env).ok).toBe(false);
    }
  });

  it("never mutates the registry itself, and never reaches a Turnkey step (static)", () => {
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");
    // The needles are assembled from parts so this test's own text can't match them.
    const registry = "real_account" + "_handles";
    expect(code).not.toMatch(new RegExp(`(UPDATE|DELETE FROM|TRUNCATE)\\s+(public\\.)?${registry}`, "i"));
    for (const needle of ["DISABLE " + "TRIGGER", "DROP " + "TRIGGER", "session_replication" + "_role", "ALTER " + "TABLE"]) expect(code.toUpperCase(), needle).not.toContain(needle.toUpperCase());
    for (const turnkeyStep of ["prepareTurnkey" + "Authorization", "submitTurnkey" + "Authorization", "reconcileTurnkey" + "Enrollment", "complete" + "Registration(", "runProvisioning" + "Pipeline"]) expect(code, turnkeyStep).not.toContain(turnkeyStep);
  });

  it("fixture handles are canonical, run-unique, and can never collide with a reserved name", () => {
    const runId = randomUUID().replace(/-/g, "").slice(0, 6);
    for (const tag of ["a", "ra", "b1", "b2", "rb1", "rb2", "c", "d1", "d2", "taken", "f1", "f6", "g", "h", "ia", "ib", "j", "k1", "k2"]) {
      const handle = `hrt_${runId}_${tag}`;
      expect(canonicalizeHandle(handle)).toEqual({ ok: true, handle });
      expect(RESERVED_HANDLES).not.toContain(handle);
    }
  });
});

// ------------------------------------------------------------------ live

const LIVE_TIMEOUT_MS = 180_000;
type Seat = { appUserId: string; authenticator: FixtureAuthenticator; credentialId: string; userHandle: string };
type Failure = { code: string | null; constraint: string | null; message: string };

describe.skipIf(!enabled)("Account Handles — runtime and concurrency against a DISPOSABLE Neon branch (live)", () => {
  const runId = randomUUID().replace(/-/g, "").slice(0, 6);
  const accountPrefix = `hrt-${runId}-`;
  const handleOf = (tag: string) => `hrt_${runId}_${tag}`;
  const facts: Record<string, unknown> = { runId, accountPrefix, handlePrefix: `hrt_${runId}_` };
  /** handle -> the account that must own it at the end. Exactly these rows, and no others, may have been added to the registry. */
  const expectedClaims = new Map<string, string>();
  const seats: Seat[] = [];
  let failures = 0;
  let connection: Promise<{ db: SmokeDb; stores: NeonDurableStores }> | null = null;
  const fetchHosts = new Set<string>();
  const originalFetch = globalThis.fetch;

  /** The ONLY way this file obtains a connection: the target check runs first. */
  function connect() {
    if (!connection) {
      const url = requireDisposableTargetUrl(GATE, ALLOWED_GATES);
      connection = Promise.all([connectSmokeDb(url), connectSmokeStores(url)]).then(([db, stores]) => ({ db, stores }));
    }
    return connection;
  }
  const q = async (text: string, params: unknown[] = []) => (await connect()).db.q(text, params);
  const stores = async () => (await connect()).stores;

  beforeAll(() => {
    // Record every host this process talks to: at the end, none may be anything but the database.
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      try {
        fetchHosts.add(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).hostname);
      } catch {
        fetchHosts.add("<unparseable>");
      }
      return originalFetch(input, init);
    }) as typeof fetch;
  });

  /** Runs in order; once anything fails, nothing further is attempted (no retry, no further writes after an uncertain one). */
  const live = (name: string, fn: () => Promise<void>) =>
    it(
      name,
      async () => {
        if (failures > 0) throw new Error("not run: an earlier step failed, and nothing further is attempted after a failure");
        try {
          await fn();
        } catch (error) {
          failures += 1;
          throw error;
        }
      },
      LIVE_TIMEOUT_MS,
    );

  async function failure(run: Promise<unknown>): Promise<Failure> {
    try {
      await run;
    } catch (error) {
      const e = error as { code?: unknown; constraint?: unknown; message?: unknown };
      return { code: typeof e.code === "string" ? e.code : null, constraint: typeof e.constraint === "string" && e.constraint ? e.constraint : null, message: String(e.message ?? "") };
    }
    throw new Error("expected the statement to be refused, but it succeeded");
  }

  const address = () => `0x${randomBytes(20).toString("hex")}`;

  /** A disposable fixture account with one ACTIVE primary passkey, created through the real registry adapter. */
  async function seat(label: string): Promise<Seat> {
    const { registry } = await stores();
    const authenticator = createFixtureAuthenticator();
    const appUserId = `${accountPrefix}${label}`;
    const userHandle = bytesToBase64Url(new Uint8Array(randomBytes(32)));
    await registry.createAccountWithPasskey({
      account: { appUserId, subOrganizationId: `${appUserId}-sub-org`, turnkeyUserId: `${appUserId}-turnkey-user`, walletId: `${appUserId}-wallet`, walletAccountId: `${appUserId}-wallet-account`, ownerAddress: address(), safeAddress: address(), accountConfigVersion: 1 },
      passkey: { credentialId: authenticator.credentialIdBase64Url, appUserId, credentialPublicKey: bytesToBase64Url(authenticator.publicKeyCose), userHandle, counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false },
    });
    const created: Seat = { appUserId, authenticator, credentialId: authenticator.credentialIdBase64Url, userHandle };
    seats.push(created);
    return created;
  }

  const assertion = (who: Seat, challenge: string) => buildAuthenticationResponseJSON({ authenticator: who.authenticator, challenge, origin: ORIGIN, rpId: config.rpId, userHandle: who.userHandle });

  async function prepare(who: Seat, handle: unknown, overrides: { challengeStore?: ChallengeStore } = {}) {
    const s = await stores();
    return prepareHandleClaim({ config, challengeStore: overrides.challengeStore ?? s.challengeStore, registry: s.registry, handles: s.handles, appUserId: who.appUserId, sessionCredentialId: who.credentialId, handle });
  }
  async function ready(who: Seat, handle: string) {
    const prepared = await prepare(who, handle);
    if (prepared.outcome !== "ready") throw new Error(`expected a claim challenge for ${handle}, got ${JSON.stringify(prepared)}`);
    return prepared;
  }
  async function complete(who: Seat, handle: unknown, response: unknown, overrides: { registry?: RealAccountRegistry } = {}) {
    const s = await stores();
    return completeHandleClaim({ config, challengeStore: s.challengeStore, registry: overrides.registry ?? s.registry, handles: s.handles, appUserId: who.appUserId, sessionCredentialId: who.credentialId, handle, response });
  }
  /** prepare + answer + complete, in one go. */
  async function claimThroughService(who: Seat, handle: string) {
    const { optionsJSON } = await ready(who, handle);
    return complete(who, handle, assertion(who, optionsJSON.challenge));
  }

  const row = async (handle: string) => (await q(`SELECT handle, kind, app_user_id, claimed_by_credential_id, created_at::text AS created_at FROM public.real_account_handles WHERE handle = $1`, [handle]))[0] ?? null;
  const ownedBy = async (appUserId: string) => (await q(`SELECT handle FROM public.real_account_handles WHERE app_user_id = $1 ORDER BY handle`, [appUserId])).map((r) => r.handle);
  const liveChallenges = async (purpose: ChallengePurpose) => Number((await q(`SELECT count(*)::int AS n FROM public.webauthn_challenges WHERE purpose = $1`, [purpose]))[0]!.n);
  const challengeExists = async (challenge: string) => (await q(`SELECT 1 AS one FROM public.webauthn_challenges WHERE challenge = $1`, [challenge])).length === 1;
  const setPasskeyStatus = (credentialId: string, status: string) => q(`UPDATE public.real_passkeys SET status = $1 WHERE credential_id = $2 RETURNING status`, [status, credentialId]);

  /** A real challenge store that also records what was minted and consumed through it. */
  async function recordingChallengeStore() {
    const inner = (await stores()).challengeStore;
    const created: ChallengePurpose[] = [];
    const consumed: ChallengePurpose[] = [];
    const store: ChallengeStore = {
      create: async (input) => (created.push(input.purpose), inner.create(input)),
      consume: async (input) => (consumed.push(input.purpose), inner.consume(input)),
    };
    return { store, created, consumed };
  }

  // ---------------------------------------------------------------- integrity baseline

  /** Every row of every public table, as a content hash — the multiset of what existed before any fixture. */
  async function tableRowHashes() {
    const tables = (await q(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`)).map((r) => String(r.relname));
    const out: Record<string, string[]> = {};
    for (const table of tables) out[table] = (await q(`SELECT md5(t::text) AS h FROM public."${table}" t ORDER BY 1`)).map((r) => String(r.h));
    return out;
  }
  const reservedState = async () =>
    (await q(`SELECT count(*)::int AS n, md5(string_agg(md5(ROW(handle, kind, app_user_id, claimed_by_credential_id, created_at)::text), ',' ORDER BY handle)) AS h FROM public.real_account_handles WHERE kind = 'reserved'`))[0]!;
  let baseline: Record<string, string[]> = {};
  let reservedBefore: Record<string, unknown> = {};

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    facts.failures = failures;
    facts.fetchHosts = [...fetchHosts].map((host) => host.replace(/^[^.]+\./, "<label>."));
    const path = process.env.HANDLES_SMOKE_FACTS_PATH;
    if (path) writeFileSync(path, `${JSON.stringify(facts, null, 2)}\n`);
    console.log(`HANDLES_RUNTIME_FACTS ${JSON.stringify(facts)}`);
  }, LIVE_TIMEOUT_MS);

  // ================================================================ target + baseline

  live("target: a migrated, unused registry — public.real_account_handles exists with 43 reserved rows and ZERO claimed; baseline captured", async () => {
    const [env] = await q(`SELECT current_setting('server_version') AS server_version, current_user::text AS role, current_schema()::text AS current_schema, to_regclass('public.real_account_handles')::text AS registry`);
    facts.environment = env;
    expect(env).toMatchObject({ current_schema: "public", registry: "real_account_handles" });
    expect(await q(`SELECT kind, count(*)::int AS n FROM public.real_account_handles GROUP BY kind ORDER BY kind`)).toEqual([{ kind: "reserved", n: SEEDED_RESERVED.length }]);
    expect((await q(`SELECT handle FROM public.real_account_handles ORDER BY handle`)).map((r) => r.handle)).toEqual(SEEDED_RESERVED);
    // No fixture of this run exists yet, and the guards are in place and enabled.
    expect(await q(`SELECT 1 AS one FROM public.real_accounts WHERE app_user_id LIKE $1`, [`${accountPrefix}%`])).toEqual([]);
    expect(await q(`SELECT tgname, tgenabled::text AS enabled FROM pg_trigger WHERE tgrelid = 'public.real_account_handles'::regclass AND NOT tgisinternal ORDER BY tgname`)).toEqual([
      { tgname: "real_account_handles_immutable_row", enabled: "O" },
      { tgname: "real_account_handles_immutable_truncate", enabled: "O" },
    ]);
    baseline = await tableRowHashes();
    reservedBefore = await reservedState();
    facts.baselineRowCounts = Object.fromEntries(Object.entries(baseline).map(([table, rows]) => [table, rows.length]));
    expect(reservedBefore.n).toBe(SEEDED_RESERVED.length);
  });

  // ================================================================ A

  live("A — two accounts race for ONE handle: exactly one claims it, the other is told it is unavailable", async () => {
    const [a1, a2] = [await seat("a1"), await seat("a2")];
    const handle = handleOf("a");
    const [forA1, forA2] = [await ready(a1, handle), await ready(a2, handle)]; // the advisory check passed for BOTH
    const responses: Array<[Seat, unknown]> = [
      [a1, assertion(a1, forA1.optionsJSON.challenge)],
      [a2, assertion(a2, forA2.optionsJSON.challenge)],
    ];
    const results = await Promise.all(responses.map(([who, response]) => complete(who, handle, response))); // genuinely concurrent
    expect(results.map((r) => r.outcome).sort()).toEqual(["claimed", "unavailable"]);
    const winner = results[0]!.outcome === "claimed" ? a1 : a2;
    const loser = winner === a1 ? a2 : a1;
    expect(await q(`SELECT handle, kind, app_user_id, claimed_by_credential_id FROM public.real_account_handles WHERE handle = $1`, [handle])).toEqual([{ handle, kind: "claimed", app_user_id: winner.appUserId, claimed_by_credential_id: winner.credentialId }]);
    expect(await ownedBy(loser.appUserId)).toEqual([]);
    expect(await ownedBy(winner.appUserId)).toEqual([handle]);
    expectedClaims.set(handle, winner.appUserId);
    facts.raceA = { outcomes: results.map((r) => r.outcome), winner: winner === a1 ? "first" : "second", rowsForHandle: 1 };
  });

  live("A (adapter level) — the same race as two raw INSERT ... SELECTs: one row, and the loser's 23505 names exactly the primary key", async () => {
    const [r1, r2] = [await seat("ra1"), await seat("ra2")];
    const handle = handleOf("ra");
    const insert = (who: Seat) =>
      q(
        `INSERT INTO real_account_handles (handle, kind, app_user_id, claimed_by_credential_id) SELECT $1, 'claimed', p.app_user_id, p.credential_id FROM real_passkeys p WHERE p.credential_id = $2 AND p.app_user_id = $3 AND p.status = 'active' RETURNING handle`,
        [handle, who.credentialId, who.appUserId],
      );
    const settled = await Promise.allSettled([insert(r1), insert(r2)]);
    expect(settled.map((s) => s.status).sort()).toEqual(["fulfilled", "rejected"]);
    const lost = settled.find((s) => s.status === "rejected") as PromiseRejectedResult;
    const refusal = lost.reason as { code?: string; constraint?: string };
    expect(refusal).toMatchObject({ code: "23505", constraint: ACCOUNT_HANDLE_PRIMARY_KEY });
    const winner = settled[0]!.status === "fulfilled" ? r1 : r2;
    expect((await row(handle))!.app_user_id).toBe(winner.appUserId);
    expectedClaims.set(handle, winner.appUserId);
    facts.raceARaw = { sqlstate: refusal.code, constraint: refusal.constraint };
  });

  // ================================================================ B

  live("B — one account races for TWO handles: exactly one is kept, the other stays completely free", async () => {
    const b = await seat("b");
    const [h1, h2] = [handleOf("b1"), handleOf("b2")];
    const [first, second] = [await ready(b, h1), await ready(b, h2)];
    const results = await Promise.all([complete(b, h1, assertion(b, first.optionsJSON.challenge)), complete(b, h2, assertion(b, second.optionsJSON.challenge))]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["already_has_handle", "claimed"]);
    const kept = results[0]!.outcome === "claimed" ? h1 : h2;
    const lost = kept === h1 ? h2 : h1;
    expect(results.find((r) => r.outcome === "already_has_handle")).toMatchObject({ handle: kept });
    expect(await ownedBy(b.appUserId)).toEqual([kept]);
    expect(await row(lost)).toBeNull();
    expect(await (await stores()).handles.findHandle(lost)).toBeNull();
    expectedClaims.set(kept, b.appUserId);
    facts.raceB = { outcomes: results.map((r) => r.outcome), kept: kept === h1 ? "first" : "second", loserHandleFree: true };
  });

  live("B (adapter level) — two raw inserts for one account: the loser's 23505 names exactly the one-handle-per-account key", async () => {
    const rb = await seat("rb");
    const [h1, h2] = [handleOf("rb1"), handleOf("rb2")];
    const insert = (handle: string) =>
      q(
        `INSERT INTO real_account_handles (handle, kind, app_user_id, claimed_by_credential_id) SELECT $1, 'claimed', p.app_user_id, p.credential_id FROM real_passkeys p WHERE p.credential_id = $2 AND p.app_user_id = $3 AND p.status = 'active' RETURNING handle`,
        [handle, rb.credentialId, rb.appUserId],
      );
    const settled = await Promise.allSettled([insert(h1), insert(h2)]);
    expect(settled.map((s) => s.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refusal = (settled.find((s) => s.status === "rejected") as PromiseRejectedResult).reason as { code?: string; constraint?: string };
    expect(refusal).toMatchObject({ code: "23505", constraint: ACCOUNT_HANDLE_OWNER_KEY });
    const kept = settled[0]!.status === "fulfilled" ? h1 : h2;
    expect(await ownedBy(rb.appUserId)).toEqual([kept]);
    expect(await row(kept === h1 ? h2 : h1)).toBeNull();
    expectedClaims.set(kept, rb.appUserId);
    facts.raceBRaw = { sqlstate: refusal.code, constraint: refusal.constraint };
  });

  // ================================================================ C

  live("C — a lost response: every permitted retry of the SAME handle is an idempotent success, with one row and no second write", async () => {
    const c = await seat("c");
    const handle = handleOf("c");
    // Two challenges minted before anything lands (the claim button pressed in two tabs).
    const [first, second] = [await ready(c, handle), await ready(c, handle)];
    expect((await complete(c, handle, assertion(c, first.optionsJSON.challenge))).outcome).toBe("claimed"); // ... and this answer never reaches the client
    const original = await row(handle);
    expect(original).toMatchObject({ kind: "claimed", app_user_id: c.appUserId, claimed_by_credential_id: c.credentialId });

    // Retry 1: the still-valid second challenge. The insert hits the unique key; the adapter sees the account already owns THIS handle.
    expect(await complete(c, handle, assertion(c, second.optionsJSON.challenge))).toEqual({ outcome: "claimed", profile: { handle, displayName: null } });
    // Retry 2: the adapter directly — the exact idempotency marker.
    expect(await (await stores()).handles.claim({ handle, appUserId: c.appUserId, credentialId: c.credentialId })).toEqual({ outcome: "claimed", handle, alreadyOwned: true });
    // Retry 3: the client asks for a new challenge — none is minted; it is told the handle it already owns (which the client treats as success).
    const before = await liveChallenges("handle_claim");
    expect(await prepare(c, handle)).toMatchObject({ outcome: "already_has_handle", handle });
    expect(await liveChallenges("handle_claim")).toBe(before);

    expect(await q(`SELECT count(*)::int AS n FROM public.real_account_handles WHERE handle = $1 OR app_user_id = $2`, [handle, c.appUserId])).toEqual([{ n: 1 }]);
    expect(await row(handle)).toEqual(original); // same row, same created_at: nothing was rewritten
    expectedClaims.set(handle, c.appUserId);
    facts.lostResponseRetry = { serviceRetry: "claimed", adapterRetry: { outcome: "claimed", alreadyOwned: true }, optionsRetry: "already_has_handle (same handle)", rows: 1 };
  });

  // ================================================================ D

  live("D — an account that owns a handle can never get a second: 'already_has_handle', its handle untouched, the other left free", async () => {
    const d = await seat("d");
    const [owned, wanted] = [handleOf("d1"), handleOf("d2")];
    const [forOwned, forWanted] = [await ready(d, owned), await ready(d, wanted)]; // both minted while the account had none
    expect((await complete(d, owned, assertion(d, forOwned.optionsJSON.challenge))).outcome).toBe("claimed");
    const original = await row(owned);
    const result = await complete(d, wanted, assertion(d, forWanted.optionsJSON.challenge));
    expect(result).toMatchObject({ outcome: "already_has_handle", handle: owned });
    expect(JSON.stringify(result)).not.toContain(wanted);
    // The same answer from every other door.
    expect(await prepare(d, wanted)).toMatchObject({ outcome: "already_has_handle", handle: owned });
    expect(await (await stores()).handles.claim({ handle: wanted, appUserId: d.appUserId, credentialId: d.credentialId })).toEqual({ outcome: "already_has_handle", handle: owned });
    expect(await row(wanted)).toBeNull();
    expect(await row(owned)).toEqual(original);
    expect(await ownedBy(d.appUserId)).toEqual([owned]);
    expectedClaims.set(owned, d.appUserId);
    facts.existingHandle = { outcome: result.outcome, returnedHandleIsTheOwnedOne: true, otherHandleFree: true };
  });

  // ================================================================ E

  live("E — a reserved name: refused at options exactly like a taken one, no challenge minted, and the seed row is untouched", async () => {
    const [e, holder] = [await seat("e"), await seat("e-holder")];
    const taken = handleOf("taken");
    expect((await claimThroughService(holder, taken)).outcome).toBe("claimed");
    expectedClaims.set(taken, holder.appUserId);

    const seedBefore = await row("admin");
    expect(seedBefore).toMatchObject({ kind: "reserved", app_user_id: null, claimed_by_credential_id: null });
    const before = await liveChallenges("handle_claim");
    const recording = await recordingChallengeStore();
    const reserved = await prepare(e, "@Admin", { challengeStore: recording.store });
    const alreadyTaken = await prepare(e, taken, { challengeStore: recording.store });
    expect(reserved).toEqual({ outcome: "unavailable", reason: "That name isn't available. Try another." });
    expect(alreadyTaken).toEqual(reserved); // the same outward answer
    expect(recording.created).toEqual([]);
    expect(await liveChallenges("handle_claim")).toBe(before);
    // Every other reserved seed is refused the same way.
    for (const name of ["support", "pay", "on_chain_finance", "wallet"]) expect((await prepare(e, name, { challengeStore: recording.store })).outcome, name).toBe("unavailable");
    expect(recording.created).toEqual([]);

    // The adapter, and the raw statement, are refused by the database itself.
    expect(await (await stores()).handles.claim({ handle: "admin", appUserId: e.appUserId, credentialId: e.credentialId })).toEqual({ outcome: "handle_taken" });
    const raw = await failure(q(`INSERT INTO real_account_handles (handle, kind, app_user_id, claimed_by_credential_id) VALUES ('admin', 'claimed', $1, $2)`, [e.appUserId, e.credentialId]));
    expect(raw).toMatchObject({ code: "23505", constraint: ACCOUNT_HANDLE_PRIMARY_KEY });
    expect(await row("admin")).toEqual(seedBefore);
    expect(await ownedBy(e.appUserId)).toEqual([]);
    facts.reserved = { optionsOutcome: reserved.outcome, sameAnswerAsTaken: true, challengesMinted: 0, adapter: "handle_taken", rawSqlstate: raw.code, rawConstraint: raw.constraint };
  });

  // ================================================================ F

  live("F — the claiming credential stops being active: refused, and no row is inserted — including when the change lands AFTER the assertion verified", async () => {
    const recorded: Record<string, unknown> = {};
    let index = 0;
    for (const status of ["revoked", "pending", "revoking"] as const) {
      // (i) the status changes between options and claim: the service's own re-read refuses.
      index += 1;
      const early = await seat(`f${index}`);
      const earlyHandle = handleOf(`f${index}`);
      const prepared = await ready(early, earlyHandle);
      expect(await setPasskeyStatus(early.credentialId, status)).toEqual([{ status }]);
      const earlyResult = await complete(early, earlyHandle, assertion(early, prepared.optionsJSON.challenge));
      expect(earlyResult.outcome, `${status} (before completion)`).toBe("rejected");
      expect(await row(earlyHandle)).toBeNull();

      // (ii) the status changes in the window AFTER the assertion verified and the counter was written, just before the insert:
      //      the service has already accepted the credential, so ONLY the INSERT ... SELECT's own `status = 'active'` can stop it.
      index += 1;
      const late = await seat(`f${index}`);
      const lateHandle = handleOf(`f${index}`);
      const latePrepared = await ready(late, lateHandle);
      const real = (await stores()).registry;
      let flipped = 0;
      const racing: RealAccountRegistry = {
        ...real,
        updateAuthenticatorCounter: async (input) => {
          await real.updateAuthenticatorCounter(input);
          expect(await setPasskeyStatus(late.credentialId, status)).toEqual([{ status }]);
          flipped += 1;
        },
      };
      const lateResult = await complete(late, lateHandle, assertion(late, latePrepared.optionsJSON.challenge), { registry: racing });
      expect(flipped, "the status flip must have happened inside the verification-to-insert window").toBe(1);
      expect(lateResult.outcome, `${status} (after verification)`).toBe("rejected");
      expect(await row(lateHandle)).toBeNull();
      // The adapter says exactly why; the raw statement inserts zero rows rather than erroring.
      expect(await (await stores()).handles.claim({ handle: lateHandle, appUserId: late.appUserId, credentialId: late.credentialId })).toEqual({ outcome: "credential_not_active" });
      expect(await row(lateHandle)).toBeNull();
      expect(await ownedBy(early.appUserId)).toEqual([]);
      expect(await ownedBy(late.appUserId)).toEqual([]);
      recorded[status] = { beforeCompletion: earlyResult.outcome, afterVerification: lateResult.outcome, adapter: "credential_not_active", rowsInserted: 0 };
    }
    facts.credentialStatus = recorded;
  });

  // ================================================================ G

  live("G — cross-account: another session, a challenge bound to another account or credential, and a foreign credential in a direct insert are all refused", async () => {
    const [g1, g2] = [await seat("g1"), await seat("g2")];
    const handle = handleOf("g");
    const s = await stores();

    // 1. Account 2's session completes account 1's challenge, with account 2's own valid passkey.
    const forG1 = await ready(g1, handle);
    expect((await complete(g2, handle, assertion(g2, forG1.optionsJSON.challenge))).outcome).toBe("rejected");
    expect(await challengeExists(forG1.optionsJSON.challenge)).toBe(false); // burned by the attempt

    // 2 + 3. A stored context naming a different account, or a different credential, than the session completing it.
    const forged: Array<[string, { appUserId: string; credentialId: string; handle: string }, Seat]> = [
      ["the context's account is not the session's", { appUserId: g2.appUserId, credentialId: g1.credentialId, handle }, g1],
      ["the context's credential is not the session's", { appUserId: g1.appUserId, credentialId: g2.credentialId, handle }, g1],
      ["the context is another account's entirely", { appUserId: g2.appUserId, credentialId: g2.credentialId, handle }, g1],
    ];
    for (const [label, context, session] of forged) {
      const options = await buildLoginOptions({ config, allowCredentialIds: [session.credentialId] });
      await s.challengeStore.create({ challenge: options.challenge, purpose: "handle_claim", ttlMs: 60_000, context });
      expect((await complete(session, handle, assertion(session, options.challenge))).outcome, label).toBe("rejected");
      expect(await challengeExists(options.challenge)).toBe(false);
    }

    // 4. Directly: account 1 with account 2's credential. The adapter's SELECT finds no such passkey; a raw VALUES insert hits the composite foreign key.
    expect(await s.handles.claim({ handle, appUserId: g1.appUserId, credentialId: g2.credentialId })).toEqual({ outcome: "credential_not_active" });
    const raw = await failure(q(`INSERT INTO real_account_handles (handle, kind, app_user_id, claimed_by_credential_id) VALUES ($1, 'claimed', $2, $3)`, [handle, g1.appUserId, g2.credentialId]));
    expect(raw).toMatchObject({ code: "23503", constraint: "real_account_handles_claimed_by_fkey" });

    expect(await row(handle)).toBeNull();
    expect(await ownedBy(g1.appUserId)).toEqual([]);
    expect(await ownedBy(g2.appUserId)).toEqual([]);
    facts.crossAccount = { otherSession: "rejected", forgedContexts: forged.length, adapter: "credential_not_active", rawSqlstate: raw.code, rawConstraint: raw.constraint };
  });

  // ================================================================ H

  live("H — replay: the same assertion a second time is refused; the challenge was consumed exactly once", async () => {
    const h = await seat("h");
    const handle = handleOf("h");
    const { optionsJSON } = await ready(h, handle);
    expect(await challengeExists(optionsJSON.challenge)).toBe(true);
    const response = assertion(h, optionsJSON.challenge);
    expect((await complete(h, handle, response)).outcome).toBe("claimed");
    expect(await challengeExists(optionsJSON.challenge)).toBe(false);
    const original = await row(handle);
    const replay = await complete(h, handle, response);
    expect(replay).toEqual({ outcome: "rejected", reason: "Couldn't confirm it's you. Try again." });
    // Two concurrent replays fare no better.
    expect((await Promise.all([complete(h, handle, response), complete(h, handle, response)])).map((r) => r.outcome)).toEqual(["rejected", "rejected"]);
    expect(await q(`SELECT count(*)::int AS n FROM public.real_account_handles WHERE handle = $1`, [handle])).toEqual([{ n: 1 }]);
    expect(await row(handle)).toEqual(original);
    expectedClaims.set(handle, h.appUserId);
    facts.replay = { first: "claimed", second: replay.outcome, rows: 1 };
  });

  live("H (concurrency) — one challenge submitted twice AT ONCE is consumed exactly once: one claim, one refusal", async () => {
    const h2 = await seat("h2");
    const handle = handleOf("h2");
    const { optionsJSON } = await ready(h2, handle);
    const response = assertion(h2, optionsJSON.challenge);
    const results = await Promise.all([complete(h2, handle, response), complete(h2, handle, response)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["claimed", "rejected"]);
    expect(await ownedBy(h2.appUserId)).toEqual([handle]);
    expectedClaims.set(handle, h2.appUserId);
    facts.replayConcurrent = { outcomes: results.map((r) => r.outcome).sort() };
  });

  // ================================================================ I

  live("I — handle mismatch: a challenge minted for one handle never claims another; the stored value is always the challenge's own", async () => {
    const i = await seat("i");
    const [bound, other] = [handleOf("ia"), handleOf("ib")];
    for (const body of [other, other.toUpperCase(), `@${other}`, `${bound}x`, `${bound.toUpperCase()}X`, bound.slice(0, -1), "", null, 42]) {
      const { optionsJSON } = await ready(i, bound);
      expect((await complete(i, body, assertion(i, optionsJSON.challenge))).outcome, String(body)).toBe("rejected");
      expect(await challengeExists(optionsJSON.challenge)).toBe(false); // each failed attempt burned its challenge
      expect(await row(bound)).toBeNull();
      expect(await row(other)).toBeNull();
    }
    expect(await ownedBy(i.appUserId)).toEqual([]);
    // A body that merely SPELLS the bound handle differently is accepted — and what is stored is the canonical context value.
    const { optionsJSON } = await ready(i, bound);
    expect((await complete(i, `  @${bound.toUpperCase()} `, assertion(i, optionsJSON.challenge))).outcome).toBe("claimed");
    expect(await ownedBy(i.appUserId)).toEqual([bound]);
    expect(await row(other)).toBeNull();
    expect(await q(`SELECT handle FROM public.real_account_handles WHERE lower(handle) = $1`, [bound])).toEqual([{ handle: bound }]);
    expectedClaims.set(bound, i.appUserId);
    facts.handleMismatch = { mismatchedBodiesRejected: 9, differentlySpelledSameHandle: "claimed", storedValueIsCanonicalContext: true };
  });

  // ================================================================ J

  live("J — display name: set, Unicode + NFC, clear; invalid names refused by the application; a 41-character direct write refused by the database", async () => {
    const j = await seat("j");
    const handle = handleOf("j");
    expect((await claimThroughService(j, handle)).outcome).toBe("claimed");
    expectedClaims.set(handle, j.appUserId);
    const original = await row(handle);
    const { handles } = await stores();
    const update = (displayName: unknown) => updateAccountDisplayName({ handles, appUserId: j.appUserId, displayName });
    const stored = async () => (await q(`SELECT display_name, char_length(display_name)::int AS chars, octet_length(display_name)::int AS bytes FROM public.real_accounts WHERE app_user_id = $1`, [j.appUserId]))[0]!;

    expect(await update("  Smoke Tester  ")).toEqual({ outcome: "updated", profile: { handle, displayName: "Smoke Tester" } });
    expect(await readAccountProfile({ handles, appUserId: j.appUserId })).toEqual({ handle, displayName: "Smoke Tester" });
    expect(await stored()).toEqual({ display_name: "Smoke Tester", chars: 12, bytes: 12 });

    // A decomposed "e + combining diaeresis" is stored as the single precomposed code point (NFC).
    const decomposed = `Zo${"e"}${String.fromCodePoint(0x308)} ${String.fromCodePoint(0x5c71, 0x7530)}`;
    const composed = `Zo${String.fromCodePoint(0xeb)} ${String.fromCodePoint(0x5c71, 0x7530)}`;
    expect(decomposed).not.toBe(composed);
    expect(await update(decomposed)).toEqual({ outcome: "updated", profile: { handle, displayName: composed } });
    expect(await stored()).toEqual({ display_name: composed, chars: 6, bytes: Buffer.byteLength(composed, "utf8") });

    // Every invalid name is refused by the APPLICATION, and nothing is written.
    const cp = (code: number) => String.fromCodePoint(code);
    const invalid: Array<[string, string]> = [
      ["a leading @", "@support"],
      ["a leading @ (handle-shaped)", `@${handle}`],
      ["a zero-width space (Cf)", `Ali${cp(0x200b)}ce`],
      ["a word joiner (Cf)", `Ali${cp(0x2060)}ce`],
      ["a soft hyphen (Cf)", `Ali${cp(0xad)}ce`],
      ["a right-to-left override (Cf)", `Ali${cp(0x202e)}ce`],
      ["a control character", `Ali${cp(0x7)}ce`],
      ["a newline", "Ali\nce"],
      ["a line separator", `Ali${cp(0x2028)}ce`],
      ["a paragraph separator", `Ali${cp(0x2029)}ce`],
      ["41 code points", "x".repeat(41)],
    ];
    for (const [label, name] of invalid) {
      expect((await update(name)).outcome, label).toBe("invalid");
      expect((await stored()).display_name, label).toBe(composed);
    }

    // The database's own structural guard, bypassing the application: 41 characters.
    const direct = await failure(q(`UPDATE public.real_accounts SET display_name = repeat('x', 41) WHERE app_user_id = $1`, [j.appUserId]));
    expect(direct).toMatchObject({ code: "23514", constraint: "real_accounts_display_name_check" });
    expect((await stored()).display_name).toBe(composed);

    // Clear it.
    expect(await update("   ")).toEqual({ outcome: "updated", profile: { handle, displayName: null } });
    expect(await stored()).toEqual({ display_name: null, chars: null, bytes: null });
    expect(await readAccountProfile({ handles, appUserId: j.appUserId })).toEqual({ handle, displayName: null });
    // Handle ownership was untouched throughout.
    expect(await row(handle)).toEqual(original);
    facts.displayName = { set: true, nfcStored: true, invalidRejectedByApplication: invalid.length, directWriteSqlstate: direct.code, directWriteConstraint: direct.constraint, cleared: true, handleUntouched: true };
  });

  // ================================================================ K

  /** One fresh step-up, then beginBackupEnrollment — stopping at the registration options, the last step before anything Turnkey. */
  async function beginBackup(who: Seat, handles: (() => AccountHandleStore) | undefined) {
    const s = await stores();
    const recording = await recordingChallengeStore();
    const stepUp = await prepareBackupStepUp({ config, challengeStore: recording.store, registry: s.registry, appUserId: who.appUserId, sessionCredentialId: who.credentialId });
    if (stepUp.outcome !== "ready") throw new Error(JSON.stringify(stepUp));
    const result = await beginBackupEnrollment({
      config,
      challengeStore: recording.store,
      registry: s.registry,
      enrollments: s.backupEnrollments,
      ...(handles ? { handles } : {}),
      appUserId: who.appUserId,
      sessionCredentialId: who.credentialId,
      stepUpResponse: assertion(who, stepUp.optionsJSON.challenge),
    });
    if (result.outcome !== "started") throw new Error(`backup setup did not start: ${JSON.stringify(result)}`);
    return { ...result, minted: recording.created, consumed: recording.consumed };
  }

  live("K — profile and backup labels: a claimed handle + display name label the new passkey; a failing profile store falls back to the legacy label with no extra step-up", async () => {
    const s = await stores();
    const [k1, k2] = [await seat("k1"), await seat("k2")];
    for (const [who, tag, name] of [[k1, "k1", "Kay One"], [k2, "k2", "Kay Two"]] as const) {
      expect((await claimThroughService(who, handleOf(tag))).outcome).toBe("claimed");
      expectedClaims.set(handleOf(tag), who.appUserId);
      expect((await updateAccountDisplayName({ handles: s.handles, appUserId: who.appUserId, displayName: name })).outcome).toBe("updated");
    }
    // 1. The real profile lookup returns both.
    expect(await readAccountProfile({ handles: s.handles, appUserId: k1.appUserId })).toEqual({ handle: handleOf("k1"), displayName: "Kay One" });
    expect(await readAccountProfileBestEffort({ handles: () => s.handles, appUserId: k1.appUserId })).toEqual({ handle: handleOf("k1"), displayName: "Kay One" });

    // 2 + 3. A working profile store: "@handle" and the display name; a fresh random user.id.
    const labelled = await beginBackup(k1, () => s.handles);
    expect(labelled.optionsJSON.user.name).toBe(`@${handleOf("k1")}`);
    expect(labelled.optionsJSON.user.displayName).toBe("Kay One");
    expect(labelled.optionsJSON.user.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(labelled.optionsJSON.user.id).not.toBe(k1.userHandle);
    expect(labelled.minted).toEqual(["backup_step_up", "backup_registration"]);
    expect(labelled.consumed).toEqual(["backup_step_up"]);

    // The profile store FAILS (rejecting, as a missing table or a dropped connection would): the setup still starts.
    const failing: Array<[string, () => AccountHandleStore]> = [
      ["the read rejects", () => ({ ...s.handles, findProfileByAppUserId: async () => Promise.reject(new Error('relation "real_account_handles" does not exist')) })],
    ];
    const fallback = await beginBackup(k2, failing[0]![1]);
    const legacy = `real-backup-${fallback.enrollmentId.slice(0, 8)}`;
    expect(fallback.optionsJSON.user.name).toBe(legacy);
    expect(fallback.optionsJSON.user.displayName).toBe(legacy);
    expect(fallback.optionsJSON.user.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(fallback.optionsJSON)).not.toContain(handleOf("k2"));
    expect(JSON.stringify(fallback.optionsJSON)).not.toContain("Kay Two");
    expect(fallback.minted).toEqual(["backup_step_up", "backup_registration"]); // one step-up, exactly as when the profile read works
    expect(fallback.consumed).toEqual(["backup_step_up"]);
    expect(fallback.optionsJSON.user.id).not.toBe(labelled.optionsJSON.user.id);

    // The enrollments stopped at 'started': no credential registered, nothing dispatched to Turnkey.
    for (const begun of [labelled, fallback]) {
      expect(await q(`SELECT state, external_outcome, new_credential_id, turnkey_request_body, turnkey_activity_id FROM public.backup_passkey_enrollments WHERE id = $1`, [begun.enrollmentId])).toEqual([
        { state: "started", external_outcome: "not_attempted", new_credential_id: null, turnkey_request_body: null, turnkey_activity_id: null },
      ]);
    }
    // The handle rows and the accounts' passkeys are exactly as they were.
    expect(await ownedBy(k1.appUserId)).toEqual([handleOf("k1")]);
    expect(await ownedBy(k2.appUserId)).toEqual([handleOf("k2")]);
    expect(await q(`SELECT credential_id, status, user_handle FROM public.real_passkeys WHERE app_user_id = ANY($1::text[]) ORDER BY app_user_id`, [[k1.appUserId, k2.appUserId]])).toEqual([
      { credential_id: k1.credentialId, status: "active", user_handle: k1.userHandle },
      { credential_id: k2.credentialId, status: "active", user_handle: k2.userHandle },
    ]);
    facts.backupLabels = {
      withProfile: { name: "@<handle>", displayName: "<display name>", freshRandomUserId: true, stepUps: 1 },
      profileStoreFailing: { name: "real-backup-<id8>", displayName: "real-backup-<id8>", stepUps: 1, started: true },
      stoppedBeforeTurnkey: true,
    };
  });

  // ================================================================ L

  live("L — an account with NO handle: its session authenticates, its profile is empty, and backup setup uses the legacy label — no handle is ever required", async () => {
    const l = await seat("l");
    const s = await stores();
    const account = (await s.registry.findAccountByAppUserId(l.appUserId))!;
    const cookie = serializeSession(createSessionPayload({ appUserId: l.appUserId, credentialId: l.credentialId, sessionEpoch: account.sessionEpoch }), SESSION_SECRET);
    const authenticated = await readAuthenticatedRealAccount({ cookieValue: cookie, sessionSecret: SESSION_SECRET, registry: s.registry });
    expect(authenticated).not.toBeNull();
    expect(authenticated!.account.appUserId).toBe(l.appUserId);
    expect(authenticated!.passkey.status).toBe("active");
    expect(Object.keys(authenticated!.account)).not.toContain("handle");
    expect(await readAccountProfile({ handles: s.handles, appUserId: l.appUserId })).toEqual({ handle: null, displayName: null });
    expect(await readAccountProfileBestEffort({ handles: () => s.handles, appUserId: l.appUserId })).toEqual({ handle: null, displayName: null });
    expect(await ownedBy(l.appUserId)).toEqual([]);

    const begun = await beginBackup(l, () => s.handles);
    const legacy = `real-backup-${begun.enrollmentId.slice(0, 8)}`;
    expect(begun.optionsJSON.user.name).toBe(legacy);
    expect(begun.optionsJSON.user.displayName).toBe(legacy);
    expect(begun.minted).toEqual(["backup_step_up", "backup_registration"]);
    // A display name alone (still no handle) changes nothing about the label, and needs no handle.
    expect((await updateAccountDisplayName({ handles: s.handles, appUserId: l.appUserId, displayName: "No Handle Yet" })).outcome).toBe("updated");
    expect(await readAccountProfile({ handles: s.handles, appUserId: l.appUserId })).toEqual({ handle: null, displayName: "No Handle Yet" });
    expect(await ownedBy(l.appUserId)).toEqual([]);
    facts.noHandleAccount = { authenticated: true, profile: { handle: null }, backupLabel: "real-backup-<id8>", displayNameWithoutHandle: true };
  });

  // ================================================================ final state

  live("final state: exactly the intended fixture rows exist; reserved seeds, pre-existing data, and every claimed row are untouched; no stray challenge or enrollment", async () => {
    // --- registry
    expect(await reservedState()).toEqual(reservedBefore); // 43 reserved rows, byte-identical
    const claimed = await q(`SELECT handle, app_user_id, claimed_by_credential_id FROM public.real_account_handles WHERE kind = 'claimed' ORDER BY handle`);
    expect(claimed.map((r) => [r.handle, r.app_user_id])).toEqual([...expectedClaims.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
    for (const r of claimed) {
      expect(String(r.handle).startsWith(`hrt_${runId}_`)).toBe(true);
      const owner = seats.find((who) => who.appUserId === r.app_user_id)!;
      expect(r.claimed_by_credential_id).toBe(owner.credentialId); // the claiming credential is the owner's own
    }
    expect(await q(`SELECT app_user_id FROM public.real_account_handles WHERE app_user_id IS NOT NULL GROUP BY app_user_id HAVING count(*) > 1`)).toEqual([]);
    expect(await q(`SELECT handle FROM public.real_account_handles WHERE kind = 'reserved' AND (app_user_id IS NOT NULL OR claimed_by_credential_id IS NOT NULL)`)).toEqual([]);
    expect(await q(`SELECT count(*)::int AS n FROM public.real_account_handles`)).toEqual([{ n: SEEDED_RESERVED.length + expectedClaims.size }]);

    // --- pre-existing data: every row that existed before is still there, byte for byte; every NEW row is a fixture of this run.
    const after = await tableRowHashes();
    expect(Object.keys(after).sort()).toEqual(Object.keys(baseline).sort());
    const added: Record<string, number> = {};
    for (const [table, before] of Object.entries(baseline)) {
      const remaining = [...after[table]!];
      for (const hash of before) {
        const at = remaining.indexOf(hash);
        expect(at, `a pre-existing row of public.${table} changed or vanished`).toBeGreaterThan(-1);
        remaining.splice(at, 1);
      }
      added[table] = remaining.length;
    }
    const enrollments = await q(`SELECT app_user_id, state, external_outcome FROM public.backup_passkey_enrollments WHERE app_user_id LIKE $1 ORDER BY app_user_id`, [`${accountPrefix}%`]);
    const leftoverChallenges = await q(`SELECT purpose, context ->> 'appUserId' AS app_user_id FROM public.webauthn_challenges ORDER BY purpose, 2`);
    const baselineChallenges = baseline.webauthn_challenges!.length;
    expect(added).toEqual({
      ...Object.fromEntries(Object.keys(baseline).map((table) => [table, 0])),
      real_accounts: seats.length,
      real_passkeys: seats.length,
      real_account_handles: expectedClaims.size,
      backup_passkey_enrollments: 3,
      webauthn_challenges: 3,
    });
    expect(await q(`SELECT count(*)::int AS n FROM public.real_accounts WHERE app_user_id LIKE $1`, [`${accountPrefix}%`])).toEqual([{ n: seats.length }]);
    expect(await q(`SELECT count(*)::int AS n FROM public.real_passkeys WHERE app_user_id LIKE $1`, [`${accountPrefix}%`])).toEqual([{ n: seats.length }]);

    // --- challenges: every handle_claim challenge was consumed; what remains are the three backup registration challenges (K, K, L).
    expect(await liveChallenges("handle_claim")).toBe(0);
    expect(await liveChallenges("backup_step_up")).toBe(0);
    expect(leftoverChallenges.length).toBe(baselineChallenges + 3);
    expect(leftoverChallenges.filter((c) => String(c.app_user_id ?? "").startsWith(accountPrefix)).map((c) => c.purpose)).toEqual(["backup_registration", "backup_registration", "backup_registration"]);
    // --- enrollments: the three begun setups, all still 'started', nothing dispatched.
    expect(enrollments.map((e) => [e.state, e.external_outcome])).toEqual([["started", "not_attempted"], ["started", "not_attempted"], ["started", "not_attempted"]]);

    // --- nothing but the database was contacted.
    for (const host of fetchHosts) expect(host).not.toMatch(/turnkey|pimlico|base\.org|rpc/i);

    facts.finalState = {
      reservedRows: SEEDED_RESERVED.length,
      reservedUnchanged: true,
      claimedFixtureHandles: expectedClaims.size,
      fixtureAccounts: seats.length,
      rowsAdded: added,
      liveHandleClaimChallenges: 0,
      leftoverBackupRegistrationChallenges: 3,
      startedEnrollments: 3,
      duplicateOwners: 0,
      preExistingRowsIdentical: true,
    };
  });
});
