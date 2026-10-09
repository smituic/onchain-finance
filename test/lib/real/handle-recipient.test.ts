import { readFileSync } from "node:fs";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import { describe, expect, it } from "vitest";
import { RESERVED_HANDLES } from "@/lib/real/handle";
import { createInMemoryAccountHandleStore, type AccountHandleStore } from "@/lib/real/server/account-handles";
import { resolveHandleRecipient, toPublicRecipientLookup } from "@/lib/real/server/handle-recipient";
import { createNeonAccountHandleStore } from "@/lib/real/server/neon-store";
import { createInMemoryRealAccountRegistry, getInMemoryRegistryInternals } from "@/lib/real/server/registry";

/**
 * Handle -> payable account (Slice A, advisory). The destination is always
 * handle -> app_user_id -> real_accounts.safe_address, never the Turnkey owner.
 * Fixtures give every account an owner address DIFFERENT from its Safe, so a
 * read that mixed them up would fail loudly.
 */
const owner = (n: number) => `0x${String(n).repeat(40)}`;
const safe = (n: number) => `0x${String(n + 4).repeat(40)}`;

async function world() {
  const registry = createInMemoryRealAccountRegistry();
  for (const n of [1, 2, 3]) {
    await registry.createAccountWithPasskey({
      account: { appUserId: `app-user-${n}`, subOrganizationId: `sub-org-${n}`, turnkeyUserId: `turnkey-user-${n}`, walletId: `wallet-${n}`, walletAccountId: `wallet-account-${n}`, ownerAddress: owner(n), safeAddress: safe(n), accountConfigVersion: 1 },
      passkey: { credentialId: `cred-${n}`, appUserId: `app-user-${n}`, credentialPublicKey: "pk", userHandle: `user-handle-${n}`, counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false },
    });
  }
  const handles = createInMemoryAccountHandleStore(registry);
  await handles.claim({ handle: "smit", appUserId: "app-user-1", credentialId: "cred-1" });
  await handles.setDisplayName({ appUserId: "app-user-1", displayName: "Smit Patel" });
  await handles.claim({ handle: "maya_chen", appUserId: "app-user-2", credentialId: "cred-2" }); // no display name
  return { registry, handles, internals: getInMemoryRegistryInternals(registry) };
}

