import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createInMemoryRealAccountRegistry, getInMemoryRegistryInternals } from "@/lib/real/server/registry";
import { createInMemoryPasskeyRevocationStore } from "@/lib/real/server/passkey-revocation-attempts";
import { createInMemoryBackupPasskeyEnrollmentStore } from "@/lib/real/server/backup-passkey-enrollment";
import { createInMemoryChallengeStore } from "@/lib/real/server/challenge-store";
import { createInMemoryAccountHandleStore } from "@/lib/real/server/account-handles";
import { createSessionPayload, serializeSession } from "@/lib/real/server/session";
import type { PaymentAttemptStore } from "@/lib/real/server/payment-attempts";
import { GENERIC_SERVER_ERROR_MESSAGE } from "@/lib/real/server/http";
import { createPublicClient, custom, encodeAbiParameters } from "viem";
import { baseSepolia } from "viem/chains";
import { rpcBlock } from "./fixtures/chain-block";
import { openBudget, scriptedBudget } from "./fixtures/chain-read-budget";
import { recordingRateLimiter } from "./fixtures/rate-limit";

/**
 * Pre-2f hardening: this repo's other tests exercise the resolveX functions
 * directly, never a route.ts GET/POST export — those call next/headers'
 * cookies(), which throws outside a live Next request scope. These three
 * tests exercise the ACTUAL route handler code (not a reimplementation),
 * mocking only next/headers' cookies() and the handful of env vars
 * requireRealServerConfig()/isRealModeEnabled() need. One test per
 * representative route family: a JSON-body route, an [id] route, and a
 * generic-500 proof — not all twelve routes.
 */

// 32 random-looking bytes, hex — REAL_SESSION_SECRET must pass the S4 strength check.
const REAL_SESSION_SECRET_VALUE = "7f3c9a1e5b2d4f60a8c7e9b1d3f5a7c90e2b4d6f8a1c3e5b7d9f0a2c4e6b8d0f";
const OWNER_ADDRESS = "0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF";
const SAFE_ADDRESS = "0xd9a4c22fb34dc74317edc8006140d66c8fa03266";

function stubRequiredConfigEnv() {
  vi.stubEnv("NEXT_PUBLIC_REAL_MODE_ENABLED", "true");
  vi.stubEnv("TURNKEY_PARENT_ORGANIZATION_ID", "sub-org-1");
  vi.stubEnv("TURNKEY_API_PUBLIC_KEY", "public-key");
  vi.stubEnv("TURNKEY_API_PRIVATE_KEY", "private-key");
  vi.stubEnv("REAL_SESSION_SECRET", REAL_SESSION_SECRET_VALUE);
  vi.stubEnv("NEXT_PUBLIC_REAL_RP_ID", "localhost");
  vi.stubEnv("NEXT_PUBLIC_REAL_ORIGIN", "http://localhost:3000");
  vi.stubEnv("PIMLICO_API_KEY", "pim_test_key");
}

function makeCookieJar(cookiesMap: Record<string, string> = {}) {
  return {
    get: (name: string) => (name in cookiesMap ? { value: cookiesMap[name] } : undefined),
    set: () => {},
    delete: () => {},
  };
}

async function seedRegistry() {
  const registry = createInMemoryRealAccountRegistry();
  await registry.createAccountWithPasskey({
    account: {
      appUserId: "app-user-1",
      subOrganizationId: "sub-org-1",
      turnkeyUserId: "turnkey-user-1",
      walletId: "wallet-1",
      walletAccountId: "wallet-account-1",
      ownerAddress: OWNER_ADDRESS,
      safeAddress: SAFE_ADDRESS,
      accountConfigVersion: 1,
    },
    passkey: {
      credentialId: "credential-1",
      appUserId: "app-user-1",
      credentialPublicKey: "cose-key",
      userHandle: "user-handle-1",
      counter: 0,
      transports: ["internal"],
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
    },
  });
  return registry;
}

/** A deliberate trap: mirrors what the real Neon adapter does (a raw Postgres error) for a non-UUID id, so this test fails loudly if the isValidUuid guard in resolveCancelPayment ever regresses. */
function createTrapPaymentAttemptStore(): PaymentAttemptStore {
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return {
    reserve: async () => {
      throw new Error("not used in this test");
    },
    reserveHandlePayment: async () => {
      throw new Error("not used in this test");
    },
    findById: async (id: string) => {
      if (!UUID_PATTERN.test(id)) {
        throw new Error(`invalid input syntax for type uuid: "${id}"`);
      }
      return null;
    },
    findLatestByAppUserId: async () => null,
    findRecentByAppUserId: async () => [],
    transition: async () => {
      throw new Error("not used in this test");
    },
    beginDispatch: async () => {
      throw new Error("not used in this test");
    },
  };
}

describe("route handlers — pre-2f hardening (actual route.ts code, not resolver reimplementations)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("POST /api/real/payments/prepare: a malformed JSON body returns a clean 400, not a 500", async () => {
    vi.resetModules();
    stubRequiredConfigEnv();
    vi.doMock("next/headers", () => ({ cookies: async () => makeCookieJar() }));

    const { POST } = await import("@/app/api/real/payments/prepare/route");
    const request = new Request("http://localhost/api/real/payments/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Invalid request body.");
  });

  it("POST /api/real/payments/[id]/cancel: a malformed (non-UUID) id returns 404, never a raw Postgres error", async () => {
    vi.resetModules();
    stubRequiredConfigEnv();
    const registry = await seedRegistry();
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), REAL_SESSION_SECRET_VALUE);
    const { REAL_SESSION_COOKIE_NAME } = await import("@/lib/real/server/session");
    vi.doMock("next/headers", () => ({ cookies: async () => makeCookieJar({ [REAL_SESSION_COOKIE_NAME]: cookieValue }) }));
    const trapStore = createTrapPaymentAttemptStore();
    vi.doMock("@/lib/real/server/runtime", () => ({
      getRealAccountRegistry: () => registry,
      getPaymentAttemptStore: () => trapStore,
      getChallengeStore: () => {
        throw new Error("not used in this test");
      },
      getRegistrationAttemptStore: () => {
        throw new Error("not used in this test");
      },
    }));

    const { POST } = await import("@/app/api/real/payments/[id]/cancel/route");
    const response = await POST(new NextRequest("http://localhost/api/real/payments/not-a-uuid/cancel", { method: "POST" }), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).not.toMatch(/invalid input syntax|uuid/i);
  });

  it("GET /api/real/payments/latest: an unexpected internal exception returns the fixed generic 500 body, never raw connection/DB text", async () => {
    vi.resetModules();
    stubRequiredConfigEnv();
    vi.doMock("next/headers", () => ({ cookies: async () => makeCookieJar() }));
    vi.doMock("@/lib/real/server/runtime", () => ({
      getRealAccountRegistry: () => {
        throw new Error("ECONNREFUSED postgres://user:pass@host/db");
      },
      getPaymentAttemptStore: () => {
        throw new Error("not used in this test");
      },
      getChallengeStore: () => {
        throw new Error("not used in this test");
      },
      getRegistrationAttemptStore: () => {
        throw new Error("not used in this test");
      },
    }));

    const { GET } = await import("@/app/api/real/payments/latest/route");
    const response = await GET();

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(GENERIC_SERVER_ERROR_MESSAGE);
    expect(body.error).not.toMatch(/ECONNREFUSED|postgres:\/\//);
  });
});

