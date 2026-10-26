import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { bytesToBase64Url } from "@/lib/real/bytes";
import type { RealServerConfig } from "@/lib/real/server/config";
import { createInMemoryChallengeStore } from "@/lib/real/server/challenge-store";
import { createInMemoryRealAccountRegistry, type RealAccountRegistry } from "@/lib/real/server/registry";
import { createInMemoryBackupPasskeyEnrollmentStore, type BackupPasskeyEnrollmentStore } from "@/lib/real/server/backup-passkey-enrollment";
import { buildAuthenticationResponseJSON, buildRegistrationResponseJSON, createFixtureAuthenticator, type FixtureAuthenticator } from "./fixtures/webauthn";
import { FakeTurnkey, signRequest } from "./fixtures/turnkey-fake";
import { openBudget, scriptedBudget } from "./fixtures/chain-read-budget";

/**
 * M3D-2: when the signing-confirmation activity read yields NO usable evidence
 * (readTurnkeyActivity -> null: timeout, SDK/transport failure, HTTP 404,
 * malformed answer) the confirmation is "unavailable" — HTTP 503, retryable,
 * nothing changed — not a "rejected" 400. A READABLE contradiction stays a
 * rejection. Everything runs in-process: @turnkey/http is mocked, time is
 * faked where a deadline matters, and nothing touches a network, Neon or a chain.
 */

const DEADLINE_MS = 5_000;
const owner = privateKeyToAccount("0x119bb329df425b685a3f3483fba01deeb1db47d608cfb051da9ad4a12995238a");
const ORIGIN = "http://localhost:3000";
const SAFE = "0xd9a4c22fb34dc74317edc8006140d66c8fa03266";
const CREATE_URL = "https://api.turnkey.com/public/v1/submit/create_authenticators";
const APP_USER = "app-user-1";
const SUB_ORG = "sub-org-1";
const UNAVAILABLE_MESSAGE = "We couldn't check your approval just now. Try again in a moment.";
const UNVERIFIED = "The authorization proof could not be verified.";

const config: RealServerConfig = {
  turnkeyApiBaseUrl: "https://api.turnkey.com",
  turnkeyParentOrganizationId: "parent-org",
  turnkeyApiPublicKey: "pub",
  turnkeyApiPrivateKey: "priv",
  sessionSecret: "test-session-secret",
  rpId: "localhost",
  rpName: "Test",
  expectedOrigins: [ORIGIN],
  rpcUrl: "https://sepolia.base.org",
  pimlicoApiKey: "pim_test_key",
};

type ReadFn = (input: never) => Promise<unknown>;
const hooks: { fake: FakeTurnkey | null; getActivity: ReadFn | null; calls: { getActivity: number; getUsers: number; signRawPayload: number } } = {
  fake: null,
  getActivity: null,
  calls: { getActivity: 0, getUsers: 0, signRawPayload: 0 },
};

vi.mock("@turnkey/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@turnkey/http")>();
  return {
    ...actual,
    TurnkeyClient: vi.fn().mockImplementation(function TurnkeyClientMock(_config: unknown, stamper: { allowCredentials?: Array<{ id: BufferSource }> }) {
      return {
        signRawPayload: (request: never) => {
          hooks.calls.signRawPayload += 1;
          return hooks.fake!.signRawPayload(request, stamper);
        },
        getActivity: (request: { organizationId: string; activityId: string }) => {
          hooks.calls.getActivity += 1;
          return hooks.getActivity ? hooks.getActivity(request as never) : hooks.fake!.getActivity(request);
        },
        getUsers: (request: { organizationId: string }) => {
          hooks.calls.getUsers += 1;
          return hooks.fake!.getUsers(request);
        },
      };
    }),
  };
});

const pipeline = await import("@/lib/real/server/backup-passkey-pipeline");

type Held = { resolve: (value: unknown) => void; reject: (error: unknown) => void };
function hang(): Held[] {
  const held: Held[] = [];
  hooks.getActivity = () => new Promise((resolve, reject) => held.push({ resolve, reject }));
  return held;
}

function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error) => Object.assign(state, { settled: true, error }),
  );
  return state;
}

