import { describe, expect, it } from "vitest";
import {
  applyAction,
  applyRelativePriceChange,
  createInitialState,
  getBorrowPosition,
  getCryptoValueMicroUsd,
  getNetWorthMicroUsd,
  getPriceMicroUsd,
  LIQUIDATION_THRESHOLD_BPS,
  MAX_BORROW_LTV_BPS,
  toMicroUnits,
  type SimulationState,
} from "@/simulation";

const T0 = 1_700_000_000_000;

/** A user holding 2 ETH ($6,000) and $10,000 cash, nothing pledged yet. */
function stateWithEth(eth = 2): SimulationState {
  const base = createInitialState(T0);
  return { ...base, balances: { ...base.balances, ETH: toMicroUnits(eth) } };
}

function act(state: SimulationState, action: Parameters<typeof applyAction>[1]) {
  const result = applyAction(state, action, T0);
  if (!result.ok) throw new Error(`action failed: ${result.error}`);
  return result;
}

/** 1 ETH pledged, and the maximum ($1,500) borrowed against it. */
function maxedOutPosition(): SimulationState {
  let state = stateWithEth(1);
  state = act(state, { type: "add-collateral", amount: toMicroUnits(1) }).state;
  return act(state, { type: "borrow-cash", amount: toMicroUnits(1_500) }).state;
}

