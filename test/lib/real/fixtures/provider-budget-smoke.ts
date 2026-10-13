import { createHash } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PROVIDER_BUDGET_BUCKETS } from "@/lib/real/server/rate-limit";
import { assertPlainIdentifier, caseFailedInVitest, checkExactFileSelection, requirePooledMode, safeEvidenceJson, type QueryDb, type SelectionCheck } from "./provisioning-limits-smoke";
import { isRunSmokeId } from "./smoke-run-ids";

/**
 * TEST-ONLY, PURE safety foundation for a FUTURE disposable-Neon smoke of the
 * provider-budget table and limiter (Milestone 3, Slice 3A-0). Stage 1 of the
 * harness: no live smoke file exists yet, and nothing here connects, reads the
 * environment, or imports a database driver or provider module. Every rule can
 * therefore be proven offline (provider-budget-smoke-harness.test.ts).
 *
 * NOTHING IN THIS FILE HAS BEEN RUN AGAINST POSTGRESQL. The SQL texts below —
 * the catalog reads in particular — are unexecuted; their first execution
 * belongs to a later, separately authorized stage. If one of them is wrong,
 * the database refuses it, cleanup stops, and the run's evidence is preserved.
 *
 * What lives here:
 *   1. the run's OWNERSHIP registry: every subject, scratch schema, and
 *      scratch object is registered — by exact name — before its first write,
 *      under cumulative caps, and registration closes for good the moment the
 *      run fails, times out, or begins its cleanup;
 *   2. the CLASSIFICATION of a database answer: a refusal, an error, or a lost
 *      answer is never counted as an ordinary budget denial;
 *   3. the run LIFECYCLE: preflight, arming, cases, one final cleanup, and a
 *      permanent poison that stops every later case, write, read, and cleanup;
 *   4. the FINAL CLEANUP: planned from the registry alone, exact names only,
 *      admitted for a scratch schema only when its inventory is exactly what
 *      was registered and nothing outside it depends on it, stopped at the
 *      first failure, never repeated;
 *   5. the EXPECTED-DELTA comparison: a clean run leaves the disposable branch
 *      at its baseline PLUS the one new table — never "restored";
 *   6. the EVIDENCE files: owner-only, created exclusively, content-screened.
 *
 * Unlike the Milestone 1 smoke there is NO per-case cleanup: each case uses
 * its own subjects, and one cleanup runs at the end, only after every decisive
 * case completed cleanly. A failed run keeps everything it wrote.
 */

// ------------------------------------------------------------------ reused, audited helpers (Milestone 1) — behaviour unchanged

export { assertPlainIdentifier, caseFailedInVitest, requirePooledMode };

/** The future live smoke's path. That file does not exist yet. */
export const PROVIDER_BUDGET_SMOKE_FILE = "test/lib/real/provider-budget.smoke.test.ts";

/** Milestone 1's exact-file rule, for the provider-budget smoke's own path. */
export function checkProviderBudgetFileSelection(cliArgs: unknown): SelectionCheck {
  return checkExactFileSelection(cliArgs, PROVIDER_BUDGET_SMOKE_FILE);
}

/** What the eventual runner must use: its own deadlines fire BEFORE the test runner gives up on a case or a hook. */
export const VITEST_TIMEOUT_MS = 120_000;
export const CASE_DEADLINE_MS = 90_000;
export const CLEANUP_DEADLINE_MS = 60_000;

/**
 * Whether the command line can leave the runner's timeouts SHORTER than the
 * run's own deadlines. The smoke gives every test and hook VITEST_TIMEOUT_MS
 * explicitly, so no flag is needed; a shorter one (the older smokes are run
 * with 30000) must never let the runner abandon a case, a cleanup, or a
 * comparison before the run's own deadline has poisoned it.
 *
 * STRICT, and independent of the exact-file check: ANY argument that mentions
 * a timeout must be exactly `--testTimeout=<ms>` or `--hookTimeout=<ms>`, at
 * most once each, with a value of at least VITEST_TIMEOUT_MS. Every other
 * spelling — a separated value, kebab-case, another timeout option, a
 * repeated or malformed flag — is refused rather than interpreted.
 */
export function checkRunnerTimeoutFlags(cliArgs: unknown): SelectionCheck {
  if (!Array.isArray(cliArgs) || cliArgs.some((arg) => typeof arg !== "string")) return { ok: false, reason: "the Vitest command line is not available to this run" };
  const seen = new Set<string>();
  for (const arg of cliArgs as string[]) {
    if (!/time-?out/i.test(arg)) continue;
    const flag = /^--(testTimeout|hookTimeout)=([0-9]{1,9})$/.exec(arg);
    if (!flag) return { ok: false, reason: "a timeout option is not in the one accepted form (--testTimeout=<ms> or --hookTimeout=<ms>)" };
    if (seen.has(flag[1]!)) return { ok: false, reason: `--${flag[1]} is given more than once` };
    seen.add(flag[1]!);
    if (Number(flag[2]) < VITEST_TIMEOUT_MS) return { ok: false, reason: `--${flag[1]} must be at least ${VITEST_TIMEOUT_MS} ms (or omitted): a shorter runner timeout could abandon a database operation before this run's own deadline stops it` };
  }
  return { ok: true };
}

/** Hard, CUMULATIVE ceilings on what one run may ever register or send. Never refilled. */
export const MAX_RUN_SUBJECTS = 40;
export const MAX_RUN_SCRATCH_SCHEMAS = 40;
export const MAX_RUN_SCRATCH_OBJECTS = 120;
export const MAX_RUN_OPERATIONS = 1_500;
/** Never more than this many budget requests in flight at once. */
export const MAX_CONCURRENCY = 24;

const RUN_ID = /^[0-9a-f]{8}$/;
const SUBJECT_SUFFIX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SCHEMA_SUFFIX = /^[a-z0-9]{1,12}$/;
const SQL_STATE = /^[0-9A-Z]{5}$/;
const PROVIDER_TABLE = "real_provider_budgets";

export type Statement = { text: string; params: unknown[] };

// ------------------------------------------------------------------ ownership

export type ScratchObjectKind = "table" | "view" | "function";
export type ScratchObject = { kind: ScratchObjectKind; name: string };
const OBJECT_KINDS: readonly string[] = ["table", "view", "function"];

/**
 * One run's fixtures, by exact name. A subject or a scratch schema is owned
 * only if THIS registry minted it, and a scratch object only if it was
 * registered under an owned schema — each BEFORE the first write that creates
 * it. Every statement builder below takes its names from here and refuses
 * anything else; nothing is ever selected by a prefix, a pattern, or a
 * timestamp. Once sealed, the registry can still be read and checked, but can
 * never grow again.
 *
 * Scratch objects must be registered in DEPENDENCY ORDER (a trigger function
 * before the table that uses it, a referenced table before the one that
 * references it): cleanup drops them in reverse, with RESTRICT.
 */
