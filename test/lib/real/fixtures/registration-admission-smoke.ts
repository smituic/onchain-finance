import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RegistrationAdmissionError, type RegistrationAdmissionErrorKind } from "@/lib/real/server/registration-admission";
import {
  CASE_DEADLINE_MS,
  CLEANUP_DEADLINE_MS,
  SCHEMA_EXTERNAL_DEPENDENCIES_SQL,
  SCHEMA_INVENTORY_SQL,
  SCHEMA_RESIDUE_SQL,
  VITEST_TIMEOUT_MS,
  checkRunnerTimeoutFlags,
  dropObjectStatement,
  dropSchemaStatement,
  runCleanupPlan,
  sha256Hex,
  summarizeCleanup,
  type CleanupAccount,
  type CleanupGate,
  type CleanupStep,
  type CleanupSummary,
  type DatabaseSnapshot,
  type EvidenceWrite,
  type ProviderTableDescriptor,
  type RunOwnership,
  type Statement,
} from "./provider-budget-smoke";
import { assertPlainIdentifier, caseFailedInVitest, checkExactFileSelection, requirePooledMode, safeEvidenceJson, type QueryDb, type SelectionCheck } from "./provisioning-limits-smoke";

/**
 * TEST-ONLY, PURE safety foundation for a FUTURE disposable-Neon smoke of the
 * global registration-admission table and its two statements (Milestone 3C-1).
 * Nothing here connects, reads the environment, or imports a database driver or
 * a provider module, so every rule can be proven offline
 * (registration-admission-smoke-harness.test.ts).
 *
 * NOTHING IN THIS FILE HAS BEEN RUN AGAINST POSTGRESQL. Every SQL text below —
 * the fixture writes, the catalog reads, the activity polls — is unexecuted.
 * Their first execution belongs to a later, separately authorized live run. If
 * one is wrong, the database refuses it, the run is poisoned, and its evidence
 * is preserved.
 *
 * It reuses, unchanged, the audited Milestone 1 / 3A pieces that are not about
 * provider budgets: the exact-file rule, the runner-timeout rule, the pooled-
 * mode rule, the scratch-schema ownership registry and its RESTRICT-only drop
 * statements, the cleanup runner, the evidence content screen, and the snapshot
 * types. What it adds is specific to this slice: the admission outcome
 * classification, the run lifecycle for it, the few fixture statements that
 * touch the one public singleton row, and the expected-delta comparison.
 *
 * WHAT THE RUN LEAVES BEHIND. Not the baseline: the baseline PLUS the expected
 * delta — public.real_registration_admission now exists, with the intended
 * structure and EXACTLY the seed row (both counters 0, both windows at the
 * epoch). It is never reported as "restored".
 */

// ------------------------------------------------------------------ reused, audited helpers — behaviour unchanged

export { CASE_DEADLINE_MS, CLEANUP_DEADLINE_MS, VITEST_TIMEOUT_MS, assertPlainIdentifier, caseFailedInVitest, checkRunnerTimeoutFlags, requirePooledMode, safeEvidenceJson, sha256Hex };

/** The live smoke's path. Vitest must have been started as exactly `vitest run <this file>`. */
export const REGISTRATION_ADMISSION_SMOKE_FILE = "test/lib/real/registration-admission.smoke.test.ts";

export function checkRegistrationAdmissionFileSelection(cliArgs: unknown): SelectionCheck {
  return checkExactFileSelection(cliArgs, REGISTRATION_ADMISSION_SMOKE_FILE);
}

// ------------------------------------------------------------------ bounds

/** Hard, CUMULATIVE ceilings on what one run may ever issue. Never refilled; a run that reaches one is poisoned. */
export const MAX_RUN_OPERATIONS = 1_500;
/** The most admission requests ever in flight at once (the largest scenario is 60). */
export const MAX_CONCURRENCY = 60;
/** The most test-fixture writes to the public singleton row (set, backdate, holder, delete, rename) in one run. */
export const MAX_ROW_FIXTURE_WRITES = 60;
/** The most polls of pg_stat_activity in one run (each is one read). */
export const MAX_ACTIVITY_POLLS = 80;

const RUN_ID = /^[0-9a-f]{8}$/;
const SQL_STATE = /^[0-9A-Z]{5}$/;
const TABLE = "real_registration_admission";

// ------------------------------------------------------------------ the fixture statements (ALL of them; the smoke file builds no UPDATE, DELETE, or DROP of its own)

/**
 * The ONLY writes this harness makes to the public singleton row, besides the
 * unmodified migration block. They run on a DISPOSABLE branch only, they name
 * the one table and the one scope as literals, and each is issued through a
 * lifecycle write that counts against MAX_ROW_FIXTURE_WRITES.
 */

/** Sets all four fields. An age is "seconds before the database's now()"; NULL means the epoch (the seed's start); a negative age is a start in the FUTURE. */
export const SET_ROW_SQL = `UPDATE public.${TABLE} SET short_window_start = CASE WHEN $1::int IS NULL THEN 'epoch'::timestamptz ELSE now() - make_interval(secs => $1::int) END, short_hits = $2::int, day_window_start = CASE WHEN $3::int IS NULL THEN 'epoch'::timestamptz ELSE now() - make_interval(secs => $3::int) END, day_hits = $4::int WHERE scope = 'register_options' RETURNING scope`;
/** Moves ONLY the short window's start back by $1 seconds. */
export const BACKDATE_SHORT_SQL = `UPDATE public.${TABLE} SET short_window_start = short_window_start - make_interval(secs => $1::int) WHERE scope = 'register_options' RETURNING scope`;
/** Moves ONLY the daily window's start back by $1 seconds. */
export const BACKDATE_DAY_SQL = `UPDATE public.${TABLE} SET day_window_start = day_window_start - make_interval(secs => $1::int) WHERE scope = 'register_options' RETURNING scope`;
/** Removes the singleton row (the missing-row case; it is used once). */
export const REMOVE_ROW_SQL = `DELETE FROM public.${TABLE} WHERE scope = 'register_options' RETURNING scope`;
export const RENAME_AWAY_SQL = `ALTER TABLE public.${TABLE} RENAME TO ${TABLE}_moved`;
export const RENAME_BACK_SQL = `ALTER TABLE public.${TABLE}_moved RENAME TO ${TABLE}`;

/**
 * A lock-holding transaction for the READ COMMITTED race cases. ONE batch, ONE
 * transaction: a single UPDATE that takes the row's tuple lock, then a sleep
 * that keeps it. The sleep is a whole number of seconds chosen by the caller
 * (validated here); the lock is released when the batch commits.
 */
