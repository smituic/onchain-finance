// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import type { LoginChallengeUseStore } from "@/lib/real/server/login-challenge-uses";
import { connectSmokeDb, connectSmokeStores, parseDatabaseUrl, requireDisposableTargetUrl, type SmokeDb, type SmokeRow } from "./fixtures/handles-smoke-db";
import type { RunOwnership, ScratchObjectKind } from "./fixtures/provider-budget-smoke";
import {
  BOOLEAN_PROBE_SQL,
  APPLY_PLAN,
  RACE_EXPIRY_OFFSET_MS,
  RACE_HOLDER_SLEEP_SECONDS,
  SHARED_HELPER_FILES,
  TARGET_PROOF_STATUS,
  checkRaceScript,
  holderDeleteAndCommitTimed,
  parseTimedHolderResult,
  raceTimingEvidence,
  registerPlan,
  type SharedHelperName,
  CAN_SEE_ACTIVITY_SQL,
  CASE_DEADLINE_MS,
  CLEANUP_DEADLINE_MS,
  CLOCK_BATCH,
  CONTRAST_VARIANT,
  CONTROL_WITHOUT_INDEX,
  CONTROL_WITH_INDEX,
  COUNT_OWNED_PRESENT_SQL,
  DB_CLOCK_SQL,
  EXPECTED_MARKER_TABLE,
  GROUP_A,
  GROUP_A1,
  GROUP_A2,
  GROUP_B,
  HOLDER_ACTIVE_SQL,
  INSERT_AGED_MARKERS_SQL,
  INSERT_MARKER_SQL,
  LIST_OWNED_PRESENT_SQL,
  LOGIN_CHALLENGE_USES_SMOKE_FILE,
  MARKER_SQL_REFERENCE_SHA256,
  MARKER_WAITERS_SQL,
  MIGRATION_IDENTITY,
  NO_KEY_VARIANT,
  NO_KEY_TABLE,
  REGISTRATION_ORDER,
  READ_MARKER_SQL,
  SCRATCH_SCHEMA_REGISTRY_CAPACITY,
  VITEST_TIMEOUT_MS,
  analyseVariant,
  assertPlainIdentifier,
  captureProductionMarkerSql,
  checkScratchCapacity,
  createLoginChallengeUsesOwnership,
  caseFailedInVitest,
  checkLoginChallengeUsesFileSelection,
  checkMigrationIdentities,
  checkProductionMarkerSql,
  checkRunAuthorization,
  checkRunnerTimeoutFlags,
  compareWithExpectedMarkerDelta,
  computeSourceIdentity,
  concludeLoginChallengeUsesRun,
  createLoginChallengeUsesLifecycle,
  createNonceRegistry,
  extractMigrationBlock,
  findPackedRef,
  holderInsertAndRollback,
  holderRowLocks,
  holderTableGate,
  markerSqlForSchema,
  parseGitHead,
  planBudget,
  requirePooledMode,
  safeEvidenceJson,
  scratchInsertSql,
  scratchRowsSql,
  tallyOutcomes,
  unsafeCandidateSql,
  writeLoginChallengeUsesEvidence,
  type DatabaseSnapshot,
  type EvidenceResult,
  type GitHead,
  type LoginChallengeUsesLifecycle,
  type MarkerOutcome,
  type NonceRegistry,
  type ProviderTableDescriptor,
  type ScenarioPlan,
  type Variant,
  type TrackedRead,
} from "./fixtures/login-challenge-uses-smoke";

/**
 * MANUAL, LIVE-DATABASE proof of the stateless-login used-marker table
 * (real_login_challenge_uses), its migration block, and the PRODUCTION marker
 * statement (Milestone 3C-2), against a DISPOSABLE Neon branch.
 *
 * IT HAS NEVER BEEN RUN LIVE. Nothing in this file is evidence of PostgreSQL or
 * Neon behavior, and no SQL it contains has ever been executed or parsed by a
 * database. Every claim about READ COMMITTED, waiting on an uncommitted insert
 * or delete, re-checking after a lock wait, SKIP LOCKED, and the clock the
 * statement reads is the design's expectation that this run exists to test.
 * Separate explicit authorization is needed before its first live execution.
 *
 * EXPLICITLY OPT-IN, AND NOT RUN as part of the build: its offline checks always
 * run; every live case is skipped unless its own gate is set, and then it runs
 * only against a confirmed disposable Neon target, with a SECOND, separate
 * confirmation for this one run (below). It must NEVER be pointed at the real
 * database, nor at an earlier smoke's branch: the registration-admission branches
 * ced714ee and c20ffc87 and every earlier smoke branch are finished and must not
 * be touched again.
 *
 * WHAT IT DRIVES. schema.sql's "Login Challenge Uses" block, exactly as written
 * (only its target-schema constant is swapped for a scratch schema), and the
 * application's OWN marker store (createNeonDurableStores(...).loginChallengeUses)
 * with truly concurrent requests. The statement text is captured FROM that adapter
 * and compared with an independently written reference before anything connects;
 * a scratch-schema copy of it is used only to prove PostgreSQL's native error for a
 * table without its unique key. It makes NO provider call, performs NO passkey
 * ceremony, and no route is involved.
 *
 * RUN AUTHORIZATION. Beside the gate, NEON_BRANCH_DATABASE_URL, and
 * NEON_BRANCH_EXPECTED_ENDPOINT_ID, the run needs LOGIN_CHALLENGE_SMOKE_RUN_ID (an
 * 8-hex id the operator chooses, never one an earlier smoke spent, with no existing
 * evidence) and LOGIN_CHALLENGE_SMOKE_CONFIRM, which must equal
 * "<run id>:<first 16 hex of sha256(source digest | endpoint id | run id)>". The source
 * digest covers the migration, the pinned marker statement, the adapter's own source, the
 * two production login-challenge modules, and THIS file and its fixture module, so a
 * confirmation never authorizes different code than was audited, a different branch endpoint, or a
 * different run. The offline harness test prints the exact string for a
 * given run id and endpoint when it is run with LOGIN_CHALLENGE_SMOKE_PRINT_CONFIRMATION=1;
 * that connects to nothing. There is no fallback and no bypass. The repository branch and
 * commit are recorded in the evidence (a detached or unreadable HEAD is refused); the
 * confirmation is bound to file CONTENT rather than to a commit, because the operator's own
 * checkpoint legitimately moves HEAD.
 *
 * DISPOSABLE BRANCH ONLY. It never reads DATABASE_URL: the target is
 * NEON_BRANCH_DATABASE_URL, and it refuses to connect unless that endpoint differs
 * from the real database's (.env.local), DATABASE_URL is not exported, and no admin
 * or other smoke gate is set.
 *
 * Milestone 0 Pass B: the run also requires NEON_BRANCH_EXPECTED_ENDPOINT_ID — the
 * branch's endpoint id, read by the operator from the Neon console — and refuses to
 * connect unless it equals the URL's endpoint exactly.
 *
 * POOLED CONNECTION, EXACT FILE, SAFE TIMEOUTS. It refuses a direct connection
 * string, refuses unless Vitest was started as exactly `vitest run <this file>`, and
 * refuses any runner-timeout flag below 120000 ms. Every test and hook carries that
 * timeout explicitly; the run's own deadlines (90 s per case and for the preflight,
 * 60 s for the cleanup and for the post-run comparison, 15 minutes for the whole
 * run) are shorter. Do NOT pass the older smokes' 30000 ms flags.
 *
 * ISOLATION IS CHECKED ON THE PATH PRODUCTION USES. The preflight reads
 * transaction_isolation and default_transaction_isolation through ONE
 * single-statement request — the autocommit path the marker statement takes — and
 * refuses to arm unless both are "read committed". It does not infer it from a
 * batch.
 *
 * FRESH BRANCH, ONE RUN. The branch must NOT already have
 * public.real_login_challenge_uses (the first case proves the statement fails
 * closed without it, and a later one applies the block to `public`), nor a
 * leftover scratch schema, nor public.real_registration_admission (which marks a
 * branch an earlier smoke used). Never rerun on a used branch.
 *
 * BOUNDED. The budgets are computed from the scenario inventory below BEFORE any
 * connection and refused if over the ceilings in the fixture (operations, 64
 * concurrent, fixture writes and rows, scratch schemas, activity polls, cleanup
 * statements, run time). Nothing is retried; a lost answer poisons the run. TIMING IS
 * BOUNDED ONLY BY DEADLINES: a 90 s deadline per case, a 15 minute deadline for the whole run
 * (after which nothing more is sent), and 60 s for the cleanup and for the final comparison.
 * There is no per-operation timeout and no request cancellation: an issued statement stays
 * tracked until it really settles, nothing aborts one (an abort could turn an uncertain write
 * into an apparent clean failure), and a deadline that fires poisons the run and reports what
 * was still in flight as unsettled. EVERY cleanup statement is counted against the 340-statement
 * ceiling before it is sent; a cleanup that would exceed it sends nothing, and one that reaches
 * it stops, poisoned and unverified. The scratch-schema registry is asked for 56 schemas (the
 * plan needs 54; the shared default of 40 is unchanged and the hard cap is 60).
 *
 * THAT THE BRANCH IS NEW IS THE OPERATOR'S EVIDENCE, NOT THIS FILE'S. The checks here (the
 * endpoint matches the operator's statement, no earlier smoke's tables or scratch schemas are
 * present, the source digest was confirmed for this run) are fail-closed gates, not proof of
 * provenance: an older branch that happens to lack those tables would pass them. Before any live
 * run the operator must supply independent Neon-console evidence that the branch was created
 * for this run.
 *
 * HOW THE RACES ARE BUILT. The repository has no interactive-transaction
 * transport, so a blocking session is a SCRIPTED HTTP BATCH (an uncommitted change,
 * a sleep, then a commit or a deliberate rollback). The production statement is
 * always issued through the production adapter over its own client. pg_stat_activity
 * is polled to PROVE the interleaving (a holder is sleeping; N requests are
 * waiting on a lock). If the interleaving is not observed, the run is poisoned — a
 * race case never passes silently.
 *
 * THE TEST-FIXTURE WRITES. On `public` the run writes ONLY: the unmodified block,
 * and marker rows whose nonces it minted itself (the production statement, the
 * pinned fixture inserts, and the holders). The final cleanup deletes EXACTLY that
 * registered list, then requires the table's total row count to be zero.
 *
 * WHAT A CLEAN RUN LEAVES BEHIND. Not the baseline: the baseline PLUS the expected
 * delta — public.real_login_challenge_uses now exists, with the intended structure
 * and EMPTY. Every pre-existing public table must be unchanged in contents and
 * shape, and every scratch schema of this run must be gone. It is never reported as
 * "restored".
 *
 * NO PER-CASE CLEANUP. One cleanup runs at the end, only if every case completed
 * cleanly: exact registered scratch objects and schemas, RESTRICT only, after a
 * read-only check that each scratch schema holds exactly what was registered and
 * nothing outside it depends on it; then the exact registered markers. No Neon
 * branch is ever deleted by this file.
 *
 * A FAILED RUN KEEPS ITS EVIDENCE. The moment a case fails, times out, or gets an
 * answer it did not expect, the run is poisoned for good: no later case, no further
 * write or read, and NO cleanup. A fixture that cannot be constructed is reported as
 * a HARNESS FAILURE, never as a migration refusal. Investigate the branch read-only
 * and do not reuse it.
 *
 * EVIDENCE. Two NEW owner-only files in `evidence/` (git-ignored; an existing file
 * is never overwritten): `login-challenge-uses-smoke-<run id>-start.json`, saved
 * before anything may be written, and `...-final.json`. Never a connection string,
 * an endpoint id, a credential, or a driver's error text. A clean run whose evidence
 * cannot be saved FAILS.
 *
 *   REAL_SMOKE_LOGIN_CHALLENGE_USES=1 NEON_BRANCH_DATABASE_URL="postgres://..." NEON_BRANCH_EXPECTED_ENDPOINT_ID="ep-..." \
 *   LOGIN_CHALLENGE_SMOKE_RUN_ID="<8 hex>" LOGIN_CHALLENGE_SMOKE_CONFIRM="<run id>:<16 hex>" \
 *     pnpm exec vitest run test/lib/real/login-challenge-uses.smoke.test.ts
 */
