import { describe, expect, it } from "vitest";
import { createInMemoryPaymentAttemptStore } from "@/lib/real/server/payment-attempts";

function reserveInput(overrides: Partial<{ appUserId: string }> = {}) {
  return {
    appUserId: overrides.appUserId ?? "app-user-1",
    safeAddress: "0x1111111111111111111111111111111111111111",
    recipient: "0x2222222222222222222222222222222222222222",
    amountBaseUnits: "1000000",
    chainId: 84532,
    tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  };
}

describe("payment attempt state machine (in-memory store)", () => {
  it("walks prepared -> awaiting_authorization -> signed -> submitted -> confirmed", async () => {
    const store = createInMemoryPaymentAttemptStore();
    const reserved = await store.reserve(reserveInput());
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    expect(reserved.attempt.state).toBe("prepared");

    const prepared = await store.transition({
      id: reserved.attempt.id,
      from: "prepared",
      to: "awaiting_authorization",
      patch: { nonce: "0", callData: "0xabc", expectedUserOperationHash: "0xhash" },
    });
    expect(prepared?.state).toBe("awaiting_authorization");
    expect(prepared?.expectedUserOperationHash).toBe("0xhash");

    const signed = await store.transition({ id: reserved.attempt.id, from: "awaiting_authorization", to: "signed" });
    expect(signed?.state).toBe("signed");

    // Durable, written BEFORE dispatch — see payments.ts's resolveSubmitPayment.
    const submitting = await store.transition({ id: reserved.attempt.id, from: "signed", to: "submitting" });
    expect(submitting?.state).toBe("submitting");

    const submitted = await store.transition({ id: reserved.attempt.id, from: "submitting", to: "submitted" });
    expect(submitted?.state).toBe("submitted");

    const confirmed = await store.transition({
      id: reserved.attempt.id,
      from: "submitted",
      to: "confirmed",
      patch: { transactionHash: "0xtxhash" },
    });
    expect(confirmed?.state).toBe("confirmed");
    expect(confirmed?.transactionHash).toBe("0xtxhash");
  });

  it("a definitive pre-submit failure (signed -> failed) is a terminal, retryable state", async () => {
    const store = createInMemoryPaymentAttemptStore();
    const reserved = await store.reserve(reserveInput());
    if (!reserved.ok) throw new Error("expected reservation to succeed");
    await store.transition({ id: reserved.attempt.id, from: "prepared", to: "awaiting_authorization" });
    await store.transition({ id: reserved.attempt.id, from: "awaiting_authorization", to: "signed" });

    const failed = await store.transition({ id: reserved.attempt.id, from: "signed", to: "failed", patch: { failureReason: "rejected by bundler" } });
    expect(failed?.state).toBe("failed");

    // Terminal + freed: a new payment for the same account can now be reserved.
    const nextReservation = await store.reserve(reserveInput());
    expect(nextReservation.ok).toBe(true);
  });

  it("an ambiguous post-dispatch outcome becomes unknown, not failed", async () => {
    const store = createInMemoryPaymentAttemptStore();
    const reserved = await store.reserve(reserveInput());
    if (!reserved.ok) throw new Error("expected reservation to succeed");
    await store.transition({ id: reserved.attempt.id, from: "prepared", to: "awaiting_authorization" });
    await store.transition({ id: reserved.attempt.id, from: "awaiting_authorization", to: "signed" });
    await store.transition({ id: reserved.attempt.id, from: "signed", to: "submitting" });

    const unknown = await store.transition({ id: reserved.attempt.id, from: "submitting", to: "unknown", patch: { failureReason: "no definitive bundler result" } });
    expect(unknown?.state).toBe("unknown");
  });

  it("a row stuck at 'submitting' (process died between the pre-dispatch CAS and recording a result) is never resendable", async () => {
    const store = createInMemoryPaymentAttemptStore();
    const reserved = await store.reserve(reserveInput());
    if (!reserved.ok) throw new Error("expected reservation to succeed");
    await store.transition({ id: reserved.attempt.id, from: "prepared", to: "awaiting_authorization" });
    await store.transition({ id: reserved.attempt.id, from: "awaiting_authorization", to: "signed" });
    const submitting = await store.transition({ id: reserved.attempt.id, from: "signed", to: "submitting" });
    expect(submitting?.state).toBe("submitting");

    // Blocks a new payment for the account...
    const blocked = await store.reserve(reserveInput());
    expect(blocked).toEqual({ ok: false, reason: "payment_in_progress" });

    // ...and a resubmit attempt for the SAME id cannot re-enter the signing
    // path either, since its CAS source state (awaiting_authorization) no
    // longer matches.
    const resubmit = await store.transition({ id: reserved.attempt.id, from: "awaiting_authorization", to: "signed" });
    expect(resubmit).toBeNull();

    // Only reconciliation (a direct transition out of "submitting", modeling
    // resolvePaymentStatus) may resolve it — never a second dispatch.
    const reconciled = await store.transition({ id: reserved.attempt.id, from: "submitting", to: "confirmed", patch: { transactionHash: "0xabc" } });
    expect(reconciled?.state).toBe("confirmed");
  });

  it("an unknown attempt blocks a blind resend — the account cannot reserve a new payment while it's unresolved", async () => {
    const store = createInMemoryPaymentAttemptStore();
    const reserved = await store.reserve(reserveInput());
    if (!reserved.ok) throw new Error("expected reservation to succeed");
    await store.transition({ id: reserved.attempt.id, from: "prepared", to: "awaiting_authorization" });
    await store.transition({ id: reserved.attempt.id, from: "awaiting_authorization", to: "signed" });
    await store.transition({ id: reserved.attempt.id, from: "signed", to: "submitting" });
    await store.transition({ id: reserved.attempt.id, from: "submitting", to: "unknown" });

    const blocked = await store.reserve(reserveInput());
    expect(blocked).toEqual({ ok: false, reason: "payment_in_progress" });

    // And a direct resubmit of the SAME unknown attempt id must not be
    // possible either — its CAS source state (awaiting_authorization) no
    // longer matches.
    const resubmit = await store.transition({ id: reserved.attempt.id, from: "awaiting_authorization", to: "signed" });
    expect(resubmit).toBeNull();
  });

  it("a duplicate concurrent submit for the same attempt cannot both win the awaiting_authorization -> signed CAS", async () => {
    const store = createInMemoryPaymentAttemptStore();
    const reserved = await store.reserve(reserveInput());
    if (!reserved.ok) throw new Error("expected reservation to succeed");
    await store.transition({ id: reserved.attempt.id, from: "prepared", to: "awaiting_authorization" });

    const [first, second] = await Promise.all([
      store.transition({ id: reserved.attempt.id, from: "awaiting_authorization", to: "signed" }),
      store.transition({ id: reserved.attempt.id, from: "awaiting_authorization", to: "signed" }),
    ]);
    const winners = [first, second].filter((result) => result !== null);
    expect(winners).toHaveLength(1);
  });

  it("a cancelled attempt is terminal and frees the account's slot", async () => {
    const store = createInMemoryPaymentAttemptStore();
    const reserved = await store.reserve(reserveInput());
    if (!reserved.ok) throw new Error("expected reservation to succeed");
    await store.transition({ id: reserved.attempt.id, from: "prepared", to: "awaiting_authorization" });

    const cancelled = await store.transition({ id: reserved.attempt.id, from: "awaiting_authorization", to: "cancelled" });
    expect(cancelled?.state).toBe("cancelled");

    const next = await store.reserve(reserveInput());
    expect(next.ok).toBe(true);
  });

  it("findLatestByAppUserId returns the most recently created attempt", async () => {
    const store = createInMemoryPaymentAttemptStore();
    const first = await store.reserve(reserveInput());
    if (!first.ok) throw new Error("expected reservation to succeed");
    await store.transition({ id: first.attempt.id, from: "prepared", to: "cancelled" });

    const second = await store.reserve(reserveInput());
    if (!second.ok) throw new Error("expected reservation to succeed");

    const latest = await store.findLatestByAppUserId("app-user-1");
    expect(latest?.id).toBe(second.attempt.id);
  });
});
