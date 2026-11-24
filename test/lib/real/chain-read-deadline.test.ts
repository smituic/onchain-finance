// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CASH_BALANCE_READ_DEADLINE_MS, CashBalanceReadDeadlineError, readCashBalance } from "@/lib/real/chain/balance";
import type { RealPublicClient } from "@/lib/real/chain/client";
import {
  ChainReadDeadlineError,
  LATEST_BLOCK_CLOCK_READ_DEADLINE_MS,
  readLatestBlockClock,
  readUserOperationChainState,
  USER_OPERATION_CHAIN_STATE_READ_DEADLINE_MS,
  type EntryPointReader,
} from "@/lib/real/chain/entry-point";
import { REAL_CASH_TOKEN } from "@/lib/real/constants";
import { resolveAuthenticatedCashBalance } from "@/lib/real/server/balance";
import { createInMemoryPaymentAttemptStore } from "@/lib/real/server/payment-attempts";
import { resolvePaymentStatus, resolvePreparePayment } from "@/lib/real/server/payments";
import { createInMemoryRealAccountRegistry } from "@/lib/real/server/registry";
import { createSessionPayload, serializeSession } from "@/lib/real/server/session";
import { scriptedBudget } from "./fixtures/chain-read-budget";
import { createFakeEntryPoint } from "./fixtures/entry-point-fake";
import { recordingRateLimiter } from "./fixtures/rate-limit";

/**
 * M3D — server chain-read caller deadlines (readCashBalance 15 s,
 * readLatestBlockClock 10 s, readUserOperationChainState 20 s, each over the
 * WHOLE operation). Everything is in-process: hand-built read fakes whose
 * answers are held on deterministic promises, fake setTimeout/clearTimeout
 * (setImmediate stays real so tests can drain the event loop), and a mocked
 * Pimlico module for the caller-mapping tests. No RPC, provider or database.
 */

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), receipt: vi.fn() }));
vi.mock("@/lib/real/server/pimlico", () => ({
  prepareCashTransferUserOperation: (...args: unknown[]) => mocks.prepare(...args),
  sendPreparedUserOperation: vi.fn(),
  fetchUserOperationReceipt: (...args: unknown[]) => mocks.receipt(...args),
}));

const BASE_SEPOLIA = 84532;
const SAFE_ADDRESS = "0xd9a4c22fb34dc74317edc8006140d66c8fa03266";
const OWNER_ADDRESS = "0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF";
const SECRET = "test-session-secret";
/** What a provider error could carry; a deadline error must never echo it. */
const SECRET_BEARING = "request to https://base-sepolia.example/v2/sk_live_SECRETKEY failed: <html>provider body</html>";

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

function expectDeadline(observed: Observed<unknown>, kind: "balance" | "chain") {
  expect(observed.status).toBe("rejected");
  expect(observed.value).toBeUndefined();
  if (kind === "balance") {
    expect(observed.error).toBeInstanceOf(CashBalanceReadDeadlineError);
    expect((observed.error as Error).message).toBe("The balance read did not finish in time.");
  } else {
    expect(observed.error).toBeInstanceOf(ChainReadDeadlineError);
    expect((observed.error as Error).message).toBe("The chain read did not finish in time.");
  }
  const text = `${(observed.error as Error).message} ${String((observed.error as Error).stack)}`;
  expect(text).not.toMatch(/https?:|sk_live|SECRETKEY|provider body/);
}

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  mocks.prepare.mockReset();
  mocks.receipt.mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
  await flush();
  await flush();
  process.off("unhandledRejection", onUnhandled);
  // S8: no controlled late failure in any test escapes as an unhandled rejection.
  expect(unhandled).toEqual([]);
});

// ---------------------------------------------------------------------------
// readCashBalance fakes
// ---------------------------------------------------------------------------

type BalanceStage = "getChainId" | "balanceOf" | "decimals";
type Gate = Deferred<void>;

/**
 * A stand-in for the two PublicClient methods readCashBalance uses. A stage
 * listed in `gates` waits for its gate before answering (a rejected gate is
 * that read failing); `answers` overrides a stage's honest value.
 */
function balanceClient(options: { gates?: Partial<Record<BalanceStage, Gate>>; answers?: Partial<Record<BalanceStage, () => unknown>> } = {}) {
  const stages: BalanceStage[] = [];
  const honest: Record<BalanceStage, () => unknown> = {
    getChainId: () => BASE_SEPOLIA,
    balanceOf: () => BigInt(20_000_000),
    decimals: () => REAL_CASH_TOKEN.decimals,
  };
  const answer = async (stage: BalanceStage) => {
    stages.push(stage);
    const gate = options.gates?.[stage];
    if (gate) await gate.promise;
    return (options.answers?.[stage] ?? honest[stage])();
  };
  const client = {
    getChainId: () => answer("getChainId"),
    readContract: (args: { functionName: "balanceOf" | "decimals"; address: string; args?: unknown[] }) => {
      expect(args.address).toBe(REAL_CASH_TOKEN.address);
      if (args.functionName === "balanceOf") expect(args.args).toEqual([SAFE_ADDRESS]);
      return answer(args.functionName);
    },
  };
  return { client: client as unknown as RealPublicClient, stages };
}

