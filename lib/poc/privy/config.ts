/**
 * Privy PoC — configuration and fixed constants.
 *
 * DISPOSABLE. This module belongs to the Phase 2 infrastructure evaluation on
 * the `poc/privy-real-account` branch and is not part of the product. Nothing
 * under lib/poc/** may be imported by production code.
 *
 * Everything here is PUBLIC configuration (safe to inline into the browser
 * bundle). No secret ever belongs in this module: the Privy app ID and client
 * ID are public identifiers, and the sponsorship path used by this PoC
 * (Privy's native gas sponsorship) needs no paymaster/bundler key on the
 * client at all.
 */

/** Base Sepolia — the only network Real Mode targets in Phase 2. */
export const BASE_SEPOLIA_CHAIN_ID = 84532 as const;

/** Circle-issued testnet USDC on Base Sepolia. Presented to consumers as "Cash". */
export const BASE_SEPOLIA_USDC_ADDRESS =
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
export const USDC_DECIMALS = 6 as const;

/** Where a human can get test USDC for the account address. */
export const CIRCLE_FAUCET_URL = "https://faucet.circle.com/";
export const BASE_SEPOLIA_EXPLORER_URL = "https://sepolia.basescan.org";

/**
 * Public Base Sepolia RPC used for chain reads when no override is set.
 * Reads only: balances, code, receipts. Sends never go through this URL —
 * they go through Privy's wallet RPC with `sponsor: true`.
 */
export const DEFAULT_BASE_SEPOLIA_RPC_URL = "https://sepolia.base.org";

/**
 * localStorage key for the PoC's own pending-send record. Holds PUBLIC chain
 * data only (recipient, amount, hash, timestamps, status) so a payment that
 * was in flight when the page reloaded can be reconciled from the chain
 * without re-sending. Never holds a credential.
 */
export const PENDING_SEND_STORAGE_KEY = "onchain-finance:poc:privy:pending-send";

export type PrivyPocEnv = {
  NEXT_PUBLIC_PRIVY_POC_ENABLED?: string;
  NEXT_PUBLIC_PRIVY_APP_ID?: string;
  NEXT_PUBLIC_PRIVY_CLIENT_ID?: string;
  NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL?: string;
};

export type PrivyPocConfig = {
  enabled: boolean;
  appId: string;
  /** Optional Privy "app client" ID (per-origin allowed-origins/cookie domain). */
  clientId: string | undefined;
  rpcUrl: string;
};

export type ConfigValidation =
  | { ok: true; config: PrivyPocConfig }
  | { ok: false; enabled: boolean; errors: string[] };

/**
 * `@privy-io/react-auth@3.44.0` throws at mount unless the app ID is a string
 * of exactly 25 characters ("Cannot initialize the Privy provider with an
 * invalid Privy app ID"). Mirror that here so a bad value fails at config
 * validation instead of inside the vendor SDK.
 */
const APP_ID_PATTERN = /^[a-z0-9]{25}$/i;

export function isPocEnabled(env: PrivyPocEnv): boolean {
  return env.NEXT_PUBLIC_PRIVY_POC_ENABLED === "true";
}

/**
 * Pure validation of the public environment. Fails closed: the route is
 * disabled unless the flag is exactly `"true"`, and a missing/malformed app ID
 * is an error rather than a silent fallback.
 */
export function validatePrivyPocConfig(env: PrivyPocEnv): ConfigValidation {
  const enabled = isPocEnabled(env);
  const errors: string[] = [];

  const appId = env.NEXT_PUBLIC_PRIVY_APP_ID?.trim() ?? "";
  if (appId.length === 0) {
    errors.push("NEXT_PUBLIC_PRIVY_APP_ID is not set.");
  } else if (!APP_ID_PATTERN.test(appId)) {
    errors.push("NEXT_PUBLIC_PRIVY_APP_ID does not look like a Privy app ID.");
  }

  const clientIdRaw = env.NEXT_PUBLIC_PRIVY_CLIENT_ID?.trim();
  const clientId = clientIdRaw && clientIdRaw.length > 0 ? clientIdRaw : undefined;

  const rpcRaw = env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL?.trim();
  const rpcUrl = rpcRaw && rpcRaw.length > 0 ? rpcRaw : DEFAULT_BASE_SEPOLIA_RPC_URL;
  if (!/^https:\/\//.test(rpcUrl)) {
    errors.push("NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL must be an https:// URL.");
  }

  if (errors.length > 0) return { ok: false, enabled, errors };
  return { ok: true, config: { enabled, appId, clientId, rpcUrl } };
}

/**
 * Reads the PoC env from `process.env`. Each key is written out literally so
 * Next.js can inline it into the client bundle at build time.
 */
export function readPrivyPocEnv(): PrivyPocEnv {
  return {
    NEXT_PUBLIC_PRIVY_POC_ENABLED: process.env.NEXT_PUBLIC_PRIVY_POC_ENABLED,
    NEXT_PUBLIC_PRIVY_APP_ID: process.env.NEXT_PUBLIC_PRIVY_APP_ID,
    NEXT_PUBLIC_PRIVY_CLIENT_ID: process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID,
    NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL: process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL,
  };
}
