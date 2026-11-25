// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hash, Hex } from "viem";
import { entryPoint07Address, UserOperationReceiptNotFoundError } from "viem/account-abstraction";
import { USER_OPERATION_CHAIN_STATE_READ_DEADLINE_MS, type EntryPointReader } from "@/lib/real/chain/entry-point";
import { REAL_CASH_TOKEN, REAL_SAFE } from "@/lib/real/constants";
import type { PreparedUserOperationFields } from "@/lib/real/payments/prepared-operation";
import { CHAIN_READ_POLICIES } from "@/lib/real/server/chain-read-budget";
import { createInMemoryPaymentAttemptStore, type PaymentAttemptState } from "@/lib/real/server/payment-attempts";
import { resolvePaymentStatus } from "@/lib/real/server/payments";
import { fetchUserOperationReceipt, sendPreparedUserOperation, UserOperationReceiptReadDeadlineError } from "@/lib/real/server/pimlico";
import type { ProviderBudgetLimiter } from "@/lib/real/server/rate-limit";
import { createInMemoryRealAccountRegistry } from "@/lib/real/server/registry";
import { createSessionPayload, serializeSession } from "@/lib/real/server/session";
import { createFakeEntryPoint } from "./fixtures/entry-point-fake";

/**
 * M3D — Pimlico receipt-read caller deadline (fetchUserOperationReceipt,
 * 15 000 ms). The REAL lib/real/server/pimlico.ts runs against a mocked SDK
 * client factory (permissionless's createPimlicoClient / createSmartAccountClient
 * are replaced by in-process fakes); the caller tests run the REAL, unchanged
 * resolvePaymentStatus and the REAL EntryPoint proof (chain/entry-point.ts)
 * over the shared in-process EntryPoint fake. Answers are held on
 * deterministic promises; setTimeout/clearTimeout are faked (setImmediate
 * stays real to drain the event loop); global fetch is replaced by a guard
 * that fails any call. No RPC, provider, database, signing or HTTP.
 */

const sdk = vi.hoisted(() => ({
  createPimlicoClient: vi.fn(),
  createSmartAccountClient: vi.fn(),
  getUserOperationReceipt: vi.fn(),
  sendUserOperation: vi.fn(),
  /** Every property read on any fake Pimlico client, in order. */
  clientAccess: [] as string[],
}));
vi.mock("permissionless/clients/pimlico", () => ({ createPimlicoClient: (...args: unknown[]) => sdk.createPimlicoClient(...args) }));
vi.mock("permissionless", () => ({ createSmartAccountClient: (...args: unknown[]) => sdk.createSmartAccountClient(...args) }));

