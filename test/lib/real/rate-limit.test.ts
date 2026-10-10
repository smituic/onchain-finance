import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createNeonRateLimitStore } from "@/lib/real/server/neon-store";
import {
  ADDRESS_PREPARE_POLICIES,
  HANDLE_PREPARE_POLICIES,
  RATE_LIMIT_BUCKETS,
  RATE_LIMIT_POLICIES,
  RECIPIENT_PROBE_POLICIES,
  createInMemoryRateLimitStore,
  createRateLimiter,
  decideRateLimit,
  normalizeRateLimitPolicies,
  type RateLimitBucket,
  type RateLimitBucketState,
  type RateLimitPolicy,
  type RateLimitStore,
} from "@/lib/real/server/rate-limit";
import { rateLimitedResponse } from "@/lib/real/server/http";

/**
 * Handle Pay Slice E — the limiter itself: the locked policy table, the
 * fixed-window semantics (through the in-memory store, with a fake clock), the
 * request-level decision, the Neon statement's shape, and the static
 * boundaries (server-only; nothing about the target is stored).
 *
 * The Neon statement's BEHAVIOUR on Postgres — atomicity under real
 * concurrency, the CHECK, idempotent migration — is the gated disposable-branch
 * smoke's job (rate-limit.smoke.test.ts), not this file's.
 */
const P = (bucket: RateLimitBucket, limit: number, windowSeconds: number): RateLimitPolicy => ({ bucket, limit, windowSeconds });

function clockedLimiter(startMs = 1_000_000_000_000) {
  let now = startMs;
  const store = createInMemoryRateLimitStore(() => now);
  return { store, limiter: createRateLimiter(store), advance: (seconds: number) => void (now += seconds * 1000), now: () => now };
}

async function allowedRun(limiter: ReturnType<typeof createRateLimiter>, subject: string, policies: readonly RateLimitPolicy[], times: number) {
  const out: boolean[] = [];
  for (let i = 0; i < times; i++) out.push((await limiter.consume({ subject, policies })).allowed);
  return out;
}

describe("the locked policy table", () => {
  it("is exactly four buckets with the agreed limits and windows", () => {
    expect([...RATE_LIMIT_BUCKETS]).toEqual(["pay_prepare_day", "pay_prepare_short", "recipient_probe_day", "recipient_probe_short"]);
    expect(RATE_LIMIT_POLICIES).toEqual({
      recipient_probe_short: { bucket: "recipient_probe_short", limit: 20, windowSeconds: 600 },
      recipient_probe_day: { bucket: "recipient_probe_day", limit: 100, windowSeconds: 86_400 },
      pay_prepare_short: { bucket: "pay_prepare_short", limit: 20, windowSeconds: 600 },
      pay_prepare_day: { bucket: "pay_prepare_day", limit: 100, windowSeconds: 86_400 },
    });
  });

  it("each request class charges exactly its buckets", () => {
    const names = (policies: readonly RateLimitPolicy[]) => policies.map((policy) => policy.bucket).sort();
    expect(names(RECIPIENT_PROBE_POLICIES)).toEqual(["recipient_probe_day", "recipient_probe_short"]);
    expect(names(ADDRESS_PREPARE_POLICIES)).toEqual(["pay_prepare_day", "pay_prepare_short"]);
    expect(names(HANDLE_PREPARE_POLICIES)).toEqual(["pay_prepare_day", "pay_prepare_short", "recipient_probe_day", "recipient_probe_short"]);
  });
});

