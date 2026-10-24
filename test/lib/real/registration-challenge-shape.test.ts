// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, encodeAbiParameters, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { base64UrlToBytes, bytesToBase64Url } from "@/lib/real/bytes";
import { createInMemoryChallengeStore, type ChallengeStore } from "@/lib/real/server/challenge-store";
import type { RealServerConfig } from "@/lib/real/server/config";
import { beginRegistration, completeRegistration as completeRegistrationWithDeps } from "@/lib/real/server/registration";
import { createInMemoryRegistrationAttemptStore, type RegistrationAttemptStore } from "@/lib/real/server/registration-attempts";
import { createInMemoryRealAccountRegistry, type RealAccountRegistry } from "@/lib/real/server/registry";
import { buildRegistrationResponseJSON, createFixtureAuthenticator } from "./fixtures/webauthn";
import { FakeParentTurnkey } from "./fixtures/turnkey-parent-fake";

/**
 * Milestone 3C-3b (A-E2): canonical registration-challenge SHAPE validation. A malformed challenge is refused — with the SAME rejection
 * as an unknown one — before challengeStore.consume, and the options step refuses to issue a non-canonical library challenge. OFFLINE
 * ONLY: the in-memory stores, the fake parent Turnkey, mocked route dependencies. This is input-shape hardening, not a rate limiter.
 */
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
const UNKNOWN = { outcome: "rejected", reason: "Unknown, expired, or already-used registration challenge." } as const;

// ---- the library-challenge override used by the options-side tests (default: pass the library's own challenge through)
const override = vi.hoisted(() => ({ challenge: null as string | null }));
vi.mock("@/lib/real/server/webauthn", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/real/server/webauthn")>();
  return {
    ...original,
    buildRegistrationOptions: async (input: Parameters<typeof original.buildRegistrationOptions>[0]) => {
      const options = await original.buildRegistrationOptions(input);
      return override.challenge === null ? options : { ...options, challenge: override.challenge };
    },
  };
});

// ---- route dependencies (the real routes, with in-memory stores and no cookies)
const route = vi.hoisted(() => ({ challengeStore: null as unknown, registry: null as unknown, attempts: null as unknown, admitted: true }));
vi.mock("@/lib/real/server/runtime", () => ({
  getChallengeStore: () => route.challengeStore,
  getRealAccountRegistry: () => route.registry,
  getRegistrationAttemptStore: () => route.attempts,
  getRegistrationAdmission: () => ({ admit: async () => (route.admitted ? { admitted: true } : { admitted: false, retryAfterSeconds: 60 }) }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }) }));

let turnkey = new FakeParentTurnkey();
beforeEach(() => {
  turnkey = new FakeParentTurnkey();
  override.challenge = null;
  route.challengeStore = null;
  route.registry = null;
  route.attempts = null;
  route.admitted = true;
  turnkey.submitMode = "completed";
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

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

/** Every method call on the object is counted. The methods are wrapped IN PLACE so the object keeps its identity (the in-memory stores key on it). */
function counted<T extends object>(target: T, calls: string[], label: string): T {
  const record = target as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (typeof value !== "function") continue;
    record[key] = (...args: unknown[]) => (calls.push(`${label}.${key}`), (value as (...a: unknown[]) => unknown).apply(target, args));
  }
  return target;
}
function world() {
  const calls: string[] = [];
  const baseChallenges = createInMemoryChallengeStore();
  const consumeResults: Array<"stored" | "null"> = [];
  const challengeStore: ChallengeStore = {
    create: async (input) => (calls.push("challengeStore.create"), baseChallenges.create(input)),
    consume: async (input) => {
      calls.push("challengeStore.consume");
      const stored = await baseChallenges.consume(input);
      consumeResults.push(stored ? "stored" : "null");
      return stored;
    },
    // Any other method an implementation offers is counted too.
    ...Object.fromEntries(Object.entries(baseChallenges).filter(([key]) => key !== "create" && key !== "consume").map(([key, value]) => [key, typeof value === "function" ? (...args: unknown[]) => (calls.push(`challengeStore.${key}`), (value as (...a: unknown[]) => unknown)(...args)) : value])),
  } as ChallengeStore;
  const registry = counted<RealAccountRegistry>(createInMemoryRealAccountRegistry(), calls, "registry");
  const attempts = counted<RegistrationAttemptStore>(createInMemoryRegistrationAttemptStore(), calls, "attempts");
  const complete = (response: RegistrationResponseJSON) => completeRegistrationWithDeps({ config, challengeStore, registry, attempts, response, publicClient: buildPublicClient(), provisioningDeps: turnkey.deps() });
  return { calls, baseChallenges, consumeResults, challengeStore, registry, attempts, complete };
}

/** A registration response whose clientDataJSON carries exactly the given JSON members (so a non-string or missing challenge can be sent). */
function responseWithClientData(members: Record<string, unknown>): RegistrationResponseJSON {
  const authenticator = createFixtureAuthenticator();
  const base = buildRegistrationResponseJSON({ authenticator, challenge: "placeholder", origin: ORIGIN, rpId: config.rpId });
  const clientDataJSON = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ type: "webauthn.create", origin: ORIGIN, ...members })));
  return { ...base, response: { ...base.response, clientDataJSON } };
}
const responseWithChallenge = (challenge: string) => buildRegistrationResponseJSON({ authenticator: createFixtureAuthenticator(), challenge, origin: ORIGIN, rpId: config.rpId });

