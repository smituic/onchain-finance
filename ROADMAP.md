# ROADMAP.md

Three phases, increasing in realism and risk. We do not move to the next phase until the current phase's exit criteria are genuinely met — realism should never outpace trust and understanding.

## Phase 1 — MVP: Simulation

**Goal:** Prove that people can learn on-chain finance concepts by doing them, using fake money, in an app that feels like normal consumer finance software.

**In scope:**
- Simulated portfolio with fake starting balances
- Swap between simulated assets
- Simulated yield-earning positions
- Borrowing against simulated collateral
- Simulated liquidation, presented as a teaching moment
- Contextual, in-the-moment education (no separate course/curriculum UI)
- Explore/Experiments: interactive, learn-by-doing scenarios (not lessons or quizzes) covering concepts like market cap vs. liquidity, price impact, stablecoins, lending yield, collateral, and liquidation — including the canonical market-cap-vs-liquidity experiment where a large sale against shallow liquidity yields far less than market cap would suggest
- A design system expressive enough to feel premium, without being locked into final visual decisions (see [DESIGN.md](DESIGN.md))

**Out of scope:**
- Any real funds, wallets, or chain interaction
- Production smart contracts
- Broad asset coverage — a small, well-chosen set of simulated assets is enough
- Accounts/auth beyond whatever is minimally needed to persist a user's simulated state

**Exit criteria:**
- A new user can, unassisted, complete a swap, open a yield position, borrow against collateral, and experience (or clearly understand) liquidation, and can explain in their own words what happened at each step.
- The core loop feels good enough that testing it with real people doesn't require caveats about unfinished UX.

## Phase 2 — Testnet

**Goal:** Introduce real blockchain mechanics underneath the experience users already understand from Phase 1, with no real value at stake.

**In scope:**
- Real wallet connection (testnet)
- Real transactions against public testnet contracts (swap, deposit/yield, borrow/collateral, liquidation) — off-the-shelf or well-audited testnet protocols where possible, not novel contracts built from scratch
- Reconciling the "chain adapter" seam anticipated in [ARCHITECTURE.md](ARCHITECTURE.md): the same actions from Phase 1 now resolve to real (testnet) transactions
- Introducing real-world friction points transparently but gently: gas, confirmation times, transaction failures — explained contextually, same as any other concept

**Out of scope:**
- Real/mainnet funds
- Full asset/protocol breadth — still a curated, teaching-oriented set
- Abstracting away wallets entirely (that's Phase 3)

**Exit criteria:**
- Users can complete the same core loop as Phase 1, now backed by real testnet transactions, without needing to understand wallets or gas beyond what's explained in context.
- The simulation-to-testnet transition validates that the Phase 1 architecture's seam held up reasonably well (informs, doesn't need to be perfect).

## Phase 3 — Long-Term: Consumer Product

**Goal:** A simple, unified consumer interface over real financial primitives — wallets, payments, swaps, lending, borrowing, investing, and tokenized real-world assets (RWAs) — where blockchain complexity is invisible by default.

**In scope:**
- Real funds, real value, production-grade infrastructure and security
- Wallets abstracted away for the default user (custody/UX model TBD when this phase is actually scoped)
- Support for tokenized real-world assets alongside crypto-native assets
- Optional "show me what's happening on-chain" mode for users who want the underlying mechanics — the same progressive-disclosure principle from Phase 1, now applied to real infrastructure

**Out of scope (until explicitly scoped later):**
- Anything specific to custody model, regulatory approach, or supported jurisdictions — these are significant decisions to be made deliberately when this phase is approached, not assumed now.

**Exit criteria:**
- N/A at this stage — Phase 3 scope, sequencing, and exit criteria should be defined for real once Phase 2 is complete and informs what's realistic.
