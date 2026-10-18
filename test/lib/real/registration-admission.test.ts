import { describe, expect, it } from "vitest";
import {
  REGISTRATION_ADMISSION_MAX_LIMIT,
  REGISTRATION_ADMISSION_MAX_WINDOW_SECONDS,
  REGISTRATION_ADMISSION_POLICY,
  RegistrationAdmissionError,
  classifyRegistrationDenial,
  createInMemoryRegistrationAdmissionStore,
  createRegistrationAdmission,
  interpretAdmittedRows,
  validateRegistrationAdmissionPolicy,
  type RegistrationAdmissionPolicy,
  type RegistrationAdmissionStore,
} from "@/lib/real/server/registration-admission";
import { createNeonRegistrationAdmissionStore } from "@/lib/real/server/neon-store";

/**
 * Milestone 3C-1 — the policy, the in-memory model, the limiter wrapper, the
 * Neon adapter (against a scripted fake `sql`; NO database, NO network), and
 * Retry-After. Offline only: nothing here executes SQL.
 */

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const P = REGISTRATION_ADMISSION_POLICY;
const SMALL: RegistrationAdmissionPolicy = { short: { limit: 2, windowSeconds: 10 }, day: { limit: 5, windowSeconds: 100 } };

function clock(start = T0) {
  let now = start;
  return { now: () => now, set: (value: number) => void (now = value), advance: (ms: number) => void (now += ms) };
}

describe("the frozen production policy", () => {
  it("is exactly 30 per 3600 s and 100 per 86400 s, deeply frozen", () => {
    expect(P).toEqual({ short: { limit: 30, windowSeconds: 3600 }, day: { limit: 100, windowSeconds: 86_400 } });
    expect(Object.isFrozen(P) && Object.isFrozen(P.short) && Object.isFrozen(P.day)).toBe(true);
    expect(() => {
      "use strict";
      (P.short as { limit: number }).limit = 9999;
    }).toThrow();
    expect(P.short.limit).toBe(30);
  });

  it("passes its own validation and comes back as a fresh frozen copy", () => {
    const copy = validateRegistrationAdmissionPolicy(P);
    expect(copy).toEqual(P);
    expect(copy).not.toBe(P);
    expect(Object.isFrozen(copy) && Object.isFrozen(copy.short) && Object.isFrozen(copy.day)).toBe(true);
  });
});

describe("policy validation — every value, before any statement", () => {
  const w = (limit: unknown, windowSeconds: unknown) => ({ limit, windowSeconds });
  const day = w(100, 86_400);
  const short = w(30, 3600);
  const bad: [string, unknown][] = [
    ["null policy", null],
    ["undefined policy", undefined],
    ["string policy", "30/3600"],
    ["array policy", []],
    ["missing day", { short }],
    ["missing short", { day }],
    ["extra key", { short, day, hour: short }],
    ["short window not an object", { short: 30, day }],
    ["short window is an array", { short: [30, 3600], day }],
    ["short window missing a key", { short: { limit: 30 }, day }],
    ["short window extra key", { short: { ...short, burst: 1 }, day }],
    ["zero short window", { short: w(30, 0), day }],
    ["negative short window", { short: w(30, -5), day }],
    ["zero day window", { short, day: w(100, 0) }],
    ["negative day window", { short, day: w(100, -86_400) }],
    ["fractional window", { short: w(30, 3600.5), day }],
    ["NaN window", { short: w(30, Number.NaN), day }],
    ["Infinity window", { short: w(30, Number.POSITIVE_INFINITY), day }],
    ["-Infinity window", { short: w(30, Number.NEGATIVE_INFINITY), day }],
    ["unsafe-integer window", { short: w(30, 2 ** 53), day }],
    ["string window", { short: w(30, "3600"), day }],
    ["null window", { short: w(30, null), day }],
    ["object-valued window", { short: w(30, { valueOf: () => 3600 }), day }],
    ["day window beyond 86400", { short, day: w(100, 86_401) }],
    ["short window equal to the day window", { short: w(30, 86_400), day }],
    ["short window longer than the day window", { short: w(30, 90_000 > 86_400 ? 86_400 : 90_000), day: w(100, 3600) }],
    ["zero limit", { short: w(0, 3600), day }],
    ["negative limit", { short: w(-1, 3600), day }],
    ["zero day limit", { short, day: w(0, 86_400) }],
    ["fractional limit", { short: w(1.5, 3600), day }],
    ["NaN limit", { short: w(Number.NaN, 3600), day }],
    ["Infinity limit", { short: w(Number.POSITIVE_INFINITY, 3600), day }],
    ["unsafe limit", { short: w(2 ** 53, 3600), day }],
    ["string limit", { short: w("30", 3600), day }],
    ["limit beyond 100000", { short: w(100_001, 3600), day }],
    ["day limit beyond 100000", { short, day: w(100_001, 86_400) }],
  ];
  it.each(bad)("rejects: %s", (_label, policy) => {
    expect(() => validateRegistrationAdmissionPolicy(policy)).toThrow(RegistrationAdmissionError);
    try {
      validateRegistrationAdmissionPolicy(policy);
    } catch (error) {
      expect((error as RegistrationAdmissionError).kind).toBe("policy");
    }
  });

  it("accepts the documented extremes", () => {
    expect(() => validateRegistrationAdmissionPolicy({ short: w(1, 1), day: w(REGISTRATION_ADMISSION_MAX_LIMIT, REGISTRATION_ADMISSION_MAX_WINDOW_SECONDS) })).not.toThrow();
  });

  it("the in-memory store refuses a bad policy and changes nothing", async () => {
    const store = createInMemoryRegistrationAdmissionStore(() => T0);
    await store.admit(P);
    const before = store.snapshot();
    for (const [, policy] of bad) await expect(store.admit(policy as never)).rejects.toThrow(RegistrationAdmissionError);
    expect(store.snapshot()).toEqual(before);
  });
});

