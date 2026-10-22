// @vitest-environment node
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_CONFIGURABLE_SCRATCH_SCHEMAS, MAX_RUN_SCRATCH_OBJECTS, MAX_RUN_SCRATCH_SCHEMAS, SCHEMA_EXTERNAL_DEPENDENCIES_SQL, SCHEMA_INVENTORY_SQL, SCHEMA_RESIDUE_SQL, createRunOwnership, resolveScratchSchemaCapacity, type DatabaseSnapshot } from "./fixtures/provider-budget-smoke";
import {
  APPLY_PLAN,
  BOOLEAN_PROBE_SQL,
  CAN_SEE_ACTIVITY_SQL,
  CEILINGS,
  CLOCK_BATCH,
  CONFIRM_ENV,
  GROUP_A1,
  GROUP_A2,
  GROUP_B,
  MARKER_DELETE_CHUNK,
  NONCE_REGISTRY_CAP,
  RACE_EXPIRY_OFFSET_MS,
  RACE_HOLDER_SLEEP_SECONDS,
  RACE_MIN_RELEASE_MARGIN_MS,
  REGISTRATION_ORDER,
  SCRATCH_SCHEMA_REGISTRY_CAPACITY,
  checkRaceScript,
  checkScratchCapacity,
  createCleanupMeter,
  createLoginChallengeUsesOwnership,
  createMeteredCleanupGate,
  extractNeonClientSource,
  holderDeleteAndCommitTimed,
  parseTimedHolderResult,
  raceTimingConsistent,
  raceTimingEvidence,
  registerPlan,
  COUNT_MARKERS_SQL,
  COUNT_OWNED_PRESENT_SQL,
  DB_CLOCK_SQL,
  DELETE_OWNED_MARKERS_SQL,
  EARLIER_MIGRATION_IDENTITIES,
  EXPECTED_ENDPOINT_ENV,
  EXPECTED_MARKER_TABLE,
  FINAL_EVIDENCE_FIELDS,
  HOLDER_ACTIVE_SQL,
  INSERT_AGED_MARKERS_SQL,
  INSERT_MARKER_SQL,
  KNOWN_SPENT_RUN_IDS,
  LIST_OWNED_PRESENT_SQL,
  LOGIN_CHALLENGE_USES_SMOKE_FILE,
  MARKER_SQL_REFERENCE,
  MARKER_SQL_REFERENCE_SHA256,
  MARKER_SQL_REFERENCE_TEMPLATE,
  MARKER_WAITERS_SQL,
  MIGRATION_IDENTITY,
  READ_MARKER_SQL,
  RUN_ID_ENV,
  SHARED_HELPER_FILES,
  START_EVIDENCE_FIELDS,
  TARGET_PROOF_STATUS,
  analyseVariant,
  captureProductionMarkerSql,
  checkLoginChallengeUsesFileSelection,
  checkMigrationIdentities,
  checkProductionMarkerSql,
  checkRunAuthorization,
  classifyMarker,
  compareWithExpectedMarkerDelta,
  computeSourceIdentity,
  concludeLoginChallengeUsesRun,
  createLoginChallengeUsesLifecycle,
  createNonceRegistry,
  expectedConfirmation,
  extractMigrationBlock,
  findPackedRef,
  holderDeleteAndCommit,
  holderInsertAndRollback,
  holderRowLocks,
  holderTableGate,
  markerSqlForSchema,
  missingEvidenceFields,
  parseGitHead,
  planBudget,
  scratchInsertSql,
  scratchRowsSql,
  tallyOutcomes,
  unsafeCandidateSql,
  writeLoginChallengeUsesEvidence,
  type DeltaVerdict,
  type EvidenceResult,
  type FinalReport,
  type ScenarioPlan,
  type SharedHelperName,
} from "./fixtures/login-challenge-uses-smoke";

/**
 * Offline proof of the PURE parts of the future login-challenge-uses smoke (Milestone 3C-2): its identity pins, its run
 * authorization, its budgets, its nonce registry, its fixture statements and holders, its outcome classification, its run
 * lifecycle, its cleanup, its expected-delta comparison, its evidence writer, and the static shape of the live file.
 * Nothing here connects to anything or executes SQL; every "database" is a function in this file, and the child-process gate
 * tests use synthetic `.invalid` hosts only and are refused before any connection.
 */
const RUN = "0a1b2c3d";
const SCHEMA_PATH = "lib/real/server/schema.sql";
const SMOKE = LOGIN_CHALLENGE_USES_SMOKE_FILE;
const FIXTURE = "test/lib/real/fixtures/login-challenge-uses-smoke.ts";
const schemaText = readFileSync(SCHEMA_PATH, "utf8");
const readSharedHelpers = (): Record<SharedHelperName, string> => Object.fromEntries(Object.entries(SHARED_HELPER_FILES).map(([name, file]) => [name, readFileSync(file, "utf8")])) as Record<SharedHelperName, string>;

// ------------------------------------------------------------------ migration identity

describe("the migration identities are pinned, and anything else refuses the run before any database work", () => {
  it("the real schema.sql has exactly the audited statements", () => {
    expect(checkMigrationIdentities(schemaText)).toEqual({ ok: true });
    const block = extractMigrationBlock(schemaText, "Login Challenge Uses");
    expect(block.length).toBe(15_070);
    expect(block.sha256).toBe("00ff39691a33436ce75d2ff33534983bd408c95574ee4ad8ad9ff6bcdcbf1d1e");
    expect(MIGRATION_IDENTITY).toEqual({ name: "Login Challenge Uses", length: 15_070, sha256: "00ff39691a33436ce75d2ff33534983bd408c95574ee4ad8ad9ff6bcdcbf1d1e" });
    expect(EARLIER_MIGRATION_IDENTITIES.map((entry) => [entry.name, entry.length, entry.sha256])).toEqual([
      ["Registration Admission", 13_101, "b269ebcc0953efce79c7504ec451237eca3dc1bc4d67996d7179b5eba26ac91f"],
      ["Handle Pay Rate Limits", 11_680, "78c5557d5b615805f0eb8c63e62d09eccffc792c95f9e2782f9af48d92d1513d"],
      ["Provider Budgets", 11_820, "8213b46c2f859fb3c8c5457d34d3dff682508d401fcf82b9169b84333c67a5f5"],
    ]);
    expect(block.statement.startsWith("DO $$")).toBe(true);
    expect(block.statement.endsWith("END $$;")).toBe(true);
    expect(block.statement.match(/DO \$\$/g)).toHaveLength(1);
    expect(block.statement.match(/'public'/g)).toHaveLength(1);
  });

  it("a one-character change to the new block, to any earlier block, a missing or duplicated block, or a moved block is refused", () => {
    const block = extractMigrationBlock(schemaText, "Login Challenge Uses").statement;
    const mutate = (text: string, find: string, replace: string) => {
      expect(text.split(find).length, find).toBeGreaterThan(1);
      return text.replace(find, replace);
    };
    expect(checkMigrationIdentities(schemaText.replace(block, block.replace("octet_length(nonce) = 16", "octet_length(nonce) = 15"))).ok).toBe(false);
    expect(checkMigrationIdentities(schemaText.replace(block, `${block} `)).ok).toBe(false);
    for (const earlier of EARLIER_MIGRATION_IDENTITIES) {
      const statement = extractMigrationBlock(schemaText, earlier.name).statement;
      const changed = checkMigrationIdentities(schemaText.replace(statement, statement.replace("DECLARE", "DECLARE ")));
      expect(changed.ok, earlier.name).toBe(false);
    }
    expect(checkMigrationIdentities(mutate(schemaText, "-- BEGIN Login Challenge Uses", "-- BEGIN Login Challenge Uses\n-- BEGIN Login Challenge Uses")).ok).toBe(false);
    expect(checkMigrationIdentities("").ok).toBe(false);
    expect(() => extractMigrationBlock(schemaText, "No Such Block")).toThrow(/not found exactly once/);
    // The Provisioning Evidence block must still follow the new block.
    const provisioning = "-- BEGIN Provisioning Evidence Capture";
    const moved = schemaText.replace(provisioning, "-- BEGIN Provisioning Evidence Capture (moved)").replace("-- BEGIN Login Challenge Uses", `${provisioning}\n-- BEGIN Login Challenge Uses`);
    expect(checkMigrationIdentities(moved).ok).toBe(false);
  });
});

// ------------------------------------------------------------------ the production marker statement

describe("the production marker statement is the pinned reference, and a scratch copy differs from it only in its table qualification", () => {
  it("the reference is independently written; the adapter's captured statement equals it; their digest is pinned", async () => {
    const captured = await captureProductionMarkerSql();
    expect(captured.template).toBe(MARKER_SQL_REFERENCE_TEMPLATE);
    expect(MARKER_SQL_REFERENCE_SHA256).toBe(MARKER_SQL_REFERENCE_SHA256.toLowerCase());
    expect(captured.values).toEqual(["0".repeat(32), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]);
    expect(checkProductionMarkerSql(captured)).toEqual({ ok: true });
    // The numbered form (for db.q) has exactly the four parameters, and no tagged-template residue.
    expect(captured.numbered.match(/\$[0-9]+/g)).toEqual(["$1", "$2", "$3", "$4"]);
    expect(captured.numbered.trimStart().startsWith("WITH purged AS (")).toBe(true);
    expect(MARKER_SQL_REFERENCE.match(/\$[0-9]+/g)).toEqual(["$1", "$2", "$2", "$2"]); // the hand-written reference names the expiration once per use
    // The reference, the adapter, and the waiter poll agree on the leading text the poll relies on.
    expect(new RegExp("^\\s*WITH purged AS").test(captured.numbered)).toBe(true);
    expect(MARKER_WAITERS_SQL).toContain("'^\\s*WITH purged AS'");
  });

  it("every mutation of the production statement is refused, one defect at a time", async () => {
    const captured = await captureProductionMarkerSql();
    const mutations: Array<[string, string, string]> = [
      ["a shorter retention margin", "interval '1 hour'", "interval '1 minute'"],
      ["a purge by now()", "p.expires_at < now() - interval", "p.expires_at < clock_timestamp() - interval"],
      ["a bigger purge", "LIMIT 64", "LIMIT 640"],
      ["no SKIP LOCKED", "FOR UPDATE SKIP LOCKED", "FOR UPDATE"],
      ["not oldest first", "ORDER BY p.expires_at", "ORDER BY p.nonce"],
      ["a pre-filter on now()", "> clock_timestamp()\n", "> now()\n"],
      ["a looser upper bound", "interval '10 minutes'", "interval '1 hour'"],
      ["an update on conflict", "DO NOTHING", "DO UPDATE SET used_at = u.used_at"],
      ["no post-insert check", "RETURNING (u.expires_at > clock_timestamp()) AS live", "RETURNING true AS live"],
      ["a post-insert check on now()", "(u.expires_at > clock_timestamp())", "(u.expires_at > now())"],
      ["a different conflict target", "ON CONFLICT (nonce)", "ON CONFLICT (expires_at)"],
      ["no purge", "WITH purged AS (", "WITH purged AS (SELECT 1) , unused AS ("],
    ];
    for (const [name, find, replace] of mutations) {
      const normalizedFind = find.replace(/\s+/g, " ").trim();
      expect(captured.template.includes(normalizedFind) || MARKER_SQL_REFERENCE_TEMPLATE.includes(normalizedFind), name).toBe(true);
      const mutated = { ...captured, template: captured.template.replace(normalizedFind, replace.replace(/\s+/g, " ").trim()) };
      expect(mutated.template, name).not.toBe(captured.template);
      expect(checkProductionMarkerSql(mutated).ok, name).toBe(false);
    }
    expect(checkProductionMarkerSql({ ...captured, values: captured.values.slice(0, 3) }).ok).toBe(false);
    expect(checkProductionMarkerSql({ ...captured, values: ["x", ...captured.values.slice(1)] }).ok).toBe(false);
    expect(checkProductionMarkerSql({ ...captured, values: [captured.values[0], captured.values[1], "other", captured.values[3]] }).ok).toBe(false);
    expect(checkProductionMarkerSql({ ...captured, template: `${captured.template} ` }).ok).toBe(false); // the comparison is exact: not even a trailing space is tolerated
  });

  it("the scratch copy qualifies exactly the three table names with an owned schema, and nothing else changes", async () => {
    const captured = await captureProductionMarkerSql();
    const ownership = createRunOwnership(RUN);
    const schema = ownership.registerScratchSchema("nokey");
    const scratch = markerSqlForSchema(captured.numbered, ownership, schema);
    expect(scratch.split(`${schema}.real_login_challenge_uses`)).toHaveLength(4);
    expect(scratch.replaceAll(`${schema}.real_login_challenge_uses`, "real_login_challenge_uses")).toBe(captured.numbered);
    // Only a schema this run registered; never public; never an unregistered name; never a text that does not name the table three times.
    expect(() => markerSqlForSchema(captured.numbered, ownership, "public")).toThrow(/does not own/);
    expect(() => markerSqlForSchema(captured.numbered, ownership, `pb_smoke_${RUN}_other`)).toThrow(/does not own/);
    expect(() => markerSqlForSchema(captured.numbered.replace("FROM real_login_challenge_uses p", "FROM x p"), ownership, schema)).toThrow(/exactly three times/);
    expect(() => markerSqlForSchema(`${captured.numbered} real_login_challenge_uses`, ownership, schema)).toThrow(/exactly three times/);
  });

  it("the original unsafe candidate is available only for an owned scratch schema, and really is the stale-clock variant", () => {
    const ownership = createRunOwnership(RUN);
    const schema = ownership.registerScratchSchema("contrast");
    const sql = unsafeCandidateSql(ownership, schema);
    expect(sql).toContain("d.expires_at < now()");
    expect(sql).toContain("$2::timestamptz > now()");
    expect(sql).not.toContain("clock_timestamp() +");
    expect(sql).toContain("RETURNING true AS live");
    expect(sql).not.toContain("public.");
    expect(sql.split(`${schema}.real_login_challenge_uses`)).toHaveLength(3);
    expect(() => unsafeCandidateSql(ownership, "public")).toThrow(/does not own/);
    expect(() => unsafeCandidateSql(ownership, `pb_smoke_${RUN}_unregistered`)).toThrow(/does not own/);
    expect(sql).not.toBe(MARKER_SQL_REFERENCE);
  });
});

// ------------------------------------------------------------------ run authorization and source identity

describe("the operator's separate, source-bound confirmation is required, and nothing bypasses it", () => {
  const sources = () => ({
    schemaText,
    neonStoreText: readFileSync("lib/real/server/neon-store.ts", "utf8"),
    loginChallengeText: readFileSync("lib/real/server/login-challenge.ts", "utf8"),
    loginChallengeUsesText: readFileSync("lib/real/server/login-challenge-uses.ts", "utf8"),
    harnessSmokeText: readFileSync(SMOKE, "utf8"),
    harnessFixtureText: readFileSync(FIXTURE, "utf8"),
    sharedHelpers: readSharedHelpers(),
  });

  it("the source identity covers the migration, the marker statement, the adapter's source, and both production modules", () => {
    const identity = computeSourceIdentity(sources());
    expect(Object.keys(identity.parts)).toEqual(["migration", "markerSqlReference", "adapterSource", "neonClientSource", "loginChallengeModule", "loginChallengeUsesModule", "harnessSmoke", "harnessFixture", "providerBudgetSmoke", "registrationAdmissionSmoke", "provisioningLimitsSmoke", "handlesSmokeDb", "smokeRunIds"]);
    expect(identity.parts.migration).toBe(MIGRATION_IDENTITY.sha256);
    expect(identity.parts.markerSqlReference).toBe(MARKER_SQL_REFERENCE_SHA256);
    expect(identity.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.shortDigest).toBe(identity.digest.slice(0, 16));
    // Any change to any one input changes the digest (so a stale confirmation can never authorize different code).
    const base = sources();
    for (const key of ["schemaText", "neonStoreText", "loginChallengeText", "loginChallengeUsesText", "harnessSmokeText", "harnessFixtureText"] as const) {
      const changed = key === "schemaText" ? { ...base, [key]: base[key].replace("octet_length(nonce) = 16", "octet_length(nonce) = 16 ") } : key === "neonStoreText" ? { ...base, [key]: base[key].replace("DO NOTHING\n        RETURNING (u.expires_at", "DO NOTHING\n        RETURNING  (u.expires_at") } : { ...base, [key]: `${base[key]}\n` };
      expect(computeSourceIdentity(changed).digest, key).not.toBe(identity.digest);
    }
    expect(() => computeSourceIdentity({ ...base, neonStoreText: "" })).toThrow(/adapter function was not found/);
  });

  it("the run authorization needs a well-formed, unspent run id, an endpoint, a confirmation bound to code + endpoint + run, and no existing evidence", () => {
    const identity = computeSourceIdentity(sources());
    const endpoint = "ep-synthetic-000009";
    const good = { [RUN_ID_ENV]: "1a2b3c4d", [EXPECTED_ENDPOINT_ENV]: endpoint, [CONFIRM_ENV]: expectedConfirmation(identity, "1a2b3c4d", endpoint) };
    const check = (env: Record<string, string | undefined>, fileExists: (file: string) => boolean = () => false) => checkRunAuthorization({ env, identity, evidenceDirectory: "evidence", fileExists });
    expect(good[CONFIRM_ENV]).toMatch(/^1a2b3c4d:[0-9a-f]{16}$/);
    expect(check(good)).toEqual({ ok: true, runId: "1a2b3c4d" });
    const refusals: Array<[string, Record<string, string | undefined>, RegExp]> = [
      ["no run id", { [EXPECTED_ENDPOINT_ENV]: endpoint, [CONFIRM_ENV]: good[CONFIRM_ENV] }, /is not set/],
      ["an empty run id", { ...good, [RUN_ID_ENV]: "" }, /is not set/],
      ["a short run id", { ...good, [RUN_ID_ENV]: "1a2b3c" }, /8 lowercase hex/],
      ["an upper-case run id", { ...good, [RUN_ID_ENV]: "1A2B3C4D" }, /8 lowercase hex/],
      ["a non-hex run id", { ...good, [RUN_ID_ENV]: "1a2b3c4g" }, /8 lowercase hex/],
      ["no endpoint", { ...good, [EXPECTED_ENDPOINT_ENV]: undefined }, /well-formed endpoint id/],
      ["a malformed endpoint", { ...good, [EXPECTED_ENDPOINT_ENV]: "ep_synthetic" }, /well-formed endpoint id/],
      ["a pooled hostname instead of the endpoint id", { ...good, [EXPECTED_ENDPOINT_ENV]: "ep-synthetic-000009-pooler.c-1.neon.invalid" }, /well-formed endpoint id/],
      ["no confirmation", { [RUN_ID_ENV]: "1a2b3c4d", [EXPECTED_ENDPOINT_ENV]: endpoint }, /is not set/],
      ["an empty confirmation", { ...good, [CONFIRM_ENV]: "" }, /is not set/],
      ["a confirmation for another run id", { ...good, [CONFIRM_ENV]: expectedConfirmation(identity, "1a2b3c4e", endpoint) }, /does not match/],
      ["a confirmation for ANOTHER ENDPOINT (a different branch)", { ...good, [CONFIRM_ENV]: expectedConfirmation(identity, "1a2b3c4d", "ep-synthetic-000010") }, /does not match/],
      ["a confirmation for other code", { ...good, [CONFIRM_ENV]: expectedConfirmation({ ...identity, digest: "f".repeat(64) }, "1a2b3c4d", endpoint) }, /does not match/],
      ["a confirmation naming the run id with a zero token", { ...good, [CONFIRM_ENV]: `1a2b3c4d:${"0".repeat(16)}` }, /does not match/],
      ["a bare run id as the confirmation", { ...good, [CONFIRM_ENV]: "1a2b3c4d" }, /does not match/],
      ["the short source digest alone", { ...good, [CONFIRM_ENV]: `1a2b3c4d:${identity.shortDigest}` }, /does not match/],
      ["the full digest", { ...good, [CONFIRM_ENV]: `1a2b3c4d:${identity.digest}` }, /does not match/],
    ];
    for (const [name, env, reason] of refusals) {
      const verdict = check(env);
      expect(verdict.ok, name).toBe(false);
      if (!verdict.ok) expect(verdict.reason, name).toMatch(reason);
    }
    for (const spent of KNOWN_SPENT_RUN_IDS) {
      const verdict = check({ [RUN_ID_ENV]: spent, [EXPECTED_ENDPOINT_ENV]: endpoint, [CONFIRM_ENV]: expectedConfirmation(identity, spent, endpoint) });
      expect(verdict.ok, spent).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/already spent/);
    }
    expect([...KNOWN_SPENT_RUN_IDS].sort()).toEqual(["6d32fdf8", "a630d8ff", "c20ffc87", "ced714ee"]);
    for (const stage of ["start", "final"]) {
      const seen: string[] = [];
      const verdict = check(good, (file) => (seen.push(file), file.endsWith(`-1a2b3c4d-${stage}.json`)));
      expect(verdict.ok, stage).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/evidence already exists/);
      expect(seen.every((file) => file.startsWith("evidence/login-challenge-uses-smoke-1a2b3c4d-"))).toBe(true);
    }
    // The verdict never echoes the value it refused.
    const wrong = check({ ...good, [CONFIRM_ENV]: "super-wrong-value" });
    expect(JSON.stringify(wrong)).not.toContain("super-wrong-value");
    // The confirmation function itself refuses malformed inputs.
    expect(() => expectedConfirmation(identity, "short", endpoint)).toThrow(/well-formed/);
    expect(() => expectedConfirmation(identity, "1a2b3c4d", "not-an-endpoint")).toThrow(/well-formed/);
    // A changed run id or endpoint changes the token (it is bound to both).
    expect(expectedConfirmation(identity, "1a2b3c4d", endpoint).split(":")[1]).not.toBe(expectedConfirmation(identity, "1a2b3c4e", endpoint).split(":")[1]);
    expect(expectedConfirmation(identity, "1a2b3c4d", endpoint).split(":")[1]).not.toBe(expectedConfirmation(identity, "1a2b3c4d", "ep-synthetic-000010").split(":")[1]);
  });

  it("the repository state is recorded, never pinned: a branch and a 40-hex commit are required, and a detached or unreadable HEAD is refused", () => {
    const commit = "46d1cc29c2f484b6572ff9461fb02190dd134372";
    expect(parseGitHead("ref: refs/heads/main\n", () => `${commit}\n`)).toEqual({ ok: true, branch: "main", commit });
    expect(parseGitHead("ref: refs/heads/feature/x-1.2", () => commit)).toEqual({ ok: true, branch: "feature/x-1.2", commit });
    for (const [name, head, ref] of [
      ["a detached HEAD", `${commit}\n`, commit],
      ["an empty HEAD", "", commit],
      ["a non-branch ref", "ref: refs/tags/v1\n", commit],
      ["a branch with no commit", "ref: refs/heads/main\n", null],
      ["a short commit", "ref: refs/heads/main\n", "abc1234"],
      ["an upper-case commit", "ref: refs/heads/main\n", commit.toUpperCase()],
      ["a ref with a space", "ref: refs/heads/ma in\n", commit],
      ["extra lines", "ref: refs/heads/main\nother\n", commit],
    ] as const) expect(parseGitHead(head, () => ref).ok, name).toBe(false);
    expect(findPackedRef(`# pack-refs\n${commit} refs/heads/main\n${"b".repeat(40)} refs/heads/other\n`, "refs/heads/main")).toBe(commit);
    expect(findPackedRef(`${commit} refs/heads/main\n`, "refs/heads/missing")).toBeNull();
    expect(findPackedRef("", "refs/heads/main")).toBeNull();
    // The real repository is readable the way the live file reads it.
    expect(parseGitHead(readFileSync(".git/HEAD", "utf8"), (ref) => { try { return readFileSync(`.git/${ref}`, "utf8"); } catch { return findPackedRef(readFileSync(".git/packed-refs", "utf8"), ref); } }).ok).toBe(true);
  });

  // OFFLINE operator aid: prints the exact confirmation string for one run id and endpoint. It connects to nothing and writes nothing.
  it.skipIf(process.env.LOGIN_CHALLENGE_SMOKE_PRINT_CONFIRMATION !== "1")("prints the confirmation string for the run id and endpoint given in the environment (offline; no database)", () => {
    const runId = process.env[RUN_ID_ENV] ?? "";
    const endpoint = process.env[EXPECTED_ENDPOINT_ENV] ?? "";
    expect((KNOWN_SPENT_RUN_IDS as readonly string[]).includes(runId)).toBe(false);
    const identity = computeSourceIdentity(sources());
    process.stderr.write(`LOGIN_CHALLENGE_SMOKE_CONFIRM=${expectedConfirmation(identity, runId, endpoint)}\nsource digest: ${identity.digest}\n`);
  });

  it("the run id and confirmation variable names cannot be mistaken for another smoke's gate", () => {
    expect(RUN_ID_ENV.startsWith("REAL_SMOKE_")).toBe(false);
    expect(CONFIRM_ENV.startsWith("REAL_SMOKE_")).toBe(false);
  });
});

