import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryAccountHandleStore } from "@/lib/real/server/account-handles";
import { GENERIC_SERVER_ERROR_MESSAGE } from "@/lib/real/server/http";
import { createInMemoryRealAccountRegistry } from "@/lib/real/server/registry";
import { checkRealApiRequest } from "@/lib/real/server/request-gate";
import { REAL_SESSION_COOKIE_NAME, createSessionPayload, serializeSession } from "@/lib/real/server/session";

/**
 * POST /api/real/recipients/lookup through the ACTUAL route.ts code — only
 * next/headers' cookies() and the runtime store getter are mocked. Fixtures
 * give every account a Turnkey owner address different from its Safe.
 */
const SECRET = "4be1c0d27a9f3e8d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170605";
const ORIGIN = "http://localhost:3000";
const URL_PATH = "/api/real/recipients/lookup";
const owner = (n: number) => `0x${String(n).repeat(40)}`;
const safe = (n: number) => `0x${String(n + 4).repeat(40)}`;

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

async function seed() {
  const registry = createInMemoryRealAccountRegistry();
  for (const n of [1, 2]) {
    await registry.createAccountWithPasskey({
      account: { appUserId: `app-user-${n}`, subOrganizationId: `sub-org-${n}`, turnkeyUserId: `turnkey-user-${n}`, walletId: `wallet-${n}`, walletAccountId: `wallet-account-${n}`, ownerAddress: owner(n), safeAddress: safe(n), accountConfigVersion: 1 },
      passkey: { credentialId: `cred-${n}`, appUserId: `app-user-${n}`, credentialPublicKey: "pk", userHandle: `user-handle-${n}`, counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false },
    });
  }
  const handles = createInMemoryAccountHandleStore(registry);
  await handles.claim({ handle: "smit", appUserId: "app-user-1", credentialId: "cred-1" });
  await handles.setDisplayName({ appUserId: "app-user-1", displayName: "Smit Patel" });
  return { registry, handles };
}
type Stores = Awaited<ReturnType<typeof seed>>;

const mint = (n: number) => serializeSession(createSessionPayload({ appUserId: `app-user-${n}`, credentialId: `cred-${n}`, sessionEpoch: 0 }), SECRET);

