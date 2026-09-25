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
  });
  if (!reserved.ok) throw new Error("expected reservation to succeed");
  await paymentStore.transition({ id: reserved.attempt.id, from: "prepared", to: "awaiting_authorization", patch: { expectedUserOperationHash: EXPECTED_HASH, ...options.window } });
  const target = options.state ?? "submitted";
  if (target !== "awaiting_authorization") await paymentStore.transition({ id: reserved.attempt.id, from: "awaiting_authorization", to: "signed" });
  if (target !== "awaiting_authorization" && target !== "signed") await paymentStore.transition({ id: reserved.attempt.id, from: "signed", to: "submitting" });
  if (target === "submitted" || target === "unknown") await paymentStore.transition({ id: reserved.attempt.id, from: "submitting", to: target });

  const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1" }), SECRET);
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

    it("unconsumed at a FINALIZED block past validUntil => provably never includable", async () => {
      const fake = createFakeEntryPoint({ ...afterExpiry, latestSequence: BigInt(0), finalizedSequence: BigInt(0) });
      expect(await readUserOperationChainState(fake.reader, chainInput)).toEqual({ kind: "expired_unincluded" });
      expect(fake.calls.some((c) => c.method === "readContract" && (c.args as { blockNumber: bigint }).blockNumber === afterExpiry.finalized.number)).toBe(true);
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
      const next = await ctx.paymentStore.reserve({ appUserId: "app-user-1", safeAddress: SENDER, recipient: "0x4444444444444444444444444444444444444444", amountBaseUnits: "1", chainId: 84532, tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" });
      expect(next.ok).toBe(true);
    });

    it("pending on-chain (inside the window, or not yet finalized past it) => unchanged", async () => {
      fetchUserOperationReceiptMock.mockReset().mockResolvedValue(null);
      const ctx = await seedSubmittedAttempt({ window });
      const outcome = await status(ctx, createFakeEntryPoint({ ...beforeFinalizedExpiry, latestSequence: BigInt(0) }).reader);
      expect(outcome.outcome === "ok" && outcome.attempt.state).toBe("submitted");
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
          const next = await ctx.paymentStore.reserve({ appUserId: "app-user-1", safeAddress: SENDER, recipient: "0x4444444444444444444444444444444444444444", amountBaseUnits: "1", chainId: 84532, tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" });
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
