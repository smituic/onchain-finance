import type { Address } from "viem";
import { entryPoint07Address } from "viem/account-abstraction";

export const TURNKEY_API_BASE_URL = "https://api.turnkey.com";

export const BASE_SEPOLIA_CHAIN_ID = 84532;

/**
 * permissionless@0.3.7 maps Safe 1.4.1 + EntryPoint 0.7 to this module. That
 * deployment is Safe4337Module 0.3.0. This exact configuration is what
 * poc/turnkey-real-account live-proved on Base Sepolia (see
 * TURNKEY_POC_AUDIT.md) — not a candidate, a verified fact.
 */
export const REAL_SAFE = {
  version: "1.4.1" as const,
  threshold: 1,
  saltNonce: "0",
  useMultiSendForSetup: true,
  entryPoint: {
    address: entryPoint07Address as Address,
    version: "0.7" as const,
  },
  module: {
    name: "Safe4337Module",
    version: "0.3.0",
    address: "0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226" as Address,
  },
  moduleSetupAddress: "0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47" as Address,
  proxyFactoryAddress: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67" as Address,
  singletonAddress: "0x41675C099F32341bf84BFc5382aF534df5C7461a" as Address,
} as const;

/**
 * Bumped whenever REAL_SAFE (or the wallet derivation path below) changes in
 * a way that would make an existing registry record's derived safeAddress
 * stale. Stored on every RealAccountRecord (registry.ts) so a future config
 * change is a detectable mismatch, not a silent one.
 */
export const REAL_ACCOUNT_CONFIG_VERSION = 1;

/** The one Ethereum wallet account every real account provisions — see server/turnkey-provisioning.ts. */
export const REAL_WALLET_ACCOUNT = {
  curve: "CURVE_SECP256K1" as const,
  pathFormat: "PATH_FORMAT_BIP32" as const,
  path: "m/44'/60'/0'/0/0",
  addressFormat: "ADDRESS_FORMAT_ETHEREUM" as const,
};

export const REAL_SESSION_COOKIE_NAME = "ocf_real_session";

/**
 * Circle-issued testnet USDC on Base Sepolia — the asset behind consumer-
 * facing "Cash" in Real Mode (see lib/real/display/cash.ts for the
 * domain->presentation rename; this constant stays USDC/decimals truth).
 * Address confirmed against Circle's published testnet contract addresses
 * (developers.circle.com/stablecoins/usdc-contract-addresses) as of Batch
 * 2c — not a candidate, a verified fact, same footing as REAL_SAFE above.
 */
export const REAL_CASH_TOKEN = {
  symbol: "USDC" as const,
  address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address,
  decimals: 6,
} as const;
