import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64Url } from "@/lib/real/bytes";
import type { RealServerConfig } from "@/lib/real/server/config";
import { createInMemoryRealAccountRegistry, getInMemoryRegistryInternals, type RealAccountRegistry } from "@/lib/real/server/registry";
import { createInMemoryPasskeyRevocationStore, getInMemoryRevocationInternals, type PasskeyRevocationStore } from "@/lib/real/server/passkey-revocation-attempts";
import { createInMemoryBackupPasskeyEnrollmentStore, type BackupPasskeyEnrollmentStore } from "@/lib/real/server/backup-passkey-enrollment";
import { createInMemoryRevocationResolutionStore } from "@/lib/real/server/passkey-revocation-resolution-store";
import type { TurnkeyReadOnlyLedger } from "@/lib/real/server/passkey-revocation-resolver";
import { TURNKEY_STAMP_FRESHNESS_WINDOW_MS } from "@/lib/real/server/turnkey-signed-request";
import { createInMemoryProviderBudgetStore, createProviderBudgetLimiter } from "@/lib/real/server/rate-limit";
import { createFixtureAuthenticator, type FixtureAuthenticator } from "./fixtures/webauthn";
import { FakeTurnkey, signRequest } from "./fixtures/turnkey-fake";

/**
 * S3 operator-only resolver — per-read CALLER deadlines (15 s) on the four
 * read-only SDK calls behind createReadOnlyTurnkeyLedger.
 *
 * Every blocked row is GENUINE (real prepare/submit/reconcile against the
 * stateful FakeTurnkey, as in passkey-revocation-resolver.test.ts). The
 * resolver is handed the REAL adapter; only the SDK client underneath is
 * replaced, with hooks that can hang, throw, reject or answer late. Fake
 * timers cover setTimeout/clearTimeout only. Nothing here touches a network,
 * a database or an operator script.
 */

const turnkey: { fake: FakeTurnkey | null } = { fake: null };
type Hook = (input: unknown, callNumber: number) => unknown;
const sdk = vi.hoisted(() => ({
  overrides: {} as Record<string, ((input: unknown, callNumber: number) => unknown) | undefined>,
  counts: { getUsers: 0, getActivity: 0, getActivities: 0, getAuthenticators: 0 } as Record<string, number>,
  log: [] as string[],
  args: [] as Array<{ name: string; args: unknown[] }>,
  mutation: {
    createAuthenticators: vi.fn(),
    deleteAuthenticators: vi.fn(),
    createUsers: vi.fn(),
    approveActivity: vi.fn(),
    signRawPayload: vi.fn(),
    createSubOrganization: vi.fn(),
    updateRootQuorum: vi.fn(),
  },
}));

vi.mock("@turnkey/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@turnkey/http")>();
  // Deliberately NOT async: a hook that throws must throw synchronously out of the SDK call.
  const call = (name: "getUsers" | "getActivity" | "getActivities" | "getAuthenticators", args: unknown[]) => {
    sdk.log.push(name);
    sdk.args.push({ name, args });
    const n = (sdk.counts[name] = (sdk.counts[name] ?? 0) + 1);
    const override = sdk.overrides[name];
    if (override) return override(args[0], n);
    return (turnkey.fake![name] as (input: unknown) => Promise<unknown>)(args[0]);
  };
  return {
    ...actual,
    TurnkeyClient: vi.fn().mockImplementation(function TurnkeyClientMock() {
      return {
        getUsers: (...args: unknown[]) => call("getUsers", args),
        getActivity: (...args: unknown[]) => call("getActivity", args),
        getActivities: (...args: unknown[]) => call("getActivities", args),
        getAuthenticators: (...args: unknown[]) => call("getAuthenticators", args),
        ...sdk.mutation,
      };
    }),
  };
});

const revocation = await import("@/lib/real/server/passkey-revocation");
const resolver = await import("@/lib/real/server/passkey-revocation-resolver");

const DEADLINE = resolver.S3_TURNKEY_READ_DEADLINE_MS;
const ORIGIN = "http://localhost:3000";
const DELETE_URL = "https://api.turnkey.com/public/v1/submit/delete_authenticators";
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

const unthrottledBudget = () => createProviderBudgetLimiter(createInMemoryProviderBudgetStore());
const tick = () => new Promise((resolve) => setTimeout(resolve, 3));
const never = () => new Promise<never>(() => {});
const FAKE_TIMERS: { toFake: Array<"setTimeout" | "clearTimeout"> } = { toFake: ["setTimeout", "clearTimeout"] };

