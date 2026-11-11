// @vitest-environment node
import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createPublicClient, custom, encodeAbiParameters } from "viem";
import { baseSepolia } from "viem/chains";
import { createInMemoryRealAccountRegistry } from "@/lib/real/server/registry";
import { createSessionPayload, serializeSession } from "@/lib/real/server/session";
import { createInMemoryPaymentAttemptStore, type PaymentAttemptStore } from "@/lib/real/server/payment-attempts";
import { SAFE_OP_VALIDITY_SECONDS } from "@/lib/real/payments/validity";
import { freshRateLimiter } from "./fixtures/rate-limit";

/**
 * L-2 A+B — pre-reservation chain-clock validation and post-prepare local
 * exception safety. Everything is local: the in-memory payment store, a faked
 * chain RPC (balance only), a mocked chain-clock reader and a mocked Pimlico
 * module. Nothing leaves the process.
 */

const SECRET = "test-session-secret";
const OWNER_ADDRESS = "0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF";
const SAFE_ADDRESS = "0xd9a4c22fb34dc74317edc8006140d66c8fa03266";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const BALANCE_OF_SELECTOR = "0x70a08231";
const DECIMALS_SELECTOR = "0x313ce567";
const SAFE_PREPARE_FAILED = "Could not prepare this payment right now. Try again in a moment.";

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO_POW_48 = ONE << BigInt(48);
const UINT48_MAX = TWO_POW_48 - ONE;
const BIGINT_COLUMN_MAX = (ONE << BigInt(63)) - ONE;
const VALID_TIMESTAMP = BigInt(1_900_000_000);
const VALID_NUMBER = BigInt(47_000_000);

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

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  clock: vi.fn(),
  hash: vi.fn(),
}));

vi.mock("@/lib/real/server/pimlico", () => ({
  prepareCashTransferUserOperation: (...args: unknown[]) => mocks.prepare(...args),
  sendPreparedUserOperation: vi.fn(),
  fetchUserOperationReceipt: vi.fn(),
}));

vi.mock("@/lib/real/chain/entry-point", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/real/chain/entry-point")>();
  return { ...original, readLatestBlockClock: (...args: unknown[]) => mocks.clock(...args) };
});

vi.mock("@/lib/real/payments/hash", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/real/payments/hash")>();
  return { ...original, computeExpectedUserOperationHash: (...args: unknown[]) => mocks.hash(...args) };
});

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

/** The chain RPC answers only the balance read: the clock is mocked, so any other call would throw. */
function buildPublicClient() {
  return createPublicClient({
    chain: baseSepolia,
    transport: custom({
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === "eth_chainId") return `0x${baseSepolia.id.toString(16)}`;
        if (method === "eth_call") {
          const selector = ((params?.[0] ?? {}) as { data?: string }).data?.slice(0, 10);
          if (selector === BALANCE_OF_SELECTOR) return encodeAbiParameters([{ type: "uint256" }], [BigInt(100_000_000)]);
          if (selector === DECIMALS_SELECTOR) return encodeAbiParameters([{ type: "uint8" }], [6]);
        }
        throw new Error(`Unexpected method in an offline test: ${method}`);
      },
    }),
  });
}

type Harness = {
  store: PaymentAttemptStore;
  /** The store's own transition, captured before it was spied on. */
  realTransition: PaymentAttemptStore["transition"];
  transition: MockInstance<PaymentAttemptStore["transition"]>;
  reserve: MockInstance<PaymentAttemptStore["reserve"]>;
  run: () => ReturnType<typeof resolvePreparePayment>;
  rows: () => Promise<Awaited<ReturnType<PaymentAttemptStore["findLatestByAppUserId"]>>>;
};

async function harness(): Promise<Harness> {
  const registry = await seedAccount();
  const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);
  const store = createInMemoryPaymentAttemptStore();
  const realTransition = store.transition.bind(store);
  const transition = vi.spyOn(store, "transition");
  const reserve = vi.spyOn(store, "reserve");
  return {
    store,
    realTransition,
    transition,
    reserve,
    run: () =>
      resolvePreparePayment({
        cookieValue,
        sessionSecret: SECRET,
        registry,
        paymentStore: store,
        rateLimiter: freshRateLimiter(),
        publicClient: buildPublicClient(),
        pimlicoApiKey: "pim_test_key",
        recipient: { kind: "address", value: RECIPIENT } as PrepareRecipientSelector,
        amountBaseUnitsInput: "1000000",
      }),
    rows: () => store.findLatestByAppUserId("app-user-1"),
  };
}