export function createRunOwnership(runId: string) {
  if (!RUN_ID.test(runId)) throw new Error("provider budget smoke: the run id must be 8 lowercase hex characters");
  const subjects: string[] = [];
  const schemas = new Map<string, ScratchObject[]>();
  let objects = 0;
  let sealed: string | null = null;
  const subjectPrefix = `smoke-${runId}-pb-`;
  const schemaShape = new RegExp(`^pb_smoke_${runId}_[a-z0-9]{1,12}$`);

  const assertOpen = (): void => {
    if (sealed !== null) throw new Error(`provider budget smoke: ownership is sealed (${sealed}); nothing further can be registered`);
  };
  const assertOwnedSubject = (subject: string): void => {
    // Both: registered by this run AND of this run's shape. Never echoes the name.
    if (typeof subject !== "string" || !subjects.includes(subject) || !isRunSmokeId(runId, subject) || !subject.startsWith(subjectPrefix)) throw new Error("provider budget smoke: refusing to touch a subject this run does not own");
  };
  const assertOwnedSchema = (schema: string): void => {
    if (typeof schema !== "string" || !schemas.has(schema) || !schemaShape.test(schema) || schema === "public") throw new Error("provider budget smoke: refusing to touch a schema this run does not own");
  };
  const assertOwnedObject = (schema: string, object: ScratchObject): void => {
    assertOwnedSchema(schema);
    if (!schemas.get(schema)!.some((owned) => owned.kind === object.kind && owned.name === object.name)) throw new Error("provider budget smoke: refusing to touch a scratch object this run did not register");
  };

  return {
    runId,
    /** Mints and registers a run-owned budget subject, BEFORE any row is charged to it. */
    registerSubject(suffix: string): string {
      assertOpen();
      if (typeof suffix !== "string" || suffix.length > 40 || !SUBJECT_SUFFIX.test(suffix)) throw new Error("provider budget smoke: a subject suffix must be lowercase letters, digits, and single hyphens");
      if (subjects.length >= MAX_RUN_SUBJECTS) throw new Error("provider budget smoke: this run reached its subject limit; refusing to register more");
      const subject = `${subjectPrefix}${suffix}`;
      if (subjects.includes(subject)) throw new Error("provider budget smoke: a subject suffix was used twice");
      subjects.push(subject);
      return subject;
    },
    /** Mints and registers a run-owned scratch schema name, BEFORE the schema is created. */
    registerScratchSchema(suffix: string): string {
      assertOpen();
      if (typeof suffix !== "string" || !SCHEMA_SUFFIX.test(suffix)) throw new Error("provider budget smoke: a schema suffix must be 1 to 12 lowercase letters and digits");
      if (schemas.size >= MAX_RUN_SCRATCH_SCHEMAS) throw new Error("provider budget smoke: this run reached its scratch-schema limit; refusing to register more");
      const schema = assertPlainIdentifier(`pb_smoke_${runId}_${suffix}`);
      if (schemas.has(schema)) throw new Error("provider budget smoke: a schema suffix was used twice");
      schemas.set(schema, []);
      return schema;
    },
    /** Registers one object the run is about to create INSIDE an owned scratch schema. Functions are zero-argument only. */
    registerScratchObject(schema: string, kind: ScratchObjectKind, name: string): ScratchObject {
      assertOpen();
      assertOwnedSchema(schema);
      if (!OBJECT_KINDS.includes(kind)) throw new Error("provider budget smoke: a scratch object must be a table, a view, or a function");
      const object: ScratchObject = { kind, name: assertPlainIdentifier(name) };
      if (objects >= MAX_RUN_SCRATCH_OBJECTS) throw new Error("provider budget smoke: this run reached its scratch-object limit; refusing to register more");
      const owned = schemas.get(schema)!;
      // One name per schema, whatever the kind: relations share a namespace, and an ambiguous name is never worth it.
      if (owned.some((existing) => existing.name === object.name)) throw new Error("provider budget smoke: a scratch object name was used twice in one schema");
      objects += 1;
      owned.push(object);
      return object;
    },
    assertOwnedSubject,
    assertOwnedSchema,
    assertOwnedObject,
    ownedSubjects: (): string[] => [...subjects],
    ownedSchemas: (): string[] => [...schemas.keys()],
    objectsOf(schema: string): ScratchObject[] {
      assertOwnedSchema(schema);
      return schemas.get(schema)!.map((object) => ({ ...object }));
    },
    /** Closes registration for good. The FIRST reason is kept. */
    seal(reason: string): void {
      if (sealed === null) sealed = reason;
    },
    sealed: (): string | null => sealed,
  };
}
export type RunOwnership = ReturnType<typeof createRunOwnership>;

// ------------------------------------------------------------------ statements (built from the registry only)

export const DELETE_SUBJECT_SQL = `DELETE FROM public.${PROVIDER_TABLE} WHERE subject = $1 RETURNING bucket`;
/** Read-only. Exact names, as one array parameter — never a pattern. */
export const SUBJECT_RESIDUE_SQL = `SELECT count(*)::int AS n FROM public.${PROVIDER_TABLE} WHERE subject = ANY($1::text[])`;
export const SCHEMA_RESIDUE_SQL = "SELECT count(*)::int AS n FROM pg_catalog.pg_namespace WHERE nspname = ANY($1::text[])";
/** Read-only: every relation and function in ONE schema, named by a bound parameter. Indexes, TOAST tables, and row types belong to their table and are not listed. */
export const SCHEMA_INVENTORY_SQL = [
  "SELECT CASE WHEN c.relkind IN ('r', 'p') THEN 'table' WHEN c.relkind IN ('v', 'm') THEN 'view' ELSE 'other:' || c.relkind::text END AS kind, c.relname::text AS name",
  "FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace",
  "WHERE n.nspname = $1 AND c.relkind NOT IN ('i', 'I', 't', 'c')",
  "UNION ALL",
  "SELECT 'function' AS kind, p.proname::text AS name",
  "FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace",
  "WHERE n.nspname = $1",
].join(" ");
/**
 * Read-only: how many dependencies CROSS the schema's boundary, in either
 * direction — a foreign key, a trigger whose function lives on the other
 * side, table inheritance, or a view that reads a relation on the other side.
 * Each must be zero before anything in the schema is dropped. (So a scratch
 * trigger must call a scratch-owned function, and a scratch view may read only
 * scratch relations.)
 */
export const SCHEMA_EXTERNAL_DEPENDENCIES_SQL = [
  "SELECT",
  "(SELECT count(*) FROM pg_catalog.pg_constraint k",
  "JOIN pg_catalog.pg_class a ON a.oid = k.conrelid JOIN pg_catalog.pg_namespace an ON an.oid = a.relnamespace",
  "JOIN pg_catalog.pg_class b ON b.oid = k.confrelid JOIN pg_catalog.pg_namespace bn ON bn.oid = b.relnamespace",
  "WHERE k.contype = 'f' AND (an.nspname = $1) <> (bn.nspname = $1))::int AS foreign_keys,",
  "(SELECT count(*) FROM pg_catalog.pg_trigger g",
  "JOIN pg_catalog.pg_class t ON t.oid = g.tgrelid JOIN pg_catalog.pg_namespace tn ON tn.oid = t.relnamespace",
  "JOIN pg_catalog.pg_proc p ON p.oid = g.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace",
  "WHERE NOT g.tgisinternal AND (tn.nspname = $1) <> (pn.nspname = $1))::int AS triggers,",
  "(SELECT count(*) FROM pg_catalog.pg_inherits i",
  "JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid JOIN pg_catalog.pg_namespace cn ON cn.oid = c.relnamespace",
  "JOIN pg_catalog.pg_class p ON p.oid = i.inhparent JOIN pg_catalog.pg_namespace pn ON pn.oid = p.relnamespace",
  "WHERE (cn.nspname = $1) <> (pn.nspname = $1))::int AS inheritance,",
  "(SELECT count(*) FROM pg_catalog.pg_depend d",
  "JOIN pg_catalog.pg_rewrite w ON w.oid = d.objid JOIN pg_catalog.pg_class v ON v.oid = w.ev_class JOIN pg_catalog.pg_namespace vn ON vn.oid = v.relnamespace",
  "JOIN pg_catalog.pg_class r ON r.oid = d.refobjid JOIN pg_catalog.pg_namespace rn ON rn.oid = r.relnamespace",
  "WHERE d.classid = 'pg_catalog.pg_rewrite'::pg_catalog.regclass AND d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass AND (vn.nspname = $1) <> (rn.nspname = $1))::int AS view_references",
].join(" ");

