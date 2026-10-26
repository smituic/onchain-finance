import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bytesToBase64Url } from "@/lib/real/bytes";
import type { RealServerConfig } from "@/lib/real/server/config";
import { createInMemoryChallengeStore } from "@/lib/real/server/challenge-store";
import { createInMemoryRealAccountRegistry, getInMemoryRegistryInternals, type RealAccountRegistry } from "@/lib/real/server/registry";
import { createInMemoryBackupPasskeyEnrollmentStore, type BackupPasskeyEnrollmentStore } from "@/lib/real/server/backup-passkey-enrollment";
import { createInMemoryPasskeyRevocationStore, type PasskeyRevocationStore } from "@/lib/real/server/passkey-revocation-attempts";
import { TURNKEY_STAMP_FRESHNESS_WINDOW_MS } from "@/lib/real/server/turnkey-signed-request";
import { buildAuthenticationResponseJSON, buildRegistrationResponseJSON, createFixtureAuthenticator, type FixtureAuthenticator } from "./fixtures/webauthn";
import { FakeTurnkey, signRequest } from "./fixtures/turnkey-fake";
import { createInMemoryProviderBudgetStore, createProviderBudgetLimiter } from "@/lib/real/server/rate-limit";
import { TURNKEY_RECONCILE_POLICIES } from "@/lib/real/server/turnkey-reconcile-budget";
import { realBudget, scriptedBudget } from "./fixtures/chain-read-budget";

/** A fresh in-memory provider budget per call: these tests exercise reconciliation, not throttling (see turnkey-reconcile-budget.test.ts). */
const unthrottledBudget = () => createProviderBudgetLimiter(createInMemoryProviderBudgetStore());

/**
 * 2g-H behavioral tests.
 *
 * H1: a stolen app cookie alone must never choose/register a backup
 * credential. Every registration challenge requires a fresh step-up by the
 * CURRENT SESSION CREDENTIAL; only the newest mint attaches; only that same
 * session credential may authorize the Turnkey create.
 *
 * H2 / authority lifecycle: a credential that MAY hold Turnkey authority is
 * never treated as harmless, is always removable or reconcilable, and keeps
 * holding the one-open-enrollment slot until its absence is PROVEN (completed
 * delete + absence read). Blocked removals are retryable, never automatically.
 * A dispatched create never leads to a second create on a bare getUsers miss.
 */

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
const revocation = await import("@/lib/real/server/passkey-revocation");

const ORIGIN = "http://localhost:3000";
const OWNER = privateKeyToAccount("0x119bb329df425b685a3f3483fba01deeb1db47d608cfb051da9ad4a12995238a");
const SAFE = "0xd9a4c22fb34dc74317edc8006140d66c8fa03266";
const CREATE_URL = "https://api.turnkey.com/public/v1/submit/create_authenticators";
const DELETE_URL = "https://api.turnkey.com/public/v1/submit/delete_authenticators";
const APP_USER = "app-user-1";
const PRIMARY_HANDLE = "primary-user-handle";

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
  revocations: PasskeyRevocationStore;
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
    account: { appUserId: APP_USER, subOrganizationId: "sub-org-1", turnkeyUserId: "turnkey-user-1", walletId: "wallet-1", walletAccountId: "wallet-account-1", ownerAddress: OWNER.address, safeAddress: SAFE, accountConfigVersion: 1 },
    passkey: { credentialId: primary.credentialIdBase64Url, appUserId: APP_USER, credentialPublicKey: bytesToBase64Url(primary.publicKeyCose), userHandle: PRIMARY_HANDLE, counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false },
  });
  const fake = new FakeTurnkey("sub-org-1", "turnkey-user-1");
  fake.addAuthenticator(primary.credentialIdBase64Url, "authenticator-primary");
  await registry.transitionPasskeyStatus({ credentialId: primary.credentialIdBase64Url, from: "active", to: "active", patch: { turnkeyAuthenticatorId: "authenticator-primary" } });
  turnkey.fake = fake;
  const clock = { now: Date.now() };
  return {
    registry,
    enrollments: createInMemoryBackupPasskeyEnrollmentStore(registry),
    revocations: createInMemoryPasskeyRevocationStore(registry),
    challengeStore: createInMemoryChallengeStore(),
    fake,
    primary,
    clock,
    deps: { fetchImpl: fake.fetchImpl, now: () => clock.now, sleep: async () => {}, maxPolls: 1 },
  };
}

// ------------------------------------------------------------------ helpers

/** A step-up challenge minted for `session` (default: the primary), answered by `answerer` (default: the session itself). */
async function stepUp(w: World, opts: { session?: FixtureAuthenticator; answerer?: FixtureAuthenticator; userHandle?: string; userVerified?: boolean } = {}) {
  const session = opts.session ?? w.primary;
  const prepared = await pipeline.prepareBackupStepUp({ config, challengeStore: w.challengeStore, registry: w.registry, appUserId: APP_USER, sessionCredentialId: session.credentialIdBase64Url });
  if (prepared.outcome !== "ready") throw new Error(JSON.stringify(prepared));
  const answerer = opts.answerer ?? session;
  const handle = opts.userHandle ?? (await w.registry.findPasskeyByCredentialId(answerer.credentialIdBase64Url))?.userHandle ?? "attacker-handle";
  return {
    optionsJSON: prepared.optionsJSON,
    response: buildAuthenticationResponseJSON({ authenticator: answerer, challenge: prepared.optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId, userHandle: handle, userVerified: opts.userVerified }),
  };
}

function begin(w: World, stepUpResponse: unknown, session: FixtureAuthenticator = w.primary) {
  return pipeline.beginBackupEnrollment({ config, challengeStore: w.challengeStore, registry: w.registry, enrollments: w.enrollments, appUserId: APP_USER, sessionCredentialId: session.credentialIdBase64Url, stepUpResponse });
}

/** Whether a brand-new backup setup could start right now (the one-open-enrollment slot). Uses a real step-up. */
async function slotIsFree(w: World) {
  const outcome = (await begin(w, (await stepUp(w)).response)).outcome;
  if (outcome !== "started" && outcome !== "already_in_progress") throw new Error(outcome);
  return outcome === "started";
}

function register(w: World, credential: FixtureAuthenticator, challenge: string, session: FixtureAuthenticator = w.primary) {
  const response = buildRegistrationResponseJSON({ authenticator: credential, challenge, origin: ORIGIN, rpId: config.rpId });
  return pipeline.completeBackupCredentialRegistration({ config, challengeStore: w.challengeStore, registry: w.registry, enrollments: w.enrollments, appUserId: APP_USER, sessionCredentialId: session.credentialIdBase64Url, response });
}

function prepareCreate(w: World, enrollmentId: string, session: FixtureAuthenticator = w.primary) {
  return pipeline.prepareTurnkeyAuthorization({ config, registry: w.registry, enrollments: w.enrollments, appUserId: APP_USER, enrollmentId, sessionCredentialId: session.credentialIdBase64Url, now: () => w.clock.now });
}

async function signedCreate(w: World, enrollmentId: string, session: FixtureAuthenticator = w.primary) {
  const prepared = await prepareCreate(w, enrollmentId, session);
  if (prepared.outcome !== "ready") throw new Error(JSON.stringify(prepared));
  return signRequest({ authenticator: session, activity: prepared.activity, url: CREATE_URL, origin: ORIGIN, rpId: config.rpId });
}

function submitCreate(w: World, enrollmentId: string, signedRequest: unknown, session: FixtureAuthenticator = w.primary) {
  return pipeline.submitTurnkeyAuthorization({ config, registry: w.registry, enrollments: w.enrollments, appUserId: APP_USER, enrollmentId, sessionCredentialId: session.credentialIdBase64Url, signedRequest, deps: w.deps });
}

function reconcileCreate(w: World, enrollmentId: string) {
  return pipeline.reconcileTurnkeyEnrollment({ config, registry: w.registry, enrollments: w.enrollments, appUserId: APP_USER, enrollmentId, providerBudgetLimiter: unthrottledBudget(), deps: w.deps });
}

/** Legitimate setup up to (but not through) the Turnkey create. */
async function toRegistered(w: World, session: FixtureAuthenticator = w.primary) {
  const begun = await begin(w, (await stepUp(w, { session })).response, session);
  if (begun.outcome !== "started") throw new Error(JSON.stringify(begun));
  const backup = createFixtureAuthenticator();
  const registered = await register(w, backup, begun.optionsJSON.challenge, session);
  if (registered.outcome !== "registered") throw new Error(JSON.stringify(registered));
  return { enrollmentId: begun.enrollmentId, backup };
}

/** ...through the create: the new credential is PENDING in the app but a live, mapped authenticator at Turnkey. */
async function toCreated(w: World, session: FixtureAuthenticator = w.primary) {
  const { enrollmentId, backup } = await toRegistered(w, session);
  expect((await submitCreate(w, enrollmentId, await signedCreate(w, enrollmentId, session), session)).outcome).toBe("confirmed");
  const enrollment = (await w.enrollments.findById(enrollmentId))!;
  return { enrollmentId, backup, authenticatorId: enrollment.turnkeyAuthenticatorId! };
}

function prepareProofA(w: World, enrollmentId: string) {
  return pipeline.prepareBackupLoginVerification({ config, challengeStore: w.challengeStore, enrollments: w.enrollments, appUserId: APP_USER, enrollmentId });
}

async function answerProofA(w: World, enrollmentId: string, backup: FixtureAuthenticator, challenge: string, enrollments: BackupPasskeyEnrollmentStore = w.enrollments) {
  const pending = (await w.enrollments.findById(enrollmentId))!;
  const response = buildAuthenticationResponseJSON({ authenticator: backup, challenge, origin: ORIGIN, rpId: config.rpId, userHandle: pending.userHandle! });
  return pipeline.confirmBackupLoginVerification({ config, challengeStore: w.challengeStore, registry: w.registry, enrollments, appUserId: APP_USER, response });
}

async function toLoginVerified(w: World, session: FixtureAuthenticator = w.primary) {
  const created = await toCreated(w, session);
  const a = await prepareProofA(w, created.enrollmentId);
  if (a.outcome !== "ready") throw new Error(JSON.stringify(a));
  expect((await answerProofA(w, created.enrollmentId, created.backup, a.optionsJSON.challenge)).outcome).toBe("verified");
  return created;
}

