import { describe, expect, it } from "vitest";
import {
  getBorrowPosition,
  getInvestmentHolding,
  getPoolSpotPriceMicroUsd,
  toMicroUnits,
} from "@/simulation";
import { createExperimentState, type ExperimentId } from "@/lib/explore/experiment-state";

const ALL_EXPERIMENT_IDS: ExperimentId[] = ["liquidity", "liquidation", "yield", "risk", "payments"];

describe("createExperimentState", () => {
  it("is deterministic — two calls for the same experiment produce byte-identical state", () => {
    for (const id of ALL_EXPERIMENT_IDS) {
      expect(createExperimentState(id)).toEqual(createExperimentState(id));
    }
  });

  it("never throws for any registered experiment id", () => {
    for (const id of ALL_EXPERIMENT_IDS) {
      expect(() => createExperimentState(id)).not.toThrow();
    }
  });

  it("liquidity: seeds 10 ETH, no cash, and a genesis pool", () => {
    const state = createExperimentState("liquidity");
    expect(state.balances.ETH).toBe(toMicroUnits(10));
    expect(state.balances.USDC).toBe(0);
    // Genesis reserves — untouched by the fixture itself, only by dispatches.
    expect(getPoolSpotPriceMicroUsd(state.pool)).toBe(toMicroUnits(3_000));
  });

  it("liquidation: 2 ETH pledged, exactly $3,000 borrowed — the engine's own max LTV", () => {
    const state = createExperimentState("liquidation");
    const position = getBorrowPosition(state);
    expect(position.collateralEth).toBe(toMicroUnits(2));
    expect(position.debtMicroUsd).toBe(toMicroUnits(3_000));
    expect(position.ltvBps).toBe(5_000);
    expect(position.liquidationPriceMicroUsd).toBe(toMicroUnits(2_000));
    expect(position.health).toBe("safe");
    // Nothing left in the free ETH balance or collateral came from Swap.
    expect(state.balances.ETH).toBe(0);
    expect(state.pool.reserves).toEqual(createExperimentState("liquidity").pool.reserves);
  });

  it("yield: $1,000 already deposited, at exactly zero elapsed time", () => {
    const state = createExperimentState("yield");
    expect(state.savings.balance).toBe(toMicroUnits(1_000));
    expect(state.savings.interestEarnedTotal).toBe(0);
    expect(state.balances.USDC).toBe(0);
  });

  it("risk: ~$1,000 in each curated investment, at genesis prices", () => {
    const state = createExperimentState("risk");
    // Buying floors to whole fixed-point units at the asset's price, so a
    // $1,000 request executes for exactly $1,000 only when $1,000 divides
    // evenly by that price (BROAD at $500, TBILL at $100) — BTC at $60,000
    // leaves a few cents of dust in cash instead, same as the real engine.
    for (const assetId of ["BROAD", "TBILL"] as const) {
      const holding = getInvestmentHolding(state, assetId);
      expect(holding.costBasisMicroUsd).toBe(toMicroUnits(1_000));
      expect(holding.unrealizedGainMicroUsd).toBe(0);
    }
    const btc = getInvestmentHolding(state, "BTC");
    expect(btc.costBasisMicroUsd).toBeLessThanOrEqual(toMicroUnits(1_000));
    expect(btc.costBasisMicroUsd).toBeGreaterThan(toMicroUnits(999));
    expect(btc.unrealizedGainMicroUsd).toBe(0);

    expect(state.balances.USDC).toBeGreaterThanOrEqual(0);
    expect(state.balances.USDC).toBeLessThan(toMicroUnits(1));
  });

  it("payments: $100 cash, nothing sent or requested yet", () => {
    const state = createExperimentState("payments");
    expect(state.balances.USDC).toBe(toMicroUnits(100));
    expect(state.pay.activity).toEqual([]);
    expect(state.pay.requests).toEqual([]);
  });
});