describe("fixed-window semantics (in-memory store, fake clock)", () => {
  it("the first N are allowed and N+1 is denied", async () => {
    const { limiter } = clockedLimiter();
    expect(await allowedRun(limiter, "u", [P("recipient_probe_short", 3, 600)], 5)).toEqual([true, true, true, false, false]);
  });

  it("the real short budget: 20 allowed, the 21st denied", async () => {
    const { limiter } = clockedLimiter();
    const run = await allowedRun(limiter, "u", RECIPIENT_PROBE_POLICIES, 21);
    expect(run.slice(0, 20).every(Boolean)).toBe(true);
    expect(run[20]).toBe(false);
  });

  it("requests inside the window increment the count; the window is anchored to the FIRST request", async () => {
    const { store, advance } = clockedLimiter();
    const policies = [P("pay_prepare_short", 5, 600)];
    expect(await store.consume({ subject: "u", policies })).toEqual([{ bucket: "pay_prepare_short", hits: 1, secondsUntilReset: 600 }]);
    advance(100);
    expect(await store.consume({ subject: "u", policies })).toEqual([{ bucket: "pay_prepare_short", hits: 2, secondsUntilReset: 500 }]);
    advance(499);
    expect(await store.consume({ subject: "u", policies })).toEqual([{ bucket: "pay_prepare_short", hits: 3, secondsUntilReset: 1 }]);
  });

  it("the first request after the window has elapsed opens a new one at hits = 1", async () => {
    const { store, limiter, advance } = clockedLimiter();
    const policies = [P("pay_prepare_short", 2, 600)];
    expect(await allowedRun(limiter, "u", policies, 3)).toEqual([true, true, false]);
    advance(599);
    expect((await limiter.consume({ subject: "u", policies })).allowed).toBe(false); // still inside
    advance(1); // exactly the window length after the first request
    expect(await store.consume({ subject: "u", policies })).toEqual([{ bucket: "pay_prepare_short", hits: 1, secondsUntilReset: 600 }]);
    expect(await allowedRun(limiter, "u", policies, 2)).toEqual([true, false]);
  });

  it("a denied request does NOT extend the window: hammering while denied never delays the reset", async () => {
    const { limiter, advance } = clockedLimiter();
    const policies = [P("recipient_probe_short", 2, 600)];
    await allowedRun(limiter, "u", policies, 2);
    for (let i = 0; i < 50; i++) {
      advance(10);
      const denied = await limiter.consume({ subject: "u", policies });
      expect(denied).toEqual({ allowed: false, retryAfterSeconds: 600 - (i + 1) * 10 });
    }
    advance(100); // 600 s after the FIRST request, despite 50 denied calls in between
    expect((await limiter.consume({ subject: "u", policies })).allowed).toBe(true);
  });

  it("the stored count is capped at limit + 1, however many denied requests arrive", async () => {
    const { store } = clockedLimiter();
    const policies = [P("pay_prepare_day", 3, 86_400)];
    const hits: number[] = [];
    for (let i = 0; i < 12; i++) hits.push((await store.consume({ subject: "u", policies }))[0]!.hits);
    expect(hits).toEqual([1, 2, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4]);
  });

  it("subjects are independent: one account's spending never touches another's budget", async () => {
    const { limiter } = clockedLimiter();
    const policies = [P("recipient_probe_short", 2, 600)];
    expect(await allowedRun(limiter, "app-user-1", policies, 3)).toEqual([true, true, false]);
    expect(await allowedRun(limiter, "app-user-2", policies, 3)).toEqual([true, true, false]);
    // A subject that merely contains another's text is still its own key.
    expect(await allowedRun(limiter, "app-user-1x", policies, 2)).toEqual([true, true]);
  });

  it("buckets are independent: exhausting one leaves the others untouched", async () => {
    const { limiter } = clockedLimiter();
    expect(await allowedRun(limiter, "u", [P("recipient_probe_short", 2, 600)], 3)).toEqual([true, true, false]);
    expect(await allowedRun(limiter, "u", [P("pay_prepare_short", 2, 600)], 3)).toEqual([true, true, false]);
    expect(await allowedRun(limiter, "u", [P("recipient_probe_day", 2, 86_400)], 2)).toEqual([true, true]);
  });
});

