import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, encodeAbiParameters, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import type { RealServerConfig } from "@/lib/real/server/config";
import { createInMemoryChallengeStore } from "@/lib/real/server/challenge-store";
import { createInMemoryRealAccountRegistry, getInMemoryRegistryInternals } from "@/lib/real/server/registry";
import { bytesToBase64Url } from "@/lib/real/bytes";
import { createInMemoryRegistrationAttemptStore } from "@/lib/real/server/registration-attempts";
import { buildRegistrationResponseJSON, createFixtureAuthenticator } from "./fixtures/webauthn";
import { toStdBase64 } from "./fixtures/turnkey-fake";

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

function completedActivity(result: unknown) {
  return { activity: { id: "activity-1", status: "ACTIVITY_STATUS_COMPLETED", result } };
}

function mockSuccessfulProvisioning(ownerAddress = "0xF6C3FE6DE636f0d8f421d5485D1a64fF3628CFaF") {
  createSubOrganizationMock.mockResolvedValue(
    completedActivity({
      createSubOrganizationResultV8: {
        subOrganizationId: "sub-org-1",
        rootUserIds: ["turnkey-user-1"],
        wallet: { walletId: "wallet-1", addresses: [ownerAddress] },
      },
    }),
  );
  getWalletAccountsMock.mockResolvedValue({ accounts: [{ address: ownerAddress, walletAccountId: "wallet-account-1" }] });
}

function newStores() {
  return {
    challengeStore: createInMemoryChallengeStore(),
    registry: createInMemoryRealAccountRegistry(),
    attempts: createInMemoryRegistrationAttemptStore(),
  };
}

