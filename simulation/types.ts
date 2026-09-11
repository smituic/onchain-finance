// Core types for the simulation/ledger layer. See simulation/README.md for the
// framework-agnostic boundary this file lives inside.

/** The fixed set of simulated assets. Extend this union as new assets are added. */
export type AssetId = "USDC" | "ETH";

/**
 * All balances are integers in fixed-point "micro-units" (see money.ts) —
 * never floats. A balance is always >= 0.
 */
export type SimulationState = {
  balances: Record<AssetId, number>;
  pool: PoolState;
  savings: SavingsState;
  /**
   * Milliseconds of simulated time the user has deliberately skipped
   * forward with Practice Mode's time control, added to wall-clock time to
   * get the simulation's "now". Lives at the top level because it's the
   * whole simulation's clock, not a savings-only concept — borrowing
   * scenarios will read the same offset.
   */
  clockOffsetMs: number;
};

/**
 * A simulated savings position. `balance` is the whole position — deposits
 * plus every bit of interest credited into it — so it's always "what the
 * user would get back if they withdrew everything right now", which keeps
 * deposits and withdrawals at arbitrary times coherent.
 * `interestEarnedTotal` is a separate lifetime counter kept for display: it
 * only ever grows, so withdrawing money doesn't erase the fact that the
 * money was earned.
 */
export type SavingsState = {
  balance: number;
  interestEarnedTotal: number;
  /** Simulated-clock timestamp (ms) that `balance` is current as of. */
  lastAccruedAt: number;
};

/**
 * Constant-product (x*y=k) AMM reserves backing the swap action. Lives
 * alongside `balances` (not derived, not UI state) because it's mutated by
 * actions and must persist the same way balances do. A single shared
 * reserve map is the boring choice while there are exactly two assets; if a
 * third asset ever needs its own distinct pair-pool, that's the point to
 * introduce a per-pair map instead.
 */
export type PoolState = {
  reserves: Record<AssetId, number>;
};

export type SwapAction = {
  type: "swap";
  fromAsset: AssetId;
  toAsset: AssetId;
  /** Amount of fromAsset to spend, in micro-units. */
  amountIn: number;
};

/** Moves Cash into savings. Amount is in micro-units of USDC (= micro-USD). */
export type DepositToSavingsAction = {
  type: "deposit-to-savings";
  amount: number;
};

/** Moves money out of savings and back into Cash, in micro-USD. */
export type WithdrawFromSavingsAction = {
  type: "withdraw-from-savings";
  amount: number;
};

/**
 * Brings the savings position up to date with the current time. Dispatched
 * at read/lifecycle boundaries (notably after the store rehydrates) so
 * interest appears without a timer constantly mutating the ledger.
 */
export type AccrueSavingsAction = {
  type: "accrue-savings";
};

/**
 * Practice Mode's time control: jumps the simulation's clock forward by one
 * step so a user can watch interest arrive without waiting a real month.
 */
export type AdvancePracticeTimeAction = {
  type: "advance-practice-time";
};

/** Grows as more mechanics (borrow, repay, liquidate, ...) are added. */
export type Action =
  | SwapAction
  | DepositToSavingsAction
  | WithdrawFromSavingsAction
  | AccrueSavingsAction
  | AdvancePracticeTimeAction;

export type SimulationErrorCode =
  | "SAME_ASSET"
  | "INVALID_AMOUNT"
  | "INSUFFICIENT_BALANCE"
  | "UNKNOWN_ASSET";

/**
 * Everything the UI needs to explain a swap's execution without
 * recomputing AMM math itself. `amountOut` is what the trade actually
 * produced; `referenceAmountOut` is what the same `amountIn` would have
 * produced at the pre-trade pool spot price with zero impact — the gap
 * between the two is what a large trade "costs" relative to that price.
 * `priceImpactBps` is always a positive magnitude (how much worse the
 * average execution price is than the pre-trade spot price), regardless of
 * swap direction.
 */
export type SwapReceipt = {
  amountOut: number;
  referenceAmountOut: number;
  referencePriceMicroUsd: number;
  executionPriceMicroUsd: number;
  priceImpactBps: number;
};

export type ActionResult =
  | { ok: true; state: SimulationState; swap?: SwapReceipt }
  | { ok: false; error: string; code: SimulationErrorCode };
