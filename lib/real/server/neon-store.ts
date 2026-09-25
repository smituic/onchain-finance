import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { ChallengePurpose, ChallengeStore, StoredChallenge } from "./challenge-store";
import { DuplicateAccountError, DuplicateCredentialError, type RealAccountRecord, type RealAccountRegistry, type RealPasskeyRecord } from "./registry";
import type { BackupPasskeyEnrollment, BackupPasskeyEnrollmentPatch, BackupPasskeyEnrollmentState, BackupPasskeyEnrollmentStore, EnrollmentExternalOutcome } from "./backup-passkey-enrollment";
import type { PasskeyRevocationAttempt, PasskeyRevocationStore, RevocationAttemptPatch, RevocationAttemptState } from "./passkey-revocation-attempts";
import type { ExternalProvisioningOutcome, RegistrationAttempt, RegistrationAttemptState, RegistrationAttemptStore } from "./registration-attempts";
import type { PaymentAttempt, PaymentAttemptState, PaymentAttemptStore, ReserveResult } from "./payment-attempts";

/**
 * SERVER-ONLY durable adapters for the vendor-neutral interfaces
 * (ChallengeStore, RealAccountRegistry, RegistrationAttemptStore,
 * PaymentAttemptStore, and Batch 2g's BackupPasskeyEnrollmentStore /
 * PasskeyRevocationStore), backed by Neon Postgres via
 * @neondatabase/serverless's HTTP query function — no persistent socket,
 * matching Next.js route handlers' request-scoped lifetime. Schema:
 * lib/real/server/schema.sql. Never imported by components, lib/real's
 * signing/domain modules, or any Zustand store — only by app/api/real/**
 * route handlers (via server/runtime.ts), and only when DATABASE_URL is
 * configured.
 *
 * Live-verified against a real Neon database: registration/restoration
 * (Batch 2b), Real Pay send (Batch 2d), and payment history (Batch 2e) —
 * see test/lib/real/neon-smoke.test.ts.
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
    role: row.role as RealPasskeyRecord["role"],
    turnkeyAuthenticatorId: (row.turnkey_authenticator_id as string | null) ?? null,
    displayName: (row.display_name as string | null) ?? null,
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

function isoOrNull(value: unknown): string | null {
  return value ? new Date(value as string).toISOString() : null;
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toBackupEnrollment(row: Row): BackupPasskeyEnrollment {
  return {
    id: row.id as string,
    appUserId: row.app_user_id as string,
    newCredentialId: (row.new_credential_id as string | null) ?? null,
    userHandle: (row.user_handle as string | null) ?? null,
    credentialPublicKey: (row.credential_public_key as string | null) ?? null,
    counter: numberOrNull(row.counter),
    transports: toStringArray(row.transports),
    credentialDeviceType: (row.credential_device_type as BackupPasskeyEnrollment["credentialDeviceType"]) ?? null,
    credentialBackedUp: (row.credential_backed_up as boolean | null) ?? null,
    registrationChallenge: (row.registration_challenge as string | null) ?? null,
    rawClientDataJson: (row.raw_client_data_json as string | null) ?? null,
    rawAttestationObject: (row.raw_attestation_object as string | null) ?? null,
    state: row.state as BackupPasskeyEnrollmentState,
    externalOutcome: row.external_outcome as EnrollmentExternalOutcome,
    externalEnrollmentAttemptedAt: isoOrNull(row.external_enrollment_attempted_at),
    authorizingCredentialId: (row.authorizing_credential_id as string | null) ?? null,
    turnkeyRequestEndpoint: (row.turnkey_request_endpoint as string | null) ?? null,
    turnkeyRequestBody: (row.turnkey_request_body as string | null) ?? null,
    turnkeyRequestBodySha256: (row.turnkey_request_body_sha256 as string | null) ?? null,
    turnkeyRequestTimestampMs: numberOrNull(row.turnkey_request_timestamp_ms),
    turnkeyRequestStamp: (row.turnkey_request_stamp as string | null) ?? null,
    turnkeyActivityId: (row.turnkey_activity_id as string | null) ?? null,
    turnkeyActivityStatus: (row.turnkey_activity_status as string | null) ?? null,
    turnkeyAuthenticatorId: (row.turnkey_authenticator_id as string | null) ?? null,
    turnkeyAuthenticatorPublicKey: (row.turnkey_authenticator_public_key as string | null) ?? null,
    signingProofChallenge: (row.signing_proof_challenge as string | null) ?? null,
    signingProofActivityId: (row.signing_proof_activity_id as string | null) ?? null,
    loginVerifiedAt: isoOrNull(row.login_verified_at),
    signingVerifiedAt: isoOrNull(row.signing_verified_at),
    blockReason: (row.block_reason as string | null) ?? null,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

function toRevocationAttempt(row: Row): PasskeyRevocationAttempt {
  return {
    id: row.id as string,
    appUserId: row.app_user_id as string,
    targetCredentialId: row.target_credential_id as string,
    targetTurnkeyAuthenticatorId: row.target_turnkey_authenticator_id as string,
    authorizerCredentialId: row.authorizer_credential_id as string,
    state: row.state as RevocationAttemptState,
    turnkeyRequestBody: (row.turnkey_request_body as string | null) ?? null,
    turnkeyRequestBodySha256: (row.turnkey_request_body_sha256 as string | null) ?? null,
    turnkeyRequestTimestampMs: numberOrNull(row.turnkey_request_timestamp_ms),
    turnkeyRequestStamp: (row.turnkey_request_stamp as string | null) ?? null,
    externalAttemptedAt: isoOrNull(row.external_attempted_at),
    turnkeyActivityId: (row.turnkey_activity_id as string | null) ?? null,
    turnkeyActivityStatus: (row.turnkey_activity_status as string | null) ?? null,
    failureReason: (row.failure_reason as string | null) ?? null,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

function toPaymentAttempt(row: Row): PaymentAttempt {
  return {
    id: row.id as string,
    appUserId: row.app_user_id as string,
    safeAddress: row.safe_address as string,
    recipient: row.recipient as string,
    amountBaseUnits: row.amount_base_units as string,
    chainId: Number(row.chain_id),
    tokenAddress: row.token_address as string,
    state: row.state as PaymentAttemptState,
    nonce: (row.nonce as string | null) ?? null,
    callData: (row.call_data as string | null) ?? null,
    factory: (row.factory as string | null) ?? null,
    factoryData: (row.factory_data as string | null) ?? null,
    callGasLimit: (row.call_gas_limit as string | null) ?? null,
    verificationGasLimit: (row.verification_gas_limit as string | null) ?? null,
    preVerificationGas: (row.pre_verification_gas as string | null) ?? null,
    maxFeePerGas: (row.max_fee_per_gas as string | null) ?? null,
    maxPriorityFeePerGas: (row.max_priority_fee_per_gas as string | null) ?? null,
    paymaster: (row.paymaster as string | null) ?? null,
    paymasterData: (row.paymaster_data as string | null) ?? null,
    paymasterVerificationGasLimit: (row.paymaster_verification_gas_limit as string | null) ?? null,
    paymasterPostOpGasLimit: (row.paymaster_post_op_gas_limit as string | null) ?? null,
    expectedUserOperationHash: (row.expected_user_operation_hash as string | null) ?? null,
    transactionHash: (row.transaction_hash as string | null) ?? null,
    failureReason: (row.failure_reason as string | null) ?? null,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

/**
 * Neon's HTTP sql.transaction() is a NON-interactive batch: a later
 * statement can't be skipped based on an earlier one's row count. Multi-row
 * Batch 2g operations therefore end with a guard SELECT that casts a
 * row-dependent string to int only when the batch's outcome is
 * inconsistent (a lost race) — the resulting 22P02 error aborts and rolls
 * back the WHOLE transaction. The cast operand always references a column,
 * so the planner can never constant-fold it into an unconditional error.
 */
