// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { createInMemoryAccountHandleStore } from "@/lib/real/server/account-handles";
import { createInMemoryPaymentAttemptStore, type PaymentAttemptStore } from "@/lib/real/server/payment-attempts";
import { createInMemoryRealAccountRegistry } from "@/lib/real/server/registry";
import { createSessionPayload, serializeSession } from "@/lib/real/server/session";
import type { RealServerConfig } from "@/lib/real/server/config";
import type { ProviderBudgetLimiter } from "@/lib/real/server/rate-limit";
import { REAL_CASH_TOKEN } from "@/lib/real/constants";
import { createReadOnlyOwnerAccount, createRealSafeAccount } from "@/lib/real/account/safe";
import { PreparedCallDataMismatchError, prepareCashTransferUserOperation } from "@/lib/real/server/pimlico";
import { resolvePreparePayment, resolveSubmitPayment } from "@/lib/real/server/payments";
import { rpcBlock } from "./fixtures/chain-block";
import { freshRateLimiter } from "./fixtures/rate-limit";

/**
 * Payment integrity: the prepared UserOperation's callData must be exactly
 * the Safe execution of the server-reserved Cash transfer.
 *
 * viem's prepareUserOperation (2.56.8) sets request.callData from the Safe
 * account's local encoding, then spreads the raw pm_getPaymasterStubData and
 * pm_getPaymasterData JSON-RPC results over the request. A paymaster response
 * that carries a `callData` key therefore replaces the local encoding. These
 * tests run the REAL pimlico.ts / viem / permissionless code; only the network
 * is faked:
 *   - the chain RPC through a viem `custom` transport;
 *   - the Pimlico JSON-RPC endpoint through a stubbed global `fetch` that
 *     answers only https://api.pimlico.io/... locally and throws for any
 *     other URL. Nothing leaves the process.
 *
 * The expected encoding is re-derived HERE from an independently declared
 * Safe4337Module ABI, not from the production encoder, so a wrong production
 * encoder cannot make these tests agree with itself.
 */

const SECRET = "7f3c9a1e5b2d4f60a8c7e9b1d3f5a7c90e2b4d6f8a1c3e5b7d9f0a2c4e6b8d0f";
const PAYER_OWNER = getAddress("0xf6c3fe6de636f0d8f421d5485d1a64ff3628cfaf");
const RECIPIENT_OWNER = "0x3333333333333333333333333333333333333333";
const RECIPIENT_SAFE = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01"; // mixed case, as stored
const RECIPIENT_SAFE_LOWER = RECIPIENT_SAFE.toLowerCase() as Address; // what the handle reservation records
const ADDRESS_RECIPIENT = "0x2222222222222222222222222222222222222222" as Address;
const ATTACKER = "0x000000000000000000000000000000000000dEaD" as Address;
const OTHER_TOKEN = "0x4444444444444444444444444444444444444444" as Address;
const AMOUNT = "1000000";

const BALANCE_OF_SELECTOR = "0x70a08231";
const DECIMALS_SELECTOR = "0x313ce567";
const GET_NONCE_SELECTOR = "0x35567e1a";
// Any well-formed ABI `bytes` return: enough for toSafeSmartAccount's
// proxyCreationCode() read to derive a deterministic (test-only) Safe address.
const DUMMY_BYTES_RETURN = encodeAbiParameters([{ type: "bytes" }], ["0x600a600c600039600a6000f3" as Hex]);

const PAYMASTER = "0x7777777777777777777777777777777777777777";
const PAYMASTER_DATA = `0x${"ab".repeat(20)}`;

// --- Independent encoders (test-side truth) ---------------------------------

const SAFE_4337_EXECUTE_ABI = [
  {
    type: "function",
    name: "executeUserOpWithErrorString",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "executeUserOp",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
    ],
    outputs: [],
  },
] as const;

const ERC20_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const transferData = (to: Address, amount: bigint) => encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [to, amount] });

function safeExec(input: { to: Address; value?: bigint; data: Hex; operation?: number; fn?: "executeUserOpWithErrorString" | "executeUserOp" }): Hex {
  return encodeFunctionData({
    abi: SAFE_4337_EXECUTE_ABI,
    functionName: input.fn ?? "executeUserOpWithErrorString",
    args: [input.to, input.value ?? BigInt(0), input.data, input.operation ?? 0],
  });
}

const expectedCallDataFor = (recipient: Address, amount: string) => safeExec({ to: REAL_CASH_TOKEN.address, data: transferData(recipient, BigInt(amount)) });