describe("registration flow: beginRegistration -> completeRegistration", () => {
  afterEach(() => {
    createSubOrganizationMock.mockReset();
    getWalletAccountsMock.mockReset();
    getSubOrgIdsMock.mockReset();
    getUsersMock.mockReset();
  });

  it("completes end to end: independently verifies WebAuthn, provisions Turnkey from the SAME credential, activates the account", async () => {
    mockSuccessfulProvisioning();
    const { challengeStore, registry, attempts } = newStores();

    const { optionsJSON } = await beginRegistration({ config, challengeStore });
    const authenticator = createFixtureAuthenticator();
    const response = buildRegistrationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId });

    const result = await completeRegistration({ config, challengeStore, registry, attempts, response, publicClient: buildPublicClient() });

    expect(result.outcome).toBe("verified");
    if (result.outcome !== "verified") return;
    expect(result.account.subOrganizationId).toBe("sub-org-1");
    expect(result.account.ownerAddress).toBe("0xF6C3FE6DE636f0d8f421d5485D1a64fF3628CFaF");
    expect(result.account.safeAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(result.sessionCookie).toBeTruthy();

    const storedAccount = await registry.findAccountByAppUserId(result.account.appUserId);
    expect(storedAccount).toEqual(result.account);
    const passkey = await registry.findPasskeyByCredentialId(authenticator.credentialIdBase64Url);
    expect(passkey?.status).toBe("active");
    const attempt = await attempts.findByCredentialId(authenticator.credentialIdBase64Url);
    expect(attempt?.state).toBe("active");

    const call = createSubOrganizationMock.mock.calls[0]![0] as {
      parameters: { rootUsers: Array<{ authenticators: Array<{ attestation: { credentialId: string } }> }> };
    };
    expect(call.parameters.rootUsers[0]!.authenticators[0]!.attestation.credentialId).toBe(authenticator.credentialIdBase64Url);
  });

  it("rejects a malformed response without ever calling Turnkey", async () => {
    const { challengeStore, registry, attempts } = newStores();
    const malformed = {
      id: "x",
      rawId: "x",
      response: { clientDataJSON: "not-valid-base64!!!", attestationObject: "x" },
      clientExtensionResults: {},
      type: "public-key",
    } as unknown as RegistrationResponseJSON;

    const result = await completeRegistration({ config, challengeStore, registry, attempts, response: malformed });

    expect(result.outcome).toBe("rejected");
    expect(createSubOrganizationMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown challenge without calling Turnkey", async () => {
    const { challengeStore, registry, attempts } = newStores();
    const authenticator = createFixtureAuthenticator();
    const response = buildRegistrationResponseJSON({ authenticator, challenge: "never-issued-challenge", origin: ORIGIN, rpId: config.rpId });

    const result = await completeRegistration({ config, challengeStore, registry, attempts, response });

    expect(result.outcome).toBe("rejected");
    expect(createSubOrganizationMock).not.toHaveBeenCalled();
  });

  it("a challenge cannot be replayed — the second completeRegistration for the same response is rejected and never re-provisions", async () => {
    mockSuccessfulProvisioning();
    const { challengeStore, registry, attempts } = newStores();
    const { optionsJSON } = await beginRegistration({ config, challengeStore });
    const authenticator = createFixtureAuthenticator();
    const response = buildRegistrationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId });

    const first = await completeRegistration({ config, challengeStore, registry, attempts, response, publicClient: buildPublicClient() });
    expect(first.outcome).toBe("verified");

    const second = await completeRegistration({ config, challengeStore, registry, attempts, response, publicClient: buildPublicClient() });
    expect(second.outcome).toBe("rejected");
    expect(createSubOrganizationMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a response signed for the wrong origin, without calling Turnkey", async () => {
    const { challengeStore, registry, attempts } = newStores();
    const authenticator = createFixtureAuthenticator();
    const { optionsJSON } = await beginRegistration({ config, challengeStore });
    const response = buildRegistrationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: "http://evil.example", rpId: config.rpId });

    const result = await completeRegistration({ config, challengeStore, registry, attempts, response });

    expect(result.outcome).toBe("rejected");
    expect(createSubOrganizationMock).not.toHaveBeenCalled();
  });

  it("rejects a response computed for the wrong RP ID, without calling Turnkey", async () => {
    const { challengeStore, registry, attempts } = newStores();
    const authenticator = createFixtureAuthenticator();
    const { optionsJSON } = await beginRegistration({ config, challengeStore });
    const response = buildRegistrationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: "not-localhost" });

    const result = await completeRegistration({ config, challengeStore, registry, attempts, response });

    expect(result.outcome).toBe("rejected");
    expect(createSubOrganizationMock).not.toHaveBeenCalled();
  });

  it("rejects when user verification was not performed, without calling Turnkey", async () => {
    const { challengeStore, registry, attempts } = newStores();
    const authenticator = createFixtureAuthenticator();
    const { optionsJSON } = await beginRegistration({ config, challengeStore });
    const response = buildRegistrationResponseJSON({
      authenticator,
      challenge: optionsJSON.challenge,
      origin: ORIGIN,
      rpId: config.rpId,
      userVerified: false,
    });

    const result = await completeRegistration({ config, challengeStore, registry, attempts, response });

    expect(result.outcome).toBe("rejected");
    expect(createSubOrganizationMock).not.toHaveBeenCalled();
  });

  it("rejects a duplicate credential registration and does not provision Turnkey a second time for it", async () => {
    mockSuccessfulProvisioning();
    const { challengeStore, registry, attempts } = newStores();
    const authenticator = createFixtureAuthenticator();

    const first = await beginRegistration({ config, challengeStore });
    const firstResponse = buildRegistrationResponseJSON({ authenticator, challenge: first.optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId });
    const firstResult = await completeRegistration({ config, challengeStore, registry, attempts, response: firstResponse, publicClient: buildPublicClient() });
    expect(firstResult.outcome).toBe("verified");

    // The SAME physical passkey attempts to register again (e.g. a confused retry).
    const second = await beginRegistration({ config, challengeStore });
    const secondResponse = buildRegistrationResponseJSON({ authenticator, challenge: second.optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId });
    const secondResult = await completeRegistration({ config, challengeStore, registry, attempts, response: secondResponse, publicClient: buildPublicClient() });

    expect(secondResult.outcome).toBe("rejected");
    expect(createSubOrganizationMock).toHaveBeenCalledTimes(1);
  });

  it("a lost/uncertain Turnkey response durably leaves the attempt 'provisioning_in_flight' with externalOutcome 'unknown' (pending, not rejected-forever) and creates no active account", async () => {
    createSubOrganizationMock.mockRejectedValue(new Error("Turnkey unreachable"));
    const { challengeStore, registry, attempts } = newStores();
    const authenticator = createFixtureAuthenticator();
    const { optionsJSON } = await beginRegistration({ config, challengeStore });
    const response = buildRegistrationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId });

    const result = await completeRegistration({ config, challengeStore, registry, attempts, response, publicClient: buildPublicClient() });

    expect(result.outcome).toBe("pending");
    expect(await registry.findPasskeyByCredentialId(authenticator.credentialIdBase64Url)).toBeNull();
    const attempt = await attempts.findByCredentialId(authenticator.credentialIdBase64Url);
    expect(attempt?.state).toBe("provisioning_in_flight");
    expect(attempt?.externalOutcome).toBe("unknown");
    expect(attempt?.externalProvisioningAttemptedAt).toBeTruthy();
    // Durable pre-commit fields are present — enough to recover later.
    expect(attempt?.rawAttestationObject).toBeTruthy();
    expect(attempt?.registrationChallenge).toBe(optionsJSON.challenge);
  });

  it("a Turnkey-CONFIRMED definitive pre-creation failure (activity resolved FAILED/REJECTED) reverts the attempt to 'verified' so a later call may retry — the one narrow condition under which a second create is ever allowed", async () => {
    createSubOrganizationMock.mockResolvedValueOnce({ activity: { id: "activity-1", type: "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V8", status: "ACTIVITY_STATUS_REJECTED" } });
    const { challengeStore, registry, attempts } = newStores();
    const authenticator = createFixtureAuthenticator();
    const { optionsJSON } = await beginRegistration({ config, challengeStore });
    const response = buildRegistrationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId });

    const result = await completeRegistration({ config, challengeStore, registry, attempts, response, publicClient: buildPublicClient() });

    expect(result.outcome).toBe("pending");
    const attemptAfterFailure = await attempts.findByCredentialId(authenticator.credentialIdBase64Url);
    expect(attemptAfterFailure?.state).toBe("verified");
    expect(attemptAfterFailure?.externalOutcome).toBe("definitive_failure");
    expect(createSubOrganizationMock).toHaveBeenCalledTimes(1);

    // A later resumed pipeline run (e.g. via login recovery) is now free to
    // attempt provisioning again — this time it succeeds.
    mockSuccessfulProvisioning();
    const { runProvisioningPipeline } = await import("@/lib/real/server/onboarding");
    const retryResult = await runProvisioningPipeline({
      config,
      registry,
      attempts,
      attempt: attemptAfterFailure!,
      publicClient: buildPublicClient(),
    });

    expect(retryResult.outcome).toBe("verified");
    expect(createSubOrganizationMock).toHaveBeenCalledTimes(2);
    expect((await attempts.findByCredentialId(authenticator.credentialIdBase64Url))?.state).toBe("active");
  });

  it("concurrent duplicate registration: two racing completions for the SAME credential can never both create durable mappings — exactly one wins, the other is rejected", async () => {
    mockSuccessfulProvisioning();
    const { challengeStore, registry, attempts } = newStores();
    const authenticator = createFixtureAuthenticator();

    const first = await beginRegistration({ config, challengeStore });
    const firstResponse = buildRegistrationResponseJSON({ authenticator, challenge: first.optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId });
    const second = await beginRegistration({ config, challengeStore });
    const secondResponse = buildRegistrationResponseJSON({ authenticator, challenge: second.optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId });

    const [firstResult, secondResult] = await Promise.all([
      completeRegistration({ config, challengeStore, registry, attempts, response: firstResponse, publicClient: buildPublicClient() }),
      completeRegistration({ config, challengeStore, registry, attempts, response: secondResponse, publicClient: buildPublicClient() }),
    ]);

    const outcomes = [firstResult.outcome, secondResult.outcome];
    expect(outcomes.filter((outcome) => outcome === "verified")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "rejected")).toHaveLength(1);

    // Only ever one durable attempt row, one active account, one Turnkey call.
    const attempt = await attempts.findByCredentialId(authenticator.credentialIdBase64Url);
    expect(attempt?.state).toBe("active");
    expect(await registry.findAccountByAppUserId(attempt!.appUserId)).not.toBeNull();
    expect(createSubOrganizationMock).toHaveBeenCalledTimes(1);
  });

  it("issued session contains no Turnkey/signing-shaped data — app identity only", async () => {
    mockSuccessfulProvisioning();
    const { challengeStore, registry, attempts } = newStores();
    const { optionsJSON } = await beginRegistration({ config, challengeStore });
    const authenticator = createFixtureAuthenticator();
    const response = buildRegistrationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId });

    const result = await completeRegistration({ config, challengeStore, registry, attempts, response, publicClient: buildPublicClient() });
    expect(result.outcome).toBe("verified");
    if (result.outcome !== "verified") return;

    expect(result.sessionCookie).not.toMatch(/subOrganization|walletId|ownerAddress|safeAddress/i);
  });
});

