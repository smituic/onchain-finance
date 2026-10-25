import { decodeClientDataJSON } from "@simplewebauthn/server/helpers";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { base64UrlToBytes } from "../bytes";
import type { SafeAccountPublicClient } from "../account/safe";
import type { RealAccountRegistry } from "./registry";
import type { RegistrationAttemptStore } from "./registration-attempts";
import type { RealServerConfig } from "./config";
import { buildLoginOptions, verifyLogin } from "./webauthn";
import { issueLoginChallenge, parseLoginChallenge } from "./login-challenge";
import { consumeLoginChallenge, type LoginChallengeUseStore } from "./login-challenge-uses";
import { createSessionPayload, serializeSession } from "./session";
import { runProvisioningPipeline, type OnboardingOutcome, type ProvisioningDeps } from "./onboarding";

/**
 * Pre-2f hardening: never forward @simplewebauthn/server's own error.message
 * for a failed verifyLogin() call — not necessarily secret-bearing here, but
 * every other rejection reason in this file is already a fixed string we
 * wrote ourselves, and a caught library error is the one place that
 * convention was broken. Mirrors server/payments.ts's SAFE_* constants.
 */
const SAFE_LOGIN_VERIFICATION_FAILED = "Login could not be verified.";
/** The one rejection wording for a challenge that is unknown, forged, malformed, expired, or already used (unchanged from the database-backed design). */
const UNKNOWN_LOGIN_CHALLENGE = "Unknown, expired, or already-used login challenge.";

/**
 * Milestone 3C-2: a STATELESS login challenge. This performs ZERO database
 * requests and ZERO writes — it mints a signed, expiring token (login-challenge.ts)
 * and hands its exact bytes to option generation. Replay protection lives in
 * completeLogin, after a successful verification. There is no global quota and no
 * source-IP logic here; anonymous callers can no longer cause durable writes.
 */
export async function beginLogin(input: { config: RealServerConfig; nowMs?: number }): Promise<{ optionsJSON: Awaited<ReturnType<typeof buildLoginOptions>> }> {
  const issued = issueLoginChallenge({ sessionSecret: input.config.sessionSecret, rpId: input.config.rpId, nowMs: input.nowMs });
  // No allowCredentials: the discoverable-credential flow lets the platform
  // authenticator present whichever synced passkeys it has for this RP ID —
  // this is what makes fresh-device restore possible without us needing to
  // already know which credential the browser has.
  const optionsJSON = await buildLoginOptions({ config: input.config, challenge: issued.tokenBytes });
  // The library must have encoded exactly our bytes; anything else would make every login fail (or worse, verify a different value).
  if (optionsJSON.challenge !== issued.challenge) throw new Error("Login options refused: the library did not encode the challenge bytes exactly.");
  return { optionsJSON };
}

export type CompleteLoginResult = OnboardingOutcome;

const MALFORMED_LOGIN_RESPONSE = "Malformed login response.";
/** Unpadded base64url alphabet. No `m` flag: `$` only matches at the very end of the string. */
const UNPADDED_BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Pure structural precheck of the assertion envelope, run after the stateless challenge check and BEFORE the first
 * credential lookup, so a malformed envelope costs no database request. It checks shape only: it proves nothing about
 * whether a credential exists and is not a rate limit. Deliberately NO maximum credential-id length (a cap needs its
 * own decision); the request-body ceiling is the only size bound.
 */
