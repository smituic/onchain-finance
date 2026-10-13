// @vitest-environment node
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFakeBudgetDb } from "./fixtures/provider-budget-fake-db";
import {
  EXPECTED_PROVIDER_TABLE,
  caseFailedInVitest,
  compareWithExpectedDelta,
  concludeProviderBudgetRun,
  createProviderBudgetLifecycle,
  createRunOwnership,
  sha256Hex,
  writeProviderBudgetEvidence,
  type DatabaseSnapshot,
  type EvidenceWrite,
  type FinalReport,
} from "./fixtures/provider-budget-smoke";

/**
 * OFFLINE — never a live test, never a database, never a provider. Two halves:
 *
 *   1. THE PROBE (bottom): the provider-budget smoke's real lifecycle,
 *      ownership registry, cleanup, comparison, and evidence writer, wired to
 *      Vitest with the SAME hook lines the smoke uses, over an in-memory
 *      stand-in. It runs only in a CHILD Vitest process, when
 *      PROVIDER_BUDGET_LIFECYCLE_PROBE names a scenario, and writes one JSON
 *      report for its parent.
 *   2. THE PARENT (top): runs that probe, and the smoke file itself, in child
 *      Vitest processes, to establish how the REAL test runner behaves — what
 *      a hook sees after an assertion failure, what happens when the runner's
 *      own timeout abandons a test or a hook that is still working, which
 *      timeout governs a test that carries its own, and that every refused
 *      configuration of the smoke fails before any connection.
 *
 * Child runs of the smoke use synthetic `.invalid` hosts only and are refused
 * before a connector is built; none is ever fully valid. Timings are scaled
 * down from the smoke's (120 s / 90 s / 60 s) but keep the same ORDER in each
 * scenario: which of the run's own deadline and the runner's timeout comes
 * first is what each scenario is about.
 */
const PROBE = "test/lib/real/provider-budget-lifecycle.probe.test.ts";
const SMOKE = "test/lib/real/provider-budget.smoke.test.ts";
const GATE = "REAL_SMOKE_PROVIDER_BUDGET";
const SCENARIO_ENV = "PROVIDER_BUDGET_LIFECYCLE_PROBE";
const DIR_ENV = "PROVIDER_BUDGET_LIFECYCLE_PROBE_DIR";
const RUN = "0a1b2c3d";
const SLOW_MS = 1_200;
const PROCESS_TIMEOUT_MS = 120_000;

type Scenario = {
  /** The runner's timeout for every test, and for the beforeAll hook. */
  timeoutMs: number;
  caseDeadlineMs: number;
  cleanupDeadlineMs: number;
  preflightDeadlineMs: number;
  verifyDeadlineMs: number;
  /** The runner's timeout for the afterAll hook. Generous unless the scenario is about that hook being abandoned. */
  endHookTimeoutMs: number;
  stall?: "case" | "cleanup" | "preflight" | "compare";
  /** The stalled operation never answers at all (so nothing can happen "later" in a process that is about to end). */
  never?: boolean;
  fail?: "inside" | "outside";
};
const GENEROUS: Scenario = { timeoutMs: 5_000, caseDeadlineMs: 4_000, cleanupDeadlineMs: 3_000, preflightDeadlineMs: 4_000, verifyDeadlineMs: 3_000, endHookTimeoutMs: 10_000 };
const SCENARIOS: Record<string, Scenario> = {
  success: GENEROUS,
  /** An assertion fails INSIDE case two's body, after it created a fixture. */
  assert_inside: { ...GENEROUS, fail: "inside" },
  /** Case two's body succeeds; the TEST around it then fails. Only the runner knows. */
  assert_outside: { ...GENEROUS, fail: "outside" },
  /** The RUNNER gives up on case two first: its body is abandoned while a write is still running. */
  runner_abandons_case: { ...GENEROUS, timeoutMs: 300, caseDeadlineMs: 30_000, stall: "case" },
  /** The run's own case deadline fires first. */
  case_deadline: { ...GENEROUS, caseDeadlineMs: 150, stall: "case" },
  /** The RUNNER gives up on the cleanup test while a DELETE is still running. */
  runner_abandons_cleanup: { ...GENEROUS, timeoutMs: 300, cleanupDeadlineMs: 30_000, stall: "cleanup" },
  /** The run's own cleanup deadline fires first. */
  cleanup_deadline: { ...GENEROUS, cleanupDeadlineMs: 150, stall: "cleanup" },
  /** A preflight read stalls past the preflight deadline. */
  preflight_deadline: { ...GENEROUS, preflightDeadlineMs: 150, stall: "preflight" },
  /** A post-run comparison read stalls past the comparison deadline. */
  compare_deadline: { ...GENEROUS, verifyDeadlineMs: 150, stall: "compare" },
  /** The RUNNER gives up on the afterAll HOOK while the comparison is still reading — what the comparison deadline exists to prevent. */
  runner_abandons_end_hook: { ...GENEROUS, verifyDeadlineMs: 30_000, endHookTimeoutMs: 300, stall: "compare", never: true },
};

