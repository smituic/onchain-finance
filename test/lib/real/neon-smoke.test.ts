import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

/**
 * MANUAL, LIVE-DATABASE SMOKE TEST — never runs in normal `pnpm test` /
 * CI unless DATABASE_URL is set (describe.skipIf below), and never invents
 * or reads a credential from anywhere but that one environment variable.
 * Nothing here is a substitute for the mocked/in-memory reconciliation
 * tests elsewhere in test/lib/real/ (those cover the state-machine logic
 * exhaustively without touching a network) — this file's only job is to
 * prove the Neon adapter's SQL actually works against a real Postgres
 * instance: schema present, transactions commit atomically, unique
 * constraints are enforced, challenge consume is atomic under real
 * concurrent HTTP requests (not just JS's single-threaded run-to-completion
 * semantics), and a full registration state-machine walk finalizes
 * correctly.
 *
 * Run manually, after applying lib/real/server/schema.sql to a Neon
 * database, with:
 *
 *   DATABASE_URL="postgres://..." pnpm test:neon-smoke
 *
 * Every row this test writes is prefixed with a random run id and deleted
 * in afterAll (best-effort, even on failure) — safe to run repeatedly
 * against a shared dev database. Never targets a production database: this
 * is Phase 2 testnet infrastructure, and DATABASE_URL should only ever
 * point at a dev/test Neon project.
 */
