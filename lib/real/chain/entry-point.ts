import type { Address, Hash } from "viem";
import { BASE_SEPOLIA_CHAIN_ID, REAL_SAFE } from "../constants";
import { SAFE_OP_VALIDITY_SECONDS, splitUserOperationNonce } from "../payments/validity";
import type { RealPublicClient } from "./client";

/** Mirrors EntryPoint v0.7 (NonceManager.getNonce, IEntryPoint.UserOperationEvent) — the same shapes as viem's entryPoint07Abi. */
const ENTRY_POINT_ABI = [
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
  {
    type: "event",
    name: "UserOperationEvent",
    anonymous: false,
    inputs: [
      { indexed: true, name: "userOpHash", type: "bytes32" },
      { indexed: true, name: "sender", type: "address" },
      { indexed: true, name: "paymaster", type: "address" },
      { indexed: false, name: "nonce", type: "uint256" },
      { indexed: false, name: "success", type: "bool" },
      { indexed: false, name: "actualGasCost", type: "uint256" },
      { indexed: false, name: "actualGasUsed", type: "uint256" },
    ],
  },
] as const;

export type EntryPointReader = Pick<RealPublicClient, "getChainId" | "getBlock" | "readContract" | "getLogs">;

/**
 * M3D server chain-read caller deadlines: how long the CALLER waits for the
 * whole exported operation, on one timer per call that is never reset between
 * read stages. Provisional, approved controlled-development values — not
 * provider-latency calibrated, not RPC SLAs, not whole-route deadlines.
 */
export const LATEST_BLOCK_CLOCK_READ_DEADLINE_MS = 10_000;
/** Covers the ENTIRE proof (chain id, latest block, nonce reads, logs, finalized block) — not each read. */
export const USER_OPERATION_CHAIN_STATE_READ_DEADLINE_MS = 20_000;

/**
 * The read could not be established within the deadline. A fixed message —
 * never an RPC URL, key or provider body. Never a clock, never a proof of
 * absence, failure or expiry: callers treat it like any other read failure.
 */
export class ChainReadDeadlineError extends Error {
  constructor() {
    super("The chain read did not finish in time.");
    this.name = "ChainReadDeadlineError";
  }
}

/**
 * Runs one whole read operation under a single caller deadline. The timer is
 * armed before `run` starts any read and cleared as soon as `run` settles
 * first; on expiry the returned promise rejects and a late result or late
 * rejection of `run` is consumed here and never reaches the caller (a promise
 * settles once). `checkpoint` throws once the deadline has fired: `run` calls
 * it after every await, so a late answer can never start another read stage.
 * State is per call. This bounds the caller's wait only — it does not abort
 * an in-flight viem request, which may still finish (or retry) on its own.
 */
function withChainReadDeadline<T>(deadlineMs: number, run: (checkpoint: () => void) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      reject(new ChainReadDeadlineError());
    }, deadlineMs);
    const checkpoint = () => {
      if (expired) throw new ChainReadDeadlineError();
    };
    run(checkpoint).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** The original, unbounded clock read — used inside the proof, which is bounded as a whole. */
async function readLatestBlockClockUnbounded(client: Pick<RealPublicClient, "getBlock">): Promise<{ number: bigint; timestamp: bigint }> {
  const block = await client.getBlock({ blockTag: "latest" });
  return { number: block.number, timestamp: block.timestamp };
}

/**
 * The chain's own clock — the clock the EntryPoint enforces validUntil against.
 * Bounded by LATEST_BLOCK_CLOCK_READ_DEADLINE_MS: a missed deadline REJECTS
 * (ChainReadDeadlineError) — never a substitute timestamp. The value is
 * returned as read; the caller validates it.
 */
export function readLatestBlockClock(client: Pick<RealPublicClient, "getBlock">): Promise<{ number: bigint; timestamp: bigint }> {
  return withChainReadDeadline(LATEST_BLOCK_CLOCK_READ_DEADLINE_MS, async (checkpoint) => {
    const clock = await readLatestBlockClockUnbounded(client);
    checkpoint();
    return clock;
  });
}

export type UserOperationChainState =
  | { kind: "included"; success: boolean; transactionHash: Hash }
  /** Proven unincludable: at a FINALIZED block past validUntil, its nonce was still unconsumed. */
  | { kind: "expired_unincluded" }
  /** Nothing provable yet (or an inconsistency) — the caller must leave the attempt exactly as it is. */
  | { kind: "unresolved" };

