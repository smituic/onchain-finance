import type { BorrowState, LiquidationReceipt, SimulationState } from "./types";
import { DECIMALS } from "./money";
import { getPriceMicroUsd } from "./market";

const SCALE = BigInt(10 ** DECIMALS);
const BPS_DIVISOR = BigInt(10_000);

/**
 * The most a user may borrow against their collateral: 50% of its value.
 * Deliberately conservative, and deliberately far below the liquidation
 * threshold below — the gap between the two *is* the safety buffer the
 * product explains, and it's what gives a user room to be wrong about
 * where the price goes.
 */
export const MAX_BORROW_LTV_BPS = 5_000;

/**
 * Borrow more than 75% of the collateral's value and the position is
 * liquidated. Reached only by the collateral falling in value, never by
 * borrowing — borrowing is capped at MAX_BORROW_LTV_BPS.
 *
 * With these two numbers, a user who borrows the maximum against ETH is
 * liquidated when ETH falls by a third, which is what makes the "ETH falls
 * 40%" scenario land the lesson.
 */
export const LIQUIDATION_THRESHOLD_BPS = 7_500;

/** Where the UI starts warning, between comfortable and nearly liquidated. */
export const CAUTION_LTV_BPS = 6_500;

export type BorrowHealth = "safe" | "caution" | "danger";

/** Everything the UI needs about a loan, with no ratio math left to do. */
export type BorrowPosition = {
  collateralEth: number;
  collateralValueMicroUsd: number;
  debtMicroUsd: number;
  /** The most this collateral could support: value × MAX_BORROW_LTV_BPS. */
  borrowLimitMicroUsd: number;
  availableToBorrowMicroUsd: number;
  /** Debt as a share of collateral value, in bps. 0 when nothing is owed. */
  ltvBps: number;
  health: BorrowHealth;
  isLiquidatable: boolean;
  /** ETH price at which this loan gets liquidated; null when nothing is owed. */
  liquidationPriceMicroUsd: number | null;
};

export function createInitialBorrowState(): BorrowState {
  return { collateralEth: 0, debtMicroUsd: 0 };
}

/** What the pledged ETH is worth right now, in micro-USD. */
export function getCollateralValueMicroUsd(state: SimulationState): number {
  const collateral = BigInt(state.borrow.collateralEth);
  const price = BigInt(getPriceMicroUsd(state, "ETH"));
  return Number((collateral * price) / SCALE);
}

function classifyHealth(ltvBps: number): BorrowHealth {
  if (ltvBps <= MAX_BORROW_LTV_BPS) return "safe";
  if (ltvBps <= CAUTION_LTV_BPS) return "caution";
  return "danger";
}

/**
 * The whole loan, derived from state — never stored, so it can't drift out
 * of sync with the collateral, the debt, or the price.
 */
export function getBorrowPosition(state: SimulationState): BorrowPosition {
  const collateralEth = state.borrow.collateralEth;
  const debtMicroUsd = state.borrow.debtMicroUsd;
  const collateralValueMicroUsd = getCollateralValueMicroUsd(state);

  const borrowLimitMicroUsd = Number(
    (BigInt(collateralValueMicroUsd) * BigInt(MAX_BORROW_LTV_BPS)) / BPS_DIVISOR,
  );
  const availableToBorrowMicroUsd = Math.max(0, borrowLimitMicroUsd - debtMicroUsd);

  if (debtMicroUsd <= 0) {
    return {
      collateralEth,
      collateralValueMicroUsd,
      debtMicroUsd: 0,
      borrowLimitMicroUsd,
      availableToBorrowMicroUsd,
      ltvBps: 0,
      health: "safe",
      isLiquidatable: false,
      liquidationPriceMicroUsd: null,
    };
  }

  // Debt with no collateral behind it can't be expressed as a ratio; it's
  // unreachable (collateral can't be removed out from under a loan) but is
  // treated as maximally unsafe rather than dividing by zero.
  const ltvBps =
    collateralValueMicroUsd > 0
      ? Number((BigInt(debtMicroUsd) * BPS_DIVISOR) / BigInt(collateralValueMicroUsd))
      : Number.MAX_SAFE_INTEGER;

  const liquidationPriceMicroUsd =
    collateralEth > 0
      ? Number(
          (BigInt(debtMicroUsd) * BPS_DIVISOR * SCALE) /
            (BigInt(collateralEth) * BigInt(LIQUIDATION_THRESHOLD_BPS)),
        )
      : null;

  return {
    collateralEth,
    collateralValueMicroUsd,
    debtMicroUsd,
    borrowLimitMicroUsd,
    availableToBorrowMicroUsd,
    ltvBps,
    health: classifyHealth(ltvBps),
    // Debt left standing after a liquidation that couldn't cover it has no
    // collateral behind it: there is nothing left to sell, so it can't be
    // liquidated again, however bad the ratio looks.
    isLiquidatable: collateralEth > 0 && ltvBps >= LIQUIDATION_THRESHOLD_BPS,
    liquidationPriceMicroUsd,
  };
}

/**
 * Liquidates the position if the debt has grown past
 * LIQUIDATION_THRESHOLD_BPS of the collateral's value, and otherwise leaves
 * state alone.
 *
 * Practice Mode simplification: the *entire* position is closed at once.
 * All collateral is sold at the current market price and the proceeds go
 * against the debt. Real lending markets sell only part of the collateral
 * and charge the liquidator a bonus out of it; both are deliberately left
 * out here so the mechanic stays deterministic and the lesson stays "the
 * collateral was sold to repay the loan" rather than a fee calculation.
 *
 * The sale settles like any real repayment, so no value is created or
 * destroyed by liquidating. Proceeds above the debt come back as Cash;
 * proceeds below it pay down what they can and the rest stays owed, with
 * no collateral behind it. The user is left holding Cash at the crashed
 * price, with no ETH to recover with — which is the cost this teaches.
 */
export function liquidateIfUnsafe(state: SimulationState): {
  state: SimulationState;
  receipt: LiquidationReceipt | null;
} {
  const position = getBorrowPosition(state);
  if (!position.isLiquidatable) return { state, receipt: null };

  const proceedsMicroUsd = position.collateralValueMicroUsd;
  const debtClearedMicroUsd = Math.min(proceedsMicroUsd, position.debtMicroUsd);
  const returnedToCashMicroUsd = proceedsMicroUsd - debtClearedMicroUsd;
  const remainingDebtMicroUsd = position.debtMicroUsd - debtClearedMicroUsd;

  return {
    state: {
      ...state,
      balances: {
        ...state.balances,
        USDC: state.balances.USDC + returnedToCashMicroUsd,
      },
      borrow: { collateralEth: 0, debtMicroUsd: remainingDebtMicroUsd },
    },
    receipt: {
      collateralSoldEth: position.collateralEth,
      collateralValueMicroUsd: position.collateralValueMicroUsd,
      debtClearedMicroUsd,
      returnedToCashMicroUsd,
      remainingDebtMicroUsd,
      ethPriceMicroUsd: getPriceMicroUsd(state, "ETH"),
    },
  };
}
