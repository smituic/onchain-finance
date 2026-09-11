# simulation/

This is the framework-agnostic simulation/ledger layer described in [ARCHITECTURE.md](../ARCHITECTURE.md). It owns the fake financial state (balances, positions, rates, collateral) and the rules for how actions change that state — no UI, no framework.

## Rules

- **No imports from `react`, `react-dom`, `next`, or `zustand`.** This is enforced by an ESLint rule scoped to this directory (see `eslint.config.mjs`) — a violation fails lint, not just review.
- **Plain, deterministic TypeScript.** Given the same state and action, always produce the same result. This is what makes the engine cheap to unit test and safe to reason about.
- **The presentation layer depends on this layer, never the other way around.** Components and the Zustand store read from and dispatch actions into this layer; this layer never imports from `app/`, `components/`, or a store.

## Status

Initial state, swap, and a constant-product (x*y=k) liquidity pool are implemented (`pool.ts`, `actions/swap.ts`) — swap execution now depends on trade size relative to pool reserves (price impact), still zero fee. Portfolio valuation (`valuation.ts`) intentionally still marks assets at the static reference prices in `assets.ts`, not the pool's live price — a known simplification, not an oversight.

Savings are implemented (`savings.ts`, `actions/savings.ts`): a single position earning a fixed `SAVINGS_ANNUAL_RATE_BPS` (4.00%/yr), with interest credited into the balance at interaction boundaries rather than by a timer. Time is passed in rather than read here — `applyAction(state, action, nowMs)` — so accrual stays deterministic and testable; `clockOffsetMs` holds the simulated time a user has skipped forward via Practice Mode's time control.

Borrowing is implemented (`borrow.ts`, `actions/borrow.ts`): one collateralised position — ETH pledged, Cash owed — capped at `MAX_BORROW_LTV_BPS` (50%) and liquidated in full at `LIQUIDATION_THRESHOLD_BPS` (75%). `getBorrowPosition()` derives the whole position (value, capacity, LTV, health, liquidation price) from state rather than storing it. Full liquidation with the surplus returned as Cash is a documented Practice Mode simplification — no partial liquidation, no liquidator bonus, no interest on the debt.

Prices now come from two deliberately separate places: `market.ts` holds the simulated **market/reference price** used for valuation and collateral (and moved by Practice Mode crash scenarios), while `pool.ts`'s spot price remains the **execution price** for swaps. A crash scenario re-prices collateral without trading against the pool or touching its reserves.
