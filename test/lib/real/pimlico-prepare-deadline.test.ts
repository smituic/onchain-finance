// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, decodeFunctionData, encodeAbiParameters, getAddress, type Address, type Hex } from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import { baseSepolia } from "viem/chains";
import { createReadOnlyOwnerAccount, createRealSafeAccount } from "@/lib/real/account/safe";
import { REAL_CASH_TOKEN } from "@/lib/real/constants";
import { encodeCashTransfer } from "@/lib/real/payments/transfer";
import { createInMemoryPaymentAttemptStore, type PaymentAttempt, type PaymentAttemptStore } from "@/lib/real/server/payment-attempts";
import { resolveCancelPayment, resolvePreparePayment } from "@/lib/real/server/payments";
import {
  CashTransferPreparationDeadlineError,
  PreparedCallDataMismatchError,
  PreparedUserOperationIntegrityError,
  prepareCashTransferUserOperation,
} from "@/lib/real/server/pimlico";
import { createInMemoryRealAccountRegistry } from "@/lib/real/server/registry";
import { createSessionPayload, serializeSession } from "@/lib/real/server/session";
import { rpcBlock } from "./fixtures/chain-block";
import { recordingRateLimiter } from "./fixtures/rate-limit";

/**
 * M3D — Pimlico preparation caller deadline and stage guards
 * (prepareCashTransferUserOperation, 25 000 ms).
 *
 * The REAL lib/real/server/pimlico.ts runs the REAL installed viem 2.56.8 /
 * permissionless 0.3.7 preparation (prepareUserOperation, its gas-estimation
 * nested preparation, paymaster selection and response spreading). Only the
 * network is faked, in process:
 *   - the chain RPC through a viem `custom` transport (every read logged; any
 *     read can be held on a deterministic gate);
 *   - Pimlico's JSON-RPC endpoint through a stubbed global `fetch` that answers
 *     https://api.pimlico.io/... locally and records (then throws for) any
 *     other URL or method. A "held" Pimlico answer returns its headers at
 *     once and holds the BODY — the stage viem reads outside its own 10 s
 *     request timeout — so a stall involves no transport timeout or retry.
 * The two SDK factories are wrapped PASS-THROUGH (the real factory is called
 * with the same values): every project callback viem invokes, every call the
 * project makes on the real Pimlico client, and every property read of the
 * top-level prepared result are recorded, with arguments, results and
 * whether they happened before or after the deadline. Nothing is mocked in
 * the deadline code itself. setTimeout/clearTimeout are faked (setImmediate
 * stays real to drain the event loop). No real RPC, provider, database,
 * signing or dispatch.
 */

type Settled = { status: "pending" | "fulfilled" | "rejected"; value?: unknown; error?: unknown };
type CallRecord = Settled & { name: string; epoch: Epoch; args: unknown[] };
type AnyFn = (...args: unknown[]) => unknown;
type Epoch = "before" | "late";

const probe = vi.hoisted(() => {
  const state = {
    /** Flipped by the tests to "late" once the deadline has fired. */
    epoch: "before" as Epoch,
    /** Every config the production code handed to createSmartAccountClient, exactly as given. */
    configs: [] as Record<string, unknown>[],
    /** Every invocation of a project callback (paymaster methods, fee callback) — by viem or by a test. */
    callbacks: [] as CallRecord[],
    /** Every call the project made on the real Pimlico client's paymaster / gas-price methods. */
    clientCalls: [] as CallRecord[],
    /** Every property read of a top-level prepared result after it reached pimlico.ts. */
    preparedReads: [] as { key: string; epoch: Epoch }[],
  };
  function track(list: CallRecord[], name: string, args: unknown[], invoke: () => unknown): unknown {
    const record: CallRecord = { name, epoch: state.epoch, args, status: "pending" };
    list.push(record);
    let result: unknown;
    try {
      result = invoke();
    } catch (error) {
      record.status = "rejected";
      record.error = error;
      throw error;
    }
    Promise.resolve(result).then(
      (value) => {
        record.status = "fulfilled";
        record.value = value;
      },
      (error: unknown) => {
        record.status = "rejected";
        record.error = error;
      },
    );
    return result;
  }
  function wrapFunctions(group: unknown): unknown {
    if (typeof group !== "object" || group === null) return group;
    return Object.fromEntries(
      Object.entries(group).map(([key, value]) => [key, typeof value === "function" ? (...args: unknown[]) => track(state.callbacks, key, args, () => (value as AnyFn)(...args)) : value]),
    );
  }
  function watchPrepared(prepared: object): object {
    return new Proxy(prepared, {
      get(target, key, receiver) {
        // `then` is the Promise machinery's own thenable probe when this value resolves an async function.
        if (key !== "then") state.preparedReads.push({ key: String(key), epoch: state.epoch });
        return Reflect.get(target, key, receiver);
      },
    });
  }
  function instrumentSmartAccountClient(create: AnyFn, config: Record<string, unknown>): unknown {
    state.configs.push(config);
    const client = create({ ...config, paymaster: wrapFunctions(config.paymaster), userOperation: wrapFunctions(config.userOperation) }) as object;
    return new Proxy(client, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key !== "prepareUserOperation" || typeof value !== "function") return value;
        return (...args: unknown[]) => (value as (...a: unknown[]) => Promise<object>)(...args).then(watchPrepared);
      },
    });
  }
  const WATCHED = new Set(["getPaymasterStubData", "getPaymasterData", "getUserOperationGasPrice"]);
  function instrumentPimlicoClient(client: object): unknown {
    return new Proxy(client, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof key !== "string" || !WATCHED.has(key) || typeof value !== "function") return value;
        return (...args: unknown[]) => track(state.clientCalls, key, args, () => (value as AnyFn)(...args));
      },
    });
  }
  return { state, instrumentSmartAccountClient, instrumentPimlicoClient };
});

vi.mock("permissionless", async (importOriginal) => {
  const actual = await importOriginal<typeof import("permissionless")>();
  return { ...actual, createSmartAccountClient: (config: Record<string, unknown>) => probe.instrumentSmartAccountClient(actual.createSmartAccountClient as unknown as AnyFn, config) };
});
vi.mock("permissionless/clients/pimlico", async (importOriginal) => {
  const actual = await importOriginal<typeof import("permissionless/clients/pimlico")>();
  return { ...actual, createPimlicoClient: (config: Parameters<typeof actual.createPimlicoClient>[0]) => probe.instrumentPimlicoClient(actual.createPimlicoClient(config)) };
});

const API_KEY = "pim_SECRETKEY_prepare_test";
const PIMLICO_URL = `https://api.pimlico.io/v2/84532/rpc?apikey=${API_KEY}`;
const SECRET = "4c1e5b7d9f0a2c4e6b8d0f7f3c9a1e5b2d4f60a8c7e9b1d3f5a7c90e2b4d6f8a";
const PAYER_OWNER = getAddress("0xf6c3fe6de636f0d8f421d5485d1a64ff3628cfaf");
const RECIPIENT = "0x2222222222222222222222222222222222222222" as Address;
const AMOUNT = "1000000";
const DEADLINE_MS = 25_000;
const SAFE_PREPARE_FAILED = "Could not prepare this payment right now. Try again in a moment.";
const PAYMASTER = "0x7777777777777777777777777777777777777777";
const STUB_DATA = `0x${"ab".repeat(20)}`;
const FINAL_DATA = `0x${"cd".repeat(24)}`;
const hexOf = (value: number | bigint) => `0x${BigInt(value).toString(16)}`;

// ---------------------------------------------------------------------------
// Deterministic promises, observation, event-loop draining
// ---------------------------------------------------------------------------

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Attaches both handlers at once, so the observed promise itself can never be an unhandled rejection. */
function observe<T>(promise: Promise<T>): Settled & { value?: T } {
  const observed: Settled & { value?: T } = { status: "pending" };
  promise.then(
    (value) => {
      observed.status = "fulfilled";
      observed.value = value;
    },
    (error: unknown) => {
      observed.status = "rejected";
      observed.error = error;
    },
  );
  return observed;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
async function drain(turns = 30) {
  for (let i = 0; i < turns; i += 1) await flush();
}
async function flushUntil(condition: () => boolean, label: string) {
  for (let i = 0; i < 400; i += 1) {
    if (condition()) return;
    await flush();
  }
  throw new Error(`never reached: ${label}`);
}
const advance = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
};

