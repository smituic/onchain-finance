// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNeonDurableStores } from "@/lib/real/server/neon-store";
import { createInMemoryRealAccountRegistry } from "@/lib/real/server/registry";

/**
 * S5 L3: the Neon registration finalize, driven through the REAL
 * @neondatabase/serverless driver with fetch intercepted (nothing leaves the
 * process). Proves the shape of what is sent — one transaction, no pre-read,
 * both INSERTs fed only by the CAS's own RETURNING rows — and how finalize
 * interprets each server answer. That the SQL behaves as intended against
 * real Postgres (lost CAS writes nothing, the same-statement FK holds,
 * concurrency) is proven by the DATABASE_URL-gated neon-smoke suite.
 */
const DATABASE_URL = "postgresql://user:pass@ep-finalize-test-000000.us-east-2.aws.neon.tech/neondb";
const CREDENTIAL_ID = "Y3JlZGVudGlhbC1pZA";
const SAFE = "0x1111111111111111111111111111111111111111";

type Sent = { queries: Array<{ query: string; params: unknown[] }> | null; single: { query: string; params: unknown[] } | null; isolation: string | null };
let sent: Sent[] = [];
let respond: (request: Sent) => Response;

beforeEach(() => {
  sent = [];
  vi.stubGlobal("fetch", async (_url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as { queries?: Sent["queries"]; query?: string; params?: unknown[] };
    const request: Sent = {
      queries: body.queries ?? null,
      single: body.query ? { query: body.query, params: body.params ?? [] } : null,
      isolation: new Headers(init?.headers).get("Neon-Batch-Isolation-Level"),
    };
    sent.push(request);
    return respond(request);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** One query result in the driver's HTTP wire shape (array mode, text values). */
function result(rows: Array<Record<string, unknown>>) {
  const names = Object.keys(rows[0] ?? {});
  return { fields: names.map((name) => ({ name, dataTypeID: 25 })), rows: rows.map((row) => names.map((name) => (row[name] === null ? null : String(row[name])))) };
}

const accountRow = {
  app_user_id: "app-user-1",
  sub_organization_id: "sub-org-1",
  turnkey_user_id: "turnkey-user-1",
  wallet_id: "wallet-1",
  wallet_account_id: "wallet-account-1",
  owner_address: "0xF6C3FE6DE636f0d8f421d5485D1a64fF3628CFaF",
  safe_address: SAFE,
  account_config_version: 1,
  session_epoch: 0,
  created_at: "2026-09-30T00:00:00.000Z",
};
const passkeyRow = {
  credential_id: CREDENTIAL_ID,
  app_user_id: "app-user-1",
  credential_public_key: "cose",
  user_handle: "handle",
  counter: 0,
  transports: null,
  credential_device_type: null,
  credential_backed_up: null,
  status: "active",
  role: "primary",
  turnkey_authenticator_id: null,
  display_name: null,
  created_at: "2026-09-30T00:00:00.000Z",
};

function batchResponse(claimed: 0 | 1, reads: { account: boolean; passkey: boolean }) {
  return Response.json({
    results: [
      result([{ credential_id: CREDENTIAL_ID }]),
      result([{ claimed, guard: null }]),
      result([]),
      result([]),
      result(reads.account ? [accountRow] : []),
      result(reads.passkey ? [passkeyRow] : []),
    ],
  });
}

/** Any single (non-batch) query — i.e. a re-read — is answered with plausible rows, so a regression that re-reads and reuses would visibly succeed. */
function singleQueryRows(request: Sent): Response {
  return Response.json(result(/real_passkeys/.test(request.single!.query) ? [passkeyRow] : [accountRow]));
}

function finalize() {
  const { attempts } = createNeonDurableStores(DATABASE_URL);
  return attempts.finalize({ credentialId: CREDENTIAL_ID, registry: createInMemoryRealAccountRegistry(), safeAddress: SAFE, accountConfigVersion: 1 });
}

describe("Neon registration finalize: one transaction whose INSERTs derive only from the CAS (S5 L3)", () => {
  it("sends exactly ONE ReadCommitted batch — no read before it — locking the attempt row first", async () => {
    respond = () => batchResponse(1, { account: true, passkey: true });
    await finalize();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.single).toBeNull();
    expect(sent[0]!.isolation).toBe("ReadCommitted");
    const queries = sent[0]!.queries!;
    expect(queries).toHaveLength(6);
    expect(queries[0]!.query).toMatch(/^\s*SELECT credential_id FROM registration_attempts WHERE credential_id = \$1 FOR UPDATE\s*$/);
  });

  it("the CAS and both INSERTs are ONE statement; both INSERTs select FROM the CAS's RETURNING rows, never VALUES, and the passkey is joined to the account actually inserted", async () => {
    respond = () => batchResponse(1, { account: true, passkey: true });
    await finalize();
    const queries = sent[0]!.queries!;
    const writing = queries.filter((q) => /\b(INSERT|DELETE)\b|(?<!FOR )\bUPDATE\b/i.test(q.query));
    expect(writing).toEqual([queries[1]]);

    const statement = queries[1]!.query.replace(/\s+/g, " ");
    expect(statement).toMatch(/^ ?WITH claimed AS \( UPDATE registration_attempts SET state = 'active'/);
    expect(statement).toMatch(/WHERE credential_id = \$3 AND state = 'turnkey_created' AND sub_organization_id IS NOT NULL AND turnkey_user_id IS NOT NULL AND wallet_id IS NOT NULL AND wallet_account_id IS NOT NULL AND owner_address IS NOT NULL RETURNING \*/);
    expect(statement).toMatch(/account_insert AS \( INSERT INTO real_accounts \([^)]*\) SELECT [^()]* FROM claimed c ON CONFLICT DO NOTHING RETURNING app_user_id \)/);
    expect(statement).toMatch(/passkey_insert AS \( INSERT INTO real_passkeys \([^)]*\) SELECT [^()]* FROM claimed c JOIN account_insert a ON a\.app_user_id = c\.app_user_id ON CONFLICT DO NOTHING/);
    expect(statement).not.toMatch(/\bVALUES\b/i);
    // In-statement guard: a won CAS must have produced exactly one of each row.
    expect(statement).toMatch(/:registration_finalize_mismatch'\)::int FROM claimed c WHERE \(SELECT count\(\*\) FROM account_insert\) <> 1 OR \(SELECT count\(\*\) FROM passkey_insert\) <> 1/);

    // The caller supplies ONLY the Safe, the config version, and which
    // attempt — every identity value written comes from the locked row.
    expect(queries[1]!.params).toEqual([SAFE, "1", CREDENTIAL_ID]);
  });

  it("post-statement guards: an active attempt needs its exact account + passkey; a non-active attempt may have neither", async () => {
    respond = () => batchResponse(1, { account: true, passkey: true });
    await finalize();
    const [activeGuard, inactiveGuard] = [sent[0]!.queries![2]!.query, sent[0]!.queries![3]!.query].map((q) => q.replace(/\s+/g, " "));
    expect(activeGuard).toMatch(/registration_finalize_mismatch'\)::int FROM registration_attempts a WHERE a\.credential_id = \$1 AND a\.state = 'active'/);
    for (const column of ["sub_organization_id", "turnkey_user_id", "wallet_id", "wallet_account_id", "owner_address", "safe_address", "account_config_version"]) {
      expect(activeGuard, column).toContain(`x.${column} = a.${column}`);
    }
    for (const column of ["credential_id", "app_user_id", "credential_public_key", "user_handle"]) {
      expect(activeGuard, column).toContain(`p.${column} = a.${column}`);
    }
    expect(inactiveGuard).toMatch(/a\.state <> 'active' AND \( EXISTS \(SELECT 1 FROM real_accounts x WHERE x\.app_user_id = a\.app_user_id\) OR EXISTS/);
  });

  it("lost CAS -> null, even when the transaction's reads return an existing account/passkey for this attempt (never reused by appUserId)", async () => {
    respond = () => batchResponse(0, { account: true, passkey: true });
    expect(await finalize()).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("won CAS -> exactly the rows this transaction wrote", async () => {
    respond = () => batchResponse(1, { account: true, passkey: true });
    const finalized = await finalize();
    expect(finalized?.account).toMatchObject({ appUserId: "app-user-1", subOrganizationId: "sub-org-1", safeAddress: SAFE, sessionEpoch: 0 });
    expect(finalized?.passkey).toMatchObject({ credentialId: CREDENTIAL_ID, status: "active", role: "primary" });
  });

  it("won CAS but a row is missing from the read-back -> throws; never a partial or substituted result", async () => {
    respond = () => batchResponse(1, { account: true, passkey: false });
    await expect(finalize()).rejects.toThrow(/without its account\/passkey rows/);
  });

  it("a 23505 unique violation is thrown, never turned into a re-read that returns some existing account/passkey pair", async () => {
    respond = (request) =>
      request.queries
        ? new Response(JSON.stringify({ message: 'duplicate key value violates unique constraint "real_passkeys_pkey"', code: "23505", constraint: "real_passkeys_pkey" }), { status: 400 })
        : singleQueryRows(request);

    await expect(finalize()).rejects.toMatchObject({ code: "23505" });
    expect(sent).toHaveLength(1); // no follow-up read
  });

  it("the finalize guard sentinel (22P02) -> null: the whole transaction rolled back", async () => {
    respond = (request) =>
      request.queries
        ? new Response(JSON.stringify({ message: 'invalid input syntax for type integer: "active:registration_finalize_mismatch"', code: "22P02" }), { status: 400 })
        : singleQueryRows(request);

    expect(await finalize()).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("any other 22P02 (not this guard's sentinel) is thrown", async () => {
    respond = () => new Response(JSON.stringify({ message: 'invalid input syntax for type integer: "x"', code: "22P02" }), { status: 400 });
    await expect(finalize()).rejects.toMatchObject({ code: "22P02" });
  });
});