function expectDecodesToReservedTransfer(callData: string, recipient: string, amount: string) {
  const outer = decodeFunctionData({ abi: SAFE_4337_EXECUTE_ABI, data: callData as Hex });
  expect(outer.functionName).toBe("executeUserOpWithErrorString");
  const [to, value, data, operation] = outer.args;
  expect(to.toLowerCase()).toBe(REAL_CASH_TOKEN.address.toLowerCase());
  expect(value).toBe(BigInt(0));
  expect(operation).toBe(0);
  const inner = decodeFunctionData({ abi: ERC20_ABI, data });
  expect(inner.functionName).toBe("transfer");
  expect((inner.args[0] as string).toLowerCase()).toBe(recipient.toLowerCase());
  expect(inner.args[1]).toBe(BigInt(amount));
}

// --- Offline network fakes ---------------------------------------------------

function publicClient() {
  return createPublicClient({
    chain: baseSepolia,
    transport: custom({
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === "eth_chainId") return `0x${baseSepolia.id.toString(16)}`;
        if (method === "eth_getBlockByNumber") return rpcBlock();
        if (method === "eth_getCode") return "0x"; // Safe not yet deployed -> factory/factoryData derived locally
        if (method === "eth_call") {
          const selector = ((params?.[0] ?? {}) as { data?: string }).data?.slice(0, 10);
          if (selector === BALANCE_OF_SELECTOR) return encodeAbiParameters([{ type: "uint256" }], [BigInt(100_000_000)]);
          if (selector === DECIMALS_SELECTOR) return encodeAbiParameters([{ type: "uint8" }], [6]);
          if (selector === GET_NONCE_SELECTOR) return encodeAbiParameters([{ type: "uint256" }], [BigInt(0)]);
          return DUMMY_BYTES_RETURN; // proxyCreationCode()
        }
        throw new Error(`Unexpected public RPC call in an offline test: ${method}`);
      },
    }),
  });
}

type PaymasterScript = {
  /** Extra keys merged into the pm_getPaymasterStubData result. */
  stubExtra?: Record<string, unknown>;
  /** isFinal on the stub result. true => viem skips pm_getPaymasterData. */
  stubIsFinal?: boolean;
  /** Extra keys merged into the pm_getPaymasterData result. */
  finalExtra?: Record<string, unknown>;
};

const rpcLog: { method: string; params: unknown[] }[] = [];
let script: PaymasterScript = {};

const hex = (n: number) => `0x${n.toString(16)}`;

function answerPimlico(method: string): unknown {
  switch (method) {
    case "pimlico_getUserOperationGasPrice": {
      const tier = { maxFeePerGas: hex(2_000_000), maxPriorityFeePerGas: hex(1_000_000) };
      return { slow: tier, standard: tier, fast: tier };
    }
    case "pm_getPaymasterStubData":
      return {
        paymaster: PAYMASTER,
        paymasterData: PAYMASTER_DATA,
        paymasterVerificationGasLimit: hex(50_000),
        paymasterPostOpGasLimit: hex(10_000),
        ...(script.stubIsFinal ? { isFinal: true } : {}),
        ...script.stubExtra,
      };
    case "eth_estimateUserOperationGas":
      return {
        preVerificationGas: hex(60_000),
        verificationGasLimit: hex(150_000),
        callGasLimit: hex(80_000),
        paymasterVerificationGasLimit: hex(50_000),
        paymasterPostOpGasLimit: hex(10_000),
      };
    case "pm_getPaymasterData":
      return {
        paymaster: PAYMASTER,
        paymasterData: PAYMASTER_DATA,
        paymasterVerificationGasLimit: hex(50_000),
        paymasterPostOpGasLimit: hex(10_000),
        ...script.finalExtra,
      };
    default:
      throw new Error(`Unexpected Pimlico method in an offline test: ${method}`);
  }
}

const fakeFetch = vi.fn(async (url: unknown, init?: { body?: unknown }) => {
  const href = typeof url === "string" ? url : url instanceof URL ? url.href : String((url as { url?: string })?.url);
  if (!href.startsWith("https://api.pimlico.io/")) throw new Error(`Network access refused in an offline test: ${href}`);
  const body = JSON.parse(String(init?.body));
  const one = (req: { id: number; method: string; params?: unknown[] }) => {
    rpcLog.push({ method: req.method, params: req.params ?? [] });
    return { jsonrpc: "2.0", id: req.id, result: answerPimlico(req.method) };
  };
  const payload = Array.isArray(body) ? body.map(one) : one(body);
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
});

const methodsCalled = () => rpcLog.map((entry) => entry.method);
const callDataSentTo = (method: string) => rpcLog.filter((entry) => entry.method === method).map((entry) => (entry.params[0] as { callData?: string }).callData);

