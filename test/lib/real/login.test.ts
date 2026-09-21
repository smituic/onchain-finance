import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, encodeAbiParameters, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import type { RealServerConfig } from "@/lib/real/server/config";
import { createInMemoryChallengeStore } from "@/lib/real/server/challenge-store";
import { createInMemoryRealAccountRegistry, type RealAccountRegistry } from "@/lib/real/server/registry";
import { createInMemoryRegistrationAttemptStore, type RegistrationAttemptStore } from "@/lib/real/server/registration-attempts";
import { parseSession } from "@/lib/real/server/session";
import { bytesToBase64Url } from "@/lib/real/bytes";
import { buildAuthenticationResponseJSON, buildRegistrationResponseJSON, createFixtureAuthenticator, type FixtureAuthenticator } from "./fixtures/webauthn";

const createSubOrganizationMock = vi.fn();
const getWalletAccountsMock = vi.fn();
const getSubOrgIdsMock = vi.fn();
const getUsersMock = vi.fn();

vi.mock("@turnkey/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@turnkey/http")>();
  return {
    ...actual,
    TurnkeyClient: vi.fn().mockImplementation(function TurnkeyClientMock() {
      return {
        createSubOrganization: createSubOrganizationMock,
        getWalletAccounts: getWalletAccountsMock,
        getSubOrgIds: getSubOrgIdsMock,
        getUsers: getUsersMock,
      };
    }),
  };
});

const { beginRegistration, completeRegistration } = await import("@/lib/real/server/registration");
const { beginLogin, completeLogin } = await import("@/lib/real/server/login");

const ORIGIN = "http://localhost:3000";
const config: RealServerConfig = {
  turnkeyApiBaseUrl: "https://api.turnkey.com",
  turnkeyParentOrganizationId: "parent-org",
  turnkeyApiPublicKey: "pub",
  turnkeyApiPrivateKey: "priv",
  sessionSecret: "test-secret",
  rpId: "localhost",
  rpName: "Test",
  expectedOrigins: [ORIGIN],
  rpcUrl: "https://sepolia.base.org",
};

const USER_HANDLE = "user-handle-1";

function newAttempts(): RegistrationAttemptStore {
  return createInMemoryRegistrationAttemptStore();
}

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

async function seedRegistry(authenticator: FixtureAuthenticator, userHandle = USER_HANDLE): Promise<RealAccountRegistry> {
  const registry = createInMemoryRealAccountRegistry();
  await registry.createAccountWithPasskey({
    account: {
      appUserId: "app-user-1",
      subOrganizationId: "sub-org-1",
      turnkeyUserId: "turnkey-user-1",
      walletId: "wallet-1",
      walletAccountId: "wallet-account-1",
      ownerAddress: "0xF6C3FE6DE636f0d8f421d5485D1a64fF3628CFaF",
      safeAddress: "0xd9a4c22fb34dc74317edc8006140d66c8fa03266",
      accountConfigVersion: 1,
    },
    passkey: {
      credentialId: authenticator.credentialIdBase64Url,
      appUserId: "app-user-1",
      credentialPublicKey: bytesToBase64Url(authenticator.publicKeyCose),
      userHandle,
      counter: authenticator.counter,
      transports: ["internal"],
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
    },
  });
  return registry;
}

