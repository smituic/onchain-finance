import { describe, expect, it, vi } from "vitest";
import { classifyReceipt } from "@/lib/real/payments/reconcile";
import { SAFE_OP_VALIDITY_SECONDS } from "@/lib/real/payments/validity";
import { createFakeEntryPoint } from "./fixtures/entry-point-fake";

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
const { readUserOperationChainState } = await import("@/lib/real/chain/entry-point");

const SECRET = "test-session-secret";

async function seedSubmittedAttempt(options: { state?: "awaiting_authorization" | "signed" | "submitting" | "submitted" | "unknown"; window?: { nonce: string; validUntil: number; prepareBlockNumber: string } } = {}) {
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
    authorizingCredentialId: "credential-1",
  });
  if (!reserved.ok) throw new Error("expected reservation to succeed");
  await paymentStore.transition({ id: reserved.attempt.id, from: "prepared", to: "awaiting_authorization", patch: { expectedUserOperationHash: EXPECTED_HASH, ...options.window } });
  const target = options.state ?? "submitted";
  if (target !== "awaiting_authorization") await paymentStore.transition({ id: reserved.attempt.id, from: "awaiting_authorization", to: "signed" });
  if (target !== "awaiting_authorization" && target !== "signed") await paymentStore.transition({ id: reserved.attempt.id, from: "signed", to: "submitting" });
  if (target === "submitted" || target === "unknown") await paymentStore.transition({ id: reserved.attempt.id, from: "submitting", to: target });

  const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);
  return { registry, paymentStore, attemptId: reserved.attempt.id, cookieValue };
}

