// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESERVED_HANDLES, canonicalizeHandle } from "@/lib/real/handle";
import { createInMemoryAccountHandleStore, type AccountHandleStore } from "@/lib/real/server/account-handles";
import { ACCOUNT_HANDLE_OWNER_KEY, ACCOUNT_HANDLE_PRIMARY_KEY, createNeonDurableStores, uniqueViolationConstraintName } from "@/lib/real/server/neon-store";
import { createInMemoryRealAccountRegistry, getInMemoryRegistryInternals, type RealAccountRegistry } from "@/lib/real/server/registry";

/**
 * The handle registry's store semantics. The in-memory adapter is the twin of
 * schema.sql's constraints; the Neon adapter is driven through the REAL
 * @neondatabase/serverless driver with fetch intercepted (nothing leaves the
 * process), proving the exact statement sent and how each database answer is
 * interpreted. That the constraints behave as intended against real Postgres
 * is NOT proven here — handles-migration.smoke.test.ts (gated, live) covers the
 * migration and the claim statement; the adapter itself has no live smoke yet.
 */

async function seedAccount(registry: RealAccountRegistry, n: number) {
  await registry.createAccountWithPasskey({
    account: { appUserId: `app-user-${n}`, subOrganizationId: `sub-org-${n}`, turnkeyUserId: `turnkey-user-${n}`, walletId: `wallet-${n}`, walletAccountId: `wallet-account-${n}`, ownerAddress: `0x${String(n).repeat(40)}`, safeAddress: `0x${String(n + 4).repeat(40)}`, accountConfigVersion: 1 },
    passkey: { credentialId: `credential-${n}`, appUserId: `app-user-${n}`, credentialPublicKey: `cose-${n}`, userHandle: `user-handle-${n}`, counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false },
  });
}

async function world() {
  const registry = createInMemoryRealAccountRegistry();
  for (const n of [1, 2, 3]) await seedAccount(registry, n);
  return { registry, handles: createInMemoryAccountHandleStore(registry) };
}

const claim = (handles: AccountHandleStore, n: number, handle: string, credentialId = `credential-${n}`) => handles.claim({ handle, appUserId: `app-user-${n}`, credentialId });

