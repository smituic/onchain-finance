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

## Phase 1 Decisions

The following technical choices have been made for Phase 1 (see [ROADMAP.md](ROADMAP.md)). Each is chosen for being the smallest, most boring option that satisfies Phase 1 without foreclosing Phase 2.

- **Framework/language: Next.js (App Router) + React + TypeScript.** The deepest ecosystem for consumer-grade UI, and TypeScript catches bugs in financial state transitions at compile time. Next.js also provides routing and server-side capability in one project, with no separate backend service for a solo developer to run. The standard Phase 2 wallet-connection stack (wagmi, viem, RainbowKit) is React-first, so this choice doesn't need to be revisited when testnet work begins.
- **Styling: Tailwind CSS.** Expresses spacing, type scale, and layout directly without committing to a themed design system, consistent with DESIGN.md still leaving exact visual identity undecided.
- **Component foundation: shadcn/ui.** Used as a source of accessible, unstyled primitives (dialogs, tooltips, popovers — needed for contextual education moments), not as a themed component library. Components are copied into the codebase and customized to match DESIGN.md rather than kept in their default visual identity. Only components actually needed are added — no bulk install of the full set. See the corresponding note in [DESIGN.md](DESIGN.md).
- **Application/simulation state: Zustand.** Portfolio, swap, earn, borrow, liquidation, and Explore/Experiments all read and mutate shared financial state, so a single lightweight shared store is used from the start rather than component-local state that would need to be lifted and merged later.
- **Simulation engine: plain, framework-agnostic TypeScript.** Pure, deterministic functions (`applyAction(state, action) → newState`) with no dependency on React, Next.js, or any UI code. This is the "simulation/ledger layer" boundary described above — kept framework-agnostic so it's cheap to test and so Phase 2 can introduce a real testnet-backed implementation behind the same shape of interface without rewriting this layer.
- **Persistence: browser storage (localStorage/IndexedDB).** Phase 1 is a single-user sandbox with fake money and no accounts, so there is no requirement yet for server-side or cross-device storage. Accessed through a small persistence module so a future backend swap touches one place, not the whole app.
- **Authentication: none in Phase 1.** There is nothing to protect — state lives in the user's own browser. Avoids building an accounts system now that would likely be redone once Phase 2/3 introduce real wallets and real funds.
- **Testing: Vitest for the simulation engine, React Testing Library for key interaction tests.** The simulation engine's purity makes it cheap to test thoroughly (swap math, collateral ratios, liquidation triggers), which matters most since bugs there would most directly undermine user trust. React Testing Library covers a small number of critical flows, not full coverage.
- **Charting: Recharts, installed only when a chart is actually needed.** Declarative and React-native; avoids solving rendering/interaction problems by hand that a library already solves.
- **Animation: Framer Motion, installed only when CSS/Tailwind transitions aren't enough.** Tailwind's transition utilities handle simple cases; Framer Motion is reserved for more expressive, stateful motion (e.g., the liquidation moment).
- **Deployment: Vercel.** Zero-config for Next.js, no infrastructure for a solo developer to manage.
- **Package manager: pnpm.** Fast, disk-efficient, and catches phantom-dependency bugs via its strict dependency graph.
- **No blockchain/Web3 libraries in Phase 1.** No wallet connectors, RPC providers, or smart contract tooling — Phase 1 has no chain interaction of any kind.

## Explicitly Not Yet Decided

- Server-side/backend data storage (only relevant if cross-device persistence becomes a real goal beyond Phase 1)
- How authentication and accounts work once they're needed (Phase 2/3)
- The Phase 2 chain adapter's specific implementation (which testnet, which contracts/protocols, wallet connector configuration)
- End-to-end testing framework (not yet justified by current surface area)
- Anything in DESIGN.md's own "Deliberately Undecided" list (exact colors, typography, icon style, dark mode default)

These should be decided when they're actually needed to move the project forward, with a preference for the smallest, most boring option that works — and recorded here once chosen.

## How to Use This Document

When implementation actually begins, update this file to reflect real decisions as they're made (with brief rationale), and keep the "proposed boundaries" section honest — if the seam between simulation and presentation stops being real, say so here rather than leaving stale aspirational architecture on record.
