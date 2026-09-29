import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64Url } from "@/lib/real/bytes";
import type { RealServerConfig } from "@/lib/real/server/config";
import { createInMemoryRealAccountRegistry, getInMemoryRegistryInternals, type RealAccountRegistry } from "@/lib/real/server/registry";
import { createInMemoryPasskeyRevocationStore, getInMemoryRevocationInternals, type PasskeyRevocationStore } from "@/lib/real/server/passkey-revocation-attempts";
import { createInMemoryBackupPasskeyEnrollmentStore, type BackupPasskeyEnrollmentStore } from "@/lib/real/server/backup-passkey-enrollment";
import { createInMemoryRevocationResolutionStore } from "@/lib/real/server/passkey-revocation-resolution-store";
import type { TurnkeyReadOnlyLedger } from "@/lib/real/server/passkey-revocation-resolver";
import { TURNKEY_STAMP_FRESHNESS_WINDOW_MS } from "@/lib/real/server/turnkey-signed-request";
import { createFixtureAuthenticator, type FixtureAuthenticator } from "./fixtures/webauthn";
import { FakeTurnkey, signRequest, toStdBase64 } from "./fixtures/turnkey-fake";

/**
 * S3 — operator resolution of BLOCKED passkey removals (R2a only).
 *
 * Every blocked row here is GENUINE: produced by the real prepare/submit/
 * reconcile path with real WebAuthn stamps against the stateful FakeTurnkey
 * (lost responses, FAILED retries) — never hand-seeded. The resolver only
 * ever sees a strict read-only ledger Proxy that throws on any property other
 * than the four reads, and every refusal is checked to change NOTHING.
 */

const turnkey: { fake: FakeTurnkey | null } = { fake: null };
const mutationSpies = vi.hoisted(() => ({
  createAuthenticators: vi.fn(),
  deleteAuthenticators: vi.fn(),
  createUsers: vi.fn(),
  approveActivity: vi.fn(),
  signRawPayload: vi.fn(),
  createSubOrganization: vi.fn(),
  updateRootQuorum: vi.fn(),
}));

vi.mock("@turnkey/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@turnkey/http")>();
  return {
    ...actual,
    TurnkeyClient: vi.fn().mockImplementation(function TurnkeyClientMock() {
      return {
        getUsers: (input: { organizationId: string }) => turnkey.fake!.getUsers(input),
        getActivity: (input: { organizationId: string; activityId: string }) => turnkey.fake!.getActivity(input),
        getActivities: (input: { organizationId: string; paginationOptions?: { limit?: string; after?: string } }) => turnkey.fake!.getActivities(input),
        getAuthenticators: (input: { organizationId: string; userId: string }) => turnkey.fake!.getAuthenticators(input),
        ...mutationSpies,
      };
    }),
  };
});

const revocation = await import("@/lib/real/server/passkey-revocation");
const resolver = await import("@/lib/real/server/passkey-revocation-resolver");

const ORIGIN = "http://localhost:3000";
const DELETE_URL = "https://api.turnkey.com/public/v1/submit/delete_authenticators";
const DELETE_TYPE = "ACTIVITY_TYPE_DELETE_AUTHENTICATORS";
const APP = "3f58e923-0000-4000-8000-000000000001";
const OTHER_APP = "3f58e923-0000-4000-8000-000000000002";
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

type LedgerOverrides = Partial<{ [K in keyof TurnkeyReadOnlyLedger]: (input: Parameters<TurnkeyReadOnlyLedger[K]>[0]) => Promise<unknown> }>;

