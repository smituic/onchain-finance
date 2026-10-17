import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { CONTROL_BODY_MAX_BYTES } from "@/lib/real/server/http";
import { REAL_API_MAX_BODY_BYTES, checkRealApiRequest } from "@/lib/real/server/request-gate";
import { createInMemoryPaymentAttemptStore } from "@/lib/real/server/payment-attempts";
import { createInMemoryRealAccountRegistry } from "@/lib/real/server/registry";
import { createSessionPayload, serializeSession } from "@/lib/real/server/session";
import { scriptedBudget } from "./fixtures/chain-read-budget";

/**
 * Milestone 3B, Slice 3B-1: the 14 control routes refuse a body over 4 KiB with
 * HTTP 413 BEFORE anything else happens, and everything else about them is
 * unchanged. These tests drive the ACTUAL route.ts code. Only next/headers'
 * cookies() and the runtime store getters are mocked; every store the routes
 * could write to or charge is a tripwire that records the call and throws, so a
 * 413 that came after a side effect is visible as a recorded event.
 *
 * What these cannot show: Next.js's own request-body handling. They prove what
 * the ROUTE does with the body it is handed.
 */

const SECRET = "7f3c9a1e5b2d4f60a8c7e9b1d3f5a7c90e2b4d6f8a1c3e5b7d9f0a2c4e6b8d0f";
const SAFE_ADDRESS = "0xd9a4c22fb34dc74317edc8006140d66c8fa03266";
const SIGNATURE = `0x${"00".repeat(12)}${"11".repeat(64)}1b`;
const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const ENROLLMENT_ID = "22222222-2222-4222-8222-222222222222";

// ---------------------------------------------------------------------------
// The harness: one mutable state object that the module mocks read, so each
// route module is imported once and every test gets fresh recording stores.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  events: [] as string[],
  registry: undefined as unknown,
  overrides: {} as Record<string, unknown>,
  tripwires: {} as Record<string, unknown>,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    // The only cookie any of these routes reads is the session cookie.
    get: (name: string) => (state.cookie !== undefined ? { name, value: state.cookie } : undefined),
    set: () => undefined,
    delete: () => undefined,
  }),
}));

vi.mock("@/lib/real/server/runtime", () => {
  const pick = (name: string) => () => (name in state.overrides ? state.overrides[name] : name === "getRealAccountRegistry" ? state.registry : state.tripwires[name]);
  return Object.fromEntries(
    ["getRealAccountRegistry", "getPaymentAttemptStore", "getRateLimiter", "getProviderBudgetLimiter", "getAccountHandleStore", "getChallengeStore", "getBackupPasskeyEnrollmentStore", "getPasskeyRevocationStore"].map((name) => [name, pick(name)]),
  );
});

/** Every property read is a function that records `label.property` and then throws — a side effect the test must not see. */
function tripwire(label: string): unknown {
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === "then") return undefined;
        return () => {
          state.events.push(`${label}.${String(property)}`);
          throw new Error(`tripwire: ${label}.${String(property)}`);
        };
      },
    },
  );
}

