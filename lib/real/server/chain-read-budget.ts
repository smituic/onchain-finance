import type { ProviderBudgetLimiter, ProviderBudgetPolicy } from "./rate-limit";

/**
 * Milestone 3, Slice 3A-1 Stage 2B — the per-account budget for chain reads
 * (the two authenticated GET routes that make the server call a provider:
 * account/balance and payments/[id]/status). SERVER-ONLY.
 *
 * ONE POLICY, ONE PLACE. Both routes' resolvers get their policies from here
 * and take no policy parameter, so they cannot diverge. That matters beyond
 * tidiness: the accounting statement stores a counter against the limit it is
 * handed, so two limits for one bucket would corrupt the counter rather than
 * merely disagree.
 *
 * DEVELOPMENT VALUES, NOT PRODUCTION LIMITS. They exist so the integration can
 * be built and tested offline; the production numbers are a separate decision.
 *
 * NOT DEPLOYABLE YET: this consults the provider-budget table, which does not
 * exist on the real application database. The limiter fails closed without it
 * (the routes answer a generic 500), so the table must be applied and verified
 * BEFORE any code that imports this module is deployed.
 */
export const CHAIN_READ_POLICIES: readonly ProviderBudgetPolicy[] = Object.freeze([
  Object.freeze({ bucket: "chain_read_short", limit: 30, windowSeconds: 600 } as const),
  Object.freeze({ bucket: "chain_read_day", limit: 200, windowSeconds: 86_400 } as const),
]);

/** Longest window any chain-read policy has: a retry delay beyond it cannot be real. */
const LONGEST_WINDOW_SECONDS = Math.max(...CHAIN_READ_POLICIES.map((policy) => policy.windowSeconds));

/** Friendly, jargon-free; shown only for a real budget denial. */
export const CHAIN_READ_RATE_LIMITED_MESSAGE = "You're checking a bit often. Try again in a moment.";

/** Internal only: no bucket, count, or subject ever leaves the server. */
export type ChainReadBudgetDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * Charges one chain read to the authenticated account — BOTH buckets, in one
 * atomic limiter operation — and reports only allowed / denied-with-delay.
 *
 * It throws, and so must be treated as "do no provider work", when the limiter
 * throws or answers anything that is not exactly an allow or a denial with a
 * positive whole-second delay no longer than the longest window. A thrown
 * error is never an allow, and a denial is never reported as a failure.
 *
 * `appUserId` is the canonical id of the account the session resolved to —
 * never anything the HTTP client sent.
 */
export async function consumeChainReadBudget(limiter: ProviderBudgetLimiter, appUserId: string): Promise<ChainReadBudgetDecision> {
  const decision: unknown = await limiter.consume({ subject: appUserId, policies: CHAIN_READ_POLICIES });
  if (typeof decision !== "object" || decision === null) throw new Error("Chain read budget refused: unusable limiter answer.");
  const { allowed, retryAfterSeconds } = decision as { allowed?: unknown; retryAfterSeconds?: unknown };
  if (allowed === true) return { allowed: true };
  if (allowed === false && typeof retryAfterSeconds === "number" && Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds >= 1 && retryAfterSeconds <= LONGEST_WINDOW_SECONDS) {
    return { allowed: false, retryAfterSeconds };
  }
  throw new Error("Chain read budget refused: unusable limiter answer.");
}
