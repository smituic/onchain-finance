import { randomUUID } from "node:crypto";
import { decodeClientDataJSON } from "@simplewebauthn/server/helpers";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { base64UrlToBytes, bytesToBase64Url, randomBytes } from "../bytes";
import { credentialIdsEqual } from "../credential-id";
import type { SafeAccountPublicClient } from "../account/safe";
import type { ChallengeStore } from "./challenge-store";
import { DuplicateAccountError, DuplicateCredentialError, type RealAccountRegistry } from "./registry";
import type { RegistrationAttemptStore } from "./registration-attempts";
import type { RealServerConfig } from "./config";
import { buildRegistrationOptions, verifyRegistration } from "./webauthn";
import { runProvisioningPipeline, type OnboardingOutcome, type ProvisioningDeps } from "./onboarding";

const REGISTRATION_CHALLENGE_TTL_MS = 1000 * 60 * 5;

/**
 * Pre-2f hardening: never forward @simplewebauthn/server's own error.message
 * for a failed verifyRegistration() call — not necessarily secret-bearing
 * here, but every other rejection reason in this file is already a fixed
 * string we wrote ourselves. Mirrors server/payments.ts's SAFE_* constants.
 */
const SAFE_REGISTRATION_VERIFICATION_FAILED = "Registration could not be verified.";

/** The one rejection for a registration challenge that is unknown, expired, already used — or not even shaped like one of ours. Never says which. */
const UNKNOWN_REGISTRATION_CHALLENGE = "Unknown, expired, or already-used registration challenge.";

/** Milestone 3C-3b: a registration challenge is the library's 32 random bytes in canonical unpadded base64url: exactly 43 characters. */
const REGISTRATION_CHALLENGE_CHARS = 43;
const REGISTRATION_CHALLENGE_BYTES = 32;
const REGISTRATION_CHALLENGE_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Whether `value` is exactly a canonical registration challenge: a primitive string of 43 characters from the URL-safe base64 alphabet
 * (no padding, no whitespace, no `+` `/`), that decodes to exactly 32 bytes and re-encodes to the same string (which rejects
 * non-zero spare trailing bits that a lenient decoder would accept). The cheap type, length and alphabet checks run FIRST, so
 * attacker-supplied large or odd input is refused before anything is decoded or allocated. Pure: no I/O. It is a SHAPE check, not
 * proof the challenge exists — only the atomic consume decides that.
 */
function isCanonicalRegistrationChallenge(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== REGISTRATION_CHALLENGE_CHARS || !REGISTRATION_CHALLENGE_SHAPE.test(value)) return false;
  try {
    const bytes = base64UrlToBytes(value);
    return bytes.length === REGISTRATION_CHALLENGE_BYTES && bytesToBase64Url(bytes) === value;
  } catch {
    return false;
  }
}

type RegistrationContext = { appUserId: string; userHandle: string };

export async function beginRegistration(input: {
  config: RealServerConfig;
  challengeStore: ChallengeStore;
}): Promise<{ optionsJSON: Awaited<ReturnType<typeof buildRegistrationOptions>> }> {
  const appUserId = randomUUID();
  const userIdBytes = randomBytes(32);
  const userHandle = bytesToBase64Url(userIdBytes);

  const optionsJSON = await buildRegistrationOptions({
    config: input.config,
    userId: userIdBytes,
    userName: `real-${appUserId.slice(0, 8)}`,
  });

  // Fail closed BEFORE anything is saved or returned: a challenge the verify step would later refuse by shape must never be issued
  // (the user would create a passkey the application then rejects). It is never normalized or repaired. A throw here is the route's
  // generic 500; the 3C-1 admission that already counted this start is not refunded.
  if (!isCanonicalRegistrationChallenge(optionsJSON.challenge)) throw new Error("Registration options refused: the generated challenge is not in the canonical form.");

  // The challenge recorded is exactly the one the library minted
  // (optionsJSON.challenge) — never a value we generated ourselves and
  // asked the library to use (see webauthn.ts's buildRegistrationOptions).
  await input.challengeStore.create({
    challenge: optionsJSON.challenge,
    purpose: "registration",
    ttlMs: REGISTRATION_CHALLENGE_TTL_MS,
    context: { appUserId, userHandle } satisfies RegistrationContext,
  });

  return { optionsJSON };
}

export type CompleteRegistrationResult = OnboardingOutcome;

