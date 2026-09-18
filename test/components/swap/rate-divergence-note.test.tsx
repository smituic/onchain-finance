import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getRateDivergenceBps, RateDivergenceNote } from "@/components/swap/rate-divergence-note";
import { toMicroUnits } from "@/simulation";

describe("getRateDivergenceBps", () => {
  it("is 0 when the two prices are identical", () => {
    expect(getRateDivergenceBps(toMicroUnits(3_000), toMicroUnits(3_000))).toBe(0);
  });

  it("measures the gap relative to the market price, unsigned, regardless of direction", () => {
    // Pool below market and pool above market by the same absolute gap
    // yield the same divergence.
    expect(getRateDivergenceBps(toMicroUnits(2_000), toMicroUnits(1_800))).toBe(1_000);
    expect(getRateDivergenceBps(toMicroUnits(1_800), toMicroUnits(2_000))).toBe(1_111);
  });
});

describe("RateDivergenceNote", () => {
  it("renders nothing when the prices are at or near genesis (no meaningful gap)", () => {
    const { container } = render(
      <RateDivergenceNote
        marketPriceMicroUsd={toMicroUnits(3_000)}
        poolPriceMicroUsd={toMicroUnits(3_000)}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a gap below the ~1% threshold", () => {
    const { container } = render(
      <RateDivergenceNote
        marketPriceMicroUsd={toMicroUnits(3_000)}
        poolPriceMicroUsd={toMicroUnits(3_020)}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("explains the gap, in the market's own value, once it becomes material", () => {
    render(
      <RateDivergenceNote
        marketPriceMicroUsd={toMicroUnits(1_800)}
        poolPriceMicroUsd={toMicroUnits(3_000)}
      />,
    );

    expect(
      screen.getByText(
        "ETH is valued at $1,800.00 elsewhere in Practice. Swap rates come from the trading pool and can differ.",
      ),
    ).toBeInTheDocument();
  });
});
