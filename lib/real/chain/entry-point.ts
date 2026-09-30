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
 */
export async function readUserOperationChainState(
  client: EntryPointReader,
  input: { sender: Address; nonce: bigint; userOperationHash: Hash; prepareBlockNumber: bigint; validUntil: number },
): Promise<UserOperationChainState> {
  let chainId: number;
  try {
    chainId = await client.getChainId();
  } catch {
    return { kind: "unresolved" };
  }
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) return { kind: "unresolved" };

  const { key, sequence } = splitUserOperationNonce(input.nonce);
  const readSequence = async (blockTag: "latest" | "finalized"): Promise<bigint | null> => {
    const onChain: unknown = await client.readContract({ address: REAL_SAFE.entryPoint.address, abi: ENTRY_POINT_ABI, functionName: "getNonce", args: [input.sender, key], blockTag });
    if (typeof onChain !== "bigint" || onChain < BigInt(0) || onChain >= BigInt(1) << BigInt(256)) return null;
    const decoded = splitUserOperationNonce(onChain);
    return decoded.key === key ? decoded.sequence : null;
  };

  // Latest state is used only for inclusion DISCOVERY (the matching event is
  // the proof); it never authorizes expired_unincluded.
  const latest = await readLatestBlockClock(client);
  const latestSequence = await readSequence("latest");
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
    const matches = logs.filter(
      (log) => log.args.userOpHash?.toLowerCase() === input.userOperationHash.toLowerCase() && log.args.sender?.toLowerCase() === input.sender.toLowerCase(),
    );
    if (matches.length !== 1 || typeof matches[0]!.args.success !== "boolean" || !matches[0]!.transactionHash) return { kind: "unresolved" };
    return { kind: "included", success: matches[0]!.args.success, transactionHash: matches[0]!.transactionHash };
  }
  if (latestSequence !== sequence) return { kind: "unresolved" };

  const finalized = await client.getBlock({ blockTag: "finalized" });
  if (finalized.timestamp <= BigInt(input.validUntil)) return { kind: "unresolved" };
  const finalizedSequence = await readSequence("finalized");
  return finalizedSequence === sequence ? { kind: "expired_unincluded" } : { kind: "unresolved" };
}
