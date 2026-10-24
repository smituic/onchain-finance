// @vitest-environment node
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, onTestFinished } from "vitest";
import { createNeonChallengeStore } from "@/lib/real/server/neon-store";
import { EXPECTED_ENDPOINT_ENV, confirmedDisposableTargetUrl, parseDatabaseUrl, readActiveEnvFiles, type ActiveEnvFiles } from "./fixtures/handles-smoke-db";
import { findPackedRef, parseGitHead, type GitHead } from "./fixtures/login-challenge-uses-smoke";
import {
  CASE_DEADLINE_MS,
  CLEANUP_DEADLINE_MS,
  SCHEMA_EXTERNAL_DEPENDENCIES_SQL,
  SCHEMA_INVENTORY_SQL,
  SCHEMA_RESIDUE_SQL,
  VITEST_TIMEOUT_MS,
  caseFailedInVitest,
  checkRunnerTimeoutFlags,
  createRunOwnership,
  requirePooledMode,
  runCleanupPlan,
  sha256Hex,
  summarizeCleanup,
  type CleanupAccount,
  type RunOwnership,
} from "./fixtures/provider-budget-smoke";
import { planAdmissionCleanup } from "./fixtures/registration-admission-smoke";
import { checkExactFileSelection, safeEvidenceJson } from "./fixtures/provisioning-limits-smoke";

/**
 * CONTROLLED, LIVE-DATABASE PROOF HARNESS for the bounded WebAuthn challenge purge (Milestone 3E,
 * createNeonChallengeStore.create) against a DISPOSABLE Neon branch.
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ IT HAS NEVER BEEN RUN LIVE. Nothing here is evidence of PostgreSQL or Neon behavior. Every claim      │
 * │ about SKIP LOCKED, LockRows, row-lock waits, planner choices, the 64-row bound, READ COMMITTED         │
 * │ re-checks, and microsecond comparisons is an expectation that a future run exists to test. Building   │
 * │ this file authorizes NOTHING: a live run needs the operator's separate authorization of the exact new │
 * │ branch, its endpoint, verified parentage, the cleanup policy, the SQL, the write and concurrency      │
 * │ ceilings below, and the stop rules.                                                                    │
 * └──────────────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * INERT BY DEFAULT. The live suite is `describe.skipIf(!enabled)`; without REAL_SMOKE_CHALLENGE_PURGE=1
 * no hook runs, no connection is opened and no SQL is built. The offline `describe` blocks below always
 * run and touch no network: they prove the gates, the statement guard, the budgets and — against an
 * in-process EMULATOR — that the case logic detects a wrong purge. THE EMULATOR PROVES NOTHING ABOUT
 * POSTGRESQL; it only proves this harness would notice if the database behaved otherwise.
 *
 * TWO EXECUTION PATHS — every case declares which one it used, and the evidence records it:
 *   real_adapter_public     the UNCHANGED createNeonChallengeStore adapter, over the production Neon client,
 *                           against public.webauthn_challenges of the disposable branch (P1, P8). Every SQL
 *                           text the adapter sends is checked equal to the pinned production statement
 *                           before it is forwarded; the adapter's own code is not re-implemented.
 *   qualified_sql_scratch   the production statement's text, mechanically schema-qualified (only the table
 *                           name changes; the transformation is inverted and checked offline) and run against
 *                           a run-owned scratch schema with a table built from schema.sql's own DDL (P2-P7).
 *                           THIS DOES NOT PROVE THE ADAPTER: it proves the SQL shape on a copy of the table.
 *   read_only_plan          EXPLAIN (FORMAT JSON) without ANALYZE of that qualified text (P9, PERF).
 *
 * OPERATOR GATES (all checked, in order, before any connection is opened; none has a default):
 *   REAL_SMOKE_CHALLENGE_PURGE=1                  the dedicated gate; any other REAL_SMOKE_* gate, DATABASE_URL
 *                                                 or a REAL_ADMIN_* variable refuses the run
 *   CHALLENGE_PURGE_SMOKE_RUN_ID                  8 lowercase hex, unspent, with no evidence file
 *   CHALLENGE_PURGE_SMOKE_BRANCH_ID               br-..., the disposable branch id (operator-supplied)
 *   CHALLENGE_PURGE_SMOKE_PARENT_BRANCH_ID        br-..., differs from the branch id (operator-verified parentage)
 *   NEON_BRANCH_EXPECTED_ENDPOINT_ID              ep-..., must equal the URL's endpoint and differ from the real one
 *   CHALLENGE_PURGE_SMOKE_EXPECTED_HOST           the exact pooled hostname, must equal the URL's hostname
 *   NEON_BRANCH_DATABASE_URL                      the separately supplied pooled connection string
 *   CHALLENGE_PURGE_SMOKE_CONFIRM                 "<run id>:<16 hex>" over the source digest, endpoint, branch, parent,
 *                                                 host, run id and mode, so it authorizes only this code, target and mode
 *   CHALLENGE_PURGE_SMOKE_PERF=1                  (optional) additionally enables the PERF case; the mode is part of the
 *                                                 confirmation, so a base confirmation cannot enable it
 *   CHALLENGE_PURGE_SMOKE_PRINT_CONFIRMATION=1    prints the confirmation string for the values above; connects to nothing
 * Vitest must be started as exactly `vitest run <this file>` with no timeout flag below 120000 ms.
 * WHAT THESE PROVE: the URL, the operator's statements and the confirmation agree with each other and with the
 * audited code. THEY DO NOT PROVE THAT THE BRANCH IS NEW, DISPOSABLE OR A CHILD OF THE NAMED PARENT — SQL cannot
 * see that. That rests on the operator's own Neon-console evidence; the branch and parent ids here are recorded,
 * bound into the confirmation, and never verified by this file.
 *
 * PUBLIC TABLE SAFETY. The adapter's bounded cleanup can delete expired rows that were already there. So a
 * read-only preflight requires public.webauthn_challenges to be COMPLETELY EMPTY before ANY write; otherwise the
 * run is refused (state REFUSED, nothing written, nothing deleted, no cleanup, no switch to another database).
 * The run then creates at most 10 public rows, every value minted and registered by this run
 * (cps-<run id>-...), and its cleanup deletes exactly those values and nothing else.
 *
 * SCRATCH SCHEMA SAFETY. One run-owned schema (pb_smoke_<run id>_main) is created only after the run is armed, never
 * an existing one (plain CREATE SCHEMA). Every scratch reference is explicitly schema-qualified; no search_path is
 * changed. At most 6,000 scratch rows in total. Cleanup drops the one registered table and then the schema with RESTRICT
 * (never CASCADE), only after a read-only check that the schema holds exactly what was registered.
 *
 * STATEMENT GUARD. The session can send only statements built by the factory below, each a fixed template whose
 * parameters are validated for its kind (owned schema, registered public value, ISO timestamp, row counts). Anything
 * else — including the adapter's statements, which pass through a wrapper — is refused before it is sent. The guard
 * counts operations, scratch rows, public rows and in-flight statements against the CEILINGS and fails closed.
 *
 * FAILURE MODEL. Every statement has a client-side deadline; nothing is retried; nothing is cancelled (an abort could
 * turn an uncertain write into an apparent clean failure). A failed case, an unexpected answer, a deadline or a lost
 * answer POISONS the run for good: no later case, no further statement, NO CLEANUP. A write whose answer was lost is
 * recorded as uncertain. The lock holder in P7 is a scripted HTTP batch with a server-side statement_timeout and a
 * finite sleep, so it releases by itself even if this client disappears. No Neon branch is ever deleted by this file.
 *
 * EVIDENCE INTEGRITY. The verdict is decided only AFTER the final evidence save, and database cleanliness is kept apart from evidence
 * completeness: completed_clean requires a confirmed cleanup AND both evidence saves; a confirmed cleanup with an unsaved file is
 * clean_but_not_evidenced (the run FAILS); a poisoned run says poisoned_evidence_preserved only if its final file was really saved, else
 * poisoned_evidence_not_saved. A failed save causes NO further database work and is never retried. The saved file records the database
 * outcome only (a fact it can state); the evidence verdict cannot be inside the evidence.
 *
 * P6 LIMITATION. P6's checks (all eight inserts present, live rows untouched, aggregate deletion within 64..512 of a 600-row backlog) are
 * necessary concurrency checks. An aggregate bound does NOT independently prove that each statement deleted at most 64 rows; that rests on
 * the SQL's own LIMIT inside the locked selection and on the separate inspection of the production statement.
 *
 * REUSE. A run id may not appear in ANY evidence file name here, and a branch id may not appear in earlier challenge-purge evidence;
 * evidence that cannot be read safely refuses. The ABSENCE of local evidence proves nothing about a branch: its freshness, parentage,
 * endpoint mapping and disposability are the operator's own Neon-console preconditions. The harness never deletes or repairs evidence.
 * Earlier evidence is read through readEvidenceFile: metadata first (a symbolic link, a non-regular file or more than 1,000,000 BYTES is refused
 * before any open), then an O_NOFOLLOW | O_NONBLOCK open with an inode re-check, a bounded read and strict UTF-8; the evidence directory must be a
 * plain directory. Nothing unreadable or malformed is skipped, and no refusal repeats file content.
 *
 * STATE MACHINE. The preflight may start only from NOT_STARTED. Every awaited preflight read re-checks that the run is still in PREFLIGHT, so a LATE
 * answer after the run was poisoned, refused or sealed is discarded: it cannot arm or refuse the run, save a start record, send SQL or alter a
 * sealed report. A late case result is discarded the same way. A poisoned run whose final file exists WITHOUT its start file is labelled
 * poisoned_final_evidence_only; poisoned_evidence_preserved means both files exist.
 *
 * S4 COMPATIBILITY. test/lib/real/neon-smoke.test.ts "S4: challenge create purges already-expired rows" assumes one
 * create purges ITS expired fixture row. Under the 64-row cap that fails on a database that already holds more than 64
 * older expired rows (a false failure). That file is not modified and must not be run as part of this proof; its
 * compatibility needs a separate decision. THIS proof verifies bounded cleanup without depending on that assumption.
 *
 * NOT PROVEN EVEN BY A CLEAN RUN: production-scale behavior, other Postgres versions, other pooler configurations,
 * the planner's choices on a table of production size, WAL or I/O cost, request-rate limiting, or anything about
 * authenticated challenge creation volume. It is not registered in smoke-gate-process.test.ts (a different file).
 */

// ------------------------------------------------------------------------------------------------ constants

const GATE = "REAL_SMOKE_CHALLENGE_PURGE";
const ALLOWED_GATES = [GATE] as const;
const SMOKE_FILE = "test/lib/real/challenge-store-bounded-purge-neon-proof.test.ts";
const ENV = {
  runId: "CHALLENGE_PURGE_SMOKE_RUN_ID",
  confirm: "CHALLENGE_PURGE_SMOKE_CONFIRM",
  branch: "CHALLENGE_PURGE_SMOKE_BRANCH_ID",
  parent: "CHALLENGE_PURGE_SMOKE_PARENT_BRANCH_ID",
  host: "CHALLENGE_PURGE_SMOKE_EXPECTED_HOST",
  perf: "CHALLENGE_PURGE_SMOKE_PERF",
  print: "CHALLENGE_PURGE_SMOKE_PRINT_CONFIRMATION",
} as const;
const enabled = process.env[GATE] === "1";
const EVIDENCE_DIRECTORY = "evidence";
const SCHEMA_PATH = "lib/real/server/schema.sql";
const STORE_PATH = "lib/real/server/neon-store.ts";
const CHALLENGE_STORE_PATH = "lib/real/server/challenge-store.ts";
const HELPER_FILES = {
  handlesSmokeDb: "test/lib/real/fixtures/handles-smoke-db.ts",
  providerBudgetSmoke: "test/lib/real/fixtures/provider-budget-smoke.ts",
  provisioningLimitsSmoke: "test/lib/real/fixtures/provisioning-limits-smoke.ts",
  registrationAdmissionSmoke: "test/lib/real/fixtures/registration-admission-smoke.ts",
  loginChallengeUsesSmoke: "test/lib/real/fixtures/login-challenge-uses-smoke.ts",
  // L-2: what else controls a live invocation. smoke-run-ids.ts is imported by the ownership registry (isRunSmokeId); vitest.config.mts sets
  // the environment, the "@" alias and the provided vitestCliArgs the exact-file gate reads. (test/setup.ts only installs a localStorage shim.)
  smokeRunIds: "test/lib/real/fixtures/smoke-run-ids.ts",
  vitestConfig: "vitest.config.mts",
} as const;
/** The installed Neon driver's package.json: its version decides how the HTTP query function behaves. Only the version string is hashed. */
const NEON_DRIVER_PACKAGE = "node_modules/@neondatabase/serverless/package.json";

/** Files whose full-content hashes the evidence records (beyond the confirmed identity). */
const EVIDENCE_FILES = [STORE_PATH, CHALLENGE_STORE_PATH, "test/lib/real/challenge-store.test.ts", "test/lib/real/challenge-store-bounded-purge.test.ts", "test/lib/real/login-challenge-uses-smoke-harness.test.ts", SMOKE_FILE] as const;

/** Run ids already spent by earlier smokes. A run id is never reused. */
const KNOWN_SPENT_RUN_IDS = ["ced714ee", "c20ffc87", "6d32fdf8", "a630d8ff", "14751f64", "53b7f63e"] as const;
/** Tables an earlier smoke leaves on a branch. Their presence marks a used branch; the run refuses. */
const USED_BRANCH_TABLES = ["real_registration_admission", "real_login_challenge_uses", "real_provider_budgets"] as const;

/** Hard limits. Each is enforced in code by the guard or the factory (and proven offline), never by comment alone. */
const CEILINGS = {
  operations: 400,
  perfExtraOperations: 60,
  publicRows: 10,
  scratchRows: 6_000,
  perfSeedRows: 4_300,
  perfCreates: 5,
  concurrency: 16,
  correctnessConcurrency: 8,
  scratchSchemas: 1,
  cleanupStatements: 24,
  runDeadlineMs: 15 * 60_000,
} as const;
const PURGE_BOUND = 64;
const PURPOSES = ["registration", "login", "backup_registration", "backup_login_verification", "backup_step_up", "handle_claim"] as const;
const HOUR = 3_600_000;
const MINUTE = 60_000;

type Timing = {
  statementDeadlineMs: number;
  caseDeadlineMs: number;
  cleanupDeadlineMs: number;
  runDeadlineMs: number;
  pollMs: number;
  holderSleepSeconds: number;
  holderWaitMs: number;
  maxCreateElapsedMs: number;
};
const LIVE_TIMING: Timing = {
  statementDeadlineMs: 30_000,
  caseDeadlineMs: CASE_DEADLINE_MS,
  cleanupDeadlineMs: CLEANUP_DEADLINE_MS,
  runDeadlineMs: CEILINGS.runDeadlineMs,
  pollMs: 500,
  holderSleepSeconds: 15,
  holderWaitMs: 8_000,
  maxCreateElapsedMs: 5_000,
};

type PathKind = "real_adapter_public" | "qualified_sql_scratch" | "read_only_plan";
type CaseDef = { id: string; title: string; path: PathKind; optional?: "perf"; operations: number; scratchRows: number; publicRows: number; concurrent: number };

/** Every case with its worst-case budget. The inventory is summed and checked against CEILINGS BEFORE any connection. */
const POLL_COUNT = LIVE_TIMING.holderWaitMs / LIVE_TIMING.pollMs + 4;
const CASES: readonly CaseDef[] = [
  { id: "P1", title: "P1. real adapter on the empty public table: parameter binding, context round trip, and a bounded purge of one expired row", path: "real_adapter_public", operations: 16, scratchRows: 0, publicRows: 4, concurrent: 1 },
  { id: "P2", title: "P2. 100 expired scratch rows: one create deletes exactly the oldest 64, leaves 36, and the new challenge is present", path: "qualified_sql_scratch", operations: 8, scratchRows: 101, publicRows: 0, concurrent: 1 },
  { id: "P3", title: "P3. unexpired rows of all six purposes survive; expired rows of every purpose are purged oldest-first", path: "qualified_sql_scratch", operations: 8, scratchRows: 77, publicRows: 0, concurrent: 1 },
  { id: "P4", title: "P4. no create deletes more than 64: exactly 64, exactly 65, and a 160-row backlog drained 64 at a time", path: "qualified_sql_scratch", operations: 28, scratchRows: 294, publicRows: 0, concurrent: 1 },
  { id: "P5", title: "P5. the cutoff is a strict less-than at microsecond precision against a millisecond bound parameter", path: "qualified_sql_scratch", operations: 14, scratchRows: 6, publicRows: 0, concurrent: 1 },
  { id: "P6", title: "P6. eight concurrent creates over a 600-row expired backlog: all inserted, live rows untouched, aggregate deletion within 64..512, no deadlock", path: "qualified_sql_scratch", operations: 14, scratchRows: 614, publicRows: 0, concurrent: 8 },
  { id: "P7", title: "P7. a lock holder keeps the oldest 64 rows locked: a concurrent purge skips them without waiting", path: "qualified_sql_scratch", operations: 14 + POLL_COUNT + 1, scratchRows: 141, publicRows: 0, concurrent: 2 },
  { id: "P8", title: "P8. real adapter: an expired challenge never authenticates (consume racing purge); a live one is consumed exactly once", path: "real_adapter_public", operations: 44, scratchRows: 0, publicRows: 5, concurrent: 4 },
  { id: "P9", title: "P9. read-only EXPLAIN of the production statement shape: Limit, LockRows, expiry-ordered selection, outer Delete", path: "read_only_plan", operations: 10, scratchRows: 120, publicRows: 0, concurrent: 1 },
  { id: "PERF", title: "PERF (optional). large-backlog measurement on scratch rows: EXPLAIN without ANALYZE and five bounded creates timed", path: "qualified_sql_scratch", optional: "perf", operations: 24, scratchRows: CEILINGS.perfSeedRows + CEILINGS.perfCreates, publicRows: 0, concurrent: 1 },
];
const SETUP_OPERATIONS = 10;
const PREFLIGHT_OPERATIONS = 14;

type BudgetTotals = { operations: number; scratchRows: number; publicRows: number; concurrent: number; perfScratchRows: number; schemas: number };
function planBudget(perf: boolean, cases: readonly CaseDef[] = CASES): { ok: boolean; totals: BudgetTotals; violations: string[] } {
  const chosen = cases.filter((entry) => perf || entry.optional !== "perf");
  const totals: BudgetTotals = {
    operations: PREFLIGHT_OPERATIONS + SETUP_OPERATIONS + CEILINGS.cleanupStatements + chosen.reduce((sum, entry) => sum + entry.operations, 0),
    scratchRows: chosen.reduce((sum, entry) => sum + entry.scratchRows, 0),
    publicRows: chosen.reduce((sum, entry) => sum + entry.publicRows, 0),
    concurrent: Math.max(1, ...chosen.map((entry) => entry.concurrent)),
    perfScratchRows: chosen.filter((entry) => entry.optional === "perf").reduce((sum, entry) => sum + entry.scratchRows, 0),
    schemas: 1,
  };
  const violations: string[] = [];
  const operationCeiling = CEILINGS.operations + (perf ? CEILINGS.perfExtraOperations : 0);
  if (totals.operations > operationCeiling) violations.push(`planned operations ${totals.operations} exceed ${operationCeiling}`);
  if (totals.scratchRows > CEILINGS.scratchRows) violations.push(`planned scratch rows ${totals.scratchRows} exceed ${CEILINGS.scratchRows}`);
  if (totals.publicRows > CEILINGS.publicRows) violations.push(`planned public rows ${totals.publicRows} exceed ${CEILINGS.publicRows}`);
  if (totals.concurrent > CEILINGS.correctnessConcurrency) violations.push(`planned concurrency ${totals.concurrent} exceeds ${CEILINGS.correctnessConcurrency}`);
  if (totals.perfScratchRows > 5_000) violations.push(`planned PERF scratch rows ${totals.perfScratchRows} exceed 5000`);
  return { ok: violations.length === 0, totals, violations };
}

// ------------------------------------------------------------------------------------------------ small helpers

type Row = Record<string, unknown>;
const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const pad4 = (n: number): string => String(n).padStart(4, "0");
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const fingerprint = (value: string): string => sha256Hex(value).slice(0, 16);

/** A harness failure: authored messages only, never a driver's text (which could name the target). */
class HarnessFailure extends Error {}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new HarnessFailure(message);
}
const one = (rows: Row[], what: string): Row => {
  check(rows.length === 1, `${what}: expected exactly one row, got ${rows.length}`);
  return rows[0]!;
};
const sqlStateOf = (error: unknown): string | null => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
};

// ------------------------------------------------------------------------------------------------ the production statement

/** The pinned reference for what createNeonChallengeStore sends. If production drifts, this harness refuses to run until re-audited. */
const PRODUCTION_CREATE_REFERENCE = normalize(
  `WITH purged AS ( DELETE FROM webauthn_challenges d WHERE d.challenge IN ( SELECT p.challenge FROM webauthn_challenges p WHERE p.expires_at < $? ORDER BY p.expires_at LIMIT 64 FOR UPDATE SKIP LOCKED ) ) INSERT INTO webauthn_challenges (challenge, purpose, context, expires_at) VALUES ($?, $?, $?, $?)`,
);
const PRODUCTION_CONSUME_REFERENCE = normalize(`DELETE FROM webauthn_challenges WHERE challenge = $? RETURNING purpose, context, created_at, expires_at`);

type CapturedSql = { create: string; consume: string; createValues: number; consumeValues: number };

/** Runs the real adapter against a recorder (offline) and returns the exact statements it sends. */
async function captureProductionSql(): Promise<CapturedSql> {
  const seen: Array<{ text: string; values: number }> = [];
  const recorder = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    seen.push({ text: normalize(strings.join("$?")), values: values.length });
    return Promise.resolve([]);
  }) as unknown as NeonQueryFunction<false, false>;
  const store = createNeonChallengeStore(recorder);
  await store.create({ challenge: "capture", purpose: "login", ttlMs: 1_000 });
  await store.consume({ challenge: "capture", purpose: "login" });
  check(seen.length === 2, "the adapter did not send exactly one create and one consume statement");
  return { create: seen[0]!.text, consume: seen[1]!.text, createValues: seen[0]!.values, consumeValues: seen[1]!.values };
}
function checkProductionSql(captured: CapturedSql): { ok: true } | { ok: false; reason: string } {
  if (captured.create !== PRODUCTION_CREATE_REFERENCE) return { ok: false, reason: "the production create statement differs from the audited reference" };
  if (captured.consume !== PRODUCTION_CONSUME_REFERENCE) return { ok: false, reason: "the production consume statement differs from the audited reference" };
  if (captured.createValues !== 5 || captured.consumeValues !== 1) return { ok: false, reason: "the production statements bind an unexpected number of values" };
  return { ok: true };
}

/** Numbered placeholders and explicit schema qualification: the ONLY transformation applied to the production create text. */
function scratchPurgeText(productionCreate: string, schema: string): string {
  let n = 0;
  const numbered = productionCreate.replace(/\$\?/g, () => `$${++n}`);
  return normalize(numbered.replace(/\bwebauthn_challenges\b/g, `${schema}.webauthn_challenges`));
}
/** Inverse of the above, for the offline proof that nothing else changed. */
function unqualify(scratch: string, schema: string): string {
  return scratch.split(`${schema}.webauthn_challenges`).join("webauthn_challenges").replace(/\$[0-9]+/g, "$?");
}

type ScratchDdl = { table: string; index: string };
/** The scratch table's DDL, taken from schema.sql's own CREATE TABLE and CREATE INDEX (plain CREATE: it must not already exist). */
function scratchDdl(schemaText: string, schema: string): ScratchDdl {
  const table = /CREATE TABLE IF NOT EXISTS webauthn_challenges \([\s\S]*?\n\);/.exec(schemaText)?.[0];
  const index = /CREATE INDEX IF NOT EXISTS webauthn_challenges_expires_at_idx ON webauthn_challenges \(expires_at\);/.exec(schemaText)?.[0];
  if (!table || !index) throw new Error("challenge purge proof: schema.sql no longer has the expected webauthn_challenges definition; refusing to build a scratch copy");
  return {
    table: normalize(table.replace("CREATE TABLE IF NOT EXISTS webauthn_challenges (", `CREATE TABLE ${schema}.webauthn_challenges (`).replace(/;$/, "")),
    index: `CREATE INDEX webauthn_challenges_expires_at_idx ON ${schema}.webauthn_challenges (expires_at)`,
  };
}

// ------------------------------------------------------------------------------------------------ statements