function expectDeadline(observed: Settled) {
  expect(observed.status).toBe("rejected");
  expect(observed.value).toBeUndefined();
  expect(observed.error).toBeInstanceOf(CashTransferPreparationDeadlineError);
  expect((observed.error as Error).name).toBe("CashTransferPreparationDeadlineError");
  expect((observed.error as Error).message).toBe("The payment preparation did not finish in time.");
  const text = `${(observed.error as Error).message} ${String((observed.error as Error).stack)}`;
  expect(text).not.toMatch(/https?:|apikey|pimlico\.io|SECRETKEY|provider body/);
}

// ---------------------------------------------------------------------------
// Offline chain fake (custom transport); any read can be held
// ---------------------------------------------------------------------------

type ChainRead = "proxyCreationCode" | "getNonce" | "getCode" | "balanceOf" | "decimals" | "chainId" | "block";
const GET_NONCE_SELECTOR = "0x35567e1a";
const BALANCE_OF_SELECTOR = "0x70a08231";
const DECIMALS_SELECTOR = "0x313ce567";
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

let chainState: { deployed: boolean; seq: bigint };
const chainLog: { read: ChainRead; epoch: Epoch }[] = [];
const chainHolds = new Map<ChainRead, Deferred<void>[]>();
const refused: string[] = [];

function holdChain(read: ChainRead) {
  const gate = deferred<void>();
  chainHolds.set(read, [...(chainHolds.get(read) ?? []), gate]);
  return gate;
}

function publicClient() {
  return createPublicClient({
    chain: baseSepolia,
    transport: custom({
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        let read: ChainRead;
        let answer: () => unknown;
        if (method === "eth_call") {
          const data = ((params?.[0] ?? {}) as { data?: Hex }).data ?? "0x";
          const selector = data.slice(0, 10);
          if (selector === GET_NONCE_SELECTOR) {
            read = "getNonce";
            const { args } = decodeFunctionData({ abi: ENTRY_POINT_GET_NONCE_ABI, data });
            answer = () => encodeAbiParameters([{ type: "uint256" }], [(args[1] << BigInt(64)) | chainState.seq]);
          } else if (selector === BALANCE_OF_SELECTOR) {
            read = "balanceOf";
            answer = () => encodeAbiParameters([{ type: "uint256" }], [BigInt(100_000_000)]);
          } else if (selector === DECIMALS_SELECTOR) {
            read = "decimals";
            answer = () => encodeAbiParameters([{ type: "uint8" }], [6]);
          } else {
            read = "proxyCreationCode";
            answer = () => encodeAbiParameters([{ type: "bytes" }], ["0x600a600c600039600a6000f3"]);
          }
        } else if (method === "eth_getCode") {
          read = "getCode";
          answer = () => (chainState.deployed ? "0x6080604052348015600f57600080fd5b50" : "0x");
        } else if (method === "eth_chainId") {
          read = "chainId";
          answer = () => hexOf(baseSepolia.id);
        } else if (method === "eth_getBlockByNumber") {
          read = "block";
          answer = () => rpcBlock();
        } else {
          refused.push(`chain:${method}`);
          throw new Error(`Unexpected chain RPC call in an offline test: ${method}`);
        }
        chainLog.push({ read, epoch: probe.state.epoch });
        const gate = chainHolds.get(read)?.shift();
        if (gate) await gate.promise;
        return answer();
      },
    }),
  });
}

// ---------------------------------------------------------------------------
// Offline Pimlico fake (stubbed fetch); any answer can be scripted or held
// ---------------------------------------------------------------------------

type PimlicoMethod = "pimlico_getUserOperationGasPrice" | "pm_getPaymasterStubData" | "eth_estimateUserOperationGas" | "pm_getPaymasterData";
type RpcError = { code: number; message: string };
type Answer = { result?: unknown; error?: RpcError };
type Spec = { hold?: boolean; shape?: (honest: Record<string, unknown>) => Record<string, unknown>; error?: RpcError };
type PimlicoRequest = { method: string; params: unknown[]; epoch: Epoch; url: string; release?: (answer?: Answer) => void };

const pimlicoLog: PimlicoRequest[] = [];
const pimlicoSpecs = new Map<string, Spec[]>();

function script(method: PimlicoMethod, spec: Spec) {
  pimlicoSpecs.set(method, [...(pimlicoSpecs.get(method) ?? []), spec]);
}
/** The NEXT request of `method` gets its headers at once and its body only on release. */
function hold(method: PimlicoMethod, shape?: Spec["shape"]) {
  script(method, { hold: true, shape });
}

const TIERS = {
  slow: { maxFeePerGas: hexOf(1_000_000), maxPriorityFeePerGas: hexOf(500_000) },
  standard: { maxFeePerGas: hexOf(2_000_000), maxPriorityFeePerGas: hexOf(1_000_000) },
  fast: { maxFeePerGas: hexOf(3_000_000), maxPriorityFeePerGas: hexOf(1_500_000) },
};
function honest(method: string): Record<string, unknown> {
  switch (method) {
    case "pimlico_getUserOperationGasPrice":
      return TIERS;
    case "pm_getPaymasterStubData":
      return { paymaster: PAYMASTER, paymasterData: STUB_DATA, paymasterVerificationGasLimit: hexOf(50_000), paymasterPostOpGasLimit: hexOf(10_000) };
    case "eth_estimateUserOperationGas":
      return { preVerificationGas: hexOf(60_000), verificationGasLimit: hexOf(150_000), callGasLimit: hexOf(80_000), paymasterVerificationGasLimit: hexOf(50_000), paymasterPostOpGasLimit: hexOf(10_000) };
    case "pm_getPaymasterData":
      return { paymaster: PAYMASTER, paymasterData: FINAL_DATA, paymasterVerificationGasLimit: hexOf(50_000), paymasterPostOpGasLimit: hexOf(10_000) };
    default:
      throw new Error(`no honest answer for ${method}`);
  }
}

const fakeFetch = vi.fn(async (url: unknown, init?: { body?: unknown }) => {
  const href = typeof url === "string" ? url : url instanceof URL ? url.href : String((url as { url?: string })?.url);
  if (!href.startsWith("https://api.pimlico.io/")) {
    refused.push(`url:${href}`);
    throw new Error("Network access refused in an offline test.");
  }
  const body = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown[] };
  if (Array.isArray(body) || !["pimlico_getUserOperationGasPrice", "pm_getPaymasterStubData", "eth_estimateUserOperationGas", "pm_getPaymasterData"].includes(body.method)) {
    refused.push(`method:${Array.isArray(body) ? "batch" : body.method}`);
    throw new Error("Unexpected Pimlico method in an offline test.");
  }
  const entry: PimlicoRequest = { method: body.method, params: body.params ?? [], epoch: probe.state.epoch, url: href };
  pimlicoLog.push(entry);
  const spec = pimlicoSpecs.get(body.method)?.shift() ?? {};
  const payloadFor = (answer?: Answer) => {
    const error = answer?.error ?? spec.error;
    if (error) return { jsonrpc: "2.0", id: body.id, error };
    const result = answer && "result" in answer ? answer.result : (spec.shape ?? ((value) => value))(honest(body.method));
    return { jsonrpc: "2.0", id: body.id, result };
  };
  const headers = { "content-type": "application/json" };
  if (!spec.hold) return new Response(JSON.stringify(payloadFor()), { status: 200, headers });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  entry.release = (answer?: Answer) => {
    controller.enqueue(new TextEncoder().encode(JSON.stringify(payloadFor(answer))));
    controller.close();
  };
  return new Response(stream, { status: 200, headers });
});