/**
 * Read-only reconciliation against the EntryPoint itself — independent of
 * the bundler. Only ever proves one of two things, and leaves everything
 * else unresolved (fail closed):
 *
 * - INCLUDED: the nonce lane (unique to this payment — see validity.ts) has
 *   advanced past our sequence AND exactly one UserOperationEvent for this
 *   userOpHash + sender exists. The event's own `success` decides confirmed
 *   vs reverted. The search range is a hard bound, not a guess: the op is
 *   only valid at timestamps <= validUntil = prepare timestamp + window, and
 *   block timestamps strictly increase by >= 1 s, so it can only sit in
 *   [prepareBlock, prepareBlock + window].
 * - NEVER INCLUDABLE: the finalized block's timestamp is past validUntil
 *   AND getNonce evaluated at blockTag "finalized" still returns this exact
 *   key at this exact sequence. Both facts come from finalized state, which
 *   cannot be reorged; `latest` state is never the proof of non-inclusion
 *   (a latest read and a finalized header are separate RPC observations and
 *   need not describe one coherent chain). The header and the state read are
 *   also two observations, but finality only advances: a finalized state at
 *   least as new as the header also has timestamp > validUntil. The state
 *   read uses the "finalized" TAG, never a numbered block, so the proof never
 *   needs a provider to serve arbitrary historical state.
 *
 * Every getNonce value is validated as a packed (key << 64 | sequence) nonce
 * whose key is exactly the one requested before its sequence is trusted; a
 * wrong key, a non-bigint, or an out-of-range value is unresolved.
 *
 * S5 (M1): the RPC must first prove it IS Base Sepolia. The canonical
 * EntryPoint v0.7 exists at the same address on most chains, and on a chain
 * where this Safe never used this nonce key getNonce returns exactly
 * `key << 64 | 0` — so a misconfigured RPC URL would otherwise "prove"
 * expired_unincluded ("No money moved") for an operation that landed on
 * Base Sepolia. A different chain id, or a failed chain-id read, is
 * unresolved before any other read.
 *
 * Any other RPC error propagates; callers treat a throw as unresolved.
 *
 * M3D: the whole proof is bounded by USER_OPERATION_CHAIN_STATE_READ_DEADLINE_MS
 * on one timer. A missed deadline REJECTS (ChainReadDeadlineError) — it is
 * never "unresolved", "included" or "expired_unincluded", and never a proof
 * assembled from the reads that did finish. After it fires, no further read
 * stage starts (every await is followed by a checkpoint).
 */
export function readUserOperationChainState(
  client: EntryPointReader,
  input: { sender: Address; nonce: bigint; userOperationHash: Hash; prepareBlockNumber: bigint; validUntil: number },
): Promise<UserOperationChainState> {
  return withChainReadDeadline(USER_OPERATION_CHAIN_STATE_READ_DEADLINE_MS, (checkpoint) => readUserOperationChainStateWithin(client, input, checkpoint));
}

async function readUserOperationChainStateWithin(
  client: EntryPointReader,
  input: { sender: Address; nonce: bigint; userOperationHash: Hash; prepareBlockNumber: bigint; validUntil: number },
  checkpoint: () => void,
): Promise<UserOperationChainState> {
  let chainId: number;
  try {
    chainId = await client.getChainId();
  } catch {
    return { kind: "unresolved" };
  }
  checkpoint();
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) return { kind: "unresolved" };

  const { key, sequence } = splitUserOperationNonce(input.nonce);
  const readSequence = async (blockTag: "latest" | "finalized"): Promise<bigint | null> => {
    const onChain: unknown = await client.readContract({ address: REAL_SAFE.entryPoint.address, abi: ENTRY_POINT_ABI, functionName: "getNonce", args: [input.sender, key], blockTag });
    checkpoint();
    if (typeof onChain !== "bigint" || onChain < BigInt(0) || onChain >= BigInt(1) << BigInt(256)) return null;
    const decoded = splitUserOperationNonce(onChain);
    return decoded.key === key ? decoded.sequence : null;
  };

  // Latest state is used only for inclusion DISCOVERY (the matching event is
  // the proof); it never authorizes expired_unincluded.
  const latest = await readLatestBlockClockUnbounded(client);
  checkpoint();
  const latestSequence = await readSequence("latest");
  checkpoint();
  if (latestSequence === null) return { kind: "unresolved" };

  if (latestSequence > sequence) {
    const lastPossibleBlock = input.prepareBlockNumber + BigInt(SAFE_OP_VALIDITY_SECONDS);
    const logs = await client.getLogs({
      address: REAL_SAFE.entryPoint.address,
      event: ENTRY_POINT_ABI[1],
      args: { userOpHash: input.userOperationHash, sender: input.sender },
      fromBlock: input.prepareBlockNumber,
      toBlock: latest.number < lastPossibleBlock ? latest.number : lastPossibleBlock,
    });
    checkpoint();
    const matches = logs.filter(
      (log) => log.args.userOpHash?.toLowerCase() === input.userOperationHash.toLowerCase() && log.args.sender?.toLowerCase() === input.sender.toLowerCase(),
    );
    if (matches.length !== 1 || typeof matches[0]!.args.success !== "boolean" || !matches[0]!.transactionHash) return { kind: "unresolved" };
    return { kind: "included", success: matches[0]!.args.success, transactionHash: matches[0]!.transactionHash };
  }
  if (latestSequence !== sequence) return { kind: "unresolved" };

  const finalized = await client.getBlock({ blockTag: "finalized" });
  checkpoint();
  if (finalized.timestamp <= BigInt(input.validUntil)) return { kind: "unresolved" };
  const finalizedSequence = await readSequence("finalized");
  checkpoint();
  return finalizedSequence === sequence ? { kind: "expired_unincluded" } : { kind: "unresolved" };
}
