import { describe, expect, it } from "vitest";
import {
  applyAction,
  calculateInterestMicroUsd,
  createInitialState,
  getTotalBalanceMicroUsd,
  PRACTICE_TIME_STEP_MS,
  SAVINGS_ANNUAL_RATE_BPS,
  toMicroUnits,
  type SimulationState,
} from "@/simulation";

const T0 = 1_700_000_000_000; // fixed instant; every test drives the clock explicitly
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function deposit(state: SimulationState, usd: number, at: number) {
  const result = applyAction(state, { type: "deposit-to-savings", amount: toMicroUnits(usd) }, at);
  if (!result.ok) throw new Error(`deposit failed: ${result.error}`);
  return result.state;
}

function withdraw(state: SimulationState, usd: number, at: number) {
  const result = applyAction(state, { type: "withdraw-from-savings", amount: toMicroUnits(usd) }, at);
  if (!result.ok) throw new Error(`withdraw failed: ${result.error}`);
  return result.state;
}

function advance(state: SimulationState, at: number) {
  const result = applyAction(state, { type: "advance-practice-time" }, at);
  if (!result.ok) throw new Error("advance failed");
  return result.state;
}

describe("savings deposits", () => {
  it("moves cash into savings without changing what the user is worth", () => {
    const state = createInitialState(T0);
    const before = getTotalBalanceMicroUsd(state);

    const next = deposit(state, 1_000, T0);

    expect(next.balances.USDC).toBe(toMicroUnits(9_000));
    expect(next.savings.balance).toBe(toMicroUnits(1_000));
    expect(getTotalBalanceMicroUsd(next)).toBe(before);
  });

  it("rejects depositing more cash than the user has", () => {
    const state = createInitialState(T0);
    const result = applyAction(
      state,
      { type: "deposit-to-savings", amount: state.balances.USDC + 1 },
      T0,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INSUFFICIENT_BALANCE");
  });

  it("rejects zero, negative, and fractional micro-unit amounts", () => {
    const state = createInitialState(T0);
    for (const amount of [0, -1, 1.5]) {
      const result = applyAction(state, { type: "deposit-to-savings", amount }, T0);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("INVALID_AMOUNT");
    }
  });

  it("leaves crypto and the swap pool untouched", () => {
    const state = createInitialState(T0);
    const next = deposit(state, 1_000, T0);

    expect(next.balances.ETH).toBe(state.balances.ETH);
    expect(next.pool).toEqual(state.pool);
  });

  it("does not mutate the state it was given", () => {
    const state = createInitialState(T0);
    const snapshot = structuredClone(state);

    deposit(state, 1_000, T0);

    expect(state).toEqual(snapshot);
  });
});

describe("savings withdrawals", () => {
  it("moves money back into cash without changing what the user is worth", () => {
    const saved = deposit(createInitialState(T0), 1_000, T0);
    const before = getTotalBalanceMicroUsd(saved);

    const next = withdraw(saved, 400, T0);

    expect(next.savings.balance).toBe(toMicroUnits(600));
    expect(next.balances.USDC).toBe(toMicroUnits(9_400));
    expect(getTotalBalanceMicroUsd(next)).toBe(before);
  });

  it("rejects withdrawing more than the savings balance", () => {
    const saved = deposit(createInitialState(T0), 1_000, T0);
    const result = applyAction(
      saved,
      { type: "withdraw-from-savings", amount: saved.savings.balance + 1 },
      T0,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INSUFFICIENT_BALANCE");
  });

  it("charges no fee and imposes no lockup", () => {
    const saved = deposit(createInitialState(T0), 1_000, T0);
    const emptied = withdraw(saved, 1_000, T0);

    expect(emptied.savings.balance).toBe(0);
    expect(emptied.balances.USDC).toBe(toMicroUnits(10_000));
  });

  it("lets the user withdraw interest that has accrued, immediately", () => {
    const saved = deposit(createInitialState(T0), 1_000, T0);
    const grown = advance(saved, T0);
    const everything = grown.savings.balance;

    const result = applyAction(grown, { type: "withdraw-from-savings", amount: everything }, T0);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.savings.balance).toBe(0);
    expect(result.state.balances.USDC).toBeGreaterThan(toMicroUnits(10_000));
    // The money was earned, so the lifetime counter keeps it after withdrawal.
    expect(result.state.savings.interestEarnedTotal).toBe(grown.savings.interestEarnedTotal);
  });
});

describe("interest accrual", () => {
  it("earns exactly the annual rate over a year", () => {
    const oneYearOnAThousand = calculateInterestMicroUsd(toMicroUnits(1_000), YEAR_MS);
    expect(oneYearOnAThousand).toBe(toMicroUnits(40)); // 4.00% of $1,000
    expect(SAVINGS_ANNUAL_RATE_BPS).toBe(400);
  });

  it("earns nothing over zero elapsed time", () => {
    expect(calculateInterestMicroUsd(toMicroUnits(1_000), 0)).toBe(0);

    const saved = deposit(createInitialState(T0), 1_000, T0);
    const result = applyAction(saved, { type: "accrue-savings" }, T0);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.savings.balance).toBe(saved.savings.balance);
    expect(result.state.savings.interestEarnedTotal).toBe(0);
  });

  it("earns nothing on an empty position", () => {
    const state = createInitialState(T0);
    const result = applyAction(state, { type: "accrue-savings" }, T0 + YEAR_MS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.savings.balance).toBe(0);
    expect(result.state.savings.interestEarnedTotal).toBe(0);
    // The clock still moves, so the idle period can't be banked and paid
    // out on a later deposit.
    expect(result.state.savings.lastAccruedAt).toBe(T0 + YEAR_MS);
  });

  it("credits interest into the balance as real elapsed time passes", () => {
    const saved = deposit(createInitialState(T0), 1_000, T0);
    const result = applyAction(saved, { type: "accrue-savings" }, T0 + YEAR_MS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.savings.balance).toBe(toMicroUnits(1_040));
    expect(result.state.savings.interestEarnedTotal).toBe(toMicroUnits(40));
  });

  it("ignores a clock that appears to run backwards", () => {
    const saved = deposit(createInitialState(T0), 1_000, T0);
    const result = applyAction(saved, { type: "accrue-savings" }, T0 - YEAR_MS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toEqual(saved);
  });

  it("keeps every ledger value an exact integer", () => {
    let state = deposit(createInitialState(T0), 1_234.567891, T0);
    state = advance(state, T0);
    state = advance(state, T0);

    expect(Number.isInteger(state.savings.balance)).toBe(true);
    expect(Number.isInteger(state.savings.interestEarnedTotal)).toBe(true);
    expect(Number.isInteger(state.balances.USDC)).toBe(true);
    expect(Number.isInteger(state.savings.lastAccruedAt)).toBe(true);
  });

  it("stays coherent across deposits made at different times", () => {
    // $1,000 for a month, then another $1,000 for a second month.
    let state = deposit(createInitialState(T0), 1_000, T0);
    state = advance(state, T0);
    const afterFirstMonth = state.savings.interestEarnedTotal;

    state = deposit(state, 1_000, T0);
    state = advance(state, T0);
    const secondMonthInterest = state.savings.interestEarnedTotal - afterFirstMonth;

    // The second month earns on roughly twice the balance, so roughly twice
    // the interest — and strictly more, since the first month compounded.
    expect(secondMonthInterest).toBeGreaterThan(afterFirstMonth * 2);
    expect(secondMonthInterest).toBeLessThan(afterFirstMonth * 2.1);
  });

  it("does not pay interest on money that was already withdrawn", () => {
    let state = deposit(createInitialState(T0), 1_000, T0);
    state = withdraw(state, 1_000, T0);
    state = advance(state, T0);

    expect(state.savings.interestEarnedTotal).toBe(0);
  });
});

describe("practice-mode time control", () => {
  it("moves the simulation clock forward by one month and pays that month's interest", () => {
    const saved = deposit(createInitialState(T0), 1_000, T0);
    const next = advance(saved, T0);

    expect(next.clockOffsetMs).toBe(PRACTICE_TIME_STEP_MS);
    // 4% a year on $1,000 for 30 days.
    expect(next.savings.interestEarnedTotal).toBe(3_287_671);
    expect(next.savings.balance).toBe(toMicroUnits(1_000) + 3_287_671);
  });

  it("is deterministic: the same jumps from the same start always give the same result", () => {
    const saved = deposit(createInitialState(T0), 1_000, T0);

    const a = advance(advance(saved, T0), T0);
    const b = advance(advance(saved, T0), T0);

    expect(a).toEqual(b);
  });

  it("increases what the user is worth, because the simulation created earnings", () => {
    const saved = deposit(createInitialState(T0), 1_000, T0);
    const before = getTotalBalanceMicroUsd(saved);

    const next = advance(saved, T0);

    expect(getTotalBalanceMicroUsd(next)).toBeGreaterThan(before);
    expect(getTotalBalanceMicroUsd(next)).toBe(before + next.savings.interestEarnedTotal);
  });

  it("leaves swap state alone", () => {
    const saved = deposit(createInitialState(T0), 1_000, T0);
    const next = advance(saved, T0);

    expect(next.pool).toEqual(saved.pool);
    expect(next.balances.ETH).toBe(saved.balances.ETH);
  });
});
