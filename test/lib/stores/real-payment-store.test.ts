import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CANCEL_REQUEST_DEADLINE_MS,
  createRealPaymentStore,
  EXPIRY_FOLLOW_UP_MS,
  followUpDelayMs,
  interpretStatusResult,
  MANUAL_CHECK_COOLDOWN_MS,
  MAX_AUTOMATIC_FOLLOW_UPS,
  MAX_FOLLOW_UP_INTERVAL_MS,
  parseSubmitRetryAfter,
  PAYMENT_NOT_ACCESSIBLE_MESSAGE,
  PREPARE_REQUEST_DEADLINE_MS,
  SIGNED_OUT_PAYMENT_MESSAGE,
  STATUS_FALLBACK_DEADLINE_MS,
  STATUS_REQUEST_DEADLINE_MS,
  SUBMIT_REQUEST_DEADLINE_MS,
  SUBMIT_UNCONFIRMED_MESSAGE,
} from "@/lib/stores/real-payment-store";
import { useRealAccountStore } from "@/lib/stores/real-account-store";
import { signPreparedPayment } from "@/lib/real/payments/client-sign";
import type { WirePreparedFields } from "@/lib/real/payments/prepared-operation";

// Slice C's prepare tests run confirmAndSend past /prepare; the passkey step is
// stubbed as "the user dismissed the prompt", which leaves the attempt awaiting.
vi.mock("@/lib/real/payments/client-sign", () => ({
  signPreparedPayment: vi.fn(async () => {
    throw Object.assign(new Error("dismissed"), { name: "NotAllowedError" });
  }),
}));

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const PREPARED_FIELDS: WirePreparedFields = {
  sender: "0x1111111111111111111111111111111111111111",
  nonce: "0",
  factory: null,
  factoryData: null,
  callData: "0x",
  callGasLimit: "100000",
  verificationGasLimit: "100000",
  preVerificationGas: "50000",
  maxFeePerGas: "1",
  maxPriorityFeePerGas: "1",
  paymaster: null,
  paymasterData: null,
  paymasterVerificationGasLimit: null,
  paymasterPostOpGasLimit: null,
  validUntil: 1_900_000_600,
};

/**
 * L-2 D-12: an honest prepare 200 names a server-issued payment id
 * (payment_attempts.id is a Postgres UUID; the store requires isValidUuid). The
 * successful-prepare fixtures use these instead of "attempt-1"-style
 * placeholders; fixtures for other routes keep their own ids.
 */
const PREPARED_ID = "5f0c3b2a-7d1e-4c8a-9b6f-2e4d1a3c5b7e";
const PREPARED_ID_2 = "a3e9c1d7-4b2f-4e8a-8c6d-0f1b2a3c4d5e";
/**
 * L-2 D-13: an honest /latest answer names a server-issued payment id too (the
 * store requires isValidUuid there as well). ATTEMPT_ID is baseAttempt()'s id
 * and ATTEMPT_ID_2 the distinct "second payment" id, replacing the "attempt-1" /
 * "attempt-2" placeholders with their dependent URLs, submit bodies and id
 * assertions; deliberately malformed and foreign ids stay as they were.
 */
const ATTEMPT_ID = "1b4e28ba-2fa1-4d2a-9b3c-5e6f7a8b9c0d";
const ATTEMPT_ID_2 = "2c5f39cb-3ab2-4e3b-8c4d-6f7a8b9c0d1e";
/** L-2 D-13: account B's own payment in the account-switch tests (was "attempt-b"). */
const ACCOUNT_B_ATTEMPT_ID = "3d6a4adc-4bc3-4f4c-9d5e-7a8b9c0d1e2f";
/** L-2 D-13: the D-1 stale-read, epoch and 409 tests' payments (were "attempt-old" / "-new" / "-same" / "-active"). */
const OLD_ATTEMPT_ID = "4e7b5bed-5cd4-4a5d-8e6f-8b9c0d1e2f3a";
const NEW_ATTEMPT_ID = "5f8c6cfe-6de5-4b6e-9f7a-9c0d1e2f3a4b";
const SAME_ATTEMPT_ID = "6a9d7d0f-7ef6-4c7f-a08b-0d1e2f3a4b5c";
const ACTIVE_ATTEMPT_ID = "7b0e8e1a-8f07-4d80-b19c-1e2f3a4b5c6d";

/** L-2 D-13: one distinct server-issued id per state for the D-1 / D-3a / D-13 state tables (distinct payments stay distinct). */
const STATE_ATTEMPT_IDS: Readonly<Record<string, string>> = {
  prepared: "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d",
  awaiting_authorization: "1b2c3d4e-5f6a-4b7c-9d8e-9f0a1b2c3d4e",
  signed: "2c3d4e5f-6a7b-4c8d-ae9f-0a1b2c3d4e5f",
  submitting: "3d4e5f6a-7b8c-4d9e-bf0a-1b2c3d4e5f6a",
  submitted: "4e5f6a7b-8c9d-4eaf-8a1b-2c3d4e5f6a7b",
  unknown: "5f6a7b8c-9d0e-4fa0-9b2c-3d4e5f6a7b8c",
  confirmed: "6a7b8c9d-0e1f-4ab1-ac3d-4e5f6a7b8c9d",
  failed: "7b8c9d0e-1f2a-4bc2-bd4e-5f6a7b8c9d0e",
  cancelled: "8c9d0e1f-2a3b-4cd3-8e5f-6a7b8c9d0e1f",
};
function stateAttemptId(state: string): string {
  const id = STATE_ATTEMPT_IDS[state];
  if (!id) throw new Error(`no fixture id for state ${state}`);
  return id;
}

const SIGNING_CONTEXT = { subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1" } as const;
const NO_SIGNING_CONTEXT = { subOrganizationId: null, authorizingCredentialId: null } as const;

/**
 * L-2 D-13: a /latest payment answer shaped as the route sends it
 * (resolveLatestPayment): all four keys; the signing context only for an
 * awaiting_authorization row bound to this session's passkey (`bound: false`
 * for one that is not), never for any other state; a reserved `prepared` row
 * without fields; the server's whole-second clock.
 */
function honestLatestBody(attempt: Record<string, unknown>, options: { bound?: boolean; nowSeconds?: number } = {}) {
  const awaiting = attempt.state === "awaiting_authorization";
  return {
    attempt: attempt.state === "prepared" ? { ...attempt, prepared: null } : attempt,
    ...(awaiting && options.bound !== false ? SIGNING_CONTEXT : NO_SIGNING_CONTEXT),
    serverNowSeconds: options.nowSeconds ?? Math.floor(Date.now() / 1000),
  };
}

function baseAttempt() {
  return {
    id: ATTEMPT_ID,
    state: "awaiting_authorization" as const,
    recipient: "0x2222222222222222222222222222222222222222",
    recipientIdentity: null as { handle: string; displayName: string | null } | null,
    amountBaseUnits: "1000000",
    transactionHash: null,
    failureReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    prepared: PREPARED_FIELDS,
  };
}

/**
 * Pre-2f hardening: account-switch/logout state isolation. init() must
 * clear a prior account's recipient/amount/attempt/error as its FIRST
 * synchronous action — before its own /latest fetch even resolves — so
 * "reset before init" holds no matter which caller (a fresh mount, an
 * account-change effect) invokes it. See components/real/real-pay-form.tsx's
 * account-change effect for the other half of this fix.
 */
describe("real-payment-store — init() resets prior-account state before fetching", () => {
  it("clears recipientInput/amountInput/attempt/error synchronously, before the /latest fetch resolves", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { attempt: null })));
    const store = createRealPaymentStore();

    // Simulate stale input left over from a prior account.
    store.getState().setRecipientInput("0x1111111111111111111111111111111111111111");
    store.getState().setAmountInput("42");
    store.setState({
      attempt: {
        id: "stale-attempt",
        state: "awaiting_authorization",
        recipient: "0x1111111111111111111111111111111111111111",
        recipientIdentity: null,
        amountBaseUnits: "42000000",
        transactionHash: null,
        failureReason: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        prepared: null,
      },
      error: "stale error from a previous account",
    });

    const pending = store.getState().init();
    // Checked BEFORE awaiting the fetch — init() must clear these as its
    // first synchronous action, not only after the response arrives.
    expect(store.getState().recipientInput).toBe("");
    expect(store.getState().amountInput).toBe("");
    expect(store.getState().attempt).toBeNull();
    expect(store.getState().error).toBeNull();

    await pending;
    // Still clear once the fetch resolves (server reported no attempt).
    expect(store.getState().attempt).toBeNull();
    vi.unstubAllGlobals();
  });

  it("a stale recipient/amount cannot be submitted under a different account — review() sees the cleared state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { attempt: null })));
    const store = createRealPaymentStore();
    store.getState().setRecipientInput("0x1111111111111111111111111111111111111111");
    store.getState().setAmountInput("42");

    await store.getState().init();
    store.getState().review();

    // Nothing to review — the fields were cleared, so review() reports the
    // validation error rather than proceeding with the prior account's data.
    expect(store.getState().status).not.toBe("reviewing");
    expect(store.getState().error).toBeTruthy();
    vi.unstubAllGlobals();
  });
});

/**
 * Pre-2f hardening: a generation token closes the gap "reset before init"
 * alone leaves open — a request started under one account/generation can
 * still resolve AFTER a newer reset()/init() has already run. See
 * real-payment-store.ts's `generation` closure variable.
 */
describe("real-payment-store — stale async response race (pre-2f hardening)", () => {
  it("a stale init() response arriving after reset() is a no-op, never resurrects a cleared attempt", async () => {
    let resolveFetch: (value: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => (resolveFetch = resolve))));
    const store = createRealPaymentStore();

    const pending = store.getState().init();
    // Simulates an account switch/logout racing ahead of the in-flight
    // /latest fetch — reset() is the standalone action real-pay-form.tsx's
    // effect calls on logout.
    store.getState().reset();
    expect(store.getState().attempt).toBeNull();
    expect(store.getState().status).toBe("editing");

    resolveFetch(
      jsonResponse(200, {
        attempt: {
          id: "stale-attempt",
          state: "awaiting_authorization",
          recipient: "0x1111111111111111111111111111111111111111",
          amountBaseUnits: "1000000",
          transactionHash: null,
          failureReason: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          prepared: null,
        },
        subOrganizationId: "sub-org-stale",
      }),
    );
    await pending;

    expect(store.getState().attempt).toBeNull();
    expect(store.getState().status).toBe("editing");
    vi.unstubAllGlobals();
  });

  it("latest-request-wins: an older init() response resolving after a newer init() cannot overwrite it", async () => {
    let resolveA: (value: Response) => void = () => {};
    let resolveB: (value: Response) => void = () => {};
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        callCount += 1;
        if (callCount === 1) return new Promise<Response>((resolve) => (resolveA = resolve));
        return new Promise<Response>((resolve) => (resolveB = resolve));
      }),
    );
    const store = createRealPaymentStore();

    // Simulates a fast account switch that re-triggers init() before the
    // first call's fetch has resolved.
    const pendingA = store.getState().init();
    const pendingB = store.getState().init();

    resolveB(jsonResponse(200, { attempt: null }));
    await pendingB;
    expect(store.getState().attempt).toBeNull();
    expect(store.getState().status).toBe("editing");

    // A — the OLDER request — resolves last and must not overwrite B's result.
    resolveA(
      jsonResponse(200, {
        attempt: {
          id: "attempt-a-stale",
          state: "awaiting_authorization",
          recipient: "0x1111111111111111111111111111111111111111",
          amountBaseUnits: "1000000",
          transactionHash: null,
          failureReason: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          prepared: null,
        },
        subOrganizationId: "sub-org-a",
      }),
    );
    await pendingA;

    expect(store.getState().attempt).toBeNull();
    expect(store.getState().status).toBe("editing");
    vi.unstubAllGlobals();
  });
});

function stubFetchByUrl(handlers: Record<string, () => Response>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      for (const [pattern, handler] of Object.entries(handlers)) {
        if (url.includes(pattern)) return handler();
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  return calls;
}

const VALID_UNTIL = PREPARED_FIELDS.validUntil;

/**
 * Part B (S2): the UI must reconcile an expired awaiting_authorization/
 * stranded attempt itself — not just wait for the server to be asked. Two
 * one-shot triggers, never a repeating poll: already-expired-on-mount, and a
 * single deferred check timed to fire exactly when an open page's attempt
 * crosses validUntil.
 */
describe("real-payment-store — Part B: one-shot expiry reconciliation (no polling)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("an already-expired awaiting_authorization attempt triggers exactly one automatic /status check on mount", async () => {
    const calls = stubFetchByUrl({
      "/api/real/payments/latest": () =>
        jsonResponse(200, { attempt: baseAttempt(), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: VALID_UNTIL + 100 }),
      "/status": () =>
        jsonResponse(200, {
          attempt: { ...baseAttempt(), state: "failed", failureReason: "This payment expired before it was included on-chain. No money moved.", prepared: PREPARED_FIELDS },
          serverNowSeconds: VALID_UNTIL + 100,
        }),
    });
    const store = createRealPaymentStore();

    await store.getState().init();

    expect(calls.filter((u) => u.includes("/status"))).toHaveLength(1);
    expect(store.getState().status).toBe("failed");
    expect(store.getState().attempt?.failureReason).toMatch(/No money moved/);
  });

  it("a legacy attempt (no prepared/validUntil) is never scheduled for an expiry check", async () => {
    vi.useFakeTimers();
    const calls = stubFetchByUrl({
      "/api/real/payments/latest": () => jsonResponse(200, { attempt: { ...baseAttempt(), prepared: null }, ...NO_SIGNING_CONTEXT, serverNowSeconds: 1_900_000_000 }),
    });
    const store = createRealPaymentStore();

    await store.getState().init();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

    expect(calls.filter((u) => u.includes("/status"))).toHaveLength(0);
  });
});

/**
 * Part D (S2): cancel() must never show a false "cancelled" state. A non-2xx
 * response means the cancellation did not happen (e.g. a concurrent submit
 * already won); a network-level failure means we don't even know whether it
 * happened — neither case may reset to a fresh "editing" state.
 */
describe("real-payment-store — Part D: cancel response correctness", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a 409 from /cancel (lost the race to a concurrent submit) reflects the real server state instead of a false 'cancelled'", async () => {
    stubFetchByUrl({
      "/cancel": () => jsonResponse(409, { error: "This payment can no longer be cancelled (state: submitting)." }),
      "/status": () => jsonResponse(200, { attempt: { ...baseAttempt(), state: "submitted", prepared: PREPARED_FIELDS }, serverNowSeconds: VALID_UNTIL }),
    });
    const store = createRealPaymentStore();
    store.setState({ attempt: baseAttempt(), status: "awaiting_authorization" });

    await store.getState().cancel();

    expect(store.getState().status).toBe("submitted");
    expect(store.getState().attempt?.state).toBe("submitted");
    expect(store.getState().error).toBeTruthy();
  });

  it("a network failure on /cancel preserves the existing attempt/status — never a guessed 'cancelled' or 'editing'", async () => {
    let cancelCallCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/cancel")) {
          cancelCallCount++;
          throw new Error("network down");
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const store = createRealPaymentStore();
    store.setState({ attempt: baseAttempt(), status: "awaiting_authorization" });

    await store.getState().cancel();

    expect(cancelCallCount).toBe(1);
    expect(store.getState().status).toBe("awaiting_authorization");
    expect(store.getState().attempt?.id).toBe(ATTEMPT_ID);
    expect(store.getState().error).toBeTruthy();
  });

  it("a 409 from /cancel followed by a failed status re-fetch still preserves state rather than guessing", async () => {
    stubFetchByUrl({
      "/cancel": () => jsonResponse(409, { error: "wrong_state" }),
      "/status": () => jsonResponse(500, { error: "internal error" }),
    });
    const store = createRealPaymentStore();
    store.setState({ attempt: baseAttempt(), status: "awaiting_authorization" });

    await store.getState().cancel();

    expect(store.getState().status).toBe("awaiting_authorization");
    expect(store.getState().attempt?.id).toBe(ATTEMPT_ID);
    expect(store.getState().error).toBeTruthy();
  });

  it("a successful cancel (2xx) still resets to a fresh editable state", async () => {
    stubFetchByUrl({ "/cancel": () => jsonResponse(200, { attempt: { ...baseAttempt(), state: "cancelled", prepared: null } }) });
    const store = createRealPaymentStore();
    store.setState({ attempt: baseAttempt(), status: "awaiting_authorization" });

    await store.getState().cancel();

    expect(store.getState().status).toBe("editing");
    expect(store.getState().attempt).toBeNull();
    expect(store.getState().error).toBeNull();
  });
});

/**
 * S2 delta #2: Base finality lags validUntil by ~20 min, so the first expiry
 * check normally returns the same non-terminal attempt. The store must keep
 * checking — slowly (EXPIRY_FOLLOW_UP_MS), with one outstanding timer — until
 * the attempt is terminal, replaced, or the generation changes.
 */
describe("real-payment-store — S2 delta: low-frequency expiry follow-up", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** Server clock that advances with the (fake) local clock; starts `secondsBeforeExpiry` before VALID_UNTIL. */
  function setup(options: { secondsBeforeExpiry: number; statusStates?: string[] }) {
    vi.useFakeTimers();
    const offset = VALID_UNTIL - options.secondsBeforeExpiry - Math.floor(Date.now() / 1000);
    const serverNow = () => Math.floor(Date.now() / 1000) + offset;
    const statusStates = options.statusStates ?? [];
    const statusUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/latest")) {
          return jsonResponse(200, { attempt: baseAttempt(), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: serverNow() });
        }
        if (url.includes("/status")) {
          statusUrls.push(url);
          const state = statusStates[statusUrls.length - 1] ?? "awaiting_authorization";
          const terminal = state === "failed";
          return jsonResponse(200, {
            attempt: { ...baseAttempt(), state, prepared: PREPARED_FIELDS, failureReason: terminal ? "This payment expired before it was included on-chain. No money moved." : null },
            serverNowSeconds: serverNow(),
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    return statusUrls;
  }

  it("the first check at validUntil returns the same non-terminal attempt; no rapid polling; a later follow-up fires at the slow cadence", async () => {
    const statusUrls = setup({ secondsBeforeExpiry: 5 });
    const store = createRealPaymentStore();
    await store.getState().init();
    expect(statusUrls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(6_000); // validUntil + 1 s
    expect(statusUrls).toHaveLength(1);
    expect(store.getState().status).toBe("awaiting_authorization");
    expect(store.getState().isAttemptPastValidity).toBe(true);

    await vi.advanceTimersByTimeAsync(EXPIRY_FOLLOW_UP_MS - 1_000);
    expect(statusUrls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(statusUrls).toHaveLength(2);
    // Stage 2A: the interval grows (75 s, then 150 s), so a second 75 s is not enough.
    await vi.advanceTimersByTimeAsync(EXPIRY_FOLLOW_UP_MS);
    expect(statusUrls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(EXPIRY_FOLLOW_UP_MS);
    expect(statusUrls).toHaveLength(3);
    expect(EXPIRY_FOLLOW_UP_MS).toBeGreaterThanOrEqual(60_000);
    expect(new Set(statusUrls)).toEqual(new Set([`/api/real/payments/${ATTEMPT_ID}/status`]));
  });

  it("a terminal result stops all future checks", async () => {
    const statusUrls = setup({ secondsBeforeExpiry: -100, statusStates: ["awaiting_authorization", "failed"] });
    const store = createRealPaymentStore();
    await store.getState().init(); // already expired: first check on mount
    expect(statusUrls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(EXPIRY_FOLLOW_UP_MS);
    expect(statusUrls).toHaveLength(2);
    expect(store.getState().status).toBe("failed");

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(statusUrls).toHaveLength(2);
  });

  it("switching to a different attempt cancels the old schedule — no call for the old payment id", async () => {
    const statusUrls = setup({ secondsBeforeExpiry: -100 });
    const store = createRealPaymentStore();
    await store.getState().init();
    expect(statusUrls).toHaveLength(1);

    store.setState({ attempt: { ...baseAttempt(), id: ATTEMPT_ID_2, prepared: null } });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(statusUrls).toHaveLength(1);
  });

  it("a generation change (reset / account switch) cancels the schedule", async () => {
    const statusUrls = setup({ secondsBeforeExpiry: 5 });
    const store = createRealPaymentStore();
    await store.getState().init();
    store.getState().reset();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(statusUrls).toHaveLength(0);
  });

  it("re-running init() (e.g. a React Strict Mode double effect) leaves exactly one timer, not two loops", async () => {
    const statusUrls = setup({ secondsBeforeExpiry: 5 });
    const store = createRealPaymentStore();
    await Promise.all([store.getState().init(), store.getState().init()]);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(statusUrls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(EXPIRY_FOLLOW_UP_MS);
    expect(statusUrls).toHaveLength(2);
  });
});

/** S2 delta #3: a /status response must never be applied across a generation or attempt change. */
describe("real-payment-store — S2 delta: stale status responses are discarded", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("account A's in-flight checkStatus resolving after account B loaded cannot overwrite B's attempt/status/offset/error", async () => {
    const A_ATTEMPT_ID = "a1a1a1a1-0000-4000-8000-00000000000a";
    const B_ATTEMPT_ID = "b2b2b2b2-0000-4000-8000-00000000000b";
    vi.useFakeTimers();
    let resolveA: (value: Response) => void = () => {};
    const bServerNow = VALID_UNTIL - 500;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(`/${A_ATTEMPT_ID}/status`)) return new Promise<Response>((resolve) => (resolveA = resolve));
        if (url.includes("/latest")) {
          return Promise.resolve(
            jsonResponse(200, { attempt: { ...baseAttempt(), id: B_ATTEMPT_ID }, subOrganizationId: "sub-org-B", authorizingCredentialId: "credential-B", serverNowSeconds: bServerNow }),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );
    const store = createRealPaymentStore();
    store.setState({ attempt: { ...baseAttempt(), id: A_ATTEMPT_ID, state: "unknown", prepared: null }, status: "unknown" });

    const pendingA = store.getState().checkStatus();
    await store.getState().init(); // account B
    const before = { ...store.getState() };
    expect(before.attempt?.id).toBe(B_ATTEMPT_ID);

    resolveA(
      jsonResponse(200, {
        attempt: { ...baseAttempt(), id: A_ATTEMPT_ID, state: "failed", failureReason: "A's reason", prepared: null },
        serverNowSeconds: 1_000,
      }),
    );
    await pendingA;

    const after = store.getState();
    expect(after.attempt?.id).toBe(B_ATTEMPT_ID);
    expect(after.status).toBe("awaiting_authorization");
    expect(after.clockOffsetSeconds).toBe(before.clockOffsetSeconds);
    expect(after.error).toBeNull();
  });

  it("a status error for a stale request never sets an error on the current attempt", async () => {
    let rejectA: (reason: unknown) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((_, reject) => (rejectA = reject))),
    );
    const store = createRealPaymentStore();
    store.setState({ attempt: { ...baseAttempt(), id: "attempt-A", state: "unknown", prepared: null }, status: "unknown" });
    const pendingA = store.getState().checkStatus();
    store.getState().reset();
    rejectA(new Error("network down"));
    await pendingA;
    expect(store.getState()).toMatchObject({ status: "editing", attempt: null, error: null });
  });
});

/**
 * Handle Pay Slice C — the Pay UI's store half. The lookup is advisory: it
 * keeps only { handle, displayName, isSelf }, and prepare is sent the
 * canonical handle alone (the server derives the destination).
 */
describe("real-payment-store — Slice C: paying by @name", () => {
  const ADDRESS = "0x3333333333333333333333333333333333333333";
  const ACCOUNT = { appUserId: "app-user-1", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222" };
  const FOUND_SMIT = { found: true, handle: "smit", displayName: "Smit Patel", isSelf: false };

  type Call = { url: string; method: string; rawBody: string | null; body: unknown };
  type Deferred = { resolve: (response: Response) => void; reject: (reason: unknown) => void };

  /** Routes fetch by URL; a handler may return a Response, throw, or return a promise it resolves later. */
  function stubApi(handlers: {
    lookup?: (body: { handle: string }) => Response | Promise<Response>;
    prepare?: (body: unknown) => Response;
    cancel?: () => Response;
    latest?: () => Response;
    status?: () => Response;
    submit?: (body: unknown) => Response;
  }) {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const rawBody = typeof init?.body === "string" ? init.body : null;
        const body: unknown = rawBody ? JSON.parse(rawBody) : undefined;
        calls.push({ url, method: (init?.method ?? "GET").toUpperCase(), rawBody, body });
        if (url.endsWith("/api/real/payments/latest")) return handlers.latest?.() ?? jsonResponse(200, { attempt: null });
        if (url.endsWith("/status") && handlers.status) return handlers.status();
        if (url.endsWith("/api/real/payments/submit") && handlers.submit) return handlers.submit(body);
        if (url.endsWith("/api/real/recipients/lookup") && handlers.lookup) return handlers.lookup(body as { handle: string });
        if (url.endsWith("/api/real/payments/prepare") && handlers.prepare) return handlers.prepare(body);
        if (url.endsWith("/cancel") && handlers.cancel) return handlers.cancel();
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    return {
      calls,
      lookups: () => calls.filter((call) => call.url.endsWith("/api/real/recipients/lookup")),
      prepares: () => calls.filter((call) => call.url.endsWith("/api/real/payments/prepare")),
    };
  }

  function deferredResponse(): { promise: Promise<Response> } & Deferred {
    let resolve: Deferred["resolve"] = () => {};
    let reject: Deferred["reject"] = () => {};
    const promise = new Promise<Response>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  /** L-2 D-12: what the server answers for THIS request — the amount sent; the address sent with a null identity, or, for a handle, its resolved lower-case Safe and the { handle, displayName } snapshot. */
  const prepareOk = (body: unknown) => {
    const sent = body as { recipient?: string; recipientHandle?: string; amountBaseUnits: string };
    const recipient = sent.recipientHandle === undefined ? { recipient: sent.recipient, recipientIdentity: null } : { recipientIdentity: { handle: sent.recipientHandle, displayName: "Smit Patel" } };
    return jsonResponse(200, { attempt: { ...baseAttempt(), id: PREPARED_ID, amountBaseUnits: sent.amountBaseUnits, ...recipient }, subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: Math.floor(Date.now() / 1000) });
  };

  function editingStore() {
    const store = createRealPaymentStore();
    store.setState({ status: "editing" });
    return store;
  }

  /** A store sitting on the review screen for a found @smit. */
  async function reviewingSmit(api: ReturnType<typeof stubApi>) {
    const store = editingStore();
    store.getState().setRecipientInput("@smit");
    store.getState().setAmountInput("1");
    await store.getState().review();
    expect(store.getState().status).toBe("reviewing");
    expect(api.lookups()).toHaveLength(1);
    return store;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    useRealAccountStore.setState({ account: null });
  });

  describe("lookup", () => {
    it("typing never looks anything up; leaving the field looks up the canonical handle exactly once", async () => {
      const api = stubApi({ lookup: () => jsonResponse(200, FOUND_SMIT) });
      const store = editingStore();

      for (const value of ["@", "@s", "@sm", "@smi", " @Smit "]) store.getState().setRecipientInput(value);
      expect(api.calls).toHaveLength(0);

      await store.getState().lookupRecipient();
      expect(api.lookups()).toHaveLength(1);
      expect(api.lookups()[0]).toMatchObject({ method: "POST", rawBody: '{"handle":"smit"}' });
      expect(store.getState().recipientLookup).toEqual({ status: "found", handle: "smit", displayName: "Smit Patel", isSelf: false });

      // Already resolved: leaving the field again (or pressing Review) asks nothing more.
      await store.getState().lookupRecipient();
      store.getState().setAmountInput("1");
      await store.getState().review();
      expect(api.lookups()).toHaveLength(1);
      expect(store.getState().status).toBe("reviewing");
    });

    it("shows looking_up while the request is in flight", async () => {
      const pending = deferredResponse();
      stubApi({ lookup: () => pending.promise });
      const store = editingStore();
      store.getState().setRecipientInput("smit");

      const lookup = store.getState().lookupRecipient();
      expect(store.getState().recipientLookup).toEqual({ status: "looking_up" });
      pending.resolve(jsonResponse(200, FOUND_SMIT));
      await lookup;
      expect(store.getState().recipientLookup.status).toBe("found");
    });

    it("Review looks an unresolved name up and opens review only after it is found", async () => {
      const pending = deferredResponse();
      const api = stubApi({ lookup: () => pending.promise });
      const store = editingStore();
      store.getState().setRecipientInput("@smit");
      store.getState().setAmountInput("1");

      const review = store.getState().review();
      expect(store.getState().status).toBe("editing");
      pending.resolve(jsonResponse(200, FOUND_SMIT));
      await review;

      expect(api.lookups()).toHaveLength(1);
      expect(store.getState().status).toBe("reviewing");
    });

    it("Review joins the lookup the field's blur already started — one request, not two", async () => {
      const pending = deferredResponse();
      const api = stubApi({ lookup: () => pending.promise });
      const store = editingStore();
      store.getState().setRecipientInput("@smit");
      store.getState().setAmountInput("1");

      const blur = store.getState().lookupRecipient();
      const review = store.getState().review();
      pending.resolve(jsonResponse(200, FOUND_SMIT));
      await Promise.all([blur, review]);

      expect(api.lookups()).toHaveLength(1);
      expect(store.getState().status).toBe("reviewing");
    });

    it("Review does not open if the amount was edited while the name was being checked", async () => {
      const pending = deferredResponse();
      stubApi({ lookup: () => pending.promise });
      const store = editingStore();
      store.getState().setRecipientInput("@smit");
      store.getState().setAmountInput("1");

      const review = store.getState().review();
      store.getState().setAmountInput("15");
      pending.resolve(jsonResponse(200, FOUND_SMIT));
      await review;

      expect(store.getState().status).toBe("editing");
      expect(store.getState().recipientLookup.status).toBe("found");
    });

    it("an invalid amount is reported before any lookup is sent", async () => {
      const api = stubApi({ lookup: () => jsonResponse(200, FOUND_SMIT) });
      const store = editingStore();
      store.getState().setRecipientInput("@smit");
      await store.getState().review();
      expect(api.calls).toHaveLength(0);
      expect(store.getState()).toMatchObject({ status: "editing", error: "Enter an amount greater than zero." });
    });

    it("a found name with no display name keeps displayName null", async () => {
      stubApi({ lookup: () => jsonResponse(200, { found: true, handle: "smit", displayName: null, isSelf: false }) });
      const store = editingStore();
      store.getState().setRecipientInput("smit");
      await store.getState().lookupRecipient();
      expect(store.getState().recipientLookup).toEqual({ status: "found", handle: "smit", displayName: null, isSelf: false });
    });

    it("not found: Review stays on the form and does not ask again", async () => {
      const api = stubApi({ lookup: () => jsonResponse(200, { found: false }) });
      const store = editingStore();
      store.getState().setRecipientInput("@nobody");
      store.getState().setAmountInput("1");

      await store.getState().review();
      expect(store.getState()).toMatchObject({ status: "editing", recipientLookup: { status: "not_found" } });
      await store.getState().review();
      await store.getState().lookupRecipient();
      expect(api.lookups()).toHaveLength(1);
      expect(store.getState().status).toBe("editing");
    });

    it("the lookup says it's you: Review refuses to advance", async () => {
      stubApi({ lookup: () => jsonResponse(200, { ...FOUND_SMIT, isSelf: true }) });
      const store = editingStore();
      store.getState().setRecipientInput("@smit");
      store.getState().setAmountInput("1");

      await store.getState().review();
      expect(store.getState().status).toBe("editing");
      await store.getState().review();
      expect(store.getState()).toMatchObject({ status: "editing", error: "That's your own @smit." });
    });

    it("your own @name (already known locally) is self immediately — no lookup request at all", async () => {
      useRealAccountStore.setState({ account: { ...ACCOUNT, handle: "smit" } });
      const api = stubApi({});
      const store = editingStore();
      store.getState().setRecipientInput(" @Smit ");
      store.getState().setAmountInput("1");

      await store.getState().lookupRecipient();
      await store.getState().review();

      expect(api.calls).toHaveLength(0);
      expect(store.getState()).toMatchObject({ status: "editing", error: "That's your own @smit.", recipientLookup: { status: "idle" } });
    });

    it("a network failure or a server error is 'error', and the next blur or Review retries", async () => {
      let attempt = 0;
      const api = stubApi({
        lookup: () => {
          attempt += 1;
          if (attempt === 1) throw new Error("network down");
          if (attempt === 2) return jsonResponse(500, { error: "Something went wrong." });
          return jsonResponse(200, FOUND_SMIT);
        },
      });
      const store = editingStore();
      store.getState().setRecipientInput("@smit");
      store.getState().setAmountInput("1");

      await store.getState().lookupRecipient();
      expect(store.getState().recipientLookup).toEqual({ status: "error" });
      await store.getState().lookupRecipient();
      expect(store.getState().recipientLookup).toEqual({ status: "error" });
      expect(store.getState().status).toBe("editing");

      await store.getState().review();
      expect(api.lookups()).toHaveLength(3);
      expect(store.getState().status).toBe("reviewing");
    });

    it("an answer about a different handle than the one asked is an error, never a found recipient", async () => {
      stubApi({ lookup: () => jsonResponse(200, { ...FOUND_SMIT, handle: "someone_else" }) });
      const store = editingStore();
      store.getState().setRecipientInput("@smit");
      await store.getState().lookupRecipient();
      expect(store.getState().recipientLookup).toEqual({ status: "error" });
    });

    it("stale response: @smi starts, @smit starts, @smit wins, the late @smi answer is ignored", async () => {
      const smi = deferredResponse();
      const smit = deferredResponse();
      const api = stubApi({ lookup: (body) => (body.handle === "smi" ? smi.promise : smit.promise) });
      const store = editingStore();

      store.getState().setRecipientInput("@smi");
      const first = store.getState().lookupRecipient();
      store.getState().setRecipientInput("@smit");
      const second = store.getState().lookupRecipient();

      smit.resolve(jsonResponse(200, FOUND_SMIT));
      await second;
      expect(store.getState().recipientLookup).toEqual({ status: "found", handle: "smit", displayName: "Smit Patel", isSelf: false });

      smi.resolve(jsonResponse(200, { found: true, handle: "smi", displayName: "Somebody Else", isSelf: false }));
      await first;
      expect(api.lookups().map((call) => call.body)).toEqual([{ handle: "smi" }, { handle: "smit" }]);
      expect(store.getState().recipientLookup).toEqual({ status: "found", handle: "smit", displayName: "Smit Patel", isSelf: false });
    });

    it("editing or clearing the field drops a found, not-found, or failed answer immediately", async () => {
      const answers = [jsonResponse(200, FOUND_SMIT), jsonResponse(200, { found: false }), jsonResponse(500, {})];
      stubApi({ lookup: () => answers.shift()! });
      const store = editingStore();

      for (const expected of ["found", "not_found", "error"]) {
        store.getState().setRecipientInput("@smit");
        await store.getState().lookupRecipient();
        expect(store.getState().recipientLookup.status).toBe(expected);
        store.getState().setRecipientInput("@smitt");
        expect(store.getState().recipientLookup).toEqual({ status: "idle" });
      }
      store.getState().setRecipientInput("");
      expect(store.getState().recipientLookup).toEqual({ status: "idle" });
    });

    it("an answer that arrives after an edit, a reset, or an init is ignored", async () => {
      for (const invalidate of ["edit", "reset", "init"] as const) {
        const pending = deferredResponse();
        stubApi({ lookup: () => pending.promise });
        const store = editingStore();
        store.getState().setRecipientInput("@smit");
        const lookup = store.getState().lookupRecipient();

        if (invalidate === "edit") {
          // Same canonical handle afterwards — the sequence alone must reject it.
          store.getState().setRecipientInput("@smi");
          store.getState().setRecipientInput("@smit");
        } else if (invalidate === "reset") {
          store.getState().reset();
          store.getState().setRecipientInput("@smit");
        } else {
          await store.getState().init();
          store.getState().setRecipientInput("@smit");
        }
        pending.resolve(jsonResponse(200, FOUND_SMIT));
        await lookup;
        expect(store.getState().recipientLookup, invalidate).toEqual({ status: "idle" });
      }
    });

    it("init() and reset() clear a resolved recipient", async () => {
      stubApi({ lookup: () => jsonResponse(200, FOUND_SMIT) });
      for (const clear of ["init", "reset"] as const) {
        const store = editingStore();
        store.getState().setRecipientInput("@smit");
        await store.getState().lookupRecipient();

        if (clear === "init") await store.getState().init();
        else store.getState().reset();

        expect(store.getState(), clear).toMatchObject({ recipientInput: "", recipientLookup: { status: "idle" }, attempt: null });
      }
    });

    it("a malformed name or a partial address never calls lookup; Review reports it and stays on the form", async () => {
      const api = stubApi({});
      for (const [input, message] of [
        ["@@smit", "Enter a valid @name."],
        ["ab", "Enter a valid @name."],
        ["0xabc", "Enter a valid account address."],
        ["", "Enter who you're paying."],
      ]) {
        const store = editingStore();
        store.getState().setRecipientInput(input);
        store.getState().setAmountInput("1");
        await store.getState().lookupRecipient();
        await store.getState().review();
        expect(store.getState(), input).toMatchObject({ status: "editing", error: message });
      }
      expect(api.calls).toHaveLength(0);
    });

    it("SECURITY: only handle/displayName/isSelf are kept — a Safe, app user id, or owner in the answer is dropped", async () => {
      stubApi({
        lookup: () =>
          jsonResponse(200, { ...FOUND_SMIT, safeAddress: "0x9999999999999999999999999999999999999999", appUserId: "app-user-9", ownerAddress: "0x8888888888888888888888888888888888888888", recipient: "0x9999999999999999999999999999999999999999" }),
      });
      const store = editingStore();
      store.getState().setRecipientInput("@smit");
      await store.getState().lookupRecipient();

      expect(store.getState().recipientLookup).toEqual({ status: "found", handle: "smit", displayName: "Smit Patel", isSelf: false });
      const snapshot = JSON.stringify(store.getState());
      for (const leaked of ["0x9999", "app-user-9", "0x8888"]) expect(snapshot).not.toContain(leaked);
    });
  });

  describe("prepare", () => {
    it("a handle payment sends exactly { recipientHandle, amountBaseUnits } — nothing else, no address", async () => {
      useRealAccountStore.setState({ account: ACCOUNT });
      const api = stubApi({ lookup: () => jsonResponse(200, FOUND_SMIT), prepare: prepareOk });
      const store = editingStore();
      store.getState().setRecipientInput(" @Smit ");
      store.getState().setAmountInput("1");
      await store.getState().review();
      await store.getState().confirmAndSend();

      expect(api.prepares()).toHaveLength(1);
      expect(api.prepares()[0].rawBody).toBe('{"recipientHandle":"smit","amountBaseUnits":"1000000"}');
      expect(store.getState().status).toBe("awaiting_authorization");
      store.getState().reset();
    });

    it("SECURITY: forged identity fields in the lookup answer never reach prepare, and no address is synthesized", async () => {
      useRealAccountStore.setState({ account: ACCOUNT });
      const api = stubApi({
        lookup: () => jsonResponse(200, { ...FOUND_SMIT, recipient: ADDRESS, recipientSafe: ADDRESS, safeAddress: ADDRESS, recipientAppUserId: "app-user-9", appUserId: "app-user-9", recipientDisplayName: "Forged", ownerAddress: ADDRESS }),
        prepare: prepareOk,
      });
      const store = await reviewingSmit(api);
      await store.getState().confirmAndSend();

      expect(api.prepares()[0].body).toEqual({ recipientHandle: "smit", amountBaseUnits: "1000000" });
      expect(api.prepares()[0].rawBody).not.toMatch(/0x|app-user|Forged|Smit Patel/);
      store.getState().reset();
    });

    it("fails closed without calling prepare when the found handle isn't the current input's handle", async () => {
      const api = stubApi({ lookup: () => jsonResponse(200, FOUND_SMIT), prepare: prepareOk });
      const store = await reviewingSmit(api);
      store.setState({ recipientLookup: { status: "found", handle: "someone_else", displayName: "Someone Else", isSelf: false } });

      await store.getState().confirmAndSend();

      expect(api.prepares()).toHaveLength(0);
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null });
      expect(store.getState().error).toBeTruthy();
    });

    it("fails closed without calling prepare when the lookup isn't 'found' or says it's the payer", async () => {
      for (const recipientLookup of [{ status: "idle" }, { status: "looking_up" }, { status: "not_found" }, { status: "error" }, { status: "found", handle: "smit", displayName: null, isSelf: true }] as const) {
        const api = stubApi({ lookup: () => jsonResponse(200, FOUND_SMIT), prepare: prepareOk });
        const store = await reviewingSmit(api);
        store.setState({ recipientLookup });
        await store.getState().confirmAndSend();
        expect(api.prepares(), recipientLookup.status).toHaveLength(0);
        expect(store.getState().status).toBe("editing");
      }
    });

    it("prepare 404 (the name is gone): back to the form, text kept, resolution cleared, the server's message shown", async () => {
      const api = stubApi({ lookup: () => jsonResponse(200, FOUND_SMIT), prepare: () => jsonResponse(404, { error: "We couldn't find anyone with that name." }) });
      const store = await reviewingSmit(api);

      await store.getState().confirmAndSend();

      expect(store.getState()).toMatchObject({
        status: "editing",
        recipientInput: "@smit",
        recipientLookup: { status: "idle" },
        attempt: null,
        error: "We couldn't find anyone with that name.",
      });
    });

    it("prepare self-payment refusal: back to the form, resolution cleared, the server's copy shown", async () => {
      const api = stubApi({ lookup: () => jsonResponse(200, FOUND_SMIT), prepare: () => jsonResponse(400, { error: "You can't pay yourself." }) });
      const store = await reviewingSmit(api);

      await store.getState().confirmAndSend();

      expect(store.getState()).toMatchObject({ status: "editing", recipientInput: "@smit", recipientLookup: { status: "idle" }, error: "You can't pay yourself." });
    });

    it("a prepare failure that isn't about the recipient (409) keeps the resolved name", async () => {
      const api = stubApi({ lookup: () => jsonResponse(200, FOUND_SMIT), prepare: () => jsonResponse(409, { error: "You already have a payment in progress." }) });
      const store = await reviewingSmit(api);
      await store.getState().confirmAndSend();
      // L-2 D-1: every prepare 409 now asks for a status check; the fixed client copy replaces the server's sentence (see the D-1 suite).
      expect(store.getState()).toMatchObject({ status: "editing", recipientLookup: { status: "found", handle: "smit" }, error: null, prepareNeedsCheck: "in_progress" });
    });
  });

  /**
   * Slice D: after prepare the attempt's own `recipientIdentity` — the
   * server's stored snapshot, on every response that returns the attempt — is
   * the ONE source of the recipient's name. The Slice C in-memory label is
   * gone; nothing here is kept beside the attempt, and nothing is sent back.
   */
  describe("attempt.recipientIdentity — the one post-prepare identity (Slice D)", () => {
    const SNAPSHOT = { handle: "smit", displayName: "Smit P. (stored)" };
    const handleAttempt = (overrides: Record<string, unknown> = {}) => ({ ...baseAttempt(), id: PREPARED_ID, recipientIdentity: SNAPSHOT, ...overrides });
    const prepareHandleOk = () => jsonResponse(200, { attempt: handleAttempt(), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: Math.floor(Date.now() / 1000) });

    it("a successful handle prepare stores the SERVER's identity on the attempt — not the advisory lookup's — and keeps no separate label", async () => {
      useRealAccountStore.setState({ account: ACCOUNT });
      const api = stubApi({ lookup: () => jsonResponse(200, FOUND_SMIT), prepare: prepareHandleOk });
      const store = await reviewingSmit(api);
      // Before prepare there is no attempt: the lookup is all the Review screen has.
      expect(store.getState().attempt).toBeNull();
      expect(store.getState().recipientLookup).toMatchObject({ status: "found", displayName: "Smit Patel" });

      await store.getState().confirmAndSend();

      expect(store.getState().attempt?.recipientIdentity).toEqual(SNAPSHOT);
      expect(store.getState()).not.toHaveProperty("recipientLabel");
      store.getState().reset();
      expect(store.getState().attempt).toBeNull();
    });

    it("an address payment's attempt has a null identity", async () => {
      useRealAccountStore.setState({ account: ACCOUNT });
      const api = stubApi({ prepare: prepareOk });
      const store = editingStore();
      store.getState().setRecipientInput(ADDRESS);
      store.getState().setAmountInput("1");
      void store.getState().review();
      await store.getState().confirmAndSend();
      expect(api.prepares()).toHaveLength(1);
      expect(store.getState().attempt).toMatchObject({ id: PREPARED_ID, recipientIdentity: null });
      store.getState().reset();
    });

    it("reload: init() -> latest restores the identity with the attempt — no lookup request, no lookup state, nothing persisted", async () => {
      const api = stubApi({ latest: () => jsonResponse(200, { attempt: handleAttempt(), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: Math.floor(Date.now() / 1000) }) });
      const store = createRealPaymentStore();

      await store.getState().init();

      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", recipientInput: "", recipientLookup: { status: "idle" }, attempt: { id: PREPARED_ID, recipientIdentity: SNAPSHOT } });
      expect(api.lookups()).toHaveLength(0);
      expect(api.calls.map((call) => call.url)).toEqual(["/api/real/payments/latest"]);
      store.getState().reset();
    });

    it("a status check replaces the attempt and the identity comes from that response", async () => {
      const renamed = { handle: "smit", displayName: null };
      stubApi({ status: () => jsonResponse(200, { attempt: handleAttempt({ state: "confirmed", recipientIdentity: renamed }), serverNowSeconds: Math.floor(Date.now() / 1000) }) });
      const store = createRealPaymentStore();
      store.setState({ status: "submitted", attempt: handleAttempt({ state: "submitted" }) });

      await store.getState().checkStatus();

      expect(store.getState()).toMatchObject({ status: "confirmed", attempt: { state: "confirmed", recipientIdentity: renamed } });
    });

    it("a successful cancel drops the attempt, and its identity with it", async () => {
      useRealAccountStore.setState({ account: ACCOUNT });
      const api = stubApi({ lookup: () => jsonResponse(200, FOUND_SMIT), prepare: prepareHandleOk, cancel: () => jsonResponse(200, { attempt: handleAttempt({ state: "cancelled", prepared: null }) }) });
      const store = await reviewingSmit(api);
      await store.getState().confirmAndSend();
      expect(store.getState().attempt?.recipientIdentity).toEqual(SNAPSHOT);

      await store.getState().cancel();

      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, recipientInput: "", recipientLookup: { status: "idle" } });
    });

    it("SECURITY: the identity is read-only — prepare, submit, and cancel never send it (or any name) back", async () => {
      useRealAccountStore.setState({ account: ACCOUNT });
      vi.mocked(signPreparedPayment).mockResolvedValueOnce({ signature: "0xsignature", activityId: "activity-1" } as never);
      const api = stubApi({
        lookup: () => jsonResponse(200, FOUND_SMIT),
        prepare: prepareHandleOk,
        // The server can't confirm yet: the attempt stays awaiting, so it can then be cancelled.
        submit: () => jsonResponse(503, { error: "We couldn't confirm your passkey approval yet. Try again in a moment.", retryable: true }),
        cancel: () => jsonResponse(200, { attempt: handleAttempt({ state: "cancelled", prepared: null }) }),
      });
      const store = await reviewingSmit(api);
      await store.getState().confirmAndSend();
      await store.getState().cancel();

      const mutations = api.calls.filter((call) => call.method === "POST" && !call.url.endsWith("/api/real/recipients/lookup"));
      expect(mutations.map((call) => [call.url, call.body])).toEqual([
        ["/api/real/payments/prepare", { recipientHandle: "smit", amountBaseUnits: "1000000" }],
        ["/api/real/payments/submit", { attemptId: PREPARED_ID, signature: "0xsignature", activityId: "activity-1" }],
        [`/api/real/payments/${PREPARED_ID}/cancel`, undefined],
      ]);
      for (const call of api.calls) expect(call.rawBody ?? "", call.url).not.toMatch(/recipientIdentity|displayName|Smit|stored/);
    });
  });

  /**
   * Handle Pay Slice E — what the client does when the server says "too many".
   * A rate-limited name check is its own state (not the generic failure), is
   * never retried automatically, and is cleared by editing like every other
   * lookup state. A rate-limited prepare shows the server's message and keeps
   * the resolved name.
   */
  describe("rate limiting (Slice E)", () => {
    const LOOKUP_429 = () => jsonResponse(429, { error: "Too many tries. Try again later.", code: "rate_limited" });
    const PREPARE_429 = () => jsonResponse(429, { error: "You're going a bit fast. Try again later.", code: "rate_limited" });

    it("a 429 from the name check is the rate_limited state — not the generic lookup error, and not a recipient error message", async () => {
      stubApi({ lookup: LOOKUP_429 });
      const store = editingStore();
      store.getState().setRecipientInput("@smit");
      await store.getState().lookupRecipient();
      expect(store.getState()).toMatchObject({ status: "editing", recipientLookup: { status: "rate_limited" }, error: null });
    });

    it("an ordinary failure is unchanged: a 500 or a network error is still the generic lookup error", async () => {
      const answers: Array<() => Response> = [() => jsonResponse(500, { error: "Something went wrong. Please try again." }), () => Promise.reject(new Error("network down")) as never];
      stubApi({ lookup: () => answers.shift()!() });
      for (let i = 0; i < 2; i++) {
        const store = editingStore();
        store.getState().setRecipientInput("@smit");
        await store.getState().lookupRecipient();
        expect(store.getState().recipientLookup, String(i)).toEqual({ status: "error" });
      }
    });

    it("editing or clearing the field drops the rate-limit state immediately", async () => {
      stubApi({ lookup: LOOKUP_429 });
      const store = editingStore();
      store.getState().setRecipientInput("@smit");
      await store.getState().lookupRecipient();
      expect(store.getState().recipientLookup).toEqual({ status: "rate_limited" });
      store.getState().setRecipientInput("@smitt");
      expect(store.getState().recipientLookup).toEqual({ status: "idle" });
      await store.getState().lookupRecipient();
      store.getState().setRecipientInput("");
      expect(store.getState().recipientLookup).toEqual({ status: "idle" });
    });

    it("NO automatic retry: leaving the field again asks nothing; each Review press asks exactly once and never loops", async () => {
      const api = stubApi({ lookup: LOOKUP_429 });
      const store = editingStore();
      store.getState().setRecipientInput("@smit");
      store.getState().setAmountInput("1");

      await store.getState().lookupRecipient();
      expect(api.lookups()).toHaveLength(1);
      // Blur again (and again): still rate limited, and no request goes out.
      await store.getState().lookupRecipient();
      await store.getState().lookupRecipient();
      expect(api.lookups()).toHaveLength(1);

      // One explicit Review press = one request; it stays on the form.
      await store.getState().review();
      expect(api.lookups()).toHaveLength(2);
      expect(store.getState()).toMatchObject({ status: "editing", recipientLookup: { status: "rate_limited" } });
      await store.getState().review();
      expect(api.lookups()).toHaveLength(3);
      expect(store.getState().status).toBe("editing");
      // Nothing was prepared, and no timer or background request follows.
      expect(api.prepares()).toHaveLength(0);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(api.calls).toHaveLength(3);
    });

    it("once the budget has recovered, the next Review press finds the name and opens review", async () => {
      const answers = [LOOKUP_429(), jsonResponse(200, FOUND_SMIT)];
      const api = stubApi({ lookup: () => answers.shift()! });
      const store = editingStore();
      store.getState().setRecipientInput("@smit");
      store.getState().setAmountInput("1");
      await store.getState().review();
      expect(store.getState()).toMatchObject({ status: "editing", recipientLookup: { status: "rate_limited" } });
      await store.getState().review();
      expect(api.lookups()).toHaveLength(2);
      expect(store.getState()).toMatchObject({ status: "reviewing", recipientLookup: { status: "found", handle: "smit" } });
    });

    it("a rate-limited PREPARE shows the server's friendly message, keeps the resolved name, and is NOT retried", async () => {
      const api = stubApi({ lookup: () => jsonResponse(200, FOUND_SMIT), prepare: PREPARE_429 });
      const store = await reviewingSmit(api);

      await store.getState().confirmAndSend();

      expect(store.getState()).toMatchObject({
        status: "editing",
        recipientInput: "@smit",
        recipientLookup: { status: "found", handle: "smit", displayName: "Smit Patel" },
        attempt: null,
        error: "You're going a bit fast. Try again later.",
      });
      expect(store.getState().error).not.toMatch(/couldn't find|429|rate_limited/i);
      expect(api.prepares()).toHaveLength(1);
      expect(api.lookups()).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(api.prepares()).toHaveLength(1);
    });

    it("the payment QUOTA's 429 is still its own message, and also keeps the resolved name", async () => {
      const api = stubApi({ lookup: () => jsonResponse(200, FOUND_SMIT), prepare: () => jsonResponse(429, { error: "You've reached the payment limit for now. Try again later." }) });
      const store = await reviewingSmit(api);
      await store.getState().confirmAndSend();
      expect(store.getState()).toMatchObject({ status: "editing", recipientLookup: { status: "found", handle: "smit" }, error: "You've reached the payment limit for now. Try again later." });
      expect(api.prepares()).toHaveLength(1);
    });

    it("a rate-limited ADDRESS prepare shows the same message and keeps the typed address", async () => {
      const api = stubApi({ prepare: PREPARE_429 });
      const store = editingStore();
      store.getState().setRecipientInput(ADDRESS);
      store.getState().setAmountInput("1");
      void store.getState().review();
      await store.getState().confirmAndSend();
      expect(store.getState()).toMatchObject({ status: "editing", recipientInput: ADDRESS, attempt: null, error: "You're going a bit fast. Try again later." });
      expect(api.prepares()).toHaveLength(1);
      expect(api.lookups()).toHaveLength(0);
    });
  });

  describe("direct address (regression)", () => {
    it("a pasted address is never looked up, review opens synchronously, and the prepare body is unchanged", async () => {
      useRealAccountStore.setState({ account: ACCOUNT });
      const api = stubApi({ prepare: prepareOk });
      const store = editingStore();
      store.getState().setRecipientInput(`  ${ADDRESS.toUpperCase().replace("0X", "0x")}  `);
      store.getState().setAmountInput("1");

      await store.getState().lookupRecipient();
      void store.getState().review();
      expect(store.getState().status).toBe("reviewing"); // no await: still synchronous
      await store.getState().confirmAndSend();

      expect(api.lookups()).toHaveLength(0);
      expect(api.prepares()[0].rawBody).toBe(JSON.stringify({ recipient: ADDRESS, amountBaseUnits: "1000000" }));
      store.getState().reset();
    });

    it("the account's own address is still left to the server (no client-side address self check was added)", async () => {
      useRealAccountStore.setState({ account: { ...ACCOUNT, handle: "smit" } });
      const api = stubApi({ prepare: () => jsonResponse(400, { error: "You can't pay yourself." }) });
      const store = editingStore();
      store.getState().setRecipientInput(ACCOUNT.safeAddress);
      store.getState().setAmountInput("1");
      void store.getState().review();
      expect(store.getState().status).toBe("reviewing");
      await store.getState().confirmAndSend();

      expect(api.lookups()).toHaveLength(0);
      expect(api.prepares()[0].body).toEqual({ recipient: ACCOUNT.safeAddress, amountBaseUnits: "1000000" });
      expect(store.getState()).toMatchObject({ status: "editing", recipientInput: ACCOUNT.safeAddress, error: "You can't pay yourself." });
    });
  });
});

/**
 * 3A-1 Stage 2A: payment-status polling safety. Automatic checks are bounded,
 * growing, visibility-aware, deduplicated and cleaned up on unmount; the
 * manual check is cooldown-limited. None of it ever touches the payment — it
 * only decides WHEN a read happens.
 */
describe("real-payment-store — 3A-1 Stage 2A: bounded, deduplicated status polling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    useRealAccountStore.setState({ account: null });
  });

  type Call = { url: string; at: number };
  const ACCOUNT = { appUserId: "app-user-1", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222" };

  /** A fake server whose clock follows the fake local clock. `hold` parks every /status answer until release(). */
  function setup(options: { secondsBeforeExpiry: number; statusStates?: string[]; hold?: boolean; cancelStatus?: number }) {
    vi.mocked(signPreparedPayment).mockClear();
    vi.useFakeTimers();
    const offset = VALID_UNTIL - options.secondsBeforeExpiry - Math.floor(Date.now() / 1000);
    const serverNow = () => Math.floor(Date.now() / 1000) + offset;
    const calls: Call[] = [];
    const held: Array<() => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push({ url, at: Date.now() });
        if (url.includes("/latest")) {
          return jsonResponse(200, { attempt: baseAttempt(), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: serverNow() });
        }
        if (url.includes("/cancel")) return jsonResponse(options.cancelStatus ?? 409, { error: "wrong_state" });
        if (url.includes("/status")) {
          const n = calls.filter((c) => c.url.includes("/status")).length;
          if (options.hold) await new Promise<void>((resolve) => held.push(resolve));
          const state = options.statusStates?.[n - 1] ?? "awaiting_authorization";
          const live = state === "awaiting_authorization";
          // The stored row keeps its prepared fields after a transition (toPublicAttempt): true when this server already handed the attempt out via /latest.
          const servedLatest = calls.some((c) => c.url.includes("/latest"));
          return jsonResponse(200, {
            attempt: { ...baseAttempt(), state, prepared: live || servedLatest ? PREPARED_FIELDS : null, failureReason: state === "failed" ? "This payment expired before it was included on-chain. No money moved." : null },
            serverNowSeconds: serverNow(),
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    return {
      calls,
      statusCalls: () => calls.filter((c) => c.url.includes("/status")),
      release: async () => {
        held.splice(0).forEach((resolve) => resolve());
        await vi.advanceTimersByTimeAsync(0);
      },
    };
  }

  const HOUR = 60 * 60 * 1000;

  it("the interval policy: 75 s, doubling, capped at 10 minutes, for at most 8 follow-ups", () => {
    expect(EXPIRY_FOLLOW_UP_MS).toBe(75_000);
    expect(MAX_AUTOMATIC_FOLLOW_UPS).toBe(8);
    expect(MAX_FOLLOW_UP_INTERVAL_MS).toBe(600_000);
    expect(MANUAL_CHECK_COOLDOWN_MS).toBe(30_000);
    expect(Array.from({ length: 8 }, (_, i) => followUpDelayMs(i) / 1000)).toEqual([75, 150, 300, 600, 600, 600, 600, 600]);
    expect(followUpDelayMs(500)).toBe(600_000);
  });

  it("A. a submitted payment gets its one initial check — automatically, once, and no follow-up loop", async () => {
    const server = setup({ secondsBeforeExpiry: 0, statusStates: ["submitted"] });
    const store = createRealPaymentStore();
    store.setState({ attempt: { ...baseAttempt(), state: "submitted", prepared: null }, status: "submitted" });

    await store.getState().checkSubmittedStatus();
    expect(server.statusCalls()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(server.statusCalls()).toHaveLength(1);
    expect(store.getState().status).toBe("submitted");
  });

  it("B. an already-expired pre-dispatch attempt (stranded or awaiting) is checked once on init, then followed up on the schedule", async () => {
    for (const state of ["awaiting_authorization", "signed"]) {
      const server = setup({ secondsBeforeExpiry: -100 });
      const store = createRealPaymentStore();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          server.calls.push({ url, at: Date.now() });
          const attempt = { ...baseAttempt(), state };
          return jsonResponse(200, url.includes("/latest") ? { attempt, ...(state === "awaiting_authorization" ? { subOrganizationId: "s", authorizingCredentialId: "c" } : NO_SIGNING_CONTEXT), serverNowSeconds: VALID_UNTIL + 100 } : { attempt, serverNowSeconds: VALID_UNTIL + 100 });
        }),
      );
      await store.getState().init();
      expect(server.statusCalls(), state).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(EXPIRY_FOLLOW_UP_MS);
      expect(server.statusCalls(), state).toHaveLength(2);
      store.getState().detach();
      vi.useRealTimers();
    }
  });

  it("C. a failed cancel re-reads the real state exactly ONCE (no duplicate request behind it) and arms a follow-up", async () => {
    const server = setup({ secondsBeforeExpiry: -100 });
    const store = createRealPaymentStore();
    store.setState({ attempt: baseAttempt(), status: "awaiting_authorization", clockOffsetSeconds: 0 });
    // Server clock is past validUntil for this attempt.
    store.setState({ clockOffsetSeconds: VALID_UNTIL + 100 - Math.floor(Date.now() / 1000) });

    await store.getState().cancel();
    expect(server.calls.filter((c) => c.url.includes("/cancel"))).toHaveLength(1);
    expect(server.statusCalls()).toHaveLength(1);
    expect(store.getState().status).toBe("awaiting_authorization");

    await vi.advanceTimersByTimeAsync(EXPIRY_FOLLOW_UP_MS);
    expect(server.statusCalls()).toHaveLength(2);
  });

  it("D/E/F/G. exactly 8 follow-ups after the initial check, at growing capped intervals, then silence — and the payment is untouched", async () => {
    const server = setup({ secondsBeforeExpiry: -100 });
    const store = createRealPaymentStore();
    await store.getState().init();
    await vi.advanceTimersByTimeAsync(24 * HOUR);

    const times = server.statusCalls().map((c) => c.at);
    expect(times).toHaveLength(1 + MAX_AUTOMATIC_FOLLOW_UPS);
    const gaps = times.slice(1).map((t, i) => (t - times[i]!) / 1000);
    expect(gaps).toEqual([75, 150, 300, 600, 600, 600, 600, 600]);
    expect(Math.max(...gaps) * 1000).toBeLessThanOrEqual(MAX_FOLLOW_UP_INTERVAL_MS);

    await vi.advanceTimersByTimeAsync(48 * HOUR);
    expect(server.statusCalls()).toHaveLength(1 + MAX_AUTOMATIC_FOLLOW_UPS);

    // Silence is not an outcome: the payment is exactly as the server last reported it.
    expect(store.getState().isFollowUpExhausted).toBe(true);
    expect(store.getState().status).toBe("awaiting_authorization");
    expect(store.getState().attempt?.state).toBe("awaiting_authorization");
    expect(store.getState().error).toBeNull();
    // T: only reads — never a prepare, submit or cancel.
    expect(server.calls.every((c) => c.url.includes("/latest") || c.url.includes("/status"))).toBe(true);
  });

  it("G. after exhaustion the manual check still works, and does not restart the automatic sequence", async () => {
    const server = setup({ secondsBeforeExpiry: -100 });
    const store = createRealPaymentStore();
    await store.getState().init();
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    const before = server.statusCalls().length;

    await store.getState().checkStatus();
    expect(server.statusCalls()).toHaveLength(before + 1);
    expect(store.getState().isFollowUpExhausted).toBe(true);

    await vi.advanceTimersByTimeAsync(48 * HOUR);
    expect(server.statusCalls()).toHaveLength(before + 1);
  });

  it("G. a late callback (a re-schedule for the same attempt after exhaustion) cannot start a fresh sequence", async () => {
    const server = setup({ secondsBeforeExpiry: -100 });
    const store = createRealPaymentStore();
    await store.getState().init();
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    const before = server.statusCalls().length;

    // A passkey prompt dismissed late re-schedules; a visibility flip re-evaluates.
    useRealAccountStore.setState({ account: ACCOUNT });
    await store.getState().resumeAuthorization();
    expect(signPreparedPayment).toHaveBeenCalled(); // the re-schedule path really ran
    store.getState().setPageVisible(false);
    store.getState().setPageVisible(true);
    await vi.advanceTimersByTimeAsync(24 * HOUR);

    expect(server.statusCalls()).toHaveLength(before);
    expect(store.getState().isFollowUpExhausted).toBe(true);
  });

  it("H. detach() (Pay form unmounted) cancels the pending follow-up — nothing fires afterwards", async () => {
    const server = setup({ secondsBeforeExpiry: -100 });
    const store = createRealPaymentStore();
    await store.getState().init();
    expect(server.statusCalls()).toHaveLength(1);

    store.getState().detach();
    await vi.advanceTimersByTimeAsync(24 * HOUR);

    expect(server.statusCalls()).toHaveLength(1);
    // The durable payment is not "finalized" or reset by stopping the timer.
    expect(store.getState().attempt?.id).toBe(ATTEMPT_ID);
    expect(store.getState().status).toBe("awaiting_authorization");
  });

  it("H. a stale callback after unmount (a dismissed passkey prompt finishing late) cannot arm or run a check", async () => {
    const server = setup({ secondsBeforeExpiry: -100 });
    const store = createRealPaymentStore();
    await store.getState().init();
    store.getState().detach();
    // detach() discards the restored attempt's context only for answers; the in-memory attempt stays, as a late caller would see it.
    store.setState({ attempt: baseAttempt(), status: "awaiting_authorization", subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", clockOffsetSeconds: VALID_UNTIL + 100 - Math.floor(Date.now() / 1000) });
    useRealAccountStore.setState({ account: ACCOUNT });

    await store.getState().resumeAuthorization();
    await vi.advanceTimersByTimeAsync(24 * HOUR);

    expect(signPreparedPayment).toHaveBeenCalled();
    expect(server.statusCalls()).toHaveLength(1);
  });

  it("Q. a status answer that arrives after unmount is dropped and arms nothing", async () => {
    const server = setup({ secondsBeforeExpiry: -100, hold: true });
    const store = createRealPaymentStore();
    const initializing = store.getState().init();
    await vi.advanceTimersByTimeAsync(0);
    expect(server.statusCalls()).toHaveLength(1);

    store.getState().detach();
    await server.release();
    await initializing;
    await vi.advanceTimersByTimeAsync(24 * HOUR);

    expect(server.statusCalls()).toHaveLength(1);
  });

  it("I/J/K. hidden: no automatic check starts; on return exactly one runs — no catch-up burst — and the schedule continues from where it was", async () => {
    const server = setup({ secondsBeforeExpiry: -100 });
    const store = createRealPaymentStore();
    await store.getState().init();
    expect(server.statusCalls()).toHaveLength(1);

    store.getState().setPageVisible(false);
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(server.statusCalls()).toHaveLength(1); // I

    store.getState().setPageVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.statusCalls()).toHaveLength(2); // J: one controlled check
    await vi.advanceTimersByTimeAsync(EXPIRY_FOLLOW_UP_MS);
    expect(server.statusCalls()).toHaveLength(2); // K: the next gap is the grown one (150 s), not a burst
    await vi.advanceTimersByTimeAsync(EXPIRY_FOLLOW_UP_MS);
    expect(server.statusCalls()).toHaveLength(3);
  });

  it("I. a check that was due while hidden never fires by itself, and an in-flight answer does not re-arm a timer while hidden", async () => {
    const server = setup({ secondsBeforeExpiry: -100, hold: true });
    const store = createRealPaymentStore();
    const initializing = store.getState().init();
    await vi.advanceTimersByTimeAsync(0);
    store.getState().setPageVisible(false);
    await server.release();
    await initializing;

    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(server.statusCalls()).toHaveLength(1);

    store.getState().setPageVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.statusCalls()).toHaveLength(2);
  });

  it("J. the post-submit check waits while hidden and runs once when the page is visible again", async () => {
    const server = setup({ secondsBeforeExpiry: 0, statusStates: ["confirmed"] });
    const store = createRealPaymentStore();
    store.setState({ attempt: { ...baseAttempt(), state: "submitted", prepared: null }, status: "submitted" });

    store.getState().setPageVisible(false);
    await store.getState().checkSubmittedStatus();
    expect(server.statusCalls()).toHaveLength(0);

    store.getState().setPageVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.statusCalls()).toHaveLength(1);
    expect(store.getState().status).toBe("confirmed");
    store.getState().setPageVisible(false);
    store.getState().setPageVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.statusCalls()).toHaveLength(1);
  });

  it("L. manual cooldown: repeated presses send one request; the control returns after 30 s", async () => {
    const server = setup({ secondsBeforeExpiry: 0, statusStates: ["submitted", "submitted", "submitted"] });
    const store = createRealPaymentStore();
    store.setState({ attempt: { ...baseAttempt(), state: "submitted", prepared: null }, status: "submitted" });

    await store.getState().checkStatus();
    await store.getState().checkStatus();
    await store.getState().checkStatus();
    expect(server.statusCalls()).toHaveLength(1);
    expect(store.getState().isManualCheckCoolingDown).toBe(true);

    await vi.advanceTimersByTimeAsync(MANUAL_CHECK_COOLDOWN_MS - 1);
    expect(store.getState().isManualCheckCoolingDown).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getState().isManualCheckCoolingDown).toBe(false);

    await store.getState().checkStatus();
    expect(server.statusCalls()).toHaveLength(2);
  });

  it("L. the cooldown never leaves the control disabled forever, and an unresolved payment is never shown as failed", async () => {
    setup({ secondsBeforeExpiry: 0, statusStates: ["unknown"] });
    const store = createRealPaymentStore();
    store.setState({ attempt: { ...baseAttempt(), state: "submitted", prepared: null }, status: "submitted" });
    await store.getState().checkStatus();
    await vi.advanceTimersByTimeAsync(10 * HOUR);
    expect(store.getState().isManualCheckCoolingDown).toBe(false);
    expect(store.getState().status).toBe("unknown"); // S: still non-terminal
  });

  it("M/N. automatic and manual checks that overlap share one request", async () => {
    const server = setup({ secondsBeforeExpiry: 5, hold: true });
    const store = createRealPaymentStore();
    await store.getState().init();
    await vi.advanceTimersByTimeAsync(6_000); // the validity timer fires: automatic request in flight (held)
    expect(server.statusCalls()).toHaveLength(1);

    const manual = store.getState().checkStatus();
    const again = store.getState().checkSubmittedStatus(); // not "submitted": a no-op
    await vi.advanceTimersByTimeAsync(0);
    expect(server.statusCalls()).toHaveLength(1);

    await server.release();
    await Promise.all([manual, again]);
    expect(server.statusCalls()).toHaveLength(1);
  });

  it("M. the post-submit check and a manual check pressed together share one request", async () => {
    const server = setup({ secondsBeforeExpiry: 0, hold: true, statusStates: ["confirmed"] });
    const store = createRealPaymentStore();
    store.setState({ attempt: { ...baseAttempt(), state: "submitted", prepared: null }, status: "submitted" });

    const automatic = store.getState().checkSubmittedStatus();
    const manual = store.getState().checkStatus();
    await vi.advanceTimersByTimeAsync(0);
    expect(server.statusCalls()).toHaveLength(1);
    await server.release();
    await Promise.all([automatic, manual]);
    expect(server.statusCalls()).toHaveLength(1);
    expect(store.getState().status).toBe("confirmed");
  });

  it("O. requests are never merged across attempts: attempt-2 gets its own request, and attempt-1's late answer is dropped", async () => {
    const server = setup({ secondsBeforeExpiry: 0, hold: true });
    const store = createRealPaymentStore();
    store.setState({ attempt: baseAttempt(), status: "awaiting_authorization" });

    const first = store.getState().checkStatus();
    await vi.advanceTimersByTimeAsync(0);
    store.setState({ attempt: { ...baseAttempt(), id: ATTEMPT_ID_2 }, status: "awaiting_authorization", isManualCheckCoolingDown: false });
    const second = store.getState().checkStatus();
    await vi.advanceTimersByTimeAsync(0);

    expect(server.statusCalls().map((c) => c.url)).toEqual([`/api/real/payments/${ATTEMPT_ID}/status`, `/api/real/payments/${ATTEMPT_ID_2}/status`]);
    await server.release();
    await Promise.all([first, second]);
    expect(store.getState().attempt?.id).toBe(ATTEMPT_ID_2);
  });

  it("P. a new lifecycle (account switch → init) never joins the previous account's request and starts a fresh budget", async () => {
    const server = setup({ secondsBeforeExpiry: -100 });
    const store = createRealPaymentStore();
    await store.getState().init();
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(store.getState().isFollowUpExhausted).toBe(true);
    const before = server.statusCalls().length;

    await store.getState().init(); // another account / a fresh mount
    expect(store.getState().isFollowUpExhausted).toBe(false);
    expect(server.statusCalls()).toHaveLength(before + 1);
    expect(store.getState().isManualCheckCoolingDown).toBe(false);
  });

  it("R. a terminal answer from a manual check ends the schedule immediately", async () => {
    const server = setup({ secondsBeforeExpiry: -100, statusStates: ["awaiting_authorization", "failed"] });
    const store = createRealPaymentStore();
    await store.getState().init();
    expect(server.statusCalls()).toHaveLength(1);

    await store.getState().checkStatus();
    expect(store.getState().status).toBe("failed");
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(server.statusCalls()).toHaveLength(2);
  });

  it("S. an unknown outcome stays non-terminal: no automatic polling is invented for it and nothing is finalized", async () => {
    const server = setup({ secondsBeforeExpiry: 0, statusStates: ["unknown"] });
    const store = createRealPaymentStore();
    store.setState({ attempt: { ...baseAttempt(), state: "submitted", prepared: null }, status: "submitted" });

    await store.getState().checkSubmittedStatus();
    expect(store.getState().status).toBe("unknown");
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(server.statusCalls()).toHaveLength(1);
    expect(store.getState().attempt?.failureReason).toBeNull();
  });
});

/**
 * Stage 2A.1: two corrections. (1) The follow-up sequence can run out while the
 * payment still reads "waiting for your approval" — the manual check must stay
 * available. (2) A status read that began before a local transition (submit, a
 * refused cancel) must not be applied after it, and the read that follows the
 * transition must be a fresh one, not a join of the older request.
 */
describe("real-payment-store — 3A-1 Stage 2A.1: recovery action and stale-read barrier", () => {
  const ACCOUNT = { appUserId: "app-user-1", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222" };
  const HOUR = 60 * 60 * 1000;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    useRealAccountStore.setState({ account: null });
  });

  type StatusRequest = { url: string; respond: (state: string) => void; fail: () => void };

  /**
   * A fake server whose /status answers are DEFERRED: each request is parked in
   * `statusRequests` until the test answers or fails it. `autoFail` rejects
   * every /status immediately instead (a network that never works).
   */
  function server(options: { secondsBeforeExpiry?: number; autoFail?: boolean } = {}) {
    // Honest-server fixture: the stored row keeps its prepared fields after a transition (toPublicAttempt). A test whose HELD attempt came from awaiting() calls keepPrepared() so its status answers retain them; held attempts built with prepared: null keep the original per-state shape.
    let retainPrepared = false;
    vi.useFakeTimers();
    vi.mocked(signPreparedPayment).mockReset();
    vi.mocked(signPreparedPayment).mockResolvedValue({ signature: "0xsig", activityId: "activity-1" } as never);
    const offset = VALID_UNTIL - (options.secondsBeforeExpiry ?? 1000) - Math.floor(Date.now() / 1000);
    const serverNow = () => Math.floor(Date.now() / 1000) + offset;
    const log: { url: string; method: string; at: number }[] = [];
    const statusRequests: StatusRequest[] = [];
    let cancelStatus = 409;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        log.push({ url, method, at: Date.now() });
        if (url.includes("/latest")) {
          return jsonResponse(200, { attempt: baseAttempt(), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: serverNow() });
        }
        if (url.includes("/submit")) return jsonResponse(200, { attempt: { ...baseAttempt(), state: "submitted", prepared: null } });
        if (url.includes("/cancel")) return jsonResponse(cancelStatus, { error: "wrong_state" });
        if (url.includes("/status")) {
          if (options.autoFail) throw new TypeError("Failed to fetch");
          return new Promise<Response>((resolve, reject) => {
            statusRequests.push({
              url,
              respond: (state) =>
                resolve(
                  jsonResponse(200, {
                    attempt: {
                      ...baseAttempt(),
                      id: url.split("/")[4]!,
                      state,
                      prepared: state === "awaiting_authorization" || retainPrepared ? PREPARED_FIELDS : null,
                      failureReason: state === "failed" ? "No money moved." : null,
                    },
                    serverNowSeconds: serverNow(),
                  }),
                ),
              fail: () => reject(new TypeError("Failed to fetch")),
            });
          });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
    const statusLog = () => log.filter((c) => c.url.includes("/status"));
    return {
      log,
      statusRequests,
      statusLog,
      count: (fragment: string) => log.filter((c) => c.url.includes(fragment)).length,
      setCancelStatus: (status: number) => {
        cancelStatus = status;
      },
      keepPrepared: (retain = true) => {
        retainPrepared = retain;
      },
      settle: () => vi.advanceTimersByTimeAsync(0),
    };
  }

  /** A pending, still-valid payment this session can approve. */
  function awaiting(store: ReturnType<typeof createRealPaymentStore>) {
    useRealAccountStore.setState({ account: ACCOUNT });
    store.setState({
      attempt: baseAttempt(),
      status: "awaiting_authorization",
      subOrganizationId: "sub-org-1",
      authorizingCredentialId: "credential-1",
      clockOffsetSeconds: 0,
    });
  }

  // ---- LOW-1 -------------------------------------------------------------

  it("LOW-1 A/B/C: nine failed checks from the validity boundary exhaust the schedule; the payment still reads as pending and the manual check stays", async () => {
    const s = server({ secondsBeforeExpiry: 5, autoFail: true });
    const store = createRealPaymentStore();
    await store.getState().init();
    expect(store.getState().isAttemptPastValidity).toBe(false); // computed before validUntil

    await vi.advanceTimersByTimeAsync(24 * HOUR);

    expect(s.statusLog()).toHaveLength(1 + MAX_AUTOMATIC_FOLLOW_UPS); // nine failed automatic checks
    expect(store.getState().isFollowUpExhausted).toBe(true);
    // The validity flag was stale in the audit's scenario (failed reads never refreshed it). It is refreshed when the schedule fires.
    expect(store.getState().isAttemptPastValidity).toBe(true);
    // Nothing was decided on the payment's behalf.
    expect(store.getState().status).toBe("awaiting_authorization");
    expect(store.getState().attempt?.state).toBe("awaiting_authorization");
    expect(s.count("/submit") + s.count("/prepare") + s.count("/cancel")).toBe(0);

    // Manual recovery: works, and works again after each cooldown, however many times it errors.
    for (let i = 1; i <= 3; i++) {
      const before = s.statusLog().length;
      await store.getState().checkStatus();
      expect(s.statusLog(), `manual #${i}`).toHaveLength(before + 1);
      expect(store.getState().error).toBeTruthy();
      expect(store.getState().isManualCheckCoolingDown).toBe(true); // D
      await store.getState().checkStatus();
      expect(s.statusLog(), `during cooldown #${i}`).toHaveLength(before + 1);
      await vi.advanceTimersByTimeAsync(MANUAL_CHECK_COOLDOWN_MS);
      expect(store.getState().isManualCheckCoolingDown).toBe(false);
    }
    // And the automatic sequence did not restart.
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(s.statusLog()).toHaveLength(1 + MAX_AUTOMATIC_FOLLOW_UPS + 3);
    expect(store.getState().isFollowUpExhausted).toBe(true);
  });

  // ---- LOW-2 -------------------------------------------------------------

  it("LOW-2 E/F/G/P: a read begun before the submit cannot revert the submitted payment, and the post-submit read is a fresh one", async () => {
    const s = server();
    const store = createRealPaymentStore();
    awaiting(store);

    // An ordinary read starts while the payment is awaiting approval.
    const older = store.getState().checkStatus();
    await s.settle();
    expect(s.statusRequests).toHaveLength(1);

    // The payment is then approved and submitted.
    await store.getState().resumeAuthorization();
    expect(store.getState().status).toBe("submitted");
    expect(s.count("/submit")).toBe(1);

    // The post-submit check (the form's effect) must not join the older request ...
    const postSubmit = store.getState().checkSubmittedStatus();
    await s.settle();
    expect(s.statusRequests).toHaveLength(1);

    // ... and when the older answer finally arrives (a stale "awaiting"), it is not applied.
    s.statusRequests[0]!.respond("awaiting_authorization");
    await s.settle();
    await older;
    expect(store.getState().status).toBe("submitted");
    expect(store.getState().attempt?.state).toBe("submitted");

    // Only then is the fresh read issued — and it is the one that decides.
    expect(s.statusRequests).toHaveLength(2);
    s.statusRequests[1]!.respond("confirmed");
    await postSubmit;
    expect(store.getState().status).toBe("confirmed");
    expect(s.statusRequests).toHaveLength(2);
    // P: exactly one submit, no prepare, no second dispatch.
    expect(s.count("/submit")).toBe(1);
    expect(s.count("/prepare")).toBe(0);
  });

  it("LOW-2 H/I: a refused cancel does not rely on a read that began before it — it waits, discards that answer, and reads fresh", async () => {
    const s = server();
    const store = createRealPaymentStore();
    awaiting(store);
    s.keepPrepared();

    const older = store.getState().checkStatus();
    await s.settle();
    expect(s.statusRequests).toHaveLength(1);

    const cancelling = store.getState().cancel();
    await s.settle();
    expect(s.count("/cancel")).toBe(1);
    expect(s.statusRequests).toHaveLength(1); // no second concurrent request while the older one is open

    s.statusRequests[0]!.respond("awaiting_authorization"); // predates whatever won the race
    await s.settle();
    await older;
    expect(store.getState().status).toBe("awaiting_authorization");
    expect(store.getState().error).toBeNull(); // the stale answer said nothing new

    expect(s.statusRequests).toHaveLength(2);
    s.statusRequests[1]!.respond("submitted");
    await cancelling;
    expect(store.getState().status).toBe("submitted");
    expect(store.getState().attempt?.state).toBe("submitted");
    expect(store.getState().error).toMatch(/could not be cancelled/i);
    expect(s.count("/submit") + s.count("/prepare")).toBe(0);
  });

  it("J. ordinary overlap (automatic follow-up + manual press) still shares one request", async () => {
    const s = server({ secondsBeforeExpiry: -100 });
    const store = createRealPaymentStore();
    const initializing = store.getState().init();
    await s.settle();
    expect(s.statusRequests).toHaveLength(1); // the automatic check

    const manual = store.getState().checkStatus();
    await s.settle();
    expect(s.statusRequests).toHaveLength(1); // joined, not duplicated

    s.statusRequests[0]!.respond("awaiting_authorization");
    await Promise.all([initializing, manual]);
    expect(s.statusLog()).toHaveLength(1);
    store.getState().detach();
  });

  it("K. no fresh read is issued once the lifecycle is detached while the older read is still open", async () => {
    const s = server();
    const store = createRealPaymentStore();
    awaiting(store);

    const older = store.getState().checkStatus();
    await s.settle();
    await store.getState().resumeAuthorization(); // submitted
    const postSubmit = store.getState().checkSubmittedStatus();
    await s.settle();

    store.getState().detach();
    s.statusRequests[0]!.respond("awaiting_authorization");
    await s.settle();
    await Promise.all([older, postSubmit]);
    await vi.advanceTimersByTimeAsync(24 * HOUR);

    expect(s.statusRequests).toHaveLength(1);
  });

  it("L. an attempt or account change while a fresh read is waiting invalidates it — nothing is requested for the old attempt", async () => {
    // attempt change
    let s = server();
    let store = createRealPaymentStore();
    awaiting(store);
    let older = store.getState().checkStatus();
    await s.settle();
    await store.getState().resumeAuthorization();
    let waiting = store.getState().checkSubmittedStatus();
    await s.settle();
    store.setState({ attempt: { ...baseAttempt(), id: ATTEMPT_ID_2, state: "submitted", prepared: null }, status: "submitted" });
    s.statusRequests[0]!.respond("awaiting_authorization");
    await s.settle();
    await Promise.all([older, waiting]);
    expect(s.statusRequests.map((r) => r.url)).toEqual([`/api/real/payments/${ATTEMPT_ID}/status`]);
    expect(store.getState().attempt?.id).toBe(ATTEMPT_ID_2);
    vi.useRealTimers();

    // account switch (a new lifecycle)
    s = server();
    store = createRealPaymentStore();
    awaiting(store);
    older = store.getState().checkStatus();
    await s.settle();
    await store.getState().resumeAuthorization();
    waiting = store.getState().checkSubmittedStatus();
    await s.settle();
    const reinit = store.getState().init(); // another account's page: new generation, own /latest
    await s.settle();
    s.statusRequests[0]!.respond("awaiting_authorization");
    await s.settle();
    await Promise.all([older, waiting, reinit]);
    // The old lifecycle's waiter issued nothing; the new one's own expiry logic is not due yet (validUntil is far off).
    expect(s.statusRequests).toHaveLength(1);
    expect(store.getState().attempt?.id).toBe(ATTEMPT_ID);
    expect(store.getState().status).toBe("awaiting_authorization");
    store.getState().detach();
  });

  it("M. a read that fails releases the slot: the waiting fresh read proceeds, and later triggers are not stuck on it", async () => {
    const s = server();
    const store = createRealPaymentStore();
    awaiting(store);

    const older = store.getState().checkStatus();
    await s.settle();
    await store.getState().resumeAuthorization();
    const waiting = store.getState().checkSubmittedStatus();
    await s.settle();

    s.statusRequests[0]!.fail();
    await s.settle();
    await older;
    expect(store.getState().error).toBeNull(); // a failed read from before the transition is not news
    expect(s.statusRequests).toHaveLength(2);

    s.statusRequests[1]!.fail();
    await waiting;
    expect(store.getState().status).toBe("submitted");
    expect(store.getState().error).toMatch(/fetch/i);

    // The slot is free again.
    await vi.advanceTimersByTimeAsync(MANUAL_CHECK_COOLDOWN_MS);
    const again = store.getState().checkStatus();
    await s.settle();
    expect(s.statusRequests).toHaveLength(3);
    s.statusRequests[2]!.respond("confirmed");
    await again;
    expect(store.getState().status).toBe("confirmed");
  });

  it("N. a terminal payment stays terminal: no late non-terminal answer can move it", async () => {
    const s = server();
    const store = createRealPaymentStore();
    awaiting(store);

    const late = store.getState().checkStatus();
    await s.settle();
    store.setState({ status: "confirmed", attempt: { ...baseAttempt(), state: "confirmed", prepared: null } });
    s.statusRequests[0]!.respond("awaiting_authorization");
    await late;

    expect(store.getState().status).toBe("confirmed");
    expect(store.getState().attempt?.state).toBe("confirmed");
  });

  it("O. refused-cancel and submit transitions in the middle of a sequence never reset the follow-up allowance", async () => {
    const s = server({ secondsBeforeExpiry: -100 });
    const store = createRealPaymentStore();
    useRealAccountStore.setState({ account: ACCOUNT });
    const answerAll = async () => {
      // Answer whatever is parked, as the (still non-terminal) server.
      for (const request of s.statusRequests.splice(0)) request.respond("awaiting_authorization");
      await s.settle();
    };

    const initializing = store.getState().init();
    await s.settle();
    await answerAll();
    await initializing;
    await vi.advanceTimersByTimeAsync(EXPIRY_FOLLOW_UP_MS);
    await answerAll();
    await vi.advanceTimersByTimeAsync(2 * EXPIRY_FOLLOW_UP_MS);
    await answerAll();
    expect(s.statusLog()).toHaveLength(3);

    // A refused cancel mid-sequence: one fresh read, and it continues the SAME allowance.
    const cancelling = store.getState().cancel();
    await s.settle();
    await answerAll();
    await cancelling;
    expect(s.statusLog()).toHaveLength(4);

    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(MAX_FOLLOW_UP_INTERVAL_MS);
      await answerAll();
    }
    expect(store.getState().isFollowUpExhausted).toBe(true);
    // Nine automatic checks in all, plus the one the cancel fallback itself made — never a fresh nine.
    expect(s.statusLog().length).toBeLessThanOrEqual(1 + MAX_AUTOMATIC_FOLLOW_UPS + 1);
    const times = s.statusLog().map((c) => c.at);
    const afterCancel = times.slice(4).map((t, i) => t - times[3 + i]!);
    expect(Math.min(...afterCancel)).toBeGreaterThanOrEqual(MAX_FOLLOW_UP_INTERVAL_MS); // the interval kept growing; it did not restart at 75 s
    expect(s.count("/submit") + s.count("/prepare")).toBe(0);
    store.getState().detach();
  });
});

/**
 * Stage 2C-2: the client side of the server's "not now" (reconciliationDeferred),
 * a bounded wait on every status read, current-epoch joins only, bounded
 * fresh-waiters, and a cancel that cannot turn into a read storm. None of it
 * touches payment execution: every request here is /latest, /status, or the
 * one legitimate /submit / refused /cancel of the scenario.
 */
describe("real-payment-store — 3A-1 Stage 2C-2: deferral, deadlines, freshness", () => {
  const ACCOUNT_A = { appUserId: "app-user-1", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222" };
  const ACCOUNT_B = { appUserId: "app-user-2", ownerAddress: "0x4444444444444444444444444444444444444444", safeAddress: "0x5555555555555555555555555555555555555555" };
  const HOUR = 60 * 60 * 1000;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    useRealAccountStore.setState({ account: null });
  });

  type StatusRequest = { url: string; signal: AbortSignal | undefined; respond: (state: string, extra?: Record<string, unknown>) => void; fail: () => void };

  /**
   * A fake server with DEFERRED /status answers that deliberately IGNORE the
   * AbortSignal (so only the client's own bounded wait can end a read).
   */
  function lab(options: { secondsBeforeExpiry?: number; latestId?: string; latestState?: string } = {}) {
    // Honest-server fixture: the stored row keeps its prepared fields after a transition (toPublicAttempt). A test whose HELD attempt came from awaiting() calls keepPrepared() so its status answers retain them; held attempts built with prepared: null keep the original per-state shape.
    let retainPrepared = false;
    vi.useFakeTimers();
    vi.mocked(signPreparedPayment).mockReset();
    vi.mocked(signPreparedPayment).mockResolvedValue({ signature: "0xsig", activityId: "activity-1" } as never);
    useRealAccountStore.setState({ account: ACCOUNT_A });
    const offset = VALID_UNTIL - (options.secondsBeforeExpiry ?? 1000) - Math.floor(Date.now() / 1000);
    const serverNow = () => Math.floor(Date.now() / 1000) + offset;
    const log: { url: string; method: string; at: number }[] = [];
    const requests: StatusRequest[] = [];
    let latestId = options.latestId ?? ATTEMPT_ID;
    let cancelStatus = 409;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        log.push({ url, method, at: Date.now() });
        if (url.includes("/latest")) {
          const state = options.latestState ?? "awaiting_authorization";
          return jsonResponse(200, {
            attempt: { ...baseAttempt(), id: latestId, state, prepared: state === "awaiting_authorization" ? PREPARED_FIELDS : null },
            // L-2 D-13 honest-fixture correction: the route sends the signing context only for an awaiting_authorization row.
            ...(state === "awaiting_authorization" ? SIGNING_CONTEXT : NO_SIGNING_CONTEXT),
            serverNowSeconds: serverNow(),
          });
        }
        if (url.includes("/submit")) return jsonResponse(200, { attempt: { ...baseAttempt(), state: "submitted", prepared: null } });
        if (url.includes("/cancel")) return cancelStatus === 200 ? jsonResponse(200, { attempt: { ...baseAttempt(), state: "cancelled", prepared: null } }) : jsonResponse(cancelStatus, { error: "wrong_state" });
        if (url.includes("/status")) {
          return new Promise<Response>((resolve, reject) => {
            requests.push({
              url,
              signal: init?.signal as AbortSignal | undefined,
              respond: (state, extra = {}) =>
                resolve(
                  jsonResponse(200, {
                    attempt: { ...baseAttempt(), id: url.split("/")[4]!, state, prepared: state === "awaiting_authorization" || retainPrepared ? PREPARED_FIELDS : null, failureReason: state === "failed" ? "No money moved." : null },
                    serverNowSeconds: serverNow(),
                    reconciliationDeferred: false,
                    ...extra,
                  }),
                ),
              fail: () => reject(new TypeError("Failed to fetch")),
            });
          });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
    const statusLog = () => log.filter((c) => c.url.includes("/status"));
    return {
      log,
      requests,
      statusLog,
      count: (fragment: string) => log.filter((c) => c.url.includes(fragment)).length,
      setLatestId: (id: string) => {
        latestId = id;
      },
      setCancelStatus: (status: number) => {
        cancelStatus = status;
      },
      keepPrepared: (retain = true) => {
        retainPrepared = retain;
      },
      settle: () => vi.advanceTimersByTimeAsync(0),
    };
  }

  function awaiting(store: ReturnType<typeof createRealPaymentStore>, attempt = baseAttempt()) {
    store.setState({ attempt, status: "awaiting_authorization", subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", clockOffsetSeconds: 0 });
  }

  const submitted = (store: ReturnType<typeof createRealPaymentStore>) =>
    store.setState({ attempt: { ...baseAttempt(), state: "submitted", prepared: null }, status: "submitted", clockOffsetSeconds: 0 });

  const deferral = (seconds: unknown) => ({ reconciliationDeferred: true, retryAfterSeconds: seconds });

  // ---- deferral ----------------------------------------------------------

  it("A. an ordinary answer is settled: nothing deferred, no deadline", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    submitted(store);
    const check = store.getState().checkStatus();
    await s.settle();
    s.requests[0]!.respond("submitted");
    await check;
    expect(store.getState()).toMatchObject({ isStatusDeferred: false, statusRetryAfterSeconds: null, status: "submitted" });
  });

  it("B/C/D. a deferred answer keeps the stored attempt, invents no outcome, records the delay, and starts nothing", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    submitted(store);
    const check = store.getState().checkStatus();
    await s.settle();
    s.requests[0]!.respond("submitted", deferral(600));
    await check;

    expect(store.getState()).toMatchObject({ status: "submitted", isStatusDeferred: true, statusRetryAfterSeconds: 600, isManualCheckCoolingDown: true, error: null });
    expect(store.getState().attempt).toMatchObject({ id: ATTEMPT_ID, state: "submitted", failureReason: null, transactionHash: null });
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(s.statusLog()).toHaveLength(1);
    expect(s.count("/submit") + s.count("/prepare")).toBe(0);
  });

  it("D. a deferred answer whose stored attempt is already terminal shows exactly that — the server's own stored state", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    submitted(store);
    const check = store.getState().checkStatus();
    await s.settle();
    s.requests[0]!.respond("confirmed", deferral(600));
    await check;
    expect(store.getState().status).toBe("confirmed");
  });

  it("E/F/G. a missing or unusable delay is never 'retry now': the attempt is not trusted, a generic message shows, a local deadline holds", async () => {
    for (const bad of [undefined, null, 0, -1, 1.5, "600", Number.NaN, 86_401, 10 ** 12, true]) {
      const s = lab();
      const store = createRealPaymentStore();
      submitted(store);
      const before = store.getState().attempt;
      const check = store.getState().checkStatus();
      await s.settle();
      // The malformed answer even claims a terminal state — it must not be applied.
      s.requests[0]!.respond("failed", { reconciliationDeferred: true, retryAfterSeconds: bad });
      await check;

      expect(store.getState().attempt, String(bad)).toEqual(before);
      expect(store.getState().status).toBe("submitted");
      expect(store.getState().error).toMatch(/couldn.t check on this payment/i);
      expect(store.getState()).toMatchObject({ isStatusDeferred: true, statusRetryAfterSeconds: null, isManualCheckCoolingDown: true });

      await vi.advanceTimersByTimeAsync(STATUS_FALLBACK_DEADLINE_MS - 1);
      await store.getState().checkStatus();
      expect(s.statusLog()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(store.getState().isManualCheckCoolingDown).toBe(false);
      vi.useRealTimers();
    }
  });

  it("E. a non-boolean reconciliationDeferred is malformed too", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    submitted(store);
    const check = store.getState().checkStatus();
    await s.settle();
    s.requests[0]!.respond("failed", { reconciliationDeferred: "yes", retryAfterSeconds: 30 });
    await check;
    expect(store.getState().status).toBe("submitted");
    expect(store.getState().error).toBeTruthy();
  });

  it("interpretStatusResult: settled / deferred / malformed, field by field", () => {
    const attempt = baseAttempt();
    const base = { attempt, serverNowSeconds: 1 };
    expect(interpretStatusResult({ ...base })).toEqual({ kind: "settled" });
    expect(interpretStatusResult({ ...base, reconciliationDeferred: false })).toEqual({ kind: "settled" });
    expect(interpretStatusResult({ ...base, reconciliationDeferred: false, retryAfterSeconds: 9 })).toEqual({ kind: "settled" });
    expect(interpretStatusResult({ ...base, reconciliationDeferred: true, retryAfterSeconds: 1 })).toEqual({ kind: "deferred", seconds: 1 });
    expect(interpretStatusResult({ ...base, reconciliationDeferred: true, retryAfterSeconds: 86_400 })).toEqual({ kind: "deferred", seconds: 86_400 });
    for (const bad of [0, -1, 0.5, 86_401, Number.POSITIVE_INFINITY, "5", null, undefined]) {
      expect(interpretStatusResult({ ...base, reconciliationDeferred: true, retryAfterSeconds: bad }), String(bad)).toEqual({ kind: "malformed" });
    }
    expect(interpretStatusResult({ ...base, reconciliationDeferred: 1 })).toEqual({ kind: "malformed" });
  });

  it("H/I/J. a 24 h delay is honored exactly: nothing before the deadline, the control returns at it, then one manual check works", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    submitted(store);
    const check = store.getState().checkStatus();
    await s.settle();
    s.requests[0]!.respond("submitted", deferral(86_400));
    await check;

    await vi.advanceTimersByTimeAsync(86_400_000 - 1);
    expect(store.getState().isManualCheckCoolingDown).toBe(true);
    await store.getState().checkStatus();
    await store.getState().checkSubmittedStatus();
    expect(s.statusLog()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(store.getState()).toMatchObject({ isManualCheckCoolingDown: false, isStatusDeferred: false });
    const again = store.getState().checkStatus();
    await s.settle();
    expect(s.statusLog()).toHaveLength(2);
    s.requests[1]!.respond("confirmed");
    await again;
    expect(store.getState().status).toBe("confirmed");
  });

  it("K/L/M. automatic follow-ups wait for the LATER of the exponential schedule and the server's deadline, and the eight-follow-up cap still holds", async () => {
    const s = lab({ secondsBeforeExpiry: -100 });
    const store = createRealPaymentStore();
    const answerAll = async (extra: Record<string, unknown>) => {
      for (const request of s.requests.splice(0)) request.respond("awaiting_authorization", extra);
      await s.settle();
    };
    const initializing = store.getState().init();
    await s.settle();
    await answerAll(deferral(1_200)); // the server says: not for 20 minutes
    await initializing;

    // 75 s would be the schedule's next step; the deadline (1200 s) is later, so that is when it fires.
    await vi.advanceTimersByTimeAsync(1_199_000);
    expect(s.statusLog()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.statusLog()).toHaveLength(2);

    // Keep deferring with a short delay: the exponential schedule is the later one now, and the cap is unchanged.
    for (let i = 0; i < 40; i++) {
      await answerAll(deferral(5));
      await vi.advanceTimersByTimeAsync(MAX_FOLLOW_UP_INTERVAL_MS);
    }
    expect(s.statusLog()).toHaveLength(1 + MAX_AUTOMATIC_FOLLOW_UPS);
    expect(store.getState().isFollowUpExhausted).toBe(true);
    expect(store.getState().status).toBe("awaiting_authorization");
    expect(s.count("/submit") + s.count("/prepare") + s.count("/cancel")).toBe(0);
    store.getState().detach();
  });

  it("N/O. a deferral that is still running survives the tab being hidden and shown: no request on return", async () => {
    const s = lab({ secondsBeforeExpiry: -100 });
    const store = createRealPaymentStore();
    const initializing = store.getState().init();
    await s.settle();
    s.requests[0]!.respond("awaiting_authorization", deferral(3_600));
    await initializing;

    store.getState().setPageVisible(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    store.getState().setPageVisible(true);
    await s.settle();
    expect(s.statusLog()).toHaveLength(1);
    store.getState().detach();
  });

  it("P. unmount and remount for the SAME account and attempt: the deadline still holds and the control still waits", async () => {
    const s = lab({ secondsBeforeExpiry: -100 });
    const store = createRealPaymentStore();
    const first = store.getState().init();
    await s.settle();
    s.requests[0]!.respond("awaiting_authorization", deferral(1_800));
    await first;
    store.getState().detach();

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const remount = store.getState().init(); // /latest is a database read and proceeds
    await s.settle();
    await remount;
    expect(s.count("/latest")).toBe(2);
    expect(s.statusLog()).toHaveLength(1); // ...but no provider-bound status read
    expect(store.getState()).toMatchObject({ isStatusDeferred: true, isManualCheckCoolingDown: true });
    await store.getState().checkStatus();
    expect(s.statusLog()).toHaveLength(1);

    // Past the deadline the established behaviour resumes: a manual check reads again.
    await vi.advanceTimersByTimeAsync(25 * 60_000);
    expect(store.getState().isManualCheckCoolingDown).toBe(false);
    const manual = store.getState().checkStatus();
    await s.settle();
    expect(s.statusLog()).toHaveLength(2);
    s.requests[1]!.respond("awaiting_authorization");
    await manual;
    store.getState().detach();
  });

  it("Q. another account is never held by this account's deadline", async () => {
    const s = lab({ secondsBeforeExpiry: -100 });
    const store = createRealPaymentStore();
    const first = store.getState().init();
    await s.settle();
    s.requests[0]!.respond("awaiting_authorization", deferral(3_600));
    await first;
    store.getState().detach();

    useRealAccountStore.setState({ account: ACCOUNT_B });
    const second = store.getState().init();
    await s.settle();
    expect(s.statusLog()).toHaveLength(2); // the same attempt id, but not the same account: read at once
    expect(store.getState().isStatusDeferred).toBe(false);
    s.requests[1]!.respond("awaiting_authorization");
    await second;
    store.getState().detach();
  });

  it("R. another attempt is never governed by this attempt's deadline", async () => {
    const s = lab({ secondsBeforeExpiry: -100 });
    const store = createRealPaymentStore();
    const first = store.getState().init();
    await s.settle();
    s.requests[0]!.respond("awaiting_authorization", deferral(3_600));
    await first;
    store.getState().detach();

    s.setLatestId(ATTEMPT_ID_2);
    const second = store.getState().init();
    await s.settle();
    expect(s.statusLog().map((c) => c.url)).toEqual([`/api/real/payments/${ATTEMPT_ID}/status`, `/api/real/payments/${ATTEMPT_ID_2}/status`]);
    s.requests[1]!.respond("awaiting_authorization");
    await second;
    store.getState().detach();
  });

  it("S. reset() (logout / a new payment) drops the deadline", async () => {
    const s = lab({ secondsBeforeExpiry: -100 });
    const store = createRealPaymentStore();
    const first = store.getState().init();
    await s.settle();
    s.requests[0]!.respond("awaiting_authorization", deferral(3_600));
    await first;
    store.getState().reset();

    const again = store.getState().init();
    await s.settle();
    expect(s.statusLog()).toHaveLength(2);
    s.requests[1]!.respond("awaiting_authorization");
    await again;
    store.getState().detach();
  });

  it("T. a deferred answer that arrives after unmount applies nothing and records no deadline", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    submitted(store);
    const check = store.getState().checkStatus();
    await s.settle();
    store.getState().detach();
    s.requests[0]!.respond("submitted", deferral(3_600));
    await check;
    expect(store.getState().isStatusDeferred).toBe(false);

    // A later mount for the same attempt is not held by an answer that never applied.
    const remount = store.getState().init();
    await s.settle();
    await remount;
    expect(store.getState().isManualCheckCoolingDown).toBe(false);
    const manual = store.getState().checkStatus();
    await s.settle();
    expect(s.statusLog()).toHaveLength(2);
    s.requests[1]!.respond("awaiting_authorization");
    await manual;
    store.getState().detach();
  });

  // ---- request deadline --------------------------------------------------

  it("U/V/W. a hanging status read is abandoned at 45 s even though fetch ignores the AbortSignal; nothing is fabricated; no timer lingers", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    submitted(store);
    const check = store.getState().checkStatus();
    await s.settle();
    expect(s.requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(STATUS_REQUEST_DEADLINE_MS - 1);
    expect(s.requests[0]!.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await check;

    expect(s.requests[0]!.signal?.aborted).toBe(true);
    expect(store.getState().error).toMatch(/taking longer than usual/i);
    expect(store.getState()).toMatchObject({ status: "submitted" });
    expect(store.getState().attempt).toMatchObject({ state: "submitted", failureReason: null });
    expect(s.count("/submit") + s.count("/prepare")).toBe(0);
    await vi.advanceTimersByTimeAsync(MANUAL_CHECK_COOLDOWN_MS);
    expect(vi.getTimerCount()).toBe(0);
    expect(s.statusLog()).toHaveLength(1); // no automatic resend after a timeout
  });

  it("X/Y. a late success or a late rejection after the timeout is dropped, and nothing becomes an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      for (const late of ["success", "failure"] as const) {
        const s = lab();
        const store = createRealPaymentStore();
        submitted(store);
        const check = store.getState().checkStatus();
        await s.settle();
        await vi.advanceTimersByTimeAsync(STATUS_REQUEST_DEADLINE_MS);
        await check;
        const errorAfterTimeout = store.getState().error;

        if (late === "success") s.requests[0]!.respond("confirmed");
        else s.requests[0]!.fail();
        // Real macrotask turns, so Node gets its chance to report an unhandled rejection.
        vi.useRealTimers();
        await new Promise<void>((resolve) => setTimeout(resolve, 10));

        expect(store.getState().status, late).toBe("submitted");
        expect(store.getState().error).toBe(errorAfterTimeout);
        vi.useRealTimers();
      }
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("Z. a fresh waiter behind a read that times out is released at the deadline and proceeds with exactly one new read", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store);
    const older = store.getState().checkStatus();
    await s.settle();
    await store.getState().resumeAuthorization(); // submitted: the epoch moves on
    const waiter = store.getState().checkSubmittedStatus();
    await s.settle();
    expect(s.requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(STATUS_REQUEST_DEADLINE_MS);
    await older;
    expect(s.requests).toHaveLength(2); // released by the older read's deadline, not by anyone answering it
    s.requests[1]!.respond("confirmed");
    await waiter;
    expect(store.getState().status).toBe("confirmed");
    expect(s.count("/submit")).toBe(1);
  });

  it("no deadline timer survives detach(): the read is aborted and the timers are gone", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    submitted(store);
    const check = store.getState().checkStatus();
    await s.settle();
    store.getState().detach();
    await check;
    expect(s.requests[0]!.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  // ---- freshness ---------------------------------------------------------

  it("AA. an ordinary caller never joins an older-epoch read — it waits, then reads once under the current epoch", async () => {
    const s = lab({ secondsBeforeExpiry: -100 });
    const store = createRealPaymentStore();
    const initializing = store.getState().init(); // an automatic read, in flight
    await s.settle();
    expect(s.requests).toHaveLength(1);
    await store.getState().resumeAuthorization(); // submitted: the epoch moves
    expect(store.getState().status).toBe("submitted");

    const manual = store.getState().checkStatus(); // would have joined (and then lost its answer to) the old read
    await s.settle();
    expect(s.requests).toHaveLength(1);

    s.requests[0]!.respond("awaiting_authorization"); // the stale answer: discarded
    await s.settle();
    expect(store.getState().status).toBe("submitted");
    expect(s.requests).toHaveLength(2);
    s.requests[1]!.respond("confirmed");
    await Promise.all([initializing, manual]);
    expect(store.getState().status).toBe("confirmed");
  });

  it("AB. two waiters behind one older read share ONE current-epoch read — never two", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store);
    const older = store.getState().checkStatus();
    await s.settle();
    await store.getState().resumeAuthorization();
    const first = store.getState().checkSubmittedStatus();
    const second = store.getState().checkSubmittedStatus();
    await s.settle();
    expect(s.requests).toHaveLength(1);

    s.requests[0]!.respond("awaiting_authorization");
    await s.settle();
    expect(s.requests).toHaveLength(2);
    s.requests[1]!.respond("confirmed");
    await Promise.all([older, first, second]);
    expect(s.requests).toHaveLength(2);
    expect(store.getState().status).toBe("confirmed");
  });

  it("AC. an older read that FAILS releases its waiters, which proceed with one new read", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store);
    const older = store.getState().checkStatus();
    await s.settle();
    await store.getState().resumeAuthorization();
    const a = store.getState().checkSubmittedStatus();
    const b = store.getState().checkSubmittedStatus();
    await s.settle();

    s.requests[0]!.fail();
    await s.settle();
    expect(s.requests).toHaveLength(2);
    s.requests[1]!.respond("confirmed");
    await Promise.all([older, a, b]);
    expect(store.getState().status).toBe("confirmed");
  });

  it("AD. an older read that TIMES OUT releases its waiters the same way", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store);
    const older = store.getState().checkStatus();
    await s.settle();
    await store.getState().resumeAuthorization();
    const a = store.getState().checkSubmittedStatus();
    const b = store.getState().checkSubmittedStatus();
    await s.settle();

    await vi.advanceTimersByTimeAsync(STATUS_REQUEST_DEADLINE_MS);
    expect(s.requests).toHaveLength(2);
    s.requests[1]!.respond("confirmed");
    await Promise.all([older, a, b]);
    expect(store.getState().status).toBe("confirmed");
  });

  it("AE. another transition while a waiter is resuming: bounded — a stale read is discarded, the next one decides, and it never cascades", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store);
    const older = store.getState().checkStatus();
    await s.settle();
    await store.getState().resumeAuthorization(); // epoch moves; payment submitted
    const waiter = store.getState().checkSubmittedStatus();
    await s.settle();

    s.requests[0]!.respond("awaiting_authorization");
    await s.settle();
    expect(s.requests).toHaveLength(2); // the waiter's read, under the current epoch

    // Before it answers, a cancel is refused: the epoch moves again.
    const cancelling = store.getState().cancel();
    await s.settle();
    expect(s.requests).toHaveLength(2); // the cancel's read waits behind it; no concurrent third request
    s.requests[1]!.respond("submitted"); // now stale: discarded
    await s.settle();
    expect(s.requests).toHaveLength(3); // the cancel's own read waited for it, then read once
    s.requests[2]!.respond("confirmed");
    await Promise.all([older, waiter, cancelling]);
    await vi.advanceTimersByTimeAsync(24 * HOUR);

    expect(store.getState().status).toBe("confirmed");
    expect(s.requests).toHaveLength(3);
    expect(s.count("/submit")).toBe(1);
  });

  it("AF. terminal answers stay monotonic against a later deferred or settled non-terminal answer", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    submitted(store);
    const first = store.getState().checkStatus();
    await s.settle();
    s.requests[0]!.respond("confirmed");
    await first;
    expect(store.getState().status).toBe("confirmed");

    await vi.advanceTimersByTimeAsync(MANUAL_CHECK_COOLDOWN_MS);
    const second = store.getState().checkStatus();
    await s.settle();
    s.requests[1]!.respond("submitted", deferral(600));
    await second;
    expect(store.getState().status).toBe("confirmed");
    expect(store.getState().attempt?.state).toBe("confirmed");
  });

  // ---- cancellation ------------------------------------------------------

  it("AG. a refused cancel still gets its first reconciliation read — and keeps the refusal visible", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store);
    s.keepPrepared();
    const cancelling = store.getState().cancel();
    await s.settle();
    expect(s.count("/cancel")).toBe(1);
    expect(s.requests).toHaveLength(1);
    s.requests[0]!.respond("submitted");
    await cancelling;
    expect(store.getState()).toMatchObject({ status: "submitted" });
    expect(store.getState().error).toMatch(/could not be cancelled/i);
  });

  it("AH. repeated refused cancels are locally bounded: one read per cooldown window, however fast Cancel is pressed", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store);
    const first = store.getState().cancel();
    await s.settle();
    s.requests[0]!.respond("awaiting_authorization");
    await first;

    for (let i = 0; i < 5; i++) await store.getState().cancel();
    expect(s.count("/cancel")).toBe(6);
    expect(s.statusLog()).toHaveLength(1);
    expect(store.getState().error).toMatch(/could not be cancelled/i);
    expect(store.getState().status).toBe("awaiting_authorization"); // never "cancelled", never failed

    await vi.advanceTimersByTimeAsync(MANUAL_CHECK_COOLDOWN_MS);
    const later = store.getState().cancel();
    await s.settle();
    expect(s.statusLog()).toHaveLength(2);
    s.requests[1]!.respond("awaiting_authorization");
    await later;
  });

  it("AI. a deferred answer to the cancel's read is applied honestly, records the deadline, and a second refusal does not read inside it", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store);
    s.keepPrepared();
    const first = store.getState().cancel();
    await s.settle();
    s.requests[0]!.respond("submitted", deferral(1_200));
    await first;
    expect(store.getState()).toMatchObject({ status: "submitted", isStatusDeferred: true, statusRetryAfterSeconds: 1_200 });
    expect(store.getState().error).toMatch(/could not be cancelled/i);

    // Even after the 30 s cancel window, the server's 1200 s deadline still governs.
    await vi.advanceTimersByTimeAsync(MANUAL_CHECK_COOLDOWN_MS + 1);
    store.setState({ status: "awaiting_authorization", attempt: baseAttempt() });
    await store.getState().cancel();
    expect(s.statusLog()).toHaveLength(1);
    expect(store.getState().status).toBe("awaiting_authorization");
    expect(s.count("/submit") + s.count("/prepare")).toBe(0);
  });
});

/**
 * Stage 2C.3: the post-submit check is for a submission THIS client made or
 * restored — not for a submitted answer a status read just delivered — and a
 * refused cancel's local read window belongs to one account and one attempt.
 */
describe("real-payment-store — 3A-1 Stage 2C.3: redundant submitted read, cancel-read scope", () => {
  const ACCOUNT_A = { appUserId: "app-user-1", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222" };
  const ACCOUNT_B = { appUserId: "app-user-2", ownerAddress: "0x4444444444444444444444444444444444444444", safeAddress: "0x5555555555555555555555555555555555555555" };
  const HOUR = 60 * 60 * 1000;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    useRealAccountStore.setState({ account: null });
  });

  type Req = { url: string; respond: (state: string, extra?: Record<string, unknown>) => void };

  function lab(options: { secondsBeforeExpiry?: number; latestState?: string; latestId?: string } = {}) {
    // Honest-server fixture: the stored row keeps its prepared fields after a transition (toPublicAttempt). A test whose HELD attempt came from awaiting() calls keepPrepared() so its status answers retain them; held attempts built with prepared: null keep the original per-state shape.
    let retainPrepared = false;
    vi.useFakeTimers();
    vi.mocked(signPreparedPayment).mockReset();
    vi.mocked(signPreparedPayment).mockResolvedValue({ signature: "0xsig", activityId: "activity-1" } as never);
    useRealAccountStore.setState({ account: ACCOUNT_A });
    const offset = VALID_UNTIL - (options.secondsBeforeExpiry ?? 1000) - Math.floor(Date.now() / 1000);
    const serverNow = () => Math.floor(Date.now() / 1000) + offset;
    const log: { url: string; method: string }[] = [];
    const requests: Req[] = [];
    let cancelStatus = 409;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        log.push({ url, method });
        if (url.includes("/latest")) {
          const state = options.latestState ?? "awaiting_authorization";
          return jsonResponse(200, {
            attempt: { ...baseAttempt(), id: options.latestId ?? ATTEMPT_ID, state, prepared: state === "awaiting_authorization" ? PREPARED_FIELDS : null },
            // L-2 D-13 honest-fixture correction: the route sends the signing context only for an awaiting_authorization row.
            ...(state === "awaiting_authorization" ? SIGNING_CONTEXT : NO_SIGNING_CONTEXT),
            serverNowSeconds: serverNow(),
          });
        }
        if (url.includes("/submit")) return jsonResponse(200, { attempt: { ...baseAttempt(), state: "submitted", prepared: null } });
        if (url.includes("/cancel")) {
          return cancelStatus === 200 ? jsonResponse(200, { attempt: { ...baseAttempt(), state: "cancelled", prepared: null } }) : jsonResponse(cancelStatus, { error: "wrong_state" });
        }
        if (url.includes("/status")) {
          return new Promise<Response>((resolve) => {
            requests.push({
              url,
              respond: (state, extra = {}) =>
                resolve(
                  jsonResponse(200, {
                    attempt: { ...baseAttempt(), id: url.split("/")[4]!, state, prepared: state === "awaiting_authorization" || retainPrepared ? PREPARED_FIELDS : null },
                    serverNowSeconds: serverNow(),
                    reconciliationDeferred: false,
                    ...extra,
                  }),
                ),
            });
          });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
    return {
      log,
      requests,
      statusCount: () => log.filter((c) => c.url.includes("/status")).length,
      count: (fragment: string) => log.filter((c) => c.url.includes(fragment)).length,
      setCancelStatus: (status: number) => {
        cancelStatus = status;
      },
      keepPrepared: (retain = true) => {
        retainPrepared = retain;
      },
      settle: () => vi.advanceTimersByTimeAsync(0),
    };
  }

  function awaiting(store: ReturnType<typeof createRealPaymentStore>, id = ATTEMPT_ID) {
    store.setState({ attempt: { ...baseAttempt(), id }, status: "awaiting_authorization", subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", clockOffsetSeconds: 0 });
  }

  // ---- LOW-2 -------------------------------------------------------------

  it("A. a LOCAL submit still gets its one post-submit read", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store);
    await store.getState().resumeAuthorization();
    expect(store.getState().status).toBe("submitted");

    const check = store.getState().checkSubmittedStatus();
    await s.settle();
    expect(s.requests).toHaveLength(1);
    s.requests[0]!.respond("confirmed");
    await check;
    expect(store.getState().status).toBe("confirmed");
    expect(s.count("/submit")).toBe(1);
  });

  it("B. a status read that RETURNS submitted does not trigger a second, immediate read", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store);
    s.keepPrepared();
    const manual = store.getState().checkStatus();
    await s.settle();
    s.requests[0]!.respond("submitted");
    await manual;
    expect(store.getState().status).toBe("submitted");

    // What the form's status-change effect does the moment status becomes "submitted".
    await store.getState().checkSubmittedStatus();
    await store.getState().checkSubmittedStatus();
    await s.settle();
    expect(s.statusCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(24 * HOUR); // and no polling loop was started
    expect(s.statusCount()).toBe(1);
  });

  it("B. the same holds when an AUTOMATIC read (expired pre-dispatch attempt) returns submitted, and when the cancel fallback does", async () => {
    const expired = lab({ secondsBeforeExpiry: -100 });
    expired.keepPrepared(); // the held attempt comes from /latest, prepared fields included
    const store = createRealPaymentStore();
    const initializing = store.getState().init();
    await expired.settle();
    expired.requests[0]!.respond("submitted");
    await initializing;
    expect(store.getState().status).toBe("submitted");
    await store.getState().checkSubmittedStatus();
    await expired.settle();
    expect(expired.statusCount()).toBe(1);
    store.getState().detach();
    vi.useRealTimers();

    const refused = lab();
    const second = createRealPaymentStore();
    awaiting(second);
    refused.keepPrepared();
    const cancelling = second.getState().cancel();
    await refused.settle();
    refused.requests[0]!.respond("submitted");
    await cancelling;
    expect(second.getState().status).toBe("submitted");
    await second.getState().checkSubmittedStatus();
    await refused.settle();
    expect(refused.statusCount()).toBe(1);
  });

  it("C. a submitted attempt RESTORED by init() (no read has delivered it) still gets its check", async () => {
    const s = lab({ latestState: "submitted" });
    const store = createRealPaymentStore();
    await store.getState().init();
    expect(store.getState().status).toBe("submitted");
    expect(s.statusCount()).toBe(0);

    const check = store.getState().checkSubmittedStatus();
    await s.settle();
    expect(s.requests).toHaveLength(1);
    s.requests[0]!.respond("submitted");
    await check;
    store.getState().detach();
  });

  it("D. once a submitted attempt has been checked in this lifecycle it is not checked again by the post-submit path — and a new lifecycle starts clean", async () => {
    const s = lab({ latestState: "submitted" });
    const store = createRealPaymentStore();
    await store.getState().init();
    const first = store.getState().checkSubmittedStatus();
    await s.settle();
    s.requests[0]!.respond("submitted");
    await first;

    await store.getState().checkSubmittedStatus();
    await s.settle();
    expect(s.statusCount()).toBe(1);

    // A remount is a new lifecycle: the restored attempt gets its check again.
    store.getState().detach();
    await store.getState().init();
    const again = store.getState().checkSubmittedStatus();
    await s.settle();
    expect(s.statusCount()).toBe(2);
    s.requests[1]!.respond("submitted");
    await again;
    store.getState().detach();
  });

  it("a LATER local transition makes the marker stale: a submit after an earlier 'submitted' read is checked again", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store);
    s.keepPrepared();
    const manual = store.getState().checkStatus();
    await s.settle();
    s.requests[0]!.respond("submitted");
    await manual;
    await store.getState().checkSubmittedStatus();
    expect(s.statusCount()).toBe(1);

    awaiting(store); // the attempt is back to awaiting approval locally and is submitted again
    await store.getState().resumeAuthorization();
    expect(store.getState().status).toBe("submitted");
    const check = store.getState().checkSubmittedStatus();
    await s.settle();
    expect(s.statusCount()).toBe(2);
    s.keepPrepared(false); // the held attempt is now the lab's submit answer, built with prepared: null
    s.requests[1]!.respond("confirmed");
    await check;
  });

  it("an active server retry deadline is still respected: a restored submitted attempt is not read inside it", async () => {
    const s = lab({ latestState: "submitted" });
    const store = createRealPaymentStore();
    await store.getState().init();
    const first = store.getState().checkSubmittedStatus();
    await s.settle();
    s.requests[0]!.respond("submitted", { reconciliationDeferred: true, retryAfterSeconds: 1_800 });
    await first;
    store.getState().detach();

    await store.getState().init(); // remount: restored submitted, deadline still running
    await store.getState().checkSubmittedStatus();
    await s.settle();
    expect(s.statusCount()).toBe(1);
    store.getState().detach();
  });

  // ---- cancel-read scope -------------------------------------------------

  it("repeated refused cancels on ONE attempt stay locally bounded", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store);
    const first = store.getState().cancel();
    await s.settle();
    s.requests[0]!.respond("awaiting_authorization");
    await first;
    for (let i = 0; i < 4; i++) await store.getState().cancel();
    expect(s.count("/cancel")).toBe(5);
    expect(s.statusCount()).toBe(1);
  });

  it("a DIFFERENT attempt does not inherit the previous attempt's cancel-read window", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store, ATTEMPT_ID);
    const first = store.getState().cancel();
    await s.settle();
    s.requests[0]!.respond("awaiting_authorization");
    await first;

    awaiting(store, ATTEMPT_ID_2); // what prepare leaves behind
    const second = store.getState().cancel();
    await s.settle();
    expect(s.requests.map((r) => r.url)).toEqual([`/api/real/payments/${ATTEMPT_ID}/status`, `/api/real/payments/${ATTEMPT_ID_2}/status`]);
    s.requests[1]!.respond("awaiting_authorization");
    await second;
  });

  it("the reachable path: a refused cancel, then a successful cancel, then a new attempt's refused cancel — the new one gets its read", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store, ATTEMPT_ID);
    const refused = store.getState().cancel();
    await s.settle();
    s.requests[0]!.respond("awaiting_authorization");
    await refused;

    s.setCancelStatus(200);
    await store.getState().cancel();
    expect(store.getState().attempt).toBeNull();

    s.setCancelStatus(409);
    awaiting(store, ATTEMPT_ID_2);
    const next = store.getState().cancel();
    await s.settle();
    expect(s.statusCount()).toBe(2);
    s.requests[1]!.respond("awaiting_authorization");
    await next;
  });

  it("another ACCOUNT does not share the window, even for the same attempt id", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store);
    const first = store.getState().cancel();
    await s.settle();
    s.requests[0]!.respond("awaiting_authorization");
    await first;

    useRealAccountStore.setState({ account: ACCOUNT_B });
    awaiting(store);
    const second = store.getState().cancel();
    await s.settle();
    expect(s.statusCount()).toBe(2);
    s.requests[1]!.respond("awaiting_authorization");
    await second;
  });

  it("a server-imposed deadline stays authoritative over the local window, for its own attempt only", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store, ATTEMPT_ID);
    const first = store.getState().cancel();
    await s.settle();
    s.requests[0]!.respond("submitted", { reconciliationDeferred: true, retryAfterSeconds: 3_600 });
    await first;

    await vi.advanceTimersByTimeAsync(MANUAL_CHECK_COOLDOWN_MS + 1); // the local window is over; the server's is not
    awaiting(store, ATTEMPT_ID);
    await store.getState().cancel();
    expect(s.statusCount()).toBe(1);
    expect(store.getState().status).toBe("awaiting_authorization"); // refusal reported; nothing invented

    awaiting(store, ATTEMPT_ID_2); // another attempt is not governed by it
    const other = store.getState().cancel();
    await s.settle();
    expect(s.statusCount()).toBe(2);
    s.requests[1]!.respond("awaiting_authorization");
    await other;
    expect(s.count("/submit") + s.count("/prepare")).toBe(0);
  });
});

/**
 * 3A-1 closeout: a server delay can never SHORTEN the manual cooldown (L-1),
 * a repeated refused cancel can never discard the read its first refusal
 * started (L-2), and the remaining client gaps the audits named.
 */
describe("real-payment-store — 3A-1 closeout: cooldown floor, cancel-read continuity, edge cases", () => {
  const ACCOUNT_A = { appUserId: "app-user-1", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222" };
  const ACCOUNT_B = { appUserId: "app-user-2", ownerAddress: "0x4444444444444444444444444444444444444444", safeAddress: "0x5555555555555555555555555555555555555555" };
  const HOUR = 60 * 60 * 1000;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    useRealAccountStore.setState({ account: null });
  });

  type Req = { url: string; respond: (state: string, extra?: Record<string, unknown>) => void; fail: () => void };

  /** `statusDelayMs`: every /status answers itself after that long (registered AFTER the client's own deadline timer). */
  function lab(options: { secondsBeforeExpiry?: number; latestId?: string; latestState?: string; statusDelayMs?: number; statusState?: string } = {}) {
    // Honest-server fixture: the stored row keeps its prepared fields after a transition (toPublicAttempt). A test whose HELD attempt came from awaiting() calls keepPrepared() so its status answers retain them; held attempts built with prepared: null keep the original per-state shape.
    let retainPrepared = false;
    vi.useFakeTimers();
    vi.mocked(signPreparedPayment).mockReset();
    vi.mocked(signPreparedPayment).mockResolvedValue({ signature: "0xsig", activityId: "activity-1" } as never);
    useRealAccountStore.setState({ account: ACCOUNT_A });
    const offset = VALID_UNTIL - (options.secondsBeforeExpiry ?? 1000) - Math.floor(Date.now() / 1000);
    const serverNow = () => Math.floor(Date.now() / 1000) + offset;
    const log: { url: string; method: string }[] = [];
    const requests: Req[] = [];
    let latestId = options.latestId ?? ATTEMPT_ID;
    const body = (url: string, state: string, extra: Record<string, unknown> = {}) =>
      jsonResponse(200, {
        attempt: { ...baseAttempt(), id: url.split("/")[4]!, state, prepared: state === "awaiting_authorization" || retainPrepared ? PREPARED_FIELDS : null },
        serverNowSeconds: serverNow(),
        reconciliationDeferred: false,
        ...extra,
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        log.push({ url, method });
        if (url.includes("/latest")) {
          const state = options.latestState ?? "awaiting_authorization";
          return jsonResponse(200, {
            attempt: { ...baseAttempt(), id: latestId, state, prepared: state === "awaiting_authorization" ? PREPARED_FIELDS : null },
            // L-2 D-13 honest-fixture correction: the route sends the signing context only for an awaiting_authorization row.
            ...(state === "awaiting_authorization" ? SIGNING_CONTEXT : NO_SIGNING_CONTEXT),
            serverNowSeconds: serverNow(),
          });
        }
        if (url.includes("/submit")) return jsonResponse(200, { attempt: { ...baseAttempt(), state: "submitted", prepared: null } });
        if (url.includes("/cancel")) return jsonResponse(409, { error: "wrong_state" });
        if (url.includes("/status")) {
          if (options.statusDelayMs !== undefined) {
            return new Promise<Response>((resolve) => setTimeout(() => resolve(body(url, options.statusState ?? "awaiting_authorization")), options.statusDelayMs));
          }
          return new Promise<Response>((resolve, reject) => {
            requests.push({ url, respond: (state, extra) => resolve(body(url, state, extra)), fail: () => reject(new TypeError("Failed to fetch")) });
          });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
    return {
      log,
      requests,
      statusCount: () => log.filter((c) => c.url.includes("/status")).length,
      count: (fragment: string) => log.filter((c) => c.url.includes(fragment)).length,
      setLatestId: (id: string) => {
        latestId = id;
      },
      keepPrepared: (retain = true) => {
        retainPrepared = retain;
      },
      settle: () => vi.advanceTimersByTimeAsync(0),
    };
  }

  function awaiting(store: ReturnType<typeof createRealPaymentStore>, id = ATTEMPT_ID) {
    store.setState({ attempt: { ...baseAttempt(), id }, status: "awaiting_authorization", subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", clockOffsetSeconds: 0 });
  }

  const submittedState = (store: ReturnType<typeof createRealPaymentStore>) =>
    store.setState({ attempt: { ...baseAttempt(), state: "submitted", prepared: null }, status: "submitted", clockOffsetSeconds: 0 });

  const deferral = (seconds: number) => ({ reconciliationDeferred: true, retryAfterSeconds: seconds });

  // ---- L-1: the cooldown is a floor ----------------------------------------

  it("L-1: a 2 s server delay cannot shorten the 30 s manual cooldown — exact boundary, repeated presses, nothing sent early", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    submittedState(store);
    const check = store.getState().checkStatus(); // starts the ordinary 30 s cooldown
    await s.settle();
    s.requests[0]!.respond("submitted", deferral(2));
    await check;
    expect(store.getState()).toMatchObject({ isManualCheckCoolingDown: true, isStatusDeferred: true, statusRetryAfterSeconds: 2 });

    await vi.advanceTimersByTimeAsync(2_000); // the server's own delay has passed
    expect(store.getState().isManualCheckCoolingDown).toBe(true);
    for (let i = 0; i < 5; i++) await store.getState().checkStatus();
    await vi.advanceTimersByTimeAsync(MANUAL_CHECK_COOLDOWN_MS - 2_000 - 1);
    expect(store.getState().isManualCheckCoolingDown).toBe(true);
    for (let i = 0; i < 5; i++) await store.getState().checkStatus();
    expect(s.statusCount()).toBe(1);
    expect(vi.getTimerCount()).toBe(1); // one cooldown timer — no recurring timer

    await vi.advanceTimersByTimeAsync(1); // t = 30 000 ms exactly
    expect(store.getState()).toMatchObject({ isManualCheckCoolingDown: false, isStatusDeferred: false });
    expect(vi.getTimerCount()).toBe(0);
    const again = store.getState().checkStatus();
    await s.settle();
    expect(s.statusCount()).toBe(2);
    s.requests[1]!.respond("confirmed");
    await again;
    expect(store.getState().status).toBe("confirmed");
    expect(s.count("/submit") + s.count("/prepare")).toBe(0);
  });

  it("L-1: a 600 s server delay is never cut to 30 s; a 30 s-or-shorter one leaves the ordinary cooldown untouched", async () => {
    for (const [seconds, ms] of [[600, 600_000], [30, 30_000], [29, 30_000], [1, 30_000]] as const) {
      const s = lab();
      const store = createRealPaymentStore();
      submittedState(store);
      const check = store.getState().checkStatus();
      await s.settle();
      s.requests[0]!.respond("submitted", deferral(seconds));
      await check;

      await vi.advanceTimersByTimeAsync(ms - 1);
      expect(store.getState().isManualCheckCoolingDown, `${seconds}s @ ${ms - 1}`).toBe(true);
      await store.getState().checkStatus();
      expect(s.statusCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(store.getState().isManualCheckCoolingDown, `${seconds}s @ ${ms}`).toBe(false);
      store.getState().detach();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    }
  });

  it("L-1: another account or attempt is not held by it — init() is a new lifecycle with no inherited cooldown", async () => {
    const s = lab({ secondsBeforeExpiry: -100 });
    const store = createRealPaymentStore();
    const first = store.getState().init();
    await s.settle();
    s.requests[0]!.respond("awaiting_authorization", deferral(2));
    await first;
    store.getState().detach();

    useRealAccountStore.setState({ account: ACCOUNT_B });
    const second = store.getState().init();
    await s.settle();
    expect(store.getState().isManualCheckCoolingDown).toBe(false);
    expect(s.statusCount()).toBe(2);
    s.requests[1]!.respond("awaiting_authorization");
    await second;
    store.getState().detach();

    useRealAccountStore.setState({ account: ACCOUNT_A });
    s.setLatestId(ATTEMPT_ID_2);
    const third = store.getState().init();
    await s.settle();
    expect(s.requests[2]!.url).toBe(`/api/real/payments/${ATTEMPT_ID_2}/status`);
    s.requests[2]!.respond("awaiting_authorization");
    await third;
    store.getState().detach();
  });

  // ---- L-2: a repeated refused cancel keeps the useful read ----------------

  it("L-2: a second refusal inside the window does not discard the first refusal's read — its answer updates the payment", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store);
    s.keepPrepared();
    const first = store.getState().cancel(); // refused -> one reconciliation read, in flight
    await s.settle();
    expect(s.requests).toHaveLength(1);

    await store.getState().cancel(); // refused again, inside the 30 s window
    await store.getState().cancel();
    expect(s.requests).toHaveLength(1);
    expect(s.count("/cancel")).toBe(3);

    s.requests[0]!.respond("submitted");
    await first;
    expect(store.getState()).toMatchObject({ status: "submitted" });
    expect(store.getState().attempt?.state).toBe("submitted");
    expect(store.getState().error).toMatch(/could not be cancelled/i);
    expect(s.statusCount()).toBe(1); // no second provider-bound read
    expect(s.count("/submit") + s.count("/prepare")).toBe(0);
  });

  it("L-2: a genuine state transition still invalidates that read — the stale 'awaiting' answer is dropped", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store);
    const refused = store.getState().cancel();
    await s.settle();
    expect(s.requests).toHaveLength(1);

    await store.getState().resumeAuthorization(); // the payment is submitted: the epoch moves
    expect(store.getState().status).toBe("submitted");
    s.requests[0]!.respond("awaiting_authorization");
    await s.settle();
    await refused;
    expect(store.getState().status).toBe("submitted");
    expect(store.getState().attempt?.state).toBe("submitted");
    expect(s.count("/submit")).toBe(1);
  });

  it("L-2: the first refusal after a window ends (or for another attempt) still invalidates and reads afresh", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store, ATTEMPT_ID);
    const first = store.getState().cancel();
    await s.settle();
    s.requests[0]!.respond("awaiting_authorization");
    await first;

    await vi.advanceTimersByTimeAsync(MANUAL_CHECK_COOLDOWN_MS);
    const later = store.getState().cancel();
    await s.settle();
    expect(s.statusCount()).toBe(2);
    s.requests[1]!.respond("awaiting_authorization");
    await later;

    awaiting(store, ATTEMPT_ID_2);
    const other = store.getState().cancel();
    await s.settle();
    expect(s.statusCount()).toBe(3);
    s.requests[2]!.respond("awaiting_authorization");
    await other;
  });

  // ---- remaining client gaps -----------------------------------------------

  it("four or more waiters behind one older read share ONE current-epoch read", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store);
    const older = store.getState().checkStatus();
    await s.settle();
    await store.getState().resumeAuthorization();
    const waiters = [1, 2, 3, 4, 5].map(() => store.getState().checkSubmittedStatus());
    await s.settle();
    expect(s.requests).toHaveLength(1);

    s.requests[0]!.respond("awaiting_authorization");
    await s.settle();
    expect(s.requests).toHaveLength(2);
    s.requests[1]!.respond("confirmed");
    await Promise.all([older, ...waiters]);
    expect(s.requests).toHaveLength(2);
    expect(store.getState().status).toBe("confirmed");
    expect(s.count("/submit")).toBe(1);
  });

  it("the 45 s tie: the client's deadline is registered first, so at exactly 45 000 ms the read is abandoned and its answer dropped; at 44 999 ms the answer wins", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const tie = lab({ statusDelayMs: STATUS_REQUEST_DEADLINE_MS, statusState: "confirmed" });
      const store = createRealPaymentStore();
      submittedState(store);
      const check = store.getState().checkStatus();
      await vi.advanceTimersByTimeAsync(STATUS_REQUEST_DEADLINE_MS);
      await check;
      expect(store.getState().status).toBe("submitted"); // not confirmed: the late answer was dropped
      expect(store.getState().error).toMatch(/taking longer than usual/i);
      expect(tie.count("/submit") + tie.count("/prepare")).toBe(0);
      vi.useRealTimers();

      const beat = lab({ statusDelayMs: STATUS_REQUEST_DEADLINE_MS - 1, statusState: "confirmed" });
      const second = createRealPaymentStore();
      submittedState(second);
      const win = second.getState().checkStatus();
      await vi.advanceTimersByTimeAsync(STATUS_REQUEST_DEADLINE_MS);
      await win;
      expect(second.getState().status).toBe("confirmed");
      expect(second.getState().error).toBeNull();
      expect(beat.statusCount()).toBe(1);

      vi.useRealTimers();
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a stale old-epoch 'submitted' answer is discarded and does NOT stand in for the post-submit read after a local submit", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store);
    const older = store.getState().checkStatus(); // begun before the submit
    await s.settle();
    await store.getState().resumeAuthorization(); // local submit: epoch moves
    s.requests[0]!.respond("submitted"); // the old read says "submitted" too — but it predates the submit
    await s.settle();
    await older;

    const check = store.getState().checkSubmittedStatus(); // must still read
    await s.settle();
    expect(s.requests).toHaveLength(2);
    s.requests[1]!.respond("confirmed");
    await check;
    expect(store.getState().status).toBe("confirmed");
    expect(s.count("/submit")).toBe(1);
  });

  it("account isolation under waiting: a switch while waiters are queued drops them all — no read for the old account", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store);
    const older = store.getState().checkStatus();
    await s.settle();
    await store.getState().resumeAuthorization();
    const waiters = [1, 2, 3].map(() => store.getState().checkSubmittedStatus());
    await s.settle();

    useRealAccountStore.setState({ account: ACCOUNT_B });
    s.requests[0]!.respond("awaiting_authorization");
    await s.settle();
    await Promise.all([older, ...waiters]);
    expect(s.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(s.requests).toHaveLength(1);
  });
});

/**
 * 3A-2 Stage 2: the client side of the server's per-account SUBMIT budget
 * (HTTP 429, code "rate_limited", retryable true, Retry-After), and isolation of
 * every submit/signing answer from a context that has since been replaced. A
 * budget denial is decided before any provider work: nothing was sent and
 * nothing changed. Everything here is a fake server on fake timers — no network,
 * no Turnkey, no bundler.
 */
describe("real-payment-store — 3A-2 Stage 2: submit cooldown and submit-response isolation", () => {
  const ACCOUNT_A = { appUserId: "app-user-1", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222" };
  const ACCOUNT_B = { appUserId: "app-user-2", ownerAddress: "0x4444444444444444444444444444444444444444", safeAddress: "0x5555555555555555555555555555555555555555" };
  const T0_MS = 1_800_000_000_000; // a whole second, so boundary arithmetic is exact
  const HOUR = 60 * 60 * 1000;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    useRealAccountStore.setState({ account: null });
  });

  const denial = (retryAfter: string | null | undefined, body: Record<string, unknown> = { error: "Too many tries right now. Wait a moment, then tap Continue.", code: "rate_limited", retryable: true }) =>
    new Response(JSON.stringify(body), { status: 429, headers: { "content-type": "application/json", ...(retryAfter === null || retryAfter === undefined ? {} : { "Retry-After": retryAfter }) } });
  const submittedBody = () => jsonResponse(200, { attempt: { ...baseAttempt(), state: "submitted", prepared: null } });

  type HeldSubmit = { body: { attemptId: string; signature: string; activityId: string }; respond: (response: Response) => void; fail: () => void };

  function lab(options: { secondsBeforeExpiry?: number; latestId?: string; latestState?: string; statusState?: string } = {}) {
    // Honest-server fixture: the stored row keeps its prepared fields after a transition (toPublicAttempt). A test whose HELD attempt came from awaiting() calls keepPrepared() so its status answers retain them; held attempts built with prepared: null keep the original per-state shape.
    let retainPrepared = false;
    vi.useFakeTimers();
    vi.setSystemTime(T0_MS);
    vi.mocked(signPreparedPayment).mockReset();
    vi.mocked(signPreparedPayment).mockResolvedValue({ signature: "0xsig", activityId: "activity-1" } as never);
    useRealAccountStore.setState({ account: ACCOUNT_A });
    const offset = VALID_UNTIL - (options.secondsBeforeExpiry ?? 1000) - Math.floor(T0_MS / 1000);
    const serverNow = () => Math.floor(Date.now() / 1000) + offset;
    const log: { url: string; method: string; body: unknown; at: number }[] = [];
    const script: Array<Response | "hold"> = [];
    const held: HeldSubmit[] = [];
    let latestId = options.latestId ?? ATTEMPT_ID;
    let statusState = options.statusState ?? "awaiting_authorization";
    let cancelOk = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? (JSON.parse(init.body as string) as unknown) : undefined;
        log.push({ url, method, body, at: Date.now() });
        if (url.includes("/latest")) {
          const state = options.latestState ?? "awaiting_authorization";
          return jsonResponse(200, {
            attempt: { ...baseAttempt(), id: latestId, state, prepared: state === "awaiting_authorization" ? PREPARED_FIELDS : null },
            // L-2 D-13 honest-fixture correction: the route sends the signing context only for an awaiting_authorization row.
            ...(state === "awaiting_authorization" ? SIGNING_CONTEXT : NO_SIGNING_CONTEXT),
            serverNowSeconds: serverNow(),
          });
        }
        if (url.includes("/submit")) {
          const next = script.shift() ?? submittedBody();
          if (next !== "hold") return next;
          return new Promise<Response>((resolve, reject) => {
            held.push({ body: body as HeldSubmit["body"], respond: resolve, fail: () => reject(new TypeError("Failed to fetch")) });
          });
        }
        if (url.includes("/cancel")) return cancelOk ? jsonResponse(200, { attempt: { ...baseAttempt(), state: "cancelled", prepared: null } }) : jsonResponse(409, { error: "wrong_state" });
        if (url.includes("/status")) {
          return jsonResponse(200, {
            attempt: { ...baseAttempt(), id: url.split("/")[4]!, state: statusState, prepared: statusState === "awaiting_authorization" || retainPrepared ? PREPARED_FIELDS : null },
            serverNowSeconds: serverNow(),
            reconciliationDeferred: false,
          });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
    return {
      log,
      held,
      offset,
      script: (...steps: Array<Response | "hold">) => script.push(...steps),
      count: (fragment: string) => log.filter((c) => c.url.includes(fragment)).length,
      submits: () => log.filter((c) => c.url.includes("/submit")),
      setLatestId: (id: string) => {
        latestId = id;
      },
      setStatusState: (state: string) => {
        statusState = state;
      },
      setCancelOk: (ok: boolean) => {
        cancelOk = ok;
      },
      keepPrepared: (retain = true) => {
        retainPrepared = retain;
      },
      settle: () => vi.advanceTimersByTimeAsync(0),
    };
  }

  function awaiting(store: ReturnType<typeof createRealPaymentStore>, offset: number, id = ATTEMPT_ID) {
    store.setState({ attempt: { ...baseAttempt(), id }, status: "awaiting_authorization", subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", clockOffsetSeconds: offset });
  }

  /** One Continue that ends in a 429 with the given Retry-After; returns the store, awaiting. */
  async function denied(retryAfter: string | null | undefined, secondsBeforeExpiry = 100_000) {
    const s = lab({ secondsBeforeExpiry });
    const store = createRealPaymentStore();
    awaiting(store, s.offset);
    s.script(denial(retryAfter));
    await store.getState().resumeAuthorization();
    return { s, store };
  }

  // ---- the header --------------------------------------------------------

  it("parseSubmitRetryAfter: whole seconds 1…86400 as plain digits only; everything else is null", () => {
    for (const [header, seconds] of [["1", 1], ["120", 120], ["86400", 86_400], ["59", 59]] as const) expect(parseSubmitRetryAfter(header), header).toBe(seconds);
    for (const bad of [null, undefined, "", " ", "0", "-1", "+5", "1.5", "1e2", "NaN", "Infinity", "-Infinity", "86401", "99999", "100000", "007", "0120", " 30", "30 ", "30s", "abc", "Wed, 21 Oct 2026 07:28:00 GMT", "1,2", "٣٠", String(2 ** 53)]) {
      expect(parseSubmitRetryAfter(bad as string | null), String(bad)).toBeNull();
    }
  });

  // ---- a valid denial ----------------------------------------------------

  it("1. a valid 429 (rate_limited, retryable, Retry-After 120) keeps the payment awaiting approval, keeps the approval, and starts a 120 s wait", async () => {
    const { s, store } = await denied("120");

    expect(store.getState()).toMatchObject({
      status: "awaiting_authorization",
      isSubmitCoolingDown: true,
      submitCooldownSeconds: 120,
      isSubmitRetryBeyondApproval: false,
      isAuthorizing: false,
      error: null,
      pendingSubmission: { attemptId: ATTEMPT_ID, signature: "0xsig", activityId: "activity-1" },
    });
    expect(store.getState().attempt).toMatchObject({ id: ATTEMPT_ID, state: "awaiting_authorization", failureReason: null });
    expect(s.submits()).toHaveLength(1);
    expect(s.count("/cancel")).toBe(0);
    store.getState().detach();
  });

  it("2. rapid Continue presses during the wait send nothing and open no passkey prompt", async () => {
    const { s, store } = await denied("120");
    const signs = vi.mocked(signPreparedPayment).mock.calls.length;

    await Promise.all([1, 2, 3, 4, 5].map(() => store.getState().resumeAuthorization()));
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all([1, 2, 3].map(() => store.getState().resumeAuthorization()));

    expect(s.submits()).toHaveLength(1);
    expect(vi.mocked(signPreparedPayment).mock.calls.length).toBe(signs);
    store.getState().detach();
  });

  it("3/4/5. one millisecond before the end nothing is sent; the end only re-enables Continue; one explicit press re-sends the SAME approval", async () => {
    const { s, store } = await denied("120");

    await vi.advanceTimersByTimeAsync(119_999);
    await store.getState().resumeAuthorization();
    expect(s.submits()).toHaveLength(1);
    expect(store.getState().isSubmitCoolingDown).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    // Timer expiry: the control is eligible again — and NOTHING was sent or signed by itself.
    expect(store.getState().isSubmitCoolingDown).toBe(false);
    expect(s.submits()).toHaveLength(1);
    expect(vi.mocked(signPreparedPayment)).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.submits()).toHaveLength(1);

    await store.getState().resumeAuthorization();
    expect(s.submits()).toHaveLength(2);
    expect(s.submits()[1]!.body).toEqual({ attemptId: ATTEMPT_ID, signature: "0xsig", activityId: "activity-1" });
    expect(vi.mocked(signPreparedPayment)).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({ status: "submitted", pendingSubmission: null });
    store.getState().detach();
  });

  it("6. a missing or unusable Retry-After is a 60 s local wait — never an immediate retry", async () => {
    for (const header of [undefined, null, "", "0", "-5", "1.5", "NaN", "Infinity", "Wed, 21 Oct 2026 07:28:00 GMT", "soon", "86401", "0120", "12s"]) {
      const { s, store } = await denied(header);
      expect(store.getState(), String(header)).toMatchObject({ isSubmitCoolingDown: true, submitCooldownSeconds: 60, status: "awaiting_authorization" });

      await vi.advanceTimersByTimeAsync(59_999);
      await store.getState().resumeAuthorization();
      expect(s.submits(), String(header)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(store.getState().isSubmitCoolingDown).toBe(false);
      store.getState().detach();
      vi.useRealTimers();
    }
  });

  it("7. the maximum Retry-After (86400 s) is honored exactly: no early retry, one after", async () => {
    const { s, store } = await denied("86400");
    expect(store.getState().submitCooldownSeconds).toBe(86_400);

    await vi.advanceTimersByTimeAsync(86_399_999);
    await store.getState().resumeAuthorization();
    expect(s.submits()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getState().isSubmitCoolingDown).toBe(false);
    await store.getState().resumeAuthorization();
    expect(s.submits()).toHaveLength(2);
    store.getState().detach();
  });

  // ---- remount, account, attempt ----------------------------------------

  it("8. a remount for the same account and attempt keeps the wait; Continue is refused before any signing; a new approval is needed only after it", async () => {
    const { s, store } = await denied("120");
    await vi.advanceTimersByTimeAsync(20_000);

    store.getState().detach();
    await store.getState().init(); // the Pay form mounts again
    expect(store.getState()).toMatchObject({ status: "awaiting_authorization", isSubmitCoolingDown: true, submitCooldownSeconds: 100, pendingSubmission: null });

    await store.getState().resumeAuthorization();
    expect(vi.mocked(signPreparedPayment)).toHaveBeenCalledTimes(1); // no new passkey prompt
    expect(s.submits()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(100_000);
    expect(store.getState().isSubmitCoolingDown).toBe(false);
    expect(vi.mocked(signPreparedPayment)).toHaveBeenCalledTimes(1);
    expect(s.submits()).toHaveLength(1);

    // The discarded signature is not promised back: the user approves again.
    await store.getState().resumeAuthorization();
    expect(vi.mocked(signPreparedPayment)).toHaveBeenCalledTimes(2);
    expect(s.submits()).toHaveLength(2);
    store.getState().detach();
  });

  it("8. a Strict-Mode style mount/cleanup/mount keeps the wait too", async () => {
    const { s, store } = await denied("300");
    store.getState().detach();
    void store.getState().init();
    store.getState().detach();
    await store.getState().init();

    expect(store.getState().isSubmitCoolingDown).toBe(true);
    await store.getState().resumeAuthorization();
    expect(s.submits()).toHaveLength(1);
    expect(vi.mocked(signPreparedPayment)).toHaveBeenCalledTimes(1);
    store.getState().detach();
  });

  it("9. reset() clears the wait; another account does not inherit it, even for an attempt with the same id", async () => {
    const { s, store } = await denied("600");

    store.getState().reset();
    expect(store.getState()).toMatchObject({ isSubmitCoolingDown: false, submitCooldownSeconds: null, isSubmitRetryBeyondApproval: false });

    useRealAccountStore.setState({ account: ACCOUNT_B });
    await store.getState().init();
    expect(store.getState().isSubmitCoolingDown).toBe(false);
    await store.getState().resumeAuthorization();
    expect(s.submits()).toHaveLength(2); // account B's own first Continue went out
    store.getState().detach();
  });

  it("9. an account switch WITHOUT a reset still does not inherit the wait (the deadline is bound to the account)", async () => {
    const { s, store } = await denied("600");
    store.getState().detach();

    useRealAccountStore.setState({ account: ACCOUNT_B });
    await store.getState().init();

    expect(store.getState().isSubmitCoolingDown).toBe(false);
    await store.getState().resumeAuthorization();
    expect(s.submits()).toHaveLength(2);
    store.getState().detach();
  });

  it("10. a different attempt inherits nothing", async () => {
    const { s, store } = await denied("600");
    store.getState().detach();

    s.setLatestId(ATTEMPT_ID_2);
    await store.getState().init();
    expect(store.getState().attempt?.id).toBe(ATTEMPT_ID_2);
    expect(store.getState().isSubmitCoolingDown).toBe(false);

    await store.getState().resumeAuthorization();
    expect(s.submits().at(-1)!.body).toMatchObject({ attemptId: ATTEMPT_ID_2 });
    expect(s.submits()).toHaveLength(2);
    store.getState().detach();
  });

  it("a successful cancel drops the wait; a refused one leaves it (and the payment) alone", async () => {
    const { s, store } = await denied("600");
    s.setCancelOk(false);
    await store.getState().cancel();
    expect(store.getState().isSubmitCoolingDown).toBe(true);
    expect(store.getState().attempt?.id).toBe(ATTEMPT_ID);

    s.setCancelOk(true);
    await store.getState().cancel();
    expect(store.getState()).toMatchObject({ status: "editing", attempt: null, isSubmitCoolingDown: false, submitCooldownSeconds: null });
    store.getState().detach();
  });

  it("detach() leaves no timer behind and a later deadline passing changes nothing", async () => {
    const { s, store } = await denied("120");
    store.getState().detach();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(s.submits()).toHaveLength(1);
    expect(vi.mocked(signPreparedPayment)).toHaveBeenCalledTimes(1);
    expect(store.getState().status).toBe("awaiting_authorization");
  });

  // ---- late answers ------------------------------------------------------

  it("11/A/B/C/D. a submit answer — success, 429, retryable or unknown — arriving after the account changed touches nothing of the new context", async () => {
    const answers: Array<{ name: string; settle: (h: HeldSubmit) => void }> = [
      { name: "success", settle: (h) => h.respond(submittedBody()) },
      { name: "429", settle: (h) => h.respond(denial("900")) },
      { name: "retryable 503", settle: (h) => h.respond(jsonResponse(503, { error: "We couldn't confirm your passkey approval yet. Try again in a moment.", retryable: true })) },
      { name: "network failure", settle: (h) => h.fail() },
      { name: "generic 500", settle: (h) => h.respond(jsonResponse(500, { error: "Something went wrong. Please try again." })) },
    ];
    for (const answer of answers) {
      const s = lab();
      const store = createRealPaymentStore();
      awaiting(store, s.offset);
      s.script("hold");
      const sending = store.getState().resumeAuthorization();
      await s.settle();
      expect(s.held).toHaveLength(1);

      // The account changes; the new account has its own payment awaiting approval.
      useRealAccountStore.setState({ account: ACCOUNT_B });
      store.getState().reset();
      s.setLatestId(ACCOUNT_B_ATTEMPT_ID);
      await store.getState().init();
      const before = store.getState();
      const snapshot = { status: before.status, attempt: before.attempt, error: before.error, pendingSubmission: before.pendingSubmission, cooling: before.isSubmitCoolingDown };

      answer.settle(s.held[0]!);
      await sending;
      await s.settle();

      const after = store.getState();
      expect({ status: after.status, attempt: after.attempt, error: after.error, pendingSubmission: after.pendingSubmission, cooling: after.isSubmitCoolingDown }, answer.name).toEqual(snapshot);
      expect(after.attempt?.id).toBe(ACCOUNT_B_ATTEMPT_ID);
      // B's payment is still free to be continued: the stale answer started no wait for it.
      s.script(submittedBody());
      await store.getState().resumeAuthorization();
      expect(s.submits().at(-1)!.body).toMatchObject({ attemptId: ACCOUNT_B_ATTEMPT_ID });
      store.getState().detach();
      vi.useRealTimers();
    }
  });

  it("12/I. an answer from a previous mount of the SAME attempt is dropped too — it neither applies nor suppresses the newer outcome", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store, s.offset);
    s.script("hold");
    const first = store.getState().resumeAuthorization();
    await s.settle();

    store.getState().detach();
    await store.getState().init(); // remount: the old handler's lifecycle is over
    s.script(submittedBody());
    await store.getState().resumeAuthorization(); // a new approval and a new submit: submitted
    expect(store.getState().status).toBe("submitted");
    const settled = { status: store.getState().status, attempt: store.getState().attempt };

    s.held[0]!.respond(denial("900")); // the old request's 429, now far too late
    await first;
    await s.settle();

    expect(store.getState().status).toBe(settled.status);
    expect(store.getState().attempt).toEqual(settled.attempt);
    expect(store.getState().isSubmitCoolingDown).toBe(false);
    store.getState().detach();
  });

  it("12. a late success after a remount does not overwrite what the new lifecycle read", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store, s.offset);
    s.script("hold");
    const first = store.getState().resumeAuthorization();
    await s.settle();
    store.getState().detach();
    s.setStatusState("awaiting_authorization");
    await store.getState().init();
    const before = store.getState().attempt;

    s.held[0]!.respond(jsonResponse(200, { attempt: { ...baseAttempt(), state: "confirmed", prepared: null } }));
    await first;

    expect(store.getState().attempt).toEqual(before);
    expect(store.getState().status).toBe("awaiting_authorization");
    store.getState().detach();
  });

  it("13/E. a passkey ceremony that finishes after reset, detach/remount, or the attempt being replaced starts no submit and keeps no signature", async () => {
    const ways: Array<{ name: string; end: (store: ReturnType<typeof createRealPaymentStore>, s: ReturnType<typeof lab>) => Promise<void> }> = [
      { name: "reset", end: async (store) => store.getState().reset() },
      {
        name: "detach and remount",
        end: async (store) => {
          store.getState().detach();
          await store.getState().init();
        },
      },
      {
        name: "attempt replaced",
        end: async (store, s) => {
          awaiting(store, s.offset, ATTEMPT_ID_2);
        },
      },
      {
        name: "account switched",
        end: async () => {
          useRealAccountStore.setState({ account: ACCOUNT_B });
        },
      },
    ];
    for (const way of ways) {
      const s = lab();
      let finish: (value: { signature: string; activityId: string }) => void = () => {};
      vi.mocked(signPreparedPayment).mockReset();
      vi.mocked(signPreparedPayment).mockImplementation(() => new Promise((resolve) => (finish = resolve as typeof finish)) as never);
      const store = createRealPaymentStore();
      awaiting(store, s.offset);

      const approving = store.getState().resumeAuthorization();
      await s.settle();
      expect(store.getState().isAuthorizing).toBe(true);
      await way.end(store, s);
      finish({ signature: "0xsig", activityId: "activity-1" });
      await approving;
      await s.settle();

      expect(s.submits(), way.name).toHaveLength(0);
      expect(store.getState().pendingSubmission, way.name).toBeNull();
      store.getState().detach();
      vi.useRealTimers();
    }
  });

  it("13. a passkey ceremony that fails after the context changed does not write an error into the new one", async () => {
    const s = lab();
    let fail: (error: Error) => void = () => {};
    vi.mocked(signPreparedPayment).mockReset();
    vi.mocked(signPreparedPayment).mockImplementation(() => new Promise((_resolve, reject) => (fail = reject)) as never);
    const store = createRealPaymentStore();
    awaiting(store, s.offset);
    const approving = store.getState().resumeAuthorization();
    await s.settle();

    store.getState().reset();
    fail(new Error("device went away"));
    await approving;

    expect(store.getState()).toMatchObject({ status: "editing", error: null, attempt: null });
  });

  it("an overlapping Continue while the passkey sheet is open opens no second ceremony", async () => {
    const s = lab();
    vi.mocked(signPreparedPayment).mockReset();
    vi.mocked(signPreparedPayment).mockImplementation(() => new Promise(() => {}) as never);
    const store = createRealPaymentStore();
    awaiting(store, s.offset);

    void store.getState().resumeAuthorization();
    await s.settle();
    await Promise.all([store.getState().resumeAuthorization(), store.getState().resumeAuthorization()]);

    expect(vi.mocked(signPreparedPayment)).toHaveBeenCalledTimes(1);
    expect(s.submits()).toHaveLength(0);
    store.getState().detach();
  });

  it("a wait that begins while another handler is signing applies before that handler sends anything", async () => {
    const s = lab();
    let finish: (value: { signature: string; activityId: string }) => void = () => {};
    vi.mocked(signPreparedPayment).mockReset();
    vi.mocked(signPreparedPayment).mockImplementation(() => new Promise((resolve) => (finish = resolve as typeof finish)) as never);
    const store = createRealPaymentStore();
    awaiting(store, s.offset);
    const approving = store.getState().resumeAuthorization();
    await s.settle();

    // A denial for this same attempt lands meanwhile (e.g. a request from a sibling handler).
    s.script(denial("300"));
    // Simulated through the only public door: a prior approval for this attempt is submitted and refused.
    store.setState({ pendingSubmission: { attemptId: ATTEMPT_ID, signature: "0xold", activityId: "activity-old" } });
    store.setState({ isAuthorizing: false });
    await store.getState().resumeAuthorization();
    expect(store.getState().isSubmitCoolingDown).toBe(true);

    finish({ signature: "0xsig", activityId: "activity-1" });
    await approving;

    expect(s.submits()).toHaveLength(1); // the ceremony's result was NOT sent into the wait
    expect(store.getState()).toMatchObject({ status: "awaiting_authorization", isSubmitCoolingDown: true, error: null });
    expect(store.getState().pendingSubmission).toMatchObject({ signature: "0xsig" }); // kept for after the wait
    store.getState().detach();
  });

  // ---- races -------------------------------------------------------------

  it("a 429 for a payment a status read already finished is dropped — a confirmed payment is never turned back into a wait", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store, s.offset);
    s.keepPrepared();
    s.script("hold");
    const sending = store.getState().resumeAuthorization();
    await s.settle();

    s.setStatusState("confirmed");
    await store.getState().checkStatus(); // a read begun AFTER the submit started applies
    expect(store.getState().status).toBe("confirmed");

    s.held[0]!.respond(denial("600"));
    await sending;

    expect(store.getState()).toMatchObject({ status: "confirmed", isSubmitCoolingDown: false });
    expect(store.getState().attempt?.state).toBe("confirmed");
    store.getState().detach();
  });

  it("a late 'submitted' never regresses a payment a read already showed as confirmed", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store, s.offset);
    s.keepPrepared();
    s.script("hold");
    const sending = store.getState().resumeAuthorization();
    await s.settle();
    s.setStatusState("confirmed");
    await store.getState().checkStatus();

    s.held[0]!.respond(submittedBody());
    await sending;

    expect(store.getState().status).toBe("confirmed");
    expect(store.getState().attempt?.state).toBe("confirmed");
    expect(store.getState().pendingSubmission).toBeNull();
    store.getState().detach();
  });

  it("a manual cancel that succeeds while the submit is pending: the late 429 does not resurrect the payment or start a wait", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store, s.offset);
    s.script("hold");
    const sending = store.getState().resumeAuthorization();
    await s.settle();

    await store.getState().cancel();
    expect(store.getState()).toMatchObject({ status: "editing", attempt: null });

    s.held[0]!.respond(denial("600"));
    await sending;

    expect(store.getState()).toMatchObject({ status: "editing", attempt: null, isSubmitCoolingDown: false, pendingSubmission: null });
    store.getState().detach();
  });

  it("two overlapping denials: the later deadline wins, and a shorter one never shortens it", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store, s.offset);
    s.script("hold", "hold");
    const first = store.getState().resumeAuthorization();
    await s.settle();
    // A read shows the row still awaiting, so a second submit is possible: two requests are in flight.
    await store.getState().checkStatus();
    expect(store.getState().status).toBe("awaiting_authorization");
    const second = store.getState().resumeAuthorization();
    await s.settle();
    expect(s.held).toHaveLength(2);

    s.held[1]!.respond(denial("600"));
    await second;
    s.held[0]!.respond(denial("30"));
    await first;

    expect(store.getState().submitCooldownSeconds).toBe(600);
    await vi.advanceTimersByTimeAsync(599_999);
    expect(store.getState().isSubmitCoolingDown).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getState().isSubmitCoolingDown).toBe(false);
    store.getState().detach();
  });

  it("a late prepare answer after an account switch applies nothing and signs nothing", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    useRealAccountStore.setState({ account: ACCOUNT_A });
    store.setState({ status: "reviewing", recipientInput: "0x3333333333333333333333333333333333333333", amountInput: "1" });
    let prepared: (response: Response) => void = () => {};
    const baseFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => (String(input).includes("/prepare") ? new Promise<Response>((resolve) => (prepared = resolve)) : baseFetch(input, init))),
    );

    const sending = store.getState().confirmAndSend();
    await s.settle();
    useRealAccountStore.setState({ account: ACCOUNT_B });
    store.getState().reset();
    prepared(jsonResponse(200, { attempt: baseAttempt(), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: Math.floor(Date.now() / 1000) }));
    await sending;

    expect(store.getState()).toMatchObject({ status: "editing", attempt: null });
    expect(vi.mocked(signPreparedPayment)).not.toHaveBeenCalled();
    store.getState().detach();
  });

  // ---- expiry ------------------------------------------------------------

  it("14. the approval expiring during the wait fabricates no failure or finality, and Cancel still works", async () => {
    const { s, store } = await denied("120", 200);
    expect(store.getState().isSubmitRetryBeyondApproval).toBe(false);

    await vi.advanceTimersByTimeAsync(201_000);

    expect(store.getState().isAttemptPastValidity).toBe(true);
    expect(store.getState()).toMatchObject({ status: "awaiting_authorization" });
    expect(store.getState().attempt).toMatchObject({ state: "awaiting_authorization", failureReason: null, transactionHash: null });
    expect(s.count("/cancel")).toBe(0);
    expect(s.submits()).toHaveLength(1);

    await store.getState().cancel();
    expect(s.count("/cancel")).toBe(1);
    expect(store.getState()).toMatchObject({ status: "editing", attempt: null });
    store.getState().detach();
  });

  it("15. a wait that ends after the approval can still be dispatched is flagged — with the server's 60 s margin as the exact boundary", async () => {
    // validUntil is 180 s away; a 120 s wait leaves exactly 60 s: still dispatchable.
    expect((await denied("120", 180)).store.getState().isSubmitRetryBeyondApproval).toBe(false);
    vi.useRealTimers();
    // One second less, and it is not.
    const tooLate = await denied("120", 179);
    expect(tooLate.store.getState()).toMatchObject({ isSubmitCoolingDown: true, isSubmitRetryBeyondApproval: true, status: "awaiting_authorization" });
    // Nothing is fabricated: the payment is exactly as it was.
    expect(tooLate.store.getState().attempt).toMatchObject({ state: "awaiting_authorization", failureReason: null });
    expect(tooLate.store.getState().pendingSubmission).not.toBeNull();
    tooLate.store.getState().detach();
  });

  it("15. the flag survives a remount, and the 60 s fallback is judged the same way", async () => {
    const { store } = await denied(undefined, 100); // 60 s fallback, 100 s left -> 40 s < margin
    expect(store.getState()).toMatchObject({ submitCooldownSeconds: 60, isSubmitRetryBeyondApproval: true });

    store.getState().detach();
    await store.getState().init();
    expect(store.getState()).toMatchObject({ isSubmitCoolingDown: true, isSubmitRetryBeyondApproval: true });
    store.getState().detach();
  });

  // ---- what must not change ---------------------------------------------

  it("16. the existing retryable 503 is unchanged: message shown, no wait, the same approval re-sent at once", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store, s.offset);
    s.script(jsonResponse(503, { error: "We couldn't confirm your passkey approval yet. Try again in a moment.", retryable: true }));
    await store.getState().resumeAuthorization();

    expect(store.getState()).toMatchObject({ status: "awaiting_authorization", isSubmitCoolingDown: false, error: "We couldn't confirm your passkey approval yet. Try again in a moment." });
    expect(store.getState().pendingSubmission).toMatchObject({ signature: "0xsig" });

    await store.getState().resumeAuthorization();
    expect(s.submits()).toHaveLength(2);
    expect(vi.mocked(signPreparedPayment)).toHaveBeenCalledTimes(1);
    store.getState().detach();
  });

  it("17. a generic 500 stays conservative: unknown, never a wait, never a resend", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store, s.offset);
    s.script(jsonResponse(500, { error: "Something went wrong. Please try again." }));
    await store.getState().resumeAuthorization();

    // L-2 D-4: the outcome is as conservative as before; the detail shown is now fixed client copy, not the server's sentence.
    expect(store.getState()).toMatchObject({ status: "unknown", isSubmitCoolingDown: false, error: "We couldn't confirm whether this payment was sent. Check its status before trying again." });
    expect(JSON.stringify(store.getState())).not.toContain("Something went wrong");
    store.getState().detach();
  });

  it("18. a 429 that is not the submit budget's denial does not impersonate it", async () => {
    const cases: Array<{ name: string; response: Response; expectStatus: string }> = [
      { name: "no retryable flag (e.g. a payment quota)", response: denial("60", { error: "You've reached the payment limit.", code: "rate_limited" }), expectStatus: "unknown" },
      { name: "retryable but another code", response: denial("60", { error: "Slow down.", code: "quota", retryable: true }), expectStatus: "awaiting_authorization" },
      { name: "retryable false", response: denial("60", { error: "Slow down.", code: "rate_limited", retryable: false }), expectStatus: "unknown" },
      { name: "no code at all", response: denial("60", { error: "Slow down.", retryable: true }), expectStatus: "awaiting_authorization" },
      { name: "right body, wrong status", response: new Response(JSON.stringify({ error: "x", code: "rate_limited", retryable: true }), { status: 503, headers: { "Retry-After": "600" } }), expectStatus: "awaiting_authorization" },
    ];
    for (const c of cases) {
      const s = lab();
      const store = createRealPaymentStore();
      awaiting(store, s.offset);
      s.script(c.response);
      await store.getState().resumeAuthorization();
      expect(store.getState().status, c.name).toBe(c.expectStatus);
      expect(store.getState().isSubmitCoolingDown, c.name).toBe(false);
      expect(store.getState().submitCooldownSeconds, c.name).toBeNull();
      store.getState().detach();
      vi.useRealTimers();
    }
  });

  it("a late /prepare FAILURE after an account switch or a remount changes nothing in the current context and signs nothing", async () => {
    const failures: Array<{ name: string; end: (settle: { resolve: (r: Response) => void; reject: (e: Error) => void }) => void }> = [
      { name: "404 for a found name", end: ({ resolve }) => resolve(jsonResponse(404, { error: "We couldn't find that name." })) },
      { name: "400", end: ({ resolve }) => resolve(jsonResponse(400, { error: "That payment can't be sent." })) },
      { name: "500", end: ({ resolve }) => resolve(jsonResponse(500, { error: "Something went wrong. Please try again." })) },
      { name: "network failure", end: ({ reject }) => reject(new TypeError("Failed to fetch")) },
    ];
    for (const way of ["account switched", "detach and remount"] as const) {
      for (const failure of failures) {
        const s = lab();
        const store = createRealPaymentStore();
        store.setState({ status: "reviewing", recipientInput: "@maya", recipientLookup: { status: "found", handle: "maya", displayName: "Maya", isSelf: false }, amountInput: "1" });
        const baseFetch = globalThis.fetch;
        let prepare: { resolve: (r: Response) => void; reject: (e: Error) => void } = { resolve: () => {}, reject: () => {} };
        vi.stubGlobal(
          "fetch",
          vi.fn((input: RequestInfo | URL, init?: RequestInit) => (String(input).includes("/prepare") ? new Promise<Response>((resolve, reject) => (prepare = { resolve, reject })) : baseFetch(input, init))),
        );

        const sending = store.getState().confirmAndSend();
        await s.settle();
        expect(store.getState().status).toBe("preparing");

        if (way === "account switched") {
          useRealAccountStore.setState({ account: ACCOUNT_B });
          store.getState().reset();
          s.setLatestId(ACCOUNT_B_ATTEMPT_ID);
        } else {
          store.getState().detach();
        }
        await store.getState().init();
        // The current context has its own, different found name — a stale 404 must not wipe it.
        store.setState({ recipientInput: "@zed", recipientLookup: { status: "found", handle: "zed", displayName: null, isSelf: false } });
        const pick = (state: ReturnType<typeof store.getState>) => ({ status: state.status, attempt: state.attempt, error: state.error, recipientInput: state.recipientInput, recipientLookup: state.recipientLookup, pendingSubmission: state.pendingSubmission });
        const before = pick(store.getState());

        failure.end(prepare);
        await sending;
        await s.settle();

        expect(pick(store.getState()), `${way}: ${failure.name}`).toEqual(before);
        expect(vi.mocked(signPreparedPayment)).not.toHaveBeenCalled();
        expect(s.submits()).toHaveLength(0);
        store.getState().detach();
        vi.useRealTimers();
      }
    }
  });

  it("a wait that outlasts the approval ends without making the approval offerable again: the flag stays, nothing is sent", async () => {
    // 30 s of approval left, a 1 s wait: the margin (60 s) is already gone, so the wait can never lead to a usable retry.
    const { s, store } = await denied("1", 30);
    expect(store.getState()).toMatchObject({ isSubmitCoolingDown: true, isSubmitRetryBeyondApproval: true });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(store.getState()).toMatchObject({ isSubmitCoolingDown: false, isSubmitRetryBeyondApproval: true, status: "awaiting_authorization" });
    expect(store.getState().attempt).toMatchObject({ state: "awaiting_authorization", failureReason: null });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.submits()).toHaveLength(1);
    expect(vi.mocked(signPreparedPayment)).toHaveBeenCalledTimes(1);
    store.getState().detach();
  });

  it("a NEW payment prepared after the previous one was cancelled elsewhere does not inherit that attempt's published wait", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    // L-2 D-12: the typed address is the recipient this suite's status / cancel fixtures answer with (baseAttempt's), and each prepare answers the amount it was sent.
    const address = baseAttempt().recipient;
    const baseFetch = globalThis.fetch;
    const preparedIds = [PREPARED_ID, PREPARED_ID_2];
    const prepareCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input).includes("/prepare")) return baseFetch(input, init);
        const id = preparedIds.shift()!;
        prepareCalls.push(id);
        const { amountBaseUnits } = JSON.parse(init!.body as string) as { amountBaseUnits: string };
        return Promise.resolve(jsonResponse(200, { attempt: { ...baseAttempt(), id, amountBaseUnits }, subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: Math.floor(Date.now() / 1000) + s.offset }));
      }),
    );
    // First approval is signed (then refused by the server's budget); the new payment's passkey sheet is dismissed.
    vi.mocked(signPreparedPayment).mockReset();
    vi.mocked(signPreparedPayment)
      .mockResolvedValueOnce({ signature: "0xsig", activityId: "activity-1" } as never)
      .mockRejectedValueOnce(Object.assign(new Error("dismissed"), { name: "NotAllowedError" }))
      .mockResolvedValue({ signature: "0xsig-new", activityId: "activity-new" } as never);

    // 1-3. Prepare, get a valid submit-budget denial (Retry-After 600), and see the wait published.
    store.getState().setRecipientInput(address);
    store.getState().setAmountInput("1");
    await store.getState().review();
    expect(store.getState().status).toBe("reviewing");
    s.script(denial("600"));
    await store.getState().confirmAndSend();
    expect(store.getState().attempt?.id).toBe(PREPARED_ID);
    expect(store.getState()).toMatchObject({ status: "awaiting_authorization", isSubmitCoolingDown: true, submitCooldownSeconds: 600, isSubmitRetryBeyondApproval: false });

    // 4-5. The attempt is cancelled elsewhere; the existing status read observes it and the store returns to editing.
    s.keepPrepared(); // the held attempt is the prepare answer, prepared fields included
    s.setStatusState("cancelled");
    await store.getState().checkStatus();
    expect(store.getState().status).toBe("editing");
    expect(store.getState().attempt).toMatchObject({ id: PREPARED_ID, state: "cancelled" });
    const submitsBefore = s.submits().length;
    const signsBefore = vi.mocked(signPreparedPayment).mock.calls.length;

    // 6-7. A NEW payment is prepared through the public actions, without reset().
    store.getState().setRecipientInput(address);
    store.getState().setAmountInput("2");
    await store.getState().review();
    await store.getState().confirmAndSend();
    expect(prepareCalls).toEqual([PREPARED_ID, PREPARED_ID_2]);
    expect(store.getState().attempt?.id).toBe(PREPARED_ID_2);
    expect(store.getState().status).toBe("awaiting_authorization");

    // 8. The old attempt's published wait is gone — all three fields.
    expect(store.getState()).toMatchObject({ isSubmitCoolingDown: false, submitCooldownSeconds: null, isSubmitRetryBeyondApproval: false });
    // 10. Preparing is the user's own action: exactly one passkey ceremony for it (dismissed), and no submit of any kind.
    expect(vi.mocked(signPreparedPayment).mock.calls.length).toBe(signsBefore + 1);
    expect(s.submits()).toHaveLength(submitsBefore);
    expect(store.getState().pendingSubmission).toBeNull();
    expect(s.count("/cancel")).toBe(0);

    // 9. The previous wait does not gate the new attempt: its Continue signs and submits at once.
    await store.getState().resumeAuthorization();
    expect(s.submits()).toHaveLength(submitsBefore + 1);
    expect(s.submits().at(-1)!.body).toMatchObject({ attemptId: PREPARED_ID_2, signature: "0xsig-new", activityId: "activity-new" });
    store.getState().detach();
  });

  it("the SAME attempt keeps its published wait across a remount — only a newly prepared attempt clears it", async () => {
    const { s, store } = await denied("600");
    store.getState().detach();
    await store.getState().init();
    expect(store.getState()).toMatchObject({ isSubmitCoolingDown: true, submitCooldownSeconds: 600 });
    await store.getState().resumeAuthorization();
    expect(s.submits()).toHaveLength(1);
    store.getState().detach();
  });

  it("a denial never calls cancel, status, prepare or the balance, and never invents a transaction", async () => {
    const { s, store } = await denied("120");
    await vi.advanceTimersByTimeAsync(119_000);
    expect(s.count("/cancel") + s.count("/prepare")).toBe(0);
    expect(store.getState().attempt?.transactionHash).toBeNull();
    store.getState().detach();
  });
});


/**
 * L-2 D-1: after a prepare request that ended without a trustworthy answer, the
 * page must not offer another Review/prepare — a payment may already exist and
 * hold the account's one active slot. The user checks explicitly (one GET
 * /latest per click); only a successful, current answer releases the form, and
 * a finished payment is never adopted. Fake server only: no network, no
 * signing, no Turnkey, no bundler.
 */
describe("real-payment-store — L-2 D-1: unresolved prepare and explicit status check", () => {
  const ADDRESS = "0x3333333333333333333333333333333333333333";
  const ACCOUNT_A = { appUserId: "app-user-1", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222" };
  const ACCOUNT_B = { appUserId: "app-user-2", ownerAddress: "0x4444444444444444444444444444444444444444", safeAddress: "0x5555555555555555555555555555555555555555" };
  const UNCERTAIN_BODY = { error: "We couldn't confirm this payment's setup. No money was sent by this request. Refresh the app to check its status before trying again.", code: "prepare_outcome_uncertain" };
  const FIXED_UNCERTAIN = "We couldn't confirm whether your payment was set up. Check its status before trying again.";
  const FIXED_IN_PROGRESS = "A payment may already be in progress. Check its status before trying again.";

  type Key = "prepare" | "latest" | "cancel" | "status" | "submit";
  type Handler = (n: number) => Response | Promise<Response>;
  const stores: Array<ReturnType<typeof createRealPaymentStore>> = [];

  beforeEach(() => {
    vi.mocked(signPreparedPayment).mockClear();
  });

  afterEach(() => {
    for (const store of stores.splice(0)) store.getState().reset();
    vi.unstubAllGlobals();
    vi.mocked(signPreparedPayment).mockClear();
    useRealAccountStore.setState({ account: null });
  });

  function server(handlers: Partial<Record<Key, Handler>>) {
    const calls: Array<{ key: Key; url: string; method: string }> = [];
    const counts: Record<Key, number> = { prepare: 0, latest: 0, cancel: 0, status: 0, submit: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        const key: Key | null = url.endsWith("/api/real/payments/prepare") ? "prepare" : url.endsWith("/api/real/payments/latest") ? "latest" : url.endsWith("/cancel") ? "cancel" : url.endsWith("/status") ? "status" : url.endsWith("/api/real/payments/submit") ? "submit" : null;
        const handler = key ? handlers[key] : undefined;
        if (!key || !handler) throw new Error(`unexpected fetch: ${method} ${url}`);
        calls.push({ key, url, method });
        counts[key] += 1;
        return handler(counts[key]);
      }),
    );
    return { calls, count: (key: Key) => calls.filter((call) => call.key === key).length, keys: () => calls.map((call) => call.key) };
  }

  function held() {
    let resolve: (response: Response) => void = () => {};
    const promise = new Promise<Response>((res) => (resolve = res));
    return { promise, resolve };
  }

  const attemptIn = (state: string, overrides: Record<string, unknown> = {}) => ({ ...baseAttempt(), id: stateAttemptId(state), state, ...overrides }) as never;
  // L-2 D-13 honest-fixture correction: the signing context only for awaiting_authorization, a reserved row without fields.
  const latestOf = (state: string, extra: Record<string, unknown> = {}) => () => jsonResponse(200, { ...honestLatestBody(attemptIn(state)), ...extra });

  function newStore() {
    useRealAccountStore.setState({ account: ACCOUNT_A });
    const store = createRealPaymentStore();
    stores.push(store);
    store.setState({ status: "editing" });
    store.getState().setRecipientInput(ADDRESS);
    store.getState().setAmountInput("1");
    return store;
  }

  /** Drives a fresh store through Review and Approve; `prepare` decides how the request ends. */
  async function afterPrepare(prepare: Handler, others: Partial<Record<Key, Handler>> = {}) {
    const api = server({ prepare, ...others });
    const store = newStore();
    await store.getState().review();
    expect(store.getState().status).toBe("reviewing");
    await store.getState().confirmAndSend();
    return { api, store };
  }

  describe("classifying a failed prepare", () => {
    it.each([
      ["the server's prepare_outcome_uncertain (C-1)", () => jsonResponse(500, UNCERTAIN_BODY), "uncertain"],
      ["a generic HTTP 500", () => jsonResponse(500, { error: "Something went wrong." }), "uncertain"],
      ["a 500 whose body is not JSON", () => new Response("<html>oops</html>", { status: 500 }), "uncertain"],
      ["an unreadable success reply", () => new Response("not json", { status: 200 }), "uncertain"],
      ["an HTTP 409 with the in-progress sentence", () => jsonResponse(409, { error: "You already have a payment in progress." }), "in_progress"],
      ["an HTTP 409 with no payment_in_progress code (account not ready)", () => jsonResponse(409, { error: "Your account isn't fully set up yet." }), "in_progress"],
    ] as const)("%s requires a status check, keeps the typed text, and shows no raw server text", async (_name, prepare, expected) => {
      const { api, store } = await afterPrepare(prepare);

      expect(store.getState()).toMatchObject({ status: "editing", prepareNeedsCheck: expected, prepareCheck: "idle", recipientInput: ADDRESS, amountInput: "1", attempt: null, error: null });
      // Nothing happens by itself: no retry, no /latest, no cancel, no signing, no submit.
      expect(api.keys()).toEqual(["prepare"]);
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });

    it("a network failure is unresolved too, and the raw 'Failed to fetch' text is never kept", async () => {
      const { api, store } = await afterPrepare(() => {
        throw new TypeError("Failed to fetch");
      });
      expect(store.getState()).toMatchObject({ status: "editing", prepareNeedsCheck: "uncertain", error: null, recipientInput: ADDRESS, amountInput: "1" });
      expect(JSON.stringify(store.getState().error)).not.toMatch(/fetch/i);
      expect(api.keys()).toEqual(["prepare"]);
    });

    it("the fixed copy is what the form shows (exported constants match the approved wording)", async () => {
      const { PREPARE_UNCERTAIN_MESSAGE, PREPARE_IN_PROGRESS_MESSAGE, PREPARE_CHECK_FAILED_MESSAGE, PREPARE_CHECK_NONE_MESSAGE } = await import("@/lib/stores/real-payment-store");
      expect(PREPARE_UNCERTAIN_MESSAGE).toBe(FIXED_UNCERTAIN);
      expect(PREPARE_IN_PROGRESS_MESSAGE).toBe(FIXED_IN_PROGRESS);
      expect(PREPARE_CHECK_FAILED_MESSAGE).toBe("We couldn't check right now. Try again in a moment.");
      expect(PREPARE_CHECK_NONE_MESSAGE).toBe("No payment is waiting. You can review your payment again.");
    });

    it.each([
      ["400", () => jsonResponse(400, { error: "Enter a valid Cash amount." })],
      ["401", () => jsonResponse(401, { error: "Not authenticated." })],
      ["404", () => jsonResponse(404, { error: "We couldn't find anyone with that name." })],
      ["429 rate_limited", () => jsonResponse(429, { error: "You're going a bit fast. Try again later.", code: "rate_limited" })],
      ["429 quota", () => jsonResponse(429, { error: "You've reached the payment limit for now. Try again later." })],
      ["502 prepare_failed", () => jsonResponse(502, { error: "We couldn't prepare that payment. Please try again." })],
    ] as const)("HTTP %s keeps its existing handling: the server's message, no status-check requirement", async (_name, prepare) => {
      const { api, store } = await afterPrepare(prepare);
      expect(store.getState().prepareNeedsCheck).toBeNull();
      expect(store.getState().status).toBe("editing");
      expect(store.getState().error).toBeTruthy();
      expect(api.keys()).toEqual(["prepare"]);
    });

    it("a prepare 500 that arrives after a reset (a new lifecycle) sets nothing", async () => {
      const gate = held();
      server({ prepare: () => gate.promise });
      const store = newStore();
      await store.getState().review();
      const pending = store.getState().confirmAndSend();
      store.getState().reset();
      gate.resolve(jsonResponse(500, UNCERTAIN_BODY));
      await pending;
      expect(store.getState()).toMatchObject({ prepareNeedsCheck: null, prepareCheck: "idle", status: "editing", recipientInput: "" });
    });

    it("a prepare 500 that arrives after an account switch sets nothing", async () => {
      const gate = held();
      server({ prepare: () => gate.promise });
      const store = newStore();
      await store.getState().review();
      const pending = store.getState().confirmAndSend();
      useRealAccountStore.setState({ account: ACCOUNT_B });
      gate.resolve(jsonResponse(500, UNCERTAIN_BODY));
      await pending;
      expect(store.getState().prepareNeedsCheck).toBeNull();
    });
  });

  describe("while a check is required", () => {
    it("review() and confirmAndSend() refuse in the store, not only on the button; editing never clears the requirement", async () => {
      const { api, store } = await afterPrepare(() => jsonResponse(500, UNCERTAIN_BODY));

      store.getState().setRecipientInput("0x4444444444444444444444444444444444444444");
      store.getState().setAmountInput("2");
      await store.getState().review();
      expect(store.getState()).toMatchObject({ status: "editing", prepareNeedsCheck: "uncertain" });

      // Even a forced "reviewing" cannot start a second prepare.
      store.setState({ status: "reviewing" });
      await store.getState().confirmAndSend();
      expect(api.count("prepare")).toBe(1);
      expect(store.getState().prepareNeedsCheck).toBe("uncertain");
    });

    it("the check does nothing when no check is required, off the editing screen, or after detach", async () => {
      const api = server({ latest: () => jsonResponse(200, { attempt: null }) });
      const store = newStore();
      await store.getState().checkPreparedPayment();
      expect(api.count("latest")).toBe(0);

      store.setState({ prepareNeedsCheck: "uncertain", status: "reviewing" });
      await store.getState().checkPreparedPayment();
      expect(api.count("latest")).toBe(0);

      store.setState({ status: "editing" });
      store.getState().detach();
      store.setState({ prepareNeedsCheck: "uncertain", status: "editing" });
      await store.getState().checkPreparedPayment();
      expect(api.count("latest")).toBe(0);
    });
  });

  describe("the check: one GET /latest per click, nothing else", () => {
    it("no attempt: releases the requirement, keeps the form, confirms plainly, and Review works again", async () => {
      const { api, store } = await afterPrepare(() => jsonResponse(500, UNCERTAIN_BODY), { latest: () => jsonResponse(200, { attempt: null }) });

      await store.getState().checkPreparedPayment();

      expect(api.keys()).toEqual(["prepare", "latest"]);
      expect(api.calls.at(-1)).toMatchObject({ method: "GET" });
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, prepareNeedsCheck: null, prepareCheck: "nothing_found", recipientInput: ADDRESS, amountInput: "1", error: null });

      await store.getState().review();
      expect(store.getState()).toMatchObject({ status: "reviewing", prepareCheck: "idle" });
    });

    it.each(["confirmed", "failed", "cancelled"] as const)("a %s latest attempt is NOT adopted (an old payment is not this form's result)", async (state) => {
      const { api, store } = await afterPrepare(() => jsonResponse(500, UNCERTAIN_BODY), { latest: latestOf(state) });
      await store.getState().checkPreparedPayment();

      expect(api.keys()).toEqual(["prepare", "latest"]);
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, prepareNeedsCheck: null, prepareCheck: "nothing_found", recipientInput: ADDRESS, amountInput: "1" });
    });

    it.each([
      ["prepared", "stranded"],
      ["signed", "stranded"],
      ["submitting", "unknown"],
      ["submitted", "submitted"],
      ["unknown", "unknown"],
    ] as const)("a %s attempt is adopted exactly and shown as %s; nothing is signed, submitted, prepared or cancelled", async (state, shown) => {
      const { api, store } = await afterPrepare(() => jsonResponse(500, UNCERTAIN_BODY), { latest: latestOf(state) });
      await store.getState().checkPreparedPayment();

      expect(store.getState()).toMatchObject({ status: shown, prepareNeedsCheck: null, prepareCheck: "idle", attempt: { id: stateAttemptId(state), state } });
      expect(api.keys()).toEqual(["prepare", "latest"]);
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });

    it("awaiting_authorization with the server's signing context resumes through the existing flow, without prompting", async () => {
      const { api, store } = await afterPrepare(() => jsonResponse(500, UNCERTAIN_BODY), { latest: latestOf("awaiting_authorization") });
      await store.getState().checkPreparedPayment();

      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", prepareNeedsCheck: null, subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", attempt: { id: stateAttemptId("awaiting_authorization") }, pendingSubmission: null, isAuthorizing: false });
      expect(api.keys()).toEqual(["prepare", "latest"]);
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });

    it("awaiting_authorization WITHOUT signing context is cancel-only (stranded), never re-bound", async () => {
      const { store } = await afterPrepare(() => jsonResponse(500, UNCERTAIN_BODY), { latest: latestOf("awaiting_authorization", { subOrganizationId: null, authorizingCredentialId: null }) });
      await store.getState().checkPreparedPayment();
      expect(store.getState()).toMatchObject({ status: "stranded", authorizingCredentialId: null, prepareNeedsCheck: null });
      expect(store.getState().error).toMatch(/different passkey/);
    });

    it("the server's attempt is the truth: the form's recipient and amount never become the payment's identity", async () => {
      const { store } = await afterPrepare(() => jsonResponse(500, UNCERTAIN_BODY), {
        latest: () => jsonResponse(200, honestLatestBody(attemptIn("prepared", { recipient: "0x9999999999999999999999999999999999999999", amountBaseUnits: "7000000" }))),
      });
      await store.getState().checkPreparedPayment();
      expect(store.getState().attempt).toMatchObject({ recipient: "0x9999999999999999999999999999999999999999", amountBaseUnits: "7000000" });
    });

    it("two rapid clicks send exactly one GET /latest, and the button state says it is checking", async () => {
      const gate = held();
      const api = server({ prepare: () => jsonResponse(500, UNCERTAIN_BODY), latest: () => gate.promise });
      const store = newStore();
      await store.getState().review();
      await store.getState().confirmAndSend();

      const first = store.getState().checkPreparedPayment();
      const second = store.getState().checkPreparedPayment();
      expect(store.getState().prepareCheck).toBe("checking");
      gate.resolve(jsonResponse(200, { attempt: null }));
      await Promise.all([first, second]);

      expect(api.count("latest")).toBe(1);
      expect(store.getState().prepareCheck).toBe("nothing_found");
    });

    it("each user-initiated check is its own single GET", async () => {
      const { api, store } = await afterPrepare(() => jsonResponse(500, UNCERTAIN_BODY), { latest: (n) => (n === 1 ? jsonResponse(500, { error: "x" }) : jsonResponse(200, { attempt: null })) });
      await store.getState().checkPreparedPayment();
      expect(api.count("latest")).toBe(1);
      await store.getState().checkPreparedPayment();
      expect(api.count("latest")).toBe(2);
    });
  });

  describe("a check that cannot be trusted keeps the requirement", () => {
    it.each([
      ["HTTP 500", () => jsonResponse(500, { error: "boom" })],
      ["HTTP 503", () => jsonResponse(503, { error: "later" })],
      ["a reply that is not JSON", () => new Response("<html>", { status: 200 })],
      ["a reply with no attempt field", () => jsonResponse(200, {})],
      ["an attempt of an unknown state", () => jsonResponse(200, { attempt: { ...baseAttempt(), state: "mystery" }, ...NO_SIGNING_CONTEXT, serverNowSeconds: Math.floor(Date.now() / 1000) })],
      ["an attempt with no id", () => jsonResponse(200, { attempt: { ...baseAttempt(), id: "" }, ...NO_SIGNING_CONTEXT, serverNowSeconds: Math.floor(Date.now() / 1000) })],
      ["a non-object attempt", () => jsonResponse(200, { attempt: "nope", ...NO_SIGNING_CONTEXT, serverNowSeconds: Math.floor(Date.now() / 1000) })],
      ["a network failure", () => {
        throw new TypeError("Failed to fetch");
      }],
    ] as const)("%s: still required, inputs kept, nothing adopted, then a later check can succeed", async (_name, latest) => {
      let calls = 0;
      const { api, store } = await afterPrepare(() => jsonResponse(500, UNCERTAIN_BODY), {
        latest: (n) => {
          calls = n;
          return n === 1 ? latest() : jsonResponse(200, { attempt: null });
        },
      });

      await store.getState().checkPreparedPayment();
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, prepareNeedsCheck: "uncertain", prepareCheck: "unavailable", recipientInput: ADDRESS, amountInput: "1" });
      expect(api.count("latest")).toBe(1);
      expect(calls).toBe(1); // no automatic retry

      await store.getState().checkPreparedPayment();
      expect(store.getState()).toMatchObject({ prepareNeedsCheck: null, prepareCheck: "nothing_found" });
    });

    it("HTTP 401 is not 'no payment': the requirement stays and the signed-out message is shown", async () => {
      const { store } = await afterPrepare(() => jsonResponse(500, UNCERTAIN_BODY), { latest: () => jsonResponse(401, { error: "Not authenticated." }) });
      await store.getState().checkPreparedPayment();
      expect(store.getState()).toMatchObject({ prepareNeedsCheck: "uncertain", prepareCheck: "idle", attempt: null, error: "You're signed out." });
    });

    it("a read that never answers ends our wait at the deadline and keeps the requirement", async () => {
      vi.useFakeTimers();
      try {
        server({ prepare: () => jsonResponse(500, UNCERTAIN_BODY), latest: () => new Promise<Response>(() => {}) });
        const store = newStore();
        await store.getState().review();
        await store.getState().confirmAndSend();
        const pending = store.getState().checkPreparedPayment();
        await vi.advanceTimersByTimeAsync(STATUS_REQUEST_DEADLINE_MS + 1);
        await pending;
        expect(store.getState()).toMatchObject({ prepareNeedsCheck: "uncertain", prepareCheck: "unavailable" });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("stale answers are never applied", () => {
    async function inFlightCheck() {
      const gate = held();
      const api = server({ prepare: () => jsonResponse(500, UNCERTAIN_BODY), latest: () => gate.promise, status: () => jsonResponse(200, { attempt: attemptIn("submitted"), serverNowSeconds: Math.floor(Date.now() / 1000) }) });
      const store = newStore();
      await store.getState().review();
      await store.getState().confirmAndSend();
      const pending = store.getState().checkPreparedPayment();
      expect(store.getState().prepareCheck).toBe("checking");
      const answer = () => gate.resolve(jsonResponse(200, honestLatestBody(attemptIn("prepared"))));
      return { api, store, pending, answer };
    }

    it("after reset()", async () => {
      const { store, pending, answer } = await inFlightCheck();
      store.getState().reset();
      answer();
      await pending;
      expect(store.getState()).toMatchObject({ attempt: null, status: "editing", prepareNeedsCheck: null, prepareCheck: "idle", recipientInput: "" });
    });

    it("after an account switch", async () => {
      const { store, pending, answer } = await inFlightCheck();
      useRealAccountStore.setState({ account: ACCOUNT_B });
      answer();
      await pending;
      expect(store.getState().attempt).toBeNull();
      expect(store.getState().status).toBe("editing");
      expect(store.getState().prepareCheck).toBe("checking"); // not applied at all; the lifecycle's init() clears it
    });

    it("after detach() (the Pay form unmounted)", async () => {
      const { store, pending, answer } = await inFlightCheck();
      store.getState().detach();
      answer();
      await pending;
      expect(store.getState().attempt).toBeNull();
      expect(store.getState().status).toBe("editing");
      expect(store.getState().prepareCheck).not.toBe("checking");
    });

    it("after a remount (detach, then init() reads the server itself)", async () => {
      const { api, store, pending, answer } = await inFlightCheck();
      store.getState().detach();
      // The remount's own read answers "no payment" ...
      (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => jsonResponse(200, { attempt: null }));
      await store.getState().init();
      expect(store.getState().attempt).toBeNull();
      // ... and the old check's late "prepared" answer must not resurrect anything.
      answer();
      await pending;
      expect(store.getState()).toMatchObject({ attempt: null, status: "editing", prepareNeedsCheck: null, prepareCheck: "idle" });
      expect(api.count("cancel")).toBe(0);
    });

    it("an older status read for another attempt cannot overwrite the attempt the check adopted", async () => {
      const status = held();
      const check = held();
      const api = server({ latest: () => check.promise, status: () => status.promise });
      useRealAccountStore.setState({ account: ACCOUNT_A });
      const store = createRealPaymentStore();
      stores.push(store);
      // An older attempt X is on screen with a status read on its way.
      store.setState({ status: "unknown", attempt: attemptIn("unknown", { id: OLD_ATTEMPT_ID }) });
      const oldRead = store.getState().checkStatus();
      await vi.waitFor(() => expect(api.count("status")).toBe(1));
      // The page then needs a check (as after an unresolved prepare) and discovers newer attempt Y.
      store.setState({ status: "editing", prepareNeedsCheck: "uncertain" });
      const discovery = store.getState().checkPreparedPayment();
      check.resolve(jsonResponse(200, honestLatestBody(attemptIn("prepared", { id: NEW_ATTEMPT_ID }))));
      await discovery;
      expect(store.getState()).toMatchObject({ status: "stranded", attempt: { id: NEW_ATTEMPT_ID } });
      // X's late answer arrives afterwards and is dropped.
      status.resolve(jsonResponse(200, { attempt: attemptIn("confirmed", { id: OLD_ATTEMPT_ID }), serverNowSeconds: Math.floor(Date.now() / 1000) }));
      await oldRead;
      expect(store.getState()).toMatchObject({ status: "stranded", attempt: { id: NEW_ATTEMPT_ID, state: "prepared" } });
    });
  });

  describe("freshness epoch", () => {
    it("a status read for the SAME attempt that began before the discovery describes the payment as it WAS and is dropped", async () => {
      const status = held();
      const check = held();
      const api = server({ latest: () => check.promise, status: () => status.promise });
      useRealAccountStore.setState({ account: ACCOUNT_A });
      const store = createRealPaymentStore();
      stores.push(store);
      store.setState({ status: "unknown", attempt: attemptIn("unknown", { id: SAME_ATTEMPT_ID }) });
      const oldRead = store.getState().checkStatus();
      await vi.waitFor(() => expect(api.count("status")).toBe(1));

      store.setState({ status: "editing", prepareNeedsCheck: "uncertain" });
      const discovery = store.getState().checkPreparedPayment();
      check.resolve(jsonResponse(200, honestLatestBody(attemptIn("submitted", { id: SAME_ATTEMPT_ID }))));
      await discovery;
      expect(store.getState()).toMatchObject({ status: "submitted", attempt: { id: SAME_ATTEMPT_ID, state: "submitted" } });

      status.resolve(jsonResponse(200, { attempt: attemptIn("failed", { id: SAME_ATTEMPT_ID }), serverNowSeconds: Math.floor(Date.now() / 1000) }));
      await oldRead;
      expect(store.getState()).toMatchObject({ status: "submitted", attempt: { id: SAME_ATTEMPT_ID, state: "submitted" } });
    });
  });

  describe("Cancel after discovery", () => {
    it("a cancel refused with 409 re-reads the server and shows what actually happened (no false 'cancelled')", async () => {
      const { api, store } = await afterPrepare(() => jsonResponse(500, UNCERTAIN_BODY), {
        latest: latestOf("prepared"),
        cancel: () => jsonResponse(409, { error: "This payment can no longer be cancelled (state: submitting)." }),
        status: () => jsonResponse(200, { attempt: attemptIn("submitted", { id: stateAttemptId("prepared") }), serverNowSeconds: Math.floor(Date.now() / 1000) }),
      });
      await store.getState().checkPreparedPayment();
      expect(store.getState().status).toBe("stranded");

      await store.getState().cancel();

      expect(api.count("cancel")).toBe(1);
      expect(store.getState()).toMatchObject({ status: "submitted", attempt: { id: stateAttemptId("prepared"), state: "submitted" } });
    });
  });

  describe("Cancel in-flight guard", () => {
    function strandedStore(cancel: Handler) {
      const api = server({ cancel });
      useRealAccountStore.setState({ account: ACCOUNT_A });
      const store = createRealPaymentStore();
      stores.push(store);
      store.setState({ status: "stranded", attempt: attemptIn("prepared") });
      return { api, store };
    }

    it("repeated presses while the request is pending issue exactly one POST, and isCancelling tracks it", async () => {
      const gate = held();
      const { api, store } = strandedStore(() => gate.promise);

      const first = store.getState().cancel();
      const second = store.getState().cancel();
      const third = store.getState().cancel();
      expect(store.getState().isCancelling).toBe(true);
      expect(api.count("cancel")).toBe(1);

      gate.resolve(jsonResponse(200, { attempt: attemptIn("cancelled", { id: stateAttemptId("prepared") }) }));
      await Promise.all([first, second, third]);

      expect(api.count("cancel")).toBe(1);
      expect(store.getState()).toMatchObject({ isCancelling: false, status: "editing", attempt: null });
    });

    it("an uncertain (network) cancel keeps the payment as it was, frees the guard, and nothing retries by itself", async () => {
      let n = 0;
      const { api, store } = strandedStore(() => {
        n += 1;
        throw new TypeError("Failed to fetch");
      });
      await store.getState().cancel();
      expect(store.getState()).toMatchObject({ isCancelling: false, status: "stranded", attempt: { id: stateAttemptId("prepared") } });
      expect(store.getState().error).toMatch(/Could not confirm/);
      expect(n).toBe(1);
      expect(api.count("cancel")).toBe(1);
      // A deliberate second press is a new request.
      await store.getState().cancel();
      expect(api.count("cancel")).toBe(2);
    });

    it("a cancel that finishes after the lifecycle was replaced changes nothing for the newer one", async () => {
      const gate = held();
      const { store } = strandedStore(() => gate.promise);
      const pending = store.getState().cancel();
      store.getState().reset();
      expect(store.getState().isCancelling).toBe(false);
      // The new lifecycle has its own payment and its own, independent Cancel slot.
      store.setState({ status: "stranded", attempt: attemptIn("prepared", { id: "attempt-newer" }) });
      gate.resolve(jsonResponse(200, { attempt: attemptIn("cancelled", { id: stateAttemptId("prepared") }) }));
      await pending;
      expect(store.getState()).toMatchObject({ status: "stranded", attempt: { id: "attempt-newer" }, isCancelling: false });
    });

    it("a cancel that finishes after an account switch changes nothing", async () => {
      const gate = held();
      const { store } = strandedStore(() => gate.promise);
      const pending = store.getState().cancel();
      useRealAccountStore.setState({ account: ACCOUNT_B });
      gate.resolve(jsonResponse(200, { attempt: attemptIn("cancelled", { id: stateAttemptId("prepared") }) }));
      await pending;
      expect(store.getState()).toMatchObject({ status: "stranded", attempt: { id: stateAttemptId("prepared") } });
    });
  });
});

/**
 * L-2 D-3a: the initial GET /latest (init) must never treat "we could not tell"
 * as "no payment". Anything but a trustworthy answer is "status_unavailable":
 * no attempt, no form, no prepare — only an explicit, user-triggered re-check.
 */
describe("real-payment-store — L-2 D-3a: safe initial payment status check", () => {
  const ADDRESS = "0x3333333333333333333333333333333333333333";
  const ACCOUNT_A = { appUserId: "app-user-1", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222" };
  const ACCOUNT_B = { appUserId: "app-user-2", ownerAddress: "0x4444444444444444444444444444444444444444", safeAddress: "0x5555555555555555555555555555555555555555" };
  /** What "unavailable" must look like: no payment on screen, no signing context, no raw error text. */
  const UNAVAILABLE = { status: "status_unavailable", attempt: null, subOrganizationId: null, authorizingCredentialId: null, pendingSubmission: null, isAttemptPastValidity: false, error: null };
  const LATEST_URL = "/api/real/payments/latest";

  type Key = "latest" | "prepare" | "cancel" | "status" | "submit" | "lookup";
  type Handler = (n: number) => Response | Promise<Response>;
  const stores: Array<ReturnType<typeof createRealPaymentStore>> = [];

  beforeEach(() => {
    vi.mocked(signPreparedPayment).mockClear();
    useRealAccountStore.setState({ account: ACCOUNT_A });
  });

  afterEach(() => {
    for (const store of stores.splice(0)) store.getState().reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.mocked(signPreparedPayment).mockClear();
    useRealAccountStore.setState({ account: null });
  });

  /** Every fetch is recorded — including one no handler expects — so "nothing else was requested" is checked against all of them. */
  function server(handlers: Partial<Record<Key, Handler>>) {
    const calls: Array<{ key: Key | "other"; url: string; method: string; signal: AbortSignal | null }> = [];
    const counts: Record<Key, number> = { latest: 0, prepare: 0, cancel: 0, status: 0, submit: 0, lookup: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        const key: Key | null = url.endsWith("/api/real/payments/prepare")
          ? "prepare"
          : url.endsWith(LATEST_URL)
            ? "latest"
            : url.endsWith("/cancel")
              ? "cancel"
              : url.endsWith("/status")
                ? "status"
                : url.endsWith("/api/real/payments/submit")
                  ? "submit"
                  : url.endsWith("/api/real/recipients/lookup")
                    ? "lookup"
                    : null;
        calls.push({ key: key ?? "other", url, method, signal: init?.signal ?? null });
        const handler = key ? handlers[key] : undefined;
        if (!key || !handler) throw new Error(`unexpected fetch: ${method} ${url}`);
        counts[key] += 1;
        return handler(counts[key]);
      }),
    );
    return { calls, count: (key: Key) => calls.filter((call) => call.key === key).length, keys: () => calls.map((call) => call.key) };
  }

  function held() {
    let resolve: (response: Response) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const promise = new Promise<Response>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  /** Lets every already-queued continuation run (a Response body read takes a few turns). */
  async function settle() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  const attemptIn = (state: string, overrides: Record<string, unknown> = {}) => ({ ...baseAttempt(), id: stateAttemptId(state), state, ...overrides }) as never;
  // L-2 D-13 honest-fixture correction: the signing context only for awaiting_authorization, a reserved row without fields.
  const latestOf = (state: string, extra: Record<string, unknown> = {}) => () => jsonResponse(200, { ...honestLatestBody(attemptIn(state)), ...extra });
  const none = () => jsonResponse(200, { attempt: null });

  function newStore() {
    const store = createRealPaymentStore();
    stores.push(store);
    return store;
  }

  /** A store whose first read failed (HTTP 500) and is showing the unavailable state; later reads are `next`. */
  async function unavailableStore(next: Handler = none, others: Partial<Record<Key, Handler>> = {}) {
    const api = server({ latest: (n) => (n === 1 ? jsonResponse(500, { error: "boom" }) : next(n)), ...others });
    const store = newStore();
    await store.getState().init();
    expect(store.getState()).toMatchObject(UNAVAILABLE);
    return { api, store };
  }

  /** The established reload mapping: server state (and signing context) -> what the page shows. */
  const RESTORED = [
    ["prepared", {}, "stranded"],
    ["signed", {}, "stranded"],
    ["awaiting_authorization", {}, "awaiting_authorization"],
    ["awaiting_authorization", { subOrganizationId: null, authorizingCredentialId: null }, "stranded"],
    ["submitting", {}, "unknown"],
    ["submitted", {}, "submitted"],
    ["unknown", {}, "unknown"],
    ["confirmed", {}, "confirmed"],
    ["failed", {}, "failed"],
    ["cancelled", {}, "editing"],
  ] as const;

  describe("a trustworthy answer keeps the existing behavior", () => {
    it("200 { attempt: null }: the ordinary form, from exactly one GET that carries an abort signal and leaves no timer behind", async () => {
      vi.useFakeTimers();
      const api = server({ latest: none });
      const store = newStore();

      const pending = store.getState().init();
      expect(store.getState().status).toBe("idle"); // loading, synchronously
      await pending;

      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, error: null, prepareNeedsCheck: null });
      expect(api.calls).toHaveLength(1);
      expect(api.calls[0]).toMatchObject({ key: "latest", url: LATEST_URL, method: "GET" });
      expect(api.calls[0].signal).toBeInstanceOf(AbortSignal);
      // Settled: the deadline timer is gone, and it never fires afterwards.
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(STATUS_REQUEST_DEADLINE_MS * 3);
      expect(api.calls[0].signal?.aborted).toBe(false);
      expect(store.getState().status).toBe("editing");
      expect(api.calls).toHaveLength(1);
    });

    it.each(RESTORED)("a valid %s attempt (%j) is restored as %s — nothing is signed, submitted, prepared or cancelled", async (state, extra, shown) => {
      const api = server({ latest: latestOf(state, extra) });
      const store = newStore();
      await store.getState().init();

      expect(store.getState()).toMatchObject({ status: shown, attempt: { id: stateAttemptId(state), state } });
      expect(store.getState().status).not.toBe("status_unavailable");
      expect(api.keys()).toEqual(["latest"]);
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });

    it("the signing context comes only from the server: present -> resumable, absent -> cancel-only with the different-passkey message", async () => {
      server({ latest: (n) => (n === 1 ? latestOf("awaiting_authorization")() : latestOf("awaiting_authorization", { subOrganizationId: null, authorizingCredentialId: null })()) });
      const store = newStore();
      await store.getState().init();
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", error: null });

      await store.getState().init();
      expect(store.getState()).toMatchObject({ status: "stranded", subOrganizationId: null, authorizingCredentialId: null });
      expect(store.getState().error).toMatch(/different passkey/);
    });

    it("HTTP 401 keeps its old behavior: the plain form, no attempt, no error — and it is not 'unavailable'", async () => {
      const api = server({ latest: () => jsonResponse(401, { error: "Not authenticated." }) });
      const store = newStore();
      await store.getState().init();
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, subOrganizationId: null, error: null });
      expect(api.count("latest")).toBe(1);
    });
  });

  describe("anything else is 'status_unavailable' — never 'no payment'", () => {
    const hostile = { ...baseAttempt(), id: "attempt-hostile", state: "awaiting_authorization" };
    it.each([
      ["HTTP 404", () => jsonResponse(404, { error: "Not found." })],
      ["HTTP 404 whose body claims there is no payment", () => jsonResponse(404, { attempt: null })],
      ["HTTP 403", () => jsonResponse(403, { error: "Forbidden." })],
      ["HTTP 409", () => jsonResponse(409, { error: "Conflict." })],
      ["HTTP 429", () => jsonResponse(429, { error: "Slow down.", code: "rate_limited" })],
      ["HTTP 500", () => jsonResponse(500, { error: "boom" })],
      ["HTTP 500 whose body claims there is no payment", () => jsonResponse(500, { attempt: null })],
      ["HTTP 500 whose body carries an attempt", () => jsonResponse(500, { attempt: hostile, subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1" })],
      ["HTTP 503 with an HTML body", () => new Response("<html>Service Unavailable</html>", { status: 503 })],
      ["a network failure", () => {
        throw new TypeError("Failed to fetch");
      }],
      ["an HTTP 200 that is not JSON", () => new Response("<html>", { status: 200 })],
      ["an HTTP 200 with an empty body", () => new Response("", { status: 200 })],
      ["an HTTP 200 of JSON null", () => jsonResponse(200, null)],
      ["an HTTP 200 of a JSON array", () => jsonResponse(200, [])],
      ["a reply with no attempt key", () => jsonResponse(200, {})],
      ["a reply with no attempt key but a signing context", () => jsonResponse(200, { subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1" })],
      ["a string attempt", () => jsonResponse(200, { attempt: "nope", ...NO_SIGNING_CONTEXT, serverNowSeconds: Math.floor(Date.now() / 1000) })],
      ["a numeric attempt", () => jsonResponse(200, { attempt: 7, ...NO_SIGNING_CONTEXT, serverNowSeconds: Math.floor(Date.now() / 1000) })],
      ["a false attempt", () => jsonResponse(200, { attempt: false, ...NO_SIGNING_CONTEXT, serverNowSeconds: Math.floor(Date.now() / 1000) })],
      ["an array attempt", () => jsonResponse(200, { attempt: [], ...NO_SIGNING_CONTEXT, serverNowSeconds: Math.floor(Date.now() / 1000) })],
      ["an attempt of an unknown state", () => jsonResponse(200, { attempt: { ...baseAttempt(), state: "mystery" }, ...NO_SIGNING_CONTEXT, serverNowSeconds: Math.floor(Date.now() / 1000) })],
      ["an attempt with no state", () => jsonResponse(200, { attempt: { ...baseAttempt(), state: undefined }, ...NO_SIGNING_CONTEXT, serverNowSeconds: Math.floor(Date.now() / 1000) })],
      ["an attempt with no id", () => jsonResponse(200, { attempt: { ...baseAttempt(), id: undefined }, ...NO_SIGNING_CONTEXT, serverNowSeconds: Math.floor(Date.now() / 1000) })],
      ["an attempt with an empty id", () => jsonResponse(200, { attempt: { ...baseAttempt(), id: "" }, ...NO_SIGNING_CONTEXT, serverNowSeconds: Math.floor(Date.now() / 1000) })],
      ["an attempt with a numeric id", () => jsonResponse(200, { attempt: { ...baseAttempt(), id: 12 }, ...NO_SIGNING_CONTEXT, serverNowSeconds: Math.floor(Date.now() / 1000) })],
    ] as const)("%s: unavailable, nothing shown or kept, one GET, no retry — then an explicit check can succeed", async (_name, latest) => {
      const api = server({ latest: (n) => (n === 1 ? latest() : none()) });
      const store = newStore();
      store.setState({ recipientInput: ADDRESS, amountInput: "5" });

      await store.getState().init();

      expect(store.getState()).toMatchObject({ ...UNAVAILABLE, recipientInput: "", amountInput: "", prepareNeedsCheck: null, prepareCheck: "idle" });
      // No network, parse or server text reaches the state the page renders from.
      expect(JSON.stringify(store.getState())).not.toMatch(/Failed to fetch|boom|html|Unexpected|JSON|Not found|Forbidden|Conflict|Slow down|attempt-hostile/);
      expect(api.keys()).toEqual(["latest"]); // exactly one read: no automatic retry, nothing else
      expect(signPreparedPayment).not.toHaveBeenCalled();

      await store.getState().checkPaymentsAgain();
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, error: null });
      expect(api.keys()).toEqual(["latest", "latest"]);
    });

    it("nothing happens by itself afterwards: no retry, polling, prepare, cancel, submit or signing — however long the page stays open", async () => {
      vi.useFakeTimers();
      const { api, store } = await unavailableStore();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      store.getState().setPageVisible(false);
      store.getState().setPageVisible(true);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(api.keys()).toEqual(["latest"]);
      expect(store.getState()).toMatchObject(UNAVAILABLE);
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });

    it("an unexpected failure while restoring a payment fails closed: init() still resolves, and no half-restored payment or signing context is left on screen", async () => {
      const api = server({ latest: latestOf("awaiting_authorization") });
      const store = newStore();
      // A subscriber that throws exactly once, the moment the attempt is applied — i.e. in the middle of adoption.
      let thrown = false;
      const unsubscribe = store.subscribe((state) => {
        if (state.attempt && !thrown) {
          thrown = true;
          throw new Error("render exploded");
        }
      });

      await expect(store.getState().init()).resolves.toBeUndefined();
      unsubscribe();

      expect(thrown).toBe(true);
      expect(store.getState()).toMatchObject(UNAVAILABLE);
      expect(JSON.stringify(store.getState())).not.toMatch(/render exploded|sub-org-1|credential-1/);
      expect(api.keys()).toEqual(["latest"]);
    });

    it("a failed init clears a previous unresolved-prepare (D-1) flag — and Review is blocked by the unavailable state instead", async () => {
      const api = server({ latest: () => jsonResponse(500, { error: "boom" }) });
      const store = newStore();
      store.setState({ status: "editing", prepareNeedsCheck: "uncertain", prepareCheck: "unavailable" });

      await store.getState().init();

      expect(store.getState()).toMatchObject({ ...UNAVAILABLE, prepareNeedsCheck: null, prepareCheck: "idle" });
      store.getState().setRecipientInput(ADDRESS);
      store.getState().setAmountInput("1");
      await store.getState().review();
      expect(store.getState().status).toBe("status_unavailable");
      expect(api.keys()).toEqual(["latest"]);
    });
  });

  describe("the 45-second client deadline", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("a GET that never answers stays loading until the deadline, then is unavailable; the request is aborted; nothing is retried", async () => {
      const api = server({ latest: () => new Promise<Response>(() => {}) });
      const store = newStore();
      const pending = store.getState().init();

      await vi.advanceTimersByTimeAsync(STATUS_REQUEST_DEADLINE_MS - 1);
      expect(store.getState().status).toBe("idle");
      expect(api.calls[0].signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(store.getState()).toMatchObject(UNAVAILABLE);
      expect(api.calls[0].signal?.aborted).toBe(true);
      expect(JSON.stringify(store.getState())).not.toMatch(/longer than usual|abort|timed out/i);

      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(STATUS_REQUEST_DEADLINE_MS * 10);
      expect(api.keys()).toEqual(["latest"]);
      expect(store.getState()).toMatchObject(UNAVAILABLE);
    });

    it("a reply whose BODY never arrives is bounded by the same deadline", async () => {
      const api = server({ latest: () => ({ status: 200, ok: true, json: () => new Promise(() => {}) }) as unknown as Response });
      const store = newStore();
      const pending = store.getState().init();
      await vi.advanceTimersByTimeAsync(STATUS_REQUEST_DEADLINE_MS);
      await pending;
      expect(store.getState()).toMatchObject(UNAVAILABLE);
      expect(api.calls[0].signal?.aborted).toBe(true);
    });

    it("headers in time but a body that arrives only AFTER the deadline: that late body is ignored, even when it carries a payment", async () => {
      let deliver: (json: unknown) => void = () => {};
      const body = new Promise<unknown>((resolve) => (deliver = resolve));
      const api = server({ latest: () => ({ status: 200, ok: true, json: () => body }) as unknown as Response });
      const store = newStore();
      const pending = store.getState().init();
      await vi.advanceTimersByTimeAsync(STATUS_REQUEST_DEADLINE_MS);
      await pending;
      expect(store.getState()).toMatchObject(UNAVAILABLE);

      deliver({ attempt: attemptIn("awaiting_authorization"), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: Math.floor(Date.now() / 1000) });
      await vi.advanceTimersByTimeAsync(1_000);
      await settle();

      expect(store.getState()).toMatchObject(UNAVAILABLE);
      expect(api.keys()).toEqual(["latest"]);
    });

    it.each([
      ["a network failure", () => Promise.reject(new TypeError("Failed to fetch"))],
      ["an HTTP 500", () => jsonResponse(500, { error: "boom" })],
      ["a malformed reply", () => jsonResponse(200, {})],
    ] as const)("a read that fails outright (%s) leaves no timer behind and is never aborted later", async (_name, latest) => {
      const api = server({ latest: latest as Handler });
      const store = newStore();
      await store.getState().init();
      expect(store.getState()).toMatchObject(UNAVAILABLE);

      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(STATUS_REQUEST_DEADLINE_MS * 2);
      expect(api.calls[0].signal?.aborted).toBe(false);
      expect(api.keys()).toEqual(["latest"]);
    });

    it.each([
      ["a payment waiting for approval", (gate: ReturnType<typeof held>) => gate.resolve(latestOf("awaiting_authorization")())],
      ["'no payment'", (gate: ReturnType<typeof held>) => gate.resolve(none())],
      ["a rejection", (gate: ReturnType<typeof held>) => gate.reject(new TypeError("Failed to fetch"))],
      ["an abort rejection", (gate: ReturnType<typeof held>) => gate.reject(new DOMException("The operation was aborted.", "AbortError"))],
    ] as const)("an answer that arrives after the deadline (%s) is ignored — and is never an unhandled rejection", async (_name, late) => {
      const gate = held();
      const api = server({ latest: () => gate.promise });
      const store = newStore();
      const pending = store.getState().init();
      await vi.advanceTimersByTimeAsync(STATUS_REQUEST_DEADLINE_MS);
      await pending;
      expect(store.getState()).toMatchObject(UNAVAILABLE);

      late(gate);
      await vi.advanceTimersByTimeAsync(1_000);
      await settle();

      expect(store.getState()).toMatchObject(UNAVAILABLE);
      expect(api.keys()).toEqual(["latest"]);
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });

    it("the deadline never fires over a restored payment: adoption's own slow status read does not turn into 'unavailable'", async () => {
      // Already past its validity window, so adoption itself starts one (held) status read.
      const expired = { ...baseAttempt(), prepared: { ...PREPARED_FIELDS, validUntil: 1 } };
      const api = server({
        latest: () => jsonResponse(200, { attempt: expired, subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: Math.floor(Date.now() / 1000) }),
        status: () => new Promise<Response>(() => {}),
      });
      const store = newStore();
      const pending = store.getState().init();
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", attempt: { id: ATTEMPT_ID } });
      expect(api.keys()).toEqual(["latest", "status"]);

      await vi.advanceTimersByTimeAsync(STATUS_REQUEST_DEADLINE_MS * 2);
      await pending;

      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", attempt: { id: ATTEMPT_ID } });
      expect(api.calls[0].signal?.aborted).toBe(false); // the /latest read was never aborted: it had settled
      expect(api.count("latest")).toBe(1);
    });

    it("after a timeout another explicit check is allowed, is its own single GET, and can time out again", async () => {
      const api = server({ latest: (n) => (n < 3 ? new Promise<Response>(() => {}) : latestOf("prepared")()) });
      const store = newStore();
      const first = store.getState().init();
      await vi.advanceTimersByTimeAsync(STATUS_REQUEST_DEADLINE_MS);
      await first;
      expect(store.getState()).toMatchObject(UNAVAILABLE);

      const second = store.getState().checkPaymentsAgain();
      expect(store.getState().status).toBe("idle");
      await vi.advanceTimersByTimeAsync(STATUS_REQUEST_DEADLINE_MS);
      await second;
      expect(store.getState()).toMatchObject(UNAVAILABLE);
      expect(api.count("latest")).toBe(2);

      await store.getState().checkPaymentsAgain();
      expect(store.getState()).toMatchObject({ status: "stranded", attempt: { id: stateAttemptId("prepared") } });
      expect(api.keys()).toEqual(["latest", "latest", "latest"]);
    });

    it("an OLD request's timeout fires after a newer init already restored a payment: the newer state is untouched", async () => {
      const api = server({ latest: (n) => (n === 1 ? new Promise<Response>(() => {}) : latestOf("awaiting_authorization")()) });
      const store = newStore();
      const older = store.getState().init();
      await vi.advanceTimersByTimeAsync(30_000);
      await store.getState().init(); // e.g. the form's effect ran again
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", attempt: { id: stateAttemptId("awaiting_authorization") } });

      await vi.advanceTimersByTimeAsync(STATUS_REQUEST_DEADLINE_MS);
      await older;

      expect(api.calls[0].signal?.aborted).toBe(true); // only the old request's own wait ended
      expect(api.calls[1].signal?.aborted).toBe(false);
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", attempt: { id: stateAttemptId("awaiting_authorization") }, authorizingCredentialId: "credential-1" });
    });

    it("a timeout after an account switch is not applied to the other account", async () => {
      const api = server({ latest: (n) => (n === 1 ? new Promise<Response>(() => {}) : none()) });
      const store = newStore();
      const forA = store.getState().init();
      await vi.advanceTimersByTimeAsync(10_000);

      useRealAccountStore.setState({ account: ACCOUNT_B });
      await vi.advanceTimersByTimeAsync(STATUS_REQUEST_DEADLINE_MS);
      await forA;
      // Not applied at all: account B's own init() (the form's account effect) decides what B sees.
      expect(store.getState().status).toBe("idle");

      await store.getState().init();
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null });
      expect(api.count("latest")).toBe(2);
    });

    it("a timeout after reset() or detach() changes nothing", async () => {
      server({ latest: () => new Promise<Response>(() => {}) });
      const afterReset = newStore();
      const one = afterReset.getState().init();
      afterReset.getState().reset();
      const afterDetach = newStore();
      const two = afterDetach.getState().init();
      afterDetach.getState().detach();

      await vi.advanceTimersByTimeAsync(STATUS_REQUEST_DEADLINE_MS);
      await Promise.all([one, two]);

      expect(afterReset.getState()).toMatchObject({ status: "editing", attempt: null, error: null });
      expect(afterDetach.getState()).toMatchObject({ status: "idle", attempt: null, error: null });
    });
  });

  describe("stale answers never touch a newer lifecycle", () => {
    const LATE: ReadonlyArray<readonly [string, (gate: ReturnType<typeof held>) => void]> = [
      ["a payment", (gate) => gate.resolve(latestOf("awaiting_authorization")())],
      ["an HTTP 500", (gate) => gate.resolve(jsonResponse(500, { error: "boom" }))],
      ["a malformed reply", (gate) => gate.resolve(jsonResponse(200, {}))],
      ["a network failure", (gate) => gate.reject(new TypeError("Failed to fetch"))],
    ];

    it.each(LATE)("reset() during the GET, then %s: still the reset's clean form", async (_name, late) => {
      const gate = held();
      server({ latest: () => gate.promise });
      const store = newStore();
      const pending = store.getState().init();
      store.getState().reset();
      late(gate);
      await pending;
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, subOrganizationId: null, error: null });
    });

    it.each(LATE)("detach() during the GET, then %s: nothing is applied", async (_name, late) => {
      const gate = held();
      server({ latest: () => gate.promise });
      const store = newStore();
      const pending = store.getState().init();
      store.getState().detach();
      late(gate);
      await pending;
      expect(store.getState()).toMatchObject({ status: "idle", attempt: null, subOrganizationId: null, error: null });
    });

    it.each(LATE)("an account switch during the GET, then %s: nothing is applied to the other account", async (_name, late) => {
      const gate = held();
      server({ latest: () => gate.promise });
      const store = newStore();
      const pending = store.getState().init();
      useRealAccountStore.setState({ account: ACCOUNT_B });
      late(gate);
      await pending;
      expect(store.getState()).toMatchObject({ status: "idle", attempt: null, subOrganizationId: null, authorizingCredentialId: null, error: null });
    });

    it.each(LATE)("a remount (detach, init) while the first GET is pending, then %s from the first: only the remount's own answer counts", async (_name, late) => {
      const first = held();
      const second = held();
      const api = server({ latest: (n) => (n === 1 ? first.promise : second.promise) });
      const store = newStore();
      const older = store.getState().init();
      store.getState().detach();
      const newer = store.getState().init();

      late(first);
      await older;
      expect(store.getState()).toMatchObject({ status: "idle", attempt: null }); // the remount is still loading

      second.resolve(latestOf("prepared")());
      await newer;
      expect(store.getState()).toMatchObject({ status: "stranded", attempt: { id: stateAttemptId("prepared") } });
      expect(api.count("latest")).toBe(2);
    });

    it.each(LATE)("an older init answering with %s AFTER a newer init succeeded cannot overwrite it", async (_name, late) => {
      const first = held();
      server({ latest: (n) => (n === 1 ? first.promise : latestOf("submitted")()) });
      const store = newStore();
      const older = store.getState().init();
      await store.getState().init();
      expect(store.getState()).toMatchObject({ status: "submitted", attempt: { id: stateAttemptId("submitted") } });

      late(first);
      await older;
      expect(store.getState()).toMatchObject({ status: "submitted", attempt: { id: stateAttemptId("submitted"), state: "submitted" }, error: null });
    });

    it("a retry while the earlier request is still settling: the earlier answer is dropped, the retry's answer is the one applied", async () => {
      vi.useFakeTimers();
      const first = held();
      const second = held();
      const api = server({ latest: (n) => (n === 1 ? first.promise : n === 2 ? second.promise : none()) });
      const store = newStore();
      const initial = store.getState().init();
      await vi.advanceTimersByTimeAsync(STATUS_REQUEST_DEADLINE_MS);
      await initial;
      expect(store.getState()).toMatchObject(UNAVAILABLE);

      const retry = store.getState().checkPaymentsAgain();
      // The first request finally answers — with a payment — while the retry is loading.
      first.resolve(latestOf("awaiting_authorization")());
      await vi.advanceTimersByTimeAsync(0);
      await settle();
      expect(store.getState()).toMatchObject({ status: "idle", attempt: null, authorizingCredentialId: null });

      second.resolve(jsonResponse(503, { error: "later" }));
      await retry;
      expect(store.getState()).toMatchObject(UNAVAILABLE);

      await store.getState().checkPaymentsAgain();
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null });
      expect(api.keys()).toEqual(["latest", "latest", "latest"]);
    });
  });

  describe("nothing can be prepared while unavailable (store-level, not only the hidden form)", () => {
    it.each([
      ["an address", ADDRESS],
      ["an @name", "@smit"],
    ] as const)("review() refuses for %s: no review screen, no lookup, no request", async (_name, recipient) => {
      const { api, store } = await unavailableStore(none, { lookup: () => jsonResponse(200, { found: true, handle: "smit", displayName: "Smit Patel", isSelf: false }) });
      store.getState().setRecipientInput(recipient);
      store.getState().setAmountInput("1");

      await store.getState().review();

      expect(store.getState()).toMatchObject({ status: "status_unavailable", attempt: null, error: null });
      expect(api.keys()).toEqual(["latest"]);
    });

    it("confirmAndSend() refuses: no prepare, no signing, state unchanged", async () => {
      const { api, store } = await unavailableStore(none, { prepare: () => jsonResponse(200, { attempt: attemptIn("awaiting_authorization"), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: 1 }) });
      store.getState().setRecipientInput(ADDRESS);
      store.getState().setAmountInput("1");

      await store.getState().confirmAndSend();

      expect(store.getState()).toMatchObject({ status: "status_unavailable", attempt: null });
      expect(api.count("prepare")).toBe(0);
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });

    it("the same inputs DO reach prepare once the state is the ordinary form — the refusal above is the unavailable state's, not the fixture's", async () => {
      const api = server({ latest: none, prepare: () => jsonResponse(200, { attempt: attemptIn("awaiting_authorization"), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: Math.floor(Date.now() / 1000) }) });
      const store = newStore();
      await store.getState().init();
      store.getState().setRecipientInput(ADDRESS);
      store.getState().setAmountInput("1");
      await store.getState().review();
      expect(store.getState().status).toBe("reviewing");
      await store.getState().confirmAndSend();
      expect(api.count("prepare")).toBe(1);
    });

    it("no other action is a way out: editAgain, cancel, resumeAuthorization, lookupRecipient, checkStatus, checkSubmittedStatus, checkPreparedPayment and typing all leave it unavailable and send nothing", async () => {
      const { api, store } = await unavailableStore(none, { cancel: () => jsonResponse(200, { attempt: null }), lookup: () => jsonResponse(200, { found: false }) });

      store.getState().editAgain();
      await store.getState().cancel();
      await store.getState().resumeAuthorization();
      store.getState().setRecipientInput("@smit");
      store.getState().setAmountInput("1");
      await store.getState().lookupRecipient();
      await store.getState().checkStatus();
      await store.getState().checkSubmittedStatus();
      store.setState({ prepareNeedsCheck: "uncertain" });
      await store.getState().checkPreparedPayment();

      expect(store.getState()).toMatchObject({ status: "status_unavailable", attempt: null });
      expect(api.keys()).toEqual(["latest"]);
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });
  });

  describe("checkPaymentsAgain(): the explicit retry", () => {
    it.each(["idle", "editing", "reviewing", "preparing", "awaiting_authorization", "submitting", "submitted", "confirmed", "failed", "unknown", "stranded"] as const)("does nothing while the status is %s", async (status) => {
      const api = server({ latest: none });
      const store = newStore();
      store.setState({ status, recipientInput: ADDRESS, amountInput: "1" });

      await store.getState().checkPaymentsAgain();

      expect(api.calls).toHaveLength(0);
      expect(store.getState()).toMatchObject({ status, recipientInput: ADDRESS, amountInput: "1" });
    });

    it("does nothing after detach() (the Pay form is gone)", async () => {
      const { api, store } = await unavailableStore();
      store.getState().detach();
      expect(store.getState().status).toBe("status_unavailable");

      await store.getState().checkPaymentsAgain();

      expect(api.keys()).toEqual(["latest"]);
      expect(store.getState().status).toBe("status_unavailable");
    });

    it("rapid repeated presses send exactly one GET, and the page is loading meanwhile", async () => {
      const gate = held();
      const { api, store } = await unavailableStore(() => gate.promise);

      const first = store.getState().checkPaymentsAgain();
      const second = store.getState().checkPaymentsAgain();
      const third = store.getState().checkPaymentsAgain();
      expect(store.getState().status).toBe("idle");
      expect(api.count("latest")).toBe(2); // the failed mount read + exactly one retry

      gate.resolve(none());
      await Promise.all([first, second, third]);

      expect(api.keys()).toEqual(["latest", "latest"]);
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null });
    });

    it("a retry that fails again stays unavailable; each press is its own single GET", async () => {
      const { api, store } = await unavailableStore((n) => (n === 2 ? jsonResponse(200, {}) : n === 3 ? Promise.reject(new TypeError("Failed to fetch")) : none()));

      await store.getState().checkPaymentsAgain();
      expect(store.getState()).toMatchObject(UNAVAILABLE);
      expect(api.count("latest")).toBe(2);

      await store.getState().checkPaymentsAgain();
      expect(store.getState()).toMatchObject(UNAVAILABLE);
      expect(api.count("latest")).toBe(3);

      await store.getState().checkPaymentsAgain();
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null });
      expect(api.keys()).toEqual(["latest", "latest", "latest", "latest"]);
    });

    it("a retry that finds the session gone (401) shows the plain form, as init always has", async () => {
      const { store } = await unavailableStore(() => jsonResponse(401, { error: "Not authenticated." }));
      await store.getState().checkPaymentsAgain();
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, error: null });
    });

    it.each(RESTORED)("a successful retry restores a %s attempt (%j) as %s — by reading only, with no prepare, submit, cancel or signing", async (state, extra, shown) => {
      const { api, store } = await unavailableStore(latestOf(state, extra));

      await store.getState().checkPaymentsAgain();

      expect(store.getState()).toMatchObject({ status: shown, attempt: { id: stateAttemptId(state), state } });
      expect(api.keys()).toEqual(["latest", "latest"]);
      expect(api.calls.every((call) => call.method === "GET")).toBe(true);
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });
  });

  describe("D-1's prepare recovery is unchanged", () => {
    /** Review and Approve an address payment whose prepare ends in HTTP 500; later /latest reads are `latest`. */
    async function afterUnresolvedPrepare(latest: Handler) {
      const api = server({ latest: (n) => (n === 1 ? none() : latest(n)), prepare: () => jsonResponse(500, { error: "Something went wrong." }) });
      const store = newStore();
      await store.getState().init();
      store.getState().setRecipientInput(ADDRESS);
      store.getState().setAmountInput("1");
      await store.getState().review();
      await store.getState().confirmAndSend();
      expect(store.getState()).toMatchObject({ status: "editing", prepareNeedsCheck: "uncertain", prepareCheck: "idle" });
      return { api, store };
    }

    it("a failed D-1 check stays on the form with its own 'unavailable' check result — it never becomes status_unavailable, and Check again does nothing there", async () => {
      const { api, store } = await afterUnresolvedPrepare(() => jsonResponse(500, { error: "boom" }));

      await store.getState().checkPreparedPayment();
      expect(store.getState()).toMatchObject({ status: "editing", prepareNeedsCheck: "uncertain", prepareCheck: "unavailable", recipientInput: ADDRESS, amountInput: "1" });

      await store.getState().checkPaymentsAgain();
      expect(store.getState()).toMatchObject({ status: "editing", prepareNeedsCheck: "uncertain", prepareCheck: "unavailable", recipientInput: ADDRESS, amountInput: "1" });
      expect(api.keys()).toEqual(["latest", "prepare", "latest"]);
    });

    it.each(["confirmed", "failed"] as const)("the same %s answer: the D-1 check does NOT adopt it, while a reload (init) still restores it", async (state) => {
      const { store } = await afterUnresolvedPrepare(latestOf(state));

      await store.getState().checkPreparedPayment();
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, prepareNeedsCheck: null, prepareCheck: "nothing_found" });

      await store.getState().init();
      expect(store.getState()).toMatchObject({ status: state, attempt: { id: stateAttemptId(state), state } });
    });
  });
});

/**
 * L-2 D-2: the prepare route answers HTTP 409 for two different things. Only
 * the exact pair "HTTP 409 + code 'account_not_ready'" is a definitive refusal
 * (nothing was started; there is nothing to check): the ordinary form returns
 * with fixed copy and the typed text. Every other 409 keeps D-1's "check the
 * payment's status" requirement, and nothing uncertain (500, network failure,
 * unreadable reply) ever becomes a definitive refusal. Fake server only: no
 * network, no signing, no Turnkey, no bundler.
 */
describe("real-payment-store — L-2 D-2: prepare 409 disambiguation (account not ready)", () => {
  const ADDRESS = "0x3333333333333333333333333333333333333333";
  const ACCOUNT_A = { appUserId: "app-user-1", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222" };
  const ACCOUNT_B = { appUserId: "app-user-2", ownerAddress: "0x4444444444444444444444444444444444444444", safeAddress: "0x5555555555555555555555555555555555555555" };
  const SERVER_SENTENCE = "Your account isn't fully set up yet.";
  const NOT_READY_BODY = { error: SERVER_SENTENCE, code: "account_not_ready" };
  const FIXED_NOT_READY = "We can't send payments from this account right now. This payment wasn't started.";
  const UNCERTAIN_BODY = { error: "We couldn't confirm this payment's setup. No money was sent by this request. Refresh the app to check its status before trying again.", code: "prepare_outcome_uncertain" };

  type Key = "prepare" | "latest" | "cancel" | "status" | "submit";
  type Handler = (n: number) => Response | Promise<Response>;
  const stores: Array<ReturnType<typeof createRealPaymentStore>> = [];

  beforeEach(() => {
    vi.mocked(signPreparedPayment).mockClear();
  });

  afterEach(() => {
    for (const store of stores.splice(0)) store.getState().reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.mocked(signPreparedPayment).mockClear();
    useRealAccountStore.setState({ account: null });
  });

  function server(handlers: Partial<Record<Key, Handler>>) {
    const calls: Array<{ key: Key; url: string; method: string }> = [];
    const counts: Record<Key, number> = { prepare: 0, latest: 0, cancel: 0, status: 0, submit: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        const key: Key | null = url.endsWith("/api/real/payments/prepare") ? "prepare" : url.endsWith("/api/real/payments/latest") ? "latest" : url.endsWith("/cancel") ? "cancel" : url.endsWith("/status") ? "status" : url.endsWith("/api/real/payments/submit") ? "submit" : null;
        const handler = key ? handlers[key] : undefined;
        if (!key || !handler) throw new Error(`unexpected fetch: ${method} ${url}`);
        calls.push({ key, url, method });
        counts[key] += 1;
        return handler(counts[key]);
      }),
    );
    return { calls, count: (key: Key) => calls.filter((call) => call.key === key).length, keys: () => calls.map((call) => call.key) };
  }

  function held() {
    let resolve: (response: Response) => void = () => {};
    const promise = new Promise<Response>((res) => (resolve = res));
    return { promise, resolve };
  }

  function newStore() {
    useRealAccountStore.setState({ account: ACCOUNT_A });
    const store = createRealPaymentStore();
    stores.push(store);
    store.setState({ status: "editing" });
    store.getState().setRecipientInput(ADDRESS);
    store.getState().setAmountInput("1");
    return store;
  }

  /** Drives a fresh store through Review and Approve; `prepare` decides how the request ends. */
  async function afterPrepare(prepare: Handler, others: Partial<Record<Key, Handler>> = {}) {
    const api = server({ prepare, ...others });
    const store = newStore();
    await store.getState().review();
    expect(store.getState().status).toBe("reviewing");
    await store.getState().confirmAndSend();
    return { api, store };
  }

  const notReady = () => jsonResponse(409, NOT_READY_BODY);

  describe("the exact refusal: HTTP 409 + code 'account_not_ready'", () => {
    it("returns to ordinary editing with the fixed copy, the typed text, no status-check requirement, and nothing else happens", async () => {
      const { api, store } = await afterPrepare(notReady);

      expect(store.getState()).toMatchObject({
        status: "editing",
        error: FIXED_NOT_READY,
        recipientInput: ADDRESS,
        amountInput: "1",
        prepareNeedsCheck: null,
        prepareCheck: "idle",
        attempt: null,
        subOrganizationId: null,
        authorizingCredentialId: null,
        pendingSubmission: null,
        isAuthorizing: false,
        isCancelling: false,
      });
      // One prepare and nothing else: no /latest, no retry, no cancel, no status read, no signing, no submit.
      expect(api.keys()).toEqual(["prepare"]);
      expect(api.calls[0]).toMatchObject({ method: "POST" });
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });

    it("the exported constant is the approved wording, and the server's own sentence is never kept", async () => {
      const { PREPARE_ACCOUNT_NOT_READY_MESSAGE } = await import("@/lib/stores/real-payment-store");
      expect(PREPARE_ACCOUNT_NOT_READY_MESSAGE).toBe(FIXED_NOT_READY);

      const { store } = await afterPrepare(notReady);
      expect(store.getState().error).toBe(FIXED_NOT_READY);
      expect(JSON.stringify(store.getState())).not.toContain(SERVER_SENTENCE);
    });

    it.each([
      ["a different sentence", { error: "Anything at all — <b>not shown</b>.", code: "account_not_ready" }],
      ["no sentence", { code: "account_not_ready" }],
      ["extra fields", { error: SERVER_SENTENCE, code: "account_not_ready", retryable: true, detail: "0xdeadbeef" }],
    ] as const)("is decided by status and code only, never by the sentence (%s)", async (_name, body) => {
      const { api, store } = await afterPrepare(() => jsonResponse(409, body));

      expect(store.getState()).toMatchObject({ status: "editing", error: FIXED_NOT_READY, prepareNeedsCheck: null, recipientInput: ADDRESS, amountInput: "1" });
      expect(JSON.stringify(store.getState())).not.toMatch(/not shown|deadbeef/);
      expect(api.keys()).toEqual(["prepare"]);
    });

    it("nothing follows by itself — a day later there has still been exactly one request", async () => {
      vi.useFakeTimers();
      const { api, store } = await afterPrepare(notReady);

      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

      expect(api.keys()).toEqual(["prepare"]);
      expect(store.getState()).toMatchObject({ status: "editing", error: FIXED_NOT_READY, prepareNeedsCheck: null });
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });

    it("'Check payment status' and Cancel have nothing to act on: neither sends a request", async () => {
      const { api, store } = await afterPrepare(notReady, { latest: () => jsonResponse(200, { attempt: null }), cancel: () => jsonResponse(200, {}) });

      await store.getState().checkPreparedPayment();
      await store.getState().cancel();
      await store.getState().resumeAuthorization();

      expect(api.keys()).toEqual(["prepare"]);
      expect(store.getState()).toMatchObject({ status: "editing", prepareNeedsCheck: null, prepareCheck: "idle", attempt: null });
    });

    it("editing a field clears the message like any other form error", async () => {
      const { store } = await afterPrepare(notReady);

      store.getState().setAmountInput("2");

      expect(store.getState()).toMatchObject({ status: "editing", error: null, amountInput: "2", recipientInput: ADDRESS, prepareNeedsCheck: null });
    });

    it("a handle payment gets the same answer and keeps its resolved name (the refusal is not about the recipient)", async () => {
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          calls.push(url);
          if (url.endsWith("/api/real/recipients/lookup")) return jsonResponse(200, { found: true, handle: "smit", displayName: "Smit Patel", isSelf: false });
          if (url.endsWith("/api/real/payments/prepare")) return notReady();
          throw new Error(`unexpected fetch: ${url}`);
        }),
      );
      useRealAccountStore.setState({ account: ACCOUNT_A });
      const store = createRealPaymentStore();
      stores.push(store);
      store.setState({ status: "editing" });
      store.getState().setRecipientInput("@smit");
      store.getState().setAmountInput("1");
      await store.getState().review();
      expect(store.getState().status).toBe("reviewing");

      await store.getState().confirmAndSend();

      expect(store.getState()).toMatchObject({ status: "editing", error: FIXED_NOT_READY, recipientInput: "@smit", amountInput: "1", prepareNeedsCheck: null, recipientLookup: { status: "found", handle: "smit", displayName: "Smit Patel", isSelf: false } });
      expect(calls.filter((url) => url.endsWith("/prepare"))).toHaveLength(1);
      expect(calls.filter((url) => url.endsWith("/lookup"))).toHaveLength(1);
    });
  });

  describe("every other HTTP 409 keeps D-1's status-check requirement", () => {
    it.each([
      ["no code (the in-progress sentence)", { error: "You already have a payment in progress." }],
      ["no code (the account sentence alone is not enough)", { error: SERVER_SENTENCE }],
      ["code 'payment_in_progress'", { error: "You already have a payment in progress.", code: "payment_in_progress" }],
      ["an unknown code", { error: SERVER_SENTENCE, code: "account_locked" }],
      ["an empty code", { error: SERVER_SENTENCE, code: "" }],
      ["upper case", { error: SERVER_SENTENCE, code: "ACCOUNT_NOT_READY" }],
      ["mixed case", { error: SERVER_SENTENCE, code: "Account_Not_Ready" }],
      ["leading whitespace", { error: SERVER_SENTENCE, code: " account_not_ready" }],
      ["trailing whitespace", { error: SERVER_SENTENCE, code: "account_not_ready\n" }],
      ["a longer code that contains it", { error: SERVER_SENTENCE, code: "account_not_ready_yet" }],
      ["a hyphenated look-alike", { error: SERVER_SENTENCE, code: "account-not-ready" }],
      ["a numeric code", { error: SERVER_SENTENCE, code: 409 }],
      ["a null code", { error: SERVER_SENTENCE, code: null }],
      ["a boolean code", { error: SERVER_SENTENCE, code: true }],
      ["an array code", { error: SERVER_SENTENCE, code: ["account_not_ready"] }],
      ["an object code", { error: SERVER_SENTENCE, code: { value: "account_not_ready" } }],
      ["the code as the error text", { error: "account_not_ready" }],
      ["the code under another key", { error: SERVER_SENTENCE, outcome: "account_not_ready", reason: "account_not_ready" }],
      ["a nested code", { error: SERVER_SENTENCE, data: { code: "account_not_ready" } }],
      ["a JSON string body", "account_not_ready"],
      ["a JSON array body", [{ code: "account_not_ready" }]],
    ] as const)("%s: in_progress, no fixed refusal copy, Review refused until checked", async (_name, body) => {
      const { api, store } = await afterPrepare(() => jsonResponse(409, body));

      expect(store.getState()).toMatchObject({ status: "editing", prepareNeedsCheck: "in_progress", prepareCheck: "idle", error: null, recipientInput: ADDRESS, amountInput: "1", attempt: null });
      expect(api.keys()).toEqual(["prepare"]);
      expect(signPreparedPayment).not.toHaveBeenCalled();

      // D-1's safeguard is intact: no second prepare while the check is outstanding.
      await store.getState().review();
      expect(store.getState().status).toBe("editing");
      store.setState({ status: "reviewing" });
      await store.getState().confirmAndSend();
      expect(api.count("prepare")).toBe(1);
      expect(store.getState().prepareNeedsCheck).toBe("in_progress");
    });

    it("a real in-progress 409 still leads to the explicit check, which adopts the server's active payment", async () => {
      const active = { ...baseAttempt(), id: ACTIVE_ATTEMPT_ID, state: "submitted" };
      const { api, store } = await afterPrepare(() => jsonResponse(409, { error: "You already have a payment in progress." }), {
        latest: () => jsonResponse(200, honestLatestBody(active)),
        status: () => jsonResponse(200, { attempt: active, reconciliationDeferred: false, serverNowSeconds: Math.floor(Date.now() / 1000) }),
      });
      expect(store.getState()).toMatchObject({ status: "editing", prepareNeedsCheck: "in_progress" });
      expect(api.keys()).toEqual(["prepare"]);

      await store.getState().checkPreparedPayment();

      expect(store.getState()).toMatchObject({ status: "submitted", attempt: { id: ACTIVE_ATTEMPT_ID, state: "submitted" }, prepareNeedsCheck: null });
      expect(api.keys().slice(0, 2)).toEqual(["prepare", "latest"]);
      expect(api.count("prepare")).toBe(1);
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });
  });

  describe("nothing uncertain becomes a definitive refusal", () => {
    it.each([
      ["an HTTP 409 with an HTML body", () => new Response("<html>409 Conflict</html>", { status: 409 })],
      ["an HTTP 409 with an empty body", () => new Response("", { status: 409 })],
      ["an HTTP 409 whose plain-text body names the code", () => new Response("account_not_ready", { status: 409 })],
      ["an HTTP 409 with truncated JSON", () => new Response('{"error":"Your account isn\'t fully set up yet.","code":"account_not_ready"', { status: 409 })],
      ["an HTTP 409 whose JSON body is null", () => jsonResponse(409, null)],
      ["an HTTP 500 carrying the code", () => jsonResponse(500, NOT_READY_BODY)],
      ["an HTTP 500 carrying the code and no sentence", () => jsonResponse(500, { code: "account_not_ready" })],
      ["the server's prepare_outcome_uncertain (C-1)", () => jsonResponse(500, UNCERTAIN_BODY)],
      ["a generic HTTP 500", () => jsonResponse(500, { error: "Something went wrong. Please try again." })],
      ["an unreadable success reply that names the code", () => new Response("account_not_ready", { status: 200 })],
    ] as const)("%s: uncertain — a status check is required and no refusal copy is shown", async (_name, prepare) => {
      const { api, store } = await afterPrepare(prepare);

      expect(store.getState()).toMatchObject({ status: "editing", prepareNeedsCheck: "uncertain", prepareCheck: "idle", error: null, recipientInput: ADDRESS, amountInput: "1", attempt: null });
      expect(api.keys()).toEqual(["prepare"]);
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });

    it.each([
      ["a rejected fetch ('Failed to fetch')", new TypeError("Failed to fetch")],
      ["a rejected fetch whose message names the code", new Error("account_not_ready")],
      ["a rejected fetch shaped like the refusal", Object.assign(new Error(SERVER_SENTENCE), { status: 409, code: "account_not_ready" })],
    ] as const)("%s: uncertain — only a real HTTP answer can be a refusal", async (_name, failure) => {
      const { api, store } = await afterPrepare(() => {
        throw failure;
      });

      expect(store.getState()).toMatchObject({ status: "editing", prepareNeedsCheck: "uncertain", error: null, recipientInput: ADDRESS, amountInput: "1" });
      expect(api.keys()).toEqual(["prepare"]);
    });

    it.each([400, 401, 404, 429, 502, 503] as const)("HTTP %i carrying the code keeps its existing handling: the server's message, no fixed refusal copy, no check requirement", async (status) => {
      const { api, store } = await afterPrepare(() => jsonResponse(status, { error: "The server's own message.", code: "account_not_ready" }));

      expect(store.getState()).toMatchObject({ status: "editing", error: "The server's own message.", prepareNeedsCheck: null, recipientInput: ADDRESS, amountInput: "1" });
      expect(api.keys()).toEqual(["prepare"]);
    });
  });

  describe("a late refusal is discarded", () => {
    async function pendingPrepare() {
      const gate = held();
      const api = server({ prepare: () => gate.promise, latest: () => jsonResponse(200, { attempt: null }) });
      const store = newStore();
      await store.getState().review();
      const pending = store.getState().confirmAndSend();
      expect(store.getState().status).toBe("preparing");
      return { api, store, pending, answer: () => gate.resolve(notReady()) };
    }

    it("after reset(): the fresh form shows no refusal and no typed text", async () => {
      const { api, store, pending, answer } = await pendingPrepare();

      store.getState().reset();
      answer();
      await pending;

      expect(store.getState()).toMatchObject({ status: "editing", error: null, prepareNeedsCheck: null, prepareCheck: "idle", recipientInput: "", amountInput: "", attempt: null });
      expect(api.keys()).toEqual(["prepare"]);
    });

    it("after detach(): nothing is written", async () => {
      const { api, store, pending, answer } = await pendingPrepare();

      store.getState().detach();
      const before = store.getState();
      answer();
      await pending;

      expect(store.getState()).toBe(before);
      expect(store.getState()).toMatchObject({ error: null, prepareNeedsCheck: null });
      expect(api.keys()).toEqual(["prepare"]);
    });

    it("after an account switch: the other account never sees it", async () => {
      const { api, store, pending, answer } = await pendingPrepare();

      useRealAccountStore.setState({ account: ACCOUNT_B });
      const before = store.getState();
      answer();
      await pending;

      expect(store.getState()).toBe(before);
      expect(store.getState()).toMatchObject({ error: null, prepareNeedsCheck: null });
      expect(api.keys()).toEqual(["prepare"]);
    });

    it("after a new lifecycle's init(): the new page keeps what init found", async () => {
      const { api, store, pending, answer } = await pendingPrepare();

      await store.getState().init();
      expect(store.getState()).toMatchObject({ status: "editing", error: null, recipientInput: "" });
      answer();
      await pending;

      expect(store.getState()).toMatchObject({ status: "editing", error: null, prepareNeedsCheck: null, recipientInput: "", amountInput: "" });
      expect(api.keys()).toEqual(["prepare", "latest"]);
    });

    it("after sign-out: nothing is written", async () => {
      const { store, pending, answer } = await pendingPrepare();

      useRealAccountStore.setState({ account: null });
      const before = store.getState();
      answer();
      await pending;

      expect(store.getState()).toBe(before);
    });
  });

  describe("a second explicit Review", () => {
    it("sends exactly one further prepare; the same refusal returns the same state (the accepted repeat)", async () => {
      const { api, store } = await afterPrepare(notReady);
      expect(api.count("prepare")).toBe(1);

      await store.getState().review();
      expect(store.getState()).toMatchObject({ status: "reviewing", error: null });
      expect(api.count("prepare")).toBe(1); // Review alone prepares nothing

      await store.getState().confirmAndSend();

      expect(api.keys()).toEqual(["prepare", "prepare"]);
      expect(store.getState()).toMatchObject({ status: "editing", error: FIXED_NOT_READY, prepareNeedsCheck: null, recipientInput: ADDRESS, amountInput: "1", attempt: null });
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });

    it("a later attempt that the server accepts proceeds normally, with the message gone", async () => {
      // The passkey prompt is dismissed (set here, not left to whatever an earlier suite installed), so the accepted payment simply waits.
      vi.mocked(signPreparedPayment).mockRejectedValueOnce(Object.assign(new Error("dismissed"), { name: "NotAllowedError" }));
      const ready = { attempt: { ...baseAttempt(), id: PREPARED_ID, recipient: ADDRESS }, subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: Math.floor(Date.now() / 1000) };
      const { api, store } = await afterPrepare((n) => (n === 1 ? notReady() : jsonResponse(200, ready)));

      await store.getState().review();
      await store.getState().confirmAndSend();

      expect(api.keys()).toEqual(["prepare", "prepare"]);
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", attempt: { id: PREPARED_ID }, prepareNeedsCheck: null });
      expect(store.getState().error).not.toBe(FIXED_NOT_READY);
      expect(signPreparedPayment).toHaveBeenCalledTimes(1); // the stubbed passkey prompt, dismissed — for the accepted payment only
      expect(api.count("submit")).toBe(0);
    });

    it("a later 409 without the code asks for the status check as before", async () => {
      const { api, store } = await afterPrepare((n) => (n === 1 ? notReady() : jsonResponse(409, { error: "You already have a payment in progress." })));

      await store.getState().review();
      await store.getState().confirmAndSend();

      expect(api.keys()).toEqual(["prepare", "prepare"]);
      expect(store.getState()).toMatchObject({ status: "editing", error: null, prepareNeedsCheck: "in_progress", prepareCheck: "idle" });
    });

    it("the old loop is closed: 409 in progress -> check finds nothing -> Review -> the refusal ends on the form, not on another check", async () => {
      const { api, store } = await afterPrepare((n) => (n === 1 ? jsonResponse(409, { error: "You already have a payment in progress." }) : notReady()), { latest: () => jsonResponse(200, { attempt: null }) });
      expect(store.getState().prepareNeedsCheck).toBe("in_progress");

      await store.getState().checkPreparedPayment();
      expect(store.getState()).toMatchObject({ prepareNeedsCheck: null, prepareCheck: "nothing_found" });
      await store.getState().review();
      await store.getState().confirmAndSend();

      expect(api.keys()).toEqual(["prepare", "latest", "prepare"]);
      expect(store.getState()).toMatchObject({ status: "editing", error: FIXED_NOT_READY, prepareNeedsCheck: null, prepareCheck: "idle" });
    });
  });

  describe("D-3a is untouched", () => {
    it("the refusal never becomes status_unavailable, and 'Check again' does nothing on the form", async () => {
      const { api, store } = await afterPrepare(notReady, { latest: () => jsonResponse(200, { attempt: null }) });

      await store.getState().checkPaymentsAgain();

      expect(store.getState()).toMatchObject({ status: "editing", error: FIXED_NOT_READY, prepareNeedsCheck: null });
      expect(api.keys()).toEqual(["prepare"]);
    });

    it("a failed first read is still status_unavailable — even when its 409 carries the code — and nothing can be prepared there", async () => {
      const api = server({ latest: () => jsonResponse(409, NOT_READY_BODY), prepare: notReady });
      useRealAccountStore.setState({ account: ACCOUNT_A });
      const store = createRealPaymentStore();
      stores.push(store);

      await store.getState().init();
      expect(store.getState()).toMatchObject({ status: "status_unavailable", error: null, attempt: null });

      store.getState().setRecipientInput(ADDRESS);
      store.getState().setAmountInput("1");
      await store.getState().review();
      await store.getState().confirmAndSend();

      expect(store.getState().status).toBe("status_unavailable");
      expect(api.keys()).toEqual(["latest"]);
    });

    it("a new lifecycle's init() drops the refusal message and reads /latest once", async () => {
      const { api, store } = await afterPrepare(notReady, { latest: () => jsonResponse(200, { attempt: null }) });

      await store.getState().init();

      expect(store.getState()).toMatchObject({ status: "editing", error: null, prepareNeedsCheck: null, recipientInput: "", amountInput: "" });
      expect(api.keys()).toEqual(["prepare", "latest"]);
    });
  });
});

/**
 * L-2 D-4: the submit route answers HTTP 409 for two different things. Only the
 * exact pair "HTTP 409 + code 'wrong_passkey'" is definitive about THIS request
 * (the server refused it before any claim or dispatch, because the payment is
 * bound to another passkey): the page goes straight to the cancel-only screen a
 * reload would give — the approval and the credential it was made with are
 * dropped, the payment and the account context stay, and nothing is cancelled,
 * retried, signed or sent by itself. Every other failed submit stays "unknown"
 * with its approval kept, and shows fixed copy instead of the server's sentence
 * or raw network/parse text. Fake server and fake clock only: no network, no
 * passkey ceremony, no Turnkey, no bundler.
 */
describe("real-payment-store — L-2 D-4: submit refusal disambiguation (exact wrong_passkey)", () => {
  const ADDRESS = "0x3333333333333333333333333333333333333333";
  const ACCOUNT_A = { appUserId: "app-user-1", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222" };
  const ACCOUNT_B = { appUserId: "app-user-2", ownerAddress: "0x4444444444444444444444444444444444444444", safeAddress: "0x5555555555555555555555555555555555555555" };
  const T0_MS = 1_800_000_000_000; // a whole second, so boundary arithmetic is exact
  const OTHER_PASSKEY = "This payment was started with a different passkey. Cancel it and start a new payment.";
  const NEUTRAL = "We couldn't confirm whether this payment was sent. Check its status before trying again.";
  const CANCEL_LOST_RACE = "This payment could not be cancelled — it may already be on its way.";
  const CANCEL_UNCONFIRMED = "Could not confirm whether this payment was cancelled. Check its status before trying again.";
  const UNAVAILABLE_SENTENCE = "We couldn't confirm your passkey approval yet. Try again in a moment.";
  const BUDGET_SENTENCE = "Too many tries right now. Wait a moment, then tap Continue.";
  const WRONG_PASSKEY_BODY = { error: OTHER_PASSKEY, code: "wrong_passkey" };
  /** What the one passkey approval of this suite produces, and so what /submit is sent. */
  const APPROVAL = { attemptId: ATTEMPT_ID, signature: "0xsig-d4", activityId: "activity-d4" };
  /** Server sentences, state names and raw network/parse text that must never be kept for display. */
  const RAW_TEXT = /Failed to fetch|Cannot read|Unexpected|not valid JSON|Not authenticated|Payment not found|no longer awaiting|\(state:|could not be verified|Something went wrong|Request failed|boom|aborted/;

  type Key = "prepare" | "latest" | "cancel" | "status" | "submit" | "balance";
  type Handler = (n: number) => Response | Promise<Response>;
  type Store = ReturnType<typeof createRealPaymentStore>;
  const stores: Store[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0_MS);
    // Self-contained: whatever an earlier suite left on the shared signing mock
    // (a persistent implementation or queued one-time ones) is dropped first,
    // and this suite installs its own approval for every test.
    vi.mocked(signPreparedPayment).mockReset();
    vi.mocked(signPreparedPayment).mockResolvedValue({ signature: APPROVAL.signature, activityId: APPROVAL.activityId } as never);
    useRealAccountStore.setState({ account: ACCOUNT_A });
  });

  afterEach(async () => {
    for (const store of stores.splice(0)) store.getState().reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    // Nothing of this suite's stays on the shared mock or the shared stores.
    vi.mocked(signPreparedPayment).mockReset();
    useRealAccountStore.setState({ account: null });
    (await import("@/lib/stores/real-balance-store")).useRealBalanceStore.getState().reset();
  });

  /** Every request is recorded — including one no handler expects, which also fails the request. */
  function server(handlers: Partial<Record<Key, Handler>>) {
    const calls: Array<{ key: Key | "other"; url: string; method: string; body: unknown }> = [];
    const counts: Record<Key, number> = { prepare: 0, latest: 0, cancel: 0, status: 0, submit: 0, balance: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        const key: Key | null = url.endsWith("/api/real/payments/prepare")
          ? "prepare"
          : url.endsWith("/api/real/payments/latest")
            ? "latest"
            : url.endsWith("/cancel")
              ? "cancel"
              : url.endsWith("/status")
                ? "status"
                : url.endsWith("/api/real/payments/submit")
                  ? "submit"
                  : url.endsWith("/api/real/account/balance")
                    ? "balance"
                    : null;
        calls.push({ key: key ?? "other", url, method, body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined });
        const handler = key ? handlers[key] : undefined;
        if (!key || !handler) throw new Error(`unexpected fetch: ${method} ${url}`);
        counts[key] += 1;
        return handler(counts[key]);
      }),
    );
    return {
      calls,
      keys: () => calls.map((call) => call.key),
      count: (key: Key) => calls.filter((call) => call.key === key).length,
      /** Everything that is not a read. */
      writes: () => calls.filter((call) => call.method !== "GET").map((call) => call.key),
    };
  }

  function held() {
    let resolve: (response: Response) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const promise = new Promise<Response>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const settle = () => vi.advanceTimersByTimeAsync(0);
  /** The advisory clock offset that puts the approval window's end `secondsBeforeExpiry` after T0. */
  const offsetFor = (secondsBeforeExpiry: number) => VALID_UNTIL - secondsBeforeExpiry - T0_MS / 1000;
  const serverNow = (secondsBeforeExpiry = 100_000) => Math.floor(Date.now() / 1000) + offsetFor(secondsBeforeExpiry);
  const wrongPasskey = () => jsonResponse(409, WRONG_PASSKEY_BODY);
  const statusReply = (state: string, secondsBeforeExpiry = 100_000) =>
    jsonResponse(200, { attempt: { ...baseAttempt(), state, prepared: PREPARED_FIELDS }, serverNowSeconds: serverNow(secondsBeforeExpiry), reconciliationDeferred: false });
  /** What /latest answers for a payment this session's passkey CAN approve. */
  const latestResumable = () => jsonResponse(200, { attempt: baseAttempt(), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: serverNow() });
  /** Everything in the store that is state (functions drop out) — for "nothing changed" comparisons. */
  const visible = (store: Store) => JSON.parse(JSON.stringify(store.getState())) as Record<string, unknown>;

  /** A payment waiting for this session's approval, as /prepare or /latest would have left it. */
  function awaiting(secondsBeforeExpiry = 100_000, attempt: ReturnType<typeof baseAttempt> = baseAttempt()): Store {
    const store = createRealPaymentStore();
    stores.push(store);
    store.setState({ attempt, status: "awaiting_authorization", subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", clockOffsetSeconds: offsetFor(secondsBeforeExpiry) });
    return store;
  }

  /** One Continue (one passkey approval, one POST /submit) answered by `submit`. */
  async function afterSubmit(submit: Handler, options: { others?: Partial<Record<Key, Handler>>; secondsBeforeExpiry?: number; attempt?: ReturnType<typeof baseAttempt> } = {}) {
    const api = server({ submit, ...options.others });
    const store = awaiting(options.secondsBeforeExpiry, options.attempt);
    const before = structuredClone(store.getState().attempt);
    await store.getState().resumeAuthorization();
    return { api, store, before };
  }

  /** One Continue answered by the exact refusal. */
  const refused = (options: Parameters<typeof afterSubmit>[1] = {}) => afterSubmit(wrongPasskey, options);

  describe("the exact refusal: HTTP 409 + code 'wrong_passkey'", () => {
    it("goes straight to cancel-only: the approval and its credential are dropped, the payment and the account context are kept", async () => {
      const { api, store, before } = await refused();

      expect(store.getState()).toMatchObject({
        status: "stranded",
        error: OTHER_PASSKEY,
        authorizingCredentialId: null,
        pendingSubmission: null,
        isAuthorizing: false,
        // The account context stays: without it a later Continue would claim "You're signed out."
        subOrganizationId: "sub-org-1",
        isAttemptPastValidity: false,
        isCancelling: false,
        isSubmitCoolingDown: false,
        prepareNeedsCheck: null,
        prepareCheck: "idle",
      });
      // The payment itself is exactly the one that was on screen: same id, amount, recipient, stored state.
      expect(store.getState().attempt).toEqual(before);
      expect(store.getState().attempt).toMatchObject({ id: ATTEMPT_ID, state: "awaiting_authorization", amountBaseUnits: "1000000", recipient: "0x2222222222222222222222222222222222222222", failureReason: null, transactionHash: null });
      // One approval, one submit of exactly that approval — and nothing else.
      expect(api.calls.map(({ key, method, body }) => ({ key, method, body }))).toEqual([{ key: "submit", method: "POST", body: APPROVAL }]);
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
      expect(vi.mocked(signPreparedPayment).mock.calls[0]![0]).toMatchObject({ authorizingCredentialId: "credential-1", subOrganizationId: "sub-org-1" });
    });

    it("the fresh flow (Review, Approve, prepare, passkey, submit) ends the same way, on the server's attempt", async () => {
      const api = server({
        prepare: () => jsonResponse(200, { attempt: { ...baseAttempt(), id: PREPARED_ID, recipient: ADDRESS }, subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: serverNow() }),
        submit: wrongPasskey,
      });
      const store = createRealPaymentStore();
      stores.push(store);
      store.setState({ status: "editing" });
      store.getState().setRecipientInput(ADDRESS);
      store.getState().setAmountInput("1");
      await store.getState().review();
      expect(store.getState().status).toBe("reviewing");

      await store.getState().confirmAndSend();

      expect(store.getState()).toMatchObject({ status: "stranded", error: OTHER_PASSKEY, authorizingCredentialId: null, pendingSubmission: null, isAuthorizing: false, subOrganizationId: "sub-org-1", prepareNeedsCheck: null });
      expect(store.getState().attempt).toMatchObject({ id: PREPARED_ID, state: "awaiting_authorization", amountBaseUnits: "1000000", recipient: ADDRESS });
      expect(api.keys()).toEqual(["prepare", "submit"]);
      expect(api.calls[1]!.body).toEqual({ attemptId: PREPARED_ID, signature: APPROVAL.signature, activityId: APPROVAL.activityId });
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["a different sentence", { error: "Internal: credential-backup is not credential-1 <b>not shown</b>", code: "wrong_passkey" }],
      ["no sentence", { code: "wrong_passkey" }],
      ["extra fields", { error: OTHER_PASSKEY, code: "wrong_passkey", retryable: false, detail: "0xdeadbeef", attempt: { id: ATTEMPT_ID, state: "confirmed" } }],
    ] as const)("is decided by status and code only, never by the sentence, and shows the client's own copy (%s)", async (_name, body) => {
      const { api, store, before } = await afterSubmit(() => jsonResponse(409, body));

      expect(store.getState()).toMatchObject({ status: "stranded", error: OTHER_PASSKEY, authorizingCredentialId: null, pendingSubmission: null, subOrganizationId: "sub-org-1" });
      // Nothing in the body is adopted: not its sentence, not its extra fields, not an "attempt".
      expect(store.getState().attempt).toEqual(before);
      expect(JSON.stringify(store.getState())).not.toMatch(/not shown|deadbeef|credential-backup|confirmed/);
      expect(api.keys()).toEqual(["submit"]);
    });

    it("a handle payment keeps the server's stored recipient identity", async () => {
      const attempt = { ...baseAttempt(), recipientIdentity: { handle: "smit", displayName: "Smit Patel" } };
      const { store } = await refused({ attempt });

      expect(store.getState().status).toBe("stranded");
      expect(store.getState().attempt).toMatchObject({ id: ATTEMPT_ID, recipientIdentity: { handle: "smit", displayName: "Smit Patel" }, amountBaseUnits: "1000000" });
    });

    it("an approval kept after a retryable 503, re-sent by Continue and then refused, is dropped — one passkey prompt in all", async () => {
      const api = server({ submit: (n) => (n === 1 ? jsonResponse(503, { error: UNAVAILABLE_SENTENCE, retryable: true }) : wrongPasskey()) });
      const store = awaiting();

      await store.getState().resumeAuthorization();
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", pendingSubmission: APPROVAL, authorizingCredentialId: "credential-1" });

      await store.getState().resumeAuthorization();

      expect(store.getState()).toMatchObject({ status: "stranded", error: OTHER_PASSKEY, pendingSubmission: null, authorizingCredentialId: null, subOrganizationId: "sub-org-1" });
      expect(api.calls.map((call) => call.body)).toEqual([APPROVAL, APPROVAL]);
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
    });

    it("an approval re-sent after a submit wait (429) has run out and then refused leaves no wait and no approval behind", async () => {
      const denial = () => new Response(JSON.stringify({ error: BUDGET_SENTENCE, code: "rate_limited", retryable: true }), { status: 429, headers: { "content-type": "application/json", "Retry-After": "60" } });
      const api = server({ submit: (n) => (n === 1 ? denial() : wrongPasskey()) });
      const store = awaiting();

      await store.getState().resumeAuthorization();
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", isSubmitCoolingDown: true, pendingSubmission: APPROVAL });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.getState().isSubmitCoolingDown).toBe(false);
      expect(api.count("submit")).toBe(1); // the wait ending sends nothing

      await store.getState().resumeAuthorization();

      expect(store.getState()).toMatchObject({ status: "stranded", error: OTHER_PASSKEY, pendingSubmission: null, authorizingCredentialId: null, isSubmitCoolingDown: false, subOrganizationId: "sub-org-1" });
      expect(api.keys()).toEqual(["submit", "submit"]);
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
    });
  });

  describe("nothing follows the refusal by itself", () => {
    it("no request, passkey prompt, cancel or new payment — right up to the end of the approval window", async () => {
      const { api, store } = await refused({ secondsBeforeExpiry: 100_000 });

      await vi.advanceTimersByTimeAsync(99_000_000); // 99,000 s: still inside the window

      expect(api.keys()).toEqual(["submit"]);
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
      expect(store.getState()).toMatchObject({ status: "stranded", error: OTHER_PASSKEY, authorizingCredentialId: null, pendingSubmission: null });
      expect(store.getState().attempt).toMatchObject({ id: ATTEMPT_ID, state: "awaiting_authorization", transactionHash: null, failureReason: null });
    });

    it("Continue cannot sign or send again: every resume and approve action is a no-op in the cancel-only state", async () => {
      const { api, store } = await refused();
      const before = visible(store);

      await store.getState().resumeAuthorization();
      await Promise.all([1, 2, 3].map(() => store.getState().resumeAuthorization()));
      await store.getState().confirmAndSend();
      await settle();

      expect(visible(store)).toEqual(before);
      expect(api.keys()).toEqual(["submit"]);
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
    });

    it("a later read-only status answer of 'still waiting for approval' does not bring the passkey back: Continue falls back to cancel-only with no prompt and no request", async () => {
      const { api, store } = await refused({ others: { status: () => statusReply("awaiting_authorization") } });

      await store.getState().checkStatus();

      // The existing status mapping shows the payment as waiting again — but nothing this session could sign with came back.
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", authorizingCredentialId: null, pendingSubmission: null, subOrganizationId: "sub-org-1" });
      expect(api.calls.map(({ key, method }) => `${method} ${key}`)).toEqual(["POST submit", "GET status"]);

      await store.getState().resumeAuthorization();

      expect(store.getState()).toMatchObject({ status: "stranded", error: OTHER_PASSKEY, authorizingCredentialId: null, pendingSubmission: null, isAuthorizing: false });
      expect(api.count("submit")).toBe(1);
      expect(api.writes()).toEqual(["submit"]);
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["cancelled", "editing"],
      ["failed", "failed"],
      ["confirmed", "confirmed"],
      ["submitted", "submitted"],
    ] as const)("a later status answer of '%s' is simply shown (%s): the finished or sent payment is not turned back into something to approve", async (state, shown) => {
      const { api, store } = await refused({ others: { status: () => statusReply(state), balance: () => jsonResponse(200, { token: "USDC", decimals: 6, balanceBaseUnits: "0" }) } });

      await store.getState().checkStatus();
      expect(store.getState().status).toBe(shown);
      expect(store.getState().attempt?.state).toBe(state);

      await store.getState().resumeAuthorization();
      await settle();

      expect(store.getState().status).toBe(shown);
      expect(store.getState()).toMatchObject({ authorizingCredentialId: null, pendingSubmission: null });
      expect(api.writes()).toEqual(["submit"]);
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
    });
  });

  describe("Cancel stays explicit and server-decided", () => {
    it("an explicit Cancel sends exactly one request for this payment, and a server 'yes' frees the form", async () => {
      const { api, store } = await refused({ others: { cancel: () => jsonResponse(200, { attempt: { ...baseAttempt(), state: "cancelled", prepared: null } }) } });
      expect(api.count("cancel")).toBe(0); // never by itself

      await store.getState().cancel();

      expect(api.keys()).toEqual(["submit", "cancel"]);
      expect(api.calls[1]).toMatchObject({ method: "POST", url: `/api/real/payments/${ATTEMPT_ID}/cancel` });
      expect(api.calls[1]!.body).toBeUndefined();
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, subOrganizationId: null, authorizingCredentialId: null, pendingSubmission: null, error: null });
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
    });

    it("two presses while the request is on its way are one request", async () => {
      const gate = held();
      const { api, store } = await refused({ others: { cancel: () => gate.promise } });

      const first = store.getState().cancel();
      const second = store.getState().cancel();
      await settle();
      expect(store.getState().isCancelling).toBe(true);
      gate.resolve(jsonResponse(200, { attempt: { ...baseAttempt(), state: "cancelled", prepared: null } }));
      await Promise.all([first, second]);

      expect(api.count("cancel")).toBe(1);
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, isCancelling: false });
    });

    it("a refused Cancel (another session already sent the payment) is reconciled by the existing status read — never shown as cancelled, never cancelled again", async () => {
      const { api, store } = await refused({ others: { cancel: () => jsonResponse(409, { error: "This payment can no longer be cancelled (state: submitted)." }), status: () => statusReply("submitted") } });

      await store.getState().cancel();

      expect(api.calls.map(({ key, method }) => `${method} ${key}`)).toEqual(["POST submit", "POST cancel", "GET status"]);
      expect(store.getState()).toMatchObject({ status: "submitted", error: CANCEL_LOST_RACE, authorizingCredentialId: null, pendingSubmission: null });
      expect(store.getState().attempt).toMatchObject({ id: ATTEMPT_ID, state: "submitted" });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(api.count("cancel")).toBe(1);
      expect(api.count("submit")).toBe(1);
    });

    it("a refused Cancel whose status read still says 'waiting' leaves a payment this session still cannot approve", async () => {
      const { api, store } = await refused({ others: { cancel: () => jsonResponse(409, { error: "Not now." }), status: () => statusReply("awaiting_authorization") } });

      await store.getState().cancel();
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", error: CANCEL_LOST_RACE, authorizingCredentialId: null, pendingSubmission: null });

      await store.getState().resumeAuthorization();

      expect(store.getState()).toMatchObject({ status: "stranded", error: OTHER_PASSKEY });
      expect(api.writes()).toEqual(["submit", "cancel"]);
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
    });

    it("a Cancel that never gets an answer changes nothing and is not retried", async () => {
      const { api, store } = await refused({
        others: {
          cancel: () => {
            throw new TypeError("Failed to fetch");
          },
        },
      });

      await store.getState().cancel();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(store.getState()).toMatchObject({ status: "stranded", error: CANCEL_UNCONFIRMED, authorizingCredentialId: null, pendingSubmission: null, isCancelling: false });
      expect(store.getState().attempt).toMatchObject({ id: ATTEMPT_ID, state: "awaiting_authorization" });
      expect(api.keys()).toEqual(["submit", "cancel"]);
    });
  });

  describe("every other failed submit stays 'unknown', keeps its approval, and shows fixed copy", () => {
    /** Conservative, in full: unknown, the fixed detail, the approval and the whole signing context kept, the payment untouched, and nothing sent after the one submit. */
    function expectUnconfirmed(api: ReturnType<typeof server>, store: Store, before: unknown) {
      const state = store.getState();
      expect(state.status).toBe("unknown");
      expect(state.error).toBe(NEUTRAL);
      expect(state.pendingSubmission).toEqual(APPROVAL);
      expect(state.authorizingCredentialId).toBe("credential-1");
      expect(state.subOrganizationId).toBe("sub-org-1");
      expect(state.isAuthorizing).toBe(false);
      expect(state.isSubmitCoolingDown).toBe(false);
      expect(state.attempt).toEqual(before);
      expect(JSON.stringify(state)).not.toMatch(RAW_TEXT);
      expect(JSON.stringify(state)).not.toContain("different passkey");
      expect(api.keys()).toEqual(["submit"]);
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
    }

    it("the exported constant is the approved wording", async () => {
      const { SUBMIT_UNCONFIRMED_MESSAGE } = await import("@/lib/stores/real-payment-store");
      expect(SUBMIT_UNCONFIRMED_MESSAGE).toBe(NEUTRAL);
    });

    it.each([
      ["no code (the wrong_state sentence)", { error: "This payment is no longer awaiting authorization (state: submitted)." }],
      ["no code (the passkey sentence alone is not enough)", { error: OTHER_PASSKEY }],
      ["code 'wrong_state'", { error: "This payment is no longer awaiting authorization (state: signed).", code: "wrong_state" }],
      ["an unknown code", { error: OTHER_PASSKEY, code: "wrong_credential" }],
      ["the code in upper case", { error: OTHER_PASSKEY, code: "WRONG_PASSKEY" }],
      ["the code in mixed case", { error: OTHER_PASSKEY, code: "Wrong_Passkey" }],
      ["a leading space", { error: OTHER_PASSKEY, code: " wrong_passkey" }],
      ["a trailing space", { error: OTHER_PASSKEY, code: "wrong_passkey " }],
      ["a trailing newline", { error: OTHER_PASSKEY, code: "wrong_passkey\n" }],
      ["a longer look-alike (suffix)", { error: OTHER_PASSKEY, code: "wrong_passkey_" }],
      ["a longer look-alike (plural)", { error: OTHER_PASSKEY, code: "wrong_passkeys" }],
      ["a longer look-alike (prefix)", { error: OTHER_PASSKEY, code: "xwrong_passkey" }],
      ["a hyphenated look-alike", { error: OTHER_PASSKEY, code: "wrong-passkey" }],
      ["an empty code", { error: OTHER_PASSKEY, code: "" }],
      ["a numeric code", { error: OTHER_PASSKEY, code: 409 }],
      ["a null code", { error: OTHER_PASSKEY, code: null }],
      ["a boolean code", { error: OTHER_PASSKEY, code: true }],
      ["an object code", { error: OTHER_PASSKEY, code: { value: "wrong_passkey" } }],
      ["an array code", { error: OTHER_PASSKEY, code: ["wrong_passkey"] }],
      ["the code nested under error", { error: { code: "wrong_passkey" } }],
      ["the code nested under data", { error: OTHER_PASSKEY, data: { code: "wrong_passkey" } }],
      ["the code under another key", { error: OTHER_PASSKEY, errorCode: "wrong_passkey", Code: "wrong_passkey", reason: "wrong_passkey" }],
    ] as const)("an HTTP 409 with %s is not the refusal", async (_name, body) => {
      const { api, store, before } = await afterSubmit(() => jsonResponse(409, body));

      expectUnconfirmed(api, store, before);
    });

    it.each([
      ["an HTML body", "<html><body>409 Conflict wrong_passkey</body></html>"],
      ["an empty body", ""],
      ["a truncated body", '{"error":"This payment was started with a different passkey.","code":"wrong_pass'],
      ["a JSON null body", "null"],
      ["a bare JSON string", '"wrong_passkey"'],
      ["a JSON array", '[{"code":"wrong_passkey"}]'],
    ] as const)("an HTTP 409 with %s is not the refusal", async (_name, text) => {
      const { api, store, before } = await afterSubmit(() => new Response(text, { status: 409 }));

      expectUnconfirmed(api, store, before);
    });

    // L-2 D-8: 401 and 404 left this list — they now have their own fixed wording (see the D-8 section, which still proves the refusal body does not make them the refusal).
    it.each([400, 403, 410, 422, 429, 500, 502, 503, 504] as const)("an HTTP %i carrying the exact refusal body is not the refusal: the status decides first", async (status) => {
      const { api, store, before } = await afterSubmit(() => jsonResponse(status, WRONG_PASSKEY_BODY));

      expectUnconfirmed(api, store, before);
    });

    it.each([
      // L-2 D-8: the real 401 and 404 answers moved to the D-8 section (fixed 401/404 wording).
      ["400 (signature refused)", 400, { error: "This payment's signature could not be verified." }],
      ["409 wrong_state (prepared)", 409, { error: "This payment is no longer awaiting authorization (state: prepared)." }],
      ["409 wrong_state (signed)", 409, { error: "This payment is no longer awaiting authorization (state: signed)." }],
      ["409 wrong_state (submitting)", 409, { error: "This payment is no longer awaiting authorization (state: submitting)." }],
      ["409 wrong_state (submitted)", 409, { error: "This payment is no longer awaiting authorization (state: submitted)." }],
      ["409 wrong_state (confirmed)", 409, { error: "This payment is no longer awaiting authorization (state: confirmed)." }],
      ["409 wrong_state (failed)", 409, { error: "This payment is no longer awaiting authorization (state: failed)." }],
      ["409 wrong_state (cancelled)", 409, { error: "This payment is no longer awaiting authorization (state: cancelled)." }],
      ["409 wrong_state (unknown)", 409, { error: "This payment is no longer awaiting authorization (state: unknown)." }],
      ["500 (the generic server error)", 500, { error: "Something went wrong. Please try again." }],
      ["a non-budget 429", 429, { error: "You've reached the payment limit.", code: "rate_limited" }],
    ] as const)("the server's real %s answer stays conservative, and its sentence is never kept", async (_name, status, body) => {
      const { api, store, before } = await afterSubmit(() => jsonResponse(status, body));

      expectUnconfirmed(api, store, before);
      expect(JSON.stringify(store.getState())).not.toContain(body.error);
    });

    const THROWN: Array<[string, () => unknown]> = [
      ["a network failure", () => new TypeError("Failed to fetch")],
      ["an aborted request", () => new DOMException("The operation was aborted.", "AbortError")],
      ["a thrown plain object shaped like the refusal", () => ({ status: 409, code: "wrong_passkey", retryable: false, message: OTHER_PASSKEY })],
      ["a thrown Error dressed up as the refusal", () => Object.assign(new Error(OTHER_PASSKEY), { name: "ApiError", status: 409, code: "wrong_passkey", retryable: false })],
      ["a thrown Error dressed up as a retryable refusal", () => Object.assign(new Error("boom"), { name: "ApiError", status: 409, code: "wrong_passkey", retryable: true })],
      ["a thrown string", () => "wrong_passkey"],
    ];

    it.each(THROWN)("%s is not the refusal: only a real answer from this page's own request helper counts", async (_name, thrown) => {
      const { api, store, before } = await afterSubmit(() => {
        throw thrown();
      });

      expectUnconfirmed(api, store, before);
    });

    it.each([
      ["an empty object", () => jsonResponse(200, {})],
      ["a JSON null", () => new Response("null", { status: 200 })],
      ["a null attempt", () => jsonResponse(200, { attempt: null })],
      ["an HTML page", () => new Response("<html>ok</html>", { status: 200 })],
      ["an empty body", () => new Response("", { status: 200 })],
      ["a refusal-shaped body with no attempt", () => jsonResponse(200, WRONG_PASSKEY_BODY)],
    ] as const)("an HTTP 200 with %s is not a result and not the refusal", async (_name, reply) => {
      const { api, store, before } = await afterSubmit(reply);

      expectUnconfirmed(api, store, before);
    });

    it("nothing follows an unconfirmed submit by itself — a day later there has still been exactly one request", async () => {
      const { api, store, before } = await afterSubmit(() => jsonResponse(409, { error: "This payment is no longer awaiting authorization (state: submitted)." }));

      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      await store.getState().resumeAuthorization(); // not offered in "unknown", and refused by the store
      await store.getState().confirmAndSend();

      expectUnconfirmed(api, store, before);
    });

    it("the kept approval works exactly as before: an explicit status check that finds the payment still waiting lets Continue re-send the SAME approval — no second passkey prompt", async () => {
      const api = server({
        submit: (n) => (n === 1 ? jsonResponse(500, { error: "Something went wrong. Please try again." }) : jsonResponse(200, { attempt: { ...baseAttempt(), state: "submitted", prepared: null } })),
        status: () => statusReply("awaiting_authorization"),
      });
      const store = awaiting();
      await store.getState().resumeAuthorization();
      expect(store.getState()).toMatchObject({ status: "unknown", error: NEUTRAL });
      expect(api.keys()).toEqual(["submit"]); // the check is the user's action, never automatic

      await store.getState().checkStatus();
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", error: null, authorizingCredentialId: "credential-1", pendingSubmission: APPROVAL });

      await store.getState().resumeAuthorization();

      expect(store.getState()).toMatchObject({ status: "submitted", pendingSubmission: null });
      expect(api.calls.filter((call) => call.key === "submit").map((call) => call.body)).toEqual([APPROVAL, APPROVAL]);
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
    });
  });

  describe("the retryable answers are exactly as before", () => {
    it("the submit budget's 429 still starts its wait and keeps the approval and the credential", async () => {
      const { api, store } = await afterSubmit(() => new Response(JSON.stringify({ error: BUDGET_SENTENCE, code: "rate_limited", retryable: true }), { status: 429, headers: { "content-type": "application/json", "Retry-After": "120" } }));

      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", error: null, isSubmitCoolingDown: true, submitCooldownSeconds: 120, isSubmitRetryBeyondApproval: false, pendingSubmission: APPROVAL, authorizingCredentialId: "credential-1", subOrganizationId: "sub-org-1" });
      expect(api.keys()).toEqual(["submit"]);
    });

    it("the retryable 503 still returns to the waiting screen with its message, the approval and the credential", async () => {
      const { api, store } = await afterSubmit(() => jsonResponse(503, { error: UNAVAILABLE_SENTENCE, retryable: true }));

      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", error: UNAVAILABLE_SENTENCE, isSubmitCoolingDown: false, pendingSubmission: APPROVAL, authorizingCredentialId: "credential-1", subOrganizationId: "sub-org-1" });
      expect(api.keys()).toEqual(["submit"]);
    });

    it.each([
      ["a budget 429", 429, { error: BUDGET_SENTENCE, code: "wrong_passkey", retryable: true }],
      ["a retryable 503", 503, { error: UNAVAILABLE_SENTENCE, code: "wrong_passkey", retryable: true }],
      // The existing retryable handling is decided first, whatever the status: an answer that says "send the same approval again" is never the refusal.
      ["a retryable 409", 409, { error: UNAVAILABLE_SENTENCE, code: "wrong_passkey", retryable: true }],
    ] as const)("%s that also carries the code keeps the existing retryable handling: waiting, approval and credential kept, never cancel-only", async (_name, status, body) => {
      const { api, store } = await afterSubmit(() => jsonResponse(status, body));

      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", error: body.error, pendingSubmission: APPROVAL, authorizingCredentialId: "credential-1", subOrganizationId: "sub-org-1", isSubmitCoolingDown: false });
      expect(api.keys()).toEqual(["submit"]);
    });
  });

  describe("late answers are never applied", () => {
    const WAYS: Array<[string, (store: Store) => void | Promise<void>]> = [
      ["reset()", (store) => store.getState().reset()],
      ["detach() (the Pay form unmounted)", (store) => store.getState().detach()],
      [
        "a remount (detach, then init)",
        async (store) => {
          store.getState().detach();
          await store.getState().init();
        },
      ],
      ["a new init() without a detach", (store) => store.getState().init()],
      ["another account signing in (no reset)", () => useRealAccountStore.setState({ account: ACCOUNT_B })],
      [
        "another account signing in (reset, then init)",
        async (store) => {
          useRealAccountStore.setState({ account: ACCOUNT_B });
          store.getState().reset();
          await store.getState().init();
        },
      ],
      ["the payment on screen being replaced by another", (store) => store.setState({ attempt: { ...baseAttempt(), id: ATTEMPT_ID_2 } })],
    ];
    const LATE: Array<[string, (gate: ReturnType<typeof held>) => void]> = [
      ["exact wrong_passkey refusal", (gate) => gate.resolve(wrongPasskey())],
      ["code-less 409", (gate) => gate.resolve(jsonResponse(409, { error: "This payment is no longer awaiting authorization (state: submitted)." }))],
      ["network failure", (gate) => gate.reject(new TypeError("Failed to fetch"))],
    ];

    it.each(WAYS.flatMap(([way, move]) => LATE.map(([late, end]) => [way, late, move, end] as const)))("after %s, a late %s writes nothing and sends nothing", async (_way, _late, move, end) => {
      const gate = held();
      const api = server({ submit: () => gate.promise, latest: latestResumable });
      const store = awaiting();
      const sending = store.getState().resumeAuthorization();
      await settle();
      expect(store.getState().status).toBe("submitting");

      await move(store);
      await settle();
      const before = visible(store);
      const callsBefore = api.calls.length;

      end(gate);
      await sending;
      await settle();

      expect(visible(store)).toEqual(before);
      expect(store.getState().status).not.toBe("stranded");
      expect(store.getState().error).not.toBe(OTHER_PASSKEY);
      expect(store.getState().error).not.toBe(NEUTRAL);
      expect(api.calls).toHaveLength(callsBefore);
      expect(api.count("cancel")).toBe(0);
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
    });

    it("a status read already on its way when the refusal arrived describes the payment as it WAS: it is never applied over the cancel-only screen", async () => {
      const submitGate = held();
      const statusGate = held();
      const api = server({ submit: () => submitGate.promise, status: () => statusGate.promise });
      const store = awaiting();
      const sending = store.getState().resumeAuthorization();
      await settle();
      const checking = store.getState().checkStatus(); // begun while the submit is still in flight
      await settle();
      expect(api.keys()).toEqual(["submit", "status"]);

      submitGate.resolve(wrongPasskey());
      await sending;
      expect(store.getState()).toMatchObject({ status: "stranded", error: OTHER_PASSKEY, authorizingCredentialId: null });
      const before = visible(store);

      statusGate.resolve(statusReply("awaiting_authorization"));
      await checking;
      await settle();

      expect(visible(store)).toEqual(before);
      expect(api.keys()).toEqual(["submit", "status"]);
    });

    it.each([
      ["cancelled elsewhere", "cancelled", "editing"],
      ["failed", "failed", "failed"],
      ["confirmed", "confirmed", "confirmed"],
      ["already sent by another session", "submitted", "submitted"],
      ["of unknown outcome", "unknown", "unknown"],
    ] as const)("a payment that a status read has meanwhile shown as %s is not pulled back to cancel-only by the late refusal", async (_name, state, shown) => {
      const gate = held();
      const api = server({ submit: () => gate.promise, status: () => statusReply(state), balance: () => jsonResponse(200, { token: "USDC", decimals: 6, balanceBaseUnits: "0" }) });
      const store = awaiting();
      const sending = store.getState().resumeAuthorization();
      await settle();

      await store.getState().checkStatus();
      await settle();
      expect(store.getState().status).toBe(shown);
      const before = visible(store);

      gate.resolve(wrongPasskey());
      await sending;
      await settle();

      expect(visible(store)).toEqual(before);
      expect(store.getState().attempt?.state).toBe(state);
      expect(store.getState().error).not.toBe(OTHER_PASSKEY);
      expect(api.count("cancel")).toBe(0);
      expect(api.count("submit")).toBe(1);
    });
  });

  describe("the existing expiry schedule after the refusal", () => {
    it("still inside the window: exactly one timer, for the moment the window ends, and what it runs is one read", async () => {
      const { api, store } = await refused({ secondsBeforeExpiry: 1_000, others: { status: () => statusReply("awaiting_authorization", 1_000) } });

      await vi.advanceTimersByTimeAsync(1_000_000); // exactly the end of the window: not yet past it
      expect(api.keys()).toEqual(["submit"]);
      expect(store.getState()).toMatchObject({ status: "stranded", isAttemptPastValidity: false });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(api.calls.map(({ key, method }) => `${method} ${key}`)).toEqual(["POST submit", "GET status"]);
      expect(api.calls[1]!.url).toBe(`/api/real/payments/${ATTEMPT_ID}/status`);
      // The server's answer is shown by the existing mapping; no passkey came back with it.
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", isAttemptPastValidity: true, authorizingCredentialId: null, pendingSubmission: null });
    });

    it("the follow-ups after that stay reads, stay bounded, and Continue still cannot sign", async () => {
      const { api, store } = await refused({ secondsBeforeExpiry: 1_000, others: { status: () => statusReply("awaiting_authorization", 1_000) } });

      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

      expect(api.writes()).toEqual(["submit"]);
      expect(api.count("status")).toBe(1 + MAX_AUTOMATIC_FOLLOW_UPS);
      expect(api.calls.every((call) => call.key === "submit" || (call.key === "status" && call.method === "GET"))).toBe(true);
      expect(store.getState().isFollowUpExhausted).toBe(true);

      await store.getState().resumeAuthorization();

      expect(store.getState()).toMatchObject({ status: "stranded", error: OTHER_PASSKEY });
      expect(api.writes()).toEqual(["submit"]);
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
    });

    it("a window that ended while the submit was on its way: the schedule's own read-only check runs once, at once — and nothing else", async () => {
      const gate = held();
      const api = server({ submit: () => gate.promise, status: () => statusReply("failed", 30) });
      const store = awaiting(30);
      const sending = store.getState().resumeAuthorization();
      await settle();
      await vi.advanceTimersByTimeAsync(45_000); // the 30 s approval window ends while the request is in flight (and before the 60 s L-2 D-6 submit deadline)
      expect(api.keys()).toEqual(["submit"]);

      gate.resolve(wrongPasskey());
      await sending;
      await settle();

      expect(api.calls.map(({ key, method }) => `${method} ${key}`)).toEqual(["POST submit", "GET status"]);
      // The server's own verdict is what is shown — never one the page made up.
      expect(store.getState().status).toBe("failed");
      expect(store.getState().attempt).toMatchObject({ id: ATTEMPT_ID, state: "failed" });
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(api.keys()).toEqual(["submit", "status"]);
    });

    it("that read's answer is dropped when the lifecycle has moved on before it arrives", async () => {
      const submitGate = held();
      const statusGate = held();
      const api = server({ submit: () => submitGate.promise, status: () => statusGate.promise });
      const store = awaiting(30);
      const sending = store.getState().resumeAuthorization();
      await settle();
      await vi.advanceTimersByTimeAsync(45_000); // past the 30 s window, before the 60 s L-2 D-6 submit deadline
      submitGate.resolve(wrongPasskey());
      await settle();
      expect(api.keys()).toEqual(["submit", "status"]);
      expect(store.getState()).toMatchObject({ status: "stranded", isAttemptPastValidity: true });

      store.getState().reset();
      const before = visible(store);
      statusGate.resolve(statusReply("failed", 30));
      await sending;
      await settle();

      expect(visible(store)).toEqual(before);
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null });
      expect(api.keys()).toEqual(["submit", "status"]);
    });

    it.each([
      ["detach()", (store: Store) => store.getState().detach()],
      ["reset()", (store: Store) => store.getState().reset()],
    ] as const)("%s after the refusal takes the timer with it: nothing is ever requested", async (_name, end) => {
      const { api, store } = await refused({ secondsBeforeExpiry: 1_000, others: { status: () => statusReply("awaiting_authorization", 1_000) } });

      end(store);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

      expect(api.keys()).toEqual(["submit"]);
    });

    it("a hidden page runs no check when the window ends; coming back runs at most the one", async () => {
      const { api, store } = await refused({ secondsBeforeExpiry: 1_000, others: { status: () => statusReply("awaiting_authorization", 1_000) } });

      store.getState().setPageVisible(false);
      await vi.advanceTimersByTimeAsync(2_000_000);
      expect(api.keys()).toEqual(["submit"]);

      store.getState().setPageVisible(true);
      await settle();

      expect(api.calls.map(({ key, method }) => `${method} ${key}`)).toEqual(["POST submit", "GET status"]);
    });
  });

  describe("the code means something only on a submit answer; D-1, D-2, D-3a and C-1 are untouched", () => {
    async function approveFromForm(prepare: Handler, others: Partial<Record<Key, Handler>> = {}) {
      const api = server({ prepare, ...others });
      const store = createRealPaymentStore();
      stores.push(store);
      store.setState({ status: "editing" });
      store.getState().setRecipientInput(ADDRESS);
      store.getState().setAmountInput("1");
      await store.getState().review();
      expect(store.getState().status).toBe("reviewing");
      await store.getState().confirmAndSend();
      return { api, store };
    }

    it("a PREPARE 409 carrying the code is still D-1's 'a payment may be in progress' — never cancel-only", async () => {
      const { api, store } = await approveFromForm(wrongPasskey);

      expect(store.getState()).toMatchObject({ status: "editing", prepareNeedsCheck: "in_progress", error: null, attempt: null });
      expect(api.keys()).toEqual(["prepare"]);
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });

    it("D-2's exact account_not_ready refusal is unchanged", async () => {
      const { api, store } = await approveFromForm(() => jsonResponse(409, { error: "Your account isn't fully set up yet.", code: "account_not_ready" }));

      expect(store.getState()).toMatchObject({ status: "editing", prepareNeedsCheck: null, error: "We can't send payments from this account right now. This payment wasn't started.", attempt: null });
      expect(api.keys()).toEqual(["prepare"]);
    });

    it("C-1's uncertain prepare answer is unchanged", async () => {
      const { api, store } = await approveFromForm(() => jsonResponse(500, { error: "We couldn't confirm this payment's setup. No money was sent by this request. Refresh the app to check its status before trying again.", code: "prepare_outcome_uncertain" }));

      expect(store.getState()).toMatchObject({ status: "editing", prepareNeedsCheck: "uncertain", error: null, attempt: null });
      expect(api.keys()).toEqual(["prepare"]);
    });

    it("a first read (GET /latest) answering 409 with the code is still D-3a's status_unavailable", async () => {
      const api = server({ latest: wrongPasskey });
      const store = createRealPaymentStore();
      stores.push(store);

      await store.getState().init();

      expect(store.getState()).toMatchObject({ status: "status_unavailable", attempt: null, error: null, authorizingCredentialId: null });
      expect(api.keys()).toEqual(["latest"]);
    });

    it("D-1's explicit check answering 409 with the code keeps the requirement", async () => {
      const { api, store } = await approveFromForm(() => jsonResponse(409, { error: "You already have a payment in progress." }), { latest: wrongPasskey });

      await store.getState().checkPreparedPayment();

      expect(store.getState()).toMatchObject({ status: "editing", prepareNeedsCheck: "in_progress", prepareCheck: "unavailable", attempt: null });
      expect(api.keys()).toEqual(["prepare", "latest"]);
    });

    it("a status read answering 409 with the code changes neither the payment's screen nor its signing context", async () => {
      const api = server({ status: wrongPasskey });
      const store = awaiting();

      await store.getState().checkStatus();

      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", authorizingCredentialId: "credential-1", subOrganizationId: "sub-org-1", pendingSubmission: null });
      expect(api.keys()).toEqual(["status"]);
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });

    it("a Cancel answering 409 with the code is an ordinary refused cancel: reconciled by a status read, signing context untouched", async () => {
      const api = server({ cancel: wrongPasskey, status: () => statusReply("awaiting_authorization") });
      const store = awaiting();

      await store.getState().cancel();

      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", error: CANCEL_LOST_RACE, authorizingCredentialId: "credential-1", subOrganizationId: "sub-org-1" });
      expect(api.keys()).toEqual(["cancel", "status"]);
    });

    it("a dismissed passkey prompt is unchanged: the same pending payment, nothing sent", async () => {
      vi.mocked(signPreparedPayment).mockReset();
      vi.mocked(signPreparedPayment).mockRejectedValue(Object.assign(new Error("dismissed"), { name: "NotAllowedError" }));
      const api = server({ submit: wrongPasskey });
      const store = awaiting();

      await store.getState().resumeAuthorization();

      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", error: null, isAuthorizing: false, authorizingCredentialId: "credential-1", pendingSubmission: null });
      expect(api.keys()).toEqual([]);
    });

    it("an accepted submit is unchanged: the server's attempt is shown and the approval is released", async () => {
      const { api, store } = await afterSubmit(() => jsonResponse(200, { attempt: { ...baseAttempt(), state: "submitted", prepared: null } }));

      expect(store.getState()).toMatchObject({ status: "submitted", error: null, pendingSubmission: null, authorizingCredentialId: "credential-1" });
      expect(api.keys()).toEqual(["submit"]);
    });
  });
});

describe("real-payment-store — L-2 D-6: bounded submit wait", () => {
  const ACCOUNT_A = { appUserId: "app-user-1", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222" };
  const ACCOUNT_B = { appUserId: "app-user-2", ownerAddress: "0x4444444444444444444444444444444444444444", safeAddress: "0x5555555555555555555555555555555555555555" };
  const T0_MS = 1_800_000_000_000; // a whole second, so boundary arithmetic is exact
  const NEUTRAL = "We couldn't confirm whether this payment was sent. Check its status before trying again.";
  const OTHER_PASSKEY = "This payment was started with a different passkey. Cancel it and start a new payment.";
  const UNAVAILABLE_SENTENCE = "We couldn't confirm your passkey approval yet. Try again in a moment.";
  const APPROVAL = { attemptId: ATTEMPT_ID, signature: "0xsig-d6", activityId: "activity-d6" };
  const DEADLINE = SUBMIT_REQUEST_DEADLINE_MS;

  type Key = "prepare" | "latest" | "cancel" | "status" | "submit" | "balance";
  type Handler = (n: number) => Response | Promise<Response>;
  type Store = ReturnType<typeof createRealPaymentStore>;
  const stores: Store[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0_MS);
    vi.mocked(signPreparedPayment).mockReset();
    vi.mocked(signPreparedPayment).mockResolvedValue({ signature: APPROVAL.signature, activityId: APPROVAL.activityId } as never);
    useRealAccountStore.setState({ account: ACCOUNT_A });
  });

  afterEach(async () => {
    for (const store of stores.splice(0)) store.getState().reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.mocked(signPreparedPayment).mockReset();
    useRealAccountStore.setState({ account: null });
    (await import("@/lib/stores/real-balance-store")).useRealBalanceStore.getState().reset();
  });

  /** Every request is recorded — including one no handler expects, which also fails the request. */
  function server(handlers: Partial<Record<Key, Handler>>) {
    const calls: Array<{ key: Key | "other"; url: string; method: string; body: unknown; signal: unknown }> = [];
    const counts: Record<Key, number> = { prepare: 0, latest: 0, cancel: 0, status: 0, submit: 0, balance: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        const key: Key | null = url.endsWith("/api/real/payments/prepare")
          ? "prepare"
          : url.endsWith("/api/real/payments/latest")
            ? "latest"
            : url.endsWith("/cancel")
              ? "cancel"
              : url.endsWith("/status")
                ? "status"
                : url.endsWith("/api/real/payments/submit")
                  ? "submit"
                  : url.endsWith("/api/real/account/balance")
                    ? "balance"
                    : null;
        calls.push({ key: key ?? "other", url, method, body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined, signal: init?.signal });
        const handler = key ? handlers[key] : undefined;
        if (!key || !handler) throw new Error(`unexpected fetch: ${method} ${url}`);
        counts[key] += 1;
        return handler(counts[key]);
      }),
    );
    return {
      calls,
      keys: () => calls.map((call) => call.key),
      count: (key: Key) => calls.filter((call) => call.key === key).length,
      writes: () => calls.filter((call) => call.method !== "GET").map((call) => call.key),
    };
  }

  function held() {
    let resolve: (response: Response) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const promise = new Promise<Response>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const settle = () => vi.advanceTimersByTimeAsync(0);
  const offsetFor = (secondsBeforeExpiry: number) => VALID_UNTIL - secondsBeforeExpiry - T0_MS / 1000;
  const serverNow = (secondsBeforeExpiry = 100_000) => Math.floor(Date.now() / 1000) + offsetFor(secondsBeforeExpiry);
  const statusReply = (state: string, secondsBeforeExpiry = 100_000) =>
    jsonResponse(200, { attempt: { ...baseAttempt(), state, prepared: PREPARED_FIELDS }, serverNowSeconds: serverNow(secondsBeforeExpiry), reconciliationDeferred: false });
  const latestResumable = () => jsonResponse(200, { attempt: baseAttempt(), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: serverNow() });
  const balanceReply = () => jsonResponse(200, { token: "USDC", decimals: 6, balanceBaseUnits: "0" });
  const visible = (store: Store) => JSON.parse(JSON.stringify(store.getState())) as Record<string, unknown>;
  const wrongPasskey = () => jsonResponse(409, { error: OTHER_PASSKEY, code: "wrong_passkey" });
  const accepted = (state: string) => () => jsonResponse(200, { attempt: { ...baseAttempt(), state, prepared: state === "awaiting_authorization" ? PREPARED_FIELDS : null } });

  function awaiting(secondsBeforeExpiry = 100_000): Store {
    const store = createRealPaymentStore();
    stores.push(store);
    store.setState({ attempt: baseAttempt(), status: "awaiting_authorization", subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", clockOffsetSeconds: offsetFor(secondsBeforeExpiry) });
    return store;
  }

  /** One Continue whose POST /submit is held open; returns once the request is on its way. */
  async function sending(handlers: Partial<Record<Key, Handler>> = {}) {
    const gate = held();
    const api = server({ submit: () => gate.promise, ...handlers });
    const store = awaiting();
    const done = store.getState().resumeAuthorization();
    await settle();
    expect(store.getState().status).toBe("submitting");
    return { gate, api, store, done };
  }

  /** What stays exactly as it was when the page gives up waiting: the payment, the approval, the account context. */
  const RETAINED = { pendingSubmission: APPROVAL, authorizingCredentialId: "credential-1", subOrganizationId: "sub-org-1", isAuthorizing: false };

  describe("A. a submit that never settles", () => {
    it("is 'submitting' until 60 s, then the existing 'unknown' with the exact conservative message — approval and payment kept, one submit, nothing else", async () => {
      const { api, store } = await sending();
      const attemptBefore = structuredClone(store.getState().attempt);

      await vi.advanceTimersByTimeAsync(DEADLINE - 1);
      expect(store.getState()).toMatchObject({ status: "submitting", error: null });

      await vi.advanceTimersByTimeAsync(1);

      expect(DEADLINE).toBe(60_000);
      expect(store.getState()).toMatchObject({ status: "unknown", error: SUBMIT_UNCONFIRMED_MESSAGE, ...RETAINED });
      expect(SUBMIT_UNCONFIRMED_MESSAGE).toBe(NEUTRAL);
      // The payment is exactly the one that was on screen — never marked failed, cancelled or sent.
      expect(store.getState().attempt).toEqual(attemptBefore);
      expect(store.getState().attempt).toMatchObject({ id: ATTEMPT_ID, state: "awaiting_authorization", failureReason: null, transactionHash: null });
      expect(api.calls.map(({ key, method, body }) => ({ key, method, body }))).toEqual([{ key: "submit", method: "POST", body: APPROVAL }]);
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("the fresh flow (Review, Approve, prepare, passkey, submit) is bounded the same way", async () => {
      const gate = held();
      const api = server({
        prepare: () => jsonResponse(200, { attempt: { ...baseAttempt(), id: PREPARED_ID, recipient: "0x3333333333333333333333333333333333333333" }, subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: serverNow() }),
        submit: () => gate.promise,
      });
      const store = createRealPaymentStore();
      stores.push(store);
      store.setState({ status: "editing" });
      store.getState().setRecipientInput("0x3333333333333333333333333333333333333333");
      store.getState().setAmountInput("1");
      await store.getState().review();
      void store.getState().confirmAndSend();
      await settle();
      expect(store.getState().status).toBe("submitting");

      await vi.advanceTimersByTimeAsync(DEADLINE);

      expect(store.getState()).toMatchObject({ status: "unknown", error: NEUTRAL, pendingSubmission: { attemptId: PREPARED_ID, signature: APPROVAL.signature, activityId: APPROVAL.activityId } });
      expect(api.keys()).toEqual(["prepare", "submit"]);
    });
  });

  describe("B. a fetch that ignores abort", () => {
    it("the request is never aborted (no signal at all), the deadline still works, and the timer does not repeat", async () => {
      const { api, store } = await sending();
      expect(vi.getTimerCount()).toBe(1); // exactly the one deadline timer

      await vi.advanceTimersByTimeAsync(DEADLINE);
      const atDeadline = visible(store);
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(10 * DEADLINE);

      expect(visible(store)).toEqual(atDeadline);
      expect(api.calls[0]!.signal).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      expect(api.keys()).toEqual(["submit"]);
    });

    it("a late rejection after the deadline is observed: no unhandled rejection, no state change", async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        const { gate, store, done } = await sending();
        await vi.advanceTimersByTimeAsync(DEADLINE);
        const atDeadline = visible(store);

        gate.reject(new TypeError("Failed to fetch"));
        await done;
        // Real macrotask turns, so Node gets its chance to report an unhandled rejection.
        vi.useRealTimers();
        await new Promise<void>((resolve) => setTimeout(resolve, 10));

        expect(visible(store)).toEqual(atDeadline);
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });
  });

  /** Every way a submit can end, with what the page has always shown for it. */
  const OUTCOMES: Array<[string, Handler, Record<string, unknown>]> = [
    ["submitted", accepted("submitted"), { status: "submitted", error: null, pendingSubmission: null }],
    ["failed", accepted("failed"), { status: "failed", error: null, pendingSubmission: null }],
    ["unknown", accepted("unknown"), { status: "unknown", error: null, pendingSubmission: null }],
    ["submitting (state)", accepted("submitting"), { status: "unknown", error: null, pendingSubmission: null }],
    ["signed", accepted("signed"), { status: "stranded", error: null, pendingSubmission: null }],
    // L-2 D-7: the submit route never answers "confirmed" in HTTP 200; one that does is not adopted (unknown + explicit Check status).
    ["confirmed", accepted("confirmed"), { status: "unknown", error: NEUTRAL, pendingSubmission: APPROVAL }],
    [
      "budget 429",
      () => new Response(JSON.stringify({ error: "Too many tries.", code: "rate_limited", retryable: true }), { status: 429, headers: { "content-type": "application/json", "Retry-After": "86000" } }),
      { status: "awaiting_authorization", error: null, isSubmitCoolingDown: true, pendingSubmission: APPROVAL },
    ],
    ["retryable 503", () => jsonResponse(503, { error: UNAVAILABLE_SENTENCE, retryable: true }), { status: "awaiting_authorization", error: UNAVAILABLE_SENTENCE, pendingSubmission: APPROVAL }],
    ["wrong_passkey", wrongPasskey, { status: "stranded", error: OTHER_PASSKEY, authorizingCredentialId: null, pendingSubmission: null }],
    ["code-less 409", () => jsonResponse(409, { error: "This payment is no longer awaiting authorization (state: submitted)." }), { status: "unknown", error: NEUTRAL, pendingSubmission: APPROVAL }],
    // L-2 D-8: the status is unchanged (unknown, approval kept); only the fixed wording differs.
    ["HTTP 401", () => jsonResponse(401, { error: "Not authenticated." }), { status: "unknown", error: SIGNED_OUT_PAYMENT_MESSAGE, pendingSubmission: APPROVAL }],
    ["HTTP 404", () => jsonResponse(404, { error: "Payment not found." }), { status: "unknown", error: PAYMENT_NOT_ACCESSIBLE_MESSAGE, pendingSubmission: APPROVAL }],
    ["HTTP 500", () => jsonResponse(500, { error: "Something went wrong." }), { status: "unknown", error: NEUTRAL, pendingSubmission: APPROVAL }],
    ["network error", () => Promise.reject(new TypeError("Failed to fetch")), { status: "unknown", error: NEUTRAL, pendingSubmission: APPROVAL }],
    ["malformed HTTP 200", () => jsonResponse(200, { nothing: true }), { status: "unknown", error: NEUTRAL, pendingSubmission: APPROVAL }],
  ];

  describe("C. timely responses are exactly what they were, and time passing changes nothing", () => {
    it.each(OUTCOMES)("%s", async (_name, handler, expected) => {
      const gate = held();
      const api = server({ submit: () => gate.promise, balance: balanceReply });
      const store = awaiting();
      const done = store.getState().resumeAuthorization();
      await settle();
      await vi.advanceTimersByTimeAsync(DEADLINE - 1); // as late as a timely answer can be
      const answer = handler(1);
      // A rejecting handler is wired to the gate so it settles exactly when the answer is delivered.
      Promise.resolve(answer).then(gate.resolve, gate.reject);
      await done;
      await settle();

      expect(store.getState()).toMatchObject(expected);
      const settled = visible(store);
      const callsAfterAnswer = api.calls.length;

      await vi.advanceTimersByTimeAsync(3 * DEADLINE);

      // The deadline no longer exists: nothing moves, nothing is asked.
      expect(visible(store)).toEqual(settled);
      expect(api.calls).toHaveLength(callsAfterAnswer);
      expect(api.count("submit")).toBe(1);
      expect(api.count("cancel")).toBe(0);
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
    });

    it.each(OUTCOMES.filter(([, , expected]) => !["awaiting_authorization", "stranded"].includes(expected.status as string)))("%s: no timer is left running once the request has settled", async (_name, handler) => {
      const api = server({ submit: handler, balance: balanceReply });
      const store = awaiting();

      await store.getState().resumeAuthorization();
      await settle();

      expect(vi.getTimerCount()).toBe(0);
      expect(api.count("submit")).toBe(1);
    });
  });

  describe("D. a late response is stale, whatever it says", () => {
    it.each(OUTCOMES)("%s delivered after the deadline writes nothing and sends nothing", async (_name, handler) => {
      const { gate, api, store, done } = await sending({ balance: balanceReply, latest: latestResumable, status: () => statusReply("confirmed") });
      await vi.advanceTimersByTimeAsync(DEADLINE);
      expect(store.getState()).toMatchObject({ status: "unknown", error: NEUTRAL, ...RETAINED });
      const atDeadline = visible(store);
      const callsBefore = api.calls.length;

      Promise.resolve(handler(1)).then(gate.resolve, gate.reject);
      await done;
      await settle();
      await vi.advanceTimersByTimeAsync(3 * DEADLINE);

      expect(visible(store)).toEqual(atDeadline);
      expect(api.calls).toHaveLength(callsBefore);
      expect(api.count("balance")).toBe(0); // no refresh, even for a late "confirmed"
      expect(api.count("cancel")).toBe(0);
      expect(api.count("submit")).toBe(1);
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0); // no new countdown from a late 429 / 503
    });
  });

  describe("E. a deadline can never act for a context that has moved on", () => {
    const WAYS: Array<[string, (store: Store) => void | Promise<void>]> = [
      ["reset()", (store) => store.getState().reset()],
      ["detach() (the Pay form unmounted)", (store) => store.getState().detach()],
      [
        "a remount (detach, then init)",
        async (store) => {
          store.getState().detach();
          await store.getState().init();
        },
      ],
      ["a new init() without a detach", (store) => store.getState().init()],
      ["another account signing in (no reset)", () => useRealAccountStore.setState({ account: ACCOUNT_B })],
      [
        "another account signing in (reset, then init)",
        async (store) => {
          useRealAccountStore.setState({ account: ACCOUNT_B });
          store.getState().reset();
          await store.getState().init();
        },
      ],
      ["the payment on screen being replaced by another", (store) => store.setState({ attempt: { ...baseAttempt(), id: ATTEMPT_ID_2 } })],
    ];

    it.each(WAYS)("after %s the deadline writes nothing and sends nothing", async (_name, move) => {
      const { api, store } = await sending({ latest: latestResumable });
      await move(store);
      await settle();
      const before = visible(store);
      const callsBefore = api.calls.length;

      await vi.advanceTimersByTimeAsync(5 * DEADLINE);

      expect(visible(store)).toEqual(before);
      expect(store.getState().status).not.toBe("unknown");
      expect(store.getState().error).not.toBe(NEUTRAL);
      expect(api.calls).toHaveLength(callsBefore);
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["reset()", (store: Store) => store.getState().reset()],
      ["detach()", (store: Store) => store.getState().detach()],
    ] as const)("%s takes the deadline timer with it — no timer is left to fire", async (_name, end) => {
      const { store } = await sending();
      expect(vi.getTimerCount()).toBe(1);

      end(store);

      expect(vi.getTimerCount()).toBe(0);
    });

    it("a request that settled in time leaves no timer that could act for the NEXT submit", async () => {
      const never = held();
      const apiB = server({ submit: (n) => (n === 1 ? jsonResponse(503, { error: UNAVAILABLE_SENTENCE, retryable: true }) : never.promise) });
      const second = awaiting();

      await second.getState().resumeAuthorization(); // answered at once: awaiting again, approval kept
      expect(second.getState()).toMatchObject({ status: "awaiting_authorization", pendingSubmission: APPROVAL });
      await vi.advanceTimersByTimeAsync(40_000);
      void second.getState().resumeAuthorization(); // the second submit starts at t = 40 s
      await settle();
      expect(second.getState().status).toBe("submitting");

      // t = 60 s: the FIRST request's deadline would have fired by now. It must not act for the second.
      await vi.advanceTimersByTimeAsync(DEADLINE - 40_000 + 1);
      expect(second.getState().status).toBe("submitting");

      // The second request's own deadline is 60 s after ITS start.
      await vi.advanceTimersByTimeAsync(40_000);
      expect(second.getState()).toMatchObject({ status: "unknown", error: NEUTRAL, pendingSubmission: APPROVAL });
      expect(apiB.count("submit")).toBe(2);
    });

    it("a successful Cancel takes the deadline timer with it", async () => {
      const { store } = await sending({ cancel: () => jsonResponse(200, { attempt: { ...baseAttempt(), state: "cancelled" } }) });
      expect(vi.getTimerCount()).toBe(1);

      await store.getState().cancel();

      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, pendingSubmission: null });
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(5 * DEADLINE);
      expect(store.getState().status).toBe("editing");
    });

    it("a status read already on its way when the deadline fires describes the payment as it WAS: it is never applied over the unknown screen", async () => {
      const statusGate = held();
      const { api, store } = await sending({ status: () => statusGate.promise });
      await vi.advanceTimersByTimeAsync(30_000);
      const checking = store.getState().checkStatus(); // begun while the submit is still in flight; its own 45 s wait outlives the submit deadline
      await settle();
      expect(api.keys()).toEqual(["submit", "status"]);

      await vi.advanceTimersByTimeAsync(DEADLINE - 30_000);
      expect(store.getState()).toMatchObject({ status: "unknown", error: NEUTRAL });
      const atDeadline = visible(store);

      statusGate.resolve(statusReply("awaiting_authorization"));
      await checking;
      await settle();

      expect(visible(store)).toEqual(atDeadline);
      expect(api.count("status")).toBe(1);
    });

    it("a payment already shown as terminal when the deadline fires is not moved to unknown", async () => {
      const { store } = await sending();
      store.setState({ status: "confirmed", attempt: { ...baseAttempt(), state: "confirmed", prepared: null } });
      const before = visible(store);

      await vi.advanceTimersByTimeAsync(DEADLINE);

      expect(visible(store)).toEqual(before);
    });
  });

  describe("D2. a late outcome never overwrites what Check status has since shown", () => {
    it.each(OUTCOMES)("%s arriving after Check status re-opened the payment writes nothing", async (_name, handler) => {
      const { gate, api, store, done } = await sending({ status: () => statusReply("awaiting_authorization"), balance: balanceReply });
      await vi.advanceTimersByTimeAsync(DEADLINE);
      await store.getState().checkStatus();
      // Awaiting again: the one state in which a stray late answer could be mistaken for current.
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", pendingSubmission: APPROVAL });
      const afterCheck = visible(store);
      const callsBefore = api.calls.length;

      Promise.resolve(handler(1)).then(gate.resolve, gate.reject);
      await done;
      await settle();

      expect(visible(store)).toEqual(afterCheck);
      expect(api.calls).toHaveLength(callsBefore);
      expect(api.count("submit")).toBe(1);
      expect(api.count("balance")).toBe(0);
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
    });
  });

  describe("F. the way forward is the user's own explicit action", () => {
    it("Check status after the deadline sends one read; 'still awaiting' leads to Continue with the RETAINED approval — no second prompt, exactly one more submit", async () => {
      const { gate, api, store, done } = await sending({ status: () => statusReply("awaiting_authorization") });
      await vi.advanceTimersByTimeAsync(DEADLINE);
      expect(api.count("status")).toBe(0); // nothing automatic
      expect(store.getState().status).toBe("unknown");

      await store.getState().checkStatus();
      expect(api.count("status")).toBe(1);
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", pendingSubmission: APPROVAL, authorizingCredentialId: "credential-1", subOrganizationId: "sub-org-1" });
      expect(api.count("submit")).toBe(1);

      // The old request finally answers: it must not overwrite Check status's result.
      const afterCheck = visible(store);
      gate.resolve(jsonResponse(200, { attempt: { ...baseAttempt(), state: "failed", prepared: null } }));
      await done;
      await settle();
      expect(visible(store)).toEqual(afterCheck);

      // Only now, on the user's explicit action, does one more submit go out — the same approval, no passkey prompt.
      const second = held();
      server({ submit: () => second.promise, status: () => statusReply("awaiting_authorization") });
      void store.getState().resumeAuthorization();
      await settle();
      second.resolve(accepted("submitted")());
      await settle();

      expect(store.getState()).toMatchObject({ status: "submitted", pendingSubmission: null });
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
    });

    it("the retained approval is what the second submit sends, byte for byte", async () => {
      const { store } = await sending({ status: () => statusReply("awaiting_authorization") });
      await vi.advanceTimersByTimeAsync(DEADLINE);
      await store.getState().checkStatus();
      const second = server({ submit: accepted("submitted") });

      await store.getState().resumeAuthorization();

      expect(second.calls.map((call) => call.body)).toEqual([APPROVAL]);
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["submitted", "submitted"],
      ["failed", "failed"],
      ["confirmed", "confirmed"],
    ] as const)("Check status can apply '%s' after the deadline", async (state, shown) => {
      const { api, store } = await sending({ status: () => statusReply(state), balance: balanceReply });
      await vi.advanceTimersByTimeAsync(DEADLINE);

      await store.getState().checkStatus();
      await settle();

      expect(store.getState().status).toBe(shown);
      expect(store.getState().attempt?.state).toBe(state);
      expect(api.count("status")).toBe(1);
      expect(api.count("submit")).toBe(1);
      expect(api.count("balance")).toBe(state === "confirmed" ? 1 : 0);
    });
  });

  describe("G. the passkey prompt is not part of the wait", () => {
    it("a prompt open for much longer than 60 s never trips the submit deadline; the clock starts when the request is sent", async () => {
      let approve: (value: { signature: string; activityId: string }) => void = () => {};
      vi.mocked(signPreparedPayment).mockReset();
      vi.mocked(signPreparedPayment).mockReturnValue(new Promise((resolve) => (approve = resolve)) as never);
      const gate = held();
      const api = server({ submit: () => gate.promise });
      const store = awaiting();
      const done = store.getState().resumeAuthorization();
      await settle();
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", isAuthorizing: true });

      await vi.advanceTimersByTimeAsync(5 * DEADLINE);
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", isAuthorizing: true, error: null });
      expect(api.calls).toHaveLength(0);

      approve({ signature: APPROVAL.signature, activityId: APPROVAL.activityId });
      await settle();
      expect(store.getState().status).toBe("submitting");

      await vi.advanceTimersByTimeAsync(DEADLINE - 1);
      expect(store.getState().status).toBe("submitting");
      await vi.advanceTimersByTimeAsync(1);
      expect(store.getState()).toMatchObject({ status: "unknown", error: NEUTRAL, ...RETAINED });
      expect(api.count("submit")).toBe(1);
      gate.resolve(wrongPasskey());
      await done;
    });
  });

  describe("H. a very long time changes nothing", () => {
    it("one day later: still one submit, one approval, no read, no cancel — the page is still asking the user", async () => {
      const { api, store } = await sending({ status: () => statusReply("confirmed"), latest: latestResumable, balance: balanceReply });

      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

      expect(store.getState()).toMatchObject({ status: "unknown", error: NEUTRAL, ...RETAINED });
      expect(api.keys()).toEqual(["submit"]);
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("an unknown screen reached by the deadline behaves like every other unknown screen", () => {
    it("reset() still leaves the form, and the abandoned request's late answer cannot bring the payment back", async () => {
      const { store, gate, done } = await sending();
      await vi.advanceTimersByTimeAsync(DEADLINE);
      expect(store.getState().status).toBe("unknown");

      store.getState().reset();
      expect(store.getState()).toMatchObject({ status: "editing", pendingSubmission: null, attempt: null });
      gate.resolve(wrongPasskey());
      await done;
      expect(store.getState()).toMatchObject({ status: "editing", pendingSubmission: null, attempt: null });
    });
  });
});

/**
 * L-2 D-7: a submit HTTP 200 is adopted only if it is THIS request's own
 * attempt (exact id, an allowed state, the held recipient and amount, showable
 * failureReason / transactionHash). Anything else is "we couldn't confirm":
 * the held payment, the retained approval and the account context stay, and
 * only the user's own Check status moves forward. No D-7 test touches a real
 * network, database, provider or passkey.
 */
describe("real-payment-store — L-2 D-7: malformed submit response recovery", () => {
  const ACCOUNT_A = { appUserId: "app-user-1", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222" };
  const ACCOUNT_B = { appUserId: "app-user-2", ownerAddress: "0x4444444444444444444444444444444444444444", safeAddress: "0x5555555555555555555555555555555555555555" };
  const T0_MS = 1_800_000_000_000;
  const NEUTRAL = "We couldn't confirm whether this payment was sent. Check its status before trying again.";
  const APPROVAL = { attemptId: ATTEMPT_ID, signature: "0xsig-d7", activityId: "activity-d7" };
  const DEADLINE = SUBMIT_REQUEST_DEADLINE_MS;
  const MARKER = "D7-RAW-MARKER-must-never-be-shown";

  type Key = "prepare" | "latest" | "cancel" | "status" | "submit" | "balance";
  type Handler = (n: number) => Response | Promise<Response>;
  type Store = ReturnType<typeof createRealPaymentStore>;
  const stores: Store[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0_MS);
    vi.mocked(signPreparedPayment).mockReset();
    vi.mocked(signPreparedPayment).mockResolvedValue({ signature: APPROVAL.signature, activityId: APPROVAL.activityId } as never);
    useRealAccountStore.setState({ account: ACCOUNT_A });
  });

  afterEach(async () => {
    for (const store of stores.splice(0)) store.getState().reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.mocked(signPreparedPayment).mockReset();
    useRealAccountStore.setState({ account: null });
    (await import("@/lib/stores/real-balance-store")).useRealBalanceStore.getState().reset();
  });

  /** Every request is recorded — including one no handler expects, which also fails the request. */
  function server(handlers: Partial<Record<Key, Handler>>) {
    const calls: Array<{ key: Key | "other"; url: string; method: string; body: unknown }> = [];
    const counts: Record<Key, number> = { prepare: 0, latest: 0, cancel: 0, status: 0, submit: 0, balance: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        const key: Key | null = url.endsWith("/api/real/payments/prepare")
          ? "prepare"
          : url.endsWith("/api/real/payments/latest")
            ? "latest"
            : url.endsWith("/cancel")
              ? "cancel"
              : url.endsWith("/status")
                ? "status"
                : url.endsWith("/api/real/payments/submit")
                  ? "submit"
                  : url.endsWith("/api/real/account/balance")
                    ? "balance"
                    : null;
        calls.push({ key: key ?? "other", url, method, body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined });
        const handler = key ? handlers[key] : undefined;
        if (!key || !handler) throw new Error(`unexpected fetch: ${method} ${url}`);
        counts[key] += 1;
        return handler(counts[key]);
      }),
    );
    return {
      calls,
      keys: () => calls.map((call) => call.key),
      count: (key: Key) => calls.filter((call) => call.key === key).length,
    };
  }

  function held() {
    let resolve: (response: Response) => void = () => {};
    const promise = new Promise<Response>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  const settle = () => vi.advanceTimersByTimeAsync(0);
  const offsetFor = (secondsBeforeExpiry: number) => VALID_UNTIL - secondsBeforeExpiry - T0_MS / 1000;
  const serverNow = (secondsBeforeExpiry = 100_000) => Math.floor(Date.now() / 1000) + offsetFor(secondsBeforeExpiry);
  const statusReply = (state: string) =>
    jsonResponse(200, { attempt: { ...baseAttempt(), state, prepared: PREPARED_FIELDS }, serverNowSeconds: serverNow(), reconciliationDeferred: false });
  const balanceReply = () => jsonResponse(200, { token: "USDC", decimals: 6, balanceBaseUnits: "0" });
  const visible = (store: Store) => JSON.parse(JSON.stringify(store.getState())) as Record<string, unknown>;

  /** A well-formed submit answer for the held payment; `over` changes (or, with undefined, drops) a field. */
  const honest = (over: Record<string, unknown> = {}) => ({ ...baseAttempt(), state: "submitted", prepared: null, ...over });
  const answer = (body: unknown) => () => jsonResponse(200, body);

  function awaiting(): Store {
    const store = createRealPaymentStore();
    stores.push(store);
    store.setState({ attempt: baseAttempt(), status: "awaiting_authorization", subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", clockOffsetSeconds: offsetFor(100_000) });
    return store;
  }

  async function sending(handlers: Partial<Record<Key, Handler>> = {}) {
    const gate = held();
    const api = server({ submit: () => gate.promise, ...handlers });
    const store = awaiting();
    const done = store.getState().resumeAuthorization();
    await settle();
    expect(store.getState().status).toBe("submitting");
    return { gate, api, store, done };
  }

  /** What stays exactly as it was when the page cannot trust an answer. */
  const RETAINED = { pendingSubmission: APPROVAL, authorizingCredentialId: "credential-1", subOrganizationId: "sub-org-1", isAuthorizing: false };

  async function submitOnce(body: unknown) {
    const api = server({ submit: answer(body) });
    const store = awaiting();
    const attemptBefore = structuredClone(store.getState().attempt);
    await store.getState().resumeAuthorization();
    await settle();
    return { api, store, attemptBefore };
  }

  /** The one assertion every malformed answer must satisfy. */
  async function expectRejected(body: unknown) {
    const { api, store, attemptBefore } = await submitOnce(body);
    expect(store.getState()).toMatchObject({ status: "unknown", error: NEUTRAL, ...RETAINED });
    expect(store.getState().attempt).toEqual(attemptBefore); // never replaced, never given an invalid state
    expect(store.getState().attempt?.state).toBe("awaiting_authorization");
    expect(JSON.stringify(visible(store))).not.toContain(MARKER); // nothing of the answer is displayed
    expect(api.keys()).toEqual(["submit"]); // one request: no status, balance, cancel, prepare or second submit
    expect(signPreparedPayment).toHaveBeenCalledTimes(1); // no extra signature
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * DEADLINE);
    expect(api.keys()).toEqual(["submit"]); // and nothing later, on its own
    expect(store.getState()).toMatchObject({ status: "unknown", error: NEUTRAL, ...RETAINED });
  }

  // ---- The matrix of malformed answers. Every body carries MARKER somewhere a leak would show.
  const leak = { failureReason: MARKER };
  const MALFORMED: Array<[string, unknown]> = [
    // A / B / C — the attempt object
    ["A: no attempt key", { nothing: true, note: MARKER }],
    ["A: empty object", {}],
    ["B: attempt null", { attempt: null }],
    ["C: attempt is a number", { attempt: 5 }],
    ["C: attempt is a string", { attempt: MARKER }],
    ["C: attempt is true", { attempt: true }],
    ["C: attempt is false", { attempt: false }],
    ["C: attempt is 0", { attempt: 0 }],
    ["C: attempt is an empty string", { attempt: "" }],
    ["C: attempt is an array", { attempt: [honest()] }],
    ["C: attempt is an empty array", { attempt: [] }],
    // D — the id
    ["D: id missing", { attempt: honest({ id: undefined, ...leak }) }],
    ["D: id null", { attempt: honest({ id: null, ...leak }) }],
    ["D: id numeric", { attempt: honest({ id: 1, ...leak }) }],
    ["D: id empty", { attempt: honest({ id: "", ...leak }) }],
    ["D: id an object", { attempt: honest({ id: { id: ATTEMPT_ID }, ...leak }) }],
    ["D: id an array", { attempt: honest({ id: [ATTEMPT_ID], ...leak }) }],
    // E — the wrong id, with every allowed state
    ...["submitted", "failed", "unknown", "signed", "submitting"].map((state): [string, unknown] => [`E: another attempt's id with state ${state}`, { attempt: honest({ id: "attempt-0", state, ...leak }) }]),
    ["E: an older-looking id", { attempt: honest({ id: ATTEMPT_ID + "0", ...leak }) }],
    ["E: id differs by case", { attempt: honest({ id: "ATTEMPT-1", ...leak }) }],
    ["E: id has a leading space", { attempt: honest({ id: ` ${ATTEMPT_ID}`, ...leak }) }],
    ["E: id has a trailing space", { attempt: honest({ id: `${ATTEMPT_ID} `, ...leak }) }],
    // F — unusable state strings
    ...["SUBMITTED", "Submitted", " submitted", "submitted ", "pending", "bogus", "", "sent"].map((state): [string, unknown] => [`F: state ${JSON.stringify(state)}`, { attempt: honest({ state, ...leak }) }]),
    // G — missing or non-string state
    ["G: state missing", { attempt: honest({ state: undefined, ...leak }) }],
    ["G: state null", { attempt: honest({ state: null, ...leak }) }],
    ["G: state numeric", { attempt: honest({ state: 5, ...leak }) }],
    ["G: state an object", { attempt: honest({ state: { value: "submitted" }, ...leak }) }],
    ["G: state an array", { attempt: honest({ state: ["submitted"], ...leak }) }],
    ["G: state boolean", { attempt: honest({ state: true, ...leak }) }],
    // H — supporting fields
    ["H: recipient missing", { attempt: honest({ recipient: undefined, ...leak }) }],
    ["H: recipient null", { attempt: honest({ recipient: null, ...leak }) }],
    ["H: recipient numeric", { attempt: honest({ recipient: 2, ...leak }) }],
    ["H: recipient an object", { attempt: honest({ recipient: { address: "0x2222222222222222222222222222222222222222" }, ...leak }) }],
    ["H: recipient is a different address", { attempt: honest({ recipient: "0x3333333333333333333333333333333333333333", ...leak }) }],
    ["H: recipient has padding", { attempt: honest({ recipient: " 0x2222222222222222222222222222222222222222", ...leak }) }],
    ["H: recipient differs by case only", { attempt: honest({ recipient: "0X2222222222222222222222222222222222222222", ...leak }) }],
    ["H: amount missing", { attempt: honest({ amountBaseUnits: undefined, ...leak }) }],
    ["H: amount null", { attempt: honest({ amountBaseUnits: null, ...leak }) }],
    ["H: amount a number", { attempt: honest({ amountBaseUnits: 1000000, ...leak }) }],
    ["H: amount an object", { attempt: honest({ amountBaseUnits: { value: "1000000" }, ...leak }) }],
    ["H: amount empty", { attempt: honest({ amountBaseUnits: "", ...leak }) }],
    ["H: amount with a fraction", { attempt: honest({ amountBaseUnits: "1000000.0", ...leak }) }],
    ["H: amount in exponent form", { attempt: honest({ amountBaseUnits: "1e6", ...leak }) }],
    ["H: amount padded", { attempt: honest({ amountBaseUnits: " 1000000", ...leak }) }],
    ["H: amount with a trailing newline", { attempt: honest({ amountBaseUnits: "1000000\n", ...leak }) }],
    ["H: amount negative", { attempt: honest({ amountBaseUnits: "-1000000", ...leak }) }],
    ["H: amount with a leading zero (digits, but not the held amount)", { attempt: honest({ amountBaseUnits: "01000000", ...leak }) }],
    ["H: amount a different digit string", { attempt: honest({ amountBaseUnits: "2000000", ...leak }) }],
    ["H: amount smaller", { attempt: honest({ amountBaseUnits: "999999", ...leak }) }],
    ["H: amount in non-ASCII digits", { attempt: honest({ amountBaseUnits: "１０００００００", ...leak }) }],
    ["H: failureReason an object", { attempt: honest({ failureReason: { message: MARKER } }) }],
    ["H: failureReason an array", { attempt: honest({ failureReason: [MARKER] }) }],
    ["H: failureReason numeric", { attempt: honest({ failureReason: 5, note: MARKER }) }],
    ["H: failureReason boolean", { attempt: honest({ failureReason: false, note: MARKER }) }],
    ["H: failureReason omitted (the server always sends string-or-null)", { attempt: honest({ failureReason: undefined, note: MARKER }) }],
    ["H: transactionHash an object", { attempt: honest({ transactionHash: { hash: MARKER }, ...leak }) }],
    ["H: transactionHash an array", { attempt: honest({ transactionHash: [MARKER] }) }],
    ["H: transactionHash numeric", { attempt: honest({ transactionHash: 5, ...leak }) }],
    ["H: transactionHash boolean", { attempt: honest({ transactionHash: true, ...leak }) }],
    ["H: transactionHash omitted (the server always sends string-or-null)", { attempt: honest({ transactionHash: undefined, note: MARKER }) }],
    // J — states this route cannot honestly answer in a 200
    ...["confirmed", "prepared", "awaiting_authorization", "cancelled"].map((state): [string, unknown] => [`J: disallowed state ${state}`, { attempt: honest({ state, transactionHash: state === "confirmed" ? "0xabc" : null, ...leak }) }]),
    // K — the top level
    ["K: top level an array", [{ attempt: honest() }]],
    ["K: top level an empty array", []],
    ["K: top level null", null],
    ["K: top level a string", MARKER],
    ["K: top level a number", 5],
    ["K: top level true", true],
    ["K: top level false", false],
  ];

  describe("a malformed or mismatched HTTP 200 is never adopted", () => {
    it.each(MALFORMED)("%s", async (_name, body) => {
      await expectRejected(body);
    });

    it("the matrix really covers every group, with no accidental duplicates", () => {
      expect(new Set(MALFORMED.map(([name]) => name)).size).toBe(MALFORMED.length);
      for (const group of ["A:", "B:", "C:", "D:", "E:", "F:", "G:", "H:", "J:", "K:"]) expect(MALFORMED.some(([name]) => name.startsWith(group))).toBe(true);
    });

    it("the amount must be digits even when it equals a (corrupt) held amount — equality alone is not enough", async () => {
      server({ submit: answer({ attempt: honest({ amountBaseUnits: "1.5", ...leak }) }) });
      const store = createRealPaymentStore();
      stores.push(store);
      store.setState({ attempt: { ...baseAttempt(), amountBaseUnits: "1.5" }, status: "awaiting_authorization", subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", clockOffsetSeconds: offsetFor(100_000) });
      await store.getState().resumeAuthorization();
      expect(store.getState()).toMatchObject({ status: "unknown", error: NEUTRAL, ...RETAINED });
      expect(store.getState().attempt).toMatchObject({ amountBaseUnits: "1.5", state: "awaiting_authorization" });
    });

    it("an unparseable 200 body is the pre-existing 'unknown' too (unchanged by D-7)", async () => {
      server({ submit: () => new Response("not json", { status: 200, headers: { "content-type": "application/json" } }) });
      const store = awaiting();
      await store.getState().resumeAuthorization();
      expect(store.getState()).toMatchObject({ status: "unknown", error: NEUTRAL, ...RETAINED });
    });
  });

  describe("an honest HTTP 200 behaves exactly as before D-7", () => {
    const CASES: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ["submitted", { state: "submitted" }, { status: "submitted", error: null, pendingSubmission: null }],
      ["failed with a reason", { state: "failed", failureReason: "The payment could not be sent." }, { status: "failed", error: null, pendingSubmission: null }],
      ["failed without a reason", { state: "failed" }, { status: "failed", error: null, pendingSubmission: null }],
      ["unknown", { state: "unknown", failureReason: "We could not confirm it." }, { status: "unknown", error: null, pendingSubmission: null }],
      ["submitting (a lost conditional write)", { state: "submitting" }, { status: "unknown", error: null, pendingSubmission: null }],
      ["signed (a lost conditional write)", { state: "signed" }, { status: "stranded", error: null, pendingSubmission: null }],
    ];

    it.each(CASES)("%s is adopted: the answer replaces the attempt, the approval is spent, one request, nothing else", async (_name, over, shown) => {
      const body = { attempt: honest(over) };
      const { api, store } = await submitOnce(body);

      expect(store.getState()).toMatchObject(shown);
      expect(store.getState().attempt).toEqual(body.attempt);
      expect(api.keys()).toEqual(["submit"]);
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
    });

    it("a transaction hash string and extra keys are accepted and kept", async () => {
      const body = { attempt: honest({ state: "submitted", transactionHash: "0xabc123", somethingNew: { nested: true } }), extra: 1 };
      const { store } = await submitOnce(body);
      expect(store.getState()).toMatchObject({ status: "submitted", pendingSubmission: null });
      expect(store.getState().attempt).toMatchObject({ transactionHash: "0xabc123" });
    });

    it("a valid recipientIdentity is accepted; so are a missing prepared, createdAt, updatedAt and recipientIdentity (not D-7 requirements)", async () => {
      const withIdentity = await submitOnce({ attempt: honest({ recipientIdentity: { handle: "smit", displayName: "Smit Patel" } }) });
      expect(withIdentity.store.getState()).toMatchObject({ status: "submitted" });

      const lean = await submitOnce({ attempt: { id: ATTEMPT_ID, state: "submitted", recipient: baseAttempt().recipient, amountBaseUnits: "1000000", transactionHash: null, failureReason: null } });
      expect(lean.store.getState()).toMatchObject({ status: "submitted", pendingSubmission: null });
    });

    it("the held recipient and amount are compared exactly — a handle payment's held attempt is accepted when the answer carries the same address", async () => {
      const api = server({ submit: answer({ attempt: honest({ recipientIdentity: { handle: "smit", displayName: null } }) }) });
      const store = createRealPaymentStore();
      stores.push(store);
      store.setState({ attempt: { ...baseAttempt(), recipientIdentity: { handle: "smit", displayName: null } }, status: "awaiting_authorization", subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", clockOffsetSeconds: offsetFor(100_000) });
      await store.getState().resumeAuthorization();
      expect(store.getState().status).toBe("submitted");
      expect(api.keys()).toEqual(["submit"]);
    });

    it("'confirmed' is no longer accepted from a submit 200 — unknown, with the approval kept and no balance refresh", async () => {
      const { api, store } = await submitOnce({ attempt: honest({ state: "confirmed", transactionHash: "0xabc" }) });
      expect(store.getState()).toMatchObject({ status: "unknown", error: NEUTRAL, ...RETAINED });
      expect(api.keys()).toEqual(["submit"]);
    });

    it("'confirmed' is still established through the authoritative status path (with its balance refresh)", async () => {
      const { api, store } = await submitOnce({ attempt: honest({ state: "confirmed", transactionHash: "0xabc" }) });
      server({ status: () => statusReply("confirmed"), balance: balanceReply });
      await store.getState().checkStatus();
      await settle();
      expect(store.getState()).toMatchObject({ status: "confirmed" });
      expect(store.getState().attempt?.state).toBe("confirmed");
      expect(api.count("submit")).toBe(1);
    });
  });

  describe("after a rejected answer the way forward is the user's own Check status — on the ORIGINAL payment", () => {
    const WRONG = { attempt: honest({ id: "attempt-evil", state: "submitted", ...leak }) };

    it("Check status asks about the held payment's id, never the returned one, and sends nothing else", async () => {
      const { api, store } = await submitOnce(WRONG);
      const second = server({ status: () => statusReply("submitted") });
      await store.getState().checkStatus();
      await settle();

      expect(second.calls.filter((call) => call.key === "status").map((call) => call.url)).toEqual([expect.stringContaining(`/${ATTEMPT_ID}/status`)]);
      expect(second.calls.some((call) => call.url.includes("attempt-evil"))).toBe(false);
      expect(second.keys()).toEqual(["status"]);
      expect(api.count("submit")).toBe(1);
      expect(store.getState()).toMatchObject({ status: "submitted" });
    });

    it("Check status 'still waiting for approval' leads to an explicit Continue: the SAME retained approval is re-sent, no second passkey prompt, one more submit", async () => {
      const { store } = await submitOnce(WRONG);
      server({ status: () => statusReply("awaiting_authorization") });
      await store.getState().checkStatus();
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", pendingSubmission: APPROVAL, authorizingCredentialId: "credential-1", subOrganizationId: "sub-org-1" });

      const again = server({ submit: answer({ attempt: honest({ state: "submitted" }) }) });
      await store.getState().resumeAuthorization();

      expect(again.calls.map((call) => call.body)).toEqual([APPROVAL]);
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
      expect(store.getState()).toMatchObject({ status: "submitted", pendingSubmission: null });
    });

    it("a second malformed answer rejects the same way — the approval is still kept, still nothing automatic", async () => {
      const { store } = await submitOnce(WRONG);
      server({ status: () => statusReply("awaiting_authorization") });
      await store.getState().checkStatus();
      const again = server({ submit: answer(WRONG) });
      await store.getState().resumeAuthorization();

      expect(store.getState()).toMatchObject({ status: "unknown", error: NEUTRAL, ...RETAINED });
      expect(again.keys()).toEqual(["submit"]);
    });

    it.each([
      ["submitted", "submitted", 0],
      ["failed", "failed", 0],
      ["confirmed", "confirmed", 1],
    ] as const)("Check status can establish '%s' through the existing status path", async (state, shown, balances) => {
      const { store } = await submitOnce(WRONG);
      const next = server({ status: () => statusReply(state), balance: balanceReply });
      await store.getState().checkStatus();
      await settle();

      expect(store.getState().status).toBe(shown);
      expect(next.count("balance")).toBe(balances);
      expect(next.count("submit")).toBe(0);
    });
  });

  describe("D-6 interleavings", () => {
    const MALFORMED_BODY = { attempt: honest({ id: "attempt-other", ...leak }) };

    it("a malformed answer just before 60 s is rejected at once; the deadline timer is gone and nothing changes at or after 60 s", async () => {
      const { gate, api, store, done } = await sending();
      await vi.advanceTimersByTimeAsync(DEADLINE - 1);
      expect(store.getState().status).toBe("submitting");

      gate.resolve(jsonResponse(200, MALFORMED_BODY));
      await done;
      expect(store.getState()).toMatchObject({ status: "unknown", error: NEUTRAL, ...RETAINED });
      expect(vi.getTimerCount()).toBe(0);
      const rejected = visible(store);

      await vi.advanceTimersByTimeAsync(10 * DEADLINE);
      expect(visible(store)).toEqual(rejected);
      expect(api.keys()).toEqual(["submit"]);
    });

    it("the deadline fires first: a late malformed answer writes nothing", async () => {
      const { gate, api, store, done } = await sending();
      await vi.advanceTimersByTimeAsync(DEADLINE);
      const atDeadline = visible(store);

      gate.resolve(jsonResponse(200, MALFORMED_BODY));
      await done;
      await settle();

      expect(visible(store)).toEqual(atDeadline);
      expect(vi.getTimerCount()).toBe(0);
      expect(api.keys()).toEqual(["submit"]);
    });

    it("the deadline fired and Check status re-opened the payment: a late malformed answer still writes nothing (not even to 'unknown')", async () => {
      const { gate, api, store, done } = await sending({ status: () => statusReply("awaiting_authorization") });
      await vi.advanceTimersByTimeAsync(DEADLINE);
      await store.getState().checkStatus();
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", pendingSubmission: APPROVAL });
      const afterCheck = visible(store);
      const callsBefore = api.calls.length;

      gate.resolve(jsonResponse(200, MALFORMED_BODY));
      await done;
      await settle();

      expect(visible(store)).toEqual(afterCheck);
      expect(api.calls).toHaveLength(callsBefore);
    });

    it("a status read already on its way becomes stale at the rejection: its answer is never applied over the unknown screen", async () => {
      const statusGate = held();
      const { gate, api, store, done } = await sending({ status: () => statusGate.promise });
      const checking = store.getState().checkStatus();
      await settle();
      expect(api.keys()).toEqual(["submit", "status"]);

      gate.resolve(jsonResponse(200, MALFORMED_BODY));
      await done;
      expect(store.getState()).toMatchObject({ status: "unknown", error: NEUTRAL });
      const rejected = visible(store);

      statusGate.resolve(statusReply("awaiting_authorization"));
      await checking;
      await settle();

      expect(visible(store)).toEqual(rejected);
      expect(api.count("status")).toBe(1);
    });

    const MOVES: Array<[string, (store: Store) => void | Promise<void>]> = [
      ["reset()", (store) => store.getState().reset()],
      ["detach()", (store) => store.getState().detach()],
      [
        "a remount (detach, then init)",
        async (store) => {
          store.getState().detach();
          await store.getState().init();
        },
      ],
      ["a new init() without a detach", (store) => store.getState().init()],
      ["another account signing in (no reset)", () => useRealAccountStore.setState({ account: ACCOUNT_B })],
      [
        "another account signing in (reset, then init)",
        async (store) => {
          useRealAccountStore.setState({ account: ACCOUNT_B });
          store.getState().reset();
          await store.getState().init();
        },
      ],
      ["the payment on screen being replaced by another", (store) => store.setState({ attempt: { ...baseAttempt(), id: ATTEMPT_ID_2 } })],
    ];

    it.each(MOVES)("a malformed answer arriving after %s writes nothing and sends nothing", async (_name, move) => {
      const { gate, api, store, done } = await sending({ latest: () => jsonResponse(200, { attempt: null }) });
      await move(store);
      await settle();
      const before = visible(store);
      const callsBefore = api.calls.length;

      gate.resolve(jsonResponse(200, MALFORMED_BODY));
      await done;
      await settle();

      expect(visible(store)).toEqual(before);
      expect(store.getState().error).not.toBe(NEUTRAL);
      expect(api.calls).toHaveLength(callsBefore);
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
    });

    it("a payment already shown as terminal is not moved to unknown by a malformed answer", async () => {
      const { gate, store, done } = await sending();
      store.setState({ status: "confirmed", attempt: { ...baseAttempt(), state: "confirmed", prepared: null } });
      const before = visible(store);

      gate.resolve(jsonResponse(200, MALFORMED_BODY));
      await done;

      expect(visible(store)).toEqual(before);
    });

    it("the rejection schedules no new timer and starts no request of its own", async () => {
      const { gate, api, store, done } = await sending();
      gate.resolve(jsonResponse(200, MALFORMED_BODY));
      await done;
      expect(vi.getTimerCount()).toBe(0);
      expect(api.keys()).toEqual(["submit"]);
      expect(store.getState().status).toBe("unknown");
    });
  });
});

/**
 * L-2 D-8: an exact HTTP 401 / 404 from POST /submit or GET /status gets fixed,
 * financially safe wording and a memory-only marker (`sessionRecovery`) that
 * lets the unknown screen offer an explicit session check. It changes nothing
 * about the payment: the status, attempt, approval and account context stay,
 * and nothing is requested, signed, retried, cancelled or refreshed because of
 * it. No D-8 test touches a real network, database, provider or passkey.
 */
describe("real-payment-store — L-2 D-8: HTTP 401 / 404 recovery", () => {
  const ACCOUNT_A = { appUserId: "app-user-1", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222" };
  const ACCOUNT_B = { appUserId: "app-user-2", ownerAddress: "0x4444444444444444444444444444444444444444", safeAddress: "0x5555555555555555555555555555555555555555" };
  const T0_MS = 1_800_000_000_000;
  const NEUTRAL = "We couldn't confirm whether this payment was sent. Check its status before trying again.";
  const SIGNED_OUT = "You're signed out, so we can't confirm this payment yet. Sign in again to check its status.";
  const NOT_ACCESSIBLE = "We can't check this payment with the current sign-in. It may still have gone through. Check that you're using the account that started it.";
  const APPROVAL = { attemptId: ATTEMPT_ID, signature: "0xsig-d8", activityId: "activity-d8" };
  const DEADLINE = SUBMIT_REQUEST_DEADLINE_MS;
  const RAW = /Not authenticated|Payment not found|Failed to fetch|Unexpected|not valid JSON|session-gone|cookie-gone/;

  type Key = "prepare" | "latest" | "cancel" | "status" | "submit" | "balance";
  type Handler = (n: number) => Response | Promise<Response>;
  type Store = ReturnType<typeof createRealPaymentStore>;
  const stores: Store[] = [];

  const unauthenticated = () => jsonResponse(401, { error: "Not authenticated." });
  const notFound = () => jsonResponse(404, { error: "Payment not found." });
  const SESSION_FAILURES: Array<["signed_out" | "not_accessible", string, () => Response]> = [
    ["signed_out", SIGNED_OUT, unauthenticated],
    ["not_accessible", NOT_ACCESSIBLE, notFound],
  ];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0_MS);
    vi.mocked(signPreparedPayment).mockReset();
    vi.mocked(signPreparedPayment).mockResolvedValue({ signature: APPROVAL.signature, activityId: APPROVAL.activityId } as never);
    useRealAccountStore.setState({ account: ACCOUNT_A });
  });

  afterEach(async () => {
    for (const store of stores.splice(0)) store.getState().reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.mocked(signPreparedPayment).mockReset();
    useRealAccountStore.setState({ account: null });
    (await import("@/lib/stores/real-balance-store")).useRealBalanceStore.getState().reset();
  });

  /** Every request is recorded — including one no handler expects, which also fails the request. */
  function server(handlers: Partial<Record<Key, Handler>>) {
    const calls: Array<{ key: Key | "other"; url: string; method: string; body: unknown }> = [];
    const counts: Record<Key, number> = { prepare: 0, latest: 0, cancel: 0, status: 0, submit: 0, balance: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        const key: Key | null = url.endsWith("/api/real/payments/prepare")
          ? "prepare"
          : url.endsWith("/api/real/payments/latest")
            ? "latest"
            : url.endsWith("/cancel")
              ? "cancel"
              : url.endsWith("/status")
                ? "status"
                : url.endsWith("/api/real/payments/submit")
                  ? "submit"
                  : url.endsWith("/api/real/account/balance")
                    ? "balance"
                    : null;
        calls.push({ key: key ?? "other", url, method, body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined });
        const handler = key ? handlers[key] : undefined;
        if (!key || !handler) throw new Error(`unexpected fetch: ${method} ${url}`);
        counts[key] += 1;
        return handler(counts[key]);
      }),
    );
    return { calls, keys: () => calls.map((call) => call.key), count: (key: Key) => calls.filter((call) => call.key === key).length };
  }

  function held() {
    let resolve: (response: Response) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const promise = new Promise<Response>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const settle = () => vi.advanceTimersByTimeAsync(0);
  const offsetFor = (secondsBeforeExpiry: number) => VALID_UNTIL - secondsBeforeExpiry - T0_MS / 1000;
  const serverNow = (secondsBeforeExpiry = 100_000) => Math.floor(Date.now() / 1000) + offsetFor(secondsBeforeExpiry);
  const statusReply = (state: string, extra: Record<string, unknown> = {}) =>
    jsonResponse(200, { attempt: { ...baseAttempt(), state, prepared: PREPARED_FIELDS }, serverNowSeconds: serverNow(), reconciliationDeferred: false, ...extra });
  const visible = (store: Store) => JSON.parse(JSON.stringify(store.getState())) as Record<string, unknown>;
  const accepted = (state: string) => () => jsonResponse(200, { attempt: { ...baseAttempt(), state, prepared: state === "awaiting_authorization" ? PREPARED_FIELDS : null } });

  function awaiting(): Store {
    const store = createRealPaymentStore();
    stores.push(store);
    store.setState({ attempt: baseAttempt(), status: "awaiting_authorization", subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", clockOffsetSeconds: offsetFor(100_000) });
    return store;
  }

  /** One Continue whose POST /submit is held open; returns once the request is on its way. */
  async function sending(handlers: Partial<Record<Key, Handler>> = {}) {
    const gate = held();
    const api = server({ submit: () => gate.promise, ...handlers });
    const store = awaiting();
    const done = store.getState().resumeAuthorization();
    await settle();
    expect(store.getState().status).toBe("submitting");
    return { gate, api, store, done };
  }

  /** A submit that ended with `submit`'s answer: the page is on the unknown screen. */
  async function afterSubmit(submit: Handler, others: Partial<Record<Key, Handler>> = {}) {
    const api = server({ submit, ...others });
    const store = awaiting();
    const before = structuredClone(store.getState().attempt);
    await store.getState().resumeAuthorization();
    await settle();
    return { api, store, before };
  }

  /** What stays exactly as it was: the approval and the whole signing context. */
  const RETAINED = { pendingSubmission: APPROVAL, authorizingCredentialId: "credential-1", subOrganizationId: "sub-org-1", isAuthorizing: false };

  it("the exported wording is exactly the approved copy, and says nothing about the payment not being sent", () => {
    expect(SIGNED_OUT_PAYMENT_MESSAGE).toBe(SIGNED_OUT);
    expect(PAYMENT_NOT_ACCESSIBLE_MESSAGE).toBe(NOT_ACCESSIBLE);
    for (const copy of [SIGNED_OUT_PAYMENT_MESSAGE, PAYMENT_NOT_ACCESSIBLE_MESSAGE]) {
      expect(copy).not.toMatch(/wasn't sent|was not sent|not sent|didn't go through|failed|cancel|retry|try again/i);
    }
    expect(PAYMENT_NOT_ACCESSIBLE_MESSAGE).toContain("It may still have gone through.");
  });

  describe("A. submit 401 / 404", () => {
    it.each(SESSION_FAILURES)("%s: the existing unknown state with the fixed wording — attempt, approval and context kept, one submit, nothing else", async (reason, message, answer) => {
      const { api, store, before } = await afterSubmit(answer);

      expect(store.getState()).toMatchObject({ status: "unknown", error: message, sessionRecovery: reason, ...RETAINED });
      expect(store.getState().attempt).toEqual(before);
      expect(store.getState().attempt).toMatchObject({ id: ATTEMPT_ID, state: "awaiting_authorization", failureReason: null, transactionHash: null });
      expect(JSON.stringify(visible(store))).not.toMatch(RAW);
      expect(api.calls.map(({ key, method, body }) => ({ key, method, body }))).toEqual([{ key: "submit", method: "POST", body: APPROVAL }]);
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      // Nothing happens by itself afterwards: no status read, balance refresh, retry, cancel or prepare.
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(api.keys()).toEqual(["submit"]);
      expect(store.getState()).toMatchObject({ status: "unknown", error: message, sessionRecovery: reason, ...RETAINED });
    });

    it.each(SESSION_FAILURES)("%s carrying the exact wrong_passkey body is still the 401/404 wording — never the cancel-only screen", async (reason, message) => {
      const status = reason === "signed_out" ? 401 : 404;
      const { api, store } = await afterSubmit(() => jsonResponse(status, { error: "This payment was started with a different passkey.", code: "wrong_passkey" }));

      expect(store.getState()).toMatchObject({ status: "unknown", error: message, sessionRecovery: reason, ...RETAINED });
      expect(api.keys()).toEqual(["submit"]);
    });

    it.each(SESSION_FAILURES)("the fresh flow (Review, Approve, prepare, passkey, submit) gets the same %s outcome", async (reason, message, answer) => {
      const api = server({
        prepare: () => jsonResponse(200, { attempt: { ...baseAttempt(), id: PREPARED_ID, recipient: "0x3333333333333333333333333333333333333333" }, subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: serverNow() }),
        submit: answer,
      });
      const store = createRealPaymentStore();
      stores.push(store);
      store.setState({ status: "editing" });
      store.getState().setRecipientInput("0x3333333333333333333333333333333333333333");
      store.getState().setAmountInput("1");
      await store.getState().review();
      await store.getState().confirmAndSend();
      await settle();

      expect(store.getState()).toMatchObject({ status: "unknown", error: message, sessionRecovery: reason, pendingSubmission: { attemptId: PREPARED_ID, signature: APPROVAL.signature, activityId: APPROVAL.activityId } });
      expect(store.getState().attempt).toMatchObject({ id: PREPARED_ID });
      expect(api.keys()).toEqual(["prepare", "submit"]);
    });
  });

  describe("B. exact classification: only an ApiError with status 401 or 404", () => {
    const OTHERS: Array<[string, Handler]> = [
      ["HTTP 400", () => jsonResponse(400, { error: "Not authenticated." })],
      ["HTTP 403", () => jsonResponse(403, { error: "Not authenticated." })],
      ["HTTP 409 (no code)", () => jsonResponse(409, { error: "Payment not found." })],
      ["HTTP 410", () => jsonResponse(410, { error: "Payment not found." })],
      ["HTTP 429 (not the budget denial)", () => jsonResponse(429, { error: "Not authenticated.", code: "rate_limited" })],
      ["HTTP 500 whose text says 401", () => jsonResponse(500, { error: "401 Not authenticated." })],
      ["HTTP 500 whose text says 404", () => jsonResponse(500, { error: "404 Payment not found." })],
      ["HTTP 502", () => jsonResponse(502, { error: "Not authenticated." })],
      ["HTTP 503 (not retryable)", () => jsonResponse(503, { error: "Payment not found." })],
      ["a network failure", () => Promise.reject(new TypeError("Failed to fetch"))],
      ["a plain Error whose message says 'Not authenticated.'", () => Promise.reject(new Error("Not authenticated."))],
      ["a non-JSON 401 (the body cannot be read, so it is not an ApiError)", () => new Response("<html>401 session-gone</html>", { status: 401 })],
      ["a non-JSON 404", () => new Response("<html>404 cookie-gone</html>", { status: 404 })],
      ["a 401 whose body is JSON null", () => new Response("null", { status: 401 })],
    ];

    it.each(OTHERS)("submit: %s keeps the generic conservative wording and does not set the marker", async (_name, answer) => {
      const { api, store } = await afterSubmit(answer);

      expect(store.getState()).toMatchObject({ status: "unknown", error: NEUTRAL, sessionRecovery: null, ...RETAINED });
      expect(api.keys()).toEqual(["submit"]);
    });

    // A JSON-null body makes api() read `json.error` off null; that throws a TypeError (not an ApiError), so even that 401 is not special.
    it.each([400, 403, 409, 410, 429, 500, 502, 503] as const)("status read: HTTP %i keeps its existing wording and does not set the marker", async (code) => {
      const submit = accepted("submitted");
      const api = server({ submit, status: () => jsonResponse(code, { error: "The server's own sentence." }) });
      const store = awaiting();
      await store.getState().resumeAuthorization();
      await settle();
      await store.getState().checkStatus();

      expect(store.getState().sessionRecovery).toBeNull();
      expect(store.getState().error).toBe("The server's own sentence.");
      expect(api.count("status")).toBe(1);
    });

    it.each([
      ["401", 401, "signed_out", SIGNED_OUT],
      ["404", 404, "not_accessible", NOT_ACCESSIBLE],
    ] as const)("the status code decides, never the server's sentence: a %s with any (or no) text is still the fixed wording", async (_name, code, reason, message) => {
      for (const body of [{ error: "Session expired." }, { error: "nope" }, {}, { error: "" }, { message: "Not authenticated." }]) {
        const { api, store } = await afterSubmit(() => jsonResponse(code, body));
        expect(store.getState()).toMatchObject({ status: "unknown", error: message, sessionRecovery: reason, ...RETAINED });
        expect(api.keys()).toEqual(["submit"]);
        store.getState().reset();
        vi.unstubAllGlobals();
      }
    });

    it("status read: a network failure and a plain Error('Not authenticated.') do not set the marker", async () => {
      const store = awaiting();
      server({ status: () => Promise.reject(new Error("Not authenticated.")) });
      await store.getState().checkStatus();

      expect(store.getState().sessionRecovery).toBeNull();
      expect(store.getState().error).toBe("Not authenticated.");
    });
  });

  describe("C. status read 401 / 404", () => {
    /** A submit that ended without an answer, leaving the unknown screen with the full signing context. */
    async function unknownScreen(status: Handler, others: Partial<Record<Key, Handler>> = {}) {
      const api = server({ submit: () => jsonResponse(500, { error: "Something went wrong." }), status, ...others });
      const store = awaiting();
      await store.getState().resumeAuthorization();
      await settle();
      expect(store.getState()).toMatchObject({ status: "unknown", error: NEUTRAL, sessionRecovery: null, ...RETAINED });
      return { api, store };
    }

    it.each(SESSION_FAILURES)("manual Check status %s: fixed wording and marker only — status, attempt, approval, context and cooldown stay; nothing else is requested", async (reason, message, answer) => {
      const { api, store } = await unknownScreen(answer);
      const attemptBefore = structuredClone(store.getState().attempt);

      await store.getState().checkStatus();

      expect(store.getState()).toMatchObject({ status: "unknown", error: message, sessionRecovery: reason, isManualCheckCoolingDown: true, ...RETAINED });
      expect(store.getState().attempt).toEqual(attemptBefore);
      expect(JSON.stringify(visible(store))).not.toMatch(RAW);
      expect(api.keys()).toEqual(["submit", "status"]);
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
      // The existing cooldown still applies, then ends — and nothing is requested by itself, ever.
      await store.getState().checkStatus();
      expect(api.count("status")).toBe(1);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(api.keys()).toEqual(["submit", "status"]);
      expect(store.getState()).toMatchObject({ status: "unknown", error: message, sessionRecovery: reason, isManualCheckCoolingDown: false, ...RETAINED });
    });

    it.each(SESSION_FAILURES)("the status read asks about the original payment only (%s)", async (_reason, _message, answer) => {
      const { api, store } = await unknownScreen(answer);
      await store.getState().checkStatus();

      const read = api.calls.find((call) => call.key === "status")!;
      expect(read.url).toContain(`/${ATTEMPT_ID}/status`);
      expect(read.method).toBe("GET");
    });

    it.each(SESSION_FAILURES)("on the other screens the same fixed wording replaces the raw text and the status does not change (%s)", async (reason, message, answer) => {
      for (const state of ["awaiting_authorization", "stranded", "submitted"] as const) {
        const api = server({ status: answer });
        const store = createRealPaymentStore();
        stores.push(store);
        store.setState({ attempt: { ...baseAttempt(), state: state === "stranded" ? "signed" : state }, status: state, subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", clockOffsetSeconds: offsetFor(100_000) });

        await store.getState().checkStatus();

        expect(store.getState()).toMatchObject({ status: state, error: message, sessionRecovery: reason });
        expect(JSON.stringify(visible(store))).not.toMatch(RAW);
        expect(api.keys()).toEqual(["status"]);
        store.getState().reset();
      }
    });

    it.each(SESSION_FAILURES)("an AUTOMATIC status read (an expired approval found on mount) gets the same handling (%s) — and starts nothing extra", async (reason, message, answer) => {
      const expiredNow = () => jsonResponse(200, { attempt: baseAttempt(), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: serverNow(-10) });
      const api = server({ latest: expiredNow, status: answer });
      const store = createRealPaymentStore();
      stores.push(store);

      await store.getState().init();
      await settle();

      expect(api.keys()).toEqual(["latest", "status"]);
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", isAttemptPastValidity: true, error: message, sessionRecovery: reason, authorizingCredentialId: "credential-1" });
      expect(store.getState().attempt).toMatchObject({ id: ATTEMPT_ID, state: "awaiting_authorization" });
      expect(api.keys()).not.toContain("submit");
      expect(api.keys()).not.toContain("cancel");
      expect(api.keys()).not.toContain("prepare");
      expect(api.keys()).not.toContain("balance");
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });

    it.each(SESSION_FAILURES)("the post-submit automatic check gets the same handling (%s); the payment stays 'submitted'", async (reason, message, answer) => {
      const api = server({ submit: accepted("submitted"), status: answer });
      const store = awaiting();
      await store.getState().resumeAuthorization();
      await settle();
      expect(store.getState().status).toBe("submitted");

      await store.getState().checkSubmittedStatus();

      expect(store.getState()).toMatchObject({ status: "submitted", error: message, sessionRecovery: reason });
      expect(api.keys()).toEqual(["submit", "status"]);
      expect(api.keys()).not.toContain("balance");
    });

    it("a status read that returns 401, and a status read after it that is answered, clears the marker — a valid settled answer is the way back", async () => {
      let n = 0;
      const { store } = await unknownScreen(() => (++n === 1 ? unauthenticated() : statusReply("awaiting_authorization")));
      await store.getState().checkStatus();
      expect(store.getState()).toMatchObject({ error: SIGNED_OUT, sessionRecovery: "signed_out" });

      await vi.advanceTimersByTimeAsync(MANUAL_CHECK_COOLDOWN_MS);
      await store.getState().checkStatus();

      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", error: null, sessionRecovery: null });
    });

    it("every answered read clears the marker: a deferral and a malformed verdict too (they prove the session works)", async () => {
      for (const answer of [
        () => statusReply("unknown", { reconciliationDeferred: true, retryAfterSeconds: 120 }),
        () => statusReply("unknown", { reconciliationDeferred: "yes" }),
        () => statusReply("submitted"),
      ]) {
        let n = 0;
        const { store } = await unknownScreen(() => (++n === 1 ? notFound() : answer()));
        await store.getState().checkStatus();
        expect(store.getState().sessionRecovery).toBe("not_accessible");
        await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
        await store.getState().checkStatus();
        expect(store.getState().sessionRecovery).toBeNull();
        expect(store.getState().error).not.toBe(NOT_ACCESSIBLE);
        store.getState().reset();
        vi.unstubAllGlobals();
      }
    });

    it("a later failure that is not a 401 / 404 keeps its own wording and leaves the earlier marker for the lifecycle to clear", async () => {
      let n = 0;
      const { store } = await unknownScreen(() => (++n === 1 ? unauthenticated() : jsonResponse(500, { error: "Something went wrong." })));
      await store.getState().checkStatus();
      await vi.advanceTimersByTimeAsync(MANUAL_CHECK_COOLDOWN_MS);
      await store.getState().checkStatus();

      expect(store.getState()).toMatchObject({ status: "unknown", error: "Something went wrong.", sessionRecovery: "signed_out", ...RETAINED });
    });

    it("401 then 404 (the session changed in between): the marker follows the latest classified failure", async () => {
      let n = 0;
      const { store } = await unknownScreen(() => (++n === 1 ? unauthenticated() : notFound()));
      await store.getState().checkStatus();
      await vi.advanceTimersByTimeAsync(MANUAL_CHECK_COOLDOWN_MS);
      await store.getState().checkStatus();

      expect(store.getState()).toMatchObject({ error: NOT_ACCESSIBLE, sessionRecovery: "not_accessible", ...RETAINED });
    });
  });

  describe("D. the marker belongs to its lifecycle", () => {
    async function marked(reason: "signed_out" | "not_accessible" = "signed_out", others: Partial<Record<Key, Handler>> = {}) {
      const answer = reason === "signed_out" ? unauthenticated : notFound;
      const api = server({ submit: answer, ...others });
      const store = awaiting();
      await store.getState().resumeAuthorization();
      await settle();
      expect(store.getState().sessionRecovery).toBe(reason);
      return { api, store };
    }

    it("init() drops it (and, as ever, everything else), whatever /latest then answers", async () => {
      const { store } = await marked("signed_out", { latest: () => jsonResponse(200, { attempt: null }) });
      await store.getState().init();
      expect(store.getState()).toMatchObject({ status: "editing", sessionRecovery: null, attempt: null, pendingSubmission: null, error: null });
    });

    it("init() clears it synchronously, before its own request is answered", async () => {
      const gate = held();
      const { store } = await marked("not_accessible", { latest: () => gate.promise });
      const pending = store.getState().init();
      expect(store.getState()).toMatchObject({ status: "idle", sessionRecovery: null, error: null, attempt: null, pendingSubmission: null });
      gate.resolve(jsonResponse(200, { attempt: null }));
      await pending;
    });

    it("init() restoring the same unknown payment from the server carries no marker and no stale wording", async () => {
      const { store } = await marked("signed_out", { latest: () => jsonResponse(200, { attempt: { ...baseAttempt(), state: "unknown", prepared: null }, ...NO_SIGNING_CONTEXT, serverNowSeconds: serverNow() }) });
      await store.getState().init();
      expect(store.getState()).toMatchObject({ status: "unknown", sessionRecovery: null, error: null, pendingSubmission: null, authorizingCredentialId: null });
      expect(store.getState().attempt).toMatchObject({ id: ATTEMPT_ID, state: "unknown" });
    });

    it("reset() drops it", async () => {
      const { store } = await marked();
      store.getState().reset();
      expect(store.getState()).toMatchObject({ sessionRecovery: null, attempt: null, pendingSubmission: null, error: null });
    });

    it("detach() drops it (the Pay form left the screen); the attempt is left for the next init to re-read", async () => {
      const { store } = await marked("not_accessible");
      store.getState().detach();
      expect(store.getState()).toMatchObject({ sessionRecovery: null, status: "unknown" });
      expect(store.getState().attempt).toMatchObject({ id: ATTEMPT_ID });
    });

    it("a successful Cancel drops it", async () => {
      const { store } = await marked("signed_out", { cancel: () => jsonResponse(200, { attempt: { ...baseAttempt(), state: "cancelled", prepared: null } }) });
      await store.getState().cancel();
      expect(store.getState()).toMatchObject({ status: "editing", sessionRecovery: null, attempt: null, error: null });
    });

    it("a new submit drops it, however it then ends", async () => {
      const gate = held();
      const api = server({ submit: () => gate.promise });
      const store = awaiting();
      store.setState({ sessionRecovery: "signed_out", error: SIGNED_OUT });
      const done = store.getState().resumeAuthorization();
      await settle();
      expect(store.getState()).toMatchObject({ status: "submitting", sessionRecovery: null, error: null });
      gate.resolve(accepted("submitted")());
      await done;
      expect(store.getState()).toMatchObject({ status: "submitted", sessionRecovery: null });
      expect(api.count("submit")).toBe(1);
    });

    it("the D-6 deadline and a malformed 200 (D-7) leave no marker: their wording is the generic one", async () => {
      const { store, done, gate } = await sending();
      store.setState({ sessionRecovery: "signed_out" });
      await vi.advanceTimersByTimeAsync(DEADLINE);
      expect(store.getState()).toMatchObject({ status: "unknown", error: NEUTRAL, sessionRecovery: null });
      gate.resolve(unauthenticated());
      await done;

      const malformed = await afterSubmit(() => jsonResponse(200, { nothing: true }));
      expect(malformed.store.getState()).toMatchObject({ status: "unknown", error: NEUTRAL, sessionRecovery: null, ...RETAINED });
    });

    it("a different account: the form's init() leaves nothing of the old marker, attempt or approval, and the new account reads only its own /latest", async () => {
      const { store } = await marked();
      const api = server({ latest: () => jsonResponse(200, { attempt: null }) });
      useRealAccountStore.setState({ account: ACCOUNT_B });

      await store.getState().init();

      expect(store.getState()).toMatchObject({ status: "editing", sessionRecovery: null, attempt: null, pendingSubmission: null, authorizingCredentialId: null, subOrganizationId: null, error: null });
      expect(api.keys()).toEqual(["latest"]);
      expect(api.calls.some((call) => call.url.includes(ATTEMPT_ID))).toBe(false);
    });
  });

  describe("E. stale answers write nothing", () => {
    it("a 401 for the payment of an ACCOUNT that has since been replaced is dropped (status read)", async () => {
      const gate = held();
      server({ status: () => gate.promise });
      const store = awaiting();
      const pending = store.getState().checkStatus();
      await settle();
      useRealAccountStore.setState({ account: ACCOUNT_B });
      const before = visible(store);

      gate.resolve(unauthenticated());
      await pending;

      expect(store.getState().sessionRecovery).toBeNull();
      expect(store.getState().error).toBeNull();
      expect(visible(store)).toEqual(before);
    });

    it("a 404 after reset() / a new lifecycle is dropped (status read)", async () => {
      for (const end of ["reset", "init", "detach"] as const) {
        const gate = held();
        server({ status: () => gate.promise, latest: () => jsonResponse(200, { attempt: null }) });
        const store = awaiting();
        const pending = store.getState().checkStatus();
        await settle();
        if (end === "reset") store.getState().reset();
        else if (end === "init") await store.getState().init();
        else store.getState().detach();
        const after = visible(store);

        gate.resolve(notFound());
        await pending;

        expect(visible(store), end).toEqual(after);
        expect(store.getState().sessionRecovery, end).toBeNull();
        store.getState().reset();
        vi.unstubAllGlobals();
      }
    });

    it("an OLDER-EPOCH 401 (the read began before a submit) never overwrites the newer state", async () => {
      const readGate = held();
      const submitGate = held();
      const api = server({ status: () => readGate.promise, submit: () => submitGate.promise });
      const store = awaiting();
      const read = store.getState().checkStatus();
      await settle();
      const sending = store.getState().resumeAuthorization();
      await settle();
      expect(store.getState().status).toBe("submitting");

      readGate.resolve(unauthenticated());
      await read;
      await settle();

      expect(store.getState()).toMatchObject({ status: "submitting", error: null, sessionRecovery: null });

      submitGate.resolve(accepted("submitted")());
      await sending;
      expect(store.getState()).toMatchObject({ status: "submitted", error: null, sessionRecovery: null });
      expect(api.count("submit")).toBe(1);
    });

    it("a late submit 401 / 404 after the D-6 deadline is ignored — the timeout state stays, and a Check status that moved on is not overwritten", async () => {
      for (const [, , answer] of SESSION_FAILURES) {
        const { gate, store, done } = await sending({ status: () => statusReply("awaiting_authorization") });
        await vi.advanceTimersByTimeAsync(DEADLINE);
        expect(store.getState()).toMatchObject({ status: "unknown", error: NEUTRAL, sessionRecovery: null });

        gate.resolve(answer());
        await done;
        expect(store.getState()).toMatchObject({ status: "unknown", error: NEUTRAL, sessionRecovery: null, ...RETAINED });

        await store.getState().checkStatus();
        expect(store.getState()).toMatchObject({ status: "awaiting_authorization", error: null, sessionRecovery: null });
        store.getState().reset();
        vi.unstubAllGlobals();
      }
    });

    it("a late submit 401 / 404 that arrives AFTER a Check status re-opened the payment writes nothing", async () => {
      for (const [, , answer] of SESSION_FAILURES) {
        const { gate, store, done } = await sending({ status: () => statusReply("awaiting_authorization") });
        await vi.advanceTimersByTimeAsync(DEADLINE);
        await store.getState().checkStatus();
        expect(store.getState()).toMatchObject({ status: "awaiting_authorization", error: null, sessionRecovery: null, ...RETAINED });
        const after = visible(store);

        gate.resolve(answer());
        await done;

        // The page is on a screen that would accept a submit answer, and still ignores this one: it belongs to the request the deadline already decided.
        expect(visible(store)).toEqual(after);
        expect(store.getState().sessionRecovery).toBeNull();
        store.getState().reset();
        vi.unstubAllGlobals();
      }
    });

    it("a timely submit 401 / 404 (just inside the deadline) is applied and stops the timer", async () => {
      for (const [reason, message, answer] of SESSION_FAILURES) {
        const { gate, store, done } = await sending();
        await vi.advanceTimersByTimeAsync(DEADLINE - 1);
        expect(store.getState().status).toBe("submitting");

        gate.resolve(answer());
        await done;

        expect(store.getState()).toMatchObject({ status: "unknown", error: message, sessionRecovery: reason, ...RETAINED });
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(DEADLINE);
        expect(store.getState()).toMatchObject({ status: "unknown", error: message, sessionRecovery: reason });
        store.getState().reset();
        vi.unstubAllGlobals();
      }
    });

    it("a submit 401 for a context that has since been replaced writes nothing (reset, a new account)", async () => {
      for (const change of ["reset", "account"] as const) {
        const { gate, store, done } = await sending();
        if (change === "reset") store.getState().reset();
        else useRealAccountStore.setState({ account: ACCOUNT_B });
        const after = visible(store);

        gate.resolve(unauthenticated());
        await done;

        expect(visible(store), change).toEqual(after);
        expect(store.getState().sessionRecovery, change).toBeNull();
        store.getState().reset();
        vi.unstubAllGlobals();
        useRealAccountStore.setState({ account: ACCOUNT_A });
      }
    });
  });

  describe("F. what did not change", () => {
    it("a valid submit 200 maps exactly as before, and the existing wrong_passkey refusal is still the cancel-only screen", async () => {
      const ok = await afterSubmit(accepted("submitted"));
      expect(ok.store.getState()).toMatchObject({ status: "submitted", error: null, pendingSubmission: null, sessionRecovery: null });

      const wrong = await afterSubmit(() => jsonResponse(409, { error: "This payment was started with a different passkey.", code: "wrong_passkey" }));
      expect(wrong.store.getState()).toMatchObject({ status: "stranded", pendingSubmission: null, authorizingCredentialId: null, sessionRecovery: null });
    });

    it("the budget denial and the retryable refusal are still handled before any 401 / 404 logic", async () => {
      const denied = await afterSubmit(() => new Response(JSON.stringify({ error: "Too many tries.", code: "rate_limited", retryable: true }), { status: 429, headers: { "content-type": "application/json", "Retry-After": "30" } }));
      expect(denied.store.getState()).toMatchObject({ status: "awaiting_authorization", sessionRecovery: null, pendingSubmission: APPROVAL });

      const retryable = await afterSubmit(() => jsonResponse(503, { error: "Try again in a moment.", retryable: true }));
      expect(retryable.store.getState()).toMatchObject({ status: "awaiting_authorization", error: "Try again in a moment.", sessionRecovery: null, pendingSubmission: APPROVAL });
    });

    it("init() still treats a 401 on /latest as before: the plain form, no marker, no fixed wording", async () => {
      server({ latest: unauthenticated });
      const store = createRealPaymentStore();
      stores.push(store);
      await store.getState().init();
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, sessionRecovery: null, error: null });
    });
  });
});

/**
 * L-2 D-10: a GET /status HTTP 200 whose body is not an honest answer about the
 * payment THIS page holds (not an object, no or foreign attempt, an unknown
 * state, another recipient or amount, unusable supporting fields, a different
 * prepared presence, a non-finite server clock) is never read, adopted or acted
 * on. It takes the existing unusable-answer fallback: fixed copy, the existing
 * 60 s deferral, and the payment left exactly as it was. The same check guards
 * the status read that follows a refused Cancel. A rejection says nothing about
 * what happened to the payment. No D-10 test touches a real network, database,
 * provider or passkey.
 */
describe("real-payment-store — L-2 D-10: malformed status response recovery", () => {
  const ACCOUNT_A = { appUserId: "app-user-1", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222" };
  const ACCOUNT_B = { appUserId: "app-user-2", ownerAddress: "0x4444444444444444444444444444444444444444", safeAddress: "0x5555555555555555555555555555555555555555" };
  const T0_MS = 1_800_000_000_000;
  const UNUSABLE = "We couldn’t check on this payment just now. Try again in a little while.";
  const CANCEL_UNCONFIRMED = "Could not confirm whether this payment was cancelled. Check its status before trying again.";
  const CANCEL_LOST_RACE = "This payment could not be cancelled — it may already be on its way.";
  const NEUTRAL = SUBMIT_UNCONFIRMED_MESSAGE;
  const APPROVAL = { attemptId: ATTEMPT_ID, signature: "0xsig-d10", activityId: "activity-d10" };
  /** Distinctive malformed values: none of them may ever appear anywhere in the store. */
  const LEAK = /FOREIGN|refunded-by-bank|0xdead|Cannot read|TypeError|Unexpected|not valid JSON|Failed to fetch|unexpected fetch/;

  type Key = "prepare" | "latest" | "cancel" | "status" | "submit" | "balance";
  type Handler = (n: number) => Response | Promise<Response>;
  type Store = ReturnType<typeof createRealPaymentStore>;
  const stores: Store[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0_MS);
    vi.mocked(signPreparedPayment).mockReset();
    vi.mocked(signPreparedPayment).mockResolvedValue({ signature: APPROVAL.signature, activityId: APPROVAL.activityId } as never);
    useRealAccountStore.setState({ account: ACCOUNT_A });
  });

  afterEach(async () => {
    for (const store of stores.splice(0)) store.getState().reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.mocked(signPreparedPayment).mockReset();
    useRealAccountStore.setState({ account: null });
    (await import("@/lib/stores/real-balance-store")).useRealBalanceStore.getState().reset();
  });

  /** Every request is recorded — including one no handler expects, which also fails the request. */
  function server(handlers: Partial<Record<Key, Handler>>) {
    const calls: Array<{ key: Key | "other"; url: string; method: string }> = [];
    const counts: Record<Key, number> = { prepare: 0, latest: 0, cancel: 0, status: 0, submit: 0, balance: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        const key: Key | null = url.endsWith("/api/real/payments/prepare")
          ? "prepare"
          : url.endsWith("/api/real/payments/latest")
            ? "latest"
            : url.endsWith("/cancel")
              ? "cancel"
              : url.endsWith("/status")
                ? "status"
                : url.endsWith("/api/real/payments/submit")
                  ? "submit"
                  : url.endsWith("/api/real/account/balance")
                    ? "balance"
                    : null;
        calls.push({ key: key ?? "other", url, method });
        const handler = key ? handlers[key] : undefined;
        if (!key || !handler) throw new Error(`unexpected fetch: ${method} ${url}`);
        counts[key] += 1;
        return handler(counts[key]);
      }),
    );
    return { calls, keys: () => calls.map((call) => call.key), count: (key: Key) => calls.filter((call) => call.key === key).length };
  }

  function held<T = Response>() {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  const settle = () => vi.advanceTimersByTimeAsync(0);
  const offsetFor = (secondsBeforeExpiry: number) => VALID_UNTIL - secondsBeforeExpiry - T0_MS / 1000;
  const serverNow = (secondsBeforeExpiry = 100_000) => Math.floor(Date.now() / 1000) + offsetFor(secondsBeforeExpiry);
  const visible = (store: Store) => JSON.parse(JSON.stringify(store.getState())) as Record<string, unknown>;
  const balanceReply = () => jsonResponse(200, { token: "USDC", decimals: 6, balanceBaseUnits: "0" });
  const J = (body: unknown) => jsonResponse(200, body);
  /** A 200 whose JSON carries values JSON text cannot (NaN, Infinity). */
  const raw = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body }) as unknown as Response;

  /** The server's own shape: the stored row keeps its prepared fields after a transition (toPublicAttempt). `undefined` overrides drop the key. */
  const attemptOf = (state: string, over: Record<string, unknown> = {}) => ({ ...baseAttempt(), state, prepared: PREPARED_FIELDS, ...over });
  const bodyOf = (state = "submitted", over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({ attempt: attemptOf(state, over), serverNowSeconds: serverNow(), reconciliationDeferred: false, ...top });
  const honest = (state = "submitted", over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => J(bodyOf(state, over, top));
  const withAttempt = (over: Record<string, unknown>) => () => J(bodyOf("submitted", over));
  const withTop = (top: Record<string, unknown>) => () => J(bodyOf("submitted", {}, top));

  type HeldKind = "submitted" | "awaiting" | "stranded" | "unknown";
  const HELD_KINDS: HeldKind[] = ["submitted", "awaiting", "stranded", "unknown"];
  const SHAPES: Record<HeldKind, { state: string; status: string }> = {
    submitted: { state: "submitted", status: "submitted" },
    awaiting: { state: "awaiting_authorization", status: "awaiting_authorization" },
    stranded: { state: "signed", status: "stranded" },
    unknown: { state: "unknown", status: "unknown" },
  };

  /** A store holding the payment the way each screen does, approval and signing context included. */
  function holding(kind: HeldKind, over: Record<string, unknown> = {}): Store {
    const store = createRealPaymentStore();
    stores.push(store);
    const { state, status } = SHAPES[kind];
    store.setState({
      attempt: attemptOf(state, over) as never,
      status: status as never,
      subOrganizationId: "sub-org-1",
      authorizingCredentialId: "credential-1",
      clockOffsetSeconds: offsetFor(100_000),
      pendingSubmission: kind === "awaiting" ? null : APPROVAL,
    });
    return store;
  }

  /** Everything a rejected answer must leave exactly as it was. */
  const kept = (store: Store) => {
    const s = store.getState();
    return structuredClone({
      attempt: s.attempt,
      status: s.status,
      pendingSubmission: s.pendingSubmission,
      authorizingCredentialId: s.authorizingCredentialId,
      subOrganizationId: s.subOrganizationId,
      clockOffsetSeconds: s.clockOffsetSeconds,
      isAttemptPastValidity: s.isAttemptPastValidity,
      isAuthorizing: s.isAuthorizing,
    });
  };

  type Case = [string, () => Response];
  const MALFORMED: Case[] = [
    // Q. the top-level value
    ["top-level null", () => J(null)],
    ["top-level string", () => J("ok")],
    ["top-level number", () => J(5)],
    ["top-level true", () => J(true)],
    ["top-level array", () => J([bodyOf()])],
    // A-C. the attempt
    ["no attempt", () => J({ serverNowSeconds: serverNow(), reconciliationDeferred: false })],
    ["attempt: null", withTop({ attempt: null })],
    ["attempt: a string", withTop({ attempt: ATTEMPT_ID })],
    ["attempt: a number", withTop({ attempt: 1 })],
    ["attempt: an array holding the honest attempt", withTop({ attempt: [attemptOf("submitted")] })],
    // D-F. the id
    ["no id", withAttempt({ id: undefined })],
    ["empty id", withAttempt({ id: "" })],
    ["numeric id", withAttempt({ id: 1 })],
    ["null id", withAttempt({ id: null })],
    ["object id", withAttempt({ id: {} })],
    ["foreign id", withAttempt({ id: "attempt-FOREIGN" })],
    ["case-folded id", withAttempt({ id: "ATTEMPT-1" })],
    ["leading-space id", withAttempt({ id: ` ${ATTEMPT_ID}` })],
    ["trailing-space id", withAttempt({ id: `${ATTEMPT_ID} ` })],
    // G-I. the state
    ["no state", withAttempt({ state: undefined })],
    ["unknown state", withAttempt({ state: "refunded-by-bank" })],
    ["case-folded state", withAttempt({ state: "SUBMITTED" })],
    ["padded state", withAttempt({ state: "submitted " })],
    ["numeric state", withAttempt({ state: 5 })],
    ["null state", withAttempt({ state: null })],
    ["array state", withAttempt({ state: ["submitted"] })],
    // J. the recipient
    ["no recipient", withAttempt({ recipient: undefined })],
    ["another recipient", withAttempt({ recipient: "0xdead000000000000000000000000000000000001" })],
    ["padded recipient", withAttempt({ recipient: "0x2222222222222222222222222222222222222222 " })],
    ["numeric recipient", withAttempt({ recipient: 5 })],
    ["null recipient", withAttempt({ recipient: null })],
    // K. the amount
    ["no amount", withAttempt({ amountBaseUnits: undefined })],
    ["another amount", withAttempt({ amountBaseUnits: "1000001" })],
    ["decimal amount", withAttempt({ amountBaseUnits: "1000000.0" })],
    ["padded amount", withAttempt({ amountBaseUnits: " 1000000" })],
    ["exponent amount", withAttempt({ amountBaseUnits: "1e6" })],
    ["numeric amount", withAttempt({ amountBaseUnits: 1_000_000 })],
    ["negative amount", withAttempt({ amountBaseUnits: "-1000000" })],
    ["empty amount", withAttempt({ amountBaseUnits: "" })],
    ["zero-padded amount", withAttempt({ amountBaseUnits: "01000000" })],
    ["null amount", withAttempt({ amountBaseUnits: null })],
    // L. transactionHash
    ["no transactionHash", withAttempt({ transactionHash: undefined })],
    ["numeric transactionHash", withAttempt({ transactionHash: 5 })],
    ["object transactionHash", withAttempt({ transactionHash: {} })],
    ["array transactionHash", withAttempt({ transactionHash: ["0xabc"] })],
    ["boolean transactionHash", withAttempt({ transactionHash: false })],
    // M. failureReason
    ["no failureReason", withAttempt({ failureReason: undefined })],
    ["numeric failureReason", withAttempt({ failureReason: 5 })],
    ["object failureReason", withAttempt({ failureReason: {} })],
    ["array failureReason", withAttempt({ failureReason: ["x"] })],
    ["boolean failureReason", withAttempt({ failureReason: false })],
    // N. prepared presence (the held attempt has prepared fields)
    ["prepared: null", withAttempt({ prepared: null })],
    ["no prepared", withAttempt({ prepared: undefined })],
    ["prepared: a string", withAttempt({ prepared: "0xprepared" })],
    ["prepared: an array", withAttempt({ prepared: [] })],
    ["prepared: a number", withAttempt({ prepared: 5 })],
    // P. the server clock
    ["no serverNowSeconds", withTop({ serverNowSeconds: undefined })],
    ["serverNowSeconds: null (what NaN or Infinity become in JSON text)", withTop({ serverNowSeconds: null })],
    ["serverNowSeconds: a numeric string", withTop({ serverNowSeconds: "1900000000" })],
    ["serverNowSeconds: true", withTop({ serverNowSeconds: true })],
    ["serverNowSeconds: an object", withTop({ serverNowSeconds: {} })],
    ["serverNowSeconds: NaN", () => raw(bodyOf("submitted", {}, { serverNowSeconds: Number.NaN }))],
    ["serverNowSeconds: Infinity", () => raw(bodyOf("submitted", {}, { serverNowSeconds: Number.POSITIVE_INFINITY }))],
    ["serverNowSeconds: -Infinity", () => raw(bodyOf("submitted", {}, { serverNowSeconds: Number.NEGATIVE_INFINITY }))],
  ];

  it("the case list covers every rejection class and has no duplicates", () => {
    expect(new Set(MALFORMED.map(([name]) => name)).size).toBe(MALFORMED.length);
    expect(MALFORMED.length).toBeGreaterThanOrEqual(60);
  });

  // ---- A-Q: a rejected answer leaves the payment exactly as it was --------------------------------------------

  describe("a malformed 200 from Check status: the existing fallback, and nothing else", () => {
    describe.each(HELD_KINDS)("from the %s screen", (kind) => {
      it.each(MALFORMED)("%s", async (_name, answer) => {
        const api = server({ status: () => answer() });
        const store = holding(kind);
        // An earlier 401 marker: an answered read — even an unusable one — proves the session works, so it is cleared.
        store.setState({ sessionRecovery: "signed_out", error: "You're signed out, so we can't confirm this payment yet. Sign in again to check its status." });
        const before = kept(store);

        await store.getState().checkStatus();
        await settle();

        expect(kept(store)).toEqual(before);
        expect(store.getState()).toMatchObject({ error: UNUSABLE, sessionRecovery: null, isStatusDeferred: true, statusRetryAfterSeconds: null, isManualCheckCoolingDown: true });
        expect(api.keys()).toEqual(["status"]); // no balance refresh, submit, cancel, prepare, latest or second read
        expect(api.calls[0]!.url).toBe(`/api/real/payments/${ATTEMPT_ID}/status`);
        expect(signPreparedPayment).not.toHaveBeenCalled();
        expect(JSON.stringify(visible(store))).not.toMatch(LEAK);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(api.keys()).toEqual(["status"]); // and nothing arms itself
      });
    });
  });

  it.each(HELD_KINDS)("from the %s screen: the 60 s deferral — Check status at 59 999 ms sends nothing, and one read goes at 60 000 ms", async (kind) => {
    const api = server({ status: (n) => (n === 1 ? J(null) : honest("submitted")) });
    const store = holding(kind);
    await store.getState().checkStatus();
    await settle();
    expect(api.count("status")).toBe(1);
    expect(store.getState()).toMatchObject({ isStatusDeferred: true, isManualCheckCoolingDown: true });

    await vi.advanceTimersByTimeAsync(STATUS_FALLBACK_DEADLINE_MS - 1);
    await store.getState().checkStatus();
    await settle();
    expect(api.count("status")).toBe(1);
    expect(store.getState().isManualCheckCoolingDown).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(store.getState()).toMatchObject({ isManualCheckCoolingDown: false, isStatusDeferred: false });
    await store.getState().checkStatus();
    await settle();
    expect(api.count("status")).toBe(2);
    expect(store.getState()).toMatchObject({ status: "submitted", error: null });
  });

  it("a rejected answer is not a local transition: a 'submitted' read already delivered still stands in for the post-submit check", async () => {
    const api = server({ status: (n) => (n === 1 ? honest("submitted") : J(null)) });
    const store = holding("submitted");
    await store.getState().checkStatus();
    await settle();
    expect(api.count("status")).toBe(1);

    await vi.advanceTimersByTimeAsync(MANUAL_CHECK_COOLDOWN_MS);
    await store.getState().checkStatus();
    await settle();
    expect(api.count("status")).toBe(2);
    expect(store.getState().error).toBe(UNUSABLE);

    await vi.advanceTimersByTimeAsync(STATUS_FALLBACK_DEADLINE_MS);
    await store.getState().checkSubmittedStatus();
    await settle();
    expect(api.count("status")).toBe(2);
  });

  it("a held SUBMITTED attempt with no prepared fields only accepts an answer with none; the amount check is a digit string", async () => {
    // A held attempt past `prepared` with no prepared fields (an older row): an honest answer carries none either. (Only a row held in
    // the `prepared` state may later honestly gain them — see the reserved-row tests below.)
    let api = server({ status: () => honest("submitted", { prepared: null }) });
    let store = holding("submitted", { prepared: null });
    await store.getState().checkStatus();
    await settle();
    expect(store.getState()).toMatchObject({ status: "submitted", error: null, isStatusDeferred: false });

    // ...and for a held attempt that is NOT in the `prepared` state, one that suddenly carries prepared fields is not the payment this page holds.
    api = server({ status: () => honest("submitted", { prepared: PREPARED_FIELDS }) });
    store = holding("submitted", { prepared: null });
    await store.getState().checkStatus();
    await settle();
    expect(store.getState()).toMatchObject({ error: UNUSABLE, isStatusDeferred: true });
    expect(store.getState().attempt?.prepared).toBeNull();
    expect(api.count("status")).toBe(1);

    // A held amount that is not a plain digit string is never matched, even by an identical answer.
    api = server({ status: () => honest("submitted", { amountBaseUnits: "12abc" }) });
    store = holding("submitted", { amountBaseUnits: "12abc" });
    await store.getState().checkStatus();
    await settle();
    expect(store.getState()).toMatchObject({ error: UNUSABLE, isStatusDeferred: true });
    expect(api.count("status")).toBe(1);
  });

  it.each([
    ["recipient", { recipient: 5 }],
    ["amountBaseUnits", { amountBaseUnits: 1_000_000 }],
    ["id", { id: 5 }],
  ] as const)("a held attempt whose %s is not a string is never matched, even by an identical answer", async (_field, over) => {
    // /latest only vouches for the id and state, so the held values themselves are not assumed to be strings.
    const api = server({ status: () => honest("submitted", over as Record<string, unknown>) });
    const store = holding("submitted", over as Record<string, unknown>);
    await store.getState().checkStatus();
    await settle();
    expect(store.getState()).toMatchObject({ error: UNUSABLE, isStatusDeferred: true, status: "submitted" });
    expect(api.count("status")).toBe(1);
  });

  // ---- a reserved row finishing its preparation: the honest null -> object transition ------------------------------

  describe("a row held in state 'prepared' with no prepared fields may honestly gain them (one-way, state-aware)", () => {
    const LATER = ["awaiting_authorization", "signed", "submitting", "submitted", "unknown", "confirmed", "failed", "cancelled"] as const;
    const SHOWN: Record<string, string> = { awaiting_authorization: "awaiting_authorization", signed: "stranded", submitting: "unknown", submitted: "submitted", unknown: "unknown", confirmed: "confirmed", failed: "failed", cancelled: "editing" };
    const reservedAttempt = (over: Record<string, unknown> = {}) => attemptOf("prepared", { prepared: null, ...over });
    const refusedCancel = () => jsonResponse(409, { error: "This payment can no longer be cancelled." });

    /**
     * The page holds a reserved row (state prepared, no prepared fields) — the stranded screen. The real GET /latest (`resolveLatestPayment`) returns
     * the signing context only for a bound `awaiting_authorization` row, so a reserved row has NO sub-organization, NO authorizing credential and no
     * approval; `adoptLatestAttempt` stores exactly those nulls.
     */
    function holdingReserved(over: Record<string, unknown> = {}): Store {
      const store = createRealPaymentStore();
      stores.push(store);
      store.setState({ attempt: reservedAttempt(over) as never, status: "stranded", subOrganizationId: null, authorizingCredentialId: null, clockOffsetSeconds: offsetFor(100_000), pendingSubmission: null });
      return store;
    }
    /** What the page holds for an attempt in `state` with no prepared fields. */
    function holdingNoFields(state: string): Store {
      const store = createRealPaymentStore();
      stores.push(store);
      store.setState({ attempt: attemptOf(state, { prepared: null }) as never, status: SHOWN[state] as never, subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", clockOffsetSeconds: offsetFor(100_000), pendingSubmission: null });
      return store;
    }
    const withPrepared = (state: string, prepared: unknown) => () => J(bodyOf(state, { prepared }));

    it("A-D: /latest hands out the reserved row, then an honest status answer with the fields is ADOPTED — same payment, nothing else sent", async () => {
      const api = server({
        latest: () => J({ attempt: reservedAttempt(), subOrganizationId: null, authorizingCredentialId: null, serverNowSeconds: serverNow() }),
        status: () => honest("awaiting_authorization"),
      });
      const store = createRealPaymentStore();
      stores.push(store);
      await store.getState().init();
      await settle();
      expect(store.getState().attempt).toMatchObject({ id: ATTEMPT_ID, state: "prepared", prepared: null });
      expect(store.getState().status).toBe("stranded");
      // N-2: the real /latest gives a reserved row no signing context, and none is invented.
      const NO_CONTEXT = { subOrganizationId: null, authorizingCredentialId: null, pendingSubmission: null, isAuthorizing: false };
      expect(store.getState()).toMatchObject(NO_CONTEXT);

      await store.getState().checkStatus();
      await settle();

      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", error: null, sessionRecovery: null, isStatusDeferred: false, statusRetryAfterSeconds: null, ...NO_CONTEXT });
      expect(store.getState().attempt).toEqual(bodyOf("awaiting_authorization").attempt);
      expect(store.getState().attempt).toMatchObject({ id: ATTEMPT_ID, recipient: baseAttempt().recipient, amountBaseUnits: "1000000" });
      expect(JSON.stringify(visible(store))).not.toMatch(LEAK);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(api.keys()).toEqual(["latest", "status"]); // no prepare, signing, submit, Cancel, balance or second read
      expect(signPreparedPayment).not.toHaveBeenCalled(); // no passkey prompt, no approval, no UserOperation
      expect(store.getState()).toMatchObject(NO_CONTEXT);
    });

    it("E: a refused Cancel (the preparation finished concurrently) reads status and adopts the completed prepared object", async () => {
      const api = server({ cancel: refusedCancel, status: () => honest("awaiting_authorization") });
      const store = holdingReserved();
      expect(store.getState()).toMatchObject({ subOrganizationId: null, authorizingCredentialId: null, pendingSubmission: null });
      await store.getState().cancel();
      await settle();
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", error: CANCEL_LOST_RACE, isStatusDeferred: false, subOrganizationId: null, authorizingCredentialId: null, pendingSubmission: null, isAuthorizing: false });
      expect(store.getState().attempt).toEqual(bodyOf("awaiting_authorization").attempt);
      expect(api.keys()).toEqual(["cancel", "status"]);
      expect(signPreparedPayment).not.toHaveBeenCalled(); // no signing context invented, no approval, no passkey prompt, no submit
    });

    it.each(LATER)("F: a later honest '%s' answer carrying the fields is adopted", async (state) => {
      const api = server({ status: () => honest(state, { failureReason: state === "failed" ? "No money moved." : null, transactionHash: state === "confirmed" ? "0xabc" : null }), balance: balanceReply });
      const store = holdingReserved();
      await store.getState().checkStatus();
      await settle();
      expect(store.getState()).toMatchObject({ status: SHOWN[state], error: null, isStatusDeferred: false });
      expect(store.getState().attempt?.prepared).toEqual(PREPARED_FIELDS);
      expect(store.getState().attempt?.state).toBe(state);
      expect(api.keys().filter((key) => key !== "status" && key !== "balance")).toEqual([]);
    });

    it.each([
      ["prepared", "prepared", "stranded"],
      ["failed", "failed", "failed"],
      ["cancelled", "cancelled", "editing"],
    ] as const)("G/H: prepared -> %s with prepared:null stays accepted", async (_name, state, shown) => {
      server({ status: () => honest(state, { prepared: null, failureReason: state === "failed" ? "Could not prepare." : null }) });
      const store = holdingReserved();
      await store.getState().checkStatus();
      await settle();
      expect(store.getState()).toMatchObject({ status: shown, error: null, isStatusDeferred: false });
      expect(store.getState().attempt?.prepared).toBeNull();
    });

    it.each([
      ["a string", "0xprepared"],
      ["a number", 5],
      ["true", true],
      ["an array", []],
      ["an array holding the fields", [PREPARED_FIELDS]],
      ["absent (the key is missing)", undefined],
    ] as const)("I: prepared as %s is rejected (fixed fallback, nothing adopted)", async (_name, value) => {
      const api = server({ status: withPrepared("awaiting_authorization", value) });
      const store = holdingReserved();
      const before = kept(store);
      await store.getState().checkStatus();
      await settle();
      expect(kept(store)).toEqual(before);
      expect(store.getState()).toMatchObject({ error: UNUSABLE, isStatusDeferred: true });
      expect(api.keys()).toEqual(["status"]);
    });

    it("J: a held attempt with no prepared fields (reserved or not) also rejects an answer with the key missing", async () => {
      for (const make of [() => holdingReserved(), () => holdingNoFields("submitted")]) {
        const api = server({ status: () => J(bodyOf("submitted", { prepared: undefined })) });
        const store = make();
        await store.getState().checkStatus();
        await settle();
        expect(store.getState()).toMatchObject({ error: UNUSABLE, isStatusDeferred: true });
        expect(api.count("status")).toBe(1);
      }
    });

    it.each(LATER)("J: a held '%s' attempt with no prepared fields rejects an answer that carries them", async (state) => {
      const api = server({ status: () => honest(state) });
      const store = holdingNoFields(state);
      const before = kept(store);
      await store.getState().checkStatus();
      await settle();
      expect(kept(store)).toEqual(before);
      expect(store.getState()).toMatchObject({ error: UNUSABLE, isStatusDeferred: true });
      expect(api.keys()).toEqual(["status"]);
    });

    it("K: a held object never becomes null — from an awaiting row and from a row held in 'prepared' with fields", async () => {
      for (const make of [() => holding("awaiting"), () => { const s = createRealPaymentStore(); stores.push(s); s.setState({ attempt: attemptOf("prepared") as never, status: "stranded", subOrganizationId: null, authorizingCredentialId: null }); return s; }]) {
        const api = server({ status: () => honest("prepared", { prepared: null }) });
        const store = make();
        const before = kept(store);
        await store.getState().checkStatus();
        await settle();
        expect(kept(store)).toEqual(before);
        expect(store.getState()).toMatchObject({ error: UNUSABLE, isStatusDeferred: true });
        expect(api.count("status")).toBe(1);
      }
    });

    it("L: an answer still in state 'prepared' never carries the fields", async () => {
      const api = server({ status: () => honest("prepared") });
      const store = holdingReserved();
      const before = kept(store);
      await store.getState().checkStatus();
      await settle();
      expect(kept(store)).toEqual(before);
      expect(store.getState()).toMatchObject({ error: UNUSABLE, isStatusDeferred: true });
      expect(api.keys()).toEqual(["status"]);
    });

    describe("N-1: an answer in state 'prepared' never carries the object, whatever the page held", () => {
      const heldObjectStore = (kind: HeldKind | "reserved-with-object"): Store => {
        if (kind !== "reserved-with-object") return holding(kind);
        const store = createRealPaymentStore();
        stores.push(store);
        store.setState({ attempt: attemptOf("prepared") as never, status: "stranded", subOrganizationId: null, authorizingCredentialId: null, clockOffsetSeconds: offsetFor(100_000), pendingSubmission: null });
        return store;
      };
      const HELD_OBJECT: Array<HeldKind | "reserved-with-object"> = [...HELD_KINDS, "reserved-with-object"];

      it.each(HELD_OBJECT)("A: ordinary status check from a held-object %s payment rejects prepared/object", async (kind) => {
        const api = server({ status: () => honest("prepared", { failureReason: null }) });
        const store = heldObjectStore(kind);
        store.setState({ sessionRecovery: "signed_out", error: "old" });
        const before = kept(store);

        await store.getState().checkStatus();
        await settle();

        expect(kept(store)).toEqual(before); // attempt, status, approval, credential, sub-organization, clock offset, identity — nothing adopted
        expect(store.getState()).toMatchObject({ error: UNUSABLE, sessionRecovery: null, isStatusDeferred: true, statusRetryAfterSeconds: null });
        expect(api.keys()).toEqual(["status"]); // no balance refresh, signing, submit, Cancel, prepare or second read
        expect(signPreparedPayment).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(STATUS_FALLBACK_DEADLINE_MS - 1);
        await store.getState().checkStatus();
        expect(api.keys()).toEqual(["status"]); // the existing 60 s deferral
        expect(JSON.stringify(visible(store))).not.toMatch(LEAK);
      });

      it.each(["awaiting", "stranded", "reserved-with-object"] as const)("B: the read after a refused Cancel from a held-object %s payment rejects prepared/object", async (kind) => {
        const api = server({ cancel: refusedCancel, status: () => honest("prepared") });
        const store = heldObjectStore(kind);
        store.setState({ sessionRecovery: "signed_out" });
        const before = kept(store);

        await store.getState().cancel();
        await settle();

        expect(kept(store)).toEqual(before);
        expect(store.getState()).toMatchObject({ error: CANCEL_UNCONFIRMED, sessionRecovery: "signed_out", isStatusDeferred: true, statusRetryAfterSeconds: null, isCancelling: false });
        expect(api.keys()).toEqual(["cancel", "status"]); // one Cancel POST, one read, nothing else
        expect(signPreparedPayment).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(STATUS_FALLBACK_DEADLINE_MS - 1);
        expect(api.keys()).toEqual(["cancel", "status"]);
      });
    });

    it.each([
      ["no prepared key", undefined, undefined],
      ["a string", "0xprepared", "0xprepared"],
      ["an array", [], []],
    ] as const)("D: a held attempt whose prepared is %s is never matched, even by an identical answer", async (_name, heldValue, replyValue) => {
      const api = server({ status: () => honest("prepared", { prepared: replyValue }) });
      const store = createRealPaymentStore();
      stores.push(store);
      store.setState({ attempt: attemptOf("prepared", { prepared: heldValue }) as never, status: "stranded", subOrganizationId: null, authorizingCredentialId: null });
      await store.getState().checkStatus();
      await settle();
      expect(store.getState()).toMatchObject({ error: UNUSABLE, isStatusDeferred: true });
      expect(api.count("status")).toBe(1);
    });

    it("M: a genuinely malformed answer for a reserved row still takes the fixed fallback and keeps everything", async () => {
      const api = server({ status: () => J(bodyOf("awaiting_authorization", { id: "attempt-FOREIGN" })) });
      const store = holdingReserved();
      const before = kept(store);
      await store.getState().checkStatus();
      await settle();
      expect(kept(store)).toEqual(before);
      expect(store.getState()).toMatchObject({ error: UNUSABLE, isStatusDeferred: true, sessionRecovery: null });
      expect(api.keys()).toEqual(["status"]);
      expect(JSON.stringify(visible(store))).not.toMatch(LEAK);
    });

    it("the refused-Cancel read applies the same rule: the fields are adopted, but a damaged prepared value is rejected", async () => {
      const api = server({ cancel: refusedCancel, status: () => J(bodyOf("awaiting_authorization", { prepared: 5 })) });
      const store = holdingReserved();
      const before = kept(store);
      await store.getState().cancel();
      await settle();
      expect(kept(store)).toEqual(before);
      expect(store.getState()).toMatchObject({ error: CANCEL_UNCONFIRMED, isStatusDeferred: true });
      expect(api.keys()).toEqual(["cancel", "status"]);
    });

    it("O: a late honest answer carrying the fields is dropped when the account or the attempt changed meanwhile", async () => {
      for (const change of [() => useRealAccountStore.setState({ account: ACCOUNT_B }), null]) {
        const gate = held();
        const api = server({ status: () => gate.promise });
        const store = holdingReserved();
        const before = kept(store);
        const check = store.getState().checkStatus();
        await settle();
        if (change) change();
        else store.setState({ attempt: attemptOf("prepared", { id: ATTEMPT_ID_2, prepared: null }) as never });
        gate.resolve(honest("awaiting_authorization"));
        await check;
        await settle();
        if (change) expect(kept(store)).toEqual(before);
        expect(store.getState().attempt?.prepared).toBeNull();
        expect(store.getState()).toMatchObject({ status: "stranded", error: null, isStatusDeferred: false });
        expect(api.count("status")).toBe(1);
        useRealAccountStore.setState({ account: ACCOUNT_A });
      }
    });

    it("O: the same for the refused-Cancel read after an account switch", async () => {
      const gate = held();
      const api = server({ cancel: refusedCancel, status: () => gate.promise });
      const store = holdingReserved();
      const cancelling = store.getState().cancel();
      await settle();
      useRealAccountStore.setState({ account: ACCOUNT_B });
      gate.resolve(honest("awaiting_authorization"));
      await cancelling;
      await settle();
      expect(store.getState().attempt?.prepared).toBeNull();
      expect(store.getState()).toMatchObject({ status: "stranded", error: null, isStatusDeferred: false });
      expect(api.keys()).toEqual(["cancel", "status"]);
    });
  });

  // ---- honest answers are unchanged ---------------------------------------------------------------------------

  describe("honest answers: all nine states are accepted exactly as before", () => {
    const NINE: Array<[string, string]> = [
      ["prepared", "stranded"],
      ["awaiting_authorization", "awaiting_authorization"],
      ["signed", "stranded"],
      ["submitting", "unknown"],
      ["submitted", "submitted"],
      ["unknown", "unknown"],
      ["confirmed", "confirmed"],
      ["failed", "failed"],
      ["cancelled", "editing"],
    ];

    describe.each(["awaiting", "unknown", "submitted"] as const)("from the %s screen", (kind) => {
      it.each(NINE)("a well-formed '%s' answer is adopted and shown as '%s'", async (state, shown) => {
        // N-1: 'prepared' is a valid state STRING, but no transition targets it, so 'prepared' carrying the prepared object is not a valid
        // state/field combination for a page that holds the object — rejected like any malformed answer (the honest 'prepared' answer is
        // prepared:null for a held RESERVED row, covered in the reserved-row tests below).
        if (state === "prepared") {
          const api = server({ status: () => honest(state) });
          const store = holding(kind);
          store.setState({ sessionRecovery: "not_accessible", error: "old" });
          const before = kept(store);
          await store.getState().checkStatus();
          await settle();
          expect(kept(store)).toEqual(before);
          expect(store.getState()).toMatchObject({ error: UNUSABLE, sessionRecovery: null, isStatusDeferred: true, statusRetryAfterSeconds: null, isManualCheckCoolingDown: true });
          expect(api.keys()).toEqual(["status"]);
          expect(signPreparedPayment).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(STATUS_FALLBACK_DEADLINE_MS - 1);
          await store.getState().checkStatus();
          expect(api.keys()).toEqual(["status"]); // the existing 60 s deferral
          return;
        }
        // A status answer may differ from the previous local state without being malformed (the server may have moved it).
        if (kind === "submitted" && (state === "awaiting_authorization" || state === "prepared" || state === "signed")) return;
        const api = server({ status: () => honest(state, { failureReason: state === "failed" ? "No money moved." : null, transactionHash: state === "confirmed" ? "0xabc" : null, recipientIdentity: { handle: "smit", displayName: "Smit" }, extra: { nested: 1 } }, { extraTop: true }), balance: balanceReply });
        const store = holding(kind);
        store.setState({ sessionRecovery: "not_accessible", error: "old" });

        await store.getState().checkStatus();
        await settle();

        const expected = bodyOf(state, { failureReason: state === "failed" ? "No money moved." : null, transactionHash: state === "confirmed" ? "0xabc" : null, recipientIdentity: { handle: "smit", displayName: "Smit" }, extra: { nested: 1 } }).attempt;
        expect(store.getState()).toMatchObject({ status: shown, error: null, sessionRecovery: null, isStatusDeferred: false, statusRetryAfterSeconds: null, clockOffsetSeconds: serverNow() - Math.floor(Date.now() / 1000) });
        expect(store.getState().attempt).toEqual(expected);
        expect(api.count("status")).toBe(1);
        expect(api.count("balance")).toBe(state === "confirmed" ? 1 : 0);
        expect(api.keys().filter((key) => key !== "status" && key !== "balance")).toEqual([]);
      });
    });

    it("a server-deferred honest answer keeps its own delay: the stored attempt is shown and the delay is recorded", async () => {
      server({ status: () => honest("submitted", {}, { reconciliationDeferred: true, retryAfterSeconds: 600 }) });
      const store = holding("submitted");
      await store.getState().checkStatus();
      await settle();
      expect(store.getState()).toMatchObject({ status: "submitted", error: null, isStatusDeferred: true, statusRetryAfterSeconds: 600 });
    });

    it("a malformed deferral on an otherwise honest answer still takes the fixed fallback (its own validation is unchanged)", async () => {
      const api = server({ status: () => honest("submitted", {}, { reconciliationDeferred: true, retryAfterSeconds: 0 }) });
      const store = holding("submitted");
      await store.getState().checkStatus();
      await settle();
      expect(store.getState()).toMatchObject({ error: UNUSABLE, isStatusDeferred: true, statusRetryAfterSeconds: null });
      expect(api.count("status")).toBe(1);
    });

    it("terminal is still final: an honest 'awaiting_authorization' answer never moves a confirmed payment", async () => {
      server({ status: () => honest("awaiting_authorization") });
      const store = holding("submitted", { state: "confirmed" });
      store.setState({ status: "confirmed" });
      await store.getState().checkStatus();
      await settle();
      expect(store.getState()).toMatchObject({ status: "confirmed" });
    });
  });

  // ---- P-1: the status read that follows a refused Cancel -----------------------------------------------------

  describe("the status read after a refused Cancel uses the same check", () => {
    const refusedCancel = () => jsonResponse(409, { error: "This payment can no longer be cancelled." });

    describe.each(["awaiting", "stranded"] as const)("from the %s screen", (kind) => {
      it.each(MALFORMED)("%s", async (_name, answer) => {
        const api = server({ cancel: refusedCancel, status: () => answer() });
        const store = holding(kind);
        // Cancel's own path leaves the session marker as it found it.
        store.setState({ sessionRecovery: "signed_out" });
        const before = kept(store);

        await store.getState().cancel();
        await settle();

        expect(kept(store)).toEqual(before);
        expect(store.getState()).toMatchObject({ error: CANCEL_UNCONFIRMED, sessionRecovery: "signed_out", isStatusDeferred: true, statusRetryAfterSeconds: null, isCancelling: false });
        expect(api.keys()).toEqual(["cancel", "status"]); // one Cancel POST, one read, nothing else
        expect(signPreparedPayment).not.toHaveBeenCalled();
        expect(JSON.stringify(visible(store))).not.toMatch(LEAK);
        // The deferral stands: another refused Cancel inside it sends no new read, and no automatic Cancel ever follows.
        await vi.advanceTimersByTimeAsync(STATUS_FALLBACK_DEADLINE_MS - 1);
        expect(api.keys()).toEqual(["cancel", "status"]);
      });
    });

    it("an honest answer is applied as before: the real state is shown beside the refusal", async () => {
      const api = server({ cancel: refusedCancel, status: () => honest("submitted") });
      const store = holding("awaiting");
      await store.getState().cancel();
      await settle();
      expect(store.getState()).toMatchObject({ status: "submitted", error: CANCEL_LOST_RACE, isStatusDeferred: false });
      expect(store.getState().attempt).toEqual(bodyOf("submitted").attempt);
      expect(api.keys()).toEqual(["cancel", "status"]);
    });

    // reset() and detach() abort the in-flight read itself, so the late answer never arrives; a switch of account or of attempt does not.
    it("the account switches while the cancel's read is in flight: the late malformed answer writes nothing", async () => {
      const gate = held();
      const api = server({ cancel: refusedCancel, status: () => gate.promise });
      const store = holding("awaiting");
      const before = kept(store);
      const cancelling = store.getState().cancel();
      await settle();
      expect(api.count("status")).toBe(1);

      useRealAccountStore.setState({ account: ACCOUNT_B });
      gate.resolve(J(null));
      await cancelling;
      await settle();

      expect(kept(store)).toEqual(before);
      expect(store.getState()).toMatchObject({ error: null, isStatusDeferred: false });
      expect(api.keys()).toEqual(["cancel", "status"]);
    });

    it("the attempt is replaced while the cancel's read is in flight: the late malformed answer writes nothing", async () => {
      const gate = held();
      const api = server({ cancel: refusedCancel, status: () => gate.promise });
      const store = holding("awaiting");
      const cancelling = store.getState().cancel();
      await settle();
      store.setState({ attempt: attemptOf("awaiting_authorization", { id: ATTEMPT_ID_2 }) as never });

      gate.resolve(J(null));
      await cancelling;
      await settle();

      expect(store.getState().attempt?.id).toBe(ATTEMPT_ID_2);
      expect(store.getState()).toMatchObject({ error: null, isStatusDeferred: false });
      expect(api.keys()).toEqual(["cancel", "status"]);
    });

    it("a stale malformed answer for the cancel's read is dropped: nothing is written", async () => {
      const gate = held();
      const api = server({ cancel: refusedCancel, status: () => gate.promise });
      const store = holding("awaiting");
      const cancelling = store.getState().cancel();
      await settle();
      expect(api.count("status")).toBe(1);

      store.getState().reset();
      gate.resolve(J(null));
      await cancelling;
      await settle();

      expect(store.getState()).toMatchObject({ attempt: null, error: null, isStatusDeferred: false });
      expect(api.keys()).toEqual(["cancel", "status"]);
    });
  });

  // ---- lifecycle and interleavings ----------------------------------------------------------------------------

  describe("a late malformed answer never writes into a newer lifecycle", () => {
    it("reset while the read is in flight", async () => {
      const gate = held();
      const api = server({ status: () => gate.promise });
      const store = holding("submitted");
      const check = store.getState().checkStatus();
      await settle();
      store.getState().reset();
      gate.resolve(J(null));
      await check;
      await settle();
      expect(store.getState()).toMatchObject({ attempt: null, error: null, isStatusDeferred: false });
      expect(api.keys()).toEqual(["status"]);
    });

    it("detach while the read is in flight", async () => {
      const gate = held();
      const api = server({ status: () => gate.promise });
      const store = holding("submitted");
      const check = store.getState().checkStatus();
      await settle();
      store.getState().detach();
      gate.resolve(J(null));
      await check;
      await settle();
      expect(store.getState()).toMatchObject({ error: null, isStatusDeferred: false, status: "submitted" });
      expect(api.keys()).toEqual(["status"]);
    });

    it("the account switches while the read is in flight (A to B)", async () => {
      const gate = held();
      const api = server({ status: () => gate.promise });
      const store = holding("submitted");
      const before = kept(store);
      const check = store.getState().checkStatus();
      await settle();
      useRealAccountStore.setState({ account: ACCOUNT_B });
      gate.resolve(J(null));
      await check;
      await settle();
      expect(kept(store)).toEqual(before);
      expect(store.getState()).toMatchObject({ error: null, isStatusDeferred: false });
      expect(api.keys()).toEqual(["status"]);
    });

    it("the attempt is replaced while the read is in flight", async () => {
      const gate = held();
      const api = server({ status: () => gate.promise });
      const store = holding("submitted");
      const check = store.getState().checkStatus();
      await settle();
      store.setState({ attempt: attemptOf("awaiting_authorization", { id: ATTEMPT_ID_2 }) as never, status: "awaiting_authorization" });
      gate.resolve(J(null));
      await check;
      await settle();
      expect(store.getState()).toMatchObject({ error: null, isStatusDeferred: false, status: "awaiting_authorization" });
      expect(store.getState().attempt?.id).toBe(ATTEMPT_ID_2);
      expect(api.keys()).toEqual(["status"]);
    });

    it("an older status epoch: a local transition (the submit) happened while the read was in flight", async () => {
      const gate = held();
      const api = server({ status: () => gate.promise, submit: () => honest("submitted") });
      const store = holding("awaiting");
      const check = store.getState().checkStatus();
      await settle();
      await store.getState().resumeAuthorization();
      await settle();
      expect(store.getState().status).toBe("submitted");
      const afterSubmit = kept(store);

      gate.resolve(J(null)); // the read began before the submit: it describes the payment as it WAS, malformed or not
      await check;
      await settle();

      expect(kept(store)).toEqual(afterSubmit);
      expect(store.getState()).toMatchObject({ error: null, isStatusDeferred: false });
      expect(api.count("submit")).toBe(1);
      expect(api.count("status")).toBe(1);
    });

    it("an older status epoch: a refused Cancel happened while the read was in flight", async () => {
      const gate = held();
      const api = server({ status: (n) => (n === 1 ? gate.promise : J(null)), cancel: () => jsonResponse(409, { error: "x" }) });
      const store = holding("awaiting");
      const before = kept(store);
      const check = store.getState().checkStatus();
      await settle();
      const cancelling = store.getState().cancel();
      await settle();
      expect(api.count("cancel")).toBe(1);
      expect(api.count("status")).toBe(1); // the cancel's read waits behind the older one — never two at once

      gate.resolve(J(null));
      await check;
      await settle();
      // the older read's answer is dropped without a write; the cancel's own (fresh) read then decides — and it is malformed too
      expect(api.count("status")).toBe(2);
      await cancelling;
      await settle();
      expect(kept(store)).toEqual(before);
      expect(store.getState()).toMatchObject({ error: CANCEL_UNCONFIRMED, isStatusDeferred: true });
      expect(api.count("cancel")).toBe(1);
    });
  });

  it("two callers sharing one read both reject its malformed answer: one request, one fixed message", async () => {
    const gate = held();
    const api = server({ status: () => gate.promise });
    const store = holding("submitted");
    const manual = store.getState().checkStatus();
    const postSubmit = store.getState().checkSubmittedStatus();
    await settle();
    expect(api.count("status")).toBe(1);

    gate.resolve(J({ attempt: attemptOf("submitted", { id: "attempt-FOREIGN" }), serverNowSeconds: serverNow() }));
    await Promise.all([manual, postSubmit]);
    await settle();

    expect(store.getState()).toMatchObject({ error: UNUSABLE, status: "submitted", isStatusDeferred: true });
    expect(store.getState().attempt?.id).toBe(ATTEMPT_ID);
    expect(api.keys()).toEqual(["status"]);
  });

  // ---- automatic follow-ups stay bounded ----------------------------------------------------------------------

  describe("the expiry follow-up schedule is unchanged and bounded", () => {
    const expiredLatest = () => J({ attempt: attemptOf("awaiting_authorization"), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: serverNow(-100) });

    it("a malformed automatic check keeps the payment and arms the one slow follow-up — no immediate re-read", async () => {
      const api = server({ latest: expiredLatest, status: () => J(null) });
      const store = createRealPaymentStore();
      stores.push(store);
      await store.getState().init();
      await settle();
      expect(api.count("status")).toBe(1);
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", error: UNUSABLE, isStatusDeferred: true });
      expect(store.getState().attempt?.state).toBe("awaiting_authorization");

      await vi.advanceTimersByTimeAsync(EXPIRY_FOLLOW_UP_MS - 1);
      expect(api.count("status")).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(api.count("status")).toBe(2);
      expect(api.keys().filter((key) => key !== "status" && key !== "latest")).toEqual([]);
    });

    it("an always-malformed server cannot cause a request storm: at most the initial check plus the bounded follow-ups, in a day", async () => {
      const api = server({ latest: expiredLatest, status: () => J(null) });
      const store = createRealPaymentStore();
      stores.push(store);
      await store.getState().init();
      for (let hour = 0; hour < 24; hour++) await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(api.count("status")).toBe(1 + MAX_AUTOMATIC_FOLLOW_UPS);
      expect(api.keys().filter((key) => key !== "status" && key !== "latest")).toEqual([]);
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });

    it("an honest automatic answer still schedules the follow-up and still ends it when terminal", async () => {
      const api = server({ latest: expiredLatest, status: (n) => (n === 1 ? honest("awaiting_authorization") : honest("failed", { failureReason: "No money moved." })) });
      const store = createRealPaymentStore();
      stores.push(store);
      await store.getState().init();
      expect(api.count("status")).toBe(1);
      await vi.advanceTimersByTimeAsync(EXPIRY_FOLLOW_UP_MS);
      expect(api.count("status")).toBe(2);
      expect(store.getState().status).toBe("failed");
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(api.count("status")).toBe(2);
    });
  });

  // ---- D-6, D-7 and D-8 stay as they were ---------------------------------------------------------------------

  describe("D-6 through D-9 are unchanged and compose with a malformed status answer", () => {
    it("D-6: a submit that outlived its deadline (unknown, not aborted) then a malformed Check status — still unknown, nothing is retried", async () => {
      const gate = held();
      const api = server({ submit: () => gate.promise, status: () => J({ attempt: attemptOf("confirmed"), serverNowSeconds: "later" }) });
      const store = holding("awaiting");
      const done = store.getState().resumeAuthorization();
      await settle();
      await vi.advanceTimersByTimeAsync(SUBMIT_REQUEST_DEADLINE_MS);
      expect(store.getState()).toMatchObject({ status: "unknown", error: NEUTRAL, pendingSubmission: APPROVAL });

      await store.getState().checkStatus();
      await settle();

      expect(store.getState()).toMatchObject({ status: "unknown", error: UNUSABLE, pendingSubmission: APPROVAL, authorizingCredentialId: "credential-1", subOrganizationId: "sub-org-1" });
      expect(store.getState().attempt?.state).toBe("awaiting_authorization");
      expect(api.keys()).toEqual(["submit", "status"]);
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
      gate.resolve(honest("submitted"));
      await done;
    });

    it("D-7: a malformed submit answer, then a malformed Check status — still the original payment, in the unknown state", async () => {
      const api = server({ submit: () => J({ attempt: attemptOf("submitted", { id: "attempt-FOREIGN" }) }), status: () => J({ attempt: null, serverNowSeconds: serverNow() }) });
      const store = holding("awaiting");
      await store.getState().resumeAuthorization();
      await settle();
      expect(store.getState()).toMatchObject({ status: "unknown", error: NEUTRAL, pendingSubmission: APPROVAL });

      await store.getState().checkStatus();
      await settle();

      expect(store.getState()).toMatchObject({ status: "unknown", error: UNUSABLE, pendingSubmission: APPROVAL });
      expect(store.getState().attempt?.id).toBe(ATTEMPT_ID);
      expect(api.keys()).toEqual(["submit", "status"]);
      expect(JSON.stringify(visible(store))).not.toMatch(LEAK);
    });

    it.each([
      [401, "signed_out", SIGNED_OUT_PAYMENT_MESSAGE],
      [404, "not_accessible", PAYMENT_NOT_ACCESSIBLE_MESSAGE],
    ] as const)("D-8/D-9: HTTP %i marks the session, a malformed 200 then clears the marker with the ordinary fixed copy, and a later %i is classified again", async (code, marker, message) => {
      const api = server({
        submit: () => jsonResponse(code, { error: "gone" }),
        status: (n) => (n === 1 ? J(null) : jsonResponse(code, { error: "gone" })),
      });
      const store = holding("awaiting");
      await store.getState().resumeAuthorization();
      await settle();
      expect(store.getState()).toMatchObject({ status: "unknown", error: message, sessionRecovery: marker });

      await store.getState().checkStatus();
      await settle();
      expect(store.getState()).toMatchObject({ status: "unknown", error: UNUSABLE, sessionRecovery: null, pendingSubmission: APPROVAL });

      await vi.advanceTimersByTimeAsync(STATUS_FALLBACK_DEADLINE_MS);
      await store.getState().checkStatus();
      await settle();
      expect(store.getState()).toMatchObject({ status: "unknown", error: message, sessionRecovery: marker, pendingSubmission: APPROVAL });
      expect(api.keys()).toEqual(["submit", "status", "status"]);
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
    });

    it("a post-submit read (checkSubmittedStatus) that answers malformed leaves 'submitted' and the one deferral", async () => {
      const api = server({ submit: () => honest("submitted"), status: () => J({ serverNowSeconds: serverNow() }) });
      const store = holding("awaiting");
      await store.getState().resumeAuthorization();
      await settle();
      expect(store.getState().status).toBe("submitted");

      await store.getState().checkSubmittedStatus();
      await settle();

      expect(store.getState()).toMatchObject({ status: "submitted", error: UNUSABLE, isStatusDeferred: true });
      expect(store.getState().attempt?.id).toBe(ATTEMPT_ID);
      expect(api.keys()).toEqual(["submit", "status"]);
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * L-2 D-11: malformed Cancel response recovery. POST /cancel HTTP 200 used to be
 * believed on `response.ok` alone: the page dropped the payment and returned to
 * the form without reading the body. Now the body is read while the Cancel
 * request still owns its slot, and — after the lifecycle / account / attempt
 * guard — the answer must be an honest "this payment was cancelled":
 * `{ attempt }` with the exact held id, state exactly `cancelled`, the exact held
 * recipient and digit-string amount, and `transactionHash` exactly null.
 * `prepared`, `failureReason`, `recipientIdentity`, the timestamps, any other key
 * and `serverNowSeconds` are deliberately ignored (a successful Cancel never
 * adopts the answer's attempt). Anything else leaves the payment exactly as it
 * was with the existing fixed "Could not confirm whether this payment was
 * cancelled…" copy — the same as a network failure; nothing is retried, read,
 * signed, submitted, prepared or released to the form. A rejection says nothing
 * about whether the payment was cancelled. No D-11 test touches a real network,
 * database, provider or passkey.
 */
describe("real-payment-store — L-2 D-11: malformed Cancel response recovery", () => {
  const ACCOUNT_A = { appUserId: "app-user-1", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222" };
  const ACCOUNT_B = { appUserId: "app-user-2", ownerAddress: "0x4444444444444444444444444444444444444444", safeAddress: "0x5555555555555555555555555555555555555555" };
  const T0_MS = 1_800_000_000_000;
  const ADDRESS = "0x3333333333333333333333333333333333333333";
  const CANCEL_UNCONFIRMED = "Could not confirm whether this payment was cancelled. Check its status before trying again.";
  const CANCEL_LOST_RACE = "This payment could not be cancelled — it may already be on its way.";
  const UNUSABLE = "We couldn’t check on this payment just now. Try again in a little while.";
  const APPROVAL = { attemptId: ATTEMPT_ID, signature: "0xsig-d11", activityId: "activity-d11" };
  const SNAPSHOT = { handle: "smit", displayName: "Smit" };
  /** Distinctive malformed values: none of them may ever appear anywhere in the store. */
  const LEAK = /FOREIGN|refunded-by-bank|0xdead|Cannot read|TypeError|SyntaxError|Unexpected|not valid JSON|Failed to fetch|unexpected fetch|<html>/;

  type Key = "prepare" | "latest" | "cancel" | "status" | "submit" | "balance";
  type Handler = (n: number) => Response | Promise<Response>;
  type Store = ReturnType<typeof createRealPaymentStore>;
  const stores: Store[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0_MS);
    vi.mocked(signPreparedPayment).mockReset();
    vi.mocked(signPreparedPayment).mockResolvedValue({ signature: APPROVAL.signature, activityId: APPROVAL.activityId } as never);
    useRealAccountStore.setState({ account: ACCOUNT_A });
  });

  afterEach(async () => {
    for (const store of stores.splice(0)) store.getState().reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.mocked(signPreparedPayment).mockReset();
    useRealAccountStore.setState({ account: null });
    (await import("@/lib/stores/real-balance-store")).useRealBalanceStore.getState().reset();
  });

  /** Every request is recorded — including one no handler expects, which also fails the request. */
  function server(handlers: Partial<Record<Key, Handler>>) {
    const calls: Array<{ key: Key | "other"; url: string; method: string }> = [];
    const counts: Record<Key, number> = { prepare: 0, latest: 0, cancel: 0, status: 0, submit: 0, balance: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        const key: Key | null = url.endsWith("/api/real/payments/prepare")
          ? "prepare"
          : url.endsWith("/api/real/payments/latest")
            ? "latest"
            : url.endsWith("/cancel")
              ? "cancel"
              : url.endsWith("/status")
                ? "status"
                : url.endsWith("/api/real/payments/submit")
                  ? "submit"
                  : url.endsWith("/api/real/account/balance")
                    ? "balance"
                    : null;
        calls.push({ key: key ?? "other", url, method });
        const handler = key ? handlers[key] : undefined;
        if (!key || !handler) throw new Error(`unexpected fetch: ${method} ${url}`);
        counts[key] += 1;
        return handler(counts[key]);
      }),
    );
    return { calls, keys: () => calls.map((call) => call.key), count: (key: Key) => calls.filter((call) => call.key === key).length };
  }

  function held<T = Response>() {
    let resolve: (value: T) => void = () => {};
    let reject: (reason: unknown) => void = () => {};
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const settle = () => vi.advanceTimersByTimeAsync(0);
  const offsetFor = (secondsBeforeExpiry: number) => VALID_UNTIL - secondsBeforeExpiry - T0_MS / 1000;
  const serverNow = (secondsBeforeExpiry = 100_000) => Math.floor(Date.now() / 1000) + offsetFor(secondsBeforeExpiry);
  const visible = (store: Store) => JSON.parse(JSON.stringify(store.getState())) as Record<string, unknown>;
  const J = (body: unknown) => jsonResponse(200, body);
  /** A 200-shaped reply whose body read the test controls (a body that rejects, hangs, or holds values JSON text cannot). */
  const rawReply = (json: () => Promise<unknown>, over: Record<string, unknown> = {}) => ({ ok: true, status: 200, headers: new Headers(), json, ...over }) as unknown as Response;

  /** The held payment, in the server's own shape (a stored row keeps its prepared fields after a transition). */
  const attemptOf = (state: string, over: Record<string, unknown> = {}) => ({ ...baseAttempt(), state, prepared: PREPARED_FIELDS, ...over });
  /** What POST /cancel honestly answers: the cancelled row (toPublicAttempt) — no serverNowSeconds, no reconciliation metadata. */
  const cancelledOf = (over: Record<string, unknown> = {}) => attemptOf("cancelled", over);
  const bodyOf = (over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({ attempt: cancelledOf(over), ...top });
  const honest = (over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => J(bodyOf(over, top));
  const withAttempt = (over: Record<string, unknown>) => () => J(bodyOf(over));
  const withTop = (top: Record<string, unknown>) => () => J(bodyOf({}, top));

  type HeldKind = "awaiting" | "stranded" | "reserved";
  const SHAPES: Record<HeldKind, { state: string; status: string; context: boolean }> = {
    awaiting: { state: "awaiting_authorization", status: "awaiting_authorization", context: true },
    stranded: { state: "signed", status: "stranded", context: true },
    // The real GET /latest returns the signing context only for a bound awaiting row: a reserved row (state prepared, no fields) has none.
    reserved: { state: "prepared", status: "stranded", context: false },
  };

  /** A store holding the payment the way each screen does. The stranded (signed) screen also holds the saved approval. */
  function holding(kind: HeldKind, over: Record<string, unknown> = {}): Store {
    const store = createRealPaymentStore();
    stores.push(store);
    const { state, status, context } = SHAPES[kind];
    store.setState({
      attempt: attemptOf(state, kind === "reserved" ? { prepared: null, ...over } : over) as never,
      status: status as never,
      subOrganizationId: context ? "sub-org-1" : null,
      authorizingCredentialId: context ? "credential-1" : null,
      clockOffsetSeconds: offsetFor(100_000),
      pendingSubmission: kind === "stranded" ? APPROVAL : null,
    });
    return store;
  }

  /** What an honest Cancel success leaves: exactly the pre-D-11 cleanup. */
  const CLEARED = {
    status: "editing",
    attempt: null,
    recipientLookup: { status: "idle" },
    subOrganizationId: null,
    authorizingCredentialId: null,
    pendingSubmission: null,
    isAuthorizing: false,
    recipientInput: "",
    amountInput: "",
    isAttemptPastValidity: false,
    isFollowUpExhausted: false,
    isStatusDeferred: false,
    statusRetryAfterSeconds: null,
    isSubmitCoolingDown: false,
    submitCooldownSeconds: null,
    isSubmitRetryBeyondApproval: false,
    sessionRecovery: null,
    error: null,
    isCancelling: false,
  };
  /** Pre-existing screen state an honest Cancel must clear. */
  const DIRTY = { recipientInput: ADDRESS, amountInput: "1", sessionRecovery: "signed_out" as const, isAttemptPastValidity: true, isStatusDeferred: true, statusRetryAfterSeconds: 7, error: "an older message" };

  /** Everything a rejected answer must leave exactly as it was: the whole visible store, except the one message. */
  const unchangedExceptError = (store: Store, before: Record<string, unknown>) => expect({ ...visible(store), error: before.error }).toEqual(before);

  // ---- honest success: exactly the pre-D-11 behavior ----------------------------------------------------------

  describe("an honest cancelled answer is accepted and behaves exactly as before D-11", () => {
    type Honest = [string, HeldKind, Record<string, unknown>, () => Response];
    const HONEST: Honest[] = [
      ["held awaiting (object) → cancelled (object)", "awaiting", {}, () => honest()],
      ["held reserved prepared/null → cancelled (null)", "reserved", {}, () => honest({ prepared: null })],
      ["held reserved prepared/null → cancelled (object) — preparation completed before Cancel", "reserved", {}, () => honest({ prepared: PREPARED_FIELDS })],
      ["held signed / stranded → cancelled", "stranded", {}, () => honest()],
      ["legacy awaiting row with no prepared fields (null validUntil)", "awaiting", { prepared: null }, () => honest({ prepared: null })],
      ["legacy signed row with no prepared fields", "stranded", { prepared: null }, () => honest({ prepared: null })],
      ["a handle payment (identity held and echoed)", "awaiting", { recipientIdentity: SNAPSHOT }, () => honest({ recipientIdentity: SNAPSHOT })],
      ["a handle payment, the answer omits the identity", "awaiting", { recipientIdentity: SNAPSHOT }, () => honest({ recipientIdentity: undefined })],
      ["extra unrelated fields (attempt and top level)", "awaiting", {}, () => honest({ extraThing: 1, nested: { a: [1] } }, { extraTop: "x", reconciliationDeferred: false, retryAfterSeconds: 5 })],
      // The approved ignored-field policy: this check is not a schema check.
      ["ignored: no prepared key", "awaiting", {}, () => honest({ prepared: undefined })],
      ["ignored: prepared is a string", "awaiting", {}, () => honest({ prepared: "garbage" })],
      ["ignored: prepared is an array", "awaiting", {}, () => honest({ prepared: [] })],
      ["ignored: prepared is a number", "awaiting", {}, () => honest({ prepared: 5 })],
      ["ignored: an irrelevant failureReason string", "awaiting", {}, () => honest({ failureReason: "No money moved." })],
      ["ignored: a numeric failureReason", "awaiting", {}, () => honest({ failureReason: 5 })],
      ["ignored: no failureReason key", "awaiting", {}, () => honest({ failureReason: undefined })],
      ["ignored: no serverNowSeconds (the Cancel answer carries none)", "awaiting", {}, () => J({ attempt: cancelledOf() })],
      ["ignored: a malformed serverNowSeconds", "awaiting", {}, withTop({ serverNowSeconds: "later" })],
      ["ignored: no timestamps, a malformed recipientIdentity", "awaiting", {}, () => honest({ createdAt: undefined, updatedAt: undefined, recipientIdentity: "garbage" })],
    ];

    it.each(HONEST)("%s", async (_name, kind, over, answer) => {
      const api = server({ cancel: () => answer() });
      const store = holding(kind, over);
      store.setState(DIRTY);
      if (kind === "stranded") store.setState({ pendingSubmission: APPROVAL });

      await store.getState().cancel();
      await settle();

      expect(store.getState()).toMatchObject(CLEARED);
      expect(api.calls).toEqual([{ key: "cancel", url: `/api/real/payments/${ATTEMPT_ID}/cancel`, method: "POST" }]);
      expect(signPreparedPayment).not.toHaveBeenCalled();
      // Nothing is armed behind the cleanup.
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(api.keys()).toEqual(["cancel"]);
    });

    it("a reserved row adopted through /latest (real null signing context), then an honest cancelled/null answer", async () => {
      const api = server({
        latest: () => J({ attempt: attemptOf("prepared", { prepared: null }), subOrganizationId: null, authorizingCredentialId: null, serverNowSeconds: serverNow() }),
        cancel: () => honest({ prepared: null }),
      });
      const store = createRealPaymentStore();
      stores.push(store);
      await store.getState().init();
      await settle();
      expect(store.getState()).toMatchObject({ status: "stranded", attempt: { state: "prepared", prepared: null }, subOrganizationId: null, authorizingCredentialId: null, pendingSubmission: null });

      await store.getState().cancel();
      await settle();

      expect(store.getState()).toMatchObject(CLEARED);
      expect(api.keys()).toEqual(["latest", "cancel"]);
    });

    it("a reserved row adopted through /latest whose preparation finished before Cancel: cancelled/object is honest and accepted", async () => {
      const api = server({
        latest: () => J({ attempt: attemptOf("prepared", { prepared: null }), subOrganizationId: null, authorizingCredentialId: null, serverNowSeconds: serverNow() }),
        cancel: () => honest({ prepared: PREPARED_FIELDS }),
      });
      const store = createRealPaymentStore();
      stores.push(store);
      await store.getState().init();
      await settle();
      expect(store.getState().attempt?.prepared).toBeNull();

      await store.getState().cancel();
      await settle();

      expect(store.getState()).toMatchObject(CLEARED);
      expect(api.keys()).toEqual(["latest", "cancel"]);
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });
  });

  // ---- malformed success: the payment is left exactly as it was -----------------------------------------------

  type Case = [string, () => Response];
  const STATES_OTHER_THAN_CANCELLED = ["prepared", "awaiting_authorization", "signed", "submitting", "submitted", "confirmed", "failed", "unknown"];
  const MALFORMED: Case[] = [
    // the body itself
    ["empty success body", () => new Response("", { status: 200 })],
    ["non-JSON success body", () => new Response("<html>oops</html>", { status: 200 })],
    ["a body read that rejects", () => rawReply(async () => Promise.reject(new SyntaxError("Unexpected token FOREIGN in JSON")))],
    ["top-level null", () => J(null)],
    ["top-level string", () => J("cancelled")],
    ["top-level number", () => J(5)],
    ["top-level true", () => J(true)],
    ["top-level array holding the honest body", () => J([bodyOf()])],
    // the attempt
    ["no attempt", () => J({})],
    ["attempt: null", withTop({ attempt: null })],
    ["attempt: a string", withTop({ attempt: ATTEMPT_ID })],
    ["attempt: a number", withTop({ attempt: 1 })],
    ["attempt: an array holding the honest attempt", withTop({ attempt: [cancelledOf()] })],
    // the id
    ["no id", withAttempt({ id: undefined })],
    ["empty id", withAttempt({ id: "" })],
    ["numeric id", withAttempt({ id: 1 })],
    ["null id", withAttempt({ id: null })],
    ["object id", withAttempt({ id: {} })],
    ["foreign id", withAttempt({ id: "attempt-FOREIGN" })],
    ["case-folded id", withAttempt({ id: "ATTEMPT-1" })],
    ["leading-space id", withAttempt({ id: ` ${ATTEMPT_ID}` })],
    ["trailing-space id", withAttempt({ id: `${ATTEMPT_ID} ` })],
    // the state
    ["no state", withAttempt({ state: undefined })],
    ["unknown state", withAttempt({ state: "refunded-by-bank" })],
    ["case-folded state", withAttempt({ state: "CANCELLED" })],
    ["padded state", withAttempt({ state: "cancelled " })],
    ["numeric state", withAttempt({ state: 5 })],
    ["null state", withAttempt({ state: null })],
    ["array state", withAttempt({ state: ["cancelled"] })],
    ...STATES_OTHER_THAN_CANCELLED.map((state): Case => [`known state '${state}'`, withAttempt({ state })]),
    // the recipient
    ["no recipient", withAttempt({ recipient: undefined })],
    ["another recipient", withAttempt({ recipient: "0xdead000000000000000000000000000000000001" })],
    ["padded recipient", withAttempt({ recipient: "0x2222222222222222222222222222222222222222 " })],
    ["numeric recipient", withAttempt({ recipient: 5 })],
    ["null recipient", withAttempt({ recipient: null })],
    // the amount
    ["no amount", withAttempt({ amountBaseUnits: undefined })],
    ["another amount", withAttempt({ amountBaseUnits: "1000001" })],
    ["decimal amount", withAttempt({ amountBaseUnits: "1000000.0" })],
    ["padded amount", withAttempt({ amountBaseUnits: " 1000000" })],
    ["exponent amount", withAttempt({ amountBaseUnits: "1e6" })],
    ["numeric amount", withAttempt({ amountBaseUnits: 1_000_000 })],
    ["negative amount", withAttempt({ amountBaseUnits: "-1000000" })],
    ["empty amount", withAttempt({ amountBaseUnits: "" })],
    ["zero-padded amount", withAttempt({ amountBaseUnits: "01000000" })],
    ["null amount", withAttempt({ amountBaseUnits: null })],
    // transactionHash: a pre-dispatch (cancelled) row never has one
    ["no transactionHash", withAttempt({ transactionHash: undefined })],
    ["a transactionHash string", withAttempt({ transactionHash: "0xabc" })],
    ["an empty transactionHash string", withAttempt({ transactionHash: "" })],
    ["numeric transactionHash", withAttempt({ transactionHash: 0 })],
    ["object transactionHash", withAttempt({ transactionHash: {} })],
    ["boolean transactionHash", withAttempt({ transactionHash: false })],
  ];

  it("the case list has no duplicates and covers every rejection class", () => {
    expect(new Set(MALFORMED.map(([name]) => name)).size).toBe(MALFORMED.length);
    expect(MALFORMED.length).toBeGreaterThanOrEqual(55);
  });

  describe("a malformed 200 from Cancel: the existing neutral message, and nothing else", () => {
    it.each(MALFORMED)("from the approval screen — %s", async (_name, answer) => {
      const api = server({ cancel: () => answer() });
      const store = holding("awaiting");
      // The saved approval and an earlier session marker must survive untouched.
      store.setState({ pendingSubmission: APPROVAL, sessionRecovery: "signed_out" });
      const before = visible(store);

      await store.getState().cancel();
      await settle();

      unchangedExceptError(store, before);
      expect(store.getState()).toMatchObject({ error: CANCEL_UNCONFIRMED, isCancelling: false, status: "awaiting_authorization", sessionRecovery: "signed_out", pendingSubmission: APPROVAL, authorizingCredentialId: "credential-1", subOrganizationId: "sub-org-1" });
      expect(store.getState().attempt?.id).toBe(ATTEMPT_ID);
      expect(api.keys()).toEqual(["cancel"]); // exactly one POST; no status, latest, prepare or submit by itself
      expect(signPreparedPayment).not.toHaveBeenCalled();
      expect(JSON.stringify(visible(store))).not.toMatch(LEAK);
      // No automatic retry, ever.
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(api.keys()).toEqual(["cancel"]);
    });

    // Representative context retention on the other screens (the full table above is not multiplied across screens).
    const byName = (name: string): Case => MALFORMED.find(([candidate]) => candidate === name) as Case;
    const REPRESENTATIVE: Case[] = [byName("empty success body"), byName("foreign id"), byName("known state 'submitted'")];

    describe.each(["stranded", "reserved"] as const)("from the %s screen", (kind) => {
      it.each(REPRESENTATIVE)("%s", async (_name, answer) => {
        const api = server({ cancel: () => answer() });
        const store = holding(kind);
        store.setState({ sessionRecovery: "not_accessible" });
        const before = visible(store);

        await store.getState().cancel();
        await settle();

        unchangedExceptError(store, before);
        expect(store.getState()).toMatchObject({ error: CANCEL_UNCONFIRMED, isCancelling: false, status: "stranded", sessionRecovery: "not_accessible", pendingSubmission: kind === "stranded" ? APPROVAL : null });
        expect(store.getState().attempt?.id).toBe(ATTEMPT_ID);
        expect(api.keys()).toEqual(["cancel"]);
        expect(signPreparedPayment).not.toHaveBeenCalled();
      });
    });

    it("a malformed 200 for a reserved row adopted through /latest keeps its real null signing context and invents none", async () => {
      const api = server({
        latest: () => J({ attempt: attemptOf("prepared", { prepared: null }), subOrganizationId: null, authorizingCredentialId: null, serverNowSeconds: serverNow() }),
        cancel: () => J({ attempt: null }),
      });
      const store = createRealPaymentStore();
      stores.push(store);
      await store.getState().init();
      await settle();
      const before = visible(store);

      await store.getState().cancel();
      await settle();

      unchangedExceptError(store, before);
      expect(store.getState()).toMatchObject({ status: "stranded", error: CANCEL_UNCONFIRMED, subOrganizationId: null, authorizingCredentialId: null, pendingSubmission: null });
      expect(api.keys()).toEqual(["latest", "cancel"]);
    });

    it("a recipient that differs only in letter case is rejected (no case-folding)", async () => {
      const mixed = "0xAbCdEf0000000000000000000000000000000001";
      const api = server({ cancel: withAttempt({ recipient: mixed.toLowerCase() }) });
      const store = holding("awaiting", { recipient: mixed });
      await store.getState().cancel();
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", error: CANCEL_UNCONFIRMED });
      expect(api.keys()).toEqual(["cancel"]);
    });

    it("the amount digit-string check stands on its own: a held non-digit amount is rejected even when the answer repeats it exactly", async () => {
      for (const odd of ["1e6", "1.5", "-1", " 1", "0x10", ""]) {
        const api = server({ cancel: withAttempt({ amountBaseUnits: odd }) });
        const store = holding("awaiting", { amountBaseUnits: odd });
        await store.getState().cancel();
        expect(store.getState(), `held amount ${JSON.stringify(odd)}`).toMatchObject({ status: "awaiting_authorization", error: CANCEL_UNCONFIRMED });
        expect(api.keys()).toEqual(["cancel"]);
      }
    });

    it("a non-2xx answer is never parsed by the success check: its body is not read, whatever it claims", async () => {
      const json = vi.fn(async () => bodyOf());
      const api = server({ cancel: () => rawReply(json, { ok: false, status: 409 }), status: () => J({ attempt: attemptOf("submitted"), serverNowSeconds: serverNow(), reconciliationDeferred: false }) });
      const store = holding("awaiting");
      await store.getState().cancel();
      await settle();
      expect(json).not.toHaveBeenCalled();
      // The existing refused-Cancel path ran (D-4 / D-10): one read, the real state shown beside the refusal.
      expect(store.getState()).toMatchObject({ status: "submitted", error: CANCEL_LOST_RACE });
      expect(api.keys()).toEqual(["cancel", "status"]);
    });

    it.each([409, 500, 401, 404])("an honest-looking cancelled body on HTTP %i does not release the payment to the form", async (code) => {
      const api = server({ cancel: () => jsonResponse(code, bodyOf()), status: () => J({ attempt: attemptOf("awaiting_authorization"), serverNowSeconds: serverNow(), reconciliationDeferred: false }) });
      const store = holding("awaiting");
      await store.getState().cancel();
      await settle();
      expect(store.getState().status).not.toBe("editing");
      expect(store.getState().attempt?.id).toBe(ATTEMPT_ID);
      expect(api.count("cancel")).toBe(1);
    });
  });

  // ---- the request slot: the body is read while THIS request owns it ------------------------------------------

  describe("Cancel request slot", () => {
    it("a second press while the fetch is pending sends no second POST", async () => {
      const gate = held();
      const api = server({ cancel: () => gate.promise });
      const store = holding("awaiting");
      const first = store.getState().cancel();
      const second = store.getState().cancel();
      expect(store.getState().isCancelling).toBe(true);
      expect(api.count("cancel")).toBe(1);
      gate.resolve(honest());
      await Promise.all([first, second]);
      expect(api.count("cancel")).toBe(1);
      expect(store.getState()).toMatchObject(CLEARED);
    });

    it("a second press while the successful body is still being read sends no second POST, and the slot is released only afterwards", async () => {
      const body = held<unknown>();
      const api = server({ cancel: () => rawReply(() => body.promise) });
      const store = holding("awaiting");
      const first = store.getState().cancel();
      await settle(); // the fetch has resolved; response.json() is pending
      expect(store.getState().isCancelling).toBe(true);

      await store.getState().cancel();
      await store.getState().cancel();
      expect(api.count("cancel")).toBe(1);
      expect(store.getState().isCancelling).toBe(true);

      body.resolve(bodyOf());
      await first;
      expect(api.count("cancel")).toBe(1);
      expect(store.getState()).toMatchObject(CLEARED);
    });

    it("a body read that fails releases the slot; a later explicit press is a new request and an honest answer works", async () => {
      const api = server({ cancel: (n) => (n === 1 ? rawReply(async () => Promise.reject(new SyntaxError("Unexpected end of JSON input"))) : honest()) });
      const store = holding("awaiting");
      await store.getState().cancel();
      expect(store.getState()).toMatchObject({ isCancelling: false, error: CANCEL_UNCONFIRMED, status: "awaiting_authorization" });
      expect(api.count("cancel")).toBe(1);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(api.count("cancel")).toBe(1); // nothing retried by itself

      await store.getState().cancel();
      expect(api.count("cancel")).toBe(2);
      expect(store.getState()).toMatchObject(CLEARED);
    });

    it("a malformed answer releases the slot too", async () => {
      const api = server({ cancel: (n) => (n === 1 ? J({ attempt: null }) : honest()) });
      const store = holding("awaiting");
      await store.getState().cancel();
      expect(store.getState()).toMatchObject({ isCancelling: false, error: CANCEL_UNCONFIRMED });
      await store.getState().cancel();
      expect(api.count("cancel")).toBe(2);
      expect(store.getState()).toMatchObject(CLEARED);
    });

    it("after a malformed answer, an explicit second press that gets an honest 409 uses the unchanged refused-Cancel path (one status read, the existing wording)", async () => {
      const api = server({
        cancel: (n) => (n === 1 ? J({ attempt: null }) : jsonResponse(409, { error: "This payment can no longer be cancelled (state: cancelled)." })),
        status: () => J({ attempt: attemptOf("cancelled"), serverNowSeconds: serverNow(), reconciliationDeferred: false }),
      });
      const store = holding("awaiting");
      await store.getState().cancel();
      expect(store.getState().error).toBe(CANCEL_UNCONFIRMED);

      await store.getState().cancel();
      await settle();

      expect(api.keys()).toEqual(["cancel", "cancel", "status"]);
      // The first Cancel may in fact have worked: the real state is shown beside the (existing, cautious) refusal wording.
      expect(store.getState()).toMatchObject({ status: "editing", error: CANCEL_LOST_RACE });
      expect(store.getState().attempt?.state).toBe("cancelled");
    });

    it("…and a malformed status answer on that path still takes D-10's unchanged fallback and deferral", async () => {
      const api = server({
        cancel: (n) => (n === 1 ? J({ attempt: null }) : jsonResponse(409, { error: "no" })),
        status: () => J(null),
      });
      const store = holding("awaiting");
      await store.getState().cancel();
      await store.getState().cancel();
      await settle();
      expect(api.keys()).toEqual(["cancel", "cancel", "status"]);
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", error: CANCEL_UNCONFIRMED, isStatusDeferred: true, statusRetryAfterSeconds: null });
      expect(store.getState().attempt?.id).toBe(ATTEMPT_ID);
    });
  });

  // ---- late answers: after the final await the guard runs before anything is validated or written -------------

  describe("a late answer never writes into a newer lifecycle", () => {
    type Event = [string, (store: Store) => void];
    const EVENTS: Event[] = [
      ["an account switch", () => useRealAccountStore.setState({ account: ACCOUNT_B })],
      ["reset", (store) => store.getState().reset()],
      ["detach", (store) => store.getState().detach()],
      ["an attempt replacement", (store) => store.setState({ status: "awaiting_authorization", attempt: attemptOf("awaiting_authorization", { id: ATTEMPT_ID_2 }) as never })],
    ];
    const ANSWERS: Array<[string, unknown | "reject"]> = [
      ["an honest cancelled answer", bodyOf()],
      ["a malformed answer", { attempt: null }],
      ["an answer for another payment", bodyOf({ id: "attempt-FOREIGN" })],
      ["a body that fails to parse", "reject"],
    ];

    describe.each(EVENTS)("%s", (_event, happen) => {
      it.each(ANSWERS)("while the fetch is pending, then %s arrives", async (_name, answer) => {
        const gate = held();
        const api = server({ cancel: () => gate.promise });
        const store = holding("awaiting");
        const pending = store.getState().cancel();
        await settle();

        happen(store);
        const after = { ...visible(store), isCancelling: false };
        gate.resolve(answer === "reject" ? rawReply(async () => Promise.reject(new SyntaxError("Unexpected token FOREIGN"))) : J(answer));
        await pending;
        await settle();

        expect({ ...visible(store), isCancelling: false }).toEqual(after); // nothing written: no clear, no error
        expect(store.getState().error).toBeNull();
        expect(api.keys()).toEqual(["cancel"]);
        expect(JSON.stringify(visible(store))).not.toMatch(LEAK);
      });

      it.each(ANSWERS)("after the fetch resolved but while response.json() is still pending, then %s arrives", async (_name, answer) => {
        const body = held<unknown>();
        const api = server({ cancel: () => rawReply(() => body.promise) });
        const store = holding("awaiting");
        const pending = store.getState().cancel();
        await settle(); // fetch settled; the body read is the pending await

        happen(store);
        const after = { ...visible(store), isCancelling: false };
        if (answer === "reject") body.reject(new SyntaxError("Unexpected token FOREIGN"));
        else body.resolve(answer);
        await pending;
        await settle();

        expect({ ...visible(store), isCancelling: false }).toEqual(after);
        expect(store.getState().error).toBeNull();
        expect(api.keys()).toEqual(["cancel"]);
        expect(JSON.stringify(visible(store))).not.toMatch(LEAK);
      });
    });

    it("a late answer from an older lifecycle does not release a newer lifecycle's Cancel slot", async () => {
      const staleBody = held<unknown>();
      const newerGate = held();
      const api = server({ cancel: (n) => (n === 1 ? rawReply(() => staleBody.promise) : newerGate.promise) });
      const store = holding("awaiting");
      const stale = store.getState().cancel();
      await settle();

      // A new lifecycle with its own payment and its own Cancel request in flight.
      store.getState().reset();
      store.setState({ status: "awaiting_authorization", attempt: attemptOf("awaiting_authorization", { id: ATTEMPT_ID_2 }) as never });
      const newer = store.getState().cancel();
      await settle();
      expect(store.getState().isCancelling).toBe(true);
      expect(api.count("cancel")).toBe(2);

      staleBody.resolve(bodyOf()); // honest for the OLD payment
      await stale;
      await settle();
      // Still the newer request's slot: a repeat press sends nothing, and the newer payment is untouched.
      expect(store.getState()).toMatchObject({ isCancelling: true, error: null, attempt: { id: ATTEMPT_ID_2 }, status: "awaiting_authorization" });
      await store.getState().cancel();
      expect(api.count("cancel")).toBe(2);

      newerGate.resolve(honest({ id: ATTEMPT_ID_2 }));
      await newer;
      expect(store.getState()).toMatchObject(CLEARED);
    });
  });

  // ---- what a rejection must leave running --------------------------------------------------------------------

  describe("a rejected answer leaves the existing timers, deferral and follow-ups alone", () => {
    const latestAboutToExpire = () => J({ attempt: attemptOf("awaiting_authorization"), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: serverNow(100) });

    it("the pending expiry timer still fires (no new D-11 request: the one read is the existing timer's)", async () => {
      const api = server({ latest: latestAboutToExpire, cancel: () => J({ attempt: null }), status: () => J(null) });
      const store = createRealPaymentStore();
      stores.push(store);
      await store.getState().init();
      await settle();
      expect(api.keys()).toEqual(["latest"]);

      await store.getState().cancel();
      expect(api.keys()).toEqual(["latest", "cancel"]);
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", error: CANCEL_UNCONFIRMED });

      await vi.advanceTimersByTimeAsync(100_999); // validUntil + 1 s is the existing arm point
      expect(api.count("status")).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(api.count("status")).toBe(1);
      expect(api.keys().filter((key) => key !== "status")).toEqual(["latest", "cancel"]);
    });

    it("contrast: an honest success clears that timer (nothing fires later)", async () => {
      const api = server({ latest: latestAboutToExpire, cancel: () => honest(), status: () => J(null) });
      const store = createRealPaymentStore();
      stores.push(store);
      await store.getState().init();
      await store.getState().cancel();
      expect(store.getState()).toMatchObject(CLEARED);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(api.keys()).toEqual(["latest", "cancel"]);
    });

    it("D-10's 60 s deferral and cooldown stand: a malformed Cancel neither extends nor ends them", async () => {
      const api = server({ status: () => J(null), cancel: () => J(null) });
      const store = holding("awaiting");
      await store.getState().checkStatus();
      await settle();
      expect(store.getState()).toMatchObject({ error: UNUSABLE, isStatusDeferred: true });
      expect(api.keys()).toEqual(["status"]);

      await store.getState().cancel();
      await settle();
      expect(store.getState()).toMatchObject({ error: CANCEL_UNCONFIRMED, isStatusDeferred: true, statusRetryAfterSeconds: null, status: "awaiting_authorization" });
      expect(api.keys()).toEqual(["status", "cancel"]);

      // Still inside the original window: Check status sends nothing; at the original 60 s it works again.
      await vi.advanceTimersByTimeAsync(STATUS_FALLBACK_DEADLINE_MS - 1);
      await store.getState().checkStatus();
      expect(api.count("status")).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await store.getState().checkStatus();
      await settle();
      expect(api.count("status")).toBe(2);
    });

    it("a status read already in flight is not made stale by a malformed Cancel answer (no local transition is recorded): its honest answer is still applied", async () => {
      const read = held();
      const api = server({ status: () => read.promise, cancel: () => J({ attempt: null }) });
      const store = holding("awaiting");
      const checking = store.getState().checkStatus();
      await settle();
      expect(api.count("status")).toBe(1);

      await store.getState().cancel(); // a rejected answer: the payment did not change locally
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", error: CANCEL_UNCONFIRMED });

      read.resolve(J({ attempt: attemptOf("submitted"), serverNowSeconds: serverNow(), reconciliationDeferred: false }));
      await checking;
      await settle();

      expect(store.getState()).toMatchObject({ status: "submitted", error: null });
      expect(store.getState().attempt?.state).toBe("submitted");
      expect(api.keys()).toEqual(["status", "cancel"]);
    });

    // The form offers no Cancel on the Sending screen, so this is a store-API path, not a screen the user can reach; it pins that the
    // rejection does not touch D-6's deadline (an honest success clears it, as before).
    it("(store API only) D-6: the 60 s submit deadline is not cleared by a malformed Cancel answer", async () => {
      const gate = held();
      const api = server({ submit: () => gate.promise, cancel: () => J({ attempt: null }) });
      const store = holding("awaiting");
      const sending = store.getState().resumeAuthorization();
      await settle();
      expect(api.count("submit")).toBe(1);

      await store.getState().cancel();
      expect(store.getState().error).toBe(CANCEL_UNCONFIRMED);

      await vi.advanceTimersByTimeAsync(SUBMIT_REQUEST_DEADLINE_MS);
      expect(store.getState()).toMatchObject({ status: "unknown", pendingSubmission: APPROVAL });
      expect(api.keys()).toEqual(["submit", "cancel"]);
      gate.resolve(J({ attempt: attemptOf("submitted") }));
      await sending;
    });
  });
});

/**
 * L-2 D-12 — a prepare HTTP 200 is checked (isHonestPrepareResponse) against
 * what THAT request sent before anything is adopted or signed. A rejected
 * answer takes D-1's uncertain-prepare state exactly and nothing else: no
 * adoption, no signing, no automatic request. Fixtures follow
 * resolvePreparePayment's "ready" answer (toPublicAttempt).
 */
describe("real-payment-store — L-2 D-12: prepare answers are checked before adoption", () => {
  const ACCOUNT = { appUserId: "app-user-d12", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222" };
  const ACCOUNT_B = { appUserId: "app-user-d12-b", ownerAddress: "0x6666666666666666666666666666666666666666", safeAddress: "0x7777777777777777777777777777777777777777" };
  /** Lower-case (normalizeAddress) — what the client sends and the server stores for an address payment. */
  const ADDRESS = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
  const CHECKSUMMED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
  const OTHER_ADDRESS = "0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359";
  /** A handle payment's recipient: pg_catalog.lower(safe_address) of @smit's account. */
  const SMIT_SAFE = "0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae";
  const FOUND_SMIT = { found: true, handle: "smit", displayName: "Smit Patel", isSelf: false };
  const SERVER_NOW = 1_900_000_000;
  const T0_MS = (SERVER_NOW - 100) * 1000;
  const UUID = PREPARED_ID;

  type Json = Record<string, unknown>;
  type Reply = { attempt: Json & { prepared: Json; recipientIdentity: unknown }; subOrganizationId: unknown; authorizingCredentialId: unknown; serverNowSeconds: unknown } & Json;

  /** A deployed Safe, sponsored: what server/payments.ts serializes for a fresh preparation. */
  const fields = (): Json => ({
    sender: "0x2222222222222222222222222222222222222222",
    nonce: "1844674407370955161600",
    factory: null,
    factoryData: null,
    callData: "0x7bb374280000000000000000000000000000000000000000000000000000000000000001",
    callGasLimit: "86143",
    verificationGasLimit: "120371",
    preVerificationGas: "55264",
    maxFeePerGas: "1200000",
    maxPriorityFeePerGas: "1000000",
    paymaster: "0x777777777777AeC03fd955926DbF81597e66834C",
    paymasterData: "0x01000066d1a1a4000000000000",
    paymasterVerificationGasLimit: "37193",
    paymasterPostOpGasLimit: "1",
    validUntil: SERVER_NOW + 600,
  });

  function addressReply(): Reply {
    return {
      attempt: { id: UUID, state: "awaiting_authorization", recipient: ADDRESS, recipientIdentity: null, amountBaseUnits: "1000000", transactionHash: null, failureReason: null, createdAt: "2030-03-17T17:46:40.000Z", updatedAt: "2030-03-17T17:46:41.000Z", prepared: fields() },
      subOrganizationId: "4f8d1c2b-9a3e-4b7f-8c6d-1e2f3a4b5c6d",
      authorizingCredentialId: "Zm9vYmFyLWNyZWRlbnRpYWwtaWQ",
      serverNowSeconds: SERVER_NOW,
    };
  }

  function handleReply(displayName: string | null = "Smit P. (stored)"): Reply {
    const reply = addressReply();
    reply.attempt.recipient = SMIT_SAFE;
    reply.attempt.recipientIdentity = { handle: "smit", displayName };
    return reply;
  }

  /** A Response-like object for bodies JSON cannot carry (a non-finite number). `api()` reads only ok, status, json() and headers. */
  const runtimeReply = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body }) as unknown as Response;

  const stores: Array<ReturnType<typeof createRealPaymentStore>> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0_MS);
    useRealAccountStore.setState({ account: ACCOUNT });
    vi.mocked(signPreparedPayment).mockReset();
    // The passkey sheet is dismissed: an accepted payment simply waits for approval, nothing is submitted.
    vi.mocked(signPreparedPayment).mockRejectedValue(Object.assign(new Error("dismissed"), { name: "NotAllowedError" }));
  });

  afterEach(() => {
    for (const store of stores.splice(0)) store.getState().detach();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.mocked(signPreparedPayment).mockReset();
    useRealAccountStore.setState({ account: null });
  });

  type Handler = (body: unknown) => Response | Promise<Response>;
  function server(handlers: { prepare: Handler; latest?: () => Response; lookup?: () => Response }) {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({ url, method, body });
        if (url === "/api/real/payments/prepare" && method === "POST") return handlers.prepare(body);
        if (url === "/api/real/payments/latest" && handlers.latest) return handlers.latest();
        if (url === "/api/real/recipients/lookup" && handlers.lookup) return handlers.lookup();
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
    return { calls, urls: () => calls.map((call) => `${call.method} ${call.url}`) };
  }

  async function reviewing(to: string, amount = "1") {
    const store = createRealPaymentStore();
    stores.push(store);
    store.setState({ status: "editing" });
    store.getState().setRecipientInput(to);
    store.getState().setAmountInput(amount);
    await store.getState().review();
    expect(store.getState().status).toBe("reviewing");
    return store;
  }

  function deferred() {
    let resolve: (response: Response) => void = () => {};
    const promise = new Promise<Response>((res) => (resolve = res));
    return { promise, resolve };
  }

  const PREPARE_POST = "POST /api/real/payments/prepare";

  /** Values a rejection must leave exactly as they were — set as sentinels so any adoption step shows up. */
  const SENTINELS = { clockOffsetSeconds: 1234, isManualCheckCoolingDown: true, isSubmitCoolingDown: true, submitCooldownSeconds: 42, isSubmitRetryBeyondApproval: true, isAttemptPastValidity: true, isFollowUpExhausted: true, isStatusDeferred: true, statusRetryAfterSeconds: 9 } as const;

  /** Approves from Review with the given answer; asserts D-1's uncertain state is the ONLY change and that nothing follows it for an hour. */
  async function expectRejected(store: ReturnType<typeof createRealPaymentStore>, api: ReturnType<typeof server>) {
    store.setState(SENTINELS);
    const before = store.getState();
    await store.getState().confirmAndSend();
    expect(store.getState()).toEqual({ ...before, status: "editing", error: null, prepareNeedsCheck: "uncertain", prepareCheck: "idle" });
    expect(store.getState()).toMatchObject({ attempt: null, subOrganizationId: null, authorizingCredentialId: null, pendingSubmission: null });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(api.urls()).toEqual([PREPARE_POST]);
    expect(signPreparedPayment).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ status: "editing", prepareNeedsCheck: "uncertain", error: null });
  }

  function expectAdopted(store: ReturnType<typeof createRealPaymentStore>, reply: Reply) {
    expect(store.getState()).toMatchObject({ status: "awaiting_authorization", attempt: reply.attempt, subOrganizationId: reply.subOrganizationId, authorizingCredentialId: reply.authorizingCredentialId, clockOffsetSeconds: 100, prepareNeedsCheck: null, error: null, pendingSubmission: null });
    expect(signPreparedPayment).toHaveBeenCalledTimes(1);
    expect(vi.mocked(signPreparedPayment).mock.calls[0]![0]).toMatchObject({ fields: reply.attempt.prepared, subOrganizationId: reply.subOrganizationId, authorizingCredentialId: reply.authorizingCredentialId });
  }

  describe("honest answers keep the existing flow: adopted, then the one passkey prompt", () => {
    const ADDRESS_CASES: Array<[string, string, string, string, (reply: Reply) => void]> = [
      ["a canonical address", ADDRESS, "1", "1000000", () => {}],
      ["a mixed-case address typed with spaces (sent, and answered, lower-case)", `  ${CHECKSUMMED}  `, "1", "1000000", () => {}],
      ["an amount of 1.5", ADDRESS, "1.5", "1500000", () => {}],
      ["an amount of 0.01", ADDRESS, "0.01", "10000", () => {}],
      ["every nullable prepared field null", ADDRESS, "1", "1000000", (r) => Object.assign(r.attempt.prepared, { factory: null, factoryData: null, paymaster: null, paymasterData: null, paymasterVerificationGasLimit: null, paymasterPostOpGasLimit: null })],
      ["every nullable prepared field populated (an undeployed Safe), checksummed addresses kept", ADDRESS, "1", "1000000", (r) => Object.assign(r.attempt.prepared, { factory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67", factoryData: "0x1688f0b900000000000000000000000029fcB43b46531BcA003ddC8FCB67FFE91900C7620000000000000000000000000000000000000000000000000000000000000060" })],
      ["a checksummed sender", ADDRESS, "1", "1000000", (r) => (r.attempt.prepared.sender = "0xCAFEcafeCAFEcafeCAFEcafeCAFEcafeCAFEcafe")],
      ["empty paymasterData and upper-case hex data", ADDRESS, "1", "1000000", (r) => Object.assign(r.attempt.prepared, { paymasterData: "0x", callData: "0x7BB37428ABCDEF" })],
      ["empty callData", ADDRESS, "1", "1000000", (r) => (r.attempt.prepared.callData = "0x")],
      ["zero gas values", ADDRESS, "1", "1000000", (r) => Object.assign(r.attempt.prepared, { nonce: "0", preVerificationGas: "0", paymasterPostOpGasLimit: "0" })],
      ["unrelated extra keys at every level", ADDRESS, "1", "1000000", (r) => Object.assign(r, { requestId: "x", attempt: { ...r.attempt, chainId: 84532, prepared: { ...r.attempt.prepared, extra: true } } })],
      ["no timestamps", ADDRESS, "1", "1000000", (r) => { delete r.attempt.createdAt; delete r.attempt.updatedAt; }],
      ["odd timestamps", ADDRESS, "1", "1000000", (r) => Object.assign(r.attempt, { createdAt: 5, updatedAt: null })],
    ];

    it.each(ADDRESS_CASES)("%s", async (_name, to, amount, sentAmount, edit) => {
      const reply = addressReply();
      reply.attempt.amountBaseUnits = sentAmount;
      edit(reply);
      const api = server({ prepare: () => jsonResponse(200, reply) });
      const store = await reviewing(to, amount);

      await store.getState().confirmAndSend();

      expect(api.calls[0]!.body).toEqual({ recipient: ADDRESS, amountBaseUnits: sentAmount });
      expectAdopted(store, reply);
    });

    it.each([
      ["a stored display name that differs from the earlier lookup", "Smit P. (stored)"],
      ["no stored display name", null],
    ] as const)("a handle payment: the lower-case resolved Safe and %s", async (_name, displayName) => {
      const reply = handleReply(displayName);
      const api = server({ lookup: () => jsonResponse(200, FOUND_SMIT), prepare: () => jsonResponse(200, reply) });
      const store = await reviewing("@Smit");

      await store.getState().confirmAndSend();

      expect(api.calls.find((call) => call.url.endsWith("/prepare"))!.body).toEqual({ recipientHandle: "smit", amountBaseUnits: "1000000" });
      expectAdopted(store, reply);
      expect(store.getState().attempt?.recipientIdentity).toEqual({ handle: "smit", displayName });
    });
  });

  describe("anything else is not adopted: D-1's uncertain state, and nothing happens by itself", () => {
    type Case = [string, (reply: Reply) => unknown];
    const without = (key: string) => (r: Reply) => {
      delete r.attempt[key];
      return r;
    };
    const withAttempt = (patch: Json) => (r: Reply) => ({ ...r, attempt: { ...r.attempt, ...patch } });
    const withTop = (patch: Json) => (r: Reply) => ({ ...r, ...patch });
    const withoutTop = (key: string) => (r: Reply) => {
      delete r[key];
      return r;
    };
    const withPrepared = (patch: Json) => (r: Reply) => ({ ...r, attempt: { ...r.attempt, prepared: { ...r.attempt.prepared, ...patch } } });
    const withoutPrepared = (key: string) => (r: Reply) => {
      delete r.attempt.prepared[key];
      return r;
    };

    const BODY: Case[] = [
      ["a null body", () => null],
      ["a number", () => 42],
      ["a string", () => "ok"],
      ["an array", (r) => [r]],
      ["an empty object", () => ({})],
      ["no attempt", withoutTop("attempt")],
      ["a null attempt", withTop({ attempt: null })],
      ["a string attempt", withTop({ attempt: "attempt" })],
      ["an array attempt", (r) => ({ ...r, attempt: [r.attempt] })],
    ];
    const IDENTITY: Case[] = [
      ["no id", without("id")],
      ["a numeric id", withAttempt({ id: 1 })],
      ["an empty id", withAttempt({ id: "" })],
      ["a placeholder id", withAttempt({ id: "attempt-1" })],
      ["a path-like id", withAttempt({ id: "../../latest" })],
      ["a UUID with a path suffix", withAttempt({ id: `${UUID}/cancel` })],
      ["a UUID with a space", withAttempt({ id: ` ${UUID}` })],
      ["the nil UUID (not a server-issued version)", withAttempt({ id: "00000000-0000-0000-0000-000000000000" })],
      ["no state", without("state")],
      ["an unknown state", withAttempt({ state: "approved" })],
      ...(["prepared", "signed", "submitting", "submitted", "confirmed", "failed", "cancelled", "unknown"] as const).map((state): Case => [`the known state '${state}'`, withAttempt({ state })]),
      ["another recipient", withAttempt({ recipient: OTHER_ADDRESS })],
      ["the recipient in upper case", withAttempt({ recipient: `0x${ADDRESS.slice(2).toUpperCase()}` })],
      ["the recipient checksummed", withAttempt({ recipient: CHECKSUMMED })],
      ["no recipient", without("recipient")],
      ["a non-string recipient", withAttempt({ recipient: 5 })],
      ["an identity on an address payment", withAttempt({ recipientIdentity: { handle: "smit", displayName: null } })],
      ["no recipientIdentity", without("recipientIdentity")],
      ["no amount", without("amountBaseUnits")],
      ["a numeric amount", withAttempt({ amountBaseUnits: 1000000 })],
      ["another amount", withAttempt({ amountBaseUnits: "2000000" })],
      ["a zero-padded amount", withAttempt({ amountBaseUnits: "01000000" })],
      ["a decimal amount", withAttempt({ amountBaseUnits: "1000000.0" })],
      ["an exponent amount", withAttempt({ amountBaseUnits: "1e6" })],
      ["no transactionHash", without("transactionHash")],
      ["a transactionHash", withAttempt({ transactionHash: `0x${"ab".repeat(32)}` })],
      ["an empty transactionHash", withAttempt({ transactionHash: "" })],
      ["no failureReason", without("failureReason")],
      ["a failureReason", withAttempt({ failureReason: "Could not prepare this payment right now." })],
      ["an empty failureReason", withAttempt({ failureReason: "" })],
    ];
    const SIGNING: Case[] = [
      ["no subOrganizationId", withoutTop("subOrganizationId")],
      ["a null subOrganizationId", withTop({ subOrganizationId: null })],
      ["a numeric subOrganizationId", withTop({ subOrganizationId: 7 })],
      ["an empty subOrganizationId", withTop({ subOrganizationId: "" })],
      ["no authorizingCredentialId", withoutTop("authorizingCredentialId")],
      ["a null authorizingCredentialId", withTop({ authorizingCredentialId: null })],
      ["an object authorizingCredentialId", withTop({ authorizingCredentialId: { id: "x" } })],
      ["an empty authorizingCredentialId", withTop({ authorizingCredentialId: "" })],
    ];
    const CLOCK: Case[] = [
      ["no serverNowSeconds", withoutTop("serverNowSeconds")],
      ["a string serverNowSeconds", withTop({ serverNowSeconds: String(SERVER_NOW) })],
      ["a null serverNowSeconds", withTop({ serverNowSeconds: null })],
    ];
    const PREPARED: Case[] = [
      ["no prepared", without("prepared")],
      ["a null prepared", withAttempt({ prepared: null })],
      ["a string prepared", withAttempt({ prepared: "n/a" })],
      ["an array prepared", (r) => withAttempt({ prepared: [r.attempt.prepared] })(r)],
      ...["sender", "nonce", "callData", "callGasLimit", "verificationGasLimit", "preVerificationGas", "maxFeePerGas", "maxPriorityFeePerGas", "validUntil"].map((key): Case => [`no required '${key}'`, withoutPrepared(key)]),
      ...["factory", "factoryData", "paymaster", "paymasterData", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit"].map((key): Case => [`no nullable '${key}' key`, withoutPrepared(key)]),
      ["a short sender", withPrepared({ sender: "0x2222" })],
      ["a non-hex sender", withPrepared({ sender: `0x${"g".repeat(40)}` })],
      ["a sender with an upper-case 0X", withPrepared({ sender: `0X${"2".repeat(40)}` })],
      ["a sender with a space", withPrepared({ sender: ` 0x${"2".repeat(40)}` })],
      ["a numeric sender", withPrepared({ sender: 1 })],
      ["a negative nonce", withPrepared({ nonce: "-1" })],
      ["a fractional callGasLimit", withPrepared({ callGasLimit: "86143.5" })],
      ["an exponent verificationGasLimit", withPrepared({ verificationGasLimit: "1e5" })],
      ["a hex preVerificationGas", withPrepared({ preVerificationGas: "0xd7e0" })],
      ["a maxFeePerGas with a space", withPrepared({ maxFeePerGas: " 1200000" })],
      ["a maxPriorityFeePerGas with a trailing newline", withPrepared({ maxPriorityFeePerGas: "1000000\n" })],
      ["an empty nonce", withPrepared({ nonce: "" })],
      ["a numeric callGasLimit", withPrepared({ callGasLimit: 86143 })],
      ["non-ASCII digits", withPrepared({ maxFeePerGas: "١٢٠٠٠٠٠" })],
      ["callData without 0x", withPrepared({ callData: "7bb37428" })],
      ["non-hex callData", withPrepared({ callData: "0xzz" })],
      ["odd-length callData", withPrepared({ callData: "0x7bb3742" })],
      ["empty-string callData", withPrepared({ callData: "" })],
      ["numeric callData", withPrepared({ callData: 0 })],
      ["a malformed factory", withPrepared({ factory: "0x4e1d" })],
      ["a numeric factory", withPrepared({ factory: 0 })],
      ["odd-length factoryData", withPrepared({ factory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67", factoryData: "0x168" })],
      ["a malformed paymaster", withPrepared({ paymaster: "paymaster" })],
      ["non-hex paymasterData", withPrepared({ paymasterData: "0xgg" })],
      ["a numeric paymasterData", withPrepared({ paymasterData: 1 })],
      ["a negative paymasterVerificationGasLimit", withPrepared({ paymasterVerificationGasLimit: "-5" })],
      ["a numeric paymasterVerificationGasLimit", withPrepared({ paymasterVerificationGasLimit: 37193 })],
      ["a fractional paymasterPostOpGasLimit", withPrepared({ paymasterPostOpGasLimit: "1.0" })],
      ["a string validUntil", withPrepared({ validUntil: String(SERVER_NOW + 600) })],
      ["a fractional validUntil", withPrepared({ validUntil: SERVER_NOW + 600.5 })],
      ["a zero validUntil", withPrepared({ validUntil: 0 })],
      ["a negative validUntil", withPrepared({ validUntil: -1 })],
      ["an unsafe validUntil", withPrepared({ validUntil: 2 ** 53 })],
      ["a null validUntil", withPrepared({ validUntil: null })],
    ];

    it.each([...BODY, ...IDENTITY, ...SIGNING, ...CLOCK, ...PREPARED])("an address payment answered with %s", async (_name, make) => {
      const api = server({ prepare: () => jsonResponse(200, make(addressReply())) });
      await expectRejected(await reviewing(ADDRESS), api);
    });

    it.each([
      ["an empty body", () => new Response("", { status: 200 })],
      ["a non-JSON body", () => new Response("<html>ok</html>", { status: 200 })],
      ["an infinite serverNowSeconds", () => runtimeReply({ ...addressReply(), serverNowSeconds: Infinity })],
      ["a NaN serverNowSeconds", () => runtimeReply({ ...addressReply(), serverNowSeconds: Number.NaN })],
      ["an infinite validUntil", () => runtimeReply(withPrepared({ validUntil: Infinity })(addressReply()))],
      ["a NaN validUntil", () => runtimeReply(withPrepared({ validUntil: Number.NaN })(addressReply()))],
    ] as const)("an address payment answered with %s (a runtime body)", async (_name, respond) => {
      const api = server({ prepare: () => respond() });
      await expectRejected(await reviewing(ADDRESS), api);
    });

    it.each([
      ["a checksummed resolved address", (r: Reply) => withAttempt({ recipient: "0xdE0B295669a9FD93d5F28D9Ec85E40f4cb697BAe" })(r)],
      ["a resolved address with 0X", (r: Reply) => withAttempt({ recipient: `0X${SMIT_SAFE.slice(2)}` })(r)],
      ["a short resolved address", (r: Reply) => withAttempt({ recipient: "0xde0b" })(r)],
      ["no recipient", (r: Reply) => without("recipient")(r)],
      ["the handle as the recipient", (r: Reply) => withAttempt({ recipient: "smit" })(r)],
      ["a null identity", (r: Reply) => withAttempt({ recipientIdentity: null })(r)],
      ["no identity", (r: Reply) => without("recipientIdentity")(r)],
      ["another handle", (r: Reply) => withAttempt({ recipientIdentity: { handle: "smith", displayName: "Smit P. (stored)" } })(r)],
      ["a non-canonical handle", (r: Reply) => withAttempt({ recipientIdentity: { handle: "Smit", displayName: null } })(r)],
      ["an @-prefixed handle", (r: Reply) => withAttempt({ recipientIdentity: { handle: "@smit", displayName: null } })(r)],
      ["a padded handle", (r: Reply) => withAttempt({ recipientIdentity: { handle: " smit", displayName: null } })(r)],
      ["an extra identity key", (r: Reply) => withAttempt({ recipientIdentity: { handle: "smit", displayName: null, appUserId: "app-user-9" } })(r)],
      ["no displayName key", (r: Reply) => withAttempt({ recipientIdentity: { handle: "smit" } })(r)],
      ["an empty displayName", (r: Reply) => withAttempt({ recipientIdentity: { handle: "smit", displayName: "" } })(r)],
      ["a blank displayName", (r: Reply) => withAttempt({ recipientIdentity: { handle: "smit", displayName: "   " } })(r)],
      ["a numeric displayName", (r: Reply) => withAttempt({ recipientIdentity: { handle: "smit", displayName: 5 } })(r)],
      ["an array identity", (r: Reply) => withAttempt({ recipientIdentity: [{ handle: "smit", displayName: null }] })(r)],
      ["a string identity", (r: Reply) => withAttempt({ recipientIdentity: "smit" })(r)],
    ] as const)("a handle payment answered with %s", async (_name, make) => {
      const api = server({ lookup: () => jsonResponse(200, FOUND_SMIT), prepare: () => jsonResponse(200, make(handleReply())) });
      const store = await reviewing("@smit");
      api.calls.length = 0; // the advisory lookup Review made
      await expectRejected(store, api);
    });
  });

  describe("captured intent, lifecycle and placement", () => {
    it("the answer is compared with what THIS request sent, not with inputs edited while it was on its way: a match is adopted", async () => {
      const gate = deferred();
      const reply = addressReply();
      server({ prepare: () => gate.promise });
      const store = await reviewing(ADDRESS, "1");
      const pending = store.getState().confirmAndSend();
      store.getState().setRecipientInput(OTHER_ADDRESS);
      store.getState().setAmountInput("2");

      gate.resolve(jsonResponse(200, reply));
      await pending;

      expectAdopted(store, reply);
      expect(store.getState()).toMatchObject({ recipientInput: OTHER_ADDRESS, amountInput: "2" });
    });

    it("an answer that matches the edited inputs but not the request is rejected", async () => {
      const gate = deferred();
      const reply = addressReply();
      reply.attempt.recipient = OTHER_ADDRESS;
      reply.attempt.amountBaseUnits = "2000000";
      const api = server({ prepare: () => gate.promise });
      const store = await reviewing(ADDRESS, "1");
      store.setState(SENTINELS);
      const pending = store.getState().confirmAndSend();
      store.getState().setRecipientInput(OTHER_ADDRESS);
      store.getState().setAmountInput("2");
      const before = store.getState();

      gate.resolve(jsonResponse(200, reply));
      await pending;

      expect(store.getState()).toEqual({ ...before, status: "editing", error: null, prepareNeedsCheck: "uncertain", prepareCheck: "idle" });
      expect(store.getState()).toMatchObject({ attempt: null, recipientInput: OTHER_ADDRESS, amountInput: "2" });
      expect(api.urls()).toEqual([PREPARE_POST]);
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });

    it("a handle answer is compared with the handle sent, even after the field names another one", async () => {
      const gate = deferred();
      const reply = handleReply();
      server({ lookup: () => jsonResponse(200, FOUND_SMIT), prepare: () => gate.promise });
      const store = await reviewing("@smit");
      const pending = store.getState().confirmAndSend();
      store.getState().setRecipientInput("@someone");

      gate.resolve(jsonResponse(200, reply));
      await pending;

      expectAdopted(store, reply);
    });

    it.each([
      ["malformed", () => ({ ...addressReply(), attempt: { ...addressReply().attempt, id: "attempt-1" } })],
      ["honest", () => addressReply()],
    ] as const)("a late %s answer after a reset and an account switch writes nothing and signs nothing", async (_name, body) => {
      const gate = deferred();
      const api = server({ prepare: () => gate.promise });
      const store = await reviewing(ADDRESS);
      const pending = store.getState().confirmAndSend();
      useRealAccountStore.setState({ account: ACCOUNT_B });
      store.getState().reset();
      const after = store.getState();

      gate.resolve(jsonResponse(200, body()));
      await pending;
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(store.getState()).toBe(after);
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, prepareNeedsCheck: null, error: null, subOrganizationId: null, authorizingCredentialId: null });
      expect(signPreparedPayment).not.toHaveBeenCalled();
      expect(api.urls()).toEqual([PREPARE_POST]);
    });

    it.each([
      ["malformed", () => ({ ...addressReply(), subOrganizationId: "" })],
      ["honest", () => addressReply()],
    ] as const)("a late %s answer after an unmount and a remount (detach, init) writes nothing and signs nothing", async (_name, body) => {
      const gate = deferred();
      const api = server({ prepare: () => gate.promise, latest: () => jsonResponse(200, { attempt: null }) });
      const store = await reviewing(ADDRESS);
      const pending = store.getState().confirmAndSend();
      store.getState().detach();
      await store.getState().init();
      const after = store.getState();
      expect(after).toMatchObject({ status: "editing", prepareNeedsCheck: null });

      gate.resolve(jsonResponse(200, body()));
      await pending;
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(store.getState()).toBe(after);
      expect(signPreparedPayment).not.toHaveBeenCalled();
      expect(api.urls()).toEqual([PREPARE_POST, "GET /api/real/payments/latest"]);
    });

    it("a late malformed answer after a detach alone (no remount) writes nothing", async () => {
      const gate = deferred();
      server({ prepare: () => gate.promise });
      const store = await reviewing(ADDRESS);
      const pending = store.getState().confirmAndSend();
      store.getState().detach();
      const after = store.getState();

      gate.resolve(jsonResponse(200, { attempt: null }));
      await pending;

      expect(store.getState()).toBe(after);
      expect(store.getState().prepareNeedsCheck).toBeNull();
    });
  });

  describe("recovery stays the user's explicit D-1 check", () => {
    it("after a rejected answer, Review is refused, and only Check payment status reads /latest — which can restore the payment without a passkey prompt", async () => {
      const reply = addressReply();
      const latest = { attempt: reply.attempt, subOrganizationId: reply.subOrganizationId, authorizingCredentialId: reply.authorizingCredentialId, serverNowSeconds: SERVER_NOW };
      const api = server({ prepare: () => jsonResponse(200, { ...reply, authorizingCredentialId: null }), latest: () => jsonResponse(200, latest) });
      const store = await reviewing(ADDRESS);

      await store.getState().confirmAndSend();
      expect(store.getState()).toMatchObject({ status: "editing", prepareNeedsCheck: "uncertain", attempt: null });

      // Review and Approve are refused while the check is required; nothing is sent.
      await store.getState().review();
      await store.getState().confirmAndSend();
      expect(store.getState().status).toBe("editing");
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(api.urls()).toEqual([PREPARE_POST]);

      await store.getState().checkPreparedPayment();

      expect(api.urls()).toEqual([PREPARE_POST, "GET /api/real/payments/latest"]);
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", attempt: { id: UUID }, authorizingCredentialId: reply.authorizingCredentialId, prepareNeedsCheck: null, isAuthorizing: false });
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });

    it("a check that finds no payment releases the requirement, and the next Review and Approve prepare once more", async () => {
      const replies = [{ ...addressReply(), serverNowSeconds: "now" }, addressReply()];
      const api = server({ prepare: () => jsonResponse(200, replies.shift()), latest: () => jsonResponse(200, { attempt: null }) });
      const store = await reviewing(ADDRESS);
      await store.getState().confirmAndSend();
      expect(store.getState().prepareNeedsCheck).toBe("uncertain");

      await store.getState().checkPreparedPayment();
      expect(store.getState()).toMatchObject({ prepareNeedsCheck: null, prepareCheck: "nothing_found" });
      await store.getState().review();
      await store.getState().confirmAndSend();

      expect(api.urls()).toEqual([PREPARE_POST, "GET /api/real/payments/latest", PREPARE_POST]);
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", attempt: { id: UUID } });
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * L-2 D-13: a GET /latest HTTP 200 is acted on — released, classified or
 * adopted — only if isHonestLatestResponse accepts it, at BOTH consumers:
 * init() (reload, and Check again through checkPaymentsAgain) and the D-1
 * checkPreparedPayment(). Honest shapes follow resolveLatestPayment; a
 * rejection takes each consumer's existing failure state (D-3a's
 * status_unavailable, D-1's prepareCheck "unavailable") and changes nothing else.
 */
describe("real-payment-store — L-2 D-13: malformed /latest response recovery", () => {
  const ADDRESS = "0x3333333333333333333333333333333333333333";
  const ACCOUNT_A = { appUserId: "app-user-1", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222" };
  const ACCOUNT_B = { appUserId: "app-user-2", ownerAddress: "0x4444444444444444444444444444444444444444", safeAddress: "0x5555555555555555555555555555555555555555" };
  const UNCERTAIN_BODY = { error: "We couldn't confirm this payment's setup.", code: "prepare_outcome_uncertain" };
  const UNAVAILABLE = { status: "status_unavailable", attempt: null, subOrganizationId: null, authorizingCredentialId: null, pendingSubmission: null, isAttemptPastValidity: false, error: null };
  const TX_HASH = "0x" + "ab".repeat(32);
  const SECRET = "engine-secret";

  type Key = "latest" | "prepare" | "cancel" | "status" | "submit" | "lookup";
  type Handler = (n: number) => Response | Promise<Response>;
  const stores: Array<ReturnType<typeof createRealPaymentStore>> = [];

  beforeEach(() => {
    vi.mocked(signPreparedPayment).mockClear();
    useRealAccountStore.setState({ account: ACCOUNT_A });
  });

  afterEach(() => {
    for (const store of stores.splice(0)) store.getState().reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.mocked(signPreparedPayment).mockClear();
    useRealAccountStore.setState({ account: null });
  });

  /** Every fetch is recorded, including any no handler expects, so "nothing else was requested" covers them all. */
  function server(handlers: Partial<Record<Key, Handler>>) {
    const calls: Array<{ key: Key | "other"; url: string; method: string }> = [];
    const counts: Record<Key, number> = { latest: 0, prepare: 0, cancel: 0, status: 0, submit: 0, lookup: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        const key: Key | null = url.endsWith("/api/real/payments/prepare")
          ? "prepare"
          : url.endsWith("/api/real/payments/latest")
            ? "latest"
            : url.endsWith("/cancel")
              ? "cancel"
              : url.endsWith("/status")
                ? "status"
                : url.endsWith("/api/real/payments/submit")
                  ? "submit"
                  : url.endsWith("/api/real/recipients/lookup")
                    ? "lookup"
                    : null;
        calls.push({ key: key ?? "other", url, method });
        const handler = key ? handlers[key] : undefined;
        if (!key || !handler) throw new Error(`unexpected fetch: ${method} ${url}`);
        counts[key] += 1;
        return handler(counts[key]);
      }),
    );
    return { calls, count: (key: Key) => calls.filter((call) => call.key === key).length, keys: () => calls.map((call) => call.key) };
  }

  function held() {
    let resolve: (response: Response) => void = () => {};
    const promise = new Promise<Response>((res) => (resolve = res));
    return { promise, resolve };
  }

  /** A body JSON cannot carry (undefined, NaN, Infinity): what a runtime mock or a broken proxy could hand the store. */
  function rawResponse(value: unknown): Response {
    return { ok: true, status: 200, headers: new Headers(), json: async () => value } as unknown as Response;
  }

  function newStore() {
    const store = createRealPaymentStore();
    stores.push(store);
    return store;
  }

  const nowSeconds = () => Math.floor(Date.now() / 1000);

  /** A stored row as toPublicAttempt serializes it, per state (a reserved row has no fields; a dispatched one a hash; a failed one a reason). */
  function row(state: string, over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ...baseAttempt(),
      id: stateAttemptId(state),
      state,
      prepared: state === "prepared" ? null : PREPARED_FIELDS,
      transactionHash: state === "submitted" || state === "confirmed" ? TX_HASH : null,
      failureReason: state === "failed" ? "This payment expired before it was included on-chain. No money moved." : null,
      ...over,
    };
  }
  const answer = (body: unknown) => () => jsonResponse(200, body);
  const empty = () => jsonResponse(200, { attempt: null });

  // ---- what the store does with each answer --------------------------------------------------------------------------------

  /** init(): the first read answers `first`; any later read answers "no payment". */
  async function initWith(first: Handler) {
    const api = server({ latest: (n) => (n === 1 ? first(n) : empty()) });
    const store = newStore();
    await store.getState().init();
    return { api, store };
  }

  /** The D-1 state after an unresolved prepare (`reason`), then one explicit check whose /latest answers `first`; later reads `next`. */
  async function checkWith(first: Handler, options: { reason?: "uncertain" | "in_progress"; next?: Handler; others?: Partial<Record<Key, Handler>> } = {}) {
    const prepare: Handler = options.reason === "in_progress" ? () => jsonResponse(409, { error: "You already have a payment in progress." }) : () => jsonResponse(500, UNCERTAIN_BODY);
    const api = server({ prepare, latest: (n) => (n === 1 ? first(n) : (options.next ?? empty)(n)), ...options.others });
    const store = newStore();
    store.setState({ status: "editing" });
    store.getState().setRecipientInput(ADDRESS);
    store.getState().setAmountInput("1");
    await store.getState().review();
    await store.getState().confirmAndSend();
    expect(store.getState()).toMatchObject({ status: "editing", prepareNeedsCheck: options.reason ?? "uncertain" });
    await store.getState().checkPreparedPayment();
    return { api, store };
  }

  // ---- honest answers: the existing behavior, unchanged --------------------------------------------------------------------

  /** Every combination resolveLatestPayment can honestly send, with what a reload shows. */
  const HONEST: Array<[string, () => unknown, string]> = [
    ["reserved prepared/null, no context", () => honestLatestBody(row("prepared")), "stranded"],
    ["awaiting with the bound context and complete fields", () => honestLatestBody(row("awaiting_authorization")), "awaiting_authorization"],
    ["awaiting bound to another passkey (both keys null)", () => honestLatestBody(row("awaiting_authorization"), { bound: false }), "stranded"],
    ["legacy awaiting/null with no context", () => honestLatestBody(row("awaiting_authorization", { prepared: null }), { bound: false }), "stranded"],
    ["signed/object", () => honestLatestBody(row("signed")), "stranded"],
    ["legacy signed/null", () => honestLatestBody(row("signed", { prepared: null })), "stranded"],
    ["submitting", () => honestLatestBody(row("submitting")), "unknown"],
    ["submitted with its hash", () => honestLatestBody(row("submitted")), "submitted"],
    ["legacy submitted/null", () => honestLatestBody(row("submitted", { prepared: null })), "submitted"],
    ["unknown", () => honestLatestBody(row("unknown")), "unknown"],
    ["confirmed", () => honestLatestBody(row("confirmed")), "confirmed"],
    ["failed/null (preparation failed)", () => honestLatestBody(row("failed", { prepared: null, failureReason: "We couldn't prepare this payment." })), "failed"],
    ["failed/object", () => honestLatestBody(row("failed")), "failed"],
    ["cancelled/null (a reserved row cancelled)", () => honestLatestBody(row("cancelled", { prepared: null })), "editing"],
    ["cancelled/object", () => honestLatestBody(row("cancelled")), "editing"],
    ["a handle payment with its stored snapshot", () => honestLatestBody(row("submitted", { recipientIdentity: { handle: "smit", displayName: "Smit Patel" } })), "submitted"],
    ["a mixed-case recipient (tolerated: the route lower-cases, older rows may not)", () => honestLatestBody(row("submitted", { recipient: "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01" })), "submitted"],
    ["a non-strict identity (shown by the address fallback, not validated here)", () => honestLatestBody(row("submitted", { recipientIdentity: { handle: "@Smit", extra: true } })), "submitted"],
    ["a digit-string amount with leading zeros (synthetic; P-6 allows it)", () => honestLatestBody(row("submitted", { amountBaseUnits: "0001000000" })), "submitted"],
    ["extra keys at both levels", () => ({ ...honestLatestBody(row("submitted", { note: "x", createdAt: 7 })), extra: { nested: true } }), "submitted"],
    ["timestamps of any shape (ignored)", () => honestLatestBody(row("submitted", { createdAt: null, updatedAt: undefined })), "submitted"],
  ];
  const TERMINAL_STATUS = new Set(["confirmed", "failed", "editing"]);

  describe("honest answers keep the existing behavior", () => {
    it.each([
      ["{ attempt: null }", { attempt: null }],
      ["{ attempt: null } with both signing keys null", { attempt: null, subOrganizationId: null, authorizingCredentialId: null }],
      ["{ attempt: null } with no clock (none is required)", { attempt: null, subOrganizationId: null }],
      ["{ attempt: null } with a clock and an extra key", { attempt: null, serverNowSeconds: 1_900_000_000, note: "ignored" }],
    ] as const)("init(): %s is the ordinary form", async (_name, body) => {
      const { api, store } = await initWith(answer(body));
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, subOrganizationId: null, authorizingCredentialId: null, error: null });
      expect(api.keys()).toEqual(["latest"]);
    });

    it.each([
      ["{ attempt: null }", { attempt: null }],
      ["{ attempt: null } with both signing keys null", { attempt: null, subOrganizationId: null, authorizingCredentialId: null }],
      ["{ attempt: null } with no clock", { attempt: null, authorizingCredentialId: null }],
    ] as const)("D-1: %s releases the requirement and says no payment is waiting", async (_name, body) => {
      const { api, store } = await checkWith(answer(body));
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, prepareNeedsCheck: null, prepareCheck: "nothing_found", recipientInput: ADDRESS, amountInput: "1" });
      expect(api.keys()).toEqual(["prepare", "latest"]);
    });

    it.each(HONEST)("init(): %s is adopted exactly as before (shown as %s), nothing signed or sent", async (_name, body, shown) => {
      const sent = body() as { attempt: Record<string, unknown>; subOrganizationId: string | null; authorizingCredentialId: string | null };
      const { api, store } = await initWith(answer(sent));
      expect(store.getState()).toMatchObject({ status: shown, subOrganizationId: sent.subOrganizationId, authorizingCredentialId: sent.authorizingCredentialId });
      expect(store.getState().attempt).toEqual(JSON.parse(JSON.stringify(sent.attempt)));
      expect(api.keys()).toEqual(["latest"]);
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });

    it.each(HONEST)("D-1: %s keeps the existing path (terminal: released, not adopted; active: adopted as %s)", async (_name, body, shown) => {
      const sent = body() as { attempt: Record<string, unknown> };
      const { api, store } = await checkWith(answer(sent));
      if (TERMINAL_STATUS.has(shown)) {
        expect(store.getState()).toMatchObject({ status: "editing", attempt: null, prepareNeedsCheck: null, prepareCheck: "nothing_found", recipientInput: ADDRESS, amountInput: "1" });
      } else {
        expect(store.getState()).toMatchObject({ status: shown, prepareNeedsCheck: null, prepareCheck: "idle", attempt: { id: sent.attempt.id } });
      }
      expect(api.keys()).toEqual(["prepare", "latest"]);
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });

    it("a resumed payment offers the existing approval and never prompts by itself; Continue is the user's own action", async () => {
      const { store } = await checkWith(answer(honestLatestBody(row("awaiting_authorization"))));
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", ...SIGNING_CONTEXT, pendingSubmission: null, isAuthorizing: false });
      expect(signPreparedPayment).not.toHaveBeenCalled();
      await store.getState().resumeAuthorization();
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
    });

    it("a recovered payment is the server's, not the draft: another recipient and amount are adopted as sent", async () => {
      const other = row("signed", { recipient: "0x9999999999999999999999999999999999999999", amountBaseUnits: "7000000" });
      const { store } = await checkWith(answer(honestLatestBody(other)));
      expect(store.getState().attempt).toMatchObject({ recipient: "0x9999999999999999999999999999999999999999", amountBaseUnits: "7000000" });
      expect(store.getState()).toMatchObject({ recipientInput: ADDRESS, amountInput: "1" });
    });
  });

  // ---- malformed answers -----------------------------------------------------------------------------------------------------

  const withAttempt = (over: Record<string, unknown>, base = row("submitted")) => () => jsonResponse(200, { ...honestLatestBody(base), attempt: { ...base, ...over } });
  const without = (key: string, base = row("submitted")) => () => {
    const attempt = { ...base };
    delete attempt[key];
    return jsonResponse(200, { ...honestLatestBody(base), attempt });
  };
  const withTop = (over: Record<string, unknown>, base = row("submitted")) => () => jsonResponse(200, { ...honestLatestBody(base), ...over });
  const withoutTop = (key: string, base = row("submitted")) => () => {
    const body: Record<string, unknown> = { ...honestLatestBody(base) };
    delete body[key];
    return jsonResponse(200, body);
  };
  const awaiting = () => row("awaiting_authorization");
  const preparedWith = (over: Record<string, unknown>) => withAttempt({ prepared: { ...PREPARED_FIELDS, ...over } }, awaiting());
  const preparedWithout = (key: string) => () => {
    const prepared: Record<string, unknown> = { ...PREPARED_FIELDS };
    delete prepared[key];
    return jsonResponse(200, { ...honestLatestBody(awaiting()), attempt: { ...awaiting(), prepared } });
  };

  const MALFORMED: Array<[string, Handler]> = [
    // Top level
    ["a JSON null body", answer(null)],
    ["a number body", answer(7)],
    ["a string body", answer("attempt")],
    ["a boolean body", answer(true)],
    ["an array body", answer([honestLatestBody(row("submitted"))])],
    ["an empty object", answer({})],
    ["no attempt key (signing keys null, a clock)", answer({ ...NO_SIGNING_CONTEXT, serverNowSeconds: 1_900_000_000 })],
    ["no attempt key but a signing context", answer({ ...SIGNING_CONTEXT, serverNowSeconds: 1_900_000_000 })],
    ["attempt undefined (a runtime mock)", () => rawResponse({ attempt: undefined, ...NO_SIGNING_CONTEXT, serverNowSeconds: 1_900_000_000 })],
    ["attempt false", answer({ attempt: false, ...NO_SIGNING_CONTEXT, serverNowSeconds: 1_900_000_000 })],
    ["attempt 0", answer({ attempt: 0, ...NO_SIGNING_CONTEXT, serverNowSeconds: 1_900_000_000 })],
    ["attempt an empty string", answer({ attempt: "", ...NO_SIGNING_CONTEXT, serverNowSeconds: 1_900_000_000 })],
    ["attempt a string", answer({ attempt: stateAttemptId("submitted"), ...NO_SIGNING_CONTEXT, serverNowSeconds: 1_900_000_000 })],
    ["attempt an array", answer({ attempt: [row("submitted")], ...NO_SIGNING_CONTEXT, serverNowSeconds: 1_900_000_000 })],
    ["a body that is not JSON", () => new Response("<html>engine-secret</html>", { status: 200 })],
    ["an empty body", () => new Response("", { status: 200 })],
    // Identity
    ["no id", without("id")],
    ["a numeric id", withAttempt({ id: 12 })],
    ["an object id", withAttempt({ id: { id: ATTEMPT_ID } })],
    ["a placeholder id", withAttempt({ id: "attempt-1" })],
    ["an empty id", withAttempt({ id: "" })],
    ["a path-like id", withAttempt({ id: "../../account/passkeys" })],
    ["a UUID with a path appended", withAttempt({ id: `${ATTEMPT_ID}/../cancel` })],
    ["a UUID with a leading space", withAttempt({ id: ` ${ATTEMPT_ID}` })],
    ["a UUID without hyphens", withAttempt({ id: ATTEMPT_ID.replace(/-/g, "") })],
    ["the nil UUID (no version)", withAttempt({ id: "00000000-0000-0000-0000-000000000000" })],
    ["no state", without("state")],
    ["an unknown state", withAttempt({ state: "refunded-by-bank" })],
    ["a state in the wrong case", withAttempt({ state: "SUBMITTED" })],
    ["a numeric state", withAttempt({ state: 3 })],
    ["no recipient", without("recipient")],
    ["a null recipient", withAttempt({ recipient: null })],
    ["a short recipient", withAttempt({ recipient: "0x123" })],
    ["a recipient with 41 hex digits", withAttempt({ recipient: "0x" + "2".repeat(41) })],
    ["a recipient without 0x", withAttempt({ recipient: "2".repeat(40) })],
    ["a recipient with a leading space", withAttempt({ recipient: " 0x" + "2".repeat(40) })],
    ["a recipient with non-hex digits", withAttempt({ recipient: "0x" + "z".repeat(40) })],
    ["a handle as the recipient", withAttempt({ recipient: "@smit" })],
    ["a numeric recipient", withAttempt({ recipient: 2 })],
    ["no amount", without("amountBaseUnits")],
    ["a numeric amount", withAttempt({ amountBaseUnits: 1000000 })],
    ["an empty amount", withAttempt({ amountBaseUnits: "" })],
    ["a decimal amount", withAttempt({ amountBaseUnits: "1.5" })],
    ["a negative amount", withAttempt({ amountBaseUnits: "-1" })],
    ["an exponent amount", withAttempt({ amountBaseUnits: "1e6" })],
    ["an amount with a space", withAttempt({ amountBaseUnits: " 1000000" })],
    ["an amount in non-ASCII digits", withAttempt({ amountBaseUnits: "１００" })],
    // Supporting fields
    ["no transactionHash", without("transactionHash")],
    ["a numeric transactionHash", withAttempt({ transactionHash: 7 })],
    ["an object transactionHash", withAttempt({ transactionHash: { hash: TX_HASH } })],
    ["no failureReason", without("failureReason")],
    ["an object failureReason", withAttempt({ failureReason: { raw: SECRET } }, row("failed"))],
    ["a boolean failureReason", withAttempt({ failureReason: false }, row("failed"))],
    ["no clock on a payment", withoutTop("serverNowSeconds")],
    ["a null clock", withTop({ serverNowSeconds: null })],
    ["a string clock", withTop({ serverNowSeconds: "1900000000" })],
    ["a NaN clock (runtime)", () => rawResponse({ ...honestLatestBody(row("submitted")), serverNowSeconds: Number.NaN })],
    ["an infinite clock (runtime)", () => rawResponse({ ...honestLatestBody(row("submitted")), serverNowSeconds: Number.POSITIVE_INFINITY })],
    // prepared
    ["no prepared", without("prepared")],
    ["a string prepared", withAttempt({ prepared: "0x" })],
    ["a numeric prepared", withAttempt({ prepared: 1 })],
    ["a boolean prepared", withAttempt({ prepared: true })],
    ["an array prepared", withAttempt({ prepared: [PREPARED_FIELDS] })],
    ["a reserved row carrying prepared fields", withAttempt({ prepared: PREPARED_FIELDS }, row("prepared"))],
    ["a reserved row carrying an empty object", withAttempt({ prepared: {} }, row("prepared"))],
    ["a signing-capable answer with null prepared", withAttempt({ prepared: null }, awaiting())],
    ["a signing-capable answer with an empty prepared", withAttempt({ prepared: {} }, awaiting())],
    ["a signing-capable answer missing paymaster", preparedWithout("paymaster")],
    ["a signing-capable answer missing factoryData", preparedWithout("factoryData")],
    ["a signing-capable answer missing paymasterPostOpGasLimit", preparedWithout("paymasterPostOpGasLimit")],
    ["a signing-capable answer missing validUntil", preparedWithout("validUntil")],
    ["a signing-capable answer with a short sender", preparedWith({ sender: "0x1111" })],
    ["a signing-capable answer with a bad factory", preparedWith({ factory: "0xnope" })],
    ["a signing-capable answer with half-byte callData", preparedWith({ callData: "0x123" })],
    ["a signing-capable answer with non-hex paymasterData", preparedWith({ paymasterData: "0xzz" })],
    ["a signing-capable answer with a decimal nonce", preparedWith({ nonce: "1.0" })],
    ["a signing-capable answer with a numeric gas limit", preparedWith({ callGasLimit: 100000 })],
    ["a signing-capable answer with a hex fee", preparedWith({ maxFeePerGas: "0x1" })],
    ["a signing-capable answer with a string validUntil", preparedWith({ validUntil: "1900000600" })],
    ["a signing-capable answer with validUntil 0", preparedWith({ validUntil: 0 })],
    ["a signing-capable answer with a fractional validUntil", preparedWith({ validUntil: 1_900_000_600.5 })],
    ["a signing-capable answer with a negative validUntil", preparedWith({ validUntil: -1 })],
    // Signing context
    ["a payment with no subOrganizationId key", withoutTop("subOrganizationId")],
    ["a payment with no authorizingCredentialId key", withoutTop("authorizingCredentialId")],
    ["a payment with neither signing key", () => jsonResponse(200, { attempt: row("submitted"), serverNowSeconds: 1_900_000_000 })],
    ["awaiting with only subOrganizationId set", withTop({ authorizingCredentialId: null }, awaiting())],
    ["awaiting with only authorizingCredentialId set", withTop({ subOrganizationId: null }, awaiting())],
    ["awaiting with an empty subOrganizationId", withTop({ subOrganizationId: "" }, awaiting())],
    ["awaiting with an empty authorizingCredentialId", withTop({ authorizingCredentialId: "" }, awaiting())],
    ["awaiting with both signing keys empty", withTop({ subOrganizationId: "", authorizingCredentialId: "" }, awaiting())],
    ["awaiting with a numeric subOrganizationId", withTop({ subOrganizationId: 1 }, awaiting())],
    ["awaiting with an array authorizingCredentialId", withTop({ authorizingCredentialId: ["credential-1"] }, awaiting())],
    ["awaiting with an object authorizingCredentialId", withTop({ authorizingCredentialId: { id: "credential-1" } }, awaiting())],
    ["a signed row with a signing context", withTop(SIGNING_CONTEXT, row("signed"))],
    ["a reserved row with a signing context", withTop(SIGNING_CONTEXT, row("prepared"))],
    ["a submitted row with a signing context", withTop(SIGNING_CONTEXT, row("submitted"))],
    ["an unknown row with a signing context", withTop(SIGNING_CONTEXT, row("unknown"))],
    // Empty answers that are not empty
    ["attempt: null with a subOrganizationId", answer({ attempt: null, subOrganizationId: "sub-org-1" })],
    ["attempt: null with an authorizingCredentialId", answer({ attempt: null, authorizingCredentialId: "credential-1" })],
    ["attempt: null with a full signing context", answer({ attempt: null, ...SIGNING_CONTEXT, serverNowSeconds: 1_900_000_000 })],
    ["attempt: null with an empty-string credential", answer({ attempt: null, subOrganizationId: null, authorizingCredentialId: "" })],
    ["attempt: null with a numeric subOrganizationId", answer({ attempt: null, subOrganizationId: 0 })],
    ["attempt: null with an undefined signing key (runtime)", () => rawResponse({ attempt: null, subOrganizationId: undefined })],
    // Terminal-looking answers that are malformed
    ["a confirmed row with a placeholder id", withAttempt({ id: "attempt-1" }, row("confirmed"))],
    ["a confirmed row with a signing context", withTop(SIGNING_CONTEXT, row("confirmed"))],
    ["a confirmed row with a numeric hash", withAttempt({ transactionHash: 1 }, row("confirmed"))],
    ["a confirmed row with no clock", withoutTop("serverNowSeconds", row("confirmed"))],
    ["a failed row with no prepared", without("prepared", row("failed"))],
    ["a failed row with a bad amount", withAttempt({ amountBaseUnits: "lots" }, row("failed"))],
    ["a cancelled row with a bad recipient", withAttempt({ recipient: "0x0" }, row("cancelled"))],
    ["a cancelled row with no failureReason", without("failureReason", row("cancelled"))],
    ["a cancelled row with a signing context", withTop(SIGNING_CONTEXT, row("cancelled"))],
  ];

  describe("init(): a malformed answer is 'status_unavailable', never a payment and never 'no payment'", () => {
    it.each(MALFORMED)("%s: unavailable, nothing adopted, nothing scheduled, one GET — then Check again recovers", async (_name, malformed) => {
      vi.useFakeTimers();
      const { api, store } = await initWith(malformed);

      expect(store.getState()).toMatchObject({ ...UNAVAILABLE, prepareNeedsCheck: null, prepareCheck: "idle", clockOffsetSeconds: 0 });
      expect(JSON.stringify(store.getState())).not.toMatch(/engine-secret|sub-org-1|credential-1|attempt-1/);
      expect(vi.getTimerCount()).toBe(0);
      // Review (so no prepare) is refused in the store, and nothing happens by itself.
      store.getState().setRecipientInput(ADDRESS);
      store.getState().setAmountInput("1");
      await store.getState().review();
      await store.getState().confirmAndSend();
      expect(store.getState().status).toBe("status_unavailable");
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(api.keys()).toEqual(["latest"]);
      expect(signPreparedPayment).not.toHaveBeenCalled();

      // The user's explicit Check again is the next — single — read, and an honest answer recovers.
      await store.getState().checkPaymentsAgain();
      expect(api.keys()).toEqual(["latest", "latest"]);
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, error: null });
    });

    it("Check again after a malformed answer restores an honest payment with the existing mapping and signing context", async () => {
      const api = server({ latest: (n) => (n === 1 ? withTop(SIGNING_CONTEXT, row("signed"))() : jsonResponse(200, honestLatestBody(row("awaiting_authorization")))) });
      const store = newStore();
      await store.getState().init();
      expect(store.getState()).toMatchObject(UNAVAILABLE);
      await store.getState().checkPaymentsAgain();
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", attempt: { id: stateAttemptId("awaiting_authorization") }, ...SIGNING_CONTEXT, error: null });
      expect(api.keys()).toEqual(["latest", "latest"]);
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });

    it("a malformed answer does not replace the state of a payment the page already restored when the lifecycle is new (each init is its own)", async () => {
      const api = server({ latest: (n) => (n === 1 ? jsonResponse(200, honestLatestBody(row("submitted"))) : withAttempt({ id: "attempt-1" })()) });
      const store = newStore();
      await store.getState().init();
      expect(store.getState()).toMatchObject({ status: "submitted", attempt: { id: stateAttemptId("submitted") } });
      // A new lifecycle reads again and gets a malformed answer: it says "we couldn't check", and keeps nothing of the old one.
      await store.getState().init();
      expect(store.getState()).toMatchObject(UNAVAILABLE);
      expect(api.keys()).toEqual(["latest", "latest"]);
    });
  });

  describe("D-1: a malformed answer keeps the requirement — never 'no payment', never an adoption", () => {
    it.each(MALFORMED)("%s: still required, draft and error kept, nothing adopted or sent; a later explicit check can succeed", async (_name, malformed) => {
      vi.useFakeTimers();
      const api = server({ prepare: () => jsonResponse(500, UNCERTAIN_BODY), latest: (n) => (n === 1 ? malformed(n) : empty()) });
      const store = newStore();
      store.setState({ status: "editing" });
      store.getState().setRecipientInput(ADDRESS);
      store.getState().setAmountInput("1");
      await store.getState().review();
      await store.getState().confirmAndSend();
      store.setState({ error: "an earlier message" });
      const before = store.getState();

      await store.getState().checkPreparedPayment();

      expect(store.getState()).toMatchObject({
        status: "editing",
        prepareNeedsCheck: "uncertain",
        prepareCheck: "unavailable",
        recipientInput: ADDRESS,
        amountInput: "1",
        recipientLookup: before.recipientLookup,
        error: "an earlier message",
        attempt: null,
        subOrganizationId: null,
        authorizingCredentialId: null,
        pendingSubmission: null,
        clockOffsetSeconds: before.clockOffsetSeconds,
      });
      expect(JSON.stringify(store.getState())).not.toMatch(/engine-secret|sub-org-1|credential-1/);
      // The check's own deadline timer is gone; nothing else was armed.
      expect(vi.getTimerCount()).toBe(0);
      // Review stays refused; nothing is prepared, signed, cancelled or re-read by itself.
      await store.getState().review();
      store.setState({ status: "reviewing" });
      await store.getState().confirmAndSend();
      store.setState({ status: "editing" });
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(api.keys()).toEqual(["prepare", "latest"]);
      expect(signPreparedPayment).not.toHaveBeenCalled();

      // The slot was released normally: the next explicit check is one more GET, and an honest "none" releases.
      await store.getState().checkPreparedPayment();
      expect(api.keys()).toEqual(["prepare", "latest", "latest"]);
      expect(store.getState()).toMatchObject({ prepareNeedsCheck: null, prepareCheck: "nothing_found" });
    });

    it.each(["uncertain", "in_progress"] as const)("after a %s prepare the reason is kept exactly, and the copy stays the existing failed-check line", async (reason) => {
      const { store } = await checkWith(withTop(SIGNING_CONTEXT, row("submitted")), { reason });
      expect(store.getState()).toMatchObject({ status: "editing", prepareNeedsCheck: reason, prepareCheck: "unavailable", attempt: null });
      const { PREPARE_CHECK_FAILED_MESSAGE } = await import("@/lib/stores/real-payment-store");
      expect(PREPARE_CHECK_FAILED_MESSAGE).toBe("We couldn't check right now. Try again in a moment.");
    });

    it.each([
      ["a malformed confirmed row", withTop(SIGNING_CONTEXT, row("confirmed"))],
      ["a malformed failed row", without("prepared", row("failed"))],
      ["a malformed cancelled row", withAttempt({ recipient: "0x0" }, row("cancelled"))],
    ] as const)("%s does not release the requirement, although an honest terminal row would", async (_name, malformed) => {
      const { store } = await checkWith(malformed);
      expect(store.getState()).toMatchObject({ prepareNeedsCheck: "uncertain", prepareCheck: "unavailable" });
      expect(store.getState().prepareCheck).not.toBe("nothing_found");
    });

    describe.each(["uncertain", "in_progress"] as const)("after a %s prepare and a malformed check, an explicit re-check", (reason) => {
      const MALFORMED_FIRST = withAttempt({ id: "attempt-1" }, row("signed"));

      it("A — an honest 'none': released; Review and a deliberate new prepare are allowed again", async () => {
        const { api, store } = await checkWith(MALFORMED_FIRST, { reason, next: empty });
        expect(store.getState()).toMatchObject({ prepareNeedsCheck: reason, prepareCheck: "unavailable" });
        await store.getState().checkPreparedPayment();
        expect(store.getState()).toMatchObject({ prepareNeedsCheck: null, prepareCheck: "nothing_found", recipientInput: ADDRESS, amountInput: "1" });
        await store.getState().review();
        expect(store.getState().status).toBe("reviewing");
        await store.getState().confirmAndSend();
        expect(api.count("prepare")).toBe(2);
      });

      it("B — an honest active payment: adopted through the existing flow, with its signing context, and nothing signed", async () => {
        const { api, store } = await checkWith(MALFORMED_FIRST, { reason, next: answer(honestLatestBody(row("awaiting_authorization"))) });
        await store.getState().checkPreparedPayment();
        expect(store.getState()).toMatchObject({ status: "awaiting_authorization", prepareNeedsCheck: null, prepareCheck: "idle", attempt: { id: stateAttemptId("awaiting_authorization") }, ...SIGNING_CONTEXT });
        expect(api.keys()).toEqual(["prepare", "latest", "latest"]);
        expect(signPreparedPayment).not.toHaveBeenCalled();
      });

      it("C — an honest terminal payment: released under the existing policy, not adopted", async () => {
        const { store } = await checkWith(MALFORMED_FIRST, { reason, next: answer(honestLatestBody(row("confirmed"))) });
        await store.getState().checkPreparedPayment();
        expect(store.getState()).toMatchObject({ status: "editing", attempt: null, prepareNeedsCheck: null, prepareCheck: "nothing_found" });
      });
    });

    it("the whole flow: a malformed prepare (D-12) -> D-1 -> a malformed /latest keeps it -> an explicit re-check recovers the payment, unsigned", async () => {
      const preparedRow = row("awaiting_authorization", { recipient: ADDRESS });
      const api = server({
        // D-12: honest in every respect but the missing credential — not adopted, not signed.
        prepare: () => jsonResponse(200, { attempt: { ...preparedRow, id: PREPARED_ID }, subOrganizationId: "sub-org-1", serverNowSeconds: nowSeconds() }),
        latest: (n) => (n === 1 ? withTop({ authorizingCredentialId: null }, preparedRow)() : jsonResponse(200, honestLatestBody({ ...preparedRow, id: PREPARED_ID }))),
      });
      const store = newStore();
      store.setState({ status: "editing" });
      store.getState().setRecipientInput(ADDRESS);
      store.getState().setAmountInput("1");
      await store.getState().review();
      await store.getState().confirmAndSend();
      expect(store.getState()).toMatchObject({ status: "editing", prepareNeedsCheck: "uncertain", attempt: null });

      await store.getState().checkPreparedPayment();
      expect(store.getState()).toMatchObject({ status: "editing", prepareNeedsCheck: "uncertain", prepareCheck: "unavailable", attempt: null, authorizingCredentialId: null });

      await store.getState().checkPreparedPayment();
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", prepareNeedsCheck: null, attempt: { id: PREPARED_ID }, ...SIGNING_CONTEXT });
      expect(api.keys()).toEqual(["prepare", "latest", "latest"]);
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });

    it("a rejected check moves no freshness epoch: a status read already on its way for the payment on the page still applies", async () => {
      const status = held();
      const check = held();
      const api = server({ latest: () => check.promise, status: () => status.promise });
      const store = newStore();
      store.setState({ status: "unknown", attempt: row("unknown") as never });
      const read = store.getState().checkStatus();
      await vi.waitFor(() => expect(api.count("status")).toBe(1));
      store.setState({ status: "editing", prepareNeedsCheck: "uncertain" });
      const discovery = store.getState().checkPreparedPayment();
      check.resolve(withTop(SIGNING_CONTEXT, row("unknown"))());
      await discovery;
      expect(store.getState()).toMatchObject({ status: "editing", prepareNeedsCheck: "uncertain", prepareCheck: "unavailable" });
      // The read that began before the rejected check is not stale because of it (no markTransition on rejection).
      status.resolve(jsonResponse(200, { attempt: row("unknown", { state: "submitted", transactionHash: TX_HASH }), serverNowSeconds: nowSeconds() }));
      await read;
      expect(store.getState()).toMatchObject({ status: "submitted", attempt: { id: stateAttemptId("unknown"), state: "submitted" } });
    });

    it("a check that never answers still ends at the existing deadline with the requirement kept", async () => {
      vi.useFakeTimers();
      const api = server({ prepare: () => jsonResponse(500, UNCERTAIN_BODY), latest: () => new Promise<Response>(() => {}) });
      const store = newStore();
      store.setState({ status: "editing" });
      store.getState().setRecipientInput(ADDRESS);
      store.getState().setAmountInput("1");
      await store.getState().review();
      await store.getState().confirmAndSend();
      const pending = store.getState().checkPreparedPayment();
      await vi.advanceTimersByTimeAsync(STATUS_REQUEST_DEADLINE_MS - 1);
      expect(store.getState().prepareCheck).toBe("checking");
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(store.getState()).toMatchObject({ prepareNeedsCheck: "uncertain", prepareCheck: "unavailable" });
      expect(api.keys()).toEqual(["prepare", "latest"]);
    });
  });

  // ---- lifecycle: a stale answer, honest or malformed, never reaches a newer context ----------------------------------------

  describe("stale answers never reach a newer lifecycle", () => {
    const STALE: Array<[string, () => Response]> = [
      ["an honest payment", () => jsonResponse(200, honestLatestBody(row("awaiting_authorization")))],
      ["an honest 'none'", () => jsonResponse(200, { attempt: null })],
      ["a malformed payment", () => withTop(SIGNING_CONTEXT, row("signed"))()],
      ["a malformed body", () => jsonResponse(200, [])],
    ];

    it.each(STALE)("init(): %s from the first read after reset() changes nothing", async (_name, late) => {
      const gate = held();
      server({ latest: () => gate.promise });
      const store = newStore();
      const pending = store.getState().init();
      store.getState().reset();
      gate.resolve(late());
      await pending;
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, subOrganizationId: null, authorizingCredentialId: null, error: null });
    });

    it.each(STALE)("init(): %s from account A's read after account B's own read applies nothing of A", async (_name, late) => {
      const gate = held();
      server({ latest: (n) => (n === 1 ? gate.promise : jsonResponse(200, honestLatestBody(row("submitted", { id: ACCOUNT_B_ATTEMPT_ID })))) });
      const store = newStore();
      const first = store.getState().init();
      useRealAccountStore.setState({ account: ACCOUNT_B });
      await store.getState().init();
      const before = store.getState();
      expect(before).toMatchObject({ status: "submitted", attempt: { id: ACCOUNT_B_ATTEMPT_ID } });
      gate.resolve(late());
      await first;
      expect(store.getState()).toMatchObject({ status: before.status, attempt: before.attempt, subOrganizationId: null, authorizingCredentialId: null, clockOffsetSeconds: before.clockOffsetSeconds, error: null });
    });

    it.each(STALE)("init(): %s from a read made before a remount (detach, init) applies nothing", async (_name, late) => {
      const gate = held();
      server({ latest: (n) => (n === 1 ? gate.promise : jsonResponse(200, { attempt: null })) });
      const store = newStore();
      const first = store.getState().init();
      store.getState().detach();
      await store.getState().init();
      expect(store.getState().status).toBe("editing");
      gate.resolve(late());
      await first;
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, authorizingCredentialId: null });
    });

    it.each(STALE)("init(): %s after the 45-second deadline is dropped; the deadline's own unavailable state stays", async (_name, late) => {
      vi.useFakeTimers();
      const gate = held();
      const api = server({ latest: () => gate.promise });
      const store = newStore();
      const pending = store.getState().init();
      await vi.advanceTimersByTimeAsync(STATUS_REQUEST_DEADLINE_MS);
      await pending;
      expect(store.getState()).toMatchObject(UNAVAILABLE);
      gate.resolve(late());
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getState()).toMatchObject(UNAVAILABLE);
      expect(api.keys()).toEqual(["latest"]);
    });

    it("init(): the deadline is unchanged — a malformed answer just before it is still 'unavailable', with no timer left", async () => {
      vi.useFakeTimers();
      const gate = held();
      server({ latest: () => gate.promise });
      const store = newStore();
      const pending = store.getState().init();
      await vi.advanceTimersByTimeAsync(STATUS_REQUEST_DEADLINE_MS - 1);
      expect(store.getState().status).toBe("idle");
      gate.resolve(withAttempt({ id: "attempt-1" })());
      await pending;
      expect(store.getState()).toMatchObject(UNAVAILABLE);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
      ["a malformed payment", () => ({ ...honestLatestBody(row("signed")), ...SIGNING_CONTEXT })],
      ["an honest payment", () => honestLatestBody(row("awaiting_authorization"))],
    ] as const)("init(): no await between the guard and the decision — a reset queued right behind the body read (%s) finds it already decided", async (_name, value) => {
      const store = newStore();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          status: 200,
          headers: new Headers(),
          // This reaction is registered before init()'s own await on the body, so the reset runs right after init's continuation.
          json: () => {
            const body = Promise.resolve(value());
            void body.then(() => queueMicrotask(() => store.getState().reset()));
            return body;
          },
        })),
      );
      await store.getState().init();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      // The answer was applied (or refused) under its own lifecycle; the reset came after it and is what remains.
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, subOrganizationId: null, authorizingCredentialId: null });
    });

    it("init(): an older read answering malformed after a newer init restored a payment cannot overwrite it", async () => {
      const gate = held();
      server({ latest: (n) => (n === 1 ? gate.promise : jsonResponse(200, honestLatestBody(row("awaiting_authorization")))) });
      const store = newStore();
      const first = store.getState().init();
      await store.getState().init();
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", ...SIGNING_CONTEXT });
      gate.resolve(jsonResponse(200, null));
      await first;
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", attempt: { id: stateAttemptId("awaiting_authorization") }, ...SIGNING_CONTEXT, error: null });
    });

    /** A D-1 check left on its way, and the store it belongs to. */
    async function pendingCheck() {
      const gate = held();
      const api = server({ prepare: () => jsonResponse(500, UNCERTAIN_BODY), latest: (n) => (n === 1 ? gate.promise : jsonResponse(200, { attempt: null })) });
      const store = newStore();
      store.setState({ status: "editing" });
      store.getState().setRecipientInput(ADDRESS);
      store.getState().setAmountInput("1");
      await store.getState().review();
      await store.getState().confirmAndSend();
      const pending = store.getState().checkPreparedPayment();
      expect(store.getState().prepareCheck).toBe("checking");
      return { api, store, pending, gate };
    }

    it.each(STALE)("D-1: %s after reset() sets nothing, and restores no requirement", async (_name, late) => {
      const { store, pending, gate } = await pendingCheck();
      store.getState().reset();
      gate.resolve(late());
      await pending;
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, prepareNeedsCheck: null, prepareCheck: "idle", authorizingCredentialId: null });
    });

    it.each(STALE)("D-1: %s after an account switch is not applied at all", async (_name, late) => {
      const { store, pending, gate } = await pendingCheck();
      useRealAccountStore.setState({ account: ACCOUNT_B });
      gate.resolve(late());
      await pending;
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, prepareNeedsCheck: "uncertain", prepareCheck: "checking", authorizingCredentialId: null });
    });

    it.each(STALE)("D-1: %s after detach() is not applied", async (_name, late) => {
      const { store, pending, gate } = await pendingCheck();
      store.getState().detach();
      gate.resolve(late());
      await pending;
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, prepareNeedsCheck: "uncertain", authorizingCredentialId: null });
      expect(store.getState().prepareCheck).not.toBe("unavailable");
    });

    it.each(STALE)("D-1: %s after a remount whose own read found nothing restores nothing", async (_name, late) => {
      const { store, pending, gate } = await pendingCheck();
      store.getState().detach();
      await store.getState().init();
      expect(store.getState()).toMatchObject({ status: "editing", prepareNeedsCheck: null, prepareCheck: "idle" });
      gate.resolve(late());
      await pending;
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, prepareNeedsCheck: null, prepareCheck: "idle", authorizingCredentialId: null });
    });

    it.each(STALE)("D-1: %s after a NEWER recovery lifecycle (reset, a new unresolved prepare) leaves the newer check's state alone", async (_name, late) => {
      const { api, store, pending, gate } = await pendingCheck();
      store.getState().reset();
      store.getState().setRecipientInput(ADDRESS);
      store.getState().setAmountInput("2");
      await store.getState().review();
      await store.getState().confirmAndSend();
      expect(store.getState()).toMatchObject({ prepareNeedsCheck: "uncertain", prepareCheck: "idle" });
      gate.resolve(late());
      await pending;
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, prepareNeedsCheck: "uncertain", prepareCheck: "idle", amountInput: "2", authorizingCredentialId: null });
      // The newer lifecycle's slot was not released or taken by the old answer: its own check is one GET.
      await store.getState().checkPreparedPayment();
      expect(api.count("latest")).toBe(2);
      expect(store.getState()).toMatchObject({ prepareNeedsCheck: null, prepareCheck: "nothing_found" });
    });

    it.each(STALE)("D-1: %s after the check's own 45-second deadline is dropped", async (_name, late) => {
      vi.useFakeTimers();
      const { api, store, pending, gate } = await pendingCheck();
      await vi.advanceTimersByTimeAsync(STATUS_REQUEST_DEADLINE_MS);
      await pending;
      expect(store.getState()).toMatchObject({ prepareNeedsCheck: "uncertain", prepareCheck: "unavailable" });
      gate.resolve(late());
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, prepareNeedsCheck: "uncertain", prepareCheck: "unavailable", authorizingCredentialId: null });
      expect(api.keys()).toEqual(["prepare", "latest"]);
    });
  });
});

/**
 * L-1b — the store's half of client Pay signing content binding.
 *
 * signPreparedPayment (mocked here) now requires the held payment's own intent
 * and refuses, before any passkey prompt, prepared callData that is not exactly
 * that Cash transfer (proven against the real signer in
 * test/lib/real/client-sign-content.test.ts). These tests prove the store side:
 *  - every new signature request carries `expected` = the recipient and amount
 *    of the SAME held attempt object whose `prepared` is signed — never the
 *    live form, a lookup, or a newer value (fresh address / handle prepare,
 *    /latest resume, retry after a dismissed prompt, and after a D-10 status
 *    answer replaced the prepared object);
 *  - an L-1b refusal is handled by the existing non-cancellation signing-error
 *    path: the payment, its signing context and its controls stay; nothing is
 *    prepared, submitted, read, cancelled or re-signed by itself.
 * A mocked rejection proves only the store's handling of the refusal — not that
 * the real signer refuses (that is the helper suite's job).
 *
 * Where a live input differs from the held attempt only because a test called
 * setRecipientInput / setAmountInput directly (the form hides those fields on
 * these screens), the test says so; the store accepts those calls in any status.
 */
describe("real-payment-store — L-1b: every new signature carries the held attempt's own intent", () => {
  const L1B_MESSAGE = "We couldn't verify this payment's details. You can cancel it.";
  const ACCOUNT = { appUserId: "app-user-l1b", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222" };
  const ADDRESS = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
  const CHECKSUMMED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
  const OTHER = "0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359";
  const SMIT_SAFE = "0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae";
  const FOUND_SMIT = { found: true, handle: "smit", displayName: "Smit Patel", isSelf: false };
  const SERVER_NOW = 1_900_000_000;
  const T0_MS = (SERVER_NOW - 100) * 1000;
  const SUB_ORG = "4f8d1c2b-9a3e-4b7f-8c6d-1e2f3a4b5c6d";
  const CREDENTIAL = "Zm9vYmFyLWNyZWRlbnRpYWwtaWQ";
  const DISMISSED = () => Object.assign(new Error("dismissed"), { name: "NotAllowedError" });

  type Json = Record<string, unknown>;
  type Store = ReturnType<typeof createRealPaymentStore>;
  type SignInput = { fields: unknown; expected: unknown; subOrganizationId: unknown; authorizingCredentialId: unknown };

  const fields = (callData = "0x541d63c8000000000000000000000000036cbd53842c5426634e7929541ec2318f3dcf7e"): Json => ({
    sender: ACCOUNT.safeAddress,
    nonce: "1844674407370955161600",
    factory: null,
    factoryData: null,
    callData,
    callGasLimit: "86143",
    verificationGasLimit: "120371",
    preVerificationGas: "55264",
    maxFeePerGas: "1200000",
    maxPriorityFeePerGas: "1000000",
    paymaster: "0x777777777777AeC03fd955926DbF81597e66834C",
    paymasterData: "0x01000066d1a1a4000000000000",
    paymasterVerificationGasLimit: "37193",
    paymasterPostOpGasLimit: "1",
    validUntil: SERVER_NOW + 600,
  });
  const attemptOf = (over: Json = {}): Json => ({
    id: PREPARED_ID,
    state: "awaiting_authorization",
    recipient: ADDRESS,
    recipientIdentity: null,
    amountBaseUnits: "1000000",
    transactionHash: null,
    failureReason: null,
    createdAt: "2030-03-17T17:46:40.000Z",
    updatedAt: "2030-03-17T17:46:41.000Z",
    prepared: fields(),
    ...over,
  });
  const signingReply = (attempt: Json) => ({ attempt, subOrganizationId: SUB_ORG, authorizingCredentialId: CREDENTIAL, serverNowSeconds: SERVER_NOW });

  const stores: Store[] = [];
  /** Each signing request, with the attempt the store held at that moment. */
  let seen: Array<{ input: SignInput; held: RealPaymentAttemptLike | null }>;
  type RealPaymentAttemptLike = { recipient: string; amountBaseUnits: string; prepared: unknown };

  function newStore(): Store {
    const store = createRealPaymentStore();
    stores.push(store);
    return store;
  }
  /** Records each request (and the held attempt at that moment), then answers with `outcome` (default: the prompt is dismissed). */
  function signing(store: () => Store, outcome: () => Promise<unknown> = () => Promise.reject(DISMISSED())) {
    vi.mocked(signPreparedPayment).mockImplementation(((input: SignInput) => {
      seen.push({ input, held: store().getState().attempt as unknown as RealPaymentAttemptLike | null });
      return outcome();
    }) as never);
  }

  type Handler = (body: unknown) => Response | Promise<Response>;
  function server(handlers: Partial<Record<"prepare" | "latest" | "lookup" | "status" | "cancel" | "submit" | "balance", Handler>>) {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push(`${method} ${url}`);
        const key = url.endsWith("/prepare")
          ? "prepare"
          : url.endsWith("/latest")
            ? "latest"
            : url.endsWith("/recipients/lookup")
              ? "lookup"
              : url.endsWith("/status")
                ? "status"
                : url.endsWith("/cancel")
                  ? "cancel"
                  : url.endsWith("/submit")
                    ? "submit"
                    : url.endsWith("/account/balance")
                      ? "balance"
                      : null;
        const handler = key ? handlers[key] : undefined;
        if (!handler) throw new Error(`unexpected fetch: ${method} ${url}`);
        return handler(body);
      }),
    );
    return { calls };
  }

  function deferred() {
    let resolve: (response: Response) => void = () => {};
    const promise = new Promise<Response>((res) => (resolve = res));
    return { promise, resolve };
  }

  async function reviewing(store: Store, to: string, amount: string) {
    store.setState({ status: "editing" });
    store.getState().setRecipientInput(to);
    store.getState().setAmountInput(amount);
    await store.getState().review();
    expect(store.getState().status).toBe("reviewing");
  }

  /** The request carries the held attempt's own recipient and amount, and the prepared object of that SAME attempt. */
  function expectFromHeldAttempt(index: number, attempt: Json) {
    const { input, held } = seen[index]!;
    expect(input.expected).toEqual({ recipient: attempt.recipient, amountBaseUnits: attempt.amountBaseUnits });
    expect(input.fields).toEqual(attempt.prepared);
    expect(held).not.toBeNull();
    expect(input.fields).toBe(held!.prepared); // the very object held, not a copy of something else
    expect(input.expected).toEqual({ recipient: held!.recipient, amountBaseUnits: held!.amountBaseUnits });
    expect(Object.keys(input.expected as Json).sort()).toEqual(["amountBaseUnits", "recipient"]);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0_MS);
    useRealAccountStore.setState({ account: ACCOUNT });
    vi.mocked(signPreparedPayment).mockReset();
    seen = [];
  });

  afterEach(() => {
    for (const store of stores.splice(0)) store.getState().reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.mocked(signPreparedPayment).mockReset();
    useRealAccountStore.setState({ account: null });
  });

  describe("A–F: the expected intent is the held attempt's, on every path that creates a new signature", () => {
    it("A. fresh address prepare: held lower-case recipient and base units — not the typed text, and not inputs changed while preparing", async () => {
      const reply = signingReply(attemptOf());
      const gate = deferred();
      const api = server({ prepare: () => gate.promise });
      const store = newStore();
      signing(() => store);
      await reviewing(store, `  ${CHECKSUMMED}  `, "1");

      const pending = store.getState().confirmAndSend();
      // Store-level only (the form shows no inputs while preparing): the live inputs move on before the answer arrives.
      store.getState().setRecipientInput(OTHER);
      store.getState().setAmountInput("7");
      gate.resolve(jsonResponse(200, reply));
      await pending;

      expect(api.calls).toEqual(["POST /api/real/payments/prepare"]);
      expect(seen).toHaveLength(1);
      expectFromHeldAttempt(0, reply.attempt);
      expect(seen[0]!.input.expected).toEqual({ recipient: ADDRESS, amountBaseUnits: "1000000" });
      expect(store.getState()).toMatchObject({ recipientInput: OTHER, amountInput: "7" });
    });

    it("B. fresh handle prepare: the server-resolved Safe held in the attempt — never the handle or the lookup", async () => {
      const reply = signingReply(attemptOf({ recipient: SMIT_SAFE, recipientIdentity: { handle: "smit", displayName: "Smit P." } }));
      server({ lookup: () => jsonResponse(200, FOUND_SMIT), prepare: () => jsonResponse(200, reply) });
      const store = newStore();
      signing(() => store);
      await reviewing(store, "@Smit", "1");

      await store.getState().confirmAndSend();

      expect(seen).toHaveLength(1);
      expectFromHeldAttempt(0, reply.attempt);
      expect(seen[0]!.input.expected).toEqual({ recipient: SMIT_SAFE, amountBaseUnits: "1000000" });
      expect(store.getState().recipientInput).toBe("@Smit");
    });

    it("C. /latest resume: the restored attempt's recipient and amount — not whatever the inputs hold", async () => {
      const restored = attemptOf({ id: ATTEMPT_ID, recipient: OTHER, amountBaseUnits: "2500000" });
      server({ latest: () => jsonResponse(200, { attempt: restored, subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: SERVER_NOW }) });
      const store = newStore();
      signing(() => store);
      await store.getState().init();
      expect(store.getState().status).toBe("awaiting_authorization");
      expect(seen).toHaveLength(0); // nothing is signed by itself after a reload
      // Store-level only (the resume screen shows no inputs).
      store.getState().setRecipientInput(ADDRESS);
      store.getState().setAmountInput("9");

      await store.getState().resumeAuthorization();

      expect(seen).toHaveLength(1);
      expectFromHeldAttempt(0, restored);
      expect(seen[0]!.input.expected).toEqual({ recipient: OTHER, amountBaseUnits: "2500000" });
    });

    it("D. retry after a dismissed prompt: the second request carries the same held intent and prepared object", async () => {
      const reply = signingReply(attemptOf());
      server({ prepare: () => jsonResponse(200, reply) });
      const store = newStore();
      signing(() => store);
      await reviewing(store, ADDRESS, "1");
      await store.getState().confirmAndSend();
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", error: null });

      await store.getState().resumeAuthorization();

      expect(seen).toHaveLength(2);
      expectFromHeldAttempt(0, reply.attempt);
      expectFromHeldAttempt(1, reply.attempt);
    });

    it("E. retry after a signing error: the second request carries the same held intent", async () => {
      const reply = signingReply(attemptOf());
      server({ prepare: () => jsonResponse(200, reply) });
      const store = newStore();
      signing(() => store, () => Promise.reject(new Error("Turnkey returned a completed activity without a signature.")));
      await reviewing(store, ADDRESS, "1");
      await store.getState().confirmAndSend();
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", error: "Turnkey returned a completed activity without a signature." });

      await store.getState().resumeAuthorization();

      expect(seen).toHaveLength(2);
      expectFromHeldAttempt(1, reply.attempt);
    });

    it("F. after a D-10 status answer REPLACED the prepared object, Continue signs the new object with the held intent", async () => {
      const original = attemptOf({ id: ATTEMPT_ID });
      const replacedFields = { ...fields("0x541d63c8ffff"), callGasLimit: "99999" };
      const replaced = { ...original, prepared: replacedFields, updatedAt: "2030-03-17T17:50:00.000Z" };
      const api = server({
        latest: () => jsonResponse(200, { attempt: original, subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: SERVER_NOW }),
        status: () => jsonResponse(200, { attempt: replaced, serverNowSeconds: SERVER_NOW, reconciliationDeferred: false }),
      });
      const store = newStore();
      signing(() => store);
      await store.getState().init();
      await store.getState().checkStatus();
      await vi.advanceTimersByTimeAsync(0);
      // D-10 adopted the honest answer: same payment, new prepared contents.
      expect(store.getState().status).toBe("awaiting_authorization");
      expect(store.getState().attempt).toEqual(replaced);
      expect(seen).toHaveLength(0);
      store.getState().setRecipientInput(OTHER); // store-level only
      store.getState().setAmountInput("3");

      await store.getState().resumeAuthorization();

      expect(api.calls.filter((call) => call.endsWith("/latest"))).toHaveLength(1);
      expect(seen).toHaveLength(1);
      expectFromHeldAttempt(0, replaced);
      expect((seen[0]!.input.fields as Json).callData).toBe("0x541d63c8ffff"); // the replaced object reaches the signing boundary
      expect(seen[0]!.input.expected).toEqual({ recipient: ADDRESS, amountBaseUnits: "1000000" });
    });

    it("an approval already held (pendingSubmission) is re-sent without a new signature request — unchanged by L-1b", async () => {
      const held = attemptOf({ id: ATTEMPT_ID });
      const api = server({ submit: () => new Promise<Response>(() => {}) });
      const store = newStore();
      signing(() => store);
      store.setState({ status: "awaiting_authorization", attempt: held as never, subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", clockOffsetSeconds: 100, pendingSubmission: { attemptId: ATTEMPT_ID, signature: "0xsig-held", activityId: "activity-held" } });

      void store.getState().resumeAuthorization();
      await vi.advanceTimersByTimeAsync(0);

      expect(seen).toHaveLength(0);
      expect(signPreparedPayment).not.toHaveBeenCalled();
      expect(api.calls).toEqual(["POST /api/real/payments/submit"]);
    });
  });

  describe("an L-1b refusal: the payment and its controls stay; nothing happens by itself", () => {
    async function refusedAfterPrepare() {
      const reply = signingReply(attemptOf());
      const api = server({
        prepare: () => jsonResponse(200, reply),
        cancel: () => jsonResponse(200, { attempt: { ...reply.attempt, state: "cancelled", prepared: null } }),
        balance: () => jsonResponse(200, { token: "USDC", decimals: 6, balanceBaseUnits: "0" }),
      });
      const store = newStore();
      signing(() => store, () => Promise.reject(new Error(L1B_MESSAGE)));
      await reviewing(store, ADDRESS, "1");
      await store.getState().confirmAndSend();
      return { reply, api, store };
    }

    it("stays on the SAME payment, awaiting approval, with the fixed message — attempt, signing context and account untouched", async () => {
      const { reply, api, store } = await refusedAfterPrepare();
      expect(store.getState()).toMatchObject({
        status: "awaiting_authorization",
        attempt: reply.attempt,
        subOrganizationId: SUB_ORG,
        authorizingCredentialId: CREDENTIAL,
        error: L1B_MESSAGE,
        isAuthorizing: false,
        pendingSubmission: null,
        prepareNeedsCheck: null,
        sessionRecovery: null,
      });
      expect(store.getState().attempt).toMatchObject({ id: PREPARED_ID, recipient: ADDRESS, amountBaseUnits: "1000000" });
      expect(useRealAccountStore.getState().account).toEqual(ACCOUNT);
      expect(seen).toHaveLength(1);
      expectFromHeldAttempt(0, reply.attempt);

      // Nothing follows by itself (well inside the payment's window): no prepare, submit, /latest, status read, Cancel or new prompt.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(api.calls).toEqual(["POST /api/real/payments/prepare"]);
      expect(seen).toHaveLength(1);
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", attempt: reply.attempt, error: L1B_MESSAGE, subOrganizationId: SUB_ORG, authorizingCredentialId: CREDENTIAL });
    });

    it("an explicit Continue asks again with the same held intent; unchanged contents are refused again — still the same payment, nothing sent", async () => {
      const { reply, api, store } = await refusedAfterPrepare();

      await store.getState().resumeAuthorization();

      expect(seen).toHaveLength(2);
      expectFromHeldAttempt(1, reply.attempt);
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", attempt: reply.attempt, error: L1B_MESSAGE, isAuthorizing: false, pendingSubmission: null });
      expect(api.calls).toEqual(["POST /api/real/payments/prepare"]);
    });

    it("Cancel payment stays available and cancels exactly the held payment, by explicit action only", async () => {
      const { reply, api, store } = await refusedAfterPrepare();

      await store.getState().cancel();
      await vi.advanceTimersByTimeAsync(0);

      expect(api.calls.slice(0, 2)).toEqual(["POST /api/real/payments/prepare", `POST /api/real/payments/${(reply.attempt as Json).id}/cancel`]);
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null });
      expect(seen).toHaveLength(1);
    });
  });
});

/**
 * R-03 / R-04 (post-L-2 D availability improvement — not a numbered D slice):
 * the client's own bound on one POST /prepare (60 s) and one POST /cancel
 * (45 s), in D-6's shape — a timer per request, a store-level identity marker,
 * a per-request `timedOut` flag, the existing plain await and try/catch, no
 * Promise.race and no abort. A deadline ends OUR wait only: a Prepare that ran
 * out takes D-1's existing uncertain-prepare state, a Cancel that ran out frees
 * its slot and shows the existing "could not confirm" message, and a late answer
 * of either kind is inert. Nothing is retried, read, signed or cancelled by itself.
 */
describe("real-payment-store — R-03 / R-04: bounded Prepare and Cancel waits", () => {
  const ACCOUNT_A = { appUserId: "app-user-1", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222" };
  const ACCOUNT_B = { appUserId: "app-user-2", ownerAddress: "0x4444444444444444444444444444444444444444", safeAddress: "0x5555555555555555555555555555555555555555" };
  const T0_MS = 1_800_000_000_000; // a whole second, so boundary arithmetic is exact
  const ADDRESS = "0x3333333333333333333333333333333333333333";
  const PREPARE_DEADLINE = PREPARE_REQUEST_DEADLINE_MS;
  const CANCEL_DEADLINE = CANCEL_REQUEST_DEADLINE_MS;
  const CANCEL_UNCONFIRMED = "Could not confirm whether this payment was cancelled. Check its status before trying again.";
  const CANCEL_LOST_RACE = "This payment could not be cancelled — it may already be on its way.";
  const APPROVAL = { attemptId: ATTEMPT_ID, signature: "0xsig-r03", activityId: "activity-r03" };

  type Key = "prepare" | "latest" | "cancel" | "status" | "submit" | "balance";
  type Handler = (n: number) => Response | Promise<Response>;
  type Store = ReturnType<typeof createRealPaymentStore>;
  const stores: Store[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0_MS);
    vi.mocked(signPreparedPayment).mockReset();
    vi.mocked(signPreparedPayment).mockResolvedValue({ signature: APPROVAL.signature, activityId: APPROVAL.activityId } as never);
    useRealAccountStore.setState({ account: ACCOUNT_A });
  });

  afterEach(async () => {
    for (const store of stores.splice(0)) store.getState().reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.mocked(signPreparedPayment).mockReset();
    useRealAccountStore.setState({ account: null });
    (await import("@/lib/stores/real-balance-store")).useRealBalanceStore.getState().reset();
  });

  /** Every request is recorded — including one no handler expects, which also fails the request. */
  function server(handlers: Partial<Record<Key, Handler>>) {
    const calls: Array<{ key: Key | "other"; method: string; signal: unknown }> = [];
    const counts: Record<Key, number> = { prepare: 0, latest: 0, cancel: 0, status: 0, submit: 0, balance: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        const key: Key | null = url.endsWith("/api/real/payments/prepare")
          ? "prepare"
          : url.endsWith("/api/real/payments/latest")
            ? "latest"
            : url.endsWith("/cancel")
              ? "cancel"
              : url.endsWith("/status")
                ? "status"
                : url.endsWith("/api/real/payments/submit")
                  ? "submit"
                  : url.endsWith("/api/real/account/balance")
                    ? "balance"
                    : null;
        calls.push({ key: key ?? "other", method, signal: init?.signal });
        const handler = key ? handlers[key] : undefined;
        if (!key || !handler) throw new Error(`unexpected fetch: ${method} ${url}`);
        counts[key] += 1;
        return handler(counts[key]);
      }),
    );
    return { calls, keys: () => calls.map((call) => call.key), count: (key: Key) => calls.filter((call) => call.key === key).length };
  }

  function held<T = Response>() {
    let resolve: (value: T) => void = () => {};
    let reject: (reason: unknown) => void = () => {};
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const settle = () => vi.advanceTimersByTimeAsync(0);
  const offsetFor = (secondsBeforeExpiry: number) => VALID_UNTIL - secondsBeforeExpiry - T0_MS / 1000;
  const serverNow = (secondsBeforeExpiry = 100_000) => Math.floor(Date.now() / 1000) + offsetFor(secondsBeforeExpiry);
  const visible = (store: Store) => JSON.parse(JSON.stringify(store.getState())) as Record<string, unknown>;
  const J = (body: unknown) => jsonResponse(200, body);
  /** A 200-shaped reply whose body read the test controls (it hangs until the test says so). */
  const rawReply = (json: () => Promise<unknown>) => ({ ok: true, status: 200, headers: new Headers(), json }) as unknown as Response;
  const attemptOf = (state: string, over: Record<string, unknown> = {}) => ({ ...baseAttempt(), state, prepared: PREPARED_FIELDS, ...over });

  /** An honest prepare 200 for the address payment the tests review (D-12's checks pass). */
  const prepareBody = (id: string = PREPARED_ID) => ({ attempt: { ...baseAttempt(), id, recipient: ADDRESS }, subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: serverNow() });
  const prepareReply = (id: string = PREPARED_ID) => J(prepareBody(id));
  /** What POST /submit honestly answers for that prepared payment. */
  const submitted = (id: string = PREPARED_ID) => () => J({ attempt: { ...baseAttempt(), id, recipient: ADDRESS, state: "submitted" } });
  const statusReply = (state: string) => J({ attempt: attemptOf(state), serverNowSeconds: serverNow(), reconciliationDeferred: false });
  /** POST /cancel's honest success: the cancelled row. */
  const cancelledReply = () => J({ attempt: attemptOf("cancelled") });
  const refused = () => jsonResponse(409, { error: "This payment can no longer be cancelled (state: submitting)." });

  /** D-1's uncertain-prepare state with the draft kept, no attempt and no signing context. */
  const UNCERTAIN = {
    status: "editing",
    error: null,
    prepareNeedsCheck: "uncertain",
    prepareCheck: "idle",
    attempt: null,
    recipientInput: ADDRESS,
    amountInput: "1",
    subOrganizationId: null,
    authorizingCredentialId: null,
    pendingSubmission: null,
    isAuthorizing: false,
  };

  async function reviewing(store: Store = newStore()): Promise<Store> {
    store.setState({ status: "editing" });
    store.getState().setRecipientInput(ADDRESS);
    store.getState().setAmountInput("1");
    await store.getState().review();
    expect(store.getState().status).toBe("reviewing");
    return store;
  }

  function newStore(): Store {
    const store = createRealPaymentStore();
    stores.push(store);
    return store;
  }

  /** One Approve whose POST /prepare is held open (headers never arrive); returns once the request is on its way. */
  async function preparing(handlers: Partial<Record<Key, Handler>> = {}) {
    const gate = held();
    const api = server({ prepare: () => gate.promise, ...handlers });
    const store = await reviewing();
    const done = store.getState().confirmAndSend();
    await settle();
    expect(store.getState().status).toBe("preparing");
    return { gate, api, store, done };
  }

  /** Prepare timed out, so the page is in D-1's uncertain state. */
  async function timedOutPrepare(handlers: Partial<Record<Key, Handler>> = {}) {
    const run = await preparing(handlers);
    await vi.advanceTimersByTimeAsync(PREPARE_DEADLINE);
    expect(run.store.getState()).toMatchObject(UNCERTAIN);
    return run;
  }

  /** The approval screen, holding a saved approval and its signing context (what Cancel must never drop on a timeout). */
  function holding(): Store {
    const store = newStore();
    store.setState({
      attempt: attemptOf("awaiting_authorization") as never,
      status: "awaiting_authorization",
      subOrganizationId: "sub-org-1",
      authorizingCredentialId: "credential-1",
      clockOffsetSeconds: offsetFor(100_000),
      pendingSubmission: APPROVAL,
    });
    return store;
  }

  /** One Cancel press whose POST is held open (headers never arrive). */
  async function cancelling(handlers: Partial<Record<Key, Handler>> = {}) {
    const gate = held();
    const api = server({ cancel: () => gate.promise, ...handlers });
    const store = holding();
    const before = visible(store);
    const done = store.getState().cancel();
    await settle();
    expect(store.getState().isCancelling).toBe(true);
    return { gate, api, store, done, before };
  }

  /** What a Cancel timeout leaves: the screen exactly as it was, except the fixed message — the slot is free again. */
  const afterCancelTimeout = (store: Store, before: Record<string, unknown>) => expect(visible(store)).toEqual({ ...before, error: CANCEL_UNCONFIRMED, isCancelling: false });

  describe("constants", () => {
    it("Prepare waits 60 s and Cancel 45 s; the D-6 submit (60 s) and status (45 s) bounds are unchanged", () => {
      expect(PREPARE_REQUEST_DEADLINE_MS).toBe(60_000);
      expect(CANCEL_REQUEST_DEADLINE_MS).toBe(45_000);
      expect(SUBMIT_REQUEST_DEADLINE_MS).toBe(60_000);
      expect(STATUS_REQUEST_DEADLINE_MS).toBe(45_000);
    });
  });

  describe("Prepare (R-04)", () => {
    it("P1. an honest, timely answer is adopted and signed exactly as before; its timer is gone before signing", async () => {
      const api = server({ prepare: () => prepareReply(), submit: submitted() });
      const store = await reviewing();
      await store.getState().confirmAndSend();

      expect(store.getState()).toMatchObject({ status: "submitted", prepareNeedsCheck: null, error: null });
      expect(store.getState().attempt).toMatchObject({ id: PREPARED_ID, state: "submitted" });
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
      expect(vi.mocked(signPreparedPayment).mock.calls[0]![0]).toMatchObject({ expected: { recipient: ADDRESS, amountBaseUnits: "1000000" } });
      expect(api.keys()).toEqual(["prepare", "submit"]);
      // The prepare request is never given an abort signal.
      expect(api.calls[0]!.signal).toBeUndefined();

      // Nothing the deadline could do afterwards.
      const after = visible(store);
      await vi.advanceTimersByTimeAsync(10 * PREPARE_DEADLINE);
      expect(visible(store)).toEqual(after);
      expect(api.keys()).toEqual(["prepare", "submit"]);
    });

    it("P2. an honest handled failure keeps its existing classification (500 → uncertain, 409 → in progress, account_not_ready, 400 text)", async () => {
      const cases: Array<[Response, Record<string, unknown>]> = [
        [jsonResponse(500, { error: "boom", code: "prepare_outcome_uncertain" }), { status: "editing", prepareNeedsCheck: "uncertain", error: null }],
        [jsonResponse(409, { error: "in progress" }), { status: "editing", prepareNeedsCheck: "in_progress", error: null }],
        [jsonResponse(409, { error: "x", code: "account_not_ready" }), { status: "editing", prepareNeedsCheck: null, error: "We can't send payments from this account right now. This payment wasn't started." }],
        [jsonResponse(400, { error: "You can't pay yourself." }), { status: "editing", prepareNeedsCheck: null, error: "You can't pay yourself." }],
      ];
      for (const [reply, expected] of cases) {
        server({ prepare: () => reply });
        const store = await reviewing();
        await store.getState().confirmAndSend();
        expect(store.getState()).toMatchObject(expected);
        expect(signPreparedPayment).not.toHaveBeenCalled();
        // The settled request's deadline is gone.
        expect(vi.getTimerCount()).toBe(0);
        const after = visible(store);
        await vi.advanceTimersByTimeAsync(PREPARE_DEADLINE);
        expect(visible(store)).toEqual(after);
      }
    });

    it("P3 / S1 / S2. no response headers: 'preparing' until 60 s − 1 ms, then exactly D-1's uncertain state — one request, nothing else", async () => {
      const { api, store } = await preparing();

      await vi.advanceTimersByTimeAsync(PREPARE_DEADLINE - 1);
      expect(store.getState()).toMatchObject({ status: "preparing", prepareNeedsCheck: null });

      await vi.advanceTimersByTimeAsync(1);
      expect(store.getState()).toMatchObject(UNCERTAIN);
      expect(api.keys()).toEqual(["prepare"]);
      expect(signPreparedPayment).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      // Nothing more happens by itself, however long the page stays open.
      const atDeadline = visible(store);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(visible(store)).toEqual(atDeadline);
      expect(api.keys()).toEqual(["prepare"]);
    });

    it("P4. headers arrive but the body never finishes: the same D-1 outcome at 60 s", async () => {
      const body = held<unknown>();
      const api = server({ prepare: () => rawReply(() => body.promise) });
      const store = await reviewing();
      void store.getState().confirmAndSend();
      await settle();
      expect(store.getState().status).toBe("preparing");

      await vi.advanceTimersByTimeAsync(PREPARE_DEADLINE - 1);
      expect(store.getState().status).toBe("preparing");
      await vi.advanceTimersByTimeAsync(1);
      expect(store.getState()).toMatchObject(UNCERTAIN);

      // The body finally arrives, honest and complete: dropped.
      body.resolve(prepareBody());
      await settle();
      expect(store.getState()).toMatchObject(UNCERTAIN);
      expect(signPreparedPayment).not.toHaveBeenCalled();
      expect(api.keys()).toEqual(["prepare"]);
    });

    it("P5. the server did reserve it: the user's own Check payment status adopts it through the existing read — not signed automatically", async () => {
      const { api, store } = await timedOutPrepare({ latest: () => J(honestLatestBody(baseAttempt())) });

      await store.getState().checkPreparedPayment();

      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", prepareNeedsCheck: null, prepareCheck: "idle", subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", isAuthorizing: false });
      expect(store.getState().attempt?.id).toBe(ATTEMPT_ID);
      expect(signPreparedPayment).not.toHaveBeenCalled();
      expect(api.keys()).toEqual(["prepare", "latest"]);
    });

    it("P6. a late honest success after the deadline is not adopted, not scheduled and never signed", async () => {
      const { gate, api, store, done } = await timedOutPrepare();
      const before = visible(store);

      gate.resolve(prepareReply());
      await done;

      expect(visible(store)).toEqual(before);
      expect(signPreparedPayment).not.toHaveBeenCalled();
      expect(api.keys()).toEqual(["prepare"]);
      // No expiry timer was armed for the late attempt, and Review stays hidden.
      expect(vi.getTimerCount()).toBe(0);
      await store.getState().review();
      expect(store.getState().status).toBe("editing");
    });

    it("P7. a late failure changes nothing — while uncertain, and after the user's check released it", async () => {
      const failures: Array<() => Response | Promise<Response>> = [
        () => jsonResponse(400, { error: "You can't pay yourself." }),
        () => jsonResponse(500, { error: "boom", code: "prepare_outcome_uncertain" }),
        () => jsonResponse(409, { error: "x", code: "account_not_ready" }),
        () => jsonResponse(409, { error: "in progress" }),
        () => Promise.reject(new TypeError("Failed to fetch")),
      ];
      for (const failure of failures) {
        // (a) still uncertain: a late 400 would otherwise put its own text on the form.
        {
          const { gate, store, done } = await timedOutPrepare();
          const before = visible(store);
          void Promise.resolve().then(failure).then(gate.resolve, gate.reject);
          await done;
          expect(visible(store)).toEqual(before);
        }
        // (b) released by "no payment is waiting": a late 500 / 409 would otherwise bring the requirement back.
        {
          const { gate, store, done } = await timedOutPrepare({ latest: () => J({ attempt: null }) });
          await store.getState().checkPreparedPayment();
          expect(store.getState()).toMatchObject({ prepareNeedsCheck: null, prepareCheck: "nothing_found" });
          const before = visible(store);
          void Promise.resolve().then(failure).then(gate.resolve, gate.reject);
          await done;
          expect(visible(store)).toEqual(before);
        }
      }
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });

    it("P8. a late malformed 200 does not take D-12's path: the released state stays released", async () => {
      const { gate, store, done } = await timedOutPrepare({ latest: () => J({ attempt: null }) });
      await store.getState().checkPreparedPayment();
      const before = visible(store);

      gate.resolve(J({ attempt: null }));
      await done;

      expect(visible(store)).toEqual(before);
      expect(store.getState()).toMatchObject({ prepareNeedsCheck: null, prepareCheck: "nothing_found" });
    });

    it("P9. a late answer after the D-1 read adopted the server's payment leaves that recovered payment exactly as it is", async () => {
      for (const late of [() => prepareReply(), () => jsonResponse(500, { error: "x" }), () => J({ attempt: null })]) {
        const { gate, api, store, done } = await timedOutPrepare({ latest: () => J(honestLatestBody(baseAttempt())) });
        await store.getState().checkPreparedPayment();
        expect(store.getState()).toMatchObject({ status: "awaiting_authorization", prepareNeedsCheck: null });
        const before = visible(store);

        gate.resolve(late());
        await done;

        expect(visible(store)).toEqual(before);
        expect(api.keys()).toEqual(["prepare", "latest"]);
      }
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });

    it("P10. an older request settling during a newer Prepare neither clears the newer timer nor touches its state", async () => {
      const gateA = held();
      const gateB = held();
      const api = server({ prepare: (n) => (n === 1 ? gateA.promise : gateB.promise), latest: () => J({ attempt: null }) });
      const store = await reviewing();
      const doneA = store.getState().confirmAndSend();
      await settle();
      await vi.advanceTimersByTimeAsync(PREPARE_DEADLINE);
      expect(store.getState()).toMatchObject(UNCERTAIN);
      await store.getState().checkPreparedPayment();
      await reviewing(store);
      void store.getState().confirmAndSend();
      await settle();
      expect(store.getState().status).toBe("preparing");

      // 10 s into B, A answers honestly — then A rejects in a second run below.
      await vi.advanceTimersByTimeAsync(10_000);
      gateA.resolve(prepareReply(PREPARED_ID));
      await doneA;
      expect(store.getState()).toMatchObject({ status: "preparing", attempt: null, prepareNeedsCheck: null });
      expect(signPreparedPayment).not.toHaveBeenCalled();

      // B's own deadline still fires exactly 60 s after B started.
      await vi.advanceTimersByTimeAsync(PREPARE_DEADLINE - 10_000 - 1);
      expect(store.getState().status).toBe("preparing");
      await vi.advanceTimersByTimeAsync(1);
      expect(store.getState()).toMatchObject(UNCERTAIN);
      expect(api.keys()).toEqual(["prepare", "latest", "prepare"]);
    });

    it("P10b. …and when the newer request answers in time, only ITS payment is adopted and signed", async () => {
      const gateA = held();
      const api = server({ prepare: (n) => (n === 1 ? gateA.promise : prepareReply(PREPARED_ID_2)), latest: () => J({ attempt: null }), submit: submitted(PREPARED_ID_2) });
      const store = await reviewing();
      const doneA = store.getState().confirmAndSend();
      await settle();
      await vi.advanceTimersByTimeAsync(PREPARE_DEADLINE);
      await store.getState().checkPreparedPayment();
      await reviewing(store);
      await store.getState().confirmAndSend();
      expect(store.getState()).toMatchObject({ status: "submitted" });
      expect(store.getState().attempt?.id).toBe(PREPARED_ID_2);

      gateA.reject(new TypeError("Failed to fetch"));
      await doneA;
      expect(store.getState().attempt?.id).toBe(PREPARED_ID_2);
      expect(store.getState().status).toBe("submitted");
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
      expect(api.keys()).toEqual(["prepare", "latest", "prepare", "submit"]);
    });

    it("P11. an account switch: the deadline writes nothing for the other account, and a new lifecycle drops the timer", async () => {
      // (a) the account changed but no new lifecycle yet: nothing is written at the deadline.
      {
        const { store, gate, done } = await preparing();
        useRealAccountStore.setState({ account: ACCOUNT_B });
        await vi.advanceTimersByTimeAsync(PREPARE_DEADLINE);
        expect(store.getState()).toMatchObject({ status: "preparing", prepareNeedsCheck: null });
        gate.resolve(prepareReply());
        await done;
        expect(store.getState()).toMatchObject({ status: "preparing", attempt: null, prepareNeedsCheck: null });
        useRealAccountStore.setState({ account: ACCOUNT_A });
      }
      // (b) the form's account-change init(): the timer goes with the lifecycle.
      {
        const { store, gate, done } = await preparing({ latest: () => J({ attempt: null }) });
        useRealAccountStore.setState({ account: ACCOUNT_B });
        await store.getState().init();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(PREPARE_DEADLINE);
        expect(store.getState()).toMatchObject({ status: "editing", prepareNeedsCheck: null, attempt: null });
        gate.resolve(prepareReply());
        await done;
        expect(store.getState()).toMatchObject({ status: "editing", prepareNeedsCheck: null, attempt: null });
      }
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });

    it("P12. reset() and detach() drop the timer: nothing is written at the deadline or by the late answer", async () => {
      for (const end of ["reset", "detach"] as const) {
        const { store, gate, done } = await preparing();
        store.getState()[end]();
        const after = visible(store);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(PREPARE_DEADLINE);
        expect(visible(store)).toEqual(after);
        gate.resolve(prepareReply());
        await done;
        expect(visible(store)).toEqual(after);
      }
      expect(signPreparedPayment).not.toHaveBeenCalled();
    });

    it("P13. after the deadline Review stays blocked — editing does not release it; only a successful check does", async () => {
      const { api, store } = await timedOutPrepare({ latest: () => J({ attempt: null }) });

      await store.getState().review();
      expect(store.getState().status).toBe("editing");
      store.getState().setAmountInput("2");
      store.getState().setRecipientInput(ADDRESS);
      await store.getState().review();
      await store.getState().confirmAndSend();
      expect(store.getState()).toMatchObject({ status: "editing", prepareNeedsCheck: "uncertain" });
      expect(api.keys()).toEqual(["prepare"]);

      await store.getState().checkPreparedPayment();
      await store.getState().review();
      expect(store.getState().status).toBe("reviewing");
      expect(api.keys()).toEqual(["prepare", "latest"]);
    });

    it("P14. an answer at 60 s − 1 ms stops the timer before expiry scheduling and signing: it never fires into the passkey prompt", async () => {
      const passkey = held<{ signature: string; activityId: string }>();
      vi.mocked(signPreparedPayment).mockImplementation(() => passkey.promise as never);
      const { gate, api, store } = await preparing({ submit: submitted() });

      await vi.advanceTimersByTimeAsync(PREPARE_DEADLINE - 1);
      gate.resolve(prepareReply());
      await settle();
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", isAuthorizing: true, prepareNeedsCheck: null });
      expect(signPreparedPayment).toHaveBeenCalledTimes(1);
      // The one timer left is the approval window's own (validUntil) — the prepare deadline did not survive into the prompt.
      expect(vi.getTimerCount()).toBe(1);

      // Well past the prepare deadline, with the passkey sheet still open.
      await vi.advanceTimersByTimeAsync(PREPARE_DEADLINE);
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", isAuthorizing: true, prepareNeedsCheck: null, error: null });
      expect(store.getState().attempt?.id).toBe(PREPARED_ID);

      passkey.resolve({ signature: APPROVAL.signature, activityId: APPROVAL.activityId });
      await settle();
      expect(store.getState()).toMatchObject({ status: "submitted" });
      expect(api.keys()).toEqual(["prepare", "submit"]);
    });

    it("the deadline never overwrites a screen that is no longer 'preparing' (a programmatic editAgain(); the form offers nothing while preparing)", async () => {
      const { store } = await preparing();
      store.getState().editAgain();
      const after = visible(store);
      await vi.advanceTimersByTimeAsync(PREPARE_DEADLINE);
      expect(visible(store)).toEqual(after);
      expect(store.getState().prepareNeedsCheck).toBeNull();
    });
  });

  describe("Cancel (R-03)", () => {
    it("C1. an honest, timely success clears the payment exactly as before; no timer is left", async () => {
      const api = server({ cancel: () => cancelledReply() });
      const store = holding();
      await store.getState().cancel();
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, pendingSubmission: null, authorizingCredentialId: null, isCancelling: false, error: null });
      expect(vi.getTimerCount()).toBe(0);
      expect(api.keys()).toEqual(["cancel"]);
      expect(api.calls[0]!.signal).toBeUndefined();
    });

    it("C2. an honest, timely refusal takes the existing reconciliation (one status read) — and the POST deadline is gone before that read", async () => {
      const status = held();
      const { gate, api, store } = await cancelling({ status: () => status.promise });

      await vi.advanceTimersByTimeAsync(10_000);
      gate.resolve(refused());
      await settle();
      expect(store.getState().isCancelling).toBe(false);
      expect(api.keys()).toEqual(["cancel", "status"]);

      // The POST's own 45 s passes while the status read is still waiting: the POST deadline writes nothing.
      await vi.advanceTimersByTimeAsync(CANCEL_DEADLINE - 10_000);
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", error: null });

      status.resolve(statusReply("submitted"));
      await settle();
      expect(store.getState()).toMatchObject({ status: "submitted", error: CANCEL_LOST_RACE });
      expect(api.keys()).toEqual(["cancel", "status"]);
    });

    it("C3 / C15 / S1 / S2. no headers: still cancelling at 45 s − 1 ms; at 45 s the slot is free and only the fixed message changes", async () => {
      const { api, store, before } = await cancelling();

      await vi.advanceTimersByTimeAsync(CANCEL_DEADLINE - 1);
      expect(store.getState()).toMatchObject({ isCancelling: true, error: null });

      await vi.advanceTimersByTimeAsync(1);
      afterCancelTimeout(store, before);
      // The payment, its status, the saved approval and the signing context are all still there.
      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", pendingSubmission: APPROVAL, subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1" });
      expect(visible(store).attempt).toEqual(before.attempt);
      expect(api.keys()).toEqual(["cancel"]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("C4. headers arrive but the success body never finishes: the same outcome at 45 s, and the late body is dropped", async () => {
      const body = held<unknown>();
      const api = server({ cancel: () => rawReply(() => body.promise) });
      const store = holding();
      const before = visible(store);
      const done = store.getState().cancel();
      await settle();
      expect(store.getState().isCancelling).toBe(true);

      await vi.advanceTimersByTimeAsync(CANCEL_DEADLINE - 1);
      expect(store.getState().isCancelling).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      afterCancelTimeout(store, before);

      body.resolve({ attempt: attemptOf("cancelled") });
      await done;
      afterCancelTimeout(store, before);
      expect(api.keys()).toEqual(["cancel"]);
    });

    it("C5 / C6. the Cancel may well have succeeded: the timeout does not clear the payment, and a late honest success is not adopted", async () => {
      const { gate, api, store, done, before } = await cancelling();
      await vi.advanceTimersByTimeAsync(CANCEL_DEADLINE);
      afterCancelTimeout(store, before);

      gate.resolve(cancelledReply());
      await done;

      afterCancelTimeout(store, before);
      expect(store.getState().attempt?.id).toBe(ATTEMPT_ID);
      expect(api.keys()).toEqual(["cancel"]);
    });

    it("C7. a late refusal moves no epoch and reads nothing: a status read the user started afterwards is still applied", async () => {
      const status = held();
      const { gate, api, store, done } = await cancelling({ status: () => status.promise });
      await vi.advanceTimersByTimeAsync(CANCEL_DEADLINE);

      void store.getState().checkStatus();
      await settle();
      expect(api.keys()).toEqual(["cancel", "status"]);

      gate.resolve(refused());
      await done;
      expect(api.keys()).toEqual(["cancel", "status"]);

      status.resolve(statusReply("submitted"));
      await settle();
      expect(store.getState()).toMatchObject({ status: "submitted", error: null });
      expect(api.keys()).toEqual(["cancel", "status"]);
    });

    it("C8. a late malformed answer (or a late rejection) is ignored: it does not bring the message back over a newer answered read", async () => {
      const lates: Array<(gate: ReturnType<typeof held<Response>>) => void> = [
        (gate) => gate.resolve(J({ attempt: null })),
        (gate) => gate.resolve(J({ attempt: attemptOf("cancelled", { id: ATTEMPT_ID_2 }) })),
        (gate) => gate.resolve(rawReply(async () => Promise.reject(new SyntaxError("Unexpected token")))),
        (gate) => gate.reject(new TypeError("Failed to fetch")),
      ];
      for (const late of lates) {
        const { gate, api, store, done } = await cancelling({ status: () => statusReply("awaiting_authorization") });
        await vi.advanceTimersByTimeAsync(CANCEL_DEADLINE);
        await store.getState().checkStatus();
        expect(store.getState()).toMatchObject({ status: "awaiting_authorization", error: null });
        const before = visible(store);

        late(gate);
        await done;

        expect(visible(store)).toEqual(before);
        expect(api.keys()).toEqual(["cancel", "status"]);
      }
    });

    it("C9. a status read that answers while Cancel waits stays authoritative: the timeout changes only the message and the slot", async () => {
      const { gate, api, store, done } = await cancelling({ status: () => statusReply("submitted") });
      await vi.advanceTimersByTimeAsync(10_000);
      await store.getState().checkStatus();
      expect(store.getState()).toMatchObject({ status: "submitted", isCancelling: true });
      const answered = visible(store);

      await vi.advanceTimersByTimeAsync(CANCEL_DEADLINE - 10_000);
      // (The manual check's own 30 s cooldown has ended meanwhile — its timer, not the Cancel deadline.)
      expect(visible(store)).toEqual({ ...answered, error: CANCEL_UNCONFIRMED, isCancelling: false, isManualCheckCoolingDown: false });

      gate.resolve(cancelledReply());
      await done;
      expect(store.getState()).toMatchObject({ status: "submitted", error: CANCEL_UNCONFIRMED });
      expect(store.getState().attempt).toMatchObject({ id: ATTEMPT_ID, state: "submitted" });
      expect(api.keys()).toEqual(["cancel", "status"]);
    });

    it("C10. Cancel and Continue interleaved: the timeout starts nothing — one Cancel, one submit of the saved approval, no new signature", async () => {
      const submit = held();
      const { gate, api, store, done } = await cancelling({ submit: () => submit.promise });
      void store.getState().resumeAuthorization();
      await settle();
      expect(store.getState().status).toBe("submitting");

      await vi.advanceTimersByTimeAsync(CANCEL_DEADLINE);
      expect(store.getState()).toMatchObject({ status: "submitting", error: CANCEL_UNCONFIRMED, isCancelling: false, pendingSubmission: APPROVAL });

      gate.resolve(refused());
      await done;
      expect(store.getState()).toMatchObject({ status: "submitting", pendingSubmission: APPROVAL });

      // D-6 still bounds the submit, 60 s after it was sent.
      await vi.advanceTimersByTimeAsync(SUBMIT_REQUEST_DEADLINE_MS - CANCEL_DEADLINE);
      expect(store.getState()).toMatchObject({ status: "unknown", error: SUBMIT_UNCONFIRMED_MESSAGE, pendingSubmission: APPROVAL });
      expect(signPreparedPayment).not.toHaveBeenCalled();
      expect(api.keys()).toEqual(["cancel", "submit"]);
    });

    it("C11. after the timeout an explicit second press sends exactly one more POST; a refusal then takes the existing reconciliation", async () => {
      const second = held();
      const api = server({ cancel: (n) => (n === 1 ? new Promise<Response>(() => {}) : second.promise), status: () => statusReply("cancelled") });
      const store = holding();
      void store.getState().cancel();
      await settle();
      await vi.advanceTimersByTimeAsync(CANCEL_DEADLINE);
      expect(store.getState()).toMatchObject({ isCancelling: false, error: CANCEL_UNCONFIRMED });

      void store.getState().cancel();
      await settle();
      void store.getState().cancel();
      await settle();
      expect(store.getState().isCancelling).toBe(true);
      expect(api.keys()).toEqual(["cancel", "cancel"]);

      // The first POST won on the server; the second is refused against the already-cancelled row.
      second.resolve(jsonResponse(409, { error: "This payment can no longer be cancelled (state: cancelled)." }));
      await settle();
      expect(api.keys()).toEqual(["cancel", "cancel", "status"]);
      expect(store.getState()).toMatchObject({ status: "editing", isCancelling: false, error: CANCEL_LOST_RACE });
      expect(store.getState().attempt).toMatchObject({ id: ATTEMPT_ID, state: "cancelled" });
    });

    it("C12. the old POST settling cannot release the newer press's slot or clear its deadline", async () => {
      for (const late of ["success", "refusal", "rejection"] as const) {
        const first = held();
        const api = server({ cancel: (n) => (n === 1 ? first.promise : new Promise<Response>(() => {})) });
        const store = holding();
        const doneFirst = store.getState().cancel();
        await settle();
        await vi.advanceTimersByTimeAsync(CANCEL_DEADLINE);
        void store.getState().cancel();
        await settle();
        await vi.advanceTimersByTimeAsync(10_000);
        const during = visible(store);

        if (late === "success") first.resolve(cancelledReply());
        else if (late === "refusal") first.resolve(refused());
        else first.reject(new TypeError("Failed to fetch"));
        await doneFirst;

        expect(visible(store)).toEqual(during);
        expect(store.getState().isCancelling).toBe(true);
        void store.getState().cancel();
        await settle();
        expect(api.keys()).toEqual(["cancel", "cancel"]);

        // The second press's own deadline, 45 s after IT started.
        await vi.advanceTimersByTimeAsync(CANCEL_DEADLINE - 10_000 - 1);
        expect(store.getState().isCancelling).toBe(true);
        await vi.advanceTimersByTimeAsync(1);
        expect(store.getState()).toMatchObject({ isCancelling: false, error: CANCEL_UNCONFIRMED, status: "awaiting_authorization" });
        expect(api.keys()).toEqual(["cancel", "cancel"]);
        store.getState().reset();
      }
    });

    it("C13. reset() / detach() drop the timer; an account switch makes the deadline free the slot without writing the message", async () => {
      for (const end of ["reset", "detach"] as const) {
        const { gate, store, done } = await cancelling();
        store.getState()[end]();
        const after = visible(store);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(CANCEL_DEADLINE);
        expect(visible(store)).toEqual(after);
        gate.resolve(cancelledReply());
        await done;
        expect(visible(store)).toEqual(after);
      }
      {
        const { gate, store, done, before } = await cancelling();
        useRealAccountStore.setState({ account: ACCOUNT_B });
        await vi.advanceTimersByTimeAsync(CANCEL_DEADLINE);
        expect(visible(store)).toEqual({ ...before, isCancelling: false });
        gate.resolve(cancelledReply());
        await done;
        expect(visible(store)).toEqual({ ...before, isCancelling: false });
      }
    });

    it("C14. nothing is retried or read by itself after the timeout, however long the page stays open", async () => {
      const { api, store, before } = await cancelling();
      await vi.advanceTimersByTimeAsync(CANCEL_DEADLINE);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      afterCancelTimeout(store, before);
      expect(api.keys()).toEqual(["cancel"]);
    });
  });

  describe("shared", () => {
    it("S3. late rejections after either deadline are handled: no unhandled rejection, no state change", async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        const prep = await timedOutPrepare();
        const prepBefore = visible(prep.store);
        prep.gate.reject(new TypeError("Failed to fetch"));
        await prep.done;

        const canc = await cancelling();
        await vi.advanceTimersByTimeAsync(CANCEL_DEADLINE);
        const cancBefore = visible(canc.store);
        canc.gate.reject(new TypeError("Failed to fetch"));
        await canc.done;

        // Real macrotask turns, so Node gets its chance to report an unhandled rejection.
        vi.useRealTimers();
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        expect(visible(prep.store)).toEqual(prepBefore);
        expect(visible(canc.store)).toEqual(cancBefore);
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });

    it("S4. an overdue timer that runs before the answer's continuation decides the request: the answer is then dropped", async () => {
      {
        const { gate, store, done } = await preparing({ submit: submitted() });
        gate.resolve(prepareReply());
        vi.advanceTimersByTime(PREPARE_DEADLINE); // synchronous: the timer runs before any continuation
        expect(store.getState()).toMatchObject(UNCERTAIN);
        await done;
        expect(store.getState()).toMatchObject(UNCERTAIN);
        expect(signPreparedPayment).not.toHaveBeenCalled();
      }
      {
        const { gate, api, store, done, before } = await cancelling();
        gate.resolve(cancelledReply());
        vi.advanceTimersByTime(CANCEL_DEADLINE);
        afterCancelTimeout(store, before);
        await done;
        afterCancelTimeout(store, before);
        expect(api.keys()).toEqual(["cancel"]);
      }
    });

    it("S5. an answer whose continuation runs before the overdue timer wins: adopted exactly as a timely one, and the timer never acts", async () => {
      {
        const { gate, api, store, done } = await preparing({ submit: submitted() });
        vi.advanceTimersByTime(PREPARE_DEADLINE - 1);
        gate.resolve(prepareReply());
        await done;
        expect(store.getState()).toMatchObject({ status: "submitted", prepareNeedsCheck: null });
        vi.advanceTimersByTime(1);
        await settle();
        expect(store.getState()).toMatchObject({ status: "submitted", prepareNeedsCheck: null, error: null });
        expect(api.keys()).toEqual(["prepare", "submit"]);
      }
      {
        const { gate, api, store, done } = await cancelling();
        vi.advanceTimersByTime(CANCEL_DEADLINE - 1);
        gate.resolve(cancelledReply());
        await done;
        vi.advanceTimersByTime(1);
        await settle();
        expect(store.getState()).toMatchObject({ status: "editing", attempt: null, error: null, isCancelling: false });
        expect(api.keys()).toEqual(["cancel"]);
      }
    });

    it("S6. the D-6 submit deadline is unchanged after a Prepare that answered late in its window", async () => {
      const submit = held();
      const { gate, store } = await preparing({ submit: () => submit.promise });
      await vi.advanceTimersByTimeAsync(30_000);
      gate.resolve(prepareReply());
      await settle();
      expect(store.getState().status).toBe("submitting");

      // The prepare's would-be deadline (60 s after it started) passes: nothing.
      await vi.advanceTimersByTimeAsync(PREPARE_DEADLINE - 30_000);
      expect(store.getState()).toMatchObject({ status: "submitting", prepareNeedsCheck: null });
      // The submit's own 60 s.
      await vi.advanceTimersByTimeAsync(SUBMIT_REQUEST_DEADLINE_MS - (PREPARE_DEADLINE - 30_000) - 1);
      expect(store.getState().status).toBe("submitting");
      await vi.advanceTimersByTimeAsync(1);
      expect(store.getState()).toMatchObject({ status: "unknown", error: SUBMIT_UNCONFIRMED_MESSAGE });
    });

    it("S7. a refused Cancel's status read keeps its own 45 s, counted from the read — not from the POST", async () => {
      const { gate, api, store } = await cancelling({ status: () => new Promise<Response>(() => {}) });
      await vi.advanceTimersByTimeAsync(20_000);
      gate.resolve(refused());
      await settle();
      expect(api.keys()).toEqual(["cancel", "status"]);

      await vi.advanceTimersByTimeAsync(CANCEL_DEADLINE - 20_000);
      expect(store.getState()).toMatchObject({ error: null, status: "awaiting_authorization" });
      await vi.advanceTimersByTimeAsync(STATUS_REQUEST_DEADLINE_MS - (CANCEL_DEADLINE - 20_000) - 1);
      expect(store.getState().error).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(store.getState()).toMatchObject({ error: CANCEL_UNCONFIRMED, status: "awaiting_authorization" });
      expect(api.keys()).toEqual(["cancel", "status"]);
    });
  });
});
