import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { createInitialPoolReserves, createInitialState, toMicroUnits } from "@/simulation";
import {
  createSimulationStore,
  SIMULATION_STORE_NAME,
  useHasSimulationHydrated,
  useSimulationStore,
} from "@/lib/stores/simulation-store";

const FIXED_NOW = 1_700_000_000_000;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

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
    expect(store.getState().state.balances.ETH).toBe(961_538);
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

      const second = createSimulationStore({ now: () => FIXED_NOW });
      // skipHydration: true — a fresh store starts from createInitialState()
      // even though localStorage already has persisted data.
      expect(second.getState().state).toEqual(createInitialState(FIXED_NOW));

      await second.persist.rehydrate();

      expect(second.getState().state).toEqual(persistedState);
    });

    it("migrates a pre-pool (v0) persisted entry: keeps balances, seeds a genesis pool", async () => {
      const oldBalances = { USDC: toMicroUnits(4_000), ETH: toMicroUnits(2) };
      localStorage.setItem(SIMULATION_STORE_NAME, JSON.stringify({ state: { state: { balances: oldBalances } }, version: 0 }));

      const store = createSimulationStore();
      await store.persist.rehydrate();

      expect(store.getState().state.balances).toEqual(oldBalances);
      expect(store.getState().state.pool.reserves).toEqual(createInitialPoolReserves());
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

    it("migrates a pre-savings (v1) persisted entry: keeps balances and pool, starts an empty savings position", async () => {
      const oldBalances = { USDC: toMicroUnits(4_000), ETH: toMicroUnits(2) };
      const oldPool = { reserves: createInitialPoolReserves() };
      localStorage.setItem(
        SIMULATION_STORE_NAME,
        JSON.stringify({ state: { state: { balances: oldBalances, pool: oldPool } }, version: 1 }),
      );

      const store = createSimulationStore({ now: () => FIXED_NOW });
      await store.persist.rehydrate();

      const state = store.getState().state;
      expect(state.balances).toEqual(oldBalances);
      expect(state.pool).toEqual(oldPool);
      expect(state.savings).toEqual({
        balance: 0,
        interestEarnedTotal: 0,
        lastAccruedAt: FIXED_NOW,
      });
      expect(state.clockOffsetMs).toBe(0);
    });

    it("gives a pre-pool (v0) entry both a pool and a savings position", async () => {
      const oldBalances = { USDC: toMicroUnits(4_000), ETH: toMicroUnits(2) };
      localStorage.setItem(
        SIMULATION_STORE_NAME,
        JSON.stringify({ state: { state: { balances: oldBalances } }, version: 0 }),
      );

      const store = createSimulationStore({ now: () => FIXED_NOW });
      await store.persist.rehydrate();

      const state = store.getState().state;
      expect(state.balances).toEqual(oldBalances);
      expect(state.pool.reserves).toEqual(createInitialPoolReserves());
      expect(state.savings.balance).toBe(0);
    });
  });

  describe("savings", () => {
    it("moves cash into savings and persists it", async () => {
      const store = createSimulationStore({ now: () => FIXED_NOW });
      const result = store.getState().dispatch({
        type: "deposit-to-savings",
        amount: toMicroUnits(1_000),
      });

      expect(result.ok).toBe(true);
      expect(store.getState().state.savings.balance).toBe(toMicroUnits(1_000));
      expect(store.getState().state.balances.USDC).toBe(toMicroUnits(9_000));

      const restored = createSimulationStore({ now: () => FIXED_NOW });
      await restored.persist.rehydrate();
      expect(restored.getState().state.savings.balance).toBe(toMicroUnits(1_000));
    });

    it("moves money back out of savings", () => {
      const store = createSimulationStore({ now: () => FIXED_NOW });
      store.getState().dispatch({ type: "deposit-to-savings", amount: toMicroUnits(1_000) });
      store.getState().dispatch({ type: "withdraw-from-savings", amount: toMicroUnits(250) });

      expect(store.getState().state.savings.balance).toBe(toMicroUnits(750));
      expect(store.getState().state.balances.USDC).toBe(toMicroUnits(9_250));
    });

    it("refuses to dispatch a deposit larger than the user's cash", () => {
      const store = createSimulationStore({ now: () => FIXED_NOW });
      const before = store.getState().state;

      const result = store.getState().dispatch({
        type: "deposit-to-savings",
        amount: toMicroUnits(50_000),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("INSUFFICIENT_BALANCE");
      expect(store.getState().state).toEqual(before);
    });

    it("advances practice time deterministically, on a frozen clock", () => {
      const a = createSimulationStore({ now: () => FIXED_NOW });
      a.getState().dispatch({ type: "deposit-to-savings", amount: toMicroUnits(1_000) });
      a.getState().dispatch({ type: "advance-practice-time" });

      localStorage.clear();
      const b = createSimulationStore({ now: () => FIXED_NOW });
      b.getState().dispatch({ type: "deposit-to-savings", amount: toMicroUnits(1_000) });
      b.getState().dispatch({ type: "advance-practice-time" });

      expect(a.getState().state).toEqual(b.getState().state);
      expect(a.getState().state.savings.interestEarnedTotal).toBeGreaterThan(0);
    });

    it("settles interest earned while the app was closed, on rehydration", async () => {
      const saved = createSimulationStore({ now: () => FIXED_NOW });
      saved.getState().dispatch({ type: "deposit-to-savings", amount: toMicroUnits(1_000) });

      // Reopened a year later.
      const reopened = createSimulationStore({ now: () => FIXED_NOW + YEAR_MS });
      await reopened.persist.rehydrate();

      expect(reopened.getState().state.savings.balance).toBe(toMicroUnits(1_040));
      expect(reopened.getState().state.savings.interestEarnedTotal).toBe(toMicroUnits(40));
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