const GATE = "REAL_SMOKE_LOGIN_CHALLENGE_USES";
const ALLOWED_GATES = [GATE] as const;
const enabled = process.env[GATE] === "1";

/** Where the run's evidence is saved: a fixed, git-ignored directory. The file names are built from the run id alone. */
const EVIDENCE_DIRECTORY = "evidence";
/** The most marker requests ever issued together (the largest scenario below is 60). */
const BURST = 60;
const POLL_INTERVAL_MS = 500;
/** How long to wait for a lock holder to be sleeping, and for requests to be observed waiting on a lock. */
const HOLDER_WAIT_MS = 8_000;
const BLOCK_WAIT_MS = 16_000;
/** The most polls one wait can issue (its deadline over the interval, plus the first and last reads). */
const HOLDER_WAIT_POLLS = HOLDER_WAIT_MS / POLL_INTERVAL_MS + 2;
const BLOCK_WAIT_POLLS = BLOCK_WAIT_MS / POLL_INTERVAL_MS + 2;

const SCHEMA_PATH = "lib/real/server/schema.sql";
const STORE_PATH = "lib/real/server/neon-store.ts";
const CHALLENGE_PATH = "lib/real/server/login-challenge.ts";
const USES_PATH = "lib/real/server/login-challenge-uses.ts";
const FIXTURE_PATH = "test/lib/real/fixtures/login-challenge-uses-smoke.ts";
const TARGET_LINE = "target_schema CONSTANT pg_catalog.text := 'public';";
const SCRATCH_NAME = /^pb_smoke_[0-9a-f]{8}_[a-z0-9]{1,12}$/;
const TABLE = "real_login_challenge_uses";

/** The statement under test: the block's single DO statement, exactly as schema.sql has it. */
function migrationBlock(): string {
  const block = extractMigrationBlock(readFileSync(SCHEMA_PATH, "utf8"), MIGRATION_IDENTITY.name).statement;
  if (block.split(TARGET_LINE).length !== 2) throw new Error("the block does not have exactly one target-schema constant");
  return block;
}
/** The same statement with ONLY its target-schema constant swapped, for a name of this harness's scratch shape. */
function migrationBlockFor(schemaName: string): string {
  if (!SCRATCH_NAME.test(schemaName)) throw new Error("login challenge uses smoke: the block may only be retargeted at a scratch schema of this harness's shape");
  return migrationBlock().replace(TARGET_LINE, `target_schema CONSTANT pg_catalog.text := '${schemaName}';`);
}

/** The branch and commit this working tree is on, read from `.git` (no git command). Detached, unreadable, or a worktree layout: refused. */
function readRepositoryHead(): GitHead {
  try {
    return parseGitHead(readFileSync(".git/HEAD", "utf8"), (ref) => {
      try {
        return readFileSync(`.git/${ref}`, "utf8");
      } catch {
        try {
          return findPackedRef(readFileSync(".git/packed-refs", "utf8"), ref);
        } catch {
          return null;
        }
      }
    });
  } catch {
    return { ok: false, reason: "the repository HEAD is detached or unreadable" };
  }
}

/** Every live case, in order. The run is clean only if exactly these ran. */
const EXPECTED_CASES = [
  "S1. missing table: the production marker statement fails closed (42P01) before the block is applied",
  "S2. scratch schema: first apply, idempotent rerun, markers preserved across reruns, exact catalog descriptor",
  "S3. scratch schema: the primary key, the length CHECK, and NOT NULL are enforced",
  "S4a. scratch schemas: exact hand-built copies are accepted and keep their rows, and the first fourteen column and constraint look-alikes (a01 to a14) are refused and left unchanged",
  "S4b. scratch schemas: the remaining fourteen column and constraint look-alikes (a15 to a28) are refused and left unchanged",
  "S5. scratch schemas: the index and table-level look-alikes are refused and left unchanged",
  "S6. a target schema that does not exist is refused, and is not created",
  "S7. public: the exact block applies once, reruns idempotently, preserves an owned marker, and matches the expected descriptor",
  "M1. the marker statement path runs at READ COMMITTED, now() is frozen inside a transaction while clock_timestamp() moves, and a boolean reaches JavaScript as a boolean",
  "M2. first use is consumed, a replay is rejected, and the stored row is exact",
  "M3. database-clock expiry boundaries and the ten-minute upper bound",
  "M4. 60 simultaneous requests for ONE nonce: exactly one consumed, 59 rejected",
  "M5. 60 simultaneous requests for 60 distinct nonces: all 60 consumed",
  "M6. replay after a concurrent removal of its marker: a challenge that expired while the request waited is never admitted (stale-clock race)",
  "M7. a blocked insert whose holder rolls back after expiry is never admitted",
  "M8. contrast: the original unsafe candidate DOES re-admit in the M6 interleaving, so the race is real",
  "M9. bounded purge: one-hour margin, oldest first, at most 64 per statement, live markers untouched, and the purge runs even when the pre-filter rejects",
  "M10. purge under contention: SKIP LOCKED skips locked rows, and 8 simultaneous purging statements neither deadlock nor lose live markers",
  "M11. a table without its unique key fails closed (42P10) and is never an admission",
] as const;

/** Every named read-only finding the preflight must record before the run may be armed. */
const PREFLIGHT_CHECKS = [
  "the connected database is the one the confirmed URL names",
  "the target is not a read replica",
  "unqualified names resolve to public",
  "the server is version 15 or newer (the migration reads pg_index.indnullsnotdistinct)",
  "a single autocommit statement runs at READ COMMITTED (the path production uses)",
  "the database default isolation is READ COMMITTED",
  "no relation named real_login_challenge_uses exists in any schema",
  "public.real_rate_limits exists",
  "no scratch schema of this harness's shape exists",
  "public.real_registration_admission does not exist (a branch an earlier smoke used is refused)",
  "this session can read its own pg_stat_activity entry (other sessions are seen only by the race cases' polls, which poison the run if they see nothing)",
] as const;

// ---------------------------------------------------------------------------------------------------------------------
// The scenario inventory, from which the budget is computed BEFORE any connection. Every figure is the scenario's worst case.
// ---------------------------------------------------------------------------------------------------------------------
const SCHEMA_FOR_PLAN = "pb_smoke_0a1b2c3d_plan";
const variantOperations = (variant: Variant): number => 1 + variant.steps(SCHEMA_FOR_PLAN).length + 3;
const sumOperations = (variants: readonly Variant[]): number => variants.reduce((total, variant) => total + variantOperations(variant), 0);
const plan = (name: string, operations: number, extra: Partial<Omit<ScenarioPlan, "name" | "operations">> = {}): ScenarioPlan => ({ name, operations, fixtureStatements: 0, fixtureRows: 0, polls: 0, concurrent: 1, scratchSchemas: 0, ...extra });
function scenarioInventory(): ScenarioPlan[] {
  const [s1, s2, s3, s4a, s4b, s5, s6, s7, m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11] = EXPECTED_CASES;
  const racePolls = HOLDER_WAIT_POLLS + BLOCK_WAIT_POLLS;
  return [
    plan(s1, 3),
    plan(s2, 45, { fixtureStatements: 1, fixtureRows: 1, scratchSchemas: 1 }),
    plan(s3, 28, { fixtureStatements: 1, fixtureRows: 1 }),
    plan(s4a, 40 + sumOperations(GROUP_A1), { fixtureStatements: 1, fixtureRows: 1, scratchSchemas: 2 + GROUP_A1.length }),
    plan(s4b, 6 + sumOperations(GROUP_A2), { scratchSchemas: GROUP_A2.length }),
    plan(s5, 6 + sumOperations(GROUP_B), { scratchSchemas: GROUP_B.length }),
    plan(s6, 4),
    plan(s7, 50),
    plan(m1, 10),
    plan(m2, 16),
    plan(m3, 34),
    plan(m4, 8 + BURST + 1 + racePolls, { polls: racePolls, concurrent: BURST + 2 }),
    plan(m5, 8 + BURST + 1 + racePolls, { polls: racePolls, concurrent: BURST + 2 }),
    plan(m6, 14 + racePolls, { polls: racePolls, concurrent: 4 }),
    plan(m7, 14 + racePolls, { polls: racePolls, concurrent: 4 }),
    plan(m8, 16 + racePolls, { polls: racePolls, concurrent: 4, fixtureStatements: 1, fixtureRows: 1, scratchSchemas: 1 }),
    plan(m9, 34, { fixtureStatements: 5, fixtureRows: 123 }),
    plan(m10, 60 + 2 * HOLDER_WAIT_POLLS + BLOCK_WAIT_POLLS + 8 + 8, { polls: 2 * HOLDER_WAIT_POLLS + BLOCK_WAIT_POLLS + 2, concurrent: 10, fixtureStatements: 6, fixtureRows: 208 }),
    plan(m11, 14, { scratchSchemas: 1 }),
  ];
}

