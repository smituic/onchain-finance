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

**Status: Complete.** Batch 1 (the Practice/Real boundary), the signing/Safe foundation (Batch 2a), the real account foundation (Batch 2b), the real Cash balance read (Batch 2c), Real Pay (Batch 2d), a bounded Real Pay transaction history read (Batch 2e), and the final repo-wide audit, docs, PR, and merge (Batch 2f) are all built, live-verified on Base Sepolia + a real Neon database, and merged into `main` — registration, Turnkey provisioning, fresh-browser restore, an authenticated balance read, one real sponsored Cash payment ($0.01, confirmed on-chain with a fresh Turnkey/WebAuthn signature per payment), a real-Neon-verified, live-browser-verified read-only history view over those same payment rows, and security hardening closed from two independent audits. See ARCHITECTURE.md's "Phase 2 Batch 2d Decisions", "Phase 2 Batch 2e Decisions", and "Phase 2 Pre-2f Hardening Decisions" for what's built. This completes Phase 2's real-account foundation, proved via Pay; broader Real Mode expansion (Swap, Save, Borrow, Invest) is future work — see "Future: broader Real Mode expansion" below.

**Post-2f security slice (Batch 2g), in progress after Phase 2 closed:** an account may enroll, verify, and remove a second (backup) WebAuthn passkey against the same Turnkey user/Safe — availability, not disaster recovery. Losing every passkey is still unrecoverable; no email/SMS/OTP/guardian recovery exists. Turnkey mutations are authorized only by a fresh child-passkey stamp and raw-forwarded by the server after being durably recorded; an app session alone can't disable a passkey; removal is shown as confirmed only after a completed delete activity AND confirmed absence. Live-verified on Base Sepolia with a real Turnkey child org and Neon (see ARCHITECTURE.md's "Phase 2 Batch 2g Decisions" for exactly what was and wasn't). A follow-up hardening slice, 2g-H (a fresh passkey step-up before any backup registration; removal — and user-authorized retry — of a backup that is live at Turnkey but never finished setup; and never freeing the backup slot while wallet authority is unresolved), is built and tested offline, pending live verification. Does not change Phase 2's completion status or its testnet-only, no-mainnet scope.

**Security closeout slice S1 — Real Pay credential attribution:** every payment is bound at prepare to the session's passkey, its passkey prompt is pinned to that credential, and the server proves from Turnkey's own activity record that exactly that passkey approved exactly that payment's digest before anything is sent. Built and tested offline; pending live verification (see ARCHITECTURE.md's "Slice S1").

**Security closeout slice S3 — blocked passkey-removal operator recovery:** an operator-only, dry-run-by-default admin runner that can move a stuck `blocked` removal to Removed only when Turnkey's read-only ledger proves the deletion against a DELETE this app itself stored (never a dashboard delete, never absence alone), with nothing re-adding that authority since and the target absent in two full reads. It sends nothing to Turnkey and adds no user-facing surface. Blocked setup (CREATE) recovery stays out. Built, tested offline, and live-verified on a genuine blocked removal (see ARCHITECTURE.md's "Slice S3").