const scenarioName = process.env[SCENARIO_ENV];
const settings = scenarioName !== undefined && Object.hasOwn(SCENARIOS, scenarioName) ? SCENARIOS[scenarioName]! : null;
const probeDirectory = process.env[DIR_ENV] ?? "";

const fingerprint = (seed: string, rows = 3) => ({ rows, contentDigest: `content-${seed}`, shapeDigest: `shape-${seed}` });
const BEFORE: DatabaseSnapshot = { tables: { real_accounts: fingerprint("accounts"), real_rate_limits: fingerprint("limits", 0) }, schemas: ["public"] };
const AFTER: DatabaseSnapshot = { tables: { ...BEFORE.tables, real_provider_budgets: { rows: 0, contentDigest: "", shapeDigest: "shape-new" } }, schemas: ["public"] };

// ====================================================================== the parent: real child Vitest processes

type ProbeReport = {
  final: FinalReport;
  startSaved: EvidenceWrite;
  finalSaved: EvidenceWrite;
  verdict: { pass: boolean; verdict: string };
  atStart: Array<{ test: string; state: string; poisoned: string | null; statements: number }>;
  bodiesStarted: string[];
  log: Array<{ kind: string; target: string }>;
  writes: number;
  remaining: { subjects: string[]; schemas: string[] };
  /** What was true AFTER waiting for everything that had been abandoned to settle. */
  late: { waited: boolean; state: string; poisoned: string | null; inFlight: string[]; caseInFlight: string | null; cleanupInFlight: boolean; statements: number; writes: number; lateWrite: string; lateCase: string; lateRegistration: string };
};

/** A child Vitest run with ONLY the given smoke/probe/database variables: every inherited gate, target, and credential is dropped first. */
function runVitest(args: string[], extra: Record<string, string>): Promise<{ code: number; output: string }> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || /^(VITEST|REAL_SMOKE_|REAL_ADMIN_|NEON_|DATABASE_URL$|TURNKEY_|PIMLICO_|PROVISIONING_LIFECYCLE_|PROVIDER_BUDGET_)/.test(name)) continue;
    env[name] = value;
  }
  return new Promise((resolve) => {
    execFile(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...args], { env: { ...env, ...extra } as NodeJS.ProcessEnv, timeout: PROCESS_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, output: `${stdout}\n${stderr}`.replace(/\x1b\[[0-9;]*m/g, "") });
    });
  });
}

