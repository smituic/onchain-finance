// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { REGISTRATION_ADMISSION_POLICY, createRegistrationAdmission, type RegistrationAdmission, type RegistrationAdmissionPolicy, type RegistrationAdmissionStore } from "@/lib/real/server/registration-admission";
import { checkDisposableTarget, connectSmokeDb, connectSmokeStores, parseDatabaseUrl, requireDisposableTargetUrl, type SmokeDb, type SmokeRow } from "./fixtures/handles-smoke-db";
import { createRunOwnership, type DatabaseSnapshot, type ScratchObjectKind } from "./fixtures/provider-budget-smoke";
import {
  BACKDATE_DAY_SQL,
  BACKDATE_SHORT_SQL,
  CAN_SEE_ACTIVITY_SQL,
  CASE_DEADLINE_MS,
  CLEANUP_DEADLINE_MS,
  COUNT_ROWS_SQL,
  EXPECTED_ADMISSION_TABLE,
  HOLDER_ACTIVE_SQL,
  MAX_CONCURRENCY,
  READ_ROW_SQL,
  REMOVE_ROW_SQL,
  REGISTRATION_ADMISSION_SMOKE_FILE,
  RENAME_AWAY_SQL,
  RENAME_BACK_SQL,
  SET_ROW_SQL,
  VITEST_TIMEOUT_MS,
  WAITER_BLOCKED_SQL,
  assertPlainIdentifier,
  caseFailedInVitest,
  checkRegistrationAdmissionFileSelection,
  checkRunnerTimeoutFlags,
  compareWithExpectedAdmissionDelta,
  concludeRegistrationAdmissionRun,
  createRegistrationAdmissionLifecycle,
  holderStatements,
  requirePooledMode,
  safeEvidenceJson,
  sha256Hex,
  tallyOutcomes,
  writeRegistrationAdmissionEvidence,
  type AdmissionOutcome,
  type AdmissionTableDescriptor,
  type EvidenceResult,
  type SeedRow,
  type TrackedRead,
} from "./fixtures/registration-admission-smoke";

/**
 * MANUAL, LIVE-DATABASE proof of the global registration-admission table, its
 * migration block, and its TWO admission statements (Milestone 3C-1), against a
 * DISPOSABLE Neon branch.
 *
 * IT HAS NEVER BEEN RUN LIVE. Nothing in this file is evidence of PostgreSQL or
 * Neon behavior, and no SQL it contains has ever been executed or parsed by a
 * database. Every claim about READ COMMITTED, tuple locks, re-checking a row
 * after a lock wait, and "no new row version on a refusal" is the design's
 * expectation that this run exists to test.
 *
 * EXPLICITLY OPT-IN, AND NOT RUN as part of the build: its harness checks below
 * always run; every live case is skipped unless its own gate is set, and then
 * it runs only against a confirmed disposable Neon target. It must NEVER be
 * pointed at the real database. Separate explicit authorization is needed
 * before its first live execution.
 *
 * WHAT IT DRIVES. schema.sql's "Registration Admission" block, exactly as
 * written (only its target-schema constant is swapped for a scratch schema), and
 * the application's OWN admission over its OWN Neon store
 * (createRegistrationAdmission(createNeonDurableStores().registrationAdmission))
 * with truly concurrent requests. It makes NO provider call and no route is
 * involved. Policy numbers other than the frozen production ones are TEST
 * VALUES passed to the store's own policy parameter; the frozen production
 * policy is not modified.
 *
 * DISPOSABLE BRANCH ONLY. It never reads DATABASE_URL: the target is
 * NEON_BRANCH_DATABASE_URL, and it refuses to connect unless that endpoint
 * differs from the real database's (.env.local), DATABASE_URL is not exported,
 * and no admin or other smoke gate is set.
 *
 * Milestone 0 Pass B: the run also requires NEON_BRANCH_EXPECTED_ENDPOINT_ID —
 * the branch's endpoint id, read by the operator from the Neon console — and
 * refuses to connect unless it equals the URL's endpoint exactly. Differing
 * from .env.local does not prove a branch is disposable; neither does this.
 *
 * POOLED CONNECTION, EXACT FILE, SAFE TIMEOUTS. It refuses a direct connection
 * string, refuses unless Vitest was started as exactly `vitest run <this file>`
 * (no other file, no name filter), and refuses any runner-timeout flag below
 * 120000 ms. Every test and hook carries that timeout explicitly, and the run's
 * own deadlines (90 s per case and for the preflight, 60 s for the cleanup and
 * for the post-run comparison) are shorter. Do NOT pass the older smokes' 30000
 * ms flags.
 *
 * ISOLATION IS CHECKED ON THE PATH PRODUCTION USES. The preflight reads
 * transaction_isolation and default_transaction_isolation through ONE
 * single-statement request — the same autocommit path the application's two
 * admission statements take — and refuses to arm unless both are
 * "read committed". It does not infer it from a batch's pinned isolation.
 *
 * FRESH BRANCH, ONE RUN. The branch must NOT already have
 * public.real_registration_admission: the first case proves admission fails
 * closed without the table, and a later one applies the block to `public`.
 * Never rerun on a used branch.
 *
 * BOUNDED. At most 1500 tracked operations, 60 simultaneous admission requests,
 * 60 test-fixture writes to the singleton row, 80 activity polls, and one
 * connection per request (the Neon HTTP driver). Nothing is retried; a lost
 * answer poisons the run.
 *
 * THE TEST-FIXTURE WRITES. This run, on its disposable branch only, edits the
 * one public singleton row directly (set / backdate), deletes it once, renames
 * the table away and back once, and holds its lock from a second session — all
 * through the fixture's fixed, pinned statements, and every one counted. The
 * final case restores the row to the seed state, and the post-run comparison
 * requires EXACTLY the seed (both counters 0, both windows at the epoch).
 *
 * WHAT A CLEAN RUN LEAVES BEHIND. Not the baseline: the baseline PLUS the
 * expected delta — public.real_registration_admission now exists, with the
 * intended structure and exactly the seed row. Every pre-existing public table
 * must be unchanged in contents and shape, and every scratch schema of this run
 * must be gone. It is never reported as "restored".
 *
 * NO PER-CASE CLEANUP. One cleanup runs at the end, only if every case
 * completed cleanly: exact registered scratch objects and schemas, RESTRICT
 * only, after a read-only check that each scratch schema holds exactly what was
 * registered and nothing outside it depends on it. No Neon branch is ever
 * deleted by this file.
 *
 * A FAILED RUN KEEPS ITS EVIDENCE. The moment a case fails, times out, or gets
 * an answer it did not expect, the run is poisoned for good: no later case, no
 * further write or read, and NO cleanup. Investigate the branch read-only and do
 * not reuse it. A database error or a fail-closed error is never counted as a
 * denial, and nothing is ever retried.
 *
 * EVIDENCE. Two NEW owner-only files in `evidence/` (git-ignored; an existing
 * file is never overwritten): `registration-admission-smoke-<run id>-start.json`,
 * saved before anything may be written, and `...-final.json`. Never a connection
 * string, an endpoint id, a credential, or a driver's error text. A clean run
 * whose evidence cannot be saved FAILS.
 *
 *   REAL_SMOKE_REGISTRATION_ADMISSION=1 NEON_BRANCH_DATABASE_URL="postgres://..." NEON_BRANCH_EXPECTED_ENDPOINT_ID="ep-..." \
 *     pnpm exec vitest run test/lib/real/registration-admission.smoke.test.ts
 */
const GATE = "REAL_SMOKE_REGISTRATION_ADMISSION";
const ALLOWED_GATES = [GATE] as const;
const enabled = process.env[GATE] === "1";

/** Where the run's evidence is saved: a fixed, git-ignored directory. The file names are built from the run id alone. */
const EVIDENCE_DIRECTORY = "evidence";
/** The most admission requests ever issued together (the largest scenario below is 60). */
const BURST = 60;

const SCHEMA_PATH = "lib/real/server/schema.sql";
const BEGIN = "-- BEGIN Registration Admission";
const END = "-- END Registration Admission";
const TARGET_LINE = "target_schema CONSTANT pg_catalog.text := 'public';";
const SCRATCH_NAME = /^pb_smoke_[0-9a-f]{8}_[a-z0-9]{1,12}$/;

/** The statement under test: the block's single DO statement, exactly as schema.sql has it. */
function migrationBlock(): string {
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  if (schema.split(BEGIN).length !== 2 || schema.split(END).length !== 2) throw new Error("the Registration Admission block was not found exactly once in schema.sql");
  const section = schema.slice(schema.indexOf(BEGIN), schema.indexOf(END));
  const start = section.indexOf("DO $$");
  const end = section.lastIndexOf("END $$;");
  if (start < 0 || end < start || section.split("DO $$").length !== 2) throw new Error("the Registration Admission block does not hold exactly one statement");
  const block = section.slice(start, end + "END $$;".length);
  if (block.split(TARGET_LINE).length !== 2) throw new Error("the block does not have exactly one target-schema constant");
  return block;
}
/** The same statement with ONLY its target-schema constant swapped, for a name of this harness's scratch shape. */
function migrationBlockFor(schemaName: string): string {
  if (!SCRATCH_NAME.test(schemaName)) throw new Error("registration admission smoke: the block may only be retargeted at a scratch schema of this harness's shape");
  return migrationBlock().replace(TARGET_LINE, `target_schema CONSTANT pg_catalog.text := '${schemaName}';`);
}
const MIGRATION_SHA256 = sha256Hex(migrationBlock());

/** Every live case, in order. The run is clean only if exactly these ran. */
const EXPECTED_CASES = [
  "S1. missing table: the production admission fails closed before the block is applied",
  "S2. scratch schema: first apply seeds one row, an idempotent rerun preserves it, a live counter survives a rerun, exact catalog descriptor",
  "S3. scratch schema: the CHECKs, the primary key, and NOT NULL are enforced, and no second scope can exist",
  "S4. scratch schemas: an exact hand-built copy is accepted and seeded, and the mandatory look-alikes are refused and left unchanged",
  "S5. scratch schemas: further look-alikes are refused and left unchanged",
  "S6. a target schema that does not exist is refused, and is not created",
  "S7. public: the exact block applies once, reruns idempotently, seeds exactly the intended row, and matches the expected descriptor",
  "I1. a single autocommit statement runs at READ COMMITTED, and the first admission anchors both windows",
  "I2. the production policy admits exactly 30, then refuses the 31st without touching the row",
  "I3. the production policy admits exactly 100 across hourly windows, then refuses the 101st",
  "I4. hourly rollover: the short window resets while the daily window keeps counting",
  "I5. daily rollover and independent rollover: a refusal charges neither window",
  "I6. Retry-After: short only, daily only, both (the longest), and a lowered limit",
  "I7. denial purity: 25 further refusals leave counters, window starts, xmin and ctid unchanged",
  "C1. 60 simultaneous requests against a limit of 30: exactly 30 admitted",
  "C2. 50 simultaneous requests against a daily limit of 20: exactly 20 admitted, no partial charging",
  "C3. both counters one below their limits, 10 simultaneous: exactly one admitted, both rise together",
  "C4. both windows elapsed, 40 simultaneous: one rollover and exactly 30 admitted",
  "R1. a blocked admission re-checks the newer row after the holder commits: refused, no extra admission",
  "R2. a snapshot that sees an exhausted window while another session rolls it: never falsely admitted",
  "F1. a missing singleton row fails closed, is not repaired by a request, and an operator rerun reseeds it",
  "F2. a malformed window start fails closed, and a small future start is clamped",
  "F3. a database error propagates as itself and is never an admission or a denial",
  "F4. the row is restored to the seed state",
] as const;

/** Every named read-only finding the preflight must record before the run may be armed. */
const PREFLIGHT_CHECKS = [
  "the connected database is the one the confirmed URL names",
  "the target is not a read replica",
  "unqualified names resolve to public",
  "the server is version 15 or newer (the migration reads pg_index.indnullsnotdistinct)",
  "a single autocommit statement runs at READ COMMITTED (the path production admission uses)",
  "the database default isolation is READ COMMITTED",
  "no relation named real_registration_admission exists in any schema",
  "public.real_rate_limits exists",
  "no scratch schema of this harness's shape exists",
  "this session can see pg_stat_activity (the race cases need to)",
] as const;

/** A second policy for the daily-limit scenario: the short window is generous so only the daily one decides. */
const DAILY_TWENTY: RegistrationAdmissionPolicy = { short: { limit: 1000, windowSeconds: 3600 }, day: { limit: 20, windowSeconds: 86_400 } };
const HOUR = 3600;
const DAY = 86_400;