/** `DROP <kind> <schema>.<name> RESTRICT` for ONE registered object. Both identifiers are re-checked here; RESTRICT means an unexpected dependent refuses the drop. */
export function dropObjectStatement(ownership: RunOwnership, schema: string, object: ScratchObject): Statement {
  ownership.assertOwnedObject(schema, object);
  const target = `${assertPlainIdentifier(schema)}.${assertPlainIdentifier(object.name)}`;
  if (object.kind === "function") return { text: `DROP FUNCTION ${target}() RESTRICT`, params: [] };
  return { text: `DROP ${object.kind === "view" ? "VIEW" : "TABLE"} ${target} RESTRICT`, params: [] };
}

/** `DROP SCHEMA <schema> RESTRICT` — never CASCADE: a schema that still holds anything refuses. */
export function dropSchemaStatement(ownership: RunOwnership, schema: string): Statement {
  ownership.assertOwnedSchema(schema);
  return { text: `DROP SCHEMA ${assertPlainIdentifier(schema)} RESTRICT`, params: [] };
}

// ------------------------------------------------------------------ what a database answer means

const sqlStateOf = (error: unknown): string | null => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && SQL_STATE.test(code) ? code : null;
};
const constraintOf = (error: unknown): string | null => {
  const reason = error as { constraint?: unknown; message?: unknown } | null;
  const named = reason && typeof reason.constraint === "string" && reason.constraint ? reason.constraint : (/constraint "([a-z0-9_]+)"/.exec(String(reason?.message ?? ""))?.[1] ?? null);
  return named && /^[a-z0-9_]+$/.test(named) ? named : null;
};

type Settled = { status: "fulfilled"; value: unknown } | { status: "rejected"; reason: unknown };

/**
 * How one budget request ended. Only `admitted` and `denied` are budget
 * answers. Everything else is an explicit non-answer and is NEVER counted as a
 * denial:
 *   database_error   Postgres itself answered with an error: the statement rolled back.
 *   limiter_refusal  the limiter threw its own fail-closed error — possibly AFTER the store had charged.
 *   no_answer        nothing recognisable came back: the charge may or may not have been made.
 * Carries no driver text: only a SQLSTATE and a constraint name.
 */
export type ConsumeOutcome =
  | { kind: "admitted" }
  | { kind: "denied"; retryAfterSeconds: number }
  | { kind: "database_error"; sqlState: string; constraint: string | null }
  | { kind: "limiter_refusal" }
  | { kind: "no_answer" };

export function classifyConsume(settled: Settled): ConsumeOutcome {
  if (settled.status === "fulfilled") {
    const value = settled.value as { allowed?: unknown; retryAfterSeconds?: unknown } | null;
    if (value && typeof value === "object") {
      const keys = Object.keys(value).sort().join(",");
      if (value.allowed === true && keys === "allowed") return { kind: "admitted" };
      if (value.allowed === false && keys === "allowed,retryAfterSeconds" && Number.isSafeInteger(value.retryAfterSeconds) && (value.retryAfterSeconds as number) >= 1) return { kind: "denied", retryAfterSeconds: value.retryAfterSeconds as number };
    }
    return { kind: "no_answer" };
  }
  const sqlState = sqlStateOf(settled.reason);
  if (sqlState !== null) return { kind: "database_error", sqlState, constraint: constraintOf(settled.reason) };
  if (/^Provider budget refused: /.test(String((settled.reason as { message?: unknown } | null)?.message ?? ""))) return { kind: "limiter_refusal" };
  return { kind: "no_answer" };
}

/** Counts by kind — for asserting "exactly N admitted, M denied, and NOTHING else". */
export function tallyOutcomes(outcomes: readonly ConsumeOutcome[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) counts[outcome.kind] = (counts[outcome.kind] ?? 0) + 1;
  return counts;
}

// ------------------------------------------------------------------ final cleanup

/** A database handle that can be switched off: `q` refuses, without sending anything, once `active()` is false. */
export type CleanupGate = { active(): boolean; q: QueryDb["q"] };
class CleanupStopped extends Error {}

/**
 * What is KNOWN about one step.
 *   confirmed            the database answered, and the answer was what the step expects.
 *   refused_by_database  the database answered with an error: it did not apply.
 *   unexpected_answer    the database answered, with something this harness does not accept.
 *   refused_by_harness   the answers did not establish that the step is safe; nothing was sent for it.
 *   no_answer            it was sent and its answer never arrived: it may or may not have applied.
 *   in_flight            it was sent and has not settled yet: it may still apply.
 *   not_attempted        it was never sent.
 */
export type StepOutcome = "confirmed" | "refused_by_database" | "unexpected_answer" | "refused_by_harness" | "no_answer" | "in_flight" | "not_attempted";
export type CleanupAction = "inspect_inventory" | "inspect_dependencies" | "delete_subject" | "drop_object" | "drop_schema" | "read_subject_residue" | "read_schema_residue";
export type CleanupStep = { action: CleanupAction; target: string; writes: boolean; statement: Statement; outcome: StepOutcome; sqlState: string | null; rows: number | null };
export type CleanupAccount = {
  steps: CleanupStep[];
  /** Why the loop ended before its end, if it did. */
  stopped: null | "a_step_failed" | "switched_off" | "not_admitted";
  /** Why a scratch schema was not admitted for removal, if one was not. No names. */
  refusal: string | null;
};

/**
 * The whole cleanup, planned up front from the registry and nothing else, in
 * the order it will be sent:
 *   1. READ-ONLY admission of every scratch schema (inventory, then boundary
 *      dependencies) — all of them, before the first delete or drop;
 *   2. one DELETE per owned subject, by exact subject;
 *   3. per scratch schema: its registered objects in reverse registration
 *      order, then the schema itself — every drop RESTRICT;
 *   4. two READ-ONLY residue reads, by exact names.
 */
