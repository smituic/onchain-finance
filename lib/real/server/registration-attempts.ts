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
 * this attempt automatically, and (S5 L2, Option 3) nothing adopts a Turnkey
 * resource for it either: a sub-org that merely contains this credential
 * proves neither that our request created it nor that no other authority
 * exists in it. The only automatic exits from "provisioning_in_flight" are
 * the in-process outcomes of the ONE dispatch: Turnkey's own successful
 * response (-> turnkey_created) or a Turnkey-confirmed definitive failure
 * (-> back to "verified", externalOutcome "definitive_failure", safe to
 * attempt again because Turnkey itself proved nothing was created). A lost
 * response leaves it "provisioning_in_flight" / "unknown", reported as
 * needing review, until a future operator-only resolver (which first needs
 * exact dispatch evidence) exists.
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
   * currently in `from` state. Returns null if another concurrent caller
   * already moved it — the caller re-reads and decides rather than assuming
   * its own view is still current. Throws (assertGenericTransition) for any
   * transition to or from "active": that state is finalize-only.
   */
  transition(input: {
    credentialId: string;
    from: RegistrationAttemptState;
    to: RegistrationAttemptState;
    patch?: RegistrationAttemptPatch;
  }): Promise<RegistrationAttempt | null>;

  updateCounter(input: { credentialId: string; counter: number }): Promise<void>;

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

/** S5 L2: "active" is finalize-only — a generic transition() to or from it is a programming error, never a CAS miss. */
export function assertGenericTransition(from: RegistrationAttemptState, to: RegistrationAttemptState): void {
  if (from === "active" || to === "active") throw new Error("Registration attempts enter and leave 'active' only through finalize().");
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
