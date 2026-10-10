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
import { denyingRateLimiter, failingRateLimiter, freshRateLimiter, recordingRateLimiter } from "./fixtures/rate-limit";

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

const { resolvePreparePayment, resolveSubmitPayment, resolvePaymentStatus, resolveLatestPayment, resolveCancelPayment } = await import("@/lib/real/server/payments");
const { resolvePaymentHistory } = await import("@/lib/real/server/payment-history");

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
  // One limiter per world, like one process: every prepare in a test draws on the same per-account budgets.
  return { registry, payments, handles, rateLimiter: freshRateLimiter(), internals: getInMemoryRegistryInternals(registry) };
}
type World = Awaited<ReturnType<typeof world>>;

const cookieFor = (n: number) => serializeSession(createSessionPayload({ appUserId: `app-user-${n}`, credentialId: `credential-${n}`, sessionEpoch: 0 }), SECRET);

function prepare(w: World, recipient: Parameters<typeof resolvePreparePayment>[0]["recipient"], overrides: Partial<Parameters<typeof resolvePreparePayment>[0]> = {}) {
  return resolvePreparePayment({
    cookieValue: cookieFor(1),
    sessionSecret: SECRET,
    registry: w.registry,
    paymentStore: w.payments,
    rateLimiter: w.rateLimiter,
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

  it("Slice D: the prepare response carries exactly recipientIdentity { handle, displayName } — and still nothing else about the recipient", async () => {
    const w = await world();
    const outcome = await prepare(w, handleSelector({ recipientHandle: "maya_chen" }));
    expect(outcome.outcome).toBe("ready");
    if (outcome.outcome !== "ready") return;
    expect(Object.keys(outcome).sort()).toEqual(["attempt", "authorizingCredentialId", "outcome", "serverNowSeconds", "subOrganizationId"]);
    expect(Object.keys(outcome.attempt).sort()).toEqual(["amountBaseUnits", "createdAt", "failureReason", "id", "prepared", "recipient", "recipientIdentity", "state", "transactionHash", "updatedAt"]);
    expect(outcome.attempt.recipientIdentity).toEqual({ handle: "maya_chen", displayName: "Maya Chen" });
    expect(Object.keys(outcome.attempt.recipientIdentity!).sort()).toEqual(["displayName", "handle"]);
    // The recipient's account id, Turnkey ids, and the snapshot's flat field names stay server-only.
    expect(JSON.stringify(outcome)).not.toMatch(/app-user-2|recipientAppUserId|recipientHandle|recipientDisplayName|turnkey-user-2|sub-org-2/);
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

// ------------------------------------------------------------------ Slice D: the public recipient identity

/**
 * Handle Pay Slice D — every response that returns a payment attempt, and
 * history, shows its payer `recipientIdentity: { handle, displayName }` for a
 * handle payment and null for an address payment. It is the payment's own
 * stored snapshot (never the recipient's live profile), and the recipient's
 * account id is in none of them.
 */
describe("Slice D — recipientIdentity on every payer-facing read surface", () => {
  const MAYA = { handle: "maya_chen", displayName: "Maya Chen" };
  const NOW_MS = 1_900_000_000_000; // the fixture block's own timestamp: the attempt is inside its validity window
  const session = (w: World, n = 1) => ({ cookieValue: cookieFor(n), sessionSecret: SECRET, registry: w.registry, paymentStore: w.payments });
  const NO_LEAK = /app-user-2|recipientAppUserId|recipientHandle|recipientDisplayName|turnkey-user-2|sub-org-2/;

  async function preparedHandleAttempt(w: World) {
    const outcome = await prepare(w, handleSelector({ recipientHandle: "maya_chen" }));
    if (outcome.outcome !== "ready") throw new Error(`expected ready, got ${outcome.outcome}`);
    return outcome.attempt;
  }

  it("latest, status, cancel, and history all carry the handle payment's identity — and never the recipient's account id", async () => {
    const w = await world();
    const prepared = await preparedHandleAttempt(w);
    expect(prepared.recipientIdentity).toEqual(MAYA);

    const latest = await resolveLatestPayment({ ...session(w), now: () => NOW_MS });
    expect(latest).toMatchObject({ outcome: "ok", attempt: { id: prepared.id, recipient: MAYA_SAFE.toLowerCase(), recipientIdentity: MAYA } });

    const status = await resolvePaymentStatus({ ...session(w), pimlicoApiKey: "pim_test_key", publicClient: publicClient() as never, attemptId: prepared.id, now: () => NOW_MS });
    expect(status).toMatchObject({ outcome: "ok", attempt: { id: prepared.id, state: "awaiting_authorization", recipientIdentity: MAYA } });

    const history = await resolvePaymentHistory({ ...session(w), limitInput: null });
    expect(history).toMatchObject({ outcome: "ok", entries: [{ id: prepared.id, recipient: MAYA_SAFE.toLowerCase(), recipientIdentity: MAYA }] });

    const cancelled = await resolveCancelPayment({ ...session(w), attemptId: prepared.id });
    expect(cancelled).toMatchObject({ outcome: "cancelled", attempt: { id: prepared.id, state: "cancelled", recipientIdentity: MAYA } });

    // The identity is who the payer tried to pay — it stays on a cancelled payment.
    const after = await resolvePaymentHistory({ ...session(w), limitInput: null });
    expect(after).toMatchObject({ outcome: "ok", entries: [{ state: "cancelled", recipientIdentity: MAYA }] });

    for (const response of [latest, status, history, cancelled, after]) expect(JSON.stringify(response)).not.toMatch(NO_LEAK);
  });

  it("submit carries it too (here: a refused signature fails the payment, and the failed attempt still names who it was for)", async () => {
    const w = await world();
    const prepared = await preparedHandleAttempt(w);

    const submitted = await resolveSubmitPayment({
      ...session(w),
      pimlicoApiKey: "pim_test_key",
      config: {} as never,
      attemptId: prepared.id,
      signature: "0x00",
      activityId: "01a12620-1c25-7329-86d4-f8a86a1d8d90",
      now: () => NOW_MS,
    });

    expect(submitted).toMatchObject({ outcome: "failed", attempt: { id: prepared.id, state: "failed", recipient: MAYA_SAFE.toLowerCase(), recipientIdentity: MAYA } });
    expect(JSON.stringify(submitted)).not.toMatch(NO_LEAK);
    expect(await resolvePaymentHistory({ ...session(w), limitInput: null })).toMatchObject({ outcome: "ok", entries: [{ state: "failed", recipientIdentity: MAYA }] });
  });

  it("a handle payment to an account with no display name is { handle, displayName: null } on every surface", async () => {
    const w = await world();
    await w.handles.setDisplayName({ appUserId: "app-user-2", displayName: null });
    const prepared = await preparedHandleAttempt(w);
    const nameless = { handle: "maya_chen", displayName: null };

    expect(prepared.recipientIdentity).toEqual(nameless);
    expect(await resolveLatestPayment({ ...session(w), now: () => NOW_MS })).toMatchObject({ outcome: "ok", attempt: { recipientIdentity: nameless } });
    expect(await resolvePaymentHistory({ ...session(w), limitInput: null })).toMatchObject({ outcome: "ok", entries: [{ recipientIdentity: nameless }] });
  });

  it("SNAPSHOT: after the recipient renames themselves, latest / status / history still show the name stored on the payment", async () => {
    const w = await world();
    const prepared = await preparedHandleAttempt(w);

    await w.handles.setDisplayName({ appUserId: "app-user-2", displayName: "Maya Renamed" });
    // The live profile really did change...
    expect((await w.handles.findPayableAccountByHandle("maya_chen"))?.displayName).toBe("Maya Renamed");

    // ...and no payer-facing read follows it.
    const latest = await resolveLatestPayment({ ...session(w), now: () => NOW_MS });
    const status = await resolvePaymentStatus({ ...session(w), pimlicoApiKey: "pim_test_key", publicClient: publicClient() as never, attemptId: prepared.id, now: () => NOW_MS });
    const history = await resolvePaymentHistory({ ...session(w), limitInput: null });
    expect(latest).toMatchObject({ outcome: "ok", attempt: { recipientIdentity: MAYA } });
    expect(status).toMatchObject({ outcome: "ok", attempt: { recipientIdentity: MAYA } });
    expect(history).toMatchObject({ outcome: "ok", entries: [{ recipientIdentity: MAYA }] });
    for (const response of [latest, status, history]) expect(JSON.stringify(response)).not.toContain("Maya Renamed");

    // A NEW payment takes the new name; the old one keeps the old one.
    await resolveCancelPayment({ ...session(w), attemptId: prepared.id });
    const second = await preparedHandleAttempt(w);
    expect(second.recipientIdentity).toEqual({ handle: "maya_chen", displayName: "Maya Renamed" });
    const both = await resolvePaymentHistory({ ...session(w), limitInput: null });
    if (both.outcome !== "ok") throw new Error("expected history");
    expect(both.entries.map((entry) => entry.recipientIdentity)).toEqual([{ handle: "maya_chen", displayName: "Maya Renamed" }, MAYA]);
  });

  it("ADDRESS: a direct-address payment has recipientIdentity null everywhere — even when the address IS a known handle owner's Safe", async () => {
    const w = await world();
    const outcome = await prepare(w, { kind: "address", value: MAYA_SAFE });
    if (outcome.outcome !== "ready") throw new Error(`expected ready, got ${outcome.outcome}`);
    expect(outcome.attempt).toMatchObject({ recipient: MAYA_SAFE.toLowerCase(), recipientIdentity: null });

    const latest = await resolveLatestPayment({ ...session(w), now: () => NOW_MS });
    const status = await resolvePaymentStatus({ ...session(w), pimlicoApiKey: "pim_test_key", publicClient: publicClient() as never, attemptId: outcome.attempt.id, now: () => NOW_MS });
    const history = await resolvePaymentHistory({ ...session(w), limitInput: null });
    const cancelled = await resolveCancelPayment({ ...session(w), attemptId: outcome.attempt.id });
    expect(latest).toMatchObject({ outcome: "ok", attempt: { recipientIdentity: null } });
    expect(status).toMatchObject({ outcome: "ok", attempt: { recipientIdentity: null } });
    expect(history).toMatchObject({ outcome: "ok", entries: [{ recipient: MAYA_SAFE.toLowerCase(), recipientIdentity: null }] });
    expect(cancelled).toMatchObject({ outcome: "cancelled", attempt: { recipientIdentity: null } });
    for (const response of [outcome, latest, status, history, cancelled]) expect(JSON.stringify(response)).not.toMatch(/maya_chen|Maya Chen|app-user-2/);
  });

  it("AUTHORIZATION is unchanged: another account cannot read the attempt by id, and its latest / history never include it", async () => {
    const w = await world();
    const prepared = await preparedHandleAttempt(w);

    expect(await resolvePaymentStatus({ ...session(w, 2), pimlicoApiKey: "pim_test_key", publicClient: publicClient() as never, attemptId: prepared.id, now: () => NOW_MS })).toEqual({ outcome: "not_found" });
    expect(await resolveCancelPayment({ ...session(w, 2), attemptId: prepared.id })).toEqual({ outcome: "not_found" });
    expect(await resolveLatestPayment({ ...session(w, 2), now: () => NOW_MS })).toEqual({ outcome: "none" });
    expect(await resolvePaymentHistory({ ...session(w, 2), limitInput: null })).toEqual({ outcome: "ok", entries: [] });
    expect(await resolveLatestPayment({ ...session(w), cookieValue: "garbage" })).toEqual({ outcome: "unauthenticated" });
    expect(await resolvePaymentHistory({ ...session(w), cookieValue: "garbage", limitInput: null })).toEqual({ outcome: "unauthenticated" });
  });
});

// ------------------------------------------------------------------ Slice E: rate limiting

/**
 * Handle Pay Slice E — prepare is charged to the PAYER's own budget once the
 * request is authenticated and well-formed, and before the balance read, the
 * block-clock read, the reservation (and, for a handle, the recipient
 * resolution inside it), and Pimlico. An address prepare draws on the prepare
 * budget; a handle prepare on the prepare AND the recipient-probe budgets.
 */
describe("Slice E — prepare rate limiting", () => {
  const PREPARE = ["pay_prepare_day", "pay_prepare_short"];
  const ALL_FOUR = ["pay_prepare_day", "pay_prepare_short", "recipient_probe_day", "recipient_probe_short"];

  /** A chain client that counts every RPC it is asked for, by method. */
  function countingClient() {
    const rpc: string[] = [];
    const client = createPublicClient({
      chain: baseSepolia,
      transport: custom({
        request: async ({ method, params }: { method: string; params?: unknown[] }) => {
          if (method !== "eth_chainId") rpc.push(method);
          if (method === "eth_chainId") return `0x${baseSepolia.id.toString(16)}`;
          if (method === "eth_getBlockByNumber") return rpcBlock({ timestamp: BigInt(1_900_000_000) });
          if (method === "eth_call") {
            const selector = ((params?.[0] ?? {}) as { data?: string }).data?.slice(0, 10);
            if (selector === BALANCE_OF_SELECTOR) return encodeAbiParameters([{ type: "uint256" }], [BigInt(100_000_000)]);
            if (selector === DECIMALS_SELECTOR) return encodeAbiParameters([{ type: "uint8" }], [6]);
          }
          throw new Error(`Unexpected method: ${method}`);
        },
      }),
    });
    return { client, rpc };
  }
  const attemptsOf = (w: World, n = 1) => w.payments.findRecentByAppUserId({ appUserId: `app-user-${n}`, limit: 25 });

  it("an unauthenticated request, an invalid selector, and an invalid amount consume NOTHING", async () => {
    const w = await world();
    const { limiter, charges } = recordingRateLimiter();
    const run = (recipient: Parameters<typeof prepare>[1], overrides: Parameters<typeof prepare>[2] = {}) => prepare(w, recipient, { rateLimiter: limiter, ...overrides });

    expect(await run(handleSelector({ recipientHandle: "maya_chen" }), { cookieValue: undefined })).toEqual({ outcome: "unauthenticated" });
    expect(await run({ kind: "address", value: ADDRESS_RECIPIENT }, { cookieValue: "garbage" })).toEqual({ outcome: "unauthenticated" });
    // Zero or two selectors, a non-canonical handle, a bad address.
    expect(await run(handleSelector({}))).toEqual({ outcome: "invalid_recipient" });
    expect(await run(handleSelector({ recipient: ADDRESS_RECIPIENT, recipientHandle: "maya_chen" }))).toEqual({ outcome: "invalid_recipient" });
    for (const bad of ["@maya_chen", "Maya_Chen", " maya_chen", "ab"]) expect(await run(handleSelector({ recipientHandle: bad })), bad).toEqual({ outcome: "invalid_recipient_handle" });
    for (const bad of ["0x1234", "not an address", 7, null]) expect(await run({ kind: "address", value: bad }), String(bad)).toEqual({ outcome: "invalid_recipient" });
    // A bad amount, on both paths.
    for (const amountBaseUnitsInput of ["0", "-1", "1.5", "", "abc", 1_000_000, null, "99999999999999999999"]) {
      expect(await run(handleSelector({ recipientHandle: "maya_chen" }), { amountBaseUnitsInput }), String(amountBaseUnitsInput)).toEqual({ outcome: "invalid_amount" });
      expect(await run({ kind: "address", value: ADDRESS_RECIPIENT }, { amountBaseUnitsInput }), String(amountBaseUnitsInput)).toEqual({ outcome: "invalid_amount" });
    }
    expect(charges).toEqual([]);
    expect(await attemptsOf(w)).toEqual([]);
  });

  it("an ADDRESS prepare consumes both prepare buckets ONLY; a HANDLE prepare consumes all four — for the payer, with nothing about the recipient", async () => {
    const w = await world();
    const { limiter, charges, inputs } = recordingRateLimiter();

    expect((await prepare(w, { kind: "address", value: ADDRESS_RECIPIENT }, { rateLimiter: limiter })).outcome).toBe("ready");
    expect(charges).toEqual([{ subject: "app-user-1", buckets: PREPARE }]);

    // Whatever the handle turns out to be — payable (here refused only because a payment is in progress), reserved, or nonexistent — the charge is the same.
    expect(await prepare(w, handleSelector({ recipientHandle: "maya_chen" }), { rateLimiter: limiter })).toEqual({ outcome: "payment_in_progress" });
    expect(await prepare(w, handleSelector({ recipientHandle: "nobody_here" }), { rateLimiter: limiter })).toEqual({ outcome: "recipient_not_found" });
    expect(await prepare(w, handleSelector({ recipientHandle: "admin" }), { rateLimiter: limiter })).toEqual({ outcome: "recipient_not_found" });
    expect(charges.slice(1)).toEqual([
      { subject: "app-user-1", buckets: ALL_FOUR },
      { subject: "app-user-1", buckets: ALL_FOUR },
      { subject: "app-user-1", buckets: ALL_FOUR },
    ]);
    expect(JSON.stringify(inputs)).not.toMatch(/maya|nobody_here|admin|app-user-2|0x/i);
  });

  it("the charge comes BEFORE the balance RPC, the block-clock RPC, the reservation, and Pimlico (ordering)", async () => {
    const w = await world();
    const order: string[] = [];
    const { client, rpc } = countingClient();
    const limiter = { consume: async () => (order.push(`limiter(rpc so far: ${rpc.length})`), { allowed: true as const }) };
    const reserve = vi.spyOn(w.payments, "reserveHandlePayment").mockImplementation(async () => (order.push("reserve"), { ok: false, reason: "recipient_not_found" }));
    prepareMock.mockImplementation(async () => (order.push("pimlico"), { ...preparedFields }));

    expect(await prepare(w, handleSelector({ recipientHandle: "maya_chen" }), { rateLimiter: limiter, publicClient: client })).toEqual({ outcome: "recipient_not_found" });

    expect(order).toEqual(["limiter(rpc so far: 0)", "reserve"]);
    expect(rpc).toEqual(expect.arrayContaining(["eth_call", "eth_getBlockByNumber"]));
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it("a rate-limited prepare does NO balance RPC, NO block-clock RPC, creates NO payment attempt, and makes NO Pimlico call — address and handle", async () => {
    for (const recipient of [{ kind: "address", value: ADDRESS_RECIPIENT } as const, handleSelector({ recipientHandle: "maya_chen" })]) {
      const w = await world();
      const { client, rpc } = countingClient();
      const reserve = vi.spyOn(w.payments, "reserve");
      const reserveHandle = vi.spyOn(w.payments, "reserveHandlePayment");

      const outcome = await prepare(w, recipient, { rateLimiter: denyingRateLimiter(250), publicClient: client });

      expect(outcome).toEqual({ outcome: "rate_limited", retryAfterSeconds: 250 });
      expect(rpc).toEqual([]);
      expect(reserve).not.toHaveBeenCalled();
      expect(reserveHandle).not.toHaveBeenCalled();
      expect(prepareMock).not.toHaveBeenCalled();
      expect(await attemptsOf(w)).toEqual([]);
    }
  });

  it("the 21st prepare in a window is rate limited — and it is a different outcome from the payment quota", async () => {
    const w = await world();
    w.rateLimiter = freshRateLimiter(() => 1_900_000_000_000);
    expect((await prepare(w, { kind: "address", value: ADDRESS_RECIPIENT })).outcome).toBe("ready");
    for (let i = 0; i < 19; i++) expect(await prepare(w, { kind: "address", value: ADDRESS_RECIPIENT }), String(i)).toEqual({ outcome: "payment_in_progress" });
    expect(await prepare(w, { kind: "address", value: ADDRESS_RECIPIENT })).toEqual({ outcome: "rate_limited", retryAfterSeconds: 600 });
    expect(await attemptsOf(w)).toHaveLength(1);

    // The payment quota is still its own thing, decided by the store after admission.
    const w2 = await world();
    vi.spyOn(w2.payments, "reserve").mockResolvedValueOnce({ ok: false, reason: "quota_exceeded" });
    expect(await prepare(w2, { kind: "address", value: ADDRESS_RECIPIENT })).toEqual({ outcome: "quota_exceeded" });
  });

  it("budgets are per payer: one account's exhausted budget never limits another", async () => {
    const w = await world();
    w.rateLimiter = freshRateLimiter(() => 1_900_000_000_000);
    for (let i = 0; i < 20; i++) await prepare(w, { kind: "address", value: ADDRESS_RECIPIENT });
    expect((await prepare(w, { kind: "address", value: ADDRESS_RECIPIENT })).outcome).toBe("rate_limited");
    // Account 2 is admitted (whatever its own prepare then does) — it is charged to ITS budget, not refused by account 1's.
    const recording = recordingRateLimiter(w.rateLimiter);
    expect((await prepare(w, { kind: "address", value: ADDRESS_RECIPIENT }, { cookieValue: cookieFor(2), rateLimiter: recording.limiter })).outcome).not.toBe("rate_limited");
    expect(recording.charges).toEqual([{ subject: "app-user-2", buckets: PREPARE }]);
    expect((await prepare(w, { kind: "address", value: ADDRESS_RECIPIENT })).outcome).toBe("rate_limited"); // account 1 is still limited
  });

  it("a limiter failure THROWS out of prepare (fail closed): nothing is read, reserved, or sent", async () => {
    const w = await world();
    const { client, rpc } = countingClient();
    await expect(prepare(w, handleSelector({ recipientHandle: "maya_chen" }), { rateLimiter: failingRateLimiter(), publicClient: client })).rejects.toThrow();
    expect(rpc).toEqual([]);
    expect(prepareMock).not.toHaveBeenCalled();
    expect(await attemptsOf(w)).toEqual([]);
  });

  it("an admitted prepare is otherwise unchanged: same destination, same stored identity, same public attempt", async () => {
    const w = await world();
    const outcome = await prepare(w, handleSelector({ recipientHandle: "maya_chen" }));
    if (outcome.outcome !== "ready") throw new Error(`expected ready, got ${outcome.outcome}`);
    expect(outcome.attempt).toMatchObject({ recipient: MAYA_SAFE.toLowerCase(), recipientIdentity: { handle: "maya_chen", displayName: "Maya Chen" } });
    expect(Object.keys(outcome.attempt).sort()).toEqual(["amountBaseUnits", "createdAt", "failureReason", "id", "prepared", "recipient", "recipientIdentity", "state", "transactionHash", "updatedAt"]);
    expect(await w.payments.findById(outcome.attempt.id)).toMatchObject({ recipientAppUserId: "app-user-2", recipientHandle: "maya_chen", recipientDisplayName: "Maya Chen" });
    expect(JSON.stringify(outcome)).not.toMatch(/app-user-2|recipientAppUserId|bucket|hits/);
  });
});

/**
 * THE ORACLE this slice bounds. With a payment already in progress, a handle
 * prepare never reserves anything — yet its refusal still tells a payable
 * handle (`payment_in_progress`) from a missing one (`recipient_not_found`).
 * Slice B's classification is deliberately unchanged; what changes is that the
 * question can only be asked 20 times per 10 minutes (and 100 per day), on the
 * same budget as the recipient lookup.
 */
describe("Slice E — the handle-prepare existence oracle is bounded", () => {
  it("found vs not-found is still distinguishable while admitted; after the shared probe budget is spent every answer is rate_limited and NO resolution work happens", async () => {
    const w = await world();
    w.rateLimiter = freshRateLimiter(() => 1_900_000_000_000);

    // The payer already has a non-terminal attempt.
    expect((await prepare(w, { kind: "address", value: ADDRESS_RECIPIENT })).outcome).toBe("ready");
    const reserveHandle = vi.spyOn(w.payments, "reserveHandlePayment");
    const { limiter, charges } = recordingRateLimiter(w.rateLimiter);

    // The address prepare above used 1 of the payer's 20 prepares, so 19 handle prepares are admitted
    // (a handle prepare needs BOTH its prepare and its probe budget).
    const answers: string[] = [];
    for (let i = 0; i < 19; i++) {
      const handle = i % 2 === 0 ? "maya_chen" : `nobody_${i}`;
      answers.push((await prepare(w, handleSelector({ recipientHandle: handle }), { rateLimiter: limiter })).outcome);
    }
    // Unchanged Slice B classification: the oracle exists...
    expect(answers).toEqual(Array.from({ length: 19 }, (_, i) => (i % 2 === 0 ? "payment_in_progress" : "recipient_not_found")));
    expect(reserveHandle).toHaveBeenCalledTimes(19);

    // ...but it is bounded: every further probe is refused identically for an existing and a missing handle,
    for (const handle of ["maya_chen", "nobody_x", "admin", "payer_one"]) {
      expect(await prepare(w, handleSelector({ recipientHandle: handle }), { rateLimiter: limiter }), handle).toEqual({ outcome: "rate_limited", retryAfterSeconds: 600 });
    }
    // and no recipient resolution / business work happens for them.
    expect(reserveHandle).toHaveBeenCalledTimes(19);
    expect(charges).toHaveLength(23);
    expect(charges.every((charge) => charge.subject === "app-user-1" && charge.buckets.includes("recipient_probe_short"))).toBe(true);

    // The recipient LOOKUP draws on the same probe budget — which the four denied prepares were still charged to — so it is closed too:
    // the oracle cannot be continued there.
    const { resolveHandleRecipient } = await import("@/lib/real/server/handle-recipient");
    expect(await resolveHandleRecipient({ handles: w.handles, rateLimiter: w.rateLimiter, handle: "maya_chen", currentAppUserId: "app-user-1" })).toEqual({ outcome: "rate_limited", retryAfterSeconds: 600 });
    // A different payer is unaffected.
    expect(await resolveHandleRecipient({ handles: w.handles, rateLimiter: w.rateLimiter, handle: "maya_chen", currentAppUserId: "app-user-2" })).toMatchObject({ outcome: "self" });
  });

  it("lookups and handle prepares spend ONE shared probe budget: 10 lookups + 10 handle prepares exhaust it", async () => {
    const w = await world();
    w.rateLimiter = freshRateLimiter(() => 1_900_000_000_000);
    const { resolveHandleRecipient } = await import("@/lib/real/server/handle-recipient");
    for (let i = 0; i < 10; i++) expect((await resolveHandleRecipient({ handles: w.handles, rateLimiter: w.rateLimiter, handle: "maya_chen", currentAppUserId: "app-user-1" })).outcome).toBe("ok");
    for (let i = 0; i < 10; i++) expect((await prepare(w, handleSelector({ recipientHandle: `nobody_${i}` }))).outcome).toBe("recipient_not_found");
    expect((await prepare(w, handleSelector({ recipientHandle: "maya_chen" }))).outcome).toBe("rate_limited");
    expect((await resolveHandleRecipient({ handles: w.handles, rateLimiter: w.rateLimiter, handle: "maya_chen", currentAppUserId: "app-user-1" })).outcome).toBe("rate_limited");
    // An ADDRESS prepare does not draw on the probe budget and is still admitted (10 of its 20 prepares are left).
    expect((await prepare(w, { kind: "address", value: ADDRESS_RECIPIENT })).outcome).toBe("ready");
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
    vi.doMock("@/lib/real/server/runtime", () => ({ getRealAccountRegistry: () => w.registry, getPaymentAttemptStore: () => w.payments, getAccountHandleStore: () => w.handles, getRateLimiter: () => w.rateLimiter }));
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

  it('{ recipientHandle: "maya_chen", amountBaseUnits } -> 200 ready; the handle is bound and the response names it as recipientIdentity only', async () => {
    const w = await world();
    const post = await load(w, cookieFor(1));
    const response = await post({ recipientHandle: "maya_chen", amountBaseUnits: "1000000" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["attempt", "authorizingCredentialId", "serverNowSeconds", "subOrganizationId"]);
    expect(body.attempt.recipient).toBe(MAYA_SAFE.toLowerCase());
    expect(body.attempt.recipientIdentity).toEqual({ handle: "maya_chen", displayName: "Maya Chen" });
    expect(JSON.stringify(body)).not.toMatch(/app-user-2|recipientAppUserId|recipientHandle|recipientDisplayName/);
    expect(await w.payments.findById(body.attempt.id)).toMatchObject({ recipientHandle: "maya_chen", recipientAppUserId: "app-user-2", recipientDisplayName: "Maya Chen" });
  });

  it("{ recipient, amountBaseUnits } still works and stores a NULL identity", async () => {
    const w = await world();
    const response = await (await load(w, cookieFor(1)))({ recipient: ADDRESS_RECIPIENT, amountBaseUnits: "1000000" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.attempt.recipientIdentity).toBeNull();
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

  it("Slice D: a client sending the public recipientIdentity back (or any name/account metadata) changes nothing — it is read data, never a mutation input", async () => {
    const w = await world();
    const post = await load(w, cookieFor(1));
    const forgedIdentity = { handle: "payer_one", displayName: "Forged", appUserId: "app-user-1", safeAddress: ADDRESS_RECIPIENT };

    // On a handle payment: the destination and the stored/returned identity are still the database's.
    const handleResponse = await post({ recipientHandle: "maya_chen", amountBaseUnits: "1000000", recipientIdentity: forgedIdentity, displayName: "Forged", handle: "payer_one", appUserId: "app-user-1" });
    expect(handleResponse.status).toBe(200);
    const handleBody = await handleResponse.json();
    expect(handleBody.attempt.recipient).toBe(MAYA_SAFE.toLowerCase());
    expect(handleBody.attempt.recipientIdentity).toEqual({ handle: "maya_chen", displayName: "Maya Chen" });
    expect(await w.payments.findById(handleBody.attempt.id)).toMatchObject({ recipient: MAYA_SAFE.toLowerCase(), recipientAppUserId: "app-user-2", recipientHandle: "maya_chen", recipientDisplayName: "Maya Chen" });
    expect(prepareMock.mock.calls.at(-1)![0]).toMatchObject({ recipient: MAYA_SAFE.toLowerCase() });
    await w.payments.transition({ id: handleBody.attempt.id, from: "awaiting_authorization", to: "cancelled" });

    // On an address payment: a forged identity never turns it into a handle payment.
    const addressResponse = await post({ recipient: ADDRESS_RECIPIENT, amountBaseUnits: "1000000", recipientIdentity: { handle: "maya_chen", displayName: "Maya Chen" } });
    expect(addressResponse.status).toBe(200);
    const addressBody = await addressResponse.json();
    expect(addressBody.attempt.recipient).toBe(ADDRESS_RECIPIENT);
    expect(addressBody.attempt.recipientIdentity).toBeNull();
    expect(await w.payments.findById(addressBody.attempt.id)).toMatchObject({ recipient: ADDRESS_RECIPIENT, recipientAppUserId: null, recipientHandle: null, recipientDisplayName: null });
    expect(prepareMock.mock.calls.at(-1)![0]).toMatchObject({ recipient: ADDRESS_RECIPIENT });
  });

  it("Slice E: a rate-limited prepare is 429 { error, code: 'rate_limited' } with Retry-After — for an address and a handle — and creates nothing", async () => {
    const w = await world();
    w.rateLimiter = denyingRateLimiter(345);
    const post = await load(w, cookieFor(1));
    for (const body of [{ recipient: ADDRESS_RECIPIENT, amountBaseUnits: "1000000" }, { recipientHandle: "maya_chen", amountBaseUnits: "1000000" }, { recipientHandle: "nobody_here", amountBaseUnits: "1000000" }]) {
      const response = await post(body);
      expect(response.status, JSON.stringify(body)).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("345");
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ error: "You're going a bit fast. Try again later.", code: "rate_limited" });
      expect(text).not.toMatch(/bucket|hits|subject|pay_prepare|recipient_probe|app-user|maya|remaining|reset/i);
    }
    expect(prepareMock).not.toHaveBeenCalled();
    expect(await w.payments.findRecentByAppUserId({ appUserId: "app-user-1", limit: 10 })).toEqual([]);
  });

  it("Slice E: the payment QUOTA's 429 is unchanged — its own message, no `code`, no Retry-After", async () => {
    const w = await world();
    vi.spyOn(w.payments, "reserve").mockResolvedValueOnce({ ok: false, reason: "quota_exceeded" });
    const response = await (await load(w, cookieFor(1)))({ recipient: ADDRESS_RECIPIENT, amountBaseUnits: "1000000" });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(await response.json()).toEqual({ error: "You've reached the payment limit for now. Try again later." });
  });

  it("Slice E: malformed and unauthenticated requests are never charged; a limiter failure is the generic 500 with no detail and nothing created", async () => {
    const w = await world();
    const recording = recordingRateLimiter();
    w.rateLimiter = recording.limiter;
    const post = await load(w, cookieFor(1));
    expect((await post({ amountBaseUnits: "1000000" })).status).toBe(400);
    expect((await post({ recipientHandle: "@maya_chen", amountBaseUnits: "1000000" })).status).toBe(400);
    expect((await post({ recipientHandle: "maya_chen", amountBaseUnits: "0" })).status).toBe(400);
    expect((await (await load(w, undefined))({ recipientHandle: "maya_chen", amountBaseUnits: "1000000" })).status).toBe(401);
    expect(recording.charges).toEqual([]);

    w.rateLimiter = failingRateLimiter();
    const response = await (await load(w, cookieFor(1)))({ recipientHandle: "maya_chen", amountBaseUnits: "1000000" });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "Something went wrong. Please try again." });
    expect(text).not.toMatch(/real_rate_limits|relation|bucket|recipient_probe|app-user|maya/i);
    expect(prepareMock).not.toHaveBeenCalled();
    expect(await w.payments.findRecentByAppUserId({ appUserId: "app-user-1", limit: 10 })).toEqual([]);
  });

  it("an unauthenticated request is 401 even with an invalid selector", async () => {
    const w = await world();
    const post = await load(w, undefined);
    expect((await post({ amountBaseUnits: "1000000" })).status).toBe(401);
    expect((await post({ recipientHandle: "@x", amountBaseUnits: "1000000" })).status).toBe(401);
  });
});