/** The real in-memory registry, recording every method call (session reads are the only ones a 413 may follow). */
function recordingRegistry(real: object): unknown {
  return new Proxy(real, {
    get: (target, property, receiver) => {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function" || property === "then") return value;
      return (...args: unknown[]) => {
        state.events.push(`registry.${String(property)}`);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

const SESSION_READS = ["registry.findPasskeyByCredentialId", "registry.findAccountByAppUserId"];

function stubEnv() {
  vi.stubEnv("NEXT_PUBLIC_REAL_MODE_ENABLED", "true");
  vi.stubEnv("TURNKEY_PARENT_ORGANIZATION_ID", "sub-org-1");
  vi.stubEnv("TURNKEY_API_PUBLIC_KEY", "public-key");
  vi.stubEnv("TURNKEY_API_PRIVATE_KEY", "private-key");
  vi.stubEnv("REAL_SESSION_SECRET", SECRET);
  vi.stubEnv("NEXT_PUBLIC_REAL_RP_ID", "localhost");
  vi.stubEnv("NEXT_PUBLIC_REAL_ORIGIN", "http://localhost:3000");
  vi.stubEnv("PIMLICO_API_KEY", "pim_test_key");
}

async function seedRegistry() {
  const registry = createInMemoryRealAccountRegistry();
  await registry.createAccountWithPasskey({
    account: { appUserId: "app-user-1", subOrganizationId: "sub-org-1", turnkeyUserId: "turnkey-user-1", walletId: "wallet-1", walletAccountId: "wallet-account-1", ownerAddress: "0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF", safeAddress: SAFE_ADDRESS, accountConfigVersion: 1 },
    passkey: { credentialId: "credential-1", appUserId: "app-user-1", credentialPublicKey: "cose-key", userHandle: "user-handle-1", counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false },
  });
  return registry;
}

const fetchSpy = vi.fn(async (): Promise<Response> => {
  throw new Error("network is not available in this test");
});

let realRegistry: Awaited<ReturnType<typeof seedRegistry>>;
let validCookie: string;

beforeAll(async () => {
  realRegistry = await seedRegistry();
  validCookie = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);
});

beforeEach(() => {
  stubEnv();
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockClear();
  state.cookie = validCookie;
  state.events = [];
  state.overrides = {};
  state.registry = recordingRegistry(realRegistry);
  state.tripwires = {
    getPaymentAttemptStore: tripwire("paymentStore"),
    getRateLimiter: tripwire("rateLimiter"),
    getProviderBudgetLimiter: tripwire("providerBudget"),
    getAccountHandleStore: tripwire("handleStore"),
    getChallengeStore: tripwire("challengeStore"),
    getBackupPasskeyEnrollmentStore: tripwire("enrollmentStore"),
    getPasskeyRevocationStore: tripwire("revocationStore"),
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The 14 routes.
// ---------------------------------------------------------------------------

type RouteCase = {
  /** Route file, relative to the repository root. */
  file: string;
  method: "POST" | "PATCH";
  url: string;
  /** Whether the route reads the session BEFORE the body (all but prepare and submit). */
  sessionFirst: boolean;
  /** A body the route's own validation accepts far enough to reach its resolver. */
  valid: Record<string, unknown>;
  /** The route has a `[credentialId]` segment. */
  credentialParam?: string;
  /** Charges the 3A-3 Turnkey reconcile budget. */
  budgeted?: boolean;
};

const ROUTES: RouteCase[] = [
  { file: "app/api/real/payments/prepare/route.ts", method: "POST", url: "/api/real/payments/prepare", sessionFirst: false, valid: { recipient: "0x2222222222222222222222222222222222222222", amountBaseUnits: "10000" } },
  { file: "app/api/real/payments/submit/route.ts", method: "POST", url: "/api/real/payments/submit", sessionFirst: false, valid: { attemptId: ATTEMPT_ID, signature: SIGNATURE, activityId: "activity-1" } },
  { file: "app/api/real/recipients/lookup/route.ts", method: "POST", url: "/api/real/recipients/lookup", sessionFirst: true, valid: { handle: "smit" } },
  { file: "app/api/real/account/handle/options/route.ts", method: "POST", url: "/api/real/account/handle/options", sessionFirst: true, valid: { handle: "smit" } },
  { file: "app/api/real/account/profile/route.ts", method: "PATCH", url: "/api/real/account/profile", sessionFirst: true, valid: { displayName: "Smit" } },
  { file: "app/api/real/account/passkeys/[credentialId]/route.ts", method: "PATCH", url: "/api/real/account/passkeys/credential-1", sessionFirst: true, credentialParam: "credential-1", valid: { displayName: "Laptop" } },
  { file: "app/api/real/account/passkeys/[credentialId]/revoke/cancel/route.ts", method: "POST", url: "/api/real/account/passkeys/credential-1/revoke/cancel", sessionFirst: true, credentialParam: "credential-1", valid: { attemptId: ATTEMPT_ID } },
  { file: "app/api/real/account/passkeys/[credentialId]/revoke/reconcile/route.ts", method: "POST", url: "/api/real/account/passkeys/credential-1/revoke/reconcile", sessionFirst: true, credentialParam: "credential-1", valid: { attemptId: ATTEMPT_ID }, budgeted: true },
  { file: "app/api/real/account/passkeys/backup/abandon/route.ts", method: "POST", url: "/api/real/account/passkeys/backup/abandon", sessionFirst: true, valid: { enrollmentId: ENROLLMENT_ID } },
  { file: "app/api/real/account/passkeys/backup/authorize/options/route.ts", method: "POST", url: "/api/real/account/passkeys/backup/authorize/options", sessionFirst: true, valid: { enrollmentId: ENROLLMENT_ID } },
  { file: "app/api/real/account/passkeys/backup/authorize/reconcile/route.ts", method: "POST", url: "/api/real/account/passkeys/backup/authorize/reconcile", sessionFirst: true, valid: { enrollmentId: ENROLLMENT_ID }, budgeted: true },
  { file: "app/api/real/account/passkeys/backup/verify-login/options/route.ts", method: "POST", url: "/api/real/account/passkeys/backup/verify-login/options", sessionFirst: true, valid: { enrollmentId: ENROLLMENT_ID } },
  { file: "app/api/real/account/passkeys/backup/verify-signing/options/route.ts", method: "POST", url: "/api/real/account/passkeys/backup/verify-signing/options", sessionFirst: true, valid: { enrollmentId: ENROLLMENT_ID } },
  { file: "app/api/real/account/passkeys/backup/verify-signing/confirm/route.ts", method: "POST", url: "/api/real/account/passkeys/backup/verify-signing/confirm", sessionFirst: true, valid: { enrollmentId: ENROLLMENT_ID, activityId: "activity-1" }, budgeted: true },
];

type RouteModule = Record<string, (...args: never[]) => Promise<Response>>;

/** Explicit imports (not a computed path) so the bundler resolves each route exactly like production code does. */
const ROUTE_MODULES: Record<string, () => Promise<RouteModule>> = {
  "app/api/real/payments/prepare/route.ts": () => import("@/app/api/real/payments/prepare/route"),
  "app/api/real/payments/submit/route.ts": () => import("@/app/api/real/payments/submit/route"),
  "app/api/real/recipients/lookup/route.ts": () => import("@/app/api/real/recipients/lookup/route"),
  "app/api/real/account/handle/options/route.ts": () => import("@/app/api/real/account/handle/options/route"),
  "app/api/real/account/profile/route.ts": () => import("@/app/api/real/account/profile/route"),
  "app/api/real/account/passkeys/[credentialId]/route.ts": () => import("@/app/api/real/account/passkeys/[credentialId]/route"),
  "app/api/real/account/passkeys/[credentialId]/revoke/cancel/route.ts": () => import("@/app/api/real/account/passkeys/[credentialId]/revoke/cancel/route"),
  "app/api/real/account/passkeys/[credentialId]/revoke/reconcile/route.ts": () => import("@/app/api/real/account/passkeys/[credentialId]/revoke/reconcile/route"),
  "app/api/real/account/passkeys/backup/abandon/route.ts": () => import("@/app/api/real/account/passkeys/backup/abandon/route"),
  "app/api/real/account/passkeys/backup/authorize/options/route.ts": () => import("@/app/api/real/account/passkeys/backup/authorize/options/route"),
  "app/api/real/account/passkeys/backup/authorize/reconcile/route.ts": () => import("@/app/api/real/account/passkeys/backup/authorize/reconcile/route"),
  "app/api/real/account/passkeys/backup/verify-login/options/route.ts": () => import("@/app/api/real/account/passkeys/backup/verify-login/options/route"),
  "app/api/real/account/passkeys/backup/verify-signing/options/route.ts": () => import("@/app/api/real/account/passkeys/backup/verify-signing/options/route"),
  "app/api/real/account/passkeys/backup/verify-signing/confirm/route.ts": () => import("@/app/api/real/account/passkeys/backup/verify-signing/confirm/route"),
};

const moduleFor = (file: string) => ROUTE_MODULES[file]!();

type Call = { status: number; body: unknown };

/** Invokes the real route handler with `request`. */
async function invoke(route: RouteCase, request: Request): Promise<Call> {
  const handler = (await moduleFor(route.file))[route.method]! as (request: Request, context?: unknown) => Promise<Response>;
  const response = await handler(route.credentialParam ? new NextRequest(request) : request, route.credentialParam ? { params: Promise.resolve({ credentialId: route.credentialParam }) } : undefined);
  return { status: response.status, body: await response.json().catch(() => null) };
}

const encoder = new TextEncoder();

function jsonRequest(route: RouteCase, body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${route.url}`, { method: route.method, headers: { "content-type": "application/json", ...headers }, body });
}

/** A syntactically valid JSON body whose single string field pushes the whole body to `bytes` bytes. */
const bodyOfBytes = (route: RouteCase, bytes: number): string => {
  const filler = Object.keys(route.valid)[0]!;
  const probe = JSON.stringify({ ...route.valid, [filler]: "" });
  return JSON.stringify({ ...route.valid, [filler]: "x".repeat(bytes - encoder.encode(probe).byteLength) });
};

const nonSession = (events: string[]) => events.filter((event) => !SESSION_READS.includes(event));

const TOO_LARGE = { error: "This request is too large.", code: "request_too_large" };

describe.each(ROUTES)("$method $url — oversized body is refused with 413 before anything happens", (route) => {
  const assertNothingHappened = () => {
    expect(fetchSpy).not.toHaveBeenCalled(); // no Turnkey, Pimlico, or RPC
    expect(route.sessionFirst ? nonSession(state.events) : state.events).toEqual([]); // no limiter, challenge, claim, write, or transition
  };

  it("actual body over 4096 bytes (no Content-Length): 413 with the exact body", async () => {
    const result = await invoke(route, jsonRequest(route, bodyOfBytes(route, CONTROL_BODY_MAX_BYTES + 1)));
    expect(result).toEqual({ status: 413, body: TOO_LARGE });
    assertNothingHappened();
  });

  it("declared Content-Length over 4096 (body never read): 413", async () => {
    const result = await invoke(route, jsonRequest(route, "{}", { "content-length": String(CONTROL_BODY_MAX_BYTES + 1) }));
    expect(result).toEqual({ status: 413, body: TOO_LARGE });
    assertNothingHappened();
  });

  it("a body far over the limit is 413 and no response carries any of its content", async () => {
    const marker = "UNIQUE-OVERSIZED-MARKER";
    const huge = JSON.stringify({ ...route.valid, filler: marker + "y".repeat(200_000) });
    const result = await invoke(route, jsonRequest(route, huge));
    expect(result.status).toBe(413);
    expect(JSON.stringify(result.body)).not.toContain(marker);
    assertNothingHappened();
  });

  it("an oversized STREAMED body (chunked, no Content-Length) is 413", async () => {
    const chunk = encoder.encode("x".repeat(1500));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 10) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const request = new Request(`http://localhost${route.url}`, { method: route.method, headers: { "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit & { duplex: "half" });
    expect(await invoke(route, request)).toEqual({ status: 413, body: TOO_LARGE });
    assertNothingHappened();
  });

  it("exactly 4096 bytes is NOT refused: the route goes on to its own validation and processing", async () => {
    const body = bodyOfBytes(route, CONTROL_BODY_MAX_BYTES);
    expect(encoder.encode(body).byteLength).toBe(CONTROL_BODY_MAX_BYTES);
    const result = await invoke(route, jsonRequest(route, body, { "content-length": String(CONTROL_BODY_MAX_BYTES) }));
    expect(result.status).not.toBe(413);
  });

  it("a declared length that disagrees with a small body is the route's existing 400, not a 413", async () => {
    const result = await invoke(route, jsonRequest(route, "{}", { "content-length": "100" }));
    expect(result).toEqual({ status: 400, body: { error: "Invalid request body." } });
    assertNothingHappened();
  });

  it("an invalid body keeps the route's existing 400 and message: malformed JSON, invalid UTF-8, empty, and JSON null", async () => {
    const invalidUtf8 = new Uint8Array([...encoder.encode('{"a":"'), 0xff, ...encoder.encode('"}')]);
    for (const body of ["{not json", invalidUtf8, "", "null"]) {
      state.events = [];
      const result = await invoke(route, jsonRequest(route, body));
      expect(result, String(body)).toEqual({ status: 400, body: { error: "Invalid request body." } });
      assertNothingHappened();
    }
  });

  it("an ordinary valid request is unchanged: it passes the body stage and reaches its resolver", async () => {
    const result = await invoke(route, jsonRequest(route, JSON.stringify(route.valid)));
    expect(result.status).not.toBe(413);
    expect(result.body).not.toEqual({ error: "Invalid request body." });
    // It got past the body and touched a dependency (a store, the registry beyond the session read, or the network).
    expect(nonSession(state.events).length + fetchSpy.mock.calls.length).toBeGreaterThan(0);
  });
});

describe("authentication placement is unchanged", () => {
  const prepare = ROUTES[0]!;
  const submit = ROUTES[1]!;
  const profile = ROUTES.find((route) => route.url === "/api/real/account/profile")!;

  it("prepare and submit judge size BEFORE the session: an unauthenticated oversized body is a 413 with the registry untouched", async () => {
    state.cookie = undefined;
    for (const route of [prepare, submit]) {
      state.events = [];
      expect(await invoke(route, jsonRequest(route, bodyOfBytes(route, CONTROL_BODY_MAX_BYTES + 1)))).toEqual({ status: 413, body: TOO_LARGE });
      expect(state.events).toEqual([]);
    }
  });

  it("a session-first route still answers 401 to an unauthenticated caller, whatever the body size", async () => {
    state.cookie = undefined;
    expect(await invoke(profile, jsonRequest(profile, bodyOfBytes(profile, CONTROL_BODY_MAX_BYTES + 1)))).toEqual({ status: 401, body: { error: "Not authenticated." } });
  });

  it("an unauthenticated small prepare/submit is still the route's own 401", async () => {
    state.cookie = undefined;
    for (const route of [prepare, submit]) {
      state.overrides = { getPaymentAttemptStore: createInMemoryPaymentAttemptStore() };
      const result = await invoke(route, jsonRequest(route, JSON.stringify(route.valid)));
      expect(result, route.url).toEqual({ status: 401, body: { error: "Not authenticated." } });
    }
  });
});

describe("payment submit — an oversized request leaves the payment untouched", () => {
  async function seedAwaitingAuthorization() {
    const paymentStore = createInMemoryPaymentAttemptStore();
    const reserved = await paymentStore.reserve({ appUserId: "app-user-1", safeAddress: SAFE_ADDRESS, recipient: "0x2222222222222222222222222222222222222222", amountBaseUnits: "10000", chainId: 84532, tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", authorizingCredentialId: "credential-1" });
    if (!reserved.ok) throw new Error("expected reservation");
    await paymentStore.transition({
      id: reserved.attempt.id,
      from: "prepared",
      to: "awaiting_authorization",
      patch: { nonce: "0", callData: "0x1234", callGasLimit: "80000", verificationGasLimit: "150000", preVerificationGas: "60000", maxFeePerGas: "2000000", maxPriorityFeePerGas: "1000000", expectedUserOperationHash: `0x${"ab".repeat(32)}`, validUntil: Math.floor(Date.now() / 1000) + 600, prepareBlockNumber: "1" },
    });
    // Record every call the route makes to the store.
    const calls: string[] = [];
    const recording = new Proxy(paymentStore, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          calls.push(String(property));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    return { paymentStore, recording, calls, attemptId: reserved.attempt.id };
  }

  it("an oversized submit is a 413 that makes no store call, no budget charge, and no provider call; the attempt stays awaiting_authorization, byte for byte", async () => {
    const { paymentStore, recording, calls, attemptId } = await seedAwaitingAuthorization();
    const { limiter, calls: budgetCalls } = scriptedBudget({ allowed: true });
    state.overrides = { getPaymentAttemptStore: recording, getProviderBudgetLimiter: limiter };
    const before = structuredClone(await paymentStore.findById(attemptId));
    const route = ROUTES[1]!;

    const body = JSON.stringify({ attemptId, signature: SIGNATURE, activityId: "activity-1", padding: "x".repeat(CONTROL_BODY_MAX_BYTES) });
    expect(await invoke(route, jsonRequest(route, body))).toEqual({ status: 413, body: TOO_LARGE });
    expect(await invoke(route, jsonRequest(route, "{}", { "content-length": "99999" }))).toEqual({ status: 413, body: TOO_LARGE });

    expect(calls).toEqual([]); // not even a read, let alone failBeforeClaim / transition
    expect(budgetCalls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await paymentStore.findById(attemptId)).toEqual(before);
    expect((await paymentStore.findById(attemptId))?.state).toBe("awaiting_authorization");
  });

  it("the same payment can still be submitted afterwards: a normal request reaches the submit budget (here denied) and the attempt is still awaiting_authorization", async () => {
    const { paymentStore, recording, attemptId } = await seedAwaitingAuthorization();
    const { limiter, calls: budgetCalls } = scriptedBudget({ allowed: false, retryAfterSeconds: 90 });
    state.overrides = { getPaymentAttemptStore: recording, getProviderBudgetLimiter: limiter };
    const route = ROUTES[1]!;

    expect((await invoke(route, jsonRequest(route, JSON.stringify({ attemptId, signature: SIGNATURE, activityId: "activity-1", padding: "x".repeat(CONTROL_BODY_MAX_BYTES) })))).status).toBe(413);

    const retry = await invoke(route, jsonRequest(route, JSON.stringify({ attemptId, signature: SIGNATURE, activityId: "activity-1" })));
    expect(retry.status).toBe(429);
    expect(retry.body).toMatchObject({ code: "rate_limited", retryable: true });
    expect(budgetCalls).toHaveLength(1); // exactly the one charge, made by the normal request
    expect((await paymentStore.findById(attemptId))?.state).toBe("awaiting_authorization");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("budgeted routes — a 413 never consumes a provider-budget unit", () => {
  const budgeted = ROUTES.filter((route) => route.budgeted);

  it("covers exactly the three Turnkey reconcile/confirm routes", () => {
    expect(budgeted.map((route) => route.url)).toEqual([
      "/api/real/account/passkeys/credential-1/revoke/reconcile",
      "/api/real/account/passkeys/backup/authorize/reconcile",
      "/api/real/account/passkeys/backup/verify-signing/confirm",
    ]);
  });

  it.each(budgeted)("$url: oversized -> 413 with zero limiter calls, zero Turnkey calls, and no store access; a normal request then still reaches the resolver", async (route) => {
    const { limiter, calls } = scriptedBudget({ allowed: true });
    state.overrides = { getProviderBudgetLimiter: limiter };

    expect((await invoke(route, jsonRequest(route, bodyOfBytes(route, CONTROL_BODY_MAX_BYTES + 1)))).status).toBe(413);
    expect(calls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(nonSession(state.events)).toEqual([]); // the enrollment and revocation stores were never opened: no claim, no replay, no DELETE

    const normal = await invoke(route, jsonRequest(route, JSON.stringify(route.valid)));
    expect(normal.status).not.toBe(413);
    expect(nonSession(state.events).length).toBeGreaterThan(0);
  });
});

describe("other side effects stay behind the body check", () => {
  it("the handle-claim options route mints no challenge and charges no probe budget for an oversized body", async () => {
    const route = ROUTES.find((candidate) => candidate.url === "/api/real/account/handle/options")!;
    await invoke(route, jsonRequest(route, bodyOfBytes(route, CONTROL_BODY_MAX_BYTES + 1)));
    expect(state.events.filter((event) => event.startsWith("challengeStore.") || event.startsWith("rateLimiter.") || event.startsWith("handleStore."))).toEqual([]);
  });

  it("the recipient lookup charges no probe budget and reads no handle for an oversized body", async () => {
    const route = ROUTES.find((candidate) => candidate.url === "/api/real/recipients/lookup")!;
    await invoke(route, jsonRequest(route, bodyOfBytes(route, CONTROL_BODY_MAX_BYTES + 1)));
    expect(state.events.filter((event) => event.startsWith("rateLimiter.") || event.startsWith("handleStore."))).toEqual([]);
  });

  it("prepare charges no prepare/probe budget, makes no reservation, and builds no provider client for an oversized body", async () => {
    const route = ROUTES[0]!;
    await invoke(route, jsonRequest(route, bodyOfBytes(route, CONTROL_BODY_MAX_BYTES + 1)));
    expect(state.events).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3B-2: the request gate in front of the 3B-1 routes.
// ---------------------------------------------------------------------------

describe("3B-2 gate + route together — the 4 KiB route limit still applies to what the 10 MiB gate admits", () => {
  const GATE_ENV = { NEXT_PUBLIC_REAL_MODE_ENABLED: "true", NEXT_PUBLIC_REAL_ORIGIN: "http://localhost:3000" };
  const gate = (request: Request) => checkRealApiRequest(request, GATE_ENV);
  const withHeaders = (route: RouteCase, body: string, extra: Record<string, string>) =>
    new Request(`http://localhost${route.url}`, { method: route.method, headers: { "content-type": "application/json", origin: "http://localhost:3000", ...extra }, body });

  it.each(ROUTES)("$url: a 5 000-byte body with an honest Content-Length passes the gate and is refused 413 by the route", async (route) => {
    const body = bodyOfBytes(route, 5000);
    const request = withHeaders(route, body, { "content-length": "5000" });
    expect(gate(request)).toBeNull();
    expect(await invoke(route, withHeaders(route, body, { "content-length": "5000" }))).toEqual({ status: 413, body: TOO_LARGE });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(route.sessionFirst ? nonSession(state.events) : state.events).toEqual([]);
  });

  it.each(ROUTES)("$url: a body declared at exactly 10 MiB passes the gate; the route refuses it at once from the declared length, without reading it", async (route) => {
    const declared = { "content-length": String(REAL_API_MAX_BODY_BYTES) };
    expect(gate(withHeaders(route, "{}", declared))).toBeNull();
    expect(await invoke(route, withHeaders(route, "{}", declared))).toEqual({ status: 413, body: TOO_LARGE });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(ROUTES)("$url: a body declared one byte over 10 MiB never reaches the route — the gate answers 413 first", async (route) => {
    const response = gate(withHeaders(route, "{}", { "content-length": String(REAL_API_MAX_BODY_BYTES + 1) }));
    expect(response?.status).toBe(413);
    expect(await response?.json()).toEqual(TOO_LARGE);
  });

  it("a short valid JSON prefix followed by padding cannot be admitted by declaring a small length: the framing, not the header, decides what is read", async () => {
    // Without a length the gate refuses outright (411), so a 'prefix + padding' upload cannot even start.
    const route = ROUTES[0]!;
    const request = new Request(`http://localhost${route.url}`, { method: route.method, headers: { "content-type": "application/json", origin: "http://localhost:3000" }, body: `${JSON.stringify(route.valid)}${" ".repeat(64)}garbage` });
    expect(gate(request)?.status).toBe(411);
    // With a declared length over the ceiling it is 413 at the gate, and with one over the route's own limit it is 413 in the route.
    expect(gate(withHeaders(route, JSON.stringify(route.valid), { "content-length": String(REAL_API_MAX_BODY_BYTES + 1) }))?.status).toBe(413);
  });
});

// ---------------------------------------------------------------------------
// Source guards.
// ---------------------------------------------------------------------------

const root = path.resolve(__dirname, "../../..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

function routeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    return statSync(full).isDirectory() ? routeFiles(full) : entry === "route.ts" ? [full] : [];
  });
}

/** Strips comments so a guard never trips on prose that mentions a forbidden call. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const EIGHT_REMAINING_BODY_ROUTES = [
  "app/api/real/account/handle/claim/route.ts",
  "app/api/real/account/login/verify/route.ts",
  "app/api/real/account/passkeys/[credentialId]/revoke/submit/route.ts",
  "app/api/real/account/passkeys/backup/authorize/submit/route.ts",
  "app/api/real/account/passkeys/backup/options/route.ts",
  "app/api/real/account/passkeys/backup/register/route.ts",
  "app/api/real/account/passkeys/backup/verify-login/confirm/route.ts",
  "app/api/real/account/register/verify/route.ts",
];

describe("source guards — the 14 control routes", () => {
  it("there are exactly 14 authorized routes, each with the right method", () => {
    expect(ROUTES).toHaveLength(14);
    expect(new Set(ROUTES.map((route) => route.file)).size).toBe(14);
    expect(ROUTES.filter((route) => route.method === "PATCH").map((route) => route.url)).toEqual(["/api/real/account/profile", "/api/real/account/passkeys/credential-1"]);
  });

  it.each(ROUTES)("$file reads its body only through the bounded reader with the shared 4096-byte policy", (route) => {
    const source = code(read(route.file));
    expect(source.match(/readBoundedJsonBody\(/g)).toHaveLength(1);
    expect(source).toContain("readBoundedJsonBody(request, CONTROL_BODY_MAX_BYTES)");
    expect(source).toMatch(/bounded\.kind === "too_large"\) return requestTooLargeResponse\(\)/);
    expect(source).toContain('bounded.kind === "ok" ? bounded.value : null');
    expect(source).toContain(`export async function ${route.method}(`);
    // No second, unbounded way to read the body, and no inline size number.
    expect(source).not.toContain("readJsonBody");
    expect(source).not.toMatch(/\.(json|text|arrayBuffer|blob|formData|bytes)\(\)/);
    expect(source).not.toMatch(/request\.body\b/);
    expect(source).not.toMatch(/\b4096\b|\b4 \* 1024\b|1024 \*/);
  });

  it("the 413 happens before the first thing after the body in every route (the response is returned at the read site)", () => {
    for (const route of ROUTES) {
      const source = code(read(route.file));
      const readAt = source.indexOf("readBoundedJsonBody(request");
      const refuseAt = source.indexOf("requestTooLargeResponse()", readAt);
      expect(refuseAt, route.file).toBeGreaterThan(readAt);
      // Nothing but the read statement lies between the read and the refusal.
      expect(source.slice(readAt, refuseAt).split("\n").filter((line) => line.trim()).length, route.file).toBe(2);
    }
  });
});

describe("source guards — the eight routes NOT migrated by this slice", () => {
  it("still read their bodies with readJsonBody (they are not yet protected by this slice)", () => {
    for (const file of EIGHT_REMAINING_BODY_ROUTES) {
      const source = code(read(file));
      expect(source, file).toContain("readJsonBody(request)");
      expect(source, file).not.toContain("readBoundedJsonBody");
    }
  });

  it("every body-reading route in app/api is either one of the 14 bounded routes or one of these 8 — nothing else, nothing new", () => {
    const bodyReaders = routeFiles(path.join(root, "app/api"))
      .map((file) => path.relative(root, file))
      .filter((file) => /readJsonBody|readBoundedJsonBody|\brequest\.(json|text|arrayBuffer|formData|blob|body)\b|\breq\.(json|text|arrayBuffer|formData|blob|body)\b/.test(code(read(file))))
      .sort();
    expect(bodyReaders).toEqual([...ROUTES.map((route) => route.file), ...EIGHT_REMAINING_BODY_ROUTES].sort());
    expect(bodyReaders).toHaveLength(22);
  });

  it("readJsonBody itself still exists for them (it is not banned yet)", () => {
    expect(code(read("lib/real/server/http.ts"))).toContain("export async function readJsonBody(");
  });
});

describe("source guards — the shared reader", () => {
  const http = code(read("lib/real/server/http.ts"));
  const reader = http.slice(http.indexOf("export async function readBoundedJsonBody"), http.indexOf("export { isRealModeEnabled }"));

  it("the control policy is one constant of 4096 bytes in http.ts, and no production limits module was created", () => {
    expect(http.match(/export const CONTROL_BODY_MAX_BYTES = 4096;/g)).toHaveLength(1);
    expect(CONTROL_BODY_MAX_BYTES).toBe(4096);
  });

  it("counts a chunk against the limit BEFORE keeping it, so the chunk that crosses the line is never retained", () => {
    const check = reader.indexOf("received + value.byteLength > maxBytes");
    const keep = reader.indexOf("chunks.push(");
    expect(check).toBeGreaterThan(-1);
    expect(keep).toBeGreaterThan(check);
    expect(reader.slice(check, keep)).toContain("too_large");
  });

  it("never falls back to an unbounded read", () => {
    expect(reader).not.toMatch(/\.(json|text|arrayBuffer|blob|formData|bytes)\(\)/);
    expect(reader).not.toContain("readJsonBody");
  });

  it("decodes strictly and parses without a reviver", () => {
    expect(reader).toContain('new TextDecoder("utf-8", { fatal: true })');
    expect(reader).toMatch(/JSON\.parse\(text\)/);
    expect(reader).not.toMatch(/JSON\.parse\([^)]*,/);
    expect(reader).not.toMatch(/\.trim\(|\.normalize\(|JSON\.stringify/);
  });

  it("requires an explicit positive safe-integer limit and never logs", () => {
    expect(reader).toContain("Number.isSafeInteger(maxBytes) || maxBytes < 1");
    expect(reader).not.toMatch(/console\./);
    expect(reader).not.toMatch(/maxBytes\s*=\s*[^=]|maxBytes\?/); // no default value, not optional
  });
});
