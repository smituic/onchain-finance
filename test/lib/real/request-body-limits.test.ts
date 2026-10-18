import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { CONTROL_BODY_MAX_BYTES, SIGNED_TURNKEY_REQUEST_BODY_MAX_BYTES, WEBAUTHN_ASSERTION_BODY_MAX_BYTES, WEBAUTHN_REGISTRATION_BODY_MAX_BYTES, readBoundedJsonBody } from "@/lib/real/server/http";
import { parseSignedTurnkeyRequest } from "@/lib/real/server/turnkey-signed-request";
import { REAL_API_MAX_BODY_BYTES, checkRealApiRequest } from "@/lib/real/server/request-gate";
import { createInMemoryPaymentAttemptStore } from "@/lib/real/server/payment-attempts";
import { createInMemoryRealAccountRegistry } from "@/lib/real/server/registry";
import { createSessionPayload, serializeSession } from "@/lib/real/server/session";
import { scriptedBudget } from "./fixtures/chain-read-budget";
import { buildAuthenticationResponseJSON, buildRegistrationResponseJSON, createFixtureAuthenticator } from "./fixtures/webauthn";

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
  /** What the two signed-request services were called with (they are still the real functions; this only records the argument). */
  captured: { revocation: [] as unknown[], authorization: [] as unknown[], registration: [] as unknown[], backupRegistration: [] as unknown[] },
  emptyCaptured: () => ({ revocation: [] as unknown[], authorization: [] as unknown[], registration: [] as unknown[], backupRegistration: [] as unknown[] }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    // The only cookie any of these routes reads is the session cookie.
    get: (name: string) => (state.cookie !== undefined ? { name, value: state.cookie } : undefined),
    set: () => void state.events.push("cookies.set"),
    delete: () => undefined,
  }),
}));

/** Records the exact `signedRequest` the route hands each signed-request service, then runs the real function. */
vi.mock("@/lib/real/server/passkey-revocation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/real/server/passkey-revocation")>();
  return {
    ...actual,
    submitRevocation: ((input: Parameters<typeof actual.submitRevocation>[0]) => {
      state.captured.revocation.push(input.signedRequest);
      return actual.submitRevocation(input);
    }) as typeof actual.submitRevocation,
  };
});

vi.mock("@/lib/real/server/backup-passkey-pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/real/server/backup-passkey-pipeline")>();
  return {
    ...actual,
    submitTurnkeyAuthorization: ((input: Parameters<typeof actual.submitTurnkeyAuthorization>[0]) => {
      state.captured.authorization.push(input.signedRequest);
      return actual.submitTurnkeyAuthorization(input);
    }) as typeof actual.submitTurnkeyAuthorization,
    completeBackupCredentialRegistration: ((input: Parameters<typeof actual.completeBackupCredentialRegistration>[0]) => {
      state.captured.backupRegistration.push(input.response);
      return actual.completeBackupCredentialRegistration(input);
    }) as typeof actual.completeBackupCredentialRegistration,
  };
});

vi.mock("@/lib/real/server/registration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/real/server/registration")>();
  return {
    ...actual,
    completeRegistration: ((input: Parameters<typeof actual.completeRegistration>[0]) => {
      state.captured.registration.push(input.response);
      return actual.completeRegistration(input);
    }) as typeof actual.completeRegistration,
  };
});