beforeEach(() => {
  mocks.prepare.mockReset();
  mocks.clock.mockReset();
  mocks.hash.mockReset();
  mocks.prepare.mockImplementation(async () => ({ ...preparedFields }));
  mocks.clock.mockImplementation(async () => ({ number: VALID_NUMBER, timestamp: VALID_TIMESTAMP }));
  mocks.hash.mockImplementation(() => `0x${"ab".repeat(32)}`);
});

describe("L-2 A — the chain clock is validated before anything is reserved", () => {
  const rejectedClocks: [string, unknown][] = [
    ["a missing block number", { timestamp: VALID_TIMESTAMP }],
    ["a null block number", { number: null, timestamp: VALID_TIMESTAMP }],
    ["a missing timestamp", { number: VALID_NUMBER }],
    ["a null timestamp", { number: VALID_NUMBER, timestamp: null }],
    ["a string block number", { number: "47000000", timestamp: VALID_TIMESTAMP }],
    ["a JS-number block number", { number: 47_000_000, timestamp: VALID_TIMESTAMP }],
    ["a string timestamp", { number: VALID_NUMBER, timestamp: "1900000000" }],
    ["a JS-number timestamp", { number: VALID_NUMBER, timestamp: 1_900_000_000 }],
    ["a negative block number", { number: -ONE, timestamp: VALID_TIMESTAMP }],
    ["a negative timestamp", { number: VALID_NUMBER, timestamp: -ONE }],
    ["a block number beyond the BIGINT column", { number: BIGINT_COLUMN_MAX + ONE, timestamp: VALID_TIMESTAMP }],
    ["an oversized timestamp (beyond Number's safe range)", { number: VALID_NUMBER, timestamp: ONE << BigInt(60) }],
    ["a timestamp one second too large for uint48 once the window is added", { number: VALID_NUMBER, timestamp: UINT48_MAX - BigInt(SAFE_OP_VALIDITY_SECONDS) + ONE }],
    ["an empty object", {}],
    ["null", null],
    ["undefined", undefined],
    ["a string", "latest"],
  ];

  it.each(rejectedClocks)("refuses %s: safe failure, no reservation, no Pimlico call, no row, no transition", async (_name, clock) => {
    const h = await harness();
    mocks.clock.mockImplementation(async () => clock);

    const outcome = await h.run();

    expect(outcome).toEqual({ outcome: "prepare_failed", reason: SAFE_PREPARE_FAILED });
    expect(h.reserve).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(h.transition).not.toHaveBeenCalled();
    expect(await h.rows()).toBeNull();
  });

  it("accepts a representative clock and persists the exact validity window", async () => {
    const h = await harness();

    const outcome = await h.run();

    expect(outcome.outcome).toBe("ready");
    const row = await h.rows();
    expect(row?.state).toBe("awaiting_authorization");
    expect(row?.validUntil).toBe(Number(VALID_TIMESTAMP) + SAFE_OP_VALIDITY_SECONDS);
    expect(row?.prepareBlockNumber).toBe(VALID_NUMBER.toString());
    expect(h.reserve).toHaveBeenCalledTimes(1);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
  });

  it("does not reject legitimate block zero", async () => {
    const h = await harness();
    mocks.clock.mockImplementation(async () => ({ number: ZERO, timestamp: VALID_TIMESTAMP }));

    const outcome = await h.run();

    expect(outcome.outcome).toBe("ready");
    expect((await h.rows())?.prepareBlockNumber).toBe("0");
  });

  it("accepts the largest timestamp whose validUntil still fits uint48, with an exact (safe-integer) result", async () => {
    const h = await harness();
    const edge = UINT48_MAX - BigInt(SAFE_OP_VALIDITY_SECONDS);
    mocks.clock.mockImplementation(async () => ({ number: VALID_NUMBER, timestamp: edge }));

    const outcome = await h.run();

    expect(outcome.outcome).toBe("ready");
    const validUntil = (await h.rows())?.validUntil;
    expect(validUntil).toBe(Number(UINT48_MAX));
    expect(Number.isSafeInteger(validUntil)).toBe(true);
  });

  it("keeps the existing behavior when the clock read itself throws: safe failure, nothing reserved, no raw error text", async () => {
    const h = await harness();
    mocks.clock.mockImplementation(async () => {
      throw new Error("RPC unavailable: https://rpc.example/secret-key");
    });

    const outcome = await h.run();

    expect(outcome).toEqual({ outcome: "prepare_failed", reason: SAFE_PREPARE_FAILED });
    expect(JSON.stringify(outcome)).not.toContain("secret-key");
    expect(h.reserve).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(await h.rows()).toBeNull();
  });
});

