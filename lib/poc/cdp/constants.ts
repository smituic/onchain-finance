/**
 * Fixed facts for the CDP proof-of-concept (branch poc/cdp-real-account).
 * Disposable diagnostic code — nothing under lib/poc/** is product
 * architecture; verified pieces move to lib/real/** later, the rest is deleted.
 *
 * Every value is testnet-only. There is deliberately no mainnet entry.
 */

/** Base Sepolia, the only network this PoC talks to. */
export const BASE_SEPOLIA_CHAIN_ID = 84532;

/** CDP's network identifier for Base Sepolia (matches `EvmUserOperationNetwork`). */
export const CDP_NETWORK = "base-sepolia" as const;

/**
 * Circle-issued testnet USDC on Base Sepolia. The product calls this "Cash";
 * the diagnostic layer always says USDC as well so the two are never confused.
 */
export const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
export const USDC_DECIMALS = 6;
export const USDC_SYMBOL = "USDC";
export const CONSUMER_LABEL = "Cash";

/** Where to get test USDC. Select "Base Sepolia" on the page. */
export const CIRCLE_FAUCET_URL = "https://faucet.circle.com/";

/** Block explorer for evidence links. */
export const BASE_SEPOLIA_EXPLORER_URL = "https://sepolia.basescan.org";

export function explorerAddressUrl(address: string): string {
  return `${BASE_SEPOLIA_EXPLORER_URL}/address/${address}`;
}

export function explorerTxUrl(hash: string): string {
  return `${BASE_SEPOLIA_EXPLORER_URL}/tx/${hash}`;
}
