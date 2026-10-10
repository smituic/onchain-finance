import { createInMemoryRateLimitStore, createRateLimiter, type RateLimitDecision, type RateLimitPolicy, type RateLimiter } from "@/lib/real/server/rate-limit";

/**
 * TEST-ONLY limiters (Handle Pay Slice E). `freshRateLimiter` is the real
 * limiter over the in-memory store with the real policies — what every test
 * that isn't about rate limiting passes, so the production code path (charge,
 * then work) is always the one exercised.
 */
export const freshRateLimiter = (nowMs?: () => number): RateLimiter => createRateLimiter(createInMemoryRateLimitStore(nowMs));

export type RateLimitCharge = { subject: string; buckets: string[] };

/** Records every charge (subject + sorted bucket names — exactly what the limiter is told) and delegates to `inner`. */
export function recordingRateLimiter(inner: RateLimiter = freshRateLimiter()): { limiter: RateLimiter; charges: RateLimitCharge[]; inputs: { subject: string; policies: readonly RateLimitPolicy[] }[] } {
  const charges: RateLimitCharge[] = [];
  const inputs: { subject: string; policies: readonly RateLimitPolicy[] }[] = [];
  return {
    charges,
    inputs,
    limiter: {
      async consume(input) {
        inputs.push(input);
        charges.push({ subject: input.subject, buckets: input.policies.map((policy) => policy.bucket).sort() });
        return inner.consume(input);
      },
    },
  };
}

/** Always denies — for proving what a rate-limited request does NOT do. */
export const denyingRateLimiter = (retryAfterSeconds = 123): RateLimiter => ({ consume: async (): Promise<RateLimitDecision> => ({ allowed: false, retryAfterSeconds }) });

/** A limiter whose backend is down (e.g. the table is missing). The message is deliberately revealing, so tests can prove none of it leaks. */
export const failingRateLimiter = (): RateLimiter => ({
  consume: async () => {
    throw new Error('relation "real_rate_limits" does not exist — subject app-user-1 bucket recipient_probe_short');
  },
});
