import { describe, expect, it, vi } from "vitest";
import { classifyReceipt } from "@/lib/real/payments/reconcile";

const EXPECTED_HASH = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const SENDER = "0x2222222222222222222222222222222222222222" as const;

function receipt(overrides: Partial<Parameters<typeof classifyReceipt>[0]> = {}) {
  return {
    userOpHash: EXPECTED_HASH,
    sender: SENDER,
    success: true,
    receipt: { transactionHash: "0xabc" as const, status: "success" as const },
    ...overrides,
  };
}

describe("classifyReceipt", () => {
  it("confirms only when the hash, sender, success, and status all agree", () => {
    const outcome = classifyReceipt(receipt(), { userOperationHash: EXPECTED_HASH, sender: SENDER });
    expect(outcome).toEqual({ outcome: "confirmed", transactionHash: "0xabc" });
  });

  it("a reverted-but-otherwise-well-formed receipt is 'failed', not confirmed", () => {
    const outcome = classifyReceipt(receipt({ success: false, receipt: { transactionHash: "0xabc", status: "reverted" } }), {
      userOperationHash: EXPECTED_HASH,
      sender: SENDER,
    });
    expect(outcome).toEqual({ outcome: "failed", transactionHash: "0xabc" });
  });

  it("no receipt yet is unresolved, never treated as failure", () => {
    expect(classifyReceipt(null, { userOperationHash: EXPECTED_HASH, sender: SENDER })).toEqual({ outcome: "unresolved" });
  });

  it("a receipt for a different UserOperation hash is unresolved, never trusted as this payment's result", () => {
    const outcome = classifyReceipt(receipt({ userOpHash: "0x9999999999999999999999999999999999999999999999999999999999999999" }), {
      userOperationHash: EXPECTED_HASH,
      sender: SENDER,
    });
    expect(outcome).toEqual({ outcome: "unresolved" });
  });

  it("a receipt for a different sender is unresolved", () => {
    const outcome = classifyReceipt(receipt({ sender: "0x3333333333333333333333333333333333333333" }), {
      userOperationHash: EXPECTED_HASH,
      sender: SENDER,
    });
    expect(outcome).toEqual({ outcome: "unresolved" });
  });

  it("a malformed receipt (missing success/transactionHash/status) is unresolved, not confirmed or failed", () => {
    expect(
      classifyReceipt({ userOpHash: EXPECTED_HASH, sender: SENDER, success: undefined as unknown as boolean, receipt: { transactionHash: "0xabc", status: "success" } }, {
        userOperationHash: EXPECTED_HASH,
        sender: SENDER,
      }),
    ).toEqual({ outcome: "unresolved" });
  });
});

const fetchUserOperationReceiptMock = vi.fn();
vi.mock("@/lib/real/server/pimlico", () => ({
  prepareCashTransferUserOperation: vi.fn(),
  sendPreparedUserOperation: vi.fn(),
  fetchUserOperationReceipt: (...args: unknown[]) => fetchUserOperationReceiptMock(...(args as [never])),
}));

const { resolvePaymentStatus } = await import("@/lib/real/server/payments");
const { createInMemoryRealAccountRegistry } = await import("@/lib/real/server/registry");
const { createSessionPayload, serializeSession } = await import("@/lib/real/server/session");
const { createInMemoryPaymentAttemptStore } = await import("@/lib/real/server/payment-attempts");

const SECRET = "test-session-secret";

async function seedSubmittedAttempt() {
  const registry = createInMemoryRealAccountRegistry();
  await registry.createAccountWithPasskey({
    account: {
      appUserId: "app-user-1",
      subOrganizationId: "sub-org-1",
      turnkeyUserId: "turnkey-user-1",
      walletId: "wallet-1",
      walletAccountId: "wallet-account-1",
      ownerAddress: "0x1111111111111111111111111111111111111111",
      safeAddress: SENDER,
      accountConfigVersion: 1,
    },
    passkey: {
      credentialId: "credential-1",
      appUserId: "app-user-1",
      credentialPublicKey: "cose-key",
      userHandle: "user-handle-1",
      counter: 0,
      transports: ["internal"],
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
    },
  });

  const paymentStore = createInMemoryPaymentAttemptStore();
  const reserved = await paymentStore.reserve({
    appUserId: "app-user-1",
    safeAddress: SENDER,
    recipient: "0x4444444444444444444444444444444444444444",
    amountBaseUnits: "1000000",
    chainId: 84532,
    tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  });
  if (!reserved.ok) throw new Error("expected reservation to succeed");
  await paymentStore.transition({ id: reserved.attempt.id, from: "prepared", to: "awaiting_authorization", patch: { expectedUserOperationHash: EXPECTED_HASH } });
  await paymentStore.transition({ id: reserved.attempt.id, from: "awaiting_authorization", to: "signed" });
  await paymentStore.transition({ id: reserved.attempt.id, from: "signed", to: "submitted" });

  const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1" }), SECRET);
  return { registry, paymentStore, attemptId: reserved.attempt.id, cookieValue };
}

describe("resolvePaymentStatus", () => {
  it("reconciles a submitted attempt to confirmed using the precomputed expected hash, never a client-supplied one", async () => {
    fetchUserOperationReceiptMock.mockReset();
    const { registry, paymentStore, attemptId, cookieValue } = await seedSubmittedAttempt();
    fetchUserOperationReceiptMock.mockResolvedValueOnce(receipt());

    const outcome = await resolvePaymentStatus({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", attemptId });

    expect(outcome.outcome).toBe("ok");
    if (outcome.outcome !== "ok") return;
    expect(outcome.attempt.state).toBe("confirmed");
    expect(fetchUserOperationReceiptMock).toHaveBeenCalledWith(expect.objectContaining({ userOperationHash: EXPECTED_HASH }));
  });

  it("an unresolved receipt leaves the attempt exactly where it was — never guessed at", async () => {
    fetchUserOperationReceiptMock.mockReset();
    const { registry, paymentStore, attemptId, cookieValue } = await seedSubmittedAttempt();
    fetchUserOperationReceiptMock.mockResolvedValueOnce(null);

    const outcome = await resolvePaymentStatus({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", attemptId });

    expect(outcome.outcome).toBe("ok");
    if (outcome.outcome !== "ok") return;
    expect(outcome.attempt.state).toBe("submitted");
  });

  it("a receipt for a mismatched hash never confirms this attempt", async () => {
    fetchUserOperationReceiptMock.mockReset();
    const { registry, paymentStore, attemptId, cookieValue } = await seedSubmittedAttempt();
    fetchUserOperationReceiptMock.mockResolvedValueOnce(receipt({ userOpHash: "0x9999999999999999999999999999999999999999999999999999999999999999" }));

    const outcome = await resolvePaymentStatus({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", attemptId });

    expect(outcome.outcome).toBe("ok");
    if (outcome.outcome !== "ok") return;
    expect(outcome.attempt.state).toBe("submitted");
  });
});
