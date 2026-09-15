# ROADMAP.md

This document sequences delivery — what gets built, in what order, and what's in or out of scope at each stage. For the product vision itself — the seven-area IA (Home/Pay/Save/Invest/Swap/Borrow/Explore), Practice vs. Real mode, and what the product abstracts — see [PRODUCT.md](PRODUCT.md). Phases here describe how we get there, not what the product ultimately is.

Three phases, increasing in realism and risk. We do not move to the next phase until the current phase's exit criteria are genuinely met — realism should never outpace trust and understanding.

## Phase 1 — Practice Mode: The Complete Product

**Status: Complete.** All seven areas — Home, Pay, Save, Invest, Swap, Borrow, and Explore — are built and functional in Practice Mode, and the exit criteria below are met. Phase 2 is next.

**Goal:** Deliver the complete consumer product — all seven areas — in Practice Mode. Prove that people can learn on-chain finance concepts by doing them, entirely simulated, with no real funds, wallets, or chain interaction yet.

**In scope:**
- Home — a single aggregate view of simulated balances across all areas (the existing portfolio view)
- Pay — a meaningful simulated experience: sending, receiving, requesting, depositing, and withdrawing between simulated accounts
- Save — simulated yield-earning positions
- Invest — a curated simulated investing experience across a small set of simulated assets; the investing experience exists now, real/tokenized assets come later
- Swap between simulated assets, with simulated liquidity and price impact
- Borrow against simulated collateral, including simulated liquidation presented as a teaching moment
- Contextual, in-the-moment education (no separate course/curriculum UI)
- Explore: interactive, learn-by-doing scenarios covering concepts like market cap vs. liquidity, price impact, stablecoins, lending yield, collateral, and liquidation — including the canonical market-cap-vs-liquidity experiment where a large sale against shallow liquidity yields far less than market cap would suggest
- A design system expressive enough to feel premium, without being locked into final visual decisions (see [DESIGN.md](DESIGN.md))

**Out of scope:**
- Any real funds, wallets, or chain interaction — Real Mode does not exist yet
- Real bank/payment rails or transfers to other real users in Pay — the Pay experience is fully simulated
- Real or tokenized assets, brokerage integration, or RWA infrastructure in Invest — the investing experience is fully simulated
- Production smart contracts
- Broad asset coverage — a small, well-chosen set of simulated assets is enough
- Accounts/auth beyond whatever is minimally needed to persist a user's simulated state

**Exit criteria:**
- A new user can, unassisted, use Home, Pay, Save, Invest, Swap, Borrow, and Explore in Practice Mode, and can explain in their own words what happened at each step, including a swap's price impact and a liquidation.
- The core loop feels good enough that testing it with real people doesn't require caveats about unfinished UX.

## Phase 2 — Testnet: Introducing Real Mode

**Goal:** Introduce Real Mode for a curated subset of features, backed by real (testnet) infrastructure, while Practice Mode remains fully available for everything — including features Real Mode doesn't support yet. This is also where the Practice ⇄ Real switch itself gets built.

**In scope:**
- Real wallet connection (testnet)
- Real Mode for Swap, Save, and Borrow, executing against public testnet contracts — off-the-shelf or well-audited testnet protocols where possible, not novel contracts built from scratch
- The Practice ⇄ Real mode switch, shared across the app
- Reconciling the "chain adapter" seam anticipated in [ARCHITECTURE.md](ARCHITECTURE.md): the same actions from Phase 1 now resolve to real (testnet) transactions
- Introducing real-world friction points transparently but gently: gas, confirmation times, transaction failures — explained contextually, same as any other concept

**Out of scope:**
- Real/mainnet funds
- Real Mode for Pay or Invest — still Practice-only
- Full asset/protocol breadth — still a curated, teaching-oriented set
- Abstracting away wallets entirely (that's Phase 3)

**Exit criteria:**
- Users can complete the same Swap/Save/Borrow loop as Phase 1, now backed by real testnet transactions in Real Mode, without needing to understand wallets or gas beyond what's explained in context.
- Switching between Practice and Real mode feels like the same product — validating that the seam described in PRODUCT.md holds up in practice.

## Phase 3 — Consumer Product: Full Vision, Real Mode

**Goal:** Deliver the full seven-area product in Real Mode, with blockchain complexity invisible by default, per [PRODUCT.md](PRODUCT.md).

**In scope:**
- Real funds, real value, production-grade infrastructure and security
- Real Mode for Pay (bank/payment rails, real transfers between users) and Invest (real/tokenized assets — RWAs, Treasuries, funds — alongside crypto), building on the simulated experiences already delivered in Phase 1
- Wallets abstracted away for the default user (custody/UX model TBD when this phase is actually scoped)
- Practice Mode remains permanently available across all seven areas
- Optional "show me what's happening on-chain" progressive disclosure for users who want the underlying mechanics, per PRODUCT.md's Abstracting Complexity section

**Out of scope (until explicitly scoped later):**
- Anything specific to custody model, regulatory approach, or supported jurisdictions — these are significant decisions to be made deliberately when this phase is approached, not assumed now.

**Exit criteria:**
- N/A at this stage — Phase 3 scope, sequencing, and exit criteria should be defined for real once Phase 2 is complete and informs what's realistic.
