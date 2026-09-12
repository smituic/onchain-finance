"use client";

import { useCallback, useRef, useState } from "react";
import { applyAction, type Action, type ActionResult, type SimulationState } from "@/simulation";
import { createExperimentState, EXPERIMENT_NOW_MS, type ExperimentId } from "@/lib/explore/experiment-state";

export type UseExperimentSimulation = {
  state: SimulationState;
  /**
   * Increments on every successful dispatch since the sandbox was last (re)
   * created; 0 means "still exactly the starting fixture". Cheap stand-in
   * for "has anything changed" — no deep equality needed to decide whether
   * to show "Reset experiment".
   */
  version: number;
  dispatch: (action: Action) => ActionResult;
  /** Recreates the experiment's deterministic starting fixture from scratch. */
  reset: () => void;
};

/**
 * One Explore experiment's isolated sandbox: plain React state, seeded from
 * lib/explore/experiment-state.ts, dispatched into via the real
 * applyAction — never the app's Zustand simulation-store. Nothing here can
 * reach the user's actual Practice Mode portfolio; see ARCHITECTURE.md.
 */
export function useExperimentSimulation(experimentId: ExperimentId): UseExperimentSimulation {
  const [state, setState] = useState<SimulationState>(() => createExperimentState(experimentId));
  const [version, setVersion] = useState(0);

  // A ref mirrors state so a caller that dispatches more than once in a row
  // (e.g. resetting a scenario to genesis before applying it — see the
  // Liquidation and Risk experiments) always acts on the result of its own
  // previous dispatch in this same call, rather than a stale closure over
  // the state variable from the last render. It only ever needs updating
  // from dispatch/reset below — nothing else changes `state` — so it's
  // never written during render itself.
  const stateRef = useRef(state);

  const dispatch = useCallback((action: Action): ActionResult => {
    const result = applyAction(stateRef.current, action, EXPERIMENT_NOW_MS);
    if (result.ok) {
      stateRef.current = result.state;
      setState(result.state);
      setVersion((v) => v + 1);
    }
    return result;
  }, []);

  const reset = useCallback(() => {
    const initial = createExperimentState(experimentId);
    stateRef.current = initial;
    setState(initial);
    setVersion(0);
  }, [experimentId]);

  return { state, version, dispatch, reset };
}
