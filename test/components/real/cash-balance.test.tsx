import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CashBalance, describeWait } from "@/components/real/cash-balance";
import { useRealAccountStore } from "@/lib/stores/real-account-store";
import { useRealBalanceStore } from "@/lib/stores/real-balance-store";

const ACCOUNT = { appUserId: "app-user-1", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222" };

function stubFetchOnce(response: { status: number; body: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(response.body), { status: response.status, headers: { "content-type": "application/json" } })),
  );
}

describe("CashBalance", () => {
  beforeEach(() => {
    useRealAccountStore.setState({ account: null, status: "idle", error: null, hasHydrated: true });
    useRealBalanceStore.setState({ balance: null, status: "idle", error: null });
    vi.unstubAllGlobals();
  });

  it("renders nothing when there is no signed-in account", () => {
    const { container } = render(<CashBalance />);
    expect(container).toBeEmptyDOMElement();
  });

  it("fetches and displays a non-zero balance, formatted as consumer money", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    stubFetchOnce({ status: 200, body: { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" } });

    render(<CashBalance />);

    await waitFor(() => expect(screen.getByText("$20.00")).toBeInTheDocument());
    expect(screen.getByText("Cash")).toBeInTheDocument();
    expect(screen.queryByText(/USDC/)).not.toBeInTheDocument();
  });

  it("displays a genuine zero balance as $0.00", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    stubFetchOnce({ status: 200, body: { token: "USDC", decimals: 6, balanceBaseUnits: "0" } });

    render(<CashBalance />);

    await waitFor(() => expect(screen.getByText("$0.00")).toBeInTheDocument());
  });

  it("shows an unauthenticated state, never a fabricated balance, when the server reports 401", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    stubFetchOnce({ status: 401, body: { error: "Not authenticated." } });

    render(<CashBalance />);

    await waitFor(() => expect(screen.getByText(/Sign in to see your balance/)).toBeInTheDocument());
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("an RPC/read failure shows an explicit error state — never $0.00", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    stubFetchOnce({ status: 502, body: { error: "Could not read your balance." } });

    render(<CashBalance />);

    await waitFor(() => expect(screen.getByText(/Couldn.t load your balance/)).toBeInTheDocument());
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("the Refresh button re-fetches the balance", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ token: "USDC", decimals: 6, balanceBaseUnits: "1000000" }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<CashBalance />);
    await waitFor(() => expect(screen.getByText("$1.00")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("pre-2f hardening: switching to a different account's address never leaves the prior account's balance on screen", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    stubFetchOnce({ status: 200, body: { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" } });
    render(<CashBalance />);
    await waitFor(() => expect(screen.getByText("$20.00")).toBeInTheDocument());

    const ACCOUNT_B = { appUserId: "app-user-2", ownerAddress: "0x4444444444444444444444444444444444444444", safeAddress: "0x5555555555555555555555555555555555555555" };
    let resolveSecondFetch: (value: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (resolveSecondFetch = resolve))),
    );

    act(() => {
      useRealAccountStore.setState({ account: ACCOUNT_B, status: "ready" });
    });

    // Before the new account's fetch has resolved, A's balance must already be gone.
    expect(screen.queryByText("$20.00")).not.toBeInTheDocument();

    resolveSecondFetch(new Response(JSON.stringify({ token: "USDC", decimals: 6, balanceBaseUnits: "5000000" }), { status: 200, headers: { "content-type": "application/json" } }));
    await waitFor(() => expect(screen.getByText("$5.00")).toBeInTheDocument());
  });
});

/**
 * 3A-1 Stage 2C-1: the server's chain-read budget denial, as the user sees it.
 */
describe("CashBalance — 3A-1 Stage 2C-1: refresh limit", () => {
  const BALANCE_BODY = { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" };
  const LIMITED_BODY = { error: "You're checking a bit often. Try again in a moment.", code: "rate_limited" };

  const limited = (retryAfter: string | null) =>
    new Response(JSON.stringify(LIMITED_BODY), { status: 429, headers: { "content-type": "application/json", ...(retryAfter === null ? {} : { "Retry-After": retryAfter }) } });
  const ok = (body: unknown = BALANCE_BODY) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  function stubSequence(...responses: Array<() => Response>) {
    let calls = 0;
    const fetchMock = vi.fn(async () => responses[Math.min(calls++, responses.length - 1)]!());
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  beforeEach(() => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready", error: null, hasHydrated: true });
    useRealBalanceStore.getState().reset();
    useRealBalanceStore.setState({ balance: null, status: "idle", error: null, retryAfterSeconds: null, isCoolingDown: false });
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
    useRealAccountStore.setState({ account: null });
    useRealBalanceStore.getState().reset();
  });

  it("describeWait never softens a long wait", () => {
    expect(describeWait(5)).toBe("in less than a minute");
    expect(describeWait(60)).toBe("in about a minute");
    expect(describeWait(600)).toBe("in about 10 minutes");
    expect(describeWait(3_599)).toBe("in about 60 minutes");
    expect(describeWait(3_600)).toBe("in about an hour");
    expect(describeWait(7_201)).toBe("in about 3 hours");
    expect(describeWait(86_400)).toBe("in about 24 hours");
  });

  it("a refusal says the balance can't be refreshed, gives the real wait, and shows no amount — never $0.00", async () => {
    const fetchMock = stubSequence(() => limited("600"));
    render(<CashBalance />);

    await waitFor(() => expect(screen.getByTestId("real-cash-balance-limited")).toBeInTheDocument());
    expect(screen.getByText(/can.t be refreshed right now/)).toBeInTheDocument();
    expect(screen.getByText(/Try again in about 10 minutes/)).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    expect(screen.queryByText(/Couldn.t load your balance/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/rate_limited|429|RPC|Pimlico|gas|bucket|quota|budget|chain.read/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a day-long wait is stated as hours, not 'a moment'", async () => {
    stubSequence(() => limited("86400"));
    render(<CashBalance />);
    await waitFor(() => expect(screen.getByText(/Try again in about 24 hours/)).toBeInTheDocument());
    expect(screen.queryByText(/moment|few seconds/i)).not.toBeInTheDocument();
  });

  it("with no usable Retry-After it makes no promise about the wait", async () => {
    for (const header of [null, "soon", "-1"]) {
      stubSequence(() => limited(header));
      const { unmount } = render(<CashBalance />);
      await waitFor(() => expect(screen.getByText(/Try again in a little while/)).toBeInTheDocument());
      expect(screen.queryByText(/about \d+|in about/)).not.toBeInTheDocument();
      unmount();
      useRealBalanceStore.getState().reset();
      useRealBalanceStore.setState({ status: "idle", isCoolingDown: false, retryAfterSeconds: null });
    }
  });

  it("the control is disabled during the cooldown and repeated clicks send nothing", async () => {
    const fetchMock = stubSequence(() => limited("600"));
    render(<CashBalance />);
    const button = await screen.findByRole("button", { name: "Try again" });
    expect(button).toBeDisabled();

    for (let i = 0; i < 5; i++) fireEvent.click(button);
    // Even a store-level call (the payment store's post-confirmation refresh) is suppressed.
    await act(async () => {
      await useRealBalanceStore.getState().fetchBalance();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("after the cooldown the control returns, enabled — and one press fetches again and shows the balance", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const fetchMock = stubSequence(() => limited("120"), () => ok());
    // Testing Library's own polling is not driven by the fake clock, so flush by hand.
    const flush = () => act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    render(<CashBalance />);
    await flush();
    expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();

    await act(async () => {
      vi.advanceTimersByTime(119_999);
    });
    expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    const ready = screen.getByRole("button", { name: "Try again" });
    expect(ready).toBeEnabled();
    expect(screen.getByText(/You can try again/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1); // nothing retried by itself

    fireEvent.click(ready);
    await flush();
    expect(screen.getByText("$20.00")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("an ordinary failure (502) is unchanged: the old wording, the server's text, and an immediate Retry", async () => {
    const fetchMock = stubSequence(
      () => new Response(JSON.stringify({ error: "Could not read your balance right now. Try again in a moment." }), { status: 502 }),
      () => ok(),
    );
    render(<CashBalance />);
    await waitFor(() => expect(screen.getByText(/Couldn.t load your balance: Could not read your balance right now/)).toBeInTheDocument());
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByText("$20.00")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("an account switch while limited: the next account's balance loads at once, with no inherited denial and nothing of the old one", async () => {
    const fetchMock = stubSequence(() => limited("3600"), () => ok({ ...BALANCE_BODY, balanceBaseUnits: "5000000" }));
    render(<CashBalance />);
    await screen.findByRole("button", { name: "Try again" });

    const ACCOUNT_B = { appUserId: "app-user-2", ownerAddress: "0x4444444444444444444444444444444444444444", safeAddress: "0x5555555555555555555555555555555555555555" };
    act(() => {
      useRealAccountStore.setState({ account: ACCOUNT_B, status: "ready" });
    });

    await waitFor(() => expect(screen.getByText("$5.00")).toBeInTheDocument());
    expect(screen.queryByTestId("real-cash-balance-limited")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("navigation: a remount for the same account asks nothing while limited, and a remount for another account never shows the old balance", async () => {
    const fetchMock = stubSequence(() => ok(), () => limited("900"), () => ok({ ...BALANCE_BODY, balanceBaseUnits: "7000000" }));
    const first = render(<CashBalance />);
    await waitFor(() => expect(screen.getByText("$20.00")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByTestId("real-cash-balance-limited");
    first.unmount();

    // Same account, remounted: no request, still limited, no balance.
    const second = render(<CashBalance />);
    await screen.findByTestId("real-cash-balance-limited");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("$20.00")).not.toBeInTheDocument();
    second.unmount();

    // A different account signs in while nothing is mounted, then the page mounts.
    useRealAccountStore.setState({ account: { appUserId: "app-user-2", ownerAddress: "0x4444444444444444444444444444444444444444", safeAddress: "0x5555555555555555555555555555555555555555" }, status: "ready" });
    render(<CashBalance />);
    expect(screen.queryByText("$20.00")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("$7.00")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("no account means nothing is rendered and nothing is asked", () => {
    useRealAccountStore.setState({ account: null });
    const fetchMock = stubSequence(() => ok());
    const { container } = render(<CashBalance />);
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
