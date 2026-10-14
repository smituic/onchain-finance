import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRealPaymentStore,
  EXPIRY_FOLLOW_UP_MS,
  followUpDelayMs,
  interpretStatusResult,
  MANUAL_CHECK_COOLDOWN_MS,
  MAX_AUTOMATIC_FOLLOW_UPS,
  MAX_FOLLOW_UP_INTERVAL_MS,
  STATUS_FALLBACK_DEADLINE_MS,
  STATUS_REQUEST_DEADLINE_MS,
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

function baseAttempt() {
  return {
    id: "attempt-1",
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
    // Stage 2A: the interval grows (75 s, then 150 s), so a second 75 s is not enough.
    await vi.advanceTimersByTimeAsync(EXPIRY_FOLLOW_UP_MS);
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

  const prepareOk = () => jsonResponse(200, { attempt: baseAttempt(), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: Math.floor(Date.now() / 1000) });

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
      expect(store.getState()).toMatchObject({ status: "editing", recipientLookup: { status: "found", handle: "smit" }, error: "You already have a payment in progress." });
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
    const handleAttempt = (overrides: Record<string, unknown> = {}) => ({ ...baseAttempt(), recipientIdentity: SNAPSHOT, ...overrides });
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
      expect(store.getState().attempt).toMatchObject({ id: "attempt-1", recipientIdentity: null });
      store.getState().reset();
    });

    it("reload: init() -> latest restores the identity with the attempt — no lookup request, no lookup state, nothing persisted", async () => {
      const api = stubApi({ latest: () => jsonResponse(200, { attempt: handleAttempt(), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: Math.floor(Date.now() / 1000) }) });
      const store = createRealPaymentStore();

      await store.getState().init();

      expect(store.getState()).toMatchObject({ status: "awaiting_authorization", recipientInput: "", recipientLookup: { status: "idle" }, attempt: { id: "attempt-1", recipientIdentity: SNAPSHOT } });
      expect(api.lookups()).toHaveLength(0);
      expect(api.calls.map((call) => call.url)).toEqual(["/api/real/payments/latest"]);
      store.getState().reset();
    });

    it("a status check replaces the attempt and the identity comes from that response", async () => {
      const renamed = { handle: "smit", displayName: null };
      stubApi({ status: () => jsonResponse(200, { attempt: handleAttempt({ state: "confirmed", prepared: null, recipientIdentity: renamed }), serverNowSeconds: Math.floor(Date.now() / 1000) }) });
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
        ["/api/real/payments/submit", { attemptId: "attempt-1", signature: "0xsignature", activityId: "activity-1" }],
        ["/api/real/payments/attempt-1/cancel", undefined],
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
          return jsonResponse(200, {
            attempt: { ...baseAttempt(), state, prepared: live ? PREPARED_FIELDS : null, failureReason: state === "failed" ? "This payment expired before it was included on-chain. No money moved." : null },
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
          return jsonResponse(200, url.includes("/latest") ? { attempt, subOrganizationId: "s", authorizingCredentialId: "c", serverNowSeconds: VALID_UNTIL + 100 } : { attempt, serverNowSeconds: VALID_UNTIL + 100 });
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
    expect(store.getState().attempt?.id).toBe("attempt-1");
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
    store.setState({ attempt: { ...baseAttempt(), id: "attempt-2" }, status: "awaiting_authorization", isManualCheckCoolingDown: false });
    const second = store.getState().checkStatus();
    await vi.advanceTimersByTimeAsync(0);

    expect(server.statusCalls().map((c) => c.url)).toEqual(["/api/real/payments/attempt-1/status", "/api/real/payments/attempt-2/status"]);
    await server.release();
    await Promise.all([first, second]);
    expect(store.getState().attempt?.id).toBe("attempt-2");
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
                      prepared: state === "awaiting_authorization" ? PREPARED_FIELDS : null,
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
    store.setState({ attempt: { ...baseAttempt(), id: "attempt-2", state: "submitted", prepared: null }, status: "submitted" });
    s.statusRequests[0]!.respond("awaiting_authorization");
    await s.settle();
    await Promise.all([older, waiting]);
    expect(s.statusRequests.map((r) => r.url)).toEqual(["/api/real/payments/attempt-1/status"]);
    expect(store.getState().attempt?.id).toBe("attempt-2");
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
    expect(store.getState().attempt?.id).toBe("attempt-1");
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
    vi.useFakeTimers();
    vi.mocked(signPreparedPayment).mockReset();
    vi.mocked(signPreparedPayment).mockResolvedValue({ signature: "0xsig", activityId: "activity-1" } as never);
    useRealAccountStore.setState({ account: ACCOUNT_A });
    const offset = VALID_UNTIL - (options.secondsBeforeExpiry ?? 1000) - Math.floor(Date.now() / 1000);
    const serverNow = () => Math.floor(Date.now() / 1000) + offset;
    const log: { url: string; method: string; at: number }[] = [];
    const requests: StatusRequest[] = [];
    let latestId = options.latestId ?? "attempt-1";
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
            subOrganizationId: "sub-org-1",
            authorizingCredentialId: "credential-1",
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
                    attempt: { ...baseAttempt(), id: url.split("/")[4]!, state, prepared: state === "awaiting_authorization" ? PREPARED_FIELDS : null, failureReason: state === "failed" ? "No money moved." : null },
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
    expect(store.getState().attempt).toMatchObject({ id: "attempt-1", state: "submitted", failureReason: null, transactionHash: null });
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

    s.setLatestId("attempt-2");
    const second = store.getState().init();
    await s.settle();
    expect(s.statusLog().map((c) => c.url)).toEqual(["/api/real/payments/attempt-1/status", "/api/real/payments/attempt-2/status"]);
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
            attempt: { ...baseAttempt(), id: options.latestId ?? "attempt-1", state, prepared: state === "awaiting_authorization" ? PREPARED_FIELDS : null },
            subOrganizationId: "sub-org-1",
            authorizingCredentialId: "credential-1",
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
                    attempt: { ...baseAttempt(), id: url.split("/")[4]!, state, prepared: state === "awaiting_authorization" ? PREPARED_FIELDS : null },
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
      settle: () => vi.advanceTimersByTimeAsync(0),
    };
  }

  function awaiting(store: ReturnType<typeof createRealPaymentStore>, id = "attempt-1") {
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
    awaiting(store, "attempt-1");
    const first = store.getState().cancel();
    await s.settle();
    s.requests[0]!.respond("awaiting_authorization");
    await first;

    awaiting(store, "attempt-2"); // what prepare leaves behind
    const second = store.getState().cancel();
    await s.settle();
    expect(s.requests.map((r) => r.url)).toEqual(["/api/real/payments/attempt-1/status", "/api/real/payments/attempt-2/status"]);
    s.requests[1]!.respond("awaiting_authorization");
    await second;
  });

  it("the reachable path: a refused cancel, then a successful cancel, then a new attempt's refused cancel — the new one gets its read", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store, "attempt-1");
    const refused = store.getState().cancel();
    await s.settle();
    s.requests[0]!.respond("awaiting_authorization");
    await refused;

    s.setCancelStatus(200);
    await store.getState().cancel();
    expect(store.getState().attempt).toBeNull();

    s.setCancelStatus(409);
    awaiting(store, "attempt-2");
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
    awaiting(store, "attempt-1");
    const first = store.getState().cancel();
    await s.settle();
    s.requests[0]!.respond("submitted", { reconciliationDeferred: true, retryAfterSeconds: 3_600 });
    await first;

    await vi.advanceTimersByTimeAsync(MANUAL_CHECK_COOLDOWN_MS + 1); // the local window is over; the server's is not
    awaiting(store, "attempt-1");
    await store.getState().cancel();
    expect(s.statusCount()).toBe(1);
    expect(store.getState().status).toBe("awaiting_authorization"); // refusal reported; nothing invented

    awaiting(store, "attempt-2"); // another attempt is not governed by it
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
    vi.useFakeTimers();
    vi.mocked(signPreparedPayment).mockReset();
    vi.mocked(signPreparedPayment).mockResolvedValue({ signature: "0xsig", activityId: "activity-1" } as never);
    useRealAccountStore.setState({ account: ACCOUNT_A });
    const offset = VALID_UNTIL - (options.secondsBeforeExpiry ?? 1000) - Math.floor(Date.now() / 1000);
    const serverNow = () => Math.floor(Date.now() / 1000) + offset;
    const log: { url: string; method: string }[] = [];
    const requests: Req[] = [];
    let latestId = options.latestId ?? "attempt-1";
    const body = (url: string, state: string, extra: Record<string, unknown> = {}) =>
      jsonResponse(200, {
        attempt: { ...baseAttempt(), id: url.split("/")[4]!, state, prepared: state === "awaiting_authorization" ? PREPARED_FIELDS : null },
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
            subOrganizationId: "sub-org-1",
            authorizingCredentialId: "credential-1",
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
      settle: () => vi.advanceTimersByTimeAsync(0),
    };
  }

  function awaiting(store: ReturnType<typeof createRealPaymentStore>, id = "attempt-1") {
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
    s.setLatestId("attempt-2");
    const third = store.getState().init();
    await s.settle();
    expect(s.requests[2]!.url).toBe("/api/real/payments/attempt-2/status");
    s.requests[2]!.respond("awaiting_authorization");
    await third;
    store.getState().detach();
  });

  // ---- L-2: a repeated refused cancel keeps the useful read ----------------

  it("L-2: a second refusal inside the window does not discard the first refusal's read — its answer updates the payment", async () => {
    const s = lab();
    const store = createRealPaymentStore();
    awaiting(store);
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
    awaiting(store, "attempt-1");
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

    awaiting(store, "attempt-2");
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