export function holderStatements(change: "exhaust" | "roll_short", sleepSeconds: number): string[] {
  if (!Number.isSafeInteger(sleepSeconds) || sleepSeconds < 1 || sleepSeconds > 30) throw new Error("registration admission smoke: a holder may sleep 1 to 30 whole seconds");
  const update =
    change === "exhaust"
      ? `UPDATE public.${TABLE} SET short_hits = 30, day_hits = 30 WHERE scope = 'register_options'`
      : `UPDATE public.${TABLE} SET short_window_start = now() - make_interval(secs => 7200), short_hits = 30 WHERE scope = 'register_options'`;
  return [update, `SELECT pg_catalog.pg_sleep(${sleepSeconds})`];
}

// ------------------------------------------------------------------ the reads (all READ-ONLY)

export const READ_ROW_SQL = `SELECT short_hits, day_hits, short_window_start = 'epoch'::timestamptz AS short_at_epoch, day_window_start = 'epoch'::timestamptz AS day_at_epoch, extract(epoch FROM (now() - short_window_start))::float8 AS short_age, extract(epoch FROM (now() - day_window_start))::float8 AS day_age, short_window_start::text AS short_start, day_window_start::text AS day_start, xmin::text AS row_xmin, ctid::text AS row_ctid FROM public.${TABLE} WHERE scope = 'register_options'`;
export const COUNT_ROWS_SQL = `SELECT count(*)::int AS n FROM public.${TABLE}`;
/** Another session, in this database, running a sleep statement: the lock holder is holding. */
export const HOLDER_ACTIVE_SQL = `SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE datname = pg_catalog.current_database() AND pid <> pg_catalog.pg_backend_pid() AND state = 'active' AND query LIKE '%pg_sleep%' AND query NOT LIKE '%pg_stat_activity%'`;
/** Another session, in this database, waiting on a lock while running an admission UPDATE: the racing request is really blocked. The text is matched with leading whitespace allowed, because a tagged template reaches the server with its own leading newline. */
export const WAITER_BLOCKED_SQL = `SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE datname = pg_catalog.current_database() AND pid <> pg_catalog.pg_backend_pid() AND wait_event_type = 'Lock' AND query ~ '^\\s*UPDATE ${TABLE} AS a'`;
/** This session can see its own entry (so the two polls above can see others'). */
export const CAN_SEE_ACTIVITY_SQL = `SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE pid = pg_catalog.pg_backend_pid()`;

// ------------------------------------------------------------------ what a database answer means

type Settled = { status: "fulfilled"; value: unknown } | { status: "rejected"; reason: unknown };

const sqlStateOf = (error: unknown): string | null => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && SQL_STATE.test(code) ? code : null;
};
const constraintOf = (error: unknown): string | null => {
  const reason = error as { constraint?: unknown; message?: unknown } | null;
  const named = reason && typeof reason.constraint === "string" && reason.constraint ? reason.constraint : (/constraint "([a-z0-9_]+)"/.exec(String(reason?.message ?? ""))?.[1] ?? null);
  return named && /^[a-z0-9_]+$/.test(named) ? named : null;
};

/**
 * How one admission request ended. Only `admitted` and `denied` are admission
 * answers. Everything else is an explicit non-answer and is NEVER counted as a
 * denial:
 *   admission_error  the application's own fail-closed error (a missing row, a malformed state, a bad policy).
 *   database_error   Postgres itself answered with an error: the statement did not apply.
 *   no_answer        nothing recognisable came back: the charge may or may not have been made.
 * Carries no driver text: a SQLSTATE and a constraint name, or the application's error KIND.
 */
export type AdmissionOutcome =
  | { kind: "admitted" }
  | { kind: "denied"; retryAfterSeconds: number }
  | { kind: "admission_error"; errorKind: RegistrationAdmissionErrorKind }
  | { kind: "database_error"; sqlState: string; constraint: string | null }
  | { kind: "no_answer" };

export function classifyAdmission(settled: Settled): AdmissionOutcome {
  if (settled.status === "fulfilled") {
    const value = settled.value as { admitted?: unknown; retryAfterSeconds?: unknown } | null;
    if (value && typeof value === "object") {
      const keys = Object.keys(value).sort().join(",");
      if (value.admitted === true && keys === "admitted") return { kind: "admitted" };
      if (value.admitted === false && keys === "admitted,retryAfterSeconds" && Number.isSafeInteger(value.retryAfterSeconds) && (value.retryAfterSeconds as number) >= 1) return { kind: "denied", retryAfterSeconds: value.retryAfterSeconds as number };
    }
    return { kind: "no_answer" };
  }
  if (settled.reason instanceof RegistrationAdmissionError) return { kind: "admission_error", errorKind: settled.reason.kind };
  const sqlState = sqlStateOf(settled.reason);
  if (sqlState !== null) return { kind: "database_error", sqlState, constraint: constraintOf(settled.reason) };
  return { kind: "no_answer" };
}

export function tallyOutcomes(outcomes: readonly AdmissionOutcome[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) counts[outcome.kind] = (counts[outcome.kind] ?? 0) + 1;
  return counts;
}

// ------------------------------------------------------------------ scratch-schema cleanup (the only cleanup this run has)

/**
 * The whole cleanup, planned from the ownership registry alone: READ-ONLY
 * admission of every scratch schema (inventory, then boundary dependencies),
 * then per schema its registered objects in reverse order and the schema itself
 * (RESTRICT only, never CASCADE), then ONE read-only residue read by exact
 * names. There are no subjects and no rows of this run to delete: the public
 * table the run created is the expected delta, and stays.
 */
export function planAdmissionCleanup(ownership: RunOwnership): CleanupAccount {
  const step = (action: CleanupStep["action"], target: string, writes: boolean, statement: Statement): CleanupStep => ({ action, target, writes, statement, outcome: "not_attempted", sqlState: null, rows: null });
  const steps: CleanupStep[] = [];
  const schemas = ownership.ownedSchemas();
  for (const schema of schemas) {
    ownership.assertOwnedSchema(schema);
    steps.push(step("inspect_inventory", schema, false, { text: SCHEMA_INVENTORY_SQL, params: [schema] }));
    steps.push(step("inspect_dependencies", schema, false, { text: SCHEMA_EXTERNAL_DEPENDENCIES_SQL, params: [schema] }));
  }
  for (const schema of schemas) {
    for (const object of ownership.objectsOf(schema).reverse()) steps.push(step("drop_object", `${schema}.${object.name}`, true, dropObjectStatement(ownership, schema, object)));
    steps.push(step("drop_schema", schema, true, dropSchemaStatement(ownership, schema)));
  }
  steps.push(step("read_schema_residue", "owned schemas", false, { text: SCHEMA_RESIDUE_SQL, params: [schemas] }));
  return { steps, stopped: null, refusal: null };
}

// ------------------------------------------------------------------ baseline plus expected delta

export type AdmissionTableDescriptor = ProviderTableDescriptor;

