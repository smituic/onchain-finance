import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bytesToBase64Url } from "@/lib/real/bytes";
import type { RealServerConfig } from "@/lib/real/server/config";
import { createInMemoryChallengeStore } from "@/lib/real/server/challenge-store";
import { createInMemoryRealAccountRegistry, type RealAccountRegistry } from "@/lib/real/server/registry";
import { createInMemoryBackupPasskeyEnrollmentStore, type BackupPasskeyEnrollmentStore } from "@/lib/real/server/backup-passkey-enrollment";
import { TURNKEY_STAMP_FRESHNESS_WINDOW_MS } from "@/lib/real/server/turnkey-signed-request";
import { buildAuthenticationResponseJSON, buildRegistrationResponseJSON, createFixtureAuthenticator, type FixtureAuthenticator } from "./fixtures/webauthn";
import { FakeTurnkey, signRequest, stampBody } from "./fixtures/turnkey-fake";

const turnkey: { fake: FakeTurnkey | null } = { fake: null };

vi.mock("@turnkey/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@turnkey/http")>();
  return {
    ...actual,
    TurnkeyClient: vi.fn().mockImplementation(function TurnkeyClientMock() {
      return {
        getUsers: (input: { organizationId: string }) => turnkey.fake!.getUsers(input),
        getActivity: (input: { organizationId: string; activityId: string }) => turnkey.fake!.getActivity(input),
      };
    }),
  };
});

const pipeline = await import("@/lib/real/server/backup-passkey-pipeline");
const { beginLogin, completeLogin } = await import("@/lib/real/server/login");
const { createInMemoryRegistrationAttemptStore } = await import("@/lib/real/server/registration-attempts");
const { readAuthenticatedRealAccount } = await import("@/lib/real/server/auth");
const { createSessionPayload, serializeSession } = await import("@/lib/real/server/session");

const ORIGIN = "http://localhost:3000";
const OWNER = privateKeyToAccount("0x119bb329df425b685a3f3483fba01deeb1db47d608cfb051da9ad4a12995238a");
const SAFE = "0xd9a4c22fb34dc74317edc8006140d66c8fa03266";
const CREATE_URL = "https://api.turnkey.com/public/v1/submit/create_authenticators";

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

type World = {
  registry: RealAccountRegistry;
  enrollments: BackupPasskeyEnrollmentStore;
  challengeStore: ReturnType<typeof createInMemoryChallengeStore>;
  fake: FakeTurnkey;
  primary: FixtureAuthenticator;
  clock: { now: number };
  deps: { fetchImpl: typeof fetch; now: () => number; sleep: () => Promise<void>; maxPolls: number };
};

async function world(): Promise<World> {
  const registry = createInMemoryRealAccountRegistry();
  const primary = createFixtureAuthenticator();
  await registry.createAccountWithPasskey({
    account: {
      appUserId: "app-user-1",
      subOrganizationId: "sub-org-1",
      turnkeyUserId: "turnkey-user-1",
      walletId: "wallet-1",
      walletAccountId: "wallet-account-1",
      ownerAddress: OWNER.address,
      safeAddress: SAFE,
      accountConfigVersion: 1,
    },
    passkey: {
      credentialId: primary.credentialIdBase64Url,
      appUserId: "app-user-1",
      credentialPublicKey: bytesToBase64Url(primary.publicKeyCose),
      userHandle: "primary-user-handle",
      counter: 0,
      transports: ["internal"],
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
    },
  });
  const fake = new FakeTurnkey("sub-org-1", "turnkey-user-1");
  fake.addAuthenticator(primary.credentialIdBase64Url, "authenticator-primary");
  await registry.transitionPasskeyStatus({ credentialId: primary.credentialIdBase64Url, from: "active", to: "active", patch: { turnkeyAuthenticatorId: "authenticator-primary" } });
  turnkey.fake = fake;
  const clock = { now: Date.now() };
  return {
    registry,
    enrollments: createInMemoryBackupPasskeyEnrollmentStore(registry),
    challengeStore: createInMemoryChallengeStore(),
    fake,
    primary,
    clock,
    deps: { fetchImpl: fake.fetchImpl, now: () => clock.now, sleep: async () => {}, maxPolls: 1 },
  };
}

async function registerBackup(w: World) {
  const begun = await pipeline.beginBackupEnrollment({ config, challengeStore: w.challengeStore, registry: w.registry, enrollments: w.enrollments, appUserId: "app-user-1" });
  if (begun.outcome !== "started") throw new Error(JSON.stringify(begun));
  const backup = createFixtureAuthenticator();
  const response = buildRegistrationResponseJSON({ authenticator: backup, challenge: begun.optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId });
  const registered = await pipeline.completeBackupCredentialRegistration({ config, challengeStore: w.challengeStore, registry: w.registry, enrollments: w.enrollments, appUserId: "app-user-1", response });
  if (registered.outcome !== "registered") throw new Error(JSON.stringify(registered));
  return { enrollmentId: begun.enrollmentId, backup, optionsJSON: begun.optionsJSON };
}

