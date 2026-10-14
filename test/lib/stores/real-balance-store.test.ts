import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRealBalanceStore,
  FALLBACK_COOLDOWN_MS,
  MAX_RETRY_AFTER_SECONDS,
  parseRetryAfterSeconds,
} from "@/lib/stores/real-balance-store";
import { useRealAccountStore } from "@/lib/stores/real-account-store";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("real-balance-store — fetchBalance", () => {
  it("a normal fetch resolves to a ready state with the returned balance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { token: "USDC", decimals: 6, balanceBaseUnits: "1000000" })));
    const store = createRealBalanceStore();

    await store.getState().fetchBalance();

    expect(store.getState().status).toBe("ready");
    expect(store.getState().balance?.balanceBaseUnits).toBe("1000000");
    vi.unstubAllGlobals();
  });

  it("a 401 is reported as unauthenticated, never a fabricated balance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: "Not authenticated." })));
    const store = createRealBalanceStore();

    await store.getState().fetchBalance();

    expect(store.getState().status).toBe("unauthenticated");
    expect(store.getState().balance).toBeNull();
    vi.unstubAllGlobals();
  });
});

/**
 * Pre-2f hardening: see real-balance-store.ts's `generation` closure
 * variable — a stale fetchBalance() response must never overwrite state a
 * newer reset() (account switch/logout) already cleared, nor a newer
 * fetchBalance() call's own result.
 */
