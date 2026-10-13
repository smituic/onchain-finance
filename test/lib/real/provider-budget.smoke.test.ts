// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { PROVIDER_BUDGET_BUCKETS, createProviderBudgetLimiter, type ProviderBudgetFamily, type ProviderBudgetLimiter, type ProviderBudgetPolicy, type ProviderBudgetStore } from "@/lib/real/server/rate-limit";
import { checkDisposableTarget, connectSmokeDb, connectSmokeStores, parseDatabaseUrl, requireDisposableTargetUrl, type SmokeDb, type SmokeRow } from "./fixtures/handles-smoke-db";
import {
  CASE_DEADLINE_MS,
  CLEANUP_DEADLINE_MS,
  EXPECTED_PROVIDER_TABLE,
  MAX_CONCURRENCY,
  PROVIDER_BUDGET_SMOKE_FILE,
  VITEST_TIMEOUT_MS,
  assertPlainIdentifier,
  caseFailedInVitest,
  checkProviderBudgetFileSelection,
  checkRunnerTimeoutFlags,
  compareWithExpectedDelta,
  concludeProviderBudgetRun,
  createProviderBudgetLifecycle,
  createRunOwnership,
  requirePooledMode,
  sha256Hex,
  tallyOutcomes,
  writeProviderBudgetEvidence,
  type ConsumeOutcome,
  type DatabaseSnapshot,
  type EvidenceWrite,
  type ProviderTableDescriptor,
  type ScratchObjectKind,
  type TrackedRead,
} from "./fixtures/provider-budget-smoke";
import { safeEvidenceJson } from "./fixtures/provisioning-limits-smoke";

/**
 * MANUAL, LIVE-DATABASE proof of the provider-budget table and its ONE-statement
 * limiter (Milestone 3, Slice 3A-0), against a DISPOSABLE Neon branch.
 *
 * EXPLICITLY OPT-IN, AND NOT RUN as part of the build: its harness checks
 * below always run; every live case is skipped unless its own gate is set, and
 * then it runs only against a confirmed disposable Neon target. It must NEVER
 * be pointed at the real database.
 *
 * ONE CONTROLLED LIVE RUN HAS COMPLETED. Run 6d32fdf8, 2026-10-13: one run on
 * one disposable Neon branch, pooled connection, PostgreSQL 18.6. Vitest: 32
 * passed, 0 skipped, 0 failed, exit code 0 (as reported by the operator). All
 * 20 live cases ran; the lifecycle ended COMPLETED_CLEAN and the database
 * verdict was baseline_plus_expected_delta — never "restored", because the new
 * table remains, empty. An independent audit of the saved evidence found it
 * clean and evidenced. See ARCHITECTURE.md, "Public Readiness Milestone 3".
 *
 * THIS FILE IS NOT BYTE-IDENTICAL TO THE ONE THAT RAN, whose SHA-256 was
 * e8c9acf91656ecdcb1a66b2bb5e110642e9b16953102e3d6d2d2122d86a3ff8b. It was edited
 * twice afterwards, in OFFLINE, ungated code only: (1) this header comment, to
 * record the run; (2) one offline harness assertion — the test named "the
 * header records the one live run ..." — which used to require the pre-run
 * sentence and now checks the recorded run instead. The live describe block
 * (every case body, gate, hook, cleanup, and database operation) is unchanged.
 *
 * THAT BRANCH MUST NEVER BE REUSED: it now holds public.real_provider_budgets,
 * which the run requires to be absent. Any further live execution
 * requires separate authorization and a FRESH disposable
 * branch. Outside such a run, nothing in this file is evidence of PostgreSQL
 * or Neon behavior.
 *
 * WHAT IT DRIVES. schema.sql's "Provider Budgets" block, exactly as written
 * (only its target-schema constant is swapped for a scratch schema), and the
 * application's own limiter over its own Neon store
 * (createProviderBudgetLimiter(createNeonDurableStores().providerBudgets)) with
 * truly concurrent requests. It makes NO provider call and no route is
 * involved. Every limit and window below is a TEST VALUE: no provider budget
 * has an approved number, and none is set here.
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
 * 120000 ms. Every test and hook here carries that timeout explicitly, and the
 * run's own deadlines (90 s per case and for the preflight, 60 s for the
 * cleanup and for the post-run comparison) are shorter — so the run poisons
 * itself BEFORE the runner could abandon a database operation. Do NOT pass the
 * older smokes' 30000 ms flags.
 *
 * FRESH BRANCH, ONE RUN. The branch must NOT already have
 * public.real_provider_budgets: the first case proves the limiter fails closed
 * without the table, and a later one applies the block to `public`.
 *
 * WHAT A CLEAN RUN LEAVES BEHIND. Not the baseline: the baseline PLUS the
 * expected delta — public.real_provider_budgets now exists, empty, with the
 * intended structure. Every pre-existing public table must be unchanged in
 * contents and shape, and every scratch schema and budget row of this run must
 * be gone. It is never reported as "restored".
 *
 * NO PER-CASE CLEANUP. Each case uses its own subjects and scratch schemas.
 * One cleanup runs at the end, only if every case completed cleanly: exact
 * subjects, exact registered objects, RESTRICT only, after a read-only check
 * that each scratch schema holds exactly what was registered and nothing
 * outside it depends on it.
 *
 * A FAILED RUN KEEPS ITS EVIDENCE. The moment a case fails, times out, or gets
 * an answer it did not expect, the run is poisoned for good: no later case, no
 * further write or read, and NO cleanup. Investigate the branch read-only and
 * do not reuse it. A database error or a lost answer is never counted as a
 * budget denial, and nothing is ever retried.
 *
 * EVIDENCE. Two NEW owner-only files in `evidence/` (git-ignored; an existing
 * file is never overwritten): `provider-budget-smoke-<run id>-start.json`,
 * saved before anything may be written, and `...-final.json`. Never a
 * connection string, an endpoint id, a credential, or a driver's error text.
 * A clean run whose evidence cannot be saved FAILS.
 *
 *   REAL_SMOKE_PROVIDER_BUDGET=1 NEON_BRANCH_DATABASE_URL="postgres://..." NEON_BRANCH_EXPECTED_ENDPOINT_ID="ep-..." \
 *     pnpm exec vitest run test/lib/real/provider-budget.smoke.test.ts
 */
const GATE = "REAL_SMOKE_PROVIDER_BUDGET";
const ALLOWED_GATES = [GATE] as const;
const enabled = process.env[GATE] === "1";

/** Where the run's evidence is saved: a fixed, git-ignored directory. The file names are built from the run id alone. */
const EVIDENCE_DIRECTORY = "evidence";
/** The most budget requests ever issued together. */
const BURST = 16;

const SCHEMA_PATH = "lib/real/server/schema.sql";
const BEGIN = "-- BEGIN Provider Budgets";
const END = "-- END Provider Budgets";
const TARGET_LINE = "target_schema CONSTANT pg_catalog.text := 'public';";
const SCRATCH_NAME = /^pb_smoke_[0-9a-f]{8}_[a-z0-9]{1,12}$/;

/** The statement under test: the block's single DO statement, exactly as schema.sql has it. */
function migrationBlock(): string {
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  if (schema.split(BEGIN).length !== 2 || schema.split(END).length !== 2) throw new Error("the Provider Budgets block was not found exactly once in schema.sql");
  const section = schema.slice(schema.indexOf(BEGIN), schema.indexOf(END));
  const start = section.indexOf("DO $$");
  const end = section.lastIndexOf("END $$;");
  if (start < 0 || end < start || section.split("DO $$").length !== 2) throw new Error("the Provider Budgets block does not hold exactly one statement");
  const block = section.slice(start, end + "END $$;".length);
  if (block.split(TARGET_LINE).length !== 2) throw new Error("the block does not have exactly one target-schema constant");
  return block;
}
/** The same statement with ONLY its target-schema constant swapped, for a name of this harness's scratch shape. */
function migrationBlockFor(schemaName: string): string {
  if (!SCRATCH_NAME.test(schemaName)) throw new Error("provider budget smoke: the block may only be retargeted at a scratch schema of this harness's shape");
  return migrationBlock().replace(TARGET_LINE, `target_schema CONSTANT pg_catalog.text := '${schemaName}';`);
}
const MIGRATION_SHA256 = sha256Hex(migrationBlock());

