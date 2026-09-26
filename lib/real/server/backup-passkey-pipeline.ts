import { decodeClientDataJSON } from "@simplewebauthn/server/helpers";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { recoverAddress, type Hex } from "viem";
import { base64UrlToBytes, bytesToBase64Url, bytesToHex, randomBytes } from "../bytes";
import { credentialIdsEqual } from "../credential-id";
import { addressesEqual, isValidUuid } from "../identifiers";
import { serializeTurnkeyRawSignature } from "../signing/raw-signature";
import type { ChallengeStore } from "./challenge-store";
import { DuplicateCredentialError, type RealAccountRecord, type RealAccountRegistry, type RealPasskeyRecord } from "./registry";
import { isAbandonable, type BackupPasskeyEnrollment, type BackupPasskeyEnrollmentState, type BackupPasskeyEnrollmentStore, type EnrollmentExternalOutcome } from "./backup-passkey-enrollment";
import type { RealServerConfig } from "./config";
import { buildLoginOptions, buildRegistrationOptions, verifyLogin, verifyRegistration } from "./webauthn";
import { listTurnkeyUserAuthenticators, matchAuthenticatorByCredentialId, readTurnkeyActivity } from "./turnkey-discovery";
import {
  COMPLETED_STATUS,
  TERMINAL_FAILURE_STATUSES,
  forwardSignedRequest,
  hasExactlyKeys,
  isExpectedEndpointUrl,
  isFreshTimestamp,
  parseSignedBody,
  parseSignedTurnkeyRequest,
  parseTimestampMs,
  resolveDispatchDeps,
  sha256Hex,
  verifyStampAuthorizedBy,
  type TurnkeyActivitySummary,
  type TurnkeyDispatchDeps,
  type TurnkeyStamp,
} from "./turnkey-signed-request";

export type { TurnkeyDispatchDeps };

const BACKUP_REGISTRATION_CHALLENGE_TTL_MS = 1000 * 60 * 5;
const BACKUP_LOGIN_CHALLENGE_TTL_MS = 1000 * 60 * 5;
const BACKUP_STEP_UP_CHALLENGE_TTL_MS = 1000 * 60 * 5;
const CREATE_ACTIVITY_TYPE = "ACTIVITY_TYPE_CREATE_AUTHENTICATORS_V2";
const SIGN_ACTIVITY_TYPE = "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2";
const ALLOWED_TRANSPORTS = new Set([
  "AUTHENTICATOR_TRANSPORT_BLE",
  "AUTHENTICATOR_TRANSPORT_INTERNAL",
  "AUTHENTICATOR_TRANSPORT_NFC",
  "AUTHENTICATOR_TRANSPORT_USB",
  "AUTHENTICATOR_TRANSPORT_HYBRID",
]);

/** Never forward a library's own error.message — same convention as registration.ts/login.ts's SAFE_* constants. */
const SAFE_REGISTRATION_VERIFICATION_FAILED = "Registration could not be verified.";
const SAFE_LOGIN_VERIFICATION_FAILED = "Login could not be verified.";

/**
 * stepUpCredentialId: the session credential whose fresh step-up assertion authorized minting this registration challenge (2g-H).
 * mintId: the enrollment's registrationMintId when this challenge was minted — a later re-mint supersedes it (2g-H).
 */
type BackupRegistrationContext = { enrollmentId: string; appUserId: string; userHandle: string; stepUpCredentialId?: string; mintId?: string };
type BackupLoginContext = { enrollmentId: string; appUserId: string };
type BackupStepUpContext = { appUserId: string; credentialId: string };

const STEP_UP_REQUIRED = "Confirm it's you with the passkey you're signed in with, then try again.";
const SETUP_NEEDS_RESTART = "This setup wasn't confirmed with your signed-in passkey. Cancel it and start again.";
const SETUP_OTHER_PASSKEY = "Finish this setup signed in with the passkey that started it, or cancel it and start again.";
const CREATE_OUTCOME_UNKNOWN =
  "Turnkey reported this authorization as not completed, but the approved request could still be sent to it, so this setup needs review. This passkey may already be able to approve payments.";
const SETUP_REMOVED = "This setup was removed before it finished.";

/**
 * Ownership check for every step that takes an enrollmentId: a session for
 * account A can never read or act on account B's enrollment. A mismatch is
 * indistinguishable from "not found".
 */
async function loadOwnedEnrollment(input: { enrollments: BackupPasskeyEnrollmentStore; appUserId: string; enrollmentId: string }): Promise<BackupPasskeyEnrollment | null> {
  if (!isValidUuid(input.enrollmentId)) return null;
  const enrollment = await input.enrollments.findById(input.enrollmentId);
  if (!enrollment || enrollment.appUserId !== input.appUserId) return null;
  return enrollment;
}

function authenticatorName(enrollmentId: string): string {
  return `backup-${enrollmentId.slice(0, 8)}`;
}

