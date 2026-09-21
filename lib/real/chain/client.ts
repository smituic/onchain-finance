import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

/**
 * Only a client factory — balance/history reads are Batch 2c's scope. Pulled
 * forward into 2b only because deriving/persisting a Safe address at
 * registration time needs a real read (the Safe proxy factory's
 * proxyCreationCode()), which createRealSafeAccount (account/safe.ts)
 * already requires a client for.
 */
export function createRealPublicClient(rpcUrl: string) {
  return createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  });
}
