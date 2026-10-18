// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, statSync, chmodSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RegistrationAdmissionError } from "@/lib/real/server/registration-admission";
import { SCHEMA_EXTERNAL_DEPENDENCIES_SQL, SCHEMA_INVENTORY_SQL, SCHEMA_RESIDUE_SQL, createRunOwnership, type DatabaseSnapshot } from "./fixtures/provider-budget-smoke";
import {
  BACKDATE_DAY_SQL,
  BACKDATE_SHORT_SQL,
  CAN_SEE_ACTIVITY_SQL,
  COUNT_ROWS_SQL,
  EXPECTED_ADMISSION_TABLE,
  EXPECTED_SEED_ROW,
  HOLDER_ACTIVE_SQL,
  MAX_ACTIVITY_POLLS,
  MAX_CONCURRENCY,
  MAX_ROW_FIXTURE_WRITES,
  MAX_RUN_OPERATIONS,
  READ_ROW_SQL,
  REGISTRATION_ADMISSION_SMOKE_FILE,
  REMOVE_ROW_SQL,
  RENAME_AWAY_SQL,
  RENAME_BACK_SQL,
  SET_ROW_SQL,
  WAITER_BLOCKED_SQL,
  checkRegistrationAdmissionFileSelection,
  classifyAdmission,
  compareWithExpectedAdmissionDelta,
  concludeRegistrationAdmissionRun,
  createRegistrationAdmissionLifecycle,
  holderStatements,
  missingEvidenceFields,
  planAdmissionCleanup,
  tallyOutcomes,
  writeRegistrationAdmissionEvidence,
  type DeltaVerdict,
  type FinalReport,
} from "./fixtures/registration-admission-smoke";

/**
 * Offline proof of the PURE parts of the future registration-admission smoke
 * (Milestone 3C-1): its fixture statements, its outcome classification, its run
 * lifecycle, its cleanup plan, its expected-delta comparison, and its evidence
 * writer. Nothing here connects to anything or executes SQL; every "database"
 * is a function in this file.
 */
const RUN = "0a1b2c3d";