/** The one table a clean run leaves behind, as the post-run read must describe it — holding exactly the seed row. Structure only: the CHECKs' bounds are proven by the live cases that insert against them. */
export const EXPECTED_ADMISSION_TABLE: AdmissionTableDescriptor = {
  columns: [
    { name: "scope", type: "text", notNull: true, collation: "C" },
    { name: "short_window_start", type: "timestamp with time zone", notNull: true, collation: null },
    { name: "short_hits", type: "integer", notNull: true, collation: null },
    { name: "day_window_start", type: "timestamp with time zone", notNull: true, collation: null },
    { name: "day_hits", type: "integer", notNull: true, collation: null },
  ],
  constraints: [
    { name: "real_registration_admission_day_hits_check", type: "c", columns: ["day_hits"] },
    { name: "real_registration_admission_pkey", type: "p", columns: ["scope"] },
    { name: "real_registration_admission_scope_check", type: "c", columns: ["scope"] },
    { name: "real_registration_admission_short_hits_check", type: "c", columns: ["short_hits"] },
  ],
  indexes: ["real_registration_admission_pkey"],
  triggers: 0,
  foreignKeysOut: 0,
  foreignKeysIn: 0,
  policies: 0,
  rowSecurity: false,
  rows: 1,
};

/** The seed row, as the final read must find it: both counters 0 and both windows at the epoch. */
export type SeedRow = { shortHits: number; dayHits: number; shortAtEpoch: boolean; dayAtEpoch: boolean };
export const EXPECTED_SEED_ROW: SeedRow = { shortHits: 0, dayHits: 0, shortAtEpoch: true, dayAtEpoch: true };

export const DELTA_MEASURED = ["every public table's row count, content digest, and shape digest", "the names of the non-system schemas", `the structure and row count of public.${TABLE}`, "the singleton row's two counters and two window starts"] as const;
/** Said out loud in every verdict, so a clean run is never read as more than it measured. */
export const DELTA_NOT_MEASURED = ["functions, sequences, views, types, and extensions", "roles, grants, and database settings", "the contents of any schema other than public", "anything another session changed and changed back during the run"] as const;

export type DeltaVerdict = {
  ok: boolean;
  /** `baseline_plus_expected_delta` is the ONLY clean verdict. The table the run added remains, so the database is never "restored". */
  verdict: "baseline_plus_expected_delta" | "delta_mismatch";
  differences: string[];
  expectedDelta: { tableAdded: string; rows: 1; seedRow: SeedRow };
  measured: readonly string[];
  notMeasured: readonly string[];
};

const isFingerprint = (value: unknown): boolean => {
  const f = value as { rows?: unknown; contentDigest?: unknown; shapeDigest?: unknown } | null;
  return !!f && typeof f === "object" && Number.isSafeInteger(f.rows) && (f.rows as number) >= 0 && typeof f.contentDigest === "string" && typeof f.shapeDigest === "string" && f.shapeDigest !== "";
};
const isSnapshot = (value: unknown): value is DatabaseSnapshot => {
  const s = value as DatabaseSnapshot | null;
  return !!s && typeof s === "object" && !!s.tables && typeof s.tables === "object" && Object.values(s.tables).every(isFingerprint) && Array.isArray(s.schemas) && s.schemas.every((name) => typeof name === "string") && new Set(s.schemas).size === s.schemas.length;
};
const canonicalDescriptor = (descriptor: AdmissionTableDescriptor): string =>
  JSON.stringify({
    columns: descriptor.columns.map((column) => [column.name, column.type, column.notNull, column.collation]),
    constraints: [...descriptor.constraints].map((constraint) => [constraint.name, constraint.type, constraint.columns]).sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
    indexes: [...descriptor.indexes].sort(),
    counts: [descriptor.triggers, descriptor.foreignKeysOut, descriptor.foreignKeysIn, descriptor.policies, descriptor.rowSecurity, descriptor.rows],
  });
const sameSeed = (a: unknown, b: SeedRow): boolean => {
  const s = a as SeedRow | null;
  return !!s && s.shortHits === b.shortHits && s.dayHits === b.dayHits && s.shortAtEpoch === b.shortAtEpoch && s.dayAtEpoch === b.dayAtEpoch;
};

/**
 * Compares the post-run database with its pre-run baseline, EXPECTING exactly
 * one difference: `public.real_registration_admission` now exists, has the
 * intended structure, and holds exactly the seed row. Everything else that was
 * measured must be identical. Anything unreadable or malformed is a mismatch,
 * never a pass.
 */
export function compareWithExpectedAdmissionDelta(input: { before: unknown; after: unknown; admissionTable: unknown; seedRow: unknown; ownedSchemas: readonly string[] }): DeltaVerdict {
  const differences: string[] = [];
  const done = (): DeltaVerdict => ({ ok: differences.length === 0, verdict: differences.length === 0 ? "baseline_plus_expected_delta" : "delta_mismatch", differences, expectedDelta: { tableAdded: `public.${TABLE}`, rows: 1, seedRow: EXPECTED_SEED_ROW }, measured: DELTA_MEASURED, notMeasured: DELTA_NOT_MEASURED });
  if (!isSnapshot(input.before) || !isSnapshot(input.after)) {
    differences.push("a snapshot is missing or malformed");
    return done();
  }
  const { before, after } = input;
  const has = (snapshot: DatabaseSnapshot, table: string) => Object.hasOwn(snapshot.tables, table);
  if (has(before, TABLE)) differences.push(`baseline: public.${TABLE} already existed before the run`);
  if (!has(before, "real_rate_limits")) differences.push("baseline: public.real_rate_limits was not measured before the run");
  for (const schema of input.ownedSchemas) if (before.schemas.includes(schema)) differences.push("baseline: a run-owned scratch schema existed before the run");
  for (const table of Object.keys(before.tables).sort()) {
    if (table === TABLE) continue;
    if (!has(after, table)) {
      differences.push(`table removed: ${table}`);
      continue;
    }
    const was = before.tables[table]!;
    const is = after.tables[table]!;
    if (was.shapeDigest !== is.shapeDigest) differences.push(`catalog shape changed: ${table}`);
    if (was.rows !== is.rows || was.contentDigest !== is.contentDigest) differences.push(`contents changed: ${table}`);
  }
  for (const table of Object.keys(after.tables).sort()) if (table !== TABLE && !has(before, table)) differences.push(`unexpected new table: ${table}`);
  if (!has(after, TABLE)) differences.push(`expected delta missing: public.${TABLE} does not exist after the run`);
  else if (after.tables[TABLE]!.rows !== 1) differences.push(`expected delta wrong: public.${TABLE} does not hold exactly one row`);
  let described: string | null = null;
  try {
    described = canonicalDescriptor(input.admissionTable as AdmissionTableDescriptor);
  } catch {
    described = null;
  }
  if (described !== canonicalDescriptor(EXPECTED_ADMISSION_TABLE)) differences.push(`expected delta wrong: public.${TABLE} does not match the intended descriptor (structure, or not one row)`);
  if (!sameSeed(input.seedRow, EXPECTED_SEED_ROW)) differences.push(`expected delta wrong: the singleton row is not the seed (both counters 0, both windows at the epoch)`);
  for (const schema of input.ownedSchemas) if (after.schemas.includes(schema)) differences.push("a run-owned scratch schema remains");
  if ([...before.schemas].sort().join("\n") !== [...after.schemas].sort().join("\n")) differences.push("the set of schemas changed");
  return done();
}