describe("one decision per request, across all of its buckets", () => {
  it("allowed only when EVERY bucket is within its limit; a denied request has still been charged to all of them", async () => {
    const { store, limiter } = clockedLimiter();
    const probe = [P("recipient_probe_short", 2, 600), P("recipient_probe_day", 10, 86_400)];
    expect(await allowedRun(limiter, "u", probe, 3)).toEqual([true, true, false]);
    // The day bucket was charged by the denied request too.
    const states = await store.consume({ subject: "u", policies: normalizeRateLimitPolicies(probe) });
    expect(states).toEqual([
      { bucket: "recipient_probe_day", hits: 4, secondsUntilReset: 86_400 },
      { bucket: "recipient_probe_short", hits: 3, secondsUntilReset: 600 },
    ]);
  });

  it("a handle prepare is denied when the PROBE budget is spent even though the prepare budget is not — and an address prepare still goes through", async () => {
    const { limiter } = clockedLimiter();
    for (let i = 0; i < 20; i++) expect((await limiter.consume({ subject: "u", policies: RECIPIENT_PROBE_POLICIES })).allowed).toBe(true);
    expect((await limiter.consume({ subject: "u", policies: HANDLE_PREPARE_POLICIES })).allowed).toBe(false);
    expect((await limiter.consume({ subject: "u", policies: ADDRESS_PREPARE_POLICIES })).allowed).toBe(true);
  });

  it("Retry-After is the LONGEST wait among the exceeded buckets (all must recover), never one that isn't exceeded", () => {
    const policies = normalizeRateLimitPolicies([P("recipient_probe_short", 2, 600), P("recipient_probe_day", 5, 86_400), P("pay_prepare_short", 2, 600), P("pay_prepare_day", 5, 86_400)]);
    const state = (overrides: Partial<Record<RateLimitBucket, [number, number]>>): RateLimitBucketState[] =>
      policies.map((policy) => ({ bucket: policy.bucket, hits: overrides[policy.bucket]?.[0] ?? 1, secondsUntilReset: overrides[policy.bucket]?.[1] ?? 50_000 }));

    expect(decideRateLimit(policies, state({}))).toEqual({ allowed: true });
    // Only the short probe bucket is exceeded: its wait, not the (longer) un-exceeded day windows'.
    expect(decideRateLimit(policies, state({ recipient_probe_short: [3, 120] }))).toEqual({ allowed: false, retryAfterSeconds: 120 });
    // Two exceeded: the longer of the two.
    expect(decideRateLimit(policies, state({ recipient_probe_short: [3, 120], pay_prepare_short: [3, 480] }))).toEqual({ allowed: false, retryAfterSeconds: 480 });
    expect(decideRateLimit(policies, state({ recipient_probe_short: [3, 120], recipient_probe_day: [6, 70_000] }))).toEqual({ allowed: false, retryAfterSeconds: 70_000 });
  });

  it("Retry-After is always a whole number of seconds, at least 1", () => {
    const policies = [P("pay_prepare_short", 1, 600)];
    for (const [remaining, expected] of [[0, 1], [-5, 1], [0.2, 1], [1, 1], [1.01, 2], [59.5, 60], [600, 600]] as const) {
      expect(decideRateLimit(policies, [{ bucket: "pay_prepare_short", hits: 2, secondsUntilReset: remaining }])).toEqual({ allowed: false, retryAfterSeconds: expected });
    }
    // Exactly at the limit is still allowed.
    expect(decideRateLimit(policies, [{ bucket: "pay_prepare_short", hits: 1, secondsUntilReset: 600 }])).toEqual({ allowed: true });
  });

  it("FAILS CLOSED on a store answer that is not exactly one usable state per bucket", () => {
    const policies = normalizeRateLimitPolicies(RECIPIENT_PROBE_POLICIES);
    const good: RateLimitBucketState[] = [
      { bucket: "recipient_probe_day", hits: 1, secondsUntilReset: 10 },
      { bucket: "recipient_probe_short", hits: 1, secondsUntilReset: 10 },
    ];
    expect(decideRateLimit(policies, good)).toEqual({ allowed: true });
    const bad: unknown[] = [
      [],
      [good[0]],
      [good[0], good[0]],
      [good[0], { ...good[1], bucket: "pay_prepare_short" }],
      [...good, good[0]],
      [good[0], { ...good[1], hits: 0 }],
      [good[0], { ...good[1], hits: Number.NaN }],
      [good[0], { ...good[1], hits: "1" }],
      [good[0], { ...good[1], secondsUntilReset: Number.POSITIVE_INFINITY }],
      [good[0], { ...good[1], secondsUntilReset: undefined }],
      null,
    ];
    for (const states of bad) expect(() => decideRateLimit(policies, states as never), JSON.stringify(states)).toThrow(/Rate limit refused/);
  });

  it("a store failure propagates (the route's generic 500) — it is never treated as 'allowed'", async () => {
    const down: RateLimitStore = { consume: async () => Promise.reject(new Error("relation \"real_rate_limits\" does not exist")) };
    await expect(createRateLimiter(down).consume({ subject: "u", policies: RECIPIENT_PROBE_POLICIES })).rejects.toThrow();
    const lying: RateLimitStore = { consume: async () => [] };
    await expect(createRateLimiter(lying).consume({ subject: "u", policies: RECIPIENT_PROBE_POLICIES })).rejects.toThrow(/did not report every bucket/);
  });

  it("refuses a request with no subject", async () => {
    const { limiter } = clockedLimiter();
    for (const subject of ["", undefined, null, 7]) await expect(limiter.consume({ subject: subject as never, policies: RECIPIENT_PROBE_POLICIES })).rejects.toThrow(/no subject/);
  });
});