describe("POST /api/real/payments/submit — Slice S1 attribution contract (actual route.ts code)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("@turnkey/http");
  });

  const SIGNATURE = `0x${"00".repeat(12)}${"11".repeat(64)}1b`;

  async function setup(sessionCredentialId: string, limiter: ReturnType<typeof openBudget> = openBudget()) {
    vi.resetModules();
    stubRequiredConfigEnv();
    const registry = await seedRegistry();
    const primary = (await registry.findPasskeyByCredentialId("credential-1"))!;
    getInMemoryRegistryInternals(registry).passkeysByCredentialId.set("credential-backup", { ...primary, credentialId: "credential-backup", role: "backup" });
    const { createInMemoryPaymentAttemptStore } = await import("@/lib/real/server/payment-attempts");
    const paymentStore = createInMemoryPaymentAttemptStore();
    const reserved = await paymentStore.reserve({ appUserId: "app-user-1", safeAddress: SAFE_ADDRESS, recipient: "0x2222222222222222222222222222222222222222", amountBaseUnits: "10000", chainId: 84532, tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", authorizingCredentialId: "credential-1" });
    if (!reserved.ok) throw new Error("expected reservation");
    await paymentStore.transition({
      id: reserved.attempt.id,
      from: "prepared",
      to: "awaiting_authorization",
      patch: { nonce: "0", callData: "0x1234", callGasLimit: "80000", verificationGasLimit: "150000", preVerificationGas: "60000", maxFeePerGas: "2000000", maxPriorityFeePerGas: "1000000", expectedUserOperationHash: `0x${"ab".repeat(32)}`, validUntil: Math.floor(Date.now() / 1000) + 600, prepareBlockNumber: "1" },
    });
    const { REAL_SESSION_COOKIE_NAME } = await import("@/lib/real/server/session");
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: sessionCredentialId, sessionEpoch: 0 }), REAL_SESSION_SECRET_VALUE);
    vi.doMock("next/headers", () => ({ cookies: async () => makeCookieJar({ [REAL_SESSION_COOKIE_NAME]: cookieValue }) }));
    vi.doMock("@/lib/real/server/runtime", () => ({ getRealAccountRegistry: () => registry, getPaymentAttemptStore: () => paymentStore, getProviderBudgetLimiter: () => limiter }));
    const turnkeyReads = { count: 0 };
    // Turnkey is unreachable: the parent-key read-back throws.
    vi.doMock("@turnkey/http", () => ({
      TurnkeyClient: vi.fn().mockImplementation(function TurnkeyClientMock() {
        return {
          getActivity: async () => {
            turnkeyReads.count += 1;
            throw new Error("ECONNRESET api.turnkey.com");
          },
          getUsers: async () => ({ users: [] }),
        };
      }),
    }));
    const { POST } = await import("@/app/api/real/payments/submit/route");
    const submit = (body: object) => POST(new Request("http://localhost/api/real/payments/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    return { submit, paymentStore, attemptId: reserved.attempt.id, turnkeyReads };
  }

  it("Slice 3A-2: an exhausted submit budget is 429 { code: 'rate_limited', retryable: true } with Retry-After — no Turnkey read, the row unchanged", async () => {
    const { limiter, calls } = scriptedBudget({ allowed: false, retryAfterSeconds: 90 });
    const { submit, paymentStore, attemptId, turnkeyReads } = await setup("credential-1", limiter);
    const before = structuredClone(await paymentStore.findById(attemptId));

    const response = await submit({ attemptId, signature: SIGNATURE, activityId: "activity-1" });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("90");
    expect(await response.json()).toEqual({ error: "Too many tries right now. Wait a moment, then tap Continue.", code: "rate_limited", retryable: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.subject).toBe("app-user-1");
    expect(turnkeyReads.count).toBe(0);
    expect(await paymentStore.findById(attemptId)).toEqual(before);
  });

  it("Slice 3A-2: a failing budget (e.g. its table is missing) is the generic 500 — no Turnkey read, the row unchanged, no database text", async () => {
    const { limiter } = scriptedBudget(new Error('relation "real_provider_budgets" does not exist'));
    const { submit, paymentStore, attemptId, turnkeyReads } = await setup("credential-1", limiter);

    const response = await submit({ attemptId, signature: SIGNATURE, activityId: "activity-1" });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: GENERIC_SERVER_ERROR_MESSAGE });
    expect(turnkeyReads.count).toBe(0);
    expect((await paymentStore.findById(attemptId))?.state).toBe("awaiting_authorization");
  });

  it("no activity id: 400 before the row is touched — a signature alone is never enough", async () => {
    const { submit, paymentStore, attemptId } = await setup("credential-1");
    const response = await submit({ attemptId, signature: SIGNATURE });
    expect(response.status).toBe(400);
    expect((await paymentStore.findById(attemptId))?.state).toBe("awaiting_authorization");
  });

  it("another passkey's session: 409 with the start-a-new-payment message; the row is unchanged", async () => {
    const { submit, paymentStore, attemptId } = await setup("credential-backup");
    const response = await submit({ attemptId, signature: SIGNATURE, activityId: "activity-1", authorizingCredentialId: "credential-backup" });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/started with a different passkey/);
    expect(await paymentStore.findById(attemptId)).toMatchObject({ state: "awaiting_authorization", authorizingCredentialId: "credential-1" });
  });

  it("Turnkey unreachable: 503 { retryable: true } with a fixed message (never upstream text); nothing changes", async () => {
    const { submit, paymentStore, attemptId } = await setup("credential-1");
    const response = await submit({ attemptId, signature: SIGNATURE, activityId: "activity-1" });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string; retryable: boolean };
    expect(body.retryable).toBe(true);
    expect(body.error).not.toMatch(/ECONNRESET|turnkey\.com/);
    expect((await paymentStore.findById(attemptId))?.state).toBe("awaiting_authorization");
  });
});

