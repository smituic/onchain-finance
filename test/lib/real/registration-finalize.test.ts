import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, encodeAbiParameters, getAddress, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { bytesToBase64Url, randomBytes } from "@/lib/real/bytes";
import type { RealServerConfig } from "@/lib/real/server/config";
import { DuplicateAccountError, IdentityConflictError, createInMemoryRealAccountRegistry, getInMemoryRegistryInternals, type RealAccountRecord, type RealAccountRegistry, type RealPasskeyRecord } from "@/lib/real/server/registry";
import {
  REGISTRATION_IDENTITY_CONFLICT_REASON,
  accountMatchesAttempt,
  createInMemoryRegistrationAttemptStore,
  type RegistrationAttempt,
  type RegistrationAttemptStore,
} from "@/lib/real/server/registration-attempts";
import { runProvisioningPipeline } from "@/lib/real/server/onboarding";
import { seedTurnkeyCreatedThroughEvidence } from "./fixtures/provisioning-seed";

/**
 * S5 L3: registration finalize atomicity (in-memory adapter) and the
 * accountMatchesAttempt reuse rule onboarding applies to every "active"
 * attempt. The Neon adapter's SQL is covered offline by
 * neon-registration-finalize.test.ts and live by the gated neon-smoke suite.
 */

const config: RealServerConfig = {
  turnkeyApiBaseUrl: "https://api.turnkey.com",
  turnkeyParentOrganizationId: "parent-org",
  turnkeyApiPublicKey: "pub",
  turnkeyApiPrivateKey: "priv",
  sessionSecret: "test-secret",
  rpId: "localhost",
  rpName: "Test",
  expectedOrigins: ["http://localhost:3000"],
  rpcUrl: "https://sepolia.base.org",
  pimlicoApiKey: "pim_test_key",
};

const DUMMY_BYTES_RETURN = encodeAbiParameters([{ type: "bytes" }], ["0x600a600c600039600a6000f3" as Hex]);
function buildPublicClient() {
  return createPublicClient({
    chain: baseSepolia,
    transport: custom({
      request: async ({ method }: { method: string }) => {
        if (method === "eth_getCode") return "0x";
        if (method === "eth_chainId") return `0x${baseSepolia.id.toString(16)}`;
        if (method === "eth_call") return DUMMY_BYTES_RETURN;
        throw new Error(`Unexpected public RPC call in an offline test: ${method}`);
      },
    }),
  });
}

let seq = 0;
const hex40 = (n: number, digit: string) => `0x${digit.repeat(39)}${(n % 10).toString()}`;

/** A durable attempt walked to turnkey_created through the store's own CAS transitions. Every identity value is unique per call. */
async function seedTurnkeyCreated(attempts: RegistrationAttemptStore): Promise<RegistrationAttempt> {
  seq += 1;
  const credentialId = bytesToBase64Url(randomBytes(16));
  await attempts.createVerified({
    credentialId,
    appUserId: `app-user-${seq}`,
    userHandle: `handle-${seq}`,
    credentialPublicKey: `cose-${seq}`,
    counter: 0,
    transports: ["internal"],
    credentialDeviceType: "singleDevice",
    credentialBackedUp: false,
    registrationChallenge: `challenge-${seq}`,
    rawClientDataJson: "client-data",
    rawAttestationObject: "attestation",
  });
  // "provisioning_in_flight" is claim-only: walk the production evidence path.
  return seedTurnkeyCreatedThroughEvidence(attempts, credentialId, {
    subOrganizationId: `sub-org-${seq}`,
    turnkeyUserId: `turnkey-user-${seq}`,
    walletId: `wallet-${seq}`,
    walletAccountId: `wallet-account-${seq}`,
    ownerAddress: getAddress(`0x${String(seq).padStart(40, "a")}`), // checksummed, mixed case
  });
}

function world() {
  const registry = createInMemoryRealAccountRegistry();
  const attempts = createInMemoryRegistrationAttemptStore();
  return { registry, attempts, internals: getInMemoryRegistryInternals(registry) };
}

