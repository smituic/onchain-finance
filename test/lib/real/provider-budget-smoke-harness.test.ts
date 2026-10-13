// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PROVIDER_BUDGET_BUCKETS } from "@/lib/real/server/rate-limit";
import { createFakeBudgetDb, type FakeBehavior } from "./fixtures/provider-budget-fake-db";
import {
  CASE_DEADLINE_MS,
  CLEANUP_DEADLINE_MS,
  DELETE_SUBJECT_SQL,
  EXPECTED_PROVIDER_TABLE,
  FINAL_EVIDENCE_FIELDS,
  MAX_CONCURRENCY,
  MAX_RUN_OPERATIONS,
  MAX_RUN_SCRATCH_OBJECTS,
  MAX_RUN_SCRATCH_SCHEMAS,
  MAX_RUN_SUBJECTS,
  PROVIDER_BUDGET_SMOKE_FILE,
  SCHEMA_EXTERNAL_DEPENDENCIES_SQL,
  SCHEMA_INVENTORY_SQL,
  SCHEMA_RESIDUE_SQL,
  SUBJECT_RESIDUE_SQL,
  VITEST_TIMEOUT_MS,
  admitScratchSchemaCleanup,
  checkProviderBudgetFileSelection,
  checkRunnerTimeoutFlags,
  classifyConsume,
  compareWithExpectedDelta,
  concludeProviderBudgetRun,
  createProviderBudgetLifecycle,
  createRunOwnership,
  dropObjectStatement,
  dropSchemaStatement,
  missingEvidenceFields,
  parseExternalRow,
  parseInventoryRows,
  planCleanup,
  sha256Hex,
  summarizeCleanup,
  tallyOutcomes,
  writeProviderBudgetEvidence,
  type DatabaseSnapshot,
  type EvidenceWrite,
  type FinalReport,
  type ProviderTableDescriptor,
} from "./fixtures/provider-budget-smoke";

/**
 * OFFLINE proof of the provider-budget smoke's safety foundation (harness
 * Stage 1): ownership, outcome classification, the run lifecycle, the final
 * cleanup, the expected-delta comparison, and the evidence files — over an
 * in-memory stand-in. No database, no network, no provider.
 *
 * NOT PROVEN HERE: anything about PostgreSQL (the fixture's SQL texts have
 * never been executed), and how the lifecycle behaves when the real test
 * runner abandons a test or a hook at ITS timeout — that needs a child-process
 * probe, which belongs to Stage 2. Deadlines below are the lifecycle's own,
 * scaled down to milliseconds.
 */
const RUN = "0a1b2c3d";
const CASES = ["one", "two", "three"] as const;
const CHECKS = ["the target is not a replica", "the provider table is absent"] as const;
const SAVED: EvidenceWrite = { ok: true, file: "saved" };
const NOT_SAVED: EvidenceWrite = { ok: false, reason: "write_failed", code: null };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const admitted = async () => ({ allowed: true });
const denied = async () => ({ allowed: false, retryAfterSeconds: 7 });
const sqlError = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(`database said ${code}`), { code, ...extra });

const fingerprint = (seed: string, rows = 3) => ({ rows, contentDigest: `content-${seed}`, shapeDigest: `shape-${seed}` });
const BEFORE: DatabaseSnapshot = { tables: { real_accounts: fingerprint("accounts"), real_rate_limits: fingerprint("limits", 0), payment_attempts: fingerprint("payments", 20) }, schemas: ["public"] };
const AFTER: DatabaseSnapshot = { tables: { ...BEFORE.tables, real_provider_budgets: { rows: 0, contentDigest: "", shapeDigest: "shape-new" } }, schemas: ["public"] };
const goodDelta = (ownedSchemas: readonly string[] = []) => compareWithExpectedDelta({ before: BEFORE, after: AFTER, providerTable: EXPECTED_PROVIDER_TABLE, ownedSchemas });

function setup(deadlines: { caseDeadlineMs?: number; cleanupDeadlineMs?: number; preflightDeadlineMs?: number } = {}) {
  const ownership = createRunOwnership(RUN);
  const fake = createFakeBudgetDb();
  const lifecycle = createProviderBudgetLifecycle({ expectedCases: CASES, requiredPreflightChecks: CHECKS, caseDeadlineMs: deadlines.caseDeadlineMs ?? 2_000, cleanupDeadlineMs: deadlines.cleanupDeadlineMs ?? 2_000, preflightDeadlineMs: deadlines.preflightDeadlineMs, ownership });
  const arm = () => {
    lifecycle.beginPreflight();
    for (const check of CHECKS) lifecycle.preflightCheck(check, true);
    lifecycle.arm({ startEvidence: SAVED });
  };
  /** One fixture: a registered subject with two charged rows (as the production store would leave them). */
  const charge = (suffix: string) => {
    const subject = ownership.registerSubject(suffix);
    fake.seedRows(subject, ["chain_read_day", "chain_read_short"]);
    return subject;
  };
  /** One scratch schema holding a trigger function and the look-alike table, registered in dependency order. */
  const scratch = (suffix: string) => {
    const schema = ownership.registerScratchSchema(suffix);
    const objects = [ownership.registerScratchObject(schema, "function", "pb_trigger_fn"), ownership.registerScratchObject(schema, "table", "real_provider_budgets")];
    fake.seedSchema(schema, objects);
    return schema;
  };
  /** All three cases, each charging one subject; the first also creates a scratch schema. */
  const runAllCases = async () => {
    for (const name of CASES) {
      await lifecycle.runCase(name, async () => {
        charge(name);
        if (name === "one") scratch("a");
        await lifecycle.consume("a budget request", admitted);
      });
      lifecycle.afterCase({ reportedFailed: false });
    }
  };
  return { ownership, fake, lifecycle, arm, charge, scratch, runAllCases };
}

const finalEvidence = (report: FinalReport) => ({
  runId: RUN,
  lifecycleOutcome: report.outcome,
  server: { version: "18.6", isolation: "read committed", inRecovery: false },
  connectionMode: "pooled",
  migrationStatementSha256: sha256Hex("the migration statement"),
  casesExecuted: report.executed,
  casesNotExecuted: report.notExecuted,
  admissionTallies: report.admissionTallies,
  schemaRefusals: report.schemaRefusals,
  cleanup: report.cleanup,
  fingerprintsBefore: BEFORE,
  fingerprintsAfter: report.delta ? AFTER : null,
  expectedDelta: report.delta?.expectedDelta ?? null,
  unknownOperations: report.unknownOperations,
  inFlightOperations: report.inFlightOperations,
  verdict: report.verdict,
  ownedSubjects: report.ownedSubjects,
  ownedSchemas: report.ownedSchemas,
  poisoned: report.poisoned,
});

describe("reused Milestone 1 guards, and the runner's fixed timings", () => {
  it("exact-file selection is Milestone 1's rule, for the provider-budget smoke's own path", () => {
    expect(checkProviderBudgetFileSelection(["run", PROVIDER_BUDGET_SMOKE_FILE, "--testTimeout=120000", "--hookTimeout=120000"])).toEqual({ ok: true });
    for (const args of [["run"], ["run", "test/lib/real/provisioning-limits.smoke.test.ts"], ["run", PROVIDER_BUDGET_SMOKE_FILE, "test/lib/real/rate-limit.smoke.test.ts"], ["run", PROVIDER_BUDGET_SMOKE_FILE, "-t", "one"], ["watch", PROVIDER_BUDGET_SMOKE_FILE], undefined]) {
      expect(checkProviderBudgetFileSelection(args).ok, JSON.stringify(args)).toBe(false);
    }
  });

  it("the run's own deadlines fire before the test runner's timeout", () => {
    expect([VITEST_TIMEOUT_MS, CASE_DEADLINE_MS, CLEANUP_DEADLINE_MS]).toEqual([120_000, 90_000, 60_000]);
    expect(() => createProviderBudgetLifecycle({ expectedCases: CASES, requiredPreflightChecks: CHECKS, caseDeadlineMs: 0, cleanupDeadlineMs: 10, ownership: createRunOwnership(RUN) })).toThrow(/deadline/);
    expect(() => createProviderBudgetLifecycle({ expectedCases: [], requiredPreflightChecks: CHECKS, caseDeadlineMs: 10, cleanupDeadlineMs: 10, ownership: createRunOwnership(RUN) })).toThrow(/expected cases/);
    expect(() => createProviderBudgetLifecycle({ expectedCases: CASES, requiredPreflightChecks: [], caseDeadlineMs: 10, cleanupDeadlineMs: 10, ownership: createRunOwnership(RUN) })).toThrow(/preflight checks/);
  });
});

