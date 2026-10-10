import { afterEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64Url } from "@/lib/real/bytes";
import { createInMemoryAccountHandleStore } from "@/lib/real/server/account-handles";
import { createInMemoryBackupPasskeyEnrollmentStore } from "@/lib/real/server/backup-passkey-enrollment";
import { createInMemoryChallengeStore } from "@/lib/real/server/challenge-store";
import { GENERIC_SERVER_ERROR_MESSAGE } from "@/lib/real/server/http";
import { createInMemoryPasskeyRevocationStore } from "@/lib/real/server/passkey-revocation-attempts";
import { createInMemoryPaymentAttemptStore } from "@/lib/real/server/payment-attempts";
import { createInMemoryRegistrationAttemptStore } from "@/lib/real/server/registration-attempts";
import { createInMemoryRealAccountRegistry } from "@/lib/real/server/registry";
import { checkRealApiRequest } from "@/lib/real/server/request-gate";
import { REAL_SESSION_COOKIE_NAME, createSessionPayload, parseSession, serializeSession } from "@/lib/real/server/session";
import { buildAuthenticationResponseJSON, createFixtureAuthenticator, type FixtureAuthenticator } from "./fixtures/webauthn";
import { denyingRateLimiter, failingRateLimiter, freshRateLimiter, recordingRateLimiter } from "./fixtures/rate-limit";

/**
 * Account Handles through the ACTUAL route.ts code — only next/headers'
 * cookies() and the runtime store getters are mocked; WebAuthn verification
 * is the real library over genuine signatures.
 */
const SECRET = "4be1c0d27a9f3e8d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170605";
const ORIGIN = "http://localhost:3000";
const SESSION_KEYS = ["appUserId", "credentialId", "exp", "sessionEpoch", "sid", "v"];

function stubEnv() {
  vi.stubEnv("NEXT_PUBLIC_REAL_MODE_ENABLED", "true");
  vi.stubEnv("TURNKEY_PARENT_ORGANIZATION_ID", "parent-org");
  vi.stubEnv("TURNKEY_API_PUBLIC_KEY", "public-key");
  vi.stubEnv("TURNKEY_API_PRIVATE_KEY", "private-key");
  vi.stubEnv("REAL_SESSION_SECRET", SECRET);
  vi.stubEnv("NEXT_PUBLIC_REAL_RP_ID", "localhost");
  vi.stubEnv("NEXT_PUBLIC_REAL_ORIGIN", ORIGIN);
  vi.stubEnv("PIMLICO_API_KEY", "pim_test_key");
}

type Seat = { appUserId: string; authenticator: FixtureAuthenticator; userHandle: string };

async function seed() {
  const registry = createInMemoryRealAccountRegistry();
  const seats: Seat[] = [];
  for (const n of [1, 2]) {
    const authenticator = createFixtureAuthenticator();
    await registry.createAccountWithPasskey({
      account: { appUserId: `app-user-${n}`, subOrganizationId: `sub-org-${n}`, turnkeyUserId: `turnkey-user-${n}`, walletId: `wallet-${n}`, walletAccountId: `wallet-account-${n}`, ownerAddress: `0x${String(n).repeat(40)}`, safeAddress: `0x${String(n + 4).repeat(40)}`, accountConfigVersion: 1 },
      passkey: { credentialId: authenticator.credentialIdBase64Url, appUserId: `app-user-${n}`, credentialPublicKey: bytesToBase64Url(authenticator.publicKeyCose), userHandle: `user-handle-${n}`, counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false },
    });
    seats.push({ appUserId: `app-user-${n}`, authenticator, userHandle: `user-handle-${n}` });
  }
  return {
    registry,
    challengeStore: createInMemoryChallengeStore(),
    attempts: createInMemoryRegistrationAttemptStore(),
    payments: createInMemoryPaymentAttemptStore(registry),
    enrollments: createInMemoryBackupPasskeyEnrollmentStore(registry),
    revocations: createInMemoryPasskeyRevocationStore(registry),
    handles: createInMemoryAccountHandleStore(registry),
    a: seats[0]!,
    b: seats[1]!,
  };
}
type Stores = Awaited<ReturnType<typeof seed>>;

const mint = (seat: Seat) => serializeSession(createSessionPayload({ appUserId: seat.appUserId, credentialId: seat.authenticator.credentialIdBase64Url, sessionEpoch: 0 }), SECRET);

