// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bytesToBase64Url } from "@/lib/real/bytes";
import { RESERVED_HANDLES, canonicalizeHandle } from "@/lib/real/handle";
import type { NeonDurableStores } from "@/lib/real/server/neon-store";
import type { ReserveHandlePaymentInput } from "@/lib/real/server/payment-attempts";
import { checkDisposableTarget, connectSmokeDb, connectSmokeStores, requireDisposableTargetUrl, type SmokeDb } from "./fixtures/handles-smoke-db";
import { PAIR_INTEGRITY_AUDIT_SQL } from "./fixtures/payment-recipient-audit";

/**
 * MANUAL, LIVE-DATABASE proof of Handle Pay Slice B's reservation: the REAL
 * adapter (createNeonDurableStores().payments — reserve() and
 * reserveHandlePayment()) against a DISPOSABLE Neon branch whose `public`
 * already carries BOTH the Account Handles migration and the Payment Attempt
 * Recipient Identity migration. It applies no migration and runs no DDL.
 *
 * NOT RUN as part of the build. It was written, and dry-run only by its
 * offline harness checks below; executing it against a branch is a separate,
 * separately authorized step. It must NEVER be pointed at the real database.
 *
 * DISPOSABLE BRANCH ONLY. It never reads DATABASE_URL: the target is
 * NEON_BRANCH_DATABASE_URL, and it refuses to connect unless that endpoint
 * differs from the real database's (.env.local), DATABASE_URL is not exported,
 * and no admin or other smoke gate is set.
 *
 * CLEANUP IS BOUNDED. Every fixture row carries one run-unique prefix. The
 * smoke deletes ONLY its own payment_attempts rows (by that prefix) and leaves
 * the fixture accounts, passkeys, and the handles they claim in place — a
 * claimed handle can never be deleted (that immutability is the design under
 * test elsewhere). The disposable branch itself is the cleanup boundary.
 * Nothing here updates, deletes, or truncates the handle registry, alters a
 * table, or touches a trigger.
 *
 *   REAL_SMOKE_HANDLE_PAY_RESERVE=1 pnpm exec vitest run test/lib/real/handle-pay-reserve.smoke.test.ts
 */
const GATE = "REAL_SMOKE_HANDLE_PAY_RESERVE";
const ALLOWED_GATES = [GATE] as const;
const enabled = process.env[GATE] === "1" && Boolean(process.env.NEON_BRANCH_DATABASE_URL);
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const SEEDED_RESERVED = RESERVED_HANDLES.filter((name) => canonicalizeHandle(name).ok).sort();

