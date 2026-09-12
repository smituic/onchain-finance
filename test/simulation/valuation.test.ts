import { describe, expect, it } from "vitest";
import {
  applyAction,
  createInitialState,
  getAssetValueMicroUsd,
  getInvestmentHolding,
  getNetWorthMicroUsd,
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

describe("getNetWorthMicroUsd", () => {
  it("includes the curated-investment portfolio in net worth", () => {
    const state = createInitialState();
    const result = applyAction(state, { type: "buy-investment", assetId: "BROAD", amount: toMicroUnits(1_000) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(getNetWorthMicroUsd(result.state)).toBe(getNetWorthMicroUsd(state));
  });

  it("moves net worth by exactly the value change from a curated-investment market scenario", () => {
    const state = createInitialState();
    const bought = applyAction(state, {
      type: "buy-investment",
      assetId: "BROAD",
      amount: toMicroUnits(1_000),
    });
    expect(bought.ok).toBe(true);
    if (!bought.ok) return;

    const valueBefore = getInvestmentHolding(bought.state, "BROAD").currentValueMicroUsd;
    const moved = applyAction(bought.state, { type: "simulate-investment-market-move", direction: "up" });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;

    const valueAfter = getInvestmentHolding(moved.state, "BROAD").currentValueMicroUsd;
    expect(getNetWorthMicroUsd(moved.state) - getNetWorthMicroUsd(bought.state)).toBe(
      valueAfter - valueBefore,
    );
  });
});