/** Loads fresh route modules bound to `stores`, with `cookie` as the request's session cookie. Records every cookie the routes set. */
async function load(stores: Stores, cookie: string | undefined, overrides: Record<string, unknown> = {}) {
  vi.resetModules();
  stubEnv();
  const rateLimiter = freshRateLimiter(); // one per load, like one process (override getRateLimiter to observe or deny)
  const set: Array<{ name: string; value: string }> = [];
  const deleted: string[] = [];
  vi.doMock("next/headers", () => ({
    cookies: async () => ({
      get: (name: string) => (name === REAL_SESSION_COOKIE_NAME && cookie !== undefined ? { name, value: cookie } : undefined),
      set: (name: string, value: string) => void set.push({ name, value }),
      delete: (name: string) => void deleted.push(name),
    }),
  }));
  vi.doMock("@/lib/real/server/runtime", () => ({
    getRealAccountRegistry: () => stores.registry,
    getChallengeStore: () => stores.challengeStore,
    getRegistrationAttemptStore: () => stores.attempts,
    getPaymentAttemptStore: () => stores.payments,
    getBackupPasskeyEnrollmentStore: () => stores.enrollments,
    getPasskeyRevocationStore: () => stores.revocations,
    getAccountHandleStore: () => stores.handles,
    getRateLimiter: () => rateLimiter,
    ...overrides,
  }));
  const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const session = await import("@/app/api/real/session/route");
  const options = await import("@/app/api/real/account/handle/options/route");
  const claim = await import("@/app/api/real/account/handle/claim/route");
  const profile = await import("@/app/api/real/account/profile/route");
  const loginOptions = await import("@/app/api/real/account/login/options/route");
  const loginVerify = await import("@/app/api/real/account/login/verify/route");
  const backupStepUp = await import("@/app/api/real/account/passkeys/backup/step-up/options/route");
  const backupOptions = await import("@/app/api/real/account/passkeys/backup/options/route");
  return {
    set,
    deleted,
    session: () => session.GET(),
    options: (body: unknown) => options.POST(post("/api/real/account/handle/options", body)),
    claim: (body: unknown) => claim.POST(post("/api/real/account/handle/claim", body)),
    profile: (body: unknown) => profile.PATCH(new Request("http://localhost/api/real/account/profile", { method: "PATCH", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) })),
    loginOptions: () => loginOptions.POST(),
    loginVerify: (body: unknown) => loginVerify.POST(post("/api/real/account/login/verify", body)),
    backupStepUp: () => backupStepUp.POST(),
    backupOptions: (body: unknown) => backupOptions.POST(post("/api/real/account/passkeys/backup/options", body)),
  };
}

const assertion = (seat: Seat, challenge: string) => buildAuthenticationResponseJSON({ authenticator: seat.authenticator, challenge, origin: ORIGIN, rpId: "localhost", userHandle: seat.userHandle });

async function claimThroughRoutes(stores: Stores, seat: Seat, handle: string) {
  const routes = await load(stores, mint(seat));
  const prepared = await routes.options({ handle });
  const { optionsJSON } = (await prepared.json()) as { optionsJSON: { challenge: string } };
  return routes.claim({ handle, response: assertion(seat, optionsJSON.challenge) });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("next/headers");
  vi.doUnmock("@/lib/real/server/runtime");
});

describe("account response surface — handle and displayName are optional metadata", () => {
  it("GET /api/real/session: an account with no handle answers exactly as before, plus two nulls", async () => {
    const stores = await seed();
    const body = await (await (await load(stores, mint(stores.a))).session()).json();
    expect(body).toEqual({ authenticated: true, appUserId: "app-user-1", ownerAddress: `0x${"1".repeat(40)}`, safeAddress: `0x${"5".repeat(40)}`, handle: null, displayName: null });
  });

  it("GET /api/real/session: carries the claimed handle and the display name, for that account only", async () => {
    const stores = await seed();
    await stores.handles.claim({ handle: "smit", appUserId: "app-user-1", credentialId: stores.a.authenticator.credentialIdBase64Url });
    await stores.handles.setDisplayName({ appUserId: "app-user-1", displayName: "Smit Patel" });
    expect(await (await (await load(stores, mint(stores.a))).session()).json()).toMatchObject({ authenticated: true, handle: "smit", displayName: "Smit Patel" });
    expect(await (await (await load(stores, mint(stores.b))).session()).json()).toMatchObject({ authenticated: true, appUserId: "app-user-2", handle: null, displayName: null });
  });

  it("signed out: no profile lookup happens and nothing about any handle is returned", async () => {
    const stores = await seed();
    const routes = await load(stores, undefined, {
      getAccountHandleStore: () => {
        throw new Error("must not be read without a session");
      },
    });
    expect(await (await routes.session()).json()).toEqual({ authenticated: false });
  });

  it("POST login/verify: an existing account with NO handle signs in unchanged; the response gains only two nulls", async () => {
    const stores = await seed();
    const routes = await load(stores, undefined);
    const { optionsJSON } = (await (await routes.loginOptions()).json()) as { optionsJSON: { challenge: string; allowCredentials?: unknown } };
    expect(optionsJSON.allowCredentials).toBeUndefined(); // still the discoverable-credential restore flow
    const response = await routes.loginVerify({ response: assertion(stores.a, optionsJSON.challenge) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ appUserId: "app-user-1", ownerAddress: `0x${"1".repeat(40)}`, safeAddress: `0x${"5".repeat(40)}`, handle: null, displayName: null });
    expect(routes.set).toHaveLength(1);
  });

  it("POST login/verify: returns the handle and display name — and the session cookie payload is exactly what it always was", async () => {
    const stores = await seed();
    await stores.handles.claim({ handle: "smit", appUserId: "app-user-1", credentialId: stores.a.authenticator.credentialIdBase64Url });
    await stores.handles.setDisplayName({ appUserId: "app-user-1", displayName: "Smit Patel" });
    const routes = await load(stores, undefined);
    const { optionsJSON } = (await (await routes.loginOptions()).json()) as { optionsJSON: { challenge: string } };
    const response = await routes.loginVerify({ response: assertion(stores.a, optionsJSON.challenge) });
    expect(await response.json()).toMatchObject({ appUserId: "app-user-1", handle: "smit", displayName: "Smit Patel" });
    const cookie = routes.set[0]!;
    expect(cookie.name).toBe(REAL_SESSION_COOKIE_NAME);
    const payload = parseSession(cookie.value, SECRET)!;
    expect(Object.keys(payload).sort()).toEqual(SESSION_KEYS);
    expect(payload).toMatchObject({ v: 2, appUserId: "app-user-1", credentialId: stores.a.authenticator.credentialIdBase64Url, sessionEpoch: 0 });
    const decoded = Buffer.from(cookie.value.split(".")[0]!, "base64url").toString("utf8");
    expect(decoded).not.toMatch(/smit|Smit Patel|handle|displayName/);
  });

});

