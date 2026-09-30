import { afterEach, describe, expect, it, vi } from "vitest";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import { createInMemoryChallengeStore } from "@/lib/real/server/challenge-store";
import { createNeonChallengeStore } from "@/lib/real/server/neon-store";

describe("createInMemoryChallengeStore", () => {
  it("consumes a freshly created challenge exactly once", async () => {
    const store = createInMemoryChallengeStore();
    await store.create({ challenge: "abc", purpose: "registration", ttlMs: 60_000 });

    const first = await store.consume({ challenge: "abc", purpose: "registration" });
    expect(first?.challenge).toBe("abc");

    const second = await store.consume({ challenge: "abc", purpose: "registration" });
    expect(second).toBeNull();
  });

  it("rejects a wrong-purpose consume, and the challenge is still burned afterward (never retryable)", async () => {
    const store = createInMemoryChallengeStore();
    await store.create({ challenge: "abc", purpose: "registration", ttlMs: 60_000 });

    const wrongPurpose = await store.consume({ challenge: "abc", purpose: "login" });
    expect(wrongPurpose).toBeNull();

    const rightPurposeAfter = await store.consume({ challenge: "abc", purpose: "registration" });
    expect(rightPurposeAfter).toBeNull();
  });

  it("rejects an expired challenge", async () => {
    const store = createInMemoryChallengeStore();
    await store.create({ challenge: "abc", purpose: "login", ttlMs: -1 });

    const result = await store.consume({ challenge: "abc", purpose: "login" });
    expect(result).toBeNull();
  });

  it("rejects an unknown challenge", async () => {
    const store = createInMemoryChallengeStore();
    const result = await store.consume({ challenge: "never-created", purpose: "login" });
    expect(result).toBeNull();
  });

  it("carries opaque context from create through to consume", async () => {
    const store = createInMemoryChallengeStore();
    await store.create({ challenge: "abc", purpose: "registration", ttlMs: 60_000, context: { appUserId: "user-1" } });

    const result = await store.consume({ challenge: "abc", purpose: "registration" });
    expect(result?.context).toEqual({ appUserId: "user-1" });
  });

  it("keeps two challenges independent", async () => {
    const store = createInMemoryChallengeStore();
    await store.create({ challenge: "one", purpose: "registration", ttlMs: 60_000 });
    await store.create({ challenge: "two", purpose: "login", ttlMs: 60_000 });

    expect(await store.consume({ challenge: "one", purpose: "registration" })).not.toBeNull();
    expect(await store.consume({ challenge: "two", purpose: "login" })).not.toBeNull();
  });

  it("atomic consume: two concurrent consume attempts for the same challenge — exactly one succeeds, the other is rejected as a replay", async () => {
    const store = createInMemoryChallengeStore();
    await store.create({ challenge: "race", purpose: "registration", ttlMs: 60_000 });

    const [first, second] = await Promise.all([
      store.consume({ challenge: "race", purpose: "registration" }),
      store.consume({ challenge: "race", purpose: "registration" }),
    ]);

    const results = [first, second];
    const succeeded = results.filter((result) => result !== null);
    const rejected = results.filter((result) => result === null);
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(succeeded[0]?.challenge).toBe("race");

    // Never retryable afterward, even though one of the racers "won".
    expect(await store.consume({ challenge: "race", purpose: "registration" })).toBeNull();
  });
});

describe("S4: opportunistic expired-challenge cleanup on create", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("in-memory: creating a challenge purges already-expired rows and keeps live ones", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    vi.setSystemTime(t0);
    const store = createInMemoryChallengeStore();
    await store.create({ challenge: "short", purpose: "login", ttlMs: 1_000 });
    await store.create({ challenge: "long", purpose: "login", ttlMs: 60_000 });

    vi.setSystemTime(t0 + 5_000); // "short" is now expired, "long" is live
    await store.create({ challenge: "trigger", purpose: "registration", ttlMs: 60_000 });

    // Rewind the clock: had "short" merely been left in place, it would be
    // consumable again here. It was purged, so it is simply unknown.
    vi.setSystemTime(t0);
    expect(await store.consume({ challenge: "short", purpose: "login" })).toBeNull();
    expect((await store.consume({ challenge: "long", purpose: "login" }))?.challenge).toBe("long");
    expect((await store.consume({ challenge: "trigger", purpose: "registration" }))?.challenge).toBe("trigger");
  });

  it("in-memory: a challenge exactly at its expiry instant is not purged (consume accepts it too)", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    vi.setSystemTime(t0);
    const store = createInMemoryChallengeStore();
    await store.create({ challenge: "edge", purpose: "login", ttlMs: 1_000 });
    vi.setSystemTime(t0 + 1_000);
    await store.create({ challenge: "trigger", purpose: "login", ttlMs: 1_000 });
    expect((await store.consume({ challenge: "edge", purpose: "login" }))?.challenge).toBe("edge");
  });

  it("Neon: create is ONE statement that deletes only rows with expires_at before now, then inserts — no scheduled job, entropy/consume unchanged", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-01T00:00:00Z");
    vi.setSystemTime(now);
    const calls: { text: string; values: unknown[] }[] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join("$?").replace(/\s+/g, " ").trim(), values });
      return Promise.resolve([]);
    }) as unknown as NeonQueryFunction<false, false>;

    await createNeonChallengeStore(sql).create({ challenge: "c1", purpose: "login", ttlMs: 300_000 });

    expect(calls).toHaveLength(1);
    const [{ text, values }] = calls as [{ text: string; values: unknown[] }];
    expect(text).toMatch(/^WITH purged AS \( DELETE FROM webauthn_challenges WHERE expires_at < \$\? \) INSERT INTO webauthn_challenges/);
    // The purge cutoff is "now" (strictly less-than); the new row expires at now + TTL.
    expect(values[0]).toBe(now.toISOString());
    expect(values).toContain(new Date(now.getTime() + 300_000).toISOString());
    // The purge touches expired rows only — no other predicate, no purpose filter, no live rows.
    expect(text).not.toMatch(/DELETE FROM webauthn_challenges WHERE (?!expires_at < \$\? \))/);
  });
});