/** Every live case, in order. The run is clean only if exactly these ran. */
const EXPECTED_CASES = [
  "S1. missing table: the production limiter fails closed before the block is applied",
  "S2. scratch schema: first apply, idempotent rerun, rerun with a row, exact catalog descriptor",
  "S3. scratch schema: the bucket CHECK, the hits CHECK, the primary key, and NOT NULL are enforced",
  "S4. scratch schemas: an exact hand-built copy is accepted, and the 13 mandatory look-alikes are refused and left unchanged",
  "S5. scratch schemas: 11 further look-alikes are refused and left unchanged",
  "S6. a target schema that does not exist is refused, and is not created",
  "S7. public: the exact block applies once, reruns idempotently, and matches the expected descriptor",
  "G1. exactly-at-limit admission, then one denial",
  "G2. 16 concurrent requests on one family: exactly the limit is admitted",
  "G3. daily exhaustion, independent of the short-window capacity",
  "G4. both windows exhausted: the longest wait decides",
  "G5. window expiry by the database clock",
  "G6. repeated denials do not extend the window",
  "G7. counters saturate at limit + 1",
  "G8. two subjects competing at once are independent",
  "G9. overlapping 2-, 4- and 6-bucket sets in mixed caller order",
  "G10. overlapping four-bucket combinations across families",
  "E1. a foreign bucket is refused by the CHECK and the whole multi-bucket statement rolls back",
  "E2. an oversized window is refused and nothing is charged",
  "E3. an oversized limit: the first request is charged, the next is refused, and the rows are unchanged",
] as const;

/** Every named read-only finding the preflight must record before the run may be armed. */
const PREFLIGHT_CHECKS = [
  "the connected database is the one the confirmed URL names",
  "the target is not a read replica",
  "unqualified names resolve to public",
  "no relation named real_provider_budgets exists in any schema",
  "public.real_rate_limits exists",
  "no provider-budget scratch schema exists",
] as const;

const SHORT_S = 600;
const DAY_S = 86_400;
const P = (bucket: ProviderBudgetPolicy["bucket"], limit: number, windowSeconds: number): ProviderBudgetPolicy => ({ bucket, limit, windowSeconds });
/** One family's short and daily TEST budgets. */
const family = (name: ProviderBudgetFamily, shortLimit: number, dayLimit: number, shortWindow = SHORT_S, dayWindow = DAY_S): ProviderBudgetPolicy[] => [P(`${name}_short`, shortLimit, shortWindow), P(`${name}_day`, dayLimit, dayWindow)];

// The look-alike tables: the intended definition, in parts, so each variant differs from it in exactly one way.
const COLUMNS = { bucket: 'bucket TEXT COLLATE "C" NOT NULL', subject: "subject TEXT NOT NULL", windowStart: "window_start TIMESTAMPTZ NOT NULL", hits: "hits INTEGER NOT NULL" };
const PRIMARY_KEY = "CONSTRAINT real_provider_budgets_pkey PRIMARY KEY (bucket, subject)";
const SIX = "'chain_read_short', 'chain_read_day', 'turnkey_reconcile_short', 'turnkey_reconcile_day', 'pay_submit_short', 'pay_submit_day'";
const BUCKET_CHECK = `CONSTRAINT real_provider_budgets_bucket_check CHECK (bucket IN (${SIX}))`;
const HITS_CHECK = "CONSTRAINT real_provider_budgets_hits_check CHECK (hits >= 1)";
const tableDdl = (schema: string, parts: readonly string[], tail = "") => `CREATE TABLE ${schema}.real_provider_budgets (${parts.join(", ")})${tail}`;
const exact = (overrides: Partial<Record<"bucket" | "subject" | "windowStart" | "hits" | "pk" | "bucketCheck" | "hitsCheck", string | null>> = {}, extra: readonly string[] = []): string[] => {
  const parts = { bucket: COLUMNS.bucket, subject: COLUMNS.subject, windowStart: COLUMNS.windowStart, hits: COLUMNS.hits, pk: PRIMARY_KEY, bucketCheck: BUCKET_CHECK, hitsCheck: HITS_CHECK, ...overrides };
  return [parts.bucket, parts.subject, parts.windowStart, parts.hits, ...extra.filter((part) => !part.startsWith("CONSTRAINT")), parts.pk, parts.bucketCheck, parts.hitsCheck, ...extra.filter((part) => part.startsWith("CONSTRAINT"))].filter((part): part is string => typeof part === "string");
};
type Step = { register?: [ScratchObjectKind, string]; sql: string };
type Variant = { suffix: string; what: string; steps: (schema: string) => Step[] };
const lookAlike = (sql: string): Step => ({ register: ["table", "real_provider_budgets"], sql });

/** The 13 mandatory wrong shapes. Each is ONE table, wholly inside its own scratch schema. */
const MANDATORY_VARIANTS: Variant[] = [
  { suffix: "m01", what: "an extra column", steps: (s) => [lookAlike(tableDdl(s, exact({}, ["target_handle TEXT"])))] },
  { suffix: "m02", what: "a missing column", steps: (s) => [lookAlike(tableDdl(s, exact({ windowStart: null })))] },
  { suffix: "m03", what: "hits as BIGINT", steps: (s) => [lookAlike(tableDdl(s, exact({ hits: "hits BIGINT NOT NULL" })))] },
  { suffix: "m04", what: "bucket without its collation", steps: (s) => [lookAlike(tableDdl(s, exact({ bucket: "bucket TEXT NOT NULL" })))] },
  { suffix: "m05", what: "a nullable column", steps: (s) => [lookAlike(tableDdl(s, exact({ windowStart: "window_start TIMESTAMPTZ" })))] },
  { suffix: "m06", what: "a column default", steps: (s) => [lookAlike(tableDdl(s, exact({ hits: "hits INTEGER NOT NULL DEFAULT 1" })))] },
  { suffix: "m07", what: "the primary key in the wrong column order", steps: (s) => [lookAlike(tableDdl(s, exact({ pk: "CONSTRAINT real_provider_budgets_pkey PRIMARY KEY (subject, bucket)" })))] },
  { suffix: "m08", what: "the primary key under the wrong name", steps: (s) => [lookAlike(tableDdl(s, exact({ pk: "CONSTRAINT pb_wrong_pkey PRIMARY KEY (bucket, subject)" })))] },
  { suffix: "m09", what: "no bucket CHECK", steps: (s) => [lookAlike(tableDdl(s, exact({ bucketCheck: null })))] },
  { suffix: "m10", what: "the bucket CHECK listing the four Slice E buckets", steps: (s) => [lookAlike(tableDdl(s, exact({ bucketCheck: "CONSTRAINT real_provider_budgets_bucket_check CHECK (bucket IN ('recipient_probe_short', 'recipient_probe_day', 'pay_prepare_short', 'pay_prepare_day'))" })))] },
  { suffix: "m11", what: "the bucket CHECK under the wrong name", steps: (s) => [lookAlike(tableDdl(s, exact({ bucketCheck: `CONSTRAINT pb_wrong_bucket_check CHECK (bucket IN (${SIX}))` })))] },
  { suffix: "m12", what: "the hits CHECK allowing zero", steps: (s) => [lookAlike(tableDdl(s, exact({ hitsCheck: "CONSTRAINT real_provider_budgets_hits_check CHECK (hits >= 0)" })))] },
  { suffix: "m13", what: "an extra index", steps: (s) => [lookAlike(tableDdl(s, exact())), { sql: `CREATE INDEX pb_extra_idx ON ${s}.real_provider_budgets (subject)` }] },
];

/**
 * 11 further wrong shapes. Every object each one needs — a parent, a child, a
 * trigger function — is created INSIDE the same scratch schema and registered
 * before it exists, in dependency order; nothing outside the schema is ever
 * referenced, altered, or made to depend on it.
 */
