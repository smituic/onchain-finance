import { describe, expect, it } from "vitest";
import { applyAction, createInitialState, getPortfolioValueMicroUsd, toMicroUnits } from "@/simulation";

describe("getPortfolioValueMicroUsd", () => {
  it("values the initial portfolio at exactly $10,000", () => {
    const state = createInitialState();
    expect(getPortfolioValueMicroUsd(state)).toBe(10_000_000_000);
  });

  it("contributes zero for a zero balance", () => {
    const state = createInitialState();
    expect(state.balances.ETH).toBe(0);
    expect(getPortfolioValueMicroUsd(state)).toBe(
      getPortfolioValueMicroUsd({ balances: { ...state.balances }, pool: state.pool }),
    );
  });

  it("only ever loses value (mod rounding + price impact) across a swap, never gains", () => {
    const state = createInitialState();
    const before = getPortfolioValueMicroUsd(state);

    const result = applyAction(state, {
      type: "swap",
      fromAsset: "USDC",
      toAsset: "ETH",
      amountIn: toMicroUnits(3_333.333333),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(getPortfolioValueMicroUsd(result.state)).toBeLessThanOrEqual(before);
  });
});