// ------------------------------------------------------------------ budgets

describe("the budgets are computed from the scenario inventory and refused when over a ceiling", () => {
  const scenario = (overrides: Partial<ScenarioPlan> = {}): ScenarioPlan => ({ name: "one", operations: 10, fixtureStatements: 1, fixtureRows: 1, polls: 1, concurrent: 1, scratchSchemas: 1, ...overrides });
  it("an in-budget inventory passes, and totals are the sums (concurrency is the largest)", () => {
    const verdict = planBudget([scenario({ name: "a", concurrent: 5 }), scenario({ name: "b", concurrent: 62, scratchSchemas: 2 })]);
    expect(verdict.ok).toBe(true);
    expect(verdict.totals).toEqual({ operations: 20, fixtureStatements: 2, fixtureRows: 2, polls: 2, concurrent: 62, scratchSchemas: 3, cleanupOperations: 23 });
  });

  it("each ceiling refuses on its own", () => {
    const over: Array<[string, Partial<ScenarioPlan>, RegExp]> = [
      ["operations", { operations: CEILINGS.operations + 1 }, /planned operations/],
      ["concurrency", { concurrent: CEILINGS.concurrent + 1 }, /planned concurrency/],
      ["fixture statements", { fixtureStatements: CEILINGS.fixtureStatements + 1 }, /fixture statements/],
      ["fixture rows", { fixtureRows: CEILINGS.fixtureRows + 1 }, /fixture rows/],
      ["scratch schemas", { scratchSchemas: CEILINGS.scratchSchemas + 1 }, /scratch schemas/],
      ["polls", { polls: CEILINGS.polls + 1 }, /planned polls/],
    ];
    for (const [name, change, reason] of over) {
      const verdict = planBudget([scenario(change)]);
      expect(verdict.ok, name).toBe(false);
      expect(verdict.violations.join(" "), name).toMatch(reason);
    }
    // Cleanup alone can exceed its ceiling.
    expect(planBudget([scenario({ scratchSchemas: 60 })], { ...CEILINGS, cleanupOperations: 100 }).violations.join(" ")).toMatch(/cleanup operations/);
  });

  it("malformed plans and ceilings are refused, never normalized", () => {
    expect(planBudget([scenario({ operations: -1 })]).ok).toBe(false);
    expect(planBudget([scenario({ operations: 1.5 })]).ok).toBe(false);
    expect(planBudget([scenario({ polls: Number.NaN })]).ok).toBe(false);
    expect(planBudget([scenario(), scenario()]).ok).toBe(false); // a duplicate name
    expect(planBudget([scenario({ name: "" })]).ok).toBe(false);
    expect(planBudget([scenario()], { ...CEILINGS, operations: 0 }).ok).toBe(false);
  });

  it("the ceilings are the documented ones", () => {
    expect(CEILINGS).toMatchObject({ operations: 2000, concurrent: 64, fixtureStatements: 90, fixtureRows: 700, scratchSchemas: 60, polls: 400, caseDeadlineMs: 90_000, runDeadlineMs: 900_000, cleanupOperations: 340 });
    // L-1: no per-operation timeout exists, so none is declared (a declared-but-unenforced limit would be misleading).
    expect(CEILINGS).not.toHaveProperty("operationTimeoutMs");
    expect(Object.keys(CEILINGS).sort()).toEqual(["caseDeadlineMs", "cleanupOperations", "concurrent", "fixtureRows", "fixtureStatements", "operations", "polls", "runDeadlineMs", "scratchSchemas"]);
  });
});

// ------------------------------------------------------------------ nonces and fixture statements

describe("every marker the run writes is a nonce it minted, and every fixture statement is pinned", () => {
  it("the registry mints 32-hex nonces that start with the run id, once per label, up to a cap, and refuses what it does not own", () => {
    const nonces = createNonceRegistry(RUN, 5);
    const one = nonces.register("first-label");
    expect(one).toMatch(/^0a1b2c3d[0-9a-f]{24}$/);
    expect(nonces.register("first-label-2")).not.toBe(one);
    expect(() => nonces.register("first-label")).toThrow(/used twice/);
    expect(nonces.registerMany("many", 2)).toHaveLength(2);
    expect(nonces.assertOwned(one)).toBe(one);
    expect(() => nonces.assertOwned("0a1b2c3d" + "f".repeat(24))).toThrow(/does not own/);
    expect(() => nonces.assertOwned("f".repeat(32))).toThrow(/does not own/);
    expect(() => nonces.assertOwned(one.toUpperCase())).toThrow(/does not own/);
    expect(() => nonces.assertOwned("xyz")).toThrow(/does not own/);
    expect(nonces.register("fifth")).toBeTruthy();
    expect(() => nonces.register("sixth")).toThrow(/nonce limit/);
    expect(nonces.count()).toBe(5);
    expect(nonces.owned()).toHaveLength(5);
    for (const label of ["", "Upper", "has space", "a_b", "-lead", "trail-", "double--hyphen", "x".repeat(61)]) expect(() => createNonceRegistry(RUN).register(label), label).toThrow(/label/);
    expect(() => createNonceRegistry("0A1B2C3D")).toThrow(/8 lowercase hex/);
    expect(() => createNonceRegistry(RUN).registerMany("x", 0)).toThrow(/bad nonce count/);
  });

  it("a different run id mints different nonces for the same labels, and none starts with another run's id", () => {
    const a = createNonceRegistry("0a1b2c3d").register("same");
    const b = createNonceRegistry("1a2b3c4d").register("same");
    expect(a).not.toBe(b);
    expect(a.startsWith("0a1b2c3d")).toBe(true);
    expect(b.startsWith("1a2b3c4d")).toBe(true);
  });

  it("the fixture statements are exactly these, and touch only the marker table", () => {
    expect(INSERT_MARKER_SQL).toBe("INSERT INTO public.real_login_challenge_uses (nonce, expires_at, used_at) VALUES (decode($1::text, 'hex'), $2::timestamptz, $3::timestamptz)");
    expect(INSERT_AGED_MARKERS_SQL).toBe("INSERT INTO public.real_login_challenge_uses (nonce, expires_at, used_at) SELECT decode(u.x, 'hex'), now() - make_interval(secs => $2::int + u.n::int), now() - make_interval(secs => $2::int + u.n::int + 300) FROM unnest($1::text[]) WITH ORDINALITY AS u(x, n)");
    expect(DELETE_OWNED_MARKERS_SQL).toBe("DELETE FROM public.real_login_challenge_uses WHERE encode(nonce, 'hex') = ANY($1::text[]) RETURNING encode(nonce, 'hex') AS nonce");
    expect(COUNT_MARKERS_SQL).toBe("SELECT count(*)::int AS n FROM public.real_login_challenge_uses");
    expect(COUNT_OWNED_PRESENT_SQL).toBe("SELECT count(*)::int AS n FROM public.real_login_challenge_uses WHERE encode(nonce, 'hex') = ANY($1::text[])");
    expect(LIST_OWNED_PRESENT_SQL).toBe("SELECT encode(nonce, 'hex') AS nonce FROM public.real_login_challenge_uses WHERE encode(nonce, 'hex') = ANY($1::text[]) ORDER BY expires_at, nonce");
    expect(READ_MARKER_SQL).toContain("FROM public.real_login_challenge_uses WHERE encode(nonce, 'hex') = $1::text");
    expect(DB_CLOCK_SQL).toBe("SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS ms");
    expect(BOOLEAN_PROBE_SQL).toBe("SELECT (now() >= now()) AS yes, (now() < now()) AS no");
    expect([...CLOCK_BATCH]).toEqual(["SELECT now() AS tx_start", "SELECT pg_catalog.pg_sleep(1)", "SELECT now() AS tx_start_again, clock_timestamp() AS wall, (clock_timestamp() - now()) >= interval '900 milliseconds' AS wall_moved"]);
    for (const text of [INSERT_MARKER_SQL, INSERT_AGED_MARKERS_SQL, DELETE_OWNED_MARKERS_SQL, COUNT_MARKERS_SQL, COUNT_OWNED_PRESENT_SQL, LIST_OWNED_PRESENT_SQL, READ_MARKER_SQL]) {
      expect(text, text).not.toMatch(/\b(DROP|TRUNCATE|CASCADE|UPDATE|ALTER|GRANT|REVOKE)\b/);
      expect(text.match(/real_login_challenge_uses/g)?.length, text).toBe(1);
    }
    // The only DELETE takes an exact list; it has no other predicate and no pattern.
    expect(DELETE_OWNED_MARKERS_SQL).not.toMatch(/LIKE|~|BETWEEN|<|>/);
    // The activity polls look only at sessions of this database other than the poller, and never read statement text beyond a prefix test.
    for (const text of [HOLDER_ACTIVE_SQL, MARKER_WAITERS_SQL, CAN_SEE_ACTIVITY_SQL]) expect(text).toContain("pg_catalog.pg_stat_activity");
    expect(HOLDER_ACTIVE_SQL).toContain("pid <> pg_catalog.pg_backend_pid()");
    expect(MARKER_WAITERS_SQL).toContain("wait_event_type = 'Lock'");
  });

  it("the holders are scripted batches with a fixed shape: one change, a bounded sleep, and a commit or a deliberate 22012 rollback", () => {
    const nonce = `${RUN}${"ab".repeat(12)}`;
    const exp = "2030-01-01T00:00:00.000Z";
    const insert = holderInsertAndRollback(nonce, exp, 20);
    expect(insert).toHaveLength(3);
    expect(insert[0]).toBe(`INSERT INTO public.real_login_challenge_uses (nonce, expires_at, used_at) VALUES (decode('${nonce}', 'hex'), '${exp}'::timestamptz, clock_timestamp())`);
    expect(insert[1]).toBe("SELECT pg_catalog.pg_sleep(20)");
    expect(insert[2]).toBe("SELECT 1 / (SELECT count(*) FROM pg_catalog.pg_class WHERE false)::int");
    expect(holderDeleteAndCommit(nonce, 20)).toEqual([`DELETE FROM public.real_login_challenge_uses WHERE nonce = decode('${nonce}', 'hex')`, "SELECT pg_catalog.pg_sleep(20)"]);
    expect(holderTableGate(14)).toEqual(["LOCK TABLE public.real_login_challenge_uses IN SHARE ROW EXCLUSIVE MODE", "SELECT pg_catalog.pg_sleep(14)"]);
    expect(holderRowLocks([nonce], 14)).toEqual([`SELECT 1 FROM public.real_login_challenge_uses WHERE encode(nonce, 'hex') = ANY(ARRAY['${nonce}']) FOR UPDATE`, "SELECT pg_catalog.pg_sleep(14)"]);
    // A scratch schema is accepted only when owned.
    const ownership = createRunOwnership(RUN);
    const schema = ownership.registerScratchSchema("contrast");
    expect(holderDeleteAndCommit(nonce, 20, schema, ownership)[0]).toBe(`DELETE FROM ${schema}.real_login_challenge_uses WHERE nonce = decode('${nonce}', 'hex')`);
    expect(() => holderDeleteAndCommit(nonce, 20, schema)).toThrow(/ownership registry/);
    expect(() => holderDeleteAndCommit(nonce, 20, `pb_smoke_${RUN}_other`, ownership)).toThrow(/does not own/);
    // Bad inputs are refused, not escaped.
    for (const bad of ["x", `${nonce}'`, nonce.toUpperCase(), nonce.slice(1), `${nonce}; DROP TABLE x`]) {
      expect(() => holderInsertAndRollback(bad, exp, 20), bad).toThrow();
      expect(() => holderDeleteAndCommit(bad, 20), bad).toThrow();
      expect(() => holderRowLocks([bad], 14), bad).toThrow();
    }
    for (const bad of ["2030-01-01", "2030-01-01T00:00:00Z", "2030-01-01T00:00:00.000+00:00", "2030-01-01T00:00:00.000Z'; --", "2030-02-31T00:00:00.000Z"]) expect(() => holderInsertAndRollback(nonce, bad, 20), bad).toThrow();
    for (const bad of [0, 31, 1.5, Number.NaN, -1]) {
      expect(() => holderInsertAndRollback(nonce, exp, bad), String(bad)).toThrow(/seconds out of range/);
      expect(() => holderTableGate(bad), String(bad)).toThrow(/seconds out of range/);
    }
    expect(() => holderRowLocks([], 14)).toThrow(/1 to 64/);
    expect(() => holderRowLocks(Array.from({ length: 65 }, () => nonce), 14)).toThrow(/1 to 64/);
  });

  it("the scratch insert and read builders accept only an owned scratch schema and validated values", () => {
    const ownership = createRunOwnership(RUN);
    const schema = ownership.registerScratchSchema("apply");
    expect(scratchInsertSql(ownership, schema, { nonceBytesHex: "ab".repeat(16), expires: "2030-01-01T00:00:00.000Z", used: "now()" })).toBe(`INSERT INTO ${schema}.real_login_challenge_uses (nonce, expires_at, used_at) VALUES (decode('${"ab".repeat(16)}', 'hex'), '2030-01-01T00:00:00.000Z'::timestamptz, pg_catalog.now())`);
    expect(scratchInsertSql(ownership, schema, { nonceBytesHex: "NULL", expires: "NULL", used: "NULL" })).toContain("VALUES (NULL, NULL, NULL)");
    expect(scratchInsertSql(ownership, schema, { nonceBytesHex: "", expires: "now()", used: "now()" })).toContain("decode('', 'hex')");
    expect(scratchRowsSql(ownership, schema)).toBe(`SELECT encode(nonce, 'hex') AS nonce, octet_length(nonce)::int AS nonce_bytes FROM ${schema}.real_login_challenge_uses ORDER BY nonce`);
    for (const target of ["public", `pb_smoke_${RUN}_other`, "pg_catalog"]) {
      expect(() => scratchInsertSql(ownership, target, { nonceBytesHex: "ab", expires: "now()", used: "now()" }), target).toThrow();
      expect(() => scratchRowsSql(ownership, target), target).toThrow();
    }
    for (const bad of ["a", "zz", "AB", `ab'); DROP TABLE x; --`, "ab".repeat(65)]) expect(() => scratchInsertSql(ownership, schema, { nonceBytesHex: bad, expires: "now()", used: "now()" }), bad).toThrow(/hex byte string/);
    for (const bad of ["2030-01-01", "tomorrow", "now()); --"]) expect(() => scratchInsertSql(ownership, schema, { nonceBytesHex: "ab", expires: bad, used: "now()" }), bad).toThrow();
  });
});

// ------------------------------------------------------------------ the look-alike consistency checker

describe("the look-alike consistency checker fails closed (adapted from the Milestone 3C-1 checker that would have caught its S4 defect)", () => {
  const S = "pb_smoke_0a1b2c3d_check";
  const T = `${S}.real_login_challenge_uses`;
  const table = (body: string, tail = "") => `CREATE TABLE ${T} (${body})${tail}`;
  const intended = "nonce BYTEA NOT NULL, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ NOT NULL, CONSTRAINT real_login_challenge_uses_pkey PRIMARY KEY (nonce), CONSTRAINT real_login_challenge_uses_nonce_length_check CHECK (octet_length(nonce) = 16)";
  const reg = (sql: string) => ({ register: ["table", "real_login_challenge_uses"] as ["table", string], sql });
  const issues = (steps: Parameters<typeof analyseVariant>[1]) => analyseVariant(S, steps).issues.join("\n");

  it("the intended table is clean, and a removed column that a constraint, index, or ALTER still names is flagged (the original defect)", () => {
    expect(issues([reg(table(intended))])).toBe("");
    expect(issues([reg(table(intended.replace("nonce BYTEA NOT NULL, ", "")))])).toContain("names column nonce, which");
    expect(issues([reg(table(intended.replace("expires_at TIMESTAMPTZ NOT NULL, ", ""))), { sql: `CREATE INDEX real_login_challenge_uses_expires_at_idx ON ${T} USING btree (expires_at)` }])).toContain("an index: names column expires_at");
    expect(issues([reg(table(intended.replace("used_at TIMESTAMPTZ NOT NULL, ", ""))), { sql: `CREATE INDEX x ON ${T} USING btree (used_at) WHERE (used_at IS NOT NULL)` }])).toContain("names column used_at");
    expect(issues([reg(table(intended.replace("used_at TIMESTAMPTZ NOT NULL, ", ""))), { sql: `ALTER TABLE ${T} ADD CONSTRAINT c CHECK (used_at IS NOT NULL) NOT VALID` }])).toContain("an added constraint: names column used_at");
    expect(issues([reg(table("nonce BYTEA NOT NULL, used_at TIMESTAMPTZ GENERATED ALWAYS AS (expires_at) STORED"))])).toContain("names column expires_at");
  });

  it("anything it does not recognize, unbalanced text, duplicate columns, and ownership mistakes are flagged", () => {
    expect(issues([reg(table(intended, " WITH (fillfactor = 50)"))])).toContain("an unrecognized table tail");
    expect(issues([reg(table(intended, " PARTITION BY HASH (nonce)"))])).toBe("");
    expect(issues([reg(table(intended.replace(/\)$/, "")))])).toMatch(/unbalanced|unrecognized/);
    expect(issues([reg(table("nonce BYTEA, , used_at TIMESTAMPTZ"))])).toContain("an empty table-definition item");
    expect(issues([reg(table("nonce BYTEA, 42 INTEGER"))])).toContain("an unrecognized table-definition item");
    expect(issues([reg(table("nonce BYTEA, nonce BYTEA"))])).toContain("defined twice");
    expect(issues([reg(table(intended)), { sql: `GRANT SELECT ON ${T} TO PUBLIC` }])).toContain("an unrecognized statement kind");
    expect(issues([reg(table(intended)), { sql: `ALTER TABLE ${T} ADD COLUMN y INT` }])).toContain("an unrecognized ALTER TABLE form");
    expect(issues([reg(table(intended)), { sql: `CREATE INDEX x ON ${T} USING gin (nonce)` }])).toContain("an unrecognized CREATE INDEX form");
    expect(issues([{ sql: table(intended) }])).toContain("differ from the registered ones");
    expect(issues([reg(table(intended)), { register: ["table", "ghost"], sql: `ALTER TABLE ${T} ENABLE ROW LEVEL SECURITY` }])).toContain("differ from the registered ones");
    expect(issues([{ register: ["table", "lcu_parent"], sql: `CREATE TABLE ${S}.lcu_parent ()` }])).toContain("never creates the relation the migration will inspect");
    expect(issues([reg(table(intended)), { sql: `CREATE TRIGGER t BEFORE INSERT ON ${T} FOR EACH ROW EXECUTE FUNCTION ${S}.missing_fn()` }])).toContain("a trigger calling a function this variant has not created");
    expect(issues([reg(table(intended)), { sql: `CREATE POLICY p ON ${S}.other USING (true)` }])).toContain("a policy on a table this variant has not created");
  });

  it("an expression index, a storage option, and a partial index are recognized (and a column they name is still checked)", () => {
    const base = reg(table(intended));
    expect(issues([base, { sql: `CREATE INDEX x ON ${T} USING btree ((expires_at AT TIME ZONE 'UTC'))` }])).toBe("");
    expect(issues([base, { sql: `CREATE INDEX x ON ${T} USING btree (expires_at) WITH (fillfactor = 70)` }])).toBe("");
    expect(issues([base, { sql: `CREATE UNIQUE INDEX x ON ${T} USING btree (expires_at) WHERE (expires_at IS NOT NULL)` }])).toBe("");
    expect(issues([reg(table(intended.replace("expires_at TIMESTAMPTZ NOT NULL, ", ""))), { sql: `CREATE INDEX x ON ${T} USING btree ((expires_at AT TIME ZONE 'UTC'))` }])).toContain("an index: names column expires_at");
  });
});