type World = {
  registry: RealAccountRegistry;
  revocations: PasskeyRevocationStore;
  enrollments: BackupPasskeyEnrollmentStore;
  resolution: ReturnType<typeof createInMemoryRevocationResolutionStore>;
  fake: FakeTurnkey;
  a: FixtureAuthenticator;
  b: FixtureAuthenticator;
  clock: { now: number };
  deps: { fetchImpl: typeof fetch; now: () => number; sleep: () => Promise<void>; maxPolls: number };
  attemptId: string;
};

async function enrollBackup(w: Pick<World, "enrollments" | "fake">, who: FixtureAuthenticator, authenticatorId: string): Promise<void> {
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
  await w.enrollments.transition({ id: enrollment.id, from: "turnkey_authenticator_created", to: "login_verified", patch: { loginVerifiedAt: new Date().toISOString() } });
  const signingProofChallenge = `0x${"ab".repeat(32)}`;
  expect(await w.enrollments.transition({ id: enrollment.id, from: "login_verified", to: "login_verified", patch: { signingProofChallenge } })).not.toBeNull();
  expect(await w.enrollments.activate({ id: enrollment.id, signingProofActivityId: `proof-${authenticatorId}`, signingProofChallenge })).not.toBeNull();
}

/** Account APP: A (primary) + B (active backup, the removal target), plus an unrelated OTHER_APP; B's removal is genuinely BLOCKED (lost response, window closed). */
async function world(): Promise<World> {
  const registry = createInMemoryRealAccountRegistry();
  const a = createFixtureAuthenticator();
  const b = createFixtureAuthenticator();
  const other = createFixtureAuthenticator();
  const account = (appUserId: string, org: string, user: string, ownerAddress = "0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF", safeAddress = "0xd9a4c22fb34dc74317edc8006140d66c8fa03266") => ({
    appUserId,
    subOrganizationId: org,
    turnkeyUserId: user,
    walletId: "wallet",
    walletAccountId: "wallet-account",
    ownerAddress,
    safeAddress,
    accountConfigVersion: 1,
  });
  const passkey = (appUserId: string, who: FixtureAuthenticator) => ({ credentialId: who.credentialIdBase64Url, appUserId, credentialPublicKey: bytesToBase64Url(who.publicKeyCose), userHandle: "h", counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice" as const, credentialBackedUp: false });
  await registry.createAccountWithPasskey({ account: account(APP, "sub-org-1", "turnkey-user-1"), passkey: passkey(APP, a) });
  await registry.transitionPasskeyStatus({ credentialId: a.credentialIdBase64Url, from: "active", to: "active", patch: { turnkeyAuthenticatorId: "authenticator-a" } });
  await registry.createAccountWithPasskey({ account: account(OTHER_APP, "sub-org-2", "turnkey-user-2", "0x2222222222222222222222222222222222222201", "0x2222222222222222222222222222222222222202"), passkey: passkey(OTHER_APP, other) });
  await registry.transitionPasskeyStatus({ credentialId: other.credentialIdBase64Url, from: "active", to: "active", patch: { turnkeyAuthenticatorId: "authenticator-other" } });

  const fake = new FakeTurnkey("sub-org-1", "turnkey-user-1");
  fake.addAuthenticator(a.credentialIdBase64Url, "authenticator-a");
  turnkey.fake = fake;
  const enrollments = createInMemoryBackupPasskeyEnrollmentStore(registry);
  const revocations = createInMemoryPasskeyRevocationStore(registry);
  await tick();
  await enrollBackup({ enrollments, fake }, b, "authenticator-b");
  const clock = { now: Date.now() };
  const deps = { fetchImpl: fake.fetchImpl, now: () => clock.now, sleep: async () => {}, maxPolls: 1 };

  // Block the removal of B: the DELETE lands at Turnkey, every response is lost, the window closes.
  const prepared = await revocation.prepareRevocation({ config, registry, revocations, appUserId: APP, credentialId: b.credentialIdBase64Url, sessionCredentialId: a.credentialIdBase64Url, now: () => clock.now });
  if (prepared.outcome !== "ready") throw new Error(JSON.stringify(prepared));
  const signed = signRequest({ authenticator: a, activity: prepared.activity, url: DELETE_URL, origin: ORIGIN, rpId: config.rpId });
  fake.nextMode = "lose_response_after_apply";
  await revocation.submitRevocation({ config, registry, revocations, appUserId: APP, credentialId: b.credentialIdBase64Url, attemptId: prepared.attemptId, sessionCredentialId: a.credentialIdBase64Url, signedRequest: signed, deps });
  fake.nextMode = "ok";
  clock.now += TURNKEY_STAMP_FRESHNESS_WINDOW_MS + 1;
  const reconciled = await revocation.reconcileRevocation({ config, registry, revocations, appUserId: APP, credentialId: b.credentialIdBase64Url, attemptId: prepared.attemptId, providerBudgetLimiter: unthrottledBudget(), deps });
  expect(reconciled.outcome).toBe("blocked");
  expect(await revocations.findById(prepared.attemptId)).toMatchObject({ state: "blocked", failureReason: "no_activity_receipt" });

  return { registry, revocations, enrollments, resolution: createInMemoryRevocationResolutionStore(registry, revocations), fake, a, b, clock, deps, attemptId: prepared.attemptId };
}

/** Complete durable state — used to prove a refused run changes NOTHING. */
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

/** Naive but sufficient for this one file: drops block and line comments so source guards judge code, not prose. */
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => {
      state.settled = true;
      state.value = value;
    },
    (error) => {
      state.settled = true;
      state.error = error;
    },
  );
  return state;
}

