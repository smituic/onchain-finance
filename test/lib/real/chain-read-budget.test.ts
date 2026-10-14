import { readFileSync } from "node:fs";
import { createPublicClient, custom, encodeAbiParameters } from "viem";
import { baseSepolia } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { CHAIN_READ_POLICIES, CHAIN_READ_RATE_LIMITED_MESSAGE, consumeChainReadBudget } from "@/lib/real/server/chain-read-budget";
import { GENERIC_SERVER_ERROR_MESSAGE } from "@/lib/real/server/http";
import { REAL_CASH_TOKEN } from "@/lib/real/constants";
import { createFakeEntryPoint } from "./fixtures/entry-point-fake";
import { realBudget, scriptedBudget } from "./fixtures/chain-read-budget";

/**
 * Milestone 3 / Slice 3A-1 Stage 2B: the per-account chain-read budget on
 * GET account/balance and GET payments/[id]/status. Everything is offline:
 * fake limiters, a fake RPC, a mocked bundler. No Neon, no provider.
 */

const fetchUserOperationReceiptMock = vi.fn();
vi.mock("@/lib/real/server/pimlico", () => ({
  prepareCashTransferUserOperation: vi.fn(),
  sendPreparedUserOperation: vi.fn(),
  fetchUserOperationReceipt: (...args: unknown[]) => fetchUserOperationReceiptMock(...(args as [never])),
}));

const { resolvePaymentStatus } = await import("@/lib/real/server/payments");
const { resolveAuthenticatedCashBalance } = await import("@/lib/real/server/balance");
const { createInMemoryRealAccountRegistry } = await import("@/lib/real/server/registry");
const { createInMemoryPaymentAttemptStore } = await import("@/lib/real/server/payment-attempts");
const { REAL_SESSION_COOKIE_NAME, createSessionPayload, serializeSession } = await import("@/lib/real/server/session");

const SECRET = "4be1c0d27a9f3e8d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170605";
const OWNER = "0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF";
const SAFE = "0xd9a4c22fb34dc74317edc8006140d66c8fa03266";
const OWNER_2 = "0x2222222222222222222222222222222222222201";
const SAFE_2 = "0x2222222222222222222222222222222222222202";
const HASH = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const TX = "0x5555555555555555555555555555555555555555555555555555555555555555";
const VALID_UNTIL = 1_900_000_600;
const NONCE = (BigInt("0x1a0d5d70cd9") << BigInt(64)).toString();
const WINDOW = { nonce: NONCE, validUntil: VALID_UNTIL, prepareBlockNumber: "47000000" };
const PAST_VALIDITY_MS = (VALID_UNTIL + 3_000) * 1000;
const SHORT = 600;
const DAY = 86_400;

const cookieFor = (appUserId: string, credentialId: string) => serializeSession(createSessionPayload({ appUserId, credentialId, sessionEpoch: 0 }), SECRET);

async function seedRegistry() {
  const registry = createInMemoryRealAccountRegistry();
  for (const n of [1, 2]) {
    await registry.createAccountWithPasskey({
      account: { appUserId: `app-user-${n}`, subOrganizationId: `sub-org-${n}`, turnkeyUserId: `turnkey-user-${n}`, walletId: `wallet-${n}`, walletAccountId: `wallet-account-${n}`, ownerAddress: n === 1 ? OWNER : OWNER_2, safeAddress: n === 1 ? SAFE : SAFE_2, accountConfigVersion: 1 },
      passkey: { credentialId: `credential-${n}`, appUserId: `app-user-${n}`, credentialPublicKey: `cose-${n}`, userHandle: `handle-${n}`, counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false },
    });
  }
  return registry;
}

type AttemptState = "prepared" | "awaiting_authorization" | "signed" | "submitting" | "submitted" | "unknown" | "confirmed" | "failed" | "cancelled";

/** An attempt owned by `owner`, walked to `state` through the store's own legal transitions. */
async function seedAttempt(
  registry: Awaited<ReturnType<typeof seedRegistry>>,
  options: { state?: AttemptState; window?: Partial<typeof WINDOW> | null; owner?: 1 | 2; paymentStore?: ReturnType<typeof createInMemoryPaymentAttemptStore> } = {},
) {
  const owner = options.owner ?? 1;
  const paymentStore = options.paymentStore ?? createInMemoryPaymentAttemptStore();
  const reserved = await paymentStore.reserve({
    appUserId: `app-user-${owner}`,
    safeAddress: owner === 1 ? SAFE : SAFE_2,
    recipient: "0x4444444444444444444444444444444444444444",
    amountBaseUnits: "1000000",
    chainId: 84532,
    tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    authorizingCredentialId: `credential-${owner}`,
  });
  if (!reserved.ok) throw new Error("reservation refused");
  const id = reserved.attempt.id;
  const target = options.state ?? "submitted";
  const window = options.window === undefined ? WINDOW : options.window;
  if (target !== "prepared") {
    await paymentStore.transition({ id, from: "prepared", to: "awaiting_authorization", patch: { expectedUserOperationHash: HASH, ...(window ?? {}) } as never });
  }
  if (target === "cancelled") await paymentStore.transition({ id, from: "awaiting_authorization", to: "cancelled" });
  if (!["prepared", "awaiting_authorization", "cancelled"].includes(target)) await paymentStore.transition({ id, from: "awaiting_authorization", to: "signed" });
  if (["submitting", "submitted", "unknown", "confirmed", "failed"].includes(target)) await paymentStore.transition({ id, from: "signed", to: "submitting" });
  if (["submitted", "unknown", "confirmed", "failed"].includes(target)) {
    await paymentStore.transition({ id, from: "submitting", to: target === "submitted" || target === "unknown" ? target : "submitted" });
  }
  if (target === "confirmed") await paymentStore.transition({ id, from: "submitted", to: "confirmed", patch: { transactionHash: TX, failureReason: null } });
  if (target === "failed") await paymentStore.transition({ id, from: "submitted", to: "failed", patch: { transactionHash: TX, failureReason: "This payment failed." } });
  return { id, paymentStore, owner };
}

