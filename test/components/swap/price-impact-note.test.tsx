import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PriceImpactNote } from "@/components/swap/price-impact-note";
import type { SwapReceipt } from "@/simulation";

const baseReceipt: SwapReceipt = {
  amountOut: 961_538,
  referenceAmountOut: 1_000_000,
  referencePriceMicroUsd: 3_000_000_000,
  executionPriceMicroUsd: 3_120_000_000,
  priceImpactBps: 400,
};

describe("PriceImpactNote", () => {
  it("renders nothing for a trade below the meaningful-impact threshold", () => {
    const receipt: SwapReceipt = { ...baseReceipt, priceImpactBps: 9 };
    const { container } = render(<PriceImpactNote receipt={receipt} toAsset="ETH" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the collapsed plain-language line and toggle for a trade at/above the threshold", () => {
    render(<PriceImpactNote receipt={{ ...baseReceipt, priceImpactBps: 10 }} toAsset="ETH" />);

    expect(
      screen.getByText("You're getting a little less than the current rate — larger trades move the price more."),
    ).toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: /why did i receive less/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/at the current rate/i)).not.toBeInTheDocument();
  });

  it("expands to show the reference/actual amounts and the named price-impact term on click", () => {
    render(<PriceImpactNote receipt={baseReceipt} toAsset="ETH" />);

    const toggle = screen.getByRole("button", { name: /why did i receive less/i });
    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/you'd expect ≈ 1 ETH\. This trade receives 0\.961538 ETH instead\./)).toBeInTheDocument();
    expect(screen.getByText(/trades are filled from the pool's available funds/i)).toBeInTheDocument();
    expect(screen.getByText(/this is called price impact\. Here, it moved the price by 4\.00%\./i)).toBeInTheDocument();
  });

  it("collapses again on a second click, removing the detail panel", () => {
    render(<PriceImpactNote receipt={baseReceipt} toAsset="ETH" />);

    const toggle = screen.getByRole("button", { name: /why did i receive less/i });
    fireEvent.click(toggle);
    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/at the current rate/i)).not.toBeInTheDocument();
  });
});