/** Every way the profile store can fail: the registry table missing, a transient error, a synchronous throw, or the store not being buildable at all. */
const BROKEN_PROFILE_STORES: Array<[string, Record<string, unknown>]> = [
  ["the registry table is missing (migration not applied)", { getAccountHandleStore: () => ({ findProfileByAppUserId: async () => Promise.reject(new Error('relation "real_account_handles" does not exist')) }) }],
  ["a transient database error", { getAccountHandleStore: () => ({ findProfileByAppUserId: async () => Promise.reject(new TypeError("fetch failed")) }) }],
  [
    "the store throws synchronously",
    {
      getAccountHandleStore: () => ({
        findProfileByAppUserId: () => {
          throw new Error("boom");
        },
      }),
    },
  ],
  [
    "the store cannot even be built",
    {
      getAccountHandleStore: () => {
        throw new Error("store init failed");
      },
    },
  ],
];

describe("M1 — profile metadata never blocks authentication", () => {
  it.each(BROKEN_PROFILE_STORES)("POST login/verify: %s -> login still succeeds, the session cookie IS issued, handle/displayName are null", async (_label, overrides) => {
    const stores = await seed();
    await stores.handles.claim({ handle: "smit", appUserId: "app-user-1", credentialId: stores.a.authenticator.credentialIdBase64Url });
    const routes = await load(stores, undefined, overrides);
    const { optionsJSON } = (await (await routes.loginOptions()).json()) as { optionsJSON: { challenge: string } };
    const response = await routes.loginVerify({ response: assertion(stores.a, optionsJSON.challenge) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ appUserId: "app-user-1", ownerAddress: `0x${"1".repeat(40)}`, safeAddress: `0x${"5".repeat(40)}`, handle: null, displayName: null });
    expect(routes.set).toHaveLength(1);
    const payload = parseSession(routes.set[0]!.value, SECRET)!;
    expect(payload).toMatchObject({ appUserId: "app-user-1", credentialId: stores.a.authenticator.credentialIdBase64Url, sessionEpoch: 0 });
    expect(Object.keys(payload).sort()).toEqual(SESSION_KEYS);
  });

  it.each(BROKEN_PROFILE_STORES)("GET /api/real/session: %s -> still authenticated, cookie left alone, handle/displayName null", async (_label, overrides) => {
    const stores = await seed();
    await stores.handles.claim({ handle: "smit", appUserId: "app-user-1", credentialId: stores.a.authenticator.credentialIdBase64Url });
    const routes = await load(stores, mint(stores.a), overrides);
    const response = await routes.session();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: true, appUserId: "app-user-1", ownerAddress: `0x${"1".repeat(40)}`, safeAddress: `0x${"5".repeat(40)}`, handle: null, displayName: null });
    expect(routes.deleted).toEqual([]); // never treated as a dead session
  });

  it("POST register/verify: a successful registration issues its session and answers with null handle/displayName — the profile store is never touched", async () => {
    const stores = await seed();
    const touched: string[] = [];
    const sessionCookie = mint(stores.a);
    vi.doMock("@/lib/real/server/registration", () => ({
      completeRegistration: async () => ({ outcome: "verified", sessionCookie, account: await stores.registry.findAccountByAppUserId("app-user-1") }),
    }));
    try {
      const routes = await load(stores, undefined, {
        getAccountHandleStore: () => {
          touched.push("getAccountHandleStore");
          throw new Error("profile store is down");
        },
      });
      const { POST } = await import("@/app/api/real/account/register/verify/route");
      const response = await POST(new Request("http://localhost/api/real/account/register/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response: { id: "x" } }) }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ appUserId: "app-user-1", ownerAddress: `0x${"1".repeat(40)}`, safeAddress: `0x${"5".repeat(40)}`, handle: null, displayName: null });
      expect(routes.set).toEqual([{ name: REAL_SESSION_COOKIE_NAME, value: sessionCookie }]);
      expect(touched).toEqual([]);
    } finally {
      vi.doUnmock("@/lib/real/server/registration");
    }
  });

  it("register/verify has no dependency on the handle store at all (static), and its non-success outcomes are unchanged", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/api/real/account/register/verify/route.ts", "utf8");
    expect(source).not.toMatch(/getAccountHandleStore|handle-claim|account-handles|readAccountProfile/);
    expect(source).toContain("handle: null,");
    expect(source).toContain("displayName: null,");
    const stores = await seed();
    for (const [outcome, status] of [["rejected", 400], ["blocked", 409], ["pending", 503]] as const) {
      vi.doMock("@/lib/real/server/registration", () => ({ completeRegistration: async () => ({ outcome, reason: "nope" }) }));
      try {
        const routes = await load(stores, undefined);
        const { POST } = await import("@/app/api/real/account/register/verify/route");
        const response = await POST(new Request("http://localhost/api/real/account/register/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response: { id: "x" } }) }));
        expect(response.status).toBe(status);
        expect(routes.set).toHaveLength(0);
      } finally {
        vi.doUnmock("@/lib/real/server/registration");
      }
    }
  });

  it("the enrichment is attempted only AFTER authentication succeeded: a failed login never reads the profile and sets no cookie", async () => {
    const stores = await seed();
    const touched: string[] = [];
    const routes = await load(stores, undefined, {
      getAccountHandleStore: () => {
        touched.push("read");
        return stores.handles;
      },
    });
    const { optionsJSON } = (await (await routes.loginOptions()).json()) as { optionsJSON: { challenge: string } };
    const wrongUserHandle = buildAuthenticationResponseJSON({ authenticator: stores.a.authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: "localhost", userHandle: "not-the-stored-handle" });
    const response = await routes.loginVerify({ response: wrongUserHandle });
    expect(response.status).toBe(401);
    expect(routes.set).toHaveLength(0);
    expect(touched).toEqual([]);
  });

  it("FAIL CLOSED, unchanged: a real authentication/account-store failure is still a 500 with NO cookie — only the profile read is best-effort", async () => {
    const stores = await seed();
    // login/verify: the account registry fails after the assertion verified.
    const brokenRegistry = { ...stores.registry, findAccountByAppUserId: async () => Promise.reject(new Error("ECONNREFUSED postgres://user:pass@host/db")) };
    let routes = await load(stores, undefined, { getRealAccountRegistry: () => brokenRegistry });
    let { optionsJSON } = (await (await routes.loginOptions()).json()) as { optionsJSON: { challenge: string } };
    let response = await routes.loginVerify({ response: assertion(stores.a, optionsJSON.challenge) });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: GENERIC_SERVER_ERROR_MESSAGE });
    expect(routes.set).toHaveLength(0);
    // login/verify: the passkey lookup fails.
    const brokenPasskeys = { ...stores.registry, findPasskeyByCredentialId: async () => Promise.reject(new Error("db down")) };
    routes = await load(stores, undefined, { getRealAccountRegistry: () => brokenPasskeys });
    ({ optionsJSON } = (await (await routes.loginOptions()).json()) as { optionsJSON: { challenge: string } });
    response = await routes.loginVerify({ response: assertion(stores.a, optionsJSON.challenge) });
    expect(response.status).toBe(500);
    expect(routes.set).toHaveLength(0);
    // GET session: the account read fails -> 500, and the (possibly still valid) cookie is NOT cleared.
    const sessionRoutes = await load(stores, mint(stores.a), { getRealAccountRegistry: () => brokenRegistry });
    const sessionResponse = await sessionRoutes.session();
    expect(sessionResponse.status).toBe(500);
    expect(await sessionResponse.json()).toEqual({ error: GENERIC_SERVER_ERROR_MESSAGE });
    expect(sessionRoutes.deleted).toEqual([]);
  });

  it("a revoked or signed-out-everywhere session is still refused, whatever the profile store does", async () => {
    const stores = await seed();
    await stores.registry.incrementSessionEpoch("app-user-1");
    const routes = await load(stores, mint(stores.a), BROKEN_PROFILE_STORES[0]![1]);
    expect(await (await routes.session()).json()).toEqual({ authenticated: false });
    expect(routes.deleted).toEqual([REAL_SESSION_COOKIE_NAME]);
  });

  it.each(BROKEN_PROFILE_STORES)("N1 — POST passkeys/backup/options: %s -> the backup setup still starts (200) with the pre-Handles passkey label, after ONE step-up", async (_label, overrides) => {
    const stores = await seed();
    await stores.handles.claim({ handle: "smit", appUserId: "app-user-1", credentialId: stores.a.authenticator.credentialIdBase64Url });
    await stores.handles.setDisplayName({ appUserId: "app-user-1", displayName: "Smit Patel" });
    const routes = await load(stores, mint(stores.a), overrides);
    const stepUp = (await (await routes.backupStepUp()).json()) as { optionsJSON: { challenge: string } };
    const response = await routes.backupOptions({ stepUp: assertion(stores.a, stepUp.optionsJSON.challenge) });
    expect(response.status).toBe(200);
    const { enrollmentId, optionsJSON } = (await response.json()) as { enrollmentId: string; optionsJSON: { user: { id: string; name: string; displayName: string } } };
    expect(optionsJSON.user.name).toBe(`real-backup-${enrollmentId.slice(0, 8)}`);
    expect(optionsJSON.user.displayName).toBe(optionsJSON.user.name);
    expect(optionsJSON.user.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(optionsJSON)).not.toMatch(/smit|Smit Patel/);
    expect(await stores.enrollments.findActiveByAppUserId("app-user-1")).toMatchObject({ id: enrollmentId, state: "started" });
  });

  it("N1 — POST passkeys/backup/options: with a working profile store and a claimed handle, the new passkey is labelled @handle", async () => {
    const stores = await seed();
    await stores.handles.claim({ handle: "smit", appUserId: "app-user-1", credentialId: stores.a.authenticator.credentialIdBase64Url });
    await stores.handles.setDisplayName({ appUserId: "app-user-1", displayName: "Smit Patel" });
    const routes = await load(stores, mint(stores.a));
    const stepUp = (await (await routes.backupStepUp()).json()) as { optionsJSON: { challenge: string } };
    const response = await routes.backupOptions({ stepUp: assertion(stores.a, stepUp.optionsJSON.challenge) });
    expect(response.status).toBe(200);
    const { optionsJSON } = (await response.json()) as { optionsJSON: { user: { name: string; displayName: string } } };
    expect(optionsJSON.user).toMatchObject({ name: "@smit", displayName: "Smit Patel" });
  });

  it("N1 — a failed step-up is still refused (403) whatever the profile store does, and the store is never built", async () => {
    const stores = await seed();
    let built = 0;
    const routes = await load(stores, mint(stores.a), { getAccountHandleStore: () => ((built += 1), stores.handles) });
    expect((await routes.backupOptions({ stepUp: { id: "x", response: { clientDataJSON: "x" } } })).status).toBe(403);
    expect((await routes.backupOptions({})).status).toBe(403);
    expect(built).toBe(0);
    expect(await stores.enrollments.findActiveByAppUserId("app-user-1")).toBeNull();
  });

  it("where the profile DECIDES something it is NOT best-effort: the claim and profile routes still answer 500", async () => {
    const stores = await seed();
    const routes = await load(stores, mint(stores.a), BROKEN_PROFILE_STORES[0]![1]);
    expect((await routes.options({ handle: "smit" })).status).toBe(500);
    expect((await routes.profile({ displayName: "Smit" })).status).toBe(500);
  });
});

