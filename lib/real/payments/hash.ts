import type { Hex } from "viem";
import { getUserOperationHash } from "viem/account-abstraction";
import { BASE_SEPOLIA_CHAIN_ID, REAL_SAFE } from "../constants";
import type { PreparedUserOperationFields } from "./prepared-operation";

/**
 * The one place the ERC-4337 UserOperation hash is computed — a pure,
 * deterministic function of the prepared fields, EntryPoint 0.7, and Base
 * Sepolia's chain id. Backed by viem's own `getUserOperationHash`
 * (`viem/account-abstraction`), confirmed present in the installed
 * viem@2.56.8 by reading its source before writing this wrapper, not
 * guessed. The signature field is NOT part of this hash (ERC-4337 excludes
 * it, since it's the thing being signed over) — the hash is therefore fully
 * computable at prepare time, before any signing happens.
 *
 * Called from `prepare` (persisted durably before eth_sendUserOperation is
 * ever dispatched, so a lost send response still leaves a reconciliation
 * key) and again from `submit` (recomputed from the same stored fields as a
 * consistency check before signing is trusted) — one function, two call
 * sites, never two implementations to drift apart.
 */
export function computeExpectedUserOperationHash(fields: PreparedUserOperationFields): Hex {
  return getUserOperationHash({
    chainId: BASE_SEPOLIA_CHAIN_ID,
    entryPointAddress: REAL_SAFE.entryPoint.address,
    entryPointVersion: REAL_SAFE.entryPoint.version,
    userOperation: {
      sender: fields.sender,
      nonce: fields.nonce,
      factory: fields.factory,
      factoryData: fields.factoryData,
      callData: fields.callData,
      callGasLimit: fields.callGasLimit,
      verificationGasLimit: fields.verificationGasLimit,
      preVerificationGas: fields.preVerificationGas,
      maxFeePerGas: fields.maxFeePerGas,
      maxPriorityFeePerGas: fields.maxPriorityFeePerGas,
      paymaster: fields.paymaster,
      paymasterData: fields.paymasterData,
      paymasterVerificationGasLimit: fields.paymasterVerificationGasLimit,
      paymasterPostOpGasLimit: fields.paymasterPostOpGasLimit,
      // Not part of the hash (see the doc comment above) — a placeholder is
      // required only to satisfy UserOperation's type shape.
      signature: "0x",
    },
  });
}