describe("in-memory handle store (the twin of schema.sql's constraints)", () => {
  it("a claim creates a permanent row; the account's profile then carries it", async () => {
    const { handles } = await world();
    expect(await handles.findProfileByAppUserId("app-user-1")).toEqual({ handle: null, displayName: null });
    expect(await claim(handles, 1, "smit")).toEqual({ outcome: "claimed", handle: "smit", alreadyOwned: false });
    expect(await handles.findHandle("smit")).toEqual({ handle: "smit", kind: "claimed", appUserId: "app-user-1" });
    expect(await handles.findProfileByAppUserId("app-user-1")).toEqual({ handle: "smit", displayName: null });
    expect(await handles.findProfileByAppUserId("no-such-account")).toBeNull();
  });

  it("is seeded with the reserved names, which no account can claim", async () => {
    const { handles } = await world();
    for (const name of RESERVED_HANDLES) {
      expect(await handles.findHandle(name)).toEqual({ handle: name, kind: "reserved", appUserId: null });
      if (canonicalizeHandle(name).ok) expect(await claim(handles, 1, name)).toEqual({ outcome: "handle_taken" });
    }
    expect(await handles.findProfileByAppUserId("app-user-1")).toEqual({ handle: null, displayName: null });
  });

  it("two accounts racing for the same handle: exactly one wins", async () => {
    for (let round = 0; round < 20; round += 1) {
      const { handles } = await world();
      const results = await Promise.all([claim(handles, 1, "smit"), claim(handles, 2, "smit"), claim(handles, 3, "smit")]);
      expect(results.filter((r) => r.outcome === "claimed")).toHaveLength(1);
      expect(results.filter((r) => r.outcome === "handle_taken")).toHaveLength(2);
      const owner = (await handles.findHandle("smit"))!.appUserId;
      for (const n of [1, 2, 3]) expect((await handles.findProfileByAppUserId(`app-user-${n}`))!.handle).toBe(`app-user-${n}` === owner ? "smit" : null);
    }
  });

  it("one account racing for two handles: exactly one wins, and the loser's name stays free", async () => {
    const { handles } = await world();
    const results = await Promise.all([claim(handles, 1, "smit"), claim(handles, 1, "smitty")]);
    expect(results.filter((r) => r.outcome === "claimed")).toHaveLength(1);
    const lost = results.find((r) => r.outcome !== "claimed")!;
    const won = (await handles.findProfileByAppUserId("app-user-1"))!.handle!;
    expect(lost).toEqual({ outcome: "already_has_handle", handle: won });
    const free = won === "smit" ? "smitty" : "smit";
    expect(await handles.findHandle(free)).toBeNull();
    expect(await claim(handles, 2, free)).toMatchObject({ outcome: "claimed" });
  });

  it("idempotent lost-response retry: claiming the handle the account ALREADY owns succeeds without writing; a different one never does", async () => {
    const { handles } = await world();
    await claim(handles, 1, "smit");
    expect(await claim(handles, 1, "smit")).toEqual({ outcome: "claimed", handle: "smit", alreadyOwned: true });
    expect(await claim(handles, 1, "other")).toEqual({ outcome: "already_has_handle", handle: "smit" });
    expect(await claim(handles, 2, "smit")).toEqual({ outcome: "handle_taken" }); // never "success" for someone else's handle
    expect(await handles.findHandle("other")).toBeNull();
  });

  it("the claiming credential must be an ACTIVE passkey of that same account — re-checked by the store itself", async () => {
    const { registry, handles } = await world();
    expect(await claim(handles, 1, "smit", "credential-2")).toEqual({ outcome: "credential_not_active" }); // another account's passkey
    expect(await claim(handles, 1, "smit", "no-such-credential")).toEqual({ outcome: "credential_not_active" });
    const internals = getInMemoryRegistryInternals(registry);
    for (const status of ["pending", "revoking", "revoked"] as const) {
      internals.passkeysByCredentialId.set("credential-1", { ...internals.passkeysByCredentialId.get("credential-1")!, status });
      expect(await claim(handles, 1, "smit")).toEqual({ outcome: "credential_not_active" });
    }
    expect(await handles.findHandle("smit")).toBeNull();
  });

  it("refuses a non-canonical handle outright (the format CHECK's twin) — the service must canonicalize first", async () => {
    const { handles } = await world();
    for (const bad of ["Smit", "@smit", "sm", "a".repeat(21), "_smit", "smit_", "sm__it", "1smit", "sm\u0131t"]) {
      await expect(claim(handles, 1, bad)).rejects.toThrow(/format check/);
    }
  });

  it("has no operation that changes or removes a handle", async () => {
    const { handles } = await world();
    expect(Object.keys(handles).sort()).toEqual(["claim", "findHandle", "findPayableAccountByHandle", "findProfileByAppUserId", "setDisplayName"]);
  });

  it("display name: set, replace, clear; never touches the handle; unknown account is false", async () => {
    const { handles } = await world();
    await claim(handles, 1, "smit");
    expect(await handles.setDisplayName({ appUserId: "app-user-1", displayName: "Smit Patel" })).toBe(true);
    expect(await handles.findProfileByAppUserId("app-user-1")).toEqual({ handle: "smit", displayName: "Smit Patel" });
    // Not unique: a second account may use the same display name.
    expect(await handles.setDisplayName({ appUserId: "app-user-2", displayName: "Smit Patel" })).toBe(true);
    expect(await handles.setDisplayName({ appUserId: "app-user-1", displayName: null })).toBe(true);
    expect(await handles.findProfileByAppUserId("app-user-1")).toEqual({ handle: "smit", displayName: null });
    expect(await handles.setDisplayName({ appUserId: "nobody", displayName: "x" })).toBe(false);
  });
});

// ------------------------------------------------------------------ Neon adapter (fetch-intercepted)

