import type { SimulationState } from "./types";
import { toMicroUnits } from "./money";
import { createInitialPoolReserves } from "./pool";
import { createInitialSavingsState } from "./savings";
import { createInitialBorrowState } from "./borrow";
import { createInitialMarketState } from "./market";
import { createInitialInvestState, createInitialInvestmentMarketState } from "./investments";

/**
 * A new simulated portfolio: ~$10,000 in USDC, nothing else.
 *
 * `nowMs` seeds the savings position's accrual clock; it defaults to the
 * real clock so callers that don't care about time don't have to pass one.
 */
export function createInitialState(nowMs: number = Date.now()): SimulationState {
  return {
    balances: {
      USDC: toMicroUnits(10_000),
      ETH: 0,
    },
    pool: {
      reserves: createInitialPoolReserves(),
    },
    savings: createInitialSavingsState(nowMs),
    borrow: createInitialBorrowState(),
    market: createInitialMarketState(),
    invest: createInitialInvestState(),
    investmentMarket: createInitialInvestmentMarketState(),
    clockOffsetMs: 0,
  };
}