describe("deterministic bucket ordering and policy validation", () => {
  it("whatever order a caller lists them in, every store sees buckets in the same byte order", async () => {
    const seen: string[][] = [];
    const inner = createInMemoryRateLimitStore(() => 0);
    const spy: RateLimitStore = { consume: (input) => (seen.push(input.policies.map((policy) => policy.bucket)), inner.consume(input)) };
    const limiter = createRateLimiter(spy);
    const sorted = ["pay_prepare_day", "pay_prepare_short", "recipient_probe_day", "recipient_probe_short"];
    await limiter.consume({ subject: "u", policies: HANDLE_PREPARE_POLICIES });
    await limiter.consume({ subject: "u", policies: [...HANDLE_PREPARE_POLICIES].reverse() });
    await limiter.consume({ subject: "u", policies: [HANDLE_PREPARE_POLICIES[2]!, HANDLE_PREPARE_POLICIES[0]!, HANDLE_PREPARE_POLICIES[3]!, HANDLE_PREPARE_POLICIES[1]!] });
    expect(seen).toEqual([sorted, sorted, sorted]);
    // A lookup's two rows are a SUFFIX of a handle prepare's four, in the same relative order — the shared rows are always locked probe_day then probe_short.
    await limiter.consume({ subject: "u", policies: [...RECIPIENT_PROBE_POLICIES].reverse() });
    expect(seen[3]).toEqual(["recipient_probe_day", "recipient_probe_short"]);
    expect(sorted.slice(2)).toEqual(seen[3]);
    // Byte order is what Postgres's COLLATE "C" gives.
    expect([...sorted].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(sorted);
    expect(normalizeRateLimitPolicies(RECIPIENT_PROBE_POLICIES)).not.toBe(RECIPIENT_PROBE_POLICIES); // never sorts a caller's array in place
  });

  it("a duplicate bucket is REJECTED (never charged twice, never silently dropped)", async () => {
    const { limiter } = clockedLimiter();
    const twice = [P("recipient_probe_short", 20, 600), P("recipient_probe_short", 20, 600)];
    expect(() => normalizeRateLimitPolicies(twice)).toThrow(/same bucket was named twice/);
    await expect(limiter.consume({ subject: "u", policies: twice })).rejects.toThrow(/same bucket was named twice/);
    await expect(limiter.consume({ subject: "u", policies: [...RECIPIENT_PROBE_POLICIES, P("recipient_probe_day", 5, 60)] })).rejects.toThrow(/same bucket/);
  });

  it("no policies, an unknown bucket, or a non-positive / fractional limit or window is refused", () => {
    const bad: unknown[] = [
      [],
      undefined,
      [{ bucket: "recipient_handle_smit", limit: 1, windowSeconds: 1 }],
      [{ bucket: "", limit: 1, windowSeconds: 1 }],
      [P("pay_prepare_day", 0, 60)],
      [P("pay_prepare_day", -1, 60)],
      [P("pay_prepare_day", 1.5, 60)],
      [P("pay_prepare_day", 1, 0)],
      [P("pay_prepare_day", 1, 0.5)],
      [P("pay_prepare_day", Number.NaN, 60)],
      [P("pay_prepare_day", Number.POSITIVE_INFINITY, 60)],
      [null],
    ];
    for (const policies of bad) expect(() => normalizeRateLimitPolicies(policies as never), JSON.stringify(policies)).toThrow(/Rate limit refused/);
  });
});

describe("the Neon adapter — ONE statement per request", () => {
  function recordingSql(result: unknown[] | Error) {
    const calls: { text: string; values: unknown[] }[] = [];
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join("$").replace(/\s+/g, " ").trim(), values });
      if (result instanceof Error) throw result;
      return result;
    }) as never;
    return { sql, calls };
  }
  const fourRows = [
    { bucket: "pay_prepare_day", hits: 1, seconds_until_reset: 86_400 },
    { bucket: "pay_prepare_short", hits: 2, seconds_until_reset: "599" },
    { bucket: "recipient_probe_day", hits: "3", seconds_until_reset: 86_000 },
    { bucket: "recipient_probe_short", hits: 21, seconds_until_reset: 42, subject: "app-user-1", window_start: "2026-01-01" },
  ];

  it("a lookup (2 buckets), an address prepare (2), and a handle prepare (4) each make exactly ONE database call", async () => {
    for (const policies of [RECIPIENT_PROBE_POLICIES, ADDRESS_PREPARE_POLICIES, HANDLE_PREPARE_POLICIES]) {
      const { sql, calls } = recordingSql(fourRows);
      await createNeonRateLimitStore(sql).consume({ subject: "app-user-1", policies: normalizeRateLimitPolicies(policies) });
      expect(calls, String(policies.length)).toHaveLength(1);
    }
  });

  it("it is a single multi-row upsert: rows in byte order, database time, the count capped at limit + 1, the window moved only when elapsed", async () => {
    const { sql, calls } = recordingSql(fourRows);
    await createNeonRateLimitStore(sql).consume({ subject: "app-user-1", policies: normalizeRateLimitPolicies(HANDLE_PREPARE_POLICIES) });
    const text = calls[0]!.text;
    expect(text).toMatch(/^INSERT INTO real_rate_limits AS r \(bucket, subject, window_start, hits\) SELECT p\.key, \$::text, now\(\), 1 FROM jsonb_each\(\$::jsonb\) AS p ORDER BY p\.key COLLATE "C" ON CONFLICT \(bucket, subject\) DO UPDATE SET /);
    expect(text).toContain("LEAST(r.hits + 1, ($::jsonb -> r.bucket ->> 'limit')::int + 1)");
    expect(text).toContain("<= now() THEN now() ELSE r.window_start END");
    expect(text).toContain("<= now() THEN 1 ELSE LEAST(");
    expect(text).toMatch(/RETURNING r\.bucket, r\.hits, GREATEST\(1, ceil\(extract\(epoch FROM \(r\.window_start \+ make_interval\(.*\) - now\(\)\)\)\)\)::int AS seconds_until_reset$/);
    // One statement, no transaction, no separate read, no lock statement, no server wall clock.
    expect(text.split(";").filter((part) => part.trim() !== "")).toHaveLength(1);
    expect(text).not.toMatch(/\bBEGIN\b|\bCOMMIT\b|FOR UPDATE|SELECT [^;]* FROM real_rate_limits|clock_timestamp|statement_timestamp/i);
  });

  it("the ONLY values sent are the caller's own subject and the bucket budgets — never a handle, an address, a name, or a clock reading", async () => {
    const { sql, calls } = recordingSql(fourRows);
    await createNeonRateLimitStore(sql).consume({ subject: "app-user-1", policies: normalizeRateLimitPolicies(HANDLE_PREPARE_POLICIES) });
    const { values } = calls[0]!;
    const budgets = JSON.stringify({
      pay_prepare_day: { limit: 100, windowSeconds: 86_400 },
      pay_prepare_short: { limit: 20, windowSeconds: 600 },
      recipient_probe_day: { limit: 100, windowSeconds: 86_400 },
      recipient_probe_short: { limit: 20, windowSeconds: 600 },
    });
    expect(new Set(values)).toEqual(new Set(["app-user-1", budgets]));
    expect(values.filter((value) => value === "app-user-1")).toHaveLength(1);
    expect(Object.keys(JSON.parse(budgets))).toEqual(["pay_prepare_day", "pay_prepare_short", "recipient_probe_day", "recipient_probe_short"]);
  });

  it("rows are mapped field by field (numbers coerced, extra columns dropped)", async () => {
    const { sql } = recordingSql(fourRows);
    const states = await createNeonRateLimitStore(sql).consume({ subject: "app-user-1", policies: normalizeRateLimitPolicies(HANDLE_PREPARE_POLICIES) });
    expect(states).toEqual([
      { bucket: "pay_prepare_day", hits: 1, secondsUntilReset: 86_400 },
      { bucket: "pay_prepare_short", hits: 2, secondsUntilReset: 599 },
      { bucket: "recipient_probe_day", hits: 3, secondsUntilReset: 86_000 },
      { bucket: "recipient_probe_short", hits: 21, secondsUntilReset: 42 },
    ]);
    expect(decideRateLimit(normalizeRateLimitPolicies(HANDLE_PREPARE_POLICIES), states)).toEqual({ allowed: false, retryAfterSeconds: 42 });
  });

  it("FAILS CLOSED: a missing table or any database error throws — and so does a short answer", async () => {
    const missing = recordingSql(new Error('relation "real_rate_limits" does not exist'));
    await expect(createRateLimiter(createNeonRateLimitStore(missing.sql)).consume({ subject: "app-user-1", policies: RECIPIENT_PROBE_POLICIES })).rejects.toThrow();
    const short = recordingSql([fourRows[2]]);
    await expect(createRateLimiter(createNeonRateLimitStore(short.sql)).consume({ subject: "app-user-1", policies: RECIPIENT_PROBE_POLICIES })).rejects.toThrow(/did not report every bucket/);
  });
});

