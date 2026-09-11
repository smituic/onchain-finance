import type {
  ActionResult,
  AddCollateralAction,
  BorrowCashAction,
  RemoveCollateralAction,
  RepayCashAction,
  SimulateEthPriceChangeAction,
  SimulationState,
} from "../types";
import { getBorrowPosition, liquidateIfUnsafe, MAX_BORROW_LTV_BPS } from "../borrow";
import { applyRelativePriceChange, getGenesisPriceMicroUsd } from "../market";

function validateAmount(amount: number): ActionResult | null {
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, error: "Enter an amount greater than zero.", code: "INVALID_AMOUNT" };
  }
  return null;
}

/** Pledges ETH the user already holds. Pledged ETH leaves their spendable balance. */
export function applyAddCollateral(
  state: SimulationState,
  action: AddCollateralAction,
): ActionResult {
  const invalid = validateAmount(action.amount);
  if (invalid) return invalid;

  if (action.amount > state.balances.ETH) {
    return { ok: false, error: "You don't have that much ETH.", code: "INSUFFICIENT_BALANCE" };
  }

  return {
    ok: true,
    state: {
      ...state,
      balances: { ...state.balances, ETH: state.balances.ETH - action.amount },
      borrow: { ...state.borrow, collateralEth: state.borrow.collateralEth + action.amount },
    },
  };
}

/**
 * Returns pledged ETH. Refused if taking it back would leave the remaining
 * collateral supporting more debt than the borrowing limit allows — the
 * user can always get collateral back by repaying first.
 */
export function applyRemoveCollateral(
  state: SimulationState,
  action: RemoveCollateralAction,
): ActionResult {
  const invalid = validateAmount(action.amount);
  if (invalid) return invalid;

  if (action.amount > state.borrow.collateralEth) {
    return {
      ok: false,
      error: "You don't have that much ETH set aside.",
      code: "INSUFFICIENT_BALANCE",
    };
  }

  const next: SimulationState = {
    ...state,
    balances: { ...state.balances, ETH: state.balances.ETH + action.amount },
    borrow: { ...state.borrow, collateralEth: state.borrow.collateralEth - action.amount },
  };

  const position = getBorrowPosition(next);
  if (position.debtMicroUsd > 0 && position.ltvBps > MAX_BORROW_LTV_BPS) {
    return {
      ok: false,
      error: "Taking that much back would leave your loan unsafe. Repay some of it first.",
      code: "WOULD_BE_UNSAFE",
    };
  }

  return { ok: true, state: next };
}

/** Borrows Cash against pledged collateral, capped at the borrowing limit. */
export function applyBorrowCash(state: SimulationState, action: BorrowCashAction): ActionResult {
  const invalid = validateAmount(action.amount);
  if (invalid) return invalid;

  const position = getBorrowPosition(state);
  if (action.amount > position.availableToBorrowMicroUsd) {
    return {
      ok: false,
      error:
        position.collateralEth > 0
          ? "That's more than your ETH can safely support."
          : "Set some ETH aside as collateral first.",
      code: "EXCEEDS_BORROW_LIMIT",
    };
  }

  return {
    ok: true,
    state: {
      ...state,
      balances: { ...state.balances, USDC: state.balances.USDC + action.amount },
      borrow: { ...state.borrow, debtMicroUsd: state.borrow.debtMicroUsd + action.amount },
    },
  };
}

/** Pays borrowed Cash back. Collateral stays pledged until it's taken back. */
export function applyRepayCash(state: SimulationState, action: RepayCashAction): ActionResult {
  const invalid = validateAmount(action.amount);
  if (invalid) return invalid;

  if (action.amount > state.borrow.debtMicroUsd) {
    return { ok: false, error: "That's more than you owe.", code: "EXCEEDS_DEBT" };
  }

  if (action.amount > state.balances.USDC) {
    return { ok: false, error: "You don't have that much cash.", code: "INSUFFICIENT_BALANCE" };
  }

  return {
    ok: true,
    state: {
      ...state,
      balances: { ...state.balances, USDC: state.balances.USDC - action.amount },
      borrow: { ...state.borrow, debtMicroUsd: state.borrow.debtMicroUsd - action.amount },
    },
  };
}

function repriceEth(state: SimulationState, priceMicroUsd: number): ActionResult {
  const repriced: SimulationState = {
    ...state,
    market: {
      ...state.market,
      pricesMicroUsd: { ...state.market.pricesMicroUsd, ETH: priceMicroUsd },
    },
  };

  // A price move is the only thing that can push a loan past the
  // liquidation threshold, so this is where liquidation is settled.
  const { state: settled, receipt } = liquidateIfUnsafe(repriced);
  return receipt ? { ok: true, state: settled, liquidation: receipt } : { ok: true, state: settled };
}

/** Moves ETH's simulated market price, then settles any liquidation it caused. */
export function applySimulateEthPriceChange(
  state: SimulationState,
  action: SimulateEthPriceChangeAction,
): ActionResult {
  if (!Number.isInteger(action.changeBps) || action.changeBps === 0 || action.changeBps <= -10_000) {
    return { ok: false, error: "Choose a price change.", code: "INVALID_AMOUNT" };
  }

  const current = state.market.pricesMicroUsd.ETH;
  return repriceEth(state, applyRelativePriceChange(current, action.changeBps));
}

/** Puts ETH's simulated market price back to where the simulation started. */
export function applyResetEthPrice(state: SimulationState): ActionResult {
  return repriceEth(state, getGenesisPriceMicroUsd("ETH"));
}
