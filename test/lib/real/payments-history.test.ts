import { describe, expect, it } from "vitest";
import { createInMemoryRealAccountRegistry } from "@/lib/real/server/registry";
import { createSessionPayload, serializeSession } from "@/lib/real/server/session";
import { createInMemoryPaymentAttemptStore, type PaymentAttempt, type PaymentAttemptStore } from "@/lib/real/server/payment-attempts";
import { clampHistoryLimit, resolvePaymentHistory, toPaymentHistoryEntry } from "@/lib/real/server/payment-history";

const SECRET = "test-session-secret";

async function seedAccount(registry: ReturnType<typeof createInMemoryRealAccountRegistry>, appUserId: string, credentialId: string) {
  await registry.createAccountWithPasskey({
    account: {
      appUserId,
      subOrganizationId: `sub-org-${appUserId}`,
      turnkeyUserId: `turnkey-user-${appUserId}`,
      walletId: `wallet-${appUserId}`,
      walletAccountId: `wallet-account-${appUserId}`,
      // S5 L2: every seeded account has its own owner/Safe (unique identity).
      ownerAddress: appUserId === "app-user-1" ? "0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF" : "0x2222222222222222222222222222222222222201",
      safeAddress: appUserId === "app-user-1" ? "0xd9a4c22fb34dc74317edc8006140d66c8fa03266" : "0x2222222222222222222222222222222222222202",
      accountConfigVersion: 1,
    },
    passkey: {
      credentialId,
      appUserId,
      credentialPublicKey: "cose-key",
      userHandle: `user-handle-${appUserId}`,
      counter: 0,
      transports: ["internal"],
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
    },
  });
}

function cookieFor(appUserId: string, credentialId: string) {
  return serializeSession(createSessionPayload({ appUserId, credentialId, sessionEpoch: 0 }), SECRET);
}

async function reserveAndAdvance(
  store: ReturnType<typeof createInMemoryPaymentAttemptStore>,
  appUserId: string,
  finalState: PaymentAttempt["state"],
  patch: Partial<PaymentAttempt> = {},
) {
  const reserved = await store.reserve({
    appUserId,
    safeAddress: "0xd9a4c22fb34dc74317edc8006140d66c8fa03266",
    recipient: "0x2222222222222222222222222222222222222222",
    amountBaseUnits: "1000000",
    chainId: 84532,
    tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    authorizingCredentialId: "credential-1",
  });
  if (!reserved.ok) throw new Error("expected reservation to succeed");
  if (finalState === "prepared") return reserved.attempt;
  await store.transition({ id: reserved.attempt.id, from: "prepared", to: "awaiting_authorization" });
  if (finalState === "awaiting_authorization") return (await store.findById(reserved.attempt.id))!;
  await store.transition({ id: reserved.attempt.id, from: "awaiting_authorization", to: finalState, patch });
  return (await store.findById(reserved.attempt.id))!;
}