function toTurnkeyTransport(transport: string): string {
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

// ---------------------------------------------------------------- status

/**
 * 2g-H: can this credential (possibly) authorize at Turnkey? Never optimistic.
 *   granted   — active/revoking, or pending with a CONFIRMED Turnkey authenticator
 *   none      — pending, and provably never reached Turnkey (nothing dispatched,
 *               or Turnkey authoritatively failed the one request we sent)
 *   uncertain — pending after a create may have reached Turnkey (in flight or
 *               in review), or anything we can't tie to its open enrollment
 */
export function passkeyWalletAccess(passkey: Pick<RealPasskeyRecord, "credentialId" | "status" | "turnkeyAuthenticatorId">, openEnrollment: BackupPasskeyEnrollment | null): "none" | "uncertain" | "granted" {
  if (passkey.status === "active" || passkey.status === "revoking" || passkey.turnkeyAuthenticatorId !== null) return "granted";
  if (passkey.status !== "pending") return "none";
  const enrollment = openEnrollment && openEnrollment.newCredentialId === passkey.credentialId ? openEnrollment : null;
  // Only "nothing was ever dispatched" is provably none. A dispatched create — even one Turnkey
  // reported FAILED (a legacy 'definitive_failure') — may still be sent by the browser that holds it.
  if (enrollment?.state === "credential_registered" && enrollment.externalOutcome === "not_attempted") return "none";
  return "uncertain";
}

export type BackupEnrollmentStatus = {
  id: string;
  state: BackupPasskeyEnrollmentState;
  externalOutcome: EnrollmentExternalOutcome;
  /** True only when no Turnkey attempt is outstanding — see isAbandonable. */
  abandonable: boolean;
  blockReason: string | null;
};

/** Read-only resume status — never exposes ceremony artifacts, signed requests, stamps, or Turnkey ids. */
export async function getActiveBackupEnrollment(input: { enrollments: BackupPasskeyEnrollmentStore; appUserId: string }): Promise<BackupEnrollmentStatus | null> {
  const enrollment = await input.enrollments.findActiveByAppUserId(input.appUserId);
  if (!enrollment) return null;
  return { id: enrollment.id, state: enrollment.state, externalOutcome: enrollment.externalOutcome, abandonable: isAbandonable(enrollment), blockReason: enrollment.blockReason };
}

// ---------------------------------------------------------------- step 0: step-up (2g-H)

/**
 * Why this exists: the backup's credential is CHOSEN at registration, and a
 * later Turnkey authorization by the signed-in passkey is bound (by
 * validateCreateBody) to exactly that credential. If an app cookie alone
 * could mint a registration challenge, whoever holds a stolen cookie could
 * register THEIR authenticator into the enrollment, and the victim's next
 * "Resume setup" tap would grant it full Turnkey authority. So every
 * registration challenge is minted only after a fresh, user-verified
 * assertion by the CURRENT SESSION CREDENTIAL (allowCredentials = that one
 * credential; not "any passkey on the account" — the session credential is
 * the one the browser demonstrably holds, and the one the later Turnkey
 * authorization must come from anyway). App authentication only: nothing
 * here touches Turnkey or signs anything.
 */
export type PrepareBackupStepUpResult = { outcome: "ready"; optionsJSON: Awaited<ReturnType<typeof buildLoginOptions>> } | { outcome: "rejected"; reason: string };

export async function prepareBackupStepUp(input: {
  config: RealServerConfig;
  challengeStore: ChallengeStore;
  registry: RealAccountRegistry;
  appUserId: string;
  sessionCredentialId: string;
}): Promise<PrepareBackupStepUpResult> {
  const passkey = await input.registry.findPasskeyByCredentialId(input.sessionCredentialId);
  if (!passkey || passkey.appUserId !== input.appUserId || passkey.status !== "active") return { outcome: "rejected", reason: "The passkey you're signed in with isn't active." };
  const optionsJSON = await buildLoginOptions({ config: input.config, allowCredentialIds: [passkey.credentialId] });
  await input.challengeStore.create({
    challenge: optionsJSON.challenge,
    purpose: "backup_step_up",
    ttlMs: BACKUP_STEP_UP_CHALLENGE_TTL_MS,
    context: { appUserId: input.appUserId, credentialId: passkey.credentialId } satisfies BackupStepUpContext,
  });
  return { outcome: "ready", optionsJSON };
}

/** Single-use (consumed first, even on failure), expiring, purpose-bound, and bound to this app user AND this session credential. */
async function verifyBackupStepUp(input: {
  config: RealServerConfig;
  challengeStore: ChallengeStore;
  registry: RealAccountRegistry;
  appUserId: string;
  sessionCredentialId: string;
  response: unknown;
}): Promise<{ ok: true; credentialId: string } | { ok: false }> {
  const response = input.response as AuthenticationResponseJSON | null | undefined;
  if (!response || typeof response !== "object" || typeof response.id !== "string" || !response.response || typeof response.response.clientDataJSON !== "string") return { ok: false };
  let clientData: ReturnType<typeof decodeClientDataJSON>;
  try {
    clientData = decodeClientDataJSON(response.response.clientDataJSON);
  } catch {
    return { ok: false };
  }
  const stored = await input.challengeStore.consume({ challenge: clientData.challenge, purpose: "backup_step_up" });
  if (!stored) return { ok: false };
  const context = stored.context as BackupStepUpContext | null;
  if (!context || context.appUserId !== input.appUserId || context.credentialId !== input.sessionCredentialId) return { ok: false };

  const passkey = await input.registry.findPasskeyByCredentialId(input.sessionCredentialId);
  if (!passkey || passkey.appUserId !== input.appUserId || passkey.status !== "active") return { ok: false };
  if (!credentialIdsEqual(response.id, passkey.credentialId)) return { ok: false };
  if (!response.response.userHandle || response.response.userHandle !== passkey.userHandle) return { ok: false };

  let verified;
  try {
    verified = await verifyLogin({
      config: input.config,
      response: { ...response, id: passkey.credentialId, rawId: passkey.credentialId },
      expectedChallenge: stored.challenge,
      credential: { id: passkey.credentialId, publicKey: base64UrlToBytes(passkey.credentialPublicKey), counter: passkey.counter, transports: passkey.transports ?? undefined },
    });
  } catch {
    return { ok: false };
  }
  if (!verified.verified || !verified.authenticationInfo.userVerified) return { ok: false };
  await input.registry.updateAuthenticatorCounter({ credentialId: passkey.credentialId, counter: verified.authenticationInfo.newCounter });
  return { ok: true, credentialId: passkey.credentialId };
}

// ---------------------------------------------------------------- step 1: begin

export type BeginBackupEnrollmentResult =
  | { outcome: "started"; enrollmentId: string; optionsJSON: Awaited<ReturnType<typeof buildRegistrationOptions>> }
  | { outcome: "step_up_failed"; reason: string }
  | { outcome: "already_in_progress"; reason: string }
  | { outcome: "rejected"; reason: string };

/**
 * Starts (or, while still 'started', re-mints the ceremony for) the one
 * active enrollment, excluding every non-revoked credential this account
 * already has — @simplewebauthn/server's excludeCredentials is what makes
 * re-registering an existing credential as the "backup" impossible.
 *
 * 2g-H: EVERY call — first start or re-mint — requires a fresh step-up
 * assertion by the session credential (prepareBackupStepUp), verified before
 * anything is created or minted. A cookie alone gets nothing.
 */
export async function beginBackupEnrollment(input: {
  config: RealServerConfig;
  challengeStore: ChallengeStore;
  registry: RealAccountRegistry;
  enrollments: BackupPasskeyEnrollmentStore;
  appUserId: string;
  sessionCredentialId: string;
  stepUpResponse: unknown;
}): Promise<BeginBackupEnrollmentResult> {
  const stepUp = await verifyBackupStepUp({ ...input, response: input.stepUpResponse });
  if (!stepUp.ok) return { outcome: "step_up_failed", reason: STEP_UP_REQUIRED };

  const account = await input.registry.findAccountByAppUserId(input.appUserId);
  if (!account) return { outcome: "rejected", reason: "No account found for this session." };

  let enrollment = await input.enrollments.createStarted({ appUserId: input.appUserId });
  if (!enrollment) {
    // Re-minting is safe only while nothing was registered or attempted.
    const existing = await input.enrollments.findActiveByAppUserId(input.appUserId);
    if (!existing || existing.state !== "started") {
      return { outcome: "already_in_progress", reason: "A backup passkey setup is already in progress — resume it instead." };
    }
    enrollment = existing;
  }
  // 2g-H: every mint gets a fresh id, recorded by CAS while still 'started';
  // registerCredential only accepts the CURRENT mint, so any challenge from an
  // earlier mint (another tab, a captured response) can never attach later.
  const mintId = bytesToBase64Url(randomBytes(16));
  const minted = await input.enrollments.transition({ id: enrollment.id, from: "started", to: "started", patch: { registrationMintId: mintId } });
  if (!minted) return { outcome: "already_in_progress", reason: "A backup passkey setup is already in progress — resume it instead." };

  const existingPasskeys = await input.registry.findPasskeysByAppUserId(input.appUserId);
  const userIdBytes = randomBytes(32);
  const optionsJSON = await buildRegistrationOptions({
    config: input.config,
    userId: userIdBytes,
    userName: `real-backup-${enrollment.id.slice(0, 8)}`,
    excludeCredentialIds: existingPasskeys.filter((p) => p.status !== "revoked").map((p) => p.credentialId),
  });

  await input.challengeStore.create({
    challenge: optionsJSON.challenge,
    purpose: "backup_registration",
    ttlMs: BACKUP_REGISTRATION_CHALLENGE_TTL_MS,
    context: { enrollmentId: enrollment.id, appUserId: input.appUserId, userHandle: bytesToBase64Url(userIdBytes), stepUpCredentialId: stepUp.credentialId, mintId } satisfies BackupRegistrationContext,
  });

  return { outcome: "started", enrollmentId: enrollment.id, optionsJSON };
}

// ---------------------------------------------------------------- step 2: register locally

export type CompleteBackupCredentialRegistrationResult = { outcome: "registered"; enrollmentId: string } | { outcome: "rejected"; reason: string };

/**
 * Independently verifies the NEW credential's registration ceremony (app
 * authentication only — nothing to do with Turnkey yet), then in ONE atomic
 * store operation inserts the pending passkey and attaches it to the
 * enrollment. A lost race leaves no orphan row.
 *
 * 2g-H: only a challenge minted after a fresh step-up by THIS session's
 * credential is accepted, and that credential is recorded on the enrollment.
 */
export async function completeBackupCredentialRegistration(input: {
  config: RealServerConfig;
  challengeStore: ChallengeStore;
  registry: RealAccountRegistry;
  enrollments: BackupPasskeyEnrollmentStore;
  appUserId: string;
  sessionCredentialId: string;
  response: RegistrationResponseJSON;
}): Promise<CompleteBackupCredentialRegistrationResult> {
  let clientData: ReturnType<typeof decodeClientDataJSON>;
  try {
    clientData = decodeClientDataJSON(input.response.response.clientDataJSON);
  } catch {
    return { outcome: "rejected", reason: "Malformed registration response." };
  }

  const stored = await input.challengeStore.consume({ challenge: clientData.challenge, purpose: "backup_registration" });
  if (!stored) return { outcome: "rejected", reason: "Unknown, expired, or already-used setup challenge." };
  const context = stored.context as BackupRegistrationContext;
  if (context.appUserId !== input.appUserId) return { outcome: "rejected", reason: "This setup belongs to a different session." };
  if (!context.stepUpCredentialId || context.stepUpCredentialId !== input.sessionCredentialId) return { outcome: "rejected", reason: STEP_UP_REQUIRED };
  // The step-up credential may have been removed since the challenge was minted.
  const stepUpPasskey = await input.registry.findPasskeyByCredentialId(context.stepUpCredentialId);
  if (!stepUpPasskey || stepUpPasskey.appUserId !== input.appUserId || stepUpPasskey.status !== "active") return { outcome: "rejected", reason: STEP_UP_REQUIRED };

  const enrollment = await input.enrollments.findById(context.enrollmentId);
  if (!enrollment || enrollment.appUserId !== input.appUserId || enrollment.state !== "started") {
    return { outcome: "rejected", reason: "This setup is not awaiting a new passkey." };
  }
  if (!context.mintId || enrollment.registrationMintId !== context.mintId) return { outcome: "rejected", reason: "This setup was restarted; use the newest passkey prompt." };

  let verified;
  try {
    verified = await verifyRegistration({ config: input.config, response: input.response, expectedChallenge: stored.challenge });
  } catch {
    return { outcome: "rejected", reason: SAFE_REGISTRATION_VERIFICATION_FAILED };
  }
  if (!verified.verified) return { outcome: "rejected", reason: SAFE_REGISTRATION_VERIFICATION_FAILED };
  if (!verified.registrationInfo.userVerified) return { outcome: "rejected", reason: "User verification was not performed." };

  const credential = verified.registrationInfo.credential;
  const existing = await input.registry.findPasskeysByAppUserId(input.appUserId);
  if (existing.some((p) => credentialIdsEqual(p.credentialId, credential.id))) {
    return { outcome: "rejected", reason: "This passkey is already registered to this account." };
  }

  try {
    const registered = await input.enrollments.registerCredential({
      id: enrollment.id,
      credential: {
        credentialId: credential.id,
        userHandle: context.userHandle,
        credentialPublicKey: bytesToBase64Url(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports ?? null,
        credentialDeviceType: verified.registrationInfo.credentialDeviceType,
        credentialBackedUp: verified.registrationInfo.credentialBackedUp,
        registrationChallenge: stored.challenge,
        rawClientDataJson: input.response.response.clientDataJSON,
        rawAttestationObject: input.response.response.attestationObject,
        stepUpCredentialId: context.stepUpCredentialId,
        registrationMintId: context.mintId,
      },
    });
    if (!registered) return { outcome: "rejected", reason: "This setup changed while registering; resume it instead." };
    return { outcome: "registered", enrollmentId: registered.id };
  } catch (error) {
    if (error instanceof DuplicateCredentialError) return { outcome: "rejected", reason: "This passkey is already registered to an account." };
    throw error;
  }
}

// ---------------------------------------------------------------- step 3: child-authorized Turnkey create (Model B)

/** The exact activity the browser must stamp. Built from durable state only — the browser only overwrites timestampMs immediately before stamping. */
function expectedCreateActivity(input: { account: RealAccountRecord; enrollment: BackupPasskeyEnrollment; timestampMs: string }) {
  const e = input.enrollment;
  return {
    type: CREATE_ACTIVITY_TYPE,
    timestampMs: input.timestampMs,
    organizationId: input.account.subOrganizationId,
    parameters: {
      userId: input.account.turnkeyUserId,
      authenticators: [
        {
          authenticatorName: authenticatorName(e.id),
          challenge: e.registrationChallenge!,
          attestation: {
            credentialId: e.newCredentialId!,
            clientDataJson: e.rawClientDataJson!,
            attestationObject: e.rawAttestationObject!,
            transports: (e.transports ?? ["internal"]).map(toTurnkeyTransport),
          },
        },
      ],
    },
  };
}

export type PrepareTurnkeyAuthorizationResult =
  | { outcome: "ready"; activity: ReturnType<typeof expectedCreateActivity>; rpId: string; authorizingCredentialId: string }
  | { outcome: "rejected"; reason: string };

/**
 * The authorizer is ALWAYS the caller's own session credential (derived
 * here, never client-selected) — the only credential the browser can
 * physically produce a fresh assertion for right now.
 */
export async function prepareTurnkeyAuthorization(input: {
  config: RealServerConfig;
  registry: RealAccountRegistry;
  enrollments: BackupPasskeyEnrollmentStore;
  appUserId: string;
  enrollmentId: string;
  sessionCredentialId: string;
  now?: () => number;
}): Promise<PrepareTurnkeyAuthorizationResult> {
  const enrollment = await loadOwnedEnrollment(input);
  // 2g-H: only a create that was NEVER dispatched may be authorized — never a second create after one was sent.
  if (!enrollment || enrollment.state !== "credential_registered" || enrollment.externalOutcome !== "not_attempted" || !enrollment.newCredentialId || !enrollment.registrationChallenge) {
    return { outcome: "rejected", reason: "This setup is not ready for authorization." };
  }
  // 2g-H: never ask the signed-in passkey to authorize a credential that was
  // attached without a step-up (e.g. planted with a stolen cookie pre-2g-H),
  // and only the SAME session credential whose step-up chose it may authorize it.
  if (!enrollment.registrationStepUpCredentialId) return { outcome: "rejected", reason: SETUP_NEEDS_RESTART };
  if (enrollment.registrationStepUpCredentialId !== input.sessionCredentialId) return { outcome: "rejected", reason: SETUP_OTHER_PASSKEY };
  const account = await input.registry.findAccountByAppUserId(input.appUserId);
  if (!account) return { outcome: "rejected", reason: "No account found for this session." };
  const authorizer = await input.registry.findPasskeyByCredentialId(input.sessionCredentialId);
  if (!authorizer || authorizer.appUserId !== input.appUserId || authorizer.status !== "active") {
    return { outcome: "rejected", reason: "The passkey you're signed in with isn't active." };
  }
  return {
    outcome: "ready",
    activity: expectedCreateActivity({ account, enrollment, timestampMs: String((input.now ?? Date.now)()) }),
    rpId: input.config.rpId,
    authorizingCredentialId: authorizer.credentialId,
  };
}

/** Validates the EXACT signed body against durable state; any deviation (org, user, credential, attestation, extra fields, activity type) rejects. Returns the body's timestampMs. */
function validateCreateBody(body: string, account: RealAccountRecord, enrollment: BackupPasskeyEnrollment): number | null {
  const parsed = parseSignedBody(body);
  if (!parsed || !hasExactlyKeys(parsed, ["type", "timestampMs", "organizationId", "parameters"])) return null;
  if (parsed.type !== CREATE_ACTIVITY_TYPE || parsed.organizationId !== account.subOrganizationId) return null;
  const timestampMs = parseTimestampMs(parsed.timestampMs);
  if (timestampMs === null) return null;
  const parameters = parsed.parameters;
  if (!hasExactlyKeys(parameters, ["userId", "authenticators"]) || parameters.userId !== account.turnkeyUserId) return null;
  const authenticators = parameters.authenticators;
  if (!Array.isArray(authenticators) || authenticators.length !== 1) return null;
  const authenticator = authenticators[0] as unknown;
  if (!hasExactlyKeys(authenticator, ["authenticatorName", "challenge", "attestation"])) return null;
  if (authenticator.authenticatorName !== authenticatorName(enrollment.id) || authenticator.challenge !== enrollment.registrationChallenge) return null;
  const attestation = authenticator.attestation;
  if (!hasExactlyKeys(attestation, ["credentialId", "clientDataJson", "attestationObject", "transports"])) return null;
  if (!credentialIdsEqual(attestation.credentialId, enrollment.newCredentialId)) return null;
  if (attestation.clientDataJson !== enrollment.rawClientDataJson || attestation.attestationObject !== enrollment.rawAttestationObject) return null;
  if (!Array.isArray(attestation.transports) || !attestation.transports.every((t) => typeof t === "string" && ALLOWED_TRANSPORTS.has(t))) return null;
  return timestampMs;
}

export type ReconcileEnrollmentResult =
  | { outcome: "confirmed" }
  | { outcome: "pending"; reason: string }
  | { outcome: "blocked"; reason: string }
  | { outcome: "rejected"; reason: string };

/**
 * Receives the browser's child-stamped createAuthenticators request.
 * Validates body + URL + stamp authorship, then — in ONE CAS, BEFORE any
 * external call — moves 'credential_registered' -> 'turnkey_enrollment_in_flight'
 * with externalOutcome 'unknown' and the exact request recorded. A second
 * concurrent submission loses that CAS and is never forwarded. Only after
 * the commit is the byte-identical body raw-forwarded.
 */
export async function submitTurnkeyAuthorization(input: {
  config: RealServerConfig;
  registry: RealAccountRegistry;
  enrollments: BackupPasskeyEnrollmentStore;
  appUserId: string;
  enrollmentId: string;
  sessionCredentialId: string;
  signedRequest: unknown;
  deps?: TurnkeyDispatchDeps;
}): Promise<ReconcileEnrollmentResult> {
  const { now } = resolveDispatchDeps(input.deps);
  const enrollment = await loadOwnedEnrollment(input);
  if (!enrollment) return { outcome: "rejected", reason: "Unknown setup." };
  if (enrollment.state !== "credential_registered" || enrollment.externalOutcome !== "not_attempted") return { outcome: "rejected", reason: "This setup already has an authorization in progress — check its status instead." };
  if (!enrollment.registrationStepUpCredentialId) return { outcome: "rejected", reason: SETUP_NEEDS_RESTART };
  if (enrollment.registrationStepUpCredentialId !== input.sessionCredentialId) return { outcome: "rejected", reason: SETUP_OTHER_PASSKEY };

  const account = await input.registry.findAccountByAppUserId(input.appUserId);
  if (!account) return { outcome: "rejected", reason: "No account found for this session." };
  const signed = parseSignedTurnkeyRequest(input.signedRequest);
  if (!signed || !isExpectedEndpointUrl(input.config, "create_authenticators", signed.url)) return { outcome: "rejected", reason: "The signed request is not acceptable." };
  const timestampMs = validateCreateBody(signed.body, account, enrollment);
  if (timestampMs === null) return { outcome: "rejected", reason: "The signed request does not match this setup." };
  if (!isFreshTimestamp(timestampMs, now())) return { outcome: "rejected", reason: "The signed request has expired. Please authorize again." };

  const authorizer = await input.registry.findPasskeyByCredentialId(input.sessionCredentialId);
  if (!authorizer || authorizer.appUserId !== input.appUserId || authorizer.status !== "active") return { outcome: "rejected", reason: "The passkey you're signed in with isn't active." };
  const stampCheck = await verifyStampAuthorizedBy({ config: input.config, body: signed.body, stamp: signed.stamp, credential: authorizer });
  if (!stampCheck.ok) return { outcome: "rejected", reason: "The authorization wasn't signed by your current passkey." };

  const claimed = await input.enrollments.transition({
    id: enrollment.id,
    from: "credential_registered",
    to: "turnkey_enrollment_in_flight",
    patch: {
      externalOutcome: "unknown",
      externalEnrollmentAttemptedAt: new Date(now()).toISOString(),
      authorizingCredentialId: authorizer.credentialId,
      turnkeyRequestEndpoint: "create_authenticators",
      turnkeyRequestBody: signed.body,
      turnkeyRequestBodySha256: sha256Hex(signed.body),
      turnkeyRequestTimestampMs: timestampMs,
      turnkeyRequestStamp: JSON.stringify(signed.stamp),
      turnkeyActivityId: null,
      turnkeyActivityStatus: null,
      turnkeyRequestReplayed: false,
    },
  });
  if (!claimed) return { outcome: "rejected", reason: "This setup already has an authorization in progress — check its status instead." };
  await input.registry.updateAuthenticatorCounter({ credentialId: authorizer.credentialId, counter: stampCheck.newCounter });

  const forwarded = await forwardSignedRequest({ config: input.config, endpoint: "create_authenticators", body: signed.body, stamp: signed.stamp, fetchImpl: input.deps?.fetchImpl });
  if (forwarded.kind === "activity") await recordCreateActivity(input.enrollments, claimed.id, forwarded.activity);

  return reconcileTurnkeyEnrollment({ ...input, deps: input.deps });
}

async function recordCreateActivity(enrollments: BackupPasskeyEnrollmentStore, id: string, activity: TurnkeyActivitySummary): Promise<void> {
  // First writer wins: the activity id now identifies this exact request (the
  // stamp, a live body-bound bearer credential, is cleared) and a concurrent
  // send's activity can never replace it.
  await enrollments.recordActivity({ id, activityId: activity.id, activityStatus: activity.status });
}

function createResultAuthenticatorId(activity: TurnkeyActivitySummary): string | null {
  const result = activity.raw.result as { createAuthenticatorsResult?: { authenticatorIds?: unknown } } | undefined;
  const ids = result?.createAuthenticatorsResult?.authenticatorIds;
  return Array.isArray(ids) && ids.length === 1 && typeof ids[0] === "string" ? ids[0] : null;
}

/**
 * Drives an in-flight create to a truthful state, using ONLY: a
 * byte-identical replay of the stored signed body (while fresh, and only
 * when no activity id was ever learned), read-only getActivity polling, and
 * read-only getUsers matching by credential-id BYTES. Never a new create.
 *   - FAILED/REJECTED activity: confirmed anyway if getUsers shows exactly
 *     one byte-matching authenticator (the original request may have landed
 *     before a replay failed). Otherwise — ambiguous OR a miss — 'blocked'
 *     review (2g-H): the browser still holds the exact signed body + stamp
 *     and could post it to Turnkey itself, and Turnkey's own freshness /
 *     same-body rules are unverified (our local replay window protects only
 *     OUR server path), so a server-observed failure never proves absence.
 *     Review keeps the slot, is never abandonable or re-authorizable, and
 *     stays reconcilable by exact match. At most ONE replay is ever forwarded
 *     (claimReplay), and the first recorded activity id wins.
 *   - blocked (2g-H, not terminal): read-only discovery only; exactly one
 *     byte-matching authenticator moves it to turnkey_authenticator_created
 *     (then removable); anything else leaves it in review.
 *   - COMPLETED activity: accepted only when getUsers shows exactly one
 *     authenticator for this credential AND its id equals the activity
 *     result's id.
 *   - No activity id after the replay window: an exact credential match in
 *     getUsers confirms; a miss is NOT proof of failure and stays pending.
 */
export async function reconcileTurnkeyEnrollment(input: {
  config: RealServerConfig;
  registry: RealAccountRegistry;
  enrollments: BackupPasskeyEnrollmentStore;
  appUserId: string;
  enrollmentId: string;
  deps?: TurnkeyDispatchDeps;
}): Promise<ReconcileEnrollmentResult> {
  const deps = resolveDispatchDeps(input.deps);
  let enrollment = await loadOwnedEnrollment(input);
  if (!enrollment) return { outcome: "rejected", reason: "Unknown setup." };
  if (enrollment.state === "turnkey_authenticator_created" || enrollment.state === "login_verified" || enrollment.state === "active") return { outcome: "confirmed" };
  if (enrollment.state === "removal_in_progress" || enrollment.state === "removed") return { outcome: "rejected", reason: SETUP_REMOVED };
  if (enrollment.state === "credential_registered" && enrollment.externalOutcome === "definitive_failure") {
    // 2g-H: a legacy (pre-2g-H) "definitive failure" is uncertain authority — move it into review.
    await input.enrollments.transition({ id: enrollment.id, from: "credential_registered", to: "blocked", patch: { blockReason: CREATE_OUTCOME_UNKNOWN } });
    enrollment = (await input.enrollments.findById(enrollment.id)) ?? enrollment;
  }
  if ((enrollment.state !== "turnkey_enrollment_in_flight" && enrollment.state !== "blocked") || !enrollment.newCredentialId) return { outcome: "rejected", reason: "This setup has no authorization in progress." };

  const account = await input.registry.findAccountByAppUserId(input.appUserId);
  if (!account) return { outcome: "rejected", reason: "No account found for this session." };

  if (enrollment.state === "blocked") {
    // Review: read-only discovery only — never a replay, never a new create,
    // and a miss is never read as absence.
    const reason = enrollment.blockReason ?? "This setup needs manual review.";
    const match = matchAuthenticatorByCredentialId(await listTurnkeyUserAuthenticators({ config: input.config, subOrganizationId: account.subOrganizationId, turnkeyUserId: account.turnkeyUserId }), enrollment.newCredentialId);
    if (match.outcome !== "found" || !match.authenticator.publicKey) return { outcome: "blocked", reason };
    const recovered = await input.enrollments.confirmCreated({ id: enrollment.id, turnkeyAuthenticatorId: match.authenticator.authenticatorId, turnkeyAuthenticatorPublicKey: match.authenticator.publicKey, turnkeyActivityStatus: null });
    if (recovered) return { outcome: "confirmed" };
    const fresh = await input.enrollments.findById(enrollment.id);
    return fresh && fresh.state !== "blocked" && fresh.state !== "turnkey_enrollment_in_flight" ? { outcome: "confirmed" } : { outcome: "blocked", reason };
  }

  if (!enrollment.turnkeyActivityId) {
    const fresh = enrollment.turnkeyRequestTimestampMs !== null && isFreshTimestamp(enrollment.turnkeyRequestTimestampMs, deps.now());
    if (fresh && enrollment.turnkeyRequestBody && enrollment.turnkeyRequestStamp) {
      // 2g-H: durably claim THE one replay before sending it — only the first
      // false -> true wins, so concurrent reconciles forward at most one replay.
      const claimedReplay = await input.enrollments.claimReplay({ id: enrollment.id });
      if (claimedReplay) {
        const stamp = JSON.parse(enrollment.turnkeyRequestStamp) as TurnkeyStamp;
        const replayed = await forwardSignedRequest({ config: input.config, endpoint: "create_authenticators", body: enrollment.turnkeyRequestBody, stamp, fetchImpl: deps.fetchImpl });
        if (replayed.kind === "activity") await recordCreateActivity(input.enrollments, enrollment.id, replayed.activity);
      }
    } else if (!fresh && enrollment.turnkeyRequestStamp) {
      await input.enrollments.transition({ id: enrollment.id, from: "turnkey_enrollment_in_flight", to: "turnkey_enrollment_in_flight", patch: { turnkeyRequestStamp: null } });
    }
    enrollment = (await input.enrollments.findById(enrollment.id)) ?? enrollment;
  }

  const newCredentialId = enrollment.newCredentialId!;
  if (!enrollment.turnkeyActivityId) {
    const match = matchAuthenticatorByCredentialId(await listTurnkeyUserAuthenticators({ config: input.config, subOrganizationId: account.subOrganizationId, turnkeyUserId: account.turnkeyUserId }), newCredentialId);
    if (match.outcome === "ambiguous") return blockEnrollment(input.enrollments, enrollment.id, "More than one Turnkey authenticator matches this passkey; manual review is required.");
    if (match.outcome !== "found") return { outcome: "pending", reason: "Your authorization was sent but hasn't been confirmed yet. Check again shortly." };
    return confirmEnrollmentCreated(input.enrollments, enrollment.id, match.authenticator, null);
  }

  let activity: TurnkeyActivitySummary | null = null;
  for (let poll = 0; poll < deps.maxPolls; poll += 1) {
    if (poll > 0) await deps.sleep(deps.pollIntervalMs);
    activity = await readTurnkeyActivity({ config: input.config, subOrganizationId: account.subOrganizationId, activityId: enrollment.turnkeyActivityId });
    if (activity && (activity.status === COMPLETED_STATUS || TERMINAL_FAILURE_STATUSES.has(activity.status))) break;
  }
  if (!activity) return { outcome: "pending", reason: "Your authorization is still being processed. Check again shortly." };
  if (activity.id !== enrollment.turnkeyActivityId || activity.organizationId !== account.subOrganizationId || activity.type !== CREATE_ACTIVITY_TYPE) {
    return blockEnrollment(input.enrollments, enrollment.id, "The Turnkey activity doesn't match this setup; manual review is required.");
  }
  if (activity.status !== enrollment.turnkeyActivityStatus) {
    await input.enrollments.transition({ id: enrollment.id, from: "turnkey_enrollment_in_flight", to: "turnkey_enrollment_in_flight", patch: { turnkeyActivityStatus: activity.status } });
  }

  if (TERMINAL_FAILURE_STATUSES.has(activity.status)) {
    // A FAILED/REJECTED activity proves only that THIS activity created
    // nothing. The original may have landed after a lost response (Turnkey
    // same-body dedupe is not assumed), and the browser still holds the exact
    // signed body + stamp and could post it to Turnkey itself. So an exact
    // credential match confirms; anything else — including a clean miss —
    // is review: slot held, no abandon, no second create, discovery only.
    const match = matchAuthenticatorByCredentialId(await listTurnkeyUserAuthenticators({ config: input.config, subOrganizationId: account.subOrganizationId, turnkeyUserId: account.turnkeyUserId }), newCredentialId);
    if (match.outcome === "found") return confirmEnrollmentCreated(input.enrollments, enrollment.id, match.authenticator, activity.status);
    if (match.outcome === "ambiguous") return blockEnrollment(input.enrollments, enrollment.id, "More than one Turnkey authenticator matches this passkey; manual review is required.");
    return blockEnrollment(input.enrollments, enrollment.id, CREATE_OUTCOME_UNKNOWN);
  }
  if (activity.status !== COMPLETED_STATUS) return { outcome: "pending", reason: "Your authorization is still being processed. Check again shortly." };

  const resultId = createResultAuthenticatorId(activity);
  if (!resultId) return blockEnrollment(input.enrollments, enrollment.id, "The completed Turnkey activity has no single authenticator result; manual review is required.");
  const match = matchAuthenticatorByCredentialId(await listTurnkeyUserAuthenticators({ config: input.config, subOrganizationId: account.subOrganizationId, turnkeyUserId: account.turnkeyUserId }), newCredentialId);
  if (match.outcome === "ambiguous") return blockEnrollment(input.enrollments, enrollment.id, "More than one Turnkey authenticator matches this passkey; manual review is required.");
  if (match.outcome !== "found") return { outcome: "pending", reason: "Turnkey completed the authorization; waiting for it to appear. Check again shortly." };
  if (match.authenticator.authenticatorId !== resultId) return blockEnrollment(input.enrollments, enrollment.id, "Turnkey's result doesn't match the authenticator found for this passkey; manual review is required.");
  return confirmEnrollmentCreated(input.enrollments, enrollment.id, match.authenticator, activity.status);
}

async function blockEnrollment(enrollments: BackupPasskeyEnrollmentStore, id: string, reason: string): Promise<ReconcileEnrollmentResult> {
  await enrollments.transition({ id, from: "turnkey_enrollment_in_flight", to: "blocked", patch: { blockReason: reason, turnkeyRequestStamp: null } });
  return { outcome: "blocked", reason };
}

async function confirmEnrollmentCreated(
  enrollments: BackupPasskeyEnrollmentStore,
  id: string,
  authenticator: { authenticatorId: string; publicKey: string },
  activityStatus: string | null,
): Promise<ReconcileEnrollmentResult> {
  if (!authenticator.publicKey) return blockEnrollment(enrollments, id, "The Turnkey authenticator has no readable public key; manual review is required.");
  const confirmed = await enrollments.confirmCreated({ id, turnkeyAuthenticatorId: authenticator.authenticatorId, turnkeyAuthenticatorPublicKey: authenticator.publicKey, turnkeyActivityStatus: activityStatus });
  if (confirmed) return { outcome: "confirmed" };
  const fresh = await enrollments.findById(id);
  if (fresh && fresh.state !== "turnkey_enrollment_in_flight" && fresh.state !== "blocked") return { outcome: "confirmed" };
  return blockEnrollment(enrollments, id, "This passkey's Turnkey mapping conflicts with an existing record; manual review is required.");
}

// ---------------------------------------------------------------- abandon

export type AbandonBackupEnrollmentResult = { outcome: "abandoned" } | { outcome: "rejected"; reason: string };

/** Only while no Turnkey attempt is outstanding — an uncertain create is never abandoned. */
export async function abandonBackupEnrollment(input: { enrollments: BackupPasskeyEnrollmentStore; appUserId: string; enrollmentId: string }): Promise<AbandonBackupEnrollmentResult> {
  const enrollment = await loadOwnedEnrollment(input);
  if (!enrollment) return { outcome: "rejected", reason: "Unknown setup." };
  if (!isAbandonable(enrollment)) return { outcome: "rejected", reason: "This setup can't be cancelled while its Turnkey authorization is unconfirmed." };
  const abandoned = await input.enrollments.abandon({ id: enrollment.id });
  return abandoned ? { outcome: "abandoned" } : { outcome: "rejected", reason: "This setup changed; check its status and try again." };
}

// ---------------------------------------------------------------- step 4: Proof A (app authentication by the new credential)

export type PrepareBackupLoginVerificationResult = { outcome: "ready"; optionsJSON: Awaited<ReturnType<typeof buildLoginOptions>> } | { outcome: "rejected"; reason: string };

/** Single-use challenge bound to this account+enrollment, allowCredentials = ONLY the pending new credential. */
export async function prepareBackupLoginVerification(input: {
  config: RealServerConfig;
  challengeStore: ChallengeStore;
  enrollments: BackupPasskeyEnrollmentStore;
  appUserId: string;
  enrollmentId: string;
}): Promise<PrepareBackupLoginVerificationResult> {
  const enrollment = await loadOwnedEnrollment(input);
  if (!enrollment || !enrollment.newCredentialId || enrollment.state !== "turnkey_authenticator_created") {
    return { outcome: "rejected", reason: "This setup is not awaiting sign-in verification." };
  }
  const optionsJSON = await buildLoginOptions({ config: input.config, allowCredentialIds: [enrollment.newCredentialId] });
  await input.challengeStore.create({
    challenge: optionsJSON.challenge,
    purpose: "backup_login_verification",
    ttlMs: BACKUP_LOGIN_CHALLENGE_TTL_MS,
    context: { enrollmentId: enrollment.id, appUserId: input.appUserId } satisfies BackupLoginContext,
  });
  return { outcome: "ready", optionsJSON };
}

export type ConfirmBackupLoginVerificationResult = { outcome: "verified" } | { outcome: "rejected"; reason: string };

/** Verified against the pending credential's own stored public key. Evidence for the enrollment only — never mints a session. */
export async function confirmBackupLoginVerification(input: {
  config: RealServerConfig;
  challengeStore: ChallengeStore;
  registry: RealAccountRegistry;
  enrollments: BackupPasskeyEnrollmentStore;
  appUserId: string;
  response: AuthenticationResponseJSON;
}): Promise<ConfirmBackupLoginVerificationResult> {
  let clientData: ReturnType<typeof decodeClientDataJSON>;
  try {
    clientData = decodeClientDataJSON(input.response.response.clientDataJSON);
  } catch {
    return { outcome: "rejected", reason: "Malformed sign-in response." };
  }
  const stored = await input.challengeStore.consume({ challenge: clientData.challenge, purpose: "backup_login_verification" });
  if (!stored) return { outcome: "rejected", reason: "Unknown, expired, or already-used verification challenge." };
  const context = stored.context as BackupLoginContext;
  if (context.appUserId !== input.appUserId) return { outcome: "rejected", reason: "This verification belongs to a different session." };

  const enrollment = await input.enrollments.findById(context.enrollmentId);
  if (!enrollment || enrollment.appUserId !== input.appUserId || !enrollment.newCredentialId) return { outcome: "rejected", reason: "Unknown setup." };
  if (enrollment.state === "login_verified" || enrollment.state === "active") return { outcome: "verified" };
  if (enrollment.state !== "turnkey_authenticator_created") return { outcome: "rejected", reason: "This setup is not awaiting sign-in verification." };

  const passkey = await input.registry.findPasskeyByCredentialId(enrollment.newCredentialId);
  if (!passkey || passkey.status !== "pending" || passkey.appUserId !== input.appUserId) return { outcome: "rejected", reason: "Unknown or already-verified passkey." };
  if (!credentialIdsEqual(input.response.id, passkey.credentialId)) return { outcome: "rejected", reason: "A different passkey answered; use the new backup passkey." };
  if (!input.response.response.userHandle || input.response.response.userHandle !== passkey.userHandle) {
    return { outcome: "rejected", reason: "Passkey userHandle does not match the registered credential." };
  }

  let verified;
  try {
    verified = await verifyLogin({
      config: input.config,
      response: { ...input.response, id: passkey.credentialId, rawId: passkey.credentialId },
      expectedChallenge: stored.challenge,
      credential: { id: passkey.credentialId, publicKey: base64UrlToBytes(passkey.credentialPublicKey), counter: passkey.counter, transports: passkey.transports ?? undefined },
    });
  } catch {
    return { outcome: "rejected", reason: SAFE_LOGIN_VERIFICATION_FAILED };
  }
  if (!verified.verified) return { outcome: "rejected", reason: SAFE_LOGIN_VERIFICATION_FAILED };
  if (!verified.authenticationInfo.userVerified) return { outcome: "rejected", reason: "User verification was not performed." };

  await input.registry.updateAuthenticatorCounter({ credentialId: passkey.credentialId, counter: verified.authenticationInfo.newCounter });
  const advanced = await input.enrollments.transition({ id: enrollment.id, from: "turnkey_authenticator_created", to: "login_verified", patch: { loginVerifiedAt: new Date().toISOString() } });
  if (advanced) return { outcome: "verified" };
  // Lost the CAS — e.g. 2g-H: another passkey's removal of this pending
  // credential moved the enrollment to 'removal_in_progress' first. Report the truth, never "verified".
  const fresh = await input.enrollments.findById(enrollment.id);
  return fresh?.state === "login_verified" || fresh?.state === "active" ? { outcome: "verified" } : { outcome: "rejected", reason: "This setup is no longer in progress." };
}

// ---------------------------------------------------------------- step 5: Proof B (Turnkey authorization BY the new authenticator)

export type PrepareSigningProofResult =
  | { outcome: "ready"; subOrganizationId: string; ownerAddress: string; rpId: string; authorizingCredentialId: string; digest: Hex }
  | { outcome: "rejected"; reason: string };

/** A fresh random nonce the NEW credential signs via signRawPayload. Nothing is broadcast; no UserOperation, no Safe nonce. */
export async function prepareSigningProof(input: {
  config: RealServerConfig;
  registry: RealAccountRegistry;
  enrollments: BackupPasskeyEnrollmentStore;
  appUserId: string;
  enrollmentId: string;
}): Promise<PrepareSigningProofResult> {
  const enrollment = await loadOwnedEnrollment(input);
  if (!enrollment || !enrollment.newCredentialId || enrollment.state !== "login_verified") {
    return { outcome: "rejected", reason: "This setup is not awaiting authorization verification." };
  }
  const account = await input.registry.findAccountByAppUserId(input.appUserId);
  if (!account) return { outcome: "rejected", reason: "No account found for this session." };
  const digest = `0x${bytesToHex(randomBytes(32))}` as Hex;
  const claimed = await input.enrollments.transition({ id: enrollment.id, from: "login_verified", to: "login_verified", patch: { signingProofChallenge: digest } });
  if (!claimed) return { outcome: "rejected", reason: "This setup changed; please retry." };
  return { outcome: "ready", subOrganizationId: account.subOrganizationId, ownerAddress: account.ownerAddress, rpId: input.config.rpId, authorizingCredentialId: enrollment.newCredentialId, digest };
}

export type ConfirmSigningProofResult = { outcome: "active" } | { outcome: "rejected"; reason: string };

function normalizePublicKey(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Proof B, attributed to the NEW authenticator specifically. Owner-address
 * recovery alone can't tell the backup from the primary (both authorize the
 * same wallet key), so this reads the signRawPayload activity back
 * (read-only getActivity) and requires ALL of:
 *   - same child org, ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2, COMPLETED;
 *   - its intent signs exactly the stored nonce with the canonical owner;
 *   - an APPROVED vote, for this activity, by this Turnkey user, whose
 *     publicKey equals the enrolled authenticator's credential.publicKey
 *     (recorded from getUsers at creation confirmation);
 *   - the activity's own signature result recovers to the canonical owner.
 * Only then: ONE atomic activation (enrollment and passkey -> active).
 */
export async function confirmSigningProof(input: {
  config: RealServerConfig;
  registry: RealAccountRegistry;
  enrollments: BackupPasskeyEnrollmentStore;
  appUserId: string;
  enrollmentId: string;
  activityId: string;
}): Promise<ConfirmSigningProofResult> {
  const enrollment = await loadOwnedEnrollment(input);
  if (!enrollment) return { outcome: "rejected", reason: "Unknown setup." };
  if (enrollment.state === "active") return { outcome: "active" };
  if (enrollment.state !== "login_verified" || !enrollment.signingProofChallenge || !enrollment.turnkeyAuthenticatorPublicKey || !enrollment.loginVerifiedAt) {
    return { outcome: "rejected", reason: "This setup is not awaiting authorization verification." };
  }
  const account = await input.registry.findAccountByAppUserId(input.appUserId);
  if (!account) return { outcome: "rejected", reason: "No account found for this session." };

  const activity = await readTurnkeyActivity({ config: input.config, subOrganizationId: account.subOrganizationId, activityId: input.activityId });
  if (!activity || activity.id !== input.activityId || activity.organizationId !== account.subOrganizationId || activity.type !== SIGN_ACTIVITY_TYPE) {
    return { outcome: "rejected", reason: "The authorization proof could not be verified." };
  }
  if (activity.status !== COMPLETED_STATUS) return { outcome: "rejected", reason: "The authorization proof isn't complete yet. Try again." };

  const intent = (activity.raw.intent as { signRawPayloadIntentV2?: Record<string, unknown> } | undefined)?.signRawPayloadIntentV2;
  if (
    !intent ||
    typeof intent.signWith !== "string" ||
    !addressesEqual(intent.signWith, account.ownerAddress) ||
    typeof intent.payload !== "string" ||
    intent.payload.toLowerCase() !== enrollment.signingProofChallenge.toLowerCase() ||
    intent.hashFunction !== "HASH_FUNCTION_NO_OP" ||
    intent.encoding !== "PAYLOAD_ENCODING_HEXADECIMAL"
  ) {
    return { outcome: "rejected", reason: "The authorization proof signed something other than this setup's challenge." };
  }

  const expectedKey = normalizePublicKey(enrollment.turnkeyAuthenticatorPublicKey);
  const votes = Array.isArray(activity.raw.votes) ? (activity.raw.votes as Array<Record<string, unknown>>) : [];
  const attributed = votes.some(
    (vote) =>
      vote.selection === "VOTE_SELECTION_APPROVED" &&
      vote.activityId === activity.id &&
      vote.userId === account.turnkeyUserId &&
      expectedKey !== "" &&
      normalizePublicKey(vote.publicKey) === expectedKey,
  );
  if (!attributed) return { outcome: "rejected", reason: "The authorization wasn't approved by the new backup passkey." };

  const result = (activity.raw.result as { signRawPayloadResult?: { r?: string; s?: string; v?: string } } | undefined)?.signRawPayloadResult;
  if (!result?.r || !result.s || !result.v) return { outcome: "rejected", reason: "The authorization proof has no signature." };
  let recovered: string;
  try {
    recovered = await recoverAddress({ hash: enrollment.signingProofChallenge as Hex, signature: serializeTurnkeyRawSignature({ r: result.r, s: result.s, v: result.v }) });
  } catch {
    return { outcome: "rejected", reason: "The authorization proof could not be verified." };
  }
  if (!addressesEqual(recovered, account.ownerAddress)) return { outcome: "rejected", reason: "The authorization proof did not recover the account owner." };

  const activated = await input.enrollments.activate({ id: enrollment.id, signingProofActivityId: activity.id });
  if (activated) return { outcome: "active" };
  const fresh = await input.enrollments.findById(enrollment.id);
  return fresh?.state === "active" ? { outcome: "active" } : { outcome: "rejected", reason: "Activation could not be completed; check status and retry." };
}