beforeEach(() => {
  hooks.fake = null;
  hooks.getActivity = null;
  hooks.calls = { getActivity: 0, getUsers: 0, signRawPayload: 0 };
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------- fixtures

type World = {
  registry: RealAccountRegistry;
  enrollments: BackupPasskeyEnrollmentStore;
  challengeStore: ReturnType<typeof createInMemoryChallengeStore>;
  fake: FakeTurnkey;
  primary: FixtureAuthenticator;
  deps: { fetchImpl: typeof fetch; now: () => number; sleep: () => Promise<void>; maxPolls: number };
};

async function world(): Promise<World> {
  const registry = createInMemoryRealAccountRegistry();
  const primary = createFixtureAuthenticator();
  await registry.createAccountWithPasskey({
    account: { appUserId: APP_USER, subOrganizationId: SUB_ORG, turnkeyUserId: "turnkey-user-1", walletId: "wallet-1", walletAccountId: "wallet-account-1", ownerAddress: owner.address, safeAddress: SAFE, accountConfigVersion: 1 },
    passkey: { credentialId: primary.credentialIdBase64Url, appUserId: APP_USER, credentialPublicKey: bytesToBase64Url(primary.publicKeyCose), userHandle: "primary-user-handle", counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false },
  });
  const fake = new FakeTurnkey(SUB_ORG, "turnkey-user-1");
  fake.addAuthenticator(primary.credentialIdBase64Url, "authenticator-primary");
  await registry.transitionPasskeyStatus({ credentialId: primary.credentialIdBase64Url, from: "active", to: "active", patch: { turnkeyAuthenticatorId: "authenticator-primary" } });
  hooks.fake = fake;
  return {
    registry,
    enrollments: createInMemoryBackupPasskeyEnrollmentStore(registry),
    challengeStore: createInMemoryChallengeStore(),
    fake,
    primary,
    deps: { fetchImpl: fake.fetchImpl, now: () => Date.now(), sleep: async () => {}, maxPolls: 1 },
  };
}

/** Drives the real pipeline to `login_verified`: registered backup -> created in Turnkey -> signed in with the new passkey. */
async function toLoginVerified(w: World) {
  const prepared = await pipeline.prepareBackupStepUp({ config, challengeStore: w.challengeStore, registry: w.registry, appUserId: APP_USER, sessionCredentialId: w.primary.credentialIdBase64Url });
  if (prepared.outcome !== "ready") throw new Error(JSON.stringify(prepared));
  const handle = (await w.registry.findPasskeyByCredentialId(w.primary.credentialIdBase64Url))!.userHandle;
  const stepUpResponse = buildAuthenticationResponseJSON({ authenticator: w.primary, challenge: prepared.optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId, userHandle: handle });
  const begun = await pipeline.beginBackupEnrollment({ config, challengeStore: w.challengeStore, registry: w.registry, enrollments: w.enrollments, appUserId: APP_USER, sessionCredentialId: w.primary.credentialIdBase64Url, stepUpResponse });
  if (begun.outcome !== "started") throw new Error(JSON.stringify(begun));
  const enrollmentId = begun.enrollmentId;

  const backup = createFixtureAuthenticator();
  const registration = buildRegistrationResponseJSON({ authenticator: backup, challenge: begun.optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId });
  const registered = await pipeline.completeBackupCredentialRegistration({ config, challengeStore: w.challengeStore, registry: w.registry, enrollments: w.enrollments, appUserId: APP_USER, sessionCredentialId: w.primary.credentialIdBase64Url, response: registration });
  if (registered.outcome !== "registered") throw new Error(JSON.stringify(registered));

  const authorization = await pipeline.prepareTurnkeyAuthorization({ config, registry: w.registry, enrollments: w.enrollments, appUserId: APP_USER, enrollmentId, sessionCredentialId: w.primary.credentialIdBase64Url, now: () => Date.now() });
  if (authorization.outcome !== "ready") throw new Error(JSON.stringify(authorization));
  const signedRequest = await signRequest({ authenticator: w.primary, activity: authorization.activity, url: CREATE_URL, origin: ORIGIN, rpId: config.rpId });
  const submitted = await pipeline.submitTurnkeyAuthorization({ config, registry: w.registry, enrollments: w.enrollments, appUserId: APP_USER, enrollmentId, sessionCredentialId: w.primary.credentialIdBase64Url, signedRequest, deps: w.deps });
  expect(submitted.outcome).toBe("confirmed");

  const loginOptions = await pipeline.prepareBackupLoginVerification({ config, challengeStore: w.challengeStore, enrollments: w.enrollments, appUserId: APP_USER, enrollmentId });
  if (loginOptions.outcome !== "ready") throw new Error(JSON.stringify(loginOptions));
  const pending = (await w.enrollments.findById(enrollmentId))!;
  const loginResponse = buildAuthenticationResponseJSON({ authenticator: backup, challenge: loginOptions.optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId, userHandle: pending.userHandle! });
  const verified = await pipeline.confirmBackupLoginVerification({ config, challengeStore: w.challengeStore, registry: w.registry, enrollments: w.enrollments, appUserId: APP_USER, response: loginResponse });
  expect(verified.outcome).toBe("verified");
  return { enrollmentId, backup };
}

type ActivityOverrides = {
  id?: string;
  status?: string;
  organizationId?: string;
  type?: string;
  payload?: string;
  votes?: unknown[] | null;
  signature?: Hex;
  omitResult?: boolean;
};

/** Prepares the stored nonce and seeds the signRawPayload activity a correct client approval would produce, with optional faults. */
async function seedProofB(w: World, enrollmentId: string, overrides: ActivityOverrides = {}) {
  const prepared = await pipeline.prepareSigningProof({ config, registry: w.registry, enrollments: w.enrollments, appUserId: APP_USER, enrollmentId });
  if (prepared.outcome !== "ready") throw new Error(JSON.stringify(prepared));
  const enrollment = (await w.enrollments.findById(enrollmentId))!;
  const signature = overrides.signature ?? (await owner.sign({ hash: prepared.digest as Hex }));
  const id = overrides.id ?? `sign-${Math.random().toString(16).slice(2)}`;
  w.fake.addActivity({
    id,
    status: overrides.status ?? "ACTIVITY_STATUS_COMPLETED",
    organizationId: overrides.organizationId ?? SUB_ORG,
    type: overrides.type ?? "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
    intent: { signRawPayloadIntentV2: { signWith: owner.address, payload: overrides.payload ?? prepared.digest, encoding: "PAYLOAD_ENCODING_HEXADECIMAL", hashFunction: "HASH_FUNCTION_NO_OP" } },
    ...(overrides.omitResult ? {} : { result: { signRawPayloadResult: { r: signature.slice(2, 66), s: signature.slice(66, 130), v: Number.parseInt(signature.slice(130), 16) === 27 ? "00" : "01" } } }),
    votes: overrides.votes === undefined ? [{ selection: "VOTE_SELECTION_APPROVED", activityId: id, userId: "turnkey-user-1", publicKey: enrollment.turnkeyAuthenticatorPublicKey }] : overrides.votes,
  } as never);
  return { id, digest: prepared.digest };
}

const confirm = (w: World, enrollmentId: string, activityId: string, providerBudgetLimiter = openBudget()) =>
  pipeline.confirmSigningProof({ config, registry: w.registry, enrollments: w.enrollments, appUserId: APP_USER, enrollmentId, activityId, providerBudgetLimiter });

const stateOf = async (w: World, enrollmentId: string) => (await w.enrollments.findById(enrollmentId))?.state;
const passkeyStatusOf = async (w: World, enrollmentId: string) => {
  const enrollment = (await w.enrollments.findById(enrollmentId))!;
  return (await w.registry.findPasskeyByCredentialId(enrollment.newCredentialId!))?.status;
};

// ---------------------------------------------------------------- pipeline: null read -> unavailable

describe("confirmSigningProof — a read without usable evidence is 'unavailable' (not a rejection)", () => {
  it("a hanging read reaches the 5 s local deadline and yields unavailable after exactly ONE SDK read; the late success cannot activate; the same id then activates", async () => {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    const proof = await seedProofB(w, enrollmentId);
    const forwarded = w.fake.forwarded.length;

    hooks.calls = { getActivity: 0, getUsers: 0, signRawPayload: 0 };
    const held = hang();
    vi.useFakeTimers();
    const state = track(confirm(w, enrollmentId, proof.id));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state).toMatchObject({ settled: true, value: { outcome: "unavailable" } });
    expect(await stateOf(w, enrollmentId)).toBe("login_verified");
    expect(await passkeyStatusOf(w, enrollmentId)).toBe("pending");

    // A late SUCCESS after the deadline is ignored: nothing activates, nothing is re-read, nothing retried.
    held[0]!.resolve({ activity: structuredClone(w.fake.activities.get(proof.id)!) });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await stateOf(w, enrollmentId)).toBe("login_verified");
    expect(await passkeyStatusOf(w, enrollmentId)).toBe("pending");
    expect(hooks.calls.getActivity).toBe(1);
    expect(hooks.calls.signRawPayload).toBe(0);
    expect(w.fake.forwarded).toHaveLength(forwarded);

    vi.useRealTimers();
    hooks.getActivity = null;
    expect((await confirm(w, enrollmentId, proof.id)).outcome).toBe("active");
    expect(await stateOf(w, enrollmentId)).toBe("active");
  });

  it.each([
    ["an SDK exception", () => Promise.reject(new Error("socket hang up"))],
    ["a synchronous SDK exception", () => {
      throw new Error("synchronous SDK failure");
    }],
    ["a provider HTTP 404", () => Promise.reject(Object.assign(new Error("Turnkey error 5: activity not found"), { status: 404 }))],
    ["an empty answer", () => Promise.resolve({})],
    ["a non-object activity", () => Promise.resolve({ activity: "garbage" })],
    ["an activity with no id or status", () => Promise.resolve({ activity: { type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2" } })],
  ] as const)("%s -> unavailable, enrollment still login_verified, one SDK read, no signing or forwarding", async (_name, failure) => {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    const proof = await seedProofB(w, enrollmentId);
    const forwarded = w.fake.forwarded.length;

    hooks.calls = { getActivity: 0, getUsers: 0, signRawPayload: 0 };
    hooks.getActivity = failure as ReadFn;
    expect(await confirm(w, enrollmentId, proof.id)).toEqual({ outcome: "unavailable" });
    expect(await stateOf(w, enrollmentId)).toBe("login_verified");
    expect(await passkeyStatusOf(w, enrollmentId)).toBe("pending");
    expect(hooks.calls.getActivity).toBe(1);
    expect(hooks.calls.getUsers).toBe(0);
    expect(hooks.calls.signRawPayload).toBe(0);
    expect(w.fake.forwarded).toHaveLength(forwarded);
  });

  it("charges exactly one budget unit per confirmation that reaches the read — unavailable is not refunded — against the session account", async () => {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    const proof = await seedProofB(w, enrollmentId);
    const budget = scriptedBudget({ allowed: true });

    hooks.getActivity = () => Promise.reject(new Error("down"));
    expect(await confirm(w, enrollmentId, proof.id, budget.limiter)).toEqual({ outcome: "unavailable" });
    expect(budget.calls).toHaveLength(1);
    expect(budget.calls[0]!.subject).toBe(APP_USER);

    expect(await confirm(w, enrollmentId, proof.id, budget.limiter)).toEqual({ outcome: "unavailable" });
    expect(budget.calls).toHaveLength(2); // each admitted retry is charged again
  });

  it("a budget denial stays rate_limited (never unavailable), and makes no provider read", async () => {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    const proof = await seedProofB(w, enrollmentId);
    const budget = scriptedBudget({ allowed: false, retryAfterSeconds: 77 });

    hooks.calls = { getActivity: 0, getUsers: 0, signRawPayload: 0 };
    const result = await confirm(w, enrollmentId, proof.id, budget.limiter);
    expect(result).toMatchObject({ outcome: "rate_limited", retryAfterSeconds: 77 });
    expect(hooks.calls.getActivity).toBe(0);
    expect(await stateOf(w, enrollmentId)).toBe("login_verified");
  });

  it("a valid completed activity still activates (enrollment and passkey), after one read", async () => {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    const proof = await seedProofB(w, enrollmentId);
    hooks.calls = { getActivity: 0, getUsers: 0, signRawPayload: 0 };
    expect(await confirm(w, enrollmentId, proof.id)).toEqual({ outcome: "active" });
    expect(hooks.calls.getActivity).toBe(1);
    expect(await stateOf(w, enrollmentId)).toBe("active");
    expect(await passkeyStatusOf(w, enrollmentId)).toBe("active");
  });
});

// ---------------------------------------------------------------- pipeline: readable contradictions stay rejected

describe("confirmSigningProof — a READABLE contradiction is still a rejection and never activates", () => {
  const rejectedCases: Array<[string, ActivityOverrides, string?]> = [
    ["a FAILED activity", { status: "ACTIVITY_STATUS_FAILED" }, "The authorization proof isn't complete yet. Try again."],
    ["a REJECTED activity", { status: "ACTIVITY_STATUS_REJECTED" }, "The authorization proof isn't complete yet. Try again."],
    ["a still-pending activity", { status: "ACTIVITY_STATUS_PENDING" }, "The authorization proof isn't complete yet. Try again."],
    ["a different organization", { organizationId: "some-other-org" }, UNVERIFIED],
    ["a different activity type", { type: "ACTIVITY_TYPE_CREATE_AUTHENTICATORS_V2" }, UNVERIFIED],
    ["a signed payload that is not the stored nonce", { payload: `0x${"ab".repeat(32)}` }, "The authorization proof signed something other than this setup's challenge."],
    ["no approving vote", { votes: [] }, "The authorization wasn't approved by the new backup passkey."],
    ["an approving vote by another key", { votes: [{ selection: "VOTE_SELECTION_APPROVED", activityId: "x", userId: "turnkey-user-1", publicKey: "AAAA" }] }, "The authorization wasn't approved by the new backup passkey."],
    ["a missing signature", { omitResult: true }, "The authorization proof has no signature."],
  ];

  it.each(rejectedCases)("%s -> rejected, not unavailable; login_verified is preserved", async (_name, overrides, reason) => {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    const proof = await seedProofB(w, enrollmentId, overrides);
    const result = await confirm(w, enrollmentId, proof.id);
    expect(result).toEqual({ outcome: "rejected", reason });
    expect(await stateOf(w, enrollmentId)).toBe("login_verified");
    expect(await passkeyStatusOf(w, enrollmentId)).toBe("pending");
  });

  it("a signature recovering a different owner is rejected", async () => {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    const stranger = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const proof = await seedProofB(w, enrollmentId, { signature: await stranger.sign({ hash: `0x${"11".repeat(32)}` as Hex }) });
    expect(await confirm(w, enrollmentId, proof.id)).toEqual({ outcome: "rejected", reason: "The authorization proof did not recover the account owner." });
    expect(await stateOf(w, enrollmentId)).toBe("login_verified");
  });

  it("a readable activity whose id differs from the requested id is rejected (the read is for the REQUESTED id)", async () => {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    const proof = await seedProofB(w, enrollmentId);
    hooks.getActivity = async () => ({ activity: { ...structuredClone(w.fake.activities.get(proof.id)!), id: "a-different-activity" } });
    expect(await confirm(w, enrollmentId, proof.id)).toEqual({ outcome: "rejected", reason: UNVERIFIED });
    expect(await stateOf(w, enrollmentId)).toBe("login_verified");
  });

  it("a malformed activity id is rejected for free: no budget unit, no provider read", async () => {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    await seedProofB(w, enrollmentId);
    const budget = scriptedBudget({ allowed: true });
    hooks.calls = { getActivity: 0, getUsers: 0, signRawPayload: 0 };
    expect(await confirm(w, enrollmentId, "not a valid id!", budget.limiter)).toEqual({ outcome: "rejected", reason: UNVERIFIED });
    expect(budget.calls).toHaveLength(0);
    expect(hooks.calls.getActivity).toBe(0);
  });

  it("a superseded nonce cannot activate: an activity that signed the OLD nonce is rejected after a newer prepare", async () => {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    const stale = await seedProofB(w, enrollmentId); // signs nonce #1
    const fresh = await seedProofB(w, enrollmentId); // prepare again: nonce #2 supersedes #1
    expect(fresh.digest).not.toBe(stale.digest);

    expect(await confirm(w, enrollmentId, stale.id)).toEqual({ outcome: "rejected", reason: "The authorization proof signed something other than this setup's challenge." });
    expect(await stateOf(w, enrollmentId)).toBe("login_verified");
    expect((await confirm(w, enrollmentId, fresh.id)).outcome).toBe("active");
  });

  it.each(["removal_in_progress", "removed", "abandoned", "credential_registered", "turnkey_authenticator_created"] as const)("an enrollment in state %s is rejected without a read", async (state) => {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    const proof = await seedProofB(w, enrollmentId);
    const current = (await w.enrollments.findById(enrollmentId))!;
    // Move the durable state away from login_verified through the store's own guarded transition.
    const moved = await w.enrollments.transition({ id: enrollmentId, from: "login_verified", to: state as never, patch: {} });
    if (!moved) throw new Error(`could not move ${current.state} -> ${state}`);

    hooks.calls = { getActivity: 0, getUsers: 0, signRawPayload: 0 };
    expect((await confirm(w, enrollmentId, proof.id)).outcome).toBe("rejected");
    expect(hooks.calls.getActivity).toBe(0);
    expect(await stateOf(w, enrollmentId)).toBe(state);
    expect(await passkeyStatusOf(w, enrollmentId)).not.toBe("active");
  });

  it("an unknown enrollment is rejected", async () => {
    const w = await world();
    await toLoginVerified(w);
    expect(await confirm(w, "no-such-enrollment", "sign-abc")).toEqual({ outcome: "rejected", reason: "Unknown setup." });
  });
});

// ---------------------------------------------------------------- the real route

const AUTHENTICATED = { account: { appUserId: APP_USER }, credentialId: "cred" };

describe("POST /api/real/account/passkeys/backup/verify-signing/confirm — the unavailable contract", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("@/app/api/real/account/passkeys/session");
    vi.doUnmock("@/lib/real/server/runtime");
  });

  /** The REAL route + REAL pipeline + REAL discovery; only the session, the runtime's stores and the mocked Turnkey SDK are stand-ins. */
  async function loadRoute(w: World, limiter = openBudget(), session: unknown = AUTHENTICATED) {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_REAL_MODE_ENABLED", "true");
    vi.stubEnv("TURNKEY_PARENT_ORGANIZATION_ID", "parent-org");
    vi.stubEnv("TURNKEY_API_PUBLIC_KEY", "public-key");
    vi.stubEnv("TURNKEY_API_PRIVATE_KEY", "private-key");
    vi.stubEnv("REAL_SESSION_SECRET", "4be1c0d27a9f3e8d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170605");
    vi.stubEnv("NEXT_PUBLIC_REAL_RP_ID", "localhost");
    vi.stubEnv("NEXT_PUBLIC_REAL_ORIGIN", ORIGIN);
    vi.stubEnv("PIMLICO_API_KEY", "pim_test_key");
    vi.doMock("@/app/api/real/account/passkeys/session", () => ({ readPasskeySession: async () => session }));
    vi.doMock("@/lib/real/server/runtime", () => ({
      getRealAccountRegistry: () => w.registry,
      getBackupPasskeyEnrollmentStore: () => w.enrollments,
      getProviderBudgetLimiter: () => limiter,
    }));
    const route = await import("@/app/api/real/account/passkeys/backup/verify-signing/confirm/route");
    return (body: unknown) =>
      route.POST(new Request("http://localhost/api/real/account/passkeys/backup/verify-signing/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  }
  const callRoute = async (w: World, body: unknown, limiter = openBudget(), session: unknown = AUTHENTICATED) => (await loadRoute(w, limiter, session))(body);

  it("an unreadable activity is HTTP 503 with EXACTLY { error, retryable: true } — no code, no Retry-After, no raw detail — and changes nothing", async () => {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    const proof = await seedProofB(w, enrollmentId);
    const forwarded = w.fake.forwarded.length;
    hooks.calls = { getActivity: 0, getUsers: 0, signRawPayload: 0 };
    hooks.getActivity = () => Promise.reject(new Error("Turnkey error 13: secret-looking provider detail org=sub-org-1"));

    const response = await callRoute(w, { enrollmentId, activityId: proof.id });
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: UNAVAILABLE_MESSAGE, retryable: true });
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["error", "retryable"]);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(text).not.toMatch(/secret-looking|Turnkey error|sub-org-1|code/);

    expect(hooks.calls.getActivity).toBe(1);
    expect(hooks.calls.signRawPayload).toBe(0);
    expect(w.fake.forwarded).toHaveLength(forwarded);
    expect(await stateOf(w, enrollmentId)).toBe("login_verified");
  });

  it("a hanging read answers the same 503 once the local deadline fires", async () => {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    const proof = await seedProofB(w, enrollmentId);
    const post = await loadRoute(w); // load first, on real timers
    hang();
    vi.useFakeTimers();
    const pending = track(post({ enrollmentId, activityId: proof.id }));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(pending.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(pending.settled).toBe(true);
    const response = pending.value!;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: UNAVAILABLE_MESSAGE, retryable: true });
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(await stateOf(w, enrollmentId)).toBe("login_verified");
  });

  it("the SAME activity id then succeeds with HTTP 200 { active: true } once the read works", async () => {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    const proof = await seedProofB(w, enrollmentId);
    hooks.getActivity = () => Promise.reject(new Error("down"));
    expect((await callRoute(w, { enrollmentId, activityId: proof.id })).status).toBe(503);

    hooks.getActivity = null;
    const ok = await callRoute(w, { enrollmentId, activityId: proof.id });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ active: true });
    expect(await stateOf(w, enrollmentId)).toBe("active");
  });

  it("a readable contradiction is still HTTP 400 { error } with no `retryable`", async () => {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    const failed = await seedProofB(w, enrollmentId, { status: "ACTIVITY_STATUS_FAILED" });
    const response = await callRoute(w, { enrollmentId, activityId: failed.id });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "The authorization proof isn't complete yet. Try again." });

    const wrongOrg = await seedProofB(w, enrollmentId, { organizationId: "other-org" });
    const second = await callRoute(w, { enrollmentId, activityId: wrongOrg.id });
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ error: UNVERIFIED });
  });

  it("a budget denial is still HTTP 429 with Retry-After and code rate_limited, and makes no provider read", async () => {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    const proof = await seedProofB(w, enrollmentId);
    hooks.calls = { getActivity: 0, getUsers: 0, signRawPayload: 0 };
    const response = await callRoute(w, { enrollmentId, activityId: proof.id }, scriptedBudget({ allowed: false, retryAfterSeconds: 45 }).limiter);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("45");
    expect(await response.json()).toMatchObject({ code: "rate_limited", retryable: true });
    expect(hooks.calls.getActivity).toBe(0);
  });

  it("a limiter failure is the generic 500 with no provider read (never an allow, never a 503)", async () => {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    const proof = await seedProofB(w, enrollmentId);
    hooks.calls = { getActivity: 0, getUsers: 0, signRawPayload: 0 };
    const response = await callRoute(w, { enrollmentId, activityId: proof.id }, scriptedBudget(new Error("limiter down")).limiter);
    expect(response.status).toBe(500);
    expect(hooks.calls.getActivity).toBe(0);
  });

  it("unauthenticated is 401 and invalid input is 400, before any read", async () => {
    const w = await world();
    hooks.calls = { getActivity: 0, getUsers: 0, signRawPayload: 0 };
    expect((await callRoute(w, { enrollmentId: "e", activityId: "a" }, openBudget(), null)).status).toBe(401);
    const noEnrollment = await callRoute(w, { activityId: "a" });
    expect(noEnrollment.status).toBe(400);
    expect(await noEnrollment.json()).toEqual({ error: "An enrollmentId is required." });
    const noActivity = await callRoute(w, { enrollmentId: "e" });
    expect(noActivity.status).toBe(400);
    expect(await noActivity.json()).toEqual({ error: "An activityId is required." });
    expect(hooks.calls.getActivity).toBe(0);
  });

  it("a stored enrollment already active answers 200 { active: true } without a read", async () => {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    const proof = await seedProofB(w, enrollmentId);
    expect((await callRoute(w, { enrollmentId, activityId: proof.id })).status).toBe(200);
    hooks.calls = { getActivity: 0, getUsers: 0, signRawPayload: 0 };
    const again = await callRoute(w, { enrollmentId, activityId: proof.id });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ active: true });
    expect(hooks.calls.getActivity).toBe(0);
  });

  it("an internal failure remains the generic 500", async () => {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    const proof = await seedProofB(w, enrollmentId);
    const broken = { ...w.registry, findAccountByAppUserId: async () => { throw new Error("database down"); } } as unknown as RealAccountRegistry;
    const response = await callRoute({ ...w, registry: broken }, { enrollmentId, activityId: proof.id });
    expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty("retryable");
  });
});