function isWellFormedLoginEnvelope(response: { id?: unknown; rawId?: unknown; type?: unknown }, clientDataType: unknown): boolean {
  const id = response.id;
  if (typeof id !== "string" || id.length === 0 || !UNPADDED_BASE64URL.test(id) || id.length % 4 === 1) return false;
  if (response.rawId !== id) return false;
  if (response.type !== "public-key") return false;
  return clientDataType === "webauthn.get";
}

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
  /** Milestone 3C-2: where a VERIFIED login challenge is recorded as used (login-challenge-uses.ts). Never webauthn_challenges. */
  loginChallengeUses: LoginChallengeUseStore;
  /** Application clock for the advisory expiry precheck; production leaves it unset. */
  nowMs?: number;
  registry: RealAccountRegistry;
  attempts: RegistrationAttemptStore;
  response: AuthenticationResponseJSON;
  publicClient?: SafeAccountPublicClient;
  provisioningDeps?: ProvisioningDeps;
}): Promise<CompleteLoginResult> {
  let clientData: ReturnType<typeof decodeClientDataJSON>;
  try {
    clientData = decodeClientDataJSON(input.response.response.clientDataJSON);
  } catch {
    return { outcome: "rejected", reason: MALFORMED_LOGIN_RESPONSE };
  }

  // Milestone 3C-2 ordering. The challenge is first checked as a SIGNED, UNEXPIRED, login-purpose token for this
  // RP ID — with no database access, so a forged or malformed one costs nothing. It is NOT yet consumed: a used
  // marker is written only after the assertion has been cryptographically verified and every acceptance check
  // below has passed, so an invalid assertion can never create a marker. A challenge that is not one of ours
  // (including any old database-backed login challenge) is refused here.
  const token = parseLoginChallenge(clientData.challenge, { sessionSecret: input.config.sessionSecret, rpId: input.config.rpId, nowMs: input.nowMs });
  if (!token.ok) return { outcome: "rejected", reason: UNKNOWN_LOGIN_CHALLENGE };
  const expectedChallenge = clientData.challenge;

  // Structural envelope check, still with no database access. Same generic wording as an undecodable clientDataJSON.
  if (!isWellFormedLoginEnvelope(input.response, clientData.type)) return { outcome: "rejected", reason: MALFORMED_LOGIN_RESPONSE };

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
        expectedChallenge,
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

    // Single use, enforced by the database, BEFORE the counter update, the account lookup, and the session. A throw
    // (database error, malformed answer) propagates: no session, no retry of an uncertain write.
    if (!(await consumeLoginChallenge(input.loginChallengeUses, token))) return { outcome: "rejected", reason: UNKNOWN_LOGIN_CHALLENGE };

    await input.registry.updateAuthenticatorCounter({ credentialId: passkey.credentialId, counter: verified.authenticationInfo.newCounter });

    const account = await input.registry.findAccountByAppUserId(passkey.appUserId);
    if (!account) return { outcome: "rejected", reason: "No account is associated with this passkey." };

    // Rotate: always mint a brand-new session on successful login, never
    // extend or reuse a prior one. Minted at the account's CURRENT epoch
    // (just read) — logging in never invalidates other sessions; only
    // "Sign out everywhere" moves the epoch.
    const sessionPayload = createSessionPayload({ appUserId: account.appUserId, credentialId: passkey.credentialId, sessionEpoch: account.sessionEpoch });
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
      expectedChallenge,
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

  // Single use, enforced by the database, BEFORE the counter update and BEFORE the provisioning pipeline: a replay of
  // one challenge can never enter provisioning twice. A throw propagates (no pipeline entry, no retry).
  if (!(await consumeLoginChallenge(input.loginChallengeUses, token))) return { outcome: "rejected", reason: UNKNOWN_LOGIN_CHALLENGE };

  // Possession proven independently of Turnkey. Persist the counter
  // durably even though the account isn't active yet, then resume the
  // SAME onboarding pipeline registration.ts uses — never a blind second
  // createSubOrganization call, and an uncertain create is never adopted
  // (S5 L2 Option 3: it reports needs-review).
  await input.attempts.updateCounter({ credentialId: attempt.credentialId, counter: verified.authenticationInfo.newCounter });

  return runProvisioningPipeline({
    config: input.config,
    registry: input.registry,
    attempts: input.attempts,
    attempt: { ...attempt, counter: verified.authenticationInfo.newCounter },
    publicClient: input.publicClient,
    provisioningDeps: input.provisioningDeps,
  });
}
