import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { PortfolioView } from "@/components/portfolio/portfolio-view";
import { useSimulationStore } from "@/lib/stores/simulation-store";
import { createInitialState } from "@/simulation";

describe("PortfolioView", () => {
  beforeEach(async () => {
    localStorage.clear();
    useSimulationStore.setState({ state: createInitialState() });
    await act(async () => {
      await useSimulationStore.persist.rehydrate();
    });
  });

  it("shows total portfolio value and per-asset balances", () => {
    render(<PortfolioView />);

    expect(screen.getByTestId("portfolio-value")).toHaveTextContent("$10,000.00");
    expect(screen.getByText("USDC")).toBeInTheDocument();
    expect(screen.getByText("10,000 USDC")).toBeInTheDocument();
    expect(screen.getByText("ETH")).toBeInTheDocument();
    expect(screen.getByText("0 ETH")).toBeInTheDocument();
  });

  it("links to the swap screen", () => {
    render(<PortfolioView />);
    expect(screen.getByRole("link", { name: "Swap" })).toHaveAttribute("href", "/swap");
  });
});
