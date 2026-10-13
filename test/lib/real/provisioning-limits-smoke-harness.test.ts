// @vitest-environment node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseDatabaseUrl } from "./fixtures/handles-smoke-db";
import { createFakeLedgerDb } from "./fixtures/provisioning-limits-fake-db";
import {
  MAX_BACKDATE_SECONDS,
  MAX_RUN_ATTEMPTS,
  MAX_RUN_BACKDATES,
  PROVISIONING_LIMITS_SMOKE_FILE,
  assertPlainIdentifier,
  beginCleanupProgress,
  caseFailedInVitest,
  checkExactFileSelection,
  classifyClaimResult,
  concludeRun,
  createRunFixtures,
  createRunLifecycle,
  lockHolderStatements,
  openGate,
  removeOwnedFixtures,
  requirePooledMode,
  safeEvidenceJson,
  summarizeCleanup,
  tally,
  writeEvidenceFile,
  type FinalReport,
} from "./fixtures/provisioning-limits-smoke";

/**
 * OFFLINE proof of the provisioning dispatch-ceiling smoke's SAFETY GUARDS
 * (provisioning-limits.smoke.test.ts): what it refuses, what it may touch,
 * and how it reads a claim's outcome. Synthetic values only; the child
 * processes below use `.invalid` hosts and are refused before any connector
 * is built.
 *
 * Nothing here simulates a database, and nothing here is evidence of how
 * PostgreSQL or Neon behaves under concurrency. That evidence can only come
 * from running the smoke itself against a disposable branch.
 */
const FILE = PROVISIONING_LIMITS_SMOKE_FILE;
const GATE = "REAL_SMOKE_PROVISIONING_LIMITS";
const RUN = "0a1b2c3d";
const OTHER_RUN = "0a1b2c3e";
const UUID_A = "3f2b1c9e-0a4d-4e6f-8b7a-1c2d3e4f5a6b";
const UUID_B = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const LOCK_KEY = "5711486127619329878";

describe("exact-file selection", () => {
  it.each([
    ["the documented command", ["run", FILE, "--testTimeout=120000", "--hookTimeout=120000"]],
    ["without the timeout flags", ["run", FILE]],
    ["with a ./ prefix", ["run", `./${FILE}`]],
    ["flags before the file", ["run", "--hookTimeout=30000", FILE]],
  ])("accepts %s", (_name, args) => {
    expect(checkExactFileSelection(args)).toEqual({ ok: true });
  });

  it.each<[string, unknown, RegExp]>([
    ["no argument list at all (the config did not provide one)", undefined, /not available/],
    ["a non-array", "run", /not available/],
    ["a non-string argument", ["run", FILE, 5], /not available/],
    ["the whole suite (no file)", ["run"], /ONE test file/],
    ["a bare `vitest` (watch mode)", [], /vitest run/],
    ["watch mode with the file", [FILE], /vitest run/],
    ["another command", ["watch", FILE], /vitest run/],
    ["a second file", ["run", FILE, "test/lib/real/neon-smoke.test.ts"], /ONE test file/],
    ["the same file twice", ["run", FILE, FILE], /ONE test file/],
    ["a different file", ["run", "test/lib/real/neon-smoke.test.ts"], /ONE test file/],
    ["a directory that contains it", ["run", "test/lib/real"], /ONE test file/],
    ["a partial name", ["run", "provisioning-limits"], /ONE test file/],
    ["an absolute path", ["run", `/somewhere/${FILE}`], /ONE test file/],
    ["a name filter (-t)", ["run", FILE, "-t", "A."], /ONE test file/],
    ["a name filter in one argument", ["run", FILE, "-t=A."], /only --testTimeout/],
    ["--testNamePattern", ["run", FILE, "--testNamePattern=budget"], /only --testTimeout/],
    ["--bail", ["run", FILE, "--bail=1"], /only --testTimeout/],
    ["--retry", ["run", FILE, "--retry=2"], /only --testTimeout/],
    ["--passWithNoTests", ["run", FILE, "--passWithNoTests"], /only --testTimeout/],
    ["--config", ["run", FILE, "--config=other.config.mts"], /only --testTimeout/],
    ["a timeout given as two arguments", ["run", FILE, "--testTimeout", "30000"], /ONE test file/],
    ["a non-numeric timeout", ["run", FILE, "--testTimeout=forever"], /only --testTimeout/],
  ])("refuses %s", (_name, args, reason) => {
    const result = checkExactFileSelection(args);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  });

  it("the argument list comes from the main process's command line, never from the environment", () => {
    const config = readFileSync("vitest.config.mts", "utf8");
    expect(config).toContain("provide: { vitestCliArgs: process.argv.slice(2) },");
    expect(config).not.toMatch(/process\.env/);
  });
});

