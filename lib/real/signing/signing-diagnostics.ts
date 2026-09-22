import { hashTypedData, recoverTypedDataAddress, type Hex, type LocalAccount, type TypedDataDefinition } from "viem";
import { addressesEqual } from "../identifiers";

export type SignTypedDataDiagnostic = {
  expectedOwner: string;
  preSignDigest: Hex;
  signature: Hex;
  signatureByteLength: number;
  vByte: number | null;
  recoveredAddress: string;
  matches: boolean;
};

/**
 * Wraps a LocalAccount so every signTypedData call is instrumented: the
 * EXACT typed-data object passed in is hashed locally with viem's own
 * hashTypedData BEFORE signing, and the returned signature is recovered
 * against that SAME object (not a separately reconstructed one) immediately
 * after — this is what distinguishes "the digest we actually asked the
 * signer to sign" from any other reconstruction of it elsewhere.
 *
 * Diagnostic only: it changes no signing behavior (delegates to the real
 * account's signTypedData unmodified), adds no persisted state or signing
 * authority.
 */
export function instrumentSignTypedData(owner: LocalAccount, onDiagnostic: (diagnostic: SignTypedDataDiagnostic) => void): LocalAccount {
  return {
    ...owner,
    async signTypedData(typedData) {
      const definition = typedData as TypedDataDefinition;
      const preSignDigest = hashTypedData(definition);
      const signature = await owner.signTypedData(typedData);
      const byteLength = (signature.length - 2) / 2;
      const vByte = byteLength > 0 ? Number.parseInt(signature.slice(-2), 16) : null;
      const recoveredAddress = await recoverTypedDataAddress({ ...definition, signature });
      onDiagnostic({
        expectedOwner: owner.address,
        preSignDigest,
        signature,
        signatureByteLength: byteLength,
        vByte,
        recoveredAddress,
        matches: addressesEqual(recoveredAddress, owner.address),
      });
      return signature;
    },
  };
}