describe("findPayableAccountByHandle — in-memory adapter", () => {
  it("a claimed handle returns exactly handle, display name, app_user_id and the SAFE address", async () => {
    const { handles } = await world();
    expect(await handles.findPayableAccountByHandle("smit")).toEqual({ handle: "smit", displayName: "Smit Patel", appUserId: "app-user-1", safeAddress: safe(1) });
  });

  it("returns real_accounts.safe_address — never the Turnkey owner address", async () => {
    const { handles, registry } = await world();
    const found = (await handles.findPayableAccountByHandle("smit"))!;
    expect(found.safeAddress).toBe((await registry.findAccountByAppUserId("app-user-1"))!.safeAddress);
    expect(found.safeAddress).not.toBe(owner(1));
    expect(Object.values(found)).not.toContain(owner(1));
    expect(Object.keys(found).sort()).toEqual(["appUserId", "displayName", "handle", "safeAddress"]);
  });

  it("an account with no display name resolves with displayName null", async () => {
    const { handles } = await world();
    expect(await handles.findPayableAccountByHandle("maya_chen")).toMatchObject({ handle: "maya_chen", displayName: null, safeAddress: safe(2) });
  });

  it("every reserved handle, and a nonexistent one, resolve to null", async () => {
    const { handles } = await world();
    for (const reserved of RESERVED_HANDLES) expect(await handles.findPayableAccountByHandle(reserved), reserved).toBeNull();
    expect(await handles.findPayableAccountByHandle("nobody")).toBeNull();
  });

  it("is an exact match: no prefix, no substring, no case-insensitive fallback", async () => {
    const { handles } = await world();
    for (const near of ["smi", "smit1", "mit", "SMIT", "@smit", "maya", "maya_"]) expect(await handles.findPayableAccountByHandle(near), near).toBeNull();
  });

  it("Slice B rule: an account with NO active passkey is still payable — receiving Cash is separate from signing in", async () => {
    const { handles, internals } = await world();
    const primary = internals.passkeysByCredentialId.get("cred-1")!;
    internals.passkeysByCredentialId.set("cred-1", { ...primary, status: "revoked" });
    expect(await handles.findPayableAccountByHandle("smit")).toMatchObject({ handle: "smit", appUserId: "app-user-1", safeAddress: safe(1) });
    internals.passkeysByCredentialId.delete("cred-1"); // no passkey rows at all
    expect(await handles.findPayableAccountByHandle("smit")).toMatchObject({ safeAddress: safe(1) });
  });

  it("a pending-only, revoking-only, or revoked-only recipient is payable", async () => {
    const { handles, internals } = await world();
    const primary = internals.passkeysByCredentialId.get("cred-1")!;
    for (const status of ["pending", "revoking", "revoked"] as const) {
      internals.passkeysByCredentialId.set("cred-1", { ...primary, status });
      expect(await handles.findPayableAccountByHandle("smit"), status).toMatchObject({ safeAddress: safe(1) });
    }
  });

  it("an account without a usable Safe address is NOT payable (the store's only usability rule)", async () => {
    const { handles, internals } = await world();
    const account = internals.accountsByAppUserId.get("app-user-1")!;
    for (const bad of ["", "not-an-address", "0x1234", `0x${"g".repeat(40)}`, `${safe(1)}00`]) {
      internals.accountsByAppUserId.set("app-user-1", { ...account, safeAddress: bad });
      expect(await handles.findPayableAccountByHandle("smit"), JSON.stringify(bad)).toBeNull();
    }
    internals.accountsByAppUserId.set("app-user-1", { ...account, safeAddress: safe(1).toUpperCase().replace("0X", "0x") }); // mixed case is a valid Safe
    expect(await handles.findPayableAccountByHandle("smit")).not.toBeNull();
  });

  it("is read-only: nothing is claimed or changed by looking", async () => {
    const { handles } = await world();
    await handles.findPayableAccountByHandle("nobody");
    expect(await handles.findHandle("nobody")).toBeNull();
    expect(await handles.findProfileByAppUserId("app-user-3")).toEqual({ handle: null, displayName: null });
  });
});

describe("findPayableAccountByHandle — Neon adapter (query shape; no live database)", () => {
  function fakeSql(rows: Array<Record<string, unknown>>) {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join("?"), values });
      return Promise.resolve(rows);
    };
    return { store: createNeonAccountHandleStore(sql as unknown as NeonQueryFunction<false, false>), calls };
  }

  it("issues ONE joined, parameterized, read-only query over real_account_handles and real_accounts", async () => {
    const { store, calls } = fakeSql([]);
    await store.findPayableAccountByHandle("smit");
    expect(calls).toHaveLength(1);
    const { text, values } = calls[0]!;
    expect(values).toEqual(["smit"]);
    expect(text).toMatch(/^\s*SELECT /);
    expect(text).toContain("FROM real_account_handles h");
    expect(text).toMatch(/JOIN real_accounts a ON a\.app_user_id = h\.app_user_id/);
    expect(text).toMatch(/h\.handle = \?/);
    expect(text).toContain("h.kind = 'claimed'");
    // Slice B: the passkey rule is gone; the only usability predicate is a valid Safe address — the SAME shape the payment reservation applies.
    expect(text).not.toMatch(/real_passkeys|EXISTS/i);
    expect(text).toContain("a.safe_address ~ '^0x[0-9a-fA-F]{40}$'");
    expect(text).not.toMatch(/INSERT|UPDATE|DELETE/i);
  });

  it("selects the Safe address and never the Turnkey owner column", async () => {
    const { store, calls } = fakeSql([]);
    await store.findPayableAccountByHandle("smit");
    const text = calls[0]!.text;
    expect(text).toContain("a.safe_address");
    expect(text).not.toMatch(/owner_address/i);
    expect(text).not.toMatch(/SELECT\s+\*|\.\*/);
  });

  it("maps a row to the same record the in-memory adapter returns; no row is null", async () => {
    const mapped = fakeSql([{ handle: "smit", display_name: "Smit Patel", app_user_id: "app-user-1", safe_address: safe(1) }]);
    expect(await mapped.store.findPayableAccountByHandle("smit")).toEqual((await (await world()).handles.findPayableAccountByHandle("smit"))!);
    const noName = fakeSql([{ handle: "maya_chen", display_name: null, app_user_id: "app-user-2", safe_address: safe(2) }]);
    expect(await noName.store.findPayableAccountByHandle("maya_chen")).toEqual({ handle: "maya_chen", displayName: null, appUserId: "app-user-2", safeAddress: safe(2) });
    expect(await fakeSql([]).store.findPayableAccountByHandle("nobody")).toBeNull();
  });

  it("does not pass an owner address through even if a row carried one", async () => {
    const { store } = fakeSql([{ handle: "smit", display_name: null, app_user_id: "app-user-1", safe_address: safe(1), owner_address: owner(1) }]);
    const found = (await store.findPayableAccountByHandle("smit"))!;
    expect(found.safeAddress).toBe(safe(1));
    expect(Object.values(found)).not.toContain(owner(1));
  });
});

