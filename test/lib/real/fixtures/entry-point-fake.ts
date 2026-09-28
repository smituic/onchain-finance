import type { EntryPointReader } from "@/lib/real/chain/entry-point";

type FakeLog = { args: { userOpHash?: string; sender?: string; success?: boolean }; transactionHash: string | null };
type Lane = { latest: bigint; finalized: bigint };

/**
 * An in-process stand-in for the read-only EntryPoint calls
 * chain/entry-point.ts makes (getBlock latest/finalized, getNonce at a block
 * tag, getLogs). Latest and finalized nonce state are fully independent —
 * neither defaults to the other — so tests can make them disagree. The key
 * half of the nonce is echoed back from the request, exactly like
 * NonceManager.getNonce, unless `rawNonce` overrides the whole packed value.
 * Records every call so tests can assert what was (and wasn't) read.
 */
export function createFakeEntryPoint(state: {
  latest?: { number: bigint; timestamp: bigint };
  finalized?: { number: bigint; timestamp: bigint };
  latestSequence?: bigint;
  finalizedSequence?: bigint;
  /** Per-key lanes; a requested key not listed here uses latestSequence/finalizedSequence. */
  lanes?: Map<bigint, Lane>;
  /** Returned verbatim (not re-packed with the requested key) for that tag. */
  rawNonce?: { latest?: unknown; finalized?: unknown };
  logs?: FakeLog[];
  fail?: boolean;
  /** Throws on any readContract given a numbered blockNumber — proves no historical numbered read is attempted. */
  failNumberedReads?: boolean;
  /** Throws only on getNonce at blockTag "finalized" (e.g. a provider that doesn't support it). */
  failFinalizedStateReads?: boolean;
}) {
  const latest = state.latest ?? { number: BigInt(47_000_100), timestamp: BigInt(Math.floor(Date.now() / 1000)) };
  const finalized = state.finalized ?? { number: latest.number - BigInt(645), timestamp: latest.timestamp - BigInt(1290) };
  const calls: { method: string; args: unknown }[] = [];

  const reader = {
    async getBlock(args: { blockTag?: string }) {
      calls.push({ method: "getBlock", args });
      if (state.fail) throw new Error("RPC unavailable");
      return args.blockTag === "finalized" ? finalized : latest;
    },
    async readContract(args: { args: [string, bigint]; blockNumber?: bigint; blockTag?: string }) {
      calls.push({ method: "readContract", args });
      if (state.fail) throw new Error("RPC unavailable");
      if (state.failNumberedReads && args.blockNumber !== undefined) throw new Error("RPC does not serve historical state at this block");
      const tag = args.blockTag === "finalized" ? "finalized" : "latest";
      if (tag === "finalized" && state.failFinalizedStateReads) throw new Error("finalized block tag not supported");
      if (state.rawNonce && tag in state.rawNonce) return state.rawNonce[tag];
      const requestedKey = args.args[1];
      const lane = state.lanes?.get(requestedKey);
      const sequence = lane ? lane[tag] : tag === "finalized" ? (state.finalizedSequence ?? BigInt(0)) : (state.latestSequence ?? BigInt(0));
      return (requestedKey << BigInt(64)) | sequence;
    },
    async getLogs(args: unknown) {
      calls.push({ method: "getLogs", args });
      if (state.fail) throw new Error("RPC unavailable");
      return state.logs ?? [];
    },
  };
  return { reader: reader as unknown as EntryPointReader, calls, latest, finalized };
}