const BRAND = Symbol("challenge-purge-proof-statement");
type StmtKind =
  | "cat_identity" | "cat_public_count" | "cat_shape" | "cat_indexes" | "cat_checks" | "cat_schemas" | "cat_used_tables" | "cat_activity_self" | "cat_holder_active"
  | "rd_list" | "rd_count" | "rd_public_row" | "rd_public_present" | "explain"
  | "create_schema" | "create_table" | "create_index" | "seed_rows" | "seed_one" | "reset" | "analyze" | "purge_create"
  | "public_seed" | "public_delete" | "ownership";
type Stmt = Readonly<{ [BRAND]: true; kind: StmtKind; text: string; params: readonly unknown[]; mode: "read" | "write"; scratchRows: number }>;
type BatchStmt = Readonly<{ [BRAND]: true; kind: "holder"; statements: ReadonlyArray<{ text: string; params: unknown[] }>; sleepSeconds: number }>;

const TEXT = {
  identity: normalize(`SELECT pg_catalog.current_database()::text AS database, pg_catalog.current_setting('server_version') AS version, pg_catalog.current_setting('server_version_num')::int AS version_num, pg_catalog.current_setting('transaction_isolation') AS isolation, pg_catalog.current_setting('default_transaction_isolation') AS default_isolation, pg_catalog.pg_is_in_recovery() AS in_recovery, (pg_catalog.to_regclass('public.webauthn_challenges') IS NOT NULL AND pg_catalog.to_regclass('webauthn_challenges') = pg_catalog.to_regclass('public.webauthn_challenges')) AS resolves_to_public`),
  publicCount: "SELECT count(*)::int AS n FROM public.webauthn_challenges",
  shape: normalize(`SELECT a.attname::text AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_expr FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE a.attrelid = pg_catalog.to_regclass($1::text) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`),
  indexes: normalize(`SELECT c.relname::text AS name, pg_catalog.pg_get_indexdef(i.indexrelid) AS definition FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = pg_catalog.to_regclass($1::text) ORDER BY c.relname`),
  checks: normalize(`SELECT pg_catalog.pg_get_constraintdef(k.oid) AS definition FROM pg_catalog.pg_constraint k WHERE k.conrelid = pg_catalog.to_regclass($1::text) AND k.contype = 'c' ORDER BY k.conname`),
  schemas: "SELECT nspname::text AS name FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' ORDER BY nspname",
  usedTables: normalize(`SELECT c.relname::text AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname = ANY($1::text[]) ORDER BY c.relname`),
  activitySelf: "SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE pid = pg_catalog.pg_backend_pid()",
  holderActive: normalize(`SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE datname = pg_catalog.current_database() AND pid <> pg_catalog.pg_backend_pid() AND state = 'active' AND query LIKE '%' || $1::text || '%' AND query NOT LIKE '%pg_stat_activity%'`),
  publicSeed: "INSERT INTO public.webauthn_challenges (challenge, purpose, expires_at) VALUES ($1::text, $2::text, $3::timestamptz)",
  publicRow: normalize(`SELECT challenge, purpose, context::text AS context, (extract(epoch FROM expires_at) * 1000)::bigint AS expires_ms FROM public.webauthn_challenges WHERE challenge = $1::text`),
  publicPresent: "SELECT challenge FROM public.webauthn_challenges WHERE challenge = ANY($1::text[]) ORDER BY challenge",
  publicDelete: "DELETE FROM public.webauthn_challenges WHERE challenge = ANY($1::text[]) RETURNING challenge",
} as const;
const TAG = (runId: string): string => `cps_holder_${runId}`;
const ISO_MS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const ISO_US = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/;
const CHALLENGE_VALUE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEED_PREFIX = /^p[a-z0-9]{1,3}-$/;

/** Per-schema templates. Shared by the factory and the offline emulator so both speak about the same text. */
function scratchTexts(schema: string, runId: string, productionCreate: string, ddl: ScratchDdl) {
  const T = `${schema}.webauthn_challenges`;
  const purge = scratchPurgeText(productionCreate, schema);
  return {
    table: T,
    createSchema: `CREATE SCHEMA ${schema}`,
    createTable: ddl.table,
    createIndex: ddl.index,
    list: `SELECT challenge, purpose FROM ${T} ORDER BY expires_at, challenge`,
    count: `SELECT count(*)::int AS n FROM ${T}`,
    seedRows: normalize(`INSERT INTO ${T} (challenge, purpose, expires_at) SELECT $1::text || pg_catalog.lpad(n::text, 4, '0'), (ARRAY['registration', 'login', 'backup_registration', 'backup_login_verification', 'backup_step_up', 'handle_claim'])[1 + (n % 6)], $2::timestamptz + n * interval '1 second' FROM pg_catalog.generate_series(1, $3::int) AS n`),
    seedOne: `INSERT INTO ${T} (challenge, purpose, expires_at) VALUES ($1::text, $2::text, $3::timestamptz)`,
    reset: `DELETE FROM ${T}`,
    analyze: `ANALYZE ${T}`,
    purge,
    explain: `EXPLAIN (FORMAT JSON) ${purge}`,
    holderSettings: "SET LOCAL statement_timeout = '25s'",
    holderLock: `SELECT challenge FROM ${T} WHERE challenge = ANY($1::text[]) ORDER BY challenge FOR UPDATE`,
    holderSleep: `SELECT pg_catalog.pg_sleep($1::int) /* ${TAG(runId)} */`,
  };
}

/** Global defense in depth, applied to every statement at send time in addition to the per-kind template. */
const FORBIDDEN = /;|\bCASCADE\b|\bTRUNCATE\b|\bALTER\b|\bGRANT\b|\bREVOKE\b|\bCOPY\b|\bVACUUM\b|\bREINDEX\b|\bCLUSTER\b|\bsearch_path\b|\bpg_(terminate|cancel)_backend\b|\bDROP\s+(DATABASE|ROLE|USER|OWNED|EXTENSION|FUNCTION|VIEW|INDEX)\b|\bCREATE\s+(DATABASE|ROLE|USER|EXTENSION|FUNCTION|TRIGGER|VIEW)\b|\bEXPLAIN\s*\([^)]*\bANALYZE\b|\bSET\b(?!\s+LOCAL\b)/i;
function assertStatementText(stmt: { kind: string; text: string }): void {
  if (FORBIDDEN.test(stmt.text)) throw new HarnessFailure(`statement of kind ${stmt.kind} contains a forbidden construct; refusing to send it`);
  if (/\bDROP\b/i.test(stmt.text) && stmt.kind !== "ownership") throw new HarnessFailure("only the ownership cleanup may DROP");
  if (/\bFOR\s+UPDATE\b/i.test(stmt.text) && !["holder", "purge_create", "explain"].includes(stmt.kind)) throw new HarnessFailure("row locks are taken only by the purge and the holder");
  if (/\bpg_sleep\b/i.test(stmt.text) && stmt.kind !== "holder") throw new HarnessFailure("only the holder sleeps");
  if (/\bSET\s+LOCAL\b/i.test(stmt.text) && stmt.kind !== "holder") throw new HarnessFailure("only the holder sets transaction options");
  if (/\bEXPLAIN\b/i.test(stmt.text) && stmt.kind !== "explain") throw new HarnessFailure("EXPLAIN is only the read-only plan statement");
}

type PublicRows = ReturnType<typeof createPublicRows>;
function createPublicRows(runId: string, max: number) {
  const values: string[] = [];
  const shape = new RegExp(`^cps-${runId}-[a-z0-9]+(-[a-z0-9]+)*$`);
  return {
    /** Mints one run-owned public challenge value BEFORE any row for it can be written. Refuses the 11th. */
    register(name: string): string {
      const value = `cps-${runId}-${name}`;
      if (!shape.test(value) || value.length > 80) throw new HarnessFailure("a public challenge value is not of this run's shape");
      if (values.includes(value)) throw new HarnessFailure("a public challenge value was registered twice");
      if (values.length >= max) throw new HarnessFailure("this run reached its public-row limit; refusing to register more");
      values.push(value);
      return value;
    },
    owns: (value: unknown): boolean => typeof value === "string" && values.includes(value),
    list: (): string[] => [...values],
  };
}

/**
 * The only way to build a statement. Each builder validates its parameters for its kind and returns a frozen,
 * branded object; the session refuses anything not built here.
 */
function createStatements(input: { runId: string; schema: string; ownership: RunOwnership; publicRows: PublicRows; productionCreate: string; ddl: ScratchDdl; cleanupAllowed: ReadonlySet<string> }) {
  const { runId, schema, ownership, publicRows } = input;
  ownership.assertOwnedSchema(schema);
  const X = scratchTexts(schema, runId, input.productionCreate, input.ddl);
  const make = (kind: StmtKind, text: string, params: unknown[], mode: "read" | "write", scratchRows = 0): Stmt => {
    if (mode === "read" && kind !== "explain" && /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\b/i.test(text)) throw new HarnessFailure(`a read statement of kind ${kind} contains a write verb`);
    if (mode === "write" && /^\s*(SELECT|EXPLAIN)\b/i.test(text)) throw new HarnessFailure(`a write statement of kind ${kind} is a query`);
    const stmt = Object.freeze({ [BRAND]: true as const, kind, text, params: Object.freeze([...params]), mode, scratchRows });
    assertStatementText(stmt);
    return stmt;
  };
  const isoMs = (value: unknown): string => {
    if (typeof value !== "string" || !ISO_MS.test(value) || Number.isNaN(Date.parse(value))) throw new HarnessFailure("a timestamp parameter is not an exact-millisecond UTC ISO string");
    return value;
  };
  const isoAny = (value: unknown): string => {
    if (typeof value !== "string" || !(ISO_MS.test(value) || ISO_US.test(value)) || Number.isNaN(Date.parse(value.slice(0, 23) + "Z"))) throw new HarnessFailure("a timestamp parameter is not a UTC ISO string");
    return value;
  };
  const purpose = (value: unknown): string => {
    if (typeof value !== "string" || !(PURPOSES as readonly string[]).includes(value)) throw new HarnessFailure("a purpose parameter is not a known challenge purpose");
    return value;
  };
  const value = (v: unknown): string => {
    if (typeof v !== "string" || v.length > 40 || !CHALLENGE_VALUE.test(v)) throw new HarnessFailure("a scratch challenge value is malformed");
    return v;
  };
  const tableArg = (v: unknown): string => {
    if (v !== "public.webauthn_challenges" && v !== X.table) throw new HarnessFailure("a catalog read may name only the public table or this run's scratch table");
    return v;
  };
  type PurgeInput = { cutoff: string; challenge: string; purpose: string; context: string | null; expiresAt: string };
  const purgeParams = (p: PurgeInput): unknown[] => [isoMs(p.cutoff), value(p.challenge), purpose(p.purpose), p.context === null ? null : String(p.context), isoMs(p.expiresAt)];
  const registered = (values: unknown): string[] => {
    if (!Array.isArray(values) || values.length === 0 || values.length > CEILINGS.publicRows || !values.every((entry) => publicRows.owns(entry))) throw new HarnessFailure("a public statement names a value this run did not register");
    return values as string[];
  };

  return {
    texts: X,
    identity: () => make("cat_identity", TEXT.identity, [], "read"),
    publicCount: () => make("cat_public_count", TEXT.publicCount, [], "read"),
    shape: (table: string) => make("cat_shape", TEXT.shape, [tableArg(table)], "read"),
    indexes: (table: string) => make("cat_indexes", TEXT.indexes, [tableArg(table)], "read"),
    checks: (table: string) => make("cat_checks", TEXT.checks, [tableArg(table)], "read"),
    schemas: () => make("cat_schemas", TEXT.schemas, [], "read"),
    usedTables: () => make("cat_used_tables", TEXT.usedTables, [[...USED_BRANCH_TABLES]], "read"),
    activitySelf: () => make("cat_activity_self", TEXT.activitySelf, [], "read"),
    holderActive: () => make("cat_holder_active", TEXT.holderActive, [TAG(runId)], "read"),
    list: () => make("rd_list", X.list, [], "read"),
    count: () => make("rd_count", X.count, [], "read"),
    publicRow: (challenge: string) => make("rd_public_row", TEXT.publicRow, registered([challenge]), "read"),
    publicPresent: (challenges: string[]) => make("rd_public_present", TEXT.publicPresent, [registered(challenges)], "read"),
    explain: (p: PurgeInput) => make("explain", X.explain, purgeParams(p), "read"),
    createSchema: () => make("create_schema", X.createSchema, [], "write"),
    createTable: () => make("create_table", X.createTable, [], "write"),
    createIndex: () => make("create_index", X.createIndex, [], "write"),
    seedRows: (prefix: string, baseIso: string, count: number) => {
      if (!SEED_PREFIX.test(prefix)) throw new HarnessFailure("a seed prefix is malformed");
      if (!Number.isSafeInteger(count) || count < 1 || count > CEILINGS.perfSeedRows) throw new HarnessFailure("a seed count is outside 1..4300");
      return make("seed_rows", X.seedRows, [prefix, isoMs(baseIso), count], "write", count);
    },
    seedOne: (challenge: string, purposeValue: string, expiresIso: string) => make("seed_one", X.seedOne, [value(challenge), purpose(purposeValue), isoAny(expiresIso)], "write", 1),
    reset: () => make("reset", X.reset, [], "write"),
    analyze: () => make("analyze", X.analyze, [], "write"),
    purgeCreate: (p: PurgeInput) => make("purge_create", X.purge, purgeParams(p), "write", 1),
    publicSeed: (challenge: string, purposeValue: string, expiresIso: string) => make("public_seed", TEXT.publicSeed, [registered([challenge])[0], purpose(purposeValue), isoMs(expiresIso)], "write"),
    publicDelete: (challenges: string[]) => {
      const exact = registered(challenges);
      if (!same([...exact].sort(), publicRows.list().sort())) throw new HarnessFailure("the cleanup delete must name exactly the values this run registered");
      return make("public_delete", TEXT.publicDelete, [exact], "write");
    },
    /** A statement from the ownership module's own cleanup plan, admitted only by exact text and owned names. */
    ownership: (text: string, params: unknown[]): Stmt => {
      if (!input.cleanupAllowed.has(text)) throw new HarnessFailure("an ownership statement is not part of the planned cleanup");
      const drop = /^DROP (TABLE|SCHEMA) /.test(text);
      if (drop && !new RegExp(`^DROP (TABLE ${schema}\\.webauthn_challenges|SCHEMA ${schema}) RESTRICT$`).test(text)) throw new HarnessFailure("a DROP names something this run does not own");
      for (const param of params) {
        const names = Array.isArray(param) ? param : [param];
        if (!names.every((name) => name === schema)) throw new HarnessFailure("an ownership statement names a schema this run does not own");
      }
      return make("ownership", text, params, drop ? "write" : "read");
    },
    /** The lock holder: a transaction with a server-side statement timeout, a row lock on exact values, and a finite sleep. */
    holder: (challenges: string[], sleepSeconds: number): BatchStmt => {
      if (!Number.isSafeInteger(sleepSeconds) || sleepSeconds < 1 || sleepSeconds > 20) throw new HarnessFailure("the holder sleep must be 1..20 seconds");
      if (!Array.isArray(challenges) || challenges.length === 0 || challenges.length > PURGE_BOUND || !challenges.every((entry) => /^p7-[0-9]{4}$/.test(entry))) throw new HarnessFailure("the holder may lock only P7's own scratch values");
      const statements = [
        { text: X.holderSettings, params: [] as unknown[] },
        { text: X.holderLock, params: [challenges] as unknown[] },
        { text: X.holderSleep, params: [sleepSeconds] as unknown[] },
      ];
      for (const entry of statements) assertStatementText({ kind: "holder", text: entry.text });
      return Object.freeze({ [BRAND]: true as const, kind: "holder" as const, statements, sleepSeconds });
    },
  };
}
type Statements = ReturnType<typeof createStatements>;

// ------------------------------------------------------------------------------------------------ the driver

type Driver = {
  query(text: string, params: unknown[]): Promise<Row[]>;
  transaction(statements: ReadonlyArray<{ text: string; params: unknown[] }>): Promise<Row[][]>;
  adapter: NeonQueryFunction<false, false>;
};
/** The ONLY places a connection is opened. Never reached unless every gate passed. */
let connectionAttempts = 0;
async function openLiveDriver(url: string): Promise<Driver> {
  connectionAttempts += 1;
  const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
  const real = createNeonSqlClient(url);
  return {
    query: async (text, params) => (await real.query(text, params)) as Row[],
    transaction: async (statements) => (await real.transaction(statements.map((entry) => real.query(entry.text, entry.params)))) as Row[][],
    adapter: real,
  };
}

// ------------------------------------------------------------------------------------------------ verdicts

/** What the DATABASE ended up as — a fact the saved final evidence can state. */
type DatabaseOutcome = "refused_before_any_write" | "poisoned" | "cleanup_not_confirmed" | "cleanup_confirmed";
/** The run's overall verdict, decided only AFTER the final evidence save. Database cleanliness and evidence completeness are kept apart. */
type Verdict = "completed_clean" | "clean_but_not_evidenced" | "cleanup_not_confirmed" | "poisoned_evidence_preserved" | "poisoned_final_evidence_only" | "poisoned_evidence_not_saved" | "refused_before_any_write";
function verdictFor(database: DatabaseOutcome, startSaved: boolean, finalSaved: boolean): Verdict {
  if (database === "refused_before_any_write") return "refused_before_any_write";
  // "preserved" means BOTH files exist; a final file without its start file is named for what it is.
  if (database === "poisoned") return finalSaved ? (startSaved ? "poisoned_evidence_preserved" : "poisoned_final_evidence_only") : "poisoned_evidence_not_saved";
  if (database === "cleanup_not_confirmed") return "cleanup_not_confirmed";
  return startSaved && finalSaved ? "completed_clean" : "clean_but_not_evidenced";
}
/**
 * The run's pass/fail, in the manner of the project's earlier concludeRun: it passes ONLY when the database cleanup was confirmed AND
 * both evidence files were saved. A clean database whose evidence is incomplete is a failure — reported, never repaired by further
 * database work. No verdict other than completed_clean passes.
 */
function concludeRun(report: { outcome: unknown; evidence?: { start?: { saved?: unknown; reason?: unknown }; final?: { saved?: unknown; reason?: unknown } } }): { pass: boolean; verdict: string; message: string } {
  const outcome = String(report.outcome);
  const startSaved = report.evidence?.start?.saved === true;
  const finalSaved = report.evidence?.final?.saved === true;
  const evidenceNote = `start evidence ${startSaved ? "saved" : "NOT saved"}; final evidence ${finalSaved ? "saved" : "NOT saved"}`;
  if (outcome === "completed_clean" && startSaved && finalSaved) return { pass: true, verdict: outcome, message: `challenge purge proof: completed clean; ${evidenceNote}.` };
  if (outcome === "clean_but_not_evidenced") return { pass: false, verdict: outcome, message: `challenge purge proof: the database cleanup was confirmed, but the evidence is incomplete (${evidenceNote}); this is NOT an evidenced successful run, and nothing further was sent to the database.` };
  if (outcome === "poisoned_final_evidence_only") return { pass: false, verdict: outcome, message: `challenge purge proof: the run was poisoned; only the FINAL evidence exists (${evidenceNote}); the start record was never saved, and nothing was cleaned up.` };
  if (outcome === "poisoned_evidence_not_saved") return { pass: false, verdict: outcome, message: `challenge purge proof: the run was poisoned AND its final evidence was NOT saved (${evidenceNote}); the branch state is unknown and nothing was cleaned up.` };
  return { pass: false, verdict: outcome, message: `challenge purge proof: ${outcome} (${evidenceNote}).` };
}

// ------------------------------------------------------------------------------------------------ the session

type State = "NOT_STARTED" | "PREFLIGHT" | "REFUSED" | "ARMED" | "RUNNING" | "CLEANUP" | "COMPLETED_CLEAN" | "COMPLETED_NOT_CLEAN" | "COMPLETED_NOT_EVIDENCED" | "POISONED";
type EvidenceSave = { ok: true } | { ok: false; reason: string };
type SessionInput = {
  runId: string;
  driver: Driver;
  timing: Timing;
  perf: boolean;
  production: CapturedSql;
  ddl: ScratchDdl;
  target: Record<string, unknown>;
  provenance: Record<string, unknown>;
  save: (stage: "start" | "final", evidence: Record<string, unknown>) => EvidenceSave;
};
type Ctx = {
  S: Statements;
  timing: Timing;
  exec(stmt: Stmt): Promise<Row[]>;
  batch(stmt: BatchStmt): Promise<Row[][]>;
  store: ReturnType<typeof createNeonChallengeStore>;
  publicValue(name: string): string;
  cutoff(): Date;
  reset(): Promise<void>;
  list(): Promise<string[]>;
  listRows(): Promise<Array<{ challenge: string; purpose: string }>>;
  count(): Promise<number>;
  /** Public-table scope: every row in public.webauthn_challenges must be one this run registered. Two reads. */
  publicScope(label: string): Promise<{ total: number; owned: number }>;
  waitUntil(probe: () => Promise<boolean>, deadlineMs: number): Promise<boolean>;
};

