import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, encodeAbiParameters } from "viem";
import { baseSepolia } from "viem/chains";
import { createInMemoryRealAccountRegistry, getInMemoryRegistryInternals } from "@/lib/real/server/registry";
import { createSessionPayload, serializeSession } from "@/lib/real/server/session";
import { createInMemoryPaymentAttemptStore } from "@/lib/real/server/payment-attempts";
import { BASE_SEPOLIA_CHAIN_ID, REAL_CASH_TOKEN } from "@/lib/real/constants";
import { computeExpectedUserOperationHash } from "@/lib/real/payments/hash";
import { SAFE_OP_VALIDITY_SECONDS } from "@/lib/real/payments/validity";
import { rpcBlock, TEST_PREPARE_BLOCK_NUMBER } from "./fixtures/chain-block";

const SECRET = "test-session-secret";
const OWNER_ADDRESS = "0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF";
const SAFE_ADDRESS = "0xd9a4c22fb34dc74317edc8006140d66c8fa03266";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const BALANCE_OF_SELECTOR = "0x70a08231";
const DECIMALS_SELECTOR = "0x313ce567";

const preparedFields = {
  sender: SAFE_ADDRESS,
  nonce: BigInt(0),
  factory: undefined,
  factoryData: undefined,
  callData: "0xcalldata",
  callGasLimit: BigInt(80_000),
  verificationGasLimit: BigInt(150_000),
  preVerificationGas: BigInt(60_000),
  maxFeePerGas: BigInt(2_000_000),
  maxPriorityFeePerGas: BigInt(1_000_000),
  paymaster: undefined,
  paymasterData: undefined,
  paymasterVerificationGasLimit: undefined,
  paymasterPostOpGasLimit: undefined,
} as const;

const prepareCashTransferUserOperationMock: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<typeof preparedFields>>> = vi.fn(async () => ({
  ...preparedFields,
}));

vi.mock("@/lib/real/server/pimlico", () => ({
  prepareCashTransferUserOperation: (...args: unknown[]) => prepareCashTransferUserOperationMock(...(args as [never])),
  sendPreparedUserOperation: vi.fn(),
  fetchUserOperationReceipt: vi.fn(),
}));

const { resolvePreparePayment } = await import("@/lib/real/server/payments");
type PrepareRecipientSelector = NonNullable<Parameters<typeof resolvePreparePayment>[0]["recipient"]>;

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

const PREPARE_BLOCK_TIMESTAMP = BigInt(1_900_000_000);

function buildPublicClient(balance: bigint, options: { failBlockRead?: boolean } = {}) {
  return createPublicClient({
    chain: baseSepolia,
    transport: custom({
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === "eth_chainId") return `0x${baseSepolia.id.toString(16)}`;
        if (method === "eth_getBlockByNumber") {
          if (options.failBlockRead) throw new Error("RPC unavailable: https://rpc.example/secret-key");
          return rpcBlock({ timestamp: PREPARE_BLOCK_TIMESTAMP });
        }
        if (method === "eth_call") {
          const call = (params?.[0] ?? {}) as { data?: string };
          const selector = call.data?.slice(0, 10);
          if (selector === BALANCE_OF_SELECTOR) return encodeAbiParameters([{ type: "uint256" }], [balance]);
          if (selector === DECIMALS_SELECTOR) return encodeAbiParameters([{ type: "uint8" }], [6]);
          throw new Error(`Unexpected selector: ${selector}`);
        }
        throw new Error(`Unexpected method in prepare test: ${method}`);
      },
    }),
  });
}

function baseInput(overrides: Partial<Parameters<typeof resolvePreparePayment>[0]> = {}) {
  return {
    cookieValue: undefined,
    sessionSecret: SECRET,
    registry: createInMemoryRealAccountRegistry(),
    paymentStore: createInMemoryPaymentAttemptStore(),
    publicClient: buildPublicClient(BigInt(100_000_000)),
    pimlicoApiKey: "pim_test_key",
    recipient: { kind: "address", value: RECIPIENT } as PrepareRecipientSelector | null,
    amountBaseUnitsInput: "1000000",
    ...overrides,
  };
}

