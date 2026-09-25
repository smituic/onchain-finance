/**
 * The account/passkey registry is the APP AUTHENTICATION boundary's source
 * of truth — deliberately separate from Turnkey. A row existing here is
 * what lets a credentialId become an app session; Turnkey is never asked
 * "who is this" during login (see server/turnkey-discovery.ts, which is
 * reconciliation-only and never mints a session).
 *
 * Two record types, not one: an account can outlive/gain additional
 * passkeys (Batch 2g backup enrollment), so
 * credential identity and account identity are modeled separately even
 * though Batch 2b only ever creates one of each.
 */

export type RealAccountRecord = {
  appUserId: string;
  subOrganizationId: string;
  turnkeyUserId: string;
  walletId: string;
  walletAccountId: string;
  /** Case-preserved — Turnkey's signWith/resource lookup is case-sensitive. */
  ownerAddress: string;
  safeAddress: string;
  /** Ties this record to the Safe/module/version config it was derived under (see lib/real/constants.ts), so a future config change can be detected rather than silently mismatched. */
  accountConfigVersion: number;
  createdAt: string;
};

/**
 * APP state only — never a statement about Turnkey (see schema.sql):
 * 'pending' (backup mid-enrollment) -> 'active' -> 'revoking' (app login
 * disabled; Turnkey removal NOT yet confirmed — may still authorize at
 * Turnkey) -> 'revoked'. readAuthenticatedRealAccount and completeLogin
 * refuse anything but 'active'.
 */
export type RealPasskeyStatus = "pending" | "active" | "revoking" | "revoked";

export type RealPasskeyRecord = {
  credentialId: string;
  appUserId: string;
  /** base64url-encoded COSE public key bytes, as returned by @simplewebauthn/server's WebAuthnCredential.publicKey. */
  credentialPublicKey: string;
  /** base64url-encoded WebAuthn user.id set at registration — compared against response.userHandle on every login, independent of credentialId matching. */
  userHandle: string;
  counter: number;
  transports: string[] | null;
  credentialDeviceType: "singleDevice" | "multiDevice" | null;
  credentialBackedUp: boolean | null;
  status: RealPasskeyStatus;
  /** Display/bookkeeping only — primary and backup have EQUAL Turnkey authority once active; never an authorization check. Added credentials start as backup; a confirmed removal that leaves no non-revoked primary promotes the oldest active passkey (passkey-revocation-attempts.ts's confirmDeleted). */
  role: "primary" | "backup";
  /** Turnkey-side authenticator id; required before this passkey can be removed or authorize a removal. Null until enrollment confirmation (backups) or the admin backfill (pre-2g primaries). */
  turnkeyAuthenticatorId: string | null;
  /** User-chosen label — presentation metadata only, never identity or an authorization input. Null until renamed (the UI falls back to the role label). */
  displayName: string | null;
  createdAt: string;
};

export type RenamePasskeyResult = { outcome: "renamed"; passkey: RealPasskeyRecord } | { outcome: "not_found" } | { outcome: "not_active" };

export class DuplicateCredentialError extends Error {
  constructor(readonly credentialId: string) {
    super(`A passkey is already registered for credentialId ${credentialId}.`);
    this.name = "DuplicateCredentialError";
  }
}

export class DuplicateAccountError extends Error {
  constructor(readonly appUserId: string) {
    super(`An account already exists for appUserId ${appUserId}.`);
    this.name = "DuplicateAccountError";
  }
}

/**
 * Server-only, vendor-neutral. Route handlers and tests depend on this
 * interface — never on a specific database — so a durable backing store
 * can be swapped in later without touching call sites (see
 * createInMemoryRealAccountRegistry for the test/dev adapter).
 */
export interface RealAccountRegistry {
  /**
   * The one atomic "activate the account" step — called only after BOTH
   * WebAuthn registration verification AND Turnkey provisioning have
   * already succeeded, so a row here always represents a fully bound
   * app-identity + credential + Turnkey account. Rejects
   * (DuplicateCredentialError / DuplicateAccountError) rather than
   * overwriting an existing credential or account.
   */
  createAccountWithPasskey(input: {
    account: Omit<RealAccountRecord, "createdAt">;
    /** Always creates the passkey as role="primary", status="active" — backups go through backup-passkey-enrollment.ts. */
    passkey: Omit<RealPasskeyRecord, "createdAt" | "status" | "role" | "turnkeyAuthenticatorId" | "displayName">;
  }): Promise<{ account: RealAccountRecord; passkey: RealPasskeyRecord }>;
  findAccountByAppUserId(appUserId: string): Promise<RealAccountRecord | null>;
  findPasskeyByCredentialId(credentialId: string): Promise<RealPasskeyRecord | null>;
  findPasskeysByAppUserId(appUserId: string): Promise<RealPasskeyRecord[]>;
  updateAuthenticatorCounter(input: { credentialId: string; counter: number }): Promise<void>;

