import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { InvestView } from "@/components/invest/invest-view";
import { useSimulationStore } from "@/lib/stores/simulation-store";
import { createInitialState, toMicroUnits } from "@/simulation";

async function resetStore() {
  localStorage.clear();
  useSimulationStore.setState({ state: createInitialState() });
  await act(async () => {
    await useSimulationStore.persist.rehydrate();
  });
}

function selectAsset(testId: string) {
  fireEvent.click(screen.getByTestId(testId));
}

function buy(amount: string) {
  fireEvent.click(screen.getByRole("button", { name: "Buy" }));
  fireEvent.change(screen.getByLabelText(/^Buy /), { target: { value: amount } });
  fireEvent.click(screen.getByRole("button", { name: "Buy" }));
}

function sell(amount: string) {
  fireEvent.click(screen.getByRole("button", { name: "Sell" }));
  fireEvent.change(screen.getByLabelText(/^Sell /), { target: { value: amount } });
  fireEvent.click(screen.getByRole("button", { name: "Sell" }));
}

describe("InvestView", () => {
  beforeEach(resetStore);

  it("shows a useful empty state with the curated universe already browsable", () => {
    render(<InvestView />);

    expect(screen.getByTestId("invest-portfolio-value")).toHaveTextContent("$0.00");
    expect(
      screen.getByText("Choose an investment below and try putting some simulated cash into it."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Your investments")).not.toBeInTheDocument();

    expect(screen.getByTestId("asset-BTC")).toHaveTextContent("Bitcoin");
    expect(screen.getByTestId("asset-BROAD")).toHaveTextContent("U.S. Stock Market");
    expect(screen.getByTestId("asset-TBILL")).toHaveTextContent("Short-Term Treasuries");
  });

  it("opens an investment's detail from the curated list", () => {
    render(<InvestView />);
    selectAsset("asset-BTC");

    expect(screen.getByRole("heading", { name: "Bitcoin" })).toBeInTheDocument();
    expect(screen.getByTestId("value-row-price")).toHaveTextContent("$60,000.00");
    expect(screen.getByText(/Higher risk/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buy" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sell" })).not.toBeInTheDocument();
  });

  it("buys an investment, settling the executed cost rather than the requested amount", () => {
    render(<InvestView />);
    selectAsset("asset-BTC");
    buy("500");

    expect(screen.getByRole("status")).toHaveTextContent("Bought $499.98 of Bitcoin.");
    expect(useSimulationStore.getState().state.invest.holdings.BTC.unitsHeld).toBe(8_333);
    expect(useSimulationStore.getState().state.balances.USDC).toBe(toMicroUnits(10_000) - 499_980_000);
    expect(screen.getByTestId("value-row-you-own")).toHaveTextContent("$499.98");
  });

  it("rejects investing more cash than is available", () => {
    render(<InvestView />);
    selectAsset("asset-BTC");
    buy("20000");

    expect(screen.getByText("You don't have that much cash.")).toBeInTheDocument();
    expect(useSimulationStore.getState().state.invest.holdings.BTC.unitsHeld).toBe(0);
  });

  it("rejects a zero or unparseable amount", () => {
    render(<InvestView />);
    selectAsset("asset-BTC");
    fireEvent.click(screen.getByRole("button", { name: "Buy" }));
    fireEvent.change(screen.getByLabelText(/^Buy /), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Buy" }));

    expect(screen.getByText("Enter an amount greater than zero.")).toBeInTheDocument();
  });

  it("lists a purchased holding back on the browse screen, with its return", () => {
    render(<InvestView />);
    selectAsset("asset-BROAD");
    buy("1000");
    fireEvent.click(screen.getByRole("button", { name: "Back to all investments" }));

    expect(screen.getByText("Your investments")).toBeInTheDocument();
    expect(screen.getByTestId("holding-BROAD")).toHaveTextContent("U.S. Stock Market");
    expect(screen.getByTestId("holding-BROAD")).toHaveTextContent("$1,000.00");
    expect(screen.getByTestId("invest-portfolio-value")).toHaveTextContent("$1,000.00");
  });

  it("sells part of a position, crediting exact proceeds and reducing cost basis proportionally", () => {
    render(<InvestView />);
    selectAsset("asset-BROAD");
    buy("1000");
    sell("300");

    expect(screen.getByRole("status")).toHaveTextContent("Sold $300.00 of U.S. Stock Market.");
    expect(useSimulationStore.getState().state.invest.holdings.BROAD).toEqual({
      unitsHeld: toMicroUnits(1.4),
      costBasisMicroUsd: toMicroUnits(700),
    });
    expect(useSimulationStore.getState().state.balances.USDC).toBe(
      toMicroUnits(10_000) - toMicroUnits(1_000) + toMicroUnits(300),
    );
  });

  it("cannot sell more than the position is worth", () => {
    render(<InvestView />);
    selectAsset("asset-BROAD");
    buy("1000");
    sell("5000");

    expect(screen.getByText("You don't have that much invested.")).toBeInTheDocument();
  });

  it("sells a full position with one tap, leaving nothing behind", () => {
    render(<InvestView />);
    selectAsset("asset-BROAD");
    buy("1000");

    fireEvent.click(screen.getByRole("button", { name: "Sell" }));
    fireEvent.click(screen.getByRole("button", { name: "Sell all" }));

    expect(screen.getByRole("status")).toHaveTextContent("Sold all of your U.S. Stock Market.");
    expect(useSimulationStore.getState().state.invest.holdings.BROAD).toEqual({
      unitsHeld: 0,
      costBasisMicroUsd: 0,
    });
    // No longer owned, so the detail view drops back to just the Buy action.
    expect(screen.queryByRole("button", { name: "Sell" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to all investments" }));
    expect(screen.queryByText("Your investments")).not.toBeInTheDocument();
  });

  it("moves prices with a market scenario, differently per risk tier, and resets them", () => {
    render(<InvestView />);

    expect(screen.getByTestId("value-row-bitcoin")).toHaveTextContent("$60,000.00");
    expect(screen.getByTestId("value-row-u.s.-stock-market")).toHaveTextContent("$500.00");
    expect(screen.getByTestId("value-row-short-term-treasuries")).toHaveTextContent("$100.00");

    fireEvent.click(screen.getByRole("button", { name: "Market rises" }));

    expect(screen.getByTestId("value-row-bitcoin")).toHaveTextContent("$75,000.00");
    expect(screen.getByTestId("value-row-u.s.-stock-market")).toHaveTextContent("$550.00");
    expect(screen.getByTestId("value-row-short-term-treasuries")).toHaveTextContent("$101.00");

    fireEvent.click(screen.getByRole("button", { name: "Reset prices" }));

    expect(screen.getByTestId("value-row-bitcoin")).toHaveTextContent("$60,000.00");
    expect(screen.queryByRole("button", { name: "Reset prices" })).not.toBeInTheDocument();
  });

  it("makes the tokenization explainer accessible from Invest", () => {
    render(<InvestView />);

    expect(screen.getByText("How can traditional investments exist on-chain?")).toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: /does owning a token mean/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/doesn't by itself give you legal ownership/)).toBeInTheDocument();
  });
});