// The look-alike tables: the intended definition, in parts, so each variant differs from it in exactly one way.
const COLUMNS = {
  scope: 'scope TEXT COLLATE "C" NOT NULL',
  shortStart: "short_window_start TIMESTAMPTZ NOT NULL",
  shortHits: "short_hits INTEGER NOT NULL",
  dayStart: "day_window_start TIMESTAMPTZ NOT NULL",
  dayHits: "day_hits INTEGER NOT NULL",
};
const PRIMARY_KEY = "CONSTRAINT real_registration_admission_pkey PRIMARY KEY (scope)";
const SCOPE_CHECK = "CONSTRAINT real_registration_admission_scope_check CHECK (scope = 'register_options')";
const SHORT_CHECK = "CONSTRAINT real_registration_admission_short_hits_check CHECK (short_hits >= 0 AND short_hits <= 100000)";
const DAY_CHECK = "CONSTRAINT real_registration_admission_day_hits_check CHECK (day_hits >= 0 AND day_hits <= 100000)";
const tableDdl = (schema: string, parts: readonly string[], options: { prefix?: string; tail?: string } = {}) => `CREATE ${options.prefix ?? ""}TABLE ${schema}.real_registration_admission (${parts.join(", ")})${options.tail ?? ""}`;
type PartOverrides = Partial<Record<"scope" | "shortStart" | "shortHits" | "dayStart" | "dayHits" | "pk" | "scopeCheck" | "shortCheck" | "dayCheck", string | null>>;
const exact = (overrides: PartOverrides = {}, extra: readonly string[] = []): string[] => {
  const parts = { ...COLUMNS, pk: PRIMARY_KEY, scopeCheck: SCOPE_CHECK, shortCheck: SHORT_CHECK, dayCheck: DAY_CHECK, ...overrides };
  return [parts.scope, parts.shortStart, parts.shortHits, parts.dayStart, parts.dayHits, ...extra.filter((part) => !part.startsWith("CONSTRAINT")), parts.pk, parts.scopeCheck, parts.shortCheck, parts.dayCheck, ...extra.filter((part) => part.startsWith("CONSTRAINT"))].filter((part): part is string => typeof part === "string");
};
type Step = { register?: [ScratchObjectKind, string]; sql: string };
type Variant = { suffix: string; what: string; steps: (schema: string) => Step[] };
const lookAlike = (sql: string): Step => ({ register: ["table", "real_registration_admission"], sql });

/** The mandatory wrong shapes. Each is ONE table, wholly inside its own scratch schema. */
const MANDATORY_VARIANTS: Variant[] = [
  { suffix: "m01", what: "an extra column", steps: (s) => [lookAlike(tableDdl(s, exact({}, ["extra_note TEXT"])))] },
  { suffix: "m02", what: "a missing column", steps: (s) => [lookAlike(tableDdl(s, exact({ dayStart: null })))] },
  { suffix: "m03", what: "short_hits as BIGINT", steps: (s) => [lookAlike(tableDdl(s, exact({ shortHits: "short_hits BIGINT NOT NULL" })))] },
  { suffix: "m04", what: "scope without its collation", steps: (s) => [lookAlike(tableDdl(s, exact({ scope: "scope TEXT NOT NULL" })))] },
  { suffix: "m05", what: "scope under a different built-in collation", steps: (s) => [lookAlike(tableDdl(s, exact({ scope: 'scope TEXT COLLATE "POSIX" NOT NULL' })))] },
  { suffix: "m06", what: "a nullable window start", steps: (s) => [lookAlike(tableDdl(s, exact({ shortStart: "short_window_start TIMESTAMPTZ" })))] },
  { suffix: "m07", what: "a column default", steps: (s) => [lookAlike(tableDdl(s, exact({ shortHits: "short_hits INTEGER NOT NULL DEFAULT 0" })))] },
  { suffix: "m08", what: "the primary key under the wrong name", steps: (s) => [lookAlike(tableDdl(s, exact({ pk: "CONSTRAINT ra_wrong_pkey PRIMARY KEY (scope)" })))] },
  { suffix: "m09", what: "the primary key over the wrong columns", steps: (s) => [lookAlike(tableDdl(s, exact({ pk: "CONSTRAINT real_registration_admission_pkey PRIMARY KEY (scope, short_hits)" })))] },
  { suffix: "m10", what: "no scope CHECK", steps: (s) => [lookAlike(tableDdl(s, exact({ scopeCheck: null })))] },
  { suffix: "m11", what: "a scope CHECK admitting a second scope", steps: (s) => [lookAlike(tableDdl(s, exact({ scopeCheck: "CONSTRAINT real_registration_admission_scope_check CHECK (scope IN ('register_options', 'login_options'))" })))] },
  { suffix: "m12", what: "a short_hits CHECK allowing negatives", steps: (s) => [lookAlike(tableDdl(s, exact({ shortCheck: "CONSTRAINT real_registration_admission_short_hits_check CHECK (short_hits >= -1 AND short_hits <= 100000)" })))] },
  { suffix: "m13", what: "a day_hits CHECK with a higher bound", steps: (s) => [lookAlike(tableDdl(s, exact({ dayCheck: "CONSTRAINT real_registration_admission_day_hits_check CHECK (day_hits >= 0 AND day_hits <= 100001)" })))] },
  { suffix: "m14", what: "the scope CHECK under the wrong name", steps: (s) => [lookAlike(tableDdl(s, exact({ scopeCheck: "CONSTRAINT ra_wrong_scope_check CHECK (scope = 'register_options')" })))] },
  { suffix: "m15", what: "an extra index", steps: (s) => [lookAlike(tableDdl(s, exact())), { sql: `CREATE INDEX ra_extra_idx ON ${s}.real_registration_admission (short_hits)` }] },
];

/**
 * Further wrong shapes. Every object each one needs — a parent, a child, a
 * trigger function — is created INSIDE the same scratch schema and registered
 * before it exists, in dependency order; nothing outside the schema is ever
 * referenced, altered, or made to depend on it.
 */
const FURTHER_VARIANTS: Variant[] = [
  { suffix: "a01", what: "an extra CHECK", steps: (s) => [lookAlike(tableDdl(s, exact({}, ["CONSTRAINT ra_extra_check CHECK (day_hits < 1000000)"])))] },
  {
    suffix: "a02",
    what: "a short_hits CHECK that is not validated",
    steps: (s) => [lookAlike(tableDdl(s, exact({ shortCheck: null }))), { sql: `ALTER TABLE ${s}.real_registration_admission ADD CONSTRAINT real_registration_admission_short_hits_check CHECK (short_hits >= 0 AND short_hits <= 100000) NOT VALID` }],
  },
  { suffix: "a03", what: "a generated column", steps: (s) => [lookAlike(tableDdl(s, exact({ dayHits: "day_hits INTEGER GENERATED ALWAYS AS (1) STORED NOT NULL" })))] },
  { suffix: "a04", what: "row-level security enabled", steps: (s) => [lookAlike(tableDdl(s, exact())), { sql: `ALTER TABLE ${s}.real_registration_admission ENABLE ROW LEVEL SECURITY` }] },
  { suffix: "a05", what: "a policy without row-level security", steps: (s) => [lookAlike(tableDdl(s, exact())), { sql: `CREATE POLICY ra_policy ON ${s}.real_registration_admission USING (true)` }] },
  {
    suffix: "a06",
    what: "a view under the table's name",
    steps: (s) => [{ register: ["view", "real_registration_admission"], sql: `CREATE VIEW ${s}.real_registration_admission AS SELECT 'register_options'::text AS scope, pg_catalog.now() AS short_window_start, 0 AS short_hits, pg_catalog.now() AS day_window_start, 0 AS day_hits` }],
  },
  {
    suffix: "a07",
    what: "a foreign key to another scratch table",
    steps: (s) => [
      { register: ["table", "ra_parent"], sql: `CREATE TABLE ${s}.ra_parent (scope TEXT PRIMARY KEY)` },
      lookAlike(tableDdl(s, exact({}, [`CONSTRAINT ra_out_fk FOREIGN KEY (scope) REFERENCES ${s}.ra_parent (scope)`]))),
    ],
  },
  {
    suffix: "a08",
    what: "another scratch table referencing it",
    steps: (s) => [lookAlike(tableDdl(s, exact())), { register: ["table", "ra_child"], sql: `CREATE TABLE ${s}.ra_child (scope TEXT COLLATE "C", CONSTRAINT ra_in_fk FOREIGN KEY (scope) REFERENCES ${s}.real_registration_admission (scope))` }],
  },
  {
    suffix: "a09",
    what: "a trigger calling a scratch function",
    steps: (s) => [
      { register: ["function", "ra_trigger_fn"], sql: `CREATE FUNCTION ${s}.ra_trigger_fn() RETURNS trigger LANGUAGE plpgsql AS $ra$ BEGIN RETURN NEW; END $ra$` },
      lookAlike(tableDdl(s, exact())),
      { sql: `CREATE TRIGGER ra_trigger BEFORE INSERT ON ${s}.real_registration_admission FOR EACH ROW EXECUTE FUNCTION ${s}.ra_trigger_fn()` },
    ],
  },
  { suffix: "a10", what: "a rule", steps: (s) => [lookAlike(tableDdl(s, exact())), { sql: `CREATE RULE ra_rule AS ON INSERT TO ${s}.real_registration_admission DO ALSO NOTHING` }] },
  { suffix: "a11", what: "an inheritance child of another scratch table", steps: (s) => [{ register: ["table", "ra_parent"], sql: `CREATE TABLE ${s}.ra_parent ()` }, lookAlike(tableDdl(s, exact(), { tail: ` INHERITS (${s}.ra_parent)` }))] },
  { suffix: "a12", what: "a partitioned table", steps: (s) => [lookAlike(tableDdl(s, exact(), { tail: " PARTITION BY LIST (scope)" }))] },
  { suffix: "a13", what: "an unlogged table", steps: (s) => [lookAlike(tableDdl(s, exact(), { prefix: "UNLOGGED " }))] },
];

