import { randomUUID } from "node:crypto";
import { REMOVABLE_PENDING_ENROLLMENT_STATES } from "./backup-passkey-enrollment";
import { getInMemoryRegistryInternals, type RealAccountRegistry } from "./registry";

/**
 * Durable removal of one passkey, authorized by a DIFFERENT surviving
 * credential (see schema.sql's passkey_revocation_attempts comment and
 * passkey-revocation.ts):
 *
 *   authorization_needed -> dispatch_in_flight -> confirmed
 *   off-ramps: cancelled (only before dispatch), blocked (after dispatch)
 *
 * Removable targets: an 'active' mapped passkey; (2g-H) a 'pending' backup
 * whose Turnkey authenticator is already CONFIRMED (enrollment
 * turnkey_authenticator_created / login_verified) — it may already authorize
 * at Turnkey, so setup never finishing must not strand it; or (2g-H) a
 * 'revoking' target whose earlier removal BLOCKED, with nothing in flight — a
 * new, user-authorized retry (fresh survivor stamp, fresh body, same
 * authenticator id; never automatic, never back to 'active'). The authorizer
 * is always a different 'active', mapped passkey.
 *
 * A pending target's enrollment moves to 'removal_in_progress' at dispatch
 * (activation impossible, one-open-enrollment slot still HELD) and to
 * 'removed' only with the confirmed deletion (slot freed).
 *
 * An app session alone can only create an 'authorization_needed' attempt —
 * the target stays 'active'. The target leaves 'active' only inside
 * beginDispatch, after the survivor's fresh WebAuthn stamp was verified.
 * APP DISABLED != TURNKEY REMOVED: while dispatched the target is 'revoking'
 * (app login disabled) but may still authorize at Turnkey; only
 * confirmDeleted — a completed DELETE activity for exactly this
 * authenticator AND a subsequent absence read — makes it 'revoked'.
 *
 * ONE-WAY AFTER DISPATCH: the browser holds a valid signed delete and could
 * send those exact bytes to Turnkey itself, so no outcome we observe proves
 * the target wasn't deleted. Nothing here ever moves a dispatched target
 * back to 'active'; every outcome other than confirmDeleted is 'blocked'.
 */
export type RevocationAttemptState = "authorization_needed" | "dispatch_in_flight" | "confirmed" | "cancelled" | "blocked";

export type PasskeyRevocationAttempt = {
  id: string;
  appUserId: string;
  targetCredentialId: string;
  targetTurnkeyAuthenticatorId: string;
  authorizerCredentialId: string;
  state: RevocationAttemptState;
  turnkeyRequestBody: string | null;
  turnkeyRequestBodySha256: string | null;
  turnkeyRequestTimestampMs: number | null;
  /** Live, body-bound bearer credential — cleared once an activity id is known or the replay window closes. */
  turnkeyRequestStamp: string | null;
  externalAttemptedAt: string | null;
  /** Written only by recordActivity (first writer wins). */
  turnkeyActivityId: string | null;
  turnkeyActivityStatus: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
};

/** undefined = leave unchanged; null = clear. */
export type RevocationAttemptPatch = {
  turnkeyRequestBody?: string | null;
  turnkeyRequestBodySha256?: string | null;
  turnkeyRequestTimestampMs?: number | null;
  turnkeyRequestStamp?: string | null;
  externalAttemptedAt?: string | null;
  turnkeyActivityStatus?: string | null;
  failureReason?: string | null;
};

export type PrepareRevocationStoreResult =
  | { ok: true; attempt: PasskeyRevocationAttempt }
  | { ok: false; reason: "same_credential" | "target_not_removable" | "authorizer_not_eligible" | "removal_in_progress" };

