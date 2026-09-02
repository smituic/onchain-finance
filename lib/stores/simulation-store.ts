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
  /**
   * Whether explicit rehydration (see skipHydration below) has finished.
   * Lives in the store itself — not a separate React-effect-driven flag —
   * so every consumer reads it through the store's own subscription
   * machinery. Not persisted (see partialize): it's lifecycle state, not
   * financial state.
   */
  hasHydrated: boolean;
  dispatch: (action: Action) => ActionResult;
};

export const SIMULATION_STORE_NAME = "onchain-finance:simulation";

export function createSimulationStore() {
  const store = create<SimulationStore>()(
    persist(
      (set, get) => ({
        state: createInitialState(),
        hasHydrated: false,
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
        // presentation layer must explicitly call
        // `useSimulationStore.persist.rehydrate()` after mount (e.g. in a
        // client-only effect) to load any persisted state.
        skipHydration: true,
      },
    ),
  );

  // Registered once, here, at store-creation time — not inside a React
  // effect. A per-component effect subscription would race: another
  // mounted component's effect could call rehydrate() (and thus fire this
  // one-shot event) before this component's own effect has subscribed,
  // permanently missing the notification. Writing hasHydrated into the
  // store itself sidesteps that entirely.
  store.persist.onFinishHydration(() => store.setState({ hasHydrated: true }));

  return store;
}

/** The store components use. */
export const useSimulationStore = createSimulationStore();

/**
 * Whether useSimulationStore has finished explicit rehydration. Components
 * can use this to avoid showing default initial-state balances as if they
 * were real, persisted ones.
 */
export function useHasSimulationHydrated(): boolean {
  return useSimulationStore((s) => s.hasHydrated);
}
