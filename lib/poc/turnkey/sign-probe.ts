import { hashTypedData, recoverAddress, type Address, type Hex } from "viem";
import { bytesToHex, randomBytes } from "./bytes";
import { createPasskeyTurnkeyClient, createTurnkeyOwnerAccount } from "./account";
import { BASE_SEPOLIA_CHAIN_ID } from "./constants";
import { addressesEqual } from "./identifiers";
import { isWebAuthnCancellation } from "./passkey";
import { signDigestViaTurnkeyRaw } from "./raw-sign";
export { serializeTurnkeyRawSignature } from "./raw-signature";
import { instrumentSignTypedData, type SignTypedDataDiagnostic } from "./signing-diagnostics";
import { createVerifiedTurnkeyOwnerAccount } from "./verified-account";
import { parseWebAuthnFlags } from "./webauthn-flags";

export type SignProbeResult =
  | {
      outcome: "signed";
      activityId: string;
      payloadHash: string;
      signaturePresent: true;
      userVerified: boolean | null;
    }
  | {
      outcome: "cancelled";
      signaturePresent: false;
    };

export async function runHarmlessSignProbe(input: {
  rpId: string;
  subOrganizationId: string;
  ownerAddress: string;
}): Promise<SignProbeResult> {
  const client = createPasskeyTurnkeyClient(input.rpId);
  const payload = bytesToHex(randomBytes(32));

  try {
    const response = await client.signRawPayload({
      type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
      timestampMs: String(Date.now()),
      organizationId: input.subOrganizationId,
      parameters: {
        signWith: input.ownerAddress,
        payload,
        encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
        hashFunction: "HASH_FUNCTION_NO_OP",
      },
    });

    const result = response.activity.result.signRawPayloadResult;
    if (!result?.r || !result?.s) {
      throw new Error("Turnkey returned a completed activity without a signature.");
    }
    return {
      outcome: "signed",
      activityId: response.activity.id,
      payloadHash: payload,
      signaturePresent: true,
      userVerified: null,
    };
  } catch (error) {
    if (isWebAuthnCancellation(error)) {
      return { outcome: "cancelled", signaturePresent: false };
    }
    throw error;
  }
}

export type ReplayProbePrepared = {
  url: string;
  originalBody: string;
  stampHeaderName: string;
  stampHeaderValue: string;
  uvFlags: { userPresent: boolean; userVerified: boolean } | null;
};

export async function prepareSignRawPayloadStamp(input: {
  rpId: string;
  subOrganizationId: string;
  ownerAddress: string;
}): Promise<ReplayProbePrepared> {
  const client = createPasskeyTurnkeyClient(input.rpId);
  const payload = bytesToHex(randomBytes(32));
  const signed = await client.stampSignRawPayload({
    type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
    timestampMs: String(Date.now()),
    organizationId: input.subOrganizationId,
    parameters: {
      signWith: input.ownerAddress,
      payload,
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction: "HASH_FUNCTION_NO_OP",
    },
  });

  let uvFlags = null;
  try {
    const stamp = JSON.parse(signed.stamp.stampHeaderValue) as { authenticatorData?: string };
    if (stamp.authenticatorData) uvFlags = parseWebAuthnFlags(stamp.authenticatorData);
  } catch {
    uvFlags = null;
  }

  return {
    url: signed.url,
    originalBody: signed.body,
    stampHeaderName: signed.stamp.stampHeaderName,
    stampHeaderValue: signed.stamp.stampHeaderValue,
    uvFlags,
  };
}

export function mutateSignRawPayloadBody(originalBody: string): string {
  const parsed = JSON.parse(originalBody) as {
    parameters?: { payload?: string };
  };
  if (!parsed.parameters) parsed.parameters = {};
  parsed.parameters.payload = bytesToHex(randomBytes(32));
  return JSON.stringify(parsed);
}

/**
 * A tiny, fixed, deterministic EIP-712 object with no relationship to
 * Safe/4337 — used to test whether @turnkey/viem's signTypedData adapter
 * (Turnkey's PAYLOAD_ENCODING_EIP712 path) works in isolation, independent
 * of any SafeOp construction. Every field is a literal constant so the
 * digest is identical on every run and directly comparable across probes.
 */
export const EIP712_SIGN_PROBE_TYPED_DATA = {
  domain: {
    name: "OCF Turnkey PoC",
    version: "1",
    chainId: BASE_SEPOLIA_CHAIN_ID,
  },
  types: {
    Probe: [
      { name: "purpose", type: "string" },
      { name: "nonce", type: "uint256" },
    ],
  },
  primaryType: "Probe",
  message: {
    purpose: "turnkey-eip712-sign-probe",
    nonce: BigInt(1),
  },
} as const;

export type Eip712SignProbeResult = {
  expectedOwner: Address;
  digest: Hex;
  signature: Hex;
  signatureByteLength: number;
  vByte: number | null;
  recoveredAddress: Address;
  matches: boolean;
};