type World = {
  registry: RealAccountRegistry;
  revocations: PasskeyRevocationStore;
  enrollments: BackupPasskeyEnrollmentStore;
  resolution: ReturnType<typeof createInMemoryRevocationResolutionStore>;
  fake: FakeTurnkey;
  a: FixtureAuthenticator;
  b: FixtureAuthenticator;
  c: FixtureAuthenticator;
  cEnrollmentId: string | null;
  clock: { now: number };
  deps: { fetchImpl: typeof fetch; now: () => number; sleep: () => Promise<void>; maxPolls: number };
  ledgerCalls: string[];
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

/** Every ledger read goes through here: any property other than the four reads throws. */
function strictLedger(w: World, overrides: LedgerOverrides = {}): TurnkeyReadOnlyLedger {
  const base: Record<string, (input: never) => Promise<unknown>> = {
    getActivity: (input) => w.fake.getActivity(input),
    getActivities: (input) => w.fake.getActivities(input),
    getUsers: (input) => w.fake.getUsers(input),
    getAuthenticators: (input) => w.fake.getAuthenticators(input),
    ...(overrides as Record<string, (input: never) => Promise<unknown>>),
  };
  return new Proxy(base, {
    get(target, prop) {
      if (typeof prop !== "string" || !["getActivity", "getActivities", "getUsers", "getAuthenticators"].includes(prop)) throw new Error(`forbidden ledger access: ${String(prop)}`);
      return async (input: never) => {
        w.ledgerCalls.push(prop);
        return target[prop]!(input);
      };
    },
  }) as unknown as TurnkeyReadOnlyLedger;
}

async function enrollBackup(w: Pick<World, "enrollments" | "fake">, who: FixtureAuthenticator, authenticatorId: string, activate: boolean): Promise<string> {
  const enrollment = (await w.enrollments.createStarted({ appUserId: APP }))!;
  const mint = `mint-${authenticatorId}`;
  await w.enrollments.transition({ id: enrollment.id, from: "started", to: "started", patch: { registrationMintId: mint } });
  await w.enrollments.registerCredential({
    id: enrollment.id,
    credential: { credentialId: who.credentialIdBase64Url, userHandle: "h", credentialPublicKey: bytesToBase64Url(who.publicKeyCose), counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false, registrationChallenge: "c", rawClientDataJson: "d", rawAttestationObject: "e", stepUpCredentialId: "s", registrationMintId: mint },
  });
  await w.enrollments.transition({ id: enrollment.id, from: "credential_registered", to: "turnkey_enrollment_in_flight", patch: { externalOutcome: "unknown" } });
  const created = w.fake.addAuthenticator(who.credentialIdBase64Url, authenticatorId);
  expect(await w.enrollments.confirmCreated({ id: enrollment.id, turnkeyAuthenticatorId: authenticatorId, turnkeyAuthenticatorPublicKey: created.credential.publicKey, turnkeyActivityStatus: "ACTIVITY_STATUS_COMPLETED" })).not.toBeNull();
  if (activate) {
    await w.enrollments.transition({ id: enrollment.id, from: "turnkey_authenticator_created", to: "login_verified", patch: { loginVerifiedAt: new Date().toISOString() } });
    expect(await w.enrollments.activate({ id: enrollment.id, signingProofActivityId: `proof-${authenticatorId}` })).not.toBeNull();
  }
  return enrollment.id;
}

/**
 * Account APP: A (primary, active), B (backup, active — its enrollment
 * 'active'), optionally C (backup, PENDING but Turnkey-mapped: enrollment
 * 'turnkey_authenticator_created', holding the one-open slot). Plus an
 * unrelated account OTHER_APP that must never change.
 */
async function world(opts: { pendingC?: boolean } = {}): Promise<World> {
  const registry = createInMemoryRealAccountRegistry();
  const a = createFixtureAuthenticator();
  const b = createFixtureAuthenticator();
  const c = createFixtureAuthenticator();
  const other = createFixtureAuthenticator();
  const account = (appUserId: string, org: string, user: string) => ({
    appUserId,
    subOrganizationId: org,
    turnkeyUserId: user,
    walletId: "wallet",
    walletAccountId: "wallet-account",
    ownerAddress: "0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF",
    safeAddress: "0xd9a4c22fb34dc74317edc8006140d66c8fa03266",
    accountConfigVersion: 1,
  });
  const passkey = (appUserId: string, who: FixtureAuthenticator) => ({ credentialId: who.credentialIdBase64Url, appUserId, credentialPublicKey: bytesToBase64Url(who.publicKeyCose), userHandle: "h", counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice" as const, credentialBackedUp: false });
  await registry.createAccountWithPasskey({ account: account(APP, "sub-org-1", "turnkey-user-1"), passkey: passkey(APP, a) });
  await registry.transitionPasskeyStatus({ credentialId: a.credentialIdBase64Url, from: "active", to: "active", patch: { turnkeyAuthenticatorId: "authenticator-a" } });
  await registry.createAccountWithPasskey({ account: account(OTHER_APP, "sub-org-2", "turnkey-user-2"), passkey: passkey(OTHER_APP, other) });
  await registry.transitionPasskeyStatus({ credentialId: other.credentialIdBase64Url, from: "active", to: "active", patch: { turnkeyAuthenticatorId: "authenticator-other" } });

  const fake = new FakeTurnkey("sub-org-1", "turnkey-user-1");
  fake.addAuthenticator(a.credentialIdBase64Url, "authenticator-a");
  turnkey.fake = fake;
  const enrollments = createInMemoryBackupPasskeyEnrollmentStore(registry);
  const revocations = createInMemoryPasskeyRevocationStore(registry);
  await tick();
  await enrollBackup({ enrollments, fake }, b, "authenticator-b", true);
  let cEnrollmentId: string | null = null;
  if (opts.pendingC) {
    await tick();
    cEnrollmentId = await enrollBackup({ enrollments, fake }, c, "authenticator-c", false);
  }
  const clock = { now: Date.now() };
  return {
    registry,
    revocations,
    enrollments,
    resolution: createInMemoryRevocationResolutionStore(registry, revocations),
    fake,
    a,
    b,
    c,
    cEnrollmentId,
    clock,
    deps: { fetchImpl: fake.fetchImpl, now: () => clock.now, sleep: async () => {}, maxPolls: 1 },
    ledgerCalls: [],
  };
}

function prepare(w: World, target: FixtureAuthenticator, session: FixtureAuthenticator) {
  return revocation.prepareRevocation({ config, registry: w.registry, revocations: w.revocations, appUserId: APP, credentialId: target.credentialIdBase64Url, sessionCredentialId: session.credentialIdBase64Url, now: () => w.clock.now });
}

async function prepareAndSign(w: World, target: FixtureAuthenticator, session: FixtureAuthenticator) {
  const prepared = await prepare(w, target, session);
  if (prepared.outcome !== "ready") throw new Error(JSON.stringify(prepared));
  return { attemptId: prepared.attemptId, signed: signRequest({ authenticator: session, activity: prepared.activity, url: DELETE_URL, origin: ORIGIN, rpId: config.rpId }) };
}

function submit(w: World, target: FixtureAuthenticator, session: FixtureAuthenticator, attemptId: string, signedRequest: unknown) {
  return revocation.submitRevocation({ config, registry: w.registry, revocations: w.revocations, appUserId: APP, credentialId: target.credentialIdBase64Url, attemptId, sessionCredentialId: session.credentialIdBase64Url, signedRequest, deps: w.deps });
}

function reconcile(w: World, target: FixtureAuthenticator, attemptId: string) {
  return revocation.reconcileRevocation({ config, registry: w.registry, revocations: w.revocations, appUserId: APP, credentialId: target.credentialIdBase64Url, attemptId, deps: w.deps });
}

/** LF1: the DELETE lands at Turnkey, every response is lost, the window closes => genuinely 'blocked/no_activity_receipt' with the target really gone. */
async function blockByLostResponse(w: World, target: FixtureAuthenticator, session: FixtureAuthenticator): Promise<string> {
  const { attemptId, signed } = await prepareAndSign(w, target, session);
  w.fake.nextMode = "lose_response_after_apply";
  await submit(w, target, session, attemptId, signed);
  w.fake.nextMode = "ok";
  w.clock.now += TURNKEY_STAMP_FRESHNESS_WINDOW_MS + 1;
  expect((await reconcile(w, target, attemptId)).outcome).toBe("blocked");
  expect(await w.revocations.findById(attemptId)).toMatchObject({ state: "blocked", failureReason: "no_activity_receipt", turnkeyActivityId: null });
  return attemptId;
}

/** The user's retry (fresh survivor stamp, fresh body) FAILS at Turnkey because the target is already gone => 'blocked/delete_activity_failed'. */
async function blockByFailedRetry(w: World, target: FixtureAuthenticator, session: FixtureAuthenticator): Promise<string> {
  await tick();
  const { attemptId, signed } = await prepareAndSign(w, target, session);
  w.fake.modeQueue = ["fail_activity"];
  expect((await submit(w, target, session, attemptId, signed)).outcome).toBe("blocked");
  expect(await w.revocations.findById(attemptId)).toMatchObject({ state: "blocked", failureReason: "delete_activity_failed", turnkeyActivityStatus: "ACTIVITY_STATUS_FAILED" });
  return attemptId;
}

function resolve(w: World, attemptId: string, opts: { commit?: boolean; ledger?: TurnkeyReadOnlyLedger; appUserId?: string } = {}) {
  return resolver.resolveBlockedRevocation({ store: w.resolution, ledger: opts.ledger ?? strictLedger(w), appUserId: opts.appUserId ?? APP, revocationAttemptId: attemptId, commit: opts.commit ?? true, now: () => w.clock.now });
}

const sha = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");

/** The Turnkey activity bound (by fingerprint) to an attempt's stored body. */
async function activityForBody(w: World, attemptId: string) {
  const attempt = (await w.revocations.findById(attemptId))!;
  return [...w.fake.activities.values()].find((a) => a.fingerprint === `sha256:${sha(attempt.turnkeyRequestBody!)}`)!;
}

/** Complete durable state (passkeys, attempts, enrollments, resolution rows) — used to prove refusals write nothing. */
function dump(w: World) {
  const { passkeysByCredentialId, backupEnrollmentMaps } = getInMemoryRegistryInternals(w.registry);
  const { attempts } = getInMemoryRevocationInternals(w.revocations);
  return structuredClone({
    passkeys: [...passkeysByCredentialId.values()].sort((x, y) => x.credentialId.localeCompare(y.credentialId)),
    attempts: [...attempts.values()].sort((x, y) => x.id.localeCompare(y.id)),
    enrollments: backupEnrollmentMaps.flatMap((m) => [...m.values()]).sort((x, y) => x.id.localeCompare(y.id)),
    resolutions: [...w.resolution.resolutions],
  });
}

const passkey = async (w: World, who: FixtureAuthenticator) => (await w.registry.findPasskeyByCredentialId(who.credentialIdBase64Url))!;

async function expectRefusedUnchanged(w: World, attemptId: string, expected: { outcome: string; reason?: string }, ledger?: TurnkeyReadOnlyLedger) {
  const before = dump(w);
  const forwarded = w.fake.forwarded.length;
  const report = await resolve(w, attemptId, { ledger });
  expect(report).toMatchObject({ ...expected, committed: false });
  expect(dump(w)).toEqual(before);
  expect(w.fake.forwarded).toHaveLength(forwarded);
  return report;
}

afterEach(() => {
  turnkey.fake = null;
  for (const spy of Object.values(mutationSpies)) spy.mockClear();
});

// ---------------------------------------------------------------- main recovery

describe("S3 resolver — R2a recovery", () => {
  it("A: a genuine lost-response block (no activity id) + our stored body's COMPLETED receipt + target absent => revoked; own fields untouched; one audit row", async () => {
    const w = await world();
    const attemptId = await blockByLostResponse(w, w.b, w.a);
    const receipt = await activityForBody(w, attemptId);
    const forwarded = w.fake.forwarded.length;

    const report = await resolve(w, attemptId);
    expect(report).toMatchObject({ outcome: "resolved", committed: true, evidence: { receiptActivityId: receipt.id, receiptSource: "stored_attempt_body", receiptBodyAttemptId: attemptId, survivorAuthenticatorIds: ["authenticator-a"] } });
    // AH: state/updated_at only — the attempt's own activity id/status/failure reason are unchanged.
    expect(await w.revocations.findById(attemptId)).toMatchObject({ state: "confirmed", turnkeyActivityId: null, turnkeyActivityStatus: null, failureReason: "no_activity_receipt" });
    expect((await passkey(w, w.b)).status).toBe("revoked");
    expect((await passkey(w, w.a))).toMatchObject({ status: "active", role: "primary" });
    expect(w.resolution.resolutions).toHaveLength(1);
    expect(w.resolution.resolutions[0]).toMatchObject({
      revocationAttemptId: attemptId,
      appUserId: APP,
      targetCredentialId: w.b.credentialIdBase64Url,
      targetTurnkeyAuthenticatorId: "authenticator-b",
      originalFailureReason: "no_activity_receipt",
      receiptActivityId: receipt.id,
      receiptSource: "stored_attempt_body",
      receiptBodyAttemptId: attemptId,
      activityLogHeadId: [...w.fake.activities.values()].at(-1)!.id,
      observedSurvivorAuthenticatorIds: ["authenticator-a"],
      resolverVersion: 1,
    });
    // No raw body, stamp, or assertion is ever part of the audit row.
    expect(JSON.stringify(w.resolution.resolutions[0])).not.toMatch(/timestampMs|stampHeader|clientDataJson|signature/);
    // AI: reads only; nothing forwarded; no mutation method ever touched.
    expect(w.fake.forwarded).toHaveLength(forwarded);
    for (const spy of Object.values(mutationSpies)) expect(spy).not.toHaveBeenCalled();
  });

  it("A: the LF1 dead end — the lost-response delete landed, the user's retry FAILED (target already gone) — the retry resolves via the EARLIER stored body; its own FAILED activity/status/reason stay untouched; the earlier attempt stays blocked history", async () => {
    const w = await world();
    const first = await blockByLostResponse(w, w.b, w.a);
    const retry = await blockByFailedRetry(w, w.b, w.a);
    const retryBefore = (await w.revocations.findById(retry))!;
    const receipt = await activityForBody(w, first);

    // The OLDER attempt can't be resolved: a newer non-cancelled one exists.
    await expectRefusedUnchanged(w, first, { outcome: "not_resolvable_state", reason: "newer_attempt_exists" });

    const report = await resolve(w, retry);
    expect(report).toMatchObject({ outcome: "resolved", evidence: { receiptActivityId: receipt.id, receiptSource: "stored_attempt_body", receiptBodyAttemptId: first } });
    expect(await w.revocations.findById(retry)).toMatchObject({
      state: "confirmed",
      turnkeyActivityId: retryBefore.turnkeyActivityId,
      turnkeyActivityStatus: "ACTIVITY_STATUS_FAILED",
      failureReason: "delete_activity_failed",
      turnkeyRequestBodySha256: retryBefore.turnkeyRequestBodySha256,
      turnkeyRequestBody: retryBefore.turnkeyRequestBody,
    });
    expect((await w.revocations.findById(first))?.state).toBe("blocked");
    expect((await passkey(w, w.b)).status).toBe("revoked");
    expect(w.resolution.resolutions).toMatchObject([{ revocationAttemptId: retry, receiptBodyAttemptId: first, originalFailureReason: "delete_activity_failed" }]);
  });

  it("A: own_attempt — a block caused by a mis-read result, where Turnkey's own ledger holds the exact COMPLETED receipt for THIS attempt's recorded id", async () => {
    const w = await world();
    const { attemptId, signed } = await prepareAndSign(w, w.b, w.a);
    w.fake.nextMode = "pending_activity";
    await submit(w, w.b, w.a, attemptId, signed);
    w.fake.nextMode = "ok";
    const own = (await w.revocations.findById(attemptId))!.turnkeyActivityId!;
    const activity = w.fake.activities.get(own)!;
    // The delete completed at Turnkey; a transient response-shape quirk made reconcile read a non-matching result => blocked.
    w.fake.users.set("turnkey-user-1", w.fake.authenticators().filter((x) => x.authenticatorId !== "authenticator-b"));
    Object.assign(activity, { status: "ACTIVITY_STATUS_COMPLETED", result: { deleteAuthenticatorsResult: { authenticatorIds: ["something-else"] } } });
    expect((await reconcile(w, w.b, attemptId)).outcome).toBe("blocked");
    expect((await w.revocations.findById(attemptId))?.failureReason).toBe("delete_result_mismatch");
    activity.result = { deleteAuthenticatorsResult: { authenticatorIds: ["authenticator-b"] } };
    const before = (await w.revocations.findById(attemptId))!;

    const report = await resolve(w, attemptId);
    expect(report).toMatchObject({ outcome: "resolved", evidence: { receiptActivityId: own, receiptSource: "own_attempt", receiptBodyAttemptId: attemptId } });
    expect(await w.revocations.findById(attemptId)).toMatchObject({ state: "confirmed", turnkeyActivityId: own, turnkeyActivityStatus: before.turnkeyActivityStatus, failureReason: "delete_result_mismatch" });
  });

  it("a short first page is NOT the end: the walk keeps going until an EMPTY page and finds the receipt further back", async () => {
    const w = await world();
    const attemptId = await blockByLostResponse(w, w.b, w.a);
    for (let i = 0; i < 3; i += 1) w.fake.addActivity({ id: `sign-${i}`, status: "ACTIVITY_STATUS_COMPLETED", organizationId: "sub-org-1", type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2", intent: {}, result: {} });
    const pages: number[] = [];
    const ledger = strictLedger(w, {
      getActivities: async (input) => {
        // A deliberately SHORT first page (2 rows) even though more exist.
        const limit = input.paginationOptions.limit === "1" ? "1" : input.paginationOptions.after === undefined ? "2" : "100";
        const response = await w.fake.getActivities({ ...input, paginationOptions: { ...input.paginationOptions, limit } });
        pages.push(response.activities.length);
        return response;
      },
    });
    expect((await resolve(w, attemptId, { ledger })).outcome).toBe("resolved");
    expect(pages.slice(0, 3)).toEqual([2, expect.any(Number), 0]);
  });
});

// ---------------------------------------------------------------- receipts

describe("S3 resolver — receipt evidence (R2a only)", () => {
  it("B: the delete never landed (response lost BEFORE apply) and the target vanished out of band => no receipt, stays blocked", async () => {
    const w = await world();
    const { attemptId, signed } = await prepareAndSign(w, w.b, w.a);
    w.fake.nextMode = "lose_response_before_apply";
    await submit(w, w.b, w.a, attemptId, signed);
    w.fake.nextMode = "ok";
    w.clock.now += TURNKEY_STAMP_FRESHNESS_WINDOW_MS + 1;
    expect((await reconcile(w, w.b, attemptId)).outcome).toBe("blocked");
    w.fake.users.set("turnkey-user-1", w.fake.authenticators().filter((x) => x.authenticatorId !== "authenticator-b"));
    await expectRefusedUnchanged(w, attemptId, { outcome: "no_receipt" });
    expect(w.ledgerCalls).not.toContain("getUsers"); // absence is never even consulted without a receipt
  });

  it("C: R2b is never accepted — an exact external/dashboard COMPLETED delete of the target with no stored body (any or no fingerprint) + target absent => no receipt", async () => {
    const w = await world();
    const { attemptId, signed } = await prepareAndSign(w, w.b, w.a);
    w.fake.nextMode = "lose_response_before_apply";
    await submit(w, w.b, w.a, attemptId, signed);
    w.fake.nextMode = "ok";
    w.clock.now += TURNKEY_STAMP_FRESHNESS_WINDOW_MS + 1;
    await reconcile(w, w.b, attemptId);
    w.fake.users.set("turnkey-user-1", w.fake.authenticators().filter((x) => x.authenticatorId !== "authenticator-b"));
    const external = (id: string, fingerprint?: string) => ({
      id,
      status: "ACTIVITY_STATUS_COMPLETED",
      organizationId: "sub-org-1",
      type: DELETE_TYPE,
      intent: { deleteAuthenticatorsIntent: { userId: "turnkey-user-1", authenticatorIds: ["authenticator-b"] } },
      result: { deleteAuthenticatorsResult: { authenticatorIds: ["authenticator-b"] } },
      ...(fingerprint === undefined ? {} : { fingerprint }),
    });
    w.fake.addActivity(external("dashboard-1", `sha256:${sha("a body this app never stored")}`));
    w.fake.addActivity(external("dashboard-2"));
    await expectRefusedUnchanged(w, attemptId, { outcome: "no_receipt" });
  });

  it("D: a fingerprint that isn't exactly 'sha256:' + our stored body hash => refused", async () => {
    for (const mutate of [
      () => `sha256:${sha("different")}`,
      (fp: string) => fp.toUpperCase(),
      (fp: string) => fp.replace("sha256:", ""),
      () => undefined,
    ]) {
      const w = await world();
      const attemptId = await blockByLostResponse(w, w.b, w.a);
      const receipt = await activityForBody(w, attemptId);
      receipt.fingerprint = mutate(receipt.fingerprint as string);
      await expectRefusedUnchanged(w, attemptId, { outcome: "no_receipt" });
    }
  });

  it("E: one stored body bound to MORE THAN ONE Turnkey activity (any status) => inconsistent, refused", async () => {
    const w = await world();
    const attemptId = await blockByLostResponse(w, w.b, w.a);
    const receipt = await activityForBody(w, attemptId);
    w.fake.addActivity({ ...structuredClone(receipt), id: "duplicate-activity", status: "ACTIVITY_STATUS_FAILED", createdAt: undefined });
    await expectRefusedUnchanged(w, attemptId, { outcome: "inconsistent_manual_review", reason: "stored_body_matches_multiple_activities" });
  });

  it("two DIFFERENT exact receipts for the target => inconsistent, refused", async () => {
    const w = await world();
    const first = await blockByLostResponse(w, w.b, w.a);
    const retry = await blockByFailedRetry(w, w.b, w.a);
    const retryActivity = await activityForBody(w, retry);
    Object.assign(retryActivity, { status: "ACTIVITY_STATUS_COMPLETED", result: { deleteAuthenticatorsResult: { authenticatorIds: ["authenticator-b"] } } });
    expect(first).not.toBe(retry);
    await expectRefusedUnchanged(w, retry, { outcome: "inconsistent_manual_review", reason: "multiple_receipts" });
  });

  it.each([
    ["status", (a: Record<string, unknown>) => ({ ...a, status: "ACTIVITY_STATUS_PENDING" })],
    ["fingerprint", (a: Record<string, unknown>) => ({ ...a, fingerprint: `sha256:${sha("x")}` })],
    ["createdAt", (a: Record<string, unknown>) => ({ ...a, createdAt: { seconds: "1", nanos: "0" } })],
    ["intent", (a: Record<string, unknown>) => ({ ...a, intent: { deleteAuthenticatorsIntent: { userId: "turnkey-user-1", authenticatorIds: ["authenticator-a"] } } })],
    ["result", (a: Record<string, unknown>) => ({ ...a, result: { deleteAuthenticatorsResult: { authenticatorIds: [] } } })],
    ["id", (a: Record<string, unknown>) => ({ ...a, id: "another" })],
    ["type", (a: Record<string, unknown>) => ({ ...a, type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2" })],
    ["organizationId", (a: Record<string, unknown>) => ({ ...a, organizationId: "sub-org-2" })],
  ])("F: the getActivity re-read of the receipt differs (%s) => refused", async (_field, mutate) => {
    const w = await world();
    const attemptId = await blockByLostResponse(w, w.b, w.a);
    const ledger = strictLedger(w, { getActivity: async (input) => ({ activity: mutate((await w.fake.getActivity(input)).activity) }) });
    await expectRefusedUnchanged(w, attemptId, { outcome: "inconsistent_manual_review", reason: "receipt_reread_mismatch" }, ledger);
  });

  it("F: the receipt re-read failing => turnkey_read_failed, no change", async () => {
    const w = await world();
    const attemptId = await blockByLostResponse(w, w.b, w.a);
    const ledger = strictLedger(w, { getActivity: async () => Promise.reject(new Error("down")) });
    await expectRefusedUnchanged(w, attemptId, { outcome: "turnkey_read_failed" }, ledger);
  });

  it("G: a receipt in the wrong org => the walk is inconclusive, refused", async () => {
    const w = await world();
    const attemptId = await blockByLostResponse(w, w.b, w.a);
    (await activityForBody(w, attemptId)).organizationId = "sub-org-2";
    await expectRefusedUnchanged(w, attemptId, { outcome: "turnkey_read_incomplete", reason: "foreign_org_activity" });
  });

  it.each([
    ["H: wrong user in the intent", { intent: { deleteAuthenticatorsIntent: { userId: "turnkey-user-2", authenticatorIds: ["authenticator-b"] } } }],
    ["I: wrong activity type", { type: "ACTIVITY_TYPE_DELETE_USERS" }],
    ["J: a non-singleton intent", { intent: { deleteAuthenticatorsIntent: { userId: "turnkey-user-1", authenticatorIds: ["authenticator-b", "authenticator-a"] } } }],
    ["J: a different intent target", { intent: { deleteAuthenticatorsIntent: { userId: "turnkey-user-1", authenticatorIds: ["authenticator-a"] } } }],
    ["J: extra intent fields", { intent: { deleteAuthenticatorsIntent: { userId: "turnkey-user-1", authenticatorIds: ["authenticator-b"], extra: 1 } } }],
    ["K: a non-singleton result", { result: { deleteAuthenticatorsResult: { authenticatorIds: ["authenticator-b", "authenticator-a"] } } }],
    ["K: an empty result", { result: { deleteAuthenticatorsResult: { authenticatorIds: [] } } }],
    ["K: a different result target", { result: { deleteAuthenticatorsResult: { authenticatorIds: ["authenticator-a"] } } }],
    ["not COMPLETED", { status: "ACTIVITY_STATUS_FAILED" }],
  ])("%s => no exact receipt, refused", async (_label, change) => {
    const w = await world();
    const attemptId = await blockByLostResponse(w, w.b, w.a);
    Object.assign(await activityForBody(w, attemptId), change);
    await expectRefusedUnchanged(w, attemptId, { outcome: "no_receipt", reason: "no_exact_completed_receipt" });
  });

  it("a stored body that no longer re-validates (tampered bytes or hash) is untrusted => no receipt", async () => {
    for (const tamper of ["body", "hash"] as const) {
      const w = await world();
      const attemptId = await blockByLostResponse(w, w.b, w.a);
      const { attempts } = getInMemoryRevocationInternals(w.revocations);
      const row = attempts.get(attemptId)!;
      if (tamper === "body") attempts.set(attemptId, { ...row, turnkeyRequestBody: `${row.turnkeyRequestBody} ` });
      else attempts.set(attemptId, { ...row, turnkeyRequestBodySha256: sha("other") });
      await expectRefusedUnchanged(w, attemptId, { outcome: "no_receipt", reason: "no_trusted_stored_delete_body" });
    }
  });
});

// ---------------------------------------------------------------- absence

describe("S3 resolver — absence proof (never sufficient alone, fails closed)", () => {
  const withExtraUser = (w: World, authenticators: Array<{ authenticatorId: string; credentialId: string }>) =>
    w.fake.users.set("someone-else", authenticators.map((a) => ({ ...a, authenticatorName: "x", credential: { publicKey: "02" } })));

  it("L: target id absent, but the target's credential BYTES present — on the account user, or on ANY other user — => refused", async () => {
    for (const where of ["account-user", "other-user"] as const) {
      const w = await world();
      const attemptId = await blockByLostResponse(w, w.b, w.a);
      if (where === "account-user") w.fake.addAuthenticator(w.b.credentialIdBase64Url, "authenticator-b-again");
      else withExtraUser(w, [{ authenticatorId: "authenticator-z", credentialId: toStdBase64(w.b.credentialIdBase64Url) }]);
      await expectRefusedUnchanged(w, attemptId, { outcome: "target_still_present", reason: "target_credential_bytes_present" });
    }
  });

  it("M: target bytes absent, but the target authenticator ID present (anywhere) => refused", async () => {
    for (const where of ["account-user", "other-user"] as const) {
      const w = await world();
      const attemptId = await blockByLostResponse(w, w.b, w.a);
      const stranger = createFixtureAuthenticator();
      if (where === "account-user") w.fake.addAuthenticator(stranger.credentialIdBase64Url, "authenticator-b");
      else withExtraUser(w, [{ authenticatorId: "authenticator-b", credentialId: toStdBase64(stranger.credentialIdBase64Url) }]);
      const report = await resolve(w, attemptId, { commit: false });
      expect(report.outcome).not.toBe("resolvable_dry_run");
      await expectRefusedUnchanged(w, attemptId, { outcome: "target_still_present", reason: "target_authenticator_id_present" });
    }
  });

  it("N: getUsers and getAuthenticators disagree (missing, extra, or different bytes) => refused", async () => {
    const variants: Array<(list: Array<Record<string, unknown>>) => unknown> = [
      (list) => list.slice(1),
      (list) => [...list, { authenticatorId: "authenticator-q", credentialId: toStdBase64(createFixtureAuthenticator().credentialIdBase64Url) }],
      (list) => list.map((a) => ({ ...a, credentialId: toStdBase64(createFixtureAuthenticator().credentialIdBase64Url) })),
    ];
    for (const variant of variants) {
      const w = await world();
      const attemptId = await blockByLostResponse(w, w.b, w.a);
      const ledger = strictLedger(w, { getAuthenticators: async (input) => ({ authenticators: variant((await w.fake.getAuthenticators(input)).authenticators as Array<Record<string, unknown>>) }) });
      await expectRefusedUnchanged(w, attemptId, { outcome: "inconsistent_manual_review", reason: "authenticator_views_disagree" }, ledger);
    }
  });

  it("O: an expected survivor missing at Turnkey, or present with different credential bytes => refused", async () => {
    const w = await world();
    const attemptId = await blockByLostResponse(w, w.b, w.a);
    w.fake.users.set("turnkey-user-1", []);
    await expectRefusedUnchanged(w, attemptId, { outcome: "inconsistent_manual_review", reason: "expected_authenticator_missing" });

    const w2 = await world();
    const attemptId2 = await blockByLostResponse(w2, w2.b, w2.a);
    w2.fake.users.set("turnkey-user-1", [{ ...w2.fake.authenticators()[0]!, credentialId: toStdBase64(createFixtureAuthenticator().credentialIdBase64Url) }]);
    await expectRefusedUnchanged(w2, attemptId2, { outcome: "inconsistent_manual_review", reason: "expected_authenticator_credential_mismatch" });
  });

  it("P: an unexplained (unmapped) authenticator on the account user => refused", async () => {
    const w = await world();
    const attemptId = await blockByLostResponse(w, w.b, w.a);
    w.fake.addAuthenticator(createFixtureAuthenticator().credentialIdBase64Url, "authenticator-mystery");
    await expectRefusedUnchanged(w, attemptId, { outcome: "inconsistent_manual_review", reason: "unexplained_authenticator" });
  });

  it("Q: duplicate credential bytes (or a duplicate authenticator id) on the account user => refused", async () => {
    const w = await world();
    const attemptId = await blockByLostResponse(w, w.b, w.a);
    w.fake.addAuthenticator(w.a.credentialIdBase64Url, "authenticator-a2");
    await expectRefusedUnchanged(w, attemptId, { outcome: "inconsistent_manual_review", reason: "duplicate_credential_bytes" });

    const w2 = await world();
    const attemptId2 = await blockByLostResponse(w2, w2.b, w2.a);
    w2.fake.addAuthenticator(createFixtureAuthenticator().credentialIdBase64Url, "authenticator-a");
    await expectRefusedUnchanged(w2, attemptId2, { outcome: "inconsistent_manual_review", reason: "duplicate_authenticator_id" });
  });

  it("the account's Turnkey user missing, getUsers failing, or a malformed/undecodable authenticator => refused, never read as absence", async () => {
    const cases: Array<[LedgerOverrides, string]> = [
      [{ getUsers: async () => ({ users: [] }) }, "inconsistent_manual_review"],
      [{ getUsers: async () => Promise.reject(new Error("down")) }, "turnkey_read_failed"],
      [{ getUsers: async () => null }, "turnkey_read_failed"],
      [{ getUsers: async () => ({ users: [{ userId: "turnkey-user-1" }] }) }, "turnkey_read_failed"],
      [{ getUsers: async () => ({ users: [{ userId: "turnkey-user-1", authenticators: [{ authenticatorId: "authenticator-a", credentialId: "!!" }] }] }) }, "turnkey_read_failed"],
      [{ getAuthenticators: async () => ({}) }, "turnkey_read_failed"],
      [{ getAuthenticators: async () => Promise.reject(new Error("down")) }, "turnkey_read_failed"],
    ];
    for (const [overrides, outcome] of cases) {
      const w = await world();
      const attemptId = await blockByLostResponse(w, w.b, w.a);
      await expectRefusedUnchanged(w, attemptId, { outcome }, strictLedger(w, overrides));
    }
  });

  it("the second absence snapshot sees the target reappear => refused (no fixed delay is trusted; both snapshots must pass)", async () => {
    const w = await world();
    const attemptId = await blockByLostResponse(w, w.b, w.a);
    let reads = 0;
    const ledger = strictLedger(w, {
      getUsers: async (input) => {
        reads += 1;
        if (reads === 2) w.fake.addAuthenticator(w.b.credentialIdBase64Url, "authenticator-b");
        return w.fake.getUsers(input);
      },
    });
    await expectRefusedUnchanged(w, attemptId, { outcome: "target_still_present" }, ledger);
  });
});

// ---------------------------------------------------------------- later authority

describe("S3 resolver — later authenticator authority", () => {
  const credentialV2 = (credentialId: string) => ({ authenticatorName: "x", challenge: "c", attestation: { credentialId, clientDataJson: "d", attestationObject: "e", transports: [] } });
  const credentialV1 = (id: string) => ({ authenticatorName: "x", userId: "u", challenge: "c", attestation: { id, rawId: id, type: "public-key", response: { clientDataJson: "d", attestationObject: "e" }, clientExtensionResults: {} } });

  async function afterReceipt(change: (w: World, targetCredential: string) => Record<string, unknown>, opts: { sameSecond?: boolean } = {}) {
    const w = await world();
    const attemptId = await blockByLostResponse(w, w.b, w.a);
    const receipt = await activityForBody(w, attemptId);
    const activity = { id: "later-activity", status: "ACTIVITY_STATUS_COMPLETED", organizationId: "sub-org-1", result: {}, ...change(w, w.b.credentialIdBase64Url) } as unknown as Record<string, unknown> & { id: string; status: string; organizationId: string; type: string };
    if (opts.sameSecond) activity.createdAt = structuredClone(receipt.createdAt);
    w.fake.addActivity(activity);
    return { w, attemptId };
  }

  it.each([
    ["CREATE_AUTHENTICATORS_V2 (credential bytes)", (w: World, cred: string) => ({ type: "ACTIVITY_TYPE_CREATE_AUTHENTICATORS_V2", intent: { createAuthenticatorsIntentV2: { userId: "turnkey-user-1", authenticators: [credentialV2(toStdBase64(cred))] } } }), "target_credential_readded_after_receipt"],
    ["CREATE_AUTHENTICATORS (v1 attestation id/rawId)", (w: World, cred: string) => ({ type: "ACTIVITY_TYPE_CREATE_AUTHENTICATORS", intent: { createAuthenticatorsIntent: { authenticators: [credentialV1(cred)] } } }), "target_credential_readded_after_receipt"],
    ["CREATE_USERS_V4", (w: World, cred: string) => ({ type: "ACTIVITY_TYPE_CREATE_USERS_V4", intent: { createUsersIntentV4: { users: [{ userName: "x", authenticators: [credentialV2(cred)] }] } } }), "target_credential_readded_after_receipt"],
    ["RECOVER_USER", (w: World, cred: string) => ({ type: "ACTIVITY_TYPE_RECOVER_USER", intent: { recoverUserIntent: { userId: "turnkey-user-1", authenticator: credentialV2(cred) } } }), "target_credential_readded_after_receipt"],
    ["ACCEPT_INVITATION_V2", (w: World, cred: string) => ({ type: "ACTIVITY_TYPE_ACCEPT_INVITATION_V2", intent: { acceptInvitationIntentV2: { invitationId: "i", userId: "u", authenticator: credentialV2(cred) } } }), "target_credential_readded_after_receipt"],
    ["CREATE_SUB_ORGANIZATION_V7", (w: World, cred: string) => ({ type: "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V7", intent: { createSubOrganizationIntentV7: { rootUsers: [{ authenticators: [credentialV2(cred)] }] } } }), "target_credential_readded_after_receipt"],
    [
      "a CREATE whose RESULT names the target authenticator id",
      () => ({ type: "ACTIVITY_TYPE_CREATE_AUTHENTICATORS_V2", intent: { createAuthenticatorsIntentV2: { userId: "turnkey-user-1", authenticators: [credentialV2(createFixtureAuthenticator().credentialIdBase64Url)] } }, result: { createAuthenticatorsResult: { authenticatorIds: ["authenticator-b"] } } }),
      "target_authenticator_readded_after_receipt",
    ],
  ])("R: a later %s re-adding the target => refused", async (_label, change, reason) => {
    const { w, attemptId } = await afterReceipt(change);
    await expectRefusedUnchanged(w, attemptId, { outcome: "inconsistent_manual_review", reason });
  });

  it("R: even a PENDING or FAILED later re-add counts (a pending create may still complete)", async () => {
    for (const status of ["ACTIVITY_STATUS_PENDING", "ACTIVITY_STATUS_FAILED"]) {
      const { w, attemptId } = await afterReceipt((_w, cred) => ({ status, type: "ACTIVITY_TYPE_CREATE_AUTHENTICATORS_V2", intent: { createAuthenticatorsIntentV2: { userId: "turnkey-user-1", authenticators: [credentialV2(cred)] } } }));
      await expectRefusedUnchanged(w, attemptId, { outcome: "inconsistent_manual_review", reason: "target_credential_readded_after_receipt" });
    }
  });

  it("S: a matching CREATE in the SAME SECOND as the receipt counts as at/after => refused", async () => {
    const { w, attemptId } = await afterReceipt((_w, cred) => ({ type: "ACTIVITY_TYPE_CREATE_AUTHENTICATORS_V2", intent: { createAuthenticatorsIntentV2: { userId: "turnkey-user-1", authenticators: [credentialV2(cred)] } } }), { sameSecond: true });
    await expectRefusedUnchanged(w, attemptId, { outcome: "inconsistent_manual_review", reason: "target_credential_readded_after_receipt" });
  });

  it.each([
    ["authenticators not an array", () => ({ type: "ACTIVITY_TYPE_CREATE_AUTHENTICATORS_V2", intent: { createAuthenticatorsIntentV2: { authenticators: "x" } } }), "malformed_authority_activity_after_receipt"],
    ["an undecodable credential id", () => ({ type: "ACTIVITY_TYPE_CREATE_AUTHENTICATORS_V2", intent: { createAuthenticatorsIntentV2: { authenticators: [credentialV2("!!not-an-id")] } } }), "malformed_authority_activity_after_receipt"],
    ["an authority type with an empty intent", () => ({ type: "ACTIVITY_TYPE_CREATE_USERS_V3", intent: {} }), "malformed_authority_activity_after_receipt"],
    ["a user without an authenticators array", () => ({ type: "ACTIVITY_TYPE_CREATE_USERS_V3", intent: { createUsersIntentV3: { users: [{ userName: "x" }] } } }), "malformed_authority_activity_after_receipt"],
    ["two intent keys", () => ({ type: "ACTIVITY_TYPE_CREATE_AUTHENTICATORS_V2", intent: { createAuthenticatorsIntentV2: { authenticators: [] }, createUsersIntentV4: { users: [] } } }), "malformed_authority_activity_after_receipt"],
    ["an UNKNOWN activity type carrying an attestation", () => ({ type: "ACTIVITY_TYPE_SOMETHING_NEW", intent: { somethingNewIntent: { authenticator: credentialV2("abc") } } }), "unrecognized_authority_shape_after_receipt"],
  ])("T: a malformed/unrecognized authority activity after the receipt (%s) => refused", async (_label, change, reason) => {
    const { w, attemptId } = await afterReceipt(change);
    await expectRefusedUnchanged(w, attemptId, { outcome: "inconsistent_manual_review", reason });
  });

  it("an unrelated later CREATE, and the target's own ORIGINAL create before the receipt, do not block resolution", async () => {
    const { w, attemptId } = await afterReceipt(() => ({ type: "ACTIVITY_TYPE_CREATE_AUTHENTICATORS_V2", intent: { createAuthenticatorsIntentV2: { userId: "turnkey-user-1", authenticators: [credentialV2(toStdBase64(createFixtureAuthenticator().credentialIdBase64Url))] } }, result: { createAuthenticatorsResult: { authenticatorIds: ["authenticator-new"] } } }));
    // The earlier CREATE of B itself, before the receipt:
    const { activities } = w.fake;
    const early = { id: "original-create-b", status: "ACTIVITY_STATUS_COMPLETED", organizationId: "sub-org-1", type: "ACTIVITY_TYPE_CREATE_AUTHENTICATORS_V2", intent: { createAuthenticatorsIntentV2: { userId: "turnkey-user-1", authenticators: [credentialV2(w.b.credentialIdBase64Url)] } }, result: { createAuthenticatorsResult: { authenticatorIds: ["authenticator-b"] } }, createdAt: { seconds: "1000", nanos: "0" } };
    const rebuilt = new Map([[early.id, early], ...activities]);
    w.fake.activities = rebuilt as typeof activities;
    expect((await resolve(w, attemptId)).outcome).toBe("resolved");
  });
});

// ---------------------------------------------------------------- the activity walk

describe("S3 resolver — activity-log walk (no partial scan ever resolves)", () => {
  it("U: getActivities failing or malformed => refused", async () => {
    for (const [overrides, outcome] of [
      [{ getActivities: async () => Promise.reject(new Error("down")) }, "turnkey_read_failed"],
      [{ getActivities: async () => ({ activities: "nope" }) }, "turnkey_read_failed"],
      [{ getActivities: async () => ({ activities: [{ id: "x" }] }) }, "turnkey_read_incomplete"],
    ] as Array<[LedgerOverrides, string]>) {
      const w = await world();
      const attemptId = await blockByLostResponse(w, w.b, w.a);
      await expectRefusedUnchanged(w, attemptId, { outcome }, strictLedger(w, overrides));
    }
  });

  it("U: an endless log exceeding the page cap => incomplete, refused", async () => {
    const w = await world();
    const attemptId = await blockByLostResponse(w, w.b, w.a);
    let page = 0;
    const ledger = strictLedger(w, {
      getActivities: async () => {
        page += 1;
        return { activities: Array.from({ length: 100 }, (_, i) => ({ id: `p${page}-${i}`, status: "ACTIVITY_STATUS_COMPLETED", organizationId: "sub-org-1", type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2", createdAt: { seconds: String(1_900_000_000 - page * 1000 - i), nanos: "0" } })) };
      },
    });
    await expectRefusedUnchanged(w, attemptId, { outcome: "turnkey_read_incomplete", reason: "activity_page_cap_exceeded" }, ledger);
    expect(page).toBe(resolver.MAX_ACTIVITY_PAGES);
  });

  it("V: a repeated page (cursor ignored) or a repeated id => incomplete, refused", async () => {
    const w = await world();
    const attemptId = await blockByLostResponse(w, w.b, w.a);
    const ledger = strictLedger(w, { getActivities: async (input) => w.fake.getActivities({ organizationId: input.organizationId, paginationOptions: { limit: input.paginationOptions.limit } }) });
    await expectRefusedUnchanged(w, attemptId, { outcome: "turnkey_read_incomplete", reason: "repeated_activity_id" }, ledger);
  });

  it("V: createdAt increasing while walking newest -> oldest, or an over-full page => incomplete, refused", async () => {
    const w = await world();
    const attemptId = await blockByLostResponse(w, w.b, w.a);
    // A NEWER row (listed first) whose createdAt is EARLIER than the older receipt's.
    w.fake.addActivity({ id: "out-of-order", status: "ACTIVITY_STATUS_COMPLETED", organizationId: "sub-org-1", type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2", intent: {}, result: {}, createdAt: { seconds: "5", nanos: "0" } });
    await expectRefusedUnchanged(w, attemptId, { outcome: "turnkey_read_incomplete", reason: "activity_created_at_increasing" });

    const w2 = await world();
    const attemptId2 = await blockByLostResponse(w2, w2.b, w2.a);
    const over = strictLedger(w2, { getActivities: async () => ({ activities: Array.from({ length: 101 }, (_, i) => ({ id: `x${i}`, status: "s", organizationId: "sub-org-1", type: "t", createdAt: { seconds: "1", nanos: "0" } })) }) });
    await expectRefusedUnchanged(w2, attemptId2, { outcome: "turnkey_read_incomplete", reason: "activity_page_over_limit" }, over);
  });

  it("W: the activity-log head moves after the final absence snapshot => refused, rerun required", async () => {
    const w = await world();
    const attemptId = await blockByLostResponse(w, w.b, w.a);
    const ledger = strictLedger(w, {
      getActivities: async (input) => {
        if (input.paginationOptions.limit === "1") w.fake.addActivity({ id: "late-arrival", status: "ACTIVITY_STATUS_PENDING", organizationId: "sub-org-1", type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2", intent: {}, result: {} });
        return w.fake.getActivities(input);
      },
    });
    await expectRefusedUnchanged(w, attemptId, { outcome: "activity_log_changed" }, ledger);
    // The head check is the LAST read: after both absence snapshots.
    expect(w.ledgerCalls.slice(-5)).toEqual(["getUsers", "getAuthenticators", "getUsers", "getAuthenticators", "getActivities"]);
  });
});

// ---------------------------------------------------------------- local state

describe("S3 resolver — local preconditions", () => {
  it("X: a newer authorization_needed attempt blocks resolution; once it is CANCELLED the blocked attempt resolves", async () => {
    const w = await world();
    const attemptId = await blockByLostResponse(w, w.b, w.a);
    await tick();
    const retry = await prepare(w, w.b, w.a);
    if (retry.outcome !== "ready") throw new Error("setup");
    await expectRefusedUnchanged(w, attemptId, { outcome: "not_resolvable_state", reason: "newer_attempt_exists" });
    await revocation.cancelRevocation({ revocations: w.revocations, appUserId: APP, credentialId: w.b.credentialIdBase64Url, attemptId: retry.attemptId, sessionCredentialId: w.a.credentialIdBase64Url });
    expect((await resolve(w, attemptId)).outcome).toBe("resolved");
  });

  it("Y: a newer BLOCKED attempt blocks resolution of the older one", async () => {
    const w = await world();
    const first = await blockByLostResponse(w, w.b, w.a);
    await blockByFailedRetry(w, w.b, w.a);
    await expectRefusedUnchanged(w, first, { outcome: "not_resolvable_state", reason: "newer_attempt_exists" });
  });

  it("a dispatch_in_flight attempt, a non-blocked attempt, a wrong account, or malformed ids => refused", async () => {
    const w = await world();
    const attemptId = await blockByLostResponse(w, w.b, w.a);
    const before = dump(w);
    expect(await resolve(w, attemptId, { appUserId: OTHER_APP })).toMatchObject({ outcome: "not_resolvable_state", reason: "attempt_not_owned_by_account", committed: false });
    expect(dump(w)).toEqual(before);
    expect(await resolve(w, "not-a-uuid")).toMatchObject({ outcome: "not_resolvable_state", reason: "invalid_identifier" });
    expect(await resolve(w, attemptId, { appUserId: "app-user-1" })).toMatchObject({ outcome: "not_resolvable_state", reason: "invalid_identifier" });
    expect(await resolve(w, "3f58e923-0000-4000-8000-00000000dead")).toMatchObject({ outcome: "not_resolvable_state", reason: "unknown_account_or_attempt" });

    // A retry in flight (response pending):
    await tick();
    const { attemptId: inflight, signed } = await prepareAndSign(w, w.b, w.a);
    w.fake.modeQueue = ["pending_activity"];
    await submit(w, w.b, w.a, inflight, signed);
    expect((await w.revocations.findById(inflight))?.state).toBe("dispatch_in_flight");
    await expectRefusedUnchanged(w, attemptId, { outcome: "not_resolvable_state", reason: "dispatch_in_flight_exists" });
    await expectRefusedUnchanged(w, inflight, { outcome: "not_resolvable_state", reason: "attempt_state_dispatch_in_flight" });
  });

  it("AF: no other ACTIVE mapped survivor => refused (never resolves toward zero active passkeys)", async () => {
    const w = await world();
    const attemptId = await blockByLostResponse(w, w.b, w.a);
    await w.registry.transitionPasskeyStatus({ credentialId: w.a.credentialIdBase64Url, from: "active", to: "revoking" });
    await expectRefusedUnchanged(w, attemptId, { outcome: "not_resolvable_state", reason: "no_other_active_mapped_passkey" });
  });
});

// ---------------------------------------------------------------- the commit

describe("S3 resolver — the locked commit", () => {
  it("AJ: a DRY RUN performs every read and check and writes NOTHING; the commit run then resolves", async () => {
    const w = await world({ pendingC: true });
    const attemptId = await blockByLostResponse(w, w.c, w.a);
    const before = dump(w);
    const report = await resolve(w, attemptId, { commit: false });
    expect(report).toMatchObject({ outcome: "resolvable_dry_run", committed: false, evidence: { receiptSource: "stored_attempt_body" } });
    expect(dump(w)).toEqual(before);
    expect((await resolve(w, attemptId)).outcome).toBe("resolved");
  });

  it("AA: two concurrent operator commits => exactly one resolution row; the other reports already-resolved; reruns are idempotent", async () => {
    const w = await world();
    const attemptId = await blockByLostResponse(w, w.b, w.a);
    const reports = await Promise.all([resolve(w, attemptId), resolve(w, attemptId)]);
    expect(reports.map((r) => r.outcome).sort()).toEqual(["already_resolved", "resolved"]);
    expect(w.resolution.resolutions).toHaveLength(1);
    const after = dump(w);
    expect(await resolve(w, attemptId)).toMatchObject({ outcome: "already_resolved", committed: false });
    expect(dump(w)).toEqual(after);
  });

  it("AB: a lost CAS — any re-checked local fact changed between the reads and the commit — rolls back COMPLETELY", async () => {
    const tampers: Array<[string, (w: World, attemptId: string) => Promise<void> | void]> = [
      ["the attempt's failure reason", (w, id) => {
        const { attempts } = getInMemoryRevocationInternals(w.revocations);
        attempts.set(id, { ...attempts.get(id)!, failureReason: "tampered" });
      }],
      ["the attempt's activity id", (w, id) => {
        const { attempts } = getInMemoryRevocationInternals(w.revocations);
        attempts.set(id, { ...attempts.get(id)!, turnkeyActivityId: "tampered" });
      }],
      ["the receipt body's bytes", (w, id) => {
        const { attempts } = getInMemoryRevocationInternals(w.revocations);
        attempts.set(id, { ...attempts.get(id)!, turnkeyRequestBody: `${attempts.get(id)!.turnkeyRequestBody} ` });
      }],
      ["the target mapping", (w) => {
        const { passkeysByCredentialId } = getInMemoryRegistryInternals(w.registry);
        const c = passkeysByCredentialId.get(w.c.credentialIdBase64Url)!;
        passkeysByCredentialId.set(c.credentialId, { ...c, turnkeyAuthenticatorId: "authenticator-other-c" });
      }],
      ["every other survivor left 'active'", async (w) => {
        await w.registry.transitionPasskeyStatus({ credentialId: w.a.credentialIdBase64Url, from: "active", to: "revoking" });
        await w.registry.transitionPasskeyStatus({ credentialId: w.b.credentialIdBase64Url, from: "active", to: "revoking" });
      }],
      ["every other active survivor lost its Turnkey mapping (still 'active')", (w) => {
        const { passkeysByCredentialId } = getInMemoryRegistryInternals(w.registry);
        for (const who of [w.a, w.b]) {
          const p = passkeysByCredentialId.get(who.credentialIdBase64Url)!;
          passkeysByCredentialId.set(p.credentialId, { ...p, turnkeyAuthenticatorId: null });
        }
      }],
      ["the target's enrollment moved", async (w) => {
        const { backupEnrollmentMaps } = getInMemoryRegistryInternals(w.registry);
        for (const map of backupEnrollmentMaps) {
          const e = map.get(w.cEnrollmentId!);
          if (e) map.set(e.id, { ...e, state: "blocked" });
        }
      }],
      ["a newer attempt appeared", async (w) => {
        await tick();
        expect((await prepare(w, w.c, w.a)).outcome).toBe("ready");
      }],
    ];
    for (const [label, tamper] of tampers) {
      const w = await world({ pendingC: true });
      const attemptId = await blockByLostResponse(w, w.c, w.a);
      let armed = true;
      const ledger = strictLedger(w, {
        getActivities: async (input) => {
          // The head read is the last Turnkey read before the commit: change local state right there.
          if (input.paginationOptions.limit === "1" && armed) {
            armed = false;
            await tamper(w, attemptId);
          }
          return w.fake.getActivities(input);
        },
      });
      const report = await resolve(w, attemptId, { ledger });
      expect(report, label).toMatchObject({ outcome: "lost_race", committed: false });
      // Nothing moved: attempt still blocked, target still revoking, enrollment still holding the slot, no row.
      expect((await w.revocations.findById(attemptId))?.state, label).toBe("blocked");
      expect((await passkey(w, w.c)).status, label).toBe("revoking");
      expect((await w.enrollments.findById(w.cEnrollmentId!))?.state, label).not.toBe("removed");
      expect(w.resolution.resolutions).toHaveLength(0);
      expect(await w.enrollments.createStarted({ appUserId: APP })).toBeNull();
    }
  });

  it("Z: a user retry (prepare + beginDispatch) racing the resolver — whichever commits first wins, never both, never a double transition", async () => {
    // Retry first: it lands between the resolver's reads and its commit.
    const w = await world();
    const attemptId = await blockByLostResponse(w, w.b, w.a);
    let armed = true;
    const ledger = strictLedger(w, {
      getActivities: async (input) => {
        if (input.paginationOptions.limit === "1" && armed) {
          armed = false;
          await tick();
          const { attemptId: retry, signed } = await prepareAndSign(w, w.b, w.a);
          w.fake.nextMode = "lose_response_before_apply";
          await submit(w, w.b, w.a, retry, signed);
          w.fake.nextMode = "ok";
          expect((await w.revocations.findById(retry))?.state).toBe("dispatch_in_flight");
        }
        return w.fake.getActivities(input);
      },
    });
    expect((await resolve(w, attemptId, { ledger })).outcome).toBe("lost_race");
    expect((await w.revocations.findById(attemptId))?.state).toBe("blocked");
    expect((await passkey(w, w.b)).status).toBe("revoking");
    expect(w.resolution.resolutions).toHaveLength(0);

    // A retry whose DELETE reaches Turnkey moves the activity-log head: refused even before the commit.
    const w1 = await world();
    const attempt1 = await blockByLostResponse(w1, w1.b, w1.a);
    let armed1 = true;
    const ledger1 = strictLedger(w1, {
      getActivities: async (input) => {
        if (input.paginationOptions.limit === "1" && armed1) {
          armed1 = false;
          await tick();
          const { attemptId: retry, signed } = await prepareAndSign(w1, w1.b, w1.a);
          w1.fake.modeQueue = ["fail_activity"];
          await submit(w1, w1.b, w1.a, retry, signed);
        }
        return w1.fake.getActivities(input);
      },
    });
    expect((await resolve(w1, attempt1, { ledger: ledger1 })).outcome).toBe("activity_log_changed");
    expect(w1.resolution.resolutions).toHaveLength(0);

    // Resolver first: afterwards the user's retry can't even be prepared, and nothing is forwarded.
    const w2 = await world();
    const attemptId2 = await blockByLostResponse(w2, w2.b, w2.a);
    expect((await resolve(w2, attemptId2)).outcome).toBe("resolved");
    const forwarded = w2.fake.forwarded.length;
    expect((await prepare(w2, w2.b, w2.a)).outcome).toBe("rejected");
    expect(w2.fake.forwarded).toHaveLength(forwarded);
  });

  it("AC: a PENDING-origin target frees the one-open-enrollment slot ONLY on a successful resolution", async () => {
    const w = await world({ pendingC: true });
    const attemptId = await blockByLostResponse(w, w.c, w.a);
    expect((await w.enrollments.findById(w.cEnrollmentId!))?.state).toBe("removal_in_progress");
    expect(await w.enrollments.createStarted({ appUserId: APP })).toBeNull();

    // A refusal (the target reappears) keeps the slot held.
    w.fake.addAuthenticator(w.c.credentialIdBase64Url, "authenticator-c");
    expect((await resolve(w, attemptId)).outcome).toBe("target_still_present");
    expect(await w.enrollments.createStarted({ appUserId: APP })).toBeNull();

    w.fake.users.set("turnkey-user-1", w.fake.authenticators().filter((a) => a.authenticatorId !== "authenticator-c"));
    expect((await resolve(w, attemptId)).outcome).toBe("resolved");
    expect((await w.enrollments.findById(w.cEnrollmentId!))?.state).toBe("removed");
    expect((await passkey(w, w.c)).status).toBe("revoked");
    expect(await w.enrollments.createStarted({ appUserId: APP })).not.toBeNull();
  });

  it("AD: removing the PRIMARY promotes the oldest active survivor (role only); a pending setup is never promoted", async () => {
    const w = await world({ pendingC: true });
    const attemptId = await blockByLostResponse(w, w.a, w.b);
    expect((await resolve(w, attemptId)).outcome).toBe("resolved");
    expect(await passkey(w, w.a)).toMatchObject({ status: "revoked", role: "primary" });
    expect(await passkey(w, w.b)).toMatchObject({ status: "active", role: "primary", turnkeyAuthenticatorId: "authenticator-b" });
    expect(await passkey(w, w.c)).toMatchObject({ status: "pending", role: "backup" });
  });

  it("AE: removing a BACKUP promotes nobody", async () => {
    const w = await world();
    const attemptId = await blockByLostResponse(w, w.b, w.a);
    expect((await resolve(w, attemptId)).outcome).toBe("resolved");
    expect(await passkey(w, w.a)).toMatchObject({ status: "active", role: "primary" });
    expect(await passkey(w, w.b)).toMatchObject({ status: "revoked", role: "backup" });
  });

  it("AG: an unrelated account is byte-for-byte unchanged", async () => {
    const w = await world();
    const attemptId = await blockByLostResponse(w, w.b, w.a);
    const otherBefore = dump(w).passkeys.filter((p) => p.appUserId === OTHER_APP);
    expect((await resolve(w, attemptId)).outcome).toBe("resolved");
    expect(dump(w).passkeys.filter((p) => p.appUserId === OTHER_APP)).toEqual(otherBefore);
  });

  it("the store refuses a second resolution citing an already-used receipt, and an attempt that isn't blocked", async () => {
    const w = await world();
    const attemptId = await blockByLostResponse(w, w.b, w.a);
    const report = await resolve(w, attemptId);
    expect(report.outcome).toBe("resolved");
    const row = w.resolution.resolutions[0]!;
    const replay = await w.resolution.commitResolution({
      appUserId: APP,
      attemptId,
      targetCredentialId: row.targetCredentialId,
      targetTurnkeyAuthenticatorId: row.targetTurnkeyAuthenticatorId,
      expected: { turnkeyActivityId: null, turnkeyActivityStatus: null, failureReason: "no_activity_receipt" },
      receipt: { activityId: row.receiptActivityId, source: row.receiptSource, bodyAttemptId: row.receiptBodyAttemptId, bodySha256: row.receiptBodySha256, turnkeyCreatedAt: row.receiptTurnkeyCreatedAt },
      activityLogHeadId: row.activityLogHeadId,
      absenceFirstObservedAt: row.absenceFirstObservedAt,
      absenceLastObservedAt: row.absenceLastObservedAt,
      survivorAuthenticatorIds: row.observedSurvivorAuthenticatorIds,
      resolverVersion: 1,
    });
    expect(replay).toEqual({ outcome: "lost_race" });
    expect(w.resolution.resolutions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- no mutation path

describe("S3 resolver — no Turnkey mutation path exists", () => {
  it("AI: across a full resolution the ledger is asked only for the four reads; nothing is forwarded; no client mutation method is touched", async () => {
    const w = await world({ pendingC: true });
    const attemptId = await blockByLostResponse(w, w.c, w.a);
    const forwarded = w.fake.forwarded.length;
    expect((await resolve(w, attemptId)).outcome).toBe("resolved");
    expect(new Set(w.ledgerCalls)).toEqual(new Set(["getActivities", "getActivity", "getUsers", "getAuthenticators"]));
    expect(w.fake.forwarded).toHaveLength(forwarded);
    for (const spy of Object.values(mutationSpies)) expect(spy).not.toHaveBeenCalled();
  });

  it("AI: the production ledger exposes EXACTLY the four reads, each bound to the matching client read — no mutation method is reachable through it", async () => {
    const w = await world();
    const ledger = resolver.createReadOnlyTurnkeyLedger(config);
    expect(Object.keys(ledger).sort()).toEqual(["getActivities", "getActivity", "getAuthenticators", "getUsers"]);
    expect(Object.isFrozen(ledger)).toBe(true);
    await ledger.getUsers({ organizationId: "sub-org-1" });
    await ledger.getAuthenticators({ organizationId: "sub-org-1", userId: "turnkey-user-1" });
    await ledger.getActivities({ organizationId: "sub-org-1", paginationOptions: { limit: "1" } });
    w.fake.addActivity({ id: "probe", status: "ACTIVITY_STATUS_COMPLETED", organizationId: "sub-org-1", type: "t" });
    await ledger.getActivity({ organizationId: "sub-org-1", activityId: "probe" });
    for (const spy of Object.values(mutationSpies)) expect(spy).not.toHaveBeenCalled();
  });

  it("redactReport prints only truncated identifiers", async () => {
    const w = await world();
    const attemptId = await blockByLostResponse(w, w.b, w.a);
    const report = await resolve(w, attemptId, { commit: false });
    const printed = JSON.stringify(resolver.redactReport(report));
    expect(printed).not.toContain(report.evidence!.receiptActivityId);
    expect(printed).not.toContain(w.b.credentialIdBase64Url);
    expect(printed).toContain("resolvable_dry_run");
  });
});