  /**
   * Concurrency-safe compare-and-swap on one passkey row's status (same
   * shape as registration-attempts.ts's transition()). Returns null, never
   * throws, when the row isn't currently `from`. Multi-row Batch 2g
   * transitions (enrollment activation, revocation) do NOT use this — they
   * go through their stores' own atomic operations.
   */
  transitionPasskeyStatus(input: {
    credentialId: string;
    from: RealPasskeyStatus;
    to: RealPasskeyStatus;
    patch?: { turnkeyAuthenticatorId?: string };
  }): Promise<RealPasskeyRecord | null>;

  /**
   * Sets display_name only — no other column. Ownership (appUserId) and
   * status='active' are enforced in the same write, so a passkey on another
   * account is indistinguishable from a missing one ("not_found"), and
   * pending/revoking/revoked rows are never touched ("not_active").
   * `displayName` must already be validated (validatePasskeyDisplayName).
   */
  renamePasskey(input: { appUserId: string; credentialId: string; displayName: string }): Promise<RenamePasskeyResult>;
}

/**
 * The in-memory adapter's raw maps, reachable only through
 * getInMemoryRegistryInternals — lets the in-memory backup-enrollment and
 * revocation stores perform their multi-row operations SYNCHRONOUSLY (no
 * await between check and write), which is what makes them atomic under
 * concurrent Promise.all, mirroring the Neon adapter's single-transaction
 * guarantees. Never used by production code paths (Neon has no such hook).
 */
export type InMemoryRegistryInternals = {
  accountsByAppUserId: Map<string, RealAccountRecord>;
  passkeysByCredentialId: Map<string, RealPasskeyRecord>;
};

const inMemoryInternals = new WeakMap<RealAccountRegistry, InMemoryRegistryInternals>();

export function getInMemoryRegistryInternals(registry: RealAccountRegistry): InMemoryRegistryInternals {
  const internals = inMemoryInternals.get(registry);
  if (!internals) throw new Error("In-memory Batch 2g stores require the in-memory registry.");
  return internals;
}

export function createInMemoryRealAccountRegistry(): RealAccountRegistry {
  const accountsByAppUserId = new Map<string, RealAccountRecord>();
  const passkeysByCredentialId = new Map<string, RealPasskeyRecord>();

  const registry: RealAccountRegistry = {
    async createAccountWithPasskey({ account, passkey }) {
      // Checked (and thrown on) before either Map is written — this function
      // never partially applies. In-memory Map access is synchronous, so
      // there is no await between the checks and the writes below for
      // another call to race into.
      if (passkeysByCredentialId.has(passkey.credentialId)) {
        throw new DuplicateCredentialError(passkey.credentialId);
      }
      if (accountsByAppUserId.has(account.appUserId)) {
        throw new DuplicateAccountError(account.appUserId);
      }

      const createdAt = new Date().toISOString();
      const accountRecord: RealAccountRecord = { ...account, createdAt };
      const passkeyRecord: RealPasskeyRecord = {
        ...passkey,
        status: "active",
        role: "primary",
        turnkeyAuthenticatorId: null,
        displayName: null,
        createdAt,
      };
      accountsByAppUserId.set(account.appUserId, accountRecord);
      passkeysByCredentialId.set(passkey.credentialId, passkeyRecord);
      return { account: accountRecord, passkey: passkeyRecord };
    },

    async findAccountByAppUserId(appUserId) {
      return accountsByAppUserId.get(appUserId) ?? null;
    },

    async findPasskeyByCredentialId(credentialId) {
      return passkeysByCredentialId.get(credentialId) ?? null;
    },

    async findPasskeysByAppUserId(appUserId) {
      return [...passkeysByCredentialId.values()].filter((passkey) => passkey.appUserId === appUserId);
    },

    async updateAuthenticatorCounter({ credentialId, counter }) {
      const existing = passkeysByCredentialId.get(credentialId);
      if (!existing) return;
      passkeysByCredentialId.set(credentialId, { ...existing, counter });
    },

    async transitionPasskeyStatus({ credentialId, from, to, patch }) {
      const current = passkeysByCredentialId.get(credentialId);
      if (!current || current.status !== from) return null;
      const next: RealPasskeyRecord = {
        ...current,
        ...(patch?.turnkeyAuthenticatorId !== undefined ? { turnkeyAuthenticatorId: patch.turnkeyAuthenticatorId } : {}),
        status: to,
      };
      passkeysByCredentialId.set(credentialId, next);
      return next;
    },

    async renamePasskey({ appUserId, credentialId, displayName }) {
      const current = passkeysByCredentialId.get(credentialId);
      if (!current || current.appUserId !== appUserId) return { outcome: "not_found" };
      if (current.status !== "active") return { outcome: "not_active" };
      const next: RealPasskeyRecord = { ...current, displayName };
      passkeysByCredentialId.set(credentialId, next);
      return { outcome: "renamed", passkey: next };
    },
  };
  inMemoryInternals.set(registry, { accountsByAppUserId, passkeysByCredentialId });
  return registry;
}
