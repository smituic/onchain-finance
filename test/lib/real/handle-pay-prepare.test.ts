import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, encodeAbiParameters } from "viem";
import { baseSepolia } from "viem/chains";
import { createInMemoryAccountHandleStore } from "@/lib/real/server/account-handles";
import { parsePrepareRecipientSelector } from "@/lib/real/server/handle-recipient";
import { createInMemoryPaymentAttemptStore, type PaymentAttempt, type PaymentAttemptStore } from "@/lib/real/server/payment-attempts";
import { createInMemoryRealAccountRegistry, getInMemoryRegistryInternals } from "@/lib/real/server/registry";
import { REAL_SESSION_COOKIE_NAME, createSessionPayload, serializeSession } from "@/lib/real/server/session";
import { BASE_SEPOLIA_CHAIN_ID, REAL_CASH_TOKEN } from "@/lib/real/constants";
import { rpcBlock } from "./fixtures/chain-block";

/**
 * Handle Pay Slice B through prepare: the wire contract (exactly one
 * recipient selector), strict canonical handles, the handle reservation, and
 * the SINGLE recipient source for the Safe transfer (reserved.attempt.recipient
 * — for address and handle payments alike). Fixtures give every account an
 * owner address different from its Safe.
 */
const SECRET = "7f3c9a1e5b2d4f60a8c7e9b1d3f5a7c90e2b4d6f8a1c3e5b7d9f0a2c4e6b8d0f";
const ORIGIN = "http://localhost:3000";
const PAYER_OWNER = "0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF";
const PAYER_SAFE = "0xd9a4c22fb34dc74317edc8006140d66c8fa03266";
const MAYA_OWNER = "0x3333333333333333333333333333333333333333";
const MAYA_SAFE = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01"; // mixed-case as stored
const ADDRESS_RECIPIENT = "0x2222222222222222222222222222222222222222";
const BALANCE_OF_SELECTOR = "0x70a08231";
const DECIMALS_SELECTOR = "0x313ce567";

const preparedFields = {
  sender: PAYER_SAFE,
  nonce: BigInt(0),
  factory: undefined,
  factoryData: undefined,
  callData: "0xcalldata",
  callGasLimit: BigInt(80_000),
  verificationGasLimit: BigInt(150_000),
  preVerificationGas: BigInt(60_000),
  maxFeePerGas: BigInt(2_000_000),
  maxPriorityFeePerGas: BigInt(1_000_000),
  paymaster: undefined,
  paymasterData: undefined,
  paymasterVerificationGasLimit: undefined,
  paymasterPostOpGasLimit: undefined,
} as const;

const prepareMock: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<typeof preparedFields>>> = vi.fn(async () => ({ ...preparedFields }));
vi.mock("@/lib/real/server/pimlico", () => ({
  prepareCashTransferUserOperation: (...args: unknown[]) => prepareMock(...(args as [never])),
  sendPreparedUserOperation: vi.fn(),
  fetchUserOperationReceipt: vi.fn(),
}));

const { resolvePreparePayment } = await import("@/lib/real/server/payments");

function publicClient(balance = BigInt(100_000_000)) {
  return createPublicClient({
    chain: baseSepolia,
    transport: custom({
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === "eth_chainId") return `0x${baseSepolia.id.toString(16)}`;
        if (method === "eth_getBlockByNumber") return rpcBlock({ timestamp: BigInt(1_900_000_000) });
        if (method === "eth_call") {
          const selector = ((params?.[0] ?? {}) as { data?: string }).data?.slice(0, 10);
          if (selector === BALANCE_OF_SELECTOR) return encodeAbiParameters([{ type: "uint256" }], [balance]);
          if (selector === DECIMALS_SELECTOR) return encodeAbiParameters([{ type: "uint8" }], [6]);
          throw new Error(`Unexpected selector: ${selector}`);
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    }),
  });
}

