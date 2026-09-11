import type {
  ActionResult,
  DepositToSavingsAction,
  SimulationState,
  WithdrawFromSavingsAction,
} from "../types";
import { accrueSavings, PRACTICE_TIME_STEP_MS } from "../savings";

/**
 * Cash is held as USDC, which the simulation prices at exactly $1, so a
 * micro-unit of USDC and a micro-USD of savings are the same thing. Moving
 * money between them therefore can't change what the user is worth — only
 * interest can.
 */
const CASH_ASSET = "USDC" as const;

function validateAmount(amount: number): ActionResult | null {
  if (!Number.isInteger(amount) || amount <= 0) {
    return {
      ok: false,
      error: "Enter an amount greater than zero.",
      code: "INVALID_AMOUNT",
    };
  }
  return null;
}

/** Moves Cash into savings. Interest is settled first, then the deposit lands. */
export function applyDepositToSavings(
  state: SimulationState,
  action: DepositToSavingsAction,
  nowMs: number,
): ActionResult {
  const invalid = validateAmount(action.amount);
  if (invalid) return invalid;

  const accrued = accrueSavings(state, nowMs);

  if (action.amount > accrued.balances[CASH_ASSET]) {
    return { ok: false, error: "You don't have that much cash.", code: "INSUFFICIENT_BALANCE" };
  }

  return {
    ok: true,
    state: {
      ...accrued,
      balances: {
        ...accrued.balances,
        [CASH_ASSET]: accrued.balances[CASH_ASSET] - action.amount,
      },
      savings: {
        ...accrued.savings,
        balance: accrued.savings.balance + action.amount,
      },
    },
  };
}

/**
 * Moves money out of savings and back into Cash. Interest is settled first,
 * so interest earned right up to this moment is withdrawable — a user can
 * always take out everything the screen says they have.
 */
export function applyWithdrawFromSavings(
  state: SimulationState,
  action: WithdrawFromSavingsAction,
  nowMs: number,
): ActionResult {
  const invalid = validateAmount(action.amount);
  if (invalid) return invalid;

  const accrued = accrueSavings(state, nowMs);

  if (action.amount > accrued.savings.balance) {
    return {
      ok: false,
      error: "You don't have that much in savings.",
      code: "INSUFFICIENT_BALANCE",
    };
  }

  return {
    ok: true,
    state: {
      ...accrued,
      balances: {
        ...accrued.balances,
        [CASH_ASSET]: accrued.balances[CASH_ASSET] + action.amount,
      },
      savings: {
        ...accrued.savings,
        balance: accrued.savings.balance - action.amount,
      },
    },
  };
}

/** Settles interest up to now without moving any money. */
export function applyAccrueSavings(state: SimulationState, nowMs: number): ActionResult {
  return { ok: true, state: accrueSavings(state, nowMs) };
}

/**
 * Skips the simulation's clock forward one step and settles the interest
 * that the jump just earned. Interest before the jump is settled first, so
 * stepping forward twice earns exactly what stepping forward once twice
 * over would.
 */
export function applyAdvancePracticeTime(state: SimulationState, nowMs: number): ActionResult {
  const settled = accrueSavings(state, nowMs);
  const jumped: SimulationState = {
    ...settled,
    clockOffsetMs: settled.clockOffsetMs + PRACTICE_TIME_STEP_MS,
  };

  return { ok: true, state: accrueSavings(jumped, nowMs) };
}