// ------------------------------------------------------------------ outcome classification

describe("a marker answer is consumed, rejected, or an explicit non-answer — never a guess", () => {
  const rejected = (reason: unknown) => ({ status: "rejected" as const, reason });
  it("classifies each case", () => {
    expect(classifyMarker({ status: "fulfilled", value: "consumed" })).toEqual({ kind: "consumed" });
    expect(classifyMarker({ status: "fulfilled", value: "rejected" })).toEqual({ kind: "rejected" });
    expect(classifyMarker({ status: "fulfilled", value: true })).toEqual({ kind: "no_answer" });
    expect(classifyMarker({ status: "fulfilled", value: undefined })).toEqual({ kind: "no_answer" });
    expect(classifyMarker({ status: "fulfilled", value: "CONSUMED" })).toEqual({ kind: "no_answer" });
    expect(classifyMarker(rejected(Object.assign(new Error("x"), { code: "42P10", constraint: "real_login_challenge_uses_pkey" })))).toEqual({ kind: "database_error", sqlState: "42P10", constraint: "real_login_challenge_uses_pkey" });
    expect(classifyMarker(rejected(Object.assign(new Error('duplicate key violates constraint "real_login_challenge_uses_pkey"'), { code: "23505" })))).toEqual({ kind: "database_error", sqlState: "23505", constraint: "real_login_challenge_uses_pkey" });
    expect(classifyMarker(rejected(new Error("Login challenge use refused: the marker statement's live flag is missing or not a boolean.")))).toEqual({ kind: "invariant_failure" });
    expect(classifyMarker(rejected(new Error("fetch failed")))).toEqual({ kind: "no_answer" });
    expect(classifyMarker(rejected(Object.assign(new Error("x"), { code: "ECONNRESET" })))).toEqual({ kind: "no_answer" });
    expect(classifyMarker(rejected(null))).toEqual({ kind: "no_answer" });
    expect(tallyOutcomes([{ kind: "consumed" }, { kind: "rejected" }, { kind: "rejected" }, { kind: "database_error", sqlState: "40P01", constraint: null }])).toEqual({ consumed: 1, rejected: 2, database_error: 1 });
  });
});

// ------------------------------------------------------------------ the expected delta

describe("a clean run leaves the baseline plus exactly an empty marker table", () => {
  const fingerprint = (rows: number, tag: string) => ({ rows, contentDigest: `c-${tag}`, shapeDigest: `s-${tag}` });
  const before: DatabaseSnapshot = { tables: { real_rate_limits: fingerprint(0, "a"), payment_attempts: fingerprint(13, "p") }, schemas: ["public"] };
  const after = (): DatabaseSnapshot => ({ tables: { ...before.tables, real_login_challenge_uses: fingerprint(0, "m") }, schemas: ["public"] });
  const compare = (overrides: Partial<{ before: unknown; after: unknown; markerTable: unknown; ownedSchemas: string[] }> = {}) => compareWithExpectedMarkerDelta({ before, after: after(), markerTable: EXPECTED_MARKER_TABLE, ownedSchemas: [`pb_smoke_${RUN}_a01`], ...overrides });

  it("the expected descriptor is the migration's table, in alphabetical order, and EMPTY", () => {
    expect(EXPECTED_MARKER_TABLE.columns.map((column) => [column.name, column.type, column.notNull])).toEqual([["nonce", "bytea", true], ["expires_at", "timestamp with time zone", true], ["used_at", "timestamp with time zone", true]]);
    expect(EXPECTED_MARKER_TABLE.constraints.map((constraint) => constraint.name)).toEqual(["real_login_challenge_uses_nonce_length_check", "real_login_challenge_uses_pkey"]);
    expect(EXPECTED_MARKER_TABLE.indexes).toEqual(["real_login_challenge_uses_expires_at_idx", "real_login_challenge_uses_pkey"]);
    expect(EXPECTED_MARKER_TABLE.rows).toBe(0);
    expect(EXPECTED_MARKER_TABLE).toMatchObject({ triggers: 0, foreignKeysOut: 0, foreignKeysIn: 0, policies: 0, rowSecurity: false });
  });

  it("passes only when exactly that is the difference", () => {
    const verdict = compare();
    expect(verdict.ok).toBe(true);
    expect(verdict.verdict).toBe("baseline_plus_expected_delta");
    expect(verdict.differences).toEqual([]);
    expect(verdict.expectedDelta).toEqual({ tableAdded: "public.real_login_challenge_uses", rows: 0 });
    expect(verdict.measured.length).toBeGreaterThan(0);
    expect(verdict.notMeasured.join(" ")).toMatch(/functions|roles/);
  });

  it("every other difference is a mismatch", () => {
    const mismatch = (verdict: DeltaVerdict, text: RegExp) => {
      expect(verdict.ok).toBe(false);
      expect(verdict.verdict).toBe("delta_mismatch");
      expect(verdict.differences.join("\n")).toMatch(text);
    };
    const changed = after();
    changed.tables.payment_attempts = fingerprint(14, "p");
    mismatch(compare({ after: changed }), /contents changed: payment_attempts/);
    const reshaped = after();
    reshaped.tables.real_rate_limits = { ...reshaped.tables.real_rate_limits!, shapeDigest: "other" };
    mismatch(compare({ after: reshaped }), /catalog shape changed: real_rate_limits/);
    const removed = after();
    delete removed.tables.payment_attempts;
    mismatch(compare({ after: removed }), /table removed: payment_attempts/);
    const extra = after();
    extra.tables.surprise = fingerprint(0, "x");
    mismatch(compare({ after: extra }), /unexpected new table: surprise/);
    mismatch(compare({ after: before }), /expected delta missing/);
    const full = after();
    full.tables.real_login_challenge_uses = fingerprint(1, "m");
    mismatch(compare({ after: full }), /is not empty/);
    mismatch(compare({ markerTable: { ...EXPECTED_MARKER_TABLE, rows: 1 } }), /does not match the intended descriptor/);
    mismatch(compare({ markerTable: { ...EXPECTED_MARKER_TABLE, indexes: ["real_login_challenge_uses_pkey"] } }), /does not match the intended descriptor/);
    mismatch(compare({ markerTable: null }), /does not match the intended descriptor/);
    const leftover = after();
    leftover.schemas = ["public", `pb_smoke_${RUN}_a01`];
    mismatch(compare({ after: leftover }), /scratch schema remains/);
    mismatch(compare({ before: { ...before, tables: { ...before.tables, real_login_challenge_uses: fingerprint(0, "m") } } }), /already existed before/);
    mismatch(compare({ before: { tables: { payment_attempts: fingerprint(13, "p") }, schemas: ["public"] } }), /real_rate_limits was not measured/);
    mismatch(compare({ before: { ...before, schemas: ["public", `pb_smoke_${RUN}_a01`] } }), /existed before the run/);
    mismatch(compare({ after: undefined }), /malformed/);
    mismatch(compare({ before: { tables: { x: { rows: "1" } }, schemas: [] } }), /malformed/);
    mismatch(compare({ after: { ...after(), schemas: ["public", "other"] } }), /set of schemas changed/);
  });
});

// ------------------------------------------------------------------ evidence

describe("the evidence writer saves two private, never-overwritten records and refuses anything unsafe", () => {
  const dirs: string[] = [];
  const temp = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "lcu-evidence-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const startRecord = (overrides: Record<string, unknown> = {}) => ({ ...Object.fromEntries(START_EVIDENCE_FIELDS.map((field) => [field, field === "runId" ? RUN : "x"])), ...overrides });
  const finalRecord = (overrides: Record<string, unknown> = {}) => ({ ...Object.fromEntries(FINAL_EVIDENCE_FIELDS.map((field) => [field, field === "runId" ? RUN : "x"])), ...overrides });

  it("writes <dir>/login-challenge-uses-smoke-<run>-<stage>.json with mode 0600, once", () => {
    const directory = temp();
    const first = writeLoginChallengeUsesEvidence({ directory, runId: RUN, stage: "start", evidence: startRecord() });
    expect(first).toEqual({ ok: true, file: path.join(directory, `login-challenge-uses-smoke-${RUN}-start.json`) });
    if (first.ok) {
      expect(statSync(first.file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(first.file, "utf8")).runId).toBe(RUN);
    }
    expect(writeLoginChallengeUsesEvidence({ directory, runId: RUN, stage: "start", evidence: startRecord({ other: "new" }) })).toMatchObject({ ok: false, reason: "already_exists" });
    expect(JSON.parse(readFileSync(path.join(directory, `login-challenge-uses-smoke-${RUN}-start.json`), "utf8")).other).toBeUndefined();
    expect(writeLoginChallengeUsesEvidence({ directory, runId: RUN, stage: "final", evidence: finalRecord() }).ok).toBe(true);
    expect(existsSync(path.join(directory, `login-challenge-uses-smoke-${RUN}-final.json`))).toBe(true);
  });

  it("refuses an invalid run id or stage, an incomplete record, another run's record, unsafe content, and a directory others can enter", () => {
    const directory = temp();
    const write = (input: Partial<Parameters<typeof writeLoginChallengeUsesEvidence>[0]>): EvidenceResult => writeLoginChallengeUsesEvidence({ directory, runId: RUN, stage: "start", evidence: startRecord(), ...input });
    expect(write({ runId: "../../x" })).toMatchObject({ ok: false, reason: "invalid_run_id" });
    expect(write({ runId: "0A1B2C3D" })).toMatchObject({ ok: false, reason: "invalid_run_id" });
    expect(write({ stage: "other" as never })).toMatchObject({ ok: false, reason: "invalid_run_id" });
    expect(write({ evidence: {} })).toMatchObject({ ok: false, reason: "incomplete" });
    expect(write({ evidence: null })).toMatchObject({ ok: false, reason: "incomplete" });
    expect(write({ evidence: [] })).toMatchObject({ ok: false, reason: "incomplete" });
    expect(write({ evidence: startRecord({ runId: "1a2b3c4d" }) })).toMatchObject({ ok: false, reason: "incomplete" });
    expect(write({ stage: "final", evidence: startRecord() })).toMatchObject({ ok: false, reason: "incomplete" });
    for (const unsafe of ["postgresql://user:pw@host/db", "ep-cool-name-123456", "x-pooler", "my password", "the api_key", "a private-key", "secret", "Bearer abc", "an authorization header", "a credential", "token"]) {
      expect(write({ evidence: startRecord({ note: unsafe }) }), unsafe).toMatchObject({ ok: false, reason: "unsafe_content" });
    }
    expect(write({ evidence: startRecord({ circular: (() => { const loop: Record<string, unknown> = {}; loop.self = loop; return loop; })() }) })).toMatchObject({ ok: false, reason: "unsafe_content" });
    expect(readdirEmpty(directory)).toBe(true);
    chmodSync(directory, 0o755);
    expect(write({})).toMatchObject({ ok: false, reason: "directory_not_private" });
    expect(readdirEmpty(directory)).toBe(true);
  });

  it("REAL start and final evidence shapes pass the content screen: the source identity, the repository, the target status, a poisoned reason, a refusal, and an action", () => {
    const smoke = readFileSync(SMOKE, "utf8");
    const status = TARGET_PROOF_STATUS;
    expect(smoke).toContain("targetProofStatus: TARGET_PROOF_STATUS,");
    const identity = computeSourceIdentity({
      schemaText,
      neonStoreText: readFileSync("lib/real/server/neon-store.ts", "utf8"),
      loginChallengeText: readFileSync("lib/real/server/login-challenge.ts", "utf8"),
      loginChallengeUsesText: readFileSync("lib/real/server/login-challenge-uses.ts", "utf8"),
      harnessSmokeText: smoke,
      harnessFixtureText: readFileSync(FIXTURE, "utf8"),
      sharedHelpers: readSharedHelpers(),
    });
    const common = {
      runId: RUN,
      repository: { branch: "main", commit: "46d1cc29c2f484b6572ff9461fb02190dd134372" },
      sourceIdentity: identity,
      migrationIdentity: { name: MIGRATION_IDENTITY.name, length: MIGRATION_IDENTITY.length, sha256: MIGRATION_IDENTITY.sha256 },
      markerSqlIdentity: { referenceSha256: MARKER_SQL_REFERENCE_SHA256, productionMatchesReference: true },
      targetProofStatus: status,
      server: { database: "neondb", version: "18.6", isolation: "read committed", defaultIsolation: "read committed", inRecovery: false },
      connectionMode: "pooled",
      scenarioInventory: [{ name: "S1. missing table: the production marker statement fails closed (42P01) before the block is applied", operations: 3 }],
      plannedBudget: planBudget([{ name: "one", operations: 1, fixtureStatements: 0, fixtureRows: 0, polls: 0, concurrent: 1, scratchSchemas: 0 }]),
      fingerprintsBefore: { tables: { real_rate_limits: { rows: 0, contentDigest: "d", shapeDigest: "s" } }, schemas: ["public"] },
    };
    const directory = temp();
    expect(writeLoginChallengeUsesEvidence({ directory, runId: RUN, stage: "start", evidence: common }).ok).toBe(true);
    const final = {
      ...common,
      actualBudget: { operations: 1, fixtureStatements: 0, fixtureRows: 0, polls: 0, maxConcurrent: 1, scratchSchemas: 0 },
      casesExecuted: [],
      casesNotExecuted: [],
      markerTallies: { "M4. 60 simultaneous requests for ONE nonce: exactly one consumed, 59 rejected": { consumed: 1, rejected: 59 } },
      fixtureReport: [{ case: "S4", what: "building the look-alike (an extra column)", constructed: true }],
      migrationRefusals: [{ case: "S4", what: "the block against a look-alike (an extra column)", sqlState: "P0001" }],
      observations: { m4: { holderObserved: 1, blockedObserved: 60 } },
      cleanup: { attempted: true, accepted: true, skipped: null, inFlight: false, markersDeleted: 3, markerResidue: 0 },
      fingerprintsAfter: common.fingerprintsBefore,
      expectedDelta: cleanDeltaForEvidence(),
      unknownOperations: [],
      inFlightOperations: [],
      disposition: "baseline_plus_expected_delta",
      completeRestoration: false,
      poisoned: "HARNESS FAILURE: the fixture could not be constructed (building the look-alike (an extra column)) — SQLSTATE 42703; the migration was never tested for this scenario",
      action: "Investigate the disposable branch read-only. Do not reuse or automatically repair the branch.",
    };
    expect(writeLoginChallengeUsesEvidence({ directory, runId: RUN, stage: "final", evidence: final })).toMatchObject({ ok: true });
    // The identity object carries no field whose name or value trips the screen.
    expect(JSON.stringify(identity)).not.toMatch(/token|bearer|authorization|credential|secret|password/i);
  });

  it("the required fields are exactly the documented ones", () => {
    expect([...START_EVIDENCE_FIELDS]).toEqual(["runId", "repository", "sourceIdentity", "migrationIdentity", "markerSqlIdentity", "targetProofStatus", "server", "connectionMode", "scenarioInventory", "plannedBudget", "fingerprintsBefore"]);
    for (const field of ["repository", "sourceIdentity", "migrationIdentity", "markerSqlIdentity", "actualBudget", "casesExecuted", "casesNotExecuted", "markerTallies", "fixtureReport", "migrationRefusals", "observations", "cleanup", "fingerprintsAfter", "expectedDelta", "unknownOperations", "inFlightOperations", "disposition"]) expect(FINAL_EVIDENCE_FIELDS as readonly string[]).toContain(field);
    expect(missingEvidenceFields("start", startRecord())).toEqual([]);
    expect(missingEvidenceFields("start", startRecord({ server: undefined }))).toEqual(["server"]);
    expect(missingEvidenceFields("final", finalRecord({ runId: "bad" }))).toEqual(["runId"]);
    expect(missingEvidenceFields("final", "x")).toHaveLength(FINAL_EVIDENCE_FIELDS.length);
  });
});
function cleanDeltaForEvidence() {
  return { ok: true, verdict: "baseline_plus_expected_delta", differences: [], expectedDelta: { tableAdded: "public.real_login_challenge_uses", rows: 0 }, measured: ["every public table's row count, content digest, and shape digest"], notMeasured: ["roles, grants, and database settings"] };
}
function readdirEmpty(directory: string): boolean {
  return readFileSyncList(directory).length === 0;
}
function readFileSyncList(directory: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("node:fs") as typeof import("node:fs")).readdirSync(directory);
}

// ------------------------------------------------------------------ the lifecycle