describe("S5 L2: the registration credential id is the ATTESTED one, bound to response.id by bytes", () => {
  afterEach(() => {
    createSubOrganizationMock.mockReset();
    getWalletAccountsMock.mockReset();
  });

  /** A genuine response whose client-supplied id/rawId are replaced (the library only requires id === rawId). */
  async function respond(stores: ReturnType<typeof newStores>, authenticator = createFixtureAuthenticator(), id?: string) {
    const { optionsJSON } = await beginRegistration({ config, challengeStore: stores.challengeStore });
    const response = buildRegistrationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId });
    if (id !== undefined) Object.assign(response, { id, rawId: id });
    return { response, authenticator };
  }

  it("response.id naming DIFFERENT bytes than the attested credential -> fixed 400-class rejection, no attempt under either id, no Turnkey call", async () => {
    mockSuccessfulProvisioning();
    const stores = newStores();
    const otherId = bytesToBase64Url(new Uint8Array(32).fill(9));
    const { response, authenticator } = await respond(stores, undefined, otherId);

    const result = await completeRegistration({ ...stores, config, response, publicClient: buildPublicClient() });

    expect(result).toEqual({ outcome: "rejected", reason: "Registration could not be verified." });
    expect(await stores.attempts.findByCredentialId(authenticator.credentialIdBase64Url)).toBeNull();
    expect(await stores.attempts.findByCredentialId(otherId)).toBeNull();
    expect(await stores.registry.findPasskeyByCredentialId(authenticator.credentialIdBase64Url)).toBeNull();
    expect(createSubOrganizationMock).not.toHaveBeenCalled();
  });

  it("response.id as another encoding of the SAME bytes (padded standard base64) is accepted; the durable id and Turnkey's are the canonical attested one", async () => {
    mockSuccessfulProvisioning();
    const stores = newStores();
    const authenticator = createFixtureAuthenticator();
    const { response } = await respond(stores, authenticator, toStdBase64(authenticator.credentialIdBase64Url));
    expect(response.id).not.toBe(authenticator.credentialIdBase64Url);

    const result = await completeRegistration({ ...stores, config, response, publicClient: buildPublicClient() });

    expect(result.outcome).toBe("verified");
    expect((await stores.attempts.findByCredentialId(authenticator.credentialIdBase64Url))?.state).toBe("active");
    expect(await stores.attempts.findByCredentialId(response.id)).toBeNull();
    const call = createSubOrganizationMock.mock.calls[0]![0] as { parameters: { rootUsers: Array<{ authenticators: Array<{ attestation: { credentialId: string } }> }> } };
    expect(call.parameters.rootUsers[0]!.authenticators[0]!.attestation.credentialId).toBe(authenticator.credentialIdBase64Url);
  });

  it("an attested id that already belongs to a PRIMARY passkey is rejected before Turnkey — even when response.id spells it differently", async () => {
    mockSuccessfulProvisioning();
    const stores = newStores();
    const authenticator = createFixtureAuthenticator();
    expect((await completeRegistration({ ...stores, config, response: (await respond(stores, authenticator)).response, publicClient: buildPublicClient() })).outcome).toBe("verified");

    const { response } = await respond(stores, authenticator, toStdBase64(authenticator.credentialIdBase64Url));
    const result = await completeRegistration({ ...stores, config, response, publicClient: buildPublicClient() });

    expect(result).toEqual({ outcome: "rejected", reason: 'This passkey is already registered. Use "I already have an account" instead.' });
    expect(createSubOrganizationMock).toHaveBeenCalledTimes(1);
  });

  it("an attested id that already belongs to a BACKUP passkey (any status) is rejected before Turnkey, with no attempt created", async () => {
    mockSuccessfulProvisioning();
    const stores = newStores();
    const owner = createFixtureAuthenticator();
    expect((await completeRegistration({ ...stores, config, response: (await respond(stores, owner)).response, publicClient: buildPublicClient() })).outcome).toBe("verified");
    const ownerPasskey = (await stores.registry.findPasskeyByCredentialId(owner.credentialIdBase64Url))!;
    const backup = createFixtureAuthenticator();
    getInMemoryRegistryInternals(stores.registry).passkeysByCredentialId.set(backup.credentialIdBase64Url, {
      ...ownerPasskey,
      credentialId: backup.credentialIdBase64Url,
      credentialPublicKey: bytesToBase64Url(backup.publicKeyCose),
      role: "backup",
      status: "pending",
    });

    const { response } = await respond(stores, backup, toStdBase64(backup.credentialIdBase64Url));
    const result = await completeRegistration({ ...stores, config, response, publicClient: buildPublicClient() });

    expect(result).toEqual({ outcome: "rejected", reason: 'This passkey is already registered. Use "I already have an account" instead.' });
    expect(await stores.attempts.findByCredentialId(backup.credentialIdBase64Url)).toBeNull();
    expect(createSubOrganizationMock).toHaveBeenCalledTimes(1);
  });

  it("a pending attempt is found by the ATTESTED id, not the raw response.id spelling", async () => {
    createSubOrganizationMock.mockRejectedValue(new Error("Turnkey unreachable"));
    const stores = newStores();
    const authenticator = createFixtureAuthenticator();
    expect((await completeRegistration({ ...stores, config, response: (await respond(stores, authenticator)).response, publicClient: buildPublicClient() })).outcome).toBe("pending");

    const { response } = await respond(stores, authenticator, toStdBase64(authenticator.credentialIdBase64Url));
    const result = await completeRegistration({ ...stores, config, response, publicClient: buildPublicClient() });

    expect(result).toEqual({ outcome: "rejected", reason: 'A registration is already pending for this passkey. Use "I already have an account" to resume it.' });
    expect(createSubOrganizationMock).toHaveBeenCalledTimes(1);
  });
});