vi.mock("@/lib/real/server/runtime", () => {
  const pick = (name: string) => () => (name in state.overrides ? state.overrides[name] : name === "getRealAccountRegistry" ? state.registry : state.tripwires[name]);
  return Object.fromEntries(
    ["getRealAccountRegistry", "getRegistrationAttemptStore", "getPaymentAttemptStore", "getRateLimiter", "getProviderBudgetLimiter", "getAccountHandleStore", "getChallengeStore", "getBackupPasskeyEnrollmentStore", "getPasskeyRevocationStore"].map((name) => [name, pick(name)]),
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
  state.captured = state.emptyCaptured();
  state.overrides = {};
  state.registry = recordingRegistry(realRegistry);
  state.tripwires = {
    getRegistrationAttemptStore: tripwire("registrationAttempts"),
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
  /** The body budget the route enforces, and the name of the shared constant it must use. */
  limit: number;
  limitName: "CONTROL_BODY_MAX_BYTES" | "WEBAUTHN_ASSERTION_BODY_MAX_BYTES" | "SIGNED_TURNKEY_REQUEST_BODY_MAX_BYTES" | "WEBAUTHN_REGISTRATION_BODY_MAX_BYTES";
  /** A valid request makes no store call the harness can see beyond the session reads (login verify has no session). */
  anyEventCounts?: boolean;
  /** Which signed-request service the route passes `signedRequest` to. */
  signedService?: "revocation" | "authorization";
  /** Which registration service receives the parsed `response` (3B-4). */
  registrationService?: "registration" | "backupRegistration";
};

type ControlCase = Omit<RouteCase, "limit" | "limitName">;

const CONTROL_ROUTES: ControlCase[] = [
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

// --- 3B-3: four WebAuthn-assertion routes (16 KiB) and two signed-Turnkey routes (64 KiB). ---

const fixtureAuthenticator = createFixtureAuthenticator();
/** A REAL ES256 assertion produced by the offline fixture authenticator. */
const ES256_ASSERTION = buildAuthenticationResponseJSON({ authenticator: fixtureAuthenticator, challenge: "Y2hhbGxlbmdlLWZvci10ZXN0cw", origin: "http://localhost:3000", rpId: "localhost", userHandle: "dXNlci1oYW5kbGUtMQ" });

/** Representative signed envelopes: the shapes the browser's Turnkey stamper sends (sizes are realistic, values are fake). */
const stampValue = (credentialIdChars = 43) => JSON.stringify({ authenticatorData: "A".repeat(50), clientDataJson: "B".repeat(280), credentialId: "C".repeat(credentialIdChars), signature: "D".repeat(96) });
const DELETE_SIGNED = {
  body: JSON.stringify({ type: "ACTIVITY_TYPE_DELETE_AUTHENTICATORS", timestampMs: "1760000000000", organizationId: "00000000-0000-4000-8000-000000000001", parameters: { userId: "00000000-0000-4000-8000-000000000002", authenticatorIds: ["00000000-0000-4000-8000-000000000003"] } }),
  stamp: { stampHeaderName: "X-Stamp-Webauthn", stampHeaderValue: stampValue() },
  url: "https://api.turnkey.com/public/v1/submit/delete_authenticators",
};
const CREATE_SIGNED = {
  body: JSON.stringify({ type: "ACTIVITY_TYPE_CREATE_AUTHENTICATORS_V2", timestampMs: "1760000000000", organizationId: "00000000-0000-4000-8000-000000000001", parameters: { userId: "00000000-0000-4000-8000-000000000002", authenticators: [{ authenticatorName: "ON Chain backup", challenge: "E".repeat(43), attestation: { credentialId: "F".repeat(43), clientDataJson: "G".repeat(180), attestationObject: "H".repeat(400), transports: ["AUTHENTICATOR_TRANSPORT_INTERNAL"] } }] } }),
  stamp: { stampHeaderName: "X-Stamp-Webauthn", stampHeaderValue: stampValue() },
  url: "https://api.turnkey.com/public/v1/submit/create_authenticators",
};

const WEBAUTHN = "WEBAUTHN_ASSERTION_BODY_MAX_BYTES" as const;
const SIGNED = "SIGNED_TURNKEY_REQUEST_BODY_MAX_BYTES" as const;

const ASSERTION_ROUTES: RouteCase[] = [
  { file: "app/api/real/account/login/verify/route.ts", method: "POST", url: "/api/real/account/login/verify", sessionFirst: false, anyEventCounts: true, valid: { response: ES256_ASSERTION }, limit: WEBAUTHN_ASSERTION_BODY_MAX_BYTES, limitName: WEBAUTHN },
  { file: "app/api/real/account/handle/claim/route.ts", method: "POST", url: "/api/real/account/handle/claim", sessionFirst: true, valid: { handle: "smit", response: ES256_ASSERTION }, limit: WEBAUTHN_ASSERTION_BODY_MAX_BYTES, limitName: WEBAUTHN },
  { file: "app/api/real/account/passkeys/backup/options/route.ts", method: "POST", url: "/api/real/account/passkeys/backup/options", sessionFirst: true, valid: { stepUp: ES256_ASSERTION }, limit: WEBAUTHN_ASSERTION_BODY_MAX_BYTES, limitName: WEBAUTHN },
  { file: "app/api/real/account/passkeys/backup/verify-login/confirm/route.ts", method: "POST", url: "/api/real/account/passkeys/backup/verify-login/confirm", sessionFirst: true, valid: { response: ES256_ASSERTION }, limit: WEBAUTHN_ASSERTION_BODY_MAX_BYTES, limitName: WEBAUTHN },
];

const SIGNED_ROUTES: RouteCase[] = [
  { file: "app/api/real/account/passkeys/[credentialId]/revoke/submit/route.ts", method: "POST", url: "/api/real/account/passkeys/credential-1/revoke/submit", sessionFirst: true, credentialParam: "credential-1", valid: { attemptId: ATTEMPT_ID, signedRequest: DELETE_SIGNED }, limit: SIGNED_TURNKEY_REQUEST_BODY_MAX_BYTES, limitName: SIGNED, signedService: "revocation" },
  { file: "app/api/real/account/passkeys/backup/authorize/submit/route.ts", method: "POST", url: "/api/real/account/passkeys/backup/authorize/submit", sessionFirst: true, valid: { enrollmentId: ENROLLMENT_ID, signedRequest: CREATE_SIGNED }, limit: SIGNED_TURNKEY_REQUEST_BODY_MAX_BYTES, limitName: SIGNED, signedService: "authorization" },
];

// --- 3B-4: the two WebAuthn-registration routes (64 KiB). ---

/** A REAL offline registration response (genuine P-256 key, CBOR attestation object, "none" format). */
const REGISTRATION_RESPONSE = buildRegistrationResponseJSON({ authenticator: createFixtureAuthenticator(), challenge: "Y2hhbGxlbmdlLWZvci10ZXN0cw", origin: "http://localhost:3000", rpId: "localhost", transports: ["internal", "hybrid"] });
const REGISTRATION = "WEBAUTHN_REGISTRATION_BODY_MAX_BYTES" as const;

const REGISTRATION_ROUTES: RouteCase[] = [
  { file: "app/api/real/account/register/verify/route.ts", method: "POST", url: "/api/real/account/register/verify", sessionFirst: false, anyEventCounts: true, valid: { response: REGISTRATION_RESPONSE }, limit: WEBAUTHN_REGISTRATION_BODY_MAX_BYTES, limitName: REGISTRATION, registrationService: "registration" },
  { file: "app/api/real/account/passkeys/backup/register/route.ts", method: "POST", url: "/api/real/account/passkeys/backup/register", sessionFirst: true, valid: { response: REGISTRATION_RESPONSE }, limit: WEBAUTHN_REGISTRATION_BODY_MAX_BYTES, limitName: REGISTRATION, registrationService: "backupRegistration" },
];

const ROUTES: RouteCase[] = [
  ...CONTROL_ROUTES.map((route): RouteCase => ({ ...route, limit: CONTROL_BODY_MAX_BYTES, limitName: "CONTROL_BODY_MAX_BYTES" })),
  ...ASSERTION_ROUTES,
  ...SIGNED_ROUTES,
  ...REGISTRATION_ROUTES,
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
  "app/api/real/account/login/verify/route.ts": () => import("@/app/api/real/account/login/verify/route"),
  "app/api/real/account/handle/claim/route.ts": () => import("@/app/api/real/account/handle/claim/route"),
  "app/api/real/account/passkeys/backup/options/route.ts": () => import("@/app/api/real/account/passkeys/backup/options/route"),
  "app/api/real/account/passkeys/backup/verify-login/confirm/route.ts": () => import("@/app/api/real/account/passkeys/backup/verify-login/confirm/route"),
  "app/api/real/account/passkeys/[credentialId]/revoke/submit/route.ts": () => import("@/app/api/real/account/passkeys/[credentialId]/revoke/submit/route"),
  "app/api/real/account/passkeys/backup/authorize/submit/route.ts": () => import("@/app/api/real/account/passkeys/backup/authorize/submit/route"),
  "app/api/real/account/register/verify/route.ts": () => import("@/app/api/real/account/register/verify/route"),
  "app/api/real/account/passkeys/backup/register/route.ts": () => import("@/app/api/real/account/passkeys/backup/register/route"),
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
  const probe = JSON.stringify({ ...route.valid, _pad: "" });
  return JSON.stringify({ ...route.valid, _pad: "x".repeat(bytes - encoder.encode(probe).byteLength) });
};

const nonSession = (events: string[]) => events.filter((event) => !SESSION_READS.includes(event));

const TOO_LARGE = { error: "This request is too large.", code: "request_too_large" };

describe.each(ROUTES)("$method $url — oversized body is refused with 413 before anything happens", (route) => {
  const assertNothingHappened = () => {
    expect(fetchSpy).not.toHaveBeenCalled(); // no Turnkey, Pimlico, or RPC
    expect(route.sessionFirst ? nonSession(state.events) : state.events).toEqual([]); // no limiter, challenge, claim, write, or transition
    expect(state.captured).toEqual(state.emptyCaptured()); // the signed-request services were never called
  };

  it("actual body over 4096 bytes (no Content-Length): 413 with the exact body", async () => {
    const result = await invoke(route, jsonRequest(route, bodyOfBytes(route, route.limit + 1)));
    expect(result).toEqual({ status: 413, body: TOO_LARGE });
    assertNothingHappened();
  });

  it("declared Content-Length over 4096 (body never read): 413", async () => {
    const result = await invoke(route, jsonRequest(route, "{}", { "content-length": String(route.limit + 1) }));
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
    const chunk = encoder.encode("x".repeat(Math.ceil(route.limit / 4)));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 6) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const request = new Request(`http://localhost${route.url}`, { method: route.method, headers: { "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit & { duplex: "half" });
    expect(await invoke(route, request)).toEqual({ status: 413, body: TOO_LARGE });
    assertNothingHappened();
  });

  it("exactly 4096 bytes is NOT refused: the route goes on to its own validation and processing", async () => {
    const body = bodyOfBytes(route, route.limit);
    expect(encoder.encode(body).byteLength).toBe(route.limit);
    const result = await invoke(route, jsonRequest(route, body, { "content-length": String(route.limit) }));
    expect(result.status).not.toBe(413);
    // ...and the body was READ and parsed: any 400 is a later domain-validation answer, never the body-stage message.
    expect(result.body).not.toEqual({ error: "Invalid request body." });
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
    const touched = route.anyEventCounts ? state.events.length : nonSession(state.events).length;
    expect(touched + fetchSpy.mock.calls.length).toBeGreaterThan(0);
  });
});

describe("authentication placement is unchanged", () => {
  const prepare = ROUTES[0]!;
  const submit = ROUTES[1]!;
  const loginVerify = ROUTES.find((route) => route.url === "/api/real/account/login/verify")!;
  const registerVerify = ROUTES.find((route) => route.url === "/api/real/account/register/verify")!;
  const backupRegister = ROUTES.find((route) => route.url === "/api/real/account/passkeys/backup/register")!;
  const profile = ROUTES.find((route) => route.url === "/api/real/account/profile")!;

  it("prepare and submit judge size BEFORE the session: an unauthenticated oversized body is a 413 with the registry untouched", async () => {
    state.cookie = undefined;
    for (const route of [prepare, submit, loginVerify, registerVerify]) {
      state.events = [];
      expect(await invoke(route, jsonRequest(route, bodyOfBytes(route, route.limit + 1)))).toEqual({ status: 413, body: TOO_LARGE });
      expect(state.events).toEqual([]);
    }
  });

  it("a session-first route still answers 401 to an unauthenticated caller, whatever the body size", async () => {
    state.cookie = undefined;
    for (const route of [profile, backupRegister]) {
      expect(await invoke(route, jsonRequest(route, bodyOfBytes(route, route.limit + 1))), route.url).toEqual({ status: 401, body: { error: "Not authenticated." } });
      expect(await invoke(route, jsonRequest(route, JSON.stringify(route.valid))), route.url).toEqual({ status: 401, body: { error: "Not authenticated." } });
    }
    expect(state.captured.backupRegistration).toEqual([]); // the unauthenticated body never reached the service
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

    expect((await invoke(route, jsonRequest(route, bodyOfBytes(route, route.limit + 1)))).status).toBe(413);
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
// 3B-3: WebAuthn-assertion routes (16 KiB) and signed-Turnkey routes (64 KiB).
// ---------------------------------------------------------------------------

const NEW_ROUTES = [...ASSERTION_ROUTES, ...SIGNED_ROUTES];

describe("3B-3 family limits — each family uses its own budget, not the control one", () => {
  it("the policy hierarchy is strictly increasing and every family sits under the 10 MiB gate", () => {
    expect(CONTROL_BODY_MAX_BYTES).toBe(4096);
    expect(WEBAUTHN_ASSERTION_BODY_MAX_BYTES).toBe(16_384);
    expect(SIGNED_TURNKEY_REQUEST_BODY_MAX_BYTES).toBe(65_536);
    expect(CONTROL_BODY_MAX_BYTES).toBeLessThan(WEBAUTHN_ASSERTION_BODY_MAX_BYTES);
    expect(WEBAUTHN_ASSERTION_BODY_MAX_BYTES).toBeLessThan(SIGNED_TURNKEY_REQUEST_BODY_MAX_BYTES);
    expect(SIGNED_TURNKEY_REQUEST_BODY_MAX_BYTES).toBeLessThan(REAL_API_MAX_BODY_BYTES);
  });

  it.each(NEW_ROUTES)("$url: the family limit is the one enforced (a body the 4 KiB policy would refuse is read; one byte over the family limit is not)", async (route) => {
    // 3 times the control budget but well inside this family's: it must be READ (not 413) and parsed (not the body-stage 400).
    const medium = await invoke(route, jsonRequest(route, bodyOfBytes(route, CONTROL_BODY_MAX_BYTES * 3)));
    expect(medium.status).not.toBe(413);
    expect(medium.body).not.toEqual({ error: "Invalid request body." });
    state.events = [];
    expect(await invoke(route, jsonRequest(route, bodyOfBytes(route, route.limit + 1)))).toEqual({ status: 413, body: TOO_LARGE });
  });

  it.each(NEW_ROUTES)("$url: exactly the family limit is accepted by the bounded reader, one byte more is not (reader-level, same bytes the route sees)", async (route) => {
    const exact = bodyOfBytes(route, route.limit);
    expect(encoder.encode(exact).byteLength).toBe(route.limit);
    expect(await readBoundedJsonBody(new Request("http://localhost/x", { method: "POST", body: exact }), route.limit)).toMatchObject({ kind: "ok" });
    expect(await readBoundedJsonBody(new Request("http://localhost/x", { method: "POST", body: bodyOfBytes(route, route.limit + 1) }), route.limit)).toEqual({ kind: "too_large" });
  });

  it.each(NEW_ROUTES)("$url: a declared length over the family limit is 413 without reading the body", async (route) => {
    expect(await invoke(route, jsonRequest(route, "{}", { "content-length": String(route.limit + 1) }))).toEqual({ status: 413, body: TOO_LARGE });
  });

  it.each(NEW_ROUTES)("$url: a declared length within the limit that disagrees with the body is the existing 400, not a 413", async (route) => {
    expect(await invoke(route, jsonRequest(route, "{}", { "content-length": "100" }))).toEqual({ status: 400, body: { error: "Invalid request body." } });
    expect(await invoke(route, jsonRequest(route, JSON.stringify(route.valid), { "content-length": "5" }))).toEqual({ status: 400, body: { error: "Invalid request body." } });
  });

  it.each(NEW_ROUTES)("$url: a multi-byte body is measured in transport bytes, not characters", async (route) => {
    // 3-byte characters: `limit / 3 + 1` characters is under the limit as a string length but over it in bytes.
    const euro = String.fromCharCode(0x20ac);
    const body = JSON.stringify({ ...route.valid, _pad: euro.repeat(Math.floor(route.limit / 3) + 1) });
    expect(body.length).toBeLessThan(route.limit);
    expect(encoder.encode(body).byteLength).toBeGreaterThan(route.limit);
    expect(await invoke(route, jsonRequest(route, body))).toEqual({ status: 413, body: TOO_LARGE });
  });
});

describe("3B-3 WebAuthn assertion shapes stay far below 16 KiB", () => {
  const b64 = (bytes: number) => "A".repeat(Math.ceil((bytes * 4) / 3));
  /** A synthetic AuthenticationResponseJSON built from per-field BYTE sizes (base64url length ~ 4/3 of that). */
  const synthetic = (sizes: { credentialId: number; clientDataJSON: number; authenticatorData: number; signature: number; userHandle: number; extensionResults: number }) => ({
    id: b64(sizes.credentialId),
    rawId: b64(sizes.credentialId),
    response: { clientDataJSON: b64(sizes.clientDataJSON), authenticatorData: b64(sizes.authenticatorData), signature: b64(sizes.signature), userHandle: b64(sizes.userHandle) },
    authenticatorAttachment: "cross-platform",
    clientExtensionResults: sizes.extensionResults ? { credProps: { rk: true }, largeBlob: { blob: b64(sizes.extensionResults) } } : {},
    type: "public-key",
  });
  const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;

  const SHAPES = {
    "ES256 (real offline fixture)": ES256_ASSERTION,
    "ES256-shaped, typical platform authenticator": synthetic({ credentialId: 32, clientDataJSON: 160, authenticatorData: 37, signature: 72, userHandle: 32, extensionResults: 0 }),
    "RS256-shaped, 2048-bit signature (256 bytes)": synthetic({ credentialId: 64, clientDataJSON: 200, authenticatorData: 37, signature: 256, userHandle: 64, extensionResults: 0 }),
    "RS256-shaped, 4096-bit signature (512 bytes)": synthetic({ credentialId: 64, clientDataJSON: 200, authenticatorData: 37, signature: 512, userHandle: 64, extensionResults: 0 }),
    "long credential id (1023 bytes, the WebAuthn maximum)": synthetic({ credentialId: 1023, clientDataJSON: 200, authenticatorData: 37, signature: 72, userHandle: 64, extensionResults: 0 }),
    "large authenticatorData (1 KiB of extension output)": synthetic({ credentialId: 64, clientDataJSON: 200, authenticatorData: 1024, signature: 72, userHandle: 64, extensionResults: 0 }),
    "large signature + extension results": synthetic({ credentialId: 64, clientDataJSON: 200, authenticatorData: 37, signature: 512, userHandle: 64, extensionResults: 1024 }),
    "generous synthetic worst case (every field at a generous maximum)": synthetic({ credentialId: 1023, clientDataJSON: 1024, authenticatorData: 1024, signature: 512, userHandle: 64, extensionResults: 1024 }),
  } as const;

  it("every shape, wrapped as each of the four routes sends it, fits the family limit with at least 2x headroom", () => {
    const sizes: Record<string, number> = {};
    for (const [name, assertion] of Object.entries(SHAPES)) {
      const envelopes = [{ response: assertion }, { handle: "smit", response: assertion }, { stepUp: assertion }];
      const largest = Math.max(...envelopes.map(bytes));
      sizes[name] = largest;
      expect(largest, name).toBeLessThan(WEBAUTHN_ASSERTION_BODY_MAX_BYTES / 2);
    }
    // The measured envelope sizes (bytes) are printed in the test report so a reader can see the real numbers.
    expect(Object.keys(sizes)).toHaveLength(Object.keys(SHAPES).length);
    expect(sizes["generous synthetic worst case (every field at a generous maximum)"]).toBeGreaterThan(sizes["ES256 (real offline fixture)"]!);
  });

  it.each(ASSERTION_ROUTES)("$url accepts every representative shape past the body stage (never a 413, never the body-stage 400)", async (route) => {
    const key = Object.keys(route.valid).find((name) => name === "response" || name === "stepUp")!;
    for (const [name, assertion] of Object.entries(SHAPES)) {
      state.events = [];
      const result = await invoke(route, jsonRequest(route, JSON.stringify({ ...route.valid, [key]: assertion })));
      expect(result.status, name).not.toBe(413);
      expect(result.body, name).not.toEqual({ error: "Invalid request body." });
    }
  });

  it("the real ES256 fixture assertion passes through unchanged: the route hands the resolver exactly the parsed fields", async () => {
    const route = ASSERTION_ROUTES[0]!;
    const result = await readBoundedJsonBody(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ response: ES256_ASSERTION }) }), route.limit);
    expect(result).toEqual({ kind: "ok", value: { response: ES256_ASSERTION } });
  });
});

describe("3B-3 signed Turnkey envelopes — sizes, integrity, and no forwarding after a 413", () => {
  const signedRoutes = SIGNED_ROUTES;
  const capturedFor = (route: RouteCase) => (route.signedService === "revocation" ? state.captured.revocation : state.captured.authorization);
  const envelopeFor = (route: RouteCase, signedRequest: unknown) => JSON.stringify({ ...route.valid, signedRequest });

  /** A well-formed signed request whose body and stamp sit exactly at the parser's limits (16 384 and 8 192 UTF-16 units). */
  const atParserLimits = () => {
    const bodyHead = '{"type":"ACTIVITY_TYPE_DELETE_AUTHENTICATORS","pad":"';
    const body = bodyHead + "a".repeat(16_384 - bodyHead.length - 2) + '"}';
    const stampHead = '{"authenticatorData":"AAAA","clientDataJson":"BBBB","credentialId":"CCCC","signature":"';
    const stamp = stampHead + "d".repeat(8_192 - stampHead.length - 2) + '"}';
    return { body, stamp: { stampHeaderName: "X-Stamp-Webauthn", stampHeaderValue: stamp }, url: "https://api.turnkey.com/public/v1/submit/delete_authenticators" };
  };

  it("representative revoke/submit and authorize/submit envelopes are small relative to 64 KiB", () => {
    for (const route of signedRoutes) expect(encoder.encode(JSON.stringify(route.valid)).byteLength, route.url).toBeLessThan(SIGNED_TURNKEY_REQUEST_BODY_MAX_BYTES / 20);
  });

  it("a stamper-shaped request with body and stamp AT the parser's limits fits well inside 64 KiB and still parses", () => {
    const signed = atParserLimits();
    expect(signed.body.length).toBe(16_384);
    expect(signed.stamp.stampHeaderValue.length).toBe(8_192);
    for (const route of signedRoutes) expect(encoder.encode(envelopeFor(route, signed)).byteLength, route.url).toBeLessThan(SIGNED_TURNKEY_REQUEST_BODY_MAX_BYTES / 2);
    expect(parseSignedTurnkeyRequest(signed)).not.toBeNull();
    // The parser's own limits are unchanged: one unit over is refused by the parser even though the transport admits it.
    expect(parseSignedTurnkeyRequest({ ...signed, body: signed.body + " " })).toBeNull();
    expect(parseSignedTurnkeyRequest({ ...signed, stamp: { ...signed.stamp, stampHeaderValue: signed.stamp.stampHeaderValue + " " } })).toBeNull();
  });

  it.each(signedRoutes)("$url: an envelope of exactly 65 536 bytes is read; 65 537 bytes is a 413", async (route) => {
    const exact = bodyOfBytes(route, SIGNED_TURNKEY_REQUEST_BODY_MAX_BYTES);
    expect(encoder.encode(exact).byteLength).toBe(65_536);
    const accepted = await invoke(route, jsonRequest(route, exact, { "content-length": "65536" }));
    expect(accepted.status).not.toBe(413);
    expect(accepted.body).not.toEqual({ error: "Invalid request body." });
    // The route got to its service: it was handed the original signedRequest object.
    expect(capturedFor(route)).toHaveLength(1);

    state.captured = state.emptyCaptured();
    state.events = [];
    const over = bodyOfBytes(route, SIGNED_TURNKEY_REQUEST_BODY_MAX_BYTES + 1);
    expect(encoder.encode(over).byteLength).toBe(65_537);
    expect(await invoke(route, jsonRequest(route, over, { "content-length": "65537" }))).toEqual({ status: 413, body: TOO_LARGE });
    expect(capturedFor(route)).toEqual([]);
    expect(nonSession(state.events)).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("escape amplification: a worst-case ASCII signed request (every inner character needs escaping again in the outer JSON) is still well under 64 KiB", () => {
    // Inner body made of `\"` pairs (2 units each): the outer JSON turns each into `\\\"` (4 bytes) — a 2x expansion.
    const head = '{"k":"';
    const body = head + '\\"'.repeat((16_384 - head.length - 2) / 2) + '"}';
    expect(body.length).toBe(16_384);
    const stamp = '{"s":"' + '\\"'.repeat((8_192 - 6 - 2) / 2) + '"}';
    expect(stamp.length).toBe(8_192);
    const signed = { body, stamp: { stampHeaderName: "X-Stamp-Webauthn", stampHeaderValue: stamp }, url: "https://api.turnkey.com/public/v1/submit/delete_authenticators" };
    expect(parseSignedTurnkeyRequest(signed)).not.toBeNull();
    for (const route of signedRoutes) expect(encoder.encode(envelopeFor(route, signed)).byteLength, route.url).toBeLessThan(SIGNED_TURNKEY_REQUEST_BODY_MAX_BYTES);
  });

  it("the approved stricter transport limit: only a body AND stamp both saturated with 3-byte characters can exceed 64 KiB, and that is refused", async () => {
    // 16 384 + 8 192 units at 3 bytes each is ~73.7 KB. A real stamper emits ASCII (base64url, hex, quotes) only.
    const euro = String.fromCharCode(0x20ac);
    const body = '{"k":"' + euro.repeat(16_384 - 8) + '"}';
    const stamp = '{"s":"' + euro.repeat(8_192 - 8) + '"}';
    const signed = { body, stamp: { stampHeaderName: "X-Stamp-Webauthn", stampHeaderValue: stamp }, url: "https://api.turnkey.com/public/v1/submit/delete_authenticators" };
    expect(parseSignedTurnkeyRequest(signed)).not.toBeNull(); // the PARSER would take it; only the transport limit refuses it
    const route = signedRoutes[0]!;
    expect(encoder.encode(envelopeFor(route, signed)).byteLength).toBeGreaterThan(SIGNED_TURNKEY_REQUEST_BODY_MAX_BYTES);
    expect(await invoke(route, jsonRequest(route, envelopeFor(route, signed)))).toEqual({ status: 413, body: TOO_LARGE });
  });

  it.each(signedRoutes)("$url: the signed strings reach the service BYTE-FOR-BYTE, whatever the outer JSON's whitespace and escaping looks like", async (route) => {
    const eAcute = String.fromCharCode(0x00e9);
    const eDecomposed = "e" + String.fromCharCode(0x0301);
    const lineSep = String.fromCharCode(0x2028);
    const emoji = String.fromCodePoint(0x1f600);
    // Signed strings with leading/trailing whitespace, decomposed Unicode, mixed-case keys, a line separator, an emoji and an escaped slash.
    const body = ` {"TimestampMs":"1760000000000","Name":"${eAcute}${eDecomposed}","sep":"${lineSep}","e":"${emoji}","path":"a\\/b","Case":"MiXeD"} `;
    const stampValue = ` {"authenticatorData":"AAAA","clientDataJson":"BBBB","credentialId":"CcCc","signature":"dDdD"}\n`;
    const url = "https://api.turnkey.com/public/v1/submit/delete_authenticators";
    const signedRequest = { body, stamp: { stampHeaderName: "x-stamp-webauthn", stampHeaderValue: stampValue }, url };

    // Several spellings of the SAME outer JSON: compact, pretty-printed, and with every non-ASCII character written as an escape.
    const compact = JSON.stringify({ ...route.valid, signedRequest });
    const pretty = JSON.stringify({ ...route.valid, signedRequest }, null, 4);
    const escaped = compact.replace(/[^\x20-\x7e]/g, (character) => character.split("").map((unit) => "\\u" + unit.charCodeAt(0).toString(16).padStart(4, "0")).join(""));
    expect(escaped).not.toBe(compact);
    expect(pretty).not.toBe(compact);

    for (const [name, text] of [["compact", compact], ["pretty-printed", pretty], ["escaped non-ASCII", escaped]] as const) {
      state.captured = state.emptyCaptured();
      state.events = [];
      await invoke(route, jsonRequest(route, text));
      const captured = capturedFor(route);
      expect(captured, name).toHaveLength(1);
      const received = captured[0] as { body: string; stamp: { stampHeaderName: string; stampHeaderValue: string }; url: string };
      // Identity, not equality-after-cleanup: nothing was trimmed, normalized, re-cased, unescaped or re-serialized.
      expect(received.body, name).toBe(body);
      expect(received.stamp.stampHeaderValue, name).toBe(stampValue);
      expect(received.stamp.stampHeaderName, name).toBe("x-stamp-webauthn");
      expect(received.url, name).toBe(url);
      // The UTF-8 bytes are the same too (what would be hashed and forwarded).
      expect(Buffer.from(received.body, "utf8").equals(Buffer.from(body, "utf8")), name).toBe(true);
      expect(Buffer.from(received.stamp.stampHeaderValue, "utf8").equals(Buffer.from(stampValue, "utf8")), name).toBe(true);
    }
  });

  it.each(signedRoutes)("$url: the existing parser still decides what is a valid signed request (a bounded envelope is not a valid one)", async (route) => {
    const route413 = await invoke(route, jsonRequest(route, envelopeFor(route, { body: "x", stamp: { stampHeaderName: "Wrong", stampHeaderValue: "{}" }, url: "u" })));
    // Within the byte limit, so not a 413; the service (not the transport limit) rejects the malformed envelope with the existing 400.
    expect(route413.status).not.toBe(413);
    expect(capturedFor(route)).toHaveLength(1);
    expect(parseSignedTurnkeyRequest({ body: "x", stamp: { stampHeaderName: "Wrong", stampHeaderValue: "{}" }, url: "u" })).toBeNull();
  });

  it.each(signedRoutes)("$url: a 413 forwards nothing — no signed DELETE or CREATE_AUTHENTICATORS, no replay or dispatch claim, no durable transition, no provider call", async (route) => {
    const huge = JSON.stringify({ ...route.valid, signedRequest: { ...(route.valid.signedRequest as object), padding: "x".repeat(SIGNED_TURNKEY_REQUEST_BODY_MAX_BYTES) } });
    expect(await invoke(route, jsonRequest(route, huge))).toEqual({ status: 413, body: TOO_LARGE });
    expect(capturedFor(route)).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(nonSession(state.events)).toEqual([]); // the enrollment / revocation store (claimReplay, beginDispatch, transitions) was never opened
  });
});

describe("3B-3 login verify — a 413 never reaches registration or provisioning", () => {
  it("an oversized login assertion opens no registration-attempt store, no challenge store, and no registry beyond nothing at all", async () => {
    const route = ASSERTION_ROUTES[0]!;
    const result = await invoke(route, jsonRequest(route, JSON.stringify({ response: { ...ES256_ASSERTION, padding: "x".repeat(WEBAUTHN_ASSERTION_BODY_MAX_BYTES) } })));
    expect(result).toEqual({ status: 413, body: TOO_LARGE });
    expect(state.events).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the store getters login verify uses are all behind the body check (a valid body does reach them)", async () => {
    const route = ASSERTION_ROUTES[0]!;
    await invoke(route, jsonRequest(route, JSON.stringify(route.valid)));
    expect(state.events.length).toBeGreaterThan(0);
  });
});

describe("3B-3 handle claim, step-up options and verify-login confirm — a 413 consumes nothing", () => {
  it.each(ASSERTION_ROUTES.slice(1))("$url: no challenge consumed, no counter update, no handle or enrollment mutation, no provider call", async (route) => {
    const result = await invoke(route, jsonRequest(route, bodyOfBytes(route, WEBAUTHN_ASSERTION_BODY_MAX_BYTES + 1)));
    expect(result).toEqual({ status: 413, body: TOO_LARGE });
    expect(state.events.filter((event) => /^(challengeStore|handleStore|enrollmentStore|revocationStore|rateLimiter|providerBudget|paymentStore|registrationAttempts)\./.test(event))).toEqual([]);
    expect(nonSession(state.events)).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3B-4: WebAuthn registration routes (64 KiB).
// ---------------------------------------------------------------------------

describe("3B-4 registration routes — exact boundaries, with proof the body was PARSED", () => {
  const capturedFor = (route: RouteCase) => state.captured[route.registrationService!];

  it.each(REGISTRATION_ROUTES)("$url: exactly 65 536 bytes is read and the resolver receives the original response; 65 537 is a 413 that reaches nothing", async (route) => {
    const exact = bodyOfBytes(route, WEBAUTHN_REGISTRATION_BODY_MAX_BYTES);
    expect(encoder.encode(exact).byteLength).toBe(65_536);
    const accepted = await invoke(route, jsonRequest(route, exact, { "content-length": "65536" }));
    expect(accepted.status).not.toBe(413);
    // A 401 or an unrelated 500 would not prove anything: the resolver must have been handed the parsed `response`, field for field.
    expect(capturedFor(route)).toEqual([REGISTRATION_RESPONSE]);

    state.captured = state.emptyCaptured();
    state.events = [];
    const over = bodyOfBytes(route, WEBAUTHN_REGISTRATION_BODY_MAX_BYTES + 1);
    expect(encoder.encode(over).byteLength).toBe(65_537);
    expect(await invoke(route, jsonRequest(route, over, { "content-length": "65537" }))).toEqual({ status: 413, body: TOO_LARGE });
    expect(capturedFor(route)).toEqual([]);
    expect(route.sessionFirst ? nonSession(state.events) : state.events).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(REGISTRATION_ROUTES)("$url: a body with no `response` is the existing response-required 400, and the resolver is not called", async (route) => {
    for (const body of ["{}", '{"response":null}', '{"response":false}', '{"other":1}']) {
      const result = await invoke(route, jsonRequest(route, body));
      expect(result, body).toEqual({ status: 400, body: { error: "A WebAuthn registration response is required." } });
    }
    expect(capturedFor(route)).toEqual([]);
  });

  it.each(REGISTRATION_ROUTES)("$url: JSON null, malformed JSON, invalid UTF-8 and an empty body are the existing 'Invalid request body.' 400", async (route) => {
    const invalidUtf8 = new Uint8Array([...encoder.encode('{"response":"'), 0xff, ...encoder.encode('"}')]);
    for (const body of ["null", "{not json", invalidUtf8, ""]) {
      const result = await invoke(route, jsonRequest(route, body));
      expect(result, String(body)).toEqual({ status: 400, body: { error: "Invalid request body." } });
    }
    expect(capturedFor(route)).toEqual([]);
  });

  it.each(REGISTRATION_ROUTES)("$url: a declared length that disagrees with the body is the existing 400; one over the limit is a 413 without reading the stream", async (route) => {
    expect(await invoke(route, jsonRequest(route, JSON.stringify(route.valid), { "content-length": "5" }))).toEqual({ status: 400, body: { error: "Invalid request body." } });
    expect(await invoke(route, jsonRequest(route, "{}", { "content-length": "65537" }))).toEqual({ status: 413, body: TOO_LARGE });
    expect(capturedFor(route)).toEqual([]);
  });

  it.each(REGISTRATION_ROUTES)("$url: an oversized STREAMED body (no Content-Length) is a 413 and the stream is cancelled", async (route) => {
    let pulls = 0;
    let cancelled = false;
    const chunk = encoder.encode("x".repeat(20_000));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls <= 8) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request(`http://localhost${route.url}`, { method: route.method, headers: { "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit & { duplex: "half" });
    expect(await invoke(route, request)).toEqual({ status: 413, body: TOO_LARGE });
    await Promise.resolve();
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(8); // it stopped asking once the limit was crossed
    expect(capturedFor(route)).toEqual([]);
  });

  it.each(REGISTRATION_ROUTES)("$url: UTF-8 multibyte bytes are counted as bytes (a body short in characters but over 64 KiB is refused)", async (route) => {
    const euro = String.fromCharCode(0x20ac);
    const body = JSON.stringify({ ...route.valid, _pad: euro.repeat(Math.floor(WEBAUTHN_REGISTRATION_BODY_MAX_BYTES / 3) + 1) });
    expect(body.length).toBeLessThan(WEBAUTHN_REGISTRATION_BODY_MAX_BYTES);
    expect(encoder.encode(body).byteLength).toBeGreaterThan(WEBAUTHN_REGISTRATION_BODY_MAX_BYTES);
    expect(await invoke(route, jsonRequest(route, body))).toEqual({ status: 413, body: TOO_LARGE });
  });
});

describe("3B-4 registration fixtures — complete envelopes stay far below 64 KiB and arrive unchanged", () => {
  const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
  const b64 = (count: number) => "A".repeat(Math.ceil((count * 4) / 3));
  /** A synthetic startRegistration()-shaped response built from per-field BYTE sizes (base64url length ~ 4/3 of that). */
  const synthetic = (sizes: { credentialId: number; clientDataJSON: number; authenticatorData: number; publicKey: number; attestationObject: number; extensionResults?: number; transports?: string[]; publicKeyAlgorithm?: number }) => ({
    id: b64(sizes.credentialId),
    rawId: b64(sizes.credentialId),
    response: {
      clientDataJSON: b64(sizes.clientDataJSON),
      attestationObject: b64(sizes.attestationObject),
      authenticatorData: b64(sizes.authenticatorData),
      transports: sizes.transports ?? ["internal"],
      publicKeyAlgorithm: sizes.publicKeyAlgorithm ?? -7,
      publicKey: b64(sizes.publicKey),
    },
    authenticatorAttachment: "platform",
    clientExtensionResults: sizes.extensionResults ? { credProps: { rk: true }, largeBlob: { supported: true, blob: b64(sizes.extensionResults) } } : { credProps: { rk: true } },
    type: "public-key",
  });
  // A certificate is typically 0.5-1.5 KiB; "synthetic chain" below stacks several, with the leaf, an intermediate and a root.
  const CERT = 1500;
  const SHAPES: Record<string, unknown> = {
    "real offline ES256 fixture (format none)": REGISTRATION_RESPONSE,
    "ES256 full startRegistration shape, 16-byte credential id": synthetic({ credentialId: 16, clientDataJSON: 150, authenticatorData: 200, publicKey: 91, attestationObject: 300 }),
    "ES256 full startRegistration shape, 32-byte credential id": synthetic({ credentialId: 32, clientDataJSON: 150, authenticatorData: 200, publicKey: 91, attestationObject: 300 }),
    "ES256 full startRegistration shape, 64-byte credential id": synthetic({ credentialId: 64, clientDataJSON: 150, authenticatorData: 230, publicKey: 91, attestationObject: 330 }),
    "RS256-shaped (294-byte SubjectPublicKeyInfo, 2048-bit)": synthetic({ credentialId: 32, clientDataJSON: 150, authenticatorData: 420, publicKey: 294, attestationObject: 700, publicKeyAlgorithm: -257 }),
    "RS256-shaped (550-byte public key, 4096-bit)": synthetic({ credentialId: 32, clientDataJSON: 150, authenticatorData: 700, publicKey: 550, attestationObject: 1100, publicKeyAlgorithm: -257 }),
    "1023-byte credential id (the WebAuthn maximum)": synthetic({ credentialId: 1023, clientDataJSON: 150, authenticatorData: 1200, publicKey: 91, attestationObject: 1500 }),
    "large authenticatorData": synthetic({ credentialId: 64, clientDataJSON: 150, authenticatorData: 4096, publicKey: 91, attestationObject: 4300 }),
    "large publicKey": synthetic({ credentialId: 64, clientDataJSON: 150, authenticatorData: 600, publicKey: 2048, attestationObject: 900 }),
    "packed attestation with a synthetic certificate chain (3 certs)": synthetic({ credentialId: 32, clientDataJSON: 150, authenticatorData: 250, publicKey: 91, attestationObject: 3 * CERT + 400 }),
    "TPM-shaped attestation (certInfo + pubArea + AIK chain)": synthetic({ credentialId: 32, clientDataJSON: 150, authenticatorData: 300, publicKey: 294, attestationObject: 4 * CERT + 1200, publicKeyAlgorithm: -257 }),
    "Android-key-shaped (certificate chain of 4 + extensions)": synthetic({ credentialId: 32, clientDataJSON: 150, authenticatorData: 250, publicKey: 91, attestationObject: 4 * CERT + 800, transports: ["internal", "hybrid"] }),
    "Apple-shaped (anonymous attestation, 2-cert chain)": synthetic({ credentialId: 20, clientDataJSON: 150, authenticatorData: 250, publicKey: 91, attestationObject: 2 * CERT + 300 }),
    "generous synthetic worst case (every field generous, 6-cert chain, 4 KiB extensions)": synthetic({ credentialId: 1023, clientDataJSON: 1024, authenticatorData: 8192, publicKey: 2048, attestationObject: 6 * CERT + 6000, extensionResults: 4096, transports: ["usb", "nfc", "ble", "internal", "hybrid", "smart-card"] }),
  };

  it("every shape, as the complete serialized request envelope, is measured in real UTF-8 bytes and sits below the 64 KiB limit", () => {
    const sizes = Object.entries(SHAPES).map(([name, response]) => [name, bytes({ response })] as const);
    for (const [name, size] of sizes) expect(size, name).toBeLessThan(WEBAUTHN_REGISTRATION_BODY_MAX_BYTES);
    // The extreme synthetic still leaves headroom, and the sizes are monotone in the way the shapes were built.
    const worst = Math.max(...sizes.map(([, size]) => size));
    expect(worst).toBeLessThan(WEBAUTHN_REGISTRATION_BODY_MAX_BYTES * 0.75);
    expect(sizes[0]![1]).toBeLessThan(worst);
    // Measuring with the Buffer API gives the same figure as TextEncoder.
    for (const [, response] of Object.entries(SHAPES)) expect(Buffer.byteLength(JSON.stringify({ response }), "utf8")).toBe(bytes({ response }));
  });

  it.each(REGISTRATION_ROUTES)("$url: every shape reaches the resolver with values IDENTICAL to what the legacy request.json() reader produced", async (route) => {
    for (const [name, response] of Object.entries(SHAPES)) {
      state.captured = state.emptyCaptured();
      state.events = [];
      const text = JSON.stringify({ response });
      const legacy = (await new Request("http://localhost/x", { method: "POST", body: text }).json()) as { response: unknown };
      const result = await invoke(route, jsonRequest(route, text));
      expect(result.status, name).not.toBe(413);
      expect(state.captured[route.registrationService!], name).toEqual([legacy.response]);
    }
  });

  it.each(REGISTRATION_ROUTES)("$url: credential data is passed through byte-for-byte — no trim, no case-folding, no Unicode normalization, no re-serialization", async (route) => {
    const eDecomposed = "e" + String.fromCharCode(0x0301);
    const nbsp = String.fromCharCode(0x00a0);
    const tricky = {
      id: "AbC-_dEf0123456789AbC-_dEf0123456789AbC",
      rawId: " AbC-_dEf0123456789AbC-_dEf0123456789AbC ",
      response: {
        clientDataJSON: "  eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0  ",
        attestationObject: "o2NmbXRkbm9uZQ==\n",
        authenticatorData: "MIXED-case_Base64Url",
        publicKey: "0xAbCdEf0123456789",
        transports: ["INTERNAL", "Hybrid", eDecomposed],
      },
      clientExtensionResults: { Key: { "": null, UPPER: 1.0, nested: [0, -0, 1e21] } },
      type: "public-key",
      extra: `The  Quick\tBrown${nbsp}Fox`,
    };
    const compact = JSON.stringify({ response: tricky });
    const pretty = JSON.stringify({ response: tricky }, null, 3);
    for (const text of [compact, pretty]) {
      state.captured = state.emptyCaptured();
      await invoke(route, jsonRequest(route, text));
      const received = state.captured[route.registrationService!][0] as typeof tricky;
      expect(received).toEqual(JSON.parse(text).response);
      expect(received.rawId).toBe(" AbC-_dEf0123456789AbC-_dEf0123456789AbC ");
      expect(received.response.clientDataJSON).toBe("  eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0  ");
      expect(received.response.attestationObject).toBe("o2NmbXRkbm9uZQ==\n");
      expect(received.response.publicKey).toBe("0xAbCdEf0123456789");
      expect(received.response.transports).toEqual(["INTERNAL", "Hybrid", eDecomposed]);
      expect(received.extra).toBe(`The  Quick\tBrown${nbsp}Fox`);
    }
  });

  it("the real fixture is nowhere near the limit", () => {
    expect(bytes({ response: REGISTRATION_RESPONSE })).toBeLessThan(WEBAUTHN_REGISTRATION_BODY_MAX_BYTES / 20);
  });
});

describe("3B-4 primary registration — a 413 reaches nothing durable and sets no cookie", () => {
  const route = REGISTRATION_ROUTES[0]!;

  it("an oversized registration makes zero challenge, attempt, registry, provisioning, database, cookie or provider operations", async () => {
    const result = await invoke(route, jsonRequest(route, JSON.stringify({ response: { ...REGISTRATION_RESPONSE, padding: "x".repeat(WEBAUTHN_REGISTRATION_BODY_MAX_BYTES) } })));
    expect(result).toEqual({ status: 413, body: TOO_LARGE });
    expect(state.events).toEqual([]); // no challengeStore.*, registrationAttempts.*, registry.*, or cookies.set
    expect(state.captured.registration).toEqual([]); // completeRegistration (and so createVerified / provisioning) never ran
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a valid request does reach the registration service (the same harness sees the operations a 413 must not)", async () => {
    await invoke(route, jsonRequest(route, JSON.stringify(route.valid)));
    expect(state.captured.registration).toEqual([REGISTRATION_RESPONSE]);
    expect(state.events.length).toBeGreaterThan(0);
  });
});

describe("3B-4 backup registration — a 413 reaches nothing durable and keeps the session read first", () => {
  const route = REGISTRATION_ROUTES[1]!;

  it("an authenticated oversized request: 413 with only the two session reads, no challenge, enrollment, credential registration or provider call", async () => {
    const result = await invoke(route, jsonRequest(route, JSON.stringify({ response: { ...REGISTRATION_RESPONSE, padding: "x".repeat(WEBAUTHN_REGISTRATION_BODY_MAX_BYTES) } })));
    expect(result).toEqual({ status: 413, body: TOO_LARGE });
    expect(state.events).toEqual(SESSION_READS); // exactly the two read-only session-registry reads, in order, and nothing else
    expect(state.captured.backupRegistration).toEqual([]); // completeBackupCredentialRegistration never ran
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a valid authenticated request does reach the backup registration service", async () => {
    await invoke(route, jsonRequest(route, JSON.stringify(route.valid)));
    expect(state.captured.backupRegistration).toEqual([REGISTRATION_RESPONSE]);
  });
});

describe("3B-4 gate compatibility for the registration routes", () => {
  const GATE_ENV = { NEXT_PUBLIC_REAL_MODE_ENABLED: "true", NEXT_PUBLIC_REAL_ORIGIN: "http://localhost:3000" };
  const gate = (request: Request) => checkRealApiRequest(request, GATE_ENV);
  const build = (route: RouteCase, body: string, extra: Record<string, string>) =>
    new Request(`http://localhost${route.url}`, { method: route.method, headers: { "content-type": "application/json", origin: "http://localhost:3000", ...extra }, body });

  it.each(REGISTRATION_ROUTES)("$url: a body under 64 KiB is admitted by the gate and handled by the route", async (route) => {
    const body = JSON.stringify(route.valid);
    const declared = { "content-length": String(Buffer.byteLength(body, "utf8")) };
    expect(gate(build(route, body, declared))).toBeNull();
    await invoke(route, build(route, body, declared));
    expect(state.captured[route.registrationService!]).toEqual([REGISTRATION_RESPONSE]);
  });

  it.each(REGISTRATION_ROUTES)("$url: a body between 64 KiB and 10 MiB is admitted by the gate and refused 413 by the route", async (route) => {
    const body = bodyOfBytes(route, 200_000);
    const declared = { "content-length": "200000" };
    expect(gate(build(route, body, declared))).toBeNull();
    expect(await invoke(route, build(route, body, declared))).toEqual({ status: 413, body: TOO_LARGE });
  });

  it.each(REGISTRATION_ROUTES)("$url: declared 10 MiB passes the gate and is a route 413; 10 MiB + 1 is the gate's 413; no length at all is the gate's 411", async (route) => {
    const atCeiling = { "content-length": String(REAL_API_MAX_BODY_BYTES) };
    expect(gate(build(route, "{}", atCeiling))).toBeNull();
    expect(await invoke(route, build(route, "{}", atCeiling))).toEqual({ status: 413, body: TOO_LARGE });
    const over = gate(build(route, "{}", { "content-length": String(REAL_API_MAX_BODY_BYTES + 1) }));
    expect(over?.status).toBe(413);
    expect(await over?.json()).toEqual(TOO_LARGE);
    expect(gate(build(route, "{}", {}))?.status).toBe(411);
  });

  it.each(REGISTRATION_ROUTES)("$url: the 403 and 415 checks still come first", (route) => {
    expect(gate(build(route, "{}", { origin: "https://evil.example" }))?.status).toBe(403);
    expect(gate(new Request(`http://localhost${route.url}`, { method: route.method, headers: { "content-type": "text/plain", origin: "http://localhost:3000", "content-length": "2" }, body: "{}" }))?.status).toBe(415);
  });
});

// ---------------------------------------------------------------------------
// 3B-2: the request gate in front of the 3B-1 routes.
// ---------------------------------------------------------------------------

describe("3B-2 gate + route together — each route's own limit still applies to what the 10 MiB gate admits", () => {
  const GATE_ENV = { NEXT_PUBLIC_REAL_MODE_ENABLED: "true", NEXT_PUBLIC_REAL_ORIGIN: "http://localhost:3000" };
  const gate = (request: Request) => checkRealApiRequest(request, GATE_ENV);
  const withHeaders = (route: RouteCase, body: string, extra: Record<string, string>) =>
    new Request(`http://localhost${route.url}`, { method: route.method, headers: { "content-type": "application/json", origin: "http://localhost:3000", ...extra }, body });

  it.each(ROUTES)("$url: a body one byte over the route's own limit, with an honest Content-Length, passes the gate and is refused 413 by the route", async (route) => {
    const body = bodyOfBytes(route, route.limit + 1);
    const declared = { "content-length": String(route.limit + 1) };
    expect(gate(withHeaders(route, body, declared))).toBeNull();
    expect(await invoke(route, withHeaders(route, body, declared))).toEqual({ status: 413, body: TOO_LARGE });
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

  it.each(ROUTES)("$url: no Content-Length at all is refused 411 by the gate before the route; a directly invoked handler still counts the bytes", async (route) => {
    expect(gate(withHeaders(route, "{}", {}))?.status).toBe(411);
    expect(await invoke(route, withHeaders(route, bodyOfBytes(route, route.limit + 1), {}))).toEqual({ status: 413, body: TOO_LARGE });
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


describe("source guards — the 22 bounded routes (14 control, 4 assertion, 2 signed, 2 registration)", () => {
  it("the inventory is exactly 14 + 4 + 2 + 2 = 22 distinct routes, each with the right method and family constant", () => {
    expect(ROUTES).toHaveLength(22);
    expect(new Set(ROUTES.map((route) => route.file)).size).toBe(22);
    expect(ROUTES.filter((route) => route.limitName === "CONTROL_BODY_MAX_BYTES")).toHaveLength(14);
    expect(ROUTES.filter((route) => route.limitName === "WEBAUTHN_ASSERTION_BODY_MAX_BYTES").map((route) => route.url)).toEqual([
      "/api/real/account/login/verify",
      "/api/real/account/handle/claim",
      "/api/real/account/passkeys/backup/options",
      "/api/real/account/passkeys/backup/verify-login/confirm",
    ]);
    expect(ROUTES.filter((route) => route.limitName === "SIGNED_TURNKEY_REQUEST_BODY_MAX_BYTES").map((route) => route.url)).toEqual([
      "/api/real/account/passkeys/credential-1/revoke/submit",
      "/api/real/account/passkeys/backup/authorize/submit",
    ]);
    expect(ROUTES.filter((route) => route.method === "PATCH").map((route) => route.url)).toEqual(["/api/real/account/profile", "/api/real/account/passkeys/credential-1"]);
    expect(ROUTES.filter((route) => route.limitName === "WEBAUTHN_REGISTRATION_BODY_MAX_BYTES").map((route) => route.url)).toEqual([
      "/api/real/account/register/verify",
      "/api/real/account/passkeys/backup/register",
    ]);
    expect(ROUTES.filter((route) => route.method === "POST")).toHaveLength(20);
    // The limit each route is tested with is the very constant it names.
    const byName = { CONTROL_BODY_MAX_BYTES, WEBAUTHN_ASSERTION_BODY_MAX_BYTES, SIGNED_TURNKEY_REQUEST_BODY_MAX_BYTES, WEBAUTHN_REGISTRATION_BODY_MAX_BYTES };
    for (const route of ROUTES) expect(route.limit, route.file).toBe(byName[route.limitName]);
  });

  it.each(ROUTES)("$file reads its body only through the bounded reader with its family policy ($limitName)", (route) => {
    const source = code(read(route.file));
    expect(source.match(/readBoundedJsonBody\(/g)).toHaveLength(1);
    expect(source).toContain(`readBoundedJsonBody(request, ${route.limitName})`);
    // It names exactly one policy constant — never another family's.
    for (const other of ["CONTROL_BODY_MAX_BYTES", "WEBAUTHN_ASSERTION_BODY_MAX_BYTES", "SIGNED_TURNKEY_REQUEST_BODY_MAX_BYTES", "WEBAUTHN_REGISTRATION_BODY_MAX_BYTES"]) {
      if (other !== route.limitName) expect(source, other).not.toContain(other);
    }
    expect(source).toMatch(/bounded\.kind === "too_large"\) return requestTooLargeResponse\(\)/);
    expect(source).toContain('bounded.kind === "ok" ? bounded.value : null');
    expect(source).toContain(`export async function ${route.method}(`);
    // No second, unbounded way to read the body, and no inline size number.
    expect(source).not.toContain("readJsonBody");
    expect(source).not.toMatch(/\.(json|text|arrayBuffer|blob|formData|bytes)\(\)/);
    expect(source).not.toMatch(/request\.body\b|\breq\.(json|text|arrayBuffer|formData|blob|body)\b/);
    expect(source).not.toMatch(/\b4096\b|\b4 \* 1024\b|1024 \*|\b16384\b|\b16_384\b|\b65536\b|\b65_536\b|\b10485760\b|\b10_485_760\b|\b64 \* 1024\b|\b16 \* 1024\b/);
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

describe("source guards — no body-reading route uses the legacy unbounded reader", () => {
  it("every body-reading route in app/api is one of the 22 bounded routes — all 22 accounted for, none counted twice, nothing new", () => {
    const bodyReaders = routeFiles(path.join(root, "app/api"))
      .map((file) => path.relative(root, file))
      .filter((file) => /readBoundedJsonBody|\breadJsonBody\b|\brequest\.(json|text|arrayBuffer|formData|blob|body)\b|\breq\.(json|text|arrayBuffer|formData|blob|body)\b/.test(code(read(file))))
      .sort();
    expect(bodyReaders).toEqual(ROUTES.map((route) => route.file).sort());
    expect(bodyReaders).toHaveLength(22);
    expect(new Set(bodyReaders).size).toBe(22);
    // All 22 use the bounded reader, exactly once; none uses anything else.
    for (const file of bodyReaders) {
      const source = code(read(file));
      expect(source.match(/readBoundedJsonBody\(/g), file).toHaveLength(1);
      expect(source, file).not.toMatch(/\breadJsonBody\b/);
    }
  });

  it("readJsonBody has no production caller anywhere in app/ or lib/, and http.ts no longer defines it", () => {
    const walk = (directory: string): string[] =>
      readdirSync(directory).flatMap((entry) => {
        const full = path.join(directory, entry);
        if (statSync(full).isDirectory()) return walk(full);
        return /\.(ts|tsx|mjs|js)$/.test(entry) ? [full] : [];
      });
    const callers = [...walk(path.join(root, "app")), ...walk(path.join(root, "lib")), ...walk(path.join(root, "components"))]
      .filter((file) => /\breadJsonBody\b/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(root, file));
    expect(callers).toEqual([]);
    expect(code(read("lib/real/server/http.ts"))).not.toMatch(/\breadJsonBody\b/);
  });
});

describe("source guards — the shared reader", () => {
  const http = code(read("lib/real/server/http.ts"));
  const reader = http.slice(http.indexOf("export async function readBoundedJsonBody"), http.indexOf("export { isRealModeEnabled }"));

  it("the three family policies are single constants in http.ts with the approved values, and no production limits module was created", () => {
    expect(http.match(/export const CONTROL_BODY_MAX_BYTES = 4096;/g)).toHaveLength(1);
    expect(http.match(/export const WEBAUTHN_ASSERTION_BODY_MAX_BYTES = 16_384;/g)).toHaveLength(1);
    expect(http.match(/export const SIGNED_TURNKEY_REQUEST_BODY_MAX_BYTES = 65_536;/g)).toHaveLength(1);
    expect(http.match(/export const WEBAUTHN_REGISTRATION_BODY_MAX_BYTES = 65_536;/g)).toHaveLength(1);
    expect(CONTROL_BODY_MAX_BYTES).toBe(4096);
    // The constants live in http.ts: there is no separate limits module.
    const serverFiles = readdirSync(path.join(root, "lib/real/server"));
    expect(serverFiles.filter((name) => /body-?limit|request-?limit|size-?limit/i.test(name))).toEqual([]);
  });

  it("the policy hierarchy: control < assertion < registration < the 10 MiB gate, and signed < the gate (signed and registration may be equal)", () => {
    expect(CONTROL_BODY_MAX_BYTES).toBeLessThan(WEBAUTHN_ASSERTION_BODY_MAX_BYTES);
    expect(WEBAUTHN_ASSERTION_BODY_MAX_BYTES).toBeLessThan(WEBAUTHN_REGISTRATION_BODY_MAX_BYTES);
    expect(WEBAUTHN_REGISTRATION_BODY_MAX_BYTES).toBeLessThan(REAL_API_MAX_BODY_BYTES);
    expect(WEBAUTHN_ASSERTION_BODY_MAX_BYTES).toBeLessThan(SIGNED_TURNKEY_REQUEST_BODY_MAX_BYTES);
    expect(SIGNED_TURNKEY_REQUEST_BODY_MAX_BYTES).toBeLessThan(REAL_API_MAX_BODY_BYTES);
    expect(WEBAUTHN_REGISTRATION_BODY_MAX_BYTES).toBe(65_536);
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