describe.skipIf(!process.env.DATABASE_URL)("Neon adapter smoke test (live database)", () => {
  const databaseUrl = process.env.DATABASE_URL;
  const runId = randomUUID().slice(0, 8);
  const credentialId = (suffix: string) => `smoke-${runId}-cred-${suffix}`;
  const appUserId = (suffix: string) => `smoke-${runId}-user-${suffix}`;
  const challenge = (suffix: string) => `smoke-${runId}-challenge-${suffix}`;

  const cleanupCredentialIds = new Set<string>();
  const cleanupAppUserIds = new Set<string>();
  const cleanupChallenges = new Set<string>();

  afterAll(async () => {
    if (!databaseUrl) return;
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(databaseUrl);
    for (const id of cleanupCredentialIds) {
      await sql`DELETE FROM real_passkeys WHERE credential_id = ${id}`;
      await sql`DELETE FROM registration_attempts WHERE credential_id = ${id}`;
    }
    for (const id of cleanupAppUserIds) {
      await sql`DELETE FROM real_accounts WHERE app_user_id = ${id}`;
    }
    for (const value of cleanupChallenges) {
      await sql`DELETE FROM webauthn_challenges WHERE challenge = ${value}`;
    }
  });

  it("schema applies: all four tables exist", async () => {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(databaseUrl!);
    for (const table of ["webauthn_challenges", "registration_attempts", "real_accounts", "real_passkeys"]) {
      const rows = (await sql`SELECT to_regclass(${table}) AS exists`) as { exists: string | null }[];
      expect(rows[0]?.exists, `table "${table}" is missing — apply lib/real/server/schema.sql first`).toBe(table);
    }
  });

  it("challenge create + atomic consume works against the real database, including under real concurrent requests", async () => {
    const { createNeonChallengeStore } = await import("@/lib/real/server/neon-store");
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(databaseUrl!);
    const store = createNeonChallengeStore(sql);
    const value = challenge("consume");
    cleanupChallenges.add(value);

    await store.create({ challenge: value, purpose: "registration", ttlMs: 60_000, context: { note: "smoke test" } });

    const [first, second] = await Promise.all([
      store.consume({ challenge: value, purpose: "registration" }),
      store.consume({ challenge: value, purpose: "registration" }),
    ]);
    const succeeded = [first, second].filter((result) => result !== null);
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]?.context).toEqual({ note: "smoke test" });

    // Never retryable afterward.
    expect(await store.consume({ challenge: value, purpose: "registration" })).toBeNull();
  });

  it("real_accounts + real_passkeys are created together atomically, and the unique credential constraint is enforced", async () => {
    const { createNeonRealAccountRegistry } = await import("@/lib/real/server/neon-store");
    const { DuplicateCredentialError } = await import("@/lib/real/server/registry");
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(databaseUrl!);
    const registry = createNeonRealAccountRegistry(sql);

    const credId = credentialId("account");
    const userId = appUserId("account");
    cleanupCredentialIds.add(credId);
    cleanupAppUserIds.add(userId);

    const created = await registry.createAccountWithPasskey({
      account: {
        appUserId: userId,
        subOrganizationId: "smoke-sub-org",
        turnkeyUserId: "smoke-turnkey-user",
        walletId: "smoke-wallet",
        walletAccountId: "smoke-wallet-account",
        ownerAddress: "0xF6C3FE6DE636f0d8f421d5485D1a64fF3628CFaF",
        safeAddress: "0xd9a4c22fb34dc74317edc8006140d66c8fa03266",
        accountConfigVersion: 1,
      },
      passkey: {
        credentialId: credId,
        appUserId: userId,
        credentialPublicKey: "smoke-public-key",
        userHandle: "smoke-user-handle",
        counter: 0,
        transports: ["internal"],
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
      },
    });
    expect(created.account.appUserId).toBe(userId);
    expect(created.passkey.credentialId).toBe(credId);
    expect(await registry.findAccountByAppUserId(userId)).not.toBeNull();
    expect(await registry.findPasskeyByCredentialId(credId)).not.toBeNull();

    // Same credentialId, different appUserId — must reject, and must not
    // have partially applied (still exactly one account for the original user).
    const otherUserId = appUserId("account-dup");
    cleanupAppUserIds.add(otherUserId);
    await expect(
      registry.createAccountWithPasskey({
        account: {
          appUserId: otherUserId,
          subOrganizationId: "smoke-sub-org-2",
          turnkeyUserId: "smoke-turnkey-user-2",
          walletId: "smoke-wallet-2",
          walletAccountId: "smoke-wallet-account-2",
          ownerAddress: "0x1111111111111111111111111111111111111111",
          safeAddress: "0x2222222222222222222222222222222222222222",
          accountConfigVersion: 1,
        },
        passkey: {
          credentialId: credId,
          appUserId: otherUserId,
          credentialPublicKey: "smoke-public-key-2",
          userHandle: "smoke-user-handle-2",
          counter: 0,
          transports: ["internal"],
          credentialDeviceType: "singleDevice",
          credentialBackedUp: false,
        },
      }),
    ).rejects.toBeInstanceOf(DuplicateCredentialError);
    expect(await registry.findAccountByAppUserId(otherUserId)).toBeNull();
  });

  it("registration_attempts state transitions are CAS-safe and finalize() atomically activates the account", async () => {
    const { createNeonDurableStores } = await import("@/lib/real/server/neon-store");
    const stores = createNeonDurableStores(databaseUrl!);

    const credId = credentialId("attempt");
    const userId = appUserId("attempt");
    cleanupCredentialIds.add(credId);
    cleanupAppUserIds.add(userId);

    const created = await stores.attempts.createVerified({
      credentialId: credId,
      appUserId: userId,
      userHandle: "smoke-user-handle",
      credentialPublicKey: "smoke-public-key",
      counter: 0,
      transports: ["internal"],
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
      registrationChallenge: "smoke-registration-challenge",
      rawClientDataJson: "smoke-client-data",
      rawAttestationObject: "smoke-attestation-object",
    });
    expect(created.state).toBe("verified");
    expect(created.externalOutcome).toBe("not_attempted");

    // A CAS transition from the WRONG state must be rejected (null), never
    // silently applied.
    expect(await stores.attempts.transition({ credentialId: credId, from: "turnkey_created", to: "active" })).toBeNull();

    const inFlight = await stores.attempts.transition({
      credentialId: credId,
      from: "verified",
      to: "provisioning_in_flight",
      patch: { externalOutcome: "unknown", externalProvisioningAttemptedAt: new Date().toISOString() },
    });
    expect(inFlight?.state).toBe("provisioning_in_flight");
    expect(inFlight?.externalOutcome).toBe("unknown");

    const created2 = await stores.attempts.transition({
      credentialId: credId,
      from: "provisioning_in_flight",
      to: "turnkey_created",
      patch: {
        subOrganizationId: "smoke-sub-org",
        turnkeyUserId: "smoke-turnkey-user",
        walletId: "smoke-wallet",
        walletAccountId: "smoke-wallet-account",
        ownerAddress: "0xF6C3FE6DE636f0d8f421d5485D1a64fF3628CFaF",
        externalOutcome: "confirmed_created",
      },
    });
    expect(created2?.state).toBe("turnkey_created");

    const finalized = await stores.attempts.finalize({
      credentialId: credId,
      registry: stores.registry,
      safeAddress: "0xd9a4c22fb34dc74317edc8006140d66c8fa03266",
      accountConfigVersion: 1,
    });
    expect(finalized?.account.appUserId).toBe(userId);
    expect(finalized?.passkey.credentialId).toBe(credId);

    const finalAttempt = await stores.attempts.findByCredentialId(credId);
    expect(finalAttempt?.state).toBe("active");
    expect(await stores.registry.findAccountByAppUserId(userId)).not.toBeNull();
    expect(await stores.registry.findPasskeyByCredentialId(credId)).not.toBeNull();

    // finalize() is itself a CAS: calling it again must not double-create.
    expect(await stores.attempts.finalize({ credentialId: credId, registry: stores.registry, safeAddress: "0x", accountConfigVersion: 1 })).toBeNull();
  });

  it("the database layer never stores signing/private material — a direct row read contains no such fields", async () => {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(databaseUrl!);
    const credId = credentialId("boundary");
    const userId = appUserId("boundary");
    cleanupCredentialIds.add(credId);
    cleanupAppUserIds.add(userId);

    await sql`
      INSERT INTO registration_attempts (
        credential_id, app_user_id, user_handle, credential_public_key, counter,
        registration_challenge, raw_client_data_json, raw_attestation_object, state
      ) VALUES (
        ${credId}, ${userId}, 'smoke-user-handle', 'smoke-public-key', 0,
        'smoke-challenge', 'smoke-client-data', 'smoke-attestation-object', 'verified'
      )
    `;
    const rows = (await sql`SELECT * FROM registration_attempts WHERE credential_id = ${credId}`) as Record<string, unknown>[];
    const row = rows[0]!;
    const serialized = JSON.stringify(row).toLowerCase();
    for (const forbidden of ["privatekey", "private_key", "seedphrase", "seed_phrase", "apiprivatekey", "signingkey", "stamper"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(Object.keys(row)).not.toContain("private_key");
  });
});