async function signedCreate(w: World, enrollmentId: string, opts: { signer?: FixtureAuthenticator; mutate?: (activity: Record<string, unknown>) => void; url?: string } = {}) {
  const prepared = await pipeline.prepareTurnkeyAuthorization({ config, registry: w.registry, enrollments: w.enrollments, appUserId: "app-user-1", enrollmentId, sessionCredentialId: w.primary.credentialIdBase64Url, now: () => w.clock.now });
  if (prepared.outcome !== "ready") throw new Error(JSON.stringify(prepared));
  const activity = JSON.parse(JSON.stringify(prepared.activity)) as Record<string, unknown>;
  opts.mutate?.(activity);
  return signRequest({ authenticator: opts.signer ?? w.primary, activity, url: opts.url ?? CREATE_URL, origin: ORIGIN, rpId: config.rpId });
}

function submit(w: World, enrollmentId: string, signedRequest: unknown) {
  return pipeline.submitTurnkeyAuthorization({ config, registry: w.registry, enrollments: w.enrollments, appUserId: "app-user-1", enrollmentId, sessionCredentialId: w.primary.credentialIdBase64Url, signedRequest, deps: w.deps });
}

function reconcile(w: World, enrollmentId: string) {
  return pipeline.reconcileTurnkeyEnrollment({ config, registry: w.registry, enrollments: w.enrollments, appUserId: "app-user-1", enrollmentId, deps: w.deps });
}

async function proofA(w: World, enrollmentId: string, answerer: FixtureAuthenticator, userHandle?: string) {
  const prepared = await pipeline.prepareBackupLoginVerification({ config, challengeStore: w.challengeStore, enrollments: w.enrollments, appUserId: "app-user-1", enrollmentId });
  if (prepared.outcome !== "ready") throw new Error(JSON.stringify(prepared));
  const pending = (await w.enrollments.findById(enrollmentId))!;
  const response = buildAuthenticationResponseJSON({ authenticator: answerer, challenge: prepared.optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId, userHandle: userHandle ?? pending.userHandle! });
  return pipeline.confirmBackupLoginVerification({ config, challengeStore: w.challengeStore, registry: w.registry, enrollments: w.enrollments, appUserId: "app-user-1", response });
}

/** Seeds the fake with a completed signRawPayload activity for the proof nonce, approved by `votePublicKey`, and confirms it. */
async function proofB(w: World, enrollmentId: string, opts: { votePublicKey?: string; payloadOverride?: Hex } = {}) {
  const prepared = await pipeline.prepareSigningProof({ config, registry: w.registry, enrollments: w.enrollments, appUserId: "app-user-1", enrollmentId });
  if (prepared.outcome !== "ready") throw new Error(JSON.stringify(prepared));
  const enrollment = (await w.enrollments.findById(enrollmentId))!;
  const payload = opts.payloadOverride ?? prepared.digest;
  const signature = await OWNER.sign({ hash: payload });
  const id = `sign-${Math.random().toString(16).slice(2)}`;
  w.fake.addActivity({
    id,
    status: "ACTIVITY_STATUS_COMPLETED",
    organizationId: "sub-org-1",
    type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
    intent: { signRawPayloadIntentV2: { signWith: OWNER.address, payload, encoding: "PAYLOAD_ENCODING_HEXADECIMAL", hashFunction: "HASH_FUNCTION_NO_OP" } },
    result: { signRawPayloadResult: { r: signature.slice(2, 66), s: signature.slice(66, 130), v: Number.parseInt(signature.slice(130), 16) === 27 ? "00" : "01" } },
    votes: [{ selection: "VOTE_SELECTION_APPROVED", activityId: id, userId: "turnkey-user-1", publicKey: opts.votePublicKey ?? enrollment.turnkeyAuthenticatorPublicKey }],
  });
  return pipeline.confirmSigningProof({ config, registry: w.registry, enrollments: w.enrollments, appUserId: "app-user-1", enrollmentId, activityId: id });
}

async function driveToActive(w: World) {
  const { enrollmentId, backup } = await registerBackup(w);
  expect((await submit(w, enrollmentId, await signedCreate(w, enrollmentId))).outcome).toBe("confirmed");
  expect((await proofA(w, enrollmentId, backup)).outcome).toBe("verified");
  expect((await proofB(w, enrollmentId)).outcome).toBe("active");
  return { enrollmentId, backup };
}

afterEach(() => {
  turnkey.fake = null;
});