const CANONICAL = bytesToBase64Url(new Uint8Array(32).map((_, index) => index * 7 + 3));
const ZEROS = "A".repeat(43); // 32 zero bytes, canonical
// CANONICAL ends in "w" (index 48, spare bits 00); "x" (index 49) sets a spare bit, so it decodes to the SAME 32 bytes but is not canonical.
const CANONICAL_SPARE_BIT_SET = `${CANONICAL.slice(0, 42)}x`;

describe("A, B, M: canonical challenges keep working, and a well-formed unknown one still reaches the atomic consume exactly once", () => {
  it("A: a challenge issued by beginRegistration is 43 characters of canonical base64url for exactly 32 bytes — the shape the validator accepts", async () => {
    const w = world();
    for (let i = 0; i < 25; i += 1) {
      const { optionsJSON } = await beginRegistration({ config, challengeStore: w.challengeStore });
      expect(optionsJSON.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(base64UrlToBytes(optionsJSON.challenge)).toHaveLength(32);
      expect(bytesToBase64Url(base64UrlToBytes(optionsJSON.challenge))).toBe(optionsJSON.challenge);
      expect(await w.baseChallenges.consume({ challenge: optionsJSON.challenge, purpose: "registration" })).not.toBeNull(); // and it really was stored
    }
  });

  it("B: a valid registration completes normally (WebAuthn verification, durable attempt, provisioning, activation), consuming exactly once", async () => {
    const w = world();
    const { optionsJSON } = await beginRegistration({ config, challengeStore: w.challengeStore });
    const authenticator = createFixtureAuthenticator();
    const response = buildRegistrationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId });
    w.calls.length = 0;
    const result = await w.complete(response);
    expect(result.outcome).toBe("verified");
    expect(w.calls.filter((call) => call === "challengeStore.consume")).toHaveLength(1);
    expect(w.consumeResults).toEqual(["stored"]);
    expect(turnkey.createRequests).toHaveLength(1);
    expect((await w.attempts.findByCredentialId(authenticator.credentialIdBase64Url))?.state).toBe("active");
    expect((await w.registry.findPasskeyByCredentialId(authenticator.credentialIdBase64Url))?.status).toBe("active");
  });

  it("M/N: a canonical but NONEXISTENT challenge reaches consume exactly once (with the registration purpose) and gets the unchanged rejection", async () => {
    const w = world();
    const consume = vi.spyOn(w.challengeStore, "consume");
    expect(await w.complete(responseWithChallenge(CANONICAL))).toEqual(UNKNOWN);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledWith({ challenge: CANONICAL, purpose: "registration" });
    expect(turnkey.requests).toHaveLength(0);
  });
});

