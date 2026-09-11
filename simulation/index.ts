// Public surface of the simulation/ledger layer. The presentation layer
// (Zustand store, components) should only import from this file, never reach
// into simulation/*'s internals directly.

export type {
  AccrueSavingsAction,
  Action,
  ActionResult,
  AdvancePracticeTimeAction,
  AssetId,
  DepositToSavingsAction,
  PoolState,
  SavingsState,
  SimulationErrorCode,
  SimulationState,
  SwapAction,
  SwapReceipt,
  WithdrawFromSavingsAction,
} from "./types";
export type { AssetDefinition } from "./assets";

export { ASSETS } from "./assets";
export { DECIMALS, fromMicroUnits, toMicroUnits } from "./money";
export { createInitialState } from "./state";
export { applyAction } from "./applyAction";
export { getAssetValueMicroUsd, getPortfolioValueMicroUsd, getTotalBalanceMicroUsd } from "./valuation";
export { createInitialPoolReserves, getPoolSpotPriceMicroUsd } from "./pool";
export {
  accrueSavings,
  calculateInterestMicroUsd,
  createInitialSavingsState,
  getSimulatedNow,
  PRACTICE_TIME_STEP_MS,
  SAVINGS_ANNUAL_RATE_BPS,
} from "./savings";