function finalizeInput(registry: RealAccountRegistry, attempt: RegistrationAttempt, safeAddress = hex40(Number(attempt.appUserId.split("-").pop()), "5")) {
  return { credentialId: attempt.credentialId, registry, safeAddress, safeOwnerAddress: attempt.ownerAddress!, accountConfigVersion: 1 };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("in-memory finalize: never 'active' without its rows, never a partial row (S5 L3)", () => {
  it("createAccountWithPasskey throws BEFORE writing: the attempt is restored to the exact pre-claim turnkey_created object; no account, no passkey", async () => {
    const { registry, attempts, internals } = world();
    const attempt = await seedTurnkeyCreated(attempts);
    const before = await attempts.findByCredentialId(attempt.credentialId);
    vi.spyOn(registry, "createAccountWithPasskey").mockRejectedValueOnce(new Error("injected store failure"));

    await expect(attempts.finalize(finalizeInput(registry, attempt))).rejects.toThrow("injected store failure");

    const after = await attempts.findByCredentialId(attempt.credentialId);
    expect(after).toBe(before);
    expect(after?.state).toBe("turnkey_created");
    expect(internals.accountsByAppUserId.has(attempt.appUserId)).toBe(false);
    expect(internals.passkeysByCredentialId.has(attempt.credentialId)).toBe(false);
  });

  it("createAccountWithPasskey PARTIALLY writes (account + passkey) then throws: both partial rows are removed and the attempt restored", async () => {
    const { registry, attempts, internals } = world();
    const attempt = await seedTurnkeyCreated(attempts);
    const real = registry.createAccountWithPasskey.bind(registry);
    vi.spyOn(registry, "createAccountWithPasskey").mockImplementationOnce(async (input) => {
      await real(input); // both rows land...
      throw new Error("injected failure after write"); // ...then the call fails
    });

    await expect(attempts.finalize(finalizeInput(registry, attempt))).rejects.toThrow("injected failure after write");

    expect((await attempts.findByCredentialId(attempt.credentialId))?.state).toBe("turnkey_created");
    expect(internals.accountsByAppUserId.has(attempt.appUserId)).toBe(false);
    expect(internals.passkeysByCredentialId.has(attempt.credentialId)).toBe(false);
  });

  it("compensation only touches what THIS invocation wrote: a row another operation wrote meanwhile is left alone; a counter update made meanwhile survives the restore", async () => {
    const { registry, attempts, internals } = world();
    const attempt = await seedTurnkeyCreated(attempts);
    const foreignPasskey: RealPasskeyRecord = {
      credentialId: attempt.credentialId,
      appUserId: "some-other-account",
      credentialPublicKey: "other-cose",
      userHandle: "other-handle",
      counter: 0,
      transports: null,
      credentialDeviceType: null,
      credentialBackedUp: null,
      status: "pending",
      role: "backup",
      turnkeyAuthenticatorId: null,
      displayName: null,
      createdAt: new Date().toISOString(),
    };
    vi.spyOn(registry, "createAccountWithPasskey").mockImplementationOnce(async () => {
      internals.passkeysByCredentialId.set(attempt.credentialId, foreignPasskey);
      // "active" is finalize-only (S5 L2): the only other write that can touch
      // the claimed attempt is a counter update (login recovery).
      await attempts.updateCounter({ credentialId: attempt.credentialId, counter: 7 });
      throw new Error("injected");
    });

    await expect(attempts.finalize(finalizeInput(registry, attempt))).rejects.toThrow("injected");

    expect(internals.passkeysByCredentialId.get(attempt.credentialId)).toBe(foreignPasskey);
    expect(await attempts.findByCredentialId(attempt.credentialId)).toMatchObject({ state: "turnkey_created", counter: 7, safeAddress: null, accountConfigVersion: null });
  });

  it("a clean finalize after either failure succeeds", async () => {
    for (const failure of ["before-write", "after-write"] as const) {
      const { registry, attempts, internals } = world();
      const attempt = await seedTurnkeyCreated(attempts);
      const real = registry.createAccountWithPasskey.bind(registry);
      vi.spyOn(registry, "createAccountWithPasskey").mockImplementationOnce(async (input) => {
        if (failure === "after-write") await real(input);
        throw new Error("injected");
      });
      await expect(attempts.finalize(finalizeInput(registry, attempt))).rejects.toThrow("injected");

      const finalized = await attempts.finalize(finalizeInput(registry, attempt));
      expect(finalized, failure).not.toBeNull();
      const active = await attempts.findByCredentialId(attempt.credentialId);
      expect(active?.state).toBe("active");
      expect(accountMatchesAttempt(active!, finalized!.account, finalized!.passkey)).toBe(true);
      expect(internals.accountsByAppUserId.size).toBe(1);
      expect(internals.passkeysByCredentialId.size).toBe(1);
    }
  });

  it("five concurrent finalize calls: exactly one wins; one account, one passkey, and a consistent active attempt", async () => {
    const { registry, attempts, internals } = world();
    const attempt = await seedTurnkeyCreated(attempts);

    const results = await Promise.all(Array.from({ length: 5 }, () => attempts.finalize(finalizeInput(registry, attempt))));

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(internals.accountsByAppUserId.size).toBe(1);
    expect(internals.passkeysByCredentialId.size).toBe(1);
    const active = await attempts.findByCredentialId(attempt.credentialId);
    const winner = results.find((result) => result !== null)!;
    expect(accountMatchesAttempt(active!, winner.account, winner.passkey)).toBe(true);
  });

  it("a replay after success returns null and writes nothing", async () => {
    const { registry, attempts, internals } = world();
    const attempt = await seedTurnkeyCreated(attempts);
    expect(await attempts.finalize(finalizeInput(registry, attempt))).not.toBeNull();
    const account = internals.accountsByAppUserId.get(attempt.appUserId);

    expect(await attempts.finalize(finalizeInput(registry, attempt, hex40(0, "9")))).toBeNull();
    expect(internals.accountsByAppUserId.get(attempt.appUserId)).toBe(account);
    expect(internals.accountsByAppUserId.size).toBe(1);
  });

  it("a blocked (or otherwise non-turnkey_created) attempt finalizes to null with no rows", async () => {
    const { registry, attempts, internals } = world();
    const attempt = await seedTurnkeyCreated(attempts);
    await attempts.transition({ credentialId: attempt.credentialId, from: "turnkey_created", to: "blocked", patch: { blockReason: "review" } });

    expect(await attempts.finalize(finalizeInput(registry, attempt))).toBeNull();
    expect(internals.accountsByAppUserId.size).toBe(0);
    expect(internals.passkeysByCredentialId.size).toBe(0);
  });

  it("S5 L2: another account already holding the sub-org, owner, or Safe — in any letter case — BLOCKS the attempt (turnkey_created -> blocked); zero new rows", async () => {
    const cases: Array<[string, (holder: RegistrationAttempt, target: RegistrationAttempt, registry: RealAccountRegistry) => Promise<void>]> = [
      ["sub-org (upper-cased)", async (holder, target, registry) => void (await registry.createAccountWithPasskey(holderRecords(holder, { subOrganizationId: target.subOrganizationId!.toUpperCase() })))],
      ["sub-org (exact)", async (holder, target, registry) => void (await registry.createAccountWithPasskey(holderRecords(holder, { subOrganizationId: target.subOrganizationId! })))],
      ["owner (lower-cased)", async (holder, target, registry) => void (await registry.createAccountWithPasskey(holderRecords(holder, { ownerAddress: target.ownerAddress!.toLowerCase() })))],
      ["owner (upper-cased hex)", async (holder, target, registry) => void (await registry.createAccountWithPasskey(holderRecords(holder, { ownerAddress: `0x${target.ownerAddress!.slice(2).toUpperCase()}` })))],
      ["safe (upper-cased)", async (holder, _target, registry) => void (await registry.createAccountWithPasskey(holderRecords(holder, { safeAddress: "0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD" })))],
    ];
    for (const [name, seedConflict] of cases) {
      const { registry, attempts, internals } = world();
      const holder = await seedTurnkeyCreated(attempts);
      const target = await seedTurnkeyCreated(attempts);
      await seedConflict(holder, target, registry);
      // A COMMITTED conflict is caught before the claim — no write is even attempted (Neon: the block statement precedes the CAS).
      const write = vi.spyOn(registry, "createAccountWithPasskey");

      expect(await attempts.finalize(finalizeInput(registry, target, "0xdddddddddddddddddddddddddddddddddddddddd")), name).toBeNull();
      expect(write, name).not.toHaveBeenCalled();
      write.mockRestore();
      expect(await attempts.findByCredentialId(target.credentialId), name).toMatchObject({ state: "blocked", blockReason: REGISTRATION_IDENTITY_CONFLICT_REASON, safeAddress: null });
      expect(internals.accountsByAppUserId.has(target.appUserId), name).toBe(false);
      expect(internals.passkeysByCredentialId.has(target.credentialId), name).toBe(false);
      expect(internals.accountsByAppUserId.size, name).toBe(1);
      // Blocked is terminal for finalize: a retry writes nothing.
      expect(await attempts.finalize(finalizeInput(registry, target, "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")), name).toBeNull();
      expect(internals.accountsByAppUserId.size, name).toBe(1);
    }
  });

  it("the credential already being taken is NOT an identity conflict: null, attempt untouched (turnkey_created), nothing written", async () => {
    const { registry, attempts, internals } = world();
    const holder = await seedTurnkeyCreated(attempts);
    const target = await seedTurnkeyCreated(attempts);
    await registry.createAccountWithPasskey({ ...holderRecords(holder, {}), passkey: { ...holderRecords(holder, {}).passkey, credentialId: target.credentialId } });

    expect(await attempts.finalize(finalizeInput(registry, target))).toBeNull();
    expect((await attempts.findByCredentialId(target.credentialId))?.state).toBe("turnkey_created");
    expect(internals.accountsByAppUserId.size).toBe(1);
  });

  it("S5 L2: a concurrent identity conflict the pre-check could not see (the registry — the unique indexes' twin — refuses) blocks the attempt; zero rows", async () => {
    const { registry, attempts, internals } = world();
    const attempt = await seedTurnkeyCreated(attempts);
    vi.spyOn(registry, "createAccountWithPasskey").mockRejectedValueOnce(new IdentityConflictError(attempt.appUserId));

    expect(await attempts.finalize(finalizeInput(registry, attempt))).toBeNull();

    expect(await attempts.findByCredentialId(attempt.credentialId)).toMatchObject({ state: "blocked", blockReason: REGISTRATION_IDENTITY_CONFLICT_REASON });
    expect(internals.accountsByAppUserId.size).toBe(0);
    expect(internals.passkeysByCredentialId.size).toBe(0);
  });

  it("S5 L2: an unrelated store error is NOT mislabeled as an identity conflict — thrown, attempt restored to turnkey_created, not blocked", async () => {
    for (const error of [new DuplicateAccountError("x"), new Error("connection reset")]) {
      const { registry, attempts } = world();
      const attempt = await seedTurnkeyCreated(attempts);
      vi.spyOn(registry, "createAccountWithPasskey").mockRejectedValueOnce(error);

      await expect(attempts.finalize(finalizeInput(registry, attempt))).rejects.toBe(error);
      expect((await attempts.findByCredentialId(attempt.credentialId))?.state).toBe("turnkey_created");
    }
  });
});

describe("S5 L2: the Safe is bound to the owner it was derived from", () => {
  it("Safe derived from owner A, attempt owner still A (any letter case) -> finalize works", async () => {
    for (const spell of [(a: string) => a, (a: string) => a.toLowerCase(), (a: string) => `0x${a.slice(2).toUpperCase()}`]) {
      const { registry, attempts } = world();
      const attempt = await seedTurnkeyCreated(attempts);
      expect(await attempts.finalize({ ...finalizeInput(registry, attempt), safeOwnerAddress: spell(attempt.ownerAddress!) })).not.toBeNull();
    }
  });

  it("Safe derived from owner A, but the locked attempt's owner is now B -> the CAS loses: null, zero rows, attempt untouched", async () => {
    const { registry, attempts, internals } = world();
    const attempt = await seedTurnkeyCreated(attempts);
    const ownerA = getAddress(`0x${"a".repeat(39)}1`);
    expect(ownerA.toLowerCase()).not.toBe(attempt.ownerAddress!.toLowerCase());

    expect(await attempts.finalize({ ...finalizeInput(registry, attempt), safeOwnerAddress: ownerA })).toBeNull();

    expect(await attempts.findByCredentialId(attempt.credentialId)).toMatchObject({ state: "turnkey_created", safeAddress: null });
    expect(internals.accountsByAppUserId.size).toBe(0);
    expect(internals.passkeysByCredentialId.size).toBe(0);
  });

  it("a stale owner never blocks on an identity conflict either (the Safe comparison would be about the wrong owner)", async () => {
    const { registry, attempts, internals } = world();
    const holder = await seedTurnkeyCreated(attempts);
    const target = await seedTurnkeyCreated(attempts);
    await registry.createAccountWithPasskey(holderRecords(holder, { safeAddress: "0xdddddddddddddddddddddddddddddddddddddddd" }));

    expect(await attempts.finalize({ ...finalizeInput(registry, target, "0xdddddddddddddddddddddddddddddddddddddddd"), safeOwnerAddress: getAddress(`0x${"a".repeat(39)}1`) })).toBeNull();
    expect((await attempts.findByCredentialId(target.credentialId))?.state).toBe("turnkey_created");
    expect(internals.accountsByAppUserId.size).toBe(1);
  });

  it("onboarding: the owner changes WHILE the Safe is being derived -> finalize is bound to the owner it derived from: no rows, 'pending', never a session", async () => {
    const { registry, attempts, internals } = world();
    const attempt = await seedTurnkeyCreated(attempts);
    const ownerB = getAddress(`0x${"b".repeat(39)}2`);
    let moved = false;
    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: custom({
        request: async ({ method }: { method: string }) => {
          // Mid-derivation (network reads), the attempt's owner moves.
          if (!moved) {
            moved = true;
            await attempts.transition({ credentialId: attempt.credentialId, from: "turnkey_created", to: "turnkey_created", patch: { ownerAddress: ownerB } });
          }
          if (method === "eth_getCode") return "0x";
          if (method === "eth_chainId") return `0x${baseSepolia.id.toString(16)}`;
          if (method === "eth_call") return DUMMY_BYTES_RETURN;
          throw new Error(`Unexpected public RPC call in an offline test: ${method}`);
        },
      }),
    });

    const result = await runProvisioningPipeline({ config, registry, attempts, attempt, publicClient });
    expect(moved).toBe(true);

    expect(result.outcome).toBe("pending");
    expect(internals.accountsByAppUserId.size).toBe(0);
    expect(internals.passkeysByCredentialId.size).toBe(0);
  });
});