function createSession(input: SessionInput) {
  const { runId, driver, timing, perf, production } = input;
  const ownership = createRunOwnership(runId, { maxScratchSchemas: CEILINGS.scratchSchemas });
  const schema = ownership.registerScratchSchema("main");
  ownership.registerScratchObject(schema, "table", "webauthn_challenges");
  const publicRows = createPublicRows(runId, CEILINGS.publicRows);
  const account: CleanupAccount = planAdmissionCleanup(ownership);
  const cleanupAllowed = new Set(account.steps.map((step) => step.statement.text));
  const S = createStatements({ runId, schema, ownership, publicRows, productionCreate: production.create, ddl: input.ddl, cleanupAllowed });
  const expectedCases = CASES.filter((entry) => perf || entry.optional !== "perf");
  const operationCeiling = CEILINGS.operations + (perf ? CEILINGS.perfExtraOperations : 0);

  let state: State = "NOT_STARTED";
  let poisonReason: string | null = null;
  const startedAt = Date.now();
  let cleanupStartedAt = 0;
  let operations = 0;
  let writes = 0;
  let scratchRowsCreated = 0;
  let publicCreates = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const outstanding = new Set<Promise<unknown>>();
  const uncertain: Array<{ what: string; mode: string }> = [];
  const refusals: Array<{ what: string; sqlState: string | null }> = [];
  const completed: string[] = [];
  const caseResults: Array<Record<string, unknown>> = [];
  const preflight: Array<{ check: string; ok: boolean }> = [];
  const facts: Record<string, unknown> = {};
  let baselineSchemas: string[] = [];
  let startSaved: EvidenceSave = { ok: false, reason: "not attempted" };
  let finalReport: Record<string, unknown> | null = null;

  /** Evidence writers must never throw into the run; a throw is a failed save. Nothing is retried. */
  const safeSave = (stage: "start" | "final", evidence: Record<string, unknown>): EvidenceSave => {
    try {
      return input.save(stage, evidence);
    } catch {
      return { ok: false, reason: "the evidence writer threw" };
    }
  };

  const poison = (reason: string): void => {
    if (poisonReason === null) poisonReason = reason;
    if (state !== "COMPLETED_CLEAN" && state !== "COMPLETED_NOT_CLEAN" && state !== "COMPLETED_NOT_EVIDENCED") state = "POISONED";
    ownership.seal(reason);
  };

  const gate = (mode: "read" | "write"): void => {
    if (state === "POISONED") throw new HarnessFailure("the run is poisoned; nothing further is sent");
    if (state === "REFUSED" || state === "NOT_STARTED" || state === "COMPLETED_CLEAN" || state === "COMPLETED_NOT_CLEAN" || state === "COMPLETED_NOT_EVIDENCED") throw new HarnessFailure(`nothing may be sent in state ${state}`);
    if (mode === "write" && state === "PREFLIGHT") throw new HarnessFailure("the preflight is read-only; the run is not armed");
    const limit = state === "CLEANUP" ? cleanupStartedAt + timing.cleanupDeadlineMs : startedAt + timing.runDeadlineMs;
    if (Date.now() > limit) {
      poison("a run or cleanup deadline passed");
      throw new HarnessFailure("a run or cleanup deadline passed; nothing further is sent");
    }
  };

  /** Sends ONE operation: counted, deadline-bounded, never retried, never cancelled. */
  async function track<T>(what: string, mode: "read" | "write", start: () => Promise<T>, deadlineMs: number, cost: { scratchRows?: number }): Promise<T> {
    operations += 1;
    if (mode === "write") writes += 1;
    if (operations > operationCeiling) {
      poison("the operation ceiling was exceeded");
      throw new HarnessFailure("the operation ceiling was exceeded");
    }
    scratchRowsCreated += cost.scratchRows ?? 0;
    if (scratchRowsCreated > CEILINGS.scratchRows) {
      poison("the scratch-row ceiling was exceeded");
      throw new HarnessFailure("the scratch-row ceiling was exceeded");
    }
    if (inFlight >= CEILINGS.concurrency) {
      poison("the concurrency ceiling was exceeded");
      throw new HarnessFailure("the concurrency ceiling was exceeded");
    }
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const op = Promise.resolve().then(start);
    outstanding.add(op);
    const release = () => {
      inFlight -= 1;
      outstanding.delete(op);
    };
    op.then(release, release);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HarnessFailure("DEADLINE")), deadlineMs);
    });
    try {
      return await Promise.race([op, deadline]);
    } catch (error) {
      const sqlState = sqlStateOf(error);
      if (error instanceof HarnessFailure && error.message === "DEADLINE") {
        uncertain.push({ what, mode });
        poison(`${what}: no answer within the deadline`);
        throw new HarnessFailure(`${what}: no answer within the deadline (the outcome is unknown; nothing is retried)`);
      }
      refusals.push({ what, sqlState });
      if (sqlState === null && mode === "write") uncertain.push({ what, mode });
      poison(`${what}: the database or driver refused${sqlState ? ` (${sqlState})` : ""}`);
      throw Object.assign(new HarnessFailure(`${what}: the database or driver refused${sqlState ? ` (SQLSTATE ${sqlState})` : " (no SQLSTATE)"}`), sqlState ? { code: sqlState } : {});
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const hasBrand = (value: unknown): boolean => typeof value === "object" && value !== null && (value as { [BRAND]?: unknown })[BRAND] === true;

  async function exec(stmt: Stmt): Promise<Row[]> {
    if (!hasBrand(stmt)) throw new HarnessFailure("only statements built by the factory may be sent");
    assertStatementText(stmt);
    gate(stmt.mode);
    return track(stmt.kind, stmt.mode, () => driver.query(stmt.text, [...stmt.params]), timing.statementDeadlineMs, { scratchRows: stmt.scratchRows });
  }
  async function batch(stmt: BatchStmt): Promise<Row[][]> {
    if (!hasBrand(stmt) || stmt.kind !== "holder") throw new HarnessFailure("only the factory's holder batch may be sent");
    gate("write");
    return track("holder", "write", () => driver.transaction(stmt.statements), stmt.sleepSeconds * 1000 + 20_000, {});
  }

  /** The adapter's own statements: forwarded only if their text is exactly the pinned production text and their values are run-owned. */
  const adapterSql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = normalize(strings.join("$?"));
    if (text === production.create && values.length === 5) {
      if (!publicRows.owns(values[1])) throw new HarnessFailure("the adapter was asked to create a public challenge this run did not register");
      if (typeof values[0] !== "string" || !ISO_MS.test(values[0])) throw new HarnessFailure("the adapter's cutoff is not an exact-millisecond ISO string");
      publicCreates += 1;
      gate("write");
      return track("adapter_create", "write", () => Promise.resolve(driver.adapter(strings, ...values)) as Promise<Row[]>, timing.statementDeadlineMs, {});
    }
    if (text === production.consume && values.length === 1) {
      if (!publicRows.owns(values[0])) throw new HarnessFailure("the adapter was asked to consume a public challenge this run did not register");
      gate("write");
      return track("adapter_consume", "write", () => Promise.resolve(driver.adapter(strings, ...values)) as Promise<Row[]>, timing.statementDeadlineMs, {});
    }
    throw new HarnessFailure("the adapter sent a statement that is not the pinned production create or consume; refusing to forward it");
  }) as unknown as NeonQueryFunction<false, false>;
  const store = createNeonChallengeStore(adapterSql);

  const ctx: Ctx = {
    S,
    timing,
    exec,
    batch,
    store,
    publicValue: (name) => publicRows.register(name),
    cutoff: () => new Date(),
    reset: async () => {
      await exec(S.reset());
    },
    list: async () => (await exec(S.list())).map((row) => String(row.challenge)),
    listRows: async () => (await exec(S.list())).map((row) => ({ challenge: String(row.challenge), purpose: String(row.purpose) })),
    count: async () => Number(one(await exec(S.count()), "count").n),
    publicScope: async (label) => {
      const total = Number(one(await exec(S.publicCount()), "public count").n);
      const values = publicRows.list();
      const owned = values.length === 0 ? 0 : (await exec(S.publicPresent(values))).length;
      check(total === owned, `${label}: public.webauthn_challenges holds ${total} rows but only ${owned} are this run's; the scope is no longer limited to run-owned rows`);
      return { total, owned };
    },
    waitUntil: async (probe, deadlineMs) => {
      const until = Date.now() + deadlineMs;
      for (;;) {
        if (await probe()) return true;
        if (Date.now() >= until) return false;
        await sleep(timing.pollMs);
      }
    },
  };

  // ---------------------------------------------------------------------------------------------- preflight

  async function runPreflight(): Promise<void> {
    // A terminal or running state must never be pulled back into PREFLIGHT, and a preflight can be started only once.
    if (state !== "NOT_STARTED") throw new HarnessFailure(`the preflight cannot start in state ${state}`);
    state = "PREFLIGHT";
    /**
     * L-A. Every awaited read passes through here. If the run was poisoned, refused or sealed while a read was outstanding, its LATE answer is
     * discarded: no check is recorded, no state changes (POISONED is never overwritten by ARMED or REFUSED), no start evidence is saved, no sealed
     * report is touched, and no SQL is sent. Nothing is retried. After the last read the remaining steps run synchronously, so the check is atomic
     * with arming.
     */
    const stillPreflight = (): void => {
      if (state !== "PREFLIGHT" || finalReport !== null) throw new HarnessFailure("the run ended while the preflight was outstanding; its late result is discarded");
    };
    const read = async (stmt: Stmt): Promise<Row[]> => {
      const rows = await exec(stmt);
      stillPreflight();
      return rows;
    };
    const record = (name: string, ok: boolean) => preflight.push({ check: name, ok });
    const server = one(await read(S.identity()), "identity");
    facts.server = { database: server.database, version: server.version, isolation: server.isolation, defaultIsolation: server.default_isolation, inRecovery: server.in_recovery };
    record("the target is not a read replica", server.in_recovery === false);
    record("the server is version 15 or newer", typeof server.version_num === "number" && server.version_num >= 150000);
    record("a single autocommit statement runs at READ COMMITTED", server.isolation === "read committed");
    record("the database default isolation is READ COMMITTED", server.default_isolation === "read committed");
    record("the unqualified name webauthn_challenges resolves to public.webauthn_challenges (the adapter's statements are unqualified)", server.resolves_to_public === true);
    const publicShape = await read(S.shape("public.webauthn_challenges"));
    record("public.webauthn_challenges has the five expected columns", same(publicShape.map((row) => row.name), ["challenge", "purpose", "context", "created_at", "expires_at"]));
    const publicIndexes = await read(S.indexes("public.webauthn_challenges"));
    record("public.webauthn_challenges has the expires_at btree index", publicIndexes.some((row) => row.name === "webauthn_challenges_expires_at_idx" && /USING btree \(expires_at\)/.test(String(row.definition))));
    const publicChecks = await read(S.checks("public.webauthn_challenges"));
    record("the purpose CHECK allows all six purposes", publicChecks.some((row) => PURPOSES.every((name) => String(row.definition).includes(`'${name}'`))));
    facts.publicShape = publicShape.map((row) => `${row.name}:${row.type}:${row.not_null}:${row.default_expr ?? ""}`);
    const used = await read(S.usedTables());
    record("no table an earlier smoke leaves behind exists in public (a used branch is refused)", used.length === 0);
    const schemas = (await read(S.schemas())).map((row) => String(row.name));
    baselineSchemas = schemas;
    record("no scratch schema of this harness's shape exists", !schemas.some((name) => name.startsWith("pb_smoke_")));
    const visible = one(await read(S.activitySelf()), "activity");
    record("this session can read its own pg_stat_activity entry", visible.n === 1);
    const total = Number(one(await read(S.publicCount()), "count").n);
    facts.publicRowsAtStart = total;
    record("public.webauthn_challenges is COMPLETELY EMPTY (no inherited or unrelated row)", total === 0);

    stillPreflight();
    const failed = preflight.filter((entry) => !entry.ok).map((entry) => entry.check);
    if (failed.length > 0) {
      state = "REFUSED";
      throw new HarnessFailure(`REFUSED before any write; nothing was changed. Failed preflight checks: ${failed.join("; ")}`);
    }
    startSaved = safeSave("start", {
      runId,
      stage: "start",
      mode: perf ? "correctness+performance" : "correctness",
      target: input.target,
      provenance: input.provenance,
      server: facts.server,
      preflight,
      plan: { cases: expectedCases.map((entry) => ({ id: entry.id, path: entry.path, operations: entry.operations, scratchRows: entry.scratchRows, publicRows: entry.publicRows, concurrent: entry.concurrent })), budget: planBudget(perf), ceilings: CEILINGS },
      baseline: { publicRows: total, schemas },
    });
    if (!startSaved.ok) {
      state = "REFUSED";
      throw new HarnessFailure(`REFUSED before any write: the start evidence could not be saved (${startSaved.reason})`);
    }
    state = "ARMED";
  }

  async function runSetup(): Promise<void> {
    await exec(S.createSchema());
    await exec(S.createTable());
    await exec(S.createIndex());
    const scratchShape = await exec(S.shape(S.texts.table));
    check(same(scratchShape.map((row) => `${row.name}:${row.type}:${row.not_null}:${row.default_expr ?? ""}`), facts.publicShape), "the scratch table's columns, types, nullability and defaults differ from public.webauthn_challenges");
    const scratchIndexes = await exec(S.indexes(S.texts.table));
    check(scratchIndexes.some((row) => row.name === "webauthn_challenges_expires_at_idx"), "the scratch table has no expires_at index");
    const scratchChecks = await exec(S.checks(S.texts.table));
    check(scratchChecks.some((row) => PURPOSES.every((name) => String(row.definition).includes(`'${name}'`))), "the scratch table's purpose CHECK does not allow all six purposes");
  }

  // ---------------------------------------------------------------------------------------------- cases

  const caseBodies: Record<string, (c: Ctx) => Promise<Record<string, unknown>>> = {
    P1: async (c) => {
      const scopeBefore = await c.publicScope("P1 before");
      const [a, b, expired, trigger] = [c.publicValue("p1-a"), c.publicValue("p1-b"), c.publicValue("p1-exp"), c.publicValue("p1-trig")];
      const createdA = await c.store.create({ challenge: a, purpose: "handle_claim", ttlMs: 300_000, context: { k: "v", n: 1 } });
      const rowA = one(await c.exec(c.S.publicRow(a)), "P1 row a");
      const context = JSON.parse(String(rowA.context)) as { k?: unknown; n?: unknown };
      check(rowA.purpose === "handle_claim" && context.k === "v" && context.n === 1, "P1: the purpose or the JSON context did not round trip");
      check(Number(rowA.expires_ms) === createdA.expiresAt, "P1: the stored expires_at differs from the adapter's returned expiresAt (millisecond binding)");
      await c.store.create({ challenge: b, purpose: "login", ttlMs: 300_000 });
      const rowB = one(await c.exec(c.S.publicRow(b)), "P1 row b");
      check(rowB.purpose === "login" && rowB.context === null, "P1: a create without context must store NULL");
      await c.exec(c.S.publicSeed(expired, "login", new Date(Date.now() - MINUTE).toISOString()));
      await c.store.create({ challenge: trigger, purpose: "login", ttlMs: 60_000 });
      const present = (await c.exec(c.S.publicPresent([a, b, expired, trigger]))).map((row) => String(row.challenge)).sort();
      check(same(present, [a, b, trigger].sort()), "P1: the real adapter's create did not purge the one expired row while keeping the live ones");
      const scopeAfter = await c.publicScope("P1 after");
      return { expected: { present: "a, b, trigger; expired removed", publicScope: "only run-owned rows" }, actual: { presentCount: present.length, expiredRemoved: !present.includes(expired), publicRowsBefore: scopeBefore.total, publicRowsAfter: scopeAfter.total } };
    },

    P2: async (c) => {
      await c.reset();
      const cutoff = c.cutoff();
      await c.exec(c.S.seedRows("p2-", new Date(cutoff.getTime() - 2 * HOUR).toISOString(), 100));
      check((await c.count()) === 100, "P2: the seed did not produce 100 rows");
      await c.exec(c.S.purgeCreate({ cutoff: cutoff.toISOString(), challenge: "p2-new", purpose: "login", context: null, expiresAt: new Date(cutoff.getTime() + 5 * MINUTE).toISOString() }));
      const after = await c.list();
      const expected = [...Array.from({ length: 36 }, (_, i) => `p2-${pad4(65 + i)}`), "p2-new"];
      check(same(after, expected), `P2: expected the 36 newest expired rows and the new challenge; got ${after.length} rows`);
      return { expected: { deleted: 64, remainingExpired: 36, newPresent: true }, actual: { deleted: 100 - (after.length - 1), remainingExpired: after.length - 1, newPresent: after.includes("p2-new") } };
    },

    P3: async (c) => {
      await c.reset();
      const cutoff = c.cutoff();
      await c.exec(c.S.seedRows("p3l-", new Date(cutoff.getTime() + HOUR).toISOString(), 6));
      await c.exec(c.S.seedRows("p3e-", new Date(cutoff.getTime() - 2 * HOUR).toISOString(), 70));
      await c.exec(c.S.purgeCreate({ cutoff: cutoff.toISOString(), challenge: "p3-new", purpose: "login", context: null, expiresAt: new Date(cutoff.getTime() + 5 * MINUTE).toISOString() }));
      const rows = await c.listRows();
      const live = rows.filter((row) => row.challenge.startsWith("p3l-"));
      const expiredLeft = rows.filter((row) => row.challenge.startsWith("p3e-")).map((row) => row.challenge);
      check(live.length === 6 && new Set(live.map((row) => row.purpose)).size === 6, "P3: the six unexpired rows (one per purpose) were not all preserved");
      check(same(expiredLeft, Array.from({ length: 6 }, (_, i) => `p3e-${pad4(65 + i)}`)), "P3: the expired rows left are not exactly the six newest");
      check(rows.some((row) => row.challenge === "p3-new"), "P3: the new challenge is missing");
      return { expected: { liveKept: 6, livePurposes: 6, expiredDeleted: 64, expiredLeft: 6 }, actual: { liveKept: live.length, livePurposes: new Set(live.map((row) => row.purpose)).size, expiredLeft: expiredLeft.length } };
    },

    P4: async (c) => {
      const outcomes: Record<string, unknown> = {};
      const create = (cutoff: Date, challenge: string) => c.exec(c.S.purgeCreate({ cutoff: cutoff.toISOString(), challenge, purpose: "login", context: null, expiresAt: new Date(cutoff.getTime() + 5 * MINUTE).toISOString() }));
      for (const [label, prefix, size, remaining] of [["exactly 64", "p4a-", 64, 0], ["exactly 65", "p4b-", 65, 1]] as const) {
        await c.reset();
        const cutoff = c.cutoff();
        await c.exec(c.S.seedRows(prefix, new Date(cutoff.getTime() - 2 * HOUR).toISOString(), size));
        await create(cutoff, `${prefix}new`);
        const left = (await c.list()).filter((name) => name.startsWith(prefix) && name !== `${prefix}new`);
        check(left.length === remaining, `P4: with ${label} expired rows, ${remaining} should remain; ${left.length} did`);
        outcomes[label] = { deleted: size - left.length, remaining: left.length };
      }
      await c.reset();
      const cutoff = c.cutoff();
      await c.exec(c.S.seedRows("p4c-", new Date(cutoff.getTime() - 2 * HOUR).toISOString(), 160));
      let previous = 160;
      let maxDeleted = 0;
      const drain: number[] = [];
      for (let step = 1; step <= 3; step += 1) {
        await create(cutoff, `p4c-new${step}`);
        const left = (await c.list()).filter((name) => /^p4c-[0-9]{4}$/.test(name)).length;
        const deleted = previous - left;
        maxDeleted = Math.max(maxDeleted, deleted);
        drain.push(left);
        check(deleted <= PURGE_BOUND, `P4: one create deleted ${deleted} rows, above the bound of ${PURGE_BOUND}`);
        previous = left;
      }
      check(same(drain, [96, 32, 0]), `P4: the backlog should drain 160 -> 96 -> 32 -> 0; observed ${drain.join(" -> ")}`);
      return { expected: { drain: [96, 32, 0], maxDeletedPerCreate: 64 }, actual: { drain, maxDeletedPerCreate: maxDeleted, ...outcomes } };
    },

    P5: async (c) => {
      await c.reset();
      const cutoff = c.cutoff();
      const ms = cutoff.getTime();
      const iso = (offset: number) => new Date(ms + offset).toISOString();
      const withMicros = (offset: number, micros: string) => iso(offset).replace("Z", `${micros}Z`);
      const rows: Array<[string, string, boolean]> = [
        ["p5-below-1us", withMicros(-1, "999"), false],
        ["p5-below-1ms", iso(-1), false],
        ["p5-equal", iso(0), true],
        ["p5-above-1us", withMicros(0, "001"), true],
        ["p5-above-1ms", iso(1), true],
      ];
      for (const [name, stamp] of rows) await c.exec(c.S.seedOne(name, "login", stamp));
      await c.exec(c.S.purgeCreate({ cutoff: iso(0), challenge: "p5-new", purpose: "login", context: null, expiresAt: iso(5 * MINUTE) }));
      const left = await c.list();
      const expectedKept = rows.filter((row) => row[2]).map((row) => row[0]);
      check(same([...left].sort(), [...expectedKept, "p5-new"].sort()), `P5: strict less-than failed; rows left: ${left.join(",")}`);
      return { expected: { deleted: ["p5-below-1us", "p5-below-1ms"], keptAtOrAbove: expectedKept.length }, actual: { left: left.length - 1, newPresent: left.includes("p5-new") } };
    },

    P6: async (c) => {
      // FIXTURE: a 600-row expired backlog (so even eight full 64-row purges, 512 rows, cannot empty it) plus 6 live rows.
      await c.reset();
      const cutoff = c.cutoff();
      const EXPIRED = 600;
      const LIVE = 6;
      const CONCURRENT = CEILINGS.correctnessConcurrency;
      await c.exec(c.S.seedRows("p6-", new Date(cutoff.getTime() - 2 * HOUR).toISOString(), EXPIRED));
      await c.exec(c.S.seedRows("p6l-", new Date(cutoff.getTime() + HOUR).toISOString(), LIVE));
      const settled = await Promise.allSettled(
        Array.from({ length: CONCURRENT }, (_, i) => c.exec(c.S.purgeCreate({ cutoff: cutoff.toISOString(), challenge: `p6-new${i + 1}`, purpose: "login", context: null, expiresAt: new Date(cutoff.getTime() + 5 * MINUTE).toISOString() }))),
      );
      const failures = settled.filter((entry) => entry.status !== "fulfilled").length;
      check(failures === 0, "P6: a concurrent create failed (a deadlock or any other error poisons the run)");
      const names = await c.list();
      const inserted = names.filter((name) => /^p6-new[0-9]$/.test(name));
      const live = names.filter((name) => /^p6l-[0-9]{4}$/.test(name));
      const remaining = names.filter((name) => /^p6-[0-9]{4}$/.test(name)).length;
      const deleted = EXPIRED - remaining;
      check(same(live, Array.from({ length: LIVE }, (_, i) => `p6l-${pad4(i + 1)}`)), "P6: a previously live row was deleted or altered");
      check(same([...inserted].sort(), Array.from({ length: CONCURRENT }, (_, i) => `p6-new${i + 1}`).sort()), "P6: the eight new challenge values are not all present exactly once");
      // AGGREGATE bound only. It is a necessary concurrency check, NOT proof that each statement deleted at most 64 rows: a statement could
      // delete more than 64 while another deleted fewer and the total would still fit. The per-statement bound rests on the SQL's own
      // semantics (LIMIT 64 inside the locked selection) and on the separate inspection of the production statement.
      check(deleted >= PURGE_BOUND && deleted <= CONCURRENT * PURGE_BOUND, `P6: ${deleted} expired rows were deleted in total; between 64 and ${CONCURRENT * PURGE_BOUND} were expected`);
      check(remaining >= EXPIRED - CONCURRENT * PURGE_BOUND, `P6: only ${remaining} expired rows remain; at least ${EXPIRED - CONCURRENT * PURGE_BOUND} must`);
      check(names.length === remaining + LIVE + CONCURRENT, "P6: the table holds rows that are neither seeded nor created by the eight creates");
      return {
        expected: { inserted: CONCURRENT, liveKept: LIVE, deletedBetween: [PURGE_BOUND, CONCURRENT * PURGE_BOUND], expiredRemainingAtLeast: EXPIRED - CONCURRENT * PURGE_BOUND, errors: 0 },
        actual: { inserted: inserted.length, liveKept: live.length, deleted, expiredRemaining: remaining, errors: failures, launched: settled.length, totalRows: names.length },
        limitation: "aggregate deletion bound only; it does not independently prove that each statement deleted at most 64 rows",
      };
    },

    P7: async (c) => {
      await c.reset();
      const cutoff = c.cutoff();
      await c.exec(c.S.seedRows("p7-", new Date(cutoff.getTime() - 2 * HOUR).toISOString(), 140));
      const locked = Array.from({ length: PURGE_BOUND }, (_, i) => `p7-${pad4(i + 1)}`);
      const holder = c.batch(c.S.holder(locked, c.timing.holderSleepSeconds));
      holder.catch(() => undefined);
      const isActive = async () => Number(one(await c.exec(c.S.holderActive()), "holder poll").n) >= 1;
      const seen = await c.waitUntil(isActive, c.timing.holderWaitMs);
      check(seen, "P7: the lock holder was never observed sleeping, so the interleaving is not proven");
      const started = Date.now();
      await c.exec(c.S.purgeCreate({ cutoff: cutoff.toISOString(), challenge: "p7-new", purpose: "login", context: null, expiresAt: new Date(cutoff.getTime() + 5 * MINUTE).toISOString() }));
      const elapsed = Date.now() - started;
      const stillHeld = await isActive();
      check(stillHeld, "P7: the holder had already finished when the purge returned, so the purge may have waited for it");
      check(elapsed < c.timing.maxCreateElapsedMs, `P7: the purge took ${elapsed} ms with the holder still sleeping; it should not wait`);
      await holder;
      const names = await c.list();
      const lockedKept = locked.every((name) => names.includes(name));
      const next = Array.from({ length: PURGE_BOUND }, (_, i) => `p7-${pad4(PURGE_BOUND + 1 + i)}`);
      const nextDeleted = next.every((name) => !names.includes(name));
      const rest = Array.from({ length: 12 }, (_, i) => `p7-${pad4(129 + i)}`);
      check(lockedKept, "P7: a locked row was deleted");
      check(nextDeleted, "P7: the purge did not delete the next 64 unlocked rows");
      check(rest.every((name) => names.includes(name)) && names.includes("p7-new") && names.length === 64 + 12 + 1, "P7: the remaining rows are not exactly the 12 newest expired rows, the locked 64 and the new challenge");
      return { expected: { lockedKept: 64, nextDeleted: 64, remaining: 77, holderStillSleepingWhenPurgeReturned: true }, actual: { lockedKept: locked.length, nextDeleted: next.length, remaining: names.length, holderStillSleepingWhenPurgeReturned: stillHeld, purgeElapsedMs: elapsed, holderPolls: "bounded" } };
    },

    P8: async (c) => {
      await c.publicScope("P8 before");
      const rounds: Array<Record<string, unknown>> = [];
      for (const round of [1, 2]) {
        const [expired, trigger] = [c.publicValue(`p8-exp${round}`), c.publicValue(`p8-trig${round}`)];
        await c.exec(c.S.publicSeed(expired, "login", new Date(Date.now() - MINUTE).toISOString()));
        const [consumed] = await Promise.all([c.store.consume({ challenge: expired, purpose: "login" }), c.store.create({ challenge: trigger, purpose: "login", ttlMs: 60_000 })]);
        check(consumed === null, "P8: an EXPIRED challenge authenticated");
        const present = (await c.exec(c.S.publicPresent([expired, trigger]))).map((row) => String(row.challenge));
        check(!present.includes(expired) && present.includes(trigger), "P8: the expired row must be gone (consumed or purged) and the new one present");
        rounds.push({ round, consumedResult: "null", expiredRemoved: true });
      }
      const live = c.publicValue("p8-live");
      await c.store.create({ challenge: live, purpose: "login", ttlMs: 120_000 });
      const results = await Promise.all(Array.from({ length: 4 }, () => c.store.consume({ challenge: live, purpose: "login" })));
      const winners = results.filter((entry) => entry !== null);
      check(winners.length === 1 && winners[0]?.challenge === live, `P8: ${winners.length} of 4 concurrent consumes succeeded; exactly 1 must`);
      check((await c.store.consume({ challenge: live, purpose: "login" })) === null, "P8: a consumed challenge was consumable again");
      check((await c.exec(c.S.publicPresent([live]))).length === 0, "P8: the consumed row is still present");
      const scope = await c.publicScope("P8 after");
      return { expected: { expiredAuthenticated: 0, liveConsumedOnce: 1, publicScope: "only run-owned rows" }, actual: { rounds, liveWinners: winners.length, concurrentConsumes: 4, publicRowsAfter: scope.total } };
    },

    P9: async (c) => {
      await c.reset();
      const cutoff = c.cutoff();
      await c.exec(c.S.seedRows("p9-", new Date(cutoff.getTime() - 2 * HOUR).toISOString(), 120));
      await c.exec(c.S.analyze());
      const plan = summarizePlan(await c.exec(c.S.explain({ cutoff: cutoff.toISOString(), challenge: "p9-new", purpose: "login", context: null, expiresAt: new Date(cutoff.getTime() + 5 * MINUTE).toISOString() })));
      check(plan.hasLimit && plan.limitRows !== null && plan.limitRows <= PURGE_BOUND, "P9: the plan has no Limit node estimated at 64 rows or fewer");
      check(plan.lockRowsUnderLimit, "P9: no LockRows node sits under the Limit (the SKIP LOCKED selection)");
      check(plan.hasDelete, "P9: no ModifyTable Delete node on webauthn_challenges");
      check(plan.hasInsert, "P9: no ModifyTable Insert node on webauthn_challenges");
      return { expected: { limit: "<=64", lockRowsUnderLimit: true, delete: true, insert: true }, actual: plan };
    },

    PERF: async (c) => {
      await c.reset();
      const cutoff = c.cutoff();
      const p = { cutoff: cutoff.toISOString(), purpose: "login", context: null, expiresAt: new Date(cutoff.getTime() + 5 * MINUTE).toISOString() };
      await c.exec(c.S.seedRows("pf-", new Date(cutoff.getTime() - 2 * HOUR).toISOString(), CEILINGS.perfSeedRows));
      await c.exec(c.S.analyze());
      const before = summarizePlan(await c.exec(c.S.explain({ ...p, challenge: "pf-plan" })));
      const timings: number[] = [];
      for (let step = 1; step <= CEILINGS.perfCreates; step += 1) {
        const rowsBefore = await c.count();
        const started = Date.now();
        await c.exec(c.S.purgeCreate({ ...p, challenge: `pf-new${step}` }));
        timings.push(Date.now() - started);
        const rowsAfter = await c.count();
        check(rowsBefore - rowsAfter + 1 === PURGE_BOUND, `PERF: create ${step} deleted ${rowsBefore - rowsAfter + 1} rows; exactly 64 were expected`);
      }
      return { expected: { deletedPerCreate: 64, creates: CEILINGS.perfCreates }, actual: { clientWallMsPerCreate: timings, measurement: "client-observed wall time including network; NOT database execution time", planBefore: before } };
    },
  };

  function summarizePlan(rows: Row[]): { hasLimit: boolean; limitRows: number | null; lockRowsUnderLimit: boolean; hasDelete: boolean; hasInsert: boolean; nodes: string[]; indexesUsed: string[]; seqScans: number } {
    const cell = one(rows, "explain")["QUERY PLAN"];
    const parsed = (typeof cell === "string" ? JSON.parse(cell) : cell) as Array<{ Plan?: PlanNode }>;
    check(Array.isArray(parsed) && parsed[0]?.Plan, "the EXPLAIN answer is not a JSON plan");
    const nodes: PlanNode[] = [];
    const walk = (node: PlanNode) => {
      nodes.push(node);
      for (const child of node.Plans ?? []) walk(child);
    };
    walk(parsed[0]!.Plan!);
    const limit = nodes.find((node) => node["Node Type"] === "Limit");
    const under = (node: PlanNode | undefined, type: string): boolean => !!node && (node.Plans ?? []).some((child) => child["Node Type"] === type || under(child, type));
    return {
      hasLimit: limit !== undefined,
      limitRows: typeof limit?.["Plan Rows"] === "number" ? limit["Plan Rows"] : null,
      lockRowsUnderLimit: under(limit, "LockRows"),
      hasDelete: nodes.some((node) => node["Node Type"] === "ModifyTable" && node.Operation === "Delete" && node["Relation Name"] === "webauthn_challenges"),
      hasInsert: nodes.some((node) => node["Node Type"] === "ModifyTable" && node.Operation === "Insert" && node["Relation Name"] === "webauthn_challenges"),
      nodes: nodes.map((node) => String(node["Node Type"])),
      indexesUsed: nodes.map((node) => node["Index Name"]).filter((name): name is string => typeof name === "string"),
      seqScans: nodes.filter((node) => node["Node Type"] === "Seq Scan").length,
    };
  }

  async function runCase(id: string): Promise<void> {
    const definition = expectedCases.find((entry) => entry.id === id);
    if (!definition) throw new HarnessFailure(`unknown case ${id}`);
    const needsSetup = state === "ARMED";
    if (needsSetup) state = "RUNNING";
    if (state !== "RUNNING") throw new HarnessFailure(`case ${id} cannot run in state ${state}`);
    const before = { operations, writes, scratchRowsCreated, publicCreates };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const caseDeadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HarnessFailure("CASE_DEADLINE")), timing.caseDeadlineMs);
    });
    try {
      if (needsSetup) await Promise.race([runSetup(), caseDeadline]);
      const notes = await Promise.race([caseBodies[id]!(ctx), caseDeadline]);
      if (finalReport !== null || state !== "RUNNING") throw new HarnessFailure(`${id}: the run ended while the case was outstanding; its late result is discarded`);
      completed.push(id);
      caseResults.push({ id, title: definition.title, path: definition.path, status: "passed", statements: operations - before.operations, writes: writes - before.writes, scratchRowsInserted: scratchRowsCreated - before.scratchRowsCreated, publicCreates: publicCreates - before.publicCreates, ...notes });
    } catch (error) {
      const message = error instanceof HarnessFailure ? (error.message === "CASE_DEADLINE" ? "the case deadline passed" : error.message) : "an unexpected error";
      if (finalReport === null) caseResults.push({ id, title: definition.title, path: definition.path, status: "failed", reason: message });
      poison(`${id}: ${message}`);
      throw error instanceof HarnessFailure ? error : new HarnessFailure(`${id}: an unexpected error`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------------------------------------- finish and cleanup

  const baseReport = () => ({
    runId,
    stage: "final",
    target: input.target,
    provenance: input.provenance,
    mode: perf ? "correctness+performance" : "correctness",
    stateAtWrite: state,
    poisonReason,
    caseResults: caseResults.map((entry) => ({ ...entry })),
    expectedCases: expectedCases.map((entry) => entry.id),
    completedCases: [...completed],
    counters: { operations, writes, scratchRowsInserted: scratchRowsCreated, publicRowsRegistered: publicRows.list().length, publicCreatesViaAdapter: publicCreates, maxInFlight, ceilings: CEILINGS },
    uncertainWrites: uncertain.map((entry) => ({ ...entry })),
    refusals: refusals.map((entry) => ({ ...entry })),
    startEvidenceSavedAtWrite: startSaved.ok,
  });

  /**
   * Seals the run: the final evidence is saved EXACTLY ONCE, with no database work and no retry, and its result — together with the
   * start save — decides the verdict. A run is `completed_clean` only if the database cleanup was confirmed AND both saves succeeded;
   * a poisoned run claims its evidence was preserved only if the final file was really saved. The saved file records the DATABASE
   * outcome (a fact it can state); the verdict about the evidence itself is decided after the save and lives in the returned report.
   */
  function seal(body: Record<string, unknown>, databaseOutcome: DatabaseOutcome): Record<string, unknown> {
    const saved = safeSave("final", { ...body, databaseOutcome });
    const verdict = verdictFor(databaseOutcome, startSaved.ok, saved.ok);
    if (databaseOutcome === "cleanup_confirmed") state = verdict === "completed_clean" ? "COMPLETED_CLEAN" : "COMPLETED_NOT_EVIDENCED";
    finalReport = {
      ...body,
      databaseOutcome,
      outcome: verdict,
      evidence: { start: startSaved.ok ? { saved: true } : { saved: false, reason: startSaved.reason }, final: saved.ok ? { saved: true } : { saved: false, reason: saved.reason } },
    };
    return finalReport;
  }

  async function finish(): Promise<Record<string, unknown>> {
    if (finalReport) return finalReport;
    if (state === "NOT_STARTED" || state === "REFUSED") {
      return seal({ ...baseReport(), cleanup: "none was needed or attempted", residue: "no write was made" }, "refused_before_any_write");
    }
    const allDone = expectedCases.every((entry) => completed.includes(entry.id));
    if (state === "POISONED" || !allDone) {
      poison(poisonReason ?? "not every expected case completed");
      return seal(
        {
          ...baseReport(),
          cleanup: "NOT attempted: a poisoned run keeps everything it wrote",
          residue: "unknown; investigate the branch read-only; the branch must not be reused",
          runOwnedPublicValues: publicRows.list(),
          scratchSchema: schema,
          action: "Inspect the disposable branch read-only. Do not rerun on it. Do not repair by deleting anything.",
          outstandingOperations: outstanding.size,
        },
        "poisoned",
      );
    }

    state = "CLEANUP";
    cleanupStartedAt = Date.now();
    let cleanupSteps = 0;
    const cleanup: Record<string, unknown> = {};
    let confirmed = false;
    try {
      const values = publicRows.list();
      if (values.length > 0) {
        const deleted = (await exec(S.publicDelete(values))).map((row) => String(row.challenge));
        check(deleted.every((value) => values.includes(value)), "cleanup deleted a value this run did not register");
        cleanup.publicRowsDeleted = deleted.length;
        cleanupSteps += 1;
      }
      const residue = Number(one(await exec(S.publicCount()), "residue").n);
      cleanup.publicRowsRemaining = residue;
      check(residue === 0, `cleanup: ${residue} rows remain in public.webauthn_challenges after the exact-value delete; they are NOT this run's and nothing further was deleted`);
      const gateForPlan = { active: () => state === "CLEANUP", q: async (text: string, params?: unknown[]) => exec(S.ownership(text, params ?? [])) };
      const ran = await runCleanupPlan(ownership, gateForPlan, account, () => outstanding.size);
      const summary = summarizeCleanup(ran);
      cleanup.scratch = { status: summary.status, steps: summary.steps, stopped: ran.stopped, refusal: ran.refusal };
      cleanupSteps += ran.steps.length;
      check(cleanupSteps <= CEILINGS.cleanupStatements, "cleanup exceeded its statement ceiling");
      check(summary.status === "confirmed", "the scratch cleanup was not fully confirmed");
      const schemasAfter = (await exec(S.schemas())).map((row) => String(row.name));
      cleanup.schemasMatchBaseline = same(schemasAfter, baselineSchemas);
      check(cleanup.schemasMatchBaseline === true, "the schema list after cleanup differs from the baseline");
      confirmed = true;
    } catch (error) {
      cleanup.error = error instanceof HarnessFailure ? error.message : "an unexpected error";
      poison(`cleanup: ${String(cleanup.error)}`);
    }
    if (!confirmed) state = "COMPLETED_NOT_CLEAN";
    return seal(
      {
        ...baseReport(),
        cleanup,
        residue: confirmed ? "zero residue confirmed: public.webauthn_challenges is empty again and the scratch schema is gone" : "NOT confirmed; inspect read-only; do not reuse the branch",
        runOwnedPublicValues: publicRows.list(),
        scratchSchema: schema,
        branchDeletion: "never performed by this harness",
      },
      confirmed ? "cleanup_confirmed" : "cleanup_not_confirmed",
    );
  }

  return {
    runPreflight,
    runCase,
    finish,
    poison,
    afterCase: (failed: boolean) => {
      if (failed) poison("the test runner reported a failed case");
    },
    state: () => state,
    poisonReason: () => poisonReason,
    stats: () => ({ operations, writes, scratchRowsCreated, publicCreates, maxInFlight, uncertain: [...uncertain], completed: [...completed], publicRows: publicRows.list(), startSaved }),
    publicRows,
    S,
    ownership,
    schema,
    adapterSql,
  };
}
type PlanNode = { "Node Type"?: string; "Relation Name"?: string; "Index Name"?: string; "Plan Rows"?: number; Operation?: string; Plans?: PlanNode[] };
type Session = ReturnType<typeof createSession>;

// ------------------------------------------------------------------------------------------------ authorization

type IdentityInfo = { digest: string; parts: Record<string, string> };
/** The audited code a confirmation covers: this file, the production create/consume source, schema.sql's table, and every shared helper. */
function neonClientWiring(storeText: string): string {
  const constant = /export const NEON_TRANSACTION_ISOLATION_LEVEL = [^\n]*\n/.exec(storeText)?.[0];
  const start = storeText.indexOf("export function createNeonSqlClient(");
  const end = storeText.indexOf("\n}\n", start);
  if (!constant || start < 0 || end < 0) throw new Error("challenge purge proof: the Neon client wiring was not found in neon-store.ts");
  return `${constant}${storeText.slice(start, end + 3)}`;
}
function neonDriverVersion(packageJson: string): string {
  const version = (JSON.parse(packageJson) as { version?: unknown }).version;
  if (typeof version !== "string" || version === "") throw new Error("challenge purge proof: the Neon driver's version could not be read");
  return version;
}
function computeIdentity(read: (file: string) => string): IdentityInfo {
  const store = read(STORE_PATH);
  const start = store.indexOf("export function createNeonChallengeStore(");
  const end = store.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw new Error("challenge purge proof: createNeonChallengeStore was not found");
  const schemaText = read(SCHEMA_PATH);
  const ddl = scratchDdl(schemaText, "pb_smoke_00000000_main");
  const parts: Record<string, string> = {
    thisFile: sha256Hex(read(SMOKE_FILE)),
    challengeStoreAdapter: sha256Hex(store.slice(start, end + 3)),
    challengeStoreModule: sha256Hex(read(CHALLENGE_STORE_PATH)),
    schemaTable: sha256Hex(`${ddl.table}|${ddl.index}`),
    // L-2: the Neon client wiring the live driver is built from (the isolation constant and createNeonSqlClient), and the driver's version.
    neonClientWiring: sha256Hex(neonClientWiring(store)),
    neonDriverVersion: sha256Hex(neonDriverVersion(read(NEON_DRIVER_PACKAGE))),
    ...Object.fromEntries(Object.entries(HELPER_FILES).map(([name, file]) => [name, sha256Hex(read(file))])),
  };
  return { parts, digest: sha256Hex(JSON.stringify(parts)) };
}

const RUN_ID_SHAPE = /^[0-9a-f]{8}$/;
const BRANCH_ID_SHAPE = /^br-[a-z0-9]+(-[a-z0-9]+)+$/;
const ENDPOINT_ID_SHAPE = /^ep-[a-z0-9]+(-[a-z0-9]+)+$/;
const HOST_SHAPE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** The operator's confirmation for ONE run: bound to the audited code, the endpoint, branch, parent, host, run id and mode. */
function expectedConfirmation(identity: IdentityInfo, t: { runId: string; endpointId: string; branchId: string; parentBranchId: string; hostname: string; perf: boolean }): string {
  return `${t.runId}:${sha256Hex(`${identity.digest}|${t.endpointId}|${t.branchId}|${t.parentBranchId}|${t.hostname}|${t.runId}|${t.perf ? "perf" : "base"}`).slice(0, 16)}`;
}

/** Reads the evidence directory. A missing directory is an empty one; nothing is deleted, repaired or written. */
type EvidenceFs = { list(directory: string): string[]; read(file: string): string };
const EVIDENCE_NAME = /^challenge-purge-smoke-[0-9a-f]{8}-(start|final)\.json$/;
/** The size limit, in BYTES (not characters). */
const MAX_EVIDENCE_BYTES = 1_000_000;

/** A file this scanner refuses to read. Its message is authored here and never carries file content or a path. */
class EvidenceRefusal extends Error {}

/**
 * L-C. Reads ONE evidence file safely, metadata first. (1) lstat: a symbolic link, anything that is not a regular file (directory, FIFO, socket,
 * device) and anything over the byte limit is refused BEFORE it is opened or read. (2) The file is then opened with O_NOFOLLOW — appropriate
 * here, and the smallest fix for the check-then-open race: if the path is swapped for a symbolic link after the lstat, the open itself fails
 * (ELOOP) instead of following it — and O_NONBLOCK, so that a FIFO swapped in cannot block the open. (3) fstat on the OPEN descriptor must still
 * be a regular file of the same device and inode, within the limit. (4) At most limit + 1 bytes are read, so an oversized file is never held in
 * memory, and anything over the limit is refused. (5) The bytes must be valid UTF-8. A platform without O_NOFOLLOW refuses (fail closed).
 * `afterInspection` exists only so a test can perform the swap deterministically.
 */
function readEvidenceFile(file: string, afterInspection?: () => void): string {
  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== "number") throw new EvidenceRefusal("this platform cannot open a file without following links");
  const inspected = lstatSync(file);
  if (inspected.isSymbolicLink()) throw new EvidenceRefusal("a symbolic link");
  if (!inspected.isFile()) throw new EvidenceRefusal("not a regular file");
  if (inspected.size > MAX_EVIDENCE_BYTES) throw new EvidenceRefusal("too large");
  afterInspection?.();
  const fd = openSync(file, fsConstants.O_RDONLY | noFollow | (typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new EvidenceRefusal("not a regular file");
    if (opened.dev !== inspected.dev || opened.ino !== inspected.ino) throw new EvidenceRefusal("changed between inspection and open");
    if (opened.size > MAX_EVIDENCE_BYTES) throw new EvidenceRefusal("too large");
    const buffer = Buffer.alloc(MAX_EVIDENCE_BYTES + 1);
    let length = 0;
    for (;;) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
      if (length > MAX_EVIDENCE_BYTES) throw new EvidenceRefusal("too large");
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
    } catch {
      throw new EvidenceRefusal("not valid UTF-8");
    }
  } finally {
    closeSync(fd);
  }
}

