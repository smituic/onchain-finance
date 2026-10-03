// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNeonDurableStores } from "@/lib/real/server/neon-store";
import type { DispatchTerminalObservation } from "@/lib/real/server/registration-attempts";

/**
 * Provisioning Evidence Capture: the Neon adapter's dispatch-evidence SQL,
 * driven through the REAL @neondatabase/serverless driver with fetch
 * intercepted (nothing leaves the process). Proves the shape of what is
 * sent — the claim and the evidence INSERT are one statement in one batch,
 * the write-once WHERE guards, no statement that could rewrite request
 * evidence — and how each server answer is interpreted. That the SQL behaves
 * as intended against real Postgres (atomicity under a race, the CHECKs, the
 * unique and partial indexes) is for the DATABASE_URL-gated neon-smoke suite.
 */
const DATABASE_URL = "postgresql://user:pass@ep-dispatch-test-000000.us-east-2.aws.neon.tech/neondb";
const CREDENTIAL_ID = "Y3JlZGVudGlhbC1pZA";
const DISPATCH_ID = "3f2b1c9e-0a4d-4e6f-8b7a-1c2d3e4f5a6b";
const BODY = '{"type":"ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V8","timestampMs":"1790204988123","organizationId":"parent-org","parameters":{"note":"quote \\" backslash \\\\ and \'apostrophe\'"}}';
const SHA = createHash("sha256").update(BODY, "utf8").digest("hex");
const EVIDENCE = { evidenceVersion: 1, organizationId: "parent-org", stampPublicKey: "02abc", requestTimestampMs: 1790204988123, requestBody: BODY, requestBodySha256: SHA };

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

const attemptRow = {
  credential_id: CREDENTIAL_ID,
  app_user_id: "app-user-1",
  user_handle: "handle",
  credential_public_key: "cose",
  counter: 0,
  transports: null,
  credential_device_type: null,
  credential_backed_up: null,
  registration_challenge: "challenge",
  raw_client_data_json: "client-data",
  raw_attestation_object: "attestation",
  state: "provisioning_in_flight",
  external_outcome: "unknown",
  external_provisioning_attempted_at: "2026-09-24T00:00:00.000Z",
  sub_organization_id: null,
  turnkey_user_id: null,
  wallet_id: null,
  wallet_account_id: null,
  owner_address: null,
  safe_address: null,
  account_config_version: null,
  block_reason: null,
  created_at: "2026-09-24T00:00:00.000Z",
  updated_at: "2026-09-24T00:00:00.000Z",
  guard: null,
};

function dispatchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DISPATCH_ID,
    credential_id: CREDENTIAL_ID,
    dispatch_seq: 1,
    evidence_version: 1,
    organization_id: "parent-org",
    stamp_public_key: "02abc",
    request_timestamp_ms: "1790204988123",
    request_body: BODY,
    request_body_sha256: SHA,
    created_at: "2026-09-24T00:00:00.000Z",
    turnkey_activity_id: null,
    turnkey_activity_fingerprint: null,
    activity_recorded_at: null,
    terminal_status: null,
    terminal_observed_at: null,
    terminal_observed_by: null,
    turnkey_created_at: null,
    observed_sub_organization_id: null,
    observed_root_user_id: null,
    observed_wallet_id: null,
    observed_owner_address: null,
    failure_code: null,
    failure_message: null,
    intent_verdict: null,
    fingerprint_verdict: null,
    vote_verdict: null,
    last_observed_status: null,
    last_observed_at: null,
    updated_at: "2026-09-24T00:00:00.000Z",
    ...overrides,
  };
}

const store = () => createNeonDurableStores(DATABASE_URL).attempts;
const begin = () => store().beginProvisioningDispatch({ credentialId: CREDENTIAL_ID, attemptedAt: "2026-09-24T00:00:00.000Z", evidence: EVIDENCE });
const flat = (query: string) => query.replace(/\s+/g, " ").trim();

