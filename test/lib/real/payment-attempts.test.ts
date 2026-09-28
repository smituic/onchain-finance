import { describe, expect, it } from "vitest";
import { createInMemoryPaymentAttemptStore, DuplicateSignActivityError } from "@/lib/real/server/payment-attempts";
import { createInMemoryRealAccountRegistry } from "@/lib/real/server/registry";

function reserveInput(overrides: Partial<{ appUserId: string }> = {}) {
  return {
    appUserId: overrides.appUserId ?? "app-user-1",
    safeAddress: "0x1111111111111111111111111111111111111111",
    recipient: "0x2222222222222222222222222222222222222222",
    amountBaseUnits: "1000000",
    chainId: 84532,
    tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    authorizingCredentialId: "credential-1",
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

  describe("findRecentByAppUserId (Batch 2e history read)", () => {
    it("returns attempts newest-first, most-recently-inserted first on a timestamp tie", async () => {
      const store = createInMemoryPaymentAttemptStore();
      const first = await store.reserve(reserveInput());
      if (!first.ok) throw new Error("expected reservation to succeed");
      await store.transition({ id: first.attempt.id, from: "prepared", to: "cancelled" });
      const second = await store.reserve(reserveInput());
      if (!second.ok) throw new Error("expected reservation to succeed");
      await store.transition({ id: second.attempt.id, from: "prepared", to: "cancelled" });

      const recent = await store.findRecentByAppUserId({ appUserId: "app-user-1", limit: 10 });
      expect(recent.map((a) => a.id)).toEqual([second.attempt.id, first.attempt.id]);
    });

    it("respects the limit", async () => {
      const store = createInMemoryPaymentAttemptStore();
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const reserved = await store.reserve(reserveInput());
        if (!reserved.ok) throw new Error("expected reservation to succeed");
        await store.transition({ id: reserved.attempt.id, from: "prepared", to: "cancelled" });
        ids.push(reserved.attempt.id);
      }

      const recent = await store.findRecentByAppUserId({ appUserId: "app-user-1", limit: 2 });
      expect(recent).toHaveLength(2);
      expect(recent.map((a) => a.id)).toEqual([ids[4], ids[3]]);
    });

    it("never returns another account's attempts", async () => {
      const store = createInMemoryPaymentAttemptStore();
      const mine = await store.reserve(reserveInput());
      if (!mine.ok) throw new Error("expected reservation to succeed");
      const theirs = await store.reserve(reserveInput({ appUserId: "app-user-2" }));
      if (!theirs.ok) throw new Error("expected reservation to succeed");

      const recent = await store.findRecentByAppUserId({ appUserId: "app-user-1", limit: 10 });
      expect(recent.map((a) => a.id)).toEqual([mine.attempt.id]);
    });
  });
});

describe("Slice S1 — attribution fields (in-memory store)", () => {
  async function awaiting(store: ReturnType<typeof createInMemoryPaymentAttemptStore>) {
    const reserved = await store.reserve(reserveInput());
    if (!reserved.ok) throw new Error("expected a reservation");
    await store.transition({ id: reserved.attempt.id, from: "prepared", to: "awaiting_authorization" });
    return reserved.attempt;
  }

  it("reserve() binds the credential at creation; the activity/verification fields start empty", async () => {
    const store = createInMemoryPaymentAttemptStore();
    const reserved = await store.reserve(reserveInput());
    expect(reserved.ok && reserved.attempt).toMatchObject({ authorizingCredentialId: "credential-1", turnkeySignActivityId: null, authorizationVerifiedAt: null });
  });

  it("the signing activity id and verification time are write-once — a later patch never overwrites them", async () => {
    const store = createInMemoryPaymentAttemptStore();
    const attempt = await awaiting(store);
    await store.transition({ id: attempt.id, from: "awaiting_authorization", to: "signed", patch: { turnkeySignActivityId: "activity-a", authorizationVerifiedAt: "2026-01-01T00:00:00.000Z" } });
    const after = await store.transition({ id: attempt.id, from: "signed", to: "failed", patch: { turnkeySignActivityId: "activity-b", authorizationVerifiedAt: "2027-01-01T00:00:00.000Z" } });
    expect(after).toMatchObject({ state: "failed", turnkeySignActivityId: "activity-a", authorizationVerifiedAt: "2026-01-01T00:00:00.000Z" });
  });

  it("an activity id already recorded on another payment throws DuplicateSignActivityError and applies nothing", async () => {
    const store = createInMemoryPaymentAttemptStore();
    const first = await awaiting(store);
    await store.transition({ id: first.id, from: "awaiting_authorization", to: "signed", patch: { turnkeySignActivityId: "activity-a" } });
    await store.transition({ id: first.id, from: "signed", to: "failed" });
    const second = await awaiting(store);

    await expect(store.transition({ id: second.id, from: "awaiting_authorization", to: "signed", patch: { turnkeySignActivityId: "activity-a" } })).rejects.toBeInstanceOf(DuplicateSignActivityError);
    expect(await store.findById(second.id)).toMatchObject({ state: "awaiting_authorization", turnkeySignActivityId: null });
  });
});

describe("Slice S1 — beginDispatch: signed -> submitting only while the bound passkey is active (in-memory store)", () => {
  async function world(options: { withRegistry?: boolean } = {}) {
    const registry = createInMemoryRealAccountRegistry();
    await registry.createAccountWithPasskey({
      account: { appUserId: "app-user-1", subOrganizationId: "s", turnkeyUserId: "t", walletId: "w", walletAccountId: "wa", ownerAddress: "0x1", safeAddress: "0x1111111111111111111111111111111111111111", accountConfigVersion: 1 },
      passkey: { credentialId: "credential-1", appUserId: "app-user-1", credentialPublicKey: "k", userHandle: "h", counter: 0, transports: null, credentialDeviceType: null, credentialBackedUp: null },
    });
    const store = createInMemoryPaymentAttemptStore(options.withRegistry === false ? undefined : registry);
    const reserved = await store.reserve(reserveInput());
    if (!reserved.ok) throw new Error("expected a reservation");
    await store.transition({ id: reserved.attempt.id, from: "prepared", to: "awaiting_authorization" });
    await store.transition({ id: reserved.attempt.id, from: "awaiting_authorization", to: "signed" });
    return { registry, store, id: reserved.attempt.id };
  }

  it("claims a signed row whose bound passkey is active", async () => {
    const { store, id } = await world();
    expect((await store.beginDispatch({ id }))?.state).toBe("submitting");
    expect(await store.beginDispatch({ id })).toBeNull(); // no second claim
  });

  it.each(["revoking", "revoked"] as const)("refuses when the bound passkey is %s — the row stays signed", async (status) => {
    const { registry, store, id } = await world();
    await registry.transitionPasskeyStatus({ credentialId: "credential-1", from: "active", to: "revoking" });
    if (status === "revoked") await registry.transitionPasskeyStatus({ credentialId: "credential-1", from: "revoking", to: "revoked" });
    expect(await store.beginDispatch({ id })).toBeNull();
    expect((await store.findById(id))?.state).toBe("signed");
  });

  it("refuses when the row isn't signed, or when there's no registry to check against", async () => {
    const { store, id } = await world();
    await store.transition({ id, from: "signed", to: "cancelled" });
    expect(await store.beginDispatch({ id })).toBeNull();

    const unchecked = await world({ withRegistry: false });
    expect(await unchecked.store.beginDispatch({ id: unchecked.id })).toBeNull();
  });
});
