import { describe, expect, it, vi } from "vitest";
import { createInMemoryRealAccountRegistry } from "@/lib/real/server/registry";
import { createSessionPayload, serializeSession } from "@/lib/real/server/session";
import { createInMemoryPaymentAttemptStore, type PaymentAttempt, type PaymentAttemptStore } from "@/lib/real/server/payment-attempts";
import { resolveCancelPayment } from "@/lib/real/server/payments";

const SECRET = "test-session-secret";
const OWNER_ADDRESS = "0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF";
const SAFE_ADDRESS = "0xd9a4c22fb34dc74317edc8006140d66c8fa03266";

async function seedAccount() {
  const registry = createInMemoryRealAccountRegistry();
  await registry.createAccountWithPasskey({
    account: {
      appUserId: "app-user-1",
      subOrganizationId: "sub-org-1",
      turnkeyUserId: "turnkey-user-1",
      walletId: "wallet-1",
      walletAccountId: "wallet-account-1",
      ownerAddress: OWNER_ADDRESS,
      safeAddress: SAFE_ADDRESS,
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
  return registry;
}

function cookieFor() {
  return serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);
}

async function reserveAttempt(paymentStore: PaymentAttemptStore): Promise<PaymentAttempt> {
  const reserved = await paymentStore.reserve({
    appUserId: "app-user-1",
    safeAddress: SAFE_ADDRESS,
    recipient: "0x2222222222222222222222222222222222222222",
    amountBaseUnits: "1000000",
    chainId: 84532,
    tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    authorizingCredentialId: "credential-1",
  });
  if (!reserved.ok) throw new Error("expected reservation to succeed");
  return reserved.attempt;
}

/** Pre-2f hardening: cancel now accepts prepared/awaiting_authorization/signed (previously only awaiting_authorization), and refuses submitting/submitted/unknown — see payments.ts's resolveCancelPayment doc comment for why. */
describe("resolveCancelPayment — cancellable state matrix (pre-2f hardening)", () => {
  it("cancels an attempt still in 'prepared'", async () => {
    const registry = await seedAccount();
    const paymentStore = createInMemoryPaymentAttemptStore();
    const attempt = await reserveAttempt(paymentStore);

    const outcome = await resolveCancelPayment({ cookieValue: cookieFor(), sessionSecret: SECRET, registry, paymentStore, attemptId: attempt.id });

    expect(outcome.outcome).toBe("cancelled");
  });

  it("cancels an attempt in 'awaiting_authorization' (the original, still-supported case)", async () => {
    const registry = await seedAccount();
    const paymentStore = createInMemoryPaymentAttemptStore();
    const attempt = await reserveAttempt(paymentStore);
    await paymentStore.transition({ id: attempt.id, from: "prepared", to: "awaiting_authorization" });

    const outcome = await resolveCancelPayment({ cookieValue: cookieFor(), sessionSecret: SECRET, registry, paymentStore, attemptId: attempt.id });

    expect(outcome.outcome).toBe("cancelled");
  });

  it("cancels an attempt in 'signed' — the new stranding-prevention case", async () => {
    const registry = await seedAccount();
    const paymentStore = createInMemoryPaymentAttemptStore();
    const attempt = await reserveAttempt(paymentStore);
    await paymentStore.transition({ id: attempt.id, from: "prepared", to: "awaiting_authorization" });
    await paymentStore.transition({ id: attempt.id, from: "awaiting_authorization", to: "signed" });

    const outcome = await resolveCancelPayment({ cookieValue: cookieFor(), sessionSecret: SECRET, registry, paymentStore, attemptId: attempt.id });

    expect(outcome.outcome).toBe("cancelled");
  });

  it.each(["submitting", "submitted", "unknown"] as const)("refuses to cancel an attempt in '%s' — the operation may already be on-chain", async (state) => {
    const registry = await seedAccount();
    const paymentStore = createInMemoryPaymentAttemptStore();
    const attempt = await reserveAttempt(paymentStore);
    await paymentStore.transition({ id: attempt.id, from: "prepared", to: "awaiting_authorization" });
    await paymentStore.transition({ id: attempt.id, from: "awaiting_authorization", to: "signed" });
    await paymentStore.transition({ id: attempt.id, from: "signed", to: "submitting" });
    if (state !== "submitting") {
      await paymentStore.transition({ id: attempt.id, from: "submitting", to: state });
    }

    const outcome = await resolveCancelPayment({ cookieValue: cookieFor(), sessionSecret: SECRET, registry, paymentStore, attemptId: attempt.id });

    expect(outcome.outcome).toBe("wrong_state");
    if (outcome.outcome === "wrong_state") expect(outcome.state).toBe(state);
  });

  it("a cancelled (terminal) attempt cannot be cancelled again", async () => {
    const registry = await seedAccount();
    const paymentStore = createInMemoryPaymentAttemptStore();
    const attempt = await reserveAttempt(paymentStore);
    const first = await resolveCancelPayment({ cookieValue: cookieFor(), sessionSecret: SECRET, registry, paymentStore, attemptId: attempt.id });
    expect(first.outcome).toBe("cancelled");

    const second = await resolveCancelPayment({ cookieValue: cookieFor(), sessionSecret: SECRET, registry, paymentStore, attemptId: attempt.id });
    expect(second.outcome).toBe("wrong_state");
  });

  it("pre-2f hardening: a malformed (non-UUID) attemptId is refused as not_found, never reaching the store", async () => {
    const registry = await seedAccount();
    const paymentStore = createInMemoryPaymentAttemptStore();
    const findByIdSpy = vi.spyOn(paymentStore, "findById");

    const outcome = await resolveCancelPayment({ cookieValue: cookieFor(), sessionSecret: SECRET, registry, paymentStore, attemptId: "not-a-uuid" });

    expect(outcome.outcome).toBe("not_found");
    expect(findByIdSpy).not.toHaveBeenCalled();
  });

  it("cancelling frees the account's one-active-attempt slot regardless of which pre-dispatch state it was cancelled from", async () => {
    const registry = await seedAccount();
    const paymentStore = createInMemoryPaymentAttemptStore();
    const attempt = await reserveAttempt(paymentStore);
    await paymentStore.transition({ id: attempt.id, from: "prepared", to: "awaiting_authorization" });
    await paymentStore.transition({ id: attempt.id, from: "awaiting_authorization", to: "signed" });

    const outcome = await resolveCancelPayment({ cookieValue: cookieFor(), sessionSecret: SECRET, registry, paymentStore, attemptId: attempt.id });
    expect(outcome.outcome).toBe("cancelled");

    const reserved = await paymentStore.reserve({
      appUserId: "app-user-1",
      safeAddress: SAFE_ADDRESS,
      recipient: "0x2222222222222222222222222222222222222222",
      amountBaseUnits: "1000000",
      chainId: 84532,
      tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      authorizingCredentialId: "credential-1",
    });
    expect(reserved.ok).toBe(true);
  });
});