describe("the 429 contract", () => {
  it("is exactly { error, code: 'rate_limited' } with an integer Retry-After — no count, reset time, bucket, account, or target", async () => {
    const response = rateLimitedResponse("Too many tries. Try again later.", 317);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("317");
    expect(await response.json()).toEqual({ error: "Too many tries. Try again later.", code: "rate_limited" });
    expect([...response.headers.keys()].sort()).toEqual(["content-type", "retry-after"]);
  });

  it("Retry-After is always a whole number of seconds >= 1, whatever it is handed", () => {
    for (const [input, expected] of [[0, "1"], [-3, "1"], [0.4, "1"], [12.2, "13"], [Number.NaN, "1"], [Number.POSITIVE_INFINITY, "1"]] as const) {
      expect(rateLimitedResponse("x", input).headers.get("Retry-After"), String(input)).toBe(expected);
    }
  });
});

describe("static boundaries", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
    return out;
  };
  const normalized = (file: string) => file.split(path.sep).join("/");
  const sources = [...walk("lib"), ...walk("app"), ...walk("components"), ...walk("simulation")];
  const naming = (pattern: RegExp) => sources.filter((file) => pattern.test(readFileSync(file, "utf8"))).map(normalized).sort();
  const limiterSource = readFileSync("lib/real/server/rate-limit.ts", "utf8");

  it("the limiter is SERVER-ONLY: it is imported only by server modules and the three protected routes — never a component, a store, lib/real's browser code, or Practice", () => {
    expect(naming(/from\s+["'][^"']*\/rate-limit["']/)).toEqual([
      "lib/real/server/handle-claim.ts",
      "lib/real/server/handle-recipient.ts",
      "lib/real/server/neon-store.ts",
      "lib/real/server/payments.ts",
      "lib/real/server/runtime.ts",
    ]);
    expect(naming(/getRateLimiter\b/)).toEqual([
      "app/api/real/account/handle/options/route.ts",
      "app/api/real/payments/prepare/route.ts",
      "app/api/real/recipients/lookup/route.ts",
      "lib/real/server/runtime.ts",
    ]);
    expect(naming(/real_rate_limits/)).toEqual(["lib/real/server/neon-store.ts", "lib/real/server/rate-limit.ts"]);
    // No bucket name ever appears outside the limiter module (so none can be sent to a browser).
    expect(naming(/recipient_probe_(short|day)|pay_prepare_(short|day)/)).toEqual(["lib/real/server/rate-limit.ts"]);
  });

  it("the limiter module depends on nothing: no handle, account, payment, session, network, or framework import", () => {
    expect(limiterSource).not.toMatch(/^import /m);
    // Code only (the doc comments explain, in prose, what is deliberately NOT keyed on).
    const limiterCode = limiterSource
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(limiterCode.length).toBeGreaterThan(2000);
    expect(limiterCode).not.toMatch(/\bfetch\(|process\.env|\bheaders\b|x-forwarded-for|\bip\b|recipientHandle|canonicalHandle|safeAddress|displayName|sessionId|credentialId|cookie/i);
  });

  it("every caller charges the AUTHENTICATED account, and nothing about the target reaches the limiter", () => {
    const callSites: Record<string, RegExp> = {
      "lib/real/server/handle-recipient.ts": /input\.rateLimiter\.consume\(\{ subject: input\.currentAppUserId, policies: RECIPIENT_PROBE_POLICIES \}\)/,
      "lib/real/server/handle-claim.ts": /input\.rateLimiter\.consume\(\{ subject: input\.appUserId, policies: RECIPIENT_PROBE_POLICIES \}\)/,
      "lib/real/server/payments.ts": /input\.rateLimiter\.consume\(\{\s*subject: authenticated\.account\.appUserId,\s*policies: target\.kind === "handle" \? HANDLE_PREPARE_POLICIES : ADDRESS_PREPARE_POLICIES,\s*\}\)/,
    };
    for (const [file, pattern] of Object.entries(callSites)) {
      const text = readFileSync(file, "utf8");
      expect(text, file).toMatch(pattern);
      expect(text.match(/rateLimiter\.consume\(/g), file).toHaveLength(1);
    }
  });

  it("the 429 body is built in ONE place and no route adds limiter internals to a response", () => {
    expect(naming(/rateLimitedResponse\(/)).toEqual([
      "app/api/real/account/handle/options/route.ts",
      "app/api/real/payments/prepare/route.ts",
      "app/api/real/recipients/lookup/route.ts",
      "lib/real/server/http.ts",
    ]);
    for (const route of ["app/api/real/account/handle/options/route.ts", "app/api/real/payments/prepare/route.ts", "app/api/real/recipients/lookup/route.ts"]) {
      const text = readFileSync(route, "utf8");
      expect(text, route).not.toMatch(/retryAfterSeconds(?!\))/); // only ever passed straight into rateLimitedResponse(...)
      expect(text, route).not.toMatch(/\bhits\b|secondsUntilReset|\bsubject\b/);
    }
    // The pre-existing payment-quota 429 keeps its own body: no `code`, no Retry-After.
    expect(readFileSync("app/api/real/payments/prepare/route.ts", "utf8")).toContain('return jsonError("You\'ve reached the payment limit for now. Try again later.", 429);');
  });

  it("production never falls back to the in-memory limiter", () => {
    const runtime = readFileSync("lib/real/server/runtime.ts", "utf8");
    const neonBranch = runtime.slice(runtime.indexOf("if (databaseUrl) {"), runtime.indexOf('if (process.env.NODE_ENV === "production")'));
    expect(neonBranch).toContain("rateLimiter = createRateLimiter(durable.rateLimits);");
    expect(neonBranch).not.toContain("createInMemoryRateLimitStore");
    const afterThrow = runtime.slice(runtime.indexOf("DATABASE_URL is required in production"));
    expect(afterThrow).toContain("rateLimiter = createRateLimiter(createInMemoryRateLimitStore());"); // reachable only past the production throw
    expect(runtime.match(/createInMemoryRateLimitStore\(\)/g)).toHaveLength(1);
  });
});