export interface PasskeyRevocationStore {
  /**
   * Records an 'authorization_needed' attempt. Changes NO passkey status —
   * a cookie alone must never disable another credential. Requires:
   * authorizer != target; authorizer 'active' and Turnkey-mapped; target
   * removable (see above) and mapped; no dispatched attempt for the target.
   */
  prepare(input: { appUserId: string; targetCredentialId: string; authorizerCredentialId: string }): Promise<PrepareRevocationStoreResult>;
  findById(id: string): Promise<PasskeyRevocationAttempt | null>;
  /** The most recent attempt per target passkey on this account. */
  findLatestPerTarget(appUserId: string): Promise<PasskeyRevocationAttempt[]>;
  /** Single-row CAS on the attempt alone (never changes a passkey's status). */
  transition(input: { id: string; from: RevocationAttemptState; to: RevocationAttemptState; patch?: RevocationAttemptPatch }): Promise<PasskeyRevocationAttempt | null>;
  /**
   * ONE transaction, serialized PER ACCOUNT (Neon: real_accounts row
   * SELECT ... FOR UPDATE), run only after the survivor's stamp was
   * verified: re-reads target + survivor against committed reality, requires
   * the survivor still 'active', mapped, and != target, and the target still
   * removable and mapped; then attempt 'authorization_needed' ->
   * 'dispatch_in_flight' with the exact request recorded, a pending target's
   * enrollment -> 'removal_in_progress' (activation can never
   * resurrect it — the slot stays held until confirmDeleted), AND target
   * 'active'/'pending' -> 'revoking' (a retry's target already is). 2g-H:
   * refused (null) if the signed body's hash equals any earlier attempt's for
   * this target — a retry always needs fresh WebAuthn over fresh bytes. Null (nothing changed) if any check fails. Two
   * racing removals (A by B, B by A) can never both pass — at least one
   * mapped credential always stays 'active'. Commits before any Turnkey call.
   */
  beginDispatch(input: { id: string; patch: RevocationAttemptPatch }): Promise<PasskeyRevocationAttempt | null>;
  /**
   * First writer wins: records the activity id only while
   * 'dispatch_in_flight' with no activity id yet, and clears the stamp. Null
   * if another send (a concurrent byte-identical replay) already recorded one.
   */
  recordActivity(input: { id: string; activityId: string; activityStatus: string }): Promise<PasskeyRevocationAttempt | null>;
  /**
   * ONE transaction: attempt 'dispatch_in_flight' -> 'confirmed' AND target
   * 'revoking' -> 'revoked' AND, if that leaves the account with no
   * non-revoked primary, its oldest active passkey's role -> 'primary'. Role
   * is app metadata only (no Turnkey/owner/Safe/identity change), but the
   * three writes are the final app state together: never "confirmed" with
   * the sole survivor still labeled backup. (2g-H) A removed-before-activation
   * enrollment ('removal_in_progress') becomes 'removed' in the same step —
   * the only point its one-open-enrollment slot frees. The caller must already hold
   * BOTH halves of the deletion evidence.
   */
  confirmDeleted(input: { id: string; turnkeyActivityStatus: string }): Promise<PasskeyRevocationAttempt | null>;
}

function applyPatch(current: PasskeyRevocationAttempt, patch: RevocationAttemptPatch | undefined): PasskeyRevocationAttempt {
  const next = { ...current } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value !== undefined) next[key] = value;
  }
  return next as PasskeyRevocationAttempt;
}

const inMemoryRevocationInternals = new WeakMap<PasskeyRevocationStore, { attempts: Map<string, PasskeyRevocationAttempt> }>();

/** Lets the in-memory operator resolution store (S3) run its multi-row commit synchronously, like getInMemoryRegistryInternals. */
export function getInMemoryRevocationInternals(store: PasskeyRevocationStore): { attempts: Map<string, PasskeyRevocationAttempt> } {
  const internals = inMemoryRevocationInternals.get(store);
  if (!internals) throw new Error("The in-memory resolution store requires the in-memory revocation store.");
  return internals;
}