describe("the fixture statements are pinned, and touch only the one table and the one scope", () => {
  const writes = { SET_ROW_SQL, BACKDATE_SHORT_SQL, BACKDATE_DAY_SQL, REMOVE_ROW_SQL, RENAME_AWAY_SQL, RENAME_BACK_SQL };
  const reads = { READ_ROW_SQL, COUNT_ROWS_SQL, HOLDER_ACTIVE_SQL, WAITER_BLOCKED_SQL, CAN_SEE_ACTIVITY_SQL };

  it("the writes are exactly these statements", () => {
    expect(SET_ROW_SQL).toBe(
      "UPDATE public.real_registration_admission SET short_window_start = CASE WHEN $1::int IS NULL THEN 'epoch'::timestamptz ELSE now() - make_interval(secs => $1::int) END, short_hits = $2::int, day_window_start = CASE WHEN $3::int IS NULL THEN 'epoch'::timestamptz ELSE now() - make_interval(secs => $3::int) END, day_hits = $4::int WHERE scope = 'register_options' RETURNING scope",
    );
    expect(BACKDATE_SHORT_SQL).toBe("UPDATE public.real_registration_admission SET short_window_start = short_window_start - make_interval(secs => $1::int) WHERE scope = 'register_options' RETURNING scope");
    expect(BACKDATE_DAY_SQL).toBe("UPDATE public.real_registration_admission SET day_window_start = day_window_start - make_interval(secs => $1::int) WHERE scope = 'register_options' RETURNING scope");
    expect(REMOVE_ROW_SQL).toBe("DELETE FROM public.real_registration_admission WHERE scope = 'register_options' RETURNING scope");
    expect(RENAME_AWAY_SQL).toBe("ALTER TABLE public.real_registration_admission RENAME TO real_registration_admission_moved");
    expect(RENAME_BACK_SQL).toBe("ALTER TABLE public.real_registration_admission_moved RENAME TO real_registration_admission");
  });

  it("every row write is scoped to the singleton by a literal, is one statement, names only the one table, and sends no policy number", () => {
    for (const [name, text] of Object.entries({ SET_ROW_SQL, BACKDATE_SHORT_SQL, BACKDATE_DAY_SQL, REMOVE_ROW_SQL })) {
      expect(text, name).toContain("WHERE scope = 'register_options'");
      expect(text, name).toMatch(/ RETURNING scope$/);
      expect(text.split(";").filter((part) => part.trim() !== ""), name).toHaveLength(1);
      expect(text.match(/real_registration_admission/g), name).toHaveLength(1);
      expect(text, name).not.toMatch(/\bTRUNCATE\b|\bDROP\b|\bCASCADE\b|\bJOIN\b|\bUSING\b|\bWITH\b|real_rate_limits|real_provider_budgets/i);
    }
    for (const [name, text] of Object.entries({ RENAME_AWAY_SQL, RENAME_BACK_SQL })) {
      expect(text.split(";").filter((part) => part.trim() !== ""), name).toHaveLength(1);
      expect(text, name).toMatch(/^ALTER TABLE public\.real_registration_admission(_moved)? RENAME TO real_registration_admission(_moved)?$/);
    }
    // Never a bare table name: always schema-qualified, so a search_path can never redirect a fixture write.
    for (const [name, text] of Object.entries(writes)) expect(text, name).not.toMatch(/(UPDATE|FROM|TABLE) real_registration_admission/);
  });

  it("the reads write nothing and name only the table (or the activity view)", () => {
    for (const [name, text] of Object.entries(reads)) {
      // A quoted literal (the LIKE pattern that recognises the racing UPDATE) is data, not a statement.
      expect(text.replace(/'[^']*'/g, "''"), name).not.toMatch(/\b(UPDATE|INSERT|DELETE|ALTER|DROP|TRUNCATE|CREATE|LOCK)\b|FOR (NO KEY )?UPDATE/i);
      expect(text.split(";").filter((part) => part.trim() !== ""), name).toHaveLength(1);
      expect(text, name).toMatch(/^SELECT /);
    }
    expect(READ_ROW_SQL).toContain("xmin::text AS row_xmin");
    expect(READ_ROW_SQL).toContain("ctid::text AS row_ctid");
    expect(READ_ROW_SQL).toContain("WHERE scope = 'register_options'");
    // The activity polls look only at OTHER sessions of THIS database.
    for (const text of [HOLDER_ACTIVE_SQL, WAITER_BLOCKED_SQL]) {
      expect(text).toContain("datname = pg_catalog.current_database()");
      expect(text).toContain("pid <> pg_catalog.pg_backend_pid()");
    }
    expect(WAITER_BLOCKED_SQL).toContain("wait_event_type = 'Lock'");
    expect(WAITER_BLOCKED_SQL).toContain("query ~ '^\\s*UPDATE real_registration_admission AS a'");
  });

  it("a lock holder is one UPDATE and one sleep, the sleep bounded to 1..30 whole seconds", () => {
    const exhaust = holderStatements("exhaust", 8);
    expect(exhaust).toEqual(["UPDATE public.real_registration_admission SET short_hits = 30, day_hits = 30 WHERE scope = 'register_options'", "SELECT pg_catalog.pg_sleep(8)"]);
    const roll = holderStatements("roll_short", 5);
    expect(roll[0]).toBe("UPDATE public.real_registration_admission SET short_window_start = now() - make_interval(secs => 7200), short_hits = 30 WHERE scope = 'register_options'");
    expect(roll[1]).toBe("SELECT pg_catalog.pg_sleep(5)");
    for (const bad of [0, -1, 31, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "8" as unknown as number]) expect(() => holderStatements("exhaust", bad), String(bad)).toThrow(/sleep/);
  });
});

describe("classifyAdmission — only an admission or a denial is an answer", () => {
  const ok = (value: unknown) => classifyAdmission({ status: "fulfilled", value });
  const bad = (reason: unknown) => classifyAdmission({ status: "rejected", reason });
  it("admitted and denied are recognised, by exact shape", () => {
    expect(ok({ admitted: true })).toEqual({ kind: "admitted" });
    expect(ok({ admitted: false, retryAfterSeconds: 42 })).toEqual({ kind: "denied", retryAfterSeconds: 42 });
  });
  it("anything else is no_answer, never a denial", () => {
    for (const value of [undefined, null, {}, "admitted", { admitted: true, retryAfterSeconds: 1 }, { admitted: false }, { admitted: false, retryAfterSeconds: 0 }, { admitted: false, retryAfterSeconds: 1.5 }, { admitted: false, retryAfterSeconds: 3, hits: 1 }]) {
      expect(ok(value), JSON.stringify(value)).toEqual({ kind: "no_answer" });
    }
  });
  it("the application's own fail-closed error is an admission_error with its KIND, never a denial", () => {
    expect(bad(new RegistrationAdmissionError("missing_row", "x"))).toEqual({ kind: "admission_error", errorKind: "missing_row" });
    expect(bad(new RegistrationAdmissionError("malformed_state", "x"))).toEqual({ kind: "admission_error", errorKind: "malformed_state" });
  });
  it("a database error carries a SQLSTATE and a constraint name only; a lost answer is no_answer", () => {
    expect(bad(Object.assign(new Error("relation does not exist"), { code: "42P01" }))).toEqual({ kind: "database_error", sqlState: "42P01", constraint: null });
    expect(bad(Object.assign(new Error('violates check constraint "x_check"'), { code: "23514" }))).toEqual({ kind: "database_error", sqlState: "23514", constraint: "x_check" });
    expect(bad(new Error("fetch failed"))).toEqual({ kind: "no_answer" });
    expect(bad(Object.assign(new Error("x"), { code: "nope" }))).toEqual({ kind: "no_answer" });
  });
  it("tally counts by kind", () => {
    expect(tallyOutcomes([{ kind: "admitted" }, { kind: "admitted" }, { kind: "denied", retryAfterSeconds: 3 }])).toEqual({ admitted: 2, denied: 1 });
  });
});

// ------------------------------------------------------------------ the lifecycle

const CASES = ["c1", "c2"] as const;
const CHECKS = ["p1", "p2"] as const;
const SAVED = { ok: true, file: "evidence/x.json" } as const;

function build(over: { caseDeadlineMs?: number; cleanupDeadlineMs?: number } = {}) {
  const ownership = createRunOwnership(RUN);
  const life = createRegistrationAdmissionLifecycle({ expectedCases: CASES, requiredPreflightChecks: CHECKS, caseDeadlineMs: over.caseDeadlineMs ?? 500, cleanupDeadlineMs: over.cleanupDeadlineMs ?? 500, ownership });
  return { life, ownership };
}
async function arm(life: ReturnType<typeof build>["life"]) {
  await life.runPreflight(async () => {
    await life.read("a preflight read", async () => []);
    life.preflightCheck("p1", true);
    life.preflightCheck("p2", true);
    life.arm({ startEvidence: SAVED });
  });
}
const denied = (n = 5) => async () => ({ admitted: false as const, retryAfterSeconds: n });
const admitted = async () => ({ admitted: true as const });

describe("the lifecycle — arming", () => {
  it("allows reads, and refuses ANY write, before the run is armed (and poisons)", async () => {
    const { life } = build();
    await life.runPreflight(async () => {
      await life.read("a read", async () => []);
      await expect(life.write("a write", async () => [])).rejects.toThrow(/poisoned/);
      await expect(life.writeRow("a row write", async () => [])).rejects.toThrow(/poisoned/);
    }).catch(() => undefined);
    expect(life.state()).toBe("POISONED");
    expect(life.poisoned()).toMatch(/before the run was armed/);
  });

  it("refuses to arm without every required preflight check, and without saved start evidence", async () => {
    const a = build();
    await a.life.runPreflight(async () => {
      a.life.preflightCheck("p1", true);
      expect(() => a.life.arm({ startEvidence: SAVED })).toThrow(/poisoned/);
    }).catch(() => undefined);
    expect(a.life.poisoned()).toMatch(/preflight check\(s\) not passed/);
    const b = build();
    await b.life.runPreflight(async () => {
      b.life.preflightCheck("p1", true);
      b.life.preflightCheck("p2", true);
      expect(() => b.life.arm({ startEvidence: { ok: false, reason: "write_failed", code: null } })).toThrow(/poisoned/);
    }).catch(() => undefined);
    expect(b.life.poisoned()).toMatch(/without saved start evidence/);
  });

  it("a failed or unknown or repeated preflight check poisons", async () => {
    for (const run of [(l: ReturnType<typeof build>["life"]) => l.preflightCheck("p1", false), (l: ReturnType<typeof build>["life"]) => l.preflightCheck("nope", true)]) {
      const { life } = build();
      await life.runPreflight(async () => void expect(() => run(life)).toThrow(/poisoned/)).catch(() => undefined);
      expect(life.state()).toBe("POISONED");
    }
    const { life } = build();
    await life.runPreflight(async () => {
      life.preflightCheck("p1", true);
      expect(() => life.preflightCheck("p1", true)).toThrow(/poisoned/);
    }).catch(() => undefined);
    expect(life.state()).toBe("POISONED");
  });

  it("a preflight that ends without arming is poisoned", async () => {
    const { life } = build();
    await expect(life.runPreflight(async () => undefined)).rejects.toThrow(/poisoned/);
    expect(life.poisoned()).toMatch(/without arming/);
  });

  it("no case may start before the run is armed", async () => {
    const { life } = build();
    await expect(life.runCase("c1", async () => undefined)).rejects.toThrow(/not armed/);
  });
});

describe("the lifecycle — cases and admission outcomes", () => {
  it("runs the cases in order, once each, and refuses a case that is not next (poisoning)", async () => {
    const { life } = build();
    await arm(life);
    await expect(life.runCase("c2", async () => undefined)).rejects.toThrow(/poisoned/);
    expect(life.poisoned()).toMatch(/not the next expected case/);
    await expect(life.runCase("c1", async () => undefined)).rejects.toThrow(/poisoned/); // and nothing runs afterwards
  });

  it("an admission is tallied; a denial is not an error; the operation is called EXACTLY ONCE (never retried)", async () => {
    const { life } = build();
    await arm(life);
    let calls = 0;
    await life.runCase("c1", async () => {
      expect((await life.admit("a", async () => (calls += 1, { admitted: true }))).kind).toBe("admitted");
      expect((await life.admit("b", denied(9))).kind).toBe("denied");
    });
    expect(calls).toBe(1);
    expect(life.state()).toBe("ARMED");
  });

  it("a database error, a fail-closed error, and a lost answer are NEVER a denial: each poisons", async () => {
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ["database", async () => Promise.reject(Object.assign(new Error("x"), { code: "40001" }))],
      ["fail-closed", async () => Promise.reject(new RegistrationAdmissionError("missing_row", "x"))],
      ["lost", async () => Promise.reject(new Error("fetch failed"))],
      ["nonsense", async () => ({ admitted: "maybe" })],
    ];
    for (const [label, operation] of attempts) {
      const { life } = build();
      await arm(life);
      await expect(life.runCase("c1", async () => void (await life.admit("a request", operation)))).rejects.toThrow();
      expect(life.state(), label).toBe("POISONED");
    }
  });

  it("expectAdmissionFailure accepts only the named kind; admitted, denied, another kind, and a database error all poison", async () => {
    const good = build();
    await arm(good.life);
    await good.life.runCase("c1", async () => {
      expect(await good.life.expectAdmissionFailure("x", async () => Promise.reject(new RegistrationAdmissionError("missing_row", "x")), ["missing_row"])).toBe("missing_row");
    });
    expect(good.life.state()).toBe("ARMED");
    for (const operation of [admitted, denied(), async () => Promise.reject(new RegistrationAdmissionError("malformed_state", "x")), async () => Promise.reject(Object.assign(new Error("x"), { code: "42P01" }))]) {
      const { life } = build();
      await arm(life);
      await expect(life.runCase("c1", async () => void (await life.expectAdmissionFailure("x", operation, ["missing_row"])))).rejects.toThrow();
      expect(life.state()).toBe("POISONED");
    }
  });

  it("expectDatabaseRefusal accepts only a listed SQLSTATE; success, another SQLSTATE and a lost answer poison", async () => {
    const good = build();
    await arm(good.life);
    await good.life.runCase("c1", async () => {
      const refusal = await good.life.expectDatabaseRefusal("x", async () => Promise.reject(Object.assign(new Error('violates check constraint "k_check"'), { code: "23514" })), ["23514"]);
      expect(refusal).toEqual({ sqlState: "23514", constraint: "k_check" });
    });
    for (const operation of [async () => [], async () => Promise.reject(Object.assign(new Error("x"), { code: "23505" })), async () => Promise.reject(new Error("fetch failed"))]) {
      const { life } = build();
      await arm(life);
      await expect(life.runCase("c1", async () => void (await life.expectDatabaseRefusal("x", operation, ["23514"])))).rejects.toThrow();
      expect(life.state()).toBe("POISONED");
    }
    const { life } = build();
    await arm(life);
    await expect(life.runCase("c1", async () => void (await life.expectDatabaseRefusal("x", async () => [], []))).catch((e) => Promise.reject(e))).rejects.toThrow();
  });

  it("a burst is bounded at 60, returns every outcome, and a fail-closed kind is allowed only when the burst names it", async () => {
    expect(MAX_CONCURRENCY).toBe(60);
    const { life } = build();
    await arm(life);
    await life.runCase("c1", async () => {
      const outcomes = await life.admitBurst("sixty", Array.from({ length: 60 }, (_, i) => (i < 30 ? admitted : denied())));
      expect(tallyOutcomes(outcomes)).toEqual({ admitted: 30, denied: 30 });
      const missing = await life.admitBurst("missing", Array.from({ length: 3 }, () => async () => Promise.reject(new RegistrationAdmissionError("missing_row", "x"))), ["missing_row"]);
      expect(tallyOutcomes(missing)).toEqual({ admission_error: 3 });
    });
    const over = build();
    await arm(over.life);
    await expect(over.life.runCase("c1", async () => void (await over.life.admitBurst("sixty-one", Array.from({ length: 61 }, () => admitted))))).rejects.toThrow();
    expect(over.life.poisoned()).toMatch(/concurrency bound/);
    const unlisted = build();
    await arm(unlisted.life);
    await expect(unlisted.life.runCase("c1", async () => void (await unlisted.life.admitBurst("x", [async () => Promise.reject(new RegistrationAdmissionError("missing_row", "x"))])))).rejects.toThrow();
    expect(unlisted.life.state()).toBe("POISONED");
  });

  it("a database operation outside a running case poisons", async () => {
    const { life } = build();
    await arm(life);
    await expect(life.read("outside a case", async () => [])).rejects.toThrow(/poisoned/);
    expect(life.poisoned()).toMatch(/outside a running case/);
  });

  it("a case that outlives its deadline poisons, and so does one that returns with an operation unsettled", async () => {
    const slow = build({ caseDeadlineMs: 30 });
    await arm(slow.life);
    await expect(slow.life.runCase("c1", () => new Promise<void>(() => undefined))).rejects.toThrow(/deadline/);
    expect(slow.life.poisoned()).toMatch(/exceeded its 30 ms deadline/);
    const loose = build();
    await arm(loose.life);
    let release: () => void = () => undefined;
    await expect(
      loose.life.runCase("c1", async () => {
        void loose.life.launch("never collected", () => new Promise<void>((resolve) => (release = resolve)));
      }),
    ).rejects.toThrow(/poisoned/);
    release();
    expect(loose.life.poisoned()).toMatch(/still unsettled/);
  });

  it("the operation limit, the row-write limit, and the poll limit each poison when reached", async () => {
    expect(MAX_RUN_OPERATIONS).toBe(1500);
    expect(MAX_ROW_FIXTURE_WRITES).toBe(60);
    expect(MAX_ACTIVITY_POLLS).toBe(80);
    const rows = build();
    await arm(rows.life);
    await expect(
      rows.life.runCase("c1", async () => {
        for (let i = 0; i < MAX_ROW_FIXTURE_WRITES + 1; i += 1) await rows.life.writeRow("a row write", async () => []);
      }),
    ).rejects.toThrow();
    expect(rows.life.rowFixtureWrites()).toBe(MAX_ROW_FIXTURE_WRITES);
    expect(rows.life.poisoned()).toMatch(/limit of writes to the singleton row/);
    const polls = build();
    await arm(polls.life);
    await expect(
      polls.life.runCase("c1", async () => {
        for (let i = 0; i < MAX_ACTIVITY_POLLS + 1; i += 1) await polls.life.poll("a poll", async () => []);
      }),
    ).rejects.toThrow();
    expect(polls.life.poisoned()).toMatch(/limit of activity polls/);
  });

  it("launch + collect: a holder and a racer run together, are collected, and are tallied", async () => {
    const { life } = build();
    await arm(life);
    await life.runCase("c1", async () => {
      const holder = life.launch("holder", async () => []);
      const racer = life.launch("racer", denied(7));
      await life.collectHolder(holder);
      expect(await life.collectAdmission(racer)).toEqual({ kind: "denied", retryAfterSeconds: 7 });
    });
    expect(life.state()).toBe("ARMED");
  });

  it("the runner's own failure poisons, and a poisoned run sends nothing further", async () => {
    const { life } = build();
    await arm(life);
    await life.runCase("c1", async () => undefined);
    life.afterCase({ reportedFailed: true });
    expect(life.poisoned()).toMatch(/test runner reported/);
    let sent = 0;
    await expect(life.runCase("c2", async () => void (sent += 1))).rejects.toThrow(/poisoned/);
    await expect(life.read("later read", async () => void (sent += 1))).rejects.toThrow(/poisoned/);
    expect(sent).toBe(0);
  });
});

