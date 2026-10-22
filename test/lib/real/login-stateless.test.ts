import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealServerConfig } from "@/lib/real/server/config";
import { createInMemoryChallengeStore, type ChallengePurpose } from "@/lib/real/server/challenge-store";
import { createInMemoryRealAccountRegistry, type RealAccountRegistry } from "@/lib/real/server/registry";
import { createInMemoryRegistrationAttemptStore } from "@/lib/real/server/registration-attempts";
import { createInMemoryLoginChallengeUseStore, type LoginChallengeUseStore } from "@/lib/real/server/login-challenge-uses";
import { issueLoginChallenge, parseLoginChallenge } from "@/lib/real/server/login-challenge";
import { beginLogin, completeLogin } from "@/lib/real/server/login";
import { completeRegistration } from "@/lib/real/server/registration";
import { parseSession } from "@/lib/real/server/session";
import { bytesToBase64Url } from "@/lib/real/bytes";
import { buildAuthenticationResponseJSON, buildRegistrationResponseJSON, createFixtureAuthenticator, type FixtureAuthenticator } from "./fixtures/webauthn";

/**
 * Milestone 3C-2 — login verification with stateless challenges: ordering, replay, and isolation. Offline only: the
 * registry, the used-marker store, and the attempt store are in-memory fakes; no database, network, or provider exists here.
 */
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
const WRONG_WORDING = "Unknown, expired, or already-used login challenge.";

async function seedRegistry(authenticator: FixtureAuthenticator): Promise<RealAccountRegistry> {
  const registry = createInMemoryRealAccountRegistry();
  await registry.createAccountWithPasskey({
    account: { appUserId: "app-user-1", subOrganizationId: "sub-org-1", turnkeyUserId: "turnkey-user-1", walletId: "wallet-1", walletAccountId: "wallet-account-1", ownerAddress: "0xF6C3FE6DE636f0d8f421d5485D1a64fF3628CFaF", safeAddress: "0xd9a4c22fb34dc74317edc8006140d66c8fa03266", accountConfigVersion: 1 },
    passkey: { credentialId: authenticator.credentialIdBase64Url, appUserId: "app-user-1", credentialPublicKey: bytesToBase64Url(authenticator.publicKeyCose), userHandle: USER_HANDLE, counter: authenticator.counter, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false },
  });
  return registry;
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

async function world() {
  const authenticator = createFixtureAuthenticator();
  const events: string[] = [];
  const registry = recording(await seedRegistry(authenticator), "registry", events);
  const markers = createInMemoryLoginChallengeUseStore();
  const uses = recording(markers, "marker", events) as LoginChallengeUseStore;
  const attempts = createInMemoryRegistrationAttemptStore();
  const respond = (challenge: string, over: Partial<Parameters<typeof buildAuthenticationResponseJSON>[0]> = {}) =>
    buildAuthenticationResponseJSON({ authenticator, challenge, origin: ORIGIN, rpId: config.rpId, userHandle: USER_HANDLE, ...over });
  const login = (response: ReturnType<typeof respond>, over: { uses?: LoginChallengeUseStore; cfg?: RealServerConfig } = {}) =>
    completeLogin({ config: over.cfg ?? config, loginChallengeUses: over.uses ?? uses, registry, attempts, response });
  const fresh = async () => (await beginLogin({ config })).optionsJSON.challenge;
  const counter = async () => (await registry.findPasskeyByCredentialId(authenticator.credentialIdBase64Url))!.counter;
  return { authenticator, events, registry, markers, uses, attempts, respond, login, fresh, counter };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock("@/lib/real/server/runtime");
  vi.unstubAllEnvs();
});

