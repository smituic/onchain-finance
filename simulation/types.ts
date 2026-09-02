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
};

export type SwapAction = {
  type: "swap";
  fromAsset: AssetId;
  toAsset: AssetId;
  /** Amount of fromAsset to spend, in micro-units. */
  amountIn: number;
};

/** Grows as more mechanics (deposit, borrow, repay, liquidate, ...) are added. */
export type Action = SwapAction;

export type SimulationErrorCode =
  | "SAME_ASSET"
  | "INVALID_AMOUNT"
  | "INSUFFICIENT_BALANCE"
  | "UNKNOWN_ASSET";

export type ActionResult =
  | { ok: true; state: SimulationState }
  | { ok: false; error: string; code: SimulationErrorCode };