describe("resolvePaymentStatus", () => {
  it("reconciles a submitted attempt to confirmed using the precomputed expected hash, never a client-supplied one", async () => {
    fetchUserOperationReceiptMock.mockReset();
    const { registry, paymentStore, attemptId, cookieValue } = await seedSubmittedAttempt();
    fetchUserOperationReceiptMock.mockResolvedValueOnce(receipt());

    const outcome = await resolvePaymentStatus({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", publicClient: createFakeEntryPoint({}).reader, attemptId });

    expect(outcome.outcome).toBe("ok");
    if (outcome.outcome !== "ok") return;
    expect(outcome.attempt.state).toBe("confirmed");
    expect(fetchUserOperationReceiptMock).toHaveBeenCalledWith(expect.objectContaining({ userOperationHash: EXPECTED_HASH }));
  });

  it("an unresolved receipt leaves the attempt exactly where it was — never guessed at", async () => {
    fetchUserOperationReceiptMock.mockReset();
    const { registry, paymentStore, attemptId, cookieValue } = await seedSubmittedAttempt();
    fetchUserOperationReceiptMock.mockResolvedValueOnce(null);

    const outcome = await resolvePaymentStatus({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", publicClient: createFakeEntryPoint({}).reader, attemptId });

    expect(outcome.outcome).toBe("ok");
    if (outcome.outcome !== "ok") return;
    expect(outcome.attempt.state).toBe("submitted");
  });

  it("a receipt for a mismatched hash never confirms this attempt", async () => {
    fetchUserOperationReceiptMock.mockReset();
    const { registry, paymentStore, attemptId, cookieValue } = await seedSubmittedAttempt();
    fetchUserOperationReceiptMock.mockResolvedValueOnce(receipt({ userOpHash: "0x9999999999999999999999999999999999999999999999999999999999999999" }));

    const outcome = await resolvePaymentStatus({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", publicClient: createFakeEntryPoint({}).reader, attemptId });

    expect(outcome.outcome).toBe("ok");
    if (outcome.outcome !== "ok") return;
    expect(outcome.attempt.state).toBe("submitted");
  });

  it("Part E (S2): returns serverNowSeconds from this server's own wall clock", async () => {
    fetchUserOperationReceiptMock.mockReset().mockResolvedValueOnce(null);
    const { registry, paymentStore, attemptId, cookieValue } = await seedSubmittedAttempt();
    const fixedNowMs = 1_950_000_000_000;

    const outcome = await resolvePaymentStatus({
      cookieValue,
      sessionSecret: SECRET,
      registry,
      paymentStore,
      pimlicoApiKey: "pim_test_key",
      publicClient: createFakeEntryPoint({}).reader,
      attemptId,
      now: () => fixedNowMs,
    });

    expect(outcome).toMatchObject({ outcome: "ok", serverNowSeconds: Math.floor(fixedNowMs / 1000) });
  });

  it("a stale failure_reason from an earlier 'unknown' resolution is cleared once the same attempt is later proven confirmed", async () => {
    fetchUserOperationReceiptMock.mockReset();
    const { paymentStore, registry, attemptId, cookieValue } = await seedSubmittedAttempt({ state: "unknown" });
    // Simulate the earlier ambiguous-submit patch that left a failure_reason
    // on the row (server/payments.ts's resolveSubmitPayment "unknown" branch).
    await paymentStore.transition({ id: attemptId, from: "unknown", to: "unknown", patch: { failureReason: "No definitive result was received after the operation was signed and dispatched." } });
    fetchUserOperationReceiptMock.mockResolvedValueOnce(receipt());

    const outcome = await resolvePaymentStatus({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", publicClient: createFakeEntryPoint({}).reader, attemptId });

    expect(outcome.outcome).toBe("ok");
    if (outcome.outcome !== "ok") return;
    expect(outcome.attempt).toMatchObject({ state: "confirmed", failureReason: null });
  });
});

describe("EntryPoint nonce reconciliation (bundler-independent)", () => {
  // A realistic per-payment nonce: a timestamp-derived KEY with sequence 0 (viem's nonceKeyManager).
  const KEY = BigInt("0x1a0d5d70cd9");
  const NONCE = KEY << BigInt(64);
  const PREPARE_BLOCK = BigInt(47_000_000);
  const VALID_UNTIL = 1_900_000_600;
  const TX = "0x5555555555555555555555555555555555555555555555555555555555555555";
  const window = { nonce: NONCE.toString(), validUntil: VALID_UNTIL, prepareBlockNumber: PREPARE_BLOCK.toString() };
  const chainInput = { sender: SENDER, nonce: NONCE, userOperationHash: EXPECTED_HASH, prepareBlockNumber: PREPARE_BLOCK, validUntil: VALID_UNTIL } as const;
  const matchingLog = (success: boolean) => ({ args: { userOpHash: EXPECTED_HASH, sender: SENDER, success }, transactionHash: TX });
  const afterExpiry = { latest: { number: BigInt(47_001_000), timestamp: BigInt(VALID_UNTIL + 3_000) }, finalized: { number: BigInt(47_000_700), timestamp: BigInt(VALID_UNTIL + 1) } };
  const beforeFinalizedExpiry = { latest: { number: BigInt(47_001_000), timestamp: BigInt(VALID_UNTIL + 3_000) }, finalized: { number: BigInt(47_000_200), timestamp: BigInt(VALID_UNTIL) } };

  describe("readUserOperationChainState", () => {
    it("nonce lane advanced + exactly one matching UserOperationEvent => included, with the event's own success flag and tx hash", async () => {
      for (const success of [true, false]) {
        const fake = createFakeEntryPoint({ latestSequence: BigInt(1), logs: [matchingLog(success)] });
        expect(await readUserOperationChainState(fake.reader, chainInput)).toEqual({ kind: "included", success, transactionHash: TX });
      }
    });

    it("the event search is bounded to [prepareBlock, prepareBlock + window] — never beyond, never before", async () => {
      const fake = createFakeEntryPoint({ latest: { number: PREPARE_BLOCK + BigInt(5_000), timestamp: BigInt(VALID_UNTIL + 9_000) }, latestSequence: BigInt(1), logs: [matchingLog(true)] });
      await readUserOperationChainState(fake.reader, chainInput);
      expect(fake.calls.find((c) => c.method === "getLogs")?.args).toMatchObject({ fromBlock: PREPARE_BLOCK, toBlock: PREPARE_BLOCK + BigInt(SAFE_OP_VALIDITY_SECONDS), args: { userOpHash: EXPECTED_HASH, sender: SENDER } });
    });

    it("nonce advanced but no (or more than one, or a mismatched) event => unresolved, never guessed", async () => {
      for (const logs of [[], [matchingLog(true), matchingLog(true)], [{ args: { userOpHash: "0x" + "9".repeat(64), sender: SENDER, success: true }, transactionHash: TX }]]) {
        const fake = createFakeEntryPoint({ latestSequence: BigInt(1), logs });
        expect(await readUserOperationChainState(fake.reader, chainInput)).toEqual({ kind: "unresolved" });
      }
    });

    const nonceReads = (fake: ReturnType<typeof createFakeEntryPoint>) =>
      fake.calls.filter((c) => c.method === "readContract").map((c) => c.args as { args: [string, bigint]; blockNumber?: bigint; blockTag?: string });

    it("S2-A: finalized timestamp > validUntil and getNonce at blockTag 'finalized' returns this exact key + sequence => expired_unincluded", async () => {
      const fake = createFakeEntryPoint({ ...afterExpiry, latestSequence: BigInt(0), finalizedSequence: BigInt(0) });
      expect(await readUserOperationChainState(fake.reader, chainInput)).toEqual({ kind: "expired_unincluded" });
      expect(nonceReads(fake).some((r) => r.blockTag === "finalized")).toBe(true);
    });

    it("S2-B: latest looks unconsumed but FINALIZED state shows the lane consumed => never expired_unincluded (latest is not the proof)", async () => {
      const fake = createFakeEntryPoint({ ...afterExpiry, latestSequence: BigInt(0), finalizedSequence: BigInt(1) });
      expect(await readUserOperationChainState(fake.reader, chainInput)).toEqual({ kind: "unresolved" });
    });

    it("S2-C: getNonce at blockTag 'finalized' throwing (unsupported tag / RPC error) propagates — never expired_unincluded", async () => {
      const fake = createFakeEntryPoint({ ...afterExpiry, latestSequence: BigInt(0), failFinalizedStateReads: true });
      await expect(readUserOperationChainState(fake.reader, chainInput)).rejects.toThrow();
    });

    it("S2-D: a getNonce of 0n for our NON-zero key (key decodes to 0, sequence 0) is unresolved, not 'unconsumed'", async () => {
      expect(KEY).not.toBe(BigInt(0));
      for (const rawNonce of [{ finalized: BigInt(0) }, { latest: BigInt(0) }]) {
        const fake = createFakeEntryPoint({ ...afterExpiry, latestSequence: BigInt(0), finalizedSequence: BigInt(0), rawNonce });
        expect(await readUserOperationChainState(fake.reader, chainInput)).toEqual({ kind: "unresolved" });
      }
    });

    it("S2-E: a packed value whose KEY differs but whose low 64-bit sequence matches is unresolved", async () => {
      const wrongKey = (KEY + BigInt(1)) << BigInt(64); // sequence 0, same as ours
      for (const rawNonce of [{ finalized: wrongKey }, { latest: wrongKey }]) {
        const fake = createFakeEntryPoint({ ...afterExpiry, latestSequence: BigInt(0), finalizedSequence: BigInt(0), rawNonce });
        expect(await readUserOperationChainState(fake.reader, chainInput)).toEqual({ kind: "unresolved" });
      }
    });

    it("S2-E': a malformed getNonce value (non-bigint, negative, > uint256) is unresolved", async () => {
      for (const bad of ["0", 0, null, BigInt(-1), BigInt(1) << BigInt(256)]) {
        const fake = createFakeEntryPoint({ ...afterExpiry, latestSequence: BigInt(0), finalizedSequence: BigInt(0), rawNonce: { finalized: bad } });
        expect(await readUserOperationChainState(fake.reader, chainInput)).toEqual({ kind: "unresolved" });
      }
    });

    it("S2-F: finalized.timestamp exactly == validUntil is unresolved (the op is still valid AT validUntil)", async () => {
      const fake = createFakeEntryPoint({ ...afterExpiry, finalized: { number: BigInt(47_000_600), timestamp: BigInt(VALID_UNTIL) }, latestSequence: BigInt(0), finalizedSequence: BigInt(0) });
      expect(await readUserOperationChainState(fake.reader, chainInput)).toEqual({ kind: "unresolved" });
      expect(nonceReads(fake).some((r) => r.blockTag === "finalized")).toBe(false);
    });

    it("S2-G: another nonce key's lane advancing (latest or finalized) does not affect ours — every read requests OUR key", async () => {
      const lanes = new Map([[KEY + BigInt(7), { latest: BigInt(9), finalized: BigInt(9) }]]);
      const fake = createFakeEntryPoint({ ...afterExpiry, latestSequence: BigInt(0), finalizedSequence: BigInt(0), lanes });
      expect(await readUserOperationChainState(fake.reader, chainInput)).toEqual({ kind: "expired_unincluded" });
      expect(nonceReads(fake).every((r) => r.args[1] === KEY)).toBe(true);
    });

    it("S2-H: no numbered (historical) block read is ever required — every getNonce uses a block TAG", async () => {
      const fake = createFakeEntryPoint({ ...afterExpiry, latestSequence: BigInt(0), finalizedSequence: BigInt(0), failNumberedReads: true });
      expect(await readUserOperationChainState(fake.reader, chainInput)).toEqual({ kind: "expired_unincluded" });
      expect(nonceReads(fake).every((r) => r.blockNumber === undefined && (r.blockTag === "latest" || r.blockTag === "finalized"))).toBe(true);
    });

    it("latest past validUntil is NOT enough — until the finalized block is past it, the answer stays unresolved (reorg-safe)", async () => {
      const fake = createFakeEntryPoint({ ...beforeFinalizedExpiry, latestSequence: BigInt(0) });
      expect(await readUserOperationChainState(fake.reader, chainInput)).toEqual({ kind: "unresolved" });
    });

    it("still inside the window with the nonce unconsumed => unresolved (it may yet land)", async () => {
      const fake = createFakeEntryPoint({ latest: { number: BigInt(47_000_050), timestamp: BigInt(VALID_UNTIL - 100) }, latestSequence: BigInt(0) });
      expect(await readUserOperationChainState(fake.reader, chainInput)).toEqual({ kind: "unresolved" });
    });

    it("reads the nonce under THIS payment's own key — another payment's lane advancing is irrelevant", async () => {
      const fake = createFakeEntryPoint({ ...beforeFinalizedExpiry, latestSequence: BigInt(0) });
      await readUserOperationChainState(fake.reader, chainInput);
      const keys = fake.calls.filter((c) => c.method === "readContract").map((c) => (c.args as { args: [string, bigint] }).args[1]);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((k) => k === KEY)).toBe(true);
    });
  });

  describe("resolvePaymentStatus with no bundler receipt", () => {
    const status = (ctx: Awaited<ReturnType<typeof seedSubmittedAttempt>>, publicClient: ReturnType<typeof createFakeEntryPoint>["reader"]) =>
      resolvePaymentStatus({ cookieValue: ctx.cookieValue, sessionSecret: SECRET, registry: ctx.registry, paymentStore: ctx.paymentStore, pimlicoApiKey: "pim_test_key", publicClient, attemptId: ctx.attemptId });

    it("a lost bundler (no receipt) but an on-chain event => confirmed with the event's tx hash", async () => {
      fetchUserOperationReceiptMock.mockReset().mockResolvedValue(null);
      const ctx = await seedSubmittedAttempt({ state: "unknown", window });
      const outcome = await status(ctx, createFakeEntryPoint({ latestSequence: BigInt(1), logs: [matchingLog(true)] }).reader);
      expect(outcome.outcome === "ok" && outcome.attempt).toMatchObject({ state: "confirmed", transactionHash: TX });
    });

    it("an on-chain reverted event => failed (with tx hash) — the nonce was consumed, money may have paid gas, but the transfer didn't happen", async () => {
      fetchUserOperationReceiptMock.mockReset().mockResolvedValue(null);
      const ctx = await seedSubmittedAttempt({ window });
      const outcome = await status(ctx, createFakeEntryPoint({ latestSequence: BigInt(1), logs: [matchingLog(false)] }).reader);
      expect(outcome.outcome === "ok" && outcome.attempt).toMatchObject({ state: "failed", transactionHash: TX });
    });

    it("a 'submitting' row left by a crash, proven never includable => failed ('no money moved'), and the account can pay again — never resent", async () => {
      fetchUserOperationReceiptMock.mockReset().mockResolvedValue(null);
      const ctx = await seedSubmittedAttempt({ state: "submitting", window });
      const outcome = await status(ctx, createFakeEntryPoint({ ...afterExpiry, latestSequence: BigInt(0), finalizedSequence: BigInt(0) }).reader);
      expect(outcome.outcome === "ok" && outcome.attempt).toMatchObject({ state: "failed", failureReason: expect.stringMatching(/expired before it was included.*No money moved/) });
      const next = await ctx.paymentStore.reserve({ appUserId: "app-user-1", safeAddress: SENDER, recipient: "0x4444444444444444444444444444444444444444", amountBaseUnits: "1", chainId: 84532, tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", authorizingCredentialId: "credential-1" });
      expect(next.ok).toBe(true);
    });

    it("pending on-chain (inside the window, or not yet finalized past it) => unchanged", async () => {
      fetchUserOperationReceiptMock.mockReset().mockResolvedValue(null);
      const ctx = await seedSubmittedAttempt({ window });
      const outcome = await status(ctx, createFakeEntryPoint({ ...beforeFinalizedExpiry, latestSequence: BigInt(0) }).reader);
      expect(outcome.outcome === "ok" && outcome.attempt.state).toBe("submitted");
    });

    it("S2-C: a provider that can't serve getNonce at 'finalized' leaves the row unchanged — never 'No money moved'", async () => {
      fetchUserOperationReceiptMock.mockReset().mockResolvedValue(null);
      const ctx = await seedSubmittedAttempt({ state: "submitting", window });
      const outcome = await status(ctx, createFakeEntryPoint({ ...afterExpiry, latestSequence: BigInt(0), failFinalizedStateReads: true }).reader);
      expect(outcome.outcome === "ok" && outcome.attempt).toMatchObject({ state: "submitting", failureReason: null });
    });

    it("any RPC failure fails closed: unchanged, no upstream text surfaced", async () => {
      fetchUserOperationReceiptMock.mockReset().mockResolvedValue(null);
      const ctx = await seedSubmittedAttempt({ window });
      const outcome = await status(ctx, createFakeEntryPoint({ fail: true }).reader);
      expect(outcome.outcome === "ok" && outcome.attempt).toMatchObject({ state: "submitted", failureReason: null });
    });

    it("a bundler receipt still wins — the chain isn't consulted when the bundler already answered", async () => {
      fetchUserOperationReceiptMock.mockReset().mockResolvedValue(receipt());
      const ctx = await seedSubmittedAttempt({ window });
      const fake = createFakeEntryPoint({ ...afterExpiry, latestSequence: BigInt(0), finalizedSequence: BigInt(0) });
      const outcome = await status(ctx, fake.reader);
      expect(outcome.outcome === "ok" && outcome.attempt.state).toBe("confirmed");
      expect(fake.calls).toHaveLength(0);
    });

    describe("never-dispatched (awaiting_authorization / signed) rows", () => {
      const statusAt = (ctx: Awaited<ReturnType<typeof seedSubmittedAttempt>>, publicClient: ReturnType<typeof createFakeEntryPoint>["reader"], nowSeconds: number) =>
        resolvePaymentStatus({ cookieValue: ctx.cookieValue, sessionSecret: SECRET, registry: ctx.registry, paymentStore: ctx.paymentStore, pimlicoApiKey: "pim_test_key", publicClient, attemptId: ctx.attemptId, now: () => nowSeconds * 1000 });

      it("before validUntil: unchanged, and the chain isn't even read", async () => {
        const ctx = await seedSubmittedAttempt({ state: "awaiting_authorization", window });
        const fake = createFakeEntryPoint({ ...afterExpiry, latestSequence: BigInt(0), finalizedSequence: BigInt(0) });
        const outcome = await statusAt(ctx, fake.reader, VALID_UNTIL);
        expect(outcome.outcome === "ok" && outcome.attempt.state).toBe("awaiting_authorization");
        expect(fake.calls).toHaveLength(0);
      });

      it("wall clock AND latest block past validUntil are NOT enough — unchanged until a finalized block is past it", async () => {
        const ctx = await seedSubmittedAttempt({ state: "awaiting_authorization", window });
        const outcome = await statusAt(ctx, createFakeEntryPoint({ ...beforeFinalizedExpiry, latestSequence: BigInt(0) }).reader, VALID_UNTIL + 3_000);
        expect(outcome.outcome === "ok" && outcome.attempt.state).toBe("awaiting_authorization");
      });

      it("finalized past validUntil with the lane unconsumed => failed, 'no money moved', and the slot is freed — for awaiting_authorization and signed alike", async () => {
        for (const state of ["awaiting_authorization", "signed"] as const) {
          fetchUserOperationReceiptMock.mockReset();
          const ctx = await seedSubmittedAttempt({ state, window });
          const outcome = await statusAt(ctx, createFakeEntryPoint({ ...afterExpiry, latestSequence: BigInt(0), finalizedSequence: BigInt(0) }).reader, VALID_UNTIL + 3_000);
          expect(outcome.outcome === "ok" && outcome.attempt).toMatchObject({ state: "failed", transactionHash: null, failureReason: expect.stringMatching(/No money moved/) });
          const next = await ctx.paymentStore.reserve({ appUserId: "app-user-1", safeAddress: SENDER, recipient: "0x4444444444444444444444444444444444444444", amountBaseUnits: "1", chainId: 84532, tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", authorizingCredentialId: "credential-1" });
          expect(next.ok).toBe(true);
        }
      });

      it("never assumed unsigned: if its lane advanced with a matching event (a signature was made and landed), it is recorded truthfully as confirmed", async () => {
        const ctx = await seedSubmittedAttempt({ state: "awaiting_authorization", window });
        const outcome = await statusAt(ctx, createFakeEntryPoint({ ...afterExpiry, latestSequence: BigInt(1), logs: [matchingLog(true)] }).reader, VALID_UNTIL + 3_000);
        expect(outcome.outcome === "ok" && outcome.attempt).toMatchObject({ state: "confirmed", transactionHash: TX });
      });

      it("RPC failure or a legacy row without a window: unchanged", async () => {
        const failing = await seedSubmittedAttempt({ state: "awaiting_authorization", window });
        expect((await statusAt(failing, createFakeEntryPoint({ fail: true }).reader, VALID_UNTIL + 3_000)).outcome === "ok").toBe(true);
        expect((await failing.paymentStore.findById(failing.attemptId))?.state).toBe("awaiting_authorization");

        const legacy = await seedSubmittedAttempt({ state: "awaiting_authorization" });
        const fake = createFakeEntryPoint({ ...afterExpiry, latestSequence: BigInt(0), finalizedSequence: BigInt(0) });
        await statusAt(legacy, fake.reader, VALID_UNTIL + 3_000);
        expect((await legacy.paymentStore.findById(legacy.attemptId))?.state).toBe("awaiting_authorization");
        expect(fake.calls).toHaveLength(0);
      });

      it("a legacy row (no valid_until) is never offered for a new signing ceremony, even after polling /status well past when a normal window would have expired", async () => {
        const legacy = await seedSubmittedAttempt({ state: "awaiting_authorization" });
        const outcome = await statusAt(legacy, createFakeEntryPoint({ ...afterExpiry, latestSequence: BigInt(0), finalizedSequence: BigInt(0) }).reader, VALID_UNTIL + 3_000);
        expect(outcome.outcome).toBe("ok");
        if (outcome.outcome !== "ok") return;
        expect(outcome.attempt.state).toBe("awaiting_authorization");
        // toPublicAttempt's hasPreparedFields requires validUntil !== null —
        // a legacy row can never carry `prepared` on the wire, so the client
        // can never reconstruct a SafeOp to sign for it, at any wall-clock time.
        expect(outcome.attempt.prepared).toBeNull();
      });

      it("a concurrent submit that already moved the row on wins: the stale CAS changes nothing", async () => {
        const ctx = await seedSubmittedAttempt({ state: "awaiting_authorization", window });
        const fake = createFakeEntryPoint({ ...afterExpiry, latestSequence: BigInt(0), finalizedSequence: BigInt(0) });
        const originalGetBlock = fake.reader.getBlock.bind(fake.reader);
        (fake.reader as { getBlock: typeof fake.reader.getBlock }).getBlock = (async (args: Parameters<typeof fake.reader.getBlock>[0]) => {
          await ctx.paymentStore.transition({ id: ctx.attemptId, from: "awaiting_authorization", to: "signed" });
          return originalGetBlock(args);
        }) as typeof fake.reader.getBlock;
        await statusAt(ctx, fake.reader, VALID_UNTIL + 3_000);
        expect((await ctx.paymentStore.findById(ctx.attemptId))?.state).toBe("signed");
      });
    });

    it("a legacy row with no window/prepare block is never concluded from the chain", async () => {
      fetchUserOperationReceiptMock.mockReset().mockResolvedValue(null);
      const ctx = await seedSubmittedAttempt();
      const fake = createFakeEntryPoint({ ...afterExpiry, latestSequence: BigInt(0), finalizedSequence: BigInt(0) });
      const outcome = await status(ctx, fake.reader);
      expect(outcome.outcome === "ok" && outcome.attempt.state).toBe("submitted");
      expect(fake.calls).toHaveLength(0);
    });
  });
});