/** Seeds a completed signRawPayload activity approved by the new authenticator's key (Proof B's evidence). */
async function seedProofB(w: World, enrollmentId: string) {
  const prepared = await pipeline.prepareSigningProof({ config, registry: w.registry, enrollments: w.enrollments, appUserId: APP_USER, enrollmentId });
  if (prepared.outcome !== "ready") throw new Error(JSON.stringify(prepared));
  const enrollment = (await w.enrollments.findById(enrollmentId))!;
  const signature = await OWNER.sign({ hash: prepared.digest as Hex });
  const id = `sign-${Math.random().toString(16).slice(2)}`;
  w.fake.addActivity({
    id,
    status: "ACTIVITY_STATUS_COMPLETED",
    organizationId: "sub-org-1",
    type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
    intent: { signRawPayloadIntentV2: { signWith: OWNER.address, payload: prepared.digest, encoding: "PAYLOAD_ENCODING_HEXADECIMAL", hashFunction: "HASH_FUNCTION_NO_OP" } },
    result: { signRawPayloadResult: { r: signature.slice(2, 66), s: signature.slice(66, 130), v: Number.parseInt(signature.slice(130), 16) === 27 ? "00" : "01" } },
    votes: [{ selection: "VOTE_SELECTION_APPROVED", activityId: id, userId: "turnkey-user-1", publicKey: enrollment.turnkeyAuthenticatorPublicKey }],
  });
  return id;
}

function confirmProofB(w: World, enrollmentId: string, activityId: string) {
  return pipeline.confirmSigningProof({ config, registry: w.registry, enrollments: w.enrollments, appUserId: APP_USER, enrollmentId, activityId, providerBudgetLimiter: unthrottledBudget() });
}

/** A full, legitimate enrollment to ACTIVE — gives the account a second active passkey. */
async function addActiveBackup(w: World, session: FixtureAuthenticator = w.primary) {
  const created = await toLoginVerified(w, session);
  expect((await confirmProofB(w, created.enrollmentId, await seedProofB(w, created.enrollmentId))).outcome).toBe("active");
  return created;
}

function prepareRemoval(w: World, target: FixtureAuthenticator, session: FixtureAuthenticator) {
  return revocation.prepareRevocation({ config, registry: w.registry, revocations: w.revocations, appUserId: APP_USER, credentialId: target.credentialIdBase64Url, sessionCredentialId: session.credentialIdBase64Url, now: () => w.clock.now });
}

async function signedRemoval(w: World, target: FixtureAuthenticator, session: FixtureAuthenticator) {
  const prepared = await prepareRemoval(w, target, session);
  if (prepared.outcome !== "ready") throw new Error(JSON.stringify(prepared));
  return { attemptId: prepared.attemptId, signed: signRequest({ authenticator: session, activity: prepared.activity, url: DELETE_URL, origin: ORIGIN, rpId: config.rpId }) };
}

function submitRemoval(w: World, target: FixtureAuthenticator, session: FixtureAuthenticator, attemptId: string, signedRequest: unknown) {
  return revocation.submitRevocation({ config, registry: w.registry, revocations: w.revocations, appUserId: APP_USER, credentialId: target.credentialIdBase64Url, attemptId, sessionCredentialId: session.credentialIdBase64Url, signedRequest, deps: w.deps });
}

function reconcileRemoval(w: World, target: FixtureAuthenticator, attemptId: string) {
  return revocation.reconcileRevocation({ config, registry: w.registry, revocations: w.revocations, appUserId: APP_USER, credentialId: target.credentialIdBase64Url, attemptId, providerBudgetLimiter: unthrottledBudget(), deps: w.deps });
}

/** Dispatches a removal whose delete activity FAILS (nothing deleted at Turnkey) → attempt 'blocked', target 'revoking'. */
async function blockedRemoval(w: World, target: FixtureAuthenticator, session: FixtureAuthenticator) {
  const { attemptId, signed } = await signedRemoval(w, target, session);
  w.fake.nextMode = "fail_activity";
  expect((await submitRemoval(w, target, session, attemptId, signed)).outcome).toBe("blocked");
  w.fake.nextMode = "ok";
  return { attemptId, signed };
}

const passkey = async (w: World, who: FixtureAuthenticator) => w.registry.findPasskeyByCredentialId(who.credentialIdBase64Url);
const openEnrollment = (w: World) => pipeline.getActiveBackupEnrollment({ enrollments: w.enrollments, appUserId: APP_USER });
const atTurnkey = (w: World, credential: FixtureAuthenticator) => w.fake.authenticators().some((a) => a.credentialId === Buffer.from(credential.credentialId).toString("base64"));
const creates = (w: World) => w.fake.forwarded.filter((f) => f.url === CREATE_URL);
const deletes = (w: World) => w.fake.forwarded.filter((f) => f.url === DELETE_URL);
async function walletAccess(w: World, who: FixtureAuthenticator) {
  return pipeline.passkeyWalletAccess((await passkey(w, who))!, await w.enrollments.findActiveByAppUserId(APP_USER));
}

afterEach(() => {
  turnkey.fake = null;
  vi.useRealTimers();
});

// ================================================================== H1 + Decision 5

describe("2g-H / H1 — a fresh step-up by the session credential gates every backup registration challenge", () => {
  it("a cookie alone gets nothing: no step-up (or a malformed one) mints no challenge and creates no enrollment", async () => {
    const w = await world();
    for (const bogus of [undefined, null, {}, "x", { id: "x", response: { clientDataJSON: "not-base64-json" } }]) {
      expect((await begin(w, bogus)).outcome).toBe("step_up_failed");
    }
    expect(await openEnrollment(w)).toBeNull();
  });

  it("with a fresh, user-verified assertion by the session credential, the registration challenge is issued", async () => {
    const w = await world();
    const up = await stepUp(w);
    expect(up.optionsJSON.allowCredentials?.map((c) => c.id)).toEqual([w.primary.credentialIdBase64Url]);
    expect(up.optionsJSON.userVerification).toBe("required");
    expect((await begin(w, up.response)).outcome).toBe("started");
  });

  it("an assertion by any other credential is rejected — another active passkey on the account, or an outsider's — and a step-up minted for A can't be spent by session B", async () => {
    const w = await world();
    const { backup } = await addActiveBackup(w);
    expect((await begin(w, (await stepUp(w, { answerer: backup })).response)).outcome).toBe("step_up_failed");
    expect((await begin(w, (await stepUp(w, { answerer: createFixtureAuthenticator(), userHandle: PRIMARY_HANDLE })).response)).outcome).toBe("step_up_failed");
    const capturedA = await stepUp(w); // a valid step-up POST body by A, captured before use
    expect((await begin(w, capturedA.response, backup)).outcome).toBe("step_up_failed");
  });

  it("the assertion must be user-verified and carry the credential's own user handle", async () => {
    const w = await world();
    expect((await begin(w, (await stepUp(w, { userVerified: false })).response)).outcome).toBe("step_up_failed");
    expect((await begin(w, (await stepUp(w, { userHandle: "someone-else" })).response)).outcome).toBe("step_up_failed");
  });

  it("a consumed step-up can't be replayed, and an expired one is refused", async () => {
    const w = await world();
    const up = await stepUp(w);
    expect((await begin(w, up.response)).outcome).toBe("started");
    expect((await begin(w, up.response)).outcome).toBe("step_up_failed");

    vi.useFakeTimers({ toFake: ["Date"] });
    const stale = await stepUp(w);
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    expect((await begin(w, stale.response)).outcome).toBe("step_up_failed");
  });

  it("re-minting a 'started' setup needs ANOTHER fresh step-up, and SUPERSEDES the earlier registration challenge", async () => {
    const w = await world();
    const first = await begin(w, (await stepUp(w)).response);
    const second = await begin(w, (await stepUp(w)).response);
    if (first.outcome !== "started" || second.outcome !== "started") throw new Error("setup");
    expect(first.enrollmentId).toBe(second.enrollmentId);
    // The OLD challenge (still unexpired, still unconsumed) can no longer attach anything...
    expect((await register(w, createFixtureAuthenticator(), first.optionsJSON.challenge)).outcome).toBe("rejected");
    expect((await w.enrollments.findById(first.enrollmentId))?.state).toBe("started");
    // ...only the newest mint does.
    expect((await register(w, createFixtureAuthenticator(), second.optionsJSON.challenge)).outcome).toBe("registered");
  });

  it("the store itself refuses a superseded mint atomically (re-mint racing a registration) — nothing attaches, no orphan pending passkey", async () => {
    const w = await world();
    const e = (await w.enrollments.createStarted({ appUserId: APP_USER }))!;
    await w.enrollments.transition({ id: e.id, from: "started", to: "started", patch: { registrationMintId: "mint-old" } });
    await w.enrollments.transition({ id: e.id, from: "started", to: "started", patch: { registrationMintId: "mint-new" } });
    const credential = (id: string, registrationMintId: string) => ({ credentialId: id, userHandle: "h", credentialPublicKey: "k", counter: 0, transports: null, credentialDeviceType: null, credentialBackedUp: null, registrationChallenge: "c", rawClientDataJson: "d", rawAttestationObject: "a", stepUpCredentialId: w.primary.credentialIdBase64Url, registrationMintId });
    expect(await w.enrollments.registerCredential({ id: e.id, credential: credential("cred-stale", "mint-old") })).toBeNull();
    expect(await w.registry.findPasskeyByCredentialId("cred-stale")).toBeNull();
    expect(await w.enrollments.registerCredential({ id: e.id, credential: credential("cred-fresh", "mint-new") })).toMatchObject({ newCredentialId: "cred-fresh", state: "credential_registered" });
  });

  it("a registration challenge minted without a step-up (e.g. before 2g-H) or for a different session credential is refused", async () => {
    const w = await world();
    const legacy = (await w.enrollments.createStarted({ appUserId: APP_USER }))!;
    await w.challengeStore.create({ challenge: "legacy-registration-challenge", purpose: "backup_registration", ttlMs: 60_000, context: { enrollmentId: legacy.id, appUserId: APP_USER, userHandle: "h" } });
    expect((await register(w, createFixtureAuthenticator(), "legacy-registration-challenge")).outcome).toBe("rejected");

    const w2 = await world();
    const { backup } = await addActiveBackup(w2);
    const begun = await begin(w2, (await stepUp(w2)).response);
    if (begun.outcome !== "started") throw new Error("setup");
    expect((await register(w2, createFixtureAuthenticator(), begun.optionsJSON.challenge, backup)).outcome).toBe("rejected");
    expect((await w2.enrollments.findById(begun.enrollmentId))?.state).toBe("started");
  });

  it("a step-up credential that stops being active before registration completes no longer authorizes it", async () => {
    const w = await world();
    const begun = await begin(w, (await stepUp(w)).response);
    if (begun.outcome !== "started") throw new Error("setup");
    await w.registry.transitionPasskeyStatus({ credentialId: w.primary.credentialIdBase64Url, from: "active", to: "revoking" });
    expect((await register(w, createFixtureAuthenticator(), begun.optionsJSON.challenge)).outcome).toBe("rejected");
    await expect(stepUp(w)).rejects.toThrow();
  });

  it("Decision 5: step-up by A, register X, then session B (another active passkey) can NOT authorize X's Turnkey create", async () => {
    const w = await world();
    const { backup: b } = await addActiveBackup(w); // B: a second active, mapped passkey
    const { enrollmentId, backup: x } = await toRegistered(w, w.primary); // step-upped by A (the primary)
    const forwardedBefore = w.fake.forwarded.length;

    expect(await prepareCreate(w, enrollmentId, b)).toMatchObject({ outcome: "rejected" });
    // Even a well-formed body that B stamps itself (built as A would get it) is refused before any forward.
    const asA = await prepareCreate(w, enrollmentId, w.primary);
    if (asA.outcome !== "ready") throw new Error("setup");
    const stampedByB = signRequest({ authenticator: b, activity: asA.activity, url: CREATE_URL, origin: ORIGIN, rpId: config.rpId });
    expect((await submitCreate(w, enrollmentId, stampedByB, b)).outcome).toBe("rejected");
    expect(w.fake.forwarded.length).toBe(forwardedBefore);
    expect(atTurnkey(w, x)).toBe(false);
    expect((await w.enrollments.findById(enrollmentId))?.state).toBe("credential_registered");
    // A itself still can.
    expect((await submitCreate(w, enrollmentId, await signedCreate(w, enrollmentId, w.primary))).outcome).toBe("confirmed");
  });

  it("an enrollment whose credential was attached WITHOUT a step-up (planted pre-2g-H) is never offered for Turnkey authorization — only cancellation", async () => {
    const w = await world();
    const { enrollmentId, backup: planted } = await toRegistered(w);
    const signed = await signedCreate(w, enrollmentId);
    for (const map of getInMemoryRegistryInternals(w.registry).backupEnrollmentMaps) {
      const e = map.get(enrollmentId);
      if (e) map.set(e.id, { ...e, registrationStepUpCredentialId: null });
    }
    expect((await prepareCreate(w, enrollmentId)).outcome).toBe("rejected");
    expect((await submitCreate(w, enrollmentId, signed)).outcome).toBe("rejected");
    expect(creates(w)).toHaveLength(0);
    expect(atTurnkey(w, planted)).toBe(false);
    expect(await openEnrollment(w)).toMatchObject({ state: "credential_registered", abandonable: true });
  });

  it("TWO ACTORS: an attacker holding the victim's cookie and controlling credential X can never get X to the point where one victim 'Resume' tap grants it Turnkey authority", async () => {
    const w = await world();
    const attackerX = createFixtureAuthenticator();

    // Cookie-only: the attacker can ASK for a step-up, but can't answer it; a step-up challenge isn't a registration challenge.
    expect((await begin(w, undefined)).outcome).toBe("step_up_failed");
    expect((await begin(w, (await stepUp(w, { answerer: attackerX, userHandle: PRIMARY_HANDLE })).response)).outcome).toBe("step_up_failed");
    expect((await register(w, attackerX, (await stepUp(w)).optionsJSON.challenge)).outcome).toBe("rejected");
    expect(await openEnrollment(w)).toBeNull(); // nothing for the victim to "resume"

    // The victim starts a real setup; the attacker still can't re-mint or register into it.
    const victimBegun = await begin(w, (await stepUp(w)).response);
    if (victimBegun.outcome !== "started") throw new Error("setup");
    expect((await begin(w, (await stepUp(w, { answerer: attackerX, userHandle: PRIMARY_HANDLE })).response)).outcome).toBe("step_up_failed");
    expect((await register(w, attackerX, "guessed-challenge")).outcome).toBe("rejected");

    // The victim's "Resume" authorizes the VICTIM's new credential, never X.
    const victimNew = createFixtureAuthenticator();
    expect((await register(w, victimNew, victimBegun.optionsJSON.challenge)).outcome).toBe("registered");
    expect((await submitCreate(w, victimBegun.enrollmentId, await signedCreate(w, victimBegun.enrollmentId))).outcome).toBe("confirmed");
    expect(atTurnkey(w, victimNew)).toBe(true);
    expect(atTurnkey(w, attackerX)).toBe(false);
    expect(await passkey(w, attackerX)).toBeNull();
  });
});