describe("the in-memory model — the SAME two-window rules as the SQL", () => {
  it("the first admission anchors BOTH windows at its own time", async () => {
    const c = clock();
    const store = createInMemoryRegistrationAdmissionStore(c.now);
    expect(store.snapshot()).toMatchObject({ shortHits: 0, dayHits: 0 });
    expect(await store.admit(P)).toEqual({ admitted: true });
    expect(store.snapshot()).toEqual({ shortStartMs: T0, shortHits: 1, dayStartMs: T0, dayHits: 1 });
  });

  it("works with a clock that starts at 0 (an unseeded window counts as elapsed)", async () => {
    const store = createInMemoryRegistrationAdmissionStore(() => 0);
    expect(await store.admit(P)).toEqual({ admitted: true });
  });

  it("admits EXACTLY 30 in an hour and refuses the 31st, charging nothing for the refusal", async () => {
    const c = clock();
    const store = createInMemoryRegistrationAdmissionStore(c.now);
    for (let i = 1; i <= 30; i += 1) {
      c.advance(10);
      expect(await store.admit(P), `request ${i}`).toEqual({ admitted: true });
    }
    const exhausted = store.snapshot();
    expect(exhausted).toMatchObject({ shortHits: 30, dayHits: 30 });
    c.advance(10);
    expect(await store.admit(P)).toEqual({ admitted: false, retryAfterSeconds: Math.ceil((T0 + 10 + HOUR - c.now()) / 1000) }); // the window opened at the first admission (T0 + 10 ms)
    expect(store.snapshot()).toEqual(exhausted);
  });

  it("a hundred refusals change neither counter nor either window", async () => {
    const c = clock();
    const store = createInMemoryRegistrationAdmissionStore(c.now);
    for (let i = 0; i < 30; i += 1) await store.admit(P);
    const exhausted = store.snapshot();
    for (let i = 0; i < 100; i += 1) {
      c.advance(1000);
      expect((await store.admit(P)).admitted).toBe(false);
    }
    expect(store.snapshot()).toEqual(exhausted);
  });

  it("the hour boundary: refused up to the last millisecond, admitted exactly at +3600 s with the hourly window reset and the daily one charged", async () => {
    const c = clock();
    const store = createInMemoryRegistrationAdmissionStore(c.now);
    for (let i = 0; i < 30; i += 1) await store.admit(P);
    c.set(T0 + HOUR - 1);
    expect(await store.admit(P)).toEqual({ admitted: false, retryAfterSeconds: 1 });
    c.set(T0 + HOUR);
    expect(await store.admit(P)).toEqual({ admitted: true });
    expect(store.snapshot()).toEqual({ shortStartMs: T0 + HOUR, shortHits: 1, dayStartMs: T0, dayHits: 31 });
  });

  it("exactly 100 per day across several hourly windows, then the 101st is refused even though the hourly window has room", async () => {
    const c = clock();
    const store = createInMemoryRegistrationAdmissionStore(c.now);
    const plan = [30, 30, 30, 10];
    for (const [hour, count] of plan.entries()) {
      c.set(T0 + hour * HOUR);
      for (let i = 0; i < count; i += 1) expect(await store.admit(P)).toEqual({ admitted: true });
    }
    expect(store.snapshot()).toMatchObject({ shortHits: 10, dayHits: 100 });
    const exhausted = store.snapshot();
    const refused = await store.admit(P);
    expect(refused).toEqual({ admitted: false, retryAfterSeconds: (DAY - 3 * HOUR) / 1000 });
    expect(store.snapshot()).toEqual(exhausted); // the hourly window was NOT charged by the daily refusal
  });

  it("the daily boundary: the 101st is admitted exactly at +86400 s, resetting the daily window", async () => {
    const c = clock();
    const store = createInMemoryRegistrationAdmissionStore(c.now);
    for (const [hour, count] of [30, 30, 30, 10].entries()) {
      c.set(T0 + hour * HOUR);
      for (let i = 0; i < count; i += 1) await store.admit(P);
    }
    c.set(T0 + DAY - 1);
    expect((await store.admit(P)).admitted).toBe(false);
    c.set(T0 + DAY);
    expect(await store.admit(P)).toEqual({ admitted: true });
    expect(store.snapshot()).toEqual({ shortStartMs: T0 + DAY, shortHits: 1, dayStartMs: T0 + DAY, dayHits: 1 });
  });

  it("windows roll INDEPENDENTLY: the daily window rolls while the hourly one is mid-window", async () => {
    const c = clock(0);
    const store = createInMemoryRegistrationAdmissionStore(c.now);
    c.set(0);
    await store.admit(SMALL);
    c.set(95_000);
    await store.admit(SMALL); // short elapsed -> new window at 95 s; day charged
    c.set(100_000);
    expect(await store.admit(SMALL)).toEqual({ admitted: true }); // day elapsed -> reset; short mid-window -> incremented
    expect(store.snapshot()).toEqual({ shortStartMs: 95_000, shortHits: 2, dayStartMs: 100_000, dayHits: 1 });
    c.set(101_000);
    expect(await store.admit(SMALL)).toEqual({ admitted: false, retryAfterSeconds: 4 }); // only the short window is to blame
  });

  it("windows roll independently the other way: the hourly window rolls while the daily one keeps counting", async () => {
    const c = clock(0);
    const store = createInMemoryRegistrationAdmissionStore(c.now);
    await store.admit(SMALL);
    await store.admit(SMALL);
    c.set(10_000);
    await store.admit(SMALL);
    expect(store.snapshot()).toEqual({ shortStartMs: 10_000, shortHits: 1, dayStartMs: 0, dayHits: 3 });
  });

  it("a request refused by the SHORT window does not charge the DAILY one", async () => {
    const c = clock(0);
    const store = createInMemoryRegistrationAdmissionStore(c.now);
    await store.admit(SMALL);
    await store.admit(SMALL);
    const exhausted = store.snapshot();
    for (let i = 0; i < 10; i += 1) expect((await store.admit(SMALL)).admitted).toBe(false);
    expect(store.snapshot()).toEqual(exhausted);
    expect(exhausted.dayHits).toBe(2);
  });

  it("a request refused by the DAILY window does not touch the (elapsed) HOURLY one — no extension, no reset", async () => {
    const c = clock(0);
    const store = createInMemoryRegistrationAdmissionStore(c.now);
    const dayOfTwo: RegistrationAdmissionPolicy = { short: { limit: 2, windowSeconds: 10 }, day: { limit: 2, windowSeconds: 100 } };
    await store.admit(dayOfTwo);
    await store.admit(dayOfTwo);
    const exhausted = store.snapshot();
    c.set(50_000); // hourly window elapsed, daily still active and exhausted
    for (let i = 0; i < 5; i += 1) expect(await store.admit(dayOfTwo)).toEqual({ admitted: false, retryAfterSeconds: 50 });
    expect(store.snapshot()).toEqual(exhausted);
  });

  it("lowering a limit below the current count refuses (it is exhausted, not corrupt); raising it admits again", async () => {
    const c = clock(0);
    const store = createInMemoryRegistrationAdmissionStore(c.now);
    for (let i = 0; i < 5; i += 1) await store.admit({ short: { limit: 10, windowSeconds: 10 }, day: { limit: 50, windowSeconds: 100 } });
    c.set(1000);
    expect(await store.admit({ short: { limit: 3, windowSeconds: 10 }, day: { limit: 50, windowSeconds: 100 } })).toEqual({ admitted: false, retryAfterSeconds: 9 });
    expect(await store.admit({ short: { limit: 10, windowSeconds: 10 }, day: { limit: 50, windowSeconds: 100 } })).toEqual({ admitted: true });
  });
});

