// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { bytesToBase64Url } from "@/lib/real/bytes";
import type { RealServerConfig } from "@/lib/real/server/config";
import { createInMemoryChallengeStore } from "@/lib/real/server/challenge-store";
import { createInMemoryRealAccountRegistry, type RealAccountRegistry } from "@/lib/real/server/registry";
import { createInMemoryBackupPasskeyEnrollmentStore, type BackupPasskeyEnrollmentStore } from "@/lib/real/server/backup-passkey-enrollment";
import { NEON_TRANSACTION_ISOLATION_LEVEL, createNeonDurableStores } from "@/lib/real/server/neon-store";
import { buildAuthenticationResponseJSON, buildRegistrationResponseJSON, createFixtureAuthenticator, type FixtureAuthenticator } from "./fixtures/webauthn";
import { FakeTurnkey, signRequest } from "./fixtures/turnkey-fake";
import { openBudget, scriptedBudget } from "./fixtures/chain-read-budget";

/**
 * Signing-proof nonce activation CAS. confirmSigningProof verifies a Turnkey
 * signing activity against the signing_proof_challenge it READ; a newer
 * prepareSigningProof can replace that nonce before activation. Activation now
 * carries the verified nonce and compares it, atomically and by exact value,
 * with the enrollment's CURRENT nonce — a mismatch is the existing no-match.
 *
 * Everything is offline: @turnkey/http is mocked, the Neon driver's fetch is
 * intercepted (nothing leaves the process), no SQL runs, no chain is touched.
 * The race is made deterministic with a held provider read — no sleeps, no timing.
 */

const owner = privateKeyToAccount("0x119bb329df425b685a3f3483fba01deeb1db47d608cfb051da9ad4a12995238a");
const ORIGIN = "http://localhost:3000";
const SAFE = "0xd9a4c22fb34dc74317edc8006140d66c8fa03266";
const CREATE_URL = "https://api.turnkey.com/public/v1/submit/create_authenticators";
const APP_USER = "app-user-1";
const SUB_ORG = "sub-org-1";
const ACTIVATION_FAILED = "Activation could not be completed; check status and retry.";

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

type ReadFn = (input: { organizationId: string; activityId: string }) => Promise<unknown>;
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
          return hooks.getActivity ? hooks.getActivity(request) : hooks.fake!.getActivity(request);
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