describe("L-2 B — local post-prepare construction fails closed, once", () => {
  it("success path: one prepared -> awaiting_authorization transition and nothing else", async () => {
    const h = await harness();

    const outcome = await h.run();

    expect(outcome.outcome).toBe("ready");
    expect(h.transition).toHaveBeenCalledTimes(1);
    expect(h.transition).toHaveBeenCalledWith(expect.objectContaining({ from: "prepared", to: "awaiting_authorization" }));
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
  });

  it("a local hash error makes exactly one prepared -> failed CAS for this attempt, with the fixed reason", async () => {
    const h = await harness();
    mocks.hash.mockImplementation(() => {
      throw new Error("boom: https://api.pimlico.io/v2/84532/rpc?apikey=SECRET provider-data");
    });

    const outcome = await h.run();

    expect(outcome).toEqual({ outcome: "prepare_failed", reason: SAFE_PREPARE_FAILED });
    expect(JSON.stringify(outcome)).not.toMatch(/SECRET|boom|provider-data/);
    const row = await h.rows();
    expect(row?.state).toBe("failed");
    expect(row?.failureReason).toBe(SAFE_PREPARE_FAILED);
    expect(h.transition).toHaveBeenCalledTimes(1);
    expect(h.transition).toHaveBeenCalledWith({ id: row!.id, from: "prepared", to: "failed", patch: { failureReason: SAFE_PREPARE_FAILED } });
    // Never repeated: one reservation, one provider preparation, one hash attempt.
    expect(h.reserve).toHaveBeenCalledTimes(1);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.hash).toHaveBeenCalledTimes(1);
  });

  it("a local patch-construction error (a prepared field that cannot be stringified) takes the same single-CAS path", async () => {
    const h = await harness();
    mocks.prepare.mockImplementation(async () => ({ ...preparedFields, callGasLimit: undefined }));

    const outcome = await h.run();

    expect(outcome).toEqual({ outcome: "prepare_failed", reason: SAFE_PREPARE_FAILED });
    expect((await h.rows())?.state).toBe("failed");
    expect(h.transition).toHaveBeenCalledTimes(1);
    expect(h.transition).toHaveBeenCalledWith(expect.objectContaining({ from: "prepared", to: "failed" }));
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
  });

  it("a concurrent cancellation that already won stays cancelled: the cleanup CAS returns null and is neither retried nor forced", async () => {
    const h = await harness();
    mocks.hash.mockImplementation(() => {
      throw new Error("local failure");
    });
    const realTransition = h.realTransition;
    h.transition.mockImplementation(async (input: Parameters<PaymentAttemptStore["transition"]>[0]) => {
      if (input.to === "failed") {
        // The cancellation lands between the throw and the cleanup CAS.
        await realTransition({ id: input.id, from: "prepared", to: "cancelled" });
      }
      return realTransition(input);
    });

    const outcome = await h.run();

    expect(outcome).toEqual({ outcome: "prepare_failed", reason: SAFE_PREPARE_FAILED });
    expect((await h.rows())?.state).toBe("cancelled");
    const failedAttempts = h.transition.mock.calls.filter(([input]) => input.to === "failed");
    expect(failedAttempts).toHaveLength(1);
    expect(h.transition.mock.calls.filter(([input]) => input.to === "awaiting_authorization")).toHaveLength(0);
  });

  it("a cleanup write that throws fails closed with the fixed response, is not retried, and leaks nothing", async () => {
    const h = await harness();
    mocks.hash.mockImplementation(() => {
      throw new Error("local failure");
    });
    h.transition.mockImplementation(async () => {
      throw new Error('connection to "postgres://user:password@host/db" lost');
    });

    const outcome = await h.run();

    expect(outcome).toEqual({ outcome: "prepare_failed", reason: SAFE_PREPARE_FAILED });
    expect(JSON.stringify(outcome)).not.toMatch(/postgres|password/);
    expect(h.transition).toHaveBeenCalledTimes(1);
    expect(h.transition).toHaveBeenCalledWith(expect.objectContaining({ from: "prepared", to: "failed" }));
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
  });

  it("the cleanup only ever claims a row that is literally `prepared`: a row already past it is left untouched", async () => {
    const h = await harness();
    mocks.hash.mockImplementation(() => {
      throw new Error("local failure");
    });
    const realTransition = h.realTransition;
    h.transition.mockImplementation(async (input: Parameters<PaymentAttemptStore["transition"]>[0]) => {
      if (input.to === "failed") await realTransition({ id: input.id, from: "prepared", to: "awaiting_authorization" });
      return realTransition(input);
    });

    await h.run();

    // The cleanup CAS was from "prepared"; it lost, so the later state survives.
    expect((await h.rows())?.state).toBe("awaiting_authorization");
    expect(h.transition.mock.calls.every(([input]) => input.from === "prepared")).toBe(true);
  });

  it("the final prepared -> awaiting_authorization write is NOT inside the cleanup: if it throws, no prepared -> failed follows", async () => {
    const h = await harness();
    h.transition.mockImplementation(async () => {
      throw new Error("write outcome uncertain");
    });

    await expect(h.run()).rejects.toThrow("write outcome uncertain");

    expect(h.transition).toHaveBeenCalledTimes(1);
    expect(h.transition).toHaveBeenCalledWith(expect.objectContaining({ from: "prepared", to: "awaiting_authorization" }));
    expect(h.transition.mock.calls.some(([input]) => input.to === "failed")).toBe(false);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
  });

  it("the final write returning null (a lost CAS) keeps its existing answer and triggers no cleanup", async () => {
    const h = await harness();
    h.transition.mockImplementation(async () => null);

    const outcome = await h.run();

    expect(outcome).toEqual({ outcome: "prepare_failed", reason: "Could not persist the prepared payment." });
    expect(h.transition).toHaveBeenCalledTimes(1);
  });
});