describe("resolvePaymentHistory", () => {
  it("rejects an unauthenticated request", async () => {
    const registry = createInMemoryRealAccountRegistry();
    const paymentStore = createInMemoryPaymentAttemptStore();
    const result = await resolvePaymentHistory({ cookieValue: undefined, sessionSecret: SECRET, registry, paymentStore, limitInput: undefined });
    expect(result).toEqual({ outcome: "unauthenticated" });
  });

  it("only returns the authenticated account's own attempts, never another account's", async () => {
    const registry = createInMemoryRealAccountRegistry();
    await seedAccount(registry, "app-user-1", "credential-1");
    await seedAccount(registry, "app-user-2", "credential-2");
    const paymentStore = createInMemoryPaymentAttemptStore();
    const mine = await reserveAndAdvance(paymentStore, "app-user-1", "cancelled");
    const theirs = await reserveAndAdvance(paymentStore, "app-user-2", "cancelled");

    const cookieValue = cookieFor("app-user-1", "credential-1");
    const result = await resolvePaymentHistory({ cookieValue, sessionSecret: SECRET, registry, paymentStore, limitInput: undefined });

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    // Not just a length assertion — proves the auth->store wiring resolves
    // to the AUTHENTICATED account's own attempt specifically, and that the
    // other account's attempt id never leaks through.
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.id).toBe(mine.id);
    expect(result.entries.some((entry) => entry.id === theirs.id)).toBe(false);
  });

  it("returns entries newest-first", async () => {
    const registry = createInMemoryRealAccountRegistry();
    await seedAccount(registry, "app-user-1", "credential-1");
    const paymentStore = createInMemoryPaymentAttemptStore();
    const first = await reserveAndAdvance(paymentStore, "app-user-1", "cancelled");
    const second = await reserveAndAdvance(paymentStore, "app-user-1", "cancelled");

    const cookieValue = cookieFor("app-user-1", "credential-1");
    const result = await resolvePaymentHistory({ cookieValue, sessionSecret: SECRET, registry, paymentStore, limitInput: undefined });

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.entries.map((e) => e.id)).toEqual([second.id, first.id]);
  });

  // These two tests assert the exact limit resolvePaymentHistory PASSES to
  // the store, via a minimal fake rather than the real rate-limited
  // in-memory adapter — reserving 15-30 real attempts for one account would
  // collide with PAYMENT_RATE_LIMIT (10/hour, 30/day), which has nothing to
  // do with what's under test here (limit parsing/clamping).
  function fakeStoreRecordingLimit(recorded: { limit?: number }): PaymentAttemptStore {
    return {
      reserve: async () => {
        throw new Error("not used by resolvePaymentHistory");
      },
      reserveHandlePayment: async () => {
        throw new Error("not used by resolvePaymentHistory");
      },
      findById: async () => null,
      findLatestByAppUserId: async () => null,
      transition: async () => null,
      beginDispatch: async () => null,
      findRecentByAppUserId: async ({ limit }) => {
        recorded.limit = limit;
        return [];
      },
    };
  }

  it("defaults to a limit of 10 when omitted", async () => {
    const registry = createInMemoryRealAccountRegistry();
    await seedAccount(registry, "app-user-1", "credential-1");
    const recorded: { limit?: number } = {};
    const cookieValue = cookieFor("app-user-1", "credential-1");

    await resolvePaymentHistory({ cookieValue, sessionSecret: SECRET, registry, paymentStore: fakeStoreRecordingLimit(recorded), limitInput: undefined });

    expect(recorded.limit).toBe(10);
  });

  it("clamps a requested limit above the hard max (25) rather than rejecting it", async () => {
    const registry = createInMemoryRealAccountRegistry();
    await seedAccount(registry, "app-user-1", "credential-1");
    const recorded: { limit?: number } = {};
    const cookieValue = cookieFor("app-user-1", "credential-1");

    await resolvePaymentHistory({ cookieValue, sessionSecret: SECRET, registry, paymentStore: fakeStoreRecordingLimit(recorded), limitInput: "999" });

    expect(recorded.limit).toBe(25);
  });

  it("a confirmed attempt's entry includes its transaction hash", async () => {
    const registry = createInMemoryRealAccountRegistry();
    await seedAccount(registry, "app-user-1", "credential-1");
    const paymentStore = createInMemoryPaymentAttemptStore();
    await reserveAndAdvance(paymentStore, "app-user-1", "confirmed", { transactionHash: "0xtxhash" });

    const cookieValue = cookieFor("app-user-1", "credential-1");
    const result = await resolvePaymentHistory({ cookieValue, sessionSecret: SECRET, registry, paymentStore, limitInput: undefined });

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.entries[0]).toMatchObject({ state: "confirmed", transactionHash: "0xtxhash" });
  });

  it("cancelled/failed/unknown states are reported truthfully, not remapped", async () => {
    const registry = createInMemoryRealAccountRegistry();
    await seedAccount(registry, "app-user-1", "credential-1");
    const paymentStore = createInMemoryPaymentAttemptStore();
    await reserveAndAdvance(paymentStore, "app-user-1", "cancelled");

    const cookieValue = cookieFor("app-user-1", "credential-1");
    const result = await resolvePaymentHistory({ cookieValue, sessionSecret: SECRET, registry, paymentStore, limitInput: undefined });

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.entries[0]?.state).toBe("cancelled");
  });
});

