import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, encodeAbiParameters, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { RealServerConfig } from "@/lib/real/server/config";
import { createInMemoryRealAccountRegistry, type RealAccountRegistry } from "@/lib/real/server/registry";
import { createInMemoryRegistrationAttemptStore, type RegistrationAttemptStore } from "@/lib/real/server/registration-attempts";
import { createInMemoryChallengeStore } from "@/lib/real/server/challenge-store";
import { createInMemoryLoginChallengeUseStore, type LoginChallengeUseStore } from "@/lib/real/server/login-challenge-uses";
import { issueLoginChallenge } from "@/lib/real/server/login-challenge";
import { bytesToBase64Url } from "@/lib/real/bytes";
import { buildAuthenticationResponseJSON, buildRegistrationResponseJSON, createFixtureAuthenticator, type FixtureAuthenticator } from "./fixtures/webauthn";
import { FakeParentTurnkey } from "./fixtures/turnkey-parent-fake";

/**
 * Login verify — structural envelope precheck (Milestone 3C, E1). Offline only: in-memory registry, attempt store and
 * used-marker store behind call-recording proxies; the Turnkey SDK is mocked so nothing can reach a network. This is
 * request-shape hardening, not a rate limiter, and it adds no credential-id length cap.
 */
const getWalletAccountsMock = vi.fn();
const getSubOrgIdsMock = vi.fn();
const getUsersMock = vi.fn();

vi.mock("@turnkey/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@turnkey/http")>();
  return {
    ...actual,
    TurnkeyClient: vi.fn().mockImplementation(function TurnkeyClientMock() {
      return { getWalletAccounts: getWalletAccountsMock, getSubOrgIds: getSubOrgIdsMock, getUsers: getUsersMock };
    }),
  };
});

const { beginLogin, completeLogin } = await import("@/lib/real/server/login");
const { beginRegistration, completeRegistration } = await import("@/lib/real/server/registration");
const { PROVISIONING_NEEDS_REVIEW_REASON } = await import("@/lib/real/server/onboarding");

const ORIGIN = "http://localhost:3000";
const USER_HANDLE = "user-handle-1";
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
const MALFORMED = { outcome: "rejected", reason: "Malformed login response." } as const;
const UNKNOWN_CHALLENGE = { outcome: "rejected", reason: "Unknown, expired, or already-used login challenge." } as const;
const WRITE_EVENTS = ["marker.consume", "registry.updateAuthenticatorCounter", "attempts.updateCounter"];

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

/** Wraps an object so every method call is logged by name, then forwarded. */
function recording<T extends object>(target: T, label: string, events: string[]): T {
  return new Proxy(target, {
    get(real, property, receiver) {
      const value = Reflect.get(real, property, receiver) as unknown;
      if (typeof value !== "function" || property === "then") return value;
      return (...args: unknown[]) => {
        events.push(`${label}.${String(property)}`);
        return (value as (...a: unknown[]) => unknown).apply(real, args);
      };
    },
  });
}

function clientDataJSON(over: { type?: unknown; challenge: string }): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ type: over.type, challenge: over.challenge, origin: ORIGIN, crossOrigin: false })));
}

