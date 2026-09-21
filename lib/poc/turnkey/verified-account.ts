import { hashTypedData, recoverTypedDataAddress, type Address, type Hex, type LocalAccount, type TypedDataDefinition } from "viem";
import { createTurnkeyOwnerAccount } from "./account";
import { addressesEqual } from "./identifiers";
import { signDigestViaTurnkeyRaw } from "./raw-sign";

export type VerifiedSignTypedDataFailure = {
  expectedOwner: Address;
  recoveredAddress: Address;
  digest: Hex;
  signature: Hex;
};

/**
 * Thrown by createVerifiedTurnkeyOwnerAccount's signTypedData instead of
 * ever returning a signature that doesn't recover to the canonical owner —
 * this is exactly the failure mode live probes isolated to @turnkey/viem's
 * own EIP-712 adapter (a raw signRawPayload call over the identical digest
 * recovered correctly; the adapter did not).
 */
export class VerifiedSignTypedDataError extends Error {
  readonly expectedOwner: Address;
  readonly recoveredAddress: Address;
  readonly digest: Hex;
  readonly signature: Hex;

  constructor(failure: VerifiedSignTypedDataFailure) {
    super(`Turnkey-signed EIP-712 signature recovered ${failure.recoveredAddress}, expected owner ${failure.expectedOwner}.`);
    this.name = "VerifiedSignTypedDataError";
    this.expectedOwner = failure.expectedOwner;
    this.recoveredAddress = failure.recoveredAddress;
    this.digest = failure.digest;
    this.signature = failure.signature;
  }
}

/**
 * A Turnkey-backed LocalAccount whose signTypedData bypasses @turnkey/viem's
 * PAYLOAD_ENCODING_EIP712 adapter entirely: the exact typed-data object is
 * hashed locally with viem's own hashTypedData, that 32-byte digest is
 * signed via Turnkey's low-level signRawPayload + HASH_FUNCTION_NO_OP (see
 * raw-sign.ts — the same mechanism Gate 1's harmless-sign-probe and the
 * raw-digest sign probe already prove correct), and the result is verified
 * locally with recoverTypedDataAddress against the ORIGINAL typed-data
 * object before ever being returned. A mismatch throws instead of returning
 * a bad signature.
 *
 * This is check "A" (self-verifying signTypedData). The independent SafeOp
 * preflight in safe-op-preflight.ts (check "B") still runs unchanged after
 * this, over the fully-packed Safe signature — defense in depth, not a
 * replacement.
 *
 * .address/.signMessage/.sign are unmodified, reused as-is from
 * @turnkey/viem's createAccount via createTurnkeyOwnerAccount — only
 * signTypedData is overridden, so @turnkey/viem stays a dependency for
 * everything except the one adapter path proven broken.
 */
export async function createVerifiedTurnkeyOwnerAccount(input: {
  rpId: string;
  subOrganizationId: string;
  ownerAddress: string;
}): Promise<LocalAccount> {
  const base = await createTurnkeyOwnerAccount(input);

  return {
    ...base,
    async signTypedData(typedData) {
      const definition = typedData as TypedDataDefinition;
      const digest = hashTypedData(definition);

      const { signature } = await signDigestViaTurnkeyRaw({
        rpId: input.rpId,
        subOrganizationId: input.subOrganizationId,
        ownerAddress: input.ownerAddress,
        digest,
      });

      const recoveredAddress = await recoverTypedDataAddress({ ...definition, signature });
      if (!addressesEqual(recoveredAddress, input.ownerAddress)) {
        throw new VerifiedSignTypedDataError({
          expectedOwner: input.ownerAddress as Address,
          recoveredAddress,
          digest,
          signature,
        });
      }
      return signature;
    },
  };
}
