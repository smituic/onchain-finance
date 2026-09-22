import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RealPaymentHistory } from "@/components/real/real-payment-history";
import { useRealAccountStore } from "@/lib/stores/real-account-store";
import { useRealPaymentHistoryStore } from "@/lib/stores/real-payment-history-store";

const ACCOUNT = { appUserId: "app-user-1", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222" };
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const VALID_TX_HASH = `0x${"1234567890abcdef".repeat(4)}`;

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: "payment-attempt-1",
    recipient: RECIPIENT,
    amountBaseUnits: "1000000",
    state: "confirmed",
    transactionHash: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:05.000Z",
    ...overrides,
  };
}

/**
 * Throws for anything other than GET .../history. Note this does NOT fail a
 * test by itself: the history store's own try/catch turns a thrown fetch
 * error into an ordinary "error" status, not an uncaught exception — so
 * tests that need to prove no other endpoint was ever called assert
 * directly on fetchMock.mock.calls (see the Refresh and mount tests below),
 * rather than relying on this throw to surface as a failure on its own.
 */
function stubHistoryOnlyFetch(entries: unknown[]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET" || !url.includes("/api/real/payments/history")) {
      throw new Error(`Unexpected fetch in history component: ${method} ${url}`);
    }
    return new Response(JSON.stringify({ entries }), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("RealPaymentHistory", () => {
  beforeEach(() => {
    useRealAccountStore.setState({ account: null, status: "idle", error: null, hasHydrated: true });
    useRealPaymentHistoryStore.setState({ entries: [], status: "idle", error: null });
    vi.unstubAllGlobals();
  });

  it("renders nothing when there is no signed-in account", () => {
    const { container } = render(<RealPaymentHistory />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a loading state, then an empty state when there are no payments yet", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    stubHistoryOnlyFetch([]);

    render(<RealPaymentHistory />);
    expect(screen.getByLabelText("Loading your recent payments")).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText(/No payments yet/)).toBeInTheDocument());
  });

  it("shows an error state with retry on a non-2xx response", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } })));

    render(<RealPaymentHistory />);
    await waitFor(() => expect(screen.getByText(/Couldn.t load your recent payments/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("renders a confirmed payment as Sent", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    stubHistoryOnlyFetch([entry({ state: "confirmed" })]);

    render(<RealPaymentHistory />);
    await waitFor(() => expect(screen.getByText("Sent")).toBeInTheDocument());
  });

  it("renders a cancelled payment as Cancelled", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    stubHistoryOnlyFetch([entry({ id: "payment-attempt-2", state: "cancelled" })]);

    render(<RealPaymentHistory />);
    await waitFor(() => expect(screen.getByText("Cancelled")).toBeInTheDocument());
  });

  it("renders an unknown attempt as a non-final 'Checking status', never Failed", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    stubHistoryOnlyFetch([entry({ id: "payment-attempt-3", state: "unknown" })]);

    render(<RealPaymentHistory />);
    await waitFor(() => expect(screen.getByText("Checking status")).toBeInTheDocument());
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
  });

  it("only shows transaction details when a valid transaction hash is present", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    stubHistoryOnlyFetch([
      entry({ id: "payment-attempt-4", state: "confirmed", transactionHash: VALID_TX_HASH }),
      entry({ id: "payment-attempt-5", state: "submitted", transactionHash: null }),
    ]);

    render(<RealPaymentHistory />);
    await waitFor(() => expect(screen.getAllByText("See transaction details")).toHaveLength(1));
  });

  it("renders the explorer link with the fixed origin, target=_blank, and rel=noopener noreferrer for a valid hash", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    stubHistoryOnlyFetch([entry({ state: "confirmed", transactionHash: VALID_TX_HASH })]);

    render(<RealPaymentHistory />);
    fireEvent.click(await screen.findByRole("button", { name: "See transaction details" }));

    const link = await screen.findByRole("link", { name: "View on Base Sepolia explorer" });
    expect(link).toHaveAttribute("href", `https://sepolia.basescan.org/tx/${VALID_TX_HASH}`);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it.each([
    ["too short", "0x1234"],
    ["missing 0x prefix", "1234567890abcdef".repeat(4)],
    ["non-hex characters", `0x${"g".repeat(64)}`],
  ])("does not render transaction details for a malformed hash (%s)", async (_label, badHash) => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    stubHistoryOnlyFetch([entry({ state: "confirmed", transactionHash: badHash })]);

    render(<RealPaymentHistory />);
    await waitFor(() => expect(screen.getByText("Sent")).toBeInTheDocument());
    expect(screen.queryByText("See transaction details")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("formats amountBaseUnits \"1000000\" as $1.00", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    stubHistoryOnlyFetch([entry({ amountBaseUnits: "1000000" })]);

    render(<RealPaymentHistory />);
    await waitFor(() => expect(screen.getByText("$1.00")).toBeInTheDocument());
  });

  it("a 401 response shows the unauthenticated state, not a fabricated empty list", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Not authenticated." }), { status: 401, headers: { "content-type": "application/json" } })));

    render(<RealPaymentHistory />);
    await waitFor(() => expect(screen.getByText(/Sign in to see your recent payments/)).toBeInTheDocument());
    expect(screen.queryByText(/No payments yet/)).not.toBeInTheDocument();
  });

  it("the Refresh button re-fetches history and never calls prepare/submit/cancel/status", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    const fetchMock = stubHistoryOnlyFetch([entry()]);

    render(<RealPaymentHistory />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    for (const call of fetchMock.mock.calls) {
      const url = typeof call[0] === "string" ? call[0] : call[0].toString();
      expect(url).toContain("/api/real/payments/history");
    }
  });

  it("mounting the component never calls anything but GET .../history", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    const fetchMock = stubHistoryOnlyFetch([entry()]);

    render(<RealPaymentHistory />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[1]?.method ?? "GET").toBe("GET");
  });

  it("pre-2f hardening: switching to a different account's address never leaves the prior account's history on screen", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    stubHistoryOnlyFetch([entry({ id: "payment-attempt-account-a", state: "confirmed" })]);
    render(<RealPaymentHistory />);
    await waitFor(() => expect(screen.getByTestId("real-payment-history-row-payment-attempt-account-a")).toBeInTheDocument());

    const ACCOUNT_B = { appUserId: "app-user-2", ownerAddress: "0x4444444444444444444444444444444444444444", safeAddress: "0x5555555555555555555555555555555555555555" };
    let resolveSecondFetch: (value: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (resolveSecondFetch = resolve))),
    );

    act(() => {
      useRealAccountStore.setState({ account: ACCOUNT_B, status: "ready" });
    });

    // Before B's fetch has resolved, A's row must already be gone.
    expect(screen.queryByTestId("real-payment-history-row-payment-attempt-account-a")).not.toBeInTheDocument();

    resolveSecondFetch(
      new Response(JSON.stringify({ entries: [entry({ id: "payment-attempt-account-b" })] }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    await waitFor(() => expect(screen.getByTestId("real-payment-history-row-payment-attempt-account-b")).toBeInTheDocument());
  });
});
