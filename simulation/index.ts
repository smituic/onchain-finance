// Public surface of the simulation/ledger layer. The presentation layer
// (Zustand store, components) should only import from this file, never reach
// into simulation/*'s internals directly.

export type {
  Action,
  ActionResult,
  AssetId,
  SimulationErrorCode,
  SimulationState,
  SwapAction,
} from "./types";
export type { AssetDefinition } from "./assets";

export { ASSETS } from "./assets";
export { DECIMALS, fromMicroUnits, toMicroUnits } from "./money";
export { createInitialState } from "./state";
export { applyAction } from "./applyAction";
