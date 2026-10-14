import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAY_SUBMIT_POLICIES, PAY_SUBMIT_RATE_LIMITED_MESSAGE, consumePaySubmitBudget } from "@/lib/real/server/pay-submit-budget";
import { CHAIN_READ_POLICIES } from "@/lib/real/server/chain-read-budget";
import { retryableRateLimitedResponse, rateLimitedResponse } from "@/lib/real/server/http";
import { createInMemoryProviderBudgetStore, createProviderBudgetLimiter, normalizeProviderBudgetPolicies } from "@/lib/real/server/rate-limit";
import { realBudget, scriptedBudget } from "./fixtures/chain-read-budget";

const DAY = 86_400;
const ALLOW = { allowed: true } as const;
const deny = (retryAfterSeconds: number) => ({ allowed: false, retryAfterSeconds }) as const;

describe("PAY_SUBMIT_POLICIES — Slice 3A-2 development values", () => {
  it("are exactly the approved development values, on both buckets of the family", () => {
    expect(PAY_SUBMIT_POLICIES).toEqual([
      { bucket: "pay_submit_short", limit: 12, windowSeconds: 600 },
      { bucket: "pay_submit_day", limit: 90, windowSeconds: DAY },
    ]);
  });

  it("are frozen — the collection and each entry", () => {
    expect(Object.isFrozen(PAY_SUBMIT_POLICIES)).toBe(true);
    for (const policy of PAY_SUBMIT_POLICIES) expect(Object.isFrozen(policy)).toBe(true);
  });

  it("pass the limiter's own normalization (a family is always charged on both buckets), and never mix with chain_read", () => {
    expect(normalizeProviderBudgetPolicies(PAY_SUBMIT_POLICIES).map((policy) => policy.bucket)).toEqual(["pay_submit_day", "pay_submit_short"]);
    expect(PAY_SUBMIT_POLICIES.some((policy) => CHAIN_READ_POLICIES.some((other) => other.bucket === policy.bucket))).toBe(false);
  });

  it("the denial message is plain language and names no provider, bucket, or counter", () => {
    expect(PAY_SUBMIT_RATE_LIMITED_MESSAGE).toBe("Too many tries right now. Wait a moment, then tap Continue.");
    expect(PAY_SUBMIT_RATE_LIMITED_MESSAGE).not.toMatch(/turnkey|pimlico|bundler|bucket|budget|pay_submit|limit/i);
  });
});