/** The evidence directory itself must be a real directory, not a link to somewhere else; a missing one is empty. */
function listEvidenceDirectory(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const inspected = lstatSync(directory);
  if (inspected.isSymbolicLink() || !inspected.isDirectory()) throw new EvidenceRefusal("the evidence directory is not a plain directory");
  return readdirSync(directory);
}
const defaultEvidenceFs: EvidenceFs = { list: listEvidenceDirectory, read: (file) => readEvidenceFile(file) };

/**
 * L-3 / L-C. A reason to refuse, or null. (1) The run id may not appear as a whole hex token in ANY evidence file name here, whichever smoke
 * wrote it (names only; no content is read for this). (2) The branch id may not appear as target.branchId in any earlier challenge-purge
 * evidence. Only this harness's own file names are ever opened, each through the safe reader above; a link, a non-regular file, an oversized,
 * unreadable, non-UTF-8 or unparsable file REFUSES (reuse cannot be ruled out) — nothing is silently skipped, and no refusal carries file content.
 * The ABSENCE of local evidence is NOT proof that a branch is fresh: freshness, parentage, endpoint mapping and disposability remain the
 * operator's own Neon-console preconditions.
 */
function checkEvidenceReuse(input: { runId: string; branchId: string; directory: string; fs: EvidenceFs }): string | null {
  let names: string[];
  try {
    names = input.fs.list(input.directory);
  } catch {
    return "the evidence directory could not be listed (or is not a plain directory), so reuse of a run id or branch cannot be ruled out";
  }
  const token = new RegExp(`(^|[^0-9a-f])${input.runId}([^0-9a-f]|$)`);
  if (names.some((name) => token.test(name))) return "evidence already exists for this run id (in some smoke's file name); a run id is never reused";
  for (const name of names.filter((entry) => EVIDENCE_NAME.test(entry))) {
    let text: string;
    try {
      text = input.fs.read(path.join(input.directory, name));
    } catch (error) {
      if (error instanceof EvidenceRefusal) return `an earlier challenge-purge evidence file was refused (${error.message}), so branch reuse cannot be ruled out`;
      return "an earlier challenge-purge evidence file could not be read or parsed, so branch reuse cannot be ruled out";
    }
    if (Buffer.byteLength(text, "utf8") > MAX_EVIDENCE_BYTES) return "an earlier challenge-purge evidence file is too large to inspect, so branch reuse cannot be ruled out";
    let parsed: { target?: { branchId?: unknown } } | null;
    try {
      parsed = JSON.parse(text) as { target?: { branchId?: unknown } } | null;
    } catch {
      return "an earlier challenge-purge evidence file could not be read or parsed, so branch reuse cannot be ruled out";
    }
    // Every evidence file this harness writes names its branch; one that does not is malformed, and is refused rather than skipped.
    if (typeof parsed?.target?.branchId !== "string") return "an earlier challenge-purge evidence file does not name its branch, so branch reuse cannot be ruled out";
    if (parsed.target.branchId === input.branchId) return "this branch id appears in earlier challenge-purge evidence; a branch is never reused";
  }
  return null;
}

type LiveConfig = { runId: string; url: string; endpointId: string; branchId: string; parentBranchId: string; hostname: string; perf: boolean };
type Authorization = { ok: true; config: LiveConfig } | { ok: false; reason: string };

/** EVERY gate, in order, over plain inputs. Opens nothing, reads nothing, prints nothing. Reasons never echo a supplied value. */
function authorizeLiveRun(input: { env: Record<string, string | undefined>; files: ActiveEnvFiles; cliArgs: unknown; identity: IdentityInfo; evidenceDirectory: string; evidenceFs?: EvidenceFs }): Authorization {
  const { env } = input;
  const refuse = (reason: string): Authorization => ({ ok: false, reason });
  if (env[GATE] !== "1") return refuse(`${GATE} is not exactly "1"`);
  const selection = checkExactFileSelection(input.cliArgs, SMOKE_FILE);
  if (!selection.ok) return refuse(selection.reason);
  const timeouts = checkRunnerTimeoutFlags(input.cliArgs);
  if (!timeouts.ok) return refuse(timeouts.reason);
  const runId = env[ENV.runId];
  if (runId === undefined || !RUN_ID_SHAPE.test(runId)) return refuse(`${ENV.runId} must be exactly 8 lowercase hex characters`);
  if ((KNOWN_SPENT_RUN_IDS as readonly string[]).includes(runId)) return refuse(`${ENV.runId} names a run id that an earlier smoke already spent`);
  const branchId = env[ENV.branch];
  const parentBranchId = env[ENV.parent];
  if (branchId === undefined || !BRANCH_ID_SHAPE.test(branchId)) return refuse(`${ENV.branch} must be a well-formed branch id (br-...)`);
  if (parentBranchId === undefined || !BRANCH_ID_SHAPE.test(parentBranchId)) return refuse(`${ENV.parent} must be a well-formed parent branch id (br-...)`);
  if (branchId === parentBranchId) return refuse("the branch id and its parent branch id must differ");
  const reuse = checkEvidenceReuse({ runId, branchId, directory: input.evidenceDirectory, fs: input.evidenceFs ?? defaultEvidenceFs });
  if (reuse !== null) return refuse(reuse);
  const endpointId = env[EXPECTED_ENDPOINT_ENV];
  if (endpointId === undefined || !ENDPOINT_ID_SHAPE.test(endpointId)) return refuse(`${EXPECTED_ENDPOINT_ENV} must be a well-formed endpoint id (ep-...)`);
  const expectedHost = env[ENV.host];
  if (expectedHost === undefined || !HOST_SHAPE.test(expectedHost)) return refuse(`${ENV.host} must be the exact pooled hostname, in lower case`);
  const perfValue = env[ENV.perf];
  if (perfValue !== undefined && perfValue !== "" && perfValue !== "1") return refuse(`${ENV.perf} must be unset or exactly "1"`);
  const perf = perfValue === "1";
  let url: string;
  try {
    url = confirmedDisposableTargetUrl({ env, ...input.files, gate: GATE, allowedGates: ALLOWED_GATES }, "challenge purge proof refused to connect");
  } catch (error) {
    return refuse(error instanceof Error ? error.message : "the target check failed");
  }
  const parsed = parseDatabaseUrl(url, false);
  if (!parsed.ok) return refuse("the target URL could not be read");
  if (parsed.hostname !== expectedHost) return refuse(`the connection hostname does not equal ${ENV.host}`);
  if (parsed.endpoint !== endpointId) return refuse(`the connection endpoint does not equal ${EXPECTED_ENDPOINT_ENV}`);
  const mode = requirePooledMode(parsed);
  if (!mode.ok) return refuse(mode.reason);
  const budget = planBudget(perf);
  if (!budget.ok) return refuse(`the planned budget exceeds a ceiling: ${budget.violations.join("; ")}`);
  const confirm = env[ENV.confirm];
  if (confirm === undefined || confirm === "") return refuse(`${ENV.confirm} is not set (the operator's separate confirmation for this run)`);
  const config: LiveConfig = { runId, url, endpointId, branchId, parentBranchId, hostname: parsed.hostname, perf };
  if (confirm !== expectedConfirmation(input.identity, config)) return refuse(`${ENV.confirm} does not match this run id, target, mode, and source identity`);
  return { ok: true, config };
}

