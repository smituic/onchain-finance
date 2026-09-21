import { WebauthnStamper } from "@turnkey/webauthn-stamper";
import { bytesToBase64Url, bytesToHex, randomBytes } from "./bytes";
import { readPublicTurnkeyPocConfig } from "./config";

export const REQUIRED_USER_VERIFICATION = "required" as const;

type TurnkeyAttestation = {
  credentialId: string;
  clientDataJson: string;
  attestationObject: string;
  transports: Array<
    | "AUTHENTICATOR_TRANSPORT_BLE"
    | "AUTHENTICATOR_TRANSPORT_INTERNAL"
    | "AUTHENTICATOR_TRANSPORT_NFC"
    | "AUTHENTICATOR_TRANSPORT_USB"
    | "AUTHENTICATOR_TRANSPORT_HYBRID"
  >;
};

export type PasskeyRegistration = {
  /**
   * Base64url (no padding) encoding of the exact challenge bytes passed to
   * navigator.credentials.create. This must be byte-for-byte what the
   * authenticator embedded in clientDataJSON.challenge, or Turnkey rejects
   * the attestation with "ChallengeMismatch". Do not hex-encode this value —
   * Turnkey's own SDK (createWebPasskey) produces this exact base64url form.
   */
  challengeBase64Url: string;
  attestation: TurnkeyAttestation;
  rpId: string;
  userVerification: typeof REQUIRED_USER_VERIFICATION;
};

function toTurnkeyTransport(
  transport: string,
): TurnkeyAttestation["transports"][number] {
  switch (transport) {
    case "ble":
      return "AUTHENTICATOR_TRANSPORT_BLE";
    case "nfc":
      return "AUTHENTICATOR_TRANSPORT_NFC";
    case "usb":
      return "AUTHENTICATOR_TRANSPORT_USB";
    case "hybrid":
      return "AUTHENTICATOR_TRANSPORT_HYBRID";
    default:
      return "AUTHENTICATOR_TRANSPORT_INTERNAL";
  }
}

/**
 * Direct WebAuthn create. Turnkey's getWebAuthnAttestation maps
 * response.transports with .map() and throws when the browser omits it.
 */
export async function registerPasskey(): Promise<PasskeyRegistration> {
  if (!window.PublicKeyCredential) {
    throw new Error("WebAuthn is not supported in this browser.");
  }

  const { rpId, rpName } = readPublicTurnkeyPocConfig();
  const challenge = randomBytes(32);
  const userId = randomBytes(32);

  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { id: rpId, name: rpName },
      user: {
        id: userId as BufferSource,
        name: `turnkey-poc-${bytesToHex(userId).slice(0, 8)}`,
        displayName: "Turnkey PoC user",
      },
      challenge: challenge as BufferSource,
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      timeout: 300000,
      attestation: "none",
      authenticatorSelection: {
        residentKey: "preferred",
        requireResidentKey: false,
        userVerification: REQUIRED_USER_VERIFICATION,
      },
    },
  })) as PublicKeyCredential | null;

  if (!credential) throw new Error("Passkey registration was cancelled.");

  const response = credential.response as AuthenticatorAttestationResponse;
  const transports = (response.getTransports?.() ?? ["internal"]).map(toTurnkeyTransport);

  return {
    challengeBase64Url: bytesToBase64Url(challenge),
    attestation: {
      credentialId: bytesToBase64Url(new Uint8Array(credential.rawId)),
      clientDataJson: bytesToBase64Url(new Uint8Array(response.clientDataJSON)),
      attestationObject: bytesToBase64Url(new Uint8Array(response.attestationObject)),
      transports,
    },
    rpId,
    userVerification: REQUIRED_USER_VERIFICATION,
  };
}

export function createRequiredWebauthnStamper(rpId: string): WebauthnStamper {
  return new WebauthnStamper({
    rpId,
    userVerification: REQUIRED_USER_VERIFICATION,
    timeout: 300000,
  });
}

export function isWebAuthnCancellation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  return name === "NotAllowedError" || name === "AbortError";
}
