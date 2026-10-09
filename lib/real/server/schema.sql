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
-- challenge to that route's consume() call). 'backup_step_up' (2g-H) is the
-- fresh assertion by the CURRENT SESSION CREDENTIAL that must precede every
-- backup registration challenge — an app cookie alone never mints one.
-- 'handle_claim' is the fresh assertion by the current session credential that
-- must precede a permanent @handle claim; its context binds the account, that
-- credential, and the exact handle. Never interchangeable with backup_step_up.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  challenge     TEXT PRIMARY KEY,
  purpose       TEXT NOT NULL CHECK (purpose IN ('registration', 'login', 'backup_registration', 'backup_login_verification', 'backup_step_up', 'handle_claim')),
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
    CHECK (purpose IN ('registration', 'login', 'backup_registration', 'backup_login_verification', 'backup_step_up', 'handle_claim'));
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
  -- S4: account-wide session generation — see the S4 migration at the end.
  session_epoch             BIGINT NOT NULL DEFAULT 0,
  -- Account display name — see the migration after S4's. Never identity.
  display_name              TEXT CONSTRAINT real_accounts_display_name_check CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 40),
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
--   off-ramps:
--     abandoned            terminal; only while NOTHING was ever dispatched to
--                          Turnkey (after a dispatch the browser still holds
--                          the signed create and could send it itself, so no
--                          server-observed failure proves absence — review)
--     blocked              NOT terminal (2g-H): the create may have reached
--                          Turnkey but the outcome is ambiguous — "setup needs
--                          review". Holds the slot; read-only discovery that
--                          finds exactly one byte-matching authenticator moves
--                          it to turnkey_authenticator_created (then removable)
--     removal_in_progress  NOT terminal (2g-H): another active passkey
--                          dispatched the delete of this pending-but-live
--                          credential. Activation impossible; slot held until
--                          the delete is confirmed; a blocked removal is retryable
--     removed              terminal (2g-H): the delete is confirmed (completed
--                          activity naming the authenticator + absence read)
--
-- AUTHORITY INVARIANT: an enrollment whose credential MAY hold Turnkey
-- authority never frees the one-open-enrollment slot (only active / abandoned /
-- removed do), so the account can't pile up replacement backups around it.
--
-- turnkey_request_* hold the EXACT child-WebAuthn-stamped createAuthenticators
-- request, written in the same CAS that moves the row into
-- turnkey_enrollment_in_flight (external_outcome 'unknown') BEFORE it is
-- forwarded, so a lost response can only ever lead to a byte-identical
-- replay (while fresh) or read-only reconciliation — never a second create.
-- turnkey_request_stamp is a live, body-bound bearer credential: it is
-- cleared as soon as an activity id is recorded or the replay window closes.
--
-- registration_step_up_credential_id (2g-H): the session credential whose
-- fresh assertion authorized minting the registration challenge the new
-- credential answered. NULL means the credential was attached without that
-- step-up (only possible before 2g-H) — such an enrollment is never offered
-- for Turnkey authorization; it can only be abandoned.
--
-- registration_mint_id (2g-H): the newest registration challenge minted for a
-- 'started' enrollment; a challenge from an earlier (superseded) mint never
-- attaches a credential.
--
-- turnkey_request_replayed (2g-H): claimed by CAS (false -> true, no activity
-- id yet) BEFORE reconciliation forwards the ONE byte-identical replay it may
-- ever send, so concurrent reconciles forward at most one. external_outcome
-- 'definitive_failure' is legacy only: 2g-H never writes it, and treats such a
-- row as uncertain authority (moved into review; never abandonable/retryable).
--
-- A pending credential that already has a Turnkey authenticator
-- (turnkey_authenticator_created / login_verified) may be removed by another
-- active passkey (passkey_revocation_attempts): the dispatch transaction
-- moves this enrollment to 'removal_in_progress' together with the passkey
-- leaving 'pending' (activation can never resurrect it); only the confirmed
-- deletion moves it to 'removed' and frees the slot.
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
                                       'turnkey_authenticator_created', 'login_verified', 'active', 'abandoned', 'blocked',
                                       'removal_in_progress', 'removed'
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
  registration_step_up_credential_id TEXT,
  registration_mint_id              TEXT,
  turnkey_request_replayed          BOOLEAN NOT NULL DEFAULT false,
  login_verified_at                 TIMESTAMPTZ,
  signing_verified_at               TIMESTAMPTZ,
  block_reason                      TEXT,
  created_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS backup_passkey_enrollments_app_user_id_idx ON backup_passkey_enrollments (app_user_id);

-- 2g-H hand-applied migration. Idempotent. New columns: nullable/defaulted, so
-- every pre-existing row stays valid (and is treated as "no step-up proof",
-- "no current mint", "never replayed").
ALTER TABLE backup_passkey_enrollments ADD COLUMN IF NOT EXISTS registration_step_up_credential_id TEXT;
ALTER TABLE backup_passkey_enrollments ADD COLUMN IF NOT EXISTS registration_mint_id TEXT;
ALTER TABLE backup_passkey_enrollments ADD COLUMN IF NOT EXISTS turnkey_request_replayed BOOLEAN NOT NULL DEFAULT false;
-- Widen the state CHECK (live constraint name not assumed; same atomic
-- discover-drop-add pattern as above). Pre-live check (read-only):
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'backup_passkey_enrollments'::regclass AND contype = 'c';
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conname FROM pg_constraint con
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
    WHERE con.conrelid = 'backup_passkey_enrollments'::regclass AND con.contype = 'c' AND att.attname = 'state'
  LOOP
    EXECUTE format('ALTER TABLE backup_passkey_enrollments DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE backup_passkey_enrollments ADD CONSTRAINT backup_passkey_enrollments_state_check CHECK (state IN (
    'started', 'credential_registered', 'turnkey_enrollment_in_flight',
    'turnkey_authenticator_created', 'login_verified', 'active', 'abandoned', 'blocked',
    'removal_in_progress', 'removed'
  ));