// ------------------------------------------------------------------ evidence

export const START_EVIDENCE_FIELDS = ["runId", "server", "connectionMode", "migrationStatementSha256", "expectedCases", "fingerprintsBefore"] as const;
export const FINAL_EVIDENCE_FIELDS = [
  "runId",
  "lifecycleOutcome",
  "server",
  "connectionMode",
  "migrationStatementSha256",
  "casesExecuted",
  "casesNotExecuted",
  "admissionTallies",
  "schemaRefusals",
  "rowSnapshots",
  "cleanup",
  "fingerprintsBefore",
  "fingerprintsAfter",
  "expectedDelta",
  "writes",
  "unknownOperations",
  "inFlightOperations",
  "verdict",
] as const;
export type EvidenceStage = "start" | "final";

export function missingEvidenceFields(stage: EvidenceStage, evidence: unknown): string[] {
  const required: readonly string[] = stage === "start" ? START_EVIDENCE_FIELDS : FINAL_EVIDENCE_FIELDS;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return [...required];
  const record = evidence as Record<string, unknown>;
  const missing = required.filter((field) => !Object.hasOwn(record, field) || record[field] === undefined);
  if (!missing.includes("runId") && (typeof record.runId !== "string" || !RUN_ID.test(record.runId))) missing.push("runId");
  if (!missing.includes("migrationStatementSha256") && (typeof record.migrationStatementSha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.migrationStatementSha256))) missing.push("migrationStatementSha256");
  return missing;
}

/** On top of the shared content screen (which this never loosens): token-like material is refused too. */
const UNSAFE_EXTRA = /token|bearer|authorization|credential/i;

export type EvidenceResult = EvidenceWrite;

/**
 * Saves one evidence record as `<directory>/registration-admission-smoke-<run id>-<stage>.json`.
 * The name is built from a validated run id and a fixed stage word; the record
 * must be complete for its stage and pass the content screen; the directory
 * must be the owner's alone (created 0700 if absent — an existing one that
 * others can enter is REFUSED, never re-permissioned); the file is created
 * exclusively (an existing file is never overwritten) with mode 0600, and that
 * mode is read back. Returns a classification — never an error message.
 */
export function writeRegistrationAdmissionEvidence(input: { directory: string; runId: string; stage: EvidenceStage; evidence: unknown }): EvidenceResult {
  if (!RUN_ID.test(input.runId) || (input.stage !== "start" && input.stage !== "final")) return { ok: false, reason: "invalid_run_id", code: null };
  if (missingEvidenceFields(input.stage, input.evidence).length > 0 || (input.evidence as { runId?: unknown }).runId !== input.runId) return { ok: false, reason: "incomplete", code: null };
  const json = safeEvidenceJson(input.evidence);
  if (json === null || UNSAFE_EXTRA.test(json)) return { ok: false, reason: "unsafe_content", code: null };
  const file = path.join(input.directory, `registration-admission-smoke-${input.runId}-${input.stage}.json`);
  try {
    mkdirSync(input.directory, { recursive: true, mode: 0o700 });
    if ((statSync(input.directory).mode & 0o077) !== 0) return { ok: false, reason: "directory_not_private", code: null };
    writeFileSync(file, json, { flag: "wx", mode: 0o600 });
    if ((statSync(file).mode & 0o777) !== 0o600) return { ok: false, reason: "write_failed", code: "MODE" };
  } catch (error) {
    const code = String((error as { code?: unknown } | null)?.code ?? "");
    return { ok: false, reason: code === "EEXIST" ? "already_exists" : "write_failed", code: /^[A-Z0-9_]{1,24}$/.test(code) ? code : null };
  }
  return { ok: true, file };
}

// ------------------------------------------------------------------ run lifecycle

export type LifecycleState = "NOT_STARTED" | "PREFLIGHT" | "ARMED" | "RUNNING" | "CLEANUP" | "COMPLETED_CLEAN" | "COMPLETED_DELTA_MISMATCH" | "POISONED";
export type OperationRecord = { what: string; phase: "preflight" | "case" | "verify"; mode: "read" | "write" };
export type TrackedRead = <T>(what: string, operation: () => Promise<T>) => Promise<T>;
export type SchemaRefusal = { case: string | null; what: string; sqlState: string };
export type ReportedCleanupStep = Omit<CleanupStep, "statement">;
/** A request the run launched and has not yet collected: its settlement never throws. */
export type Launched = { what: string; done: Promise<Settled> };

export type FinalReport = {
  outcome: "NOT_STARTED" | "COMPLETED_CLEAN" | "COMPLETED_DELTA_MISMATCH" | "POISONED";
  verdict: "not_started" | "baseline_plus_expected_delta" | "delta_mismatch" | "poisoned_evidence_preserved";
  /** Always false: even a clean run leaves the table it added. */
  completeRestoration: false;
  poisoned: string | null;
  executed: string[];
  notExecuted: string[];
  inFlightOperations: string[];
  unknownOperations: string[];
  operationsIssued: number;
  /** What the run WROTE to the public singleton row and to the schema, by count — so a partial run still reports which writes occurred. */
  writes: { rowFixtureWrites: number; operationsIssued: number; activityPolls: number };
  admissionTallies: Record<string, Record<string, number>>;
  schemaRefusals: SchemaRefusal[];
  cleanup: { attempted: boolean; accepted: boolean; skipped: string | null; inFlight: boolean; summary: CleanupSummary | null; stopped: CleanupAccount["stopped"]; refusal: string | null; steps: ReportedCleanupStep[] };
  ownedSchemas: string[];
  delta: DeltaVerdict | null;
  action: string;
};

const INVESTIGATE = "Investigate the disposable branch read-only. Do not reuse or automatically repair the branch.";
const PREFIX = "registration admission smoke";

/**
 * The run's one state machine. Rules, none of which can be undone during a run:
 *
 *   - `poison` is permanent and keeps its FIRST reason. It is set by a failed
 *     preflight check, a case that throws or outlives its deadline, any
 *     database answer that is not the one the call expects, a lost answer, an
 *     operation attempted in the wrong state, a cleanup that is not confirmed,
 *     a limit reached, and a failure the test runner reports. Poisoning also
 *     seals ownership. Once poisoned, NOTHING new is sent.
 *   - Nothing may be written before `arm`, and `arm` needs every required
 *     preflight check passed, nothing unsettled, and the start evidence saved.
 *   - Every operation is tracked from the moment it is issued until it REALLY
 *     settles. A deadline stops the run waiting; it does not make the
 *     operation finished.
 *   - NOTHING IS EVER RETRIED. A request whose answer is lost poisons the run.
 *   - A case starts only when the run is armed, clean, idle, and it is the next
 *     expected case. There is ONE cleanup, at the end, attempted at most once.
 *   - Writes to the singleton row are counted (MAX_ROW_FIXTURE_WRITES) and
 *     activity polls are counted (MAX_ACTIVITY_POLLS).
 */
