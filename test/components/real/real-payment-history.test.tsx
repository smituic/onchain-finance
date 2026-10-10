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

/**
 * Handle Pay Slice D — a handle payment's row names who it was sent to (the
 * payment's stored snapshot); an address payment's row stays an address.
 * Nothing is looked up, and an address is never turned into a name.
 */
describe("RealPaymentHistory — Slice D: recipient identity", () => {
  const SMIT = { handle: "smit", displayName: "Smit Patel" };
  const recipientOf = (id: string) => screen.getByTestId(`real-payment-history-row-${id}`).querySelector('[data-testid="real-payment-history-recipient"]') as HTMLElement;

  beforeEach(() => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready", error: null, hasHydrated: true });
    useRealPaymentHistoryStore.setState({ entries: [], status: "idle", error: null });
    vi.unstubAllGlobals();
  });

  async function renderWith(entries: unknown[]) {
    const fetchMock = stubHistoryOnlyFetch(entries);
    render(<RealPaymentHistory />);
    await waitFor(() => expect(screen.getAllByTestId("real-payment-history-recipient").length).toBe(entries.length));
    return fetchMock;
  }

  it("a handle payment row reads 'To Name (@handle)' and does not show the address", async () => {
    await renderWith([entry({ recipientIdentity: SMIT })]);
    const recipient = recipientOf("payment-attempt-1");
    expect(recipient).toHaveTextContent(/^To\s*Smit Patel\s*\(@smit\)$/);
    expect(recipient).toHaveAttribute("title", "Smit Patel (@smit)");
    expect(screen.getByTestId("real-payment-history-row-payment-attempt-1").textContent).not.toMatch(/0x3333/);
  });

  it("a handle payment with no display name reads 'To @handle'", async () => {
    await renderWith([entry({ recipientIdentity: { handle: "smit", displayName: null } })]);
    expect(recipientOf("payment-attempt-1")).toHaveTextContent(/^To\s*@smit$/);
    expect(screen.getByTestId("real-payment-history-row-payment-attempt-1").textContent).not.toMatch(/0x3333|null/);
  });

  it("a direct-address row is unchanged: 'To 0x3333…3333' (identity null, or absent on an older response)", async () => {
    await renderWith([entry({ id: "a", recipientIdentity: null }), entry({ id: "b" })]);
    for (const id of ["a", "b"]) {
      expect(recipientOf(id)).toHaveTextContent(/^To 0x3333…3333$/);
      expect(recipientOf(id).textContent).not.toContain("@");
    }
  });

  it("a direct-address payment to an address that IS a known person's account still shows the address — next to that person's handle payment", async () => {
    // Same recipient address on both rows; only the one that was PAID BY HANDLE carries an identity.
    const fetchMock = await renderWith([entry({ id: "by-handle", recipientIdentity: SMIT }), entry({ id: "by-address", recipientIdentity: null })]);
    expect(recipientOf("by-handle")).toHaveTextContent(/Smit Patel\s*\(@smit\)/);
    expect(recipientOf("by-address")).toHaveTextContent(/^To 0x3333…3333$/);
    expect(recipientOf("by-address").textContent).not.toMatch(/Smit|@/);
    // Nothing was looked up to decide that: history is the only request.
    expect(fetchMock.mock.calls.every(([input]) => String(input).includes("/api/real/payments/history"))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("the identity is shown whatever the outcome: failed, cancelled, pending, submitted, and unknown rows all name the handle", async () => {
    const states = ["confirmed", "failed", "cancelled", "awaiting_authorization", "submitted", "unknown", "prepared", "signed", "submitting"];
    await renderWith(states.map((state) => entry({ id: state, state, recipientIdentity: SMIT })));
    for (const state of states) {
      expect(recipientOf(state), state).toHaveTextContent(/^To\s*Smit Patel\s*\(@smit\)$/);
    }
    expect(screen.getByTestId("real-payment-history-row-failed")).toHaveTextContent("Failed");
    expect(screen.getByTestId("real-payment-history-row-cancelled")).toHaveTextContent("Cancelled");
  });

  it("a maximum-length name is layout-safe: the name truncates, the @handle and the date never shrink, and the full label stays available", async () => {
    const longest = { handle: "a".repeat(20), displayName: "W".repeat(40) };
    await renderWith([entry({ recipientIdentity: longest })]);
    const recipient = recipientOf("payment-attempt-1");
    const [to, name, handle] = Array.from(recipient.children) as HTMLElement[];

    expect(recipient.className).toMatch(/\bmin-w-0\b/);
    expect(to).toHaveTextContent("To");
    expect(name).toHaveTextContent("W".repeat(40));
    expect(name.className).toMatch(/\btruncate\b/);
    expect(name.className).toMatch(/\bmin-w-0\b/);
    expect(handle).toHaveTextContent(`(@${"a".repeat(20)})`);
    expect(handle.className).toMatch(/\bshrink-0\b/);
    expect(handle.className).not.toMatch(/\btruncate\b/);
    expect(recipient).toHaveAttribute("title", `${"W".repeat(40)} (@${"a".repeat(20)})`);
    expect((recipient.nextElementSibling as HTMLElement).className).toMatch(/\bshrink-0\b/); // the date
  });

  it("a malformed identity falls back to the address — never a half-shown or repaired name", async () => {
    const malformed: unknown[] = [{ handle: "@smit", displayName: "Smit Patel" }, { handle: "Smit", displayName: null }, { displayName: "Smit Patel" }, { handle: "smit", displayName: "" }, { handle: "smit", displayName: "Smit Patel", appUserId: "app-user-2" }, "smit"];
    await renderWith(malformed.map((recipientIdentity, index) => entry({ id: `m${index}`, recipientIdentity })));
    malformed.forEach((recipientIdentity, index) => {
      expect(recipientOf(`m${index}`), JSON.stringify(recipientIdentity)).toHaveTextContent(/^To 0x3333…3333$/);
    });
    expect(screen.getByTestId("real-payment-history").textContent).not.toMatch(/Smit|@|app-user/);
  });

  it("amount, status, date, and transaction details still work on a handle payment row", async () => {
    await renderWith([entry({ recipientIdentity: SMIT, transactionHash: VALID_TX_HASH })]);
    const row = screen.getByTestId("real-payment-history-row-payment-attempt-1");
    expect(row).toHaveTextContent("$1.00");
    expect(row).toHaveTextContent("Sent");
    fireEvent.click(screen.getByText("See transaction details"));
    expect(row).toHaveTextContent(`Transaction: ${VALID_TX_HASH}`);
    const link = screen.getByRole("link", { name: "View on Base Sepolia explorer" });
    expect(link.getAttribute("href")).toContain(VALID_TX_HASH);
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});
