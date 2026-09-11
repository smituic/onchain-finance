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