describe("backup enrollment — local registration", () => {
  it("excludes the existing credential from the new ceremony", async () => {
    const w = await world();
    const { optionsJSON } = await registerBackup(w);
    expect(optionsJSON.excludeCredentials?.map((c) => c.id)).toContain(w.primary.credentialIdBase64Url);
  });

  it("re-registering the primary credential as the 'backup' is rejected", async () => {
    const w = await world();
    const begun = await pipeline.beginBackupEnrollment({ config, challengeStore: w.challengeStore, registry: w.registry, enrollments: w.enrollments, appUserId: "app-user-1" });
    if (begun.outcome !== "started") throw new Error("setup");
    const response = buildRegistrationResponseJSON({ authenticator: w.primary, challenge: begun.optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId });
    const result = await pipeline.completeBackupCredentialRegistration({ config, challengeStore: w.challengeStore, registry: w.registry, enrollments: w.enrollments, appUserId: "app-user-1", response });
    expect(result.outcome).toBe("rejected");
  });

  it("a registration challenge minted for one account can't be completed by another session", async () => {
    const w = await world();
    const begun = await pipeline.beginBackupEnrollment({ config, challengeStore: w.challengeStore, registry: w.registry, enrollments: w.enrollments, appUserId: "app-user-1" });
    if (begun.outcome !== "started") throw new Error("setup");
    const response = buildRegistrationResponseJSON({ authenticator: createFixtureAuthenticator(), challenge: begun.optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId });
    const result = await pipeline.completeBackupCredentialRegistration({ config, challengeStore: w.challengeStore, registry: w.registry, enrollments: w.enrollments, appUserId: "someone-else", response });
    expect(result.outcome).toBe("rejected");
  });

  it("the new credential is a distinct id, pending, role backup, same app user — and pending cannot log in", async () => {
    const w = await world();
    const { enrollmentId, backup } = await registerBackup(w);
    expect(backup.credentialIdBase64Url).not.toBe(w.primary.credentialIdBase64Url);
    const passkey = await w.registry.findPasskeyByCredentialId(backup.credentialIdBase64Url);
    expect(passkey).toMatchObject({ status: "pending", role: "backup", appUserId: "app-user-1" });
    expect((await w.enrollments.findById(enrollmentId))?.state).toBe("credential_registered");

    const loginChallenges = createInMemoryChallengeStore();
    const { optionsJSON } = await beginLogin({ config, challengeStore: loginChallenges });
    const response = buildAuthenticationResponseJSON({ authenticator: backup, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId, userHandle: passkey!.userHandle });
    expect((await completeLogin({ config, challengeStore: loginChallenges, registry: w.registry, attempts: createInMemoryRegistrationAttemptStore(), response })).outcome).toBe("rejected");
  });

  it("pending-insert/attach race: two credentials racing onto one enrollment — exactly one attaches, the loser leaves NO orphan pending passkey", async () => {
    const w = await world();
    const created = (await w.enrollments.createStarted({ appUserId: "app-user-1" }))!;
    const credential = (id: string) => ({
      credentialId: id,
      userHandle: "h",
      credentialPublicKey: "k",
      counter: 0,
      transports: null,
      credentialDeviceType: null,
      credentialBackedUp: null,
      registrationChallenge: "c",
      rawClientDataJson: "d",
      rawAttestationObject: "a",
    });
    const [a, b] = await Promise.all([
      w.enrollments.registerCredential({ id: created.id, credential: credential("cred-a") }),
      w.enrollments.registerCredential({ id: created.id, credential: credential("cred-b") }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const pending = (await w.registry.findPasskeysByAppUserId("app-user-1")).filter((p) => p.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.credentialId).toBe((a ?? b)!.newCredentialId);
  });
});

describe("backup enrollment — Model B dispatch of the child-authorized create", () => {
  it("raw-forwards the EXACT previously signed body and stamp, and only to the server-derived endpoint", async () => {
    const w = await world();
    const { enrollmentId } = await registerBackup(w);
    const signed = await signedCreate(w, enrollmentId);
    expect((await submit(w, enrollmentId, signed)).outcome).toBe("confirmed");
    expect(w.fake.forwarded).toHaveLength(1);
    expect(w.fake.forwarded[0]!.url).toBe(CREATE_URL);
    expect(w.fake.forwarded[0]!.body).toBe(signed.body);
    expect(w.fake.forwarded[0]!.headers["X-Stamp-Webauthn"]).toBe(signed.stamp.stampHeaderValue);
  });

  it("the server cannot authorize the create itself: a stamp from any credential other than the session's is rejected and never forwarded", async () => {
    const w = await world();
    const { enrollmentId } = await registerBackup(w);
    const forged = await signedCreate(w, enrollmentId, { signer: createFixtureAuthenticator({ credentialId: w.primary.credentialId }) });
    expect((await submit(w, enrollmentId, forged)).outcome).toBe("rejected");
    expect((await submit(w, enrollmentId, { body: forged.body, url: CREATE_URL, stamp: { stampHeaderName: "X-Stamp", stampHeaderValue: "x" } })).outcome).toBe("rejected");
    expect(w.fake.forwarded).toHaveLength(0);
  });

  it.each([
    ["different organization", (a: Record<string, unknown>) => (a.organizationId = "other-org")],
    ["different Turnkey user", (a: Record<string, unknown>) => ((a.parameters as Record<string, unknown>).userId = "other-user")],
    ["different activity type", (a: Record<string, unknown>) => (a.type = "ACTIVITY_TYPE_CREATE_API_KEYS")],
    ["different credential", (a: Record<string, unknown>) => ((((a.parameters as Record<string, unknown>).authenticators as Array<Record<string, Record<string, unknown>>>)[0]!.attestation!).credentialId = "AAAA")],
    ["an extra top-level field", (a: Record<string, unknown>) => (a.generateAppProofs = true)],
    ["a second authenticator", (a: Record<string, unknown>) => {
      const list = (a.parameters as Record<string, unknown>).authenticators as unknown[];
      list.push(list[0]);
    }],
  ])("a signed body with %s is rejected and never forwarded", async (_label, mutate) => {
    const w = await world();
    const { enrollmentId } = await registerBackup(w);
    const signed = await signedCreate(w, enrollmentId, { mutate });
    expect((await submit(w, enrollmentId, signed)).outcome).toBe("rejected");
    expect(w.fake.forwarded).toHaveLength(0);
    expect((await w.enrollments.findById(enrollmentId))?.state).toBe("credential_registered");
  });

  it("an arbitrary browser-supplied URL is rejected", async () => {
    const w = await world();
    const { enrollmentId } = await registerBackup(w);
    const signed = await signedCreate(w, enrollmentId, { url: "https://evil.example/public/v1/submit/create_authenticators" });
    expect((await submit(w, enrollmentId, signed)).outcome).toBe("rejected");
    expect(w.fake.forwarded).toHaveLength(0);
  });

  it("a stale signed request is rejected before any durable claim", async () => {
    const w = await world();
    const { enrollmentId } = await registerBackup(w);
    const signed = await signedCreate(w, enrollmentId);
    w.clock.now += TURNKEY_STAMP_FRESHNESS_WINDOW_MS + 1;
    expect((await submit(w, enrollmentId, signed)).outcome).toBe("rejected");
    expect(w.fake.forwarded).toHaveLength(0);
  });

  it("the attempt is durably 'in flight / unknown' with the exact request recorded BEFORE the external POST", async () => {
    const w = await world();
    const { enrollmentId } = await registerBackup(w);
    const signed = await signedCreate(w, enrollmentId);
    let seenAtForward: unknown = null;
    w.fake.onForward = async () => {
      seenAtForward = await w.enrollments.findById(enrollmentId);
    };
    await submit(w, enrollmentId, signed);
    expect(seenAtForward).toMatchObject({ state: "turnkey_enrollment_in_flight", externalOutcome: "unknown", turnkeyRequestBody: signed.body, turnkeyRequestEndpoint: "create_authenticators" });
  });

  it("confirmation matches by credential-id BYTES (Turnkey echoes standard base64) and records the authenticator id and public key; the stamp is cleared", async () => {
    const w = await world();
    const { enrollmentId, backup } = await registerBackup(w);
    await submit(w, enrollmentId, await signedCreate(w, enrollmentId));
    const enrollment = await w.enrollments.findById(enrollmentId);
    const created = w.fake.authenticators().find((a) => a.authenticatorId !== "authenticator-primary")!;
    expect(created.credentialId).not.toBe(backup.credentialIdBase64Url); // different string form...
    expect(enrollment).toMatchObject({ state: "turnkey_authenticator_created", externalOutcome: "confirmed_created", turnkeyAuthenticatorId: created.authenticatorId, turnkeyAuthenticatorPublicKey: created.credential.publicKey, turnkeyRequestStamp: null });
    expect((await w.registry.findPasskeyByCredentialId(backup.credentialIdBase64Url))?.turnkeyAuthenticatorId).toBe(created.authenticatorId); // ...same bytes
  });

  it("two concurrent authorizations for one enrollment forward AT MOST one activity", async () => {
    const w = await world();
    const { enrollmentId } = await registerBackup(w);
    const first = await signedCreate(w, enrollmentId);
    w.clock.now += 1;
    const second = await signedCreate(w, enrollmentId);
    const results = await Promise.all([submit(w, enrollmentId, first), submit(w, enrollmentId, second)]);
    expect(results.filter((r) => r.outcome === "rejected")).toHaveLength(1);
    expect(w.fake.forwarded).toHaveLength(1);
    expect(w.fake.authenticators()).toHaveLength(2);
  });

  it("crash after Turnkey success but before the response: reconciliation only ever replays the SAME bytes (never a new create) and ends with exactly one new authenticator", async () => {
    const w = await world();
    const { enrollmentId } = await registerBackup(w);
    const signed = await signedCreate(w, enrollmentId);
    w.fake.nextMode = "lose_response_after_apply";
    w.fake.lagReads = true;
    expect((await submit(w, enrollmentId, signed)).outcome).toBe("pending");
    w.fake.nextMode = "ok";
    w.fake.propagate();
    expect((await reconcile(w, enrollmentId)).outcome).toBe("confirmed");
    expect(new Set(w.fake.forwarded.map((f) => f.body))).toEqual(new Set([signed.body]));
    expect(w.fake.authenticators()).toHaveLength(2);
    // A fresh authorization can no longer even be prepared or submitted.
    expect((await pipeline.prepareTurnkeyAuthorization({ config, registry: w.registry, enrollments: w.enrollments, appUserId: "app-user-1", enrollmentId, sessionCredentialId: w.primary.credentialIdBase64Url })).outcome).toBe("rejected");
    expect((await submit(w, enrollmentId, signed)).outcome).toBe("rejected");
  });

  it("lost response after the replay window: never replays or re-stamps; read-only discovery confirms the create by bytes", async () => {
    const w = await world();
    const { enrollmentId } = await registerBackup(w);
    w.fake.nextMode = "lose_response_after_apply";
    w.fake.lagReads = true;
    await submit(w, enrollmentId, await signedCreate(w, enrollmentId));
    const forwardsBefore = w.fake.forwarded.length;
    w.fake.nextMode = "ok";
    w.fake.propagate();
    w.clock.now += TURNKEY_STAMP_FRESHNESS_WINDOW_MS + 1;
    expect((await reconcile(w, enrollmentId)).outcome).toBe("confirmed");
    expect(w.fake.forwarded).toHaveLength(forwardsBefore);
  });

  it("lost response before Turnkey applied it, window expired: 'not found' is NOT failure — stays pending/unknown, never abandonable, the stamp is cleared", async () => {
    const w = await world();
    const { enrollmentId } = await registerBackup(w);
    w.fake.nextMode = "lose_response_before_apply";
    await submit(w, enrollmentId, await signedCreate(w, enrollmentId));
    const forwardsBefore = w.fake.forwarded.length;
    w.clock.now += TURNKEY_STAMP_FRESHNESS_WINDOW_MS + 1;
    expect((await reconcile(w, enrollmentId)).outcome).toBe("pending");
    const enrollment = (await w.enrollments.findById(enrollmentId))!;
    expect(enrollment).toMatchObject({ state: "turnkey_enrollment_in_flight", externalOutcome: "unknown", turnkeyRequestStamp: null });
    expect((await pipeline.abandonBackupEnrollment({ enrollments: w.enrollments, appUserId: "app-user-1", enrollmentId })).outcome).toBe("rejected");
    expect(w.fake.forwarded).toHaveLength(forwardsBefore);
    expect(new Set(w.fake.forwarded.map((f) => f.body)).size).toBe(1);
  });

  it("a PENDING activity is polled read-only (never resubmitted) until it completes", async () => {
    const w = await world();
    const { enrollmentId } = await registerBackup(w);
    w.fake.nextMode = "pending_activity";
    expect((await submit(w, enrollmentId, await signedCreate(w, enrollmentId))).outcome).toBe("pending");
    const activityId = (await w.enrollments.findById(enrollmentId))!.turnkeyActivityId!;
    const newCredential = (await w.enrollments.findById(enrollmentId))!.newCredentialId!;
    const created = w.fake.addAuthenticator(newCredential);
    w.fake.activities.get(activityId)!.status = "ACTIVITY_STATUS_COMPLETED";
    w.fake.activities.get(activityId)!.result = { createAuthenticatorsResult: { authenticatorIds: [created.authenticatorId] } };
    expect((await reconcile(w, enrollmentId)).outcome).toBe("confirmed");
    expect(w.fake.forwarded).toHaveLength(1);
  });

  it("a FAILED activity is Turnkey's proof nothing was created: back to credential_registered, re-authorizable or abandonable", async () => {
    const w = await world();
    const { enrollmentId } = await registerBackup(w);
    w.fake.nextMode = "fail_activity";
    expect((await submit(w, enrollmentId, await signedCreate(w, enrollmentId))).outcome).toBe("failed_retryable");
    expect((await w.enrollments.findById(enrollmentId))).toMatchObject({ state: "credential_registered", externalOutcome: "definitive_failure", turnkeyRequestBody: null });
    w.fake.nextMode = "ok";
    w.clock.now += 1;
    expect((await submit(w, enrollmentId, await signedCreate(w, enrollmentId))).outcome).toBe("confirmed");
  });

  it("H2: with NO same-body dedupe — original create lands but its response is lost, the replay comes back FAILED — getUsers still shows the authenticator, so creation is CONFIRMED, not definitive_failure", async () => {
    const w = await world();
    const { enrollmentId, backup } = await registerBackup(w);
    w.fake.dedupeByBody = false;
    w.fake.modeQueue = ["lose_response_after_apply", "fail_activity"];
    const result = await submit(w, enrollmentId, await signedCreate(w, enrollmentId));
    expect(w.fake.forwarded).toHaveLength(2); // original + one byte-identical replay
    const replayActivity = [...w.fake.activities.values()].at(-1)!;
    expect(replayActivity.status).toBe("ACTIVITY_STATUS_FAILED");
    expect(result.outcome).toBe("confirmed");
    const enrollment = (await w.enrollments.findById(enrollmentId))!;
    expect(enrollment).toMatchObject({ state: "turnkey_authenticator_created", externalOutcome: "confirmed_created" });
    const created = w.fake.authenticators().find((a) => a.authenticatorId !== "authenticator-primary")!;
    expect((await w.registry.findPasskeyByCredentialId(backup.credentialIdBase64Url))?.turnkeyAuthenticatorId).toBe(created.authenticatorId);
  });

  it("H2: a FAILED activity with an AMBIGUOUS getUsers result blocks for review instead of declaring failure", async () => {
    const w = await world();
    const { enrollmentId } = await registerBackup(w);
    const newCredential = (await w.enrollments.findById(enrollmentId))!.newCredentialId!;
    w.fake.addAuthenticator(newCredential);
    w.fake.addAuthenticator(newCredential);
    w.fake.nextMode = "fail_activity";
    expect((await submit(w, enrollmentId, await signedCreate(w, enrollmentId))).outcome).toBe("blocked");
  });

  it("exact-bytes binding: a create body re-serialized after stamping (same JSON meaning, different bytes) is rejected and never forwarded", async () => {
    const reserializers = [
      (b: string) => JSON.stringify(JSON.parse(b), null, 1),
      (b: string) => JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(b) as Record<string, unknown>).reverse())),
    ];
    for (const reserialize of reserializers) {
      const w = await world();
      const { enrollmentId } = await registerBackup(w);
      const signed = await signedCreate(w, enrollmentId);
      const altered = reserialize(signed.body);
      expect(altered).not.toBe(signed.body);
      expect(JSON.parse(altered)).toEqual(JSON.parse(signed.body));
      // Same meaning passes every semantic check; only the stamp — bound to the exact bytes — refuses it.
      expect(await submit(w, enrollmentId, { ...signed, body: altered })).toEqual({ outcome: "rejected", reason: "The authorization wasn't signed by your current passkey." });
      expect(w.fake.forwarded).toHaveLength(0);
      expect((await w.enrollments.findById(enrollmentId))?.state).toBe("credential_registered");
    }
  });

  it.each([
    ["a root duplicate", (b: string) => b.replace('"organizationId":"sub-org-1"', '"organizationId":"other-org","organizationId":"sub-org-1"')],
    ["a nested duplicate", (b: string) => b.replace('"userId":"turnkey-user-1"', '"userId":"other-user","userId":"turnkey-user-1"')],
    ["a duplicate deep inside the authenticators array", (b: string) => b.replace(/"credentialId":"([^"]+)"/, '"credentialId":"AAAA","credentialId":"$1"')],
    ["an escaped spelling of the same name", (b: string) => b.replace('"organizationId":"sub-org-1"', '"organizationId":"other-org","organizati\\u006fnId":"sub-org-1"')],
  ])("a create body with %s is rejected before semantic validation, state unchanged, never forwarded — even though validly stamped and JSON.parse reads it correctly", async (_label, alter) => {
    const w = await world();
    const { enrollmentId } = await registerBackup(w);
    const signed = await signedCreate(w, enrollmentId);
    const body = alter(signed.body);
    expect(body).not.toBe(signed.body);
    expect(JSON.parse(body)).toEqual(JSON.parse(signed.body));
    const duplicated = { ...signed, body, stamp: stampBody({ authenticator: w.primary, body, origin: ORIGIN, rpId: config.rpId }) };
    expect(await submit(w, enrollmentId, duplicated)).toEqual({ outcome: "rejected", reason: "The signed request is not acceptable." });
    expect(w.fake.forwarded).toHaveLength(0);
    expect(await w.enrollments.findById(enrollmentId)).toMatchObject({ state: "credential_registered", externalOutcome: "not_attempted", turnkeyRequestBody: null });
  });

  it("a COMPLETED activity whose result names a different authenticator than the one found for this credential blocks for review", async () => {
    const w = await world();
    const { enrollmentId } = await registerBackup(w);
    w.fake.nextMode = "pending_activity";
    await submit(w, enrollmentId, await signedCreate(w, enrollmentId));
    const enrollment = (await w.enrollments.findById(enrollmentId))!;
    w.fake.addAuthenticator(enrollment.newCredentialId!);
    Object.assign(w.fake.activities.get(enrollment.turnkeyActivityId!)!, { status: "ACTIVITY_STATUS_COMPLETED", result: { createAuthenticatorsResult: { authenticatorIds: ["someone-elses"] } } });
    expect((await reconcile(w, enrollmentId)).outcome).toBe("blocked");
  });
});

