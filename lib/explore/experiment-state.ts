// Deterministic starting states for Explore's isolated sandboxes. See
// ARCHITECTURE.md's "Explore sandbox" section for the full architecture:
// each experiment gets a fresh SimulationState built from
// createInitialState() — never a reference to the user's real Practice
// Mode state — so there is no reachable path from a sandbox back into the
// app's Zustand store.

import {
  applyAction,
  createInitialState,
  toMicroUnits,
  type Action,
  type SimulationState,
} from "@/simulation";

/**
 * Fixed simulated "now" for every Explore sandbox. Never Date.now() — an
 * experiment must produce byte-identical state on every run, on every
 * machine, regardless of when it's opened. The exact value is arbitrary;
 * what matters is that it never changes.
 */
export const EXPERIMENT_NOW_MS = 1_700_000_000_000;

export type ExperimentId = "liquidity" | "liquidation" | "yield" | "risk" | "payments";

/**
 * Runs one action a fixture depends on succeeding, via the real engine.
 * Throws if it doesn't — a fixture that can fail isn't a valid fixture, and
 * this should only ever happen from a mistake in the builder below, not
 * from anything a user does.
 */
function run(state: SimulationState, action: Action): SimulationState {
  const result = applyAction(state, action, EXPERIMENT_NOW_MS);
  if (!result.ok) {
    throw new Error(`Explore fixture action failed: ${action.type} — ${result.error}`);
  }
  return result.state;
}

/**
 * Directly sets spendable balances. Reserved for primitive starting
 * holdings (cash, ETH) — the same kind of thing createInitialState() itself
 * seeds "from outside the app". Anything derived (a loan, a savings
 * position, an investment holding) is built by dispatching real actions
 * below instead, so it can't become a position the engine would never
 * actually produce.
 */
function seedBalances(
  state: SimulationState,
  balances: Partial<SimulationState["balances"]>,
): SimulationState {
  return { ...state, balances: { ...state.balances, ...balances } };
}

/**
 * "You own $30,000 of ETH. Can you sell it for $30,000?" — 10 ETH, no cash,
 * pool at genesis reserves (75,000 USDC / 25 ETH). Selling into it is what
 * demonstrates price impact; nothing about the setup should.
 */
function createLiquidityFixture(): SimulationState {
  const base = createInitialState(EXPERIMENT_NOW_MS);
  return seedBalances(base, { USDC: 0, ETH: toMicroUnits(10) });
}

/**
 * "What happens if ETH falls?" — 2 ETH pledged, $3,000 borrowed against it.
 * That's exactly the engine's MAX_BORROW_LTV_BPS (50%) at ETH's genesis
 * price of $3,000, so every number in the starting position is round: 50%
 * LTV, $2,000 liquidation price. Built by pledging and borrowing rather
 * than hand-writing the position, so it obeys the same limits a real user
 * would hit.
 */
function createLiquidationFixture(): SimulationState {
  const base = createInitialState(EXPERIMENT_NOW_MS);
  const seeded = seedBalances(base, { USDC: 0, ETH: toMicroUnits(2) });
  const pledged = run(seeded, { type: "add-collateral", amount: toMicroUnits(2) });
  return run(pledged, { type: "borrow-cash", amount: toMicroUnits(3_000) });
}

/**
 * "What does a 4% annual rate look like over time?" — $1,000 already
 * deposited into savings, right at the fixture's fixed clock, so elapsed
 * time starts at exactly zero.
 */
function createYieldFixture(): SimulationState {
  const base = createInitialState(EXPERIMENT_NOW_MS);
  const seeded = seedBalances(base, { USDC: toMicroUnits(1_000) });
  return run(seeded, { type: "deposit-to-savings", amount: toMicroUnits(1_000) });
}

/**
 * "Why not put everything in whatever grows fastest?" — $1,000 into each of
 * the three curated investments, so one market move (see
 * INVESTMENT_MARKET_MOVE_BPS) lands on identical starting positions and the
 * spread in outcomes is the only variable.
 */
function createRiskFixture(): SimulationState {
  const base = createInitialState(EXPERIMENT_NOW_MS);
  const seeded = seedBalances(base, { USDC: toMicroUnits(3_000) });
  const withBtc = run(seeded, { type: "buy-investment", assetId: "BTC", amount: toMicroUnits(1_000) });
  const withBroad = run(withBtc, {
    type: "buy-investment",
    assetId: "BROAD",
    amount: toMicroUnits(1_000),
  });
  return run(withBroad, { type: "buy-investment", assetId: "TBILL", amount: toMicroUnits(1_000) });
}

/**
 * "What actually happens when you send money?" — $100 cash, nothing sent,
 * requested, or recorded yet.
 */
function createPaymentsFixture(): SimulationState {
  const base = createInitialState(EXPERIMENT_NOW_MS);
  return seedBalances(base, { USDC: toMicroUnits(100) });
}

const EXPERIMENT_BUILDERS: Record<ExperimentId, () => SimulationState> = {
  liquidity: createLiquidityFixture,
  liquidation: createLiquidationFixture,
  yield: createYieldFixture,
  risk: createRiskFixture,
  payments: createPaymentsFixture,
};

/** The deterministic starting SimulationState for one Explore experiment. */
export function createExperimentState(experimentId: ExperimentId): SimulationState {
  return EXPERIMENT_BUILDERS[experimentId]();
}