describe("consumePaySubmitBudget", () => {
  it("charges BOTH buckets in one limiter call, for exactly the subject it was given", async () => {
    const { limiter, calls } = scriptedBudget(ALLOW);
    expect(await consumePaySubmitBudget(limiter, "app-user-1")).toEqual({ allowed: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.subject).toBe("app-user-1");
    expect(calls[0]!.policies).toBe(PAY_SUBMIT_POLICIES);
  });

  it("a denial is accepted only with a positive whole-second delay no longer than the longest window", async () => {
    expect(await consumePaySubmitBudget(scriptedBudget(deny(1)).limiter, "u")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(await consumePaySubmitBudget(scriptedBudget(deny(42)).limiter, "u")).toEqual({ allowed: false, retryAfterSeconds: 42 });
    expect(await consumePaySubmitBudget(scriptedBudget(deny(DAY)).limiter, "u")).toEqual({ allowed: false, retryAfterSeconds: DAY });
  });

  it("a throw is an error, and every malformed answer is an error — never an allow", async () => {
    await expect(consumePaySubmitBudget(scriptedBudget(new Error("connection terminated")).limiter, "u")).rejects.toThrow(/connection terminated/);
    for (const bad of [
      undefined,
      null,
      "allowed",
      7,
      true,
      {},
      { retryAfterSeconds: 30 },
      { allowed: "true" },
      { allowed: 1 },
      { allowed: null },
      { allowed: false },
      { allowed: false, retryAfterSeconds: 0 },
      { allowed: false, retryAfterSeconds: -5 },
      { allowed: false, retryAfterSeconds: Number.NaN },
      { allowed: false, retryAfterSeconds: Number.POSITIVE_INFINITY },
      { allowed: false, retryAfterSeconds: 1.5 },
      { allowed: false, retryAfterSeconds: "30" },
      { allowed: false, retryAfterSeconds: DAY + 1 },
      { allowed: false, retryAfterSeconds: Number.MAX_SAFE_INTEGER },
    ]) {
      await expect(consumePaySubmitBudget(scriptedBudget(bad).limiter, "u"), JSON.stringify(bad)).rejects.toThrow(/unusable limiter answer/);
    }
  });

  it("real accounting: the 13th request in a window is denied, with a real retry delay; another account is unaffected; chain reads are a separate budget", async () => {
    const limiter = realBudget();
    for (let i = 0; i < 12; i += 1) expect(await consumePaySubmitBudget(limiter, "app-user-1")).toEqual({ allowed: true });

    const denied = await consumePaySubmitBudget(limiter, "app-user-1");
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(Number.isSafeInteger(denied.retryAfterSeconds)).toBe(true);
      expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(denied.retryAfterSeconds).toBeLessThanOrEqual(600);
    }
    expect(await consumePaySubmitBudget(limiter, "app-user-2")).toEqual({ allowed: true });
    expect((await limiter.consume({ subject: "app-user-1", policies: CHAIN_READ_POLICIES })).allowed).toBe(true);
  });

  it("real accounting: the daily bucket is enforced independently of the short one, and a denial is never refunded", async () => {
    let now = 0;
    const limiter = createProviderBudgetLimiter(createInMemoryProviderBudgetStore(() => now));
    let allowed = 0;
    // 11 minutes apart over under 24 hours: the 10-minute window always resets, so only the daily bucket can deny.
    for (let i = 0; i < 130; i += 1) {
      now = i * 660_000;
      if ((await consumePaySubmitBudget(limiter, "app-user-1")).allowed) allowed += 1;
    }
    expect(allowed).toBe(90);
  });
});

describe("retryableRateLimitedResponse — the submit denial contract", () => {
  it("is a 429 with a whole-second Retry-After and exactly { error, code, retryable: true }", async () => {
    const response = retryableRateLimitedResponse(PAY_SUBMIT_RATE_LIMITED_MESSAGE, 42);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(await response.json()).toEqual({ error: PAY_SUBMIT_RATE_LIMITED_MESSAGE, code: "rate_limited", retryable: true });
  });

  it("refuses an impossible delay instead of inventing a header", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => retryableRateLimitedResponse("x", bad)).toThrow();
  });

  it("leaves the shared rateLimitedResponse unchanged — no retryable field on the probe/prepare routes", async () => {
    expect(await rateLimitedResponse("slow down", 7).json()).toEqual({ error: "slow down", code: "rate_limited" });
  });
});

