import { createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createInMemoryRealAccountRegistry, getInMemoryRegistryInternals, type RealAccountRegistry } from "@/lib/real/server/registry";
import { createInMemoryChallengeStore } from "@/lib/real/server/challenge-store";
import { createInMemoryRegistrationAttemptStore } from "@/lib/real/server/registration-attempts";
import { createInMemoryPaymentAttemptStore } from "@/lib/real/server/payment-attempts";
import { createInMemoryBackupPasskeyEnrollmentStore } from "@/lib/real/server/backup-passkey-enrollment";
import { createInMemoryPasskeyRevocationStore } from "@/lib/real/server/passkey-revocation-attempts";
import { REAL_SESSION_COOKIE_NAME, createSessionPayload, serializeSession } from "@/lib/real/server/session";
import { GENERIC_SERVER_ERROR_MESSAGE } from "@/lib/real/server/http";

/**
 * S4 (F2/F6-D and the auth-route matrix), against the ACTUAL route.ts code:
 * only next/headers' cookies() and the runtime store getters are mocked.
 */

const SECRET = "4be1c0d27a9f3e8d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170605";
const SAFE_ADDRESS = "0xd9a4c22fb34dc74317edc8006140d66c8fa03266";
const OWNER_ADDRESS = "0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF";
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function stubEnv() {
  vi.stubEnv("NEXT_PUBLIC_REAL_MODE_ENABLED", "true");
  vi.stubEnv("TURNKEY_PARENT_ORGANIZATION_ID", "parent-org");
  vi.stubEnv("TURNKEY_API_PUBLIC_KEY", "public-key");
  vi.stubEnv("TURNKEY_API_PRIVATE_KEY", "private-key");
  vi.stubEnv("REAL_SESSION_SECRET", SECRET);
  vi.stubEnv("NEXT_PUBLIC_REAL_RP_ID", "localhost");
  vi.stubEnv("NEXT_PUBLIC_REAL_ORIGIN", "http://localhost:3000");
  vi.stubEnv("PIMLICO_API_KEY", "pim_test_key");
}

/** A cookie jar that records what the route did to the session cookie. */
function makeJar(value?: string, options: { deleteThrows?: boolean } = {}) {
  const deleted: string[] = [];
  const jar = {
    get: (name: string) => (name === REAL_SESSION_COOKIE_NAME && value !== undefined ? { name, value } : undefined),
    set: () => {},
    delete: (name: string) => {
      if (options.deleteThrows) throw new Error("response already committed");
      deleted.push(name);
    },
  };
  return { jar, deleted };
}

const mint = (appUserId: string, credentialId: string, sessionEpoch = 0) => serializeSession(createSessionPayload({ appUserId, credentialId, sessionEpoch }), SECRET);

function legacyV1Token(appUserId: string, credentialId: string): string {
  const encoded = Buffer.from(JSON.stringify({ v: 1, appUserId, credentialId, exp: Date.now() + 60_000, sid: "legacy" }), "utf8").toString("base64url");
  return `${encoded}.${createHmac("sha256", SECRET).update(encoded).digest("base64url")}`;
}

async function seed() {
  const registry = createInMemoryRealAccountRegistry();
  for (const n of [1, 2]) {
    await registry.createAccountWithPasskey({
      account: { appUserId: `app-user-${n}`, subOrganizationId: `sub-org-${n}`, turnkeyUserId: `turnkey-user-${n}`, walletId: `wallet-${n}`, walletAccountId: `wallet-account-${n}`, ownerAddress: OWNER_ADDRESS, safeAddress: SAFE_ADDRESS, accountConfigVersion: 1 },
      passkey: { credentialId: `credential-${n}`, appUserId: `app-user-${n}`, credentialPublicKey: `cose-${n}`, userHandle: `handle-${n}`, counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false },
    });
  }
  // Each account gets a second, Turnkey-mapped active passkey (so removals can be prepared).
  const internals = getInMemoryRegistryInternals(registry);
  for (const n of [1, 2]) {
    const primary = internals.passkeysByCredentialId.get(`credential-${n}`)!;
    internals.passkeysByCredentialId.set(`credential-${n}`, { ...primary, turnkeyAuthenticatorId: `authenticator-${n}` });
    internals.passkeysByCredentialId.set(`credential-${n}b`, { ...primary, credentialId: `credential-${n}b`, role: "backup", turnkeyAuthenticatorId: `authenticator-${n}b` });
  }
  const stores = {
    registry,
    challengeStore: createInMemoryChallengeStore(),
    attempts: createInMemoryRegistrationAttemptStore(),
    payments: createInMemoryPaymentAttemptStore(registry),
    enrollments: createInMemoryBackupPasskeyEnrollmentStore(registry),
    revocations: createInMemoryPasskeyRevocationStore(registry),
  };
  return stores;
}