const IMMUTABLE_COLUMNS = ["id", "credential_id", "dispatch_seq", "evidence_version", "organization_id", "stamp_public_key", "request_timestamp_ms", "request_body", "request_body_sha256", "created_at"];

describe("Neon beginProvisioningDispatch: the claim and the evidence INSERT are ONE statement", () => {
  it("sends exactly ONE ReadCommitted batch — no read before it — of two statements: claim+insert, then the read-back", async () => {
    respond = () => Response.json({ results: [result([attemptRow]), result([dispatchRow()])] });
    await begin();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.single).toBeNull();
    expect(sent[0]!.isolation).toBe("ReadCommitted");
    expect(sent[0]!.queries).toHaveLength(2);
  });

  it("the CAS is the `claimed` CTE; the INSERT selects FROM claimed (never VALUES), so a lost CAS has nothing to insert", async () => {
    respond = () => Response.json({ results: [result([attemptRow]), result([dispatchRow()])] });
    await begin();
    const statement = flat(sent[0]!.queries![0]!.query);
    expect(statement).toMatch(/^WITH claimed AS \( UPDATE registration_attempts SET state = 'provisioning_in_flight', external_outcome = 'unknown', external_provisioning_attempted_at = \$1::timestamptz, updated_at = now\(\) WHERE credential_id = \$2 AND state = 'verified' RETURNING \* \)/);
    expect(statement).toMatch(/inserted AS \( INSERT INTO registration_provisioning_dispatches \(credential_id, dispatch_seq, evidence_version, organization_id, stamp_public_key, request_timestamp_ms, request_body, request_body_sha256\) SELECT c\.credential_id, .* FROM claimed c RETURNING id \)/);
    expect(statement).not.toMatch(/\bVALUES\b/i);
    expect(statement).not.toMatch(/ON CONFLICT/i); // a collision must abort the statement, never be skipped or overwrite a row
    // The next sequence number for THIS attempt, computed inside the same statement.
    expect(statement).toContain("(SELECT COALESCE(MAX(d.dispatch_seq), 0) + 1 FROM registration_provisioning_dispatches d WHERE d.credential_id = c.credential_id)");
    // A won CAS that did not insert exactly one row aborts the whole statement.
    expect(statement).toMatch(/:provisioning_dispatch_mismatch'\)::int WHERE \(SELECT count\(\*\) FROM inserted\) <> 1\) AS guard FROM claimed c$/);
    // Exactly one UPDATE (the claim) and one INSERT; the read-back writes nothing.
    expect(statement.match(/\bUPDATE\b/g)).toHaveLength(1);
    expect(statement.match(/\bINSERT\b/g)).toHaveLength(1);
    expect(flat(sent[0]!.queries![1]!.query)).toBe("SELECT * FROM registration_provisioning_dispatches WHERE credential_id = $1 AND request_body_sha256 = $2");
  });

  it("the exact body string is a bound parameter, byte for byte — never interpolated, trimmed, or re-serialized", async () => {
    respond = () => Response.json({ results: [result([attemptRow]), result([dispatchRow()])] });
    await begin();
    const { query, params } = sent[0]!.queries![0]!;
    expect(params).toEqual(["2026-09-24T00:00:00.000Z", CREDENTIAL_ID, "1", "parent-org", "02abc", "1790204988123", BODY, SHA]);
    expect(query).not.toContain(BODY);
    expect(query).not.toContain(SHA);
    expect(sent[0]!.queries![1]!.params).toEqual([CREDENTIAL_ID, SHA]);
  });

  it("won claim -> the claimed attempt and the PERSISTED dispatch row (body returned verbatim)", async () => {
    respond = () => Response.json({ results: [result([attemptRow]), result([dispatchRow()])] });
    const begun = await begin();
    expect(begun?.attempt).toMatchObject({ credentialId: CREDENTIAL_ID, state: "provisioning_in_flight", externalOutcome: "unknown" });
    expect(begun?.dispatch).toMatchObject({ id: DISPATCH_ID, dispatchSeq: 1, evidenceVersion: 1, requestTimestampMs: 1790204988123, requestBody: BODY, requestBodySha256: SHA, turnkeyActivityId: null, terminalStatus: null });
  });

  it("lost CAS -> null, even if the read-back returned a row (nothing was claimed, so nothing may be dispatched)", async () => {
    respond = () => Response.json({ results: [result([]), result([dispatchRow()])] });
    expect(await begin()).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("won claim but no evidence row in the read-back -> throws; never dispatches without the persisted row", async () => {
    respond = () => Response.json({ results: [result([attemptRow]), result([])] });
    await expect(begin()).rejects.toThrow(/without its evidence row/);
  });

  it.each([
    ["the body-digest unique constraint", { message: 'duplicate key value violates unique constraint "registration_provisioning_dispatches_body_sha256_key"', code: "23505" }],
    ["the one-open-dispatch index", { message: 'duplicate key value violates unique constraint "registration_provisioning_dispatches_one_open_idx"', code: "23505" }],
    ["the digest CHECK", { message: 'new row for relation "registration_provisioning_dispatches" violates check constraint "registration_provisioning_dispatches_body_digest_check"', code: "23514" }],
    ["the in-statement guard", { message: 'invalid input syntax for type integer: "provisioning_in_flight:provisioning_dispatch_mismatch"', code: "22P02" }],
    ["a missing table (migration not applied)", { message: 'relation "registration_provisioning_dispatches" does not exist', code: "42P01" }],
  ])("a database error from %s is THROWN (the batch rolled back: the attempt is still 'verified') — never null, never a retry, never a follow-up write", async (_label, body) => {
    respond = () => new Response(JSON.stringify(body), { status: 400 });
    await expect(begin()).rejects.toThrow();
    expect(sent).toHaveLength(1);
  });
});

describe("Neon write-once dispatch updates", () => {
  const completed: DispatchTerminalObservation = {
    status: "ACTIVITY_STATUS_COMPLETED",
    observedBy: "dispatch",
    turnkeyCreatedAt: "2026-09-24T00:00:00.000Z",
    observedSubOrganizationId: "sub-org-1",
    observedRootUserId: "turnkey-user-1",
    observedWalletId: "wallet-1",
    observedOwnerAddress: "0xF6C3FE6DE636f0d8f421d5485D1a64fF3628CFaF",
    failureCode: null,
    failureMessage: null,
    intentVerdict: "exact",
    fingerprintVerdict: "match",
    voteVerdict: "parent_key",
  };

  it("recordDispatchActivity: one UPDATE guarded by `turnkey_activity_id IS NULL`", async () => {
    respond = () => Response.json(result([dispatchRow({ turnkey_activity_id: "activity-1", turnkey_activity_fingerprint: "sha256:abc", activity_recorded_at: "2026-09-24T00:00:01.000Z" })]));
    const recorded = await store().recordDispatchActivity({ dispatchId: DISPATCH_ID, activityId: "activity-1", fingerprint: "sha256:abc" });
    expect(recorded).toMatchObject({ outcome: "recorded", dispatch: { turnkeyActivityId: "activity-1", turnkeyActivityFingerprint: "sha256:abc" } });
    expect(sent).toHaveLength(1);
    expect(flat(sent[0]!.single!.query)).toBe(
      "UPDATE registration_provisioning_dispatches SET turnkey_activity_id = $1, turnkey_activity_fingerprint = $2, activity_recorded_at = now(), updated_at = now() WHERE id = $3::uuid AND turnkey_activity_id IS NULL RETURNING *",
    );
    expect(sent[0]!.single!.params).toEqual(["activity-1", "sha256:abc", DISPATCH_ID]);
  });

  it("recordDispatchActivity: the guard matched nothing -> a READ decides (same id: already_recorded; another id: mismatch; no row: not_found) — never a second write", async () => {
    const answer = async (existing: Array<Record<string, unknown>>) => {
      sent = [];
      respond = (request) => Response.json(result(/^\s*UPDATE/.test(request.single!.query) ? [] : existing));
      const outcome = await store().recordDispatchActivity({ dispatchId: DISPATCH_ID, activityId: "activity-1", fingerprint: null });
      expect(sent.map((s) => flat(s.single!.query).split(" ")[0])).toEqual(["UPDATE", "SELECT"]);
      return outcome;
    };
    expect((await answer([dispatchRow({ turnkey_activity_id: "activity-1", activity_recorded_at: "2026-09-24T00:00:01.000Z" })])).outcome).toBe("already_recorded");
    const mismatch = await answer([dispatchRow({ turnkey_activity_id: "activity-OTHER", activity_recorded_at: "2026-09-24T00:00:01.000Z" })]);
    expect(mismatch).toMatchObject({ outcome: "mismatch", dispatch: { turnkeyActivityId: "activity-OTHER" } });
    expect(await answer([])).toEqual({ outcome: "not_found" });
  });

  it("recordDispatchTerminal: one UPDATE guarded by the recorded activity id AND `terminal_status IS NULL`", async () => {
    respond = () => Response.json(result([dispatchRow({ turnkey_activity_id: "activity-1", activity_recorded_at: "2026-09-24T00:00:01.000Z", terminal_status: "ACTIVITY_STATUS_COMPLETED", terminal_observed_at: "2026-09-24T00:00:02.000Z", terminal_observed_by: "dispatch", intent_verdict: "exact", fingerprint_verdict: "match", vote_verdict: "parent_key" })]));
    const recorded = await store().recordDispatchTerminal({ dispatchId: DISPATCH_ID, activityId: "activity-1", observation: completed });
    expect(recorded).toMatchObject({ outcome: "recorded", dispatch: { terminalStatus: "ACTIVITY_STATUS_COMPLETED", terminalObservedBy: "dispatch" } });
    const statement = flat(sent[0]!.single!.query);
    expect(statement).toMatch(/^UPDATE registration_provisioning_dispatches SET terminal_status = \$1, terminal_observed_at = now\(\), terminal_observed_by = \$2,/);
    expect(statement).toMatch(/WHERE id = \$\d+::uuid AND turnkey_activity_id = \$\d+ AND terminal_status IS NULL RETURNING \*$/);
    expect(sent[0]!.single!.params).toEqual(["ACTIVITY_STATUS_COMPLETED", "dispatch", "2026-09-24T00:00:00.000Z", "sub-org-1", "turnkey-user-1", "wallet-1", "0xF6C3FE6DE636f0d8f421d5485D1a64fF3628CFaF", null, null, "exact", "match", "parent_key", "ACTIVITY_STATUS_COMPLETED", DISPATCH_ID, "activity-1"]);
  });

  it("recordDispatchTerminal: the guard matched nothing -> a READ decides (already_terminal / activity_mismatch / not_found); the stored observation is returned untouched", async () => {
    const answer = async (existing: Array<Record<string, unknown>>) => {
      sent = [];
      respond = (request) => Response.json(result(/^\s*UPDATE/.test(request.single!.query) ? [] : existing));
      return store().recordDispatchTerminal({ dispatchId: DISPATCH_ID, activityId: "activity-1", observation: completed });
    };
    const terminal = { terminal_status: "ACTIVITY_STATUS_FAILED", terminal_observed_at: "2026-09-24T00:00:02.000Z", terminal_observed_by: "operator_poll", intent_verdict: "exact", fingerprint_verdict: "match", vote_verdict: "parent_key" };
    expect(await answer([dispatchRow({ turnkey_activity_id: "activity-1", activity_recorded_at: "2026-09-24T00:00:01.000Z", ...terminal })])).toMatchObject({ outcome: "already_terminal", dispatch: { terminalStatus: "ACTIVITY_STATUS_FAILED", terminalObservedBy: "operator_poll" } });
    expect((await answer([dispatchRow({ turnkey_activity_id: "activity-OTHER", activity_recorded_at: "2026-09-24T00:00:01.000Z" })])).outcome).toBe("activity_mismatch");
    expect((await answer([dispatchRow()])).outcome).toBe("activity_mismatch"); // no activity id recorded at all
    expect(await answer([])).toEqual({ outcome: "not_found" });
    expect(sent).toHaveLength(2);
  });

  it("recordDispatchObservation: touches only last_observed_* / updated_at, for an OPEN dispatch's recorded activity id", async () => {
    respond = () => Response.json(result([{ id: DISPATCH_ID }]));
    expect(await store().recordDispatchObservation({ dispatchId: DISPATCH_ID, activityId: "activity-1", status: "ACTIVITY_STATUS_PENDING" })).toBe(true);
    expect(flat(sent[0]!.single!.query)).toBe(
      "UPDATE registration_provisioning_dispatches SET last_observed_status = $1, last_observed_at = now(), updated_at = now() WHERE id = $2::uuid AND turnkey_activity_id = $3 AND terminal_status IS NULL RETURNING id",
    );
    respond = () => Response.json(result([]));
    expect(await store().recordDispatchObservation({ dispatchId: DISPATCH_ID, activityId: "activity-1", status: "ACTIVITY_STATUS_PENDING" })).toBe(false);
  });

  it("findDispatchesByCredentialId: oldest first, every column mapped", async () => {
    respond = () => Response.json(result([dispatchRow(), dispatchRow({ id: "4a2b1c9e-0a4d-4e6f-8b7a-1c2d3e4f5a6b", dispatch_seq: 2, failure_code: 3, turnkey_created_at: "2026-09-24T00:00:00.000Z" })]));
    const rows = await store().findDispatchesByCredentialId(CREDENTIAL_ID);
    expect(flat(sent[0]!.single!.query)).toBe("SELECT * FROM registration_provisioning_dispatches WHERE credential_id = $1 ORDER BY dispatch_seq ASC");
    expect(rows.map((row) => row.dispatchSeq)).toEqual([1, 2]);
    expect(rows[1]).toMatchObject({ failureCode: 3, turnkeyCreatedAt: "2026-09-24T00:00:00.000Z", requestBody: BODY });
  });
});

describe("the request evidence has no UPDATE path (source)", () => {
  const source = readFileSync("lib/real/server/neon-store.ts", "utf8");
  const sqlOnly = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  const updates = [...sqlOnly.matchAll(/UPDATE\s+registration_provisioning_dispatches\b([\s\S]*?)\bWHERE\b/g)].map((match) => match[1]!);

  it("there are exactly three UPDATE statements on the dispatch table, and none names an immutable column in its SET clause", () => {
    expect(updates).toHaveLength(3);
    for (const setClause of updates) {
      const assigned = [...setClause.matchAll(/(?:\bSET\b|,)\s*([a-z_]+)\s*=/g)].map((match) => match[1]!);
      expect(assigned.length).toBeGreaterThan(0);
      for (const column of IMMUTABLE_COLUMNS) expect(assigned, `SET clause: ${setClause.slice(0, 80)}`).not.toContain(column);
    }
  });

  it("every UPDATE that writes the activity identity or the terminal group carries its write-once guard", () => {
    const statements = [...sqlOnly.matchAll(/UPDATE\s+registration_provisioning_dispatches\b[\s\S]*?RETURNING/g)].map((match) => match[0].replace(/\s+/g, " "));
    expect(statements).toHaveLength(3);
    for (const statement of statements) {
      if (/SET turnkey_activity_id =/.test(statement)) expect(statement).toMatch(/AND turnkey_activity_id IS NULL RETURNING$/);
      if (/SET terminal_status =/.test(statement)) expect(statement).toMatch(/AND terminal_status IS NULL RETURNING$/);
      // Outside its own guarded statement, the activity identity is only ever compared (WHERE), never assigned (SET).
      const setClause = statement.slice(statement.indexOf(" SET "), statement.indexOf(" WHERE "));
      if (!/SET turnkey_activity_id =/.test(statement)) expect(setClause).not.toMatch(/turnkey_activity_(id|fingerprint)|activity_recorded_at/);
    }
  });

  it("nothing in the server code deletes a dispatch row, and no dispatch write goes through the generic transition patch", () => {
    for (const file of ["neon-store.ts", "registration-attempts.ts", "onboarding.ts", "provisioning-dispatch.ts", "provisioning-activity-poller.ts", "provisioning-evidence.ts", "turnkey-provisioning.ts"]) {
      const text = readFileSync(`lib/real/server/${file}`, "utf8");
      expect(text, file).not.toMatch(/DELETE\s+FROM\s+registration_provisioning_dispatches/i);
      expect(text, file).not.toMatch(/TRUNCATE\s+(TABLE\s+)?registration_provisioning_dispatches/i);
    }
    const patchType = /export type RegistrationAttemptPatch = Partial<\s*Pick<\s*RegistrationAttempt,([\s\S]*?)>\s*>;/.exec(readFileSync("lib/real/server/registration-attempts.ts", "utf8"))?.[1] ?? "";
    expect(patchType).toContain('"externalOutcome"');
    expect(patchType).not.toMatch(/request|dispatch|activity|fingerprint|terminal|observed/i);
  });
});

describe("L1: Neon — 'provisioning_in_flight' is claim-only; its two exits are single evidence-bound CASes", () => {
  it("the generic transition() refuses to enter or leave provisioning_in_flight BEFORE any SQL is sent", async () => {
    respond = () => Response.json(result([attemptRow]));
    await expect(store().transition({ credentialId: CREDENTIAL_ID, from: "verified", to: "provisioning_in_flight" })).rejects.toThrow(/only through beginProvisioningDispatch/);
    await expect(store().transition({ credentialId: CREDENTIAL_ID, from: "provisioning_in_flight", to: "verified" })).rejects.toThrow(/only through beginProvisioningDispatch/);
    await expect(store().transition({ credentialId: CREDENTIAL_ID, from: "provisioning_in_flight", to: "turnkey_created" })).rejects.toThrow(/only through beginProvisioningDispatch/);
    expect(sent).toHaveLength(0);
  });

  it("revertProvisioningAfterDefinitiveFailure: ONE UPDATE, requiring the newest dispatch's in-process FAILED/REJECTED evidence for this exact activity", async () => {
    respond = () => Response.json(result([{ ...attemptRow, state: "verified", external_outcome: "definitive_failure" }]));
    const reverted = await store().revertProvisioningAfterDefinitiveFailure({ credentialId: CREDENTIAL_ID, dispatchId: DISPATCH_ID, activityId: "activity-1" });
    expect(reverted).toMatchObject({ state: "verified", externalOutcome: "definitive_failure" });
    expect(sent).toHaveLength(1);
    const statement = flat(sent[0]!.single!.query);
    expect(statement).toMatch(/^UPDATE registration_attempts a SET state = 'verified', external_outcome = 'definitive_failure', updated_at = now\(\) WHERE a\.credential_id = \$1 AND a\.state = 'provisioning_in_flight' AND EXISTS \(/);
    for (const clause of [
      "d.id = $2::uuid AND d.credential_id = a.credential_id",
      "d.dispatch_seq = (SELECT max(x.dispatch_seq) FROM registration_provisioning_dispatches x WHERE x.credential_id = a.credential_id)",
      "d.turnkey_activity_id = $3",
      "d.terminal_status IN ('ACTIVITY_STATUS_FAILED', 'ACTIVITY_STATUS_REJECTED')",
      "d.terminal_observed_by = 'dispatch'",
      "d.fingerprint_verdict IN ('match', 'unrecognized_form')",
      "(d.intent_verdict = 'exact' OR (d.intent_verdict = 'fields_only' AND d.fingerprint_verdict = 'match'))",
    ]) {
      expect(statement).toContain(clause);
    }
    expect(sent[0]!.single!.params).toEqual([CREDENTIAL_ID, DISPATCH_ID, "activity-1"]);
    respond = () => Response.json(result([]));
    expect(await store().revertProvisioningAfterDefinitiveFailure({ credentialId: CREDENTIAL_ID, dispatchId: DISPATCH_ID, activityId: "activity-1" })).toBeNull();
  });

  it("advanceProvisioningToTurnkeyCreated: ONE UPDATE, requiring an exact-intent in-process COMPLETED whose observed ids EQUAL the identity written", async () => {
    const identity = { subOrganizationId: "sub-org-1", turnkeyUserId: "turnkey-user-1", walletId: "wallet-1", walletAccountId: "wallet-account-1", ownerAddress: "0xF6C3FE6DE636f0d8f421d5485D1a64fF3628CFaF" };
    respond = () => Response.json(result([{ ...attemptRow, state: "turnkey_created", external_outcome: "confirmed_created", sub_organization_id: "sub-org-1", turnkey_user_id: "turnkey-user-1", wallet_id: "wallet-1", wallet_account_id: "wallet-account-1", owner_address: identity.ownerAddress }]));
    const advanced = await store().advanceProvisioningToTurnkeyCreated({ credentialId: CREDENTIAL_ID, dispatchId: DISPATCH_ID, activityId: "activity-1", identity });
    expect(advanced).toMatchObject({ state: "turnkey_created", ...identity });
    expect(sent).toHaveLength(1);
    const statement = flat(sent[0]!.single!.query);
    expect(statement).toMatch(/^UPDATE registration_attempts a SET state = 'turnkey_created', external_outcome = 'confirmed_created', sub_organization_id = \$1, turnkey_user_id = \$2, wallet_id = \$3, wallet_account_id = \$4, owner_address = \$5, updated_at = now\(\) WHERE a\.credential_id = \$6 AND a\.state = 'provisioning_in_flight'/);
    expect(statement).toContain("AND a.sub_organization_id IS NULL AND a.turnkey_user_id IS NULL AND a.wallet_id IS NULL AND a.wallet_account_id IS NULL AND a.owner_address IS NULL");
    for (const clause of [
      "d.dispatch_seq = (SELECT max(x.dispatch_seq) FROM registration_provisioning_dispatches x WHERE x.credential_id = a.credential_id)",
      "d.terminal_status = 'ACTIVITY_STATUS_COMPLETED'",
      "d.terminal_observed_by = 'dispatch'",
      "d.intent_verdict = 'exact'",
      "d.fingerprint_verdict IN ('match', 'unrecognized_form')",
      "d.observed_sub_organization_id = $9",
      "d.observed_root_user_id = $10",
      "d.observed_wallet_id = $11",
      "d.observed_owner_address = $12",
    ]) {
      expect(statement).toContain(clause);
    }
    // The values compared against the evidence are the SAME values written — never read from the row.
    expect(sent[0]!.single!.params).toEqual(["sub-org-1", "turnkey-user-1", "wallet-1", "wallet-account-1", identity.ownerAddress, CREDENTIAL_ID, DISPATCH_ID, "activity-1", "sub-org-1", "turnkey-user-1", "wallet-1", identity.ownerAddress]);
    expect(statement).not.toMatch(/SET[^W]*observed_/);
    respond = () => Response.json(result([]));
    expect(await store().advanceProvisioningToTurnkeyCreated({ credentialId: CREDENTIAL_ID, dispatchId: DISPATCH_ID, activityId: "activity-1", identity })).toBeNull();
  });
});