describe("L-2 — existing prepare-failure behavior is unchanged", () => {
  beforeEach(() => {
    mocks.hash.mockImplementation(() => `0x${"ab".repeat(32)}`);
  });

  it("a provider preparation failure (the L-1a / calldata-binding path) still fails the row once with the fixed reason and never reaches hashing", async () => {
    const h = await harness();
    mocks.prepare.mockImplementation(async () => {
      throw new Error("PreparedCallDataMismatchError https://api.pimlico.io/?apikey=SECRET");
    });

    const outcome = await h.run();

    expect(outcome).toEqual({ outcome: "prepare_failed", reason: SAFE_PREPARE_FAILED });
    expect(JSON.stringify(outcome)).not.toContain("SECRET");
    expect((await h.rows())?.state).toBe("failed");
    expect(h.transition).toHaveBeenCalledTimes(1);
    expect(h.transition).toHaveBeenCalledWith(expect.objectContaining({ from: "prepared", to: "failed", patch: { failureReason: SAFE_PREPARE_FAILED } }));
    expect(mocks.hash).not.toHaveBeenCalled();
  });

  it("a sender mismatch still fails with its own reason and never reaches hashing", async () => {
    const h = await harness();
    mocks.prepare.mockImplementation(async () => ({ ...preparedFields, sender: "0x1111111111111111111111111111111111111111" }));

    const outcome = await h.run();

    expect(outcome.outcome).toBe("prepare_failed");
    expect((await h.rows())?.state).toBe("failed");
    expect(h.transition).toHaveBeenCalledTimes(1);
    expect(mocks.hash).not.toHaveBeenCalled();
  });
});
