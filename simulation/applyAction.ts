import type { Action, ActionResult, SimulationState } from "./types";
import { applySwap } from "./actions/swap";

/** Single entry point into the simulation ledger. Pure: never mutates state. */
export function applyAction(state: SimulationState, action: Action): ActionResult {
  switch (action.type) {
    case "swap":
      return applySwap(state, action);
  }
}
