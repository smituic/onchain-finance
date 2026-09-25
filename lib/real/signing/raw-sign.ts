import type { Hex } from "viem";
import { createPasskeyTurnkeyClient } from "./turnkey-client";
import { serializeTurnkeyRawSignature } from "./raw-signature";

export type TurnkeyRawSignResult = {
  signature: Hex;
  /** Turnkey's activity id — Batch 2g's Proof B reads the activity's votes back by this id. Unused by the payment path. */
  activityId: string;
};

/**
 * The one place that actually asks Turnkey to sign a pre-computed 32-byte
 * digest: a fresh WebauthnStamper/TurnkeyClient per call, encoded as
 * PAYLOAD_ENCODING_HEXADECIMAL + HASH_FUNCTION_NO_OP ("sign exactly these
 * bytes, do not hash them again"), signWith passed through case-preserved
 * (Turnkey's resource lookup is case-sensitive). This is the exact request
 * shape poc/turnkey-real-account proved live recovers the canonical owner —
 * unlike @turnkey/viem's own PAYLOAD_ENCODING_EIP712 adapter, which this
 * module never uses (see verified-account.ts).
 */
export async function signDigestViaTurnkeyRaw(input: {
  rpId: string;
  subOrganizationId: string;
  ownerAddress: string;
  digest: Hex;
  /** Batch 2g only: scopes the WebAuthn ceremony to one specific credential — see createRequiredWebauthnStamper's doc comment. The ordinary payment-signing call site never passes this. */
  authorizingCredentialId?: string;
}): Promise<TurnkeyRawSignResult> {
  const client = createPasskeyTurnkeyClient(input.rpId, input.authorizingCredentialId ? { allowCredentialId: input.authorizingCredentialId } : undefined);
  const response = await client.signRawPayload({
    type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
    timestampMs: String(Date.now()),
    organizationId: input.subOrganizationId,
    parameters: {
      signWith: input.ownerAddress,
      payload: input.digest,
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction: "HASH_FUNCTION_NO_OP",
    },
  });

  const result = response.activity.result.signRawPayloadResult;
  if (!result?.r || !result?.s || !result?.v) {
    throw new Error("Turnkey returned a completed activity without a signature.");
  }
  return { signature: serializeTurnkeyRawSignature(result), activityId: response.activity.id };
}