describe("login/options — stateless: zero database requests, zero writes", () => {
  it("beginLogin takes no store at all, makes no network request, and returns a signed 78-character challenge for this RP ID", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("no network in this test")));
    vi.stubGlobal("fetch", fetchSpy);
    const { optionsJSON } = await beginLogin({ config });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(optionsJSON.challenge).toHaveLength(78);
    expect(parseLoginChallenge(optionsJSON.challenge, { sessionSecret: config.sessionSecret, rpId: config.rpId }).ok).toBe(true);
    expect(beginLogin.length).toBe(1); // one argument: {config, nowMs?} — nothing to write to
  });

  it("preserves the response contract (the same keys and fixed values the library-minted options had) and the discoverable-credential flow", async () => {
    const { optionsJSON } = await beginLogin({ config });
    const { buildLoginOptions } = await import("@/lib/real/server/webauthn");
    const legacy = await buildLoginOptions({ config }); // what login/options returned before 3C-2 (library-minted challenge)
    expect(Object.keys(optionsJSON).sort()).toEqual(Object.keys(legacy).sort());
    expect({ ...optionsJSON, challenge: "-" }).toEqual({ ...legacy, challenge: "-" });
    expect(optionsJSON.rpId).toBe("localhost");
    expect(optionsJSON.userVerification).toBe("required");
    expect(optionsJSON.allowCredentials).toBeUndefined();
    expect(optionsJSON.timeout).toBe(60000);
  });

  it("every token is distinct", async () => {
    const challenges = await Promise.all(Array.from({ length: 50 }, () => beginLogin({ config }).then((r) => r.optionsJSON.challenge)));
    expect(new Set(challenges).size).toBe(50);
  });

  it("the ROUTE touches no runtime getter at all: it answers 200 with { optionsJSON } even when EVERY store getter explodes", async () => {
    vi.resetModules();
    for (const [name, value] of Object.entries({
      NEXT_PUBLIC_REAL_MODE_ENABLED: "true",
      TURNKEY_PARENT_ORGANIZATION_ID: "p",
      TURNKEY_API_PUBLIC_KEY: "k",
      TURNKEY_API_PRIVATE_KEY: "k",
      REAL_SESSION_SECRET: "4be1c0d27a9f3e8d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170605",
      NEXT_PUBLIC_REAL_RP_ID: "localhost",
      NEXT_PUBLIC_REAL_ORIGIN: ORIGIN,
      PIMLICO_API_KEY: "x",
    })) vi.stubEnv(name, value);
    const touched: string[] = [];
    vi.doMock("@/lib/real/server/runtime", () => new Proxy({}, { get: (_t, property) => (touched.push(String(property)), () => Promise.reject(new Error("a store was touched"))) }));
    const { POST } = await import("@/app/api/real/account/login/options/route");
    const response = await POST();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { optionsJSON: { challenge: string } };
    expect(body.optionsJSON.challenge).toHaveLength(78);
    expect(touched).toEqual([]);
  });
});

