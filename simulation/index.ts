// Public surface of the simulation/ledger layer. The presentation layer
// (Zustand store, components) should only import from this file, never reach
// into simulation/*'s internals directly.

export type {
  AccrueSavingsAction,
  Action,
  ActionResult,
  AddCollateralAction,
  AdvancePracticeTimeAction,
  AssetId,
  BorrowCashAction,
  BorrowState,
  DepositToSavingsAction,
  LiquidationReceipt,
  MarketState,
  PoolState,
  RemoveCollateralAction,
  RepayCashAction,
  ResetEthPriceAction,
  SavingsState,
  SimulateEthPriceChangeAction,
  SimulationErrorCode,
  SimulationState,
  SwapAction,
  SwapReceipt,
  WithdrawFromSavingsAction,
} from "./types";
export type { AssetDefinition } from "./assets";
export type { BorrowHealth, BorrowPosition } from "./borrow";

export { ASSETS } from "./assets";
export { DECIMALS, fromMicroUnits, toMicroUnits } from "./money";
export { createInitialState } from "./state";
export { applyAction } from "./applyAction";
export {
  getAssetValueMicroUsd,
  getCryptoValueMicroUsd,
  getNetWorthMicroUsd,
  getPortfolioValueMicroUsd,
} from "./valuation";
export { createInitialPoolReserves, getPoolSpotPriceMicroUsd } from "./pool";
export {
  accrueSavings,
  calculateInterestMicroUsd,
  createInitialSavingsState,
  getSimulatedNow,
  PRACTICE_TIME_STEP_MS,
  SAVINGS_ANNUAL_RATE_BPS,
} from "./savings";
export {
  CAUTION_LTV_BPS,
  createInitialBorrowState,
  getBorrowPosition,
  getCollateralValueMicroUsd,
  LIQUIDATION_THRESHOLD_BPS,
  MAX_BORROW_LTV_BPS,
} from "./borrow";
export {
  applyRelativePriceChange,
  createInitialMarketState,
  getGenesisPriceMicroUsd,
  getPriceMicroUsd,
} from "./market";