type Stores = Awaited<ReturnType<typeof seed>>;

function mockRuntime(stores: Stores, registryOverride?: Partial<RealAccountRegistry>) {
  const registry = registryOverride ? { ...stores.registry, ...registryOverride } : stores.registry;
  vi.doMock("@/lib/real/server/runtime", () => ({
    getRealAccountRegistry: () => registry,
    getChallengeStore: () => stores.challengeStore,
    getRegistrationAttemptStore: () => stores.attempts,
    getPaymentAttemptStore: () => stores.payments,
    getBackupPasskeyEnrollmentStore: () => stores.enrollments,
    getPasskeyRevocationStore: () => stores.revocations,
  }));
}

async function loadSessionRoute(cookie: string | undefined, stores: Stores, options: { deleteThrows?: boolean; registryOverride?: Partial<RealAccountRegistry> } = {}) {
  vi.resetModules();
  stubEnv();
  const { jar, deleted } = makeJar(cookie, options);
  vi.doMock("next/headers", () => ({ cookies: async () => jar }));
  mockRuntime(stores, options.registryOverride);
  const route = await import("@/app/api/real/session/route");
  return { route, deleted };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("next/headers");
  vi.doUnmock("@/lib/real/server/runtime");
});

describe("GET /api/real/session — dead cookies are cleared (F6-D)", () => {
  it("a valid v2 session is authenticated and its cookie is left alone", async () => {
    const stores = await seed();
    const { route, deleted } = await loadSessionRoute(mint("app-user-1", "credential-1"), stores);
    const response = await route.GET();
    expect(await response.json()).toMatchObject({ authenticated: true, appUserId: "app-user-1" });
    expect(deleted).toEqual([]);
  });

  it("legacy v1, wrong-epoch, revoked-credential, and tampered cookies all read as signed out AND are cleared", async () => {
    const stores = await seed();
    await stores.registry.transitionPasskeyStatus({ credentialId: "credential-1b", from: "active", to: "revoked" });
    for (const cookie of [legacyV1Token("app-user-1", "credential-1"), mint("app-user-1", "credential-1", 5), mint("app-user-1", "credential-1b"), `${mint("app-user-1", "credential-1").slice(0, -2)}xx`]) {
      const { route, deleted } = await loadSessionRoute(cookie, stores);
      const response = await route.GET();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ authenticated: false });
      expect(deleted).toEqual([REAL_SESSION_COOKIE_NAME]);
    }
  });

  it("no cookie: signed out, nothing to clear", async () => {
    const stores = await seed();
    const { route, deleted } = await loadSessionRoute(undefined, stores);
    expect(await (await route.GET()).json()).toEqual({ authenticated: false });
    expect(deleted).toEqual([]);
  });

  it("a registry failure is a generic 500 and never clears a cookie that may still be valid", async () => {
    const stores = await seed();
    const { route, deleted } = await loadSessionRoute(mint("app-user-1", "credential-1"), stores, {
      registryOverride: {
        findPasskeyByCredentialId: async () => {
          throw new Error("ECONNRESET");
        },
      },
    });
    const response = await route.GET();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: GENERIC_SERVER_ERROR_MESSAGE });
    expect(deleted).toEqual([]);
  });
});