describe("the lifecycle — the one cleanup, the end of the run, and the verdict", () => {
  /** A fake database that answers the cleanup plan's statements from the registry; nothing else. */
  function fakeDb(ownership: ReturnType<typeof createRunOwnership>, sent: string[]) {
    return {
      async q(text: string, params: unknown[] = []) {
        sent.push(text);
        if (text === SCHEMA_INVENTORY_SQL) return ownership.objectsOf(String(params[0])).map((object) => ({ kind: object.kind, name: object.name }));
        if (text === SCHEMA_EXTERNAL_DEPENDENCIES_SQL) return [{ foreign_keys: 0, triggers: 0, inheritance: 0, view_references: 0 }];
        if (text === SCHEMA_RESIDUE_SQL) return [{ n: 0 }];
        if (/^DROP (TABLE|VIEW|FUNCTION|SCHEMA) /.test(text)) return [];
        throw new Error("unexpected statement");
      },
    };
  }
  const goodDelta: DeltaVerdict = { ok: true, verdict: "baseline_plus_expected_delta", differences: [], expectedDelta: { tableAdded: "public.real_registration_admission", rows: 1, seedRow: EXPECTED_SEED_ROW }, measured: [], notMeasured: [] };

  it("plans only RESTRICT drops of registered scratch objects, read-only admission first, one residue read last — and no row deletes, no subjects, no provider table", () => {
    const ownership = createRunOwnership(RUN);
    const schema = ownership.registerScratchSchema("apply");
    ownership.registerScratchObject(schema, "table", "real_registration_admission");
    const plan = planAdmissionCleanup(ownership);
    expect(plan.steps.map((step) => [step.action, step.writes])).toEqual([
      ["inspect_inventory", false],
      ["inspect_dependencies", false],
      ["drop_object", true],
      ["drop_schema", true],
      ["read_schema_residue", false],
    ]);
    for (const step of plan.steps.filter((entry) => entry.writes)) expect(step.statement.text).toMatch(/^DROP (TABLE|VIEW|FUNCTION|SCHEMA) [a-z0-9_.]+(\(\))? RESTRICT$/);
    const all = plan.steps.map((step) => step.statement.text).join("\n");
    expect(all).not.toMatch(/CASCADE|DELETE|real_provider_budgets|real_registration_admission\b(?!.* RESTRICT)/);
  });

  it("a clean run: all cases, one confirmed cleanup, a matching comparison, and a verdict that needs both evidence records", async () => {
    const { life, ownership } = build();
    await arm(life);
    await life.runCase("c1", async () => {
      const schema = ownership.registerScratchSchema("apply");
      await life.write("creating a scratch schema", async () => []);
      ownership.registerScratchObject(schema, "table", "real_registration_admission");
    });
    await life.runCase("c2", async () => undefined);
    const sent: string[] = [];
    await life.runFinalCleanup(fakeDb(ownership, sent));
    expect(sent.some((text) => /^DROP TABLE /.test(text) && text.endsWith(" RESTRICT"))).toBe(true);
    expect(sent.some((text) => /CASCADE|DELETE/.test(text))).toBe(false);
    const final = await life.finish({ compare: async () => goodDelta });
    expect(final.outcome).toBe("COMPLETED_CLEAN");
    expect(final.verdict).toBe("baseline_plus_expected_delta");
    expect(final.completeRestoration).toBe(false); // never "restored"
    expect(final.cleanup.accepted).toBe(true);
    expect(concludeRegistrationAdmissionRun(final, { start: SAVED, final: SAVED }).pass).toBe(true);
    expect(concludeRegistrationAdmissionRun(final, { start: SAVED, final: { ok: false, reason: "already_exists", code: "EEXIST" } })).toMatchObject({ pass: false, verdict: "clean_but_not_evidenced" });
  });

  it("a poisoned run is never cleaned up, never compared, and reported as poisoned with the writes it made", async () => {
    const { life, ownership } = build();
    await arm(life);
    await life.runCase("c1", async () => {
      await life.writeRow("a row write", async () => []);
    });
    life.poison("a case failed");
    const sent: string[] = [];
    await life.runFinalCleanup(fakeDb(ownership, sent));
    expect(sent).toEqual([]);
    let compared = 0;
    const final = await life.finish({ compare: async () => (compared += 1, goodDelta) });
    expect(compared).toBe(0);
    expect(final.outcome).toBe("POISONED");
    expect(final.verdict).toBe("poisoned_evidence_preserved");
    expect(final.writes).toEqual({ rowFixtureWrites: 1, operationsIssued: 2, activityPolls: 0 }); // the preflight read, then the row write
    expect(final.action).toMatch(/Investigate the disposable branch read-only/);
    expect(concludeRegistrationAdmissionRun(final, { start: SAVED, final: SAVED }).pass).toBe(false);
  });

  it("cleanup before every case ran poisons; a cleanup that is not confirmed poisons; a second cleanup is refused", async () => {
    const early = build();
    await arm(early.life);
    await early.life.runCase("c1", async () => undefined);
    const sent: string[] = [];
    await early.life.runFinalCleanup(fakeDb(early.ownership, sent));
    expect(sent).toEqual([]);
    expect(early.life.poisoned()).toMatch(/before every expected case/);

    const failing = build();
    await arm(failing.life);
    await failing.life.runCase("c1", async () => undefined);
    await failing.life.runCase("c2", async () => undefined);
    await expect(failing.life.runFinalCleanup({ q: async () => Promise.reject(Object.assign(new Error("x"), { code: "42501" })) })).rejects.toThrow(/not confirmed|incomplete|uncertain/);
    expect(failing.life.state()).toBe("POISONED");
  });

  it("a comparison mismatch is COMPLETED_DELTA_MISMATCH and not a pass; a run that never armed reports nothing written", async () => {
    const { life, ownership } = build();
    await arm(life);
    await life.runCase("c1", async () => undefined);
    await life.runCase("c2", async () => undefined);
    await life.runFinalCleanup(fakeDb(ownership, []));
    const final = await life.finish({ compare: async () => ({ ...goodDelta, ok: false, verdict: "delta_mismatch", differences: ["x"] }) });
    expect(final.outcome).toBe("COMPLETED_DELTA_MISMATCH");
    expect(concludeRegistrationAdmissionRun(final, { start: SAVED, final: SAVED }).pass).toBe(false);
    const idle = build();
    const report: FinalReport = await idle.life.finish({ compare: async () => goodDelta });
    expect(report.outcome).toBe("NOT_STARTED");
    expect(report.action).toBe("Nothing was written.");
  });
});

