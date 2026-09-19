# ARCHITECTURE.md

## Status

This document records the architectural **principles**, the **decisions actually made** so far (Phase 1, and the start of Phase 2), and what is still open. Decisions are listed with brief rationale; anything in "Explicitly Not Yet Decided" or marked as a *candidate* should not be read as settled.

## Guiding Principles

- **Appropriate for one developer.** Every architectural choice should be justified by what a single person can build, understand, and maintain. No microservices, no distributed systems, no infrastructure that exists to support a team or scale we don't have.
- **Avoid premature abstraction.** Build the simplest thing that satisfies the current phase (see [ROADMAP.md](ROADMAP.md)). Don't build a plugin system, a generic "protocol adapter framework," or configurable everything before there are at least two real cases that need it.
- **Simulate first, generalize later.** The MVP's financial logic (balances, swaps, yield, borrowing, liquidation) should be implemented as a straightforward simulation — plain data and logic, not a blockchain client pretending to be one.
- **Practice and Real are parallel paths, not one engine with two backends.** The Practice simulation is pure and synchronous; real chain interaction is asynchronous with intermediate states. Forcing both behind one interface would make the simulation worse at its job without making Real Mode better at its own. They share the presentation layer (formatters, rows, notes, the shell) — never an engine, a store, or persisted state. See "Phase 2 Decisions".
- **Boring and legible over clever.** Prefer well-understood, widely-documented tools and patterns. A solo developer's biggest risk is complexity they can't hold in their head or debug alone.

## Conceptual Boundaries

- **Simulation / ledger layer** (`simulation/`) — owns the fake financial state: balances, positions, rates, collateral, and the rules for how actions (swap, deposit, borrow, repay) change that state, including liquidation logic. Pure, synchronous, framework-agnostic; it does not know how it's displayed and does not know Real Mode exists.
- **Real layer** (`lib/real/`, reserved — populated from Phase 2 Batch 2) — owns everything about a real account and real chain interaction: account identity, balance reads, transaction submission and status. Asynchronous, framework-agnostic, and fenced from the simulation in both directions. It is the *only* place a blockchain SDK may be imported (plus server-side route handlers under `app/api/real/**` that must hold a secret).
- **Presentation layer** — the UI and interaction design described in [DESIGN.md](DESIGN.md). It reads from and issues actions to *either* the simulation store or the Real store, chosen per page by the mode boundary, and owns all the contextual education/teaching-moment logic. Components never import a chain SDK.

Originally this document anticipated a "chain adapter" that would satisfy the same shape of requests as the simulation layer. That was dropped when Phase 2 was actually scoped — see the principle above and "Phase 2 Decisions" below.

## Phase 1 Decisions

The following technical choices have been made for Phase 1 (see [ROADMAP.md](ROADMAP.md)). Each is chosen for being the smallest, most boring option that satisfies Phase 1 without foreclosing Phase 2.