describe("DELETE /api/real/session — Sign out everywhere (F2)", () => {
  it("invalidates EVERY session for the account — a second browser and another passkey's session included — and clears this cookie", async () => {
    const stores = await seed();
    const browserA = mint("app-user-1", "credential-1");
    const browserB = mint("app-user-1", "credential-1");
    const otherPasskey = mint("app-user-1", "credential-1b");
    const otherAccount = mint("app-user-2", "credential-2");

    const { route, deleted } = await loadSessionRoute(browserA, stores);
    const response = await route.DELETE();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: false, signedOutEverywhere: true });
    expect(deleted).toEqual([REAL_SESSION_COOKIE_NAME]);
    expect((await stores.registry.findAccountByAppUserId("app-user-1"))?.sessionEpoch).toBe(1);

    for (const cookie of [browserA, browserB, otherPasskey]) {
      const { route: check } = await loadSessionRoute(cookie, stores);
      expect(await (await check.GET()).json()).toEqual({ authenticated: false });
    }
    // Account-scoped, not global: another account's session is untouched.
    const { route: other } = await loadSessionRoute(otherAccount, stores);
    expect(await (await other.GET()).json()).toMatchObject({ authenticated: true, appUserId: "app-user-2" });
    // And a session minted at the new epoch (i.e. a fresh sign-in) works.
    const { route: fresh } = await loadSessionRoute(mint("app-user-1", "credential-1", 1), stores);
    expect(await (await fresh.GET()).json()).toMatchObject({ authenticated: true, appUserId: "app-user-1" });
  });

  it("if the epoch increment fails: a 500, the cookie is NOT cleared, and every session still works — never a false success", async () => {
    const stores = await seed();
    const cookie = mint("app-user-1", "credential-1");
    const { route, deleted } = await loadSessionRoute(cookie, stores, {
      registryOverride: {
        incrementSessionEpoch: async () => {
          throw new Error("write failed");
        },
      },
    });
    const response = await route.DELETE();
    expect(response.status).toBe(500);
    expect(deleted).toEqual([]);
    expect((await stores.registry.findAccountByAppUserId("app-user-1"))?.sessionEpoch).toBe(0);
  });

  it("if clearing the cookie fails AFTER the increment, the sign-out still stands: every token is already server-invalid", async () => {
    const stores = await seed();
    const cookie = mint("app-user-1", "credential-1");
    const { route } = await loadSessionRoute(cookie, stores, { deleteThrows: true });
    const response = await route.DELETE();
    expect(response.status).toBe(200);
    const { route: check, deleted } = await loadSessionRoute(cookie, stores);
    expect(await (await check.GET()).json()).toEqual({ authenticated: false });
    expect(deleted).toEqual([REAL_SESSION_COOKIE_NAME]);
  });

  it("without a valid session: 401, the dead cookie is cleared, and no epoch moves", async () => {
    const stores = await seed();
    for (const cookie of [undefined, legacyV1Token("app-user-1", "credential-1"), mint("app-user-1", "credential-1", 9)]) {
      const { route, deleted } = await loadSessionRoute(cookie, stores);
      const response = await route.DELETE();
      expect(response.status).toBe(401);
      expect(deleted).toEqual(cookie === undefined ? [] : [REAL_SESSION_COOKIE_NAME]);
    }
    expect((await stores.registry.findAccountByAppUserId("app-user-1"))?.sessionEpoch).toBe(0);
  });
});

type RouteCase = { name: string; module: string; method: "GET" | "POST" | "PATCH" | "DELETE"; path: string; params?: Record<string, string> };

const PAYMENT_ID = "0b7d1d3e-4f0e-4a4e-9a0e-3f7b2a1c9d8e";

