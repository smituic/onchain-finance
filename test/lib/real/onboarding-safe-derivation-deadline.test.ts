// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { BaseError, createPublicClient, custom, encodeAbiParameters, getAddress, toFunctionSelector, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { createRealSafeAccount } from "@/lib/real/account/safe";
import { REAL_ACCOUNT_CONFIG_VERSION, REAL_SAFE } from "@/lib/real/constants";
import { createVerifiedTurnkeyOwnerAccount } from "@/lib/real/signing/verified-account";
import { bytesToBase64Url, randomBytes } from "@/lib/real/bytes";
import type { RealServerConfig } from "@/lib/real/server/config";
import { createInMemoryChallengeStore, type ChallengeStore } from "@/lib/real/server/challenge-store";
import { createInMemoryLoginChallengeUseStore, type LoginChallengeUseStore } from "@/lib/real/server/login-challenge-uses";
import { GENERIC_SERVER_ERROR_MESSAGE } from "@/lib/real/server/http";
import { createInMemoryRealAccountRegistry, type RealAccountRegistry } from "@/lib/real/server/registry";
import { createInMemoryRegistrationAttemptStore, type RegistrationAttempt, type RegistrationAttemptStore } from "@/lib/real/server/registration-attempts";
import { parseSession } from "@/lib/real/server/session";
import { buildAuthenticationResponseJSON, buildRegistrationResponseJSON, createFixtureAuthenticator, type FixtureAuthenticator } from "./fixtures/webauthn";
import { FAKE_OWNER_ADDRESS, FakeParentTurnkey } from "./fixtures/turnkey-parent-fake";
import { claimWithEvidence, seedTurnkeyCreatedThroughEvidence } from "./fixtures/provisioning-seed";

/**
 * M3D — Onboarding Safe-address derivation caller deadline (15 000 ms) in
 * lib/real/server/onboarding.ts's runProvisioningPipeline.
 *
 * The REAL onboarding pipeline, the REAL registration and login flows, the
 * REAL in-memory attempt store / registry / challenge and login-marker stores,
 * and the REAL installed permissionless Safe derivation (toSafeSmartAccount →
 * one proxyCreationCode eth_call) run unmodified. Only the network is faked:
 *   - the chain through a viem `custom` transport (retryCount 0 — the test's
 *     own client, not production's) that logs every request, answers only
 *     eth_call, and can hold or fail each read on a deterministic gate;
 *   - lib/real/chain/client's createRealPublicClient (used only when no client
 *     is injected, as in production and in the route tests) is replaced by a
 *     recorder that returns that same controlled client — it never builds an
 *     HTTP client — and can throw synchronously on request;
 *   - Turnkey through the existing FakeParentTurnkey deps (no network);
 *   - a global `fetch` that records and refuses every call.
 * The deadline itself is never mocked. setTimeout / clearTimeout are faked
 * (setImmediate stays real to drain the event loop); a process
 * `unhandledRejection` listener, the refused-request log and the fetch guard
 * are checked after every test. No real RPC, Turnkey, database or browser.
 */

const DEADLINE_MS = 15_000; // the approved value, written out — never imported from the code under test
const DEADLINE_MESSAGE = "The account address could not be derived in time.";
const ORIGIN = "http://localhost:3000";
const config: RealServerConfig = {
  turnkeyApiBaseUrl: "https://api.turnkey.com",
  turnkeyParentOrganizationId: "parent-org",
  turnkeyApiPublicKey: "pub",
  turnkeyApiPrivateKey: "priv",
  sessionSecret: "4be1c0d27a9f3e8d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170605", // strong, so the real route config accepts it too
  rpId: "localhost",
  rpName: "Test",
  expectedOrigins: [ORIGIN],
  rpcUrl: "https://rpc.example.invalid/secret-key-123",
  pimlicoApiKey: "pim_test_key",
};
const UNKNOWN_REGISTRATION = { outcome: "rejected", reason: "Unknown, expired, or already-used registration challenge." } as const;
const UNKNOWN_LOGIN = { outcome: "rejected", reason: "Unknown, expired, or already-used login challenge." } as const;
const PROXY_CREATION_CODE_SELECTOR = toFunctionSelector("proxyCreationCode()");
const PROXY_CREATION_CODE_RETURN = encodeAbiParameters([{ type: "bytes" }], ["0x600a600c600039600a6000f3" as Hex]);

// ---- module seams (hoisted) -------------------------------------------------

const factory = vi.hoisted(() => ({
  calls: [] as Array<{ rpcUrl: string; timersAtCall: number }>,
  throwSync: null as unknown,
  client: null as unknown,
}));
vi.mock("@/lib/real/chain/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/real/chain/client")>();
  return {
    ...actual,
    createRealPublicClient: (rpcUrl: string) => {
      factory.calls.push({ rpcUrl, timersAtCall: vi.getTimerCount() });
      if (factory.throwSync !== null) throw factory.throwSync;
      if (!factory.client) throw new Error("test: no controlled client configured");
      return factory.client;
    },
  };
});

const route = vi.hoisted(() => ({
  challengeStore: null as unknown,
  registry: null as unknown,
  attempts: null as unknown,
  loginChallengeUses: null as unknown,
  provisioningDeps: null as unknown,
  cookieSets: [] as unknown[],
}));
vi.mock("@/lib/real/server/runtime", () => ({
  getChallengeStore: () => route.challengeStore,
  getRealAccountRegistry: () => route.registry,
  getRegistrationAttemptStore: () => route.attempts,
  getLoginChallengeUses: () => route.loginChallengeUses,
  getAccountHandleStore: () => {
    throw new Error("test: the handle store is not reachable on these paths");
  },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: (...args: unknown[]) => route.cookieSets.push(args), delete: () => undefined }) }));
