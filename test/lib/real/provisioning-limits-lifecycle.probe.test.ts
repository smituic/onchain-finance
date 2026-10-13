// @vitest-environment node
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeLedgerDb } from "./fixtures/provisioning-limits-fake-db";
import { caseFailedInVitest, concludeRun, createRunFixtures, createRunLifecycle, writeEvidenceFile } from "./fixtures/provisioning-limits-smoke";

/**
 * OFFLINE PROBE — never a live test, never a database. It exists to be run in
 * a child Vitest process by provisioning-limits-smoke-harness.test.ts, to show
 * how the dispatch-ceiling smoke's lifecycle behaves under the REAL test
 * runner: what afterEach sees after an assertion failure, what happens when
 * the runner's own timeout abandons a case body — or a CLEANUP hook — that is
 * still running, and what a stalled cleanup statement can and cannot do
 * afterwards.
 *
 * It uses the smoke's actual lifecycle, ownership registry, and cleanup, wired
 * to Vitest with the same two lines the smoke uses, over an in-memory stand-in
 * for the two tables. It is skipped unless PROVISIONING_LIFECYCLE_PROBE names a
 * scenario, and it writes one JSON report, for its parent to read, to the
 * file PROVISIONING_LIFECYCLE_PROBE_REPORT names (a temporary file the parent
 * created; a runner may withhold a passing run's console output).
 *
 * Timings are scaled down from the smoke's (120 s / 90 s / 60 s) but keep the
 * same ORDER in each scenario: which of the run's own deadline and the
 * runner's timeout comes first is what each scenario is about.
 */
const SLOW_MS = 1_200;
type Stall = { index: number; thenFail?: boolean };
/** `timeoutMs` is the runner's timeout for both a test and its afterEach hook, as in the smoke. */
const SCENARIOS: Record<string, { timeoutMs: number; caseDeadlineMs: number; cleanupDeadlineMs: number; stall?: Stall }> = {
  success: { timeoutMs: 5_000, caseDeadlineMs: 4_000, cleanupDeadlineMs: 3_000 },
  assert_fail: { timeoutMs: 5_000, caseDeadlineMs: 4_000, cleanupDeadlineMs: 3_000 },
  outside_failure: { timeoutMs: 5_000, caseDeadlineMs: 4_000, cleanupDeadlineMs: 3_000 },
  /** The RUNNER gives up on the case first: the body is abandoned while still running. */
  runner_timeout: { timeoutMs: 300, caseDeadlineMs: 30_000, cleanupDeadlineMs: 30_000 },
  /** The run's own case deadline fires first. */
  deadline: { timeoutMs: 5_000, caseDeadlineMs: 150, cleanupDeadlineMs: 3_000 },
  // Case two creates two fixtures, so its cleanup is statements 3, 4, 5, 6 and the residue read 7 (case one's were 0, 1 and 2).
  /** A DELETE stalls past the CLEANUP deadline (the hook's own timeout is far off), then succeeds. */
  cleanup_stall_deadline: { timeoutMs: 5_000, caseDeadlineMs: 4_000, cleanupDeadlineMs: 150, stall: { index: 3 } },
  /** A DELETE stalls past the RUNNER's hook timeout (the cleanup deadline is far off), then succeeds. */
  cleanup_stall_hook: { timeoutMs: 300, caseDeadlineMs: 30_000, cleanupDeadlineMs: 30_000, stall: { index: 3 } },
  /** A DELETE stalls past the cleanup deadline, then FAILS. */
  cleanup_stall_fail: { timeoutMs: 5_000, caseDeadlineMs: 4_000, cleanupDeadlineMs: 150, stall: { index: 3, thenFail: true } },
  /** Every DELETE succeeds; the final residue read stalls past the cleanup deadline. */
  residue_stall_deadline: { timeoutMs: 5_000, caseDeadlineMs: 4_000, cleanupDeadlineMs: 150, stall: { index: 7 } },
  /** Every DELETE succeeds; the final residue read stalls past the RUNNER's hook timeout. */
  residue_stall_hook: { timeoutMs: 300, caseDeadlineMs: 30_000, cleanupDeadlineMs: 30_000, stall: { index: 7 } },
};
const scenario = process.env.PROVISIONING_LIFECYCLE_PROBE;
const settings = scenario !== undefined && Object.hasOwn(SCENARIOS, scenario) ? SCENARIOS[scenario]! : null;
const EXPECTED_CASES = ["one", "two", "three"] as const;