END $$;
-- One OPEN enrollment per account, where 'blocked' and 'removal_in_progress'
-- now count as open (they may hold Turnkey authority). Replaces the Batch 2g
-- index (backup_passkey_enrollments_one_active_per_account), which let
-- 'blocked' free the slot.
--
-- FAIL-SAFE SWAP: ONE DO block = ONE transaction. The table is locked against
-- writes first; if any account already has more than one enrollment that the
-- NEW rule counts as open (e.g. a 'blocked' one plus another), it RAISEs
-- before anything changes — the old index is untouched. The old index is
-- dropped only AFTER the new one was created in this same transaction (a
-- unique-violation while building it also aborts everything). There is never
-- a moment with neither index. Rerunnable: once the new index exists, only the
-- (idempotent) drop of the old one runs. Pre-live check (read-only):
--   SELECT app_user_id, count(*) FROM backup_passkey_enrollments
--   WHERE state NOT IN ('active', 'abandoned', 'removed') GROUP BY app_user_id HAVING count(*) > 1;
-- BEGIN 2g-H one-open-index migration
DO $$
BEGIN
  IF to_regclass('backup_passkey_enrollments_one_open_per_account') IS NULL THEN
    LOCK TABLE backup_passkey_enrollments IN SHARE ROW EXCLUSIVE MODE;
    IF EXISTS (
      SELECT 1 FROM backup_passkey_enrollments
      WHERE state NOT IN ('active', 'abandoned', 'removed')
      GROUP BY app_user_id HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION '2g-H migration refused: an account has more than one open backup enrollment (e.g. blocked + another). Resolve by hand; the existing one-active index was left in place.';
    END IF;
    CREATE UNIQUE INDEX backup_passkey_enrollments_one_open_per_account
      ON backup_passkey_enrollments (app_user_id)
      WHERE state NOT IN ('active', 'abandoned', 'removed');
  END IF;
  DROP INDEX IF EXISTS backup_passkey_enrollments_one_active_per_account;
END $$;
-- END 2g-H one-open-index migration

-- Batch 2g: durable removal of one passkey, authorized by a DIFFERENT,
-- surviving credential (always the caller's own session credential).
--
--   authorization_needed -> dispatch_in_flight -> confirmed
--   off-ramps: cancelled (only from authorization_needed, only by the
--              credential that owns it — the target never left 'active'),
--              blocked (after dispatch: every outcome other than a confirmed
--              deletion; target stays 'revoking').
--   S3: 'blocked' -> 'confirmed' exists ONLY through the operator resolver,
--   with the R2a evidence described at passkey_revocation_resolutions below.
--
-- RETRY (2g-H): a 'revoking' target with a 'blocked' attempt and NO attempt
-- 'dispatch_in_flight' may get a NEW attempt — a fresh survivor stamp over a
-- fresh body, naming the same authenticator id. Old attempts stay as history;
-- nothing is retried automatically and the target never returns to 'active'.
--
-- ONE-WAY AFTER DISPATCH: the browser holds the valid signed delete and could
-- send the same bytes to Turnkey directly, so no FAILED/REJECTED activity,
-- missing activity id, or positive getUsers read proves the target wasn't
-- deleted. A dispatched target is never automatically restored to 'active'.
--
-- Target: an 'active' passkey; (2g-H) a 'pending' backup that already has a
-- Turnkey authenticator (its enrollment is turnkey_authenticator_created or
-- login_verified) — it may already authorize at Turnkey, so it must be
-- removable even if setup never finishes; or (2g-H) a 'revoking' target whose
-- earlier removal blocked (retry). The authorizer is always a different
-- 'active', mapped passkey.
--
-- An app cookie alone can only create an 'authorization_needed' row: the
-- target keeps its status. Only after a fresh WebAuthn stamp by the survivor is
-- verified does ONE transaction (account row locked FOR UPDATE) re-check the
-- survivor, move the attempt to 'dispatch_in_flight' with the exact request,
-- move a pending target's enrollment to 'removal_in_progress', and move the
-- target 'active'/'pending' -> 'revoking' — committed BEFORE the request is
-- forwarded to Turnkey. confirmDeleted (both halves of the evidence) makes the
-- target 'revoked' and that enrollment 'removed' in one transaction.
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

-- Slice S3 hand-applied migration: operator resolution of a BLOCKED removal
-- (lib/real/server/passkey-revocation-resolver.ts; run only through the
-- env-gated admin runner test/admin/resolve-passkey-revocation.admin.test.ts).
-- The one extra exit from 'blocked' — to 'confirmed' — exists ONLY with this
-- evidence (R2a): a COMPLETED DELETE naming exactly the target, bound by
-- fingerprint to a DELETE body THIS app stored for that target, re-read by id,
-- no later activity re-granting the target's authority, and two full absence
-- reads. Absence alone is never enough; an external/dashboard delete with no
-- stored body (R2b) is never accepted. The resolved attempt keeps its own
-- turnkey_activity_id / turnkey_activity_status / failure_reason untouched;
-- the recovery receipt lives ONLY here.
--
-- Append-only by construction: the resolver's commit batch only INSERTs; no
-- code path updates or deletes a row. No request body, stamp, assertion, key,
-- or operator identity is stored — receipt_body_sha256 is a hash only.
--   revocation_attempt_id  UNIQUE: an attempt is resolved at most once (two
--                          racing operator commits can't both succeed).
--   receipt_activity_id    UNIQUE: a receipt names exactly one authenticator
--                          id, which maps to at most one passkey
--                          (real_passkeys_turnkey_authenticator_id_key), and a
--                          resolved target is 'revoked' (never resolvable
--                          again) — so one receipt can truthfully resolve at
--                          most one attempt.
-- Pre-live check (read-only): SELECT to_regclass('passkey_revocation_resolutions');
CREATE TABLE IF NOT EXISTS passkey_revocation_resolutions (
  id                                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  revocation_attempt_id                UUID NOT NULL UNIQUE REFERENCES passkey_revocation_attempts (id),
  app_user_id                          TEXT NOT NULL REFERENCES real_accounts (app_user_id),
  target_credential_id                 TEXT NOT NULL REFERENCES real_passkeys (credential_id),
  target_turnkey_authenticator_id      TEXT NOT NULL,
  original_failure_reason              TEXT,
  receipt_activity_id                  TEXT NOT NULL UNIQUE,
  receipt_source                       TEXT NOT NULL CHECK (receipt_source IN ('own_attempt', 'stored_attempt_body')),
  receipt_body_attempt_id              UUID NOT NULL REFERENCES passkey_revocation_attempts (id),
  receipt_body_sha256                  TEXT NOT NULL CHECK (receipt_body_sha256 ~ '^[0-9a-f]{64}$'),
  receipt_turnkey_created_at           TIMESTAMPTZ NOT NULL,
  activity_log_head_id                 TEXT NOT NULL,
  absence_first_observed_at            TIMESTAMPTZ NOT NULL,
  absence_last_observed_at             TIMESTAMPTZ NOT NULL,
  observed_survivor_authenticator_ids  TEXT[] NOT NULL,
  resolver_version                     INT NOT NULL,
  created_at                           TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
  valid_until                          BIGINT,
  prepare_block_number                 BIGINT,
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

-- Finite SafeOp expiry hand-applied migration. Idempotent; nullable, so every
-- pre-existing row stays valid (a legacy row without a window is never
-- offered for signing and never dispatched — see server/payments.ts).
--   valid_until           unix seconds the owner signed as the SafeOp's
--                         validUntil (chain block timestamp at prepare + the
--                         window in lib/real/payments/validity.ts). submit
--                         requires the signature to carry EXACTLY this value.
--   prepare_block_number  the block that timestamp came from — the lower
--                         bound of the on-chain UserOperationEvent search.
-- The nonce (key = nonce >> 64, sequence = low 64 bits) is already stored.
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS valid_until BIGINT;
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS prepare_block_number BIGINT;

-- Slice S1 hand-applied migration: Real Pay credential attribution.
-- Idempotent; all nullable, so every pre-existing row stays valid. A row
-- with NULL authorizing_credential_id predates attribution: it is never
-- signed or dispatched (server/payments.ts) and is never back-filled.
--   authorizing_credential_id    the app session credential at prepare —
--                                written once by reserve(), never patched.
--                                Plain FK, no ON DELETE action: passkeys are
--                                revoked by status, never deleted, so a
--                                revoked passkey stays as attribution evidence.
--   turnkey_sign_activity_id     the signRawPayload activity the server read
--                                back from Turnkey and verified before dispatch
--                                (server/payment-authorization.ts). A locator
--                                the client supplied, trusted only after that
--                                read. Written once, never overwritten.
--   authorization_verified_at    when that verification passed.
-- Pre-live check (read-only): SELECT count(*) FROM payment_attempts
--   WHERE turnkey_sign_activity_id IS NOT NULL;  -- expect 0 before first use
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS authorizing_credential_id TEXT REFERENCES real_passkeys (credential_id);
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS turnkey_sign_activity_id TEXT;
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS authorization_verified_at TIMESTAMPTZ;
-- One Turnkey signing activity authorizes at most one payment.
CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_turnkey_sign_activity_id_key
  ON payment_attempts (turnkey_sign_activity_id) WHERE turnkey_sign_activity_id IS NOT NULL;

-- Slice S4 hand-applied migration: account-wide session revocation.
-- Idempotent. Every session token carries the session_epoch it was minted at
-- and is accepted only while it EQUALS this column (lib/real/server/auth.ts).
-- "Sign out everywhere" increments it in one statement, invalidating every
-- session issued for the account; normal login reads it and never changes it.
-- Existing rows start at 0. (Pre-S4 v1 tokens carry no epoch and are refused
-- by version regardless, so every existing session signs in again once.)
-- Pre-live check (read-only):
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'real_accounts' AND column_name = 'session_epoch';  -- expect 0 rows before
ALTER TABLE real_accounts ADD COLUMN IF NOT EXISTS session_epoch BIGINT NOT NULL DEFAULT 0;

-- Account Handles slice, hand-applied migration (part 1 of 2; the handle
-- registry itself is the "Account Handles" block further down). Idempotent;
-- nullable, so every pre-existing row stays valid and NULL means "no display
-- name". This is the ACCOUNT's name, not real_passkeys.display_name.
-- Presentation metadata ONLY: mutable, never unique, never indexed, never used
-- in any lookup or authorization. The CHECK is a structural length guard
-- (code points); the Unicode rules (NFC, no control / format / line-separator
-- characters, never starting with "@") are enforced by
-- lib/real/display/account-name.ts.
--
-- `ADD COLUMN IF NOT EXISTS` only trusts the column's NAME: on a database
-- that already has some `display_name` column this statement does nothing at
-- all. So this statement is NOT what makes the column safe to use — the
-- "Account Handles" block below PROVES the column and its CHECK from the
-- catalog (step 0, before it creates anything) and RAISEs on any other shape.
-- The constraint is named explicitly, so a different pre-existing constraint
-- under that name makes this statement itself fail rather than be renamed
-- around. Nothing here or there ever alters or drops an existing column or
-- constraint into compliance.
ALTER TABLE real_accounts ADD COLUMN IF NOT EXISTS display_name TEXT
  CONSTRAINT real_accounts_display_name_check CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 40);

-- Slice S5 L2 hand-applied migration: one local account per Turnkey
-- identity. No two real_accounts rows may share a sub_organization_id,
-- owner_address, or safe_address, compared case-insensitively (lower(...),
-- the same comparison registration finalize uses). Finalize already blocks a
-- committed conflict; these indexes close the concurrent window, surfacing as
-- a 23505 naming exactly one of these indexes (neon-store.ts's
-- ACCOUNT_IDENTITY_UNIQUE_INDEXES), which finalize also turns into 'blocked'.
--
-- FAIL-SAFE, ONE DO block = ONE transaction, on EVERY run (never skipped
-- because the names already exist):
--   1. lock public.real_accounts against writes (SHARE ROW EXCLUSIVE);
--   2. re-check duplicates per lower(identity) INSIDE the lock — any
--      duplicate RAISEs; nothing is chosen, deleted, or merged;
--   3. CREATE UNIQUE INDEX IF NOT EXISTS for each (a missing one is built);
--   4. validate all three against the catalog, since IF NOT EXISTS trusts the
--      NAME: each must be an index in this schema, on this table, UNIQUE,
--      VALID, READY, immediate, not partial, btree, exactly one key that is
--      an expression, that expression deparsing to exactly lower(<column>)
--      over a pg_catalog.text column, depending on exactly that one column
--      and on NOTHING else, with the default operator class and a
--      deterministic collation. Anything else (a same-named table, a
--      non-unique / partial / raw-column / wrong-column / invalid index, an
--      index using a look-alike lower(), ...) RAISEs and rolls the whole block
--      back. Wrong objects are never dropped or repaired here — that is an
--      operator decision.
-- WHICH lower(): the block first pins search_path to `pg_catalog, pg_temp`
-- for its own transaction (set_config(..., true)), so no caller's
-- search_path can shadow anything it resolves, and it requires
-- pg_catalog.lower(pg_catalog.text) to be a built-in (OID below
-- FirstNormalObjectId, 16384) that unqualified `lower(text)` resolves to.
-- Under that pinned path Postgres deparses an index expression as the
-- unqualified `lower(col)` ONLY if the function it calls is exactly what
-- `lower` resolves to for that argument type — i.e. the built-in (functions
-- are never looked up in pg_temp, and only superusers can add to pg_catalog);
-- a look-alike prints schema-qualified and fails. Independently, built-in
-- (pinned) objects are never recorded in pg_depend while any user-defined
-- function, type, collation, or operator class an index uses is — so the
-- index may depend on nothing but its own table and that one column.
-- Rerunnable: with three correct indexes, steps 1-4 just re-confirm them.
-- The schema is the single `target_schema` constant (the gated migration
-- smoke runs this exact block against a scratch schema).
-- Pre-live check (read-only; each must return 0 rows):
--   SELECT lower(sub_organization_id), count(*) FROM real_accounts GROUP BY 1 HAVING count(*) > 1;
--   SELECT lower(owner_address), count(*) FROM real_accounts GROUP BY 1 HAVING count(*) > 1;
--   SELECT lower(safe_address), count(*) FROM real_accounts GROUP BY 1 HAVING count(*) > 1;
--   SELECT relname, relkind FROM pg_class WHERE relname LIKE 'real_accounts_%_lower_key';  -- none yet
-- BEGIN S5 L2 identity-index migration
DO $$
DECLARE
  -- Declared types are resolved BEFORE the search_path pin below, so each is schema-qualified.
  target_schema CONSTANT pg_catalog.text := 'public';
  identities CONSTANT pg_catalog.text[] := ARRAY[
    ['real_accounts_sub_organization_id_lower_key', 'sub_organization_id'],
    ['real_accounts_owner_address_lower_key', 'owner_address'],
    ['real_accounts_safe_address_lower_key', 'safe_address']
  ];
  tbl pg_catalog.regclass;
  identity pg_catalog.text[];
  duplicate pg_catalog.int4;
  col_attnum pg_catalog.int2;
  col_type pg_catalog.oid;
  lower_fn pg_catalog.regprocedure;
  ix pg_catalog.record;
BEGIN
  -- 0. Trusted name resolution for everything below, for this transaction only.
  PERFORM pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true);
  lower_fn := pg_catalog.to_regprocedure('pg_catalog.lower(pg_catalog.text)');
  IF lower_fn IS NULL OR lower_fn::pg_catalog.oid >= 16384::pg_catalog.oid
    OR pg_catalog.to_regprocedure('lower(text)') IS DISTINCT FROM lower_fn THEN
    RAISE EXCEPTION 'S5 L2 migration refused: lower(text) does not resolve to the built-in pg_catalog.lower(text).';
  END IF;

  tbl := to_regclass(format('%I.real_accounts', target_schema));
  IF tbl IS NULL THEN
    RAISE EXCEPTION 'S5 L2 migration refused: %.real_accounts does not exist.', target_schema;
  END IF;

  -- 1. Always lock first.
  EXECUTE format('LOCK TABLE %s IN SHARE ROW EXCLUSIVE MODE', tbl);

  -- 2. Duplicates, re-checked inside the lock.
  FOREACH identity SLICE 1 IN ARRAY identities LOOP
    duplicate := NULL;
    EXECUTE format('SELECT 1 FROM %s GROUP BY pg_catalog.lower(%I) HAVING count(*) > 1 LIMIT 1', tbl, identity[2]) INTO duplicate;
    IF duplicate IS NOT NULL THEN
      RAISE EXCEPTION 'S5 L2 migration refused: two accounts share a % (case-insensitively). Resolve by hand; nothing was changed.', identity[2];
    END IF;
  END LOOP;

  -- 3. Build what is missing (IF NOT EXISTS trusts the name — step 4 does not).
  FOREACH identity SLICE 1 IN ARRAY identities LOOP
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %s (pg_catalog.lower(%I))', identity[1], tbl, identity[2]);
  END LOOP;

  -- 4. Validate every expected index against the catalog.
  FOREACH identity SLICE 1 IN ARRAY identities LOOP
    col_attnum := NULL;
    col_type := NULL;
    SELECT a.attnum, a.atttypid INTO col_attnum, col_type FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = tbl AND a.attname = identity[2] AND NOT a.attisdropped;
    SELECT c.oid, c.relkind, am.amname, i.indrelid, i.indisunique, i.indisvalid, i.indisready, i.indimmediate,
           i.indisexclusion, i.indpred IS NULL AS not_partial, i.indnatts, i.indnkeyatts, i.indkey[0] AS key0,
           pg_catalog.pg_get_expr(i.indexprs, i.indrelid) AS expr, opc.opcdefault, coll.collisdeterministic,
           (SELECT count(*) FROM pg_catalog.pg_depend d
             WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid
               AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.refobjid = tbl AND d.refobjsubid <> 0) AS column_deps,
           (SELECT count(*) FROM pg_catalog.pg_depend d
             WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid
               AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.refobjid = tbl AND d.refobjsubid = col_attnum) AS intended_column_deps,
           (SELECT count(*) FROM pg_catalog.pg_depend d
             WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid
               AND NOT (d.refclassid = 'pg_catalog.pg_class'::regclass AND d.refobjid = tbl)) AS foreign_deps
      INTO ix
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid
      LEFT JOIN pg_catalog.pg_am am ON am.oid = c.relam
      LEFT JOIN pg_catalog.pg_opclass opc ON opc.oid = i.indclass[0]
      LEFT JOIN pg_catalog.pg_collation coll ON coll.oid = i.indcollation[0]
      WHERE n.nspname = target_schema AND c.relname = identity[1];
    IF ix.oid IS NULL OR col_attnum IS NULL
      OR col_type IS DISTINCT FROM 'pg_catalog.text'::pg_catalog.regtype
      OR ix.relkind IS DISTINCT FROM 'i'
      OR ix.indrelid IS DISTINCT FROM tbl
      OR ix.amname IS DISTINCT FROM 'btree'
      OR ix.indisunique IS NOT TRUE
      OR ix.indisvalid IS NOT TRUE
      OR ix.indisready IS NOT TRUE
      OR ix.indimmediate IS NOT TRUE
      OR ix.indisexclusion IS NOT FALSE
      OR ix.not_partial IS NOT TRUE
      OR ix.indnatts IS DISTINCT FROM 1
      OR ix.indnkeyatts IS DISTINCT FROM 1
      OR ix.key0 IS DISTINCT FROM 0
      OR ix.expr IS DISTINCT FROM format('lower(%I)', identity[2])
      OR ix.column_deps IS DISTINCT FROM 1
      OR ix.intended_column_deps IS DISTINCT FROM 1
      OR ix.foreign_deps IS DISTINCT FROM 0
      OR ix.opcdefault IS NOT TRUE
      OR ix.collisdeterministic IS NOT TRUE
    THEN
      RAISE EXCEPTION 'S5 L2 migration refused: %.% is not exactly UNIQUE (lower(%)) on %. Nothing was changed; review and resolve by hand (never auto-dropped).', target_schema, identity[1], identity[2], tbl;
    END IF;
  END LOOP;
END $$;
-- END S5 L2 identity-index migration

-- BEGIN Account Handles
-- Hand-applied, idempotent, FAIL-CLOSED (part 2 of 2; part 1 is the
-- real_accounts.display_name column above, and the 'handle_claim' challenge
-- purpose at the top of this file). SLICE COMPLETE/CLOSED. PROVEN AND APPLIED:
--   * the migration passed a live smoke on a disposable Neon branch
--     (PostgreSQL 18.6; test/lib/real/handles-migration.smoke.test.ts, first
--     76/76, then re-proven on this exact text at 77/77, 61 live): scratch-
--     schema clean apply, hostile-object refusals, partial-failure recovery,
--     and that branch's `public` with an idempotent rerun;
--   * the runtime/concurrency service behavior over the real adapters passed
--     there (test/lib/real/handles-runtime.smoke.test.ts, 21/21, 17 live);
--   * the migration was APPLIED TO THE REAL NEON DATABASE (PostgreSQL 18.6;
--     first apply and one idempotent rerun passed, the three statements
--     matched the SHA-256 digests proven on the disposable branch, no existing
--     row changed, 43 reserved / 0 claimed at that point);
--   * a real browser/WebAuthn gate against that database then claimed
--     exactly one real handle.
-- See ARCHITECTURE.md's "Human-Readable Account Identity (Handles)" for the
-- SHA-256 of each proven piece. The executed SQL below is that evidence: the
-- comments here may change, the statement may not without a new smoke.
-- Apply it BEFORE deploying the code that uses it. Without it, registration,
-- sign-in, the session check, and backup-passkey setup still work (the handle /
-- display name are best-effort presentation and come back empty), but claiming
-- a handle and saving a display name answer 500.
--
-- STEP 0 — real_accounts.display_name is PROVEN, before anything is created.
-- The column must exist (part 1 adds it) and be exactly the intended shape:
-- an ordinary column of the built-in TEXT type with its default collation,
-- nullable, no default, not generated, not an identity column, not an array —
-- compared against a reference column deparsed by this server. Its CHECK,
-- real_accounts_display_name_check, must be a validated, non-deferrable CHECK
-- on exactly that one column whose definition equals the reference's, and it
-- may depend on nothing but real_accounts (a look-alike char_length in another
-- schema deparses schema-qualified AND records a dependency — refused twice).
-- A missing column, a wrong type, NOT NULL, a default, a generated/identity
-- column, a missing / weakened / differently-bounded / NOT VALID CHECK: each
-- RAISEs. Nothing is altered, dropped, or replaced to make it fit. Other,
-- unrelated columns and CHECKs on real_accounts are not this block's business.
--
-- real_account_handles is the PERMANENT registry of human-readable account
-- names ("@smit"). One row per handle, forever:
--
--   handle   the canonical form, stored WITHOUT "@": lowercase ASCII, 3-20
--            characters of a-z 0-9 _, starting with a letter, no leading,
--            trailing, or consecutive underscores (lib/real/handle.ts is the
--            one application validator; the format CHECK is its twin).
--            COLLATE "C" on the column and inside the CHECK, plus
--            octet_length = char_length (ASCII only), so neither the regex
--            ranges nor uniqueness ever depend on a locale. Because only the
--            canonical lowercase form can be stored, the primary key IS
--            case-insensitive uniqueness.
--   kind     'reserved' — a system name no account may hold (seeded below;
--                         no owner, no claimer), or
--            'claimed'  — an account's handle (owner AND claimer both set).
--   app_user_id               the owning account. UNIQUE: one handle per
--                             account, ever (NULLs — reserved rows — are
--                             distinct).
--   claimed_by_credential_id  the passkey whose fresh assertion authorized
--                             the claim. The composite foreign key proves it
--                             belonged to that same account.
--
-- A handle has NO authentication authority, is never part of a session, and
-- never enters a Turnkey request or the provisioning evidence. It resolves to
-- the account (and so to its Safe) — never to the Turnkey owner address.
--
-- IMMUTABLE AND NEVER RECYCLED: a row trigger refuses every UPDATE and DELETE
-- and a statement trigger refuses TRUNCATE. The application only ever INSERTs
-- (one INSERT ... SELECT from real_passkeys, so the database itself re-checks
-- that the claiming credential is still active and belongs to the account).
-- Both foreign keys are NO ACTION — nothing cascades, nothing is set NULL —
-- so an account or passkey that owns a handle can't be deleted from under it.
--
-- real_passkeys_app_user_credential_key (UNIQUE (app_user_id, credential_id))
-- exists only so that composite foreign key has a key to reference; it adds
-- no new rule (credential_id is already the primary key).
--
-- FAIL-CLOSED, same convention as the Provisioning Evidence Capture block
-- below: ONE DO block = ONE transaction; search_path pinned to
-- `pg_catalog, pg_temp`; whatever is missing is created by name, and then
-- everything is PROVEN from the catalog — the unique key on real_passkeys,
-- the table (ordinary, permanent, no inheritance, no row-level security, no
-- rule, built-in column types and collations), every column and constraint
-- against a reference copy deparsed by this server, both foreign keys
-- (targets, columns, NO ACTION, MATCH SIMPLE, not deferrable, validated), no
-- foreign index, no foreign dependency, the guard function's exact body, and
-- exactly the two guard triggers (and no other user trigger). Any mismatch
-- RAISEs and rolls the whole block back. Nothing is ever dropped, rebuilt, or
-- repaired here.
--
-- Reserved names are seeded with ON CONFLICT (handle) DO NOTHING — a seed
-- never overwrites a row. The seed list is lib/real/handle.ts's
-- RESERVED_HANDLES minus any name the format CHECK itself already makes
-- unclaimable ('me' is two characters; a row for it could not exist). If a name on the list is already CLAIMED by an
-- account (only possible if the list grows later), the block RAISEs: that is
-- an operator decision.
-- Pre-live checks (read-only):
--   SELECT to_regclass('real_account_handles');                          -- NULL before first apply
--   SELECT conname FROM pg_constraint WHERE conrelid = 'real_passkeys'::regclass AND contype = 'u';
DO $$
DECLARE
  -- Declared types are resolved BEFORE the search_path pin below, so each is schema-qualified.
  target_schema CONSTANT pg_catalog.text := 'public';
  table_name CONSTANT pg_catalog.text := 'real_account_handles';
  reference_name CONSTANT pg_catalog.text := 'real_account_handles_reference';
  display_name_reference_name CONSTANT pg_catalog.text := 'real_accounts_display_name_reference';
  display_name_check_name CONSTANT pg_catalog.text := 'real_accounts_display_name_check';
  -- Exactly what part 1's ALTER adds (a test keeps the two texts identical).
  display_name_definition CONSTANT pg_catalog.text :=
    'display_name TEXT CONSTRAINT real_accounts_display_name_check CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 40)';
  passkey_key_name CONSTANT pg_catalog.text := 'real_passkeys_app_user_credential_key';
  account_fk_name CONSTANT pg_catalog.text := 'real_account_handles_app_user_id_fkey';
  claimer_fk_name CONSTANT pg_catalog.text := 'real_account_handles_claimed_by_fkey';
  guard_function_name CONSTANT pg_catalog.text := 'real_account_handles_refuse_change';
  row_guard_name CONSTANT pg_catalog.text := 'real_account_handles_immutable_row';
  truncate_guard_name CONSTANT pg_catalog.text := 'real_account_handles_immutable_truncate';
  guard_function_body CONSTANT pg_catalog.text := $guard$
BEGIN
  RAISE EXCEPTION 'real_account_handles is append-only: a handle is never changed, removed, or recycled.';
END;
$guard$;
  reserved_handles CONSTANT pg_catalog.text[] := ARRAY[
    'admin', 'administrator', 'support', 'help', 'security', 'official', 'staff', 'team',
    'system', 'root', 'moderator', 'api', 'app', 'null', 'undefined', 'anonymous',
    'everyone', 'onchain', 'onchainfinance', 'on_chain_finance', 'cash', 'pay', 'save',
    'invest', 'swap', 'borrow', 'explore', 'home', 'real', 'practice', 'bank', 'turnkey',
    'safe', 'base', 'coinbase', 'circle', 'usdc', 'pimlico', 'wallet', 'account',
    'settings', 'login', 'register'
  ];
  -- Every column and constraint except the two foreign keys, each constraint explicitly named.
  definition CONSTANT pg_catalog.text := $definition$
    handle                    TEXT COLLATE "C" NOT NULL,
    kind                      TEXT NOT NULL,
    app_user_id               TEXT,
    claimed_by_credential_id  TEXT,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT real_account_handles_pkey PRIMARY KEY (handle),
    -- NULLs are distinct, so any number of reserved rows may have no owner.
    CONSTRAINT real_account_handles_app_user_id_key UNIQUE (app_user_id),
    CONSTRAINT real_account_handles_kind_check CHECK (kind IN ('reserved', 'claimed')),
    CONSTRAINT real_account_handles_format_check
      CHECK (octet_length(handle) = char_length(handle)
        AND char_length(handle) BETWEEN 3 AND 20
        AND (handle COLLATE "C") ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'),
    CONSTRAINT real_account_handles_owner_check
      CHECK ((kind = 'reserved' AND app_user_id IS NULL AND claimed_by_credential_id IS NULL)
        OR (kind = 'claimed' AND app_user_id IS NOT NULL AND claimed_by_credential_id IS NOT NULL))
  $definition$;
  ns pg_catalog.oid;
  tbl pg_catalog.oid;
  ref pg_catalog.oid;
  accounts_tbl pg_catalog.oid;
  passkeys_tbl pg_catalog.oid;
  guard_fn pg_catalog.oid;
  accounts_app_user pg_catalog.int2;
  passkeys_app_user pg_catalog.int2;
  passkeys_credential pg_catalog.int2;
  own_app_user pg_catalog.int2;
  own_claimer pg_catalog.int2;
  display_name_ref pg_catalog.oid;
  dn record;
  dn_ref record;
  dn_check record;
  passkey_key record;
  account_fk record;
  claimer_fk record;
  t record;
  r record;
  m record;
  bad pg_catalog.text;
BEGIN
  PERFORM pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true);

  SELECT n.oid INTO ns FROM pg_catalog.pg_namespace n WHERE n.nspname = target_schema;
  IF ns IS NULL THEN
    RAISE EXCEPTION 'Account handles migration refused: schema % does not exist.', target_schema;
  END IF;
  SELECT c.oid INTO accounts_tbl FROM pg_catalog.pg_class c WHERE c.relnamespace = ns AND c.relname = 'real_accounts' AND c.relkind = 'r';
  SELECT c.oid INTO passkeys_tbl FROM pg_catalog.pg_class c WHERE c.relnamespace = ns AND c.relname = 'real_passkeys' AND c.relkind = 'r';
  IF accounts_tbl IS NULL OR passkeys_tbl IS NULL THEN
    RAISE EXCEPTION 'Account handles migration refused: %.real_accounts or %.real_passkeys is not an ordinary table.', target_schema, target_schema;
  END IF;
  SELECT a.attnum INTO accounts_app_user FROM pg_catalog.pg_attribute a WHERE a.attrelid = accounts_tbl AND a.attname = 'app_user_id' AND NOT a.attisdropped;

  -- 0. real_accounts.display_name: proven against a reference column, BEFORE anything below is created.
  EXECUTE format('DROP TABLE IF EXISTS pg_temp.%I', display_name_reference_name);
  EXECUTE format('CREATE TEMPORARY TABLE %I (%s) ON COMMIT DROP', display_name_reference_name, display_name_definition);
  SELECT c.oid INTO display_name_ref FROM pg_catalog.pg_class c WHERE c.relnamespace = pg_catalog.pg_my_temp_schema() AND c.relname = display_name_reference_name;
  SELECT a.attnum, a.atttypid, a.atttypmod, a.attcollation, a.attndims, a.attnotnull, a.atthasdef, a.attidentity, a.attgenerated
    INTO dn_ref FROM pg_catalog.pg_attribute a WHERE a.attrelid = display_name_ref AND a.attname = 'display_name' AND a.attnum > 0 AND NOT a.attisdropped;
  SELECT a.attnum, a.atttypid, a.atttypmod, a.attcollation, a.attndims, a.attnotnull, a.atthasdef, a.attidentity, a.attgenerated
    INTO dn FROM pg_catalog.pg_attribute a WHERE a.attrelid = accounts_tbl AND a.attname = 'display_name' AND a.attnum > 0 AND NOT a.attisdropped;
  IF dn.attnum IS NULL OR dn_ref.attnum IS NULL
    OR dn.atttypid IS DISTINCT FROM 'pg_catalog.text'::pg_catalog.regtype
    OR dn.atttypid IS DISTINCT FROM dn_ref.atttypid
    OR dn.atttypmod IS DISTINCT FROM dn_ref.atttypmod
    OR dn.attcollation IS DISTINCT FROM dn_ref.attcollation
    OR dn.attndims IS DISTINCT FROM dn_ref.attndims
    OR dn.attnotnull IS NOT FALSE
    OR dn.atthasdef IS NOT FALSE
    OR dn.attidentity IS DISTINCT FROM dn_ref.attidentity
    OR dn.attgenerated IS DISTINCT FROM dn_ref.attgenerated
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_attrdef ad WHERE ad.adrelid = accounts_tbl AND ad.adnum = dn.attnum)
  THEN
    RAISE EXCEPTION 'Account handles migration refused: %.real_accounts.display_name is missing or is not exactly a nullable TEXT column with no default (not generated, not identity). Nothing was changed; review and resolve by hand (never altered or dropped).', target_schema;
  END IF;
  SELECT k.oid, k.connoinherit, pg_catalog.pg_get_constraintdef(k.oid) AS def INTO dn_ref
    FROM pg_catalog.pg_constraint k WHERE k.conrelid = display_name_ref AND k.conname = display_name_check_name AND k.contype = 'c';
  SELECT k.oid INTO dn_check FROM pg_catalog.pg_constraint k
    WHERE k.conrelid = accounts_tbl AND k.conname = display_name_check_name AND k.contype = 'c'
      AND k.convalidated AND NOT k.condeferrable AND NOT k.condeferred
      AND k.connoinherit = dn_ref.connoinherit
      AND k.conkey = ARRAY[dn.attnum]::pg_catalog.int2[]
      AND pg_catalog.pg_get_constraintdef(k.oid) = dn_ref.def;
  IF dn_ref.oid IS NULL OR dn_check.oid IS NULL THEN
    RAISE EXCEPTION 'Account handles migration refused: % on %.real_accounts is missing, not validated, or not exactly the intended length CHECK on display_name. Nothing was changed; review and resolve by hand (never altered or dropped).', display_name_check_name, target_schema;
  END IF;
  SELECT pg_catalog.string_agg(DISTINCT d.refclassid::pg_catalog.regclass::pg_catalog.text || ':' || d.refobjid::pg_catalog.text, ', ') INTO bad
    FROM pg_catalog.pg_depend d
    WHERE d.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass AND d.objid = dn_check.oid
      AND NOT (d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.refobjid = accounts_tbl);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Account handles migration refused: % on %.real_accounts depends on an object other than real_accounts (%). Nothing was changed; review and resolve by hand (never altered or dropped).', display_name_check_name, target_schema, bad;
  END IF;
  EXECUTE format('DROP TABLE pg_temp.%I', display_name_reference_name);
  SELECT a.attnum INTO passkeys_app_user FROM pg_catalog.pg_attribute a WHERE a.attrelid = passkeys_tbl AND a.attname = 'app_user_id' AND NOT a.attisdropped;
  SELECT a.attnum INTO passkeys_credential FROM pg_catalog.pg_attribute a WHERE a.attrelid = passkeys_tbl AND a.attname = 'credential_id' AND NOT a.attisdropped;

  -- A. The key the composite foreign key references: created only if no constraint has that name, then proven.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = passkeys_tbl AND k.conname = passkey_key_name) THEN
    EXECUTE format('ALTER TABLE %I.real_passkeys ADD CONSTRAINT %I UNIQUE (app_user_id, credential_id)', target_schema, passkey_key_name);
  END IF;
  SELECT k.oid, k.conindid INTO passkey_key FROM pg_catalog.pg_constraint k
    WHERE k.conrelid = passkeys_tbl AND k.conname = passkey_key_name AND k.contype = 'u' AND k.convalidated AND NOT k.condeferrable
      AND k.conkey = ARRAY[passkeys_app_user, passkeys_credential]::pg_catalog.int2[];
  IF passkey_key.oid IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i WHERE i.indexrelid = passkey_key.conindid AND i.indrelid = passkeys_tbl
      AND i.indisunique AND i.indisvalid AND i.indisready AND i.indimmediate AND NOT i.indisexclusion
      AND i.indnatts = 2 AND i.indnkeyatts = 2 AND i.indkey[0] = passkeys_app_user AND i.indkey[1] = passkeys_credential
      AND i.indexprs IS NULL AND i.indpred IS NULL)
  THEN
    RAISE EXCEPTION 'Account handles migration refused: %.% is not exactly UNIQUE (app_user_id, credential_id) on %.real_passkeys. Nothing was changed; review and resolve by hand (never auto-dropped).', target_schema, passkey_key_name, target_schema;
  END IF;

  -- B. Create what is missing (IF NOT EXISTS trusts the name — everything below does not).
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I.%I (%s, CONSTRAINT %I FOREIGN KEY (app_user_id) REFERENCES %I.real_accounts (app_user_id) ON UPDATE NO ACTION ON DELETE NO ACTION, CONSTRAINT %I FOREIGN KEY (app_user_id, claimed_by_credential_id) REFERENCES %I.real_passkeys (app_user_id, credential_id) ON UPDATE NO ACTION ON DELETE NO ACTION)',
    target_schema, table_name, definition, account_fk_name, target_schema, claimer_fk_name, target_schema);

  -- 1. The relation under that name, BEFORE any further DDL touches it.
  SELECT c.oid, c.relkind, c.relpersistence, c.relispartition, c.relrowsecurity, c.relforcerowsecurity
    INTO t FROM pg_catalog.pg_class c WHERE c.relnamespace = ns AND c.relname = table_name;
  IF t.oid IS NULL OR t.relkind IS DISTINCT FROM 'r' OR t.relpersistence IS DISTINCT FROM 'p' OR t.relispartition IS NOT FALSE THEN
    RAISE EXCEPTION 'Account handles migration refused: %.% is not an ordinary, permanent, non-partition table. Nothing was changed; review and resolve by hand (never auto-dropped).', target_schema, table_name;
  END IF;
  tbl := t.oid;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid = tbl OR i.inhparent = tbl) THEN
    RAISE EXCEPTION 'Account handles migration refused: %.% takes part in table inheritance (as a child or a parent). Nothing was changed; review and resolve by hand (never auto-dropped).', target_schema, table_name;
  END IF;
  IF t.relrowsecurity IS NOT FALSE OR t.relforcerowsecurity IS NOT FALSE OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy pol WHERE pol.polrelid = tbl) THEN
    RAISE EXCEPTION 'Account handles migration refused: %.% has row-level security enabled or forced, or a policy. Nothing was changed; review and resolve by hand (never auto-dropped).', target_schema, table_name;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_trigger g WHERE g.tgrelid = tbl AND NOT g.tgisinternal AND g.tgname NOT IN (row_guard_name, truncate_guard_name))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite w WHERE w.ev_class = tbl)
  THEN
    RAISE EXCEPTION 'Account handles migration refused: %.% has an unexpected user trigger or a rule. Nothing was changed; review and resolve by hand (never auto-dropped).', target_schema, table_name;
  END IF;
  SELECT pg_catalog.string_agg(a.attname::pg_catalog.text, ', ') INTO bad
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type ty ON ty.oid = a.atttypid
    WHERE a.attrelid = tbl AND a.attnum > 0 AND NOT a.attisdropped
      AND (ty.typnamespace IS DISTINCT FROM (SELECT n2.oid FROM pg_catalog.pg_namespace n2 WHERE n2.nspname = 'pg_catalog')
        OR ty.typtype IS DISTINCT FROM 'b' OR ty.oid >= 16384 OR a.attcollation >= 16384);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Account handles migration refused: %.% column(s) % use a type or collation that is not a built-in base type/collation. Nothing was changed; review and resolve by hand (never auto-dropped).', target_schema, table_name, bad;
  END IF;

  -- The reference: the same definition, deparsed by this server, in this transaction.
  EXECUTE format('DROP TABLE IF EXISTS pg_temp.%I', reference_name);
  EXECUTE format('CREATE TEMPORARY TABLE %I (%s) ON COMMIT DROP', reference_name, definition);
  SELECT c.oid INTO ref FROM pg_catalog.pg_class c WHERE c.relnamespace = pg_catalog.pg_my_temp_schema() AND c.relname = reference_name;

  -- (1, continued) Every constraint on the table is validated.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = tbl AND NOT k.convalidated) THEN
    RAISE EXCEPTION 'Account handles migration refused: %.% has a constraint that is not validated.', target_schema, table_name;
  END IF;

  -- 2. Columns: every reference column, exactly (type, collation "C" on handle, NOT NULL, default).
  SELECT pg_catalog.string_agg(rc.attname::pg_catalog.text, ', ') INTO bad
    FROM pg_catalog.pg_attribute rc
    LEFT JOIN pg_catalog.pg_attrdef rd ON rd.adrelid = rc.attrelid AND rd.adnum = rc.attnum
    WHERE rc.attrelid = ref AND rc.attnum > 0 AND NOT rc.attisdropped
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute tc
        LEFT JOIN pg_catalog.pg_attrdef td ON td.adrelid = tc.attrelid AND td.adnum = tc.attnum
        WHERE tc.attrelid = tbl AND tc.attname = rc.attname AND NOT tc.attisdropped AND tc.attnum > 0
          AND tc.atttypid = rc.atttypid AND tc.atttypmod = rc.atttypmod AND tc.attcollation = rc.attcollation
          AND tc.attnotnull = rc.attnotnull AND tc.attidentity = rc.attidentity AND tc.attgenerated = rc.attgenerated
          AND pg_catalog.pg_get_expr(td.adbin, td.adrelid) IS NOT DISTINCT FROM pg_catalog.pg_get_expr(rd.adbin, rd.adrelid));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Account handles migration refused: %.% column(s) % differ from the intended definition. Nothing was changed; review and resolve by hand (never auto-dropped).', target_schema, table_name, bad;
  END IF;

  -- 3. Every reference constraint (NOT NULL is covered by the columns above), by name, structurally.
  FOR r IN
    SELECT k.conname, k.contype, k.condeferrable, k.condeferred, k.connoinherit,
           pg_catalog.pg_get_constraintdef(k.oid) AS def,
           (SELECT pg_catalog.array_agg(a.attname ORDER BY u.ord) FROM pg_catalog.unnest(k.conkey) WITH ORDINALITY u(attnum, ord)
             JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum) AS key_names,
           k.conindid
      FROM pg_catalog.pg_constraint k WHERE k.conrelid = ref AND k.contype IN ('c', 'u', 'p')
  LOOP
    SELECT k.oid, k.conindid INTO m
      FROM pg_catalog.pg_constraint k
      WHERE k.conrelid = tbl AND k.conname = r.conname AND k.contype = r.contype AND k.convalidated
        AND k.condeferrable = r.condeferrable AND k.condeferred = r.condeferred AND k.connoinherit = r.connoinherit
        AND pg_catalog.pg_get_constraintdef(k.oid) = r.def
        AND (SELECT pg_catalog.array_agg(a.attname ORDER BY u.ord) FROM pg_catalog.unnest(k.conkey) WITH ORDINALITY u(attnum, ord)
              JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum) IS NOT DISTINCT FROM r.key_names;
    IF m.oid IS NULL THEN
      RAISE EXCEPTION 'Account handles migration refused: constraint % on %.% is missing or not the intended definition. Nothing was changed; review and resolve by hand (never auto-dropped).', r.conname, target_schema, table_name;
    END IF;
    IF r.contype IN ('u', 'p') AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_index ti, pg_catalog.pg_index ri, pg_catalog.pg_class tic, pg_catalog.pg_class ric
      WHERE ti.indexrelid = m.conindid AND ri.indexrelid = r.conindid AND tic.oid = ti.indexrelid AND ric.oid = ri.indexrelid
        AND ti.indrelid = tbl AND tic.relam = ric.relam
        AND ti.indisunique AND ti.indisunique = ri.indisunique AND ti.indisprimary = ri.indisprimary
        AND ti.indisvalid AND ti.indisready AND ti.indimmediate AND NOT ti.indisexclusion
        AND ti.indnullsnotdistinct = ri.indnullsnotdistinct
        AND ti.indnatts = ri.indnatts AND ti.indnkeyatts = ri.indnkeyatts
        AND ti.indexprs IS NULL AND ti.indpred IS NULL AND ri.indexprs IS NULL AND ri.indpred IS NULL
        AND ti.indclass::pg_catalog.text = ri.indclass::pg_catalog.text
        AND ti.indcollation::pg_catalog.text = ri.indcollation::pg_catalog.text
        AND ti.indoption::pg_catalog.text = ri.indoption::pg_catalog.text)
    THEN
      RAISE EXCEPTION 'Account handles migration refused: the index behind % on %.% is not the intended one.', r.conname, target_schema, table_name;
    END IF;
  END LOOP;

  -- 4. Both foreign keys, structurally: NO ACTION on update and delete, MATCH SIMPLE, not deferrable, validated.
  SELECT a.attnum INTO own_app_user FROM pg_catalog.pg_attribute a WHERE a.attrelid = tbl AND a.attname = 'app_user_id' AND NOT a.attisdropped;
  SELECT a.attnum INTO own_claimer FROM pg_catalog.pg_attribute a WHERE a.attrelid = tbl AND a.attname = 'claimed_by_credential_id' AND NOT a.attisdropped;
  SELECT k.oid, k.conindid INTO account_fk FROM pg_catalog.pg_constraint k
    WHERE k.conrelid = tbl AND k.conname = account_fk_name AND k.contype = 'f' AND k.convalidated AND NOT k.condeferrable
      AND k.confrelid = accounts_tbl AND k.confupdtype = 'a' AND k.confdeltype = 'a' AND k.confmatchtype = 's'
      AND k.conkey = ARRAY[own_app_user]::pg_catalog.int2[] AND k.confkey = ARRAY[accounts_app_user]::pg_catalog.int2[];
  IF account_fk.oid IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i WHERE i.indexrelid = account_fk.conindid AND i.indrelid = accounts_tbl AND i.indisunique AND i.indisvalid
      AND i.indnkeyatts = 1 AND i.indkey[0] = accounts_app_user AND i.indexprs IS NULL AND i.indpred IS NULL)
  THEN
    RAISE EXCEPTION 'Account handles migration refused: % is not exactly app_user_id -> %.real_accounts(app_user_id), NO ACTION. Nothing was changed; review and resolve by hand (never auto-dropped).', account_fk_name, target_schema;
  END IF;
  SELECT k.oid, k.conindid INTO claimer_fk FROM pg_catalog.pg_constraint k
    WHERE k.conrelid = tbl AND k.conname = claimer_fk_name AND k.contype = 'f' AND k.convalidated AND NOT k.condeferrable
      AND k.confrelid = passkeys_tbl AND k.confupdtype = 'a' AND k.confdeltype = 'a' AND k.confmatchtype = 's'
      AND k.conkey = ARRAY[own_app_user, own_claimer]::pg_catalog.int2[]
      AND k.confkey = ARRAY[passkeys_app_user, passkeys_credential]::pg_catalog.int2[];
  IF claimer_fk.oid IS NULL OR claimer_fk.conindid IS DISTINCT FROM passkey_key.conindid THEN
    RAISE EXCEPTION 'Account handles migration refused: % is not exactly (app_user_id, claimed_by_credential_id) -> %.real_passkeys(app_user_id, credential_id), NO ACTION. Nothing was changed; review and resolve by hand (never auto-dropped).', claimer_fk_name, target_schema;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = tbl AND k.contype = 'f' AND k.oid NOT IN (account_fk.oid, claimer_fk.oid)) THEN
    RAISE EXCEPTION 'Account handles migration refused: %.% has an unexpected foreign key. Nothing was changed; review and resolve by hand (never auto-dropped).', target_schema, table_name;
  END IF;

  -- 5. No index on the table but the reference constraints' backing indexes.
  SELECT pg_catalog.string_agg(c.relname::pg_catalog.text, ', ') INTO bad
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = tbl
      AND i.indexrelid NOT IN (
        SELECT k.conindid FROM pg_catalog.pg_constraint k
        WHERE k.conrelid = tbl AND k.contype IN ('u', 'p')
          AND k.conname IN (SELECT rk.conname FROM pg_catalog.pg_constraint rk WHERE rk.conrelid = ref AND rk.contype IN ('u', 'p')));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Account handles migration refused: %.% has unexpected index(es) %. Nothing was changed; review and resolve by hand (never auto-dropped).', target_schema, table_name, bad;
  END IF;

  -- 6. Dependencies: only on this table (and, for each foreign key, on its referenced table and that table's unique index).
  SELECT pg_catalog.string_agg(DISTINCT d.classid::pg_catalog.regclass::pg_catalog.text || ':' || d.objid::pg_catalog.text, ', ') INTO bad
    FROM pg_catalog.pg_depend d
    WHERE ((d.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass AND d.objid IN (SELECT k.oid FROM pg_catalog.pg_constraint k WHERE k.conrelid = tbl))
        OR (d.classid = 'pg_catalog.pg_attrdef'::pg_catalog.regclass AND d.objid IN (SELECT ad.oid FROM pg_catalog.pg_attrdef ad WHERE ad.adrelid = tbl)))
      AND NOT (d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.refobjid = tbl)
      AND NOT (d.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass AND d.objid = account_fk.oid
               AND d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.refobjid IN (accounts_tbl, account_fk.conindid))
      AND NOT (d.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass AND d.objid = claimer_fk.oid
               AND d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.refobjid IN (passkeys_tbl, claimer_fk.conindid));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Account handles migration refused: %.% has a constraint or default depending on an object other than its own columns (%). Nothing was changed; review and resolve by hand (never auto-dropped).', target_schema, table_name, bad;
  END IF;

  -- 7. Immutability: the guard function (created only if missing, then proven byte for byte) ...
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = ns AND p.proname = guard_function_name) THEN
    EXECUTE format('CREATE FUNCTION %I.%I() RETURNS pg_catalog.trigger LANGUAGE plpgsql AS %L', target_schema, guard_function_name, guard_function_body);
  END IF;
  SELECT p.oid INTO guard_fn FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid = p.prolang
    WHERE p.pronamespace = ns AND p.proname = guard_function_name AND p.pronargs = 0 AND p.prokind = 'f'
      AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype AND l.lanname = 'plpgsql'
      AND NOT p.prosecdef AND p.proconfig IS NULL AND p.prosrc = guard_function_body;
  IF guard_fn IS NULL OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = ns AND p.proname = guard_function_name) <> 1 THEN
    RAISE EXCEPTION 'Account handles migration refused: %.%() is not exactly the intended guard function. Nothing was changed; review and resolve by hand (never auto-dropped).', target_schema, guard_function_name;
  END IF;

  -- ... and exactly two triggers using it: BEFORE UPDATE OR DELETE per row, and BEFORE TRUNCATE per statement.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger g WHERE g.tgrelid = tbl AND g.tgname = row_guard_name AND NOT g.tgisinternal) THEN
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION %I.%I()', row_guard_name, target_schema, table_name, target_schema, guard_function_name);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger g WHERE g.tgrelid = tbl AND g.tgname = truncate_guard_name AND NOT g.tgisinternal) THEN
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION %I.%I()', truncate_guard_name, target_schema, table_name, target_schema, guard_function_name);
  END IF;
  -- tgtype bits: ROW 1, BEFORE 2, DELETE 8, UPDATE 16, TRUNCATE 32. 27 = row-level BEFORE UPDATE OR DELETE; 34 = statement-level BEFORE TRUNCATE.
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger g
        WHERE g.tgrelid = tbl AND NOT g.tgisinternal AND g.tgfoid = guard_fn AND g.tgenabled = 'O' AND g.tgqual IS NULL AND g.tgnargs = 0
          AND g.tgattr::pg_catalog.text = ''
          AND ((g.tgname = row_guard_name AND g.tgtype = 27) OR (g.tgname = truncate_guard_name AND g.tgtype = 34))) <> 2
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger g WHERE g.tgrelid = tbl AND NOT g.tgisinternal) <> 2
  THEN
    RAISE EXCEPTION 'Account handles migration refused: %.% does not have exactly the two intended immutability triggers. Nothing was changed; review and resolve by hand (never auto-dropped).', target_schema, table_name;
  END IF;

  -- 8. Reserved names: inserted only where absent — a seed never overwrites a row.
  EXECUTE format('INSERT INTO %I.%I (handle, kind) SELECT h, ''reserved'' FROM pg_catalog.unnest($1) AS h ON CONFLICT (handle) DO NOTHING', target_schema, table_name)
    USING reserved_handles;
  EXECUTE format('SELECT pg_catalog.string_agg(h, '', '') FROM pg_catalog.unnest($1) AS h WHERE NOT EXISTS (SELECT 1 FROM %I.%I x WHERE x.handle = h AND x.kind = ''reserved'')', target_schema, table_name)
    INTO bad USING reserved_handles;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Account handles migration refused: reserved name(s) % are not reserved rows (already claimed?). Nothing was changed; review and resolve by hand.', bad;
  END IF;

  EXECUTE format('DROP TABLE pg_temp.%I', reference_name);
