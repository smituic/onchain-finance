import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createNeonProviderBudgetStore, createNeonRateLimitStore } from "@/lib/real/server/neon-store";
import * as limiterModule from "@/lib/real/server/rate-limit";
import {
  HANDLE_PREPARE_POLICIES,
  PROVIDER_BUDGET_BUCKETS,
  PROVIDER_BUDGET_FAMILIES,
  RATE_LIMIT_BUCKETS,
  RATE_LIMIT_POLICIES,
  createInMemoryProviderBudgetStore,
  createInMemoryRateLimitStore,
  createProviderBudgetLimiter,
  createRateLimiter,
  normalizeProviderBudgetPolicies,
  normalizeRateLimitPolicies,
  type ProviderBudgetBucket,
  type ProviderBudgetFamily,
  type ProviderBudgetLimiter,
  type ProviderBudgetPolicy,
  type ProviderBudgetStore,
} from "@/lib/real/server/rate-limit";

/**
 * Milestone 3, Slice 3A-0 — the provider-budget FOUNDATION: the six-bucket
 * allow-list, the limiter over the in-memory store (fake clock), the Neon
 * statement's shape (a recording fake — no database), and static assertions
 * over schema.sql.
 *
 * OFFLINE ONLY. Nothing here connects to a database or a provider, and nothing
 * here proves how PostgreSQL executes the statement or the migration block —
 * real concurrency, the CHECK, and the block's first apply / rerun / refusals
 * need their own disposable-branch smoke, which does not exist yet.
 *
 * Every limit and window below is a TEST value. No provider budget has an
 * approved number, and the module under test exports none.
 */
const SHORT = 600;
const DAY = 86_400;
const P = (bucket: ProviderBudgetBucket, limit: number, windowSeconds: number): ProviderBudgetPolicy => ({ bucket, limit, windowSeconds });
const family = (name: ProviderBudgetFamily, shortLimit: number, dayLimit: number): ProviderBudgetPolicy[] => [
  P(`${name}_short`, shortLimit, SHORT),
  P(`${name}_day`, dayLimit, DAY),
];

function clocked(startMs = 1_000_000_000_000) {
  let now = startMs;
  const store = createInMemoryProviderBudgetStore(() => now);
  return { store, limiter: createProviderBudgetLimiter(store), advance: (seconds: number) => void (now += seconds * 1000) };
}

async function allowedRun(limiter: ProviderBudgetLimiter, subject: string, policies: readonly ProviderBudgetPolicy[], times: number) {
  const out: boolean[] = [];
  for (let i = 0; i < times; i++) out.push((await limiter.consume({ subject, policies })).allowed);
  return out;
}

function recordingSql(result: unknown[] | Error) {
  const calls: { text: string; values: unknown[] }[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("$").replace(/\s+/g, " ").trim(), values });
    if (result instanceof Error) throw result;
    return result;
  }) as never;
  return { sql, calls };
}

const limiterSource = readFileSync("lib/real/server/rate-limit.ts", "utf8");
const stripComments = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