async function load(stores: Stores, cookie: string | undefined, overrides: Record<string, unknown> = {}) {
  vi.resetModules();
  stubEnv();
  vi.doMock("next/headers", () => ({
    cookies: async () => ({ get: (name: string) => (name === REAL_SESSION_COOKIE_NAME && cookie !== undefined ? { name, value: cookie } : undefined) }),
  }));
  vi.doMock("@/lib/real/server/runtime", () => ({
    getRealAccountRegistry: () => stores.registry,
    getAccountHandleStore: () => stores.handles,
    ...overrides,
  }));
  const route = await import("@/app/api/real/recipients/lookup/route");
  const request = (body: unknown) => new Request(`http://localhost${URL_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { lookup: (body: unknown) => route.POST(request(body)), route };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("next/headers");
  vi.doUnmock("@/lib/real/server/runtime");
});

describe("POST /api/real/recipients/lookup", () => {
  it("unauthenticated (no cookie, bad cookie) -> 401, and the handle store is never read", async () => {
    const stores = await seed();
    const throwing = {
      getAccountHandleStore: () => {
        throw new Error("must not be read without a session");
      },
    };
    for (const cookie of [undefined, "garbage", `${mint(2)}x`]) {
      const response = await (await load(stores, cookie, throwing)).lookup({ handle: "smit" });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Not authenticated." });
    }
  });

  it("a session whose passkey is no longer active is refused", async () => {
    const stores = await seed();
    await stores.registry.transitionPasskeyStatus({ credentialId: "cred-2", from: "active", to: "revoked" });
    expect((await (await load(stores, mint(2))).lookup({ handle: "smit" })).status).toBe(401);
  });

  it("found: exactly { found, handle, displayName, isSelf } with isSelf false", async () => {
    const stores = await seed();
    const response = await (await load(stores, mint(2))).lookup({ handle: "@Smit" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ found: true, handle: "smit", displayName: "Smit Patel", isSelf: false });
    expect(Object.keys(body).sort()).toEqual(["displayName", "found", "handle", "isSelf"]);
  });

  it("found without a display name: displayName is null, same key set", async () => {
    const stores = await seed();
    await stores.handles.setDisplayName({ appUserId: "app-user-1", displayName: null });
    const body = await (await (await load(stores, mint(2))).lookup({ handle: "smit" })).json();
    expect(body).toEqual({ found: true, handle: "smit", displayName: null, isSelf: false });
  });

  it("self: the caller's own handle -> found with isSelf true", async () => {
    const stores = await seed();
    const body = await (await (await load(stores, mint(1))).lookup({ handle: "smit" })).json();
    expect(body).toEqual({ found: true, handle: "smit", displayName: "Smit Patel", isSelf: true });
  });

  it("not found: exactly { found: false }, HTTP 200", async () => {
    const stores = await seed();
    const response = await (await load(stores, mint(1))).lookup({ handle: "nobody" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ found: false });
    expect(Object.keys(body)).toEqual(["found"]);
  });

  it("a reserved handle is byte-for-byte indistinguishable from a nonexistent one", async () => {
    const stores = await seed();
    const routes = await load(stores, mint(1));
    const reserved = await routes.lookup({ handle: "admin" });
    const missing = await routes.lookup({ handle: "zzzunclaimed" });
    expect(reserved.status).toBe(missing.status);
    expect(await reserved.text()).toBe(await missing.text());
  });

  it("Slice B: an account whose passkeys are all inactive is still found — receiving Cash is separate from signing in; the public shape is unchanged", async () => {
    const stores = await seed();
    await stores.registry.transitionPasskeyStatus({ credentialId: "cred-1", from: "active", to: "revoked" });
    const response = await (await load(stores, mint(2))).lookup({ handle: "smit" });
    const body = await response.json();
    expect(body).toEqual({ found: true, handle: "smit", displayName: "Smit Patel", isSelf: false });
    expect(Object.keys(body).sort()).toEqual(["displayName", "found", "handle", "isSelf"]);
    expect(JSON.stringify(body)).not.toMatch(/app-user-1|0x/);
  });

  it("Slice B: a pending-only or revoking-only recipient is found; reserved and nonexistent stay { found: false }", async () => {
    const stores = await seed();
    for (const to of ["revoking", "revoked"] as const) {
      await stores.registry.transitionPasskeyStatus({ credentialId: "cred-1", from: to === "revoking" ? "active" : "revoking", to });
      const routes = await load(stores, mint(2));
      expect(await (await routes.lookup({ handle: "smit" })).json(), to).toMatchObject({ found: true, handle: "smit" });
    }
    const routes = await load(stores, mint(2));
    expect(await (await routes.lookup({ handle: "admin" })).json()).toEqual({ found: false });
    expect(await (await routes.lookup({ handle: "nobody" })).json()).toEqual({ found: false });
  });

  it("malformed handle -> 400 with the canonicalizer's own reason", async () => {
    const stores = await seed();
    const routes = await load(stores, mint(1));
    for (const [handle, reason] of [
      ["@@smit", "Use only letters a–z, numbers, and underscores."],
      ["", "Enter a name."],
      ["ab", "Use at least 3 characters."],
      ["a".repeat(21), "Use 20 characters or fewer."],
      ["smít", "Use only letters a–z, numbers, and underscores."],
      ["1smit", "Start with a letter."],
      ["smit_", "Underscores can't be first, last, or next to each other."],
      [42, "Enter a name."],
      [null, "Enter a name."],
    ] as const) {
      const response = await routes.lookup({ handle });
      expect(response.status, JSON.stringify(handle)).toBe(400);
      expect(await response.json()).toEqual({ error: reason });
    }
    expect((await routes.lookup({})).status).toBe(400); // no handle at all
  });

  it("an unparseable or non-object body -> 400 Invalid request body.", async () => {
    const stores = await seed();
    const routes = await load(stores, mint(1));
    for (const body of ["{not json", "null", '"smit"', "42"]) {
      const response = await routes.lookup(body);
      expect(response.status, body).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid request body." });
    }
  });

  it("successful responses never contain app_user_id, either address, Turnkey ids, credential ids, or passkey data", async () => {
    const stores = await seed();
    const forbidden = ["app-user-1", "app-user-2", safe(1), safe(2), owner(1), owner(2), "sub-org-1", "turnkey-user-1", "wallet-1", "wallet-account-1", "cred-1", "user-handle-1", "pk", "pim_test_key", "private-key"];
    for (const [caller, handle] of [[2, "smit"], [1, "smit"], [2, "nobody"], [2, "admin"]] as const) {
      const text = await (await (await load(stores, mint(caller))).lookup({ handle })).text();
      for (const secret of forbidden) expect(text, `${handle} as ${caller}: ${secret}`).not.toContain(secret);
    }
  });

  it("the recipient's Safe is not the owner address in the fixtures that back this suite", async () => {
    const stores = await seed();
    const account = (await stores.registry.findAccountByAppUserId("app-user-1"))!;
    const payable = (await stores.handles.findPayableAccountByHandle("smit"))!;
    expect(payable.safeAddress).toBe(account.safeAddress);
    expect(payable.safeAddress).not.toBe(account.ownerAddress);
  });

  it("an infrastructure failure -> generic 500 that leaks no database or provider detail", async () => {
    const stores = await seed();
    const leaks = ['relation "real_account_handles" does not exist', "connect ECONNREFUSED 10.0.0.5:5432", "postgres://user:hunter2@ep-secret.neon.tech/db", "fetch failed"];
    for (const message of leaks) {
      const failing = { getAccountHandleStore: () => ({ findPayableAccountByHandle: () => Promise.reject(new Error(message)) }) };
      const response = await (await load(stores, mint(2), failing)).lookup({ handle: "smit" });
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ error: GENERIC_SERVER_ERROR_MESSAGE });
      for (const leak of leaks) expect(text).not.toContain(leak);
    }
    const unbuildable = { getAccountHandleStore: () => { throw new Error("DATABASE_URL is required"); } };
    const response = await (await load(stores, mint(2), unbuildable)).lookup({ handle: "smit" });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: GENERIC_SERVER_ERROR_MESSAGE });
  });

  it("Real Mode disabled -> 404 before anything is read", async () => {
    const stores = await seed();
    const routes = await load(stores, mint(2));
    vi.stubEnv("NEXT_PUBLIC_REAL_MODE_ENABLED", "false");
    const response = await routes.lookup({ handle: "smit" });
    expect(response.status).toBe(404);
  });

  it("exports POST only: no GET, PUT, PATCH, or DELETE (no list or search endpoint)", async () => {
    const stores = await seed();
    const { route } = await load(stores, mint(2));
    expect(Object.keys(route).sort()).toEqual(["POST"]);
  });
});

describe("request gate — /api/real/recipients/lookup is JSON-only and same-origin by default", () => {
  const gate = (init: RequestInit) => checkRealApiRequest(new Request(`http://localhost${URL_PATH}`, { method: "POST", ...init }), { NEXT_PUBLIC_REAL_MODE_ENABLED: "true", NEXT_PUBLIC_REAL_ORIGIN: ORIGIN });

  it("accepts application/json from the configured origin", () => {
    expect(gate({ headers: { "content-type": "application/json", origin: ORIGIN }, body: "{}" })).toBeNull();
  });

  it("refuses non-JSON bodies (415), a missing content type (415), and cross-site / foreign origins (403)", () => {
    expect(gate({ headers: { "content-type": "text/plain" }, body: "{}" })?.status).toBe(415);
    expect(gate({ headers: { "content-type": "application/x-www-form-urlencoded" }, body: "handle=smit" })?.status).toBe(415);
    expect(gate({ body: "{}" })?.status).toBe(415);
    expect(gate({ headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: "{}" })?.status).toBe(403);
    expect(gate({ headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" })?.status).toBe(403);
  });
});
