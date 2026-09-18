import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LiquidityExperiment } from "@/components/explore/experiments/liquidity-experiment";

describe("LiquidityExperiment", () => {
  it("starts with 10 ETH worth $30,000, and no reset button yet", () => {
    render(<LiquidityExperiment />);
    expect(screen.getByText("$30,000.00")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset experiment" })).not.toBeInTheDocument();
  });

  it("a small sale lands close to the going rate", () => {
    render(<LiquidityExperiment />);
    fireEvent.click(screen.getByRole("button", { name: "Sell 0.5 ETH" }));

    expect(screen.getByText("What changed")).toBeInTheDocument();
    // referenceAmountOut $1,500.00, amountOut $1,470.59 — a small, not huge, gap.
    expect(screen.getByText(/\$1,500\.00/)).toBeInTheDocument();
    expect(screen.getByText(/\$1,470\.59/)).toBeInTheDocument();
  });

  it("a much larger sale has a meaningfully larger price impact than a small one", () => {
    render(<LiquidityExperiment />);

    fireEvent.click(screen.getByRole("button", { name: "Sell 0.5 ETH" }));
    const smallImpactText = screen.getByText(/price impact\./).textContent ?? "";
    const smallImpactMatch = smallImpactText.match(/(\d+\.\d+)% price impact/);

    fireEvent.click(screen.getByRole("button", { name: "Reset experiment" }));
    fireEvent.click(screen.getByRole("button", { name: "Sell all remaining ETH" }));
    const largeImpactText = screen.getByText(/price impact\./).textContent ?? "";
    const largeImpactMatch = largeImpactText.match(/(\d+\.\d+)% price impact/);

    expect(smallImpactMatch).not.toBeNull();
    expect(largeImpactMatch).not.toBeNull();
    expect(Number(largeImpactMatch![1])).toBeGreaterThan(Number(smallImpactMatch![1]));
  });

  it("selling all 10 ETH receives materially less than its $30,000 quoted value", () => {
    render(<LiquidityExperiment />);
    fireEvent.click(screen.getByRole("button", { name: "Sell all remaining ETH" }));

    // Selling the full 10 ETH against 75,000/25 reserves nets exactly $21,428.57.
    expect(screen.getByText(/\$21,428\.57/)).toBeInTheDocument();
    expect(screen.getByText("ETH remaining")).toBeInTheDocument();
    expect(screen.getByText("0 ETH")).toBeInTheDocument();
  });

  it("reset restores the starting fixture", () => {
    render(<LiquidityExperiment />);
    fireEvent.click(screen.getByRole("button", { name: "Sell 2 ETH" }));
    expect(screen.getByText("What changed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset experiment" }));

    expect(screen.getByText("$30,000.00")).toBeInTheDocument();
    expect(screen.queryByText("What changed")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset experiment" })).not.toBeInTheDocument();
  });

  it("links to the full Swap feature", () => {
    render(<LiquidityExperiment />);
    expect(screen.getByRole("link", { name: "Try it in Swap" })).toHaveAttribute("href", "/swap");
  });
});
