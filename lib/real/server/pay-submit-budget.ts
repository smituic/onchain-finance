import type { ProviderBudgetLimiter, ProviderBudgetPolicy } from "./rate-limit";

/**
 * Milestone 3, Slice 3A-2 Stage 1 — the per-account budget for a payment
 * submit (POST /api/real/payments/submit). SERVER-ONLY.
 *
 * A submit that reaches the attribution proof makes the server read Turnkey
 * (getActivity, and getUsers for the authenticator mapping) before anything
 * else happens, and may go on to dispatch through the bundler. Without a
 * budget a signed-in account could drive unlimited Turnkey reads by repeating
 * submits. One provider-bound submit request is ONE unit, covering every
 * Turnkey read and the permitted downstream dispatch.
 *
 * ONE POLICY, ONE PLACE. The resolver takes its policies from here and has no
 * policy parameter, so it cannot diverge. That matters beyond tidiness: the
 * accounting statement stores a counter against the limit it is handed, so two
 * limits for one bucket would corrupt the counter rather than merely disagree.
 *
 * DEVELOPMENT VALUES, NOT PRODUCTION LIMITS. They exist so the integration can
 * be built and tested offline; the production numbers are a separate decision.
 *
 * NOT DEPLOYABLE YET: this consults the provider-budget table, which does not
 * exist on the real application database. The limiter fails closed without it
 * (the route answers a generic 500), so the table must be applied and verified
 * BEFORE any code that imports this module is deployed.
 */
export const PAY_SUBMIT_POLICIES: readonly ProviderBudgetPolicy[] = Object.freeze([
  Object.freeze({ bucket: "pay_submit_short", limit: 12, windowSeconds: 600 } as const),
  Object.freeze({ bucket: "pay_submit_day", limit: 90, windowSeconds: 86_400 } as const),
]);

/** Longest window any pay-submit policy has: a retry delay beyond it cannot be real. */
const LONGEST_WINDOW_SECONDS = Math.max(...PAY_SUBMIT_POLICIES.map((policy) => policy.windowSeconds));

/**
 * Friendly, jargon-free; shown only for a real budget denial. The denial
 * happens before any provider work, so nothing changed and tapping Continue
 * again with the same approval is exactly right.
 */
export const PAY_SUBMIT_RATE_LIMITED_MESSAGE = "Too many tries right now. Wait a moment, then tap Continue.";

/** Internal only: no bucket, count, or subject ever leaves the server. */
export type PaySubmitBudgetDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * Charges one provider-bound submit to the authenticated account — BOTH
 * buckets, in one atomic limiter operation — and reports only allowed /
 * denied-with-delay.
 *
 * It throws, and so must be treated as "do no provider work", when the limiter
 * throws or answers anything that is not exactly an allow or a denial with a
 * positive whole-second delay no longer than the longest window. A thrown
 * error is never an allow, and a denial is never reported as a failure.
 *
 * `appUserId` is the canonical id of the account the session resolved to —
 * never anything the HTTP client sent.
 */
export async function consumePaySubmitBudget(limiter: ProviderBudgetLimiter, appUserId: string): Promise<PaySubmitBudgetDecision> {
  const decision: unknown = await limiter.consume({ subject: appUserId, policies: PAY_SUBMIT_POLICIES });
  if (typeof decision !== "object" || decision === null) throw new Error("Pay submit budget refused: unusable limiter answer.");
  const { allowed, retryAfterSeconds } = decision as { allowed?: unknown; retryAfterSeconds?: unknown };
  if (allowed === true) return { allowed: true };
  if (allowed === false && typeof retryAfterSeconds === "number" && Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds >= 1 && retryAfterSeconds <= LONGEST_WINDOW_SECONDS) {
    return { allowed: false, retryAfterSeconds };
  }
  throw new Error("Pay submit budget refused: unusable limiter answer.");
}
