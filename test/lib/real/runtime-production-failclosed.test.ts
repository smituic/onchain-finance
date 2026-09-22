import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pre-2f hardening: lib/real/server/runtime.ts previously fell back to
 * fully in-memory, single-process stores whenever DATABASE_URL was unset,
 * with no NODE_ENV check at all — a misconfigured production deployment
 * would silently run non-durably. It now fails closed (throws) when
 * NODE_ENV is "production" and DATABASE_URL is absent.
 *
 * runtime.ts holds module-level mutable singletons (registry, etc.), so
 * each scenario needs vi.resetModules() + a fresh dynamic import — reusing
 * the same module instance across cases would let one test's cached store
 * leak into the next.
 */
describe("runtime.ts — production fails closed without DATABASE_URL", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("NODE_ENV=production with no DATABASE_URL: every getter throws a clear configuration error", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "");
    const runtime = await import("@/lib/real/server/runtime");

    expect(() => runtime.getRealAccountRegistry()).toThrow(/DATABASE_URL/);
    expect(() => runtime.getPaymentAttemptStore()).toThrow(/DATABASE_URL/);
    expect(() => runtime.getChallengeStore()).toThrow(/DATABASE_URL/);
    expect(() => runtime.getRegistrationAttemptStore()).toThrow(/DATABASE_URL/);
  });

  it("NODE_ENV=production with DATABASE_URL set: no throw (Neon adapter construction doesn't eagerly connect)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgres://user:pass@example-host/db");
    const runtime = await import("@/lib/real/server/runtime");

    expect(() => runtime.getRealAccountRegistry()).not.toThrow();
    expect(() => runtime.getPaymentAttemptStore()).not.toThrow();
  });

  it("NODE_ENV=test (or any non-production) with no DATABASE_URL: unchanged silent in-memory fallback", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DATABASE_URL", "");
    const runtime = await import("@/lib/real/server/runtime");

    expect(() => runtime.getRealAccountRegistry()).not.toThrow();
    expect(() => runtime.getPaymentAttemptStore()).not.toThrow();
  });

  it("NODE_ENV unset with no DATABASE_URL: unchanged silent in-memory fallback (development default)", async () => {
    vi.stubEnv("NODE_ENV", undefined);
    vi.stubEnv("DATABASE_URL", "");
    const runtime = await import("@/lib/real/server/runtime");

    expect(() => runtime.getRealAccountRegistry()).not.toThrow();
  });
});