END $$;
-- END Account Handles

-- BEGIN Payment Attempt Recipient Identity
-- Hand-applied, idempotent, FAIL-CLOSED. CLOSED / COMPLETE: it is statically
-- tested (test/lib/real/payment-recipient-identity-schema.test.ts), passed its
-- gated disposable-branch smoke
-- (test/lib/real/payment-recipient-identity-migration.smoke.test.ts) on Neon
-- PostgreSQL 18.6 (64/64, `public` apply and idempotent rerun), passed an
-- independent audit, was applied EXACTLY ONCE to the real Neon database's
-- `public` schema (direct endpoint, no ambiguous outcome), and passed an
-- independent production post-apply audit (no Critical, High, or Medium).
-- Nothing is pending; no further apply is needed. This header is
-- comment-only history: the executed DO block below, through its closing
-- END line, is evidence-bearing and unchanged (SHA-256 in ARCHITECTURE.md).
--
-- WHAT IT ADDS: three nullable columns on payment_attempts, one CHECK, and two
-- foreign keys — so that a LATER slice (Handle Pay Slice B, not built) can
-- record WHO a payment was meant for when it is addressed to an @handle.
-- Nothing reads or writes these columns today: prepare, reserve(), submit,
-- reconcile, history, and every mapper are unchanged, and an existing INSERT
-- that does not name them leaves all three NULL.
--
--   recipient_app_user_id   the recipient ACCOUNT (real_accounts.app_user_id).
--   recipient_handle        the canonical handle the payer addressed
--                           (real_account_handles.handle; COLLATE "C", like
--                           the registry's own column).
--   recipient_display_name  the recipient's display name AS SHOWN at prepare —
--                           a snapshot for receipts, nullable even for a
--                           handle payment, never an identity or lookup input.
--                           Its length is already bounded where it is written
--                           (real_accounts_display_name_check); it gets no
--                           second length CHECK here.
--
-- No default, no backfill, no new index, no trigger. There is no
-- `recipient_kind` column: "paid by handle" IS `recipient_handle IS NOT NULL`,
-- and a second column saying so could only ever disagree with it.
--
-- payment_attempts_recipient_identity_check: a row is either an ADDRESS
-- payment (all three NULL — every existing row, and every address payment
-- from now on) or a HANDLE payment (handle AND account both set; the display
-- name may still be NULL). A handle without an account, an account without a
-- handle, or a display name on its own is refused.
--
-- Both foreign keys are direct, validated, not deferrable, MATCH SIMPLE, and
-- NO ACTION on update and delete — nothing cascades and nothing is set NULL,
-- so a recorded recipient can never silently vanish or be re-pointed:
--   payment_attempts_recipient_app_user_id_fkey  -> real_accounts (app_user_id)
--   payment_attempts_recipient_handle_fkey       -> real_account_handles (handle)
--
-- KNOWN, DELIBERATE GAP — PAIR INTEGRITY IS NOT ENFORCED HERE. The database
-- proves the handle exists and the account exists, NOT that the handle belongs
-- to that account. A composite key would need UNIQUE (handle, app_user_id) on
-- real_account_handles, and that table's block above is closed, evidence-
-- bearing, and proves its exact index set — it is not touched. The registry is
-- immutable and never recycled, so a pair that is right when written stays
-- right. Slice B must therefore derive BOTH values from the database inside
-- the one atomic INSERT (never from the client), and must write the recipient
-- address as lower(a.safe_address): payment_attempts.recipient is normalized
-- lowercase, while real_accounts.safe_address is stored case-preserving.
-- The standing audit query — it must return ZERO rows once handle payments
-- exist (read-only):
--   SELECT p.id
--   FROM payment_attempts p
--   LEFT JOIN real_account_handles h ON h.handle = p.recipient_handle
--   LEFT JOIN real_accounts a ON a.app_user_id = p.recipient_app_user_id
--   WHERE p.recipient_handle IS NOT NULL
--     AND (h.kind IS DISTINCT FROM 'claimed'
--       OR h.app_user_id IS DISTINCT FROM p.recipient_app_user_id
--       OR lower(a.safe_address) IS DISTINCT FROM lower(p.recipient));
--
-- DECIDED FOR SLICE B (recorded here; this migration does not depend on it and
-- no lookup code changes with it): a claimed handle with a valid account/Safe
-- can RECEIVE Cash whether or not it currently has an active passkey —
-- receiving and authenticating are separate concerns. Slice B removes the
-- active-passkey condition from authoritative payment resolution and aligns
-- the advisory lookup with that rule.
--
-- A recipient is always the account's Safe. The Turnkey signer address is not
-- part of this block in any form.
--
-- WITHOUT THIS MIGRATION, Slice B fails CLOSED: its INSERT names these columns,
-- so the statement is refused outright (undefined column) and no payment is
-- reserved — a handle payment can never be stored with its identity silently
-- dropped.
--
-- FAIL-CLOSED, same convention as the Account Handles block above: ONE DO
-- block = ONE transaction; search_path pinned to `pg_catalog, pg_temp`;
-- payment_attempts, real_accounts, and real_account_handles must each be an
-- ordinary permanent table (so the Handles migration comes first); whatever is
-- missing is created by name, and then everything is PROVEN from the catalog —
-- each column against a reference copy deparsed by this server (built-in TEXT,
-- no type modifier, not an array, the exact collation, nullable, no default,
-- not identity, not generated), the CHECK (validated, enforced, not
-- deferrable, exactly those three columns, the reference's own deparsed
-- definition, depending on nothing but payment_attempts), both foreign keys
-- (target table and column, the unique index behind it, NO ACTION both ways,
-- MATCH SIMPLE, validated, enforced, not deferrable), and that NOTHING else —
-- no index, trigger, view, policy, or second constraint — depends on the three
-- columns. Any mismatch RAISEs and rolls the whole block back, including the
-- columns it had just added. Nothing is ever dropped, altered into compliance,
-- or repaired here, and no row is ever written.
-- Pre-live checks (read-only; historical — the real apply is done). Matching by
-- wildcard is unsafe on PostgreSQL 18, which already names the legacy NOT NULL
-- on `recipient` payment_attempts_recipient_not_null; match the exact names:
--   SELECT attname FROM pg_attribute WHERE attrelid = 'payment_attempts'::regclass AND attname IN ('recipient_app_user_id', 'recipient_handle', 'recipient_display_name') AND NOT attisdropped;  -- none before first apply, three now
--   SELECT conname FROM pg_constraint WHERE conrelid = 'payment_attempts'::regclass AND conname IN ('payment_attempts_recipient_identity_check', 'payment_attempts_recipient_app_user_id_fkey', 'payment_attempts_recipient_handle_fkey');  -- none before first apply, three now
DO $$
DECLARE
  -- Declared types are resolved BEFORE the search_path pin below, so each is schema-qualified.
  target_schema CONSTANT pg_catalog.text := 'public';
  table_name CONSTANT pg_catalog.text := 'payment_attempts';
  reference_name CONSTANT pg_catalog.text := 'payment_attempts_recipient_identity_reference';
  check_name CONSTANT pg_catalog.text := 'payment_attempts_recipient_identity_check';
  account_fk_name CONSTANT pg_catalog.text := 'payment_attempts_recipient_app_user_id_fkey';
  handle_fk_name CONSTANT pg_catalog.text := 'payment_attempts_recipient_handle_fkey';
  -- Exactly the three columns, each "<name> <definition>". The same text adds the column and builds the reference copy.
  column_definitions CONSTANT pg_catalog.text[] := ARRAY[
    'recipient_app_user_id TEXT',
    'recipient_handle TEXT COLLATE "C"',
    'recipient_display_name TEXT'
  ];
  -- The same text adds the CHECK and builds the reference copy.
  check_expression CONSTANT pg_catalog.text :=
    '(recipient_handle IS NULL AND recipient_app_user_id IS NULL AND recipient_display_name IS NULL) OR (recipient_handle IS NOT NULL AND recipient_app_user_id IS NOT NULL)';
  ns pg_catalog.oid;
  tbl pg_catalog.oid;
  ref pg_catalog.oid;
  accounts_tbl pg_catalog.oid;
  handles_tbl pg_catalog.oid;
  c_collation pg_catalog.oid;
  default_collation pg_catalog.oid;
  expected_collation pg_catalog.oid;
  accounts_app_user pg_catalog.int2;
  handles_handle pg_catalog.int2;
  own_app_user pg_catalog.int2;
  own_handle pg_catalog.int2;
  own_display_name pg_catalog.int2;
  column_definition pg_catalog.text;
  col pg_catalog.text;
  tc record;
  rc record;
  ck_ref record;
  ck record;
  account_fk record;
  handle_fk record;
  bad pg_catalog.text;
BEGIN
  PERFORM pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true);

  SELECT n.oid INTO ns FROM pg_catalog.pg_namespace n WHERE n.nspname = target_schema;
  IF ns IS NULL THEN
    RAISE EXCEPTION 'Payment recipient identity migration refused: schema % does not exist.', target_schema;
  END IF;

  -- 1. The three tables, each ordinary, permanent, and not a partition — BEFORE anything is added.
  SELECT c.oid INTO tbl FROM pg_catalog.pg_class c
    WHERE c.relnamespace = ns AND c.relname = table_name AND c.relkind = 'r' AND c.relpersistence = 'p' AND NOT c.relispartition;
  SELECT c.oid INTO accounts_tbl FROM pg_catalog.pg_class c
    WHERE c.relnamespace = ns AND c.relname = 'real_accounts' AND c.relkind = 'r' AND c.relpersistence = 'p' AND NOT c.relispartition;
  SELECT c.oid INTO handles_tbl FROM pg_catalog.pg_class c
    WHERE c.relnamespace = ns AND c.relname = 'real_account_handles' AND c.relkind = 'r' AND c.relpersistence = 'p' AND NOT c.relispartition;
  IF tbl IS NULL OR accounts_tbl IS NULL OR handles_tbl IS NULL THEN
    RAISE EXCEPTION 'Payment recipient identity migration refused: %.payment_attempts, %.real_accounts, or %.real_account_handles is missing or is not an ordinary, permanent, non-partition table (the Account Handles migration comes first). Nothing was changed; review and resolve by hand (never altered or dropped).', target_schema, target_schema, target_schema;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid = tbl OR i.inhparent = tbl) THEN
    RAISE EXCEPTION 'Payment recipient identity migration refused: %.% takes part in table inheritance (as a child or a parent). Nothing was changed; review and resolve by hand (never altered or dropped).', target_schema, table_name;
  END IF;
  SELECT a.attnum INTO accounts_app_user FROM pg_catalog.pg_attribute a WHERE a.attrelid = accounts_tbl AND a.attname = 'app_user_id' AND a.attnum > 0 AND NOT a.attisdropped;
  SELECT a.attnum INTO handles_handle FROM pg_catalog.pg_attribute a WHERE a.attrelid = handles_tbl AND a.attname = 'handle' AND a.attnum > 0 AND NOT a.attisdropped;
  SELECT co.oid INTO c_collation FROM pg_catalog.pg_collation co JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace WHERE cn.nspname = 'pg_catalog' AND co.collname = 'C';
  SELECT co.oid INTO default_collation FROM pg_catalog.pg_collation co JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace WHERE cn.nspname = 'pg_catalog' AND co.collname = 'default';
  IF accounts_app_user IS NULL OR handles_handle IS NULL OR c_collation IS NULL OR default_collation IS NULL THEN
    RAISE EXCEPTION 'Payment recipient identity migration refused: %.real_accounts.app_user_id, %.real_account_handles.handle, or a built-in collation could not be found. Nothing was changed; review and resolve by hand (never altered or dropped).', target_schema, target_schema;
  END IF;

  -- 2. Add what is missing (IF NOT EXISTS trusts the name — everything below does not).
  FOREACH column_definition IN ARRAY column_definitions LOOP
    EXECUTE format('ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS %s', target_schema, table_name, column_definition);
  END LOOP;

  -- The reference: the same column and CHECK text, deparsed by this server, in this transaction.
  EXECUTE format('DROP TABLE IF EXISTS pg_temp.%I', reference_name);
  EXECUTE format('CREATE TEMPORARY TABLE %I (%s, CONSTRAINT %I CHECK (%s)) ON COMMIT DROP', reference_name, pg_catalog.array_to_string(column_definitions, ', '), check_name, check_expression);
  SELECT c.oid INTO ref FROM pg_catalog.pg_class c WHERE c.relnamespace = pg_catalog.pg_my_temp_schema() AND c.relname = reference_name;

  -- 3. Each column, exactly: built-in TEXT, no type modifier, not an array, the intended collation, nullable, no default, not identity, not generated.
  FOREACH column_definition IN ARRAY column_definitions LOOP
    col := pg_catalog.split_part(column_definition, ' ', 1);
    expected_collation := CASE WHEN col = 'recipient_handle' THEN c_collation ELSE default_collation END;
    SELECT a.attnum, a.atttypid, a.atttypmod, a.attcollation, a.attndims, a.attnotnull, a.atthasdef, a.attidentity, a.attgenerated
      INTO rc FROM pg_catalog.pg_attribute a WHERE a.attrelid = ref AND a.attname = col AND a.attnum > 0 AND NOT a.attisdropped;
    SELECT a.attnum, a.atttypid, a.atttypmod, a.attcollation, a.attndims, a.attnotnull, a.atthasdef, a.attidentity, a.attgenerated
      INTO tc FROM pg_catalog.pg_attribute a WHERE a.attrelid = tbl AND a.attname = col AND a.attnum > 0 AND NOT a.attisdropped;
    IF tc.attnum IS NULL OR rc.attnum IS NULL
      OR tc.atttypid IS DISTINCT FROM 'pg_catalog.text'::pg_catalog.regtype
      OR tc.atttypid IS DISTINCT FROM rc.atttypid
      OR tc.atttypmod IS DISTINCT FROM rc.atttypmod
      OR tc.attndims IS DISTINCT FROM rc.attndims
      OR tc.attcollation IS DISTINCT FROM rc.attcollation
      OR tc.attcollation IS DISTINCT FROM expected_collation
      OR tc.attnotnull IS NOT FALSE
      OR tc.atthasdef IS NOT FALSE
      OR tc.attidentity IS DISTINCT FROM rc.attidentity
      OR tc.attgenerated IS DISTINCT FROM rc.attgenerated
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_attrdef ad WHERE ad.adrelid = tbl AND ad.adnum = tc.attnum)
    THEN
      RAISE EXCEPTION 'Payment recipient identity migration refused: %.%.% is missing or is not exactly the intended nullable TEXT column (collation, no default, not generated, not identity, not an array). Nothing was changed; review and resolve by hand (never altered or dropped).', target_schema, table_name, col;
    END IF;
  END LOOP;
  SELECT a.attnum INTO own_app_user FROM pg_catalog.pg_attribute a WHERE a.attrelid = tbl AND a.attname = 'recipient_app_user_id' AND a.attnum > 0 AND NOT a.attisdropped;
  SELECT a.attnum INTO own_handle FROM pg_catalog.pg_attribute a WHERE a.attrelid = tbl AND a.attname = 'recipient_handle' AND a.attnum > 0 AND NOT a.attisdropped;
  SELECT a.attnum INTO own_display_name FROM pg_catalog.pg_attribute a WHERE a.attrelid = tbl AND a.attname = 'recipient_display_name' AND a.attnum > 0 AND NOT a.attisdropped;

  -- 4. The CHECK: created only if no constraint has that name, then proven against the reference's own deparsed definition.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = tbl AND k.conname = check_name) THEN
    EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK (%s)', target_schema, table_name, check_name, check_expression);
  END IF;
  SELECT k.oid, k.connoinherit, pg_catalog.pg_get_constraintdef(k.oid) AS def INTO ck_ref
    FROM pg_catalog.pg_constraint k WHERE k.conrelid = ref AND k.conname = check_name AND k.contype = 'c';
  SELECT k.oid INTO ck FROM pg_catalog.pg_constraint k
    WHERE k.conrelid = tbl AND k.conname = check_name AND k.contype = 'c'
      AND k.convalidated AND NOT k.condeferrable AND NOT k.condeferred
      AND COALESCE((pg_catalog.to_jsonb(k) ->> 'conenforced')::pg_catalog.bool, true)
      AND k.connoinherit = ck_ref.connoinherit
      AND (SELECT pg_catalog.array_agg(u.attnum ORDER BY u.attnum) FROM pg_catalog.unnest(k.conkey) AS u(attnum))
        = (SELECT pg_catalog.array_agg(v.attnum ORDER BY v.attnum) FROM pg_catalog.unnest(ARRAY[own_app_user, own_handle, own_display_name]::pg_catalog.int2[]) AS v(attnum))
      AND pg_catalog.pg_get_constraintdef(k.oid) = ck_ref.def;
  IF ck_ref.oid IS NULL OR ck.oid IS NULL THEN
    RAISE EXCEPTION 'Payment recipient identity migration refused: % on %.% is missing, not validated, not enforced, deferrable, or not exactly the intended CHECK over the three recipient columns. Nothing was changed; review and resolve by hand (never altered or dropped).', check_name, target_schema, table_name;
  END IF;
  SELECT pg_catalog.string_agg(DISTINCT d.refclassid::pg_catalog.regclass::pg_catalog.text || ':' || d.refobjid::pg_catalog.text, ', ') INTO bad
    FROM pg_catalog.pg_depend d
    WHERE d.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass AND d.objid = ck.oid
      AND NOT (d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.refobjid = tbl);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Payment recipient identity migration refused: % on %.% depends on an object other than that table (%). Nothing was changed; review and resolve by hand (never altered or dropped).', check_name, target_schema, table_name, bad;
  END IF;

  -- 5. Both foreign keys: created only if no constraint has that name, then proven structurally —
  --    the target table and column, the unique index behind it, NO ACTION ('a') on update and delete, MATCH SIMPLE ('s'), validated, enforced, not deferrable.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = tbl AND k.conname = account_fk_name) THEN
    EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (recipient_app_user_id) REFERENCES %I.real_accounts (app_user_id) ON UPDATE NO ACTION ON DELETE NO ACTION',
      target_schema, table_name, account_fk_name, target_schema);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = tbl AND k.conname = handle_fk_name) THEN
    EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (recipient_handle) REFERENCES %I.real_account_handles (handle) ON UPDATE NO ACTION ON DELETE NO ACTION',
      target_schema, table_name, handle_fk_name, target_schema);
  END IF;
  SELECT k.oid, k.conindid INTO account_fk FROM pg_catalog.pg_constraint k
    WHERE k.conrelid = tbl AND k.conname = account_fk_name AND k.contype = 'f'
      AND k.convalidated AND NOT k.condeferrable AND NOT k.condeferred
      AND COALESCE((pg_catalog.to_jsonb(k) ->> 'conenforced')::pg_catalog.bool, true)
      AND NOT COALESCE((pg_catalog.to_jsonb(k) ->> 'conperiod')::pg_catalog.bool, false)
      AND k.confrelid = accounts_tbl AND k.confupdtype = 'a' AND k.confdeltype = 'a' AND k.confmatchtype = 's'
      AND k.conkey = ARRAY[own_app_user]::pg_catalog.int2[] AND k.confkey = ARRAY[accounts_app_user]::pg_catalog.int2[];
  IF account_fk.oid IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i WHERE i.indexrelid = account_fk.conindid AND i.indrelid = accounts_tbl
      AND i.indisunique AND i.indisvalid AND i.indisready AND i.indimmediate AND NOT i.indisexclusion
      AND i.indnatts = 1 AND i.indnkeyatts = 1 AND i.indkey[0] = accounts_app_user AND i.indexprs IS NULL AND i.indpred IS NULL)
  THEN
    RAISE EXCEPTION 'Payment recipient identity migration refused: % is not exactly recipient_app_user_id -> %.real_accounts(app_user_id), validated, not deferrable, NO ACTION. Nothing was changed; review and resolve by hand (never altered or dropped).', account_fk_name, target_schema;
  END IF;
  SELECT k.oid, k.conindid INTO handle_fk FROM pg_catalog.pg_constraint k
    WHERE k.conrelid = tbl AND k.conname = handle_fk_name AND k.contype = 'f'
      AND k.convalidated AND NOT k.condeferrable AND NOT k.condeferred
      AND COALESCE((pg_catalog.to_jsonb(k) ->> 'conenforced')::pg_catalog.bool, true)
      AND NOT COALESCE((pg_catalog.to_jsonb(k) ->> 'conperiod')::pg_catalog.bool, false)
      AND k.confrelid = handles_tbl AND k.confupdtype = 'a' AND k.confdeltype = 'a' AND k.confmatchtype = 's'
      AND k.conkey = ARRAY[own_handle]::pg_catalog.int2[] AND k.confkey = ARRAY[handles_handle]::pg_catalog.int2[];
  IF handle_fk.oid IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i WHERE i.indexrelid = handle_fk.conindid AND i.indrelid = handles_tbl
      AND i.indisunique AND i.indisvalid AND i.indisready AND i.indimmediate AND NOT i.indisexclusion
      AND i.indnatts = 1 AND i.indnkeyatts = 1 AND i.indkey[0] = handles_handle AND i.indexprs IS NULL AND i.indpred IS NULL)
  THEN
    RAISE EXCEPTION 'Payment recipient identity migration refused: % is not exactly recipient_handle -> %.real_account_handles(handle), validated, not deferrable, NO ACTION. Nothing was changed; review and resolve by hand (never altered or dropped).', handle_fk_name, target_schema;
  END IF;

  -- 6. Nothing else depends on the three columns: no index, no trigger, no view or rule, no policy, no second CHECK or foreign key.
  SELECT pg_catalog.string_agg(DISTINCT d.classid::pg_catalog.regclass::pg_catalog.text || ':' || d.objid::pg_catalog.text, ', ') INTO bad
    FROM pg_catalog.pg_depend d
    WHERE d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.refobjid = tbl
      AND d.refobjsubid IN (own_app_user, own_handle, own_display_name)
      AND NOT (d.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass AND d.objid IN (ck.oid, account_fk.oid, handle_fk.oid));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Payment recipient identity migration refused: an unexpected object (%) depends on a recipient identity column of %.% (an index, trigger, view, policy, or another constraint). Nothing was changed; review and resolve by hand (never altered or dropped).', bad, target_schema, table_name;
  END IF;

  EXECUTE format('DROP TABLE pg_temp.%I', reference_name);
