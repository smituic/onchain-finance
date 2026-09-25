import { toSafeSmartAccount } from "permissionless/accounts";
import { toAccount } from "viem/accounts";
import { type Address, type LocalAccount } from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import { REAL_SAFE } from "../constants";

/** Whatever client type toSafeSmartAccount itself actually expects — derived rather than hand-declared, so a chain-specific client (e.g. Base Sepolia's OP-stack formatters) built from this module's own "viem" import can never structurally diverge from permissionless's own resolved "viem" types. */
export type SafeAccountPublicClient = Parameters<typeof toSafeSmartAccount>[0]["client"];

/**
 * Derives the Safe smart account for a given owner: a deterministic (CREATE2)
 * computation from ownerAddress plus these fixed Safe/module/saltNonce
 * constants. There is nothing else to "restore" about the Safe itself once
 * the owner is known — recovering account access means recovering the
 * ability to sign as ownerAddress (see signing/verified-account.ts), not
 * recovering the Safe address, which always re-derives to the same value.
 *
 * publicClient is passed in rather than constructed here — chain/RPC wiring
 * belongs to a later batch; tests supply an in-process transport instead of
 * a live RPC (see the signing chain test).
 */
export async function createRealSafeAccount(input: {
  owner: LocalAccount;
  publicClient: SafeAccountPublicClient;
  /** The SafeOp validity this account signs with (packed into the signature and part of the signed EIP-712 message). Omitted only where nothing is signed — address derivation, server-side prepare. Never affects the Safe address. */
  validity?: { validAfter: number; validUntil: number };
}) {
  return toSafeSmartAccount({
    validAfter: input.validity?.validAfter,
    validUntil: input.validity?.validUntil,
    client: input.publicClient,
    owners: [input.owner],
    version: REAL_SAFE.version,
    entryPoint: {
      address: entryPoint07Address,
      version: REAL_SAFE.entryPoint.version,
    },
    saltNonce: BigInt(REAL_SAFE.saltNonce),
    threshold: BigInt(REAL_SAFE.threshold),
    safe4337ModuleAddress: REAL_SAFE.module.address,
    safeModuleSetupAddress: REAL_SAFE.moduleSetupAddress,
    safeProxyFactoryAddress: REAL_SAFE.proxyFactoryAddress,
    safeSingletonAddress: REAL_SAFE.singletonAddress,
    useMultiSendForSetup: REAL_SAFE.useMultiSendForSetup,
  });
}

function unsupportedReadOnly(method: string): () => Promise<never> {
  return async () => {
    throw new Error(`${method}() is not supported by this read-only owner account — it exists only so the server can call prepareUserOperation without ever holding signing authority.`);
  };
}

/**
 * A read-only stand-in for the Safe's owner, used ONLY for server-side
 * prepareUserOperation (deriving nonce/factory/factoryData/gas/paymaster
 * fields) — never for signing. Every signing method throws, so if this is
 * ever mis-wired into a submit path it fails loudly instead of silently
 * forging (or attempting to forge) a signature. The server never holds the
 * owner's private key material at all; real signing happens client-side via
 * signing/verified-account.ts's createVerifiedTurnkeyOwnerAccount, driven by
 * a fresh WebAuthn ceremony.
 */
export function createReadOnlyOwnerAccount(ownerAddress: Address): LocalAccount {
  return toAccount({
    address: ownerAddress,
    sign: unsupportedReadOnly("sign"),
    signMessage: unsupportedReadOnly("signMessage"),
    signTransaction: unsupportedReadOnly("signTransaction"),
    signTypedData: unsupportedReadOnly("signTypedData"),
    signAuthorization: unsupportedReadOnly("signAuthorization"),
  });
}