// ================================================================== H2 + Decision 1

describe("2g-H / H2 — a pending backup that is live at Turnkey is removable, and its slot frees only on PROVEN absence", () => {
  it("pending WITHOUT a confirmed Turnkey authenticator is not removable through the wallet-removal flow (it can still be cancelled)", async () => {
    const w = await world();
    const { enrollmentId, backup } = await toRegistered(w);
    expect(await prepareRemoval(w, backup, w.primary)).toMatchObject({ outcome: "rejected", code: "not_removable" });
    expect((await pipeline.abandonBackupEnrollment({ enrollments: w.enrollments, appUserId: APP_USER, enrollmentId })).outcome).toBe("abandoned");
  });

  it.each(["turnkey_authenticator_created", "login_verified"] as const)(
    "pending + confirmed Turnkey authenticator (%s): removable by another active passkey — exact delete, revoked, enrollment 'removed', slot freed, new backup to active",
    async (at) => {
      const w = await world();
      const { enrollmentId, backup, authenticatorId } = at === "turnkey_authenticator_created" ? await toCreated(w) : await toLoginVerified(w);
      const accountBefore = await w.registry.findAccountByAppUserId(APP_USER);
      expect(atTurnkey(w, backup)).toBe(true);
      expect(await walletAccess(w, backup)).toBe("granted");

      const { attemptId, signed } = await signedRemoval(w, backup, w.primary);
      expect(await passkey(w, backup)).toMatchObject({ status: "pending" }); // a cookie alone changes nothing
      expect((await submitRemoval(w, backup, w.primary, attemptId, signed)).outcome).toBe("revoked");

      expect(deletes(w)).toHaveLength(1);
      expect(deletes(w)[0]!.body).toBe(signed.body); // exact raw forwarding unchanged
      expect(JSON.parse(deletes(w)[0]!.body).parameters).toEqual({ userId: "turnkey-user-1", authenticatorIds: [authenticatorId] });
      expect(atTurnkey(w, backup)).toBe(false);
      expect(await passkey(w, backup)).toMatchObject({ status: "revoked", role: "backup" });
      expect((await w.enrollments.findById(enrollmentId))?.state).toBe("removed");
      expect(await openEnrollment(w)).toBeNull();
      expect(await w.registry.findAccountByAppUserId(APP_USER)).toEqual(accountBefore);

      const next = await addActiveBackup(w);
      expect(await passkey(w, next.backup)).toMatchObject({ status: "active", role: "backup" });
    },
  );

  it("1/6: a DISPATCHED (unconfirmed) removal makes activation impossible but does NOT free the slot — no replacement backup can start", async () => {
    const w = await world();
    const { enrollmentId, backup } = await toLoginVerified(w);
    const { attemptId, signed } = await signedRemoval(w, backup, w.primary);
    w.fake.nextMode = "pending_activity";
    expect((await submitRemoval(w, backup, w.primary, attemptId, signed)).outcome).toBe("pending");
    expect(await passkey(w, backup)).toMatchObject({ status: "revoking" });
    expect((await w.enrollments.findById(enrollmentId))?.state).toBe("removal_in_progress");
    expect(await openEnrollment(w)).toMatchObject({ state: "removal_in_progress", abandonable: false });
    expect(await slotIsFree(w)).toBe(false);
    expect((await prepareProofA(w, enrollmentId)).outcome).toBe("rejected");
    expect((await reconcileCreate(w, enrollmentId)).outcome).toBe("rejected");
  });

  it("2/7: the removal's CONFIRMATION (completed delete + absence read) frees the slot — then a new backup can be enrolled", async () => {
    const w = await world();
    const { enrollmentId, backup } = await toCreated(w);
    const { attemptId, signed } = await signedRemoval(w, backup, w.primary);
    w.fake.nextMode = "pending_activity";
    await submitRemoval(w, backup, w.primary, attemptId, signed);
    expect(await slotIsFree(w)).toBe(false);

    const activityId = (await w.revocations.findById(attemptId))!.turnkeyActivityId!;
    Object.assign(w.fake.activities.get(activityId)!, { status: "ACTIVITY_STATUS_COMPLETED", result: { deleteAuthenticatorsResult: { authenticatorIds: [(await passkey(w, backup))!.turnkeyAuthenticatorId] } } });
    w.fake.users.set("turnkey-user-1", w.fake.authenticators().filter((a) => a.credentialId !== Buffer.from(backup.credentialId).toString("base64")));
    w.fake.nextMode = "ok";
    expect((await reconcileRemoval(w, backup, attemptId)).outcome).toBe("revoked");
    expect((await w.enrollments.findById(enrollmentId))?.state).toBe("removed");
    expect(await slotIsFree(w)).toBe(true);
  });

  it("late Proof A — even one racing between Proof A's read and its state change — cannot reactivate a removed credential", async () => {
    const w = await world();
    const { enrollmentId, backup } = await toCreated(w);
    const proofA = await prepareProofA(w, enrollmentId);
    if (proofA.outcome !== "ready") throw new Error("setup");
    const { attemptId, signed } = await signedRemoval(w, backup, w.primary);
    const racing: BackupPasskeyEnrollmentStore = {
      ...w.enrollments,
      transition: async (args) => {
        expect((await submitRemoval(w, backup, w.primary, attemptId, signed)).outcome).toBe("revoked");
        return w.enrollments.transition(args);
      },
    };
    expect((await answerProofA(w, enrollmentId, backup, proofA.optionsJSON.challenge, racing)).outcome).toBe("rejected");
    expect((await w.enrollments.findById(enrollmentId))?.state).toBe("removed");
    expect((await passkey(w, backup))?.status).toBe("revoked");
  });

  it("late Proof B / activation (evidence gathered before the removal) cannot reactivate the removed credential", async () => {
    const w = await world();
    const { enrollmentId, backup } = await toLoginVerified(w);
    const signingActivity = await seedProofB(w, enrollmentId);
    const { attemptId, signed } = await signedRemoval(w, backup, w.primary);
    w.fake.nextMode = "pending_activity";
    await submitRemoval(w, backup, w.primary, attemptId, signed); // dispatched, NOT confirmed
    expect((await confirmProofB(w, enrollmentId, signingActivity)).outcome).toBe("rejected");
    // The REAL stored nonce (prepared by seedProofB): the null must come from the removal's state, not from a missing nonce.
    const storedNonce = (await w.enrollments.findById(enrollmentId))!.signingProofChallenge!;
    expect(storedNonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await w.enrollments.activate({ id: enrollmentId, signingProofActivityId: signingActivity, signingProofChallenge: storedNonce })).toBeNull();
    expect((await w.enrollments.findById(enrollmentId))?.state).toBe("removal_in_progress");
    expect((await passkey(w, backup))?.status).toBe("revoking");
  });

  it("15: activation vs removal — whichever commits first wins, always consistent, and the slot is never freed by dispatch", async () => {
    const w1 = await world();
    const first = await toLoginVerified(w1);
    const prepared = await signedRemoval(w1, first.backup, w1.primary); // prepared while still pending
    expect((await confirmProofB(w1, first.enrollmentId, await seedProofB(w1, first.enrollmentId))).outcome).toBe("active");
    expect((await submitRemoval(w1, first.backup, w1.primary, prepared.attemptId, prepared.signed)).outcome).toBe("revoked");
    expect((await w1.enrollments.findById(first.enrollmentId))?.state).toBe("active");

    const w2 = await world();
    const second = await toLoginVerified(w2);
    const signing = await seedProofB(w2, second.enrollmentId);
    const removal = await signedRemoval(w2, second.backup, w2.primary);
    w2.fake.nextMode = "pending_activity";
    await Promise.all([confirmProofB(w2, second.enrollmentId, signing), submitRemoval(w2, second.backup, w2.primary, removal.attemptId, removal.signed)]);
    expect((await w2.revocations.findById(removal.attemptId))?.state).toBe("dispatch_in_flight");
    expect((await passkey(w2, second.backup))?.status).toBe("revoking");
    expect(["active", "removal_in_progress"]).toContain((await w2.enrollments.findById(second.enrollmentId))?.state);
  });

  it("the survivor must still be an eligible active passkey inside the dispatch step — otherwise nothing changes", async () => {
    const w = await world();
    const { enrollmentId, backup } = await toCreated(w);
    const { attemptId, signed } = await signedRemoval(w, backup, w.primary);
    await w.registry.transitionPasskeyStatus({ credentialId: w.primary.credentialIdBase64Url, from: "active", to: "revoking" });
    expect((await submitRemoval(w, backup, w.primary, attemptId, signed)).outcome).toBe("rejected");
    expect((await passkey(w, backup))?.status).toBe("pending");
    expect((await w.enrollments.findById(enrollmentId))?.state).toBe("turnkey_authenticator_created");
    expect(deletes(w)).toHaveLength(0);
  });

  it("a duplicate/replayed removal submit forwards at most one delete", async () => {
    const w = await world();
    const { backup } = await toCreated(w);
    const { attemptId, signed } = await signedRemoval(w, backup, w.primary);
    const results = await Promise.all([submitRemoval(w, backup, w.primary, attemptId, signed), submitRemoval(w, backup, w.primary, attemptId, signed)]);
    expect(results.filter((r) => r.outcome === "revoked")).toHaveLength(1);
    expect((await submitRemoval(w, backup, w.primary, attemptId, signed)).outcome).toBe("rejected");
    expect(deletes(w)).toHaveLength(1);
  });

  it("16: last-credential safety — a pending credential can never authorize a removal; the authorizer must be active", async () => {
    const w = await world();
    const { backup } = await toCreated(w);
    expect((await w.revocations.prepare({ appUserId: APP_USER, targetCredentialId: w.primary.credentialIdBase64Url, authorizerCredentialId: backup.credentialIdBase64Url })).ok).toBe(false);
    expect(await prepareRemoval(w, w.primary, backup)).toMatchObject({ outcome: "rejected" });
    expect((await passkey(w, w.primary))?.status).toBe("active");
  });

  it("racing a pending removal against an active removal never leaves zero active passkeys", async () => {
    const w = await world();
    const b = await addActiveBackup(w);
    const x = await toCreated(w);
    const xByP = await signedRemoval(w, x.backup, w.primary);
    const pByB = await signedRemoval(w, w.primary, b.backup);
    await Promise.all([submitRemoval(w, x.backup, w.primary, xByP.attemptId, xByP.signed), submitRemoval(w, w.primary, b.backup, pByB.attemptId, pByB.signed)]);
    expect((await w.registry.findPasskeysByAppUserId(APP_USER)).filter((p) => p.status === "active").length).toBeGreaterThanOrEqual(1);
    expect((await passkey(w, b.backup))?.status).toBe("active");
  });

  it("17: an ordinary ACTIVE-passkey removal is unchanged (no enrollment is touched)", async () => {
    const w = await world();
    const b = await addActiveBackup(w);
    const { attemptId, signed } = await signedRemoval(w, b.backup, w.primary);
    expect((await submitRemoval(w, b.backup, w.primary, attemptId, signed)).outcome).toBe("revoked");
    expect((await w.enrollments.findById(b.enrollmentId))?.state).toBe("active");
    expect(await slotIsFree(w)).toBe(true);
  });
});