describe("A, B. lifecycle transitions, and nothing is written before arming", () => {
  it("A. NOT_STARTED -> PREFLIGHT -> ARMED -> RUNNING -> ARMED -> CLEANUP -> COMPLETED_CLEAN, with the whole clean run accounted for", async () => {
    const { lifecycle, fake, ownership, runAllCases } = setup();
    expect(lifecycle.state()).toBe("NOT_STARTED");
    lifecycle.beginPreflight();
    expect(lifecycle.state()).toBe("PREFLIGHT");
    expect(await lifecycle.read("a preflight read", async () => 5)).toBe(5);
    for (const check of CHECKS) lifecycle.preflightCheck(check, true);
    lifecycle.arm({ startEvidence: SAVED });
    expect(lifecycle.state()).toBe("ARMED");

    let during: string | null = null;
    await lifecycle.runCase("one", async () => void (during = lifecycle.state()));
    expect(during).toBe("RUNNING");
    expect(lifecycle.state()).toBe("ARMED");
    await lifecycle.runCase("two", async () => undefined);
    await lifecycle.runCase("three", async () => undefined);

    await lifecycle.runFinalCleanup(fake.db);
    expect(lifecycle.state()).toBe("CLEANUP");
    const report = await lifecycle.finish({ compare: async () => goodDelta(ownership.ownedSchemas()) });
    expect(lifecycle.state()).toBe("COMPLETED_CLEAN");
    expect(report).toMatchObject({ outcome: "COMPLETED_CLEAN", verdict: "baseline_plus_expected_delta", completeRestoration: false, poisoned: null, executed: [...CASES], notExecuted: [], inFlightOperations: [], unknownOperations: [] });
    expect(report.action).toContain("baseline PLUS the expected delta");
    expect(report.action).toContain("not restored");
    await runAllCases().catch(() => undefined); // a finished run starts nothing further
    expect(lifecycle.state()).toBe("POISONED");
  });

  it("A. a complete, cleaned-up run whose database is not baseline-plus-delta ends COMPLETED_DELTA_MISMATCH — never clean", async () => {
    const { lifecycle, fake, arm, runAllCases } = setup();
    arm();
    await runAllCases();
    await lifecycle.runFinalCleanup(fake.db);
    const mismatch = compareWithExpectedDelta({ before: BEFORE, after: { ...AFTER, tables: { ...AFTER.tables, payment_attempts: fingerprint("payments", 21) } }, providerTable: EXPECTED_PROVIDER_TABLE, ownedSchemas: [] });
    const report = await lifecycle.finish({ compare: async () => mismatch });
    expect(report).toMatchObject({ outcome: "COMPLETED_DELTA_MISMATCH", verdict: "delta_mismatch", completeRestoration: false });
    expect(lifecycle.state()).toBe("COMPLETED_DELTA_MISMATCH");
    expect(concludeProviderBudgetRun(report, { start: SAVED, final: SAVED })).toMatchObject({ pass: false, verdict: "not_clean" });
  });

  it("A. a run that never armed ends NOT_STARTED, and its cleanup sends nothing", async () => {
    const { lifecycle, fake } = setup();
    lifecycle.beginPreflight();
    await lifecycle.runFinalCleanup(fake.db);
    const report = await lifecycle.finish({ compare: async () => goodDelta() });
    expect(report).toMatchObject({ outcome: "NOT_STARTED", verdict: "not_started", action: "Nothing was written." });
    expect(fake.log).toEqual([]);
  });

  it("A. arming needs every required check passed, nothing unsettled, and the start evidence saved", async () => {
    const missingCheck = setup().lifecycle;
    missingCheck.beginPreflight();
    missingCheck.preflightCheck(CHECKS[0], true);
    expect(() => missingCheck.arm({ startEvidence: SAVED })).toThrow(/poisoned/);
    expect(missingCheck.poisoned()).toMatch(/1 preflight check\(s\) not passed/);

    const failedCheck = setup().lifecycle;
    failedCheck.beginPreflight();
    expect(() => failedCheck.preflightCheck(CHECKS[0], false)).toThrow(/poisoned/);
    expect(() => failedCheck.arm({ startEvidence: SAVED })).toThrow(/poisoned/);
    expect(failedCheck.state()).toBe("POISONED");

    const noEvidence = setup().lifecycle;
    noEvidence.beginPreflight();
    for (const check of CHECKS) noEvidence.preflightCheck(check, true);
    expect(() => noEvidence.arm({ startEvidence: NOT_SAVED })).toThrow(/poisoned/);
    expect(noEvidence.poisoned()).toMatch(/without saved start evidence/);

    const unsettled = setup().lifecycle;
    unsettled.beginPreflight();
    for (const check of CHECKS) unsettled.preflightCheck(check, true);
    void unsettled.read("a slow preflight read", () => sleep(60)).catch(() => undefined);
    expect(() => unsettled.arm({ startEvidence: SAVED })).toThrow(/poisoned/);
    expect(unsettled.poisoned()).toMatch(/still unsettled/);

    const skipped = setup().lifecycle;
    expect(() => skipped.arm({ startEvidence: SAVED })).toThrow(/poisoned/); // never even entered the preflight
    const unknownCheck = setup().lifecycle;
    unknownCheck.beginPreflight();
    expect(() => unknownCheck.preflightCheck("something else", true)).toThrow(/poisoned/);
    const twice = setup().lifecycle;
    twice.beginPreflight();
    expect(() => twice.beginPreflight()).toThrow(/poisoned/);
  });

  it("B. no write before arming: not before the preflight, not during it — the operation is never called", async () => {
    for (const enter of [false, true]) {
      const { lifecycle } = setup();
      if (enter) lifecycle.beginPreflight();
      let called = 0;
      await expect(lifecycle.write("a write", async () => void (called += 1))).rejects.toThrow(/poisoned/);
      await expect(lifecycle.consume("a budget request", async () => void (called += 1))).rejects.toThrow(/poisoned/);
      expect(called).toBe(0);
      expect(lifecycle.state()).toBe("POISONED");
    }
    const { lifecycle } = setup();
    let bodyRan = false;
    await expect(lifecycle.runCase("one", async () => void (bodyRan = true))).rejects.toThrow(/not armed/);
    expect(bodyRan).toBe(false);
  });

  it("B. an armed run still writes only INSIDE a case, and cases run only in their expected order, once", async () => {
    const outside = setup();
    outside.arm();
    let called = 0;
    await expect(outside.lifecycle.write("a write between cases", async () => void (called += 1))).rejects.toThrow(/poisoned/);
    expect(called).toBe(0);
    expect(outside.lifecycle.poisoned()).toMatch(/outside a running case/);

    const order = setup();
    order.arm();
    await expect(order.lifecycle.runCase("two", async () => void (called += 1))).rejects.toThrow(/poisoned/);
    expect(order.lifecycle.poisoned()).toMatch(/not the next expected case/);

    const repeat = setup();
    repeat.arm();
    await repeat.lifecycle.runCase("one", async () => undefined);
    await expect(repeat.lifecycle.runCase("one", async () => void (called += 1))).rejects.toThrow(/poisoned/);
    expect(called).toBe(0);
  });
});

describe("C, D, E. poison is permanent, keeps its first reason, and stops everything", () => {
  it("after poison: no case, write, read, budget request, expected refusal, registration, cleanup, or comparison — each refused before it is called", async () => {
    const { lifecycle, fake, ownership, arm, charge } = setup();
    arm();
    await lifecycle.runCase("one", async () => void charge("kept"));
    lifecycle.poison("first reason");
    lifecycle.poison("second reason");
    expect(lifecycle.poisoned()).toBe("first reason");
    expect(lifecycle.state()).toBe("POISONED");

    let called = 0;
    const call = async () => void (called += 1);
    await expect(lifecycle.runCase("two", call)).rejects.toThrow(/first reason/);
    await expect(lifecycle.write("a write", call)).rejects.toThrow(/poisoned/);
    await expect(lifecycle.read("a read", call)).rejects.toThrow(/poisoned/);
    await expect(lifecycle.consume("a budget request", call)).rejects.toThrow(/poisoned/);
    await expect(lifecycle.consumeBurst("a burst", [call, call])).rejects.toThrow(/poisoned/);
    await expect(lifecycle.expectRefusal("a refusal", call, ["23514"])).rejects.toThrow(/poisoned/);
    expect(() => lifecycle.arm({ startEvidence: SAVED })).toThrow(/poisoned/);
    expect(() => lifecycle.beginPreflight()).toThrow(/poisoned/);
    expect(called).toBe(0);
    // Ownership cannot grow after a failure.
    expect(ownership.sealed()).toBe("the run is poisoned");
    expect(() => ownership.registerSubject("late")).toThrow(/sealed/);
    expect(() => ownership.registerScratchSchema("late")).toThrow(/sealed/);

    await lifecycle.runFinalCleanup(fake.db);
    const report = await lifecycle.finish({ compare: async () => (await call(), goodDelta()) });
    expect(called).toBe(0); // not even the read-only comparison
    expect(fake.log).toEqual([]);
    expect(report).toMatchObject({ outcome: "POISONED", verdict: "poisoned_evidence_preserved", poisoned: "first reason", executed: ["one"], notExecuted: ["two", "three"] });
    expect(report.cleanup).toMatchObject({ attempted: false, accepted: false, skipped: "nothing was sent: first reason" });
    expect(report.action).toContain("No cleanup was started");
    // The fixture the run created is still there, exactly as it was.
    expect(fake.rowsOf(report.ownedSubjects[0]!)).toEqual(["chain_read_day", "chain_read_short"]);
    lifecycle.poison("third reason");
    expect(lifecycle.poisoned()).toBe("first reason");
  });

  it("E. a later, different failure never replaces the first reason", async () => {
    const { lifecycle, arm } = setup();
    arm();
    await expect(lifecycle.runCase("one", async () => void (await lifecycle.write("the first write", () => Promise.reject(sqlError("40P01")))))).rejects.toThrow();
    const first = lifecycle.poisoned();
    expect(first).toBe("the database refused the first write (SQLSTATE 40P01)");
    lifecycle.afterCase({ reportedFailed: true });
    await expect(lifecycle.runCase("two", async () => undefined)).rejects.toThrow();
    expect(lifecycle.poisoned()).toBe(first);
  });
});

describe("F, G, H. ownership: exact names, this run only, bounded, and closed after a failure", () => {
  it("F. only a subject this run registered — and of this run's shape — is owned", () => {
    const ownership = createRunOwnership(RUN);
    const subject = ownership.registerSubject("case-a-1");
    expect(subject).toBe(`smoke-${RUN}-pb-case-a-1`);
    expect(() => ownership.assertOwnedSubject(subject)).not.toThrow();
    for (const foreign of [`smoke-${RUN}-pb-case-a-2`, `smoke-${RUN}-pb-case-a-1x`, "smoke-ffffffff-pb-case-a-1", `smoke-${RUN}-pl-case-a-1`, "app-user-1", "", `%`, undefined]) {
      expect(() => ownership.assertOwnedSubject(foreign as string), String(foreign)).toThrow(/does not own/);
    }
    // Another run's registry does not own it either.
    expect(() => createRunOwnership("ffffffff").assertOwnedSubject(subject)).toThrow(/does not own/);
    expect(() => ownership.registerSubject("case-a-1")).toThrow(/used twice/);
    for (const bad of ["", "A", "a b", "a--b", "-a", "a'; --", "a%", "x".repeat(41)]) expect(() => ownership.registerSubject(bad), bad).toThrow(/suffix/);
    expect(() => createRunOwnership("0A1B2C3D")).toThrow(/run id/);
    expect(() => createRunOwnership("0a1b2c3")).toThrow(/run id/);
  });

  it("G. only a schema this run registered is owned; `public` and every other name are refused by every statement builder", () => {
    const ownership = createRunOwnership(RUN);
    const schema = ownership.registerScratchSchema("tamper01");
    expect(schema).toBe(`pb_smoke_${RUN}_tamper01`);
    const table = ownership.registerScratchObject(schema, "table", "real_provider_budgets");
    for (const foreign of ["public", "pg_catalog", `pb_smoke_${RUN}_tamper02`, "pb_smoke_ffffffff_tamper01", `${schema} CASCADE`, `${schema}; DROP SCHEMA public`, ""]) {
      expect(() => ownership.assertOwnedSchema(foreign), foreign).toThrow(/does not own/);
      expect(() => dropSchemaStatement(ownership, foreign), foreign).toThrow(/does not own/);
      expect(() => dropObjectStatement(ownership, foreign, table), foreign).toThrow(/does not own/);
      expect(() => ownership.registerScratchObject(foreign, "table", "t"), foreign).toThrow(/does not own/);
      expect(admitScratchSchemaCleanup(ownership, foreign, { inventory: [], external: { foreignKeys: 0, triggers: 0, inheritance: 0, viewReferences: 0 } }, 0)).toEqual({ ok: false, reason: "the schema is not owned by this run" });
    }
    // An object that was never registered is not owned, even inside an owned schema.
    expect(() => dropObjectStatement(ownership, schema, { kind: "table", name: "real_accounts" })).toThrow(/did not register/);
    expect(() => dropObjectStatement(ownership, schema, { kind: "view", name: "real_provider_budgets" })).toThrow(/did not register/);
    // No identifier that is not a plain lower-case name can ever be registered.
    for (const bad of ["a_b", "A", "", "x".repeat(13), "a;b", "a b"]) expect(() => ownership.registerScratchSchema(bad), bad).toThrow(/suffix/);
    for (const bad of ["Real", "t; DROP TABLE public.real_accounts", 't"x', "t.u", "", "1t"]) expect(() => ownership.registerScratchObject(schema, "table", bad), bad).toThrow(/plain identifier/);
    expect(() => ownership.registerScratchObject(schema, "index" as never, "i")).toThrow(/table, a view, or a function/);
    expect(() => ownership.registerScratchObject(schema, "view", "real_provider_budgets")).toThrow(/used twice/);
    expect(() => ownership.registerScratchSchema("tamper01")).toThrow(/used twice/);
    expect(dropObjectStatement(ownership, schema, table)).toEqual({ text: `DROP TABLE ${schema}.real_provider_budgets RESTRICT`, params: [] });
    expect(dropSchemaStatement(ownership, schema)).toEqual({ text: `DROP SCHEMA ${schema} RESTRICT`, params: [] });
  });

  it("H. registrations are capped cumulatively, and a sealed registry never grows", () => {
    const ownership = createRunOwnership(RUN);
    for (let i = 0; i < MAX_RUN_SUBJECTS; i += 1) ownership.registerSubject(`s-${i}`);
    expect(() => ownership.registerSubject("one-more")).toThrow(/subject limit/);
    const schemas: string[] = [];
    for (let i = 0; i < MAX_RUN_SCRATCH_SCHEMAS; i += 1) schemas.push(ownership.registerScratchSchema(`s${i}`));
    expect(() => ownership.registerScratchSchema("more")).toThrow(/scratch-schema limit/);
    for (let i = 0; i < MAX_RUN_SCRATCH_OBJECTS; i += 1) ownership.registerScratchObject(schemas[i % schemas.length]!, "table", `t_${i}`);
    expect(() => ownership.registerScratchObject(schemas[0]!, "table", "one_more")).toThrow(/scratch-object limit/);
    expect(ownership.ownedSubjects()).toHaveLength(MAX_RUN_SUBJECTS);

    const sealed = createRunOwnership(RUN);
    const schema = sealed.registerScratchSchema("a");
    sealed.seal("first");
    sealed.seal("second");
    expect(sealed.sealed()).toBe("first");
    expect(() => sealed.registerSubject("x")).toThrow(/sealed/);
    expect(() => sealed.registerScratchSchema("b")).toThrow(/sealed/);
    expect(() => sealed.registerScratchObject(schema, "table", "t")).toThrow(/sealed/);
    expect(() => sealed.assertOwnedSchema(schema)).not.toThrow(); // what was owned can still be checked
  });

  it("H. a run sends at most MAX_RUN_OPERATIONS operations, and a burst at most MAX_CONCURRENCY at once", async () => {
    const { lifecycle, arm } = setup();
    arm();
    let sent = 0;
    await expect(
      lifecycle.runCase("one", async () => {
        for (let i = 0; i < MAX_RUN_OPERATIONS; i += 1) await lifecycle.read("a read", async () => void (sent += 1));
        await lifecycle.read("one read too many", async () => void (sent += 1));
      }),
    ).rejects.toThrow();
    expect(sent).toBe(MAX_RUN_OPERATIONS);
    expect(lifecycle.poisoned()).toBe("the run reached its operation limit");

    const burst = setup();
    burst.arm();
    await expect(burst.lifecycle.runCase("one", () => burst.lifecycle.consumeBurst("too many at once", Array.from({ length: MAX_CONCURRENCY + 1 }, () => async () => void (sent += 1))))).rejects.toThrow();
    expect(sent).toBe(MAX_RUN_OPERATIONS);
    expect(burst.lifecycle.poisoned()).toMatch(/outside the concurrency bound/);
  });
});