describe("login (fresh-device restore) flow: beginLogin -> completeLogin", () => {
  it("a valid assertion from a registered, discoverable passkey restores the session — never touches Turnkey", async () => {
    const authenticator = createFixtureAuthenticator();
    const registry = await seedRegistry(authenticator);
    const challengeStore = createInMemoryChallengeStore();
    const attempts = newAttempts();

    const { optionsJSON } = await beginLogin({ config, challengeStore });
    const response = buildAuthenticationResponseJSON({
      authenticator,
      challenge: optionsJSON.challenge,
      origin: ORIGIN,
      rpId: config.rpId,
      userHandle: USER_HANDLE,
    });

    const result = await completeLogin({ config, challengeStore, registry, attempts, response });

    expect(result.outcome).toBe("verified");
    if (result.outcome !== "verified") return;
    expect(result.account.appUserId).toBe("app-user-1");
    expect(result.account.safeAddress).toBe("0xd9a4c22fb34dc74317edc8006140d66c8fa03266");

    const session = parseSession(result.sessionCookie, config.sessionSecret);
    expect(session?.appUserId).toBe("app-user-1");
    expect(session?.credentialId).toBe(authenticator.credentialIdBase64Url);
    expect(result.sessionCookie).not.toMatch(/subOrganization|walletId|ownerAddress|safeAddress/i);
  });

  it("uses no allowCredentials — the discoverable-credential flow that makes fresh-device restore possible", async () => {
    const challengeStore = createInMemoryChallengeStore();
    const { optionsJSON } = await beginLogin({ config, challengeStore });
    expect(optionsJSON.allowCredentials === undefined || optionsJSON.allowCredentials.length === 0).toBe(true);
  });

  it("rejects an unknown credential", async () => {
    const registeredAuthenticator = createFixtureAuthenticator();
    const registry = await seedRegistry(registeredAuthenticator);
    const unknownAuthenticator = createFixtureAuthenticator();
    const challengeStore = createInMemoryChallengeStore();
    const attempts = newAttempts();

    const { optionsJSON } = await beginLogin({ config, challengeStore });
    const response = buildAuthenticationResponseJSON({ authenticator: unknownAuthenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId });

    const result = await completeLogin({ config, challengeStore, registry, attempts, response });
    expect(result.outcome).toBe("rejected");
  });

  it("rejects an unknown/never-issued challenge", async () => {
    const authenticator = createFixtureAuthenticator();
    const registry = await seedRegistry(authenticator);
    const challengeStore = createInMemoryChallengeStore();
    const attempts = newAttempts();
    const response = buildAuthenticationResponseJSON({ authenticator, challenge: "never-issued", origin: ORIGIN, rpId: config.rpId, userHandle: USER_HANDLE });

    const result = await completeLogin({ config, challengeStore, registry, attempts, response });
    expect(result.outcome).toBe("rejected");
  });

  it("rejects an expired challenge", async () => {
    const authenticator = createFixtureAuthenticator();
    const registry = await seedRegistry(authenticator);
    const challengeStore = createInMemoryChallengeStore();
    const attempts = newAttempts();
    const { optionsJSON } = await beginLogin({ config, challengeStore });
    // Immediately expire it by consuming and re-recording with a negative TTL.
    await challengeStore.consume({ challenge: optionsJSON.challenge, purpose: "login" });
    await challengeStore.create({ challenge: optionsJSON.challenge, purpose: "login", ttlMs: -1 });

    const response = buildAuthenticationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId, userHandle: USER_HANDLE });
    const result = await completeLogin({ config, challengeStore, registry, attempts, response });
    expect(result.outcome).toBe("rejected");
  });

  it("rejects a replayed challenge — the second completeLogin for the same challenge is rejected", async () => {
    const authenticator = createFixtureAuthenticator();
    const registry = await seedRegistry(authenticator);
    const challengeStore = createInMemoryChallengeStore();
    const attempts = newAttempts();
    const { optionsJSON } = await beginLogin({ config, challengeStore });
    const response = buildAuthenticationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId, userHandle: USER_HANDLE });

    const first = await completeLogin({ config, challengeStore, registry, attempts, response });
    expect(first.outcome).toBe("verified");

    const second = await completeLogin({ config, challengeStore, registry, attempts, response });
    expect(second.outcome).toBe("rejected");
  });

  it("rejects an invalid signature (wrong key for the registered credential)", async () => {
    const registered = createFixtureAuthenticator();
    const impostor = createFixtureAuthenticator({ credentialId: registered.credentialId });
    const registry = await seedRegistry(registered);
    const challengeStore = createInMemoryChallengeStore();
    const attempts = newAttempts();
    const { optionsJSON } = await beginLogin({ config, challengeStore });
    const response = buildAuthenticationResponseJSON({ authenticator: impostor, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId, userHandle: USER_HANDLE });

    const result = await completeLogin({ config, challengeStore, registry, attempts, response });
    expect(result.outcome).toBe("rejected");
  });

  it("rejects a wrong-origin assertion", async () => {
    const authenticator = createFixtureAuthenticator();
    const registry = await seedRegistry(authenticator);
    const challengeStore = createInMemoryChallengeStore();
    const attempts = newAttempts();
    const { optionsJSON } = await beginLogin({ config, challengeStore });
    const response = buildAuthenticationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: "http://evil.example", rpId: config.rpId, userHandle: USER_HANDLE });

    const result = await completeLogin({ config, challengeStore, registry, attempts, response });
    expect(result.outcome).toBe("rejected");
  });

  it("rejects a userHandle mismatch even though the credentialId and signature are both valid", async () => {
    const authenticator = createFixtureAuthenticator();
    const registry = await seedRegistry(authenticator, USER_HANDLE);
    const challengeStore = createInMemoryChallengeStore();
    const attempts = newAttempts();
    const { optionsJSON } = await beginLogin({ config, challengeStore });
    const response = buildAuthenticationResponseJSON({
      authenticator,
      challenge: optionsJSON.challenge,
      origin: ORIGIN,
      rpId: config.rpId,
      userHandle: "a-different-user-handle",
    });

    const result = await completeLogin({ config, challengeStore, registry, attempts, response });
    expect(result.outcome).toBe("rejected");
  });

  it("rejects when userHandle is missing entirely from the assertion", async () => {
    const authenticator = createFixtureAuthenticator();
    const registry = await seedRegistry(authenticator);
    const challengeStore = createInMemoryChallengeStore();
    const attempts = newAttempts();
    const { optionsJSON } = await beginLogin({ config, challengeStore });
    const response = buildAuthenticationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId });

    const result = await completeLogin({ config, challengeStore, registry, attempts, response });
    expect(result.outcome).toBe("rejected");
  });

  it("a revoked passkey can no longer log in", async () => {
    const authenticator = createFixtureAuthenticator();
    const registry = await seedRegistry(authenticator);
    await registry.revokePasskey(authenticator.credentialIdBase64Url);
    const challengeStore = createInMemoryChallengeStore();
    const attempts = newAttempts();
    const { optionsJSON } = await beginLogin({ config, challengeStore });
    const response = buildAuthenticationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId, userHandle: USER_HANDLE });

    const result = await completeLogin({ config, challengeStore, registry, attempts, response });
    expect(result.outcome).toBe("rejected");
  });

  it("zero-counter authenticators are accepted repeatedly (matches @simplewebauthn/server semantics, not an invented stricter rule)", async () => {
    const authenticator = createFixtureAuthenticator({ counter: 0 });
    const registry = await seedRegistry(authenticator);
    const challengeStore = createInMemoryChallengeStore();
    const attempts = newAttempts();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { optionsJSON } = await beginLogin({ config, challengeStore });
      const response = buildAuthenticationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId, userHandle: USER_HANDLE });
      const result = await completeLogin({ config, challengeStore, registry, attempts, response });
      expect(result.outcome).toBe("verified");
    }

    expect((await registry.findPasskeyByCredentialId(authenticator.credentialIdBase64Url))?.counter).toBe(0);
  });

  it("persists an advanced counter after a successful login", async () => {
    const authenticator = createFixtureAuthenticator({ counter: 5 });
    const registry = await seedRegistry(authenticator);
    const challengeStore = createInMemoryChallengeStore();
    const attempts = newAttempts();
    const { optionsJSON } = await beginLogin({ config, challengeStore });
    const response = buildAuthenticationResponseJSON({
      authenticator,
      challenge: optionsJSON.challenge,
      origin: ORIGIN,
      rpId: config.rpId,
      userHandle: USER_HANDLE,
      counterOverride: 6,
    });

    const result = await completeLogin({ config, challengeStore, registry, attempts, response });
    expect(result.outcome).toBe("verified");
    expect((await registry.findPasskeyByCredentialId(authenticator.credentialIdBase64Url))?.counter).toBe(6);
  });

  it("a counter regression is rejected when the stored counter is nonzero — payment-time signing advancing the counter between app logins is still a valid gap forward, never backward", async () => {
    const authenticator = createFixtureAuthenticator({ counter: 5 });
    const registry = await seedRegistry(authenticator);
    const challengeStore = createInMemoryChallengeStore();
    const attempts = newAttempts();
    const { optionsJSON } = await beginLogin({ config, challengeStore });
    const response = buildAuthenticationResponseJSON({
      authenticator,
      challenge: optionsJSON.challenge,
      origin: ORIGIN,
      rpId: config.rpId,
      userHandle: USER_HANDLE,
      counterOverride: 3,
    });

    const result = await completeLogin({ config, challengeStore, registry, attempts, response });
    expect(result.outcome).toBe("rejected");
  });

  it("rotates: two successful logins issue two different session cookies", async () => {
    const authenticator = createFixtureAuthenticator();
    const registry = await seedRegistry(authenticator);
    const challengeStore = createInMemoryChallengeStore();
    const attempts = newAttempts();

    const { optionsJSON: first } = await beginLogin({ config, challengeStore });
    const firstResult = await completeLogin({
      config,
      challengeStore,
      registry,
      attempts,
      response: buildAuthenticationResponseJSON({ authenticator, challenge: first.challenge, origin: ORIGIN, rpId: config.rpId, userHandle: USER_HANDLE }),
    });

    const { optionsJSON: second } = await beginLogin({ config, challengeStore });
    const secondResult = await completeLogin({
      config,
      challengeStore,
      registry,
      attempts,
      response: buildAuthenticationResponseJSON({ authenticator, challenge: second.challenge, origin: ORIGIN, rpId: config.rpId, userHandle: USER_HANDLE }),
    });

    expect(firstResult.outcome).toBe("verified");
    expect(secondResult.outcome).toBe("verified");
    if (firstResult.outcome !== "verified" || secondResult.outcome !== "verified") return;
    expect(firstResult.sessionCookie).not.toBe(secondResult.sessionCookie);
  });
});