describe("the limiter wrapper", () => {
  it("hands the store exactly the frozen policy and returns a clean decision", async () => {
    const seen: unknown[] = [];
    const store: RegistrationAdmissionStore = {
      async admit(policy) {
        seen.push(policy);
        return { admitted: true };
      },
    };
    expect(await createRegistrationAdmission(store).admit()).toEqual({ admitted: true });
    expect(seen).toEqual([P]);
    expect(createRegistrationAdmission(store).admit.length).toBe(0); // no caller-supplied numbers
  });

  it("admits 30, refuses the 31st", async () => {
    const store = createInMemoryRegistrationAdmissionStore(clock().now);
    const admission = createRegistrationAdmission(store);
    for (let i = 0; i < 30; i += 1) expect(await admission.admit()).toEqual({ admitted: true });
    const refused = await admission.admit();
    expect(refused).toMatchObject({ admitted: false });
    expect(Object.keys(refused).sort()).toEqual(["admitted", "retryAfterSeconds"]);
  });

  it("a refusal carries only a whole-second delay — no hit count, limit, window, or key", async () => {
    const admission = createRegistrationAdmission({ admit: async () => ({ admitted: false, retryAfterSeconds: 77, hits: 31, limit: 30, key: "x" }) as never });
    expect(await admission.admit()).toEqual({ admitted: false, retryAfterSeconds: 77 });
  });

  it("FAILS CLOSED: a store that throws makes admit() throw", async () => {
    await expect(createRegistrationAdmission({ admit: async () => Promise.reject(new Error("boom")) }).admit()).rejects.toThrow("boom");
  });

  const unusable: unknown[] = [
    undefined,
    null,
    "admitted",
    true,
    {},
    { admitted: "true" },
    { admitted: 1 },
    { admitted: false },
    { admitted: false, retryAfterSeconds: 0 },
    { admitted: false, retryAfterSeconds: -1 },
    { admitted: false, retryAfterSeconds: 1.5 },
    { admitted: false, retryAfterSeconds: Number.NaN },
    { admitted: false, retryAfterSeconds: Number.POSITIVE_INFINITY },
    { admitted: false, retryAfterSeconds: "30" },
    { admitted: false, retryAfterSeconds: 86_401 },
  ];
  it.each(unusable.map((value, index) => [index, value] as const))("FAILS CLOSED: unusable answer #%i is never an admission", async (_index, value) => {
    await expect(createRegistrationAdmission({ admit: async () => value as never }).admit()).rejects.toThrow(RegistrationAdmissionError);
  });
});

/** A scripted fake of the Neon tagged-template function: records every call, answers from a queue. */
function scriptedSql(script: (unknown[] | Error)[]) {
  const calls: { text: string; values: unknown[] }[] = [];
  let transactionUsed = 0;
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join("$").replace(/\s+/g, " ").trim(), values });
      const next = script[calls.length - 1];
      if (next === undefined) throw new Error("unexpected extra statement");
      if (next instanceof Error) throw next;
      return next;
    },
    {
      transaction: () => {
        transactionUsed += 1;
        throw new Error("sql.transaction must never be used");
      },
    },
  ) as never;
  return { sql, calls, transactionUsed: () => transactionUsed };
}

const ADMITTED = [{ short_hits: 1, day_hits: 1 }];
const exhaustedShort = (extra: Record<string, unknown> = {}) => [{ short_hits: 30, day_hits: 30, short_wait: 1200, day_wait: 80_000, ...extra }];