/** The REAL adapter, handed to the real resolver. */
function run(w: World, opts: { commit?: boolean; appUserId?: string; ledger?: TurnkeyReadOnlyLedger } = {}) {
  return resolver.resolveBlockedRevocation({
    store: w.resolution,
    ledger: opts.ledger ?? resolver.createReadOnlyTurnkeyLedger(config),
    appUserId: opts.appUserId ?? APP,
    revocationAttemptId: w.attemptId,
    commit: opts.commit ?? true,
    now: () => w.clock.now,
  });
}

/** Let everything that can settle without a timer settle, so the next advance is measured from the hung call's timer start. */
const flush = () => vi.advanceTimersByTimeAsync(0);

/** Drive a run whose read hangs: still waiting one ms before the deadline, settled one ms later. */
async function runUntilDeadline(w: World, opts: { commit?: boolean } = {}) {
  const state = track(run(w, opts));
  await flush();
  await vi.advanceTimersByTimeAsync(DEADLINE - 1);
  expect(state.settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(state.settled).toBe(true);
  expect(state.error).toBeUndefined();
  return state.value as Awaited<ReturnType<typeof run>>;
}

function expectNothingMutated(w: World, before: ReturnType<typeof dump>, forwarded: number) {
  expect(dump(w)).toEqual(before);
  expect(w.resolution.resolutions).toHaveLength(0);
  expect(w.fake.forwarded).toHaveLength(forwarded);
  for (const spy of Object.values(sdk.mutation)) expect(spy).not.toHaveBeenCalled();
}

/** A resolve-after-N-ms read that defers to the real fake. */
const delayed = (ms: number, name: "getUsers" | "getActivity" | "getActivities" | "getAuthenticators"): Hook => (input) =>
  new Promise((resolve, reject) => {
    setTimeout(() => {
      (turnkey.fake![name] as (i: unknown) => Promise<unknown>)(input).then(resolve, reject);
    }, ms);
  });

beforeEach(() => {
  sdk.overrides = {};
  sdk.counts = { getUsers: 0, getActivity: 0, getActivities: 0, getAuthenticators: 0 };
  sdk.log = [];
  sdk.args = [];
});

afterEach(() => {
  vi.useRealTimers();
  turnkey.fake = null;
  for (const spy of Object.values(sdk.mutation)) spy.mockClear();
});

// ---------------------------------------------------------------- A–D, G–J: every read hangs -> refusal, nothing written

describe("each of the four SDK reads, when it never answers, rejects at the deadline and the resolver refuses", () => {
  // getActivities call 1 = first log page; 2 = the terminal empty page; 3 = the head read after both snapshots.
  const cases: Array<{ label: string; method: "getUsers" | "getActivity" | "getActivities" | "getAuthenticators"; call: number; reason: string; lastLog: string[] }> = [
    { label: "A: getActivities (first log page)", method: "getActivities", call: 1, reason: "get_activities_error", lastLog: ["getActivities"] },
    { label: "E: getActivities (a LATER log page — the walk is not allowed to stop there)", method: "getActivities", call: 2, reason: "get_activities_error", lastLog: ["getActivities", "getActivities"] },
    { label: "B/G: getActivity (receipt re-read)", method: "getActivity", call: 1, reason: "get_activity_error", lastLog: ["getActivities", "getActivities", "getActivity"] },
    { label: "C/H: getUsers (first absence snapshot)", method: "getUsers", call: 1, reason: "authenticator_read_error", lastLog: ["getActivities", "getActivities", "getActivity", "getUsers"] },
    { label: "D/H: getAuthenticators (first absence snapshot)", method: "getAuthenticators", call: 1, reason: "authenticator_read_error", lastLog: ["getActivities", "getActivities", "getActivity", "getUsers", "getAuthenticators"] },
    { label: "I: getUsers (SECOND absence snapshot)", method: "getUsers", call: 2, reason: "authenticator_read_error", lastLog: ["getActivities", "getActivities", "getActivity", "getUsers", "getAuthenticators", "getUsers"] },
    { label: "I: getAuthenticators (SECOND absence snapshot)", method: "getAuthenticators", call: 2, reason: "authenticator_read_error", lastLog: ["getActivities", "getActivities", "getActivity", "getUsers", "getAuthenticators", "getUsers", "getAuthenticators"] },
    { label: "J: getActivities (the final head read)", method: "getActivities", call: 3, reason: "head_read_error", lastLog: ["getActivities", "getActivities", "getActivity", "getUsers", "getAuthenticators", "getUsers", "getAuthenticators", "getActivities"] },
  ];

  it.each(cases)("$label", async ({ method, call, reason, lastLog }) => {
    const w = await world();
    const before = dump(w);
    const forwarded = w.fake.forwarded.length;
    sdk.log = [];
    sdk.overrides[method] = (input, n) => (n === call ? never() : (turnkey.fake![method] as (i: unknown) => Promise<unknown>)(input));
    vi.useFakeTimers(FAKE_TIMERS);

    const report = await runUntilDeadline(w, { commit: true });

    expect(report).toEqual({ outcome: "turnkey_read_failed", reason, committed: false });
    // No read after the failed one, and no second attempt at it.
    expect(sdk.log).toEqual(lastLog);
    expect(vi.getTimerCount()).toBe(0);
    expectNothingMutated(w, before, forwarded);
    expect(await w.revocations.findById(w.attemptId)).toMatchObject({ state: "blocked" });
  });
});

// ---------------------------------------------------------------- E/F: the empty-page hazard

describe("a timed-out activity-log page can never be mistaken for the end of the log", () => {
  /** A full (100-row) older-than-everything first page of activities that cannot carry authority. */
  const fullPage = () => ({
    activities: Array.from({ length: 100 }, (_, i) => ({
      id: `pad-${String(i).padStart(3, "0")}`,
      type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
      status: "ACTIVITY_STATUS_COMPLETED",
      organizationId: "sub-org-1",
      createdAt: { seconds: "1700000000", nanos: "0" },
      intent: {},
      result: {},
    })),
  });

  it("E: page 1 is a full page and page 2 hangs -> refused at the deadline; the partial log is never used", async () => {
    const w = await world();
    const before = dump(w);
    sdk.overrides.getActivities = (_input, n) => (n === 1 ? Promise.resolve(fullPage()) : never());
    vi.useFakeTimers(FAKE_TIMERS);
    const report = await runUntilDeadline(w, { commit: true });
    expect(report).toEqual({ outcome: "turnkey_read_failed", reason: "get_activities_error", committed: false });
    expect(sdk.counts.getActivities).toBe(2);
    expect(sdk.counts.getActivity).toBe(0); // never got as far as a receipt
    expectNothingMutated(w, before, w.fake.forwarded.length);
  });

  it("F: MUTANT — a deadline that resolved { activities: [] } would end the walk early and let the run proceed; the real adapter refuses instead", async () => {
    const w = await world();
    // What a broken wrapper would hand the resolver for the hung page: an empty page.
    const mutant: TurnkeyReadOnlyLedger = {
      ...resolver.createReadOnlyTurnkeyLedger(config),
      getActivities: async (input) => (sdk.counts.getActivities++ === 1 ? { activities: [] } : turnkey.fake!.getActivities(input)),
    };
    sdk.counts.getActivities = 0;
    const mutantReport = await run(w, { commit: false, ledger: mutant });
    // The security assertion used by the real-adapter tests ("turnkey_read_failed") does NOT hold for the mutant …
    expect(mutantReport.outcome).not.toBe("turnkey_read_failed");
    // … and an empty FIRST page is read as "empty log" — a different, wrong, non-failure outcome.
    const emptyFirst: TurnkeyReadOnlyLedger = { ...resolver.createReadOnlyTurnkeyLedger(config), getActivities: async () => ({ activities: [] }) };
    expect(await run(w, { commit: false, ledger: emptyFirst })).toMatchObject({ outcome: "no_receipt", reason: "empty_activity_log" });

    // The real adapter, same hang position, is a failure — never a terminal empty page.
    sdk.overrides.getActivities = (input, n) => (n === 2 ? never() : (turnkey.fake!.getActivities as (i: unknown) => Promise<unknown>)(input));
    sdk.counts.getActivities = 0;
    vi.useFakeTimers(FAKE_TIMERS);
    const real = await runUntilDeadline(w, { commit: false });
    expect(real).toEqual({ outcome: "turnkey_read_failed", reason: "get_activities_error", committed: false });
  });

  it("F: the deadline helper's timer callback can only reject — no placeholder value exists in its code", () => {
    const source = stripComments(readFileSync(path.resolve(process.cwd(), "lib/real/server/passkey-revocation-resolver.ts"), "utf8"));
    expect(source.match(/setTimeout\(\(\) => reject\(new S3ReadDeadlineError\(\)\), S3_TURNKEY_READ_DEADLINE_MS\)/g)).toHaveLength(1);
    expect(source.match(/\bsetTimeout\(/g)).toHaveLength(1);
    const helper = /function withS3ReadDeadline[\s\S]*?\n\}\n/.exec(source)?.[0] ?? "";
    expect(helper).not.toBe("");
    expect(helper).not.toMatch(/activities|null|\[\s*\]/);
    // The only value that can ever be resolved is the SDK's own, passed straight through.
    expect(helper.match(/\bresolve\(/g)).toEqual(["resolve("]);
    expect(helper).toContain("resolve(value);");
  });
});

// ---------------------------------------------------------------- K–M: normal behaviour

describe("normal SDK behaviour is preserved", () => {
  it("K: a read that answers 1 ms before the deadline succeeds with its original answer, and the run resolves", async () => {
    const w = await world();
    sdk.overrides.getActivity = delayed(DEADLINE - 1, "getActivity");
    vi.useFakeTimers(FAKE_TIMERS);
    const state = track(run(w, { commit: false }));
    await flush();
    await vi.advanceTimersByTimeAsync(DEADLINE - 1);
    expect(state.settled).toBe(true);
    expect(state.value).toMatchObject({ outcome: "resolvable_dry_run", committed: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["getActivity", "getActivities", "getUsers", "getAuthenticators"] as const)("L: %s throwing SYNCHRONOUSLY keeps the existing classification and leaks no timer", async (method) => {
    const w = await world();
    const before = dump(w);
    sdk.overrides[method] = () => {
      throw new Error("sdk exploded synchronously");
    };
    vi.useFakeTimers(FAKE_TIMERS);
    const report = await run(w, { commit: true }); // settles with NO timer advance
    const reasons = { getActivity: "get_activity_error", getActivities: "get_activities_error", getUsers: "authenticator_read_error", getAuthenticators: "authenticator_read_error" };
    expect(report).toEqual({ outcome: "turnkey_read_failed", reason: reasons[method], committed: false });
    expect(vi.getTimerCount()).toBe(0);
    expectNothingMutated(w, before, w.fake.forwarded.length);
  });

  it.each(["getActivity", "getActivities", "getUsers", "getAuthenticators"] as const)("M: %s rejecting immediately keeps the existing classification and leaks no timer", async (method) => {
    const w = await world();
    const before = dump(w);
    sdk.overrides[method] = () => Promise.reject(new Error("401 from sdk"));
    vi.useFakeTimers(FAKE_TIMERS);
    const report = await run(w, { commit: true });
    const reasons = { getActivity: "get_activity_error", getActivities: "get_activities_error", getUsers: "authenticator_read_error", getAuthenticators: "authenticator_read_error" };
    expect(report).toEqual({ outcome: "turnkey_read_failed", reason: reasons[method], committed: false });
    expect(vi.getTimerCount()).toBe(0);
    expectNothingMutated(w, before, w.fake.forwarded.length);
  });

  it("Q: every read gets its OWN fresh timer — a run far longer than one deadline in total still succeeds when each read is under it", async () => {
    const w = await world();
    for (const name of ["getActivity", "getActivities", "getUsers", "getAuthenticators"] as const) sdk.overrides[name] = delayed(DEADLINE - 1_000, name);
    vi.useFakeTimers(FAKE_TIMERS);
    const state = track(run(w, { commit: false }));
    let advanced = 0;
    for (let i = 0; i < 40 && !state.settled; i += 1) {
      await vi.advanceTimersByTimeAsync(DEADLINE - 1_000);
      advanced += DEADLINE - 1_000;
    }
    expect(state.value).toMatchObject({ outcome: "resolvable_dry_run" });
    expect(advanced).toBeGreaterThan(DEADLINE * 5); // 8 sequential reads
    expect(sdk.log).toHaveLength(8);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("U: a complete, healthy run still resolves exactly as before (dry run, then commit)", async () => {
    const w = await world();
    vi.useFakeTimers(FAKE_TIMERS);
    expect(await run(w, { commit: false })).toMatchObject({ outcome: "resolvable_dry_run", committed: false });
    expect(w.resolution.resolutions).toHaveLength(0);
    const report = await run(w, { commit: true });
    expect(report).toMatchObject({ outcome: "resolved", committed: true });
    expect(w.resolution.resolutions).toHaveLength(1);
    expect(await w.revocations.findById(w.attemptId)).toMatchObject({ state: "confirmed" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------- N–P: late results

describe("a result that arrives after the deadline reaches nobody", () => {
  it("N: a late SUCCESS after the timeout changes nothing and triggers no further read or write", async () => {
    const w = await world();
    const before = dump(w);
    let release!: (value: unknown) => void;
    sdk.overrides.getActivity = (input) =>
      new Promise((resolve) => {
        release = (v) => resolve(v);
        void input;
      });
    vi.useFakeTimers(FAKE_TIMERS);
    const report = await runUntilDeadline(w, { commit: true });
    expect(report).toEqual({ outcome: "turnkey_read_failed", reason: "get_activity_error", committed: false });
    const logAtFailure = [...sdk.log];

    // The SDK now answers with a perfectly valid receipt. It must go nowhere.
    const real = await turnkey.fake!.getActivities({ organizationId: "sub-org-1", paginationOptions: { limit: "100" } });
    release({ activity: (real as { activities: unknown[] }).activities[0] });
    await vi.advanceTimersByTimeAsync(DEADLINE * 3);
    expect(sdk.log).toEqual(logAtFailure);
    expectNothingMutated(w, before, w.fake.forwarded.length);
  });

  it("O: a late REJECTION after the timeout raises no unhandled rejection", async () => {
    const w = await world();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      let fail!: (error: Error) => void;
      sdk.overrides.getUsers = () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        });
      vi.useFakeTimers(FAKE_TIMERS);
      const report = await runUntilDeadline(w, { commit: true });
      expect(report).toEqual({ outcome: "turnkey_read_failed", reason: "authenticator_read_error", committed: false });
      fail(new Error("late socket error"));
      await vi.advanceTimersByTimeAsync(DEADLINE);
      vi.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("P: an SDK call that ignores cancellation is still only waited on for the deadline, and is given no cancel hook", async () => {
    const w = await world();
    let ignored = 0;
    sdk.overrides.getActivity = () => {
      ignored += 1;
      return never(); // no abort wiring of any kind
    };
    vi.useFakeTimers(FAKE_TIMERS);
    const report = await runUntilDeadline(w, { commit: false });
    expect(report).toMatchObject({ outcome: "turnkey_read_failed", reason: "get_activity_error" });
    expect(ignored).toBe(1);
    for (const call of sdk.args) expect(call.args).toHaveLength(1); // the input object only — no signal, no options
  });
});

// ---------------------------------------------------------------- R, S: adapter shape

describe("the adapter", () => {
  it("R: passes each input through to the SDK method unchanged (and only the input)", async () => {
    const w = await world();
    void w;
    const ledger = resolver.createReadOnlyTurnkeyLedger(config);
    sdk.overrides = {
      getActivity: () => Promise.resolve("a"),
      getActivities: () => Promise.resolve("b"),
      getUsers: () => Promise.resolve("c"),
      getAuthenticators: () => Promise.resolve("d"),
    };
    const inputs = {
      getActivity: { organizationId: "o1", activityId: "act-1" },
      getActivities: { organizationId: "o2", paginationOptions: { limit: "100", after: "act-9" } },
      getUsers: { organizationId: "o3" },
      getAuthenticators: { organizationId: "o4", userId: "u4" },
    };
    sdk.args = [];
    expect(await ledger.getActivity(inputs.getActivity)).toBe("a");
    expect(await ledger.getActivities(inputs.getActivities)).toBe("b");
    expect(await ledger.getUsers(inputs.getUsers)).toBe("c");
    expect(await ledger.getAuthenticators(inputs.getAuthenticators)).toBe("d");
    expect(sdk.args.map((c) => c.name)).toEqual(["getActivity", "getActivities", "getUsers", "getAuthenticators"]);
    for (const call of sdk.args) {
      expect(call.args).toHaveLength(1);
      expect(call.args[0]).toBe(inputs[call.name as keyof typeof inputs]); // same object, not a copy
    }
  });

  it("S: is frozen and exposes exactly the four read methods", () => {
    const ledger = resolver.createReadOnlyTurnkeyLedger(config);
    expect(Object.isFrozen(ledger)).toBe(true);
    expect(Object.keys(ledger).sort()).toEqual(["getActivities", "getActivity", "getAuthenticators", "getUsers"]);
  });

  it("an adapter-level read returns the SDK's original rejection (not a rewrapped error)", async () => {
    const ledger = resolver.createReadOnlyTurnkeyLedger(config);
    const original = new Error("original sdk error");
    sdk.overrides.getUsers = () => Promise.reject(original);
    await expect(ledger.getUsers({ organizationId: "o" })).rejects.toBe(original);
  });

  it("an adapter-level hang rejects with a private deadline error, never a value", async () => {
    const ledger = resolver.createReadOnlyTurnkeyLedger(config);
    sdk.overrides.getActivities = () => never();
    vi.useFakeTimers(FAKE_TIMERS);
    const state = track(ledger.getActivities({ organizationId: "o", paginationOptions: { limit: "100" } }));
    await vi.advanceTimersByTimeAsync(DEADLINE);
    expect(state.settled).toBe(true);
    expect(state.value).toBeUndefined();
    expect(state.error).toBeInstanceOf(Error);
    expect((state.error as Error).name).toBe("S3ReadDeadlineError");
  });
});

// ---------------------------------------------------------------- T: identity binding

describe("T: wrong-account and wrong-organization evidence still fail closed", () => {
  it("an attempt that is not the named account's is refused with no Turnkey read at all", async () => {
    const w = await world();
    const before = dump(w);
    const report = await run(w, { appUserId: OTHER_APP, commit: true });
    expect(report).toMatchObject({ outcome: "not_resolvable_state", committed: false });
    expect(sdk.log).toEqual([]);
    expectNothingMutated(w, before, w.fake.forwarded.length);
  });

  it("an activity-log row from a foreign organization is incomplete evidence, never accepted", async () => {
    const w = await world();
    const before = dump(w);
    sdk.overrides.getActivities = async (input) => {
      const page = (await turnkey.fake!.getActivities(input as Parameters<FakeTurnkey["getActivities"]>[0])) as { activities: Array<Record<string, unknown>> };
      return { activities: page.activities.map((a, i) => (i === 0 ? { ...a, organizationId: "someone-elses-org" } : a)) };
    };
    const report = await run(w, { commit: true });
    expect(report).toEqual({ outcome: "turnkey_read_incomplete", reason: "foreign_org_activity", committed: false });
    expectNothingMutated(w, before, w.fake.forwarded.length);
  });
});

// ---------------------------------------------------------------- V–X: commit mode, rerun, overlap

describe("commit mode", () => {
  it("V: a read deadline in COMMIT mode leaves committed=false and writes nothing (no audit row, no state change)", async () => {
    const w = await world();
    const before = dump(w);
    sdk.overrides.getActivities = (input, n) => (n === 3 ? never() : (turnkey.fake!.getActivities as (i: unknown) => Promise<unknown>)(input));
    vi.useFakeTimers(FAKE_TIMERS);
    const report = await runUntilDeadline(w, { commit: true });
    expect(report).toEqual({ outcome: "turnkey_read_failed", reason: "head_read_error", committed: false });
    expectNothingMutated(w, before, w.fake.forwarded.length);
    expect((await w.registry.findPasskeyByCredentialId(w.b.credentialIdBase64Url))?.status).toBe("revoking");
  });

  it("W: after a deadline, a separate FRESH read-only run is still possible and redoes every read itself", async () => {
    const w = await world();
    sdk.overrides.getUsers = (_input, n) => (n === 1 ? never() : (turnkey.fake!.getUsers as (i: unknown) => Promise<unknown>)(_input));
    vi.useFakeTimers(FAKE_TIMERS);
    expect(await runUntilDeadline(w, { commit: false })).toMatchObject({ outcome: "turnkey_read_failed" });
    sdk.overrides = {};
    sdk.log = [];
    const second = await run(w, { commit: true });
    expect(second).toMatchObject({ outcome: "resolved", committed: true });
    // The second run did the whole read sequence again (walk 2, re-read 1, two snapshots 4, head 1).
    expect(sdk.log).toEqual(["getActivities", "getActivities", "getActivity", "getUsers", "getAuthenticators", "getUsers", "getAuthenticators", "getActivities"]);
    expect(w.resolution.resolutions).toHaveLength(1);
  });

  it("X: two overlapping commit runs still produce exactly ONE commit (the account-locked CAS)", async () => {
    const w = await world();
    vi.useFakeTimers(FAKE_TIMERS);
    const [x, y] = await Promise.all([run(w, { commit: true }), run(w, { commit: true })]);
    const outcomes = [x.outcome, y.outcome].sort();
    expect(outcomes.filter((o) => o === "resolved")).toHaveLength(1);
    expect(["already_resolved", "lost_race"]).toContain(outcomes.find((o) => o !== "resolved"));
    expect(w.resolution.resolutions).toHaveLength(1);
    expect([x.committed, y.committed].filter(Boolean)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------- Y, Z: structural guards

describe("structure", () => {
  const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), "utf8");

  it("Y: the S3 operator runner declares an explicit 1,200,000 ms timeout on its one test, and keeps every gate", () => {
    const source = read("test/admin/resolve-passkey-revocation.admin.test.ts");
    expect(source.match(/const S3_OPERATOR_RUNNER_TIMEOUT_MS = 1_200_000;/g)).toHaveLength(1);
    expect(source.match(/\n {2}\}, S3_OPERATOR_RUNNER_TIMEOUT_MS\);\n\}\);\n$/g)).toHaveLength(1);
    expect(source.match(/\bit\(/g)).toHaveLength(1);
    for (const gate of ["requireAdminTarget(", "requireApprovedTurnkeyHost(", "requireCommitDecision(", "requireApprovedTurnkeyConfig(", "requireCommitOutcome("]) expect(source).toContain(gate);
    expect(source).toContain('process.env.REAL_ADMIN_RESOLVE_PASSKEY_REVOCATION === "1"');
    expect(source).toContain("expect(report.committed).toBe(commit && report.outcome === \"resolved\");");
    // Scoped to this one test: no global configuration was touched.
    expect(read("vitest.config.mts")).not.toMatch(/testTimeout|hookTimeout/);
  });

  it("Z: the resolver gained no provider write, signed forwarding, retry or extra transport", () => {
    const source = stripComments(read("lib/real/server/passkey-revocation-resolver.ts"));
    for (const forbidden of [/\bforwardSignedRequest\b/, /\bfetch\s*\(/, /\/public\/v1\/submit/, /\bcreateActivityPoller\b/, /\bwhile\s*\(/, /\bretry\b/i, /\bAbortController\b/, /\bsleep\b/]) {
      expect(source).not.toMatch(forbidden);
    }
    // Exactly the four reads go through the one helper; each is called once at its adapter site.
    expect(source.match(/function withS3ReadDeadline</g)).toHaveLength(1);
    expect(source.match(/withS3ReadDeadline\(\(\) => client\.(getActivity|getActivities|getUsers|getAuthenticators)\(input\)\)/g)).toHaveLength(4);
    expect(source.match(/withS3ReadDeadline\(/g)).toHaveLength(4);
    expect(source.match(/\bclient\.\w+\(/g)).toHaveLength(4);
  });

  it("the production module's exports gain only the deadline constant", () => {
    expect(Object.keys(resolver).sort()).toEqual([
      "ACTIVITY_PAGE_LIMIT",
      "AUTHORITY_ACTIVITY_TYPES",
      "MAX_ACTIVITY_PAGES",
      "RESOLVER_VERSION",
      "S3_TURNKEY_READ_DEADLINE_MS",
      "createReadOnlyTurnkeyLedger",
      "redactReport",
      "resolveBlockedRevocation",
    ]);
    expect(resolver.S3_TURNKEY_READ_DEADLINE_MS).toBe(15_000);
  });
});