describe("resolveHandleRecipient", () => {
  const resolve = async (handle: unknown, currentAppUserId = "app-user-2", handles?: AccountHandleStore) => resolveHandleRecipient({ handles: handles ?? (await world()).handles, handle, currentAppUserId });

  it("ok: canonical handle, display name, app_user_id and the Safe (server-side)", async () => {
    expect(await resolve("smit")).toEqual({ outcome: "ok", canonicalHandle: "smit", displayName: "Smit Patel", appUserId: "app-user-1", safeAddress: safe(1) });
  });

  it("canonicalizes: bare, one leading @, uppercase, and surrounding ASCII whitespace all resolve to the same recipient", async () => {
    for (const input of ["smit", "@smit", "SMIT", "@Smit", "  @smit\n", "\tSmIt "]) expect(await resolve(input), JSON.stringify(input)).toMatchObject({ outcome: "ok", canonicalHandle: "smit", safeAddress: safe(1) });
  });

  it("malformed: the existing canonicalizer's reason, and the store is never read", async () => {
    const throwing = { findPayableAccountByHandle: () => Promise.reject(new Error("must not be read")) } as unknown as AccountHandleStore;
    for (const bad of ["@@smit", "", "@", "ab", "a".repeat(21), "1smit", "sm it", "smit;--", "smít", "ｓｍｉｔ", "Kmit", 42, null, undefined, {}]) {
      const result = await resolve(bad, "app-user-2", throwing);
      expect(result, JSON.stringify(bad)).toMatchObject({ outcome: "malformed" });
      expect(typeof (result as { reason: string }).reason).toBe("string");
    }
    expect(await resolve("@@smit")).toEqual({ outcome: "malformed", reason: "Use only letters a–z, numbers, and underscores." });
  });

  it("not_found: nonexistent, reserved, and an invalid-Safe account are one indistinguishable outcome", async () => {
    const w = await world();
    const account = w.internals.accountsByAppUserId.get("app-user-2")!;
    w.internals.accountsByAppUserId.set("app-user-2", { ...account, safeAddress: "not-an-address" });
    for (const handle of ["nobody", "admin", "@support", "maya_chen"]) expect(await resolve(handle, "app-user-3", w.handles), handle).toEqual({ outcome: "not_found" });
  });

  it("Slice B: a recipient with zero active passkeys resolves ok (and self still resolves self)", async () => {
    const w = await world();
    const primary = w.internals.passkeysByCredentialId.get("cred-2")!;
    w.internals.passkeysByCredentialId.set("cred-2", { ...primary, status: "revoked" });
    expect(await resolve("maya_chen", "app-user-3", w.handles)).toMatchObject({ outcome: "ok", canonicalHandle: "maya_chen", safeAddress: safe(2) });
    expect(await resolve("maya_chen", "app-user-2", w.handles)).toMatchObject({ outcome: "self" });
  });

  it("self: detected by app_user_id, with the same resolved fields", async () => {
    expect(await resolve("@smit", "app-user-1")).toEqual({ outcome: "self", canonicalHandle: "smit", displayName: "Smit Patel", appUserId: "app-user-1", safeAddress: safe(1) });
  });

  it("self is decided by identity, not address: another account is never 'self' even if asked about its own handle by someone else", async () => {
    expect(await resolve("smit", "app-user-3")).toMatchObject({ outcome: "ok" });
    expect(await resolve("smit", "")).toMatchObject({ outcome: "ok" });
    expect(await resolve("smit", safe(1))).toMatchObject({ outcome: "ok" }); // an address is not an identity
  });

  it("propagates a store failure (the route turns it into a generic 500)", async () => {
    const broken = { findPayableAccountByHandle: () => Promise.reject(new Error("connection refused")) } as unknown as AccountHandleStore;
    await expect(resolve("smit", "app-user-2", broken)).rejects.toThrow("connection refused");
  });
});