const FURTHER_VARIANTS: Variant[] = [
  { suffix: "a01", what: "an extra CHECK", steps: (s) => [lookAlike(tableDdl(s, exact({}, ["CONSTRAINT pb_extra_check CHECK (hits < 1000000)"])))] },
  {
    suffix: "a02",
    what: "the hits CHECK not validated",
    steps: (s) => [lookAlike(tableDdl(s, exact({ hitsCheck: null }))), { sql: `ALTER TABLE ${s}.real_provider_budgets ADD CONSTRAINT real_provider_budgets_hits_check CHECK (hits >= 1) NOT VALID` }],
  },
  { suffix: "a03", what: "the bucket CHECK listing five buckets", steps: (s) => [lookAlike(tableDdl(s, exact({ bucketCheck: "CONSTRAINT real_provider_budgets_bucket_check CHECK (bucket IN ('chain_read_short', 'chain_read_day', 'turnkey_reconcile_short', 'turnkey_reconcile_day', 'pay_submit_short'))" })))] },
  { suffix: "a04", what: "the bucket CHECK listing seven buckets", steps: (s) => [lookAlike(tableDdl(s, exact({ bucketCheck: `CONSTRAINT real_provider_budgets_bucket_check CHECK (bucket IN (${SIX}, 'chain_read_hour'))` })))] },
  { suffix: "a05", what: "a generated column", steps: (s) => [lookAlike(tableDdl(s, exact({ hits: "hits INTEGER GENERATED ALWAYS AS (1) STORED NOT NULL" })))] },
  { suffix: "a06", what: "row-level security enabled", steps: (s) => [lookAlike(tableDdl(s, exact())), { sql: `ALTER TABLE ${s}.real_provider_budgets ENABLE ROW LEVEL SECURITY` }] },
  {
    suffix: "a07",
    what: "a view under the table's name",
    steps: (s) => [{ register: ["view", "real_provider_budgets"], sql: `CREATE VIEW ${s}.real_provider_budgets AS SELECT 'chain_read_day'::text AS bucket, 'x'::text AS subject, pg_catalog.now() AS window_start, 1 AS hits` }],
  },
  {
    suffix: "a08",
    what: "a foreign key to another scratch table",
    steps: (s) => [
      { register: ["table", "pb_parent"], sql: `CREATE TABLE ${s}.pb_parent (subject TEXT PRIMARY KEY)` },
      lookAlike(tableDdl(s, exact({}, [`CONSTRAINT pb_out_fk FOREIGN KEY (subject) REFERENCES ${s}.pb_parent (subject)`]))),
    ],
  },
  {
    suffix: "a09",
    what: "another scratch table referencing it",
    steps: (s) => [
      lookAlike(tableDdl(s, exact())),
      { register: ["table", "pb_child"], sql: `CREATE TABLE ${s}.pb_child (bucket TEXT COLLATE "C", subject TEXT, CONSTRAINT pb_in_fk FOREIGN KEY (bucket, subject) REFERENCES ${s}.real_provider_budgets (bucket, subject))` },
    ],
  },
  {
    suffix: "a10",
    what: "a trigger calling a scratch function",
    steps: (s) => [
      { register: ["function", "pb_trigger_fn"], sql: `CREATE FUNCTION ${s}.pb_trigger_fn() RETURNS trigger LANGUAGE plpgsql AS $pb$ BEGIN RETURN NEW; END $pb$` },
      lookAlike(tableDdl(s, exact())),
      { sql: `CREATE TRIGGER pb_trigger BEFORE INSERT ON ${s}.real_provider_budgets FOR EACH ROW EXECUTE FUNCTION ${s}.pb_trigger_fn()` },
    ],
  },
  {
    suffix: "a11",
    what: "an inheritance child of another scratch table",
    steps: (s) => [{ register: ["table", "pb_parent"], sql: `CREATE TABLE ${s}.pb_parent ()` }, lookAlike(tableDdl(s, exact(), ` INHERITS (${s}.pb_parent)`))],
  },
];