describe.skipIf(settings === null)("provisioning limits lifecycle probe (in-memory, offline)", () => {
  const LIVE_TIMEOUT_MS = settings?.timeoutMs ?? 5_000;
  const fixtures = createRunFixtures("0a1b2c3d");
  const ledger = createFakeLedgerDb();
  const db = ledger.db;
  const lifecycle = createRunLifecycle({ expectedCases: EXPECTED_CASES, caseDeadlineMs: settings?.caseDeadlineMs ?? 4_000, cleanupDeadlineMs: settings?.cleanupDeadlineMs ?? 3_000, fixtures, db: () => db });
  lifecycle.arm();
  const flags = { bodiesStarted: [] as string[], lateBodySettled: false, lateWrite: "not attempted" };
  /** What each test found when it was about to start — recorded before anything else, by the runner's own beforeEach. */
  const atStart: Array<{ test: string; poisoned: string | null; cleanupInFlight: string | null; stalled: number; statementsSent: number }> = [];
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const stall = settings?.stall;
  if (stall) ledger.failWhen((_statement, index) => (index === stall.index ? { stallMs: SLOW_MS, ...(stall.thenFail ? { error: Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }) } : {}) } : undefined));

  /** A fixture "write": one attempt and one dispatch row, through the lifecycle's write gate. */
  const make = (suffix: string) =>
    lifecycle.write("creating a fixture", async () => {
      const credentialId = fixtures.newCredentialId(suffix);
      const dispatchId = randomUUID();
      fixtures.registerDispatch(dispatchId, credentialId);
      ledger.seed(credentialId, [dispatchId]);
    });

  beforeEach((context) => void atStart.push({ test: context.task.name, poisoned: lifecycle.poisoned(), cleanupInFlight: lifecycle.cleanupInFlight(), stalled: ledger.stalled(), statementsSent: ledger.log.length }));

  // The same two wiring lines as provisioning-limits.smoke.test.ts.
  afterEach((context) => lifecycle.afterCase({ reportedFailed: caseFailedInVitest(context) }), LIVE_TIMEOUT_MS);
  function liveCase(name: (typeof EXPECTED_CASES)[number], body: () => Promise<void>) {
    it(name, () => lifecycle.runCase(name, async () => {
      flags.bodiesStarted.push(name);
      await body();
    }), LIVE_TIMEOUT_MS);
  }

  afterAll(async () => {
    // Let anything that was abandoned finish, so the report shows what it did afterwards.
    const statementsSentBeforeWaiting = ledger.log.length;
    const stillInFlightBeforeWaiting = { cleanup: lifecycle.cleanupInFlight(), caseBody: lifecycle.inFlight(), stalled: ledger.stalled() };
    if (stall || scenario === "runner_timeout" || scenario === "deadline") await sleep(SLOW_MS + 400);
    let baselineRead = false;
    const final = await lifecycle.finish({
      verifyBaseline: async () => {
        baselineRead = true;
        return ledger.attempts.size === 0 && ledger.dispatches.size === 0;
      },
    });
    // The smoke's own end-of-run verdict, when the parent names an evidence directory.
    const evidenceDirectory = process.env.PROVISIONING_LIFECYCLE_PROBE_EVIDENCE_DIR;
    const saved = evidenceDirectory ? writeEvidenceFile({ directory: evidenceDirectory, runId: fixtures.runId, evidence: { final } }) : null;
    const verdict = saved ? concludeRun(final, saved) : null;
    const reportPath = process.env.PROVISIONING_LIFECYCLE_PROBE_REPORT;
    if (!reportPath) throw new Error("lifecycle probe: no report file was named");
    writeFileSync(
      reportPath,
      JSON.stringify({
        final,
        flags,
        atStart,
        baselineRead,
        poisonedAtEnd: lifecycle.poisoned(),
        stillInFlightBeforeWaiting,
        stillInFlightAtEnd: { cleanup: lifecycle.cleanupInFlight(), caseBody: lifecycle.inFlight(), stalled: ledger.stalled() },
        statementsSentBeforeWaiting,
        settledAfterStall: ledger.settledAfterStall,
        attempts: [...ledger.attempts],
        dispatches: ledger.dispatches.size,
        log: ledger.log,
        saved,
        verdict,
      }),
    );
    if (verdict && !verdict.pass) throw new Error(verdict.message);
  }, 10_000);

  liveCase("one", async () => {
    await make("one");
  });

  if (scenario === "outside_failure") {
    // The case body itself succeeds; the failure happens in the test AROUND it, where only the runner sees it.
    it("two", async () => {
      await lifecycle.runCase("two", async () => {
        flags.bodiesStarted.push("two");
        await make("two");
        await make("two-b");
      });
      expect("the ledger").toBe("what this case expected");
    }, LIVE_TIMEOUT_MS);
  } else {
    liveCase("two", async () => {
      await make("two");
      await make("two-b");
      if (scenario === "assert_fail") expect(ledger.dispatches.size).toBe(99);
      if (scenario === "runner_timeout" || scenario === "deadline") {
        await sleep(SLOW_MS); // still "talking to the database" when the runner or the deadline gives up
        try {
          await make("two-late");
          flags.lateWrite = "performed";
        } catch {
          flags.lateWrite = "refused";
        }
        flags.lateBodySettled = true;
      }
    });
  }

  liveCase("three", async () => {
    await make("three");
  });

  it("every decisive case ran, exactly once, in order", () => {
    expect(lifecycle.poisoned()).toBeNull();
    expect(lifecycle.inFlight()).toBeNull();
    expect(lifecycle.cleanupInFlight()).toBeNull();
    expect(lifecycle.executed()).toEqual([...EXPECTED_CASES]);
  });
});