// ------------------------------------------------------------------ the expected delta

describe("compareWithExpectedAdmissionDelta — the database ends at its baseline PLUS the one table holding exactly the seed row", () => {
  const fingerprint = (rows: number, tag: string) => ({ rows, contentDigest: `c-${tag}`, shapeDigest: `s-${tag}` });
  const before: DatabaseSnapshot = { tables: { real_rate_limits: fingerprint(3, "rl"), real_accounts: fingerprint(2, "ra") }, schemas: ["public"] };
  const after: DatabaseSnapshot = { tables: { ...before.tables, real_registration_admission: fingerprint(1, "adm") }, schemas: ["public"] };
  const input = (over: Partial<Parameters<typeof compareWithExpectedAdmissionDelta>[0]> = {}) => ({ before, after, admissionTable: EXPECTED_ADMISSION_TABLE, seedRow: EXPECTED_SEED_ROW, ownedSchemas: ["pb_smoke_0a1b2c3d_apply"], ...over });

  it("the intended result is the only clean one", () => {
    const verdict = compareWithExpectedAdmissionDelta(input());
    expect(verdict).toMatchObject({ ok: true, verdict: "baseline_plus_expected_delta", differences: [] });
    expect(verdict.expectedDelta.rows).toBe(1);
  });

  it.each([
    ["a malformed before-snapshot", input({ before: null })],
    ["a malformed after-snapshot", input({ after: { tables: {}, schemas: "x" } })],
    ["the new table already existed before the run", input({ before: after })],
    ["the baseline never measured real_rate_limits", input({ before: { tables: { real_accounts: fingerprint(2, "ra") }, schemas: ["public"] } })],
    ["the new table is missing afterwards", input({ after: before })],
    ["the new table holds two rows", input({ after: { ...after, tables: { ...after.tables, real_registration_admission: fingerprint(2, "adm") } } })],
    ["the new table is empty", input({ after: { ...after, tables: { ...after.tables, real_registration_admission: fingerprint(0, "adm") } } })],
    ["a pre-existing table changed content", input({ after: { ...after, tables: { ...after.tables, real_accounts: fingerprint(2, "changed") } } })],
    ["a pre-existing table changed shape", input({ after: { ...after, tables: { ...after.tables, real_rate_limits: { ...fingerprint(3, "rl"), shapeDigest: "s-other" } } } })],
    ["a pre-existing table disappeared", input({ after: { ...after, tables: { real_registration_admission: fingerprint(1, "adm") } } })],
    ["an unexpected extra table appeared", input({ after: { ...after, tables: { ...after.tables, stray: fingerprint(0, "x") } } })],
    ["the descriptor differs (an extra index)", input({ admissionTable: { ...EXPECTED_ADMISSION_TABLE, indexes: ["real_registration_admission_pkey", "extra_idx"] } })],
    ["the descriptor differs (no row)", input({ admissionTable: { ...EXPECTED_ADMISSION_TABLE, rows: 0 } })],
    ["the descriptor is unreadable", input({ admissionTable: null })],
    ["the singleton is not the seed (a counter is left over)", input({ seedRow: { ...EXPECTED_SEED_ROW, shortHits: 1 } })],
    ["the singleton is not the seed (a window start is not the epoch)", input({ seedRow: { ...EXPECTED_SEED_ROW, dayAtEpoch: false } })],
    ["the singleton was not read", input({ seedRow: null })],
    ["a scratch schema remains", input({ after: { ...after, schemas: ["public", "pb_smoke_0a1b2c3d_apply"] } })],
    ["the set of schemas changed", input({ after: { ...after, schemas: ["public", "other"] } })],
    ["a scratch schema existed before", input({ before: { ...before, schemas: ["public", "pb_smoke_0a1b2c3d_apply"] } })],
  ])("a mismatch: %s", (_name, value) => {
    const verdict = compareWithExpectedAdmissionDelta(value as never);
    expect(verdict.ok).toBe(false);
    expect(verdict.verdict).toBe("delta_mismatch");
    expect(verdict.differences.length).toBeGreaterThan(0);
  });

  it("the expected descriptor names exactly the five columns and four constraints schema.sql defines", () => {
    const schema = readFileSync("lib/real/server/schema.sql", "utf8");
    const block = schema.slice(schema.indexOf("-- BEGIN Registration Admission"), schema.indexOf("-- END Registration Admission"));
    for (const column of EXPECTED_ADMISSION_TABLE.columns) expect(block, column.name).toMatch(new RegExp(`\\n\\s+${column.name}\\s`));
    for (const constraint of EXPECTED_ADMISSION_TABLE.constraints) expect(block, constraint.name).toContain(`CONSTRAINT ${constraint.name} `);
    expect(EXPECTED_ADMISSION_TABLE.columns).toHaveLength(5);
    expect(EXPECTED_ADMISSION_TABLE.constraints).toHaveLength(4);
    expect(EXPECTED_ADMISSION_TABLE.indexes).toEqual(["real_registration_admission_pkey"]);
    expect(EXPECTED_ADMISSION_TABLE.rows).toBe(1);
    expect(EXPECTED_SEED_ROW).toEqual({ shortHits: 0, dayHits: 0, shortAtEpoch: true, dayAtEpoch: true });
  });
});