describe("backup enrollment — resume and abandon", () => {
  it("status reports every meaningful state from durable storage, with abandonable only when no Turnkey attempt is outstanding", async () => {
    const w = await world();
    const status = () => pipeline.getActiveBackupEnrollment({ enrollments: w.enrollments, appUserId: "app-user-1" });
    expect(await status()).toBeNull();

    const begun = await pipeline.beginBackupEnrollment({ config, challengeStore: w.challengeStore, registry: w.registry, enrollments: w.enrollments, appUserId: "app-user-1" });
    if (begun.outcome !== "started") throw new Error("setup");
    expect(await status()).toMatchObject({ state: "started", abandonable: true });

    const backup = createFixtureAuthenticator();
    const response = buildRegistrationResponseJSON({ authenticator: backup, challenge: begun.optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId });
    await pipeline.completeBackupCredentialRegistration({ config, challengeStore: w.challengeStore, registry: w.registry, enrollments: w.enrollments, appUserId: "app-user-1", response });
    expect(await status()).toMatchObject({ state: "credential_registered", abandonable: true });

    w.fake.nextMode = "pending_activity";
    await submit(w, begun.enrollmentId, await signedCreate(w, begun.enrollmentId));
    expect(await status()).toMatchObject({ state: "turnkey_enrollment_in_flight", abandonable: false });

    const enrollment = (await w.enrollments.findById(begun.enrollmentId))!;
    const created = w.fake.addAuthenticator(enrollment.newCredentialId!);
    Object.assign(w.fake.activities.get(enrollment.turnkeyActivityId!)!, { status: "ACTIVITY_STATUS_COMPLETED", result: { createAuthenticatorsResult: { authenticatorIds: [created.authenticatorId] } } });
    await reconcile(w, begun.enrollmentId);
    expect(await status()).toMatchObject({ state: "turnkey_authenticator_created", abandonable: false });

    await proofA(w, begun.enrollmentId, backup);
    expect(await status()).toMatchObject({ state: "login_verified", abandonable: false });

    await proofB(w, begun.enrollmentId);
    expect(await status()).toBeNull(); // 'active' is terminal
    expect((await w.enrollments.findById(begun.enrollmentId))?.state).toBe("active");
  });

  it("a second setup can't start while one is past 'started', but a stale 'started' re-mints on the SAME row", async () => {
    const w = await world();
    const a = await pipeline.beginBackupEnrollment({ config, challengeStore: w.challengeStore, registry: w.registry, enrollments: w.enrollments, appUserId: "app-user-1" });
    const b = await pipeline.beginBackupEnrollment({ config, challengeStore: w.challengeStore, registry: w.registry, enrollments: w.enrollments, appUserId: "app-user-1" });
    expect(a.outcome === "started" && b.outcome === "started" && a.enrollmentId === b.enrollmentId).toBe(true);
    const w2 = await world();
    await registerBackup(w2);
    expect((await pipeline.beginBackupEnrollment({ config, challengeStore: w2.challengeStore, registry: w2.registry, enrollments: w2.enrollments, appUserId: "app-user-1" })).outcome).toBe("already_in_progress");
  });

  it("abandoning a pre-dispatch enrollment cleans up its orphan pending passkey (revoked — it never reached Turnkey)", async () => {
    const w = await world();
    const { enrollmentId, backup } = await registerBackup(w);
    expect((await pipeline.abandonBackupEnrollment({ enrollments: w.enrollments, appUserId: "app-user-1", enrollmentId })).outcome).toBe("abandoned");
    expect((await w.registry.findPasskeyByCredentialId(backup.credentialIdBase64Url))?.status).toBe("revoked");
    expect(await pipeline.getActiveBackupEnrollment({ enrollments: w.enrollments, appUserId: "app-user-1" })).toBeNull();
    expect(w.fake.forwarded).toHaveLength(0);
  });

  it("another account's session can't read, act on, or abandon this enrollment", async () => {
    const w = await world();
    const { enrollmentId } = await registerBackup(w);
    expect((await pipeline.abandonBackupEnrollment({ enrollments: w.enrollments, appUserId: "intruder", enrollmentId })).outcome).toBe("rejected");
    expect((await pipeline.prepareTurnkeyAuthorization({ config, registry: w.registry, enrollments: w.enrollments, appUserId: "intruder", enrollmentId, sessionCredentialId: w.primary.credentialIdBase64Url })).outcome).toBe("rejected");
  });
});

