import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import {
  applyAction,
  createInitialState,
  type Action,
  type ActionResult,
  type SimulationState,
} from "@/simulation";

export type SimulationStore = {
  state: SimulationState;
  dispatch: (action: Action) => ActionResult;
};

export const SIMULATION_STORE_NAME = "onchain-finance:simulation";

export function createSimulationStore() {
  return create<SimulationStore>()(
    persist(
      (set, get) => ({
        state: createInitialState(),
        dispatch: (action) => {
          const result = applyAction(get().state, action);
          if (result.ok) set({ state: result.state });
          return result;
        },
      }),
      {
        name: SIMULATION_STORE_NAME,
        storage: createJSONStorage(() => localStorage),
        partialize: (store) => ({ state: store.state }),
        // Next.js renders server-first, where localStorage doesn't exist, so
        // a store created here always starts from createInitialState(). We
        // don't assume auto-hydration on the client is safe either — the
        // future presentation layer must explicitly call
        // `useSimulationStore.persist.rehydrate()` after mount (e.g. in a
        // client-only effect) to load any persisted state.
        skipHydration: true,
      },
    ),
  );
}

/** The store components use. */
export const useSimulationStore = createSimulationStore();
