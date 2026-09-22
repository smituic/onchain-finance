import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";

/**
 * Thin wrapper over @simplewebauthn/browser, kept instead of hand-rolling
 * navigator.credentials.create/get()'s ArrayBuffer<->base64url conversion:
 * startRegistration/startAuthentication produce exactly the
 * RegistrationResponseJSON/AuthenticationResponseJSON shapes
 * @simplewebauthn/server's verify functions expect, so the wire format
 * between browser and server is never hand-serialized on either side.
 */
export async function performRegistrationCeremony(
  optionsJSON: PublicKeyCredentialCreationOptionsJSON,
): Promise<RegistrationResponseJSON> {
  return startRegistration({ optionsJSON });
}

export async function performLoginCeremony(
  optionsJSON: PublicKeyCredentialRequestOptionsJSON,
): Promise<AuthenticationResponseJSON> {
  return startAuthentication({ optionsJSON });
}

export function isWebAuthnCancellation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String((error as { name: unknown }).name) : "";
  return name === "NotAllowedError" || name === "AbortError";
}