describe("login/verify — an INVALID attempt can never create a used marker, update a counter, or open a session", () => {
  async function expectNothingWritten(w: Awaited<ReturnType<typeof world>>, before: number) {
    expect(w.markers.snapshot()).toEqual([]);
    expect(await w.counter()).toBe(before);
    expect(w.events.filter((event) => event.startsWith("marker."))).toEqual([]);
    expect(w.events).not.toContain("registry.updateAuthenticatorCounter");
  }

  it("a challenge that is not a signed token (including a random library-style challenge): rejected with ZERO database requests", async () => {
    const w = await world();
    for (const challenge of ["Y2hhbGxlbmdlLWZvci10ZXN0cw", "", "x".repeat(78), await w.fresh().then((c) => c.slice(0, 77)), "AQEAAAGjGGDj4AABAgMEBQYHCAkKCwwNDg_4Q5r60PqK29bo85IHp2QIgzW9t81boMVCwpaGqrdvCA"]) {
      w.events.length = 0;
      expect(await w.login(w.respond(challenge))).toEqual({ outcome: "rejected", reason: WRONG_WORDING });
      expect(w.events, challenge.slice(0, 8)).toEqual([]); // the registry and the marker store were never even asked
    }
  });

  it("a forged MAC and a modified expiration: rejected before any database request", async () => {
    const w = await world();
    const good = Buffer.from(await w.fresh(), "base64url");
    const forged = Buffer.from(good);
    forged[40] = forged[40]! ^ 0xff;
    const longer = Buffer.from(good);
    longer.writeBigUInt64BE(longer.readBigUInt64BE(2) + BigInt(60_000), 2);
    for (const bytes of [forged, longer]) {
      w.events.length = 0;
      expect(await w.login(w.respond(bytes.toString("base64url")))).toEqual({ outcome: "rejected", reason: WRONG_WORDING });
      expect(w.events).toEqual([]);
    }
  });

  it("an expired token and a token for another RP ID or another secret: rejected before any database request", async () => {
    const w = await world();
    const expired = (await beginLogin({ config, nowMs: Date.now() - 6 * 60_000 })).optionsJSON.challenge;
    const otherRp = issueLoginChallenge({ sessionSecret: config.sessionSecret, rpId: "other.example" }).challenge;
    const otherSecret = issueLoginChallenge({ sessionSecret: "rotated-secret", rpId: config.rpId }).challenge;
    for (const challenge of [expired, otherRp, otherSecret]) {
      w.events.length = 0;
      expect(await w.login(w.respond(challenge))).toEqual({ outcome: "rejected", reason: WRONG_WORDING });
      expect(w.events).toEqual([]);
    }
  });

  it("an unknown credential: no marker", async () => {
    const w = await world();
    const stranger = createFixtureAuthenticator();
    const challenge = await w.fresh();
    const result = await w.login(buildAuthenticationResponseJSON({ authenticator: stranger, challenge, origin: ORIGIN, rpId: config.rpId, userHandle: USER_HANDLE }));
    expect(result.outcome).toBe("rejected");
    await expectNothingWritten(w, w.authenticator.counter);
  });

  it("a wrong userHandle and a missing userHandle: no marker", async () => {
    const w = await world();
    for (const userHandle of ["someone-else", undefined]) {
      const result = await w.login(w.respond(await w.fresh(), { userHandle }));
      expect(result.outcome).toBe("rejected");
    }
    await expectNothingWritten(w, w.authenticator.counter);
  });

  it("a revoked / pending-status passkey: no marker", async () => {
    const w = await world();
    const credentialId = w.authenticator.credentialIdBase64Url;
    const real = await w.registry.findPasskeyByCredentialId(credentialId);
    const revoked = { ...w.registry, findPasskeyByCredentialId: async () => ({ ...real!, status: "revoked" as const }) } as RealAccountRegistry;
    const result = await completeLogin({ config, loginChallengeUses: w.uses, registry: revoked, attempts: w.attempts, response: w.respond(await w.fresh()) });
    expect(result).toEqual({ outcome: "rejected", reason: "Unknown or revoked passkey." });
    await expectNothingWritten(w, w.authenticator.counter);
  });

  it("a wrong signature (one character of the signature altered): no marker, no counter update", async () => {
    const w = await world();
    const response = w.respond(await w.fresh());
    const signature = response.response.signature;
    const tampered = { ...response, response: { ...response.response, signature: `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}` } };
    const result = await w.login(tampered);
    expect(result).toEqual({ outcome: "rejected", reason: "Login could not be verified." });
    await expectNothingWritten(w, w.authenticator.counter);
  });

  it("a wrong origin and a wrong RP ID (authenticator data for another site): no marker", async () => {
    const w = await world();
    expect((await w.login(w.respond(await w.fresh(), { origin: "http://evil.example" }))).outcome).toBe("rejected");
    expect((await w.login(w.respond(await w.fresh(), { rpId: "evil.example" }))).outcome).toBe("rejected");
    await expectNothingWritten(w, w.authenticator.counter);
  });

  it("missing user verification: no marker", async () => {
    const w = await world();
    const result = await w.login(w.respond(await w.fresh(), { userVerified: false }));
    expect(result.outcome).toBe("rejected");
    await expectNothingWritten(w, w.authenticator.counter);
  });

  it("an assertion whose challenge field is not the one in the signed client data (a swapped challenge): no marker", async () => {
    const w = await world();
    const a = await w.fresh();
    const b = await w.fresh();
    const response = w.respond(a);
    // Same signature material, but verified against a DIFFERENT (valid) token: the library's own challenge comparison refuses it.
    const swapped = { ...w.respond(b), response: { ...w.respond(b).response, signature: response.response.signature } };
    expect((await w.login(swapped)).outcome).toBe("rejected");
    await expectNothingWritten(w, w.authenticator.counter);
  });
});

