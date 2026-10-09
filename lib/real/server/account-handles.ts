import { HANDLE_MAX_LENGTH, HANDLE_MIN_LENGTH, HANDLE_PATTERN, RESERVED_HANDLES } from "../handle";
import { normalizeAddress } from "../identifiers";
import { getInMemoryRegistryInternals, type RealAccountRegistry } from "./registry";

/**
 * The permanent handle registry (schema.sql's real_account_handles) and the
 * account's display name (real_accounts.display_name) — the two pieces of
 * human-readable identity. Neither has any authentication authority: nothing
 * here is read by auth.ts, a session, or any Turnkey request. A handle
 * resolves to an account (and so its Safe), never to the Turnkey owner.
 *
 * Rows are append-only: there is no update or delete operation on this
 * interface, and the database refuses both.
 */
export type AccountProfile = {
  /** Canonical, without "@". Null until the account claims one. */
  handle: string | null;
  displayName: string | null;
};

export type AccountHandleRecord = {
  handle: string;
  kind: "reserved" | "claimed";
  /** Null for a reserved row. */
  appUserId: string | null;
};

export type ClaimHandleResult =
  /** `alreadyOwned`: this account already held exactly this handle (a retry whose first answer was lost) — nothing was written. */
  | { outcome: "claimed"; handle: string; alreadyOwned: boolean }
  /** The handle belongs to another account or is reserved. */
  | { outcome: "handle_taken" }
  /** This account already has a DIFFERENT handle; handles never change. */
  | { outcome: "already_has_handle"; handle: string }
  /** The claiming credential is not an active passkey of this account. */
  | { outcome: "credential_not_active" };

/**
 * What recipient resolution needs from a CLAIMED handle, and nothing more.
 * SERVER-ONLY: `appUserId` and `safeAddress` must never reach a public
 * response. `safeAddress` is real_accounts.safe_address — the account itself —
 * and is never the Turnkey owner address (which this read does not select).
 */
export type PayableAccountRecord = {
  handle: string;
  displayName: string | null;
  appUserId: string;
  safeAddress: string;
};

export interface AccountHandleStore {
  /** Exact lookup of a canonical handle (reserved or claimed). Advisory only — claim() is authoritative. */
  findHandle(handle: string): Promise<AccountHandleRecord | null>;
  /**
   * handle -> app_user_id -> real_accounts.safe_address, in one read. Null for
   * a reserved or unclaimed handle, and for an account whose Safe address is
   * not a valid address. Whether the account has an active passkey is NOT
   * part of the rule: receiving Cash is separate from signing in, so a claimed
   * handle with a valid Safe is payable either way (the same rule the
   * authoritative payment reservation uses). Advisory: it decides nothing
   * about a payment — prepare re-resolves from the database. `handle` must
   * already be canonical (lib/real/handle.ts).
   */
  findPayableAccountByHandle(handle: string): Promise<PayableAccountRecord | null>;
  /** Null when the account doesn't exist. */
  findProfileByAppUserId(appUserId: string): Promise<AccountProfile | null>;
  /**
   * The one write: a single INSERT ... SELECT from the passkey table, so the
   * store itself re-checks that `credentialId` is an ACTIVE passkey of
   * `appUserId`. Uniqueness (one account per handle, one handle per account)
   * is decided by the store, not by a prior read. `handle` must already be
   * canonical (lib/real/handle.ts).
   */
  claim(input: { handle: string; appUserId: string; credentialId: string }): Promise<ClaimHandleResult>;
  /** Sets or clears (null) the display name. False when the account doesn't exist. `displayName` must already be validated (validateAccountDisplayName). */
  setDisplayName(input: { appUserId: string; displayName: string | null }): Promise<boolean>;
}

/** The in-memory twin of schema.sql's real_account_handles format CHECK. */
function assertCanonicalHandle(handle: string): void {
  if (handle.length < HANDLE_MIN_LENGTH || handle.length > HANDLE_MAX_LENGTH || !HANDLE_PATTERN.test(handle)) {
    throw new Error("real_account_handles: handle violates the format check.");
  }
}

/**
 * Test/dev adapter. Seeded with the reserved names, like schema.sql. Every
 * operation is synchronous between its checks and its write (no await), so
 * concurrent Promise.all callers see the same one-winner outcomes the
 * database's unique constraints give.
 */
export function createInMemoryAccountHandleStore(registry: RealAccountRegistry): AccountHandleStore {
  const internals = getInMemoryRegistryInternals(registry);
  const byHandle = new Map<string, AccountHandleRecord>(RESERVED_HANDLES.map((handle) => [handle, { handle, kind: "reserved", appUserId: null }]));
  const handleByAppUserId = new Map<string, string>();
  const displayNames = new Map<string, string>();
  // The in-memory payment store resolves a handle payment from these same two maps (see InMemoryRegistryInternals.handleDirectory).
  internals.handleDirectory = { byHandle, displayNames };

  return {
    async findHandle(handle) {
      return byHandle.get(handle) ?? null;
    },

    async findPayableAccountByHandle(handle) {
      const record = byHandle.get(handle);
      if (!record || record.kind !== "claimed" || record.appUserId === null) return null;
      const account = internals.accountsByAppUserId.get(record.appUserId);
      if (!account) return null;
      // No active-passkey requirement: only a usable Safe address (the Neon twin checks the same shape in SQL).
      if (!normalizeAddress(account.safeAddress)) return null;
      return { handle: record.handle, displayName: displayNames.get(account.appUserId) ?? null, appUserId: account.appUserId, safeAddress: account.safeAddress };
    },

    async findProfileByAppUserId(appUserId) {
      if (!internals.accountsByAppUserId.has(appUserId)) return null;
      return { handle: handleByAppUserId.get(appUserId) ?? null, displayName: displayNames.get(appUserId) ?? null };
    },

    async claim({ handle, appUserId, credentialId }) {
      assertCanonicalHandle(handle);
      const passkey = internals.passkeysByCredentialId.get(credentialId);
      if (!passkey || passkey.appUserId !== appUserId || passkey.status !== "active") return { outcome: "credential_not_active" };
      const owned = handleByAppUserId.get(appUserId);
      if (owned !== undefined) return owned === handle ? { outcome: "claimed", handle, alreadyOwned: true } : { outcome: "already_has_handle", handle: owned };
      if (byHandle.has(handle)) return { outcome: "handle_taken" };
      byHandle.set(handle, { handle, kind: "claimed", appUserId });
      handleByAppUserId.set(appUserId, handle);
      return { outcome: "claimed", handle, alreadyOwned: false };
    },

    async setDisplayName({ appUserId, displayName }) {
      if (!internals.accountsByAppUserId.has(appUserId)) return false;
      if (displayName === null) displayNames.delete(appUserId);
      else displayNames.set(appUserId, displayName);
      return true;
    },
  };
}