describe("L, M, N. what a database answer means", () => {
  it("only a well-formed limiter decision is an answer; an error, a limiter refusal, and anything unrecognized are not denials", () => {
    expect(classifyConsume({ status: "fulfilled", value: { allowed: true } })).toEqual({ kind: "admitted" });
    expect(classifyConsume({ status: "fulfilled", value: { allowed: false, retryAfterSeconds: 12 } })).toEqual({ kind: "denied", retryAfterSeconds: 12 });
    for (const value of [undefined, null, {}, { allowed: "true" }, { allowed: true, retryAfterSeconds: 1 }, { allowed: false }, { allowed: false, retryAfterSeconds: 0 }, { allowed: false, retryAfterSeconds: 1.5 }, { allowed: false, retryAfterSeconds: 3, bucket: "x" }, []]) {
      expect(classifyConsume({ status: "fulfilled", value }), JSON.stringify(value)).toEqual({ kind: "no_answer" });
    }
    expect(classifyConsume({ status: "rejected", reason: sqlError("23514", { constraint: "real_provider_budgets_bucket_check" }) })).toEqual({ kind: "database_error", sqlState: "23514", constraint: "real_provider_budgets_bucket_check" });
    expect(classifyConsume({ status: "rejected", reason: Object.assign(new Error('violates check constraint "real_provider_budgets_hits_check"'), { code: "23514" }) })).toMatchObject({ constraint: "real_provider_budgets_hits_check" });
    expect(classifyConsume({ status: "rejected", reason: sqlError("42P01") })).toEqual({ kind: "database_error", sqlState: "42P01", constraint: null });
    expect(classifyConsume({ status: "rejected", reason: new Error("Provider budget refused: the store did not report every bucket.") })).toEqual({ kind: "limiter_refusal" });
    for (const reason of [new Error("fetch failed"), Object.assign(new Error("x"), { code: "ECONNRESET" }), "boom", null, undefined]) expect(classifyConsume({ status: "rejected", reason })).toEqual({ kind: "no_answer" });
    // No driver text survives classification.
    expect(JSON.stringify(classifyConsume({ status: "rejected", reason: sqlError("57014", { message: "postgres://user:pw@host/db timed out" }) }))).not.toMatch(/postgres|pw@/);
    expect(tallyOutcomes([{ kind: "admitted" }, { kind: "admitted" }, { kind: "denied", retryAfterSeconds: 1 }, { kind: "no_answer" }])).toEqual({ admitted: 2, denied: 1, no_answer: 1 });
  });

  it("admitted and denied budget requests are tallied per case, singly and in bursts", async () => {
    const { lifecycle, fake, arm } = setup();
    arm();
    await lifecycle.runCase("one", async () => {
      expect(await lifecycle.consume("a budget request", admitted)).toEqual({ kind: "admitted" });
      expect(await lifecycle.consume("a budget request", denied)).toEqual({ kind: "denied", retryAfterSeconds: 7 });
      const outcomes = await lifecycle.consumeBurst("a burst", [admitted, admitted, denied, admitted, denied]);
      expect(tallyOutcomes(outcomes)).toEqual({ admitted: 3, denied: 2 });
    });
    await lifecycle.runCase("two", async () => void (await lifecycle.consume("a budget request", denied)));
    await lifecycle.runCase("three", async () => undefined);
    await lifecycle.runFinalCleanup(fake.db);
    const report = await lifecycle.finish({ compare: async () => goodDelta() });
    expect(report.admissionTallies).toEqual({ one: { admitted: 4, denied: 3 }, two: { admitted: 0, denied: 1 } });
    expect(report.operationsIssued).toBe(8);
  });

  it("L. a missing answer poisons — a rejected write, an unrecognizable budget answer, and one lost request inside a burst", async () => {
    const write = setup();
    write.arm();
    await expect(write.lifecycle.runCase("one", () => write.lifecycle.write("applying the migration", () => Promise.reject(new Error("fetch failed"))))).rejects.toThrow();
    expect(write.lifecycle.poisoned()).toBe("no answer for applying the migration; it may or may not have taken effect");
    expect((await write.lifecycle.finish({ compare: async () => goodDelta() })).unknownOperations).toEqual(["applying the migration"]);

    const single = setup();
    single.arm();
    await expect(single.lifecycle.runCase("one", () => single.lifecycle.consume("a budget request", async () => ({ ok: 1 })))).rejects.toThrow();
    expect(single.lifecycle.poisoned()).toMatch(/no usable answer for a budget request/);

    const burst = setup();
    burst.arm();
    let settled = 0;
    const counted = (operation: () => Promise<unknown>) => () => operation().finally(() => void (settled += 1));
    await expect(burst.lifecycle.runCase("one", () => burst.lifecycle.consumeBurst("a burst", [counted(admitted), counted(() => Promise.reject(new Error("socket hang up"))), counted(denied), counted(admitted)]))).rejects.toThrow();
    expect(settled).toBe(4); // the burst was awaited to the end: nothing was left running behind the failure
    const report = await burst.lifecycle.finish({ compare: async () => goodDelta() });
    expect(report.unknownOperations).toEqual(["a burst"]);
    // The lost request is not a denial: it appears in no tally.
    expect(report.admissionTallies).toEqual({ one: { admitted: 2, denied: 1 } });
    expect(report.outcome).toBe("POISONED");
  });

  it("M. an unexpected SQLSTATE poisons — on a write, a read, and a budget request (never counted as denied)", async () => {
    for (const [what, run, reason] of [
      ["a write", (l: ReturnType<typeof setup>["lifecycle"]) => l.write("a write", () => Promise.reject(sqlError("55P03"))), "the database refused a write (SQLSTATE 55P03)"],
      ["a read", (l: ReturnType<typeof setup>["lifecycle"]) => l.read("a read", () => Promise.reject(sqlError("42P01"))), "the database refused a read (SQLSTATE 42P01)"],
      ["a budget request", (l: ReturnType<typeof setup>["lifecycle"]) => l.consume("a budget request", () => Promise.reject(sqlError("23514"))), "a budget request (a budget request) was refused by the database (SQLSTATE 23514); that is not a budget denial"],
      ["a limiter refusal", (l: ReturnType<typeof setup>["lifecycle"]) => l.consume("a budget request", () => Promise.reject(new Error("Provider budget refused: unknown bucket."))), "a budget request (a budget request) was refused by the limiter itself; whether it was charged is unknown"],
    ] as const) {
      const { lifecycle, arm } = setup();
      arm();
      await expect(lifecycle.runCase("one", () => run(lifecycle)), what).rejects.toThrow();
      expect(lifecycle.poisoned(), what).toBe(reason);
      expect((await lifecycle.finish({ compare: async () => goodDelta() })).admissionTallies, what).toEqual({});
    }
  });

  it("N. a refusal the case explicitly expects — by exact SQLSTATE — is classified without poisoning; nothing else is", async () => {
    const { lifecycle, fake, arm } = setup();
    arm();
    await lifecycle.runCase("one", async () => {
      expect(await lifecycle.expectRefusal("a foreign bucket", () => Promise.reject(sqlError("23514", { constraint: "real_provider_budgets_bucket_check" })), ["23514"])).toEqual({ sqlState: "23514", constraint: "real_provider_budgets_bucket_check" });
      expect(await lifecycle.expectRefusal("the migration on a look-alike", () => Promise.reject(sqlError("P0001")), ["P0001"])).toEqual({ sqlState: "P0001", constraint: null });
    });
    expect(lifecycle.poisoned()).toBeNull();
    await lifecycle.runCase("two", async () => undefined);
    await lifecycle.runCase("three", async () => undefined);
    await lifecycle.runFinalCleanup(fake.db);
    expect((await lifecycle.finish({ compare: async () => goodDelta() })).schemaRefusals).toEqual([
      { case: "one", what: "a foreign bucket", sqlState: "23514" },
      { case: "one", what: "the migration on a look-alike", sqlState: "P0001" },
    ]);

    const failures: Array<[string, () => Promise<unknown>, readonly string[], RegExp]> = [
      ["a different SQLSTATE", () => Promise.reject(sqlError("42P01")), ["23514"], /with SQLSTATE 42P01, which this case does not allow/],
      ["it succeeded", async () => [], ["23514"], /was expected to be refused by the database, and was not/],
      ["no answer", () => Promise.reject(new Error("fetch failed")), ["23514"], /no answer for/],
      ["no SQLSTATE named", () => Promise.reject(sqlError("23514")), [], /named no valid SQLSTATE/],
      ["a malformed SQLSTATE named", () => Promise.reject(sqlError("23514")), ["any"], /named no valid SQLSTATE/],
    ];
    for (const [what, operation, allowed, reason] of failures) {
      const other = setup();
      other.arm();
      await expect(other.lifecycle.runCase("one", () => other.lifecycle.expectRefusal("an expected refusal", operation, allowed)), what).rejects.toThrow();
      expect(other.lifecycle.poisoned(), what).toMatch(reason);
    }
  });
});