function status(
  registry: Awaited<ReturnType<typeof seedRegistry>>,
  paymentStore: ReturnType<typeof createInMemoryPaymentAttemptStore>,
  attemptId: string,
  limiter: ReturnType<typeof scriptedBudget>["limiter"],
  extra: { cookieValue?: string | null; publicClient?: ReturnType<typeof createFakeEntryPoint>["reader"]; now?: () => number } = {},
) {
  return resolvePaymentStatus({
    cookieValue: "cookieValue" in extra ? extra.cookieValue : cookieFor("app-user-1", "credential-1"),
    sessionSecret: SECRET,
    registry,
    paymentStore,
    pimlicoApiKey: "pim_test_key",
    providerBudgetLimiter: limiter,
    publicClient: extra.publicClient ?? createFakeEntryPoint({}).reader,
    attemptId,
    now: extra.now,
  });
}

const ALLOW = { allowed: true } as const;
const deny = (retryAfterSeconds: number) => ({ allowed: false, retryAfterSeconds }) as const;

beforeEach(() => {
  fetchUserOperationReceiptMock.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  fetchUserOperationReceiptMock.mockReset();
  vi.unstubAllEnvs();
  vi.doUnmock("next/headers");
  vi.doUnmock("@/lib/real/server/runtime");
  vi.doUnmock("@/lib/real/chain/client");
});

