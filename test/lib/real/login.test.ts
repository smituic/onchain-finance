import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, encodeAbiParameters, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import type { RealServerConfig } from "@/lib/real/server/config";
import { createInMemoryChallengeStore } from "@/lib/real/server/challenge-store";
import { createInMemoryRealAccountRegistry, type RealAccountRegistry } from "@/lib/real/server/registry";
import { REGISTRATION_IDENTITY_CONFLICT_REASON, createInMemoryRegistrationAttemptStore, type RegistrationAttempt, type RegistrationAttemptStore } from "@/lib/real/server/registration-attempts";
import { parseSession } from "@/lib/real/server/session";
import { readAuthenticatedRealAccount } from "@/lib/real/server/auth";
import { bytesToBase64Url } from "@/lib/real/bytes";
import { buildAuthenticationResponseJSON, buildRegistrationResponseJSON, createFixtureAuthenticator, type FixtureAuthenticator } from "./fixtures/webauthn";
import { FakeParentTurnkey } from "./fixtures/turnkey-parent-fake";

const getWalletAccountsMock = vi.fn();
const getSubOrgIdsMock = vi.fn();
const getUsersMock = vi.fn();

vi.mock("@turnkey/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@turnkey/http")>();
  return {
    ...actual,
    TurnkeyClient: vi.fn().mockImplementation(function TurnkeyClientMock() {
      return {
        getWalletAccounts: getWalletAccountsMock,
        getSubOrgIds: getSubOrgIdsMock,
        getUsers: getUsersMock,
      };
    }),
  };
});

const { beginRegistration, completeRegistration } = await import("@/lib/real/server/registration");
const { beginLogin, completeLogin } = await import("@/lib/real/server/login");
const { PROVISIONING_NEEDS_REVIEW_REASON } = await import("@/lib/real/server/onboarding");
const { TurnkeyClient } = await import("@turnkey/http");

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
  pimlicoApiKey: "pim_test_key",
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
    await registry.transitionPasskeyStatus({ credentialId: authenticator.credentialIdBase64Url, from: "active", to: "revoked" });
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

describe("S4: login and the account session epoch", () => {
  async function loginOnce(authenticator: FixtureAuthenticator, registry: RealAccountRegistry, challengeStore = createInMemoryChallengeStore()) {
    const { optionsJSON } = await beginLogin({ config, challengeStore });
    const response = buildAuthenticationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId, userHandle: USER_HANDLE });
    return completeLogin({ config, challengeStore, registry, attempts: newAttempts(), response });
  }
  const authed = (registry: RealAccountRegistry, cookieValue: string) => readAuthenticatedRealAccount({ cookieValue, sessionSecret: config.sessionSecret, registry });

  it("concurrent completion of the SAME assertion: exactly one session is issued (single-use challenge consumption)", async () => {
    const authenticator = createFixtureAuthenticator();
    const registry = await seedRegistry(authenticator);
    const challengeStore = createInMemoryChallengeStore();
    const { optionsJSON } = await beginLogin({ config, challengeStore });
    const response = buildAuthenticationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId, userHandle: USER_HANDLE });

    const results = await Promise.all([
      completeLogin({ config, challengeStore, registry, attempts: newAttempts(), response }),
      completeLogin({ config, challengeStore, registry, attempts: newAttempts(), response }),
      completeLogin({ config, challengeStore, registry, attempts: newAttempts(), response }),
    ]);
    expect(results.filter((r) => r.outcome === "verified")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "rejected")).toHaveLength(2);
  });

  it("distinct valid login assertions create independent sessions at the same epoch — logging in never signs anyone else out", async () => {
    const authenticator = createFixtureAuthenticator();
    const registry = await seedRegistry(authenticator);
    const first = await loginOnce(authenticator, registry);
    const second = await loginOnce(authenticator, registry);
    if (first.outcome !== "verified" || second.outcome !== "verified") throw new Error("expected two verified logins");

    const a = await authed(registry, first.sessionCookie);
    const b = await authed(registry, second.sessionCookie);
    expect(a?.session.sessionEpoch).toBe(0);
    expect(b?.session.sessionEpoch).toBe(0);
    expect(a?.session.sid).not.toBe(b?.session.sid);
    expect((await registry.findAccountByAppUserId("app-user-1"))?.sessionEpoch).toBe(0);
  });

  it("after an epoch increment, old sessions fail and a new login is minted at the new epoch and works", async () => {
    const authenticator = createFixtureAuthenticator();
    const registry = await seedRegistry(authenticator);
    const before = await loginOnce(authenticator, registry);
    if (before.outcome !== "verified") throw new Error("expected a verified login");

    await registry.incrementSessionEpoch("app-user-1");
    expect(await authed(registry, before.sessionCookie)).toBeNull();

    const after = await loginOnce(authenticator, registry);
    if (after.outcome !== "verified") throw new Error("expected a verified login");
    expect(parseSession(after.sessionCookie, config.sessionSecret)?.sessionEpoch).toBe(1);
    expect((await authed(registry, after.sessionCookie))?.account.appUserId).toBe("app-user-1");
  });
});