/** Every multi-row operation runs synchronously end to end — atomic (and per-account serialized) in this single-threaded adapter. */
export function createInMemoryPasskeyRevocationStore(registry: RealAccountRegistry): PasskeyRevocationStore {
  const attempts = new Map<string, PasskeyRevocationAttempt>();
  const { passkeysByCredentialId } = getInMemoryRegistryInternals(registry);

  function latestForTarget(targetCredentialId: string): PasskeyRevocationAttempt | undefined {
    return [...attempts.values()].filter((a) => a.targetCredentialId === targetCredentialId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  function hasDispatched(targetCredentialId: string): boolean {
    return [...attempts.values()].some((a) => a.targetCredentialId === targetCredentialId && a.state === "dispatch_in_flight");
  }

  const { backupEnrollmentMaps } = getInMemoryRegistryInternals(registry);

  function eligible(appUserId: string, credentialId: string) {
    const passkey = passkeysByCredentialId.get(credentialId);
    return passkey && passkey.appUserId === appUserId && passkey.status === "active" && passkey.turnkeyAuthenticatorId ? passkey : null;
  }

  /** The not-yet-activated enrollment whose pending credential already has a confirmed Turnkey authenticator. */
  function removablePendingEnrollment(appUserId: string, credentialId: string) {
    for (const map of backupEnrollmentMaps) {
      for (const enrollment of map.values()) {
        if (enrollment.appUserId === appUserId && enrollment.newCredentialId === credentialId && REMOVABLE_PENDING_ENROLLMENT_STATES.includes(enrollment.state)) return { map, enrollment };
      }
    }
    return null;
  }

  function enrollmentFor(appUserId: string, credentialId: string, state: string) {
    for (const map of backupEnrollmentMaps) {
      for (const enrollment of map.values()) {
        if (enrollment.appUserId === appUserId && enrollment.newCredentialId === credentialId && enrollment.state === state) return { map, enrollment };
      }
    }
    return null;
  }

  function removableTarget(appUserId: string, credentialId: string) {
    const active = eligible(appUserId, credentialId);
    if (active) return active;
    const passkey = passkeysByCredentialId.get(credentialId);
    if (!passkey || passkey.appUserId !== appUserId || !passkey.turnkeyAuthenticatorId) return null;
    if (passkey.status === "pending") return removablePendingEnrollment(appUserId, credentialId) ? passkey : null;
    // Retry: a revoking target whose earlier removal blocked (prepare/beginDispatch separately require nothing in flight).
    if (passkey.status === "revoking") return [...attempts.values()].some((a) => a.targetCredentialId === credentialId && a.state === "blocked") ? passkey : null;
    return null;
  }

  /** Same rule as the Neon confirmDeleted: no non-revoked primary left -> the oldest active passkey becomes primary. */
  function passkeyToPromote(appUserId: string) {
    const account = [...passkeysByCredentialId.values()].filter((p) => p.appUserId === appUserId);
    if (account.some((p) => p.role === "primary" && p.status !== "revoked")) return null;
    const active = account.filter((p) => p.status === "active").sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.credentialId.localeCompare(y.credentialId));
    return active[0] ?? null;
  }

  function save(next: PasskeyRevocationAttempt): PasskeyRevocationAttempt {
    const saved = { ...next, updatedAt: new Date().toISOString() };
    attempts.set(saved.id, saved);
    return saved;
  }

  const store: PasskeyRevocationStore = {
    async prepare({ appUserId, targetCredentialId, authorizerCredentialId }) {
      if (targetCredentialId === authorizerCredentialId) return { ok: false, reason: "same_credential" };
      if (!eligible(appUserId, authorizerCredentialId)) return { ok: false, reason: "authorizer_not_eligible" };
      if (hasDispatched(targetCredentialId)) return { ok: false, reason: "removal_in_progress" };
      const target = removableTarget(appUserId, targetCredentialId);
      if (!target) return { ok: false, reason: "target_not_removable" };
      const now = new Date().toISOString();
      const attempt: PasskeyRevocationAttempt = {
        id: randomUUID(),
        appUserId,
        targetCredentialId,
        targetTurnkeyAuthenticatorId: target.turnkeyAuthenticatorId!,
        authorizerCredentialId,
        state: "authorization_needed",
        turnkeyRequestBody: null,
        turnkeyRequestBodySha256: null,
        turnkeyRequestTimestampMs: null,
        turnkeyRequestStamp: null,
        externalAttemptedAt: null,
        turnkeyActivityId: null,
        turnkeyActivityStatus: null,
        failureReason: null,
        createdAt: now,
        updatedAt: now,
      };
      attempts.set(attempt.id, attempt);
      return { ok: true, attempt };
    },

    async findById(id) {
      return attempts.get(id) ?? null;
    },

    async findLatestPerTarget(appUserId) {
      const targets = new Set([...attempts.values()].filter((a) => a.appUserId === appUserId).map((a) => a.targetCredentialId));
      return [...targets].map((target) => latestForTarget(target)!);
    },

    async transition({ id, from, to, patch }) {
      const current = attempts.get(id);
      if (!current || current.state !== from) return null;
      return save({ ...applyPatch(current, patch), state: to });
    },

    async beginDispatch({ id, patch }) {
      const current = attempts.get(id);
      if (!current || current.state !== "authorization_needed" || current.targetCredentialId === current.authorizerCredentialId) return null;
      if (!eligible(current.appUserId, current.authorizerCredentialId) || hasDispatched(current.targetCredentialId)) return null;
      const target = removableTarget(current.appUserId, current.targetCredentialId);
      if (!target || target.turnkeyAuthenticatorId !== current.targetTurnkeyAuthenticatorId) return null;
      // 2g-H: every attempt needs FRESH signed bytes — never a body an earlier attempt for this target already dispatched.
      if ([...attempts.values()].some((a) => a.targetCredentialId === current.targetCredentialId && a.id !== current.id && a.turnkeyRequestBodySha256 !== null && a.turnkeyRequestBodySha256 === patch.turnkeyRequestBodySha256)) return null;
      if (target.status === "pending") {
        const pending = removablePendingEnrollment(current.appUserId, target.credentialId)!;
        pending.map.set(pending.enrollment.id, { ...pending.enrollment, state: "removal_in_progress", turnkeyRequestStamp: null, updatedAt: new Date().toISOString() });
      }
      passkeysByCredentialId.set(target.credentialId, { ...target, status: "revoking" });
      return save({ ...applyPatch(current, patch), state: "dispatch_in_flight" });
    },

    async recordActivity({ id, activityId, activityStatus }) {
      const current = attempts.get(id);
      if (!current || current.state !== "dispatch_in_flight" || current.turnkeyActivityId) return null;
      return save({ ...current, turnkeyActivityId: activityId, turnkeyActivityStatus: activityStatus, turnkeyRequestStamp: null });
    },

    async confirmDeleted({ id, turnkeyActivityStatus }) {
      const current = attempts.get(id);
      if (!current || current.state !== "dispatch_in_flight") return null;
      const target = passkeysByCredentialId.get(current.targetCredentialId);
      if (!target || target.status !== "revoking") return null;
      passkeysByCredentialId.set(target.credentialId, { ...target, status: "revoked" });
      const removing = enrollmentFor(current.appUserId, target.credentialId, "removal_in_progress");
      if (removing) removing.map.set(removing.enrollment.id, { ...removing.enrollment, state: "removed", updatedAt: new Date().toISOString() });
      const survivor = passkeyToPromote(current.appUserId);
      if (survivor) passkeysByCredentialId.set(survivor.credentialId, { ...survivor, role: "primary" });
      return save({ ...current, state: "confirmed", turnkeyActivityStatus, turnkeyRequestStamp: null });
    },
  };
  inMemoryRevocationInternals.set(store, { attempts });
  return store;
}