const readBalance = (client: RealPublicClient) => readCashBalance({ publicClient: client, safeAddress: SAFE_ADDRESS });

describe("readCashBalance — 15 s whole-operation caller deadline", () => {
  it("pins the approved value", () => {
    expect(CASH_BALANCE_READ_DEADLINE_MS).toBe(15_000);
  });

  it("B1/B11: the honest result is unchanged, every read runs exactly once, and no timer is left armed", async () => {
    const { client, stages } = balanceClient();
    const result = observe(readBalance(client));
    await flush();
    expect(result).toEqual({ status: "fulfilled", value: { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" } });
    expect(stages).toEqual(["getChainId", "balanceOf", "decimals"]);
    expect(vi.getTimerCount()).toBe(0);
    await advance(CASH_BALANCE_READ_DEADLINE_MS * 2);
    expect(result.status).toBe("fulfilled");
  });

  it("B2/B3: an initial read that never answers is still pending at 14 999 ms and rejects at 15 000 ms", async () => {
    const { client, stages } = balanceClient({ gates: { getChainId: deferred() } });
    const result = observe(readBalance(client));
    expect(vi.getTimerCount()).toBe(1);
    await advance(14_999);
    expect(result.status).toBe("pending");
    await advance(1);
    expectDeadline(result, "balance");
    expect(stages).toEqual(["getChainId"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("B4: a later read (balanceOf, inside the parallel stage) that never answers rejects at the deadline", async () => {
    const { client, stages } = balanceClient({ gates: { balanceOf: deferred() } });
    const result = observe(readBalance(client));
    await flush();
    expect(stages).toEqual(["getChainId", "balanceOf", "decimals"]);
    await advance(14_999);
    expect(result.status).toBe("pending");
    await advance(1);
    expectDeadline(result, "balance");
  });

  it("B5: the deadline is not reset between stages — a 10 s chain-id read leaves 5 s for the contract reads", async () => {
    const chainGate = deferred();
    const { client, stages } = balanceClient({ gates: { getChainId: chainGate, decimals: deferred() } });
    const result = observe(readBalance(client));
    await advance(10_000);
    chainGate.resolve();
    await flush();
    expect(stages).toEqual(["getChainId", "balanceOf", "decimals"]);
    expect(vi.getTimerCount()).toBe(1);
    await advance(4_999);
    expect(result.status).toBe("pending");
    await advance(1);
    expectDeadline(result, "balance");
  });

  it("B6: a timeout rejects — never a zero, an empty or any other balance-shaped value", async () => {
    const { client } = balanceClient({ gates: { getChainId: deferred() } });
    const result = observe(readBalance(client));
    await advance(CASH_BALANCE_READ_DEADLINE_MS);
    expectDeadline(result, "balance");
    expect(result.error).not.toHaveProperty("balanceBaseUnits");
    expect(result.error).not.toHaveProperty("decimals");
  });

  it("B7/S6: a late chain-id success after expiry starts neither contract read", async () => {
    const chainGate = deferred();
    const { client, stages } = balanceClient({ gates: { getChainId: chainGate } });
    const result = observe(readBalance(client));
    await advance(CASH_BALANCE_READ_DEADLINE_MS);
    expectDeadline(result, "balance");
    chainGate.resolve();
    await flush();
    await advance(60_000);
    expect(stages).toEqual(["getChainId"]);
    expectDeadline(result, "balance");
  });

  it("B8/S4: late success of the already-started parallel reads cannot reach the original caller", async () => {
    const balanceGate = deferred();
    const decimalsGate = deferred();
    const { client, stages } = balanceClient({ gates: { balanceOf: balanceGate, decimals: decimalsGate } });
    const result = observe(readBalance(client));
    await advance(CASH_BALANCE_READ_DEADLINE_MS);
    expectDeadline(result, "balance");
    balanceGate.resolve();
    decimalsGate.resolve();
    await flush();
    expectDeadline(result, "balance");
    expect(stages).toEqual(["getChainId", "balanceOf", "decimals"]);
  });

  it("B9/S8: late rejections — of the first read, or of one parallel read while the other succeeds — are consumed and never surface", async () => {
    const chainGate = deferred();
    const first = balanceClient({ gates: { getChainId: chainGate } });
    const firstResult = observe(readBalance(first.client));
    const balanceGate = deferred();
    const decimalsGate = deferred();
    const parallel = balanceClient({ gates: { balanceOf: balanceGate, decimals: decimalsGate } });
    const parallelResult = observe(readBalance(parallel.client));
    await advance(CASH_BALANCE_READ_DEADLINE_MS);
    chainGate.reject(new Error(SECRET_BEARING));
    balanceGate.reject(new Error(SECRET_BEARING));
    decimalsGate.resolve();
    await flush();
    await flush();
    expectDeadline(firstResult, "balance");
    expectDeadline(parallelResult, "balance");
    expect(unhandled).toEqual([]);
  });

  it("B10/B12/S7: an ordinary error before the deadline propagates unchanged, is not retried, and leaves no timer", async () => {
    const failure = new Error("network unreachable");
    const cases: { answers: Partial<Record<BalanceStage, () => unknown>>; expected: RegExp | Error; stages: BalanceStage[] }[] = [
      {
        answers: {
          getChainId: () => {
            throw failure;
          },
        },
        expected: failure,
        stages: ["getChainId"],
      },
      { answers: { getChainId: () => 1 }, expected: /Base Sepolia/, stages: ["getChainId"] },
      { answers: { decimals: () => 18 }, expected: /decimals/, stages: ["getChainId", "balanceOf", "decimals"] },
      {
        answers: {
          balanceOf: () => {
            throw failure;
          },
        },
        expected: failure,
        stages: ["getChainId", "balanceOf", "decimals"],
      },
    ];
    for (const testCase of cases) {
      const { client, stages } = balanceClient({ answers: testCase.answers });
      const result = observe(readBalance(client));
      await flush();
      expect(result.status).toBe("rejected");
      if (testCase.expected instanceof Error) expect(result.error).toBe(testCase.expected);
      else expect((result.error as Error).message).toMatch(testCase.expected);
      expect(result.error).not.toBeInstanceOf(CashBalanceReadDeadlineError);
      expect(vi.getTimerCount()).toBe(0);
      await advance(CASH_BALANCE_READ_DEADLINE_MS * 2);
      expect(stages).toEqual(testCase.stages);
    }
  });

  it("S5: an honest answer just before the deadline wins, and the cleared timer stays inert", async () => {
    const chainGate = deferred();
    const { client } = balanceClient({ gates: { getChainId: chainGate } });
    const result = observe(readBalance(client));
    await advance(14_999);
    chainGate.resolve();
    await flush();
    expect(result).toEqual({ status: "fulfilled", value: { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" } });
    expect(vi.getTimerCount()).toBe(0);
    await advance(60_000);
    expect(result.status).toBe("fulfilled");
  });
});

// ---------------------------------------------------------------------------
// readLatestBlockClock
// ---------------------------------------------------------------------------

function clockClient(answer: () => Promise<unknown>) {
  const calls: unknown[] = [];
  const client = {
    getBlock: (args: unknown) => {
      calls.push(args);
      return answer();
    },
  };
  return { client: client as unknown as Pick<RealPublicClient, "getBlock">, calls };
}

const BLOCK = { number: BigInt(47_000_123), timestamp: BigInt(1_900_000_000), hash: "0xab" };

describe("readLatestBlockClock — 10 s caller deadline", () => {
  it("pins the approved value", () => {
    expect(LATEST_BLOCK_CLOCK_READ_DEADLINE_MS).toBe(10_000);
  });

  it("K1/K7: the honest clock is returned unchanged from one latest-block read, with no timer left", async () => {
    const { client, calls } = clockClient(async () => BLOCK);
    const result = observe(readLatestBlockClock(client));
    await flush();
    expect(result).toEqual({ status: "fulfilled", value: { number: BLOCK.number, timestamp: BLOCK.timestamp } });
    expect(calls).toEqual([{ blockTag: "latest" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("K2/K3/K4: a held read is pending at 9 999 ms and rejects at 10 000 ms — no fabricated timestamp", async () => {
    const gate = deferred<unknown>();
    const { client, calls } = clockClient(() => gate.promise);
    const result = observe(readLatestBlockClock(client));
    await advance(9_999);
    expect(result.status).toBe("pending");
    await advance(1);
    expectDeadline(result, "chain");
    expect(result.error).not.toHaveProperty("timestamp");
    expect(result.error).not.toHaveProperty("number");
    expect(calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("K5/S7: a late block cannot alter the rejected result, and nothing re-reads", async () => {
    const gate = deferred<unknown>();
    const { client, calls } = clockClient(() => gate.promise);
    const result = observe(readLatestBlockClock(client));
    await advance(LATEST_BLOCK_CLOCK_READ_DEADLINE_MS);
    gate.resolve(BLOCK);
    await flush();
    await advance(60_000);
    expectDeadline(result, "chain");
    expect(calls).toHaveLength(1);
  });

  it("K6: a late rejection is consumed", async () => {
    const gate = deferred<unknown>();
    const { client } = clockClient(() => gate.promise);
    const result = observe(readLatestBlockClock(client));
    await advance(LATEST_BLOCK_CLOCK_READ_DEADLINE_MS);
    gate.reject(new Error(SECRET_BEARING));
    await flush();
    expectDeadline(result, "chain");
  });

  it("K7: an ordinary failure propagates unchanged and clears the timer", async () => {
    const failure = new Error("RPC unavailable");
    const { client } = clockClient(async () => {
      throw failure;
    });
    const result = observe(readLatestBlockClock(client));
    await flush();
    expect(result).toEqual({ status: "rejected", error: failure });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("K8: a malformed block is passed through as read (never repaired or substituted) for the caller's own validation", async () => {
    for (const block of [
      { number: null, timestamp: BigInt(1_900_000_000) },
      { number: BigInt(1), timestamp: undefined },
      { number: "47000000", timestamp: -1 },
    ]) {
      const { client } = clockClient(async () => block);
      const result = observe(readLatestBlockClock(client));
      await flush();
      expect(result).toEqual({ status: "fulfilled", value: { number: block.number, timestamp: block.timestamp } });
    }
    // A block that is not an object at all still throws, as before.
    const { client } = clockClient(async () => null);
    const result = observe(readLatestBlockClock(client));
    await flush();
    expect(result.status).toBe("rejected");
    expect(result.error).toBeInstanceOf(TypeError);
  });
});

// ---------------------------------------------------------------------------
// readUserOperationChainState
// ---------------------------------------------------------------------------

const SENDER = "0x2222222222222222222222222222222222222222" as const;
const EXPECTED_HASH = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const KEY = BigInt("0x1a0d5d70cd9");
const NONCE = KEY << BigInt(64);
const PREPARE_BLOCK = BigInt(47_000_000);
const VALID_UNTIL = 1_900_000_600;
const TX = "0x5555555555555555555555555555555555555555555555555555555555555555";
const chainInput = { sender: SENDER, nonce: NONCE, userOperationHash: EXPECTED_HASH, prepareBlockNumber: PREPARE_BLOCK, validUntil: VALID_UNTIL } as const;
const matchingLog = (success: boolean) => ({ args: { userOpHash: EXPECTED_HASH, sender: SENDER, success }, transactionHash: TX });
const afterExpiry = { latest: { number: BigInt(47_001_000), timestamp: BigInt(VALID_UNTIL + 3_000) }, finalized: { number: BigInt(47_000_700), timestamp: BigInt(VALID_UNTIL + 1) } };

/** Fixture state for each honest proof branch, and the read stages that branch makes, in order. */
const EXPIRED = { state: { ...afterExpiry, latestSequence: BigInt(0), finalizedSequence: BigInt(0) }, result: { kind: "expired_unincluded" } };
const INCLUDED = { state: { latestSequence: BigInt(1), logs: [matchingLog(true)] }, result: { kind: "included", success: true, transactionHash: TX } };
const EXPIRED_STAGES = ["getChainId", "getBlock:latest", "getNonce:latest", "getBlock:finalized", "getNonce:finalized"] as const;
const INCLUDED_STAGES = ["getChainId", "getBlock:latest", "getNonce:latest", "getLogs"] as const;
type ProofStage = (typeof EXPIRED_STAGES)[number] | (typeof INCLUDED_STAGES)[number];

/**
 * The shared EntryPoint fake (honest answers) behind per-stage gates: a gated
 * stage waits for its gate, then answers exactly as the fake would; a rejected
 * gate is that read failing. `stages` records every read that STARTED.
 */
function proofReader(state: Parameters<typeof createFakeEntryPoint>[0], gates: Partial<Record<ProofStage, Gate>> = {}) {
  const fake = createFakeEntryPoint(state);
  const base = fake.reader as unknown as Record<"getChainId" | "getBlock" | "readContract" | "getLogs", (args?: unknown) => Promise<unknown>>;
  const stages: ProofStage[] = [];
  const route = async (stage: ProofStage, read: () => Promise<unknown>) => {
    stages.push(stage);
    const gate = gates[stage];
    if (gate) await gate.promise;
    return read();
  };
  const tag = (args: unknown) => ((args as { blockTag?: string }).blockTag === "finalized" ? "finalized" : "latest");
  const reader = {
    getChainId: () => route("getChainId", () => base.getChainId()),
    getBlock: (args: unknown) => route(`getBlock:${tag(args)}`, () => base.getBlock(args)),
    readContract: (args: unknown) => route(`getNonce:${tag(args)}`, () => base.readContract(args)),
    getLogs: (args: unknown) => route("getLogs", () => base.getLogs(args)),
  };
  return { reader: reader as unknown as EntryPointReader, stages, calls: fake.calls };
}

const readProof = (reader: EntryPointReader) => readUserOperationChainState(reader, chainInput);

describe("readUserOperationChainState — 20 s whole-proof caller deadline", () => {
  it("pins the approved value", () => {
    expect(USER_OPERATION_CHAIN_STATE_READ_DEADLINE_MS).toBe(20_000);
  });

  it("P1/P12: each honest proof branch is unchanged, reads each stage once, and leaves no timer", async () => {
    for (const [branch, stagesExpected] of [
      [EXPIRED, EXPIRED_STAGES],
      [INCLUDED, INCLUDED_STAGES],
    ] as const) {
      const { reader, stages } = proofReader(branch.state);
      const result = observe(readProof(reader));
      await flush();
      expect(result).toEqual({ status: "fulfilled", value: branch.result });
      expect(stages).toEqual([...stagesExpected]);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("P1: the proof makes no nested per-stage clock deadline — one timer covers the whole proof", async () => {
    const { reader } = proofReader(EXPIRED.state, { "getBlock:latest": deferred() });
    const result = observe(readProof(reader));
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    // Past readLatestBlockClock's own 10 s: the proof is still waiting on its single 20 s deadline.
    await advance(LATEST_BLOCK_CLOCK_READ_DEADLINE_MS);
    expect(result.status).toBe("pending");
    await advance(USER_OPERATION_CHAIN_STATE_READ_DEADLINE_MS - LATEST_BLOCK_CLOCK_READ_DEADLINE_MS);
    expectDeadline(result, "chain");
  });

  it("P2/P3: an initial chain-id read that never answers is pending at 19 999 ms and rejects at 20 000 ms", async () => {
    const { reader, stages } = proofReader(EXPIRED.state, { getChainId: deferred() });
    const result = observe(readProof(reader));
    await advance(19_999);
    expect(result.status).toBe("pending");
    await advance(1);
    expectDeadline(result, "chain");
    expect(stages).toEqual(["getChainId"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("P4/P5/P8: a hang at ANY stage of either branch rejects at the deadline — never unresolved, included, expired or partial", async () => {
    for (const [branch, branchStages] of [
      [EXPIRED, EXPIRED_STAGES],
      [INCLUDED, INCLUDED_STAGES],
    ] as const) {
      for (const [index, held] of branchStages.entries()) {
        const { reader, stages } = proofReader(branch.state, { [held]: deferred() });
        const result = observe(readProof(reader));
        await flush();
        expect(stages).toEqual(branchStages.slice(0, index + 1));
        await advance(19_999);
        expect(result.status).toBe("pending");
        await advance(1);
        expectDeadline(result, "chain");
      }
    }
  });

  it("P6/P7: stages consume one shared deadline — 5 s each for three stages leaves 5 s for the fourth, and it never restarts", async () => {
    const gates = { getChainId: deferred(), "getBlock:latest": deferred(), "getNonce:latest": deferred(), "getBlock:finalized": deferred() };
    const { reader, stages } = proofReader(EXPIRED.state, gates);
    const result = observe(readProof(reader));
    for (const stage of ["getChainId", "getBlock:latest", "getNonce:latest"] as const) {
      await advance(5_000);
      gates[stage].resolve();
      await flush();
    }
    expect(stages).toEqual(["getChainId", "getBlock:latest", "getNonce:latest", "getBlock:finalized"]);
    expect(vi.getTimerCount()).toBe(1);
    await advance(4_999);
    expect(result.status).toBe("pending");
    await advance(1);
    expectDeadline(result, "chain");
  });

  it("P7: a first stage answering at 19 000 ms leaves 1 000 ms, not a fresh 20 s", async () => {
    const chainGate = deferred();
    const { reader, stages } = proofReader(EXPIRED.state, { getChainId: chainGate, "getBlock:latest": deferred() });
    const result = observe(readProof(reader));
    await advance(19_000);
    chainGate.resolve();
    await flush();
    expect(stages).toEqual(["getChainId", "getBlock:latest"]);
    await advance(999);
    expect(result.status).toBe("pending");
    await advance(1);
    expectDeadline(result, "chain");
  });

  it("P9/S6/S7: a late answer at ANY stage of either branch starts no further read, and nothing is retried", async () => {
    for (const branchStages of [EXPIRED_STAGES, INCLUDED_STAGES]) {
      const branch = branchStages === EXPIRED_STAGES ? EXPIRED : INCLUDED;
      for (const [index, held] of branchStages.entries()) {
        const gate = deferred();
        const { reader, stages, calls } = proofReader(branch.state, { [held]: gate });
        const result = observe(readProof(reader));
        await advance(USER_OPERATION_CHAIN_STATE_READ_DEADLINE_MS);
        expectDeadline(result, "chain");
        gate.resolve();
        await flush();
        await advance(120_000);
        expect(stages).toEqual(branchStages.slice(0, index + 1));
        // The held read itself answered once, late; no read before it was repeated.
        expect(calls).toHaveLength(index + 1);
        expectDeadline(result, "chain");
      }
    }
  });

  it("P10/S4: a late answer that would COMPLETE the proof (expired_unincluded or included) cannot replace the rejection", async () => {
    for (const [branch, last] of [
      [EXPIRED, "getNonce:finalized"],
      [INCLUDED, "getLogs"],
    ] as const) {
      const gate = deferred();
      const { reader } = proofReader(branch.state, { [last]: gate });
      const result = observe(readProof(reader));
      await advance(USER_OPERATION_CHAIN_STATE_READ_DEADLINE_MS);
      gate.resolve();
      await flush();
      expectDeadline(result, "chain");
    }
  });

  it("P11/S8: late rejections — including a late chain-id failure, which would otherwise be 'unresolved' — are consumed; the answer stays the deadline", async () => {
    for (const held of ["getChainId", "getBlock:finalized", "getNonce:finalized"] as const) {
      const gate = deferred();
      const { reader } = proofReader(EXPIRED.state, { [held]: gate });
      const result = observe(readProof(reader));
      await advance(USER_OPERATION_CHAIN_STATE_READ_DEADLINE_MS);
      gate.reject(new Error(SECRET_BEARING));
      await flush();
      expectDeadline(result, "chain");
    }
    expect(unhandled).toEqual([]);
  });

  it("P13: an ordinary read error before the deadline propagates unchanged; a failed chain-id read stays 'unresolved'; neither leaves a timer", async () => {
    const failure = new Error("RPC unavailable");
    const finalizedGate = deferred();
    finalizedGate.promise.catch(() => {}); // rejected before the read awaits it; the read still sees the rejection
    finalizedGate.reject(failure);
    const failing = proofReader(EXPIRED.state, { "getBlock:finalized": finalizedGate });
    const failed = observe(readProof(failing.reader));
    await flush();
    expect(failed).toEqual({ status: "rejected", error: failure });
    expect(vi.getTimerCount()).toBe(0);

    const chainIdFails = proofReader({ ...EXPIRED.state, failChainId: true });
    const unresolved = observe(readProof(chainIdFails.reader));
    await flush();
    expect(unresolved).toEqual({ status: "fulfilled", value: { kind: "unresolved" } });
    expect(chainIdFails.stages).toEqual(["getChainId"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("P14: existing chain, nonce, event and finality conditions still decide 'unresolved' within the deadline", async () => {
    const cases: Parameters<typeof createFakeEntryPoint>[0][] = [
      { ...EXPIRED.state, chainId: 1 }, // wrong chain: unresolved before any other read
      { ...afterExpiry, finalized: { number: BigInt(47_000_200), timestamp: BigInt(VALID_UNTIL) }, latestSequence: BigInt(0), finalizedSequence: BigInt(0) }, // finalized not past validUntil
      { ...afterExpiry, latestSequence: BigInt(0), finalizedSequence: BigInt(1) }, // finalized lane consumed (latest is not the proof)
      { ...EXPIRED.state, rawNonce: { latest: (KEY + BigInt(1)) << BigInt(64) } }, // wrong nonce key
      { ...EXPIRED.state, rawNonce: { latest: -BigInt(1) } }, // out-of-range nonce
      { latestSequence: BigInt(1), logs: [] }, // advanced lane, no event
      { latestSequence: BigInt(1), logs: [matchingLog(true), matchingLog(true)] }, // two events
      { latestSequence: BigInt(1), logs: [{ args: { userOpHash: EXPECTED_HASH, sender: SENDER }, transactionHash: TX }] }, // event without success flag
    ];
    for (const state of cases) {
      const { reader } = proofReader(state);
      const result = observe(readProof(reader));
      await flush();
      expect(result).toEqual({ status: "fulfilled", value: { kind: "unresolved" } });
      expect(vi.getTimerCount()).toBe(0);
    }
    const wrongChain = proofReader({ ...EXPIRED.state, chainId: 1 });
    await readProof(wrongChain.reader);
    expect(wrongChain.stages).toEqual(["getChainId"]);
  });
});

// ---------------------------------------------------------------------------
// Shared: per-invocation isolation
// ---------------------------------------------------------------------------

describe("per-invocation deadline isolation", () => {
  it("S1/S2: overlapping balance reads keep independent deadlines; the older one timing out does not clear the newer one's timer", async () => {
    const older = observe(readBalance(balanceClient({ gates: { getChainId: deferred() } }).client));
    await advance(5_000);
    const newer = observe(readBalance(balanceClient({ gates: { getChainId: deferred() } }).client));
    expect(vi.getTimerCount()).toBe(2);
    await advance(10_000);
    expectDeadline(older, "balance");
    expect(newer.status).toBe("pending");
    expect(vi.getTimerCount()).toBe(1);
    await advance(4_999);
    expect(newer.status).toBe("pending");
    await advance(1);
    expectDeadline(newer, "balance");
  });

  it("S2: an older balance read that SUCCEEDS clears only its own timer; a newer held read still times out on its own clock", async () => {
    const olderGate = deferred();
    const older = observe(readBalance(balanceClient({ gates: { getChainId: olderGate } }).client));
    await advance(1_000);
    const newer = observe(readBalance(balanceClient({ gates: { getChainId: deferred() } }).client));
    olderGate.resolve();
    await flush();
    expect(older).toEqual({ status: "fulfilled", value: { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" } });
    expect(vi.getTimerCount()).toBe(1);
    await advance(14_999);
    expect(newer.status).toBe("pending");
    await advance(1);
    expectDeadline(newer, "balance");
  });

  it("S2: an older proof that SUCCEEDS clears only its own timer; a newer held proof still times out on its own clock", async () => {
    const olderGate = deferred();
    const older = observe(readProof(proofReader(EXPIRED.state, { getChainId: olderGate }).reader));
    await advance(1_000);
    const newer = observe(readProof(proofReader(EXPIRED.state, { getChainId: deferred() }).reader));
    olderGate.resolve();
    await flush();
    expect(older).toEqual({ status: "fulfilled", value: EXPIRED.result });
    expect(vi.getTimerCount()).toBe(1);
    await advance(19_999);
    expect(newer.status).toBe("pending");
    await advance(1);
    expectDeadline(newer, "chain");
  });

  it("S3: one clock read times out while a concurrent one succeeds", async () => {
    const held = observe(readLatestBlockClock(clockClient(() => deferred<unknown>().promise).client));
    const honest = observe(readLatestBlockClock(clockClient(async () => BLOCK).client));
    await flush();
    expect(honest).toEqual({ status: "fulfilled", value: { number: BLOCK.number, timestamp: BLOCK.timestamp } });
    await advance(LATEST_BLOCK_CLOCK_READ_DEADLINE_MS);
    expectDeadline(held, "chain");
    expect(honest.status).toBe("fulfilled");
  });
});

// ---------------------------------------------------------------------------
// Caller mappings (the existing server callers, unchanged)
// ---------------------------------------------------------------------------

async function seedAccount(safeAddress: string) {
  const registry = createInMemoryRealAccountRegistry();
  await registry.createAccountWithPasskey({
    account: {
      appUserId: "app-user-1",
      subOrganizationId: "sub-org-1",
      turnkeyUserId: "turnkey-user-1",
      walletId: "wallet-1",
      walletAccountId: "wallet-account-1",
      ownerAddress: OWNER_ADDRESS,
      safeAddress,
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
  const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);
  return { registry, cookieValue };
}

/** A balance + clock client for resolvePreparePayment: `gates` holds a stage; `stages` records what started. */
function prepareClient(gates: Partial<Record<BalanceStage | "getBlock", Gate>>) {
  const balance = balanceClient({ gates });
  const stages = balance.stages as (BalanceStage | "getBlock")[];
  const client = Object.assign(balance.client, {
    getBlock: async () => {
      stages.push("getBlock");
      if (gates.getBlock) await gates.getBlock.promise;
      return BLOCK;
    },
  });
  return { client, stages };
}

describe("caller mappings after a deadline (existing callers, unchanged)", () => {
  it("account balance: a timed-out read is the fixed read_failed outcome — never a balance — and its one budget unit stays charged", async () => {
    const { registry, cookieValue } = await seedAccount(SAFE_ADDRESS);
    const budget = scriptedBudget({ allowed: true });
    const { client, stages } = balanceClient({ gates: { getChainId: deferred() } });
    const outcome = observe(resolveAuthenticatedCashBalance({ cookieValue, sessionSecret: SECRET, registry, publicClient: client, providerBudgetLimiter: budget.limiter }));
    await flushUntil(() => stages.length > 0, "balance read started");
    await advance(CASH_BALANCE_READ_DEADLINE_MS);
    expect(outcome).toEqual({ status: "fulfilled", value: { outcome: "read_failed", reason: "Could not read your balance right now. Try again in a moment." } });
    expect(budget.calls).toHaveLength(1);
    expect(stages).toEqual(["getChainId"]);
  });

  async function prepareHarness(gates: Partial<Record<BalanceStage | "getBlock", Gate>>) {
    const { registry, cookieValue } = await seedAccount(SAFE_ADDRESS);
    const store = createInMemoryPaymentAttemptStore();
    const reserve = vi.spyOn(store, "reserve");
    const limiter = recordingRateLimiter();
    const { client, stages } = prepareClient(gates);
    const outcome = observe(
      resolvePreparePayment({
        cookieValue,
        sessionSecret: SECRET,
        registry,
        paymentStore: store,
        rateLimiter: limiter.limiter,
        publicClient: client,
        pimlicoApiKey: "pim_test_key",
        recipient: { kind: "address", value: "0x2222222222222222222222222222222222222222" } as NonNullable<Parameters<typeof resolvePreparePayment>[0]["recipient"]>,
        amountBaseUnitsInput: "1000000",
      }),
    );
    return { outcome, stages, store, reserve, limiter };
  }

  it("Pay prepare: a timed-out balance check is balance_check_failed, before any clock read, reservation or Pimlico call", async () => {
    const h = await prepareHarness({ balanceOf: deferred() });
    await flushUntil(() => h.stages.includes("balanceOf"), "prepare balance read started");
    await advance(CASH_BALANCE_READ_DEADLINE_MS);
    expect(h.outcome).toEqual({ status: "fulfilled", value: { outcome: "balance_check_failed", reason: "Could not check your balance right now. Try again in a moment." } });
    expect(h.stages).not.toContain("getBlock");
    expect(h.reserve).not.toHaveBeenCalled();
    expect(await h.store.findLatestByAppUserId("app-user-1")).toBeNull();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(h.limiter.charges).toHaveLength(1);
  });

  it("Pay prepare: a timed-out chain clock is prepare_failed, before any reservation or Pimlico call — no substitute clock", async () => {
    const h = await prepareHarness({ getBlock: deferred() });
    await flushUntil(() => h.stages.includes("getBlock"), "prepare clock read started");
    await advance(LATEST_BLOCK_CLOCK_READ_DEADLINE_MS);
    expect(h.outcome).toEqual({ status: "fulfilled", value: { outcome: "prepare_failed", reason: "Could not prepare this payment right now. Try again in a moment." } });
    expect(h.reserve).not.toHaveBeenCalled();
    expect(await h.store.findLatestByAppUserId("app-user-1")).toBeNull();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(h.limiter.charges).toHaveLength(1);
  });

  it("payment status: a timed-out EntryPoint proof leaves the stored payment exactly as it was — no transition, one budget charge", async () => {
    const { registry, cookieValue } = await seedAccount(SENDER);
    const store = createInMemoryPaymentAttemptStore();
    const reserved = await store.reserve({
      appUserId: "app-user-1",
      safeAddress: SENDER,
      recipient: "0x4444444444444444444444444444444444444444",
      amountBaseUnits: "1000000",
      chainId: BASE_SEPOLIA,
      tokenAddress: REAL_CASH_TOKEN.address,
      authorizingCredentialId: "credential-1",
    });
    if (!reserved.ok) throw new Error("expected reservation to succeed");
    const id = reserved.attempt.id;
    await store.transition({ id, from: "prepared", to: "awaiting_authorization", patch: { expectedUserOperationHash: EXPECTED_HASH, nonce: NONCE.toString(), validUntil: VALID_UNTIL, prepareBlockNumber: PREPARE_BLOCK.toString() } });
    await store.transition({ id, from: "awaiting_authorization", to: "signed" });
    await store.transition({ id, from: "signed", to: "submitting" });
    await store.transition({ id, from: "submitting", to: "unknown" });
    const before = await store.findById(id);
    const transition = vi.spyOn(store, "transition");
    mocks.receipt.mockResolvedValue(null);
    const budget = scriptedBudget({ allowed: true });
    // Would prove expired_unincluded ("failed") if the held finalized nonce read ever answered.
    const gate = deferred();
    const { reader, stages } = proofReader(EXPIRED.state, { "getNonce:finalized": gate });

    const outcome = observe(resolvePaymentStatus({ cookieValue, sessionSecret: SECRET, registry, paymentStore: store, pimlicoApiKey: "pim_test_key", providerBudgetLimiter: budget.limiter, publicClient: reader, attemptId: id }));
    await flushUntil(() => stages.includes("getNonce:finalized"), "status proof reached its last read");
    await advance(USER_OPERATION_CHAIN_STATE_READ_DEADLINE_MS);
    expect(outcome.status).toBe("fulfilled");
    expect(outcome.value).toMatchObject({ outcome: "ok", reconciliationDeferred: false, attempt: { id, state: "unknown" } });
    gate.resolve();
    await flush();
    expect(transition).not.toHaveBeenCalled();
    expect(await store.findById(id)).toEqual(before);
    expect(budget.calls).toHaveLength(1);
    expect(mocks.receipt).toHaveBeenCalledTimes(1);
  });
});