// ------------------------------------------------------------------ file selection and evidence

describe("run selection", () => {
  it("accepts exactly `vitest run <this file>` (with the two timeout flags) and nothing else", () => {
    expect(REGISTRATION_ADMISSION_SMOKE_FILE).toBe("test/lib/real/registration-admission.smoke.test.ts");
    expect(checkRegistrationAdmissionFileSelection(["run", REGISTRATION_ADMISSION_SMOKE_FILE])).toEqual({ ok: true });
    expect(checkRegistrationAdmissionFileSelection(["run", REGISTRATION_ADMISSION_SMOKE_FILE, "--testTimeout=120000"])).toEqual({ ok: true });
    for (const args of [undefined, [], ["run"], ["watch", REGISTRATION_ADMISSION_SMOKE_FILE], ["run", "test/lib/real/provider-budget.smoke.test.ts"], ["run", REGISTRATION_ADMISSION_SMOKE_FILE, "test/lib/real/rate-limit.test.ts"], ["run", REGISTRATION_ADMISSION_SMOKE_FILE, "-t", "S1"], ["run", REGISTRATION_ADMISSION_SMOKE_FILE, "--testNamePattern=S1"], ["run", REGISTRATION_ADMISSION_SMOKE_FILE, "--reporter=json"], ["run", "test/lib/real"]]) {
      expect(checkRegistrationAdmissionFileSelection(args as never).ok, JSON.stringify(args)).toBe(false);
    }
  });
});

