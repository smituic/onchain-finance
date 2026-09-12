import { describe, expect, it } from "vitest";
import {
  applyAction,
  createInitialState,
  getGenesisInvestmentPriceMicroUsd,
  getInvestmentHolding,
  getInvestmentPortfolioValueMicroUsd,
  getInvestmentPriceMicroUsd,
  getInvestPortfolio,
  getNetWorthMicroUsd,
  INVESTMENT_ASSETS,
  toMicroUnits,
  type SimulationState,
} from "@/simulation";

const T0 = 1_700_000_000_000;

function base(): SimulationState {
  return createInitialState(T0);
}

function act(state: SimulationState, action: Parameters<typeof applyAction>[1]) {
  const result = applyAction(state, action, T0);
  if (!result.ok) throw new Error(`action failed: ${result.error}`);
  return result;
}

describe("curated investment universe", () => {
  it("defines exactly Bitcoin, a broad U.S. market fund, and short-term Treasuries", () => {
    expect(Object.keys(INVESTMENT_ASSETS).sort()).toEqual(["BROAD", "BTC", "TBILL"]);
    expect(INVESTMENT_ASSETS.BTC.category).toBe("Crypto");
    expect(INVESTMENT_ASSETS.BROAD.category).toBe("Stocks");
    expect(INVESTMENT_ASSETS.TBILL.category).toBe("Treasuries");
  });

  it("seeds initial simulated prices from the registry", () => {
    const state = base();
    expect(getInvestmentPriceMicroUsd(state, "BTC")).toBe(toMicroUnits(60_000));
    expect(getInvestmentPriceMicroUsd(state, "BROAD")).toBe(toMicroUnits(500));
    expect(getInvestmentPriceMicroUsd(state, "TBILL")).toBe(toMicroUnits(100));
  });
});

describe("initial state", () => {
  it("starts with an empty portfolio", () => {
    const state = base();
    for (const assetId of ["BTC", "BROAD", "TBILL"] as const) {
      expect(state.invest.holdings[assetId]).toEqual({ unitsHeld: 0, costBasisMicroUsd: 0 });
    }
    expect(getInvestPortfolio(state)).toEqual({
      totalValueMicroUsd: 0,
      totalCostBasisMicroUsd: 0,
      totalUnrealizedGainMicroUsd: 0,
      totalUnrealizedGainBps: 0,
    });
  });
});