describe("the Neon adapter — E1 admits, E2 only classifies", () => {
  it("an admission is ONE statement: a conditional UPDATE ... RETURNING on the singleton row", async () => {
    const { sql, calls } = scriptedSql([[{ short_hits: 7, day_hits: 40 }]]);
    expect(await createNeonRegistrationAdmissionStore(sql).admit(P)).toEqual({ admitted: true });
    expect(calls).toHaveLength(1);
    const text = calls[0]!.text;
    expect(text).toMatch(/^UPDATE real_registration_admission AS a SET short_window_start = CASE WHEN a\.short_window_start \+ make_interval\(secs => \$::int\) <= now\(\) THEN now\(\) ELSE a\.short_window_start END, short_hits = CASE WHEN /);
    expect(text).toContain("WHERE a.scope = 'register_options' AND (a.short_window_start + make_interval(secs => $::int) <= now() OR a.short_hits < $::int) AND (a.day_window_start + make_interval(secs => $::int) <= now() OR a.day_hits < $::int)");
    expect(text).toMatch(/RETURNING a\.short_hits, a\.day_hits$/);
    // One statement, no other table, no sub-select (it would read the old snapshot), no lock, no refund, no server wall clock, no transaction.
    expect(text.split(";").filter((part) => part.trim() !== "")).toHaveLength(1);
    expect(text).not.toMatch(/\bSELECT\b|\bBEGIN\b|\bCOMMIT\b|FOR (NO KEY )?UPDATE|INSERT|DELETE|clock_timestamp|statement_timestamp|hits - 1|hits-1|GREATEST|LEAST/i);
    expect(text.match(/real_registration_admission/g)).toHaveLength(1);
  });

  it("sends only the four policy numbers, as parameters, in the order the statement uses them — nothing about the request", async () => {
    const { sql, calls } = scriptedSql([ADMITTED]);
    await createNeonRegistrationAdmissionStore(sql).admit(P);
    // SET: short window x2, day window x2; WHERE: short window, short limit, day window, day limit.
    expect(calls[0]!.values).toEqual([3600, 3600, 86_400, 86_400, 3600, 30, 86_400, 100]);
    expect(calls[0]!.text).not.toMatch(/'(3600|86400|30|100)'/);
  });

  it("an admission runs NO second statement", async () => {
    const { sql, calls } = scriptedSql([ADMITTED]);
    await createNeonRegistrationAdmissionStore(sql).admit(P);
    expect(calls).toHaveLength(1);
  });

  it("zero rows from E1 runs E2: a SEPARATE, read-only SELECT", async () => {
    const { sql, calls } = scriptedSql([[], exhaustedShort()]);
    expect(await createNeonRegistrationAdmissionStore(sql).admit(P)).toEqual({ admitted: false, retryAfterSeconds: 1200 });
    expect(calls).toHaveLength(2);
    const text = calls[1]!.text;
    expect(text).toMatch(/^SELECT a\.short_hits, a\.day_hits, CASE WHEN a\.short_window_start \+ make_interval\(secs => \$::int\) <= now\(\) THEN NULL ELSE LEAST\(GREATEST\(ceil\(extract\(epoch FROM/);
    expect(text).toMatch(/FROM real_registration_admission a WHERE a\.scope = 'register_options'$/);
    expect(text).not.toMatch(/\bUPDATE\b|\bINSERT\b|\bDELETE\b|FOR (NO KEY )?UPDATE|\bBEGIN\b|\bCOMMIT\b|WITH /i);
    expect(text).toContain("1000000");
    expect(calls[1]!.values).toEqual([3600, 3600, 86_400, 86_400]); // only the two window lengths, each used twice
  });

  it("E2 NEVER grants admission: capacity seen after a refusal is still a refusal, advised at 1 second", async () => {
    for (const row of [
      { short_hits: 3, day_hits: 3, short_wait: 3000, day_wait: 80_000 },
      { short_hits: 0, day_hits: 0, short_wait: null, day_wait: null },
      { short_hits: 30, day_hits: 30, short_wait: null, day_wait: null }, // both windows rolled in between
    ]) {
      const { sql } = scriptedSql([[], [row]]);
      expect(await createNeonRegistrationAdmissionStore(sql).admit(P)).toEqual({ admitted: false, retryAfterSeconds: 1 });
    }
  });

  it("a missing singleton row (E1 and E2 both empty) THROWS — never an admission", async () => {
    const { sql, calls } = scriptedSql([[], []]);
    const failure = await createNeonRegistrationAdmissionStore(sql).admit(P).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RegistrationAdmissionError);
    expect((failure as RegistrationAdmissionError).kind).toBe("missing_row");
    expect(calls).toHaveLength(2); // and no third statement tried to repair it
  });

  it("more than one row from E1 THROWS and E2 is never consulted", async () => {
    const { sql, calls } = scriptedSql([[...ADMITTED, ...ADMITTED]]);
    await expect(createNeonRegistrationAdmissionStore(sql).admit(P)).rejects.toThrow(RegistrationAdmissionError);
    expect(calls).toHaveLength(1);
  });

  it("more than one row from E2 THROWS", async () => {
    const { sql } = scriptedSql([[], [...exhaustedShort(), ...exhaustedShort()]]);
    await expect(createNeonRegistrationAdmissionStore(sql).admit(P)).rejects.toThrow(RegistrationAdmissionError);
  });

  const malformedAdmissions: [string, unknown][] = [
    ["null counters", [{ short_hits: null, day_hits: null }]],
    ["missing counters", [{}]],
    ["zero short counter", [{ short_hits: 0, day_hits: 1 }]],
    ["zero day counter", [{ short_hits: 1, day_hits: 0 }]],
    ["negative counter", [{ short_hits: -1, day_hits: 1 }]],
    ["fractional counter", [{ short_hits: 1.5, day_hits: 1 }]],
    ["non-numeric counter", [{ short_hits: "many", day_hits: 1 }]],
    ["short counter above its limit", [{ short_hits: 31, day_hits: 1 }]],
    ["day counter above its limit", [{ short_hits: 1, day_hits: 101 }]],
    ["a row that is not an object", ["1"]],
  ];
  it.each(malformedAdmissions)("a malformed admission row THROWS: %s", async (_label, rows) => {
    const { sql } = scriptedSql([rows as never]);
    await expect(createNeonRegistrationAdmissionStore(sql).admit(P)).rejects.toThrow(RegistrationAdmissionError);
  });

  it("counters returned as digit strings are accepted (the driver's text form), exactly at the limits", async () => {
    const { sql } = scriptedSql([[{ short_hits: "30", day_hits: "100" }]]);
    expect(await createNeonRegistrationAdmissionStore(sql).admit(P)).toEqual({ admitted: true });
  });

  const malformedStates: [string, Record<string, unknown>][] = [
    ["null hits", { short_hits: null, day_hits: 1, short_wait: 5, day_wait: 5 }],
    ["negative hits", { short_hits: -1, day_hits: 1, short_wait: 5, day_wait: 5 }],
    ["fractional hits", { short_hits: 1.5, day_hits: 1, short_wait: 5, day_wait: 5 }],
    ["hits beyond the table's own bound", { short_hits: 100_001, day_hits: 1, short_wait: 5, day_wait: 5 }],
    ["missing short_wait", { short_hits: 30, day_hits: 30, day_wait: 5 }],
    ["missing day_wait", { short_hits: 30, day_hits: 30, short_wait: 5 }],
    ["zero wait", { short_hits: 30, day_hits: 30, short_wait: 0, day_wait: 5 }],
    ["negative wait", { short_hits: 30, day_hits: 30, short_wait: -4, day_wait: 5 }],
    ["fractional wait", { short_hits: 30, day_hits: 30, short_wait: 4.5, day_wait: 5 }],
    ["NaN wait", { short_hits: 30, day_hits: 30, short_wait: Number.NaN, day_wait: 5 }],
    ["string wait", { short_hits: 30, day_hits: 30, short_wait: "soon", day_wait: 5 }],
    ["short wait beyond the window plus tolerance", { short_hits: 30, day_hits: 30, short_wait: 3661, day_wait: 5 }],
    ["day wait beyond the window plus tolerance", { short_hits: 30, day_hits: 30, short_wait: 5, day_wait: 86_461 }],
    ["the SQL's own sentinel (a window start far in the future)", { short_hits: 30, day_hits: 30, short_wait: 1_000_000, day_wait: 5 }],
  ];
  it.each(malformedStates)("a malformed E2 row THROWS: %s", async (_label, row) => {
    const { sql } = scriptedSql([[], [row]]);
    await expect(createNeonRegistrationAdmissionStore(sql).admit(P)).rejects.toThrow(RegistrationAdmissionError);
  });

  it("database exceptions PROPAGATE untouched — a storage failure is never a refusal and never an admission", async () => {
    for (const error of [new Error('relation "real_registration_admission" does not exist'), Object.assign(new Error("serialization failure"), { code: "40001" }), new Error("fetch failed")]) {
      const first = scriptedSql([error]);
      await expect(createNeonRegistrationAdmissionStore(first.sql).admit(P)).rejects.toBe(error);
      expect(first.calls).toHaveLength(1); // E2 is not tried after a failed E1
      const second = scriptedSql([[], error]);
      await expect(createNeonRegistrationAdmissionStore(second.sql).admit(P)).rejects.toBe(error);
    }
  });

  it("never uses a transaction, and no statement refunds a charge", async () => {
    const admitted = scriptedSql([ADMITTED]);
    await createNeonRegistrationAdmissionStore(admitted.sql).admit(P);
    const refused = scriptedSql([[], exhaustedShort()]);
    await createNeonRegistrationAdmissionStore(refused.sql).admit(P);
    expect(admitted.transactionUsed() + refused.transactionUsed()).toBe(0);
  });

  it("an invalid policy makes ZERO database calls", async () => {
    const bad: unknown[] = [
      { short: { limit: 30, windowSeconds: 0 }, day: P.day },
      { short: { limit: 30, windowSeconds: -3600 }, day: P.day },
      { short: P.short, day: { limit: 100, windowSeconds: 0 } },
      { short: { limit: 0, windowSeconds: 3600 }, day: P.day },
      { short: { limit: Number.NaN, windowSeconds: 3600 }, day: P.day },
      { short: P.day, day: P.short },
      null,
      undefined,
      {},
    ];
    for (const policy of bad) {
      const { sql, calls } = scriptedSql([ADMITTED, ADMITTED]);
      await expect(createNeonRegistrationAdmissionStore(sql).admit(policy as never)).rejects.toThrow(RegistrationAdmissionError);
      expect(calls, JSON.stringify(policy)).toHaveLength(0);
    }
  });
});

describe("Retry-After", () => {
  const classify = (row: Record<string, unknown>, policy = P) => classifyRegistrationDenial(policy, [row]);

  it("short window exhausted: its wait", () => {
    expect(classify({ short_hits: 30, day_hits: 40, short_wait: 1200, day_wait: 80_000 })).toEqual({ admitted: false, retryAfterSeconds: 1200 });
  });

  it("daily window exhausted: its wait", () => {
    expect(classify({ short_hits: 5, day_hits: 100, short_wait: 1200, day_wait: 80_000 })).toEqual({ admitted: false, retryAfterSeconds: 80_000 });
  });

  it("both exhausted: the LONGEST wait", () => {
    expect(classify({ short_hits: 30, day_hits: 100, short_wait: 3000, day_wait: 900 })).toEqual({ admitted: false, retryAfterSeconds: 3000 });
    expect(classify({ short_hits: 30, day_hits: 100, short_wait: 900, day_wait: 80_000 })).toEqual({ admitted: false, retryAfterSeconds: 80_000 });
  });

  it("an ELAPSED window (NULL wait) is never exhausted, whatever its counter says", () => {
    expect(classify({ short_hits: 30, day_hits: 100, short_wait: null, day_wait: 700 })).toEqual({ admitted: false, retryAfterSeconds: 700 });
    expect(classify({ short_hits: 30, day_hits: 100, short_wait: 700, day_wait: null })).toEqual({ admitted: false, retryAfterSeconds: 700 });
  });

  it("a counter ABOVE a lowered limit is exhausted, not corrupt", () => {
    expect(classify({ short_hits: 45, day_hits: 3, short_wait: 400, day_wait: 800 })).toEqual({ admitted: false, retryAfterSeconds: 400 });
  });

  it("a window with room is not exhausted: a counter one below the limit does not count", () => {
    expect(classify({ short_hits: 29, day_hits: 99, short_wait: 400, day_wait: 800 })).toEqual({ admitted: false, retryAfterSeconds: 1 });
  });

  it("neither exhausted (capacity moved between E1 and E2): advised at 1 second, still a refusal", () => {
    expect(classify({ short_hits: 1, day_hits: 1, short_wait: 3000, day_wait: 80_000 })).toEqual({ admitted: false, retryAfterSeconds: 1 });
  });

  it("the minimum is 1 and a wait of 1 stays 1", () => {
    expect(classify({ short_hits: 30, day_hits: 1, short_wait: 1, day_wait: 5 })).toEqual({ admitted: false, retryAfterSeconds: 1 });
  });

  it("the maximum is the window: a full window passes; a wait inside the 60 s tolerance is CLAMPED to the window; beyond it throws", () => {
    expect(classify({ short_hits: 30, day_hits: 1, short_wait: 3600, day_wait: 5 }).retryAfterSeconds).toBe(3600);
    expect(classify({ short_hits: 30, day_hits: 1, short_wait: 3660, day_wait: 5 }).retryAfterSeconds).toBe(3600);
    expect(classify({ short_hits: 1, day_hits: 100, short_wait: 5, day_wait: 86_460 }).retryAfterSeconds).toBe(86_400);
    expect(() => classify({ short_hits: 30, day_hits: 1, short_wait: 3661, day_wait: 5 })).toThrow(RegistrationAdmissionError);
    expect(() => classify({ short_hits: 1, day_hits: 100, short_wait: 5, day_wait: 86_461 })).toThrow(RegistrationAdmissionError);
  });

  it("is validated even for a window that is not exhausted (a corrupt wait is not ignored)", () => {
    expect(() => classify({ short_hits: 1, day_hits: 1, short_wait: 99_999, day_wait: 5 })).toThrow(RegistrationAdmissionError);
  });

  it("a different policy's window length is what bounds the wait", () => {
    expect(classify({ short_hits: 2, day_hits: 1, short_wait: 70, day_wait: 5 }, SMALL).retryAfterSeconds).toBe(10);
  });

  it("the in-memory model rounds fractional seconds UP and never advises less than 1", async () => {
    const c = clock(0);
    const store = createInMemoryRegistrationAdmissionStore(c.now);
    await store.admit(SMALL);
    await store.admit(SMALL);
    c.set(8_500); // 1.5 s left
    expect(await store.admit(SMALL)).toEqual({ admitted: false, retryAfterSeconds: 2 });
    c.set(9_999); // 1 ms left
    expect(await store.admit(SMALL)).toEqual({ admitted: false, retryAfterSeconds: 1 });
    c.set(9_000); // exactly 1 s left
    expect(await store.admit(SMALL)).toEqual({ admitted: false, retryAfterSeconds: 1 });
  });

  it("interpretAdmittedRows is exported for the model and refuses zero rows", () => {
    expect(() => interpretAdmittedRows(P, [])).toThrow(RegistrationAdmissionError);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Exact-SQL regression (Milestone 3C-1 hardening). The earlier tests pin parts of E1 and E2; these pin ALL of both.
//
// The expected statements below are written HERE, by hand, from the independently audited design (the reference SQL with
// numbered parameters $1..$4) — they are NEVER built from, copied from, or transformed out of the captured text. The only
// transformation is on the REFERENCE: each numbered parameter becomes the bare `$` that this file's fake `sql` tag joins
// the template strings with, and the order in which they occur gives the expected value order.
//
// Nothing here executes SQL. The production SQL is read, never changed.
// ---------------------------------------------------------------------------------------------------------------------

/** Whitespace-normalized text: every run of whitespace is one space, ends trimmed. Nothing else is forgiven. */
const normalizeSql = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The audited reference E1, with numbered parameters. $1 short window s, $2 short limit, $3 day window s, $4 day limit. */
const REFERENCE_E1 = `
UPDATE real_registration_admission AS a
SET
  short_window_start = CASE WHEN a.short_window_start + make_interval(secs => $1::int) <= now() THEN now() ELSE a.short_window_start END,
  short_hits = CASE WHEN a.short_window_start + make_interval(secs => $1::int) <= now() THEN 1 ELSE a.short_hits + 1 END,
  day_window_start = CASE WHEN a.day_window_start + make_interval(secs => $3::int) <= now() THEN now() ELSE a.day_window_start END,
  day_hits = CASE WHEN a.day_window_start + make_interval(secs => $3::int) <= now() THEN 1 ELSE a.day_hits + 1 END
WHERE a.scope = 'register_options'
  AND (a.short_window_start + make_interval(secs => $1::int) <= now() OR a.short_hits < $2::int)
  AND (a.day_window_start + make_interval(secs => $3::int) <= now() OR a.day_hits < $4::int)
RETURNING a.short_hits, a.day_hits`;

/** The audited reference E2, with numbered parameters. $1 short window s, $2 day window s. */
const REFERENCE_E2 = `
SELECT
  a.short_hits,
  a.day_hits,
  CASE WHEN a.short_window_start + make_interval(secs => $1::int) <= now() THEN NULL
    ELSE LEAST(GREATEST(ceil(extract(epoch FROM (a.short_window_start + make_interval(secs => $1::int) - now()))), 1), 1000000)::int END AS short_wait,
  CASE WHEN a.day_window_start + make_interval(secs => $2::int) <= now() THEN NULL
    ELSE LEAST(GREATEST(ceil(extract(epoch FROM (a.day_window_start + make_interval(secs => $2::int) - now()))), 1), 1000000)::int END AS day_wait
FROM real_registration_admission a
WHERE a.scope = 'register_options'`;

/**
 * Turns a numbered-parameter reference into what a tagged template yields: the SQL with every `$n` replaced by the bare
 * `$` the fake joins with, and the parameter numbers in the order they occur (so the expected value order is derived from
 * the reference, not from the captured values).
 */
function asTemplate(reference: string): { text: string; order: number[] } {
  const order: number[] = [];
  const text = normalizeSql(reference).replace(/\$([0-9]+)/g, (_match, n: string) => {
    order.push(Number(n));
    return "$";
  });
  return { text, order };
}

/** The assertion every statement must pass: the whole normalized text equals the reference's — not a pattern, not a fragment. */
const matchesReference = (actual: string, reference: string): boolean => normalizeSql(actual) === asTemplate(reference).text;

/** The statements and values the production adapter really sends for a refusal (E1 empty, then E2) under `policy`. */
async function capture(policy: RegistrationAdmissionPolicy = P) {
  // E2's canned answer is valid for ANY policy (a one-second wait is inside every window), so the capture never throws.
  const { sql, calls } = scriptedSql([[], [{ short_hits: policy.short.limit, day_hits: 1, short_wait: 1, day_wait: 1 }]]);
  await createNeonRegistrationAdmissionStore(sql).admit(policy);
  return { e1: calls[0]!, e2: calls[1]!, count: calls.length };
}

describe("the complete E1 statement is pinned", () => {
  it("equals the audited reference E1, whitespace-normalized, in full", async () => {
    const { e1 } = await capture();
    const expected = asTemplate(REFERENCE_E1);
    expect(e1.text).toBe(expected.text);
    expect(matchesReference(e1.text, REFERENCE_E1)).toBe(true);
  });

  it("the expected text is independent of the production text: it is a literal in this file, and hand-checked against the design's own shape", () => {
    // A second, shape-level check written separately from the reference above, so one mistake cannot hide in both.
    const e1 = asTemplate(REFERENCE_E1).text;
    expect(e1.startsWith("UPDATE real_registration_admission AS a SET short_window_start = CASE WHEN a.short_window_start + make_interval(secs => $::int) <= now() THEN now() ELSE a.short_window_start END, short_hits = CASE WHEN a.short_window_start + make_interval(secs => $::int) <= now() THEN 1 ELSE a.short_hits + 1 END, ")).toBe(true);
    expect(e1.endsWith("WHERE a.scope = 'register_options' AND (a.short_window_start + make_interval(secs => $::int) <= now() OR a.short_hits < $::int) AND (a.day_window_start + make_interval(secs => $::int) <= now() OR a.day_hits < $::int) RETURNING a.short_hits, a.day_hits")).toBe(true);
    expect(asTemplate(REFERENCE_E1).order).toEqual([1, 1, 3, 3, 1, 2, 3, 4]);
  });

  it("the values sent are the policy numbers in exactly the order the reference's parameters occur (different numbers everywhere, so a swap cannot hide)", async () => {
    const distinct: RegistrationAdmissionPolicy = { short: { limit: 11, windowSeconds: 7 }, day: { limit: 13, windowSeconds: 701 } };
    const { e1 } = await capture(distinct);
    const byNumber: Record<number, number> = { 1: 7, 2: 11, 3: 701, 4: 13 }; // $1 short window, $2 short limit, $3 day window, $4 day limit
    expect(e1.values).toEqual(asTemplate(REFERENCE_E1).order.map((n) => byNumber[n]!));
    expect(e1.text).toBe(asTemplate(REFERENCE_E1).text);
  });

  it("and under the production policy", async () => {
    const { e1 } = await capture(P);
    expect(e1.values).toEqual(asTemplate(REFERENCE_E1).order.map((n) => ({ 1: 3600, 2: 30, 3: 86_400, 4: 100 })[n]));
  });

  it("is exactly one statement: no trailing statement, no transaction, no lock, no second table", async () => {
    const { e1 } = await capture();
    expect(e1.text.split(";").filter((part) => part.trim() !== "")).toHaveLength(1);
    expect(e1.text).not.toMatch(/\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b|\bSAVEPOINT\b|FOR (NO KEY )?UPDATE|FOR SHARE|\bLOCK\b|\bWITH\b|\bSELECT\b|\bINSERT\b|\bDELETE\b|\bJOIN\b|\bFROM\b/i);
    expect(e1.text.match(/real_registration_admission/g)).toHaveLength(1);
  });
});

describe("the complete E2 statement is pinned", () => {
  it("equals the audited reference E2, whitespace-normalized, in full", async () => {
    const { e2 } = await capture();
    expect(e2.text).toBe(asTemplate(REFERENCE_E2).text);
    expect(matchesReference(e2.text, REFERENCE_E2)).toBe(true);
  });

  it("has the four columns in order, and elapsed windows are NULL — checked against a separately written shape", () => {
    const e2 = asTemplate(REFERENCE_E2).text;
    expect(e2.startsWith("SELECT a.short_hits, a.day_hits, CASE WHEN a.short_window_start + make_interval(secs => $::int) <= now() THEN NULL ELSE LEAST(GREATEST(ceil(extract(epoch FROM (a.short_window_start + make_interval(secs => $::int) - now()))), 1), 1000000)::int END AS short_wait, ")).toBe(true);
    expect(e2.endsWith("CASE WHEN a.day_window_start + make_interval(secs => $::int) <= now() THEN NULL ELSE LEAST(GREATEST(ceil(extract(epoch FROM (a.day_window_start + make_interval(secs => $::int) - now()))), 1), 1000000)::int END AS day_wait FROM real_registration_admission a WHERE a.scope = 'register_options'")).toBe(true);
    expect(asTemplate(REFERENCE_E2).order).toEqual([1, 1, 2, 2]);
  });

  it("the values are the two window lengths, each twice, in the order the reference's parameters occur", async () => {
    const distinct: RegistrationAdmissionPolicy = { short: { limit: 11, windowSeconds: 7 }, day: { limit: 13, windowSeconds: 701 } };
    const { e2 } = await capture(distinct);
    expect(e2.values).toEqual(asTemplate(REFERENCE_E2).order.map((n) => ({ 1: 7, 2: 701 })[n]));
  });

  it("is a single read-only SELECT: it cannot write, lock, or touch another table", async () => {
    const { e2 } = await capture();
    expect(e2.text.split(";").filter((part) => part.trim() !== "")).toHaveLength(1);
    expect(e2.text).not.toMatch(/\bUPDATE\b|\bINSERT\b|\bDELETE\b|\bBEGIN\b|\bCOMMIT\b|FOR (NO KEY )?UPDATE|FOR SHARE|\bLOCK\b|\bWITH\b|\bJOIN\b|\bRETURNING\b/i);
    expect(e2.text.match(/real_registration_admission/g)).toHaveLength(1);
  });

  it("the whole refusal path is exactly two statements, and an admission exactly one", async () => {
    expect((await capture()).count).toBe(2);
    const admitted = scriptedSql([ADMITTED]);
    await createNeonRegistrationAdmissionStore(admitted.sql).admit(P);
    expect(admitted.calls).toHaveLength(1);
    expect(admitted.calls[0]!.text).toBe(asTemplate(REFERENCE_E1).text);
  });
});

describe("mutation sensitivity: the exact assertions reject representative bad SQL (strings in memory only; the production SQL is never touched)", () => {
  type Mutation = { name: string; statement: "E1" | "E2"; apply: (text: string) => string };
  /** Replaces the Nth occurrence (0-based) of `needle`; throws if it is not there, so a mutation can never silently do nothing. */
  const nth = (needle: string, replacement: string, n = 0) => (text: string): string => {
    let at = -1;
    for (let i = 0; i <= n; i += 1) {
      at = text.indexOf(needle, at + 1);
      if (at < 0) throw new Error(`mutation needle not found: ${needle}`);
    }
    return text.slice(0, at) + replacement + text.slice(at + needle.length);
  };

  const MUTATIONS: Mutation[] = [
    // The named representative bugs.
    { name: "short_hits increments by 2 (a.short_hits + 2)", statement: "E1", apply: nth("a.short_hits + 1", "a.short_hits + 2") },
    { name: "day_hits increments by 2 (a.day_hits + 2)", statement: "E1", apply: nth("a.day_hits + 1", "a.day_hits + 2") },
    { name: "short-window reset sets hits to 0 (THEN 0)", statement: "E1", apply: nth("THEN 1 ELSE a.short_hits + 1", "THEN 0 ELSE a.short_hits + 1") },
    { name: "daily-window reset sets hits to 0 (THEN 0)", statement: "E1", apply: nth("THEN 1 ELSE a.day_hits + 1", "THEN 0 ELSE a.day_hits + 1") },
    { name: "short-window reset keeps the old start (THEN a.short_window_start ELSE now())", statement: "E1", apply: nth("THEN now() ELSE a.short_window_start", "THEN a.short_window_start ELSE now()") },
    { name: "daily-window reset keeps the old start (THEN a.day_window_start ELSE now())", statement: "E1", apply: nth("THEN now() ELSE a.day_window_start", "THEN a.day_window_start ELSE now()") },
    { name: "short_hits CASE tests the DAILY window (swapped predicate)", statement: "E1", apply: nth("short_hits = CASE WHEN a.short_window_start", "short_hits = CASE WHEN a.day_window_start") },
    { name: "day_hits CASE tests the SHORT window (swapped predicate)", statement: "E1", apply: nth("day_hits = CASE WHEN a.day_window_start", "day_hits = CASE WHEN a.short_window_start") },
    { name: "WHERE tests the short limit against the DAILY window length (swapped parameters)", statement: "E1", apply: nth("a.short_window_start + make_interval(secs => $::int) <= now() OR a.short_hits", "a.day_window_start + make_interval(secs => $::int) <= now() OR a.short_hits") },
    { name: "short exhaustion uses <= (admits one too many)", statement: "E1", apply: nth("a.short_hits < $::int", "a.short_hits <= $::int") },
    { name: "daily exhaustion uses <= (admits one too many)", statement: "E1", apply: nth("a.day_hits < $::int", "a.day_hits <= $::int") },
    { name: "short exhaustion compares against the wrong column (day_hits)", statement: "E1", apply: nth("OR a.short_hits < $::int", "OR a.day_hits < $::int") },
    { name: "the two admission conditions are OR-ed (one window can admit alone)", statement: "E1", apply: nth("a.short_hits < $::int) AND (a.day_window_start", "a.short_hits < $::int) OR (a.day_window_start") },
    { name: "E2 day_wait counts down to the wrong instant (+ becomes -)", statement: "E2", apply: nth("a.day_window_start + make_interval(secs => $::int) - now()", "a.day_window_start - make_interval(secs => $::int) - now()", 0) },
    { name: "E2 short_wait counts down to the wrong instant (+ becomes -)", statement: "E2", apply: nth("a.short_window_start + make_interval(secs => $::int) - now()", "a.short_window_start - make_interval(secs => $::int) - now()", 0) },
    { name: "E2 day_wait rounds down (floor instead of ceil)", statement: "E2", apply: nth("ceil(extract(epoch FROM (a.day_window_start", "floor(extract(epoch FROM (a.day_window_start") },
    { name: "E2 short_wait rounds down (floor instead of ceil)", statement: "E2", apply: nth("ceil(extract(epoch FROM (a.short_window_start", "floor(extract(epoch FROM (a.short_window_start") },
    { name: "E2 day_wait has no minimum of 1 (GREATEST(..., 0))", statement: "E2", apply: nth("1), 1000000)::int END AS day_wait", "0), 1000000)::int END AS day_wait") },
    { name: "E2 short_wait has no sentinel cap", statement: "E2", apply: nth("1), 1000000)::int END AS short_wait", "1), 2147483647)::int END AS short_wait") },
    { name: "E2 elapsed predicate is strict (< instead of <=) for the short window", statement: "E2", apply: nth("a.short_window_start + make_interval(secs => $::int) <= now() THEN NULL", "a.short_window_start + make_interval(secs => $::int) < now() THEN NULL") },
    { name: "E2 elapsed predicate is strict (< instead of <=) for the daily window", statement: "E2", apply: nth("a.day_window_start + make_interval(secs => $::int) <= now() THEN NULL", "a.day_window_start + make_interval(secs => $::int) < now() THEN NULL") },
    { name: "E2 reports the daily window's wait under the short column (columns swapped)", statement: "E2", apply: nth("END AS short_wait", "END AS day_wait_swapped") },
    { name: "E2 swaps the two counters", statement: "E2", apply: nth("SELECT a.short_hits, a.day_hits,", "SELECT a.day_hits, a.short_hits,") },
    // Structure and scope.
    { name: "E1 elapsed predicate is strict (< instead of <=) in the SET clause", statement: "E1", apply: nth("a.short_window_start + make_interval(secs => $::int) <= now() THEN now()", "a.short_window_start + make_interval(secs => $::int) < now() THEN now()") },
    { name: "E1 uses the server wall clock instead of now()", statement: "E1", apply: nth("THEN now() ELSE a.day_window_start", "THEN clock_timestamp() ELSE a.day_window_start") },
    { name: "E1 drops the daily admission condition entirely", statement: "E1", apply: (text) => text.replace(" AND (a.day_window_start + make_interval(secs => $::int) <= now() OR a.day_hits < $::int)", "") },
    { name: "E1 targets another scope", statement: "E1", apply: nth("a.scope = 'register_options'", "a.scope = 'login_options'") },
    { name: "E1 returns the wrong columns", statement: "E1", apply: nth("RETURNING a.short_hits, a.day_hits", "RETURNING a.day_hits, a.short_hits") },
    { name: "E1 takes a row lock (FOR UPDATE appended)", statement: "E1", apply: (text) => `${text} FOR UPDATE` },
    { name: "E1 is wrapped in a transaction", statement: "E1", apply: (text) => `BEGIN; ${text}; COMMIT` },
    { name: "E1 gains a second statement (a refund)", statement: "E1", apply: (text) => `${text}; UPDATE real_registration_admission SET short_hits = short_hits - 1` },
    { name: "E2 gains a write (it must stay read-only)", statement: "E2", apply: (text) => `${text}; DELETE FROM real_registration_admission` },
    { name: "E2 reads a different scope", statement: "E2", apply: nth("a.scope = 'register_options'", "a.scope = 'login_options'") },
    { name: "E2 locks the row", statement: "E2", apply: (text) => `${text} FOR UPDATE` },
  ];

  it("every mutation really changes the statement (a mutation that changed nothing would prove nothing)", async () => {
    const { e1, e2 } = await capture();
    for (const mutation of MUTATIONS) {
      const original = mutation.statement === "E1" ? e1.text : e2.text;
      expect(mutation.apply(original), mutation.name).not.toBe(original);
    }
  });

  it("the exact assertion REJECTS every mutation, and still ACCEPTS the unmutated statements", async () => {
    const { e1, e2 } = await capture();
    expect(matchesReference(e1.text, REFERENCE_E1)).toBe(true);
    expect(matchesReference(e2.text, REFERENCE_E2)).toBe(true);
    const detected: string[] = [];
    const missed: string[] = [];
    for (const mutation of MUTATIONS) {
      const original = mutation.statement === "E1" ? e1.text : e2.text;
      const reference = mutation.statement === "E1" ? REFERENCE_E1 : REFERENCE_E2;
      (matchesReference(mutation.apply(original), reference) ? missed : detected).push(mutation.name);
    }
    expect(missed).toEqual([]);
    expect(detected).toHaveLength(MUTATIONS.length);
    expect(MUTATIONS.length).toBeGreaterThanOrEqual(8);
  });

  it("the eight mutations the audit named are all among those detected", () => {
    const required = [
      "short_hits increments by 2",
      "day_hits increments by 2",
      "short-window reset sets hits to 0",
      "daily-window reset sets hits to 0",
      "short-window reset keeps the old start",
      "short_hits CASE tests the DAILY window",
      "short exhaustion uses <=",
      "E2 day_wait counts down to the wrong instant",
      "E2 short_wait counts down to the wrong instant",
    ];
    for (const prefix of required) expect(MUTATIONS.some((mutation) => mutation.name.startsWith(prefix)), prefix).toBe(true);
  });

  it("whitespace is the ONLY thing the comparison forgives: a reformatted statement still matches, a one-character change does not", async () => {
    const { e1 } = await capture();
    expect(matchesReference(e1.text.replace(/ /g, "\n   "), REFERENCE_E1)).toBe(true);
    expect(matchesReference(`\n  ${e1.text}  \n`, REFERENCE_E1)).toBe(true); // leading and trailing whitespace
    expect(matchesReference(e1.text.replace("$::int", "$ ::int"), REFERENCE_E1)).toBe(false); // a space INSIDE a token is not forgiven
    expect(matchesReference(e1.text.replace("<= now() THEN 1", "<= now() THEN 2"), REFERENCE_E1)).toBe(false);
    expect(matchesReference(e1.text.replace("a.scope", "b.scope"), REFERENCE_E1)).toBe(false);
  });
});
