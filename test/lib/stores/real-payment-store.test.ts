import { describe, expect, it, vi } from "vitest";
import { createRealPaymentStore } from "@/lib/stores/real-payment-store";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * Pre-2f hardening: account-switch/logout state isolation. init() must
 * clear a prior account's recipient/amount/attempt/error as its FIRST
 * synchronous action — before its own /latest fetch even resolves — so
 * "reset before init" holds no matter which caller (a fresh mount, an
 * account-change effect) invokes it. See components/real/real-pay-form.tsx's
 * account-change effect for the other half of this fix.
 */
describe("real-payment-store — init() resets prior-account state before fetching", () => {
  it("clears recipientInput/amountInput/attempt/error synchronously, before the /latest fetch resolves", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { attempt: null })));
    const store = createRealPaymentStore();

    // Simulate stale input left over from a prior account.
    store.getState().setRecipientInput("0x1111111111111111111111111111111111111111");
    store.getState().setAmountInput("42");
    store.setState({
      attempt: {
        id: "stale-attempt",
        state: "awaiting_authorization",
        recipient: "0x1111111111111111111111111111111111111111",
        amountBaseUnits: "42000000",
        transactionHash: null,
        failureReason: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        prepared: null,
      },
      error: "stale error from a previous account",
    });

    const pending = store.getState().init();
    // Checked BEFORE awaiting the fetch — init() must clear these as its
    // first synchronous action, not only after the response arrives.
    expect(store.getState().recipientInput).toBe("");
    expect(store.getState().amountInput).toBe("");
    expect(store.getState().attempt).toBeNull();
    expect(store.getState().error).toBeNull();

    await pending;
    // Still clear once the fetch resolves (server reported no attempt).
    expect(store.getState().attempt).toBeNull();
    vi.unstubAllGlobals();
  });

  it("a stale recipient/amount cannot be submitted under a different account — review() sees the cleared state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { attempt: null })));
    const store = createRealPaymentStore();
    store.getState().setRecipientInput("0x1111111111111111111111111111111111111111");
    store.getState().setAmountInput("42");

    await store.getState().init();
    store.getState().review();

    // Nothing to review — the fields were cleared, so review() reports the
    // validation error rather than proceeding with the prior account's data.
    expect(store.getState().status).not.toBe("reviewing");
    expect(store.getState().error).toBeTruthy();
    vi.unstubAllGlobals();
  });
});
