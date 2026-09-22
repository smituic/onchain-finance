import { DuplicateAccountError, DuplicateCredentialError, type RealAccountRecord, type RealAccountRegistry, type RealPasskeyRecord } from "./registry";

/**
 * The durable onboarding workflow. A row is written the instant a WebAuthn
 * registration is independently verified — BEFORE Turnkey is ever called —
 * so a process crash between verification and account activation is always
 * recoverable (see server/onboarding.ts's runProvisioningPipeline, shared
 * by registration and login-recovery).
 *
 *   verified -> provisioning_in_flight -> turnkey_created -> active
 *        ^               \-> blocked (ambiguous Turnkey discovery; manual review)
 *        \_______________/  (only on a Turnkey-CONFIRMED definitive failure —
 *                             see externalOutcome below)
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
 *                       created (see turnkey-provisioning.ts's
 *                       isDefinitiveProvisioningFailure).
 *
 * The critical invariant this state machine enforces: once externalOutcome
 * becomes "unknown", nothing may call provisionTurnkeyChildAccount again for
 * this attempt automatically — not even after a later Turnkey discovery
 * lookup comes back with zero matches (Turnkey's credential-discovery API
 * carries no read-after-write consistency guarantee, so a zero-match result
 * is not proof the earlier call never landed). The only ways out of
 * "provisioning_in_flight" are: discovery finding exactly one match
 * (reconcile -> turnkey_created), discovery finding more than one match
 * (-> blocked, manual review), or a Turnkey-confirmed definitive failure
 * (-> back to "verified", externalOutcome "definitive_failure", safe to
 * attempt again because Turnkey itself proved nothing was created). A zero
 * discovery match on its own leaves the attempt exactly where it was —
 * unresolved, retried only by a later discovery re-check (bounded by how
 * often a client calls back in, never an automatic loop) or a manual/admin
 * decision, both deferred past Batch 2b.
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
   * kept so provisionTurnkeyChildAccount can be retried later from durable
   * state if an earlier call's outcome was never learned.
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
   * currently in `from` state. Returns null (never throws) if another
   * concurrent caller already moved it — the caller re-reads and decides
   * rather than assuming its own view is still current.
   */
  transition(input: {
    credentialId: string;
    from: RegistrationAttemptState;
    to: RegistrationAttemptState;
    patch?: RegistrationAttemptPatch;
  }): Promise<RegistrationAttempt | null>;

  updateCounter(input: { credentialId: string; counter: number }): Promise<void>;

  /**
   * The one atomic activation step: requires the attempt to currently be
   * "turnkey_created" (CAS), writes real_accounts + real_passkeys via the
   * given registry, and marks the attempt "active" — all together where
   * the adapter can make that transactional (the Neon adapter wraps both
   * in one SQL transaction). Returns null if the attempt wasn't in the
   * expected state (lost race / already finalized elsewhere) rather than
   * throwing — the caller re-reads.
   */
  finalize(input: {
    credentialId: string;
    registry: RealAccountRegistry;
    safeAddress: string;
    accountConfigVersion: number;
  }): Promise<{ account: RealAccountRecord; passkey: RealPasskeyRecord } | null>;
}

export function createInMemoryRegistrationAttemptStore(): RegistrationAttemptStore {
  const attempts = new Map<string, RegistrationAttempt>();
  const appUserIndex = new Map<string, string>(); // appUserId -> credentialId

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

    async finalize({ credentialId, registry, safeAddress, accountConfigVersion }) {
      const current = attempts.get(credentialId);
      if (!current || current.state !== "turnkey_created") return null;
      if (!current.subOrganizationId || !current.turnkeyUserId || !current.walletId || !current.walletAccountId || !current.ownerAddress) return null;

      // Claim the transition synchronously before the first await, so a
      // concurrent finalize() call for the same credentialId sees
      // state !== "turnkey_created" and returns null instead of racing.
      const claimed: RegistrationAttempt = {
        ...current,
        state: "active",
        safeAddress,
        accountConfigVersion,
        updatedAt: new Date().toISOString(),
      };
      attempts.set(credentialId, claimed);

      const created = await registry.createAccountWithPasskey({
        account: {
          appUserId: current.appUserId,
          subOrganizationId: current.subOrganizationId,
          turnkeyUserId: current.turnkeyUserId,
          walletId: current.walletId,
          walletAccountId: current.walletAccountId,
          ownerAddress: current.ownerAddress,
          safeAddress,
          accountConfigVersion,
        },
        passkey: {
          credentialId: current.credentialId,
          appUserId: current.appUserId,
          credentialPublicKey: current.credentialPublicKey,
          userHandle: current.userHandle,
          counter: current.counter,
          transports: current.transports,
          credentialDeviceType: current.credentialDeviceType,
          credentialBackedUp: current.credentialBackedUp,
        },
      });
      return created;
    },
  };
}
