import { decodeClientDataJSON } from "@simplewebauthn/server/helpers";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { base64UrlToBytes } from "../bytes";
import type { SafeAccountPublicClient } from "../account/safe";
import type { ChallengeStore } from "./challenge-store";
import type { RealAccountRegistry } from "./registry";
import type { RegistrationAttemptStore } from "./registration-attempts";
import type { RealServerConfig } from "./config";
import { buildLoginOptions, verifyLogin } from "./webauthn";
import { createSessionPayload, serializeSession } from "./session";
import { runProvisioningPipeline, type OnboardingOutcome } from "./onboarding";

const LOGIN_CHALLENGE_TTL_MS = 1000 * 60 * 5;

/**
 * Pre-2f hardening: never forward @simplewebauthn/server's own error.message
 * for a failed verifyLogin() call — not necessarily secret-bearing here, but
 * every other rejection reason in this file is already a fixed string we
 * wrote ourselves, and a caught library error is the one place that
 * convention was broken. Mirrors server/payments.ts's SAFE_* constants.
 */
const SAFE_LOGIN_VERIFICATION_FAILED = "Login could not be verified.";

export async function beginLogin(input: {
  config: RealServerConfig;
  challengeStore: ChallengeStore;
}): Promise<{ optionsJSON: Awaited<ReturnType<typeof buildLoginOptions>> }> {
  // No allowCredentials: the discoverable-credential flow lets the platform
  // authenticator present whichever synced passkeys it has for this RP ID —
  // this is what makes fresh-device restore possible without us needing to
  // already know which credential the browser has.
  const optionsJSON = await buildLoginOptions({ config: input.config });
  // Record exactly the challenge the library minted (see registration.ts's
  // identical reasoning and webauthn.ts's buildLoginOptions).
  await input.challengeStore.create({ challenge: optionsJSON.challenge, purpose: "login", ttlMs: LOGIN_CHALLENGE_TTL_MS });
  return { optionsJSON };
}

export type CompleteLoginResult = OnboardingOutcome;

/**
 * APP LOGIN — this never talks to Turnkey UNLESS the credential belongs to
 * a still-pending registration attempt (below), in which case a
 * successfully-verified assertion is used only to PROVE POSSESSION before
 * resuming the SAME durable onboarding pipeline registration.ts uses — it
 * never runs Turnkey's own loginWithPasskey/stampLogin/createReadWriteSession
 * or any other credential-discovery-as-authentication shortcut, and
 * credentialId alone is never treated as authentication, only as which
 * durable row to attempt cryptographic verification against. No session is
 * issued for an incomplete account before reconciliation finalizes it.
 */
export async function completeLogin(input: {
  config: RealServerConfig;
  challengeStore: ChallengeStore;
  registry: RealAccountRegistry;
  attempts: RegistrationAttemptStore;
  response: AuthenticationResponseJSON;
  publicClient?: SafeAccountPublicClient;
}): Promise<CompleteLoginResult> {
  let clientData: ReturnType<typeof decodeClientDataJSON>;
  try {
    clientData = decodeClientDataJSON(input.response.response.clientDataJSON);
  } catch {
    return { outcome: "rejected", reason: "Malformed login response." };
  }

  const stored = await input.challengeStore.consume({ challenge: clientData.challenge, purpose: "login" });
  if (!stored) return { outcome: "rejected", reason: "Unknown, expired, or already-used login challenge." };

  const passkey = await input.registry.findPasskeyByCredentialId(input.response.id);
  if (passkey) {
    if (passkey.status !== "active") return { outcome: "rejected", reason: "Unknown or revoked passkey." };

    const responseUserHandle = input.response.response.userHandle;
    if (!responseUserHandle || responseUserHandle !== passkey.userHandle) {
      return { outcome: "rejected", reason: "Passkey userHandle does not match the registered credential." };
    }

    let verified;
    try {
      verified = await verifyLogin({
        config: input.config,
        response: input.response,
        expectedChallenge: stored.challenge,
        credential: {
          id: passkey.credentialId,
          publicKey: base64UrlToBytes(passkey.credentialPublicKey),
          counter: passkey.counter,
          transports: passkey.transports ?? undefined,
        },
      });
    } catch {
      // @simplewebauthn/server itself throws here for a counter regression
      // (see verifyAuthenticationResponse.js: only when either side's
      // counter is nonzero — both-zero authenticators are exempt, matching
      // real platform-authenticator behavior rather than an invented
      // stricter rule). Never forward the library's own error.message — see
      // SAFE_LOGIN_VERIFICATION_FAILED above.
      return { outcome: "rejected", reason: SAFE_LOGIN_VERIFICATION_FAILED };
    }
    if (!verified.verified) return { outcome: "rejected", reason: SAFE_LOGIN_VERIFICATION_FAILED };
    if (!verified.authenticationInfo.userVerified) return { outcome: "rejected", reason: "User verification was not performed." };

    await input.registry.updateAuthenticatorCounter({ credentialId: passkey.credentialId, counter: verified.authenticationInfo.newCounter });

    const account = await input.registry.findAccountByAppUserId(passkey.appUserId);
    if (!account) return { outcome: "rejected", reason: "No account is associated with this passkey." };

    // Rotate: always mint a brand-new session on successful login, never
    // extend or reuse a prior one.
    const sessionPayload = createSessionPayload({ appUserId: account.appUserId, credentialId: passkey.credentialId });
    const sessionCookie = serializeSession(sessionPayload, input.config.sessionSecret);
    return { outcome: "verified", sessionCookie, account };
  }

  // Not an active passkey — check whether this credential belongs to a
  // registration that was verified but never finished activating.
  const attempt = await input.attempts.findByCredentialId(input.response.id);
  if (!attempt) return { outcome: "rejected", reason: "Unknown credential." };

  const responseUserHandle = input.response.response.userHandle;
  if (!responseUserHandle || responseUserHandle !== attempt.userHandle) {
    return { outcome: "rejected", reason: "Passkey userHandle does not match the registered credential." };
  }

  let verified;
  try {
    verified = await verifyLogin({
      config: input.config,
      response: input.response,
      expectedChallenge: stored.challenge,
      credential: {
        id: attempt.credentialId,
        publicKey: base64UrlToBytes(attempt.credentialPublicKey),
        counter: attempt.counter,
        transports: attempt.transports ?? undefined,
      },
    });
  } catch {
    // Never forward @simplewebauthn/server's own error.message — see
    // SAFE_LOGIN_VERIFICATION_FAILED above.
    return { outcome: "rejected", reason: SAFE_LOGIN_VERIFICATION_FAILED };
  }
  if (!verified.verified) return { outcome: "rejected", reason: SAFE_LOGIN_VERIFICATION_FAILED };
  if (!verified.authenticationInfo.userVerified) return { outcome: "rejected", reason: "User verification was not performed." };

  // Possession proven independently of Turnkey. Persist the counter
  // durably even though the account isn't active yet, then resume the
  // SAME onboarding pipeline registration.ts uses — discovery-first,
  // never a blind second createSubOrganization call.
  await input.attempts.updateCounter({ credentialId: attempt.credentialId, counter: verified.authenticationInfo.newCounter });

  return runProvisioningPipeline({
    config: input.config,
    registry: input.registry,
    attempts: input.attempts,
    attempt: { ...attempt, counter: verified.authenticationInfo.newCounter },
    publicClient: input.publicClient,
  });
}
