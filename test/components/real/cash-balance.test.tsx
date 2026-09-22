import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CashBalance } from "@/components/real/cash-balance";
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