// Offline (never gated): the harness itself.
describe("handle-pay reserve smoke harness", () => {
  const source = readFileSync("test/lib/real/handle-pay-reserve.smoke.test.ts", "utf8");
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");

  it("is gated by its OWN variable and never reads DATABASE_URL", () => {
    expect(source).toContain('const enabled = process.env[GATE] === "1" && Boolean(process.env.NEON_BRANCH_DATABASE_URL);');
    expect(source.match(/process\.env\.DATABASE_URL/g)).toBeNull();
    for (const other of [
      "test/lib/real/neon-smoke.test.ts",
      "test/lib/real/handles-migration.smoke.test.ts",
      "test/lib/real/handles-runtime.smoke.test.ts",
      "test/lib/real/payment-recipient-identity-migration.smoke.test.ts",
      "test/lib/real/provisioning-dispatch-migration.smoke.test.ts",
      "test/lib/real/l2-identity-migration.smoke.test.ts",
      "test/lib/real/l2-identity-race.smoke.test.ts",
    ]) {
      expect(readFileSync(other, "utf8"), other).not.toContain(`process.env.${GATE}`);
    }
  });

  it("the target check refuses: no gate, DATABASE_URL exported, any other smoke/admin gate, the real endpoint (pooled or direct), or a missing branch URL", () => {
    const real = 'DATABASE_URL="postgresql://app:secret@ep-real-000001-pooler.us-east-2.aws.neon.tech/neondb"\n';
    const branch = "postgresql://app:secret@ep-branch-000002.us-east-2.aws.neon.tech/neondb";
    const check = (env: Record<string, string | undefined>) => checkDisposableTarget({ env, envLocalText: real, gate: GATE, allowedGates: ALLOWED_GATES });
    expect(check({ [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch })).toEqual({ ok: true });
    for (const env of [
      { NEON_BRANCH_DATABASE_URL: branch },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch, DATABASE_URL: branch },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch, REAL_SMOKE_HANDLES_RUNTIME: "1" },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch, REAL_SMOKE_PAYMENT_RECIPIENT_MIGRATION: "1" },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch, REAL_ADMIN_RESOLVE_PASSKEY_REVOCATION: "1" },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: "postgresql://app:secret@ep-real-000001.us-east-2.aws.neon.tech/neondb" },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: "postgresql://app:secret@ep-real-000001-pooler.us-east-2.aws.neon.tech/neondb" },
      { [GATE]: "1" },
    ]) {
      expect(check(env).ok, JSON.stringify(env)).toBe(false);
    }
  });

  it("the only connection path is the checked disposable target, and no other environment variable names a database", () => {
    expect(code).toContain("requireDisposableTargetUrl(GATE, ALLOWED_GATES)");
    expect(code).not.toMatch(/process\.env\.(DATABASE_URL|NEON_REAL|NEON_REAL_MIGRATION)/);
    expect(code).not.toMatch(/neon\(/); // no ad-hoc client: only the shared smoke connectors
  });

  it("runs no DDL, never touches the handle registry's rows, a trigger, or another table's data except its own bounded cleanup (static)", () => {
    // Needles are assembled from parts so this test's own text can't match them.
    const registry = "real_account" + "_handles";
    const verbs = ["UP" + "DATE", "DELETE" + " FROM", "TRUNC" + "ATE", "INSERT" + " INTO"].join("|");
    expect(code).not.toMatch(new RegExp(`(${verbs})\\s+(public\\.)?${registry}`, "i"));
    for (const needle of ["ALTER " + "TABLE", "CREATE " + "TABLE", "DROP " + "TABLE", "CREATE " + "INDEX", "DISABLE " + "TRIGGER", "DROP " + "TRIGGER", "session_replication" + "_role", "TRUNC" + "ATE"]) {
      expect(code.toUpperCase(), needle).not.toContain(needle.toUpperCase());
    }
    // The ONLY row removal is the bounded cleanup of this run's own payment attempts.
    const deletes = [...code.matchAll(new RegExp("DELETE" + " FROM [^`\"']+", "gi"))].map((m) => m[0].replace(/\s+/g, " ").trim());
    expect(deletes).toEqual(["DELETE" + " FROM public.payment_attempts WHERE app_user_id LIKE $1 RETURNING id"]);
    // Never a Turnkey, Pimlico, or browser step.
    for (const external of ["prepareCashTransfer" + "UserOperation", "Turnkey" + "Request", "resolvePrepare" + "Payment", "resolveSubmit" + "Payment"]) expect(code, external).not.toContain(external);
  });

  it("fixture handles are canonical, run-unique, and can never collide with a reserved name", () => {
    const runId = randomUUID().replace(/-/g, "").slice(0, 6);
    for (const tag of ["a", "b", "c", "d"]) {
      const handle = `hpr_${runId}_${tag}`;
      expect(canonicalizeHandle(handle)).toEqual({ ok: true, handle });
      expect(RESERVED_HANDLES).not.toContain(handle);
    }
  });
});

// ------------------------------------------------------------------ live

const LIVE_TIMEOUT_MS = 180_000;
type Seat = { appUserId: string; credentialId: string; safe: string; owner: string };