function isGuardAbort(error: unknown, sentinel: string): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code: unknown }).code) : "";
  const message = "message" in error ? String((error as { message: unknown }).message) : "";
  return code === "22P02" && message.includes(sentinel);
}

function has<T extends object>(patch: T | undefined, key: keyof T): boolean {
  return patch !== undefined && patch[key] !== undefined;
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
            INSERT INTO real_passkeys (credential_id, app_user_id, credential_public_key, user_handle, counter, transports, credential_device_type, credential_backed_up, status, role)
            VALUES (${passkey.credentialId}, ${passkey.appUserId}, ${passkey.credentialPublicKey}, ${passkey.userHandle}, ${passkey.counter}, ${passkey.transports}, ${passkey.credentialDeviceType}, ${passkey.credentialBackedUp}, 'active', 'primary')
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

    async findPasskeysByAppUserId(appUserId) {
      const rows = (await sql`SELECT * FROM real_passkeys WHERE app_user_id = ${appUserId} ORDER BY created_at ASC`) as Row[];
      return rows.map(toPasskey);
    },

    async updateAuthenticatorCounter({ credentialId, counter }) {
      await sql`UPDATE real_passkeys SET counter = ${counter} WHERE credential_id = ${credentialId}`;
    },

    async transitionPasskeyStatus({ credentialId, from, to, patch }) {
      const rows = (await sql`
        UPDATE real_passkeys
        SET
          status = ${to},
          turnkey_authenticator_id = COALESCE(${patch?.turnkeyAuthenticatorId ?? null}, turnkey_authenticator_id)
        WHERE credential_id = ${credentialId} AND status = ${from}
        RETURNING *
      `) as Row[];
      return rows[0] ? toPasskey(rows[0]) : null;
    },

    async renamePasskey({ appUserId, credentialId, displayName }) {
      const rows = (await sql`
        UPDATE real_passkeys SET display_name = ${displayName}
        WHERE credential_id = ${credentialId} AND app_user_id = ${appUserId} AND status = 'active'
        RETURNING *
      `) as Row[];
      if (rows[0]) return { outcome: "renamed", passkey: toPasskey(rows[0]) };
      // Only to pick the right refusal — scoped to the same account, so another account's credential stays "not_found".
      const existing = (await sql`SELECT 1 FROM real_passkeys WHERE credential_id = ${credentialId} AND app_user_id = ${appUserId}`) as Row[];
      return { outcome: existing.length > 0 ? "not_active" : "not_found" };
    },
  };
}

