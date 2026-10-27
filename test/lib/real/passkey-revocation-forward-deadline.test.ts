import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bytesToBase64Url } from "@/lib/real/bytes";
import type { RealServerConfig } from "@/lib/real/server/config";
import { createInMemoryRealAccountRegistry, type RealAccountRegistry } from "@/lib/real/server/registry";
import { createInMemoryPasskeyRevocationStore, type PasskeyRevocationStore } from "@/lib/real/server/passkey-revocation-attempts";
import { TURNKEY_STAMP_FRESHNESS_WINDOW_MS, forwardSignedRequest } from "@/lib/real/server/turnkey-signed-request";
import { createInMemoryProviderBudgetStore, createProviderBudgetLimiter } from "@/lib/real/server/rate-limit";
import { createFixtureAuthenticator, type FixtureAuthenticator } from "./fixtures/webauthn";
import { FakeTurnkey, signRequest } from "./fixtures/turnkey-fake";

/**
 * M3D — the single DELETE forward is bounded to a 10 s TOTAL caller wait.
 * Everything here is offline: fake timers (only setTimeout/clearTimeout, so
 * the stamp clock stays under the test's control), controlled promises and the
 * in-memory stores. A deadline proves nothing about what Turnkey did, so none
 * of these tests treats expiry as failure, absence or permission to re-send.
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

const revocation = await import("@/lib/real/server/passkey-revocation");

const ORIGIN = "http://localhost:3000";
const DELETE_URL = "https://api.turnkey.com/public/v1/submit/delete_authenticators";
const DEADLINE = revocation.REVOCATION_DELETE_FORWARD_DEADLINE_MS;
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

type FetchCall = { url: string; init: RequestInit & { body: string } };
type World = {
  registry: RealAccountRegistry;
  revocations: PasskeyRevocationStore;
  fake: FakeTurnkey;
  a: FixtureAuthenticator;
  b: FixtureAuthenticator;
  clock: { now: number };
  calls: FetchCall[];
  /** Replaced per test; every call is recorded first. */
  behavior: { current: (call: FetchCall) => Promise<Response> | Response };
  deps: { fetchImpl: typeof fetch; now: () => number; sleep: () => Promise<void>; maxPolls: number };
};

/** An account with two ACTIVE, Turnkey-mapped passkeys: A (the session survivor) and B (the removal target). */
async function world(): Promise<World> {
  const registry = createInMemoryRealAccountRegistry();
  const a = createFixtureAuthenticator();
  const b = createFixtureAuthenticator();
  await registry.createAccountWithPasskey({
    account: {
      appUserId: "app-user-1",
      subOrganizationId: "sub-org-1",
      turnkeyUserId: "turnkey-user-1",
      walletId: "wallet-1",
      walletAccountId: "wallet-account-1",
      ownerAddress: "0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF",
      safeAddress: "0xd9a4c22fb34dc74317edc8006140d66c8fa03266",
      accountConfigVersion: 1,
    },
    passkey: { credentialId: a.credentialIdBase64Url, appUserId: "app-user-1", credentialPublicKey: bytesToBase64Url(a.publicKeyCose), userHandle: "handle-a", counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false },
  });
  const enrollmentStore = (await import("@/lib/real/server/backup-passkey-enrollment")).createInMemoryBackupPasskeyEnrollmentStore(registry);
  const enrollment = (await enrollmentStore.createStarted({ appUserId: "app-user-1" }))!;
  await enrollmentStore.transition({ id: enrollment.id, from: "started", to: "started", patch: { registrationMintId: "mint-1" } });
  await enrollmentStore.registerCredential({
    id: enrollment.id,
    credential: { credentialId: b.credentialIdBase64Url, userHandle: "handle-b", credentialPublicKey: bytesToBase64Url(b.publicKeyCose), counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false, registrationChallenge: "c", rawClientDataJson: "d", rawAttestationObject: "e", stepUpCredentialId: "step-up-credential", registrationMintId: "mint-1" },
  });
  await registry.transitionPasskeyStatus({ credentialId: a.credentialIdBase64Url, from: "active", to: "active", patch: { turnkeyAuthenticatorId: "authenticator-a" } });
  await registry.transitionPasskeyStatus({ credentialId: b.credentialIdBase64Url, from: "pending", to: "active", patch: { turnkeyAuthenticatorId: "authenticator-b" } });

  const fake = new FakeTurnkey("sub-org-1", "turnkey-user-1");
  fake.addAuthenticator(a.credentialIdBase64Url, "authenticator-a");
  fake.addAuthenticator(b.credentialIdBase64Url, "authenticator-b");
  turnkey.fake = fake;
  const clock = { now: Date.now() };
  const calls: FetchCall[] = [];
  const behavior: World["behavior"] = { current: (call) => fake.fetchImpl(call.url, call.init as never) as Promise<Response> };
  const fetchImpl = ((url: string, init: FetchCall["init"]) => {
    const call = { url, init };
    calls.push(call);
    return behavior.current(call);
  }) as unknown as typeof fetch;
  return { registry, revocations: createInMemoryPasskeyRevocationStore(registry), fake, a, b, clock, calls, behavior, deps: { fetchImpl, now: () => clock.now, sleep: async () => {}, maxPolls: 1 } };
}