/**
 * ONE WebAuthn registration ceremony produces the credential used for BOTH
 * our own independent app-authentication verification (below, first) and —
 * only after that succeeds — the Turnkey child sub-organization's sole
 * authenticator, via the shared runProvisioningPipeline (never a second
 * passkey). The durable pre-commit (attempts.createVerified) happens
 * immediately after independent verification and BEFORE Turnkey is ever
 * called, so a crash anywhere after this point is recoverable — either by
 * completing this same request's pipeline run, or later via login recovery
 * (see onboarding.ts / login.ts). Nothing is activated (no real_accounts
 * row, no session) until the pipeline reaches "active".
 */
export async function completeRegistration(input: {
  config: RealServerConfig;
  challengeStore: ChallengeStore;
  registry: RealAccountRegistry;
  attempts: RegistrationAttemptStore;
  response: RegistrationResponseJSON;
  publicClient?: SafeAccountPublicClient;
  provisioningDeps?: ProvisioningDeps;
}): Promise<CompleteRegistrationResult> {
  let clientData: ReturnType<typeof decodeClientDataJSON>;
  try {
    clientData = decodeClientDataJSON(input.response.response.clientDataJSON);
  } catch {
    return { outcome: "rejected", reason: "Malformed registration response." };
  }

  // Milestone 3C-3b: a value that is not even shaped like a challenge we issue is refused here — the same rejection as an unknown one —
  // with ZERO store calls. A well-formed value still goes straight into the unchanged atomic consume below (the one-time-use guarantee).
  if (!isCanonicalRegistrationChallenge(clientData.challenge)) return { outcome: "rejected", reason: UNKNOWN_REGISTRATION_CHALLENGE };

  const stored = await input.challengeStore.consume({ challenge: clientData.challenge, purpose: "registration" });
  if (!stored) return { outcome: "rejected", reason: UNKNOWN_REGISTRATION_CHALLENGE };
  const { appUserId, userHandle } = stored.context as RegistrationContext;

  let verified;
  try {
    verified = await verifyRegistration({ config: input.config, response: input.response, expectedChallenge: stored.challenge });
  } catch {
    // Never forward @simplewebauthn/server's own error.message — see
    // SAFE_REGISTRATION_VERIFICATION_FAILED above.
    return { outcome: "rejected", reason: SAFE_REGISTRATION_VERIFICATION_FAILED };
  }
  if (!verified.verified) return { outcome: "rejected", reason: SAFE_REGISTRATION_VERIFICATION_FAILED };
  if (!verified.registrationInfo.userVerified) return { outcome: "rejected", reason: "User verification was not performed." };

  // S5 L2: the durable credential id is the one the authenticator ATTESTED
  // (registrationInfo.credential.id, from authData) — the library only checks
  // response.id === rawId as strings, never against authData. Bind the
  // client-supplied id to it by decoded bytes, then run every credential
  // pre-check against the attested id only.
  const credentialId = verified.registrationInfo.credential.id;
  if (!credentialIdsEqual(input.response.id, credentialId)) return { outcome: "rejected", reason: SAFE_REGISTRATION_VERIFICATION_FAILED };

  if (await input.registry.findAccountByAppUserId(appUserId)) {
    return { outcome: "rejected", reason: "An account already exists for this registration attempt." };
  }
  if (await input.registry.findPasskeyByCredentialId(credentialId)) {
    return { outcome: "rejected", reason: 'This passkey is already registered. Use "I already have an account" instead.' };
  }
  if (await input.attempts.findByCredentialId(credentialId)) {
    return { outcome: "rejected", reason: 'A registration is already pending for this passkey. Use "I already have an account" to resume it.' };
  }

  // Durable pre-commit — before Turnkey is ever called. If the process
  // dies at any point after this line, the attempt is recoverable (see
  // onboarding.ts's runProvisioningPipeline, reached again either later in
  // this same call or via login recovery).
  let attempt;
  try {
    attempt = await input.attempts.createVerified({
      credentialId,
      appUserId,
      userHandle,
      credentialPublicKey: bytesToBase64Url(verified.registrationInfo.credential.publicKey),
      counter: verified.registrationInfo.credential.counter,
      transports: verified.registrationInfo.credential.transports ?? null,
      credentialDeviceType: verified.registrationInfo.credentialDeviceType,
      credentialBackedUp: verified.registrationInfo.credentialBackedUp,
      registrationChallenge: stored.challenge,
      rawClientDataJson: input.response.response.clientDataJSON,
      rawAttestationObject: input.response.response.attestationObject,
    });
  } catch (error) {
    if (error instanceof DuplicateCredentialError || error instanceof DuplicateAccountError) {
      return { outcome: "rejected", reason: error.message };
    }
    throw error;
  }

  return runProvisioningPipeline({
    config: input.config,
    registry: input.registry,
    attempts: input.attempts,
    attempt,
    publicClient: input.publicClient,
    provisioningDeps: input.provisioningDeps,
  });
}