describe("fixture ownership: only ids this run registered, and of this run's shape", () => {
  it("mints run-owned ids, and refuses a bad run id, a bad suffix, or a repeat", () => {
    const fixtures = createRunFixtures(RUN);
    expect(fixtures.newCredentialId("a-prior-0")).toBe(`smoke-${RUN}-pl-a-prior-0`);
    expect(fixtures.appUserIdFor(`smoke-${RUN}-pl-a-prior-0`)).toBe(`smoke-${RUN}-pl-a-prior-0-user`);
    expect(() => fixtures.newCredentialId("a-prior-0")).toThrow(/used twice/);
    for (const suffix of ["", "A", "a b", "a_b", "a--b", "-a", "a-", "a'b", "a%", "a;b", "../x"]) expect(() => fixtures.newCredentialId(suffix), suffix).toThrow(/suffix/);
    for (const runId of ["", "0a1b2c3", "0a1b2c3d4", "0A1B2C3D", "0a1b2c3g", "%%%%%%%%"]) expect(() => createRunFixtures(runId), runId).toThrow(/8 lowercase hex/);
  });

  it.each([
    ["a production-like credential id", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEf"],
    ["an application account id", "3f58e923-d3d8-4607-8e53-722f32ae6659"],
    ["an id of this run's shape that this run never registered", `smoke-${RUN}-pl-never-made`],
    ["another run's id", `smoke-${OTHER_RUN}-pl-a-prior-0`],
    ["the adapter smoke's id for the same run", `smoke-${RUN}-pd-claim`],
    ["a LIKE pattern", `smoke-${RUN}-pl-%`],
    ["a bare prefix", `smoke-${RUN}-pl-`],
    ["an empty id", ""],
  ])("refuses to touch %s — and never echoes it", (_name, id) => {
    const fixtures = createRunFixtures(RUN);
    const owned = fixtures.newCredentialId("a-prior-0");
    fixtures.registerDispatch(UUID_A, owned);
    for (const act of [
      () => fixtures.assertOwnedCredential(id),
      () => fixtures.appUserIdFor(id),
      () => fixtures.evidenceFor(id, "x"),
      () => fixtures.registerDispatch(UUID_B, id),
      () => fixtures.assertOwnedDispatch(UUID_A, id),
      () => fixtures.backdateStatement(UUID_A, id, 60),
      () => lockHolderStatements(fixtures, { lockKey: LOCK_KEY, holdSeconds: 5, insert: { credentialId: id, label: "holder" } }),
      () => lockHolderStatements(fixtures, { lockKey: LOCK_KEY, holdSeconds: 5, expire: { dispatchId: UUID_A, credentialId: id, window: "1 hour", expiresInSeconds: 3 } }),
    ]) {
      let message = "";
      try {
        act();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/does not own/);
      if (id.length > 4) expect(message).not.toContain(id);
    }
  });

  it("a registry with a forged entry of another run's shape still refuses it (membership AND shape)", () => {
    // The registry can only add ids it mints, so the shape check is defense in depth; prove it is really applied.
    const source = readFileSync("test/lib/real/fixtures/provisioning-limits-smoke.ts", "utf8");
    expect(source).toContain("if (!credentialIds.has(credentialId) || !isRunSmokeId(runId, credentialId)) throw new Error");
    expect(source.match(/credentialIds\.add\(/g)).toHaveLength(1); // newCredentialId is the only way in
    expect(source.match(/dispatchOwners\.set\(/g)).toHaveLength(1); // registerDispatch is the only way in
  });

  it("a dispatch row is owned only as registered: unknown ids, the wrong owner, a changed owner, and malformed ids are refused", () => {
    const fixtures = createRunFixtures(RUN);
    const a = fixtures.newCredentialId("a");
    const b = fixtures.newCredentialId("b");
    fixtures.registerDispatch(UUID_A, a);
    fixtures.registerDispatch(UUID_A, a); // idempotent for the same owner
    expect(() => fixtures.assertOwnedDispatch(UUID_A, a)).not.toThrow();
    expect(() => fixtures.assertOwnedDispatch(UUID_A, b)).toThrow(/does not own/);
    expect(() => fixtures.assertOwnedDispatch(UUID_B, a)).toThrow(/does not own/);
    expect(() => fixtures.registerDispatch(UUID_A, b)).toThrow(/cannot change owner/);
    for (const id of ["", "not-a-uuid", UUID_B.toUpperCase(), `${UUID_B}'`, `${UUID_B} OR true`]) expect(() => fixtures.registerDispatch(id, a), id).toThrow(/lowercase UUID/);
    expect(fixtures.ownedDispatchIds()).toEqual([UUID_A]);
  });
});

describe("test-only re-dating is exact and bounded", () => {
  it("one row, by exact id AND exact owner, both as bound parameters", () => {
    const fixtures = createRunFixtures(RUN);
    const owned = fixtures.newCredentialId("e-history-0");
    fixtures.registerDispatch(UUID_A, owned);
    expect(fixtures.backdateStatement(UUID_A, owned, 7200)).toEqual({
      text: "UPDATE registration_provisioning_dispatches SET created_at = created_at - pg_catalog.make_interval(secs => $3::int) WHERE id = $1::uuid AND credential_id = $2 RETURNING id",
      params: [UUID_A, owned, 7200],
    });
  });

  it("it changes created_at and nothing else, on that one table, and is never unconditional or pattern-based", () => {
    const fixtures = createRunFixtures(RUN);
    const owned = fixtures.newCredentialId("x");
    fixtures.registerDispatch(UUID_A, owned);
    const { text } = fixtures.backdateStatement(UUID_A, owned, 60);
    expect(text.match(/\bSET\b ([\s\S]*?) \bWHERE\b/)?.[1]).toBe("created_at = created_at - pg_catalog.make_interval(secs => $3::int)");
    expect(text).not.toMatch(/LIKE|terminal_status|\bstate\b|now\(\)| OR | AND .* AND /i);
    expect(text).not.toContain(owned);
    expect(text).not.toContain(UUID_A);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_BACKDATE_SECONDS + 1, 10 ** 9])("refuses a backdate of %s seconds", (seconds) => {
    const fixtures = createRunFixtures(RUN);
    const owned = fixtures.newCredentialId("x");
    fixtures.registerDispatch(UUID_A, owned);
    expect(() => fixtures.backdateStatement(UUID_A, owned, seconds)).toThrow(/within the bound/);
  });

  it("a run can re-date at most MAX_RUN_BACKDATES rows and create at most MAX_RUN_ATTEMPTS attempts — both CUMULATIVE over the whole run", () => {
    expect(MAX_RUN_BACKDATES).toBe(60);
    expect(MAX_RUN_ATTEMPTS).toBe(100);
    expect(MAX_BACKDATE_SECONDS).toBe(26 * 60 * 60);
    const fixtures = createRunFixtures(RUN);
    const owned = fixtures.newCredentialId("x");
    fixtures.registerDispatch(UUID_A, owned);
    for (let i = 0; i < MAX_RUN_BACKDATES; i += 1) fixtures.backdateStatement(UUID_A, owned, 60);
    expect(() => fixtures.backdateStatement(UUID_A, owned, 60)).toThrow(/backdate limit/);
    // The backdate budget is for the whole run: forgetting removed fixtures does not refill it.
    fixtures.forget([owned]);
    const again = fixtures.newCredentialId("y");
    fixtures.registerDispatch(UUID_B, again);
    expect(() => fixtures.backdateStatement(UUID_B, again, 60)).toThrow(/backdate limit/);

    // The attempt bound is for the whole run too: removing a finished case's fixtures does not refill it,
    // and an id that was removed can never be minted (and so owned) a second time.
    const many = createRunFixtures(RUN);
    for (let i = 0; i < MAX_RUN_ATTEMPTS; i += 1) {
      many.newCredentialId(`n-${i}`);
      if (i % 10 === 9) many.forget(many.ownedCredentialIds()); // as after each case's confirmed cleanup
    }
    expect(many.mintedCount()).toBe(MAX_RUN_ATTEMPTS);
    expect(many.ownedCredentialIds()).toEqual([]);
    expect(() => many.newCredentialId("one-more")).toThrow(/fixture limit/);
    const reuse = createRunFixtures(RUN);
    reuse.forget([reuse.newCredentialId("a")]);
    expect(() => reuse.newCredentialId("a")).toThrow(/used twice/);
    // The ten prepared cases need 89 attempts and 40 re-datings in all — inside both bounds.
    expect(89).toBeLessThanOrEqual(MAX_RUN_ATTEMPTS);
    expect(40).toBeLessThanOrEqual(MAX_RUN_BACKDATES);
  });
});

describe("cleanup is exact and bounded", () => {
  it("two statements per owned credential — its dispatch rows, then its attempt — each by ONE exact id as a bound parameter", () => {
    const fixtures = createRunFixtures(RUN);
    const ids = ["a", "b", "c"].map((suffix) => fixtures.newCredentialId(suffix));
    const statements = fixtures.cleanupStatements();
    expect(statements).toEqual(
      ids.flatMap((id) => [
        { credentialId: id, target: "dispatchRows", text: "DELETE FROM registration_provisioning_dispatches WHERE credential_id = $1 RETURNING id", params: [id] },
        { credentialId: id, target: "attemptRow", text: "DELETE FROM registration_attempts WHERE credential_id = $1 RETURNING credential_id", params: [id] },
      ]),
    );
    for (const { text } of statements) expect(text).not.toMatch(/LIKE|created_at|terminal_status|state\b|smoke| OR |<|>/i);
  });

  it("F-3. forget() removes EXACTLY the ids it is given — another case's registrations, and their dispatch rows, stay", () => {
    const fixtures = createRunFixtures(RUN);
    expect(fixtures.cleanupStatements()).toEqual([]);
    const a = fixtures.newCredentialId("a");
    const b = fixtures.newCredentialId("b");
    fixtures.registerDispatch(UUID_A, a);
    fixtures.registerDispatch(UUID_B, b);
    fixtures.forget([a]);
    expect(fixtures.ownedCredentialIds()).toEqual([b]);
    expect(fixtures.ownedDispatchIds()).toEqual([UUID_B]);
    expect(() => fixtures.backdateStatement(UUID_A, a, 60)).toThrow(/does not own/); // a forgotten id is no longer owned
    expect(() => fixtures.backdateStatement(UUID_B, b, 60)).not.toThrow(); // the other one is untouched
    expect(fixtures.cleanupStatements().map((statement) => statement.credentialId)).toEqual([b, b]);
    // It cannot be asked to forget something the run does not own, and there is no "forget everything".
    expect(() => fixtures.forget([`smoke-${OTHER_RUN}-pl-a`])).toThrow(/does not own/);
    expect(() => fixtures.forget([a])).toThrow(/does not own/);
    fixtures.forget([]);
    expect(fixtures.ownedCredentialIds()).toEqual([b]);
    const source = readFileSync("test/lib/real/fixtures/provisioning-limits-smoke.ts", "utf8");
    expect(source).not.toMatch(/forgetRemoved|credentialIds\.clear\(|dispatchOwners\.clear\(/);
  });

  it("the fixture module's ONLY row-changing statements are the backdate, the two cleanup deletes, and the lock-holder's two", () => {
    const source = readFileSync("test/lib/real/fixtures/provisioning-limits-smoke.ts", "utf8");
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");
    expect(code.match(/"DELETE FROM [a-z_]+/g)).toEqual(['"DELETE FROM registration_provisioning_dispatches', '"DELETE FROM registration_attempts']);
    expect(code.match(/`?"?UPDATE [a-z_]+/g)).toEqual(['"UPDATE registration_provisioning_dispatches', "`UPDATE registration_provisioning_dispatches"]);
    expect(code.match(/INSERT INTO [a-z_]+/g)).toEqual(["INSERT INTO registration_provisioning_dispatches"]);
    expect(code).not.toMatch(/TRUNCATE|DROP |ALTER |CREATE |GRANT |pg_advisory_lock|pg_try_advisory|pg_advisory_unlock/);
    // Pure: no database, network, environment, or provider reach.
    // (The one line that NAMES forbidden evidence content is a deny-list, not a reach to anything.)
    const reach = code.split("\n").filter((line) => !line.startsWith("const UNSAFE_EVIDENCE = ")).join("\n");
    expect(code.split("\n").filter((line) => line.startsWith("const UNSAFE_EVIDENCE = "))).toHaveLength(1);
    expect(reach).not.toMatch(/process\.env|fetch\(|neon|turnkey|pimlico|@\/lib/i);
    // Its only file access is the evidence writer: one exclusive, owner-only create.
    expect(code.match(/writeFileSync\([^\n]*/g)).toEqual(['writeFileSync(file, json, { flag: "wx", mode: 0o600 });']);
    expect(code.match(/mkdirSync\([^\n]*/g)).toEqual(["mkdirSync(input.directory, { recursive: true, mode: 0o700 });"]);
    expect(code).not.toMatch(/readFileSync|unlinkSync|rmSync|renameSync|appendFileSync|createWriteStream/);
  });
});

describe("the lock-holder batch", () => {
  const setup = () => {
    const fixtures = createRunFixtures(RUN);
    const holder = fixtures.newCredentialId("f-holder");
    const boundary = fixtures.newCredentialId("ih-prior-0");
    fixtures.registerDispatch(UUID_A, boundary);
    return { fixtures, holder, boundary };
  };

  it("holder with an insert: the transaction-scoped lock FIRST, one fixture row for an owned attempt, the hold, then a last clock reading", () => {
    const { fixtures, holder } = setup();
    const statements = lockHolderStatements(fixtures, { lockKey: LOCK_KEY, holdSeconds: 5, insert: { credentialId: holder, label: "holder" } });
    expect(statements).toHaveLength(4);
    expect(statements[0]).toBe(`SELECT pg_catalog.pg_advisory_xact_lock(${LOCK_KEY}::bigint)`);
    const body = `{"smoke":"${holder}","label":"holder"}`;
    expect(statements[1]).toBe(
      `INSERT INTO registration_provisioning_dispatches (credential_id, dispatch_seq, evidence_version, organization_id, stamp_public_key, request_timestamp_ms, request_body, request_body_sha256, created_at, updated_at) SELECT '${holder}', 1, 1, 'smoke-parent-org', 'smoke-02abc', 1790204988123, '${body}', '${createHash("sha256").update(body, "utf8").digest("hex")}', t.at, t.at FROM (SELECT pg_catalog.clock_timestamp() AS at) t RETURNING id, created_at`,
    );
    expect(statements[2]).toBe("SELECT pg_catalog.pg_sleep(5)");
    expect(statements[3]).toBe("SELECT pg_catalog.clock_timestamp() AS released_after");
  });

  it("holder with an expiry: re-dates ONE owned row, by exact id and owner, to leave its window while the lock is held", () => {
    const { fixtures, boundary } = setup();
    for (const window of ["1 hour", "24 hours"] as const) {
      const statements = lockHolderStatements(fixtures, { lockKey: LOCK_KEY, holdSeconds: 7, expire: { dispatchId: UUID_A, credentialId: boundary, window, expiresInSeconds: 3 } });
      expect(statements).toEqual([
        `SELECT pg_catalog.pg_advisory_xact_lock(${LOCK_KEY}::bigint)`,
        `UPDATE registration_provisioning_dispatches SET created_at = pg_catalog.clock_timestamp() - interval '${window}' + interval '3 seconds' WHERE id = '${UUID_A}'::uuid AND credential_id = '${boundary}' RETURNING created_at + interval '${window}' AS expires_at`,
        "SELECT pg_catalog.pg_sleep(7)",
        "SELECT pg_catalog.clock_timestamp() AS released_after",
      ]);
    }
  });

  it("is the same advisory lock the production claim takes, and only ever the transaction-scoped form", () => {
    const neon = readFileSync("lib/real/server/neon-store.ts", "utf8");
    expect(neon).toContain(`export const PROVISIONING_DISPATCH_ADVISORY_LOCK_KEY = "${LOCK_KEY}";`);
    const { fixtures, holder } = setup();
    for (const statement of lockHolderStatements(fixtures, { lockKey: LOCK_KEY, holdSeconds: 1, insert: { credentialId: holder, label: "holder" } })) expect(statement).not.toMatch(/pg_advisory_lock|pg_try_advisory|pg_advisory_unlock|COMMIT|ROLLBACK|;/);
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ["a non-numeric lock key", { lockKey: "1; DROP TABLE x", holdSeconds: 5 }, /plain positive integer/],
    ["a negative lock key", { lockKey: "-5", holdSeconds: 5 }, /plain positive integer/],
    ["an empty lock key", { lockKey: "", holdSeconds: 5 }, /plain positive integer/],
    ["a zero-second hold", { lockKey: LOCK_KEY, holdSeconds: 0 }, /1 to 10 seconds/],
    ["an 11-second hold", { lockKey: LOCK_KEY, holdSeconds: 11 }, /1 to 10 seconds/],
    ["a fractional hold", { lockKey: LOCK_KEY, holdSeconds: 2.5 }, /1 to 10 seconds/],
    ["an unknown window", { lockKey: LOCK_KEY, holdSeconds: 7, expire: { dispatchId: UUID_A, credentialId: `smoke-${RUN}-pl-ih-prior-0`, window: "1 year", expiresInSeconds: 3 } }, /unknown window/],
    ["an expiry at or after the release", { lockKey: LOCK_KEY, holdSeconds: 7, expire: { dispatchId: UUID_A, credentialId: `smoke-${RUN}-pl-ih-prior-0`, window: "1 hour", expiresInSeconds: 7 } }, /while the lock is still held/],
    ["an expiry of zero", { lockKey: LOCK_KEY, holdSeconds: 7, expire: { dispatchId: UUID_A, credentialId: `smoke-${RUN}-pl-ih-prior-0`, window: "1 hour", expiresInSeconds: 0 } }, /while the lock is still held/],
    ["a row this run does not own", { lockKey: LOCK_KEY, holdSeconds: 7, expire: { dispatchId: UUID_B, credentialId: `smoke-${RUN}-pl-ih-prior-0`, window: "1 hour", expiresInSeconds: 3 } }, /does not own/],
    ["an insert label that could carry a quote", { lockKey: LOCK_KEY, holdSeconds: 5, insert: { credentialId: `smoke-${RUN}-pl-f-holder`, label: "x'y" } }, /body label/],
  ])("refuses %s", (_name, input, reason) => {
    const { fixtures } = setup();
    expect(() => lockHolderStatements(fixtures, input as Parameters<typeof lockHolderStatements>[1])).toThrow(reason);
  });
});

describe("reading a claim's outcome: an error or a lost answer is never a refusal", () => {
  const claimedValue = { outcome: "claimed", attempt: { updatedAt: "2026-10-12T00:00:00.000Z" }, dispatch: { id: UUID_A, dispatchSeq: 1, createdAt: "2026-10-12T00:00:02.000Z" } };

  it("a won claim and the three named refusals are answers", () => {
    expect(classifyClaimResult({ status: "fulfilled", value: claimedValue })).toEqual({ kind: "claimed", dispatchId: UUID_A, dispatchSeq: 1, createdAt: "2026-10-12T00:00:02.000Z", attemptUpdatedAt: "2026-10-12T00:00:00.000Z" });
    for (const outcome of ["claim_lost", "attempt_budget_exhausted", "global_capacity_reached"] as const) expect(classifyClaimResult({ status: "fulfilled", value: { outcome } })).toEqual({ kind: outcome });
  });

  it.each<[string, unknown]>([
    ["null (the old 'lost' answer)", null],
    ["undefined", undefined],
    ["an unknown outcome", { outcome: "rate_limited" }],
    ["a refusal carrying extra fields", { outcome: "global_capacity_reached", dispatch: {} }],
    ["'claimed' without its rows", { outcome: "claimed" }],
    ["'claimed' with a malformed dispatch", { outcome: "claimed", attempt: { updatedAt: "x" }, dispatch: { id: 5, dispatchSeq: 1, createdAt: "x" } }],
    ["a bare string", "global_capacity_reached"],
  ])("%s is `uncertain`, not a refusal and not a claim", (_name, value) => {
    expect(classifyClaimResult({ status: "fulfilled", value }).kind).toBe("uncertain");
  });

  it.each<[string, { code: string; message: string }, string]>([
    ["a lock timeout", { code: "55P03", message: "canceling statement due to lock timeout" }, "lock_timeout"],
    ["a statement / transaction timeout", { code: "57014", message: "canceling statement due to statement timeout" }, "statement_timeout"],
    ["a deadlock", { code: "40P01", message: "deadlock detected" }, "deadlock"],
    ["a unique violation", { code: "23505", message: 'duplicate key value violates unique constraint "registration_provisioning_dispatches_body_sha256_key"' }, "constraint"],
    ["a check violation", { code: "23514", message: "violates check constraint" }, "constraint"],
    ["the in-statement guard", { code: "22P02", message: "invalid input syntax for type integer" }, "other"],
    ["a missing table", { code: "42P01", message: "relation does not exist" }, "other"],
  ])("%s is a database_error (the batch rolled back) with its SQLSTATE", (_name, reason, detail) => {
    expect(classifyClaimResult({ status: "rejected", reason: Object.assign(new Error(reason.message), { code: reason.code }) })).toMatchObject({ kind: "database_error", code: reason.code, detail });
  });

  it("a constraint violation names the constraint — from the driver's own field, else from the server's message — and nothing else passes as a name", () => {
    const named = (reason: Record<string, unknown>) => classifyClaimResult({ status: "rejected", reason: Object.assign(new Error(String(reason.message ?? "")), reason) });
    const key = "registration_provisioning_dispatches_body_sha256_key";
    expect(named({ code: "23505", constraint: key, message: "duplicate key value" })).toMatchObject({ kind: "database_error", constraint: key });
    expect(named({ code: "23505", message: `duplicate key value violates unique constraint "${key}"` })).toMatchObject({ kind: "database_error", constraint: key });
    expect(named({ code: "23505", message: "duplicate key value" })).toMatchObject({ kind: "database_error", constraint: null });
    expect(named({ code: "23505", constraint: "x; DROP TABLE y", message: "duplicate" })).toMatchObject({ kind: "database_error", constraint: null });
    // The name case G requires is the one schema.sql gives UNIQUE (request_body_sha256).
    expect(readFileSync("lib/real/server/schema.sql", "utf8")).toContain(`CONSTRAINT ${key} UNIQUE (request_body_sha256),`);
    expect(readFileSync(FILE, "utf8")).toContain(`constraint: "${key}" });`);
  });

  it.each<[string, unknown]>([
    ["a failed connection", new TypeError("fetch failed")],
    ["a DNS failure", Object.assign(new Error("getaddrinfo ENOTFOUND host.invalid"), { code: "ENOTFOUND" })],
    ["an aborted request", Object.assign(new Error("This operation was aborted"), { name: "AbortError" })],
    ["a non-error rejection", "boom"],
    ["a rejection with no code", new Error("Error connecting to database")],
  ])("%s is `uncertain` — the claim may have committed", (_name, reason) => {
    expect(classifyClaimResult({ status: "rejected", reason }).kind).toBe("uncertain");
  });

  it("an error message never carries a connection URL, and is truncated", () => {
    const observed = classifyClaimResult({ status: "rejected", reason: new Error(`could not reach postgresql://app:secret@ep-x.neon.invalid/neondb ${"x".repeat(500)}`) });
    expect(observed.kind).toBe("uncertain");
    if (observed.kind === "uncertain") {
      expect(observed.message).not.toMatch(/secret|neon\.invalid/);
      expect(observed.message.length).toBeLessThanOrEqual(200);
    }
  });

  it("a tally counts every kind, so 'exactly N admitted and M refused' fails on any error or uncertainty", () => {
    const refused = classifyClaimResult({ status: "fulfilled", value: { outcome: "global_capacity_reached" } });
    const won = classifyClaimResult({ status: "fulfilled", value: claimedValue });
    const lost = classifyClaimResult({ status: "rejected", reason: new TypeError("fetch failed") });
    expect(tally([won, refused, refused])).toEqual({ claimed: 1, global_capacity_reached: 2 });
    expect(tally([won, refused, lost])).not.toEqual({ claimed: 1, global_capacity_reached: 2 });
    expect(tally([won, refused, lost])).toEqual({ claimed: 1, global_capacity_reached: 1, uncertain: 1 });
  });
});

describe("catalog names used to build read-only statements", () => {
  it("accepts plain lower-case identifiers and refuses everything else", () => {
    for (const name of ["registration_attempts", "real_accounts", "_x", "t1"]) expect(assertPlainIdentifier(name)).toBe(name);
    for (const name of ["", "Users", "a b", 'a"b', "a;b", "a.b", "1abc", "a-b", "x".repeat(64), null, undefined, 5]) expect(() => assertPlainIdentifier(name), String(name)).toThrow(/plain identifier/);
  });
});

// ------------------------------------------------------------------ process level: the smoke file in a real child Vitest
const SYNTHETIC_URL = "postgresql://app:synthetic@ep-synthetic-000009.c-1.neon.invalid/neondb";
const SYNTHETIC_POOLED_URL = "postgresql://app:synthetic@ep-synthetic-000009-pooler.c-1.neon.invalid/neondb";
const SYNTHETIC_ENDPOINT = "ep-synthetic-000009";
const PROBE = "test/lib/real/provisioning-limits-lifecycle.probe.test.ts";
const PROCESS_TIMEOUT_MS = 120_000;
const REFUSAL = /refused to connect: |refused before any database work: /;
const CONNECTION_ATTEMPT = /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|getaddrinfo|NeonDbError|WebSocket/i;
/** What the smoke prints once it is about to connect: the rendered mode label, or its evidence line. (A refusal's code frame may show the source of those lines; it never shows them rendered.) */
const NOTHING_REPORTED = /connection_mode: pooled|\[provisioning-limits-smoke\] \{/;
const summary = (output: string) => /Tests\s+([^\n]*)/.exec(output)?.[1] ?? "";

/** A child Vitest run with ONLY the given smoke/database variables: every inherited gate, target, and credential is dropped first. */
function runVitest(args: string[], extra: Record<string, string>): Promise<{ code: number; output: string }> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || /^(VITEST|REAL_SMOKE_|REAL_ADMIN_|NEON_|DATABASE_URL$|TURNKEY_|PIMLICO_|HANDLES_SMOKE_|PAYMENT_RECIPIENT_SMOKE_)/.test(name)) continue;
    env[name] = value;
  }
  return new Promise((resolve) => {
    execFile(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...args], { env: { ...env, ...extra } as NodeJS.ProcessEnv, timeout: PROCESS_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, output: `${stdout}\n${stderr}` });
    });
  });
}

// ------------------------------------------------------------------ pooled connection mode
describe("this run requires the branch's POOLED connection string", () => {
  const BRANCH = "ep-branch-000002";
  const url = (host: string) => `postgresql://app:secret@${host}/neondb`;
  const mode = (host: string) => requirePooledMode(parseDatabaseUrl(url(host), false));

  it("a pooled target is accepted, and the only thing reported is the label", () => {
    expect(mode(`${BRANCH}-pooler.c-1.neon.invalid`)).toEqual({ ok: true, mode: "pooled" });
    expect(mode(`${BRANCH}-pooler.neon.invalid`)).toEqual({ ok: true, mode: "pooled" });
  });

  it.each([
    ["the direct connection string", `${BRANCH}.c-1.neon.invalid`, /requires the disposable branch's POOLED connection string/],
    ["a doubled suffix", `${BRANCH}-pooler-pooler.neon.invalid`, /not exactly <endpoint id>-pooler/],
    ["the suffix on a later label only", `${BRANCH}.c-1-pooler.neon.invalid`, /requires the disposable branch's POOLED/],
    ["'pooler' as its own label", `${BRANCH}.pooler.neon.invalid`, /requires the disposable branch's POOLED/],
    ["a bare '-pooler' host label", "-pooler.neon.invalid", /not exactly <endpoint id>-pooler|could not be read/],
    ["a host that is not an endpoint id", "db-pooler.neon.invalid", /not exactly <endpoint id>-pooler/],
    ["an underscore form", `${BRANCH}_pooler.neon.invalid`, /could not be read|requires the disposable branch's POOLED/],
    ["a mixed-case suffix", `${BRANCH}-POOLER.neon.invalid`, /could not be read/],
  ])("refuses %s — without echoing the URL, its credential, or the endpoint", (_name, host, reason) => {
    const result = mode(host);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(reason);
      expect(result.reason).not.toMatch(/secret|postgres(ql)?:\/\/|neon\.invalid|000002|ep-branch/);
    }
  });

  it("an unreadable target is refused, and a forged 'pooled' flag on a direct hostname is not believed", () => {
    expect(requirePooledMode({ ok: false, problem: "is missing or not a URL" })).toEqual({ ok: false, reason: "the confirmed target could not be read" });
    expect(requirePooledMode({ ok: true, hostname: `${BRANCH}.neon.invalid`, endpoint: BRANCH, pooled: true }).ok).toBe(false);
    expect(requirePooledMode({ ok: true, hostname: `${BRANCH}-pooler.neon.invalid`, endpoint: "ep-other-000003", pooled: true }).ok).toBe(false);
    expect(requirePooledMode({ ok: true, hostname: `${BRANCH}-pooler.neon.invalid`, endpoint: BRANCH, pooled: false }).ok).toBe(false);
  });

  it("the rule is local to this smoke: it reads the shared parser's result and the shared target check is untouched by it", () => {
    const fixture = readFileSync("test/lib/real/fixtures/provisioning-limits-smoke.ts", "utf8");
    const rule = /export function requirePooledMode\([\s\S]*?\n\}/.exec(fixture)?.[0] ?? "";
    expect(rule).not.toMatch(/new URL|process\.env|searchParams/);
    const shared = readFileSync("test/lib/real/fixtures/handles-smoke-db.ts", "utf8");
    expect(shared).not.toMatch(/requirePooledMode|provisioning-limits/);
    // The other disposable-branch smokes still accept either form.
    expect(shared).toContain("return verdict(resolveTarget(input, { urlEnv: BRANCH_URL_ENV, requireDirect: false, confirm: true }));");
  });
});

// ------------------------------------------------------------------ exact-owner cleanup against the in-memory stand-in
const DISPATCH = (n: number) => `3f2b1c9e-0a4d-4e6f-8b7a-${String(n).padStart(12, "0")}`;
const sqlError = (code: string, message: string) => Object.assign(new Error(message), { code });
const ID = (suffix: string) => `smoke-${RUN}-pl-${suffix}`;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The smoke's real registry, cleanup, and lifecycle over the in-memory ledger. `make` is a gated fixture write, as in the smoke. */
function world(options: { caseDeadlineMs?: number; cleanupDeadlineMs?: number; expectedCases?: readonly string[] } = {}) {
  const fixtures = createRunFixtures(RUN);
  const ledger = createFakeLedgerDb();
  const lifecycle = createRunLifecycle({ expectedCases: options.expectedCases ?? ["one", "two", "three"], caseDeadlineMs: options.caseDeadlineMs ?? 5_000, cleanupDeadlineMs: options.cleanupDeadlineMs ?? 5_000, fixtures, db: () => ledger.db });
  lifecycle.arm();
  let n = 0;
  const make = (suffix: string) =>
    lifecycle.write("creating a fixture", async () => {
      const credentialId = fixtures.newCredentialId(suffix);
      n += 1;
      fixtures.registerDispatch(DISPATCH(n), credentialId);
      ledger.seed(credentialId, [DISPATCH(n)]);
      return credentialId;
    });
  /** A case that creates one fixture per suffix and finishes cleanly. */
  const ran = (name: string, ...suffixes: string[]) =>
    lifecycle.runCase(name, async () => {
      for (const suffix of suffixes) await make(suffix);
    });
  const finish = (verifyBaseline: () => Promise<boolean> = async () => ledger.attempts.size === 0 && ledger.dispatches.size === 0) => lifecycle.finish({ verifyBaseline });
  return { fixtures, ledger, lifecycle, make, ran, finish };
}
const OK = { reportedFailed: false };
const counts = (overrides: Partial<Record<"total" | "confirmed" | "refusedByDatabase" | "noAnswer" | "inFlight" | "notAttempted", number>>) => ({ total: 0, confirmed: 0, refusedByDatabase: 0, noAnswer: 0, inFlight: 0, notAttempted: 0, ...overrides });

describe("cleanup: exact, gated before every statement, stop-on-failure, never repeated", () => {
  it("a confirmed cleanup deletes exactly the owned ids, dispatch rows before the attempt, then LOOKS for residue — and only then forgets exactly those ids", async () => {
    const w = world();
    w.ledger.seed("AbCdEf-production-like", [DISPATCH(900)]); // someone else's rows
    await w.ran("one", "a", "b");
    const progress = await removeOwnedFixtures(w.fixtures, openGate(w.ledger.db));
    expect(summarizeCleanup(progress)).toEqual({ status: "confirmed", statements: counts({ total: 4, confirmed: 4 }), residue: "clean", mayStillComplete: false });
    expect(w.ledger.log).toEqual([
      { kind: "delete_dispatches", param: ID("a") },
      { kind: "delete_attempt", param: ID("a") },
      { kind: "delete_dispatches", param: ID("b") },
      { kind: "delete_attempt", param: ID("b") },
      { kind: "residue", param: `smoke-${RUN}-pl-%` },
    ]);
    expect([...w.ledger.attempts]).toEqual(["AbCdEf-production-like"]);
    expect(w.ledger.dispatches.size).toBe(1);
    expect(w.fixtures.ownedCredentialIds()).toEqual([]);
  });

  it.each<[string, unknown, "refused_by_database" | "no_answer", "incomplete" | "uncertain"]>([
    ["the database refuses a statement (SQLSTATE)", sqlError("57014", "canceling statement due to statement timeout"), "refused_by_database", "incomplete"],
    ["a statement's answer never arrives", new TypeError("fetch failed"), "no_answer", "uncertain"],
  ])("G. cleanup partially succeeds, then fails — %s: it STOPS there, and the account says what was deleted, what failed, and what was never sent", async (_name, error, outcome, status) => {
    const w = world();
    await w.ran("one", "a", "b", "c");
    w.ledger.failWhen((_statement, index) => (index === 2 ? { error } : undefined)); // the third statement: b's dispatch rows
    const progress = await removeOwnedFixtures(w.fixtures, openGate(w.ledger.db));
    expect(progress.credentials).toEqual([
      { credentialId: ID("a"), dispatchRows: "confirmed", attemptRow: "confirmed" }, // a IS gone
      { credentialId: ID("b"), dispatchRows: outcome, attemptRow: "not_attempted" },
      { credentialId: ID("c"), dispatchRows: "not_attempted", attemptRow: "not_attempted" },
    ]);
    expect(summarizeCleanup(progress)).toEqual({ status, statements: counts({ total: 6, confirmed: 2, [outcome === "no_answer" ? "noAnswer" : "refusedByDatabase"]: 1, notAttempted: 3 }), residue: "not_read", mayStillComplete: outcome === "no_answer" });
    expect(progress.sqlState).toBe(outcome === "refused_by_database" ? "57014" : null);
    expect(w.ledger.log).toHaveLength(3); // a's two, the failed one — nothing after it, not even the residue read
    expect([...w.ledger.attempts]).toEqual([ID("b"), ID("c")]);
    // Nothing is forgotten after an unconfirmed cleanup — not even `a`, whose rows are gone: the registry is what
    // was minted and not confirmed removed, and the account above is what says which rows actually went.
    expect(w.fixtures.ownedCredentialIds()).toEqual([ID("a"), ID("b"), ID("c")]);
    expect(JSON.stringify(progress)).not.toMatch(/fetch failed|canceling statement/); // outcomes and a SQLSTATE only — no driver text
  });

  it("a failure on an attempt row is recorded on that row; rows found by the final look make it incomplete; an unanswered look is uncertain — and none of them empties the registry", async () => {
    const attemptRow = world();
    await attemptRow.ran("one", "a");
    attemptRow.ledger.failWhen((statement) => (statement.kind === "delete_attempt" ? { error: sqlError("23503", "violates foreign key constraint") } : undefined));
    const first = await removeOwnedFixtures(attemptRow.fixtures, openGate(attemptRow.ledger.db));
    expect(first.credentials).toEqual([{ credentialId: ID("a"), dispatchRows: "confirmed", attemptRow: "refused_by_database" }]);
    expect(first.sqlState).toBe("23503");
    expect(summarizeCleanup(first).status).toBe("incomplete");

    const leftover = world();
    await leftover.ran("one", "a");
    leftover.ledger.seed(ID("unregistered"), []); // a row of this run's shape that the registry does not hold
    const second = await removeOwnedFixtures(leftover.fixtures, openGate(leftover.ledger.db));
    expect(summarizeCleanup(second)).toMatchObject({ status: "incomplete", residue: "rows_remain", statements: counts({ total: 2, confirmed: 2 }) });
    expect(second.residueCounts).toEqual({ attempts: 1, dispatches: 0 });
    expect([...leftover.ledger.attempts]).toEqual([ID("unregistered")]); // seen, reported, NOT deleted
    expect(leftover.fixtures.ownedCredentialIds()).toEqual([ID("a")]);

    const blind = world();
    await blind.ran("one", "a");
    blind.ledger.failWhen((statement) => (statement.kind === "residue" ? { error: new TypeError("fetch failed") } : undefined));
    const third = await removeOwnedFixtures(blind.fixtures, openGate(blind.ledger.db));
    expect(summarizeCleanup(third)).toMatchObject({ status: "uncertain", residue: "no_answer", statements: counts({ total: 2, confirmed: 2 }) });
    expect(blind.fixtures.ownedCredentialIds()).toEqual([ID("a")]);
  });

  it("the gate is consulted before EVERY statement: switched off part-way, the loop sends nothing further — and a switched-off gate refuses a direct call too", async () => {
    const w = world();
    await w.ran("one", "a", "b", "c");
    let allowed = 3; // a's two deletes and b's dispatch rows
    const sent: string[] = [];
    const gate = {
      active: () => allowed > 0,
      q: (text: string, params?: unknown[]) => {
        allowed -= 1;
        sent.push(String(params?.[0]));
        return w.ledger.db.q(text, params);
      },
    };
    const progress = await removeOwnedFixtures(w.fixtures, gate);
    expect(sent).toEqual([ID("a"), ID("a"), ID("b")]);
    expect(progress.stopped).toBe("switched_off");
    expect(progress.credentials).toEqual([
      { credentialId: ID("a"), dispatchRows: "confirmed", attemptRow: "confirmed" },
      { credentialId: ID("b"), dispatchRows: "confirmed", attemptRow: "not_attempted" },
      { credentialId: ID("c"), dispatchRows: "not_attempted", attemptRow: "not_attempted" },
    ]);
    expect(progress.residue).toBe("not_read");
    expect(w.fixtures.ownedCredentialIds()).toHaveLength(3);
    // A gate that is off from the start: not one statement.
    const never = world();
    await never.ran("one", "a");
    const untouched = await removeOwnedFixtures(never.fixtures, { active: () => false, q: never.ledger.db.q });
    expect(never.ledger.log).toEqual([]);
    expect(summarizeCleanup(untouched)).toMatchObject({ status: "incomplete", statements: counts({ total: 2, notAttempted: 2 }) });
  });

  it("each DELETE re-checks ownership at the moment it is sent, and is built only from the registry", () => {
    const source = readFileSync("test/lib/real/fixtures/provisioning-limits-smoke.ts", "utf8");
    const loop = /export async function removeOwnedFixtures\([\s\S]*?\n\}/.exec(source)?.[0] ?? "";
    const gateCheck = loop.indexOf("if (!gate.active() || !entry) {");
    const ownership = loop.indexOf("fixtures.assertOwnedCredential(statement.credentialId);");
    const send = loop.indexOf("await gate.q(statement.text, statement.params);");
    expect(gateCheck).toBeGreaterThan(0);
    expect(ownership).toBeGreaterThan(gateCheck);
    expect(send).toBeGreaterThan(ownership);
    // The loop can reach the database ONLY through the gate.
    expect(loop.match(/\.q\(/g)).toHaveLength(2); // one delete call site, one residue read
    expect(loop).not.toMatch(/\bdb\b|database\.q|input\.db/);
    expect(loop).toContain('if (progress.residue === "clean" && gate.active()) fixtures.forget(progress.credentials.map((entry) => entry.credentialId));');
  });

  it("an account starts with every statement 'not_attempted', before anything asynchronous happens", async () => {
    const w = world();
    await w.ran("one", "a", "b");
    const progress = beginCleanupProgress(w.fixtures);
    expect(summarizeCleanup(progress)).toEqual({ status: "incomplete", statements: counts({ total: 4, notAttempted: 4 }), residue: "not_read", mayStillComplete: false });
    expect(w.ledger.log).toEqual([]);
  });
});

// ------------------------------------------------------------------ the poison lifecycle
describe("run lifecycle (the smoke's real lifecycle, registry, and cleanup over an in-memory ledger)", () => {
  it("A. cleanup completes normally: it is in flight from before its first statement until it settles, runs once, and the next case starts only afterwards", async () => {
    const w = world();
    await w.ran("one", "a");
    expect(w.ledger.log).toEqual([]); // nothing is deleted while the case runs
    w.ledger.failWhen((statement) => (statement.kind === "delete_dispatches" ? { stallMs: 40 } : undefined));
    const cleaning = w.lifecycle.afterCase(OK);
    expect(w.lifecycle.cleanupInFlight()).toBe("one"); // set synchronously, before any await
    await wait(5);
    expect(w.lifecycle.cleanupInFlight()).toBe("one");
    const record = await cleaning;
    expect(w.lifecycle.cleanupInFlight()).toBeNull();
    expect(record.accepted).toBe(true);
    expect(summarizeCleanup(record.progress!)).toMatchObject({ status: "confirmed", statements: counts({ total: 2, confirmed: 2 }), residue: "clean" });
    expect(w.ledger.deletes()).toHaveLength(2);
    expect(w.ledger.attempts.size + w.ledger.dispatches.size).toBe(0);
    expect(w.lifecycle.poisoned()).toBeNull();
    // ...and now the next case may start.
    await w.ran("two", "b");
    expect(w.lifecycle.executed()).toEqual(["one", "two"]);
  });

  it("B + H. a DELETE stalls beyond the cleanup deadline: the run poisons at the deadline, and the cleanup stays IN FLIGHT until the stalled statement really settles", async () => {
    const w = world({ cleanupDeadlineMs: 30 });
    await w.ran("one", "a", "b");
    w.ledger.failWhen((_statement, index) => (index === 0 ? { stallMs: 150 } : undefined));
    await expect(w.lifecycle.afterCase(OK)).rejects.toThrow(/exceeded its deadline. No further cleanup statement will be sent; what was already issued may still complete. Nothing is retried/);
    expect(w.lifecycle.poisoned()).toBe('the cleanup after "one" exceeded its 30 ms deadline; a statement it already issued may still complete');
    expect(w.lifecycle.inFlight()).toBeNull(); // the case body settled long ago...
    expect(w.lifecycle.cleanupInFlight()).toBe("one"); // ...but the cleanup has not: the deadline did not clear the marker
    expect(w.ledger.stalled()).toBe(1);
    expect(w.ledger.log).toHaveLength(1);
    // While it is in flight the report says so, and that it may still complete.
    const during = await w.finish();
    expect(during.unconfirmedCleanup).toMatchObject({ cleanups: 1, confirmed: 0, inFlight: 1, notAttempted: 3, mayStillComplete: true });
    expect(during.stillInFlight).toEqual({ caseBody: null, cleanup: "one" });
    await wait(180);
    expect(w.lifecycle.cleanupInFlight()).toBeNull(); // cleared only now, by the loop itself settling
    expect(w.lifecycle.poisoned()).toMatch(/^the cleanup after "one" exceeded its 30 ms deadline/);
  });

  it("D. the stalled DELETE eventually SUCCEEDS: its outcome is recorded, and not one further statement is sent — no next DELETE, no residue read", async () => {
    const w = world({ cleanupDeadlineMs: 30 });
    await w.ran("one", "a", "b");
    w.ledger.failWhen((_statement, index) => (index === 0 ? { stallMs: 120 } : undefined));
    await expect(w.lifecycle.afterCase(OK)).rejects.toThrow(/exceeded its deadline/);
    await wait(160);
    expect(w.ledger.settledAfterStall).toEqual([{ kind: "delete_dispatches", param: ID("a") }]);
    expect(w.ledger.log).toEqual([{ kind: "delete_dispatches", param: ID("a") }]); // the late continuation stopped at the gate
    const record = w.lifecycle.cleanups()[0]!;
    expect(record.accepted).toBe(false);
    expect(record.progress).toMatchObject({ stopped: "switched_off", residue: "not_read", credentials: [{ credentialId: ID("a"), dispatchRows: "confirmed", attemptRow: "not_attempted" }, { credentialId: ID("b"), dispatchRows: "not_attempted", attemptRow: "not_attempted" }] });
    expect(w.ledger.dispatches.size).toBe(1); // a's dispatch row IS gone; everything else remains
    expect([...w.ledger.attempts]).toEqual([ID("a"), ID("b")]);
    expect(w.fixtures.ownedCredentialIds()).toEqual([ID("a"), ID("b")]);
    // Later hooks do not restart it.
    for (let i = 0; i < 3; i += 1) expect((await w.lifecycle.afterCase(OK)).skipped).toMatch(/^nothing was sent: the cleanup after "one" exceeded/);
    expect(w.ledger.log).toHaveLength(1);
  });

  it("E. the stalled DELETE eventually FAILS: recorded as refused, never retried, nothing further sent", async () => {
    const w = world({ cleanupDeadlineMs: 30 });
    await w.ran("one", "a", "b");
    w.ledger.failWhen((_statement, index) => (index === 0 ? { stallMs: 120, error: sqlError("57014", "canceling statement due to statement timeout") } : undefined));
    await expect(w.lifecycle.afterCase(OK)).rejects.toThrow(/exceeded its deadline/);
    await wait(160);
    w.ledger.failWhen(null); // even with the database healthy again, nothing asks it anything
    await w.lifecycle.afterCase(OK);
    const final = await w.finish();
    expect(w.ledger.log).toEqual([{ kind: "delete_dispatches", param: ID("a") }]);
    expect(final.cleanups[0]).toMatchObject({ accepted: false, sqlState: "57014", credentials: [{ credentialId: ID("a"), dispatchRows: "refused_by_database", attemptRow: "not_attempted" }, { credentialId: ID("b"), dispatchRows: "not_attempted", attemptRow: "not_attempted" }] });
    expect(final.unconfirmedCleanup).toEqual({ cleanups: 1, confirmed: 0, refusedByDatabase: 1, noAnswer: 0, inFlight: 0, notAttempted: 3, residue: "not_read", mayStillComplete: false });
    expect(w.ledger.dispatches.size).toBe(2);
  });

  it("C + I. a later case that finds a cleanup in flight refuses BEFORE its body — no read, no write — and so does any write", async () => {
    const w = world({ cleanupDeadlineMs: 5_000 }); // the deadline is far off: only the in-flight marker protects
    await w.ran("one", "a", "b");
    w.ledger.failWhen((_statement, index) => (index === 0 ? { stallMs: 120 } : undefined));
    const abandoned = w.lifecycle.afterCase(OK); // the runner stops waiting for this hook...
    abandoned.catch(() => undefined);
    await wait(10);
    const body = vi.fn(async () => undefined); // ...and starts the next test
    await expect(w.lifecycle.runCase("two", body)).rejects.toThrow(/"two" was not run.*poisoned \(the cleanup after "one" was still in flight when "two" was about to start; its statements may still complete\)/);
    expect(body).not.toHaveBeenCalled();
    const operation = vi.fn(async () => undefined);
    await expect(w.lifecycle.write("a provisioning claim", operation)).rejects.toThrow(/poisoned/);
    expect(operation).not.toHaveBeenCalled();
    expect(w.ledger.log).toHaveLength(1); // only the stalled DELETE; nothing since
    // When the stalled statement returns, the abandoned loop finds the run poisoned and stops.
    await expect(abandoned).rejects.toThrow(/the cleanup after "one" was incomplete/);
    expect(w.ledger.log).toHaveLength(1);
    expect(w.lifecycle.cleanupInFlight()).toBeNull();
    expect(w.lifecycle.cleanups()[0]).toMatchObject({ accepted: false, progress: { stopped: "switched_off" } });
  });

  it("F. the residue read stalls: every DELETE was confirmed, but the registry is NOT emptied, the cleanup is not accepted, and the report does not call the rows retained", async () => {
    const w = world({ cleanupDeadlineMs: 30 });
    await w.ran("one", "a", "b");
    w.ledger.failWhen((statement) => (statement.kind === "residue" ? { stallMs: 120 } : undefined));
    await expect(w.lifecycle.afterCase(OK)).rejects.toThrow(/exceeded its deadline/);
    expect(w.fixtures.ownedCredentialIds()).toEqual([ID("a"), ID("b")]);
    expect(w.lifecycle.cleanupInFlight()).toBe("one");
    await wait(160); // the read answers "clean" — too late to count
    expect(w.fixtures.ownedCredentialIds()).toEqual([ID("a"), ID("b")]); // still not forgotten
    const final = await w.finish();
    expect(final.cleanups[0]).toMatchObject({ accepted: false, summary: { statements: counts({ total: 4, confirmed: 4 }), residue: "clean" } });
    expect(final.unconfirmedCleanup).toMatchObject({ cleanups: 1, confirmed: 4, notAttempted: 0, residue: "clean" });
    expect(final.registryCredentialIds).toEqual([ID("a"), ID("b")]);
    expect(final.action).toMatch(/^The database state is unknown after this failure\. Some run-owned rows may have been deleted, and some may remain\..*confirmed \(those rows ARE deleted\): 4;/);
    expect(final.action).not.toMatch(/deleted none|No cleanup was started/);
    expect(final).toMatchObject({ outcome: "poisoned_evidence_preserved", databaseRestored: false });
  });

  it("G + K. a partial cleanup's final report says what was deleted and what is unknown — never that nothing was deleted, never that the ids are 'retained'", async () => {
    const w = world();
    await w.ran("one", "a", "b", "c");
    w.ledger.failWhen((_statement, index) => (index === 3 ? { error: new TypeError("fetch failed"), applied: true } : undefined)); // b's attempt row: applied, answer lost
    await expect(w.lifecycle.afterCase(OK)).rejects.toThrow(/the cleanup after "one" was uncertain. No further cleanup will be attempted; the database state is unknown/);
    expect(w.lifecycle.poisoned()).toBe('the cleanup after "one" was uncertain (3 of 6 statements confirmed)');
    const final = await w.finish();
    expect(final.cleanups[0]!.credentials).toEqual([
      { credentialId: ID("a"), dispatchRows: "confirmed", attemptRow: "confirmed" },
      { credentialId: ID("b"), dispatchRows: "confirmed", attemptRow: "no_answer" },
      { credentialId: ID("c"), dispatchRows: "not_attempted", attemptRow: "not_attempted" },
    ]);
    expect(final.unconfirmedCleanup).toEqual({ cleanups: 1, confirmed: 3, refusedByDatabase: 0, noAnswer: 1, inFlight: 0, notAttempted: 2, residue: "not_read", mayStillComplete: true });
    expect(final.action).toBe(
      "The database state is unknown after this failure. Some run-owned rows may have been deleted, and some may remain. A cleanup was interrupted; of its delete statements — confirmed (those rows ARE deleted): 3; refused by the database: 0; sent with no known outcome (may still complete): 1; never sent: 2. Its final look for leftover rows: not_read. The database was NOT restored. Investigate the disposable branch read-only. Do not reuse or automatically repair the branch.",
    );
    // The ids are the registry — minted and not confirmed removed — not a claim about what is in the database.
    expect(final.registryCredentialIds).toEqual([ID("a"), ID("b"), ID("c")]);
    expect(final).not.toHaveProperty("retainedCredentialIds");
    const json = JSON.stringify(final);
    expect(json).not.toMatch(/retained|deleted none|LEFT in|No cleanup was started|"databaseRestored":true|fetch failed/);
    // In truth (which the harness does not re-read after poison): a and b are gone, c remains.
    expect([...w.ledger.attempts]).toEqual([ID("c")]);
    // And nothing was sent after the failure.
    expect(w.ledger.log).toHaveLength(4);
    await w.lifecycle.afterCase(OK);
    expect(w.ledger.log).toHaveLength(4);
  });

  it("a failed run in which no cleanup was ever started is described as exactly that — not as an interrupted cleanup", async () => {
    const w = world();
    await w.ran("one", "one-a");
    await w.lifecycle.afterCase(OK);
    await expect(
      w.lifecycle.runCase("two", async () => {
        await w.make("two-a");
        throw new Error("assertion failed");
      }),
    ).rejects.toThrow();
    await w.lifecycle.afterCase({ reportedFailed: true });
    const baseline = vi.fn(async () => true); // even a baseline that WOULD match is not consulted
    const final = await w.finish(baseline);
    expect(baseline).not.toHaveBeenCalled();
    expect(final).toMatchObject({ outcome: "poisoned_evidence_preserved", databaseRestored: false, baselineCompared: false, poisoned: '"two" failed', executed: ["one"], notExecuted: ["two", "three"], registryCredentialIds: [ID("two-a")] });
    expect(final.unconfirmedCleanup).toEqual({ cleanups: 0, confirmed: 0, refusedByDatabase: 0, noAnswer: 0, inFlight: 0, notAttempted: 0, residue: null, mayStillComplete: false });
    expect(final.action).toMatch(/^The run is poisoned\. No cleanup was started after the failure, so the harness itself deleted none of the rows of the identifiers in registryCredentialIds — but their presence was not verified.*NOT restored.*Investigate the disposable branch read-only\. Do not reuse or automatically repair the branch\.$/);
    expect(JSON.stringify(final)).not.toMatch(/"databaseRestored":true|completed_clean|matches its pre-run baseline/);
    expect(final.cleanups.map((entry) => [entry.accepted, entry.skipped === null])).toEqual([[true, true], [false, false]]);
    expect([...w.ledger.attempts]).toEqual([ID("two-a")]);
  });

  it("mutual exclusion: a case cannot start until the previous case's cleanup was confirmed — even if the runner never called the hook", async () => {
    const w = world();
    await w.ran("one", "a");
    const body = vi.fn(async () => undefined);
    await expect(w.lifecycle.runCase("two", body)).rejects.toThrow(/poisoned \(the cleanup after "one" was never confirmed before "two" was about to start\)/);
    expect(body).not.toHaveBeenCalled();
    expect(w.ledger.log).toEqual([]);
  });

  it("mutual exclusion: a cleanup that is due while its case body is still running, or while another cleanup is in flight, sends nothing and poisons", async () => {
    const overlapping = world({ cleanupDeadlineMs: 5_000 });
    await overlapping.ran("one", "a");
    overlapping.ledger.failWhen((_statement, index) => (index === 0 ? { stallMs: 80 } : undefined));
    const first = overlapping.lifecycle.afterCase(OK);
    first.catch(() => undefined);
    await wait(5);
    expect((await overlapping.lifecycle.afterCase(OK)).skipped).toMatch(/^nothing was sent: the cleanup after "one" was still in flight when another cleanup was due/);
    expect(overlapping.ledger.log).toHaveLength(1);
    await expect(first).rejects.toThrow(/incomplete/);
    expect(overlapping.ledger.log).toHaveLength(1); // and the first one stopped too

    const body = world();
    let release!: () => void;
    const running = body.lifecycle.runCase("one", async () => {
      await body.make("a");
      await new Promise<void>((resolve) => (release = resolve));
    });
    running.catch(() => undefined);
    await wait(5);
    expect((await body.lifecycle.afterCase(OK)).skipped).toMatch(/^nothing was sent: "one" was still running when its cleanup was due/);
    expect(body.ledger.log).toEqual([]);
    release();
    await expect(running).rejects.toThrow(/poisoned/);
  });

  it("poison arriving WHILE a cleanup runs stops it at the next statement, and that cleanup is not accepted", async () => {
    const w = world();
    await w.ran("one", "a", "b");
    w.ledger.failWhen((_statement, index) => (index === 1 ? { stallMs: 40 } : undefined));
    const cleaning = w.lifecycle.afterCase(OK);
    await wait(10);
    w.lifecycle.poison("something else went wrong");
    await expect(cleaning).rejects.toThrow(/the cleanup after "one" was incomplete/);
    expect(w.ledger.log).toHaveLength(2); // a's two statements; b was never touched
    expect(w.lifecycle.cleanups()[0]).toMatchObject({ accepted: false, progress: { stopped: "switched_off" } });
    expect(w.lifecycle.poisoned()).toBe("something else went wrong");
  });

  it("B'. an assertion fails after fixtures were created: the run poisons and NO cleanup statement is sent — the rows stay exactly as they were", async () => {
    const w = world();
    await expect(
      w.lifecycle.runCase("one", async () => {
        await w.make("a");
        await w.make("b");
        expect(w.ledger.dispatches.size).toBe(99);
      }),
    ).rejects.toThrow();
    const before = { attempts: [...w.ledger.attempts], dispatches: [...w.ledger.dispatches] };
    for (const observed of [{ reportedFailed: true }, OK]) expect((await w.lifecycle.afterCase(observed)).skipped).toMatch(/^nothing was sent: "one" failed/);
    expect(w.ledger.log).toEqual([]);
    expect({ attempts: [...w.ledger.attempts], dispatches: [...w.ledger.dispatches] }).toEqual(before);
    expect(w.lifecycle.poisoned()).toBe('"one" failed');
    expect(w.lifecycle.executed()).toEqual([]);
  });

  it("the runner's verdict alone is enough: a case whose own body succeeded but whose test failed is not cleaned up", async () => {
    const w = world();
    await w.ran("one", "a");
    expect((await w.lifecycle.afterCase({ reportedFailed: true })).skipped).toMatch(/the test runner reported "one" as failed/);
    expect(w.ledger.log).toEqual([]);
    expect(w.ledger.attempts.size).toBe(1);
    expect(w.lifecycle.poisoned()).toBe('the test runner reported "one" as failed');
  });

  it("a database error inside a case: the run poisons at once, the failed write is not repeated, and no cleanup is sent", async () => {
    const w = world();
    const failing = vi.fn(async () => {
      throw sqlError("40P01", "deadlock detected");
    });
    await expect(
      w.lifecycle.runCase("one", async () => {
        await w.make("a");
        await w.lifecycle.write("re-dating a fixture row", failing);
      }),
    ).rejects.toThrow(/deadlock/);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(w.lifecycle.poisoned()).toBe("a database operation failed (re-dating a fixture row)");
    await w.lifecycle.afterCase({ reportedFailed: true });
    expect(w.ledger.log).toEqual([]);
    expect([...w.ledger.attempts]).toEqual([ID("a")]);
  });

  it("a case body still unresolved when cleanup is due: the run poisons, nothing is sent — and the poison stays when that body later settles", async () => {
    const w = world();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let lateWrite = "not attempted";
    const running = w.lifecycle.runCase("one", async () => {
      await w.make("a");
      await gate; // "still talking to the database" after the runner has given up on this test
      try {
        await w.make("a-late");
        lateWrite = "performed";
      } catch {
        lateWrite = "refused";
      }
    });
    running.catch(() => undefined);
    await wait(10);
    expect(w.lifecycle.inFlight()).toBe("one");
    expect((await w.lifecycle.afterCase(OK)).skipped).toMatch(/still running when its cleanup was due/);
    expect(w.ledger.log).toEqual([]);
    release();
    await expect(running).rejects.toThrow(/poisoned/);
    expect(lateWrite).toBe("refused");
    expect(w.lifecycle.inFlight()).toBeNull();
    expect(w.lifecycle.poisoned()).toMatch(/^"one" was still running when its cleanup was due/); // unchanged, not cleared
    expect(w.lifecycle.executed()).toEqual([]);
    expect([...w.ledger.attempts]).toEqual([ID("a")]);
  });

  it("a case that outlives the run's own deadline poisons the run while it is still in flight; its late success changes nothing", async () => {
    const w = world({ caseDeadlineMs: 30 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const running = w.lifecycle.runCase("one", async () => {
      await w.make("a");
      await gate;
    });
    await expect(running).rejects.toThrow(/exceeded its deadline/);
    expect(w.lifecycle.poisoned()).toMatch(/^"one" exceeded its 30 ms deadline/);
    expect(w.lifecycle.inFlight()).toBe("one"); // not assumed cancelled
    const next = vi.fn(async () => undefined);
    await expect(w.lifecycle.runCase("two", next)).rejects.toThrow(/poisoned/);
    expect(next).not.toHaveBeenCalled();
    release();
    await wait(10);
    expect(w.lifecycle.inFlight()).toBeNull();
    expect(w.lifecycle.poisoned()).toMatch(/^"one" exceeded its 30 ms deadline/);
    expect(w.lifecycle.executed()).toEqual([]);
  });

  it("after poison: every later case refuses BEFORE its body, every write refuses before its operation, and the ledger is not touched again", async () => {
    const w = world();
    await expect(w.lifecycle.runCase("one", async () => void expect(1).toBe(2))).rejects.toThrow();
    const bodies = [vi.fn(async () => undefined), vi.fn(async () => undefined)];
    await expect(w.lifecycle.runCase("two", bodies[0]!)).rejects.toThrow(/"two" was not run.*poisoned.*never retried automatically/);
    await expect(w.lifecycle.runCase("three", bodies[1]!)).rejects.toThrow(/poisoned/);
    for (const body of bodies) expect(body).not.toHaveBeenCalled();
    const operation = vi.fn(async () => undefined);
    await expect(w.lifecycle.write("a provisioning claim", operation)).rejects.toThrow(/poisoned/);
    expect(() => w.lifecycle.beforeWrite("a provisioning claim")).toThrow(/poisoned/);
    expect(operation).not.toHaveBeenCalled();
    expect(w.ledger.log).toEqual([]);
  });

  it("J. the poison is permanent and keeps its FIRST reason — through later hooks, a stalled cleanup settling, re-arming, and the end of the run", async () => {
    const w = world({ cleanupDeadlineMs: 30 });
    await w.ran("one", "a");
    w.ledger.failWhen((_statement, index) => (index === 0 ? { stallMs: 80 } : undefined));
    await expect(w.lifecycle.afterCase(OK)).rejects.toThrow();
    const first = w.lifecycle.poisoned();
    expect(first).toMatch(/^the cleanup after "one" exceeded its 30 ms deadline/);
    w.lifecycle.poison("second");
    w.lifecycle.arm(); // arming again does not clear it
    await wait(110); // the stalled statement settles
    await w.lifecycle.afterCase(OK);
    await expect(w.lifecycle.runCase("two", async () => undefined)).rejects.toThrow(/poisoned/);
    expect((await w.finish()).poisoned).toBe(first);
    expect(w.lifecycle.poisoned()).toBe(first);
    const source = readFileSync("test/lib/real/fixtures/provisioning-limits-smoke.ts", "utf8");
    expect(source.match(/\bpoisoned = /g)).toEqual(["poisoned = "]); // assigned in exactly one place...
    expect(source).toContain("if (poisoned === null) poisoned = reason;"); // ...and only while still null
    // One lifecycle, one poison: the cleanup gate reads that same flag.
    expect(source).toContain("active: () => poisoned === null && !expired && cleanupInvocation === invocation,");
  });

  it("a cleanup that the database refuses poisons the run immediately, and NO later hook sends another cleanup statement", async () => {
    const w = world();
    await w.ran("one", "a", "b");
    w.ledger.failWhen((_statement, index) => (index === 1 ? { error: sqlError("57014", "canceling statement due to statement timeout") } : undefined));
    await expect(w.lifecycle.afterCase(OK)).rejects.toThrow(/the cleanup after "one" was incomplete/);
    expect(w.lifecycle.poisoned()).toBe('the cleanup after "one" was incomplete (1 of 4 statements confirmed)');
    w.ledger.failWhen(null);
    for (let i = 0; i < 3; i += 1) expect((await w.lifecycle.afterCase(OK)).skipped).toMatch(/^nothing was sent/);
    const next = vi.fn(async () => undefined);
    await expect(w.lifecycle.runCase("two", next)).rejects.toThrow(/poisoned/);
    const baseline = vi.fn(async () => true);
    const final = await w.finish(baseline);
    expect(next).not.toHaveBeenCalled();
    expect(baseline).not.toHaveBeenCalled();
    expect(w.ledger.log).toHaveLength(2);
    expect(final.unconfirmedCleanup).toMatchObject({ cleanups: 1, confirmed: 1, refusedByDatabase: 1, notAttempted: 2, mayStillComplete: false });
    expect(final.cleanups[0]!.sqlState).toBe("57014");
  });

  it("L. a successful complete run: every expected case executes, each cleanup is confirmed and accepted once, residue is zero, and the baseline comparison passes", async () => {
    const w = world();
    for (const name of ["one", "two", "three"]) {
      await w.ran(name, `${name}-a`, `${name}-b`);
      await w.lifecycle.afterCase(OK);
    }
    await w.lifecycle.afterCase(OK); // after the final completeness check, which creates nothing
    const baseline = vi.fn(async () => w.ledger.attempts.size === 0 && w.ledger.dispatches.size === 0);
    const final = await w.finish(baseline);
    expect(baseline).toHaveBeenCalledTimes(1);
    expect(final).toMatchObject({ outcome: "completed_clean", databaseRestored: true, baselineCompared: true, poisoned: null, stillInFlight: { caseBody: null, cleanup: null }, executed: ["one", "two", "three"], notExecuted: [], registryCredentialIds: [] });
    expect(final.cleanups.map((entry) => [entry.accepted, entry.summary?.status, entry.summary?.statements.confirmed, entry.summary?.residue])).toEqual([[true, "confirmed", 4, "clean"], [true, "confirmed", 4, "clean"], [true, "confirmed", 4, "clean"], [true, "confirmed", 0, "clean"]]);
    expect(final.unconfirmedCleanup).toMatchObject({ cleanups: 0, confirmed: 0 });
    expect(w.ledger.deletes()).toHaveLength(12); // each fixture's two statements, once
    expect(w.ledger.attempts.size + w.ledger.dispatches.size).toBe(0);
  });

  it("a complete run whose database does NOT match its baseline is reported as a mismatch, never as restored; an unreadable baseline or a missing case poisons", async () => {
    const mismatch = world({ expectedCases: ["one"] });
    await mismatch.ran("one");
    await mismatch.lifecycle.afterCase(OK);
    expect(await mismatch.finish(async () => false)).toMatchObject({ outcome: "completed_baseline_mismatch", databaseRestored: false, baselineCompared: true });

    const unreadable = world({ expectedCases: ["one"] });
    await unreadable.ran("one");
    await unreadable.lifecycle.afterCase(OK);
    expect(await unreadable.finish(async () => Promise.reject(new TypeError("fetch failed")))).toMatchObject({ outcome: "poisoned_evidence_preserved", databaseRestored: false });

    const uncleaned = world({ expectedCases: ["one"] });
    await uncleaned.ran("one", "a");
    expect(await uncleaned.finish(async () => true)).toMatchObject({ outcome: "poisoned_evidence_preserved", poisoned: 'the cleanup after "one" was never confirmed' });

    const short = world();
    await short.ran("one");
    await short.lifecycle.afterCase(OK);
    expect(await short.finish()).toMatchObject({ outcome: "poisoned_evidence_preserved", databaseRestored: false, poisoned: "not every expected case ran", notExecuted: ["two", "three"] });
  });

  it("an uncertain write: the run poisons, the write is not retried, and no further claim is made", async () => {
    const w = world();
    const claim = vi.fn(async (): Promise<string> => {
      w.lifecycle.beforeWrite("a provisioning claim");
      const observed = classifyClaimResult({ status: "rejected", reason: new TypeError("fetch failed") });
      if (observed.kind === "uncertain") throw w.lifecycle.uncertain("a provisioning claim whose answer never arrived");
      return observed.kind;
    });
    await expect(
      w.lifecycle.runCase("one", async () => {
        await w.make("a");
        await claim(); // its answer never arrives
        await claim(); // never reached
      }),
    ).rejects.toThrow(/poisoned \(uncertain outcome \(a provisioning claim whose answer never arrived\); the write may or may not have committed\)/);
    expect(claim).toHaveBeenCalledTimes(1);
    await expect(claim()).rejects.toThrow(/a provisioning claim refused/); // a stray later call is stopped at the gate
    await w.lifecycle.afterCase({ reportedFailed: true });
    expect(w.ledger.log).toEqual([]);
    expect(readFileSync(FILE, "utf8")).toContain('if (observation.kind === "uncertain") throw lifecycle.uncertain("a provisioning claim whose answer never arrived");');
  });

  it("before the preflight has passed nothing runs, nothing is written, and nothing is cleaned up", async () => {
    const fixtures = createRunFixtures(RUN);
    const ledger = createFakeLedgerDb();
    const lifecycle = createRunLifecycle({ expectedCases: ["one"], caseDeadlineMs: 1_000, cleanupDeadlineMs: 1_000, fixtures, db: () => ledger.db });
    const body = vi.fn(async () => undefined);
    await expect(lifecycle.runCase("one", body)).rejects.toThrow(/preflight did not pass/);
    expect(() => lifecycle.beforeWrite("a provisioning claim")).toThrow(/preflight did not pass/);
    expect(await lifecycle.afterCase(OK)).toMatchObject({ skipped: "the run never started", progress: null, accepted: false });
    const baseline = vi.fn(async () => true);
    expect(await lifecycle.finish({ verifyBaseline: baseline })).toMatchObject({ outcome: "not_started", databaseRestored: false });
    expect(body).not.toHaveBeenCalled();
    expect(baseline).not.toHaveBeenCalled();
    expect(ledger.log).toEqual([]);
  });

  it("an unexpected case name, a case started twice, a write outside any case, and a non-positive deadline are all refused", async () => {
    const unknown = world();
    await expect(unknown.lifecycle.runCase("four", async () => undefined)).rejects.toThrow(/poisoned/);
    const twice = world();
    await twice.ran("one");
    await twice.lifecycle.afterCase(OK);
    await expect(twice.lifecycle.runCase("one", async () => undefined)).rejects.toThrow(/poisoned/);
    const outside = world();
    await expect(outside.make("a")).rejects.toThrow(/poisoned \(a write \(creating a fixture\) was attempted outside a running case\)/);
    expect(outside.ledger.attempts.size).toBe(0);
    for (const bad of [{ caseDeadlineMs: 0, cleanupDeadlineMs: 10 }, { caseDeadlineMs: 10, cleanupDeadlineMs: 0 }, { caseDeadlineMs: 10, cleanupDeadlineMs: 1.5 }]) {
      expect(() => createRunLifecycle({ expectedCases: [], ...bad, fixtures: createRunFixtures(RUN), db: () => createFakeLedgerDb().db })).toThrow(/deadline/);
    }
  });

  it("the runner's verdict is read fail-closed: only a test that is positively passing or still running counts as not failed", () => {
    expect(caseFailedInVitest({ task: { result: { state: "pass" } } })).toBe(false);
    expect(caseFailedInVitest({ task: { result: { state: "run" } } })).toBe(false);
    expect(caseFailedInVitest({ task: { result: { state: "fail" } } })).toBe(true);
    expect(caseFailedInVitest({ task: { result: { state: "run", errors: [new Error("x")] } } })).toBe(true);
    for (const unreadable of [undefined, null, {}, { task: {} }, { task: { result: null } }, { task: { result: { state: "skip" } } }, { task: { result: {} } }]) expect(caseFailedInVitest(unreadable)).toBe(true);
  });
});

// ------------------------------------------------------------------ the evidence file
describe("evidence file: one new owner-only file per run, never overwritten, never unsafe", () => {
  const inTemp = async (body: (directory: string) => void | Promise<void>) => {
    const directory = mkdtempSync(path.join(tmpdir(), "provisioning-evidence-"));
    try {
      await body(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
  const clean = { outcome: "completed_clean", databaseRestored: true, action: "None." } as FinalReport;
  const readdirNames = (directory: string) => readdirSync(directory).sort();

  it("writes <directory>/provisioning-limits-smoke-<run id>.json, readable by its owner only, with exactly the evidence", () =>
    inTemp((directory) => {
      const evidence = { runId: RUN, connection_mode: "pooled", final: { outcome: "completed_clean" }, cleanups: [{ sqlState: "57014" }] };
      const saved = writeEvidenceFile({ directory: path.join(directory, "evidence"), runId: RUN, evidence });
      const file = path.join(directory, "evidence", `provisioning-limits-smoke-${RUN}.json`);
      expect(saved).toEqual({ ok: true, file });
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(evidence);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(path.join(directory, "evidence")).mode & 0o077).toBe(0);
    }));

  it("M. an existing evidence file is NEVER overwritten: the write is refused and the file is untouched", () =>
    inTemp((directory) => {
      const file = path.join(directory, `provisioning-limits-smoke-${RUN}.json`);
      writeFileSync(file, "an earlier run's evidence");
      expect(writeEvidenceFile({ directory, runId: RUN, evidence: { runId: RUN } })).toEqual({ ok: false, reason: "already_exists", code: "EEXIST" });
      expect(readFileSync(file, "utf8")).toBe("an earlier run's evidence");
      // A second write by the same run is refused the same way.
      expect(writeEvidenceFile({ directory, runId: OTHER_RUN, evidence: {} }).ok).toBe(true);
      expect(writeEvidenceFile({ directory, runId: OTHER_RUN, evidence: {} })).toMatchObject({ ok: false, reason: "already_exists" });
    }));

  it.each(["", "0a1b2c3", "0A1B2C3D", "../../etc", "0a1b2c3d/..", "0a1b2c3d.json", "..", "0a1b2c3d\u0000", `${RUN}/x`])("the file name is built from a validated run id only — %j is refused and nothing is written anywhere", (runId) =>
    inTemp((directory) => {
      expect(writeEvidenceFile({ directory, runId, evidence: {} })).toEqual({ ok: false, reason: "invalid_run_id", code: null });
      expect(existsSync(path.join(directory, "..", "etc"))).toBe(false);
      expect(statSync(directory).isDirectory()).toBe(true);
      expect(readdirNames(directory)).toEqual([]);
    }));

  it.each<[string, unknown]>([
    ["a connection string", { detail: "could not reach postgresql://app:pw@host/db" }],
    ["an endpoint hostname from a driver error", { detail: "getaddrinfo ENOTFOUND ep-cool-name-000002-pooler.us-east-2.aws.neon.tech" }],
    ["a bare endpoint id", { endpoint: "ep-cool-name-000002" }],
    ["a pooled host label", { host: "something-pooler" }],
    ["a credential-like key", { apiKey: "x" }],
    ["a private key field", { private_key: "x" }],
    ["something not serializable", { toJSON: () => { throw new Error("boom"); } }],
    ["undefined", undefined],
  ])("evidence holding %s is not written (or printed): unsafe_content", (_name, evidence) =>
    inTemp((directory) => {
      expect(safeEvidenceJson(evidence)).toBeNull();
      expect(writeEvidenceFile({ directory, runId: RUN, evidence })).toEqual({ ok: false, reason: "unsafe_content", code: null });
      expect(readdirNames(directory)).toEqual([]);
    }));

  it("the lifecycle's own reports pass the content check — they carry outcomes, counts, run-owned ids, and SQLSTATEs, and no driver text", async () => {
    const w = world();
    await w.ran("one", "a", "b");
    w.ledger.failWhen((_statement, index) => (index === 1 ? { error: Object.assign(new Error("could not reach postgresql://app:secret@ep-x-000001-pooler.neon.tech/neondb"), { code: "08006" }) } : undefined));
    await expect(w.lifecycle.afterCase(OK)).rejects.toThrow();
    const final = await w.finish();
    const json = safeEvidenceJson({ final });
    expect(json).not.toBeNull();
    expect(json).toContain('"sqlState":"08006"');
    expect(json).toContain(ID("a"));
    expect(json).not.toMatch(/secret|neon\.tech|could not reach/);
  });

  it("a write that fails for any other reason is classified, not thrown, and carries no path or message", () =>
    inTemp((directory) => {
      const blocker = path.join(directory, "not-a-directory");
      writeFileSync(blocker, "x");
      const saved = writeEvidenceFile({ directory: path.join(blocker, "evidence"), runId: RUN, evidence: {} });
      expect(saved.ok).toBe(false);
      if (!saved.ok) {
        expect(saved.reason).toBe("write_failed");
        expect(saved.code === null || /^[A-Z0-9_]+$/.test(saved.code)).toBe(true);
        expect(JSON.stringify(saved)).not.toContain(directory);
      }
    }));

  it("N. a clean run whose evidence could not be saved is NOT a pass; a saved file never rescues a run that was not clean", () => {
    const saved = { ok: true as const, file: "evidence/x.json" };
    expect(concludeRun(clean, saved)).toMatchObject({ pass: true, verdict: "clean_and_evidenced" });
    for (const reason of ["already_exists", "write_failed", "unsafe_content", "invalid_run_id"] as const) {
      const verdict = concludeRun(clean, { ok: false, reason, code: null });
      expect(verdict).toMatchObject({ pass: false, verdict: "clean_but_not_evidenced" });
      expect(verdict.message).toMatch(/evidence file was NOT saved.*not an evidenced successful run\. Nothing is retried and the database is not touched again/);
    }
    for (const outcome of ["poisoned_evidence_preserved", "completed_baseline_mismatch", "not_started"] as const) {
      expect(concludeRun({ ...clean, outcome, databaseRestored: false }, saved)).toMatchObject({ pass: false, verdict: "not_clean" });
    }
    expect(concludeRun({ ...clean, databaseRestored: false }, saved).pass).toBe(false);
    // The verdict function only decides: it has no database, registry, or lifecycle to act on.
    const source = readFileSync("test/lib/real/fixtures/provisioning-limits-smoke.ts", "utf8");
    const verdictSource = /export function concludeRun\([\s\S]*?\n\}/.exec(source)?.[0] ?? "";
    expect(verdictSource).not.toMatch(/\.q\(|cleanup|forget|fixtures|lifecycle|await /);
  });
});

// ------------------------------------------------------------------ the same lifecycle under the REAL test runner
type ProbeFlight = { cleanup: string | null; caseBody: string | null; stalled: number };
type ProbeLine = {
  final: FinalReport;
  flags: { bodiesStarted: string[]; lateBodySettled: boolean; lateWrite: string };
  atStart: Array<{ test: string; poisoned: string | null; cleanupInFlight: string | null; stalled: number; statementsSent: number }>;
  baselineRead: boolean;
  poisonedAtEnd: string | null;
  stillInFlightBeforeWaiting: ProbeFlight;
  stillInFlightAtEnd: ProbeFlight;
  statementsSentBeforeWaiting: number;
  settledAfterStall: Array<{ kind: string; param: string }>;
  attempts: string[];
  dispatches: number;
  log: Array<{ kind: string; param: string }>;
  saved: { ok: boolean; reason?: string } | null;
  verdict: { pass: boolean; verdict: string } | null;
};
/** Runs the probe in a child Vitest and reads the report it wrote to a temporary file of its own. */
async function probe(scenario: string, prepare?: (evidenceDirectory: string) => void, inspect?: (evidenceDirectory: string) => void): Promise<{ code: number; output: string; line: ProbeLine }> {
  const dir = mkdtempSync(path.join(tmpdir(), "provisioning-lifecycle-probe-"));
  const reportPath = path.join(dir, "report.json");
  const evidenceDirectory = path.join(dir, "evidence");
  try {
    prepare?.(evidenceDirectory);
    const { code, output } = await runVitest([PROBE], { PROVISIONING_LIFECYCLE_PROBE: scenario, PROVISIONING_LIFECYCLE_PROBE_REPORT: reportPath, ...(prepare ? { PROVISIONING_LIFECYCLE_PROBE_EVIDENCE_DIR: evidenceDirectory } : {}) });
    if (!existsSync(reportPath)) throw new Error(`the lifecycle probe wrote no report for "${scenario}" (exit ${code}): ${output.replace(/\x1b\[[0-9;]*m/g, "").slice(-600)}`);
    expect(output, "no unhandled rejection or error may escape the child run").not.toMatch(/Unhandled (Rejection|Error)/i);
    inspect?.(evidenceDirectory);
    return { code, output, line: JSON.parse(readFileSync(reportPath, "utf8")) as ProbeLine };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const TWO = [ID("two"), ID("two-b")];
const deletesFor = (line: ProbeLine, suffix: string) => line.log.filter((statement) => statement.kind !== "residue" && statement.param === ID(suffix)).length;
const startOf = (line: ProbeLine, test: string) => line.atStart.find((entry) => entry.test.startsWith(test))!;

describe("the lifecycle wired to real Vitest hooks (in-memory ledger, child process — no database of any kind)", () => {
  it("the probe is wired with the SAME two lines as the smoke, and is skipped unless a scenario is named", async () => {
    const smoke = readFileSync(FILE, "utf8");
    const probeSource = readFileSync(PROBE, "utf8");
    for (const line of ["  afterEach((context) => lifecycle.afterCase({ reportedFailed: caseFailedInVitest(context) }), LIVE_TIMEOUT_MS);", "    it(name, () => lifecycle.runCase(name, async () => {"]) {
      expect(smoke, line).toContain(line);
      expect(probeSource, line).toContain(line);
    }
    expect(probeSource).not.toMatch(/handles-smoke-db|neon-store|connectSmoke|process\.env\.(DATABASE_URL|NEON|REAL_)/);
    const { code, output } = await runVitest([PROBE], {});
    expect(code, summary(output)).toBe(0);
    expect(summary(output)).toMatch(/\b4 skipped\b/);
  }, PROCESS_TIMEOUT_MS);

  it("A + L. success: each case starts only after the previous cleanup settled, every fixture is deleted exactly once, the end is clean — and with its evidence saved, the run passes", async () => {
    const { code, line } = await probe("success", () => undefined);
    expect(code).toBe(0);
    expect(line.final).toMatchObject({ outcome: "completed_clean", databaseRestored: true, baselineCompared: true, poisoned: null, executed: ["one", "two", "three"], registryCredentialIds: [] });
    for (const suffix of ["one", "two", "two-b", "three"]) expect(deletesFor(line, suffix), suffix).toBe(2); // its dispatch rows, its attempt — once
    expect(line.final.cleanups.map((entry) => [entry.accepted, entry.summary?.status])).toEqual([[true, "confirmed"], [true, "confirmed"], [true, "confirmed"], [true, "confirmed"]]);
    // When each test began: no cleanup in flight, and the previous cleanup's statements all already sent.
    expect(line.atStart.map((entry) => [entry.cleanupInFlight, entry.stalled, entry.statementsSent])).toEqual([[null, 0, 0], [null, 0, 3], [null, 0, 8], [null, 0, 11]]);
    expect(line.attempts).toEqual([]);
    expect(line.dispatches).toBe(0);
    expect(line.saved).toMatchObject({ ok: true });
    expect(line.verdict).toMatchObject({ pass: true, verdict: "clean_and_evidenced" });
  }, PROCESS_TIMEOUT_MS);

  it("M + N. the same clean run with an evidence file already there: the file is not overwritten, and the run FAILS as clean-but-not-evidenced — with no further ledger activity", async () => {
    const fileIn = (evidenceDirectory: string) => path.join(evidenceDirectory, `provisioning-limits-smoke-${RUN}.json`);
    const { code, line } = await probe(
      "success",
      (evidenceDirectory) => {
        mkdirSync(evidenceDirectory, { recursive: true });
        writeFileSync(fileIn(evidenceDirectory), "an earlier run's evidence");
      },
      (evidenceDirectory) => expect(readFileSync(fileIn(evidenceDirectory), "utf8")).toBe("an earlier run's evidence"),
    );
    expect(code).not.toBe(0);
    expect(line.final.outcome).toBe("completed_clean"); // the lifecycle itself ended clean...
    expect(line.saved).toMatchObject({ ok: false, reason: "already_exists" });
    expect(line.verdict).toMatchObject({ pass: false, verdict: "clean_but_not_evidenced" }); // ...but the run does not pass
    expect(line.log).toHaveLength(12); // exactly the clean run's statements; the evidence failure triggered nothing
  }, PROCESS_TIMEOUT_MS);

  it.each([
    ["an assertion inside the case fails after its fixtures exist", "assert_fail", /^"two" failed$/],
    ["a failure the lifecycle cannot see itself (outside the case body) — the runner's verdict", "outside_failure", /^the test runner reported "two" as failed$/],
  ])("%s: the run FAILS, no cleanup is sent for case two, and case three never starts", async (_name, scenario, poison) => {
    const { code, line } = await probe(scenario);
    expect(code).not.toBe(0);
    expect(line.final).toMatchObject({ outcome: "poisoned_evidence_preserved", databaseRestored: false, baselineCompared: false, notExecuted: expect.arrayContaining(["three"]), registryCredentialIds: TWO });
    expect(line.final.poisoned).toMatch(poison);
    expect(line.final.unconfirmedCleanup.cleanups).toBe(0);
    expect(line.final.action).toMatch(/^The run is poisoned\. No cleanup was started after the failure/);
    expect(line.baselineRead).toBe(false);
    expect(line.flags.bodiesStarted).toEqual(["one", "two"]); // three's body was never entered
    expect(line.attempts).toEqual(TWO);
    expect(line.dispatches).toBe(2);
    expect(deletesFor(line, "one")).toBe(2); // the clean case before it WAS cleaned up
    expect(deletesFor(line, "two") + deletesFor(line, "two-b")).toBe(0);
    expect(line.final.cleanups.map((entry) => entry.skipped === null)).toEqual([true, false, false, false]);
  }, PROCESS_TIMEOUT_MS);

  it.each([
    ["the RUNNER times the test out while its body is still running", "runner_timeout", /^"two" was still running when its cleanup was due/],
    ["the run's own case deadline fires first", "deadline", /^"two" exceeded its 150 ms deadline/],
  ])("%s: afterEach sends nothing, case three never starts, the abandoned body's late write is refused, and the poison outlives its settling", async (_name, scenario, poison) => {
    const { code, line } = await probe(scenario);
    expect(code).not.toBe(0);
    expect(line.final.outcome).toBe("poisoned_evidence_preserved");
    expect(line.final.databaseRestored).toBe(false);
    expect(line.final.poisoned).toMatch(poison);
    expect(line.flags.lateBodySettled).toBe(true); // the body DID carry on after it was abandoned...
    expect(line.flags.lateWrite).toBe("refused"); // ...and was not allowed to write
    expect(line.poisonedAtEnd).toBe(line.final.poisoned); // still poisoned after it settled
    expect(line.flags.bodiesStarted).toEqual(["one", "two"]);
    expect(line.final.executed).toEqual(["one"]);
    expect(line.attempts).toEqual(TWO);
    expect(line.log.filter((statement) => statement.kind !== "residue")).toHaveLength(2); // only case one's two deletes, ever
    expect(line.final.cleanups.map((entry) => entry.skipped === null)).toEqual([true, false, false, false]);
  }, PROCESS_TIMEOUT_MS);

  it.each<[string, string, RegExp, "confirmed" | "refused_by_database"]>([
    ["B + D. a DELETE stalls past the CLEANUP deadline (the hook timeout is far off), then succeeds", "cleanup_stall_deadline", /^the cleanup after "two" exceeded its 150 ms deadline; a statement it already issued may still complete$/, "confirmed"],
    ["C + H + I. a DELETE stalls past the RUNNER's hook timeout (the cleanup deadline is far off), then succeeds", "cleanup_stall_hook", /^the cleanup after "two" was still in flight when "three" was about to start; its statements may still complete$/, "confirmed"],
    ["E. a DELETE stalls past the cleanup deadline, then fails", "cleanup_stall_fail", /^the cleanup after "two" exceeded its 150 ms deadline/, "refused_by_database"],
  ])("%s: case three does no database work, and after the stalled statement settles NOT ONE further statement is sent", async (_name, scenario, poison, lateOutcome) => {
    const { code, line } = await probe(scenario);
    expect(code).not.toBe(0);
    expect(line.final.poisoned).toMatch(poison);
    expect(line.final).toMatchObject({ outcome: "poisoned_evidence_preserved", databaseRestored: false, baselineCompared: false, executed: ["one", "two"], notExecuted: ["three"] });
    // When the runner started test three, the cleanup after two was still in flight with its DELETE unanswered.
    expect(startOf(line, "three")).toMatchObject({ cleanupInFlight: "two", stalled: 1, statementsSent: 4 });
    expect(line.flags.bodiesStarted).toEqual(["one", "two"]); // three refused before its body: no read, no write
    // Still in flight when the suite's tests were over — the marker did not clear at the deadline or the hook timeout...
    expect(line.stillInFlightBeforeWaiting).toEqual({ cleanup: "two", caseBody: null, stalled: 1 });
    // ...and it cleared only once the statement itself settled.
    expect(line.stillInFlightAtEnd).toEqual({ cleanup: null, caseBody: null, stalled: 0 });
    expect(line.settledAfterStall).toEqual([{ kind: "delete_dispatches", param: ID("two") }]);
    // The whole point: nothing was sent after the stalled DELETE — not the next DELETE, not a retry, not a residue read.
    expect(line.statementsSentBeforeWaiting).toBe(4);
    expect(line.log).toHaveLength(4);
    expect(line.log[3]).toEqual({ kind: "delete_dispatches", param: ID("two") });
    expect(deletesFor(line, "two-b")).toBe(0);
    // And the report is truthful about the one statement that was issued.
    expect(line.final.cleanups[1]).toMatchObject({ accepted: false, credentials: [{ credentialId: ID("two"), dispatchRows: lateOutcome, attemptRow: "not_attempted" }, { credentialId: ID("two-b"), dispatchRows: "not_attempted", attemptRow: "not_attempted" }] });
    expect(line.final.unconfirmedCleanup).toMatchObject({ cleanups: 1, confirmed: lateOutcome === "confirmed" ? 1 : 0, refusedByDatabase: lateOutcome === "confirmed" ? 0 : 1, notAttempted: 3, residue: "not_read" });
    expect(line.final.action).toMatch(/^The database state is unknown after this failure\. Some run-owned rows may have been deleted, and some may remain\./);
    expect(line.final.registryCredentialIds).toEqual(TWO);
    expect(line.dispatches).toBe(lateOutcome === "confirmed" ? 1 : 2);
    expect(line.poisonedAtEnd).toBe(line.final.poisoned);
    expect(line.baselineRead).toBe(false);
  }, PROCESS_TIMEOUT_MS);

  it.each<[string, string, RegExp]>([
    ["F. the residue read stalls past the CLEANUP deadline", "residue_stall_deadline", /^the cleanup after "two" exceeded its 150 ms deadline/],
    ["F. the residue read stalls past the RUNNER's hook timeout", "residue_stall_hook", /^the cleanup after "two" was still in flight when "three" was about to start/],
  ])("%s: the registry is not emptied, case three does not start, and the report says the rows WERE deleted rather than retained", async (_name, scenario, poison) => {
    const { code, line } = await probe(scenario);
    expect(code).not.toBe(0);
    expect(line.final.poisoned).toMatch(poison);
    expect(startOf(line, "three")).toMatchObject({ cleanupInFlight: "two", stalled: 1, statementsSent: 8 });
    expect(line.flags.bodiesStarted).toEqual(["one", "two"]);
    expect(line.stillInFlightBeforeWaiting).toEqual({ cleanup: "two", caseBody: null, stalled: 1 });
    expect(line.stillInFlightAtEnd).toEqual({ cleanup: null, caseBody: null, stalled: 0 });
    expect(line.log).toHaveLength(8); // case two's four deletes and the one stalled read; nothing after
    // All four deletes were confirmed, so the rows are gone — but the look never counted, so the registry keeps both ids.
    expect(line.attempts).toEqual([]);
    expect(line.final.registryCredentialIds).toEqual(TWO);
    expect(line.final.cleanups[1]).toMatchObject({ accepted: false, summary: { statements: { total: 4, confirmed: 4 } } });
    expect(line.final.unconfirmedCleanup).toMatchObject({ cleanups: 1, confirmed: 4, notAttempted: 0 });
    expect(line.final.action).toMatch(/^The database state is unknown after this failure\..*confirmed \(those rows ARE deleted\): 4;/);
    expect(line.final.action).not.toMatch(/deleted none|No cleanup was started/);
    expect(line.final).toMatchObject({ outcome: "poisoned_evidence_preserved", databaseRestored: false });
  }, PROCESS_TIMEOUT_MS);
});

// Sequential on purpose: thirteen child Vitest processes at once would starve the rest of an ordinary full run.
describe("the smoke file in a real child process (synthetic values, .invalid hosts)", () => {
  const armed = { [GATE]: "1", NEON_BRANCH_DATABASE_URL: SYNTHETIC_POOLED_URL, NEON_BRANCH_EXPECTED_ENDPOINT_ID: SYNTHETIC_ENDPOINT };
  /** Every live case is reported; none passed. */
  const expectNothingLiveRan = (output: string) => {
    expect(output).toMatch(/Test Files\s+1 failed/);
    expect(output).not.toMatch(/Test Files\s+\d+ passed/);
    expect(output).not.toMatch(CONNECTION_ATTEMPT);
    expect(output).not.toContain("synthetic");
    expect(output).not.toMatch(NOTHING_REPORTED); // neither line is printed before a connection is about to be made
  };

  it("no gate: every live case is skipped and the run is green — whatever else is exported", async () => {
    const { code, output } = await runVitest([FILE], { DATABASE_URL: SYNTHETIC_URL, NEON_BRANCH_DATABASE_URL: SYNTHETIC_URL, NEON_BRANCH_EXPECTED_ENDPOINT_ID: SYNTHETIC_ENDPOINT, REAL_SMOKE_PROVISIONING_DISPATCH: "1" });
    expect(code, summary(output)).toBe(0);
    expect(summary(output)).toMatch(/\b11 skipped\b/); // the ten cases and the completeness check
    expect(output).not.toMatch(REFUSAL);
    expect(output).not.toMatch(CONNECTION_ATTEMPT);
  }, PROCESS_TIMEOUT_MS);

  it.each<[string, Record<string, string>, RegExp]>([
    ["the gate alone (no target)", { [GATE]: "1" }, /NEON_BRANCH_DATABASE_URL is missing or not a URL/],
    ["no operator confirmation of the endpoint", { [GATE]: "1", NEON_BRANCH_DATABASE_URL: SYNTHETIC_URL }, REFUSAL],
    ["DATABASE_URL exported beside a full target", { ...armed, DATABASE_URL: SYNTHETIC_URL }, /DATABASE_URL is exported/],
    ["DATABASE_URL as the only URL (no fallback)", { [GATE]: "1", NEON_BRANCH_EXPECTED_ENDPOINT_ID: SYNTHETIC_ENDPOINT, DATABASE_URL: SYNTHETIC_URL }, /DATABASE_URL is exported/],
    ["the adapter smoke's gate beside it", { ...armed, REAL_SMOKE_NEON_ADAPTER: "1" }, /an unrelated smoke gate is set/],
    ["the adapter smoke's dispatch sub-gate beside it", { ...armed, REAL_SMOKE_PROVISIONING_DISPATCH: "1" }, /an unrelated smoke gate is set/],
    ["an admin gate beside it", { ...armed, REAL_ADMIN_POLL_PROVISIONING_ACTIVITY: "1" }, /an admin gate is set/],
    ["an endpoint id that does not match the URL", { ...armed, NEON_BRANCH_EXPECTED_ENDPOINT_ID: "ep-other-000008" }, REFUSAL],
    ["a routing override in the URL", { ...armed, NEON_BRANCH_DATABASE_URL: `${SYNTHETIC_POOLED_URL}?options=endpoint%3Dep-real` }, /unsupported or repeated connection parameter/],
  ])("gate set, %s -> the run FAILS, refused before any connection", async (_name, env, reason) => {
    const { code, output } = await runVitest([FILE], env);
    expect(code, summary(output)).not.toBe(0);
    expect(output).toMatch(REFUSAL);
    expect(output).toMatch(reason);
    expectNothingLiveRan(output);
  }, PROCESS_TIMEOUT_MS);

  it("fully armed and exactly selected, but with the branch's DIRECT connection string -> refused before any connection, with no URL in the message", async () => {
    const { code, output } = await runVitest([FILE], { ...armed, NEON_BRANCH_DATABASE_URL: SYNTHETIC_URL });
    expect(code, summary(output)).not.toBe(0);
    expect(output).toMatch(REFUSAL);
    // With a readable .env.local the target check passes and the pooled-mode rule is what refuses; without one the target check refuses first.
    if (existsSync(".env.local") && !/refused to connect: /.test(output)) expect(output).toMatch(/refused before any database work: this run requires the disposable branch's POOLED connection string/);
    expect(output).not.toMatch(NOTHING_REPORTED); // the label is printed only for an accepted target
    expectNothingLiveRan(output);
  }, PROCESS_TIMEOUT_MS);

  it.each<[string, string[]]>([
    ["a second test file selected beside it", [FILE, "test/lib/real/neon-smoke-fixture-ids.test.ts"]],
    ["a test-name filter", [FILE, "-t", "A. six"]],
    ["a directory instead of the file", ["test/lib/real/provisioning-limits.smoke"]],
  ])("fully armed but not run as the one exact file (%s) -> refused before any connection", async (_name, args) => {
    const { code, output } = await runVitest(args, armed);
    expect(code, summary(output)).not.toBe(0);
    expect(output).toMatch(REFUSAL);
    // With a readable .env.local the target check passes and the selection check is what refuses; without one the target check refuses first. Either way nothing connects.
    if (existsSync(".env.local") && !/refused to connect: /.test(output)) expect(output).toMatch(/refused before any database work: (it must be the ONE test file selected|only --testTimeout)/);
    expect(output).not.toMatch(CONNECTION_ATTEMPT);
    expect(output).not.toContain("synthetic");
    expect(output).not.toMatch(NOTHING_REPORTED);
  }, PROCESS_TIMEOUT_MS);
});