export function createRegistrationAdmissionLifecycle(input: { expectedCases: readonly string[]; requiredPreflightChecks: readonly string[]; caseDeadlineMs: number; cleanupDeadlineMs: number; preflightDeadlineMs?: number; ownership: RunOwnership }) {
  const preflightDeadlineMs = input.preflightDeadlineMs ?? input.caseDeadlineMs;
  for (const ms of [input.caseDeadlineMs, input.cleanupDeadlineMs, preflightDeadlineMs]) if (!Number.isSafeInteger(ms) || ms < 1) throw new Error(`${PREFIX}: a deadline must be a positive whole number of milliseconds`);
  if (input.expectedCases.length === 0 || new Set(input.expectedCases).size !== input.expectedCases.length) throw new Error(`${PREFIX}: the expected cases must be a non-empty list of distinct names`);
  if (input.requiredPreflightChecks.length === 0 || new Set(input.requiredPreflightChecks).size !== input.requiredPreflightChecks.length) throw new Error(`${PREFIX}: the required preflight checks must be a non-empty list of distinct names`);

  let phase: Exclude<LifecycleState, "POISONED"> = "NOT_STARTED";
  let poisoned: string | null = null;
  let caseInFlight: string | null = null;
  let preflightInFlight = false;
  let preflightTimer: ReturnType<typeof setTimeout> | undefined;
  let onPreflightExpired: ((error: Error) => void) | null = null;
  let verifying = false;
  let verifyInFlight = false;
  let operationSeq = 0;
  let issued = 0;
  let rowFixtureWrites = 0;
  let activityPolls = 0;
  const operations = new Map<number, OperationRecord>();
  const unknownOperations: string[] = [];
  const passedChecks = new Set<string>();
  const executed: string[] = [];
  const tallies: Record<string, Record<string, number>> = {};
  const schemaRefusals: SchemaRefusal[] = [];
  const cleanup: { attempted: boolean; accepted: boolean; skipped: string | null; inFlight: boolean; account: CleanupAccount | null } = { attempted: false, accepted: false, skipped: null, inFlight: false, account: null };

  const poison = (reason: string): void => {
    if (poisoned === null) poisoned = reason;
    input.ownership.seal("the run is poisoned");
  };
  const refusal = (what: string) => new Error(`${PREFIX}: ${what} refused — the run is poisoned (${String(poisoned)}). A failed live run stops here; it is never retried automatically.`);

  const admit = (what: string, mode: "read" | "write", count = 1): OperationRecord["phase"] => {
    if (poisoned !== null) throw refusal(what);
    if (verifying) {
      if (mode === "write") {
        poison(`a write (${what}) was attempted during the post-run comparison`);
        throw refusal(what);
      }
    } else if (phase === "PREFLIGHT") {
      if (mode === "write") {
        poison(`a write (${what}) was attempted before the run was armed`);
        throw refusal(what);
      }
    } else if (phase !== "RUNNING" || caseInFlight === null) {
      poison(`a database operation (${what}) was attempted outside a running case (${phase})`);
      throw refusal(what);
    }
    if (issued + count > MAX_RUN_OPERATIONS) {
      poison("the run reached its operation limit");
      throw refusal(what);
    }
    return verifying ? "verify" : phase === "PREFLIGHT" ? "preflight" : "case";
  };
  const issue = <T>(record: OperationRecord, operation: () => Promise<T>): Promise<T> => {
    const id = (operationSeq += 1);
    issued += 1;
    operations.set(id, record);
    let pending: Promise<T>;
    try {
      pending = Promise.resolve(operation());
    } catch (error) {
      pending = Promise.reject(error);
    }
    const tracked = pending.finally(() => void operations.delete(id));
    tracked.catch(() => undefined);
    return tracked;
  };
  const settle = async <T>(record: OperationRecord, operation: () => Promise<T>): Promise<Settled> => {
    try {
      return { status: "fulfilled", value: await issue(record, operation) };
    } catch (reason) {
      return { status: "rejected", reason };
    }
  };
  const fail = (what: string, reason: unknown): Error => {
    const sqlState = sqlStateOf(reason);
    if (sqlState !== null) poison(`the database refused ${what} (SQLSTATE ${sqlState})`);
    else {
      unknownOperations.push(what);
      poison(`no answer for ${what}; it may or may not have taken effect`);
    }
    return refusal(`continuing after ${what} was`);
  };
  const plain = async <T>(what: string, mode: "read" | "write", operation: () => Promise<T>): Promise<T> => {
    const settled = await settle({ what, phase: admit(what, mode), mode }, operation);
    if (settled.status === "rejected") throw fail(what, settled.reason);
    if (poisoned !== null) throw refusal(`using the answer to ${what} was`);
    return settled.value as T;
  };
  const tally = (outcome: AdmissionOutcome): void => {
    const bucket = (tallies[caseInFlight ?? ""] ??= {});
    const key = outcome.kind === "admission_error" ? `admission_error:${outcome.errorKind}` : outcome.kind;
    bucket[key] = (bucket[key] ?? 0) + 1;
  };
  /** Records one admission outcome. An allowed non-answer (listed error kinds) is counted; anything else that is not admitted/denied poisons. */
  const noteOutcome = (what: string, outcome: AdmissionOutcome, allowedErrors: readonly RegistrationAdmissionErrorKind[]): void => {
    if (outcome.kind === "admitted" || outcome.kind === "denied") tally(outcome);
    else if (outcome.kind === "admission_error" && allowedErrors.includes(outcome.errorKind)) tally(outcome);
    else if (outcome.kind === "admission_error") poison(`an admission request (${what}) failed closed with "${outcome.errorKind}", which this case does not expect; that is not a denial`);
    else if (outcome.kind === "database_error") poison(`an admission request (${what}) was refused by the database (SQLSTATE ${outcome.sqlState}); that is not a denial`);
    else {
      unknownOperations.push(what);
      poison(`no usable answer for an admission request (${what}); it may or may not have been charged`);
    }
  };

  return {
    state: (): LifecycleState => (poisoned !== null ? "POISONED" : phase),
    poison,
    poisoned: (): string | null => poisoned,
    executed: (): string[] => [...executed],
    inFlightOperations: (): string[] => [...operations.values()].map((record) => record.what),
    caseInFlight: (): string | null => caseInFlight,
    preflightInFlight: (): boolean => preflightInFlight,
    cleanupInFlight: (): boolean => cleanup.inFlight,
    operationsIssued: (): number => issued,
    rowFixtureWrites: (): number => rowFixtureWrites,
    activityPolls: (): number => activityPolls,

    beginPreflight(): void {
      if (poisoned !== null) throw refusal("the preflight");
      if (phase !== "NOT_STARTED") {
        poison("the preflight was started twice");
        throw refusal("the preflight");
      }
      phase = "PREFLIGHT";
      preflightTimer = setTimeout(() => {
        if (phase !== "PREFLIGHT") return;
        poison(`the preflight exceeded its ${preflightDeadlineMs} ms deadline; a read it issued may still be running`);
        onPreflightExpired?.(new Error(`${PREFIX}: the preflight exceeded its deadline. Nothing was written, and nothing is retried.`));
      }, preflightDeadlineMs);
      (preflightTimer as { unref?: () => void }).unref?.();
    },
    async runPreflight<T>(body: () => Promise<T>): Promise<T> {
      this.beginPreflight();
      preflightInFlight = true;
      const tracked = Promise.resolve()
        .then(body)
        .then(
          (value) => {
            preflightInFlight = false;
            return value;
          },
          (error: unknown) => {
            poison("the preflight failed");
            preflightInFlight = false;
            throw error;
          },
        );
      tracked.catch(() => undefined);
      const expired = new Promise<never>((_, reject) => void (onPreflightExpired = reject));
      expired.catch(() => undefined);
      const value = await Promise.race([tracked, expired]);
      if (poisoned !== null) throw refusal("completing the preflight was");
      if (phase === "PREFLIGHT") {
        poison("the preflight ended without arming the run");
        throw refusal("completing the preflight was");
      }
      return value;
    },
    preflightCheck(name: string, passed: boolean): void {
      if (poisoned !== null) throw refusal(`the preflight check "${name}"`);
      if (phase !== "PREFLIGHT" || !input.requiredPreflightChecks.includes(name) || passedChecks.has(name)) {
        poison(`the preflight check "${name}" was not expected here`);
        throw refusal(`the preflight check "${name}"`);
      }
      if (passed !== true) {
        poison(`the preflight check "${name}" did not pass`);
        throw refusal(`the preflight check "${name}"`);
      }
      passedChecks.add(name);
    },
    arm(start: { startEvidence: EvidenceResult }): void {
      if (poisoned !== null) throw refusal("arming the run");
      const missing = input.requiredPreflightChecks.filter((name) => !passedChecks.has(name));
      if (phase !== "PREFLIGHT" || missing.length > 0) poison(phase !== "PREFLIGHT" ? "arming was attempted outside the preflight" : `arming was attempted with ${missing.length} preflight check(s) not passed`);
      else if (operations.size > 0) poison("arming was attempted while a preflight read was still unsettled");
      else if (!start?.startEvidence || start.startEvidence.ok !== true) poison("arming was attempted without saved start evidence");
      if (poisoned !== null) throw refusal("arming the run");
      clearTimeout(preflightTimer);
      phase = "ARMED";
    },

    /** One read. Allowed in the preflight and inside a case. Any failure poisons; it is never repeated. */
    read: <T>(what: string, operation: () => Promise<T>): Promise<T> => plain(what, "read", operation),
    /** One write to a scratch schema or the migration block. Allowed only inside a case of an armed run. */
    write: <T>(what: string, operation: () => Promise<T>): Promise<T> => plain(what, "write", operation),
    /** One write to the public SINGLETON ROW (or its table's name): counted, and bounded by MAX_ROW_FIXTURE_WRITES. */
    async writeRow<T>(what: string, operation: () => Promise<T>): Promise<T> {
      if (rowFixtureWrites >= MAX_ROW_FIXTURE_WRITES) {
        poison("the run reached its limit of writes to the singleton row");
        throw refusal(what);
      }
      const settled = await settle({ what, phase: admit(what, "write"), mode: "write" }, operation);
      rowFixtureWrites += 1;
      if (settled.status === "rejected") throw fail(what, settled.reason);
      if (poisoned !== null) throw refusal(`using the answer to ${what} was`);
      return settled.value as T;
    },
    /** One read of pg_stat_activity: counted, bounded by MAX_ACTIVITY_POLLS. */
    async poll<T>(what: string, operation: () => Promise<T>): Promise<T> {
      if (activityPolls >= MAX_ACTIVITY_POLLS) {
        poison("the run reached its limit of activity polls");
        throw refusal(what);
      }
      activityPolls += 1;
      return plain(what, "read", operation);
    },

    /** One operation the DATABASE IS EXPECTED TO REFUSE, with one of the SQLSTATEs this call names. Success, another SQLSTATE, and a lost answer all poison. */
    async expectDatabaseRefusal(what: string, operation: () => Promise<unknown>, allowedSqlStates: readonly string[]): Promise<{ sqlState: string; constraint: string | null }> {
      if (allowedSqlStates.length === 0 || !allowedSqlStates.every((code) => typeof code === "string" && SQL_STATE.test(code))) {
        poison(`an expected refusal (${what}) named no valid SQLSTATE`);
        throw refusal(what);
      }
      const settled = await settle({ what, phase: admit(what, "write"), mode: "write" }, operation);
      if (settled.status === "fulfilled") {
        poison(`${what} was expected to be refused by the database, and was not`);
        throw refusal(`continuing after ${what} was`);
      }
      const sqlState = sqlStateOf(settled.reason);
      if (sqlState === null) throw fail(what, settled.reason);
      if (!allowedSqlStates.includes(sqlState)) {
        poison(`the database refused ${what} with SQLSTATE ${sqlState}, which this case does not allow`);
        throw refusal(`continuing after ${what} was`);
      }
      if (poisoned !== null) throw refusal(`using the answer to ${what} was`);
      schemaRefusals.push({ case: caseInFlight, what, sqlState });
      return { sqlState, constraint: constraintOf(settled.reason) };
    },

    /** One admission request. Returns only `admitted` or `denied`; every other outcome poisons — it is never a denial. */
    async admit(what: string, operation: () => Promise<unknown>): Promise<Extract<AdmissionOutcome, { kind: "admitted" | "denied" }>> {
      const outcome = classifyAdmission(await settle({ what, phase: admit(what, "write"), mode: "write" }, operation));
      noteOutcome(what, outcome, []);
      if (poisoned !== null || (outcome.kind !== "admitted" && outcome.kind !== "denied")) throw refusal(`continuing after ${what} was`);
      return outcome;
    },
    /** One admission request that the APPLICATION is expected to refuse with one of these error kinds (fail closed). Any other outcome poisons. */
    async expectAdmissionFailure(what: string, operation: () => Promise<unknown>, kinds: readonly RegistrationAdmissionErrorKind[]): Promise<RegistrationAdmissionErrorKind> {
      const outcome = classifyAdmission(await settle({ what, phase: admit(what, "write"), mode: "write" }, operation));
      if (outcome.kind !== "admission_error") {
        // Admitted or denied is the WRONG answer here; a database error or a lost answer is worse. Either way the run is over.
        noteOutcome(what, outcome, []);
        poison(`${what} was expected to fail closed (${kinds.join(" or ")}) and did not`);
        throw refusal(`continuing after ${what} was`);
      }
      noteOutcome(what, outcome, kinds);
      if (poisoned !== null) throw refusal(`continuing after ${what} was`);
      return outcome.errorKind;
    },
    /** Several admission requests issued TOGETHER (bounded by MAX_CONCURRENCY). Resolves only once every one has settled. `allowedErrors` lists the fail-closed kinds this burst may legitimately return. */
    async admitBurst(what: string, requests: ReadonlyArray<() => Promise<unknown>>, allowedErrors: readonly RegistrationAdmissionErrorKind[] = []): Promise<AdmissionOutcome[]> {
      if (requests.length < 1 || requests.length > MAX_CONCURRENCY) {
        poison(`a burst (${what}) was outside the concurrency bound`);
        throw refusal(what);
      }
      const phaseNow = admit(what, "write", requests.length);
      const outcomes = (await Promise.all(requests.map((operation) => settle({ what, phase: phaseNow, mode: "write" }, operation)))).map(classifyAdmission);
      for (const outcome of outcomes) noteOutcome(what, outcome, allowedErrors);
      if (poisoned !== null) throw refusal(`continuing after ${what} was`);
      return outcomes;
    },

    /**
     * Starts ONE tracked operation WITHOUT waiting for it, for the two-session race
     * cases. It is a write (a lock holder, or an admission racing it). The caller
     * MUST collect it before its case returns; a case that returns with an
     * uncollected launch is poisoned.
     */
    launch(what: string, operation: () => Promise<unknown>): Launched {
      const record: OperationRecord = { what, phase: admit(what, "write"), mode: "write" };
      return { what, done: settle(record, operation) };
    },
    /** Collects a launched lock holder: it must have succeeded, or the run is poisoned. */
    async collectHolder(launched: Launched): Promise<void> {
      const settled = await launched.done;
      if (settled.status === "rejected") throw fail(launched.what, settled.reason);
      if (poisoned !== null) throw refusal(`using the answer to ${launched.what} was`);
    },
    /** Collects a launched admission request as an admission outcome (admitted/denied only; anything else poisons). */
    async collectAdmission(launched: Launched): Promise<Extract<AdmissionOutcome, { kind: "admitted" | "denied" }>> {
      const outcome = classifyAdmission(await launched.done);
      noteOutcome(launched.what, outcome, []);
      if (poisoned !== null || (outcome.kind !== "admitted" && outcome.kind !== "denied")) throw refusal(`continuing after ${launched.what} was`);
      return outcome;
    },

    async runCase<T>(name: string, body: () => Promise<T>): Promise<T> {
      if (poisoned !== null) throw refusal(`"${name}" was not run: starting it was`);
      if (phase === "NOT_STARTED" || phase === "PREFLIGHT") throw new Error(`${PREFIX}: not run — the run is not armed, so nothing may be written`);
      if (caseInFlight !== null) poison(`"${caseInFlight}" was still running when "${name}" was about to start`);
      else if (phase !== "ARMED") poison(`"${name}" was about to start in state ${phase}`);
      if (operations.size > 0) poison(`${operations.size} operation(s) were still unsettled when "${name}" was about to start`);
      if (input.expectedCases[executed.length] !== name) poison(`"${name}" is not the next expected case`);
      if (poisoned !== null) throw refusal(`"${name}" was not run: starting it was`);

      phase = "RUNNING";
      caseInFlight = name;
      const tracked = body().then(
        (value) => {
          if (caseInFlight === name) caseInFlight = null;
          return value;
        },
        (error: unknown) => {
          poison(`"${name}" failed`);
          if (caseInFlight === name) caseInFlight = null;
          throw error;
        },
      );
      tracked.catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          poison(`"${name}" exceeded its ${input.caseDeadlineMs} ms deadline; its database requests may still be running or may still complete`);
          reject(new Error(`${PREFIX}: "${name}" exceeded its deadline. Its outcome is uncertain; nothing is retried.`));
        }, input.caseDeadlineMs);
      });
      try {
        const value = await Promise.race([tracked, deadline]);
        if (poisoned !== null) throw refusal(`"${name}" was not counted as run: completing it was`);
        if (operations.size > 0) {
          poison(`"${name}" returned with ${operations.size} operation(s) still unsettled`);
          throw refusal(`"${name}" was not counted as run: completing it was`);
        }
        executed.push(name);
        phase = "ARMED";
        return value;
      } finally {
        clearTimeout(timer);
      }
    },

    afterCase(observed: { reportedFailed: boolean }): void {
      if (phase === "NOT_STARTED" || phase === "PREFLIGHT") return;
      if (caseInFlight !== null) poison(`"${caseInFlight}" was still running when its test ended (it timed out or was abandoned); its database requests may still complete`);
      if (observed.reportedFailed) poison("the test runner reported a test as failed");
    },

    /** The ONE cleanup of scratch schemas. Sends something only when the run is armed, clean, complete, and idle; attempted at most once. */
    async runFinalCleanup(db: QueryDb): Promise<void> {
      const skip = (reason: string): void => {
        if (cleanup.skipped === null && !cleanup.attempted) cleanup.skipped = reason;
      };
      if (phase === "NOT_STARTED" || phase === "PREFLIGHT") return skip("the run never armed; nothing was written");
      if (cleanup.attempted) poison("a second final cleanup was attempted");
      if (caseInFlight !== null) poison(`"${caseInFlight}" was still running when the final cleanup was due`);
      if (operations.size > 0) poison(`${operations.size} operation(s) were still unsettled when the final cleanup was due`);
      if (poisoned === null && (phase !== "ARMED" || executed.length !== input.expectedCases.length)) poison("the final cleanup was due before every expected case had completed");
      if (poisoned !== null) return skip(`nothing was sent: ${poisoned}`);

      cleanup.attempted = true;
      phase = "CLEANUP";
      input.ownership.seal("the final cleanup began");
      const account = planAdmissionCleanup(input.ownership);
      cleanup.account = account;
      let expired = false;
      const gate: CleanupGate = {
        active: () => poisoned === null && !expired,
        q: (text, params) => (gate.active() ? db.q(text, params) : Promise.reject(new CleanupSwitchedOff("cleanup switched off"))),
      };
      cleanup.inFlight = true;
      const tracked = runCleanupPlan(input.ownership, gate, account, () => operations.size + (caseInFlight === null ? 0 : 1)).then(
        () => undefined,
        () => void (account.stopped = account.stopped ?? "a_step_failed"),
      );
      void tracked.then(() => void (cleanup.inFlight = false));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          poison(`the final cleanup exceeded its ${input.cleanupDeadlineMs} ms deadline; a statement it already issued may still complete`);
          reject(new Error(`${PREFIX}: the final cleanup exceeded its deadline. No further cleanup statement will be sent; what was already issued may still complete. Nothing is retried.`));
        }, input.cleanupDeadlineMs);
      });
      try {
        await Promise.race([tracked, deadline]);
      } finally {
        clearTimeout(timer);
      }
      const summary = summarizeCleanup(account);
      if (summary.status !== "confirmed") {
        poison(`the final cleanup was ${summary.status} (${summary.steps.confirmed} of ${summary.steps.total} steps confirmed)`);
        throw new Error(`${PREFIX}: the final cleanup was ${summary.status}. No further cleanup will be attempted; the database state is unknown.`);
      }
      if (poisoned !== null) throw refusal("counting the cleanup as done was");
      cleanup.accepted = true;
    },

    /** The end of the run. Makes NO write and sends no cleanup; the post-run comparison is read only, and only for a run that is clean, complete, and cleaned up. */
    async finish(end: { compare: (read: TrackedRead) => Promise<DeltaVerdict>; deadlineMs?: number }): Promise<FinalReport> {
      const verifyDeadlineMs = end.deadlineMs ?? input.cleanupDeadlineMs;
      if (!Number.isSafeInteger(verifyDeadlineMs) || verifyDeadlineMs < 1) throw new Error(`${PREFIX}: a deadline must be a positive whole number of milliseconds`);
      let delta: DeltaVerdict | null = null;
      const report = (outcome: FinalReport["outcome"], verdict: FinalReport["verdict"], action: string): FinalReport => ({
        outcome,
        verdict,
        completeRestoration: false,
        poisoned,
        executed: [...executed],
        notExecuted: input.expectedCases.filter((name) => !executed.includes(name)),
        inFlightOperations: [...[...operations.values()].map((record) => record.what), ...(preflightInFlight ? ["the preflight"] : []), ...(caseInFlight !== null ? [`case body: ${caseInFlight}`] : []), ...(cleanup.inFlight ? ["the final cleanup"] : []), ...(verifyInFlight ? ["the post-run comparison"] : [])],
        unknownOperations: [...unknownOperations],
        operationsIssued: issued,
        writes: { rowFixtureWrites, operationsIssued: issued, activityPolls },
        admissionTallies: Object.fromEntries(Object.entries(tallies).map(([name, tally]) => [name, { ...tally }])),
        schemaRefusals: schemaRefusals.map((entry) => ({ ...entry })),
        cleanup: {
          attempted: cleanup.attempted,
          accepted: cleanup.accepted,
          skipped: cleanup.skipped,
          inFlight: cleanup.inFlight,
          summary: cleanup.account ? summarizeCleanup(cleanup.account) : null,
          stopped: cleanup.account?.stopped ?? null,
          refusal: cleanup.account?.refusal ?? null,
          steps: (cleanup.account?.steps ?? []).map(({ action: stepAction, target, writes, outcome: stepOutcome, sqlState, rows }) => ({ action: stepAction, target, writes, outcome: stepOutcome, sqlState, rows })),
        },
        ownedSchemas: input.ownership.ownedSchemas(),
        delta,
        action,
      });
      if (poisoned === null && (phase === "NOT_STARTED" || phase === "PREFLIGHT")) return report("NOT_STARTED", "not_started", "Nothing was written.");
      if (caseInFlight !== null) poison(`"${caseInFlight}" was still running at the end of the run`);
      if (operations.size > 0) poison(`${operations.size} operation(s) were still unsettled at the end of the run`);
      if (cleanup.inFlight) poison("the final cleanup was still in flight at the end of the run");
      if (poisoned === null && executed.length !== input.expectedCases.length) poison("not every expected case ran");
      if (poisoned === null && !cleanup.accepted) poison("the final cleanup was never confirmed");
      if (poisoned === null) {
        verifying = true;
        verifyInFlight = true;
        const tracked = Promise.resolve().then(() => end.compare((what, operation) => plain(what, "read", operation)));
        void tracked.then(
          () => void (verifyInFlight = false),
          () => void (verifyInFlight = false),
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            poison(`the post-run comparison exceeded its ${verifyDeadlineMs} ms deadline; a read it issued may still be running`);
            reject(new Error(`${PREFIX}: the post-run comparison exceeded its deadline.`));
          }, verifyDeadlineMs);
        });
        try {
          delta = await Promise.race([tracked, deadline]);
        } catch {
          delta = null;
          poison("the post-run comparison could not be read");
        } finally {
          clearTimeout(timer);
          verifying = false;
        }
        if (poisoned === null && delta !== null) {
          if (delta.ok === true && delta.verdict === "baseline_plus_expected_delta" && delta.differences.length === 0) {
            phase = "COMPLETED_CLEAN";
            return report("COMPLETED_CLEAN", "baseline_plus_expected_delta", `None. Every case ran, the cleanup was confirmed, and the database is at its baseline PLUS the expected delta: public.${TABLE} now exists, holding exactly the seed row. It was not restored to its pre-run state, and only what the comparison lists as measured was verified.`);
          }
          phase = "COMPLETED_DELTA_MISMATCH";
          return report("COMPLETED_DELTA_MISMATCH", "delta_mismatch", `Every case ran and the cleanup was confirmed, but the database does NOT match its baseline plus the expected delta. ${INVESTIGATE}`);
        }
      }
      const action = !cleanup.attempted
        ? `The run is poisoned. No cleanup was started, so the harness itself removed none of the schemas it registered — but their presence was not verified, the public singleton row may be in a test state (see writes), and a request still in flight may have changed things. ${INVESTIGATE}`
        : `The database state is unknown after this failure: the final cleanup was started and not confirmed, so some run-owned schemas may be gone and some may remain (see cleanup.steps). ${INVESTIGATE}`;
      return report("POISONED", "poisoned_evidence_preserved", action);
    },
  };
}
export type RegistrationAdmissionLifecycle = ReturnType<typeof createRegistrationAdmissionLifecycle>;

