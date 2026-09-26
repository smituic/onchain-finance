import { randomUUID } from "node:crypto";
import { DuplicateCredentialError, getInMemoryRegistryInternals, type RealAccountRegistry, type RealPasskeyRecord } from "./registry";

/**
 * Durable enrollment of a second (backup) passkey against the SAME Turnkey
 * user. See schema.sql's backup_passkey_enrollments comment and
 * backup-passkey-pipeline.ts for the step functions:
 *
 *   started -> credential_registered -> turnkey_enrollment_in_flight
 *     -> turnkey_authenticator_created -> login_verified -> active
 *   off-ramps:
 *     abandoned            only while no Turnkey authority can exist (nothing
 *                          dispatched, or Turnkey authoritatively failed the
 *                          one request we ever sent) — terminal
 *     blocked              (2g-H: NOT terminal) the create may have reached
 *                          Turnkey but its outcome is ambiguous — "setup needs
 *                          review"; holds the slot; an exact single credential
 *                          match later moves it to turnkey_authenticator_created
 *     removal_in_progress  (2g-H) another active passkey dispatched the delete
 *                          of this pending-but-live credential; activation is
 *                          impossible; holds the slot until the delete is
 *                          confirmed (retryable if the removal blocks)
 *     removed              (2g-H) the delete is confirmed (completed activity
 *                          + absence read) — terminal
 *
 * AUTHORITY INVARIANT: no state in which a Turnkey authenticator for this
 * credential may exist is at once shown as harmless, neither removable nor
 * reconcilable, AND frees the one-open-enrollment slot.
 */
export type BackupPasskeyEnrollmentState =
  | "started"
  | "credential_registered"
  | "turnkey_enrollment_in_flight"
  | "turnkey_authenticator_created"
  | "login_verified"
  | "active"
  | "abandoned"
  | "blocked"
  | "removal_in_progress"
  | "removed";

/** Only these free the one-open-enrollment slot (schema.sql's backup_passkey_enrollments_one_open_per_account). */
export const TERMINAL_ENROLLMENT_STATES: readonly BackupPasskeyEnrollmentState[] = ["active", "abandoned", "removed"];

/**
 * 2g-H: the states in which the pending passkey already has a CONFIRMED
 * Turnkey authenticator (confirmCreated mapped it) but isn't active yet — it
 * may already authorize at Turnkey, so another active passkey may remove it.
 * The removal's dispatch transaction moves the enrollment to
 * 'removal_in_progress' (activation impossible, slot still held).
 */
export const REMOVABLE_PENDING_ENROLLMENT_STATES: readonly BackupPasskeyEnrollmentState[] = ["turnkey_authenticator_created", "login_verified"];

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
  /**
   * 2g-H: the session credential whose fresh step-up assertion authorized the
   * registration challenge this enrollment's new credential answered. Null
   * only for credentials attached before 2g-H — never offered for Turnkey
   * authorization (a stolen cookie could have chosen them); abandon only.
   */
  registrationStepUpCredentialId: string | null;
  /** 2g-H: identifies the newest registration challenge minted for this enrollment; any older challenge is superseded. */
  registrationMintId: string | null;
  /** 2g-H: true once reconciliation has (or may have) forwarded a byte-identical replay of the create — a later FAILED activity is then never proof that nothing was created. */
  turnkeyRequestReplayed: boolean;
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
  registrationMintId?: string | null;
  turnkeyRequestReplayed?: boolean;
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
  /** The session credential whose fresh step-up minted the registration challenge (see registrationStepUpCredentialId). */
  stepUpCredentialId: string;
  /** Must equal the enrollment's CURRENT registrationMintId — a challenge from a superseded mint never attaches. */
  registrationMintId: string;
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
  turnkeyRequestReplayed: false,
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
   * confirmed: enrollment 'turnkey_enrollment_in_flight' (or, 2g-H, a
   * 'blocked' review whose exact single credential match was later found) ->
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
   * 2g-H: claims the ONE byte-identical replay of the recorded create —
   * turnkey_request_replayed false -> true, only while in flight with no
   * activity id learned. Null for every other caller, so concurrent
   * reconciles forward at most one replay.
   */
  claimReplay(input: { id: string }): Promise<BackupPasskeyEnrollment | null>;

  /**
   * 2g-H: FIRST WRITER WINS (like revocation recordActivity) — records the
   * create activity id only while in flight with none recorded yet, and
   * clears the stamp. Null if another send already recorded one.
   */
  recordActivity(input: { id: string; activityId: string; activityStatus: string }): Promise<BackupPasskeyEnrollment | null>;

  /**
   * ONE atomic step, only while no Turnkey attempt was EVER dispatched
   * ('started', or 'credential_registered' with externalOutcome
   * not_attempted): enrollment -> 'abandoned', any pending passkey ->
   * 'revoked' (it never reached Turnkey, so that is fully truthful). 2g-H:
   * never after a dispatch — the browser still holds the signed create and
   * could send it to Turnkey itself, so no server-observed failure proves
   * absence.
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

/** 2g-H: only while nothing was EVER dispatched to Turnkey. A (legacy) 'definitive_failure' is uncertain authority, not abandonable. */
export function isAbandonable(enrollment: BackupPasskeyEnrollment): boolean {
  if (enrollment.state === "started") return true;
  return enrollment.state === "credential_registered" && enrollment.externalOutcome === "not_attempted";
}

/**
 * Every multi-row operation below runs synchronously end to end (no await
 * between check and write), which is what makes it atomic against
 * concurrent callers in this single-threaded adapter.
 */
export function createInMemoryBackupPasskeyEnrollmentStore(registry: RealAccountRegistry): BackupPasskeyEnrollmentStore {
  const enrollments = new Map<string, BackupPasskeyEnrollment>();
  const { passkeysByCredentialId, backupEnrollmentMaps } = getInMemoryRegistryInternals(registry);
  // Lets the in-memory revocation store move a removed pending
  // passkey's enrollment synchronously, in the same step as beginDispatch.
  backupEnrollmentMaps.push(enrollments);

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
        registrationStepUpCredentialId: null,
        registrationMintId: null,
        turnkeyRequestReplayed: false,
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
      if (!current || current.state !== "started" || current.registrationMintId !== credential.registrationMintId) return null;

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
        displayName: null,
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
        registrationStepUpCredentialId: credential.stepUpCredentialId,
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
      if (!current || (current.state !== "turnkey_enrollment_in_flight" && current.state !== "blocked") || !current.newCredentialId) return null;
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
        blockReason: null,
      });
    },

    async claimReplay({ id }) {
      const current = enrollments.get(id);
      if (!current || current.state !== "turnkey_enrollment_in_flight" || current.turnkeyActivityId !== null || current.turnkeyRequestReplayed) return null;
      return save({ ...current, turnkeyRequestReplayed: true });
    },

    async recordActivity({ id, activityId, activityStatus }) {
      const current = enrollments.get(id);
      if (!current || current.state !== "turnkey_enrollment_in_flight" || current.turnkeyActivityId !== null) return null;
      return save({ ...current, turnkeyActivityId: activityId, turnkeyActivityStatus: activityStatus, turnkeyRequestStamp: null });
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
