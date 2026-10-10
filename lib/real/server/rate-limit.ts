/**
 * Handle Pay Slice E — per-account abuse limiting for the surfaces that can be
 * used to probe who has a handle, and for payment prepare. SERVER-ONLY.
 *
 * It changes no payment authority: it only decides whether a request may go
 * on to do its protected work (the recipient read, the availability read, the
 * balance / block RPCs, the reservation, Pimlico).
 *
 * SUBJECT: always the authenticated account's app_user_id. A budget is never
 * keyed by — and the limiter is never told — the handle, account, Safe, or
 * display name being looked up or paid, nor a session id or an IP address.
 *
 * ALGORITHM: a first-request-anchored FIXED WINDOW per (bucket, subject). The
 * first request opens the window; requests inside it increment the count; the
 * first request after it has elapsed opens a new one. A denied request never
 * moves the window, and the stored count is capped at limit + 1. (A fixed
 * window can let up to about 2x the limit through around a boundary — accepted.)
 *
 * ONE DECISION PER REQUEST: every bucket that applies to a request is charged
 * in ONE store operation, in byte order of bucket name, and the request is
 * allowed only if every bucket is within its limit. A denied request has
 * still been charged to all of its buckets.
 *
 * FAIL CLOSED: a store that throws, or that answers anything but exactly one
 * state per charged bucket, makes consume() throw — the route's generic 500.
 * A request is never let through because the limiter could not be consulted.
 * The real_rate_limits table (schema.sql) must therefore exist before this
 * code is deployed, and production never runs on the in-memory store
 * (runtime.ts).
 *
 * NOT IN THIS SLICE: per-IP or global limits. These endpoints are
 * authenticated, so resistance to many accounts (Sybil) belongs at
 * registration; this slice does not by itself make a public deployment ready.
 */
export const RATE_LIMIT_BUCKETS = ["pay_prepare_day", "pay_prepare_short", "recipient_probe_day", "recipient_probe_short"] as const;
export type RateLimitBucket = (typeof RATE_LIMIT_BUCKETS)[number];

export type RateLimitPolicy = { readonly bucket: RateLimitBucket; readonly limit: number; readonly windowSeconds: number };

const TEN_MINUTES_SECONDS = 10 * 60;
const ONE_DAY_SECONDS = 24 * 60 * 60;

/** The four budgets. Limits are per authenticated account. */
export const RATE_LIMIT_POLICIES: { readonly [B in RateLimitBucket]: RateLimitPolicy & { readonly bucket: B } } = {
  recipient_probe_short: { bucket: "recipient_probe_short", limit: 20, windowSeconds: TEN_MINUTES_SECONDS },
  recipient_probe_day: { bucket: "recipient_probe_day", limit: 100, windowSeconds: ONE_DAY_SECONDS },
  pay_prepare_short: { bucket: "pay_prepare_short", limit: 20, windowSeconds: TEN_MINUTES_SECONDS },
  pay_prepare_day: { bucket: "pay_prepare_day", limit: 100, windowSeconds: ONE_DAY_SECONDS },
};

/** Recipient lookup, and the handle-claim options (availability) step: anything that answers "does this @name exist". */
export const RECIPIENT_PROBE_POLICIES: readonly RateLimitPolicy[] = [RATE_LIMIT_POLICIES.recipient_probe_short, RATE_LIMIT_POLICIES.recipient_probe_day];
/** A direct-address payment prepare. */
export const ADDRESS_PREPARE_POLICIES: readonly RateLimitPolicy[] = [RATE_LIMIT_POLICIES.pay_prepare_short, RATE_LIMIT_POLICIES.pay_prepare_day];
/** A handle payment prepare is both a payment prepare and a handle probe (its refusals tell found from not-found). */
export const HANDLE_PREPARE_POLICIES: readonly RateLimitPolicy[] = [...RECIPIENT_PROBE_POLICIES, ...ADDRESS_PREPARE_POLICIES];

/** What a store reports for one charged bucket: the count AFTER this request, and the whole seconds until its window ends (by the store's own clock). */
export type RateLimitBucketState = { bucket: string; hits: number; secondsUntilReset: number };

/**
 * The persistence seam. `policies` arrives already validated, de-duplicated,
 * and sorted (normalizeRateLimitPolicies); the store charges every one of them
 * as ONE atomic operation and reports each bucket's resulting state.
 */
export interface RateLimitStore {
  consume(input: { subject: string; policies: readonly RateLimitPolicy[] }): Promise<RateLimitBucketState[]>;
}

/** Internal only. Routes turn a denial into a 429 carrying Retry-After; no bucket, count, or subject ever leaves the server. */
export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface RateLimiter {
  consume(input: { subject: string; policies: readonly RateLimitPolicy[] }): Promise<RateLimitDecision>;
}