async function prepareAndSign(w: World, opts: { mutate?: (a: Record<string, unknown>) => void } = {}) {
  const prepared = await revocation.prepareRevocation({ config, registry: w.registry, revocations: w.revocations, appUserId: "app-user-1", credentialId: w.b.credentialIdBase64Url, sessionCredentialId: w.a.credentialIdBase64Url, now: () => w.clock.now });
  if (prepared.outcome !== "ready") throw new Error(JSON.stringify(prepared));
  const activity = JSON.parse(JSON.stringify(prepared.activity)) as Record<string, unknown>;
  opts.mutate?.(activity);
  return { attemptId: prepared.attemptId, signed: signRequest({ authenticator: w.a, activity, url: DELETE_URL, origin: ORIGIN, rpId: config.rpId }) };
}

function submit(w: World, attemptId: string, signedRequest: unknown) {
  return revocation.submitRevocation({ config, registry: w.registry, revocations: w.revocations, appUserId: "app-user-1", credentialId: w.b.credentialIdBase64Url, attemptId, sessionCredentialId: w.a.credentialIdBase64Url, signedRequest, deps: w.deps });
}

function reconcile(w: World, attemptId: string) {
  return revocation.reconcileRevocation({
    config,
    registry: w.registry,
    revocations: w.revocations,
    appUserId: "app-user-1",
    credentialId: w.b.credentialIdBase64Url,
    attemptId,
    providerBudgetLimiter: createProviderBudgetLimiter(createInMemoryProviderBudgetStore()),
    deps: w.deps,
  });
}