/** Active-passkey world: one registered credential, every store call recorded. */
async function activeWorld(credentialId?: Uint8Array) {
  const authenticator = createFixtureAuthenticator({ credentialId });
  const events: string[] = [];
  const rawRegistry = createInMemoryRealAccountRegistry();
  await rawRegistry.createAccountWithPasskey({
    account: { appUserId: "app-user-1", subOrganizationId: "sub-org-1", turnkeyUserId: "turnkey-user-1", walletId: "wallet-1", walletAccountId: "wallet-account-1", ownerAddress: "0xF6C3FE6DE636f0d8f421d5485D1a64fF3628CFaF", safeAddress: "0xd9a4c22fb34dc74317edc8006140d66c8fa03266", accountConfigVersion: 1 },
    passkey: { credentialId: authenticator.credentialIdBase64Url, appUserId: "app-user-1", credentialPublicKey: bytesToBase64Url(authenticator.publicKeyCose), userHandle: USER_HANDLE, counter: authenticator.counter, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false },
  });
  const registry = recording(rawRegistry, "registry", events) as RealAccountRegistry;
  const markers = createInMemoryLoginChallengeUseStore();
  const uses = recording(markers, "marker", events) as LoginChallengeUseStore;
  const attempts = recording(createInMemoryRegistrationAttemptStore(), "attempts", events) as RegistrationAttemptStore;
  const fresh = async () => (await beginLogin({ config })).optionsJSON.challenge;
  const respond = (challenge: string, over: Partial<Parameters<typeof buildAuthenticationResponseJSON>[0]> = {}) =>
    buildAuthenticationResponseJSON({ authenticator, challenge, origin: ORIGIN, rpId: config.rpId, userHandle: USER_HANDLE, ...over });
  const login = (response: AuthenticationResponseJSON) => completeLogin({ config, loginChallengeUses: uses, registry, attempts, response });
  const counter = async () => (await rawRegistry.findPasskeyByCredentialId(authenticator.credentialIdBase64Url))!.counter;
  return { authenticator, events, registry, markers, attempts, fresh, respond, login, counter };
}

/** A valid-challenge response whose envelope has been altered. `id`/`rawId`/`type` overrides use `undefined` to DELETE the field. */
async function envelope(w: Awaited<ReturnType<typeof activeWorld>>, over: { id?: unknown; rawId?: unknown; type?: unknown; clientType?: unknown }, has: ReadonlyArray<"id" | "rawId" | "type" | "clientType">) {
  const challenge = await w.fresh();
  const base = w.respond(challenge) as unknown as Record<string, unknown> & { response: Record<string, unknown> };
  const out: Record<string, unknown> = { ...base, response: { ...base.response } };
  if (has.includes("id")) out.id = over.id;
  if (has.includes("rawId")) out.rawId = over.rawId;
  if (has.includes("type")) out.type = over.type;
  if (has.includes("id") && over.id === undefined) delete out.id;
  if (has.includes("rawId") && over.rawId === undefined) delete out.rawId;
  if (has.includes("type") && over.type === undefined) delete out.type;
  if (has.includes("clientType")) (out.response as Record<string, unknown>).clientDataJSON = clientDataJSON({ type: over.clientType, challenge });
  return out as unknown as AuthenticationResponseJSON;
}

const GOOD_ID = bytesToBase64Url(new Uint8Array(32).fill(7)); // 43 characters