/** Runs one probe scenario in a child Vitest, in a temporary directory of its own, and reads what it left there. */
async function probe(scenario: string, options: { cliFlags?: string[]; prepare?: (evidenceDirectory: string) => void; expectReport?: boolean } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "provider-budget-probe-"));
  const evidenceDirectory = path.join(directory, "evidence");
  try {
    options.prepare?.(evidenceDirectory);
    const { code, output } = await runVitest([PROBE, ...(options.cliFlags ?? [])], { [SCENARIO_ENV]: scenario, [DIR_ENV]: directory });
    const reportPath = path.join(directory, "report.json");
    if (options.expectReport !== false && !existsSync(reportPath)) throw new Error(`the lifecycle probe wrote no report for "${scenario}" (exit ${code}): ${output.slice(-900)}`);
    expect(output, "no unhandled rejection or error may escape the child run").not.toMatch(/Unhandled (Rejection|Error)/i);
    const files = existsSync(evidenceDirectory) ? readdirSync(evidenceDirectory).sort() : [];
    const evidence = Object.fromEntries(files.map((name) => [name, readFileSync(path.join(evidenceDirectory, name), "utf8")]));
    return { code, output, report: existsSync(reportPath) ? (JSON.parse(readFileSync(reportPath, "utf8")) as ProbeReport) : null, evidenceFiles: files, evidence };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
const START_FILE = `provider-budget-smoke-${RUN}-start.json`;
const FINAL_FILE = `provider-budget-smoke-${RUN}-final.json`;
const startOf = (report: ProbeReport, test: string) => report.atStart.find((entry) => entry.test === test)!;
const SUBJECT = (suffix: string) => `smoke-${RUN}-pb-${suffix}`;

// Sequential on purpose: this many child Vitest processes at once would starve the rest of an ordinary full run.
describe.skipIf(scenarioName !== undefined)("the provider-budget lifecycle under the REAL test runner (in-memory stand-in, child processes — no database of any kind)", () => {
  it("the probe is wired with the SAME hook lines as the smoke, and is skipped unless a scenario is named", async () => {
    const smoke = readFileSync(SMOKE, "utf8");
    const probeSource = readFileSync(PROBE, "utf8");
    for (const line of [
      "  afterEach((context) => lifecycle.afterCase({ reportedFailed: caseFailedInVitest(context) }), VITEST_TIMEOUT_MS);",
      "    it(name, () => lifecycle.runCase(name, body), VITEST_TIMEOUT_MS);",
      "    await lifecycle.runFinalCleanup(db);",
      "    await lifecycle.runPreflight(async () => {",
    ]) {
      expect(smoke, line).toContain(line);
      expect(probeSource, line).toContain(line);
    }
    const { code, output } = await runVitest([PROBE], { PROVIDER_BUDGET_LIFECYCLE_PROBE: "not-a-scenario" });
    expect(code).toBe(0);
    expect(output).toMatch(/Tests\s+\d+ skipped/);
    expect(output).not.toMatch(/passed|failed/);
  }, PROCESS_TIMEOUT_MS);

  it("success: every case runs, the one cleanup removes exactly the run's fixtures, both evidence records are saved, and the run passes as baseline plus expected delta", async () => {
    const { code, report, evidenceFiles } = await probe("success");
    expect(code).toBe(0);
    expect(report!.final).toMatchObject({ outcome: "COMPLETED_CLEAN", verdict: "baseline_plus_expected_delta", completeRestoration: false, poisoned: null, executed: ["one", "two", "three"], inFlightOperations: [], unknownOperations: [] });
    expect(report!.verdict).toEqual({ pass: true, verdict: "clean_and_evidenced" });
    expect(evidenceFiles).toEqual([FINAL_FILE, START_FILE]);
    expect(report!.remaining).toEqual({ subjects: ["someone-else"], schemas: [] }); // a row that is not the run's survives
    expect(report!.final.cleanup.summary).toMatchObject({ status: "confirmed" });
    // Each case found the run clean and idle; nothing was sent before the cleanup test.
    for (const test of ["one", "two", "three"]) expect(startOf(report!, test)).toMatchObject({ poisoned: null, statements: 0 });
    expect(report!.log.filter((statement) => statement.kind === "delete_subject").map((statement) => statement.target)).toEqual([SUBJECT("one"), SUBJECT("two"), SUBJECT("three")]);
  }, PROCESS_TIMEOUT_MS);

  it("which timeout governs: a SHORT --testTimeout / --hookTimeout on the command line does not shorten tests and hooks that carry their own", async () => {
    // Every case here takes longer than 50 ms, and the probe passes its timeouts explicitly, exactly as the smoke does.
    const { code, report, output } = await probe("success", { cliFlags: ["--testTimeout=50", "--hookTimeout=50"] });
    expect(output).not.toMatch(/timed out/i);
    expect(code).toBe(0);
    expect(report!.final.outcome).toBe("COMPLETED_CLEAN");
  }, PROCESS_TIMEOUT_MS);

  it.each([
    ["assert_inside", '"two" failed'],
    ["assert_outside", "the test runner reported a test as failed"],
  ])("C. %s: the failure reaches the hook, the run poisons, no later case runs, and NO cleanup statement is ever sent", async (scenario, reason) => {
    const { code, report, evidenceFiles, evidence } = await probe(scenario);
    expect(code).not.toBe(0);
    expect(report!.final).toMatchObject({ outcome: "POISONED", verdict: "poisoned_evidence_preserved", poisoned: reason });
    expect(startOf(report!, "three").poisoned).toBe(reason);
    expect(report!.bodiesStarted).toEqual(["one", "two"]); // case three was refused BEFORE its body
    expect(report!.log).toEqual([]);
    expect(report!.final.cleanup).toMatchObject({ attempted: false, accepted: false });
    // Every fixture the run created is still there, and the failure's evidence was saved.
    expect(report!.remaining.subjects).toEqual(["someone-else", SUBJECT("one"), SUBJECT("two")].sort());
    expect(report!.remaining.schemas).toHaveLength(1);
    expect(evidenceFiles).toEqual([FINAL_FILE, START_FILE]);
    expect(JSON.parse(evidence[FINAL_FILE]!)).toMatchObject({ lifecycleOutcome: "POISONED", poisoned: reason });
    expect(report!.verdict).toEqual({ pass: false, verdict: "not_clean" });
  }, PROCESS_TIMEOUT_MS);

  it("A. the RUNNER abandons a case body that is still writing: the hook poisons the run, nothing later starts, and the write stays in flight until it really settles", async () => {
    const { code, report, output, evidenceFiles } = await probe("runner_abandons_case");
    expect(code).not.toBe(0);
    expect(output).toMatch(/Test timed out in 300ms/);
    expect(report!.final.outcome).toBe("POISONED");
    expect(report!.final.poisoned).toBe('"two" was still running when its test ended (it timed out or was abandoned); its database requests may still complete');
    // When the run ended, the abandoned work was still tracked — not assumed finished because nobody was waiting.
    expect(report!.final.inFlightOperations).toEqual(["a slow write", "case body: two"]);
    expect(startOf(report!, "three").poisoned).not.toBeNull();
    expect(report!.bodiesStarted).toEqual(["one", "two"]);
    expect(report!.log).toEqual([]);
    expect(evidenceFiles).toEqual([FINAL_FILE, START_FILE]);
    // E. After it settled: still poisoned, and it authorized nothing.
    expect(report!.late).toMatchObject({ waited: true, state: "POISONED", inFlight: [], caseInFlight: null, statements: 0, writes: 0 });
    expect(report!.late.lateWrite).toMatch(/poisoned/);
    expect(report!.late.lateCase).toMatch(/poisoned/);
    expect(report!.late.lateRegistration).toMatch(/sealed/);
  }, PROCESS_TIMEOUT_MS);

  it("the run's own case deadline fires before the runner's: the lifecycle poisons FIRST, and the result is the same", async () => {
    const { code, report, output } = await probe("case_deadline");
    expect(code).not.toBe(0);
    expect(output).not.toMatch(/Test timed out/);
    expect(report!.final.poisoned).toBe('"two" exceeded its 150 ms deadline; its database requests may still be running or may still complete');
    expect(report!.final.inFlightOperations).toEqual(["a slow write", "case body: two"]);
    expect(report!.bodiesStarted).toEqual(["one", "two"]);
    expect(report!.log).toEqual([]);
    expect(report!.late).toMatchObject({ state: "POISONED", inFlight: [], statements: 0 });
  }, PROCESS_TIMEOUT_MS);

  it("B. the RUNNER abandons the cleanup while a DELETE is still running: the run poisons, and once that DELETE settles NOT ONE further statement is sent", async () => {
    const { code, report, output, evidenceFiles } = await probe("runner_abandons_cleanup");
    expect(code).not.toBe(0);
    expect(output).toMatch(/Test timed out in 300ms/);
    expect(report!.final.outcome).toBe("POISONED");
    expect(report!.final.poisoned).toBe("the test runner reported a test as failed");
    expect(report!.final.cleanup).toMatchObject({ attempted: true, accepted: false, inFlight: true });
    expect(report!.final.inFlightOperations).toEqual(["the final cleanup"]);
    expect(report!.final.cleanup.steps[3]).toMatchObject({ action: "delete_subject", outcome: "in_flight" });
    // Plan: 0-1 the schema's inspection, 2-4 the three deletes. The stalled one is index 3.
    expect(report!.log).toHaveLength(4);
    expect(report!.late).toMatchObject({ waited: true, state: "POISONED", cleanupInFlight: false, statements: 4, writes: 2 });
    expect(evidenceFiles).toEqual([FINAL_FILE, START_FILE]);
    expect(report!.verdict.pass).toBe(false);
  }, PROCESS_TIMEOUT_MS);

  it("the run's own cleanup deadline fires before the runner's: poisoned at the deadline, the cleanup still in flight, nothing sent after it", async () => {
    const { code, report, output } = await probe("cleanup_deadline");
    expect(code).not.toBe(0);
    expect(output).not.toMatch(/Test timed out/);
    expect(report!.final.poisoned).toBe("the final cleanup exceeded its 150 ms deadline; a statement it already issued may still complete");
    expect(report!.final.cleanup).toMatchObject({ attempted: true, accepted: false, inFlight: true });
    expect(report!.log).toHaveLength(4);
    expect(report!.late).toMatchObject({ state: "POISONED", cleanupInFlight: false, statements: 4 });
  }, PROCESS_TIMEOUT_MS);

  it("a preflight read stalls past the preflight deadline: the hook fails, no case runs, nothing is written, and the start evidence is never saved", async () => {
    const { code, report, output, evidenceFiles } = await probe("preflight_deadline");
    expect(code).not.toBe(0);
    expect(output).not.toMatch(/Hook timed out/);
    expect(report!.final).toMatchObject({ outcome: "POISONED", poisoned: "the preflight exceeded its 150 ms deadline; a read it issued may still be running", executed: [] });
    expect(report!.final.inFlightOperations).toEqual(["a slow baseline read", "the preflight"]);
    expect(report!.bodiesStarted).toEqual([]);
    expect(report!.log).toEqual([]);
    expect(report!.startSaved.ok).toBe(false);
    expect(evidenceFiles).toEqual([FINAL_FILE]); // the failure itself is still recorded
    // The abandoned preflight body kept going after the stall, and could neither arm the run nor read.
    expect(report!.late).toMatchObject({ state: "POISONED", inFlight: [] });
    expect(report!.late.lateWrite).toMatch(/poisoned/);
  }, PROCESS_TIMEOUT_MS);

  it("a post-run comparison read stalls past the comparison deadline: the run poisons, is never reported clean, and its final evidence is still saved", async () => {
    const { code, report, output, evidenceFiles, evidence } = await probe("compare_deadline");
    expect(code).not.toBe(0);
    expect(output).not.toMatch(/Hook timed out/);
    expect(report!.final).toMatchObject({ outcome: "POISONED", poisoned: "the post-run comparison exceeded its 150 ms deadline; a read it issued may still be running", delta: null });
    expect(report!.final.inFlightOperations).toEqual(["a slow post-run snapshot", "the post-run comparison"]);
    expect(report!.final.cleanup).toMatchObject({ attempted: true, accepted: true }); // the cleanup itself had been confirmed
    expect(evidenceFiles).toEqual([FINAL_FILE, START_FILE]);
    expect(JSON.parse(evidence[FINAL_FILE]!)).toMatchObject({ lifecycleOutcome: "POISONED", verdict: "poisoned_evidence_preserved" });
    expect(report!.verdict).toEqual({ pass: false, verdict: "not_clean" });
    expect(report!.late).toMatchObject({ state: "POISONED", inFlight: [] });
  }, PROCESS_TIMEOUT_MS);

  it("WHY the comparison has a deadline below the hook timeout: when the RUNNER abandons the end-of-run hook instead, the run fails with no final evidence at all", async () => {
    const { code, output, evidenceFiles } = await probe("runner_abandons_end_hook", { expectReport: false });
    expect(code).not.toBe(0);
    expect(output).toMatch(/Hook timed out in 300ms/);
    // The hook was abandoned mid-comparison, before it could save the final record: only the start record exists.
    expect(evidenceFiles).toEqual([START_FILE]);
  }, PROCESS_TIMEOUT_MS);

  it("D. a final evidence file already exists: it is not overwritten, and the otherwise clean run FAILS as clean-but-not-evidenced — with no further database activity", async () => {
    const existing = '{"someone":"else"}';
    const { code, report, evidence } = await probe("success", {
      prepare: (directory) => {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        writeFileSync(path.join(directory, FINAL_FILE), existing, { mode: 0o600 });
      },
    });
    expect(code).not.toBe(0);
    expect(evidence[FINAL_FILE]).toBe(existing);
    expect(report!.finalSaved).toEqual({ ok: false, reason: "already_exists", code: "EEXIST" });
    expect(report!.final.outcome).toBe("COMPLETED_CLEAN");
    expect(report!.verdict).toEqual({ pass: false, verdict: "clean_but_not_evidenced" });
    expect(report!.late.statements).toBe(report!.log.length); // nothing was sent after the verdict
  }, PROCESS_TIMEOUT_MS);

  it("D. a START evidence file already exists: the run cannot be armed, so no case runs and nothing is ever written", async () => {
    const existing = '{"someone":"else"}';
    const { code, report, evidence } = await probe("success", {
      prepare: (directory) => {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        writeFileSync(path.join(directory, START_FILE), existing, { mode: 0o600 });
      },
    });
    expect(code).not.toBe(0);
    expect(evidence[START_FILE]).toBe(existing);
    expect(report!.startSaved).toEqual({ ok: false, reason: "already_exists", code: "EEXIST" });
    expect(report!.final).toMatchObject({ outcome: "POISONED", poisoned: "arming was attempted without saved start evidence", executed: [] });
    expect(report!.bodiesStarted).toEqual([]);
    expect(report!.log).toEqual([]);
  }, PROCESS_TIMEOUT_MS);
});

// Sequential on purpose, as above.
describe.skipIf(scenarioName !== undefined)("the smoke file in a real child process (synthetic values, .invalid hosts — refused before any connection)", () => {
  const SYNTHETIC_ENDPOINT = "ep-synthetic-000009";
  const SYNTHETIC_URL = `postgresql://app:synthetic@${SYNTHETIC_ENDPOINT}.c-1.neon.invalid/neondb`;
  const SYNTHETIC_POOLED_URL = `postgresql://app:synthetic@${SYNTHETIC_ENDPOINT}-pooler.c-1.neon.invalid/neondb`;
  const armed = { [GATE]: "1", NEON_BRANCH_DATABASE_URL: SYNTHETIC_POOLED_URL, NEON_BRANCH_EXPECTED_ENDPOINT_ID: SYNTHETIC_ENDPOINT };
  const REFUSAL = /refused to connect: |refused before any database work: /;
  /** What a real connection attempt to a synthetic host would print. None may appear. */
  const CONNECTION_ATTEMPT = /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|getaddrinfo|NeonDbError|WebSocket/i;
  /** Printed only once nothing can refuse any more, i.e. just before a connector is built. (The runtime line — a refusal's code frame may quote the source line, with its placeholder.) */
  const ABOUT_TO_CONNECT = /\[provider-budget-smoke\] connection_mode: [a-z]/;
  const summary = (output: string) => /Tests\s+([^\n]*)/.exec(output)?.[1] ?? "";
  const liveCount = (readFileSync(SMOKE, "utf8").match(/^  liveCase\(/gm) ?? []).length + 2; // the cases, the completeness check, and the cleanup test
  /** The real evidence directory's provider-budget records. A refused run must never add one. */
  const evidenceRecords = () => (existsSync("evidence") ? readdirSync("evidence").filter((name) => name.startsWith("provider-budget-smoke-")).sort() : []);
  const recordsBefore = evidenceRecords();
  const expectNothingLiveRan = (output: string) => {
    expect(output).toMatch(/Test Files\s+1 failed/);
    expect(output).not.toMatch(/Test Files\s+\d+ passed/);
    expect(output).not.toMatch(CONNECTION_ATTEMPT);
    expect(output).not.toMatch(ABOUT_TO_CONNECT);
    expect(output).not.toContain("synthetic");
    expect(evidenceRecords()).toEqual(recordsBefore);
  };
  /** With a readable .env.local the target check passes and the later rule under test is what refuses; without one the target check refuses first. Either way nothing connects. */
  const refusedBy = (output: string, reason: RegExp) => {
    if (existsSync(".env.local") && !/refused to connect: /.test(output)) expect(output).toMatch(reason);
  };

  it("F. no gate: every live case is skipped and the run is green — whatever else is exported", async () => {
    const { code, output } = await runVitest([SMOKE], { DATABASE_URL: SYNTHETIC_URL, NEON_BRANCH_DATABASE_URL: SYNTHETIC_POOLED_URL, NEON_BRANCH_EXPECTED_ENDPOINT_ID: SYNTHETIC_ENDPOINT, REAL_SMOKE_RATE_LIMIT: "1" });
    expect(code, summary(output)).toBe(0);
    expect(liveCount).toBe(22);
    expect(summary(output)).toMatch(new RegExp(`\\b${liveCount} skipped\\b`));
    expect(summary(output)).not.toMatch(/failed/);
    expect(output).not.toMatch(REFUSAL);
    expect(output).not.toMatch(CONNECTION_ATTEMPT);
    expect(output).not.toMatch(ABOUT_TO_CONNECT);
  }, PROCESS_TIMEOUT_MS);

  it.each<[string, Record<string, string>, RegExp]>([
    ["G. the gate alone (no target)", { [GATE]: "1" }, /NEON_BRANCH_DATABASE_URL is missing or not a URL/],
    ["H. no operator confirmation of the endpoint", { [GATE]: "1", NEON_BRANCH_DATABASE_URL: SYNTHETIC_POOLED_URL }, REFUSAL],
    ["H. an endpoint id that does not match the URL", { ...armed, NEON_BRANCH_EXPECTED_ENDPOINT_ID: "ep-other-000008" }, REFUSAL],
    ["J. DATABASE_URL exported beside a full target", { ...armed, DATABASE_URL: SYNTHETIC_URL }, /DATABASE_URL is exported/],
    ["J. DATABASE_URL as the only URL (no fallback)", { [GATE]: "1", NEON_BRANCH_EXPECTED_ENDPOINT_ID: SYNTHETIC_ENDPOINT, DATABASE_URL: SYNTHETIC_URL }, /DATABASE_URL is exported/],
    ["K. the Slice E smoke's gate beside it", { ...armed, REAL_SMOKE_RATE_LIMIT: "1" }, /an unrelated smoke gate is set/],
    ["K. the provisioning-limits smoke's gate beside it", { ...armed, REAL_SMOKE_PROVISIONING_LIMITS: "1" }, /an unrelated smoke gate is set/],
    ["K. an admin gate beside it", { ...armed, REAL_ADMIN_POLL_PROVISIONING_ACTIVITY: "1" }, /an admin gate is set/],
    ["a routing override in the URL", { ...armed, NEON_BRANCH_DATABASE_URL: `${SYNTHETIC_POOLED_URL}?options=endpoint%3Dep-real` }, /unsupported or repeated connection parameter/],
  ])("gate set, %s -> the run FAILS, refused before any connection", async (_name, env, reason) => {
    const { code, output } = await runVitest([SMOKE], env);
    expect(code, summary(output)).not.toBe(0);
    expect(output).toMatch(REFUSAL);
    expect(output).toMatch(reason);
    expectNothingLiveRan(output);
  }, PROCESS_TIMEOUT_MS);

  it("I. fully armed and exactly selected, but with the branch's DIRECT connection string -> refused before any connection, with no URL in the message", async () => {
    const { code, output } = await runVitest([SMOKE], { ...armed, NEON_BRANCH_DATABASE_URL: SYNTHETIC_URL });
    expect(code, summary(output)).not.toBe(0);
    expect(output).toMatch(REFUSAL);
    refusedBy(output, /refused before any database work: this run requires the disposable branch's POOLED connection string/);
    expectNothingLiveRan(output);
  }, PROCESS_TIMEOUT_MS);

  it.each<[string, string[]]>([
    ["L. a second test file selected beside it", [SMOKE, "test/lib/real/neon-smoke-fixture-ids.test.ts"]],
    ["M. a test-name filter", [SMOKE, "-t", "G1."]],
    ["M. a test-name filter in its long form", [SMOKE, "--testNamePattern=G1."]],
    ["a directory instead of the file", ["test/lib/real/provider-budget.smoke"]],
  ])("fully armed but not run as the one exact file (%s) -> refused before any connection", async (_name, args) => {
    const { code, output } = await runVitest(args, armed);
    expect(code, summary(output)).not.toBe(0);
    expect(output).toMatch(REFUSAL);
    refusedBy(output, /refused before any database work: (it must be the ONE test file selected|only --testTimeout)/);
    expect(output).not.toMatch(CONNECTION_ATTEMPT);
    expect(output).not.toMatch(ABOUT_TO_CONNECT);
    expect(output).not.toContain("synthetic");
  }, PROCESS_TIMEOUT_MS);

  it.each<[string, string[]]>([
    ["the older smokes' 30000 ms flags", ["--testTimeout=30000", "--hookTimeout=30000"]],
    ["a short hook timeout beside a long test timeout", ["--testTimeout=120000", "--hookTimeout=30000"]],
    ["a short test timeout alone", ["--testTimeout=119999"]],
  ])("fully armed and exactly selected, but with %s -> refused before any connection", async (_name, flags) => {
    const { code, output } = await runVitest([SMOKE, ...flags], armed);
    expect(code, summary(output)).not.toBe(0);
    expect(output).toMatch(REFUSAL);
    refusedBy(output, /refused before any database work: --(testTimeout|hookTimeout) must be at least 120000 ms/);
    expectNothingLiveRan(output);
  }, PROCESS_TIMEOUT_MS);
});

// ====================================================================== the probe: runs ONLY in a child process

describe.skipIf(settings === null)("provider-budget lifecycle probe (in-memory, offline)", () => {
  const s: Scenario = settings ?? GENEROUS;
  const VITEST_TIMEOUT_MS = s.timeoutMs;
  const EXPECTED_CASES = ["one", "two", "three"] as const;
  const PREFLIGHT_CHECKS = ["the target is not a read replica", "the provider table is absent"] as const;
  const EVIDENCE_DIRECTORY = path.join(probeDirectory, "evidence");
  const runId = RUN;
  const ownership = createRunOwnership(runId);
  const fake = createFakeBudgetDb();
  const db = fake.db;
  const lifecycle = createProviderBudgetLifecycle({ expectedCases: EXPECTED_CASES, requiredPreflightChecks: PREFLIGHT_CHECKS, caseDeadlineMs: s.caseDeadlineMs, cleanupDeadlineMs: s.cleanupDeadlineMs, preflightDeadlineMs: s.preflightDeadlineMs, ownership });
  let startSaved: EvidenceWrite = { ok: false, reason: "write_failed", code: null };
  const atStart: ProbeReport["atStart"] = [];
  const bodiesStarted: string[] = [];
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const describeError = async (attempt: () => unknown): Promise<string> => {
    try {
      await attempt();
      return "accepted";
    } catch (error) {
      return (error as Error).message;
    }
  };
  fake.seedRows("someone-else", ["pay_submit_day"]);
  // The cleanup plan for this probe: 0-1 the one schema's inspection, 2-4 the three subject deletes. The middle delete is the one that stalls.
  if (s.stall === "cleanup") fake.failWhen((_statement, index) => (index === 3 ? { stallMs: SLOW_MS } : undefined));

  /** One fixture, as a tracked write: a registered subject with two charged rows; case one also creates a scratch schema. */
  const body = (name: (typeof EXPECTED_CASES)[number]) => async () => {
    bodiesStarted.push(name);
    await sleep(100); // longer than the 50 ms flags the parent passes in one scenario
    const subject = ownership.registerSubject(name);
    await lifecycle.write("charging a fixture", async () => fake.seedRows(subject, ["chain_read_day", "chain_read_short"]));
    if (name === "one") {
      const schema = ownership.registerScratchSchema("a");
      const objects = [ownership.registerScratchObject(schema, "table", "real_provider_budgets")];
      await lifecycle.write("creating a scratch schema", async () => fake.seedSchema(schema, objects));
    }
    if (name === "two" && s.stall === "case") await lifecycle.write("a slow write", () => sleep(SLOW_MS));
    if (name === "two" && s.fail === "inside") expect("the case's own assertion").toBe("failing");
  };

  function liveCase(name: (typeof EXPECTED_CASES)[number], body: () => Promise<void>) {
    it(name, () => lifecycle.runCase(name, body), VITEST_TIMEOUT_MS);
  }

  beforeEach((context) => void atStart.push({ test: context.task.name, state: lifecycle.state(), poisoned: lifecycle.poisoned(), statements: fake.log.length }));

  beforeAll(async () => {
    await lifecycle.runPreflight(async () => {
      await lifecycle.read(s.stall === "preflight" ? "a slow baseline read" : "the baseline", () => (s.stall === "preflight" ? sleep(SLOW_MS) : Promise.resolve()));
      for (const check of PREFLIGHT_CHECKS) lifecycle.preflightCheck(check, true);
      const startEvidence = { runId, server: { version: "probe" }, connectionMode: "pooled", migrationStatementSha256: sha256Hex("probe"), expectedCases: [...EXPECTED_CASES], fingerprintsBefore: BEFORE };
      startSaved = writeProviderBudgetEvidence({ directory: EVIDENCE_DIRECTORY, runId, stage: "start", evidence: startEvidence });
      lifecycle.arm({ startEvidence: startSaved });
    });
  }, VITEST_TIMEOUT_MS);

  // The same line as provider-budget.smoke.test.ts.
  afterEach((context) => lifecycle.afterCase({ reportedFailed: caseFailedInVitest(context) }), VITEST_TIMEOUT_MS);

  afterAll(async () => {
    const final = await lifecycle.finish({
      deadlineMs: s.verifyDeadlineMs,
      compare: async (read) => {
        await read(s.stall === "compare" ? "a slow post-run snapshot" : "the post-run snapshot", () => (s.stall !== "compare" ? Promise.resolve() : s.never ? new Promise<void>(() => undefined) : sleep(SLOW_MS)));
        return compareWithExpectedDelta({ before: BEFORE, after: AFTER, providerTable: EXPECTED_PROVIDER_TABLE, ownedSchemas: ownership.ownedSchemas() });
      },
    });
    const evidence = {
      runId,
      lifecycleOutcome: final.outcome,
      server: { version: "probe" },
      connectionMode: "pooled",
      migrationStatementSha256: sha256Hex("probe"),
      casesExecuted: final.executed,
      casesNotExecuted: final.notExecuted,
      admissionTallies: final.admissionTallies,
      schemaRefusals: final.schemaRefusals,
      cleanup: final.cleanup,
      fingerprintsBefore: BEFORE,
      fingerprintsAfter: final.delta ? AFTER : null,
      expectedDelta: final.delta,
      unknownOperations: final.unknownOperations,
      inFlightOperations: final.inFlightOperations,
      verdict: final.verdict,
      poisoned: final.poisoned,
    };
    const finalSaved = writeProviderBudgetEvidence({ directory: EVIDENCE_DIRECTORY, runId, stage: "final", evidence });
    const verdict = concludeProviderBudgetRun(final, { start: startSaved, final: finalSaved });

    // PROBE-ONLY (the smoke stops at the verdict): wait for everything that was abandoned to really settle, then record
    // what the run would still let anything do. Nothing here is sent to the stand-in except through the lifecycle.
    const snapshotAtVerdict = { log: fake.log.map(({ kind, target }) => ({ kind, target })), writes: fake.writes().length, remaining: { subjects: fake.subjects(), schemas: fake.schemaNames() } };
    const pending = final.inFlightOperations.length > 0;
    if (pending) await sleep(SLOW_MS + 300);
    const late: ProbeReport["late"] = {
      waited: pending,
      state: lifecycle.state(),
      poisoned: lifecycle.poisoned(),
      inFlight: lifecycle.inFlightOperations(),
      caseInFlight: lifecycle.caseInFlight(),
      cleanupInFlight: lifecycle.cleanupInFlight(),
      statements: fake.log.length,
      writes: fake.writes().length,
      lateWrite: await describeError(() => lifecycle.write("a late write", async () => fake.seedRows("late", ["chain_read_day"]))),
      lateCase: await describeError(() => lifecycle.runCase("three", async () => void bodiesStarted.push("three (late)"))),
      lateRegistration: await describeError(() => ownership.registerSubject("late")),
    };
    const report: ProbeReport = { final, startSaved, finalSaved, verdict: { pass: verdict.pass, verdict: verdict.verdict }, atStart, bodiesStarted, ...snapshotAtVerdict, late };
    writeFileSync(path.join(probeDirectory, "report.json"), JSON.stringify(report));
    if (!verdict.pass) throw new Error(verdict.message);
  }, s.endHookTimeoutMs);

  liveCase("one", body("one"));

  // Case two, written out so one scenario can fail the TEST after its body succeeded — something only the runner sees.
  it("two", async () => {
    await lifecycle.runCase("two", body("two"));
    if (s.fail === "outside") expect("the test around the case").toBe("failing");
  }, VITEST_TIMEOUT_MS);

  liveCase("three", body("three"));

  it("every decisive case ran, exactly once, in order", () => {
    expect(lifecycle.poisoned()).toBeNull();
    expect(lifecycle.executed()).toEqual([...EXPECTED_CASES]);
  }, VITEST_TIMEOUT_MS);

  it("Z. the final cleanup removes exactly what this run registered", async () => {
    await lifecycle.runFinalCleanup(db);
    expect(lifecycle.poisoned()).toBeNull();
    expect(lifecycle.state()).toBe("CLEANUP");
  }, VITEST_TIMEOUT_MS);
});