describe("S5 L2: 'active' is finalize-only", () => {
  it("generic transition() cannot move turnkey_created -> active (throws; attempt unchanged; no rows)", async () => {
    const { attempts, internals } = world();
    const attempt = await seedTurnkeyCreated(attempts);
    await expect(attempts.transition({ credentialId: attempt.credentialId, from: "turnkey_created", to: "active" })).rejects.toThrow(/only through finalize/);
    expect((await attempts.findByCredentialId(attempt.credentialId))?.state).toBe("turnkey_created");
    expect(internals.accountsByAppUserId.size).toBe(0);
  });

  it("generic transition() cannot move an active attempt anywhere", async () => {
    const { registry, attempts } = world();
    const attempt = await seedTurnkeyCreated(attempts);
    expect(await attempts.finalize(finalizeInput(registry, attempt))).not.toBeNull();
    for (const to of ["verified", "provisioning_in_flight", "turnkey_created", "blocked", "active"] as const) {
      await expect(attempts.transition({ credentialId: attempt.credentialId, from: "active", to }), to).rejects.toThrow(/only through finalize/);
    }
    expect((await attempts.findByCredentialId(attempt.credentialId))?.state).toBe("active");
  });

  it("finalize remains the route to active", async () => {
    const { registry, attempts } = world();
    const attempt = await seedTurnkeyCreated(attempts);
    expect(await attempts.finalize(finalizeInput(registry, attempt))).not.toBeNull();
    expect((await attempts.findByCredentialId(attempt.credentialId))?.state).toBe("active");
  });
});

