import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createInitialInvestmentMarketState,
  createInitialInvestState,
  createInitialPayState,
  createInitialPoolReserves,
  createInitialSavingsState,
  createInitialState,
  getBorrowPosition,
  getInvestmentPriceMicroUsd,
  toMicroUnits,
} from "@/simulation";
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

  describe("borrowing", () => {
    /** A store whose user holds 1 ETH, ready to pledge it. */
    function storeWithEth() {
      const store = createSimulationStore({ now: () => FIXED_NOW });
      store.setState({
        state: {
          ...store.getState().state,
          balances: { ...store.getState().state.balances, ETH: toMicroUnits(1) },
        },
      });
      return store;
    }

    it("dispatches collateral, borrowing, and repayment, and persists the loan", async () => {
      const store = storeWithEth();

      expect(store.getState().dispatch({ type: "add-collateral", amount: toMicroUnits(1) }).ok).toBe(
        true,
      );
      expect(store.getState().dispatch({ type: "borrow-cash", amount: toMicroUnits(1_000) }).ok).toBe(
        true,
      );
      expect(store.getState().dispatch({ type: "repay-cash", amount: toMicroUnits(250) }).ok).toBe(
        true,
      );

      expect(store.getState().state.borrow).toEqual({
        collateralEth: toMicroUnits(1),
        debtMicroUsd: toMicroUnits(750),
      });

      const restored = createSimulationStore({ now: () => FIXED_NOW });
      await restored.persist.rehydrate();
      expect(restored.getState().state.borrow).toEqual({
        collateralEth: toMicroUnits(1),
        debtMicroUsd: toMicroUnits(750),
      });
    });

    it("dispatches a crash scenario and persists both the price and the liquidation it caused", async () => {
      const store = storeWithEth();
      store.getState().dispatch({ type: "add-collateral", amount: toMicroUnits(1) });
      store.getState().dispatch({ type: "borrow-cash", amount: toMicroUnits(1_500) });

      const result = store.getState().dispatch({
        type: "simulate-eth-price-change",
        changeBps: -4_000,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.liquidation).toBeDefined();
      expect(store.getState().state.borrow).toEqual({ collateralEth: 0, debtMicroUsd: 0 });

      const restored = createSimulationStore({ now: () => FIXED_NOW });
      await restored.persist.rehydrate();
      expect(restored.getState().state.market.pricesMicroUsd.ETH).toBe(toMicroUnits(1_800));
      expect(restored.getState().state.borrow).toEqual({ collateralEth: 0, debtMicroUsd: 0 });
    });

    it("migrates a pre-borrow (v2) entry, keeping balances, pool, savings, and the clock", async () => {
      const balances = { USDC: toMicroUnits(4_000), ETH: toMicroUnits(2) };
      const pool = { reserves: createInitialPoolReserves() };
      const savings = { ...createInitialSavingsState(FIXED_NOW), balance: toMicroUnits(500) };
      localStorage.setItem(
        SIMULATION_STORE_NAME,
        JSON.stringify({
          state: { state: { balances, pool, savings, clockOffsetMs: 12_345 } },
          version: 2,
        }),
      );

      const store = createSimulationStore({ now: () => FIXED_NOW });
      await store.persist.rehydrate();

      const state = store.getState().state;
      expect(state.balances).toEqual(balances);
      expect(state.pool).toEqual(pool);
      expect(state.clockOffsetMs).toBe(12_345);
      // The savings balance carries through untouched, apart from the
      // interest hydration settles for the time the clock offset represents.
      expect(state.savings.balance).toBe(toMicroUnits(500) + state.savings.interestEarnedTotal);
      expect(state.savings.balance).toBeGreaterThanOrEqual(toMicroUnits(500));
      // ...and Borrow starts empty, at the genesis price.
      expect(state.borrow).toEqual({ collateralEth: 0, debtMicroUsd: 0 });
      expect(state.market.pricesMicroUsd.ETH).toBe(toMicroUnits(3_000));
      expect(getBorrowPosition(state).availableToBorrowMicroUsd).toBe(0);
    });
  });

  describe("investing", () => {
    it("dispatches a buy, updating holdings and cash, and persists it", async () => {
      const store = createSimulationStore({ now: () => FIXED_NOW });

      const result = store.getState().dispatch({
        type: "buy-investment",
        assetId: "BTC",
        amount: toMicroUnits(500),
      });

      expect(result.ok).toBe(true);
      expect(store.getState().state.invest.holdings.BTC.unitsHeld).toBe(8_333);
      expect(store.getState().state.balances.USDC).toBe(toMicroUnits(10_000) - 499_980_000);

      const restored = createSimulationStore({ now: () => FIXED_NOW });
      await restored.persist.rehydrate();
      expect(restored.getState().state.invest.holdings.BTC.unitsHeld).toBe(8_333);
    });

    it("dispatches a sell, returning cash and reducing the position", () => {
      const store = createSimulationStore({ now: () => FIXED_NOW });
      store.getState().dispatch({ type: "buy-investment", assetId: "BROAD", amount: toMicroUnits(1_000) });

      const result = store.getState().dispatch({
        type: "sell-investment",
        assetId: "BROAD",
        amount: toMicroUnits(400),
      });

      expect(result.ok).toBe(true);
      expect(store.getState().state.invest.holdings.BROAD).toEqual({
        unitsHeld: toMicroUnits(1.2),
        costBasisMicroUsd: toMicroUnits(600),
      });
    });

    it("dispatches a market scenario, moving every curated investment's price", () => {
      const store = createSimulationStore({ now: () => FIXED_NOW });

      const result = store.getState().dispatch({ type: "simulate-investment-market-move", direction: "up" });

      expect(result.ok).toBe(true);
      expect(getInvestmentPriceMicroUsd(store.getState().state, "BTC")).toBe(toMicroUnits(75_000));
      expect(getInvestmentPriceMicroUsd(store.getState().state, "BROAD")).toBe(toMicroUnits(550));
      expect(getInvestmentPriceMicroUsd(store.getState().state, "TBILL")).toBe(toMicroUnits(101));

      const resetResult = store.getState().dispatch({ type: "reset-investment-prices" });
      expect(resetResult.ok).toBe(true);
      expect(getInvestmentPriceMicroUsd(store.getState().state, "BTC")).toBe(toMicroUnits(60_000));
    });

    it("migrates a pre-invest (v3) entry, keeping every previous field and seeding an empty portfolio", async () => {
      const balances = { USDC: toMicroUnits(4_000), ETH: toMicroUnits(2) };
      const pool = { reserves: createInitialPoolReserves() };
      const savings = { ...createInitialSavingsState(FIXED_NOW), balance: toMicroUnits(500) };
      const borrow = { collateralEth: toMicroUnits(1), debtMicroUsd: toMicroUnits(1_000) };
      const market = { pricesMicroUsd: { USDC: toMicroUnits(1), ETH: toMicroUnits(2_500) } };
      localStorage.setItem(
        SIMULATION_STORE_NAME,
        JSON.stringify({
          state: { state: { balances, pool, savings, clockOffsetMs: 12_345, borrow, market } },
          version: 3,
        }),
      );

      const store = createSimulationStore({ now: () => FIXED_NOW });
      await store.persist.rehydrate();

      const state = store.getState().state;
      expect(state.balances).toEqual(balances);
      expect(state.pool).toEqual(pool);
      expect(state.clockOffsetMs).toBe(12_345);
      expect(state.borrow).toEqual(borrow);
      expect(state.market).toEqual(market);
      // Savings carries through untouched apart from interest hydration settles.
      expect(state.savings.balance).toBeGreaterThanOrEqual(toMicroUnits(500));
      // ...and Invest starts empty, at genesis prices.
      expect(state.invest).toEqual(createInitialInvestState());
      expect(state.investmentMarket).toEqual(createInitialInvestmentMarketState());
    });
  });

  describe("pay", () => {
    it("dispatches a send, decreasing Cash, and persists the activity", async () => {
      const store = createSimulationStore({ now: () => FIXED_NOW });

      const result = store.getState().dispatch({
        type: "send-payment",
        contactId: "maya",
        amount: toMicroUnits(50),
      });

      expect(result.ok).toBe(true);
      expect(store.getState().state.balances.USDC).toBe(toMicroUnits(10_000) - toMicroUnits(50));
      expect(store.getState().state.pay.activity).toHaveLength(1);

      const restored = createSimulationStore({ now: () => FIXED_NOW });
      await restored.persist.rehydrate();
      expect(restored.getState().state.pay.activity).toEqual(store.getState().state.pay.activity);
    });

    it("dispatches a receive, increasing Cash", () => {
      const store = createSimulationStore({ now: () => FIXED_NOW });
      const result = store.getState().dispatch({
        type: "receive-payment",
        contactId: "jordan",
        amount: toMicroUnits(25),
      });

      expect(result.ok).toBe(true);
      expect(store.getState().state.balances.USDC).toBe(toMicroUnits(10_000) + toMicroUnits(25));
    });

    it("dispatches a deposit and a withdrawal", () => {
      const store = createSimulationStore({ now: () => FIXED_NOW });
      store.getState().dispatch({ type: "deposit-cash", amount: toMicroUnits(200) });
      store.getState().dispatch({ type: "withdraw-cash", amount: toMicroUnits(75) });

      expect(store.getState().state.balances.USDC).toBe(toMicroUnits(10_000) + toMicroUnits(200) - toMicroUnits(75));
      expect(store.getState().state.pay.activity.map((a) => a.kind)).toEqual(["deposit", "withdraw"]);
    });

    it("creates a request, moving no Cash, and persists it as pending", async () => {
      const store = createSimulationStore({ now: () => FIXED_NOW });
      const result = store.getState().dispatch({
        type: "create-payment-request",
        contactId: "alex",
        amount: toMicroUnits(40),
      });

      expect(result.ok).toBe(true);
      expect(store.getState().state.balances.USDC).toBe(toMicroUnits(10_000));
      expect(store.getState().state.pay.requests).toEqual([
        expect.objectContaining({ id: "request-1", status: "pending" }),
      ]);

      const restored = createSimulationStore({ now: () => FIXED_NOW });
      await restored.persist.rehydrate();
      expect(restored.getState().state.pay.requests).toEqual(store.getState().state.pay.requests);
    });

    it("completes a request exactly once, and persists the paid status and counters", async () => {
      const store = createSimulationStore({ now: () => FIXED_NOW });
      const created = store.getState().dispatch({
        type: "create-payment-request",
        contactId: "alex",
        amount: toMicroUnits(40),
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const requestId = created.paymentRequest!.id;

      const paid = store.getState().dispatch({ type: "complete-payment-request", requestId });
      expect(paid.ok).toBe(true);
      expect(store.getState().state.balances.USDC).toBe(toMicroUnits(10_000) + toMicroUnits(40));

      const second = store.getState().dispatch({ type: "complete-payment-request", requestId });
      expect(second.ok).toBe(false);
      expect(store.getState().state.balances.USDC).toBe(toMicroUnits(10_000) + toMicroUnits(40));

      const restored = createSimulationStore({ now: () => FIXED_NOW });
      await restored.persist.rehydrate();
      expect(restored.getState().state.pay.requests[0].status).toBe("paid");
      expect(restored.getState().state.pay.nextRequestId).toBe(2);
      expect(restored.getState().state.pay.nextActivityId).toBe(2);
    });

    it("migrates a pre-pay (v4) entry, preserving every previous field exactly and seeding empty Pay state", async () => {
      const balances = { USDC: toMicroUnits(4_000), ETH: toMicroUnits(2) };
      const pool = { reserves: createInitialPoolReserves() };
      const clockOffsetMs = 12_345;
      // lastAccruedAt is set so that getSimulatedNow(state, FIXED_NOW) - lastAccruedAt === 0:
      // rehydration's accrueSavings call then earns no additional interest,
      // so every savings field below can be asserted exactly rather than
      // with a >= bound.
      const savings = {
        balance: toMicroUnits(500),
        interestEarnedTotal: toMicroUnits(20),
        lastAccruedAt: FIXED_NOW + clockOffsetMs,
      };
      const borrow = { collateralEth: toMicroUnits(1), debtMicroUsd: toMicroUnits(1_000) };
      const market = { pricesMicroUsd: { USDC: toMicroUnits(1), ETH: toMicroUnits(2_500) } };
      const invest = createInitialInvestState();
      invest.holdings.BTC = { unitsHeld: toMicroUnits(0.01), costBasisMicroUsd: toMicroUnits(600) };
      const investmentMarket = createInitialInvestmentMarketState();

      localStorage.setItem(
        SIMULATION_STORE_NAME,
        JSON.stringify({
          state: {
            state: { balances, pool, savings, clockOffsetMs, borrow, market, invest, investmentMarket },
          },
          version: 4,
        }),
      );

      const store = createSimulationStore({ now: () => FIXED_NOW });
      await store.persist.rehydrate();

      const state = store.getState().state;
      expect(state.balances).toEqual(balances);
      expect(state.pool).toEqual(pool);
      expect(state.clockOffsetMs).toBe(clockOffsetMs);
      expect(state.savings).toEqual(savings);
      expect(state.borrow).toEqual(borrow);
      expect(state.market).toEqual(market);
      expect(state.invest).toEqual(invest);
      expect(state.investmentMarket).toEqual(investmentMarket);
      expect(state.pay).toEqual(createInitialPayState());
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