describe("toPublicRecipientLookup — the only public shape", () => {
  it("found: exactly { found, handle, displayName, isSelf }", async () => {
    const { handles } = await world();
    const ok = toPublicRecipientLookup((await resolveHandleRecipient({ handles, handle: "smit", currentAppUserId: "app-user-2" })) as never);
    expect(ok).toEqual({ found: true, handle: "smit", displayName: "Smit Patel", isSelf: false });
    expect(Object.keys(ok).sort()).toEqual(["displayName", "found", "handle", "isSelf"]);
    const self = toPublicRecipientLookup((await resolveHandleRecipient({ handles, handle: "smit", currentAppUserId: "app-user-1" })) as never);
    expect(self).toEqual({ found: true, handle: "smit", displayName: "Smit Patel", isSelf: true });
  });

  it("not found: exactly { found: false }", () => {
    const result = toPublicRecipientLookup({ outcome: "not_found" });
    expect(result).toEqual({ found: false });
    expect(Object.keys(result)).toEqual(["found"]);
  });

  it("never carries the app user id or either address", async () => {
    const { handles } = await world();
    const serialized = JSON.stringify(toPublicRecipientLookup((await resolveHandleRecipient({ handles, handle: "smit", currentAppUserId: "app-user-2" })) as never));
    for (const secret of ["app-user-1", safe(1), owner(1), "sub-org-1", "turnkey-user-1", "cred-1", "user-handle-1"]) expect(serialized).not.toContain(secret);
  });
});

/** Strips block and line comments so the assertions below look only at code and SQL. */
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("boundary — recipient resolution never touches the Turnkey owner address", () => {
  it("the resolver, the route, and the Neon read never select or reference an owner address", () => {
    const neon = readFileSync("lib/real/server/neon-store.ts", "utf8");
    const start = neon.indexOf("async findPayableAccountByHandle");
    const end = neon.indexOf("async findProfileByAppUserId", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const neonRead = stripComments(neon.slice(start, end));
    expect(neonRead).toContain("a.safe_address");
    expect(neonRead).not.toMatch(/owner_?address/i);

    for (const path of ["lib/real/server/handle-recipient.ts", "app/api/real/recipients/lookup/route.ts"]) {
      const code = stripComments(readFileSync(path, "utf8"));
      expect(code, path).not.toMatch(/owner_?address/i);
    }
    const store = readFileSync("lib/real/server/account-handles.ts", "utf8");
    const memStart = store.indexOf("async findPayableAccountByHandle");
    const memEnd = store.indexOf("async findProfileByAppUserId", memStart);
    expect(stripComments(store.slice(memStart, memEnd))).not.toMatch(/owner_?address/i);
  });

  it("the route has no read other than the exact-match handle resolver (no list, prefix, address, or app-user-id lookup)", () => {
    const code = stripComments(readFileSync("app/api/real/recipients/lookup/route.ts", "utf8"));
    expect(code).toContain("resolveHandleRecipient");
    expect(code).not.toMatch(/findAccountByAppUserId|findHandle|findProfileByAppUserId|LIKE|ILIKE|startsWith|\.search|safeAddress/);
    expect(code).not.toMatch(/export (async )?function (GET|PUT|PATCH|DELETE)/);
  });
});