describe("a malformed envelope with a VALID stateless challenge is refused before ANY store call", () => {
  async function expectRefusedWithoutStoreCalls(w: Awaited<ReturnType<typeof activeWorld>>, response: AuthenticationResponseJSON) {
    w.events.length = 0;
    const before = await w.counter();
    w.events.length = 0;
    const result = await w.login(response);
    expect(result).toEqual(MALFORMED);
    expect("sessionCookie" in result).toBe(false);
    expect(w.events).toEqual([]); // no registry call (incl. findPasskeyByCredentialId), no attempts call (incl. findByCredentialId), no marker call
    expect(w.markers.snapshot()).toEqual([]);
    expect(await w.counter()).toBe(before);
  }

  const badIds: Array<[string, unknown]> = [
    ["null", null],
    ["number", 1234],
    ["boolean", true],
    ["array", ["abcd", "efgh"]],
    ["object", { toString: () => GOOD_ID, length: 43 }],
    ["empty string", ""],
  ];
  for (const [label, value] of badIds) {
    it(`response.id is ${label} (rawId equal to it)`, async () => {
      const w = await activeWorld();
      await expectRefusedWithoutStoreCalls(w, await envelope(w, { id: value, rawId: value }, ["id", "rawId"]));
    });
  }

  it("response.id is missing", async () => {
    const w = await activeWorld();
    await expectRefusedWithoutStoreCalls(w, await envelope(w, { id: undefined, rawId: undefined }, ["id", "rawId"]));
  });

  const badShapes: Array<[string, string]> = [
    ["padding '='", `${GOOD_ID}=`], // 44 characters: only the alphabet rejects it
    ["'+' character", `${GOOD_ID.slice(0, 20)}+${GOOD_ID.slice(21)}`],
    ["'/' character", `${GOOD_ID.slice(0, 20)}/${GOOD_ID.slice(21)}`],
    ["a space", `${GOOD_ID.slice(0, 20)} ${GOOD_ID.slice(21)}`],
    ["a trailing newline", `${GOOD_ID}\n`],
    ["a leading tab", `\t${GOOD_ID}`],
    ["length modulo 4 equal to 1 (41 characters)", GOOD_ID.slice(0, 41)],
    ["length modulo 4 equal to 1 (5 characters)", "abcde"],
  ];
  for (const [label, id] of badShapes) {
    it(`response.id has ${label} (rawId equal to it)`, async () => {
      const w = await activeWorld();
      await expectRefusedWithoutStoreCalls(w, await envelope(w, { id, rawId: id }, ["id", "rawId"]));
    });
  }

  it("response.rawId is missing", async () => {
    const w = await activeWorld();
    await expectRefusedWithoutStoreCalls(w, await envelope(w, { rawId: undefined }, ["rawId"]));
  });

  it("response.rawId is not a string", async () => {
    const w = await activeWorld();
    for (const rawId of [123, null, true, [w.authenticator.credentialIdBase64Url], {}]) await expectRefusedWithoutStoreCalls(w, await envelope(w, { rawId }, ["rawId"]));
  });

  it("response.rawId differs from response.id (even when both are individually valid)", async () => {
    const w = await activeWorld();
    const other = bytesToBase64Url(new Uint8Array(32).fill(9));
    await expectRefusedWithoutStoreCalls(w, await envelope(w, { rawId: other }, ["rawId"]));
    await expectRefusedWithoutStoreCalls(w, await envelope(w, { rawId: `${w.authenticator.credentialIdBase64Url}A` }, ["rawId"]));
  });

  it("response.type is missing, wrong, or not a string", async () => {
    const w = await activeWorld();
    await expectRefusedWithoutStoreCalls(w, await envelope(w, { type: undefined }, ["type"]));
    for (const type of ["password", "Public-Key", "public-key ", "", 5, null, true, ["public-key"]]) await expectRefusedWithoutStoreCalls(w, await envelope(w, { type }, ["type"]));
  });

  it("decoded clientData.type is missing, wrong, not a string, or webauthn.create", async () => {
    const w = await activeWorld();
    await expectRefusedWithoutStoreCalls(w, await envelope(w, { clientType: undefined }, ["clientType"]));
    for (const clientType of ["password", "WebAuthn.get", "webauthn.get ", "", 5, null, true, ["webauthn.get"], "webauthn.create"]) await expectRefusedWithoutStoreCalls(w, await envelope(w, { clientType }, ["clientType"]));
  });

  it("writes nothing and triggers no finalization: no marker, no counter update, no attempt write, no Turnkey client or request", async () => {
    const w = await activeWorld();
    const id = `${GOOD_ID}=`;
    const result = await w.login(await envelope(w, { id, rawId: id }, ["id", "rawId"]));
    expect(result).toEqual(MALFORMED);
    expect(w.events.filter((event) => WRITE_EVENTS.includes(event))).toEqual([]);
    expect(getSubOrgIdsMock).not.toHaveBeenCalled();
    expect(getUsersMock).not.toHaveBeenCalled();
    expect(getWalletAccountsMock).not.toHaveBeenCalled();
  });

  it("the answer is the same generic text whether or not the claimed credential exists (no stored-credential or registration-state oracle)", async () => {
    const w = await activeWorld();
    const real = w.authenticator.credentialIdBase64Url;
    const stranger = createFixtureAuthenticator().credentialIdBase64Url;
    const results = [];
    for (const id of [`${real}=`, `${stranger}=`]) results.push(await w.login(await envelope(w, { id, rawId: id }, ["id", "rawId"])));
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toEqual(MALFORMED);
  });
});