describe("I. the cleanup plan: exact names from the registry, nothing else", () => {
  it("is admission reads for every schema FIRST, then one exact DELETE per subject, then RESTRICT drops in reverse registration order, then two exact-name residue reads", () => {
    const { ownership, charge, scratch } = setup();
    const [s1, s2] = [charge("a"), charge("b")];
    const schema = scratch("x");
    const plan = planCleanup(ownership);
    expect(plan.steps.map((step) => [step.action, step.target, step.writes, step.statement.text, step.statement.params])).toEqual([
      ["inspect_inventory", schema, false, SCHEMA_INVENTORY_SQL, [schema]],
      ["inspect_dependencies", schema, false, SCHEMA_EXTERNAL_DEPENDENCIES_SQL, [schema]],
      ["delete_subject", s1, true, DELETE_SUBJECT_SQL, [s1]],
      ["delete_subject", s2, true, DELETE_SUBJECT_SQL, [s2]],
      ["drop_object", `${schema}.real_provider_budgets`, true, `DROP TABLE ${schema}.real_provider_budgets RESTRICT`, []],
      ["drop_object", `${schema}.pb_trigger_fn`, true, `DROP FUNCTION ${schema}.pb_trigger_fn() RESTRICT`, []],
      ["drop_schema", schema, true, `DROP SCHEMA ${schema} RESTRICT`, []],
      ["read_subject_residue", "owned subjects", false, SUBJECT_RESIDUE_SQL, [[s1, s2]]],
      ["read_schema_residue", "owned schemas", false, SCHEMA_RESIDUE_SQL, [[schema]]],
    ]);
    expect(plan.steps.every((step) => step.outcome === "not_attempted")).toBe(true);
    for (const step of plan.steps) {
      // Never a pattern, never CASCADE, never more than one statement, never an existing application table.
      expect(step.statement.text, step.action).not.toMatch(/\bLIKE\b|%|CASCADE|;|TRUNCATE|\bUPDATE\b|\bALTER\b|real_accounts|real_rate_limits|payment_attempts|registration_/i);
      if (step.writes) expect(step.statement.text).toMatch(new RegExp(`^(DELETE FROM public\\.real_provider_budgets WHERE subject = \\$1 RETURNING bucket|DROP (TABLE|VIEW|FUNCTION|SCHEMA) pb_smoke_${RUN}_[a-z0-9]+(\\.[a-z_][a-z0-9_]*(\\(\\))?)? RESTRICT)$`));
    }
    // The only DELETE the fixture can build is the exact-subject one, and the reads take names as bound parameters.
    expect(DELETE_SUBJECT_SQL).toBe("DELETE FROM public.real_provider_budgets WHERE subject = $1 RETURNING bucket");
    for (const read of [SUBJECT_RESIDUE_SQL, SCHEMA_RESIDUE_SQL, SCHEMA_INVENTORY_SQL, SCHEMA_EXTERNAL_DEPENDENCIES_SQL]) expect(read).toMatch(/^SELECT /);
  });

  it("a successful run proves all of its owned data is gone: every step confirmed, in plan order, and both residue reads zero", async () => {
    const { lifecycle, fake, ownership, arm, runAllCases } = setup();
    arm();
    await runAllCases();
    fake.seedRows("app-user-not-ours", ["pay_submit_day"]); // someone else's row must survive
    const plan = planCleanup(ownership).steps.map((step) => step.statement.text);
    await lifecycle.runFinalCleanup(fake.db);
    expect(fake.log.map((statement) => statement.text)).toEqual(plan);
    expect(fake.subjects()).toEqual(["app-user-not-ours"]);
    expect(fake.schemaNames()).toEqual([]);
    const report = await lifecycle.finish({ compare: async () => goodDelta(ownership.ownedSchemas()) });
    expect(report.cleanup).toMatchObject({ attempted: true, accepted: true, skipped: null, inFlight: false, stopped: null, refusal: null });
    expect(report.cleanup.summary).toEqual({ status: "confirmed", steps: { total: 10, confirmed: 10, refusedByDatabase: 0, unexpectedAnswer: 0, refusedByHarness: 0, noAnswer: 0, inFlight: 0, notAttempted: 0 }, mayStillComplete: false });
    expect(report.cleanup.steps.filter((step) => step.action === "delete_subject").map((step) => step.rows)).toEqual([2, 2, 2]);
    expect(report.cleanup.steps.every((step) => !("statement" in step))).toBe(true);
    expect(concludeProviderBudgetRun(report, { start: SAVED, final: SAVED })).toEqual({ pass: true, verdict: "clean_and_evidenced", message: "provider budget smoke: completed clean (baseline plus expected delta), evidence saved." });
    // Attempted once only: a second cleanup sends nothing and poisons.
    const sent = fake.log.length;
    await lifecycle.runFinalCleanup(fake.db);
    expect(fake.log).toHaveLength(sent);
    expect(lifecycle.poisoned()).toBe("a second final cleanup was attempted");
  });
});

describe("scratch-schema safety: a matching name is never enough", () => {
  const clean = { foreignKeys: 0, triggers: 0, inheritance: 0, viewReferences: 0 };

  it("a schema is admitted for removal only with exactly its registered inventory, no boundary-crossing dependency, and nothing outstanding", () => {
    const ownership = createRunOwnership(RUN);
    const schema = ownership.registerScratchSchema("a");
    const fn = ownership.registerScratchObject(schema, "function", "pb_trigger_fn");
    const table = ownership.registerScratchObject(schema, "table", "real_provider_budgets");
    expect(admitScratchSchemaCleanup(ownership, schema, { inventory: [table, fn], external: clean }, 0)).toEqual({ ok: true });
    const refused: Array<[string, Parameters<typeof admitScratchSchemaCleanup>[2], number, string]> = [
      ["an extra object", { inventory: [table, fn, { kind: "table", name: "surprise" }], external: clean }, 0, "the schema holds an object this run did not register"],
      ["the same name as a different kind", { inventory: [fn, { kind: "view", name: "real_provider_budgets" }], external: clean }, 0, "the schema holds an object this run did not register"],
      ["a kind this harness never creates", { inventory: [table, fn, { kind: "other:S" as never, name: "a_sequence" }], external: clean }, 0, "the schema holds an object this run did not register"],
      ["a registered object missing", { inventory: [table], external: clean }, 0, "a registered object is missing from the schema"],
      ["a duplicate listing", { inventory: [table, table, fn], external: clean }, 0, "the schema's inventory lists an object twice"],
      ["a foreign key across the boundary", { inventory: [table, fn], external: { ...clean, foreignKeys: 1 } }, 0, "a dependency crosses the schema's boundary"],
      ["a trigger across the boundary", { inventory: [table, fn], external: { ...clean, triggers: 1 } }, 0, "a dependency crosses the schema's boundary"],
      ["inheritance across the boundary", { inventory: [table, fn], external: { ...clean, inheritance: 2 } }, 0, "a dependency crosses the schema's boundary"],
      ["a view across the boundary", { inventory: [table, fn], external: { ...clean, viewReferences: 1 } }, 0, "a dependency crosses the schema's boundary"],
      ["an unreadable observation", null, 0, "the schema's contents or dependencies could not be read"],
      ["an outstanding operation", { inventory: [table, fn], external: clean }, 1, "operations of this run are still outstanding"],
    ];
    for (const [what, observation, outstanding, reason] of refused) expect(admitScratchSchemaCleanup(ownership, schema, observation, outstanding), what).toEqual({ ok: false, reason });
  });

  it("the catalog answers are read strictly: anything malformed is unreadable, never empty", () => {
    expect(parseInventoryRows([{ kind: "table", name: "real_provider_budgets" }])).toEqual([{ kind: "table", name: "real_provider_budgets" }]);
    expect(parseInventoryRows([])).toEqual([]);
    for (const rows of [null, undefined, "x", [null], [{ kind: "table" }], [{ kind: 1, name: "t" }], [{ kind: "table", name: "T" }], [{ kind: "table", name: "t; drop" }]]) expect(parseInventoryRows(rows), JSON.stringify(rows)).toBeNull();
    expect(parseExternalRow([{ foreign_keys: 0, triggers: 0, inheritance: 0, view_references: 0 }])).toEqual(clean);
    for (const rows of [[], [{}], [{ foreign_keys: "0", triggers: 0, inheritance: 0, view_references: 0 }], [{ foreign_keys: 0, triggers: 0, inheritance: 0 }], [{ foreign_keys: -1, triggers: 0, inheritance: 0, view_references: 0 }], [clean, clean], null]) expect(parseExternalRow(rows), JSON.stringify(rows)).toBeNull();
  });

  it.each([
    ["an unregistered object sits in a scratch schema", (fake: ReturnType<typeof setup>["fake"], schema: string) => fake.seedSchema(schema, [{ kind: "function", name: "pb_trigger_fn" }, { kind: "table", name: "real_provider_budgets" }, { kind: "table", name: "not_ours" }]), "the schema holds an object this run did not register"],
    ["a foreign key links the scratch schema to something outside it", (fake: ReturnType<typeof setup>["fake"], schema: string) => fake.seedSchema(schema, [{ kind: "function", name: "pb_trigger_fn" }, { kind: "table", name: "real_provider_budgets" }], { foreign_keys: 1 }), "a dependency crosses the schema's boundary"],
  ])("when %s, the WHOLE cleanup is refused before its first delete or drop, and everything is preserved", async (_what, tamper, reason) => {
    const { lifecycle, fake, ownership, arm, runAllCases } = setup();
    arm();
    await runAllCases();
    const schema = ownership.ownedSchemas()[0]!;
    tamper(fake, schema);
    const objectsBefore = fake.objectsIn(schema);
    await expect(lifecycle.runFinalCleanup(fake.db)).rejects.toThrow(/final cleanup was incomplete/);
    expect(fake.writes()).toEqual([]);
    expect(fake.log.map((statement) => statement.kind)).toEqual(["inventory", "dependencies"]);
    expect(fake.subjects()).toHaveLength(3);
    expect(fake.objectsIn(schema)).toEqual(objectsBefore);
    const report = await lifecycle.finish({ compare: async () => goodDelta() });
    expect(report.outcome).toBe("POISONED");
    expect(report.cleanup).toMatchObject({ attempted: true, accepted: false, stopped: "not_admitted", refusal: reason });
    expect(report.cleanup.steps.map((step) => step.outcome)).toEqual(["confirmed", "refused_by_harness", ...Array.from({ length: 8 }, () => "not_attempted")]);
    expect(report.action).toContain("the final cleanup was started and not confirmed");
  });
});

