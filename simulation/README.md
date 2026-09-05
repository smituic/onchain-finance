# simulation/

This is the framework-agnostic simulation/ledger layer described in [ARCHITECTURE.md](../ARCHITECTURE.md). It owns the fake financial state (balances, positions, rates, collateral) and the rules for how actions change that state — no UI, no framework.

## Rules

- **No imports from `react`, `react-dom`, `next`, or `zustand`.** This is enforced by an ESLint rule scoped to this directory (see `eslint.config.mjs`) — a violation fails lint, not just review.
- **Plain, deterministic TypeScript.** Given the same state and action, always produce the same result. This is what makes the engine cheap to unit test and safe to reason about.
- **The presentation layer depends on this layer, never the other way around.** Components and the Zustand store read from and dispatch actions into this layer; this layer never imports from `app/`, `components/`, or a store.

## Status

Initial state, swap, and a constant-product (x*y=k) liquidity pool are implemented (`pool.ts`, `actions/swap.ts`) — swap execution now depends on trade size relative to pool reserves (price impact), still zero fee. Portfolio valuation (`valuation.ts`) intentionally still marks assets at the static reference prices in `assets.ts`, not the pool's live price — a known simplification, not an oversight. Earn, borrow, and liquidation logic have not been implemented yet.