// The register route passes no Turnkey deps; inject the fake's (pass-through otherwise).
vi.mock("@/lib/real/server/registration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/real/server/registration")>();
  return {
    ...actual,
    completeRegistration: (input: Parameters<typeof actual.completeRegistration>[0]) =>
      actual.completeRegistration({ ...input, provisioningDeps: input.provisioningDeps ?? (route.provisioningDeps as typeof input.provisioningDeps) }),
  };
});

const { OnboardingSafeDerivationDeadlineError, runProvisioningPipeline } = await import("@/lib/real/server/onboarding");
const { beginRegistration, completeRegistration } = await import("@/lib/real/server/registration");
const { beginLogin, completeLogin } = await import("@/lib/real/server/login");
const registerRoute = await import("@/app/api/real/account/register/verify/route");
const loginRoute = await import("@/app/api/real/account/login/verify/route");

// ---- controlled chain --------------------------------------------------------

type Mode = "answer" | "hold" | "fail";
type Gate = { resolve: () => void; reject: (error: unknown) => void };
type Epoch = "before" | "late";
let epoch: Epoch = "before";
const chainLog: Array<{ method: string; params: unknown; epoch: Epoch; timersAtRequest: number }> = [];
const gates: Gate[] = [];
const refused: string[] = [];
let modes: Mode[] = [];
let failWith: unknown = null;

function controlledClient() {
  return createPublicClient({
    chain: baseSepolia,
    transport: custom(
      {
        request: async ({ method, params }: { method: string; params?: unknown }) => {
          chainLog.push({ method, params, epoch, timersAtRequest: vi.getTimerCount() });
          if (method !== "eth_call") {
            refused.push(`chain ${method}`);
            throw new Error(`Unexpected chain request in an offline test: ${method}`);
          }
          const mode = modes.shift() ?? "answer";
          if (mode === "fail") throw failWith;
          if (mode === "hold") {
            return new Promise<Hex>((resolve, reject) => gates.push({ resolve: () => resolve(PROXY_CREATION_CODE_RETURN), reject }));
          }
          return PROXY_CREATION_CODE_RETURN;
        },
      },
      { retryCount: 0 },
    ),
  });
}

const fetchGuard = vi.fn(async (url: unknown) => {
  refused.push(`fetch ${String(url)}`);
  throw new Error("Unexpected network access in an offline test.");
});

// ---- harness -----------------------------------------------------------------

type Settled = { status: "pending" | "fulfilled" | "rejected"; value?: unknown; error?: unknown };
function observe<T>(promise: Promise<T>): Settled & { value?: T } {
  const observed: Settled & { value?: T } = { status: "pending" };
  promise.then(
    (value) => {
      observed.status = "fulfilled";
      observed.value = value;
    },
    (error: unknown) => {
      observed.status = "rejected";
      observed.error = error;
    },
  );
  return observed;
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
async function drain(turns = 30) {
  for (let i = 0; i < turns; i += 1) await flush();
}
async function flushUntil(condition: () => boolean, label: string) {
  for (let i = 0; i < 3_000; i += 1) {
    if (condition()) return;
    await flush();
  }
  throw new Error(`never reached: ${label}`);
}
const advance = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
};

let setTimeoutSpy: MockInstance<typeof setTimeout>;
/** Every timer armed with the derivation deadline's delay. Turnkey's own request timers use 10 000 / 5 000 / 3 000. */
const derivationTimersArmed = () => setTimeoutSpy.mock.calls.filter((call) => call[1] === DEADLINE_MS).length;

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(() => {
  epoch = "before";
  chainLog.length = 0;
  gates.length = 0;
  refused.length = 0;
  modes = [];
  failWith = null;
  factory.calls.length = 0;
  factory.throwSync = null;
  factory.client = controlledClient();
  route.challengeStore = null;
  route.registry = null;
  route.attempts = null;
  route.loginChallengeUses = null;
  route.provisioningDeps = null;
  route.cookieSets.length = 0;
  fetchGuard.mockClear();
  vi.stubGlobal("fetch", fetchGuard);
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await drain(5);
  process.off("unhandledRejection", onUnhandled);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  expect(unhandled).toEqual([]);
  expect(refused).toEqual([]);
  expect(fetchGuard).not.toHaveBeenCalled();
});

/** Fires the deadline: everything after is "late". */
async function expire(elapsed = 0) {
  await advance(DEADLINE_MS - elapsed);
  epoch = "late";
}

function expectDeadline(observed: Settled) {
  expect(observed.status).toBe("rejected");
  expect(observed.value).toBeUndefined();
  const error = observed.error as Error;
  expect(error).toBeInstanceOf(OnboardingSafeDerivationDeadlineError);
  expect(error.name).toBe("OnboardingSafeDerivationDeadlineError");
  expect(error.message).toBe(DEADLINE_MESSAGE);
}

/** The honest Safe address for an owner, derived directly (no deadline helper) from the same inputs and the same answer. */
async function expectedSafeAddress(attempt: { ownerAddress: string; subOrganizationId: string }) {
  const owner = createVerifiedTurnkeyOwnerAccount({ rpId: config.rpId, subOrganizationId: attempt.subOrganizationId, ownerAddress: attempt.ownerAddress });
  const honest = createPublicClient({ chain: baseSepolia, transport: custom({ request: async () => PROXY_CREATION_CODE_RETURN }, { retryCount: 0 }) });
  return (await createRealSafeAccount({ owner, publicClient: honest })).address;
}