describe("schema.sql — the real_rate_limits block (static)", () => {
  const schema = readFileSync("lib/real/server/schema.sql", "utf8");
  const BEGIN = "-- BEGIN Handle Pay Rate Limits";
  const END = "-- END Handle Pay Rate Limits";
  const raw = schema.slice(schema.indexOf(BEGIN), schema.indexOf(END));
  const code = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  const flat = code.replace(/\s+/g, " ");

  it("is ONE new DO block, after the recipient-identity block and before the provisioning-evidence block (which stays last)", () => {
    expect(schema.split(BEGIN)).toHaveLength(2);
    expect(schema.split(END)).toHaveLength(2);
    expect(schema.indexOf(BEGIN)).toBeGreaterThan(schema.indexOf("-- END Payment Attempt Recipient Identity"));
    expect(schema.indexOf("-- BEGIN Provisioning Evidence Capture")).toBeGreaterThan(schema.indexOf(END));
    expect(schema.trimEnd().endsWith("-- END Provisioning Evidence Capture")).toBe(true);
    expect(code.trim().startsWith("DO $$")).toBe(true);
    expect(code.trim().endsWith("END $$;")).toBe(true);
    expect(code.match(/DO \$\$/g)).toHaveLength(1);
    expect(raw.match(/'public'/g)).toHaveLength(1);
    expect(flat).toContain("target_schema CONSTANT pg_catalog.text := 'public';");
    expect(flat).toContain("table_name CONSTANT pg_catalog.text := 'real_rate_limits';");
  });

  it("defines exactly four columns, one primary key, and the two bounded CHECKs", () => {
    const definition = flat.slice(flat.indexOf("$definition$") + 12, flat.lastIndexOf("$definition$")).trim();
    expect(definition).toBe(
      [
        'bucket TEXT COLLATE "C" NOT NULL,',
        "subject TEXT NOT NULL,",
        "window_start TIMESTAMPTZ NOT NULL,",
        "hits INTEGER NOT NULL,",
        "CONSTRAINT real_rate_limits_pkey PRIMARY KEY (bucket, subject),",
        "CONSTRAINT real_rate_limits_bucket_check CHECK (bucket IN ('recipient_probe_short', 'recipient_probe_day', 'pay_prepare_short', 'pay_prepare_day')),",
        "CONSTRAINT real_rate_limits_hits_check CHECK (hits >= 1)",
      ].join(" "),
    );
    // The CHECK's bucket list is exactly the limiter's.
    const listed = [...definition.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!).sort();
    expect(listed).toEqual([...RATE_LIMIT_BUCKETS]);
  });

  it("stores nothing about the target and adds no foreign key, index, trigger, default, or backfill", () => {
    expect(code).not.toMatch(/handle|recipient_(app_user_id|handle|display_name)|safe_address|display_name|\bip\b|inet|session|email|passkey|turnkey/i);
    // Everything the block EXECUTEs or defines (its refusal messages are prose, and are checked separately below).
    const definition = flat.slice(flat.indexOf("$definition$") + 12, flat.lastIndexOf("$definition$"));
    const executed = [...code.matchAll(/EXECUTE format\('([^']*)'/g)].map((match) => match[1]!);
    expect(executed).toEqual(["CREATE TABLE IF NOT EXISTS %I.%I (%s)", "DROP TABLE IF EXISTS pg_temp.%I", "CREATE TEMPORARY TABLE %I (%s) ON COMMIT DROP", "DROP TABLE pg_temp.%I"]);
    for (const ddl of [definition, ...executed]) {
      expect(ddl).not.toMatch(/REFERENCES|FOREIGN KEY|INDEX|TRIGGER|DEFAULT|INSERT|UPDATE|DELETE|ALTER|GENERATED/i);
    }
    // Outside those, the block only reads the catalog: no other statement writes or alters anything.
    const withoutExecuted = code.replace(/EXECUTE format\('[^']*'/g, "").replace(/RAISE EXCEPTION '[^']*'/g, "");
    expect(withoutExecuted).not.toMatch(/\b(INSERT INTO|UPDATE|DELETE FROM|ALTER|TRUNCATE|CREATE|DROP|GRANT)\b/);
    // It creates only its own table (and its own temporary reference copy).
    expect([...code.matchAll(/CREATE (?:TEMPORARY )?TABLE[^']*/g)].map((match) => match[0].trim())).toEqual(["CREATE TABLE IF NOT EXISTS %I.%I (%s)", "CREATE TEMPORARY TABLE %I (%s) ON COMMIT DROP"]);
  });

  it("is fail-closed: search_path pinned first, and every refusal RAISEs under one prefix", () => {
    expect(flat.slice(flat.indexOf(" BEGIN ") + 1)).toMatch(/^BEGIN PERFORM pg_catalog\.set_config\('search_path', 'pg_catalog, pg_temp', true\);/);
    const raises = [...code.matchAll(/RAISE EXCEPTION '([^']*)'/g)].map((match) => match[1]!);
    expect(raises.length).toBeGreaterThanOrEqual(12);
    for (const message of raises) expect(message).toMatch(/^Rate limit migration refused: /);
    for (const proof of ["pg_inherits", "relrowsecurity", "pg_trigger", "pg_rewrite", "confrelid = tbl", "contype NOT IN ('c', 'p', 'n')", "has unexpected index(es)", "pg_depend"]) expect(code, proof).toContain(proof);
  });

  it("does not touch any existing block: the evidence-bearing blocks sit outside it, byte for byte, and it names none of their objects", () => {
    expect(code).not.toMatch(/payment_attempts|real_account_handles|real_accounts|real_passkeys|registration_/);
    for (const marker of ["-- BEGIN Account Handles", "-- END Account Handles", "-- BEGIN Payment Attempt Recipient Identity", "-- END Payment Attempt Recipient Identity", "-- BEGIN Provisioning Evidence Capture"]) {
      expect(schema.split(marker), marker).toHaveLength(2);
    }
  });

  it("records the deployment order: the table must exist before the Slice E code is deployed", () => {
    expect(raw).toContain("it must be applied BEFORE the Slice E application code is");
    expect(raw).toContain("FAIL CLOSED without it");
    expect(readFileSync("lib/real/server/rate-limit.ts", "utf8")).toContain("must therefore exist before this");
  });
});