describe("POST /api/real/payments/submit — outcome mapping", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("next/headers");
    vi.doUnmock("@/lib/real/server/runtime");
    vi.doUnmock("@/lib/real/server/payments");
  });

  async function load(outcome: unknown | Error) {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_REAL_MODE_ENABLED", "true");
    vi.stubEnv("TURNKEY_PARENT_ORGANIZATION_ID", "parent-org");
    vi.stubEnv("TURNKEY_API_PUBLIC_KEY", "public-key");
    vi.stubEnv("TURNKEY_API_PRIVATE_KEY", "private-key");
    vi.stubEnv("REAL_SESSION_SECRET", "4be1c0d27a9f3e8d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170605");
    vi.stubEnv("NEXT_PUBLIC_REAL_RP_ID", "localhost");
    vi.stubEnv("NEXT_PUBLIC_REAL_ORIGIN", "http://localhost:3000");
    vi.stubEnv("PIMLICO_API_KEY", "pim_test_key");
    const limiter = realBudget();
    const resolve = vi.fn(async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    });
    vi.doMock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
    vi.doMock("@/lib/real/server/runtime", () => ({ getRealAccountRegistry: () => ({}), getPaymentAttemptStore: () => ({}), getProviderBudgetLimiter: () => limiter }));
    vi.doMock("@/lib/real/server/payments", () => ({ resolveSubmitPayment: resolve }));
    const route = await import("@/app/api/real/payments/submit/route");
    const request = new Request("http://localhost/api/real/payments/submit", { method: "POST", body: JSON.stringify({ attemptId: "a", signature: "0x00", activityId: "b", appUserId: "attacker" }) });
    return { response: await route.POST(request), resolve, limiter };
  }

  it("a budget denial is 429 { error, code: 'rate_limited', retryable: true } with the validated Retry-After", async () => {
    const { response } = await load({ outcome: "rate_limited", retryAfterSeconds: 77 });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("77");
    const body = await response.json();
    expect(body).toEqual({ error: PAY_SUBMIT_RATE_LIMITED_MESSAGE, code: "rate_limited", retryable: true });
    expect(body.retryable).toBe(true);
  });

  it("hands the resolver the runtime's budget limiter and never anything from the request body but attempt/signature/activity", async () => {
    const { resolve, limiter } = await load({ outcome: "not_found" });
    const input = (resolve.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(input.providerBudgetLimiter).toBe(limiter);
    expect(input.attemptId).toBe("a");
    expect(JSON.stringify(input)).not.toContain("attacker");
    expect(Object.keys(input)).not.toContain("appUserId");
  });

  it("every other outcome keeps its existing response", async () => {
    expect((await load({ outcome: "unauthenticated" })).response.status).toBe(401);
    expect((await load({ outcome: "not_found" })).response.status).toBe(404);
    expect((await load({ outcome: "invalid_signature" })).response.status).toBe(400);
    expect((await load({ outcome: "wrong_state", state: "cancelled" })).response.status).toBe(409);
    expect((await load({ outcome: "wrong_passkey" })).response.status).toBe(409);
    const unavailable = (await load({ outcome: "authorization_unavailable" })).response;
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "We couldn't confirm your passkey approval yet. Try again in a moment.", retryable: true });
    for (const outcome of ["submitted", "failed", "unknown"]) {
      const { response } = await load({ outcome, attempt: { id: "x" } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ attempt: { id: "x" } });
    }
  });

  it("a limiter failure or malformed delay is the generic 500 — no detail, never a 429 or an allow", async () => {
    for (const outcome of [new Error('relation "real_provider_budgets" does not exist'), { outcome: "rate_limited", retryAfterSeconds: 0 }]) {
      const { response } = await load(outcome);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Something went wrong. Please try again." });
    }
  });
});

describe("static boundaries — pay_submit policy lives in one place", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
    return out;
  };

  it("the submit resolver and route carry no bucket name, window, or numeric limit — they only call the policy module", () => {
    const route = readFileSync("app/api/real/payments/submit/route.ts", "utf8");
    expect(route).not.toMatch(/pay_submit/);
    expect(route).not.toMatch(/windowSeconds/);
    expect(route).not.toMatch(/\blimit:\s*\d/);
    const payments = readFileSync("lib/real/server/payments.ts", "utf8");
    expect(payments).not.toMatch(/pay_submit/);
    expect(payments).not.toMatch(/windowSeconds/);
    expect(payments).not.toMatch(/\blimit:\s*\d/);
    expect(payments).toMatch(/consumePaySubmitBudget\(input\.providerBudgetLimiter/);
    expect(payments.match(/consumePaySubmitBudget\(/g)).toHaveLength(1);
  });

  it("the policy module names exactly two limits; no browser-reachable file names a pay_submit bucket", () => {
    const source = readFileSync("lib/real/server/pay-submit-budget.ts", "utf8");
    expect(source.match(/limit: \d+/g)).toHaveLength(2);
    expect(source).toContain("pay_submit_short");
    expect(source).toContain("pay_submit_day");
    const naming = [...walk("lib"), ...walk("app"), ...walk("components"), ...walk("simulation")].filter((file) => /pay_submit/.test(readFileSync(file, "utf8"))).map((file) => file.split(path.sep).join("/")).sort();
    expect(naming).toEqual(["lib/real/server/pay-submit-budget.ts", "lib/real/server/rate-limit.ts"]);
  });

  it("the other budget guards are untouched: chain-read-budget.ts does not name pay_submit, and the policy module never names chain_read", () => {
    expect(readFileSync("lib/real/server/chain-read-budget.ts", "utf8")).not.toMatch(/pay_submit/);
    expect(readFileSync("lib/real/server/pay-submit-budget.ts", "utf8")).not.toMatch(/chain_read|turnkey_reconcile/);
  });
});
