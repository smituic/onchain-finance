# ARCHITECTURE.md

## Status

This document describes **principles and proposed boundaries**, not finalized architecture. No framework, stack, database, hosting, or infrastructure decisions have been made yet. Nothing here should be read as "already decided" — treat it as a set of constraints for whoever (today, a solo developer) eventually makes those decisions.

## Guiding Principles

- **Appropriate for one developer.** Every architectural choice should be justified by what a single person can build, understand, and maintain. No microservices, no distributed systems, no infrastructure that exists to support a team or scale we don't have.
- **Avoid premature abstraction.** Build the simplest thing that satisfies the current phase (see [ROADMAP.md](ROADMAP.md)). Don't build a plugin system, a generic "protocol adapter framework," or configurable everything before there are at least two real cases that need it.
- **Simulate first, generalize later.** The MVP's financial logic (balances, swaps, yield, borrowing, liquidation) should be implemented as a straightforward simulation — plain data and logic, not a blockchain client pretending to be one.
- **Keep the door open to testnet, without building for it yet.** The simulation logic and the UI should not be so tangled together that replacing "simulated balances" with "real testnet balances" later requires a rewrite. This means: keep a conceptual seam between "what the numbers are" and "how the numbers are displayed and acted on" — but don't build a formal plugin interface for it until Phase 2 actually requires one.
- **Boring and legible over clever.** Prefer well-understood, widely-documented tools and patterns. A solo developer's biggest risk is complexity they can't hold in their head or debug alone.

## Proposed Conceptual Boundaries

These are *conceptual* boundaries to keep in mind while building the MVP — not a prescription for folder structure, services, or specific technologies:

- **Simulation / ledger layer** — owns the fake financial state: balances, positions, rates, collateral, and the rules for how actions (swap, deposit, borrow, repay) change that state, including liquidation logic. This layer should not know or care how it's displayed.
- **Presentation layer** — the UI and interaction design described in [DESIGN.md](DESIGN.md). It reads from and issues actions to the simulation layer, and owns all the contextual education/teaching-moment logic.
- **Future chain adapter (not built yet)** — in Phase 2 (testnet), a layer will need to exist that can satisfy the same shape of requests the simulation layer currently satisfies, but backed by real wallet/chain interaction instead of simulated state. We are not designing this layer now — we are simply avoiding decisions today that would make it unnecessarily painful to introduce later.

## Explicitly Not Yet Decided

- Application framework / language / runtime
- Data storage (if any is needed beyond local/in-memory state for the MVP)
- Hosting and deployment
- Authentication and user accounts
- Any blockchain, wallet, or chain-specific SDK or library
- Testing strategy and tooling

These should be decided when they're actually needed to move the MVP forward, with a preference for the smallest, most boring option that works — and recorded here once chosen.

## How to Use This Document

When implementation actually begins, update this file to reflect real decisions as they're made (with brief rationale), and keep the "proposed boundaries" section honest — if the seam between simulation and presentation stops being real, say so here rather than leaving stale aspirational architecture on record.
