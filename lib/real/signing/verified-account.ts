import { hashTypedData, recoverTypedDataAddress, type Address, type Hex, type LocalAccount, type TypedDataDefinition } from "viem";
import { toAccount } from "viem/accounts";
import { addressesEqual } from "../identifiers";
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
 * this is exactly the failure mode poc/turnkey-real-account isolated live to
 * @turnkey/viem's own EIP-712 adapter (a raw signRawPayload call over the
 * identical digest recovered correctly; the adapter did not — see
 * TURNKEY_POC_AUDIT.md).
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

function unsupported(method: string): () => Promise<never> {
  return async () => {
    throw new Error(`${method}() is not supported by this account — real SafeOp signing goes through signTypedData only.`);
  };
}

/**
 * A Turnkey-backed LocalAccount whose signTypedData bypasses @turnkey/viem's
 * PAYLOAD_ENCODING_EIP712 adapter entirely: the exact typed-data object is
 * hashed locally with viem's own hashTypedData, that 32-byte digest is
 * signed via Turnkey's low-level signRawPayload + HASH_FUNCTION_NO_OP (see
 * raw-sign.ts — the mechanism proven correct live), and the result is
 * verified locally with recoverTypedDataAddress against the ORIGINAL
 * typed-data object before ever being returned. A mismatch throws instead
 * of returning a bad signature.
 *
 * This is check "A" (self-verifying signTypedData). The independent SafeOp
 * preflight (payments/safe-op-preflight.ts, check "B") still runs after
 * this, over the fully-packed Safe signature — defense in depth, not a
 * replacement.
 *
 * Built directly on plain viem's toAccount() rather than @turnkey/viem's
 * createAccount(): permissionless@0.3.7's signUserOperation only ever calls
 * .address and .signTypedData() on a LocalAccount owner (verified against
 * the installed package source before this decision — see
 * ARCHITECTURE.md's Phase 2 decisions). @turnkey/viem is therefore not a
 * dependency of this module at all, which means the one adapter it ships
 * that's proven to recover the wrong signer is not merely unused by
 * convention — it is not reachable code, because the package isn't
 * installed.
 *
 * sign/signMessage/signTransaction/signAuthorization intentionally throw:
 * nothing in the proven signing path calls them, and a silent (and
 * unverified) implementation of any of them would be worse than a loud
 * failure if something upstream ever starts calling one.
 */
export function createVerifiedTurnkeyOwnerAccount(input: {
  rpId: string;
  subOrganizationId: string;
  ownerAddress: string;
}): LocalAccount {
  return toAccount({
    address: input.ownerAddress as Address,
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
    sign: unsupported("sign"),
    signMessage: unsupported("signMessage"),
    signTransaction: unsupported("signTransaction"),
    signAuthorization: unsupported("signAuthorization"),
  });
}