function holderRecords(attempt: RegistrationAttempt, overrides: Partial<RealAccountRecord>) {
  return {
    account: {
      appUserId: attempt.appUserId,
      subOrganizationId: attempt.subOrganizationId!,
      turnkeyUserId: attempt.turnkeyUserId!,
      walletId: attempt.walletId!,
      walletAccountId: attempt.walletAccountId!,
      ownerAddress: attempt.ownerAddress!,
      safeAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
      accountConfigVersion: 1,
      ...overrides,
    },
    passkey: {
      credentialId: attempt.credentialId,
      appUserId: attempt.appUserId,
      credentialPublicKey: attempt.credentialPublicKey,
      userHandle: attempt.userHandle,
      counter: 0,
      transports: null,
      credentialDeviceType: null,
      credentialBackedUp: null,
    },
  };
}

describe("accountMatchesAttempt: reuse requires an exact, field-for-field match (S5 L3)", () => {
  async function finalizedWorld() {
    const { registry, attempts } = world();
    const attempt = await seedTurnkeyCreated(attempts);
    const finalized = (await attempts.finalize(finalizeInput(registry, attempt)))!;
    const active = (await attempts.findByCredentialId(attempt.credentialId))!;
    return { active, account: finalized.account, passkey: finalized.passkey };
  }

  it("matches the rows finalize wrote, including a differently-encoded (padded standard base64) credential id for the same bytes", async () => {
    const { active, account, passkey } = await finalizedWorld();
    expect(accountMatchesAttempt(active, account, passkey)).toBe(true);
    const bytes = Buffer.from(passkey.credentialId, "base64url");
    expect(accountMatchesAttempt(active, account, { ...passkey, credentialId: bytes.toString("base64") })).toBe(true);
  });

  it("any single differing account field fails", async () => {
    const { active, account, passkey } = await finalizedWorld();
    const mutations: Array<Partial<RealAccountRecord>> = [
      { appUserId: "other" },
      { subOrganizationId: "other" },
      { turnkeyUserId: "other" },
      { walletId: "other" },
      { walletAccountId: "other" },
      { ownerAddress: account.ownerAddress.toLowerCase() },
      { safeAddress: "0x0000000000000000000000000000000000000001" },
      { accountConfigVersion: account.accountConfigVersion + 1 },
    ];
    for (const mutation of mutations) {
      expect(accountMatchesAttempt(active, { ...account, ...mutation }, passkey), JSON.stringify(mutation)).toBe(false);
    }
  });

  it("any single differing passkey field, a non-active status, or a non-primary role fails", async () => {
    const { active, account, passkey } = await finalizedWorld();
    const mutations: Array<Partial<RealPasskeyRecord>> = [
      { credentialId: bytesToBase64Url(randomBytes(16)) },
      { appUserId: "other" },
      { credentialPublicKey: "other-cose" },
      { userHandle: "other-handle" },
      { status: "revoked" },
      { status: "revoking" },
      { role: "backup" },
    ];
    for (const mutation of mutations) {
      expect(accountMatchesAttempt(active, account, { ...passkey, ...mutation }), JSON.stringify(mutation)).toBe(false);
    }
  });

  it("a non-active attempt never matches", async () => {
    const { active, account, passkey } = await finalizedWorld();
    expect(accountMatchesAttempt({ ...active, state: "turnkey_created" }, account, passkey)).toBe(false);
  });
});