// Offline (never gated): the harness itself. The pure guards are proven in provider-budget-smoke-harness.test.ts.
describe("provider budget smoke harness", () => {
  const source = readFileSync("test/lib/real/provider-budget.smoke.test.ts", "utf8");
  const uncommented = source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");
  // Everything except this offline block (whose own assertions quote the code they look for).
  const live = uncommented.slice(uncommented.indexOf("\ndescribe.skipIf(!enabled)"));
  const code = uncommented.slice(0, uncommented.indexOf('\ndescribe("provider budget smoke harness"')) + live;

  it("is this harness's registered file, gated by its OWN variable only, and never reads DATABASE_URL", () => {
    expect(PROVIDER_BUDGET_SMOKE_FILE).toBe("test/lib/real/provider-budget.smoke.test.ts");
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
      { REAL_SMOKE_RATE_LIMIT: "1", NEON_BRANCH_DATABASE_URL: branch }, // the Slice E smoke's gate is not this gate
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch, DATABASE_URL: branch },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch, REAL_SMOKE_RATE_LIMIT: "1" },
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
      "if (!mode.ok) throw new Error(`Provider budget smoke refused before any database work: ${mode.reason}`);",
      'const selection = checkProviderBudgetFileSelection(inject("vitestCliArgs"));',
      "if (!selection.ok) throw new Error(`Provider budget smoke refused before any database work: ${selection.reason}`);",
      'const timeouts = checkRunnerTimeoutFlags(inject("vitestCliArgs"));',
      "if (!timeouts.ok) throw new Error(`Provider budget smoke refused before any database work: ${timeouts.reason}`);",
      "console.log(`[provider-budget-smoke] connection_mode: ${mode.mode}`);",
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
    expect(uncommented.match(/^describe\(/gm)).toHaveLength(1); // this offline block is the only ungated one
    expect(code).toContain('describe.skipIf(!enabled)("provider budgets — schema block and real concurrency (DISPOSABLE BRANCH ONLY)", () => {');
    expect(code.match(/connectSmoke(?:Db|Stores)\(/g)).toHaveLength(2);
    expect(code).not.toMatch(/createNeon\w+\(|\bneon\(|new URL\([^)]*\)\.(hostname|host)\b|-pooler/);
    // Inside the preflight: every required check, the baseline, the START evidence, and only then the arming.
    const preflight = hook.slice(hook.indexOf("await lifecycle.runPreflight(async () => {"));
    const saved = preflight.indexOf('startSaved = writeProviderBudgetEvidence({ directory: EVIDENCE_DIRECTORY, runId, stage: "start", evidence: startEvidence });');
    const armed = preflight.indexOf("lifecycle.arm({ startEvidence: startSaved });");
    expect(preflight.indexOf("baseline = await snapshot(lifecycle.read);")).toBeGreaterThan(0);
    expect(saved).toBeGreaterThan(preflight.indexOf("baseline = await snapshot(lifecycle.read);"));
    expect(armed).toBeGreaterThan(saved);
    expect(code.match(/lifecycle\.arm\(/g)).toHaveLength(1);
    expect(preflight.match(/lifecycle\.preflightCheck\(/g)).toHaveLength(PREFLIGHT_CHECKS.length);
    for (const check of PREFLIGHT_CHECKS) expect(preflight, check).toContain(`lifecycle.preflightCheck("${check}", `);
  });

  it("every test and hook carries the runner timeout explicitly, and the run's own deadlines are shorter", () => {
    expect([VITEST_TIMEOUT_MS, CASE_DEADLINE_MS, CLEANUP_DEADLINE_MS]).toEqual([120_000, 90_000, 60_000]);
    expect(code).toContain("const lifecycle = createProviderBudgetLifecycle({ expectedCases: EXPECTED_CASES, requiredPreflightChecks: PREFLIGHT_CHECKS, caseDeadlineMs: CASE_DEADLINE_MS, cleanupDeadlineMs: CLEANUP_DEADLINE_MS, preflightDeadlineMs: CASE_DEADLINE_MS, ownership });");
    expect(code).toContain("const final = await lifecycle.finish({\n      deadlineMs: CLEANUP_DEADLINE_MS,");
    // Each of the four kinds of step that can wait on the database has exactly one deadline, and it is below the runner's.
    expect(live.match(/\}, VITEST_TIMEOUT_MS\);/g)).toHaveLength(4); // beforeAll, afterAll, the completeness check, the cleanup test
    expect(live.match(/, VITEST_TIMEOUT_MS\);/g)).toHaveLength(6); // ...and liveCase's it, and afterEach
    expect(live.match(/\b(it|beforeAll|afterAll|afterEach)\(/g)).toHaveLength(6);
    // The header tells the operator not to pass the older flags, and the documented command passes none.
    expect(source).toContain("Do NOT pass the\n * older smokes' 30000 ms flags.");
    expect(source).toContain(" *     pnpm exec vitest run test/lib/real/provider-budget.smoke.test.ts\n */");
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
    // The 13 mandatory look-alikes and the 11 further ones, each in a schema of its own.
    expect(MANDATORY_VARIANTS).toHaveLength(13);
    expect(FURTHER_VARIANTS).toHaveLength(11);
    const suffixes = [...MANDATORY_VARIANTS, ...FURTHER_VARIANTS].map((variant) => variant.suffix);
    expect(new Set(suffixes).size).toBe(24);
    // Nothing a case is named can trip the evidence content screen.
    for (const name of [...EXPECTED_CASES, ...PREFLIGHT_CHECKS]) expect(name).not.toMatch(/secret|password|token|credential|bearer|authorization|api[_-]?key|private[_-]?key|\bep-|pooler|postgres/i);
  });

  it("every database call goes through a lifecycle wrapper, and every budget request through the PRODUCTION limiter over the PRODUCTION store", () => {
    const calls = live.match(/\bdb\.q\(/g) ?? [];
    expect(calls.length).toBeGreaterThan(10);
    // Each one is the body of an arrow handed to a wrapper: read(...), lifecycle.write(...), or lifecycle.expectRefusal(...).
    expect(live.match(/\(\) =>\s*db\.q\(/g)).toHaveLength(calls.length);
    expect(live).not.toMatch(/await db\.q\(|db\.tx\(/);
    expect(code).toContain("store = stores.providerBudgets;");
    expect(code).toContain("limiter = createProviderBudgetLimiter(store);");
    expect(code.match(/limiter\.consume\(/g)).toHaveLength(1);
    expect(code).toContain("return () => limiter.consume({ subject, policies });");
    expect(code.match(/store\.consume\(/g)).toHaveLength(1); // case E1 only: the one deliberate bypass of the limiter's own bucket check
    expect(live.match(/lifecycle\.expectRefusal\([^\n]*\(\) => store\.consume\(/g)).toHaveLength(1);
    expect(code).not.toMatch(/createInMemory|InMemory/);
    // Requests are issued only through the tracked wrappers, never awaited bare, and never more than 16 at once.
    // A request is a thunk: it is built here and invoked ONLY by a lifecycle wrapper — never called or awaited directly.
    expect(live).not.toMatch(/await request\(|request\([^\n]*\)\(\)/);
    expect(BURST).toBe(16);
    expect(BURST).toBeLessThanOrEqual(MAX_CONCURRENCY);
    expect(code).toContain('if (requests.length > BURST) throw new Error("provider budget smoke: too many simultaneous budget requests");');
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
    expect(MIGRATION_SHA256).toMatch(/^[0-9a-f]{64}$/);
    const scratch = migrationBlockFor("pb_smoke_0a1b2c3d_apply");
    expect(scratch).toContain("target_schema CONSTANT pg_catalog.text := 'pb_smoke_0a1b2c3d_apply';");
    expect(scratch).not.toContain("'public'");
    expect(scratch.replace("'pb_smoke_0a1b2c3d_apply'", "'public'")).toBe(block);
    expect(scratch.length - block.length).toBe("pb_smoke_0a1b2c3d_apply".length - "public".length);
    for (const name of ["public", "pg_catalog", "pb_smoke_0a1b2c3d_a'; DROP", "PB_SMOKE_0a1b2c3d_a", "pb_smoke_0a1b2c3d_", "x"]) expect(() => migrationBlockFor(name), name).toThrow(/scratch schema/);
    // The block is the Slice 3A-0 one — never the Slice E block, and never the whole file.
    expect(block).toContain("table_name CONSTANT pg_catalog.text := 'real_provider_budgets';");
    expect(block).not.toMatch(/real_rate_limits|registration_|payment_attempts/);
    expect(code.match(/readFileSync\(/g)).toHaveLength(1);
    expect(code).not.toMatch(/search_path|SET LOCAL|set_config/);
    // `public` is written to by exactly one helper, which sends the unmodified block.
    expect(code.match(/db\.q\(migrationBlock\(\)\)/g)).toHaveLength(1);
    expect(code).toContain('const applyToPublic = (what: string) => lifecycle.write(what, () => db.q(migrationBlock()));');
  });

  it("it makes no provider call and writes nothing but its own scratch objects, the new table, and budget rows (static)", () => {
    const imports = [...source.matchAll(/^(?:import [^\n]*|\}) from "([^"]+)";$/gm)].map((match) => match[1]).sort();
    expect(imports).toEqual(["./fixtures/handles-smoke-db", "./fixtures/provider-budget-smoke", "./fixtures/provisioning-limits-smoke", "@/lib/real/server/rate-limit", "node:crypto", "node:fs", "vitest"].sort());
    expect(source).not.toMatch(/\bimport\(|\brequire\(/);
    // Needles are assembled from parts so this test's own text can't match them.
    for (const needle of ["turn" + "key", "pim" + "lico", "fet" + "ch(", "createRealSafe" + "Account", "prepareCash" + "Transfer", "/api/" + "real", "getProviderBudget" + "Limiter"]) expect(code.toLowerCase().replace(/turnkey_reconcile/g, ""), needle).not.toContain(needle.toLowerCase());
    for (const table of ["payment" + "_attempts", "real" + "_accounts", "real" + "_passkeys", "real_account" + "_handles", "registration" + "_attempts", "webauthn" + "_challenges"]) expect(code, table).not.toContain(table);
    // real_rate_limits is only ever READ (its fingerprint must not change).
    expect(code.match(/real_rate_limits/g)!.length).toBeGreaterThan(0);
    expect(code).not.toMatch(/(INTO|UPDATE|FROM|TABLE|ON)\s+(public\.)?real_rate_limits/i);
    // This file builds NO removal of any kind: every DELETE and DROP comes from the ownership-checked cleanup plan.
    for (const needle of ["DEL" + "ETE", "DR" + "OP ", "TRUNC" + "ATE", "CASC" + "ADE", " LI" + "KE ", "UPD" + "ATE "]) expect(code.toUpperCase(), needle).not.toContain(needle);
    // Every CREATE / ALTER / INSERT it sends names a scratch schema variable — never `public`, never an unqualified name.
    const ddl = [...code.matchAll(/\b(CREATE (?:TABLE|VIEW|INDEX|FUNCTION|TRIGGER|SCHEMA)|ALTER TABLE|INSERT INTO)\b([^`"\n]{0,120})/g)].map((match) => `${match[1]}${match[2]}`);
    expect(ddl.length).toBeGreaterThan(15);
    for (const statement of ddl) expect(statement, statement).toMatch(/^(CREATE SCHEMA \$\{schema\}|CREATE (TABLE|VIEW|FUNCTION) \$\{(s|schema)\}\.|CREATE INDEX pb_extra_idx ON \$\{s\}\.|CREATE TRIGGER pb_trigger BEFORE INSERT ON \$\{s\}\.|ALTER TABLE \$\{s\}\.|INSERT INTO \$\{(schema|applied)\}\.)/);
    // Scratch objects reference only their own schema: no REFERENCES, INHERITS, or EXECUTE FUNCTION target outside `${s}.`.
    for (const [, target] of code.matchAll(/\b(?:REFERENCES|INHERITS \(|EXECUTE FUNCTION) ?([^ (]+)/g)) expect(target, target).toMatch(/^\$\{s\}\./);
    // Its only file write is the evidence, through the fixture's writer, in the fixed git-ignored directory.
    expect(code.match(/writeFileSync|mkdirSync|appendFileSync|createWriteStream/g)).toBeNull();
    expect(code.match(/writeProviderBudgetEvidence\(/g)).toHaveLength(2);
    expect(code).toContain('const EVIDENCE_DIRECTORY = "evidence";');
    expect(readFileSync(".gitignore", "utf8")).toMatch(/^\/evidence\/$/m);
  });

  it("the end of the run: one cleanup through the lifecycle, a tracked comparison, both evidence records, and a verdict that needs all of it", () => {
    expect(code.match(/lifecycle\.runFinalCleanup\(db\)/g)).toHaveLength(1);
    expect(code).toContain("  afterEach((context) => lifecycle.afterCase({ reportedFailed: caseFailedInVitest(context) }), VITEST_TIMEOUT_MS);");
    expect(code.match(/afterEach\(/g)).toHaveLength(1);
    const end = /\n  afterAll\(async \(\) => \{\n([\s\S]*?)\n  \}, VITEST_TIMEOUT_MS\);/.exec(code)?.[1] ?? "";
    expect(end.trimStart().startsWith("if (!started) return;")).toBe(true);
    expect(end).toContain("after = await snapshot(read);");
    expect(end).toContain('const providerTable = await describeTable(read, "public");');
    expect(end).toContain("return compareWithExpectedDelta({ before: baseline, after, providerTable, ownedSchemas: ownership.ownedSchemas() });");
    // After the lifecycle has finished, the hook touches the database through nothing at all.
    expect(end).not.toMatch(/lifecycle\.(read|write|consume|consumeBurst|expectRefusal|runFinalCleanup)\b|db\.q\(/);
    expect(end).toContain('const finalSaved = writeProviderBudgetEvidence({ directory: EVIDENCE_DIRECTORY, runId, stage: "final", evidence });');
    expect(end).toContain("const verdict = concludeProviderBudgetRun(final, { start: startSaved, final: finalSaved });");
    expect(end.trimEnd().endsWith("if (!verdict.pass) throw new Error(verdict.message);")).toBe(true);
    expect(end).toMatch(/console\.log\(`\[provider-budget-smoke\] \$\{safeEvidenceJson\(/);
    expect(code.match(/console\.log\(/g)).toHaveLength(2);
    expect(code.match(/afterAll\(/g)).toHaveLength(1);
  });

  it("the header records the one live run (6d32fdf8, 2026-10-13, 32 passed / 0 skipped, COMPLETED_CLEAN, baseline_plus_expected_delta), says the file was edited since, forbids reusing that branch, and still documents the opt-in and the confirmed-target variables", () => {
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
    // The one live run, by its identifying facts and its outcome.
    expect(header).toContain("ONE CONTROLLED LIVE RUN HAS COMPLETED. Run 6d32fdf8, 2026-10-13:");
    expect(header).toContain("PostgreSQL 18.6");
    expect(header).toContain("Vitest: 32 passed, 0 skipped, 0 failed, exit code 0");
    expect(header).toContain("All 20 live cases ran");
    expect(header).toContain("the lifecycle ended COMPLETED_CLEAN");
    expect(header).toContain("the database verdict was baseline_plus_expected_delta");
    // It does not claim to be the file that ran, and says what was edited since and where.
    expect(header).toContain("THIS FILE IS NOT BYTE-IDENTICAL TO THE ONE THAT RAN, whose SHA-256 was e8c9acf91656ecdcb1a66b2bb5e110642e9b16953102e3d6d2d2122d86a3ff8b.");
    expect(header).toContain("edited twice afterwards, in OFFLINE, ungated code only");
    expect(header).toContain("The live describe block (every case body, gate, hook, cleanup, and database operation) is unchanged.");
    // The branch is spent.
    expect(header).toContain("THAT BRANCH MUST NEVER BE REUSED");
    expect(header).toContain("which the run requires to be absent");
    expect(header).toContain("requires separate authorization and a FRESH disposable branch");
    // The pre-run claim is gone: it is no longer true, and must not come back.
    expect(source).not.toContain("IT HAS NEVER BEEN " + "RUN LIVE.");
    expect(source).not.toContain("ITS FIRST AUTHORIZED LIVE RUN HAS " + "COMPLETED (");
    // Unchanged, meaningful safety wording.
    expect(source).toContain("EXPLICITLY OPT-IN, AND NOT RUN as part of the build");
    expect(source).toContain("requires separate authorization and a FRESH disposable\n * branch");
    expect(source).toContain("It must NEVER\n * be pointed at the real database.");
    expect(source).toContain('NEON_BRANCH_EXPECTED_ENDPOINT_ID="ep-..."');
    expect(source).toContain("Milestone 0 Pass B: the run also requires NEON_BRANCH_EXPECTED_ENDPOINT_ID");
    expect(source).toContain("It is never reported as \"restored\".");
    expect([...PROVIDER_BUDGET_BUCKETS]).toHaveLength(6);
  });
});

describe.skipIf(!enabled)("provider budgets — schema block and real concurrency (DISPOSABLE BRANCH ONLY)", () => {
  const runId = randomUUID().replace(/-/g, "").slice(0, 8);
  const ownership = createRunOwnership(runId);
  const lifecycle = createProviderBudgetLifecycle({ expectedCases: EXPECTED_CASES, requiredPreflightChecks: PREFLIGHT_CHECKS, caseDeadlineMs: CASE_DEADLINE_MS, cleanupDeadlineMs: CLEANUP_DEADLINE_MS, preflightDeadlineMs: CASE_DEADLINE_MS, ownership });
  let db: SmokeDb;
  let store: ProviderBudgetStore;
  let limiter: ProviderBudgetLimiter;
  /** True from the moment a connector is about to be built: only then is there anything to report at the end. */
  let started = false;
  let baseline: DatabaseSnapshot | null = null;
  let startSaved: EvidenceWrite = { ok: false, reason: "write_failed", code: null };
  const facts: Record<string, unknown> = { connectionMode: null, server: null };
  const caseNotes: Record<string, unknown> = {};
  /** The scratch schema case S2 applies the block in; S3 inserts against it. */
  let applied = "";

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const one = (rows: SmokeRow[]): SmokeRow => {
    if (rows.length !== 1) throw new Error(`provider budget smoke: expected exactly one row, got ${rows.length}`);
    return rows[0]!;
  };
  const write = (what: string, text: string, params: unknown[] = []) => lifecycle.write(what, () => db.q(text, params));
  const refused = (what: string, text: string, sqlStates: readonly string[], params: unknown[] = []) => lifecycle.expectRefusal(what, () => db.q(text, params), sqlStates);
  const applyToPublic = (what: string) => lifecycle.write(what, () => db.q(migrationBlock()));

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

  /** Read-only: `<schema>.real_provider_budgets` in the shape the expected-delta comparison takes. `schema` is `public` or a schema this run owns. */
  async function describeTable(read: TrackedRead, schema: string): Promise<ProviderTableDescriptor> {
    if (schema !== "public") ownership.assertOwnedSchema(schema);
    const at = [schema, "real_provider_budgets"];
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
    const rows = one(await read("counting the table's rows", () => db.q(`SELECT count(*)::int AS n FROM ${schema === "public" ? "public" : assertPlainIdentifier(schema)}.real_provider_budgets`)));
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

  /** One budget request through the production limiter, for a subject this run owns. Built here, issued only by a lifecycle wrapper. */
  const request = (subject: string, policies: readonly ProviderBudgetPolicy[]) => {
    ownership.assertOwnedSubject(subject);
    return () => limiter.consume({ subject, policies });
  };
  /** Several requests issued TOGETHER and awaited to the last one. Returns every outcome, in order. */
  const together = (what: string, requests: ReadonlyArray<() => Promise<unknown>>) => {
    if (requests.length > BURST) throw new Error("provider budget smoke: too many simultaneous budget requests");
    return lifecycle.consumeBurst(what, requests);
  };
  const admittedCount = (outcomes: readonly ConsumeOutcome[]) => outcomes.filter((outcome) => outcome.kind === "admitted").length;
  /** A subject's rows as the database holds them: hits and window start, by bucket. */
  const rowsOf = async (subject: string) => {
    ownership.assertOwnedSubject(subject);
    const rows = await lifecycle.read("reading a subject's budget rows", () => db.q('SELECT bucket::text AS bucket, hits, window_start::text AS window_start FROM public.real_provider_budgets WHERE subject = $1 ORDER BY bucket COLLATE "C"', [subject]));
    return { hits: Object.fromEntries(rows.map((row) => [String(row.bucket), row.hits as number])), windowStart: Object.fromEntries(rows.map((row) => [String(row.bucket), String(row.window_start)])) };
  };
  /** A denial's wait, checked against the window that must have caused it. One second of slack: a request that waited on a row can see a window opened just after its own clock reading. */
  const expectDenied = (outcome: ConsumeOutcome, bounds: { above: number; atMost: number }) => {
    if (outcome.kind !== "denied") throw new Error(`provider budget smoke: expected a denial, got ${outcome.kind}`);
    expect(outcome.retryAfterSeconds).toBeGreaterThan(bounds.above);
    expect(outcome.retryAfterSeconds).toBeLessThanOrEqual(bounds.atMost + 1);
  };

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
    const before = await shapeDigest(lifecycle.read, schema, "real_provider_budgets");
    const refusal = await refused(`the block against a look-alike (${variant.what})`, migrationBlockFor(schema), ["P0001"]);
    expect(await shapeDigest(lifecycle.read, schema, "real_provider_budgets"), variant.what).toBe(before);
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
    if (!mode.ok) throw new Error(`Provider budget smoke refused before any database work: ${mode.reason}`);
    const selection = checkProviderBudgetFileSelection(inject("vitestCliArgs"));
    if (!selection.ok) throw new Error(`Provider budget smoke refused before any database work: ${selection.reason}`);
    const timeouts = checkRunnerTimeoutFlags(inject("vitestCliArgs"));
    if (!timeouts.ok) throw new Error(`Provider budget smoke refused before any database work: ${timeouts.reason}`);
    // Every refusal is behind us. The label only — never the connection string.
    console.log(`[provider-budget-smoke] connection_mode: ${mode.mode}`);
    started = true;
    db = await connectSmokeDb(url);
    const stores = await connectSmokeStores(url);
    store = stores.providerBudgets;
    limiter = createProviderBudgetLimiter(store);
    facts.connectionMode = mode.mode;

    // Everything in the preflight is READ-ONLY, tracked, and under one deadline; the run is armed only at its very end.
    await lifecycle.runPreflight(async () => {
      const server = one(await lifecycle.read("reading the server's identity", () => db.q("SELECT pg_catalog.current_database()::text AS database, pg_catalog.current_setting('server_version') AS version, pg_catalog.current_setting('default_transaction_isolation') AS isolation, pg_catalog.pg_is_in_recovery() AS in_recovery, pg_catalog.current_schema()::text AS current_schema")));
      facts.server = { database: server.database, version: server.version, defaultIsolation: server.isolation, inRecovery: server.in_recovery };
      lifecycle.preflightCheck("the connected database is the one the confirmed URL names", server.database === new URL(url).pathname.slice(1));
      lifecycle.preflightCheck("the target is not a read replica", server.in_recovery === false);
      lifecycle.preflightCheck("unqualified names resolve to public", server.current_schema === "public");
      const sameName = one(await lifecycle.read("looking for an existing provider-budget relation", () => db.q("SELECT count(*)::int AS n FROM pg_catalog.pg_class c WHERE c.relname = 'real_provider_budgets'")));
      lifecycle.preflightCheck("no relation named real_provider_budgets exists in any schema", sameName.n === 0);
      baseline = await snapshot(lifecycle.read);
      lifecycle.preflightCheck("public.real_rate_limits exists", Object.hasOwn(baseline.tables, "real_rate_limits"));
      lifecycle.preflightCheck("no provider-budget scratch schema exists", !baseline.schemas.some((name) => name.startsWith("pb_smoke_")));
      // The START record is saved before anything may be written: without it the run cannot be armed.
      const startEvidence = { runId, server: facts.server, connectionMode: facts.connectionMode, migrationStatementSha256: MIGRATION_SHA256, expectedCases: [...EXPECTED_CASES], fingerprintsBefore: baseline };
      startSaved = writeProviderBudgetEvidence({ directory: EVIDENCE_DIRECTORY, runId, stage: "start", evidence: startEvidence });
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
        const providerTable = await describeTable(read, "public");
        return compareWithExpectedDelta({ before: baseline, after, providerTable, ownedSchemas: ownership.ownedSchemas() });
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
      cleanup: final.cleanup,
      fingerprintsBefore: baseline,
      fingerprintsAfter: after,
      expectedDelta: final.delta,
      unknownOperations: final.unknownOperations,
      inFlightOperations: final.inFlightOperations,
      verdict: final.verdict,
      poisoned: final.poisoned,
      operationsIssued: final.operationsIssued,
      ownedSubjects: final.ownedSubjects,
      ownedSchemas: final.ownedSchemas,
      caseNotes,
      startEvidence: startSaved.ok ? "saved" : startSaved.reason,
      action: final.action,
    };
    const finalSaved = writeProviderBudgetEvidence({ directory: EVIDENCE_DIRECTORY, runId, stage: "final", evidence });
    const verdict = concludeProviderBudgetRun(final, { start: startSaved, final: finalSaved });
    console.log(`[provider-budget-smoke] ${safeEvidenceJson({ ...evidence, finalEvidence: finalSaved.ok ? "saved" : finalSaved.reason, runVerdict: verdict.verdict }) ?? '{"evidence":"withheld: it failed the content check"}'}`);
    // Fails for a poisoned run, a delta mismatch, AND a clean run whose evidence could not be saved. Nothing else happens here.
    if (!verdict.pass) throw new Error(verdict.message);
  }, VITEST_TIMEOUT_MS);

  // ---------------------------------------------------------------- S: the schema block

  liveCase("S1. missing table: the production limiter fails closed before the block is applied", async () => {
    const subject = ownership.registerSubject("s1");
    // 42P01 = undefined_table. The limiter throws; it never answers "allowed".
    const refusal = await lifecycle.expectRefusal("a budget request with no table", request(subject, family("chain_read", 5, 50)), ["42P01"]);
    caseNotes.s1 = refusal;
  });

  liveCase("S2. scratch schema: first apply, idempotent rerun, rerun with a row, exact catalog descriptor", async () => {
    const schema = ownership.registerScratchSchema("apply");
    await write("creating a scratch schema", `CREATE SCHEMA ${schema}`);
    ownership.registerScratchObject(schema, "table", "real_provider_budgets");
    await write("the block's first apply in a scratch schema", migrationBlockFor(schema));
    expect(await describeTable(lifecycle.read, schema)).toEqual(EXPECTED_PROVIDER_TABLE);
    const shape = await shapeDigest(lifecycle.read, schema, "real_provider_budgets");
    await write("the block's rerun in a scratch schema", migrationBlockFor(schema));
    await write("a row in the scratch table", `INSERT INTO ${schema}.real_provider_budgets (bucket, subject, window_start, hits) VALUES ('chain_read_day', 'scratch-row', pg_catalog.now(), 1)`);
    await write("the block's rerun over existing data", migrationBlockFor(schema));
    expect(await describeTable(lifecycle.read, schema)).toEqual({ ...EXPECTED_PROVIDER_TABLE, rows: 1 });
    expect(await shapeDigest(lifecycle.read, schema, "real_provider_budgets")).toBe(shape);
    applied = schema;
  });

  liveCase("S3. scratch schema: the bucket CHECK, the hits CHECK, the primary key, and NOT NULL are enforced", async () => {
    ownership.assertOwnedSchema(applied);
    const insert = (values: string) => `INSERT INTO ${applied}.real_provider_budgets (bucket, subject, window_start, hits) VALUES (${values})`;
    const now = "pg_catalog.now()";
    // 23514 = check_violation, 23505 = unique_violation, 23502 = not_null_violation.
    for (const bucket of ["not_a_bucket", "CHAIN_READ_SHORT", "chain_read", "pay_prepare_day", "recipient_probe_short", ""]) {
      expect((await refused("a row with a bucket outside the six", insert(`'${bucket}', 's', ${now}, 1`), ["23514"])).constraint, bucket).toBe("real_provider_budgets_bucket_check");
    }
    expect((await refused("a row with zero hits", insert(`'chain_read_short', 's', ${now}, 0`), ["23514"])).constraint).toBe("real_provider_budgets_hits_check");
    expect((await refused("a duplicate (bucket, subject)", insert(`'chain_read_day', 'scratch-row', ${now}, 1`), ["23505"])).constraint).toBe("real_provider_budgets_pkey");
    await refused("a row with no window start (there is no default)", `INSERT INTO ${applied}.real_provider_budgets (bucket, subject, hits) VALUES ('chain_read_short', 's', 1)`, ["23502"]);
    await refused("a row with no hits (there is no default)", `INSERT INTO ${applied}.real_provider_budgets (bucket, subject, window_start) VALUES ('chain_read_short', 's', ${now})`, ["23502"]);
    // Each of the six buckets is accepted.
    for (const bucket of PROVIDER_BUDGET_BUCKETS) await write("a row in each of the six buckets", insert(`'${bucket}', 'six', ${now}, 1`));
    expect((await describeTable(lifecycle.read, applied)).rows).toBe(7);
  });

  liveCase("S4. scratch schemas: an exact hand-built copy is accepted, and the 13 mandatory look-alikes are refused and left unchanged", async () => {
    // The control: the same parts, unchanged, are the intended table — so every variant below differs from it in exactly one way.
    const control = await buildVariant({ suffix: "control", what: "an exact hand-built copy", steps: (s) => [lookAlike(tableDdl(s, exact()))] });
    await write("the block against an exact hand-built copy", migrationBlockFor(control));
    expect(await describeTable(lifecycle.read, control)).toEqual(EXPECTED_PROVIDER_TABLE);
    const refusals: Record<string, string> = {};
    for (const variant of MANDATORY_VARIANTS) refusals[variant.suffix] = await refusesAndLeavesUnchanged(variant);
    expect(Object.keys(refusals)).toHaveLength(13);
    caseNotes.s4 = refusals;
  });

  liveCase("S5. scratch schemas: 11 further look-alikes are refused and left unchanged", async () => {
    const refusals: Record<string, string> = {};
    for (const variant of FURTHER_VARIANTS) refusals[variant.suffix] = await refusesAndLeavesUnchanged(variant);
    expect(Object.keys(refusals)).toHaveLength(11);
    caseNotes.s5 = refusals;
  });

  liveCase("S6. a target schema that does not exist is refused, and is not created", async () => {
    // Of this run's shape, but deliberately never registered and never created: the block must not create it.
    const absent = `pb_smoke_${runId}_absent`;
    await refused("the block against a schema that does not exist", migrationBlockFor(absent), ["P0001"]);
    const found = one(await lifecycle.read("looking for the schema the block was refused", () => db.q("SELECT count(*)::int AS n FROM pg_catalog.pg_namespace WHERE nspname = $1", [absent])));
    expect(found.n).toBe(0);
  });

  liveCase("S7. public: the exact block applies once, reruns idempotently, and matches the expected descriptor", async () => {
    // The ONLY writes to `public` in the whole run besides budget rows: the unmodified block, twice.
    await applyToPublic("the block's first apply in public");
    expect(await describeTable(lifecycle.read, "public")).toEqual(EXPECTED_PROVIDER_TABLE);
    const shape = await shapeDigest(lifecycle.read, "public", "real_provider_budgets");
    await applyToPublic("the block's rerun in public");
    expect(await describeTable(lifecycle.read, "public")).toEqual(EXPECTED_PROVIDER_TABLE);
    expect(await shapeDigest(lifecycle.read, "public", "real_provider_budgets")).toBe(shape);
    // The production statement names the table without a schema: it must resolve to the one just created.
    const resolved = one(await lifecycle.read("resolving the unqualified table name", () => db.q("SELECT (pg_catalog.to_regclass('real_provider_budgets') IS NOT NULL AND pg_catalog.to_regclass('real_provider_budgets') = pg_catalog.to_regclass('public.real_provider_budgets')) AS same")));
    expect(resolved.same).toBe(true);
    // The Slice E table was not touched by any of it.
    expect(await shapeDigest(lifecycle.read, "public", "real_rate_limits")).toBe(baseline!.tables.real_rate_limits!.shapeDigest);
  });

  // ---------------------------------------------------------------- G: the production limiter over the production store

  liveCase("G1. exactly-at-limit admission, then one denial", async () => {
    const subject = ownership.registerSubject("g1");
    const policies = family("chain_read", 3, 50);
    for (let i = 0; i < 3; i += 1) expect((await lifecycle.consume("a budget request", request(subject, policies))).kind, `request ${i + 1}`).toBe("admitted");
    expect((await rowsOf(subject)).hits).toEqual({ chain_read_day: 3, chain_read_short: 3 });
    expectDenied(await lifecycle.consume("a budget request", request(subject, policies)), { above: 0, atMost: SHORT_S });
    // The denied request was still charged to both buckets.
    expect((await rowsOf(subject)).hits).toEqual({ chain_read_day: 4, chain_read_short: 4 });
  });

  liveCase("G2. 16 concurrent requests on one family: exactly the limit is admitted", async () => {
    const subject = ownership.registerSubject("g2");
    const policies = family("pay_submit", 5, 100);
    const outcomes = await together("16 simultaneous requests", Array.from({ length: BURST }, () => request(subject, policies)));
    expect(tallyOutcomes(outcomes)).toEqual({ admitted: 5, denied: 11 });
    // The short count stopped at limit + 1; the daily one counted every request.
    expect((await rowsOf(subject)).hits).toEqual({ pay_submit_day: 16, pay_submit_short: 6 });
    caseNotes.g2 = tallyOutcomes(outcomes);
  });

  liveCase("G3. daily exhaustion, independent of the short-window capacity", async () => {
    const subject = ownership.registerSubject("g3");
    const policies = family("turnkey_reconcile", 10, 3);
    for (let i = 0; i < 3; i += 1) expect((await lifecycle.consume("a budget request", request(subject, policies))).kind).toBe("admitted");
    // The short bucket has room (4 of 10): only the daily one is exceeded, so the wait is the day's.
    expectDenied(await lifecycle.consume("a budget request", request(subject, policies)), { above: SHORT_S + 1, atMost: DAY_S });
    expect((await rowsOf(subject)).hits).toEqual({ turnkey_reconcile_day: 4, turnkey_reconcile_short: 4 });
  });

  liveCase("G4. both windows exhausted: the longest wait decides", async () => {
    const subject = ownership.registerSubject("g4");
    const policies = family("chain_read", 2, 2);
    for (let i = 0; i < 2; i += 1) expect((await lifecycle.consume("a budget request", request(subject, policies))).kind).toBe("admitted");
    expectDenied(await lifecycle.consume("a budget request", request(subject, policies)), { above: SHORT_S + 1, atMost: DAY_S });
    expect((await rowsOf(subject)).hits).toEqual({ chain_read_day: 3, chain_read_short: 3 });
  });

  liveCase("G5. window expiry by the database clock", async () => {
    const subject = ownership.registerSubject("g5");
    const WINDOW_S = 4; // a real, short TEST window: nothing is re-dated
    const policies = family("pay_submit", 2, 50, WINDOW_S, 3_600);
    for (let i = 0; i < 2; i += 1) expect((await lifecycle.consume("a budget request", request(subject, policies))).kind).toBe("admitted");
    expectDenied(await lifecycle.consume("a budget request", request(subject, policies)), { above: 0, atMost: WINDOW_S });
    const opened = await rowsOf(subject);
    // Wait until the DATABASE says the short window has elapsed. Bounded; running out is a failure, never a pass.
    let elapsed = false;
    for (let i = 0; i < 30 && !elapsed; i += 1) {
      await sleep(500);
      elapsed = one(await lifecycle.read("asking the database whether the window has elapsed", () => db.q("SELECT (window_start + pg_catalog.make_interval(secs => $3::int) <= pg_catalog.now()) AS elapsed FROM public.real_provider_budgets WHERE subject = $1 AND bucket = $2", [subject, "pay_submit_short", WINDOW_S]))).elapsed === true;
    }
    if (!elapsed) throw new Error("provider budget smoke: the short window never elapsed by the database clock within the bound. Not retried.");
    expect((await lifecycle.consume("the first request after the window", request(subject, policies))).kind).toBe("admitted");
    const reopened = await rowsOf(subject);
    // The short window reopened at 1 with a NEW start; the long one kept counting from its own first request.
    expect(reopened.hits).toEqual({ pay_submit_day: 4, pay_submit_short: 1 });
    expect(reopened.windowStart.pay_submit_short).not.toBe(opened.windowStart.pay_submit_short);
    expect(reopened.windowStart.pay_submit_day).toBe(opened.windowStart.pay_submit_day);
  });

  liveCase("G6. repeated denials do not extend the window", async () => {
    const subject = ownership.registerSubject("g6");
    const policies = family("chain_read", 1, 100);
    expect((await lifecycle.consume("a budget request", request(subject, policies))).kind).toBe("admitted");
    const opened = await rowsOf(subject);
    for (let i = 0; i < 4; i += 1) expectDenied(await lifecycle.consume("a denied request", request(subject, policies)), { above: 0, atMost: SHORT_S });
    const outcomes = await together("eight simultaneous denied requests", Array.from({ length: 8 }, () => request(subject, policies)));
    expect(tallyOutcomes(outcomes)).toEqual({ denied: 8 });
    const after = await rowsOf(subject);
    expect(after.windowStart).toEqual(opened.windowStart);
    expect(after.hits).toEqual({ chain_read_day: 13, chain_read_short: 2 });
  });

  liveCase("G7. counters saturate at limit + 1", async () => {
    const subject = ownership.registerSubject("g7");
    const policies = family("turnkey_reconcile", 2, 3);
    const outcomes = await together("twelve simultaneous requests", Array.from({ length: 12 }, () => request(subject, policies)));
    expect(tallyOutcomes(outcomes)).toEqual({ admitted: 2, denied: 10 });
    expect((await rowsOf(subject)).hits).toEqual({ turnkey_reconcile_day: 4, turnkey_reconcile_short: 3 });
    // Still capped after more.
    expect(tallyOutcomes(await together("eight more", Array.from({ length: 8 }, () => request(subject, policies))))).toEqual({ denied: 8 });
    expect((await rowsOf(subject)).hits).toEqual({ turnkey_reconcile_day: 4, turnkey_reconcile_short: 3 });
  });

  liveCase("G8. two subjects competing at once are independent", async () => {
    const subjects = [ownership.registerSubject("g8-a"), ownership.registerSubject("g8-b")];
    const policies = family("chain_read", 3, 100);
    const outcomes = await together("two subjects, eight requests each, all at once", Array.from({ length: BURST }, (_, i) => request(subjects[i % 2]!, policies)));
    expect(admittedCount(outcomes.filter((_, i) => i % 2 === 0))).toBe(3);
    expect(admittedCount(outcomes.filter((_, i) => i % 2 === 1))).toBe(3);
    for (const subject of subjects) expect((await rowsOf(subject)).hits).toEqual({ chain_read_day: 8, chain_read_short: 4 });
  });

  liveCase("G9. overlapping 2-, 4- and 6-bucket sets in mixed caller order", async () => {
    const subject = ownership.registerSubject("g9");
    const HIGH = 1_000; // far above anything this case sends: every count below is exact, not capped
    const two = family("chain_read", HIGH, HIGH);
    const four = [...two, ...family("pay_submit", HIGH, HIGH)];
    const six = [...four, ...family("turnkey_reconcile", HIGH, HIGH)];
    for (let round = 0; round < 2; round += 1) {
      // Five of each set, interleaved, every other one listed in reverse: only the limiter's own sort keeps the lock order consistent.
      const outcomes = await together(
        "fifteen simultaneous requests over overlapping bucket sets",
        Array.from({ length: 15 }, (_, i) => {
          const set = [two, four, six][i % 3]!;
          return request(subject, i % 2 === 0 ? set : [...set].reverse());
        }),
      );
      expect(tallyOutcomes(outcomes), `round ${round}`).toEqual({ admitted: 15 }); // a deadlock (40P01) would have poisoned the run
    }
    // One decision per request: each shared row was charged exactly once by every request that named it.
    expect((await rowsOf(subject)).hits).toEqual({ chain_read_day: 30, chain_read_short: 30, pay_submit_day: 20, pay_submit_short: 20, turnkey_reconcile_day: 10, turnkey_reconcile_short: 10 });
  });

  liveCase("G10. overlapping four-bucket combinations across families", async () => {
    const subject = ownership.registerSubject("g10");
    const HIGH = 1_000;
    const chain = family("chain_read", HIGH, HIGH);
    const pay = family("pay_submit", 6, HIGH); // the one tight budget
    const reconcile = family("turnkey_reconcile", HIGH, HIGH);
    const combinations = [[...chain, ...pay], [...pay, ...reconcile], [...chain, ...reconcile]];
    const outcomes = await together(
      "fifteen simultaneous requests over three four-bucket combinations",
      Array.from({ length: 15 }, (_, i) => {
        const set = combinations[i % 3]!;
        return request(subject, i % 2 === 0 ? set : [...set].reverse());
      }),
    );
    // Ten requests name pay_submit and exactly six of them are admitted; the five that do not are all admitted.
    expect(admittedCount(outcomes.filter((_, i) => i % 3 === 2))).toBe(5);
    expect(admittedCount(outcomes.filter((_, i) => i % 3 !== 2))).toBe(6);
    expect(tallyOutcomes(outcomes)).toEqual({ admitted: 11, denied: 4 });
    // A denied request was still charged to every bucket it named.
    expect((await rowsOf(subject)).hits).toEqual({ chain_read_day: 10, chain_read_short: 10, pay_submit_day: 10, pay_submit_short: 7, turnkey_reconcile_day: 10, turnkey_reconcile_short: 10 });
  });

  // ---------------------------------------------------------------- E: errors the database itself must answer

  liveCase("E1. a foreign bucket is refused by the CHECK and the whole multi-bucket statement rolls back", async () => {
    const subject = ownership.registerSubject("e1");
    for (const foreign of ["not_a_bucket", "pay_prepare_day"]) {
      // The store, called directly, so the limiter's own bucket check cannot refuse first: the CHECK must.
      const refusal = await lifecycle.expectRefusal("a statement naming a bucket outside the six", () => store.consume({ subject, policies: [P("chain_read_day", 5, DAY_S), P("chain_read_short", 5, SHORT_S), { bucket: foreign, limit: 5, windowSeconds: SHORT_S }] as never }), ["23514"]);
      expect(refusal.constraint, foreign).toBe("real_provider_budgets_bucket_check");
      // One statement, so the two valid rows were not charged either.
      expect((await rowsOf(subject)).hits, foreign).toEqual({});
    }
  });

  liveCase("E2. an oversized window is refused and nothing is charged", async () => {
    const subject = ownership.registerSubject("e2");
    // 22003 = numeric_value_out_of_range: the window does not fit the statement's integer cast.
    await lifecycle.expectRefusal("a budget request whose window exceeds an integer", request(subject, family("chain_read", 5, 50, SHORT_S, 3_000_000_000)), ["22003"]);
    expect((await rowsOf(subject)).hits).toEqual({});
  });

  liveCase("E3. an oversized limit: the first request is charged, the next is refused, and the rows are unchanged", async () => {
    const subject = ownership.registerSubject("e3");
    const policies = family("pay_submit", 2_147_483_647, 5);
    expect((await lifecycle.consume("the first request", request(subject, policies))).kind).toBe("admitted");
    const charged = await rowsOf(subject);
    expect(charged.hits).toEqual({ pay_submit_day: 1, pay_submit_short: 1 });
    // The second request computes limit + 1 for the existing row, which overflows: the statement fails as a whole (fail closed).
    await lifecycle.expectRefusal("a second request under a limit of the largest integer", request(subject, policies), ["22003"]);
    expect(await rowsOf(subject)).toEqual(charged);
  });

  // ---------------------------------------------------------------- the end

  it("every decisive case ran, exactly once, in order", () => {
    expect(lifecycle.poisoned()).toBeNull();
    expect(lifecycle.inFlightOperations()).toEqual([]);
    expect(lifecycle.executed()).toEqual([...EXPECTED_CASES]);
  }, VITEST_TIMEOUT_MS);

  it("Z. the final cleanup removes exactly what this run registered", async () => {
    // Sends something only if every case above completed cleanly; otherwise it records why nothing was sent.
    await lifecycle.runFinalCleanup(db);
    expect(lifecycle.poisoned()).toBeNull();
    expect(lifecycle.state()).toBe("CLEANUP");
  }, VITEST_TIMEOUT_MS);
});