export function createNeonBackupPasskeyEnrollmentStore(sql: NeonQueryFunction<false, false>): BackupPasskeyEnrollmentStore {
  return {
    async createStarted({ appUserId }) {
      try {
        const rows = (await sql`INSERT INTO backup_passkey_enrollments (app_user_id, state) VALUES (${appUserId}, 'started') RETURNING *`) as Row[];
        return toBackupEnrollment(rows[0]!);
      } catch (error) {
        if (isUniqueViolation(error, "backup_passkey_enrollments_one_active_per_account")) return null;
        throw error;
      }
    },

    async findById(id) {
      const rows = (await sql`SELECT * FROM backup_passkey_enrollments WHERE id = ${id}`) as Row[];
      return rows[0] ? toBackupEnrollment(rows[0]) : null;
    },

    async findActiveByAppUserId(appUserId) {
      const rows = (await sql`
        SELECT * FROM backup_passkey_enrollments
        WHERE app_user_id = ${appUserId} AND state NOT IN ('active', 'abandoned', 'blocked')
        ORDER BY created_at DESC LIMIT 1
      `) as Row[];
      return rows[0] ? toBackupEnrollment(rows[0]) : null;
    },

    async registerCredential({ id, credential }) {
      try {
        const results = await sql.transaction([
          sql`
            INSERT INTO real_passkeys (credential_id, app_user_id, credential_public_key, user_handle, counter, transports, credential_device_type, credential_backed_up, status, role)
            SELECT ${credential.credentialId}, e.app_user_id, ${credential.credentialPublicKey}, ${credential.userHandle}, ${credential.counter}, ${credential.transports}, ${credential.credentialDeviceType}, ${credential.credentialBackedUp}, 'pending', 'backup'
            FROM backup_passkey_enrollments e WHERE e.id = ${id} AND e.state = 'started'
          `,
          sql`
            UPDATE backup_passkey_enrollments SET
              state = 'credential_registered',
              new_credential_id = ${credential.credentialId},
              user_handle = ${credential.userHandle},
              credential_public_key = ${credential.credentialPublicKey},
              counter = ${credential.counter},
              transports = ${credential.transports},
              credential_device_type = ${credential.credentialDeviceType},
              credential_backed_up = ${credential.credentialBackedUp},
              registration_challenge = ${credential.registrationChallenge},
              raw_client_data_json = ${credential.rawClientDataJson},
              raw_attestation_object = ${credential.rawAttestationObject},
              updated_at = now()
            WHERE id = ${id} AND state = 'started'
            RETURNING *
          `,
          // Lost the CAS (another request attached a different credential):
          // abort, rolling back the INSERT above — never an orphan pending row.
          sql`
            SELECT (e.state || ':backup_attach_lost_race')::int FROM backup_passkey_enrollments e
            WHERE e.id = ${id} AND (e.state <> 'credential_registered' OR e.new_credential_id IS DISTINCT FROM ${credential.credentialId})
          `,
        ]);
        const rows = results[1] as Row[];
        return rows[0] ? toBackupEnrollment(rows[0]) : null;
      } catch (error) {
        if (isGuardAbort(error, "backup_attach_lost_race")) return null;
        if (isUniqueViolation(error, "real_passkeys_pkey") || isUniqueViolation(error, "backup_passkey_enrollments_new_credential_id_key")) {
          throw new DuplicateCredentialError(credential.credentialId);
        }
        throw error;
      }
    },

    async transition({ id, from, to, patch }) {
      const p: BackupPasskeyEnrollmentPatch | undefined = patch;
      const rows = (await sql`
        UPDATE backup_passkey_enrollments SET
          state = ${to},
          external_outcome = COALESCE(${p?.externalOutcome ?? null}, external_outcome),
          external_enrollment_attempted_at = CASE WHEN ${has(p, "externalEnrollmentAttemptedAt")} THEN ${p?.externalEnrollmentAttemptedAt ?? null}::timestamptz ELSE external_enrollment_attempted_at END,
          authorizing_credential_id = CASE WHEN ${has(p, "authorizingCredentialId")} THEN ${p?.authorizingCredentialId ?? null} ELSE authorizing_credential_id END,
          turnkey_request_endpoint = CASE WHEN ${has(p, "turnkeyRequestEndpoint")} THEN ${p?.turnkeyRequestEndpoint ?? null} ELSE turnkey_request_endpoint END,
          turnkey_request_body = CASE WHEN ${has(p, "turnkeyRequestBody")} THEN ${p?.turnkeyRequestBody ?? null} ELSE turnkey_request_body END,
          turnkey_request_body_sha256 = CASE WHEN ${has(p, "turnkeyRequestBodySha256")} THEN ${p?.turnkeyRequestBodySha256 ?? null} ELSE turnkey_request_body_sha256 END,
          turnkey_request_timestamp_ms = CASE WHEN ${has(p, "turnkeyRequestTimestampMs")} THEN ${p?.turnkeyRequestTimestampMs ?? null}::bigint ELSE turnkey_request_timestamp_ms END,
          turnkey_request_stamp = CASE WHEN ${has(p, "turnkeyRequestStamp")} THEN ${p?.turnkeyRequestStamp ?? null} ELSE turnkey_request_stamp END,
          turnkey_activity_id = CASE WHEN ${has(p, "turnkeyActivityId")} THEN ${p?.turnkeyActivityId ?? null} ELSE turnkey_activity_id END,
          turnkey_activity_status = CASE WHEN ${has(p, "turnkeyActivityStatus")} THEN ${p?.turnkeyActivityStatus ?? null} ELSE turnkey_activity_status END,
          signing_proof_challenge = CASE WHEN ${has(p, "signingProofChallenge")} THEN ${p?.signingProofChallenge ?? null} ELSE signing_proof_challenge END,
          login_verified_at = CASE WHEN ${has(p, "loginVerifiedAt")} THEN ${p?.loginVerifiedAt ?? null}::timestamptz ELSE login_verified_at END,
          block_reason = CASE WHEN ${has(p, "blockReason")} THEN ${p?.blockReason ?? null} ELSE block_reason END,
          updated_at = now()
        WHERE id = ${id} AND state = ${from}
        RETURNING *
      `) as Row[];
      return rows[0] ? toBackupEnrollment(rows[0]) : null;
    },

    async confirmCreated({ id, turnkeyAuthenticatorId, turnkeyAuthenticatorPublicKey, turnkeyActivityStatus }) {
      try {
        const results = await sql.transaction([
          sql`
            UPDATE backup_passkey_enrollments SET
              state = 'turnkey_authenticator_created',
              external_outcome = 'confirmed_created',
              turnkey_authenticator_id = ${turnkeyAuthenticatorId},
              turnkey_authenticator_public_key = ${turnkeyAuthenticatorPublicKey},
              turnkey_activity_status = COALESCE(${turnkeyActivityStatus}, turnkey_activity_status),
              turnkey_request_stamp = NULL,
              updated_at = now()
            WHERE id = ${id} AND state = 'turnkey_enrollment_in_flight'
            RETURNING *
          `,
          sql`
            UPDATE real_passkeys SET turnkey_authenticator_id = ${turnkeyAuthenticatorId}
            WHERE credential_id = (SELECT new_credential_id FROM backup_passkey_enrollments WHERE id = ${id} AND state = 'turnkey_authenticator_created' AND turnkey_authenticator_id = ${turnkeyAuthenticatorId})
              AND status = 'pending' AND turnkey_authenticator_id IS NULL
          `,
          sql`
            SELECT (e.state || ':backup_confirm_mismatch')::int FROM backup_passkey_enrollments e
            WHERE e.id = ${id} AND e.state = 'turnkey_authenticator_created' AND e.turnkey_authenticator_id = ${turnkeyAuthenticatorId}
              AND NOT EXISTS (SELECT 1 FROM real_passkeys p WHERE p.credential_id = e.new_credential_id AND p.turnkey_authenticator_id = ${turnkeyAuthenticatorId})
          `,
        ]);
        const rows = results[0] as Row[];
        return rows[0] ? toBackupEnrollment(rows[0]) : null;
      } catch (error) {
        if (isGuardAbort(error, "backup_confirm_mismatch") || isUniqueViolation(error, "real_passkeys_turnkey_authenticator_id_key")) return null;
        throw error;
      }
    },

    async activate({ id, signingProofActivityId }) {
      try {
        const results = await sql.transaction([
          sql`
            UPDATE backup_passkey_enrollments SET state = 'active', signing_proof_activity_id = ${signingProofActivityId}, signing_verified_at = now(), updated_at = now()
            WHERE id = ${id} AND state = 'login_verified' AND login_verified_at IS NOT NULL
            RETURNING *
          `,
          sql`
            UPDATE real_passkeys SET status = 'active'
            WHERE credential_id = (SELECT new_credential_id FROM backup_passkey_enrollments WHERE id = ${id} AND state = 'active')
              AND status = 'pending' AND turnkey_authenticator_id IS NOT NULL
          `,
          // Never "enrollment active + passkey not active": abort the whole batch instead.
          sql`
            SELECT (e.state || ':backup_activation_mismatch')::int FROM backup_passkey_enrollments e
            WHERE e.id = ${id} AND e.state = 'active'
              AND NOT EXISTS (SELECT 1 FROM real_passkeys p WHERE p.credential_id = e.new_credential_id AND p.status = 'active')
          `,
        ]);
        const rows = results[0] as Row[];
        return rows[0] ? toBackupEnrollment(rows[0]) : null;
      } catch (error) {
        if (isGuardAbort(error, "backup_activation_mismatch")) return null;
        throw error;
      }
    },

    async abandon({ id }) {
      const results = await sql.transaction([
        sql`
          UPDATE backup_passkey_enrollments SET state = 'abandoned', turnkey_request_stamp = NULL, updated_at = now()
          WHERE id = ${id} AND (state = 'started' OR (state = 'credential_registered' AND external_outcome IN ('not_attempted', 'definitive_failure')))
          RETURNING *
        `,
        sql`
          UPDATE real_passkeys SET status = 'revoked'
          WHERE credential_id = (SELECT new_credential_id FROM backup_passkey_enrollments WHERE id = ${id} AND state = 'abandoned') AND status = 'pending'
        `,
      ]);
      const rows = results[0] as Row[];
      return rows[0] ? toBackupEnrollment(rows[0]) : null;
    },
  };
}

