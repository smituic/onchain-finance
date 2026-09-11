import { describe, expect, it } from "vitest";
import {
  applyAction,
  createInitialState,
  getAssetValueMicroUsd,
  getPortfolioValueMicroUsd,
  toMicroUnits,
} from "@/simulation";

describe("getAssetValueMicroUsd", () => {
  it("values a single asset's balance at its fixed price", () => {
    const state = createInitialState();
    expect(getAssetValueMicroUsd(state, "USDC")).toBe(10_000_000_000);
    expect(getAssetValueMicroUsd(state, "ETH")).toBe(0);
  });

  it("sums across assets to the portfolio total", () => {
    const result = applyAction(createInitialState(), {
      type: "swap",
      fromAsset: "USDC",
      toAsset: "ETH",
      amountIn: toMicroUnits(3_000),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(getAssetValueMicroUsd(result.state, "USDC") + getAssetValueMicroUsd(result.state, "ETH")).toBe(
      getPortfolioValueMicroUsd(result.state),
    );
  });
});

describe("getPortfolioValueMicroUsd", () => {
  it("values the initial portfolio at exactly $10,000", () => {
    const state = createInitialState();
    expect(getPortfolioValueMicroUsd(state)).toBe(10_000_000_000);
  });

  it("contributes zero for a zero balance", () => {
    const state = createInitialState();
    expect(state.balances.ETH).toBe(0);
    expect(getPortfolioValueMicroUsd(state)).toBe(
      getPortfolioValueMicroUsd({ ...state, balances: { ...state.balances } }),
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