/** Every Real route that requires an app session. Registration/login (options + verify) are intentionally public and are NOT in this list. */
const AUTHENTICATED_ROUTES: RouteCase[] = [
  { name: "GET balance", module: "@/app/api/real/account/balance/route", method: "GET", path: "/api/real/account/balance" },
  { name: "GET passkeys", module: "@/app/api/real/account/passkeys/route", method: "GET", path: "/api/real/account/passkeys" },
  { name: "PATCH passkey rename", module: "@/app/api/real/account/passkeys/[credentialId]/route", method: "PATCH", path: "/api/real/account/passkeys/credential-1", params: { credentialId: "credential-1" } },
  { name: "POST revoke/options", module: "@/app/api/real/account/passkeys/[credentialId]/revoke/options/route", method: "POST", path: "/api/real/account/passkeys/credential-1b/revoke/options", params: { credentialId: "credential-1b" } },
  { name: "POST revoke/submit", module: "@/app/api/real/account/passkeys/[credentialId]/revoke/submit/route", method: "POST", path: "/api/real/account/passkeys/credential-1b/revoke/submit", params: { credentialId: "credential-1b" } },
  { name: "POST revoke/reconcile", module: "@/app/api/real/account/passkeys/[credentialId]/revoke/reconcile/route", method: "POST", path: "/api/real/account/passkeys/credential-1b/revoke/reconcile", params: { credentialId: "credential-1b" } },
  { name: "POST revoke/cancel", module: "@/app/api/real/account/passkeys/[credentialId]/revoke/cancel/route", method: "POST", path: "/api/real/account/passkeys/credential-1b/revoke/cancel", params: { credentialId: "credential-1b" } },
  { name: "POST backup/abandon", module: "@/app/api/real/account/passkeys/backup/abandon/route", method: "POST", path: "/api/real/account/passkeys/backup/abandon" },
  { name: "POST backup/authorize/options", module: "@/app/api/real/account/passkeys/backup/authorize/options/route", method: "POST", path: "/api/real/account/passkeys/backup/authorize/options" },
  { name: "POST backup/authorize/reconcile", module: "@/app/api/real/account/passkeys/backup/authorize/reconcile/route", method: "POST", path: "/api/real/account/passkeys/backup/authorize/reconcile" },
  { name: "POST backup/authorize/submit", module: "@/app/api/real/account/passkeys/backup/authorize/submit/route", method: "POST", path: "/api/real/account/passkeys/backup/authorize/submit" },
  { name: "POST backup/options", module: "@/app/api/real/account/passkeys/backup/options/route", method: "POST", path: "/api/real/account/passkeys/backup/options" },
  { name: "POST backup/register", module: "@/app/api/real/account/passkeys/backup/register/route", method: "POST", path: "/api/real/account/passkeys/backup/register" },
  { name: "GET backup/status", module: "@/app/api/real/account/passkeys/backup/status/route", method: "GET", path: "/api/real/account/passkeys/backup/status" },
  { name: "POST backup/step-up/options", module: "@/app/api/real/account/passkeys/backup/step-up/options/route", method: "POST", path: "/api/real/account/passkeys/backup/step-up/options" },
  { name: "POST backup/verify-login/options", module: "@/app/api/real/account/passkeys/backup/verify-login/options/route", method: "POST", path: "/api/real/account/passkeys/backup/verify-login/options" },
  { name: "POST backup/verify-login/confirm", module: "@/app/api/real/account/passkeys/backup/verify-login/confirm/route", method: "POST", path: "/api/real/account/passkeys/backup/verify-login/confirm" },
  { name: "POST backup/verify-signing/options", module: "@/app/api/real/account/passkeys/backup/verify-signing/options/route", method: "POST", path: "/api/real/account/passkeys/backup/verify-signing/options" },
  { name: "POST backup/verify-signing/confirm", module: "@/app/api/real/account/passkeys/backup/verify-signing/confirm/route", method: "POST", path: "/api/real/account/passkeys/backup/verify-signing/confirm" },
  { name: "POST payments/[id]/cancel", module: "@/app/api/real/payments/[id]/cancel/route", method: "POST", path: `/api/real/payments/${PAYMENT_ID}/cancel`, params: { id: PAYMENT_ID } },
  { name: "GET payments/[id]/status", module: "@/app/api/real/payments/[id]/status/route", method: "GET", path: `/api/real/payments/${PAYMENT_ID}/status`, params: { id: PAYMENT_ID } },
  { name: "GET payments/history", module: "@/app/api/real/payments/history/route", method: "GET", path: "/api/real/payments/history" },
  { name: "GET payments/latest", module: "@/app/api/real/payments/latest/route", method: "GET", path: "/api/real/payments/latest" },
  { name: "POST payments/prepare", module: "@/app/api/real/payments/prepare/route", method: "POST", path: "/api/real/payments/prepare" },
  { name: "POST payments/submit", module: "@/app/api/real/payments/submit/route", method: "POST", path: "/api/real/payments/submit" },
  { name: "DELETE session (sign out everywhere)", module: "@/app/api/real/session/route", method: "DELETE", path: "/api/real/session" },
];