describe("ordering: the stateless challenge is judged FIRST, the envelope second, the first lookup third", () => {
  it("a forged / expired / foreign challenge with a malformed envelope is refused as an unknown challenge (the token check wins), with zero store calls", async () => {
    const w = await activeWorld();
    const expired = (await beginLogin({ config, nowMs: Date.now() - 6 * 60_000 })).optionsJSON.challenge;
    const otherRp = issueLoginChallenge({ sessionSecret: config.sessionSecret, rpId: "other.example" }).challenge;
    for (const challenge of ["Y2hhbGxlbmdlLWZvci10ZXN0cw", "", expired, otherRp]) {
      for (const bad of [{ id: `${GOOD_ID}=`, rawId: `${GOOD_ID}=` }, {}]) {
        w.events.length = 0;
        const response = { ...w.respond(challenge), ...bad, type: "not-public-key" } as unknown as AuthenticationResponseJSON;
        expect(await w.login(response), challenge.slice(0, 6)).toEqual(UNKNOWN_CHALLENGE);
        expect(w.events).toEqual([]);
      }
    }
  });

  it("a forged challenge with a WELL-FORMED envelope still fails before the database", async () => {
    const w = await activeWorld();
    expect(await w.login(w.respond("Y2hhbGxlbmdlLWZvci10ZXN0cw"))).toEqual(UNKNOWN_CHALLENGE);
    expect(w.events).toEqual([]);
  });

  it("an undecodable clientDataJSON keeps its own earlier rejection (same generic wording), with zero store calls", async () => {
    const w = await activeWorld();
    const response = w.respond(await w.fresh());
    response.response.clientDataJSON = "!!!not-json";
    expect(await w.login(response)).toEqual(MALFORMED);
    expect(w.events).toEqual([]);
  });
});

describe("a well-formed envelope is untouched: the original lookups, responses and ordering remain", () => {
  it("an UNKNOWN but well-formed credential id with a valid challenge follows the original first and second lookups, answers 'Unknown credential.', and writes nothing", async () => {
    const w = await activeWorld();
    const stranger = createFixtureAuthenticator();
    const response = buildAuthenticationResponseJSON({ authenticator: stranger, challenge: await w.fresh(), origin: ORIGIN, rpId: config.rpId, userHandle: USER_HANDLE });
    w.events.length = 0;
    expect(await w.login(response)).toEqual({ outcome: "rejected", reason: "Unknown credential." });
    expect(w.events).toEqual(["registry.findPasskeyByCredentialId", "attempts.findByCredentialId"]);
    expect(w.markers.snapshot()).toEqual([]);
  });

  it("a very long well-formed id is NOT length-capped by this precheck: it passes and reaches both lookups (the body ceiling is the only bound)", async () => {
    const w = await activeWorld();
    for (const length of [1364, 1365, 2000, 4000, 12_000]) {
      const id = "A".repeat(length + (length % 4 === 1 ? 1 : 0));
      const response = { ...w.respond(await w.fresh()), id, rawId: id } as AuthenticationResponseJSON;
      w.events.length = 0;
      expect(await w.login(response), String(length)).toEqual({ outcome: "rejected", reason: "Unknown credential." });
      expect(w.events).toEqual(["registry.findPasskeyByCredentialId", "attempts.findByCredentialId"]);
    }
  });

  it("an active passkey login still verifies: lookup -> marker -> counter -> account, one marker, a session, the counter advanced", async () => {
    const w = await activeWorld();
    w.events.length = 0;
    const result = await w.login(w.respond(await w.fresh(), { counterOverride: 5 }));
    expect(result.outcome).toBe("verified");
    expect(w.events).toEqual(["registry.findPasskeyByCredentialId", "marker.consume", "registry.updateAuthenticatorCounter", "registry.findAccountByAppUserId"]);
    expect(w.markers.snapshot()).toHaveLength(1);
    expect(await w.counter()).toBe(5);
    if (result.outcome === "verified") expect(result.account.appUserId).toBe("app-user-1");
  });

  it("the replay marker is still written only AFTER verification: a failed signature, missing user verification and a wrong userHandle all leave no marker", async () => {
    const w = await activeWorld();
    const tampered = w.respond(await w.fresh());
    tampered.response.signature = `${tampered.response.signature[0] === "A" ? "B" : "A"}${tampered.response.signature.slice(1)}`;
    expect(await w.login(tampered)).toEqual({ outcome: "rejected", reason: "Login could not be verified." });
    expect((await w.login(w.respond(await w.fresh(), { userVerified: false }))).outcome).toBe("rejected");
    expect((await w.login(w.respond(await w.fresh(), { userHandle: "someone-else" }))).outcome).toBe("rejected");
    expect(w.markers.snapshot()).toEqual([]);
    expect(w.events).not.toContain("marker.consume");
    expect(w.events).not.toContain("registry.updateAuthenticatorCounter");
  });

  it("replay safety is unchanged: the same valid assertion is accepted once and then refused at the marker", async () => {
    const w = await activeWorld();
    const response = w.respond(await w.fresh());
    expect((await w.login(response)).outcome).toBe("verified");
    expect(await w.login(response)).toEqual(UNKNOWN_CHALLENGE);
    expect(w.markers.snapshot()).toHaveLength(1);
  });

  it("library-produced assertions pass the shape check across representative credential-id byte lengths (no maximum enforced)", async () => {
    for (const bytes of [1, 2, 3, 16, 20, 32, 48, 64, 65, 100, 127, 255, 256, 300, 512, 1000]) {
      const credentialId = new Uint8Array(bytes);
      crypto.getRandomValues(credentialId);
      const w = await activeWorld(credentialId);
      const response = w.respond(await w.fresh());
      expect(response.id).toBe(response.rawId);
      expect(response.id.length % 4, String(bytes)).not.toBe(1);
      w.events.length = 0;
      const result = await w.login(response);
      expect(result.outcome, `${bytes} bytes`).toBe("verified");
      expect(w.events[0]).toBe("registry.findPasskeyByCredentialId");
    }
  });
});