// ================================================================== Decision 2

describe("2g-H — a BLOCKED removal can be retried (fresh survivor approval, never automatic, never back to active)", () => {
  it("3/4/5: pending-origin — a blocked delete keeps the slot; a retry with a fresh stamp is confirmed absent → revoked, enrollment 'removed', slot freed", async () => {
    const w = await world();
    const { enrollmentId, backup, authenticatorId } = await toCreated(w);
    const first = await blockedRemoval(w, backup, w.primary);
    expect(atTurnkey(w, backup)).toBe(true); // the FAILED delete removed nothing
    expect(await passkey(w, backup)).toMatchObject({ status: "revoking" });
    expect((await w.enrollments.findById(enrollmentId))?.state).toBe("removal_in_progress");
    expect(await slotIsFree(w)).toBe(false); // 3: blocked keeps the slot occupied

    // Never automatic: reconciling the blocked attempt sends nothing new.
    const before = deletes(w).length;
    expect((await reconcileRemoval(w, backup, first.attemptId)).outcome).toBe("blocked");
    expect(deletes(w).length).toBe(before);

    // The old stamp can't be reused for the retry once stale; a fresh one is required.
    w.clock.now += TURNKEY_STAMP_FRESHNESS_WINDOW_MS + 1;
    const retry = await prepareRemoval(w, backup, w.primary);
    if (retry.outcome !== "ready") throw new Error(JSON.stringify(retry));
    expect(retry.attemptId).not.toBe(first.attemptId);
    expect(retry.activity.parameters.authenticatorIds).toEqual([authenticatorId]);
    expect((await submitRemoval(w, backup, w.primary, retry.attemptId, first.signed)).outcome).toBe("rejected");
    const fresh = signRequest({ authenticator: w.primary, activity: retry.activity, url: DELETE_URL, origin: ORIGIN, rpId: config.rpId });
    expect((await submitRemoval(w, backup, w.primary, retry.attemptId, fresh)).outcome).toBe("revoked");

    expect(atTurnkey(w, backup)).toBe(false);
    expect(await passkey(w, backup)).toMatchObject({ status: "revoked" });
    expect((await w.enrollments.findById(enrollmentId))?.state).toBe("removed");
    expect(await w.revocations.findById(first.attemptId)).toMatchObject({ state: "blocked" }); // history kept
    expect(await slotIsFree(w)).toBe(true); // 5
  });

  it("FIX 3: a retry must carry FRESH signed bytes — the previous attempt's exact body/stamp is refused even inside the freshness window, and never forwarded", async () => {
    const w = await world();
    const b = await addActiveBackup(w);
    const first = await blockedRemoval(w, b.backup, w.primary);
    const retry = await prepareRemoval(w, b.backup, w.primary);
    if (retry.outcome !== "ready") throw new Error(JSON.stringify(retry));
    const deletesBefore = deletes(w).length;
    // Still well inside the local freshness window, the old bytes are refused for the new attempt.
    expect((await submitRemoval(w, b.backup, w.primary, retry.attemptId, first.signed)).outcome).toBe("rejected");
    expect(deletes(w).length).toBe(deletesBefore);
    expect(await w.revocations.findById(retry.attemptId)).toMatchObject({ state: "authorization_needed" });
    expect(await passkey(w, b.backup)).toMatchObject({ status: "revoking" });
    // A genuinely fresh approval over a fresh body (new timestamp) is accepted.
    w.clock.now += 1_000;
    const fresh = await prepareRemoval(w, b.backup, w.primary);
    if (fresh.outcome !== "ready") throw new Error("setup");
    expect(fresh.attemptId).toBe(retry.attemptId); // the session's own undispatched retry is re-offered, never duplicated
    const freshSigned = signRequest({ authenticator: w.primary, activity: fresh.activity, url: DELETE_URL, origin: ORIGIN, rpId: config.rpId });
    expect(freshSigned.body).not.toBe(first.signed.body);
    expect((await submitRemoval(w, b.backup, w.primary, retry.attemptId, freshSigned)).outcome).toBe("revoked");
    expect(deletes(w).length).toBe(deletesBefore + 1);
    expect(await w.revocations.findById(first.attemptId)).toMatchObject({ state: "blocked" }); // history kept
  });

  it("formerly-ACTIVE target — blocked delete → retry → confirmed absent → revoked", async () => {
    const w = await world();
    const b = await addActiveBackup(w);
    await blockedRemoval(w, b.backup, w.primary);
    expect(await passkey(w, b.backup)).toMatchObject({ status: "revoking" });
    w.clock.now += 1_000; // the retry is a NEW request (fresh timestamp → different bytes), never the old one
    const { attemptId, signed } = await signedRemoval(w, b.backup, w.primary);
    expect((await submitRemoval(w, b.backup, w.primary, attemptId, signed)).outcome).toBe("revoked");
    expect(await passkey(w, b.backup)).toMatchObject({ status: "revoked" });
    expect(atTurnkey(w, b.backup)).toBe(false);
  });

  it("a retry is refused while a removal is still in flight, and the survivor must still be active; a cancelled retry leaves the target 'revoking' (never 'active')", async () => {
    const w = await world();
    const b = await addActiveBackup(w);
    const { attemptId, signed } = await signedRemoval(w, b.backup, w.primary);
    w.fake.nextMode = "pending_activity";
    await submitRemoval(w, b.backup, w.primary, attemptId, signed);
    expect(await prepareRemoval(w, b.backup, w.primary)).toMatchObject({ outcome: "rejected", code: "removal_in_progress" });

    const w2 = await world();
    const c = await addActiveBackup(w2);
    await blockedRemoval(w2, c.backup, w2.primary);
    const retry = await prepareRemoval(w2, c.backup, w2.primary);
    if (retry.outcome !== "ready") throw new Error("setup");
    expect((await revocation.cancelRevocation({ revocations: w2.revocations, appUserId: APP_USER, credentialId: c.backup.credentialIdBase64Url, attemptId: retry.attemptId, sessionCredentialId: w2.primary.credentialIdBase64Url })).outcome).toBe("cancelled");
    expect(await passkey(w2, c.backup)).toMatchObject({ status: "revoking" });
    await w2.registry.transitionPasskeyStatus({ credentialId: w2.primary.credentialIdBase64Url, from: "active", to: "pending" });
    expect(await prepareRemoval(w2, c.backup, w2.primary)).toMatchObject({ outcome: "rejected" });
  });
});