// ---- worlds ------------------------------------------------------------------

let seq = 0;
type World = {
  registry: RealAccountRegistry;
  attempts: RegistrationAttemptStore;
  challengeStore: ChallengeStore;
  loginChallengeUses: LoginChallengeUseStore;
  turnkey: FakeParentTurnkey;
  /** A pass-through spy on the store's real finalize (counts every call, by anyone). */
  finalize: ReturnType<typeof vi.spyOn>;
  realFinalize: RegistrationAttemptStore["finalize"];
};
function world(): World {
  const registry = createInMemoryRealAccountRegistry();
  const attempts = createInMemoryRegistrationAttemptStore();
  const realFinalize = attempts.finalize.bind(attempts);
  const finalize = vi.spyOn(attempts, "finalize");
  return { registry, attempts, challengeStore: createInMemoryChallengeStore(), loginChallengeUses: createInMemoryLoginChallengeUseStore(), turnkey: new FakeParentTurnkey(), finalize, realFinalize };
}

/** A durable "turnkey_created" attempt, walked through the store's own evidence-bound transitions. */
async function seedTurnkeyCreated(w: World): Promise<RegistrationAttempt> {
  seq += 1;
  const credentialId = bytesToBase64Url(randomBytes(16));
  await w.attempts.createVerified({
    credentialId,
    appUserId: `app-user-${seq}`,
    userHandle: `handle-${seq}`,
    credentialPublicKey: `cose-${seq}`,
    counter: 0,
    transports: ["internal"],
    credentialDeviceType: "singleDevice",
    credentialBackedUp: false,
    registrationChallenge: `challenge-${seq}`,
    rawClientDataJson: "client-data",
    rawAttestationObject: "attestation",
  });
  return seedTurnkeyCreatedThroughEvidence(w.attempts, credentialId, {
    subOrganizationId: `sub-org-${seq}`,
    turnkeyUserId: `turnkey-user-${seq}`,
    walletId: `wallet-${seq}`,
    walletAccountId: `wallet-account-${seq}`,
    ownerAddress: getAddress(`0x${String(seq).padStart(40, "b")}`),
  });
}

const pipeline = (w: World, attempt: RegistrationAttempt, inject = true) =>
  runProvisioningPipeline({ config, registry: w.registry, attempts: w.attempts, attempt, publicClient: inject ? controlledClient() : undefined, provisioningDeps: w.turnkey.deps() });

async function expectNothingActivated(w: World, attempt: RegistrationAttempt) {
  expect(await w.registry.findAccountByAppUserId(attempt.appUserId)).toBeNull();
  expect(await w.registry.findPasskeyByCredentialId(attempt.credentialId)).toBeNull();
}

// ---------------------------------------------------------------------------
// A–C, P: the honest path is unchanged
// ---------------------------------------------------------------------------

