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

  async function setup(sessionCredentialId: string) {
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
    vi.doMock("@/lib/real/server/runtime", () => ({ getRealAccountRegistry: () => registry, getPaymentAttemptStore: () => paymentStore }));
    // Turnkey is unreachable: the parent-key read-back throws.
    vi.doMock("@turnkey/http", () => ({
      TurnkeyClient: vi.fn().mockImplementation(function TurnkeyClientMock() {
        return {
          getActivity: async () => {
            throw new Error("ECONNRESET api.turnkey.com");
          },
          getUsers: async () => ({ users: [] }),
        };
      }),
    }));
    const { POST } = await import("@/app/api/real/payments/submit/route");
    const submit = (body: object) => POST(new Request("http://localhost/api/real/payments/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    return { submit, paymentStore, attemptId: reserved.attempt.id };
  }

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