async function world() {
  const registry = createInMemoryRealAccountRegistry();
  const seed = async (n: number, owner: string, safe: string) =>
    registry.createAccountWithPasskey({
      account: { appUserId: `app-user-${n}`, subOrganizationId: `sub-org-${n}`, turnkeyUserId: `turnkey-user-${n}`, walletId: `wallet-${n}`, walletAccountId: `wallet-account-${n}`, ownerAddress: owner, safeAddress: safe, accountConfigVersion: 1 },
      passkey: { credentialId: `credential-${n}`, appUserId: `app-user-${n}`, credentialPublicKey: "cose", userHandle: `user-handle-${n}`, counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false },
    });
  await seed(1, PAYER_OWNER, PAYER_SAFE);
  await seed(2, MAYA_OWNER, MAYA_SAFE);
  const payments = createInMemoryPaymentAttemptStore(registry); // built BEFORE the handle store, like runtime.ts
  const handles = createInMemoryAccountHandleStore(registry);
  await handles.claim({ handle: "maya_chen", appUserId: "app-user-2", credentialId: "credential-2" });
  await handles.setDisplayName({ appUserId: "app-user-2", displayName: "Maya Chen" });
  await handles.claim({ handle: "payer_one", appUserId: "app-user-1", credentialId: "credential-1" });
  return { registry, payments, handles, internals: getInMemoryRegistryInternals(registry) };
}
type World = Awaited<ReturnType<typeof world>>;

const cookieFor = (n: number) => serializeSession(createSessionPayload({ appUserId: `app-user-${n}`, credentialId: `credential-${n}`, sessionEpoch: 0 }), SECRET);

function prepare(w: World, recipient: Parameters<typeof resolvePreparePayment>[0]["recipient"], overrides: Partial<Parameters<typeof resolvePreparePayment>[0]> = {}) {
  return resolvePreparePayment({
    cookieValue: cookieFor(1),
    sessionSecret: SECRET,
    registry: w.registry,
    paymentStore: w.payments,
    publicClient: publicClient(),
    pimlicoApiKey: "pim_test_key",
    recipient,
    amountBaseUnitsInput: "1000000",
    ...overrides,
  });
}
const handleSelector = (body: unknown) => parsePrepareRecipientSelector(body);

beforeEach(() => {
  prepareMock.mockReset();
  prepareMock.mockImplementation(async () => ({ ...preparedFields }));
});

describe("parsePrepareRecipientSelector — exactly one selector, parsed once", () => {
  it("an address selector", () => {
    expect(parsePrepareRecipientSelector({ recipient: ADDRESS_RECIPIENT, amountBaseUnits: "1" })).toEqual({ kind: "address", value: ADDRESS_RECIPIENT });
  });

  it("a canonical handle selector", () => {
    expect(parsePrepareRecipientSelector({ recipientHandle: "smit" })).toEqual({ kind: "handle", handle: "smit" });
    expect(parsePrepareRecipientSelector({ recipientHandle: "maya_chen" })).toEqual({ kind: "handle", handle: "maya_chen" });
  });

  it("both selectors, neither, or a non-object body -> null (invalid_recipient), never 'pick one'", () => {
    expect(parsePrepareRecipientSelector({ recipient: ADDRESS_RECIPIENT, recipientHandle: "smit" })).toBeNull();
    expect(parsePrepareRecipientSelector({})).toBeNull();
    expect(parsePrepareRecipientSelector({ amountBaseUnits: "1" })).toBeNull();
    for (const body of [null, undefined, "smit", 42, true, ["smit"]]) expect(parsePrepareRecipientSelector(body), JSON.stringify(body)).toBeNull();
  });

  it("a present-but-wrong-typed value still counts as present, so it cannot hide a second selector", () => {
    expect(parsePrepareRecipientSelector({ recipient: null, recipientHandle: "smit" })).toBeNull();
    expect(parsePrepareRecipientSelector({ recipient: ADDRESS_RECIPIENT, recipientHandle: null })).toBeNull();
    expect(parsePrepareRecipientSelector({ recipient: "", recipientHandle: "smit" })).toBeNull();
  });

  it('a handle must ALREADY be canonical: "smit" is accepted; "@smit", "Smit", whitespace, and every other spelling is invalid_handle', () => {
    for (const bad of ["@smit", "Smit", "SMIT", " smit", "smit ", "\tsmit\n", "@Smit", "@@smit", "", "@", "ab", "a".repeat(21), "1smit", "smit_", "sm it", "smít", "ｓｍｉｔ", "Kmit", 42, null, {}, ["smit"]]) {
      expect(parsePrepareRecipientSelector({ recipientHandle: bad }), JSON.stringify(bad)).toEqual({ kind: "invalid_handle" });
    }
  });

  it("only the two selector keys are ever read: forged identity keys change nothing", () => {
    const forged = { recipientHandle: "smit", recipientAppUserId: "app-user-9", recipientSafeAddress: ADDRESS_RECIPIENT, recipientDisplayName: "Forged", safeAddress: ADDRESS_RECIPIENT, appUserId: "app-user-9" };
    expect(parsePrepareRecipientSelector(forged)).toEqual({ kind: "handle", handle: "smit" });
  });
});

