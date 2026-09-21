import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { ChallengePurpose, ChallengeStore, StoredChallenge } from "./challenge-store";
import { DuplicateAccountError, DuplicateCredentialError, type RealAccountRecord, type RealAccountRegistry, type RealPasskeyRecord } from "./registry";
import type { ExternalProvisioningOutcome, RegistrationAttempt, RegistrationAttemptState, RegistrationAttemptStore } from "./registration-attempts";

/**
 * SERVER-ONLY durable adapters for the three vendor-neutral interfaces
 * (ChallengeStore, RealAccountRegistry, RegistrationAttemptStore), backed by
 * Neon Postgres via @neondatabase/serverless's HTTP query function — no
 * persistent socket, matching Next.js route handlers' request-scoped
 * lifetime. Schema: lib/real/server/schema.sql. Never imported by
 * components, lib/real's signing/domain modules, or any Zustand store —
 * only by app/api/real/** route handlers (via server/runtime.ts), and only
 * when DATABASE_URL is configured.
 *
 * This file has never been exercised against a live database in this
 * session (no credentials were available) — see the Batch 2b report's "env
 * setup" section for what's needed before it can be.
 */

type Row = Record<string, unknown>;

function toStringArray(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(String);
  return null;
}

function toAttempt(row: Row): RegistrationAttempt {
  return {
    credentialId: row.credential_id as string,
    appUserId: row.app_user_id as string,
    userHandle: row.user_handle as string,
    credentialPublicKey: row.credential_public_key as string,
    counter: Number(row.counter),
    transports: toStringArray(row.transports),
    credentialDeviceType: (row.credential_device_type as RegistrationAttempt["credentialDeviceType"]) ?? null,
    credentialBackedUp: (row.credential_backed_up as boolean | null) ?? null,
    registrationChallenge: row.registration_challenge as string,
    rawClientDataJson: row.raw_client_data_json as string,
    rawAttestationObject: row.raw_attestation_object as string,
    state: row.state as RegistrationAttemptState,
    externalOutcome: row.external_outcome as ExternalProvisioningOutcome,
    externalProvisioningAttemptedAt: row.external_provisioning_attempted_at ? new Date(row.external_provisioning_attempted_at as string).toISOString() : null,
    subOrganizationId: (row.sub_organization_id as string | null) ?? null,
    turnkeyUserId: (row.turnkey_user_id as string | null) ?? null,
    walletId: (row.wallet_id as string | null) ?? null,
    walletAccountId: (row.wallet_account_id as string | null) ?? null,
    ownerAddress: (row.owner_address as string | null) ?? null,
    safeAddress: (row.safe_address as string | null) ?? null,
    accountConfigVersion: row.account_config_version === null || row.account_config_version === undefined ? null : Number(row.account_config_version),
    blockReason: (row.block_reason as string | null) ?? null,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

function toAccount(row: Row): RealAccountRecord {
  return {
    appUserId: row.app_user_id as string,
    subOrganizationId: row.sub_organization_id as string,
    turnkeyUserId: row.turnkey_user_id as string,
    walletId: row.wallet_id as string,
    walletAccountId: row.wallet_account_id as string,
    ownerAddress: row.owner_address as string,
    safeAddress: row.safe_address as string,
    accountConfigVersion: Number(row.account_config_version),
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

function toPasskey(row: Row): RealPasskeyRecord {
  return {
    credentialId: row.credential_id as string,
    appUserId: row.app_user_id as string,
    credentialPublicKey: row.credential_public_key as string,
    userHandle: row.user_handle as string,
    counter: Number(row.counter),
    transports: toStringArray(row.transports),
    credentialDeviceType: (row.credential_device_type as RealPasskeyRecord["credentialDeviceType"]) ?? null,
    credentialBackedUp: (row.credential_backed_up as boolean | null) ?? null,
    status: row.status as RealPasskeyRecord["status"],
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

function isUniqueViolation(error: unknown, constraintHint?: string): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code: unknown }).code) : "";
  if (code !== "23505") return false;
  if (!constraintHint) return true;
  const message = "message" in error ? String((error as { message: unknown }).message) : "";
  return message.includes(constraintHint);
}

export function createNeonChallengeStore(sql: NeonQueryFunction<false, false>): ChallengeStore {
  return {
    async create({ challenge, purpose, ttlMs, context }) {
      const expiresAt = new Date(Date.now() + ttlMs);
      await sql`
        INSERT INTO webauthn_challenges (challenge, purpose, context, expires_at)
        VALUES (${challenge}, ${purpose}, ${context === undefined ? null : JSON.stringify(context)}, ${expiresAt.toISOString()})
      `;
      return { challenge, purpose, createdAt: Date.now(), expiresAt: expiresAt.getTime(), context: context ?? null };
    },

    async consume({ challenge, purpose }) {
      // DELETE ... RETURNING is atomic: a challenge can be consumed by
      // exactly one caller, ever, even under concurrent requests.
      const rows = (await sql`
        DELETE FROM webauthn_challenges WHERE challenge = ${challenge} RETURNING purpose, context, created_at, expires_at
      `) as Row[];
      const row = rows[0];
      if (!row) return null;
      if ((row.purpose as ChallengePurpose) !== purpose) return null;
      const expiresAt = new Date(row.expires_at as string).getTime();
      if (Date.now() > expiresAt) return null;
      const context = typeof row.context === "string" ? (JSON.parse(row.context) as unknown) : (row.context ?? null);
      const result: StoredChallenge = { challenge, purpose, createdAt: new Date(row.created_at as string).getTime(), expiresAt, context };
      return result;
    },
  };
}

export function createNeonRealAccountRegistry(sql: NeonQueryFunction<false, false>): RealAccountRegistry {
  return {
    async createAccountWithPasskey({ account, passkey }) {
      try {
        const [accountRows, passkeyRows] = await sql.transaction([
          sql`
            INSERT INTO real_accounts (app_user_id, sub_organization_id, turnkey_user_id, wallet_id, wallet_account_id, owner_address, safe_address, account_config_version)
            VALUES (${account.appUserId}, ${account.subOrganizationId}, ${account.turnkeyUserId}, ${account.walletId}, ${account.walletAccountId}, ${account.ownerAddress}, ${account.safeAddress}, ${account.accountConfigVersion})
            RETURNING *
          `,
          sql`
            INSERT INTO real_passkeys (credential_id, app_user_id, credential_public_key, user_handle, counter, transports, credential_device_type, credential_backed_up, status)
            VALUES (${passkey.credentialId}, ${passkey.appUserId}, ${passkey.credentialPublicKey}, ${passkey.userHandle}, ${passkey.counter}, ${passkey.transports}, ${passkey.credentialDeviceType}, ${passkey.credentialBackedUp}, 'active')
            RETURNING *
          `,
        ]);
        return { account: toAccount((accountRows as Row[])[0]!), passkey: toPasskey((passkeyRows as Row[])[0]!) };
      } catch (error) {
        if (isUniqueViolation(error, "real_passkeys_pkey")) throw new DuplicateCredentialError(passkey.credentialId);
        if (isUniqueViolation(error, "real_accounts_pkey")) throw new DuplicateAccountError(account.appUserId);
        throw error;
      }
    },

    async findAccountByAppUserId(appUserId) {
      const rows = (await sql`SELECT * FROM real_accounts WHERE app_user_id = ${appUserId}`) as Row[];
      return rows[0] ? toAccount(rows[0]) : null;
    },

    async findPasskeyByCredentialId(credentialId) {
      const rows = (await sql`SELECT * FROM real_passkeys WHERE credential_id = ${credentialId}`) as Row[];
      return rows[0] ? toPasskey(rows[0]) : null;
    },

    async updateAuthenticatorCounter({ credentialId, counter }) {
      await sql`UPDATE real_passkeys SET counter = ${counter} WHERE credential_id = ${credentialId}`;
    },

    async revokePasskey(credentialId) {
      await sql`UPDATE real_passkeys SET status = 'revoked' WHERE credential_id = ${credentialId}`;
    },
  };
}

export function createNeonRegistrationAttemptStore(sql: NeonQueryFunction<false, false>): RegistrationAttemptStore {
  return {
    async createVerified(input) {
      try {
        const rows = (await sql`
          INSERT INTO registration_attempts (
            credential_id, app_user_id, user_handle, credential_public_key, counter, transports,
            credential_device_type, credential_backed_up, registration_challenge, raw_client_data_json,
            raw_attestation_object, state
          ) VALUES (
            ${input.credentialId}, ${input.appUserId}, ${input.userHandle}, ${input.credentialPublicKey}, ${input.counter}, ${input.transports},
            ${input.credentialDeviceType}, ${input.credentialBackedUp}, ${input.registrationChallenge}, ${input.rawClientDataJson},
            ${input.rawAttestationObject}, 'verified'
          ) RETURNING *
        `) as Row[];
        return toAttempt(rows[0]!);
      } catch (error) {
        if (isUniqueViolation(error, "registration_attempts_pkey")) throw new DuplicateCredentialError(input.credentialId);
        if (isUniqueViolation(error, "registration_attempts_app_user_id")) throw new DuplicateAccountError(input.appUserId);
        throw error;
      }
    },

    async findByCredentialId(credentialId) {
      const rows = (await sql`SELECT * FROM registration_attempts WHERE credential_id = ${credentialId}`) as Row[];
      return rows[0] ? toAttempt(rows[0]) : null;
    },

    async transition({ credentialId, from, to, patch }) {
      // A single UPDATE ... WHERE state = $from RETURNING * is the CAS: at
      // most one concurrent caller ever affects a row (Postgres row-level
      // locking), everyone else gets zero rows back and returns null.
      const rows = (await sql`
        UPDATE registration_attempts
        SET
          state = ${to},
          external_outcome = COALESCE(${patch?.externalOutcome ?? null}, external_outcome),
          external_provisioning_attempted_at = COALESCE(${patch?.externalProvisioningAttemptedAt ?? null}, external_provisioning_attempted_at),
          sub_organization_id = COALESCE(${patch?.subOrganizationId ?? null}, sub_organization_id),
          turnkey_user_id = COALESCE(${patch?.turnkeyUserId ?? null}, turnkey_user_id),
          wallet_id = COALESCE(${patch?.walletId ?? null}, wallet_id),
          wallet_account_id = COALESCE(${patch?.walletAccountId ?? null}, wallet_account_id),
          owner_address = COALESCE(${patch?.ownerAddress ?? null}, owner_address),
          safe_address = COALESCE(${patch?.safeAddress ?? null}, safe_address),
          account_config_version = COALESCE(${patch?.accountConfigVersion ?? null}, account_config_version),
          block_reason = COALESCE(${patch?.blockReason ?? null}, block_reason),
          counter = COALESCE(${patch?.counter ?? null}, counter),
          updated_at = now()
        WHERE credential_id = ${credentialId} AND state = ${from}
        RETURNING *
      `) as Row[];
      return rows[0] ? toAttempt(rows[0]) : null;
    },

    async updateCounter({ credentialId, counter }) {
      await sql`UPDATE registration_attempts SET counter = ${counter}, updated_at = now() WHERE credential_id = ${credentialId}`;
    },

    // Deliberately does NOT call registry.createAccountWithPasskey — the
    // passed-in `registry` param is kept for interface parity with the
    // in-memory adapter, but here it's the CALLER's registry (which may or
    // may not share this connection). To guarantee real cross-table
    // atomicity (registration_attempts + real_accounts + real_passkeys all
    // committing together or not at all), this performs the full write as
    // one sql.transaction() against the SAME connection this store itself
    // holds, then re-reads through the caller's registry so the returned
    // records reflect whatever that registry's own read path produces.
    async finalize({ credentialId, registry, safeAddress, accountConfigVersion }) {
      const attemptRows = (await sql`SELECT * FROM registration_attempts WHERE credential_id = ${credentialId}`) as Row[];
      const attempt = attemptRows[0] ? toAttempt(attemptRows[0]) : null;
      if (!attempt || attempt.state !== "turnkey_created") return null;
      if (!attempt.subOrganizationId || !attempt.turnkeyUserId || !attempt.walletId || !attempt.walletAccountId || !attempt.ownerAddress) return null;

      try {
        const results = await sql.transaction([
          sql`
            UPDATE registration_attempts
            SET state = 'active', safe_address = ${safeAddress}, account_config_version = ${accountConfigVersion}, updated_at = now()
            WHERE credential_id = ${credentialId} AND state = 'turnkey_created'
            RETURNING credential_id
          `,
          sql`
            INSERT INTO real_accounts (app_user_id, sub_organization_id, turnkey_user_id, wallet_id, wallet_account_id, owner_address, safe_address, account_config_version)
            VALUES (${attempt.appUserId}, ${attempt.subOrganizationId}, ${attempt.turnkeyUserId}, ${attempt.walletId}, ${attempt.walletAccountId}, ${attempt.ownerAddress}, ${safeAddress}, ${accountConfigVersion})
            RETURNING *
          `,
          sql`
            INSERT INTO real_passkeys (credential_id, app_user_id, credential_public_key, user_handle, counter, transports, credential_device_type, credential_backed_up, status)
            VALUES (${attempt.credentialId}, ${attempt.appUserId}, ${attempt.credentialPublicKey}, ${attempt.userHandle}, ${attempt.counter}, ${attempt.transports}, ${attempt.credentialDeviceType}, ${attempt.credentialBackedUp}, 'active')
            RETURNING *
          `,
        ]);
        const attemptUpdateRows = results[0] as Row[];
        if (attemptUpdateRows.length === 0) return null; // lost the CAS race
        const account = toAccount((results[1] as Row[])[0]!);
        const passkey = toPasskey((results[2] as Row[])[0]!);
        return { account, passkey };
      } catch (error) {
        if (isUniqueViolation(error)) {
          // Another concurrent finalize already created the account/passkey
          // — re-read via the caller's registry rather than treating this
          // as a hard failure.
          const account = await registry.findAccountByAppUserId(attempt.appUserId);
          const existingPasskey = await registry.findPasskeyByCredentialId(attempt.credentialId);
          if (account && existingPasskey) return { account, passkey: existingPasskey };
          return null;
        }
        throw error;
      }
    },
  };
}

export type NeonDurableStores = {
  challengeStore: ChallengeStore;
  registry: RealAccountRegistry;
  attempts: RegistrationAttemptStore;
};

/** One connection (Neon's HTTP query function is stateless/per-request-safe), three adapters. */
export function createNeonDurableStores(databaseUrl: string): NeonDurableStores {
  const sql = neon(databaseUrl);
  return {
    challengeStore: createNeonChallengeStore(sql),
    registry: createNeonRealAccountRegistry(sql),
    attempts: createNeonRegistrationAttemptStore(sql),
  };
}
