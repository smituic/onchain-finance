import type { EntryPointReader } from "@/lib/real/chain/entry-point";

type FakeLog = { args: { userOpHash?: string; sender?: string; success?: boolean }; transactionHash: string | null };

/**
 * An in-process stand-in for the three read-only EntryPoint calls
 * chain/entry-point.ts makes (getBlock latest/finalized, getNonce at a block,
 * getLogs). Nonce sequences are given per block tag; the key half of the
 * nonce is echoed back from the request, exactly like NonceManager.getNonce.
 * Records every call so tests can assert what was (and wasn't) read.
 */
export function createFakeEntryPoint(state: {
  latest?: { number: bigint; timestamp: bigint };
  finalized?: { number: bigint; timestamp: bigint };
  latestSequence?: bigint;
  finalizedSequence?: bigint;
  logs?: FakeLog[];
  fail?: boolean;
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
    async readContract(args: { args: [string, bigint]; blockNumber?: bigint }) {
      calls.push({ method: "readContract", args });
      if (state.fail) throw new Error("RPC unavailable");
      const sequence = args.blockNumber === finalized.number ? (state.finalizedSequence ?? state.latestSequence ?? BigInt(0)) : (state.latestSequence ?? BigInt(0));
      return (args.args[1] << BigInt(64)) | sequence;
    },
    async getLogs(args: unknown) {
      calls.push({ method: "getLogs", args });
      if (state.fail) throw new Error("RPC unavailable");
      return state.logs ?? [];
    },
  };
  return { reader: reader as unknown as EntryPointReader, calls, latest, finalized };
}