describe("a pending-registration credential keeps its original recovery path", () => {
  let turnkey = new FakeParentTurnkey();
  beforeEach(() => {
    turnkey = new FakeParentTurnkey();
  });
  afterEach(() => {
    getWalletAccountsMock.mockReset();
    getSubOrgIdsMock.mockReset();
    getUsersMock.mockReset();
  });

  /** The existing crash window: a verified registration whose one Turnkey create has an unknown outcome. */
  async function stuck() {
    turnkey.submitMode = "network_error_before_apply";
    const events: string[] = [];
    const rawRegistry = createInMemoryRealAccountRegistry();
    const rawAttempts = createInMemoryRegistrationAttemptStore();
    const challengeStore = createInMemoryChallengeStore();
    const authenticator: FixtureAuthenticator = createFixtureAuthenticator();
    const { optionsJSON } = await beginRegistration({ config, challengeStore });
    const registered = await completeRegistration({ config, challengeStore, registry: rawRegistry, attempts: rawAttempts, provisioningDeps: turnkey.deps(), response: buildRegistrationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId }) });
    expect(registered).toEqual({ outcome: "pending", reason: PROVISIONING_NEEDS_REVIEW_REASON });
    const attempt = (await rawAttempts.findByCredentialId(authenticator.credentialIdBase64Url))!;
    const registry = recording(rawRegistry, "registry", events) as RealAccountRegistry;
    const attempts = recording(rawAttempts, "attempts", events) as RegistrationAttemptStore;
    const markers = createInMemoryLoginChallengeUseStore();
    const uses = recording(markers, "marker", events) as LoginChallengeUseStore;
    const response = async () => buildAuthenticationResponseJSON({ authenticator, challenge: (await beginLogin({ config })).optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId, userHandle: attempt.userHandle });
    const login = (r: AuthenticationResponseJSON) => completeLogin({ config, loginChallengeUses: uses, registry, attempts, response: r, publicClient: buildPublicClient(), provisioningDeps: turnkey.deps() });
    events.length = 0;
    return { events, markers, attempt, rawAttempts, authenticator, response, login };
  }

  it("a malformed envelope never reaches the attempt store, the marker store or the provisioning pipeline (no Turnkey request, no finalization)", async () => {
    const w = await stuck();
    const requestsBefore = turnkey.requests.length;
    const id = `${w.authenticator.credentialIdBase64Url}=`;
    const base = await w.response();
    for (const response of [
      { ...base, id, rawId: id },
      { ...base, rawId: GOOD_ID },
      { ...base, type: "password" },
      { ...base, response: { ...base.response, clientDataJSON: clientDataJSON({ type: "webauthn.create", challenge: (await beginLogin({ config })).optionsJSON.challenge }) } },
    ] as AuthenticationResponseJSON[]) {
      expect(await w.login(response)).toEqual(MALFORMED);
    }
    expect(w.events).toEqual([]);
    expect(w.markers.snapshot()).toEqual([]);
    expect(turnkey.requests.length).toBe(requestsBefore);
    expect((await w.rawAttempts.findByCredentialId(w.authenticator.credentialIdBase64Url))!.counter).toBe(w.attempt.counter);
  });

  it("a well-formed assertion still follows: active-passkey miss -> attempt lookup -> marker (after verification) -> counter -> the existing needs-review pipeline outcome", async () => {
    const w = await stuck();
    const result = await w.login(await w.response());
    expect(result).toEqual({ outcome: "pending", reason: PROVISIONING_NEEDS_REVIEW_REASON });
    expect(w.events.slice(0, 4)).toEqual(["registry.findPasskeyByCredentialId", "attempts.findByCredentialId", "marker.consume", "attempts.updateCounter"]);
    expect(w.markers.snapshot()).toHaveLength(1);
  });

  it("a replay of the same pending-registration assertion is still refused at the marker", async () => {
    const w = await stuck();
    const response = await w.response();
    expect((await w.login(response)).outcome).toBe("pending");
    expect(await w.login(response)).toEqual(UNKNOWN_CHALLENGE);
    expect(w.markers.snapshot()).toHaveLength(1);
  });
});