// ================================================================== Decisions 3 + 4

describe("2g-H — an uncertain CREATE is never harmless, never frees the slot, and never leads to a second create on a bare miss", () => {
  it("8: lost CREATE response, no activity id, window closed, getUsers miss → still in flight, slot held, not abandonable, 'uncertain'", async () => {
    const w = await world();
    const { enrollmentId, backup } = await toRegistered(w);
    w.fake.nextMode = "lose_response_before_apply";
    await submitCreate(w, enrollmentId, await signedCreate(w, enrollmentId));
    w.clock.now += TURNKEY_STAMP_FRESHNESS_WINDOW_MS + 1;
    expect((await reconcileCreate(w, enrollmentId)).outcome).toBe("pending");
    expect(await openEnrollment(w)).toMatchObject({ state: "turnkey_enrollment_in_flight", abandonable: false });
    expect(await walletAccess(w, backup)).toBe("uncertain");
    expect(await slotIsFree(w)).toBe(false);
    expect((await pipeline.abandonBackupEnrollment({ enrollments: w.enrollments, appUserId: APP_USER, enrollmentId })).outcome).toBe("rejected");
  });

  it("9: ambiguous CREATE discovery → 'blocked' review that HOLDS the slot and stays 'uncertain' (never harmless)", async () => {
    const w = await world();
    const { enrollmentId, backup } = await toRegistered(w);
    w.fake.nextMode = "lose_response_before_apply";
    await submitCreate(w, enrollmentId, await signedCreate(w, enrollmentId));
    w.fake.addAuthenticator(backup.credentialIdBase64Url, "dup-1");
    w.fake.addAuthenticator(backup.credentialIdBase64Url, "dup-2");
    w.clock.now += TURNKEY_STAMP_FRESHNESS_WINDOW_MS + 1;
    expect((await reconcileCreate(w, enrollmentId)).outcome).toBe("blocked");
    expect(await openEnrollment(w)).toMatchObject({ state: "blocked", abandonable: false });
    expect(await walletAccess(w, backup)).toBe("uncertain");
    expect(await slotIsFree(w)).toBe(false);
  });

  it("11/12: original lands but its response is lost, the replay comes back FAILED, and getUsers is stale → review (NOT definitive failure, no second create); a later exact match recovers the id and enables removal", async () => {
    const w = await world();
    const { enrollmentId, backup } = await toRegistered(w);
    w.fake.dedupeByBody = false;
    w.fake.lagReads = true; // the created authenticator is invisible to getUsers for now
    w.fake.modeQueue = ["lose_response_after_apply", "fail_activity"]; // original applies; the byte-identical replay FAILS
    expect((await submitCreate(w, enrollmentId, await signedCreate(w, enrollmentId))).outcome).toBe("blocked");
    expect(creates(w)).toHaveLength(2); // the original + ONE replay, both byte-identical
    expect(creates(w)[1]!.body).toBe(creates(w)[0]!.body);
    expect(await w.enrollments.findById(enrollmentId)).toMatchObject({ state: "blocked", externalOutcome: "unknown", turnkeyRequestReplayed: true });

    // No path to a fresh create: not re-authorizable, not abandonable; re-checks never forward anything.
    expect((await prepareCreate(w, enrollmentId)).outcome).toBe("rejected");
    expect((await pipeline.abandonBackupEnrollment({ enrollments: w.enrollments, appUserId: APP_USER, enrollmentId })).outcome).toBe("rejected");
    expect((await reconcileCreate(w, enrollmentId)).outcome).toBe("blocked");
    expect(creates(w)).toHaveLength(2);
    expect(await walletAccess(w, backup)).toBe("uncertain");
    expect(await slotIsFree(w)).toBe(false);

    // 12: the authenticator becomes visible → exact single match → mapped → removable.
    w.fake.propagate();
    expect((await reconcileCreate(w, enrollmentId)).outcome).toBe("confirmed");
    const recovered = (await w.enrollments.findById(enrollmentId))!;
    expect(recovered.state).toBe("turnkey_authenticator_created");
    expect(recovered.blockReason).toBeNull(); // FIX 5: the stale review reason is cleared on recovery
    expect(await passkey(w, backup)).toMatchObject({ status: "pending", turnkeyAuthenticatorId: recovered.turnkeyAuthenticatorId });
    expect(await walletAccess(w, backup)).toBe("granted");
    const { attemptId, signed } = await signedRemoval(w, backup, w.primary);
    expect((await submitRemoval(w, backup, w.primary, attemptId, signed)).outcome).toBe("revoked");
    expect(await slotIsFree(w)).toBe(true);
    expect(creates(w)).toHaveLength(2);
  });

  it("FIX 1 (exact adversarial): original CREATE FAILED + getUsers miss, but the browser's captured body/stamp is still usable → review, slot held, no abandon, no new CREATE; a later direct replay is recovered by exact match and made removable", async () => {
    const w = await world();
    w.fake.dedupeByBody = false; // never encode Turnkey same-body dedupe as an assumption
    const { enrollmentId, backup } = await toRegistered(w);
    const captured = await signedCreate(w, enrollmentId); // what the browser stamped — it keeps a copy
    w.fake.nextMode = "fail_activity";
    // 1-2. Turnkey reports the only request we sent as FAILED, and getUsers shows no match.
    expect((await submitCreate(w, enrollmentId, captured)).outcome).toBe("blocked");
    expect(atTurnkey(w, backup)).toBe(false);
    expect(creates(w)).toHaveLength(1);
    // 4. Review: slot held, authority treated as uncertain.
    expect(await w.enrollments.findById(enrollmentId)).toMatchObject({ state: "blocked", externalOutcome: "unknown" });
    expect(await walletAccess(w, backup)).toBe("uncertain");
    expect(await slotIsFree(w)).toBe(false);
    // 5. No abandon. 6. No new CREATE (can't be prepared, and resubmitting — even the same captured bytes — is refused and never forwarded by us).
    expect((await pipeline.abandonBackupEnrollment({ enrollments: w.enrollments, appUserId: APP_USER, enrollmentId })).outcome).toBe("rejected");
    expect((await prepareCreate(w, enrollmentId)).outcome).toBe("rejected");
    expect((await submitCreate(w, enrollmentId, captured)).outcome).toBe("rejected");
    expect(creates(w)).toHaveLength(1);

    // 3. The browser posts its captured bytes to Turnkey DIRECTLY (bypassing us) — nothing we hold prevented that.
    w.fake.nextMode = "ok";
    await w.fake.fetchImpl(CREATE_URL, { method: "POST", body: captured.body, headers: { [captured.stamp.stampHeaderName]: captured.stamp.stampHeaderValue } } as unknown as RequestInit);
    expect(atTurnkey(w, backup)).toBe(true);
    expect(await slotIsFree(w)).toBe(false); // still accounted for

    // 7. Read-only re-check finds exactly one match → id persisted, removable; its removal frees the slot.
    expect((await reconcileCreate(w, enrollmentId)).outcome).toBe("confirmed");
    const recovered = (await w.enrollments.findById(enrollmentId))!;
    expect(recovered).toMatchObject({ state: "turnkey_authenticator_created", blockReason: null });
    expect(await walletAccess(w, backup)).toBe("granted");
    const { attemptId, signed } = await signedRemoval(w, backup, w.primary);
    expect((await submitRemoval(w, backup, w.primary, attemptId, signed)).outcome).toBe("revoked");
    expect(atTurnkey(w, backup)).toBe(false);
    expect(await slotIsFree(w)).toBe(true);
  });

  it("a legacy 'definitive_failure' row (pre-fix) is uncertain authority: not abandonable, not re-authorizable, and a re-check moves it into review", async () => {
    const w = await world();
    const { enrollmentId, backup } = await toRegistered(w);
    await w.enrollments.transition({ id: enrollmentId, from: "credential_registered", to: "credential_registered", patch: { externalOutcome: "definitive_failure" } });
    expect(await walletAccess(w, backup)).toBe("uncertain");
    expect(await openEnrollment(w)).toMatchObject({ abandonable: false });
    expect((await pipeline.abandonBackupEnrollment({ enrollments: w.enrollments, appUserId: APP_USER, enrollmentId })).outcome).toBe("rejected");
    expect((await prepareCreate(w, enrollmentId)).outcome).toBe("rejected");
    expect((await reconcileCreate(w, enrollmentId)).outcome).toBe("blocked");
    expect((await w.enrollments.findById(enrollmentId))?.state).toBe("blocked");
    expect(creates(w)).toHaveLength(0);
    expect(await slotIsFree(w)).toBe(false);
  });

  it("FIX 4: two concurrent reconciles of an unanswered create forward AT MOST ONE replay", async () => {
    const w = await world();
    const { enrollmentId } = await toRegistered(w);
    const signed = await signedCreate(w, enrollmentId);
    // The state submit leaves after a lost first response: exact request recorded, no activity id, replay not yet claimed.
    await w.enrollments.transition({
      id: enrollmentId,
      from: "credential_registered",
      to: "turnkey_enrollment_in_flight",
      patch: { externalOutcome: "unknown", turnkeyRequestEndpoint: "create_authenticators", turnkeyRequestBody: signed.body, turnkeyRequestBodySha256: "h", turnkeyRequestTimestampMs: Number(JSON.parse(signed.body).timestampMs), turnkeyRequestStamp: JSON.stringify(signed.stamp) },
    });
    w.fake.nextMode = "pending_activity";
    await Promise.all([reconcileCreate(w, enrollmentId), reconcileCreate(w, enrollmentId), reconcileCreate(w, enrollmentId)]);
    expect(creates(w)).toHaveLength(1);
    expect(await w.enrollments.findById(enrollmentId)).toMatchObject({ turnkeyRequestReplayed: true, turnkeyRequestStamp: null });
    await reconcileCreate(w, enrollmentId);
    expect(creates(w)).toHaveLength(1); // never a second replay
  });

  it("FIX 4: create-activity recording is first-writer-wins — a second caller can't replace the recorded activity id", async () => {
    const w = await world();
    const { enrollmentId } = await toRegistered(w);
    w.fake.nextMode = "pending_activity";
    await submitCreate(w, enrollmentId, await signedCreate(w, enrollmentId));
    const first = (await w.enrollments.findById(enrollmentId))!.turnkeyActivityId!;
    expect(await w.enrollments.recordActivity({ id: enrollmentId, activityId: "activity-from-another-send", activityStatus: "ACTIVITY_STATUS_COMPLETED" })).toBeNull();
    expect((await w.enrollments.findById(enrollmentId))?.turnkeyActivityId).toBe(first);
    expect(await w.enrollments.claimReplay({ id: enrollmentId })).toBeNull(); // an activity is known: nothing to replay
  });

  it("walletAccess is never optimistic: pending passkeys map to none / uncertain / granted exactly by provable state", async () => {
    const w = await world();
    const { enrollmentId, backup } = await toRegistered(w);
    expect(await walletAccess(w, backup)).toBe("none"); // nothing dispatched
    w.fake.nextMode = "pending_activity";
    await submitCreate(w, enrollmentId, await signedCreate(w, enrollmentId));
    expect(await walletAccess(w, backup)).toBe("uncertain"); // in flight
    // A pending row that can't be tied to its open enrollment is "uncertain", never "none".
    expect(pipeline.passkeyWalletAccess({ credentialId: "orphan", status: "pending", turnkeyAuthenticatorId: null }, null)).toBe("uncertain");
    expect(pipeline.passkeyWalletAccess({ credentialId: "x", status: "active", turnkeyAuthenticatorId: null }, null)).toBe("granted");
  });
});