const API_KEY = "pim_SECRETKEY_test";
const SECRET = "test-session-secret";
const SENDER = "0x2222222222222222222222222222222222222222" as const;
const OWNER_ADDRESS = "0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF";
const HASH = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const RECEIPT_TX = "0x7777777777777777777777777777777777777777777777777777777777777777" as const;
const PROOF_TX = "0x5555555555555555555555555555555555555555555555555555555555555555" as const;
const KEY = BigInt("0x1a0d5d70cd9");
const NONCE = KEY << BigInt(64);
const PREPARE_BLOCK = BigInt(47_000_000);
const VALID_UNTIL = 1_900_000_600;
const DEADLINE_MS = 15_000;
const SAFE_REVERTED = "The bundler reported the operation reverted on-chain.";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T = unknown>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Observed<T> = { status: "pending" | "fulfilled" | "rejected"; value?: T; error?: unknown };
/** Attaches both handlers at once, so the observed promise itself can never be an unhandled rejection. */
function observe<T>(promise: Promise<T>): Observed<T> {
  const observed: Observed<T> = { status: "pending" };
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

/** One real macrotask turn: every queued microtask (and Node's unhandled-rejection check) runs first. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
async function flushUntil(condition: () => boolean, label: string) {
  for (let i = 0; i < 200; i += 1) {
    if (condition()) return;
    await flush();
  }
  throw new Error(`never reached: ${label}`);
}
const advance = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
};

function expectDeadline(observed: Observed<unknown>) {
  expect(observed.status).toBe("rejected");
  expect(observed.value).toBeUndefined();
  expect(observed.error).toBeInstanceOf(UserOperationReceiptReadDeadlineError);
  expect((observed.error as Error).name).toBe("UserOperationReceiptReadDeadlineError");
  expect((observed.error as Error).message).toBe("The receipt read did not finish in time.");
  const text = `${(observed.error as Error).message} ${String((observed.error as Error).stack)}`;
  expect(text).not.toMatch(/https?:|apikey|pimlico\.io|SECRETKEY|provider body/);
}

/** The shape viem's getUserOperationReceipt resolves with (formatted; bigints and extra fields included). */
function sdkReceipt(overrides: { success?: boolean; status?: "success" | "reverted"; transactionHash?: Hash; userOpHash?: Hash } = {}) {
  return {
    actualGasCost: BigInt(123_456),
    actualGasUsed: BigInt(98_765),
    entryPoint: entryPoint07Address,
    logs: [],
    nonce: NONCE,
    paymaster: "0x3333333333333333333333333333333333333333",
    reason: undefined,
    receipt: {
      blockHash: "0x8888888888888888888888888888888888888888888888888888888888888888",
      blockNumber: BigInt(47_000_010),
      contractAddress: null,
      cumulativeGasUsed: BigInt(500_000),
      effectiveGasPrice: BigInt(1_000_000),
      from: "0x9999999999999999999999999999999999999999",
      gasUsed: BigInt(200_000),
      logs: [],
      logsBloom: "0x00",
      status: overrides.status ?? "success",
      to: entryPoint07Address,
      transactionHash: overrides.transactionHash ?? RECEIPT_TX,
      transactionIndex: 0,
      type: "eip1559",
    },
    sender: SENDER,
    success: overrides.success ?? true,
    userOpHash: overrides.userOpHash ?? HASH,
  };
}

/**
 * A receipt whose every property read is counted — proves whether late data
 * was mapped at all. The root `then` probe is the Promise machinery's own
 * thenable check when the fake resolves with this object, not mapping code.
 */
function countingReceipt() {
  const reads: string[] = [];
  const watch = <T extends object>(target: T, prefix: string): T =>
    new Proxy(target, {
      get(obj, key, receiver) {
        if (!(prefix === "" && key === "then")) reads.push(`${prefix}${String(key)}`);
        const value = Reflect.get(obj, key, receiver);
        return typeof value === "object" && value !== null ? watch(value, `${prefix}${String(key)}.`) : value;
      },
    });
  return { receipt: watch(sdkReceipt(), ""), reads };
}

const fetchGuard = vi.fn(() => {
  throw new Error("network disabled in this test file");
});

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("fetch", fetchGuard);
  fetchGuard.mockClear();
  sdk.clientAccess.length = 0;
  sdk.getUserOperationReceipt.mockReset();
  sdk.sendUserOperation.mockReset();
  sdk.createSmartAccountClient.mockReset();
  sdk.createPimlicoClient.mockReset().mockImplementation(() => {
    const client = {
      getUserOperationReceipt: (...args: unknown[]) => sdk.getUserOperationReceipt(...args),
      sendUserOperation: (...args: unknown[]) => sdk.sendUserOperation(...args),
    };
    return new Proxy(client, {
      get(target, key, receiver) {
        sdk.clientAccess.push(String(key));
        return Reflect.get(target, key, receiver);
      },
    });
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await flush();
  await flush();
  process.off("unhandledRejection", onUnhandled);
  vi.unstubAllGlobals();
  // No controlled late failure in any test escapes as an unhandled rejection, and nothing touched the network.
  expect(unhandled).toEqual([]);
  expect(fetchGuard).not.toHaveBeenCalled();
  // No SDK preparation path is ever reached from this file.
  expect(sdk.createSmartAccountClient).not.toHaveBeenCalled();
});

const read = () => fetchUserOperationReceipt({ pimlicoApiKey: API_KEY, userOperationHash: HASH });
const holdReceipt = () => {
  const gate = deferred<unknown>();
  sdk.getUserOperationReceipt.mockImplementationOnce(() => gate.promise);
  return gate;
};

// ---------------------------------------------------------------------------
// Direct receipt tests
// ---------------------------------------------------------------------------

describe("fetchUserOperationReceipt — 15 s caller deadline (direct)", () => {
  it("R1/R10/R16/R19: an honest receipt is mapped exactly as before from ONE SDK call with the exact hash, and no timer is left", async () => {
    sdk.getUserOperationReceipt.mockResolvedValueOnce(sdkReceipt());
    const result = observe(read());
    await flush();
    expect(result.status).toBe("fulfilled");
    expect(result.value).toStrictEqual({ userOpHash: HASH, sender: SENDER, success: true, receipt: { transactionHash: RECEIPT_TX, status: "success" } });
    expect(sdk.getUserOperationReceipt).toHaveBeenCalledTimes(1);
    expect(sdk.getUserOperationReceipt.mock.calls[0]).toStrictEqual([{ hash: HASH }]);
    expect(vi.getTimerCount()).toBe(0);
    await advance(DEADLINE_MS * 2);
    expect(result.status).toBe("fulfilled");
  });

  it("R19: the client is built exactly as before — one Pimlico client, EntryPoint 0.7, the same Pimlico URL — and only the receipt method is touched", async () => {
    sdk.getUserOperationReceipt.mockResolvedValueOnce(sdkReceipt());
    await read();
    expect(sdk.createPimlicoClient).toHaveBeenCalledTimes(1);
    const [config] = sdk.createPimlicoClient.mock.calls[0] as [{ transport: (opts: object) => { value?: { url?: string } }; entryPoint: unknown }];
    expect(config.entryPoint).toStrictEqual({ address: entryPoint07Address, version: REAL_SAFE.entryPoint.version });
    // Building the transport descriptor makes no request (the fetch guard would fail the test).
    expect(config.transport({}).value?.url).toBe(`https://api.pimlico.io/v2/84532/rpc?apikey=${API_KEY}`);
    expect(sdk.clientAccess).toEqual(["getUserOperationReceipt"]);
  });

  it("R20: the reverted mapping branch is preserved (success false / status reverted) without inventing fields", async () => {
    sdk.getUserOperationReceipt.mockResolvedValueOnce(sdkReceipt({ success: false, status: "reverted" }));
    await expect(read()).resolves.toStrictEqual({ userOpHash: HASH, sender: SENDER, success: false, receipt: { transactionHash: RECEIPT_TX, status: "reverted" } });
  });

  it("R20 (artificial): HEAD's defensive null branch is preserved — reachable only through a fake, since viem 2.56.8 throws UserOperationReceiptNotFoundError instead of returning null", async () => {
    sdk.getUserOperationReceipt.mockResolvedValueOnce(null);
    const result = observe(read());
    await flush();
    expect(result).toEqual({ status: "fulfilled", value: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("R2/R3/R4: a receipt read that never answers is pending at 14 999 ms and rejects at 15 000 ms; nothing re-reads afterwards", async () => {
    holdReceipt();
    const result = observe(read());
    expect(vi.getTimerCount()).toBe(1);
    await advance(14_999);
    expect(result.status).toBe("pending");
    await advance(1);
    expectDeadline(result);
    expect(vi.getTimerCount()).toBe(0);
    await advance(10 * 60_000);
    expect(sdk.getUserOperationReceipt).toHaveBeenCalledTimes(1);
    expect(sdk.createPimlicoClient).toHaveBeenCalledTimes(1);
  });

  it("R2: the one deadline timer is already armed when the SDK client is built and when the receipt read starts", async () => {
    const seen: number[] = [];
    const build = sdk.createPimlicoClient.getMockImplementation()!;
    sdk.createPimlicoClient.mockImplementationOnce((...args: unknown[]) => {
      seen.push(vi.getTimerCount());
      return build(...args);
    });
    sdk.getUserOperationReceipt.mockImplementationOnce(() => {
      seen.push(vi.getTimerCount());
      return deferred<unknown>().promise;
    });
    const result = observe(read());
    await flush();
    expect(seen).toEqual([1, 1]);
    await advance(DEADLINE_MS);
    expectDeadline(result);
  });

  it("R5/R6/R7: a timeout rejects with the fixed error — never null, a receipt-shaped value, a hash or a success flag — and echoes no provider text", async () => {
    // A provider error carrying a URL, key and body is pending when the deadline fires.
    const gate = holdReceipt();
    const result = observe(read());
    await advance(DEADLINE_MS);
    expectDeadline(result);
    expect(result.error).not.toHaveProperty("success");
    expect(result.error).not.toHaveProperty("receipt");
    expect(result.error).not.toHaveProperty("transactionHash");
    gate.reject(new Error(`request to https://api.pimlico.io/v2/84532/rpc?apikey=${API_KEY} failed: <html>provider body</html>`));
    await flush();
    expectDeadline(result);
  });

  it("R8/R11: an ordinary error before the deadline passes through unchanged (same object), is not retried, and clears the timer", async () => {
    const failure = new Error("bundler down");
    sdk.getUserOperationReceipt.mockRejectedValueOnce(failure);
    const result = observe(read());
    await flush();
    expect(result.status).toBe("rejected");
    expect(result.error).toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
    await advance(DEADLINE_MS * 2);
    expect(result.error).toBe(failure);
    expect(sdk.getUserOperationReceipt).toHaveBeenCalledTimes(1);
  });

  it("R8: an ordinary error arriving at 14 999 ms still wins over the deadline", async () => {
    const gate = holdReceipt();
    const failure = new Error("late but in time");
    const result = observe(read());
    await advance(14_999);
    gate.reject(failure);
    await flush();
    expect(result.error).toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
    await advance(1);
    expect(result.error).toBe(failure);
  });

  it("R9: viem's real UserOperationReceiptNotFoundError before the deadline passes through unchanged — not converted to null or to the deadline error", async () => {
    const notFound = new UserOperationReceiptNotFoundError({ hash: HASH });
    sdk.getUserOperationReceipt.mockRejectedValueOnce(notFound);
    const result = observe(read());
    await flush();
    expect(result.status).toBe("rejected");
    expect(result.error).toBe(notFound);
    expect(result.error).not.toBeInstanceOf(UserOperationReceiptReadDeadlineError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("R12: a SYNCHRONOUS throw — from client construction or from the receipt method — rejects with that error and leaves no timer armed", async () => {
    const constructionFailure = new Error("client construction failed");
    sdk.createPimlicoClient.mockImplementationOnce(() => {
      throw constructionFailure;
    });
    const first = observe(read());
    await flush();
    expect(first).toEqual({ status: "rejected", error: constructionFailure });
    expect(vi.getTimerCount()).toBe(0);
    expect(sdk.getUserOperationReceipt).not.toHaveBeenCalled();

    const methodFailure = new Error("receipt method threw synchronously");
    sdk.getUserOperationReceipt.mockImplementationOnce(() => {
      throw methodFailure;
    });
    const second = observe(read());
    await flush();
    expect(second).toEqual({ status: "rejected", error: methodFailure });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("R10: an honest receipt arriving at 14 999 ms wins, and the cleared timer stays inert", async () => {
    const gate = holdReceipt();
    const result = observe(read());
    await advance(14_999);
    gate.resolve(sdkReceipt());
    await flush();
    expect(result.status).toBe("fulfilled");
    expect(vi.getTimerCount()).toBe(0);
    await advance(DEADLINE_MS);
    expect(result.status).toBe("fulfilled");
  });

  it("R13/S-late: a late successful receipt after the deadline cannot replace the rejection, and is not even mapped (no field is read)", async () => {
    const gate = holdReceipt();
    const result = observe(read());
    await advance(DEADLINE_MS);
    expectDeadline(result);
    const late = countingReceipt();
    gate.resolve(late.receipt);
    await flush();
    await flush();
    expectDeadline(result);
    expect(late.reads).toEqual([]);
    expect(sdk.getUserOperationReceipt).toHaveBeenCalledTimes(1);
  });

  it("R13: a late MALFORMED receipt (would throw if mapped) is not adopted and raises nothing", async () => {
    const gate = holdReceipt();
    const result = observe(read());
    await advance(DEADLINE_MS);
    gate.resolve({ userOpHash: HASH, sender: SENDER, success: true });
    await flush();
    expectDeadline(result);
  });

  it("R14/R15/R17: a late rejection is consumed — no unhandled rejection (checked after every test), no second read, no change to the answer", async () => {
    const gate = holdReceipt();
    const result = observe(read());
    await advance(DEADLINE_MS);
    gate.reject(new UserOperationReceiptNotFoundError({ hash: HASH }));
    await flush();
    await flush();
    expectDeadline(result);
    await advance(10 * 60_000);
    expect(sdk.getUserOperationReceipt).toHaveBeenCalledTimes(1);
    expect(sdk.createPimlicoClient).toHaveBeenCalledTimes(1);
  });

  it("R18: a receipt read — honest, failed or timed out — never sends, prepares or touches a paymaster / gas method", async () => {
    sdk.getUserOperationReceipt.mockResolvedValueOnce(sdkReceipt());
    await read();
    sdk.getUserOperationReceipt.mockRejectedValueOnce(new Error("bundler down"));
    await read().catch(() => undefined);
    holdReceipt();
    const held = observe(read());
    await advance(DEADLINE_MS);
    expectDeadline(held);
    expect(sdk.sendUserOperation).not.toHaveBeenCalled();
    expect(sdk.createSmartAccountClient).not.toHaveBeenCalled();
    expect(new Set(sdk.clientAccess)).toEqual(new Set(["getUserOperationReceipt"]));
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe("fetchUserOperationReceipt — per-invocation deadline isolation", () => {
  it("C1/C3: overlapping held calls keep independent timers; the older one timing out does not clear the newer one's", async () => {
    holdReceipt();
    holdReceipt();
    const older = observe(read());
    await advance(5_000);
    const newer = observe(read());
    expect(vi.getTimerCount()).toBe(2);
    await advance(10_000);
    expectDeadline(older);
    expect(newer.status).toBe("pending");
    expect(vi.getTimerCount()).toBe(1);
    await advance(4_999);
    expect(newer.status).toBe("pending");
    await advance(1);
    expectDeadline(newer);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("C2: an older call that SUCCEEDS clears only its own timer; a newer held call still times out on its own clock", async () => {
    const olderGate = holdReceipt();
    holdReceipt();
    const older = observe(read());
    await advance(1_000);
    const newer = observe(read());
    await advance(2_000);
    olderGate.resolve(sdkReceipt());
    await flush();
    expect(older.status).toBe("fulfilled");
    expect(vi.getTimerCount()).toBe(1);
    await advance(12_999);
    expect(newer.status).toBe("pending");
    await advance(1);
    expectDeadline(newer);
  });

  it("C4: one call times out while a concurrent one succeeds with its own receipt", async () => {
    holdReceipt();
    const honestGate = holdReceipt();
    const held = observe(read());
    const honest = observe(read());
    await advance(10_000);
    honestGate.resolve(sdkReceipt({ transactionHash: PROOF_TX }));
    await flush();
    expect(honest.value).toStrictEqual({ userOpHash: HASH, sender: SENDER, success: true, receipt: { transactionHash: PROOF_TX, status: "success" } });
    await advance(5_000);
    expectDeadline(held);
    expect(honest.status).toBe("fulfilled");
  });

  it("C5/C8: an expired call's late settlement does not affect a fresh call — no shared expired flag, no module-level timer", async () => {
    const expiredGate = holdReceipt();
    const expired = observe(read());
    await advance(DEADLINE_MS);
    expectDeadline(expired);

    // A fresh call after the expiry resolves normally (a shared expired flag would reject it at its checkpoint).
    sdk.getUserOperationReceipt.mockResolvedValueOnce(sdkReceipt());
    const freshImmediate = observe(read());
    await flush();
    expect(freshImmediate.status).toBe("fulfilled");

    // A fresh held call is unaffected by the expired call's late answer, and keeps its own full deadline.
    const freshGate = holdReceipt();
    const fresh = observe(read());
    expect(vi.getTimerCount()).toBe(1);
    expiredGate.resolve(sdkReceipt({ transactionHash: PROOF_TX }));
    await flush();
    expect(fresh.status).toBe("pending");
    expect(vi.getTimerCount()).toBe(1);
    await advance(14_999);
    expect(fresh.status).toBe("pending");
    freshGate.resolve(sdkReceipt());
    await flush();
    expect(fresh.value).toStrictEqual({ userOpHash: HASH, sender: SENDER, success: true, receipt: { transactionHash: RECEIPT_TX, status: "success" } });
    expectDeadline(expired);
  });

  it("C6: completion-first ordering — an answer scheduled for 14 999 ms resolves, and the deadline never fires afterwards", async () => {
    sdk.getUserOperationReceipt.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(sdkReceipt()), 14_999)));
    const result = observe(read());
    expect(vi.getTimerCount()).toBe(2);
    await advance(14_999);
    expect(result.status).toBe("fulfilled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("C7: timer-first ordering — an answer scheduled for the same 15 000 ms tick (armed after the deadline timer) loses to the deadline", async () => {
    const late = countingReceipt();
    sdk.getUserOperationReceipt.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(late.receipt), DEADLINE_MS)));
    const result = observe(read());
    await advance(DEADLINE_MS);
    expectDeadline(result);
    expect(late.reads).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Dispatch isolation and source freeze
// ---------------------------------------------------------------------------

const FIELDS = {
  sender: SENDER,
  nonce: NONCE,
  factory: undefined,
  factoryData: undefined,
  callData: "0xabcdef" as Hex,
  callGasLimit: BigInt(100_000),
  verificationGasLimit: BigInt(200_000),
  preVerificationGas: BigInt(50_000),
  maxFeePerGas: BigInt(2_000_000),
  maxPriorityFeePerGas: BigInt(1_000_000),
  paymaster: "0x3333333333333333333333333333333333333333",
  paymasterData: "0x" as Hex,
  paymasterVerificationGasLimit: BigInt(60_000),
  paymasterPostOpGasLimit: BigInt(0),
} as unknown as PreparedUserOperationFields;
const SIGNATURE = "0x00aa" as Hex;

describe("dispatch isolation (fake SDK only — no UserOperation is signed or sent)", () => {
  it("D1: a held sendPreparedUserOperation outlives 15 s with no deadline error, no timer and no extra send; its result then passes through", async () => {
    const gate = deferred<Hash>();
    sdk.sendUserOperation.mockImplementationOnce(() => gate.promise);
    const sent = observe(sendPreparedUserOperation({ pimlicoApiKey: API_KEY, fields: FIELDS, signature: SIGNATURE }));
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    await advance(DEADLINE_MS);
    await advance(60_000);
    expect(sent.status).toBe("pending");
    expect(vi.getTimerCount()).toBe(0);
    expect(sdk.sendUserOperation).toHaveBeenCalledTimes(1);
    expect(sdk.sendUserOperation.mock.calls[0]).toStrictEqual([{ ...FIELDS, signature: SIGNATURE, entryPointAddress: entryPoint07Address }]);
    gate.resolve(HASH);
    await flush();
    expect(sent).toEqual({ status: "fulfilled", value: HASH });
    expect(sdk.getUserOperationReceipt).not.toHaveBeenCalled();
    expect(sdk.clientAccess).toEqual(["sendUserOperation"]);
  });

  it("D1: a send failure after 15 s passes through unchanged (same object, not the deadline error) and is not retried", async () => {
    const gate = deferred<Hash>();
    sdk.sendUserOperation.mockImplementationOnce(() => gate.promise);
    const sent = observe(sendPreparedUserOperation({ pimlicoApiKey: API_KEY, fields: FIELDS, signature: SIGNATURE }));
    await advance(DEADLINE_MS + 1);
    const failure = new Error("send failed");
    gate.reject(failure);
    await flush();
    expect(sent).toEqual({ status: "rejected", error: failure });
    await advance(60_000);
    expect(sdk.sendUserOperation).toHaveBeenCalledTimes(1);
  });

  it("F1: every region of pimlico.ts outside the approved preparation section — client construction, verification, dispatch and the whole receipt-deadline section — is byte-identical to the receipt checkpoint", () => {
    const source = readFileSync(path.resolve(process.cwd(), "lib/real/server/pimlico.ts"), "utf8");
    const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
    const bytes = Buffer.from(source, "utf8");
    const shaBytes = (slice: Buffer) => createHash("sha256").update(slice).digest("hex");
    // Constants taken from the receipt checkpoint 4cfef83 (pimlico.ts 797436ce…04e4, 14 095 bytes). The
    // preparation exception may change only the bytes between these two regions; the receipt
    // checkpoint's 11 109-byte prefix pin (4aaa49ca…9b5b) is superseded by it.
    // Region A: bytes 0–6 667 — imports, the Pimlico URL and client construction, both error classes and verifyPreparedUserOperation.
    expect(shaBytes(bytes.subarray(0, 6_667))).toBe("875c97540d4c1e5b9849429362312d2a3dbca8d7aa02b0b95b891f58ac45162b");
    // Region B: the last 3 672 bytes — sendPreparedUserOperation and the entire receipt-deadline section, to end of file.
    expect(shaBytes(bytes.subarray(bytes.length - 3_672))).toBe("3ef31c7d36f6e750eb074b28948cc931adf014c7b8996d440502ff802afe72cb");
    const fn = (start: string) => {
      const from = source.indexOf(start);
      return source.slice(from, source.indexOf("\n}\n", from) + 3);
    };
    const once = (needle: string) => {
      const from = source.indexOf(needle);
      expect(from).toBeGreaterThan(0);
      expect(source.indexOf(needle, from + 1)).toBe(-1);
      return from;
    };
    // The same regions, by name (each must also still be unique in the file).
    once("function pimlicoRpcUrl(");
    once("function createServerPimlicoClient(");
    const clientStart = once("/**\n * SERVER-ONLY");
    expect(sha(source.slice(clientStart, source.indexOf("\n}\n", source.indexOf("function createServerPimlicoClient(")) + 3))).toBe("9611322df5869bac4ac3635bc544eda502a376c7825d9466ff41a9e6bfc9972a");
    once("export function verifyPreparedUserOperation(");
    expect(sha(fn("export function verifyPreparedUserOperation("))).toBe("733c27634d925b072b8e2889fd42a554a2924eb11ea3686d33f29bd445320ec1");
    once("export async function sendPreparedUserOperation(");
    expect(sha(fn("export async function sendPreparedUserOperation("))).toBe("ade507f02dd960272e1bd17d7441231785b4bbd6848f4c40cc69b9bf1a42e540");
    const sectionStart = once("/**\n * M3D Pimlico receipt-read caller deadline");
    // The receipt section is the file's last 2 986 bytes, unchanged.
    expect(Buffer.byteLength(source.slice(sectionStart), "utf8")).toBe(2_986);
    expect(sha(source.slice(sectionStart))).toBe("b79ad44bf601a64c0fa3e1cfeee0b9f79c0d92d9193bd4298cf8404e38b5806d");
    // The new section adds no transport, abort, retry, send or preparation code.
    const section = source.slice(sectionStart);
    for (const token of ["sendUserOperation", "prepareUserOperation", "createSmartAccountClient", "http(", "retryCount", "retryDelay", "AbortController", "signal", "fetch("]) {
      expect(section).not.toContain(token);
    }
    expect(section.match(/setTimeout\(/g)).toHaveLength(1);
    expect(section.match(/getUserOperationReceipt\(/g)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The real, unchanged caller: resolvePaymentStatus
// ---------------------------------------------------------------------------

/** A per-account chain-read budget that always allows, records each charge and every property touched (a refund would show up here). */
function recordingBudget() {
  const calls: { subject: string; policies: unknown }[] = [];
  const touched: string[] = [];
  const target: ProviderBudgetLimiter = {
    async consume({ subject, policies }) {
      calls.push({ subject, policies });
      return { allowed: true };
    },
  };
  const limiter = new Proxy(target, {
    get(obj, key, receiver) {
      touched.push(String(key));
      return Reflect.get(obj, key, receiver);
    },
  });
  return { limiter, calls, touched };
}

type Gate = Deferred<void>;
type ProofStage = "getChainId" | "getBlock" | "readContract" | "getLogs";
/** The shared EntryPoint fake (honest answers) behind optional per-method gates; `stages` records every read that STARTED. */
function proofReader(state: Parameters<typeof createFakeEntryPoint>[0], gates: Partial<Record<ProofStage, Gate>> = {}) {
  const fake = createFakeEntryPoint(state);
  const base = fake.reader as unknown as Record<ProofStage, (args?: unknown) => Promise<unknown>>;
  const stages: ProofStage[] = [];
  const route = (stage: ProofStage) => async (args?: unknown) => {
    stages.push(stage);
    const gate = gates[stage];
    if (gate) await gate.promise;
    return base[stage](args);
  };
  const reader = { getChainId: route("getChainId"), getBlock: route("getBlock"), readContract: route("readContract"), getLogs: route("getLogs") };
  return { reader: reader as unknown as EntryPointReader, stages };
}

/** Proof fixtures: INCLUDED proves inclusion of HASH by SENDER (tx PROOF_TX); UNRESOLVED proves nothing (nonce unconsumed, window open). */
const INCLUDED = { latestSequence: BigInt(1), logs: [{ args: { userOpHash: HASH, sender: SENDER, success: true }, transactionHash: PROOF_TX }] };
const UNRESOLVED = { latestSequence: BigInt(0), finalizedSequence: BigInt(0) };

async function seedPayment(state: PaymentAttemptState) {
  const registry = createInMemoryRealAccountRegistry();
  await registry.createAccountWithPasskey({
    account: {
      appUserId: "app-user-1",
      subOrganizationId: "sub-org-1",
      turnkeyUserId: "turnkey-user-1",
      walletId: "wallet-1",
      walletAccountId: "wallet-account-1",
      ownerAddress: OWNER_ADDRESS,
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
  const store = createInMemoryPaymentAttemptStore();
  const reserved = await store.reserve({
    appUserId: "app-user-1",
    safeAddress: SENDER,
    recipient: "0x4444444444444444444444444444444444444444",
    amountBaseUnits: "1000000",
    chainId: 84532,
    tokenAddress: REAL_CASH_TOKEN.address,
    authorizingCredentialId: "credential-1",
  });
  if (!reserved.ok) throw new Error("expected reservation to succeed");
  const id = reserved.attempt.id;
  await store.transition({ id, from: "prepared", to: "awaiting_authorization", patch: { expectedUserOperationHash: HASH, nonce: NONCE.toString(), validUntil: VALID_UNTIL, prepareBlockNumber: PREPARE_BLOCK.toString() } });
  if (state !== "awaiting_authorization") await store.transition({ id, from: "awaiting_authorization", to: "signed" });
  if (state !== "awaiting_authorization" && state !== "signed") await store.transition({ id, from: "signed", to: "submitting" });
  if (state === "submitted" || state === "unknown") await store.transition({ id, from: "submitting", to: state });
  if (state === "confirmed") {
    await store.transition({ id, from: "submitting", to: "submitted" });
    await store.transition({ id, from: "submitted", to: "confirmed", patch: { transactionHash: RECEIPT_TX } });
  }
  const seeded = await store.findById(id);
  expect(seeded?.state).toBe(state);
  const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);
  const budget = recordingBudget();
  const transition = vi.spyOn(store, "transition");
  const status = (reader: EntryPointReader, now?: () => number) =>
    observe(resolvePaymentStatus({ cookieValue, sessionSecret: SECRET, registry, paymentStore: store, pimlicoApiKey: API_KEY, providerBudgetLimiter: budget.limiter, publicClient: reader, attemptId: id, now }));
  return { id, store, before: seeded!, budget, transition, status };
}

function expectOneCharge(budget: ReturnType<typeof recordingBudget>) {
  expect(budget.calls).toHaveLength(1);
  expect(budget.calls[0]).toEqual({ subject: "app-user-1", policies: CHAIN_READ_POLICIES });
  // Only consume() was ever reached on the limiter: no refund, release or second charge.
  expect(budget.touched).toEqual(["consume"]);
}

describe("resolvePaymentStatus with the real receipt deadline (caller unchanged)", () => {
  it.each(["submitting", "submitted", "unknown"] as const)(
    "I1/I2/I4/I8/I10/I13 (%s): a held receipt times out, the existing EntryPoint proof runs exactly once, proves nothing, and the stored payment is unchanged",
    async (state) => {
      const h = await seedPayment(state);
      holdReceipt();
      const { reader, stages } = proofReader(UNRESOLVED);
      const outcome = h.status(reader);
      await flushUntil(() => sdk.getUserOperationReceipt.mock.calls.length === 1, "receipt read started");
      await advance(14_999);
      expect(outcome.status).toBe("pending");
      expect(stages).toEqual([]);
      await advance(1);
      await flushUntil(() => outcome.status !== "pending", "status answered");
      expect(outcome.value).toMatchObject({ outcome: "ok", reconciliationDeferred: false, attempt: { id: h.id, state, transactionHash: null } });
      expect(stages.filter((stage) => stage === "getChainId")).toHaveLength(1);
      expect(h.transition).not.toHaveBeenCalled();
      expect(await h.store.findById(h.id)).toEqual(h.before);
      expectOneCharge(h.budget);
      expect(sdk.getUserOperationReceipt).toHaveBeenCalledTimes(1);
      expect(sdk.sendUserOperation).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("I3/I7/I9: after a receipt timeout a source-valid inclusion proof makes the existing confirmed transition; a late receipt then changes nothing", async () => {
    const h = await seedPayment("unknown");
    const receiptGate = holdReceipt();
    const { reader, stages } = proofReader(INCLUDED);
    const outcome = h.status(reader);
    await flushUntil(() => sdk.getUserOperationReceipt.mock.calls.length === 1, "receipt read started");
    await advance(DEADLINE_MS);
    await flushUntil(() => outcome.status !== "pending", "status answered");
    expect(outcome.value).toMatchObject({ outcome: "ok", attempt: { id: h.id, state: "confirmed", transactionHash: PROOF_TX } });
    expect(stages).toContain("getLogs");
    expect(h.transition).toHaveBeenCalledTimes(1);
    expect(h.transition).toHaveBeenCalledWith({ id: h.id, from: "unknown", to: "confirmed", patch: { transactionHash: PROOF_TX, failureReason: null } });
    const settled = await h.store.findById(h.id);

    // A late, conflicting receipt (reverted, other tx) cannot override the completed fallback.
    receiptGate.resolve(sdkReceipt({ success: false, status: "reverted", transactionHash: RECEIPT_TX }));
    await flush();
    await advance(60_000);
    expect(h.transition).toHaveBeenCalledTimes(1);
    expect(await h.store.findById(h.id)).toEqual(settled);
    expectOneCharge(h.budget);
    expect(sdk.getUserOperationReceipt).toHaveBeenCalledTimes(1);
  });

  it("I5: a receipt timeout followed by a timed-out EntryPoint proof leaves the stored payment unchanged; late answers of both change nothing", async () => {
    const h = await seedPayment("submitted");
    const receiptGate = holdReceipt();
    const proofGate: Gate = deferred<void>();
    const { reader, stages } = proofReader(INCLUDED, { getChainId: proofGate });
    const outcome = h.status(reader);
    await flushUntil(() => sdk.getUserOperationReceipt.mock.calls.length === 1, "receipt read started");
    await advance(DEADLINE_MS);
    await flushUntil(() => stages.includes("getChainId"), "proof started");
    expect(outcome.status).toBe("pending");
    await advance(USER_OPERATION_CHAIN_STATE_READ_DEADLINE_MS);
    await flushUntil(() => outcome.status !== "pending", "status answered");
    expect(outcome.value).toMatchObject({ outcome: "ok", attempt: { id: h.id, state: "submitted" } });
    // Both late answers would each prove "confirmed" if they were ever adopted.
    receiptGate.resolve(sdkReceipt());
    proofGate.resolve();
    await flush();
    await flush();
    expect(h.transition).not.toHaveBeenCalled();
    expect(await h.store.findById(h.id)).toEqual(h.before);
    expect(stages).toEqual(["getChainId"]);
    expectOneCharge(h.budget);
  });

  it("I5: a receipt timeout followed by an unavailable (failing) EntryPoint proof leaves the stored payment unchanged", async () => {
    const h = await seedPayment("unknown");
    holdReceipt();
    const outcome = h.status(createFakeEntryPoint({ fail: true }).reader);
    await flushUntil(() => sdk.getUserOperationReceipt.mock.calls.length === 1, "receipt read started");
    await advance(DEADLINE_MS);
    await flushUntil(() => outcome.status !== "pending", "status answered");
    expect(outcome.value).toMatchObject({ outcome: "ok", attempt: { id: h.id, state: "unknown" } });
    expect(h.transition).not.toHaveBeenCalled();
    expect(await h.store.findById(h.id)).toEqual(h.before);
    expectOneCharge(h.budget);
  });

  it("I6: after a timeout whose proof was unresolved, a late VALID confirming receipt makes no receipt-based transition", async () => {
    const h = await seedPayment("unknown");
    const receiptGate = holdReceipt();
    const outcome = h.status(proofReader(UNRESOLVED).reader);
    await flushUntil(() => sdk.getUserOperationReceipt.mock.calls.length === 1, "receipt read started");
    await advance(DEADLINE_MS);
    await flushUntil(() => outcome.status !== "pending", "status answered");
    receiptGate.resolve(sdkReceipt());
    await flush();
    await advance(60_000);
    expect(h.transition).not.toHaveBeenCalled();
    expect(await h.store.findById(h.id)).toEqual(h.before);
    expect(outcome.value).toMatchObject({ attempt: { state: "unknown" } });
  });

  it("I12: an honest receipt before the deadline follows the original receipt path — confirmed from the receipt, no EntryPoint read, no timer left", async () => {
    const h = await seedPayment("submitted");
    sdk.getUserOperationReceipt.mockResolvedValueOnce(sdkReceipt());
    const { reader, stages } = proofReader(INCLUDED);
    const outcome = h.status(reader);
    await flushUntil(() => outcome.status !== "pending", "status answered");
    expect(outcome.value).toMatchObject({ outcome: "ok", attempt: { id: h.id, state: "confirmed", transactionHash: RECEIPT_TX } });
    expect(h.transition).toHaveBeenCalledWith({ id: h.id, from: "submitted", to: "confirmed", patch: { transactionHash: RECEIPT_TX, failureReason: null } });
    expect(stages).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expectOneCharge(h.budget);
  });

  it("I12: an honest REVERTED receipt before the deadline follows the original failed path", async () => {
    const h = await seedPayment("unknown");
    sdk.getUserOperationReceipt.mockResolvedValueOnce(sdkReceipt({ success: false, status: "reverted" }));
    const { reader, stages } = proofReader(INCLUDED);
    const outcome = h.status(reader);
    await flushUntil(() => outcome.status !== "pending", "status answered");
    expect(outcome.value).toMatchObject({ attempt: { state: "failed", transactionHash: RECEIPT_TX, failureReason: SAFE_REVERTED } });
    expect(stages).toEqual([]);
  });

  it("I12: viem's UserOperationReceiptNotFoundError before the deadline keeps its existing meaning — no receipt, so the existing proof decides (here: inclusion)", async () => {
    const h = await seedPayment("submitting");
    sdk.getUserOperationReceipt.mockRejectedValueOnce(new UserOperationReceiptNotFoundError({ hash: HASH }));
    const { reader, stages } = proofReader(INCLUDED);
    const outcome = h.status(reader);
    await flushUntil(() => outcome.status !== "pending", "status answered");
    expect(outcome.value).toMatchObject({ attempt: { state: "confirmed", transactionHash: PROOF_TX } });
    expect(stages.filter((stage) => stage === "getChainId")).toHaveLength(1);
    expectOneCharge(h.budget);
  });

  it("I11: branches that need no receipt still make no receipt read and build no Pimlico client", async () => {
    // Pre-dispatch, window still open: no provider read, no charge.
    const open = await seedPayment("awaiting_authorization");
    const openReader = proofReader(UNRESOLVED);
    const openOutcome = open.status(openReader.reader, () => (VALID_UNTIL - 60) * 1000);
    await flushUntil(() => openOutcome.status !== "pending", "open pre-dispatch answered");
    expect(openReader.stages).toEqual([]);
    expect(open.budget.calls).toHaveLength(0);

    // Pre-dispatch past validUntil: only the existing EntryPoint proof, never a receipt.
    for (const state of ["awaiting_authorization", "signed"] as const) {
      const h = await seedPayment(state);
      const { reader, stages } = proofReader(UNRESOLVED);
      const outcome = h.status(reader, () => (VALID_UNTIL + 60) * 1000);
      await flushUntil(() => outcome.status !== "pending", `${state} answered`);
      expect(stages).toContain("getChainId");
      expectOneCharge(h.budget);
    }

    // A terminal row: nothing at all.
    const done = await seedPayment("confirmed");
    const doneReader = proofReader(INCLUDED);
    const doneOutcome = done.status(doneReader.reader);
    await flushUntil(() => doneOutcome.status !== "pending", "terminal answered");
    expect(doneOutcome.value).toMatchObject({ attempt: { state: "confirmed" } });
    expect(doneReader.stages).toEqual([]);
    expect(done.budget.calls).toHaveLength(0);

    expect(sdk.getUserOperationReceipt).not.toHaveBeenCalled();
    expect(sdk.createPimlicoClient).not.toHaveBeenCalled();
  });
});