export function createNeonPasskeyRevocationStore(sql: NeonQueryFunction<false, false>): PasskeyRevocationStore {
  async function explainRefusal(appUserId: string, targetCredentialId: string, authorizerCredentialId: string) {
    const rows = (await sql`
      SELECT
        (SELECT status FROM real_passkeys WHERE credential_id = ${authorizerCredentialId} AND app_user_id = ${appUserId} AND turnkey_authenticator_id IS NOT NULL) AS authorizer_status,
        EXISTS (SELECT 1 FROM passkey_revocation_attempts WHERE target_credential_id = ${targetCredentialId} AND state = 'dispatch_in_flight') AS dispatched
    `) as Row[];
    const row = rows[0] ?? {};
    if (row.authorizer_status !== "active") return "authorizer_not_eligible" as const;
    if (row.dispatched === true) return "removal_in_progress" as const;
    return "target_not_removable" as const;
  }

  return {
    async prepare({ appUserId, targetCredentialId, authorizerCredentialId }) {
      if (targetCredentialId === authorizerCredentialId) return { ok: false, reason: "same_credential" };
      // Changes no passkey status — a cookie alone never disables a credential.
      const rows = (await sql`
        INSERT INTO passkey_revocation_attempts (app_user_id, target_credential_id, target_turnkey_authenticator_id, authorizer_credential_id, state)
        SELECT ${appUserId}, t.credential_id, t.turnkey_authenticator_id, ${authorizerCredentialId}, 'authorization_needed'
        FROM real_passkeys t
        WHERE t.credential_id = ${targetCredentialId} AND t.app_user_id = ${appUserId} AND t.status = 'active' AND t.turnkey_authenticator_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM real_passkeys s
            WHERE s.credential_id = ${authorizerCredentialId} AND s.app_user_id = ${appUserId} AND s.status = 'active' AND s.turnkey_authenticator_id IS NOT NULL
          )
          AND NOT EXISTS (SELECT 1 FROM passkey_revocation_attempts d WHERE d.target_credential_id = ${targetCredentialId} AND d.state = 'dispatch_in_flight')
        RETURNING *
      `) as Row[];
      if (rows[0]) return { ok: true, attempt: toRevocationAttempt(rows[0]) };
      return { ok: false, reason: await explainRefusal(appUserId, targetCredentialId, authorizerCredentialId) };
    },

    async findById(id) {
      const rows = (await sql`SELECT * FROM passkey_revocation_attempts WHERE id = ${id}`) as Row[];
      return rows[0] ? toRevocationAttempt(rows[0]) : null;
    },

    async findLatestPerTarget(appUserId) {
      const rows = (await sql`
        SELECT DISTINCT ON (target_credential_id) * FROM passkey_revocation_attempts
        WHERE app_user_id = ${appUserId}
        ORDER BY target_credential_id, created_at DESC
      `) as Row[];
      return rows.map(toRevocationAttempt);
    },

    async transition({ id, from, to, patch }) {
      const p: RevocationAttemptPatch | undefined = patch;
      const rows = (await sql`
        UPDATE passkey_revocation_attempts SET
          state = ${to},
          turnkey_request_body = CASE WHEN ${has(p, "turnkeyRequestBody")} THEN ${p?.turnkeyRequestBody ?? null} ELSE turnkey_request_body END,
          turnkey_request_body_sha256 = CASE WHEN ${has(p, "turnkeyRequestBodySha256")} THEN ${p?.turnkeyRequestBodySha256 ?? null} ELSE turnkey_request_body_sha256 END,
          turnkey_request_timestamp_ms = CASE WHEN ${has(p, "turnkeyRequestTimestampMs")} THEN ${p?.turnkeyRequestTimestampMs ?? null}::bigint ELSE turnkey_request_timestamp_ms END,
          turnkey_request_stamp = CASE WHEN ${has(p, "turnkeyRequestStamp")} THEN ${p?.turnkeyRequestStamp ?? null} ELSE turnkey_request_stamp END,
          external_attempted_at = CASE WHEN ${has(p, "externalAttemptedAt")} THEN ${p?.externalAttemptedAt ?? null}::timestamptz ELSE external_attempted_at END,
          turnkey_activity_status = CASE WHEN ${has(p, "turnkeyActivityStatus")} THEN ${p?.turnkeyActivityStatus ?? null} ELSE turnkey_activity_status END,
          failure_reason = CASE WHEN ${has(p, "failureReason")} THEN ${p?.failureReason ?? null} ELSE failure_reason END,
          updated_at = now()
        WHERE id = ${id} AND state = ${from}
        RETURNING *
      `) as Row[];
      return rows[0] ? toRevocationAttempt(rows[0]) : null;
    },

    async beginDispatch({ id, patch }) {
      try {
        const results = await sql.transaction([
          // Serializes every dispatch for this account: a racing beginDispatch
          // blocks here until this transaction commits, and its next
          // statement reads the committed result (READ COMMITTED takes a fresh
          // snapshot per statement).
          sql`SELECT app_user_id FROM real_accounts WHERE app_user_id = (SELECT app_user_id FROM passkey_revocation_attempts WHERE id = ${id}) FOR UPDATE`,
          sql`
            UPDATE passkey_revocation_attempts r SET
              state = 'dispatch_in_flight',
              turnkey_request_body = ${patch.turnkeyRequestBody ?? null},
              turnkey_request_body_sha256 = ${patch.turnkeyRequestBodySha256 ?? null},
              turnkey_request_timestamp_ms = ${patch.turnkeyRequestTimestampMs ?? null}::bigint,
              turnkey_request_stamp = ${patch.turnkeyRequestStamp ?? null},
              external_attempted_at = ${patch.externalAttemptedAt ?? null}::timestamptz,
              updated_at = now()
            WHERE r.id = ${id} AND r.state = 'authorization_needed' AND r.target_credential_id <> r.authorizer_credential_id
              AND EXISTS (
                SELECT 1 FROM real_passkeys t
                WHERE t.credential_id = r.target_credential_id AND t.app_user_id = r.app_user_id AND t.status = 'active'
                  AND t.turnkey_authenticator_id = r.target_turnkey_authenticator_id
              )
              AND EXISTS (
                SELECT 1 FROM real_passkeys s
                WHERE s.credential_id = r.authorizer_credential_id AND s.app_user_id = r.app_user_id AND s.status = 'active' AND s.turnkey_authenticator_id IS NOT NULL
              )
            RETURNING *
          `,
          sql`
            UPDATE real_passkeys SET status = 'revoking'
            WHERE credential_id = (SELECT target_credential_id FROM passkey_revocation_attempts WHERE id = ${id} AND state = 'dispatch_in_flight')
              AND status = 'active'
          `,
          // Never "attempt dispatched + target still active": abort the whole batch instead.
          sql`
            SELECT (r.state || ':revocation_dispatch_mismatch')::int FROM passkey_revocation_attempts r
            WHERE r.id = ${id} AND r.state = 'dispatch_in_flight'
              AND NOT EXISTS (SELECT 1 FROM real_passkeys p WHERE p.credential_id = r.target_credential_id AND p.status = 'revoking')
          `,
        ]);
        const rows = results[1] as Row[];
        return rows[0] ? toRevocationAttempt(rows[0]) : null;
      } catch (error) {
        if (isGuardAbort(error, "revocation_dispatch_mismatch") || isUniqueViolation(error, "passkey_revocation_attempts_one_dispatch_per_target")) return null;
        throw error;
      }
    },

    async recordActivity({ id, activityId, activityStatus }) {
      const rows = (await sql`
        UPDATE passkey_revocation_attempts SET
          turnkey_activity_id = ${activityId}, turnkey_activity_status = ${activityStatus}, turnkey_request_stamp = NULL, updated_at = now()
        WHERE id = ${id} AND state = 'dispatch_in_flight' AND turnkey_activity_id IS NULL
        RETURNING *
      `) as Row[];
      return rows[0] ? toRevocationAttempt(rows[0]) : null;
    },

    async confirmDeleted({ id, turnkeyActivityStatus }) {
      try {
        const results = await sql.transaction([
          // Same per-account serialization as beginDispatch, so the role
          // promotion below can't interleave with another removal's dispatch.
          sql`SELECT app_user_id FROM real_accounts WHERE app_user_id = (SELECT app_user_id FROM passkey_revocation_attempts WHERE id = ${id}) FOR UPDATE`,
          sql`
            UPDATE passkey_revocation_attempts SET state = 'confirmed', turnkey_activity_status = ${turnkeyActivityStatus}, turnkey_request_stamp = NULL, updated_at = now()
            WHERE id = ${id} AND state = 'dispatch_in_flight'
            RETURNING *
          `,
          sql`
            UPDATE real_passkeys SET status = 'revoked'
            WHERE credential_id = (SELECT target_credential_id FROM passkey_revocation_attempts WHERE id = ${id} AND state = 'confirmed') AND status = 'revoking'
          `,
          // Role is app metadata only: no non-revoked primary left -> the
          // oldest active passkey becomes primary. Never touches status,
          // identity, or Turnkey mapping.
          sql`
            UPDATE real_passkeys p SET role = 'primary'
            WHERE p.credential_id = (
                SELECT s.credential_id FROM real_passkeys s
                JOIN passkey_revocation_attempts a ON a.app_user_id = s.app_user_id
                WHERE a.id = ${id} AND a.state = 'confirmed' AND s.status = 'active'
                ORDER BY s.created_at ASC, s.credential_id ASC LIMIT 1
              )
              AND p.role = 'backup'
              AND NOT EXISTS (SELECT 1 FROM real_passkeys q WHERE q.app_user_id = p.app_user_id AND q.role = 'primary' AND q.status <> 'revoked')
          `,
          sql`
            SELECT (a.state || ':revocation_confirm_mismatch')::int FROM passkey_revocation_attempts a
            WHERE a.id = ${id} AND a.state = 'confirmed'
              AND NOT EXISTS (SELECT 1 FROM real_passkeys p WHERE p.credential_id = a.target_credential_id AND p.status = 'revoked')
          `,
          // Never "confirmed" while an active survivor is left without a primary: abort the whole batch instead.
          sql`
            SELECT (a.state || ':revocation_confirm_mismatch')::int FROM passkey_revocation_attempts a
            WHERE a.id = ${id} AND a.state = 'confirmed'
              AND EXISTS (SELECT 1 FROM real_passkeys p WHERE p.app_user_id = a.app_user_id AND p.status = 'active')
              AND NOT EXISTS (SELECT 1 FROM real_passkeys p WHERE p.app_user_id = a.app_user_id AND p.role = 'primary' AND p.status <> 'revoked')
          `,
        ]);
        const rows = results[1] as Row[];
        return rows[0] ? toRevocationAttempt(rows[0]) : null;
      } catch (error) {
        if (isGuardAbort(error, "revocation_confirm_mismatch")) return null;
        throw error;
      }
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

/**
 * Batch 2d: durable Real Pay attempts. `reserve()` is a SINGLE SQL statement
 * (a CTE) — never a separate count-then-insert pair — so no caller can
 * observe a "count says OK" result and then race a second INSERT past it;
 * the count and the INSERT are the same statement:
 *
 *  1. `pg_advisory_xact_lock(hashtext(app_user_id))` — the TRANSACTION-scoped
 *     variant, not the session-scoped `pg_advisory_lock` — serializes
 *     concurrent reserve() EXECUTION ORDER for the SAME account only
 *     (different accounts never contend) and releases automatically when
 *     this single statement's implicit transaction ends. This matters
 *     specifically because Neon's HTTP query function opens a fresh
 *     connection per call (there is no persistent session to scope a
 *     session-level lock to, and a session-scoped lock could leak
 *     indefinitely on a driver that never reuses connections); a
 *     transaction-scoped lock has no such failure mode.
 *  2. `_lock` is marked `MATERIALIZED` and its result is cross-joined into
 *     `_counts`'s FROM clause, so the lock is provably acquired before the
 *     quota counts are read WITHIN THIS STATEMENT's own execution.
 *  3. The INSERT only happens `WHERE hourly < 10 AND daily < 30 AND active = 0`.
 *
 * PRE-2F CORRECTED CLAIM (two independent audits, 2026-09): the advisory
 * lock does NOT refresh this statement's read-committed snapshot. If this
 * statement was blocked waiting on the lock, and the transaction holding it
 * committed a new row in the meantime, that row is not guaranteed visible
 * to `_counts` once the lock is granted and this statement resumes —
 * Postgres does not re-snapshot mid-statement under READ COMMITTED. So the
 * lock does not, by itself, make the hourly/daily numeric quota counts
 * airtight under concurrency; they're serially enforced and best-effort
 * precise, not a cryptographically tight bound.
 *
 * What DOES hold unconditionally is the one-active-attempt-per-account
 * invariant: the partial unique index (payment_attempts_one_active_per_account,
 * see schema.sql) is a hard Postgres constraint checked against current
 * committed reality at INSERT time, independent of any statement's
 * snapshot — so a second concurrent reserve() for the same account is
 * refused either by this statement's own active-count check or, failing
 * that, by the unique index itself (surfaced here as a 23505
 * unique-violation mapped to "payment_in_progress"). Quota is not
 * bypassable in the way that would matter (two active payments at once);
 * the numeric hourly/daily counts just aren't proven mathematically exact.
 * If a future design ever allows more than one active payment per account,
 * this reservation logic must be revisited — the unique index's backstop
 * role goes away.
 */
export function createNeonPaymentAttemptStore(sql: NeonQueryFunction<false, false>): PaymentAttemptStore {
  return {
    async reserve(input): Promise<ReserveResult> {
      try {
        const rows = (await sql`
          WITH _lock AS MATERIALIZED (
            SELECT pg_advisory_xact_lock(hashtext(${input.appUserId})::bigint)
          ), _counts AS (
            SELECT
              count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS hourly,
              count(*) FILTER (WHERE created_at > now() - interval '1 day') AS daily,
              count(*) FILTER (WHERE state NOT IN ('confirmed', 'failed', 'cancelled')) AS active
            FROM payment_attempts, _lock
            WHERE app_user_id = ${input.appUserId}
          )
          INSERT INTO payment_attempts (app_user_id, safe_address, recipient, amount_base_units, chain_id, token_address, state)
          SELECT ${input.appUserId}, ${input.safeAddress}, ${input.recipient}, ${input.amountBaseUnits}, ${input.chainId}, ${input.tokenAddress}, 'prepared'
          FROM _counts
          WHERE hourly < 10 AND daily < 30 AND active = 0
          RETURNING *
        `) as Row[];

        if (rows.length === 0) {
          // The statement ran but its WHERE matched nothing — need one more
          // read to tell "quota" apart from "already has one in flight" for
          // an accurate result (the write itself already refused either
          // way, so this read is informational, not a second decision).
          const counts = (await sql`
            SELECT
              count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS hourly,
              count(*) FILTER (WHERE created_at > now() - interval '1 day') AS daily,
              count(*) FILTER (WHERE state NOT IN ('confirmed', 'failed', 'cancelled')) AS active
            FROM payment_attempts WHERE app_user_id = ${input.appUserId}
          `) as Row[];
          const active = Number(counts[0]?.active ?? 0);
          if (active > 0) return { ok: false, reason: "payment_in_progress" };
          return { ok: false, reason: "quota_exceeded" };
        }

        return { ok: true, attempt: toPaymentAttempt(rows[0]!) };
      } catch (error) {
        if (isUniqueViolation(error, "payment_attempts_one_active_per_account")) {
          return { ok: false, reason: "payment_in_progress" };
        }
        throw error;
      }
    },

    async findById(id) {
      const rows = (await sql`SELECT * FROM payment_attempts WHERE id = ${id}`) as Row[];
      return rows[0] ? toPaymentAttempt(rows[0]) : null;
    },

    async findLatestByAppUserId(appUserId) {
      const rows = (await sql`
        SELECT * FROM payment_attempts WHERE app_user_id = ${appUserId} ORDER BY created_at DESC LIMIT 1
      `) as Row[];
      return rows[0] ? toPaymentAttempt(rows[0]) : null;
    },

    // Batch 2e: bounded history read, served by the same
    // (app_user_id, created_at DESC) index findLatestByAppUserId already
    // uses. `limit` is a plain integer already clamped by the caller
    // (server/payment-history.ts), passed as a bound parameter — never
    // string-interpolated into the query. `id DESC` is a secondary,
    // deterministic tie-break for the (rare, TIMESTAMPTZ-microsecond-
    // resolution) case of two rows sharing created_at — it does not carry
    // "most recently inserted" meaning the way the in-memory adapter's own
    // tie-break does, since payment_attempts.id is a random UUID with no
    // correlation to insertion order; it only guarantees a fixed, repeatable
    // order for a given data set.
    async findRecentByAppUserId({ appUserId, limit }) {
      const rows = (await sql`
        SELECT * FROM payment_attempts WHERE app_user_id = ${appUserId} ORDER BY created_at DESC, id DESC LIMIT ${limit}
      `) as Row[];
      return rows.map(toPaymentAttempt);
    },

    async transition({ id, from, to, patch }) {
      const rows = (await sql`
        UPDATE payment_attempts
        SET
          state = ${to},
          nonce = COALESCE(${patch?.nonce ?? null}, nonce),
          call_data = COALESCE(${patch?.callData ?? null}, call_data),
          factory = COALESCE(${patch?.factory ?? null}, factory),
          factory_data = COALESCE(${patch?.factoryData ?? null}, factory_data),
          call_gas_limit = COALESCE(${patch?.callGasLimit ?? null}, call_gas_limit),
          verification_gas_limit = COALESCE(${patch?.verificationGasLimit ?? null}, verification_gas_limit),
          pre_verification_gas = COALESCE(${patch?.preVerificationGas ?? null}, pre_verification_gas),
          max_fee_per_gas = COALESCE(${patch?.maxFeePerGas ?? null}, max_fee_per_gas),
          max_priority_fee_per_gas = COALESCE(${patch?.maxPriorityFeePerGas ?? null}, max_priority_fee_per_gas),
          paymaster = COALESCE(${patch?.paymaster ?? null}, paymaster),
          paymaster_data = COALESCE(${patch?.paymasterData ?? null}, paymaster_data),
          paymaster_verification_gas_limit = COALESCE(${patch?.paymasterVerificationGasLimit ?? null}, paymaster_verification_gas_limit),
          paymaster_post_op_gas_limit = COALESCE(${patch?.paymasterPostOpGasLimit ?? null}, paymaster_post_op_gas_limit),
          expected_user_operation_hash = COALESCE(${patch?.expectedUserOperationHash ?? null}, expected_user_operation_hash),
          transaction_hash = COALESCE(${patch?.transactionHash ?? null}, transaction_hash),
          failure_reason = COALESCE(${patch?.failureReason ?? null}, failure_reason),
          updated_at = now()
        WHERE id = ${id} AND state = ${from}
        RETURNING *
      `) as Row[];
      return rows[0] ? toPaymentAttempt(rows[0]) : null;
    },
  };
}

export type NeonDurableStores = {
  challengeStore: ChallengeStore;
  registry: RealAccountRegistry;
  attempts: RegistrationAttemptStore;
  payments: PaymentAttemptStore;
  backupEnrollments: BackupPasskeyEnrollmentStore;
  revocations: PasskeyRevocationStore;
};

/** One connection (Neon's HTTP query function is stateless/per-request-safe), six adapters. */
export function createNeonDurableStores(databaseUrl: string): NeonDurableStores {
  const sql = neon(databaseUrl);
  return {
    challengeStore: createNeonChallengeStore(sql),
    registry: createNeonRealAccountRegistry(sql),
    attempts: createNeonRegistrationAttemptStore(sql),
    payments: createNeonPaymentAttemptStore(sql),
    backupEnrollments: createNeonBackupPasskeyEnrollmentStore(sql),
    revocations: createNeonPasskeyRevocationStore(sql),
  };
}
