import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createInMemoryPaymentAttemptStore, PAYMENT_RATE_LIMIT } from "@/lib/real/server/payment-attempts";

function reserveInput(appUserId = "app-user-1") {
  return {
    appUserId,
    safeAddress: "0x1111111111111111111111111111111111111111",
    recipient: "0x2222222222222222222222222222222222222222",
    amountBaseUnits: "1000000",
    chainId: 84532,
    tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  };
}

/** Reserve, then immediately resolve it to a terminal state so the next reserve() isn't blocked by "payment_in_progress" — isolates the quota check from the one-active-attempt check. */
async function reserveAndTerminate(store: ReturnType<typeof createInMemoryPaymentAttemptStore>, appUserId: string) {
  const reserved = await store.reserve(reserveInput(appUserId));
  if (!reserved.ok) return reserved;
  await store.transition({ id: reserved.attempt.id, from: "prepared", to: "cancelled" });
  return reserved;
}

describe("PaymentAttemptStore.reserve — quota and single-in-flight-attempt guarantees", () => {
  it(`allows exactly ${PAYMENT_RATE_LIMIT.perHour} reservations within an hour, then refuses with quota_exceeded`, async () => {
    const store = createInMemoryPaymentAttemptStore();
    for (let i = 0; i < PAYMENT_RATE_LIMIT.perHour; i += 1) {
      const result = await reserveAndTerminate(store, "app-user-1");
      expect(result.ok).toBe(true);
    }
    const eleventh = await store.reserve(reserveInput("app-user-1"));
    expect(eleventh).toEqual({ ok: false, reason: "quota_exceeded" });
  });

  it("a second reserve() while a non-terminal attempt exists returns payment_in_progress, not quota_exceeded", async () => {
    const store = createInMemoryPaymentAttemptStore();
    const first = await store.reserve(reserveInput());
    expect(first.ok).toBe(true);

    const second = await store.reserve(reserveInput());
    expect(second).toEqual({ ok: false, reason: "payment_in_progress" });
  });

  it("a confirmed/failed/cancelled attempt frees the slot for a new reserve()", async () => {
    const store = createInMemoryPaymentAttemptStore();
    const first = await store.reserve(reserveInput());
    if (!first.ok) throw new Error("expected reservation to succeed");
    await store.transition({ id: first.attempt.id, from: "prepared", to: "failed" });

    const second = await store.reserve(reserveInput());
    expect(second.ok).toBe(true);
  });

  it("quota and in-flight guards are per-account: a different account is never blocked by another's state", async () => {
    const store = createInMemoryPaymentAttemptStore();
    const mine = await store.reserve(reserveInput("app-user-1"));
    expect(mine.ok).toBe(true);

    const theirs = await store.reserve(reserveInput("app-user-2"));
    expect(theirs.ok).toBe(true);
  });

  it("concurrency contract: two simultaneous reserve() calls for the same account resolve with exactly one ok:true", async () => {
    const store = createInMemoryPaymentAttemptStore();
    const [first, second] = await Promise.all([store.reserve(reserveInput()), store.reserve(reserveInput())]);
    const successes = [first, second].filter((result) => result.ok);
    expect(successes).toHaveLength(1);
    const failure = [first, second].find((result) => !result.ok);
    expect(failure).toEqual({ ok: false, reason: "payment_in_progress" });
  });
});

describe("Neon reserve() stays a single atomic SQL statement — a structural guard against a future non-atomic regression", () => {
  it("createNeonPaymentAttemptStore's reserve() issues exactly one sql`...` call, never a separate count-then-insert pair", () => {
    const source = readFileSync(path.resolve(process.cwd(), "lib/real/server/neon-store.ts"), "utf8");
    const reserveStart = source.indexOf("async reserve(input)");
    expect(reserveStart).toBeGreaterThan(-1);
    // Slice from reserve() to the next store method (findById) and count
    // template-tagged `sql\`` invocations in the "happy path" try block —
    // there should be exactly one (the CTE) before any zero-row fallback
    // read, proving the reservation itself (quota check + slot check +
    // insert) is one round trip, not several.
    const nextMethodStart = source.indexOf("async findById(id) {", reserveStart);
    const reserveBody = source.slice(reserveStart, nextMethodStart);
    const happyPathBody = reserveBody.slice(0, reserveBody.indexOf("if (rows.length === 0)"));
    const sqlCallCount = (happyPathBody.match(/sql`/g) ?? []).length;
    expect(sqlCallCount).toBe(1);
    // And that one statement performs the lock + quota count + conditional
    // insert together.
    expect(reserveBody).toMatch(/pg_advisory_xact_lock/);
    expect(reserveBody).toMatch(/INSERT INTO payment_attempts/);
  });
});