describe("resolvePreparePayment — handle path", () => {
  it("a claimed canonical handle prepares: recipient = lower(Safe), the snapshot is persisted, and the encoder receives exactly reserved.attempt.recipient", async () => {
    const w = await world();
    const reserveHandle = vi.spyOn(w.payments, "reserveHandlePayment");
    const reserve = vi.spyOn(w.payments, "reserve");

    const outcome = await prepare(w, handleSelector({ recipientHandle: "maya_chen" }));

    expect(outcome.outcome).toBe("ready");
    expect(reserve).not.toHaveBeenCalled();
    // reserveHandlePayment is told ONLY payer/payment fields and the handle.
    expect(reserveHandle).toHaveBeenCalledTimes(1);
    expect(reserveHandle.mock.calls[0]![0]).toEqual({
      appUserId: "app-user-1",
      safeAddress: PAYER_SAFE,
      recipientHandle: "maya_chen",
      amountBaseUnits: "1000000",
      chainId: BASE_SEPOLIA_CHAIN_ID,
      tokenAddress: REAL_CASH_TOKEN.address,
      authorizingCredentialId: "credential-1",
    });
    if (outcome.outcome !== "ready") return;
    const stored = (await w.payments.findById(outcome.attempt.id))!;
    expect(stored).toMatchObject({
      recipient: MAYA_SAFE.toLowerCase(),
      recipientAppUserId: "app-user-2",
      recipientHandle: "maya_chen",
      recipientDisplayName: "Maya Chen",
      authorizingCredentialId: "credential-1",
      state: "awaiting_authorization",
    });
    expect(stored.recipient).not.toBe(MAYA_OWNER.toLowerCase());
    expect(prepareMock).toHaveBeenCalledTimes(1);
    expect(prepareMock.mock.calls[0]![0]).toMatchObject({ recipient: stored.recipient, ownerAddress: PAYER_OWNER, amountBaseUnits: "1000000" });
    expect(outcome.attempt.recipient).toBe(stored.recipient);
  });

  it("a recipient with zero active passkeys is payable through prepare", async () => {
    const w = await world();
    w.internals.passkeysByCredentialId.set("credential-2", { ...w.internals.passkeysByCredentialId.get("credential-2")!, status: "revoked" });
    expect((await prepare(w, handleSelector({ recipientHandle: "maya_chen" }))).outcome).toBe("ready");
  });

  it("the prepare response carries no recipient identity beyond the public attempt shape", async () => {
    const w = await world();
    const outcome = await prepare(w, handleSelector({ recipientHandle: "maya_chen" }));
    expect(outcome.outcome).toBe("ready");
    if (outcome.outcome !== "ready") return;
    expect(Object.keys(outcome).sort()).toEqual(["attempt", "authorizingCredentialId", "outcome", "serverNowSeconds", "subOrganizationId"]);
    expect(Object.keys(outcome.attempt).sort()).toEqual(["amountBaseUnits", "createdAt", "failureReason", "id", "prepared", "recipient", "state", "transactionHash", "updatedAt"]);
    expect(JSON.stringify(outcome)).not.toMatch(/app-user-2|maya_chen|Maya Chen|recipientAppUserId|recipientHandle|recipientDisplayName|turnkey-user-2|sub-org-2/);
  });

  it("a reserved handle, a nonexistent one, and an invalid-Safe account are one recipient_not_found — and nothing is reserved or prepared", async () => {
    const w = await world();
    const account = w.internals.accountsByAppUserId.get("app-user-2")!;
    for (const handle of ["admin", "support", "nobody"]) {
      expect(await prepare(w, handleSelector({ recipientHandle: handle })), handle).toEqual({ outcome: "recipient_not_found" });
    }
    w.internals.accountsByAppUserId.set("app-user-2", { ...account, safeAddress: "not-an-address" });
    expect(await prepare(w, handleSelector({ recipientHandle: "maya_chen" }))).toEqual({ outcome: "recipient_not_found" });
    expect(await w.payments.findRecentByAppUserId({ appUserId: "app-user-1", limit: 10 })).toEqual([]);
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it("self handle -> self_payment, with no attempt inserted and no Pimlico call", async () => {
    const w = await world();
    expect(await prepare(w, handleSelector({ recipientHandle: "payer_one" }))).toEqual({ outcome: "self_payment" });
    expect(await w.payments.findRecentByAppUserId({ appUserId: "app-user-1", limit: 10 })).toEqual([]);
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it("a non-canonical handle fails BEFORE the store is touched: invalid_recipient_handle", async () => {
    const w = await world();
    const reserveHandle = vi.spyOn(w.payments, "reserveHandlePayment");
    const reserve = vi.spyOn(w.payments, "reserve");
    for (const bad of ["@maya_chen", "Maya_Chen", " maya_chen", "maya_chen "]) {
      expect(await prepare(w, handleSelector({ recipientHandle: bad })), JSON.stringify(bad)).toEqual({ outcome: "invalid_recipient_handle" });
    }
    expect(reserveHandle).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it("both selectors, or neither (selector null) -> invalid_recipient, after authentication", async () => {
    const w = await world();
    expect(await prepare(w, handleSelector({ recipient: ADDRESS_RECIPIENT, recipientHandle: "maya_chen" }))).toEqual({ outcome: "invalid_recipient" });
    expect(await prepare(w, handleSelector({}))).toEqual({ outcome: "invalid_recipient" });
    // Authentication still comes first.
    expect(await prepare(w, handleSelector({}), { cookieValue: undefined })).toEqual({ outcome: "unauthenticated" });
    expect(await prepare(w, handleSelector({ recipientHandle: "@x" }), { cookieValue: "garbage" })).toEqual({ outcome: "unauthenticated" });
  });

  it("quota_exceeded and payment_in_progress come straight from the store (shared with the address path)", async () => {
    const w = await world();
    expect((await prepare(w, handleSelector({ recipientHandle: "maya_chen" }))).outcome).toBe("ready");
    expect(await prepare(w, handleSelector({ recipientHandle: "maya_chen" }))).toEqual({ outcome: "payment_in_progress" });
    expect(await prepare(w, { kind: "address", value: ADDRESS_RECIPIENT })).toEqual({ outcome: "payment_in_progress" });
    const w2 = await world();
    vi.spyOn(w2.payments, "reserveHandlePayment").mockResolvedValueOnce({ ok: false, reason: "quota_exceeded" });
    expect(await prepare(w2, handleSelector({ recipientHandle: "maya_chen" }))).toEqual({ outcome: "quota_exceeded" });
  });

  it("insufficient balance is still checked before anything is reserved", async () => {
    const w = await world();
    const reserveHandle = vi.spyOn(w.payments, "reserveHandlePayment");
    expect(await prepare(w, handleSelector({ recipientHandle: "maya_chen" }), { publicClient: publicClient(BigInt(1)) })).toEqual({ outcome: "insufficient_balance" });
    expect(reserveHandle).not.toHaveBeenCalled();
  });
});

describe("resolvePreparePayment — address path is unchanged", () => {
  it("an address payment goes through reserve() only, with the three identity fields NULL and no handle lookup", async () => {
    const w = await world();
    const reserve = vi.spyOn(w.payments, "reserve");
    const reserveHandle = vi.spyOn(w.payments, "reserveHandlePayment");
    const directoryReads = vi.spyOn(w.internals.handleDirectory!.byHandle, "get");

    const outcome = await prepare(w, { kind: "address", value: ADDRESS_RECIPIENT.toUpperCase().replace("0X", "0x") });

    expect(outcome.outcome).toBe("ready");
    expect(reserveHandle).not.toHaveBeenCalled();
    expect(directoryReads).not.toHaveBeenCalled();
    expect(reserve).toHaveBeenCalledWith({
      appUserId: "app-user-1",
      safeAddress: PAYER_SAFE,
      recipient: ADDRESS_RECIPIENT, // normalized exactly as before
      amountBaseUnits: "1000000",
      chainId: BASE_SEPOLIA_CHAIN_ID,
      tokenAddress: REAL_CASH_TOKEN.address,
      authorizingCredentialId: "credential-1",
    });
    if (outcome.outcome !== "ready") return;
    expect(await w.payments.findById(outcome.attempt.id)).toMatchObject({ recipient: ADDRESS_RECIPIENT, recipientAppUserId: null, recipientHandle: null, recipientDisplayName: null });
    expect(prepareMock.mock.calls[0]![0]).toMatchObject({ recipient: ADDRESS_RECIPIENT });
  });

  it("an address that equals a known account's Safe stays an ADDRESS payment — no handle identity is inferred", async () => {
    const w = await world();
    const outcome = await prepare(w, { kind: "address", value: MAYA_SAFE });
    expect(outcome.outcome).toBe("ready");
    if (outcome.outcome !== "ready") return;
    expect(await w.payments.findById(outcome.attempt.id)).toMatchObject({ recipient: MAYA_SAFE.toLowerCase(), recipientAppUserId: null, recipientHandle: null, recipientDisplayName: null });
  });

  it("direct-address self-pay is unchanged: allowed, still an address payment", async () => {
    const w = await world();
    const outcome = await prepare(w, { kind: "address", value: PAYER_SAFE });
    expect(outcome.outcome).toBe("ready");
    if (outcome.outcome !== "ready") return;
    expect(await w.payments.findById(outcome.attempt.id)).toMatchObject({ recipient: PAYER_SAFE.toLowerCase(), recipientAppUserId: null, recipientHandle: null });
  });

  it("a malformed address is invalid_recipient before the store is touched; a non-string address too", async () => {
    const w = await world();
    const reserve = vi.spyOn(w.payments, "reserve");
    expect(await prepare(w, { kind: "address", value: "not-an-address" })).toEqual({ outcome: "invalid_recipient" });
    expect(await prepare(w, { kind: "address", value: 42 })).toEqual({ outcome: "invalid_recipient" });
    expect(reserve).not.toHaveBeenCalled();
  });
});

describe("the Safe transfer is built from reserved.attempt.recipient — and only that — for BOTH paths", () => {
  /** A store whose reservations record a recipient DIFFERENT from anything the request named. */
  function storeRecording(recipient: string, base: PaymentAttemptStore): PaymentAttemptStore {
    const tamper = <T extends { ok: boolean }>(result: T): T => (result.ok ? ({ ...result, attempt: { ...(result as unknown as { attempt: PaymentAttempt }).attempt, recipient } } as T) : result);
    return { ...base, reserve: async (input) => tamper(await base.reserve(input)), reserveHandlePayment: async (input) => tamper(await base.reserveHandlePayment(input)) };
  }

  it("what the encoder receives is exactly the attempt's recorded recipient (address path)", async () => {
    const w = await world();
    const recorded = "0x9999999999999999999999999999999999999999";
    await prepare(w, { kind: "address", value: ADDRESS_RECIPIENT }, { paymentStore: storeRecording(recorded, w.payments) });
    expect(prepareMock.mock.calls[0]![0]).toMatchObject({ recipient: recorded });
    expect(prepareMock.mock.calls[0]![0]).not.toMatchObject({ recipient: ADDRESS_RECIPIENT });
  });

  it("... and on the handle path (the Safe is not re-derived anywhere else)", async () => {
    const w = await world();
    const recorded = "0x9999999999999999999999999999999999999999";
    await prepare(w, handleSelector({ recipientHandle: "maya_chen" }), { paymentStore: storeRecording(recorded, w.payments) });
    expect(prepareMock.mock.calls[0]![0]).toMatchObject({ recipient: recorded });
  });

  it("the recorded recipient is re-normalized: a mixed-case record is encoded lower-cased", async () => {
    const w = await world();
    await prepare(w, handleSelector({ recipientHandle: "maya_chen" }), { paymentStore: storeRecording("0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", w.payments) });
    expect(prepareMock.mock.calls[0]![0]).toMatchObject({ recipient: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  });

  it.each([["garbage"], [""], ["0x1234"], [`0x${"g".repeat(40)}`]])("an unusable recorded recipient (%j) fails closed: SAFE_PREPARE_FAILED, the attempt is failed, the encoder is never called", async (bad) => {
    for (const selector of [{ kind: "address", value: ADDRESS_RECIPIENT } as const, handleSelector({ recipientHandle: "maya_chen" })]) {
      prepareMock.mockClear();
      const w = await world();
      const outcome = await prepare(w, selector, { paymentStore: storeRecording(bad, w.payments) });
      expect(outcome).toEqual({ outcome: "prepare_failed", reason: "Could not prepare this payment right now. Try again in a moment." });
      expect(prepareMock).not.toHaveBeenCalled();
      const [attempt] = await w.payments.findRecentByAppUserId({ appUserId: "app-user-1", limit: 5 });
      expect(attempt).toMatchObject({ state: "failed", failureReason: "Could not prepare this payment right now. Try again in a moment." });
    }
  });
});

// ------------------------------------------------------------------ the actual route

describe("POST /api/real/payments/prepare — the actual route code", () => {
  const stubEnv = () => {
    vi.stubEnv("NEXT_PUBLIC_REAL_MODE_ENABLED", "true");
    vi.stubEnv("TURNKEY_PARENT_ORGANIZATION_ID", "parent-org");
    vi.stubEnv("TURNKEY_API_PUBLIC_KEY", "public-key");
    vi.stubEnv("TURNKEY_API_PRIVATE_KEY", "private-key");
    vi.stubEnv("REAL_SESSION_SECRET", SECRET);
    vi.stubEnv("NEXT_PUBLIC_REAL_RP_ID", "localhost");
    vi.stubEnv("NEXT_PUBLIC_REAL_ORIGIN", ORIGIN);
    vi.stubEnv("PIMLICO_API_KEY", "pim_test_key");
  };

  async function load(w: World, cookie: string | undefined) {
    vi.resetModules();
    stubEnv();
    vi.doMock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => (name === REAL_SESSION_COOKIE_NAME && cookie !== undefined ? { name, value: cookie } : undefined) }) }));
    vi.doMock("@/lib/real/server/runtime", () => ({ getRealAccountRegistry: () => w.registry, getPaymentAttemptStore: () => w.payments, getAccountHandleStore: () => w.handles }));
    vi.doMock("@/lib/real/chain/client", () => ({ createRealPublicClient: () => publicClient() }));
    vi.doMock("@/lib/real/server/pimlico", () => ({
      prepareCashTransferUserOperation: (...args: unknown[]) => prepareMock(...(args as [never])),
      sendPreparedUserOperation: vi.fn(),
      fetchUserOperationReceipt: vi.fn(),
    }));
    const route = await import("@/app/api/real/payments/prepare/route");
    return (body: unknown) => route.POST(new Request("http://localhost/api/real/payments/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("next/headers");
    vi.doUnmock("@/lib/real/server/runtime");
    vi.doUnmock("@/lib/real/chain/client");
    vi.doUnmock("@/lib/real/server/pimlico");
  });

  it('{ recipientHandle: "maya_chen", amountBaseUnits } -> 200 ready; the handle is bound and the response has no recipient identity', async () => {
    const w = await world();
    const post = await load(w, cookieFor(1));
    const response = await post({ recipientHandle: "maya_chen", amountBaseUnits: "1000000" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["attempt", "authorizingCredentialId", "serverNowSeconds", "subOrganizationId"]);
    expect(body.attempt.recipient).toBe(MAYA_SAFE.toLowerCase());
    expect(JSON.stringify(body)).not.toMatch(/app-user-2|maya_chen|Maya Chen|recipientAppUserId|recipientHandle|recipientDisplayName/);
    expect(await w.payments.findById(body.attempt.id)).toMatchObject({ recipientHandle: "maya_chen", recipientAppUserId: "app-user-2", recipientDisplayName: "Maya Chen" });
  });

  it("{ recipient, amountBaseUnits } still works and stores a NULL identity", async () => {
    const w = await world();
    const response = await (await load(w, cookieFor(1)))({ recipient: ADDRESS_RECIPIENT, amountBaseUnits: "1000000" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(await w.payments.findById(body.attempt.id)).toMatchObject({ recipient: ADDRESS_RECIPIENT, recipientAppUserId: null, recipientHandle: null, recipientDisplayName: null });
  });

  it("both selectors, or neither -> 400 invalid_recipient, nothing reserved", async () => {
    const w = await world();
    const post = await load(w, cookieFor(1));
    for (const body of [{ recipient: ADDRESS_RECIPIENT, recipientHandle: "maya_chen", amountBaseUnits: "1000000" }, { amountBaseUnits: "1000000" }, { recipient: null, recipientHandle: "maya_chen", amountBaseUnits: "1000000" }]) {
      const response = await post(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({ error: "Enter a valid recipient address." });
    }
    expect(await w.payments.findRecentByAppUserId({ appUserId: "app-user-1", limit: 10 })).toEqual([]);
  });

  it('"@maya_chen", uppercase, and whitespace-padded handles are refused at prepare (400), exactly "maya_chen" is accepted', async () => {
    const w = await world();
    const post = await load(w, cookieFor(1));
    for (const bad of ["@maya_chen", "Maya_Chen", " maya_chen", "maya_chen\n"]) {
      const response = await post({ recipientHandle: bad, amountBaseUnits: "1000000" });
      expect(response.status, JSON.stringify(bad)).toBe(400);
      expect(await response.json()).toEqual({ error: "Enter a valid @name." });
    }
    expect(await w.payments.findRecentByAppUserId({ appUserId: "app-user-1", limit: 10 })).toEqual([]);
    expect((await post({ recipientHandle: "maya_chen", amountBaseUnits: "1000000" })).status).toBe(200);
  });

  it("recipient_not_found -> 404 (reserved, nonexistent, and invalid Safe are indistinguishable); self_payment -> 400", async () => {
    const w = await world();
    const post = await load(w, cookieFor(1));
    const responses = await Promise.all(["admin", "nobody"].map((handle) => post({ recipientHandle: handle, amountBaseUnits: "1000000" })));
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "We couldn't find anyone with that name." });
    }
    const self = await post({ recipientHandle: "payer_one", amountBaseUnits: "1000000" });
    expect(self.status).toBe(400);
    expect(await self.json()).toEqual({ error: "You can't pay yourself." });
    expect(await w.payments.findRecentByAppUserId({ appUserId: "app-user-1", limit: 10 })).toEqual([]);
  });

  it("forged recipient identity in the body cannot influence a handle payment", async () => {
    const w = await world();
    const post = await load(w, cookieFor(1));
    const response = await post({
      recipientHandle: "maya_chen",
      amountBaseUnits: "1000000",
      recipientAppUserId: "app-user-1",
      recipientSafeAddress: ADDRESS_RECIPIENT,
      recipientDisplayName: "Forged",
      appUserId: "app-user-1",
      safeAddress: ADDRESS_RECIPIENT,
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(await w.payments.findById(body.attempt.id)).toMatchObject({ recipient: MAYA_SAFE.toLowerCase(), recipientAppUserId: "app-user-2", recipientDisplayName: "Maya Chen" });
  });

  it("an unauthenticated request is 401 even with an invalid selector", async () => {
    const w = await world();
    const post = await load(w, undefined);
    expect((await post({ amountBaseUnits: "1000000" })).status).toBe(401);
    expect((await post({ recipientHandle: "@x", amountBaseUnits: "1000000" })).status).toBe(401);
  });
});