// ================================================================== FIX 2 (static; the live proof is in neon-smoke)

describe("2g-H — the one-open index migration is fail-safe (schema.sql structure)", () => {
  it("is ONE DO block that locks, pre-checks conflicts (RAISE), creates the new index, and only then drops the old one; nothing outside it touches either index", async () => {
    const { readFileSync } = await import("node:fs");
    const schema = readFileSync("lib/real/server/schema.sql", "utf8");
    const begin = schema.indexOf("-- BEGIN 2g-H one-open-index migration");
    const end = schema.indexOf("-- END 2g-H one-open-index migration");
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    const block = schema.slice(begin, end);
    expect(block.match(/DO \$\$/g)).toHaveLength(1);
    const order = ["LOCK TABLE backup_passkey_enrollments", "GROUP BY app_user_id HAVING count(*) > 1", "RAISE EXCEPTION", "CREATE UNIQUE INDEX backup_passkey_enrollments_one_open_per_account", "DROP INDEX IF EXISTS backup_passkey_enrollments_one_active_per_account"].map((needle) => block.indexOf(needle));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const statementsOutside = (schema.slice(0, begin) + schema.slice(end))
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(statementsOutside).not.toMatch(/backup_passkey_enrollments_one_(open|active)_per_account/);
  });
});


// ================================================================== 3A-3 Stage 1: Turnkey reconcile budgets