describe("PATCH /api/real/account/passkeys/[credentialId] — rename (actual route.ts code)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Two accounts; the session (when signedIn) is app-user-1 / credential-1. */
  async function setup({ signedIn = true } = {}) {
    vi.resetModules();
    stubRequiredConfigEnv();
    const registry = await seedRegistry();
    await registry.createAccountWithPasskey({
      account: { appUserId: "app-user-2", subOrganizationId: "sub-org-2", turnkeyUserId: "turnkey-user-2", walletId: "wallet-2", walletAccountId: "wallet-account-2", ownerAddress: "0x2222222222222222222222222222222222222201", safeAddress: "0x2222222222222222222222222222222222222202", accountConfigVersion: 1 }, // S5 L2: distinct identity
      passkey: { credentialId: "credential-2", appUserId: "app-user-2", credentialPublicKey: "cose-key-2", userHandle: "user-handle-2", counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false },
    });
    const { REAL_SESSION_COOKIE_NAME } = await import("@/lib/real/server/session");
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), REAL_SESSION_SECRET_VALUE);
    vi.doMock("next/headers", () => ({ cookies: async () => makeCookieJar(signedIn ? { [REAL_SESSION_COOKIE_NAME]: cookieValue } : {}) }));
    const revocations = createInMemoryPasskeyRevocationStore(registry);
    const enrollments = createInMemoryBackupPasskeyEnrollmentStore(registry);
    vi.doMock("@/lib/real/server/runtime", () => ({
      getRealAccountRegistry: () => registry,
      getPasskeyRevocationStore: () => revocations,
      getBackupPasskeyEnrollmentStore: () => enrollments,
    }));
    const { PATCH } = await import("@/app/api/real/account/passkeys/[credentialId]/route");
    const rename = (credentialId: string, body: string) =>
      PATCH(new NextRequest(`http://localhost/api/real/account/passkeys/${credentialId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body }), {
        params: Promise.resolve({ credentialId }),
      });
    return { registry, rename };
  }

  it("without a session: 401, nothing renamed", async () => {
    const { registry, rename } = await setup({ signedIn: false });
    const response = await rename("credential-1", JSON.stringify({ displayName: "iPhone" }));
    expect(response.status).toBe(401);
    expect((await registry.findPasskeyByCredentialId("credential-1"))?.displayName).toBeNull();
  });

  it("another account's passkey: the same 404 as a missing one, and it stays unnamed", async () => {
    const { registry, rename } = await setup();
    const foreign = await rename("credential-2", JSON.stringify({ displayName: "Hijacked" }));
    const missing = await rename("no-such-credential", JSON.stringify({ displayName: "Hijacked" }));
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
    expect((await registry.findPasskeyByCredentialId("credential-2"))?.displayName).toBeNull();
  });

  it("invalid input is a 400: malformed JSON, missing name, whitespace-only, too long", async () => {
    const { registry, rename } = await setup();
    for (const body of ["{not valid json", "null", JSON.stringify({}), JSON.stringify({ displayName: "   " }), JSON.stringify({ displayName: "a".repeat(41) })]) {
      expect((await rename("credential-1", body)).status).toBe(400);
    }
    expect((await registry.findPasskeyByCredentialId("credential-1"))?.displayName).toBeNull();
  });

  it("a non-active passkey is a 409", async () => {
    const { registry, rename } = await setup();
    const internals = getInMemoryRegistryInternals(registry);
    internals.passkeysByCredentialId.set("credential-1b", { ...internals.passkeysByCredentialId.get("credential-1")!, credentialId: "credential-1b", status: "revoked" });
    expect((await rename("credential-1b", JSON.stringify({ displayName: "Old key" }))).status).toBe(409);
  });

  it("GET omits revoked passkeys (history), keeps pending/revoking (live operations), and never deletes the revoked row", async () => {
    const { registry } = await setup();
    const internals = getInMemoryRegistryInternals(registry);
    const base = internals.passkeysByCredentialId.get("credential-1")!;
    for (const status of ["revoked", "pending", "revoking"] as const) {
      internals.passkeysByCredentialId.set(`credential-${status}`, { ...base, credentialId: `credential-${status}`, role: "backup", status });
    }

    const { GET } = await import("@/app/api/real/account/passkeys/route");
    const list = (await (await GET()).json()) as { passkeys: { credentialId: string; walletAccess: string }[] };

    expect(list.passkeys.map((p) => p.credentialId).sort()).toEqual(["credential-1", "credential-pending", "credential-revoking"]);
    // 2g-H: never optimistic — a pending row with no provable "never reached the wallet" is "uncertain", not harmless.
    expect(Object.fromEntries(list.passkeys.map((p) => [p.credentialId, p.walletAccess]))).toEqual({ "credential-1": "granted", "credential-pending": "uncertain", "credential-revoking": "granted" });
    expect(await registry.findPasskeyByCredentialId("credential-revoked")).toMatchObject({ status: "revoked" });
  });

  it("renames the session account's own passkey (trimmed), and the list returns the name", async () => {
    const { rename } = await setup();
    const response = await rename("credential-1", JSON.stringify({ displayName: "  MacBook Touch ID " }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ passkey: { credentialId: "credential-1", displayName: "MacBook Touch ID" } });

    const { GET } = await import("@/app/api/real/account/passkeys/route");
    const list = (await (await GET()).json()) as { passkeys: { credentialId: string; displayName: string | null }[] };
    expect(list.passkeys).toEqual([expect.objectContaining({ credentialId: "credential-1", displayName: "MacBook Touch ID" })]);
  });
});

describe("2g-H: backup setup routes require a fresh step-up by the session credential (actual route.ts code)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function setup({ signedIn = true } = {}) {
    vi.resetModules();
    stubRequiredConfigEnv();
    const registry = await seedRegistry();
    const challengeStore = createInMemoryChallengeStore();
    const created: { challenge: string; purpose: string; context: unknown }[] = [];
    const recordingChallengeStore = {
      ...challengeStore,
      create: async (input: Parameters<typeof challengeStore.create>[0]) => {
        created.push({ challenge: input.challenge, purpose: input.purpose, context: input.context });
        return challengeStore.create(input);
      },
    };
    const enrollments = createInMemoryBackupPasskeyEnrollmentStore(registry);
    const { REAL_SESSION_COOKIE_NAME } = await import("@/lib/real/server/session");
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), REAL_SESSION_SECRET_VALUE);
    vi.doMock("next/headers", () => ({ cookies: async () => makeCookieJar(signedIn ? { [REAL_SESSION_COOKIE_NAME]: cookieValue } : {}) }));
    vi.doMock("@/lib/real/server/runtime", () => ({
      getRealAccountRegistry: () => registry,
      getChallengeStore: () => recordingChallengeStore,
      getBackupPasskeyEnrollmentStore: () => enrollments,
      getAccountHandleStore: () => createInMemoryAccountHandleStore(registry),
    }));
    const stepUpRoute = await import("@/app/api/real/account/passkeys/backup/step-up/options/route");
    const optionsRoute = await import("@/app/api/real/account/passkeys/backup/options/route");
    const options = (body?: string) => optionsRoute.POST(new Request("http://localhost/api/real/account/passkeys/backup/options", { method: "POST", headers: { "content-type": "application/json" }, body }));
    return { enrollments, created, stepUp: () => stepUpRoute.POST(), options };
  }

  it("without a session: both routes are 401 and nothing is minted", async () => {
    const { created, stepUp, options } = await setup({ signedIn: false });
    expect((await stepUp()).status).toBe(401);
    expect((await options(JSON.stringify({}))).status).toBe(401);
    expect(created).toHaveLength(0);
  });

  it("step-up options are scoped to exactly the session credential, user-verification required, purpose backup_step_up", async () => {
    const { created, stepUp } = await setup();
    const response = await stepUp();
    expect(response.status).toBe(200);
    const { optionsJSON } = (await response.json()) as { optionsJSON: { allowCredentials: { id: string }[]; userVerification: string; challenge: string } };
    expect(optionsJSON.allowCredentials.map((c) => c.id)).toEqual(["credential-1"]);
    expect(optionsJSON.userVerification).toBe("required");
    expect(created).toEqual([{ challenge: optionsJSON.challenge, purpose: "backup_step_up", context: { appUserId: "app-user-1", credentialId: "credential-1" } }]);
  });

  it("a cookie alone can't get a registration challenge: missing/garbage step-up is refused (403), nothing is created or minted", async () => {
    const { enrollments, created, options } = await setup();
    expect((await options()).status).toBe(400);
    for (const body of [JSON.stringify({}), JSON.stringify({ stepUp: null }), JSON.stringify({ stepUp: { id: "credential-1", response: { clientDataJSON: "x" } } })]) {
      const response = await options(body);
      expect(response.status).toBe(403);
      expect(await response.json()).not.toHaveProperty("optionsJSON");
    }
    expect(await enrollments.findActiveByAppUserId("app-user-1")).toBeNull();
    expect(created.filter((c) => c.purpose === "backup_registration")).toHaveLength(0);
  });
});

/**
 * L-2 D-2: the prepare route's two 409s. `account_not_ready` (a stored Safe or
 * owner address that fails validation) is decided before any budget charge,
 * chain read, reservation or provider call, and now carries an additive `code`
 * so the client can tell it from "a payment already exists". Every other body —
 * `payment_in_progress` above all — is exactly what it was. The actual route.ts
 * code, an in-memory registry and payment store, an in-process fake chain RPC
 * and a Pimlico module that fails the test if it is ever reached.
 */
describe("POST /api/real/payments/prepare — L-2 D-2: 409 response bodies (actual route.ts code)", () => {
  const RECIPIENT = "0x2222222222222222222222222222222222222222";
  const CASH_TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const ACCOUNT_SENTENCE = "Your account isn't fully set up yet.";

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("next/headers");
    vi.doUnmock("@/lib/real/server/runtime");
    vi.doUnmock("@/lib/real/chain/client");
    vi.doUnmock("@/lib/real/server/pimlico");
  });

  /** `account` overrides what the registry returns for the signed-in account (how a malformed stored address is simulated). */
  async function setup(options: { account?: { safeAddress?: string; ownerAddress?: string }; signedIn?: boolean } = {}) {
    vi.resetModules();
    stubRequiredConfigEnv();
    const seeded = await seedRegistry();
    const stored = await seeded.findAccountByAppUserId("app-user-1");
    const registry = options.account ? { ...seeded, findAccountByAppUserId: async () => ({ ...stored!, ...options.account }) } : seeded;
    const { createInMemoryPaymentAttemptStore } = await import("@/lib/real/server/payment-attempts");
    const paymentStore = createInMemoryPaymentAttemptStore();
    const storeCalls: string[] = [];
    const countedStore: PaymentAttemptStore = {
      ...paymentStore,
      reserve: async (input) => {
        storeCalls.push("reserve");
        return paymentStore.reserve(input);
      },
      reserveHandlePayment: async (input) => {
        storeCalls.push("reserveHandlePayment");
        return paymentStore.reserveHandlePayment(input);
      },
      transition: async (input) => {
        storeCalls.push("transition");
        return paymentStore.transition(input);
      },
    };
    const { limiter, charges } = recordingRateLimiter();
    const rpc: string[] = [];
    const pimlico = { calls: 0 };
    const { REAL_SESSION_COOKIE_NAME } = await import("@/lib/real/server/session");
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), REAL_SESSION_SECRET_VALUE);
    vi.doMock("next/headers", () => ({ cookies: async () => makeCookieJar(options.signedIn === false ? {} : { [REAL_SESSION_COOKIE_NAME]: cookieValue }) }));
    vi.doMock("@/lib/real/server/runtime", () => ({
      getRealAccountRegistry: () => registry,
      getPaymentAttemptStore: () => countedStore,
      getRateLimiter: () => limiter,
      getProviderBudgetLimiter: () => openBudget(),
    }));
    vi.doMock("@/lib/real/chain/client", () => ({
      createRealPublicClient: () =>
        createPublicClient({
          chain: baseSepolia,
          transport: custom({
            request: async ({ method, params }: { method: string; params?: unknown[] }) => {
              rpc.push(method);
              if (method === "eth_chainId") return `0x${baseSepolia.id.toString(16)}`;
              if (method === "eth_getBlockByNumber") return rpcBlock({ timestamp: BigInt(1_900_000_000) });
              if (method === "eth_call") {
                const selector = ((params?.[0] ?? {}) as { data?: string }).data?.slice(0, 10);
                if (selector === "0x70a08231") return encodeAbiParameters([{ type: "uint256" }], [BigInt(100_000_000)]);
                if (selector === "0x313ce567") return encodeAbiParameters([{ type: "uint8" }], [6]);
              }
              throw new Error(`Unexpected RPC method in an offline test: ${method}`);
            },
          }),
        }),
    }));
    const reached = async () => {
      pimlico.calls += 1;
      throw new Error("Pimlico must not be reached in this test");
    };
    vi.doMock("@/lib/real/server/pimlico", () => ({ prepareCashTransferUserOperation: reached, sendPreparedUserOperation: reached, fetchUserOperationReceipt: reached }));
    const { POST } = await import("@/app/api/real/payments/prepare/route");
    const prepare = (body: unknown = { recipient: RECIPIENT, amountBaseUnits: "1000000" }) =>
      POST(new Request("http://localhost/api/real/payments/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    return { prepare, paymentStore, storeCalls, charges, rpc, pimlico, registry };
  }

  it.each([
    ["a stored Safe address that fails validation", { safeAddress: "not-an-address" }],
    ["an empty stored Safe address", { safeAddress: "" }],
    ["a stored owner address that fails validation", { ownerAddress: "0x1234" }],
    ["both addresses unusable", { safeAddress: "0x", ownerAddress: "" }],
  ] as const)("account_not_ready (%s): HTTP 409 with the existing sentence and exactly the additive code — nothing charged, read, reserved or sent", async (_name, account) => {
    const { prepare, paymentStore, storeCalls, charges, rpc, pimlico } = await setup({ account });

    const response = await prepare();

    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("Retry-After")).toBeNull();
    const raw = await response.text();
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body).toEqual({ error: ACCOUNT_SENTENCE, code: "account_not_ready" });
    expect(Object.keys(body).sort()).toEqual(["code", "error"]);
    // Nothing about the account leaves the server with it.
    expect(raw).not.toMatch(/not-an-address|0x1234|app-user-1|sub-org-1|credential-1/);
    // Decided before the budget, the chain, the reservation and the provider.
    expect(charges).toHaveLength(0);
    expect(rpc).toHaveLength(0);
    expect(storeCalls).toHaveLength(0);
    expect(pimlico.calls).toBe(0);
    expect(await paymentStore.findLatestByAppUserId("app-user-1")).toBeNull();
  });

  it("account_not_ready wins over a malformed selector and amount: the same body whatever the request asked for", async () => {
    const { prepare, charges, storeCalls } = await setup({ account: { safeAddress: "not-an-address" } });

    for (const body of [{ recipient: "nope", amountBaseUnits: "abc" }, { recipientHandle: "smit", amountBaseUnits: "1000000" }, {}]) {
      const response = await prepare(body);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: ACCOUNT_SENTENCE, code: "account_not_ready" });
    }
    expect(charges).toHaveLength(0);
    expect(storeCalls).toHaveLength(0);
  });

  it("payment_in_progress is unchanged: HTTP 409, its existing sentence, and NO code — with the existing payment untouched", async () => {
    const { prepare, paymentStore, storeCalls, charges, pimlico } = await setup();
    const existing = await paymentStore.reserve({ appUserId: "app-user-1", safeAddress: SAFE_ADDRESS, recipient: RECIPIENT, amountBaseUnits: "10000", chainId: 84532, tokenAddress: CASH_TOKEN, authorizingCredentialId: "credential-1" });
    if (!existing.ok) throw new Error("expected reservation");
    const before = structuredClone(await paymentStore.findById(existing.attempt.id));

    const response = await prepare();

    expect(response.status).toBe(409);
    expect(response.headers.get("Retry-After")).toBeNull();
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "You already have a payment in progress." });
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body).not.toHaveProperty("code");
    // The request got as far as the reservation, which refused it; nothing was prepared or changed.
    expect(charges).toHaveLength(1);
    expect(storeCalls).toEqual(["reserve"]);
    expect(pimlico.calls).toBe(0);
    expect(await paymentStore.findById(existing.attempt.id)).toEqual(before);
  });

  it("the two 409s differ only as intended: same status, different sentence, and the code on account_not_ready alone", async () => {
    const notReady = await (await setup({ account: { safeAddress: "not-an-address" } })).prepare();
    const world = await setup();
    await world.paymentStore.reserve({ appUserId: "app-user-1", safeAddress: SAFE_ADDRESS, recipient: RECIPIENT, amountBaseUnits: "10000", chainId: 84532, tokenAddress: CASH_TOKEN, authorizingCredentialId: "credential-1" });
    const inProgress = await world.prepare();

    expect([notReady.status, inProgress.status]).toEqual([409, 409]);
    const [a, b] = [(await notReady.json()) as Record<string, unknown>, (await inProgress.json()) as Record<string, unknown>];
    expect(a.code).toBe("account_not_ready");
    expect("code" in b).toBe(false);
    expect(a.error).not.toBe(b.error);
  });

  it("the other refusals keep their exact bodies, with no code added", async () => {
    const signedOut = await (await setup({ signedIn: false })).prepare();
    expect(signedOut.status).toBe(401);
    expect(await signedOut.json()).toEqual({ error: "Not authenticated." });

    const { prepare } = await setup();
    const cases: Array<[unknown, number, unknown]> = [
      [{ recipient: "nope", amountBaseUnits: "1000000" }, 400, { error: "Enter a valid recipient address." }],
      [{ recipient: RECIPIENT, recipientHandle: "smit", amountBaseUnits: "1000000" }, 400, { error: "Enter a valid recipient address." }],
      [{ recipientHandle: "@Smit", amountBaseUnits: "1000000" }, 400, { error: "Enter a valid @name." }],
      [{ recipient: RECIPIENT, amountBaseUnits: "0" }, 400, { error: "Enter a valid Cash amount." }],
      [{ recipient: RECIPIENT, amountBaseUnits: "999000000" }, 400, { error: "Enter a valid Cash amount." }],
      [{ recipient: RECIPIENT, amountBaseUnits: "100000001" }, 400, { error: "Enter a valid Cash amount." }],
    ];
    for (const [body, status, expected] of cases) {
      const response = await prepare(body);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(expected);
    }
  });

  it("an unexpected exception is still the generic 500 — never a 409, never the code", async () => {
    const { prepare, registry } = await setup();
    (registry as { findAccountByAppUserId: unknown }).findAccountByAppUserId = async () => {
      throw new Error("ECONNREFUSED postgres://user:pass@host/db account_not_ready");
    };

    const response = await prepare();

    expect(response.status).toBe(500);
    const raw = await response.text();
    expect(JSON.parse(raw)).toEqual({ error: GENERIC_SERVER_ERROR_MESSAGE });
    expect(raw).not.toMatch(/account_not_ready|postgres|ECONNREFUSED/);
  });

  it("the balance route's account_not_ready is NOT given the code (out of scope, unchanged)", async () => {
    await setup({ account: { safeAddress: "not-an-address" } });
    const { GET } = await import("@/app/api/real/account/balance/route");

    const response = await GET();

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: ACCOUNT_SENTENCE });
  });

  it("source guard: the route names the code once, on the account_not_ready case, and gives payment_in_progress none", () => {
    const source = readFileSync(resolve(process.cwd(), "app/api/real/payments/prepare/route.ts"), "utf8");
    expect(source.match(/code: "account_not_ready"/g)).toHaveLength(1);
    const accountCase = source.slice(source.indexOf('case "account_not_ready":'), source.indexOf('case "invalid_recipient":'));
    expect(accountCase).toContain('{ error: "Your account isn\'t fully set up yet.", code: "account_not_ready" }, { status: 409 }');
    const inProgressCase = source.slice(source.indexOf('case "payment_in_progress":'), source.indexOf('case "prepare_failed":'));
    expect(inProgressCase).toContain('return jsonError("You already have a payment in progress.", 409);');
    expect(inProgressCase).not.toContain("code");
  });
});

/**
 * L-2 D-4: the submit route's two 409s. `wrong_passkey` (the session's passkey
 * is not the one the payment is bound to) is decided before this request's
 * claim, budget charge or any provider call, on a row still awaiting
 * authorization, and now carries an additive `code` so the client can show the
 * cancel-only screen directly. `wrong_state` stays code-less, and every other
 * body is exactly what it was. The actual route.ts code: first over the real
 * resolver with an in-memory registry and payment store (Turnkey and Pimlico
 * fail the test if reached), then over every resolver outcome in turn.
 */
describe("POST /api/real/payments/submit — L-2 D-4: 409 response bodies (actual route.ts code)", () => {
  const SIGNATURE = `0x${"00".repeat(12)}${"11".repeat(64)}1b`;
  const PASSKEY_SENTENCE = "This payment was started with a different passkey. Cancel it and start a new payment.";
  const UNAVAILABLE_SENTENCE = "We couldn't confirm your passkey approval yet. Try again in a moment.";
  const BUDGET_SENTENCE = "Too many tries right now. Wait a moment, then tap Continue.";
  const OTHER_STATES = ["prepared", "signed", "submitting", "submitted", "confirmed", "failed", "cancelled", "unknown"] as const;
  const wrongStateSentence = (state: string) => `This payment is no longer awaiting authorization (state: ${state}).`;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("next/headers");
    vi.doUnmock("@/lib/real/server/runtime");
    vi.doUnmock("@/lib/real/server/pimlico");
    vi.doUnmock("@/lib/real/server/payments");
    vi.doUnmock("@turnkey/http");
  });

  /**
   * The real resolver behind the real route. `session` is the signed-in passkey
   * (null: signed out); `view` overrides what the store reports for the row —
   * how a row in another state, or another account's row, is simulated.
   */
  async function setup(options: { session?: "credential-1" | "credential-backup" | null; view?: { state?: string; appUserId?: string }; limiter?: ReturnType<typeof openBudget> } = {}) {
    vi.resetModules();
    stubRequiredConfigEnv();
    const registry = await seedRegistry();
    const primary = (await registry.findPasskeyByCredentialId("credential-1"))!;
    getInMemoryRegistryInternals(registry).passkeysByCredentialId.set("credential-backup", { ...primary, credentialId: "credential-backup", role: "backup" });
    const { createInMemoryPaymentAttemptStore } = await import("@/lib/real/server/payment-attempts");
    const paymentStore = createInMemoryPaymentAttemptStore();
    const reserved = await paymentStore.reserve({ appUserId: "app-user-1", safeAddress: SAFE_ADDRESS, recipient: "0x2222222222222222222222222222222222222222", amountBaseUnits: "10000", chainId: 84532, tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", authorizingCredentialId: "credential-1" });
    if (!reserved.ok) throw new Error("expected reservation");
    await paymentStore.transition({
      id: reserved.attempt.id,
      from: "prepared",
      to: "awaiting_authorization",
      patch: { nonce: "0", callData: "0x1234", callGasLimit: "80000", verificationGasLimit: "150000", preVerificationGas: "60000", maxFeePerGas: "2000000", maxPriorityFeePerGas: "1000000", expectedUserOperationHash: `0x${"ab".repeat(32)}`, validUntil: Math.floor(Date.now() / 1000) + 600, prepareBlockNumber: "1" },
    });
    // Every write the submit path could make is recorded: a claim (transition) or a dispatch admission.
    const writes: string[] = [];
    const countedStore: PaymentAttemptStore = {
      ...paymentStore,
      findById: async (id) => {
        const row = await paymentStore.findById(id);
        return row && options.view ? ({ ...row, ...options.view } as typeof row) : row;
      },
      transition: async (input) => {
        writes.push("transition");
        return paymentStore.transition(input);
      },
      beginDispatch: async (input) => {
        writes.push("beginDispatch");
        return paymentStore.beginDispatch(input);
      },
    };
    const budget = scriptedBudget({ allowed: true });
    const limiter = options.limiter ?? budget.limiter;
    const session = options.session === undefined ? "credential-1" : options.session;
    const { REAL_SESSION_COOKIE_NAME } = await import("@/lib/real/server/session");
    const cookieValue = session === null ? null : serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: session, sessionEpoch: 0 }), REAL_SESSION_SECRET_VALUE);
    vi.doMock("next/headers", () => ({ cookies: async () => makeCookieJar(cookieValue === null ? {} : { [REAL_SESSION_COOKIE_NAME]: cookieValue }) }));
    vi.doMock("@/lib/real/server/runtime", () => ({ getRealAccountRegistry: () => registry, getPaymentAttemptStore: () => countedStore, getProviderBudgetLimiter: () => limiter }));
    const turnkeyReads = { count: 0 };
    // Turnkey is unreachable: the parent-key read-back throws (and is counted).
    vi.doMock("@turnkey/http", () => ({
      TurnkeyClient: vi.fn().mockImplementation(function TurnkeyClientMock() {
        return {
          getActivity: async () => {
            turnkeyReads.count += 1;
            throw new Error("ECONNRESET api.turnkey.com");
          },
          getUsers: async () => ({ users: [] }),
        };
      }),
    }));
    const pimlico = { calls: 0 };
    const reached = async () => {
      pimlico.calls += 1;
      throw new Error("Pimlico must not be reached in this test");
    };
    vi.doMock("@/lib/real/server/pimlico", () => ({ prepareCashTransferUserOperation: reached, sendPreparedUserOperation: reached, fetchUserOperationReceipt: reached }));
    const { POST } = await import("@/app/api/real/payments/submit/route");
    const attemptId = reserved.attempt.id;
    const submit = (body: unknown = { attemptId, signature: SIGNATURE, activityId: "activity-1" }) =>
      POST(new Request("http://localhost/api/real/payments/submit", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }));
    return { submit, paymentStore, attemptId, writes, budgetCalls: budget.calls, turnkeyReads, pimlico };
  }

  it("wrong_passkey: HTTP 409 with the existing sentence and exactly the additive code — nothing claimed, charged, read or sent, the row untouched", async () => {
    const { submit, paymentStore, attemptId, writes, budgetCalls, turnkeyReads, pimlico } = await setup({ session: "credential-backup" });
    const before = structuredClone(await paymentStore.findById(attemptId));

    const response = await submit();

    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("Retry-After")).toBeNull();
    const raw = await response.text();
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body).toEqual({ error: PASSKEY_SENTENCE, code: "wrong_passkey" });
    expect(Object.keys(body).sort()).toEqual(["code", "error"]);
    expect(body).not.toHaveProperty("retryable");
    // Nothing about the account, either passkey or the payment leaves the server with it.
    expect(raw).not.toMatch(/credential-1|credential-backup|app-user-1|sub-org-1|awaiting_authorization/);
    expect(raw).not.toContain(attemptId);
    // Decided before the claim, the budget, Turnkey and the bundler.
    expect(writes).toHaveLength(0);
    expect(budgetCalls).toHaveLength(0);
    expect(turnkeyReads.count).toBe(0);
    expect(pimlico.calls).toBe(0);
    expect(await paymentStore.findById(attemptId)).toEqual(before);
    expect(before).toMatchObject({ state: "awaiting_authorization", authorizingCredentialId: "credential-1" });
  });

  it("wrong_passkey is the same body however often it is asked, and whatever else the request carries", async () => {
    const { submit, paymentStore, attemptId, writes, budgetCalls } = await setup({ session: "credential-backup" });

    for (const extra of [{}, { authorizingCredentialId: "credential-backup" }, { code: "ok", state: "submitted" }]) {
      const response = await submit({ attemptId, signature: SIGNATURE, activityId: "activity-1", ...extra });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: PASSKEY_SENTENCE, code: "wrong_passkey" });
    }
    expect(writes).toHaveLength(0);
    expect(budgetCalls).toHaveLength(0);
    expect((await paymentStore.findById(attemptId))?.state).toBe("awaiting_authorization");
  });

  it.each(OTHER_STATES)("wrong_state (%s) is unchanged: HTTP 409, its existing sentence, and NO code — for the bound passkey's session", async (state) => {
    const { submit, writes, budgetCalls, turnkeyReads, pimlico } = await setup({ view: { state } });

    const response = await submit();

    expect(response.status).toBe(409);
    expect(response.headers.get("Retry-After")).toBeNull();
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: wrongStateSentence(state) });
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body).not.toHaveProperty("code");
    expect(writes).toHaveLength(0);
    expect(budgetCalls).toHaveLength(0);
    expect(turnkeyReads.count).toBe(0);
    expect(pimlico.calls).toBe(0);
  });

  it.each(OTHER_STATES)("wrong_state (%s) wins over the passkey check: another passkey's session still gets the code-less 409, never the code", async (state) => {
    const { submit, writes } = await setup({ session: "credential-backup", view: { state } });

    const response = await submit();

    expect(response.status).toBe(409);
    const raw = await response.text();
    expect(JSON.parse(raw)).toEqual({ error: wrongStateSentence(state) });
    expect(raw).not.toContain("wrong_passkey");
    expect(raw).not.toContain("code");
    expect(writes).toHaveLength(0);
  });

  it("the two 409s differ only as intended: same status, different sentence, and the code on wrong_passkey alone", async () => {
    const passkey = await (await setup({ session: "credential-backup" })).submit();
    const state = await (await setup({ view: { state: "submitted" } })).submit();

    expect([passkey.status, state.status]).toEqual([409, 409]);
    const [a, b] = [(await passkey.json()) as Record<string, unknown>, (await state.json()) as Record<string, unknown>];
    expect(a.code).toBe("wrong_passkey");
    expect("code" in b).toBe(false);
    expect(a.error).not.toBe(b.error);
  });

  it("the other refusals keep their exact bodies, with no code added (401, 404, 400)", async () => {
    const signedOut = await (await setup({ session: null })).submit();
    expect(signedOut.status).toBe(401);
    expect(await signedOut.json()).toEqual({ error: "Not authenticated." });

    const { submit, attemptId, paymentStore, writes, budgetCalls } = await setup();
    const cases: Array<[unknown, number, unknown]> = [
      [{ attemptId: "11111111-1111-4111-8111-111111111111", signature: SIGNATURE, activityId: "activity-1" }, 404, { error: "Payment not found." }],
      [{ attemptId: "not-a-uuid", signature: SIGNATURE, activityId: "activity-1" }, 404, { error: "Payment not found." }],
      [{ attemptId: 42, signature: SIGNATURE, activityId: "activity-1" }, 404, { error: "Payment not found." }],
      [{ attemptId, activityId: "activity-1" }, 404, { error: "Payment not found." }],
      [{ attemptId, signature: "0xzz", activityId: "activity-1" }, 400, { error: "This payment's signature could not be verified." }],
      [{ attemptId, signature: "0x123", activityId: "activity-1" }, 400, { error: "This payment's signature could not be verified." }],
      [{ attemptId, signature: SIGNATURE }, 400, { error: "This payment's signature could not be verified." }],
      ["{not valid json", 400, { error: "Invalid request body." }],
    ];
    for (const [body, status, expected] of cases) {
      const response = await submit(body);
      expect(response.status, JSON.stringify(body)).toBe(status);
      expect(response.headers.get("Retry-After")).toBeNull();
      expect(await response.json(), JSON.stringify(body)).toEqual(expected);
    }
    expect(writes).toHaveLength(0);
    expect(budgetCalls).toHaveLength(0);
    expect((await paymentStore.findById(attemptId))?.state).toBe("awaiting_authorization");
  });

  it("another account's payment is still 404 — never a 409 of either kind", async () => {
    const { submit, writes } = await setup({ session: "credential-backup", view: { appUserId: "someone-else" } });

    const response = await submit();

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Payment not found." });
    expect(writes).toHaveLength(0);
  });

  it("the retryable answers are unchanged: 429 (budget) and 503 (approval not confirmable yet)", async () => {
    const denied = scriptedBudget({ allowed: false, retryAfterSeconds: 90 });
    const limited = await setup({ limiter: denied.limiter });
    const tooMany = await limited.submit();
    expect(tooMany.status).toBe(429);
    expect(tooMany.headers.get("Retry-After")).toBe("90");
    expect(await tooMany.json()).toEqual({ error: BUDGET_SENTENCE, code: "rate_limited", retryable: true });
    expect(limited.turnkeyReads.count).toBe(0);
    expect(limited.writes).toHaveLength(0);

    const world = await setup();
    const unavailable = await world.submit();
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("Retry-After")).toBeNull();
    const body = (await unavailable.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: UNAVAILABLE_SENTENCE, retryable: true });
    expect(body).not.toHaveProperty("code");
    expect(world.budgetCalls).toHaveLength(1);
    expect(world.writes).toHaveLength(0);
    expect(world.pimlico.calls).toBe(0);
    expect((await world.paymentStore.findById(world.attemptId))?.state).toBe("awaiting_authorization");
  });

  it("an unexpected exception is still the generic 500 — never a 409, never the code", async () => {
    const failing = scriptedBudget(new Error("ECONNREFUSED postgres://user:pass@host/db wrong_passkey"));
    const { submit, writes, turnkeyReads } = await setup({ limiter: failing.limiter });

    const response = await submit();

    expect(response.status).toBe(500);
    const raw = await response.text();
    expect(JSON.parse(raw)).toEqual({ error: GENERIC_SERVER_ERROR_MESSAGE });
    expect(raw).not.toMatch(/wrong_passkey|postgres|ECONNREFUSED/);
    expect(writes).toHaveLength(0);
    expect(turnkeyReads.count).toBe(0);
  });

  it("a definitive 200 is unchanged: { attempt } only — here a signature the server refuses before any claim", async () => {
    const { submit, attemptId, paymentStore, budgetCalls, turnkeyReads, pimlico } = await setup();

    // Well-formed hex, but not a 65-byte owner signature behind the validity prefix.
    const response = await submit({ attemptId, signature: `0x${"00".repeat(12)}${"11".repeat(40)}`, activityId: "activity-1" });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { attempt: { id: string; state: string } };
    expect(Object.keys(body)).toEqual(["attempt"]);
    expect(body.attempt).toMatchObject({ id: attemptId, state: "failed" });
    expect((await paymentStore.findById(attemptId))?.state).toBe("failed");
    expect(budgetCalls).toHaveLength(0);
    expect(turnkeyReads.count).toBe(0);
    expect(pimlico.calls).toBe(0);
  });

  /** The route's own translation, outcome by outcome: the resolver is replaced, so each wire shape is pinned exactly. */
  describe("every resolver outcome, translated by the route", () => {
    const ATTEMPT = { id: "11111111-1111-4111-8111-111111111111", state: "submitted", recipient: "0x2222222222222222222222222222222222222222", recipientIdentity: null, amountBaseUnits: "10000", transactionHash: null, failureReason: null };

    async function translate(outcome: unknown) {
      vi.resetModules();
      stubRequiredConfigEnv();
      vi.doMock("next/headers", () => ({ cookies: async () => makeCookieJar() }));
      vi.doMock("@/lib/real/server/runtime", () => ({ getRealAccountRegistry: () => ({}), getPaymentAttemptStore: () => ({}), getProviderBudgetLimiter: () => ({}) }));
      const resolver = vi.fn(async () => {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      });
      vi.doMock("@/lib/real/server/payments", () => ({ resolveSubmitPayment: resolver }));
      const { POST } = await import("@/app/api/real/payments/submit/route");
      const response = await POST(new Request("http://localhost/api/real/payments/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ attemptId: ATTEMPT.id, signature: SIGNATURE, activityId: "activity-1" }) }));
      expect(resolver).toHaveBeenCalledTimes(1);
      return response;
    }

    it.each([
      ["unauthenticated", { outcome: "unauthenticated" }, 401, { error: "Not authenticated." }],
      ["not_found", { outcome: "not_found" }, 404, { error: "Payment not found." }],
      ["invalid_signature", { outcome: "invalid_signature" }, 400, { error: "This payment's signature could not be verified." }],
      ...OTHER_STATES.map((state) => [`wrong_state (${state})`, { outcome: "wrong_state", state }, 409, { error: wrongStateSentence(state) }] as const),
      ["wrong_passkey", { outcome: "wrong_passkey" }, 409, { error: PASSKEY_SENTENCE, code: "wrong_passkey" }],
      ["authorization_unavailable", { outcome: "authorization_unavailable" }, 503, { error: UNAVAILABLE_SENTENCE, retryable: true }],
      ["submitted", { outcome: "submitted", attempt: ATTEMPT }, 200, { attempt: ATTEMPT }],
      ["failed", { outcome: "failed", attempt: { ...ATTEMPT, state: "failed", failureReason: "This payment could not be sent. No money moved." } }, 200, { attempt: { ...ATTEMPT, state: "failed", failureReason: "This payment could not be sent. No money moved." } }],
      ["unknown", { outcome: "unknown", attempt: { ...ATTEMPT, state: "unknown" } }, 200, { attempt: { ...ATTEMPT, state: "unknown" } }],
    ] as ReadonlyArray<readonly [string, unknown, number, unknown]>)("%s: exact status and body, no Retry-After, and a code only on wrong_passkey", async (name, outcome, status, expected) => {
      const response = await translate(outcome);

      expect(response.status).toBe(status);
      expect(response.headers.get("Retry-After")).toBeNull();
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toEqual(expected);
      expect("code" in body).toBe(name === "wrong_passkey");
      expect("retryable" in body).toBe(name === "authorization_unavailable");
    });

    it("rate_limited: 429, Retry-After, its own code and retryable flag — unchanged", async () => {
      const response = await translate({ outcome: "rate_limited", retryAfterSeconds: 90 });

      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("90");
      expect(await response.json()).toEqual({ error: BUDGET_SENTENCE, code: "rate_limited", retryable: true });
    });

    it("a resolver exception: the generic 500, whatever its text", async () => {
      const response = await translate(new Error("wrong_passkey: credential-backup != credential-1"));

      expect(response.status).toBe(500);
      const raw = await response.text();
      expect(JSON.parse(raw)).toEqual({ error: GENERIC_SERVER_ERROR_MESSAGE });
      expect(raw).not.toMatch(/wrong_passkey|credential/);
    });
  });

  it("source guard: the route names the code once, on the wrong_passkey case, and gives wrong_state none", () => {
    const source = readFileSync(resolve(process.cwd(), "app/api/real/payments/submit/route.ts"), "utf8");
    expect(source.match(/code: "wrong_passkey"/g)).toHaveLength(1);
    expect(source.match(/\bcode:/g)).toHaveLength(1);
    const passkeyCase = source.slice(source.indexOf('case "wrong_passkey":'), source.indexOf('case "authorization_unavailable":'));
    expect(passkeyCase).toContain('{ error: "This payment was started with a different passkey. Cancel it and start a new payment.", code: "wrong_passkey" }, { status: 409 }');
    expect(passkeyCase).not.toMatch(/Retry-After|retryable/);
    const stateCase = source.slice(source.indexOf('case "wrong_state":'), source.indexOf('case "wrong_passkey":'));
    expect(stateCase).toContain("return jsonError(`This payment is no longer awaiting authorization (state: ${outcome.state}).`, 409);");
    expect(stateCase).not.toContain("code");
    // The resolver decides wrong_passkey before the budget charge and the claim: the order the code's meaning rests on.
    const resolver = readFileSync(resolve(process.cwd(), "lib/real/server/payments.ts"), "utf8");
    const submitBody = resolver.slice(resolver.indexOf("export async function resolveSubmitPayment("));
    const refusal = submitBody.indexOf('return { outcome: "wrong_passkey" };');
    expect(refusal).toBeGreaterThan(-1);
    expect(submitBody.indexOf('if (attempt.state !== "awaiting_authorization") return { outcome: "wrong_state", state: attempt.state };')).toBeLessThan(refusal);
    expect(refusal).toBeLessThan(submitBody.indexOf("consumePaySubmitBudget("));
    expect(refusal).toBeLessThan(submitBody.indexOf("verifyPaymentAuthorization("));
    expect(refusal).toBeLessThan(submitBody.indexOf('to: "signed"'));
  });
});
