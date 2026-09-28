import { afterEach, describe, expect, it, vi } from "vitest";
import { createRealPaymentStore, EXPIRY_FOLLOW_UP_MS } from "@/lib/stores/real-payment-store";
import type { WirePreparedFields } from "@/lib/real/payments/prepared-operation";

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

function baseAttempt() {
  return {
    id: "attempt-1",
    state: "awaiting_authorization" as const,
    recipient: "0x2222222222222222222222222222222222222222",
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
          attempt: { ...baseAttempt(), state: "failed", failureReason: "This payment expired before it was included on-chain. No money moved.", prepared: null },
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
      "/api/real/payments/latest": () => jsonResponse(200, { attempt: { ...baseAttempt(), prepared: null }, serverNowSeconds: 1_900_000_000 }),
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
      "/status": () => jsonResponse(200, { attempt: { ...baseAttempt(), state: "submitted", prepared: null }, serverNowSeconds: VALID_UNTIL }),
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
    expect(store.getState().attempt?.id).toBe("attempt-1");
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
    expect(store.getState().attempt?.id).toBe("attempt-1");
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
            attempt: { ...baseAttempt(), state, prepared: terminal ? null : PREPARED_FIELDS, failureReason: terminal ? "This payment expired before it was included on-chain. No money moved." : null },
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
    await vi.advanceTimersByTimeAsync(EXPIRY_FOLLOW_UP_MS);
    expect(statusUrls).toHaveLength(3);
    expect(EXPIRY_FOLLOW_UP_MS).toBeGreaterThanOrEqual(60_000);
    expect(new Set(statusUrls)).toEqual(new Set(["/api/real/payments/attempt-1/status"]));
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

    store.setState({ attempt: { ...baseAttempt(), id: "attempt-2", prepared: null } });
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
    vi.useFakeTimers();
    let resolveA: (value: Response) => void = () => {};
    const bServerNow = VALID_UNTIL - 500;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/attempt-A/status")) return new Promise<Response>((resolve) => (resolveA = resolve));
        if (url.includes("/latest")) {
          return Promise.resolve(
            jsonResponse(200, { attempt: { ...baseAttempt(), id: "attempt-B" }, subOrganizationId: "sub-org-B", authorizingCredentialId: "credential-B", serverNowSeconds: bServerNow }),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );
    const store = createRealPaymentStore();
    store.setState({ attempt: { ...baseAttempt(), id: "attempt-A", state: "unknown", prepared: null }, status: "unknown" });

    const pendingA = store.getState().checkStatus();
    await store.getState().init(); // account B
    const before = { ...store.getState() };
    expect(before.attempt?.id).toBe("attempt-B");

    resolveA(
      jsonResponse(200, {
        attempt: { ...baseAttempt(), id: "attempt-A", state: "failed", failureReason: "A's reason", prepared: null },
        serverNowSeconds: 1_000,
      }),
    );
    await pendingA;

    const after = store.getState();
    expect(after.attempt?.id).toBe("attempt-B");
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
