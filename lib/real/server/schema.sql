-- Real Mode durable schema (Neon Postgres). One database.
-- No private keys, no Turnkey signing/session credentials, no WebAuthn
-- private material — only public account/credential identifiers and
-- public attestation objects (needed to retry Turnkey provisioning after
-- an uncertain external-call outcome; these are public ceremony artifacts,
-- not secrets).

-- Short-lived, one-time, purpose-bound WebAuthn challenges.
-- 'backup_registration'/'backup_login_verification' are Batch 2g's backup-
-- passkey purposes — kept distinct from 'registration'/'login' so a
-- challenge minted for one ceremony can never be consumed by the other
-- route (a backup-registration challenge submitted to the primary
-- register/verify route, or vice versa, is simply an unknown-purpose
-- challenge to that route's consume() call).
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  challenge     TEXT PRIMARY KEY,
  purpose       TEXT NOT NULL CHECK (purpose IN ('registration', 'login', 'backup_registration', 'backup_login_verification')),
  context       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS webauthn_challenges_expires_at_idx ON webauthn_challenges (expires_at);

-- Batch 2g hand-applied migration: widen the purpose CHECK on a database
-- created before the backup-passkey purposes existed. The live constraint's
-- NAME is not assumed (the original inline CHECK's auto-generated name is
-- unverified against live Neon): every CHECK constraint that references
-- `purpose` is dropped and one known-named replacement added, inside one DO
-- block so the swap is atomic. Idempotent. Pre-live check (read-only):
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'webauthn_challenges'::regclass AND contype = 'c';
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conname FROM pg_constraint con
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
    WHERE con.conrelid = 'webauthn_challenges'::regclass AND con.contype = 'c' AND att.attname = 'purpose'
  LOOP
    EXECUTE format('ALTER TABLE webauthn_challenges DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE webauthn_challenges ADD CONSTRAINT webauthn_challenges_purpose_check
    CHECK (purpose IN ('registration', 'login', 'backup_registration', 'backup_login_verification'));
END $$;

-- The durable onboarding workflow. A row is written the instant a WebAuthn
-- registration is independently verified — BEFORE Turnkey is ever called —
-- so a crash between verification and account activation is always
-- recoverable from this table (see lib/real/server/onboarding.ts).
CREATE TABLE IF NOT EXISTS registration_attempts (
  credential_id             TEXT PRIMARY KEY,
  app_user_id               TEXT NOT NULL UNIQUE,
  user_handle               TEXT NOT NULL,
  credential_public_key     TEXT NOT NULL,
  counter                   BIGINT NOT NULL,
  transports                TEXT[],
  credential_device_type    TEXT,
  credential_backed_up      BOOLEAN,
  -- Public WebAuthn ceremony artifacts (never signing material) — needed to
  -- retry Turnkey provisioning if an earlier attempt's outcome is unknown.
  registration_challenge    TEXT NOT NULL,
  raw_client_data_json      TEXT NOT NULL,
  raw_attestation_object    TEXT NOT NULL,
  state                     TEXT NOT NULL CHECK (state IN ('verified', 'provisioning_in_flight', 'turnkey_created', 'active', 'blocked')),
  -- Tracks the external createSubOrganization call's status independently
  -- of `state`: "unknown" (dispatched, outcome never learned) is the value
  -- that permanently forbids an automatic second create for this attempt —
  -- see lib/real/server/registration-attempts.ts's state-machine doc comment.
  external_outcome          TEXT NOT NULL DEFAULT 'not_attempted' CHECK (external_outcome IN ('not_attempted', 'unknown', 'confirmed_created', 'definitive_failure')),
  external_provisioning_attempted_at TIMESTAMPTZ,
  sub_organization_id       TEXT,
  turnkey_user_id           TEXT,
  wallet_id                 TEXT,
  wallet_account_id         TEXT,
  owner_address             TEXT,
  safe_address              TEXT,
  account_config_version    INT,
  block_reason              TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS registration_attempts_state_idx ON registration_attempts (state);

-- The finalized, active account identity. One row per app identity.
CREATE TABLE IF NOT EXISTS real_accounts (
  app_user_id               TEXT PRIMARY KEY,
  sub_organization_id       TEXT NOT NULL,
  turnkey_user_id           TEXT NOT NULL,
  wallet_id                 TEXT NOT NULL,
  wallet_account_id         TEXT NOT NULL,
  owner_address             TEXT NOT NULL,
  safe_address              TEXT NOT NULL,
  account_config_version    INT NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The finalized, active passkey identity — what login verifies against day
-- to day. credential_id is globally unique; app_user_id is a foreign key
-- to real_accounts (an account may gain additional passkeys — Batch 2g adds
-- a backup beyond the primary Batch 2b always creates).
--
-- status (APP state only — never a statement about Turnkey):
--   'pending'  a backup credential mid-enrollment (backup_passkey_enrollments);
--              cannot log in or sign in-app (auth.ts/login.ts refuse
--              anything but 'active').
--   'active'   usable.
--   'revoking' app login DISABLED, Turnkey removal NOT yet confirmed — the
--              credential MAY STILL authorize at Turnkey (see
--              passkey_revocation_attempts).
--   'revoked'  either a Turnkey-confirmed removal (completed DELETE activity
--              for this exact authenticator AND a subsequent read showing it
--              absent), or an abandoned enrollment that never reached Turnkey.
--
-- role is display/bookkeeping only: primary and backup have EQUAL Turnkey
-- authority once active; role is never an authorization check. A new
-- credential added to an existing account is always 'backup'; when a
-- confirmed removal leaves no non-revoked primary, the oldest active
-- passkey is promoted to 'primary' in that same transaction.
--
-- Revoked rows are never deleted — they are audit history and are referenced
-- by passkey_revocation_attempts. The management list simply hides them.
--
-- display_name: user-chosen label (see the migration below); never identity.
--
-- turnkey_authenticator_id: the Turnkey-side id, required before a passkey
-- can be removed or act as the surviving authorizer of a removal. Set by
-- enrollment confirmation for backups; backfilled for pre-2g primaries by
-- the env-gated admin runner (test/admin/backfill-turnkey-authenticator-ids.admin.test.ts).
CREATE TABLE IF NOT EXISTS real_passkeys (
  credential_id              TEXT PRIMARY KEY,
  app_user_id                TEXT NOT NULL REFERENCES real_accounts (app_user_id),
  credential_public_key      TEXT NOT NULL,
  user_handle                TEXT NOT NULL,
  counter                    BIGINT NOT NULL,
  transports                 TEXT[],
  credential_device_type     TEXT,
  credential_backed_up       BOOLEAN,
  status                     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'revoking', 'revoked')),
  role                       TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary', 'backup')),
  turnkey_authenticator_id   TEXT,
  display_name               TEXT CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 40),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS real_passkeys_app_user_id_idx ON real_passkeys (app_user_id);

-- Batch 2g hand-applied migration for a pre-2g database (no migration
-- framework — schema.sql is applied by hand). Idempotent. The existing
-- status CHECK's NAME is not assumed: every CHECK referencing `status` is
-- dropped and a known-named replacement added atomically, same pattern as
-- webauthn_challenges above. Existing 'active'/'revoked' rows satisfy it.
-- Pre-live check (read-only):
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'real_passkeys'::regclass AND contype = 'c';
ALTER TABLE real_passkeys ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary', 'backup'));
ALTER TABLE real_passkeys ADD COLUMN IF NOT EXISTS turnkey_authenticator_id TEXT;
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conname FROM pg_constraint con
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
    WHERE con.conrelid = 'real_passkeys'::regclass AND con.contype = 'c' AND att.attname = 'status'
  LOOP
    EXECUTE format('ALTER TABLE real_passkeys DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE real_passkeys ADD CONSTRAINT real_passkeys_status_check CHECK (status IN ('pending', 'active', 'revoking', 'revoked'));
END $$;
-- One Turnkey authenticator maps to at most one local passkey — the backfill
-- relies on this to refuse (never overwrite) a conflicting mapping.
CREATE UNIQUE INDEX IF NOT EXISTS real_passkeys_turnkey_authenticator_id_key
  ON real_passkeys (turnkey_authenticator_id) WHERE turnkey_authenticator_id IS NOT NULL;

-- Passkey names hand-applied migration. Presentation metadata ONLY: never
-- unique, never indexed, never used in any lookup or authorization — identity
-- is always credential_id / turnkey_authenticator_id. NULL (every pre-existing
-- row and every new enrollment) means "show the role label". Idempotent.
ALTER TABLE real_passkeys ADD COLUMN IF NOT EXISTS display_name TEXT
  CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 40);

-- Hand-applied one-time repair for removals confirmed BEFORE confirmDeleted
-- promoted survivors: same rule, role column only (never status, identity,
-- or Turnkey mapping). Idempotent — a no-op once every account with an
-- active passkey has a non-revoked primary. Pre-live check (read-only):
--   SELECT credential_id, app_user_id, status, role FROM real_passkeys p
--   WHERE p.status = 'active' AND NOT EXISTS (SELECT 1 FROM real_passkeys q
--     WHERE q.app_user_id = p.app_user_id AND q.role = 'primary' AND q.status <> 'revoked');
UPDATE real_passkeys p SET role = 'primary'
WHERE p.status = 'active' AND p.role = 'backup'
  AND NOT EXISTS (SELECT 1 FROM real_passkeys q WHERE q.app_user_id = p.app_user_id AND q.role = 'primary' AND q.status <> 'revoked')
  AND p.credential_id = (
    SELECT s.credential_id FROM real_passkeys s
    WHERE s.app_user_id = p.app_user_id AND s.status = 'active'
    ORDER BY s.created_at ASC, s.credential_id ASC LIMIT 1
  );

-- Batch 2g: durable enrollment of a second (backup) passkey against the SAME
-- Turnkey user. Same "durable row before the uncertain external call, never
-- blindly repeat an unknown outcome" discipline as registration_attempts.
--
--   started -> credential_registered -> turnkey_enrollment_in_flight
--     -> turnkey_authenticator_created -> login_verified -> active
--   off-ramps: abandoned (only while no Turnkey attempt is outstanding),
--              blocked (ambiguous discovery; manual review)
--
-- turnkey_request_* hold the EXACT child-WebAuthn-stamped createAuthenticators
-- request, written in the same CAS that moves the row into
-- turnkey_enrollment_in_flight (external_outcome 'unknown') BEFORE it is
-- forwarded, so a lost response can only ever lead to a byte-identical
-- replay (while fresh) or read-only reconciliation — never a second create.
-- turnkey_request_stamp is a live, body-bound bearer credential: it is
-- cleared as soon as an activity id is recorded or the replay window closes.
CREATE TABLE IF NOT EXISTS backup_passkey_enrollments (
  id                                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_user_id                       TEXT NOT NULL REFERENCES real_accounts (app_user_id),
  new_credential_id                 TEXT UNIQUE,
  user_handle                       TEXT,
  credential_public_key             TEXT,
  counter                           BIGINT,
  transports                        TEXT[],
  credential_device_type            TEXT,
  credential_backed_up              BOOLEAN,
  registration_challenge            TEXT,
  raw_client_data_json              TEXT,
  raw_attestation_object            TEXT,
  state                             TEXT NOT NULL CHECK (state IN (
                                       'started', 'credential_registered', 'turnkey_enrollment_in_flight',
                                       'turnkey_authenticator_created', 'login_verified', 'active', 'abandoned', 'blocked'
                                     )),
  external_outcome                  TEXT NOT NULL DEFAULT 'not_attempted' CHECK (external_outcome IN ('not_attempted', 'unknown', 'confirmed_created', 'definitive_failure')),
  external_enrollment_attempted_at  TIMESTAMPTZ,
  authorizing_credential_id         TEXT,
  turnkey_request_endpoint          TEXT,
  turnkey_request_body              TEXT,
  turnkey_request_body_sha256       TEXT,
  turnkey_request_timestamp_ms      BIGINT,
  turnkey_request_stamp             TEXT,
  turnkey_activity_id               TEXT,
  turnkey_activity_status           TEXT,
  turnkey_authenticator_id          TEXT,
  turnkey_authenticator_public_key  TEXT,
  signing_proof_challenge           TEXT,
  signing_proof_activity_id         TEXT,
  login_verified_at                 TIMESTAMPTZ,
  signing_verified_at               TIMESTAMPTZ,
  block_reason                      TEXT,
  created_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS backup_passkey_enrollments_app_user_id_idx ON backup_passkey_enrollments (app_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS backup_passkey_enrollments_one_active_per_account
  ON backup_passkey_enrollments (app_user_id)
  WHERE state NOT IN ('active', 'abandoned', 'blocked');

-- Batch 2g: durable removal of one passkey, authorized by a DIFFERENT,
-- surviving credential (always the caller's own session credential).
--
--   authorization_needed -> dispatch_in_flight -> confirmed
--   off-ramps: cancelled (only from authorization_needed, only by the
--              credential that owns it — the target never left 'active'),
--              blocked (after dispatch: every outcome other than a confirmed
--              deletion; manual review, target stays 'revoking').
--
-- ONE-WAY AFTER DISPATCH: the browser holds the valid signed delete and could
-- send the same bytes to Turnkey directly, so no FAILED/REJECTED activity,
-- missing activity id, or positive getUsers read proves the target wasn't
-- deleted. A dispatched target is never automatically restored to 'active'.
--
-- An app cookie alone can only create an 'authorization_needed' row: the
-- target stays 'active'. Only after a fresh WebAuthn stamp by the survivor is
-- verified does ONE transaction (account row locked FOR UPDATE) re-check the
-- survivor, move the attempt to 'dispatch_in_flight' with the exact request,
-- and move the target 'active' -> 'revoking' — committed BEFORE the request
-- is forwarded to Turnkey.
--
-- 'confirmed' requires BOTH a COMPLETED DELETE_AUTHENTICATORS activity whose
-- result names exactly target_turnkey_authenticator_id AND a subsequent
-- read showing that authenticator absent. A discovery miss alone is never a
-- deletion receipt.
CREATE TABLE IF NOT EXISTS passkey_revocation_attempts (
  id                                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_user_id                       TEXT NOT NULL REFERENCES real_accounts (app_user_id),
  target_credential_id              TEXT NOT NULL REFERENCES real_passkeys (credential_id),
  target_turnkey_authenticator_id   TEXT NOT NULL,
  authorizer_credential_id          TEXT NOT NULL REFERENCES real_passkeys (credential_id),
  state                             TEXT NOT NULL CHECK (state IN ('authorization_needed', 'dispatch_in_flight', 'confirmed', 'cancelled', 'blocked')),
  turnkey_request_body              TEXT,
  turnkey_request_body_sha256       TEXT,
  turnkey_request_timestamp_ms      BIGINT,
  turnkey_request_stamp             TEXT,
  external_attempted_at             TIMESTAMPTZ,
  turnkey_activity_id               TEXT,
  turnkey_activity_status           TEXT,
  failure_reason                    TEXT,
  created_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS passkey_revocation_attempts_app_user_id_idx ON passkey_revocation_attempts (app_user_id, created_at DESC);
-- At most one DISPATCHED removal per target. Undispatched authorization_needed
-- rows are harmless (they change nothing) and may coexist.
CREATE UNIQUE INDEX IF NOT EXISTS passkey_revocation_attempts_one_dispatch_per_target
  ON passkey_revocation_attempts (target_credential_id)
  WHERE state = 'dispatch_in_flight';

-- Batch 2d: durable Real Pay attempts. No signing material is ever written
-- here — the UserOperation signature is used only in-process during
-- /api/real/payments/submit and discarded; expected_user_operation_hash is
-- the durable reconciliation key, computed and persisted BEFORE
-- eth_sendUserOperation is ever called (see lib/real/payments/hash.ts), so a
-- lost send response still leaves a way to look the operation up.
--
-- State machine: prepared -> awaiting_authorization -> signed -> submitting
-- -> submitted -> confirmed, with failed/cancelled/unknown as alternates.
-- "submitting" is written BEFORE eth_sendUserOperation is ever dispatched
-- (lib/real/server/payments.ts's resolveSubmitPayment) specifically so a
-- crash between "signature verified" and "dispatch result recorded" leaves
-- a durable row that reconciliation (never a resend) can resolve —
-- resolvePaymentStatus treats "submitting" exactly like "unknown".
CREATE TABLE IF NOT EXISTS payment_attempts (
  id                                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_user_id                          TEXT NOT NULL REFERENCES real_accounts (app_user_id),
  safe_address                         TEXT NOT NULL,
  recipient                            TEXT NOT NULL,
  amount_base_units                    TEXT NOT NULL,
  chain_id                             INT NOT NULL,
  token_address                        TEXT NOT NULL,
  state                                TEXT NOT NULL CHECK (state IN ('prepared', 'awaiting_authorization', 'signed', 'submitting', 'submitted', 'confirmed', 'failed', 'cancelled', 'unknown')),
  nonce                                TEXT,
  call_data                            TEXT,
  factory                              TEXT,
  factory_data                         TEXT,
  call_gas_limit                       TEXT,
  verification_gas_limit               TEXT,
  pre_verification_gas                 TEXT,
  max_fee_per_gas                      TEXT,
  max_priority_fee_per_gas             TEXT,
  paymaster                            TEXT,
  paymaster_data                       TEXT,
  paymaster_verification_gas_limit     TEXT,
  paymaster_post_op_gas_limit          TEXT,
  expected_user_operation_hash         TEXT,
  transaction_hash                     TEXT,
  failure_reason                       TEXT,
  created_at                           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_attempts_app_user_created_idx ON payment_attempts (app_user_id, created_at DESC);

-- At most one non-terminal attempt per account, enforced by Postgres itself
-- (not application code) — see lib/real/server/neon-store.ts's reserve().
CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_one_active_per_account
  ON payment_attempts (app_user_id)
  WHERE state NOT IN ('confirmed', 'failed', 'cancelled');