export function planCleanup(ownership: RunOwnership): CleanupAccount {
  const step = (action: CleanupAction, target: string, writes: boolean, statement: Statement): CleanupStep => ({ action, target, writes, statement, outcome: "not_attempted", sqlState: null, rows: null });
  const steps: CleanupStep[] = [];
  const schemas = ownership.ownedSchemas();
  const subjects = ownership.ownedSubjects();
  for (const schema of schemas) {
    ownership.assertOwnedSchema(schema);
    steps.push(step("inspect_inventory", schema, false, { text: SCHEMA_INVENTORY_SQL, params: [schema] }));
    steps.push(step("inspect_dependencies", schema, false, { text: SCHEMA_EXTERNAL_DEPENDENCIES_SQL, params: [schema] }));
  }
  for (const subject of subjects) {
    ownership.assertOwnedSubject(subject);
    steps.push(step("delete_subject", subject, true, { text: DELETE_SUBJECT_SQL, params: [subject] }));
  }
  for (const schema of schemas) {
    for (const object of ownership.objectsOf(schema).reverse()) steps.push(step("drop_object", `${schema}.${object.name}`, true, dropObjectStatement(ownership, schema, object)));
    steps.push(step("drop_schema", schema, true, dropSchemaStatement(ownership, schema)));
  }
  steps.push(step("read_subject_residue", "owned subjects", false, { text: SUBJECT_RESIDUE_SQL, params: [subjects] }));
  steps.push(step("read_schema_residue", "owned schemas", false, { text: SCHEMA_RESIDUE_SQL, params: [schemas] }));
  return { steps, stopped: null, refusal: null };
}

export type SchemaObservation = { inventory: ScratchObject[]; external: { foreignKeys: number; triggers: number; inheritance: number; viewReferences: number } };
export type Admission = { ok: true } | { ok: false; reason: string };

/** The inventory read's rows, strictly: plain names and known kinds only, or null. */
export function parseInventoryRows(rows: unknown): ScratchObject[] | null {
  if (!Array.isArray(rows)) return null;
  const inventory: ScratchObject[] = [];
  for (const row of rows as Array<{ kind?: unknown; name?: unknown } | null>) {
    if (!row || typeof row.kind !== "string" || typeof row.name !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/.test(row.name)) return null;
    // A kind this harness never creates (a sequence, a foreign table, ...) stays visible as itself and matches nothing registered.
    inventory.push({ kind: row.kind as ScratchObjectKind, name: row.name });
  }
  return inventory;
}

/** The dependency read's single row, strictly: four non-negative whole numbers, or null. */
export function parseExternalRow(rows: unknown): SchemaObservation["external"] | null {
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const row = rows[0] as Record<string, unknown> | null;
  if (!row) return null;
  const values = [row.foreign_keys, row.triggers, row.inheritance, row.view_references];
  if (!values.every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) return null;
  return { foreignKeys: values[0] as number, triggers: values[1] as number, inheritance: values[2] as number, viewReferences: values[3] as number };
}

/**
 * Whether ONE scratch schema may be removed. All of: this run owns it by
 * exact name; nothing else of the run is still outstanding; what is in it is
 * EXACTLY what was registered — nothing extra, nothing missing; and no
 * dependency crosses its boundary in either direction. A matching name alone
 * is never enough. Reasons name no object.
 */
export function admitScratchSchemaCleanup(ownership: RunOwnership, schema: string, observation: SchemaObservation | null, outstandingOperations: number): Admission {
  try {
    ownership.assertOwnedSchema(schema);
  } catch {
    return { ok: false, reason: "the schema is not owned by this run" };
  }
  if (!Number.isSafeInteger(outstandingOperations) || outstandingOperations !== 0) return { ok: false, reason: "operations of this run are still outstanding" };
  if (observation === null) return { ok: false, reason: "the schema's contents or dependencies could not be read" };
  const key = (object: ScratchObject) => `${object.kind}:${object.name}`;
  const expected = ownership.objectsOf(schema).map(key).sort();
  const found = observation.inventory.map(key).sort();
  if (new Set(found).size !== found.length) return { ok: false, reason: "the schema's inventory lists an object twice" };
  if (found.some((entry) => !expected.includes(entry))) return { ok: false, reason: "the schema holds an object this run did not register" };
  if (expected.some((entry) => !found.includes(entry))) return { ok: false, reason: "a registered object is missing from the schema" };
  const { foreignKeys, triggers, inheritance, viewReferences } = observation.external;
  if (foreignKeys !== 0 || triggers !== 0 || inheritance !== 0 || viewReferences !== 0) return { ok: false, reason: "a dependency crosses the schema's boundary" };
  return { ok: true };
}

const countOf = (rows: unknown): number | null => {
  const n = Array.isArray(rows) && rows.length === 1 ? (rows[0] as { n?: unknown } | null)?.n : null;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
};

/**
 * Sends the planned steps, in order, through a gate — and STOPS at the first
 * step that is not confirmed, or the moment the gate is switched off. Before
 * EACH step it re-checks the gate and the target's ownership. It never
 * retries, never widens a statement, and never throws. `outstanding` is the
 * number of OTHER operations of the run still unsettled.
 */
export async function runCleanupPlan(ownership: RunOwnership, gate: CleanupGate, account: CleanupAccount, outstanding: () => number): Promise<CleanupAccount> {
  const inventories = new Map<string, ScratchObject[] | null>();
  for (const step of account.steps) {
    if (!gate.active()) {
      account.stopped = "switched_off";
      return account;
    }
    if (step.action === "delete_subject") ownership.assertOwnedSubject(step.target);
    if (step.action === "inspect_inventory" || step.action === "inspect_dependencies" || step.action === "drop_schema") ownership.assertOwnedSchema(step.target);
    if (step.action === "drop_object") ownership.assertOwnedSchema(step.target.split(".")[0]!);
    step.outcome = "in_flight";
    let rows: unknown;
    try {
      rows = await gate.q(step.statement.text, step.statement.params);
    } catch (error) {
      if (error instanceof CleanupStopped) {
        step.outcome = "not_attempted";
        account.stopped = "switched_off";
        return account;
      }
      step.sqlState = sqlStateOf(error);
      step.outcome = step.sqlState !== null ? "refused_by_database" : "no_answer";
      account.stopped = "a_step_failed";
      return account;
    }
    step.rows = Array.isArray(rows) ? rows.length : null;
    let accepted = Array.isArray(rows);
    if (accepted && step.action === "inspect_inventory") {
      const inventory = parseInventoryRows(rows);
      inventories.set(step.target, inventory);
      accepted = inventory !== null;
    } else if (accepted && step.action === "inspect_dependencies") {
      const inventory = inventories.get(step.target) ?? null;
      const external = parseExternalRow(rows);
      const admission = admitScratchSchemaCleanup(ownership, step.target, inventory !== null && external !== null ? { inventory, external } : null, outstanding());
      if (!admission.ok) {
        step.outcome = "refused_by_harness";
        account.stopped = "not_admitted";
        account.refusal = admission.reason;
        return account;
      }
    } else if (accepted && step.action === "delete_subject") {
      // At most one row per bucket, and only the six known buckets: anything else is not this harness's data.
      const buckets = (rows as Array<{ bucket?: unknown } | null>).map((row) => row?.bucket);
      accepted = buckets.length <= PROVIDER_BUDGET_BUCKETS.length && new Set(buckets).size === buckets.length && buckets.every((bucket) => typeof bucket === "string" && (PROVIDER_BUDGET_BUCKETS as readonly string[]).includes(bucket));
    } else if (accepted && (step.action === "read_subject_residue" || step.action === "read_schema_residue")) {
      accepted = countOf(rows) === 0;
      step.rows = countOf(rows);
    }
    if (!accepted) {
      step.outcome = "unexpected_answer";
      account.stopped = "a_step_failed";
      return account;
    }
    step.outcome = "confirmed";
  }
  return account;
}

