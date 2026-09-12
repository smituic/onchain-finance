import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import {
  applyAction,
  createInitialBorrowState,
  createInitialInvestmentMarketState,
  createInitialInvestState,
  createInitialMarketState,
  createInitialPoolReserves,
  createInitialSavingsState,
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

/** Shape of what `partialize` below persists: just the financial state. */
type PersistedSimulationState = {
  state: {
    balances: SimulationState["balances"];
    pool?: SimulationState["pool"];
    savings?: SimulationState["savings"];
    clockOffsetMs?: number;
    borrow?: SimulationState["borrow"];
    market?: SimulationState["market"];
    invest?: SimulationState["invest"];
    investmentMarket?: SimulationState["investmentMarket"];
  };
};

/**
 * @param now injectable clock. The store is the one place that reads real
 * time, so the simulation engine stays pure and tests can drive interest
 * accrual to an exact instant.
 */
export function createSimulationStore({ now = () => Date.now() }: { now?: () => number } = {}) {
  const store = create<SimulationStore>()(
    persist(
      (set, get) => ({
        state: createInitialState(now()),
        hasHydrated: false,
        dispatch: (action) => {
          const result = applyAction(get().state, action, now());
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
        // Bumped when `state`'s shape changes. Each step is additive and
        // preserves what the user already had: v1 added the liquidity pool,
        // v2 added the savings position and simulated clock, v3 added the
        // loan and simulated market prices, v4 added the curated Invest
        // portfolio and its simulated market prices. An entry from an older
        // version has no history to restore for the part that didn't exist
        // yet, so that part starts empty — balances, ETH, pool reserves,
        // savings, the practice clock, the loan, and market prices all
        // carry through untouched.
        version: 4,
        migrate: (persisted, version) => {
          const typed = persisted as PersistedSimulationState;
          let migrated = typed.state;

          if (version < 1) {
            migrated = { ...migrated, pool: { reserves: createInitialPoolReserves() } };
          }
          if (version < 2) {
            migrated = { ...migrated, savings: createInitialSavingsState(now()), clockOffsetMs: 0 };
          }
          if (version < 3) {
            migrated = {
              ...migrated,
              borrow: createInitialBorrowState(),
              market: createInitialMarketState(),
            };
          }
          if (version < 4) {
            migrated = {
              ...migrated,
              invest: createInitialInvestState(),
              investmentMarket: createInitialInvestmentMarketState(),
            };
          }

          return { state: migrated } satisfies PersistedSimulationState;
        },
      },
    ),
  );

  // Registered once, here, at store-creation time — not inside a React
  // effect. A per-component effect subscription would race: another
  // mounted component's effect could call rehydrate() (and thus fire this
  // one-shot event) before this component's own effect has subscribed,
  // permanently missing the notification. Writing hasHydrated into the
  // store itself sidesteps that entirely.
  store.persist.onFinishHydration(() => {
    // Settle the interest earned while the app was closed. Doing it here,
    // at a lifecycle boundary, is what lets savings grow over real time
    // without a timer permanently mutating the ledger.
    store.getState().dispatch({ type: "accrue-savings" });
    store.setState({ hasHydrated: true });
  });

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
