import { createHash, randomUUID } from "node:crypto";
import { credentialIdsEqual } from "../credential-id";
import { addressesEqual } from "../identifiers";
import {
  DuplicateAccountError,
  DuplicateCredentialError,
  IdentityConflictError,
  accountIdentitiesConflict,
  getInMemoryRegistryInternals,
  type RealAccountRecord,
  type RealAccountRegistry,
  type RealPasskeyRecord,
} from "./registry";

/**
 * The durable onboarding workflow. A row is written the instant a WebAuthn
 * registration is independently verified — BEFORE Turnkey is ever called —
 * so a process crash between verification and account activation is always
 * recoverable (see server/onboarding.ts's runProvisioningPipeline, shared
 * by registration and login-recovery).
 *
 *   verified -> provisioning_in_flight -> turnkey_created -> active (finalize only)
 *        ^               |                    \-> blocked (identity conflict, at finalize)
 *        \_______________/  (only on a Turnkey-CONFIRMED definitive failure —
 *                             see externalOutcome below)
 *
 * "active" is finalize-only (S5 L2): transition() never moves an attempt to
 * or from it, so an attempt is active exactly when finalize committed its
 * account + passkey rows.
 *
 * "provisioning_in_flight" is claim-only (Provisioning Evidence Capture):
 * transition() never moves an attempt to or from it either. The ONLY way in
 * is beginProvisioningDispatch (the claim + its evidence row, atomically);
 * the ONLY ways out are revertProvisioningAfterDefinitiveFailure and
 * advanceProvisioningToTurnkeyCreated, each a CAS that also requires the
 * matching in-process ("dispatch") terminal observation on that attempt's
 * newest evidence row. Nothing an operator records can satisfy either.
 *
 * "provisioning_in_flight" means "an external createSubOrganization call for
 * this credential has begun and we do not yet have a definitive result" —
 * `externalOutcome` records exactly why:
 *
 *   not_attempted      no external call has ever begun for this attempt.
 *   unknown            a call was dispatched but its outcome was never
 *                       learned (network error, timeout, lost response,
 *                       process death mid-call) — NOT proof of failure.
 *   confirmed_created  Turnkey returned a complete, successful result.
 *   definitive_failure Turnkey's own activity ledger resolved this specific
 *                       attempt to a terminal FAILED/REJECTED status — the
 *                       only signal strong enough to prove no child was
 *                       created (see provisioning-dispatch.ts).
 *
 * The critical invariant this state machine enforces: once externalOutcome
 * becomes "unknown", nothing may dispatch a create again for this attempt
 * automatically, and (S5 L2, Option 3) nothing adopts a Turnkey
 * resource for it either: a sub-org that merely contains this credential
 * proves neither that our request created it nor that no other authority
 * exists in it. The only automatic exits from "provisioning_in_flight" are
 * the in-process outcomes of the ONE dispatch: Turnkey's own successful
 * response (-> turnkey_created) or a Turnkey-confirmed definitive failure
 * (-> back to "verified", externalOutcome "definitive_failure", safe to
 * attempt again because Turnkey itself proved nothing was created). A lost
 * response leaves it "provisioning_in_flight" / "unknown", reported as
 * needing review, until a future operator-only resolver exists.
 *
 * Provisioning Evidence Capture: "verified -> provisioning_in_flight" for a
 * real dispatch goes through beginProvisioningDispatch, which commits the
 * claim TOGETHER with one immutable evidence row (ProvisioningDispatch: the
 * exact request body + its digest) before anything is stamped or sent. That
 * row is evidence for the future resolver only — nothing here reads it back
 * to move an attempt out of "provisioning_in_flight".
 */
export type RegistrationAttemptState = "verified" | "provisioning_in_flight" | "turnkey_created" | "active" | "blocked";

export type ExternalProvisioningOutcome = "not_attempted" | "unknown" | "confirmed_created" | "definitive_failure";