export type CleanupSummary = {
  /**
   *   confirmed   every step was confirmed, both residue reads included: all of the run's owned data is gone.
   *   incomplete  something was refused or never sent — nothing is in doubt.
   *   uncertain   at least one issued statement has no known outcome.
   */
  status: "confirmed" | "incomplete" | "uncertain";
  steps: { total: number; confirmed: number; refusedByDatabase: number; unexpectedAnswer: number; refusedByHarness: number; noAnswer: number; inFlight: number; notAttempted: number };
  mayStillComplete: boolean;
};

export function summarizeCleanup(account: CleanupAccount): CleanupSummary {
  const count = (outcome: StepOutcome) => account.steps.filter((step) => step.outcome === outcome).length;
  const steps = { total: account.steps.length, confirmed: count("confirmed"), refusedByDatabase: count("refused_by_database"), unexpectedAnswer: count("unexpected_answer"), refusedByHarness: count("refused_by_harness"), noAnswer: count("no_answer"), inFlight: count("in_flight"), notAttempted: count("not_attempted") };
  const mayStillComplete = steps.inFlight > 0 || steps.noAnswer > 0;
  return { status: steps.total > 0 && steps.confirmed === steps.total ? "confirmed" : mayStillComplete ? "uncertain" : "incomplete", steps, mayStillComplete };
}

// ------------------------------------------------------------------ baseline plus expected delta

/** One public table as the preflight / post-run read measured it. */
export type TableFingerprint = { rows: number; contentDigest: string; shapeDigest: string };
/** What was measured, and only that: the public tables, and the names of the non-system schemas. */
export type DatabaseSnapshot = { tables: Record<string, TableFingerprint>; schemas: string[] };

export type ProviderTableDescriptor = {
  columns: Array<{ name: string; type: string; notNull: boolean; collation: string | null }>;
  /** CHECK and PRIMARY KEY constraints only, by name. */
  constraints: Array<{ name: string; type: "c" | "p"; columns: string[] }>;
  indexes: string[];
  triggers: number;
  foreignKeysOut: number;
  foreignKeysIn: number;
  policies: number;
  rowSecurity: boolean;
  rows: number;
};

/**
 * The one table a clean run leaves behind, as the post-run read must describe
 * it — and EMPTY. This is structure only: that the bucket CHECK lists exactly
 * the six buckets is proven by the live cases that insert against it, not by
 * this comparison.
 */
export const EXPECTED_PROVIDER_TABLE: ProviderTableDescriptor = {
  columns: [
    { name: "bucket", type: "text", notNull: true, collation: "C" },
    { name: "subject", type: "text", notNull: true, collation: null },
    { name: "window_start", type: "timestamp with time zone", notNull: true, collation: null },
    { name: "hits", type: "integer", notNull: true, collation: null },
  ],
  constraints: [
    { name: "real_provider_budgets_bucket_check", type: "c", columns: ["bucket"] },
    { name: "real_provider_budgets_hits_check", type: "c", columns: ["hits"] },
    { name: "real_provider_budgets_pkey", type: "p", columns: ["bucket", "subject"] },
  ],
  indexes: ["real_provider_budgets_pkey"],
  triggers: 0,
  foreignKeysOut: 0,
  foreignKeysIn: 0,
  policies: 0,
  rowSecurity: false,
  rows: 0,
};

export const DELTA_MEASURED = ["every public table's row count, content digest, and shape digest", "the names of the non-system schemas", `the structure and row count of public.${PROVIDER_TABLE}`] as const;
/** Said out loud in every verdict, so a clean run is never read as more than it measured. */
export const DELTA_NOT_MEASURED = ["functions, sequences, views, types, and extensions", "roles, grants, and database settings", "the contents of any schema other than public", "anything another session changed and changed back during the run"] as const;

export type DeltaVerdict = {
  ok: boolean;
  /** `baseline_plus_expected_delta` is the ONLY clean verdict. The table the run added remains, so the database is never "restored". */
  verdict: "baseline_plus_expected_delta" | "delta_mismatch";
  differences: string[];
  expectedDelta: { tableAdded: string; rows: 0 };
  measured: readonly string[];
  notMeasured: readonly string[];
};

const isFingerprint = (value: unknown): value is TableFingerprint => {
  const f = value as TableFingerprint | null;
  return !!f && typeof f === "object" && Number.isSafeInteger(f.rows) && f.rows >= 0 && typeof f.contentDigest === "string" && typeof f.shapeDigest === "string" && f.shapeDigest !== "";
};
const isSnapshot = (value: unknown): value is DatabaseSnapshot => {
  const s = value as DatabaseSnapshot | null;
  return !!s && typeof s === "object" && !!s.tables && typeof s.tables === "object" && Object.values(s.tables).every(isFingerprint) && Array.isArray(s.schemas) && s.schemas.every((name) => typeof name === "string") && new Set(s.schemas).size === s.schemas.length;
};
const canonicalDescriptor = (descriptor: ProviderTableDescriptor): string =>
  JSON.stringify({
    columns: descriptor.columns.map((column) => [column.name, column.type, column.notNull, column.collation]),
    constraints: [...descriptor.constraints].map((constraint) => [constraint.name, constraint.type, constraint.columns]).sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
    indexes: [...descriptor.indexes].sort(),
    counts: [descriptor.triggers, descriptor.foreignKeysOut, descriptor.foreignKeysIn, descriptor.policies, descriptor.rowSecurity, descriptor.rows],
  });

/**
 * Compares the post-run database with its pre-run baseline, EXPECTING exactly
 * one difference: `public.real_provider_budgets` now exists, has the intended
 * structure, and is empty. Everything else that was measured must be
 * identical. Anything unreadable or malformed is a mismatch, never a pass.
 */
export function compareWithExpectedDelta(input: { before: unknown; after: unknown; providerTable: unknown; ownedSchemas: readonly string[] }): DeltaVerdict {
  const differences: string[] = [];
  const done = (): DeltaVerdict => ({ ok: differences.length === 0, verdict: differences.length === 0 ? "baseline_plus_expected_delta" : "delta_mismatch", differences, expectedDelta: { tableAdded: `public.${PROVIDER_TABLE}`, rows: 0 }, measured: DELTA_MEASURED, notMeasured: DELTA_NOT_MEASURED });
  if (!isSnapshot(input.before) || !isSnapshot(input.after)) {
    differences.push("a snapshot is missing or malformed");
    return done();
  }
  const { before, after } = input;
  const has = (snapshot: DatabaseSnapshot, table: string) => Object.hasOwn(snapshot.tables, table);
  // Before.
  if (has(before, PROVIDER_TABLE)) differences.push(`baseline: public.${PROVIDER_TABLE} already existed before the run`);
  if (!has(before, "real_rate_limits")) differences.push("baseline: public.real_rate_limits was not measured before the run");
  for (const schema of input.ownedSchemas) if (before.schemas.includes(schema)) differences.push("baseline: a run-owned scratch schema existed before the run");
  // After: the pre-existing tables, one by one.
  for (const table of Object.keys(before.tables).sort()) {
    if (table === PROVIDER_TABLE) continue;
    if (!has(after, table)) {
      differences.push(`table removed: ${table}`);
      continue;
    }
    const was = before.tables[table]!;
    const is = after.tables[table]!;
    if (was.shapeDigest !== is.shapeDigest) differences.push(`catalog shape changed: ${table}`);
    if (was.rows !== is.rows || was.contentDigest !== is.contentDigest) differences.push(`contents changed: ${table}`);
  }
  for (const table of Object.keys(after.tables).sort()) if (table !== PROVIDER_TABLE && !has(before, table)) differences.push(`unexpected new table: ${table}`);
  // After: the one expected addition.
  if (!has(after, PROVIDER_TABLE)) differences.push(`expected delta missing: public.${PROVIDER_TABLE} does not exist after the run`);
  else if (after.tables[PROVIDER_TABLE]!.rows !== 0) differences.push(`expected delta wrong: public.${PROVIDER_TABLE} is not empty`);
  let described: string | null = null;
  try {
    described = canonicalDescriptor(input.providerTable as ProviderTableDescriptor);
  } catch {
    described = null;
  }
  if (described !== canonicalDescriptor(EXPECTED_PROVIDER_TABLE)) differences.push(`expected delta wrong: public.${PROVIDER_TABLE} does not match the intended descriptor (structure, or not empty)`);
  // After: schemas.
  for (const schema of input.ownedSchemas) if (after.schemas.includes(schema)) differences.push("a run-owned scratch schema remains");
  const beforeSchemas = [...before.schemas].sort().join("\n");
  const afterSchemas = [...after.schemas].sort().join("\n");
  if (beforeSchemas !== afterSchemas) differences.push("the set of schemas changed");
  return done();
}

