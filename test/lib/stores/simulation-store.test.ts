import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { createInitialState, toMicroUnits } from "@/simulation";
import {
  createSimulationStore,
  SIMULATION_STORE_NAME,
  useHasSimulationHydrated,
  useSimulationStore,
} from "@/lib/stores/simulation-store";

describe("simulation store", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("starts from createInitialState()", () => {
    const store = createSimulationStore();
    expect(store.getState().state).toEqual(createInitialState());
  });

  it("updates state on a successful dispatch", () => {
    const store = createSimulationStore();
    const amountIn = toMicroUnits(3_000);

    const result = store.getState().dispatch({ type: "swap", fromAsset: "USDC", toAsset: "ETH", amountIn });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(store.getState().state).toEqual(result.state);
    expect(store.getState().state.balances.ETH).toBe(toMicroUnits(1));
  });

  it("leaves state unchanged on a failed dispatch", () => {
    const store = createSimulationStore();
    const before = store.getState().state;

    const result = store.getState().dispatch({
      type: "swap",
      fromAsset: "USDC",
      toAsset: "ETH",
      amountIn: before.balances.USDC + 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INSUFFICIENT_BALANCE");
    expect(store.getState().state).toEqual(before);
  });

  describe("persistence", () => {
    it("restores persisted financial state only after explicit rehydration", async () => {
      const first = createSimulationStore();
      first.getState().dispatch({
        type: "swap",
        fromAsset: "USDC",
        toAsset: "ETH",
        amountIn: toMicroUnits(3_000),
      });
      const persistedState = first.getState().state;

      const second = createSimulationStore();
      // skipHydration: true — a fresh store starts from createInitialState()
      // even though localStorage already has persisted data.
      expect(second.getState().state).toEqual(createInitialState());

      await second.persist.rehydrate();

      expect(second.getState().state).toEqual(persistedState);
    });

    it("persists only `state`, not `dispatch`", () => {
      const store = createSimulationStore();
      store.getState().dispatch({
        type: "swap",
        fromAsset: "USDC",
        toAsset: "ETH",
        amountIn: toMicroUnits(3_000),
      });

      const raw = localStorage.getItem(SIMULATION_STORE_NAME);
      expect(raw).not.toBeNull();
      const persisted = JSON.parse(raw as string);

      expect(Object.keys(persisted.state)).toEqual(["state"]);
    });
  });

  describe("useHasSimulationHydrated", () => {
    it("reflects false before rehydration and true after", async () => {
      const { result } = renderHook(() => useHasSimulationHydrated());

      expect(result.current).toBe(false);

      await act(async () => {
        await useSimulationStore.persist.rehydrate();
      });

      expect(result.current).toBe(true);
    });

    it("reflects true immediately for a component that mounts after hydration already finished", async () => {
      // Regression test: hasHydrated must live in the store itself, updated
      // via a listener registered once at store-creation time — not via a
      // per-component effect subscription, which would race against
      // whichever component's effect calls rehydrate() first and could
      // permanently miss the one-shot completion event.
      await act(async () => {
        await useSimulationStore.persist.rehydrate();
      });

      const { result } = renderHook(() => useHasSimulationHydrated());
      expect(result.current).toBe(true);
    });
  });
});
