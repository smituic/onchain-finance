// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abortable,
  bounded,
  DIRECT_DATABASE_URL_ENV,
  HARNESS_REQUEST,
  openHolder,
  Poison,
  RACE_LIMITS,
  recordingFetch,
  prepareRaceSuite,
  RecordingRouter,
  runRaceCase,
  sessionStartupOptions,
  waitForFinalizeBlockedBy,
  type Batch,
  type HolderClient,
  type RaceContext,
  type RaceHooks,
  type SessionSetting,
} from "./fixtures/race-harness";

/**
 * MANUAL, LIVE-DATABASE, POST-INDEX proof that production finalize() crosses
 * the identity unique-index collision path deterministically — not by
 * scheduler luck:
 *
 *   1. an interactive transaction W (Neon `Client` over WebSocket) inserts a
 *      holder account + passkey that collides, case-insensitively, with
 *      attempt L on ONE identity — and does NOT commit;
 *   2. production finalize(L) starts: its pre-claim conflict check cannot see
 *      W's uncommitted row, so it claims and INSERTs, and must then WAIT on
 *      W's uncommitted unique-index entry;
 *   3. the test waits for exactly that database state — Postgres reporting a
 *      backend running finalize's statement blocked by W's pid
 *      (pg_blocking_pids) — then commits W;
 *   4. finalize's transaction gets the real 23505 naming the identity index,
 *      rolls back whole, and its follow-up [lock, block] transaction blocks L.
 * A ROLLBACK of W instead must let finalize complete normally.
 *
 * Every case runs through fixtures/race-harness.ts's runRaceCase: internal
 * deadlines that CANCEL (HTTP AbortSignal + server statement_timeout; client
 * close + client/server timeouts on WebSocket sessions), and a teardown that
 * finishes before the case returns — including the termination proof
 * (neutralizeAndClean below). The Vitest timeout is only a last resort.
 *
 * Requires schema.sql's S5 L2 identity indexes to be APPLIED, and a DIRECT
 * (non-pooled) Neon endpoint — its own variable, never DATABASE_URL (normally
 * the pooled app URL). Every client here (production stores, holder,
 * monitor, sentinel, cleanup) uses that one URL:
 *
 *   REAL_SMOKE_L2_INDEXES=1 REAL_SMOKE_L2_DIRECT_DATABASE_URL="postgres://...@ep-xxx.<region>.aws.neon.tech/..." \
 *     pnpm exec vitest run test/lib/real/l2-identity-race.smoke.test.ts
 *
 * With the gate on, beforeAll REFUSES — before patching fetch or writing
 * anything — a missing/unparseable/pooled URL, or a session whose
 * application_name and timeouts the server did not actually apply.
 */
const enabled = process.env.REAL_SMOKE_L2_INDEXES === "1";
const COLUMNS = ["sub_organization_id", "owner_address", "safe_address"] as const;
type Column = (typeof COLUMNS)[number];
/** Last-resort runner guard only; every case's own deadlines and teardown finish well before it (worstCaseCaseMs). */
const LIVE_TIMEOUT_MS = RACE_LIMITS.outerTestMs;

function identityFor(userId: string) {
  const address = (label: string) => `0x${createHash("sha256").update(`${userId}:${label}`).digest("hex").slice(0, 40)}`;
  return { subOrganizationId: `${userId}-sub-org`, turnkeyUserId: `${userId}-turnkey-user`, walletId: `${userId}-wallet`, walletAccountId: `${userId}-wallet-account`, ownerAddress: address("owner"), safeAddress: address("safe") };
}
/** The SAME identity value in another letter case — one identity to the lower(...) indexes. */
function caseVariant(column: Column, of: ReturnType<typeof identityFor>): Partial<ReturnType<typeof identityFor>> {
  if (column === "sub_organization_id") return { subOrganizationId: of.subOrganizationId.toUpperCase() };
  if (column === "owner_address") return { ownerAddress: `0x${of.ownerAddress.slice(2).toUpperCase()}` };
  return { safeAddress: `0x${of.safeAddress.slice(2).toUpperCase()}` };
}

// Offline (never gated): each holder collides with the attempt ONLY case-insensitively, on exactly one identity.
describe("S5 L2 race harness: holder identities", () => {
  it.each(COLUMNS)("the %s variant differs in case from the attempt's value, is equal under lower(), and leaves the other identities distinct", (column) => {
    const attempt = identityFor("attempt");
    const holder = { ...identityFor("holder"), ...caseVariant(column, attempt) };
    const fields = { sub_organization_id: "subOrganizationId", owner_address: "ownerAddress", safe_address: "safeAddress" } as const;
    for (const c of COLUMNS) {
      const [a, h] = [attempt[fields[c]], holder[fields[c]]];
      if (c === column) {
        expect(h).not.toBe(a);
        expect(h.toLowerCase()).toBe(a.toLowerCase());
      } else expect(h.toLowerCase()).not.toBe(a.toLowerCase());
    }
  });
});