describe("clampHistoryLimit", () => {
  it("defaults to 10 for missing, non-numeric, zero, or negative input", () => {
    expect(clampHistoryLimit(undefined)).toBe(10);
    expect(clampHistoryLimit(null)).toBe(10);
    expect(clampHistoryLimit("abc")).toBe(10);
    expect(clampHistoryLimit("0")).toBe(10);
    expect(clampHistoryLimit("-5")).toBe(10);
  });

  it("passes through a valid value within bounds", () => {
    expect(clampHistoryLimit("3")).toBe(3);
  });

  it("clamps anything above 25 down to 25", () => {
    expect(clampHistoryLimit("100")).toBe(25);
  });

  it("truncates a decimal string, matching parseInt semantics", () => {
    expect(clampHistoryLimit("3.9")).toBe(3);
  });

  it("tolerates surrounding whitespace", () => {
    expect(clampHistoryLimit(" 5 ")).toBe(5);
  });
});

describe("toPaymentHistoryEntry — data minimization", () => {
  it("exposes exactly the minimal public fields, even when the source attempt has gas/paymaster/calldata/nonce/signing-adjacent fields populated", () => {
    const attempt: PaymentAttempt = {
      id: "payment-attempt-1",
      appUserId: "app-user-1",
      safeAddress: "0xd9a4c22fb34dc74317edc8006140d66c8fa03266",
      recipient: "0x2222222222222222222222222222222222222222",
      amountBaseUnits: "1000000",
      chainId: 84532,
      tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      state: "confirmed",
      nonce: "0",
      callData: "0xcalldata",
      factory: "0xfactory",
      factoryData: "0xfactorydata",
      callGasLimit: "80000",
      verificationGasLimit: "150000",
      preVerificationGas: "60000",
      maxFeePerGas: "2000000",
      maxPriorityFeePerGas: "1000000",
      paymaster: "0xpaymaster",
      paymasterData: "0xpaymasterdata",
      paymasterVerificationGasLimit: "100000",
      paymasterPostOpGasLimit: "50000",
      expectedUserOperationHash: "0xexpectedhash",
      validUntil: 1_900_000_600,
      prepareBlockNumber: "47000000",
      authorizingCredentialId: "credential-1",
      // Slice B's server-only recipient identity snapshot — populated here so the assertion below proves it never reaches a history entry.
      recipientAppUserId: "app-user-2",
      recipientHandle: "maya_chen",
      recipientDisplayName: "Maya Chen",
      turnkeySignActivityId: "turnkey-activity-1",
      authorizationVerifiedAt: "2026-01-01T00:00:03.000Z",
      transactionHash: "0xtxhash",
      failureReason: "internal bundler diagnostic text",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:05.000Z",
    };

    const entry = toPaymentHistoryEntry(attempt);

    expect(Object.keys(entry).sort()).toEqual(["amountBaseUnits", "createdAt", "id", "recipient", "state", "transactionHash", "updatedAt"].sort());
    expect(entry).toEqual({
      id: "payment-attempt-1",
      recipient: "0x2222222222222222222222222222222222222222",
      amountBaseUnits: "1000000",
      state: "confirmed",
      transactionHash: "0xtxhash",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:05.000Z",
    });
    // Handle Pay Slice B: the recipient identity snapshot is server-only. History is Slice D's work, not this one's.
    expect(JSON.stringify(entry)).not.toMatch(/app-user-2|maya_chen|Maya Chen|recipientAppUserId|recipientHandle|recipientDisplayName/);
  });
});