/**
 * Isolates @turnkey/viem's own signTypedData adapter path (its
 * PAYLOAD_ENCODING_EIP712 usage): a fresh passkey signs
 * EIP712_SIGN_PROBE_TYPED_DATA (not a SafeOp) through createAccount's
 * unmodified signTypedData, and the result is recovered locally against the
 * exact same object that was signed. Never calls Pimlico or any
 * chain-submission API.
 *
 * KNOWN BROKEN: a live probe recovered the wrong signer from this exact
 * adapter over a digest that signDigestViaTurnkeyRaw recovers correctly for
 * the identical bytes — see runVerifiedEip712SignProbe, which now backs real
 * SafeOp signing. This function is kept only as an optional, manually
 * triggered comparison; it is not part of the normal verification flow.
 */
export async function runEip712SignProbe(input: {
  rpId: string;
  subOrganizationId: string;
  ownerAddress: string;
}): Promise<Eip712SignProbeResult> {
  const owner = await createTurnkeyOwnerAccount({
    rpId: input.rpId,
    subOrganizationId: input.subOrganizationId,
    ownerAddress: input.ownerAddress,
  });

  let captured: SignTypedDataDiagnostic | null = null;
  const instrumented = instrumentSignTypedData(owner, (diagnostic) => {
    captured = diagnostic;
  });
  const signature = await instrumented.signTypedData(EIP712_SIGN_PROBE_TYPED_DATA);
  if (!captured) throw new Error("EIP-712 sign probe did not capture a signing diagnostic.");
  const diagnostic: SignTypedDataDiagnostic = captured;

  return {
    expectedOwner: input.ownerAddress as Address,
    digest: diagnostic.preSignDigest,
    signature,
    signatureByteLength: diagnostic.signatureByteLength,
    vByte: diagnostic.vByte,
    recoveredAddress: diagnostic.recoveredAddress as Address,
    matches: diagnostic.matches,
  };
}

/**
 * Exercises the FIXED signing path — createVerifiedTurnkeyOwnerAccount's
 * custom signTypedData (local hash -> signDigestViaTurnkeyRaw -> local
 * recovery check) — over the same fixed EIP712_SIGN_PROBE_TYPED_DATA object,
 * so it's directly comparable to runEip712SignProbe's result. This is the
 * one real SafeOp payments now route through. Never calls Pimlico or any
 * chain-submission API.
 */
export async function runVerifiedEip712SignProbe(input: {
  rpId: string;
  subOrganizationId: string;
  ownerAddress: string;
}): Promise<Eip712SignProbeResult> {
  const owner = await createVerifiedTurnkeyOwnerAccount({
    rpId: input.rpId,
    subOrganizationId: input.subOrganizationId,
    ownerAddress: input.ownerAddress,
  });

  let captured: SignTypedDataDiagnostic | null = null;
  const instrumented = instrumentSignTypedData(owner, (diagnostic) => {
    captured = diagnostic;
  });
  const signature = await instrumented.signTypedData(EIP712_SIGN_PROBE_TYPED_DATA);
  if (!captured) throw new Error("Verified EIP-712 sign probe did not capture a signing diagnostic.");
  const diagnostic: SignTypedDataDiagnostic = captured;

  return {
    expectedOwner: input.ownerAddress as Address,
    digest: diagnostic.preSignDigest,
    signature,
    signatureByteLength: diagnostic.signatureByteLength,
    vByte: diagnostic.vByte,
    recoveredAddress: diagnostic.recoveredAddress as Address,
    matches: diagnostic.matches,
  };
}

export type RawDigestSignProbeResult = {
  expectedOwner: Address;
  digest: Hex;
  signature: Hex;
  recoveredAddress: Address;
  matches: boolean;
};

/**
 * Signs the SAME fixed EIP-712 object's locally-computed digest via
 * signDigestViaTurnkeyRaw — Turnkey's low-level signRawPayload with
 * HASH_FUNCTION_NO_OP ("sign exactly these 32 bytes, do not hash them
 * again"), the same primitive createVerifiedTurnkeyOwnerAccount's
 * signTypedData now uses for real SafeOp signing. This bypasses
 * @turnkey/viem's PAYLOAD_ENCODING_EIP712 adapter entirely, so comparing its
 * result against runEip712SignProbe's isolates whether that adapter
 * specifically is where a digest mismatch is introduced. Never calls
 * Pimlico or any chain-submission API.
 */
export async function runRawDigestSignProbe(input: {
  rpId: string;
  subOrganizationId: string;
  ownerAddress: string;
}): Promise<RawDigestSignProbeResult> {
  const digest = hashTypedData(EIP712_SIGN_PROBE_TYPED_DATA);
  const { signature } = await signDigestViaTurnkeyRaw({
    rpId: input.rpId,
    subOrganizationId: input.subOrganizationId,
    ownerAddress: input.ownerAddress,
    digest,
  });
  const recoveredAddress = await recoverAddress({ hash: digest, signature });

  return {
    expectedOwner: input.ownerAddress as Address,
    digest,
    signature,
    recoveredAddress,
    matches: addressesEqual(recoveredAddress, input.ownerAddress),
  };
}