describe("the route: the same 401 and generic wording, and no runtime store is ever called for a malformed envelope", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/real/server/runtime");
    vi.unstubAllEnvs();
  });

  it("answers 401 'Malformed login response.' and calls no store method", async () => {
    vi.resetModules();
    const secret = "4be1c0d27a9f3e8d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170605";
    for (const [name, value] of Object.entries({
      NEXT_PUBLIC_REAL_MODE_ENABLED: "true",
      TURNKEY_PARENT_ORGANIZATION_ID: "p",
      TURNKEY_API_PUBLIC_KEY: "k",
      TURNKEY_API_PRIVATE_KEY: "k",
      REAL_SESSION_SECRET: secret,
      NEXT_PUBLIC_REAL_RP_ID: "localhost",
      NEXT_PUBLIC_REAL_ORIGIN: ORIGIN,
      PIMLICO_API_KEY: "x",
    })) vi.stubEnv(name, value);
    const methodCalls: string[] = [];
    const explode = (label: string) => new Proxy({}, { get: (_t, property) => (...args: unknown[]) => (methodCalls.push(`${label}.${String(property)}`), Promise.reject(new Error(`unexpected ${label} call ${args.length}`))) });
    vi.doMock("@/lib/real/server/runtime", () => ({
      getLoginChallengeUses: () => explode("marker"),
      getRealAccountRegistry: () => explode("registry"),
      getRegistrationAttemptStore: () => explode("attempts"),
      getAccountHandleStore: () => explode("handles"),
    }));
    const { POST } = await import("@/app/api/real/account/login/verify/route");
    const challenge = issueLoginChallenge({ sessionSecret: secret, rpId: "localhost" }).challenge;
    const id = `${GOOD_ID}=`;
    const response = {
      id,
      rawId: id,
      type: "public-key",
      response: { clientDataJSON: clientDataJSON({ type: "webauthn.get", challenge }), authenticatorData: "AA", signature: "AA", userHandle: USER_HANDLE },
      clientExtensionResults: {},
    };
    const result = await POST(new Request("http://localhost/api/real/account/login/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response }) }));
    expect(result.status).toBe(401);
    expect(await result.json()).toEqual({ error: "Malformed login response." });
    expect(methodCalls).toEqual([]);
  });
});
