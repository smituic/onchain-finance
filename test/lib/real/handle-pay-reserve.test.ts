import { readFileSync } from "node:fs";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryAccountHandleStore } from "@/lib/real/server/account-handles";
import { createNeonPaymentAttemptStore } from "@/lib/real/server/neon-store";
import { createInMemoryPaymentAttemptStore, PAYMENT_RATE_LIMIT, type PaymentAttemptStore, type ReserveHandlePaymentInput } from "@/lib/real/server/payment-attempts";
import { createInMemoryRealAccountRegistry, getInMemoryRegistryInternals } from "@/lib/real/server/registry";

/**
 * Handle Pay Slice B at the STORE: reserveHandlePayment resolves the recipient
 * (handle -> claimed row -> account -> Safe) INSIDE the reservation, and writes
 * recipient + the identity snapshot from that one resolution. The Safe is the
 * destination; the Turnkey owner address is a DIFFERENT value in every fixture,
 * so any mix-up fails loudly.
 */
const owner = (n: number) => `0x${String(n).repeat(40)}`;
// Account 2's Safe is mixed-case on purpose: recipient must be stored lower-cased.
const MIXED_SAFE_2 = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const safe = (n: number) => (n === 2 ? MIXED_SAFE_2 : `0x${String(n + 4).repeat(40)}`);
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

async function world() {
  const registry = createInMemoryRealAccountRegistry();
  for (const n of [1, 2, 3, 4]) {
    await registry.createAccountWithPasskey({
      account: { appUserId: `app-user-${n}`, subOrganizationId: `sub-org-${n}`, turnkeyUserId: `turnkey-user-${n}`, walletId: `wallet-${n}`, walletAccountId: `wallet-account-${n}`, ownerAddress: owner(n), safeAddress: safe(n), accountConfigVersion: 1 },
      passkey: { credentialId: `cred-${n}`, appUserId: `app-user-${n}`, credentialPublicKey: "pk", userHandle: `user-handle-${n}`, counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false },
    });
  }
  // The payment store is built BEFORE the handle store, exactly like runtime.ts: the handle directory is registered lazily.
  const payments = createInMemoryPaymentAttemptStore(registry);
  const handles = createInMemoryAccountHandleStore(registry);
  await handles.claim({ handle: "smit", appUserId: "app-user-1", credentialId: "cred-1" });
  await handles.setDisplayName({ appUserId: "app-user-1", displayName: "Smit Patel" });
  await handles.claim({ handle: "maya_chen", appUserId: "app-user-2", credentialId: "cred-2" });
  await handles.setDisplayName({ appUserId: "app-user-2", displayName: "Maya Chen" });
  await handles.claim({ handle: "no_name", appUserId: "app-user-3", credentialId: "cred-3" }); // claimed, no display name
  return { registry, payments, handles, internals: getInMemoryRegistryInternals(registry) };
}
type World = Awaited<ReturnType<typeof world>>;

/** The payer is app-user-4 unless a test says otherwise. Only payer/payment fields — never a recipient. */
function handleInput(recipientHandle: string, appUserId = "app-user-4"): ReserveHandlePaymentInput {
  return { appUserId, safeAddress: safe(Number(appUserId.slice(-1))), recipientHandle, amountBaseUnits: "1000000", chainId: 84532, tokenAddress: TOKEN, authorizingCredentialId: `cred-${appUserId.slice(-1)}` };
}
function addressInput(recipient: string, appUserId = "app-user-4") {
  return { appUserId, safeAddress: safe(Number(appUserId.slice(-1))), recipient, amountBaseUnits: "1000000", chainId: 84532, tokenAddress: TOKEN, authorizingCredentialId: `cred-${appUserId.slice(-1)}` };
}
async function attemptsOf(w: World, appUserId: string) {
  return w.payments.findRecentByAppUserId({ appUserId, limit: 50 });
}