const TARGET_PROOF_STATUS = "the connection URL, the operator-supplied endpoint, host, branch id and parent branch id agreed with each other and with the confirmation before any connection; NONE of this proves the branch is new, disposable or a child of the named parent, which rests on the operator's separate console evidence";

/** Evidence: a new owner-only file, never overwritten, never holding a connection string or an endpoint id. */
function writeEvidence(directory: string, runId: string, stage: "start" | "final", evidence: Record<string, unknown>): EvidenceSave {
  const json = safeEvidenceJson(evidence);
  if (json === null) return { ok: false, reason: "the content screen refused the evidence" };
  const file = path.join(directory, `challenge-purge-smoke-${runId}-${stage}.json`);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if ((statSync(directory).mode & 0o077) !== 0) return { ok: false, reason: "the evidence directory is not private" };
    writeFileSync(file, json, { flag: "wx", mode: 0o600 });
    if ((statSync(file).mode & 0o777) !== 0o600) return { ok: false, reason: "the evidence file mode is not 0600" };
  } catch (error) {
    return { ok: false, reason: String((error as { code?: unknown } | null)?.code ?? "write failed").slice(0, 24) };
  }
  return { ok: true };
}

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

// ------------------------------------------------------------------------------------------------ offline: the emulator (NOT PostgreSQL)

type EmulatorOptions = { hold?: { text: string; until: Promise<void> }; failOn?: { startsWith: string; code: string }; stallOn?: { startsWith: string }; onlyFor?: { prefix: string; limit?: number; reachLive?: boolean }; limit?: number; skipLocked?: boolean; strictLess?: boolean; deleteLive?: boolean; newestFirst?: boolean; initialPublicRows?: number; stallWrites?: boolean; sleepMsPerSecond?: number };
/** Microseconds since the epoch as a number (about 1.8e15, safely inside 2^53). */
const micros = (iso: string): number => Date.parse(`${iso.slice(0, 19)}Z`) * 1000 + Math.round(Number(`0.${iso.slice(20, -1)}`) * 1e6);

/** An in-process stand-in that speaks the harness's templates. It proves the harness would notice a wrong purge; it proves nothing about PostgreSQL. */
function createEmulator(schema: string, runId: string, production: CapturedSql, ddl: ScratchDdl, options: EmulatorOptions = {}) {
  const X = scratchTexts(schema, runId, production.create, ddl);
  const limit = options.limit ?? PURGE_BOUND;
  const scratch = new Map<string, { purpose: string; expires: number; order: number }>();
  const publicTable = new Map<string, { purpose: string; context: string | null; expires: number; createdMs: number }>();
  for (let i = 0; i < (options.initialPublicRows ?? 0); i += 1) publicTable.set(`inherited-${i}`, { purpose: "login", context: null, expires: 0, createdMs: 0 });
  const locked = new Set<string>();
  let holders = 0;
  let seq = 0;
  let schemaExists = false;
  let tableExists = false;
  const calls: string[] = [];
  const sorted = <T extends { expires: number; order: number }>(rows: Array<[string, T]>) => rows.sort((a, b) => (a[1].expires === b[1].expires ? a[1].order - b[1].order : a[1].expires < b[1].expires ? -1 : 1));
  const purge = (table: Map<string, { expires: number }>, cutoff: number, respectLocks: boolean, mutate: boolean, forced: { limit?: number; reachLive?: boolean } | null = null) => {
    const withOrder = [...table.entries()].map(([name, row]) => [name, { expires: row.expires, order: (row as { order?: number }).order ?? 0 }] as [string, { expires: number; order: number }]);
    // The wrong-purge mutants apply to the scratch table only, so each one fails exactly the case that targets it.
    const eligible = forced?.reachLive ? sorted(withOrder).reverse() : mutate && options.deleteLive ? withOrder.sort((a, b) => a[1].order - b[1].order) : sorted(withOrder.filter(([, row]) => (mutate && options.strictLess === false ? row.expires <= cutoff : row.expires < cutoff)));
    if (mutate && options.newestFirst) eligible.reverse();
    const chosen = eligible.filter(([name]) => !(respectLocks && locked.has(name))).slice(0, forced?.limit ?? (mutate ? limit : PURGE_BOUND));
    for (const [name] of chosen) table.delete(name);
    return chosen.length;
  };
  const plan = [{ Plan: { "Node Type": "ModifyTable", Operation: "Insert", "Relation Name": "webauthn_challenges", Plans: [{ "Node Type": "Result" }, { "Node Type": "ModifyTable", Operation: "Delete", "Relation Name": "webauthn_challenges", Plans: [{ "Node Type": "Nested Loop", Plans: [{ "Node Type": "Limit", "Plan Rows": 64, Plans: [{ "Node Type": "LockRows", Plans: [{ "Node Type": "Index Scan", "Index Name": "webauthn_challenges_expires_at_idx" }] }] }] }] }] } }];
  const shape = [["challenge", "text", true, null], ["purpose", "text", true, null], ["context", "jsonb", false, null], ["created_at", "timestamp with time zone", true, "now()"], ["expires_at", "timestamp with time zone", true, null]].map(([name, type, notNull, def]) => ({ name, type, not_null: notNull, default_expr: def }));
  const purposeCheck = `CHECK ((purpose = ANY (ARRAY[${PURPOSES.map((name) => `'${name}'::text`).join(", ")}])))`;

  const query = async (text: string, params: unknown[]): Promise<Row[]> => {
    calls.push(text);
    // Test controls: hold ONE statement's answer until released, refuse a statement with a SQLSTATE, or never answer it.
    if (options.hold && text === options.hold.text) await options.hold.until;
    if (options.failOn && text.startsWith(options.failOn.startsWith)) throw Object.assign(new Error("emulated refusal"), { code: options.failOn.code });
    if (options.stallOn && text.startsWith(options.stallOn.startsWith)) return new Promise<Row[]>(() => undefined);
    if (options.stallWrites && /^(INSERT|DELETE|CREATE|ANALYZE|DROP|WITH)/.test(text)) return new Promise<Row[]>(() => undefined);
    if (text === TEXT.identity) return [{ database: "emulated", version: "15.0", version_num: 150000, isolation: "read committed", default_isolation: "read committed", in_recovery: false, resolves_to_public: true }];
    if (text === TEXT.publicCount) return [{ n: publicTable.size }];
    if (text === TEXT.shape) return shape;
    if (text === TEXT.indexes) return [{ name: "webauthn_challenges_expires_at_idx", definition: "CREATE INDEX webauthn_challenges_expires_at_idx ON x.webauthn_challenges USING btree (expires_at)" }, { name: "webauthn_challenges_pkey", definition: "CREATE UNIQUE INDEX webauthn_challenges_pkey ON x.webauthn_challenges USING btree (challenge)" }];
    if (text === TEXT.checks) return [{ definition: purposeCheck }];
    if (text === TEXT.schemas) return [{ name: "public" }, ...(schemaExists ? [{ name: schema }] : [])];
    if (text === TEXT.usedTables) return [];
    if (text === TEXT.activitySelf) return [{ n: 1 }];
    if (text === TEXT.holderActive) return [{ n: holders }];
    if (text === X.createSchema) { schemaExists = true; return []; }
    if (text === X.createTable) { tableExists = true; return []; }
    if (text === X.createIndex || text === X.analyze) return [];
    if (text === X.reset) { scratch.clear(); return []; }
    if (text === X.list) return sorted([...scratch.entries()]).map(([challenge, row]) => ({ challenge, purpose: row.purpose }));
    if (text === X.count) return [{ n: scratch.size }];
    if (text === X.seedRows) {
      const [prefix, base, count] = params as [string, string, number];
      for (let n = 1; n <= count; n += 1) scratch.set(`${prefix}${pad4(n)}`, { purpose: PURPOSES[n % 6]!, expires: micros(base) + n * 1_000_000, order: seq++ });
      return [];
    }
    if (text === X.seedOne) {
      const [challenge, purpose, expires] = params as [string, string, string];
      scratch.set(challenge, { purpose, expires: micros(expires), order: seq++ });
      return [];
    }
    if (text === X.purge || text === X.explain) {
      if (text === X.explain) return [{ "QUERY PLAN": plan }];
      const [cutoff, challenge, purpose, , expiresAt] = params as [string, string, string, null, string];
      // A mutation scoped to one prefix misbehaves ONLY for the creates that carry it, so it fails exactly the case that targets it.
      const forced = options.onlyFor && challenge.startsWith(options.onlyFor.prefix) ? options.onlyFor : null;
      purge(scratch as unknown as Map<string, { expires: number }>, micros(cutoff), options.skipLocked !== false, true, forced);
      if (options.skipLocked === false && locked.size > 0) {
        // The emulated "no SKIP LOCKED" statement WAITS for the holder, as a blocking SELECT FOR UPDATE would.
        while (holders > 0) await sleep(5);
      }
      scratch.set(challenge, { purpose, expires: micros(expiresAt), order: seq++ });
      return [];
    }
    if (text === TEXT.publicSeed) {
      const [challenge, purpose, expires] = params as [string, string, string];
      publicTable.set(challenge, { purpose, context: null, expires: micros(expires), createdMs: Date.now() });
      return [];
    }
    if (text === TEXT.publicRow) {
      const row = publicTable.get(params[0] as string);
      return row ? [{ challenge: params[0], purpose: row.purpose, context: row.context, expires_ms: String(Math.floor(row.expires / 1000)) }] : [];
    }
    if (text === TEXT.publicPresent) return (params[0] as string[]).filter((name) => publicTable.has(name)).sort().map((challenge) => ({ challenge }));
    if (text === TEXT.publicDelete) {
      const names = (params[0] as string[]).filter((name) => publicTable.delete(name));
      return names.map((challenge) => ({ challenge }));
    }
    if (text === SCHEMA_INVENTORY_SQL) return tableExists ? [{ kind: "table", name: "webauthn_challenges" }] : [];
    if (text === SCHEMA_EXTERNAL_DEPENDENCIES_SQL) return [{ foreign_keys: 0, triggers: 0, inheritance: 0, view_references: 0 }];
    if (text === `DROP TABLE ${schema}.webauthn_challenges RESTRICT`) { tableExists = false; return []; }
    if (text === `DROP SCHEMA ${schema} RESTRICT`) { schemaExists = false; return []; }
    if (text === SCHEMA_RESIDUE_SQL) return [{ n: schemaExists ? 1 : 0 }];
    throw new Error(`emulator: unrecognized statement ${text.slice(0, 40)}`);
  };

  const adapter = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = normalize(strings.join("$?"));
    calls.push(text);
    if (text === production.create) {
      const [cutoff, challenge, purpose, context, expiresAt] = values as [string, string, string, string | null, string];
      purge(publicTable as unknown as Map<string, { expires: number }>, micros(cutoff), true, false);
      publicTable.set(challenge, { purpose, context, expires: micros(expiresAt), createdMs: Date.now() });
      return Promise.resolve([]);
    }
    if (text === production.consume) {
      const row = publicTable.get(values[0] as string);
      publicTable.delete(values[0] as string);
      return Promise.resolve(row ? [{ purpose: row.purpose, context: row.context, created_at: new Date(row.createdMs).toISOString(), expires_at: new Date(Math.floor(row.expires / 1000)).toISOString() }] : []);
    }
    return Promise.reject(new Error("emulator: unrecognized adapter statement"));
  }) as unknown as NeonQueryFunction<false, false>;

  const driver: Driver = {
    query,
    transaction: async (statements) => {
      calls.push("transaction");
      const ids = statements[1]!.params[0] as string[];
      const seconds = statements[2]!.params[0] as number;
      for (const id of ids) locked.add(id);
      holders += 1;
      await sleep(seconds * (options.sleepMsPerSecond ?? 20));
      holders -= 1;
      for (const id of ids) locked.delete(id);
      return statements.map(() => []);
    },
    adapter,
  };
  return { driver, calls, scratch, publicTable, state: () => ({ schemaExists, tableExists }) };
}

const FAST_TIMING: Timing = { statementDeadlineMs: 1_500, caseDeadlineMs: 6_000, cleanupDeadlineMs: 3_000, runDeadlineMs: 20_000, pollMs: 5, holderSleepSeconds: 15, holderWaitMs: 800, maxCreateElapsedMs: 5_000 };
const SYNTHETIC_RUN = "0a1b2c3d";

// ------------------------------------------------------------------------------------------------ offline tests (always run)