describe("buying", () => {
  it("buys $500 of Bitcoin at $60,000: exactly 8,333 micro-units, executed at exactly $499.98", () => {
    const result = act(base(), { type: "buy-investment", assetId: "BTC", amount: toMicroUnits(500) });

    expect(result.state.invest.holdings.BTC.unitsHeld).toBe(8_333);
    expect(result.investmentTrade?.unitsTraded).toBe(8_333);

    const executedMicroUsd = 499_980_000;
    expect(result.investmentTrade?.amountMicroUsd).toBe(executedMicroUsd);
    expect(result.state.invest.holdings.BTC.costBasisMicroUsd).toBe(executedMicroUsd);
    // Cash decreases by exactly the executed cost, not the requested $500 —
    // the 2-cent remainder from flooring to whole units stays in cash.
    expect(result.state.balances.USDC).toBe(toMicroUnits(10_000) - executedMicroUsd);

    // Cash decrease must equal the value increase exactly: buying alone
    // cannot change net worth, not even by rounding dust.
    expect(getNetWorthMicroUsd(result.state)).toBe(getNetWorthMicroUsd(base()));
  });

  it("rejects buying more cash than available", () => {
    const result = applyAction(
      base(),
      { type: "buy-investment", assetId: "BTC", amount: toMicroUnits(20_000) },
      T0,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INSUFFICIENT_BALANCE");
  });

  it("rejects zero and negative amounts", () => {
    for (const amount of [0, -1]) {
      const result = applyAction(base(), { type: "buy-investment", assetId: "BTC", amount }, T0);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("INVALID_AMOUNT");
    }
  });

  it("rejects an amount too small to buy even one whole unit", () => {
    // At $60,000/BTC, one micro-unit (1e-6 BTC) costs $0.06 — a fraction of
    // a cent buys none.
    const result = applyAction(base(), { type: "buy-investment", assetId: "BTC", amount: 1 }, T0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_AMOUNT");
  });

  it("produces coherent, additive cost basis across repeated buys", () => {
    let state = base();
    state = act(state, { type: "buy-investment", assetId: "BTC", amount: toMicroUnits(500) }).state;
    state = act(state, { type: "buy-investment", assetId: "BTC", amount: toMicroUnits(500) }).state;

    expect(state.invest.holdings.BTC.unitsHeld).toBe(8_333 * 2);
    expect(state.invest.holdings.BTC.costBasisMicroUsd).toBe(499_980_000 * 2);
  });

  it("buying does not change net worth for a case with no rounding remainder", () => {
    const before = base();
    const after = act(before, { type: "buy-investment", assetId: "BROAD", amount: toMicroUnits(1_000) })
      .state;

    expect(after.invest.holdings.BROAD).toEqual({
      unitsHeld: toMicroUnits(2),
      costBasisMicroUsd: toMicroUnits(1_000),
    });
    expect(getNetWorthMicroUsd(after)).toBe(getNetWorthMicroUsd(before));
  });
});

describe("selling", () => {
  function stateWithBroadPosition(): SimulationState {
    return act(base(), { type: "buy-investment", assetId: "BROAD", amount: toMicroUnits(1_000) }).state;
  }

  it("sells part of a position: proceeds and cost basis move exactly, proportionally", () => {
    const holding = stateWithBroadPosition();
    const result = act(holding, { type: "sell-investment", assetId: "BROAD", amount: toMicroUnits(300) });

    expect(result.investmentTrade?.amountMicroUsd).toBe(toMicroUnits(300));
    expect(result.state.invest.holdings.BROAD).toEqual({
      unitsHeld: toMicroUnits(1.4),
      costBasisMicroUsd: toMicroUnits(700),
    });
    expect(result.state.balances.USDC).toBe(holding.balances.USDC + toMicroUnits(300));
    // Selling at current value cannot change net worth.
    expect(getNetWorthMicroUsd(result.state)).toBe(getNetWorthMicroUsd(holding));
  });

  it("sells a position whose requested amount doesn't divide evenly: credits only the executed proceeds", () => {
    const holding = act(base(), { type: "buy-investment", assetId: "BTC", amount: toMicroUnits(500) })
      .state;
    const before = holding;

    const result = act(holding, { type: "sell-investment", assetId: "BTC", amount: toMicroUnits(250) });
    const trade = result.investmentTrade;
    if (!trade) throw new Error("expected an investment trade receipt");

    // The engine may credit slightly less than the $250 requested (rounded
    // down to whole units), but never more, and never loses track of it.
    expect(trade.amountMicroUsd).toBeLessThanOrEqual(toMicroUnits(250));
    expect(trade.amountMicroUsd).toBeGreaterThan(0);
    expect(result.state.balances.USDC).toBe(before.balances.USDC + trade.amountMicroUsd);

    // The proceeds must equal exactly unitsTraded × price ÷ SCALE — the
    // executed identity the settlement fix guarantees.
    const priceMicroUsd = getInvestmentPriceMicroUsd(before, "BTC");
    const expectedProceeds = Number(
      (BigInt(trade.unitsTraded) * BigInt(priceMicroUsd)) / BigInt(1_000_000),
    );
    expect(trade.amountMicroUsd).toBe(expectedProceeds);

    // No value leaked or was created: net worth is exactly unchanged.
    expect(getNetWorthMicroUsd(result.state)).toBe(getNetWorthMicroUsd(before));
  });

  it("sells the full position exactly: units and cost basis land on zero, not dust", () => {
    const holding = stateWithBroadPosition();
    const fullValue = getInvestmentHolding(holding, "BROAD").currentValueMicroUsd;

    const result = act(holding, { type: "sell-investment", assetId: "BROAD", amount: fullValue });

    expect(result.state.invest.holdings.BROAD).toEqual({ unitsHeld: 0, costBasisMicroUsd: 0 });
    expect(result.investmentTrade?.amountMicroUsd).toBe(fullValue);
    expect(getNetWorthMicroUsd(result.state)).toBe(getNetWorthMicroUsd(holding));
  });

  it("rejects a request for more than the position's current value", () => {
    const holding = stateWithBroadPosition();
    const fullValue = getInvestmentHolding(holding, "BROAD").currentValueMicroUsd;

    const result = applyAction(
      holding,
      { type: "sell-investment", assetId: "BROAD", amount: fullValue + toMicroUnits(50) },
      T0,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INSUFFICIENT_BALANCE");
  });

  it("rejects selling an asset the user doesn't own", () => {
    const result = applyAction(
      base(),
      { type: "sell-investment", assetId: "BTC", amount: toMicroUnits(100) },
      T0,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INSUFFICIENT_BALANCE");
  });

  it("rejects a sell amount larger than a held position is worth, when the asset is also owned elsewhere", () => {
    // Owns BTC, but asks to sell more BROAD value than exists (BROAD unowned).
    const holding = act(base(), { type: "buy-investment", assetId: "BTC", amount: toMicroUnits(500) })
      .state;
    const result = applyAction(
      holding,
      { type: "sell-investment", assetId: "BROAD", amount: toMicroUnits(1) },
      T0,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INSUFFICIENT_BALANCE");
  });

  it("rejects zero and negative amounts", () => {
    const holding = stateWithBroadPosition();
    for (const amount of [0, -1]) {
      const result = applyAction(holding, { type: "sell-investment", assetId: "BROAD", amount }, T0);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("INVALID_AMOUNT");
    }
  });
});

describe("derived valuation", () => {
  it("computes current value, unrealized gain, and percent return from state", () => {
    let state = base();
    state = act(state, { type: "buy-investment", assetId: "BROAD", amount: toMicroUnits(1_000) }).state;
    state = act(state, { type: "simulate-investment-market-move", direction: "up" }).state;

    const holding = getInvestmentHolding(state, "BROAD");
    // BROAD moves 10% per scenario: $1,000 -> $1,100.
    expect(holding.currentValueMicroUsd).toBe(toMicroUnits(1_100));
    expect(holding.unrealizedGainMicroUsd).toBe(toMicroUnits(100));
    expect(holding.unrealizedGainBps).toBe(1_000);
  });

  it("is safe when cost basis is zero (nothing bought yet)", () => {
    const holding = getInvestmentHolding(base(), "BTC");
    expect(holding.currentValueMicroUsd).toBe(0);
    expect(holding.unrealizedGainMicroUsd).toBe(0);
    expect(holding.unrealizedGainBps).toBe(0);
  });

  it("aggregates the whole portfolio", () => {
    let state = base();
    state = act(state, { type: "buy-investment", assetId: "BROAD", amount: toMicroUnits(1_000) }).state;
    state = act(state, { type: "buy-investment", assetId: "TBILL", amount: toMicroUnits(1_000) }).state;

    const portfolio = getInvestPortfolio(state);
    expect(portfolio.totalCostBasisMicroUsd).toBe(toMicroUnits(2_000));
    expect(portfolio.totalValueMicroUsd).toBe(toMicroUnits(2_000));
    expect(getInvestmentPortfolioValueMicroUsd(state)).toBe(portfolio.totalValueMicroUsd);
  });
});

describe("market scenarios", () => {
  it("moves each risk tier by its own magnitude on a market-up scenario", () => {
    const result = act(base(), { type: "simulate-investment-market-move", direction: "up" });

    expect(getInvestmentPriceMicroUsd(result.state, "BTC")).toBe(toMicroUnits(75_000)); // +25%
    expect(getInvestmentPriceMicroUsd(result.state, "BROAD")).toBe(toMicroUnits(550)); // +10%
    expect(getInvestmentPriceMicroUsd(result.state, "TBILL")).toBe(toMicroUnits(101)); // +1%
  });

  it("moves each risk tier by its own magnitude on a market-down scenario", () => {
    const result = act(base(), { type: "simulate-investment-market-move", direction: "down" });

    expect(getInvestmentPriceMicroUsd(result.state, "BTC")).toBe(toMicroUnits(45_000)); // -25%
    expect(getInvestmentPriceMicroUsd(result.state, "BROAD")).toBe(toMicroUnits(450)); // -10%
    expect(getInvestmentPriceMicroUsd(result.state, "TBILL")).toBe(toMicroUnits(99)); // -1%
  });

  it("restores genesis prices on reset", () => {
    let state = base();
    state = act(state, { type: "simulate-investment-market-move", direction: "down" }).state;
    state = act(state, { type: "reset-investment-prices" }).state;

    for (const assetId of ["BTC", "BROAD", "TBILL"] as const) {
      expect(getInvestmentPriceMicroUsd(state, assetId)).toBe(getGenesisInvestmentPriceMicroUsd(assetId));
    }
  });

  it("changes net worth by exactly the holding-value delta a scenario causes", () => {
    const holding = act(base(), { type: "buy-investment", assetId: "BROAD", amount: toMicroUnits(1_000) })
      .state;
    const worthBefore = getNetWorthMicroUsd(holding);
    const valueBefore = getInvestmentHolding(holding, "BROAD").currentValueMicroUsd;

    const after = act(holding, { type: "simulate-investment-market-move", direction: "up" }).state;
    const valueAfter = getInvestmentHolding(after, "BROAD").currentValueMicroUsd;

    expect(getNetWorthMicroUsd(after) - worthBefore).toBe(valueAfter - valueBefore);
  });

  it("never touches the swap pool, ETH's market price, savings, borrowing, or the Practice clock", () => {
    const before = base();
    const after = act(before, { type: "simulate-investment-market-move", direction: "down" }).state;

    expect(after.pool).toEqual(before.pool);
    expect(after.market).toEqual(before.market);
    expect(after.savings).toEqual(before.savings);
    expect(after.borrow).toEqual(before.borrow);
    expect(after.clockOffsetMs).toBe(before.clockOffsetMs);
  });

  it("buying and selling never touch the swap pool, ETH's market price, savings, borrowing, or the clock", () => {
    const before = base();
    let state = act(before, { type: "buy-investment", assetId: "BTC", amount: toMicroUnits(500) }).state;
    state = act(state, { type: "sell-investment", assetId: "BTC", amount: toMicroUnits(100) }).state;

    expect(state.pool).toEqual(before.pool);
    expect(state.market).toEqual(before.market);
    expect(state.savings).toEqual(before.savings);
    expect(state.borrow).toEqual(before.borrow);
    expect(state.clockOffsetMs).toBe(before.clockOffsetMs);
  });
});