describe("J, K, O, P, Q. cleanup admission and failure", () => {
  it("J. no cleanup after a case failure — a thrown body, a failed assertion the runner reports, or a missing case", async () => {
    const thrown = setup();
    thrown.arm();
    await thrown.lifecycle.runCase("one", async () => void thrown.charge("kept"));
    await expect(thrown.lifecycle.runCase("two", async () => Promise.reject(new Error("assertion failed")))).rejects.toThrow("assertion failed");
    expect(thrown.lifecycle.poisoned()).toBe('"two" failed');
    await thrown.lifecycle.runFinalCleanup(thrown.fake.db);
    expect(thrown.fake.log).toEqual([]);

    const reported = setup();
    reported.arm();
    await reported.runAllCases();
    reported.lifecycle.afterCase({ reportedFailed: true }); // the body resolved, but the runner failed the test
    await reported.lifecycle.runFinalCleanup(reported.fake.db);
    expect(reported.fake.log).toEqual([]);
    expect(reported.lifecycle.poisoned()).toBe("the test runner reported a test as failed");
    expect(reported.fake.subjects()).toHaveLength(3);

    const incomplete = setup();
    incomplete.arm();
    await incomplete.lifecycle.runCase("one", async () => void incomplete.charge("kept"));
    await incomplete.lifecycle.runFinalCleanup(incomplete.fake.db);
    expect(incomplete.fake.log).toEqual([]);
    expect(incomplete.lifecycle.poisoned()).toBe("the final cleanup was due before every expected case had completed");
    expect((await incomplete.lifecycle.finish({ compare: async () => goodDelta() })).notExecuted).toEqual(["two", "three"]);
  });

  it("K. no cleanup while case work is in flight — a running body, or an operation a case left unsettled", async () => {
    const running = setup();
    running.arm();
    await running.lifecycle.runCase("one", async () => void running.charge("kept"));
    await running.lifecycle.runCase("two", async () => undefined);
    let release = () => {};
    const body = running.lifecycle.runCase("three", () => new Promise<void>((resolve) => void (release = resolve)));
    await running.lifecycle.runFinalCleanup(running.fake.db);
    expect(running.fake.log).toEqual([]);
    expect(running.lifecycle.poisoned()).toBe('"three" was still running when the final cleanup was due');
    running.lifecycle.afterCase({ reportedFailed: false });
    release();
    await expect(body).rejects.toThrow(/poisoned/); // it settled, but the run stays poisoned and it is not counted
    expect(running.lifecycle.executed()).toEqual(["one", "two"]);

    const leaked = setup();
    leaked.arm();
    await expect(
      leaked.lifecycle.runCase("one", async () => {
        void leaked.lifecycle.write("a write nobody awaited", () => sleep(80)).catch(() => undefined);
      }),
    ).rejects.toThrow(/poisoned/);
    expect(leaked.lifecycle.poisoned()).toBe('"one" returned with 1 operation(s) still unsettled');
    expect(leaked.lifecycle.inFlightOperations()).toEqual(["a write nobody awaited"]);
    await leaked.lifecycle.runFinalCleanup(leaked.fake.db);
    expect(leaked.fake.log).toEqual([]);
  });

  const cleanupFailure = async (behavior: FakeBehavior, index = 3) => {
    const context = setup();
    context.arm();
    await context.runAllCases();
    // Plan: 0 inventory, 1 dependencies, 2-4 the three subject deletes, 5-6 object drops, 7 schema drop, 8-9 residue reads.
    context.fake.failWhen((_statement, at) => (at === index ? behavior : undefined));
    await expect(context.lifecycle.runFinalCleanup(context.fake.db)).rejects.toThrow(/final cleanup was/);
    const report = await context.lifecycle.finish({ compare: async () => Promise.reject(new Error("the comparison must not be read")) });
    return { ...context, report };
  };

  it("O. the database refuses a cleanup statement: the run poisons, the loop stops there, and nothing is retried", async () => {
    const { fake, report, lifecycle } = await cleanupFailure({ error: sqlError("57014") });
    expect(lifecycle.poisoned()).toBe("the final cleanup was incomplete (3 of 10 steps confirmed)");
    expect(fake.log).toHaveLength(4);
    expect(fake.writes().map((statement) => statement.kind)).toEqual(["delete_subject", "delete_subject"]);
    expect(report.outcome).toBe("POISONED");
    expect(report.cleanup.steps.map((step) => step.outcome)).toEqual(["confirmed", "confirmed", "confirmed", "refused_by_database", ...Array.from({ length: 6 }, () => "not_attempted")]);
    expect(report.cleanup.steps[3]).toMatchObject({ action: "delete_subject", sqlState: "57014" });
    expect(report.cleanup.summary).toMatchObject({ status: "incomplete", mayStillComplete: false });
    // PARTIAL cleanup, reported as exactly that: one subject's rows are gone, two remain, the scratch schema is untouched.
    expect(fake.subjects()).toHaveLength(2);
    expect(fake.schemaNames()).toHaveLength(1);
    expect(report.action).toContain("some run-owned rows or schemas may be gone and some may remain");
    expect(concludeProviderBudgetRun(report, { start: SAVED, final: SAVED }).pass).toBe(false);
  });

  it("O. a cleanup statement whose answer is lost (it DID apply) is uncertain — never confirmed, never repeated", async () => {
    const { fake, report } = await cleanupFailure({ error: new Error("fetch failed"), applied: true });
    expect(report.cleanup.steps[3]!.outcome).toBe("no_answer");
    expect(report.cleanup.summary).toMatchObject({ status: "uncertain", mayStillComplete: true });
    expect(fake.subjects()).toHaveLength(1); // it applied, but the harness does not know that and says so
    expect(fake.log).toHaveLength(4);
  });

  it("O. unexpected residue, an unexpected row on a delete, and a refused RESTRICT drop each stop the cleanup as not confirmed", async () => {
    const residue = await cleanupFailure({ rows: [{ n: 2 }] }, 8);
    expect(residue.report.cleanup.steps[8]).toMatchObject({ action: "read_subject_residue", outcome: "unexpected_answer", rows: 2 });
    expect(residue.report.cleanup.steps[9]!.outcome).toBe("not_attempted");
    expect(residue.lifecycle.poisoned()).toBe("the final cleanup was incomplete (8 of 10 steps confirmed)");

    const unreadable = await cleanupFailure({ rows: [{ n: "0" }] }, 9);
    expect(unreadable.report.cleanup.steps[9]).toMatchObject({ outcome: "unexpected_answer", rows: null });

    const foreignRow = await cleanupFailure({ rows: [{ bucket: "recipient_probe_day" }] }, 2);
    expect(foreignRow.report.cleanup.steps[2]).toMatchObject({ action: "delete_subject", outcome: "unexpected_answer" });
    expect(foreignRow.fake.writes()).toHaveLength(1);

    const restricted = await cleanupFailure({ error: sqlError("2BP01") }, 5);
    expect(restricted.report.cleanup.steps[5]).toMatchObject({ action: "drop_object", outcome: "refused_by_database", sqlState: "2BP01" });
    expect(restricted.fake.schemaNames()).toHaveLength(1);
  });

  it("O. the stand-in refuses what Postgres would: a schema that still holds an object, and any statement the plan cannot build", async () => {
    const fake = createFakeBudgetDb();
    fake.seedSchema(`pb_smoke_${RUN}_a`, [{ kind: "table", name: "real_provider_budgets" }]);
    await expect(fake.db.q(`DROP SCHEMA pb_smoke_${RUN}_a RESTRICT`)).rejects.toMatchObject({ code: "2BP01" });
    await expect(fake.db.q(`DROP TABLE pb_smoke_${RUN}_a.absent RESTRICT`)).rejects.toMatchObject({ code: "42P01" });
    await expect(fake.db.q(`DROP SCHEMA pb_smoke_${RUN}_b RESTRICT`)).rejects.toMatchObject({ code: "3F000" });
    for (const [text, params] of [
      [`DROP SCHEMA pb_smoke_${RUN}_a CASCADE`, []],
      ["DELETE FROM public.real_provider_budgets WHERE subject LIKE $1 RETURNING bucket", ["smoke-%"]],
      ["DELETE FROM public.real_provider_budgets", []],
      ["DELETE FROM public.real_rate_limits WHERE subject = $1 RETURNING bucket", ["x"]],
      [DELETE_SUBJECT_SQL, []],
      ["SELECT 1", []],
    ] as Array<[string, unknown[]]>) {
      await expect(fake.db.q(text, params), text).rejects.toThrow(/not allowed to send/);
    }
    expect(fake.log).toHaveLength(3);
  });

  it("P. a case that outlives its deadline: the run poisons while its operation is still in flight, and that operation's late success authorizes nothing", async () => {
    const { lifecycle, fake, ownership, arm } = setup({ caseDeadlineMs: 40 });
    arm();
    let lateResult: unknown = "pending";
    await expect(
      lifecycle.runCase("one", async () => {
        ownership.registerSubject("slow");
        lateResult = await lifecycle.write("a slow write", () => sleep(150).then(() => "applied")).catch((error: Error) => error.message);
      }),
    ).rejects.toThrow(/exceeded its deadline/);
    expect(lifecycle.poisoned()).toMatch(/"one" exceeded its 40 ms deadline/);
    // The deadline did not release it: it is still tracked, and so is the body.
    expect(lifecycle.inFlightOperations()).toEqual(["a slow write"]);
    expect(lifecycle.caseInFlight()).toBe("one");
    expect(() => ownership.registerSubject("after-timeout")).toThrow(/sealed/);
    const early = await lifecycle.finish({ compare: async () => goodDelta() });
    expect(early.inFlightOperations).toEqual(["a slow write", "case body: one"]);

    await sleep(200);
    expect(lifecycle.inFlightOperations()).toEqual([]);
    expect(lifecycle.caseInFlight()).toBeNull();
    // It DID apply — and its own caller is told the run is poisoned rather than handed the result.
    expect(lateResult).toMatch(/poisoned/);
    expect(lifecycle.state()).toBe("POISONED");
    let called = 0;
    await expect(lifecycle.runCase("two", async () => void (called += 1))).rejects.toThrow(/poisoned/);
    await expect(lifecycle.write("another write", async () => void (called += 1))).rejects.toThrow(/poisoned/);
    await lifecycle.runFinalCleanup(fake.db);
    expect(called).toBe(0);
    expect(fake.log).toEqual([]);
    expect(lifecycle.executed()).toEqual([]);
  });

  it("P. a request that never answers at all keeps the run poisoned and in flight for good", async () => {
    const { lifecycle, arm } = setup({ caseDeadlineMs: 30 });
    arm();
    await expect(lifecycle.runCase("one", () => lifecycle.consume("a budget request", () => new Promise<never>(() => undefined)))).rejects.toThrow(/exceeded its deadline/);
    await sleep(60);
    const report = await lifecycle.finish({ compare: async () => goodDelta() });
    expect(report.inFlightOperations).toEqual(["a budget request", "case body: one"]);
    expect(report.outcome).toBe("POISONED");
    expect(report.admissionTallies).toEqual({});
  });

  it("P, Q. a cleanup DELETE stalls past the cleanup deadline: the run poisons, the cleanup stays in flight until it settles, and NOT ONE further statement is sent", async () => {
    const { lifecycle, fake, arm, runAllCases } = setup({ cleanupDeadlineMs: 40 });
    arm();
    await runAllCases();
    fake.failWhen((_statement, at) => (at === 3 ? { stallMs: 150 } : undefined));
    await expect(lifecycle.runFinalCleanup(fake.db)).rejects.toThrow(/exceeded its deadline/);
    expect(lifecycle.poisoned()).toMatch(/the final cleanup exceeded its 40 ms deadline/);
    expect(lifecycle.cleanupInFlight()).toBe(true);
    expect(fake.pending()).toBe(1);
    const early = await lifecycle.finish({ compare: async () => goodDelta() });
    expect(early.inFlightOperations).toEqual(["the final cleanup"]);
    expect(early.cleanup.steps[3]!.outcome).toBe("in_flight");
    expect(early.cleanup.summary).toMatchObject({ status: "uncertain", mayStillComplete: true });

    await sleep(200);
    expect(lifecycle.cleanupInFlight()).toBe(false);
    expect(fake.settledAfterStall()).toHaveLength(1);
    // The stalled DELETE did complete — and nothing followed it: no next DELETE, no drop, no residue read.
    expect(fake.log).toHaveLength(4);
    const late = await lifecycle.finish({ compare: async () => goodDelta() });
    expect(late.cleanup.steps.map((step) => step.outcome)).toEqual(["confirmed", "confirmed", "confirmed", "confirmed", ...Array.from({ length: 6 }, () => "not_attempted")]);
    expect(late.cleanup).toMatchObject({ accepted: false, stopped: "switched_off" });
    expect(late.outcome).toBe("POISONED");
    // A second attempt after the late settlement sends nothing either.
    await lifecycle.runFinalCleanup(fake.db);
    expect(fake.log).toHaveLength(4);
  });

  it("Q. poison arriving while the cleanup runs stops it at the next step: no DELETE or DROP is sent after it", async () => {
    const { lifecycle, fake, arm, runAllCases } = setup();
    arm();
    await runAllCases();
    fake.failWhen((_statement, at) => (at === 2 ? (lifecycle.poison("poisoned from elsewhere"), undefined) : undefined));
    await expect(lifecycle.runFinalCleanup(fake.db)).rejects.toThrow(/final cleanup was incomplete/);
    expect(fake.writes()).toHaveLength(1); // the one already being sent; nothing after it
    expect(lifecycle.poisoned()).toBe("poisoned from elsewhere");
    const report = await lifecycle.finish({ compare: async () => goodDelta() });
    expect(report.cleanup).toMatchObject({ accepted: false, stopped: "switched_off" });
    expect(summarizeCleanup({ steps: [], stopped: null, refusal: null }).status).toBe("incomplete"); // an empty account is never "confirmed"
  });
});