**Security closeout slice S4 — session / account security hygiene:** an account-wide "Sign out everywhere" backed by a server-side session epoch (no session table or denylist). The session token moves to v2, so existing sessions sign in again once. One origin/content-type gate covers every `/api/real/**` mutation, opportunistic expired-challenge cleanup, a minimum-strength session secret, anti-framing/nosniff headers, and client state that can't leak across accounts or claim a failed sign-out succeeded. Built, tested offline, and live-verified against real Neon with two real browser sessions: the migration was applied, a pre-S4 session was refused, one sign-out ended both browsers' sessions, a failed sign-out stayed honestly signed in, and the origin gate, headers, and challenge purge all behaved as designed. There was no Turnkey or chain change. Platform rate limiting, security-event logging, full CSP, and the HSTS/`__Host-` decision remain future work (see ARCHITECTURE.md's "Slice S4").

**Goal:** Introduce Real Mode, backed by real (testnet) infrastructure, one area at a time, while Practice Mode remains fully available for everything — including areas Real Mode doesn't support yet. Prove one real end-to-end path before broadening.

### Sequencing decision (September 2026)

This phase was originally planned to start with Real Mode for Swap, Save, and Borrow, with Pay staying Practice-only until Phase 3. That ordering has been deliberately reversed: **Pay comes first.** Sending a stablecoin to another account is the simplest real financial action there is — one account, one balance, one transfer, one transaction to watch — so it is the cheapest way to prove the whole Real Mode foundation (account, balance, transaction lifecycle, history) before any protocol integration adds its own complexity. Swap, Save, and Borrow in Real Mode were originally scoped to follow within Phase 2 once that foundation existed; now that the foundation is built, live-verified, and merged, they've moved out of Phase 2 and into future work — see "Future: broader Real Mode expansion" below.

The new order:

1. **Practice/Real boundary** — the mode switch, the per-page boundary, honest "Practice-only for now" states, and a lint-enforced separation between the Practice engine and the future Real layer. *Done.*
2. **Real account foundation** — a real, blockchain-backed account the user sets up without seed phrases or browser extensions; the app never holds key material. *Done — registration, durable Neon persistence, and fresh-browser restore are live-verified. Fresh per-payment Turnkey authorization (Batch 2a) is proven end to end by Real Pay below — a real sponsored Cash transfer with a fresh Turnkey/WebAuthn signature confirmed on-chain.*
3. **Real testnet Cash balance** — reading a real testnet stablecoin balance and presenting it as Cash. *Done — a read-only, session-authenticated USDC `balanceOf` read for the durable Safe address, live-verified against the real (unfunded, $0.00) account from Batch 2b. No signing, no Turnkey/Pimlico involvement.*
4. **Real Pay** — sending Cash to another address, with explicit preparing / awaiting approval / submitted / confirmed / failed / unknown states. *Done — a real sponsored Cash transfer ($0.01) confirmed on Base Sepolia, with a fresh Turnkey/WebAuthn signature required per payment, a server-bound payment intent (no arbitrary calldata/target), a durable Neon state machine with atomic reservation, and reconcile-never-resend recovery. See ARCHITECTURE.md's "Phase 2 Batch 2d Decisions".*
5. **Transaction lifecycle and history** — persisted, recoverable across reload, with the real transaction hash and status one tap away. *Done — a bounded, read-only view (default 10 rows, hard max 25) over Batch 2d's `payment_attempts` rows, authenticated/account-scoped the same way the balance/latest reads already are, in consumer status language, with no reconciliation or mutation from the history UI itself. Live-verified: a real-Neon smoke suite (newest-first, limit-honoring, account-scoped) and a live browser check against Base Sepolia + the real database, confirming the existing confirmed/cancelled rows render truthfully and Refresh calls only the history endpoint. See ARCHITECTURE.md's "Phase 2 Batch 2e Decisions".*
6. Real Mode for Swap, Save, and Borrow against public testnet protocols — off-the-shelf or well-audited testnet deployments where possible, not novel contracts. *Deferred: moved out of Phase 2's completed foundation scope; now future work — see "Future: broader Real Mode expansion" below.*

**In scope:**
- Real account/wallet on a public testnet, with a consumer-grade setup (no seed phrases or extensions in the default path)
- Real Mode for Pay (balance, send, transaction status/history) — the foundation Phase 2 set out to prove. (Swap, Save, and Borrow were originally sequenced to follow within Phase 2; they're now future work — see below.)
- The Practice ⇄ Real mode switch, shared across the app, with a build-time feature flag that is authoritative over any remembered choice
- Practice and Real as parallel state paths: the Practice simulation engine is not extended, wrapped, or made asynchronous for Real Mode
- Introducing real-world friction points transparently but gently: confirmation times, transaction failures, and (where not abstracted) gas — explained contextually, same as any other concept

**Out of scope:**
- Real/mainnet funds or anything of real value — testnet only, for the whole phase
- Real Mode for Invest, Swap, Save, and Borrow — future work beyond Phase 2's completed foundation (see below)
- Bank/payment rails, usernames/handles, requests, or contacts in Real Mode
- Full asset/protocol breadth — still a curated, teaching-oriented set
- Recovery, spending limits, session permissions, transaction simulation, fraud/scam screening
- Any cross-chain abstraction or bridging

**Exit criteria (met):**
- A user can set up a real account, hold a real testnet Cash balance, send Cash to another account, and see the payment move through its states to confirmed — without needing to understand wallets, gas, or hashes beyond what's explained in context.
- Switching between Practice and Real mode feels like the same product, and Practice Mode is provably unchanged by anything Real Mode does.

The Swap/Save/Borrow-in-Real-Mode criterion originally listed here reflected Phase 2's original full scope. Now that the account/balance/transaction-lifecycle foundation is proved end to end via Pay, that criterion has moved to "Future: broader Real Mode expansion" below rather than blocking Phase 2 from being considered done.

### Future: broader Real Mode expansion

Real Mode for Swap, Save, Borrow, and Invest — against public testnet protocols, off-the-shelf or well-audited testnet deployments where possible, not novel contracts — remains a real product goal, but is no longer part of Phase 2's exit criteria. It builds on the same foundation Phase 2 just proved (account, signing, balance, transaction lifecycle) and will get its own sequencing, batches, and exit criteria when it's actually taken up. This is testnet Real Mode broadening, distinct from and prior to Phase 3's production/mainnet scope below.

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
