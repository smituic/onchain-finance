import { afterEach, describe, expect, it, vi } from "vitest";
import { createRealPaymentStore, EXPIRY_FOLLOW_UP_MS } from "@/lib/stores/real-payment-store";
import { useRealAccountStore } from "@/lib/stores/real-account-store";
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
  function stubApi(handlers: { lookup?: (body: { handle: string }) => Response | Promise<Response>; prepare?: (body: unknown) => Response; cancel?: () => Response }) {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const rawBody = typeof init?.body === "string" ? init.body : null;
        const body: unknown = rawBody ? JSON.parse(rawBody) : undefined;
        calls.push({ url, method: (init?.method ?? "GET").toUpperCase(), rawBody, body });
        if (url.endsWith("/api/real/payments/latest")) return jsonResponse(200, { attempt: null });
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

    it("init() and reset() clear a resolved recipient and the same-session label", async () => {
      stubApi({ lookup: () => jsonResponse(200, FOUND_SMIT) });
      for (const clear of ["init", "reset"] as const) {
        const store = editingStore();
        store.getState().setRecipientInput("@smit");
        await store.getState().lookupRecipient();
        store.setState({ recipientLabel: { attemptId: "attempt-1", handle: "smit", displayName: "Smit Patel" } });

        if (clear === "init") await store.getState().init();
        else store.getState().reset();

        expect(store.getState(), clear).toMatchObject({ recipientInput: "", recipientLookup: { status: "idle" }, recipientLabel: null });
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
      expect(store.getState()).toMatchObject({ status: "editing", attempt: null, recipientLabel: null });
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
        recipientLabel: null,
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

  describe("same-session recipient label", () => {
    it("is set by a successful handle prepare, for that attempt id only", async () => {
      useRealAccountStore.setState({ account: ACCOUNT });
      const api = stubApi({ lookup: () => jsonResponse(200, FOUND_SMIT), prepare: prepareOk });
      const store = await reviewingSmit(api);
      await store.getState().confirmAndSend();

      expect(store.getState().recipientLabel).toEqual({ attemptId: "attempt-1", handle: "smit", displayName: "Smit Patel" });
      store.getState().reset();
      expect(store.getState().recipientLabel).toBeNull();
    });

    it("a successful cancel clears it, along with the resolved recipient", async () => {
      useRealAccountStore.setState({ account: ACCOUNT });
      const api = stubApi({ lookup: () => jsonResponse(200, FOUND_SMIT), prepare: prepareOk, cancel: () => jsonResponse(200, { attempt: { ...baseAttempt(), state: "cancelled", prepared: null } }) });
      const store = await reviewingSmit(api);
      await store.getState().confirmAndSend();
      expect(store.getState().recipientLabel).not.toBeNull();

      await store.getState().cancel();

      expect(store.getState()).toMatchObject({ status: "editing", recipientInput: "", recipientLookup: { status: "idle" }, recipientLabel: null });
    });

    it("an address payment never gets one", async () => {
      useRealAccountStore.setState({ account: ACCOUNT });
      const api = stubApi({ prepare: prepareOk });
      const store = editingStore();
      store.getState().setRecipientInput(ADDRESS);
      store.getState().setAmountInput("1");
      void store.getState().review();
      await store.getState().confirmAndSend();
      expect(api.prepares()).toHaveLength(1);
      expect(store.getState().recipientLabel).toBeNull();
      store.getState().reset();
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