// --- World ------------------------------------------------------------------

let payerSafe: Address;

async function world() {
  const registry = createInMemoryRealAccountRegistry();
  const seed = (n: number, owner: string, safe: string) =>
    registry.createAccountWithPasskey({
      account: { appUserId: `app-user-${n}`, subOrganizationId: `sub-org-${n}`, turnkeyUserId: `turnkey-user-${n}`, walletId: `wallet-${n}`, walletAccountId: `wallet-account-${n}`, ownerAddress: owner, safeAddress: safe, accountConfigVersion: 1 },
      passkey: { credentialId: `credential-${n}`, appUserId: `app-user-${n}`, credentialPublicKey: "cose", userHandle: `user-handle-${n}`, counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false },
    });
  await seed(1, PAYER_OWNER, payerSafe);
  await seed(2, RECIPIENT_OWNER, RECIPIENT_SAFE);
  const payments = createInMemoryPaymentAttemptStore(registry);
  const handles = createInMemoryAccountHandleStore(registry);
  await handles.claim({ handle: "maya_chen", appUserId: "app-user-2", credentialId: "credential-2" });
  return { registry, payments, rateLimiter: freshRateLimiter() };
}
type World = Awaited<ReturnType<typeof world>>;

const PAYER_COOKIE = () => serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);

function prepare(w: World, recipient: Parameters<typeof resolvePreparePayment>[0]["recipient"]) {
  return resolvePreparePayment({
    cookieValue: PAYER_COOKIE(),
    sessionSecret: SECRET,
    registry: w.registry,
    paymentStore: w.payments,
    rateLimiter: w.rateLimiter,
    publicClient: publicClient(),
    pimlicoApiKey: "pim_test_key",
    recipient,
    amountBaseUnitsInput: AMOUNT,
  });
}

const byAddress = { kind: "address" as const, value: ADDRESS_RECIPIENT };
const byHandle = { kind: "handle" as const, handle: "maya_chen" };

async function latest(store: PaymentAttemptStore) {
  const attempt = await store.findLatestByAppUserId("app-user-1");
  if (!attempt) throw new Error("no attempt recorded");
  return attempt;
}

const SAFE_PREPARE_FAILED = "Could not prepare this payment right now. Try again in a moment.";

beforeEach(async () => {
  rpcLog.length = 0;
  script = {};
  fakeFetch.mockClear();
  vi.stubGlobal("fetch", fakeFetch);
  const account = await createRealSafeAccount({ owner: createReadOnlyOwnerAccount(PAYER_OWNER), publicClient: publicClient() });
  payerSafe = account.address;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- Substitutions a hostile paymaster response might carry -----------------

const reservedTransfer = transferData(ADDRESS_RECIPIENT, BigInt(AMOUNT));
const SUBSTITUTIONS: { name: string; callData: () => unknown }[] = [
  { name: "a different recipient", callData: () => safeExec({ to: REAL_CASH_TOKEN.address, data: transferData(ATTACKER, BigInt(AMOUNT)) }) },
  { name: "a different amount", callData: () => safeExec({ to: REAL_CASH_TOKEN.address, data: transferData(ADDRESS_RECIPIENT, BigInt(AMOUNT) * BigInt(1000)) }) },
  { name: "a different target contract", callData: () => safeExec({ to: OTHER_TOKEN, data: reservedTransfer }) },
  { name: "a DELEGATECALL operation", callData: () => safeExec({ to: REAL_CASH_TOKEN.address, data: reservedTransfer, operation: 1 }) },
  { name: "a non-zero call value", callData: () => safeExec({ to: REAL_CASH_TOKEN.address, data: reservedTransfer, value: BigInt(1) }) },
  { name: "a different token function (approve)", callData: () => safeExec({ to: REAL_CASH_TOKEN.address, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [ATTACKER, BigInt(2) ** BigInt(256) - BigInt(1)] }) }) },
  { name: "the alternate Safe entry point (executeUserOp)", callData: () => safeExec({ to: REAL_CASH_TOKEN.address, data: reservedTransfer, fn: "executeUserOp" }) },
  { name: "the expected encoding with trailing bytes appended", callData: () => `${expectedCallDataFor(ADDRESS_RECIPIENT, AMOUNT)}00` },
  { name: "empty callData", callData: () => "0x" },
  { name: "a non-string callData", callData: () => 12345 },
];