// ------------------------------------------------------------------ evidence

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

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
  "cleanup",
  "fingerprintsBefore",
  "fingerprintsAfter",
  "expectedDelta",
  "unknownOperations",
  "inFlightOperations",
  "verdict",
] as const;
export type EvidenceStage = "start" | "final";

/** The fields a record of this stage lacks (an absent key or `undefined`; `null` and empty lists are answers). The run id and the statement digest must also be well-formed. */
export function missingEvidenceFields(stage: EvidenceStage, evidence: unknown): string[] {
  const required: readonly string[] = stage === "start" ? START_EVIDENCE_FIELDS : FINAL_EVIDENCE_FIELDS;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return [...required];
  const record = evidence as Record<string, unknown>;
  const missing = required.filter((field) => !Object.hasOwn(record, field) || record[field] === undefined);
  if (!missing.includes("runId") && (typeof record.runId !== "string" || !RUN_ID.test(record.runId))) missing.push("runId");
  if (!missing.includes("migrationStatementSha256") && (typeof record.migrationStatementSha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.migrationStatementSha256))) missing.push("migrationStatementSha256");
  return missing;
}

/** On top of Milestone 1's screen (which this never loosens): token-like material is refused too. */
const UNSAFE_EXTRA = /token|bearer|authorization|credential/i;

export type EvidenceWrite = { ok: true; file: string } | { ok: false; reason: "invalid_run_id" | "incomplete" | "unsafe_content" | "directory_not_private" | "already_exists" | "write_failed"; code: string | null };

/**
 * Saves one evidence record as `<directory>/provider-budget-smoke-<run id>-<stage>.json`.
 * The name is built from a validated run id and a fixed stage word; the record
 * must be complete for its stage and pass the content screen; the directory
 * must be the owner's alone (created 0700 if absent — an existing one that
 * others can enter is REFUSED, never re-permissioned); the file is created
 * exclusively (an existing file is never overwritten) with mode 0600, and that
 * mode is read back. Returns a classification — never an error message.
 */
