import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { SIMULATION_STORE_NAME, useSimulationStore } from "@/lib/stores/simulation-store";
import { createInitialState, toMicroUnits, type SimulationState } from "@/simulation";
import { LiquidityExperiment } from "@/components/explore/experiments/liquidity-experiment";
import { LiquidationExperiment } from "@/components/explore/experiments/liquidation-experiment";
import { YieldExperiment } from "@/components/explore/experiments/yield-experiment";
import { RiskExperiment } from "@/components/explore/experiments/risk-experiment";
import { PaymentsExperiment } from "@/components/explore/experiments/payments-experiment";

/**
 * A deliberately non-default main Practice portfolio — cash, ETH, savings,
 * an open loan, and an investment holding — so this proves isolation for a
 * real user's state, not just for a pristine store nobody has touched yet.
 */
function buildNonDefaultMainState(): SimulationState {
  const base = createInitialState(1_700_000_000_000);
  return {
    ...base,
    balances: { ...base.balances, USDC: toMicroUnits(500), ETH: toMicroUnits(3) },
    savings: {
      balance: toMicroUnits(2_000),
      interestEarnedTotal: toMicroUnits(50),
      lastAccruedAt: 1_700_000_000_000,
    },
    borrow: { collateralEth: toMicroUnits(1), debtMicroUsd: toMicroUnits(1_000) },
    invest: {
      holdings: {
        ...base.invest.holdings,
        BTC: { unitsHeld: toMicroUnits(0.01), costBasisMicroUsd: toMicroUnits(600) },
      },
    },
  };
}

const EXPERIMENTS: [string, () => React.JSX.Element][] = [
  ["Liquidity", LiquidityExperiment],
  ["Liquidation", LiquidationExperiment],
  ["Yield", YieldExperiment],
  ["Risk", RiskExperiment],
  ["Payments", PaymentsExperiment],
];

describe("Explore sandbox isolation", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it.each(EXPERIMENTS)(
    "%s never mutates the main Practice store or localStorage, however it's used",
    (_name, Component) => {
      const mainState = buildNonDefaultMainState();
      useSimulationStore.setState({ state: mainState, hasHydrated: true });
      const storedBefore = localStorage.getItem(SIMULATION_STORE_NAME);

      render(<Component />);

      // Click every control the sandbox renders, twice over — the second
      // pass catches buttons (like "reset", or a request's "mark paid")
      // that only appear once the first pass's clicks have run.
      for (let pass = 0; pass < 2; pass++) {
        for (const button of screen.getAllByRole("button")) {
          fireEvent.click(button);
        }
      }

      // Reference equality: if this holds, the store's `set()` was never
      // called at all — the strongest possible proof of isolation.
      expect(useSimulationStore.getState().state).toBe(mainState);
      // Value equality as well, in case a future refactor of this test
      // ever stops asserting reference equality.
      expect(useSimulationStore.getState().state).toEqual(mainState);
      expect(localStorage.getItem(SIMULATION_STORE_NAME)).toBe(storedBefore);
    },
  );

  it("an Explore reset never resets the user's real Practice portfolio", () => {
    const mainState = buildNonDefaultMainState();
    useSimulationStore.setState({ state: mainState, hasHydrated: true });

    render(<LiquidationExperiment />);
    fireEvent.click(screen.getByRole("button", { name: "ETH falls 40%" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset experiment" }));

    expect(useSimulationStore.getState().state).toBe(mainState);
  });
});