const status = async (w: World) => (await w.registry.findPasskeyByCredentialId(w.b.credentialIdBase64Url))?.status;
const activityResponse = (id: string) => new Response(JSON.stringify({ activity: { id, status: "ACTIVITY_STATUS_PENDING", type: "ACTIVITY_TYPE_DELETE_AUTHENTICATORS", organizationId: "sub-org-1" } }), { status: 200 });
/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
/** Tracks settlement without awaiting (so a hang is observable, not a test timeout). */
function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => ((state.settled = true), (state.value = value)),
    (error) => ((state.settled = true), (state.error = error)),
  );
  return state;
}
/** Lets already-queued microtasks run without moving the fake clock. */
const flush = () => vi.advanceTimersByTimeAsync(0);
/** Real macrotask turns (not the fake clock): lets promise chains and stores fully settle. */
const macrotasks = async (turns = 5) => {
  for (let i = 0; i < turns; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};
/** Bounded wait on real macrotasks for a tracked promise to settle. The fake clock never moves here, so a forward with no deadline still fails (it never settles). */
async function until(state: { settled: boolean }) {
  for (let i = 0; i < 2_000 && !state.settled; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}
/** Waits (on real macrotasks, never the fake clock) until the Nth forward has been issued: stamp verification is genuinely asynchronous. */
async function forwarded(w: World, count = 1) {
  for (let i = 0; i < 2_000 && w.calls.length < count; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  expect(w.calls.length).toBeGreaterThanOrEqual(count);
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => void unhandled.push(reason);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  vi.useRealTimers();
  turnkey.fake = null;
});

describe("DELETE forward deadline — total caller wait", () => {
  it("the deadline is the approved provisional 10,000 ms", () => {
    expect(DEADLINE).toBe(10_000);
  });

  it("A/J: a forward that never answers (and ignores abort) ends the caller's wait at exactly 10,000 ms — one forward, no second send", async () => {
    const w = await world();
    const hang = deferred<Response>(); // never settled: models a transport that ignores the abort signal
    w.behavior.current = () => hang.promise;
    const { attemptId, signed } = await prepareAndSign(w);

    const result = track(submit(w, attemptId, signed));
    await forwarded(w);
    expect(w.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(DEADLINE - 1);
    expect(result.settled).toBe(false);
    expect(w.calls[0]!.init.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await until(result);
    expect(result.settled).toBe(true);
    expect(result.error).toBeUndefined();
    // Inside the signed-request window with no activity id: the existing pending answer.
    expect(result.value).toMatchObject({ outcome: "pending" });
    expect(w.calls[0]!.init.signal?.aborted).toBe(true); // asked politely; the transport above never listened
    expect(w.calls).toHaveLength(1);
    // Waiting longer sends nothing.
    await vi.advanceTimersByTimeAsync(10 * DEADLINE);
    expect(w.calls).toHaveLength(1);
    expect(w.fake.forwarded).toHaveLength(0);
  });

  it("T: no deadline timer is left behind after a timeout or after an answer", async () => {
    const w = await world();
    w.behavior.current = () => new Promise<Response>(() => {});
    const { attemptId, signed } = await prepareAndSign(w);
    const result = track(submit(w, attemptId, signed));
    await forwarded(w);
    await vi.advanceTimersByTimeAsync(DEADLINE);
    await until(result);
    expect(result.settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    const w2 = await world();
    const prepared = await prepareAndSign(w2);
    const second = track(submit(w2, prepared.attemptId, prepared.signed));
    for (let i = 0; i < 2_000 && !second.settled; i += 1) await macrotasks(1); // stamp verification is genuinely asynchronous
    await until(second);
    expect(second.settled).toBe(true); // the in-memory Turnkey answers at once
    expect(vi.getTimerCount()).toBe(0);
  });

  it("B: a valid answer arriving just before the deadline is used and its timer is cleared", async () => {
    const w = await world();
    const gate = deferred<Response>();
    w.behavior.current = () => gate.promise;
    const { attemptId, signed } = await prepareAndSign(w);
    const result = track(submit(w, attemptId, signed));
    await forwarded(w);
    await vi.advanceTimersByTimeAsync(DEADLINE - 1);
    expect(result.settled).toBe(false);
    gate.resolve(activityResponse("activity-early"));
    await macrotasks();
    await until(result);
    expect(result.settled).toBe(true);
    expect((await w.revocations.findById(attemptId))?.turnkeyActivityId).toBe("activity-early");
    expect(w.calls[0]!.init.signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(w.calls).toHaveLength(1);
  });

  it("C/N: a late success after the deadline is discarded — no activity recorded, no state change", async () => {
    const w = await world();
    const gate = deferred<Response>();
    w.behavior.current = () => gate.promise;
    const record = vi.spyOn(w.revocations, "recordActivity");
    const transition = vi.spyOn(w.revocations, "transition");
    const { attemptId, signed } = await prepareAndSign(w);
    const result = track(submit(w, attemptId, signed));
    await forwarded(w);
    await vi.advanceTimersByTimeAsync(DEADLINE);
    await until(result);
    expect(result.settled).toBe(true);
    const before = await w.revocations.findById(attemptId);
    const transitionsBefore = transition.mock.calls.length;

    gate.resolve(activityResponse("activity-late"));
    await macrotasks();
    await vi.advanceTimersByTimeAsync(DEADLINE);
    expect(record).not.toHaveBeenCalled();
    expect(transition.mock.calls).toHaveLength(transitionsBefore);
    expect(await w.revocations.findById(attemptId)).toEqual(before);
    expect((await w.revocations.findById(attemptId))?.turnkeyActivityId).toBeNull();
    expect(await status(w)).toBe("revoking"); // never restored, never marked removed
    expect(w.calls).toHaveLength(1);
  });

  it("S: a late rejection after the deadline raises no unhandled rejection", async () => {
    const w = await world();
    const gate = deferred<Response>();
    w.behavior.current = () => gate.promise;
    const { attemptId, signed } = await prepareAndSign(w);
    const result = track(submit(w, attemptId, signed));
    await forwarded(w);
    await vi.advanceTimersByTimeAsync(DEADLINE);
    await until(result);
    expect(result.settled).toBe(true);
    gate.reject(new Error("socket hang up"));
    await macrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it("I: headers arrive but the body never finishes — the caller still settles at the total deadline", async () => {
    const w = await world();
    w.behavior.current = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) as unknown as Response;
    const { attemptId, signed } = await prepareAndSign(w);
    const result = track(submit(w, attemptId, signed));
    await forwarded(w);
    await vi.advanceTimersByTimeAsync(DEADLINE - 1);
    expect(result.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await until(result);
    expect(result.settled).toBe(true);
    expect(result.value).toMatchObject({ outcome: "pending" });
    expect((await w.revocations.findById(attemptId))?.turnkeyActivityId).toBeNull();
    expect(w.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the deadline starts when the forward starts: time spent before the claim and send is not counted against it", async () => {
    const w = await world();
    w.behavior.current = () => new Promise<Response>(() => {});
    const { attemptId, signed } = await prepareAndSign(w);
    // Time passing before submit begins (e.g. the user's tab) has no timer to fire.
    await vi.advanceTimersByTimeAsync(5 * DEADLINE);
    const result = track(submit(w, attemptId, signed));
    await forwarded(w);
    expect(w.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(DEADLINE - 1);
    expect(result.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await until(result);
    expect(result.settled).toBe(true);
  });
});

describe("DELETE forward deadline — existing no_activity semantics are unchanged", () => {
  const cases: Array<[string, (call: FetchCall) => Promise<Response> | Response]> = [
    ["D: an immediate network rejection", () => Promise.reject(new Error("network"))],
    [
      "E: a synchronous fetch exception",
      () => {
        throw new Error("sync boom");
      },
    ],
    ["F: a non-2xx answer (even one that carries an activity)", () => new Response(JSON.stringify({ activity: { id: "a1", status: "x" } }), { status: 500 })],
    ["G: a malformed JSON answer", () => new Response("not json", { status: 200 })],
    ["H: an answer without an activity id", () => new Response(JSON.stringify({ activity: { status: "x" } }), { status: 200 })],
  ];

  it.each(cases)("%s → pending with no activity id, one forward, nothing recorded, no timer left", async (_label, behavior) => {
    const w = await world();
    w.behavior.current = behavior;
    const record = vi.spyOn(w.revocations, "recordActivity");
    const { attemptId, signed } = await prepareAndSign(w);
    const result = await submit(w, attemptId, signed);
    expect(result).toMatchObject({ outcome: "pending" });
    expect(w.calls).toHaveLength(1);
    expect(record).not.toHaveBeenCalled();
    const attempt = await w.revocations.findById(attemptId);
    expect(attempt).toMatchObject({ state: "dispatch_in_flight", turnkeyActivityId: null });
    expect(await status(w)).toBe("revoking");
    expect(vi.getTimerCount()).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it("N: a normal authorized DELETE is forwarded once, byte for byte, with the original stamp and no parent credential", async () => {
    const w = await world();
    const { attemptId, signed } = await prepareAndSign(w);
    const result = await submit(w, attemptId, signed);
    expect(result.outcome).toBe("revoked");
    expect(w.calls).toHaveLength(1);
    const { url, init } = w.calls[0]!;
    expect(url).toBe(DELETE_URL);
    expect(init.body).toBe(signed.body);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Stamp-Webauthn"]).toBe(signed.stamp.stampHeaderValue);
    expect(Object.keys(headers).sort()).toEqual(["Content-Type", "X-Stamp-Webauthn"]);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
    expect(await status(w)).toBe("revoked");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("DELETE forward deadline — R0 single forward", () => {
  it("K: two concurrent submits of the same removal forward exactly once", async () => {
    const w = await world();
    const gate = deferred<Response>();
    w.behavior.current = () => gate.promise;
    const { attemptId, signed } = await prepareAndSign(w);
    const first = track(submit(w, attemptId, signed));
    const second = track(submit(w, attemptId, signed));
    await forwarded(w);
    expect(w.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(DEADLINE);
    await until(first);
    await until(second);
    expect(first.settled && second.settled).toBe(true);
    const outcomes = [first.value, second.value].map((r) => r?.outcome).sort();
    expect(outcomes).toEqual(["pending", "rejected"]);
    expect(w.calls).toHaveLength(1);
  });

  it("a later submit of the same signed bytes after the timeout is refused and sends nothing", async () => {
    const w = await world();
    w.behavior.current = () => new Promise<Response>(() => {});
    const { attemptId, signed } = await prepareAndSign(w);
    const first = track(submit(w, attemptId, signed));
    await forwarded(w);
    await vi.advanceTimersByTimeAsync(DEADLINE);
    await until(first);
    expect(first.settled).toBe(true);
    const again = await submit(w, attemptId, signed);
    expect(again.outcome).toBe("rejected");
    expect(w.calls).toHaveLength(1);
  });

  it("L/M: reconcile after a timeout never re-sends the DELETE; once the window closes it is the existing blocked / no_activity_receipt", async () => {
    const w = await world();
    w.behavior.current = () => new Promise<Response>(() => {});
    const { attemptId, signed } = await prepareAndSign(w);
    const first = track(submit(w, attemptId, signed));
    await forwarded(w);
    await vi.advanceTimersByTimeAsync(DEADLINE);
    await until(first);
    expect(first.settled).toBe(true);

    expect((await reconcile(w, attemptId)).outcome).toBe("pending");
    expect(w.calls).toHaveLength(1);
    expect(await status(w)).toBe("revoking");

    w.clock.now += TURNKEY_STAMP_FRESHNESS_WINDOW_MS + 1;
    expect((await reconcile(w, attemptId)).outcome).toBe("blocked");
    expect(await w.revocations.findById(attemptId)).toMatchObject({ state: "blocked", failureReason: "no_activity_receipt", turnkeyRequestStamp: null, turnkeyActivityId: null });
    expect(await status(w)).toBe("revoking"); // not restored to active, not claimed removed
    expect(w.calls).toHaveLength(1);
    expect(w.fake.forwarded).toHaveLength(0);
  });

  it("a signed window that closes while waiting makes the timed-out submit itself end as blocked / no_activity_receipt — still one forward", async () => {
    const w = await world();
    w.behavior.current = () => new Promise<Response>(() => {});
    const { attemptId, signed } = await prepareAndSign(w);
    // Signed 5 s short of the window edge, so the 10 s wait outlasts it.
    w.clock.now += TURNKEY_STAMP_FRESHNESS_WINDOW_MS - 5_000;
    const result = track(submit(w, attemptId, signed));
    await forwarded(w);
    w.clock.now += DEADLINE;
    await vi.advanceTimersByTimeAsync(DEADLINE);
    await until(result);
    expect(result.settled).toBe(true);
    expect(result.value).toMatchObject({ outcome: "blocked" });
    expect(await w.revocations.findById(attemptId)).toMatchObject({ state: "blocked", failureReason: "no_activity_receipt" });
    expect(w.calls).toHaveLength(1);
  });

  it("a timed-out removal is not retried by a browser reload / new submit with a fresh signature for the same attempt", async () => {
    const w = await world();
    w.behavior.current = () => new Promise<Response>(() => {});
    const { attemptId, signed } = await prepareAndSign(w);
    const first = track(submit(w, attemptId, signed));
    await forwarded(w);
    await vi.advanceTimersByTimeAsync(DEADLINE);
    await until(first);
    expect(first.settled).toBe(true);
    const fresh = signRequest({ authenticator: w.a, activity: JSON.parse(signed.body), url: DELETE_URL, origin: ORIGIN, rpId: config.rpId });
    expect((await submit(w, attemptId, fresh)).outcome).toBe("rejected");
    expect(w.calls).toHaveLength(1);
  });
});

describe("DELETE forward deadline — authorization is unchanged and runs before any forward or timer", () => {
  it.each([
    ["a different target authenticator", (a: Record<string, unknown>) => ((a.parameters as Record<string, unknown>).authenticatorIds = ["authenticator-a"])],
    ["a different Turnkey user", (a: Record<string, unknown>) => ((a.parameters as Record<string, unknown>).userId = "someone-else")],
    ["a different organization", (a: Record<string, unknown>) => (a.organizationId = "other-org")],
    ["a different activity type", (a: Record<string, unknown>) => (a.type = "ACTIVITY_TYPE_CREATE_AUTHENTICATORS_V2")],
    ["an extra parameter", (a: Record<string, unknown>) => ((a.parameters as Record<string, unknown>).extra = true)],
  ])("O: %s is refused — nothing is forwarded, no timer started, no claim made", async (_label, mutate) => {
    const w = await world();
    w.behavior.current = () => new Promise<Response>(() => {});
    const { attemptId, signed } = await prepareAndSign(w, { mutate });
    const result = await submit(w, attemptId, signed);
    expect(result.outcome).toBe("rejected");
    expect(w.calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(await w.revocations.findById(attemptId)).toMatchObject({ state: "authorization_needed" });
    expect(await status(w)).toBe("active");
  });

  it("O: a stamp not made by the session credential is refused before any forward or timer", async () => {
    const w = await world();
    w.behavior.current = () => new Promise<Response>(() => {});
    const prepared = await revocation.prepareRevocation({ config, registry: w.registry, revocations: w.revocations, appUserId: "app-user-1", credentialId: w.b.credentialIdBase64Url, sessionCredentialId: w.a.credentialIdBase64Url, now: () => w.clock.now });
    if (prepared.outcome !== "ready") throw new Error("setup");
    const forged = signRequest({ authenticator: createFixtureAuthenticator({ credentialId: w.a.credentialId }), activity: prepared.activity, url: DELETE_URL, origin: ORIGIN, rpId: config.rpId });
    expect((await submit(w, prepared.attemptId, forged)).outcome).toBe("rejected");
    expect(w.calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an expired signed request is refused before any forward or timer", async () => {
    const w = await world();
    const { attemptId, signed } = await prepareAndSign(w);
    w.clock.now += TURNKEY_STAMP_FRESHNESS_WINDOW_MS + 1;
    expect((await submit(w, attemptId, signed)).outcome).toBe("rejected");
    expect(w.calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("P/Q: submit has no budget of its own, and a timeout adds no provider write, read or signing step", async () => {
    const source = readFileSync(join(process.cwd(), "lib/real/server/passkey-revocation.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const submitBody = code.slice(code.indexOf("export async function submitRevocation"), code.indexOf("function isPresent"));
    expect(submitBody).not.toMatch(/providerBudgetLimiter|consume\w*Budget|rate_limited/);
    expect(submitBody).toMatch(/reconcileRevocationCore\(input, ALREADY_ADMITTED\)/);

    const w = await world();
    w.behavior.current = () => new Promise<Response>(() => {});
    const { attemptId, signed } = await prepareAndSign(w);
    const getUsers = vi.spyOn(w.fake, "getUsers");
    const getActivity = vi.spyOn(w.fake, "getActivity");
    const result = track(submit(w, attemptId, signed));
    await forwarded(w);
    await vi.advanceTimersByTimeAsync(DEADLINE);
    await until(result);
    expect(result.settled).toBe(true);
    // The internal reconcile had no activity id, so it made no Turnkey read; the only network call was the one forward.
    expect(getUsers).not.toHaveBeenCalled();
    expect(getActivity).not.toHaveBeenCalled();
    expect(w.calls).toHaveLength(1);
  });
});

describe("DELETE forward deadline — CREATE is untouched", () => {
  const endpointInput = (fetchImpl: typeof fetch, deadlineMs?: number) => ({
    config,
    endpoint: "create_authenticators" as const,
    body: "{}",
    stamp: { stampHeaderName: "X-Stamp-Webauthn", stampHeaderValue: '{"x":1}' },
    fetchImpl,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  });

  it("R: with no deadline the forward is the original unbounded call — the very fetch passed in, no abort signal, no timer, no early settle", async () => {
    const gate = deferred<Response>();
    const inits: Array<RequestInit | undefined> = [];
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => (inits.push(init), gate.promise));
    const result = track(forwardSignedRequest(endpointInput(fetchImpl as unknown as typeof fetch)));
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(inits[0]).not.toHaveProperty("signal");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(result.settled).toBe(false); // still waiting, as before: CREATE has no deadline
    gate.resolve(activityResponse("late-create"));
    await macrotasks();
    expect(result.value).toMatchObject({ kind: "activity", activity: { id: "late-create" } });
  });

  it("R: static guard — only the DELETE call site passes a deadline; both CREATE forwards (first send and the one claimed replay) pass none", () => {
    const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const pipeline = read("lib/real/server/backup-passkey-pipeline.ts");
    const calls = [...pipeline.matchAll(/\bforwardSignedRequest\s*\(([\s\S]*?)\);/g)];
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call[1]).toContain('"create_authenticators"');
    expect(pipeline).not.toMatch(/deadline/i);
    expect(pipeline).not.toMatch(/REVOCATION_DELETE_FORWARD_DEADLINE_MS/);

    const revocationSource = read("lib/real/server/passkey-revocation.ts");
    const deleteCalls = [...revocationSource.matchAll(/\bforwardSignedRequest\s*\(([\s\S]*?)\}\);/g)];
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]![1]).toMatch(/endpoint: "delete_authenticators"/);
    expect(deleteCalls[0]![1]).toMatch(/deadlineMs: REVOCATION_DELETE_FORWARD_DEADLINE_MS/);

    // No other module reaches the bounded form, and the shared function has no default bound.
    const shared = read("lib/real/server/turnkey-signed-request.ts");
    expect(shared).not.toMatch(/deadlineMs\s*=\s*\d|deadlineMs\s*\?\?\s*\d|DEFAULT_\w*DEADLINE/);
  });

  it("an invalid bound throws before anything is sent — it can never silently become 'no deadline'", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const fetchImpl = vi.fn();
      await expect(forwardSignedRequest(endpointInput(fetchImpl as unknown as typeof fetch, bad))).rejects.toBeInstanceOf(RangeError);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
