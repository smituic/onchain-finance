import { randomUUID } from "node:crypto";
import { DuplicateCredentialError, getInMemoryRegistryInternals, type RealAccountRegistry, type RealPasskeyRecord } from "./registry";

/**
 * Durable enrollment of a second (backup) passkey against the SAME Turnkey
 * user. See schema.sql's backup_passkey_enrollments comment and
 * backup-passkey-pipeline.ts for the step functions:
 *
 *   started -> credential_registered -> turnkey_enrollment_in_flight
 *     -> turnkey_authenticator_created -> login_verified -> active
 *   off-ramps: abandoned (no outstanding Turnkey attempt), blocked (ambiguous)
 */
export type BackupPasskeyEnrollmentState =
  | "started"
  | "credential_registered"
  | "turnkey_enrollment_in_flight"
  | "turnkey_authenticator_created"
  | "login_verified"
  | "active"
  | "abandoned"
  | "blocked";

export const TERMINAL_ENROLLMENT_STATES: readonly BackupPasskeyEnrollmentState[] = ["active", "abandoned", "blocked"];

export type EnrollmentExternalOutcome = "not_attempted" | "unknown" | "confirmed_created" | "definitive_failure";

export type BackupPasskeyEnrollment = {
  id: string;
  appUserId: string;
  newCredentialId: string | null;
  userHandle: string | null;
  credentialPublicKey: string | null;
  counter: number | null;
  transports: string[] | null;
  credentialDeviceType: "singleDevice" | "multiDevice" | null;
  credentialBackedUp: boolean | null;
  registrationChallenge: string | null;
  rawClientDataJson: string | null;
  rawAttestationObject: string | null;
  state: BackupPasskeyEnrollmentState;
  externalOutcome: EnrollmentExternalOutcome;
  externalEnrollmentAttemptedAt: string | null;
  /** The EXISTING credential whose fresh WebAuthn stamp authorized createAuthenticators — always the caller's session credential, recorded server-side. */
  authorizingCredentialId: string | null;
  turnkeyRequestEndpoint: string | null;
  /** The exact signed body string — forwarded byte-for-byte, never re-serialized. */
  turnkeyRequestBody: string | null;
  turnkeyRequestBodySha256: string | null;
  turnkeyRequestTimestampMs: number | null;
  /** JSON of the WebAuthn stamp header — a live, body-bound bearer credential; cleared once an activity id is known or the replay window closes. */
  turnkeyRequestStamp: string | null;
  turnkeyActivityId: string | null;
  turnkeyActivityStatus: string | null;
  turnkeyAuthenticatorId: string | null;
  /** credential.publicKey of the enrolled authenticator as read back from getUsers — Proof B requires an APPROVED vote from exactly this key. */
  turnkeyAuthenticatorPublicKey: string | null;
  signingProofChallenge: string | null;
  signingProofActivityId: string | null;
  loginVerifiedAt: string | null;
  signingVerifiedAt: string | null;
  blockReason: string | null;
  createdAt: string;
  updatedAt: string;
};

/** undefined = leave unchanged; null = clear. */
export type BackupPasskeyEnrollmentPatch = {
  externalOutcome?: EnrollmentExternalOutcome;
  externalEnrollmentAttemptedAt?: string | null;
  authorizingCredentialId?: string | null;
  turnkeyRequestEndpoint?: string | null;
  turnkeyRequestBody?: string | null;
  turnkeyRequestBodySha256?: string | null;
  turnkeyRequestTimestampMs?: number | null;
  turnkeyRequestStamp?: string | null;
  turnkeyActivityId?: string | null;
  turnkeyActivityStatus?: string | null;
  signingProofChallenge?: string | null;
  loginVerifiedAt?: string | null;
  blockReason?: string | null;
};

export type AttachCredentialInput = {
  credentialId: string;
  userHandle: string;
  credentialPublicKey: string;
  counter: number;
  transports: string[] | null;
  credentialDeviceType: "singleDevice" | "multiDevice" | null;
  credentialBackedUp: boolean | null;
  registrationChallenge: string;
  rawClientDataJson: string;
  rawAttestationObject: string;
};

/** Clears every recorded field of an external create attempt — used only when Turnkey itself proved that attempt created nothing. */
export const CLEARED_TURNKEY_REQUEST: BackupPasskeyEnrollmentPatch = {
  turnkeyRequestEndpoint: null,
  turnkeyRequestBody: null,
  turnkeyRequestBodySha256: null,
  turnkeyRequestTimestampMs: null,
  turnkeyRequestStamp: null,
  turnkeyActivityId: null,
  turnkeyActivityStatus: null,
};