beforeEach(() => {
  hooks.fake = null;
  hooks.getActivity = null;
  hooks.calls = { getActivity: 0, getUsers: 0, signRawPayload: 0 };
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

/** "Tab" step: the real prepareSigningProof stores a fresh nonce, then the activity a correct client approval would produce is seeded for it. */
async function prepareTab(w: World, enrollmentId: string) {
  const prepared = await pipeline.prepareSigningProof({ config, registry: w.registry, enrollments: w.enrollments, appUserId: APP_USER, enrollmentId });
  if (prepared.outcome !== "ready") throw new Error(JSON.stringify(prepared));
  const enrollment = (await w.enrollments.findById(enrollmentId))!;
  const signature = await owner.sign({ hash: prepared.digest as Hex });
  const id = `sign-${Math.random().toString(16).slice(2)}`;
  w.fake.addActivity({
    id,
    status: "ACTIVITY_STATUS_COMPLETED",
    organizationId: SUB_ORG,
    type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
    intent: { signRawPayloadIntentV2: { signWith: owner.address, payload: prepared.digest, encoding: "PAYLOAD_ENCODING_HEXADECIMAL", hashFunction: "HASH_FUNCTION_NO_OP" } },
    result: { signRawPayloadResult: { r: signature.slice(2, 66), s: signature.slice(66, 130), v: Number.parseInt(signature.slice(130), 16) === 27 ? "00" : "01" } },
    votes: [{ selection: "VOTE_SELECTION_APPROVED", activityId: id, userId: "turnkey-user-1", publicKey: enrollment.turnkeyAuthenticatorPublicKey }],
  } as never);
  return { activityId: id, nonce: prepared.digest as string };
}

type Enrollments = BackupPasskeyEnrollmentStore;
const confirm = (w: World, enrollmentId: string, activityId: string, opts: { enrollments?: Enrollments; limiter?: ReturnType<typeof openBudget>; appUserId?: string } = {}) =>
  pipeline.confirmSigningProof({ config, registry: w.registry, enrollments: opts.enrollments ?? w.enrollments, appUserId: opts.appUserId ?? APP_USER, enrollmentId, activityId, providerBudgetLimiter: opts.limiter ?? openBudget() });

const snapshot = async (w: World, enrollmentId: string) => {
  const enrollment = (await w.enrollments.findById(enrollmentId))!;
  const passkey = await w.registry.findPasskeyByCredentialId(enrollment.newCredentialId!);
  return { state: enrollment.state, nonce: enrollment.signingProofChallenge, activityId: enrollment.signingProofActivityId, verifiedAt: enrollment.signingVerifiedAt, passkeyStatus: passkey?.status };
};

/** Counts activate calls and their outcomes while delegating to the real store. */
function spyOnActivate(store: Enrollments) {
  const log: Array<{ input: Parameters<Enrollments["activate"]>[0]; result: "activated" | "no_match" }> = [];
  const spied: Enrollments = {
    ...store,
    activate: async (input) => {
      const result = await store.activate(input);
      log.push({ input, result: result ? "activated" : "no_match" });
      return result;
    },
  };
  return { spied, log };
}

// ---------------------------------------------------------------- A–K: the deterministic two-tab race

describe("signing-proof nonce: a replaced nonce can never be activated by the older verified proof", () => {
  it("A/B: single tab — a valid proof activates, and the stored nonce equals the one the activity authorized", async () => {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    const tab = await prepareTab(w, enrollmentId);
    const { spied, log } = spyOnActivate(w.enrollments);

    expect(await confirm(w, enrollmentId, tab.activityId, { enrollments: spied })).toEqual({ outcome: "active" });
    const after = await snapshot(w, enrollmentId);
    expect(after).toMatchObject({ state: "active", nonce: tab.nonce, activityId: tab.activityId, passkeyStatus: "active" });
    expect(after.verifiedAt).not.toBeNull();
    // The activity itself signed that exact nonce, and the pipeline handed activate that same value.
    expect((w.fake.activities.get(tab.activityId) as unknown as { intent: { signRawPayloadIntentV2: { payload: string } } }).intent.signRawPayloadIntentV2.payload).toBe(tab.nonce);
    expect(log).toHaveLength(1);
    expect(log[0]!.input).toEqual({ id: enrollmentId, signingProofActivityId: tab.activityId, signingProofChallenge: tab.nonce });
  });

  it("C–K: Tab A snapshots N1; Tab B prepares N2 before A activates; A is NOT activated; B's N2 activity then is", async () => {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    const tabA = await prepareTab(w, enrollmentId); // nonce N1 + a valid COMPLETED activity for N1
    const N1 = tabA.nonce;

    // Hold Tab A's provider read so the interleaving is exact: snapshot taken, read in flight.
    let release!: (value: unknown) => void;
    let reached!: () => void;
    const readReached = new Promise<void>((resolve) => (reached = resolve));
    hooks.getActivity = (request) => {
      if (request.activityId !== tabA.activityId) return hooks.fake!.getActivity(request);
      reached();
      return new Promise((resolve) => (release = resolve));
    };

    const budget = scriptedBudget({ allowed: true });
    const { spied, log } = spyOnActivate(w.enrollments);
    hooks.calls = { getActivity: 0, getUsers: 0, signRawPayload: 0 }; // count only what the confirmation itself does
    const confirmA = confirm(w, enrollmentId, tabA.activityId, { enrollments: spied, limiter: budget.limiter });
    await readReached; // A has snapshotted N1 and is parked inside the provider read

    // Tab B prepares: N2 supersedes N1 in the authoritative store, BEFORE A activates.
    const tabB = await prepareTab(w, enrollmentId);
    const N2 = tabB.nonce;
    expect(N2).not.toBe(N1);
    expect((await w.enrollments.findById(enrollmentId))!.signingProofChallenge).toBe(N2);

    // A's read completes with its genuinely valid, COMPLETED N1 activity.
    release({ activity: structuredClone(w.fake.activities.get(tabA.activityId)!) });
    const resultA = await confirmA;

    expect(resultA).toEqual({ outcome: "rejected", reason: ACTIVATION_FAILED });
    expect(log).toEqual([{ input: { id: enrollmentId, signingProofActivityId: tabA.activityId, signingProofChallenge: N1 }, result: "no_match" }]);
    // F–I: still login_verified under N2; no activity id, no verification time, passkey still pending.
    expect(await snapshot(w, enrollmentId)).toEqual({ state: "login_verified", nonce: N2, activityId: null, verifiedAt: null, passkeyStatus: "pending" });
    // N: exactly one charge, never refunded; no extra provider read, no signing, no activation retry.
    expect(budget.calls).toHaveLength(1);
    expect(hooks.calls.getActivity).toBe(1);
    expect(hooks.calls.signRawPayload).toBe(0);

    // J/K: Tab B's N2 activity activates and the evidence matches N2.
    hooks.getActivity = null;
    expect(await confirm(w, enrollmentId, tabB.activityId, { enrollments: spied })).toEqual({ outcome: "active" });
    expect(await snapshot(w, enrollmentId)).toMatchObject({ state: "active", nonce: N2, activityId: tabB.activityId, passkeyStatus: "active" });
    expect(log.map((entry) => entry.result)).toEqual(["no_match", "activated"]);
    expect(log[1]!.input.signingProofChallenge).toBe(N2);
  });

  it("the superseded activity (N1) stays unusable after N2 is stored, and N2 cannot be activated by it either", async () => {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    const stale = await prepareTab(w, enrollmentId);
    const fresh = await prepareTab(w, enrollmentId);
    // The pipeline's own nonce check already rejects the stale activity (it signed N1, the store holds N2)...
    expect((await confirm(w, enrollmentId, stale.activityId)).outcome).toBe("rejected");
    // ...and the store refuses the old nonce directly too, even with otherwise valid state.
    expect(await w.enrollments.activate({ id: enrollmentId, signingProofActivityId: stale.activityId, signingProofChallenge: stale.nonce })).toBeNull();
    expect((await snapshot(w, enrollmentId)).state).toBe("login_verified");
    expect((await confirm(w, enrollmentId, fresh.activityId)).outcome).toBe("active");
  });

  it("duplicate concurrent confirmations of the same proof produce at most one activation", async () => {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    const tab = await prepareTab(w, enrollmentId);
    const { spied, log } = spyOnActivate(w.enrollments);
    const results = await Promise.all([confirm(w, enrollmentId, tab.activityId, { enrollments: spied }), confirm(w, enrollmentId, tab.activityId, { enrollments: spied })]);
    expect(results.every((result) => result.outcome === "active")).toBe(true);
    expect(log.filter((entry) => entry.result === "activated")).toHaveLength(1);
    expect(await snapshot(w, enrollmentId)).toMatchObject({ state: "active", nonce: tab.nonce, activityId: tab.activityId, passkeyStatus: "active" });
  });

  it("a removal that wins first keeps its invariants: a valid nonce does not reactivate a removal_in_progress enrollment", async () => {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    const tab = await prepareTab(w, enrollmentId);
    expect(await w.enrollments.transition({ id: enrollmentId, from: "login_verified", to: "removal_in_progress", patch: {} })).not.toBeNull();
    expect(await w.enrollments.activate({ id: enrollmentId, signingProofActivityId: tab.activityId, signingProofChallenge: tab.nonce })).toBeNull();
    expect(await snapshot(w, enrollmentId)).toMatchObject({ state: "removal_in_progress", nonce: tab.nonce, activityId: null, verifiedAt: null, passkeyStatus: "pending" });
  });

  it("another account cannot confirm this enrollment's proof, and a vote from the wrong key never activates", async () => {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    const tab = await prepareTab(w, enrollmentId);
    expect(await confirm(w, enrollmentId, tab.activityId, { appUserId: "someone-else" })).toEqual({ outcome: "rejected", reason: "Unknown setup." });

    const wrong = await prepareTab(w, enrollmentId);
    const activity = w.fake.activities.get(wrong.activityId) as unknown as { votes: Array<{ publicKey: string }> };
    activity.votes = [{ ...activity.votes[0]!, publicKey: "A".repeat(43) }];
    expect((await confirm(w, enrollmentId, wrong.activityId)).outcome).toBe("rejected");
    expect((await snapshot(w, enrollmentId)).state).toBe("login_verified");
  });

  it("M3D-2 is unchanged: a read without usable evidence is still 'unavailable', charges once, and activates nothing", async () => {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    const tab = await prepareTab(w, enrollmentId);
    const budget = scriptedBudget({ allowed: true });
    const { spied, log } = spyOnActivate(w.enrollments);
    hooks.calls = { getActivity: 0, getUsers: 0, signRawPayload: 0 };
    hooks.getActivity = () => Promise.reject(new Error("socket hang up"));
    expect(await confirm(w, enrollmentId, tab.activityId, { enrollments: spied, limiter: budget.limiter })).toEqual({ outcome: "unavailable" });
    expect(budget.calls).toHaveLength(1);
    expect(log).toHaveLength(0);
    expect(hooks.calls.getActivity).toBe(1);
    expect((await snapshot(w, enrollmentId)).state).toBe("login_verified");
  });
});

// ---------------------------------------------------------------- in-memory store contract

describe("in-memory activate — exact-nonce contract", () => {
  async function ready() {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    const tab = await prepareTab(w, enrollmentId);
    return { w, enrollmentId, tab };
  }
  const untouched = (tab: { nonce: string }) => ({ state: "login_verified" as const, nonce: tab.nonce, activityId: null, verifiedAt: null, passkeyStatus: "pending" as const });

  it.each([
    ["an old/foreign nonce", () => `0x${"11".repeat(32)}`],
    ["a null nonce", () => null as unknown as string],
    ["an undefined nonce", () => undefined as unknown as string],
    ["an empty nonce", () => ""],
    ["a non-string nonce", () => 123 as unknown as string],
    ["the right nonce in upper case (no normalization)", (tab: { nonce: string }) => `0x${tab.nonce.slice(2).toUpperCase()}`],
    ["the right nonce with surrounding whitespace (no trimming)", (tab: { nonce: string }) => ` ${tab.nonce} `],
  ])("%s returns null and mutates nothing", async (_name, pick) => {
    const { w, enrollmentId, tab } = await ready();
    expect(await w.enrollments.activate({ id: enrollmentId, signingProofActivityId: tab.activityId, signingProofChallenge: pick(tab) })).toBeNull();
    expect(await snapshot(w, enrollmentId)).toEqual(untouched(tab));
  });

  it("an enrollment with NO stored nonce is never activated, whatever is supplied (a missing value is not a wildcard)", async () => {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    expect((await w.enrollments.findById(enrollmentId))!.signingProofChallenge).toBeNull();
    for (const supplied of [null, undefined, "", `0x${"22".repeat(32)}`]) {
      expect(await w.enrollments.activate({ id: enrollmentId, signingProofActivityId: "x", signingProofChallenge: supplied as unknown as string })).toBeNull();
    }
    expect((await snapshot(w, enrollmentId)).state).toBe("login_verified");
  });

  it("the exact stored nonce activates, once", async () => {
    const { w, enrollmentId, tab } = await ready();
    expect(await w.enrollments.activate({ id: enrollmentId, signingProofActivityId: tab.activityId, signingProofChallenge: tab.nonce })).toMatchObject({ state: "active", signingProofActivityId: tab.activityId });
    expect(await snapshot(w, enrollmentId)).toMatchObject({ state: "active", passkeyStatus: "active" });
    expect(await w.enrollments.activate({ id: enrollmentId, signingProofActivityId: "again", signingProofChallenge: tab.nonce })).toBeNull();
  });
});

// ---------------------------------------------------------------- Neon: the SQL actually sent (offline, intercepted fetch)

describe("Neon activate — the nonce predicate and its binding in the SQL actually sent", () => {
  const DATABASE_URL = "postgresql://user:pass@ep-nonce-test-000000.us-east-2.aws.neon.tech/neondb";
  const ID = "00000000-0000-4000-8000-000000000000";
  const NONCE = `0x${"ab".repeat(32)}`;
  type Query = { query: string; params: unknown[] };
  let sent: Array<{ isolation: string | null; queries: Query[] }> = [];

  beforeEach(() => {
    sent = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as { queries?: Query[] };
      sent.push({ isolation: new Headers(init?.headers).get("Neon-Batch-Isolation-Level"), queries: body.queries ?? [] });
      throw new Error("intercepted: no network in this test");
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const norm = (text: string) => text.replace(/\s+/g, " ").trim();

  it("sends ONE ReadCommitted batch: account lock FIRST, then an enrollment UPDATE whose WHERE carries the exact-nonce predicate bound from the argument", async () => {
    const stores = createNeonDurableStores(DATABASE_URL);
    await expect(stores.backupEnrollments.activate({ id: ID, signingProofActivityId: "activity-1", signingProofChallenge: NONCE })).rejects.toThrow();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.isolation).toBe(NEON_TRANSACTION_ISOLATION_LEVEL);
    expect(NEON_TRANSACTION_ISOLATION_LEVEL).toBe("ReadCommitted");

    const [lock, update, passkey, guard] = sent[0]!.queries;
    expect(sent[0]!.queries).toHaveLength(4);
    expect(norm(lock!.query)).toMatch(/^SELECT app_user_id FROM real_accounts WHERE .* FOR UPDATE$/);

    const updateText = norm(update!.query);
    expect(updateText).toContain("UPDATE backup_passkey_enrollments SET state = 'active'");
    expect(updateText).toMatch(/WHERE id = \$\d+ AND state = 'login_verified' AND login_verified_at IS NOT NULL AND signing_proof_challenge = \$\d+ RETURNING \*$/);
    // The nonce is a bound parameter (never interpolated), exactly as supplied, next to the id and activity id.
    expect(updateText).not.toContain(NONCE);
    expect(update!.params).toEqual(["activity-1", ID, NONCE]);

    // No-match leaves the other statements inert: the passkey update is keyed on state = 'active', and the guard only fires on a half-activation.
    expect(norm(passkey!.query)).toContain("state = 'active'");
    expect(norm(passkey!.query)).toContain("status = 'pending' AND turnkey_authenticator_id IS NOT NULL");
    expect(norm(guard!.query)).toContain("e.state = 'active'");
  });

  it.each([
    ["empty", ""],
    ["null", null],
    ["undefined", undefined],
  ])("a %s expected nonce returns null WITHOUT sending any SQL", async (_name, nonce) => {
    const stores = createNeonDurableStores(DATABASE_URL);
    expect(await stores.backupEnrollments.activate({ id: ID, signingProofActivityId: "activity-1", signingProofChallenge: nonce as unknown as string })).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("an unexpected database failure still propagates (existing error handling, no swallow, no retry)", async () => {
    const stores = createNeonDurableStores(DATABASE_URL);
    await expect(stores.backupEnrollments.activate({ id: ID, signingProofActivityId: "activity-1", signingProofChallenge: NONCE })).rejects.toThrow();
    expect(sent).toHaveLength(1);
  });
});
