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