describe("S5 L2 (Option 3): an uncertain Turnkey create is never adopted — login on it reports needs-review", () => {
  /** The parent-org side of Turnkey as the provisioning path reaches it (raw, parent-stamped POSTs). */
  let turnkey = new FakeParentTurnkey();
  beforeEach(() => {
    turnkey = new FakeParentTurnkey();
  });
  afterEach(() => {
    getWalletAccountsMock.mockReset();
    getSubOrgIdsMock.mockReset();
    getUsersMock.mockReset();
  });

  const ownerAddress = "0xF6C3FE6DE636f0d8f421d5485D1a64fF3628CFaF";
  /** Every Turnkey read of any kind: SDK-client reads AND raw parent requests other than the one create (get_activity, list_wallet_accounts). */
  const turnkeyReads = () =>
    getSubOrgIdsMock.mock.calls.length + getUsersMock.mock.calls.length + getWalletAccountsMock.mock.calls.length + (turnkey.requests.length - turnkey.createRequests.length);

  /** The exact crash window: verified + durably pre-committed, then the ONE create's response is lost. */
  async function stuckAttempt() {
    turnkey.submitMode = "network_error_before_apply";
    const registry = createInMemoryRealAccountRegistry();
    const challengeStore = createInMemoryChallengeStore();
    const attempts = newAttempts();
    const authenticator = createFixtureAuthenticator();
    const { optionsJSON } = await beginRegistration({ config, challengeStore });
    const registered = await completeRegistration({ config, challengeStore, registry, attempts, provisioningDeps: turnkey.deps(), response: buildRegistrationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId }) });
    expect(registered).toEqual({ outcome: "pending", reason: PROVISIONING_NEEDS_REVIEW_REASON });
    const attempt = (await attempts.findByCredentialId(authenticator.credentialIdBase64Url))!;
    expect(attempt).toMatchObject({ state: "provisioning_in_flight", externalOutcome: "unknown" });
    const login = async () => {
      const { optionsJSON: loginOptions } = await beginLogin({ config, challengeStore });
      const response = buildAuthenticationResponseJSON({ authenticator, challenge: loginOptions.challenge, origin: ORIGIN, rpId: config.rpId, userHandle: attempt.userHandle });
      return completeLogin({ config, challengeStore, registry, attempts, response, publicClient: buildPublicClient(), provisioningDeps: turnkey.deps() });
    };
    return { registry, attempts, authenticator, attempt, login };
  }

  /** Nothing about the attempt (beyond login's own counter persistence) or the registry changed. */
  async function expectUntouched(w: Awaited<ReturnType<typeof stuckAttempt>>) {
    const withoutCounter = (attempt: RegistrationAttempt) => ({ ...attempt, counter: 0, updatedAt: "" });
    expect(withoutCounter((await w.attempts.findByCredentialId(w.authenticator.credentialIdBase64Url))!)).toEqual(withoutCounter(w.attempt));
    expect(await w.registry.findAccountByAppUserId(w.attempt.appUserId)).toBeNull();
    expect(await w.registry.findPasskeyByCredentialId(w.authenticator.credentialIdBase64Url)).toBeNull();
  }

  it("Turnkey holds an EXACT matching sub-org for the credential: still no read, no adoption, no account/passkey, no session — needs review", async () => {
    const w = await stuckAttempt();
    // Everything a discovery would have accepted, served if anyone asked.
    getSubOrgIdsMock.mockResolvedValue({ organizationIds: ["sub-org-1"] });
    getUsersMock.mockResolvedValue({ users: [{ userId: "turnkey-user-1", authenticators: [{ authenticatorId: "auth-1", credentialId: w.authenticator.credentialIdBase64Url, credential: { publicKey: w.attempt.credentialPublicKey } }], apiKeys: [], oauthProviders: [] }] });
    getWalletAccountsMock.mockResolvedValue({ accounts: [{ address: ownerAddress, walletId: "wallet-1", walletAccountId: "wallet-account-1" }] });
    const clientsBefore = vi.mocked(TurnkeyClient).mock.calls.length;

    const result = await w.login();

    expect(result).toEqual({ outcome: "pending", reason: PROVISIONING_NEEDS_REVIEW_REASON });
    expect("sessionCookie" in result).toBe(false);
    expect(turnkeyReads()).toBe(0);
    expect(vi.mocked(TurnkeyClient).mock.calls.length).toBe(clientsBefore); // no Turnkey client was even built
    expect(turnkey.createRequests).toHaveLength(1);
    await expectUntouched(w);
  });

  it("conflicting external data (several sub-orgs, a foreign key) changes nothing: same needs-review outcome, still zero reads", async () => {
    const w = await stuckAttempt();
    getSubOrgIdsMock.mockResolvedValue({ organizationIds: ["sub-org-1", "sub-org-2"] });
    getUsersMock.mockResolvedValue({ users: [{ userId: "foreign", authenticators: [{ authenticatorId: "x", credentialId: w.authenticator.credentialIdBase64Url, credential: { publicKey: bytesToBase64Url(createFixtureAuthenticator().publicKeyCose) } }], apiKeys: [{}], oauthProviders: [] }] });

    expect(await w.login()).toEqual({ outcome: "pending", reason: PROVISIONING_NEEDS_REVIEW_REASON });
    expect(turnkeyReads()).toBe(0);
    await expectUntouched(w);
  });

  it("repeated logins never dispatch another create, never read Turnkey, and never move the attempt", async () => {
    const w = await stuckAttempt();
    for (let i = 0; i < 3; i += 1) expect((await w.login()).outcome).toBe("pending");
    expect(turnkey.createRequests).toHaveLength(1);
    expect(turnkeyReads()).toBe(0);
    await expectUntouched(w);
  });

  it("a blocked registration stays blocked on login — no Turnkey call, no session", async () => {
    // "provisioning_in_flight" is claim-only, so a block comes the real way: the
    // create completes, and finalize finds another account already holding that
    // sub-organization (S5 L2) and blocks the attempt.
    turnkey.submitMode = "completed";
    const registry = createInMemoryRealAccountRegistry();
    await registry.createAccountWithPasskey({
      account: { appUserId: "other-user", subOrganizationId: "sub-org-1", turnkeyUserId: "other-turnkey-user", walletId: "other-wallet", walletAccountId: "other-wallet-account", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222", accountConfigVersion: 1 },
      passkey: { credentialId: "other-credential", appUserId: "other-user", credentialPublicKey: "other-cose", userHandle: "other-handle", counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false },
    });
    const challengeStore = createInMemoryChallengeStore();
    const attempts = newAttempts();
    const authenticator = createFixtureAuthenticator();
    const { optionsJSON } = await beginRegistration({ config, challengeStore });
    const registered = await completeRegistration({ config, challengeStore, registry, attempts, provisioningDeps: turnkey.deps(), publicClient: buildPublicClient(), response: buildRegistrationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId }) });
    expect(registered).toEqual({ outcome: "blocked", reason: REGISTRATION_IDENTITY_CONFLICT_REASON });
    const attempt = (await attempts.findByCredentialId(authenticator.credentialIdBase64Url))!;
    const requestsBefore = turnkey.requests.length;

    const { optionsJSON: loginOptions } = await beginLogin({ config, challengeStore });
    const response = buildAuthenticationResponseJSON({ authenticator, challenge: loginOptions.challenge, origin: ORIGIN, rpId: config.rpId, userHandle: attempt.userHandle });
    expect(await completeLogin({ config, challengeStore, registry, attempts, response, publicClient: buildPublicClient(), provisioningDeps: turnkey.deps() })).toEqual({ outcome: "blocked", reason: REGISTRATION_IDENTITY_CONFLICT_REASON });
    expect(turnkey.requests).toHaveLength(requestsBefore);
    expect(turnkeyReads() - (requestsBefore - turnkey.createRequests.length)).toBe(0); // nothing beyond the registration's own reads
    expect(turnkey.createRequests).toHaveLength(1);
    expect(await registry.findAccountByAppUserId(attempt.appUserId)).toBeNull();
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