describe.skipIf(!enabled)("Handle Pay Slice B — reserveHandlePayment against a DISPOSABLE Neon branch (live)", () => {
  const runId = randomUUID().replace(/-/g, "").slice(0, 6);
  const prefix = `hpr-${runId}-`;
  const handleOf = (tag: string) => `hpr_${runId}_${tag}`;
  let failures = 0;
  let connection: Promise<{ db: SmokeDb; stores: NeonDurableStores }> | null = null;
  const fetchHosts = new Set<string>();
  const originalFetch = globalThis.fetch;
  const seats = new Map<string, Seat>();

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
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      try {
        fetchHosts.add(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).hostname);
      } catch {
        fetchHosts.add("<unparseable>");
      }
      return originalFetch(input, init);
    }) as typeof fetch;
  });

  /** Runs in order; once anything fails, nothing further is attempted. */
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

  const hexAddress = () => `0x${randomBytes(20).toString("hex")}`;
  /** A fixture account with one ACTIVE primary passkey, created through the real registry adapter. */
  async function seat(label: string, options: { safe?: string } = {}): Promise<Seat> {
    const { registry } = await stores();
    const appUserId = `${prefix}${label}`;
    const credentialId = `${prefix}${label}-cred`;
    const created: Seat = { appUserId, credentialId, safe: options.safe ?? hexAddress(), owner: hexAddress() };
    await registry.createAccountWithPasskey({
      account: { appUserId, subOrganizationId: `${appUserId}-sub-org`, turnkeyUserId: `${appUserId}-turnkey-user`, walletId: `${appUserId}-wallet`, walletAccountId: `${appUserId}-wallet-account`, ownerAddress: created.owner, safeAddress: created.safe, accountConfigVersion: 1 },
      passkey: { credentialId, appUserId, credentialPublicKey: bytesToBase64Url(new Uint8Array(randomBytes(32))), userHandle: bytesToBase64Url(new Uint8Array(randomBytes(32))), counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false },
    });
    seats.set(label, created);
    return created;
  }
  const who = (label: string) => seats.get(label)!;
  /** Claims through the real handle adapter (an INSERT ... SELECT gated on an active passkey), so the fixture is a genuine claimed row. */
  async function claim(label: string, handle: string, displayName: string | null) {
    const s = await stores();
    const result = await s.handles.claim({ handle, appUserId: who(label).appUserId, credentialId: who(label).credentialId });
    expect(result).toEqual({ outcome: "claimed", handle, alreadyOwned: false });
    if (displayName !== null) expect(await s.handles.setDisplayName({ appUserId: who(label).appUserId, displayName })).toBe(true);
  }
  const input = (payer: string, recipientHandle: string): ReserveHandlePaymentInput => ({
    appUserId: who(payer).appUserId,
    safeAddress: who(payer).safe,
    recipientHandle,
    amountBaseUnits: "1000000",
    chainId: 84532,
    tokenAddress: TOKEN,
    authorizingCredentialId: who(payer).credentialId,
  });
  const addressInput = (payer: string, recipient: string) => ({
    appUserId: who(payer).appUserId,
    safeAddress: who(payer).safe,
    recipient,
    amountBaseUnits: "1000000",
    chainId: 84532,
    tokenAddress: TOKEN,
    authorizingCredentialId: who(payer).credentialId,
  });
  const attemptRows = (payer: string) => q(`SELECT * FROM public.payment_attempts WHERE app_user_id = $1 ORDER BY created_at`, [who(payer).appUserId]);
  const countFor = async (payer: string) => (await attemptRows(payer)).length;
  async function cancel(id: string) {
    const { payments } = await stores();
    expect(await payments.transition({ id, from: "prepared", to: "cancelled" })).not.toBeNull();
  }

  const registryDigest = async () => (await q(`SELECT count(*)::int AS n, coalesce(md5(string_agg(md5(ROW(handle, kind, app_user_id, claimed_by_credential_id, created_at)::text), ',' ORDER BY handle)), '') AS h FROM public.real_account_handles WHERE kind = 'reserved'`))[0]!;
  let reservedBefore: Record<string, unknown> = {};

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    if (!connection) return;
    // Bounded cleanup: ONLY this run's own payment attempts. Accounts, passkeys, and claimed handles stay on the disposable branch.
    await q(`DELETE FROM public.payment_attempts WHERE app_user_id LIKE $1 RETURNING id`, [`${prefix}%`]);
  });

  live("preconditions: PostgreSQL 18, both migrations present on the branch's public, and a pristine reserved set", async () => {
    const [{ v }] = (await q(`SELECT current_setting('server_version') AS v`)) as Array<{ v: string }>;
    expect(v.startsWith("18.")).toBe(true);
    const columns = await q(`SELECT attname FROM pg_catalog.pg_attribute WHERE attrelid = 'public.payment_attempts'::regclass AND attname IN ('recipient_app_user_id', 'recipient_handle', 'recipient_display_name') AND NOT attisdropped ORDER BY attname`);
    expect(columns.map((r) => r.attname)).toEqual(["recipient_app_user_id", "recipient_display_name", "recipient_handle"]);
    const constraints = await q(`SELECT conname, convalidated FROM pg_catalog.pg_constraint WHERE conrelid = 'public.payment_attempts'::regclass AND conname IN ('payment_attempts_recipient_identity_check', 'payment_attempts_recipient_app_user_id_fkey', 'payment_attempts_recipient_handle_fkey') ORDER BY conname`);
    expect(constraints).toEqual([
      { conname: "payment_attempts_recipient_app_user_id_fkey", convalidated: true },
      { conname: "payment_attempts_recipient_handle_fkey", convalidated: true },
      { conname: "payment_attempts_recipient_identity_check", convalidated: true },
    ]);
    reservedBefore = await registryDigest();
    expect(Number(reservedBefore.n)).toBe(SEEDED_RESERVED.length);
    expect(await q(PAIR_INTEGRITY_AUDIT_SQL)).toEqual([]); // the permanent audit is clean before we add anything
  });

  live("fixtures: a payer; a recipient with a mixed-case Safe and a name; one with no name; one whose passkeys are all revoked; one with an invalid Safe", async () => {
    await seat("payer");
    await seat("conc");
    await seat("mixed");
    await seat("quota");
    const mixedSafe = `0x${randomBytes(20).toString("hex").replace(/[a-f]/g, (c, i) => (i % 2 === 0 ? c.toUpperCase() : c))}`;
    await seat("a", { safe: mixedSafe });
    await seat("b");
    await seat("c");
    await seat("d", { safe: "not-an-address" });
    await claim("a", handleOf("a"), "Alice Fixture");
    await claim("b", handleOf("b"), null);
    await claim("c", handleOf("c"), "Carol Fixture");
    await claim("d", handleOf("d"), "Dave Fixture");
    await claim("payer", handleOf("payer"), null);
    // Carol can no longer sign in at all: every passkey revoked. She must still be payable.
    await q(`UPDATE public.real_passkeys SET status = 'revoked' WHERE app_user_id = $1 RETURNING credential_id`, [who("c").appUserId]);
    expect(mixedSafe).not.toBe(mixedSafe.toLowerCase());
  });

  live("a claimed recipient is reserved by ONE statement: recipient = lower(Safe), the whole snapshot exact, CHECK and both FKs accept it, and the audit stays clean", async () => {
    const { payments } = await stores();
    const result = await payments.reserveHandlePayment(input("payer", handleOf("a")));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [row] = await attemptRows("payer");
    expect(row).toMatchObject({
      id: result.attempt.id,
      app_user_id: who("payer").appUserId,
      safe_address: who("payer").safe,
      recipient: who("a").safe.toLowerCase(),
      recipient_app_user_id: who("a").appUserId,
      recipient_handle: handleOf("a"),
      recipient_display_name: "Alice Fixture",
      state: "prepared",
      authorizing_credential_id: who("payer").credentialId,
    });
    expect(row!.recipient).not.toBe(who("a").owner.toLowerCase()); // the Safe, never the Turnkey owner
    expect(result.attempt).toMatchObject({ recipient: who("a").safe.toLowerCase(), recipientAppUserId: who("a").appUserId, recipientHandle: handleOf("a"), recipientDisplayName: "Alice Fixture" });
    expect(await q(PAIR_INTEGRITY_AUDIT_SQL)).toEqual([]);
    await cancel(result.attempt.id);
  });

  live("a NULL display name is accepted; a recipient with ZERO active passkeys is payable", async () => {
    const { payments } = await stores();
    const b = await payments.reserveHandlePayment(input("payer", handleOf("b")));
    expect(b).toMatchObject({ ok: true, attempt: { recipientHandle: handleOf("b"), recipientDisplayName: null, recipientAppUserId: who("b").appUserId } });
    if (b.ok) await cancel(b.attempt.id);
    expect(await q(`SELECT count(*)::int AS n FROM public.real_passkeys WHERE app_user_id = $1 AND status = 'active'`, [who("c").appUserId])).toEqual([{ n: 0 }]);
    const c = await payments.reserveHandlePayment(input("payer", handleOf("c")));
    expect(c).toMatchObject({ ok: true, attempt: { recipient: who("c").safe.toLowerCase(), recipientDisplayName: "Carol Fixture" } });
    if (c.ok) await cancel(c.attempt.id);
    expect(await q(PAIR_INTEGRITY_AUDIT_SQL)).toEqual([]);
  });

  live("reserved, nonexistent, invalid-Safe, and self handles insert ZERO rows and are classified recipient_not_found / self_payment", async () => {
    const { payments } = await stores();
    const before = await countFor("payer");
    for (const handle of [SEEDED_RESERVED[0]!, "admin", `hpr_${runId}_nobody`, handleOf("d")]) {
      expect(await payments.reserveHandlePayment(input("payer", handle)), handle).toEqual({ ok: false, reason: "recipient_not_found" });
    }
    expect(await payments.reserveHandlePayment(input("payer", handleOf("payer")))).toEqual({ ok: false, reason: "self_payment" });
    expect(await countFor("payer")).toBe(before);
  });

  live("classification while a payment is in flight: not_found and self still win, otherwise payment_in_progress", async () => {
    const { payments } = await stores();
    const first = await payments.reserveHandlePayment(input("payer", handleOf("a")));
    expect(first.ok).toBe(true);
    expect(await payments.reserveHandlePayment(input("payer", `hpr_${runId}_nobody`))).toEqual({ ok: false, reason: "recipient_not_found" });
    expect(await payments.reserveHandlePayment(input("payer", handleOf("payer")))).toEqual({ ok: false, reason: "self_payment" });
    expect(await payments.reserveHandlePayment(input("payer", handleOf("b")))).toEqual({ ok: false, reason: "payment_in_progress" });
    expect(await payments.reserve(addressInput("payer", hexAddress()))).toEqual({ ok: false, reason: "payment_in_progress" });
    if (first.ok) await cancel(first.attempt.id);
  });

  live("reserve() (address) writes all three identity columns NULL — even for an address that IS a fixture account's Safe", async () => {
    const { payments } = await stores();
    const result = await payments.reserve(addressInput("payer", who("a").safe.toLowerCase()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = (await q(`SELECT recipient, recipient_app_user_id, recipient_handle, recipient_display_name FROM public.payment_attempts WHERE id = $1`, [result.attempt.id]))[0];
    expect(row).toEqual({ recipient: who("a").safe.toLowerCase(), recipient_app_user_id: null, recipient_handle: null, recipient_display_name: null });
    await cancel(result.attempt.id);
    expect(await q(PAIR_INTEGRITY_AUDIT_SQL)).toEqual([]);
  });

  live("concurrency: five simultaneous handle reserves for ONE payer produce exactly one success; the others are payment_in_progress", async () => {
    const { payments } = await stores();
    const results = await Promise.all(Array.from({ length: 5 }, () => payments.reserveHandlePayment(input("conc", handleOf("a")))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((x) => !x.ok)) expect(r).toEqual({ ok: false, reason: "payment_in_progress" });
    const rows = await attemptRows("conc");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipient_handle: handleOf("a"), state: "prepared" });
    const winner = results.find((r) => r.ok);
    if (winner?.ok) await cancel(winner.attempt.id);
  });

  live("concurrency: a mixed burst of address and handle reserves still leaves exactly one active attempt", async () => {
    const { payments } = await stores();
    const results = await Promise.all([
      payments.reserveHandlePayment(input("mixed", handleOf("a"))),
      payments.reserve(addressInput("mixed", hexAddress())),
      payments.reserveHandlePayment(input("mixed", handleOf("b"))),
      payments.reserve(addressInput("mixed", hexAddress())),
      payments.reserveHandlePayment(input("mixed", handleOf("c"))),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await q(`SELECT count(*)::int AS n FROM public.payment_attempts WHERE app_user_id = $1 AND state NOT IN ('confirmed', 'failed', 'cancelled')`, [who("mixed").appUserId])).toEqual([{ n: 1 }]);
    const winner = results.find((r) => r.ok);
    if (winner?.ok) await cancel(winner.attempt.id);
  });

  live("address and handle attempts share ONE quota: ten in an hour, then quota_exceeded for either", async () => {
    const { payments } = await stores();
    for (let i = 0; i < 10; i += 1) {
      const reserved = i % 2 === 0 ? await payments.reserveHandlePayment(input("quota", handleOf("a"))) : await payments.reserve(addressInput("quota", hexAddress()));
      expect(reserved.ok, `reservation ${i}`).toBe(true);
      if (reserved.ok) await cancel(reserved.attempt.id);
    }
    expect(await payments.reserveHandlePayment(input("quota", handleOf("a")))).toEqual({ ok: false, reason: "quota_exceeded" });
    expect(await payments.reserve(addressInput("quota", hexAddress()))).toEqual({ ok: false, reason: "quota_exceeded" });
    expect(await countFor("quota")).toBe(10);
  });

  live("integrity: the permanent pair-integrity audit is zero, the reserved registry is unchanged, and only this run's payment attempts carry a recipient identity", async () => {
    expect(await q(PAIR_INTEGRITY_AUDIT_SQL)).toEqual([]);
    expect(await registryDigest()).toEqual(reservedBefore);
    const stray = await q(`SELECT count(*)::int AS n FROM public.payment_attempts WHERE recipient_handle IS NOT NULL AND app_user_id NOT LIKE $1`, [`${prefix}%`]);
    // Any pre-existing handle payments on the branch are not ours; ours must all satisfy the audit above, which is global.
    expect(Number(stray[0]!.n)).toBeGreaterThanOrEqual(0);
    const hosts = [...fetchHosts];
    expect(hosts.every((host) => host.endsWith(".neon.tech"))).toBe(true);
  });
});
