import { createInMemoryProviderBudgetStore, createProviderBudgetLimiter, type ProviderBudgetLimiter, type ProviderBudgetPolicy, type RateLimitDecision } from "@/lib/real/server/rate-limit";

/**
 * Offline stand-ins for the per-account chain-read budget (3A-1 Stage 2B).
 * Nothing here touches Neon or a provider.
 */

/** The real limiter over a private in-memory store: real accounting, a fresh counter per call. */
export function realBudget(nowMs?: () => number): ProviderBudgetLimiter {
  return createProviderBudgetLimiter(createInMemoryProviderBudgetStore(nowMs));
}

/** A fresh, effectively unlimited-for-one-test budget — what a test that is not about budgets passes. */
export const openBudget = realBudget;

export type RecordedBudgetCall = { subject: string; policies: readonly ProviderBudgetPolicy[] };

/**
 * A scripted limiter: answers each consume() with the next scripted step (the
 * last step repeats) and records exactly what it was asked to charge. A step
 * that is an Error is thrown; any other non-decision value is returned as-is,
 * which is how tests feed it a malformed answer.
 */
export function scriptedBudget(...steps: Array<RateLimitDecision | Error | unknown>) {
  const calls: RecordedBudgetCall[] = [];
  const limiter: ProviderBudgetLimiter = {
    async consume({ subject, policies }) {
      calls.push({ subject, policies });
      const step = steps[Math.min(calls.length - 1, steps.length - 1)];
      if (step instanceof Error) throw step;
      return step as RateLimitDecision;
    },
  };
  return { limiter, calls };
}