describe("A. the six-bucket allow-list", () => {
  it("is exactly three families, each with a short and a daily bucket, in byte order", () => {
    expect([...PROVIDER_BUDGET_FAMILIES]).toEqual(["chain_read", "pay_submit", "turnkey_reconcile"]);
    expect([...PROVIDER_BUDGET_BUCKETS]).toEqual(["chain_read_day", "chain_read_short", "pay_submit_day", "pay_submit_short", "turnkey_reconcile_day", "turnkey_reconcile_short"]);
    expect(PROVIDER_BUDGET_FAMILIES.flatMap((name) => [`${name}_day`, `${name}_short`])).toEqual([...PROVIDER_BUDGET_BUCKETS]);
    expect([...PROVIDER_BUDGET_BUCKETS].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual([...PROVIDER_BUDGET_BUCKETS]);
  });

  it("shares no name with the Slice E buckets", () => {
    expect(PROVIDER_BUDGET_BUCKETS.filter((bucket) => (RATE_LIMIT_BUCKETS as readonly string[]).includes(bucket))).toEqual([]);
  });

  it("NO numeric limit exists: the module exports no provider policy, and the provider half of the file contains no number at all", () => {
    expect(Object.keys(limiterModule).filter((name) => /provider/i.test(name)).sort()).toEqual([
      "PROVIDER_BUDGET_BUCKETS",
      "PROVIDER_BUDGET_FAMILIES",
      "createInMemoryProviderBudgetStore",
      "createProviderBudgetLimiter",
      "normalizeProviderBudgetPolicies",
    ]);
    const providerHalf = stripComments(limiterSource.slice(limiterSource.indexOf("export const PROVIDER_BUDGET_FAMILIES")));
    expect(providerHalf.length).toBeGreaterThan(1000);
    expect(providerHalf).not.toMatch(/\d/);
  });
});

describe("B. unknown buckets are refused, in both directions", () => {
  const spyStore = () => {
    const calls: unknown[] = [];
    const store: ProviderBudgetStore = { consume: async (input) => (calls.push(input), []) };
    return { store, calls };
  };

  it("the provider limiter refuses anything but its six names — including every Slice E bucket — before the store is touched", async () => {
    const bad: unknown[] = [
      [...HANDLE_PREPARE_POLICIES],
      [RATE_LIMIT_POLICIES.pay_prepare_short, RATE_LIMIT_POLICIES.pay_prepare_day],
      [...family("chain_read", 5, 50), RATE_LIMIT_POLICIES.recipient_probe_day],
      [{ bucket: "chain_read", limit: 1, windowSeconds: 1 }],
      [{ bucket: "CHAIN_READ_SHORT", limit: 1, windowSeconds: 1 }],
      [{ bucket: "chain_read_short ", limit: 1, windowSeconds: 1 }],
      [{ bucket: "pay_submit_hour", limit: 1, windowSeconds: 1 }],
      [{ bucket: "", limit: 1, windowSeconds: 1 }],
      [{ bucket: 7, limit: 1, windowSeconds: 1 }],
      [{ limit: 1, windowSeconds: 1 }],
      [null],
    ];
    for (const policies of bad) {
      const { store, calls } = spyStore();
      expect(() => normalizeProviderBudgetPolicies(policies as never), JSON.stringify(policies)).toThrow(/Provider budget refused: unknown bucket\./);
      await expect(createProviderBudgetLimiter(store).consume({ subject: "u", policies: policies as never })).rejects.toThrow(/Provider budget refused/);
      expect(calls).toEqual([]);
    }
  });

  it("the Slice E limiter refuses every provider bucket, so none can reach real_rate_limits", async () => {
    const seen: unknown[] = [];
    const inner = createInMemoryRateLimitStore(() => 0);
    const limiter = createRateLimiter({ consume: (input) => (seen.push(input), inner.consume(input)) });
    for (const bucket of PROVIDER_BUDGET_BUCKETS) {
      expect(() => normalizeRateLimitPolicies([{ bucket, limit: 1, windowSeconds: 1 }] as never), bucket).toThrow(/Rate limit refused: unknown bucket\./);
      await expect(limiter.consume({ subject: "u", policies: [{ bucket, limit: 1, windowSeconds: 1 }] as never })).rejects.toThrow(/Rate limit refused/);
    }
    expect(seen).toEqual([]);
  });

  it("the in-memory provider store plays the table's CHECK: a foreign bucket throws and charges nothing", async () => {
    const { store } = clocked();
    await expect(store.consume({ subject: "u", policies: [...family("chain_read", 5, 50), RATE_LIMIT_POLICIES.pay_prepare_day] as never })).rejects.toThrow(/outside this store's list/);
    // Nothing was charged by the refused call: the next request is the first of its window.
    expect(await store.consume({ subject: "u", policies: normalizeProviderBudgetPolicies(family("chain_read", 5, 50)) })).toEqual([
      { bucket: "chain_read_day", hits: 1, secondsUntilReset: DAY },
      { bucket: "chain_read_short", hits: 1, secondsUntilReset: SHORT },
    ]);
  });

  it("no policies, a duplicate, or a non-positive / fractional limit or window is refused", () => {
    const bad: unknown[] = [
      [],
      undefined,
      [...family("pay_submit", 5, 50), P("pay_submit_short", 5, SHORT)],
      [P("pay_submit_short", 0, SHORT), P("pay_submit_day", 5, DAY)],
      [P("pay_submit_short", -1, SHORT), P("pay_submit_day", 5, DAY)],
      [P("pay_submit_short", 1.5, SHORT), P("pay_submit_day", 5, DAY)],
      [P("pay_submit_short", 1, 0), P("pay_submit_day", 5, DAY)],
      [P("pay_submit_short", 1, 0.5), P("pay_submit_day", 5, DAY)],
      [P("pay_submit_short", Number.NaN, SHORT), P("pay_submit_day", 5, DAY)],
      [P("pay_submit_short", Number.POSITIVE_INFINITY, SHORT), P("pay_submit_day", 5, DAY)],
    ];
    for (const policies of bad) expect(() => normalizeProviderBudgetPolicies(policies as never), JSON.stringify(policies)).toThrow(/Provider budget refused/);
  });

  it("refuses a request with no subject", async () => {
    const { limiter } = clocked();
    for (const subject of ["", undefined, null, 7]) await expect(limiter.consume({ subject: subject as never, policies: family("chain_read", 5, 50) })).rejects.toThrow(/Provider budget refused: no subject\./);
  });
});

describe("C. atomic multi-bucket admission", () => {
  it("every bucket of a request is charged in ONE store operation, in byte order, whatever order the caller used", async () => {
    const seen: string[][] = [];
    const inner = createInMemoryProviderBudgetStore(() => 0);
    const limiter = createProviderBudgetLimiter({ consume: (input) => (seen.push(input.policies.map((policy) => policy.bucket)), inner.consume(input)) });
    const four = [...family("pay_submit", 5, 50), ...family("chain_read", 5, 50)];
    await limiter.consume({ subject: "u", policies: four });
    await limiter.consume({ subject: "u", policies: [...four].reverse() });
    await limiter.consume({ subject: "u", policies: family("chain_read", 5, 50).reverse() });
    expect(seen).toEqual([
      ["chain_read_day", "chain_read_short", "pay_submit_day", "pay_submit_short"],
      ["chain_read_day", "chain_read_short", "pay_submit_day", "pay_submit_short"],
      ["chain_read_day", "chain_read_short"],
    ]);
    expect(normalizeProviderBudgetPolicies(four)).not.toBe(four); // never sorts a caller's array in place
  });

  it("a family is always charged on BOTH windows: a lone short or a lone daily bucket is refused", () => {
    for (const name of PROVIDER_BUDGET_FAMILIES) {
      expect(() => normalizeProviderBudgetPolicies([P(`${name}_short`, 5, SHORT)]), name).toThrow(/both its short and its daily bucket/);
      expect(() => normalizeProviderBudgetPolicies([P(`${name}_day`, 5, DAY)]), name).toThrow(/both its short and its daily bucket/);
      expect(normalizeProviderBudgetPolicies(family(name, 5, 50)).map((policy) => policy.bucket)).toEqual([`${name}_day`, `${name}_short`]);
    }
    expect(() => normalizeProviderBudgetPolicies([...family("chain_read", 5, 50), P("pay_submit_short", 5, SHORT)])).toThrow(/both its short and its daily bucket/);
  });

  it("admitted only when EVERY bucket is within its limit; a denied request has still been charged to all of them", async () => {
    const { store, limiter } = clocked();
    const policies = family("turnkey_reconcile", 2, 10);
    expect(await allowedRun(limiter, "u", policies, 3)).toEqual([true, true, false]);
    expect(await store.consume({ subject: "u", policies: normalizeProviderBudgetPolicies(policies) })).toEqual([
      { bucket: "turnkey_reconcile_day", hits: 4, secondsUntilReset: DAY },
      { bucket: "turnkey_reconcile_short", hits: 3, secondsUntilReset: SHORT },
    ]);
  });

  it("the Neon adapter makes exactly ONE database call per request, for two, four, or six buckets", async () => {
    const rows = PROVIDER_BUDGET_BUCKETS.map((bucket) => ({ bucket, hits: 1, seconds_until_reset: 60 }));
    for (const policies of [family("chain_read", 5, 50), [...family("chain_read", 5, 50), ...family("pay_submit", 5, 50)], PROVIDER_BUDGET_FAMILIES.flatMap((name) => family(name, 5, 50))]) {
      const { sql, calls } = recordingSql(rows);
      await createNeonProviderBudgetStore(sql).consume({ subject: "app-user-1", policies: normalizeProviderBudgetPolicies(policies) });
      expect(calls, String(policies.length)).toHaveLength(1);
    }
  });
});

describe("D. concurrent requests and counter limits (in-memory store)", () => {
  it("of many simultaneous requests for one account, exactly the limit are admitted", async () => {
    const { store, limiter } = clocked();
    const policies = family("pay_submit", 20, 100);
    const decisions = await Promise.all(Array.from({ length: 75 }, () => limiter.consume({ subject: "u", policies })));
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(20);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(55);
    // The short count stopped at limit + 1; the daily one counted all 75 (it is under its own cap of 101).
    expect(await store.consume({ subject: "u", policies: normalizeProviderBudgetPolicies(policies) })).toEqual([
      { bucket: "pay_submit_day", hits: 76, secondsUntilReset: DAY },
      { bucket: "pay_submit_short", hits: 21, secondsUntilReset: SHORT },
    ]);
  });

  it("overlapping bucket sets racing each other never over-admit the shared family", async () => {
    const { limiter } = clocked();
    const read = family("chain_read", 10, 100);
    const readAndSubmit = [...family("chain_read", 10, 100), ...family("pay_submit", 1000, 1000)];
    const decisions = await Promise.all(Array.from({ length: 40 }, (_, i) => limiter.consume({ subject: "u", policies: i % 2 === 0 ? read : readAndSubmit })));
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(10);
  });

  it("the stored count is capped at limit + 1, and accounts and families are independent", async () => {
    const { store, limiter } = clocked();
    const policies = normalizeProviderBudgetPolicies(family("chain_read", 3, 5));
    const hits: number[][] = [];
    for (let i = 0; i < 9; i++) hits.push((await store.consume({ subject: "u", policies })).map((state) => state.hits));
    expect(hits).toEqual([[1, 1], [2, 2], [3, 3], [4, 4], [5, 4], [6, 4], [6, 4], [6, 4], [6, 4]]);
    expect(await allowedRun(limiter, "someone-else", family("chain_read", 3, 5), 4)).toEqual([true, true, true, false]);
    expect(await allowedRun(limiter, "u", family("turnkey_reconcile", 3, 5), 4)).toEqual([true, true, true, false]);
    expect(await allowedRun(limiter, "ux", family("chain_read", 3, 5), 1)).toEqual([true]); // a subject that merely contains another's text is its own key
  });
});

describe("E. short-window and daily-window decisions", () => {
  it("the short bucket denies with the short window's wait; the daily bucket alone is never the reason while it is within its limit", async () => {
    const { limiter, advance } = clocked();
    const policies = family("chain_read", 2, 100);
    expect(await allowedRun(limiter, "u", policies, 2)).toEqual([true, true]);
    advance(100);
    expect(await limiter.consume({ subject: "u", policies })).toEqual({ allowed: false, retryAfterSeconds: 500 });
  });

  it("once the daily budget is spent, a fresh short window does not help: denied with the daily window's wait", async () => {
    const { limiter, advance } = clocked();
    const policies = family("chain_read", 2, 3);
    expect(await allowedRun(limiter, "u", policies, 2)).toEqual([true, true]);
    advance(SHORT); // the short window has elapsed; the day has not
    expect(await limiter.consume({ subject: "u", policies })).toEqual({ allowed: true }); // short 1 of 2, day 3 of 3
    // Short 2 of 2 is within its limit; the day is now over its own, and only the day's wait is reported.
    expect(await limiter.consume({ subject: "u", policies })).toEqual({ allowed: false, retryAfterSeconds: DAY - SHORT });
  });

  it("when both are exceeded the wait is the LONGER one (both must recover)", async () => {
    const { limiter, advance } = clocked();
    const policies = family("pay_submit", 1, 1);
    expect(await limiter.consume({ subject: "u", policies })).toEqual({ allowed: true });
    advance(60);
    expect(await limiter.consume({ subject: "u", policies })).toEqual({ allowed: false, retryAfterSeconds: DAY - 60 });
    advance(SHORT); // short reset; day still spent
    expect(await limiter.consume({ subject: "u", policies })).toEqual({ allowed: false, retryAfterSeconds: DAY - 60 - SHORT });
  });
});

describe("F. window reset", () => {
  it("a window is anchored to its FIRST request and reopens at hits = 1 exactly when it has elapsed", async () => {
    const { store, advance } = clocked();
    const policies = normalizeProviderBudgetPolicies(family("turnkey_reconcile", 2, 50));
    expect(await store.consume({ subject: "u", policies })).toEqual([
      { bucket: "turnkey_reconcile_day", hits: 1, secondsUntilReset: DAY },
      { bucket: "turnkey_reconcile_short", hits: 1, secondsUntilReset: SHORT },
    ]);
    advance(SHORT - 1);
    expect(await store.consume({ subject: "u", policies })).toEqual([
      { bucket: "turnkey_reconcile_day", hits: 2, secondsUntilReset: DAY - SHORT + 1 },
      { bucket: "turnkey_reconcile_short", hits: 2, secondsUntilReset: 1 },
    ]);
    advance(1);
    // The short window reopens; the daily one keeps counting from its own first request.
    expect(await store.consume({ subject: "u", policies })).toEqual([
      { bucket: "turnkey_reconcile_day", hits: 3, secondsUntilReset: DAY - SHORT },
      { bucket: "turnkey_reconcile_short", hits: 1, secondsUntilReset: SHORT },
    ]);
  });

  it("a denied request does NOT extend the window: hammering while denied never delays the reset", async () => {
    const { limiter, advance } = clocked();
    const policies = family("pay_submit", 2, 1000);
    await allowedRun(limiter, "u", policies, 2);
    for (let i = 0; i < 50; i++) {
      advance(10);
      expect(await limiter.consume({ subject: "u", policies })).toEqual({ allowed: false, retryAfterSeconds: SHORT - (i + 1) * 10 });
    }
    advance(100); // 600 s after the FIRST request, despite 50 denied calls in between
    expect((await limiter.consume({ subject: "u", policies })).allowed).toBe(true);
  });
});

describe("G. database failure = fail closed", () => {
  const policies = family("chain_read", 5, 50);
  const good = [
    { bucket: "chain_read_day", hits: 1, secondsUntilReset: 10 },
    { bucket: "chain_read_short", hits: 1, secondsUntilReset: 10 },
  ];

  it("a store that throws makes consume() throw — it is never read as 'admitted'", async () => {
    const down: ProviderBudgetStore = { consume: async () => Promise.reject(new Error('relation "real_provider_budgets" does not exist')) };
    await expect(createProviderBudgetLimiter(down).consume({ subject: "u", policies })).rejects.toThrow(/does not exist/);
  });

  it("a store answer that is not exactly one usable state per charged bucket throws", async () => {
    expect(await createProviderBudgetLimiter({ consume: async () => good }).consume({ subject: "u", policies })).toEqual({ allowed: true });
    const bad: unknown[] = [
      [],
      [good[0]],
      [good[0], good[0]],
      [good[0], { ...good[1], bucket: "pay_submit_short" }],
      [...good, good[0]],
      [good[0], { ...good[1], hits: 0 }],
      [good[0], { ...good[1], hits: Number.NaN }],
      [good[0], { ...good[1], hits: "1" }],
      [good[0], { ...good[1], secondsUntilReset: Number.POSITIVE_INFINITY }],
      [good[0], { ...good[1], secondsUntilReset: undefined }],
      null,
    ];
    for (const states of bad) {
      await expect(createProviderBudgetLimiter({ consume: async () => states as never }).consume({ subject: "u", policies }), JSON.stringify(states)).rejects.toThrow(/Provider budget refused/);
    }
  });

  it("the Neon adapter propagates a missing table or any database error, and a short answer is refused", async () => {
    for (const error of [new Error('relation "real_provider_budgets" does not exist'), new Error('violates check constraint "real_provider_budgets_bucket_check"'), new Error("fetch failed")]) {
      const { sql, calls } = recordingSql(error);
      await expect(createProviderBudgetLimiter(createNeonProviderBudgetStore(sql)).consume({ subject: "app-user-1", policies })).rejects.toThrow(error.message);
      expect(calls).toHaveLength(1); // one attempt; never retried
    }
    const short = recordingSql([{ bucket: "chain_read_day", hits: 1, seconds_until_reset: 10 }]);
    await expect(createProviderBudgetLimiter(createNeonProviderBudgetStore(short.sql)).consume({ subject: "app-user-1", policies })).rejects.toThrow(/did not report every bucket/);
  });

  it("production never falls back to an in-memory provider budget", () => {
    const runtime = readFileSync("lib/real/server/runtime.ts", "utf8");
    const neonBranch = runtime.slice(runtime.indexOf("if (databaseUrl) {"), runtime.indexOf('if (process.env.NODE_ENV === "production")'));
    expect(neonBranch).toContain("providerBudgetLimiter = createProviderBudgetLimiter(durable.providerBudgets);");
    expect(neonBranch).not.toContain("createInMemoryProviderBudgetStore");
    const afterThrow = runtime.slice(runtime.indexOf("DATABASE_URL is required in production"));
    expect(afterThrow).toContain("providerBudgetLimiter = createProviderBudgetLimiter(createInMemoryProviderBudgetStore());"); // reachable only past the production throw
    expect(runtime.match(/createInMemoryProviderBudgetStore\(\)/g)).toHaveLength(1);
  });
});

describe("H. no counter refund", () => {
  it("the limiter and both stores expose consume() and nothing else", () => {
    const { store, limiter } = clocked();
    expect(Object.keys(limiter)).toEqual(["consume"]);
    expect(Object.keys(store)).toEqual(["consume"]);
    expect(Object.keys(createNeonProviderBudgetStore(recordingSql([]).sql))).toEqual(["consume"]);
  });

  it("inside a window a count only ever rises, whether the request was admitted or denied", async () => {
    const { store } = clocked();
    const policies = normalizeProviderBudgetPolicies(family("pay_submit", 3, 1000));
    let previous = [0, 0];
    for (let i = 0; i < 10; i++) {
      const hits = (await store.consume({ subject: "u", policies })).map((state) => state.hits);
      expect(hits[0]!).toBeGreaterThan(previous[0]!);
      expect(hits[1]!).toBeGreaterThanOrEqual(previous[1]!);
      previous = hits;
    }
  });

  it("the Neon statement has no way to lower a count short of a new window", async () => {
    const { sql, calls } = recordingSql([]);
    await createNeonProviderBudgetStore(sql).consume({ subject: "app-user-1", policies: normalizeProviderBudgetPolicies(family("pay_submit", 5, 50)) });
    const text = calls[0]!.text;
    expect(text.match(/hits = CASE WHEN .*? THEN 1 ELSE LEAST\(r\.hits \+ 1, .*?\) END/g)).toHaveLength(1);
    expect(text).not.toMatch(/r\.hits - |hits - 1|\bDELETE\b|\bTRUNCATE\b/i);
  });
});

describe("I. the Slice E limiter is intact, and the two tables never mix", () => {
  it("the four Slice E buckets and their limits are unchanged", () => {
    expect([...RATE_LIMIT_BUCKETS]).toEqual(["pay_prepare_day", "pay_prepare_short", "recipient_probe_day", "recipient_probe_short"]);
    expect(RATE_LIMIT_POLICIES).toEqual({
      recipient_probe_short: { bucket: "recipient_probe_short", limit: 20, windowSeconds: 600 },
      recipient_probe_day: { bucket: "recipient_probe_day", limit: 100, windowSeconds: 86_400 },
      pay_prepare_short: { bucket: "pay_prepare_short", limit: 20, windowSeconds: 600 },
      pay_prepare_day: { bucket: "pay_prepare_day", limit: 100, windowSeconds: 86_400 },
    });
  });

  it("each Neon statement names only its own table, and they are otherwise the SAME statement", async () => {
    const rate = recordingSql([]);
    await createNeonRateLimitStore(rate.sql).consume({ subject: "app-user-1", policies: normalizeRateLimitPolicies(HANDLE_PREPARE_POLICIES) });
    const budget = recordingSql([]);
    await createNeonProviderBudgetStore(budget.sql).consume({ subject: "app-user-1", policies: normalizeProviderBudgetPolicies(family("chain_read", 5, 50)) });
    const rateText = rate.calls[0]!.text;
    const budgetText = budget.calls[0]!.text;
    expect(rateText).toMatch(/^INSERT INTO real_rate_limits AS r /);
    expect(rateText).not.toContain("real_provider_budgets");
    expect(budgetText).toMatch(/^INSERT INTO real_provider_budgets AS r \(bucket, subject, window_start, hits\) SELECT p\.key, \$::text, now\(\), 1 FROM jsonb_each\(\$::jsonb\) AS p ORDER BY p\.key COLLATE "C" ON CONFLICT \(bucket, subject\) DO UPDATE SET /);
    expect(budgetText).not.toContain("real_rate_limits");
    expect(budgetText).toBe(rateText.replace("real_rate_limits", "real_provider_budgets"));
    // One statement, no transaction, no separate read, no lock statement, no server wall clock.
    expect(budgetText.split(";").filter((part) => part.trim() !== "")).toHaveLength(1);
    expect(budgetText).not.toMatch(/\bBEGIN\b|\bCOMMIT\b|FOR UPDATE|SELECT [^;]* FROM real_provider_budgets|clock_timestamp|statement_timestamp/i);
  });

  it("the ONLY values sent are the caller's own subject and the bucket budgets", async () => {
    const { sql, calls } = recordingSql([]);
    await createNeonProviderBudgetStore(sql).consume({ subject: "app-user-1", policies: normalizeProviderBudgetPolicies(family("turnkey_reconcile", 5, 50)) });
    const budgets = JSON.stringify({ turnkey_reconcile_day: { limit: 50, windowSeconds: DAY }, turnkey_reconcile_short: { limit: 5, windowSeconds: SHORT } });
    expect(new Set(calls[0]!.values)).toEqual(new Set(["app-user-1", budgets]));
    expect(calls[0]!.values.filter((value) => value === "app-user-1")).toHaveLength(1);
  });

  it("rows are mapped field by field (numbers coerced, extra columns dropped)", async () => {
    const { sql } = recordingSql([
      { bucket: "chain_read_day", hits: "3", seconds_until_reset: 86_000, subject: "app-user-1" },
      { bucket: "chain_read_short", hits: 6, seconds_until_reset: "42", window_start: "2026-01-01" },
    ]);
    const policies = normalizeProviderBudgetPolicies(family("chain_read", 5, 50));
    const store = createNeonProviderBudgetStore(sql);
    expect(await store.consume({ subject: "app-user-1", policies })).toEqual([
      { bucket: "chain_read_day", hits: 3, secondsUntilReset: 86_000 },
      { bucket: "chain_read_short", hits: 6, secondsUntilReset: 42 },
    ]);
    expect(await createProviderBudgetLimiter(store).consume({ subject: "app-user-1", policies })).toEqual({ allowed: false, retryAfterSeconds: 42 });
  });
});

describe("static boundaries — foundation only", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
    return out;
  };
  const sources = [...walk("lib"), ...walk("app"), ...walk("components"), ...walk("simulation")];
  const naming = (pattern: RegExp) =>
    sources
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .map((file) => file.split(path.sep).join("/"))
      .sort();

  it("NO route, server module, store, or component consults a provider budget yet", () => {
    expect(naming(/getProviderBudgetLimiter\b/)).toEqual(["lib/real/server/runtime.ts"]);
    expect(naming(/ProviderBudget/i)).toEqual(["lib/real/server/neon-store.ts", "lib/real/server/rate-limit.ts", "lib/real/server/runtime.ts"]);
    expect(naming(/real_provider_budgets/)).toEqual(["lib/real/server/neon-store.ts", "lib/real/server/rate-limit.ts"]);
    // No bucket or family name appears outside the limiter module (so none is charged, and none can be sent to a browser).
    expect(naming(/chain_read|turnkey_reconcile|pay_submit/)).toEqual(["lib/real/server/rate-limit.ts"]);
  });

  it("the limiter module still imports nothing", () => {
    expect(limiterSource).not.toMatch(/^import /m);
  });
});