END $$;
-- END Payment Attempt Recipient Identity

-- BEGIN Provisioning Evidence Capture
-- Hand-applied, idempotent, FAIL-CLOSED. Already applied (and its idempotent
-- rerun proven) on a disposable Neon branch and on the REAL Neon database's
-- public schema — see ARCHITECTURE.md's "Provisioning Evidence Capture" for
-- what was verified. Any OTHER environment must apply it BEFORE deploying the
-- code that uses it: the registration claim is ONE statement with this table's
-- INSERT, so without the table no registration can dispatch (it fails closed;
-- the attempt stays 'verified').
--
-- What was executed live is the single DO block that follows these comments
-- (its text starts at the line that begins with DO and ends at its closing
-- END line; sha256 6931570baead5295…, 20422 characters). Later edits to the
-- comments ABOVE it (like this one) change the BEGIN..END text and its hash
-- but not that statement. Extraction takes the first occurrence of the
-- statement's opening token, so these comments must never spell it out.
--
-- One row per external CREATE_SUB_ORGANIZATION dispatch, inserted in the same
-- statement as the attempt's verified -> provisioning_in_flight claim, BEFORE
-- anything is stamped or sent. Evidence for a future operator-only resolver;
-- nothing reads it back to move an attempt (Option 3 is unchanged).
--
--   immutable at insert   id, credential_id, dispatch_seq, evidence_version,
--                         organization_id, stamp_public_key,
--                         request_timestamp_ms, request_body,
--                         request_body_sha256, created_at.
--                         request_body is the EXACT string that was stamped and
--                         sent; request_body_sha256 is OUR sha256 of its UTF-8
--                         bytes. No UPDATE ever names these columns.
--   write-once            turnkey_activity_id + turnkey_activity_fingerprint +
--                         activity_recorded_at (first writer wins), then the
--                         terminal observation (terminal_status … vote_verdict).
--                         turnkey_activity_fingerprint is Turnkey's own string,
--                         stored verbatim — never our digest.
--   mutable               last_observed_status, last_observed_at, updated_at.
--
-- observed_* are what a COMPLETED activity reported. They are evidence only and
-- are never copied into registration_attempts from here.
--
-- No stamp (X-Stamp), signature, or API key material is ever stored: request_body
-- holds only the public WebAuthn ceremony artifacts and identifiers the attempt
-- row already has.
--
-- FAIL-CLOSED, same convention as the S5 L2 block above: `IF NOT EXISTS` only
-- trusts a NAME, so after creating whatever is missing the block proves, from
-- the catalog, that every named object IS the intended one, and RAISEs
-- (rolling the whole block back — nothing is ever dropped, rebuilt, or
-- repaired) if any is not:
--
--   1. search_path is pinned to `pg_catalog, pg_temp` for the block's own
--      transaction (declared types are schema-qualified because declarations
--      resolve before the pin), so every name the DDL resolves — functions,
--      operators, types — is a built-in. The schema is the single
--      `target_schema` constant (the gated scratch-schema smoke swaps only it).
--   2. IMMEDIATELY after `CREATE TABLE IF NOT EXISTS`, before any other DDL
--      touches it, the relation under that name is checked on its own: an
--      ordinary ('r'), permanent, non-partition table that is neither an
--      inheritance child nor a parent, with row-level security neither
--      enabled nor forced and no policy, no user trigger, no rule, and every
--      column of a built-in base type (pg_catalog, not a domain, enum,
--      composite, or range) with a built-in collation. A view, materialized
--      view, foreign table, or any other same-named relation is refused here.
--   3. A REFERENCE copy of the definition (everything except the foreign key,
--      which a temporary table cannot have) is built in pg_temp in the same
--      transaction. The target must match it structurally — so the expected
--      shape is whatever THIS server deparses for THIS text, never a
--      hand-copied string:
--        - every constraint on the table validated;
--        - every reference column: same type, typmod, collation, NOT NULL,
--          identity/generated, and default (deparsed);
--        - every reference constraint, by name: same kind, flags, key
--          columns, and pg_get_constraintdef; unique/primary-key backing
--          indexes structurally identical (btree, keys, opclasses, collations,
--          options, NULLS [NOT] DISTINCT, no expression, no predicate);
--        - the one-open index: an index ON THIS TABLE, btree, UNIQUE, valid,
--          ready, immediate, not exclusion, exactly (credential_id), no
--          expression, and the same predicate as the reference;
--        - NO other index on the table: only the backing indexes of the
--          reference's own unique/primary-key constraints and the one-open
--          index. (Postgres never adds indexes to a table by itself — a
--          foreign key creates none on the referencing side — so any extra
--          index, expression or predicate index included, is foreign.)
--   4. The foreign key is proven structurally: exactly credential_id ->
--      <target_schema>.registration_attempts(credential_id), through that
--      table's unique index on exactly that column, NO ACTION / MATCH SIMPLE,
--      not deferrable, validated.
--   5. Dependencies: Postgres records none on built-in (pinned) objects, but
--      always records one on a user-defined function, operator, type, or
--      collation. So every constraint, column default, and the one-open index
--      may depend ONLY on this table (and, for the foreign key, on
--      registration_attempts and its unique index); any other dependency is a
--      look-alike and is refused.
--
-- Extra, unrelated columns of a built-in base type are tolerated (they cannot
-- change what this slice writes or reads, and any default or generated
-- expression on them is covered by the dependency rule); a same-named object
-- of the wrong shape never is.
--
-- The body-digest CHECK uses built-ins only (sha256(bytea), encode,
-- convert_to — no extension). convert_to is STABLE, so Neon's acceptance was
-- once an open question; it is now live-verified: Neon accepted and enforced
-- the CHECK in scratch schemas, on a disposable branch's public schema, and on
-- the real database. The application still verifies the digest regardless; if
-- that one constraint ever has to go, nothing else changes.
DO $$
DECLARE
  -- Declared types are resolved BEFORE the search_path pin below, so each is schema-qualified.
  target_schema CONSTANT pg_catalog.text := 'public';
  table_name CONSTANT pg_catalog.text := 'registration_provisioning_dispatches';
  reference_name CONSTANT pg_catalog.text := 'registration_provisioning_dispatches_reference';
  fk_name CONSTANT pg_catalog.text := 'registration_provisioning_dispatches_credential_id_fkey';
  one_open_name CONSTANT pg_catalog.text := 'registration_provisioning_dispatches_one_open_idx';
  one_open_definition CONSTANT pg_catalog.text := '(credential_id) WHERE terminal_status IS NULL';
  -- Every column and constraint except the foreign key, each constraint explicitly named.
  definition CONSTANT pg_catalog.text := $definition$
    id                            UUID NOT NULL DEFAULT gen_random_uuid(),
    credential_id                 TEXT NOT NULL,
    dispatch_seq                  INT NOT NULL,
    evidence_version              INT NOT NULL,
    organization_id               TEXT NOT NULL,
    stamp_public_key              TEXT NOT NULL,
    request_timestamp_ms          BIGINT NOT NULL,
    request_body                  TEXT NOT NULL,
    request_body_sha256           TEXT NOT NULL,
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    turnkey_activity_id           TEXT,
    turnkey_activity_fingerprint  TEXT,
    activity_recorded_at          TIMESTAMPTZ,
    terminal_status               TEXT,
    terminal_observed_at          TIMESTAMPTZ,
    terminal_observed_by          TEXT,
    turnkey_created_at            TIMESTAMPTZ,
    observed_sub_organization_id  TEXT,
    observed_root_user_id         TEXT,
    observed_wallet_id            TEXT,
    observed_owner_address        TEXT,
    failure_code                  INT,
    failure_message               TEXT,
    intent_verdict                TEXT,
    fingerprint_verdict           TEXT,
    vote_verdict                  TEXT,
    last_observed_status          TEXT,
    last_observed_at              TIMESTAMPTZ,
    updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT registration_provisioning_dispatches_pkey PRIMARY KEY (id),
    CONSTRAINT registration_provisioning_dispatches_seq_key UNIQUE (credential_id, dispatch_seq),
    CONSTRAINT registration_provisioning_dispatches_body_sha256_key UNIQUE (request_body_sha256),
    -- NULLs are distinct, so any number of rows may still lack an activity id.
    CONSTRAINT registration_provisioning_dispatches_activity_id_key UNIQUE (turnkey_activity_id),
    CONSTRAINT registration_provisioning_dispatches_dispatch_seq_check CHECK (dispatch_seq >= 1),
    CONSTRAINT registration_provisioning_dispatches_evidence_version_check CHECK (evidence_version >= 1),
    CONSTRAINT registration_provisioning_dispatches_organization_id_check CHECK (organization_id <> ''),
    CONSTRAINT registration_provisioning_dispatches_stamp_public_key_check CHECK (stamp_public_key <> ''),
    CONSTRAINT registration_provisioning_dispatches_request_timestamp_ms_check CHECK (request_timestamp_ms >= 0),
    CONSTRAINT registration_provisioning_dispatches_request_body_check CHECK (request_body <> ''),
    CONSTRAINT registration_provisioning_dispatches_request_body_sha256_check CHECK (request_body_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT registration_provisioning_dispatches_body_digest_check
      CHECK (request_body_sha256 = encode(sha256(convert_to(request_body, 'UTF8')), 'hex')),
    CONSTRAINT registration_provisioning_dispatches_turnkey_activity_id_check CHECK (turnkey_activity_id <> ''),
    CONSTRAINT registration_provisioning_dispatches_fingerprint_length_check CHECK (char_length(turnkey_activity_fingerprint) <= 200),
    CONSTRAINT registration_provisioning_dispatches_terminal_status_check
      CHECK (terminal_status IN ('ACTIVITY_STATUS_COMPLETED', 'ACTIVITY_STATUS_FAILED', 'ACTIVITY_STATUS_REJECTED')),
    CONSTRAINT registration_provisioning_dispatches_terminal_observed_by_check CHECK (terminal_observed_by IN ('dispatch', 'operator_poll')),
    CONSTRAINT registration_provisioning_dispatches_failure_message_check CHECK (char_length(failure_message) <= 500),
    CONSTRAINT registration_provisioning_dispatches_intent_verdict_check CHECK (intent_verdict IN ('exact', 'fields_only', 'mismatch')),
    CONSTRAINT registration_provisioning_dispatches_fingerprint_verdict_check CHECK (fingerprint_verdict IN ('match', 'mismatch', 'unrecognized_form')),
    CONSTRAINT registration_provisioning_dispatches_vote_verdict_check CHECK (vote_verdict IN ('parent_key', 'other')),
    CONSTRAINT registration_provisioning_dispatches_last_observed_status_check CHECK (char_length(last_observed_status) <= 100),
    CONSTRAINT registration_provisioning_dispatches_activity_group_check
      CHECK ((turnkey_activity_id IS NULL) = (activity_recorded_at IS NULL)
        AND (turnkey_activity_fingerprint IS NULL OR turnkey_activity_id IS NOT NULL)),
    CONSTRAINT registration_provisioning_dispatches_terminal_group_check
      CHECK ((terminal_status IS NULL) = (terminal_observed_at IS NULL)
        AND (terminal_status IS NULL) = (terminal_observed_by IS NULL)
        AND (terminal_status IS NULL) = (intent_verdict IS NULL)
        AND (terminal_status IS NULL) = (fingerprint_verdict IS NULL)
        AND (terminal_status IS NULL) = (vote_verdict IS NULL)
        AND (terminal_status IS NOT NULL OR turnkey_created_at IS NULL)),
    CONSTRAINT registration_provisioning_dispatches_terminal_needs_id_check
      CHECK (terminal_status IS NULL OR turnkey_activity_id IS NOT NULL),
    CONSTRAINT registration_provisioning_dispatches_observed_result_check
      CHECK (terminal_status IS NOT DISTINCT FROM 'ACTIVITY_STATUS_COMPLETED'
        OR (observed_sub_organization_id IS NULL AND observed_root_user_id IS NULL
          AND observed_wallet_id IS NULL AND observed_owner_address IS NULL)),
    CONSTRAINT registration_provisioning_dispatches_failure_check
      CHECK ((failure_code IS NULL AND failure_message IS NULL)
        OR (terminal_status IS NOT NULL AND terminal_status IN ('ACTIVITY_STATUS_FAILED', 'ACTIVITY_STATUS_REJECTED')))
  $definition$;
  ns pg_catalog.oid;
  tbl pg_catalog.oid;
  ref pg_catalog.oid;
  attempts_tbl pg_catalog.oid;
  attempts_credential pg_catalog.int2;
  own_credential pg_catalog.int2;
  t record;
  r record;
  fk record;
  ix record;
  bad pg_catalog.text;
BEGIN
  PERFORM pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true);

  SELECT n.oid INTO ns FROM pg_catalog.pg_namespace n WHERE n.nspname = target_schema;
  IF ns IS NULL THEN
    RAISE EXCEPTION 'Provisioning evidence migration refused: schema % does not exist.', target_schema;
  END IF;
  SELECT c.oid INTO attempts_tbl FROM pg_catalog.pg_class c WHERE c.relnamespace = ns AND c.relname = 'registration_attempts' AND c.relkind = 'r';
  IF attempts_tbl IS NULL THEN
    RAISE EXCEPTION 'Provisioning evidence migration refused: %.registration_attempts is not an ordinary table.', target_schema;
  END IF;

  -- Create what is missing (IF NOT EXISTS trusts the name — everything below does not).
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I.%I (%s, CONSTRAINT %I FOREIGN KEY (credential_id) REFERENCES %I.registration_attempts (credential_id))',
    target_schema, table_name, definition, fk_name, target_schema);

  -- 1. The relation under that name, BEFORE any further DDL touches it.
  SELECT c.oid, c.relkind, c.relpersistence, c.relispartition, c.relrowsecurity, c.relforcerowsecurity
    INTO t FROM pg_catalog.pg_class c WHERE c.relnamespace = ns AND c.relname = table_name;
  IF t.oid IS NULL OR t.relkind IS DISTINCT FROM 'r' OR t.relpersistence IS DISTINCT FROM 'p' OR t.relispartition IS NOT FALSE THEN
    RAISE EXCEPTION 'Provisioning evidence migration refused: %.% is not an ordinary, permanent, non-partition table. Nothing was changed; review and resolve by hand (never auto-dropped).', target_schema, table_name;
  END IF;
  tbl := t.oid;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid = tbl OR i.inhparent = tbl) THEN
    RAISE EXCEPTION 'Provisioning evidence migration refused: %.% takes part in table inheritance (as a child or a parent). Nothing was changed; review and resolve by hand (never auto-dropped).', target_schema, table_name;
  END IF;
  IF t.relrowsecurity IS NOT FALSE OR t.relforcerowsecurity IS NOT FALSE OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy pol WHERE pol.polrelid = tbl) THEN
    RAISE EXCEPTION 'Provisioning evidence migration refused: %.% has row-level security enabled or forced, or a policy. Nothing was changed; review and resolve by hand (never auto-dropped).', target_schema, table_name;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_trigger g WHERE g.tgrelid = tbl AND NOT g.tgisinternal)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite w WHERE w.ev_class = tbl)
  THEN
    RAISE EXCEPTION 'Provisioning evidence migration refused: %.% has a user trigger or a rule. Nothing was changed; review and resolve by hand (never auto-dropped).', target_schema, table_name;
  END IF;
  SELECT pg_catalog.string_agg(a.attname::pg_catalog.text, ', ') INTO bad
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type ty ON ty.oid = a.atttypid
    WHERE a.attrelid = tbl AND a.attnum > 0 AND NOT a.attisdropped
      AND (ty.typnamespace IS DISTINCT FROM (SELECT n2.oid FROM pg_catalog.pg_namespace n2 WHERE n2.nspname = 'pg_catalog')
        OR ty.typtype IS DISTINCT FROM 'b' OR ty.oid >= 16384 OR a.attcollation >= 16384);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Provisioning evidence migration refused: %.% column(s) % use a type or collation that is not a built-in base type/collation. Nothing was changed; review and resolve by hand (never auto-dropped).', target_schema, table_name, bad;
  END IF;

  EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I.%I %s', one_open_name, target_schema, table_name, one_open_definition);

  -- The reference: the same definition, deparsed by this server, in this transaction.
  EXECUTE format('DROP TABLE IF EXISTS pg_temp.%I', reference_name);
  EXECUTE format('CREATE TEMPORARY TABLE %I (%s) ON COMMIT DROP', reference_name, definition);
  EXECUTE format('CREATE UNIQUE INDEX %I ON pg_temp.%I %s', reference_name || '_one_open', reference_name, one_open_definition);
  SELECT c.oid INTO ref FROM pg_catalog.pg_class c WHERE c.relnamespace = pg_catalog.pg_my_temp_schema() AND c.relname = reference_name;

  -- (1, continued) Every constraint on the table is validated.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = tbl AND NOT k.convalidated) THEN
    RAISE EXCEPTION 'Provisioning evidence migration refused: %.% has a constraint that is not validated.', target_schema, table_name;
  END IF;

  -- 2. Columns: every reference column, exactly.
  SELECT pg_catalog.string_agg(rc.attname::pg_catalog.text, ', ') INTO bad
    FROM pg_catalog.pg_attribute rc
    LEFT JOIN pg_catalog.pg_attrdef rd ON rd.adrelid = rc.attrelid AND rd.adnum = rc.attnum
    WHERE rc.attrelid = ref AND rc.attnum > 0 AND NOT rc.attisdropped
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute tc
        LEFT JOIN pg_catalog.pg_attrdef td ON td.adrelid = tc.attrelid AND td.adnum = tc.attnum
        WHERE tc.attrelid = tbl AND tc.attname = rc.attname AND NOT tc.attisdropped AND tc.attnum > 0
          AND tc.atttypid = rc.atttypid AND tc.atttypmod = rc.atttypmod AND tc.attcollation = rc.attcollation
          AND tc.attnotnull = rc.attnotnull AND tc.attidentity = rc.attidentity AND tc.attgenerated = rc.attgenerated
          AND pg_catalog.pg_get_expr(td.adbin, td.adrelid) IS NOT DISTINCT FROM pg_catalog.pg_get_expr(rd.adbin, rd.adrelid));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Provisioning evidence migration refused: %.% column(s) % differ from the intended definition. Nothing was changed; review and resolve by hand (never auto-dropped).', target_schema, table_name, bad;
  END IF;

  -- 3. Every reference constraint (NOT NULL is covered by the columns above), by name, structurally.
  FOR r IN
    SELECT k.conname, k.contype, k.condeferrable, k.condeferred, k.connoinherit,
           pg_catalog.pg_get_constraintdef(k.oid) AS def,
           (SELECT pg_catalog.array_agg(a.attname ORDER BY u.ord) FROM pg_catalog.unnest(k.conkey) WITH ORDINALITY u(attnum, ord)
             JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum) AS key_names,
           k.conindid
      FROM pg_catalog.pg_constraint k WHERE k.conrelid = ref AND k.contype IN ('c', 'u', 'p')
  LOOP
    SELECT k.oid, k.conindid INTO fk
      FROM pg_catalog.pg_constraint k
      WHERE k.conrelid = tbl AND k.conname = r.conname AND k.contype = r.contype AND k.convalidated
        AND k.condeferrable = r.condeferrable AND k.condeferred = r.condeferred AND k.connoinherit = r.connoinherit
        AND pg_catalog.pg_get_constraintdef(k.oid) = r.def
        AND (SELECT pg_catalog.array_agg(a.attname ORDER BY u.ord) FROM pg_catalog.unnest(k.conkey) WITH ORDINALITY u(attnum, ord)
              JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum) IS NOT DISTINCT FROM r.key_names;
    IF fk.oid IS NULL THEN
      RAISE EXCEPTION 'Provisioning evidence migration refused: constraint % on %.% is missing or not the intended definition. Nothing was changed; review and resolve by hand (never auto-dropped).', r.conname, target_schema, table_name;
    END IF;
    IF r.contype IN ('u', 'p') AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_index ti, pg_catalog.pg_index ri, pg_catalog.pg_class tic, pg_catalog.pg_class ric
      WHERE ti.indexrelid = fk.conindid AND ri.indexrelid = r.conindid AND tic.oid = ti.indexrelid AND ric.oid = ri.indexrelid
        AND ti.indrelid = tbl AND tic.relam = ric.relam
        AND ti.indisunique AND ti.indisunique = ri.indisunique AND ti.indisprimary = ri.indisprimary
        AND ti.indisvalid AND ti.indisready AND ti.indimmediate AND NOT ti.indisexclusion
        AND ti.indnullsnotdistinct = ri.indnullsnotdistinct
        AND ti.indnatts = ri.indnatts AND ti.indnkeyatts = ri.indnkeyatts
        AND ti.indexprs IS NULL AND ti.indpred IS NULL AND ri.indexprs IS NULL AND ri.indpred IS NULL
        AND ti.indclass::pg_catalog.text = ri.indclass::pg_catalog.text
        AND ti.indcollation::pg_catalog.text = ri.indcollation::pg_catalog.text
        AND ti.indoption::pg_catalog.text = ri.indoption::pg_catalog.text)
    THEN
      RAISE EXCEPTION 'Provisioning evidence migration refused: the index behind % on %.% is not the intended one.', r.conname, target_schema, table_name;
    END IF;
  END LOOP;

  -- 4. The foreign key, structurally.
  SELECT a.attnum INTO own_credential FROM pg_catalog.pg_attribute a WHERE a.attrelid = tbl AND a.attname = 'credential_id' AND NOT a.attisdropped;
  SELECT a.attnum INTO attempts_credential FROM pg_catalog.pg_attribute a WHERE a.attrelid = attempts_tbl AND a.attname = 'credential_id' AND NOT a.attisdropped;
  SELECT k.oid, k.conindid INTO fk FROM pg_catalog.pg_constraint k
    WHERE k.conrelid = tbl AND k.conname = fk_name AND k.contype = 'f' AND k.convalidated AND NOT k.condeferrable
      AND k.confrelid = attempts_tbl AND k.confupdtype = 'a' AND k.confdeltype = 'a' AND k.confmatchtype = 's'
      AND k.conkey = ARRAY[own_credential]::pg_catalog.int2[] AND k.confkey = ARRAY[attempts_credential]::pg_catalog.int2[];
  IF fk.oid IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i WHERE i.indexrelid = fk.conindid AND i.indrelid = attempts_tbl AND i.indisunique AND i.indisvalid
      AND i.indnkeyatts = 1 AND i.indkey[0] = attempts_credential AND i.indexprs IS NULL AND i.indpred IS NULL)
  THEN
    RAISE EXCEPTION 'Provisioning evidence migration refused: % is not exactly credential_id -> %.registration_attempts(credential_id). Nothing was changed; review and resolve by hand (never auto-dropped).', fk_name, target_schema;
  END IF;

  -- 5. The one-open index.
  SELECT c.oid, c.relkind, i.indrelid, c.relam, i.indisunique, i.indisprimary, i.indisvalid, i.indisready, i.indimmediate, i.indisexclusion,
         i.indnatts, i.indnkeyatts, i.indkey[0] AS key0, i.indexprs IS NULL AS no_exprs, i.indnullsnotdistinct,
         i.indclass::pg_catalog.text AS opclasses, i.indcollation::pg_catalog.text AS collations, i.indoption::pg_catalog.text AS options,
         pg_catalog.pg_get_expr(i.indpred, i.indrelid) AS pred
    INTO ix
    FROM pg_catalog.pg_class c LEFT JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid
    WHERE c.relnamespace = ns AND c.relname = one_open_name;
  SELECT c.relam, i.indnullsnotdistinct, i.indclass::pg_catalog.text AS opclasses, i.indcollation::pg_catalog.text AS collations,
         i.indoption::pg_catalog.text AS options, pg_catalog.pg_get_expr(i.indpred, i.indrelid) AS pred
    INTO r
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid
    WHERE c.relnamespace = pg_catalog.pg_my_temp_schema() AND c.relname = reference_name || '_one_open';
  IF ix.oid IS NULL OR ix.relkind IS DISTINCT FROM 'i' OR ix.indrelid IS DISTINCT FROM tbl
    OR ix.relam IS DISTINCT FROM (SELECT am.oid FROM pg_catalog.pg_am am WHERE am.amname = 'btree') OR ix.relam IS DISTINCT FROM r.relam
    OR ix.indisunique IS NOT TRUE OR ix.indisprimary IS NOT FALSE OR ix.indisvalid IS NOT TRUE OR ix.indisready IS NOT TRUE
    OR ix.indimmediate IS NOT TRUE OR ix.indisexclusion IS NOT FALSE
    OR ix.indnatts IS DISTINCT FROM 1 OR ix.indnkeyatts IS DISTINCT FROM 1 OR ix.key0 IS DISTINCT FROM own_credential OR ix.no_exprs IS NOT TRUE
    OR ix.indnullsnotdistinct IS DISTINCT FROM r.indnullsnotdistinct
    OR ix.opclasses IS DISTINCT FROM r.opclasses OR ix.collations IS DISTINCT FROM r.collations OR ix.options IS DISTINCT FROM r.options
    OR ix.pred IS NULL OR ix.pred IS DISTINCT FROM r.pred
  THEN
    RAISE EXCEPTION 'Provisioning evidence migration refused: %.% is not exactly UNIQUE (credential_id) WHERE terminal_status IS NULL on %.%. Nothing was changed; review and resolve by hand (never auto-dropped).', target_schema, one_open_name, target_schema, table_name;
  END IF;

  -- 6. No index on the table but the reference constraints' backing indexes and the one-open index.
  SELECT pg_catalog.string_agg(c.relname::pg_catalog.text, ', ') INTO bad
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = tbl AND i.indexrelid IS DISTINCT FROM ix.oid
      AND i.indexrelid NOT IN (
        SELECT k.conindid FROM pg_catalog.pg_constraint k
        WHERE k.conrelid = tbl AND k.contype IN ('u', 'p')
          AND k.conname IN (SELECT rk.conname FROM pg_catalog.pg_constraint rk WHERE rk.conrelid = ref AND rk.contype IN ('u', 'p')));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Provisioning evidence migration refused: %.% has unexpected index(es) %. Nothing was changed; review and resolve by hand (never auto-dropped).', target_schema, table_name, bad;
  END IF;

  -- 7. Dependencies: only on this table (and, for the foreign key, on registration_attempts and its unique index).
  SELECT pg_catalog.string_agg(DISTINCT d.classid::pg_catalog.regclass::pg_catalog.text || ':' || d.objid::pg_catalog.text, ', ') INTO bad
    FROM pg_catalog.pg_depend d
    WHERE ((d.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass AND d.objid IN (SELECT k.oid FROM pg_catalog.pg_constraint k WHERE k.conrelid = tbl))
        OR (d.classid = 'pg_catalog.pg_attrdef'::pg_catalog.regclass AND d.objid IN (SELECT ad.oid FROM pg_catalog.pg_attrdef ad WHERE ad.adrelid = tbl))
        OR (d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.objid = ix.oid))
      AND NOT (d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.refobjid = tbl)
      AND NOT (d.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass AND d.objid = fk.oid
               AND d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.refobjid IN (attempts_tbl, fk.conindid));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Provisioning evidence migration refused: %.% has a constraint, default, or index depending on an object other than its own columns (%). Nothing was changed; review and resolve by hand (never auto-dropped).', target_schema, table_name, bad;
  END IF;

  EXECUTE format('DROP TABLE pg_temp.%I', reference_name);
END $$;
-- END Provisioning Evidence Capture
