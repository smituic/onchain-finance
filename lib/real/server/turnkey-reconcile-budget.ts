import type { ProviderBudgetLimiter, ProviderBudgetPolicy } from "./rate-limit";

/**
 * Milestone 3, Slice 3A-3 Stage 1 — the per-account budget for Turnkey
 * reconciliation: the requests that make the server READ Turnkey (getActivity,
 * getUsers) on behalf of the signed-in user, and — for a backup-passkey create
 * with no recorded activity — may forward the one permitted replay.
 *   POST /api/real/account/passkeys/backup/authorize/reconcile
 *   POST /api/real/account/passkeys/backup/verify-signing/confirm
 *   POST /api/real/account/passkeys/[credentialId]/revoke/reconcile
 * SERVER-ONLY.
 *
 * One provider-bound request is ONE unit, however many Turnkey reads it makes.
 * A request that never reaches Turnkey (unknown or foreign id, a terminal or
 * wrong state, a missing account, a removal still inside its no-receipt grace
 * window, ...) is never charged. The two submit routes are not charged here:
 * their own WebAuthn authorization and durable dispatch claim stay in force,
 * and their internal reconcile runs on an already-admitted private path.
 *
 * ONE POLICY, ONE PLACE. The three reconcile entrypoints get their policies
 * from here and take no policy parameter, so they cannot diverge. That matters
 * beyond tidiness: the accounting statement stores a counter against the limit
 * it is handed, so two limits for one bucket would corrupt the counter rather
 * than merely disagree.
 *
 * DEVELOPMENT VALUES, NOT PRODUCTION LIMITS. They exist so the integration can
 * be built and tested offline; the production numbers are a separate decision.
 *
 * NOT DEPLOYABLE YET: this consults the provider-budget table, which does not
 * exist on the real application database. The limiter fails closed without it
 * (the routes answer a generic 500), so the table must be applied and verified
 * BEFORE any code that imports this module is deployed.
 */
export const TURNKEY_RECONCILE_POLICIES: readonly ProviderBudgetPolicy[] = Object.freeze([
  Object.freeze({ bucket: "turnkey_reconcile_short", limit: 20, windowSeconds: 600 } as const),
  Object.freeze({ bucket: "turnkey_reconcile_day", limit: 100, windowSeconds: 86_400 } as const),
]);

/** Longest window any turnkey-reconcile policy has: a retry delay beyond it cannot be real. */
const LONGEST_WINDOW_SECONDS = Math.max(...TURNKEY_RECONCILE_POLICIES.map((policy) => policy.windowSeconds));

/**
 * Friendly, jargon-free; shown only for a real budget denial of the signing
 * confirmation. Nothing was read and nothing changed, so trying again later is
 * exactly right.
 */
export const TURNKEY_RECONCILE_RATE_LIMITED_MESSAGE = "You're checking a bit often. Try again in a moment.";

/** Internal only: no bucket, count, or subject ever leaves the server. */
export type TurnkeyReconcileBudgetDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * Charges one provider-bound reconciliation to the authenticated account —
 * BOTH buckets, in one atomic limiter operation — and reports only allowed /
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
export async function consumeTurnkeyReconcileBudget(limiter: ProviderBudgetLimiter, appUserId: string): Promise<TurnkeyReconcileBudgetDecision> {
  const decision: unknown = await limiter.consume({ subject: appUserId, policies: TURNKEY_RECONCILE_POLICIES });
  if (typeof decision !== "object" || decision === null) throw new Error("Turnkey reconcile budget refused: unusable limiter answer.");
  const { allowed, retryAfterSeconds } = decision as { allowed?: unknown; retryAfterSeconds?: unknown };
  if (allowed === true) return { allowed: true };
  if (allowed === false && typeof retryAfterSeconds === "number" && Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds >= 1 && retryAfterSeconds <= LONGEST_WINDOW_SECONDS) {
    return { allowed: false, retryAfterSeconds };
  }
  throw new Error("Turnkey reconcile budget refused: unusable limiter answer.");
}