const methods = () => pimlicoLog.map((entry) => entry.method);
const requestsOf = (method: string) => pimlicoLog.filter((entry) => entry.method === method);
const lateRequests = () => pimlicoLog.filter((entry) => entry.epoch === "late").map((entry) => entry.method);
const heldOf = (method: string) => pimlicoLog.filter((entry) => entry.method === method && entry.release);
const callbacksOf = (name: string) => probe.state.callbacks.filter((record) => record.name === name);
const clientCallsOf = (name: string) => probe.state.clientCalls.filter((record) => record.name === name);
function countsOf(list: string[]) {
  const counts: Record<string, number> = {};
  for (const item of list) counts[item] = (counts[item] ?? 0) + 1;
  return counts;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let payerSafe: Address;
let expectedCallData: Hex;
let localFactory: Address;
let localFactoryData: Hex;

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(async () => {
  chainState = { deployed: false, seq: BigInt(0) };
  vi.stubGlobal("fetch", fakeFetch);
  // Local expectations, derived with real timers before the fakes are armed.
  const account = await createRealSafeAccount({ owner: createReadOnlyOwnerAccount(PAYER_OWNER), publicClient: publicClient() });
  payerSafe = account.address;
  expectedCallData = await account.encodeCalls([{ to: REAL_CASH_TOKEN.address, data: encodeCashTransfer(RECIPIENT, AMOUNT), value: BigInt(0) }]);
  const factoryArgs = await account.getFactoryArgs();
  localFactory = factoryArgs.factory as Address;
  localFactoryData = factoryArgs.factoryData as Hex;
  chainLog.length = 0;
  chainHolds.clear();
  pimlicoLog.length = 0;
  pimlicoSpecs.clear();
  refused.length = 0;
  fakeFetch.mockClear();
  probe.state.epoch = "before";
  probe.state.configs.length = 0;
  probe.state.callbacks.length = 0;
  probe.state.clientCalls.length = 0;
  probe.state.preparedReads.length = 0;
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(async () => {
  vi.useRealTimers();
  await drain(5);
  process.off("unhandledRejection", onUnhandled);
  vi.unstubAllGlobals();
  // No controlled late failure in any test escapes as an unhandled rejection, and nothing
  // reached an unexpected URL, RPC method or chain read.
  expect(unhandled).toEqual([]);
  expect(refused).toEqual([]);
});

const prepare = (overrides: { ownerAddress?: Address } = {}) =>
  observe(prepareCashTransferUserOperation({ publicClient: publicClient(), pimlicoApiKey: API_KEY, ownerAddress: PAYER_OWNER, recipient: RECIPIENT, amountBaseUnits: AMOUNT, ...overrides }));

/** Advance to exactly the deadline of a call started at the current fake time, and mark everything after it "late". */
async function expire(alreadyElapsed = 0) {
  await advance(DEADLINE_MS - 1 - alreadyElapsed);
  await advance(1);
  probe.state.epoch = "late";
}

/** A stub answer without a paymaster: viem then runs the nested stub (and final) inside gas estimation. */
const withoutPaymaster = (value: Record<string, unknown>) => {
  const rest = { ...value };
  delete rest.paymaster;
  return rest;
};
const withIsFinal = (value: Record<string, unknown>) => ({ ...value, isFinal: true });

function expectNoProjectWorkAfterDeadline() {
  expect(lateRequests()).toEqual([]);
  expect(chainLog.filter((entry) => entry.epoch === "late")).toEqual([]);
  expect(probe.state.clientCalls.filter((record) => record.epoch === "late")).toEqual([]);
  expect(probe.state.preparedReads.filter((read) => read.epoch === "late")).toEqual([]);
}

// ---------------------------------------------------------------------------
// Honest-path compatibility (the wrapper changes nothing)
// ---------------------------------------------------------------------------

describe("honest preparation through the guarded callbacks is unchanged", () => {
  it("H1/D14: undeployed Safe — the locally derived nonce, factory and callData; per-method counts unchanged; no timer left", async () => {
    const result = prepare();
    await flushUntil(() => result.status !== "pending", "prepared");
    expect(result.status).toBe("fulfilled");
    const prepared = result.value!;
    expect(prepared.sender).toBe(payerSafe);
    expect(prepared.callData).toBe(expectedCallData);
    expect(prepared.factory).toBe(localFactory);
    expect(prepared.factoryData).toBe(localFactoryData);
    expect(countsOf(methods())).toEqual({ pimlico_getUserOperationGasPrice: 1, pm_getPaymasterStubData: 1, eth_estimateUserOperationGas: 1, pm_getPaymasterData: 1 });
    expect(methods()).toEqual(["pimlico_getUserOperationGasPrice", "pm_getPaymasterStubData", "eth_estimateUserOperationGas", "pm_getPaymasterData"]);
    expect(countsOf(chainLog.map((entry) => entry.read))).toEqual({ proxyCreationCode: 1, getNonce: 1, getCode: 1 });
    expect(vi.getTimerCount()).toBe(0);
    await advance(DEADLINE_MS * 2);
    expect(result.status).toBe("fulfilled");
    for (const request of pimlicoLog) expect(request.url).toBe(PIMLICO_URL);
  });

  it("H2: deployed Safe — no factory fields sent or returned; the read nonce sequence is used; counts unchanged", async () => {
    chainState = { deployed: true, seq: BigInt(7) };
    const result = prepare();
    await flushUntil(() => result.status !== "pending", "prepared");
    expect(result.status).toBe("fulfilled");
    expect(result.value!.factory).toBeUndefined();
    expect(result.value!.factoryData).toBeUndefined();
    expect(result.value!.nonce & ((BigInt(1) << BigInt(64)) - BigInt(1))).toBe(BigInt(7));
    for (const request of requestsOf("pm_getPaymasterStubData")) expect((request.params[0] as Record<string, unknown>).factory).toBeUndefined();
    expect(countsOf(methods())).toEqual({ pimlico_getUserOperationGasPrice: 1, pm_getPaymasterStubData: 1, eth_estimateUserOperationGas: 1, pm_getPaymasterData: 1 });
    expect(countsOf(chainLog.map((entry) => entry.read))).toEqual({ proxyCreationCode: 1, getNonce: 1, getCode: 1 });
  });

  it("H3/H4: the existing fee tier (fast) is used, and the final paymaster fields are the ones returned", async () => {
    const result = prepare();
    await flushUntil(() => result.status !== "pending", "prepared");
    const prepared = result.value!;
    expect(prepared.maxFeePerGas).toBe(BigInt(3_000_000));
    expect(prepared.maxPriorityFeePerGas).toBe(BigInt(1_500_000));
    expect(prepared.paymaster).toBe(PAYMASTER);
    expect(prepared.paymasterData).toBe(FINAL_DATA);
    expect(prepared.paymasterVerificationGasLimit).toBe(BigInt(50_000));
    expect(prepared.paymasterPostOpGasLimit).toBe(BigInt(10_000));
    expect(prepared.callGasLimit).toBe(BigInt(80_000));
    expect(prepared.verificationGasLimit).toBe(BigInt(150_000));
    expect(prepared.preVerificationGas).toBe(BigInt(60_000));
    // The fee callback handed viem exactly the client's `fast` tier object.
    const [fee] = callbacksOf("estimateFeesPerGas");
    const [price] = clientCallsOf("getUserOperationGasPrice");
    expect(fee.status).toBe("fulfilled");
    expect(fee.value).toBe((price.value as { fast: unknown }).fast);
    expect(price.args).toEqual([]);
  });

  it("H5: both paymaster methods are wired, each delegating viem's exact argument object to the real client and handing back the client's exact result", async () => {
    const result = prepare();
    await flushUntil(() => result.status !== "pending", "prepared");
    const [config] = probe.state.configs;
    // No sponsorship policy, context, validity or other new setting: the same keys as before, with both paymaster methods.
    expect(Object.keys(config).sort()).toEqual(["account", "bundlerTransport", "chain", "client", "paymaster", "userOperation"]);
    expect(Object.keys(config.paymaster as object).sort()).toEqual(["getPaymasterData", "getPaymasterStubData"]);
    expect(Object.keys(config.userOperation as object)).toEqual(["estimateFeesPerGas"]);
    for (const name of ["getPaymasterStubData", "getPaymasterData"]) {
      const wrapper = callbacksOf(name);
      const client = clientCallsOf(name);
      expect(wrapper).toHaveLength(1);
      expect(client).toHaveLength(1);
      expect(wrapper[0].args).toHaveLength(1);
      expect(client[0].args).toHaveLength(1);
      expect(client[0].args[0]).toBe(wrapper[0].args[0]);
      expect(wrapper[0].status).toBe("fulfilled");
      expect(wrapper[0].value).toBe(client[0].value);
      const args = wrapper[0].args[0] as Record<string, unknown>;
      expect(args.chainId).toBe(84532);
      expect(args.entryPointAddress).toBe(entryPoint07Address);
      expect(args.context).toBeUndefined();
      expect(args.sender).toBe(payerSafe);
      expect(args.callData).toBe(expectedCallData);
    }
    // On the wire: the userOperation, EntryPoint 0.7, Base Sepolia's chain id and an empty (null) context — no sponsorship policy or validity setting.
    for (const method of ["pm_getPaymasterStubData", "pm_getPaymasterData"]) {
      const [request] = requestsOf(method);
      expect(request.params[1]).toBe(entryPoint07Address);
      expect(request.params[2]).toBe(hexOf(84532));
      expect(request.params[3]).toBeNull();
      expect(request.params).toHaveLength(4);
    }
  });

  it("H6: a stub with isFinal: true still skips the final request (counts unchanged), and the stub's data is used", async () => {
    script("pm_getPaymasterStubData", { shape: withIsFinal });
    const result = prepare();
    await flushUntil(() => result.status !== "pending", "prepared");
    expect(result.status).toBe("fulfilled");
    expect(result.value!.paymasterData).toBe(STUB_DATA);
    expect(countsOf(methods())).toEqual({ pimlico_getUserOperationGasPrice: 1, pm_getPaymasterStubData: 1, eth_estimateUserOperationGas: 1 });
    expect((callbacksOf("getPaymasterStubData")[0].value as { isFinal?: boolean }).isFinal).toBe(true);
    expect(callbacksOf("getPaymasterData")).toHaveLength(0);
  });

  it("H7: a stub without a paymaster takes viem's nested path — second stub and nested final inside estimation, then the outer final — all through the wrapper", async () => {
    script("pm_getPaymasterStubData", { shape: withoutPaymaster });
    script("pm_getPaymasterStubData", { shape: withoutPaymaster });
    const result = prepare();
    await flushUntil(() => result.status !== "pending", "prepared");
    expect(result.status).toBe("fulfilled");
    expect(methods()).toEqual(["pimlico_getUserOperationGasPrice", "pm_getPaymasterStubData", "pm_getPaymasterStubData", "pm_getPaymasterData", "eth_estimateUserOperationGas", "pm_getPaymasterData"]);
    // Every paymaster request, outer and nested, went through the guarded wrapper — none bypassed it.
    expect(callbacksOf("getPaymasterStubData")).toHaveLength(2);
    expect(callbacksOf("getPaymasterData")).toHaveLength(2);
    expect(clientCallsOf("getPaymasterStubData")).toHaveLength(2);
    expect(clientCallsOf("getPaymasterData")).toHaveLength(2);
    expect(result.value!.paymaster).toBe(PAYMASTER);
    expect(result.value!.paymasterData).toBe(FINAL_DATA);
  });

  it("H8: the nested final-stub variant (the nested stub is final) — stub ×2, one outer final — through the wrapper", async () => {
    script("pm_getPaymasterStubData", { shape: withoutPaymaster });
    script("pm_getPaymasterStubData", { shape: withIsFinal });
    const result = prepare();
    await flushUntil(() => result.status !== "pending", "prepared");
    expect(result.status).toBe("fulfilled");
    expect(methods()).toEqual(["pimlico_getUserOperationGasPrice", "pm_getPaymasterStubData", "pm_getPaymasterStubData", "eth_estimateUserOperationGas", "pm_getPaymasterData"]);
    expect(callbacksOf("getPaymasterStubData")).toHaveLength(2);
    expect(callbacksOf("getPaymasterData")).toHaveLength(1);
  });

  it("H9/D13/D15: ordinary errors before the deadline pass through unchanged and clear the timer — callData mismatch, structural integrity, and the provider's own error object", async () => {
    script("pm_getPaymasterData", { shape: (value) => ({ ...value, callData: "0xdeadbeef" }) });
    const mismatch = prepare();
    await flushUntil(() => mismatch.status !== "pending", "mismatch");
    expect(mismatch.error).toBeInstanceOf(PreparedCallDataMismatchError);
    expect(vi.getTimerCount()).toBe(0);

    script("pm_getPaymasterData", { shape: (value) => ({ ...value, paymaster: "0x0000000000000000000000000000000000000000" }) });
    const integrity = prepare();
    await flushUntil(() => integrity.status !== "pending", "integrity");
    expect(integrity.error).toBeInstanceOf(PreparedUserOperationIntegrityError);
    expect(vi.getTimerCount()).toBe(0);

    probe.state.clientCalls.length = 0;
    pimlicoLog.length = 0;
    script("pm_getPaymasterStubData", { error: { code: -32602, message: "provider body: invalid params" } });
    const failed = prepare();
    await flushUntil(() => failed.status !== "pending", "provider error");
    expect(failed.status).toBe("rejected");
    expect(failed.error).not.toBeInstanceOf(CashTransferPreparationDeadlineError);
    // The very object the real client rejected with, not wrapped or normalized.
    expect(failed.error).toBe(clientCallsOf("getPaymasterStubData")[0].error);
    expect(vi.getTimerCount()).toBe(0);
    // Not retried by the project (and this error code is not retried by the transport either).
    expect(countsOf(methods())).toEqual({ pimlico_getUserOperationGasPrice: 1, pm_getPaymasterStubData: 1 });
    await advance(DEADLINE_MS * 2);
    expect(countsOf(methods())).toEqual({ pimlico_getUserOperationGasPrice: 1, pm_getPaymasterStubData: 1 });
  });

  it("D16: a synchronous throw inside the preparation (a malformed owner address) rejects with that error and leaves no timer", async () => {
    const result = prepare({ ownerAddress: "0xnot-an-address" as Address });
    await flushUntil(() => result.status !== "pending", "sync throw");
    expect(result.status).toBe("rejected");
    expect((result.error as Error).name).toBe("InvalidAddressError");
    expect(vi.getTimerCount()).toBe(0);
    expect(chainLog).toEqual([]);
    expect(pimlicoLog).toEqual([]);
  });

  it("D21 (sanity): on the honest path pimlico.ts does read the prepared result — so an empty read log after expiry is meaningful", async () => {
    const result = prepare();
    await flushUntil(() => result.status !== "pending", "prepared");
    const keys = probe.state.preparedReads.map((read) => read.key);
    expect(keys).toContain("callData");
    expect(keys).toContain("paymaster");
  });
});

// ---------------------------------------------------------------------------
// The 25 s deadline at every stage
// ---------------------------------------------------------------------------

describe("prepareCashTransferUserOperation — one 25 s caller deadline", () => {
  it("D1/D2/D17/D20: a stalled preparation is pending at 24 999 ms and rejects at 25 000 ms with the fixed error — never a value", async () => {
    hold("pm_getPaymasterStubData");
    const result = prepare();
    await flushUntil(() => heldOf("pm_getPaymasterStubData").length === 1, "stub held");
    await advance(DEADLINE_MS - 1);
    expect(result.status).toBe("pending");
    await advance(1);
    expectDeadline(result);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("D3/D5: the timer is armed before any work — already pending while Safe account construction's first read is in flight; a stalled construction times out and its late answer starts nothing", async () => {
    const gate = holdChain("proxyCreationCode");
    const result = prepare();
    await flushUntil(() => chainLog.length === 1, "account read started");
    expect(chainLog.map((entry) => entry.read)).toEqual(["proxyCreationCode"]);
    expect(vi.getTimerCount()).toBe(1);
    await expire();
    expectDeadline(result);
    gate.resolve();
    await drain();
    expectDeadline(result);
    // No client was built, no nonce / deployment read and no provider request after the late answer.
    expect(probe.state.configs).toHaveLength(0);
    expect(chainLog.map((entry) => entry.read)).toEqual(["proxyCreationCode"]);
    expect(pimlicoLog).toEqual([]);
    expectNoProjectWorkAfterDeadline();
  });

  it("D4: the deadline is not reset between stages — 8 s in construction, 8 s in the nonce read, then the gas price: pending at 24 999, rejected at 25 000", async () => {
    const account = holdChain("proxyCreationCode");
    const nonce = holdChain("getNonce");
    hold("pimlico_getUserOperationGasPrice");
    const result = prepare();
    await flushUntil(() => chainLog.length === 1, "construction");
    await advance(8_000);
    account.resolve();
    await flushUntil(() => chainLog.some((entry) => entry.read === "getNonce"), "nonce read");
    await advance(8_000);
    nonce.resolve();
    await flushUntil(() => heldOf("pimlico_getUserOperationGasPrice").length === 1, "gas price held");
    await advance(DEADLINE_MS - 16_000 - 1);
    expect(result.status).toBe("pending");
    await advance(1);
    expectDeadline(result);
  });

  it("D6: a stalled nonce / deployment read times out; its late answer starts no SDK preparation, callback or provider request", async () => {
    const gate = holdChain("getNonce");
    const result = prepare();
    await flushUntil(() => chainLog.some((entry) => entry.read === "getNonce"), "nonce read");
    await expire();
    expectDeadline(result);
    gate.resolve();
    await drain();
    expect(probe.state.callbacks).toEqual([]);
    expect(pimlicoLog).toEqual([]);
    expectNoProjectWorkAfterDeadline();
  });

  it("D7/C2: a stalled gas-price request times out; the late price is not handed to viem (the fee callback rejects) and no stub request starts", async () => {
    hold("pimlico_getUserOperationGasPrice");
    const result = prepare();
    await flushUntil(() => heldOf("pimlico_getUserOperationGasPrice").length === 1, "gas price held");
    await expire();
    expectDeadline(result);
    heldOf("pimlico_getUserOperationGasPrice")[0].release!();
    await drain();
    const [price] = clientCallsOf("getUserOperationGasPrice");
    expect(price.status).toBe("fulfilled");
    const [fee] = callbacksOf("estimateFeesPerGas");
    expect(fee.status).toBe("rejected");
    expect(fee.error).toBeInstanceOf(CashTransferPreparationDeadlineError);
    expect(methods()).toEqual(["pimlico_getUserOperationGasPrice"]);
    expect(callbacksOf("getPaymasterStubData")).toEqual([]);
    expectNoProjectWorkAfterDeadline();
  });

  it("D8/C5: a stalled stub request times out; the late stub is not handed to viem, so no estimation or final request starts", async () => {
    hold("pm_getPaymasterStubData");
    const result = prepare();
    await flushUntil(() => heldOf("pm_getPaymasterStubData").length === 1, "stub held");
    await expire();
    expectDeadline(result);
    heldOf("pm_getPaymasterStubData")[0].release!();
    await drain();
    expect(clientCallsOf("getPaymasterStubData")[0].status).toBe("fulfilled");
    const [stub] = callbacksOf("getPaymasterStubData");
    expect(stub.status).toBe("rejected");
    expect(stub.error).toBeInstanceOf(CashTransferPreparationDeadlineError);
    expect(methods()).toEqual(["pimlico_getUserOperationGasPrice", "pm_getPaymasterStubData"]);
    expectNoProjectWorkAfterDeadline();
  });

  it("D9/C4/C9: a stalled estimation times out; viem's own continuation then reaches the final callback, which starts no final request", async () => {
    hold("eth_estimateUserOperationGas");
    const result = prepare();
    await flushUntil(() => heldOf("eth_estimateUserOperationGas").length === 1, "estimate held");
    await expire();
    expectDeadline(result);
    // The in-flight estimation is not aborted: its late answer is still read and processed by viem.
    heldOf("eth_estimateUserOperationGas")[0].release!();
    await drain();
    const finals = callbacksOf("getPaymasterData");
    expect(finals).toHaveLength(1);
    expect(finals[0].epoch).toBe("late");
    expect(finals[0].status).toBe("rejected");
    expect(finals[0].error).toBeInstanceOf(CashTransferPreparationDeadlineError);
    expect(clientCallsOf("getPaymasterData")).toEqual([]);
    expect(requestsOf("pm_getPaymasterData")).toEqual([]);
    expectNoProjectWorkAfterDeadline();
  });

  it("C9: SDK-internal continuation is NOT stopped — a retryable estimation error after the deadline is retried by viem's transport, a request this deadline does not prevent; the final callback is still refused", async () => {
    hold("eth_estimateUserOperationGas");
    const result = prepare();
    await flushUntil(() => heldOf("eth_estimateUserOperationGas").length === 1, "estimate held");
    await expire();
    expectDeadline(result);
    heldOf("eth_estimateUserOperationGas")[0].release!({ error: { code: -32603, message: "internal" } });
    await drain();
    await advance(150); // viem's first exponential backoff step
    await drain();
    // Accepted limitation: the transport's own retry of an already-started request runs after the deadline.
    expect(lateRequests()).toEqual(["eth_estimateUserOperationGas"]);
    // ...and viem then reaches the final callback, which still starts no final request.
    const [final] = callbacksOf("getPaymasterData");
    expect(final.epoch).toBe("late");
    expect(final.error).toBeInstanceOf(CashTransferPreparationDeadlineError);
    expect(requestsOf("pm_getPaymasterData")).toEqual([]);
    expect(probe.state.preparedReads).toEqual([]);
  });

  it("D10/C6: a stalled final request times out; the late final answer is not handed back, so no prepared result reaches pimlico.ts", async () => {
    hold("pm_getPaymasterData");
    const result = prepare();
    await flushUntil(() => heldOf("pm_getPaymasterData").length === 1, "final held");
    await expire();
    expectDeadline(result);
    heldOf("pm_getPaymasterData")[0].release!();
    await drain();
    expect(clientCallsOf("getPaymasterData")[0].status).toBe("fulfilled");
    expect(callbacksOf("getPaymasterData")[0].error).toBeInstanceOf(CashTransferPreparationDeadlineError);
    expect(probe.state.preparedReads).toEqual([]);
    expectNoProjectWorkAfterDeadline();
  });

  it("D11/C7: a stalled NESTED stub (inside gas estimation) times out; its late answer is refused by the same wrapper — no nested final, estimation or outer final", async () => {
    script("pm_getPaymasterStubData", { shape: withoutPaymaster });
    hold("pm_getPaymasterStubData", withoutPaymaster);
    const result = prepare();
    await flushUntil(() => heldOf("pm_getPaymasterStubData").length === 1, "nested stub held");
    expect(methods()).toEqual(["pimlico_getUserOperationGasPrice", "pm_getPaymasterStubData", "pm_getPaymasterStubData"]);
    await expire();
    expectDeadline(result);
    heldOf("pm_getPaymasterStubData")[0].release!();
    await drain();
    const stubs = callbacksOf("getPaymasterStubData");
    expect(stubs).toHaveLength(2);
    expect(stubs[1].error).toBeInstanceOf(CashTransferPreparationDeadlineError);
    expect(methods()).toEqual(["pimlico_getUserOperationGasPrice", "pm_getPaymasterStubData", "pm_getPaymasterStubData"]);
    expect(callbacksOf("getPaymasterData")).toEqual([]);
    expectNoProjectWorkAfterDeadline();
  });

  it("D12/C7: a stalled NESTED final request times out; its late answer is refused — no estimation and no outer final", async () => {
    script("pm_getPaymasterStubData", { shape: withoutPaymaster });
    script("pm_getPaymasterStubData", { shape: withoutPaymaster });
    hold("pm_getPaymasterData");
    const result = prepare();
    await flushUntil(() => heldOf("pm_getPaymasterData").length === 1, "nested final held");
    await expire();
    expectDeadline(result);
    heldOf("pm_getPaymasterData")[0].release!();
    await drain();
    expect(callbacksOf("getPaymasterData")).toHaveLength(1);
    expect(callbacksOf("getPaymasterData")[0].error).toBeInstanceOf(CashTransferPreparationDeadlineError);
    expect(methods()).toEqual(["pimlico_getUserOperationGasPrice", "pm_getPaymasterStubData", "pm_getPaymasterStubData", "pm_getPaymasterData"]);
    expectNoProjectWorkAfterDeadline();
  });

  it("C7: in the nested path, a stalled estimation's late answer reaches only the outer final callback — refused, no request", async () => {
    script("pm_getPaymasterStubData", { shape: withoutPaymaster });
    script("pm_getPaymasterStubData", { shape: withoutPaymaster });
    hold("eth_estimateUserOperationGas");
    const result = prepare();
    await flushUntil(() => heldOf("eth_estimateUserOperationGas").length === 1, "estimate held");
    await expire();
    expectDeadline(result);
    heldOf("eth_estimateUserOperationGas")[0].release!();
    await drain();
    const finals = callbacksOf("getPaymasterData");
    expect(finals).toHaveLength(2);
    expect(finals[1].epoch).toBe("late");
    expect(finals[1].error).toBeInstanceOf(CashTransferPreparationDeadlineError);
    expect(requestsOf("pm_getPaymasterData")).toHaveLength(1);
    expectNoProjectWorkAfterDeadline();
  });

  it("D18/D21: a late SUCCESSFUL preparation (isFinal stub, estimation answered late) is discarded — never compared, verified or returned", async () => {
    script("pm_getPaymasterStubData", { shape: withIsFinal });
    hold("eth_estimateUserOperationGas");
    const result = prepare();
    await flushUntil(() => heldOf("eth_estimateUserOperationGas").length === 1, "estimate held");
    await expire();
    expectDeadline(result);
    heldOf("eth_estimateUserOperationGas")[0].release!();
    await drain();
    expectDeadline(result);
    // viem finished (no final needed), but pimlico.ts read nothing of the late result.
    expect(callbacksOf("getPaymasterData")).toEqual([]);
    expect(probe.state.preparedReads).toEqual([]);
    expectNoProjectWorkAfterDeadline();
  });

  it("D19: a late REJECTION is consumed — no unhandled rejection (checked after every test), no change to the answer, nothing retried", async () => {
    hold("pm_getPaymasterStubData");
    const result = prepare();
    await flushUntil(() => heldOf("pm_getPaymasterStubData").length === 1, "stub held");
    await expire();
    heldOf("pm_getPaymasterStubData")[0].release!({ error: { code: -32602, message: "provider body: late failure" } });
    await drain();
    expectDeadline(result);
    expect(clientCallsOf("getPaymasterStubData")[0].status).toBe("rejected");
    await advance(DEADLINE_MS * 2);
    expect(methods()).toEqual(["pimlico_getUserOperationGasPrice", "pm_getPaymasterStubData"]);
  });

  it("C1/C3/C4: the guarded callbacks invoked directly after expiry reject at once and start no gas-price, stub or final request", async () => {
    const gate = holdChain("getNonce");
    const result = prepare();
    await flushUntil(() => chainLog.some((entry) => entry.read === "getNonce"), "nonce read");
    await expire();
    expectDeadline(result);
    const [config] = probe.state.configs;
    const paymaster = config.paymaster as Record<string, (args: unknown) => Promise<unknown>>;
    const userOperation = config.userOperation as Record<string, (args: unknown) => Promise<unknown>>;
    const args = { chainId: 84532, entryPointAddress: entryPoint07Address, sender: payerSafe, nonce: BigInt(0), callData: expectedCallData };
    for (const call of [() => userOperation.estimateFeesPerGas({}), () => paymaster.getPaymasterStubData(args), () => paymaster.getPaymasterData(args)]) {
      const outcome = observe(call());
      await drain(3);
      expectDeadline(outcome);
    }
    gate.resolve();
    await drain();
    expect(probe.state.clientCalls).toEqual([]);
    expect(pimlicoLog).toEqual([]);
    expectNoProjectWorkAfterDeadline();
  });

  it("C8: whichever stage is stalled, releasing EVERYTHING after the deadline starts no new project-controlled provider request", async () => {
    for (const method of ["pimlico_getUserOperationGasPrice", "pm_getPaymasterStubData", "pm_getPaymasterData"] as const) {
      pimlicoLog.length = 0;
      probe.state.epoch = "before";
      hold(method);
      const result = prepare();
      await flushUntil(() => heldOf(method).length === 1, `${method} held`);
      await expire();
      expectDeadline(result);
      heldOf(method)[0].release!();
      await drain();
      expect(lateRequests()).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Per-invocation isolation and ordering
// ---------------------------------------------------------------------------

describe("per-invocation deadline isolation and ordering", () => {
  it("C10/C12: overlapping calls keep independent timers; the older one timing out does not affect the newer one", async () => {
    hold("pm_getPaymasterStubData");
    hold("pm_getPaymasterStubData");
    const older = prepare();
    await flushUntil(() => heldOf("pm_getPaymasterStubData").length === 1, "older held");
    await advance(10_000);
    const newer = prepare();
    await flushUntil(() => heldOf("pm_getPaymasterStubData").length === 2, "newer held");
    expect(vi.getTimerCount()).toBe(2);
    await advance(DEADLINE_MS - 10_000);
    expectDeadline(older);
    expect(newer.status).toBe("pending");
    expect(vi.getTimerCount()).toBe(1);
    heldOf("pm_getPaymasterStubData")[0].release!();
    await drain();
    expect(newer.status).toBe("pending");
    await advance(10_000 - 1);
    expect(newer.status).toBe("pending");
    await advance(1);
    expectDeadline(newer);
  });

  it("C11: an older call that SUCCEEDS clears only its own timer; the newer held call still times out on its own clock", async () => {
    hold("pm_getPaymasterData");
    hold("pm_getPaymasterData");
    const older = prepare();
    await flushUntil(() => heldOf("pm_getPaymasterData").length === 1, "older held");
    await advance(5_000);
    const newer = prepare();
    await flushUntil(() => heldOf("pm_getPaymasterData").length === 2, "newer held");
    heldOf("pm_getPaymasterData")[0].release!();
    await flushUntil(() => older.status !== "pending", "older settled");
    expect(older.status).toBe("fulfilled");
    expect(vi.getTimerCount()).toBe(1);
    await advance(DEADLINE_MS - 1);
    expect(newer.status).toBe("pending");
    await advance(1);
    expectDeadline(newer);
  });

  it("C13: completion-first — a final answer released at 24 999 ms resolves, and the deadline never fires afterwards", async () => {
    hold("pm_getPaymasterData");
    const result = prepare();
    await flushUntil(() => heldOf("pm_getPaymasterData").length === 1, "final held");
    await advance(DEADLINE_MS - 1);
    heldOf("pm_getPaymasterData")[0].release!();
    await flushUntil(() => result.status !== "pending", "settled");
    expect(result.status).toBe("fulfilled");
    expect(result.value!.callData).toBe(expectedCallData);
    expect(vi.getTimerCount()).toBe(0);
    await advance(DEADLINE_MS);
    expect(result.status).toBe("fulfilled");
  });

  it("C14: timer-first — an answer scheduled for the same 25 000 ms tick (armed after the deadline timer) loses to the deadline", async () => {
    hold("pm_getPaymasterData");
    const result = prepare();
    await flushUntil(() => heldOf("pm_getPaymasterData").length === 1, "final held");
    // No fake time has passed since the call armed its deadline; this timer is armed later, for the same tick.
    setTimeout(() => heldOf("pm_getPaymasterData")[0].release!(), DEADLINE_MS);
    await advance(DEADLINE_MS);
    await drain();
    expectDeadline(result);
    expect(probe.state.preparedReads).toEqual([]);
  });

  it("C15: no retry is added — after a timeout nothing is re-prepared or re-requested, however long the clock runs", async () => {
    hold("pm_getPaymasterStubData");
    const result = prepare();
    await flushUntil(() => heldOf("pm_getPaymasterStubData").length === 1, "stub held");
    await expire();
    expectDeadline(result);
    await advance(10 * 60_000);
    await drain();
    expect(methods()).toEqual(["pimlico_getUserOperationGasPrice", "pm_getPaymasterStubData"]);
    expect(countsOf(chainLog.map((entry) => entry.read))).toEqual({ proxyCreationCode: 1, getNonce: 1, getCode: 1 });
    expect(probe.state.configs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The real, unchanged caller: resolvePreparePayment (W2 / W3)
// ---------------------------------------------------------------------------

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

async function world() {
  const registry = createInMemoryRealAccountRegistry();
  await registry.createAccountWithPasskey({
    account: { appUserId: "app-user-1", subOrganizationId: "sub-org-1", turnkeyUserId: "turnkey-user-1", walletId: "wallet-1", walletAccountId: "wallet-account-1", ownerAddress: PAYER_OWNER, safeAddress: payerSafe, accountConfigVersion: 1 },
    passkey: { credentialId: "credential-1", appUserId: "app-user-1", credentialPublicKey: "cose", userHandle: "user-handle-1", counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false },
  });
  const store = createInMemoryPaymentAttemptStore(registry);
  const transitions: { from: string; to: string; result: "ok" | "null" | "threw" }[] = [];
  const original = store.transition.bind(store);
  let failW2: Error | null = null;
  const transition = vi.spyOn(store, "transition").mockImplementation(async (args) => {
    if (failW2 && args.from === "prepared" && args.to === "failed") {
      transitions.push({ from: args.from, to: args.to, result: "threw" });
      throw failW2;
    }
    const result = await original(args);
    transitions.push({ from: args.from, to: args.to, result: result ? "ok" : "null" });
    return result;
  });
  const findById = vi.spyOn(store, "findById");
  const limiter = recordingRateLimiter();
  const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);
  const run = () =>
    observe(
      resolvePreparePayment({
        cookieValue,
        sessionSecret: SECRET,
        registry,
        paymentStore: store,
        rateLimiter: limiter.limiter,
        publicClient: publicClient(),
        pimlicoApiKey: API_KEY,
        recipient: { kind: "address", value: RECIPIENT },
        amountBaseUnitsInput: AMOUNT,
      }),
    );
  const latest = async () => (await store.findLatestByAppUserId("app-user-1"))!;
  const cancel = async () => resolveCancelPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore: store, attemptId: (await latest()).id });
  return { store: store as PaymentAttemptStore, transitions, transition, findById, limiter, run, latest, cancel, setFailW2: (error: Error) => (failW2 = error) };
}

function expectFailedUnprepared(attempt: PaymentAttempt) {
  expect(attempt.state).toBe("failed");
  expect(attempt.failureReason).toBe(SAFE_PREPARE_FAILED);
  for (const column of PREPARED_COLUMNS) expect(attempt[column], column).toBeNull();
}

function expectNoSigningOrDispatch() {
  // The only provider methods ever requested are preparation reads; nothing was sent.
  for (const method of methods()) expect(["pimlico_getUserOperationGasPrice", "pm_getPaymasterStubData", "eth_estimateUserOperationGas", "pm_getPaymasterData"]).toContain(method);
}

describe("resolvePreparePayment with the real preparation deadline (caller unchanged)", () => {
  it("I1/I2/I3/I6/I10/I11/I12/I13: a preparation timeout enters the existing W2 — exactly one prepared → failed CAS, prepare_failed, no W3, one admission charge, nothing retried, signed or sent", async () => {
    const w = await world();
    hold("pm_getPaymasterStubData");
    const outcome = w.run();
    await flushUntil(() => heldOf("pm_getPaymasterStubData").length === 1, "stub held");
    expect((await w.latest()).state).toBe("prepared");
    await advance(DEADLINE_MS - 1);
    expect(outcome.status).toBe("pending");
    expect(w.transitions).toEqual([]);
    await advance(1);
    await flushUntil(() => outcome.status !== "pending", "outcome");
    probe.state.epoch = "late";
    expect(outcome.value).toEqual({ outcome: "prepare_failed", reason: SAFE_PREPARE_FAILED });
    expect(w.transitions).toEqual([{ from: "prepared", to: "failed", result: "ok" }]);
    expectFailedUnprepared(await w.latest());
    expect(w.limiter.charges).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    // Long after: still nothing more.
    await advance(10 * 60_000);
    await drain();
    expect(w.transitions).toHaveLength(1);
    expect(w.limiter.charges).toHaveLength(1);
    expect(methods()).toEqual(["pimlico_getUserOperationGasPrice", "pm_getPaymasterStubData"]);
    expectNoSigningOrDispatch();
  });

  it("I7: a LATE successful preparation (released after the timeout) cannot reach W3 — the row stays failed with no prepared fields", async () => {
    const w = await world();
    hold("pm_getPaymasterData");
    const outcome = w.run();
    await flushUntil(() => heldOf("pm_getPaymasterData").length === 1, "final held");
    await advance(DEADLINE_MS);
    await flushUntil(() => outcome.status !== "pending", "outcome");
    probe.state.epoch = "late";
    expect(outcome.value).toEqual({ outcome: "prepare_failed", reason: SAFE_PREPARE_FAILED });
    heldOf("pm_getPaymasterData")[0].release!();
    await drain();
    await advance(60_000);
    await drain();
    expect(w.transitions).toEqual([{ from: "prepared", to: "failed", result: "ok" }]);
    expect(w.transition.mock.calls.some(([args]) => args.to === "awaiting_authorization")).toBe(false);
    expect(probe.state.preparedReads).toEqual([]);
    expectFailedUnprepared(await w.latest());
    expectNoProjectWorkAfterDeadline();
  });

  it("I8: a LATE rejection after the timeout causes no further database write", async () => {
    const w = await world();
    hold("pm_getPaymasterStubData");
    const outcome = w.run();
    await flushUntil(() => heldOf("pm_getPaymasterStubData").length === 1, "stub held");
    await advance(DEADLINE_MS);
    await flushUntil(() => outcome.status !== "pending", "outcome");
    heldOf("pm_getPaymasterStubData")[0].release!({ error: { code: -32602, message: "provider body: late" } });
    await drain();
    expect(w.transitions).toEqual([{ from: "prepared", to: "failed", result: "ok" }]);
    expectFailedUnprepared(await w.latest());
  });

  it("I4/I9: a concurrent Cancel that wins before W2 — the W2 CAS returns null, the existing safe failure answers, and the row stays cancelled", async () => {
    const w = await world();
    hold("pm_getPaymasterStubData");
    const outcome = w.run();
    await flushUntil(() => heldOf("pm_getPaymasterStubData").length === 1, "stub held");
    const cancelled = await w.cancel();
    expect(cancelled.outcome).toBe("cancelled");
    await advance(DEADLINE_MS);
    await flushUntil(() => outcome.status !== "pending", "outcome");
    expect(outcome.value).toEqual({ outcome: "prepare_failed", reason: SAFE_PREPARE_FAILED });
    expect(w.transitions).toEqual([
      { from: "prepared", to: "cancelled", result: "ok" },
      { from: "prepared", to: "failed", result: "null" },
    ]);
    expect((await w.latest()).state).toBe("cancelled");
    heldOf("pm_getPaymasterStubData")[0].release!();
    await drain();
    expect(w.transitions).toHaveLength(2);
  });

  it("I5: if the W2 write THROWS, the answer is prepare_outcome_uncertain — no read-back, no second write, no retry", async () => {
    const w = await world();
    w.setFailW2(new Error("relation does not exist — leaked db text"));
    hold("pm_getPaymasterStubData");
    const outcome = w.run();
    await flushUntil(() => heldOf("pm_getPaymasterStubData").length === 1, "stub held");
    const readsBefore = w.findById.mock.calls.length;
    await advance(DEADLINE_MS);
    await flushUntil(() => outcome.status !== "pending", "outcome");
    expect(outcome.value).toEqual({ outcome: "prepare_outcome_uncertain" });
    expect(w.transitions).toEqual([{ from: "prepared", to: "failed", result: "threw" }]);
    expect(w.findById.mock.calls.length).toBe(readsBefore);
    heldOf("pm_getPaymasterStubData")[0].release!();
    await drain();
    await advance(60_000);
    expect(w.transitions).toHaveLength(1);
    expect(methods()).toEqual(["pimlico_getUserOperationGasPrice", "pm_getPaymasterStubData"]);
  });

  it("I14: an honest preparation before the deadline follows the unchanged W3 path — ready, one prepared → awaiting_authorization write, no timer left", async () => {
    const w = await world();
    const outcome = w.run();
    await flushUntil(() => outcome.status !== "pending", "outcome");
    expect(outcome.value).toMatchObject({ outcome: "ready" });
    expect(w.transitions).toEqual([{ from: "prepared", to: "awaiting_authorization", result: "ok" }]);
    const attempt = await w.latest();
    expect(attempt.state).toBe("awaiting_authorization");
    expect(attempt.callData).toBe(expectedCallData);
    expect(attempt.paymaster).toBe(PAYMASTER);
    expect(w.limiter.charges).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expectNoSigningOrDispatch();
  });
});

// ---------------------------------------------------------------------------
// Static shape of the approved preparation section
// ---------------------------------------------------------------------------

describe("source shape of the preparation exception", () => {
  it("P1: the preparation section (between the frozen regions) adds one timer and no transport, abort, retry, send, receipt or sponsorship-policy code", () => {
    const bytes = readFileSync(path.resolve(process.cwd(), "lib/real/server/pimlico.ts"));
    // The frozen regions recorded by pimlico-receipt-deadline.test.ts F1: bytes 0–6 667 and the last 3 672.
    const section = bytes.subarray(6_667, bytes.length - 3_672).toString("utf8");
    expect(section.startsWith("/**\n * M3D Pimlico preparation caller deadline")).toBe(true);
    expect(section).toContain("const CASH_TRANSFER_PREPARATION_DEADLINE_MS = 25_000;");
    expect(section.match(/setTimeout\(/g)).toHaveLength(1);
    expect(section.match(/clearTimeout\(/g)).toHaveLength(2);
    expect(section.match(/\bhttp\(/g)).toHaveLength(1);
    expect(section).toContain("return gasPrice.fast;");
    for (const token of [
      "AbortController",
      "signal",
      "retryCount",
      "retryDelay",
      "sendUserOperation",
      "getUserOperationReceipt",
      "withUserOperationReceiptReadDeadline",
      "sponsorUserOperation",
      "paymasterContext:",
      "validForSeconds",
      "sponsorshipPolicyId",
      "fetch(",
    ]) {
      expect(section, token).not.toContain(token);
    }
  });
});

// ---------------------------------------------------------------------------
// I-1: a stub `paymaster` of boolean true must not reach viem's raw paymaster path
// ---------------------------------------------------------------------------

/**
 * viem spreads the stub answer over the request; in the nested preparation
 * inside gas estimation, `paymaster: true` selects viem's own raw
 * pm_getPaymasterStubData / pm_getPaymasterData calls through the bundler
 * transport, outside the guarded wrapper (reproduced offline against the
 * unguarded code: a raw nested stub, then a raw final after the deadline).
 */
const paymasterTrue = (value: Record<string, unknown>) => ({ ...value, paymaster: true });

describe("I-1 — a stub answering paymaster: true is refused before viem can select its raw paymaster calls", () => {
  it("I1-A: before the deadline — fails closed with the fixed integrity error; no raw nested stub, final or estimation, then or ever", async () => {
    script("pm_getPaymasterStubData", { shape: paymasterTrue });
    hold("pm_getPaymasterStubData"); // where the raw nested stub would wait, if it started
    const result = prepare();
    await flushUntil(() => result.status !== "pending", "settled");
    expect(result.status).toBe("rejected");
    expect(result.error).toBeInstanceOf(PreparedUserOperationIntegrityError);
    expect(`${(result.error as Error).message} ${String((result.error as Error).stack)}`).not.toMatch(/https?:|apikey|pimlico\.io|SECRETKEY/);
    expect(vi.getTimerCount()).toBe(0);
    // The anomaly reached the guarded wrapper (the client answered it) and was refused there.
    expect((clientCallsOf("getPaymasterStubData")[0].value as { paymaster?: unknown }).paymaster).toBe(true);
    expect(callbacksOf("getPaymasterStubData")[0].error).toBeInstanceOf(PreparedUserOperationIntegrityError);
    expect(methods()).toEqual(["pimlico_getUserOperationGasPrice", "pm_getPaymasterStubData"]);
    await expire();
    await advance(10 * 60_000);
    await drain();
    expect(methods()).toEqual(["pimlico_getUserOperationGasPrice", "pm_getPaymasterStubData"]);
    expect(probe.state.preparedReads).toEqual([]);
  });

  it("I1-B: after the deadline — a late paymaster: true stub meets the deadline guard first; nothing further starts", async () => {
    hold("pm_getPaymasterStubData", paymasterTrue);
    const result = prepare();
    await flushUntil(() => heldOf("pm_getPaymasterStubData").length === 1, "stub held");
    await expire();
    expectDeadline(result);
    heldOf("pm_getPaymasterStubData")[0].release!();
    await drain();
    expectDeadline(result);
    expect(callbacksOf("getPaymasterStubData")[0].error).toBeInstanceOf(CashTransferPreparationDeadlineError);
    expect(methods()).toEqual(["pimlico_getUserOperationGasPrice", "pm_getPaymasterStubData"]);
    expectNoProjectWorkAfterDeadline();
  });

  it("I1-A2: the same refusal applies to a nested stub (outer stub without a paymaster) — no final and no estimation follow", async () => {
    script("pm_getPaymasterStubData", { shape: withoutPaymaster });
    script("pm_getPaymasterStubData", { shape: paymasterTrue });
    const result = prepare();
    await flushUntil(() => result.status !== "pending", "settled");
    expect(result.error).toBeInstanceOf(PreparedUserOperationIntegrityError);
    expect(callbacksOf("getPaymasterStubData")).toHaveLength(2);
    expect(methods()).toEqual(["pimlico_getUserOperationGasPrice", "pm_getPaymasterStubData", "pm_getPaymasterStubData"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("I1-C/D: through the real resolvePreparePayment — the existing W2 failure (one prepared → failed CAS, prepare_failed), no W3, no extra write, one admission charge", async () => {
    const w = await world();
    script("pm_getPaymasterStubData", { shape: paymasterTrue });
    const outcome = w.run();
    await flushUntil(() => outcome.status !== "pending", "outcome");
    expect(outcome.value).toEqual({ outcome: "prepare_failed", reason: SAFE_PREPARE_FAILED });
    expect(w.transitions).toEqual([{ from: "prepared", to: "failed", result: "ok" }]);
    expectFailedUnprepared(await w.latest());
    expect(w.limiter.charges).toHaveLength(1);
    await advance(10 * 60_000);
    await drain();
    expect(w.transitions).toHaveLength(1);
    expect(methods()).toEqual(["pimlico_getUserOperationGasPrice", "pm_getPaymasterStubData"]);
    expectNoSigningOrDispatch();
  });
});
