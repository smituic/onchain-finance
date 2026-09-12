import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { HomeView } from "@/components/home/home-view";
import { useSimulationStore } from "@/lib/stores/simulation-store";
import { createInitialState, toMicroUnits } from "@/simulation";

describe("HomeView", () => {
  beforeEach(async () => {
    localStorage.clear();
    useSimulationStore.setState({ state: createInitialState() });
    await act(async () => {
      await useSimulationStore.persist.rehydrate();
    });
  });

  it("shows the total balance from simulation state", () => {
    render(<HomeView />);
    expect(screen.getByTestId("total-balance")).toHaveTextContent("$10,000.00");
  });

  it("derives Cash and Crypto from actual balances, and shows nothing invented for Savings or Investments", () => {
    render(<HomeView />);

    expect(screen.getByTestId("value-row-cash")).toHaveTextContent("$10,000.00");
    expect(screen.getByTestId("value-row-cash")).toHaveTextContent("10,000 USDC");
    expect(screen.getByTestId("value-row-crypto")).toHaveTextContent("$0.00");
    expect(screen.getByTestId("value-row-crypto")).toHaveTextContent("0 ETH");

    // No engine exists for these yet — they must read as empty, not populated.
    expect(screen.getByTestId("value-row-savings")).toHaveTextContent("$0.00");
    expect(screen.getByTestId("value-row-investments")).toHaveTextContent("$0.00");
  });

  it("reflects a swap in Cash, Crypto, and the total", async () => {
    await act(async () => {
      useSimulationStore.getState().dispatch({
        type: "swap",
        fromAsset: "USDC",
        toAsset: "ETH",
        amountIn: toMicroUnits(3_000),
      });
    });

    render(<HomeView />);

    expect(screen.getByTestId("value-row-cash")).toHaveTextContent("$7,000.00");
    expect(screen.getByTestId("value-row-crypto")).toHaveTextContent("$2,884.61");
    expect(screen.getByTestId("value-row-crypto")).toHaveTextContent("0.961538 ETH");
    expect(screen.getByTestId("total-balance")).toHaveTextContent("$9,884.61");
  });

  it("moves money between Cash and Savings without changing the total", async () => {
    const { unmount } = render(<HomeView />);
    const totalBefore = screen.getByTestId("total-balance").textContent;
    unmount();

    await act(async () => {
      useSimulationStore.getState().dispatch({
        type: "deposit-to-savings",
        amount: toMicroUnits(1_000),
      });
    });

    render(<HomeView />);

    expect(screen.getByTestId("value-row-cash")).toHaveTextContent("$9,000.00");
    expect(screen.getByTestId("value-row-savings")).toHaveTextContent("$1,000.00");
    expect(screen.getByTestId("value-row-savings")).toHaveTextContent("Earning interest");
    // Moving money between your own pockets can't make you richer.
    expect(screen.getByTestId("total-balance")).toHaveTextContent(totalBefore as string);
  });

  it("grows the total once savings have earned interest", async () => {
    await act(async () => {
      useSimulationStore.getState().dispatch({
        type: "deposit-to-savings",
        amount: toMicroUnits(1_000),
      });
      useSimulationStore.getState().dispatch({ type: "advance-practice-time" });
    });

    render(<HomeView />);

    // $10,000 + 4.00% a year on $1,000 for 30 days ($3.287671).
    expect(screen.getByTestId("total-balance")).toHaveTextContent("$10,003.29");
    expect(screen.getByTestId("value-row-savings")).toHaveTextContent("$1,003.29");
  });

  it("borrowing hands over cash and a debt, leaving net worth unchanged", async () => {
    await act(async () => {
      const base = useSimulationStore.getState().state;
      useSimulationStore.setState({
        state: { ...base, balances: { ...base.balances, ETH: toMicroUnits(1) } },
      });
      useSimulationStore.getState().dispatch({ type: "add-collateral", amount: toMicroUnits(1) });
    });

    const { unmount } = render(<HomeView />);
    const beforeBorrowing = screen.getByTestId("total-balance").textContent;
    unmount();

    await act(async () => {
      useSimulationStore.getState().dispatch({ type: "borrow-cash", amount: toMicroUnits(1_000) });
    });

    render(<HomeView />);

    expect(screen.getByTestId("value-row-cash")).toHaveTextContent("$11,000.00");
    expect(screen.getByTestId("value-row-borrowed")).toHaveTextContent("−$1,000.00");
    // $10,000 cash + $3,000 of ETH, and borrowing can't change it.
    expect(screen.getByTestId("total-balance")).toHaveTextContent(beforeBorrowing as string);
    expect(screen.getByTestId("total-balance")).toHaveTextContent("$13,000.00");
    expect(screen.getByText("What you're worth")).toBeInTheDocument();
  });

  it("counts pledged collateral as crypto the user still owns", async () => {
    await act(async () => {
      const base = useSimulationStore.getState().state;
      useSimulationStore.setState({
        state: { ...base, balances: { ...base.balances, ETH: toMicroUnits(2) } },
      });
      useSimulationStore.getState().dispatch({ type: "add-collateral", amount: toMicroUnits(1) });
    });

    render(<HomeView />);

    expect(screen.getByTestId("value-row-crypto")).toHaveTextContent("$6,000.00");
    expect(screen.getByTestId("value-row-crypto")).toHaveTextContent("2 ETH");
    expect(screen.getByTestId("value-row-crypto")).toHaveTextContent("set aside for your loan");
  });

  it("buying an investment moves Cash into Investments without changing net worth", async () => {
    const { unmount } = render(<HomeView />);
    const totalBefore = screen.getByTestId("total-balance").textContent;
    unmount();

    await act(async () => {
      useSimulationStore.getState().dispatch({
        type: "buy-investment",
        assetId: "BROAD",
        amount: toMicroUnits(1_000),
      });
    });

    render(<HomeView />);

    expect(screen.getByTestId("value-row-cash")).toHaveTextContent("$9,000.00");
    expect(screen.getByTestId("value-row-investments")).toHaveTextContent("$1,000.00");
    expect(screen.getByTestId("total-balance")).toHaveTextContent(totalBefore as string);
  });

  it("selling an investment at current value moves it back to Cash without changing net worth", async () => {
    await act(async () => {
      useSimulationStore.getState().dispatch({
        type: "buy-investment",
        assetId: "BROAD",
        amount: toMicroUnits(1_000),
      });
    });

    const { unmount } = render(<HomeView />);
    const totalBefore = screen.getByTestId("total-balance").textContent;
    unmount();

    await act(async () => {
      useSimulationStore.getState().dispatch({
        type: "sell-investment",
        assetId: "BROAD",
        amount: toMicroUnits(1_000),
      });
    });

    render(<HomeView />);

    expect(screen.getByTestId("value-row-cash")).toHaveTextContent("$10,000.00");
    expect(screen.getByTestId("value-row-investments")).toHaveTextContent("$0.00");
    expect(screen.getByTestId("total-balance")).toHaveTextContent(totalBefore as string);
  });

  it("moves net worth when a curated-investment market scenario changes holding value", async () => {
    await act(async () => {
      useSimulationStore.getState().dispatch({
        type: "buy-investment",
        assetId: "BROAD",
        amount: toMicroUnits(1_000),
      });
      useSimulationStore.getState().dispatch({ type: "simulate-investment-market-move", direction: "up" });
    });

    render(<HomeView />);

    // BROAD moves 10% per scenario: $1,000 -> $1,100, so net worth rises by $100.
    expect(screen.getByTestId("value-row-investments")).toHaveTextContent("$1,100.00");
    expect(screen.getByTestId("total-balance")).toHaveTextContent("$10,100.00");
  });

  it("drops net worth when the simulated ETH price falls", async () => {
    await act(async () => {
      const base = useSimulationStore.getState().state;
      useSimulationStore.setState({
        state: { ...base, balances: { ...base.balances, ETH: toMicroUnits(1) } },
      });
      useSimulationStore
        .getState()
        .dispatch({ type: "simulate-eth-price-change", changeBps: -4_000 });
    });

    render(<HomeView />);

    expect(screen.getByTestId("value-row-crypto")).toHaveTextContent("$1,800.00");
    expect(screen.getByTestId("total-balance")).toHaveTextContent("$11,800.00");
  });

  it("sending a Pay payment decreases Cash and total net worth by exactly the amount", async () => {
    const { unmount } = render(<HomeView />);
    const totalBefore = screen.getByTestId("total-balance").textContent;
    unmount();

    await act(async () => {
      useSimulationStore.getState().dispatch({ type: "send-payment", contactId: "maya", amount: toMicroUnits(50) });
    });

    render(<HomeView />);

    expect(screen.getByTestId("value-row-cash")).toHaveTextContent("$9,950.00");
    expect(totalBefore).toBe("$10,000.00");
    expect(screen.getByTestId("total-balance")).toHaveTextContent("$9,950.00");
  });

  it("receiving and depositing Pay Cash each increase Cash and total net worth by exactly the amount", async () => {
    await act(async () => {
      useSimulationStore.getState().dispatch({ type: "receive-payment", contactId: "jordan", amount: toMicroUnits(25) });
    });

    render(<HomeView />);
    expect(screen.getByTestId("value-row-cash")).toHaveTextContent("$10,025.00");
    expect(screen.getByTestId("total-balance")).toHaveTextContent("$10,025.00");
  });

  it("depositing Pay Cash increases Cash and total net worth by exactly the amount", async () => {
    await act(async () => {
      useSimulationStore.getState().dispatch({ type: "deposit-cash", amount: toMicroUnits(200) });
    });

    render(<HomeView />);
    expect(screen.getByTestId("value-row-cash")).toHaveTextContent("$10,200.00");
    expect(screen.getByTestId("total-balance")).toHaveTextContent("$10,200.00");
  });

  it("creating a Pay request leaves Cash and total net worth unchanged", async () => {
    const { unmount } = render(<HomeView />);
    const totalBefore = screen.getByTestId("total-balance").textContent;
    unmount();

    await act(async () => {
      useSimulationStore.getState().dispatch({
        type: "create-payment-request",
        contactId: "alex",
        amount: toMicroUnits(40),
      });
    });

    render(<HomeView />);
    expect(screen.getByTestId("value-row-cash")).toHaveTextContent("$10,000.00");
    expect(screen.getByTestId("total-balance")).toHaveTextContent(totalBefore as string);
  });

  it("paying a Pay request increases Cash and total net worth exactly once", async () => {
    let requestId = "";
    await act(async () => {
      const result = useSimulationStore.getState().dispatch({
        type: "create-payment-request",
        contactId: "alex",
        amount: toMicroUnits(40),
      });
      requestId = result.ok ? result.paymentRequest!.id : "";
    });

    await act(async () => {
      useSimulationStore.getState().dispatch({ type: "complete-payment-request", requestId });
    });

    const { unmount } = render(<HomeView />);
    expect(screen.getByTestId("value-row-cash")).toHaveTextContent("$10,040.00");
    expect(screen.getByTestId("total-balance")).toHaveTextContent("$10,040.00");
    unmount();

    await act(async () => {
      const second = useSimulationStore.getState().dispatch({ type: "complete-payment-request", requestId });
      expect(second.ok).toBe(false);
    });

    render(<HomeView />);
    // A second attempt cannot inflate Cash/net worth further.
    expect(screen.getByTestId("value-row-cash")).toHaveTextContent("$10,040.00");
    expect(screen.getByTestId("total-balance")).toHaveTextContent("$10,040.00");
  });

  it("offers the primary actions", () => {
    render(<HomeView />);

    const expected: [string, string][] = [
      ["Pay", "/pay"],
      ["Save", "/save"],
      ["Invest", "/invest"],
      ["Swap", "/swap"],
      ["Borrow", "/borrow"],
    ];
    for (const [label, href] of expected) {
      expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", href);
    }
  });

  it("links into Explore experiments", () => {
    render(<HomeView />);

    expect(screen.getByRole("link", { name: "All experiments" })).toHaveAttribute("href", "/explore");
    expect(screen.getByText("Why do large trades move prices?")).toBeInTheDocument();
  });

  it("shows an honest empty state where activity history will go", () => {
    render(<HomeView />);
    expect(screen.getByText("No activity yet")).toBeInTheDocument();
  });

  it("does not show a balance before the store has hydrated", () => {
    act(() => {
      useSimulationStore.setState({ hasHydrated: false });
    });

    render(<HomeView />);
    expect(screen.queryByTestId("total-balance")).not.toBeInTheDocument();
  });
});
