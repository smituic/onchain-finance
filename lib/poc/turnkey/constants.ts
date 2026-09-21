import type { Address, Hex } from "viem";
import { entryPoint07Address } from "viem/account-abstraction";

/** Isolated Turnkey PoC — not product configuration. */

export const TURNKEY_API_BASE_URL = "https://api.turnkey.com";

export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_SEPOLIA_PUBLIC_RPC_URL = "https://sepolia.base.org";

/** Circle-issued testnet USDC on Base Sepolia. Consumer label: Cash. */
export const CASH_USDC = {
  address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address,
  decimals: 6,
  consumerLabel: "Cash",
  diagnosticLabel: "Cash (USDC)",
} as const;

export const GATE2_PAYMENT_USDC = "0.10";

/**
 * permissionless@0.3.7 maps Safe 1.4.1 + EntryPoint 0.7 to this module.
 * That deployment is Safe4337Module 0.3.0.
 */
export const SAFE_POC = {
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

export const ETHEREUM_WALLET_ACCOUNT = {
  curve: "CURVE_SECP256K1" as const,
  pathFormat: "PATH_FORMAT_BIP32" as const,
  path: "m/44'/60'/0'/0/0",
  addressFormat: "ADDRESS_FORMAT_ETHEREUM" as const,
};

export const PUBLIC_ACCOUNT_STORAGE_KEY = "onchain-finance:turnkey-poc:public-account";
export const PENDING_OPERATION_STORAGE_KEY = "onchain-finance:turnkey-poc:pending-operation";
export const OPERATION_HISTORY_STORAGE_KEY = "onchain-finance:turnkey-poc:operation-history";
export const STORAGE_AUDIT_STORAGE_KEY = "onchain-finance:turnkey-poc:storage-audit";

export const SESSION_COOKIE_NAME = "ocf_turnkey_poc_session";

export const PIMLICO_ALLOWED_METHODS = [
  "eth_chainId",
  "eth_supportedEntryPoints",
  "eth_estimateUserOperationGas",
  "eth_sendUserOperation",
  "eth_getUserOperationByHash",
  "eth_getUserOperationReceipt",
  "pm_sponsorUserOperation",
  "pm_getPaymasterStubData",
  "pm_getPaymasterData",
  "pm_validateSponsorshipPolicies",
  "pimlico_getUserOperationGasPrice",
  "pimlico_getUserOperationStatus",
] as const;

export const EXECUTED_SIGNING_PATH = [
  "@turnkey/webauthn-stamper WebauthnStamper(userVerification: required)",
  "@turnkey/http TurnkeyClient",
  "@turnkey/viem createAccount(TurnkeyClient + owner address)",
  "permissionless toSafeSmartAccount(Safe 1.4.1, EntryPoint 0.7, threshold 1)",
] as const;

export const FORBIDDEN_EXECUTED_PATH = [
  "IndexedDB stamper",
  "browser session key / IndexedDbStamper",
  "Turnkey persistent read/write session",
  "stampLogin / createReadWriteSession / OTP/OAuth signing session",
  "Clerk",
] as const;

export type HexAddress = Address;
export type HexHash = Hex;