// Offline (never gated): the harness itself. The pure guards are proven in login-challenge-uses-smoke-harness.test.ts.
describe("login challenge uses smoke harness", () => {
  const SCHEMA_FOR_CHECK = "pb_smoke_0a1b2c3d_check";
  const everyVariant = [...GROUP_A, ...GROUP_B, CONTROL_WITH_INDEX, CONTROL_WITHOUT_INDEX, CONTRAST_VARIANT, NO_KEY_VARIANT];

  it("fixture consistency: EVERY look-alike's and control's DDL is internally consistent — nothing names a column its table lacks, and every created object is registered", () => {
    expect(GROUP_A).toHaveLength(28);
    expect([GROUP_A1.length, GROUP_A2.length]).toEqual([14, 14]);
    expect(GROUP_B).toHaveLength(21);
    const suffixes = everyVariant.map((variant) => variant.suffix);
    expect(new Set(suffixes).size).toBe(suffixes.length);
    for (const variant of everyVariant) expect(analyseVariant(SCHEMA_FOR_CHECK, variant.steps(SCHEMA_FOR_CHECK)).issues, `${variant.suffix} (${variant.what})`).toEqual([]);
    expect(analyseVariant(SCHEMA_FOR_CHECK, NO_KEY_TABLE(SCHEMA_FOR_CHECK)).issues).toEqual([]);
  });

  it("the migration identities, the production marker statement's identity, and the budget plan are all as pinned", async () => {
    expect(checkMigrationIdentities(readFileSync(SCHEMA_PATH, "utf8"))).toEqual({ ok: true });
    expect(checkProductionMarkerSql(await captureProductionMarkerSql())).toEqual({ ok: true });
    expect(MARKER_SQL_REFERENCE_SHA256).toHaveLength(64);
    const budget = planBudget(scenarioInventory());
    expect(budget.violations).toEqual([]);
    expect(budget.ok).toBe(true);
    expect(scenarioInventory().map((scenario) => scenario.name)).toEqual([...EXPECTED_CASES]);
    // The registry holds every planned schema, and the plan equals the replayed registration sequence.
    expect(budget.totals.scratchSchemas).toBe(REGISTRATION_ORDER.length);
    expect(checkScratchCapacity(budget.totals.scratchSchemas, SCRATCH_SCHEMA_REGISTRY_CAPACITY)).toEqual({ ok: true });
  });

  it("the live block registers every expected case, in order, through liveCase, and no case can be skipped", () => {
    const source = readFileSync(LOGIN_CHALLENGE_USES_SMOKE_FILE, "utf8");
    const registered = [...source.matchAll(/^ {2}liveCase\(\n? *(EXPECTED_CASES\[\d+\])/gm)].length;
    expect(registered).toBe(EXPECTED_CASES.length);
    expect(source).not.toMatch(/\b(it|describe|test)\.(only|skip|todo|fails)\b/);
  });
});

describe.skipIf(!enabled)("login challenge uses — schema block, production marker statement, and real concurrency (DISPOSABLE BRANCH ONLY)", () => {
  let runId = "";
  let ownership: RunOwnership;
  let nonces: NonceRegistry;
  let lifecycle: LoginChallengeUsesLifecycle;
  let db: SmokeDb;
  let store: LoginChallengeUseStore;
  /** True from the moment a connector is about to be built: only then is there anything to report at the end. */
  let started = false;
  let baseline: DatabaseSnapshot | null = null;
  let startSaved: EvidenceResult = { ok: false, reason: "write_failed", code: null };
  let sourceIdentity: ReturnType<typeof computeSourceIdentity> | null = null;
  let repositoryState: { branch: string; commit: string } | null = null;
  let plannedBudget: ReturnType<typeof planBudget> | null = null;
  const facts: Record<string, unknown> = { connectionMode: null, server: null };
  const caseNotes: Record<string, unknown> = {};
  /** The scratch schema case S2 applies the block in; S3 inserts against it. */
  let applied = "";
  /**
   * Every PUBLIC marker this run KNOWS is present (and, being live or expired less than an hour ago, must never be purged): recorded when its use was
   * consumed, its row was inserted by a fixture, or a race left it behind. M10 checks the whole ledger by exact identity at the end.
   */
  const knownPresent = new Set<string>();

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const one = (rows: SmokeRow[]): SmokeRow => {
    if (rows.length !== 1) throw new Error(`login challenge uses smoke: expected exactly one row, got ${rows.length}`);
    return rows[0]!;
  };
  const write = (what: string, text: string, params: unknown[] = []) => lifecycle.write(what, () => db.q(text, params));
  const build = (what: string, text: string) => lifecycle.buildFixture(what, () => db.q(text));
  const rowsWrite = (what: string, rows: number, text: string, params: unknown[] = []) => lifecycle.fixtureWrite(what, rows, () => db.q(text, params));
  const applyToPublic = (what: string) => lifecycle.write(what, () => db.q(migrationBlock()));

  /** A condition the race cases depend on. If it does not hold, the case proved nothing: the run is poisoned and the case stops. */
  function insist(ok: boolean, reason: string): void {
    if (ok) return;
    lifecycle.poison(`HARNESS VALIDITY: ${reason}`);
    throw new Error(`login challenge uses smoke: ${reason}`);
  }

  /** The database's own clock, in epoch milliseconds. Every expiry below is computed from it, never from this machine's clock. */
  const dbNowMs = async (): Promise<number> => Number(one(await lifecycle.read("reading the database clock", () => db.q(DB_CLOCK_SQL))).ms);
  const isoAfter = (baseMs: number, offsetMs: number) => new Date(baseMs + offsetMs).toISOString();

  /** One marker request through the PRODUCTION adapter. The nonce must be one this run minted. */
  const consume = async (what: string, nonceHex: string, expiresAtIso: string) => {
    const outcome = await lifecycle.consume(what, () => store.consume({ nonceHex: nonces.assertOwned(nonceHex), expiresAtIso }));
    if (outcome === "consumed") knownPresent.add(nonceHex);
    return outcome;
  };
  const launchConsume = (what: string, nonceHex: string, expiresAtIso: string) => lifecycle.launch(what, () => store.consume({ nonceHex: nonces.assertOwned(nonceHex), expiresAtIso }));

  const present = async (what: string, list: readonly string[]): Promise<number> => one(await lifecycle.read(what, () => db.q(COUNT_OWNED_PRESENT_SQL, [[...list]]))).n as number;
  const presentSet = async (what: string, list: readonly string[]): Promise<Set<string>> => new Set((await lifecycle.read(what, () => db.q(LIST_OWNED_PRESENT_SQL, [[...list]]))).map((row) => String(row.nonce)));
  const markerRow = async (nonceHex: string) => one(await lifecycle.read("reading a marker row", () => db.q(READ_MARKER_SQL, [nonces.assertOwned(nonceHex)])));
  const insertMarker = async (what: string, nonceHex: string, expiresIso: string, usedIso: string) => {
    await rowsWrite(what, 1, INSERT_MARKER_SQL, [nonces.assertOwned(nonceHex), expiresIso, usedIso]);
    knownPresent.add(nonceHex);
  };
  const insertAged = (what: string, list: readonly string[], baseSeconds: number) => rowsWrite(what, list.length, INSERT_AGED_MARKERS_SQL, [list.map((nonce) => nonces.assertOwned(nonce)), baseSeconds]);

  /** Polls pg_stat_activity (bounded, counted) until `statement` sees at least `atLeast` sessions, or the deadline passes. Returns the most seen. */
  async function waitFor(what: string, statement: string, atLeast: number, deadlineMs: number): Promise<number> {
    const stop = Date.now() + deadlineMs;
    let best = 0;
    for (;;) {
      const n = one(await lifecycle.poll(what, () => db.q(statement))).n as number;
      best = Math.max(best, n);
      if (n >= atLeast || Date.now() >= stop) return best;
      await sleep(POLL_INTERVAL_MS);
    }
  }

  /** Read-only: one relation's catalog shape, as one digest. Schema and name are bound parameters. */
  const shapeDigest = async (read: TrackedRead, schema: string, relation: string): Promise<string> =>
    String(
      one(
        await read("fingerprinting a relation's catalog shape", () =>
          db.q(
            `SELECT pg_catalog.md5(COALESCE(pg_catalog.string_agg(x, '|' ORDER BY x), '')) AS digest FROM (
               SELECT 'rel:' || c.relkind::text || ':' || c.relpersistence::text || ':' || c.relrowsecurity::text AS x
                 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2
               UNION ALL
               SELECT 'col:' || a.attnum::text || ':' || a.attname || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':' || a.attcollation::text || ':' || a.attgenerated::text || ':' || COALESCE(pg_catalog.pg_get_expr(d.adbin, d.adrelid), '')
                 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                 LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
               UNION ALL
               SELECT 'con:' || k.conname || ':' || k.contype::text || ':' || k.convalidated::text || ':' || pg_catalog.pg_get_constraintdef(k.oid)
                 FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid = k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2
               UNION ALL
               SELECT 'ref:' || k.conname
                 FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid = k.confrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2
               UNION ALL
               SELECT 'idx:' || i.indexdef FROM pg_catalog.pg_indexes i WHERE i.schemaname = $1 AND i.tablename = $2
               UNION ALL
               SELECT 'trg:' || g.tgname
                 FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class c ON c.oid = g.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE NOT g.tgisinternal AND n.nspname = $1 AND c.relname = $2
               UNION ALL
               SELECT 'rule:' || w.rulename
                 FROM pg_catalog.pg_rewrite w JOIN pg_catalog.pg_class c ON c.oid = w.ev_class JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2
               UNION ALL
               SELECT 'pol:' || p.polname
                 FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2
               UNION ALL
               SELECT 'inh:' || p.relname
                 FROM pg_catalog.pg_inherits h JOIN pg_catalog.pg_class c ON c.oid = h.inhrelid JOIN pg_catalog.pg_class p ON p.oid = h.inhparent JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2
             ) s`,
            [schema, relation],
          ),
        ),
      ).digest,
    );

  /** Read-only: every public table's row count, content digest, and shape digest, plus the names of the non-system schemas. */
  async function snapshot(read: TrackedRead): Promise<DatabaseSnapshot> {
    const names = (await read("listing the public tables", () => db.q("SELECT c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname"))).map((row) => assertPlainIdentifier(row.name));
    const tables: DatabaseSnapshot["tables"] = {};
    for (const table of names) {
      const content = one(await read("fingerprinting a public table's contents", () => db.q(`SELECT count(*)::int AS n, COALESCE(pg_catalog.md5(pg_catalog.string_agg(pg_catalog.md5(t::text), '' ORDER BY pg_catalog.md5(t::text))), '') AS digest FROM public.${table} t`)));
      tables[table] = { rows: content.n as number, contentDigest: String(content.digest), shapeDigest: await shapeDigest(read, "public", table) };
    }
    const schemas = (await read("listing the schemas", () => db.q("SELECT n.nspname::text AS name FROM pg_catalog.pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' ORDER BY 1"))).map((row) => String(row.name));
    return { tables, schemas };
  }

  /** Read-only: `<schema>.real_login_challenge_uses` in the shape the expected-delta comparison takes. `schema` is `public` or a schema this run owns. */
  async function describeTable(read: TrackedRead, schema: string): Promise<ProviderTableDescriptor> {
    if (schema !== "public") ownership.assertOwnedSchema(schema);
    const at = [schema, TABLE];
    const columns = await read("reading the table's columns", () =>
      db.q(
        `SELECT a.attname::text AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
                (SELECT co.collname::text FROM pg_catalog.pg_collation co WHERE co.oid = a.attcollation AND co.collname <> 'default') AS collation
           FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
        at,
      ),
    );
    const constraints = await read("reading the table's constraints", () =>
      db.q(
        `SELECT k.conname::text AS name, k.contype::text AS type,
                (SELECT pg_catalog.string_agg(a.attname::text, ',' ORDER BY u.ord) FROM pg_catalog.unnest(k.conkey) WITH ORDINALITY u(attnum, ord)
                   JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum) AS columns
           FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid = k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2 AND k.contype IN ('c', 'p') ORDER BY k.conname`,
        at,
      ),
    );
    const indexes = await read("reading the table's indexes", () => db.q("SELECT i.indexname::text AS name FROM pg_catalog.pg_indexes i WHERE i.schemaname = $1 AND i.tablename = $2 ORDER BY 1", at));
    const counts = one(
      await read("reading the table's triggers, foreign keys, and policies", () =>
        db.q(
          `SELECT (SELECT count(*) FROM pg_catalog.pg_trigger g WHERE g.tgrelid = c.oid AND NOT g.tgisinternal)::int AS triggers,
                  (SELECT count(*) FROM pg_catalog.pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'f')::int AS fk_out,
                  (SELECT count(*) FROM pg_catalog.pg_constraint k WHERE k.confrelid = c.oid)::int AS fk_in,
                  (SELECT count(*) FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid)::int AS policies,
                  (c.relrowsecurity OR c.relforcerowsecurity) AS row_security
             FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`,
          at,
        ),
      ),
    );
    const rows = one(await read("counting the table's rows", () => db.q(`SELECT count(*)::int AS n FROM ${schema === "public" ? "public" : assertPlainIdentifier(schema)}.${TABLE}`)));
    return {
      columns: columns.map((row) => ({ name: String(row.name), type: String(row.type), notNull: row.not_null === true, collation: row.collation === null ? null : String(row.collation) })),
      constraints: constraints.map((row) => ({ name: String(row.name), type: row.type as "c" | "p", columns: String(row.columns).split(",") })),
      indexes: indexes.map((row) => String(row.name)),
      triggers: counts.triggers as number,
      foreignKeysOut: counts.fk_out as number,
      foreignKeysIn: counts.fk_in as number,
      policies: counts.policies as number,
      rowSecurity: counts.row_security === true,
      rows: rows.n as number,
    };
  }

  /** The rows of a scratch copy this run owns, as hex nonces (ordered). */
  const scratchNonces = async (schema: string): Promise<string[]> => (await lifecycle.read("reading the scratch table's rows", () => db.q(scratchRowsSql(ownership, schema)))).map((row) => String(row.nonce));

  /** Creates one look-alike in a scratch schema of its own — every object registered before it exists — and returns the schema. */
  async function buildVariant(variant: Variant): Promise<string> {
    const schema = ownership.registerScratchSchema(variant.suffix);
    await write("creating a scratch schema", `CREATE SCHEMA ${schema}`);
    for (const step of variant.steps(schema)) {
      if (step.register) ownership.registerScratchObject(schema, step.register[0] as ScratchObjectKind, step.register[1]);
      // Building the FIXTURE goes through buildFixture: a database refusal of the fixture is a HARNESS FAILURE, never a migration refusal.
      await build(`building the look-alike (${variant.what})`, step.sql);
    }
    return schema;
  }
  /** The block must REFUSE the look-alike with its own RAISE (or the SQLSTATE this look-alike names) and leave it exactly as it was. */
  async function refusesAndLeavesUnchanged(variant: Variant): Promise<string> {
    const schema = await buildVariant(variant);
    const before = await shapeDigest(lifecycle.read, schema, TABLE);
    const refusal = await lifecycle.expectMigrationRefusal(`the block against a look-alike (${variant.what})`, () => db.q(migrationBlockFor(schema)), variant.allowed ?? ["P0001"]);
    expect(await shapeDigest(lifecycle.read, schema, TABLE), variant.what).toBe(before);
    return refusal.sqlState;
  }

  /**
   * A live case. Everything it does to the database happens inside lifecycle.runCase, which refuses before the body — before any
   * database activity — once the run is poisoned or an earlier case is still running, and poisons the run if the body outlives its deadline.
   */
  function liveCase(name: (typeof EXPECTED_CASES)[number], body: () => Promise<void>) {
    it(name, () => lifecycle.runCase(name, body), VITEST_TIMEOUT_MS);
  }

  beforeAll(async () => {
    const url = requireDisposableTargetUrl(GATE, ALLOWED_GATES);
    const mode = requirePooledMode(parseDatabaseUrl(url, false));
    if (!mode.ok) throw new Error(`Login challenge uses smoke refused before any database work: ${mode.reason}`);
    const selection = checkLoginChallengeUsesFileSelection(inject("vitestCliArgs"));
    if (!selection.ok) throw new Error(`Login challenge uses smoke refused before any database work: ${selection.reason}`);
    const timeouts = checkRunnerTimeoutFlags(inject("vitestCliArgs"));
    if (!timeouts.ok) throw new Error(`Login challenge uses smoke refused before any database work: ${timeouts.reason}`);
    // The code about to run is the code that was audited: the migrations, the production marker statement, and the source digest the operator confirmed.
    const schemaText = readFileSync(SCHEMA_PATH, "utf8");
    const identities = checkMigrationIdentities(schemaText);
    if (!identities.ok) throw new Error(`Login challenge uses smoke refused before any database work: ${identities.reason}`);
    const captured = await captureProductionMarkerSql();
    const markerSql = checkProductionMarkerSql(captured);
    if (!markerSql.ok) throw new Error(`Login challenge uses smoke refused before any database work: ${markerSql.reason}`);
    const repository = readRepositoryHead();
    if (!repository.ok) throw new Error(`Login challenge uses smoke refused before any database work: ${repository.reason}`);
    repositoryState = { branch: repository.branch, commit: repository.commit };
    sourceIdentity = computeSourceIdentity({
      schemaText,
      neonStoreText: readFileSync(STORE_PATH, "utf8"),
      loginChallengeText: readFileSync(CHALLENGE_PATH, "utf8"),
      loginChallengeUsesText: readFileSync(USES_PATH, "utf8"),
      harnessSmokeText: readFileSync(LOGIN_CHALLENGE_USES_SMOKE_FILE, "utf8"),
      harnessFixtureText: readFileSync(FIXTURE_PATH, "utf8"),
      sharedHelpers: Object.fromEntries(Object.entries(SHARED_HELPER_FILES).map(([name, file]) => [name, readFileSync(file, "utf8")])) as Record<SharedHelperName, string>,
    });
    const authorization = checkRunAuthorization({ env: process.env, identity: sourceIdentity, evidenceDirectory: EVIDENCE_DIRECTORY });
    if (!authorization.ok) throw new Error(`Login challenge uses smoke refused before any database work: ${authorization.reason}`);
    plannedBudget = planBudget(scenarioInventory());
    if (!plannedBudget.ok) throw new Error(`Login challenge uses smoke refused before any database work: ${plannedBudget.violations.join("; ")}`);
    const capacity = checkScratchCapacity(plannedBudget.totals.scratchSchemas, SCRATCH_SCHEMA_REGISTRY_CAPACITY);
    if (!capacity.ok) throw new Error(`Login challenge uses smoke refused before any database work: ${capacity.reason}`);
    const raceScript = checkRaceScript({ expiryOffsetMs: RACE_EXPIRY_OFFSET_MS, holderSleepSeconds: RACE_HOLDER_SLEEP_SECONDS, holderWaitMs: HOLDER_WAIT_MS });
    if (!raceScript.ok) throw new Error(`Login challenge uses smoke refused before any database work: ${raceScript.reason}`);
    runId = authorization.runId;
    ownership = createLoginChallengeUsesOwnership(runId);
    nonces = createNonceRegistry(runId);
    lifecycle = createLoginChallengeUsesLifecycle({ expectedCases: EXPECTED_CASES, requiredPreflightChecks: PREFLIGHT_CHECKS, caseDeadlineMs: CASE_DEADLINE_MS, cleanupDeadlineMs: CLEANUP_DEADLINE_MS, preflightDeadlineMs: CASE_DEADLINE_MS, ownership, nonces });
    // Every refusal is behind us. The label only — never the connection string.
    console.log(`[login-challenge-uses-smoke] connection_mode: ${mode.mode}`);
    started = true;
    db = await connectSmokeDb(url);
    const stores = await connectSmokeStores(url);
    store = stores.loginChallengeUses;
    facts.connectionMode = mode.mode;

    // Everything in the preflight is READ-ONLY, tracked, and under one deadline; the run is armed only at its very end.
    await lifecycle.runPreflight(async () => {
      // ONE single-statement request: the same autocommit path the production marker statement takes. Never a batch.
      const server = one(await lifecycle.read("reading the server's identity", () => db.q("SELECT pg_catalog.current_database()::text AS database, pg_catalog.current_setting('server_version') AS version, pg_catalog.current_setting('server_version_num')::int AS version_num, pg_catalog.current_setting('transaction_isolation') AS isolation, pg_catalog.current_setting('default_transaction_isolation') AS default_isolation, pg_catalog.pg_is_in_recovery() AS in_recovery, pg_catalog.current_schema()::text AS current_schema")));
      facts.server = { database: server.database, version: server.version, isolation: server.isolation, defaultIsolation: server.default_isolation, inRecovery: server.in_recovery };
      lifecycle.preflightCheck("the connected database is the one the confirmed URL names", server.database === new URL(url).pathname.slice(1));
      lifecycle.preflightCheck("the target is not a read replica", server.in_recovery === false);
      lifecycle.preflightCheck("unqualified names resolve to public", server.current_schema === "public");
      lifecycle.preflightCheck("the server is version 15 or newer (the migration reads pg_index.indnullsnotdistinct)", typeof server.version_num === "number" && server.version_num >= 150000);
      lifecycle.preflightCheck("a single autocommit statement runs at READ COMMITTED (the path production uses)", server.isolation === "read committed");
      lifecycle.preflightCheck("the database default isolation is READ COMMITTED", server.default_isolation === "read committed");
      const sameName = one(await lifecycle.read("looking for an existing marker relation", () => db.q("SELECT count(*)::int AS n FROM pg_catalog.pg_class c WHERE c.relname = 'real_login_challenge_uses'")));
      lifecycle.preflightCheck("no relation named real_login_challenge_uses exists in any schema", sameName.n === 0);
      const usedBranch = one(await lifecycle.read("looking for an earlier smoke's table", () => db.q("SELECT count(*)::int AS n FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'real_registration_admission'")));
      lifecycle.preflightCheck("public.real_registration_admission does not exist (a branch an earlier smoke used is refused)", usedBranch.n === 0);
      const visible = one(await lifecycle.read("checking that this session can read its own activity entry", () => db.q(CAN_SEE_ACTIVITY_SQL)));
      lifecycle.preflightCheck("this session can read its own pg_stat_activity entry (other sessions are seen only by the race cases' polls, which poison the run if they see nothing)", visible.n === 1);
      baseline = await snapshot(lifecycle.read);
      lifecycle.preflightCheck("public.real_rate_limits exists", Object.hasOwn(baseline.tables, "real_rate_limits"));
      lifecycle.preflightCheck("no scratch schema of this harness's shape exists", !baseline.schemas.some((name) => name.startsWith("pb_smoke_")));
      // The START record is saved before anything may be written: without it the run cannot be armed.
      const startEvidence = {
        runId,
        repository: repositoryState,
        sourceIdentity,
        migrationIdentity: { name: MIGRATION_IDENTITY.name, length: MIGRATION_IDENTITY.length, sha256: MIGRATION_IDENTITY.sha256 },
        markerSqlIdentity: { referenceSha256: MARKER_SQL_REFERENCE_SHA256, productionMatchesReference: true },
        targetProofStatus: TARGET_PROOF_STATUS,
        server: facts.server,
        connectionMode: facts.connectionMode,
        scenarioInventory: scenarioInventory(),
        plannedBudget,
        fingerprintsBefore: baseline,
      };
      startSaved = writeLoginChallengeUsesEvidence({ directory: EVIDENCE_DIRECTORY, runId, stage: "start", evidence: startEvidence });
      lifecycle.arm({ startEvidence: startSaved });
    });
  }, VITEST_TIMEOUT_MS);

  // After EVERY test: nothing is sent. The runner's own verdict on the test, or a body it abandoned, poisons the run.
  afterEach((context) => {
    if (started) lifecycle.afterCase({ reportedFailed: caseFailedInVitest(context) });
  }, VITEST_TIMEOUT_MS);

  // The end of the run: no write, no cleanup, and no read at all once the run is poisoned.
  afterAll(async () => {
    if (!started) return;
    let after: DatabaseSnapshot | null = null;
    const final = await lifecycle.finish({
      deadlineMs: CLEANUP_DEADLINE_MS,
      compare: async (read) => {
        after = await snapshot(read);
        const markerTable = await describeTable(read, "public");
        return compareWithExpectedMarkerDelta({ before: baseline, after, markerTable, ownedSchemas: ownership.ownedSchemas() });
      },
    });
    // Evidence for review: counts, digests, outcomes, this run's own fixture names, SQLSTATEs. Never a URL, an endpoint id, a credential, or a driver's error text.
    const evidence = {
      runId,
      repository: repositoryState,
      sourceIdentity,
      migrationIdentity: { name: MIGRATION_IDENTITY.name, length: MIGRATION_IDENTITY.length, sha256: MIGRATION_IDENTITY.sha256 },
      markerSqlIdentity: { referenceSha256: MARKER_SQL_REFERENCE_SHA256, productionMatchesReference: true },
      targetProofStatus: TARGET_PROOF_STATUS,
      server: facts.server,
      connectionMode: facts.connectionMode,
      scenarioInventory: scenarioInventory(),
      plannedBudget,
      actualBudget: final.actualBudget,
      lifecycleOutcome: final.outcome,
      casesExecuted: final.executed,
      casesNotExecuted: final.notExecuted,
      markerTallies: final.markerTallies,
      fixtureReport: final.fixtureReport,
      migrationRefusals: final.migrationRefusals,
      observations: { ...final.observations, notes: caseNotes },
      cleanup: final.cleanup,
      fingerprintsBefore: baseline,
      fingerprintsAfter: after,
      expectedDelta: final.delta,
      unknownOperations: final.unknownOperations,
      inFlightOperations: final.inFlightOperations,
      disposition: final.disposition,
      completeRestoration: final.completeRestoration,
      poisoned: final.poisoned,
      ownedSchemas: final.ownedSchemas,
      ownedMarkers: final.ownedMarkers,
      startEvidence: startSaved.ok ? "saved" : startSaved.reason,
      action: final.action,
    };
    const finalSaved = writeLoginChallengeUsesEvidence({ directory: EVIDENCE_DIRECTORY, runId, stage: "final", evidence });
    const verdict = concludeLoginChallengeUsesRun(final, { start: startSaved, final: finalSaved });
    console.log(`[login-challenge-uses-smoke] ${safeEvidenceJson({ ...evidence, finalEvidence: finalSaved.ok ? "saved" : finalSaved.reason, runVerdict: verdict.verdict }) ?? '{"evidence":"withheld: it failed the content check"}'}`);
    // Fails for a poisoned run, a delta mismatch, AND a clean run whose evidence could not be saved. Nothing else happens here.
    if (!verdict.pass) throw new Error(verdict.message);
  }, VITEST_TIMEOUT_MS);

  // ---------------------------------------------------------------- S: the schema block

  liveCase(EXPECTED_CASES[0], async () => {
    // 42P01 = undefined_table. The adapter throws; it never answers "consumed" and never a rejection.
    const missing = nonces.register("s1-missing-table");
    const refusal = await lifecycle.expectMarkerDatabaseError("a marker request with no table", () => store.consume({ nonceHex: missing, expiresAtIso: isoAfter(Date.now(), 120_000) }), ["42P01"]);
    caseNotes.s1 = refusal;
  });

  liveCase(EXPECTED_CASES[1], async () => {
    const schema = registerPlan(ownership, APPLY_PLAN);
    await write("creating a scratch schema", `CREATE SCHEMA ${schema}`);
    await write("the block's first apply in a scratch schema", migrationBlockFor(schema));
    expect(await describeTable(lifecycle.read, schema)).toEqual(EXPECTED_MARKER_TABLE);
    expect(await scratchNonces(schema)).toEqual([]); // the migration writes no row at all
    const shape = await shapeDigest(lifecycle.read, schema, TABLE);
    // A marker already recorded in the migration-created table must survive the idempotent rerun, untouched.
    const kept = "5e".repeat(16);
    await rowsWrite("recording one marker in the scratch table (test fixture)", 1, scratchInsertSql(ownership, schema, { nonceBytesHex: kept, expires: "2030-01-01T00:00:00.000Z", used: "now()" }));
    await write("the block's rerun in a scratch schema", migrationBlockFor(schema));
    expect(await scratchNonces(schema)).toEqual([kept]);
    expect(await describeTable(lifecycle.read, schema)).toEqual({ ...EXPECTED_MARKER_TABLE, rows: 1 });
    expect(await shapeDigest(lifecycle.read, schema, TABLE)).toBe(shape);
    await write("the block's second rerun in a scratch schema", migrationBlockFor(schema));
    expect(await scratchNonces(schema)).toEqual([kept]);
    applied = schema;
    caseNotes.s2 = { rowsAfterApply: 0, markerAfterReruns: "preserved", descriptor: "exact" };
  });

  liveCase(EXPECTED_CASES[2], async () => {
    ownership.assertOwnedSchema(applied);
    const hex16 = "ab".repeat(16);
    const row = (nonceBytesHex: string, expires = "2030-01-01T00:00:00.000Z", used = "now()") => scratchInsertSql(ownership, applied, { nonceBytesHex, expires, used });
    // The valid row, and then each rule broken in exactly one way. 23514 = check_violation, 23505 = unique_violation, 23502 = not_null_violation.
    await rowsWrite("recording a valid marker in the scratch table (test fixture)", 1, row(hex16));
    expect((await lifecycle.expectDatabaseRefusal("a 15-byte nonce", () => db.q(row("ab".repeat(15))), ["23514"])).constraint).toBe("real_login_challenge_uses_nonce_length_check");
    expect((await lifecycle.expectDatabaseRefusal("a 17-byte nonce", () => db.q(row("ab".repeat(17))), ["23514"])).constraint).toBe("real_login_challenge_uses_nonce_length_check");
    expect((await lifecycle.expectDatabaseRefusal("an empty nonce", () => db.q(row("")), ["23514"])).constraint).toBe("real_login_challenge_uses_nonce_length_check");
    expect((await lifecycle.expectDatabaseRefusal("a duplicate nonce", () => db.q(row(hex16)), ["23505"])).constraint).toBe("real_login_challenge_uses_pkey");
    await lifecycle.expectDatabaseRefusal("a NULL nonce", () => db.q(row("NULL")), ["23502"]);
    await lifecycle.expectDatabaseRefusal("a NULL expiration (there is no default)", () => db.q(row("cd".repeat(16), "NULL")), ["23502"]);
    await lifecycle.expectDatabaseRefusal("a NULL used time (there is no default)", () => db.q(row("cd".repeat(16), "2030-01-01T00:00:00.000Z", "NULL")), ["23502"]);
    expect(await scratchNonces(applied)).toEqual([hex16, "5e".repeat(16)].sort());
  });

  liveCase(EXPECTED_CASES[3], async () => {
    // The controls: the same parts, unchanged, are the intended table — so every variant below differs from it in exactly one way.
    const withIndex = await buildVariant(CONTROL_WITH_INDEX);
    const heldRow = "c1".repeat(16);
    await rowsWrite("recording one marker in an exact hand-built copy (test fixture)", 1, scratchInsertSql(ownership, withIndex, { nonceBytesHex: heldRow, expires: "2030-01-01T00:00:00.000Z", used: "now()" }));
    const shapeBefore = await shapeDigest(lifecycle.read, withIndex, TABLE);
    await write("the block against an exact hand-built copy with its index", migrationBlockFor(withIndex));
    expect(await describeTable(lifecycle.read, withIndex)).toEqual({ ...EXPECTED_MARKER_TABLE, rows: 1 });
    expect(await scratchNonces(withIndex)).toEqual([heldRow]); // a correct existing table keeps its rows
    expect(await shapeDigest(lifecycle.read, withIndex, TABLE)).toBe(shapeBefore); // and an exact copy is not rebuilt
    const withoutIndex = await buildVariant(CONTROL_WITHOUT_INDEX);
    expect((await describeTable(lifecycle.read, withoutIndex)).indexes).toEqual(["real_login_challenge_uses_pkey"]);
    await write("the block against an exact hand-built copy without its index", migrationBlockFor(withoutIndex));
    expect(await describeTable(lifecycle.read, withoutIndex)).toEqual(EXPECTED_MARKER_TABLE); // the missing expiry index is created, and nothing else
    const refusals: Record<string, string> = {};
    for (const variant of GROUP_A1) refusals[variant.suffix] = await refusesAndLeavesUnchanged(variant);
    expect(Object.keys(refusals)).toHaveLength(14);
    caseNotes.s4a = refusals;
  });

  liveCase(EXPECTED_CASES[4], async () => {
    const refusals: Record<string, string> = {};
    for (const variant of GROUP_A2) refusals[variant.suffix] = await refusesAndLeavesUnchanged(variant);
    expect(Object.keys(refusals)).toHaveLength(14);
    caseNotes.s4b = refusals;
  });

  liveCase(EXPECTED_CASES[5], async () => {
    const refusals: Record<string, string> = {};
    for (const variant of GROUP_B) refusals[variant.suffix] = await refusesAndLeavesUnchanged(variant);
    expect(Object.keys(refusals)).toHaveLength(21);
    caseNotes.s5 = refusals;
  });

  liveCase(EXPECTED_CASES[6], async () => {
    // Of this run's shape, but deliberately never registered and never created: the block must not create it.
    const absent = `pb_smoke_${runId}_absent`;
    await lifecycle.expectMigrationRefusal("the block against a schema that does not exist", () => db.q(migrationBlockFor(absent)), ["P0001"]);
    const found = one(await lifecycle.read("looking for the schema the block was refused", () => db.q("SELECT count(*)::int AS n FROM pg_catalog.pg_namespace WHERE nspname = $1", [absent])));
    expect(found.n).toBe(0);
  });

  liveCase(EXPECTED_CASES[7], async () => {
    // The ONLY applications of the block to `public` in the whole run.
    await applyToPublic("the block's first apply in public");
    expect(await describeTable(lifecycle.read, "public")).toEqual(EXPECTED_MARKER_TABLE);
    const shape = await shapeDigest(lifecycle.read, "public", TABLE);
    // The production statement names the table without a schema: it must resolve to the one just created.
    const resolved = one(await lifecycle.read("resolving the unqualified table name", () => db.q("SELECT (pg_catalog.to_regclass('real_login_challenge_uses') IS NOT NULL AND pg_catalog.to_regclass('real_login_challenge_uses') = pg_catalog.to_regclass('public.real_login_challenge_uses')) AS same")));
    expect(resolved.same).toBe(true);
    // A marker recorded through the PRODUCTION adapter survives the rerun, byte for byte.
    const kept = nonces.register("s7-kept");
    const exp = isoAfter(await dbNowMs(), 120_000);
    expect(await consume("a marker recorded before the rerun", kept, exp)).toBe("consumed");
    const before = await markerRow(kept);
    await applyToPublic("the block's rerun in public");
    expect(await describeTable(lifecycle.read, "public")).toEqual({ ...EXPECTED_MARKER_TABLE, rows: 1 });
    expect(await shapeDigest(lifecycle.read, "public", TABLE)).toBe(shape);
    expect(await markerRow(kept)).toEqual(before);
    // The Slice E table was not touched by any of it.
    expect(await shapeDigest(lifecycle.read, "public", "real_rate_limits")).toBe(baseline!.tables.real_rate_limits!.shapeDigest);
  });

  // ---------------------------------------------------------------- M: the production marker statement

  liveCase(EXPECTED_CASES[8], async () => {
    // The single-statement path again, now that the table exists.
    const level = one(await lifecycle.read("reading the isolation level through the single-statement path", () => db.q("SELECT pg_catalog.current_setting('transaction_isolation') AS level")));
    expect(level.level).toBe("read committed");
    // Inside ONE transaction now() does not move while the wall clock does: this is the stale-clock hazard the statement is built against.
    const batch = await lifecycle.read("reading now() and clock_timestamp() across a one-second sleep inside one transaction", () => db.tx([...CLOCK_BATCH]));
    const first = batch[0]![0]!;
    const last = batch[2]![0]!;
    expect(new Date(first.tx_start as string).getTime()).toBe(new Date(last.tx_start_again as string).getTime());
    expect(last.wall_moved).toBe(true);
    // A boolean computed by the database arrives in JavaScript as a boolean: the adapter's `live` flag depends on it.
    const probe = one(await lifecycle.read("reading a boolean computed by the database", () => db.q(BOOLEAN_PROBE_SQL)));
    expect(probe.yes).toBe(true);
    expect(probe.no).toBe(false);
    expect(typeof probe.yes).toBe("boolean");
    caseNotes.m1 = { isolation: level.level, nowFrozenInTransaction: true, wallClockMoved: true, booleanTransport: "boolean" };
  });

  liveCase(EXPECTED_CASES[9], async () => {
    const n = nonces.register("m2-first-use");
    const exp = isoAfter(await dbNowMs(), 120_000);
    expect(await consume("the first use", n, exp)).toBe("consumed");
    expect(await consume("a replay of the same challenge", n, exp)).toBe("rejected");
    expect(await consume("a second replay", n, exp)).toBe("rejected");
    const row = await markerRow(n);
    expect(row.nonce_bytes).toBe(16);
    expect(Date.parse(`${String(row.expires_utc).replace(" ", "T")}Z`)).toBe(Date.parse(exp));
    expect(row.used_not_future).toBe(true);
    expect(await present("counting the marker after the replays", [n])).toBe(1);
    // A different nonce under the same expiration is independent.
    const other = nonces.register("m2-other");
    expect(await consume("a different challenge with the same expiration", other, exp)).toBe("consumed");
    expect(await present("counting both markers", [n, other])).toBe(2);
  });

  liveCase(EXPECTED_CASES[10], async () => {
    // Every expiry is computed from the DATABASE clock. Over HTTP the exact millisecond edge cannot be hit, so each boundary is probed with a margin well beyond the latency.
    const base = await dbNowMs();
    const probes: Array<[string, number, "consumed" | "rejected"]> = [
      ["m3-expired-10s", -10_000, "rejected"],
      ["m3-expired-1s", -1_000, "rejected"],
      ["m3-soon-20s", 20_000, "consumed"],
      ["m3-ahead-9m30s", 570_000, "consumed"],
      ["m3-ahead-10m30s", 630_000, "rejected"],
      ["m3-ahead-one-year", 365 * 86_400_000, "rejected"],
    ];
    const results: Record<string, string> = {};
    for (const [label, offset, expected] of probes) {
      const n = nonces.register(label);
      const outcome = await consume(`a challenge expiring ${offset} ms from the database clock`, n, isoAfter(base, offset));
      expect(outcome, label).toBe(expected);
      // A rejection by the pre-filter writes nothing; an acceptance writes exactly one row.
      expect(await present(`counting the marker for ${label}`, [n]), label).toBe(expected === "consumed" ? 1 : 0);
      results[label] = outcome;
    }
    caseNotes.m3 = results;
  });

  liveCase(EXPECTED_CASES[11], async () => {
    // One nonce. A holder inserts it UNCOMMITTED and sleeps; 60 requests are launched and must be OBSERVED waiting on that insert; then the holder rolls back.
    const n = nonces.register("m4-one-nonce");
    const exp = isoAfter(await dbNowMs(), 150_000);
    const holder = lifecycle.launch("holder: inserts the nonce uncommitted, then rolls back", () => db.tx(holderInsertAndRollback(n, exp, 26)));
    const holderUp = await waitFor("waiting for the holder to be sleeping", HOLDER_ACTIVE_SQL, 1, HOLDER_WAIT_MS);
    const requests = Array.from({ length: BURST }, (_, index) => launchConsume(`simultaneous request ${index + 1} of ${BURST}`, n, exp));
    const blocked = await waitFor("waiting for 60 requests to be blocked on the uncommitted insert", MARKER_WAITERS_SQL, BURST, BLOCK_WAIT_MS);
    await lifecycle.collectHolderRolledBack(holder);
    const outcomes: MarkerOutcome[] = [];
    for (const request of requests) outcomes.push(await lifecycle.collectMarker(request));
    lifecycle.observe("m4", { holderObserved: holderUp, blockedObserved: blocked, requests: requests.length });
    insist(holderUp >= 1 && blocked >= BURST, `only ${blocked} of ${BURST} requests were observed waiting together; the overlap is not proven`);
    expect(tallyOutcomes(outcomes)).toEqual({ consumed: 1, rejected: BURST - 1 });
    expect(await present("counting the marker after the race", [n])).toBe(1);
    knownPresent.add(n);
  });

  liveCase(EXPECTED_CASES[12], async () => {
    // 60 distinct nonces. A holder takes a table lock that blocks every insert; 60 requests are OBSERVED waiting on it, and released together.
    const list = nonces.registerMany("m5-distinct", BURST);
    const exp = isoAfter(await dbNowMs(), 150_000);
    const holder = lifecycle.launch("holder: locks the marker table against inserts, then commits", () => db.tx(holderTableGate(26)));
    const holderUp = await waitFor("waiting for the holder to be sleeping", HOLDER_ACTIVE_SQL, 1, HOLDER_WAIT_MS);
    const requests = list.map((n, index) => launchConsume(`simultaneous request ${index + 1} of ${BURST}`, n, exp));
    const blocked = await waitFor("waiting for 60 requests to be blocked on the table lock", MARKER_WAITERS_SQL, BURST, BLOCK_WAIT_MS);
    await lifecycle.collectHolderCommitted(holder);
    const outcomes: MarkerOutcome[] = [];
    for (const request of requests) outcomes.push(await lifecycle.collectMarker(request));
    lifecycle.observe("m5", { holderObserved: holderUp, blockedObserved: blocked, requests: requests.length });
    insist(holderUp >= 1 && blocked >= BURST, `only ${blocked} of ${BURST} requests were observed waiting together; the overlap is not proven`);
    expect(tallyOutcomes(outcomes)).toEqual({ consumed: BURST });
    expect(await present("counting the markers after the race", list)).toBe(BURST);
    for (const n of list) knownPresent.add(n);
  });

  liveCase(EXPECTED_CASES[13], async () => {
    // The highest-priority race. A challenge is consumed; another session removes its marker (as a purge would) and keeps the removal UNCOMMITTED past the
    // challenge's expiry; a replay starts BEFORE expiry, passes its pre-filter, and waits. When the removal commits the replay's insert finds no conflict —
    // and must still not be admitted, because the challenge has expired by the database's clock.
    // TIMING EVIDENCE: the holder's batch reads the DATABASE clock first and last (MEASURED); the replay's blocking is observed in pg_stat_activity (MEASURED).
    const n = nonces.register("m6-replay");
    const base = await dbNowMs();
    const exp = isoAfter(base, RACE_EXPIRY_OFFSET_MS);
    expect(await consume("the original use", n, exp)).toBe("consumed");
    const holder = lifecycle.launch("holder: removes the marker uncommitted, then commits after expiry", () => db.tx(holderDeleteAndCommitTimed(n, RACE_HOLDER_SLEEP_SECONDS)));
    const holderUp = await waitFor("waiting for the holder to be sleeping", HOLDER_ACTIVE_SQL, 1, HOLDER_WAIT_MS);
    const replay = launchConsume("the replay, started before expiry", n, exp);
    const blocked = await waitFor("waiting for the replay to block behind the removal", MARKER_WAITERS_SQL, 1, BLOCK_WAIT_MS);
    const released = await lifecycle.collectHolderCommitted(holder);
    const outcome = await lifecycle.collectMarker(replay);
    const afterMs = await dbNowMs();
    const timed = parseTimedHolderResult(released);
    const rowAfter = (await present("counting the marker after the stale-clock replay", [n])) === 1;
    const evidence = raceTimingEvidence({ expiryIso: exp, expiryOffsetMs: RACE_EXPIRY_OFFSET_MS, intendedHolderSleepSeconds: RACE_HOLDER_SLEEP_SECONDS, holderKind: "commit", holderSleepingSeenBeforeReplay: holderUp, replayBlockedSeen: blocked, timed, dbClockAfterCollectMs: afterMs, expiredAtStatementPostCheck: outcome.kind === "rejected" && rowAfter ? true : null });
    lifecycle.observe("m6", evidence);
    insist(holderUp >= 1 && blocked >= 1, "the replay was not observed waiting behind the uncommitted removal; the interleaving was not built");
    insist(timed !== null, "the holder's in-batch database-clock readings were missing or malformed; the release time is not measured");
    insist(timed!.startedMs < Date.parse(exp) && timed!.releasedMs > Date.parse(exp), "the holder's measured database-clock readings do not show it starting before the expiry and releasing after it; the interleaving was not built");
    insist(afterMs > Date.parse(exp), "the database clock, read after the holder was collected, was not past the expiry");
    expect(outcome.kind).toBe("rejected");
    // The replay's marker was inserted and kept (an expired marker is never an admission); a further replay is rejected too.
    expect(rowAfter).toBe(true);
    knownPresent.add(n);
    expect(await consume("a further replay", n, exp)).toBe("rejected");
  });

  liveCase(EXPECTED_CASES[14], async () => {
    // A holder inserts the nonce UNCOMMITTED and keeps it past expiry, then ROLLS BACK. A request started before expiry waits on that insert; once it rolls back
    // the request's own insert succeeds — and must not be admitted, because the challenge has expired.
    // TIMING EVIDENCE: a rollback holder's batch ends in an error, which discards its results, so its start and release instants are NOT OBSERVED. What is
    // MEASURED is the request's blocking (pg_stat_activity), the database clock after collection (an upper bound), and the request's own outcome: rejected with its
    // marker row present means its post-insert check, after the lock wait, found the challenge expired.
    const n = nonces.register("m7-blocked-insert");
    const base = await dbNowMs();
    const exp = isoAfter(base, RACE_EXPIRY_OFFSET_MS);
    const holder = lifecycle.launch("holder: inserts the nonce uncommitted, then rolls back after expiry", () => db.tx(holderInsertAndRollback(n, exp, RACE_HOLDER_SLEEP_SECONDS)));
    const holderUp = await waitFor("waiting for the holder to be sleeping", HOLDER_ACTIVE_SQL, 1, HOLDER_WAIT_MS);
    const request = launchConsume("the request, started before expiry", n, exp);
    const blocked = await waitFor("waiting for the request to block behind the uncommitted insert", MARKER_WAITERS_SQL, 1, BLOCK_WAIT_MS);
    await lifecycle.collectHolderRolledBack(holder);
    const outcome = await lifecycle.collectMarker(request);
    const afterMs = await dbNowMs();
    const rowAfter = (await present("counting the marker after the blocked insert", [n])) === 1;
    const evidence = raceTimingEvidence({ expiryIso: exp, expiryOffsetMs: RACE_EXPIRY_OFFSET_MS, intendedHolderSleepSeconds: RACE_HOLDER_SLEEP_SECONDS, holderKind: "rollback", holderSleepingSeenBeforeReplay: holderUp, replayBlockedSeen: blocked, timed: null, dbClockAfterCollectMs: afterMs, expiredAtStatementPostCheck: outcome.kind === "rejected" && rowAfter ? true : null });
    lifecycle.observe("m7", evidence);
    insist(holderUp >= 1 && blocked >= 1, "the request was not observed waiting behind the uncommitted insert; the interleaving was not built");
    insist(afterMs > Date.parse(exp), "the database clock, read after the holder was collected, was not past the expiry");
    expect(outcome.kind).toBe("rejected");
    expect(rowAfter).toBe(true);
    knownPresent.add(n);
    expect(await consume("a further attempt", n, exp)).toBe("rejected");
  });

  liveCase(EXPECTED_CASES[15], async () => {
    // The original, UNSAFE candidate (purge `expires_at < now()`, insert `WHERE exp > now()`, no post-insert check), on a scratch copy and in the M6 interleaving.
    // It must re-admit: that is what makes M6's rejection of the same interleaving by the production statement meaningful. If it does NOT, M6 proved less than
    // it appears to, and the run says so by poisoning.
    const schema = await buildVariant(CONTRAST_VARIANT);
    const n = nonces.register("m8-contrast");
    const base = await dbNowMs();
    const exp = isoAfter(base, RACE_EXPIRY_OFFSET_MS);
    await rowsWrite("recording the consumed marker in the scratch copy (test fixture)", 1, scratchInsertSql(ownership, schema, { nonceBytesHex: n, expires: exp, used: "now()" }));
    const holder = lifecycle.launch("holder: removes the marker uncommitted, then commits after expiry", () => db.tx(holderDeleteAndCommitTimed(n, RACE_HOLDER_SLEEP_SECONDS, schema, ownership)));
    const holderUp = await waitFor("waiting for the holder to be sleeping", HOLDER_ACTIVE_SQL, 1, HOLDER_WAIT_MS);
    const unsafe = lifecycle.launch("the unsafe candidate, started before expiry", () => db.q(unsafeCandidateSql(ownership, schema), [n, exp]));
    const blocked = await waitFor("waiting for the unsafe candidate to block behind the removal", MARKER_WAITERS_SQL, 1, BLOCK_WAIT_MS);
    const released = await lifecycle.collectHolderCommitted(holder);
    const answer = await lifecycle.collectRaw(unsafe);
    const rows = "rows" in answer ? (answer.rows as SmokeRow[]) : [];
    const admitted = rows.length === 1 && rows[0]!.live === true;
    const afterMs = await dbNowMs();
    const timed = parseTimedHolderResult(released);
    const evidence = raceTimingEvidence({ expiryIso: exp, expiryOffsetMs: RACE_EXPIRY_OFFSET_MS, intendedHolderSleepSeconds: RACE_HOLDER_SLEEP_SECONDS, holderKind: "commit", holderSleepingSeenBeforeReplay: holderUp, replayBlockedSeen: blocked, timed, dbClockAfterCollectMs: afterMs, expiredAtStatementPostCheck: null });
    lifecycle.observe("m8", { ...evidence, unsafeCandidateAdmitted: admitted });
    insist(holderUp >= 1 && blocked >= 1, "the unsafe candidate was not observed waiting behind the uncommitted removal");
    insist(timed !== null && timed.startedMs < Date.parse(exp) && timed.releasedMs > Date.parse(exp), "the holder's measured database-clock readings do not show it starting before the expiry and releasing after it");
    insist(admitted, "the original unsafe candidate was NOT re-admitted in this interleaving, so M6 does not demonstrate the race");
  });

  liveCase(EXPECTED_CASES[16], async () => {
    // Bounded purge. A: 100 markers expired more than an hour ago (position n is n seconds older than the previous, so a HIGHER position is OLDER).
    // B: 20 expired 30 minutes ago (inside the one-hour margin). C: 3 still live.
    const a = nonces.registerMany("m9-old", 100);
    const b = nonces.registerMany("m9-recent", 20);
    const c = nonces.registerMany("m9-live", 3);
    await insertAged("recording 100 markers expired more than an hour ago (test fixture)", a, 7_200);
    await insertAged("recording 20 markers expired inside the one-hour margin (test fixture)", b, 1_800);
    for (const n of b) knownPresent.add(n);
    const base = await dbNowMs();
    for (const [index, n] of c.entries()) await insertMarker(`recording live marker ${index + 1} (test fixture)`, n, isoAfter(base, 300_000), isoAfter(base, -1_000));
    expect(await present("counting the fixture before any purge", [...a, ...b, ...c])).toBe(123);

    // Statement 1 (accepted): purges the 64 OLDEST of A, nothing else.
    const t1 = nonces.register("m9-trigger-1");
    expect(await consume("a use that triggers the first purge", t1, isoAfter(await dbNowMs(), 120_000))).toBe("consumed");
    const afterFirst = await presentSet("listing A after the first purge", a);
    expect(afterFirst.size).toBe(36);
    expect(afterFirst).toEqual(new Set(a.slice(0, 36))); // the 36 YOUNGEST remain: the oldest 64 went first
    expect(await present("counting B and C after the first purge", [...b, ...c, t1])).toBe(24);

    // Statement 2 (REJECTED by the pre-filter): the purge still runs, because the data-modifying CTE always executes.
    const t2 = nonces.register("m9-trigger-2");
    expect(await consume("a use rejected by the pre-filter, which still purges", t2, isoAfter(await dbNowMs(), -60_000))).toBe("rejected");
    expect(await present("counting A after the second purge", a)).toBe(0);
    expect(await present("counting the rejected use's marker", [t2])).toBe(0);

    // Statement 3: nothing within the margin and nothing live is ever purged.
    const t3 = nonces.register("m9-trigger-3");
    expect(await consume("a use that triggers a third purge", t3, isoAfter(await dbNowMs(), 120_000))).toBe("consumed");
    expect(await present("counting B and C after the third purge", [...b, ...c, t1, t3])).toBe(25);
    expect(await presentSet("listing every marker M9 expects to remain", [...b, ...c, t1, t3])).toEqual(new Set([...b, ...c, t1, t3]));
    caseNotes.m9 = { oldBeforeFirst: 100, oldAfterFirst: 36, oldAfterSecond: 0, withinMarginKept: 20, liveKept: 3 };
  });

  liveCase(EXPECTED_CASES[17], async () => {
    // SKIP LOCKED: 70 markers expired more than an hour ago; a holder row-locks the 10 OLDEST. A purging statement must not wait for them.
    const p = nonces.registerMany("m10-aged", 70);
    await insertAged("recording 70 markers expired more than an hour ago (test fixture)", p, 7_200);
    const locked = p.slice(60);
    const holder = lifecycle.launch("holder: row-locks the 10 oldest markers, then commits", () => db.tx(holderRowLocks(locked, 14)));
    const holderUp = await waitFor("waiting for the row-lock holder to be sleeping", HOLDER_ACTIVE_SQL, 1, HOLDER_WAIT_MS);
    const t1 = nonces.register("m10-trigger-1");
    const started = Date.now();
    expect(await consume("a use whose purge meets locked rows", t1, isoAfter(await dbNowMs(), 120_000))).toBe("consumed");
    const stillHeld = one(await lifecycle.poll("checking that the holder is still holding", () => db.q(HOLDER_ACTIVE_SQL))).n as number;
    const waiting = one(await lifecycle.poll("checking that nothing is waiting on the locked rows", () => db.q(MARKER_WAITERS_SQL))).n as number;
    lifecycle.observe("m10-skip", { holderObserved: holderUp, holderStillHoldingAfterPurge: stillHeld, waitersAfterPurge: waiting, purgeMs: Date.now() - started });
    insist(holderUp >= 1 && stillHeld >= 1, "the row-lock holder was not holding while the purge ran; SKIP LOCKED was not exercised");
    expect(waiting).toBe(0);
    // The 60 unlocked rows are gone; the 10 locked ones were skipped, not waited for.
    expect(await presentSet("listing the aged markers after the purge", p)).toEqual(new Set(locked));
    await lifecycle.collectHolderCommitted(holder);
    const t2 = nonces.register("m10-trigger-2");
    expect(await consume("a use after the locks were released", t2, isoAfter(await dbNowMs(), 120_000))).toBe("consumed");
    expect(await present("counting the aged markers after the locks were released", p)).toBe(0);

    // M10's own protected markers: 5 expired inside the one-hour margin and 3 still live. Together with everything M9 and the earlier cases left (the ledger),
    // they must all survive every purge below, by exact identity.
    const keptRecent = nonces.registerMany("m10-recent", 5);
    const keptLive = nonces.registerMany("m10-live", 3);
    await insertAged("recording 5 markers expired inside the one-hour margin (test fixture)", keptRecent, 1_800);
    for (const n of keptRecent) knownPresent.add(n);
    const liveBase = await dbNowMs();
    for (const [index, n] of keptLive.entries()) await insertMarker(`recording live marker ${index + 1} (test fixture)`, n, isoAfter(liveBase, 300_000), isoAfter(liveBase, -1_000));

    // Eight purging statements released together over 130 expired markers: no deadlock, every protected marker intact.
    const q = nonces.registerMany("m10-bulk", 130);
    await insertAged("recording 130 markers expired more than an hour ago (test fixture)", q, 7_200);
    const burst = nonces.registerMany("m10-burst", 8);
    const exp = isoAfter(await dbNowMs(), 150_000);
    const gate = lifecycle.launch("holder: locks the marker table against inserts, then commits", () => db.tx(holderTableGate(14)));
    const gateUp = await waitFor("waiting for the table-lock holder to be sleeping", HOLDER_ACTIVE_SQL, 1, HOLDER_WAIT_MS);
    const purges = burst.map((n, index) => launchConsume(`purging request ${index + 1} of 8`, n, exp));
    const blocked = await waitFor("waiting for 8 purging requests to be blocked on the table lock", MARKER_WAITERS_SQL, 8, BLOCK_WAIT_MS);
    await lifecycle.collectHolderCommitted(gate);
    const outcomes: MarkerOutcome[] = [];
    for (const purge of purges) outcomes.push(await lifecycle.collectMarker(purge));
    lifecycle.observe("m10-burst", { gateObserved: gateUp, blockedObserved: blocked });
    insist(gateUp >= 1 && blocked >= 8, `only ${blocked} of 8 purging requests were observed waiting together; the overlap is not proven`);
    expect(tallyOutcomes(outcomes)).toEqual({ consumed: 8 });
    for (const n of burst) knownPresent.add(n);
    expect(await present("counting the burst's own markers", burst)).toBe(8);
    // The burst's eight statements together removed at least the first one's 64 and at most all 130 (no statement may exceed 64, and only expired-over-an-hour markers qualify).
    let remaining = await present("counting the remaining aged markers after the burst", q);
    expect(remaining).toBeLessThanOrEqual(130 - 64);
    // Drained one statement at a time, each removes EXACTLY min(64, remaining): oldest first is proven for P and A; here the per-statement bound is.
    const drained: number[] = [];
    for (let round = 1; remaining > 0 && round <= 3; round += 1) {
      const t = nonces.register(`m10-drain-${round}`);
      expect(await consume(`a use that drains aged markers, round ${round}`, t, isoAfter(await dbNowMs(), 120_000))).toBe("consumed");
      const next = await present(`counting the remaining aged markers after drain round ${round}`, q);
      expect(remaining - next, `drain round ${round}`).toBe(Math.min(64, remaining));
      drained.push(remaining - next);
      remaining = next;
    }
    expect(remaining).toBe(0);
    // Nothing the run knows to be present has disappeared, and nothing it knows to be protected was purged: exact identity, not a count.
    const survivors = await presentSet("listing every marker the run knows to be present", [...knownPresent]);
    expect(survivors).toEqual(new Set(knownPresent));
    expect(await present("counting M10's protected markers", [...keptRecent, ...keptLive])).toBe(8);
    lifecycle.observe("m10-preservation", { knownPresentChecked: knownPresent.size, drainRounds: drained });
    caseNotes.m10 = { lockedRowsSkipped: locked.length };
  });

  liveCase(EXPECTED_CASES[18], async () => {
    // The production statement text, with only the table qualified, against a table that has the columns but NO unique key: ON CONFLICT (nonce) has nothing to
    // arbitrate on, and PostgreSQL itself must refuse (42P10). No marker is written and nothing is admitted.
    const schema = await buildVariant(NO_KEY_VARIANT);
    const captured = await captureProductionMarkerSql();
    const n = nonces.register("m11-no-key");
    const exp = isoAfter(await dbNowMs(), 120_000);
    const refusal = await lifecycle.expectMarkerDatabaseError("the production statement against a table without its unique key", () => db.q(markerSqlForSchema(captured.numbered, ownership, schema), [n, exp, exp, exp]), ["42P10"]);
    expect(await scratchNonces(schema)).toEqual([]);
    caseNotes.m11 = refusal;
  });

  // The last two tests: nothing executes unless every case above ran, in order.
  it("every decisive case ran, exactly once, in order", () => {
    expect(lifecycle.executed()).toEqual([...EXPECTED_CASES]);
  }, VITEST_TIMEOUT_MS);

  it("Z. the final cleanup removes exactly what this run registered", async () => {
    await lifecycle.runFinalCleanup(db);
  }, VITEST_TIMEOUT_MS);
});