describe("onboarding reuse: only an exactly matching account is ever resumed (S5 L3)", () => {
  async function activeWorld() {
    const { registry, attempts, internals } = world();
    const attempt = await seedTurnkeyCreated(attempts);
    await attempts.finalize(finalizeInput(registry, attempt));
    const active = (await attempts.findByCredentialId(attempt.credentialId))!;
    return { registry, attempts, internals, active };
  }

  it("an active attempt with its exact rows resumes (verified); nothing new is written", async () => {
    const { registry, attempts, internals, active } = await activeWorld();
    const result = await runProvisioningPipeline({ config, registry, attempts, attempt: active });
    expect(result.outcome).toBe("verified");
    if (result.outcome === "verified") expect(result.account).toBe(internals.accountsByAppUserId.get(active.appUserId));
    expect(internals.accountsByAppUserId.size).toBe(1);
    expect(internals.passkeysByCredentialId.size).toBe(1);
  });

  it("an active attempt whose account row differs is NOT reused — fails closed, no session", async () => {
    for (const field of ["subOrganizationId", "ownerAddress", "safeAddress", "walletAccountId"] as const) {
      const { registry, attempts, internals, active } = await activeWorld();
      const account = internals.accountsByAppUserId.get(active.appUserId)!;
      internals.accountsByAppUserId.set(active.appUserId, { ...account, [field]: `${account[field]}-tampered` });

      const result = await runProvisioningPipeline({ config, registry, attempts, attempt: active });
      expect(result.outcome, field).toBe("rejected");
      expect("sessionCookie" in result, field).toBe(false);
    }
  });

  it("an active attempt whose passkey differs (key, handle) or is no longer the active primary is NOT reused", async () => {
    const mutations: Array<Partial<RealPasskeyRecord>> = [{ credentialPublicKey: "tampered" }, { userHandle: "tampered" }, { status: "revoked" }];
    for (const mutation of mutations) {
      const { registry, attempts, internals, active } = await activeWorld();
      const passkey = internals.passkeysByCredentialId.get(active.credentialId)!;
      internals.passkeysByCredentialId.set(active.credentialId, { ...passkey, ...mutation });

      const result = await runProvisioningPipeline({ config, registry, attempts, attempt: active });
      expect(result.outcome, JSON.stringify(mutation)).toBe("rejected");
    }
  });

  it("an active attempt with no rows at all fails closed", async () => {
    const { registry, attempts, internals, active } = await activeWorld();
    internals.accountsByAppUserId.clear();
    expect((await runProvisioningPipeline({ config, registry, attempts, attempt: active })).outcome).toBe("rejected");
  });

  /** A store whose finalize loses to `race` (run first, as if by another request) and returns null — exercising onboarding's re-read. */
  function losingFinalize(attempts: RegistrationAttemptStore, race: (input: Parameters<RegistrationAttemptStore["finalize"]>[0]) => Promise<void>): RegistrationAttemptStore {
    return {
      ...attempts,
      async finalize(input) {
        await race(input);
        return null;
      },
    };
  }

  it("finalize returns null and the attempt is now blocked -> 'blocked' (never pending, never a session)", async () => {
    const { registry, attempts } = world();
    const attempt = await seedTurnkeyCreated(attempts);
    const store = losingFinalize(attempts, async ({ credentialId }) => {
      await attempts.transition({ credentialId, from: "turnkey_created", to: "blocked", patch: { blockReason: "needs review" } });
    });

    const result = await runProvisioningPipeline({ config, registry, attempts: store, attempt, publicClient: buildPublicClient() });
    expect(result).toEqual({ outcome: "blocked", reason: "needs review" });
  });

  it("finalize returns null because another call finished it: reused only when the rows match exactly", async () => {
    const { registry, attempts } = world();
    const attempt = await seedTurnkeyCreated(attempts);
    const store = losingFinalize(attempts, async (input) => void (await attempts.finalize(input)));

    const result = await runProvisioningPipeline({ config, registry, attempts: store, attempt, publicClient: buildPublicClient() });
    expect(result.outcome).toBe("verified");
  });

  it("finalize returns null, the attempt is active, but its account doesn't match -> fails closed (the old code returned any account for the appUserId)", async () => {
    const { registry, attempts, internals } = world();
    const attempt = await seedTurnkeyCreated(attempts);
    const store = losingFinalize(attempts, async (input) => {
      await attempts.finalize(input);
      const account = internals.accountsByAppUserId.get(attempt.appUserId)!;
      internals.accountsByAppUserId.set(attempt.appUserId, { ...account, subOrganizationId: "someone-elses-sub-org" });
    });

    const result = await runProvisioningPipeline({ config, registry, attempts: store, attempt, publicClient: buildPublicClient() });
    expect(result.outcome).toBe("rejected");
  });

  it("S5 L2: an identity conflict at finalize -> 'blocked' with the conflict reason; no account, no passkey, no session", async () => {
    const { registry, attempts, internals } = world();
    const holder = await seedTurnkeyCreated(attempts);
    const attempt = await seedTurnkeyCreated(attempts);
    await registry.createAccountWithPasskey(holderRecords(holder, { subOrganizationId: attempt.subOrganizationId! }));

    const result = await runProvisioningPipeline({ config, registry, attempts, attempt, publicClient: buildPublicClient() });

    expect(result).toEqual({ outcome: "blocked", reason: REGISTRATION_IDENTITY_CONFLICT_REASON });
    expect(internals.accountsByAppUserId.has(attempt.appUserId)).toBe(false);
    expect(internals.passkeysByCredentialId.has(attempt.credentialId)).toBe(false);
    // And it stays blocked on every later call.
    const blocked = (await attempts.findByCredentialId(attempt.credentialId))!;
    expect((await runProvisioningPipeline({ config, registry, attempts, attempt: blocked, publicClient: buildPublicClient() })).outcome).toBe("blocked");
  });

  it("finalize returns null and the attempt is still turnkey_created -> pending (unchanged semantics)", async () => {
    const { registry, attempts } = world();
    const attempt = await seedTurnkeyCreated(attempts);
    const store = losingFinalize(attempts, async () => {});

    const result = await runProvisioningPipeline({ config, registry, attempts: store, attempt, publicClient: buildPublicClient() });
    expect(result.outcome).toBe("pending");
  });
});
