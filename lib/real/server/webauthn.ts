import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
import type { RealServerConfig } from "./config";

/**
 * APP AUTHENTICATION only — independent of Turnkey. This module never talks
 * to Turnkey and Turnkey never talks to this module; the two verification
 * paths are deliberately kept apart (see registration.ts / login.ts, which
 * compose this with the registry and, for registration only, Turnkey
 * provisioning of the SAME already-verified credential).
 */

export async function buildRegistrationOptions(input: {
  config: RealServerConfig;
  userId: Uint8Array<ArrayBuffer>;
  userName: string;
  userDisplayName?: string;
  excludeCredentialIds?: string[];
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
  // No explicit `challenge`: generateRegistrationOptions generates its own
  // random bytes and base64url-encodes them directly. Passing a `string`
  // here instead — even one that already looks base64url — gets UTF-8
  // byte-encoded and THEN base64url-encoded (see
  // generateRegistrationOptions.js: `isoUint8Array.fromUTF8String` for any
  // string challenge), which silently produces a different value than the
  // string itself. Callers must capture optionsJSON.challenge (the value
  // actually generated) as the one to persist/compare against — never
  // pre-mint a challenge string and pass it in as `challenge`.
  return generateRegistrationOptions({
    rpName: input.config.rpName,
    rpID: input.config.rpId,
    userName: input.userName,
    userID: input.userId,
    userDisplayName: input.userDisplayName ?? input.userName,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    },
    excludeCredentials: (input.excludeCredentialIds ?? []).map((id) => ({ id })),
  });
}

export async function verifyRegistration(input: {
  config: RealServerConfig;
  response: RegistrationResponseJSON;
  expectedChallenge: string;
}): Promise<VerifiedRegistrationResponse> {
  return verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: input.config.expectedOrigins,
    expectedRPID: input.config.rpId,
    requireUserVerification: true,
  });
}

export async function buildLoginOptions(input: {
  config: RealServerConfig;
  /**
   * Batch 2g only: scopes the ceremony to specific credential id(s) instead
   * of the ordinary discoverable-credential restore flow. Used exclusively
   * by the backup-passkey verification step (proof "A" of
   * backup-passkey-pipeline.ts) to prove a SPECIFIC newly-enrolled
   * credential can independently log in — never by the ordinary login
   * route, which must keep letting the platform authenticator present
   * whichever synced passkey it has (fresh-device restore depends on that).
   */
  allowCredentialIds?: string[];
}): Promise<PublicKeyCredentialRequestOptionsJSON> {
  // Same reasoning as buildRegistrationOptions: no explicit `challenge`, let
  // the library mint its own random bytes; capture optionsJSON.challenge.
  return generateAuthenticationOptions({
    rpID: input.config.rpId,
    userVerification: "required",
    // No allowCredentials for the ordinary restore flow (allowCredentialIds
    // unset) — the platform authenticator itself presents the user's synced
    // passkeys. Set only for the backup-verification path above.
    allowCredentials: input.allowCredentialIds?.map((id) => ({ id })),
  });
}

export async function verifyLogin(input: {
  config: RealServerConfig;
  response: AuthenticationResponseJSON;
  expectedChallenge: string;
  credential: WebAuthnCredential;
}): Promise<VerifiedAuthenticationResponse> {
  return verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: input.config.expectedOrigins,
    expectedRPID: input.config.rpId,
    credential: input.credential,
    requireUserVerification: true,
  });
}

export type { AuthenticationResponseJSON, RegistrationResponseJSON, WebAuthnCredential };