const INJECTION_PATHS: { name: string; arrange: (callData: unknown) => PaymasterScript; reached: string[] }[] = [
  { name: "stub data (isFinal: true — final data skipped)", arrange: (callData) => ({ stubIsFinal: true, stubExtra: { callData } }), reached: ["pm_getPaymasterStubData"] },
  { name: "stub data (isFinal: false — honest final data)", arrange: (callData) => ({ stubExtra: { callData } }), reached: ["pm_getPaymasterStubData", "pm_getPaymasterData"] },
  { name: "final data", arrange: (callData) => ({ finalExtra: { callData } }), reached: ["pm_getPaymasterStubData", "pm_getPaymasterData"] },
];

// --- Tests ------------------------------------------------------------------

describe("offline harness sanity", () => {
  it("refuses any non-Pimlico URL", async () => {
    await expect(fakeFetch("https://example.com/")).rejects.toThrow(/Network access refused/);
  });
});

describe("prepareCashTransferUserOperation — callData bound to the locally encoded Cash transfer", () => {
  const prepareDirect = () =>
    prepareCashTransferUserOperation({ publicClient: publicClient(), pimlicoApiKey: "pim_test_key", ownerAddress: PAYER_OWNER, recipient: ADDRESS_RECIPIENT, amountBaseUnits: AMOUNT });

  it("an ordinary sponsored preparation returns exactly the Safe execution of transfer(recipient, amount)", async () => {
    const prepared = await prepareDirect();
    expect(prepared.callData).toBe(expectedCallDataFor(ADDRESS_RECIPIENT, AMOUNT));
    expectDecodesToReservedTransfer(prepared.callData, ADDRESS_RECIPIENT, AMOUNT);
    expect(prepared.sender).toBe(payerSafe);
    expect(prepared.paymaster).toBe(PAYMASTER);
    expect(methodsCalled()).toEqual(expect.arrayContaining(["pimlico_getUserOperationGasPrice", "pm_getPaymasterStubData", "eth_estimateUserOperationGas", "pm_getPaymasterData"]));
  });

  it("the honest provider was always sent the locally encoded callData", async () => {
    await prepareDirect();
    for (const method of ["pm_getPaymasterStubData", "eth_estimateUserOperationGas", "pm_getPaymasterData"]) {
      expect(callDataSentTo(method)).toEqual([expectedCallDataFor(ADDRESS_RECIPIENT, AMOUNT)]);
    }
  });

  it("an echoed callData identical to the local encoding is accepted (well-formed and equal, not merely well-formed)", async () => {
    script = { finalExtra: { callData: expectedCallDataFor(ADDRESS_RECIPIENT, AMOUNT) } };
    const prepared = await prepareDirect();
    expect(prepared.callData).toBe(expectedCallDataFor(ADDRESS_RECIPIENT, AMOUNT));
  });

  it("the same bytes in a different hex letter case are refused (strict, fail-closed comparison)", async () => {
    const expected = expectedCallDataFor(ADDRESS_RECIPIENT, AMOUNT);
    script = { finalExtra: { callData: `0x${expected.slice(2).toUpperCase()}` } };
    await expect(prepareDirect()).rejects.toBeInstanceOf(PreparedCallDataMismatchError);
  });

  for (const path of INJECTION_PATHS) {
    for (const substitution of SUBSTITUTIONS) {
      it(`${path.name}: refuses ${substitution.name}`, async () => {
        script = path.arrange(substitution.callData());
        await expect(prepareDirect()).rejects.toBeInstanceOf(PreparedCallDataMismatchError);
        expect(methodsCalled()).toEqual(expect.arrayContaining(path.reached));
      });
    }
  }

  it("the mismatch error carries no provider-supplied text", async () => {
    script = { stubIsFinal: true, stubExtra: { callData: "0xdeadbeef-https://api.pimlico.io/?apikey=pim_test_key" } };
    const error = await prepareDirect().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PreparedCallDataMismatchError);
    expect(String((error as Error).message)).not.toMatch(/deadbeef|apikey|pim_test_key/);
  });
});

