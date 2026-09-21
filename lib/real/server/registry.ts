/**
 * The account/passkey registry is the APP AUTHENTICATION boundary's source
 * of truth — deliberately separate from Turnkey. A row existing here is
 * what lets a credentialId become an app session; Turnkey is never asked
 * "who is this" during login (see server/turnkey-discovery.ts, which is
 * reconciliation-only and never mints a session).
 *
 * Two record types, not one: an account can outlive/gain additional
 * passkeys later (not implemented yet — revokePasskey exists for when a
 * passkey needs replacing), so credential identity and account identity are
 * modeled separately even though Batch 2b only ever creates one of each.
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
  status: "active" | "revoked";
  createdAt: string;
};

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
    passkey: Omit<RealPasskeyRecord, "createdAt" | "status">;
  }): Promise<{ account: RealAccountRecord; passkey: RealPasskeyRecord }>;
  findAccountByAppUserId(appUserId: string): Promise<RealAccountRecord | null>;
  findPasskeyByCredentialId(credentialId: string): Promise<RealPasskeyRecord | null>;
  updateAuthenticatorCounter(input: { credentialId: string; counter: number }): Promise<void>;
  revokePasskey(credentialId: string): Promise<void>;
}

export function createInMemoryRealAccountRegistry(): RealAccountRegistry {
  const accountsByAppUserId = new Map<string, RealAccountRecord>();
  const passkeysByCredentialId = new Map<string, RealPasskeyRecord>();

  return {
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
      const passkeyRecord: RealPasskeyRecord = { ...passkey, status: "active", createdAt };
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

    async updateAuthenticatorCounter({ credentialId, counter }) {
      const existing = passkeysByCredentialId.get(credentialId);
      if (!existing) return;
      passkeysByCredentialId.set(credentialId, { ...existing, counter });
    },

    async revokePasskey(credentialId) {
      const existing = passkeysByCredentialId.get(credentialId);
      if (!existing) return;
      passkeysByCredentialId.set(credentialId, { ...existing, status: "revoked" });
    },
  };
}