const DATABASE_URL = "postgresql://user:pass@ep-handles-test-000000.us-east-2.aws.neon.tech/neondb";
type Sent = { query: string; params: unknown[]; batch: boolean };
let sent: Sent[] = [];
let respond: (request: Sent, index: number) => Response;

function result(rows: Array<Record<string, unknown>>, names = Object.keys(rows[0] ?? {})) {
  return Response.json({ fields: names.map((name) => ({ name, dataTypeID: 25 })), rows: rows.map((row) => names.map((name) => (row[name] === null ? null : String(row[name])))) });
}
const violation = (constraint: string, withField = true) =>
  new Response(JSON.stringify({ message: `duplicate key value violates unique constraint "${constraint}"`, code: "23505", ...(withField ? { constraint } : {}) }), { status: 400 });
const flat = (query: string) => query.replace(/\s+/g, " ").trim();

describe("Neon handle store (real driver, intercepted transport)", () => {
  beforeEach(() => {
    sent = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as { query?: string; params?: unknown[]; queries?: unknown[] };
      const request: Sent = { query: body.query ?? "", params: body.params ?? [], batch: Array.isArray(body.queries) };
      sent.push(request);
      return respond(request, sent.length - 1);
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const handles = () => createNeonDurableStores(DATABASE_URL).handles;
  const doClaim = () => handles().claim({ handle: "smit", appUserId: "app-user-1", credentialId: "credential-1" });

  it("claim is ONE INSERT ... SELECT from real_passkeys: owner and claimer come from the passkey row, gated on active + same account", async () => {
    respond = () => result([{ handle: "smit" }]);
    expect(await doClaim()).toEqual({ outcome: "claimed", handle: "smit", alreadyOwned: false });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.batch).toBe(false);
    expect(flat(sent[0]!.query)).toBe(
      "INSERT INTO real_account_handles (handle, kind, app_user_id, claimed_by_credential_id) SELECT $1, 'claimed', p.app_user_id, p.credential_id FROM real_passkeys p WHERE p.credential_id = $2 AND p.app_user_id = $3 AND p.status = 'active' RETURNING handle",
    );
    expect(sent[0]!.params).toEqual(["smit", "credential-1", "app-user-1"]);
    expect(sent[0]!.query).not.toMatch(/ON CONFLICT|UPDATE|DELETE/i);
  });

  it("no row inserted (credential not active / not this account's) -> credential_not_active, with no follow-up", async () => {
    respond = () => result([], ["handle"]);
    expect(await doClaim()).toEqual({ outcome: "credential_not_active" });
    expect(sent).toHaveLength(1);
  });

  it.each([
    ["the primary key (named by the constraint field)", ACCOUNT_HANDLE_PRIMARY_KEY, true],
    ["the primary key (named by the message alone)", ACCOUNT_HANDLE_PRIMARY_KEY, false],
    ["the one-handle-per-account key", ACCOUNT_HANDLE_OWNER_KEY, true],
  ])("23505 on %s, and the account already owns the SAME handle -> idempotent success", async (_label, constraint, withField) => {
    respond = (_request, index) => (index === 0 ? violation(constraint, withField) : result([{ handle: "smit" }]));
    expect(await doClaim()).toEqual({ outcome: "claimed", handle: "smit", alreadyOwned: true });
    expect(sent).toHaveLength(2);
    expect(flat(sent[1]!.query)).toBe("SELECT handle FROM real_account_handles WHERE app_user_id = $1");
    expect(sent[1]!.params).toEqual(["app-user-1"]);
  });

  it.each([ACCOUNT_HANDLE_PRIMARY_KEY, ACCOUNT_HANDLE_OWNER_KEY])("23505 on %s, and the account owns a DIFFERENT handle -> already_has_handle (never success)", async (constraint) => {
    respond = (_request, index) => (index === 0 ? violation(constraint) : result([{ handle: "other" }]));
    expect(await doClaim()).toEqual({ outcome: "already_has_handle", handle: "other" });
  });

  it("23505 on the primary key, and the account owns nothing -> handle_taken", async () => {
    respond = (_request, index) => (index === 0 ? violation(ACCOUNT_HANDLE_PRIMARY_KEY) : result([], ["handle"]));
    expect(await doClaim()).toEqual({ outcome: "handle_taken" });
  });

  it("23505 on the owner key but the account owns nothing (impossible with immutable rows) is thrown, never guessed at", async () => {
    respond = (_request, index) => (index === 0 ? violation(ACCOUNT_HANDLE_OWNER_KEY) : result([], ["handle"]));
    await expect(doClaim()).rejects.toMatchObject({ code: "23505" });
  });

  it.each([
    ["a 23505 naming some other constraint", () => violation("real_passkeys_pkey")],
    ["a 23505 naming a look-alike", () => violation("x_real_account_handles_pkey")],
    ["a 23505 naming no constraint at all", () => new Response(JSON.stringify({ message: "duplicate key", code: "23505" }), { status: 400 })],
    ["a foreign-key violation", () => new Response(JSON.stringify({ message: "violates foreign key constraint", code: "23503", constraint: "real_account_handles_claimed_by_fkey" }), { status: 400 })],
    ["a CHECK violation", () => new Response(JSON.stringify({ message: "violates check constraint", code: "23514", constraint: "real_account_handles_format_check" }), { status: 400 })],
    ["the immutability trigger", () => new Response(JSON.stringify({ message: "real_account_handles is append-only", code: "P0001" }), { status: 400 })],
  ])("never converts %s into success or 'taken' — it is thrown, with no follow-up read", async (_label, answer) => {
    respond = answer;
    await expect(doClaim()).rejects.toBeTruthy();
    expect(sent).toHaveLength(1);
  });

  it("uniqueViolationConstraintName returns the exact name only for a 23505", () => {
    expect(uniqueViolationConstraintName({ code: "23505", constraint: ACCOUNT_HANDLE_PRIMARY_KEY })).toBe(ACCOUNT_HANDLE_PRIMARY_KEY);
    expect(uniqueViolationConstraintName({ code: "23505", message: `duplicate key value violates unique constraint "${ACCOUNT_HANDLE_OWNER_KEY}"` })).toBe(ACCOUNT_HANDLE_OWNER_KEY);
    expect(uniqueViolationConstraintName({ code: "23503", constraint: ACCOUNT_HANDLE_PRIMARY_KEY })).toBeUndefined();
    expect(uniqueViolationConstraintName(new Error("boom"))).toBeUndefined();
    expect(uniqueViolationConstraintName(null)).toBeUndefined();
  });

  it("findProfileByAppUserId is one read joining the account's display name to its handle; missing account -> null", async () => {
    respond = () => result([{ display_name: "Smit Patel", handle: "smit" }]);
    expect(await handles().findProfileByAppUserId("app-user-1")).toEqual({ handle: "smit", displayName: "Smit Patel" });
    expect(flat(sent[0]!.query)).toBe("SELECT a.display_name, h.handle FROM real_accounts a LEFT JOIN real_account_handles h ON h.app_user_id = a.app_user_id WHERE a.app_user_id = $1");
    respond = () => result([{ display_name: null, handle: null }]);
    expect(await handles().findProfileByAppUserId("app-user-1")).toEqual({ handle: null, displayName: null });
    respond = () => result([], ["display_name", "handle"]);
    expect(await handles().findProfileByAppUserId("nobody")).toBeNull();
  });

  it("setDisplayName updates only real_accounts.display_name, scoped to the account", async () => {
    respond = () => result([{ app_user_id: "app-user-1" }]);
    expect(await handles().setDisplayName({ appUserId: "app-user-1", displayName: "Smit" })).toBe(true);
    expect(flat(sent[0]!.query)).toBe("UPDATE real_accounts SET display_name = $1 WHERE app_user_id = $2 RETURNING app_user_id");
    expect(sent[0]!.params).toEqual(["Smit", "app-user-1"]);
    respond = () => result([], ["app_user_id"]);
    expect(await handles().setDisplayName({ appUserId: "nobody", displayName: null })).toBe(false);
  });
});