describe("the lifecycle: a run is armed once, poisoned for good at the first surprise, and cleaned up at most once", () => {
  const OK_START: EvidenceResult = { ok: true, file: "x" };
  const CASES = ["case one", "case two"] as const;
  const CHECKS = ["check one"] as const;

  function setup(overrides: Partial<Parameters<typeof createLoginChallengeUsesLifecycle>[0]> = {}) {
    const ownership = createRunOwnership(RUN);
    const nonces = createNonceRegistry(RUN);
    const lifecycle = createLoginChallengeUsesLifecycle({ expectedCases: CASES, requiredPreflightChecks: CHECKS, caseDeadlineMs: 2000, cleanupDeadlineMs: 2000, ownership, nonces, ...overrides });
    return { ownership, nonces, lifecycle };
  }
  type Run = ReturnType<typeof setup>;
  const arm = (run: Run) =>
    run.lifecycle.runPreflight(async () => {
      run.lifecycle.preflightCheck("check one", true);
      run.lifecycle.arm({ startEvidence: OK_START });
    });
  const state = (run: Run) => run.lifecycle.state();
  const sqlError = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error("db"), { code, ...extra });

  /** A scripted database for the cleanup: every statement answers what a clean database would. */
  function cleanDb(options: { markerResidue?: number; deleted?: (chunk: string[]) => string[]; log?: string[] } = {}) {
    const log = options.log ?? [];
    return {
      log,
      q: async (text: string, params: unknown[] = []) => {
        log.push(text);
        if (text === SCHEMA_INVENTORY_SQL) return [];
        if (text === SCHEMA_EXTERNAL_DEPENDENCIES_SQL) return [{ foreign_keys: 0, triggers: 0, inheritance: 0, view_references: 0 }];
        if (text === SCHEMA_RESIDUE_SQL) return [{ n: 0 }];
        if (text === DELETE_OWNED_MARKERS_SQL) return (options.deleted ? options.deleted(params[0] as string[]) : (params[0] as string[])).map((nonce) => ({ nonce }));
        if (text === COUNT_MARKERS_SQL) return [{ n: options.markerResidue ?? 0 }];
        throw new Error(`unexpected statement: ${text.slice(0, 40)}`);
      },
    };
  }
  const cleanDelta = (): DeltaVerdict => ({ ok: true, verdict: "baseline_plus_expected_delta", differences: [], expectedDelta: { tableAdded: "public.real_login_challenge_uses", rows: 0 }, measured: [], notMeasured: [] });
  const finish = (run: Run, delta: DeltaVerdict = cleanDelta()) => run.lifecycle.finish({ compare: async () => delta });

  it("a complete clean run: preflight, arm, every case in order, one cleanup, one comparison -> COMPLETED_CLEAN", async () => {
    const run = setup();
    expect(state(run)).toBe("NOT_STARTED");
    await arm(run);
    expect(state(run)).toBe("ARMED");
    const n = run.nonces.register("a");
    for (const name of CASES) await run.lifecycle.runCase(name, async () => void (await run.lifecycle.write("a write", async () => [{ n }])));
    const db = cleanDb();
    await run.lifecycle.runFinalCleanup(db);
    const report = await finish(run);
    expect(report.outcome).toBe("COMPLETED_CLEAN");
    expect(report.disposition).toBe("baseline_plus_expected_delta");
    expect(report.completeRestoration).toBe(false);
    expect(report.poisoned).toBeNull();
    expect(report.executed).toEqual([...CASES]);
    expect(report.cleanup).toMatchObject({ attempted: true, accepted: true, markersDeleted: 1, markerResidue: 0 });
    expect(report.actualBudget.operations).toBe(2);
    expect(db.log.filter((text) => text === DELETE_OWNED_MARKERS_SQL)).toHaveLength(1);
    expect(concludeLoginChallengeUsesRun(report, { start: OK_START, final: OK_START })).toMatchObject({ pass: true, verdict: "clean_and_evidenced" });
    expect(concludeLoginChallengeUsesRun(report, { start: OK_START, final: { ok: false, reason: "write_failed", code: null } })).toMatchObject({ pass: false, verdict: "clean_but_not_evidenced" });
  });

  it("nothing may be written before the run is armed, and arming needs every check and the saved start evidence", async () => {
    const early = setup();
    await expect(early.lifecycle.runPreflight(async () => void (await early.lifecycle.write("an early write", async () => 1)))).rejects.toThrow();
    expect(early.lifecycle.poisoned()).toMatch(/before the run was armed/);
    const noCheck = setup();
    await expect(noCheck.lifecycle.runPreflight(async () => noCheck.lifecycle.arm({ startEvidence: OK_START }))).rejects.toThrow();
    expect(noCheck.lifecycle.poisoned()).toMatch(/1 preflight check/);
    const noEvidence = setup();
    await expect(noEvidence.lifecycle.runPreflight(async () => { noEvidence.lifecycle.preflightCheck("check one", true); noEvidence.lifecycle.arm({ startEvidence: { ok: false, reason: "write_failed", code: null } }); })).rejects.toThrow();
    expect(noEvidence.lifecycle.poisoned()).toMatch(/without saved start evidence/);
    const failed = setup();
    await expect(failed.lifecycle.runPreflight(async () => failed.lifecycle.preflightCheck("check one", false))).rejects.toThrow();
    expect(failed.lifecycle.poisoned()).toMatch(/did not pass/);
    const unknown = setup();
    await expect(unknown.lifecycle.runPreflight(async () => unknown.lifecycle.preflightCheck("another check", true))).rejects.toThrow();
    const neverArmed = setup();
    await expect(neverArmed.lifecycle.runPreflight(async () => 1)).rejects.toThrow();
    expect(neverArmed.lifecycle.poisoned()).toMatch(/without arming/);
    const noOperationOutsideACase = setup();
    await arm(noOperationOutsideACase);
    await expect(noOperationOutsideACase.lifecycle.write("outside", async () => 1)).rejects.toThrow();
    expect(noOperationOutsideACase.lifecycle.poisoned()).toMatch(/outside a running case/);
  });

  it("a case that is not the next expected one, runs twice, or throws poisons the run; a poisoned run refuses further cases", async () => {
    const wrongOrder = setup();
    await arm(wrongOrder);
    await expect(wrongOrder.lifecycle.runCase("case two", async () => undefined)).rejects.toThrow();
    expect(wrongOrder.lifecycle.poisoned()).toMatch(/not the next expected case/);
    const throwing = setup();
    await arm(throwing);
    await expect(throwing.lifecycle.runCase("case one", async () => { throw new Error("assertion"); })).rejects.toThrow("assertion");
    expect(state(throwing)).toBe("POISONED");
    await expect(throwing.lifecycle.runCase("case two", async () => undefined)).rejects.toThrow(/poisoned/);
    expect(throwing.lifecycle.executed()).toEqual([]);
    const notArmed = setup();
    await expect(notArmed.lifecycle.runCase("case one", async () => undefined)).rejects.toThrow(/not armed/);
  });

  it("a case that outlives its deadline poisons the run and reports the uncertainty", async () => {
    const run = setup({ caseDeadlineMs: 30 });
    await arm(run);
    await expect(run.lifecycle.runCase("case one", () => new Promise<void>((resolve) => setTimeout(resolve, 300)))).rejects.toThrow(/exceeded its deadline/);
    expect(run.lifecycle.poisoned()).toMatch(/exceeded its 30 ms deadline/);
  });

  it("every database answer that is not the expected one poisons: a lost answer, a database error, and an operation still in flight", async () => {
    const lost = setup();
    await arm(lost);
    await expect(lost.lifecycle.runCase("case one", async () => void (await lost.lifecycle.write("a lost write", () => Promise.reject(new Error("fetch failed")))))).rejects.toThrow();
    expect(lost.lifecycle.poisoned()).toMatch(/no answer for a lost write/);
    expect((await finish(lost)).unknownOperations).toEqual(["a lost write"]);
    const refused = setup();
    await arm(refused);
    await expect(refused.lifecycle.runCase("case one", async () => void (await refused.lifecycle.write("a refused write", () => Promise.reject(sqlError("23505")))))).rejects.toThrow();
    expect(refused.lifecycle.poisoned()).toMatch(/SQLSTATE 23505/);
    const unsettled = setup();
    await arm(unsettled);
    await expect(unsettled.lifecycle.runCase("case one", async () => void unsettled.lifecycle.launch("never collected", () => new Promise(() => undefined)))).rejects.toThrow();
    expect(unsettled.lifecycle.poisoned()).toMatch(/still unsettled/);
    expect((await finish(unsettled)).inFlightOperations).toContain("never collected");
  });

  it("a fixture that cannot be constructed is a HARNESS FAILURE — never a migration refusal, never a pass", async () => {
    const run = setup();
    await arm(run);
    await expect(run.lifecycle.runCase("case one", async () => void (await run.lifecycle.buildFixture("building a look-alike", () => Promise.reject(sqlError("42703")))))).rejects.toThrow();
    expect(run.lifecycle.poisoned()).toMatch(/^HARNESS FAILURE: the fixture could not be constructed \(building a look-alike\) — SQLSTATE 42703/);
    const report = await finish(run);
    expect(report.fixtureReport).toEqual([{ case: "case one", what: "building a look-alike", constructed: false }]);
    expect(report.migrationRefusals).toEqual([]);
    expect(report.outcome).toBe("POISONED");
    const built = setup();
    await arm(built);
    await built.lifecycle.runCase("case one", async () => void (await built.lifecycle.buildFixture("building a look-alike", async () => [])));
    expect((await finish(built)).fixtureReport).toEqual([{ case: "case one", what: "building a look-alike", constructed: true }]);
  });

  it("a migration refusal counts only for a SQLSTATE the scenario names; acceptance, another SQLSTATE, and a lost answer all poison", async () => {
    const accepted = setup();
    await arm(accepted);
    await accepted.lifecycle.runCase("case one", async () => {
      expect(await accepted.lifecycle.expectMigrationRefusal("the block against a look-alike", () => Promise.reject(sqlError("P0001", { constraint: "real_login_challenge_uses_pkey" })), ["P0001"])).toEqual({ sqlState: "P0001", constraint: "real_login_challenge_uses_pkey" });
      await accepted.lifecycle.expectMigrationRefusal("the block against a missing-column look-alike", () => Promise.reject(sqlError("42703")), ["42703"]);
    });
    expect((await finish(accepted)).migrationRefusals).toEqual([
      { case: null, what: "the block against a look-alike", sqlState: "P0001" },
      { case: null, what: "the block against a missing-column look-alike", sqlState: "42703" },
    ].map((entry) => ({ ...entry, case: "case one" })));
    for (const [label, operation, allowed, reason] of [
      ["accepted", () => Promise.resolve([]), ["P0001"], /UNEXPECTED MIGRATION RESULT: .* was expected to be refused, and was accepted/],
      ["another SQLSTATE", () => Promise.reject(sqlError("42703")), ["P0001"], /UNEXPECTED MIGRATION RESULT: .* SQLSTATE 42703, which this scenario does not allow/],
      ["a lost answer", () => Promise.reject(new Error("fetch failed")), ["P0001"], /no answer for/],
      ["no allowed SQLSTATE", () => Promise.reject(sqlError("P0001")), [], /named no valid SQLSTATE/],
      ["a malformed allowed SQLSTATE", () => Promise.reject(sqlError("P0001")), ["p0001"], /named no valid SQLSTATE/],
    ] as const) {
      const run = setup();
      await arm(run);
      await expect(run.lifecycle.runCase("case one", async () => void (await run.lifecycle.expectMigrationRefusal("the block", operation, allowed))), label).rejects.toThrow();
      expect(run.lifecycle.poisoned(), label).toMatch(reason);
    }
  });

  it("a marker request is consumed or rejected; a database error, a malformed answer, and a lost answer are NEVER counted as a rejection", async () => {
    const run = setup();
    await arm(run);
    await run.lifecycle.runCase("case one", async () => {
      expect(await run.lifecycle.consume("a use", async () => "consumed")).toBe("consumed");
      expect(await run.lifecycle.consume("a replay", async () => "rejected")).toBe("rejected");
    });
    expect((await finish(run)).markerTallies).toEqual({ "case one": { consumed: 1, rejected: 1 } });
    for (const [label, operation, reason] of [
      ["a database error", () => Promise.reject(sqlError("40P01")), /refused by the database \(SQLSTATE 40P01\); that is not a rejection/],
      ["a malformed answer", () => Promise.reject(new Error("Login challenge use refused: the marker statement's live flag is missing or not a boolean.")), /failed closed on a malformed answer/],
      ["a lost answer", () => Promise.reject(new Error("fetch failed")), /no usable answer/],
      ["an unrecognized value", () => Promise.resolve(true), /no usable answer/],
    ] as const) {
      const fresh = setup();
      await arm(fresh);
      await expect(fresh.lifecycle.runCase("case one", async () => void (await fresh.lifecycle.consume("a use", operation))), label).rejects.toThrow();
      expect(fresh.lifecycle.poisoned(), label).toMatch(reason);
    }
    // A database error the scenario EXPECTS (a missing table, a missing unique key) is accepted with its SQLSTATE, and anything else is not.
    const expected = setup();
    await arm(expected);
    await expected.lifecycle.runCase("case one", async () => {
      expect(await expected.lifecycle.expectMarkerDatabaseError("no table", () => Promise.reject(sqlError("42P01")), ["42P01"])).toEqual({ sqlState: "42P01" });
    });
    expect((await finish(expected)).markerTallies).toEqual({ "case one": { "database_error:42P01": 1 } });
    for (const [label, operation] of [["another SQLSTATE", () => Promise.reject(sqlError("42P10"))], ["an answer", () => Promise.resolve("consumed")], ["a lost answer", () => Promise.reject(new Error("x"))]] as const) {
      const wrong = setup();
      await arm(wrong);
      await expect(wrong.lifecycle.runCase("case one", async () => void (await wrong.lifecycle.expectMarkerDatabaseError("no table", operation, ["42P01"]))), label).rejects.toThrow();
      expect(wrong.lifecycle.poisoned(), label).toBeTruthy();
    }
  });

  it("launched holders and requests must be collected; a rollback holder must end with the deliberate 22012, a commit holder must not fail", async () => {
    const run = setup();
    await arm(run);
    await run.lifecycle.runCase("case one", async () => {
      const rolledBack = run.lifecycle.launch("holder", () => Promise.reject(sqlError("22012")));
      const committed = run.lifecycle.launch("holder 2", async () => [[]]);
      const request = run.lifecycle.launch("request", async () => "consumed");
      await run.lifecycle.collectHolderRolledBack(rolledBack);
      await run.lifecycle.collectHolderCommitted(committed);
      expect(await run.lifecycle.collectMarker(request)).toEqual({ kind: "consumed" });
    });
    for (const [label, launchOperation, collect, reason] of [
      ["a rollback holder that commits", async () => [[]], "rolledBack", /expected to roll back and committed/],
      ["a rollback holder with another error", () => Promise.reject(sqlError("57014")), "rolledBack", /not the deliberate 22012 rollback/],
      ["a rollback holder with no answer", () => Promise.reject(new Error("x")), "rolledBack", /no answer for/],
      ["a commit holder that fails", () => Promise.reject(sqlError("22012")), "committed", /refused/],
    ] as const) {
      const fresh = setup();
      await arm(fresh);
      await expect(
        fresh.lifecycle.runCase("case one", async () => {
          const holder = fresh.lifecycle.launch("holder", launchOperation);
          await (collect === "rolledBack" ? fresh.lifecycle.collectHolderRolledBack(holder) : fresh.lifecycle.collectHolderCommitted(holder));
        }),
        label,
      ).rejects.toThrow();
      expect(fresh.lifecycle.poisoned(), label).toMatch(reason);
    }
  });

  it("the concurrency, operation, fixture-write, and poll budgets stop the run when reached", async () => {
    const wide = setup();
    await arm(wide);
    await expect(
      wide.lifecycle.runCase("case one", async () => {
        const pending = [] as ReturnType<typeof wide.lifecycle.launch>[];
        for (let i = 0; i < CEILINGS.concurrent + 1; i += 1) pending.push(wide.lifecycle.launch(`request ${i}`, () => new Promise(() => undefined)));
      }),
    ).rejects.toThrow();
    expect(wide.lifecycle.poisoned()).toMatch(/would exceed the concurrency ceiling/);
    expect(wide.lifecycle.inFlightCount()).toBe(CEILINGS.concurrent);

    const small = { ...CEILINGS, operations: 3, fixtureStatements: 2, fixtureRows: 5, polls: 1 };
    const operations = setup({ ceilings: small });
    await arm(operations);
    await expect(operations.lifecycle.runCase("case one", async () => { for (let i = 0; i < 4; i += 1) await operations.lifecycle.read("a read", async () => 1); })).rejects.toThrow();
    expect(operations.lifecycle.poisoned()).toMatch(/operation limit/);
    const statements = setup({ ceilings: small });
    await arm(statements);
    await expect(statements.lifecycle.runCase("case one", async () => { for (let i = 0; i < 3; i += 1) await statements.lifecycle.fixtureWrite("a fixture", 1, async () => 1); })).rejects.toThrow();
    expect(statements.lifecycle.poisoned()).toMatch(/fixture-write budget/);
    const rows = setup({ ceilings: small });
    await arm(rows);
    await expect(rows.lifecycle.runCase("case one", async () => void (await rows.lifecycle.fixtureWrite("a fixture", 6, async () => 1)))).rejects.toThrow();
    expect(rows.lifecycle.poisoned()).toMatch(/fixture-write budget/);
    const polls = setup({ ceilings: small });
    await arm(polls);
    await expect(polls.lifecycle.runCase("case one", async () => { await polls.lifecycle.poll("a poll", async () => 1); await polls.lifecycle.poll("a poll", async () => 1); })).rejects.toThrow();
    expect(polls.lifecycle.poisoned()).toMatch(/limit of activity polls/);
    const clock = { now: 0 };
    const deadline = setup({ now: () => clock.now, ceilings: { ...CEILINGS, runDeadlineMs: 1000 } });
    await arm(deadline);
    clock.now = 1001;
    await expect(deadline.lifecycle.runCase("case one", async () => void (await deadline.lifecycle.read("late", async () => 1)))).rejects.toThrow();
    expect(deadline.lifecycle.poisoned()).toMatch(/whole-run deadline/);
    await expect(arm(setup({ ceilings: { ...CEILINGS, operations: 2 } }))).resolves.toBeUndefined();
  });

  it("the final cleanup runs only for an armed, clean, complete, idle run; it deletes EXACTLY the registered markers and demands zero residue", async () => {
    const poisoned = setup();
    await arm(poisoned);
    poisoned.lifecycle.poison("something went wrong");
    const quiet = cleanDb();
    await poisoned.lifecycle.runFinalCleanup(quiet);
    expect(quiet.log).toEqual([]);
    expect((await finish(poisoned)).cleanup).toMatchObject({ attempted: false, skipped: expect.stringContaining("nothing was sent") });

    const incomplete = setup();
    await arm(incomplete);
    await incomplete.lifecycle.runCase("case one", async () => undefined);
    const db = cleanDb();
    await incomplete.lifecycle.runFinalCleanup(db);
    expect(db.log).toEqual([]);
    expect(incomplete.lifecycle.poisoned()).toMatch(/before every expected case had completed/);

    const neverArmed = setup();
    const never = cleanDb();
    await neverArmed.lifecycle.runFinalCleanup(never);
    expect(never.log).toEqual([]);
    expect(neverArmed.lifecycle.poisoned()).toBeNull();

    const exact = setup();
    await arm(exact);
    const list = exact.nonces.registerMany("many", 250);
    for (const name of CASES) await exact.lifecycle.runCase(name, async () => undefined);
    const sent = cleanDb();
    await exact.lifecycle.runFinalCleanup(sent);
    const deletions = sent.log.length;
    expect(deletions).toBeGreaterThan(0);
    // 250 owned markers are deleted in three exact lists of at most 100 each, in registration order.
    const chunks: string[][] = [];
    const recording = { q: async (text: string, params: unknown[] = []) => { if (text === DELETE_OWNED_MARKERS_SQL) chunks.push(params[0] as string[]); return cleanDb().q(text, params); } };
    const again = setup();
    await arm(again);
    again.nonces.registerMany("many", 250);
    for (const name of CASES) await again.lifecycle.runCase(name, async () => undefined);
    await again.lifecycle.runFinalCleanup(recording);
    expect(chunks.map((chunk) => chunk.length)).toEqual([100, 100, 50]);
    expect(chunks.flat()).toEqual(again.nonces.owned());
    expect(list).toHaveLength(250);
  });

  it("a cleanup that is not confirmed poisons: marker residue, an unowned deletion, an extra row, a failing statement, a second cleanup, and a deadline", async () => {
    const attempt0 = async (db: ReturnType<typeof cleanDb>) => {
      const run = setup();
      await arm(run);
      run.nonces.register("one");
      for (const name of CASES) await run.lifecycle.runCase(name, async () => undefined);
      await run.lifecycle.runFinalCleanup(db);
      return { lifecycle: run.lifecycle, report: await finish(run) };
    };
    const attempt = async (db: ReturnType<typeof cleanDb> | { q: (text: string, params?: unknown[]) => Promise<unknown[]> }, overrides: Partial<Parameters<typeof createLoginChallengeUsesLifecycle>[0]> = {}) => {
      const run = setup(overrides);
      await arm(run);
      run.nonces.register("one");
      for (const name of CASES) await run.lifecycle.runCase(name, async () => undefined);
      await expect(run.lifecycle.runFinalCleanup(db as never)).rejects.toThrow(/not confirmed|deadline/);
      return run;
    };
    expect((await attempt(cleanDb({ markerResidue: 1 }))).lifecycle.poisoned()).toMatch(/marker residue 1/);
    expect((await attempt(cleanDb({ deleted: (chunk) => [...chunk, "f".repeat(32)] }))).lifecycle.poisoned()).toMatch(/not confirmed/);
    expect((await attempt(cleanDb({ deleted: (chunk) => [...chunk, ...chunk] }))).lifecycle.poisoned()).toMatch(/not confirmed/);
    const failing = { q: async (text: string) => { if (text === DELETE_OWNED_MARKERS_SQL) throw sqlError("40001"); return cleanDb().q(text); } };
    expect((await attempt(failing)).lifecycle.poisoned()).toMatch(/not confirmed/);
    const slow = { q: async () => new Promise<never[]>(() => undefined) };
    expect((await attempt(slow, { cleanupDeadlineMs: 30 })).lifecycle.poisoned()).toMatch(/exceeded its 30 ms deadline|not confirmed/);

    // Markers the run minted but never inserted (a rejected pre-filter, a rolled-back holder) are simply absent: the exact deletion removes nothing for them and the residue read still demands an empty table.
    const absent = await attempt0(cleanDb({ deleted: () => [] }));
    expect(absent.lifecycle.poisoned()).toBeNull();
    expect(absent.report.cleanup).toMatchObject({ accepted: true, markersDeleted: 0, markerResidue: 0 });

    const twice = setup();
    await arm(twice);
    for (const name of CASES) await twice.lifecycle.runCase(name, async () => undefined);
    await twice.lifecycle.runFinalCleanup(cleanDb());
    await expect(twice.lifecycle.runFinalCleanup(cleanDb())).resolves.toBeUndefined();
    expect(twice.lifecycle.poisoned()).toMatch(/second final cleanup/);
  });

  it("scratch schemas are dropped only after a read-only admission, with RESTRICT, and the sealed registry cannot grow again", async () => {
    const run = setup();
    await arm(run);
    const schema = run.ownership.registerScratchSchema("a01");
    run.ownership.registerScratchObject(schema, "table", "real_login_challenge_uses");
    for (const name of CASES) await run.lifecycle.runCase(name, async () => undefined);
    const log: string[] = [];
    const db = {
      q: async (text: string, params: unknown[] = []) => {
        log.push(text);
        if (text === SCHEMA_INVENTORY_SQL) return [{ kind: "table", name: "real_login_challenge_uses" }];
        if (text === SCHEMA_EXTERNAL_DEPENDENCIES_SQL) return [{ foreign_keys: 0, triggers: 0, inheritance: 0, view_references: 0 }];
        if (text === SCHEMA_RESIDUE_SQL) return [{ n: 0 }];
        if (text.startsWith("DROP ")) return [];
        return cleanDb().q(text, params);
      },
    };
    await run.lifecycle.runFinalCleanup(db);
    const drops = log.filter((text) => text.startsWith("DROP "));
    expect(drops).toEqual([`DROP TABLE ${schema}.real_login_challenge_uses RESTRICT`, `DROP SCHEMA ${schema} RESTRICT`]);
    expect(log.join(" ")).not.toMatch(/CASCADE/);
    expect(log.indexOf(SCHEMA_INVENTORY_SQL)).toBeLessThan(log.findIndex((text) => text.startsWith("DROP ")));
    expect(() => run.ownership.registerScratchSchema("late")).toThrow(/sealed/);
    // A schema holding something unregistered is not dropped.
    const stray = setup();
    await arm(stray);
    const strayName = stray.ownership.registerScratchSchema("a02");
    stray.ownership.registerScratchObject(strayName, "table", "real_login_challenge_uses");
    for (const name of CASES) await stray.lifecycle.runCase(name, async () => undefined);
    const sent: string[] = [];
    await expect(stray.lifecycle.runFinalCleanup({ q: async (text: string, params: unknown[] = []) => { sent.push(text); return text === SCHEMA_INVENTORY_SQL ? [{ kind: "table", name: "real_login_challenge_uses" }, { kind: "table", name: "surprise" }] : cleanDb().q(text, params); } })).rejects.toThrow(/not confirmed/);
    expect(sent.some((text) => text.startsWith("DROP "))).toBe(false);
  });

  it("the final report is honest: a poisoned run is never COMPLETED_CLEAN, a delta mismatch is its own outcome, and nothing is ever 'restored'", async () => {
    const mismatch = setup();
    await arm(mismatch);
    for (const name of CASES) await mismatch.lifecycle.runCase(name, async () => undefined);
    await mismatch.lifecycle.runFinalCleanup(cleanDb());
    const report: FinalReport = await finish(mismatch, { ...cleanDelta(), ok: false, verdict: "delta_mismatch", differences: ["contents changed: payment_attempts"] });
    expect(report.outcome).toBe("COMPLETED_DELTA_MISMATCH");
    expect(concludeLoginChallengeUsesRun(report, { start: OK_START, final: OK_START }).pass).toBe(false);
    const missingCase = setup();
    await arm(missingCase);
    await missingCase.lifecycle.runCase("case one", async () => undefined);
    const incomplete = await finish(missingCase);
    expect(incomplete.outcome).toBe("POISONED");
    expect(incomplete.notExecuted).toEqual(["case two"]);
    expect(incomplete.completeRestoration).toBe(false);
    const unread = setup();
    await arm(unread);
    for (const name of CASES) await unread.lifecycle.runCase(name, async () => undefined);
    await unread.lifecycle.runFinalCleanup(cleanDb());
    const unreadable = await unread.lifecycle.finish({ compare: async () => { throw new Error("could not read"); } });
    expect(unreadable.outcome).toBe("POISONED");
    expect(unreadable.poisoned).toMatch(/post-run comparison could not be read/);
    const notStarted = await finish(setup());
    expect(notStarted).toMatchObject({ outcome: "NOT_STARTED", disposition: "not_started", poisoned: null });
    expect(concludeLoginChallengeUsesRun(notStarted, { start: OK_START, final: OK_START }).pass).toBe(false);
    // A write during the post-run comparison poisons it.
    const writer = setup();
    await arm(writer);
    for (const name of CASES) await writer.lifecycle.runCase(name, async () => undefined);
    await writer.lifecycle.runFinalCleanup(cleanDb());
    const writing = await writer.lifecycle.finish({ compare: async (read) => { await read("a read", async () => 1); await writer.lifecycle.write("a write", async () => 1); return cleanDelta(); } });
    expect(writing.outcome).toBe("POISONED");
    expect(writing.poisoned).toMatch(/during the post-run comparison/);
  });

  it("construction refuses bad deadlines and empty or duplicated case and check lists", () => {
    const ownership = createRunOwnership(RUN);
    const nonces = createNonceRegistry(RUN);
    const base = { expectedCases: CASES, requiredPreflightChecks: CHECKS, caseDeadlineMs: 1000, cleanupDeadlineMs: 1000, ownership, nonces };
    for (const bad of [{ caseDeadlineMs: 0 }, { cleanupDeadlineMs: 1.5 }, { preflightDeadlineMs: -1 }, { expectedCases: [] }, { expectedCases: ["a", "a"] }, { requiredPreflightChecks: [] }, { requiredPreflightChecks: ["a", "a"] }]) {
      expect(() => createLoginChallengeUsesLifecycle({ ...base, ...bad } as never), JSON.stringify(bad)).toThrow();
    }
  });
});

