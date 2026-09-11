// Public surface of the simulation/ledger layer. The presentation layer
// (Zustand store, components) should only import from this file, never reach
// into simulation/*'s internals directly.

export type {
  Action,
  ActionResult,
  AssetId,
  PoolState,
  SimulationErrorCode,
  SimulationState,
  SwapAction,
  SwapReceipt,
} from "./types";
export type { AssetDefinition } from "./assets";

export { ASSETS } from "./assets";
export { DECIMALS, fromMicroUnits, toMicroUnits } from "./money";
export { createInitialState } from "./state";
export { applyAction } from "./applyAction";
export { getAssetValueMicroUsd, getPortfolioValueMicroUsd } from "./valuation";
export { createInitialPoolReserves, getPoolSpotPriceMicroUsd } from "./pool";