describe("POST /api/real/account/handle/options + /claim", () => {
  it("both require a session, and do nothing without one", async () => {
    const stores = await seed();
    const routes = await load(stores, undefined);
    expect((await routes.options({ handle: "smit" })).status).toBe(401);
    expect((await routes.claim({ handle: "smit", response: {} })).status).toBe(401);
    expect(await stores.handles.findHandle("smit")).toBeNull();
  });

  it("a full claim: options (200, pinned to the session credential) then claim (200) — and the session route then reports it", async () => {
    const stores = await seed();
    const routes = await load(stores, mint(stores.a));
    const prepared = await routes.options({ handle: "@Smit" });
    expect(prepared.status).toBe(200);
    const { handle, optionsJSON } = (await prepared.json()) as { handle: string; optionsJSON: { challenge: string; allowCredentials: { id: string }[]; userVerification: string } };
    expect(handle).toBe("smit");
    expect(optionsJSON.allowCredentials.map((c) => c.id)).toEqual([stores.a.authenticator.credentialIdBase64Url]);
    expect(optionsJSON.userVerification).toBe("required");
    const claimed = await routes.claim({ handle: "smit", response: assertion(stores.a, optionsJSON.challenge) });
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toEqual({ handle: "smit", displayName: null });
    expect(routes.set).toHaveLength(0); // claiming never mints or changes a session
    expect(await (await routes.session()).json()).toMatchObject({ handle: "smit" });
  });

  it("status codes: malformed 400, reserved/taken 409 (same body), already-has-a-handle 409 with the owned handle, bad body 400", async () => {
    const stores = await seed();
    expect((await claimThroughRoutes(stores, stores.b, "taken")).status).toBe(200);
    const routes = await load(stores, mint(stores.a));
    expect((await routes.options({ handle: "ab" })).status).toBe(400);
    expect((await routes.options({})).status).toBe(400);
    expect((await routes.options("{not json")).status).toBe(400);
    expect((await routes.options("null")).status).toBe(400);
    const reserved = await routes.options({ handle: "admin" });
    const taken = await routes.options({ handle: "taken" });
    expect([reserved.status, taken.status]).toEqual([409, 409]);
    expect(await reserved.json()).toEqual(await taken.json());
    // Account 2 already has "taken": any further request reports it, mints nothing.
    const other = await load(stores, mint(stores.b));
    const again = await other.options({ handle: "something" });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ handle: "taken" });
  });

  it("claim refusals are 403 with one fixed message, and never reveal why", async () => {
    const stores = await seed();
    const routes = await load(stores, mint(stores.a));
    const { optionsJSON } = (await (await routes.options({ handle: "smit" })).json()) as { optionsJSON: { challenge: string } };
    const wrongHandle = await routes.claim({ handle: "other", response: assertion(stores.a, optionsJSON.challenge) });
    const replay = await routes.claim({ handle: "smit", response: assertion(stores.a, optionsJSON.challenge) });
    const garbage = await routes.claim({ handle: "smit", response: { id: "x" } });
    const missing = await routes.claim({ handle: "smit" });
    for (const response of [wrongHandle, replay, garbage, missing]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Couldn't confirm it's you. Try again." });
    }
    expect(await stores.handles.findHandle("smit")).toBeNull();
    expect(await stores.handles.findHandle("other")).toBeNull();
  });

  it("account 2's session can't complete a claim account 1 started", async () => {
    const stores = await seed();
    const asA = await load(stores, mint(stores.a));
    const { optionsJSON } = (await (await asA.options({ handle: "smit" })).json()) as { optionsJSON: { challenge: string } };
    const asB = await load(stores, mint(stores.b));
    expect((await asB.claim({ handle: "smit", response: assertion(stores.b, optionsJSON.challenge) })).status).toBe(403);
    expect(await stores.handles.findHandle("smit")).toBeNull();
  });

  it("an unexpected store error is the fixed generic 500 — never database text, never a success", async () => {
    const stores = await seed();
    const routes = await load(stores, mint(stores.a), {
      getAccountHandleStore: () => ({
        ...stores.handles,
        claim: async () => Promise.reject(Object.assign(new Error('duplicate key value violates unique constraint "real_passkeys_pkey"'), { code: "23505" })),
      }),
    });
    const { optionsJSON } = (await (await routes.options({ handle: "smit" })).json()) as { optionsJSON: { challenge: string } };
    const response = await routes.claim({ handle: "smit", response: assertion(stores.a, optionsJSON.challenge) });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: GENERIC_SERVER_ERROR_MESSAGE });
  });

  it("both are JSON-only under the request gate (not on the body-less allow-list), and cross-origin callers are refused", () => {
    const env = { NEXT_PUBLIC_REAL_MODE_ENABLED: "true", NEXT_PUBLIC_REAL_ORIGIN: ORIGIN };
    for (const [method, pathname] of [["POST", "/api/real/account/handle/options"], ["POST", "/api/real/account/handle/claim"], ["PATCH", "/api/real/account/profile"]] as const) {
      const url = `http://localhost:3000${pathname}`;
      expect(checkRealApiRequest(new Request(url, { method, headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" }), env)).toBeNull();
      expect(checkRealApiRequest(new Request(url, { method, headers: { origin: ORIGIN } }), env)?.status).toBe(415);
      expect(checkRealApiRequest(new Request(url, { method, headers: { origin: ORIGIN, "content-type": "text/plain" }, body: "{}" }), env)?.status).toBe(415);
      expect(checkRealApiRequest(new Request(url, { method, headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" }), env)?.status).toBe(403);
      expect(checkRealApiRequest(new Request(url, { method, headers: { origin: ORIGIN, "sec-fetch-site": "cross-site", "content-type": "application/json" }, body: "{}" }), env)?.status).toBe(403);
    }
  });
});

describe("PATCH /api/real/account/profile — display name", () => {
  it("requires a session; needs no passkey; sets, normalizes, and clears the name; never touches the handle", async () => {
    const stores = await seed();
    expect((await (await load(stores, undefined)).profile({ displayName: "X" })).status).toBe(401);
    expect((await claimThroughRoutes(stores, stores.a, "smit")).status).toBe(200);
    const routes = await load(stores, mint(stores.a));
    const saved = await routes.profile({ displayName: "  Zoe\u0308  " });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ handle: "smit", displayName: "Zo\u00EB" });
    expect(await (await routes.profile({ displayName: "" })).json()).toEqual({ handle: "smit", displayName: null });
    expect(await (await routes.profile({ displayName: null })).json()).toEqual({ handle: "smit", displayName: null });
    expect(await (await routes.profile({ displayName: "Smit", handle: "hijack" })).json()).toEqual({ handle: "smit", displayName: "Smit" }); // a `handle` field is ignored
    expect(await stores.handles.findHandle("hijack")).toBeNull();
  });

  it("invalid names are 400 with the validator's reason; a bad body is 400", async () => {
    const stores = await seed();
    const routes = await load(stores, mint(stores.a));
    for (const bad of ["a".repeat(41), "Maya\u202EChen", "Maya\nChen", "Maya\u2028Chen", "@support", "@alice", "Ali\u200Bce", "Ali\u2060ce", "Ali\u00ADce", 42]) expect((await routes.profile({ displayName: bad })).status, String(bad)).toBe(400);
    expect((await routes.profile("{nope")).status).toBe(400);
    expect((await stores.handles.findProfileByAppUserId("app-user-1"))!.displayName).toBeNull();
  });

  it("is scoped to the session's own account", async () => {
    const stores = await seed();
    await (await load(stores, mint(stores.a))).profile({ displayName: "Account One", appUserId: "app-user-2" });
    expect((await stores.handles.findProfileByAppUserId("app-user-1"))!.displayName).toBe("Account One");
    expect((await stores.handles.findProfileByAppUserId("app-user-2"))!.displayName).toBeNull();
  });
});

describe("readAuthenticatedRealAccount stays free of handle metadata (static)", () => {
  it("auth.ts and session.ts never read the handle store, and no other protected route does", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    for (const file of ["lib/real/server/auth.ts", "lib/real/server/session.ts"]) expect(readFileSync(file, "utf8")).not.toMatch(/handle-claim|account-handles|getAccountHandleStore|displayName|display_name/);
    const routes: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry === "route.ts") routes.push(full);
      }
    };
    walk("app/api/real");
    const readers = routes.filter((file) => /getAccountHandleStore/.test(readFileSync(file, "utf8"))).map((file) => file.split(path.sep).join("/")).sort();
    expect(readers).toEqual([
      "app/api/real/account/handle/claim/route.ts",
      "app/api/real/account/handle/options/route.ts",
      "app/api/real/account/login/verify/route.ts",
      "app/api/real/account/passkeys/backup/options/route.ts",
      "app/api/real/account/profile/route.ts",
      "app/api/real/recipients/lookup/route.ts",
      "app/api/real/session/route.ts",
    ]);
    // Of those, the two that enrich an ALREADY-authenticated response use the best-effort read directly ...
    const bestEffort = routes.filter((file) => /readAccountProfileBestEffort/.test(readFileSync(file, "utf8"))).map((file) => file.split(path.sep).join("/")).sort();
    expect(bestEffort).toEqual(["app/api/real/account/login/verify/route.ts", "app/api/real/session/route.ts"]);
    // ... the backup-options route hands the pipeline the store GETTER (a thunk), which the pipeline reads best-effort (N1) ...
    expect(readFileSync("app/api/real/account/passkeys/backup/options/route.ts", "utf8")).toMatch(/handles: getAccountHandleStore,\n/);
    // ... and only the claim and profile routes — where the profile decides something — and the recipient lookup, whose whole answer is the handle read, build the store eagerly and read it strictly.
    const strict = routes.filter((file) => /getAccountHandleStore\(\)/.test(readFileSync(file, "utf8"))).map((file) => file.split(path.sep).join("/")).sort();
    expect(strict).toEqual(["app/api/real/account/handle/claim/route.ts", "app/api/real/account/handle/options/route.ts", "app/api/real/account/profile/route.ts", "app/api/real/recipients/lookup/route.ts"]);
  });
});