- **Framework/language: Next.js (App Router) + React + TypeScript.** The deepest ecosystem for consumer-grade UI, and TypeScript catches bugs in financial state transitions at compile time. Next.js also provides routing and server-side capability (route handlers) in one project, with no separate backend service for a solo developer to run — which Phase 2 relies on for anything that must hold a secret.
- **Styling: Tailwind CSS.** Expresses spacing, type scale, and layout directly without committing to a themed design system, consistent with DESIGN.md still leaving exact visual identity undecided.
- **Component foundation: shadcn/ui.** Used as a source of accessible, unstyled primitives (dialogs, tooltips, popovers — needed for contextual education moments), not as a themed component library. Components are copied into the codebase and customized to match DESIGN.md rather than kept in their default visual identity. Only components actually needed are added — no bulk install of the full set. See the corresponding note in [DESIGN.md](DESIGN.md).
- **Application/simulation state: Zustand.** Portfolio, swap, earn, and borrow/liquidation all read and mutate the user's real Practice Mode financial state through one shared store, rather than component-local state that would need to be lifted and merged later. Explore is a deliberate exception — see "Explore sandbox" below.
- **Simulation engine: plain, framework-agnostic TypeScript.** Pure, deterministic functions (`applyAction(state, action) → newState`) with no dependency on React, Next.js, or any UI code. This is the "simulation/ledger layer" boundary described above — kept framework-agnostic so it's cheap to test, and kept unchanged by Phase 2 (Real Mode is a parallel path, not a second implementation of this interface).
- **Explore sandbox: isolated, ephemeral `SimulationState` — not the Zustand store.** Explore's interactive experiments (`lib/explore/experiment-state.ts`, `lib/explore/use-experiment-simulation.ts`) each get their own `SimulationState`, built by `createExperimentState()` from `createInitialState()` plus real `applyAction()` calls — never from a reference to the user's actual Practice portfolio. A `useExperimentSimulation()` hook holds that state in plain React state local to the experiment's component and dispatches into it via the same `applyAction()` the rest of the app uses, with a fixed simulated clock (`EXPERIMENT_NOW_MS`) so every fixture and every scenario is fully deterministic. This was chosen over (a) mutating the user's real Practice state directly, and (b) snapshotting and restoring it around an experiment: both make an experiment's "reset" ambiguous with the user's own portfolio, and (b) additionally breaks determinism (real dispatch reads the wall clock) and risks the persist middleware writing sandbox state to `localStorage` if an exit path is missed. An isolated sandbox reuses the same engine and financial math with no new abstraction, needs no persistence migration (experiment progress isn't the user's money and has no value across sessions), and can't reach the main store even by mistake — enforced by an ESLint rule banning `@/lib/stores/simulation-store` imports from `components/explore/**` and `lib/explore/**`, and proven by tests asserting the main store's state is referentially unchanged (`toBe`, not just `toEqual`) after driving every control in every experiment.
- **Persistence: browser storage (localStorage/IndexedDB).** Phase 1 is a single-user sandbox with fake money and no accounts, so there is no requirement yet for server-side or cross-device storage. Accessed through a small persistence module so a future backend swap touches one place, not the whole app.
- **Authentication: none in Phase 1.** There is nothing to protect — state lives in the user's own browser. Avoids building an accounts system now that would likely be redone once Phase 2/3 introduce real wallets and real funds.
- **Testing: Vitest for the simulation engine, React Testing Library for key interaction tests.** The simulation engine's purity makes it cheap to test thoroughly (swap math, collateral ratios, liquidation triggers), which matters most since bugs there would most directly undermine user trust. React Testing Library covers a small number of critical flows, not full coverage.
- **Charting: Recharts, installed only when a chart is actually needed.** Declarative and React-native; avoids solving rendering/interaction problems by hand that a library already solves.
- **Animation: Framer Motion, installed only when CSS/Tailwind transitions aren't enough.** Tailwind's transition utilities handle simple cases; Framer Motion is reserved for more expressive, stateful motion (e.g., the liquidation moment).
- **Deployment: Vercel.** Zero-config for Next.js, no infrastructure for a solo developer to manage.
- **Package manager: pnpm.** Fast, disk-efficient, and catches phantom-dependency bugs via its strict dependency graph.
- **No blockchain/Web3 libraries in Phase 1.** No wallet connectors, RPC providers, or smart contract tooling — Phase 1 has no chain interaction of any kind. (Still true after Phase 2 Batch 1; the first chain dependency arrives with the real account foundation.)

## Phase 2 Decisions

Made while building Batch 1 of Phase 2 (the Practice/Real boundary — see [ROADMAP.md](ROADMAP.md) for the sequencing decision that put Pay first).

