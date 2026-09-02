# simulation/

This is the framework-agnostic simulation/ledger layer described in [ARCHITECTURE.md](../ARCHITECTURE.md). It owns the fake financial state (balances, positions, rates, collateral) and the rules for how actions change that state — no UI, no framework.

## Rules

- **No imports from `react`, `react-dom`, `next`, or `zustand`.** This is enforced by an ESLint rule scoped to this directory (see `eslint.config.mjs`) — a violation fails lint, not just review.
- **Plain, deterministic TypeScript.** Given the same state and action, always produce the same result. This is what makes the engine cheap to unit test and safe to reason about.
- **The presentation layer depends on this layer, never the other way around.** Components and the Zustand store read from and dispatch actions into this layer; this layer never imports from `app/`, `components/`, or a store.

## Status

Empty. No swap/earn/borrow/liquidation logic has been implemented yet — that's product feature work for a later task, not part of the initial scaffold.