describe("challenge purge proof harness — offline (no database, no network)", () => {
  const schemaText = readFileSync(SCHEMA_PATH, "utf8");
  const schemaName = `pb_smoke_${SYNTHETIC_RUN}_main`;
  const ddl = scratchDdl(schemaText, schemaName);
  let production: CapturedSql;
  beforeAll(async () => {
    production = await captureProductionSql();
  });
  type SaveStub = (stage: "start" | "final", evidence: Record<string, unknown>) => EvidenceSave;
  const newSession = async (options: EmulatorOptions, perf = false, timing: Timing = FAST_TIMING, saveStub?: SaveStub) => {
    const emulator = createEmulator(schemaName, SYNTHETIC_RUN, production, ddl, options);
    const saved: Array<{ stage: string; evidence: Record<string, unknown>; callsAtSave: number }> = [];
    const session = createSession({
      runId: SYNTHETIC_RUN,
      driver: emulator.driver,
      timing,
      perf,
      production,
      ddl,
      target: { synthetic: true },
      provenance: { synthetic: true },
      save: (stage, evidence) => {
        saved.push({ stage, evidence, callsAtSave: emulator.calls.length });
        return saveStub ? saveStub(stage, evidence) : { ok: true };
      },
    });
    return { emulator, session, saved };
  };
  const runAll = async (session: Session, perf: boolean) => {
    await session.runPreflight();
    for (const entry of CASES.filter((candidate) => perf || candidate.optional !== "perf")) await session.runCase(entry.id);
    return session.finish();
  };

  it("INERT BY DEFAULT: with the gate unset nothing connected, and the live suite is skipped", () => {
    if (!enabled) expect(connectionAttempts).toBe(0);
    expect(process.env[GATE] === "1").toBe(enabled);
    const source = readFileSync(SMOKE_FILE, "utf8");
    expect(source).toContain("describe.skipIf(!enabled)(");
    // The one place a connection can be opened is openLiveDriver, called only from the live suite's beforeAll.
    expect(source.match(/= createNeonSqlClient\(/g)).toHaveLength(1); // the one call site is inside openLiveDriver
    expect([...source.matchAll(/openLiveDriver\(/g)]).toHaveLength(2); // its definition and its single call, in the live suite's beforeAll
    expect(source).not.toMatch(/\b(it|describe|test)\.(only|skip|todo|fails)\b/);
  });

  it("the audited production statements are exactly the pinned references", async () => {
    expect(checkProductionSql(production)).toEqual({ ok: true });
    expect(production.create).toContain("LIMIT 64 FOR UPDATE SKIP LOCKED");
    expect(checkProductionSql({ ...production, create: production.create.replace("LIMIT 64", "LIMIT 65") }).ok).toBe(false);
    expect(checkProductionSql({ ...production, consume: production.consume.replace("WHERE challenge", "WHERE true OR challenge") }).ok).toBe(false);
  });

  it("the scratch statement differs from production ONLY by numbered placeholders and the schema qualification, and it names no public object", () => {
    const text = scratchPurgeText(production.create, schemaName);
    expect(unqualify(text, schemaName)).toBe(production.create);
    expect(text.match(new RegExp(`${schemaName}\\.webauthn_challenges`, "g"))).toHaveLength(3);
    expect(text).not.toMatch(/public/);
    expect(text).toMatch(/\$1 ORDER BY p\.expires_at LIMIT 64 FOR UPDATE SKIP LOCKED/);
    expect(text).toMatch(/VALUES \(\$2, \$3, \$4, \$5\)$/);
    expect(normalize(`EXPLAIN (FORMAT JSON) ${text}`)).not.toMatch(/ANALYZE/i);
  });

  it("the scratch DDL comes from schema.sql, is a plain CREATE (never IF NOT EXISTS), is fully qualified, and keeps all six purposes", () => {
    expect(ddl.table).toMatch(new RegExp(`^CREATE TABLE ${schemaName}\\.webauthn_challenges \\(`));
    expect(ddl.table).not.toMatch(/IF NOT EXISTS|public/);
    for (const purpose of PURPOSES) expect(ddl.table).toContain(`'${purpose}'`);
    expect(ddl.index).toBe(`CREATE INDEX webauthn_challenges_expires_at_idx ON ${schemaName}.webauthn_challenges (expires_at)`);
    expect(() => scratchDdl("CREATE TABLE something_else ();", schemaName)).toThrow(/no longer has the expected/);
  });

  it("the budget is within every ceiling in both modes, the public rows are at most 10, and PERF stays within 5,000 rows", () => {
    for (const perf of [false, true]) {
      const plan = planBudget(perf);
      expect(plan.violations).toEqual([]);
      expect(plan.totals.publicRows).toBeLessThanOrEqual(10);
      expect(plan.totals.scratchRows).toBeLessThanOrEqual(6_000);
      expect(plan.totals.concurrent).toBeLessThanOrEqual(8);
    }
    expect(planBudget(false).totals.scratchRows).toBeLessThan(1_500);
    expect(planBudget(true).totals.perfScratchRows).toBeLessThanOrEqual(5_000);
    expect(CEILINGS.concurrency).toBeLessThanOrEqual(16);
    expect(planBudget(true, [{ ...CASES[0]!, publicRows: 11 }]).ok).toBe(false);
    expect(planBudget(true, [{ ...CASES[0]!, scratchRows: 6_001 }]).ok).toBe(false);
    expect(planBudget(true, [{ ...CASES[0]!, concurrent: 9 }]).ok).toBe(false);
    expect(CASES.map((entry) => entry.id)).toEqual(["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "PERF"]);
  });

  describe("authorization gates (synthetic values; nothing is read from the environment or the repository's env files)", () => {
    const real = "postgres://u:p@ep-real-thing-111111.us-east-2.aws.neon.tech/neondb?sslmode=require";
    const files: ActiveEnvFiles = { envLocalText: `DATABASE_URL=${real}\n`, otherEnvFiles: {} };
    const hostname = "ep-cool-branch-222222-pooler.us-east-2.aws.neon.tech";
    const url = `postgres://u:p@${hostname}/neondb?sslmode=require`;
    const identity: IdentityInfo = computeIdentity((file) => readFileSync(file, "utf8"));
    const target = { runId: "5e6f7a8b", endpointId: "ep-cool-branch-222222", branchId: "br-new-branch-111111", parentBranchId: "br-parent-branch-222222", hostname, perf: false };
    const good = (): Record<string, string | undefined> => ({
      [GATE]: "1",
      NEON_BRANCH_DATABASE_URL: url,
      [EXPECTED_ENDPOINT_ENV]: target.endpointId,
      [ENV.runId]: target.runId,
      [ENV.branch]: target.branchId,
      [ENV.parent]: target.parentBranchId,
      [ENV.host]: hostname,
      [ENV.confirm]: expectedConfirmation(identity, target),
    });
    const argv = ["run", SMOKE_FILE];
    const emptyEvidenceFs: EvidenceFs = { list: () => [], read: () => "" };
    const authorize = (env: Record<string, string | undefined>, overrides: Partial<Parameters<typeof authorizeLiveRun>[0]> = {}) => authorizeLiveRun({ env, files, cliArgs: argv, identity, evidenceDirectory: "evidence", evidenceFs: emptyEvidenceFs, ...overrides });
    const refusalFor = (mutate: (env: Record<string, string | undefined>) => void, overrides: Partial<Parameters<typeof authorizeLiveRun>[0]> = {}) => {
      const env = good();
      mutate(env);
      const result = authorize(env, overrides);
      expect(result.ok, "must refuse").toBe(false);
      return result.ok ? "" : result.reason;
    };

    it("accepts a complete, consistent authorization and nothing less", () => {
      const result = authorize(good());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.config).toMatchObject({ runId: target.runId, branchId: target.branchId, parentBranchId: target.parentBranchId, hostname, perf: false });
    });

    it("refuses each missing, malformed or mismatched gate", () => {
      expect(refusalFor((env) => { delete env[GATE]; })).toMatch(/not exactly "1"/);
      expect(refusalFor((env) => { env[GATE] = "true"; })).toMatch(/not exactly "1"/);
      expect(refusalFor(() => undefined, { cliArgs: ["run", SMOKE_FILE, "-t", "P2"] })).toMatch(/exact path/);
      expect(refusalFor(() => undefined, { cliArgs: ["run", SMOKE_FILE, "--testTimeout=30000"] })).toMatch(/at least/);
      expect(refusalFor(() => undefined, { cliArgs: ["run", "test/lib/real/other.test.ts"] })).toMatch(/exact path/);
      expect(refusalFor((env) => { delete env[ENV.runId]; })).toMatch(/8 lowercase hex/);
      expect(refusalFor((env) => { env[ENV.runId] = "ced714ee"; })).toMatch(/already spent/);
      expect(refusalFor(() => undefined, { evidenceFs: { list: () => [`challenge-purge-smoke-${target.runId}-start.json`], read: () => "{}" } })).toMatch(/evidence already exists/);
      expect(refusalFor((env) => { delete env[ENV.branch]; })).toMatch(/branch id/);
      expect(refusalFor((env) => { env[ENV.parent] = env[ENV.branch]; })).toMatch(/must differ/);
      expect(refusalFor((env) => { env[ENV.parent] = "main"; })).toMatch(/parent branch id/);
      expect(refusalFor((env) => { delete env[EXPECTED_ENDPOINT_ENV]; })).toMatch(/endpoint id/);
      expect(refusalFor((env) => { env[EXPECTED_ENDPOINT_ENV] = "ep-other-branch-333333"; })).toMatch(/does not match|endpoint/);
      expect(refusalFor((env) => { delete env[ENV.host]; })).toMatch(/hostname/);
      expect(refusalFor((env) => { env[ENV.host] = "ep-cool-branch-222222-pooler.eu-west-1.aws.neon.tech"; })).toMatch(/hostname does not equal/);
      expect(refusalFor((env) => { delete env.NEON_BRANCH_DATABASE_URL; })).toMatch(/refused to connect/);
      expect(refusalFor((env) => { env.DATABASE_URL = real; })).toMatch(/DATABASE_URL is exported/);
      expect(refusalFor((env) => { env.REAL_SMOKE_RATE_LIMIT = "1"; })).toMatch(/unrelated smoke gate/);
      expect(refusalFor((env) => { env.REAL_ADMIN_TOKEN = "x"; })).toMatch(/admin gate/);
      expect(refusalFor((env) => { env.NEON_BRANCH_DATABASE_URL = real; env[EXPECTED_ENDPOINT_ENV] = "ep-real-thing-111111"; env[ENV.host] = "ep-real-thing-111111.us-east-2.aws.neon.tech"; })).toMatch(/real database/);
      expect(refusalFor((env) => { env.NEON_BRANCH_DATABASE_URL = url.replace("-pooler", ""); env[ENV.host] = hostname.replace("-pooler", ""); })).toMatch(/POOLED/);
      expect(refusalFor((env) => { delete env[ENV.confirm]; })).toMatch(/not set/);
      expect(refusalFor((env) => { env[ENV.confirm] = `${target.runId}:0000000000000000`; })).toMatch(/does not match/);
    });

    it("binds the confirmation to every input: run id, endpoint, branch, parent, host, source digest, and mode", () => {
      const base = expectedConfirmation(identity, target);
      for (const changed of [{ runId: "5e6f7a8c" }, { endpointId: "ep-cool-branch-222223" }, { branchId: "br-new-branch-111112" }, { parentBranchId: "br-parent-branch-222223" }, { hostname: "x.example" }, { perf: true }]) expect(expectedConfirmation(identity, { ...target, ...changed })).not.toBe(base);
      expect(expectedConfirmation({ ...identity, digest: sha256Hex("other") }, target)).not.toBe(base);
      // A base confirmation cannot enable the optional PERF case, and a bad value for the flag is refused outright.
      expect(refusalFor((env) => { env[ENV.perf] = "1"; })).toMatch(/does not match/);
      expect(refusalFor((env) => { env[ENV.perf] = "yes"; })).toMatch(/unset or exactly "1"/);
      const perfEnv = good();
      perfEnv[ENV.perf] = "1";
      perfEnv[ENV.confirm] = expectedConfirmation(identity, { ...target, perf: true });
      const perfResult = authorize(perfEnv);
      expect(perfResult.ok && perfResult.config.perf).toBe(true);
    });

    it("the identity covers this file, the production adapter, challenge-store.ts, the schema table, and every imported helper", () => {
      expect(Object.keys(identity.parts).sort()).toEqual(["challengeStoreAdapter", "challengeStoreModule", "handlesSmokeDb", "loginChallengeUsesSmoke", "neonClientWiring", "neonDriverVersion", "providerBudgetSmoke", "provisioningLimitsSmoke", "registrationAdmissionSmoke", "schemaTable", "smokeRunIds", "thisFile", "vitestConfig"]);
      const changed = computeIdentity((file) => (file === SMOKE_FILE ? `${readFileSync(file, "utf8")}\n// changed` : readFileSync(file, "utf8")));
      expect(changed.digest).not.toBe(identity.digest);
      const adapterChanged = computeIdentity((file) => (file === STORE_PATH ? readFileSync(file, "utf8").replace("LIMIT 64", "LIMIT 65") : readFileSync(file, "utf8")));
      expect(adapterChanged.parts.challengeStoreAdapter).not.toBe(identity.parts.challengeStoreAdapter);
    });

    it("L-2: a change to the Neon client wiring, the driver version, smoke-run-ids.ts or vitest.config.mts changes the digest AND voids a confirmation printed earlier", () => {
      const original = (file: string) => readFileSync(file, "utf8");
      const mutations: Array<[string, (file: string) => string]> = [
        ["the Neon isolation constant", (file) => (file === STORE_PATH ? original(file).replace('NEON_TRANSACTION_ISOLATION_LEVEL = "ReadCommitted"', 'NEON_TRANSACTION_ISOLATION_LEVEL = "Serializable"') : original(file))],
        ["createNeonSqlClient", (file) => (file === STORE_PATH ? original(file).replace("return neon(databaseUrl, { isolationLevel: NEON_TRANSACTION_ISOLATION_LEVEL });", "return neon(databaseUrl, { isolationLevel: NEON_TRANSACTION_ISOLATION_LEVEL, fullResults: false });") : original(file))],
        ["the installed driver version", (file) => (file === NEON_DRIVER_PACKAGE ? JSON.stringify({ ...(JSON.parse(original(file)) as object), version: "9.9.9" }) : original(file))],
        ["smoke-run-ids.ts", (file) => (file === HELPER_FILES.smokeRunIds ? `${original(file)}\n// changed` : original(file))],
        ["vitest.config.mts", (file) => (file === HELPER_FILES.vitestConfig ? `${original(file)}\n// changed` : original(file))],
      ];
      for (const [name, read] of mutations) {
        const changed = computeIdentity(read);
        expect(changed.digest, name).not.toBe(identity.digest);
        const verdict = authorize(good(), { identity: changed });
        expect(verdict.ok, `${name}: a confirmation printed for the earlier code must not authorize this code`).toBe(false);
        if (!verdict.ok) expect(verdict.reason, name).toMatch(/does not match/);
      }
      // Specificity: a function elsewhere in neon-store.ts is not part of the wiring or the adapter, so it changes neither.
      const unrelated = computeIdentity((file) => (file === STORE_PATH ? original(file).replace("export function createNeonRealAccountRegistry(", "export function createNeonRealAccountRegistry (") : original(file)));
      expect(unrelated.digest).toBe(identity.digest);
      expect(() => neonClientWiring("no wiring here")).toThrow(/wiring was not found/);
      expect(() => neonDriverVersion("{}")).toThrow(/version could not be read/);
    });

    it("L-3: a run id in ANY evidence file name, or a branch id in earlier challenge-purge evidence, is refused; unreadable evidence is refused; absence proves nothing", () => {
      const named = (...names: string[]): Partial<Parameters<typeof authorizeLiveRun>[0]> => ({ evidenceFs: { list: () => names, read: () => JSON.stringify({ target: { branchId: "br-some-other-branch-999999" } }) } });
      const reasonFor = (overrides: Partial<Parameters<typeof authorizeLiveRun>[0]>) => {
        const result = authorize(good(), overrides);
        expect(result.ok, "must refuse").toBe(false);
        return result.ok ? "" : result.reason;
      };
      expect(reasonFor(named(`provider-budget-smoke-${target.runId}-start.json`))).toMatch(/run id/);
      expect(reasonFor(named(`login-challenge-uses-smoke-${target.runId}-final.json`))).toMatch(/run id/);
      expect(reasonFor(named(`challenge-purge-smoke-${target.runId}-start.json`))).toMatch(/run id/);
      expect(reasonFor(named(`some_${target.runId}.json`))).toMatch(/run id/);
      // The match is on a whole hex token: a longer hex run that merely CONTAINS the id is a different id.
      expect(authorize(good(), named(`note-${target.runId}c-start.json`)).ok).toBe(true);
      expect(authorize(good(), named("unrelated.txt", "challenge-purge-smoke-aaaaaaaa-start.json")).ok).toBe(true);
      // Branch reuse, from this harness's own earlier evidence.
      const earlier = (branchId: unknown) => ({ evidenceFs: { list: () => ["challenge-purge-smoke-aaaaaaaa-start.json"], read: () => JSON.stringify({ target: { branchId } }) } });
      expect(reasonFor(earlier(target.branchId))).toMatch(/branch id appears in earlier/);
      expect(authorize(good(), earlier("br-some-other-branch-999999")).ok).toBe(true);
      // Anything that cannot be inspected safely refuses (reuse cannot be ruled out).
      expect(reasonFor({ evidenceFs: { list: () => ["challenge-purge-smoke-aaaaaaaa-final.json"], read: () => "not json" } })).toMatch(/could not be read or parsed/);
      expect(reasonFor({ evidenceFs: { list: () => ["challenge-purge-smoke-aaaaaaaa-final.json"], read: () => { throw new Error("EACCES"); } } })).toMatch(/could not be read or parsed/);
      expect(reasonFor({ evidenceFs: { list: () => ["challenge-purge-smoke-aaaaaaaa-final.json"], read: () => " ".repeat(MAX_EVIDENCE_BYTES + 1) } })).toMatch(/too large/);
      expect(reasonFor({ evidenceFs: { list: () => { throw new Error("EACCES"); }, read: () => "{}" } })).toMatch(/could not be listed/);
      // Only this harness's own file names are ever read; nothing else in the directory is opened.
      const opened: string[] = [];
      authorize(good(), { evidenceFs: { list: () => ["credentials.env", "provider-budget-smoke-aaaaaaaa-start.json", ".env.local", "challenge-purge-smoke-aaaaaaaa-start.json"], read: (file) => (opened.push(path.basename(file)), JSON.stringify({ target: { branchId: "br-x-1" } })) } });
      expect(opened).toEqual(["challenge-purge-smoke-aaaaaaaa-start.json"]);
      // The interface offers listing and reading only: nothing in this guard can delete, repair or overwrite evidence.
      expect(Object.keys(defaultEvidenceFs).sort()).toEqual(["list", "read"]);
      // A missing evidence directory is an empty one, which is NOT evidence that a branch is fresh (that stays the operator's Neon-console precondition).
      expect(defaultEvidenceFs.list("this-evidence-directory-does-not-exist")).toEqual([]);
    });

    describe("L-C: evidence scanning is metadata-first, link-safe, byte-bounded and fail-closed (temporary fixtures only; no real evidence or credential is read)", () => {
      // Created in beforeAll, not at collection time, so a filtered run (which skips these tests and their afterAll) creates nothing to leak.
      let root = "";
      let decoy = "";
      beforeAll(() => {
        root = mkdtempSync(path.join(tmpdir(), "cps-scan-"));
        decoy = path.join(root, "decoy.json");
        writeFileSync(decoy, evidence("br-decoy-branch-000001"));
      });
      let counter = 0;
      const fresh = (): string => {
        counter += 1;
        const dir = path.join(root, `d${counter}`);
        mkdirSync(dir);
        return dir;
      };
      const NAME = "challenge-purge-smoke-aaaaaaaa-start.json";
      const evidence = (branchId: string, pad = 0): string => JSON.stringify({ target: { branchId }, pad: "x".repeat(pad) });
      const scan = (dir: string) => authorize(good(), { evidenceDirectory: dir, evidenceFs: defaultEvidenceFs });
      const refusal = (dir: string): string => {
        const result = scan(dir);
        expect(result.ok, "must refuse").toBe(false);
        return result.ok ? "" : result.reason;
      };
      // `decoy` (set above) is an outside file a link could point at: well-formed, naming a DIFFERENT branch, so following it would look harmless.
      afterAll(() => {
        if (root !== "") rmSync(root, { recursive: true, force: true });
      });

      it("A. ordinary valid evidence naming another branch is accepted", () => {
        const dir = fresh();
        writeFileSync(path.join(dir, NAME), evidence("br-other-branch-000001"));
        expect(scan(dir).ok).toBe(true);
      });

      it("B. a file of EXACTLY the byte limit is accepted; one byte more is refused", () => {
        const dir = fresh();
        const base = Buffer.byteLength(evidence("br-other-branch-000001"), "utf8");
        const exact = evidence("br-other-branch-000001", MAX_EVIDENCE_BYTES - base);
        expect(Buffer.byteLength(exact, "utf8")).toBe(MAX_EVIDENCE_BYTES);
        writeFileSync(path.join(dir, NAME), exact);
        expect(scan(dir).ok).toBe(true);
        writeFileSync(path.join(dir, NAME), evidence("br-other-branch-000001", MAX_EVIDENCE_BYTES - base + 1));
        expect(refusal(dir)).toMatch(/too large/);
      });

      it("C. an oversized file is refused from its METADATA: a 3 GB sparse file is never opened or read", () => {
        const dir = fresh();
        const file = path.join(dir, NAME);
        writeFileSync(file, "");
        truncateSync(file, 3_000_000_000);
        const started = Date.now();
        expect(refusal(dir)).toMatch(/too large/);
        expect(() => readEvidenceFile(file)).toThrow(EvidenceRefusal);
        // The hook runs after the metadata check and before the open: an oversized file never gets that far.
        let reachedOpen = false;
        expect(() => readEvidenceFile(file, () => { reachedOpen = true; })).toThrow(/too large/);
        expect(reachedOpen).toBe(false);
        expect(Date.now() - started).toBeLessThan(5_000);
      });

      it("D. the limit is in BYTES: Unicode content that is under the limit in characters but over it in bytes is refused, and exact-byte Unicode is accepted", () => {
        const dir = fresh();
        const heavy = JSON.stringify({ target: { branchId: "br-other-branch-000001" }, pad: "é".repeat(600_000) });
        expect(heavy.length).toBeLessThan(MAX_EVIDENCE_BYTES);
        expect(Buffer.byteLength(heavy, "utf8")).toBeGreaterThan(MAX_EVIDENCE_BYTES);
        writeFileSync(path.join(dir, NAME), heavy);
        expect(refusal(dir)).toMatch(/too large/);
        const exactDir = fresh();
        const overhead = Buffer.byteLength(JSON.stringify({ target: { branchId: "br-other-branch-000001" }, pad: "" }), "utf8");
        const room = MAX_EVIDENCE_BYTES - overhead;
        const count = Math.floor(room / 2);
        const exact = JSON.stringify({ target: { branchId: "br-other-branch-000001" }, pad: `${"é".repeat(count)}${"x".repeat(room - 2 * count)}` });
        expect(Buffer.byteLength(exact, "utf8")).toBe(MAX_EVIDENCE_BYTES);
        expect(exact.length).toBeLessThan(MAX_EVIDENCE_BYTES);
        writeFileSync(path.join(exactDir, NAME), exact);
        expect(scan(exactDir).ok).toBe(true);
        // A reader that hands back text (any injected one) is measured in bytes as well.
        const injected = authorize(good(), { evidenceFs: { list: () => [NAME], read: () => heavy } });
        expect(injected.ok).toBe(false);
        if (!injected.ok) expect(injected.reason).toMatch(/too large/);
      });

      it("E. a symbolic link is refused (live or dangling), a link in the directory's place is refused, and an unrelated link is never opened", () => {
        const live = fresh();
        symlinkSync(decoy, path.join(live, NAME));
        expect(refusal(live)).toMatch(/symbolic link/);
        let reachedOpen = false;
        expect(() => readEvidenceFile(path.join(live, NAME), () => { reachedOpen = true; })).toThrow(/symbolic link/);
        expect(reachedOpen).toBe(false);
        const dangling = fresh();
        symlinkSync(path.join(root, "does-not-exist.json"), path.join(dangling, NAME));
        expect(refusal(dangling)).toMatch(/symbolic link/);
        const unrelated = fresh();
        symlinkSync(decoy, path.join(unrelated, "notes.env"));
        expect(scan(unrelated).ok).toBe(true); // not this harness's file name: never opened
        const realDir = fresh();
        writeFileSync(path.join(realDir, NAME), evidence("br-other-branch-000001"));
        const linkedDir = path.join(root, `linked-${counter}`);
        symlinkSync(realDir, linkedDir);
        expect(refusal(linkedDir)).toMatch(/could not be listed/);
      });

      it("E2. the open itself refuses to follow a link swapped in AFTER the metadata check (O_NOFOLLOW), and a different file swapped in is detected", () => {
        const dir = fresh();
        const file = path.join(dir, NAME);
        writeFileSync(file, evidence("br-other-branch-000001"));
        expect(() => readEvidenceFile(file, () => { rmSync(file); symlinkSync(decoy, file); })).toThrow(); // ELOOP from the open, not a read of the decoy
        const swapDir = fresh();
        const swapped = path.join(swapDir, NAME);
        writeFileSync(swapped, evidence("br-other-branch-000001"));
        const replacement = path.join(swapDir, "replacement.tmp");
        writeFileSync(replacement, evidence("br-other-branch-000002"));
        // The replacement exists BEFORE the swap, so it has a different inode from the file it replaces.
        expect(() => readEvidenceFile(swapped, () => renameSync(replacement, swapped))).toThrow(/changed between inspection and open/);
        expect(() => readEvidenceFile(path.join(dir, "missing.json"))).toThrow();
      });

      it("F. non-regular objects are refused before any open: a directory, and a FIFO (which would block an open)", () => {
        const asDirectory = fresh();
        mkdirSync(path.join(asDirectory, NAME));
        expect(refusal(asDirectory)).toMatch(/not a regular file/);
        const asFifo = fresh();
        execFileSync("mkfifo", [path.join(asFifo, NAME)]);
        expect(refusal(asFifo)).toMatch(/not a regular file/);
        let reachedOpen = false;
        expect(() => readEvidenceFile(path.join(asFifo, NAME), () => { reachedOpen = true; })).toThrow(/not a regular file/);
        expect(reachedOpen).toBe(false); // a FIFO is refused before an open that could block
        const notADirectory = path.join(root, "plain-file");
        writeFileSync(notADirectory, "x");
        const result = authorize(good(), { evidenceDirectory: notADirectory, evidenceFs: defaultEvidenceFs });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toMatch(/could not be listed/);
      }, 15_000);

      it("G. unreadable, empty, non-UTF-8, unparsable and branch-less files are all refused — none is skipped — and no refusal repeats file content", () => {
        const MARKER = "CONTENT-MARKER-MUST-NOT-APPEAR";
        const cases: Array<[string, () => string | Buffer, RegExp]> = [
          ["invalid JSON", () => `{ ${MARKER}`, /could not be read or parsed/],
          ["empty file", () => "", /could not be read or parsed/],
          ["not UTF-8", () => Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), /not valid UTF-8/],
          ["valid JSON that names no branch", () => JSON.stringify({ note: MARKER }), /does not name its branch/],
          ["JSON null", () => "null", /does not name its branch/],
        ];
        for (const [label, content, reason] of cases) {
          const dir = fresh();
          writeFileSync(path.join(dir, NAME), content());
          const text = refusal(dir);
          expect(text, label).toMatch(reason);
          expect(text, label).not.toContain(MARKER);
        }
        if (process.getuid?.() !== 0) {
          const dir = fresh();
          const file = path.join(dir, NAME);
          writeFileSync(file, evidence("br-other-branch-000001"));
          chmodSync(file, 0o000);
          expect(refusal(dir)).toMatch(/could not be read or parsed/);
          chmodSync(file, 0o600);
        }
      });

      it("H. a run id found in ANY evidence file name is refused from the NAME alone — the content is never read", () => {
        const dir = fresh();
        mkdirSync(path.join(dir, `provider-budget-smoke-${target.runId}-start.json`)); // reading it would fail differently; refusal must come first
        expect(refusal(dir)).toMatch(/run id/);
      });

      it("I. a branch id found in earlier challenge-purge evidence is refused, and a different branch is not", () => {
        const dir = fresh();
        writeFileSync(path.join(dir, NAME), evidence(target.branchId));
        expect(refusal(dir)).toMatch(/branch id appears in earlier/);
        const other = fresh();
        writeFileSync(path.join(other, NAME), evidence("br-another-branch-000002"));
        expect(scan(other).ok).toBe(true);
      });

      it("J. every error path fails closed with a refusal (never an allow), including one bad file among good ones", () => {
        const dir = fresh();
        writeFileSync(path.join(dir, "challenge-purge-smoke-aaaaaaaa-start.json"), evidence("br-other-branch-000001"));
        writeFileSync(path.join(dir, "challenge-purge-smoke-bbbbbbbb-final.json"), "not json");
        expect(refusal(dir)).toMatch(/could not be read or parsed/);
        expect(authorize(good(), { evidenceDirectory: dir, evidenceFs: { list: () => { throw new Error("EIO"); }, read: () => "" } }).ok).toBe(false);
      });
    });
  });

  describe("M-1: the verdict depends on BOTH evidence saves, never on the database alone", () => {
    const ok: EvidenceSave = { ok: true };
    const failFinal: SaveStub = (stage) => (stage === "final" ? { ok: false, reason: "disk full" } : ok);
    const runToEnd = async (session: Session) => {
      await session.runPreflight();
      for (const entry of CASES.filter((candidate) => candidate.optional === undefined)) await session.runCase(entry.id);
      return session.finish();
    };
    const runUntilFailure = async (session: Session) => {
      await session.runPreflight();
      for (const entry of CASES.filter((candidate) => candidate.optional === undefined)) {
        try {
          await session.runCase(entry.id);
        } catch {
          break;
        }
      }
      return session.finish();
    };

    it("A. both saves succeed: completed_clean, COMPLETED_CLEAN, and concludeRun passes", async () => {
      const { session, saved } = await newSession({});
      const final = await runToEnd(session);
      expect(final.outcome).toBe("completed_clean");
      expect(final.databaseOutcome).toBe("cleanup_confirmed");
      expect(session.state()).toBe("COMPLETED_CLEAN");
      expect(final.evidence).toEqual({ start: { saved: true }, final: { saved: true } });
      expect(saved.map((entry) => entry.stage)).toEqual(["start", "final"]);
      expect(concludeRun(final as Parameters<typeof concludeRun>[0]).pass).toBe(true);
    }, 30_000);

    it("B. the start save fails: the run is REFUSED before any write, no case or cleanup runs, and nothing passes", async () => {
      const { session, emulator, saved } = await newSession({}, false, FAST_TIMING, (stage) => (stage === "start" ? { ok: false, reason: "disk full" } : ok));
      await expect(session.runPreflight()).rejects.toThrow(/start evidence could not be saved/);
      expect(session.state()).toBe("REFUSED");
      expect(emulator.calls.every((call) => /^SELECT/.test(call))).toBe(true);
      const final = await session.finish();
      expect(final.outcome).toBe("refused_before_any_write");
      expect(final.evidence).toMatchObject({ start: { saved: false, reason: "disk full" } });
      expect(concludeRun(final as Parameters<typeof concludeRun>[0]).pass).toBe(false);
      expect(saved.map((entry) => entry.stage)).toEqual(["start", "final"]);
      expect(emulator.calls.every((call) => /^SELECT/.test(call))).toBe(true);
    });

    it("C. the final save fails AFTER a successful cleanup: clean_but_not_evidenced, never COMPLETED_CLEAN, and it fails the run", async () => {
      const { session, emulator, saved } = await newSession({}, false, FAST_TIMING, failFinal);
      const final = await runToEnd(session);
      expect(final.databaseOutcome).toBe("cleanup_confirmed");
      expect(final.outcome).toBe("clean_but_not_evidenced");
      expect(final.outcome).not.toBe("completed_clean");
      expect(session.state()).toBe("COMPLETED_NOT_EVIDENCED");
      expect(session.state()).not.toBe("COMPLETED_CLEAN");
      expect(final.evidence).toEqual({ start: { saved: true }, final: { saved: false, reason: "disk full" } });
      const verdict = concludeRun(final as Parameters<typeof concludeRun>[0]);
      expect(verdict.pass).toBe(false);
      expect(verdict.verdict).toBe("clean_but_not_evidenced");
      expect(verdict.message).toMatch(/cleanup was confirmed, but the evidence is incomplete.*final evidence NOT saved/);
      // The database really was cleaned (the distinction is kept), and the final file was attempted exactly once, with no fallback file.
      expect(emulator.state()).toEqual({ schemaExists: false, tableExists: false });
      expect(emulator.publicTable.size).toBe(0);
      expect(saved.filter((entry) => entry.stage === "final")).toHaveLength(1);
      // G. No SQL follows the failed save: nothing is repaired, retried or cleaned again.
      const atFinalSave = saved.find((entry) => entry.stage === "final")!.callsAtSave;
      expect(emulator.calls.length).toBe(atFinalSave);
      await expect(session.finish()).resolves.toBe(final);
      expect(emulator.calls.length).toBe(atFinalSave);
      await expect(session.runCase("P2")).rejects.toThrow(/cannot run/);
      expect(emulator.calls.length).toBe(atFinalSave);
    }, 30_000);

    it("D. a poisoned run whose final evidence IS saved is poisoned_evidence_preserved; the saved file states the database outcome and the run is not a pass", async () => {
      const { session, emulator, saved } = await newSession({ limit: 65 });
      const final = await runUntilFailure(session);
      expect(final.outcome).toBe("poisoned_evidence_preserved");
      expect(final.evidence).toMatchObject({ final: { saved: true } });
      const file = saved.find((entry) => entry.stage === "final")!.evidence;
      expect(file.databaseOutcome).toBe("poisoned");
      expect(Object.hasOwn(file, "outcome")).toBe(false); // the verdict about the evidence cannot be inside the evidence
      expect(concludeRun(final as Parameters<typeof concludeRun>[0]).pass).toBe(false);
      expect(emulator.calls.some((call) => call.startsWith("DROP") || call === TEXT.publicDelete)).toBe(false);
    }, 30_000);

    it("E. a poisoned run whose final save FAILS is poisoned_evidence_not_saved and says so — it never claims preservation", async () => {
      const { session, emulator, saved } = await newSession({ limit: 65 }, false, FAST_TIMING, failFinal);
      const final = await runUntilFailure(session);
      expect(final.outcome).toBe("poisoned_evidence_not_saved");
      expect(final.outcome).not.toBe("poisoned_evidence_preserved");
      expect(final.evidence).toMatchObject({ final: { saved: false, reason: "disk full" } });
      const verdict = concludeRun(final as Parameters<typeof concludeRun>[0]);
      expect(verdict.pass).toBe(false);
      expect(verdict.message).toMatch(/final evidence was NOT saved|final evidence NOT saved/);
      const atFinalSave = saved.find((entry) => entry.stage === "final")!.callsAtSave;
      expect(emulator.calls.length).toBe(atFinalSave); // G again: no database work to repair the evidence, and no destructive cleanup
      expect(emulator.calls.some((call) => call.startsWith("DROP") || call === TEXT.publicDelete)).toBe(false);
    }, 30_000);

    it("F. no failed-evidence path can report completed_clean: the whole truth table, a throwing writer, and a forged verdict", async () => {
      const databases: DatabaseOutcome[] = ["refused_before_any_write", "poisoned", "cleanup_not_confirmed", "cleanup_confirmed"];
      for (const database of databases) {
        for (const startSaved of [true, false]) {
          for (const finalSaved of [true, false]) {
            const verdict = verdictFor(database, startSaved, finalSaved);
            const clean = verdict === "completed_clean";
            expect(clean, `${database}/${startSaved}/${finalSaved}`).toBe(database === "cleanup_confirmed" && startSaved && finalSaved);
            const concluded = concludeRun({ outcome: verdict, evidence: { start: { saved: startSaved }, final: { saved: finalSaved } } });
            expect(concluded.pass, `${database}/${startSaved}/${finalSaved}`).toBe(clean);
          }
        }
      }
      // A forged completed_clean with an unsaved file is still not a pass.
      expect(concludeRun({ outcome: "completed_clean", evidence: { start: { saved: true }, final: { saved: false, reason: "x" } } }).pass).toBe(false);
      expect(concludeRun({ outcome: "completed_clean" }).pass).toBe(false);
      // A writer that THROWS is a failed save, not an escaped exception, and a throw never produces completed_clean.
      const throwing: SaveStub = (stage) => {
        if (stage === "final") throw new Error("boom");
        return ok;
      };
      const { session } = await newSession({}, false, FAST_TIMING, throwing);
      const final = await runToEnd(session);
      expect(final.outcome).toBe("clean_but_not_evidenced");
      expect(final.evidence).toMatchObject({ final: { saved: false, reason: "the evidence writer threw" } });
      expect(session.state()).toBe("COMPLETED_NOT_EVIDENCED");
      // The live suite's afterAll decides through concludeRun, and compares nothing to completed_clean itself.
      const source = readFileSync(SMOKE_FILE, "utf8");
      const live = source.slice(source.indexOf("afterAll(async () => {\n    if (!started || !session) return;"));
      expect(live).toContain("concludeRun(final as Parameters<typeof concludeRun>[0])");
      expect(live).toContain("if (!verdict.pass) throw new Error(");
    }, 30_000);

    it("writeEvidence creates each file exclusively with mode 0600 in a private directory, never overwrites, and refuses unsafe content without creating a file", () => {
      const root = mkdtempSync(path.join(tmpdir(), "cps-evidence-"));
      const directory = path.join(root, "evidence");
      onTestFinished(() => rmSync(root, { recursive: true, force: true })); // this test's own temporary directory, pass or fail
      const body = { runId: SYNTHETIC_RUN, stage: "final", target: { branchId: "br-test-branch-1" } };
      expect(writeEvidence(directory, SYNTHETIC_RUN, "final", body)).toEqual({ ok: true });
      const file = path.join(directory, `challenge-purge-smoke-${SYNTHETIC_RUN}-final.json`);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(directory).mode & 0o077).toBe(0);
      const before = readFileSync(file, "utf8");
      expect(writeEvidence(directory, SYNTHETIC_RUN, "final", { ...body, changed: true })).toEqual({ ok: false, reason: "EEXIST" });
      expect(readFileSync(file, "utf8")).toBe(before);
      expect(writeEvidence(directory, SYNTHETIC_RUN, "start", { note: "postgres://user:pw@host/db" })).toMatchObject({ ok: false });
      expect(existsSync(path.join(directory, `challenge-purge-smoke-${SYNTHETIC_RUN}-start.json`))).toBe(false);
      expect(writeEvidence(directory, SYNTHETIC_RUN, "start", { endpoint: "ep-some-branch-123456" })).toMatchObject({ ok: false });
    });

    describe("L-A: a late preflight result can never move a terminated run back to ARMED or REFUSED", () => {
      const deferred = () => {
        let release!: () => void;
        const until = new Promise<void>((resolve) => {
          release = resolve;
        });
        return { until, release };
      };
      const eventually = async (condition: () => boolean) => {
        for (let i = 0; i < 400 && !condition(); i += 1) await sleep(5);
        expect(condition(), "the held statement was reached").toBe(true);
      };
      /** Starts a preflight whose read of `holdText` is held open, and waits until that read is outstanding. */
      const heldPreflight = async (options: EmulatorOptions = {}, holdText: string = TEXT.publicCount) => {
        const gate = deferred();
        const harness = await newSession({ ...options, hold: { text: holdText, until: gate.until } });
        const pending = harness.session.runPreflight();
        pending.catch(() => undefined);
        await eventually(() => harness.emulator.calls.includes(holdText));
        return { ...harness, gate, pending };
      };
      const LATE = /ended while the preflight was outstanding/;

      it("A. a normal successful preflight arms the run exactly once and saves the start evidence once", async () => {
        const { session, saved } = await newSession({});
        await session.runPreflight();
        expect(session.state()).toBe("ARMED");
        expect(saved.map((entry) => entry.stage)).toEqual(["start"]);
        await expect(session.runPreflight()).rejects.toThrow(/cannot start in state ARMED/);
        expect(session.state()).toBe("ARMED");
      });

      it("B. a normal refused preflight (non-empty public table) ends REFUSED and saves no start evidence", async () => {
        const { session, saved } = await newSession({ initialPublicRows: 1 });
        await expect(session.runPreflight()).rejects.toThrow(/COMPLETELY EMPTY/);
        expect(session.state()).toBe("REFUSED");
        expect(saved).toHaveLength(0);
      });

      it("C. poisoning while a read-only preflight read is outstanding: the late answer is discarded and no further read is sent", async () => {
        const { session, emulator, saved, gate, pending } = await heldPreflight({}, TEXT.identity);
        session.poison("a deadline passed");
        expect(session.state()).toBe("POISONED");
        const before = emulator.calls.length;
        gate.release();
        await expect(pending).rejects.toThrow(/poisoned|ended while the preflight/);
        expect(session.state()).toBe("POISONED");
        expect(emulator.calls.length).toBe(before); // not one more statement after the poison
        expect(saved).toHaveLength(0);
      });

      it("D. a LATE SUCCESS after poisoning does not arm the run, save a start record, or send anything", async () => {
        const { session, emulator, saved, gate, pending } = await heldPreflight();
        session.poison("a deadline passed");
        const before = emulator.calls.length;
        gate.release();
        await expect(pending).rejects.toThrow(LATE);
        expect(session.state()).toBe("POISONED");
        expect(session.state()).not.toBe("ARMED");
        expect(saved.map((entry) => entry.stage)).not.toContain("start");
        expect(session.stats().startSaved.ok).toBe(false);
        expect(emulator.calls.length).toBe(before);
        await expect(session.runCase("P1")).rejects.toThrow(/cannot run/);
        expect(emulator.calls.length).toBe(before);
      });

      it("E. a LATE REFUSAL after poisoning leaves the run POISONED, not REFUSED", async () => {
        const { session, emulator, saved, gate, pending } = await heldPreflight({ initialPublicRows: 1 });
        session.poison("a deadline passed");
        const before = emulator.calls.length;
        gate.release();
        await expect(pending).rejects.toThrow(LATE);
        expect(session.state()).toBe("POISONED");
        expect(session.state()).not.toBe("REFUSED");
        expect(saved).toHaveLength(0);
        expect(emulator.calls.length).toBe(before);
      });

      it("F. a late completion after SEALING cannot alter the sealed report, the saved evidence, or the state", async () => {
        const { session, emulator, saved, gate, pending } = await heldPreflight();
        const final = await session.finish(); // what afterAll does when the preflight timed out: poison and seal
        expect(final.outcome).toBe("poisoned_final_evidence_only");
        expect(session.state()).toBe("POISONED");
        const sealed = JSON.stringify(final);
        const savedBefore = saved.map((entry) => JSON.stringify(entry.evidence));
        const before = emulator.calls.length;
        gate.release();
        await expect(pending).rejects.toThrow(LATE);
        expect(JSON.stringify(final)).toBe(sealed);
        expect(saved.map((entry) => JSON.stringify(entry.evidence))).toEqual(savedBefore);
        expect(saved.map((entry) => entry.stage)).toEqual(["final"]);
        await expect(session.finish()).resolves.toBe(final);
        expect(session.state()).toBe("POISONED");
        expect(emulator.calls.length).toBe(before);
      });

      it("G. no SQL is sent after termination, whichever way the run ended", async () => {
        const { session, emulator, gate, pending } = await heldPreflight();
        await session.finish();
        const before = emulator.calls.length;
        gate.release();
        await expect(pending).rejects.toThrow();
        await expect(session.runPreflight()).rejects.toThrow(/cannot start/);
        await expect(session.runCase("P2")).rejects.toThrow();
        await session.finish();
        expect(emulator.calls.length).toBe(before);
      });

      it("H. no terminal state ever regresses: a second preflight or a case on a POISONED, REFUSED or COMPLETED run changes nothing", async () => {
        const terminal: Array<[string, () => Promise<{ session: Session; emulator: { calls: string[] } }>]> = [
          ["POISONED", async () => { const h = await newSession({}); h.session.poison("x"); return h; }],
          ["REFUSED", async () => { const h = await newSession({ initialPublicRows: 1 }); await h.session.runPreflight().catch(() => undefined); return h; }],
          ["COMPLETED_CLEAN", async () => { const h = await newSession({}); await runToEnd(h.session); return h; }],
          ["COMPLETED_NOT_EVIDENCED", async () => { const h = await newSession({}, false, FAST_TIMING, failFinal); await runToEnd(h.session); return h; }],
          ["COMPLETED_NOT_CLEAN", async () => { const h = await newSession({ failOn: { startsWith: "DROP SCHEMA", code: "2BP01" } }); await runToEnd(h.session); return h; }],
        ];
        for (const [expected, build] of terminal) {
          const { session, emulator } = await build();
          expect(session.state(), expected).toBe(expected);
          const before = emulator.calls.length;
          await expect(session.runPreflight(), expected).rejects.toThrow(/cannot start in state/);
          await expect(session.runCase("P1"), expected).rejects.toThrow();
          expect(session.state(), expected).toBe(expected);
          expect(emulator.calls.length, expected).toBe(before);
        }
      }, 60_000);
    });

    describe("L-B: database cleanup, start evidence, final evidence and the overall verdict are four separate facts", () => {
      const dropFails = { failOn: { startsWith: "DROP SCHEMA", code: "2BP01" } } as const;
      const count = (calls: string[], prefix: string) => calls.filter((call) => call.startsWith(prefix)).length;
      const facts = (final: Record<string, unknown>) => ({
        database: final.databaseOutcome,
        start: (final.evidence as { start: { saved: boolean } }).start.saved,
        final: (final.evidence as { final: { saved: boolean } }).final.saved,
        verdict: final.outcome,
      });
      const conclude = (final: Record<string, unknown>) => concludeRun(final as Parameters<typeof concludeRun>[0]);

      it("A. cleanup FAILS but the final evidence is saved: cleanup_not_confirmed, both files exist, not a pass, and the failed statement is never retried", async () => {
        const { session, emulator, saved } = await newSession(dropFails);
        const final = await runToEnd(session);
        expect(facts(final)).toEqual({ database: "cleanup_not_confirmed", start: true, final: true, verdict: "cleanup_not_confirmed" });
        expect(session.state()).toBe("COMPLETED_NOT_CLEAN");
        expect((final.cleanup as { scratch: { status: string } }).scratch.status).toBe("incomplete"); // refused by the database, not "uncertain"
        expect(conclude(final).pass).toBe(false);
        expect(saved.find((entry) => entry.stage === "final")!.evidence.databaseOutcome).toBe("cleanup_not_confirmed");
        // F. exactly one attempt at each destructive cleanup statement, and a second finish() sends nothing.
        expect(count(emulator.calls, "DROP SCHEMA")).toBe(1);
        expect(count(emulator.calls, "DROP TABLE")).toBe(1);
        expect(emulator.calls.filter((call) => call === TEXT.publicDelete)).toHaveLength(1);
        const calls = emulator.calls.length;
        await expect(session.finish()).resolves.toBe(final);
        expect(emulator.calls.length).toBe(calls);
      }, 30_000);

      it("B. cleanup FAILS and the final evidence cannot be saved: the database outcome and the evidence failure are both reported, and no SQL follows the failed save", async () => {
        const { session, emulator, saved } = await newSession(dropFails, false, FAST_TIMING, failFinal);
        const final = await runToEnd(session);
        expect(facts(final)).toEqual({ database: "cleanup_not_confirmed", start: true, final: false, verdict: "cleanup_not_confirmed" });
        expect(final.evidence).toMatchObject({ final: { saved: false, reason: "disk full" } });
        const verdict = conclude(final);
        expect(verdict.pass).toBe(false);
        expect(verdict.message).toMatch(/final evidence NOT saved/);
        const atSave = saved.find((entry) => entry.stage === "final")!.callsAtSave;
        expect(emulator.calls.length).toBe(atSave); // G
        expect(count(emulator.calls, "DROP SCHEMA")).toBe(1);
      }, 30_000);

      it("B2. an UNCERTAIN cleanup statement (no answer) is recorded, stops the cleanup, and is never retried or followed by anything", async () => {
        const { session, emulator, saved } = await newSession({ stallOn: { startsWith: "DROP TABLE" } }, false, { ...FAST_TIMING, statementDeadlineMs: 120 });
        const final = await runToEnd(session);
        expect(facts(final)).toEqual({ database: "cleanup_not_confirmed", start: true, final: true, verdict: "cleanup_not_confirmed" });
        expect((final.cleanup as { scratch: { status: string } }).scratch.status).toBe("uncertain");
        expect((final.uncertainWrites as unknown[]).length).toBe(1);
        expect(count(emulator.calls, "DROP TABLE")).toBe(1);
        expect(count(emulator.calls, "DROP SCHEMA")).toBe(0); // the cleanup stopped at the uncertain step
        const atSave = saved.find((entry) => entry.stage === "final")!.callsAtSave;
        expect(emulator.calls.length).toBe(atSave);
        expect(conclude(final).pass).toBe(false);
      }, 30_000);

      it("C. the preflight is poisoned BEFORE the start evidence is saved: the final evidence alone is named for what it is (never 'preserved')", async () => {
        const deferred = (() => { let release!: () => void; const until = new Promise<void>((resolve) => { release = resolve; }); return { until, release }; })();
        const { session, emulator, saved } = await newSession({ hold: { text: TEXT.publicCount, until: deferred.until } });
        const pending = session.runPreflight();
        pending.catch(() => undefined);
        for (let i = 0; i < 400 && !emulator.calls.includes(TEXT.publicCount); i += 1) await sleep(5);
        const final = await session.finish();
        deferred.release();
        await expect(pending).rejects.toThrow();
        expect(facts(final)).toEqual({ database: "poisoned", start: false, final: true, verdict: "poisoned_final_evidence_only" });
        expect(final.evidence).toMatchObject({ start: { saved: false, reason: "not attempted" } });
        expect(final.outcome).not.toBe("poisoned_evidence_preserved");
        expect(conclude(final).message).toMatch(/only the FINAL evidence exists/);
        expect(saved.map((entry) => entry.stage)).toEqual(["final"]);
      });

      it("D. the final evidence is saved but the start evidence never was: refused (start save failed) is not a pass, and the truth table names every combination", async () => {
        const { session } = await newSession({}, false, FAST_TIMING, (stage) => (stage === "start" ? { ok: false, reason: "disk full" } : { ok: true }));
        await expect(session.runPreflight()).rejects.toThrow();
        const final = await session.finish();
        expect(facts(final)).toEqual({ database: "refused_before_any_write", start: false, final: true, verdict: "refused_before_any_write" });
        expect(conclude(final).pass).toBe(false);
        expect(verdictFor("poisoned", false, true)).toBe("poisoned_final_evidence_only");
        expect(verdictFor("poisoned", true, true)).toBe("poisoned_evidence_preserved");
        expect(verdictFor("poisoned", true, false)).toBe("poisoned_evidence_not_saved");
        expect(verdictFor("poisoned", false, false)).toBe("poisoned_evidence_not_saved");
        expect(verdictFor("cleanup_confirmed", false, true)).toBe("clean_but_not_evidenced");
      });

      it("E. NO failure path is ever reported completed_clean, across the real session in every failure scenario; only the fully successful run is", async () => {
        const scenarios: Array<[string, () => Promise<{ final: Record<string, unknown>; session: Session }>, boolean]> = [
          ["success", async () => { const { session } = await newSession({}); return { final: await runToEnd(session), session }; }, true],
          ["cleanup refused, evidence saved", async () => { const { session } = await newSession(dropFails); return { final: await runToEnd(session), session }; }, false],
          ["cleanup refused, final unsaved", async () => { const { session } = await newSession(dropFails, false, FAST_TIMING, failFinal); return { final: await runToEnd(session), session }; }, false],
          ["cleanup uncertain", async () => { const { session } = await newSession({ stallOn: { startsWith: "DROP TABLE" } }, false, { ...FAST_TIMING, statementDeadlineMs: 120 }); return { final: await runToEnd(session), session }; }, false],
          ["clean, final unsaved", async () => { const { session } = await newSession({}, false, FAST_TIMING, failFinal); return { final: await runToEnd(session), session }; }, false],
          ["clean, final writer throws", async () => { const { session } = await newSession({}, false, FAST_TIMING, (stage) => { if (stage === "final") throw new Error("boom"); return { ok: true }; }); return { final: await runToEnd(session), session }; }, false],
          ["poisoned by a wrong purge", async () => { const { session } = await newSession({ limit: 65 }); return { final: await runUntilFailure(session), session }; }, false],
          ["poisoned, final unsaved", async () => { const { session } = await newSession({ limit: 65 }, false, FAST_TIMING, failFinal); return { final: await runUntilFailure(session), session }; }, false],
          ["refused: public table not empty", async () => { const { session } = await newSession({ initialPublicRows: 1 }); await session.runPreflight().catch(() => undefined); return { final: await session.finish(), session }; }, false],
          ["refused: start evidence unsaved", async () => { const { session } = await newSession({}, false, FAST_TIMING, () => ({ ok: false, reason: "disk full" })); await session.runPreflight().catch(() => undefined); return { final: await session.finish(), session }; }, false],
        ];
        for (const [label, run, shouldPass] of scenarios) {
          const { final, session } = await run();
          const verdict = conclude(final);
          expect(verdict.pass, label).toBe(shouldPass);
          expect(final.outcome === "completed_clean", label).toBe(shouldPass);
          expect(session.state() === "COMPLETED_CLEAN", label).toBe(shouldPass);
        }
      }, 120_000);
    });
  });

  describe("statement guard", () => {
    const build = () => {
      const ownership = createRunOwnership(SYNTHETIC_RUN, { maxScratchSchemas: 1 });
      const schema = ownership.registerScratchSchema("main");
      ownership.registerScratchObject(schema, "table", "webauthn_challenges");
      const publicRows = createPublicRows(SYNTHETIC_RUN, 10);
      const account = planAdmissionCleanup(ownership);
      const S = createStatements({ runId: SYNTHETIC_RUN, schema, ownership, publicRows, productionCreate: production.create, ddl: scratchDdl(schemaText, schema), cleanupAllowed: new Set(account.steps.map((step) => step.statement.text)) });
      return { S, publicRows, account, ownership };
    };

    it("caps public rows at 10, refuses unregistered values, and refuses a delete that is not exactly the registered set", async () => {
      const { S, publicRows } = build();
      const values = Array.from({ length: 10 }, (_, i) => publicRows.register(`row-${i}`));
      expect(() => publicRows.register("row-11")).toThrow(/public-row limit/);
      expect(() => publicRows.register("row-1")).toThrow(/twice/);
      expect(() => S.publicRow("cps-ffffffff-other")).toThrow(/did not register/);
      expect(() => S.publicSeed(`cps-${SYNTHETIC_RUN}-never-registered`, "login", new Date().toISOString())).toThrow(/did not register/);
      expect(() => S.publicDelete(values.slice(1))).toThrow(/exactly the values/);
      expect(S.publicDelete(values).mode).toBe("write");
    });

    it("validates every parameter: schema ownership, ISO shape, purposes, seed sizes, catalog targets", async () => {
      const { S } = build();
      expect(() => S.seedRows("p2-", new Date().toISOString(), 4_301)).toThrow(/outside/);
      expect(() => S.seedRows("bad prefix", new Date().toISOString(), 1)).toThrow(/prefix/);
      expect(() => S.seedRows("p2-", "2026-01-01", 1)).toThrow(/exact-millisecond/);
      expect(() => S.seedOne("x", "not_a_purpose", new Date().toISOString())).toThrow(/purpose/);
      expect(() => S.purgeCreate({ cutoff: "now()", challenge: "x", purpose: "login", context: null, expiresAt: new Date().toISOString() })).toThrow(/exact-millisecond/);
      expect(() => S.purgeCreate({ cutoff: new Date().toISOString(), challenge: "X; DROP", purpose: "login", context: null, expiresAt: new Date().toISOString() })).toThrow(/malformed/);
      expect(() => S.shape("public.real_accounts")).toThrow(/public table or this run's scratch/);
      expect(() => S.holder(["not-p7"], 5)).toThrow(/P7/);
      expect(() => S.holder(["p7-0001"], 21)).toThrow(/1..20/);
    });

    it("every statement a session can build passes the global safety screen, and the screen rejects each dangerous construct", async () => {
      const { S, publicRows, account } = build();
      const value = publicRows.register("probe");
      const iso = new Date().toISOString();
      const p = { cutoff: iso, challenge: "c", purpose: "login", context: null, expiresAt: iso };
      const built = [S.identity(), S.publicCount(), S.shape(S.texts.table), S.indexes("public.webauthn_challenges"), S.checks(S.texts.table), S.schemas(), S.usedTables(), S.activitySelf(), S.holderActive(), S.list(), S.count(), S.publicRow(value), S.publicPresent([value]), S.explain(p), S.createSchema(), S.createTable(), S.createIndex(), S.seedRows("p2-", iso, 3), S.seedOne("c", "login", iso), S.reset(), S.analyze(), S.purgeCreate(p), S.publicSeed(value, "login", iso), S.publicDelete([value]), ...account.steps.map((step) => S.ownership(step.statement.text, step.statement.params))];
      for (const stmt of built) expect(() => assertStatementText(stmt)).not.toThrow();
      for (const stmt of built.filter((entry) => entry.mode === "write")) expect(["create_schema", "create_table", "create_index", "seed_rows", "seed_one", "reset", "analyze", "purge_create", "public_seed", "public_delete", "ownership"]).toContain(stmt.kind);
      const dangerous = ["DROP SCHEMA public CASCADE", "TRUNCATE public.webauthn_challenges", "ALTER TABLE x ADD y int", "SET search_path = public", "SELECT 1; SELECT 2", "EXPLAIN (ANALYZE, FORMAT JSON) DELETE FROM x", "COPY x TO STDOUT", "DROP TABLE real_accounts RESTRICT", "SELECT pg_sleep(1)", "SELECT * FROM x FOR UPDATE", "GRANT ALL ON x TO y"];
      for (const text of dangerous) expect(() => assertStatementText({ kind: "read", text }), text).toThrow(/forbidden|only the|row locks|EXPLAIN/);
      // The ownership kind refuses a DROP of anything but the one registered table and schema, and a foreign schema name.
      expect(() => S.ownership("DROP TABLE public.real_accounts RESTRICT", [])).toThrow(/not part of the planned cleanup/);
      expect(() => S.ownership(SCHEMA_INVENTORY_SQL, ["public"])).toThrow(/schema this run does not own/);
    });

    it("the session refuses unbranded SQL, writes before arming, and any statement after poison, and never retries", async () => {
      const { session, emulator } = await newSession({});
      await expect(session.runPreflight()).resolves.toBeUndefined();
      const before = emulator.calls.length;
      await expect(session.runCase("P2")).resolves.toBeUndefined();
      expect(emulator.calls.length).toBeGreaterThan(before);
      session.poison("test");
      const frozen = emulator.calls.length;
      await expect(session.runCase("P3")).rejects.toThrow(/cannot run|poisoned/);
      expect(emulator.calls.length).toBe(frozen);
      await expect(session.finish()).resolves.toMatchObject({ outcome: "poisoned_evidence_preserved" });
    });
  });

  describe("dry run against the emulator (proves the harness would notice a wrong purge — NOT PostgreSQL)", () => {
    it("a faithful emulation passes every case, cleans up exactly, and stays inside every ceiling (correctness mode)", async () => {
      const { session, emulator, saved } = await newSession({});
      const final = await runAll(session, false);
      expect(final.outcome).toBe("completed_clean");
      expect(session.state()).toBe("COMPLETED_CLEAN");
      expect((final.completedCases as string[])).toEqual(["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"]);
      const stats = session.stats();
      expect(stats.publicRows.length).toBeLessThanOrEqual(10);
      expect(stats.scratchRowsCreated).toBeLessThanOrEqual(planBudget(false).totals.scratchRows);
      expect(stats.maxInFlight).toBeLessThanOrEqual(8);
      expect(stats.operations).toBeLessThanOrEqual(planBudget(false).totals.operations);
      expect(emulator.publicTable.size).toBe(0);
      expect(emulator.state()).toEqual({ schemaExists: false, tableExists: false });
      expect(saved.map((entry) => entry.stage)).toEqual(["start", "final"]);
      for (const entry of saved) expect(safeEvidenceJson(entry.evidence), `${entry.stage} evidence passes the content screen`).not.toBeNull();
      // Paths are recorded per case.
      expect((final.caseResults as Array<{ id: string; path: string }>).map((entry) => [entry.id, entry.path])).toEqual([["P1", "real_adapter_public"], ["P2", "qualified_sql_scratch"], ["P3", "qualified_sql_scratch"], ["P4", "qualified_sql_scratch"], ["P5", "qualified_sql_scratch"], ["P6", "qualified_sql_scratch"], ["P7", "qualified_sql_scratch"], ["P8", "real_adapter_public"], ["P9", "read_only_plan"]]);
    }, 30_000);

    it("with PERF enabled the optional case also runs and stays within 5,000 scratch rows", async () => {
      const { session } = await newSession({}, true);
      const final = await runAll(session, true);
      expect(final.outcome).toBe("completed_clean");
      expect((final.completedCases as string[]).at(-1)).toBe("PERF");
      expect(session.stats().scratchRowsCreated).toBeLessThanOrEqual(6_000);
    }, 30_000);

    const mutants: Array<[string, EmulatorOptions, string, RegExp?]> = [
      ["a purge bound of 65", { limit: 65 }, "P2"],
      ["an unbounded purge", { limit: 100_000 }, "P2"],
      ["newest-first selection", { newestFirst: true }, "P2"],
      ["a non-strict (<=) cutoff", { strictLess: false }, "P5"],
      ["deleting a live row", { deleteLive: true }, "P3"],
      ["a purge that waits on locks instead of skipping them", { skipLocked: false }, "P7"],
      ["an over-deletion that appears only under concurrency (each of P6's creates deletes up to 100 rows)", { onlyFor: { prefix: "p6-new", limit: 100 } }, "P6", /expired rows remain|deleted in total/],
      ["a selection that ignores expiry and takes the newest rows (live ones) only under concurrency (P6's creates)", { onlyFor: { prefix: "p6-new", reachLive: true } }, "P6", /previously live row/],
    ];
    for (const [name, options, failingCase, message] of mutants) {
      it(`DETECTS ${name}: ${failingCase} fails, the run is poisoned, and no cleanup runs`, async () => {
          const { session, emulator } = await newSession(options);
        await session.runPreflight();
        let failure: unknown = null;
        for (const entry of CASES.filter((candidate) => candidate.optional === undefined)) {
          try {
            await session.runCase(entry.id);
          } catch (error) {
            failure = error;
            expect(entry.id, name).toBe(failingCase);
            if (message) expect((error as Error).message, name).toMatch(message);
            break;
          }
        }
        expect(failure, name).toBeInstanceOf(HarnessFailure);
        expect(session.state()).toBe("POISONED");
        const final = await session.finish();
        expect(final.outcome).toBe("poisoned_evidence_preserved");
        expect(emulator.calls.some((call) => call.startsWith("DROP"))).toBe(false);
        expect(emulator.calls.includes(TEXT.publicDelete)).toBe(false);
      }, 30_000);
    }

    it("a non-empty public table REFUSES the run before any write, deletes nothing, and runs no cleanup", async () => {
      const { session, emulator, saved } = await newSession({ initialPublicRows: 1 });
      await expect(session.runPreflight()).rejects.toThrow(/COMPLETELY EMPTY/);
      expect(session.state()).toBe("REFUSED");
      expect(emulator.calls.every((call) => /^SELECT/.test(call))).toBe(true);
      expect(emulator.publicTable.size).toBe(1);
      await expect(session.runCase("P1")).rejects.toThrow();
      const final = await session.finish();
      expect(final.outcome).toBe("refused_before_any_write");
      expect(saved.some((entry) => entry.stage === "start")).toBe(false);
      expect(emulator.calls.every((call) => /^SELECT/.test(call))).toBe(true);
    });

    it("an unsaved start record REFUSES arming: no write is possible without it", async () => {
      const emulator = createEmulator(schemaName, SYNTHETIC_RUN, production, ddl);
      const session = createSession({ runId: SYNTHETIC_RUN, driver: emulator.driver, timing: FAST_TIMING, perf: false, production, ddl, target: {}, provenance: {}, save: () => ({ ok: false, reason: "disk" }) });
      await expect(session.runPreflight()).rejects.toThrow(/start evidence could not be saved/);
      expect(emulator.calls.every((call) => /^SELECT/.test(call))).toBe(true);
    });

    it("a write that never answers hits its deadline: recorded as uncertain, run poisoned, nothing retried, no cleanup", async () => {
      const { session, emulator } = await newSession({ stallWrites: true }, false, { ...FAST_TIMING, statementDeadlineMs: 80, caseDeadlineMs: 2_000 });
      await session.runPreflight();
      await expect(session.runCase("P2")).rejects.toThrow(/no answer within the deadline/);
      expect(session.state()).toBe("POISONED");
      expect(session.stats().uncertain).toHaveLength(1);
      expect(emulator.calls.filter((call) => call.startsWith("CREATE SCHEMA"))).toHaveLength(1); // sent once, never repeated
      const final = await session.finish();
      expect(final.outcome).toBe("poisoned_evidence_preserved");
      expect((final.uncertainWrites as unknown[]).length).toBe(1);
      expect(emulator.calls.some((call) => call.startsWith("DROP") || call === TEXT.publicDelete)).toBe(false);
    });

    it("the adapter wrapper forwards only the pinned production statements over values this run registered", async () => {
      const { session, emulator } = await newSession({});
      await session.runPreflight();
      await session.runCase("P2"); // arms the run and sets up the scratch table
      const before = emulator.calls.length;
      expect(() => session.adapterSql`SELECT 1`).toThrow(/not the pinned production/);
      const store = createNeonChallengeStore(session.adapterSql);
      await expect(store.create({ challenge: "unregistered", purpose: "login", ttlMs: 1_000 })).rejects.toThrow(/did not register/);
      await expect(store.consume({ challenge: "unregistered", purpose: "login" })).rejects.toThrow(/did not register/);
      expect(emulator.calls.length).toBe(before); // nothing refused was ever forwarded
      expect(session.stats().publicCreates).toBe(0);
      const registered = session.publicRows.register("probe");
      await expect(store.create({ challenge: registered, purpose: "login", ttlMs: 1_000 })).resolves.toBeDefined();
      expect(session.stats().publicCreates).toBe(1);
    });
  });
});

// ------------------------------------------------------------------------------------------------ L-1: process-level gate proofs (offline)

/**
 * A preload for the CHILD processes only: logs and blocks every non-loopback connection, DNS lookup and fetch, so a gate that failed to hold
 * would be seen as a logged attempt (and could not reach anything). Loopback and unix sockets stay open for the runner's own plumbing.
 */
const NETWORK_BLOCKER_SOURCE = `
const fs = require("fs");
const net = require("net");
const dns = require("dns");
const LOG = process.env.NET_BLOCK_LOG;
const note = (what) => { try { fs.appendFileSync(LOG, what + "\\n"); } catch {} };
const loopback = (host) => !host || host === "localhost" || host === "127.0.0.1" || host === "::1";
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // net.connect() hands Socket#connect a NORMALIZED argument list: [options, callback]. Unwrap it, or the host is never seen.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof first === "number" ? args[1] : first && typeof first === "object" ? (first.path ? "unix" : first.host) : undefined;
  if (host !== "unix" && !loopback(host)) { note("connect " + String(host)); throw new Error("blocked outbound connection"); }
  return connect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function (host, ...rest) { if (!loopback(host)) { note("lookup " + String(host)); throw new Error("blocked lookup"); } return lookup.call(this, host, ...rest); };
if (globalThis.fetch) globalThis.fetch = (...args) => { note("fetch " + String(args[0]).slice(0, 60)); throw new Error("blocked fetch"); };
`;

// A child run of THIS file re-runs its offline tests; it must never spawn children of its own.
describe.skipIf(process.env.CHALLENGE_PURGE_CHILD === "1")("process-level gates: a real child Vitest process, synthetic .invalid values only, outbound network blocked and logged", () => {
  const PROCESS_TIMEOUT_MS = 120_000;
  const SYN = { runId: "c0ffee00", endpointId: "ep-synthetic-000009", hostname: "ep-synthetic-000009-pooler.c-1.neon.invalid", branchId: "br-synthetic-branch-000001", parentBranchId: "br-synthetic-parent-000002" };
  const SYN_CREDENTIAL = "synthetic-credential-do-not-print";
  const SYN_URL = `postgresql://app:${SYN_CREDENTIAL}@${SYN.hostname}/neondb?sslmode=require`;
  const identity = computeIdentity((file) => readFileSync(file, "utf8"));
  const confirmation = (perf = false) => expectedConfirmation(identity, { ...SYN, perf });
  let work = "";
  let blocker = "";
  let sequence = 0;

  beforeAll(() => {
    work = mkdtempSync(path.join(tmpdir(), "cps-gate-"));
    blocker = path.join(work, "block-network.cjs");
    writeFileSync(blocker, NETWORK_BLOCKER_SOURCE);
  });
  // This describe's own temporary directory only (its name is minted above), removed whether the tests passed or not.
  afterAll(() => {
    if (work.startsWith(path.join(tmpdir(), "cps-gate-"))) rmSync(work, { recursive: true, force: true });
  });

  /** Every synthetic target setting except the gate and the confirmation. */
  const target = (): Record<string, string> => ({
    NEON_BRANCH_DATABASE_URL: SYN_URL,
    [EXPECTED_ENDPOINT_ENV]: SYN.endpointId,
    [ENV.runId]: SYN.runId,
    [ENV.branch]: SYN.branchId,
    [ENV.parent]: SYN.parentBranchId,
    [ENV.host]: SYN.hostname,
  });

  /**
   * A child Vitest with ONLY an allow-list of plain process variables plus the given ones. Nothing else is inherited — no smoke gate, no
   * database setting, no credential or session token, and none of the agent-detection variables that make Vitest hide console output.
   */
  const CHILD_ENV_ALLOW = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "SHELL"] as const;
  function runChild(args: string[], extra: Record<string, string>): Promise<{ code: number; output: string; attempts: string }> {
    const env: Record<string, string> = {};
    for (const name of CHILD_ENV_ALLOW) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    const log = path.join(work, `network-${(sequence += 1)}.log`);
    Object.assign(env, { CHALLENGE_PURGE_CHILD: "1", NODE_OPTIONS: `--require ${blocker}`, NET_BLOCK_LOG: log, NO_COLOR: "1", FORCE_COLOR: "0" }, extra);
    return new Promise((resolve) => {
      execFile(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...args], { env: env as NodeJS.ProcessEnv, timeout: PROCESS_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, output: `${stdout}\n${stderr}`, attempts: existsSync(log) ? readFileSync(log, "utf8") : "" });
      });
    });
  }

  const REFUSAL = /Challenge purge proof refused before any database work: /;
  /** What a real connection attempt would print, and the line the live suite prints only after every gate passed. */
  const CONNECTION_ATTEMPT = /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|getaddrinfo|NeonDbError|WebSocket|gates passed; connecting/i;
  const summary = (output: string) => /Tests\s+([^\n]*)/.exec(output)?.[1] ?? "";
  /** Nothing about the target may ever be printed, whatever the outcome. */
  const expectNoTargetLeak = (output: string) => {
    expect(output).not.toContain(SYN_CREDENTIAL);
    expect(output).not.toContain("postgresql://");
    expect(output).not.toContain(SYN.hostname);
  };
  const expectRefused = (result: { code: number; output: string; attempts: string }, reason: RegExp) => {
    expect(result.code, summary(result.output)).not.toBe(0);
    expect(result.output).toMatch(REFUSAL);
    expect(result.output).toMatch(reason);
    expect(result.output).toMatch(/Test Files\s+1 failed/);
    expect(result.output).not.toMatch(CONNECTION_ATTEMPT);
    expect(result.attempts, "no connection or lookup was attempted").toBe("");
    expectNoTargetLeak(result.output);
  };
  // Whether .env.local exists decides only how early the real-endpoint comparison refuses; either way the run is refused before any connection.
  const AFTER_TARGET_CHECK = (reason: string) => new RegExp(`(${reason}|\\.env\\.local)`);

  it("the network blocker itself logs and blocks a fetch, a socket connection and a DNS lookup, so an empty log in the tests below means something", async () => {
    const log = path.join(work, "self-test.log");
    await new Promise<void>((resolve) =>
      execFile(
        process.execPath,
        ["--require", blocker, "-e", 'try { fetch("https://example.invalid/x"); } catch {} try { require("net").connect(80, "203.0.113.1"); } catch {} try { require("dns").lookup("example.invalid", () => {}); } catch {}'],
        { env: { PATH: process.env.PATH ?? "", NET_BLOCK_LOG: log } as unknown as NodeJS.ProcessEnv, timeout: 30_000 },
        () => resolve(),
      ),
    );
    const text = existsSync(log) ? readFileSync(log, "utf8") : "";
    expect(text).toMatch(/^fetch https:\/\/example\.invalid/m);
    expect(text).toMatch(/^connect 203\.0\.113\.1/m); // a documentation-range IP literal: refused before any packet is sent
    expect(text).toMatch(/^lookup example\.invalid/m);
  }, 60_000);

  describe.concurrent("a set gate without a complete, correctly confirmed authorization FAILS the run — never a silent skip, never a connection", () => {
    it("A1. the gate alone: nonzero exit, explicit refusal, no connection", async () => {
      expectRefused(await runChild([SMOKE_FILE], { [GATE]: "1" }), /CHALLENGE_PURGE_SMOKE_RUN_ID must be exactly 8 lowercase hex/);
    }, PROCESS_TIMEOUT_MS);

    it("A2. the gate and every synthetic target setting but NO confirmation: nonzero exit, refused before any connection", async () => {
      expectRefused(await runChild([SMOKE_FILE], { [GATE]: "1", ...target() }), AFTER_TARGET_CHECK("CHALLENGE_PURGE_SMOKE_CONFIRM is not set"));
    }, PROCESS_TIMEOUT_MS);

    it("B. a WRONG confirmation for otherwise correct synthetic settings: refused before any connection", async () => {
      expectRefused(await runChild([SMOKE_FILE], { [GATE]: "1", ...target(), [ENV.confirm]: `${SYN.runId}:0000000000000000` }), AFTER_TARGET_CHECK("does not match this run id, target, mode, and source identity"));
    }, PROCESS_TIMEOUT_MS);

    it("C1. a wider file selection (a path filter that matches more than this file) cannot enable the suite, even with a CORRECT confirmation", async () => {
      const result = await runChild(["test/lib/real/challenge-store-bounded-purge"], { [GATE]: "1", ...target(), [ENV.confirm]: confirmation() });
      expect(result.code, summary(result.output)).not.toBe(0);
      expect(result.output).toMatch(REFUSAL);
      expect(result.output).toMatch(/exact path/);
      expect(result.output).not.toMatch(CONNECTION_ATTEMPT);
      expect(result.attempts).toBe("");
      expectNoTargetLeak(result.output);
    }, PROCESS_TIMEOUT_MS);

    it("C2. a test-name filter (which could skip a decisive case) cannot enable the suite either", async () => {
      const result = await runChild([SMOKE_FILE, "-t", "P2"], { [GATE]: "1", ...target(), [ENV.confirm]: confirmation() });
      expect(result.code, summary(result.output)).not.toBe(0);
      expect(result.output).toMatch(REFUSAL);
      expect(result.output).toMatch(/exact path/);
      expect(result.output).not.toMatch(CONNECTION_ATTEMPT);
      expect(result.attempts).toBe("");
      expectNoTargetLeak(result.output);
    }, PROCESS_TIMEOUT_MS);
  });

  describe.concurrent("without the gate nothing live runs, whatever else is exported", () => {
    it.each([["unset", undefined], ['"true" (not exactly "1")', "true"], ['"0"', "0"]])("D. complete synthetic settings and a CORRECT confirmation, gate %s: the live cases are skipped, exit 0, no connection", async (_label, gate) => {
      const result = await runChild([SMOKE_FILE], { ...(gate === undefined ? {} : { [GATE]: gate }), ...target(), [ENV.confirm]: confirmation() });
      expect(result.code, summary(result.output)).toBe(0);
      expect(summary(result.output)).toMatch(/passed/);
      expect(summary(result.output)).toMatch(/(\d+) skipped/);
      expect(Number(/(\d+) skipped/.exec(summary(result.output))?.[1])).toBeGreaterThanOrEqual(10);
      expect(summary(result.output)).not.toMatch(/failed/);
      expect(result.output).not.toMatch(REFUSAL);
      expect(result.output).not.toMatch(CONNECTION_ATTEMPT);
      expect(result.attempts).toBe("");
      expectNoTargetLeak(result.output);
    }, PROCESS_TIMEOUT_MS);
  });

  describe.concurrent("the supported confirmation-print invocation", () => {
    const syntheticFiles: ActiveEnvFiles = { envLocalText: "DATABASE_URL=postgres://u:p@ep-real-thing-111111.us-east-2.aws.neon.tech/neondb\n", otherEnvFiles: {} };
    const emptyFs: EvidenceFs = { list: () => [], read: () => "" };
    const printed = (output: string): string | null => /CHALLENGE_PURGE_SMOKE_CONFIRM=([0-9a-f]{8}:[0-9a-f]{16})/.exec(output)?.[1] ?? null;
    const authorizeOffline = (confirm: string, perf: boolean) =>
      authorizeLiveRun({
        env: { [GATE]: "1", ...target(), [ENV.confirm]: confirm, ...(perf ? { [ENV.perf]: "1" } : {}) },
        files: syntheticFiles,
        cliArgs: ["run", SMOKE_FILE],
        identity,
        evidenceDirectory: "evidence",
        evidenceFs: emptyFs,
      });

    it.each([[false], [true]])("E. printing the confirmation (PERF=%s) is bound to the supplied run parameters, the same authorization logic accepts it OFFLINE, and nothing connects, runs live, or leaks", async (perf) => {
      // The print invocation reads the target settings but takes NO gate and opens NO connection; the URL is supplied only to prove it is never printed.
      const result = await runChild([SMOKE_FILE], { [ENV.print]: "1", ...target(), ...(perf ? { [ENV.perf]: "1" } : {}) });
      expect(result.code, summary(result.output)).toBe(0);
      const token = printed(result.output);
      expect(token, "the confirmation line was printed").not.toBeNull();
      // Bound to exactly the supplied parameters (and to the mode): equal to the independent in-process computation, and different from every neighbour.
      expect(token).toBe(confirmation(perf));
      expect(token).not.toBe(confirmation(!perf));
      expect(token).not.toBe(expectedConfirmation(identity, { ...SYN, perf, runId: "c0ffee01" }));
      expect(token).not.toBe(expectedConfirmation(identity, { ...SYN, perf, branchId: "br-synthetic-branch-000009" }));
      // The very same authorization logic recognizes it (a pure function over synthetic values — the connector is never reached).
      const accepted = authorizeOffline(token!, perf);
      expect(accepted.ok, accepted.ok ? "" : accepted.reason).toBe(true);
      expect(authorizeOffline(token!, !perf).ok).toBe(false);
      // No connection, no live case, no URL or credential, and no gate-passed line.
      expect(result.attempts).toBe("");
      expect(result.output).not.toMatch(REFUSAL);
      expect(result.output).not.toMatch(CONNECTION_ATTEMPT);
      expect(summary(result.output)).toMatch(/(\d+) skipped/);
      expect(summary(result.output)).not.toMatch(/failed/);
      expectNoTargetLeak(result.output);
      expect(result.output).not.toContain("ep-synthetic");
    }, PROCESS_TIMEOUT_MS);

    it("E2. printing with a malformed value is refused (nonzero), prints no confirmation, and connects to nothing", async () => {
      const result = await runChild([SMOKE_FILE], { [ENV.print]: "1", ...target(), [ENV.branch]: "not-a-branch" });
      expect(result.code).not.toBe(0);
      expect(printed(result.output)).toBeNull();
      expect(result.attempts).toBe("");
      expectNoTargetLeak(result.output);
    }, PROCESS_TIMEOUT_MS);
  });
});