// ------------------------------------------------------------------ the live file, statically

describe("the live smoke file: static shape", () => {
  const source = readFileSync(SMOKE, "utf8");
  const fixtureSource = readFileSync(FIXTURE, "utf8");
  const uncommented = (text: string) =>
    text
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");
  const codeOfFile = uncommented(source);
  const offlineStart = codeOfFile.indexOf('\ndescribe("login challenge uses smoke harness"');
  const liveStart = codeOfFile.indexOf("\ndescribe.skipIf(!enabled)");
  expect(offlineStart).toBeGreaterThan(0);
  expect(liveStart).toBeGreaterThan(offlineStart);
  const live = codeOfFile.slice(liveStart);
  // Everything except the file's own offline block (whose assertions quote the code they look for).
  const code = codeOfFile.slice(0, offlineStart) + live;
  const fixtureCode = uncommented(fixtureSource);

  it("is this harness's registered file, gated by its OWN variable only, and never reads DATABASE_URL or any env value of its own", () => {
    expect(SMOKE).toBe("test/lib/real/login-challenge-uses.smoke.test.ts");
    expect(checkLoginChallengeUsesFileSelection(["run", SMOKE])).toEqual({ ok: true });
    expect(checkLoginChallengeUsesFileSelection(["run", SMOKE, "-t", "M4"]).ok).toBe(false);
    expect(checkLoginChallengeUsesFileSelection(["run", SMOKE, "test/lib/real/other.test.ts"]).ok).toBe(false);
    expect(checkLoginChallengeUsesFileSelection(["run"]).ok).toBe(false);
    expect(code).toContain('const GATE = "REAL_SMOKE_LOGIN_CHALLENGE_USES";');
    expect(code).toContain("const ALLOWED_GATES = [GATE] as const;");
    expect(code).toContain('const enabled = process.env[GATE] === "1";');
    expect(code.match(/process\.env\b[.[]\w+\]?/g)).toEqual(["process.env[GATE]"]);
    expect(code.match(/process\.env\b(?![.[])/g)).toHaveLength(1); // handed whole, once, to the authorization check
    expect(code).toContain("checkRunAuthorization({ env: process.env, identity: sourceIdentity, evidenceDirectory: EVIDENCE_DIRECTORY })");
    expect(code).not.toMatch(/DATABASE_URL/);
    expect(fixtureCode).not.toMatch(/process\.env|DATABASE_URL|\bfetch\(|\bnew URL\(/);
  });

  it("the live block's first hook refuses in a fixed order — target, pooled mode, exact file, timeouts, migrations, marker statement, authorization, budget — and only then connects", () => {
    const hook = /\n {2}beforeAll\(async \(\) => \{\n([\s\S]*?)\n {2}\}, VITEST_TIMEOUT_MS\);/.exec(code)?.[1] ?? "";
    const order = [
      "const url = requireDisposableTargetUrl(GATE, ALLOWED_GATES);",
      "const mode = requirePooledMode(parseDatabaseUrl(url, false));",
      'const selection = checkLoginChallengeUsesFileSelection(inject("vitestCliArgs"));',
      'const timeouts = checkRunnerTimeoutFlags(inject("vitestCliArgs"));',
      "const identities = checkMigrationIdentities(schemaText);",
      "const markerSql = checkProductionMarkerSql(captured);",
      "const repository = readRepositoryHead();",
      "const authorization = checkRunAuthorization(",
      "plannedBudget = planBudget(scenarioInventory());",
      "runId = authorization.runId;",
      "console.log(`[login-challenge-uses-smoke] connection_mode: ${mode.mode}`);",
      "started = true;",
      "db = await connectSmokeDb(url);",
      "const stores = await connectSmokeStores(url);",
      "await lifecycle.runPreflight(async () => {",
    ].map((line) => hook.indexOf(line));
    expect(order[0]).toBe(hook.search(/\S/));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const refusal of ["mode", "selection", "timeouts", "identities", "markerSql", "repository", "authorization"]) expect(hook, refusal).toMatch(new RegExp(`if \\(!${refusal}\\.ok\\) throw new Error\\(\`Login challenge uses smoke refused before any database work: \\$\\{${refusal}\\.reason\\}\`\\);`));
    expect(hook).toContain("if (!plannedBudget.ok) throw new Error(`Login challenge uses smoke refused before any database work: ${plannedBudget.violations.join(\"; \")}`);");
    // One live block, and it is the only place a connector is called.
    expect(code.match(/^describe\.skipIf\(/gm)).toEqual(["describe.skipIf("]);
    expect(code).toContain('describe.skipIf(!enabled)("login challenge uses — schema block, production marker statement, and real concurrency (DISPOSABLE BRANCH ONLY)", () => {');
    expect(code.match(/connectSmoke(?:Db|Stores)\(/g)).toHaveLength(2);
    expect(code).not.toMatch(/createNeon\w+\(|\bneon\(|new URL\([^)]*\)\.(hostname|host)\b|-pooler/);
    // The arming: every check, the baseline, the START evidence, and only then the arming — once.
    const preflight = hook.slice(hook.indexOf("await lifecycle.runPreflight(async () => {"));
    expect(preflight.indexOf("baseline = await snapshot(lifecycle.read);")).toBeGreaterThan(0);
    expect(preflight.indexOf('startSaved = writeLoginChallengeUsesEvidence({ directory: EVIDENCE_DIRECTORY, runId, stage: "start", evidence: startEvidence });')).toBeGreaterThan(preflight.indexOf("baseline = await snapshot(lifecycle.read);"));
    expect(preflight.indexOf("lifecycle.arm({ startEvidence: startSaved });")).toBeGreaterThan(preflight.indexOf("startSaved = writeLoginChallengeUsesEvidence("));
    expect(code.match(/lifecycle\.arm\(/g)).toHaveLength(1);
    expect(code.match(/connectSmokeDb\(/g)).toHaveLength(1);
  });

  it("every preflight check is registered, recorded once, and has a stable name", () => {
    const checks = [...source.matchAll(/lifecycle\.preflightCheck\("([^"]+)"/g)].map((match) => match[1]);
    const listed = /const PREFLIGHT_CHECKS = \[([\s\S]*?)\] as const;/.exec(source)?.[1] ?? "";
    const names = [...listed.matchAll(/^ {2}"([^"]+)",$/gm)].map((match) => match[1]);
    expect(names).toHaveLength(11);
    expect([...checks].sort()).toEqual([...names].sort());
    expect(new Set(checks).size).toBe(checks.length);
    expect(names).toContain("no relation named real_login_challenge_uses exists in any schema");
    expect(names).toContain("no scratch schema of this harness's shape exists");
    expect(names).toContain("public.real_registration_admission does not exist (a branch an earlier smoke used is refused)");
  });

  it("isolation is read through ONE single-statement request — the production path — never inside a batch", () => {
    const hook = /\n {2}beforeAll\(async \(\) => \{\n([\s\S]*?)\n {2}\}, VITEST_TIMEOUT_MS\);/.exec(code)?.[1] ?? "";
    const identity = hook.slice(hook.indexOf('one(await lifecycle.read("reading the server\'s identity"'), hook.indexOf("facts.server ="));
    expect(identity).toContain("db.q(");
    expect(identity).not.toContain("db.tx(");
    expect(identity).toContain("pg_catalog.current_setting('transaction_isolation')");
    expect(identity).toContain("pg_catalog.current_setting('default_transaction_isolation')");
    expect(hook).toContain('lifecycle.preflightCheck("a single autocommit statement runs at READ COMMITTED (the path production uses)", server.isolation === "read committed");');
    // The only batches in the whole file: the lock holders and the one clock probe.
    expect(live.match(/db\.tx\(/g)).toHaveLength(8);
    expect(live.match(/db\.tx\(holder\w+\(/g)).toHaveLength(7);
    expect(live.match(/db\.tx\(\[\.\.\.CLOCK_BATCH\]\)/g)).toHaveLength(1);
  });

  it("every test and hook carries the runner timeout explicitly, and the run's own deadlines are shorter", () => {
    expect(code).toContain("caseDeadlineMs: CASE_DEADLINE_MS, cleanupDeadlineMs: CLEANUP_DEADLINE_MS, preflightDeadlineMs: CASE_DEADLINE_MS, ownership, nonces });");
    expect(code).toContain("const final = await lifecycle.finish({\n      deadlineMs: CLEANUP_DEADLINE_MS,");
    expect(live.match(/\b(it|beforeAll|afterAll|afterEach)\(/g)).toHaveLength(6);
    expect(live.match(/, VITEST_TIMEOUT_MS\);/g)).toHaveLength(6);
    expect(source).toContain("Do NOT pass the older smokes' 30000 ms flags.");
    expect(source).toContain("pnpm exec vitest run test/lib/real/login-challenge-uses.smoke.test.ts\n */");
  });

  it("no case can be skipped: no only/skip/todo, every case is registered through liveCase in order, and the last two tests require them all", () => {
    expect(code).not.toMatch(/\b(it|describe|test)\.(only|skip|todo|fails)\b/);
    expect(code).not.toMatch(/\bskipIf\b(?!\(!enabled\))/);
    const registered = [...live.matchAll(/^ {2}liveCase\(EXPECTED_CASES\[(\d+)\]/gm)].map((match) => Number(match[1]));
    expect(registered).toEqual(Array.from({ length: 19 }, (_, index) => index));
    const names = /const EXPECTED_CASES = \[([\s\S]*?)\] as const;/.exec(source)?.[1] ?? "";
    const cases = [...names.matchAll(/^ {2}"([^"]+)",$/gm)].map((match) => match[1]!);
    expect(cases).toHaveLength(19);
    expect(new Set(cases).size).toBe(19);
    // S4 is two independently bounded cases (the audit found ~208 sequential requests in one); every other case name is unchanged.
    expect(cases.filter((name) => name.startsWith("S4")).map((name) => name.slice(0, 3))).toEqual(["S4a", "S4b"]);
    expect(code).toContain("    it(name, () => lifecycle.runCase(name, body), VITEST_TIMEOUT_MS);");
    expect(code).toContain('  it("every decisive case ran, exactly once, in order", () => {');
    expect(code).toContain("    expect(lifecycle.executed()).toEqual([...EXPECTED_CASES]);");
    expect(code).toContain('  it("Z. the final cleanup removes exactly what this run registered", async () => {');
    expect(live.indexOf('it("Z. the final cleanup')).toBeGreaterThan(live.indexOf('it("every decisive case ran'));
    expect(live.indexOf('it("every decisive case ran')).toBeGreaterThan(live.lastIndexOf("\n  liveCase("));
    // Nothing a case or a check is named can trip the evidence content screen.
    const checks = /const PREFLIGHT_CHECKS = \[([\s\S]*?)\] as const;/.exec(source)?.[1] ?? "";
    for (const name of [...cases, ...[...checks.matchAll(/^ {2}"([^"]+)",$/gm)].map((match) => match[1]!)]) expect(name).not.toMatch(/secret|password|token|credential|bearer|authorization|api[_-]?key|private[_-]?key|\bep-|pooler|postgres(?:ql)?:/i);
    // The look-alike inventory is preserved: 28 + 21, with distinct suffixes (the tables now live in the fixture module, shared with the offline replay).
    const variantCode = fixtureCode.slice(fixtureCode.indexOf('const INDEX = "real_login_challenge_uses_expires_at_idx";'));
    const suffixes = [...variantCode.matchAll(/suffix: "([a-z0-9]+)"/g)].map((match) => match[1]!);
    expect(suffixes.filter((suffix) => /^a\d\d$/.test(suffix))).toHaveLength(28);
    expect(suffixes.filter((suffix) => /^b\d\d$/.test(suffix))).toHaveLength(21);
    expect(new Set(suffixes).size).toBe(suffixes.length);
    expect(suffixes.filter((suffix) => !/^[ab]\d\d$/.test(suffix))).toEqual(["ctlidx", "ctlnoidx", "contrast", "nokey", "apply"]);
    expect(suffixes).toHaveLength(54);
  });

  it("every database call goes through a lifecycle wrapper; every marker request goes through the PRODUCTION adapter; no retry, race, or loop escape exists", () => {
    const calls = live.match(/\bdb\.(?:q|tx)\(/g) ?? [];
    expect(calls.length).toBeGreaterThan(30);
    expect(live.match(/\(\) =>\s*db\.(?:q|tx)\(/g)).toHaveLength(calls.length);
    expect(live).not.toMatch(/await db\.(?:q|tx)\(/);
    expect(code).toContain("store = stores.loginChallengeUses;");
    expect(code.match(/store\.consume\(/g)).toHaveLength(3); // consume, launchConsume, S1's expected error, and nothing else
    expect(code.match(/lifecycle\.consume\(/g)).toHaveLength(1);
    expect(code).not.toMatch(/createInMemory|InMemory/);
    expect(live).not.toMatch(/retry\(|again\(|Promise\.race|Promise\.any|\bbreak\b|\bcontinue\b/i);
    expect(code).toContain("const BURST = 60;");
    // Every launched request is collected in the same case; the number of launches and collections is balanced per kind.
    expect(live.match(/lifecycle\.launch\(/g)!.length + live.match(/launchConsume\(/g)!.length - 1 /* its own definition */).toBeGreaterThanOrEqual(7);
    expect(live.match(/lifecycle\.collect(?:HolderCommitted|HolderRolledBack|Marker|Raw)\(/g)!.length).toBeGreaterThanOrEqual(10);
    // The races depend on observed interleavings: each insists on its own proof.
    expect(live.match(/\binsist\(/g)!.length).toBeGreaterThanOrEqual(11);
    for (const proof of ["blocked >= BURST", "blocked >= 1", "blocked >= 8", "stillHeld >= 1", "admitted,", "afterMs > Date.parse(exp)"]) expect(live, proof).toContain(proof);
  });

  it("it extracts exactly schema.sql's block; a scratch copy differs only in its target-schema constant", () => {
    expect(code).toContain("extractMigrationBlock(readFileSync(SCHEMA_PATH, \"utf8\"), MIGRATION_IDENTITY.name).statement");
    const block = extractMigrationBlock(schemaText, "Login Challenge Uses").statement;
    const scratch = block.replace("target_schema CONSTANT pg_catalog.text := 'public';", "target_schema CONSTANT pg_catalog.text := 'pb_smoke_0a1b2c3d_apply';");
    expect(scratch).not.toContain("'public'");
    expect(scratch.replace("'pb_smoke_0a1b2c3d_apply'", "'public'")).toBe(block);
    expect(code).toContain("const SCRATCH_NAME = /^pb_smoke_[0-9a-f]{8}_[a-z0-9]{1,12}$/;");
    expect(code).toContain("if (!SCRATCH_NAME.test(schemaName)) throw new Error(");
    expect(block).toContain("table_name CONSTANT pg_catalog.text := 'real_login_challenge_uses';");
    expect(block).not.toMatch(/real_rate_limits|real_provider_budgets|payment_attempts|real_registration_admission/);
    // `public` is written to by exactly one helper, which sends the unmodified block, and only the cases that are meant to.
    expect(code.match(/db\.q\(migrationBlock\(\)\)/g)).toHaveLength(1);
    expect(code).toContain("const applyToPublic = (what: string) => lifecycle.write(what, () => db.q(migrationBlock()));");
    expect(code.match(/applyToPublic\(/g)).toHaveLength(2); // the first apply and the rerun (S7 only)
    expect(code).not.toMatch(/search_path|SET LOCAL|set_config/);
  });

  it("it makes no provider call and writes nothing but its own scratch objects, the marker table through pinned fixtures, and the table's name (static)", () => {
    const imports = [...source.matchAll(/^(?:import [^\n]*|\}) from "([^"]+)";$/gm)].map((match) => match[1]).sort();
    expect(imports).toEqual(["./fixtures/handles-smoke-db", "./fixtures/login-challenge-uses-smoke", "./fixtures/provider-budget-smoke", "@/lib/real/server/login-challenge-uses", "node:fs", "vitest"].sort());
    expect(source).not.toMatch(/\bimport\(|\brequire\(/);
    for (const needle of ["turn" + "key", "pim" + "lico", "fet" + "ch(", "createRealSafe" + "Account", "prepareCash" + "Transfer", "/api/" + "real", "issueLoginChal" + "lenge", "navigator.cred" + "entials", "web" + "authn"]) expect(code.toLowerCase(), needle).not.toContain(needle.toLowerCase());
    for (const table of ["payment" + "_attempts", "real" + "_accounts", "real" + "_passkeys", "real_account" + "_handles", "registration" + "_attempts", "webauthn" + "_challenges", "real_provider" + "_budgets"]) expect(code, table).not.toContain(table);
    // real_registration_admission appears only in the preflight: its name in the check list, in the check, and in one read-only count.
    expect(code.match(/real_registration_admission/g)).toHaveLength(3);
    expect(code).toContain("SELECT count(*)::int AS n FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'real_registration_admission'");
    // real_rate_limits is only ever READ (its fingerprint must not change).
    expect(code.match(/real_rate_limits/g)!.length).toBeGreaterThan(0);
    expect(code).not.toMatch(/(INTO|UPDATE|FROM|TABLE|ON)\s+(public\.)?real_rate_limits/i);
    // This file builds NO removal, NO update, NO drop, NO cascade, NO truncation.
    for (const needle of ["DEL" + "ETE", "DR" + "OP ", "TRUNC" + "ATE", "CASC" + "ADE", "UPD" + "ATE", "GR" + "ANT", "REV" + "OKE"]) expect(code.replace(/FOR UPD\w+/g, ""), needle).not.toContain(needle);
    // No statement in the file writes to `public` directly; its marker writes are the pinned fixture statements, the holders, and the production adapter.
    expect(code).not.toMatch(/(INSERT INTO|DELETE FROM|ALTER TABLE|CREATE TABLE|CREATE INDEX|CREATE VIEW|LOCK TABLE)\s+(public\.)/);
    // Every CREATE / ALTER it sends names a scratch schema variable — never `public`, never an unqualified name.
    const variantSource = fixtureCode.slice(fixtureCode.indexOf('const INDEX = "real_login_challenge_uses_expires_at_idx";'));
    const ddl = [...variantSource.matchAll(/\b(CREATE (?:UNLOGGED )?(?:UNIQUE )?(?:TABLE|VIEW|INDEX|FUNCTION|TRIGGER|SCHEMA|POLICY|RULE)|ALTER TABLE|CREATE \$\{[^}]+\}(?:UNIQUE )?INDEX|CREATE \$\{options\.prefix \?\? ""\}TABLE)\b([^`"\n]{0,140})/g)].map((match) => `${match[1]}${match[2]}`);
    expect(ddl.length).toBeGreaterThan(14);
    expect(code).not.toMatch(/\b(CREATE (?:UNLOGGED )?(?:UNIQUE )?(?:TABLE|VIEW|INDEX|FUNCTION|TRIGGER|POLICY|RULE)|ALTER TABLE)\b/); // the live file itself builds only `CREATE SCHEMA` and migration/fixture calls
    for (const statement of ddl) expect(statement, statement).toMatch(/^(CREATE SCHEMA \$\{schema\}|CREATE \$\{options\.prefix \?\? ""\}TABLE \$\{schema\}\.|CREATE \$\{prefix\}INDEX \$\{INDEX\} ON \$\{s\}\.|CREATE (UNLOGGED )?(TABLE|VIEW|FUNCTION) \$\{s\}\.|CREATE INDEX (lcu_extra_idx|\$\{INDEX\}) ON \$\{s\}\.|CREATE TRIGGER lcu_trigger BEFORE INSERT ON \$\{s\}\.|CREATE POLICY lcu_policy ON \$\{s\}\.|CREATE RULE lcu_rule AS ON INSERT TO \$\{s\}\.|ALTER TABLE \$\{s\}\.)/);
    for (const [, target] of variantSource.matchAll(/\b(?:REFERENCES|INHERITS \(|EXECUTE FUNCTION) ?([^ (]+)/g)) expect(target, target).toMatch(/^\$\{s\}\./);
    // Its only file operations are reading sources and, through the fixture's writer, the evidence in the fixed git-ignored directory.
    expect(code.match(/writeFileSync|mkdirSync|appendFileSync|createWriteStream|unlinkSync|rmSync/g)).toBeNull();
    expect(code.match(/writeLoginChallengeUsesEvidence\(/g)).toHaveLength(2);
    expect(code).toContain('const EVIDENCE_DIRECTORY = "evidence";');
    expect(readFileSync(".gitignore", "utf8")).toMatch(/^\/evidence\/$/m);
    // The fixture module imports only the allowed modules (and the production adapter factory, whose import opens no connection).
    const fixtureImports = [...fixtureSource.matchAll(/^(?:import [^\n]*|\}) from "([^"]+)";$/gm)].map((match) => match[1]).sort();
    expect(fixtureImports).toEqual(["./provider-budget-smoke", "./provisioning-limits-smoke", "./registration-admission-smoke", "@/lib/real/server/neon-store", "node:fs", "node:path"].sort());
  });

  it("the marker rows the live file writes are written only through the pinned fixture statements, each counted by statement and row", () => {
    const fixtureWrites = [...live.matchAll(/rowsWrite\("([^"]+)", ([^,]+),/g)].length;
    expect(fixtureWrites).toBeGreaterThanOrEqual(4);
    expect(code).toContain("const rowsWrite = (what: string, rows: number, text: string, params: unknown[] = []) => lifecycle.fixtureWrite(what, rows, () => db.q(text, params));");
    expect(live.match(/lifecycle\.fixtureWrite\(/g)).toHaveLength(1);
    expect(live.match(/INSERT_MARKER_SQL|INSERT_AGED_MARKERS_SQL/g)!.length).toBeGreaterThanOrEqual(2);
    expect(code).toContain("const build = (what: string, text: string) => lifecycle.buildFixture(what, () => db.q(text));");
    expect(code).toContain("await build(`building the look-alike (${variant.what})`, step.sql);");
    expect(live.match(/lifecycle\.buildFixture\(/g)).toHaveLength(1);
  });

  it("every migration refusal goes through expectMigrationRefusal with the variant's own SQLSTATE list; fixtures never do; S4 and S5 run EVERY variant", () => {
    const refusal = /async function refusesAndLeavesUnchanged\(variant: Variant\): Promise<string> \{([\s\S]*?)\n {2}\}/.exec(live)?.[1] ?? "";
    expect(refusal).toContain('variant.allowed ?? ["P0001"]');
    expect(refusal).toContain("lifecycle.expectMigrationRefusal(");
    expect(refusal).not.toMatch(/catch|42703|42704|23\d{3}/);
    expect(live).toContain("for (const variant of GROUP_A1) refusals[variant.suffix] = await refusesAndLeavesUnchanged(variant);");
    expect(live).toContain("for (const variant of GROUP_A2) refusals[variant.suffix] = await refusesAndLeavesUnchanged(variant);");
    expect(live.match(/expect\(Object\.keys\(refusals\)\)\.toHaveLength\(14\);/g)).toHaveLength(2);
    expect(live).toContain("for (const variant of GROUP_B) refusals[variant.suffix] = await refusesAndLeavesUnchanged(variant);");
    expect(live).toContain("expect(Object.keys(refusals)).toHaveLength(21);");
    expect(source).not.toMatch(/(GROUP_A1|GROUP_A2|GROUP_A|GROUP_B)\s*\.\s*(filter|slice|splice|shift|pop)\b/);
    expect(fixtureSource).not.toMatch(/(GROUP_A1|GROUP_A2|GROUP_A|GROUP_B)\s*\.\s*(filter|slice|splice|shift|pop)\b/);
    // Only these two look-alikes may be refused by PostgreSQL itself before the migration's own guard.
    const native = [...fixtureSource.matchAll(/suffix: "(a\d\d|b\d\d)"[^\n]*allowed: \["(\w+)"\]/g)].map((match) => `${match[1]}:${match[2]}`);
    expect(native).toEqual(["a03:42703", "a08:42704"]);
  });

  it("the end of the run: one cleanup through the lifecycle, a tracked comparison, both evidence records, and a verdict that needs all of it", () => {
    expect(code.match(/lifecycle\.runFinalCleanup\(db\)/g)).toHaveLength(1);
    expect(code).toContain("  afterEach((context) => {\n    if (started) lifecycle.afterCase({ reportedFailed: caseFailedInVitest(context) });\n  }, VITEST_TIMEOUT_MS);");
    expect(code.match(/afterEach\(/g)).toHaveLength(1);
    const end = /\n {2}afterAll\(async \(\) => \{\n([\s\S]*?)\n {2}\}, VITEST_TIMEOUT_MS\);/.exec(code)?.[1] ?? "";
    expect(end.trimStart().startsWith("if (!started) return;")).toBe(true);
    expect(end).toContain("after = await snapshot(read);");
    expect(end).toContain('const markerTable = await describeTable(read, "public");');
    expect(end).toContain("return compareWithExpectedMarkerDelta({ before: baseline, after, markerTable, ownedSchemas: ownership.ownedSchemas() });");
    expect(end).not.toMatch(/lifecycle\.(read|write|poll|consume|launch|expectDatabaseRefusal|runFinalCleanup)\b|db\.q\(/);
    expect(end).toContain('const finalSaved = writeLoginChallengeUsesEvidence({ directory: EVIDENCE_DIRECTORY, runId, stage: "final", evidence });');
    expect(end).toContain("const verdict = concludeLoginChallengeUsesRun(final, { start: startSaved, final: finalSaved });");
    expect(end.trimEnd().endsWith("if (!verdict.pass) throw new Error(verdict.message);")).toBe(true);
    expect(end).toMatch(/console\.log\(`\[login-challenge-uses-smoke\] \$\{safeEvidenceJson\(/);
    expect(code.match(/console\.log\(/g)).toHaveLength(2);
    expect(code.match(/afterAll\(/g)).toHaveLength(1);
    for (const field of FINAL_EVIDENCE_FIELDS) expect(end.includes(`${field}`), field).toBe(true);
  });

  it("the header says it was never run, forbids reuse and the real database, and documents the opt-in, the confirmation, the isolation path, the bounds, and the leftover", () => {
    const start = source.indexOf("/**\n * MANUAL, LIVE-DATABASE proof");
    const end = source.indexOf("const GATE =");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const header = source
      .slice(start, end)
      .split("\n")
      .map((line) => line.replace(/^\s*(\/\*\*|\*\/|\*)\s?/, ""))
      .join(" ")
      .replace(/\s+/g, " ");
    for (const phrase of [
      "IT HAS NEVER BEEN RUN LIVE.",
      "Separate explicit authorization is needed before its first live execution.",
      "EXPLICITLY OPT-IN, AND NOT RUN as part of the build",
      "It must NEVER be pointed at the real database",
      "ced714ee and c20ffc87",
      "RUN AUTHORIZATION.",
      "so a confirmation never authorizes different code than was audited, a different branch endpoint, or a different run",
      "that connects to nothing",
      "a detached or unreadable HEAD is refused",
      "There is no fallback and no bypass.",
      "FRESH BRANCH, ONE RUN.",
      "Never rerun on a used branch.",
      "ISOLATION IS CHECKED ON THE PATH PRODUCTION USES.",
      "It does not infer it from a batch.",
      "HOW THE RACES ARE BUILT.",
      "If the interleaving is not observed, the run is poisoned",
      "No Neon branch is ever deleted by this file.",
      'It is never reported as "restored".',
      "A fixture that cannot be constructed is reported as a HARNESS FAILURE, never as a migration refusal.",
    ]) expect(header, phrase).toContain(phrase);
    expect(source).toContain('NEON_BRANCH_EXPECTED_ENDPOINT_ID="ep-..."');
    expect(source).toContain("Milestone 0 Pass B: the run also requires NEON_BRANCH_EXPECTED_ENDPOINT_ID");
    expect(header).not.toMatch(/ONE CONTROLLED LIVE RUN HAS COMPLETED|run [0-9a-f]{8}, 20/);
  });
});

// ------------------------------------------------------------------ the gate, in a real child process (synthetic values only)

describe("the gate, in real child Vitest processes with synthetic `.invalid` values: refused before any connection, and inert without the gate", () => {
  const PROCESS_TIMEOUT_MS = 120_000;
  const GATE = "REAL_SMOKE_LOGIN_CHALLENGE_USES";
  const POOLED = "postgresql://app:synthetic@ep-synthetic-000009-pooler.c-1.neon.invalid/neondb";
  const DIRECT = "postgresql://app:synthetic@ep-synthetic-000009.c-1.neon.invalid/neondb";
  const ENDPOINT = "ep-synthetic-000009";
  const REFUSAL = /refused to connect: |refused before any database work: /;
  const CONNECTION_ATTEMPT = /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|getaddrinfo|NeonDbError|WebSocket/i;
  const FILE_FAILED = /Test Files\s+1 failed/;

  function runVitest(args: string[], extra: Record<string, string>): Promise<{ code: number; output: string }> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value === undefined || /^(VITEST|REAL_SMOKE_|REAL_ADMIN_|NEON_|DATABASE_URL$|TURNKEY_|PIMLICO_|HANDLES_SMOKE_|PAYMENT_RECIPIENT_SMOKE_|LOGIN_CHALLENGE_SMOKE_)/.test(name)) continue;
      env[name] = value;
    }
    return new Promise((resolve) => {
      execFile(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...args], { env: { ...env, ...extra } as NodeJS.ProcessEnv, timeout: PROCESS_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, output: `${stdout}\n${stderr}` });
      });
    });
  }
  const refused = (result: { code: number; output: string }, reason: RegExp) => {
    expect(result.code, result.output.slice(-400)).not.toBe(0);
    expect(result.output).toMatch(REFUSAL);
    expect(result.output).toMatch(reason);
    expect(result.output).toMatch(FILE_FAILED);
    expect(result.output).not.toMatch(CONNECTION_ATTEMPT);
    expect(result.output).not.toContain("synthetic");
  };
  const wellFormed = { [GATE]: "1", NEON_BRANCH_DATABASE_URL: POOLED, NEON_BRANCH_EXPECTED_ENDPOINT_ID: ENDPOINT };

  it("gate set, no target at all -> refused", async () => {
    refused(await runVitest([SMOKE], { [GATE]: "1" }), /NEON_BRANCH_DATABASE_URL is missing or not a URL/);
  }, PROCESS_TIMEOUT_MS);

  it("gate + a branch URL, no expected endpoint id -> refused", async () => {
    refused(await runVitest([SMOKE], { [GATE]: "1", NEON_BRANCH_DATABASE_URL: POOLED }), /NEON_BRANCH_EXPECTED_ENDPOINT_ID/);
  }, PROCESS_TIMEOUT_MS);

  it("a direct (non-pooled) URL -> refused before anything else", async () => {
    refused(await runVitest([SMOKE], { ...wellFormed, NEON_BRANCH_DATABASE_URL: DIRECT }), /pooled|pooler/i);
  }, PROCESS_TIMEOUT_MS);

  it("an unrelated smoke gate beside this gate -> refused", async () => {
    refused(await runVitest([SMOKE], { ...wellFormed, REAL_SMOKE_REGISTRATION_ADMISSION: "1" }), /unrelated smoke gate/);
  }, PROCESS_TIMEOUT_MS);

  it("a well-formed target but a name filter or a second file -> refused by the exact-file rule", async () => {
    refused(await runVitest([SMOKE, "-t", "M4"], wellFormed), /exactly|single|file/i);
    refused(await runVitest([SMOKE, "test/lib/real/provider-budget-smoke-harness.test.ts"], wellFormed), /exactly|single|file/i);
  }, PROCESS_TIMEOUT_MS);

  it("a well-formed target but a timeout flag below the safe floor -> refused", async () => {
    refused(await runVitest([SMOKE, "--testTimeout=30000", "--hookTimeout=30000"], wellFormed), /120000|timeout/i);
  }, PROCESS_TIMEOUT_MS);

  it("a well-formed target but no run id, then no confirmation, then a spent run id, then a wrong confirmation -> every one refused before a connection", async () => {
    refused(await runVitest([SMOKE], wellFormed), /LOGIN_CHALLENGE_SMOKE_RUN_ID is not set/);
    refused(await runVitest([SMOKE], { ...wellFormed, LOGIN_CHALLENGE_SMOKE_RUN_ID: "1a2b3c4d" }), /LOGIN_CHALLENGE_SMOKE_CONFIRM is not set/);
    refused(await runVitest([SMOKE], { ...wellFormed, LOGIN_CHALLENGE_SMOKE_RUN_ID: "c20ffc87", LOGIN_CHALLENGE_SMOKE_CONFIRM: "c20ffc87:0000000000000000" }), /already spent/);
    refused(await runVitest([SMOKE], { ...wellFormed, LOGIN_CHALLENGE_SMOKE_RUN_ID: "1a2b3c4d", LOGIN_CHALLENGE_SMOKE_CONFIRM: "1a2b3c4d:0000000000000000" }), /does not match this run id, this endpoint, and the source identity/);
    refused(await runVitest([SMOKE], { ...wellFormed, LOGIN_CHALLENGE_SMOKE_RUN_ID: "not-hex", LOGIN_CHALLENGE_SMOKE_CONFIRM: "x" }), /8 lowercase hex/);
  }, PROCESS_TIMEOUT_MS);

  it("without the gate nothing live runs, whatever else is exported: every live test is skipped, exit 0", async () => {
    const { code, output } = await runVitest([SMOKE], { DATABASE_URL: DIRECT, NEON_BRANCH_DATABASE_URL: POOLED, NEON_BRANCH_EXPECTED_ENDPOINT_ID: ENDPOINT, LOGIN_CHALLENGE_SMOKE_RUN_ID: "1a2b3c4d", LOGIN_CHALLENGE_SMOKE_CONFIRM: "1a2b3c4d:0000000000000000" });
    expect(code, output.slice(-400)).toBe(0);
    expect(/Tests\s+([^\n]*)/.exec(output)?.[1]).toMatch(/passed.*skipped/);
    expect(output).not.toMatch(REFUSAL);
    expect(output).not.toMatch(CONNECTION_ATTEMPT);
  }, PROCESS_TIMEOUT_MS);
});

// ------------------------------------------------------------------ H-1: the scratch registry's capacity

describe("H-1: the shared scratch-schema registry keeps its default of 40, accepts an explicit bounded capacity, and the live run's 54 schemas fit", () => {
  const registerMany = (ownership: ReturnType<typeof createRunOwnership>, count: number) => Array.from({ length: count }, (_, index) => ownership.registerScratchSchema(`s${index}`));
  const snapshot = (ownership: ReturnType<typeof createRunOwnership>) => JSON.stringify({ schemas: ownership.ownedSchemas(), objects: ownership.ownedSchemas().map((schema) => ownership.objectsOf(schema)), sealed: ownership.sealed(), capacity: ownership.scratchSchemaCapacity() });

  it("the shared default is exactly 40, for a registry created with no option, an empty option object, or an undefined option", () => {
    expect(MAX_RUN_SCRATCH_SCHEMAS).toBe(40);
    expect(MAX_RUN_SCRATCH_OBJECTS).toBe(120);
    expect(MAX_CONFIGURABLE_SCRATCH_SCHEMAS).toBe(60);
    for (const options of [undefined, {}] as const) {
      const ownership = createRunOwnership(RUN, options);
      expect(ownership.scratchSchemaCapacity()).toBe(40);
      registerMany(ownership, 40);
      expect(ownership.ownedSchemas()).toHaveLength(40);
      expect(() => ownership.registerScratchSchema("s40")).toThrow(/scratch-schema limit/); // registration 41 is refused
      expect(ownership.ownedSchemas()).toHaveLength(40);
    }
    expect(resolveScratchSchemaCapacity(undefined)).toBe(40);
    expect(resolveScratchSchemaCapacity({})).toBe(40);
  });

  it("a requested capacity must be a whole number from 1 to 60: nothing else is accepted, and nothing is clamped", () => {
    for (const value of [1, 2, 40, 54, 56, 59, 60]) expect(createRunOwnership(RUN, { maxScratchSchemas: value }).scratchSchemaCapacity()).toBe(value);
    for (const value of [0, -1, -60, 1.5, 55.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 61, 100, 1000, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 2, "56", "", null, undefined, true, false, [], {}, [56], BigInt(56)]) {
      expect(() => createRunOwnership(RUN, { maxScratchSchemas: value as never }), String(value)).toThrow(/maxScratchSchemas must be a whole number from 1 to 60/);
    }
    for (const options of ["56", 56, null, [], [{ maxScratchSchemas: 56 }], true] as const) expect(() => createRunOwnership(RUN, options as never), JSON.stringify(options)).toThrow(/options must be an object/);
    expect(() => createRunOwnership(RUN, { maxScratchSchemas: 56, extra: 1 } as never)).toThrow(/unknown ownership option/);
    expect(() => createRunOwnership(RUN, { other: 1 } as never)).toThrow(/unknown ownership option/);
    // The run id rules are unchanged.
    expect(() => createRunOwnership("0A1B2C3D", { maxScratchSchemas: 56 })).toThrow(/run id/);
  });

  it("a registry never exceeds the hard cap of 60, however it is configured; the object and nonce caps do not move", () => {
    const ownership = createRunOwnership(RUN, { maxScratchSchemas: 60 });
    registerMany(ownership, 60);
    expect(() => ownership.registerScratchSchema("s60")).toThrow(/scratch-schema limit/);
    expect(ownership.ownedSchemas()).toHaveLength(60);
    // The scratch-OBJECT cap stays 120 for every registry, and a bigger schema cap does not raise it.
    const objects = createRunOwnership(RUN, { maxScratchSchemas: 60 });
    const schemas = registerMany(objects, 60);
    for (let i = 0; i < MAX_RUN_SCRATCH_OBJECTS; i += 1) objects.registerScratchObject(schemas[i % schemas.length]!, "table", `t_${i}`);
    expect(() => objects.registerScratchObject(schemas[0]!, "table", "one_too_many")).toThrow(/scratch-object limit/);
    // The marker (nonce) cap is a different registry and is untouched.
    const nonces = createNonceRegistry(RUN);
    nonces.registerMany("fill", NONCE_REGISTRY_CAP);
    expect(() => nonces.register("one-too-many")).toThrow(/nonce limit/);
    expect(NONCE_REGISTRY_CAP).toBe(600);
  });

  it("a registration refused at capacity changes NOTHING: schemas, objects, sealing, and capacity are exactly as before", () => {
    const ownership = createRunOwnership(RUN, { maxScratchSchemas: 3 });
    const [a] = registerMany(ownership, 3);
    ownership.registerScratchObject(a!, "table", "first");
    const before = snapshot(ownership);
    expect(() => ownership.registerScratchSchema("fourth")).toThrow(/scratch-schema limit/);
    expect(snapshot(ownership)).toBe(before);
    // A refused object (an unowned schema, a duplicate name, a bad kind) changes nothing either.
    expect(() => ownership.registerScratchObject(`pb_smoke_${RUN}_unowned`, "table", "x")).toThrow(/does not own/);
    expect(() => ownership.registerScratchObject(a!, "table", "first")).toThrow(/used twice/);
    expect(() => ownership.registerScratchObject(a!, "index" as never, "y")).toThrow();
    expect(snapshot(ownership)).toBe(before);
    // A duplicate schema suffix is refused without a partial entry, and sealing still closes registration for good.
    expect(() => ownership.registerScratchSchema("s0")).toThrow(/used twice|limit/);
    expect(snapshot(ownership)).toBe(before);
    ownership.seal("the cleanup began");
    expect(() => ownership.registerScratchSchema("late")).toThrow(/sealed/);
    expect(ownership.sealed()).toBe("the cleanup began");
  });

  it("the live run's registry holds all 54 planned schemas: the EXACT registration sequence of its cases, replayed through the same factory", () => {
    expect(REGISTRATION_ORDER).toHaveLength(54);
    expect(REGISTRATION_ORDER[0]).toBe(APPLY_PLAN);
    expect(SCRATCH_SCHEMA_REGISTRY_CAPACITY).toBe(56);
    expect(checkScratchCapacity(REGISTRATION_ORDER.length, SCRATCH_SCHEMA_REGISTRY_CAPACITY)).toEqual({ ok: true });
    const ownership = createLoginChallengeUsesOwnership(RUN);
    expect(ownership.scratchSchemaCapacity()).toBe(56);
    const created: string[] = [];
    for (const plan of REGISTRATION_ORDER) created.push(registerPlan(ownership, plan));
    expect(ownership.ownedSchemas()).toEqual(created);
    expect(ownership.ownedSchemas()).toHaveLength(54);
    expect(new Set(created).size).toBe(54);
    expect(created.every((schema) => /^pb_smoke_0a1b2c3d_[a-z0-9]{1,12}$/.test(schema))).toBe(true);
    // The order is the order of the cases: S2's apply schema, S4a's controls and a01-a14, S4b's a15-a28, S5's b01-b21, M8's contrast, M11's missing key.
    expect(REGISTRATION_ORDER.map((plan) => plan.suffix)).toEqual(["apply", "ctlidx", "ctlnoidx", ...GROUP_A1.map((v) => v.suffix), ...GROUP_A2.map((v) => v.suffix), ...GROUP_B.map((v) => v.suffix), "contrast", "nokey"]);
    expect(REGISTRATION_ORDER[40]!.suffix).toBe("b10"); // the registration the audit found refused
    // Every registered object is exactly what the plan said, per schema, and the total stays inside the shared object cap.
    let objects = 0;
    for (const [index, plan] of REGISTRATION_ORDER.entries()) {
      const owned = ownership.objectsOf(created[index]!);
      expect(owned.map((object) => [object.kind, object.name])).toEqual(plan.objects.map(([kind, name]) => [kind, name]));
      objects += owned.length;
    }
    expect(objects).toBe(REGISTRATION_ORDER.reduce((sum, plan) => sum + plan.objects.length, 0));
    expect(objects).toBeLessThanOrEqual(MAX_RUN_SCRATCH_OBJECTS);
    // The nonce registry the live run uses has room for every marker it can mint.
    const nonces = createNonceRegistry(RUN);
    expect(nonces.registerMany("every", NONCE_REGISTRY_CAP)).toHaveLength(NONCE_REGISTRY_CAP);
    // Two more fit (the margin); the next is refused, with no partial change; and sealing closes it.
    ownership.registerScratchSchema("margin1");
    ownership.registerScratchSchema("margin2");
    const before = snapshot(ownership);
    expect(() => ownership.registerScratchSchema("margin3")).toThrow(/scratch-schema limit/);
    expect(snapshot(ownership)).toBe(before);
    expect(ownership.ownedSchemas()).toHaveLength(56);
    ownership.seal("the final cleanup began");
    expect(() => ownership.registerScratchSchema("after-seal")).toThrow(/sealed/);
  });

  it("REGRESSION SENSITIVITY: the previous behavior (a registry created without the option) is refused at S5 variant b10, after 40 schemas", () => {
    const legacy = createRunOwnership(RUN);
    let registered = 0;
    let refusedAt: string | null = null;
    for (const plan of REGISTRATION_ORDER) {
      try {
        registerPlan(legacy, plan);
        registered += 1;
      } catch (error) {
        expect(String((error as Error).message)).toMatch(/scratch-schema limit/);
        refusedAt = plan.suffix;
        break;
      }
    }
    expect(registered).toBe(40);
    expect(refusedAt).toBe("b10");
    expect(legacy.ownedSchemas()).toHaveLength(40);
    // ...and the fixed factory is NOT satisfied by a registry that ignores the option: a capacity below the plan is refused before anything runs.
    expect(checkScratchCapacity(54, 40)).toEqual({ ok: false, reason: "the run plans 54 scratch schemas but its registry holds only 40" });
    expect(checkScratchCapacity(54, 53).ok).toBe(false);
    expect(checkScratchCapacity(54, 54)).toEqual({ ok: true });
    expect(checkScratchCapacity(54, 61).ok).toBe(false);
    expect(checkScratchCapacity(54, 1000).ok).toBe(false);
    expect(checkScratchCapacity(-1, 56).ok).toBe(false);
    expect(checkScratchCapacity(54, 0).ok).toBe(false);
    expect(checkScratchCapacity(54.5, 56).ok).toBe(false);
  });

  it("only the 3C-2 fixture asks for a larger capacity; the live file builds its registry through that one factory; the other smokes are untouched", () => {
    const asked = ["test/lib/real/provider-budget.smoke.test.ts", "test/lib/real/registration-admission.smoke.test.ts", "test/lib/real/provider-budget-lifecycle.probe.test.ts", "test/lib/real/provisioning-limits.smoke.test.ts", FIXTURE, SMOKE].filter((file) => existsSync(file) && /maxScratchSchemas/.test(readFileSync(file, "utf8")));
    expect(asked).toEqual([FIXTURE]);
    for (const file of ["test/lib/real/provider-budget.smoke.test.ts", "test/lib/real/registration-admission.smoke.test.ts"]) expect(readFileSync(file, "utf8")).toMatch(/createRunOwnership\(runId\);/);
    const live = readFileSync(SMOKE, "utf8");
    expect(live).toContain("ownership = createLoginChallengeUsesOwnership(runId);");
    expect(live).not.toMatch(/createRunOwnership\(/);
    expect(live).toContain("const capacity = checkScratchCapacity(plannedBudget.totals.scratchSchemas, SCRATCH_SCHEMA_REGISTRY_CAPACITY);");
    // The live source references the plans in the order REGISTRATION_ORDER replays them.
    const code = live.split("\n").filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join("\n");
    const livePart = code.slice(code.indexOf("\ndescribe.skipIf(!enabled)"));
    const order = ["registerPlan(ownership, APPLY_PLAN)", "buildVariant(CONTROL_WITH_INDEX)", "buildVariant(CONTROL_WITHOUT_INDEX)", "of GROUP_A1)", "of GROUP_A2)", "of GROUP_B)", "buildVariant(CONTRAST_VARIANT)", "buildVariant(NO_KEY_VARIANT)"].map((needle) => livePart.indexOf(needle));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

// ------------------------------------------------------------------ L-2: the shared helpers are bound into the source identity

describe("L-2: the confirmation is bound to the shared helpers and the Neon client wiring too, so changing any of them voids it", () => {
  const sourcesNow = () => ({
    schemaText,
    neonStoreText: readFileSync("lib/real/server/neon-store.ts", "utf8"),
    loginChallengeText: readFileSync("lib/real/server/login-challenge.ts", "utf8"),
    loginChallengeUsesText: readFileSync("lib/real/server/login-challenge-uses.ts", "utf8"),
    harnessSmokeText: readFileSync(SMOKE, "utf8"),
    harnessFixtureText: readFileSync(FIXTURE, "utf8"),
    sharedHelpers: readSharedHelpers(),
  });
  const endpoint = "ep-synthetic-000009";
  const env = (identity: ReturnType<typeof computeSourceIdentity>) => ({ [RUN_ID_ENV]: "1a2b3c4d", [EXPECTED_ENDPOINT_ENV]: endpoint, [CONFIRM_ENV]: expectedConfirmation(identity, "1a2b3c4d", endpoint) });

  it("the five shared helper files are the ones the harness really goes through, and every one exists", () => {
    expect(Object.keys(SHARED_HELPER_FILES).sort()).toEqual(["handlesSmokeDb", "providerBudgetSmoke", "provisioningLimitsSmoke", "registrationAdmissionSmoke", "smokeRunIds"]);
    for (const file of Object.values(SHARED_HELPER_FILES)) expect(existsSync(file), file).toBe(true);
    const imports = (file: string) => [...readFileSync(file, "utf8").matchAll(/from "(\.\/[^"]+)"/g)].map((match) => match[1]);
    const smokeImports = imports(SMOKE);
    const fixtureImports = imports(FIXTURE);
    expect(smokeImports).toContain("./fixtures/handles-smoke-db");
    for (const helper of ["./provider-budget-smoke", "./registration-admission-smoke", "./provisioning-limits-smoke"]) expect(fixtureImports, helper).toContain(helper);
    for (const file of ["test/lib/real/fixtures/provider-budget-smoke.ts", "test/lib/real/fixtures/provisioning-limits-smoke.ts"]) expect(imports(file), file).toContain("./smoke-run-ids");
  });

  it("changing ANY covered input changes the digest AND voids the previous confirmation", () => {
    const base = sourcesNow();
    const identity = computeSourceIdentity(base);
    const authorized = checkRunAuthorization({ env: env(identity), identity, evidenceDirectory: "evidence", fileExists: () => false });
    expect(authorized).toEqual({ ok: true, runId: "1a2b3c4d" });
    const originalConfirmation = env(identity);
    const mutated: Array<[string, ReturnType<typeof sourcesNow>]> = [
      ...(Object.keys(SHARED_HELPER_FILES) as SharedHelperName[]).map((name): [string, ReturnType<typeof sourcesNow>] => [`shared helper ${name}`, { ...base, sharedHelpers: { ...base.sharedHelpers, [name]: `${base.sharedHelpers[name]}\n// changed` } }]),
      ["the Neon isolation constant", { ...base, neonStoreText: base.neonStoreText.replace('NEON_TRANSACTION_ISOLATION_LEVEL = "ReadCommitted"', 'NEON_TRANSACTION_ISOLATION_LEVEL = "Serializable"') }],
      ["the Neon client factory", { ...base, neonStoreText: base.neonStoreText.replace("return neon(databaseUrl, { isolationLevel: NEON_TRANSACTION_ISOLATION_LEVEL });", "return neon(databaseUrl, { isolationLevel: NEON_TRANSACTION_ISOLATION_LEVEL, fullResults: false });") }],
      ["the Neon store wiring", { ...base, neonStoreText: base.neonStoreText.replace("const sql = createNeonSqlClient(databaseUrl);\n  return {\n    challengeStore", "const sql = createNeonSqlClient(databaseUrl);\n  void 0;\n  return {\n    challengeStore") }],
      ["the production adapter", { ...base, neonStoreText: base.neonStoreText.replace("LIMIT 64", "LIMIT 65") }],
      ["the harness fixture", { ...base, harnessFixtureText: `${base.harnessFixtureText}\n// changed` }],
      ["the smoke test", { ...base, harnessSmokeText: `${base.harnessSmokeText}\n// changed` }],
      ["login-challenge.ts", { ...base, loginChallengeText: `${base.loginChallengeText}\n// changed` }],
      ["login-challenge-uses.ts", { ...base, loginChallengeUsesText: `${base.loginChallengeUsesText}\n// changed` }],
    ];
    for (const [name, changedSources] of mutated) {
      expect(changedSources, name).not.toEqual(base);
      const changed = computeSourceIdentity(changedSources);
      expect(changed.digest, name).not.toBe(identity.digest);
      // The confirmation the operator typed for the AUDITED code no longer authorizes this code.
      const verdict = checkRunAuthorization({ env: originalConfirmation, identity: changed, evidenceDirectory: "evidence", fileExists: () => false });
      expect(verdict.ok, name).toBe(false);
      if (!verdict.ok) expect(verdict.reason, name).toMatch(/does not match this run id, this endpoint, and the source identity/);
    }
  });

  it("the Neon client digest is SPECIFIC: an unrelated store in neon-store.ts changes neither it nor the adapter's digest, but is not silently ignored when the wiring changes", () => {
    const base = sourcesNow();
    const identity = computeSourceIdentity(base);
    const unrelated = computeSourceIdentity({ ...base, neonStoreText: base.neonStoreText.replace("export function createNeonChallengeStore(", "export function createNeonChallengeStore (") });
    expect(unrelated.parts.neonClientSource).toBe(identity.parts.neonClientSource);
    expect(unrelated.parts.adapterSource).toBe(identity.parts.adapterSource);
    const excerpt = extractNeonClientSource(base.neonStoreText);
    expect(excerpt).toContain("NEON_TRANSACTION_ISOLATION_LEVEL");
    expect(excerpt).toContain("export function createNeonSqlClient(");
    expect(excerpt).toContain("export function createNeonDurableStores(");
    expect(excerpt).not.toContain("createNeonLoginChallengeUseStore(sql)\n}"); // the adapter's own body is hashed separately, not here
    expect(() => extractNeonClientSource("")).toThrow(/isolation constant was not found/);
    expect(() => extractNeonClientSource(base.neonStoreText.replace("export function createNeonSqlClient(", "export function renamed("))).toThrow(/createNeonSqlClient was not found/);
    expect(() => extractNeonClientSource(base.neonStoreText.replace("export function createNeonDurableStores(", "export function renamed("))).toThrow(/createNeonDurableStores was not found/);
  });

  it("every shared helper must be supplied, nothing else is accepted, and an empty module is refused", () => {
    const base = sourcesNow();
    const without = { ...base.sharedHelpers } as Record<string, string>;
    delete without.smokeRunIds;
    expect(() => computeSourceIdentity({ ...base, sharedHelpers: without as never })).toThrow(/every shared helper module must be supplied/);
    expect(() => computeSourceIdentity({ ...base, sharedHelpers: { ...base.sharedHelpers, extra: "x" } as never })).toThrow(/every shared helper module must be supplied/);
    expect(() => computeSourceIdentity({ ...base, sharedHelpers: { ...base.sharedHelpers, handlesSmokeDb: "" } })).toThrow(/every shared helper module must be supplied/);
    expect(() => computeSourceIdentity({ ...base, sharedHelpers: null as never })).toThrow(/every shared helper module must be supplied/);
    expect(() => computeSourceIdentity({ ...base, sharedHelpers: { ...base.sharedHelpers, providerBudgetSmoke: 5 as never } })).toThrow(/every shared helper module must be supplied/);
  });

  it("the live run hands the identity every shared helper by reading each pinned file; and a source digest is NOT presented as proof of a fresh disposable branch", () => {
    const live = readFileSync(SMOKE, "utf8");
    expect(live).toContain("sharedHelpers: Object.fromEntries(Object.entries(SHARED_HELPER_FILES).map(([name, file]) => [name, readFileSync(file, \"utf8\")])) as Record<SharedHelperName, string>,");
    expect(TARGET_PROOF_STATUS).toMatch(/NOT proof that the branch is newly created or disposable/);
    expect(TARGET_PROOF_STATUS).toMatch(/Neon console evidence/);
    expect(readFileSync(FIXTURE, "utf8")).toMatch(/not evidence that the target is a\s+\* freshly created disposable branch/);
  });
});

// ------------------------------------------------------------------ L-7: cleanup statements are metered

describe("L-7: every cleanup statement is counted before dispatch against the approved ceiling; exhaustion stops the cleanup and poisons the run", () => {
  const CASES = ["case one", "case two"] as const;
  const OK_START: EvidenceResult = { ok: true, file: "x" };
  function setup(cleanupOperations: number = CEILINGS.cleanupOperations) {
    const ownership = createRunOwnership(RUN);
    const nonces = createNonceRegistry(RUN);
    const lifecycle = createLoginChallengeUsesLifecycle({ expectedCases: CASES, requiredPreflightChecks: ["check one"], caseDeadlineMs: 2000, cleanupDeadlineMs: 2000, ownership, nonces, ceilings: { ...CEILINGS, cleanupOperations } });
    return { ownership, nonces, lifecycle };
  }
  async function readyRun(options: { schemas: number; objectsPerSchema: number; markers: number; ceiling?: number }) {
    const run = setup(options.ceiling);
    await run.lifecycle.runPreflight(async () => {
      run.lifecycle.preflightCheck("check one", true);
      run.lifecycle.arm({ startEvidence: OK_START });
    });
    for (let i = 0; i < options.schemas; i += 1) {
      const schema = run.ownership.registerScratchSchema(`s${i}`);
      for (let j = 0; j < options.objectsPerSchema; j += 1) run.ownership.registerScratchObject(schema, "table", `t${j}`);
    }
    run.nonces.registerMany("m", options.markers);
    for (const name of CASES) await run.lifecycle.runCase(name, async () => undefined);
    return run;
  }
  /** A database that answers like a clean one, recording every statement it is actually sent. */
  function scriptedDb(ownership: ReturnType<typeof createRunOwnership>, options: { failAt?: number } = {}) {
    const log: string[] = [];
    return {
      log,
      q: async (text: string, params: unknown[] = []) => {
        log.push(text);
        if (options.failAt !== undefined && log.length === options.failAt) throw Object.assign(new Error("db"), { code: "57014" });
        if (text === SCHEMA_INVENTORY_SQL) return ownership.objectsOf(params[0] as string).map((object) => ({ kind: object.kind, name: object.name }));
        if (text === SCHEMA_EXTERNAL_DEPENDENCIES_SQL) return [{ foreign_keys: 0, triggers: 0, inheritance: 0, view_references: 0 }];
        if (text === SCHEMA_RESIDUE_SQL) return [{ n: 0 }];
        if (text === DELETE_OWNED_MARKERS_SQL) return (params[0] as string[]).map((nonce) => ({ nonce }));
        if (text === COUNT_MARKERS_SQL) return [{ n: 0 }];
        if (text.startsWith("DROP ")) return [];
        throw new Error(`unexpected statement: ${text.slice(0, 40)}`);
      },
    };
  }

  it("the meter counts up to its limit, refuses every later statement forever, and rejects a bad limit", () => {
    const meter = createCleanupMeter(3);
    expect([meter.take(), meter.take(), meter.take()]).toEqual([true, true, true]);
    expect(meter.issued()).toBe(3);
    expect([meter.take(), meter.take()]).toEqual([false, false]);
    expect(meter.issued()).toBe(3);
    expect(meter.refused()).toBe(2);
    expect(meter.limit()).toBe(3);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3" as never]) expect(() => createCleanupMeter(bad), String(bad)).toThrow(/positive whole number/);
  });

  it("the gate counts BEFORE dispatch, sends the last permitted statement, refuses the next without sending it, and refuses everything once switched off", async () => {
    const meter = createCleanupMeter(2);
    const sent: Array<{ text: string; countAtDispatch: number }> = [];
    let exhausted = 0;
    let active = true;
    const gate = createMeteredCleanupGate({ active: () => active, meter, db: { q: async (text) => (sent.push({ text, countAtDispatch: meter.issued() }), []) }, onExhausted: () => void (exhausted += 1) });
    await gate.q("one", []);
    await gate.q("two", []); // the last permitted statement is sent
    expect(sent).toEqual([{ text: "one", countAtDispatch: 1 }, { text: "two", countAtDispatch: 2 }]); // already counted when the database saw it
    await expect(gate.q("three", [])).rejects.toThrow(/ceiling/);
    await expect(gate.q("four", [])).rejects.toThrow(/ceiling/);
    expect(sent.map((entry) => entry.text)).toEqual(["one", "two"]); // nothing unmetered was issued after exhaustion
    expect(meter.issued()).toBe(2);
    expect(exhausted).toBe(2);
    active = false;
    await expect(gate.q("five", [])).rejects.toThrow(/switched off/);
    expect(sent).toHaveLength(2);
    expect(meter.refused()).toBe(2); // a switched-off gate never even reaches the meter
  });

  it("EVERY cleanup statement is counted: the issued count equals the statements the database received, which equals the plan", async () => {
    const run = await readyRun({ schemas: 3, objectsPerSchema: 2, markers: 250 });
    const db = scriptedDb(run.ownership);
    await run.lifecycle.runFinalCleanup(db);
    const report = await run.lifecycle.finish({ compare: async () => ({ ok: true, verdict: "baseline_plus_expected_delta", differences: [], expectedDelta: { tableAdded: "public.real_login_challenge_uses", rows: 0 }, measured: [], notMeasured: [] }) });
    // 3 schemas: 3 inventories + 3 dependency reads + 6 object drops + 3 schema drops + 1 schema residue = 16; 250 markers = 3 deletions; 1 marker residue read.
    const planned = 3 + 3 + 6 + 3 + 1 + Math.ceil(250 / MARKER_DELETE_CHUNK) + 1;
    expect(planned).toBe(20);
    expect(db.log).toHaveLength(planned);
    expect(report.cleanup).toMatchObject({ attempted: true, accepted: true, statementsPlanned: planned, statementsIssued: planned, statementsRefused: 0, statementCeiling: CEILINGS.cleanupOperations });
    expect(report.outcome).toBe("COMPLETED_CLEAN"); // every statement was counted AND the cleanup was confirmed
  });

  it("the LAST permitted statement is handled correctly (a ceiling exactly equal to the plan completes), and one fewer sends NOTHING and cannot be clean", async () => {
    const exactRun = await readyRun({ schemas: 2, objectsPerSchema: 1, markers: 5 });
    const planned = 2 + 2 + 2 + 2 + 1 + 1 + 1; // 2 inventories, 2 dependency reads, 2 object drops, 2 schema drops, schema residue, 1 deletion, marker residue
    const db = scriptedDb(exactRun.ownership);
    await exactRun.lifecycle.runFinalCleanup(db);
    expect(db.log).toHaveLength(planned);
    expect(exactRun.lifecycle.poisoned()).toBeNull();

    const atCeiling = await readyRun({ schemas: 2, objectsPerSchema: 1, markers: 5, ceiling: planned });
    const dbAt = scriptedDb(atCeiling.ownership);
    await atCeiling.lifecycle.runFinalCleanup(dbAt);
    expect(dbAt.log).toHaveLength(planned); // the planned-th statement is allowed
    expect(atCeiling.lifecycle.poisoned()).toBeNull();
    const reportAt = await atCeiling.lifecycle.finish({ compare: async () => ({ ok: true, verdict: "baseline_plus_expected_delta", differences: [], expectedDelta: { tableAdded: "public.real_login_challenge_uses", rows: 0 }, measured: [], notMeasured: [] }) });
    expect(reportAt.cleanup).toMatchObject({ accepted: true, statementsIssued: planned, statementsRefused: 0, statementCeiling: planned });

    const over = await readyRun({ schemas: 2, objectsPerSchema: 1, markers: 5, ceiling: planned - 1 });
    const dbOver = scriptedDb(over.ownership);
    await over.lifecycle.runFinalCleanup(dbOver);
    expect(dbOver.log).toEqual([]); // not a single statement: a half-finished cleanup is never started
    expect(over.lifecycle.poisoned()).toMatch(/needs 11 statements, over its 10-statement ceiling; nothing was sent and the branch is unverified/);
    const reportOver = await over.lifecycle.finish({ compare: async () => { throw new Error("must not be read"); } });
    expect(reportOver.outcome).toBe("POISONED");
    expect(reportOver.cleanup).toMatchObject({ attempted: false, accepted: false, statementsIssued: 0, statementsPlanned: planned });
    expect(concludeLoginChallengeUsesRun(reportOver, { start: OK_START, final: OK_START }).pass).toBe(false);
    expect(reportOver.completeRestoration).toBe(false);
  });

  it("an INTERRUPTED cleanup (a statement fails part-way) stops at once, is never accepted, and never reports a clean baseline", async () => {
    const run = await readyRun({ schemas: 2, objectsPerSchema: 1, markers: 5 });
    const db = scriptedDb(run.ownership, { failAt: 6 });
    await expect(run.lifecycle.runFinalCleanup(db)).rejects.toThrow(/not confirmed/);
    expect(db.log).toHaveLength(6); // nothing after the failing statement was sent
    expect(run.lifecycle.poisoned()).toMatch(/final cleanup was not confirmed/);
    const report = await run.lifecycle.finish({ compare: async () => { throw new Error("must not be read"); } });
    expect(report.outcome).toBe("POISONED");
    expect(report.cleanup).toMatchObject({ accepted: false, markersDeleted: null });
    expect(report.cleanup.statementsIssued).toBe(6);
    expect(concludeLoginChallengeUsesRun(report, { start: OK_START, final: OK_START }).pass).toBe(false);
    expect(report.disposition).toBe("poisoned_evidence_preserved");
    // A cleanup is eligible ONLY for a complete, unpoisoned, idle run.
    const early = setup();
    await early.lifecycle.runPreflight(async () => {
      early.lifecycle.preflightCheck("check one", true);
      early.lifecycle.arm({ startEvidence: OK_START });
    });
    const quiet = scriptedDb(early.ownership);
    await early.lifecycle.runFinalCleanup(quiet);
    expect(quiet.log).toEqual([]);
    expect(early.lifecycle.poisoned()).toMatch(/before every expected case had completed/);
    const poisoned = await readyRun({ schemas: 1, objectsPerSchema: 1, markers: 1 });
    poisoned.lifecycle.poison("something went wrong");
    const none = scriptedDb(poisoned.ownership);
    await poisoned.lifecycle.runFinalCleanup(none);
    expect(none.log).toEqual([]);
  });

  it("the approved ceiling is unchanged (340), the estimate covers the live plan with room to spare, and cleanup never uses CASCADE or enlarges its targets", () => {
    expect(CEILINGS.cleanupOperations).toBe(340);
    const live = 54 * 5 + 1 + Math.ceil(NONCE_REGISTRY_CAP / MARKER_DELETE_CHUNK) + 1;
    expect(planBudget([{ name: "x", operations: 1, fixtureStatements: 0, fixtureRows: 0, polls: 0, concurrent: 1, scratchSchemas: 54 }]).totals.cleanupOperations).toBe(live);
    expect(live).toBeLessThanOrEqual(CEILINGS.cleanupOperations);
    const fixtureCode = readFileSync(FIXTURE, "utf8");
    const cleanupSource = fixtureCode.slice(fixtureCode.indexOf("async runFinalCleanup("), fixtureCode.indexOf("async finish("));
    expect(cleanupSource).not.toMatch(/CASCADE/i);
    expect(cleanupSource).toContain("createMeteredCleanupGate({");
    expect(cleanupSource).toContain("input.nonces.owned()");
    expect(cleanupSource.match(/gate\.q\(/g)).toHaveLength(2); // marker deletions and the residue read: the only direct statements; the plan runs through the same gate
    expect(cleanupSource).not.toMatch(/\bdb\.q\(/); // no statement reaches the database except through the metered gate
  });
});

// ------------------------------------------------------------------ L-3: race timing evidence

describe("L-3: race timing evidence separates MEASURED, INFERRED FROM SCRIPTED ORDER, and NOT OBSERVED", () => {
  it("the scripted sleep outlasts the expiry with margin, and the expiry leaves room for the holder wait and a replay", () => {
    expect(RACE_EXPIRY_OFFSET_MS).toBe(16_000);
    expect(RACE_HOLDER_SLEEP_SECONDS).toBe(20);
    expect(RACE_HOLDER_SLEEP_SECONDS * 1000).toBeGreaterThan(RACE_EXPIRY_OFFSET_MS);
    expect(RACE_HOLDER_SLEEP_SECONDS * 1000 - RACE_EXPIRY_OFFSET_MS).toBeGreaterThanOrEqual(RACE_MIN_RELEASE_MARGIN_MS);
    expect(checkRaceScript({ expiryOffsetMs: RACE_EXPIRY_OFFSET_MS, holderSleepSeconds: RACE_HOLDER_SLEEP_SECONDS, holderWaitMs: 8_000 })).toEqual({ ok: true });
    for (const [name, input] of [
      ["a sleep shorter than the expiry", { expiryOffsetMs: 20_000, holderSleepSeconds: 20, holderWaitMs: 8_000 }],
      ["a sleep that barely outlasts it", { expiryOffsetMs: 18_500, holderSleepSeconds: 20, holderWaitMs: 8_000 }],
      ["an expiry before the holder wait could finish", { expiryOffsetMs: 10_000, holderSleepSeconds: 20, holderWaitMs: 8_000 }],
      ["a zero timing", { expiryOffsetMs: 0, holderSleepSeconds: 20, holderWaitMs: 8_000 }],
      ["a fractional timing", { expiryOffsetMs: 16_000.5, holderSleepSeconds: 20, holderWaitMs: 8_000 }],
    ] as const) expect(checkRaceScript(input).ok, name).toBe(false);
    // The live file uses the shared constants, never its own literals, in the race cases.
    const live = readFileSync(SMOKE, "utf8");
    const raceCases = live.slice(live.indexOf('liveCase(EXPECTED_CASES[13]'), live.indexOf("liveCase(EXPECTED_CASES[16]"));
    expect(raceCases).not.toMatch(/16_000|, 20\)|\(n, 20|exp, 20/);
    expect(raceCases).toContain("holderDeleteAndCommitTimed(n, RACE_HOLDER_SLEEP_SECONDS)");
    expect(raceCases).toContain("holderInsertAndRollback(n, exp, RACE_HOLDER_SLEEP_SECONDS)");
    expect(live).toContain("const raceScript = checkRaceScript({ expiryOffsetMs: RACE_EXPIRY_OFFSET_MS, holderSleepSeconds: RACE_HOLDER_SLEEP_SECONDS, holderWaitMs: HOLDER_WAIT_MS });");
  });

  it("a commit holder reads the DATABASE clock first and last inside its batch; the batch result is parsed strictly", () => {
    const nonce = `${RUN}${"ab".repeat(12)}`;
    expect(holderDeleteAndCommitTimed(nonce, 20)).toEqual([DB_CLOCK_SQL, `DELETE FROM public.real_login_challenge_uses WHERE nonce = decode('${nonce}', 'hex')`, "SELECT pg_catalog.pg_sleep(20)", DB_CLOCK_SQL]);
    expect(parseTimedHolderResult([[{ ms: "1760000000000" }], [], [{ pg_sleep: "" }], [{ ms: "1760000020100" }]])).toEqual({ startedMs: 1_760_000_000_000, releasedMs: 1_760_000_020_100 });
    expect(parseTimedHolderResult([[{ ms: 5 }], [], [], [{ ms: 7 }]])).toEqual({ startedMs: 5, releasedMs: 7 });
    for (const bad of [null, [], [[], [], [], []], [[{ ms: "x" }], [], [], [{ ms: "7" }]], [[{ ms: "9" }], [], [], [{ ms: "7" }]], [[{ ms: "5" }], [], []], [[{ ms: "5" }, { ms: "6" }], [], [], [{ ms: "7" }]], [[{ ms: "-5" }], [], [], [{ ms: "7" }]], "no"]) expect(parseTimedHolderResult(bad), JSON.stringify(bad)).toBeNull();
    // A rollback holder is NOT timed: its deliberate error discards its results.
    expect(readFileSync(FIXTURE, "utf8")).toContain("a rollback holder's results are discarded by the deliberate error");
  });

  it("evidence labels each fact honestly: a commit holder's release is MEASURED, a rollback holder's is NOT OBSERVED, scripted values are INFERRED", () => {
    const exp = "2030-01-01T00:00:16.000Z";
    const expMs = Date.parse(exp);
    const commit = raceTimingEvidence({ expiryIso: exp, expiryOffsetMs: 16_000, intendedHolderSleepSeconds: 20, holderKind: "commit", holderSleepingSeenBeforeReplay: 1, replayBlockedSeen: 1, timed: { startedMs: expMs - 15_000, releasedMs: expMs + 4_500 }, dbClockAfterCollectMs: expMs + 4_700, expiredAtStatementPostCheck: true });
    expect(commit.holderReleasedDbMs).toMatchObject({ basis: "MEASURED", value: expMs + 4_500 });
    expect(commit.holderStartedDbMs.basis).toBe("MEASURED");
    expect(commit.releaseAfterExpiry).toMatchObject({ basis: "MEASURED", value: true });
    expect(commit.expiry.basis).toBe("MEASURED");
    expect(commit.expiryOffsetMs.basis).toBe("INFERRED_FROM_SCRIPTED_ORDER");
    expect(commit.intendedHolderSleepSeconds.basis).toBe("INFERRED_FROM_SCRIPTED_ORDER");
    expect(commit.scriptedReleaseMarginMs).toMatchObject({ basis: "INFERRED_FROM_SCRIPTED_ORDER", value: 4_000 });
    expect(commit.holderSleepingSeen.basis).toBe("MEASURED");
    expect(commit.replayBlockedSeen.basis).toBe("MEASURED");
    expect(commit.dbClockAfterCollectMs.note).toMatch(/UPPER bound/);
    expect(raceTimingConsistent(commit)).toBe(true);
    // A release BEFORE the expiry is recorded as measured-false, not hidden.
    const early = raceTimingEvidence({ expiryIso: exp, expiryOffsetMs: 16_000, intendedHolderSleepSeconds: 20, holderKind: "commit", holderSleepingSeenBeforeReplay: 1, replayBlockedSeen: 1, timed: { startedMs: expMs - 15_000, releasedMs: expMs - 1 }, dbClockAfterCollectMs: expMs + 10, expiredAtStatementPostCheck: null });
    expect(early.releaseAfterExpiry).toMatchObject({ basis: "MEASURED", value: false });
    expect(early.expiredAtStatementPostCheck).toMatchObject({ basis: "NOT_OBSERVED", value: null });

    const rollback = raceTimingEvidence({ expiryIso: exp, expiryOffsetMs: 16_000, intendedHolderSleepSeconds: 20, holderKind: "rollback", holderSleepingSeenBeforeReplay: 1, replayBlockedSeen: 1, timed: { startedMs: 1, releasedMs: 2 }, dbClockAfterCollectMs: expMs + 4_700, expiredAtStatementPostCheck: true });
    for (const key of ["holderStartedDbMs", "holderReleasedDbMs", "releaseAfterExpiry"] as const) expect(rollback[key], key).toMatchObject({ basis: "NOT_OBSERVED", value: null }); // a supplied reading is IGNORED for a rollback holder: it cannot exist
    expect(rollback.expiredAtStatementPostCheck).toMatchObject({ basis: "MEASURED", value: true });
    expect(rollback.dbClockAfterCollectMs.basis).toBe("MEASURED");
    expect(raceTimingConsistent(rollback)).toBe(true);
    // A commit holder with no result is NOT OBSERVED, never fabricated.
    const missing = raceTimingEvidence({ expiryIso: exp, expiryOffsetMs: 16_000, intendedHolderSleepSeconds: 20, holderKind: "commit", holderSleepingSeenBeforeReplay: 1, replayBlockedSeen: 1, timed: null, dbClockAfterCollectMs: expMs + 1, expiredAtStatementPostCheck: null });
    expect(missing.holderReleasedDbMs).toMatchObject({ basis: "NOT_OBSERVED", value: null });
    expect(raceTimingConsistent(missing)).toBe(true);
    // The consistency rule itself: MEASURED needs a value, NOT_OBSERVED forbids one.
    expect(raceTimingConsistent({ x: { basis: "MEASURED", value: null, note: "n" } })).toBe(false);
    expect(raceTimingConsistent({ x: { basis: "NOT_OBSERVED", value: 1, note: "n" } })).toBe(false);
    expect(raceTimingConsistent({ x: { basis: "INFERRED_FROM_SCRIPTED_ORDER", value: 1, note: "" } })).toBe(false);
    expect(() => raceTimingEvidence({ expiryIso: "tomorrow", expiryOffsetMs: 1, intendedHolderSleepSeconds: 1, holderKind: "commit", holderSleepingSeenBeforeReplay: 0, replayBlockedSeen: 0, timed: null, dbClockAfterCollectMs: 1, expiredAtStatementPostCheck: null })).toThrow();
  });

  it("M6/M7/M8 record that evidence, still require the replay to be OBSERVED blocked, and keep their fail-closed insists", () => {
    const raw = readFileSync(SMOKE, "utf8");
    const live = raw.split("\n").filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join("\n");
    const m6 = live.slice(live.indexOf("liveCase(EXPECTED_CASES[13]"), live.indexOf("liveCase(EXPECTED_CASES[14]"));
    const m7 = live.slice(live.indexOf("liveCase(EXPECTED_CASES[14]"), live.indexOf("liveCase(EXPECTED_CASES[15]"));
    const m8 = live.slice(live.indexOf("liveCase(EXPECTED_CASES[15]"), live.indexOf("liveCase(EXPECTED_CASES[16]"));
    expect(m6).toContain('holderKind: "commit"');
    expect(m6).toContain("insist(holderUp >= 1 && blocked >= 1,");
    expect(m6).toContain("insist(timed !== null,");
    expect(m6).toContain("timed!.startedMs < Date.parse(exp) && timed!.releasedMs > Date.parse(exp)");
    expect(m6).toContain('lifecycle.observe("m6", evidence);');
    expect(m7).toContain('holderKind: "rollback"');
    expect(m7).toContain("timed: null");
    expect(m7).toContain("insist(holderUp >= 1 && blocked >= 1,");
    expect(m7).toContain('lifecycle.observe("m7", evidence);');
    expect(m7).not.toMatch(/MEASURED|holderReleasedDbMs/); // the rollback case never claims a release time
    expect(m8).toContain("holderDeleteAndCommitTimed(");
    expect(m8).toContain('lifecycle.observe("m8", { ...evidence, unsafeCandidateAdmitted: admitted });');
    // Observed server-side blocking is never replaced by a client-side timing estimate.
    for (const body of [m6, m7, m8]) expect(body).toContain("MARKER_WAITERS_SQL");
  });
});

// ------------------------------------------------------------------ L-4: M10 preservation, L-9: the S4 split, L-5/L-1 wording

describe("L-4 / L-9 / L-5 / L-1: M10 preservation, the S4 split, and honest wording", () => {
  const live = readFileSync(SMOKE, "utf8");
  const code = live.split("\n").filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join("\n");

  it("M10 re-checks, by exact identity, every marker the run knows to be present, its own protected markers, and the per-statement purge bound", () => {
    const m10 = code.slice(code.indexOf("liveCase(EXPECTED_CASES[17]"), code.indexOf("liveCase(EXPECTED_CASES[18]"));
    expect(m10).toContain("const keptRecent = nonces.registerMany(\"m10-recent\", 5);");
    expect(m10).toContain("const keptLive = nonces.registerMany(\"m10-live\", 3);");
    expect(m10).toContain("expect(survivors).toEqual(new Set(knownPresent));");
    expect(m10).toContain("expect(await present(\"counting M10's protected markers\", [...keptRecent, ...keptLive])).toBe(8);");
    expect(m10).toContain("expect(remaining - next, `drain round ${round}`).toBe(Math.min(64, remaining));");
    expect(m10).toContain("expect(remaining).toBe(0);");
    expect(m10).toContain("expect(await presentSet(\"listing the aged markers after the purge\", p)).toEqual(new Set(locked));");
    expect(m10).toContain("expect(tallyOutcomes(outcomes)).toEqual({ consumed: 8 });");
    // The ledger is fed only by observed facts: a consumed use, a fixture insert, or a race that left its row; never by the aged fixtures that SHOULD be purged.
    expect(code.match(/knownPresent\.add\(/g)!.length).toBeGreaterThanOrEqual(9);
    expect(code).toContain("if (outcome === \"consumed\") knownPresent.add(nonceHex);");
    expect(code).not.toMatch(/knownPresent\.add\(a\b|knownPresent\.add\(p\b|knownPresent\.add\(q\b/);
    // M9's preserved set is checked by identity too, not only by count.
    expect(code).toContain("expect(await presentSet(\"listing every marker M9 expects to remain\", [...b, ...c, t1, t3])).toEqual(new Set([...b, ...c, t1, t3]));");
    // The M10 fixtures are counted in the plan (6 statements, 208 rows) so the budget still holds.
    expect(code).toContain("fixtureStatements: 6, fixtureRows: 208");
  });

  it("S4 is two cases of 14 variants each (the controls in the first), together exactly the 28 originals; no variant is dropped, duplicated, or skipped", () => {
    expect(GROUP_A1.map((v) => v.suffix)).toEqual(Array.from({ length: 14 }, (_, i) => `a${String(i + 1).padStart(2, "0")}`));
    expect(GROUP_A2.map((v) => v.suffix)).toEqual(Array.from({ length: 14 }, (_, i) => `a${String(i + 15).padStart(2, "0")}`));
    const s4a = code.slice(code.indexOf("liveCase(EXPECTED_CASES[3]"), code.indexOf("liveCase(EXPECTED_CASES[4]"));
    const s4b = code.slice(code.indexOf("liveCase(EXPECTED_CASES[4]"), code.indexOf("liveCase(EXPECTED_CASES[5]"));
    expect(s4a).toContain("buildVariant(CONTROL_WITH_INDEX)");
    expect(s4a).toContain("buildVariant(CONTROL_WITHOUT_INDEX)");
    expect(s4a).toContain("for (const variant of GROUP_A1)");
    expect(s4b).toContain("for (const variant of GROUP_A2)");
    expect(s4b).not.toContain("CONTROL_");
    // Each case keeps the full per-variant assertions (refusal with the variant's SQLSTATE list, shape unchanged) through the one helper.
    expect(s4a + s4b).not.toMatch(/GROUP_A\b/);
    const names = /const EXPECTED_CASES = \[([\s\S]*?)\] as const;/.exec(live)?.[1] ?? "";
    expect(names).toContain('"S4a. scratch schemas:');
    expect(names).toContain('"S4b. scratch schemas:');
    expect(names).not.toMatch(/"S4\. /);
    // The deadline per case is unchanged and the whole-run deadline was not raised.
    expect(CEILINGS.caseDeadlineMs).toBe(90_000);
    expect(CEILINGS.runDeadlineMs).toBe(900_000);
    expect(live).toContain("caseDeadlineMs: CASE_DEADLINE_MS, cleanupDeadlineMs: CLEANUP_DEADLINE_MS, preflightDeadlineMs: CASE_DEADLINE_MS, ownership, nonces });");
    // Requests per case: each now issues roughly half of the 208 the audit measured (plan estimate: schema + steps + 3 per variant).
    const perVariant = (variants: typeof GROUP_A1) => variants.reduce((total, variant) => total + 1 + variant.steps("pb_smoke_00000000_plan").length + 3, 0);
    expect(perVariant(GROUP_A1) + 40).toBeLessThan(140);
    expect(perVariant(GROUP_A2) + 6).toBeLessThan(140);
  });

  it("the activity check is described as a SELF check, the evidence says an endpoint match is not branch provenance, and no per-operation timeout is claimed", () => {
    expect(live).not.toContain("this session can see pg_stat_activity (the race cases need to)");
    expect(live).toContain("this session can read its own pg_stat_activity entry (other sessions are seen only by the race cases' polls, which poison the run if they see nothing)");
    expect(readFileSync(FIXTURE, "utf8")).toContain("It says nothing about other sessions");
    expect(readFileSync(FIXTURE, "utf8")).not.toMatch(/operationTimeoutMs|per-operation timeout of/i);
    expect(readFileSync(FIXTURE, "utf8")).toContain("There is NO per-operation timeout and NO request cancellation");
    expect(code).toContain("targetProofStatus: TARGET_PROOF_STATUS,");
    expect(code).not.toContain("target and expected endpoint verified");
    // The header says what the deadlines are, and that the operator must supply independent branch evidence.
    const header = live.slice(live.indexOf("/**\n * MANUAL"), live.indexOf("const GATE =")).split("\n").map((line) => line.replace(/^\s*(\/\*\*|\*\/|\*)\s?/, "")).join(" ").replace(/\s+/g, " ");
    expect(header).toContain("THAT THE BRANCH IS NEW IS THE OPERATOR'S EVIDENCE");
    expect(header).toContain("no per-operation timeout");
  });
});