describe("backup enrollment — Proof A (app authentication by the new credential)", () => {
  it("the new credential's assertion verifies against its stored key and advances — without minting a session", async () => {
    const w = await world();
    const { enrollmentId, backup } = await registerBackup(w);
    await submit(w, enrollmentId, await signedCreate(w, enrollmentId));
    const result = await proofA(w, enrollmentId, backup);
    expect(result).toEqual({ outcome: "verified" });
    expect((await w.enrollments.findById(enrollmentId))?.state).toBe("login_verified");
  });

  it("the primary credential cannot satisfy the new credential's verification", async () => {
    const w = await world();
    const { enrollmentId } = await registerBackup(w);
    await submit(w, enrollmentId, await signedCreate(w, enrollmentId));
    expect((await proofA(w, enrollmentId, w.primary, "primary-user-handle")).outcome).toBe("rejected");
    expect((await w.enrollments.findById(enrollmentId))?.state).toBe("turnkey_authenticator_created");
  });
});

describe("backup enrollment — Proof B (Turnkey authorization attributed to the new authenticator)", () => {
  async function toLoginVerified() {
    const w = await world();
    const { enrollmentId, backup } = await registerBackup(w);
    await submit(w, enrollmentId, await signedCreate(w, enrollmentId));
    await proofA(w, enrollmentId, backup);
    return { w, enrollmentId, backup };
  }

  it("an APPROVED vote by the new authenticator's key + owner-recovering signature activates both rows together", async () => {
    const { w, enrollmentId, backup } = await toLoginVerified();
    expect((await proofB(w, enrollmentId)).outcome).toBe("active");
    expect((await w.enrollments.findById(enrollmentId))?.state).toBe("active");
    expect((await w.registry.findPasskeyByCredentialId(backup.credentialIdBase64Url))?.status).toBe("active");
  });

  it("a vote by the PRIMARY authenticator cannot satisfy the pending backup's proof, even though its signature recovers the same owner", async () => {
    const { w, enrollmentId, backup } = await toLoginVerified();
    const primaryKey = w.fake.authenticators().find((a) => a.authenticatorId === "authenticator-primary")!.credential.publicKey;
    expect((await proofB(w, enrollmentId, { votePublicKey: primaryKey })).outcome).toBe("rejected");
    expect((await w.registry.findPasskeyByCredentialId(backup.credentialIdBase64Url))?.status).toBe("pending");
  });

  it("a signature over anything other than this setup's nonce is rejected", async () => {
    const { w, enrollmentId } = await toLoginVerified();
    expect((await proofB(w, enrollmentId, { payloadOverride: `0x${"ab".repeat(32)}` })).outcome).toBe("rejected");
  });

  it("activation is idempotent under retry and concurrency — never 'passkey active + enrollment unfinished' or the reverse", async () => {
    const { w, enrollmentId, backup } = await toLoginVerified();
    const [a, b] = await Promise.all([w.enrollments.activate({ id: enrollmentId, signingProofActivityId: "x" }), w.enrollments.activate({ id: enrollmentId, signingProofActivityId: "y" })]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((await w.enrollments.findById(enrollmentId))?.state).toBe("active");
    expect((await w.registry.findPasskeyByCredentialId(backup.credentialIdBase64Url))?.status).toBe("active");
    expect((await proofB(w, enrollmentId).catch(() => ({ outcome: "prepare-refused" }))).outcome).toBe("prepare-refused");
  });
});

describe("backup enrollment — end-to-end invariants", () => {
  it("same app user / Turnkey user / owner / Safe throughout; backup logs in through the ordinary path; its session resolves to the same account", async () => {
    const w = await world();
    const before = await w.registry.findAccountByAppUserId("app-user-1");
    const { backup } = await driveToActive(w);
    expect(await w.registry.findAccountByAppUserId("app-user-1")).toEqual(before);

    const challengeStore = createInMemoryChallengeStore();
    const { optionsJSON } = await beginLogin({ config, challengeStore });
    const passkey = (await w.registry.findPasskeyByCredentialId(backup.credentialIdBase64Url))!;
    const response = buildAuthenticationResponseJSON({ authenticator: backup, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId, userHandle: passkey.userHandle });
    const login = await completeLogin({ config, challengeStore, registry: w.registry, attempts: createInMemoryRegistrationAttemptStore(), response });
    expect(login.outcome).toBe("verified");
    if (login.outcome !== "verified") return;
    expect(login.account).toEqual(before);
    const cookie = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: backup.credentialIdBase64Url }), config.sessionSecret);
    expect((await readAuthenticatedRealAccount({ cookieValue: cookie, sessionSecret: config.sessionSecret, registry: w.registry }))?.account.safeAddress).toBe(SAFE);
  });
});
