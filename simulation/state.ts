import type { SimulationState } from "./types";
import { toMicroUnits } from "./money";

/** A new simulated portfolio: ~$10,000 in USDC, nothing else. */
export function createInitialState(): SimulationState {
  return {
    balances: {
      USDC: toMicroUnits(10_000),
      ETH: 0,
    },
  };
}