describe("reserveHandlePayment — in-memory twin", () => {
  it("a claimed canonical handle reserves: recipient = lower(Safe), and the whole identity snapshot comes from the directory", async () => {
    const w = await world();
    const result = await w.payments.reserveHandlePayment(handleInput("maya_chen"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt).toMatchObject({
      state: "prepared",
      appUserId: "app-user-4",
      recipient: MIXED_SAFE_2.toLowerCase(),
      recipientAppUserId: "app-user-2",
      recipientHandle: "maya_chen",
      recipientDisplayName: "Maya Chen",
    });
    expect(result.attempt.recipient).not.toBe(MIXED_SAFE_2);
    expect(result.attempt.recipient).not.toBe(owner(2).toLowerCase()); // the Safe, never the Turnkey owner
    expect(await w.payments.findById(result.attempt.id)).toEqual(result.attempt);
  });

  it("a NULL display name is accepted and stored as null", async () => {
    const w = await world();
    const result = await w.payments.reserveHandlePayment(handleInput("no_name"));
    expect(result).toMatchObject({ ok: true, attempt: { recipientHandle: "no_name", recipientAppUserId: "app-user-3", recipientDisplayName: null, recipient: safe(3) } });
  });

  it("the recipient's passkey state is irrelevant: zero, pending-only, revoking-only, and revoked-only recipients are all payable", async () => {
    for (const status of ["pending", "revoking", "revoked", "none"] as const) {
      const w = await world();
      const passkey = w.internals.passkeysByCredentialId.get("cred-2")!;
      if (status === "none") w.internals.passkeysByCredentialId.delete("cred-2");
      else w.internals.passkeysByCredentialId.set("cred-2", { ...passkey, status });
      expect(await w.payments.reserveHandlePayment(handleInput("maya_chen")), status).toMatchObject({ ok: true, attempt: { recipientAppUserId: "app-user-2" } });
    }
  });

  it("refuses with recipient_not_found — and creates NOTHING — for reserved, nonexistent, unclaimed-lookalike, missing-account, and invalid-Safe handles", async () => {
    const w = await world();
    // A claimed row whose account does not exist (representable only in the in-memory directory).
    w.internals.handleDirectory!.byHandle.set("ghost", { handle: "ghost", kind: "claimed", appUserId: "no-such-account" });
    // An account whose Safe is not a valid address.
    const account = w.internals.accountsByAppUserId.get("app-user-3")!;
    w.internals.accountsByAppUserId.set("app-user-3", { ...account, safeAddress: "not-an-address" });
    for (const handle of ["admin", "support", "nobody", "ghost", "no_name", "Smit", "@smit", " smit", "smi", ""]) {
      expect(await w.payments.reserveHandlePayment(handleInput(handle)), JSON.stringify(handle)).toEqual({ ok: false, reason: "recipient_not_found" });
    }
    expect(await attemptsOf(w, "app-user-4")).toEqual([]);
  });

  it("self-payment: the handle is the payer's own account -> self_payment, nothing is created", async () => {
    const w = await world();
    expect(await w.payments.reserveHandlePayment(handleInput("smit", "app-user-1"))).toEqual({ ok: false, reason: "self_payment" });
    expect(await attemptsOf(w, "app-user-1")).toEqual([]);
  });

  it("self is decided by app_user_id, not address: paying another account whose Safe differs is fine, and the payer's own Safe address in the input does not matter", async () => {
    const w = await world();
    const input = { ...handleInput("smit", "app-user-2"), safeAddress: safe(1) }; // a payer claiming someone else's Safe address is not self
    expect(await w.payments.reserveHandlePayment(input)).toMatchObject({ ok: true, attempt: { recipientAppUserId: "app-user-1" } });
  });

  it("classification order: not_found, then self_payment, then payment_in_progress, then quota_exceeded", async () => {
    const w = await world();
    // The payer (app-user-1) has an active payment.
    expect((await w.payments.reserve(addressInput(owner(9), "app-user-1"))).ok).toBe(true);
    expect(await w.payments.reserveHandlePayment(handleInput("nobody", "app-user-1"))).toEqual({ ok: false, reason: "recipient_not_found" });
    expect(await w.payments.reserveHandlePayment(handleInput("smit", "app-user-1"))).toEqual({ ok: false, reason: "self_payment" });
    expect(await w.payments.reserveHandlePayment(handleInput("maya_chen", "app-user-1"))).toEqual({ ok: false, reason: "payment_in_progress" });
  });

  it("address and handle attempts share ONE active-payment rule and ONE quota", async () => {
    const w = await world();
    const first = await w.payments.reserveHandlePayment(handleInput("maya_chen"));
    expect(first.ok).toBe(true);
    // An active HANDLE attempt blocks an address attempt, and a handle attempt.
    expect(await w.payments.reserve(addressInput(owner(9)))).toEqual({ ok: false, reason: "payment_in_progress" });
    expect(await w.payments.reserveHandlePayment(handleInput("smit"))).toEqual({ ok: false, reason: "payment_in_progress" });
    if (!first.ok) return;
    await w.payments.transition({ id: first.attempt.id, from: "prepared", to: "cancelled" });
    // ...and the other way round.
    const address = await w.payments.reserve(addressInput(owner(9)));
    expect(address.ok).toBe(true);
    expect(await w.payments.reserveHandlePayment(handleInput("maya_chen"))).toEqual({ ok: false, reason: "payment_in_progress" });
  });

  it(`quota counts handle and address attempts together: ${PAYMENT_RATE_LIMIT.perHour} in an hour, then quota_exceeded for either`, async () => {
    const w = await world();
    for (let i = 0; i < PAYMENT_RATE_LIMIT.perHour; i += 1) {
      const reserved = i % 2 === 0 ? await w.payments.reserveHandlePayment(handleInput("maya_chen")) : await w.payments.reserve(addressInput(owner(9)));
      expect(reserved.ok, `reservation ${i}`).toBe(true);
      if (reserved.ok) await w.payments.transition({ id: reserved.attempt.id, from: "prepared", to: "cancelled" });
    }
    expect(await w.payments.reserveHandlePayment(handleInput("maya_chen"))).toEqual({ ok: false, reason: "quota_exceeded" });
    expect(await w.payments.reserve(addressInput(owner(9)))).toEqual({ ok: false, reason: "quota_exceeded" });
  });

  it("concurrency: five simultaneous handle reserves for one payer produce exactly one success; the rest are payment_in_progress", async () => {
    const w = await world();
    const results = await Promise.all(Array.from({ length: 5 }, () => w.payments.reserveHandlePayment(handleInput("maya_chen"))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual(Array(4).fill({ ok: false, reason: "payment_in_progress" }));
    expect(await attemptsOf(w, "app-user-4")).toHaveLength(1);
  });

  it("concurrency: a mixed burst of address and handle reserves still yields exactly one active attempt", async () => {
    const w = await world();
    const results = await Promise.all([
      w.payments.reserveHandlePayment(handleInput("maya_chen")),
      w.payments.reserve(addressInput(owner(9))),
      w.payments.reserveHandlePayment(handleInput("smit")),
      w.payments.reserve(addressInput(owner(8))),
      w.payments.reserveHandlePayment(handleInput("no_name")),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await attemptsOf(w, "app-user-4")).toHaveLength(1);
  });

  it("only payer/payment fields can influence a handle reservation: forged recipient, app-user, Safe, and display-name fields are ignored", async () => {
    const w = await world();
    const forged = {
      ...handleInput("maya_chen"),
      recipient: owner(9),
      recipientAddress: owner(9),
      recipientAppUserId: "app-user-1",
      recipientDisplayName: "Forged Name",
      recipientSafeAddress: owner(9),
      recipientHandle: "maya_chen", // the one legitimate field
    } as unknown as ReserveHandlePaymentInput;
    const result = await w.payments.reserveHandlePayment(forged);
    expect(result).toMatchObject({ ok: true, attempt: { recipient: MIXED_SAFE_2.toLowerCase(), recipientAppUserId: "app-user-2", recipientDisplayName: "Maya Chen" } });
    // ...and a forged recipient cannot turn a non-existent handle into a payment.
    const w2 = await world();
    const bad = { ...handleInput("nobody"), recipient: safe(2), recipientAppUserId: "app-user-2" } as unknown as ReserveHandlePaymentInput;
    expect(await w2.payments.reserveHandlePayment(bad)).toEqual({ ok: false, reason: "recipient_not_found" });
  });

  it("fails closed without a registry or a handle store: not_found, never a throw and never an attempt", async () => {
    const noRegistry = createInMemoryPaymentAttemptStore();
    expect(await noRegistry.reserveHandlePayment(handleInput("maya_chen"))).toEqual({ ok: false, reason: "recipient_not_found" });
    const registry = createInMemoryRealAccountRegistry();
    const noHandles = createInMemoryPaymentAttemptStore(registry);
    expect(await noHandles.reserveHandlePayment(handleInput("maya_chen"))).toEqual({ ok: false, reason: "recipient_not_found" });
  });
});

describe("reserve() stays address-only", () => {
  it("writes the identity snapshot as all-null — including when the address IS a known account's Safe", async () => {
    const w = await world();
    const handleReads = vi.spyOn(w.internals.handleDirectory!.byHandle, "get");
    const result = await w.payments.reserve(addressInput(safe(2).toLowerCase()));
    expect(result).toMatchObject({ ok: true, attempt: { recipient: safe(2).toLowerCase(), recipientAppUserId: null, recipientHandle: null, recipientDisplayName: null } });
    expect(handleReads).not.toHaveBeenCalled(); // no handle lookup of any kind
    expect(await attemptsOf(w, "app-user-4")).toHaveLength(1);
  });

  it("direct-address self-pay is unchanged in Slice B (still an address payment, still allowed)", async () => {
    const w = await world();
    const own = safe(4);
    expect(await w.payments.reserve(addressInput(own, "app-user-4"))).toMatchObject({ ok: true, attempt: { recipient: own, recipientAppUserId: null, recipientHandle: null, recipientDisplayName: null } });
  });

  it("an address attempt and a handle attempt differ only in the identity snapshot and recipient resolution", async () => {
    const w = await world();
    const a = await w.payments.reserve(addressInput(MIXED_SAFE_2.toLowerCase()));
    if (!a.ok) throw new Error("expected reservation");
    await w.payments.transition({ id: a.attempt.id, from: "prepared", to: "cancelled" });
    const h = await w.payments.reserveHandlePayment(handleInput("maya_chen"));
    if (!h.ok) throw new Error("expected reservation");
    expect(h.attempt.recipient).toBe(a.attempt.recipient);
    expect(Object.keys(h.attempt).sort()).toEqual(Object.keys(a.attempt).sort());
  });
});

// ------------------------------------------------------------------ Neon adapter

const NEON_SOURCE = readFileSync("lib/real/server/neon-store.ts", "utf8");
/** Strips comments so assertions look only at code and SQL. */
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
function methodBody(name: "reserve" | "reserveHandlePayment"): string {
  const start = NEON_SOURCE.indexOf(`async ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const next = NEON_SOURCE.indexOf("    async ", start + 10);
  return stripComments(NEON_SOURCE.slice(start, next));
}

describe("Neon reserveHandlePayment — ONE authoritative statement (structure)", () => {
  const body = methodBody("reserveHandlePayment");
  const flat = body.replace(/\s+/g, " ");

  it("issues exactly one sql`...` call before any zero-row classification read", () => {
    const beforeFollowUp = body.slice(0, body.indexOf("if (rows.length === 0)"));
    expect(beforeFollowUp.match(/sql`/g)).toHaveLength(1);
    expect((body.match(/sql`/g) ?? []).length).toBe(2); // the statement, then the informational read
  });

  it("the one statement carries the existing lock + count structure, the handle and account joins, the claimed predicate, lower(a.safe_address), and the INSERT", () => {
    const statement = flat.slice(flat.indexOf("sql`"), flat.indexOf("`) as Row[]"));
    expect(statement).toContain("WITH _lock AS MATERIALIZED ( SELECT pg_advisory_xact_lock(hashtext(${input.appUserId})::bigint) )");
    expect(statement).toContain("FROM payment_attempts, _lock WHERE app_user_id = ${input.appUserId}");
    expect(statement).toContain("count(*) FILTER (WHERE state NOT IN ('confirmed', 'failed', 'cancelled')) AS active");
    expect(statement).toContain("JOIN real_account_handles h ON h.handle = ${input.recipientHandle} AND h.kind = 'claimed'");
    expect(statement).toContain("JOIN real_accounts a ON a.app_user_id = h.app_user_id");
    expect(statement).toContain("WHERE _counts.hourly < 10 AND _counts.daily < 30 AND _counts.active = 0");
    expect(statement).toContain("AND a.app_user_id <> ${input.appUserId}");
    expect(statement).toContain("AND a.safe_address ~ '^0x[0-9a-fA-F]{40}$'");
    expect(statement).toContain("pg_catalog.lower(a.safe_address)");
    expect(statement).toContain(
      "INSERT INTO payment_attempts (app_user_id, safe_address, recipient, amount_base_units, chain_id, token_address, state, authorizing_credential_id, recipient_app_user_id, recipient_handle, recipient_display_name)",
    );
    expect(statement).toContain("'prepared', ${input.authorizingCredentialId}, a.app_user_id, h.handle, a.display_name FROM _counts");
    expect(statement).toContain("RETURNING *");
  });

  it("the three identity values and the destination come ONLY from the joined rows — no caller-supplied recipient parameter exists", () => {
    const statement = flat.slice(flat.indexOf("sql`"), flat.indexOf("`) as Row[]"));
    const params = [...statement.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]).sort();
    expect(params).toEqual([
      "input.amountBaseUnits",
      "input.appUserId",
      "input.appUserId",
      "input.appUserId",
      "input.appUserId",
      "input.authorizingCredentialId",
      "input.chainId",
      "input.recipientHandle",
      "input.safeAddress",
      "input.tokenAddress",
    ]);
    expect(statement).not.toMatch(/input\.recipient(?!Handle)/);
  });

  it("never references the Turnkey owner column or the passkey table", () => {
    expect(body).not.toMatch(/owner_?address/i);
    expect(body).not.toContain("real_passkeys");
  });

  it("reserve() (address) stays a single statement that names the three identity columns as explicit NULLs and never touches the handle tables", () => {
    const address = methodBody("reserve");
    const flatAddress = address.replace(/\s+/g, " ");
    expect(flatAddress).toContain("authorizing_credential_id, recipient_app_user_id, recipient_handle, recipient_display_name)");
    expect(flatAddress).toContain("NULL::text, NULL::text, NULL::text FROM _counts");
    expect(address).not.toMatch(/real_account_handles|real_accounts|real_passkeys|owner_?address/i);
    expect(address.slice(0, address.indexOf("if (rows.length === 0)")).match(/sql`/g)).toHaveLength(1);
  });
});

describe("Neon reserveHandlePayment — behavior against a fake driver", () => {
  type Call = { text: string; values: unknown[] };
  function fakeSql(responses: Array<Array<Record<string, unknown>> | Error>) {
    const calls: Call[] = [];
    const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join("?"), values });
      const next = responses[calls.length - 1];
      if (next === undefined) throw new Error(`unexpected extra query #${calls.length}`);
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    };
    return { store: createNeonPaymentAttemptStore(sql as unknown as NeonQueryFunction<false, false>), calls };
  }
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: "11111111-1111-4111-8111-111111111111",
    app_user_id: "app-user-4",
    safe_address: safe(4),
    recipient: MIXED_SAFE_2.toLowerCase(),
    amount_base_units: "1000000",
    chain_id: 84532,
    token_address: TOKEN,
    state: "prepared",
    authorizing_credential_id: "cred-4",
    recipient_app_user_id: "app-user-2",
    recipient_handle: "maya_chen",
    recipient_display_name: "Maya Chen",
    created_at: "2026-10-09T00:00:00.000Z",
    updated_at: "2026-10-09T00:00:00.000Z",
    ...overrides,
  });

  it("success: ONE query, and the returned row maps to the full snapshot", async () => {
    const { store, calls } = fakeSql([[row()]]);
    const result = await store.reserveHandlePayment(handleInput("maya_chen"));
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: true, attempt: { recipient: MIXED_SAFE_2.toLowerCase(), recipientAppUserId: "app-user-2", recipientHandle: "maya_chen", recipientDisplayName: "Maya Chen" } });
  });

  it("the bound parameters are exactly the payer/payment fields and the handle — never an address, an app user id of the recipient, or a name", async () => {
    const { store, calls } = fakeSql([[row()]]);
    await store.reserveHandlePayment({ ...handleInput("maya_chen"), recipient: owner(9), recipientAppUserId: "app-user-2", recipientDisplayName: "Maya Chen" } as unknown as ReserveHandlePaymentInput);
    const values = calls[0]!.values;
    // In order of appearance: lock key, count filter, payer, payer Safe, amount, chain, token, credential, handle, self-exclusion.
    expect(values).toEqual(["app-user-4", "app-user-4", "app-user-4", safe(4), "1000000", 84532, TOKEN, "cred-4", "maya_chen", "app-user-4"]);
    for (const forbidden of [owner(9), "app-user-2", "Maya Chen", MIXED_SAFE_2, MIXED_SAFE_2.toLowerCase()]) expect(values).not.toContain(forbidden);
  });

  it("a NULL display name maps to null", async () => {
    const { store } = fakeSql([[row({ recipient_display_name: null })]]);
    expect(await store.reserveHandlePayment(handleInput("maya_chen"))).toMatchObject({ ok: true, attempt: { recipientDisplayName: null } });
  });

  it.each([
    ["nothing resolves", { recipient_app_user_id: null, active: 0 }, "recipient_not_found"],
    ["nothing resolves and a payment is active (not_found wins)", { recipient_app_user_id: null, active: 1 }, "recipient_not_found"],
    ["the payer's own handle", { recipient_app_user_id: "app-user-4", active: 0 }, "self_payment"],
    ["the payer's own handle with a payment active (self wins)", { recipient_app_user_id: "app-user-4", active: 2 }, "self_payment"],
    ["another account, a payment is active", { recipient_app_user_id: "app-user-2", active: 1 }, "payment_in_progress"],
    ["another account, nothing active (quota)", { recipient_app_user_id: "app-user-2", active: 0 }, "quota_exceeded"],
  ])("zero rows, then ONE read-only classification query: %s -> %s", async (_label, facts, reason) => {
    const { store, calls } = fakeSql([[], [facts]]);
    expect(await store.reserveHandlePayment(handleInput("maya_chen"))).toEqual({ ok: false, reason });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.text).toMatch(/^\s*SELECT/);
    expect(calls[1]!.text).not.toMatch(/INSERT|UPDATE|DELETE|pg_advisory/i);
    expect(calls[1]!.text).not.toMatch(/real_passkeys|owner_?address/i);
  });

  it("the one-active unique index backstop maps to payment_in_progress (same as reserve())", async () => {
    const violation = Object.assign(new Error('duplicate key value violates unique constraint "payment_attempts_one_active_per_account"'), { code: "23505" });
    const { store, calls } = fakeSql([violation]);
    expect(await store.reserveHandlePayment(handleInput("maya_chen"))).toEqual({ ok: false, reason: "payment_in_progress" });
    expect(calls).toHaveLength(1);
  });

  it("any other database error propagates (the route turns it into a generic 500)", async () => {
    const { store } = fakeSql([new Error("connection refused")]);
    await expect(store.reserveHandlePayment(handleInput("maya_chen"))).rejects.toThrow("connection refused");
  });

  it("reserve() (address) binds the caller's recipient and writes no identity values", async () => {
    const { store, calls } = fakeSql([[row({ recipient: owner(9), recipient_app_user_id: null, recipient_handle: null, recipient_display_name: null })]]);
    const result = await store.reserve(addressInput(owner(9)));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.values).toContain(owner(9));
    expect(result).toMatchObject({ ok: true, attempt: { recipient: owner(9), recipientAppUserId: null, recipientHandle: null, recipientDisplayName: null } });
  });
});

describe("both adapters implement the same store contract", () => {
  it("the interface exposes reserve and reserveHandlePayment on the in-memory and the Neon store", () => {
    const memory: PaymentAttemptStore = createInMemoryPaymentAttemptStore();
    const neon: PaymentAttemptStore = createNeonPaymentAttemptStore((() => Promise.resolve([])) as unknown as NeonQueryFunction<false, false>);
    for (const store of [memory, neon]) {
      expect(typeof store.reserve).toBe("function");
      expect(typeof store.reserveHandlePayment).toBe("function");
    }
  });
});