- **Mode is explicit, persisted, non-financial state: `lib/stores/mode-store.ts`.** A second, tiny Zustand store (`onchain-finance:mode`) holding `mode`, `hasAcknowledgedRealIntro`, and the same explicit-rehydration `hasHydrated` flag as the simulation store. It lives outside `simulation-store` so Real Mode needs no persistence migration of the ledger and so Practice invariance can be proven by reference equality. Rejected alternatives: route-level `/real/*` routes (duplicates navigation and contradicts "same product, flip a switch"), React context (a second mechanism for what Zustand already does), and a mode field inside the simulation store.
- **The feature flag is authoritative.** `NEXT_PUBLIC_REAL_MODE_ENABLED` is read once at store creation into a non-persisted `realModeEnabled`. `selectMode`/`useMode` return Practice whenever it's off, `setMode("real")` is refused, and a persisted `"real"` is normalised back to Practice on rehydration — so a browser that remembers Real Mode from an earlier build cannot stay there after a build disables it. This is the single place the flag is enforced; pages and components never check it themselves. Default is off, so an unconfigured build is byte-for-byte the Phase 1 Practice-only experience.
- **Per-page boundary: `ByMode`.** Each page hands in its two parallel presentations (`practice`, `real`) and `components/shell/by-mode.tsx` picks one. With the flag off it renders Practice immediately (server-side too); otherwise it holds a neutral skeleton until the mode store has hydrated, so a Real Mode user never sees Practice flash first. Practice views were not edited to add this — only the `page.tsx` files compose it. Explore is deliberately *not* wrapped: its experiments always run on separate Practice money, and a notice says so in Real Mode.
- **Areas without a Real implementation render `PracticeOnly`** ("{Area} is Practice-only for now" plus "Try it in Practice", which switches mode and leaves the user on the same area). An intentional product state, not an error.
- **The one-time Real Mode intro** is a confirmation dialog (Base UI's alert dialog, already a dependency via shadcn) shown before the first switch into Real Mode; acceptance is persisted in the mode store. It exists for honesty — Real Mode is a testnet build with nothing of value in it — not as onboarding infrastructure.
- **Lint-enforced fences** (`eslint.config.mjs`): `simulation/**` may not import Real Mode, app stores, or chain SDKs; `lib/real/**` may not import React/Next/Zustand, the simulation, or app stores; nothing under `app/**`, `components/**`, or `lib/**` may import a chain SDK except `lib/real/**` and `app/api/real/**`. Because flat-config rule options replace rather than merge, each block carries its full `no-restricted-imports` set — composed from shared pieces in the config file.
- **Store hydration** is one root client component (`components/store-hydration.tsx`) that rehydrates every persisted store; mode first.

### Candidates for the next batches — pending external verification, not decided

The architecture review for the real account foundation converged on a candidate stack. Each item depends on current external facts (SDK surfaces, network lifetimes, service availability) that must be verified when the batch is implemented, and none is a dependency yet:

- **Network:** Base Sepolia, with Circle-issued testnet USDC as the asset behind "Cash" (the internal symbol stays `USDC`; "Cash" remains a presentation label, as in Phase 1). To verify: the Sepolia-family sunset timeline and Base's plan for it.
- **Account:** a passkey-backed smart account via the Base Account SDK, so the app never holds key material and the default path has no seed phrase or extension. To verify: current SDK surface, session restore on reload, localhost passkey behaviour.
- **Gas:** sponsored through an ERC-7677 paymaster reached only via a server-side route handler that holds the paymaster URL. To verify: paymaster availability/limits on the chosen testnet.
- **Client library:** viem for reads, encoding, and types. wagmi/RainbowKit are *not* proposed for this slice (wallet-picker UX contradicts the product; hooks in components would defeat the `lib/real/` boundary).
- **TypeScript target:** `ES2017` today; whether to move to `ES2020` (bigint literals) is decided when a bigint-heavy dependency actually lands.

## Explicitly Not Yet Decided

- Everything in "Candidates for the next batches" above
- Server-side/backend data storage (only relevant if cross-device persistence becomes a real goal)
- How authentication and accounts work beyond a testnet account identity (Phase 2/3)
- End-to-end testing framework (not yet justified by current surface area)
- Anything in DESIGN.md's own "Deliberately Undecided" list (exact colors, typography, icon style, dark mode default)

These should be decided when they're actually needed to move the project forward, with a preference for the smallest, most boring option that works — and recorded here once chosen.

## How to Use This Document

Update this file to reflect real decisions as they're made (with brief rationale), and keep the boundaries section honest — if a seam stops being real, or a candidate is verified or rejected, say so here rather than leaving stale aspirational architecture on record.