export function writeProviderBudgetEvidence(input: { directory: string; runId: string; stage: EvidenceStage; evidence: unknown }): EvidenceWrite {
  if (!RUN_ID.test(input.runId) || (input.stage !== "start" && input.stage !== "final")) return { ok: false, reason: "invalid_run_id", code: null };
  if (missingEvidenceFields(input.stage, input.evidence).length > 0 || (input.evidence as { runId?: unknown }).runId !== input.runId) return { ok: false, reason: "incomplete", code: null };
  const json = safeEvidenceJson(input.evidence);
  if (json === null || UNSAFE_EXTRA.test(json)) return { ok: false, reason: "unsafe_content", code: null };
  const file = path.join(input.directory, `provider-budget-smoke-${input.runId}-${input.stage}.json`);
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
/** The tracked read a preflight, a case, or the post-run comparison issues its reads through. */
export type TrackedRead = <T>(what: string, operation: () => Promise<T>) => Promise<T>;
export type SchemaRefusal = { case: string | null; what: string; sqlState: string };
export type ReportedCleanupStep = Omit<CleanupStep, "statement">;

export type FinalReport = {
  outcome: "NOT_STARTED" | "COMPLETED_CLEAN" | "COMPLETED_DELTA_MISMATCH" | "POISONED";
  verdict: "not_started" | "baseline_plus_expected_delta" | "delta_mismatch" | "poisoned_evidence_preserved";
  /** Always false: even a clean run leaves the table it added. */
  completeRestoration: false;
  poisoned: string | null;
  executed: string[];
  notExecuted: string[];
  /** Still unsettled at the end: each may yet take effect. */
  inFlightOperations: string[];
  /** Sent, never answered: each may or may not have taken effect. */
  unknownOperations: string[];
  operationsIssued: number;
  admissionTallies: Record<string, { admitted: number; denied: number }>;
  schemaRefusals: SchemaRefusal[];
  cleanup: { attempted: boolean; accepted: boolean; skipped: string | null; inFlight: boolean; summary: CleanupSummary | null; stopped: CleanupAccount["stopped"]; refusal: string | null; steps: ReportedCleanupStep[] };
  /** Names this run registered. After a failure their presence in the database is NOT verified. */
  ownedSubjects: string[];
  ownedSchemas: string[];
  delta: DeltaVerdict | null;
  action: string;
};

const INVESTIGATE = "Investigate the disposable branch read-only. Do not reuse or automatically repair the branch.";

/**
 * The run's one state machine. Rules, none of which can be undone during a run:
 *
 *   - `poison` is permanent and keeps its FIRST reason. It is set by a failed
 *     preflight check, a case that throws or outlives its deadline, any
 *     database answer that is not the one the call expects, a lost answer, an
 *     operation attempted in the wrong state, a cleanup that is not
 *     confirmed, and a failure the test runner reports. Poisoning also seals
 *     ownership: nothing can be registered afterwards.
 *   - Nothing may be written before `arm`, and `arm` needs every required
 *     preflight check passed, nothing unsettled, and the start evidence saved.
 *   - Once poisoned, NOTHING new is sent: no case, no write, no read, no
 *     cleanup, no comparison. Each refusal happens before the operation's
 *     function is called.
 *   - Every operation is tracked from the moment it is issued until it REALLY
 *     settles. A deadline stops the run waiting; it does not make the
 *     operation finished, and it cannot be un-poisoned by a late answer.
 *   - A case starts only when the run is armed, clean, idle (nothing
 *     unsettled), and it is the next expected case.
 *   - There is ONE cleanup, at the end, attempted at most once, and only
 *     after every expected case completed with nothing unsettled.
 */
export function createProviderBudgetLifecycle(input: { expectedCases: readonly string[]; requiredPreflightChecks: readonly string[]; caseDeadlineMs: number; cleanupDeadlineMs: number; preflightDeadlineMs?: number; ownership: RunOwnership }) {
  /** The preflight's deadline: its own if given, else the case deadline. There is no preflight without one. */
  const preflightDeadlineMs = input.preflightDeadlineMs ?? input.caseDeadlineMs;
  for (const ms of [input.caseDeadlineMs, input.cleanupDeadlineMs, preflightDeadlineMs]) if (!Number.isSafeInteger(ms) || ms < 1) throw new Error("provider budget smoke: a deadline must be a positive whole number of milliseconds");
  if (input.expectedCases.length === 0 || new Set(input.expectedCases).size !== input.expectedCases.length) throw new Error("provider budget smoke: the expected cases must be a non-empty list of distinct names");
  if (input.requiredPreflightChecks.length === 0 || new Set(input.requiredPreflightChecks).size !== input.requiredPreflightChecks.length) throw new Error("provider budget smoke: the required preflight checks must be a non-empty list of distinct names");

  let phase: Exclude<LifecycleState, "POISONED"> = "NOT_STARTED";
  let poisoned: string | null = null;
  let caseInFlight: string | null = null;
  /** The preflight body, from its start until it REALLY settles. */
  let preflightInFlight = false;
  let preflightTimer: ReturnType<typeof setTimeout> | undefined;
  /** Rejects the preflight a caller is awaiting, the moment its deadline passes. */
  let onPreflightExpired: ((error: Error) => void) | null = null;
  /** True only while the post-run comparison may issue its (read-only) reads. */
  let verifying = false;
  /** The post-run comparison, from its start until it REALLY settles. */
  let verifyInFlight = false;
  let operationSeq = 0;
  let issued = 0;
  const operations = new Map<number, OperationRecord>();
  const unknownOperations: string[] = [];
  const passedChecks = new Set<string>();
  const executed: string[] = [];
  const tallies: Record<string, { admitted: number; denied: number }> = {};
  const schemaRefusals: SchemaRefusal[] = [];
  const cleanup: { attempted: boolean; accepted: boolean; skipped: string | null; inFlight: boolean; account: CleanupAccount | null } = { attempted: false, accepted: false, skipped: null, inFlight: false, account: null };

  const poison = (reason: string): void => {
    if (poisoned === null) poisoned = reason; // the FIRST reason is kept; nothing ever clears it
    input.ownership.seal("the run is poisoned");
  };
  const refusal = (what: string) => new Error(`provider budget smoke: ${what} refused — the run is poisoned (${String(poisoned)}). A failed live run stops here; it is never retried automatically.`);

  /** Decides, BEFORE anything is sent, whether `count` operations may be issued now. Throws (and poisons, where the attempt itself is a fault) otherwise. */
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
  /** Sends one operation and tracks it until it really settles — whoever is, or is no longer, waiting for it. */
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
  /** A rejection nobody declared as expected: a database refusal or a lost answer. Either way the run is over. */
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
    if (poisoned !== null) throw refusal(`using the answer to ${what} was`); // poisoned from elsewhere while it was in flight
    return settled.value as T;
  };
  const noteOutcome = (what: string, outcome: ConsumeOutcome): void => {
    if (outcome.kind === "admitted" || outcome.kind === "denied") {
      const tally = (tallies[caseInFlight ?? ""] ??= { admitted: 0, denied: 0 });
      tally[outcome.kind] += 1;
    } else if (outcome.kind === "database_error") poison(`a budget request (${what}) was refused by the database (SQLSTATE ${outcome.sqlState}); that is not a budget denial`);
    else if (outcome.kind === "limiter_refusal") poison(`a budget request (${what}) was refused by the limiter itself; whether it was charged is unknown`);
    else {
      unknownOperations.push(what);
      poison(`no usable answer for a budget request (${what}); it may or may not have been charged`);
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

    /**
     * NOT_STARTED -> PREFLIGHT. Called once, after the target, connection-mode,
     * file-selection, and timeout-flag checks passed. The preflight's deadline
     * starts HERE, whoever is or is not awaiting it: a run still in PREFLIGHT
     * when it passes is poisoned. Only `arm` stops that clock.
     */
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
        onPreflightExpired?.(new Error("provider budget smoke: the preflight exceeded its deadline. Nothing was written, and nothing is retried."));
      }, preflightDeadlineMs);
      // The clock never keeps a finished process alive; anything still awaiting the preflight does that by itself.
      (preflightTimer as { unref?: () => void }).unref?.();
    },
    /**
     * The whole read-only preflight as ONE awaited step: `beginPreflight`,
     * then `body` (its reads, its checks, the start evidence, and `arm`),
     * rejecting the moment the preflight deadline passes. A body that throws
     * poisons too. A body that was abandoned stays in flight until it really
     * settles, and every read or `arm` it attempts afterwards is refused.
     */
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
    /** Records one named read-only preflight finding. A failed, unknown, or repeated check poisons. */
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
    /**
     * PREFLIGHT -> ARMED: the only door to a write. Needs every required
     * check passed, nothing unsettled, and the START evidence already saved.
     */
    arm(start: { startEvidence: EvidenceWrite }): void {
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
    /** One write. Allowed only inside a case of an armed run. Any failure poisons; it is never repeated. */
    write: <T>(what: string, operation: () => Promise<T>): Promise<T> => plain(what, "write", operation),

    /**
     * One operation that the DATABASE IS EXPECTED TO REFUSE, with one of the
     * SQLSTATEs this call names. Only that passes. Success, another SQLSTATE,
     * and a lost answer all poison.
     */
    async expectRefusal(what: string, operation: () => Promise<unknown>, allowedSqlStates: readonly string[]): Promise<{ sqlState: string; constraint: string | null }> {
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

    /** One budget request. Returns only `admitted` or `denied`; every other outcome poisons — it is never a denial. */
    async consume(what: string, operation: () => Promise<unknown>): Promise<Extract<ConsumeOutcome, { kind: "admitted" | "denied" }>> {
      const outcome = classifyConsume(await settle({ what, phase: admit(what, "write"), mode: "write" }, operation));
      noteOutcome(what, outcome);
      if (poisoned !== null || (outcome.kind !== "admitted" && outcome.kind !== "denied")) throw refusal(`continuing after ${what} was`);
      return outcome;
    },
    /** Several budget requests issued TOGETHER (bounded). Resolves only once every one has settled; one bad outcome poisons the run. */
    async consumeBurst(what: string, requests: ReadonlyArray<() => Promise<unknown>>): Promise<Array<Extract<ConsumeOutcome, { kind: "admitted" | "denied" }>>> {
      if (requests.length < 1 || requests.length > MAX_CONCURRENCY) {
        poison(`a burst (${what}) was outside the concurrency bound`);
        throw refusal(what);
      }
      const phaseNow = admit(what, "write", requests.length);
      const outcomes = (await Promise.all(requests.map((operation) => settle({ what, phase: phaseNow, mode: "write" }, operation)))).map(classifyConsume);
      for (const outcome of outcomes) noteOutcome(what, outcome);
      if (poisoned !== null) throw refusal(`continuing after ${what} was`);
      return outcomes as Array<Extract<ConsumeOutcome, { kind: "admitted" | "denied" }>>;
    },

    /** Runs one live case. Refuses BEFORE calling `body` unless the run is armed, clean, idle, and this is the next expected case. */
    async runCase<T>(name: string, body: () => Promise<T>): Promise<T> {
      if (poisoned !== null) throw refusal(`"${name}" was not run: starting it was`);
      if (phase === "NOT_STARTED" || phase === "PREFLIGHT") throw new Error("provider budget smoke: not run — the run is not armed, so nothing may be written");
      if (caseInFlight !== null) poison(`"${caseInFlight}" was still running when "${name}" was about to start`);
      else if (phase !== "ARMED") poison(`"${name}" was about to start in state ${phase}`);
      if (operations.size > 0) poison(`${operations.size} operation(s) were still unsettled when "${name}" was about to start`);
      if (input.expectedCases[executed.length] !== name) poison(`"${name}" is not the next expected case`);
      if (poisoned !== null) throw refusal(`"${name}" was not run: starting it was`);

      phase = "RUNNING";
      caseInFlight = name;
      // The body stays in flight until IT settles — never merely because nobody is awaiting it any more.
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
      tracked.catch(() => undefined); // an abandoned body's late failure is already recorded as poison
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          poison(`"${name}" exceeded its ${input.caseDeadlineMs} ms deadline; its database requests may still be running or may still complete`);
          reject(new Error(`provider budget smoke: "${name}" exceeded its deadline. Its outcome is uncertain; nothing is retried.`));
        }, input.caseDeadlineMs);
      });
      try {
        const value = await Promise.race([tracked, deadline]);
        // A helper inside the body may have poisoned the run and had its error swallowed: still a failure.
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

    /** After every test. Sends NOTHING, ever: it only lets the runner's own verdict, or a body the runner abandoned, poison the run. */
    afterCase(observed: { reportedFailed: boolean }): void {
      if (phase === "NOT_STARTED" || phase === "PREFLIGHT") return;
      if (caseInFlight !== null) poison(`"${caseInFlight}" was still running when its test ended (it timed out or was abandoned); its database requests may still complete`);
      if (observed.reportedFailed) poison("the test runner reported a test as failed");
    },

    /**
     * The ONE cleanup. Sends something only when the run is armed, clean,
     * complete, and idle; otherwise it records why nothing was sent. It is
     * attempted at most once. Throws when a cleanup it started was not
     * confirmed, or outlived its deadline.
     */
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

      // Everything below is synchronous up to the first statement.
      cleanup.attempted = true;
      phase = "CLEANUP";
      input.ownership.seal("the final cleanup began");
      const account = planCleanup(input.ownership);
      cleanup.account = account;
      let expired = false;
      const gate: CleanupGate = {
        // Checked before every statement: still clean, and still inside the deadline.
        active: () => poisoned === null && !expired,
        q: (text, params) => (gate.active() ? db.q(text, params) : Promise.reject(new CleanupStopped("cleanup switched off"))),
      };
      cleanup.inFlight = true;
      // In flight until the loop ITSELF settles — never merely because the deadline passed or the hook was abandoned.
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
          reject(new Error("provider budget smoke: the final cleanup exceeded its deadline. No further cleanup statement will be sent; what was already issued may still complete. Nothing is retried."));
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
        throw new Error(`provider budget smoke: the final cleanup was ${summary.status}. No further cleanup will be attempted; the database state is unknown.`);
      }
      if (poisoned !== null) throw refusal("counting the cleanup as done was"); // poisoned from elsewhere while it ran
      cleanup.accepted = true;
    },

    /**
     * The end of the run. Makes NO write and sends no cleanup. The post-run
     * comparison is read only for a run that is clean, complete, and cleaned
     * up; a poisoned run reads nothing further and is never reported clean.
     * The comparison issues its reads through the `read` it is handed — each
     * tracked like any other operation, and read-only — and has its own
     * deadline (the cleanup deadline unless another is given): outliving it
     * poisons, and its reads stay in flight until they really settle.
     */
    async finish(end: { compare: (read: <T>(what: string, operation: () => Promise<T>) => Promise<T>) => Promise<DeltaVerdict>; deadlineMs?: number }): Promise<FinalReport> {
      const verifyDeadlineMs = end.deadlineMs ?? input.cleanupDeadlineMs;
      if (!Number.isSafeInteger(verifyDeadlineMs) || verifyDeadlineMs < 1) throw new Error("provider budget smoke: a deadline must be a positive whole number of milliseconds");
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
        ownedSubjects: input.ownership.ownedSubjects(),
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
            reject(new Error("provider budget smoke: the post-run comparison exceeded its deadline."));
          }, verifyDeadlineMs);
        });
        try {
          delta = await Promise.race([tracked, deadline]);
        } catch {
          delta = null;
          poison("the post-run comparison could not be read");
        } finally {
          clearTimeout(timer);
          verifying = false; // whatever the comparison still does afterwards is refused
        }
        if (poisoned === null && delta !== null) {
          if (delta.ok === true && delta.verdict === "baseline_plus_expected_delta" && delta.differences.length === 0) {
            phase = "COMPLETED_CLEAN";
            return report("COMPLETED_CLEAN", "baseline_plus_expected_delta", `None. Every case ran, the cleanup was confirmed, and the database is at its baseline PLUS the expected delta: public.${PROVIDER_TABLE} now exists, empty. It was not restored to its pre-run state, and only what the comparison lists as measured was verified.`);
          }
          phase = "COMPLETED_DELTA_MISMATCH";
          return report("COMPLETED_DELTA_MISMATCH", "delta_mismatch", `Every case ran and the cleanup was confirmed, but the database does NOT match its baseline plus the expected delta. ${INVESTIGATE}`);
        }
      }
      const action = !cleanup.attempted
        ? `The run is poisoned. No cleanup was started, so the harness itself removed none of the rows or schemas it registered — but their presence was not verified, and a request still in flight may have changed them. ${INVESTIGATE}`
        : `The database state is unknown after this failure: the final cleanup was started and not confirmed, so some run-owned rows or schemas may be gone and some may remain (see cleanup.steps). ${INVESTIGATE}`;
      return report("POISONED", "poisoned_evidence_preserved", action);
    },
  };
}
export type ProviderBudgetLifecycle = ReturnType<typeof createProviderBudgetLifecycle>;

