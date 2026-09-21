# ROADMAP.md

This document sequences delivery — what gets built, in what order, and what's in or out of scope at each stage. For the product vision itself — the seven-area IA (Home/Pay/Save/Invest/Swap/Borrow/Explore), Practice vs. Real mode, and what the product abstracts — see [PRODUCT.md](PRODUCT.md). Phases here describe how we get there, not what the product ultimately is.

Three phases, increasing in realism and risk. We do not move to the next phase until the current phase's exit criteria are genuinely met — realism should never outpace trust and understanding.

## Phase 1 — Practice Mode: The Complete Product

**Status: Complete.** All seven areas — Home, Pay, Save, Invest, Swap, Borrow, and Explore — are built and functional in Practice Mode, and the exit criteria below are met. Practice Mode remains permanently available and unchanged as Phase 2 proceeds.

Two rounds of post-completion product-quality polish followed: Batch A (Home recent payments, clearer ETH market-vs-Swap-rate explanation, Borrow interest disclosure, Explore sandbox clarity) and Batch B (consistent consumer vocabulary — Cash instead of USDC, Buy/Sell in Invest, "Move to savings"/"Move to Cash" in Save, contact-specific Pay request wording, "Try it in X" in Explore, friendlier Swap errors).

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

**Status: Active.** Batch 1 (the Practice/Real boundary) and the real account foundation (Batch 2) are built and live-verified on Base Sepolia + a real Neon database — registration, Turnkey provisioning, and fresh-browser restore. Real Pay submission is the next batch; see ARCHITECTURE.md's "Phase 2 Batch 2b Decisions" for what's built and what's deferred to it.

**Goal:** Introduce Real Mode, backed by real (testnet) infrastructure, one area at a time, while Practice Mode remains fully available for everything — including areas Real Mode doesn't support yet. Prove one real end-to-end path before broadening.

### Sequencing decision (September 2026)

This phase was originally planned to start with Real Mode for Swap, Save, and Borrow, with Pay staying Practice-only until Phase 3. That ordering has been deliberately reversed: **Pay comes first.** Sending a stablecoin to another account is the simplest real financial action there is — one account, one balance, one transfer, one transaction to watch — so it is the cheapest way to prove the whole Real Mode foundation (account, balance, transaction lifecycle, history) before any protocol integration adds its own complexity. Swap, Save, and Borrow in Real Mode remain Phase 2 goals; they follow once that foundation exists.

The new order:

1. **Practice/Real boundary** — the mode switch, the per-page boundary, honest "Practice-only for now" states, and a lint-enforced separation between the Practice engine and the future Real layer. *Done.*
2. **Real account foundation** — a real, blockchain-backed account the user sets up without seed phrases or browser extensions; the app never holds key material. *Done — registration, durable Neon persistence, and fresh-browser restore are live-verified. Fresh per-payment Turnkey authorization is proven in principle (Batch 2a) but its end-to-end acceptance check waits for real payment submission below.*
3. **Real testnet Cash balance** — reading a real testnet stablecoin balance and presenting it as Cash.
4. **Real Pay** — sending Cash to another address, with explicit preparing / awaiting approval / submitted / pending / confirmed / failed states.
5. **Transaction lifecycle and history** — persisted, recoverable across reload, with the real transaction hash and status one tap away.
6. Real Mode for Swap, Save, and Borrow against public testnet protocols — off-the-shelf or well-audited testnet deployments where possible, not novel contracts.

**In scope:**
- Real account/wallet on a public testnet, with a consumer-grade setup (no seed phrases or extensions in the default path)
- Real Mode for Pay first (balance, send, transaction status/history), then Swap, Save, and Borrow
- The Practice ⇄ Real mode switch, shared across the app, with a build-time feature flag that is authoritative over any remembered choice
- Practice and Real as parallel state paths: the Practice simulation engine is not extended, wrapped, or made asynchronous for Real Mode
- Introducing real-world friction points transparently but gently: confirmation times, transaction failures, and (where not abstracted) gas — explained contextually, same as any other concept

**Out of scope:**
- Real/mainnet funds or anything of real value — testnet only, for the whole phase
- Real Mode for Invest — still Practice-only
- Bank/payment rails, usernames/handles, requests, or contacts in Real Mode
- Full asset/protocol breadth — still a curated, teaching-oriented set
- Recovery, spending limits, session permissions, transaction simulation, fraud/scam screening
- Any cross-chain abstraction or bridging

**Exit criteria:**
- A user can set up a real account, hold a real testnet Cash balance, send Cash to another account, and see the payment move through its states to confirmed — without needing to understand wallets, gas, or hashes beyond what's explained in context.
- Users can complete the Swap/Save/Borrow loop from Phase 1 in Real Mode against testnet protocols.
- Switching between Practice and Real mode feels like the same product, and Practice Mode is provably unchanged by anything Real Mode does.

## Phase 3 — Consumer Product: Full Vision, Real Mode

**Goal:** Deliver the full seven-area product in Real Mode, with blockchain complexity invisible by default, per [PRODUCT.md](PRODUCT.md).

**In scope:**
- Real funds, real value, production-grade infrastructure and security
- Real Mode for Pay beyond stablecoin transfers (bank/payment rails, real transfers between named users) and for Invest (real/tokenized assets — RWAs, Treasuries, funds — alongside crypto), building on the simulated experiences already delivered in Phase 1 and the testnet Pay foundation from Phase 2
- Wallets abstracted away for the default user (custody/UX model TBD when this phase is actually scoped)
- Practice Mode remains permanently available across all seven areas
- Optional "show me what's happening on-chain" progressive disclosure for users who want the underlying mechanics, per PRODUCT.md's Abstracting Complexity section

**Out of scope (until explicitly scoped later):**
- Anything specific to custody model, regulatory approach, or supported jurisdictions — these are significant decisions to be made deliberately when this phase is approached, not assumed now.

**Exit criteria:**
- N/A at this stage — Phase 3 scope, sequencing, and exit criteria should be defined for real once Phase 2 is complete and informs what's realistic.
