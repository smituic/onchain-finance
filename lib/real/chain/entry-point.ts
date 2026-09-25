import type { Address, Hash } from "viem";
import { REAL_SAFE } from "../constants";
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

export type EntryPointReader = Pick<RealPublicClient, "getBlock" | "readContract" | "getLogs">;

/** The chain's own clock — the clock the EntryPoint enforces validUntil against. */
export async function readLatestBlockClock(client: Pick<RealPublicClient, "getBlock">): Promise<{ number: bigint; timestamp: bigint }> {
  const block = await client.getBlock({ blockTag: "latest" });
  return { number: block.number, timestamp: block.timestamp };
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
 * - NEVER INCLUDABLE: at the finalized block — which cannot be reorged — the
 *   timestamp is past validUntil and the nonce is still unconsumed, so no
 *   current or future block can include it. `latest` is deliberately NOT
 *   enough for this negative conclusion.
 *
 * Any RPC error propagates; callers treat a throw as unresolved.
 */
export async function readUserOperationChainState(
  client: EntryPointReader,
  input: { sender: Address; nonce: bigint; userOperationHash: Hash; prepareBlockNumber: bigint; validUntil: number },
): Promise<UserOperationChainState> {
  const { key, sequence } = splitUserOperationNonce(input.nonce);
  const readSequence = async (blockNumber: bigint) => {
    const onChain = await client.readContract({ address: REAL_SAFE.entryPoint.address, abi: ENTRY_POINT_ABI, functionName: "getNonce", args: [input.sender, key], blockNumber });
    return splitUserOperationNonce(onChain).sequence;
  };

  const latest = await readLatestBlockClock(client);
  const latestSequence = await readSequence(latest.number);

  if (latestSequence > sequence) {
    const lastPossibleBlock = input.prepareBlockNumber + BigInt(SAFE_OP_VALIDITY_SECONDS);
    const logs = await client.getLogs({
      address: REAL_SAFE.entryPoint.address,
      event: ENTRY_POINT_ABI[1],
      args: { userOpHash: input.userOperationHash, sender: input.sender },
      fromBlock: input.prepareBlockNumber,
      toBlock: latest.number < lastPossibleBlock ? latest.number : lastPossibleBlock,
    });
    const matches = logs.filter(
      (log) => log.args.userOpHash?.toLowerCase() === input.userOperationHash.toLowerCase() && log.args.sender?.toLowerCase() === input.sender.toLowerCase(),
    );
    if (matches.length !== 1 || typeof matches[0]!.args.success !== "boolean" || !matches[0]!.transactionHash) return { kind: "unresolved" };
    return { kind: "included", success: matches[0]!.args.success, transactionHash: matches[0]!.transactionHash };
  }
  if (latestSequence !== sequence) return { kind: "unresolved" };

  const finalized = await client.getBlock({ blockTag: "finalized" });
  if (finalized.timestamp <= BigInt(input.validUntil)) return { kind: "unresolved" };
  return (await readSequence(finalized.number)) === sequence ? { kind: "expired_unincluded" } : { kind: "unresolved" };
}
