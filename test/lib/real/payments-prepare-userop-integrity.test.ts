// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, decodeFunctionData, encodeAbiParameters, getAddress, toFunctionSelector, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { createInMemoryAccountHandleStore } from "@/lib/real/server/account-handles";
import { createInMemoryPaymentAttemptStore, type PaymentAttempt, type PaymentAttemptStore } from "@/lib/real/server/payment-attempts";
import { createInMemoryRealAccountRegistry } from "@/lib/real/server/registry";
import { createSessionPayload, serializeSession } from "@/lib/real/server/session";
import { REAL_SAFE } from "@/lib/real/constants";
import { createReadOnlyOwnerAccount, createRealSafeAccount } from "@/lib/real/account/safe";
import { computeExpectedUserOperationHash } from "@/lib/real/payments/hash";
import { parsePreparedFieldsFromWire } from "@/lib/real/payments/prepared-operation";
import {
  PreparedCallDataMismatchError,
  PreparedUserOperationIntegrityError,
  prepareCashTransferUserOperation,
  verifyPreparedUserOperation,
} from "@/lib/real/server/pimlico";
import { resolveCancelPayment, resolvePreparePayment } from "@/lib/real/server/payments";
import { rpcBlock } from "./fixtures/chain-block";
import { freshRateLimiter } from "./fixtures/rate-limit";

/**
 * L-1a — prepared UserOperation structural integrity.
 *
 * viem 2.56.8's prepareUserOperation spreads the raw pm_getPaymasterStubData
 * and pm_getPaymasterData results over the request (only the two paymaster gas
 * limits are converted, with hexToBigInt). So a paymaster response can replace
 * or delete the paymaster itself, and can inject raw (non-bigint) nonce, gas
 * and fee values, sender, factory, factoryData or initCode. These tests run
 * the REAL pimlico.ts / viem / permissionless code; only the network is faked:
 *   - the chain RPC through a viem `custom` transport (deployment state and
 *     the EntryPoint nonce are scriptable; every call is logged);
 *   - the Pimlico JSON-RPC endpoint through a stubbed global `fetch` that
 *     answers only https://api.pimlico.io/... locally and throws for any other
 *     URL. Nothing leaves the process.
 *
 * Sponsored-only: with a non-zero paymaster, EntryPoint 0.7 asks the account
 * for missingAccountFunds = 0, so the Safe's own ETH is never the gas source.
 */

const SECRET = "7f3c9a1e5b2d4f60a8c7e9b1d3f5a7c90e2b4d6f8a1c3e5b7d9f0a2c4e6b8d0f";
const PAYER_OWNER = getAddress("0xf6c3fe6de636f0d8f421d5485d1a64ff3628cfaf");
const RECIPIENT_OWNER = "0x3333333333333333333333333333333333333333";
const RECIPIENT_SAFE = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const ADDRESS_RECIPIENT = "0x2222222222222222222222222222222222222222" as Address;
const ATTACKER = "0x000000000000000000000000000000000000dEaD" as Address;
const AMOUNT = "1000000";
const SAFE_PREPARE_FAILED = "Could not prepare this payment right now. Try again in a moment.";

const ZERO = BigInt(0);
const ONE = BigInt(1);
const U128_MAX = (ONE << BigInt(128)) - ONE;
const U256_MAX = (ONE << BigInt(256)) - ONE;
const hexOf = (value: bigint) => `0x${value.toString(16)}`;

const BALANCE_OF_SELECTOR = "0x70a08231";
const DECIMALS_SELECTOR = "0x313ce567";
const GET_NONCE_SELECTOR = "0x35567e1a";
const DUMMY_BYTES_RETURN = encodeAbiParameters([{ type: "bytes" }], ["0x600a600c600039600a6000f3" as Hex]);
const DEPLOYED_CODE = "0x6080604052348015600f57600080fd5b50";

const ENTRY_POINT_GET_NONCE_ABI = [
  {
    type: "function",
    name: "getNonce",
    stateMutability: "view",
    inputs: [
      { name: "sender", type: "address" },
      { name: "key", type: "uint192" },
    ],
    outputs: [{ name: "nonce", type: "uint256" }],
  },
] as const;

const PAYMASTER = "0x7777777777777777777777777777777777777777";
const PAYMASTER_STUB_DATA = `0x${"ab".repeat(20)}`;
const PAYMASTER_FINAL_DATA = `0x${"cd".repeat(24)}`;

// --- Offline chain fake -------------------------------------------------------

/** The EntryPoint 0.7 nonce for (key, seq): seq in the low 64 bits, key in the upper 192. */
const entryPointNonce = (key: bigint, seq: bigint) => (key << BigInt(64)) | seq;

let chain: { deployed: boolean; seq: bigint };
const chainLog: string[] = [];
const nonceReads: { sender: string; key: bigint }[] = [];

function publicClient() {
  return createPublicClient({
    chain: baseSepolia,
    transport: custom({
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === "eth_call") {
          const data = ((params?.[0] ?? {}) as { data?: Hex }).data ?? "0x";
          const selector = data.slice(0, 10);
          if (selector === GET_NONCE_SELECTOR) {
            chainLog.push("eth_call:getNonce");
            const { args } = decodeFunctionData({ abi: ENTRY_POINT_GET_NONCE_ABI, data });
            nonceReads.push({ sender: args[0], key: args[1] });
            return encodeAbiParameters([{ type: "uint256" }], [entryPointNonce(args[1], chain.seq)]);
          }
          if (selector === BALANCE_OF_SELECTOR) {
            chainLog.push("eth_call:balanceOf");
            return encodeAbiParameters([{ type: "uint256" }], [BigInt(100_000_000)]);
          }
          if (selector === DECIMALS_SELECTOR) {
            chainLog.push("eth_call:decimals");
            return encodeAbiParameters([{ type: "uint8" }], [6]);
          }
          chainLog.push("eth_call:other");
          return DUMMY_BYTES_RETURN; // proxyCreationCode()
        }
        chainLog.push(method);
        if (method === "eth_chainId") return `0x${baseSepolia.id.toString(16)}`;
        if (method === "eth_getBlockByNumber") return rpcBlock();
        if (method === "eth_getCode") return chain.deployed ? DEPLOYED_CODE : "0x";
        throw new Error(`Unexpected public RPC call in an offline test: ${method}`);
      },
    }),
  });
}