describe("real-balance-store — stale async response race (pre-2f hardening)", () => {
  it("a stale fetchBalance() response arriving after reset() is a no-op, never resurrects a cleared balance", async () => {
    let resolveFetch: (value: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => (resolveFetch = resolve))));
    const store = createRealBalanceStore();

    const pending = store.getState().fetchBalance();
    expect(store.getState().status).toBe("loading");

    // Simulates an account switch/logout racing ahead of the in-flight fetch.
    store.getState().reset();
    expect(store.getState().status).toBe("idle");
    expect(store.getState().balance).toBeNull();

    resolveFetch(jsonResponse(200, { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" }));
    await pending;

    expect(store.getState().status).toBe("idle");
    expect(store.getState().balance).toBeNull();
    vi.unstubAllGlobals();
  });

  it("latest-request-wins: an older fetchBalance() response resolving after a newer one cannot overwrite it", async () => {
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
    const store = createRealBalanceStore();

    const pendingA = store.getState().fetchBalance();
    const pendingB = store.getState().fetchBalance();

    // B — the newer request — resolves first and applies.
    resolveB(jsonResponse(200, { token: "USDC", decimals: 6, balanceBaseUnits: "5000000" }));
    await pendingB;
    expect(store.getState().balance?.balanceBaseUnits).toBe("5000000");

    // A — the OLDER request — resolves last and must not overwrite B's result.
    resolveA(jsonResponse(200, { token: "USDC", decimals: 6, balanceBaseUnits: "999999999" }));
    await pendingA;

    expect(store.getState().balance?.balanceBaseUnits).toBe("5000000");
    vi.unstubAllGlobals();
  });
});

/**
 * 3A-1 Stage 2C-1: the server's chain-read budget denial (HTTP 429, code
 * "rate_limited", Retry-After). The balance is never shown as zero, nothing is
 * retried automatically, and the cooldown belongs to ONE signed-in account.
 */
describe("real-balance-store — 3A-1 Stage 2C-1: chain-read budget denial", () => {
  const ACCOUNT_A = { appUserId: "app-user-1", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222" };
  const ACCOUNT_B = { appUserId: "app-user-2", ownerAddress: "0x4444444444444444444444444444444444444444", safeAddress: "0x5555555555555555555555555555555555555555" };
  const BALANCE = { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    useRealAccountStore.setState({ account: null });
  });

  function limited(retryAfter: string | null, body: unknown = { error: "You're checking a bit often. Try again in a moment.", code: "rate_limited" }) {
    return new Response(JSON.stringify(body), { status: 429, headers: { "content-type": "application/json", ...(retryAfter === null ? {} : { "Retry-After": retryAfter }) } });
  }

  /** Scripted fetch: answers each request with the next response (the last repeats) and counts requests. */
  function script(...responses: Array<Response | (() => Response | Promise<Response>) | Error>) {
    const counter = { calls: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const step = responses[Math.min(counter.calls, responses.length - 1)]!;
        counter.calls++;
        if (step instanceof Error) throw step;
        return typeof step === "function" ? step() : step.clone();
      }),
    );
    return counter;
  }

  const signIn = (account: typeof ACCOUNT_A | null) => useRealAccountStore.setState({ account });
  const DAY_MS = MAX_RETRY_AFTER_SECONDS * 1000;

  it("parseRetryAfterSeconds accepts only a plain whole number of seconds in 1…86400", () => {
    expect(MAX_RETRY_AFTER_SECONDS).toBe(86_400);
    for (const [raw, expected] of [["1", 1], ["30", 30], ["600", 600], ["86400", 86_400], [" 90 ", 90]] as const) expect(parseRetryAfterSeconds(raw), raw).toBe(expected);
    for (const raw of [null, undefined, "", "   ", "0", "00", "-5", "+5", "1.5", "1e3", "0x10", "NaN", "Infinity", "-Infinity", "abc", "30s", "30, 60", "Wed, 21 Oct 2026 07:28:00 GMT", "086", "86401", "999999", "99999999999999999999"]) {
      expect(parseRetryAfterSeconds(raw as never), String(raw)).toBeNull();
    }
  });

  it("B/Q. a budget denial is its own state: no balance, no error text, never $0.00, with the validated delay", async () => {
    signIn(ACCOUNT_A);
    script(limited("600"));
    const store = createRealBalanceStore();

    await store.getState().fetchBalance();

    expect(store.getState()).toMatchObject({ status: "rate_limited", balance: null, error: null, retryAfterSeconds: 600, isCoolingDown: true });
  });

  it("D. Retry-After at the policy maximum (24 h) is accepted as given, with one bounded timer", async () => {
    vi.useFakeTimers();
    signIn(ACCOUNT_A);
    script(limited("86400"));
    const store = createRealBalanceStore();

    await store.getState().fetchBalance();

    expect(store.getState().retryAfterSeconds).toBe(86_400);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(DAY_MS - 1);
    expect(store.getState().isCoolingDown).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getState().isCoolingDown).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("E/F. a missing or malformed Retry-After is not an authorization to retry: unknown delay + a conservative local cooldown", async () => {
    for (const header of [null, "abc", "0", "-30", "1.5", "NaN", "Infinity", "86401", "Wed, 21 Oct 2026 07:28:00 GMT", ""]) {
      vi.useFakeTimers();
      signIn(ACCOUNT_A);
      const counter = script(limited(header), new Response(JSON.stringify(BALANCE), { status: 200 }));
      const store = createRealBalanceStore();

      await store.getState().fetchBalance();
      expect(store.getState(), String(header)).toMatchObject({ status: "rate_limited", balance: null, retryAfterSeconds: null, isCoolingDown: true });

      // Immediate presses send nothing; the fallback expires on its own.
      await store.getState().fetchBalance();
      await vi.advanceTimersByTimeAsync(FALLBACK_COOLDOWN_MS - 1);
      await store.getState().fetchBalance();
      expect(counter.calls, String(header)).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(store.getState().isCoolingDown).toBe(false);
      await store.getState().fetchBalance();
      expect(counter.calls, String(header)).toBe(2);
      expect(store.getState().status).toBe("ready");
      vi.useRealTimers();
    }
  });

  it("a 429 that is NOT our budget (no rate_limited code, or no JSON) is an ordinary failure with the same cooldown — never presented as the budget", async () => {
    for (const response of [limited("30", { error: "Slow down." }), new Response("<html>429</html>", { status: 429, headers: { "Retry-After": "30" } })]) {
      vi.useFakeTimers();
      signIn(ACCOUNT_A);
      const counter = script(response);
      const store = createRealBalanceStore();
      await store.getState().fetchBalance();
      expect(store.getState().status).toBe("error");
      expect(store.getState().balance).toBeNull();
      expect(store.getState().isCoolingDown).toBe(true);
      await store.getState().fetchBalance();
      expect(counter.calls).toBe(1);
      vi.useRealTimers();
    }
  });

  it("G. no automatic retry of any kind after a denial — not after a day, not after two", async () => {
    vi.useFakeTimers();
    signIn(ACCOUNT_A);
    const counter = script(limited("600"));
    const store = createRealBalanceStore();

    await store.getState().fetchBalance();
    await vi.advanceTimersByTimeAsync(2 * DAY_MS);

    expect(counter.calls).toBe(1);
    expect(store.getState().status).toBe("rate_limited"); // still the denial — only the control came back
    expect(store.getState().isCoolingDown).toBe(false);
  });

  it("H/I. repeated presses during the cooldown send nothing and re-render nothing; one manual retry works afterwards and clears the denial", async () => {
    vi.useFakeTimers();
    signIn(ACCOUNT_A);
    const counter = script(limited("120"), new Response(JSON.stringify(BALANCE), { status: 200 }));
    const store = createRealBalanceStore();
    await store.getState().fetchBalance();

    let notifications = 0;
    const unsubscribe = store.subscribe(() => notifications++);
    for (let i = 0; i < 25; i++) await store.getState().fetchBalance();
    unsubscribe();
    expect(counter.calls).toBe(1);
    expect(notifications).toBe(0);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(store.getState().isCoolingDown).toBe(false);
    await store.getState().fetchBalance();
    expect(counter.calls).toBe(2);
    expect(store.getState()).toMatchObject({ status: "ready", balance: BALANCE, retryAfterSeconds: null, isCoolingDown: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a second denial replaces the first: still exactly one timer, with the new delay", async () => {
    vi.useFakeTimers();
    signIn(ACCOUNT_A);
    script(limited("60"), limited("300"));
    const store = createRealBalanceStore();
    await store.getState().fetchBalance();
    await vi.advanceTimersByTimeAsync(60_000);
    await store.getState().fetchBalance();
    expect(store.getState().retryAfterSeconds).toBe(300);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("J. an account switch drops the stale balance AND the cooldown — the new account is never held back by the old one's denial", async () => {
    vi.useFakeTimers();
    signIn(ACCOUNT_A);
    const counter = script(limited("3600"), new Response(JSON.stringify({ ...BALANCE, balanceBaseUnits: "5000000" }), { status: 200 }));
    const store = createRealBalanceStore();
    await store.getState().fetchBalance();
    expect(store.getState().isCoolingDown).toBe(true);

    signIn(ACCOUNT_B);
    store.getState().reset();
    expect(store.getState()).toMatchObject({ status: "idle", balance: null, isCoolingDown: false, retryAfterSeconds: null });
    expect(vi.getTimerCount()).toBe(0);

    await store.getState().fetchBalance();
    expect(counter.calls).toBe(2);
    expect(store.getState().balance?.balanceBaseUnits).toBe("5000000");
  });

  it("J. even with no reset() in between, a different signed-in account is not blocked by the previous account's cooldown", async () => {
    vi.useFakeTimers();
    signIn(ACCOUNT_A);
    const counter = script(limited("3600"), new Response(JSON.stringify(BALANCE), { status: 200 }));
    const store = createRealBalanceStore();
    await store.getState().fetchBalance();

    signIn(ACCOUNT_B);
    await store.getState().fetchBalance();
    expect(counter.calls).toBe(2);
    expect(store.getState().status).toBe("ready");
  });

  it("M. navigation (a reset() for the SAME account) never keeps a balance, but keeps the denial: the remount's fetch sends nothing", async () => {
    vi.useFakeTimers();
    signIn(ACCOUNT_A);
    const counter = script(new Response(JSON.stringify(BALANCE), { status: 200 }), limited("900"));
    const store = createRealBalanceStore();
    await store.getState().fetchBalance();
    expect(store.getState().balance).toEqual(BALANCE);
    await vi.advanceTimersByTimeAsync(0);
    await store.getState().fetchBalance(); // 429
    expect(counter.calls).toBe(2);

    store.getState().reset(); // the page unmounted and mounted again
    expect(store.getState()).toMatchObject({ balance: null, status: "idle", isCoolingDown: true, retryAfterSeconds: 900 });
    await store.getState().fetchBalance();
    expect(counter.calls).toBe(2);
    expect(store.getState()).toMatchObject({ status: "rate_limited", balance: null, isCoolingDown: true, retryAfterSeconds: 900 });
    expect(vi.getTimerCount()).toBe(1);
  });

  it("K. a Safe-address change under the same account still drops the balance on reset()", async () => {
    signIn(ACCOUNT_A);
    script(new Response(JSON.stringify(BALANCE), { status: 200 }));
    const store = createRealBalanceStore();
    await store.getState().fetchBalance();
    signIn({ ...ACCOUNT_A, safeAddress: "0x6666666666666666666666666666666666666666" });
    store.getState().reset();
    expect(store.getState().balance).toBeNull();
    expect(store.getState().status).toBe("idle");
  });

  it("L. logout drops the cooldown; a 401 is unauthenticated, clears any cooldown, and keeps no balance", async () => {
    vi.useFakeTimers();
    signIn(ACCOUNT_A);
    script(limited("3600"));
    const store = createRealBalanceStore();
    await store.getState().fetchBalance();
    signIn(null);
    store.getState().reset();
    expect(store.getState()).toMatchObject({ status: "idle", isCoolingDown: false, balance: null });
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();

    vi.useFakeTimers();
    signIn(ACCOUNT_A);
    script(limited("3600"), new Response(JSON.stringify({ error: "Not authenticated." }), { status: 401 }));
    const second = createRealBalanceStore();
    await second.getState().fetchBalance();
    vi.setSystemTime(Date.now() + 3_600_000);
    await vi.advanceTimersByTimeAsync(3_600_000);
    await second.getState().fetchBalance();
    expect(second.getState()).toMatchObject({ status: "unauthenticated", balance: null, isCoolingDown: false, retryAfterSeconds: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("N. an older request cannot apply — nor start a cooldown — after a newer account's state exists", async () => {
    vi.useFakeTimers();
    signIn(ACCOUNT_A);
    let answerOlder: (value: Response) => void = () => {};
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        call++;
        return call === 1 ? new Promise<Response>((resolve) => (answerOlder = resolve)) : Promise.resolve(new Response(JSON.stringify(BALANCE), { status: 200 }));
      }),
    );
    const store = createRealBalanceStore();
    const older = store.getState().fetchBalance();

    signIn(ACCOUNT_B);
    store.getState().reset();
    await store.getState().fetchBalance();
    expect(store.getState().status).toBe("ready");

    answerOlder(limited("86400"));
    await older;

    expect(store.getState()).toMatchObject({ status: "ready", balance: BALANCE, isCoolingDown: false });
    expect(vi.getTimerCount()).toBe(0);
    await store.getState().fetchBalance(); // not blocked by the old denial
    expect(call).toBe(3);
  });

  it("O. concurrent calls are NOT merged (a joined read could predate the event that prompted the second call): latest wins, as before", async () => {
    signIn(ACCOUNT_A);
    const counter = script(new Response(JSON.stringify(BALANCE), { status: 200 }));
    const store = createRealBalanceStore();
    await Promise.all([store.getState().fetchBalance(), store.getState().fetchBalance()]);
    expect(counter.calls).toBe(2);
    expect(store.getState().status).toBe("ready");
  });

  it("P/Q. 502, 500 and a network failure keep their ordinary error state: server text, no balance, no cooldown, retry allowed at once", async () => {
    for (const step of [
      new Response(JSON.stringify({ error: "Could not read your balance right now. Try again in a moment." }), { status: 502 }),
      new Response(JSON.stringify({ error: "Something went wrong. Please try again." }), { status: 500 }),
      new TypeError("Failed to fetch"),
    ]) {
      signIn(ACCOUNT_A);
      const counter = script(step, new Response(JSON.stringify(BALANCE), { status: 200 }));
      const store = createRealBalanceStore();
      await store.getState().fetchBalance();
      expect(store.getState()).toMatchObject({ status: "error", balance: null, isCoolingDown: false, retryAfterSeconds: null });
      expect(store.getState().error).toBeTruthy();
      await store.getState().fetchBalance();
      expect(counter.calls).toBe(2);
      expect(store.getState().status).toBe("ready");
    }
  });
});
