-- Real Mode durable schema (Neon Postgres). One database, four tables.
-- No private keys, no Turnkey signing/session credentials, no WebAuthn
-- private material — only public account/credential identifiers and
-- public attestation objects (needed to retry Turnkey provisioning after
-- an uncertain external-call outcome; these are public ceremony artifacts,
-- not secrets).

-- Short-lived, one-time, purpose-bound WebAuthn challenges.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  challenge     TEXT PRIMARY KEY,
  purpose       TEXT NOT NULL CHECK (purpose IN ('registration', 'login')),
  context       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS webauthn_challenges_expires_at_idx ON webauthn_challenges (expires_at);

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
-- to real_accounts (an account may later gain additional passkeys, though
-- Batch 2b only ever creates one).
CREATE TABLE IF NOT EXISTS real_passkeys (
  credential_id              TEXT PRIMARY KEY,
  app_user_id                TEXT NOT NULL REFERENCES real_accounts (app_user_id),
  credential_public_key      TEXT NOT NULL,
  user_handle                TEXT NOT NULL,
  counter                    BIGINT NOT NULL,
  transports                 TEXT[],
  credential_device_type     TEXT,
  credential_backed_up       BOOLEAN,
  status                     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS real_passkeys_app_user_id_idx ON real_passkeys (app_user_id);