async function callRoute(route: RouteCase, cookie: string | undefined, stores: Stores, body: unknown = {}): Promise<Response> {
  vi.resetModules();
  stubEnv();
  const { jar } = makeJar(cookie);
  vi.doMock("next/headers", () => ({ cookies: async () => jar }));
  mockRuntime(stores);
  const mod = (await import(/* @vite-ignore */ route.module)) as Record<string, (request: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>>;
  const handler = mod[route.method]!;
  const hasBody = route.method !== "GET" && route.method !== "DELETE";
  const request = new NextRequest(`http://localhost:3000${route.path}`, {
    method: route.method,
    headers: hasBody ? { "content-type": "application/json" } : undefined,
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  return handler(request, { params: Promise.resolve(route.params ?? {}) });
}

describe("auth-route matrix: every session-requiring Real route refuses stale sessions with 401", () => {
  let stores: Stores;
  let dead: Record<string, string | undefined>;

  beforeEach(async () => {
    stores = await seed();
    await stores.registry.transitionPasskeyStatus({ credentialId: "credential-2b", from: "active", to: "revoking" });
    dead = {
      "no cookie": undefined,
      "legacy v1 token": legacyV1Token("app-user-1", "credential-1"),
      "older epoch (signed out everywhere)": mint("app-user-1", "credential-1", 0),
      "revoked credential's old token": mint("app-user-1", "credential-1b", 1),
      "revoking credential's old token": mint("app-user-2", "credential-2b", 0),
    };
    // app-user-1 signed out everywhere (epoch 0 -> 1); credential-1b then revoked.
    await stores.registry.incrementSessionEpoch("app-user-1");
    await stores.registry.transitionPasskeyStatus({ credentialId: "credential-1b", from: "active", to: "revoked" });
  });

  for (const route of AUTHENTICATED_ROUTES) {
    it(`${route.name}: 401 for every dead session`, async () => {
      for (const [label, cookie] of Object.entries(dead)) {
        const response = await callRoute(route, cookie, stores);
        expect(response.status, `${route.name} / ${label}`).toBe(401);
      }
    });
  }

  it("the matrix is not vacuous: a live session gets past auth on a read route", async () => {
    const live = mint("app-user-1", "credential-1", 1);
    const response = await callRoute(AUTHENTICATED_ROUTES.find((r) => r.name === "GET passkeys")!, live, stores);
    expect(response.status).toBe(200);
  });

  it("registration and login options stay public: no cookie still gets 200 (they are never expected to 401)", async () => {
    for (const modulePath of ["@/app/api/real/account/register/options/route", "@/app/api/real/account/login/options/route"]) {
      vi.resetModules();
      stubEnv();
      vi.doMock("next/headers", () => ({ cookies: async () => makeJar().jar }));
      mockRuntime(stores);
      const { POST } = (await import(/* @vite-ignore */ modulePath)) as { POST: () => Promise<Response> };
      const response = await POST();
      expect(response.status, modulePath).toBe(200);
      expect(await response.json()).toHaveProperty("optionsJSON");
    }
  });
});

describe("cross-account identifiers: another account's resource answers exactly like a missing one (non-enumerating)", () => {
  const session1 = () => mint("app-user-1", "credential-1");

  async function expectSameAsMissing(route: (id: string) => RouteCase, foreignId: string, missingId: string, stores: Stores, body: (id: string) => unknown = () => ({})) {
    const foreign = await callRoute(route(foreignId), session1(), stores, body(foreignId));
    const missing = await callRoute(route(missingId), session1(), stores, body(missingId));
    expect(foreign.status).toBe(missing.status);
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect(await foreign.json()).toEqual(await missing.json());
  }

  it("payments: status and cancel on account 2's payment", async () => {
    const stores = await seed();
    const reserved = await stores.payments.reserve({ appUserId: "app-user-2", safeAddress: SAFE_ADDRESS, recipient: "0x2222222222222222222222222222222222222222", amountBaseUnits: "10000", chainId: 84532, tokenAddress: TOKEN, authorizingCredentialId: "credential-2" });
    if (!reserved.ok) throw new Error("expected a reservation");
    const foreignId = reserved.attempt.id;
    for (const kind of ["status", "cancel"] as const) {
      await expectSameAsMissing(
        (id) => ({ name: kind, module: `@/app/api/real/payments/[id]/${kind}/route`, method: kind === "status" ? "GET" : "POST", path: `/api/real/payments/${id}/${kind}`, params: { id } }),
        foreignId,
        randomUUID(),
        stores,
      );
    }
    expect((await stores.payments.findById(foreignId))?.state).toBe("prepared");
  });

  it("backup enrollment: abandoning account 2's enrollment", async () => {
    const stores = await seed();
    const started = await stores.enrollments.createStarted({ appUserId: "app-user-2" });
    if (!started) throw new Error("expected an enrollment");
    const foreignId = started.id;
    await expectSameAsMissing(
      () => ({ name: "abandon", module: "@/app/api/real/account/passkeys/backup/abandon/route", method: "POST", path: "/api/real/account/passkeys/backup/abandon" }),
      foreignId,
      randomUUID(),
      stores,
      (id) => ({ enrollmentId: id }),
    );
    expect((await stores.enrollments.findById(foreignId))?.state).toBe("started");
  });

  it("credentials: removing or renaming account 2's passkey", async () => {
    const stores = await seed();
    await expectSameAsMissing(
      (id) => ({ name: "revoke/options", module: "@/app/api/real/account/passkeys/[credentialId]/revoke/options/route", method: "POST", path: `/api/real/account/passkeys/${id}/revoke/options`, params: { credentialId: id } }),
      "credential-2b",
      "no-such-credential",
      stores,
    );
    await expectSameAsMissing(
      (id) => ({ name: "rename", module: "@/app/api/real/account/passkeys/[credentialId]/route", method: "PATCH", path: `/api/real/account/passkeys/${id}`, params: { credentialId: id } }),
      "credential-2b",
      "no-such-credential",
      stores,
      () => ({ displayName: "Hijacked" }),
    );
    expect((await stores.registry.findPasskeyByCredentialId("credential-2b"))?.status).toBe("active");
  });

  it("removal attempts: cancelling account 2's pending removal attempt", async () => {
    const stores = await seed();
    const prepared = await stores.revocations.prepare({ appUserId: "app-user-2", targetCredentialId: "credential-2b", authorizerCredentialId: "credential-2" });
    if (!prepared.ok) throw new Error(`expected a prepared removal, got ${prepared.reason}`);
    const foreignId = prepared.attempt.id;
    await expectSameAsMissing(
      () => ({ name: "revoke/cancel", module: "@/app/api/real/account/passkeys/[credentialId]/revoke/cancel/route", method: "POST", path: "/api/real/account/passkeys/credential-2b/revoke/cancel", params: { credentialId: "credential-2b" } }),
      foreignId,
      randomUUID(),
      stores,
      (id) => ({ attemptId: id }),
    );
    expect((await stores.revocations.findById(foreignId))?.state).toBe("authorization_needed");
  });
});