// Offline (never gated): the harness itself. The pure guards are proven in registration-admission-smoke-harness.test.ts.
describe("registration admission smoke harness", () => {
  const source = readFileSync("test/lib/real/registration-admission.smoke.test.ts", "utf8");
  const uncommented = source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");
  // Everything except this offline block (whose own assertions quote the code they look for).
  const live = uncommented.slice(uncommented.indexOf("\ndescribe.skipIf(!enabled)"));
  const code = uncommented.slice(0, uncommented.indexOf('\ndescribe("registration admission smoke harness"')) + live;

  // ---------------------------------------------------------------------------------------------------------------
  // Fixture consistency (added after the first live run's S4 failure, SQLSTATE 42703): a look-alike whose CREATE TABLE
  // removes a column but keeps a constraint that names it is rejected by PostgreSQL BEFORE the migration's guard ever
  // runs, so the case tests nothing and poisons the run. This narrow, deterministic check evaluates EVERY variant's DDL.
  //
  // LIMITS, stated plainly. It is a small purpose-built splitter, not a SQL parser. It understands only the statement
  // shapes these variants use, and FAILS CLOSED on anything else (an unrecognized statement or table-definition item,
  // unbalanced parentheses or quotes, an unexpected table tail) rather than accepting it. It checks that a constraint,
  // index, or ALTER ... ADD CONSTRAINT never names one of the FIVE INTENDED columns that its own table does not define,
  // that every object it creates is registered for cleanup (and nothing else is), and that the relation the migration
  // will inspect exists. It does NOT check arbitrary identifiers, types, expression validity, or anything PostgreSQL
  // alone can decide (collation compatibility of a foreign key, for one). It never executes SQL.
  // ---------------------------------------------------------------------------------------------------------------
  const INTENDED_COLUMNS = Object.values(COLUMNS).map((definition) => definition.split(" ")[0]!);
  const SCHEMA_FOR_CHECK = "pb_smoke_0a1b2c3d_check";

  /** Text with string literals and quoted identifiers removed, so a quoted "C" or 'register_options' is never read as a column. */
  const withoutQuotes = (text: string) => text.replace(/'(?:[^']|'')*'/g, "''").replace(/"[^"]*"/g, "");
  const tokensOf = (text: string): string[] => withoutQuotes(text).toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? [];

  /** Index of the parenthesis closing the one at `open`; throws on unbalanced parentheses or quotes. */
  function closingParen(text: string, open: number): number {
    let depth = 0;
    let quote: string | null = null;
    for (let i = open; i < text.length; i += 1) {
      const ch = text[i]!;
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') quote = ch;
      else if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    throw new Error("unbalanced parentheses or quotes");
  }
  /** Splits a table body on its top-level commas. An empty body is an empty list; an empty item, or a stray quote or parenthesis, throws. */
  function splitTopLevel(body: string): string[] {
    if (body.trim() === "") return [];
    const items: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let start = 0;
    for (let i = 0; i < body.length; i += 1) {
      const ch = body[i]!;
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') quote = ch;
      else if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      else if (ch === "," && depth === 0) {
        items.push(body.slice(start, i).trim());
        start = i + 1;
      }
    }
    if (depth !== 0 || quote !== null) throw new Error("unbalanced parentheses or quotes");
    items.push(body.slice(start).trim());
    if (items.some((item) => item === "")) throw new Error("an empty table-definition item");
    return items;
  }

  type Analysis = { issues: string[]; tables: Map<string, Set<string>>; created: Array<{ kind: ScratchObjectKind; name: string }> };
  const ident = "[a-z0-9_]+";
  const qualified = `${ident}\\.${ident}`;

  /** Evaluates one variant's steps in order. `issues` is empty only for a consistent, fully recognized, fully registered variant. */
  function analyseVariant(schema: string, steps: readonly Step[]): Analysis {
    const issues: string[] = [];
    const tables = new Map<string, Set<string>>();
    const functions = new Set<string>();
    const views = new Set<string>();
    const created: Analysis["created"] = [];
    const registered: Array<{ kind: ScratchObjectKind; name: string }> = [];
    const relation = (name: string) => tables.has(name) || views.has(name);
    const bare = (qualifiedName: string) => qualifiedName.slice(qualifiedName.indexOf(".") + 1);
    const checkReferences = (where: string, table: string, text: string) => {
      const defined = tables.get(table);
      if (!defined) return void issues.push(`${where}: refers to a table (${table}) this variant has not created`);
      for (const token of tokensOf(text)) {
        if (INTENDED_COLUMNS.includes(token) && !defined.has(token)) issues.push(`${where}: names column ${token}, which ${table} does not define`);
      }
    };

    for (const step of steps) {
      const sql = step.sql;
      if (step.register) registered.push({ kind: step.register[0], name: step.register[1] });
      if (/^CREATE (UNLOGGED )?TABLE\b/.test(sql)) {
        const head = new RegExp(`^CREATE (?:UNLOGGED )?TABLE (${qualified}) \\(`).exec(sql);
        if (!head) {
          issues.push("an unrecognized CREATE TABLE form");
          continue;
        }
        const name = head[1]!;
        const open = head[0].length - 1;
        let items: string[];
        let tail: string;
        try {
          const close = closingParen(sql, open);
          items = splitTopLevel(sql.slice(open + 1, close));
          tail = sql.slice(close + 1).trim();
        } catch (error) {
          issues.push(`${name}: ${(error as Error).message}`);
          continue;
        }
        if (tail !== "" && !/^PARTITION BY LIST \(scope\)$/.test(tail) && !new RegExp(`^INHERITS \\(${qualified}\\)$`).test(tail)) issues.push(`${name}: an unrecognized table tail`);
        const columns = new Set<string>();
        const constraints: string[] = [];
        for (const item of items) {
          if (/^CONSTRAINT /i.test(item) || /^(PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY)\b/i.test(item)) constraints.push(item);
          else {
            const columnName = /^([a-z_][a-z0-9_]*) /.exec(item)?.[1];
            if (!columnName) issues.push(`${name}: an unrecognized table-definition item`);
            else if (columns.has(columnName)) issues.push(`${name}: column ${columnName} is defined twice`);
            else columns.add(columnName);
          }
        }
        tables.set(name, columns);
        created.push({ kind: "table", name: bare(name) });
        for (const constraint of constraints) {
          // The REFERENCES clause names the OTHER table's columns; the constraint's own columns are what must exist here.
          checkReferences(`${name} constraint`, name, constraint.replace(new RegExp(`REFERENCES ${qualified} \\([^)]*\\)`, "i"), ""));
        }
      } else if (/^CREATE VIEW\b/.test(sql)) {
        const view = new RegExp(`^CREATE VIEW (${qualified}) AS SELECT `).exec(sql)?.[1];
        if (!view) issues.push("an unrecognized CREATE VIEW form");
        else {
          views.add(view);
          created.push({ kind: "view", name: bare(view) });
        }
      } else if (/^CREATE FUNCTION\b/.test(sql)) {
        const fn = new RegExp(`^CREATE FUNCTION (${qualified})\\(\\) RETURNS trigger LANGUAGE plpgsql AS \\$ra\\$ .* \\$ra\\$$`).exec(sql)?.[1];
        if (!fn) issues.push("an unrecognized CREATE FUNCTION form");
        else {
          functions.add(fn);
          created.push({ kind: "function", name: bare(fn) });
        }
      } else if (/^CREATE INDEX\b/.test(sql)) {
        const match = new RegExp(`^CREATE INDEX ${ident} ON (${qualified}) \\(([^)]*)\\)$`).exec(sql);
        if (!match) issues.push("an unrecognized CREATE INDEX form");
        else checkReferences("an index", match[1]!, match[2]!);
      } else if (/^ALTER TABLE\b/.test(sql)) {
        const add = new RegExp(`^ALTER TABLE (${qualified}) ADD CONSTRAINT ${ident} (.*?)( NOT VALID)?$`).exec(sql);
        const rls = new RegExp(`^ALTER TABLE (${qualified}) ENABLE ROW LEVEL SECURITY$`).exec(sql);
        if (add) checkReferences("an added constraint", add[1]!, add[2]!);
        else if (rls) {
          if (!tables.has(rls[1]!)) issues.push(`${rls[1]}: row-level security enabled on a table this variant has not created`);
        } else issues.push("an unrecognized ALTER TABLE form");
      } else if (/^CREATE POLICY\b/.test(sql)) {
        const target = new RegExp(`^CREATE POLICY ${ident} ON (${qualified}) USING \\(true\\)$`).exec(sql)?.[1];
        if (!target) issues.push("an unrecognized CREATE POLICY form");
        else if (!tables.has(target)) issues.push(`${target}: a policy on a table this variant has not created`);
      } else if (/^CREATE RULE\b/.test(sql)) {
        const target = new RegExp(`^CREATE RULE ${ident} AS ON INSERT TO (${qualified}) DO ALSO NOTHING$`).exec(sql)?.[1];
        if (!target) issues.push("an unrecognized CREATE RULE form");
        else if (!tables.has(target)) issues.push(`${target}: a rule on a table this variant has not created`);
      } else if (/^CREATE TRIGGER\b/.test(sql)) {
        const match = new RegExp(`^CREATE TRIGGER ${ident} BEFORE INSERT ON (${qualified}) FOR EACH ROW EXECUTE FUNCTION (${qualified})\\(\\)$`).exec(sql);
        if (!match) issues.push("an unrecognized CREATE TRIGGER form");
        else {
          if (!tables.has(match[1]!)) issues.push(`${match[1]}: a trigger on a table this variant has not created`);
          if (!functions.has(match[2]!)) issues.push(`${match[2]}: a trigger calling a function this variant has not created`);
        }
      } else issues.push("an unrecognized statement kind (not accepted silently)");
    }

    // The relation the migration will inspect must exist in the variant's own schema.
    const target = `${schema}.real_registration_admission`;
    if (!relation(target)) issues.push("the variant never creates the relation the migration will inspect");
    // Ownership: every created object is registered for cleanup, and nothing is registered that was not created.
    const key = (entry: { kind: string; name: string }) => `${entry.kind}:${entry.name}`;
    const made = created.map(key).sort();
    const owned = registered.map(key).sort();
    if (made.join("|") !== owned.join("|")) issues.push(`created objects [${made.join(", ")}] differ from the registered ones [${owned.join(", ")}]`);
    return { issues, tables, created };
  }

  it("fixture consistency: EVERY look-alike's DDL is internally consistent — no constraint, index, or added constraint names a column its table lacks", () => {
    const all = [...MANDATORY_VARIANTS, ...FURTHER_VARIANTS];
    expect(all).toHaveLength(28);
    for (const variant of all) {
      const analysis = analyseVariant(SCHEMA_FOR_CHECK, variant.steps(SCHEMA_FOR_CHECK));
      expect(analysis.issues, `${variant.suffix} (${variant.what})`).toEqual([]);
    }
    // The control copies built inline in S2/S4 are the intended definition itself.
    expect(analyseVariant(SCHEMA_FOR_CHECK, [lookAlike(tableDdl(SCHEMA_FOR_CHECK, exact()))]).issues).toEqual([]);
  });

  it("fixture consistency would have REJECTED the original defect: a column removed while the constraint that names it stayed (SQLSTATE 42703 live)", () => {
    const original = analyseVariant(SCHEMA_FOR_CHECK, [lookAlike(tableDdl(SCHEMA_FOR_CHECK, exact({ dayHits: null })))]);
    expect(original.issues.join("\n")).toContain("names column day_hits, which pb_smoke_0a1b2c3d_check.real_registration_admission does not define");
    // The check is general, not about m02: removing ANY intended column is flagged exactly when a surviving constraint names it.
    const constraintText = [PRIMARY_KEY, SCOPE_CHECK, SHORT_CHECK, DAY_CHECK].join(" ");
    const overrideKeys = { scope: "scope", shortStart: "short_window_start", shortHits: "short_hits", dayStart: "day_window_start", dayHits: "day_hits" } as const;
    for (const [key, columnName] of Object.entries(overrideKeys)) {
      const analysis = analyseVariant(SCHEMA_FOR_CHECK, [lookAlike(tableDdl(SCHEMA_FOR_CHECK, exact({ [key]: null } as PartOverrides)))]);
      const named = constraintText.includes(columnName);
      expect(analysis.issues.length > 0, `removing ${columnName}`).toBe(named);
      if (named) expect(analysis.issues.join("\n")).toContain(`names column ${columnName}`);
    }
    // And other dangling references of the same family.
    const pkOnMissing = analyseVariant(SCHEMA_FOR_CHECK, [lookAlike(tableDdl(SCHEMA_FOR_CHECK, exact({ shortHits: null, pk: "CONSTRAINT real_registration_admission_pkey PRIMARY KEY (scope, short_hits)", shortCheck: null })))]);
    expect(pkOnMissing.issues.join("\n")).toContain("names column short_hits");
    const indexOnMissing = analyseVariant(SCHEMA_FOR_CHECK, [lookAlike(tableDdl(SCHEMA_FOR_CHECK, exact({ shortHits: null, shortCheck: null }))), { sql: `CREATE INDEX ra_extra_idx ON ${SCHEMA_FOR_CHECK}.real_registration_admission (short_hits)` }]);
    expect(indexOnMissing.issues.join("\n")).toContain("an index: names column short_hits");
    const alterOnMissing = analyseVariant(SCHEMA_FOR_CHECK, [lookAlike(tableDdl(SCHEMA_FOR_CHECK, exact({ shortHits: null, shortCheck: null }))), { sql: `ALTER TABLE ${SCHEMA_FOR_CHECK}.real_registration_admission ADD CONSTRAINT ra_c CHECK (short_hits >= 0) NOT VALID` }]);
    expect(alterOnMissing.issues.join("\n")).toContain("an added constraint: names column short_hits");
  });

  it("fixture consistency FAILS CLOSED on anything it does not recognize, and on ownership mistakes", () => {
    const table = (body: string, tail = "") => `CREATE TABLE ${SCHEMA_FOR_CHECK}.real_registration_admission (${body})${tail}`;
    const intended = exact().join(", ");
    const ok = (steps: Step[]) => analyseVariant(SCHEMA_FOR_CHECK, steps).issues;
    expect(ok([lookAlike(table(intended))])).toEqual([]);
    expect(ok([lookAlike(table(intended, " WITH (fillfactor = 50)"))]).join("\n")).toContain("an unrecognized table tail");
    expect(ok([lookAlike(table(intended.replace(/\)$/, "")))]).join("\n")).toMatch(/unbalanced|unrecognized/);
    expect(ok([lookAlike(table("scope TEXT, , short_hits INTEGER"))]).join("\n")).toContain("an empty table-definition item");
    expect(ok([lookAlike(table("scope TEXT, 42 INTEGER"))]).join("\n")).toContain("an unrecognized table-definition item");
    expect(ok([lookAlike(table("scope TEXT, scope TEXT"))]).join("\n")).toContain("defined twice");
    expect(ok([lookAlike(`CREATE TEMP TABLE x (a INT)`)]).join("\n")).toBeTruthy();
    expect(ok([lookAlike(table(intended)), { sql: `GRANT SELECT ON ${SCHEMA_FOR_CHECK}.real_registration_admission TO PUBLIC` }]).join("\n")).toContain("an unrecognized statement kind");
    expect(ok([lookAlike(table(intended)), { sql: `ALTER TABLE ${SCHEMA_FOR_CHECK}.real_registration_admission ADD COLUMN y INT` }]).join("\n")).toContain("an unrecognized ALTER TABLE form");
    // A created object that is not registered, and a registration that was not created, are both flagged (cleanup would otherwise refuse or leak).
    expect(ok([{ sql: table(intended) }]).join("\n")).toContain("differ from the registered ones");
    expect(ok([lookAlike(table(intended)), { register: ["table", "ra_ghost"], sql: `ALTER TABLE ${SCHEMA_FOR_CHECK}.real_registration_admission ENABLE ROW LEVEL SECURITY` }]).join("\n")).toContain("differ from the registered ones");
    // A variant that never creates the relation the migration inspects tests nothing.
    expect(ok([{ register: ["table", "ra_parent"], sql: `CREATE TABLE ${SCHEMA_FOR_CHECK}.ra_parent ()` }]).join("\n")).toContain("never creates the relation the migration will inspect");
  });

  it("the 'missing column' look-alike (m02) genuinely lacks exactly one intended column, keeps the other four, and nothing refers to the missing one", () => {
    const variant = MANDATORY_VARIANTS.find((entry) => entry.what === "a missing column");
    expect(variant?.suffix).toBe("m02");
    const analysis = analyseVariant(SCHEMA_FOR_CHECK, variant!.steps(SCHEMA_FOR_CHECK));
    const columns = analysis.tables.get(`${SCHEMA_FOR_CHECK}.real_registration_admission`)!;
    const missing = INTENDED_COLUMNS.filter((name) => !columns.has(name));
    expect(missing).toHaveLength(1); // a missing-column look-alike, not an empty or unrecognizable table
    expect(INTENDED_COLUMNS.filter((name) => columns.has(name))).toHaveLength(4);
    expect([...columns].filter((name) => !INTENDED_COLUMNS.includes(name))).toEqual([]); // no stray column
    expect(analysis.issues).toEqual([]); // no constraint, index, or default names the missing column
    const ddl = variant!.steps(SCHEMA_FOR_CHECK).map((step) => step.sql).join(" ");
    expect(tokensOf(ddl.replace(/^[^(]*\(/, "")).includes(missing[0]!)).toBe(false);
  });

  it("the look-alike inventory is preserved: 15 mandatory and 13 further, with these suffixes and descriptions", () => {
    expect([...MANDATORY_VARIANTS, ...FURTHER_VARIANTS].map((variant) => `${variant.suffix}: ${variant.what}`)).toEqual([
      "m01: an extra column",
      "m02: a missing column",
      "m03: short_hits as BIGINT",
      "m04: scope without its collation",
      "m05: scope under a different built-in collation",
      "m06: a nullable window start",
      "m07: a column default",
      "m08: the primary key under the wrong name",
      "m09: the primary key over the wrong columns",
      "m10: no scope CHECK",
      "m11: a scope CHECK admitting a second scope",
      "m12: a short_hits CHECK allowing negatives",
      "m13: a day_hits CHECK with a higher bound",
      "m14: the scope CHECK under the wrong name",
      "m15: an extra index",
      "a01: an extra CHECK",
      "a02: a short_hits CHECK that is not validated",
      "a03: a generated column",
      "a04: row-level security enabled",
      "a05: a policy without row-level security",
      "a06: a view under the table's name",
      "a07: a foreign key to another scratch table",
      "a08: another scratch table referencing it",
      "a09: a trigger calling a scratch function",
      "a10: a rule",
      "a11: an inheritance child of another scratch table",
      "a12: a partitioned table",
      "a13: an unlogged table",
    ]);
  });

  it("every look-alike is still expected to be refused by the migration's OWN guard (P0001), none is skipped, and none is retried", () => {
    // The refusal helper expects exactly the migration's RAISE, never the database's own refusal of the fixture (42703 and friends).
    const refusal = /async function refusesAndLeavesUnchanged\(variant: Variant\): Promise<string> \{([\s\S]*?)\n  \}/.exec(live)?.[1] ?? "";
    expect(refusal).toContain('migrationBlockFor(schema), ["P0001"]');
    expect(refusal).not.toMatch(/42703|23\d{3}|42P01|catch/);
    // Building a fixture goes through write(): a database refusal of the FIXTURE poisons the run instead of being accepted as a refusal of the migration.
    expect(live).toContain('await write(`building the look-alike (${variant.what})`, step.sql);');
    // S4 and S5 run EVERY variant, with no filter, slice, or early exit, and assert how many ran.
    expect(live).toContain("for (const variant of MANDATORY_VARIANTS) refusals[variant.suffix] = await refusesAndLeavesUnchanged(variant);");
    expect(live).toContain("expect(Object.keys(refusals)).toHaveLength(15);");
    expect(live).toContain("for (const variant of FURTHER_VARIANTS) refusals[variant.suffix] = await refusesAndLeavesUnchanged(variant);");
    expect(live).toContain("expect(Object.keys(refusals)).toHaveLength(13);");
    expect(source).not.toMatch(/(MANDATORY_VARIANTS|FURTHER_VARIANTS)\s*\.\s*(filter|slice|splice|shift|pop)\b/);
    expect(live).not.toMatch(/\b(continue|break)\b/);
  });

  it("is this harness's registered file, gated by its OWN variable only, and never reads DATABASE_URL", () => {
    expect(REGISTRATION_ADMISSION_SMOKE_FILE).toBe("test/lib/real/registration-admission.smoke.test.ts");
    expect(code).toContain('const enabled = process.env[GATE] === "1";');
    expect(code.match(/process\.env\b[.[]\w+\]?/g)).toEqual(["process.env[GATE]"]);
    expect(code).not.toMatch(/DATABASE_URL/);
  });

  it("the target check refuses: no gate, DATABASE_URL exported, any other smoke/admin gate, the real endpoint (pooled or direct), or a missing branch URL", () => {
    const real = 'DATABASE_URL="postgresql://app:secret@ep-real-000001-pooler.neon.invalid/neondb"\n';
    const branch = "postgresql://app:secret@ep-branch-000002-pooler.neon.invalid/neondb";
    const check = (env: Record<string, string | undefined>) => checkDisposableTarget({ env, envLocalText: real, gate: GATE, allowedGates: ALLOWED_GATES });
    expect(check({ [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch })).toEqual({ ok: true });
    for (const env of [
      { NEON_BRANCH_DATABASE_URL: branch },
      { REAL_SMOKE_PROVIDER_BUDGET: "1", NEON_BRANCH_DATABASE_URL: branch },
      { REAL_SMOKE_RATE_LIMIT: "1", NEON_BRANCH_DATABASE_URL: branch },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch, DATABASE_URL: branch },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch, REAL_SMOKE_PROVIDER_BUDGET: "1" },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch, REAL_SMOKE_PROVISIONING_LIMITS: "1" },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch, REAL_SMOKE_NEON_ADAPTER: "1" },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch, REAL_ADMIN_POLL_PROVISIONING_ACTIVITY: "1" },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: "postgresql://app:secret@ep-real-000001.neon.invalid/neondb" },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: "postgresql://app:secret@ep-real-000001-pooler.neon.invalid/neondb" },
      { [GATE]: "1" },
    ]) {
      expect(check(env).ok, JSON.stringify(Object.keys(env))).toBe(false);
    }
  });

  it("the live block's first hook checks the target, the pooled mode, the exact-file selection, and the timeout flags — in that order — and only then connects", () => {
    const hook = /\n  beforeAll\(async \(\) => \{\n([\s\S]*?)\n  \}, VITEST_TIMEOUT_MS\);/.exec(code)?.[1] ?? "";
    const order = [
      "const url = requireDisposableTargetUrl(GATE, ALLOWED_GATES);",
      "const mode = requirePooledMode(parseDatabaseUrl(url, false));",
      "if (!mode.ok) throw new Error(`Registration admission smoke refused before any database work: ${mode.reason}`);",
      'const selection = checkRegistrationAdmissionFileSelection(inject("vitestCliArgs"));',
      "if (!selection.ok) throw new Error(`Registration admission smoke refused before any database work: ${selection.reason}`);",
      'const timeouts = checkRunnerTimeoutFlags(inject("vitestCliArgs"));',
      "if (!timeouts.ok) throw new Error(`Registration admission smoke refused before any database work: ${timeouts.reason}`);",
      "console.log(`[registration-admission-smoke] connection_mode: ${mode.mode}`);",
      "started = true;",
      "db = await connectSmokeDb(url);",
      "const stores = await connectSmokeStores(url);",
      "await lifecycle.runPreflight(async () => {",
    ].map((line) => hook.indexOf(line));
    expect(order[0]).toBe(hook.search(/\S/));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // One live block, and it is the only place a connector is called.
    expect(code.match(/^describe\.skipIf\(/gm)).toEqual(["describe.skipIf("]);
    expect(uncommented.match(/^describe\(/gm)).toHaveLength(1);
    expect(code).toContain('describe.skipIf(!enabled)("registration admission — schema block, two-statement admission, and real concurrency (DISPOSABLE BRANCH ONLY)", () => {');
    expect(code.match(/connectSmoke(?:Db|Stores)\(/g)).toHaveLength(2);
    expect(code).not.toMatch(/createNeon\w+\(|\bneon\(|new URL\([^)]*\)\.(hostname|host)\b|-pooler/);
    // Inside the preflight: every required check, the baseline, the START evidence, and only then the arming.
    const preflight = hook.slice(hook.indexOf("await lifecycle.runPreflight(async () => {"));
    const saved = preflight.indexOf('startSaved = writeRegistrationAdmissionEvidence({ directory: EVIDENCE_DIRECTORY, runId, stage: "start", evidence: startEvidence });');
    const armed = preflight.indexOf("lifecycle.arm({ startEvidence: startSaved });");
    expect(preflight.indexOf("baseline = await snapshot(lifecycle.read);")).toBeGreaterThan(0);
    expect(saved).toBeGreaterThan(preflight.indexOf("baseline = await snapshot(lifecycle.read);"));
    expect(armed).toBeGreaterThan(saved);
    expect(code.match(/lifecycle\.arm\(/g)).toHaveLength(1);
    expect(preflight.match(/lifecycle\.preflightCheck\(/g)).toHaveLength(PREFLIGHT_CHECKS.length);
    for (const check of PREFLIGHT_CHECKS) expect(preflight, check).toContain(`lifecycle.preflightCheck("${check}", `);
  });

  it("isolation is read through ONE single-statement request — the production path — never inside a batch", () => {
    const hook = /\n  beforeAll\(async \(\) => \{\n([\s\S]*?)\n  \}, VITEST_TIMEOUT_MS\);/.exec(code)?.[1] ?? "";
    const identity = hook.slice(hook.indexOf('one(await lifecycle.read("reading the server\'s identity'), hook.indexOf("facts.server ="));
    expect(identity).toContain("db.q(");
    expect(identity).not.toContain("db.tx(");
    expect(identity).toContain("pg_catalog.current_setting('transaction_isolation')");
    expect(identity).toContain("pg_catalog.current_setting('default_transaction_isolation')");
    expect(hook).toContain('lifecycle.preflightCheck("a single autocommit statement runs at READ COMMITTED (the path production admission uses)", server.isolation === "read committed");');
    expect(hook).toContain('lifecycle.preflightCheck("the database default isolation is READ COMMITTED", server.default_isolation === "read committed");');
    // The only batches in the whole file are the two lock holders.
    expect(code.match(/db\.tx\(/g)).toHaveLength(2);
    expect(code.match(/db\.tx\(holderStatements\(/g)).toHaveLength(2);
  });

  it("every test and hook carries the runner timeout explicitly, and the run's own deadlines are shorter", () => {
    expect([VITEST_TIMEOUT_MS, CASE_DEADLINE_MS, CLEANUP_DEADLINE_MS]).toEqual([120_000, 90_000, 60_000]);
    expect(code).toContain("const lifecycle = createRegistrationAdmissionLifecycle({ expectedCases: EXPECTED_CASES, requiredPreflightChecks: PREFLIGHT_CHECKS, caseDeadlineMs: CASE_DEADLINE_MS, cleanupDeadlineMs: CLEANUP_DEADLINE_MS, preflightDeadlineMs: CASE_DEADLINE_MS, ownership });");
    expect(code).toContain("const final = await lifecycle.finish({\n      deadlineMs: CLEANUP_DEADLINE_MS,");
    expect(live.match(/\}, VITEST_TIMEOUT_MS\);/g)).toHaveLength(4); // beforeAll, afterAll, the completeness check, the cleanup test
    expect(live.match(/, VITEST_TIMEOUT_MS\);/g)).toHaveLength(6); // ...and liveCase's it, and afterEach
    expect(live.match(/\b(it|beforeAll|afterAll|afterEach)\(/g)).toHaveLength(6);
    expect(source).toContain("Do NOT pass the older smokes' 30000\n * ms flags.");
    expect(source).toContain(" *     pnpm exec vitest run test/lib/real/registration-admission.smoke.test.ts\n */");
  });

  it("no case can be skipped: no only/skip/todo, every case is registered through liveCase, and the last two tests require them all", () => {
    expect(code).not.toMatch(/\b(it|describe|test)\.(only|skip|todo|fails)\b/);
    expect(code).not.toMatch(/\bskipIf\b(?!\(!enabled\))/);
    const registered = [...code.matchAll(/^  liveCase\("([^"]+)"/gm)].map((match) => match[1]);
    expect(registered).toEqual([...EXPECTED_CASES]);
    expect(new Set(EXPECTED_CASES).size).toBe(EXPECTED_CASES.length);
    expect(code).toContain("    it(name, () => lifecycle.runCase(name, body), VITEST_TIMEOUT_MS);");
    expect(code).toContain('  it("every decisive case ran, exactly once, in order", () => {');
    expect(code).toContain("    expect(lifecycle.executed()).toEqual([...EXPECTED_CASES]);");
    expect(code).toContain('  it("Z. the final cleanup removes exactly what this run registered", async () => {');
    expect(live.indexOf('it("Z. the final cleanup')).toBeGreaterThan(live.indexOf('it("every decisive case ran'));
    expect(live.indexOf('it("every decisive case ran')).toBeGreaterThan(live.lastIndexOf("\n  liveCase("));
    expect(MANDATORY_VARIANTS).toHaveLength(15);
    expect(FURTHER_VARIANTS).toHaveLength(13);
    const suffixes = [...MANDATORY_VARIANTS, ...FURTHER_VARIANTS].map((variant) => variant.suffix);
    expect(new Set(suffixes).size).toBe(28);
    // Nothing a case is named can trip the evidence content screen.
    for (const name of [...EXPECTED_CASES, ...PREFLIGHT_CHECKS]) expect(name).not.toMatch(/secret|password|token|credential|bearer|authorization|api[_-]?key|private[_-]?key|\bep-|pooler|postgres(?:ql)?:/i);
  });

  it("every database call goes through a lifecycle wrapper, and every admission request through the PRODUCTION admission over the PRODUCTION store", () => {
    const calls = live.match(/\bdb\.(?:q|tx)\(/g) ?? [];
    expect(calls.length).toBeGreaterThan(10);
    // Each one is the body of an arrow handed to a wrapper: read(...), write(...), writeRow(...), poll(...), launch(...), or expectDatabaseRefusal(...).
    expect(live.match(/\(\) =>\s*db\.(?:q|tx)\(/g)).toHaveLength(calls.length);
    expect(live).not.toMatch(/await db\.(?:q|tx)\(/);
    expect(code).toContain("store = stores.registrationAdmission;");
    expect(code).toContain("admission = createRegistrationAdmission(store);");
    expect(code.match(/admission\.admit\(\)/g)).toHaveLength(1); // prodRequest, the one builder of a production-policy request
    // The store is called directly in ONE place, with an explicit TEST policy (the store's own seam); the frozen policy is never changed.
    expect(code.match(/store\.admit\(([^)]*)\)/g)).toEqual(["store.admit(policy)"]);
    for (const [, argument] of code.matchAll(/policyRequest\(([^)]*)\)/g)) expect(argument, argument).toMatch(/^(policy: RegistrationAdmissionPolicy|DAILY_TWENTY|PROD|LOWERED|RAISED)$/);
    expect(code).not.toMatch(/createInMemory|InMemory/);
    // Requests are issued only through the tracked wrappers, never awaited bare, and never more than 60 at once.
    expect(live).not.toMatch(/await request\(|request\([^\n]*\)\(\)/);
    expect(BURST).toBe(60);
    expect(BURST).toBeLessThanOrEqual(MAX_CONCURRENCY);
    expect(code).toContain('if (requests.length > BURST) throw new Error("registration admission smoke: too many simultaneous admission requests");');
    expect(code).not.toMatch(/retry\(|again\(|Promise\.race|Promise\.any/i);
  });

  it("it extracts exactly schema.sql's block; a scratch copy differs only in its target-schema constant, and swapping `public` back restores it byte for byte", () => {
    const schema = readFileSync(SCHEMA_PATH, "utf8");
    expect(schema.split(BEGIN)).toHaveLength(2);
    expect(schema.split(END)).toHaveLength(2);
    const block = migrationBlock();
    expect(block.startsWith("DO $$")).toBe(true);
    expect(block.endsWith("END $$;")).toBe(true);
    expect(block.match(/DO \$\$/g)).toHaveLength(1);
    expect(block.match(/'public'/g)).toHaveLength(1);
    expect(schema).toContain(block);
    expect(MIGRATION_SHA256).toBe(sha256Hex(block));
    // Pinned: the audited statement. A change here is a change to evidence-bearing SQL and needs a fresh smoke.
    expect(block).toHaveLength(13_101);
    expect(MIGRATION_SHA256).toBe("b269ebcc0953efce79c7504ec451237eca3dc1bc4d67996d7179b5eba26ac91f");
    const scratch = migrationBlockFor("pb_smoke_0a1b2c3d_apply");
    expect(scratch).toContain("target_schema CONSTANT pg_catalog.text := 'pb_smoke_0a1b2c3d_apply';");
    expect(scratch).not.toContain("'public'");
    expect(scratch.replace("'pb_smoke_0a1b2c3d_apply'", "'public'")).toBe(block);
    for (const name of ["public", "pg_catalog", "pb_smoke_0a1b2c3d_a'; DROP", "PB_SMOKE_0a1b2c3d_a", "pb_smoke_0a1b2c3d_", "x"]) expect(() => migrationBlockFor(name), name).toThrow(/scratch schema/);
    // The block is the Registration Admission one — never another block, and never the whole file.
    expect(block).toContain("table_name CONSTANT pg_catalog.text := 'real_registration_admission';");
    expect(block).not.toMatch(/real_rate_limits|real_provider_budgets|payment_attempts/);
    expect(code.match(/readFileSync\(/g)).toHaveLength(1);
    expect(code).not.toMatch(/search_path|SET LOCAL|set_config/);
    // `public` is written to by exactly one helper, which sends the unmodified block.
    expect(code.match(/db\.q\(migrationBlock\(\)\)/g)).toHaveLength(1);
    expect(code).toContain("const applyToPublic = (what: string) => lifecycle.write(what, () => db.q(migrationBlock()));");
  });

  it("it makes no provider call and writes nothing but its own scratch objects, the new table's one row, and the table's name (static)", () => {
    const imports = [...source.matchAll(/^(?:import [^\n]*|\}) from "([^"]+)";$/gm)].map((match) => match[1]).sort();
    expect(imports).toEqual(["./fixtures/handles-smoke-db", "./fixtures/provider-budget-smoke", "./fixtures/registration-admission-smoke", "@/lib/real/server/registration-admission", "node:crypto", "node:fs", "vitest"].sort());
    expect(source).not.toMatch(/\bimport\(|\brequire\(/);
    for (const needle of ["turn" + "key", "pim" + "lico", "fet" + "ch(", "createRealSafe" + "Account", "prepareCash" + "Transfer", "/api/" + "real", "getRegistration" + "Admission"]) expect(code.toLowerCase(), needle).not.toContain(needle.toLowerCase());
    for (const table of ["payment" + "_attempts", "real" + "_accounts", "real" + "_passkeys", "real_account" + "_handles", "registration" + "_attempts", "webauthn" + "_challenges", "real_provider" + "_budgets"]) expect(code, table).not.toContain(table);
    // real_rate_limits is only ever READ (its fingerprint must not change).
    expect(code.match(/real_rate_limits/g)!.length).toBeGreaterThan(0);
    expect(code).not.toMatch(/(INTO|UPDATE|FROM|TABLE|ON)\s+(public\.)?real_rate_limits/i);
    // This file builds NO removal and NO row update of any kind: every UPDATE, DELETE, and DROP comes from the fixture's pinned statements or the ownership-checked cleanup plan.
    for (const needle of ["DEL" + "ETE", "DR" + "OP ", "TRUNC" + "ATE", "CASC" + "ADE", " LI" + "KE ", "UPD" + "ATE "]) expect(code.toUpperCase(), needle).not.toContain(needle);
    // Every CREATE / ALTER / INSERT it sends names a scratch schema variable — never `public`, never an unqualified name.
    const ddl = [...code.matchAll(/\b(CREATE (?:UNLOGGED )?(?:TABLE|VIEW|INDEX|FUNCTION|TRIGGER|SCHEMA|POLICY|RULE)|ALTER TABLE|INSERT INTO)\b([^`"\n]{0,140})/g)].map((match) => `${match[1]}${match[2]}`);
    expect(ddl.length).toBeGreaterThan(15);
    for (const statement of ddl) expect(statement, statement).toMatch(/^(CREATE SCHEMA \$\{schema\}|CREATE (UNLOGGED )?(TABLE|VIEW|FUNCTION) \$\{(s|schema)\}\.|CREATE INDEX ra_extra_idx ON \$\{s\}\.|CREATE TRIGGER ra_trigger BEFORE INSERT ON \$\{s\}\.|CREATE POLICY ra_policy ON \$\{s\}\.|CREATE RULE ra_rule AS ON INSERT TO \$\{s\}\.|ALTER TABLE \$\{s\}\.|INSERT INTO \$\{(schema|applied|s)\}\.)/);
    for (const [, target] of code.matchAll(/\b(?:REFERENCES|INHERITS \(|EXECUTE FUNCTION) ?([^ (]+)/g)) expect(target, target).toMatch(/^\$\{s\}\./);
    // Its only file write is the evidence, through the fixture's writer, in the fixed git-ignored directory.
    expect(code.match(/writeFileSync|mkdirSync|appendFileSync|createWriteStream/g)).toBeNull();
    expect(code.match(/writeRegistrationAdmissionEvidence\(/g)).toHaveLength(2);
    expect(code).toContain('const EVIDENCE_DIRECTORY = "evidence";');
    expect(readFileSync(".gitignore", "utf8")).toMatch(/^\/evidence\/$/m);
  });

  it("the public singleton row is written ONLY through the fixture's pinned statements, each through writeRow, and the row is removed, and the table renamed away and back, once each", () => {
    const rowWrites = [...code.matchAll(/rowWrite\("([^"]+)", ([A-Z_]+)/g)].map((match) => match[2]);
    expect(new Set(rowWrites)).toEqual(new Set(["SET_ROW_SQL", "BACKDATE_SHORT_SQL", "BACKDATE_DAY_SQL", "REMOVE_ROW_SQL", "RENAME_AWAY_SQL", "RENAME_BACK_SQL"]));
    expect(rowWrites.filter((name) => name === "REMOVE_ROW_SQL")).toHaveLength(1);
    expect(rowWrites.filter((name) => name === "RENAME_AWAY_SQL")).toHaveLength(1);
    expect(rowWrites.filter((name) => name === "RENAME_BACK_SQL")).toHaveLength(1);
    expect(code).toContain("const rowWrite = (what: string, text: string, params: unknown[] = []) => lifecycle.writeRow(what, () => db.q(text, params));");
    expect(code.match(/lifecycle\.writeRow\(/g)).toHaveLength(1);
  });

  it("the end of the run: one cleanup through the lifecycle, a tracked comparison, both evidence records, and a verdict that needs all of it", () => {
    expect(code.match(/lifecycle\.runFinalCleanup\(db\)/g)).toHaveLength(1);
    expect(code).toContain("  afterEach((context) => lifecycle.afterCase({ reportedFailed: caseFailedInVitest(context) }), VITEST_TIMEOUT_MS);");
    expect(code.match(/afterEach\(/g)).toHaveLength(1);
    const end = /\n  afterAll\(async \(\) => \{\n([\s\S]*?)\n  \}, VITEST_TIMEOUT_MS\);/.exec(code)?.[1] ?? "";
    expect(end.trimStart().startsWith("if (!started) return;")).toBe(true);
    expect(end).toContain("after = await snapshot(read);");
    expect(end).toContain('const admissionTable = await describeTable(read, "public");');
    expect(end).toContain("const seedRow = await seedRowOf(read);");
    expect(end).toContain("return compareWithExpectedAdmissionDelta({ before: baseline, after, admissionTable, seedRow, ownedSchemas: ownership.ownedSchemas() });");
    expect(end).not.toMatch(/lifecycle\.(read|write|writeRow|poll|admit|admitBurst|expectDatabaseRefusal|runFinalCleanup)\b|db\.q\(/);
    expect(end).toContain('const finalSaved = writeRegistrationAdmissionEvidence({ directory: EVIDENCE_DIRECTORY, runId, stage: "final", evidence });');
    expect(end).toContain("const verdict = concludeRegistrationAdmissionRun(final, { start: startSaved, final: finalSaved });");
    expect(end.trimEnd().endsWith("if (!verdict.pass) throw new Error(verdict.message);")).toBe(true);
    expect(end).toMatch(/console\.log\(`\[registration-admission-smoke\] \$\{safeEvidenceJson\(/);
    expect(code.match(/console\.log\(/g)).toHaveLength(2);
    expect(code.match(/afterAll\(/g)).toHaveLength(1);
  });

  it("the header says it was never run, forbids reuse and the real database, and documents the opt-in, the confirmed-target variables, the isolation path, and the bounds", () => {
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
    expect(header).toContain("IT HAS NEVER BEEN RUN LIVE.");
    expect(header).toContain("Separate explicit authorization is needed before its first live execution.");
    expect(header).toContain("EXPLICITLY OPT-IN, AND NOT RUN as part of the build");
    expect(header).toContain("It must NEVER be pointed at the real database.");
    expect(header).toContain("FRESH BRANCH, ONE RUN.");
    expect(header).toContain("Never rerun on a used branch.");
    expect(header).toContain("ISOLATION IS CHECKED ON THE PATH PRODUCTION USES.");
    expect(header).toContain("It does not infer it from a batch's pinned isolation.");
    expect(header).toContain("At most 1500 tracked operations, 60 simultaneous admission requests, 60 test-fixture writes to the singleton row, 80 activity polls");
    expect(header).toContain("No Neon branch is ever deleted by this file.");
    expect(header).toContain("It is never reported as \"restored\".");
    expect(source).toContain('NEON_BRANCH_EXPECTED_ENDPOINT_ID="ep-..."');
    expect(source).toContain("Milestone 0 Pass B: the run also requires NEON_BRANCH_EXPECTED_ENDPOINT_ID");
    // It must never claim a live run happened.
    expect(header).not.toMatch(/ONE CONTROLLED LIVE RUN HAS COMPLETED|run [0-9a-f]{8}, 20/);
  });
});

describe.skipIf(!enabled)("registration admission — schema block, two-statement admission, and real concurrency (DISPOSABLE BRANCH ONLY)", () => {
  const runId = randomUUID().replace(/-/g, "").slice(0, 8);
  const ownership = createRunOwnership(runId);
  const lifecycle = createRegistrationAdmissionLifecycle({ expectedCases: EXPECTED_CASES, requiredPreflightChecks: PREFLIGHT_CHECKS, caseDeadlineMs: CASE_DEADLINE_MS, cleanupDeadlineMs: CLEANUP_DEADLINE_MS, preflightDeadlineMs: CASE_DEADLINE_MS, ownership });
  let db: SmokeDb;
  let store: RegistrationAdmissionStore;
  let admission: RegistrationAdmission;
  /** True from the moment a connector is about to be built: only then is there anything to report at the end. */
  let started = false;
  let baseline: DatabaseSnapshot | null = null;
  let startSaved: EvidenceResult = { ok: false, reason: "write_failed", code: null };
  const facts: Record<string, unknown> = { connectionMode: null, server: null };
  const caseNotes: Record<string, unknown> = {};
  /** The scratch schema case S2 applies the block in; S3 inserts against it. */
  let applied = "";

  const PROD = REGISTRATION_ADMISSION_POLICY;
  const LOWERED: RegistrationAdmissionPolicy = { short: { limit: 3, windowSeconds: HOUR }, day: { limit: 100, windowSeconds: DAY } };
  const RAISED: RegistrationAdmissionPolicy = { short: { limit: 10, windowSeconds: HOUR }, day: { limit: 100, windowSeconds: DAY } };

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const one = (rows: SmokeRow[]): SmokeRow => {
    if (rows.length !== 1) throw new Error(`registration admission smoke: expected exactly one row, got ${rows.length}`);
    return rows[0]!;
  };
  const write = (what: string, text: string, params: unknown[] = []) => lifecycle.write(what, () => db.q(text, params));
  const rowWrite = (what: string, text: string, params: unknown[] = []) => lifecycle.writeRow(what, () => db.q(text, params));
  const refused = (what: string, text: string, sqlStates: readonly string[], params: unknown[] = []) => lifecycle.expectDatabaseRefusal(what, () => db.q(text, params), sqlStates);
  const applyToPublic = (what: string) => lifecycle.write(what, () => db.q(migrationBlock()));

  /** The singleton row, exactly as the database holds it (public only). */
  const readRow = async (what = "reading the singleton row") => {
    const row = one(await lifecycle.read(what, () => db.q(READ_ROW_SQL)));
    return {
      shortHits: row.short_hits as number,
      dayHits: row.day_hits as number,
      shortAtEpoch: row.short_at_epoch === true,
      dayAtEpoch: row.day_at_epoch === true,
      shortAge: Number(row.short_age),
      dayAge: Number(row.day_age),
      shortStart: String(row.short_start),
      dayStart: String(row.day_start),
      xmin: String(row.row_xmin),
      ctid: String(row.row_ctid),
    };
  };
  type RowState = Awaited<ReturnType<typeof readRow>>;
  /** Sets the four fields. An age is seconds before the database's now(); null is the epoch; a negative age is a start in the future. */
  const setRow = async (shortAge: number | null, shortHits: number, dayAge: number | null, dayHits: number) => {
    const written = await rowWrite("setting the singleton row (test fixture)", SET_ROW_SQL, [shortAge, shortHits, dayAge, dayHits]);
    if (written.length !== 1) throw new Error("registration admission smoke: the fixture write did not change exactly one row");
  };
  const toSeed = () => setRow(null, 0, null, 0);
  const backdateShort = (seconds: number) => rowWrite("moving the short window back (test fixture)", BACKDATE_SHORT_SQL, [seconds]);
  const backdateDay = (seconds: number) => rowWrite("moving the daily window back (test fixture)", BACKDATE_DAY_SQL, [seconds]);

  /** One admission request through the PRODUCTION admission (the frozen policy). Built here, issued only by a lifecycle wrapper. */
  const prodRequest = () => () => admission.admit();
  /** One admission request through the PRODUCTION store with an explicit TEST policy. */
  const policyRequest = (policy: RegistrationAdmissionPolicy) => () => store.admit(policy);
  /** Several requests issued TOGETHER and awaited to the last one. Returns every outcome, in order. */
  const together = (what: string, requests: ReadonlyArray<() => Promise<unknown>>, allowedErrors: Parameters<typeof lifecycle.admitBurst>[2] = []) => {
    if (requests.length > BURST) throw new Error("registration admission smoke: too many simultaneous admission requests");
    return lifecycle.admitBurst(what, requests, allowedErrors);
  };
  const admittedCount = (outcomes: readonly AdmissionOutcome[]) => outcomes.filter((outcome) => outcome.kind === "admitted").length;
  /** A denial's wait, checked against the window that must have caused it. One second of slack either way: a request that waited on a row can see a window opened just after its own clock reading. */
  const expectDenied = (outcome: AdmissionOutcome, bounds: { atLeast: number; atMost: number }) => {
    if (outcome.kind !== "denied") throw new Error(`registration admission smoke: expected a denial, got ${outcome.kind}`);
    expect(outcome.retryAfterSeconds).toBeGreaterThanOrEqual(bounds.atLeast);
    expect(outcome.retryAfterSeconds).toBeLessThanOrEqual(bounds.atMost + 1);
  };
  const sameRow = (a: RowState, b: RowState) => {
    expect({ shortHits: a.shortHits, dayHits: a.dayHits, shortStart: a.shortStart, dayStart: a.dayStart, xmin: a.xmin, ctid: a.ctid }).toEqual({ shortHits: b.shortHits, dayHits: b.dayHits, shortStart: b.shortStart, dayStart: b.dayStart, xmin: b.xmin, ctid: b.ctid });
  };

  /** Polls pg_stat_activity (bounded, counted) until `statement` sees at least one session, or the deadline passes. */
  async function waitFor(what: string, statement: string, deadlineMs: number): Promise<boolean> {
    const stop = Date.now() + deadlineMs;
    while (Date.now() < stop) {
      const row = one(await lifecycle.poll(what, () => db.q(statement)));
      if ((row.n as number) >= 1) return true;
      await sleep(200);
    }
    return false;
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

  /** Read-only: `<schema>.real_registration_admission` in the shape the expected-delta comparison takes. `schema` is `public` or a schema this run owns. */
  async function describeTable(read: TrackedRead, schema: string): Promise<AdmissionTableDescriptor> {
    if (schema !== "public") ownership.assertOwnedSchema(schema);
    const at = [schema, "real_registration_admission"];
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
    const rows = one(await read("counting the table's rows", () => db.q(`SELECT count(*)::int AS n FROM ${schema === "public" ? "public" : assertPlainIdentifier(schema)}.real_registration_admission`)));
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

  /** Read-only: the public singleton row in the shape the expected-delta comparison takes. */
  const seedRowOf = async (read: TrackedRead): Promise<SeedRow> => {
    const row = one(await read("reading the final singleton row", () => db.q(READ_ROW_SQL)));
    return { shortHits: row.short_hits as number, dayHits: row.day_hits as number, shortAtEpoch: row.short_at_epoch === true, dayAtEpoch: row.day_at_epoch === true };
  };

  /** The rows of a scratch copy, as the database holds them (a scratch schema this run owns). */
  const scratchRow = async (schema: string) => {
    ownership.assertOwnedSchema(schema);
    const rows = await lifecycle.read("reading the scratch table's rows", () => db.q(`SELECT scope::text AS scope, short_hits, day_hits, short_window_start = 'epoch'::timestamptz AS short_at_epoch, day_window_start = 'epoch'::timestamptz AS day_at_epoch FROM ${assertPlainIdentifier(schema)}.real_registration_admission ORDER BY scope`));
    return rows.map((row) => ({ scope: String(row.scope), shortHits: row.short_hits as number, dayHits: row.day_hits as number, shortAtEpoch: row.short_at_epoch === true, dayAtEpoch: row.day_at_epoch === true }));
  };
  const SEED = { scope: "register_options", shortHits: 0, dayHits: 0, shortAtEpoch: true, dayAtEpoch: true };

  /** Creates one look-alike in a scratch schema of its own — every object registered before it exists — and returns the schema. */
  async function buildVariant(variant: Variant): Promise<string> {
    const schema = ownership.registerScratchSchema(variant.suffix);
    await write("creating a scratch schema", `CREATE SCHEMA ${schema}`);
    for (const step of variant.steps(schema)) {
      if (step.register) ownership.registerScratchObject(schema, step.register[0], step.register[1]);
      await write(`building the look-alike (${variant.what})`, step.sql);
    }
    return schema;
  }
  /** The block must REFUSE the look-alike with its own RAISE (P0001) and leave it exactly as it was. */
  async function refusesAndLeavesUnchanged(variant: Variant): Promise<string> {
    const schema = await buildVariant(variant);
    const before = await shapeDigest(lifecycle.read, schema, "real_registration_admission");
    const refusal = await refused(`the block against a look-alike (${variant.what})`, migrationBlockFor(schema), ["P0001"]);
    expect(await shapeDigest(lifecycle.read, schema, "real_registration_admission"), variant.what).toBe(before);
    return refusal.sqlState;
  }

  /**
   * A live case. Everything it does to the database happens inside
   * lifecycle.runCase, which refuses before the body — before any database
   * activity — once the run is poisoned or an earlier case is still running,
   * and poisons the run if the body outlives its deadline.
   */
  function liveCase(name: (typeof EXPECTED_CASES)[number], body: () => Promise<void>) {
    it(name, () => lifecycle.runCase(name, body), VITEST_TIMEOUT_MS);
  }

  beforeAll(async () => {
    const url = requireDisposableTargetUrl(GATE, ALLOWED_GATES);
    const mode = requirePooledMode(parseDatabaseUrl(url, false));
    if (!mode.ok) throw new Error(`Registration admission smoke refused before any database work: ${mode.reason}`);
    const selection = checkRegistrationAdmissionFileSelection(inject("vitestCliArgs"));
    if (!selection.ok) throw new Error(`Registration admission smoke refused before any database work: ${selection.reason}`);
    const timeouts = checkRunnerTimeoutFlags(inject("vitestCliArgs"));
    if (!timeouts.ok) throw new Error(`Registration admission smoke refused before any database work: ${timeouts.reason}`);
    // Every refusal is behind us. The label only — never the connection string.
    console.log(`[registration-admission-smoke] connection_mode: ${mode.mode}`);
    started = true;
    db = await connectSmokeDb(url);
    const stores = await connectSmokeStores(url);
    store = stores.registrationAdmission;
    admission = createRegistrationAdmission(store);
    facts.connectionMode = mode.mode;

    // Everything in the preflight is READ-ONLY, tracked, and under one deadline; the run is armed only at its very end.
    await lifecycle.runPreflight(async () => {
      // ONE single-statement request: the same autocommit path production admission takes. Never a batch.
      const server = one(await lifecycle.read("reading the server's identity", () => db.q("SELECT pg_catalog.current_database()::text AS database, pg_catalog.current_setting('server_version') AS version, pg_catalog.current_setting('server_version_num')::int AS version_num, pg_catalog.current_setting('transaction_isolation') AS isolation, pg_catalog.current_setting('default_transaction_isolation') AS default_isolation, pg_catalog.pg_is_in_recovery() AS in_recovery, pg_catalog.current_schema()::text AS current_schema")));
      facts.server = { database: server.database, version: server.version, isolation: server.isolation, defaultIsolation: server.default_isolation, inRecovery: server.in_recovery };
      lifecycle.preflightCheck("the connected database is the one the confirmed URL names", server.database === new URL(url).pathname.slice(1));
      lifecycle.preflightCheck("the target is not a read replica", server.in_recovery === false);
      lifecycle.preflightCheck("unqualified names resolve to public", server.current_schema === "public");
      lifecycle.preflightCheck("the server is version 15 or newer (the migration reads pg_index.indnullsnotdistinct)", typeof server.version_num === "number" && server.version_num >= 150000);
      lifecycle.preflightCheck("a single autocommit statement runs at READ COMMITTED (the path production admission uses)", server.isolation === "read committed");
      lifecycle.preflightCheck("the database default isolation is READ COMMITTED", server.default_isolation === "read committed");
      const sameName = one(await lifecycle.read("looking for an existing admission relation", () => db.q("SELECT count(*)::int AS n FROM pg_catalog.pg_class c WHERE c.relname = 'real_registration_admission'")));
      lifecycle.preflightCheck("no relation named real_registration_admission exists in any schema", sameName.n === 0);
      const visible = one(await lifecycle.read("checking that activity is visible", () => db.q(CAN_SEE_ACTIVITY_SQL)));
      lifecycle.preflightCheck("this session can see pg_stat_activity (the race cases need to)", visible.n === 1);
      baseline = await snapshot(lifecycle.read);
      lifecycle.preflightCheck("public.real_rate_limits exists", Object.hasOwn(baseline.tables, "real_rate_limits"));
      lifecycle.preflightCheck("no scratch schema of this harness's shape exists", !baseline.schemas.some((name) => name.startsWith("pb_smoke_")));
      // The START record is saved before anything may be written: without it the run cannot be armed.
      const startEvidence = { runId, server: facts.server, connectionMode: facts.connectionMode, migrationStatementSha256: MIGRATION_SHA256, expectedCases: [...EXPECTED_CASES], fingerprintsBefore: baseline };
      startSaved = writeRegistrationAdmissionEvidence({ directory: EVIDENCE_DIRECTORY, runId, stage: "start", evidence: startEvidence });
      lifecycle.arm({ startEvidence: startSaved });
    });
  }, VITEST_TIMEOUT_MS);

  // After EVERY test: nothing is sent. The runner's own verdict on the test, or a body it abandoned, poisons the run.
  afterEach((context) => lifecycle.afterCase({ reportedFailed: caseFailedInVitest(context) }), VITEST_TIMEOUT_MS);

  // The end of the run: no write, no cleanup, and no read at all once the run is poisoned.
  afterAll(async () => {
    if (!started) return;
    let after: DatabaseSnapshot | null = null;
    const final = await lifecycle.finish({
      deadlineMs: CLEANUP_DEADLINE_MS,
      compare: async (read) => {
        after = await snapshot(read);
        const admissionTable = await describeTable(read, "public");
        const seedRow = await seedRowOf(read);
        return compareWithExpectedAdmissionDelta({ before: baseline, after, admissionTable, seedRow, ownedSchemas: ownership.ownedSchemas() });
      },
    });
    // Evidence for review: counts, digests, outcomes, this run's own fixture names, SQLSTATEs. Never a URL, an endpoint
    // id, a credential, or a driver's error text. Saved to a new owner-only file (never overwriting one), and printed.
    const evidence = {
      runId,
      lifecycleOutcome: final.outcome,
      server: facts.server,
      connectionMode: facts.connectionMode,
      migrationStatementSha256: MIGRATION_SHA256,
      casesExecuted: final.executed,
      casesNotExecuted: final.notExecuted,
      admissionTallies: final.admissionTallies,
      schemaRefusals: final.schemaRefusals,
      rowSnapshots: caseNotes,
      cleanup: final.cleanup,
      fingerprintsBefore: baseline,
      fingerprintsAfter: after,
      expectedDelta: final.delta,
      writes: final.writes,
      unknownOperations: final.unknownOperations,
      inFlightOperations: final.inFlightOperations,
      verdict: final.verdict,
      poisoned: final.poisoned,
      ownedSchemas: final.ownedSchemas,
      startEvidence: startSaved.ok ? "saved" : startSaved.reason,
      action: final.action,
    };
    const finalSaved = writeRegistrationAdmissionEvidence({ directory: EVIDENCE_DIRECTORY, runId, stage: "final", evidence });
    const verdict = concludeRegistrationAdmissionRun(final, { start: startSaved, final: finalSaved });
    console.log(`[registration-admission-smoke] ${safeEvidenceJson({ ...evidence, finalEvidence: finalSaved.ok ? "saved" : finalSaved.reason, runVerdict: verdict.verdict }) ?? '{"evidence":"withheld: it failed the content check"}'}`);
    // Fails for a poisoned run, a delta mismatch, AND a clean run whose evidence could not be saved. Nothing else happens here.
    if (!verdict.pass) throw new Error(verdict.message);
  }, VITEST_TIMEOUT_MS);

  // ---------------------------------------------------------------- S: the schema block

  liveCase("S1. missing table: the production admission fails closed before the block is applied", async () => {
    // 42P01 = undefined_table. The store throws; it never answers "admitted" and never a denial.
    const refusal = await lifecycle.expectDatabaseRefusal("an admission request with no table", prodRequest(), ["42P01"]);
    caseNotes.s1 = refusal;
  });

  liveCase("S2. scratch schema: first apply seeds one row, an idempotent rerun preserves it, a live counter survives a rerun, exact catalog descriptor", async () => {
    const schema = ownership.registerScratchSchema("apply");
    await write("creating a scratch schema", `CREATE SCHEMA ${schema}`);
    ownership.registerScratchObject(schema, "table", "real_registration_admission");
    await write("the block's first apply in a scratch schema", migrationBlockFor(schema));
    expect(await describeTable(lifecycle.read, schema)).toEqual(EXPECTED_ADMISSION_TABLE);
    expect(await scratchRow(schema)).toEqual([SEED]);
    const shape = await shapeDigest(lifecycle.read, schema, "real_registration_admission");
    await write("the block's rerun in a scratch schema", migrationBlockFor(schema));
    expect(await scratchRow(schema)).toEqual([SEED]);
    expect(await describeTable(lifecycle.read, schema)).toEqual(EXPECTED_ADMISSION_TABLE);
    expect(await shapeDigest(lifecycle.read, schema, "real_registration_admission")).toBe(shape);
    applied = schema;
    // A live counter must survive a rerun (ON CONFLICT DO NOTHING, never a reset): an exact hand-built copy that ALREADY holds a live row.
    const live = await buildVariant({
      suffix: "live",
      what: "an exact hand-built copy holding a live row",
      steps: (s) => [lookAlike(tableDdl(s, exact())), { sql: `INSERT INTO ${s}.real_registration_admission (scope, short_window_start, short_hits, day_window_start, day_hits) VALUES ('register_options', pg_catalog.now(), 7, pg_catalog.now(), 9)` }],
    });
    const liveRow = { scope: "register_options", shortHits: 7, dayHits: 9, shortAtEpoch: false, dayAtEpoch: false };
    expect(await scratchRow(live)).toEqual([liveRow]);
    await write("the block against a copy holding a live row", migrationBlockFor(live));
    expect(await scratchRow(live)).toEqual([liveRow]);
    await write("the block's rerun over the live row", migrationBlockFor(live));
    expect(await scratchRow(live)).toEqual([liveRow]);
    expect(await describeTable(lifecycle.read, live)).toEqual({ ...EXPECTED_ADMISSION_TABLE, rows: 1 });
    caseNotes.s2 = { seedAfterApply: "exact", seedAfterRerun: "exact", liveRowAfterReruns: "preserved" };
  });

  liveCase("S3. scratch schema: the CHECKs, the primary key, and NOT NULL are enforced, and no second scope can exist", async () => {
    ownership.assertOwnedSchema(applied);
    const insert = (values: string) => `INSERT INTO ${applied}.real_registration_admission (scope, short_window_start, short_hits, day_window_start, day_hits) VALUES (${values})`;
    const now = "pg_catalog.now()";
    // 23514 = check_violation, 23505 = unique_violation, 23502 = not_null_violation. A CHECK is evaluated before the unique index, so each row below breaks exactly one rule.
    for (const scope of ["login_options", "REGISTER_OPTIONS", "register_options ", ""]) {
      expect((await refused("a row under another scope", insert(`'${scope}', ${now}, 0, ${now}, 0`), ["23514"])).constraint, scope).toBe("real_registration_admission_scope_check");
    }
    expect((await refused("a negative short counter", insert(`'register_options', ${now}, -1, ${now}, 0`), ["23514"])).constraint).toBe("real_registration_admission_short_hits_check");
    expect((await refused("a short counter above the bound", insert(`'register_options', ${now}, 100001, ${now}, 0`), ["23514"])).constraint).toBe("real_registration_admission_short_hits_check");
    expect((await refused("a negative daily counter", insert(`'register_options', ${now}, 0, ${now}, -1`), ["23514"])).constraint).toBe("real_registration_admission_day_hits_check");
    expect((await refused("a daily counter above the bound", insert(`'register_options', ${now}, 0, ${now}, 100001`), ["23514"])).constraint).toBe("real_registration_admission_day_hits_check");
    expect((await refused("a duplicate scope", insert(`'register_options', ${now}, 0, ${now}, 0`), ["23505"])).constraint).toBe("real_registration_admission_pkey");
    await refused("a row with no window start (there is no default)", `INSERT INTO ${applied}.real_registration_admission (scope, short_hits, day_window_start, day_hits) VALUES ('register_options', 0, ${now}, 0)`, ["23502"]);
    await refused("a row with no counter (there is no default)", `INSERT INTO ${applied}.real_registration_admission (scope, short_window_start, day_window_start, day_hits) VALUES ('register_options', ${now}, ${now}, 0)`, ["23502"]);
    // The bounds themselves are accepted by the CHECKs, and still only one row can exist.
    expect((await scratchRow(applied)).length).toBe(1);
    expect((await describeTable(lifecycle.read, applied)).rows).toBe(1);
  });

  liveCase("S4. scratch schemas: an exact hand-built copy is accepted and seeded, and the mandatory look-alikes are refused and left unchanged", async () => {
    // The control: the same parts, unchanged, are the intended table — so every variant below differs from it in exactly one way.
    const control = await buildVariant({ suffix: "control", what: "an exact hand-built copy", steps: (s) => [lookAlike(tableDdl(s, exact()))] });
    expect(await scratchRow(control)).toEqual([]); // an existing, empty, correct table: missing seed
    await write("the block against an exact hand-built copy", migrationBlockFor(control));
    expect(await describeTable(lifecycle.read, control)).toEqual(EXPECTED_ADMISSION_TABLE);
    expect(await scratchRow(control)).toEqual([SEED]); // seeded exactly once, only after the proofs passed
    const refusals: Record<string, string> = {};
    for (const variant of MANDATORY_VARIANTS) refusals[variant.suffix] = await refusesAndLeavesUnchanged(variant);
    expect(Object.keys(refusals)).toHaveLength(15);
    caseNotes.s4 = refusals;
  });

  liveCase("S5. scratch schemas: further look-alikes are refused and left unchanged", async () => {
    const refusals: Record<string, string> = {};
    for (const variant of FURTHER_VARIANTS) refusals[variant.suffix] = await refusesAndLeavesUnchanged(variant);
    expect(Object.keys(refusals)).toHaveLength(13);
    caseNotes.s5 = refusals;
  });

  liveCase("S6. a target schema that does not exist is refused, and is not created", async () => {
    // Of this run's shape, but deliberately never registered and never created: the block must not create it.
    const absent = `pb_smoke_${runId}_absent`;
    await refused("the block against a schema that does not exist", migrationBlockFor(absent), ["P0001"]);
    const found = one(await lifecycle.read("looking for the schema the block was refused", () => db.q("SELECT count(*)::int AS n FROM pg_catalog.pg_namespace WHERE nspname = $1", [absent])));
    expect(found.n).toBe(0);
  });

  liveCase("S7. public: the exact block applies once, reruns idempotently, seeds exactly the intended row, and matches the expected descriptor", async () => {
    // The ONLY writes to `public` in the whole run besides the singleton-row fixtures: the unmodified block, here and in F1.
    await applyToPublic("the block's first apply in public");
    expect(await describeTable(lifecycle.read, "public")).toEqual(EXPECTED_ADMISSION_TABLE);
    const row = await readRow();
    expect({ shortHits: row.shortHits, dayHits: row.dayHits, shortAtEpoch: row.shortAtEpoch, dayAtEpoch: row.dayAtEpoch }).toEqual({ shortHits: 0, dayHits: 0, shortAtEpoch: true, dayAtEpoch: true });
    const shape = await shapeDigest(lifecycle.read, "public", "real_registration_admission");
    await applyToPublic("the block's rerun in public");
    expect(await describeTable(lifecycle.read, "public")).toEqual(EXPECTED_ADMISSION_TABLE);
    expect(await shapeDigest(lifecycle.read, "public", "real_registration_admission")).toBe(shape);
    sameRow(await readRow(), row); // the rerun neither re-created nor re-wrote the seed row
    // The production statements name the table without a schema: it must resolve to the one just created.
    const resolved = one(await lifecycle.read("resolving the unqualified table name", () => db.q("SELECT (pg_catalog.to_regclass('real_registration_admission') IS NOT NULL AND pg_catalog.to_regclass('real_registration_admission') = pg_catalog.to_regclass('public.real_registration_admission')) AS same")));
    expect(resolved.same).toBe(true);
    // The Slice E table was not touched by any of it.
    expect(await shapeDigest(lifecycle.read, "public", "real_rate_limits")).toBe(baseline!.tables.real_rate_limits!.shapeDigest);
  });

  // ---------------------------------------------------------------- I: the production admission, one request at a time

  liveCase("I1. a single autocommit statement runs at READ COMMITTED, and the first admission anchors both windows", async () => {
    // Again, on the same single-statement path the admission uses, now that the table exists.
    const level = one(await lifecycle.read("reading the isolation level through the single-statement path", () => db.q("SELECT pg_catalog.current_setting('transaction_isolation') AS level")));
    expect(level.level).toBe("read committed");
    await toSeed();
    expect((await lifecycle.admit("the first admission", prodRequest())).kind).toBe("admitted");
    const row = await readRow();
    expect({ shortHits: row.shortHits, dayHits: row.dayHits, shortAtEpoch: row.shortAtEpoch, dayAtEpoch: row.dayAtEpoch }).toEqual({ shortHits: 1, dayHits: 1, shortAtEpoch: false, dayAtEpoch: false });
    // Both windows were anchored by the same statement's now(): identical, and recent.
    expect(row.shortStart).toBe(row.dayStart);
    expect(row.shortAge).toBeLessThan(120);
    caseNotes.i1 = { shortHits: row.shortHits, dayHits: row.dayHits };
  });

  liveCase("I2. the production policy admits exactly 30, then refuses the 31st without touching the row", async () => {
    await toSeed();
    for (let i = 1; i <= 30; i += 1) expect((await lifecycle.admit(`admission ${i} of 30`, prodRequest())).kind, `request ${i}`).toBe("admitted");
    const exhausted = await readRow();
    expect({ shortHits: exhausted.shortHits, dayHits: exhausted.dayHits }).toEqual({ shortHits: 30, dayHits: 30 });
    expectDenied(await lifecycle.admit("the 31st admission", prodRequest()), { atLeast: 1, atMost: HOUR });
    sameRow(await readRow(), exhausted); // values, window starts, xmin and ctid: no new row version
    caseNotes.i2 = { shortHits: exhausted.shortHits, dayHits: exhausted.dayHits };
  });

  liveCase("I3. the production policy admits exactly 100 across hourly windows, then refuses the 101st", async () => {
    await toSeed();
    for (const [hour, count] of [30, 30, 30, 10].entries()) {
      if (hour > 0) await backdateShort(HOUR + 1); // the hourly window elapses; the daily one is untouched
      for (let i = 1; i <= count; i += 1) expect((await lifecycle.admit(`hour ${hour + 1}, admission ${i}`, prodRequest())).kind).toBe("admitted");
    }
    const full = await readRow();
    expect({ shortHits: full.shortHits, dayHits: full.dayHits }).toEqual({ shortHits: 10, dayHits: 100 });
    // The hourly window has room (10 of 30): only the daily window refuses, so the wait is the daily one's.
    expectDenied(await lifecycle.admit("the 101st admission", prodRequest()), { atLeast: HOUR + 1, atMost: DAY });
    sameRow(await readRow(), full); // the refusal charged neither window
    caseNotes.i3 = { shortHits: full.shortHits, dayHits: full.dayHits };
  });

  liveCase("I4. hourly rollover: the short window resets while the daily window keeps counting", async () => {
    // Exhausted and ACTIVE, set deterministically (30 s old), so no real-time drift decides the outcome.
    await setRow(30, 30, 30, 30);
    expectDenied(await lifecycle.admit("a request while the hourly window is exhausted", prodRequest()), { atLeast: HOUR - 30 - 30, atMost: HOUR - 30 });
    const before = await readRow();
    await backdateShort(HOUR - 90); // about 60 seconds of the hour remain: still active
    expectDenied(await lifecycle.admit("a request just before the boundary", prodRequest()), { atLeast: 20, atMost: 61 });
    await backdateShort(120); // now past the boundary
    expect((await lifecycle.admit("a request just after the boundary", prodRequest())).kind).toBe("admitted");
    const after = await readRow();
    expect({ shortHits: after.shortHits, dayHits: after.dayHits }).toEqual({ shortHits: 1, dayHits: 31 });
    expect(after.dayStart).toBe(before.dayStart); // the daily window was not re-anchored
    expect(after.shortStart).not.toBe(before.shortStart);
  });

  liveCase("I5. daily rollover and independent rollover: a refusal charges neither window", async () => {
    // Both exhausted and active: the daily wait is the longer one.
    await setRow(10, 30, 100, 100);
    expectDenied(await lifecycle.admit("a request while both windows are exhausted", prodRequest()), { atLeast: DAY - 100 - 10, atMost: DAY - 100 });
    // The daily window elapses; the hourly window is still exhausted and ACTIVE: only the hourly window refuses, and the elapsed daily window is NOT rolled by the refusal.
    await backdateDay(DAY);
    const stale = await readRow();
    expectDenied(await lifecycle.admit("a request while only the hourly window is exhausted", prodRequest()), { atLeast: 1, atMost: HOUR });
    sameRow(await readRow(), stale);
    // Both elapsed: admitted, and both windows reset.
    await backdateShort(HOUR + 1);
    expect((await lifecycle.admit("a request with both windows elapsed", prodRequest())).kind).toBe("admitted");
    const both = await readRow();
    expect({ shortHits: both.shortHits, dayHits: both.dayHits }).toEqual({ shortHits: 1, dayHits: 1 });
    // The other direction: hourly elapsed, daily active with room — the daily window keeps its start.
    await setRow(HOUR + 1, 30, 100, 50);
    const mid = await readRow();
    expect((await lifecycle.admit("a request with only the hourly window elapsed", prodRequest())).kind).toBe("admitted");
    const after = await readRow();
    expect({ shortHits: after.shortHits, dayHits: after.dayHits }).toEqual({ shortHits: 1, dayHits: 51 });
    expect(after.dayStart).toBe(mid.dayStart);
    // And a daily refusal does not touch an elapsed hourly window.
    await setRow(HOUR + 1, 30, 100, 100);
    const dayFull = await readRow();
    expectDenied(await lifecycle.admit("a request while only the daily window is exhausted", prodRequest()), { atLeast: DAY - 200, atMost: DAY });
    sameRow(await readRow(), dayFull);
  });

  liveCase("I6. Retry-After: short only, daily only, both (the longest), and a lowered limit", async () => {
    await setRow(600, 30, 600, 5);
    expectDenied(await lifecycle.admit("only the hourly window exhausted", prodRequest()), { atLeast: HOUR - 600 - 10, atMost: HOUR - 600 });
    await setRow(600, 5, 600, 100);
    expectDenied(await lifecycle.admit("only the daily window exhausted", prodRequest()), { atLeast: DAY - 600 - 10, atMost: DAY - 600 });
    await setRow(600, 30, 600, 100);
    expectDenied(await lifecycle.admit("both exhausted, the daily wait is longer", prodRequest()), { atLeast: DAY - 600 - 10, atMost: DAY - 600 });
    await setRow(10, 30, DAY - 100, 100);
    expectDenied(await lifecycle.admit("both exhausted, the hourly wait is longer", prodRequest()), { atLeast: HOUR - 10 - 10, atMost: HOUR - 10 });
    // A limit lowered below the current count is exhausted, not corrupt; raising it admits again.
    await setRow(600, 5, 600, 5);
    const before = await readRow();
    expectDenied(await lifecycle.admit("a lowered limit", policyRequest(LOWERED)), { atLeast: HOUR - 600 - 10, atMost: HOUR - 600 });
    sameRow(await readRow(), before);
    expect((await lifecycle.admit("a raised limit", policyRequest(RAISED))).kind).toBe("admitted");
    expect((await readRow()).shortHits).toBe(6);
  });

  liveCase("I7. denial purity: 25 further refusals leave counters, window starts, xmin and ctid unchanged", async () => {
    await setRow(60, 30, 60, 40);
    const before = await readRow();
    for (let i = 1; i <= 25; i += 1) expect((await lifecycle.admit(`refusal ${i} of 25`, prodRequest())).kind).toBe("denied");
    sameRow(await readRow(), before);
    caseNotes.i7 = { shortHits: before.shortHits, dayHits: before.dayHits, refusals: 25 };
  });

  // ---------------------------------------------------------------- C: real concurrency

  liveCase("C1. 60 simultaneous requests against a limit of 30: exactly 30 admitted", async () => {
    await toSeed();
    const outcomes = await together("60 simultaneous requests", Array.from({ length: 60 }, () => prodRequest()));
    expect(tallyOutcomes(outcomes)).toEqual({ admitted: 30, denied: 30 });
    const row = await readRow();
    expect({ shortHits: row.shortHits, dayHits: row.dayHits }).toEqual({ shortHits: 30, dayHits: 30 });
    caseNotes.c1 = tallyOutcomes(outcomes);
  });

  liveCase("C2. 50 simultaneous requests against a daily limit of 20: exactly 20 admitted, no partial charging", async () => {
    await toSeed();
    const outcomes = await together("50 simultaneous requests", Array.from({ length: 50 }, () => policyRequest(DAILY_TWENTY)));
    expect(tallyOutcomes(outcomes)).toEqual({ admitted: 20, denied: 30 });
    const row = await readRow();
    // A refusal charged neither window, so the two counters rose together, once per admission.
    expect({ shortHits: row.shortHits, dayHits: row.dayHits }).toEqual({ shortHits: 20, dayHits: 20 });
    caseNotes.c2 = tallyOutcomes(outcomes);
  });

  liveCase("C3. both counters one below their limits, 10 simultaneous: exactly one admitted, both rise together", async () => {
    await setRow(60, 29, 60, 99);
    const outcomes = await together("10 simultaneous requests", Array.from({ length: 10 }, () => prodRequest()));
    expect(admittedCount(outcomes)).toBe(1);
    expect(tallyOutcomes(outcomes)).toEqual({ admitted: 1, denied: 9 });
    const row = await readRow();
    expect({ shortHits: row.shortHits, dayHits: row.dayHits }).toEqual({ shortHits: 30, dayHits: 100 });
    caseNotes.c3 = tallyOutcomes(outcomes);
  });

  liveCase("C4. both windows elapsed, 40 simultaneous: one rollover and exactly 30 admitted", async () => {
    await toSeed(); // both windows at the epoch: elapsed
    const outcomes = await together("40 simultaneous requests over elapsed windows", Array.from({ length: 40 }, () => prodRequest()));
    expect(tallyOutcomes(outcomes)).toEqual({ admitted: 30, denied: 10 });
    const row = await readRow();
    // A second reset would have lost counts: the counters equal the admissions exactly.
    expect({ shortHits: row.shortHits, dayHits: row.dayHits }).toEqual({ shortHits: 30, dayHits: 30 });
    expect(row.shortStart).toBe(row.dayStart);
    caseNotes.c4 = tallyOutcomes(outcomes);
  });

  // ---------------------------------------------------------------- R: READ COMMITTED races with a second session

  liveCase("R1. a blocked admission re-checks the newer row after the holder commits: refused, no extra admission", async () => {
    await setRow(60, 29, 60, 29); // exactly one admission left in each window, as far as a snapshot taken now can tell
    // Session T1: takes the row's lock, changes it to exhausted, and HOLDS it (an uncommitted change) for a while.
    const holder = lifecycle.launch("the lock holder (exhausts the row, then holds)", () => db.tx(holderStatements("exhaust", 8)));
    const holding = await waitFor("polling for the lock holder", HOLDER_ACTIVE_SQL, 4000);
    if (!holding) {
      lifecycle.poison("the lock holder was never observed holding the row; the interleaving was not established");
      await lifecycle.collectHolder(holder).catch(() => undefined);
      throw new Error("registration admission smoke: the race was not established (no holder)");
    }
    // Session T2: the production request. Its snapshot still shows 29/29 (the holder is uncommitted), so it tries to update — and must WAIT on the holder's tuple lock.
    const racer = lifecycle.launch("an admission racing the holder", policyRequest(PROD));
    const blocked = await waitFor("polling for the blocked admission", WAITER_BLOCKED_SQL, 4000);
    if (!blocked) {
      lifecycle.poison("the racing admission was never observed waiting on the lock; the interleaving was not established");
      await lifecycle.collectHolder(holder).catch(() => undefined);
      await lifecycle.collectAdmission(racer).catch(() => undefined);
      throw new Error("registration admission smoke: the race was not established (no waiter)");
    }
    await lifecycle.collectHolder(holder); // the holder commits: the row is now 30/30
    const outcome = await lifecycle.collectAdmission(racer);
    // After the wait, the WHERE clause is re-checked against the NEW row version (30/30): refused. E2 only classified it.
    expect(outcome.kind).toBe("denied");
    const row = await readRow();
    expect({ shortHits: row.shortHits, dayHits: row.dayHits }).toEqual({ shortHits: 30, dayHits: 30 }); // never 31
    caseNotes.r1 = { outcome: outcome.kind, shortHits: row.shortHits, dayHits: row.dayHits };
  });

  liveCase("R2. a snapshot that sees an exhausted window while another session rolls it: never falsely admitted", async () => {
    await setRow(60, 30, 60, 40);
    // Session T1: an UNCOMMITTED change that makes the hourly window elapsed, held for a while.
    let holderSettled = false;
    const holder = lifecycle.launch("the lock holder (rolls the hourly window, then holds)", () => db.tx(holderStatements("roll_short", 8)));
    void holder.done.then(() => void (holderSettled = true));
    const holding = await waitFor("polling for the lock holder", HOLDER_ACTIVE_SQL, 4000);
    if (!holding) {
      lifecycle.poison("the lock holder was never observed holding the row; the interleaving was not established");
      await lifecycle.collectHolder(holder).catch(() => undefined);
      throw new Error("registration admission smoke: the race was not established (no holder)");
    }
    // Session T2: its snapshot sees the OLD, exhausted version. It must NOT be admitted (a temporary false refusal is allowed).
    const racer = lifecycle.launch("an admission whose snapshot sees an exhausted window", policyRequest(PROD));
    const racerOutcome = await lifecycle.collectAdmission(racer);
    const settledBeforeHolder = !holderSettled; // recorded, not asserted: the design expects it not to block, which this run measures
    expect(racerOutcome.kind).toBe("denied");
    await lifecycle.collectHolder(holder); // the holder commits: the hourly window is now elapsed
    // Afterwards the window really is open, so a fresh request is admitted and rolls it.
    expect((await lifecycle.admit("a request after the holder committed", prodRequest())).kind).toBe("admitted");
    const row = await readRow();
    expect({ shortHits: row.shortHits, dayHits: row.dayHits }).toEqual({ shortHits: 1, dayHits: 41 });
    caseNotes.r2 = { racer: racerOutcome.kind, racerSettledBeforeHolder: settledBeforeHolder, shortHits: row.shortHits, dayHits: row.dayHits };
  });

  // ---------------------------------------------------------------- F: failing closed

  liveCase("F1. a missing singleton row fails closed, is not repaired by a request, and an operator rerun reseeds it", async () => {
    await toSeed();
    const removed = await rowWrite("removing the singleton row (test fixture)", REMOVE_ROW_SQL);
    expect(removed).toHaveLength(1);
    expect(await lifecycle.expectAdmissionFailure("an admission request with no singleton row", prodRequest(), ["missing_row"])).toBe("missing_row");
    const outcomes = await together("10 simultaneous requests with no singleton row", Array.from({ length: 10 }, () => prodRequest()), ["missing_row"]);
    expect(tallyOutcomes(outcomes)).toEqual({ admission_error: 10 });
    // No request repaired it.
    expect(one(await lifecycle.read("counting the singleton row", () => db.q(COUNT_ROWS_SQL))).n).toBe(0);
    // A deliberate operator rerun of the unmodified block re-inserts the seed — and resets capacity, which is exactly why it is deliberate.
    await applyToPublic("the operator's rerun of the block reseeds the removed row");
    expect(one(await lifecycle.read("counting the singleton row", () => db.q(COUNT_ROWS_SQL))).n).toBe(1);
    const row = await readRow();
    expect({ shortHits: row.shortHits, dayHits: row.dayHits, shortAtEpoch: row.shortAtEpoch, dayAtEpoch: row.dayAtEpoch }).toEqual({ shortHits: 0, dayHits: 0, shortAtEpoch: true, dayAtEpoch: true });
    expect((await lifecycle.admit("an admission after the reseed", prodRequest())).kind).toBe("admitted");
  });

  liveCase("F2. a malformed window start fails closed, and a small future start is clamped", async () => {
    // A start ten days in the FUTURE with an exhausted counter: the reported wait is far beyond the window plus its tolerance.
    await setRow(-864_000, 30, 60, 5);
    const future = await readRow();
    expect(await lifecycle.expectAdmissionFailure("an admission request with a far-future hourly start", prodRequest(), ["malformed_state"])).toBe("malformed_state");
    sameRow(await readRow(), future);
    await setRow(60, 5, -90, 100);
    expect(await lifecycle.expectAdmissionFailure("an admission request with a far-future daily start", prodRequest(), ["malformed_state"])).toBe("malformed_state");
    // A start only 30 seconds ahead is inside the 60-second tolerance: refused, with the wait clamped to the window.
    await setRow(-30, 30, 60, 5);
    expectDenied(await lifecycle.admit("an admission request with a small future start", prodRequest()), { atLeast: HOUR - 10, atMost: HOUR });
  });

  liveCase("F3. a database error propagates as itself and is never an admission or a denial", async () => {
    await toSeed();
    const beforeRename = await readRow();
    await rowWrite("renaming the table away (test fixture)", RENAME_AWAY_SQL);
    // 42P01: the UPDATE could not run. No admission, no denial, and E2 is never consulted.
    const refusal = await lifecycle.expectDatabaseRefusal("an admission request while the table is renamed away", prodRequest(), ["42P01"]);
    await rowWrite("renaming the table back (test fixture)", RENAME_BACK_SQL);
    expect(await describeTable(lifecycle.read, "public")).toEqual(EXPECTED_ADMISSION_TABLE);
    sameRow(await readRow(), beforeRename); // a rename touches no row
    caseNotes.f3 = refusal;
  });

  liveCase("F4. the row is restored to the seed state", async () => {
    await toSeed();
    const row = await readRow();
    expect({ shortHits: row.shortHits, dayHits: row.dayHits, shortAtEpoch: row.shortAtEpoch, dayAtEpoch: row.dayAtEpoch }).toEqual({ shortHits: 0, dayHits: 0, shortAtEpoch: true, dayAtEpoch: true });
    expect(one(await lifecycle.read("counting the singleton row", () => db.q(COUNT_ROWS_SQL))).n).toBe(1);
  });

  it("every decisive case ran, exactly once, in order", () => {
    expect(lifecycle.executed()).toEqual([...EXPECTED_CASES]);
    expect(lifecycle.poisoned()).toBeNull();
  }, VITEST_TIMEOUT_MS);

  it("Z. the final cleanup removes exactly what this run registered", async () => {
    await lifecycle.runFinalCleanup(db);
  }, VITEST_TIMEOUT_MS);
});