describe("login/verify — a valid login consumes the challenge exactly once, before the counter, the account, and the session", () => {
  it("success: one marker holding the token's nonce, one counter update, one session; the event order is verify -> marker -> counter -> account", async () => {
    const w = await world();
    const challenge = await w.fresh();
    const parsed = parseLoginChallenge(challenge, { sessionSecret: config.sessionSecret, rpId: config.rpId });
    if (!parsed.ok) throw new Error("fresh token must parse");
    const result = await w.login(w.respond(challenge, { counterOverride: 5 }));
    expect(result.outcome).toBe("verified");
    expect(w.markers.snapshot()).toHaveLength(1);
    expect(w.markers.snapshot()[0]).toMatchObject({ nonceHex: parsed.nonceHex, expiresAtMs: parsed.expiresAtMs });
    expect(w.events.filter((e) => /^(marker\.consume|registry\.updateAuthenticatorCounter|registry\.findAccountByAppUserId)$/.test(e))).toEqual(["marker.consume", "registry.updateAuthenticatorCounter", "registry.findAccountByAppUserId"]);
    expect(await w.counter()).toBe(5);
    if (result.outcome !== "verified") return;
    expect(parseSession(result.sessionCookie, config.sessionSecret)).toMatchObject({ appUserId: "app-user-1" });
  });

  it("sequential replay of the SAME assertion: the second is rejected AT THE MARKER (zero-counter authenticators, which the library's counter check exempts), and the counter is written once", async () => {
    const w = await world();
    const response = w.respond(await w.fresh()); // counter 0 -> the library cannot catch the replay; only the used marker can
    expect((await w.login(response)).outcome).toBe("verified");
    expect(await w.login(response)).toEqual({ outcome: "rejected", reason: WRONG_WORDING });
    expect(w.events.filter((e) => e === "registry.updateAuthenticatorCounter")).toHaveLength(1);
    expect(w.events.filter((e) => e === "marker.consume")).toHaveLength(2); // the second attempt reached the marker and lost
    expect(w.markers.snapshot()).toHaveLength(1);
  });

  it("sequential replay with a nonzero counter is stopped even earlier, by the unchanged counter check — and writes no second marker", async () => {
    const w = await world();
    const response = w.respond(await w.fresh(), { counterOverride: 7 });
    expect((await w.login(response)).outcome).toBe("verified");
    expect(await w.login(response)).toEqual({ outcome: "rejected", reason: "Login could not be verified." });
    expect(w.markers.snapshot()).toHaveLength(1);
  });

  it("60 parallel uses of the same assertion: exactly one session, one counter write, one marker", async () => {
    const w = await world();
    const response = w.respond(await w.fresh()); // zero counter: every parallel copy passes the library, so ONLY the marker decides
    const results = await Promise.all(Array.from({ length: 60 }, () => w.login(response)));
    expect(results.filter((r) => r.outcome === "verified")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "rejected")).toHaveLength(59);
    expect(w.events.filter((e) => e === "registry.updateAuthenticatorCounter")).toHaveLength(1);
    expect(w.markers.snapshot()).toHaveLength(1);
  });

  it("two DIFFERENT valid challenges both succeed (the marker is per-challenge, not a global login limit)", async () => {
    const w = await world();
    expect((await w.login(w.respond(await w.fresh(), { counterOverride: 1 }))).outcome).toBe("verified");
    expect((await w.login(w.respond(await w.fresh(), { counterOverride: 2 }))).outcome).toBe("verified");
    expect(w.markers.snapshot()).toHaveLength(2);
  });

  it("a marker store that answers 'rejected' (zero rows, or live === false): rejected with the existing wording; no counter update; no session", async () => {
    const w = await world();
    const refusing: LoginChallengeUseStore = { consume: async () => "rejected" };
    const result = await w.login(w.respond(await w.fresh()), { uses: refusing });
    expect(result).toEqual({ outcome: "rejected", reason: WRONG_WORDING });
    expect(w.events).not.toContain("registry.updateAuthenticatorCounter");
    expect(w.events).not.toContain("registry.findAccountByAppUserId");
  });

  it("a marker store that THROWS, or answers something malformed: completeLogin throws (the route's generic 500) — no counter, no account read, no session, no retry", async () => {
    for (const bad of [async (): Promise<never> => Promise.reject(new Error("db down")), async () => "maybe" as never, async () => undefined as never, async () => ({ live: true }) as never]) {
      const w = await world();
      let calls = 0;
      const store: LoginChallengeUseStore = { consume: async () => (calls += 1, bad()) };
      await expect(w.login(w.respond(await w.fresh()), { uses: store })).rejects.toThrow();
      expect(calls).toBe(1); // never retried
      expect(w.events).not.toContain("registry.updateAuthenticatorCounter");
      expect(w.events).not.toContain("registry.findAccountByAppUserId");
    }
  });

  it("a counter-update failure AFTER the marker: no session, the marker stays consumed, and a retry of the same assertion is rejected", async () => {
    const w = await world();
    const failing = { ...w.registry, updateAuthenticatorCounter: async () => Promise.reject(new Error("counter write failed")) } as unknown as RealAccountRegistry;
    const response = w.respond(await w.fresh(), { counterOverride: 3 });
    await expect(completeLogin({ config, loginChallengeUses: w.uses, registry: failing, attempts: w.attempts, response })).rejects.toThrow("counter write failed");
    expect(w.markers.snapshot()).toHaveLength(1);
    expect(await w.login(response)).toEqual({ outcome: "rejected", reason: WRONG_WORDING });
  });

  it("an account-lookup failure AFTER the marker (no account): rejected, no session, the marker stays consumed", async () => {
    const w = await world();
    const noAccount = { ...w.registry, findAccountByAppUserId: async () => null } as unknown as RealAccountRegistry;
    const response = w.respond(await w.fresh());
    const result = await completeLogin({ config, loginChallengeUses: w.uses, registry: noAccount, attempts: w.attempts, response });
    expect(result).toEqual({ outcome: "rejected", reason: "No account is associated with this passkey." });
    expect(w.markers.snapshot()).toHaveLength(1);
    expect(await w.login(response)).toEqual({ outcome: "rejected", reason: WRONG_WORDING });
  });

  it("secret rotation: a challenge issued before the rotation cannot complete a login after it", async () => {
    const w = await world();
    const challenge = await w.fresh();
    const rotated = { ...config, sessionSecret: "a-newly-rotated-secret" };
    expect(await w.login(w.respond(challenge), { cfg: rotated })).toEqual({ outcome: "rejected", reason: WRONG_WORDING });
    expect(w.markers.snapshot()).toEqual([]);
  });

  it("the sign-counter boundary is UNCHANGED: a regressed counter is still refused by the library's check, with no marker (the existing unconditional-write issue is out of scope and untouched)", async () => {
    const w = await world();
    expect((await w.login(w.respond(await w.fresh(), { counterOverride: 10 }))).outcome).toBe("verified");
    const result = await w.login(w.respond(await w.fresh(), { counterOverride: 4 }));
    expect(result).toEqual({ outcome: "rejected", reason: "Login could not be verified." });
    expect(w.markers.snapshot()).toHaveLength(1); // only the successful login left a marker
  });
});