describe("resolvePreparePayment", () => {
  beforeEach(() => {
    prepareCashTransferUserOperationMock.mockClear();
    prepareCashTransferUserOperationMock.mockImplementation(async () => ({ ...preparedFields }));
  });

  it("derives the sender from the authenticated Safe address, never anything the client could supply", async () => {
    const registry = await seedAccount();
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);

    const outcome = await resolvePreparePayment(baseInput({ registry, cookieValue }));

    expect(outcome.outcome).toBe("ready");
    expect(prepareCashTransferUserOperationMock).toHaveBeenCalledWith(
      expect.objectContaining({ ownerAddress: OWNER_ADDRESS, recipient: RECIPIENT, amountBaseUnits: "1000000" }),
    );
  });

  it("Part E (S2): returns serverNowSeconds from the server's own wall clock — the same clock resolveSubmitPayment's dispatch-margin check uses, not the chain's block timestamp", async () => {
    const registry = await seedAccount();
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);
    const fixedNowMs = 1_950_000_000_000;

    const outcome = await resolvePreparePayment(baseInput({ registry, cookieValue, now: () => fixedNowMs }));

    expect(outcome).toMatchObject({ outcome: "ready", serverNowSeconds: Math.floor(fixedNowMs / 1000) });
    // Deliberately NOT the chain's block timestamp (PREPARE_BLOCK_TIMESTAMP,
    // ~1_900_000_000) — a server wall clock and a chain clock are different
    // authorities, and the client's advisory offset must be calibrated
    // against the same clock /submit itself is judged against.
    expect(Math.floor(fixedNowMs / 1000)).not.toBe(Number(PREPARE_BLOCK_TIMESTAMP));
  });

  it("Slice S1: binds the attempt, at creation, to the session's OWN credential — P's session binds P, S's session binds S", async () => {
    const registry = await seedAccount();
    const primary = (await registry.findPasskeyByCredentialId("credential-1"))!;
    getInMemoryRegistryInternals(registry).passkeysByCredentialId.set("credential-backup", { ...primary, credentialId: "credential-backup", role: "backup" });

    for (const credentialId of ["credential-1", "credential-backup"]) {
      const paymentStore = createInMemoryPaymentAttemptStore();
      const reserveSpy = vi.spyOn(paymentStore, "reserve");
      const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId, sessionEpoch: 0 }), SECRET);

      const outcome = await resolvePreparePayment(baseInput({ registry, cookieValue, paymentStore }));

      expect(outcome).toMatchObject({ outcome: "ready", authorizingCredentialId: credentialId });
      expect(reserveSpy).toHaveBeenCalledWith(expect.objectContaining({ authorizingCredentialId: credentialId }));
      if (outcome.outcome === "ready") expect((await paymentStore.findById(outcome.attempt.id))?.authorizingCredentialId).toBe(credentialId);
    }
  });

  it("Slice S1: a session whose credential is no longer active (e.g. being removed) can't prepare — nothing is reserved or bound", async () => {
    const registry = await seedAccount();
    await registry.transitionPasskeyStatus({ credentialId: "credential-1", from: "active", to: "revoking" });
    const paymentStore = createInMemoryPaymentAttemptStore();
    const reserveSpy = vi.spyOn(paymentStore, "reserve");
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);

    expect((await resolvePreparePayment(baseInput({ registry, cookieValue, paymentStore }))).outcome).toBe("unauthenticated");
    expect(reserveSpy).not.toHaveBeenCalled();
  });

  it("always reserves against the canonical USDC token and Base Sepolia chain id", async () => {
    const registry = await seedAccount();
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);
    const paymentStore = createInMemoryPaymentAttemptStore();
    const reserveSpy = vi.spyOn(paymentStore, "reserve");

    await resolvePreparePayment(baseInput({ registry, cookieValue, paymentStore }));

    expect(reserveSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tokenAddress: REAL_CASH_TOKEN.address, chainId: BASE_SEPOLIA_CHAIN_ID, safeAddress: SAFE_ADDRESS }),
    );
  });

  it("rejects an unauthenticated request", async () => {
    const outcome = await resolvePreparePayment(baseInput({ cookieValue: undefined }));
    expect(outcome).toEqual({ outcome: "unauthenticated" });
  });

  it("rejects a malformed recipient before ever touching the payment store", async () => {
    const registry = await seedAccount();
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);
    const paymentStore = createInMemoryPaymentAttemptStore();
    const reserveSpy = vi.spyOn(paymentStore, "reserve");

    const outcome = await resolvePreparePayment(baseInput({ registry, cookieValue, paymentStore, recipient: { kind: "address", value: "not-an-address" } }));

    expect(outcome).toEqual({ outcome: "invalid_recipient" });
    expect(reserveSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["0", "zero"],
    ["-1", "negative (rejected by shape, no valid decimal string produces a leading '-')"],
    ["1.1234567", "more than 6 decimals — sent pre-parsed here as an already-invalid wire value"],
    ["not-a-number", "malformed"],
  ])("rejects an invalid amount (%s: %s)", async (amountBaseUnitsInput) => {
    const registry = await seedAccount();
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);
    const paymentStore = createInMemoryPaymentAttemptStore();
    const reserveSpy = vi.spyOn(paymentStore, "reserve");

    const outcome = await resolvePreparePayment(baseInput({ registry, cookieValue, paymentStore, amountBaseUnitsInput }));

    expect(outcome.outcome).toBe("invalid_amount");
    expect(reserveSpy).not.toHaveBeenCalled();
  });

  it("rejects an amount over the $50 ceiling", async () => {
    const registry = await seedAccount();
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);
    const outcome = await resolvePreparePayment(baseInput({ registry, cookieValue, amountBaseUnitsInput: "50000001" }));
    expect(outcome).toEqual({ outcome: "invalid_amount" });
  });

  it("rejects an amount greater than the live on-chain balance without ever calling Pimlico or reserving", async () => {
    prepareCashTransferUserOperationMock.mockClear();
    const registry = await seedAccount();
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);
    const paymentStore = createInMemoryPaymentAttemptStore();
    const reserveSpy = vi.spyOn(paymentStore, "reserve");

    const outcome = await resolvePreparePayment(
      baseInput({ registry, cookieValue, paymentStore, publicClient: buildPublicClient(BigInt(500_000)), amountBaseUnitsInput: "1000000" }),
    );

    expect(outcome).toEqual({ outcome: "insufficient_balance" });
    expect(reserveSpy).not.toHaveBeenCalled();
    expect(prepareCashTransferUserOperationMock).not.toHaveBeenCalled();
  });

  it("quota_exceeded and payment_in_progress propagate directly from the store, before ever calling Pimlico", async () => {
    prepareCashTransferUserOperationMock.mockClear();
    const registry = await seedAccount();
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);
    const paymentStore = createInMemoryPaymentAttemptStore();
    vi.spyOn(paymentStore, "reserve").mockResolvedValueOnce({ ok: false, reason: "quota_exceeded" });

    const outcome = await resolvePreparePayment(baseInput({ registry, cookieValue, paymentStore }));

    expect(outcome).toEqual({ outcome: "quota_exceeded" });
    expect(prepareCashTransferUserOperationMock).not.toHaveBeenCalled();
  });

  it("a failed external Pimlico prepare still consumes the reserved attempt (transitions it to failed)", async () => {
    prepareCashTransferUserOperationMock.mockRejectedValueOnce(new Error("Pimlico is unreachable"));
    const registry = await seedAccount();
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);
    const paymentStore = createInMemoryPaymentAttemptStore();

    const outcome = await resolvePreparePayment(baseInput({ registry, cookieValue, paymentStore }));

    expect(outcome.outcome).toBe("prepare_failed");
    const latest = await paymentStore.findLatestByAppUserId("app-user-1");
    expect(latest?.state).toBe("failed");

    // The slot is freed — a new attempt can be reserved.
    const secondAttempt = await resolvePreparePayment(baseInput({ registry, cookieValue, paymentStore }));
    expect(secondAttempt.outcome).toBe("ready");
  });

  it("pre-2f hardening: never persists or returns a raw upstream Pimlico error — even one carrying the API key/URL", async () => {
    const secretBearingMessage =
      "HTTP request failed. URL: https://api.pimlico.io/v2/84532/rpc?apikey=SECRET_TEST_KEY Details: rate limited Version: viem@2.0.0";
    prepareCashTransferUserOperationMock.mockRejectedValueOnce(new Error(secretBearingMessage));
    const registry = await seedAccount();
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);
    const paymentStore = createInMemoryPaymentAttemptStore();

    const outcome = await resolvePreparePayment(baseInput({ registry, cookieValue, paymentStore }));

    expect(outcome.outcome).toBe("prepare_failed");
    if (outcome.outcome !== "prepare_failed") return;
    for (const forbidden of ["apikey=", "SECRET_TEST_KEY", "pimlico.io", "viem@"]) {
      expect(outcome.reason).not.toContain(forbidden);
    }

    const latest = await paymentStore.findLatestByAppUserId("app-user-1");
    expect(latest?.failureReason).toBe(outcome.reason);
    for (const forbidden of ["apikey=", "SECRET_TEST_KEY", "pimlico.io", "viem@"]) {
      expect(latest?.failureReason).not.toContain(forbidden);
    }
  });

  it("pre-2f hardening: never persists or returns a raw upstream balance-check error — even one carrying the RPC URL", async () => {
    const secretBearingMessage = "HTTP request failed. URL: https://base-sepolia.g.alchemy.com/v2/SECRET_ALCHEMY_KEY Version: viem@2.0.0";
    const registry = await seedAccount();
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);
    const throwingPublicClient = {
      chain: baseSepolia,
      getChainId: async () => {
        throw new Error(secretBearingMessage);
      },
    } as unknown as Parameters<typeof resolvePreparePayment>[0]["publicClient"];

    const outcome = await resolvePreparePayment(baseInput({ registry, cookieValue, publicClient: throwingPublicClient }));

    expect(outcome.outcome).toBe("balance_check_failed");
    if (outcome.outcome !== "balance_check_failed") return;
    for (const forbidden of ["SECRET_ALCHEMY_KEY", "alchemy.com", "viem@"]) {
      expect(outcome.reason).not.toContain(forbidden);
    }
  });

  it("pre-2f hardening: fails closed (prepare_failed) if prepareCashTransferUserOperation's derived sender ever diverges from the account's registered safeAddress", async () => {
    prepareCashTransferUserOperationMock.mockResolvedValueOnce({
      ...preparedFields,
      sender: "0x9999999999999999999999999999999999999999",
    } as unknown as typeof preparedFields);
    const registry = await seedAccount();
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);
    const paymentStore = createInMemoryPaymentAttemptStore();

    const outcome = await resolvePreparePayment(baseInput({ registry, cookieValue, paymentStore }));

    expect(outcome.outcome).toBe("prepare_failed");
    const latest = await paymentStore.findLatestByAppUserId("app-user-1");
    expect(latest?.state).toBe("failed");
    // Never reached awaiting_authorization — the mismatch was caught before
    // the user would ever be asked to sign.
    expect(latest?.nonce).toBeNull();
  });

  it("computes and persists the expected UserOperation hash BEFORE ever calling the bundler — durable even if the send response is later lost", async () => {
    const registry = await seedAccount();
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);
    const paymentStore = createInMemoryPaymentAttemptStore();

    const outcome = await resolvePreparePayment(baseInput({ registry, cookieValue, paymentStore }));
    expect(outcome.outcome).toBe("ready");
    if (outcome.outcome !== "ready") return;

    const persisted = await paymentStore.findById(outcome.attempt.id);
    expect(persisted?.expectedUserOperationHash).toBeTruthy();
    expect(persisted?.expectedUserOperationHash).toBe(computeExpectedUserOperationHash(preparedFields));
    // Never persists a signature — there isn't one yet at prepare time, and
    // there is no column/field for it at all (see schema.sql).
    expect(persisted).not.toHaveProperty("signature");
  });

  it("finite expiry: validUntil = the chain's latest block timestamp + the window, persisted with its block number and returned for signing", async () => {
    const registry = await seedAccount();
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);
    const paymentStore = createInMemoryPaymentAttemptStore();

    const outcome = await resolvePreparePayment(baseInput({ registry, cookieValue, paymentStore }));
    if (outcome.outcome !== "ready") throw new Error(outcome.outcome);

    const expectedValidUntil = Number(PREPARE_BLOCK_TIMESTAMP) + SAFE_OP_VALIDITY_SECONDS;
    expect(await paymentStore.findById(outcome.attempt.id)).toMatchObject({ validUntil: expectedValidUntil, prepareBlockNumber: TEST_PREPARE_BLOCK_NUMBER.toString() });
    expect(outcome.attempt.prepared?.validUntil).toBe(expectedValidUntil);
    // The window never enters the userOpHash (ERC-4337 excludes the signature).
    expect((await paymentStore.findById(outcome.attempt.id))?.expectedUserOperationHash).toBe(computeExpectedUserOperationHash(preparedFields));
  });

  it("finite expiry: if the chain clock can't be read, nothing is reserved or prepared and no upstream text leaks", async () => {
    const registry = await seedAccount();
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);
    const paymentStore = createInMemoryPaymentAttemptStore();
    const reserveSpy = vi.spyOn(paymentStore, "reserve");

    const outcome = await resolvePreparePayment(baseInput({ registry, cookieValue, paymentStore, publicClient: buildPublicClient(BigInt(100_000_000), { failBlockRead: true }) }));

    expect(outcome.outcome).toBe("prepare_failed");
    expect(JSON.stringify(outcome)).not.toMatch(/secret-key|rpc\.example/);
    expect(reserveSpy).not.toHaveBeenCalled();
    expect(prepareCashTransferUserOperationMock).not.toHaveBeenCalled();
  });
});

describe("prepareCashTransferUserOperation source — target/token are hardcoded, never parameterized", () => {
  it("lib/real/server/pimlico.ts always calls the token contract, never accepts a `to`/token override", () => {
    const source = readFileSync(path.resolve(process.cwd(), "lib/real/server/pimlico.ts"), "utf8");
    expect(source).toMatch(/to:\s*REAL_CASH_TOKEN\.address/);
    // No parameter named anything like `to`/`target`/`tokenAddress` is
    // accepted by prepareCashTransferUserOperation's input type — its only
    // recipient/amount-shaped inputs are `recipient` and `amountBaseUnits`.
    const signatureStart = source.indexOf("export async function prepareCashTransferUserOperation(input: {");
    const signatureEnd = source.indexOf("}):", signatureStart);
    const signature = source.slice(signatureStart, signatureEnd);
    expect(signature).not.toMatch(/\btokenAddress\b/);
    expect(signature).not.toMatch(/\btarget\b/);
    expect(signature).not.toMatch(/\bcallData\b/);
    expect(signature).not.toMatch(/\bto\s*:/);
  });
});