export type RegistrationAttempt = {
  credentialId: string;
  appUserId: string;
  userHandle: string;
  credentialPublicKey: string;
  counter: number;
  transports: string[] | null;
  credentialDeviceType: "singleDevice" | "multiDevice" | null;
  credentialBackedUp: boolean | null;
  /**
   * Public WebAuthn ceremony artifacts — never signing/private material —
   * kept so the Turnkey provisioning request is built from durable state
   * (also after a Turnkey-confirmed definitive failure, via login recovery).
   */
  registrationChallenge: string;
  rawClientDataJson: string;
  rawAttestationObject: string;
  state: RegistrationAttemptState;
  externalOutcome: ExternalProvisioningOutcome;
  externalProvisioningAttemptedAt: string | null;
  subOrganizationId: string | null;
  turnkeyUserId: string | null;
  walletId: string | null;
  walletAccountId: string | null;
  ownerAddress: string | null;
  safeAddress: string | null;
  accountConfigVersion: number | null;
  blockReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RegistrationAttemptPatch = Partial<
  Pick<
    RegistrationAttempt,
    | "subOrganizationId"
    | "turnkeyUserId"
    | "walletId"
    | "walletAccountId"
    | "ownerAddress"
    | "safeAddress"
    | "accountConfigVersion"
    | "blockReason"
    | "counter"
    | "externalOutcome"
    | "externalProvisioningAttemptedAt"
  >
>;

export type DispatchTerminalStatus = "ACTIVITY_STATUS_COMPLETED" | "ACTIVITY_STATUS_FAILED" | "ACTIVITY_STATUS_REJECTED";
export const DISPATCH_TERMINAL_STATUSES: readonly DispatchTerminalStatus[] = ["ACTIVITY_STATUS_COMPLETED", "ACTIVITY_STATUS_FAILED", "ACTIVITY_STATUS_REJECTED"];
export type DispatchObservedBy = "dispatch" | "operator_poll";
/** exact: key-order-insensitive deep equality with what we sent. fields_only: everything we sent is echoed unchanged, plus keys we did not send. */
export type DispatchIntentVerdict = "exact" | "fields_only" | "mismatch";
/** Against OUR request_body_sha256. unrecognized_form: not "sha256:<64 lowercase hex>", so no comparison was possible. */
export type DispatchFingerprintVerdict = "match" | "mismatch" | "unrecognized_form";
export type DispatchVoteVerdict = "parent_key" | "other";

export const DISPATCH_FAILURE_MESSAGE_MAX_LENGTH = 500;
export const DISPATCH_FINGERPRINT_MAX_LENGTH = 200;

/**
 * One external CREATE_SUB_ORGANIZATION dispatch (schema.sql's
 * registration_provisioning_dispatches). Three groups with different rules:
 *
 *   immutable at insert   id … createdAt. requestBody is the EXACT string
 *                          that is stamped and sent; requestBodySha256 is OUR
 *                          digest of its UTF-8 bytes. Never updated.
 *   write-once            the activity identity (id + Turnkey's fingerprint,
 *                          stored verbatim — a separate thing from our
 *                          digest), then the terminal observation.
 *   mutable               lastObserved* / updatedAt only.
 *
 * The observed* result ids are EVIDENCE. They are never inputs to the
 * attempt's own identity columns: those come only from the in-process
 * response to the dispatch itself (onboarding.ts).
 */
export type ProvisioningDispatch = {
  id: string;
  credentialId: string;
  dispatchSeq: number;
  evidenceVersion: number;
  organizationId: string;
  stampPublicKey: string;
  requestTimestampMs: number;
  requestBody: string;
  requestBodySha256: string;
  createdAt: string;
  turnkeyActivityId: string | null;
  turnkeyActivityFingerprint: string | null;
  activityRecordedAt: string | null;
  terminalStatus: DispatchTerminalStatus | null;
  terminalObservedAt: string | null;
  terminalObservedBy: DispatchObservedBy | null;
  turnkeyCreatedAt: string | null;
  observedSubOrganizationId: string | null;
  observedRootUserId: string | null;
  observedWalletId: string | null;
  observedOwnerAddress: string | null;
  failureCode: number | null;
  failureMessage: string | null;
  intentVerdict: DispatchIntentVerdict | null;
  fingerprintVerdict: DispatchFingerprintVerdict | null;
  voteVerdict: DispatchVoteVerdict | null;
  lastObservedStatus: string | null;
  lastObservedAt: string | null;
  updatedAt: string;
};

export type ProvisioningDispatchEvidence = Pick<
  ProvisioningDispatch,
  "evidenceVersion" | "organizationId" | "stampPublicKey" | "requestTimestampMs" | "requestBody" | "requestBodySha256"
>;

export type DispatchTerminalObservation = {
  status: DispatchTerminalStatus;
  observedBy: DispatchObservedBy;
  turnkeyCreatedAt: string | null;
  observedSubOrganizationId: string | null;
  observedRootUserId: string | null;
  observedWalletId: string | null;
  observedOwnerAddress: string | null;
  failureCode: number | null;
  failureMessage: string | null;
  intentVerdict: DispatchIntentVerdict;
  fingerprintVerdict: DispatchFingerprintVerdict;
  voteVerdict: DispatchVoteVerdict;
};

/** already_recorded: the SAME id was recorded before (an idempotent replay). mismatch: a DIFFERENT id is recorded — it is never replaced. */
export type RecordDispatchActivityResult =
  | { outcome: "recorded" | "already_recorded" | "mismatch"; dispatch: ProvisioningDispatch }
  | { outcome: "not_found" };

/** already_terminal: a terminal observation exists and was left untouched. activity_mismatch: the row's recorded activity id is absent or different. */
export type RecordDispatchTerminalResult =
  | { outcome: "recorded" | "already_terminal" | "activity_mismatch"; dispatch: ProvisioningDispatch }
  | { outcome: "not_found" };

const SHA256_HEX = /^[0-9a-f]{64}$/;

function sha256HexOfUtf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Server-only, vendor-neutral — mirrors registry.ts's own shape. Route
 * handlers and the shared onboarding pipeline depend on this interface,
 * never on a specific backing store.
 */
export interface RegistrationAttemptStore {
  /**
   * The durable pre-commit. Rejects (DuplicateCredentialError /
   * DuplicateAccountError) rather than overwriting an existing attempt —
   * a retry for an already-attempted credential must go through login
   * recovery (see onboarding.ts), never create a second attempt row.
   */
  createVerified(input: {
    credentialId: string;
    appUserId: string;
    userHandle: string;
    credentialPublicKey: string;
    counter: number;
    transports: string[] | null;
    credentialDeviceType: "singleDevice" | "multiDevice" | null;
    credentialBackedUp: boolean | null;
    registrationChallenge: string;
    rawClientDataJson: string;
    rawAttestationObject: string;
  }): Promise<RegistrationAttempt>;

  findByCredentialId(credentialId: string): Promise<RegistrationAttempt | null>;

  /**
   * Concurrency-safe compare-and-swap: applies only if the attempt is
   * currently in `from` state. Returns null if another concurrent caller
   * already moved it — the caller re-reads and decides rather than assuming
   * its own view is still current. Throws (assertGenericTransition) for any
   * transition to or from "active" (finalize-only) or "provisioning_in_flight"
   * (claim-only — see the dedicated operations below).
   */
  transition(input: {
    credentialId: string;
    from: RegistrationAttemptState;
    to: RegistrationAttemptState;
    patch?: RegistrationAttemptPatch;
  }): Promise<RegistrationAttempt | null>;

  updateCounter(input: { credentialId: string; counter: number }): Promise<void>;

  /**
   * The pre-dispatch durability point. ONE atomic operation: the
   * "verified" -> "provisioning_in_flight" CAS (externalOutcome "unknown")
   * and the INSERT of exactly one evidence row, the next dispatch_seq for
   * this attempt. No network call. Returns null when the CAS is lost —
   * nothing was inserted and the caller must not dispatch. Throws when the
   * evidence violates a constraint (malformed/wrong digest, a body digest or
   * an open dispatch that already exists): that transaction rolls back, the
   * claim is NOT made, the attempt stays "verified", and nothing may be
   * dispatched. (It can also throw AFTER a commit whose response was lost:
   * then the claim and evidence are durable and nothing was sent — the
   * attempt is in review, fail closed.) An earlier dispatch row is never
   * overwritten.
   */
  beginProvisioningDispatch(input: {
    credentialId: string;
    attemptedAt: string;
    evidence: ProvisioningDispatchEvidence;
  }): Promise<{ attempt: RegistrationAttempt; dispatch: ProvisioningDispatch } | null>;

  /** First writer wins: records the activity id (and Turnkey's fingerprint, verbatim) once. A different id never replaces a recorded one. */
  recordDispatchActivity(input: { dispatchId: string; activityId: string; fingerprint: string | null }): Promise<RecordDispatchActivityResult>;

  /** Write-once terminal observation, only for the row's already-recorded activity id. Never touches the request evidence or the activity identity. */
  recordDispatchTerminal(input: { dispatchId: string; activityId: string; observation: DispatchTerminalObservation }): Promise<RecordDispatchTerminalResult>;

  /** Mutable metadata only (lastObservedStatus / lastObservedAt), for an open dispatch's recorded activity id. Returns whether a row was updated. */
  recordDispatchObservation(input: { dispatchId: string; activityId: string; status: string }): Promise<boolean>;

  /** Every dispatch of one attempt, oldest first. */
  findDispatchesByCredentialId(credentialId: string): Promise<ProvisioningDispatch[]>;

  /**
   * "provisioning_in_flight" -> "verified" (externalOutcome
   * "definitive_failure"), as ONE CAS that also requires the attempt's
   * NEWEST dispatch row to be exactly `dispatchId` with activity
   * `activityId` and an in-process terminal observation that proves a
   * definitive failure (dispatchProvesDefinitiveFailure). Anything stale,
   * mismatched, non-terminal, COMPLETED, or recorded by the operator poller
   * -> null, nothing changed.
   */
  revertProvisioningAfterDefinitiveFailure(input: { credentialId: string; dispatchId: string; activityId: string }): Promise<RegistrationAttempt | null>;

  /**
   * "provisioning_in_flight" -> "turnkey_created" with `identity`
   * (externalOutcome "confirmed_created"), as ONE CAS that also requires the
   * attempt's NEWEST dispatch row to be exactly `dispatchId` with activity
   * `activityId`, an in-process COMPLETED observation with an exact intent,
   * and observed result ids EQUAL to `identity` (dispatchProvesCreated). The
   * observed ids are only compared, never copied: the identity written is
   * the in-process response's. Otherwise null, nothing changed.
   */
  advanceProvisioningToTurnkeyCreated(input: { credentialId: string; dispatchId: string; activityId: string; identity: ProvisionedIdentity }): Promise<RegistrationAttempt | null>;

  /**
   * The one atomic activation step (S5 L3): the attempt's "turnkey_created"
   * -> "active" CAS and the real_accounts + real_passkeys writes commit
   * together or not at all, and an invocation that does NOT win that CAS
   * can never write either row — structurally, not because some other
   * constraint happens to conflict. Returns records only to the invocation
   * that won; null otherwise (lost race, already finalized, blocked, or a
   * conflicting existing row) — never an existing account found by
   * appUserId. The caller re-reads and checks accountMatchesAttempt.
   */
  finalize(input: {
    credentialId: string;
    registry: RealAccountRegistry;
    safeAddress: string;
    /**
     * S5 L2: the owner `safeAddress` was derived from. The CAS wins only if
     * the LOCKED attempt's owner still equals it (addressesEqual semantics);
     * otherwise nothing is written and the caller re-derives.
     */
    safeOwnerAddress: string;
    accountConfigVersion: number;
  }): Promise<{ account: RealAccountRecord; passkey: RealPasskeyRecord } | null>;
}

/**
 * S5 L2: written to block_reason when finalize finds that another account
 * already holds this attempt's sub-org, owner, or Safe (case-insensitively).
 * The attempt moves turnkey_created -> blocked; no automatic recovery.
 */
export const REGISTRATION_IDENTITY_CONFLICT_REASON = "This account's Turnkey identity is already linked to another account; manual review is required.";

/**
 * S5 L2: "active" is finalize-only. Provisioning Evidence Capture:
 * "provisioning_in_flight" is claim-only. A generic transition() to or from
 * either is a programming error, never a CAS miss.
 */
export function assertGenericTransition(from: RegistrationAttemptState, to: RegistrationAttemptState): void {
  if (from === "active" || to === "active") throw new Error("Registration attempts enter and leave 'active' only through finalize().");
  if (from === "provisioning_in_flight" || to === "provisioning_in_flight") {
    throw new Error("Registration attempts enter 'provisioning_in_flight' only through beginProvisioningDispatch(), and leave it only through its two evidence-bound operations.");
  }
}

/** The identity a validated, in-process COMPLETED create supplies for "turnkey_created". */
export type ProvisionedIdentity = { subOrganizationId: string; turnkeyUserId: string; walletId: string; walletAccountId: string; ownerAddress: string };

/**
 * The evidence a definitive-failure revert requires, on the attempt's newest
 * dispatch row — the twin of the Neon CAS's EXISTS clause. Recorded by the
 * in-process dispatch itself (never the operator poller), FAILED/REJECTED,
 * for exactly this activity, and positively tied to our body: no fingerprint
 * mismatch, and an exact intent — or extra echoed keys only when the
 * recognized fingerprint matches our digest.
 */
export function dispatchProvesDefinitiveFailure(row: ProvisioningDispatch, activityId: string): boolean {
  return (
    row.turnkeyActivityId === activityId &&
    (row.terminalStatus === "ACTIVITY_STATUS_FAILED" || row.terminalStatus === "ACTIVITY_STATUS_REJECTED") &&
    row.terminalObservedBy === "dispatch" &&
    (row.fingerprintVerdict === "match" || row.fingerprintVerdict === "unrecognized_form") &&
    (row.intentVerdict === "exact" || (row.intentVerdict === "fields_only" && row.fingerprintVerdict === "match"))
  );
}

/** The evidence "turnkey_created" requires — the twin of the Neon CAS's EXISTS clause. COMPLETED only with an EXACT intent; the observed ids must equal the identity being written. */
export function dispatchProvesCreated(row: ProvisioningDispatch, activityId: string, identity: ProvisionedIdentity): boolean {
  return (
    row.turnkeyActivityId === activityId &&
    row.terminalStatus === "ACTIVITY_STATUS_COMPLETED" &&
    row.terminalObservedBy === "dispatch" &&
    row.intentVerdict === "exact" &&
    (row.fingerprintVerdict === "match" || row.fingerprintVerdict === "unrecognized_form") &&
    row.observedSubOrganizationId === identity.subOrganizationId &&
    row.observedRootUserId === identity.turnkeyUserId &&
    row.observedWalletId === identity.walletId &&
    row.observedOwnerAddress === identity.ownerAddress
  );
}

/**
 * S5 L3: the ONLY condition under which an existing account/passkey pair may
 * be reused for a registration attempt (onboarding.ts — an "active" attempt,
 * or a re-read after finalize returned null). Every identity field finalize
 * copies from the attempt must match exactly; the passkey must be this
 * attempt's own credential (decoded-byte equality), still the active primary
 * finalize created. Anything else fails closed — a row merely sharing the
 * appUserId is never enough.
 */
export function accountMatchesAttempt(attempt: RegistrationAttempt, account: RealAccountRecord, passkey: RealPasskeyRecord): boolean {
  return (
    attempt.state === "active" &&
    account.appUserId === attempt.appUserId &&
    account.subOrganizationId === attempt.subOrganizationId &&
    account.turnkeyUserId === attempt.turnkeyUserId &&
    account.walletId === attempt.walletId &&
    account.walletAccountId === attempt.walletAccountId &&
    account.ownerAddress === attempt.ownerAddress &&
    account.safeAddress === attempt.safeAddress &&
    account.accountConfigVersion === attempt.accountConfigVersion &&
    credentialIdsEqual(passkey.credentialId, attempt.credentialId) &&
    passkey.appUserId === attempt.appUserId &&
    passkey.credentialPublicKey === attempt.credentialPublicKey &&
    passkey.userHandle === attempt.userHandle &&
    passkey.status === "active" &&
    passkey.role === "primary"
  );
}

/** The in-memory twin of schema.sql's request-evidence CHECKs (digest form, digest = sha256 of the exact body bytes). */
function assertDispatchEvidence(evidence: ProvisioningDispatchEvidence): void {
  if (!SHA256_HEX.test(evidence.requestBodySha256)) throw new Error("Provisioning dispatch evidence: request_body_sha256 must be 64 lowercase hex characters.");
  if (sha256HexOfUtf8(evidence.requestBody) !== evidence.requestBodySha256) throw new Error("Provisioning dispatch evidence: request_body_sha256 is not the digest of request_body.");
  if (!Number.isSafeInteger(evidence.evidenceVersion) || evidence.evidenceVersion < 1) throw new Error("Provisioning dispatch evidence: invalid evidence_version.");
  if (!Number.isSafeInteger(evidence.requestTimestampMs) || evidence.requestTimestampMs < 0) throw new Error("Provisioning dispatch evidence: invalid request_timestamp_ms.");
  if (!evidence.organizationId || !evidence.stampPublicKey || !evidence.requestBody) throw new Error("Provisioning dispatch evidence: missing required field.");
}

/** The in-memory twin of schema.sql's terminal-observation CHECKs. */
function assertTerminalObservation(observation: DispatchTerminalObservation): void {
  const completed = observation.status === "ACTIVITY_STATUS_COMPLETED";
  const observedResult = [observation.observedSubOrganizationId, observation.observedRootUserId, observation.observedWalletId, observation.observedOwnerAddress];
  if (!completed && observedResult.some((value) => value !== null)) throw new Error("Provisioning dispatch terminal: observed result ids are only valid with a COMPLETED status.");
  if (completed && (observation.failureCode !== null || observation.failureMessage !== null)) throw new Error("Provisioning dispatch terminal: a failure is only valid with a FAILED/REJECTED status.");
  if (observation.failureMessage !== null && observation.failureMessage.length > DISPATCH_FAILURE_MESSAGE_MAX_LENGTH) throw new Error("Provisioning dispatch terminal: failure_message is too long.");
}

export function createInMemoryRegistrationAttemptStore(): RegistrationAttemptStore {
  const attempts = new Map<string, RegistrationAttempt>();
  const appUserIndex = new Map<string, string>(); // appUserId -> credentialId
  const dispatches = new Map<string, ProvisioningDispatch>(); // dispatch id -> row, insertion-ordered
  const newestDispatch = (credentialId: string): ProvisioningDispatch | null =>
    [...dispatches.values()].filter((row) => row.credentialId === credentialId).reduce<ProvisioningDispatch | null>((newest, row) => (!newest || row.dispatchSeq > newest.dispatchSeq ? row : newest), null);

  return {
    async createVerified(input) {
      // Both checks happen before any write, synchronously (no await in
      // between) — see registry.ts's identical reasoning for why this is
      // enough to make the in-memory adapter race-safe under Promise.all.
      if (attempts.has(input.credentialId)) throw new DuplicateCredentialError(input.credentialId);
      if (appUserIndex.has(input.appUserId)) throw new DuplicateAccountError(input.appUserId);

      const now = new Date().toISOString();
      const attempt: RegistrationAttempt = {
        credentialId: input.credentialId,
        appUserId: input.appUserId,
        userHandle: input.userHandle,
        credentialPublicKey: input.credentialPublicKey,
        counter: input.counter,
        transports: input.transports,
        credentialDeviceType: input.credentialDeviceType,
        credentialBackedUp: input.credentialBackedUp,
        registrationChallenge: input.registrationChallenge,
        rawClientDataJson: input.rawClientDataJson,
        rawAttestationObject: input.rawAttestationObject,
        state: "verified",
        externalOutcome: "not_attempted",
        externalProvisioningAttemptedAt: null,
        subOrganizationId: null,
        turnkeyUserId: null,
        walletId: null,
        walletAccountId: null,
        ownerAddress: null,
        safeAddress: null,
        accountConfigVersion: null,
        blockReason: null,
        createdAt: now,
        updatedAt: now,
      };
      attempts.set(input.credentialId, attempt);
      appUserIndex.set(input.appUserId, input.credentialId);
      return attempt;
    },

    async findByCredentialId(credentialId) {
      return attempts.get(credentialId) ?? null;
    },

    async transition({ credentialId, from, to, patch }) {
      assertGenericTransition(from, to);
      const current = attempts.get(credentialId);
      if (!current || current.state !== from) return null;
      // Claimed synchronously — a concurrent caller reading right after this
      // line sees the new state and backs off, exactly like registry.ts's
      // createAccountWithPasskey.
      const next: RegistrationAttempt = { ...current, ...patch, state: to, updatedAt: new Date().toISOString() };
      attempts.set(credentialId, next);
      return next;
    },

    async updateCounter({ credentialId, counter }) {
      const current = attempts.get(credentialId);
      if (!current) return;
      attempts.set(credentialId, { ...current, counter, updatedAt: new Date().toISOString() });
    },

    async beginProvisioningDispatch({ credentialId, attemptedAt, evidence }) {
      // Everything below is synchronous (no await), so the claim and the
      // evidence insert are one step, exactly like the Neon statement. A
      // constraint violation throws BEFORE the claim: the attempt stays
      // "verified", as a failed statement would leave it.
      const current = attempts.get(credentialId);
      if (!current || current.state !== "verified") return null;
      assertDispatchEvidence(evidence);
      const existing = [...dispatches.values()];
      if (existing.some((row) => row.requestBodySha256 === evidence.requestBodySha256)) throw new Error("Provisioning dispatch evidence: this request body was already recorded (request_body_sha256 is unique).");
      const own = existing.filter((row) => row.credentialId === credentialId);
      if (own.some((row) => row.terminalStatus === null)) throw new Error("Provisioning dispatch evidence: this attempt already has an open dispatch.");

      const now = new Date().toISOString();
      const claimed: RegistrationAttempt = { ...current, state: "provisioning_in_flight", externalOutcome: "unknown", externalProvisioningAttemptedAt: attemptedAt, updatedAt: now };
      const dispatch: ProvisioningDispatch = {
        id: randomUUID(),
        credentialId,
        dispatchSeq: own.reduce((max, row) => Math.max(max, row.dispatchSeq), 0) + 1,
        evidenceVersion: evidence.evidenceVersion,
        organizationId: evidence.organizationId,
        stampPublicKey: evidence.stampPublicKey,
        requestTimestampMs: evidence.requestTimestampMs,
        requestBody: evidence.requestBody,
        requestBodySha256: evidence.requestBodySha256,
        createdAt: now,
        turnkeyActivityId: null,
        turnkeyActivityFingerprint: null,
        activityRecordedAt: null,
        terminalStatus: null,
        terminalObservedAt: null,
        terminalObservedBy: null,
        turnkeyCreatedAt: null,
        observedSubOrganizationId: null,
        observedRootUserId: null,
        observedWalletId: null,
        observedOwnerAddress: null,
        failureCode: null,
        failureMessage: null,
        intentVerdict: null,
        fingerprintVerdict: null,
        voteVerdict: null,
        lastObservedStatus: null,
        lastObservedAt: null,
        updatedAt: now,
      };
      attempts.set(credentialId, claimed);
      dispatches.set(dispatch.id, dispatch);
      return { attempt: claimed, dispatch: { ...dispatch } };
    },

    async recordDispatchActivity({ dispatchId, activityId, fingerprint }) {
      const current = dispatches.get(dispatchId);
      if (!current) return { outcome: "not_found" };
      if (current.turnkeyActivityId !== null) {
        return { outcome: current.turnkeyActivityId === activityId ? "already_recorded" : "mismatch", dispatch: { ...current } };
      }
      if (!activityId) throw new Error("Provisioning dispatch activity: an activity id is required.");
      if ([...dispatches.values()].some((row) => row.turnkeyActivityId === activityId)) throw new Error("Provisioning dispatch activity: this activity id is already recorded on another dispatch (turnkey_activity_id is unique).");
      const now = new Date().toISOString();
      const next: ProvisioningDispatch = { ...current, turnkeyActivityId: activityId, turnkeyActivityFingerprint: fingerprint, activityRecordedAt: now, updatedAt: now };
      dispatches.set(dispatchId, next);
      return { outcome: "recorded", dispatch: { ...next } };
    },

    async recordDispatchTerminal({ dispatchId, activityId, observation }) {
      const current = dispatches.get(dispatchId);
      if (!current) return { outcome: "not_found" };
      if (current.turnkeyActivityId === null || current.turnkeyActivityId !== activityId) return { outcome: "activity_mismatch", dispatch: { ...current } };
      if (current.terminalStatus !== null) return { outcome: "already_terminal", dispatch: { ...current } };
      assertTerminalObservation(observation);
      const now = new Date().toISOString();
      const next: ProvisioningDispatch = {
        ...current,
        terminalStatus: observation.status,
        terminalObservedAt: now,
        terminalObservedBy: observation.observedBy,
        turnkeyCreatedAt: observation.turnkeyCreatedAt,
        observedSubOrganizationId: observation.observedSubOrganizationId,
        observedRootUserId: observation.observedRootUserId,
        observedWalletId: observation.observedWalletId,
        observedOwnerAddress: observation.observedOwnerAddress,
        failureCode: observation.failureCode,
        failureMessage: observation.failureMessage,
        intentVerdict: observation.intentVerdict,
        fingerprintVerdict: observation.fingerprintVerdict,
        voteVerdict: observation.voteVerdict,
        lastObservedStatus: observation.status,
        lastObservedAt: now,
        updatedAt: now,
      };
      dispatches.set(dispatchId, next);
      return { outcome: "recorded", dispatch: { ...next } };
    },

    async recordDispatchObservation({ dispatchId, activityId, status }) {
      const current = dispatches.get(dispatchId);
      if (!current || current.turnkeyActivityId === null || current.turnkeyActivityId !== activityId || current.terminalStatus !== null) return false;
      const now = new Date().toISOString();
      dispatches.set(dispatchId, { ...current, lastObservedStatus: status, lastObservedAt: now, updatedAt: now });
      return true;
    },

    async findDispatchesByCredentialId(credentialId) {
      return [...dispatches.values()].filter((row) => row.credentialId === credentialId).sort((a, b) => a.dispatchSeq - b.dispatchSeq).map((row) => ({ ...row }));
    },

    async revertProvisioningAfterDefinitiveFailure({ credentialId, dispatchId, activityId }) {
      // Synchronous from check to write (no await), like the single Neon statement.
      const current = attempts.get(credentialId);
      if (!current || current.state !== "provisioning_in_flight") return null;
      const newest = newestDispatch(credentialId);
      if (!newest || newest.id !== dispatchId || !dispatchProvesDefinitiveFailure(newest, activityId)) return null;
      const next: RegistrationAttempt = { ...current, state: "verified", externalOutcome: "definitive_failure", updatedAt: new Date().toISOString() };
      attempts.set(credentialId, next);
      return next;
    },

    async advanceProvisioningToTurnkeyCreated({ credentialId, dispatchId, activityId, identity }) {
      const current = attempts.get(credentialId);
      if (!current || current.state !== "provisioning_in_flight") return null;
      if (current.subOrganizationId !== null || current.turnkeyUserId !== null || current.walletId !== null || current.walletAccountId !== null || current.ownerAddress !== null) return null;
      const newest = newestDispatch(credentialId);
      if (!newest || newest.id !== dispatchId || !dispatchProvesCreated(newest, activityId, identity)) return null;
      const next: RegistrationAttempt = { ...current, ...identity, state: "turnkey_created", externalOutcome: "confirmed_created", updatedAt: new Date().toISOString() };
      attempts.set(credentialId, next);
      return next;
    },

    async finalize({ credentialId, registry, safeAddress, safeOwnerAddress, accountConfigVersion }) {
      // Everything up to the claim is synchronous (no await), so no other
      // call can interleave between these checks and the claim — the
      // in-memory equivalent of the Neon adapter's row lock.
      const current = attempts.get(credentialId);
      if (!current || current.state !== "turnkey_created") return null;
      const { subOrganizationId, turnkeyUserId, walletId, walletAccountId, ownerAddress } = current;
      if (!subOrganizationId || !turnkeyUserId || !walletId || !walletAccountId || !ownerAddress) return null;
      // The Safe was derived for a different owner than the one now locked in.
      if (!addressesEqual(ownerAddress, safeOwnerAddress)) return null;

      const { accountsByAppUserId, passkeysByCredentialId } = getInMemoryRegistryInternals(registry);
      if (accountsByAppUserId.has(current.appUserId) || passkeysByCredentialId.has(current.credentialId)) return null;
      const block = (from: RegistrationAttempt) =>
        attempts.set(credentialId, { ...from, state: "blocked", blockReason: REGISTRATION_IDENTITY_CONFLICT_REASON, updatedAt: new Date().toISOString() });
      for (const other of accountsByAppUserId.values()) {
        if (accountIdentitiesConflict(other, { subOrganizationId, ownerAddress, safeAddress })) {
          block(current);
          return null;
        }
      }

      // Claimed synchronously, so a concurrent finalize() for the same
      // credentialId sees state !== "turnkey_created" and returns null.
      const claimed: RegistrationAttempt = { ...current, state: "active", safeAddress, accountConfigVersion, updatedAt: new Date().toISOString() };
      attempts.set(credentialId, claimed);

      const account = { appUserId: current.appUserId, subOrganizationId, turnkeyUserId, walletId, walletAccountId, ownerAddress, safeAddress, accountConfigVersion };
      const passkey = {
        credentialId: current.credentialId,
        appUserId: current.appUserId,
        credentialPublicKey: current.credentialPublicKey,
        userHandle: current.userHandle,
        counter: current.counter,
        transports: current.transports,
        credentialDeviceType: current.credentialDeviceType,
        credentialBackedUp: current.credentialBackedUp,
      };
      try {
        return await registry.createAccountWithPasskey({ account, passkey });
      } catch (error) {
        // Compensate synchronously: never "active" without its rows, never a
        // partial row. Both keys were proven absent before the claim, so a
        // row now present that carries this invocation's exact values is one
        // this invocation wrote; anything else belongs to another operation
        // and is left alone.
        const writtenAccount = accountsByAppUserId.get(account.appUserId);
        if (
          writtenAccount &&
          writtenAccount.subOrganizationId === account.subOrganizationId &&
          writtenAccount.ownerAddress === account.ownerAddress &&
          writtenAccount.safeAddress === account.safeAddress
        ) {
          accountsByAppUserId.delete(account.appUserId);
        }
        const writtenPasskey = passkeysByCredentialId.get(passkey.credentialId);
        if (writtenPasskey && writtenPasskey.appUserId === passkey.appUserId && writtenPasskey.credentialPublicKey === passkey.credentialPublicKey) {
          passkeysByCredentialId.delete(passkey.credentialId);
        }
        // "active" is finalize-only and this invocation holds the claim, so
        // an active attempt here is ours — even if updateCounter replaced the
        // object meanwhile (its counter is kept).
        const latest = attempts.get(credentialId);
        if (latest?.state === "active") {
          const restored: RegistrationAttempt =
            latest === claimed ? current : { ...latest, state: current.state, safeAddress: current.safeAddress, accountConfigVersion: current.accountConfigVersion };
          attempts.set(credentialId, restored);
          // The registry's identity uniqueness (the Neon indexes' twin) is a
          // positively known conflict, not a retryable failure.
          if (error instanceof IdentityConflictError) {
            block(restored);
            return null;
          }
        }
        throw error;
      }
    },
  };
}