describe("3A-3 — authenticated Turnkey reconcile budgets", () => {
  const ALLOW = { allowed: true } as const;
  const deny = (retryAfterSeconds: number) => ({ allowed: false, retryAfterSeconds }) as const;
  const BOOM = new Error("limiter must not be consulted");

  /** Records every Turnkey READ and every limiter charge, in order, into one event list. */
  function instrument(w: World) {
    const events: string[] = [];
    const getUsers = w.fake.getUsers;
    const getActivity = w.fake.getActivity;
    w.fake.getUsers = (async (input: { organizationId: string }) => {
      events.push("getUsers");
      return getUsers(input);
    }) as typeof w.fake.getUsers;
    w.fake.getActivity = (async (input: { organizationId: string; activityId: string }) => {
      events.push("getActivity");
      return getActivity(input);
    }) as typeof w.fake.getActivity;
    const budget = (...steps: unknown[]) => {
      const scripted = scriptedBudget(...steps);
      return {
        calls: scripted.calls,
        limiter: {
          async consume(input: Parameters<typeof scripted.limiter.consume>[0]) {
            events.push("charge");
            return scripted.limiter.consume(input);
          },
        },
      };
    };
    const reads = () => events.filter((e) => e !== "charge").length;
    return { events, budget, reads };
  }

  const reconcileCreateWith = (w: World, enrollmentId: string, providerBudgetLimiter: Parameters<typeof pipeline.reconcileTurnkeyEnrollment>[0]["providerBudgetLimiter"], appUserId = APP_USER) =>
    pipeline.reconcileTurnkeyEnrollment({ config, registry: w.registry, enrollments: w.enrollments, appUserId, enrollmentId, providerBudgetLimiter, deps: w.deps });
  const confirmWith = (w: World, enrollmentId: string, activityId: string, providerBudgetLimiter: Parameters<typeof pipeline.confirmSigningProof>[0]["providerBudgetLimiter"], registry = w.registry) =>
    pipeline.confirmSigningProof({ config, registry, enrollments: w.enrollments, appUserId: APP_USER, enrollmentId, activityId, providerBudgetLimiter });
  const reconcileRemovalWith = (w: World, target: FixtureAuthenticator, attemptId: string, providerBudgetLimiter: Parameters<typeof revocation.reconcileRevocation>[0]["providerBudgetLimiter"]) =>
    revocation.reconcileRevocation({ config, registry: w.registry, revocations: w.revocations, appUserId: APP_USER, credentialId: target.credentialIdBase64Url, attemptId, providerBudgetLimiter, deps: w.deps });

  /** The state submit leaves after a lost first response: exact request recorded, no activity id, replay not yet claimed. */
  async function toUnansweredCreate(w: World) {
    const { enrollmentId, backup } = await toRegistered(w);
    const signed = await signedCreate(w, enrollmentId);
    await w.enrollments.transition({
      id: enrollmentId,
      from: "credential_registered",
      to: "turnkey_enrollment_in_flight",
      patch: { externalOutcome: "unknown", turnkeyRequestEndpoint: "create_authenticators", turnkeyRequestBody: signed.body, turnkeyRequestBodySha256: "h", turnkeyRequestTimestampMs: Number(JSON.parse(signed.body).timestampMs), turnkeyRequestStamp: JSON.stringify(signed.stamp) },
    });
    return { enrollmentId, backup };
  }

  /** A create Turnkey accepted but has not completed: in flight WITH an activity id. */
  async function toPendingCreate(w: World) {
    const { enrollmentId, backup } = await toRegistered(w);
    w.fake.nextMode = "pending_activity";
    expect((await submitCreate(w, enrollmentId, await signedCreate(w, enrollmentId))).outcome).toBe("pending");
    w.fake.nextMode = "ok";
    expect((await w.enrollments.findById(enrollmentId))?.turnkeyActivityId).toBeTruthy();
    return { enrollmentId, backup };
  }

  describe("backup reconcile", () => {
    it("database-only exits cost nothing and never consult the limiter", async () => {
      const never = scriptedBudget(BOOM).limiter;
      const readsOf: Array<() => number> = [];
      const fresh = async () => {
        const w = await world();
        return { w };
      };

      // unknown, malformed and foreign enrollment ids; and a create nothing was dispatched for
      const { w } = await fresh();
      const { enrollmentId } = await toRegistered(w);
      const first = instrument(w);
      readsOf.push(first.reads);
      expect(await reconcileCreateWith(w, "11111111-1111-4111-8111-111111111111", never)).toMatchObject({ outcome: "rejected" });
      expect(await reconcileCreateWith(w, "not-a-uuid", never)).toMatchObject({ outcome: "rejected" });
      expect(await reconcileCreateWith(w, enrollmentId, never, "someone-else")).toMatchObject({ outcome: "rejected" });
      expect(await reconcileCreateWith(w, enrollmentId, never)).toMatchObject({ outcome: "rejected" });

      // confirmed
      const { w: w2 } = await fresh();
      const created = await toCreated(w2);
      const second = instrument(w2);
      readsOf.push(second.reads);
      expect(await reconcileCreateWith(w2, created.enrollmentId, never)).toEqual({ outcome: "confirmed" });

      // removed: a pending backup whose removal completed
      const { w: w3 } = await fresh();
      const pendingBackup = await toCreated(w3);
      const removal = await signedRemoval(w3, pendingBackup.backup, w3.primary);
      expect((await submitRemoval(w3, pendingBackup.backup, w3.primary, removal.attemptId, removal.signed)).outcome).toBe("revoked");
      expect((await w3.enrollments.findById(pendingBackup.enrollmentId))?.state).toBe("removed");
      const third = instrument(w3);
      readsOf.push(third.reads);
      expect(await reconcileCreateWith(w3, pendingBackup.enrollmentId, never)).toMatchObject({ outcome: "rejected" });

      // missing account
      const { w: w4 } = await fresh();
      const inFlight = await toPendingCreate(w4);
      const fourth = instrument(w4);
      readsOf.push(fourth.reads);
      expect(await reconcileCreateWith({ ...w4, registry: createInMemoryRealAccountRegistry() }, inFlight.enrollmentId, never)).toMatchObject({ outcome: "rejected" });

      expect(readsOf.map((reads) => reads())).toEqual([0, 0, 0, 0]);
    });

    it("an in-flight create with an activity id costs exactly ONE unit, charged BEFORE the first Turnkey read", async () => {
      const w = await world();
      const { enrollmentId } = await toPendingCreate(w);
      const { events, budget } = instrument(w);
      const { limiter, calls } = budget(ALLOW);
      expect((await reconcileCreateWith(w, enrollmentId, limiter)).outcome).toBe("pending");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({ subject: APP_USER, policies: TURNKEY_RECONCILE_POLICIES });
      expect(events[0]).toBe("charge");
      expect(events.filter((e) => e === "charge")).toHaveLength(1);
      expect(events).toContain("getActivity");
    });

    it("a blocked review costs ONE unit before its read; a denial reads nothing and reports the stored reason, flagged as deferred", async () => {
      const w = await world();
      const { enrollmentId } = await toRegistered(w);
      const signed = await signedCreate(w, enrollmentId);
      w.fake.nextMode = "fail_activity";
      expect((await submitCreate(w, enrollmentId, signed)).outcome).toBe("blocked");
      w.fake.nextMode = "ok";
      const stored = (await w.enrollments.findById(enrollmentId))!;
      expect(stored.state).toBe("blocked");

      const { events, budget, reads } = instrument(w);
      const denied = budget(deny(37));
      expect(await reconcileCreateWith(w, enrollmentId, denied.limiter)).toEqual({ outcome: "blocked", reason: stored.blockReason, reconciliationDeferred: true, retryAfterSeconds: 37 });
      expect(denied.calls).toHaveLength(1);
      expect(reads()).toBe(0);
      expect(await w.enrollments.findById(enrollmentId)).toEqual(stored);

      const allowed = budget(ALLOW);
      const result = await reconcileCreateWith(w, enrollmentId, allowed.limiter);
      expect(result.outcome).toBe("blocked");
      expect(result).not.toHaveProperty("reconciliationDeferred");
      expect(allowed.calls).toHaveLength(1);
      expect(events.slice(-2)).toEqual(["charge", "getUsers"]);
    });

    it("a legacy 'definitive_failure' moves into review for free (database only); the read that follows is the one charged unit", async () => {
      const w = await world();
      const { enrollmentId } = await toRegistered(w);
      await w.enrollments.transition({ id: enrollmentId, from: "credential_registered", to: "credential_registered", patch: { externalOutcome: "definitive_failure" } });
      const { events, budget } = instrument(w);
      const { limiter, calls } = budget(ALLOW);
      expect((await reconcileCreateWith(w, enrollmentId, limiter)).outcome).toBe("blocked");
      expect((await w.enrollments.findById(enrollmentId))?.state).toBe("blocked");
      expect(calls).toHaveLength(1);
      expect(events).toEqual(["charge", "getUsers"]);

      // Denied: the transition (database only) still happens, nothing is read.
      const w2 = await world();
      const r2 = await toRegistered(w2);
      await w2.enrollments.transition({ id: r2.enrollmentId, from: "credential_registered", to: "credential_registered", patch: { externalOutcome: "definitive_failure" } });
      const second = instrument(w2);
      expect(await reconcileCreateWith(w2, r2.enrollmentId, second.budget(deny(5)).limiter)).toMatchObject({ outcome: "blocked", reconciliationDeferred: true, retryAfterSeconds: 5 });
      expect((await w2.enrollments.findById(r2.enrollmentId))?.state).toBe("blocked");
      expect(second.reads()).toBe(0);
    });

    it("the charge comes BEFORE the replay claim: a denial claims nothing and forwards nothing, and a later allowed reconcile still gets the one replay", async () => {
      const w = await world();
      const { enrollmentId } = await toUnansweredCreate(w);
      w.fake.nextMode = "pending_activity";
      const { events, budget, reads } = instrument(w);

      const denied = budget(deny(90));
      expect(await reconcileCreateWith(w, enrollmentId, denied.limiter)).toMatchObject({ outcome: "pending", reconciliationDeferred: true, retryAfterSeconds: 90 });
      expect(creates(w)).toHaveLength(0);
      expect(reads()).toBe(0);
      expect(await w.enrollments.findById(enrollmentId)).toMatchObject({ state: "turnkey_enrollment_in_flight", turnkeyRequestReplayed: false, turnkeyActivityId: null, turnkeyRequestStamp: expect.any(String) });

      const allowed = budget(ALLOW);
      await reconcileCreateWith(w, enrollmentId, allowed.limiter);
      expect(creates(w)).toHaveLength(1);
      expect(allowed.calls).toHaveLength(1);
      expect(events.indexOf("charge")).toBeLessThan(events.indexOf("getUsers") === -1 ? Infinity : events.indexOf("getUsers"));
      expect(await w.enrollments.findById(enrollmentId)).toMatchObject({ turnkeyRequestReplayed: true });
    });

    it("a stale stored stamp is dropped BEFORE the charge, so a throttled account does not keep it — and the denial then reads nothing", async () => {
      const w = await world();
      const { enrollmentId } = await toUnansweredCreate(w);
      w.clock.now += TURNKEY_STAMP_FRESHNESS_WINDOW_MS + 1;
      const { budget, reads } = instrument(w);
      expect(await reconcileCreateWith(w, enrollmentId, budget(deny(12)).limiter)).toMatchObject({ outcome: "pending", reconciliationDeferred: true, retryAfterSeconds: 12 });
      expect(await w.enrollments.findById(enrollmentId)).toMatchObject({ state: "turnkey_enrollment_in_flight", turnkeyRequestStamp: null, turnkeyRequestReplayed: false });
      expect(creates(w)).toHaveLength(0);
      expect(reads()).toBe(0);
    });

    describe("freshness is judged AFTER admission (3A-3 follow-up, LOW-1)", () => {
      /** A limiter whose admission "takes time": it records the charge, moves the fake clock by `elapsedMs`, then answers. */
      function slowAdmission(w: World, elapsedMs: number, decision: { allowed: true } | { allowed: false; retryAfterSeconds: number }) {
        const calls: number[] = [];
        const limiter = {
          async consume() {
            calls.push(w.clock.now);
            w.clock.now += elapsedMs;
            return decision;
          },
        };
        return { limiter, calls };
      }
      /** An unanswered create whose signed request is exactly `ageMs` old on the fake clock. */
      async function unansweredCreateAged(w: World, ageMs: number) {
        const created = await toUnansweredCreate(w);
        const timestamp = (await w.enrollments.findById(created.enrollmentId))!.turnkeyRequestTimestampMs!;
        w.clock.now = timestamp + ageMs;
        return { ...created, timestamp };
      }

      it("a request that expires WHILE admission runs claims nothing and forwards nothing — and recovery is unchanged", async () => {
        const w = await world();
        const { enrollmentId } = await unansweredCreateAged(w, TURNKEY_STAMP_FRESHNESS_WINDOW_MS); // fresh: exactly on the boundary
        w.fake.nextMode = "pending_activity";
        const { reads } = instrument(w);
        const { limiter, calls } = slowAdmission(w, 1, ALLOW); // admission outlasts the window by 1 ms

        const result = await reconcileCreateWith(w, enrollmentId, limiter);
        expect(calls).toHaveLength(1); // exactly one charge
        expect(result).toEqual({ outcome: "pending", reason: expect.any(String) }); // truthful: still unconfirmed, not a deferral
        expect(result).not.toHaveProperty("reconciliationDeferred");
        expect(creates(w)).toHaveLength(0); // no replay forwarded
        const stored = (await w.enrollments.findById(enrollmentId))!;
        expect(stored).toMatchObject({ state: "turnkey_enrollment_in_flight", turnkeyRequestReplayed: false, turnkeyActivityId: null, turnkeyActivityStatus: null });
        expect(reads()).toBe(1); // only the read-only discovery that an expired request has always got

        // Existing recovery behavior: the next reconcile (the request is now plainly stale) drops the stamp, still never replays.
        expect((await reconcileCreateWith(w, enrollmentId, scriptedBudget(ALLOW).limiter)).outcome).toBe("pending");
        expect(await w.enrollments.findById(enrollmentId)).toMatchObject({ turnkeyRequestStamp: null, turnkeyRequestReplayed: false, turnkeyActivityId: null });
        expect(creates(w)).toHaveLength(0);
      });

      it("a request that is still fresh when admission ends keeps its one replay — including exactly on the boundary", async () => {
        const w = await world();
        const { enrollmentId } = await unansweredCreateAged(w, TURNKEY_STAMP_FRESHNESS_WINDOW_MS - 1);
        w.fake.nextMode = "pending_activity";
        const { limiter, calls } = slowAdmission(w, 1, ALLOW); // ends at age === window, which the predicate still accepts
        await reconcileCreateWith(w, enrollmentId, limiter);
        expect(calls).toHaveLength(1);
        expect(creates(w)).toHaveLength(1);
        expect(await w.enrollments.findById(enrollmentId)).toMatchObject({ turnkeyRequestReplayed: true, turnkeyActivityId: expect.any(String) });

        // and never a second one
        await reconcileCreateWith(w, enrollmentId, scriptedBudget(ALLOW).limiter);
        expect(creates(w)).toHaveLength(1);
      });

      it("the boundary is the existing predicate: age === window replays, age === window + 1 does not (no admission delay)", async () => {
        const fresh = await world();
        const a = await unansweredCreateAged(fresh, TURNKEY_STAMP_FRESHNESS_WINDOW_MS);
        fresh.fake.nextMode = "pending_activity";
        await reconcileCreateWith(fresh, a.enrollmentId, slowAdmission(fresh, 0, ALLOW).limiter);
        expect(creates(fresh)).toHaveLength(1);

        const stale = await world();
        const b = await unansweredCreateAged(stale, TURNKEY_STAMP_FRESHNESS_WINDOW_MS + 1);
        stale.fake.nextMode = "pending_activity";
        await reconcileCreateWith(stale, b.enrollmentId, slowAdmission(stale, 0, ALLOW).limiter);
        expect(creates(stale)).toHaveLength(0);
        expect(await stale.enrollments.findById(b.enrollmentId)).toMatchObject({ turnkeyRequestReplayed: false, turnkeyRequestStamp: null });
      });

      it("a denied admission — slow or not — cannot consume the replay claim, and a later allowed reconcile inside the window still gets it", async () => {
        const w = await world();
        const { enrollmentId } = await unansweredCreateAged(w, 1_000);
        w.fake.nextMode = "pending_activity";
        const { limiter, calls } = slowAdmission(w, 500, { allowed: false, retryAfterSeconds: 30 });
        expect(await reconcileCreateWith(w, enrollmentId, limiter)).toMatchObject({ outcome: "pending", reconciliationDeferred: true, retryAfterSeconds: 30 });
        expect(calls).toHaveLength(1);
        expect(creates(w)).toHaveLength(0);
        expect(await w.enrollments.findById(enrollmentId)).toMatchObject({ turnkeyRequestReplayed: false, turnkeyActivityId: null });

        await reconcileCreateWith(w, enrollmentId, scriptedBudget(ALLOW).limiter);
        expect(creates(w)).toHaveLength(1);
        expect(await w.enrollments.findById(enrollmentId)).toMatchObject({ turnkeyRequestReplayed: true });
      });
    });

    it("a limiter that throws or answers nonsense fails closed: it rejects, with no claim, forward, read or transition", async () => {
      for (const bad of [new Error("connection terminated"), undefined, null, { allowed: "yes" }, { allowed: false }, { allowed: false, retryAfterSeconds: 0 }, { allowed: false, retryAfterSeconds: 86_401 }]) {
        const w = await world();
        const { enrollmentId } = await toUnansweredCreate(w);
        const { budget, reads } = instrument(w);
        await expect(reconcileCreateWith(w, enrollmentId, budget(bad).limiter), JSON.stringify(bad)).rejects.toThrow();
        expect(creates(w)).toHaveLength(0);
        expect(reads()).toBe(0);
        expect(await w.enrollments.findById(enrollmentId)).toMatchObject({ turnkeyRequestReplayed: false, turnkeyActivityId: null });
      }
    });

    it("concurrent reconciles are charged independently, and still forward at most ONE replay", async () => {
      const w = await world();
      const { enrollmentId } = await toUnansweredCreate(w);
      w.fake.nextMode = "pending_activity";
      const { calls, limiter } = scriptedBudget(ALLOW);
      await Promise.all([1, 2, 3, 4].map(() => reconcileCreateWith(w, enrollmentId, limiter)));
      expect(calls).toHaveLength(4);
      expect(creates(w)).toHaveLength(1);
    });

    it("real accounting: the 21st reconcile in a window is deferred, another account is unaffected", async () => {
      const w = await world();
      const { enrollmentId } = await toPendingCreate(w);
      const limiter = realBudget();
      for (let i = 0; i < 20; i += 1) expect(await reconcileCreateWith(w, enrollmentId, limiter)).not.toHaveProperty("reconciliationDeferred");
      const denied = await reconcileCreateWith(w, enrollmentId, limiter);
      expect(denied).toMatchObject({ outcome: "pending", reconciliationDeferred: true });
      expect((denied as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect((await limiter.consume({ subject: "someone-else", policies: TURNKEY_RECONCILE_POLICIES })).allowed).toBe(true);
    });

    it("submit's own reconcile is not charged: it has no limiter, still reads Turnkey, and still reaches the same outcome", async () => {
      const w = await world();
      const { enrollmentId } = await toRegistered(w);
      const { events } = instrument(w);
      expect((await submitCreate(w, enrollmentId, await signedCreate(w, enrollmentId))).outcome).toBe("confirmed");
      expect(events).not.toContain("charge");
      expect(events).toContain("getActivity");
    });
  });

  describe("signing confirmation", () => {
    it("costs nothing for unknown, wrong-state, malformed-id and missing-account requests", async () => {
      const never = scriptedBudget(BOOM).limiter;

      const w = await world();
      const created = await toCreated(w); // authenticator created, not yet login-verified: wrong state
      const first = instrument(w);
      expect((await confirmWith(w, "11111111-1111-4111-8111-111111111111", "act-1", never)).outcome).toBe("rejected");
      expect(await confirmWith(w, created.enrollmentId, "act-1", never)).toMatchObject({ outcome: "rejected" });
      expect(first.reads()).toBe(0);

      const w2 = await world();
      const verified = await toLoginVerified(w2);
      const prepared = await pipeline.prepareSigningProof({ config, registry: w2.registry, enrollments: w2.enrollments, appUserId: APP_USER, enrollmentId: verified.enrollmentId });
      expect(prepared.outcome).toBe("ready");
      const second = instrument(w2);
      for (const bad of ["", "has space", "a/b", "x".repeat(129), "act;drop", "ünï"]) {
        expect(await confirmWith(w2, verified.enrollmentId, bad, never), bad).toMatchObject({ outcome: "rejected" });
      }
      expect(await confirmWith(w2, verified.enrollmentId, "act-1", never, createInMemoryRealAccountRegistry())).toMatchObject({ outcome: "rejected" });
      expect(second.reads()).toBe(0);
      expect((await w2.enrollments.findById(verified.enrollmentId))?.state).toBe("login_verified");
    });

    it("an already-active enrollment answers 'active' for free", async () => {
      const w = await world();
      const { enrollmentId } = await addActiveBackup(w);
      expect(await confirmWith(w, enrollmentId, "whatever", scriptedBudget(BOOM).limiter)).toEqual({ outcome: "active" });
    });

    it("a well-formed request costs exactly ONE unit, charged before readTurnkeyActivity", async () => {
      const w = await world();
      const { enrollmentId } = await toLoginVerified(w);
      const activityId = await seedProofB(w, enrollmentId);
      const { events, budget } = instrument(w);
      const { limiter, calls } = budget(ALLOW);
      expect((await confirmWith(w, enrollmentId, activityId, limiter)).outcome).toBe("active");
      expect(calls).toEqual([{ subject: APP_USER, policies: TURNKEY_RECONCILE_POLICIES }]);
      expect(events).toEqual(["charge", "getActivity"]);
    });

    it("a denial reads nothing, leaves the enrollment and its challenge untouched, and the same activity id works later", async () => {
      const w = await world();
      const { enrollmentId } = await toLoginVerified(w);
      const activityId = await seedProofB(w, enrollmentId);
      const before = (await w.enrollments.findById(enrollmentId))!;
      const { budget, reads } = instrument(w);
      expect(await confirmWith(w, enrollmentId, activityId, budget(deny(300)).limiter)).toEqual({ outcome: "rate_limited", retryAfterSeconds: 300 });
      expect(reads()).toBe(0);
      expect(await w.enrollments.findById(enrollmentId)).toEqual(before);
      expect(before.state).toBe("login_verified");
      expect((await confirmWith(w, enrollmentId, activityId, budget(ALLOW).limiter)).outcome).toBe("active");
    });

    it("a limiter failure rejects with no Turnkey read and no state change", async () => {
      for (const bad of [new Error("down"), null, { allowed: false, retryAfterSeconds: 1.5 }, { allowed: false, retryAfterSeconds: -1 }]) {
        const w = await world();
        const { enrollmentId } = await toLoginVerified(w);
        const activityId = await seedProofB(w, enrollmentId);
        const { budget, reads } = instrument(w);
        await expect(confirmWith(w, enrollmentId, activityId, budget(bad).limiter)).rejects.toThrow();
        expect(reads()).toBe(0);
        expect((await w.enrollments.findById(enrollmentId))?.state).toBe("login_verified");
      }
    });

    it("the activity ids the real flow and the fixtures produce are accepted by the validator", async () => {
      const { isWellFormedActivityId } = await import("@/lib/real/server/payment-authorization");
      for (const id of ["01a12620-1c25-7329-86d4-f8a86a1d8d90", "sign-3fa85f64", "activity-1", "act_ABC-123"]) expect(isWellFormedActivityId(id), id).toBe(true);
    });
  });

  describe("removal reconcile", () => {
    async function inFlightRemoval(w: World, mode: "pending_activity" | "lose_response_before_apply") {
      const added = await addActiveBackup(w);
      const { attemptId, signed } = await signedRemoval(w, added.backup, w.primary);
      w.fake.nextMode = mode;
      expect((await submitRemoval(w, added.backup, w.primary, attemptId, signed)).outcome).toBe("pending");
      w.fake.nextMode = "ok";
      return { ...added, attemptId };
    }

    it("R0 holds under the budget: with NO activity id the reconcile is free and silent — fresh, then stale — whatever the limiter would say", async () => {
      for (const limiterStep of [deny(60), BOOM]) {
        const w = await world();
        const { backup, attemptId } = await inFlightRemoval(w, "lose_response_before_apply");
        expect(await w.revocations.findById(attemptId)).toMatchObject({ state: "dispatch_in_flight", turnkeyActivityId: null });
        const forwardedBefore = w.fake.forwarded.length;
        const { budget, reads } = instrument(w);
        const limited = budget(limiterStep);

        expect(await reconcileRemovalWith(w, backup, attemptId, limited.limiter)).toMatchObject({ outcome: "pending" });
        expect(await reconcileRemovalWith(w, backup, attemptId, limited.limiter)).not.toHaveProperty("reconciliationDeferred");
        w.clock.now += TURNKEY_STAMP_FRESHNESS_WINDOW_MS + 1;
        expect(await reconcileRemovalWith(w, backup, attemptId, limited.limiter)).toMatchObject({ outcome: "blocked" });
        expect(await w.revocations.findById(attemptId)).toMatchObject({ state: "blocked", failureReason: "no_activity_receipt", turnkeyRequestStamp: null });

        expect(limited.calls).toHaveLength(0);
        expect(reads()).toBe(0);
        expect(w.fake.forwarded).toHaveLength(forwardedBefore);
        expect(deletes(w)).toHaveLength(1);
      }
    });

    it("with an activity id it costs exactly ONE unit, charged before the first getActivity", async () => {
      const w = await world();
      const { backup, attemptId } = await inFlightRemoval(w, "pending_activity");
      const { events, budget } = instrument(w);
      const { limiter, calls } = budget(ALLOW);
      expect((await reconcileRemovalWith(w, backup, attemptId, limiter)).outcome).toBe("pending");
      expect(calls).toEqual([{ subject: APP_USER, policies: TURNKEY_RECONCILE_POLICIES }]);
      expect(events[0]).toBe("charge");
      expect(events.filter((e) => e === "charge")).toHaveLength(1);
      expect(events).toContain("getActivity");
    });

    it("a denial is a truthful pending: no read, no write, no forward, the target stays revoking", async () => {
      const w = await world();
      const { backup, attemptId } = await inFlightRemoval(w, "pending_activity");
      const before = (await w.revocations.findById(attemptId))!;
      const forwardedBefore = w.fake.forwarded.length;
      const { budget, reads } = instrument(w);
      const result = await reconcileRemovalWith(w, backup, attemptId, budget(deny(120)).limiter);
      expect(result).toEqual({
        outcome: "pending",
        reason: expect.stringContaining("This passkey may still be able to authorize this account until removal is confirmed."),
        reconciliationDeferred: true,
        retryAfterSeconds: 120,
      });
      expect(reads()).toBe(0);
      expect(w.fake.forwarded).toHaveLength(forwardedBefore);
      expect(await w.revocations.findById(attemptId)).toEqual(before);
      expect((await passkey(w, backup))?.status).toBe("revoking");
    });

    it("a limiter failure rejects with no read and no change", async () => {
      for (const bad of [new Error("down"), undefined, { allowed: 0 }, { allowed: false, retryAfterSeconds: Number.NaN }]) {
        const w = await world();
        const { backup, attemptId } = await inFlightRemoval(w, "pending_activity");
        const before = (await w.revocations.findById(attemptId))!;
        const { budget, reads } = instrument(w);
        await expect(reconcileRemovalWith(w, backup, attemptId, budget(bad).limiter)).rejects.toThrow();
        expect(reads()).toBe(0);
        expect(await w.revocations.findById(attemptId)).toEqual(before);
      }
    });

    it("a terminal attempt, an unknown id and another account's attempt cost nothing", async () => {
      const w = await world();
      const added = await addActiveBackup(w);
      const { attemptId, signed } = await signedRemoval(w, added.backup, w.primary);
      const never = scriptedBudget(BOOM).limiter;
      expect((await reconcileRemovalWith(w, added.backup, attemptId, never)).outcome).toBe("authorization_needed"); // not yet dispatched
      expect((await reconcileRemovalWith(w, added.backup, "11111111-1111-4111-8111-111111111111", never)).outcome).toBe("rejected");
      expect((await submitRemoval(w, added.backup, w.primary, attemptId, signed)).outcome).toBe("revoked");
      expect((await reconcileRemovalWith(w, added.backup, attemptId, never)).outcome).toBe("revoked");
    });

    it("concurrent reconciles with an activity id are each charged once", async () => {
      const w = await world();
      const { backup, attemptId } = await inFlightRemoval(w, "pending_activity");
      const { calls, limiter } = scriptedBudget(ALLOW);
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => reconcileRemovalWith(w, backup, attemptId, limiter)));
      expect(results.every((r) => r.outcome === "pending")).toBe(true);
      expect(calls).toHaveLength(5);
      expect(deletes(w)).toHaveLength(1);
    });

    it("submit's own reconcile is not charged and still reaches the confirmed removal", async () => {
      const w = await world();
      const added = await addActiveBackup(w);
      const { attemptId, signed } = await signedRemoval(w, added.backup, w.primary);
      const { events } = instrument(w);
      expect((await submitRemoval(w, added.backup, w.primary, attemptId, signed)).outcome).toBe("revoked");
      expect(events).not.toContain("charge");
      expect(events).toContain("getActivity");
    });
  });
});