describe("login recovers a pending (not-yet-active) registration attempt", () => {
  afterEach(() => {
    createSubOrganizationMock.mockReset();
    getWalletAccountsMock.mockReset();
    getSubOrgIdsMock.mockReset();
    getUsersMock.mockReset();
  });

  it("a valid app-WebAuthn login assertion for a credential stuck in 'provisioning' independently re-verifies, reconciles via Turnkey discovery, finalizes the account, and issues a session — without a second WebAuthn registration ceremony", async () => {
    // Simulate the exact crash window: WebAuthn verified and durably
    // pre-committed, Turnkey createSubOrganization failed/unknown, so the
    // attempt is stuck in "provisioning_in_flight" with no active registry record.
    createSubOrganizationMock.mockRejectedValue(new Error("Turnkey unreachable"));
    const registry = createInMemoryRealAccountRegistry();
    const challengeStore = createInMemoryChallengeStore();
    const attempts = newAttempts();
    const authenticator = createFixtureAuthenticator();

    const { optionsJSON: regOptions } = await beginRegistration({ config, challengeStore });
    const regResponse = buildRegistrationResponseJSON({ authenticator, challenge: regOptions.challenge, origin: ORIGIN, rpId: config.rpId });
    const regResult = await completeRegistration({ config, challengeStore, registry, attempts, response: regResponse });
    expect(regResult.outcome).toBe("pending");
    const provisioningAttempt = await attempts.findByCredentialId(authenticator.credentialIdBase64Url);
    expect(provisioningAttempt?.state).toBe("provisioning_in_flight");
    expect(await registry.findPasskeyByCredentialId(authenticator.credentialIdBase64Url)).toBeNull();

    // Now Turnkey discovery finds the (previously ambiguous/unknown) child
    // was in fact created — recovery via a normal login assertion.
    const ownerAddress = "0xF6C3FE6DE636f0d8f421d5485D1a64fF3628CFaF";
    getSubOrgIdsMock.mockResolvedValue({ organizationIds: ["sub-org-1"] });
    getUsersMock.mockResolvedValue({ users: [{ userId: "turnkey-user-1", authenticators: [{ authenticatorId: "auth-1", credentialId: authenticator.credentialIdBase64Url }] }] });
    getWalletAccountsMock.mockResolvedValue({ accounts: [{ address: ownerAddress, walletId: "wallet-1", walletAccountId: "wallet-account-1" }] });

    const { optionsJSON: loginOptions } = await beginLogin({ config, challengeStore });
    const loginResponse = buildAuthenticationResponseJSON({
      authenticator,
      challenge: loginOptions.challenge,
      origin: ORIGIN,
      rpId: config.rpId,
      userHandle: provisioningAttempt!.userHandle,
    });

    const loginResult = await completeLogin({ config, challengeStore, registry, attempts, response: loginResponse, publicClient: buildPublicClient() });

    expect(loginResult.outcome).toBe("verified");
    if (loginResult.outcome !== "verified") return;
    expect(loginResult.account.ownerAddress).toBe(ownerAddress);
    expect(loginResult.sessionCookie).toBeTruthy();
    expect((await attempts.findByCredentialId(authenticator.credentialIdBase64Url))?.state).toBe("active");
    expect((await registry.findPasskeyByCredentialId(authenticator.credentialIdBase64Url))?.status).toBe("active");
    // No second WebAuthn registration ceremony — createSubOrganization was
    // never called a second time either (discovery found the existing child).
    expect(createSubOrganizationMock).toHaveBeenCalledTimes(1);
  });

  it("a zero-match Turnkey discovery after a lost response leaves the attempt unresolved — repeated recovery attempts never trigger a second createSubOrganization call, even after several zero-match reads", async () => {
    createSubOrganizationMock.mockRejectedValue(new Error("Turnkey unreachable"));
    const registry = createInMemoryRealAccountRegistry();
    const challengeStore = createInMemoryChallengeStore();
    const attempts = newAttempts();
    const authenticator = createFixtureAuthenticator();

    const { optionsJSON: regOptions } = await beginRegistration({ config, challengeStore });
    const regResponse = buildRegistrationResponseJSON({ authenticator, challenge: regOptions.challenge, origin: ORIGIN, rpId: config.rpId });
    const regResult = await completeRegistration({ config, challengeStore, registry, attempts, response: regResponse });
    expect(regResult.outcome).toBe("pending");
    expect(createSubOrganizationMock).toHaveBeenCalledTimes(1);

    // Discovery genuinely finds nothing yet — Turnkey's own consistency
    // guarantee doesn't rule out this being stale, so this must NEVER be
    // treated as proof the earlier call failed.
    getSubOrgIdsMock.mockResolvedValue({ organizationIds: [] });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const provisioningAttempt = await attempts.findByCredentialId(authenticator.credentialIdBase64Url);
      const { optionsJSON: loginOptions } = await beginLogin({ config, challengeStore });
      const loginResponse = buildAuthenticationResponseJSON({
        authenticator,
        challenge: loginOptions.challenge,
        origin: ORIGIN,
        rpId: config.rpId,
        userHandle: provisioningAttempt!.userHandle,
      });

      const loginResult = await completeLogin({ config, challengeStore, registry, attempts, response: loginResponse });

      expect(loginResult.outcome).toBe("pending");
      const attemptAfter = await attempts.findByCredentialId(authenticator.credentialIdBase64Url);
      expect(attemptAfter?.state).toBe("provisioning_in_flight");
      expect(attemptAfter?.externalOutcome).toBe("unknown");
    }

    // Across every retry: exactly the ONE original createSubOrganization
    // call, never a second — the invariant this fix exists to enforce.
    expect(createSubOrganizationMock).toHaveBeenCalledTimes(1);
    expect(getSubOrgIdsMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(await registry.findPasskeyByCredentialId(authenticator.credentialIdBase64Url)).toBeNull();
  });

  it("does NOT issue a session for a pending attempt before Turnkey discovery is reconciled (ambiguous discovery blocks instead)", async () => {
    createSubOrganizationMock.mockRejectedValue(new Error("Turnkey unreachable"));
    const registry = createInMemoryRealAccountRegistry();
    const challengeStore = createInMemoryChallengeStore();
    const attempts = newAttempts();
    const authenticator = createFixtureAuthenticator();

    const { optionsJSON: regOptions } = await beginRegistration({ config, challengeStore });
    const regResponse = buildRegistrationResponseJSON({ authenticator, challenge: regOptions.challenge, origin: ORIGIN, rpId: config.rpId });
    await completeRegistration({ config, challengeStore, registry, attempts, response: regResponse });
    const provisioningAttempt = await attempts.findByCredentialId(authenticator.credentialIdBase64Url);

    // Discovery finds the credential registered under two sub-orgs — ambiguous.
    getSubOrgIdsMock.mockResolvedValue({ organizationIds: ["sub-org-1", "sub-org-2"] });

    const { optionsJSON: loginOptions } = await beginLogin({ config, challengeStore });
    const loginResponse = buildAuthenticationResponseJSON({
      authenticator,
      challenge: loginOptions.challenge,
      origin: ORIGIN,
      rpId: config.rpId,
      userHandle: provisioningAttempt!.userHandle,
    });

    const loginResult = await completeLogin({ config, challengeStore, registry, attempts, response: loginResponse });

    expect(loginResult.outcome).toBe("blocked");
    expect((await attempts.findByCredentialId(authenticator.credentialIdBase64Url))?.state).toBe("blocked");
    expect(await registry.findPasskeyByCredentialId(authenticator.credentialIdBase64Url)).toBeNull();
  });
});

describe("login.ts source", () => {
  it("never imports Turnkey session-login primitives, Turnkey provisioning/discovery, or any @turnkey/* package at all — app login never talks to Turnkey", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const source = readFileSync(path.resolve(process.cwd(), "lib/real/server/login.ts"), "utf8");
    // Matches actual import specifiers, not the same names appearing in this
    // file's own explanatory comments about why they're absent (a naive
    // substring check fails on those comments — same lesson learned
    // elsewhere in this codebase, e.g. verified-account.test.ts's
    // @turnkey/viem check).
    expect(source).not.toMatch(/from\s+["']@turnkey\//);
    expect(source).not.toMatch(/from\s+["']\.\/turnkey-(provisioning|discovery)["']/);
  });
});
