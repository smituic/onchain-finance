import type { SavingsState, SimulationState } from "./types";

/**
 * The simulated annual interest rate on savings, in basis points (400 =
 * 4.00%). One fixed rate for Practice Mode — deliberately not a market rate
 * that moves, so a user can predict what should happen and check it. It
 * lives here, in the simulation layer, so no component ever hardcodes a
 * rate of its own.
 */
export const SAVINGS_ANNUAL_RATE_BPS = 400;

const BPS_DIVISOR = BigInt(10_000);
const MS_PER_YEAR = BigInt(365 * 24 * 60 * 60 * 1000);

/** One press of Practice Mode's time control: 30 days, shown as "a month". */
export const PRACTICE_TIME_STEP_MS = 30 * 24 * 60 * 60 * 1000;

export function createInitialSavingsState(nowMs: number): SavingsState {
  return { balance: 0, interestEarnedTotal: 0, lastAccruedAt: nowMs };
}

/** The simulation's current time: wall clock plus any time skipped forward. */
export function getSimulatedNow(state: SimulationState, nowMs: number): number {
  return nowMs + state.clockOffsetMs;
}

/**
 * Interest earned on `balance` over `elapsedMs`, in micro-USD, floored.
 *
 * Simple interest across the window, applied at each interaction boundary —
 * so a position that's touched repeatedly compounds per interaction rather
 * than continuously. That's a deliberate simplification for an educational
 * simulation, and it's exact: BigInt throughout, with the multiply before
 * the divide, because balance * rate * elapsed overflows Number's safe
 * integer range within days.
 */
export function calculateInterestMicroUsd(balanceMicroUsd: number, elapsedMs: number): number {
  if (balanceMicroUsd <= 0 || elapsedMs <= 0) return 0;

  const interest =
    (BigInt(balanceMicroUsd) * BigInt(SAVINGS_ANNUAL_RATE_BPS) * BigInt(elapsedMs)) /
    (BPS_DIVISOR * MS_PER_YEAR);

  return Number(interest);
}

/**
 * Brings savings up to date as of `nowMs`, crediting any interest earned
 * since it was last accrued into the balance. Pure, and safe to call as
 * often as you like: accruing twice at the same instant credits nothing the
 * second time. A clock that appears to run backwards (system time changed)
 * leaves the position untouched rather than charging negative interest.
 */
export function accrueSavings(state: SimulationState, nowMs: number): SimulationState {
  const simulatedNow = getSimulatedNow(state, nowMs);
  const elapsedMs = simulatedNow - state.savings.lastAccruedAt;
  if (elapsedMs <= 0) return state;

  const interest = calculateInterestMicroUsd(state.savings.balance, elapsedMs);

  return {
    ...state,
    savings: {
      balance: state.savings.balance + interest,
      interestEarnedTotal: state.savings.interestEarnedTotal + interest,
      lastAccruedAt: simulatedNow,
    },
  };
}
