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
  BuyInvestmentAction,
  CompletePaymentRequestAction,
  CreatePaymentRequestAction,
  DepositCashAction,
  DepositToSavingsAction,
  InvestmentAssetId,
  InvestmentHoldingState,
  InvestmentMarketState,
  InvestmentTradeReceipt,
  InvestState,
  LiquidationReceipt,
  MarketState,
  PayActivity,
  PayActivityKind,
  PayContactId,
  PaymentRequest,
  PaymentRequestStatus,
  PayState,
  PoolState,
  ReceivePaymentAction,
  RemoveCollateralAction,
  RepayCashAction,
  ResetEthPriceAction,
  ResetInvestmentPricesAction,
  SavingsState,
  SellInvestmentAction,
  SendPaymentAction,
  SimulateEthPriceChangeAction,
  SimulateInvestmentMarketMoveAction,
  SimulationErrorCode,
  SimulationState,
  SwapAction,
  SwapReceipt,
  WithdrawCashAction,
  WithdrawFromSavingsAction,
} from "./types";
export type { AssetDefinition } from "./assets";
export type { BorrowHealth, BorrowPosition } from "./borrow";
export type {
  InvestmentAssetDefinition,
  InvestmentCategory,
  InvestmentHolding,
  InvestmentRiskLevel,
  InvestPortfolio,
} from "./investments";
export type { PayContactDefinition } from "./pay";

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
export {
  createInitialInvestmentMarketState,
  createInitialInvestState,
  getGenesisInvestmentPriceMicroUsd,
  getInvestmentHolding,
  getInvestmentHoldings,
  getInvestmentPortfolioValueMicroUsd,
  getInvestmentPriceMicroUsd,
  getInvestPortfolio,
  INVESTMENT_ASSET_IDS,
  INVESTMENT_ASSETS,
  INVESTMENT_MARKET_MOVE_BPS,
} from "./investments";
export { createInitialPayState, PAY_CONTACT_IDS, PAY_CONTACTS, PRACTICE_HANDLE } from "./pay";