describe("schema.sql (static — no PostgreSQL has run any of this here)", () => {
  const schema = readFileSync("lib/real/server/schema.sql", "utf8");
  const section = (begin: string, end: string) => schema.slice(schema.indexOf(begin), schema.indexOf(end));
  const statementOf = (raw: string) => raw.slice(raw.indexOf("DO $$"), raw.lastIndexOf("END $$;") + "END $$;".length);
  const codeOf = (raw: string) =>
    raw
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");

  const SLICE_E_BEGIN = "-- BEGIN Handle Pay Rate Limits";
  const SLICE_E_END = "-- END Handle Pay Rate Limits";
  const BEGIN = "-- BEGIN Provider Budgets";
  const END = "-- END Provider Budgets";
  const sliceEStatement = statementOf(section(SLICE_E_BEGIN, SLICE_E_END));
  const raw = section(BEGIN, END);
  const statement = statementOf(raw);
  const code = codeOf(raw);
  const flat = code.replace(/\s+/g, " ");
  const definition = flat.slice(flat.indexOf("$definition$") + 12, flat.lastIndexOf("$definition$")).trim();

  it("J. the Slice E statement is byte-for-byte what was executed on the real database", () => {
    expect(schema.split(SLICE_E_BEGIN)).toHaveLength(2);
    expect(schema.split(SLICE_E_END)).toHaveLength(2);
    expect(sliceEStatement).toHaveLength(11680);
    expect(createHash("sha256").update(sliceEStatement).digest("hex")).toBe("78c5557d5b615805f0eb8c63e62d09eccffc792c95f9e2782f9af48d92d1513d");
    expect(sliceEStatement).toContain("CHECK (bucket IN ('recipient_probe_short', 'recipient_probe_day', 'pay_prepare_short', 'pay_prepare_day'))");
    expect(sliceEStatement).not.toMatch(/provider_budget|chain_read|turnkey_reconcile|pay_submit/);
  });

  it("is ONE new block, directly after the Slice E block and before the provisioning-evidence block (which stays last)", () => {
    expect(schema.split(BEGIN)).toHaveLength(2);
    expect(schema.split(END)).toHaveLength(2);
    expect(schema).toContain(`${SLICE_E_END}\n\n${BEGIN}\n`);
    expect(schema).toContain(`${END}\n\n-- BEGIN Provisioning Evidence Capture\n`);
    expect(schema.trimEnd().endsWith("-- END Provisioning Evidence Capture")).toBe(true);
    expect(code.trim().startsWith("DO $$")).toBe(true);
    expect(code.trim().endsWith("END $$;")).toBe(true);
    expect(codeOf(statement).trim()).toBe(code.trim()); // nothing executable in the block sits outside the one statement
    expect(raw.match(/DO \$\$/g)).toHaveLength(1);
    expect(raw.match(/'public'/g)).toHaveLength(1);
    expect(flat).toContain("target_schema CONSTANT pg_catalog.text := 'public';");
    expect(flat).toContain("table_name CONSTANT pg_catalog.text := 'real_provider_budgets';");
  });

  it("is the Slice E statement with ONLY the names, the refusal prefix, and the bucket list changed", () => {
    const derived = sliceEStatement
      .replaceAll("real_rate_limits", "real_provider_budgets")
      .replaceAll("Rate limit migration refused", "Provider budget migration refused")
      .replace(
        "'recipient_probe_short', 'recipient_probe_day', 'pay_prepare_short', 'pay_prepare_day'",
        "'chain_read_short', 'chain_read_day', 'turnkey_reconcile_short', 'turnkey_reconcile_day', 'pay_submit_short', 'pay_submit_day'",
      );
    expect(statement).toBe(derived);
    expect(statement).not.toBe(sliceEStatement);
    expect(statement).not.toMatch(/real_rate_limits|Rate limit|recipient_probe|pay_prepare/);
  });

  it("defines exactly four columns, one (bucket, subject) primary key, the six-bucket CHECK, and hits >= 1", () => {
    expect(definition).toBe(
      [
        'bucket TEXT COLLATE "C" NOT NULL,',
        "subject TEXT NOT NULL,",
        "window_start TIMESTAMPTZ NOT NULL,",
        "hits INTEGER NOT NULL,",
        "CONSTRAINT real_provider_budgets_pkey PRIMARY KEY (bucket, subject),",
        "CONSTRAINT real_provider_budgets_bucket_check CHECK (bucket IN ('chain_read_short', 'chain_read_day', 'turnkey_reconcile_short', 'turnkey_reconcile_day', 'pay_submit_short', 'pay_submit_day')),",
        "CONSTRAINT real_provider_budgets_hits_check CHECK (hits >= 1)",
      ].join(" "),
    );
    // The CHECK's bucket list is exactly the limiter's.
    expect([...definition.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!).sort()).toEqual([...PROVIDER_BUDGET_BUCKETS]);
  });

  it("K. is idempotent by design: it creates only its own table IF NOT EXISTS, and otherwise only reads the catalog", () => {
    const executed = [...code.matchAll(/EXECUTE format\('([^']*)'/g)].map((match) => match[1]!);
    expect(executed).toEqual(["CREATE TABLE IF NOT EXISTS %I.%I (%s)", "DROP TABLE IF EXISTS pg_temp.%I", "CREATE TEMPORARY TABLE %I (%s) ON COMMIT DROP", "DROP TABLE pg_temp.%I"]);
    for (const ddl of [definition, ...executed]) expect(ddl).not.toMatch(/REFERENCES|FOREIGN KEY|INDEX|TRIGGER|DEFAULT|INSERT|UPDATE|DELETE|ALTER|GENERATED/i);
    // Outside those, nothing writes or alters anything: no backfill, no change to any other table.
    const withoutExecuted = code.replace(/EXECUTE format\('[^']*'/g, "").replace(/RAISE EXCEPTION '[^']*'/g, "");
    expect(withoutExecuted).not.toMatch(/\b(INSERT INTO|UPDATE|DELETE FROM|ALTER|TRUNCATE|CREATE|DROP|GRANT)\b/);
    // The only permanent object it can drop is none: both DROPs name the temporary reference copy.
    expect(executed.filter((ddl) => ddl.startsWith("DROP")).every((ddl) => ddl.includes("pg_temp.%I"))).toBe(true);
  });

  it("L. an incompatible relation under the name fails closed: search_path pinned first, every proof present, every refusal a RAISE", () => {
    expect(flat.slice(flat.indexOf(" BEGIN ") + 1)).toMatch(/^BEGIN PERFORM pg_catalog\.set_config\('search_path', 'pg_catalog, pg_temp', true\);/);
    const raises = [...code.matchAll(/RAISE EXCEPTION '([^']*)'/g)].map((match) => match[1]!);
    expect(raises.length).toBeGreaterThanOrEqual(12);
    for (const message of raises) expect(message).toMatch(/^Provider budget migration refused: /);
    for (const proof of [
      "relkind IS DISTINCT FROM 'r'",
      "relpersistence IS DISTINCT FROM 'p'",
      "pg_inherits",
      "relrowsecurity",
      "pg_trigger",
      "pg_rewrite",
      "does not have exactly the intended columns",
      "differ from the intended definition",
      "NOT c.convalidated",
      "confrelid = tbl",
      "contype NOT IN ('c', 'p', 'n')",
      "does not have exactly the intended constraints",
      "is missing or not the intended definition",
      "has unexpected index(es)",
      "pg_depend",
    ]) {
      expect(code, proof).toContain(proof);
    }
    // The check runs AFTER the create, against the catalog, never trusting the name; it never repairs.
    expect(code.indexOf("CREATE TABLE IF NOT EXISTS")).toBeLessThan(code.indexOf("pg_catalog.pg_class c WHERE c.relnamespace = ns AND c.relname = table_name"));
    expect(code).not.toMatch(/DROP TABLE (IF EXISTS )?%I\.%I|CREATE OR REPLACE/);
  });

  it("stores nothing about the request, and names no other table", () => {
    expect(code).not.toMatch(/handle|recipient|safe_address|display_name|\bip\b|inet|session|cookie|email|passkey|turnkey_(?!reconcile_(short|day)')|activity|attempt/i);
    expect(code).not.toMatch(/payment_attempts|real_account_handles|real_accounts|real_passkeys|registration_|real_rate_limits/);
  });

  it("J2. records the verified state: one disposable-branch verification, never the real database, an unchanged statement, and a separate authorization to apply it for real", () => {
    // The header is everything before the statement, and only comments precede it.
    const headerLines = raw.slice(0, raw.indexOf("DO $$")).split("\n").filter((line) => line.trim() !== "");
    expect(headerLines.length).toBeGreaterThan(20);
    for (const line of headerLines) expect(line.startsWith("--"), line).toBe(true);
    const header = headerLines.map((line) => line.replace(/^--\s?/, "")).join(" ").replace(/\s+/g, " ");

    // One controlled verification on a disposable branch has happened — said once, with its identifying facts.
    expect(header).toContain("VERIFIED ON ONE DISPOSABLE NEON BRANCH; NOT APPLIED TO THE REAL DATABASE.");
    expect(header).toContain("One controlled verification on 2026-10-13 (PostgreSQL 18.6, pooled connection, smoke run 6d32fdf8, independently audited)");
    // The real application database has not received it, and applying it there needs its own authorization.
    expect(header).toContain("The real application database has NOT received this migration.");
    expect(header).toContain("needs its own explicit authorization");
    expect(header).toContain("must come before any code that consults a provider budget is deployed");
    // The statement is unchanged: the digest and length the header records are those of the statement actually there,
    // which are the ones the live run recorded (evidence/provider-budget-smoke-6d32fdf8-*.json).
    expect(statement).toHaveLength(11820);
    expect(createHash("sha256").update(statement).digest("hex")).toBe("8213b46c2f859fb3c8c5457d34d3dff682508d401fcf82b9169b84333c67a5f5");
    expect(header).toContain("SHA-256 8213b46c2f859fb3c8c5457d34d3dff682508d401fcf82b9169b84333c67a5f5, 11820 characters.");
    expect(header).toContain("That statement is unchanged since and is evidence-bearing");
    // The pre-verification claims are gone, and must not creep back: they would now be false.
    for (const obsolete of ["NOT APPLIED ANYWHERE " + "YET", "no PostgreSQL server has " + "executed", "not to a disposable " + "branch"]) expect(raw, obsolete).not.toContain(obsolete);
    // The header's comments never spell out the statement's opening token (extraction takes its first occurrence).
    expect(raw.split("DO $$")).toHaveLength(2);
  });

  it("says plainly that nothing charges the table yet, and that the table must precede any code that consults it", () => {
    expect(raw).toContain("NOTHING CHARGES THIS TABLE YET");
    expect(raw).toContain("FAILS CLOSED without it");
    for (const marker of ["-- BEGIN Account Handles", "-- END Account Handles", "-- BEGIN Payment Attempt Recipient Identity", "-- END Payment Attempt Recipient Identity", "-- BEGIN Provisioning Evidence Capture"]) {
      expect(schema.split(marker), marker).toHaveLength(2);
    }
  });
});
