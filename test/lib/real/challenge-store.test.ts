import { describe, expect, it } from "vitest";
import { createInMemoryChallengeStore } from "@/lib/real/server/challenge-store";

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