describe("R, S, T. baseline plus expected delta", () => {
  const withTable = (name: string, value: DatabaseSnapshot["tables"][string]): DatabaseSnapshot => ({ ...AFTER, tables: { ...AFTER.tables, [name]: value } });
  const descriptor = (change: (draft: ProviderTableDescriptor) => void): ProviderTableDescriptor => {
    const draft = JSON.parse(JSON.stringify(EXPECTED_PROVIDER_TABLE)) as ProviderTableDescriptor;
    change(draft);
    return draft;
  };
  const compare = (overrides: Partial<Parameters<typeof compareWithExpectedDelta>[0]>) => compareWithExpectedDelta({ before: BEFORE, after: AFTER, providerTable: EXPECTED_PROVIDER_TABLE, ownedSchemas: [`pb_smoke_${RUN}_a`], ...overrides });

  it("R. the one expected difference — the new, empty, correctly shaped table — is recognized, and is never called a restoration", () => {
    const verdict = compare({});
    expect(verdict).toMatchObject({ ok: true, verdict: "baseline_plus_expected_delta", differences: [], expectedDelta: { tableAdded: "public.real_provider_budgets", rows: 0 } });
    expect(verdict.measured.length).toBeGreaterThan(0);
    expect(verdict.notMeasured).toContain("functions, sequences, views, types, and extensions");
    expect(JSON.stringify(verdict)).not.toMatch(/restored|identical to the baseline/i);
    // Constraint and index order is not significant.
    expect(compare({ providerTable: descriptor((draft) => void draft.constraints.reverse()) }).ok).toBe(true);
    expect(EXPECTED_PROVIDER_TABLE.columns.map((column) => column.name)).toEqual(["bucket", "subject", "window_start", "hits"]);
    expect(PROVIDER_BUDGET_BUCKETS).toHaveLength(6);
  });

  it("S. any other catalog difference fails", () => {
    const cases: Array<[string, Partial<Parameters<typeof compareWithExpectedDelta>[0]>, string]> = [
      ["an unexpected new table", { after: withTable("surprise", fingerprint("x")) }, "unexpected new table: surprise"],
      ["a pre-existing table removed", { after: { ...AFTER, tables: { real_rate_limits: BEFORE.tables.real_rate_limits!, payment_attempts: BEFORE.tables.payment_attempts!, real_provider_budgets: AFTER.tables.real_provider_budgets! } } }, "table removed: real_accounts"],
      ["a pre-existing table's shape changed", { after: withTable("real_accounts", { ...BEFORE.tables.real_accounts!, shapeDigest: "shape-altered" }) }, "catalog shape changed: real_accounts"],
      ["real_rate_limits' shape changed", { after: withTable("real_rate_limits", { ...BEFORE.tables.real_rate_limits!, shapeDigest: "shape-altered" }) }, "catalog shape changed: real_rate_limits"],
      ["the provider table is missing", { after: BEFORE }, "expected delta missing: public.real_provider_budgets does not exist after the run"],
      ["a run-owned scratch schema remains", { after: { ...AFTER, schemas: ["public", `pb_smoke_${RUN}_a`] } }, "a run-owned scratch schema remains"],
      ["an unrelated schema appeared", { after: { ...AFTER, schemas: ["public", "other"] } }, "the set of schemas changed"],
      ["a schema disappeared", { before: { ...BEFORE, schemas: ["public", "extra"] } }, "the set of schemas changed"],
      ["the provider table already existed", { before: { ...BEFORE, tables: { ...BEFORE.tables, real_provider_budgets: fingerprint("old", 0) } } }, "baseline: public.real_provider_budgets already existed before the run"],
      ["a scratch schema existed before the run", { before: { ...BEFORE, schemas: ["public", `pb_smoke_${RUN}_a`] } }, "baseline: a run-owned scratch schema existed before the run"],
      ["real_rate_limits was not measured", { before: { ...BEFORE, tables: { real_accounts: BEFORE.tables.real_accounts!, payment_attempts: BEFORE.tables.payment_attempts! } } }, "baseline: public.real_rate_limits was not measured before the run"],
      ["an extra constraint on the new table", { providerTable: descriptor((draft) => void draft.constraints.push({ name: "extra_check", type: "c", columns: ["hits"] })) }, "does not match the intended descriptor"],
      ["a wrong column type", { providerTable: descriptor((draft) => void (draft.columns[3]!.type = "bigint")) }, "does not match the intended descriptor"],
      ["a missing collation", { providerTable: descriptor((draft) => void (draft.columns[0]!.collation = null)) }, "does not match the intended descriptor"],
      ["a wrong primary-key order", { providerTable: descriptor((draft) => void (draft.constraints[2]!.columns = ["subject", "bucket"])) }, "does not match the intended descriptor"],
      ["a second index", { providerTable: descriptor((draft) => void draft.indexes.push("extra_idx")) }, "does not match the intended descriptor"],
      ["a trigger", { providerTable: descriptor((draft) => void (draft.triggers = 1)) }, "does not match the intended descriptor"],
      ["an inbound foreign key", { providerTable: descriptor((draft) => void (draft.foreignKeysIn = 1)) }, "does not match the intended descriptor"],
      ["row security", { providerTable: descriptor((draft) => void (draft.rowSecurity = true)) }, "does not match the intended descriptor"],
      ["an unreadable descriptor", { providerTable: null }, "does not match the intended descriptor"],
      ["a malformed snapshot", { after: { tables: { real_accounts: { rows: -1 } }, schemas: [] } }, "a snapshot is missing or malformed"],
      ["no snapshot", { before: undefined }, "a snapshot is missing or malformed"],
    ];
    for (const [what, overrides, difference] of cases) {
      const verdict = compare(overrides);
      expect(verdict.ok, what).toBe(false);
      expect(verdict.verdict, what).toBe("delta_mismatch");
      expect(verdict.differences.join(" | "), what).toContain(difference);
    }
  });

  it("T. a content difference in any pre-existing table fails — rows or digest — and so do rows left in the new table", () => {
    for (const [what, overrides, difference] of [
      ["one more payment", { after: withTable("payment_attempts", { ...BEFORE.tables.payment_attempts!, rows: 21 }) }, "contents changed: payment_attempts"],
      ["a changed account, same count", { after: withTable("real_accounts", { ...BEFORE.tables.real_accounts!, contentDigest: "content-edited" }) }, "contents changed: real_accounts"],
      ["a Slice E counter touched", { after: withTable("real_rate_limits", { ...BEFORE.tables.real_rate_limits!, rows: 1, contentDigest: "content-one" }) }, "contents changed: real_rate_limits"],
      ["a leftover budget row", { after: withTable("real_provider_budgets", { rows: 2, contentDigest: "x", shapeDigest: "shape-new" }) }, "expected delta wrong: public.real_provider_budgets is not empty"],
      ["a descriptor that reports rows", { providerTable: descriptor((draft) => void (draft.rows = 1)) }, "does not match the intended descriptor"],
    ] as Array<[string, Partial<Parameters<typeof compareWithExpectedDelta>[0]>, string]>) {
      const verdict = compare(overrides);
      expect(verdict.ok, what).toBe(false);
      expect(verdict.differences.join(" | "), what).toContain(difference);
    }
  });

  it("an unreadable comparison poisons instead of passing", async () => {
    const { lifecycle, fake, arm, runAllCases } = setup();
    arm();
    await runAllCases();
    await lifecycle.runFinalCleanup(fake.db);
    const report = await lifecycle.finish({ compare: () => Promise.reject(new Error("fetch failed")) });
    expect(report).toMatchObject({ outcome: "POISONED", poisoned: "the post-run comparison could not be read", delta: null });
  });
});