// ------------------------------------------------------------------------------------------------ print the confirmation (connects to nothing)

describe.skipIf(process.env[ENV.print] !== "1")("challenge purge proof — print the operator confirmation (no connection)", () => {
  it("prints the confirmation string for the supplied run, target and mode", () => {
    const identity = computeIdentity((file) => readFileSync(file, "utf8"));
    const env = process.env;
    const target = { runId: String(env[ENV.runId]), endpointId: String(env[EXPECTED_ENDPOINT_ENV]), branchId: String(env[ENV.branch]), parentBranchId: String(env[ENV.parent]), hostname: String(env[ENV.host]), perf: env[ENV.perf] === "1" };
    if (!RUN_ID_SHAPE.test(target.runId) || !ENDPOINT_ID_SHAPE.test(target.endpointId) || !BRANCH_ID_SHAPE.test(target.branchId) || !BRANCH_ID_SHAPE.test(target.parentBranchId) || !HOST_SHAPE.test(target.hostname)) throw new Error("challenge purge proof: the values supplied for the confirmation are malformed");
    console.log(`[challenge-purge-proof] ${ENV.confirm}=${expectedConfirmation(identity, target)}  (source digest ${identity.digest.slice(0, 16)})`);
  });
});

// ------------------------------------------------------------------------------------------------ LIVE (skipped unless every gate is set)

