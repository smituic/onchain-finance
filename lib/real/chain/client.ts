import { createPublicClient, http, type PublicClient, type Transport } from "viem";
import { baseSepolia } from "viem/chains";

/**
 * A client factory — used both for deriving/persisting a Safe address at
 * registration time (account/safe.ts's proxyCreationCode() read) and for
 * Batch 2c's balance reads (chain/balance.ts).
 */
export function createRealPublicClient(rpcUrl: string) {
  return createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  });
}

/**
 * Chain-pinned (typeof baseSepolia) so chain-dependent return shapes (e.g.
 * getBlock()) can't structurally diverge from a bare, chain-less viem
 * PublicClient — but transport-generic (base Transport, not the specific
 * HttpTransport createRealPublicClient happens to use), so tests can supply
 * an in-process `custom(...)` transport client instead of a live RPC.
 */
export type RealPublicClient = PublicClient<Transport, typeof baseSepolia>;