describe("cross-ceremony isolation", () => {
  const OTHER_PURPOSES: ChallengePurpose[] = ["registration", "login", "backup_registration", "backup_login_verification", "backup_step_up", "handle_claim"];

  it("a login token is not accepted by ANY database-backed ceremony (it is simply not in that store)", async () => {
    const store = createInMemoryChallengeStore();
    const token = issueLoginChallenge({ sessionSecret: config.sessionSecret, rpId: config.rpId }).challenge;
    for (const purpose of OTHER_PURPOSES) expect(await store.consume({ challenge: token, purpose }), purpose).toBeNull();
  });

  it("registration verify refuses an assertion-style login token as its challenge", async () => {
    const registrationStore = createInMemoryChallengeStore();
    const token = issueLoginChallenge({ sessionSecret: config.sessionSecret, rpId: config.rpId }).challenge;
    const attempts = createInMemoryRegistrationAttemptStore();
    const registry = createInMemoryRealAccountRegistry();
    const authenticator = createFixtureAuthenticator();
    const result = await completeRegistration({ config, challengeStore: registrationStore, registry, attempts, response: buildRegistrationResponseJSON({ authenticator, challenge: token, origin: ORIGIN, rpId: config.rpId }) });
    expect(result).toEqual({ outcome: "rejected", reason: "Unknown, expired, or already-used registration challenge." });
    expect(await attempts.findByCredentialId(authenticator.credentialIdBase64Url)).toBeNull();
  });

  it("an OLD database-backed login challenge (or any other ceremony's challenge) is rejected by login verify — there is no fallback", async () => {
    const w = await world();
    const store = createInMemoryChallengeStore();
    const legacy = await store.create({ challenge: "bGVnYWN5LWRhdGFiYXNlLWxvZ2luLWNoYWxsZW5nZQ", purpose: "login", ttlMs: 60_000 });
    const result = await w.login(w.respond(legacy.challenge));
    expect(result).toEqual({ outcome: "rejected", reason: WRONG_WORDING });
    expect(w.events).toEqual([]);
    expect(await store.consume({ challenge: legacy.challenge, purpose: "login" })).not.toBeNull(); // login verify never touched the database store
  });

  it("login verify no longer reads or writes the database ChallengeStore: completeLogin has no such parameter", () => {
    // Type-level and runtime: the input object has loginChallengeUses and no challengeStore.
    expect(completeLogin.length).toBe(1);
  });
});