export interface BackupPasskeyEnrollmentStore {
  /** Null (never throws) if the account already has a non-terminal enrollment — the partial-unique-index-backed one-active-enrollment invariant. */
  createStarted(input: { appUserId: string }): Promise<BackupPasskeyEnrollment | null>;
  findById(id: string): Promise<BackupPasskeyEnrollment | null>;
  findActiveByAppUserId(appUserId: string): Promise<BackupPasskeyEnrollment | null>;

  /**
   * ONE atomic step: inserts the role='backup', status='pending' passkey
   * row, attaches the credential to the enrollment, and moves it
   * 'started' -> 'credential_registered'. A lost CAS (the enrollment is no
   * longer 'started') returns null and leaves NO pending passkey behind.
   * Throws DuplicateCredentialError if the credential id already exists.
   */
  registerCredential(input: { id: string; credential: AttachCredentialInput }): Promise<BackupPasskeyEnrollment | null>;

  /** CAS on the enrollment row alone (single-row transitions). Null, never throws, if not currently `from`. */
  transition(input: { id: string; from: BackupPasskeyEnrollmentState; to: BackupPasskeyEnrollmentState; patch?: BackupPasskeyEnrollmentPatch }): Promise<BackupPasskeyEnrollment | null>;

  /**
   * ONE atomic step, after Turnkey's creation has been independently
   * confirmed: enrollment 'turnkey_enrollment_in_flight' ->
   * 'turnkey_authenticator_created' (externalOutcome confirmed_created, stamp
   * cleared) and the pending passkey gains its turnkeyAuthenticatorId.
   */
  confirmCreated(input: { id: string; turnkeyAuthenticatorId: string; turnkeyAuthenticatorPublicKey: string; turnkeyActivityStatus: string | null }): Promise<BackupPasskeyEnrollment | null>;

  /**
   * ONE atomic step, only once both proofs exist: enrollment 'login_verified'
   * (loginVerifiedAt set) -> 'active' and passkey 'pending' -> 'active',
   * together or not at all.
   */
  activate(input: { id: string; signingProofActivityId: string }): Promise<BackupPasskeyEnrollment | null>;

  /**
   * ONE atomic step, only while no Turnkey attempt is outstanding ('started',
   * or 'credential_registered' with externalOutcome not_attempted /
   * definitive_failure): enrollment -> 'abandoned', any pending passkey ->
   * 'revoked' (it never reached Turnkey, so that is fully truthful).
   */
  abandon(input: { id: string }): Promise<BackupPasskeyEnrollment | null>;
}

function applyPatch(current: BackupPasskeyEnrollment, patch: BackupPasskeyEnrollmentPatch | undefined): BackupPasskeyEnrollment {
  const next = { ...current } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value !== undefined) next[key] = value;
  }
  return next as BackupPasskeyEnrollment;
}

export function isAbandonable(enrollment: BackupPasskeyEnrollment): boolean {
  if (enrollment.state === "started") return true;
  return enrollment.state === "credential_registered" && (enrollment.externalOutcome === "not_attempted" || enrollment.externalOutcome === "definitive_failure");
}

/**
 * Every multi-row operation below runs synchronously end to end (no await
 * between check and write), which is what makes it atomic against
 * concurrent callers in this single-threaded adapter.
 */