describe("U, V, W, X, Y. evidence", () => {
  const root = mkdtempSync(path.join(tmpdir(), "provider-budget-evidence-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  let counter = 0;
  const directory = () => path.join(root, `run-${(counter += 1)}`);
  const startEvidence = { runId: RUN, server: { version: "18.6", isolation: "read committed" }, connectionMode: "pooled", migrationStatementSha256: sha256Hex("the migration statement"), expectedCases: [...CASES], fingerprintsBefore: BEFORE };

  async function cleanReport() {
    const { lifecycle, fake, ownership, arm, runAllCases } = setup();
    arm();
    await runAllCases();
    await lifecycle.runFinalCleanup(fake.db);
    return lifecycle.finish({ compare: async () => goodDelta(ownership.ownedSchemas()) });
  }

  it("U. an incomplete record is not written, and a clean run without BOTH saved records is not a pass", async () => {
    const report = await cleanReport();
    const complete = finalEvidence(report);
    expect(missingEvidenceFields("final", complete)).toEqual([]);
    expect(missingEvidenceFields("start", startEvidence)).toEqual([]);
    expect(missingEvidenceFields("final", startEvidence).length).toBeGreaterThan(5);
    expect(missingEvidenceFields("final", null)).toEqual([...FINAL_EVIDENCE_FIELDS]);
    expect(missingEvidenceFields("final", { ...complete, migrationStatementSha256: "abc" })).toEqual(["migrationStatementSha256"]);
    expect(missingEvidenceFields("final", { ...complete, runId: "nope" })).toEqual(["runId"]);
    expect(missingEvidenceFields("final", { ...complete, expectedDelta: null })).toEqual([]); // null is an answer; absent is not
    for (const field of FINAL_EVIDENCE_FIELDS) {
      const partial: Record<string, unknown> = { ...complete };
      delete partial[field];
      const target = directory();
      expect(writeProviderBudgetEvidence({ directory: target, runId: RUN, stage: "final", evidence: partial }), field).toEqual({ ok: false, reason: "incomplete", code: null });
      expect(() => readdirSync(target), field).toThrow(); // nothing was created, not even the directory
    }
    expect(writeProviderBudgetEvidence({ directory: directory(), runId: "ffffffff", stage: "final", evidence: complete })).toEqual({ ok: false, reason: "incomplete", code: null }); // another run's record
    expect(writeProviderBudgetEvidence({ directory: directory(), runId: "../../x", stage: "final", evidence: complete })).toEqual({ ok: false, reason: "invalid_run_id", code: null });

    const incomplete: EvidenceWrite = { ok: false, reason: "incomplete", code: null };
    expect(concludeProviderBudgetRun(report, { start: SAVED, final: incomplete })).toMatchObject({ pass: false, verdict: "clean_but_not_evidenced" });
    expect(concludeProviderBudgetRun(report, { start: NOT_SAVED, final: SAVED })).toMatchObject({ pass: false, verdict: "clean_but_not_evidenced" });
    expect(concludeProviderBudgetRun(report, { start: SAVED, final: SAVED }).pass).toBe(true);
  });

  it("V, X. a record is one new owner-only file in an owner-only directory, and an existing file is never overwritten", async () => {
    const target = directory();
    const first = writeProviderBudgetEvidence({ directory: target, runId: RUN, stage: "start", evidence: startEvidence });
    expect(first).toEqual({ ok: true, file: path.join(target, `provider-budget-smoke-${RUN}-start.json`) });
    expect(statSync(target).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(target, `provider-budget-smoke-${RUN}-start.json`)).mode & 0o777).toBe(0o600);
    const original = readFileSync(path.join(target, `provider-budget-smoke-${RUN}-start.json`), "utf8");
    expect(JSON.parse(original)).toEqual(startEvidence);

    expect(writeProviderBudgetEvidence({ directory: target, runId: RUN, stage: "start", evidence: { ...startEvidence, connectionMode: "changed" } })).toEqual({ ok: false, reason: "already_exists", code: "EEXIST" });
    expect(readFileSync(path.join(target, `provider-budget-smoke-${RUN}-start.json`), "utf8")).toBe(original);

    // The final record is its own file beside it.
    const final = writeProviderBudgetEvidence({ directory: target, runId: RUN, stage: "final", evidence: finalEvidence(await cleanReport()) });
    expect(final.ok).toBe(true);
    expect(readdirSync(target).sort()).toEqual([`provider-budget-smoke-${RUN}-final.json`, `provider-budget-smoke-${RUN}-start.json`]);
    expect(statSync(path.join(target, `provider-budget-smoke-${RUN}-final.json`)).mode & 0o777).toBe(0o600);
  });

  it("X. a directory that others can enter is refused — never re-permissioned — and nothing is written into it", () => {
    const open = directory();
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    expect(writeProviderBudgetEvidence({ directory: open, runId: RUN, stage: "start", evidence: startEvidence })).toEqual({ ok: false, reason: "directory_not_private", code: null });
    expect(readdirSync(open)).toEqual([]);
    expect(statSync(open).mode & 0o777).toBe(0o755);
  });

  it("W. credential-like material is refused by the content screen, and no file is created", () => {
    for (const [what, poisonValue] of [
      ["a connection string", "postgresql://app:pw@ep-branch-000002-pooler.c-1.neon.invalid/neondb"],
      ["an endpoint id", "ep-quiet-forest-12345678"],
      ["a pooled hostname", "something-pooler"],
      ["a password", "password=hunter2"],
      ["an API key", "api_key: abc"],
      ["a signing secret", "the signing secret"],
      ["a private key", "private-key material"],
      ["a bearer token", "Bearer abc.def"],
      ["a session token", "token=abc"],
      ["a provider credential", "turnkey credential"],
    ] as const) {
      const target = directory();
      expect(writeProviderBudgetEvidence({ directory: target, runId: RUN, stage: "start", evidence: { ...startEvidence, server: { note: poisonValue } } }), what).toEqual({ ok: false, reason: "unsafe_content", code: null });
      expect(() => readdirSync(target), what).toThrow();
    }
    const circular: Record<string, unknown> = { ...startEvidence };
    circular.self = circular;
    expect(writeProviderBudgetEvidence({ directory: directory(), runId: RUN, stage: "start", evidence: circular })).toEqual({ ok: false, reason: "unsafe_content", code: null });
  });

  it("Y. a failed run's evidence is complete and saved — and saving it never makes the run clean", async () => {
    const { lifecycle, fake, arm, charge } = setup();
    arm();
    await lifecycle.runCase("one", async () => void charge("kept"));
    await expect(lifecycle.runCase("two", () => lifecycle.consume("a budget request", () => Promise.reject(new Error("fetch failed"))))).rejects.toThrow();
    lifecycle.afterCase({ reportedFailed: true });
    await lifecycle.runFinalCleanup(fake.db);
    const report = await lifecycle.finish({ compare: async () => goodDelta() });
    expect(report).toMatchObject({ outcome: "POISONED", verdict: "poisoned_evidence_preserved", executed: ["one"], notExecuted: ["two", "three"], unknownOperations: ["a budget request"], delta: null });
    // The database fixtures are preserved: nothing was deleted.
    expect(fake.log).toEqual([]);
    expect(fake.subjects()).toEqual(report.ownedSubjects);

    const evidence = finalEvidence(report);
    expect(missingEvidenceFields("final", evidence)).toEqual([]);
    const target = directory();
    const saved = writeProviderBudgetEvidence({ directory: target, runId: RUN, stage: "final", evidence });
    expect(saved.ok).toBe(true);
    const onDisk = JSON.parse(readFileSync(path.join(target, `provider-budget-smoke-${RUN}-final.json`), "utf8")) as Record<string, unknown>;
    expect(onDisk).toMatchObject({ lifecycleOutcome: "POISONED", verdict: "poisoned_evidence_preserved", poisoned: "no usable answer for a budget request (a budget request); it may or may not have been charged", casesNotExecuted: ["two", "three"] });
    expect(concludeProviderBudgetRun(report, { start: SAVED, final: saved })).toMatchObject({ pass: false, verdict: "not_clean" });
    expect(concludeProviderBudgetRun(report, { start: SAVED, final: saved }).message).toContain("POISONED");
  });
});

// ------------------------------------------------------------------ Stage 2 integration fixes (regressions)

describe("integration fix 1: the runner's timeout flags can never undercut the run's own deadlines", () => {
  const FILE = PROVIDER_BUDGET_SMOKE_FILE;

  it("no timeout flag, or flags of at least the runner timeout, are accepted", () => {
    for (const args of [["run", FILE], ["run", FILE, "--testTimeout=120000"], ["run", FILE, "--testTimeout=120000", "--hookTimeout=120000"], ["run", FILE, "--hookTimeout=600000"], ["run", FILE, "--testTimeout=000120000"]]) {
      expect(checkRunnerTimeoutFlags(args), JSON.stringify(args)).toEqual({ ok: true });
    }
  });

  it("a shorter flag is refused — including the older smokes' 30000", () => {
    for (const args of [["run", FILE, "--testTimeout=30000", "--hookTimeout=30000"], ["run", FILE, "--testTimeout=119999"], ["run", FILE, "--testTimeout=120000", "--hookTimeout=30000"], ["run", FILE, "--hookTimeout=0"]]) {
      const check = checkRunnerTimeoutFlags(args);
      expect(check.ok, JSON.stringify(args)).toBe(false);
      if (!check.ok) expect(check.reason).toMatch(/must be at least 120000 ms/);
    }
  });

  it("every other spelling of a timeout option is refused, never interpreted: separated values, kebab-case, other options, malformed and repeated flags", () => {
    const refused: string[][] = [
      ["run", FILE, "--testTimeout", "30000"],
      ["run", FILE, "--testTimeout", "999999"],
      ["run", FILE, "--hookTimeout", "30000"],
      ["run", FILE, "--test-timeout=30000"],
      ["run", FILE, "--test-timeout=999999"],
      ["run", FILE, "--hook-timeout", "1"],
      ["run", FILE, "--testTimeout"],
      ["run", FILE, "--testTimeout="],
      ["run", FILE, "--testTimeout=abc"],
      ["run", FILE, "--testTimeout=1e9"],
      ["run", FILE, "--testTimeout=-1"],
      ["run", FILE, "--testTimeout=120000ms"],
      ["run", FILE, "--testTimeout=1234567890123"],
      ["run", FILE, "-testTimeout=120000"],
      ["run", FILE, "--TESTTIMEOUT=120000"],
      ["run", FILE, "--teardownTimeout=1"],
      ["run", FILE, "--poolOptions.forks.timeout=1"],
      ["run", FILE, "--no-testTimeout"],
      // Repeated or conflicting: which one a runner honours is not something to guess.
      ["run", FILE, "--testTimeout=120000", "--testTimeout=30000"],
      ["run", FILE, "--testTimeout=30000", "--testTimeout=120000"],
      ["run", FILE, "--hookTimeout=120000", "--hookTimeout=120000"],
    ];
    for (const args of refused) expect(checkRunnerTimeoutFlags(args).ok, JSON.stringify(args)).toBe(false);
    for (const args of [undefined, null, "run", ["run", 5], [["--testTimeout=1"]]]) expect(checkRunnerTimeoutFlags(args).ok, JSON.stringify(args)).toBe(false);
  });

  it("is independent of the exact-file rule, which separately refuses the separated and kebab forms", () => {
    expect(checkProviderBudgetFileSelection(["run", FILE, "--testTimeout=30000"])).toEqual({ ok: true }); // the file rule alone would let a short flag through
    expect(checkRunnerTimeoutFlags(["run", FILE, "--testTimeout=30000"]).ok).toBe(false);
    for (const args of [["run", FILE, "--testTimeout", "999999"], ["run", FILE, "--test-timeout=999999"]]) {
      expect(checkProviderBudgetFileSelection(args).ok, JSON.stringify(args)).toBe(false);
      expect(checkRunnerTimeoutFlags(args).ok, JSON.stringify(args)).toBe(false);
    }
  });
});

describe("integration fix 2: there is no preflight without a deadline", () => {
  it("a preflight that is begun and never armed poisons at its deadline — whether or not anyone awaits it", async () => {
    const { lifecycle } = setup({ preflightDeadlineMs: 30 });
    lifecycle.beginPreflight();
    expect(lifecycle.state()).toBe("PREFLIGHT");
    await sleep(70);
    expect(lifecycle.state()).toBe("POISONED");
    expect(lifecycle.poisoned()).toBe("the preflight exceeded its 30 ms deadline; a read it issued may still be running");
    for (const check of CHECKS) expect(() => lifecycle.preflightCheck(check, true)).toThrow(/poisoned/);
    expect(() => lifecycle.arm({ startEvidence: SAVED })).toThrow(/poisoned/);
    let called = 0;
    await expect(lifecycle.read("a late read", async () => void (called += 1))).rejects.toThrow(/poisoned/);
    await expect(lifecycle.runCase("one", async () => void (called += 1))).rejects.toThrow(/poisoned/);
    expect(called).toBe(0);
  });

  it("the deadline defaults to the case deadline, and a non-positive one is refused", async () => {
    const { lifecycle } = setup({ caseDeadlineMs: 30 });
    lifecycle.beginPreflight();
    await sleep(70);
    expect(lifecycle.poisoned()).toMatch(/the preflight exceeded its 30 ms deadline/);
    expect(() => createProviderBudgetLifecycle({ expectedCases: CASES, requiredPreflightChecks: CHECKS, caseDeadlineMs: 10, cleanupDeadlineMs: 10, preflightDeadlineMs: 0, ownership: createRunOwnership(RUN) })).toThrow(/deadline/);
  });

  it("arming stops the clock: a run armed in time is not poisoned when the preflight deadline later passes", async () => {
    const { lifecycle } = setup({ preflightDeadlineMs: 40 });
    await lifecycle.runPreflight(async () => {
      expect(await lifecycle.read("a preflight read", async () => 1)).toBe(1);
      for (const check of CHECKS) lifecycle.preflightCheck(check, true);
      lifecycle.arm({ startEvidence: SAVED });
    });
    expect(lifecycle.preflightInFlight()).toBe(false);
    await sleep(90);
    expect(lifecycle.state()).toBe("ARMED");
    await lifecycle.runCase("one", async () => undefined);
  });

  it("runPreflight rejects AT the deadline while a read is still running; the abandoned body stays in flight, and what it does after settling arms nothing and reads nothing", async () => {
    const { lifecycle, fake } = setup({ preflightDeadlineMs: 40 });
    const late = { armError: "", readsAfter: 0, settled: false };
    await expect(
      lifecycle.runPreflight(async () => {
        await lifecycle.read("a slow baseline read", () => sleep(150)).catch(() => undefined);
        // Everything below runs AFTER the deadline, in a body nobody is awaiting any more.
        await lifecycle.read("another read", async () => void (late.readsAfter += 1)).catch(() => undefined);
        try {
          for (const check of CHECKS) lifecycle.preflightCheck(check, true);
          lifecycle.arm({ startEvidence: SAVED });
        } catch (error) {
          late.armError = (error as Error).message;
        }
        late.settled = true;
      }),
    ).rejects.toThrow(/preflight exceeded its deadline/);
    expect(lifecycle.state()).toBe("POISONED");
    expect(lifecycle.preflightInFlight()).toBe(true);
    expect(lifecycle.inFlightOperations()).toEqual(["a slow baseline read"]);
    const early = await lifecycle.finish({ compare: async () => goodDelta() });
    expect(early).toMatchObject({ outcome: "POISONED", inFlightOperations: ["a slow baseline read", "the preflight"] });

    await sleep(200);
    expect(late).toEqual({ armError: expect.stringMatching(/poisoned/), readsAfter: 0, settled: true });
    expect(lifecycle.preflightInFlight()).toBe(false);
    expect(lifecycle.inFlightOperations()).toEqual([]);
    expect(lifecycle.state()).toBe("POISONED");
    let called = 0;
    await expect(lifecycle.runCase("one", async () => void (called += 1))).rejects.toThrow(/poisoned/);
    await lifecycle.runFinalCleanup(fake.db);
    expect(called).toBe(0);
    expect(fake.log).toEqual([]);
  });

  it("a preflight body that throws, or that ends without arming, poisons; a second preflight is refused", async () => {
    const thrown = setup().lifecycle;
    await expect(thrown.runPreflight(async () => Promise.reject(new Error("the baseline could not be read")))).rejects.toThrow("the baseline could not be read");
    expect(thrown.poisoned()).toBe("the preflight failed");

    const unarmed = setup().lifecycle;
    await expect(unarmed.runPreflight(async () => undefined)).rejects.toThrow(/poisoned/);
    expect(unarmed.poisoned()).toBe("the preflight ended without arming the run");

    const failedRead = setup().lifecycle;
    await expect(failedRead.runPreflight(() => failedRead.read("the baseline", () => Promise.reject(sqlError("42501"))))).rejects.toThrow();
    expect(failedRead.poisoned()).toBe("the database refused the baseline (SQLSTATE 42501)");

    const twice = setup();
    await twice.lifecycle.runPreflight(async () => {
      for (const check of CHECKS) twice.lifecycle.preflightCheck(check, true);
      twice.lifecycle.arm({ startEvidence: SAVED });
    });
    await expect(twice.lifecycle.runPreflight(async () => undefined)).rejects.toThrow(/poisoned/);
    expect(twice.lifecycle.poisoned()).toBe("the preflight was started twice");
  });
});

describe("integration fix 3: the post-run comparison is tracked, read-only, and bounded", () => {
  async function cleanedUp(deadlines: Parameters<typeof setup>[0] = {}) {
    const context = setup(deadlines);
    context.arm();
    await context.runAllCases();
    await context.lifecycle.runFinalCleanup(context.fake.db);
    return context;
  }

  it("its reads go through the lifecycle: counted, in flight while they run, and a clean verdict still needs every one of them answered", async () => {
    const { lifecycle } = await cleanedUp();
    const issuedBefore = lifecycle.operationsIssued();
    let seenInFlight: string[] = [];
    const report = await lifecycle.finish({
      compare: async (read) => {
        const before = await read("the post-run snapshot", async () => (seenInFlight = lifecycle.inFlightOperations(), BEFORE));
        await read("the provider table descriptor", async () => EXPECTED_PROVIDER_TABLE);
        return compareWithExpectedDelta({ before, after: AFTER, providerTable: EXPECTED_PROVIDER_TABLE, ownedSchemas: [] });
      },
    });
    expect(seenInFlight).toEqual(["the post-run snapshot"]);
    expect(lifecycle.operationsIssued()).toBe(issuedBefore + 2);
    expect(report).toMatchObject({ outcome: "COMPLETED_CLEAN", inFlightOperations: [] });
    // The run is over: nothing may be read or written afterwards.
    let called = 0;
    await expect(lifecycle.read("a read after the end", async () => void (called += 1))).rejects.toThrow(/poisoned/);
    expect(called).toBe(0);
  });

  it("a write attempted during the comparison is refused before it is called, and poisons", async () => {
    const { lifecycle } = await cleanedUp();
    let called = 0;
    const report = await lifecycle.finish({
      compare: async () => {
        await lifecycle.write("a repair", async () => void (called += 1));
        return goodDelta();
      },
    });
    expect(called).toBe(0);
    expect(report).toMatchObject({ outcome: "POISONED", poisoned: "a write (a repair) was attempted during the post-run comparison", delta: null });
  });

  it("a comparison read the database refuses, or never answers, poisons with that reason — never a pass", async () => {
    const refused = await cleanedUp();
    const first = await refused.lifecycle.finish({ compare: async (read) => (await read("the post-run snapshot", () => Promise.reject(sqlError("57014"))), goodDelta()) });
    expect(first).toMatchObject({ outcome: "POISONED", poisoned: "the database refused the post-run snapshot (SQLSTATE 57014)" });

    const lost = await cleanedUp();
    const second = await lost.lifecycle.finish({ compare: async (read) => (await read("the post-run snapshot", () => Promise.reject(new Error("fetch failed"))), goodDelta()) });
    expect(second).toMatchObject({ outcome: "POISONED", unknownOperations: ["the post-run snapshot"] });
  });

  it("a comparison that outlives its deadline poisons; its read stays in flight until it settles, and nothing it does afterwards is sent", async () => {
    const { lifecycle } = await cleanedUp();
    let readsAfter = 0;
    let comparisons = 0;
    const compare = async (read: <T>(what: string, operation: () => Promise<T>) => Promise<T>) => {
      comparisons += 1;
      await read("a slow post-run snapshot", () => sleep(150)).catch(() => undefined);
      await read("another read", async () => void (readsAfter += 1)).catch(() => undefined);
      return goodDelta(); // a late "everything is fine" must change nothing
    };
    const report = await lifecycle.finish({ compare, deadlineMs: 40 });
    expect(report).toMatchObject({ outcome: "POISONED", verdict: "poisoned_evidence_preserved", poisoned: "the post-run comparison exceeded its 40 ms deadline; a read it issued may still be running", delta: null });
    expect(report.inFlightOperations).toEqual(["a slow post-run snapshot", "the post-run comparison"]);
    expect(concludeProviderBudgetRun(report, { start: SAVED, final: SAVED }).pass).toBe(false);

    await sleep(200);
    expect(readsAfter).toBe(0);
    expect(lifecycle.inFlightOperations()).toEqual([]);
    const again = await lifecycle.finish({ compare });
    expect(comparisons).toBe(1); // a poisoned run never compares again
    expect(again).toMatchObject({ outcome: "POISONED", inFlightOperations: [] });
    expect(lifecycle.state()).toBe("POISONED");
  });

  it("the deadline defaults to the cleanup deadline, and a non-positive one is refused", async () => {
    const { lifecycle } = await cleanedUp({ cleanupDeadlineMs: 40 });
    const report = await lifecycle.finish({ compare: (read) => read("a slow post-run snapshot", () => sleep(120)).then(() => goodDelta()) });
    expect(report.poisoned).toBe("the post-run comparison exceeded its 40 ms deadline; a read it issued may still be running");
    await expect(lifecycle.finish({ compare: async () => goodDelta(), deadlineMs: 0 })).rejects.toThrow(/deadline/);
    await sleep(120);
  });
});