describe("honest derivation — same address, same single read, finalize unchanged", () => {
  it("A/B/C: a turnkey_created attempt derives the same Safe as a direct derivation from one proxyCreationCode eth_call, finalizes with it, and leaves no timer", async () => {
    const w = world();
    const attempt = await seedTurnkeyCreated(w);
    const expected = await expectedSafeAddress({ ownerAddress: attempt.ownerAddress!, subOrganizationId: attempt.subOrganizationId! });

    const result = await pipeline(w, attempt);

    expect(result.outcome).toBe("verified");
    if (result.outcome !== "verified") return;
    expect(result.account.safeAddress).toBe(expected);
    expect(result.account.ownerAddress).toBe(attempt.ownerAddress);
    expect(result.account.subOrganizationId).toBe(attempt.subOrganizationId);
    // finalize: called once, with exactly the derived Safe and the original owner identity.
    expect(w.finalize).toHaveBeenCalledTimes(1);
    expect(w.finalize.mock.calls[0]![0]).toEqual({ credentialId: attempt.credentialId, registry: w.registry, safeAddress: expected, safeOwnerAddress: attempt.ownerAddress, accountConfigVersion: REAL_ACCOUNT_CONFIG_VERSION });
    // One chain request: the proxy factory's proxyCreationCode() eth_call. Nothing else.
    expect(chainLog.map((entry) => entry.method)).toEqual(["eth_call"]);
    expect(chainLog[0]!.params).toEqual([{ to: REAL_SAFE.proxyFactoryAddress, data: PROXY_CREATION_CODE_SELECTOR }, "latest"]);
    expect(derivationTimersArmed()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(parseSession(result.sessionCookie, config.sessionSecret)).toMatchObject({ appUserId: attempt.appUserId, credentialId: attempt.credentialId });
    expect((await w.attempts.findByCredentialId(attempt.credentialId))?.state).toBe("active");
  });

  it("A (production client path): with no injected client, the factory is called once with the configured RPC URL and the result is the same Safe", async () => {
    const w = world();
    const attempt = await seedTurnkeyCreated(w);
    const result = await pipeline(w, attempt, false);
    expect(result.outcome).toBe("verified");
    if (result.outcome !== "verified") return;
    expect(factory.calls.map((call) => call.rpcUrl)).toEqual([config.rpcUrl]);
    expect(result.account.safeAddress).toBe(await expectedSafeAddress({ ownerAddress: attempt.ownerAddress!, subOrganizationId: attempt.subOrganizationId! }));
    expect(chainLog).toHaveLength(1);
  });

  it("finalize is outside the deadline: the timer is already cleared when finalize starts, and a finalize slower than 15 s still completes as verified", async () => {
    const w = world();
    const attempt = await seedTurnkeyCreated(w);
    let release!: () => void;
    const finalizeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const timersAtFinalize: number[] = [];
    w.finalize.mockImplementation((async (input: Parameters<RegistrationAttemptStore["finalize"]>[0]) => {
      timersAtFinalize.push(vi.getTimerCount());
      await finalizeGate;
      return w.realFinalize(input);
    }) as never);

    const result = observe(pipeline(w, attempt));
    await flushUntil(() => timersAtFinalize.length === 1, "finalize started");
    expect(timersAtFinalize).toEqual([0]);
    await advance(DEADLINE_MS * 2);
    expect(result.status).toBe("pending");
    release();
    await flushUntil(() => result.status !== "pending", "finalized");
    expect(result.status).toBe("fulfilled");
    expect((result.value as { outcome: string }).outcome).toBe("verified");
    expect(w.finalize).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// D–N: the 15 s deadline
// ---------------------------------------------------------------------------

describe("the 15 s derivation deadline", () => {
  it("D: the timer is armed before any construction — before the public client is built and before the derivation read starts", async () => {
    const w = world();
    const attempt = await seedTurnkeyCreated(w);
    modes = ["hold"];
    const result = observe(pipeline(w, attempt, false));
    await flushUntil(() => gates.length === 1, "derivation read held");
    expect(factory.calls).toEqual([{ rpcUrl: config.rpcUrl, timersAtCall: 1 }]);
    expect(chainLog.map((entry) => entry.timersAtRequest)).toEqual([1]);
    expect(derivationTimersArmed()).toBe(1);
    gates[0]!.resolve();
    await flushUntil(() => result.status !== "pending", "settled");
    expect(result.status).toBe("fulfilled");
  });

  it("E/F/K/P: a stalled derivation is pending at 14 999 ms and rejects at 15 000 ms with the fixed, sanitized error — no address of any kind, no finalize, no session", async () => {
    const w = world();
    const attempt = await seedTurnkeyCreated(w);
    modes = ["hold"];
    const result = observe(pipeline(w, attempt));
    await flushUntil(() => gates.length === 1, "derivation read held");
    const snapshot = await w.attempts.findByCredentialId(attempt.credentialId);
    await advance(DEADLINE_MS - 1);
    expect(result.status).toBe("pending");
    await advance(1);
    expectDeadline(result);
    const error = result.error as Error;
    for (const leak of [config.rpcUrl, "secret-key", "rpc.example", attempt.ownerAddress!, attempt.ownerAddress!.toLowerCase(), "0x"]) expect(error.message).not.toContain(leak);
    expect(Object.keys(error)).toEqual(["name"]); // no attached address, body, client or cause
    expect(error.cause).toBeUndefined();
    expect(w.finalize).not.toHaveBeenCalled();
    await expectNothingActivated(w, attempt);
    expect(await w.attempts.findByCredentialId(attempt.credentialId)).toEqual(snapshot);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("G: an early success clears the timer — nothing fires later", async () => {
    const w = world();
    const attempt = await seedTurnkeyCreated(w);
    modes = ["hold"];
    const result = observe(pipeline(w, attempt));
    await flushUntil(() => gates.length === 1, "held");
    await advance(DEADLINE_MS - 1);
    gates[0]!.resolve();
    await flushUntil(() => result.status !== "pending", "settled");
    expect(result.status).toBe("fulfilled");
    expect(vi.getTimerCount()).toBe(0);
    await advance(DEADLINE_MS * 4);
    expect((result.value as { outcome: string }).outcome).toBe("verified");
    expect(w.finalize).toHaveBeenCalledTimes(1);
  });

  it("H/I: an ordinary derivation failure before the deadline passes through unchanged (not normalized into the deadline error), clears the timer, and finalizes nothing", async () => {
    const w = world();
    const attempt = await seedTurnkeyCreated(w);
    const injected = Object.assign(new Error("injected provider failure"), { code: 4100 });
    failWith = injected;
    modes = ["fail"];
    const snapshot = await w.attempts.findByCredentialId(attempt.credentialId);
    const result = observe(pipeline(w, attempt));
    await flushUntil(() => result.status !== "pending", "failed");
    expect(result.status).toBe("rejected");
    expect(result.error).not.toBeInstanceOf(OnboardingSafeDerivationDeadlineError);
    // viem's own error for the failed read, carrying the injected failure as its cause chain — unchanged by the helper.
    expect(result.error).toBeInstanceOf(BaseError);
    expect((result.error as BaseError).walk((cause) => cause === injected)).toBe(injected);
    expect(vi.getTimerCount()).toBe(0);
    await advance(DEADLINE_MS * 2);
    expect(result.error).not.toBeInstanceOf(OnboardingSafeDerivationDeadlineError);
    expect(w.finalize).not.toHaveBeenCalled();
    await expectNothingActivated(w, attempt);
    expect(await w.attempts.findByCredentialId(attempt.credentialId)).toEqual(snapshot);
    expect(chainLog).toHaveLength(1); // no retry
  });

  it("J: a synchronous throw while building the public client is the same error object, leaves no timer, and starts no read", async () => {
    const w = world();
    const attempt = await seedTurnkeyCreated(w);
    const thrown = new Error("synchronous client construction failure");
    factory.throwSync = thrown;
    const result = observe(pipeline(w, attempt, false));
    await flushUntil(() => result.status !== "pending", "thrown");
    expect(result.status).toBe("rejected");
    expect(result.error).toBe(thrown);
    expect(vi.getTimerCount()).toBe(0);
    expect(derivationTimersArmed()).toBe(1);
    expect(chainLog).toEqual([]);
    expect(w.finalize).not.toHaveBeenCalled();
    await expectNothingActivated(w, attempt);
  });

  it("L: a late successful derivation is discarded — no finalize, no account, no session, the attempt unchanged, no further read", async () => {
    const w = world();
    const attempt = await seedTurnkeyCreated(w);
    modes = ["hold"];
    const result = observe(pipeline(w, attempt));
    await flushUntil(() => gates.length === 1, "held");
    const snapshot = await w.attempts.findByCredentialId(attempt.credentialId);
    await expire();
    expectDeadline(result);
    gates[0]!.resolve();
    await drain();
    await advance(10 * 60_000);
    expectDeadline(result);
    expect(w.finalize).not.toHaveBeenCalled();
    await expectNothingActivated(w, attempt);
    expect(await w.attempts.findByCredentialId(attempt.credentialId)).toEqual(snapshot);
    expect(chainLog.filter((entry) => entry.epoch === "late")).toEqual([]);
    expect(chainLog).toHaveLength(1);
    expect(derivationTimersArmed()).toBe(1); // never re-armed: no automatic retry
  });

  it("M/N: a late rejection is consumed — no unhandled rejection, the caller keeps the deadline error", async () => {
    const w = world();
    const attempt = await seedTurnkeyCreated(w);
    modes = ["hold"];
    const result = observe(pipeline(w, attempt));
    await flushUntil(() => gates.length === 1, "held");
    await expire();
    gates[0]!.reject(Object.assign(new Error("late provider failure"), { code: 4100 }));
    await drain();
    await advance(DEADLINE_MS);
    expectDeadline(result);
    expect(w.finalize).not.toHaveBeenCalled();
    // afterEach asserts no unhandledRejection was observed.
  });

  it("no automatic retry: after a timeout nothing is re-read or re-armed, even ten minutes later", async () => {
    const w = world();
    const attempt = await seedTurnkeyCreated(w);
    modes = ["hold"];
    const result = observe(pipeline(w, attempt, false));
    await flushUntil(() => gates.length === 1, "held");
    await expire();
    expectDeadline(result);
    await advance(10 * 60_000);
    expect(factory.calls).toHaveLength(1);
    expect(chainLog).toHaveLength(1);
    expect(derivationTimersArmed()).toBe(1);
    expect(w.turnkey.requests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// O: concurrency
// ---------------------------------------------------------------------------

describe("independent invocations", () => {
  it("O: an earlier success never clears a later invocation's timer — the other still times out on its own clock", async () => {
    const w = world();
    const a = await seedTurnkeyCreated(w);
    const b = await seedTurnkeyCreated(w);
    modes = ["hold", "hold"];
    const first = observe(pipeline(w, a));
    await flushUntil(() => gates.length === 1, "a held");
    const second = observe(pipeline(w, b));
    await flushUntil(() => gates.length === 2, "b held");
    await advance(1_000);
    gates[0]!.resolve();
    await flushUntil(() => first.status !== "pending", "a settled");
    expect((first.value as { outcome: string }).outcome).toBe("verified");
    expect(vi.getTimerCount()).toBe(1);
    await advance(DEADLINE_MS - 1_000 - 1);
    expect(second.status).toBe("pending");
    await advance(1);
    expectDeadline(second);
    expect(w.finalize).toHaveBeenCalledTimes(1);
    await expectNothingActivated(w, b);
  });

  it("O: staggered invocations keep separate clocks; an expired one's late answer does not touch the other or itself", async () => {
    const w = world();
    const a = await seedTurnkeyCreated(w);
    const b = await seedTurnkeyCreated(w);
    modes = ["hold", "hold"];
    const first = observe(pipeline(w, a));
    await flushUntil(() => gates.length === 1, "a held");
    await advance(5_000);
    const second = observe(pipeline(w, b));
    await flushUntil(() => gates.length === 2, "b held");
    await advance(DEADLINE_MS - 5_000);
    expectDeadline(first);
    expect(second.status).toBe("pending");
    gates[0]!.resolve(); // a's late answer
    await drain();
    await advance(5_000 - 1);
    expect(second.status).toBe("pending");
    gates[1]!.resolve();
    await flushUntil(() => second.status !== "pending", "b settled");
    expect((second.value as { outcome: string }).outcome).toBe("verified");
    expect(w.finalize).toHaveBeenCalledTimes(1);
    expect(w.finalize.mock.calls[0]![0]).toMatchObject({ credentialId: b.credentialId });
    await expectNothingActivated(w, a);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("same attempt: a timed-out invocation and a successful one — finalize runs once (from the successful one), its CAS decides, and the late answer adds nothing", async () => {
    const w = world();
    const attempt = await seedTurnkeyCreated(w);
    modes = ["hold", "answer"];
    const slow = observe(pipeline(w, attempt));
    await flushUntil(() => gates.length === 1, "slow held");
    const fast = await pipeline(w, attempt);
    expect(fast.outcome).toBe("verified");
    await expire();
    expectDeadline(slow);
    gates[0]!.resolve();
    await drain();
    expect(w.finalize).toHaveBeenCalledTimes(1);
    const active = await w.attempts.findByCredentialId(attempt.credentialId);
    expect(active?.state).toBe("active");
    expect(active?.safeAddress).toBe(await expectedSafeAddress({ ownerAddress: attempt.ownerAddress!, subOrganizationId: attempt.subOrganizationId! }));
  });
});

// ---------------------------------------------------------------------------
// Registration, login re-entry and the routes
// ---------------------------------------------------------------------------

async function registerUntilHeldDerivation(w: World) {
  modes = ["hold"];
  const { optionsJSON } = await beginRegistration({ config, challengeStore: w.challengeStore });
  const authenticator = createFixtureAuthenticator();
  const response = buildRegistrationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId });
  const result = observe(completeRegistration({ config, challengeStore: w.challengeStore, registry: w.registry, attempts: w.attempts, response, publicClient: controlledClient(), provisioningDeps: w.turnkey.deps() }));
  await flushUntil(() => gates.length === 1, "registration derivation held");
  return { authenticator, response, result, credentialId: authenticator.credentialIdBase64Url };
}

async function loginAssertion(authenticator: FixtureAuthenticator, userHandle: string) {
  const { optionsJSON } = await beginLogin({ config });
  return buildAuthenticationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId, userHandle });
}

const login = (w: World, response: Awaited<ReturnType<typeof loginAssertion>>) =>
  completeLogin({ config, loginChallengeUses: w.loginChallengeUses, registry: w.registry, attempts: w.attempts, response, publicClient: controlledClient(), provisioningDeps: w.turnkey.deps() });

describe("registration: a timed-out derivation leaves a resumable turnkey_created attempt", () => {
  it("the registration request rejects with the deadline error after exactly one create; the attempt stays turnkey_created with its identity; no account, passkey or session; a late answer changes nothing", async () => {
    const w = world();
    const { result, credentialId } = await registerUntilHeldDerivation(w);
    const held = await w.attempts.findByCredentialId(credentialId);
    expect(held).toMatchObject({ state: "turnkey_created", subOrganizationId: "sub-org-1", ownerAddress: FAKE_OWNER_ADDRESS });
    await expire();
    expectDeadline(result);
    gates[0]!.resolve();
    await drain();
    await advance(10 * 60_000);
    expect(await w.attempts.findByCredentialId(credentialId)).toEqual(held);
    expect(w.finalize).not.toHaveBeenCalled();
    expect(await w.registry.findPasskeyByCredentialId(credentialId)).toBeNull();
    expect(await w.registry.findAccountByAppUserId(held!.appUserId)).toBeNull();
    expect(w.turnkey.createRequests).toHaveLength(1);
    expect(await w.attempts.findDispatchesByCredentialId(credentialId)).toHaveLength(1);
  });

  it("the consumed registration challenge cannot be replayed after the timeout — rejected before any store write, Turnkey call or derivation read", async () => {
    const w = world();
    const { result, response, credentialId } = await registerUntilHeldDerivation(w);
    await expire();
    expectDeadline(result);
    const before = await w.attempts.findByCredentialId(credentialId);
    const turnkeyRequests = w.turnkey.requests.length;
    const replay = await completeRegistration({ config, challengeStore: w.challengeStore, registry: w.registry, attempts: w.attempts, response, publicClient: controlledClient(), provisioningDeps: w.turnkey.deps() });
    expect(replay).toEqual(UNKNOWN_REGISTRATION);
    expect(w.turnkey.requests).toHaveLength(turnkeyRequests);
    expect(chainLog).toHaveLength(1);
    expect(await w.attempts.findByCredentialId(credentialId)).toEqual(before);
  });

  it("a fresh login with the same passkey resumes the SAME attempt: same owner and sub-org, the honest Safe, active; no new create, Turnkey read or dispatch charge", async () => {
    const w = world();
    const { result, authenticator, credentialId } = await registerUntilHeldDerivation(w);
    await expire();
    expectDeadline(result);
    const held = (await w.attempts.findByCredentialId(credentialId))!;
    const turnkeyRequests = w.turnkey.requests.length;
    epoch = "before";

    const resumed = await login(w, await loginAssertion(authenticator, held.userHandle));

    expect(resumed.outcome).toBe("verified");
    if (resumed.outcome !== "verified") return;
    const expected = await expectedSafeAddress({ ownerAddress: FAKE_OWNER_ADDRESS, subOrganizationId: "sub-org-1" });
    expect(resumed.account).toMatchObject({ appUserId: held.appUserId, ownerAddress: FAKE_OWNER_ADDRESS, subOrganizationId: "sub-org-1", safeAddress: expected });
    expect(parseSession(resumed.sessionCookie, config.sessionSecret)).toMatchObject({ appUserId: held.appUserId, credentialId });
    expect(await w.attempts.findByCredentialId(credentialId)).toMatchObject({ state: "active", safeAddress: expected, ownerAddress: FAKE_OWNER_ADDRESS });
    expect(w.turnkey.requests).toHaveLength(turnkeyRequests);
    expect(w.turnkey.createRequests).toHaveLength(1);
    expect(await w.attempts.findDispatchesByCredentialId(credentialId)).toHaveLength(1);
    expect(w.finalize).toHaveBeenCalledTimes(1);
    expect(chainLog.map((entry) => entry.method)).toEqual(["eth_call", "eth_call"]); // the timed-out read, then the resume's one read
  });

  it("a login whose own derivation times out: the marker and counter writes stand, the attempt is otherwise untouched, no session; that assertion cannot be replayed; a later fresh login resumes", async () => {
    const w = world();
    const registration = await registerUntilHeldDerivation(w);
    await expire();
    expectDeadline(registration.result);
    const held = (await w.attempts.findByCredentialId(registration.credentialId))!;
    epoch = "before";
    const counterWrites = vi.spyOn(w.attempts, "updateCounter");

    modes = ["hold"];
    const assertion = await loginAssertion(registration.authenticator, held.userHandle);
    const timedOut = observe(login(w, assertion));
    await flushUntil(() => gates.length === 2, "login derivation held");
    const atDerivation = await w.attempts.findByCredentialId(registration.credentialId);
    expect(counterWrites).toHaveBeenCalledTimes(1); // the existing pre-pipeline counter write
    await expire();
    expectDeadline(timedOut);
    gates[1]!.resolve();
    await drain();
    // Unchanged by the failed derivation itself (the earlier counter write is the only difference from `held`).
    expect(await w.attempts.findByCredentialId(registration.credentialId)).toEqual(atDerivation);
    expect(atDerivation).toMatchObject({ state: "turnkey_created", subOrganizationId: held.subOrganizationId, ownerAddress: held.ownerAddress, walletId: held.walletId, turnkeyUserId: held.turnkeyUserId });
    expect(w.finalize).not.toHaveBeenCalled();

    epoch = "before";
    expect(await login(w, assertion)).toEqual(UNKNOWN_LOGIN); // single-use marker
    expect(chainLog).toHaveLength(2);

    const resumed = await login(w, await loginAssertion(registration.authenticator, held.userHandle));
    expect(resumed.outcome).toBe("verified");
    expect(w.finalize).toHaveBeenCalledTimes(1);
    expect(w.turnkey.createRequests).toHaveLength(1);
    expect(await w.attempts.findDispatchesByCredentialId(registration.credentialId)).toHaveLength(1);
  });
});

describe("routes: a derivation timeout keeps the existing generic 500", () => {
  function routeEnv(w: World) {
    vi.stubEnv("NEXT_PUBLIC_REAL_MODE_ENABLED", "true");
    vi.stubEnv("TURNKEY_PARENT_ORGANIZATION_ID", "parent-org");
    vi.stubEnv("TURNKEY_API_PUBLIC_KEY", "pub");
    vi.stubEnv("TURNKEY_API_PRIVATE_KEY", "priv");
    vi.stubEnv("REAL_SESSION_SECRET", config.sessionSecret);
    vi.stubEnv("NEXT_PUBLIC_REAL_RP_ID", config.rpId);
    vi.stubEnv("NEXT_PUBLIC_REAL_ORIGIN", ORIGIN);
    vi.stubEnv("PIMLICO_API_KEY", "pim_test_key");
    vi.stubEnv("BASE_SEPOLIA_RPC_URL", config.rpcUrl);
    route.challengeStore = w.challengeStore;
    route.registry = w.registry;
    route.attempts = w.attempts;
    route.loginChallengeUses = w.loginChallengeUses;
    route.provisioningDeps = w.turnkey.deps();
  }
  const post = (handler: { POST: (request: Request) => Promise<Response> }, path: string, response: unknown) =>
    handler.POST(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response }) }));

  async function expectGeneric500(observed: Settled) {
    expect(observed.status).toBe("fulfilled");
    const response = observed.value as Response;
    expect(response.status).toBe(500);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await response.json()).toEqual({ error: GENERIC_SERVER_ERROR_MESSAGE });
    expect(route.cookieSets).toEqual([]);
  }

  it("register/verify: the real route answers the derivation deadline with the generic 500 — no code, no Retry-After, no cookie", async () => {
    const w = world();
    routeEnv(w);
    modes = ["hold"];
    const { optionsJSON } = await beginRegistration({ config, challengeStore: w.challengeStore });
    const authenticator = createFixtureAuthenticator();
    const response: RegistrationResponseJSON = buildRegistrationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId });
    const answer = observe(post(registerRoute, "/api/real/account/register/verify", response));
    await flushUntil(() => gates.length === 1, "route derivation held");
    expect(factory.calls.map((call) => call.rpcUrl)).toEqual([config.rpcUrl]);
    await advance(DEADLINE_MS - 1);
    expect(answer.status).toBe("pending");
    await advance(1);
    await flushUntil(() => answer.status !== "pending", "answered");
    await expectGeneric500(answer);
    expect((await w.attempts.findByCredentialId(authenticator.credentialIdBase64Url))?.state).toBe("turnkey_created");
  });

  it("login/verify: resuming a turnkey_created attempt whose derivation times out is the same generic 500", async () => {
    const w = world();
    const registration = await registerUntilHeldDerivation(w);
    await expire();
    expectDeadline(registration.result);
    const held = (await w.attempts.findByCredentialId(registration.credentialId))!;
    epoch = "before";
    routeEnv(w);
    modes = ["hold"];
    const answer = observe(post(loginRoute, "/api/real/account/login/verify", await loginAssertion(registration.authenticator, held.userHandle)));
    await flushUntil(() => gates.length === 2, "route derivation held");
    await advance(DEADLINE_MS);
    await flushUntil(() => answer.status !== "pending", "answered");
    await expectGeneric500(answer);
    expect(await w.attempts.findByCredentialId(registration.credentialId)).toMatchObject({ state: "turnkey_created", ownerAddress: FAKE_OWNER_ADDRESS });
    expect(w.finalize).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// States that never derive a Safe
// ---------------------------------------------------------------------------

describe("states that do not derive never arm the timer or read the chain", () => {
  function expectNoDerivation() {
    expect(derivationTimersArmed()).toBe(0);
    expect(chainLog).toEqual([]);
    expect(factory.calls).toEqual([]);
  }

  it("blocked: the stored block reason, nothing else", async () => {
    const w = world();
    const attempt = await seedTurnkeyCreated(w);
    const blocked = await w.attempts.transition({ credentialId: attempt.credentialId, from: "turnkey_created", to: "blocked", patch: { blockReason: "test block" } });
    expect(await pipeline(w, blocked!)).toEqual({ outcome: "blocked", reason: "test block" });
    expectNoDerivation();
  });

  it("active: resumes the finalized account without deriving again", async () => {
    const w = world();
    const attempt = await seedTurnkeyCreated(w);
    expect((await pipeline(w, attempt)).outcome).toBe("verified");
    chainLog.length = 0;
    setTimeoutSpy.mockClear();
    const active = (await w.attempts.findByCredentialId(attempt.credentialId))!;
    expect((await pipeline(w, active)).outcome).toBe("verified");
    expectNoDerivation();
    expect(w.finalize).toHaveBeenCalledTimes(1);
  });

  it("provisioning_in_flight: needs review, no derivation", async () => {
    const w = world();
    seq += 1;
    const credentialId = bytesToBase64Url(randomBytes(16));
    await w.attempts.createVerified({ credentialId, appUserId: `app-user-${seq}`, userHandle: `handle-${seq}`, credentialPublicKey: "cose", counter: 0, transports: null, credentialDeviceType: null, credentialBackedUp: null, registrationChallenge: "c", rawClientDataJson: "d", rawAttestationObject: "a" });
    await claimWithEvidence(w.attempts, credentialId);
    const inFlight = (await w.attempts.findByCredentialId(credentialId))!;
    expect((await pipeline(w, inFlight)).outcome).toBe("pending");
    expectNoDerivation();
    expect(w.turnkey.requests).toEqual([]);
  });

  it("verified attempt refused by the global dispatch ceiling (capacity_reached): no create, no derivation", async () => {
    const w = world();
    for (let i = 0; i < 5; i += 1) {
      seq += 1;
      const id = bytesToBase64Url(randomBytes(16));
      await w.attempts.createVerified({ credentialId: id, appUserId: `app-user-${seq}`, userHandle: `handle-${seq}`, credentialPublicKey: "cose", counter: 0, transports: null, credentialDeviceType: null, credentialBackedUp: null, registrationChallenge: `c-${seq}`, rawClientDataJson: "d", rawAttestationObject: "a" });
      await claimWithEvidence(w.attempts, id);
    }
    seq += 1;
    const verified = await w.attempts.createVerified({ credentialId: bytesToBase64Url(randomBytes(16)), appUserId: `app-user-${seq}`, userHandle: `handle-${seq}`, credentialPublicKey: "cose", counter: 0, transports: null, credentialDeviceType: null, credentialBackedUp: null, registrationChallenge: `c-${seq}`, rawClientDataJson: "d", rawAttestationObject: "a" });
    expect((await pipeline(w, verified)).outcome).toBe("capacity_reached");
    expectNoDerivation();
    expect(w.turnkey.requests).toEqual([]);
  });

  it("verified attempt whose create outcome is lost (review): pending, no derivation", async () => {
    const w = world();
    w.turnkey.submitMode = "lose_response_after_apply";
    const { optionsJSON } = await beginRegistration({ config, challengeStore: w.challengeStore });
    const response = buildRegistrationResponseJSON({ authenticator: createFixtureAuthenticator(), challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId });
    const result = await completeRegistration({ config, challengeStore: w.challengeStore, registry: w.registry, attempts: w.attempts, response, publicClient: controlledClient(), provisioningDeps: w.turnkey.deps() });
    expect(result.outcome).toBe("pending");
    expectNoDerivation();
  });
});

// ---------------------------------------------------------------------------
// Source shape (supporting; the behavior above is the evidence)
// ---------------------------------------------------------------------------

describe("onboarding.ts source shape", () => {
  const source = readFileSync("lib/real/server/onboarding.ts", "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("one timer, one clear on each settle path, the approved constant, and no abort, retry, transport or logging code", () => {
    expect(code.match(/setTimeout\(/g)).toHaveLength(1);
    expect(code.match(/clearTimeout\(/g)).toHaveLength(2);
    expect(code).toContain("const ONBOARDING_SAFE_DERIVATION_DEADLINE_MS = 15_000;");
    expect(code).not.toMatch(/AbortController|AbortSignal|signal|retry|Retry|http\(|fetch\(|console\.|setInterval/);
  });

  it("the deadline wraps exactly the client and Safe-account construction; owner construction precedes it and finalize follows it, outside", () => {
    const opener = "await withOnboardingSafeDerivationDeadline(async () => {\n";
    const start = code.indexOf(opener);
    const end = code.indexOf("\n  });\n", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const wrapped = code.slice(start + opener.length, end).trim().split("\n").map((line) => line.trim());
    expect(wrapped).toEqual(["const publicClient = input.publicClient ?? createRealPublicClient(input.config.rpcUrl);", "return createRealSafeAccount({ owner, publicClient });"]);
    expect(code.indexOf("createVerifiedTurnkeyOwnerAccount({")).toBeLessThan(start);
    expect(code.indexOf("await input.attempts.finalize({")).toBeGreaterThan(end);
    expect(code.match(/withOnboardingSafeDerivationDeadline(<T>)?\(/g)).toHaveLength(2); // the definition and its one call
  });
});