describe("the evidence writer", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  // Always OUTSIDE the repository: a temp directory, removed after each test.
  const scratch = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ra-smoke-evidence-"));
    made.push(dir);
    return path.join(dir, "evidence");
  };
  const start = { runId: RUN, server: { version: "18.6" }, connectionMode: "pooled", migrationStatementSha256: "a".repeat(64), expectedCases: ["c1"], fingerprintsBefore: {} };
  const final = { ...start, lifecycleOutcome: "COMPLETED_CLEAN", casesExecuted: [], casesNotExecuted: [], admissionTallies: {}, schemaRefusals: [], rowSnapshots: {}, cleanup: {}, fingerprintsAfter: {}, expectedDelta: {}, writes: {}, unknownOperations: [], inFlightOperations: [], verdict: "baseline_plus_expected_delta" };

  it("writes a new owner-only file named from the run id and stage, and never overwrites", () => {
    const directory = scratch();
    const first = writeRegistrationAdmissionEvidence({ directory, runId: RUN, stage: "start", evidence: start });
    expect(first).toEqual({ ok: true, file: path.join(directory, `registration-admission-smoke-${RUN}-start.json`) });
    expect(statSync((first as { file: string }).file).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o077).toBe(0);
    expect(writeRegistrationAdmissionEvidence({ directory, runId: RUN, stage: "start", evidence: start })).toMatchObject({ ok: false, reason: "already_exists" });
    expect(writeRegistrationAdmissionEvidence({ directory, runId: RUN, stage: "final", evidence: final })).toMatchObject({ ok: true });
  });

  it("refuses an incomplete record, a bad run id or stage, and anything that looks like a secret or a database location", () => {
    const directory = scratch();
    expect(missingEvidenceFields("start", {})).toEqual([...["runId", "server", "connectionMode", "migrationStatementSha256", "expectedCases", "fingerprintsBefore"]]);
    expect(writeRegistrationAdmissionEvidence({ directory, runId: RUN, stage: "final", evidence: start })).toMatchObject({ ok: false, reason: "incomplete" });
    expect(writeRegistrationAdmissionEvidence({ directory, runId: "../x", stage: "start", evidence: start })).toMatchObject({ ok: false, reason: "invalid_run_id" });
    expect(writeRegistrationAdmissionEvidence({ directory, runId: RUN, stage: "middle" as never, evidence: start })).toMatchObject({ ok: false, reason: "invalid_run_id" });
    expect(writeRegistrationAdmissionEvidence({ directory, runId: "deadbeef", stage: "start", evidence: start })).toMatchObject({ ok: false, reason: "incomplete" }); // the record's run id must match
    for (const poison of ["postgres://user:pw@host/db", "ep-cool-name-123456", "x-pooler.region", "my password", "api_key", "a bearer abc", "an authorization header", "a credential id"]) {
      expect(writeRegistrationAdmissionEvidence({ directory, runId: RUN, stage: "start", evidence: { ...start, note: poison } }), poison).toMatchObject({ ok: false, reason: "unsafe_content" });
    }
    expect(existsSync(path.join(directory, `registration-admission-smoke-${RUN}-start.json`))).toBe(false);
  });

  it("refuses a directory others can enter, and never re-permissions it", () => {
    const directory = scratch();
    expect(writeRegistrationAdmissionEvidence({ directory, runId: RUN, stage: "start", evidence: start }).ok).toBe(true);
    chmodSync(directory, 0o755);
    expect(writeRegistrationAdmissionEvidence({ directory, runId: RUN, stage: "final", evidence: final })).toMatchObject({ ok: false, reason: "directory_not_private" });
    expect(statSync(directory).mode & 0o777).toBe(0o755); // untouched
  });
});