describe.skipIf(!enabled)("S5 L2 post-index: finalize crosses the identity 23505 path deterministically (live)", () => {
  const runId = randomUUID().slice(0, 8);
  /** Set only by beforeAll, after validation + the session preflight; nothing touches the database before that. */
  let directUrl: string | null = null;
  const databaseUrl = () => {
    if (!directUrl) throw new Error(`${DIRECT_DATABASE_URL_ENV} was not validated; refusing to touch the database`);
    return directUrl;
  };
  const poison = new Poison();
  const router = new RecordingRouter<Batch>();
  // Suite-wide backstop registry; each case also deletes its own rows in teardown.
  const suiteUserIds = new Set<string>();
  const suiteCredentialIds = new Set<string>();
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    // prepareRaceSuite: (1) validate the direct URL, (2) read-only session probe, (3) only then activate.
    // A refusal throws before step 3 — nothing patched, seeded, or written.
    const applicationName = `l2race_${runId}_preflight`;
    await prepareRaceSuite({
      env: process.env,
      applicationName,
      msSettings: { statement_timeout: RACE_LIMITS.statementTimeoutMs, lock_timeout: RACE_LIMITS.rowLockTimeoutMs, idle_in_transaction_session_timeout: RACE_LIMITS.holderIdleInTransactionMs },
      readSessionSettings: (url) =>
        bounded(
          "session preflight",
          RACE_LIMITS.cleanupMs,
          async (signal) => {
            const { neonConfig } = await import("@neondatabase/serverless");
            neonConfig.webSocketConstructor = globalThis.WebSocket as unknown as typeof neonConfig.webSocketConstructor;
            const client = await wsClient(applicationName, { lock_timeout: RACE_LIMITS.rowLockTimeoutMs }, url);
            try {
              await abortable(signal, client, () => client.connect());
              const { rows } = await abortable(signal, client, () =>
                client.query("SELECT name, setting, unit FROM pg_catalog.pg_settings WHERE name IN ('application_name', 'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout')"),
              );
              return rows as SessionSetting[];
            } finally {
              await client.end().catch(() => undefined);
            }
          },
          { poison, graceMs: RACE_LIMITS.graceMs },
        ),
      activate: (url) => {
        directUrl = url;
        globalThis.fetch = recordingFetch(realFetch, router);
      },
    });
  }, LIVE_TIMEOUT_MS);

  afterAll(async () => {
    if (!directUrl) return; // refused in beforeAll: nothing was patched or written
    try {
      await bounded(
        "suite backstop cleanup",
        RACE_LIMITS.cleanupMs,
        (signal) =>
          harnessTransaction(
            [
              ["DELETE FROM real_passkeys WHERE credential_id = ANY($1::text[])", [[...suiteCredentialIds]]],
              ["DELETE FROM real_accounts WHERE app_user_id = ANY($1::text[])", [[...suiteUserIds]]],
              ["DELETE FROM registration_attempts WHERE credential_id = ANY($1::text[])", [[...suiteCredentialIds]]],
            ],
            signal,
          ),
        { poison, graceMs: RACE_LIMITS.graceMs },
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    // Fail loudly: a case that couldn't prove its work stopped must not pass silently.
    if (poison.tripped) throw poison.tripped;
  }, LIVE_TIMEOUT_MS);

  /**
   * The harness's OWN HTTP queries (monitor, cancel, terminate, cleanup): one
   * transaction with a server-side statement_timeout, whose request is aborted
   * client-side by `signal`; marked so it is never recorded or tied to a case.
   */
  async function harnessTransaction(statements: Array<[string, unknown[]]>, signal: AbortSignal): Promise<Array<Array<Record<string, unknown>>>> {
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const sql = createNeonSqlClient(databaseUrl());
    const results = await sql.transaction([sql.query(`SET LOCAL statement_timeout = ${RACE_LIMITS.statementTimeoutMs}`), ...statements.map(([text, params]) => sql.query(text, params))], {
      fetchOptions: { signal, [HARNESS_REQUEST]: true },
    });
    return (results as Array<Array<Record<string, unknown>>>).slice(1);
  }
  const harnessQuery = async (text: string, params: unknown[], signal: AbortSignal) => (await harnessTransaction([[text, params]], signal))[0]!;

  /**
   * A WebSocket session for the holder or the cleanup sentinel: every call bounded client-side (query_timeout) and
   * server-side (statement/lock/idle-in-transaction timeouts, sent as startup `options` — see sessionStartupOptions).
   */
  async function wsClient(applicationName: string, extra: { lock_timeout?: number } = {}, connectionString: string = databaseUrl()): Promise<HolderClient> {
    const { Client } = await import("@neondatabase/serverless");
    return new Client({
      connectionString,
      application_name: applicationName,
      connectionTimeoutMillis: RACE_LIMITS.stepMs,
      query_timeout: RACE_LIMITS.stepMs,
      options: sessionStartupOptions(RACE_LIMITS, extra),
    }) as unknown as HolderClient;
  }

  async function stores() {
    const { createNeonDurableStores, createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    return { stores: createNeonDurableStores(databaseUrl()), sql: createNeonSqlClient(databaseUrl()) };
  }

  /** This case's rows, registered BEFORE each write so teardown can always remove them. */
  type CaseRows = { attemptCredentialId: string | null; userIds: Set<string>; credentialIds: Set<string> };
  const register = (rows: CaseRows, kind: "user" | "credential", id: string) => {
    (kind === "user" ? rows.userIds : rows.credentialIds).add(id);
    (kind === "user" ? suiteUserIds : suiteCredentialIds).add(id);
  };

  /** Attempt L walked to turnkey_created through the production store's own CAS transitions. */
  async function seedAttempt(rows: CaseRows, suffix: string) {
    const { stores: s, sql } = await stores();
    const userId = `smoke-${runId}-user-${suffix}`;
    const credId = Buffer.concat([Buffer.from("smokeL2R", "base64url"), createHash("sha256").update(`${runId}:${suffix}`).digest()]).toString("base64url");
    register(rows, "user", userId);
    register(rows, "credential", credId);
    rows.attemptCredentialId = credId;
    const identity = identityFor(userId);
    await s.attempts.createVerified({ credentialId: credId, appUserId: userId, userHandle: `${userId}-handle`, credentialPublicKey: `${userId}-cose`, counter: 0, transports: null, credentialDeviceType: null, credentialBackedUp: null, registrationChallenge: `${userId}-challenge`, rawClientDataJson: "x", rawAttestationObject: "x" });
    await s.attempts.transition({ credentialId: credId, from: "verified", to: "provisioning_in_flight", patch: { externalOutcome: "unknown" } });
    const { subOrganizationId, turnkeyUserId, walletId, walletAccountId, ownerAddress } = identity;
    await s.attempts.transition({ credentialId: credId, from: "provisioning_in_flight", to: "turnkey_created", patch: { subOrganizationId, turnkeyUserId, walletId, walletAccountId, ownerAddress, externalOutcome: "confirmed_created" } });
    const counts = async () => {
      const [row] = (await sql`SELECT (SELECT count(*) FROM real_accounts WHERE app_user_id = ${userId})::int AS accounts, (SELECT count(*) FROM real_passkeys WHERE credential_id = ${credId})::int AS passkeys`) as Array<{ accounts: number; passkeys: number }>;
      return row!;
    };
    return { s, userId, credId, identity, counts, finalizeInput: { credentialId: credId, registry: s.registry, safeAddress: identity.safeAddress, safeOwnerAddress: identity.ownerAddress, accountConfigVersion: 1 } };
  }

  /** Opens W (uncommitted holder account + passkey) and hands it to the case at once, so teardown always owns it. */
  async function openCaseHolder(ctx: RaceContext, rows: CaseRows, suffix: string, clash: Partial<ReturnType<typeof identityFor>>) {
    const holderId = `smoke-${runId}-holder-${suffix}`;
    const holderCred = `smoke-${runId}-holder-cred-${suffix}`;
    register(rows, "user", holderId);
    register(rows, "credential", holderCred);
    const account = { ...identityFor(holderId), ...clash };
    const applicationName = `l2race_${runId}_${suffix}`;
    const holder = await openHolder({
      client: await wsClient(applicationName),
      statements: [
        {
          text: "INSERT INTO real_accounts (app_user_id, sub_organization_id, turnkey_user_id, wallet_id, wallet_account_id, owner_address, safe_address, account_config_version) VALUES ($1, $2, $3, $4, $5, $6, $7, 1)",
          params: [holderId, account.subOrganizationId, account.turnkeyUserId, account.walletId, account.walletAccountId, account.ownerAddress, account.safeAddress],
        },
        { text: "INSERT INTO real_passkeys (credential_id, app_user_id, credential_public_key, user_handle, counter, status, role) VALUES ($1, $2, 'holder-cose', 'holder-handle', 0, 'active', 'primary')", params: [holderCred, holderId] },
      ],
      step: ctx.step,
      cleanupStep: ctx.teardownStep,
      // Exactly this session (pid AND our application_name), waiting up to 1.5 s for it to be gone, then proving it is.
      terminate: async (pid, signal) => {
        await harnessQuery("SELECT pg_catalog.pg_terminate_backend(pid, 1500) FROM pg_catalog.pg_stat_activity WHERE pid = $1 AND application_name = $2", [pid, applicationName], signal);
        const [left] = await harnessQuery("SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE pid = $1 AND application_name = $2", [pid, applicationName], signal);
        if (Number(left?.n) !== 0) throw new Error("holder session still present after pg_terminate_backend");
      },
    });
    ctx.setHolder(holder);
    return { holder, holderId, holderCred, account };
  }

  function hooksFor(rows: CaseRows, suffix: string): RaceHooks {
    return {
      // Only backends blocked by OUR holder: exactly this case's finalize, nothing else on the database.
      cancelBlockedBy: async (holderPid, signal) => {
        await harnessQuery("SELECT pg_catalog.pg_cancel_backend(pid) FROM pg_catalog.pg_stat_activity WHERE $1::int = ANY (pg_catalog.pg_blocking_pids(pid))", [holderPid], signal);
      },
      // The termination proof: take L's attempt-row lock (finalize's first statement holds it for its whole
      // transaction), then delete L's attempt and every case row, and commit. Afterwards no finalize for L is
      // running, and any still in flight finds no attempt and writes nothing.
      neutralizeAndClean: async (signal) => {
        const client = await wsClient(`l2race_${runId}_${suffix}_sentinel`, { lock_timeout: RACE_LIMITS.rowLockTimeoutMs });
        const call = <T,>(operation: () => Promise<T>) => abortable(signal, client, operation);
        let begun = false;
        try {
          await call(() => client.connect());
          await call(() => client.query("BEGIN"));
          begun = true;
          if (rows.attemptCredentialId) await call(() => client.query("SELECT credential_id FROM registration_attempts WHERE credential_id = $1 FOR UPDATE", [rows.attemptCredentialId]));
          await call(() => client.query("DELETE FROM real_passkeys WHERE credential_id = ANY($1::text[])", [[...rows.credentialIds]]));
          await call(() => client.query("DELETE FROM real_accounts WHERE app_user_id = ANY($1::text[])", [[...rows.userIds]]));
          await call(() => client.query("DELETE FROM registration_attempts WHERE credential_id = ANY($1::text[])", [[...rows.credentialIds]]));
          await call(() => client.query("COMMIT"));
          begun = false;
        } finally {
          if (begun) await client.query("ROLLBACK").catch(() => undefined);
          await client.end().catch(() => undefined);
        }
      },
    };
  }

  const monitorQuery = async (holderPid: number, signal: AbortSignal) =>
    (await harnessQuery("SELECT pid, query FROM pg_catalog.pg_stat_activity WHERE $1::int = ANY (pg_catalog.pg_blocking_pids(pid))", [holderPid], signal)) as Array<{ pid: number; query: string }>;

  it("preflight: exactly the three L2 identity unique indexes exist on public.real_accounts", async () => {
    poison.assertHealthy();
    const { ACCOUNT_IDENTITY_UNIQUE_INDEXES } = await import("@/lib/real/server/neon-store");
    // Schema-qualified: a same-named index in any other schema (e.g. a migration-smoke scratch schema) never satisfies this.
    const rows = await bounded(
      "preflight",
      RACE_LIMITS.stepMs,
      (signal) => harnessQuery("SELECT indexname FROM pg_catalog.pg_indexes WHERE schemaname = 'public' AND tablename = 'real_accounts' AND indexname = ANY($1::text[])", [[...ACCOUNT_IDENTITY_UNIQUE_INDEXES]], signal),
      { poison, graceMs: RACE_LIMITS.graceMs },
    );
    expect(rows.map((r) => String(r.indexname)).sort(), "apply schema.sql's S5 L2 migration first").toEqual([...ACCOUNT_IDENTITY_UNIQUE_INDEXES].sort());
  }, LIVE_TIMEOUT_MS);

  it.each(COLUMNS)("COMMITTED holder clashing on %s: real 23505 on that index, whole rollback, one follow-up block, loser blocked with zero rows, holder intact", async (column) => {
    const { REGISTRATION_IDENTITY_CONFLICT_REASON } = await import("@/lib/real/server/registration-attempts");
    const suffix = `c-${column.split("_")[0]}`;
    const rows: CaseRows = { attemptCredentialId: null, userIds: new Set(), credentialIds: new Set() };
    await runRaceCase({
      limits: RACE_LIMITS,
      poison,
      router,
      hooks: hooksFor(rows, suffix),
      run: async (ctx) => {
        const l = await seedAttempt(rows, suffix);
        const { holder, holderId, holderCred, account } = await openCaseHolder(ctx, rows, suffix, caseVariant(column, l.identity));
        const finalizing = ctx.startFinalize(() => l.s.attempts.finalize(l.finalizeInput));
        const waiter = await waitForFinalizeBlockedBy({ holderPid: holder.pid, finalize: finalizing, query: monitorQuery, step: ctx.step, limits: RACE_LIMITS, signal: ctx.signal });
        expect(waiter.query).toMatch(/INSERT INTO real_accounts/);
        await ctx.step("holder COMMIT", (signal) => holder.commit(signal));

        expect(await ctx.awaitFinalize(finalizing)).toBeNull();
        const batches = ctx.recorder.items;
        expect(batches).toHaveLength(2);
        // 1. The finalize transaction itself: Postgres's own 23505, naming exactly this identity index.
        expect(batches[0]!.queries).toHaveLength(7);
        expect(batches[0]!.status).toBeGreaterThanOrEqual(400);
        expect(batches[0]!.body).toMatchObject({ code: "23505", constraint: `real_accounts_${column}_lower_key` });
        // 2. Exactly one follow-up: [lock, block].
        expect(batches[1]!.queries).toHaveLength(2);
        expect(batches[1]!.queries[0]!.query).toMatch(/FOR UPDATE/);
        expect(batches[1]!.queries[1]!.query).toMatch(/SET state = 'blocked'/);
        expect(batches[1]!.status).toBe(200);

        const attempt = await l.s.attempts.findByCredentialId(l.credId);
        expect(attempt).toMatchObject({ state: "blocked", blockReason: REGISTRATION_IDENTITY_CONFLICT_REASON, safeAddress: null, accountConfigVersion: null });
        expect(await l.counts()).toEqual({ accounts: 0, passkeys: 0 });
        expect(await l.s.registry.findAccountByAppUserId(holderId)).toMatchObject({ subOrganizationId: account.subOrganizationId, ownerAddress: account.ownerAddress, safeAddress: account.safeAddress });
        expect((await l.s.registry.findPasskeyByCredentialId(holderCred))?.appUserId).toBe(holderId);
      },
    });
  }, LIVE_TIMEOUT_MS);

  it.each(COLUMNS)("ROLLED-BACK holder clashing on %s: finalize proceeds and completes normally; no follow-up transaction", async (column) => {
    const suffix = `r-${column.split("_")[0]}`;
    const rows: CaseRows = { attemptCredentialId: null, userIds: new Set(), credentialIds: new Set() };
    await runRaceCase({
      limits: RACE_LIMITS,
      poison,
      router,
      hooks: hooksFor(rows, suffix),
      run: async (ctx) => {
        const l = await seedAttempt(rows, suffix);
        const { holder, holderId } = await openCaseHolder(ctx, rows, suffix, caseVariant(column, l.identity));
        const finalizing = ctx.startFinalize(() => l.s.attempts.finalize(l.finalizeInput));
        await waitForFinalizeBlockedBy({ holderPid: holder.pid, finalize: finalizing, query: monitorQuery, step: ctx.step, limits: RACE_LIMITS, signal: ctx.signal });
        await ctx.step("holder ROLLBACK", (signal) => holder.rollback(signal));

        const finalized = await ctx.awaitFinalize(finalizing);
        const batches = ctx.recorder.items;
        expect(finalized?.account.appUserId).toBe(l.userId);
        expect(batches).toHaveLength(1);
        expect(batches[0]!.status).toBe(200);
        expect((await l.s.attempts.findByCredentialId(l.credId))?.state).toBe("active");
        expect(await l.counts()).toEqual({ accounts: 1, passkeys: 1 });
        expect(await l.s.registry.findAccountByAppUserId(holderId)).toBeNull();
      },
    });
  }, LIVE_TIMEOUT_MS);
});