/**
 * Handle Pay Slice E — the handle-claim options step answers "is this name
 * taken?", so it draws on the SAME per-account recipient-probe budget as the
 * recipient lookup, charged before the availability read and before any
 * WebAuthn challenge exists.
 */
describe("POST /api/real/account/handle/options — rate limiting (Slice E)", () => {
  const PROBE = ["recipient_probe_day", "recipient_probe_short"];
  const countingChallenges = (stores: Stores) => {
    let created = 0;
    return { created: () => created, store: { ...stores.challengeStore, create: (input: Parameters<Stores["challengeStore"]["create"]>[0]) => (created++, stores.challengeStore.create(input)) } };
  };
  const countingHandles = (stores: Stores) => {
    const reads: string[] = [];
    const store = {
      ...stores.handles,
      findHandle: (handle: string) => (reads.push("findHandle"), stores.handles.findHandle(handle)),
      findProfileByAppUserId: (appUserId: string) => (reads.push("findProfileByAppUserId"), stores.handles.findProfileByAppUserId(appUserId)),
    };
    return { reads, store };
  };

  it("an unauthenticated request, a malformed body, and a malformed name consume NOTHING", async () => {
    const stores = await seed();
    const { limiter, charges } = recordingRateLimiter();
    const overrides = { getRateLimiter: () => limiter };
    expect((await (await load(stores, undefined, overrides)).options({ handle: "smit" })).status).toBe(401);
    const routes = await load(stores, mint(stores.a), overrides);
    for (const body of ["{not json", JSON.stringify("smit")]) expect((await routes.options(body)).status).toBe(400);
    for (const handle of ["", "@", "ab", "@@smit", "sm it", "1smit", 7, null, undefined]) expect((await routes.options({ handle })).status, JSON.stringify(handle)).toBe(400);
    expect(charges).toEqual([]);
  });

  it("an availability check consumes BOTH probe buckets for the caller — available, taken, and reserved names alike — and the limiter is never told the name", async () => {
    const stores = await seed();
    await stores.handles.claim({ handle: "taken_name", appUserId: "app-user-2", credentialId: stores.b.authenticator.credentialIdBase64Url });
    const { limiter, charges, inputs } = recordingRateLimiter();
    const routes = await load(stores, mint(stores.a), { getRateLimiter: () => limiter });

    expect((await routes.options({ handle: "@Free_Name" })).status).toBe(200);
    expect((await routes.options({ handle: "taken_name" })).status).toBe(409);
    expect((await routes.options({ handle: "admin" })).status).toBe(409);

    expect(charges).toEqual([
      { subject: "app-user-1", buckets: PROBE },
      { subject: "app-user-1", buckets: PROBE },
      { subject: "app-user-1", buckets: PROBE },
    ]);
    expect(JSON.stringify(inputs)).not.toMatch(/free_name|taken_name|admin|app-user-2/i);
  });

  it("it shares ONE budget with the recipient lookup: the 21st probe is the 429 contract, with no availability read and NO WebAuthn challenge", async () => {
    const stores = await seed();
    await stores.handles.claim({ handle: "taken_name", appUserId: "app-user-2", credentialId: stores.b.authenticator.credentialIdBase64Url });
    const limiter = freshRateLimiter(() => 1_900_000_000_000);
    const challenges = countingChallenges(stores);
    const handles = countingHandles(stores);
    const routes = await load(stores, mint(stores.a), { getRateLimiter: () => limiter, getChallengeStore: () => challenges.store, getAccountHandleStore: () => handles.store });

    for (let i = 0; i < 20; i++) expect((await routes.options({ handle: i % 2 ? "taken_name" : `free_name_${i}` })).status, String(i)).toBe(i % 2 ? 409 : 200);
    expect(challenges.created()).toBe(10);
    const readsBefore = handles.reads.length;

    for (const handle of ["taken_name", "free_name_x", "admin"]) {
      const response = await routes.options({ handle });
      expect(response.status, handle).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("600");
      expect(await response.json()).toEqual({ error: "Too many tries. Try again later.", code: "rate_limited" });
    }
    expect(challenges.created()).toBe(10); // no challenge row for a denied request
    expect(handles.reads.length).toBe(readsBefore); // and no availability or profile read

    // The other account's budget is untouched.
    const other = await load(stores, mint(stores.b), { getRateLimiter: () => limiter });
    expect((await other.options({ handle: "anything_else" })).status).toBe(409); // already has a handle — but it was admitted, not limited
  });

  it("a denied request reads nothing and creates nothing, even when every store would throw", async () => {
    const stores = await seed();
    // Any METHOD call on either store throws: a denied request may hold the stores, but must never use them.
    const refuse = (what: string) => () =>
      new Proxy(
        {},
        {
          get: (_target, method) => () => {
            throw new Error(`${what} .${String(method)}() must not be called when rate limited`);
          },
        },
      );
    const routes = await load(stores, mint(stores.a), { getRateLimiter: () => denyingRateLimiter(77), getChallengeStore: refuse("challenge store"), getAccountHandleStore: refuse("handle store") });
    const response = await routes.options({ handle: "free_name" });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("77");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "Too many tries. Try again later.", code: "rate_limited" });
    expect(text).not.toMatch(/bucket|hits|subject|recipient_probe|app-user|free_name|optionsJSON|challenge/i);
  });

  it("a limiter failure is the generic 500 — FAIL CLOSED: no availability answer, no challenge, no detail", async () => {
    const stores = await seed();
    const challenges = countingChallenges(stores);
    const handles = countingHandles(stores);
    const routes = await load(stores, mint(stores.a), { getRateLimiter: () => failingRateLimiter(), getChallengeStore: () => challenges.store, getAccountHandleStore: () => handles.store });
    const response = await routes.options({ handle: "free_name" });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "Something went wrong. Please try again." });
    expect(text).not.toMatch(/real_rate_limits|relation|bucket|recipient_probe|app-user/i);
    expect(challenges.created()).toBe(0);
    expect(handles.reads).toEqual([]);
  });

  it("claiming is unchanged: a normal options -> claim still succeeds, and /handle/claim itself is not charged", async () => {
    const stores = await seed();
    const { limiter, charges } = recordingRateLimiter();
    const routes = await load(stores, mint(stores.a), { getRateLimiter: () => limiter });
    const prepared = await routes.options({ handle: "smit" });
    expect(prepared.status).toBe(200);
    const { optionsJSON } = (await prepared.json()) as { optionsJSON: { challenge: string } };
    const claimed = await routes.claim({ handle: "smit", response: assertion(stores.a, optionsJSON.challenge) });
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({ handle: "smit" });
    expect(charges).toEqual([{ subject: "app-user-1", buckets: PROBE }]);
  });
});
