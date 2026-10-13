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
 *
 * PROVIDER BUDGETS (Milestone 3, Slice 3A-0 — the second half of this file):
 * a SIBLING limiter for requests that make the server call a provider. Same
 * subject, algorithm, one-decision rule, and fail-closed behaviour, but its own
 * six buckets, its own store type, and its own table (real_provider_budgets).
 * The two never mix: each limiter refuses the other's bucket names. It is
 * FOUNDATION ONLY — no numeric limit is approved, nothing here names one, and
 * no route consults it yet.
 */
export const RATE_LIMIT_BUCKETS = ["pay_prepare_day", "pay_prepare_short", "recipient_probe_day", "recipient_probe_short"] as const;
export type RateLimitBucket = (typeof RATE_LIMIT_BUCKETS)[number];

/** One fixed-window budget: at most `limit` requests per `windowSeconds` in `bucket`. */
type WindowPolicy<B extends string> = { readonly bucket: B; readonly limit: number; readonly windowSeconds: number };

export type RateLimitPolicy = WindowPolicy<RateLimitBucket>;

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

const RATE_LIMIT_REFUSED = "Rate limit refused";
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
  return normalizePolicies(RATE_LIMIT_REFUSED, RATE_LIMIT_BUCKETS, policies);
}

/** Shared by both limiters; `allowed` is the ONE bucket list this limiter may charge, and `refused` prefixes its errors. */
function normalizePolicies<B extends string>(refused: string, allowed: readonly B[], policies: readonly WindowPolicy<B>[]): WindowPolicy<B>[] {
  if (!Array.isArray(policies) || policies.length === 0) throw new Error(`${refused}: no policy was given.`);
  const seen = new Set<string>();
  const normalized: WindowPolicy<B>[] = [];
  for (const policy of policies) {
    if (!policy || typeof policy.bucket !== "string" || !(allowed as readonly string[]).includes(policy.bucket)) throw new Error(`${refused}: unknown bucket.`);
    if (!isPositiveInt(policy.limit) || !isPositiveInt(policy.windowSeconds)) throw new Error(`${refused}: a limit and a window must be positive whole numbers.`);
    if (seen.has(policy.bucket)) throw new Error(`${refused}: the same bucket was named twice.`);
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
  return decide(RATE_LIMIT_REFUSED, policies, states);
}

function decide(refused: string, policies: readonly WindowPolicy<string>[], states: readonly RateLimitBucketState[]): RateLimitDecision {
  if (!Array.isArray(states) || states.length !== policies.length) throw new Error(`${refused}: the store did not report every bucket.`);
  let retryAfterSeconds = 0;
  for (const policy of policies) {
    const matching = states.filter((state) => state.bucket === policy.bucket);
    if (matching.length !== 1) throw new Error(`${refused}: the store did not report every bucket.`);
    const { hits, secondsUntilReset } = matching[0]!;
    if (!isPositiveInt(hits) || typeof secondsUntilReset !== "number" || !Number.isFinite(secondsUntilReset)) throw new Error(`${refused}: the store reported an unusable bucket state.`);
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
  return createInMemoryWindowStore(nowMs);
}

/** One private set of rows per call. `allowed`, when given, plays the table's bucket CHECK: a bucket outside it throws before anything is charged. */
function createInMemoryWindowStore(nowMs: () => number, allowed?: readonly string[]) {
  const rows = new Map<string, { windowStartMs: number; hits: number }>();
  return {
    async consume({ subject, policies }: { subject: string; policies: readonly WindowPolicy<string>[] }): Promise<RateLimitBucketState[]> {
      if (allowed && policies.some((policy) => !allowed.includes(policy.bucket))) throw new Error("In-memory budget store refused: a bucket outside this store's list.");
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

/**
 * PROVIDER BUDGETS — Milestone 3, Slice 3A-0. FOUNDATION ONLY.
 *
 * Three families of provider-backed work, each with a short and a daily bucket:
 *   chain_read          reads that make the server call the chain RPC
 *   turnkey_reconcile   reconciliation that makes the server read Turnkey
 *   pay_submit          a payment submit
 *
 * NO NUMERIC LIMIT IS APPROVED. This module deliberately exports no provider
 * budget policy table: a caller has to pass each bucket's limit and window, and
 * no caller exists yet. No route, and no server module, consults this limiter.
 *
 * Everything else is the limiter above, unchanged in meaning: the subject is
 * the authenticated account's app_user_id; one store operation charges every
 * bucket of a request in byte order; the request is admitted only if every
 * bucket is within its limit; a denied request has still been charged; nothing
 * is ever refunded (there is no operation that lowers a count); and a store
 * that throws or mis-reports makes consume() throw, so the caller must do no
 * provider work.
 *
 * SEPARATE FROM THE SLICE E LIMITER: these six names are accepted only here
 * and stored only in real_provider_budgets (schema.sql); the four Slice E names
 * are refused here, as these are refused there.
 */
export const PROVIDER_BUDGET_FAMILIES = ["chain_read", "pay_submit", "turnkey_reconcile"] as const;
export type ProviderBudgetFamily = (typeof PROVIDER_BUDGET_FAMILIES)[number];

export const PROVIDER_BUDGET_BUCKETS = ["chain_read_day", "chain_read_short", "pay_submit_day", "pay_submit_short", "turnkey_reconcile_day", "turnkey_reconcile_short"] as const;
export type ProviderBudgetBucket = (typeof PROVIDER_BUDGET_BUCKETS)[number];

export type ProviderBudgetPolicy = WindowPolicy<ProviderBudgetBucket>;

/** Same seam as RateLimitStore, for the sibling table. */
export interface ProviderBudgetStore {
  consume(input: { subject: string; policies: readonly ProviderBudgetPolicy[] }): Promise<RateLimitBucketState[]>;
}

export interface ProviderBudgetLimiter {
  consume(input: { subject: string; policies: readonly ProviderBudgetPolicy[] }): Promise<RateLimitDecision>;
}

const PROVIDER_BUDGET_REFUSED = "Provider budget refused";

/**
 * normalizeRateLimitPolicies' rules against the six provider buckets, plus one:
 * a family is always charged on BOTH its short and its daily bucket, so a
 * request can never be admitted on one window while skipping the other.
 */
export function normalizeProviderBudgetPolicies(policies: readonly ProviderBudgetPolicy[]): ProviderBudgetPolicy[] {
  const normalized = normalizePolicies(PROVIDER_BUDGET_REFUSED, PROVIDER_BUDGET_BUCKETS, policies);
  const named = new Set<string>(normalized.map((policy) => policy.bucket));
  for (const family of PROVIDER_BUDGET_FAMILIES) {
    if (named.has(`${family}_short`) !== named.has(`${family}_day`)) throw new Error(`${PROVIDER_BUDGET_REFUSED}: a family must be charged on both its short and its daily bucket.`);
  }
  return normalized;
}

export function createProviderBudgetLimiter(store: ProviderBudgetStore): ProviderBudgetLimiter {
  return {
    async consume({ subject, policies }) {
      if (typeof subject !== "string" || subject === "") throw new Error(`${PROVIDER_BUDGET_REFUSED}: no subject.`);
      const normalized = normalizeProviderBudgetPolicies(policies);
      return decide(PROVIDER_BUDGET_REFUSED, normalized, await store.consume({ subject, policies: normalized }));
    },
  };
}

/** Unit tests and local development ONLY, like createInMemoryRateLimitStore — its own rows, and only the six provider buckets. */
export function createInMemoryProviderBudgetStore(nowMs: () => number = Date.now): ProviderBudgetStore {
  return createInMemoryWindowStore(nowMs, PROVIDER_BUDGET_BUCKETS);
}