const isKnownBucket = (value: unknown): value is RateLimitBucket => typeof value === "string" && (RATE_LIMIT_BUCKETS as readonly string[]).includes(value);
const isPositiveInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

/** Byte order — the same order Postgres gives `COLLATE "C"`, which is how the Neon statement orders its rows. */
const byBucket = (a: { bucket: string }, b: { bucket: string }) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0);

/**
 * Callers may list policies in any order; every store sees them in ONE
 * canonical order, so concurrent requests take their row locks identically.
 * Anything questionable is refused outright (fail closed) rather than
 * repaired: no policies, an unknown bucket, a non-positive or fractional
 * limit / window, or the same bucket twice (a duplicate would otherwise be
 * charged twice or silently dropped).
 */
export function normalizeRateLimitPolicies(policies: readonly RateLimitPolicy[]): RateLimitPolicy[] {
  if (!Array.isArray(policies) || policies.length === 0) throw new Error("Rate limit refused: no policy was given.");
  const seen = new Set<string>();
  const normalized: RateLimitPolicy[] = [];
  for (const policy of policies) {
    if (!policy || !isKnownBucket(policy.bucket)) throw new Error("Rate limit refused: unknown bucket.");
    if (!isPositiveInt(policy.limit) || !isPositiveInt(policy.windowSeconds)) throw new Error("Rate limit refused: a limit and a window must be positive whole numbers.");
    if (seen.has(policy.bucket)) throw new Error("Rate limit refused: the same bucket was named twice.");
    seen.add(policy.bucket);
    normalized.push({ bucket: policy.bucket, limit: policy.limit, windowSeconds: policy.windowSeconds });
  }
  return normalized.sort(byBucket);
}

/**
 * The request-level decision. Allowed only if EVERY charged bucket is within
 * its limit. When denied, Retry-After is the LONGEST wait among the exceeded
 * buckets — all of them must recover before the same kind of request can
 * succeed — as a whole number of seconds, at least 1. Which bucket denied is
 * not reported.
 */
export function decideRateLimit(policies: readonly RateLimitPolicy[], states: readonly RateLimitBucketState[]): RateLimitDecision {
  if (!Array.isArray(states) || states.length !== policies.length) throw new Error("Rate limit refused: the store did not report every bucket.");
  let retryAfterSeconds = 0;
  for (const policy of policies) {
    const matching = states.filter((state) => state.bucket === policy.bucket);
    if (matching.length !== 1) throw new Error("Rate limit refused: the store did not report every bucket.");
    const { hits, secondsUntilReset } = matching[0]!;
    if (!isPositiveInt(hits) || typeof secondsUntilReset !== "number" || !Number.isFinite(secondsUntilReset)) throw new Error("Rate limit refused: the store reported an unusable bucket state.");
    if (hits > policy.limit) retryAfterSeconds = Math.max(retryAfterSeconds, Math.max(1, Math.ceil(secondsUntilReset)));
  }
  return retryAfterSeconds === 0 ? { allowed: true } : { allowed: false, retryAfterSeconds };
}

export function createRateLimiter(store: RateLimitStore): RateLimiter {
  return {
    async consume({ subject, policies }) {
      if (typeof subject !== "string" || subject === "") throw new Error("Rate limit refused: no subject.");
      const normalized = normalizeRateLimitPolicies(policies);
      return decideRateLimit(normalized, await store.consume({ subject, policies: normalized }));
    },
  };
}

/**
 * Unit tests and local development ONLY — one process, lost on restart, and
 * never selected in production (runtime.ts fails closed without a database).
 * Same semantics as the Neon statement: first-request-anchored fixed window,
 * the count capped at limit + 1, a denied request never moving the window,
 * and one synchronous pass over all of a request's buckets. `nowMs` is
 * injectable so tests control time.
 */
export function createInMemoryRateLimitStore(nowMs: () => number = Date.now): RateLimitStore {
  const rows = new Map<string, { windowStartMs: number; hits: number }>();
  return {
    async consume({ subject, policies }) {
      const now = nowMs();
      return policies.map((policy) => {
        const key = JSON.stringify([policy.bucket, subject]);
        const windowMs = policy.windowSeconds * 1000;
        const current = rows.get(key);
        const next =
          !current || current.windowStartMs + windowMs <= now
            ? { windowStartMs: now, hits: 1 }
            : { windowStartMs: current.windowStartMs, hits: Math.min(current.hits + 1, policy.limit + 1) };
        rows.set(key, next);
        return { bucket: policy.bucket, hits: next.hits, secondsUntilReset: Math.max(1, Math.ceil((next.windowStartMs + windowMs - now) / 1000)) };
      });
    },
  };
}