class CleanupSwitchedOff extends Error {}

/**
 * The run's verdict: it passes ONLY when the lifecycle ended COMPLETED_CLEAN
 * with the baseline-plus-expected-delta verdict AND both evidence records were
 * saved. Anything else is a failure — reported, never retried, and never a
 * reason to touch the database again.
 */
export function concludeRegistrationAdmissionRun(final: FinalReport, saved: { start: EvidenceResult; final: EvidenceResult }): { pass: boolean; verdict: "clean_and_evidenced" | "clean_but_not_evidenced" | "not_clean"; message: string } {
  const evidenced = saved.start.ok && saved.final.ok;
  if (final.outcome !== "COMPLETED_CLEAN" || final.verdict !== "baseline_plus_expected_delta" || final.poisoned !== null) return { pass: false, verdict: "not_clean", message: `${PREFIX}: ${final.outcome}. ${final.action}${evidenced ? "" : " An evidence record was also NOT saved."}` };
  if (!evidenced) return { pass: false, verdict: "clean_but_not_evidenced", message: `${PREFIX}: every case ran and the database is at its baseline plus the expected delta, but an evidence record was NOT saved, so this is not an evidenced successful run. Nothing is retried and the database is not touched again.` };
  return { pass: true, verdict: "clean_and_evidenced", message: `${PREFIX}: completed clean (baseline plus expected delta), evidence saved.` };
}