// ---------------------------------------------------------------------------
describe("the shared chain-read policy", () => {
  it("is exactly the approved DEVELOPMENT values on exactly the two chain-read buckets, and immutable", () => {
    expect(CHAIN_READ_POLICIES).toEqual([
      { bucket: "chain_read_short", limit: 30, windowSeconds: 600 },
      { bucket: "chain_read_day", limit: 200, windowSeconds: 86_400 },
    ]);
    expect(Object.isFrozen(CHAIN_READ_POLICIES)).toBe(true);
    for (const policy of CHAIN_READ_POLICIES) expect(Object.isFrozen(policy)).toBe(true);
    expect(() => (CHAIN_READ_POLICIES as unknown as unknown[]).push({})).toThrow();
  });

  it("both resolvers charge the SAME policy object — neither takes a policy, limit, or bucket of its own", async () => {
    const registry = await seedRegistry();
    const attempt = await seedAttempt(registry, { state: "submitted" });
    fetchUserOperationReceiptMock.mockResolvedValue(null);

    const forBalance = scriptedBudget(ALLOW);
    await resolveAuthenticatedCashBalance({ cookieValue: cookieFor("app-user-1", "credential-1"), sessionSecret: SECRET, registry, publicClient: balanceClient().client, providerBudgetLimiter: forBalance.limiter });
    const forStatus = scriptedBudget(ALLOW);
    await status(registry, attempt.paymentStore, attempt.id, forStatus.limiter);

    expect(forBalance.calls).toHaveLength(1);
    expect(forStatus.calls).toHaveLength(1);
    expect(forBalance.calls[0]!.policies).toBe(CHAIN_READ_POLICIES);
    expect(forStatus.calls[0]!.policies).toBe(CHAIN_READ_POLICIES);
  });

  it("source guard: no consumer carries a number, window, or bucket name — the literals live only in chain-read-budget.ts", () => {
    for (const file of ["lib/real/server/balance.ts", "lib/real/server/payments.ts", "app/api/real/account/balance/route.ts", "app/api/real/payments/[id]/status/route.ts"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/chain_read/);
      expect(source, file).not.toMatch(/windowSeconds/);
      expect(source, file).not.toMatch(/\blimit:\s*\d/);
    }
    for (const file of ["lib/real/server/balance.ts", "lib/real/server/payments.ts"]) {
      expect(readFileSync(file, "utf8"), file).toMatch(/consumeChainReadBudget\(input\.providerBudgetLimiter/);
    }
    const policySource = readFileSync("lib/real/server/chain-read-budget.ts", "utf8");
    expect(policySource).toContain("chain_read_short");
    expect(policySource.match(/limit: \d+/g)).toHaveLength(2);
  });

  it("consumeChainReadBudget: an allow, and a denial with a validated delay, are the only answers it accepts", async () => {
    expect(await consumeChainReadBudget(scriptedBudget(ALLOW).limiter, "app-user-1")).toEqual({ allowed: true });
    expect(await consumeChainReadBudget(scriptedBudget(deny(42)).limiter, "app-user-1")).toEqual({ allowed: false, retryAfterSeconds: 42 });
    expect(await consumeChainReadBudget(scriptedBudget(deny(DAY)).limiter, "app-user-1")).toEqual({ allowed: false, retryAfterSeconds: DAY });
  });

  it("consumeChainReadBudget: a throw, a malformed answer, or impossible retry metadata is an error — never an allow", async () => {
    await expect(consumeChainReadBudget(scriptedBudget(new Error("connection terminated")).limiter, "u")).rejects.toThrow(/connection terminated/);
    for (const bad of [
      undefined,
      null,
      "allowed",
      7,
      {},
      { allowed: "true" },
      { allowed: 1 },
      { allowed: false },
      { allowed: false, retryAfterSeconds: 0 },
      { allowed: false, retryAfterSeconds: -5 },
      { allowed: false, retryAfterSeconds: Number.NaN },
      { allowed: false, retryAfterSeconds: Number.POSITIVE_INFINITY },
      { allowed: false, retryAfterSeconds: 1.5 },
      { allowed: false, retryAfterSeconds: "30" },
      { allowed: false, retryAfterSeconds: DAY + 1 },
      { allowed: false, retryAfterSeconds: Number.MAX_SAFE_INTEGER },
    ]) {
      await expect(consumeChainReadBudget(scriptedBudget(bad).limiter, "u"), JSON.stringify(bad)).rejects.toThrow(/unusable limiter answer/);
    }
  });

  it("the subject is the id it is given, charged once, on both buckets — and a different account's counter is untouched", async () => {
    let now = 1_000_000;
    const limiter = realBudget(() => now);
    for (let i = 0; i < 30; i++) expect(await consumeChainReadBudget(limiter, "app-user-A")).toEqual({ allowed: true });
    const denied = await consumeChainReadBudget(limiter, "app-user-A");
    expect(denied).toMatchObject({ allowed: false });
    expect(await consumeChainReadBudget(limiter, "app-user-B")).toEqual({ allowed: true });
    expect(await consumeChainReadBudget(limiter, "app-user-A")).toMatchObject({ allowed: false });
    now += SHORT * 1000 + 1;
    expect(await consumeChainReadBudget(limiter, "app-user-A")).toEqual({ allowed: true });
  });

  it("short-window, daily-window, and both-window denials carry the right delay", async () => {
    let now = 5_000_000;
    const limiter = realBudget(() => now);
    const charge = () => consumeChainReadBudget(limiter, "app-user-1");

    // Short window only: 30 allowed, the 31st denied until the 10-minute window ends.
    for (let i = 0; i < 30; i++) expect((await charge()).allowed).toBe(true);
    const shortDenied = await charge();
    expect(shortDenied).toEqual({ allowed: false, retryAfterSeconds: SHORT });

    // A denied request is still charged, so the day counter is already at 31. Walk fresh short
    // windows until the DAY bucket (200) is what refuses: the short bucket is then well inside its limit.
    let dayDenied: Awaited<ReturnType<typeof charge>> | null = null;
    for (let window = 0; window < 10 && !dayDenied; window++) {
      now += (SHORT + 1) * 1000;
      for (let i = 0; i < 30 && !dayDenied; i++) {
        const result = await charge();
        if (!result.allowed) dayDenied = result;
      }
    }
    expect(dayDenied).not.toBeNull();
    if (!dayDenied || dayDenied.allowed) throw new Error("expected a daily denial");
    expect(dayDenied.retryAfterSeconds).toBeGreaterThan(SHORT);
    expect(dayDenied.retryAfterSeconds).toBeLessThanOrEqual(DAY);

    // Both exceeded at once (the same short window now also past 30): the LONGEST wait wins — the day's.
    let both = await charge();
    for (let i = 0; i < 40 && both.allowed; i++) both = await charge();
    for (let i = 0; i < 30; i++) both = await charge();
    expect(both).toEqual({ allowed: false, retryAfterSeconds: dayDenied.retryAfterSeconds });
  });
});

// ---------------------------------------------------------------------------
function balanceClient(options: { fail?: boolean } = {}) {
  const calls: string[] = [];
  const client = createPublicClient({
    chain: baseSepolia,
    transport: custom({
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        calls.push(method);
        if (options.fail) throw new Error("rpc down https://rpc.example/?key=secret");
        if (method === "eth_chainId") return `0x${baseSepolia.id.toString(16)}`;
        if (method === "eth_call") {
          const data = ((params?.[0] ?? {}) as { data?: string }).data ?? "";
          if (data.startsWith("0x70a08231")) return encodeAbiParameters([{ type: "uint256" }], [BigInt(20_000_000)]);
          if (data.startsWith("0x313ce567")) return encodeAbiParameters([{ type: "uint8" }], [6]);
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    }),
  });
  return { client, calls, token: REAL_CASH_TOKEN.address };
}

describe("resolveAuthenticatedCashBalance + the chain-read budget", () => {
  const run = async (limiter: ReturnType<typeof scriptedBudget>["limiter"], options: { cookieValue?: string | undefined; fail?: boolean; registry?: Awaited<ReturnType<typeof seedRegistry>> } = {}) => {
    const registry = options.registry ?? (await seedRegistry());
    const rpc = balanceClient({ fail: options.fail });
    const outcome = resolveAuthenticatedCashBalance({
      cookieValue: "cookieValue" in options ? options.cookieValue : cookieFor("app-user-1", "credential-1"),
      sessionSecret: SECRET,
      registry,
      publicClient: rpc.client,
      providerBudgetLimiter: limiter,
    });
    return { outcome, rpc };
  };

  it("an authorized read is charged exactly once — the canonical app user, both buckets — BEFORE the provider read", async () => {
    const budget = scriptedBudget(ALLOW);
    const { outcome, rpc } = await run(budget.limiter);
    expect(await outcome).toMatchObject({ outcome: "ready", balance: { balanceBaseUnits: "20000000" } });
    expect(budget.calls).toHaveLength(1);
    expect(budget.calls[0]!.subject).toBe("app-user-1");
    expect(budget.calls[0]!.policies.map((policy) => [policy.bucket, policy.limit, policy.windowSeconds])).toEqual([
      ["chain_read_short", 30, 600],
      ["chain_read_day", 200, 86_400],
    ]);
    expect(rpc.calls.length).toBeGreaterThan(0);
  });

  it("charges the SESSION's account — a different signed-in user is a different subject", async () => {
    const budget = scriptedBudget(ALLOW);
    const { outcome } = await run(budget.limiter, { cookieValue: cookieFor("app-user-2", "credential-2") });
    expect(await outcome).toMatchObject({ outcome: "ready" });
    expect(budget.calls.map((call) => call.subject)).toEqual(["app-user-2"]);
  });

  it("not authenticated (no cookie, tampered, unknown account): no charge, no RPC", async () => {
    for (const cookieValue of [undefined, "garbage", `${cookieFor("app-user-1", "credential-1")}x`, cookieFor("app-user-9", "credential-9")]) {
      const budget = scriptedBudget(ALLOW);
      const { outcome, rpc } = await run(budget.limiter, { cookieValue });
      expect(await outcome).toEqual({ outcome: "unauthenticated" });
      expect(budget.calls).toHaveLength(0);
      expect(rpc.calls).toHaveLength(0);
    }
  });

  it("an account whose Safe address is unusable is account_not_ready — no charge, no RPC", async () => {
    const registry = await seedRegistry();
    const account = await registry.findAccountByAppUserId("app-user-1");
    const broken = { ...registry, findAccountByAppUserId: async () => ({ ...account!, safeAddress: "not-an-address" }) };
    const budget = scriptedBudget(ALLOW);
    const { outcome, rpc } = await run(budget.limiter, { registry: broken as never });
    expect(await outcome).toEqual({ outcome: "account_not_ready" });
    expect(budget.calls).toHaveLength(0);
    expect(rpc.calls).toHaveLength(0);
  });

  it("a denial: rate_limited with the validated delay — no RPC, no balance, never a zero", async () => {
    const budget = scriptedBudget(deny(42));
    const { outcome, rpc } = await run(budget.limiter);
    const result = await outcome;
    expect(result).toEqual({ outcome: "rate_limited", retryAfterSeconds: 42 });
    expect(JSON.stringify(result)).not.toMatch(/balance/i);
    expect(rpc.calls).toHaveLength(0);
    expect(budget.calls).toHaveLength(1);
  });

  it("an allowed read that then fails at the provider is still read_failed (502), with the fixed safe message", async () => {
    const { outcome } = await run(scriptedBudget(ALLOW).limiter, { fail: true });
    const result = await outcome;
    expect(result.outcome).toBe("read_failed");
    expect(JSON.stringify(result)).not.toMatch(/secret|rpc\.example/);
  });

  it("a limiter that throws, or answers nonsense, is an ERROR — not read_failed, not an allow, not a deferral — and no provider is called", async () => {
    for (const step of [new Error("password authentication failed for user neondb_owner"), undefined, { allowed: "yes" }, { allowed: false, retryAfterSeconds: -1 }]) {
      const { outcome, rpc } = await run(scriptedBudget(step).limiter);
      await expect(outcome).rejects.toThrow();
      expect(rpc.calls).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
describe("resolvePaymentStatus + the chain-read budget", () => {
  describe("database-only branches are FREE — no charge, no provider read, whatever the budget says", () => {
    const cases: Array<[string, { state: AttemptState; window?: Partial<typeof WINDOW> | null; now?: number }]> = [
      ["prepared (never authorized)", { state: "prepared" }],
      ["awaiting approval, still inside its validity window", { state: "awaiting_authorization", now: (VALID_UNTIL - 100) * 1000 }],
      ["signed, still inside its validity window", { state: "signed", now: (VALID_UNTIL - 100) * 1000 }],
      ["awaiting, past validity, but a legacy row with no window at all", { state: "awaiting_authorization", window: null, now: PAST_VALIDITY_MS }],
      ["awaiting, past validity, but the stored evidence is incomplete (no nonce / block)", { state: "awaiting_authorization", window: { validUntil: VALID_UNTIL }, now: PAST_VALIDITY_MS }],
      ["confirmed (terminal)", { state: "confirmed" }],
      ["failed (terminal)", { state: "failed" }],
      ["cancelled (terminal)", { state: "cancelled" }],
    ];
    for (const [name, options] of cases) {
      it(`${name}`, async () => {
        const registry = await seedRegistry();
        const attempt = await seedAttempt(registry, { state: options.state, window: options.window });
        const entryPoint = createFakeEntryPoint({});
        const budget = scriptedBudget(deny(30)); // an exhausted account must still be able to READ this
        const outcome = await status(registry, attempt.paymentStore, attempt.id, budget.limiter, { publicClient: entryPoint.reader, now: options.now ? () => options.now! : undefined });
        expect(outcome).toMatchObject({ outcome: "ok", reconciliationDeferred: false });
        expect(budget.calls).toHaveLength(0);
        expect(fetchUserOperationReceiptMock).not.toHaveBeenCalled();
        expect(entryPoint.calls).toHaveLength(0);
        expect((await attempt.paymentStore.findById(attempt.id))?.state).toBe(options.state);
      });
    }
  });

  describe("provider-bound branches are charged ONCE, immediately before the first provider call", () => {
    it("a submitted attempt with a bundler receipt: one charge, one Pimlico read, no EntryPoint read, confirmed", async () => {
      const registry = await seedRegistry();
      const attempt = await seedAttempt(registry, { state: "submitted" });
      fetchUserOperationReceiptMock.mockResolvedValue({ userOpHash: HASH, sender: SAFE, success: true, receipt: { transactionHash: TX, status: "success" } });
      const entryPoint = createFakeEntryPoint({});
      const budget = scriptedBudget(ALLOW);
      const order: string[] = [];
      const limiter = { consume: async (input: Parameters<typeof budget.limiter.consume>[0]) => (order.push("charge"), budget.limiter.consume(input)) };
      fetchUserOperationReceiptMock.mockImplementation(async () => {
        order.push("pimlico");
        return { userOpHash: HASH, sender: SAFE, success: true, receipt: { transactionHash: TX, status: "success" } };
      });

      const outcome = await status(registry, attempt.paymentStore, attempt.id, limiter);
      expect(outcome).toMatchObject({ outcome: "ok", reconciliationDeferred: false, attempt: { state: "confirmed", transactionHash: TX } });
      expect(order).toEqual(["charge", "pimlico"]);
      expect(budget.calls).toHaveLength(1);
      expect(budget.calls[0]!.subject).toBe("app-user-1");
      expect(budget.calls[0]!.policies).toBe(CHAIN_READ_POLICIES);
      expect(entryPoint.calls).toHaveLength(0);
    });

    for (const state of ["submitting", "submitted", "unknown"] as const) {
      it(`${state}: no receipt + EntryPoint fallback — still exactly ONE charge for the whole request`, async () => {
        const registry = await seedRegistry();
        const attempt = await seedAttempt(registry, { state });
        fetchUserOperationReceiptMock.mockResolvedValue(null);
        const entryPoint = createFakeEntryPoint({ latestSequence: BigInt(1), logs: [{ args: { userOpHash: HASH, sender: SAFE, success: true }, transactionHash: TX }] });
        const budget = scriptedBudget(ALLOW);

        const outcome = await status(registry, attempt.paymentStore, attempt.id, budget.limiter, { publicClient: entryPoint.reader });
        expect(outcome).toMatchObject({ outcome: "ok", reconciliationDeferred: false, attempt: { state: "confirmed", transactionHash: TX } });
        expect(fetchUserOperationReceiptMock).toHaveBeenCalledTimes(1);
        expect(entryPoint.calls.length).toBeGreaterThan(0); // the fallback really read the chain
        expect(budget.calls).toHaveLength(1);
      });
    }

    it("a Pimlico failure is not a budget event: charged once, the fallback runs, and the attempt is left as it was when nothing is proven", async () => {
      const registry = await seedRegistry();
      const attempt = await seedAttempt(registry, { state: "submitted" });
      fetchUserOperationReceiptMock.mockRejectedValue(new Error("bundler down"));
      const budget = scriptedBudget(ALLOW);
      const outcome = await status(registry, attempt.paymentStore, attempt.id, budget.limiter, { publicClient: createFakeEntryPoint({ latestSequence: BigInt(0) }).reader });
      expect(outcome).toMatchObject({ outcome: "ok", reconciliationDeferred: false, attempt: { state: "submitted" } });
      expect(budget.calls).toHaveLength(1);
    });

    for (const state of ["awaiting_authorization", "signed"] as const) {
      it(`${state} past validUntil with complete evidence: one charge, an EntryPoint read, no bundler call`, async () => {
        const registry = await seedRegistry();
        const attempt = await seedAttempt(registry, { state });
        const entryPoint = createFakeEntryPoint({
          latest: { number: BigInt(47_001_000), timestamp: BigInt(VALID_UNTIL + 3_000) },
          finalized: { number: BigInt(47_000_700), timestamp: BigInt(VALID_UNTIL + 1) },
          latestSequence: BigInt(0),
          finalizedSequence: BigInt(0),
        });
        const budget = scriptedBudget(ALLOW);

        const outcome = await status(registry, attempt.paymentStore, attempt.id, budget.limiter, { publicClient: entryPoint.reader, now: () => PAST_VALIDITY_MS });
        expect(outcome).toMatchObject({ outcome: "ok", reconciliationDeferred: false, attempt: { state: "failed" } });
        expect(budget.calls).toHaveLength(1);
        expect(entryPoint.calls.length).toBeGreaterThan(0);
        expect(fetchUserOperationReceiptMock).not.toHaveBeenCalled();
      });
    }
  });

  describe("denial returns the stored attempt untouched — and contacts no provider", () => {
    const denialCases: Array<[string, AttemptState, number | undefined]> = [
      ["submitted (would read Pimlico)", "submitted", undefined],
      ["unknown (would read Pimlico)", "unknown", undefined],
      ["submitting (would read Pimlico)", "submitting", undefined],
      ["expired awaiting (would read the EntryPoint)", "awaiting_authorization", PAST_VALIDITY_MS],
      ["expired signed (would read the EntryPoint)", "signed", PAST_VALIDITY_MS],
    ];
    for (const [name, state, now] of denialCases) {
      it(name, async () => {
        const registry = await seedRegistry();
        const attempt = await seedAttempt(registry, { state });
        const before = await attempt.paymentStore.findById(attempt.id);
        const entryPoint = createFakeEntryPoint({ latestSequence: BigInt(1), logs: [{ args: { userOpHash: HASH, sender: SAFE, success: true }, transactionHash: TX }] });
        const transition = vi.spyOn(attempt.paymentStore, "transition");
        const budget = scriptedBudget(deny(77));

        const outcome = await status(registry, attempt.paymentStore, attempt.id, budget.limiter, { publicClient: entryPoint.reader, now: now ? () => now : undefined });

        expect(outcome).toMatchObject({ outcome: "ok", reconciliationDeferred: true, retryAfterSeconds: 77, attempt: { id: attempt.id, state } });
        expect(fetchUserOperationReceiptMock).not.toHaveBeenCalled();
        expect(entryPoint.calls).toHaveLength(0);
        expect(transition).not.toHaveBeenCalled();
        expect(await attempt.paymentStore.findById(attempt.id)).toEqual(before);
        // Nothing is implied: not terminal, no failure reason, the account's one active slot is still held.
        if (outcome.outcome === "ok") {
          expect(outcome.attempt.failureReason).toBeNull();
          expect(outcome.attempt.transactionHash).toBeNull();
        }
        const next = await attempt.paymentStore.reserve({ appUserId: "app-user-1", safeAddress: SAFE, recipient: "0x4444444444444444444444444444444444444444", amountBaseUnits: "1", chainId: 84532, tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", authorizingCredentialId: "credential-1" });
        expect(next).toEqual({ ok: false, reason: "payment_in_progress" });
      });
    }

    it("the deferred answer keeps the existing attempt shape and the existing serverNowSeconds", async () => {
      const registry = await seedRegistry();
      const attempt = await seedAttempt(registry, { state: "submitted" });
      const normal = await status(registry, attempt.paymentStore, attempt.id, scriptedBudget(ALLOW).limiter, { now: () => 1_950_000_000_000 });
      fetchUserOperationReceiptMock.mockReset();
      const deferred = await status(registry, attempt.paymentStore, attempt.id, scriptedBudget(deny(9)).limiter, { now: () => 1_950_000_000_000 });
      if (normal.outcome !== "ok" || deferred.outcome !== "ok") throw new Error("expected ok outcomes");
      expect(Object.keys(deferred.attempt).sort()).toEqual(Object.keys(normal.attempt).sort());
      expect(deferred.attempt).toEqual(normal.attempt);
      expect(deferred.serverNowSeconds).toBe(1_950_000_000);
      expect(Object.keys(deferred.attempt)).not.toEqual(expect.arrayContaining(["reconciliationDeferred"]));
      expect(Object.keys(deferred.attempt)).not.toEqual(expect.arrayContaining(["retryAfterSeconds"]));
    });

    it("a terminal attempt stays readable for an account whose budget is genuinely exhausted (real limiter, nothing charged)", async () => {
      const limiter = realBudget(() => 9_000_000);
      for (let i = 0; i < 31; i++) await consumeChainReadBudget(limiter, "app-user-1"); // spent
      expect(await consumeChainReadBudget(limiter, "app-user-1")).toMatchObject({ allowed: false });

      const registry = await seedRegistry();
      const confirmed = await seedAttempt(registry, { state: "confirmed" });
      const outcome = await status(registry, confirmed.paymentStore, confirmed.id, limiter);
      expect(outcome).toMatchObject({ outcome: "ok", reconciliationDeferred: false, attempt: { state: "confirmed", transactionHash: TX } });

      // ... while a provider-bound one, on the same exhausted account, is deferred.
      const submitted = await seedAttempt(registry, { state: "submitted" });
      const deferred = await status(registry, submitted.paymentStore, submitted.id, limiter);
      expect(deferred).toMatchObject({ outcome: "ok", reconciliationDeferred: true });
      expect(fetchUserOperationReceiptMock).not.toHaveBeenCalled();
    });
  });

  describe("authentication and ownership come BEFORE any charge", () => {
    it("unauthenticated / invalid session / unknown account: no charge, no provider", async () => {
      const registry = await seedRegistry();
      const attempt = await seedAttempt(registry, { state: "submitted" });
      for (const cookieValue of [undefined, null, "garbage", `${cookieFor("app-user-1", "credential-1")}x`, cookieFor("app-user-9", "credential-9")]) {
        const budget = scriptedBudget(ALLOW);
        expect(await status(registry, attempt.paymentStore, attempt.id, budget.limiter, { cookieValue })).toEqual({ outcome: "unauthenticated" });
        expect(budget.calls).toHaveLength(0);
      }
      expect(fetchUserOperationReceiptMock).not.toHaveBeenCalled();
    });

    it("another account's attempt, a missing attempt, and a malformed id are all not_found with no charge", async () => {
      const registry = await seedRegistry();
      const mine = await seedAttempt(registry, { state: "submitted", owner: 1 });
      const theirs = await seedAttempt(registry, { state: "submitted", owner: 2 });
      for (const [attemptId, store] of [
        [theirs.id, theirs.paymentStore],
        ["00000000-0000-4000-8000-000000000000", mine.paymentStore],
        ["not-a-uuid", mine.paymentStore],
        ["", mine.paymentStore],
      ] as const) {
        const budget = scriptedBudget(ALLOW);
        expect(await status(registry, store, attemptId, budget.limiter)).toEqual({ outcome: "not_found" });
        expect(budget.calls).toHaveLength(0);
      }
      expect(fetchUserOperationReceiptMock).not.toHaveBeenCalled();
    });
  });

  describe("a limiter that fails closed", () => {
    it("a throw, a malformed answer, or impossible retry metadata rejects — no provider call, no transition, no deferral pretended", async () => {
      for (const step of [new Error("Neon unavailable: connection terminated"), undefined, null, { allowed: "true" }, { allowed: false }, { allowed: false, retryAfterSeconds: 0 }, { allowed: false, retryAfterSeconds: Number.NaN }, { allowed: false, retryAfterSeconds: DAY * 10 }]) {
        for (const state of ["submitted", "awaiting_authorization"] as const) {
          const registry = await seedRegistry();
          const attempt = await seedAttempt(registry, { state });
          const entryPoint = createFakeEntryPoint({});
          const transition = vi.spyOn(attempt.paymentStore, "transition");
          await expect(status(registry, attempt.paymentStore, attempt.id, scriptedBudget(step).limiter, { publicClient: entryPoint.reader, now: state === "awaiting_authorization" ? () => PAST_VALIDITY_MS : undefined })).rejects.toThrow();
          expect(fetchUserOperationReceiptMock).not.toHaveBeenCalled();
          expect(entryPoint.calls).toHaveLength(0);
          expect(transition).not.toHaveBeenCalled();
          expect((await attempt.paymentStore.findById(attempt.id))?.state).toBe(state);
        }
      }
    });
  });

  describe("concurrency", () => {
    it("31 simultaneous provider-bound requests against the real limiter: exactly 30 reach the provider, 1 is deferred, each charged once", async () => {
      const registry = await seedRegistry();
      const attempt = await seedAttempt(registry, { state: "submitted" });
      fetchUserOperationReceiptMock.mockResolvedValue(null);
      const limiter = realBudget();
      let consumes = 0;
      const counting = { consume: async (input: Parameters<typeof limiter.consume>[0]) => (consumes++, limiter.consume(input)) };

      const outcomes = await Promise.all(Array.from({ length: 31 }, () => status(registry, attempt.paymentStore, attempt.id, counting, { publicClient: createFakeEntryPoint({}).reader })));

      expect(consumes).toBe(31);
      expect(fetchUserOperationReceiptMock).toHaveBeenCalledTimes(30);
      expect(outcomes.filter((outcome) => outcome.outcome === "ok" && outcome.reconciliationDeferred)).toHaveLength(1);
      expect((await attempt.paymentStore.findById(attempt.id))?.state).toBe("submitted");
    });
  });
});

// ---------------------------------------------------------------------------
describe("closeout: the zero-provider boundaries the Stage 2B audit named", () => {
  /** The same store, but every read of the attempt shows `patch` — how a malformed stored row is simulated without touching the store. */
  function withStoredRow(store: ReturnType<typeof createInMemoryPaymentAttemptStore>, patch: Record<string, unknown>) {
    const wrapped = {
      ...store,
      findById: async (id: string) => {
        const row = await store.findById(id);
        return row ? { ...row, ...patch } : row;
      },
    };
    return { wrapped: wrapped as unknown as typeof store, transition: vi.spyOn(wrapped, "transition") };
  }

  it("1. submitting / submitted / unknown with NO stored UserOperation hash stay database-only and free", async () => {
    for (const state of ["submitting", "submitted", "unknown"] as const) {
      const registry = await seedRegistry();
      const attempt = await seedAttempt(registry, { state });
      const { wrapped, transition } = withStoredRow(attempt.paymentStore, { expectedUserOperationHash: null });
      const entryPoint = createFakeEntryPoint({});
      const budget = scriptedBudget(deny(30)); // an exhausted account must still read this

      const outcome = await status(registry, wrapped, attempt.id, budget.limiter, { publicClient: entryPoint.reader, now: () => PAST_VALIDITY_MS });

      expect(outcome, state).toMatchObject({ outcome: "ok", reconciliationDeferred: false, attempt: { id: attempt.id, state } });
      expect(budget.calls, state).toHaveLength(0);
      expect(fetchUserOperationReceiptMock).not.toHaveBeenCalled();
      expect(entryPoint.calls).toHaveLength(0);
      expect(transition).not.toHaveBeenCalled();
      expect((await attempt.paymentStore.findById(attempt.id))?.state).toBe(state);
    }
  });

  it("2. an expired pre-dispatch attempt whose stored Safe address is unusable is free — nothing can be proven, so nothing is asked", async () => {
    for (const state of ["awaiting_authorization", "signed"] as const) {
      const registry = await seedRegistry();
      const attempt = await seedAttempt(registry, { state });
      const { wrapped, transition } = withStoredRow(attempt.paymentStore, { safeAddress: "not-an-address" });
      const entryPoint = createFakeEntryPoint({});
      const budget = scriptedBudget(deny(30));

      const outcome = await status(registry, wrapped, attempt.id, budget.limiter, { publicClient: entryPoint.reader, now: () => PAST_VALIDITY_MS });

      expect(outcome, state).toMatchObject({ outcome: "ok", reconciliationDeferred: false, attempt: { id: attempt.id, state } });
      expect(budget.calls, state).toHaveLength(0);
      expect(entryPoint.calls).toHaveLength(0);
      expect(fetchUserOperationReceiptMock).not.toHaveBeenCalled();
      expect(transition).not.toHaveBeenCalled();
    }
  });

  it("2b. (pinned) a DISPATCHED attempt with an unusable Safe still makes a bundler read, so it is charged exactly once and makes no EntryPoint read", async () => {
    const registry = await seedRegistry();
    const attempt = await seedAttempt(registry, { state: "submitted" });
    const { wrapped } = withStoredRow(attempt.paymentStore, { safeAddress: "not-an-address" });
    const entryPoint = createFakeEntryPoint({});
    const budget = scriptedBudget(ALLOW);
    fetchUserOperationReceiptMock.mockResolvedValue(null);

    const outcome = await status(registry, wrapped, attempt.id, budget.limiter, { publicClient: entryPoint.reader });

    expect(outcome).toMatchObject({ outcome: "ok", reconciliationDeferred: false, attempt: { state: "submitted" } });
    expect(budget.calls).toHaveLength(1);
    expect(fetchUserOperationReceiptMock).toHaveBeenCalledTimes(1);
    expect(entryPoint.calls).toHaveLength(0);
  });

  it("3. now == validUntil keeps the existing no-provider behavior; one second later the read is provider-bound and charged", async () => {
    const registry = await seedRegistry();
    const attempt = await seedAttempt(registry, { state: "awaiting_authorization" });
    const entryPoint = createFakeEntryPoint({});
    const budget = scriptedBudget(deny(77));

    const onTheBoundary = await status(registry, attempt.paymentStore, attempt.id, budget.limiter, { publicClient: entryPoint.reader, now: () => VALID_UNTIL * 1000 });
    expect(onTheBoundary).toMatchObject({ outcome: "ok", reconciliationDeferred: false, attempt: { state: "awaiting_authorization" } });
    expect(budget.calls).toHaveLength(0);
    expect(entryPoint.calls).toHaveLength(0);

    const oneSecondLater = await status(registry, attempt.paymentStore, attempt.id, budget.limiter, { publicClient: entryPoint.reader, now: () => (VALID_UNTIL + 1) * 1000 });
    expect(oneSecondLater).toMatchObject({ outcome: "ok", reconciliationDeferred: true, retryAfterSeconds: 77 });
    expect(budget.calls).toHaveLength(1);
    expect(entryPoint.calls).toHaveLength(0); // denied: still no provider read
  });

  it("4. the charge PRECEDES the EntryPoint read — and is made exactly once for the whole request", async () => {
    for (const state of ["awaiting_authorization", "signed"] as const) {
      const registry = await seedRegistry();
      const attempt = await seedAttempt(registry, { state });
      const order: string[] = [];
      const fake = createFakeEntryPoint({
        latest: { number: BigInt(47_001_000), timestamp: BigInt(VALID_UNTIL + 3_000) },
        finalized: { number: BigInt(47_000_700), timestamp: BigInt(VALID_UNTIL + 1) },
        latestSequence: BigInt(0),
        finalizedSequence: BigInt(0),
      });
      // Every method the EntryPoint reader exposes records itself the moment it is called.
      const reader = new Proxy(fake.reader, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? (...args: unknown[]) => (order.push(`entrypoint:${String(property)}`), value.apply(target, args)) : value;
        },
      });
      const budget = scriptedBudget(ALLOW);
      const limiter = { consume: async (input: Parameters<typeof budget.limiter.consume>[0]) => (order.push("charge"), budget.limiter.consume(input)) };

      const outcome = await status(registry, attempt.paymentStore, attempt.id, limiter, { publicClient: reader, now: () => PAST_VALIDITY_MS });

      expect(outcome, state).toMatchObject({ outcome: "ok", attempt: { state: "failed" } });
      expect(order[0], state).toBe("charge");
      expect(order.filter((entry) => entry === "charge")).toHaveLength(1);
      expect(order.some((entry) => entry.startsWith("entrypoint:"))).toBe(true);
      expect(order.indexOf("charge")).toBeLessThan(order.findIndex((entry) => entry.startsWith("entrypoint:")));
    }
  });
});

// ---------------------------------------------------------------------------
describe("the routes", () => {
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

  async function load(options: {
    cookie?: string;
    registry: Awaited<ReturnType<typeof seedRegistry>>;
    paymentStore?: ReturnType<typeof createInMemoryPaymentAttemptStore>;
    limiter: ReturnType<typeof scriptedBudget>["limiter"];
    rpc?: ReturnType<typeof balanceClient>;
  }) {
    vi.resetModules();
    stubEnv();
    vi.doMock("next/headers", () => ({
      cookies: async () => ({ get: (name: string) => (name === REAL_SESSION_COOKIE_NAME && options.cookie !== undefined ? { name, value: options.cookie } : undefined), set: () => {}, delete: () => {} }),
    }));
    vi.doMock("@/lib/real/server/runtime", () => ({
      getRealAccountRegistry: () => options.registry,
      getPaymentAttemptStore: () => options.paymentStore,
      getProviderBudgetLimiter: () => options.limiter,
    }));
    vi.doMock("@/lib/real/chain/client", () => ({ createRealPublicClient: () => options.rpc?.client ?? createFakeEntryPoint({}).reader }));
    const balance = await import("@/app/api/real/account/balance/route");
    const statusRoute = await import("@/app/api/real/payments/[id]/status/route");
    return {
      balance: () => balance.GET(),
      status: (id: string) => statusRoute.GET(new NextRequest(`http://localhost:3000/api/real/payments/${id}/status`), { params: Promise.resolve({ id }) } as never),
    };
  }

  const GOOD_COOKIE = cookieFor("app-user-1", "credential-1");

  it("balance: a denial is 429 + code rate_limited + a whole-second Retry-After + a friendly message — and no RPC, no balance", async () => {
    const registry = await seedRegistry();
    const rpc = balanceClient();
    const routes = await load({ cookie: GOOD_COOKIE, registry, limiter: scriptedBudget(deny(42)).limiter, rpc });
    const response = await routes.balance();
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(await response.json()).toEqual({ error: CHAIN_READ_RATE_LIMITED_MESSAGE, code: "rate_limited" });
    expect(rpc.calls).toHaveLength(0);
  });

  it("balance: the message is plain language — no bucket, count, or provider vocabulary", () => {
    expect(CHAIN_READ_RATE_LIMITED_MESSAGE).not.toMatch(/chain|rpc|bucket|budget|limit|quota|provider|user ?operation|pimlico/i);
  });

  it("balance: allowed -> 200 with the balance and no Retry-After; existing 401 / 409 / 502 are unchanged", async () => {
    const registry = await seedRegistry();
    const ok = await (await load({ cookie: GOOD_COOKIE, registry, limiter: scriptedBudget(ALLOW).limiter, rpc: balanceClient() })).balance();
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Retry-After")).toBeNull();
    expect(await ok.json()).toMatchObject({ balanceBaseUnits: "20000000" });

    const budget = scriptedBudget(ALLOW);
    const unauthenticated = await (await load({ registry, limiter: budget.limiter, rpc: balanceClient() })).balance();
    expect(unauthenticated.status).toBe(401);
    expect(budget.calls).toHaveLength(0);

    const failed = await (await load({ cookie: GOOD_COOKIE, registry, limiter: scriptedBudget(ALLOW).limiter, rpc: balanceClient({ fail: true }) })).balance();
    expect(failed.status).toBe(502);

    const account = await registry.findAccountByAppUserId("app-user-1");
    const broken = { ...registry, findAccountByAppUserId: async () => ({ ...account!, safeAddress: "nope" }) } as never;
    const notReady = await (await load({ cookie: GOOD_COOKIE, registry: broken, limiter: scriptedBudget(ALLOW).limiter, rpc: balanceClient() })).balance();
    expect(notReady.status).toBe(409);
  });

  it("balance: a limiter failure is the generic 500 — no internals, no RPC", async () => {
    const registry = await seedRegistry();
    for (const step of [new Error("connection to neon-host.internal:5432 refused; password=hunter2"), undefined, { allowed: "maybe" }, { allowed: false, retryAfterSeconds: Number.NaN }]) {
      const rpc = balanceClient();
      const response = await (await load({ cookie: GOOD_COOKIE, registry, limiter: scriptedBudget(step).limiter, rpc })).balance();
      expect(response.status).toBe(500);
      expect(response.headers.get("Retry-After")).toBeNull();
      const body = await response.json();
      expect(body).toEqual({ error: GENERIC_SERVER_ERROR_MESSAGE });
      expect(JSON.stringify(body)).not.toMatch(/neon|hunter2|password|5432/);
      expect(rpc.calls).toHaveLength(0);
    }
  });

  it("status: an ordinary answer carries reconciliationDeferred:false and the unchanged attempt + serverNowSeconds", async () => {
    const registry = await seedRegistry();
    const attempt = await seedAttempt(registry, { state: "confirmed" });
    const response = await (await load({ cookie: GOOD_COOKIE, registry, paymentStore: attempt.paymentStore, limiter: scriptedBudget(ALLOW).limiter })).status(attempt.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("Retry-After")).toBeNull();
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["attempt", "reconciliationDeferred", "serverNowSeconds"]);
    expect(body).toMatchObject({ reconciliationDeferred: false, attempt: { id: attempt.id, state: "confirmed" } });
    expect(typeof body.serverNowSeconds).toBe("number");
  });

  it("status: a denial is 200 with the stored attempt, reconciliationDeferred:true, retryAfterSeconds, and a Retry-After header", async () => {
    const registry = await seedRegistry();
    const attempt = await seedAttempt(registry, { state: "submitted" });
    const response = await (await load({ cookie: GOOD_COOKIE, registry, paymentStore: attempt.paymentStore, limiter: scriptedBudget(deny(120)).limiter })).status(attempt.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("Retry-After")).toBe("120");
    const body = await response.json();
    expect(body).toMatchObject({ reconciliationDeferred: true, retryAfterSeconds: 120, attempt: { id: attempt.id, state: "submitted" } });
    expect(Object.keys(body).sort()).toEqual(["attempt", "reconciliationDeferred", "retryAfterSeconds", "serverNowSeconds"]);
    expect(Object.keys(body.attempt)).not.toContain("reconciliationDeferred");
    expect(fetchUserOperationReceiptMock).not.toHaveBeenCalled();
  });

  it("status: 401 / 404 are unchanged and uncharged; a limiter failure is the generic 500 with no provider call", async () => {
    const registry = await seedRegistry();
    const mine = await seedAttempt(registry, { state: "submitted", owner: 1 });
    const theirs = await seedAttempt(registry, { state: "submitted", owner: 2, paymentStore: mine.paymentStore });

    const budget = scriptedBudget(ALLOW);
    const unauth = await (await load({ registry, paymentStore: mine.paymentStore, limiter: budget.limiter })).status(mine.id);
    expect(unauth.status).toBe(401);
    const foreign = await (await load({ cookie: GOOD_COOKIE, registry, paymentStore: mine.paymentStore, limiter: budget.limiter })).status(theirs.id);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: "Payment not found." });
    expect(budget.calls).toHaveLength(0);

    for (const step of [new Error("Neon unavailable"), undefined, { allowed: false, retryAfterSeconds: 0 }]) {
      const response = await (await load({ cookie: GOOD_COOKIE, registry, paymentStore: mine.paymentStore, limiter: scriptedBudget(step).limiter })).status(mine.id);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: GENERIC_SERVER_ERROR_MESSAGE });
    }
    expect(fetchUserOperationReceiptMock).not.toHaveBeenCalled();
  });
});