describe("C–L, O: a malformed challenge is refused with the SAME rejection and ZERO store, registry, attempt or provider work", () => {
  const spare = (canonical: string, replacement: string) => canonical.slice(0, -1) + replacement;
  const cases: Array<[string, RegistrationResponseJSON]> = [
    ["C: a missing challenge member", responseWithClientData({})],
    ["D: null", responseWithClientData({ challenge: null })],
    ["D: a number", responseWithClientData({ challenge: 12345 })],
    ["D: a boolean", responseWithClientData({ challenge: true })],
    ["D: an object", responseWithClientData({ challenge: { value: CANONICAL } })],
    ["D: an array holding a canonical value", responseWithClientData({ challenge: [CANONICAL] })],
    ["the empty string", responseWithClientData({ challenge: "" })],
    ["E: 42 characters", responseWithClientData({ challenge: CANONICAL.slice(0, 42) })],
    ["F: 44 characters", responseWithClientData({ challenge: `${CANONICAL}A` })],
    ["G: padded to 44 with =", responseWithClientData({ challenge: `${CANONICAL}=` })],
    ["G: 42 characters plus one =", responseWithClientData({ challenge: `${CANONICAL.slice(0, 42)}=` })],
    ["H: standard-alphabet + at 43 characters", responseWithClientData({ challenge: `${CANONICAL.slice(0, 20)}+${CANONICAL.slice(21)}` })],
    ["H: standard-alphabet / at 43 characters", responseWithClientData({ challenge: `${CANONICAL.slice(0, 20)}/${CANONICAL.slice(21)}` })],
    ["I: an inner space", responseWithClientData({ challenge: `${CANONICAL.slice(0, 20)} ${CANONICAL.slice(21)}` })],
    ["I: a trailing newline (44)", responseWithClientData({ challenge: `${CANONICAL}\n` })],
    ["I: a newline replacing the final character (exactly 43)", responseWithClientData({ challenge: `${CANONICAL.slice(0, 42)}\n` })],
    ["I: a tab replacing a character", responseWithClientData({ challenge: `${CANONICAL.slice(0, 42)}\t` })],
    ["I: a leading space (44)", responseWithClientData({ challenge: ` ${CANONICAL}` })],
    ["J: a NUL character at 43 characters", responseWithClientData({ challenge: `${CANONICAL.slice(0, 42)}\u0000` })],
    ["J: an embedded NUL", responseWithClientData({ challenge: `${CANONICAL.slice(0, 20)}\u0000${CANONICAL.slice(21)}` })],
    ["a non-ASCII look-alike at 43 characters", responseWithClientData({ challenge: `${CANONICAL.slice(0, 42)}é` })],
    ["a 43-character value with a punctuation character", responseWithClientData({ challenge: `${CANONICAL.slice(0, 42)}!` })],
    ["K: an oversized value (1 MiB)", responseWithClientData({ challenge: "A".repeat(1024 * 1024) })],
    ["K: an oversized value with invalid characters", responseWithClientData({ challenge: "+".repeat(200_000) })],
    ["L: a noncanonical final character (spare bits 01)", responseWithClientData({ challenge: spare(ZEROS, "B") })],
    ["L: a noncanonical final character (spare bits 10)", responseWithClientData({ challenge: spare(ZEROS, "C") })],
    ["L: a noncanonical final character (spare bits 11)", responseWithClientData({ challenge: spare(ZEROS, "D") })],
    ["L: a noncanonical final character on a real value (spare bit set)", responseWithClientData({ challenge: CANONICAL_SPARE_BIT_SET })],
  ];

  it.each(cases)("%s -> the unchanged rejection; no consume, no create, no registry/attempt call, no provider request", async (_label, response) => {
    const w = world();
    expect(await w.complete(response)).toEqual(UNKNOWN);
    expect(w.calls).toEqual([]);
    expect(w.consumeResults).toEqual([]);
    expect(turnkey.requests).toHaveLength(0);
  });

  it("L: the noncanonical trailing-bit values REALLY are accepted by a lenient decoder — so only the re-encoding check can refuse them", () => {
    const strict = ZEROS;
    for (const last of ["B", "C", "D"]) {
      const lenient = spare(strict, last);
      expect(lenient).not.toBe(strict);
      expect(Buffer.from(lenient, "base64url").equals(Buffer.from(strict, "base64url"))).toBe(true); // Node accepts it as the same 32 bytes
      expect(base64UrlToBytes(lenient)).toHaveLength(32); // so does the repository's own decoder
      expect(bytesToBase64Url(base64UrlToBytes(lenient))).toBe(strict); // ...and re-encoding does not reproduce the input
    }
    // Only the last character has spare bits: the 32nd byte ends at bit 256, so 43 characters carry 258 bits.
    expect(43 * 6 - 32 * 8).toBe(2);
  });

  it("L: the explicit spare-bit value really is a noncanonical spelling of CANONICAL", () => {
    expect(CANONICAL.endsWith("w")).toBe(true);
    expect(CANONICAL_SPARE_BIT_SET).not.toBe(CANONICAL);
    expect(Buffer.from(CANONICAL_SPARE_BIT_SET, "base64url").equals(Buffer.from(CANONICAL, "base64url"))).toBe(true);
    expect(bytesToBase64Url(base64UrlToBytes(CANONICAL_SPARE_BIT_SET))).toBe(CANONICAL);
  });

  it("K: cheap checks run BEFORE any decoding or allocation — an oversized, wrong-length, or bad-alphabet value never reaches atob or a decoder", async () => {
    const w = world();
    const responses = ["A".repeat(1024 * 1024), "+".repeat(200_000), CANONICAL.slice(0, 42), `${CANONICAL}A`, `${CANONICAL.slice(0, 42)}=`, `${CANONICAL.slice(0, 20)}+${CANONICAL.slice(21)}`].map(responseWithChallenge);
    const atob = vi.spyOn(globalThis, "atob"); // armed only after the fixtures (which encode and decode freely) have been built
    for (const response of responses) {
      expect(await w.complete(response)).toEqual(UNKNOWN);
    }
    expect(atob).not.toHaveBeenCalled();
    expect(w.calls).toEqual([]);
  });

  it("N: the rejection is byte-for-byte the one an unknown challenge gets — nothing reveals whether a challenge exists", async () => {
    const w = world();
    const unknown = await w.complete(responseWithChallenge(CANONICAL));
    const malformed = await w.complete(responseWithChallenge(CANONICAL.slice(0, 42)));
    expect(JSON.stringify(malformed)).toBe(JSON.stringify(unknown));
    expect(Object.keys(malformed).sort()).toEqual(["outcome", "reason"]);
    // A malformed clientDataJSON keeps its own, older rejection (it is not a challenge-shape failure).
    const garbled = { ...responseWithChallenge(CANONICAL), response: { clientDataJSON: "not-valid-base64!!!", attestationObject: "x" } } as RegistrationResponseJSON;
    expect(await w.complete(garbled)).toEqual({ outcome: "rejected", reason: "Malformed registration response." });
  });

  it("N: through the real verify route the malformed and the unknown challenge are the same 400 with the same body", async () => {
    vi.stubEnv("NEXT_PUBLIC_REAL_MODE_ENABLED", "true");
    vi.stubEnv("TURNKEY_PARENT_ORGANIZATION_ID", "parent-org");
    vi.stubEnv("TURNKEY_API_PUBLIC_KEY", "public-key");
    vi.stubEnv("TURNKEY_API_PRIVATE_KEY", "private-key");
    vi.stubEnv("REAL_SESSION_SECRET", "4be1c0d27a9f3e8d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170605");
    vi.stubEnv("NEXT_PUBLIC_REAL_RP_ID", "localhost");
    vi.stubEnv("NEXT_PUBLIC_REAL_ORIGIN", ORIGIN);
    vi.stubEnv("PIMLICO_API_KEY", "pim_test_key");
    const w = world();
    route.challengeStore = w.challengeStore;
    route.registry = w.registry;
    route.attempts = w.attempts;
    const { POST } = await import("@/app/api/real/account/register/verify/route");
    const post = (response: RegistrationResponseJSON) => POST(new Request("http://localhost/api/real/account/register/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response }) }));
    const unknown = await post(responseWithChallenge(CANONICAL));
    w.calls.length = 0;
    const malformed = await post(responseWithChallenge(`${CANONICAL}=`));
    expect([unknown.status, malformed.status]).toEqual([400, 400]);
    expect(await malformed.json()).toEqual(await unknown.json());
    expect(w.calls).toEqual([]); // and the malformed request touched nothing
  });
});

describe("E, F, P, Q: consumption stays atomic and one-time", () => {
  it("P: a successfully consumed challenge cannot be replayed, and nothing is provisioned twice", async () => {
    const w = world();
    const { optionsJSON } = await beginRegistration({ config, challengeStore: w.challengeStore });
    const response = buildRegistrationResponseJSON({ authenticator: createFixtureAuthenticator(), challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId });
    expect((await w.complete(response)).outcome).toBe("verified");
    expect(await w.complete(response)).toEqual(UNKNOWN);
    expect(turnkey.createRequests).toHaveLength(1);
    expect(w.consumeResults).toEqual(["stored", "null"]);
  });

  it("E: a verification that FAILS still consumed the challenge — the same challenge cannot be reused afterwards", async () => {
    const w = world();
    const { optionsJSON } = await beginRegistration({ config, challengeStore: w.challengeStore });
    const bad = buildRegistrationResponseJSON({ authenticator: createFixtureAuthenticator(), challenge: optionsJSON.challenge, origin: "http://evil.example", rpId: config.rpId });
    expect(await w.complete(bad)).toEqual({ outcome: "rejected", reason: "Registration could not be verified." });
    const good = buildRegistrationResponseJSON({ authenticator: createFixtureAuthenticator(), challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId });
    expect(await w.complete(good)).toEqual(UNKNOWN);
    expect(turnkey.requests).toHaveLength(0);
  });

  it("F/Q: two concurrent verifies of the same challenge — at most one consume succeeds, one account is created, one create is sent", async () => {
    const w = world();
    const { optionsJSON } = await beginRegistration({ config, challengeStore: w.challengeStore });
    const authenticator = createFixtureAuthenticator();
    const response = buildRegistrationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId });
    const results = await Promise.all([w.complete(response), w.complete(response), w.complete(response)]);
    expect(w.consumeResults.filter((result) => result === "stored")).toHaveLength(1);
    expect(w.consumeResults.filter((result) => result === "null")).toHaveLength(2);
    expect(results.filter((result) => result.outcome === "verified")).toHaveLength(1);
    expect(results.filter((result) => JSON.stringify(result) === JSON.stringify(UNKNOWN))).toHaveLength(2);
    expect(turnkey.createRequests).toHaveLength(1);
    expect((await w.attempts.findByCredentialId(authenticator.credentialIdBase64Url))?.state).toBe("active");
  });

  it("the consume path itself is unchanged: the atomic DELETE ... RETURNING is the only one-time guarantee, and no read-before-delete was added", async () => {
    const { readFileSync } = await import("node:fs");
    const registration = readFileSync("lib/real/server/registration.ts", "utf8");
    expect(registration.match(/challengeStore\.consume\(/g)).toHaveLength(1);
    expect(registration).toContain('await input.challengeStore.consume({ challenge: clientData.challenge, purpose: "registration" });');
    const store = readFileSync("lib/real/server/neon-store.ts", "utf8");
    expect(store).toMatch(/DELETE FROM webauthn_challenges[\s\S]{0,400}RETURNING/);
    // The shape check sits strictly between decoding clientDataJSON and the consume, and everything after the consume is as before.
    const decode = registration.indexOf("decodeClientDataJSON(input.response.response.clientDataJSON)");
    const shape = registration.indexOf("if (!isCanonicalRegistrationChallenge(clientData.challenge))");
    const consume = registration.indexOf("input.challengeStore.consume(");
    const verify = registration.indexOf("await verifyRegistration(");
    expect(decode).toBeGreaterThan(0);
    expect([decode, shape, consume, verify].every((index) => index > 0) && decode < shape && shape < consume && consume < verify).toBe(true);
  });
});

describe("R, S: the options step refuses to issue a non-canonical library challenge, fails generically, and saves nothing", () => {
  const malformedLibraryChallenges: Array<[string, string]> = [
    ["42 characters", CANONICAL.slice(0, 42)],
    ["44 characters", `${CANONICAL}A`],
    ["padded", `${CANONICAL.slice(0, 42)}=`],
    ["standard alphabet", `${CANONICAL.slice(0, 20)}+${CANONICAL.slice(21)}`],
    ["noncanonical trailing bits", `${"A".repeat(42)}B`],
    ["empty", ""],
    ["whitespace", `${CANONICAL.slice(0, 42)} `],
  ];

  it.each(malformedLibraryChallenges)("R: a library challenge of %s -> beginRegistration throws BEFORE challengeStore.create; nothing is saved or returned", async (_label, challenge) => {
    override.challenge = challenge;
    const w = world();
    await expect(beginRegistration({ config, challengeStore: w.challengeStore })).rejects.toThrow(/canonical form/);
    expect(w.calls).toEqual([]); // no create, and no other store call
    expect(await w.baseChallenges.consume({ challenge, purpose: "registration" })).toBeNull();
  });

  it("R: a library challenge that IS canonical is saved exactly as minted — never normalized, repaired, or replaced", async () => {
    override.challenge = CANONICAL;
    const w = world();
    const { optionsJSON } = await beginRegistration({ config, challengeStore: w.challengeStore });
    expect(optionsJSON.challenge).toBe(CANONICAL);
    expect(w.calls).toEqual(["challengeStore.create"]);
    expect((await w.baseChallenges.consume({ challenge: CANONICAL, purpose: "registration" }))?.challenge).toBe(CANONICAL);
  });

  it("S: through the real options route, a non-canonical library challenge is the generic 500 — no options returned, nothing stored, and the 3C-1 admission is not refunded or changed", async () => {
    vi.stubEnv("NEXT_PUBLIC_REAL_MODE_ENABLED", "true");
    vi.stubEnv("TURNKEY_PARENT_ORGANIZATION_ID", "parent-org");
    vi.stubEnv("TURNKEY_API_PUBLIC_KEY", "public-key");
    vi.stubEnv("TURNKEY_API_PRIVATE_KEY", "private-key");
    vi.stubEnv("REAL_SESSION_SECRET", "4be1c0d27a9f3e8d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170605");
    vi.stubEnv("NEXT_PUBLIC_REAL_RP_ID", "localhost");
    vi.stubEnv("NEXT_PUBLIC_REAL_ORIGIN", ORIGIN);
    vi.stubEnv("PIMLICO_API_KEY", "pim_test_key");
    const w = world();
    route.challengeStore = w.challengeStore;
    route.admitted = true;
    const { POST } = await import("@/app/api/real/account/register/options/route");
    override.challenge = CANONICAL.slice(0, 42);
    const bad = await POST();
    expect(bad.status).toBe(500);
    const body = await bad.json();
    expect(body).toEqual({ error: expect.any(String) });
    expect(JSON.stringify(body)).not.toMatch(/optionsJSON|challenge|canonical/i);
    expect(w.calls).toEqual([]);
    // The very next, healthy request works as before.
    override.challenge = null;
    const good = await POST();
    expect(good.status).toBe(200);
    const { optionsJSON } = (await good.json()) as { optionsJSON: { challenge: string } };
    expect(optionsJSON.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(w.calls).toEqual(["challengeStore.create"]);
  });

  it("the options route's order is unchanged: disabled, config, global admission, THEN the challenge (a refusal mints nothing)", async () => {
    vi.stubEnv("NEXT_PUBLIC_REAL_MODE_ENABLED", "true");
    vi.stubEnv("TURNKEY_PARENT_ORGANIZATION_ID", "parent-org");
    vi.stubEnv("TURNKEY_API_PUBLIC_KEY", "public-key");
    vi.stubEnv("TURNKEY_API_PRIVATE_KEY", "private-key");
    vi.stubEnv("REAL_SESSION_SECRET", "4be1c0d27a9f3e8d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170605");
    vi.stubEnv("NEXT_PUBLIC_REAL_RP_ID", "localhost");
    vi.stubEnv("NEXT_PUBLIC_REAL_ORIGIN", ORIGIN);
    vi.stubEnv("PIMLICO_API_KEY", "pim_test_key");
    const w = world();
    route.challengeStore = w.challengeStore;
    route.admitted = false;
    const { POST } = await import("@/app/api/real/account/register/options/route");
    const refused = await POST();
    expect(refused.status).toBe(503);
    expect(w.calls).toEqual([]);
  });
});

describe("T, U: the validator is private, and the neighbouring paths are untouched", () => {
  it("the validator is not exported and the module adds no dependency or I/O", async () => {
    const { readFileSync } = await import("node:fs");
    const registration = readFileSync("lib/real/server/registration.ts", "utf8");
    expect(registration).not.toMatch(/export (function|const) isCanonicalRegistrationChallenge/);
    expect(Object.keys(await import("@/lib/real/server/registration")).sort()).toEqual(["beginRegistration", "completeRegistration"]);
    const imports = [...registration.matchAll(/^import [^\n]* from "([^"]+)";$/gm)].map((match) => match[1]).sort();
    expect(imports).toEqual(["../account/safe", "../bytes", "../credential-id", "./challenge-store", "./config", "./onboarding", "./registration-attempts", "./registry", "./webauthn", "@simplewebauthn/server", "@simplewebauthn/server/helpers", "node:crypto"].sort());
  });
});
