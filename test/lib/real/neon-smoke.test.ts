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
 * correctly. A second describe block below extends this to Batch 2d's
 * payment_attempts atomic reservation/quota logic — same reasoning: the
 * transaction-scoped advisory lock and the partial unique index need to be
 * proven against real Postgres concurrency, not just JS's.
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

/**
 * Batch 2d: the atomic reservation/quota/single-non-terminal-attempt logic
 * is security- and sponsorship-critical, so it is proven here against a
 * real Neon database — not just the in-process concurrency proofs in
 * test/lib/real/payment-attempts-reserve.test.ts (which prove the
 * *contract*, but cannot prove real Postgres actually enforces it under
 * genuine concurrent HTTP requests the way this file's other describe
 * block already does for challenge consumption).
 *
 * Requires `payment_attempts` (Batch 2d's schema.sql addition) to already
 * be applied. Run manually with:
 *
 *   DATABASE_URL="postgres://..." pnpm test:neon-smoke
 */
describe.skipIf(!process.env.DATABASE_URL)("Neon payment_attempts smoke test (live database) — Batch 2d", () => {
  const databaseUrl = process.env.DATABASE_URL;
  const runId = randomUUID().slice(0, 8);
  const appUserId = (suffix: string) => `smoke-pay-${runId}-user-${suffix}`;
  const SAFE_ADDRESS = "0xd9a4c22fb34dc74317edc8006140d66c8fa03266";
  const RECIPIENT = "0x2222222222222222222222222222222222222222";
  const TOKEN_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const CHAIN_ID = 84532;

  const cleanupAppUserIds = new Set<string>();

  afterAll(async () => {
    if (!databaseUrl) return;
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(databaseUrl);
    for (const id of cleanupAppUserIds) {
      await sql`DELETE FROM payment_attempts WHERE app_user_id = ${id}`;
      await sql`DELETE FROM real_accounts WHERE app_user_id = ${id}`;
    }
  });

  async function seedRealAccount(userId: string) {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(databaseUrl!);
    await sql`
      INSERT INTO real_accounts (app_user_id, sub_organization_id, turnkey_user_id, wallet_id, wallet_account_id, owner_address, safe_address, account_config_version)
      VALUES (${userId}, 'smoke-sub-org', 'smoke-turnkey-user', 'smoke-wallet', 'smoke-wallet-account', '0xF6C3FE6DE636f0d8f421d5485D1a64fF3628CFaF', ${SAFE_ADDRESS}, 1)
    `;
  }

  function reserveInput(userId: string) {
    return { appUserId: userId, safeAddress: SAFE_ADDRESS, recipient: RECIPIENT, amountBaseUnits: "1000000", chainId: CHAIN_ID, tokenAddress: TOKEN_ADDRESS };
  }

  it("A: the payment_attempts table exists", async () => {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(databaseUrl!);
    const rows = (await sql`SELECT to_regclass('payment_attempts') AS exists`) as { exists: string | null }[];
    expect(rows[0]?.exists, "table payment_attempts is missing — apply the Batch 2d schema addition first").toBe("payment_attempts");
  });

  it("B/F: several concurrent reserve() calls for the same account — exactly one succeeds under real concurrent HTTP requests, atomically", async () => {
    const { createNeonPaymentAttemptStore } = await import("@/lib/real/server/neon-store");
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(databaseUrl!);
    const store = createNeonPaymentAttemptStore(sql);
    const userId = appUserId("concurrency");
    cleanupAppUserIds.add(userId);
    await seedRealAccount(userId);

    const results = await Promise.all(Array.from({ length: 5 }, () => store.reserve(reserveInput(userId))));
    const succeeded = results.filter((result) => result.ok);
    const inProgress = results.filter((result) => !result.ok && result.reason === "payment_in_progress");
    expect(succeeded).toHaveLength(1);
    expect(inProgress).toHaveLength(4);
  }, 30_000);

  it("C: the partial unique index itself — independent of reserve()'s advisory lock — prevents two active attempts for one account", async () => {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(databaseUrl!);
    const userId = appUserId("unique-index");
    cleanupAppUserIds.add(userId);
    await seedRealAccount(userId);

    // Raw concurrent inserts, deliberately bypassing reserve()'s advisory
    // lock entirely — this proves the UNIQUE INDEX is an independent
    // backstop, not merely a restatement of the lock's own guarantee.
    const insertOne = () => sql`
      INSERT INTO payment_attempts (app_user_id, safe_address, recipient, amount_base_units, chain_id, token_address, state)
      VALUES (${userId}, ${SAFE_ADDRESS}, ${RECIPIENT}, '1000000', ${CHAIN_ID}, ${TOKEN_ADDRESS}, 'prepared')
      RETURNING id
    `;

    const results = await Promise.allSettled([insertOne(), insertOne()]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]!.reason)).toMatch(/payment_attempts_one_active_per_account|duplicate key/i);
  });

  it("D: a cancelled (terminal) attempt frees the slot for a later reservation", async () => {
    const { createNeonPaymentAttemptStore } = await import("@/lib/real/server/neon-store");
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(databaseUrl!);
    const store = createNeonPaymentAttemptStore(sql);
    const userId = appUserId("terminal");
    cleanupAppUserIds.add(userId);
    await seedRealAccount(userId);

    const first = await store.reserve(reserveInput(userId));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const blocked = await store.reserve(reserveInput(userId));
    expect(blocked).toEqual({ ok: false, reason: "payment_in_progress" });

    const cancelled = await store.transition({ id: first.attempt.id, from: "prepared", to: "cancelled" });
    expect(cancelled?.state).toBe("cancelled");

    const second = await store.reserve(reserveInput(userId));
    expect(second.ok).toBe(true);
  });

  it("E: the hourly quota (10/hour) is enforced by the real database, not merely in-process logic", async () => {
    const { createNeonPaymentAttemptStore } = await import("@/lib/real/server/neon-store");
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(databaseUrl!);
    const store = createNeonPaymentAttemptStore(sql);
    const userId = appUserId("quota");
    cleanupAppUserIds.add(userId);
    await seedRealAccount(userId);

    for (let i = 0; i < 10; i += 1) {
      const reserved = await store.reserve(reserveInput(userId));
      expect(reserved.ok).toBe(true);
      if (!reserved.ok) return;
      await store.transition({ id: reserved.attempt.id, from: "prepared", to: "cancelled" });
    }

    const eleventh = await store.reserve(reserveInput(userId));
    expect(eleventh).toEqual({ ok: false, reason: "quota_exceeded" });
  }, 60_000);

  it("G/H: CAS state transitions and expected_user_operation_hash persistence work against the real database", async () => {
    const { createNeonPaymentAttemptStore } = await import("@/lib/real/server/neon-store");
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(databaseUrl!);
    const store = createNeonPaymentAttemptStore(sql);
    const userId = appUserId("cas");
    cleanupAppUserIds.add(userId);
    await seedRealAccount(userId);

    const reserved = await store.reserve(reserveInput(userId));
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;

    // A CAS from the wrong state is rejected (null), never silently applied.
    expect(await store.transition({ id: reserved.attempt.id, from: "signed", to: "submitting" })).toBeNull();

    const awaiting = await store.transition({
      id: reserved.attempt.id,
      from: "prepared",
      to: "awaiting_authorization",
      patch: { expectedUserOperationHash: "0xsmokehash" },
    });
    expect(awaiting?.state).toBe("awaiting_authorization");
    expect(awaiting?.expectedUserOperationHash).toBe("0xsmokehash");

    // Persisted, re-readable — not just returned in the same round trip.
    const reread = await store.findById(reserved.attempt.id);
    expect(reread?.expectedUserOperationHash).toBe("0xsmokehash");

    // A duplicate concurrent CAS out of the same state — only one may win.
    const [a, b] = await Promise.all([
      store.transition({ id: reserved.attempt.id, from: "awaiting_authorization", to: "signed" }),
      store.transition({ id: reserved.attempt.id, from: "awaiting_authorization", to: "signed" }),
    ]);
    expect([a, b].filter((result) => result !== null)).toHaveLength(1);

    const submitting = await store.transition({ id: reserved.attempt.id, from: "signed", to: "submitting" });
    expect(submitting?.state).toBe("submitting");
    const confirmed = await store.transition({ id: reserved.attempt.id, from: "submitting", to: "confirmed", patch: { transactionHash: "0xsmoketx" } });
    expect(confirmed?.state).toBe("confirmed");
    expect(confirmed?.transactionHash).toBe("0xsmoketx");
  });

  it("I: the database row never contains signing/private material — direct read, not just the mapped type", async () => {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(databaseUrl!);
    const userId = appUserId("no-secrets");
    cleanupAppUserIds.add(userId);
    await seedRealAccount(userId);

    const rows = (await sql`
      INSERT INTO payment_attempts (app_user_id, safe_address, recipient, amount_base_units, chain_id, token_address, state, expected_user_operation_hash)
      VALUES (${userId}, ${SAFE_ADDRESS}, ${RECIPIENT}, '1000000', ${CHAIN_ID}, ${TOKEN_ADDRESS}, 'awaiting_authorization', '0xsmokehash')
      RETURNING *
    `) as Record<string, unknown>[];
    const row = rows[0]!;

    expect(Object.keys(row)).not.toContain("signature");
    const serialized = JSON.stringify(row).toLowerCase();
    for (const forbidden of ["signature", "privatekey", "private_key", "seedphrase", "stamper", "signingkey"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