describe("resolvePreparePayment — a substituted economic action never becomes awaiting_authorization", () => {
  it("address recipient, honest provider: ready, and the persisted callData is the reserved transfer", async () => {
    const w = await world();
    const outcome = await prepare(w, byAddress);
    expect(outcome.outcome).toBe("ready");
    const attempt = await latest(w.payments);
    expect(attempt.state).toBe("awaiting_authorization");
    expect(attempt.callData).toBe(expectedCallDataFor(ADDRESS_RECIPIENT, AMOUNT));
    expectDecodesToReservedTransfer(attempt.callData!, attempt.recipient, attempt.amountBaseUnits);
    if (outcome.outcome === "ready") expect(outcome.attempt.prepared?.callData).toBe(attempt.callData);
  });

  it("@handle recipient, honest provider: ready, and the persisted callData pays the handle's Safe (never its owner)", async () => {
    const w = await world();
    const outcome = await prepare(w, byHandle);
    expect(outcome.outcome).toBe("ready");
    const attempt = await latest(w.payments);
    expect(attempt.recipient).toBe(RECIPIENT_SAFE.toLowerCase());
    expect(attempt.callData).toBe(expectedCallDataFor(RECIPIENT_SAFE_LOWER, AMOUNT));
    expectDecodesToReservedTransfer(attempt.callData!, RECIPIENT_SAFE, AMOUNT);
    expect(attempt.callData!.toLowerCase()).not.toContain(RECIPIENT_OWNER.slice(2).toLowerCase());
  });

  for (const [selectorName, selector] of [["address", byAddress], ["@handle", byHandle]] as const) {
    for (const path of INJECTION_PATHS) {
      for (const substitution of [SUBSTITUTIONS[0], SUBSTITUTIONS[1], SUBSTITUTIONS[3]]) {
        it(`${selectorName}, ${path.name}: ${substitution.name} -> prepare_failed, attempt failed, no callData persisted`, async () => {
          const w = await world();
          script = path.arrange(substitution.callData());
          const outcome = await prepare(w, selector);
          expect(outcome).toEqual({ outcome: "prepare_failed", reason: SAFE_PREPARE_FAILED });
          const attempt = await latest(w.payments);
          expect(attempt.state).toBe("failed");
          expect(attempt.failureReason).toBe(SAFE_PREPARE_FAILED);
          expect(attempt.callData).toBeNull();
          expect(attempt.expectedUserOperationHash).toBeNull();
          expect(attempt.paymaster).toBeNull();
        });
      }
    }
  }

  it("a reservation whose recorded amount differs from the validated amount fails closed before any Pimlico call", async () => {
    const w = await world();
    const store: PaymentAttemptStore = {
      ...w.payments,
      reserve: async (input) => {
        const reserved = await w.payments.reserve(input);
        return reserved.ok ? { ...reserved, attempt: { ...reserved.attempt, amountBaseUnits: "999000000" } } : reserved;
      },
    };
    const outcome = await prepare({ ...w, payments: store }, byAddress);
    expect(outcome).toEqual({ outcome: "prepare_failed", reason: SAFE_PREPARE_FAILED });
    expect(rpcLog).toEqual([]);
    const attempt = await latest(w.payments);
    expect(attempt.state).toBe("failed");
    expect(attempt.callData).toBeNull();
  });

  it("a refused attempt cannot advance to signing or submission (submit reports wrong_state before any provider work)", async () => {
    const w = await world();
    script = { stubIsFinal: true, stubExtra: { callData: SUBSTITUTIONS[0].callData() } };
    expect((await prepare(w, byAddress)).outcome).toBe("prepare_failed");
    const attempt = await latest(w.payments);
    rpcLog.length = 0;

    const budget: ProviderBudgetLimiter = { consume: vi.fn(async () => { throw new Error("budget must not be consulted"); }) } as unknown as ProviderBudgetLimiter;
    const submitted = await resolveSubmitPayment({
      cookieValue: PAYER_COOKIE(),
      sessionSecret: SECRET,
      registry: w.registry,
      paymentStore: w.payments,
      pimlicoApiKey: "pim_test_key",
      config: {} as RealServerConfig,
      providerBudgetLimiter: budget,
      attemptId: attempt.id,
      signature: `0x${"11".repeat(77)}`,
      activityId: "01a12620-1c25-7329-86d4-f8a86a1d8d90",
    });
    expect(submitted).toEqual({ outcome: "wrong_state", state: "failed" });
    expect(budget.consume).not.toHaveBeenCalled();
    expect(rpcLog).toEqual([]);
    expect((await w.payments.findById(attempt.id))?.state).toBe("failed");
  });

  it("existing failure/retry semantics: after a refused prepare the slot is free and an honest retry creates a NEW ready attempt", async () => {
    const w = await world();
    script = { finalExtra: { callData: SUBSTITUTIONS[1].callData() } };
    expect((await prepare(w, byAddress)).outcome).toBe("prepare_failed");
    const failed = await latest(w.payments);

    script = {};
    const retried = await prepare(w, byAddress);
    expect(retried.outcome).toBe("ready");
    const fresh = await latest(w.payments);
    expect(fresh.id).not.toBe(failed.id);
    expect(fresh.state).toBe("awaiting_authorization");
    expect(fresh.callData).toBe(expectedCallDataFor(ADDRESS_RECIPIENT, AMOUNT));
    expect((await w.payments.findById(failed.id))?.state).toBe("failed");
  });
});
