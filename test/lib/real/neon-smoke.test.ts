import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Deterministic, per-fixture account identity derived from a run-specific
 * app user id: accounts that exist at the same time never share a sub-org,
 * Turnkey user, wallet, owner, or Safe (the planned real_accounts uniqueness
 * indexes would reject that). Ids keep the `smoke` prefix, so residue stays
 * detectable by `LIKE 'smoke%'`; addresses are 20 bytes of sha256(userId:label).
 */
function smokeIdentity(userId: string) {
  const address = (label: string) => `0x${createHash("sha256").update(`${userId}:${label}`).digest("hex").slice(0, 40)}`;
  return {
    subOrganizationId: `${userId}-sub-org`,
    turnkeyUserId: `${userId}-turnkey-user`,
    walletId: `${userId}-wallet`,
    walletAccountId: `${userId}-wallet-account`,
    ownerAddress: address("owner"),
    safeAddress: address("safe"),
  };
}

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
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const sql = createNeonSqlClient(databaseUrl);
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

  it("schema applies: all core tables exist", async () => {
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const sql = createNeonSqlClient(databaseUrl!);
    for (const table of ["webauthn_challenges", "registration_attempts", "real_accounts", "real_passkeys", "backup_passkey_enrollments", "passkey_revocation_attempts"]) {
      const rows = (await sql`SELECT to_regclass(${table}) AS exists`) as { exists: string | null }[];
      expect(rows[0]?.exists, `table "${table}" is missing — apply lib/real/server/schema.sql first`).toBe(table);
    }
  });

  it("challenge create + atomic consume works against the real database, including under real concurrent requests", async () => {
    const { createNeonChallengeStore } = await import("@/lib/real/server/neon-store");
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const sql = createNeonSqlClient(databaseUrl!);
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
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const sql = createNeonSqlClient(databaseUrl!);
    const registry = createNeonRealAccountRegistry(sql);

    const credId = credentialId("account");
    const userId = appUserId("account");
    cleanupCredentialIds.add(credId);
    cleanupAppUserIds.add(userId);

    const created = await registry.createAccountWithPasskey({
      account: {
        appUserId: userId,
        ...smokeIdentity(userId),
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
          ...smokeIdentity(otherUserId),
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
      patch: { ...turnkeyPatch(userId), externalOutcome: "confirmed_created" },
    });
    expect(created2?.state).toBe("turnkey_created");

    const finalized = await stores.attempts.finalize({
      credentialId: credId,
      registry: stores.registry,
      safeAddress: smokeIdentity(userId).safeAddress,
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

  // ---- S5 L3: finalize atomicity against real Postgres ----

  function turnkeyPatch(userId: string) {
    const { subOrganizationId, turnkeyUserId, walletId, walletAccountId, ownerAddress } = smokeIdentity(userId);
    return { subOrganizationId, turnkeyUserId, walletId, walletAccountId, ownerAddress };
  }

  /** A durable attempt walked to turnkey_created through the adapter's own CAS transitions, registered for cleanup. */
  async function seedTurnkeyCreated(suffix: string) {
    const { createNeonDurableStores, createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const stores = createNeonDurableStores(databaseUrl!);
    const sql = createNeonSqlClient(databaseUrl!);
    // Canonical base64url (accountMatchesAttempt compares decoded bytes and
    // fails closed on anything undecodable): "smokeL3A" decodes to exactly 6
    // bytes, so the id keeps that prefix for cleanup/residue detection.
    const credId = Buffer.concat([Buffer.from("smokeL3A", "base64url"), createHash("sha256").update(`${runId}:${suffix}`).digest()]).toString("base64url");
    const userId = appUserId(suffix);
    cleanupCredentialIds.add(credId);
    cleanupAppUserIds.add(userId);
    await stores.attempts.createVerified({
      credentialId: credId,
      appUserId: userId,
      userHandle: `${userId}-handle`,
      credentialPublicKey: `${userId}-cose`,
      counter: 0,
      transports: ["internal"],
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
      registrationChallenge: `${userId}-challenge`,
      rawClientDataJson: "smoke-client-data",
      rawAttestationObject: "smoke-attestation-object",
    });
    await stores.attempts.transition({ credentialId: credId, from: "verified", to: "provisioning_in_flight", patch: { externalOutcome: "unknown" } });
    await stores.attempts.transition({ credentialId: credId, from: "provisioning_in_flight", to: "turnkey_created", patch: { ...turnkeyPatch(userId), externalOutcome: "confirmed_created" } });
    const finalizeInput = { credentialId: credId, registry: stores.registry, safeAddress: smokeIdentity(userId).safeAddress, accountConfigVersion: 1 };
    const counts = async () => {
      const [row] = (await sql`
        SELECT (SELECT count(*) FROM real_accounts WHERE app_user_id = ${userId})::int AS accounts,
               (SELECT count(*) FROM real_passkeys WHERE credential_id = ${credId})::int AS passkeys
      `) as { accounts: number; passkeys: number }[];
      return row!;
    };
    return { stores, sql, credId, userId, finalizeInput, counts };
  }

  it("S5 L3: a LOST CAS writes nothing even when the account/passkey ids are free (attempt moved off turnkey_created with every field still set)", async () => {
    const { stores, credId, finalizeInput, counts } = await seedTurnkeyCreated("l3-lost-cas");
    expect(await stores.attempts.transition({ credentialId: credId, from: "turnkey_created", to: "provisioning_in_flight" })).not.toBeNull();

    expect(await stores.attempts.finalize(finalizeInput)).toBeNull();
    expect(await counts()).toEqual({ accounts: 0, passkeys: 0 });
    expect((await stores.attempts.findByCredentialId(credId))?.state).toBe("provisioning_in_flight");
  });

  it("S5 L3: a blocked attempt finalizes to null with no rows", async () => {
    const { stores, credId, finalizeInput, counts } = await seedTurnkeyCreated("l3-blocked");
    await stores.attempts.transition({ credentialId: credId, from: "turnkey_created", to: "blocked", patch: { blockReason: "smoke review" } });

    expect(await stores.attempts.finalize(finalizeInput)).toBeNull();
    expect(await counts()).toEqual({ accounts: 0, passkeys: 0 });
    expect((await stores.attempts.findByCredentialId(credId))?.state).toBe("blocked");
  });

  it("S5 L3: five concurrent finalizes over real HTTP -> exactly one valid pair; the same-statement account+passkey INSERT satisfies the real FK; a replay reuses nothing and changes nothing", async () => {
    const { accountMatchesAttempt } = await import("@/lib/real/server/registration-attempts");
    const { stores, sql, credId, userId, finalizeInput, counts } = await seedTurnkeyCreated("l3-concurrent");

    const results = await Promise.all(Array.from({ length: 5 }, () => stores.attempts.finalize(finalizeInput)));
    const winners = results.filter((result) => result !== null);
    expect(winners).toHaveLength(1);
    expect(await counts()).toEqual({ accounts: 1, passkeys: 1 });

    const active = (await stores.attempts.findByCredentialId(credId))!;
    const account = (await stores.registry.findAccountByAppUserId(userId))!;
    const passkey = (await stores.registry.findPasskeyByCredentialId(credId))!;
    expect(accountMatchesAttempt(active, account, passkey)).toBe(true);
    expect(winners[0]).toEqual({ account, passkey });

    // The FK real_passkeys.app_user_id -> real_accounts really exists, so the
    // single-statement parent+child insert above was checked against it.
    const [fk] = (await sql`
      SELECT count(*)::int AS n FROM pg_constraint
      WHERE conrelid = 'real_passkeys'::regclass AND confrelid = 'real_accounts'::regclass AND contype = 'f'
    `) as { n: number }[];
    expect(fk!.n).toBeGreaterThanOrEqual(1);

    expect(await stores.attempts.finalize(finalizeInput)).toBeNull();
    expect(await counts()).toEqual({ accounts: 1, passkeys: 1 });
    expect(await stores.registry.findAccountByAppUserId(userId)).toEqual(account);
  });

  it("S5 L3: a conflicting existing row rolls back the WHOLE transaction — the CAS too: the attempt stays turnkey_created, no account, the other row untouched", async () => {
    const { stores, credId, userId, finalizeInput, counts } = await seedTurnkeyCreated("l3-conflict");
    const holderId = appUserId("l3-conflict-holder");
    cleanupAppUserIds.add(holderId);
    // Another account already holds this attempt's credential id.
    await stores.registry.createAccountWithPasskey({
      account: { appUserId: holderId, ...smokeIdentity(holderId), accountConfigVersion: 1 },
      passkey: { credentialId: credId, appUserId: holderId, credentialPublicKey: "holder-cose", userHandle: "holder-handle", counter: 0, transports: null, credentialDeviceType: null, credentialBackedUp: null },
    });

    expect(await stores.attempts.finalize(finalizeInput)).toBeNull();
    expect((await stores.attempts.findByCredentialId(credId))?.state).toBe("turnkey_created");
    expect((await counts()).accounts).toBe(0);
    expect((await stores.registry.findPasskeyByCredentialId(credId))?.appUserId).toBe(holderId);
    expect(await stores.registry.findAccountByAppUserId(userId)).toBeNull();
  });

  it("S5 L3: an active attempt whose account or passkey no longer matches is NOT resumed by onboarding (fails closed)", async () => {
    const { runProvisioningPipeline } = await import("@/lib/real/server/onboarding");
    const smokeConfig = {
      turnkeyApiBaseUrl: "https://api.turnkey.com",
      turnkeyParentOrganizationId: "unused",
      turnkeyApiPublicKey: "unused",
      turnkeyApiPrivateKey: "unused",
      sessionSecret: "smoke-session-secret",
      rpId: "localhost",
      rpName: "Smoke",
      expectedOrigins: ["http://localhost:3000"],
      rpcUrl: "https://sepolia.base.org",
      pimlicoApiKey: "unused",
    };
    const tamperings: Array<[string, (sql: Awaited<ReturnType<typeof seedTurnkeyCreated>>["sql"], userId: string, credId: string) => Promise<unknown>]> = [
      ["account", (sql, userId) => sql`UPDATE real_accounts SET safe_address = '0x000000000000000000000000000000000000dead' WHERE app_user_id = ${userId}`],
      ["passkey", (sql, _userId, credId) => sql`UPDATE real_passkeys SET credential_public_key = 'tampered' WHERE credential_id = ${credId}`],
    ];
    for (const [name, tamper] of tamperings) {
      const { stores, sql, credId, userId, finalizeInput } = await seedTurnkeyCreated(`l3-tamper-${name}`);
      expect(await stores.attempts.finalize(finalizeInput)).not.toBeNull();
      const active = (await stores.attempts.findByCredentialId(credId))!;
      expect((await runProvisioningPipeline({ config: smokeConfig, registry: stores.registry, attempts: stores.attempts, attempt: active })).outcome, name).toBe("verified");

      await tamper(sql, userId, credId);
      const result = await runProvisioningPipeline({ config: smokeConfig, registry: stores.registry, attempts: stores.attempts, attempt: active });
      expect(result.outcome, name).toBe("rejected");
    }
  });

  it("S4: real_accounts.session_epoch is BIGINT NOT NULL DEFAULT 0 (migration applied)", async () => {
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const sql = createNeonSqlClient(databaseUrl!);
    const rows = (await sql`
      SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'real_accounts' AND column_name = 'session_epoch'
    `) as { data_type: string; is_nullable: string; column_default: string | null }[];
    expect(rows, "real_accounts.session_epoch is missing — apply lib/real/server/schema.sql's S4 migration").toHaveLength(1);
    expect(rows[0]).toMatchObject({ data_type: "bigint", is_nullable: "NO" });
    expect(rows[0]?.column_default).toMatch(/^0/);
  });

  it("S4: a new account starts at epoch 0; concurrent increments over real HTTP requests never lose an update; an unknown account is null", async () => {
    const { createNeonRealAccountRegistry } = await import("@/lib/real/server/neon-store");
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const registry = createNeonRealAccountRegistry(createNeonSqlClient(databaseUrl!));
    const credId = credentialId("epoch");
    const userId = appUserId("epoch");
    cleanupCredentialIds.add(credId);
    cleanupAppUserIds.add(userId);
    const { account } = await registry.createAccountWithPasskey({
      account: { appUserId: userId, ...smokeIdentity(userId), accountConfigVersion: 1 },
      passkey: { credentialId: credId, appUserId: userId, credentialPublicKey: "smoke-public-key", userHandle: "smoke-user-handle", counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false },
    });
    expect(account.sessionEpoch).toBe(0);

    const results = await Promise.all(Array.from({ length: 5 }, () => registry.incrementSessionEpoch(userId)));
    expect([...results].sort()).toEqual([1, 2, 3, 4, 5]);
    expect((await registry.findAccountByAppUserId(userId))?.sessionEpoch).toBe(5);
    expect(await registry.incrementSessionEpoch(appUserId("no-such-account"))).toBeNull();
  });

  it("S4: challenge create purges already-expired rows and keeps live ones", async () => {
    const { createNeonChallengeStore } = await import("@/lib/real/server/neon-store");
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const sql = createNeonSqlClient(databaseUrl!);
    const [expired, live, trigger] = [challenge("purge-expired"), challenge("purge-live"), challenge("purge-trigger")];
    for (const value of [expired, live, trigger]) cleanupChallenges.add(value);
    await sql`INSERT INTO webauthn_challenges (challenge, purpose, expires_at) VALUES (${expired}, 'login', now() - interval '1 hour')`;
    await sql`INSERT INTO webauthn_challenges (challenge, purpose, expires_at) VALUES (${live}, 'login', now() + interval '1 hour')`;

    await createNeonChallengeStore(sql).create({ challenge: trigger, purpose: "login", ttlMs: 60_000 });

    const rows = (await sql`SELECT challenge FROM webauthn_challenges WHERE challenge IN (${expired}, ${live}, ${trigger}) ORDER BY challenge`) as { challenge: string }[];
    expect(rows.map((r) => r.challenge).sort()).toEqual([live, trigger].sort());
  });

  it("the database layer never stores signing/private material — a direct row read contains no such fields", async () => {
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const sql = createNeonSqlClient(databaseUrl!);
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
  const RECIPIENT = "0x2222222222222222222222222222222222222222";
  const TOKEN_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const CHAIN_ID = 84532;

  const cleanupAppUserIds = new Set<string>();

  afterAll(async () => {
    if (!databaseUrl) return;
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const sql = createNeonSqlClient(databaseUrl);
    for (const id of cleanupAppUserIds) {
      await sql`DELETE FROM payment_attempts WHERE app_user_id = ${id}`;
      await sql`DELETE FROM real_passkeys WHERE app_user_id = ${id}`;
      await sql`DELETE FROM real_accounts WHERE app_user_id = ${id}`;
    }
  });

  /** Slice S1: every attempt is bound (FK) to a real passkey row. */
  const credentialFor = (userId: string) => `${userId}-credential`;

  async function seedRealAccount(userId: string) {
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const sql = createNeonSqlClient(databaseUrl!);
    const identity = smokeIdentity(userId);
    await sql`
      INSERT INTO real_accounts (app_user_id, sub_organization_id, turnkey_user_id, wallet_id, wallet_account_id, owner_address, safe_address, account_config_version)
      VALUES (${userId}, ${identity.subOrganizationId}, ${identity.turnkeyUserId}, ${identity.walletId}, ${identity.walletAccountId}, ${identity.ownerAddress}, ${identity.safeAddress}, 1)
    `;
    await sql`
      INSERT INTO real_passkeys (credential_id, app_user_id, credential_public_key, user_handle, counter)
      VALUES (${credentialFor(userId)}, ${userId}, 'smoke-cose', 'smoke-handle', 0)
    `;
  }

  function reserveInput(userId: string) {
    return { appUserId: userId, safeAddress: smokeIdentity(userId).safeAddress, recipient: RECIPIENT, amountBaseUnits: "1000000", chainId: CHAIN_ID, tokenAddress: TOKEN_ADDRESS, authorizingCredentialId: credentialFor(userId) };
  }

  it("A: the payment_attempts table exists", async () => {
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const sql = createNeonSqlClient(databaseUrl!);
    const rows = (await sql`SELECT to_regclass('payment_attempts') AS exists`) as { exists: string | null }[];
    expect(rows[0]?.exists, "table payment_attempts is missing — apply the Batch 2d schema addition first").toBe("payment_attempts");
  });

  it("B/F: several concurrent reserve() calls for the same account — exactly one succeeds under real concurrent HTTP requests, atomically", async () => {
    const { createNeonPaymentAttemptStore } = await import("@/lib/real/server/neon-store");
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const sql = createNeonSqlClient(databaseUrl!);
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
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const sql = createNeonSqlClient(databaseUrl!);
    const userId = appUserId("unique-index");
    cleanupAppUserIds.add(userId);
    await seedRealAccount(userId);

    // Raw concurrent inserts, deliberately bypassing reserve()'s advisory
    // lock entirely — this proves the UNIQUE INDEX is an independent
    // backstop, not merely a restatement of the lock's own guarantee.
    const insertOne = () => sql`
      INSERT INTO payment_attempts (app_user_id, safe_address, recipient, amount_base_units, chain_id, token_address, state)
      VALUES (${userId}, ${smokeIdentity(userId).safeAddress}, ${RECIPIENT}, '1000000', ${CHAIN_ID}, ${TOKEN_ADDRESS}, 'prepared')
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
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const sql = createNeonSqlClient(databaseUrl!);
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
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const sql = createNeonSqlClient(databaseUrl!);
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

  it("K: finite expiry — valid_until / prepare_block_number persist as numbers, survive later transitions, and a full uint256 nonce round-trips exactly", async () => {
    const { createNeonPaymentAttemptStore } = await import("@/lib/real/server/neon-store");
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const sql = createNeonSqlClient(databaseUrl!);
    const store = createNeonPaymentAttemptStore(sql);
    const userId = appUserId("expiry");
    cleanupAppUserIds.add(userId);
    await seedRealAccount(userId);

    const reserved = await store.reserve(reserveInput(userId));
    if (!reserved.ok) throw new Error("reserve failed");
    expect(reserved.attempt).toMatchObject({ validUntil: null, prepareBlockNumber: null });

    const liveShapedNonce = "33025095892748469342255938797568"; // timestamp nonce key << 64, sequence 0
    await store.transition({ id: reserved.attempt.id, from: "prepared", to: "awaiting_authorization", patch: { nonce: liveShapedNonce, validUntil: 1_900_000_600, prepareBlockNumber: "47265792" } });
    await store.transition({ id: reserved.attempt.id, from: "awaiting_authorization", to: "signed" });
    const failed = await store.transition({ id: reserved.attempt.id, from: "signed", to: "failed", patch: { failureReason: "smoke" } });

    expect(failed).toMatchObject({ nonce: liveShapedNonce, validUntil: 1_900_000_600, prepareBlockNumber: "47265792" });
    expect(await store.findById(reserved.attempt.id)).toMatchObject({ validUntil: 1_900_000_600, prepareBlockNumber: "47265792" });
  });

  it("S2: an explicit failureReason: null clears a stale failure_reason on unknown -> confirmed; an omitted key leaves it alone", async () => {
    const { createNeonPaymentAttemptStore } = await import("@/lib/real/server/neon-store");
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const sql = createNeonSqlClient(databaseUrl!);
    const store = createNeonPaymentAttemptStore(sql);
    const userId = appUserId("clear-reason");
    cleanupAppUserIds.add(userId);
    await seedRealAccount(userId);

    const reserved = await store.reserve(reserveInput(userId));
    if (!reserved.ok) throw new Error("reserve failed");
    await store.transition({ id: reserved.attempt.id, from: "prepared", to: "awaiting_authorization" });
    await store.transition({ id: reserved.attempt.id, from: "awaiting_authorization", to: "signed" });
    await store.transition({ id: reserved.attempt.id, from: "signed", to: "submitting" });
    await store.transition({ id: reserved.attempt.id, from: "submitting", to: "unknown", patch: { failureReason: "smoke: ambiguous send" } });

    // Omitted key: unchanged (a self-transition, the CAS still applies).
    const untouched = await store.transition({ id: reserved.attempt.id, from: "unknown", to: "unknown", patch: { transactionHash: null } });
    expect(untouched?.failureReason).toBe("smoke: ambiguous send");

    const confirmed = await store.transition({ id: reserved.attempt.id, from: "unknown", to: "confirmed", patch: { transactionHash: `0x${"ab".repeat(32)}`, failureReason: null } });
    expect(confirmed).toMatchObject({ state: "confirmed", failureReason: null });
    const rows = (await sql`SELECT failure_reason FROM payment_attempts WHERE id = ${reserved.attempt.id}`) as { failure_reason: string | null }[];
    expect(rows[0]?.failure_reason).toBeNull();
  });

  it("G/H: CAS state transitions and expected_user_operation_hash persistence work against the real database", async () => {
    const { createNeonPaymentAttemptStore } = await import("@/lib/real/server/neon-store");
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const sql = createNeonSqlClient(databaseUrl!);
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
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const sql = createNeonSqlClient(databaseUrl!);
    const userId = appUserId("no-secrets");
    cleanupAppUserIds.add(userId);
    await seedRealAccount(userId);

    const rows = (await sql`
      INSERT INTO payment_attempts (app_user_id, safe_address, recipient, amount_base_units, chain_id, token_address, state, expected_user_operation_hash)
      VALUES (${userId}, ${smokeIdentity(userId).safeAddress}, ${RECIPIENT}, '1000000', ${CHAIN_ID}, ${TOKEN_ADDRESS}, 'awaiting_authorization', '0xsmokehash')
      RETURNING *
    `) as Record<string, unknown>[];
    const row = rows[0]!;

    expect(Object.keys(row)).not.toContain("signature");
    const serialized = JSON.stringify(row).toLowerCase();
    for (const forbidden of ["signature", "privatekey", "private_key", "seedphrase", "stamper", "signingkey"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("J: findRecentByAppUserId (Batch 2e history read) — newest-first, limit honored, scoped to the requesting account, against the real database", async () => {
    const { createNeonPaymentAttemptStore } = await import("@/lib/real/server/neon-store");
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const sql = createNeonSqlClient(databaseUrl!);
    const store = createNeonPaymentAttemptStore(sql);
    const userId = appUserId("history");
    const otherUserId = appUserId("history-other");
    cleanupAppUserIds.add(userId);
    cleanupAppUserIds.add(otherUserId);
    await seedRealAccount(userId);
    await seedRealAccount(otherUserId);

    // Cancelling between reservations frees the one-active-attempt slot,
    // same pattern test D above uses — three real, sequential rows for the
    // account under test.
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const reserved = await store.reserve(reserveInput(userId));
      expect(reserved.ok).toBe(true);
      if (!reserved.ok) return;
      await store.transition({ id: reserved.attempt.id, from: "prepared", to: "cancelled" });
      ids.push(reserved.attempt.id);
    }

    const otherReserved = await store.reserve(reserveInput(otherUserId));
    expect(otherReserved.ok).toBe(true);
    if (!otherReserved.ok) return;
    await store.transition({ id: otherReserved.attempt.id, from: "prepared", to: "cancelled" });

    const all = await store.findRecentByAppUserId({ appUserId: userId, limit: 10 });
    expect(all.map((a) => a.id)).toEqual([ids[2], ids[1], ids[0]]);
    expect(all.every((a) => a.appUserId === userId)).toBe(true);
    expect(all.some((a) => a.id === otherReserved.attempt.id)).toBe(false);

    const limited = await store.findRecentByAppUserId({ appUserId: userId, limit: 2 });
    expect(limited.map((a) => a.id)).toEqual([ids[2], ids[1]]);

    // Cleanup happens in this describe block's afterAll (deletes
    // payment_attempts + real_accounts by app_user_id) — nothing extra
    // needed here, and no existing live payment row (outside these two
    // smoke-prefixed app_user_ids) is ever touched.
  }, 30_000);

  it("S1: the bound credential persists; the signing activity id is write-once and never recorded on two payments; a revoked passkey keeps its attribution", async () => {
    const { createNeonPaymentAttemptStore } = await import("@/lib/real/server/neon-store");
    const { DuplicateSignActivityError } = await import("@/lib/real/server/payment-attempts");
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const sql = createNeonSqlClient(databaseUrl!);
    const store = createNeonPaymentAttemptStore(sql);
    const userId = appUserId("attribution");
    cleanupAppUserIds.add(userId);
    await seedRealAccount(userId);
    const activityId = `smoke-activity-${runId}`;

    const first = await store.reserve(reserveInput(userId));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.attempt).toMatchObject({ authorizingCredentialId: credentialFor(userId), turnkeySignActivityId: null, authorizationVerifiedAt: null });
    await store.transition({ id: first.attempt.id, from: "prepared", to: "awaiting_authorization" });
    const claimed = await store.transition({ id: first.attempt.id, from: "awaiting_authorization", to: "signed", patch: { turnkeySignActivityId: activityId, authorizationVerifiedAt: new Date().toISOString() } });
    expect(claimed?.turnkeySignActivityId).toBe(activityId);
    expect(claimed?.authorizationVerifiedAt).toBeTruthy();
    const kept = await store.transition({ id: first.attempt.id, from: "signed", to: "failed", patch: { turnkeySignActivityId: "overwrite-attempt" } });
    expect(kept?.turnkeySignActivityId).toBe(activityId); // write-once

    const second = await store.reserve(reserveInput(userId));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    await store.transition({ id: second.attempt.id, from: "prepared", to: "awaiting_authorization" });
    await expect(store.transition({ id: second.attempt.id, from: "awaiting_authorization", to: "signed", patch: { turnkeySignActivityId: activityId } })).rejects.toBeInstanceOf(DuplicateSignActivityError);
    expect((await store.findById(second.attempt.id))?.state).toBe("awaiting_authorization"); // nothing applied
    await store.transition({ id: second.attempt.id, from: "awaiting_authorization", to: "cancelled" });

    await sql`UPDATE real_passkeys SET status = 'revoked' WHERE credential_id = ${credentialFor(userId)}`;
    expect((await store.findById(first.attempt.id))?.authorizingCredentialId).toBe(credentialFor(userId));
  }, 30_000);

  async function signedAttempt(store: import("@/lib/real/server/payment-attempts").PaymentAttemptStore, userId: string) {
    const reserved = await store.reserve(reserveInput(userId));
    if (!reserved.ok) throw new Error("expected a reservation");
    await store.transition({ id: reserved.attempt.id, from: "prepared", to: "awaiting_authorization" });
    await store.transition({ id: reserved.attempt.id, from: "awaiting_authorization", to: "signed" });
    return reserved.attempt.id;
  }

  it("S1: beginDispatch claims signed -> submitting only while the bound passkey is active", async () => {
    const { createNeonPaymentAttemptStore } = await import("@/lib/real/server/neon-store");
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const sql = createNeonSqlClient(databaseUrl!);
    const store = createNeonPaymentAttemptStore(sql);
    const userId = appUserId("dispatch-claim");
    cleanupAppUserIds.add(userId);
    await seedRealAccount(userId);

    const first = await signedAttempt(store, userId);
    expect((await store.beginDispatch({ id: first }))?.state).toBe("submitting");
    expect(await store.beginDispatch({ id: first })).toBeNull();
    await store.transition({ id: first, from: "submitting", to: "failed" });

    await sql`UPDATE real_passkeys SET status = 'revoking' WHERE credential_id = ${credentialFor(userId)}`;
    const second = await signedAttempt(store, userId);
    expect(await store.beginDispatch({ id: second })).toBeNull();
    expect((await store.findById(second))?.state).toBe("signed");
  }, 30_000);

  it("S1: a removal holding the account lock is serialized BEFORE a concurrent beginDispatch — which then sees 'revoking' and refuses", async () => {
    const { createNeonPaymentAttemptStore } = await import("@/lib/real/server/neon-store");
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const sql = createNeonSqlClient(databaseUrl!);
    const store = createNeonPaymentAttemptStore(sql);
    const userId = appUserId("dispatch-lock");
    cleanupAppUserIds.add(userId);
    await seedRealAccount(userId);
    const id = await signedAttempt(store, userId);

    // Same first lock as the 2g removal transactions, held ~2 s with the passkey already revoking (uncommitted).
    const removal = sql.transaction([
      sql`SELECT app_user_id FROM real_accounts WHERE app_user_id = ${userId} FOR UPDATE`,
      sql`UPDATE real_passkeys SET status = 'revoking' WHERE credential_id = ${credentialFor(userId)}`,
      sql`SELECT pg_sleep(2)`,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const [, claimed] = await Promise.all([removal, store.beginDispatch({ id })]);

    expect(claimed).toBeNull();
    expect((await store.findById(id))?.state).toBe("signed");
  }, 30_000);
});

/**
 * Batch 2g live proofs — same explicit gate as above (skipped unless
 * DATABASE_URL is set). These exist to prove, against REAL Postgres through
 * the Neon HTTP transaction path, what the in-memory adapters can only
 * model: the account-row FOR UPDATE serialization, and that each
 * multi-statement sql.transaction() batch rolls back as a whole when its
 * guard statement aborts on a lost race. Every row is namespaced by a run id
 * and deleted in afterAll, children before parents.
 */
describe.skipIf(!process.env.DATABASE_URL)("Neon adapter smoke test — Batch 2g backup passkeys (live database)", () => {
  const databaseUrl = process.env.DATABASE_URL;
  const runId = randomUUID().slice(0, 8);
  const users = new Set<string>();
  const id = (kind: string, n: number | string) => `smoke2g-${runId}-${kind}-${n}`;

  async function sqlFn() {
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    return createNeonSqlClient(databaseUrl!);
  }

  async function stores() {
    const { createNeonDurableStores } = await import("@/lib/real/server/neon-store");
    return createNeonDurableStores(databaseUrl!);
  }

  /**
   * An account with the given passkeys (all Turnkey-mapped unless
   * authenticatorId is null). `purpose` must be a string unique to the
   * calling test — e.g. "confirm-created", "revocation-race-3" — never a
   * bare integer, so a test's fixed purpose can never collide with another
   * test's purpose-prefixed, round-varying id regardless of how many rounds
   * NEON_SMOKE_AB_ROUNDS requests (a round's id always contains the literal
   * "revocation-race-" prefix, which no other purpose string is a prefix
   * match for).
   */
  async function seed(purpose: string, passkeys: Array<{ credentialId: string; status: string; authenticatorId: string | null }>) {
    const sql = await sqlFn();
    const appUserId = id("user", purpose);
    users.add(appUserId);
    await sql`
      INSERT INTO real_accounts (app_user_id, sub_organization_id, turnkey_user_id, wallet_id, wallet_account_id, owner_address, safe_address, account_config_version)
      VALUES (${appUserId}, ${smokeIdentity(appUserId).subOrganizationId}, ${smokeIdentity(appUserId).turnkeyUserId}, ${smokeIdentity(appUserId).walletId}, ${smokeIdentity(appUserId).walletAccountId}, ${smokeIdentity(appUserId).ownerAddress}, ${smokeIdentity(appUserId).safeAddress}, 1)
    `;
    for (const p of passkeys) {
      await sql`
        INSERT INTO real_passkeys (credential_id, app_user_id, credential_public_key, user_handle, counter, status, role, turnkey_authenticator_id)
        VALUES (${p.credentialId}, ${appUserId}, 'pk', 'uh', 0, ${p.status}, 'primary', ${p.authenticatorId})
      `;
    }
    return appUserId;
  }

  const attachInput = (credentialId: string) => ({
    credentialId,
    userHandle: "uh",
    credentialPublicKey: "pk",
    counter: 0,
    transports: null,
    credentialDeviceType: null,
    credentialBackedUp: null,
    registrationChallenge: "c",
    rawClientDataJson: "d",
    rawAttestationObject: "a",
    stepUpCredentialId: "smoke-step-up-credential",
    registrationMintId: "smoke-mint",
  });

  const dispatchPatch = { turnkeyRequestBody: "{}", turnkeyRequestBodySha256: "h", turnkeyRequestTimestampMs: Date.now(), turnkeyRequestStamp: "{}", externalAttemptedAt: new Date().toISOString() };

  afterAll(async () => {
    if (!databaseUrl) return;
    const sql = await sqlFn();
    for (const appUserId of users) {
      await sql`DELETE FROM passkey_revocation_attempts WHERE app_user_id = ${appUserId}`;
      await sql`DELETE FROM backup_passkey_enrollments WHERE app_user_id = ${appUserId}`;
      await sql`DELETE FROM real_passkeys WHERE app_user_id = ${appUserId}`;
      await sql`DELETE FROM real_accounts WHERE app_user_id = ${appUserId}`;
    }
  });

  it("revocation prepare records an attempt WITHOUT changing the target's status (a cookie alone disables nothing)", async () => {
    const s = await stores();
    const purpose = "prepare";
    const [a, b] = [id("cred", `${purpose}-a`), id("cred", `${purpose}-b`)];
    const appUserId = await seed(purpose, [{ credentialId: a, status: "active", authenticatorId: id("auth", `${purpose}-a`) }, { credentialId: b, status: "active", authenticatorId: id("auth", `${purpose}-b`) }]);
    const prepared = await s.revocations.prepare({ appUserId, targetCredentialId: b, authorizerCredentialId: a });
    expect(prepared.ok).toBe(true);
    expect((await s.registry.findPasskeyByCredentialId(b))?.status).toBe("active");
  });

  it("FOR UPDATE serialization over the real Neon HTTP transaction path: racing dispatches 'A by B' and 'B by A' never leave zero active credentials", async () => {
    const s = await stores();
    // Default 5 for routine runs; override for a deeper live-verification pass, e.g.
    // NEON_SMOKE_AB_ROUNDS=20 pnpm exec vitest run test/lib/real/neon-smoke.test.ts -t "Batch 2g"
    const rounds = Number(process.env.NEON_SMOKE_AB_ROUNDS ?? 5);
    for (let round = 1; round <= rounds; round += 1) {
      const purpose = `revocation-race-${round}`;
      const [a, b] = [id("cred", `${purpose}-a`), id("cred", `${purpose}-b`)];
      const appUserId = await seed(purpose, [{ credentialId: a, status: "active", authenticatorId: id("auth", `${purpose}-a`) }, { credentialId: b, status: "active", authenticatorId: id("auth", `${purpose}-b`) }]);
      const aByB = await s.revocations.prepare({ appUserId, targetCredentialId: a, authorizerCredentialId: b });
      const bByA = await s.revocations.prepare({ appUserId, targetCredentialId: b, authorizerCredentialId: a });
      if (!aByB.ok || !bByA.ok) throw new Error("setup");
      const results = await Promise.all([s.revocations.beginDispatch({ id: aByB.attempt.id, patch: dispatchPatch }), s.revocations.beginDispatch({ id: bByA.attempt.id, patch: dispatchPatch })]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const active = (await s.registry.findPasskeysByAppUserId(appUserId)).filter((p) => p.status === "active" && p.turnkeyAuthenticatorId);
      expect(active).toHaveLength(1);
      // The loser changed nothing: its attempt is still undispatched.
      const loser = results[0] ? bByA.attempt.id : aByB.attempt.id;
      expect((await s.revocations.findById(loser))?.state).toBe("authorization_needed");
    }
  }, 60_000);

  it("concurrent pending-credential registration onto one enrollment leaves exactly one valid pending row and no orphan", async () => {
    const s = await stores();
    const purpose = "registration-race";
    const appUserId = await seed(purpose, [{ credentialId: id("cred", `${purpose}-primary`), status: "active", authenticatorId: id("auth", `${purpose}-primary`) }]);
    const enrollment = (await s.backupEnrollments.createStarted({ appUserId }))!;
    await s.backupEnrollments.transition({ id: enrollment.id, from: "started", to: "started", patch: { registrationMintId: "smoke-mint" } });
    const results = await Promise.all([
      s.backupEnrollments.registerCredential({ id: enrollment.id, credential: attachInput(id("cred", `${purpose}-x`)) }),
      s.backupEnrollments.registerCredential({ id: enrollment.id, credential: attachInput(id("cred", `${purpose}-y`)) }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const pending = (await s.registry.findPasskeysByAppUserId(appUserId)).filter((p) => p.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.credentialId).toBe((results[0] ?? results[1])!.newCredentialId);
  });

  it("a lost CAS in confirmCreated rolls back the WHOLE transaction (the enrollment never advances without the passkey mapping)", async () => {
    const s = await stores();
    const sql = await sqlFn();
    const purpose = "confirm-created";
    const appUserId = await seed(purpose, [{ credentialId: id("cred", `${purpose}-primary`), status: "active", authenticatorId: id("auth", `${purpose}-primary`) }]);
    const cred = id("cred", `${purpose}-new`);
    const enrollment = (await s.backupEnrollments.createStarted({ appUserId }))!;
    await s.backupEnrollments.transition({ id: enrollment.id, from: "started", to: "started", patch: { registrationMintId: "smoke-mint" } });
    await s.backupEnrollments.registerCredential({ id: enrollment.id, credential: attachInput(cred) });
    await s.backupEnrollments.transition({ id: enrollment.id, from: "credential_registered", to: "turnkey_enrollment_in_flight", patch: { externalOutcome: "unknown" } });
    // Something else mapped the passkey first -> statement 2 matches nothing -> guard aborts.
    await sql`UPDATE real_passkeys SET turnkey_authenticator_id = ${id("auth", `${purpose}-conflict`)} WHERE credential_id = ${cred}`;

    expect(await s.backupEnrollments.confirmCreated({ id: enrollment.id, turnkeyAuthenticatorId: id("auth", `${purpose}-new`), turnkeyAuthenticatorPublicKey: "02ab", turnkeyActivityStatus: null })).toBeNull();
    const after = (await s.backupEnrollments.findById(enrollment.id))!;
    expect(after.state).toBe("turnkey_enrollment_in_flight");
    expect(after.turnkeyAuthenticatorId).toBeNull();
    expect(after.externalOutcome).toBe("unknown");
  });

  it("a lost CAS in activation rolls back the WHOLE transaction (never 'enrollment active + passkey not active')", async () => {
    const s = await stores();
    const sql = await sqlFn();
    const purpose = "activation";
    const appUserId = await seed(purpose, [{ credentialId: id("cred", `${purpose}-primary`), status: "active", authenticatorId: id("auth", `${purpose}-primary`) }]);
    const cred = id("cred", `${purpose}-new`);
    const enrollment = (await s.backupEnrollments.createStarted({ appUserId }))!;
    await s.backupEnrollments.transition({ id: enrollment.id, from: "started", to: "started", patch: { registrationMintId: "smoke-mint" } });
    await s.backupEnrollments.registerCredential({ id: enrollment.id, credential: attachInput(cred) });
    await s.backupEnrollments.transition({ id: enrollment.id, from: "credential_registered", to: "turnkey_enrollment_in_flight", patch: { externalOutcome: "unknown" } });
    expect(await s.backupEnrollments.confirmCreated({ id: enrollment.id, turnkeyAuthenticatorId: id("auth", `${purpose}-new`), turnkeyAuthenticatorPublicKey: "02ab", turnkeyActivityStatus: "ACTIVITY_STATUS_COMPLETED" })).not.toBeNull();
    await s.backupEnrollments.transition({ id: enrollment.id, from: "turnkey_authenticator_created", to: "login_verified", patch: { loginVerifiedAt: new Date().toISOString() } });
    // The pending passkey stops being pending -> statement 2 matches nothing -> guard aborts.
    await sql`UPDATE real_passkeys SET status = 'revoked' WHERE credential_id = ${cred}`;

    expect(await s.backupEnrollments.activate({ id: enrollment.id, signingProofActivityId: "sign-1" })).toBeNull();
    const after = (await s.backupEnrollments.findById(enrollment.id))!;
    expect(after.state).toBe("login_verified");
    expect(after.signingVerifiedAt).toBeNull();
  });

  it("beginDispatch re-checks the survivor inside the locked transaction: an ineligible survivor changes nothing (attempt stays undispatched, target stays active)", async () => {
    const s = await stores();
    const purpose = "dispatch-eligibility";
    const [a, b] = [id("cred", `${purpose}-a`), id("cred", `${purpose}-b`)];
    const appUserId = await seed(purpose, [{ credentialId: a, status: "active", authenticatorId: id("auth", `${purpose}-a`) }, { credentialId: b, status: "active", authenticatorId: id("auth", `${purpose}-b`) }]);
    const prepared = await s.revocations.prepare({ appUserId, targetCredentialId: b, authorizerCredentialId: a });
    if (!prepared.ok) throw new Error("setup");
    // The survivor is no longer eligible -> statement 2 matches nothing; nothing may change.
    const sql = await sqlFn();
    await sql`UPDATE real_passkeys SET turnkey_authenticator_id = NULL WHERE credential_id = ${a}`;
    expect(await s.revocations.beginDispatch({ id: prepared.attempt.id, patch: dispatchPatch })).toBeNull();
    expect((await s.revocations.findById(prepared.attempt.id))?.state).toBe("authorization_needed");
    expect((await s.registry.findPasskeyByCredentialId(b))?.status).toBe("active");
  });

  async function dispatched(purpose: string) {
    const s = await stores();
    const [a, b] = [id("cred", `${purpose}-a`), id("cred", `${purpose}-b`)];
    const appUserId = await seed(purpose, [{ credentialId: a, status: "active", authenticatorId: id("auth", `${purpose}-a`) }, { credentialId: b, status: "active", authenticatorId: id("auth", `${purpose}-b`) }]);
    const prepared = await s.revocations.prepare({ appUserId, targetCredentialId: b, authorizerCredentialId: a });
    if (!prepared.ok || !(await s.revocations.beginDispatch({ id: prepared.attempt.id, patch: dispatchPatch }))) throw new Error("setup");
    return { s, attemptId: prepared.attempt.id, target: b };
  }

  it("recordActivity SQL is first-writer-wins and clears the stamp; blocking a dispatched attempt leaves the target 'revoking'", async () => {
    const { s, attemptId, target } = await dispatched("activity-recording");
    expect(await s.revocations.recordActivity({ id: attemptId, activityId: "act-1", activityStatus: "ACTIVITY_STATUS_FAILED" })).toMatchObject({ turnkeyActivityId: "act-1", turnkeyRequestStamp: null });
    expect(await s.revocations.recordActivity({ id: attemptId, activityId: "act-2", activityStatus: "ACTIVITY_STATUS_COMPLETED" })).toBeNull();
    expect(await s.revocations.transition({ id: attemptId, from: "dispatch_in_flight", to: "blocked", patch: { failureReason: "delete_activity_failed" } })).toMatchObject({ state: "blocked", turnkeyActivityId: "act-1" });
    expect((await s.registry.findPasskeyByCredentialId(target))?.status).toBe("revoking");
  });

  it("the schema has no post-dispatch restore state: 'failed' is rejected by the state CHECK", async () => {
    const { attemptId } = await dispatched("schema-guard");
    const sql = await sqlFn();
    await expect(sql`UPDATE passkey_revocation_attempts SET state = 'failed' WHERE id = ${attemptId}`).rejects.toThrow();
  });

  it("confirmDeleted: removing the primary promotes the sole active survivor in the same transaction (role only); removing a backup promotes nothing", async () => {
    const s = await stores();
    const sql = await sqlFn();
    const run = async (purpose: string, remove: "primary" | "backup") => {
      const [p, b] = [id("cred", `${purpose}-primary`), id("cred", `${purpose}-backup`)];
      const appUserId = await seed(purpose, [{ credentialId: p, status: "active", authenticatorId: id("auth", `${purpose}-p`) }, { credentialId: b, status: "active", authenticatorId: id("auth", `${purpose}-b`) }]);
      await sql`UPDATE real_passkeys SET role = 'backup', created_at = now() + interval '1 second' WHERE credential_id = ${b}`;
      const [target, survivor] = remove === "primary" ? [p, b] : [b, p];
      const survivorBefore = await s.registry.findPasskeyByCredentialId(survivor);
      const accountBefore = await s.registry.findAccountByAppUserId(appUserId);
      const prepared = await s.revocations.prepare({ appUserId, targetCredentialId: target, authorizerCredentialId: survivor });
      if (!prepared.ok || !(await s.revocations.beginDispatch({ id: prepared.attempt.id, patch: dispatchPatch }))) throw new Error("setup");
      expect((await s.registry.findPasskeyByCredentialId(survivor))?.role).toBe(survivorBefore!.role); // not promoted while only 'revoking'
      expect(await s.revocations.confirmDeleted({ id: prepared.attempt.id, turnkeyActivityStatus: "ACTIVITY_STATUS_COMPLETED" })).toMatchObject({ state: "confirmed" });
      return { target: await s.registry.findPasskeyByCredentialId(target), survivor: await s.registry.findPasskeyByCredentialId(survivor), survivorBefore, accountBefore, account: await s.registry.findAccountByAppUserId(appUserId) };
    };

    const removedPrimary = await run("promote-remove-primary", "primary");
    expect(removedPrimary.target).toMatchObject({ status: "revoked", role: "primary" }); // row kept as history
    expect(removedPrimary.survivor).toEqual({ ...removedPrimary.survivorBefore, role: "primary" });
    expect(removedPrimary.account).toEqual(removedPrimary.accountBefore);

    const removedBackup = await run("promote-remove-backup", "backup");
    expect(removedBackup.target).toMatchObject({ status: "revoked", role: "backup" });
    expect(removedBackup.survivor).toEqual(removedBackup.survivorBefore);
  });

  // ---------------------------------------------------------------- 2g-H

  it("2g-H: the 'backup_step_up' challenge purpose is accepted by the migrated CHECK, and consume stays single-use and purpose-bound", async () => {
    const s = await stores();
    const sql = await sqlFn();
    const challenge = id("challenge", "step-up");
    try {
      await s.challengeStore.create({ challenge, purpose: "backup_step_up", ttlMs: 60_000, context: { appUserId: "x", credentialId: "y" } });
      expect(await s.challengeStore.consume({ challenge, purpose: "backup_registration" })).toBeNull(); // wrong purpose (and now consumed)
      await s.challengeStore.create({ challenge, purpose: "backup_step_up", ttlMs: 60_000, context: { appUserId: "x", credentialId: "y" } });
      expect(await s.challengeStore.consume({ challenge, purpose: "backup_step_up" })).toMatchObject({ purpose: "backup_step_up", context: { appUserId: "x", credentialId: "y" } });
      expect(await s.challengeStore.consume({ challenge, purpose: "backup_step_up" })).toBeNull();
    } finally {
      await sql`DELETE FROM webauthn_challenges WHERE challenge = ${challenge}`;
    }
  });

  /** An account with an active mapped primary plus a backup enrollment driven to `turnkey_authenticator_created` (the pending passkey is mapped). */
  async function pendingLive(purpose: string) {
    const s = await stores();
    const primary = id("cred", `${purpose}-primary`);
    const appUserId = await seed(purpose, [{ credentialId: primary, status: "active", authenticatorId: id("auth", `${purpose}-primary`) }]);
    const pending = id("cred", `${purpose}-pending`);
    const enrollment = (await s.backupEnrollments.createStarted({ appUserId }))!;
    await s.backupEnrollments.transition({ id: enrollment.id, from: "started", to: "started", patch: { registrationMintId: "smoke-mint" } });
    expect(await s.backupEnrollments.registerCredential({ id: enrollment.id, credential: { ...attachInput(pending), stepUpCredentialId: primary } })).toMatchObject({ registrationStepUpCredentialId: primary });
    await s.backupEnrollments.transition({ id: enrollment.id, from: "credential_registered", to: "turnkey_enrollment_in_flight", patch: { externalOutcome: "unknown" } });
    if (!(await s.backupEnrollments.confirmCreated({ id: enrollment.id, turnkeyAuthenticatorId: id("auth", `${purpose}-pending`), turnkeyAuthenticatorPublicKey: "02ab", turnkeyActivityStatus: "ACTIVITY_STATUS_COMPLETED" }))) throw new Error("setup");
    return { s, appUserId, primary, pending, enrollmentId: enrollment.id };
  }

  it("2g-H: a pending passkey WITHOUT a Turnkey mapping is not removable", async () => {
    const s = await stores();
    const purpose = "pending-unmapped";
    const primary = id("cred", `${purpose}-primary`);
    const appUserId = await seed(purpose, [{ credentialId: primary, status: "active", authenticatorId: id("auth", `${purpose}-primary`) }]);
    const pending = id("cred", `${purpose}-pending`);
    const enrollment = (await s.backupEnrollments.createStarted({ appUserId }))!;
    await s.backupEnrollments.transition({ id: enrollment.id, from: "started", to: "started", patch: { registrationMintId: "smoke-mint" } });
    await s.backupEnrollments.registerCredential({ id: enrollment.id, credential: { ...attachInput(pending), stepUpCredentialId: primary } });
    expect(await s.revocations.prepare({ appUserId, targetCredentialId: pending, authorizerCredentialId: primary })).toEqual({ ok: false, reason: "target_not_removable" });
  });

  it("2g-H: removing a pending-but-mapped passkey — the locked dispatch moves the enrollment to 'removal_in_progress' (slot STILL HELD) and the passkey to 'revoking'; only confirmDeleted makes it 'revoked' + 'removed' and frees the slot", async () => {
    const { s, appUserId, primary, pending, enrollmentId } = await pendingLive("pending-removal");
    const prepared = await s.revocations.prepare({ appUserId, targetCredentialId: pending, authorizerCredentialId: primary });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared));
    expect((await s.registry.findPasskeyByCredentialId(pending))?.status).toBe("pending"); // prepare alone changes nothing

    expect(await s.revocations.beginDispatch({ id: prepared.attempt.id, patch: dispatchPatch })).toMatchObject({ state: "dispatch_in_flight" });
    expect((await s.registry.findPasskeyByCredentialId(pending))?.status).toBe("revoking");
    expect((await s.backupEnrollments.findById(enrollmentId))?.state).toBe("removal_in_progress");
    expect(await s.backupEnrollments.findActiveByAppUserId(appUserId)).toMatchObject({ id: enrollmentId, state: "removal_in_progress" });
    expect(await s.backupEnrollments.createStarted({ appUserId })).toBeNull(); // slot held while unresolved
    expect(await s.backupEnrollments.activate({ id: enrollmentId, signingProofActivityId: "late" })).toBeNull();

    expect(await s.revocations.confirmDeleted({ id: prepared.attempt.id, turnkeyActivityStatus: "ACTIVITY_STATUS_COMPLETED" })).toMatchObject({ state: "confirmed" });
    expect(await s.registry.findPasskeyByCredentialId(pending)).toMatchObject({ status: "revoked", role: "backup" }); // row kept as history
    expect((await s.backupEnrollments.findById(enrollmentId))?.state).toBe("removed");
    expect((await s.registry.findPasskeyByCredentialId(primary))?.status).toBe("active");
    expect(await s.backupEnrollments.createStarted({ appUserId })).toMatchObject({ state: "started" }); // freed atomically with the confirmation
  });

  it("2g-H: a BLOCKED removal keeps the slot and is retryable — a new attempt dispatches (target stays 'revoking'), and its confirmation revokes + frees the slot", async () => {
    const { s, appUserId, primary, pending, enrollmentId } = await pendingLive("pending-retry");
    const first = await s.revocations.prepare({ appUserId, targetCredentialId: pending, authorizerCredentialId: primary });
    if (!first.ok || !(await s.revocations.beginDispatch({ id: first.attempt.id, patch: dispatchPatch }))) throw new Error("setup");
    expect(await s.revocations.prepare({ appUserId, targetCredentialId: pending, authorizerCredentialId: primary })).toEqual({ ok: false, reason: "removal_in_progress" });
    expect(await s.revocations.transition({ id: first.attempt.id, from: "dispatch_in_flight", to: "blocked", patch: { failureReason: "delete_activity_failed" } })).toMatchObject({ state: "blocked" });
    expect(await s.backupEnrollments.createStarted({ appUserId })).toBeNull();

    const retry = await s.revocations.prepare({ appUserId, targetCredentialId: pending, authorizerCredentialId: primary });
    if (!retry.ok) throw new Error(JSON.stringify(retry));
    expect(retry.attempt.targetTurnkeyAuthenticatorId).toBe(first.attempt.targetTurnkeyAuthenticatorId);
    // FIX 3: the retry's signed bytes must differ from every earlier dispatched attempt's — reusing them is refused atomically.
    expect(await s.revocations.beginDispatch({ id: retry.attempt.id, patch: dispatchPatch })).toBeNull();
    expect((await s.revocations.findById(retry.attempt.id))?.state).toBe("authorization_needed");
    expect(await s.revocations.beginDispatch({ id: retry.attempt.id, patch: { ...dispatchPatch, turnkeyRequestBodySha256: "h-fresh-retry" } })).toMatchObject({ state: "dispatch_in_flight" });
    expect((await s.registry.findPasskeyByCredentialId(pending))?.status).toBe("revoking");
    expect(await s.revocations.confirmDeleted({ id: retry.attempt.id, turnkeyActivityStatus: "ACTIVITY_STATUS_COMPLETED" })).toMatchObject({ state: "confirmed" });
    expect((await s.registry.findPasskeyByCredentialId(pending))?.status).toBe("revoked");
    expect((await s.backupEnrollments.findById(enrollmentId))?.state).toBe("removed");
    expect((await s.revocations.findById(first.attempt.id))?.state).toBe("blocked"); // history kept
    expect(await s.backupEnrollments.createStarted({ appUserId })).toMatchObject({ state: "started" });
  });

  it("2g-H: an unresolved create HOLDS the slot (in flight, and 'blocked' review under the new index); the replay claim and activity recording are first-writer-wins under real concurrency; exact-match recovery maps it and clears the review reason", async () => {
    const s = await stores();
    const purpose = "unresolved-create";
    const primary = id("cred", `${purpose}-primary`);
    const appUserId = await seed(purpose, [{ credentialId: primary, status: "active", authenticatorId: id("auth", `${purpose}-primary`) }]);
    const pending = id("cred", `${purpose}-pending`);
    const enrollment = (await s.backupEnrollments.createStarted({ appUserId }))!;
    await s.backupEnrollments.transition({ id: enrollment.id, from: "started", to: "started", patch: { registrationMintId: "smoke-mint" } });
    await s.backupEnrollments.registerCredential({ id: enrollment.id, credential: { ...attachInput(pending), stepUpCredentialId: primary } });
    await s.backupEnrollments.transition({ id: enrollment.id, from: "credential_registered", to: "turnkey_enrollment_in_flight", patch: { externalOutcome: "unknown", turnkeyRequestBody: "{}", turnkeyRequestStamp: "{}" } });
    expect(await s.backupEnrollments.createStarted({ appUserId })).toBeNull();

    const claims = await Promise.all([1, 2, 3].map(() => s.backupEnrollments.claimReplay({ id: enrollment.id })));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const records = await Promise.all(["act-a", "act-b", "act-c"].map((activityId) => s.backupEnrollments.recordActivity({ id: enrollment.id, activityId, activityStatus: "ACTIVITY_STATUS_FAILED" })));
    const winner = records.filter(Boolean);
    expect(winner).toHaveLength(1);
    expect(await s.backupEnrollments.findById(enrollment.id)).toMatchObject({ turnkeyActivityId: winner[0]!.turnkeyActivityId, turnkeyRequestReplayed: true, turnkeyRequestStamp: null });

    await s.backupEnrollments.transition({ id: enrollment.id, from: "turnkey_enrollment_in_flight", to: "blocked", patch: { blockReason: "review" } });
    expect(await s.backupEnrollments.createStarted({ appUserId })).toBeNull(); // 'blocked' now counts as open
    expect(await s.backupEnrollments.findActiveByAppUserId(appUserId)).toMatchObject({ state: "blocked" });
    expect(await s.backupEnrollments.abandon({ id: enrollment.id })).toBeNull();

    expect(await s.backupEnrollments.confirmCreated({ id: enrollment.id, turnkeyAuthenticatorId: id("auth", `${purpose}-pending`), turnkeyAuthenticatorPublicKey: "02ab", turnkeyActivityStatus: null })).toMatchObject({ state: "turnkey_authenticator_created", blockReason: null });
    expect(await s.registry.findPasskeyByCredentialId(pending)).toMatchObject({ status: "pending", turnkeyAuthenticatorId: id("auth", `${purpose}-pending`) });
  });

  it("2g-H: a superseded registration mint never attaches (and leaves no orphan passkey); a dispatched create can never be abandoned", async () => {
    const s = await stores();
    const purpose = "mint-supersede";
    const primary = id("cred", `${purpose}-primary`);
    const appUserId = await seed(purpose, [{ credentialId: primary, status: "active", authenticatorId: id("auth", `${purpose}-primary`) }]);
    const enrollment = (await s.backupEnrollments.createStarted({ appUserId }))!;
    await s.backupEnrollments.transition({ id: enrollment.id, from: "started", to: "started", patch: { registrationMintId: "mint-old" } });
    await s.backupEnrollments.transition({ id: enrollment.id, from: "started", to: "started", patch: { registrationMintId: "mint-new" } });
    const stale = id("cred", `${purpose}-stale`);
    expect(await s.backupEnrollments.registerCredential({ id: enrollment.id, credential: { ...attachInput(stale), stepUpCredentialId: primary, registrationMintId: "mint-old" } })).toBeNull();
    expect(await s.registry.findPasskeyByCredentialId(stale)).toBeNull();
    const fresh = id("cred", `${purpose}-fresh`);
    expect(await s.backupEnrollments.registerCredential({ id: enrollment.id, credential: { ...attachInput(fresh), stepUpCredentialId: primary, registrationMintId: "mint-new" } })).toMatchObject({ newCredentialId: fresh });
    // A legacy 'definitive_failure' (a create WAS dispatched) is no longer abandonable at the SQL level either.
    await s.backupEnrollments.transition({ id: enrollment.id, from: "credential_registered", to: "credential_registered", patch: { externalOutcome: "definitive_failure" } });
    expect(await s.backupEnrollments.abandon({ id: enrollment.id })).toBeNull();
    expect((await s.registry.findPasskeyByCredentialId(fresh))?.status).toBe("pending");
  });

  it("2g-H migration (exact schema.sql block, on a scratch table): refuses on a blocked + open conflict with the OLD index intact and enforcing, then swaps once resolved, and reruns idempotently", async () => {
    const sql = await sqlFn();
    const { readFileSync } = await import("node:fs");
    const schema = readFileSync("lib/real/server/schema.sql", "utf8");
    const block = schema.slice(schema.indexOf("-- BEGIN 2g-H one-open-index migration"), schema.indexOf("-- END 2g-H one-open-index migration"));
    expect(block).toContain("DO $$");
    const t = `smoke_2gh_migration_${runId}`.replace(/[^a-z0-9_]/g, "_");
    const migration = block
      .replaceAll("backup_passkey_enrollments_one_open_per_account", `${t}_one_open`)
      .replaceAll("backup_passkey_enrollments_one_active_per_account", `${t}_one_active`)
      .replaceAll("backup_passkey_enrollments", t);
    const indexes = async () => ((await sql.query(`SELECT indexname FROM pg_indexes WHERE tablename = $1 ORDER BY indexname`, [t])) as { indexname: string }[]).map((r) => r.indexname);
    try {
      await sql.query(`CREATE TABLE ${t} (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), app_user_id TEXT NOT NULL, state TEXT NOT NULL)`);
      await sql.query(`CREATE UNIQUE INDEX ${t}_one_active ON ${t} (app_user_id) WHERE state NOT IN ('active', 'abandoned', 'blocked')`);
      await sql.query(`INSERT INTO ${t} (app_user_id, state) VALUES ('u1', 'blocked'), ('u1', 'started')`);

      await expect(sql.query(migration)).rejects.toThrow(/migration refused/);
      expect(await indexes()).toEqual([`${t}_one_active`, `${t}_pkey`].sort());
      await expect(sql.query(`INSERT INTO ${t} (app_user_id, state) VALUES ('u1', 'credential_registered')`)).rejects.toThrow(); // old protection still enforced

      await sql.query(`UPDATE ${t} SET state = 'abandoned' WHERE state = 'blocked'`);
      await sql.query(migration);
      expect(await indexes()).toEqual([`${t}_one_open`, `${t}_pkey`].sort());
      await sql.query(migration); // rerunnable
      expect(await indexes()).toEqual([`${t}_one_open`, `${t}_pkey`].sort());
      await sql.query(`INSERT INTO ${t} (app_user_id, state) VALUES ('u2', 'blocked')`);
      await expect(sql.query(`INSERT INTO ${t} (app_user_id, state) VALUES ('u2', 'started')`)).rejects.toThrow(); // new rule: blocked holds the slot
    } finally {
      await sql.query(`DROP TABLE IF EXISTS ${t}`);
    }
  });

  it("2g-H: activation vs pending removal under real concurrency — one serialization order, always consistent, never frees the slot at dispatch", async () => {
    const rounds = Number(process.env.NEON_SMOKE_AB_ROUNDS ?? 5);
    for (let round = 1; round <= rounds; round += 1) {
      const { s, appUserId, primary, pending, enrollmentId } = await pendingLive(`activation-race-${round}`);
      await s.backupEnrollments.transition({ id: enrollmentId, from: "turnkey_authenticator_created", to: "login_verified", patch: { loginVerifiedAt: new Date().toISOString() } });
      const prepared = await s.revocations.prepare({ appUserId, targetCredentialId: pending, authorizerCredentialId: primary });
      if (!prepared.ok) throw new Error("setup");
      const [activated, dispatched] = await Promise.all([
        s.backupEnrollments.activate({ id: enrollmentId, signingProofActivityId: `sign-${round}` }),
        s.revocations.beginDispatch({ id: prepared.attempt.id, patch: dispatchPatch }),
      ]);
      expect(dispatched).toMatchObject({ state: "dispatch_in_flight" });
      expect((await s.registry.findPasskeyByCredentialId(pending))?.status).toBe("revoking");
      const state = (await s.backupEnrollments.findById(enrollmentId))!.state;
      expect(state).toBe(activated ? "active" : "removal_in_progress");
    }
  }, 60_000);

  it("passkey names: rename is scoped to the owning account and active status; the DB CHECK caps length; seeded rows default to NULL", async () => {
    const s = await stores();
    const purpose = "rename";
    const [a, revoked] = [id("cred", `${purpose}-a`), id("cred", `${purpose}-revoked`)];
    const appUserId = await seed(purpose, [{ credentialId: a, status: "active", authenticatorId: null }, { credentialId: revoked, status: "revoked", authenticatorId: null }]);
    const otherUser = await seed(`${purpose}-other`, [{ credentialId: id("cred", `${purpose}-other`), status: "active", authenticatorId: null }]);

    expect((await s.registry.findPasskeyByCredentialId(a))?.displayName).toBeNull();
    expect(await s.registry.renamePasskey({ appUserId: otherUser, credentialId: a, displayName: "Hijacked" })).toEqual({ outcome: "not_found" });
    expect(await s.registry.renamePasskey({ appUserId, credentialId: revoked, displayName: "Old key" })).toEqual({ outcome: "not_active" });
    expect(await s.registry.renamePasskey({ appUserId, credentialId: a, displayName: "MacBook Touch ID" })).toMatchObject({ outcome: "renamed", passkey: { displayName: "MacBook Touch ID", status: "active" } });
    expect((await s.registry.findPasskeyByCredentialId(revoked))?.displayName).toBeNull();

    const sql = await sqlFn();
    await expect(sql`UPDATE real_passkeys SET display_name = ${"a".repeat(41)} WHERE credential_id = ${a}`).rejects.toThrow();
    await expect(sql`UPDATE real_passkeys SET display_name = '' WHERE credential_id = ${a}`).rejects.toThrow();
  });
});

/**
 * Slice S3 — the operator resolution store's SQL (passkey-revocation-
 * resolution-store.ts). Same DATABASE_URL gate as above; NOT yet run live.
 * Needs schema.sql's passkey_revocation_resolutions table applied first.
 * Covers only the Neon adapter (the account-locked commit batch, its CAS
 * predicates, its rollback guards, the audit uniqueness) — the resolver's
 * evidence logic is covered offline by passkey-revocation-resolver.test.ts.
 */
describe.skipIf(!process.env.DATABASE_URL)("Neon adapter smoke test — Slice S3 blocked-removal resolution (live database)", () => {
  const databaseUrl = process.env.DATABASE_URL;
  const runId = randomUUID().slice(0, 8);
  const users = new Set<string>();
  const id = (kind: string, n: string) => `smokeS3-${runId}-${kind}-${n}`;

  async function sqlFn() {
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    return createNeonSqlClient(databaseUrl!);
  }

  async function stores() {
    const { createNeonDurableStores } = await import("@/lib/real/server/neon-store");
    const { createNeonRevocationResolutionStore } = await import("@/lib/real/server/passkey-revocation-resolution-store");
    return { ...createNeonDurableStores(databaseUrl!), resolution: createNeonRevocationResolutionStore(await sqlFn()) };
  }

  const sha = async (body: string) => (await import("@/lib/real/server/turnkey-signed-request")).sha256Hex(body);

  /** Primary (active, mapped) + a pending-but-mapped backup whose removal is dispatched and then BLOCKED (slot held). */
  const STAMP_SENTINEL = "SMOKE-STAMP-SENTINEL";

  /** `keepStamp`: leave the sentinel stamp on the blocked row (normal blocking clears it) so a test can prove loadSnapshot never reads it. */
  async function blockedPendingRemoval(purpose: string, opts: { keepStamp?: boolean } = {}) {
    const s = await stores();
    const sql = await sqlFn();
    const appUserId = id("user", purpose);
    users.add(appUserId);
    const primary = id("cred", `${purpose}-primary`);
    const pending = id("cred", `${purpose}-pending`);
    await sql`
      INSERT INTO real_accounts (app_user_id, sub_organization_id, turnkey_user_id, wallet_id, wallet_account_id, owner_address, safe_address, account_config_version)
      VALUES (${appUserId}, ${smokeIdentity(appUserId).subOrganizationId}, ${smokeIdentity(appUserId).turnkeyUserId}, ${smokeIdentity(appUserId).walletId}, ${smokeIdentity(appUserId).walletAccountId}, ${smokeIdentity(appUserId).ownerAddress}, ${smokeIdentity(appUserId).safeAddress}, 1)
    `;
    await sql`
      INSERT INTO real_passkeys (credential_id, app_user_id, credential_public_key, user_handle, counter, status, role, turnkey_authenticator_id)
      VALUES (${primary}, ${appUserId}, 'pk', 'uh', 0, 'active', 'primary', ${id("auth", `${purpose}-primary`)})
    `;
    const enrollment = (await s.backupEnrollments.createStarted({ appUserId }))!;
    await s.backupEnrollments.transition({ id: enrollment.id, from: "started", to: "started", patch: { registrationMintId: "smoke-mint" } });
    await s.backupEnrollments.registerCredential({
      id: enrollment.id,
      credential: { credentialId: pending, userHandle: "uh", credentialPublicKey: "pk", counter: 0, transports: null, credentialDeviceType: null, credentialBackedUp: null, registrationChallenge: "c", rawClientDataJson: "d", rawAttestationObject: "a", stepUpCredentialId: primary, registrationMintId: "smoke-mint" },
    });
    await s.backupEnrollments.transition({ id: enrollment.id, from: "credential_registered", to: "turnkey_enrollment_in_flight", patch: { externalOutcome: "unknown" } });
    const targetAuth = id("auth", `${purpose}-pending`);
    if (!(await s.backupEnrollments.confirmCreated({ id: enrollment.id, turnkeyAuthenticatorId: targetAuth, turnkeyAuthenticatorPublicKey: "02ab", turnkeyActivityStatus: "ACTIVITY_STATUS_COMPLETED" }))) throw new Error("setup");

    const prepared = await s.revocations.prepare({ appUserId, targetCredentialId: pending, authorizerCredentialId: primary });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared));
    const body = JSON.stringify({ type: "ACTIVITY_TYPE_DELETE_AUTHENTICATORS", timestampMs: String(Date.now()), organizationId: smokeIdentity(appUserId).subOrganizationId, parameters: { userId: smokeIdentity(appUserId).turnkeyUserId, authenticatorIds: [targetAuth] } });
    const bodySha = await sha(body);
    if (!(await s.revocations.beginDispatch({ id: prepared.attempt.id, patch: { turnkeyRequestBody: body, turnkeyRequestBodySha256: bodySha, turnkeyRequestTimestampMs: Date.now(), turnkeyRequestStamp: STAMP_SENTINEL, externalAttemptedAt: new Date().toISOString() } }))) throw new Error("setup");
    await s.revocations.transition({ id: prepared.attempt.id, from: "dispatch_in_flight", to: "blocked", patch: { failureReason: "no_activity_receipt", ...(opts.keepStamp ? {} : { turnkeyRequestStamp: null }) } });
    return { s, sql, appUserId, primary, pending, targetAuth, enrollmentId: enrollment.id, attemptId: prepared.attempt.id, bodySha };
  }

  const commitInput = (w: Awaited<ReturnType<typeof blockedPendingRemoval>>, overrides: { failureReason?: string; bodySha?: string; receiptActivityId?: string } = {}) => ({
    appUserId: w.appUserId,
    attemptId: w.attemptId,
    targetCredentialId: w.pending,
    targetTurnkeyAuthenticatorId: w.targetAuth,
    expected: { turnkeyActivityId: null, turnkeyActivityStatus: null, failureReason: overrides.failureReason ?? "no_activity_receipt" },
    receipt: { activityId: overrides.receiptActivityId ?? id("activity", w.attemptId), source: "stored_attempt_body" as const, bodyAttemptId: w.attemptId, bodySha256: overrides.bodySha ?? w.bodySha, turnkeyCreatedAt: new Date().toISOString() },
    activityLogHeadId: "smoke-head",
    absenceFirstObservedAt: new Date().toISOString(),
    absenceLastObservedAt: new Date().toISOString(),
    survivorAuthenticatorIds: ["smoke-survivor"],
    resolverVersion: 1,
  });

  async function state(w: Awaited<ReturnType<typeof blockedPendingRemoval>>) {
    return {
      attempt: await w.s.revocations.findById(w.attemptId),
      target: (await w.s.registry.findPasskeyByCredentialId(w.pending))?.status,
      enrollment: (await w.s.backupEnrollments.findById(w.enrollmentId))?.state,
      rows: ((await w.sql`SELECT count(*)::int AS n FROM passkey_revocation_resolutions WHERE revocation_attempt_id = ${w.attemptId}`) as Array<{ n: number }>)[0]!.n,
    };
  }

  afterAll(async () => {
    if (!databaseUrl) return;
    const sql = await sqlFn();
    for (const appUserId of users) {
      await sql`DELETE FROM passkey_revocation_resolutions WHERE app_user_id = ${appUserId}`;
      await sql`DELETE FROM passkey_revocation_attempts WHERE app_user_id = ${appUserId}`;
      await sql`DELETE FROM backup_passkey_enrollments WHERE app_user_id = ${appUserId}`;
      await sql`DELETE FROM real_passkeys WHERE app_user_id = ${appUserId}`;
      await sql`DELETE FROM real_accounts WHERE app_user_id = ${appUserId}`;
    }
  });

  it("S3: loadSnapshot reads one consistent READ ONLY snapshot and never selects the stamp", async () => {
    const w = await blockedPendingRemoval("snapshot", { keepStamp: true });
    // Precondition: the sentinel really is in the row, so its absence below is meaningful.
    expect(((await w.sql`SELECT turnkey_request_stamp FROM passkey_revocation_attempts WHERE id = ${w.attemptId}`) as Array<{ turnkey_request_stamp: string }>)[0]!.turnkey_request_stamp).toBe(STAMP_SENTINEL);
    const snapshot = await w.s.resolution.loadSnapshot({ appUserId: w.appUserId, attemptId: w.attemptId });
    expect(snapshot).toMatchObject({ attempt: { state: "blocked", failureReason: "no_activity_receipt" }, hasNewerNonCancelledAttempt: false, targetPasskey: { status: "revoking" }, targetEnrollments: [{ state: "removal_in_progress" }], existingResolutionId: null });
    // 1. The stamp's value never reaches the snapshot.
    expect(JSON.stringify(snapshot)).not.toContain(STAMP_SENTINEL);
    // 2. No attempt row in the snapshot even has a stamp field.
    for (const row of [snapshot!.attempt, ...snapshot!.targetAttempts]) expect(Object.keys(row)).not.toContain("turnkeyRequestStamp");
  });

  it("S3: the commit — attempt blocked -> confirmed (own fields untouched), target revoked, enrollment removed (slot freed), one audit row; a second commit changes nothing", async () => {
    const w = await blockedPendingRemoval("commit");
    expect(await w.s.backupEnrollments.createStarted({ appUserId: w.appUserId })).toBeNull();
    const committed = await w.s.resolution.commitResolution(commitInput(w));
    expect(committed).toMatchObject({ outcome: "committed" });
    const after = await state(w);
    expect(after).toMatchObject({ attempt: { state: "confirmed", turnkeyActivityId: null, turnkeyActivityStatus: null, failureReason: "no_activity_receipt", turnkeyRequestBodySha256: w.bodySha }, target: "revoked", enrollment: "removed", rows: 1 });
    expect(await w.s.backupEnrollments.createStarted({ appUserId: w.appUserId })).toMatchObject({ state: "started" });
    expect(await w.s.resolution.commitResolution(commitInput(w))).toEqual({ outcome: "lost_race" });
    expect((await state(w)).rows).toBe(1);
  });

  it("S3: a lost CAS (own field changed, body hash wrong, newer attempt) rolls back COMPLETELY", async () => {
    for (const [label, tamper] of [
      ["failure reason", { failureReason: "tampered" }],
      ["body hash", { bodySha: "0".repeat(64) }],
    ] as const) {
      const w = await blockedPendingRemoval(`lost-${label.replace(/\s/g, "-")}`);
      const before = await state(w);
      expect(await w.s.resolution.commitResolution(commitInput(w, tamper)), label).toEqual({ outcome: "lost_race" });
      expect(await state(w), label).toEqual(before);
    }
    const w = await blockedPendingRemoval("lost-newer");
    await w.s.revocations.prepare({ appUserId: w.appUserId, targetCredentialId: w.pending, authorizerCredentialId: w.primary });
    const before = await state(w);
    expect(await w.s.resolution.commitResolution(commitInput(w))).toEqual({ outcome: "lost_race" });
    expect(await state(w)).toEqual(before);
  });

  it("S3: two concurrent operator commits under the real account lock => exactly one committed, one audit row", async () => {
    const w = await blockedPendingRemoval("double");
    const results = await Promise.all([w.s.resolution.commitResolution(commitInput(w)), w.s.resolution.commitResolution(commitInput(w))]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["committed", "lost_race"]);
    expect((await state(w)).rows).toBe(1);
  });

  it("S3: a user retry's prepare racing the commit on the real account row => one consistent winner", async () => {
    const w = await blockedPendingRemoval("retry-race");
    const retry = await w.s.revocations.prepare({ appUserId: w.appUserId, targetCredentialId: w.pending, authorizerCredentialId: w.primary });
    if (!retry.ok) throw new Error("setup");
    // The prepared retry alone already blocks resolution (newer non-cancelled attempt):
    expect(await w.s.resolution.commitResolution(commitInput(w))).toEqual({ outcome: "lost_race" });
    await w.s.revocations.transition({ id: retry.attempt.id, from: "authorization_needed", to: "cancelled" });
    const [committed, retried] = await Promise.all([
      w.s.resolution.commitResolution(commitInput(w)),
      w.s.revocations.prepare({ appUserId: w.appUserId, targetCredentialId: w.pending, authorizerCredentialId: w.primary }),
    ]);
    const after = await state(w);
    if (committed.outcome === "committed") {
      expect(after).toMatchObject({ target: "revoked", enrollment: "removed", rows: 1 });
    } else {
      expect(retried.ok).toBe(true);
      expect(after).toMatchObject({ target: "revoking", enrollment: "removal_in_progress", rows: 0 });
    }
  });
});