export function createInMemoryBackupPasskeyEnrollmentStore(registry: RealAccountRegistry): BackupPasskeyEnrollmentStore {
  const enrollments = new Map<string, BackupPasskeyEnrollment>();
  const { passkeysByCredentialId } = getInMemoryRegistryInternals(registry);

  function activeForAccount(appUserId: string): BackupPasskeyEnrollment | undefined {
    return [...enrollments.values()].find((e) => e.appUserId === appUserId && !TERMINAL_ENROLLMENT_STATES.includes(e.state));
  }

  function save(next: BackupPasskeyEnrollment): BackupPasskeyEnrollment {
    const saved = { ...next, updatedAt: new Date().toISOString() };
    enrollments.set(saved.id, saved);
    return saved;
  }

  return {
    async createStarted({ appUserId }) {
      if (activeForAccount(appUserId)) return null;
      const now = new Date().toISOString();
      const enrollment: BackupPasskeyEnrollment = {
        id: randomUUID(),
        appUserId,
        newCredentialId: null,
        userHandle: null,
        credentialPublicKey: null,
        counter: null,
        transports: null,
        credentialDeviceType: null,
        credentialBackedUp: null,
        registrationChallenge: null,
        rawClientDataJson: null,
        rawAttestationObject: null,
        state: "started",
        externalOutcome: "not_attempted",
        externalEnrollmentAttemptedAt: null,
        authorizingCredentialId: null,
        turnkeyRequestEndpoint: null,
        turnkeyRequestBody: null,
        turnkeyRequestBodySha256: null,
        turnkeyRequestTimestampMs: null,
        turnkeyRequestStamp: null,
        turnkeyActivityId: null,
        turnkeyActivityStatus: null,
        turnkeyAuthenticatorId: null,
        turnkeyAuthenticatorPublicKey: null,
        signingProofChallenge: null,
        signingProofActivityId: null,
        loginVerifiedAt: null,
        signingVerifiedAt: null,
        blockReason: null,
        createdAt: now,
        updatedAt: now,
      };
      enrollments.set(enrollment.id, enrollment);
      return enrollment;
    },

    async findById(id) {
      return enrollments.get(id) ?? null;
    },

    async findActiveByAppUserId(appUserId) {
      return activeForAccount(appUserId) ?? null;
    },

    async registerCredential({ id, credential }) {
      const current = enrollments.get(id);
      if (passkeysByCredentialId.has(credential.credentialId) || [...enrollments.values()].some((e) => e.newCredentialId === credential.credentialId)) {
        throw new DuplicateCredentialError(credential.credentialId);
      }
      if (!current || current.state !== "started") return null;

      const passkey: RealPasskeyRecord = {
        credentialId: credential.credentialId,
        appUserId: current.appUserId,
        credentialPublicKey: credential.credentialPublicKey,
        userHandle: credential.userHandle,
        counter: credential.counter,
        transports: credential.transports,
        credentialDeviceType: credential.credentialDeviceType,
        credentialBackedUp: credential.credentialBackedUp,
        status: "pending",
        role: "backup",
        turnkeyAuthenticatorId: null,
        createdAt: new Date().toISOString(),
      };
      passkeysByCredentialId.set(passkey.credentialId, passkey);
      return save({
        ...current,
        newCredentialId: credential.credentialId,
        userHandle: credential.userHandle,
        credentialPublicKey: credential.credentialPublicKey,
        counter: credential.counter,
        transports: credential.transports,
        credentialDeviceType: credential.credentialDeviceType,
        credentialBackedUp: credential.credentialBackedUp,
        registrationChallenge: credential.registrationChallenge,
        rawClientDataJson: credential.rawClientDataJson,
        rawAttestationObject: credential.rawAttestationObject,
        state: "credential_registered",
      });
    },

    async transition({ id, from, to, patch }) {
      const current = enrollments.get(id);
      if (!current || current.state !== from) return null;
      return save({ ...applyPatch(current, patch), state: to });
    },

    async confirmCreated({ id, turnkeyAuthenticatorId, turnkeyAuthenticatorPublicKey, turnkeyActivityStatus }) {
      const current = enrollments.get(id);
      if (!current || current.state !== "turnkey_enrollment_in_flight" || !current.newCredentialId) return null;
      const passkey = passkeysByCredentialId.get(current.newCredentialId);
      if (!passkey || passkey.status !== "pending" || passkey.turnkeyAuthenticatorId !== null) return null;
      if ([...passkeysByCredentialId.values()].some((p) => p.turnkeyAuthenticatorId === turnkeyAuthenticatorId)) return null;

      passkeysByCredentialId.set(passkey.credentialId, { ...passkey, turnkeyAuthenticatorId });
      return save({
        ...current,
        state: "turnkey_authenticator_created",
        externalOutcome: "confirmed_created",
        turnkeyAuthenticatorId,
        turnkeyAuthenticatorPublicKey,
        turnkeyActivityStatus: turnkeyActivityStatus ?? current.turnkeyActivityStatus,
        turnkeyRequestStamp: null,
      });
    },

    async activate({ id, signingProofActivityId }) {
      const current = enrollments.get(id);
      if (!current || current.state !== "login_verified" || !current.loginVerifiedAt || !current.newCredentialId) return null;
      const passkey = passkeysByCredentialId.get(current.newCredentialId);
      if (!passkey || passkey.status !== "pending" || passkey.appUserId !== current.appUserId || !passkey.turnkeyAuthenticatorId) return null;

      passkeysByCredentialId.set(passkey.credentialId, { ...passkey, status: "active" });
      return save({ ...current, state: "active", signingProofActivityId, signingVerifiedAt: new Date().toISOString() });
    },

    async abandon({ id }) {
      const current = enrollments.get(id);
      if (!current || !isAbandonable(current)) return null;
      if (current.newCredentialId) {
        const passkey = passkeysByCredentialId.get(current.newCredentialId);
        if (passkey && passkey.status === "pending") passkeysByCredentialId.set(passkey.credentialId, { ...passkey, status: "revoked" });
      }
      return save({ ...current, state: "abandoned", turnkeyRequestStamp: null });
    },
  };
}
