import type { Action, ActionResult, SimulationState } from "./types";
import { applySwap } from "./actions/swap";
import {
  applyAccrueSavings,
  applyAdvancePracticeTime,
  applyDepositToSavings,
  applyWithdrawFromSavings,
} from "./actions/savings";

/**
 * Single entry point into the simulation ledger. Pure: never mutates state.
 *
 * `nowMs` is wall-clock time, passed in rather than read inside the engine
 * so time-dependent actions (savings interest) stay deterministic and
 * testable. It defaults to the real clock for convenience at call sites —
 * like the swap preview — that aren't time-dependent at all.
 */
export function applyAction(
  state: SimulationState,
  action: Action,
  nowMs: number = Date.now(),
): ActionResult {
  switch (action.type) {
    case "swap":
      return applySwap(state, action);
    case "deposit-to-savings":
      return applyDepositToSavings(state, action, nowMs);
    case "withdraw-from-savings":
      return applyWithdrawFromSavings(state, action, nowMs);
    case "accrue-savings":
      return applyAccrueSavings(state, nowMs);
    case "advance-practice-time":
      return applyAdvancePracticeTime(state, nowMs);
  }
}