/**
 * The run's verdict: it passes ONLY when the lifecycle ended COMPLETED_CLEAN
 * with the baseline-plus-expected-delta verdict AND both evidence records were
 * saved. Anything else is a failure — reported, never retried, and never a
 * reason to touch the database again.
 */
export function concludeProviderBudgetRun(final: FinalReport, saved: { start: EvidenceWrite; final: EvidenceWrite }): { pass: boolean; verdict: "clean_and_evidenced" | "clean_but_not_evidenced" | "not_clean"; message: string } {
  const evidenced = saved.start.ok && saved.final.ok;
  if (final.outcome !== "COMPLETED_CLEAN" || final.verdict !== "baseline_plus_expected_delta" || final.poisoned !== null) return { pass: false, verdict: "not_clean", message: `provider budget smoke: ${final.outcome}. ${final.action}${evidenced ? "" : " An evidence record was also NOT saved."}` };
  if (!evidenced) return { pass: false, verdict: "clean_but_not_evidenced", message: "provider budget smoke: every case ran and the database is at its baseline plus the expected delta, but an evidence record was NOT saved, so this is not an evidenced successful run. Nothing is retried and the database is not touched again." };
  return { pass: true, verdict: "clean_and_evidenced", message: "provider budget smoke: completed clean (baseline plus expected delta), evidence saved." };
}
