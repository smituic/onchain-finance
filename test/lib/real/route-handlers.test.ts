import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createInMemoryRealAccountRegistry } from "@/lib/real/server/registry";
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

const REAL_SESSION_SECRET_VALUE = "route-handler-test-secret";
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
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1" }), REAL_SESSION_SECRET_VALUE);
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