describe("collateral", () => {
  it("moves ETH out of the spendable balance and into the loan", () => {
    const next = act(stateWithEth(), { type: "add-collateral", amount: toMicroUnits(1) }).state;

    expect(next.balances.ETH).toBe(toMicroUnits(1));
    expect(next.borrow.collateralEth).toBe(toMicroUnits(1));
    // Still the user's ETH — pledging it can't change what they're worth.
    expect(getNetWorthMicroUsd(next)).toBe(getNetWorthMicroUsd(stateWithEth()));
    expect(getCryptoValueMicroUsd(next)).toBe(toMicroUnits(6_000));
  });

  it("refuses to pledge ETH the user doesn't own", () => {
    const result = applyAction(
      stateWithEth(1),
      { type: "add-collateral", amount: toMicroUnits(2) },
      T0,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INSUFFICIENT_BALANCE");
  });

  it("rejects zero, negative, and fractional micro-unit amounts", () => {
    for (const amount of [0, -1, 0.5]) {
      const result = applyAction(stateWithEth(), { type: "add-collateral", amount }, T0);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("INVALID_AMOUNT");
    }
  });

  it("gives pledged ETH back when nothing is owed", () => {
    const pledged = act(stateWithEth(), { type: "add-collateral", amount: toMicroUnits(1) }).state;
    const next = act(pledged, { type: "remove-collateral", amount: toMicroUnits(1) }).state;

    expect(next.balances.ETH).toBe(toMicroUnits(2));
    expect(next.borrow.collateralEth).toBe(0);
  });

  it("refuses to give back collateral that a loan still needs", () => {
    const result = applyAction(
      maxedOutPosition(),
      { type: "remove-collateral", amount: toMicroUnits(1) },
      T0,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("WOULD_BE_UNSAFE");
  });

  it("gives collateral back once the loan is repaid", () => {
    const repaid = act(maxedOutPosition(), {
      type: "repay-cash",
      amount: toMicroUnits(1_500),
    }).state;
    const next = act(repaid, { type: "remove-collateral", amount: toMicroUnits(1) }).state;

    expect(next.borrow.collateralEth).toBe(0);
    expect(next.balances.ETH).toBe(toMicroUnits(1));
  });
});

describe("borrow capacity", () => {
  it("allows borrowing up to the maximum share of the collateral's value", () => {
    const pledged = act(stateWithEth(), { type: "add-collateral", amount: toMicroUnits(1) }).state;
    const position = getBorrowPosition(pledged);

    expect(MAX_BORROW_LTV_BPS).toBe(5_000);
    expect(position.collateralValueMicroUsd).toBe(toMicroUnits(3_000));
    expect(position.borrowLimitMicroUsd).toBe(toMicroUnits(1_500));
    expect(position.availableToBorrowMicroUsd).toBe(toMicroUnits(1_500));
  });

  it("shrinks as the user borrows and grows as they repay", () => {
    let state = act(stateWithEth(), { type: "add-collateral", amount: toMicroUnits(1) }).state;
    state = act(state, { type: "borrow-cash", amount: toMicroUnits(500) }).state;
    expect(getBorrowPosition(state).availableToBorrowMicroUsd).toBe(toMicroUnits(1_000));

    state = act(state, { type: "repay-cash", amount: toMicroUnits(200) }).state;
    expect(getBorrowPosition(state).availableToBorrowMicroUsd).toBe(toMicroUnits(1_200));
  });

  it("reacts immediately to a change in the collateral's price", () => {
    const state = act(stateWithEth(), { type: "add-collateral", amount: toMicroUnits(1) }).state;
    const crashed = act(state, { type: "simulate-eth-price-change", changeBps: -2_000 }).state;

    const position = getBorrowPosition(crashed);
    expect(position.collateralValueMicroUsd).toBe(toMicroUnits(2_400));
    expect(position.availableToBorrowMicroUsd).toBe(toMicroUnits(1_200));
  });

  it("is zero with no collateral pledged", () => {
    expect(getBorrowPosition(stateWithEth()).availableToBorrowMicroUsd).toBe(0);
  });
});

describe("borrowing cash", () => {
  it("hands over cash and records the debt, without making the user richer", () => {
    const pledged = act(stateWithEth(), { type: "add-collateral", amount: toMicroUnits(1) }).state;
    const before = getNetWorthMicroUsd(pledged);

    const next = act(pledged, { type: "borrow-cash", amount: toMicroUnits(1_000) }).state;

    expect(next.balances.USDC).toBe(toMicroUnits(11_000));
    expect(next.borrow.debtMicroUsd).toBe(toMicroUnits(1_000));
    expect(getNetWorthMicroUsd(next)).toBe(before);
  });

  it("refuses to lend beyond the borrowing limit", () => {
    const pledged = act(stateWithEth(), { type: "add-collateral", amount: toMicroUnits(1) }).state;
    const result = applyAction(
      pledged,
      { type: "borrow-cash", amount: toMicroUnits(1_500) + 1 },
      T0,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("EXCEEDS_BORROW_LIMIT");
  });

  it("refuses to lend against nothing", () => {
    const result = applyAction(stateWithEth(), { type: "borrow-cash", amount: toMicroUnits(1) }, T0);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("EXCEEDS_BORROW_LIMIT");
  });

  it("can never borrow its way into liquidation", () => {
    const maxed = maxedOutPosition();
    expect(getBorrowPosition(maxed).isLiquidatable).toBe(false);
    expect(getBorrowPosition(maxed).ltvBps).toBe(MAX_BORROW_LTV_BPS);
  });
});

describe("repaying", () => {
  it("reduces cash and debt together, leaving net worth alone", () => {
    const borrowed = maxedOutPosition();
    const before = getNetWorthMicroUsd(borrowed);

    const next = act(borrowed, { type: "repay-cash", amount: toMicroUnits(500) }).state;

    expect(next.balances.USDC).toBe(toMicroUnits(11_000));
    expect(next.borrow.debtMicroUsd).toBe(toMicroUnits(1_000));
    expect(getNetWorthMicroUsd(next)).toBe(before);
  });

  it("clears the debt entirely but keeps the collateral pledged", () => {
    const next = act(maxedOutPosition(), {
      type: "repay-cash",
      amount: toMicroUnits(1_500),
    }).state;

    expect(next.borrow.debtMicroUsd).toBe(0);
    expect(next.borrow.collateralEth).toBe(toMicroUnits(1));
    expect(getBorrowPosition(next).health).toBe("safe");
  });

  it("refuses to repay more than is owed", () => {
    const result = applyAction(
      maxedOutPosition(),
      { type: "repay-cash", amount: toMicroUnits(1_500) + 1 },
      T0,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("EXCEEDS_DEBT");
  });

  it("refuses to repay with cash the user doesn't have", () => {
    let state = maxedOutPosition();
    // Spend the cash on savings, leaving the debt outstanding.
    state = act(state, { type: "deposit-to-savings", amount: state.balances.USDC }).state;

    const result = applyAction(state, { type: "repay-cash", amount: toMicroUnits(100) }, T0);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INSUFFICIENT_BALANCE");
  });
});

describe("position health", () => {
  it("is healthy at the borrowing limit and stays healthy after a small move", () => {
    const maxed = maxedOutPosition();
    expect(getBorrowPosition(maxed).health).toBe("safe");

    const dipped = act(maxed, { type: "simulate-eth-price-change", changeBps: -500 }).state;
    expect(getBorrowPosition(dipped).health).toBe("caution");
    expect(getBorrowPosition(dipped).isLiquidatable).toBe(false);
  });

  it("escalates as the collateral falls further", () => {
    const maxed = maxedOutPosition();

    // -20%: $2,400 behind $1,500 → 62.5%
    const risky = act(maxed, { type: "simulate-eth-price-change", changeBps: -2_000 }).state;
    expect(getBorrowPosition(risky).ltvBps).toBe(6_250);
    expect(getBorrowPosition(risky).health).toBe("caution");

    // -30%: $2,100 behind $1,500 → 71.4%
    const danger = act(maxed, { type: "simulate-eth-price-change", changeBps: -3_000 }).state;
    expect(getBorrowPosition(danger).health).toBe("danger");
    expect(getBorrowPosition(danger).isLiquidatable).toBe(false);
  });

  it("reports the price at which the collateral gets sold", () => {
    const position = getBorrowPosition(maxedOutPosition());
    // $1,500 of debt stays safe while 75% of the collateral covers it: $2,000.
    expect(position.liquidationPriceMicroUsd).toBe(toMicroUnits(2_000));
  });

  it("has no ratio or liquidation price when nothing is owed", () => {
    const pledged = act(stateWithEth(), { type: "add-collateral", amount: toMicroUnits(1) }).state;
    const position = getBorrowPosition(pledged);

    expect(position.ltvBps).toBe(0);
    expect(position.health).toBe("safe");
    expect(position.liquidationPriceMicroUsd).toBeNull();
  });
});

describe("liquidation", () => {
  it("does not trigger just below the threshold", () => {
    // 1 ETH behind $1,500: liquidation at $2,000, so $2,001 is still safe.
    let state = stateWithEth(1);
    state = act(state, { type: "add-collateral", amount: toMicroUnits(1) }).state;
    state = act(state, { type: "borrow-cash", amount: toMicroUnits(1_500) }).state;

    const justAbove = applyAction(
      { ...state, market: { pricesMicroUsd: { ...state.market.pricesMicroUsd, ETH: toMicroUnits(2_001) } } },
      { type: "accrue-savings" },
      T0,
    );
    expect(justAbove.ok).toBe(true);
    if (!justAbove.ok) return;
    expect(getBorrowPosition(justAbove.state).isLiquidatable).toBe(false);
  });

  it("triggers exactly at the threshold", () => {
    const atThreshold: SimulationState = {
      ...maxedOutPosition(),
    };
    const priced = {
      ...atThreshold,
      market: {
        pricesMicroUsd: { ...atThreshold.market.pricesMicroUsd, ETH: toMicroUnits(2_000) },
      },
    };

    const position = getBorrowPosition(priced);
    expect(position.ltvBps).toBe(LIQUIDATION_THRESHOLD_BPS);
    expect(position.isLiquidatable).toBe(true);
  });

  it("sells the collateral when a crash pushes the loan past the threshold", () => {
    const result = applyAction(
      maxedOutPosition(),
      { type: "simulate-eth-price-change", changeBps: -4_000 },
      T0,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.liquidation).toBeDefined();

    // 1 ETH at $1,800 covers the $1,500 debt, and $300 comes back as cash.
    expect(result.liquidation!.collateralSoldEth).toBe(toMicroUnits(1));
    expect(result.liquidation!.collateralValueMicroUsd).toBe(toMicroUnits(1_800));
    expect(result.liquidation!.debtClearedMicroUsd).toBe(toMicroUnits(1_500));
    expect(result.liquidation!.returnedToCashMicroUsd).toBe(toMicroUnits(300));

    expect(result.state.borrow).toEqual({ collateralEth: 0, debtMicroUsd: 0 });
    expect(result.state.balances.USDC).toBe(toMicroUnits(11_800));
  });

  it("produces a deterministic final state", () => {
    const a = applyAction(maxedOutPosition(), { type: "simulate-eth-price-change", changeBps: -4_000 }, T0);
    const b = applyAction(maxedOutPosition(), { type: "simulate-eth-price-change", changeBps: -4_000 }, T0);

    expect(a).toEqual(b);
  });

  it("leaves an unleveraged holder's collateral alone in the same crash", () => {
    const pledged = act(stateWithEth(), { type: "add-collateral", amount: toMicroUnits(1) }).state;
    const result = applyAction(pledged, { type: "simulate-eth-price-change", changeBps: -4_000 }, T0);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.liquidation).toBeUndefined();
    expect(result.state.borrow.collateralEth).toBe(toMicroUnits(1));
  });

  it("returns the surplus as cash when the sale covers the debt", () => {
    const borrowed = maxedOutPosition();
    const result = applyAction(
      borrowed,
      { type: "simulate-eth-price-change", changeBps: -4_000 },
      T0,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 1 ETH sells for $1,800, clears the $1,500 debt, $300 comes back.
    expect(result.liquidation!.debtClearedMicroUsd).toBe(toMicroUnits(1_500));
    expect(result.liquidation!.returnedToCashMicroUsd).toBe(toMicroUnits(300));
    expect(result.liquidation!.remainingDebtMicroUsd).toBe(0);
    expect(result.state.borrow).toEqual({ collateralEth: 0, debtMicroUsd: 0 });
    expect(result.state.balances.USDC).toBe(toMicroUnits(11_800));
  });

  it("leaves the unpaid remainder owed when the sale falls short of the debt", () => {
    // -90%: 1 ETH is worth $300 against $1,500 of debt.
    const result = applyAction(
      maxedOutPosition(),
      { type: "simulate-eth-price-change", changeBps: -9_000 },
      T0,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.liquidation!.collateralValueMicroUsd).toBe(toMicroUnits(300));
    expect(result.liquidation!.debtClearedMicroUsd).toBe(toMicroUnits(300));
    expect(result.liquidation!.remainingDebtMicroUsd).toBe(toMicroUnits(1_200));
    // No cash is conjured out of a sale that didn't cover the loan...
    expect(result.liquidation!.returnedToCashMicroUsd).toBe(0);
    expect(result.state.balances.USDC).toBe(toMicroUnits(11_500));
    // ...and the part it couldn't pay is still owed, with nothing behind it.
    expect(result.state.borrow).toEqual({
      collateralEth: 0,
      debtMicroUsd: toMicroUnits(1_200),
    });
  });

  it("creates no value, whether the sale covers the debt or falls short", () => {
    for (const changeBps of [-4_000, -6_000, -9_000, -9_900]) {
      const borrowed = maxedOutPosition();

      // The same position marked at the crashed price, but not yet sold —
      // liquidating is a settlement, so it must land on the same net worth.
      const marked: SimulationState = {
        ...borrowed,
        market: {
          pricesMicroUsd: {
            ...borrowed.market.pricesMicroUsd,
            ETH: applyRelativePriceChange(getPriceMicroUsd(borrowed, "ETH"), changeBps),
          },
        },
      };

      const result = act(borrowed, { type: "simulate-eth-price-change", changeBps });

      expect(getNetWorthMicroUsd(result.state)).toBe(getNetWorthMicroUsd(marked));
    }
  });

  it("cannot be liquidated twice: leftover debt has no collateral left to sell", () => {
    const shortfall = act(maxedOutPosition(), {
      type: "simulate-eth-price-change",
      changeBps: -9_000,
    }).state;
    expect(shortfall.borrow.debtMicroUsd).toBeGreaterThan(0);
    expect(getBorrowPosition(shortfall).isLiquidatable).toBe(false);

    const again = act(shortfall, { type: "simulate-eth-price-change", changeBps: -5_000 });

    expect(again.liquidation).toBeUndefined();
    expect(again.state.borrow.debtMicroUsd).toBe(shortfall.borrow.debtMicroUsd);
  });

  it("lets the user repay debt left over after a shortfall", () => {
    const shortfall = act(maxedOutPosition(), {
      type: "simulate-eth-price-change",
      changeBps: -9_000,
    }).state;

    const repaid = act(shortfall, {
      type: "repay-cash",
      amount: shortfall.borrow.debtMicroUsd,
    }).state;

    expect(repaid.borrow.debtMicroUsd).toBe(0);
    expect(getNetWorthMicroUsd(repaid)).toBe(getNetWorthMicroUsd(shortfall));
  });
});

describe("simulated market price", () => {
  it("re-prices ETH without touching the swap pool", () => {
    const state = maxedOutPosition();
    const next = act(state, { type: "simulate-eth-price-change", changeBps: -2_000 }).state;

    expect(getPriceMicroUsd(next, "ETH")).toBe(toMicroUnits(2_400));
    expect(next.pool).toEqual(state.pool);
  });

  it("leaves savings and the practice clock untouched", () => {
    let state = stateWithEth();
    state = act(state, { type: "deposit-to-savings", amount: toMicroUnits(1_000) }).state;
    state = act(state, { type: "advance-practice-time" }).state;

    const next = act(state, { type: "simulate-eth-price-change", changeBps: -4_000 }).state;

    expect(next.savings).toEqual(state.savings);
    expect(next.clockOffsetMs).toBe(state.clockOffsetMs);
  });

  it("puts the price back where it started on reset", () => {
    let state = act(stateWithEth(), { type: "simulate-eth-price-change", changeBps: -4_000 }).state;
    state = act(state, { type: "reset-eth-price" }).state;

    expect(getPriceMicroUsd(state, "ETH")).toBe(toMicroUnits(3_000));
  });

  it("rejects a meaningless price change", () => {
    for (const changeBps of [0, -10_000, -20_000, 1.5]) {
      const result = applyAction(stateWithEth(), { type: "simulate-eth-price-change", changeBps }, T0);
      expect(result.ok).toBe(false);
    }
  });

  it("moves what the user's crypto is worth, and what they're worth overall", () => {
    const state = stateWithEth(1);
    const before = getNetWorthMicroUsd(state);

    const next = act(state, { type: "simulate-eth-price-change", changeBps: -4_000 }).state;

    expect(getCryptoValueMicroUsd(next)).toBe(toMicroUnits(1_800));
    expect(getNetWorthMicroUsd(next)).toBe(before - toMicroUnits(1_200));
  });
});

describe("state preservation across borrow actions", () => {
  it("keeps savings, the pool, and the clock intact", () => {
    let state = stateWithEth();
    state = act(state, { type: "deposit-to-savings", amount: toMicroUnits(1_000) }).state;
    state = act(state, { type: "advance-practice-time" }).state;
    const savingsBefore = state.savings;
    const poolBefore = state.pool;
    const clockBefore = state.clockOffsetMs;

    state = act(state, { type: "add-collateral", amount: toMicroUnits(1) }).state;
    state = act(state, { type: "borrow-cash", amount: toMicroUnits(1_000) }).state;
    state = act(state, { type: "repay-cash", amount: toMicroUnits(400) }).state;

    expect(state.savings).toEqual(savingsBefore);
    expect(state.pool).toEqual(poolBefore);
    expect(state.clockOffsetMs).toBe(clockBefore);
  });

  it("survives a swap, keeping the loan intact", () => {
    let state = maxedOutPosition();
    const borrowBefore = state.borrow;

    state = act(state, {
      type: "swap",
      fromAsset: "USDC",
      toAsset: "ETH",
      amountIn: toMicroUnits(1_000),
    }).state;

    expect(state.borrow).toEqual(borrowBefore);
  });

  it("does not mutate the state it was given", () => {
    const state = stateWithEth();
    const snapshot = structuredClone(state);

    act(state, { type: "add-collateral", amount: toMicroUnits(1) });

    expect(state).toEqual(snapshot);
  });

  it("keeps every ledger value an exact integer through a full journey", () => {
    let state = stateWithEth(1.234567);
    state = act(state, { type: "add-collateral", amount: toMicroUnits(1.234567) }).state;
    state = act(state, { type: "borrow-cash", amount: toMicroUnits(1_234.56) }).state;
    state = act(state, { type: "simulate-eth-price-change", changeBps: -1_000 }).state;

    expect(Number.isInteger(state.borrow.collateralEth)).toBe(true);
    expect(Number.isInteger(state.borrow.debtMicroUsd)).toBe(true);
    expect(Number.isInteger(state.balances.USDC)).toBe(true);
    expect(Number.isInteger(state.market.pricesMicroUsd.ETH)).toBe(true);
  });
});