// --- Offline Pimlico fake -----------------------------------------------------

type Script = {
  stubIsFinal?: boolean;
  stubExtra?: Record<string, unknown>;
  stubOmit?: string[];
  estimateExtra?: Record<string, unknown>;
  estimateOmit?: string[];
  finalExtra?: Record<string, unknown>;
  finalOmit?: string[];
  gasPrice?: { maxFeePerGas: unknown; maxPriorityFeePerGas: unknown };
};

let script: Script = {};
const rpcLog: { method: string; params: unknown[] }[] = [];

function shape(base: Record<string, unknown>, extra: Record<string, unknown> | undefined, omit: string[] | undefined) {
  const out: Record<string, unknown> = { ...base, ...extra };
  for (const key of omit ?? []) delete out[key];
  return out;
}

function answerPimlico(method: string): unknown {
  switch (method) {
    case "pimlico_getUserOperationGasPrice": {
      const tier = script.gasPrice ?? { maxFeePerGas: hexOf(BigInt(2_000_000)), maxPriorityFeePerGas: hexOf(BigInt(1_000_000)) };
      return { slow: tier, standard: tier, fast: tier };
    }
    case "pm_getPaymasterStubData":
      return shape(
        {
          paymaster: PAYMASTER,
          paymasterData: PAYMASTER_STUB_DATA,
          paymasterVerificationGasLimit: hexOf(BigInt(50_000)),
          paymasterPostOpGasLimit: hexOf(BigInt(10_000)),
          ...(script.stubIsFinal ? { isFinal: true } : {}),
        },
        script.stubExtra,
        script.stubOmit,
      );
    case "eth_estimateUserOperationGas":
      return shape(
        {
          preVerificationGas: hexOf(BigInt(60_000)),
          verificationGasLimit: hexOf(BigInt(150_000)),
          callGasLimit: hexOf(BigInt(80_000)),
          paymasterVerificationGasLimit: hexOf(BigInt(50_000)),
          paymasterPostOpGasLimit: hexOf(BigInt(10_000)),
        },
        script.estimateExtra,
        script.estimateOmit,
      );
    case "pm_getPaymasterData":
      return shape(
        {
          paymaster: PAYMASTER,
          paymasterData: PAYMASTER_FINAL_DATA,
          paymasterVerificationGasLimit: hexOf(BigInt(50_000)),
          paymasterPostOpGasLimit: hexOf(BigInt(10_000)),
        },
        script.finalExtra,
        script.finalOmit,
      );
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
const sentTo = (method: string) => rpcLog.filter((entry) => entry.method === method).map((entry) => entry.params[0] as Record<string, unknown>);

function countsOf(list: string[]) {
  const counts: Record<string, number> = {};
  for (const item of list) counts[item] = (counts[item] ?? 0) + 1;
  return counts;
}

// --- World ------------------------------------------------------------------

let payerSafe: Address;
let localFactory: Address;
let localFactoryData: Hex;

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

const byAddress = { kind: "address" as const, value: ADDRESS_RECIPIENT };
const byHandle = { kind: "handle" as const, handle: "maya_chen" };
type Selector = typeof byAddress | typeof byHandle;

function prepare(w: World, recipient: Selector) {
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

const prepareDirect = () =>
  prepareCashTransferUserOperation({ publicClient: publicClient(), pimlicoApiKey: "pim_test_key", ownerAddress: PAYER_OWNER, recipient: ADDRESS_RECIPIENT, amountBaseUnits: AMOUNT });

async function latest(store: PaymentAttemptStore) {
  const attempt = await store.findLatestByAppUserId("app-user-1");
  if (!attempt) throw new Error("no attempt recorded");
  return attempt;
}

const PREPARED_COLUMNS = [
  "nonce",
  "callData",
  "factory",
  "factoryData",
  "callGasLimit",
  "verificationGasLimit",
  "preVerificationGas",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "paymaster",
  "paymasterData",
  "paymasterVerificationGasLimit",
  "paymasterPostOpGasLimit",
  "expectedUserOperationHash",
  "validUntil",
  "prepareBlockNumber",
] as const satisfies readonly (keyof PaymentAttempt)[];

function expectNothingPrepared(attempt: PaymentAttempt) {
  expect(attempt.state).toBe("failed");
  expect(attempt.failureReason).toBe(SAFE_PREPARE_FAILED);
  for (const column of PREPARED_COLUMNS) expect(attempt[column], column).toBeNull();
}

beforeEach(async () => {
  script = {};
  chain = { deployed: false, seq: BigInt(0) };
  fakeFetch.mockClear();
  vi.stubGlobal("fetch", fakeFetch);
  const account = await createRealSafeAccount({ owner: createReadOnlyOwnerAccount(PAYER_OWNER), publicClient: publicClient() });
  payerSafe = account.address;
  const args = await account.getFactoryArgs();
  localFactory = args.factory as Address;
  localFactoryData = args.factoryData as Hex;
  rpcLog.length = 0;
  chainLog.length = 0;
  nonceReads.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- Tests ------------------------------------------------------------------

describe("offline harness sanity", () => {
  it("refuses any non-Pimlico URL", async () => {
    await expect(fakeFetch("https://example.com/")).rejects.toThrow(/Network access refused/);
  });

  it("the locally derived Safe initialization is the configured proxy factory's createProxyWithNonce", () => {
    expect(getAddress(localFactory)).toBe(getAddress(REAL_SAFE.proxyFactoryAddress));
    expect(localFactoryData.slice(0, 10)).toBe(toFunctionSelector("createProxyWithNonce(address,bytes,uint256)"));
  });
});

describe("RPC parity with the pre-L-1a preparation path (no extra chain or provider request)", () => {
  // Recorded by running exactly these preparations against the unmodified
  // pimlico.ts at bfc7329 (before L-1a), then frozen here.
  const BASELINE_PIMLICO = { pimlico_getUserOperationGasPrice: 1, pm_getPaymasterStubData: 1, eth_estimateUserOperationGas: 1, pm_getPaymasterData: 1 };
  const BASELINE_CHAIN_UNDEPLOYED = { "eth_call:other": 1, "eth_call:getNonce": 1, eth_getCode: 1 };
  const BASELINE_CHAIN_DEPLOYED = { "eth_call:other": 1, "eth_call:getNonce": 1, eth_getCode: 1 };

  it("undeployed Safe: identical per-method request counts", async () => {
    await prepareDirect();
    expect(countsOf(methodsCalled())).toEqual(BASELINE_PIMLICO);
    expect(countsOf(chainLog)).toEqual(BASELINE_CHAIN_UNDEPLOYED);
  });

  it("deployed Safe: identical per-method request counts", async () => {
    chain.deployed = true;
    await prepareDirect();
    expect(countsOf(methodsCalled())).toEqual(BASELINE_PIMLICO);
    expect(countsOf(chainLog)).toEqual(BASELINE_CHAIN_DEPLOYED);
  });

  it("stub isFinal: identical counts, and pm_getPaymasterData is still skipped", async () => {
    script = { stubIsFinal: true };
    await prepareDirect();
    expect(countsOf(methodsCalled())).toEqual({ pimlico_getUserOperationGasPrice: 1, pm_getPaymasterStubData: 1, eth_estimateUserOperationGas: 1 });
    expect(countsOf(chainLog)).toEqual(BASELINE_CHAIN_UNDEPLOYED);
  });
});

describe("honest sponsored preparation stays compatible", () => {
  async function expectReadyAndConsistent(w: World, selector: Selector) {
    const outcome = await prepare(w, selector);
    expect(outcome.outcome).toBe("ready");
    const attempt = await latest(w.payments);
    expect(attempt.state).toBe("awaiting_authorization");
    if (outcome.outcome !== "ready" || !outcome.attempt.prepared) throw new Error("not ready");
    // The browser's wire round trip re-derives exactly the persisted hash.
    const fields = parsePreparedFieldsFromWire(outcome.attempt.prepared);
    expect(computeExpectedUserOperationHash(fields)).toBe(attempt.expectedUserOperationHash);
    return attempt;
  }

  it("1. address payment, undeployed Safe: ready; nonce, factory and paymaster persisted from the local derivation / honest paymaster", async () => {
    const w = await world();
    const attempt = await expectReadyAndConsistent(w, byAddress);
    expect(nonceReads).toHaveLength(1);
    expect(attempt.nonce).toBe(entryPointNonce(nonceReads[0].key, BigInt(0)).toString());
    expect(attempt.factory).toBe(localFactory);
    expect(attempt.factoryData).toBe(localFactoryData);
    expect(attempt.paymaster).toBe(PAYMASTER);
    expect(attempt.paymasterData).toBe(PAYMASTER_FINAL_DATA);
  });

  it("2. @handle payment: ready and consistent", async () => {
    const w = await world();
    const attempt = await expectReadyAndConsistent(w, byHandle);
    expect(attempt.recipient).toBe(RECIPIENT_SAFE.toLowerCase());
    expect(attempt.paymaster).toBe(PAYMASTER);
  });

  it("3. deployed Safe: ready, no factory fields, and no initialization sent to the provider", async () => {
    chain.deployed = true;
    chain.seq = BigInt(7);
    const w = await world();
    const attempt = await expectReadyAndConsistent(w, byAddress);
    expect(attempt.factory).toBeNull();
    expect(attempt.factoryData).toBeNull();
    expect(attempt.nonce).toBe(entryPointNonce(nonceReads[0].key, BigInt(7)).toString());
    for (const request of sentTo("pm_getPaymasterStubData")) {
      expect(request.factory).toBeUndefined();
      expect(request.factoryData).toBeUndefined();
    }
  });

  it("4. undeployed Safe: the provider is sent exactly the locally derived nonce, factory and factoryData", async () => {
    const prepared = await prepareDirect();
    expect(prepared.factory).toBe(localFactory);
    expect(prepared.factoryData).toBe(localFactoryData);
    expect(nonceReads).toHaveLength(1);
    expect(nonceReads[0].sender).toBe(payerSafe);
    expect(prepared.nonce).toBe(entryPointNonce(nonceReads[0].key, BigInt(0)));
    for (const method of ["pm_getPaymasterStubData", "eth_estimateUserOperationGas", "pm_getPaymasterData"]) {
      for (const request of sentTo(method)) {
        expect(request.nonce).toBe(hexOf(prepared.nonce));
        expect(request.factory).toBe(localFactory);
        expect(request.factoryData).toBe(localFactoryData);
      }
    }
  });

  it("5. stub with isFinal: true is accepted without pm_getPaymasterData", async () => {
    script = { stubIsFinal: true };
    const w = await world();
    const attempt = await expectReadyAndConsistent(w, byAddress);
    expect(methodsCalled()).not.toContain("pm_getPaymasterData");
    expect(attempt.paymasterData).toBe(PAYMASTER_STUB_DATA);
  });

  it("6/7. stub followed by the final response: the final paymaster fields are the ones persisted", async () => {
    script = { finalExtra: { paymasterVerificationGasLimit: hexOf(BigInt(61_000)), paymasterPostOpGasLimit: hexOf(BigInt(12_000)) } };
    const w = await world();
    const attempt = await expectReadyAndConsistent(w, byAddress);
    expect(methodsCalled()).toEqual(expect.arrayContaining(["pm_getPaymasterStubData", "pm_getPaymasterData"]));
    expect(attempt.paymasterData).toBe(PAYMASTER_FINAL_DATA);
    expect(attempt.paymasterVerificationGasLimit).toBe("61000");
    expect(attempt.paymasterPostOpGasLimit).toBe("12000");
  });

  it("11. empty-but-valid paymasterData (0x) is accepted, persisted as 0x, and hashes consistently", async () => {
    script = { stubExtra: { paymasterData: "0x" }, finalExtra: { paymasterData: "0x" } };
    const w = await world();
    const attempt = await expectReadyAndConsistent(w, byAddress);
    expect(attempt.paymasterData).toBe("0x");
  });

  it("14. a zero paymasterPostOpGasLimit is accepted, persisted as 0, and hashes consistently", async () => {
    script = {
      stubExtra: { paymasterPostOpGasLimit: "0x0" },
      estimateExtra: { paymasterPostOpGasLimit: "0x0" },
      finalExtra: { paymasterPostOpGasLimit: "0x0" },
    };
    const w = await world();
    const attempt = await expectReadyAndConsistent(w, byAddress);
    expect(attempt.paymasterPostOpGasLimit).toBe("0");
  });

  it("zero gas and fee values are not rejected by this slice (no unverified zero rule)", async () => {
    script = {
      estimateExtra: { callGasLimit: "0x0", verificationGasLimit: "0x0", preVerificationGas: "0x0" },
      gasPrice: { maxFeePerGas: "0x0", maxPriorityFeePerGas: "0x0" },
    };
    const w = await world();
    const attempt = await expectReadyAndConsistent(w, byAddress);
    expect([attempt.callGasLimit, attempt.verificationGasLimit, attempt.preVerificationGas, attempt.maxFeePerGas, attempt.maxPriorityFeePerGas]).toEqual(["0", "0", "0", "0", "0"]);
  });

  it("24. exact EntryPoint 0.7 maxima are accepted end to end (uint128 gas/fee halves, uint256 preVerificationGas)", async () => {
    script = {
      estimateExtra: { callGasLimit: hexOf(U128_MAX), verificationGasLimit: hexOf(U128_MAX), preVerificationGas: hexOf(U256_MAX) },
      gasPrice: { maxFeePerGas: hexOf(U128_MAX), maxPriorityFeePerGas: hexOf(U128_MAX) },
      finalExtra: { paymasterVerificationGasLimit: hexOf(U128_MAX), paymasterPostOpGasLimit: hexOf(U128_MAX) },
    };
    const w = await world();
    const attempt = await expectReadyAndConsistent(w, byAddress);
    expect(attempt.callGasLimit).toBe(U128_MAX.toString());
    expect(attempt.preVerificationGas).toBe(U256_MAX.toString());
    expect(attempt.paymasterPostOpGasLimit).toBe(U128_MAX.toString());
  });

  it("an echoed, identical factory/factoryData (undeployed) is accepted — equal, not merely present", async () => {
    script = { finalExtra: { factory: localFactory, factoryData: localFactoryData } };
    const prepared = await prepareDirect();
    expect(prepared.factory).toBe(localFactory);
  });
});

// --- Adversarial: end to end through prepareCashTransferUserOperation ----------

type Case = { name: string; arrange: () => void };

const PAYMASTER_REMOVED: Case[] = [
  { name: "stub and final both omit the paymaster", arrange: () => (script = { stubOmit: ["paymaster"], finalOmit: ["paymaster"] }) },
  { name: "final sets paymaster: null", arrange: () => (script = { finalExtra: { paymaster: null } }) },
  { name: "isFinal stub without a paymaster", arrange: () => (script = { stubIsFinal: true, stubOmit: ["paymaster"] }) },
  { name: "final sets paymaster: \"\"", arrange: () => (script = { finalExtra: { paymaster: "" } }) },
];

const PAYMASTER_ZERO: Case[] = [
  { name: "isFinal stub returns the zero address", arrange: () => (script = { stubIsFinal: true, stubExtra: { paymaster: `0x${"0".repeat(40)}` } }) },
  { name: "final returns the zero address", arrange: () => (script = { finalExtra: { paymaster: `0x${"0".repeat(40)}` } }) },
];

const PAYMASTER_MALFORMED: Case[] = [
  ["too short", "0x1234"],
  ["too long", `0x${"77".repeat(21)}`],
  ["non-hex", `0x${"zz".repeat(20)}`],
  ["no 0x prefix", "77".repeat(20)],
  ["a number", 1234],
  ["an object", { address: PAYMASTER }],
].map(([label, value]) => ({ name: `final paymaster ${label}`, arrange: () => (script = { finalExtra: { paymaster: value } }) }));

const PAYMASTER_DATA_MALFORMED: Case[] = [
  ["odd-length hex", "0xabc"],
  ["non-hex", "0xzzzz"],
  ["no 0x prefix", "abcd"],
  ["a number", 1234],
  ["null", null],
  ["an empty string", ""],
].map(([label, value]) => ({ name: `final paymasterData ${label}`, arrange: () => (script = { finalExtra: { paymasterData: value } }) }));

const SPONSORSHIP_FIELDS_MISSING: Case[] = [
  {
    name: "paymasterVerificationGasLimit missing everywhere",
    arrange: () => (script = { stubOmit: ["paymasterVerificationGasLimit"], estimateOmit: ["paymasterVerificationGasLimit"], finalOmit: ["paymasterVerificationGasLimit"] }),
  },
  {
    name: "paymasterPostOpGasLimit missing everywhere",
    arrange: () => (script = { stubOmit: ["paymasterPostOpGasLimit"], estimateOmit: ["paymasterPostOpGasLimit"], finalOmit: ["paymasterPostOpGasLimit"] }),
  },
  { name: "paymasterData missing from stub and final", arrange: () => (script = { stubOmit: ["paymasterData"], finalOmit: ["paymasterData"] }) },
  { name: "isFinal stub without paymasterData", arrange: () => (script = { stubIsFinal: true, stubOmit: ["paymasterData"] }) },
];

const NONCE_SUBSTITUTED: Case[] = [
  { name: "isFinal stub injects a different nonce", arrange: () => (script = { stubIsFinal: true, stubExtra: { nonce: "0x1" } }) },
  { name: "stub injects a different nonce (honest final)", arrange: () => (script = { stubExtra: { nonce: hexOf(BigInt(42)) } }) },
  { name: "final injects a different nonce", arrange: () => (script = { finalExtra: { nonce: "0x0" } }) },
  { name: "final injects a nonce with a different key", arrange: () => (script = { finalExtra: { nonce: hexOf(entryPointNonce(BigInt(1), BigInt(0))) } }) },
  { name: "final injects a nonce as a JSON number", arrange: () => (script = { finalExtra: { nonce: 0 } }) },
  { name: "final injects a nonce of null", arrange: () => (script = { finalExtra: { nonce: null } }) },
];

const FACTORY_UNDEPLOYED: Case[] = [
  { name: "18. final substitutes the factory address", arrange: () => (script = { finalExtra: { factory: ATTACKER } }) },
  { name: "18. isFinal stub substitutes the factory address", arrange: () => (script = { stubIsFinal: true, stubExtra: { factory: ATTACKER } }) },
  { name: "19. final substitutes factoryData (last byte changed)", arrange: () => (script = { finalExtra: { factoryData: `${localFactoryData.slice(0, -2)}${localFactoryData.endsWith("ff") ? "fe" : "ff"}` } }) },
  { name: "19. stub substitutes factoryData", arrange: () => (script = { stubExtra: { factoryData: "0x1234" } }) },
  { name: "19. factoryData in a different hex case", arrange: () => (script = { finalExtra: { factoryData: `0x${localFactoryData.slice(2).toUpperCase()}` } }) },
  { name: "21. final removes factory and factoryData (null)", arrange: () => (script = { finalExtra: { factory: null, factoryData: null } }) },
  { name: "21. final removes factoryData only (0x)", arrange: () => (script = { finalExtra: { factoryData: "0x" } }) },
  { name: "21. final removes factory only (empty string)", arrange: () => (script = { finalExtra: { factory: "" } }) },
  { name: "22. final returns odd-length factoryData", arrange: () => (script = { finalExtra: { factoryData: `${localFactoryData}0` } }) },
  { name: "22. final returns non-hex factoryData", arrange: () => (script = { finalExtra: { factoryData: "0xzz" } }) },
];

const FACTORY_DEPLOYED: Case[] = [
  { name: "20. final adds the would-be-honest factory and factoryData", arrange: () => (script = { finalExtra: { factory: localFactory, factoryData: localFactoryData } }) },
  { name: "20. isFinal stub adds a factory only", arrange: () => (script = { stubIsFinal: true, stubExtra: { factory: ATTACKER } }) },
  { name: "20. final adds factoryData only", arrange: () => (script = { finalExtra: { factoryData: "0x1234" } }) },
  { name: "20. final adds factory: null", arrange: () => (script = { finalExtra: { factory: null } }) },
  { name: "20. final adds an EntryPoint 0.6 initCode", arrange: () => (script = { finalExtra: { initCode: `${localFactory}${localFactoryData.slice(2)}` } }) },
  { name: "20. final adds an EIP-7702 authorization", arrange: () => (script = { finalExtra: { authorization: { address: ATTACKER, chainId: 84532, nonce: 0 } } }) },
  { name: "22. final adds malformed factoryData", arrange: () => (script = { finalExtra: { factoryData: "0xabc" } }) },
];

const RAW_NUMERIC_FIELDS = ["callGasLimit", "verificationGasLimit", "preVerificationGas", "maxFeePerGas", "maxPriorityFeePerGas"] as const;
const NUMERIC_WRONG_TYPE: Case[] = RAW_NUMERIC_FIELDS.flatMap((field) =>
  (
    [
      ["a hex string", "0x10"],
      ["a decimal string", "16"],
      ["a JSON number", 16],
      ["a negative JSON number", -1],
      ["null", null],
      ["a boolean", true],
    ] as const
  ).map(([label, value]) => ({ name: `final injects ${field} as ${label}`, arrange: () => (script = { finalExtra: { [field]: value } }) })),
);
const NUMERIC_VIA_STUB: Case[] = RAW_NUMERIC_FIELDS.map((field) => ({
  name: `isFinal stub injects ${field} as a hex string`,
  arrange: () => (script = { stubIsFinal: true, stubExtra: { [field]: "0x5208" } }),
}));

const NUMERIC_OVERSIZED: Case[] = [
  { name: "callGasLimit = 2^128 (estimate)", arrange: () => (script = { estimateExtra: { callGasLimit: hexOf(U128_MAX + ONE) } }) },
  { name: "verificationGasLimit = 2^128 (estimate)", arrange: () => (script = { estimateExtra: { verificationGasLimit: hexOf(U128_MAX + ONE) } }) },
  { name: "preVerificationGas = 2^256 (estimate)", arrange: () => (script = { estimateExtra: { preVerificationGas: hexOf(U256_MAX + ONE) } }) },
  { name: "maxFeePerGas = 2^128 (gas price)", arrange: () => (script = { gasPrice: { maxFeePerGas: hexOf(U128_MAX + ONE), maxPriorityFeePerGas: "0x1" } }) },
  { name: "maxPriorityFeePerGas = 2^128 (gas price)", arrange: () => (script = { gasPrice: { maxFeePerGas: "0x1", maxPriorityFeePerGas: hexOf(U128_MAX + ONE) } }) },
  { name: "paymasterVerificationGasLimit = 2^128 (final)", arrange: () => (script = { finalExtra: { paymasterVerificationGasLimit: hexOf(U128_MAX + ONE) } }) },
  { name: "paymasterPostOpGasLimit = 2^128 (final)", arrange: () => (script = { finalExtra: { paymasterPostOpGasLimit: hexOf(U128_MAX + ONE) } }) },
  { name: "paymasterPostOpGasLimit = 2^128 (isFinal stub)", arrange: () => (script = { stubIsFinal: true, stubExtra: { paymasterPostOpGasLimit: hexOf(U128_MAX + ONE) } }) },
];

const SENDER_SUBSTITUTED: Case[] = [
  { name: "final injects a different sender", arrange: () => (script = { finalExtra: { sender: ATTACKER } }) },
  { name: "stub injects a different sender", arrange: () => (script = { stubExtra: { sender: ATTACKER } }) },
];

const ALL_ADVERSARIAL: { group: string; cases: Case[]; deployed?: boolean }[] = [
  { group: "8. paymaster removed", cases: PAYMASTER_REMOVED },
  { group: "9. zero paymaster", cases: PAYMASTER_ZERO },
  { group: "10. malformed paymaster address", cases: PAYMASTER_MALFORMED },
  { group: "12. malformed paymasterData", cases: PAYMASTER_DATA_MALFORMED },
  { group: "13. missing sponsorship fields", cases: SPONSORSHIP_FIELDS_MISSING },
  { group: "15/16. nonce substituted", cases: NONCE_SUBSTITUTED },
  { group: "18/19/21/22. factory integrity (undeployed Safe)", cases: FACTORY_UNDEPLOYED },
  { group: "20/22. factory integrity (deployed Safe)", cases: FACTORY_DEPLOYED, deployed: true },
  { group: "23. wrong-type numeric values", cases: [...NUMERIC_WRONG_TYPE, ...NUMERIC_VIA_STUB] },
  { group: "23/24. oversized numeric values", cases: NUMERIC_OVERSIZED },
  { group: "sender substituted", cases: SENDER_SUBSTITUTED },
];

describe("prepareCashTransferUserOperation refuses a structurally unsafe prepared operation", () => {
  for (const { group, cases, deployed } of ALL_ADVERSARIAL) {
    describe(group, () => {
      for (const c of cases) {
        it(`${c.name} -> PreparedUserOperationIntegrityError`, async () => {
          chain.deployed = deployed ?? false;
          c.arrange();
          await expect(prepareDirect()).rejects.toBeInstanceOf(PreparedUserOperationIntegrityError);
        });
      }
    });
  }

  it("a callData substitution is still reported as PreparedCallDataMismatchError (checked first, unchanged)", async () => {
    script = { finalExtra: { callData: "0x", paymaster: null } };
    await expect(prepareDirect()).rejects.toBeInstanceOf(PreparedCallDataMismatchError);
  });

  it("a non-hex paymaster gas string makes viem itself throw — still a refusal, never a coerced value", async () => {
    script = { finalExtra: { paymasterPostOpGasLimit: "0xnot-hex" } };
    await expect(prepareDirect()).rejects.toThrow();
  });
});

describe("resolvePreparePayment — a refused preparation never reaches awaiting_authorization (25, 26)", () => {
  const REPRESENTATIVE: { name: string; deployed?: boolean; arrange: () => void }[] = [
    PAYMASTER_REMOVED[0],
    PAYMASTER_ZERO[0],
    PAYMASTER_MALFORMED[0],
    PAYMASTER_DATA_MALFORMED[0],
    SPONSORSHIP_FIELDS_MISSING[0],
    NONCE_SUBSTITUTED[0],
    NONCE_SUBSTITUTED[2],
    FACTORY_UNDEPLOYED[0],
    FACTORY_UNDEPLOYED[2],
    FACTORY_UNDEPLOYED[5],
    { ...FACTORY_DEPLOYED[0], deployed: true },
    { ...FACTORY_DEPLOYED[4], deployed: true },
    NUMERIC_WRONG_TYPE[0],
    NUMERIC_OVERSIZED[0],
    NUMERIC_OVERSIZED[5],
  ];

  for (const [selectorName, selector] of [["address", byAddress], ["@handle", byHandle]] as const) {
    for (const c of REPRESENTATIVE) {
      it(`${selectorName}: ${c.name} -> prepare_failed, attempt failed, nothing prepared persisted`, async () => {
        chain.deployed = c.deployed ?? false;
        const w = await world();
        c.arrange();
        const outcome = await prepare(w, selector);
        expect(outcome).toEqual({ outcome: "prepare_failed", reason: SAFE_PREPARE_FAILED });
        expectNothingPrepared(await latest(w.payments));
      });
    }
  }
});

describe("existing retry and cancellation behavior (27)", () => {
  it("after a refused preparation the slot is free and an honest retry creates a NEW ready attempt", async () => {
    const w = await world();
    script = { finalExtra: { paymaster: null } };
    expect((await prepare(w, byAddress)).outcome).toBe("prepare_failed");
    const failed = await latest(w.payments);

    script = {};
    expect((await prepare(w, byAddress)).outcome).toBe("ready");
    const fresh = await latest(w.payments);
    expect(fresh.id).not.toBe(failed.id);
    expect(fresh.state).toBe("awaiting_authorization");
    expect((await w.payments.findById(failed.id))?.state).toBe("failed");
  });

  it("a refused (failed) attempt cannot be cancelled; an honest ready attempt still can", async () => {
    const w = await world();
    script = { finalExtra: { nonce: "0x1" } };
    await prepare(w, byAddress);
    const failed = await latest(w.payments);
    const cancel = (attemptId: string) => resolveCancelPayment({ cookieValue: PAYER_COOKIE(), sessionSecret: SECRET, registry: w.registry, paymentStore: w.payments, attemptId });
    expect(await cancel(failed.id)).toEqual({ outcome: "wrong_state", state: "failed" });

    script = {};
    await prepare(w, byAddress);
    const ready = await latest(w.payments);
    const cancelled = await cancel(ready.id);
    expect(cancelled.outcome).toBe("cancelled");
    expect((await w.payments.findById(ready.id))?.state).toBe("cancelled");
  });
});

describe("no provider text in the refusal (30)", () => {
  const HOSTILE = "0xdeadbeef https://api.pimlico.io/v2/84532/rpc?apikey=pim_test_key <script>";
  const HOSTILE_CASES: Case[] = [
    { name: "paymaster", arrange: () => (script = { finalExtra: { paymaster: HOSTILE } }) },
    { name: "paymasterData", arrange: () => (script = { finalExtra: { paymasterData: HOSTILE } }) },
    { name: "nonce", arrange: () => (script = { finalExtra: { nonce: HOSTILE } }) },
    { name: "factoryData", arrange: () => (script = { finalExtra: { factoryData: HOSTILE } }) },
    { name: "maxFeePerGas", arrange: () => (script = { finalExtra: { maxFeePerGas: HOSTILE } }) },
  ];

  for (const c of HOSTILE_CASES) {
    it(`a hostile ${c.name} value is not reflected in the error or the stored failure`, async () => {
      c.arrange();
      const error = await prepareDirect().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PreparedUserOperationIntegrityError);
      expect((error as Error).message).toBe("Prepared UserOperation failed structural integrity checks.");
      expect(String((error as Error).stack ?? "")).not.toMatch(/deadbeef|apikey|pim_test_key|<script>/);

      const w = await world();
      c.arrange();
      const outcome = await prepare(w, byAddress);
      expect(JSON.stringify(outcome)).not.toMatch(/deadbeef|apikey|pim_test_key|<script>/);
      const attempt = await latest(w.payments);
      expect(JSON.stringify(attempt)).not.toMatch(/deadbeef|apikey|pim_test_key|<script>/);
    });
  }
});

// --- Pure verifier: bigint-level cases the JSON wire cannot carry ------------

describe("verifyPreparedUserOperation — field-level rules", () => {
  const SENDER = "0x1111111111111111111111111111111111111111" as Address;
  const NONCE = entryPointNonce(BigInt(1_762_000_000_000), BigInt(3));
  const CALL_DATA = "0x1234abcd" as Hex;
  const FACTORY = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67" as Address;
  const FACTORY_DATA = "0x1688f0b9aabbcc" as Hex;

  const deployedExpectation = { sender: SENDER, nonce: NONCE, factory: undefined, factoryData: undefined, callData: CALL_DATA };
  const undeployedExpectation = { ...deployedExpectation, factory: FACTORY, factoryData: FACTORY_DATA };

  const honest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    sender: SENDER,
    nonce: NONCE,
    callData: CALL_DATA,
    callGasLimit: BigInt(80_000),
    verificationGasLimit: BigInt(150_000),
    preVerificationGas: BigInt(60_000),
    maxFeePerGas: BigInt(2_000_000),
    maxPriorityFeePerGas: BigInt(1_000_000),
    paymaster: PAYMASTER,
    paymasterData: "0x",
    paymasterVerificationGasLimit: BigInt(50_000),
    paymasterPostOpGasLimit: ZERO,
    signature: "0x00",
    ...overrides,
  });

  it("an honest deployed-Safe operation returns exactly the expected fields", () => {
    expect(verifyPreparedUserOperation(honest(), deployedExpectation)).toEqual({
      sender: SENDER,
      nonce: NONCE,
      factory: undefined,
      factoryData: undefined,
      callData: CALL_DATA,
      callGasLimit: BigInt(80_000),
      verificationGasLimit: BigInt(150_000),
      preVerificationGas: BigInt(60_000),
      maxFeePerGas: BigInt(2_000_000),
      maxPriorityFeePerGas: BigInt(1_000_000),
      paymaster: PAYMASTER,
      paymasterData: "0x",
      paymasterVerificationGasLimit: BigInt(50_000),
      paymasterPostOpGasLimit: ZERO,
    });
  });

  it("an honest undeployed-Safe operation returns the expected factory fields", () => {
    const out = verifyPreparedUserOperation(honest({ factory: FACTORY, factoryData: FACTORY_DATA }), undeployedExpectation);
    expect(out.factory).toBe(FACTORY);
    expect(out.factoryData).toBe(FACTORY_DATA);
  });

  it("returned values are copies of the validated ones, never extra provider keys", () => {
    const out = verifyPreparedUserOperation(honest({ paymasterAndData: "0xdead", sponsor: { name: "x" } }), deployedExpectation);
    expect(Object.keys(out).sort()).toEqual(
      ["callData", "callGasLimit", "factory", "factoryData", "maxFeePerGas", "maxPriorityFeePerGas", "nonce", "paymaster", "paymasterData", "paymasterPostOpGasLimit", "paymasterVerificationGasLimit", "preVerificationGas", "sender", "verificationGasLimit"],
    );
  });

  const reject = (prepared: Record<string, unknown>, expectation: Parameters<typeof verifyPreparedUserOperation>[1] = deployedExpectation) =>
    expect(() => verifyPreparedUserOperation(prepared, expectation)).toThrow(PreparedUserOperationIntegrityError);

  it("17. wrong nonce key or sequence (bigint) is refused", () => {
    reject(honest({ nonce: NONCE + ONE }));
    reject(honest({ nonce: NONCE - ONE }));
    reject(honest({ nonce: NONCE ^ (ONE << BigInt(64)) }));
    reject(honest({ nonce: entryPointNonce(BigInt(1_762_000_000_001), BigInt(3)) }));
    reject(honest({ nonce: undefined }));
  });

  const WIDTHS = [
    ["nonce", U256_MAX],
    ["callGasLimit", U128_MAX],
    ["verificationGasLimit", U128_MAX],
    ["preVerificationGas", U256_MAX],
    ["maxFeePerGas", U128_MAX],
    ["maxPriorityFeePerGas", U128_MAX],
    ["paymasterVerificationGasLimit", U128_MAX],
    ["paymasterPostOpGasLimit", U128_MAX],
  ] as const;

  for (const [field, max] of WIDTHS) {
    it(`23/24. ${field}: zero and the exact maximum are accepted; negative, max + 1 and non-bigint are refused`, () => {
      const expectationFor = (value: bigint) => (field === "nonce" ? { ...deployedExpectation, nonce: value } : deployedExpectation);
      expect(verifyPreparedUserOperation(honest({ [field]: ZERO }), expectationFor(ZERO))[field]).toBe(ZERO);
      expect(verifyPreparedUserOperation(honest({ [field]: max }), expectationFor(max))[field]).toBe(max);
      reject(honest({ [field]: -ONE }), expectationFor(-ONE));
      reject(honest({ [field]: max + ONE }), expectationFor(max + ONE));
      for (const wrong of [hexOf(BigInt(16)), "16", 16, null, undefined, true, { value: BigInt(16) }]) {
        reject(honest({ [field]: wrong }));
      }
    });
  }

  it("G1: the sponsorship fields are each required", () => {
    reject(honest({ paymaster: undefined }));
    reject(honest({ paymasterData: undefined }));
    reject(honest({ paymasterVerificationGasLimit: undefined }));
    reject(honest({ paymasterPostOpGasLimit: undefined }));
  });

  it("G1/G5: paymaster must be a non-zero 20-byte address; paymasterData whole bytes (0x allowed)", () => {
    reject(honest({ paymaster: `0x${"0".repeat(40)}` }));
    reject(honest({ paymaster: `0X${"7".repeat(40)}` }));
    reject(honest({ paymaster: `0x${"7".repeat(39)}` }));
    reject(honest({ paymasterData: "0x0" }));
    reject(honest({ paymasterData: "0xgg" }));
    reject(honest({ paymasterData: "" }));
    expect(verifyPreparedUserOperation(honest({ paymaster: `0x${"Ab".repeat(20)}` }), deployedExpectation).paymaster).toBe(`0x${"Ab".repeat(20)}`);
    expect(verifyPreparedUserOperation(honest({ paymasterData: "0xABcd" }), deployedExpectation).paymasterData).toBe("0xABcd");
  });

  it("G4: factory fields must match the local derivation exactly", () => {
    reject(honest(), undeployedExpectation);
    reject(honest({ factory: FACTORY }), undeployedExpectation);
    reject(honest({ factory: FACTORY, factoryData: "0x1688f0b9aabbcd" }), undeployedExpectation);
    reject(honest({ factory: FACTORY.toLowerCase(), factoryData: FACTORY_DATA }), undeployedExpectation);
    reject(honest({ factory: FACTORY, factoryData: FACTORY_DATA }), deployedExpectation);
    reject(honest({ factory: null }), deployedExpectation);
    reject(honest({ factoryData: "0x" }), deployedExpectation);
    reject(honest({ initCode: "0x" }), deployedExpectation);
    reject(honest({ authorization: null }), deployedExpectation);
  });

  it("G4: an internally inconsistent or malformed local expectation fails closed", () => {
    reject(honest({ factory: FACTORY }), { ...deployedExpectation, factory: FACTORY, factoryData: undefined });
    reject(honest({ factoryData: FACTORY_DATA }), { ...deployedExpectation, factory: undefined, factoryData: FACTORY_DATA });
    reject(honest({ factory: FACTORY, factoryData: "0x" }), { ...deployedExpectation, factory: FACTORY, factoryData: "0x" });
    reject(honest({ factory: FACTORY, factoryData: "0xabc" }), { ...deployedExpectation, factory: FACTORY, factoryData: "0xabc" as Hex });
    reject(honest({ factory: "0x1234", factoryData: FACTORY_DATA }), { ...deployedExpectation, factory: "0x1234" as Address, factoryData: FACTORY_DATA });
    reject(honest({ nonce: -ONE }), { ...deployedExpectation, nonce: -ONE });
  });

  it("the sender must be exactly the local Safe address", () => {
    reject(honest({ sender: ATTACKER }));
    reject(honest({ sender: SENDER.toUpperCase() }));
    reject(honest({ sender: undefined }));
  });
});