describe.skipIf(!enabled)("challenge purge proof — bounded WebAuthn challenge purge on a DISPOSABLE Neon branch ONLY", () => {
  let session: Session | null = null;
  let started = false;

  beforeAll(async () => {
    // 1. Every gate, before any connection. A refusal FAILS the run; it is never a silent green skip.
    const identity = computeIdentity((file) => readFileSync(file, "utf8"));
    const authorization = authorizeLiveRun({ env: process.env, files: readActiveEnvFiles(), cliArgs: inject("vitestCliArgs"), identity, evidenceDirectory: EVIDENCE_DIRECTORY });
    if (!authorization.ok) throw new Error(`Challenge purge proof refused before any database work: ${authorization.reason}`);
    const { config } = authorization;
    // 2. The code about to run is the audited code.
    const captured = await captureProductionSql();
    const pinned = checkProductionSql(captured);
    if (!pinned.ok) throw new Error(`Challenge purge proof refused before any database work: ${pinned.reason}`);
    const repository = readRepositoryHead();
    if (!repository.ok) throw new Error(`Challenge purge proof refused before any database work: ${repository.reason}`);
    const ddl = scratchDdl(readFileSync(SCHEMA_PATH, "utf8"), `pb_smoke_${config.runId}_main`);
    // 3. Only now is a connection opened. Nothing printed here names the target.
    console.log(`[challenge-purge-proof] gates passed; mode=${config.perf ? "correctness+performance" : "correctness"}; connecting`);
    started = true;
    const driver = await openLiveDriver(config.url);
    session = createSession({
      runId: config.runId,
      driver,
      timing: LIVE_TIMING,
      perf: config.perf,
      production: captured,
      ddl,
      target: { branchId: config.branchId, parentBranchId: config.parentBranchId, endpointFingerprint: fingerprint(config.endpointId), hostFingerprint: fingerprint(config.hostname), connectionMode: "pooled" },
      provenance: {
        status: TARGET_PROOF_STATUS,
        repository: { branch: repository.branch, commit: repository.commit },
        sourceIdentity: identity,
        fileHashes: Object.fromEntries(EVIDENCE_FILES.map((file) => [file, sha256Hex(readFileSync(file, "utf8"))])),
      },
      save: (stage, evidence) => writeEvidence(EVIDENCE_DIRECTORY, config.runId, stage, evidence),
    });
    await session.runPreflight();
  }, VITEST_TIMEOUT_MS);

  afterEach((context) => {
    if (started && session) session.afterCase(caseFailedInVitest(context));
  }, VITEST_TIMEOUT_MS);

  // Every expected case is registered here, in order, through the same runCase; none can be skipped silently.
  const perf = process.env[ENV.perf] === "1";
  for (const entry of CASES.filter((candidate) => perf || candidate.optional !== "perf")) {
    it(entry.title, async () => {
      if (!session) throw new Error("the session was never established");
      await session.runCase(entry.id);
    }, VITEST_TIMEOUT_MS);
  }

  afterAll(async () => {
    if (!started || !session) return;
    const final = await session.finish();
    const verdict = concludeRun(final as Parameters<typeof concludeRun>[0]);
    console.log(`[challenge-purge-proof] verdict: ${verdict.verdict}`);
    if (!verdict.pass) throw new Error(`${verdict.message} Inspect the disposable branch read-only; do not reuse it.`);
  }, VITEST_TIMEOUT_MS + CLEANUP_DEADLINE_MS);
});
