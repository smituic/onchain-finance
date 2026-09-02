# PRODUCT.md

## North Star

**Make on-chain finance feel like normal money.**

Everything in this product is judged against that sentence. If a feature makes a user feel like they need to understand blockchain to use their money, it's wrong. If it makes on-chain finance feel as ordinary as checking a banking app, it's right.

## The Problem

On-chain finance (DeFi) is powerful — programmable money, transparent markets, permissionless access — but it is inaccessible to normal people. The UX is built by and for people who already understand wallets, gas, slippage, and liquidation. Newcomers are asked to learn a vocabulary and a set of risks before they're allowed to participate at all. Courses and explainers teach concepts in the abstract, disconnected from the moment a user actually needs them.

This product's bet: people learn financial concepts best by doing them, in context, with nothing real at stake — and once they understand them, the underlying mechanics should be able to fade into the background permanently.

## MVP

The MVP is a **simulated on-chain finance app using fake money**. No real funds, no production smart contracts, no real chain interaction. It is a safe, sleek sandbox that behaves like a real on-chain finance app.

A new user begins with approximately **$10,000 in simulated funds** and is explicitly encouraged to experiment freely — the money is fake precisely so that curiosity and mistakes are free of real consequence.

### Core MVP Features

- **Simulated portfolio** — users hold a starting balance of fake assets and can see their portfolio value, composition, and performance over time, presented like a normal consumer finance app (not a block explorer).
- **Swap** — users exchange one simulated asset for another, experiencing price impact, rates, and confirmation flows the way they would on a real DEX, without real value moving.
- **Simulated yield** — users can deposit assets into a simulated yield-generating position and watch balances grow, learning what "earning yield" means and where it comes from.
- **Borrow against collateral** — users can lock a simulated asset as collateral and borrow another against it, learning the relationship between collateral value, borrow capacity, and risk.
- **Liquidation** — if a user's collateral value falls too far relative to their borrowed amount, they experience a simulated liquidation. This is a deliberate teaching moment, not just a penalty — the product should help the user understand *why* it happened.
- **Contextual education** — concepts (collateralization ratio, slippage, liquidity, liquidation threshold, APY vs APR, etc.) are explained at the moment they become relevant to a user's action, via short, dismissible, in-context copy — never as a separate course, quiz, or wall of text.
- **Explore/Experiments** — a set of interactive scenarios where users manipulate a financial situation directly and discover a concept through the outcome, rather than being told about it. Like the rest of the product, these are learn-by-doing simulations, not lessons, quizzes, or courses. Candidate concepts include market cap vs. liquidity, price impact, stablecoins, lending yield, collateral, and liquidation. The canonical example: a simulated asset has a large market cap but shallow liquidity; when the user attempts to sell a large position, the simulator shows their actual proceeds falling dramatically short of what market-cap intuition would suggest, and explains why.

### Explicit Non-Goals for MVP

- No real funds, real wallets, or real chain interaction of any kind.
- No production smart contracts.
- No KYC, custody, or regulatory-surface features.
- No breadth for its own sake — the MVP should cover a small number of assets and mechanics, chosen for how well they teach the core concepts, not for market completeness.
- No traditional "learn" section, course, or curriculum. Education is contextual only.

## UX Philosophy

- **Learn by doing.** Every concept is introduced through an action the user takes, not a lesson they read first.
- **Progressive disclosure.** Simple by default; complexity is available a tap away for users who want it, never forced on users who don't.
- **Hide jargon, not concepts.** Users should always see plain-language explanations and consequences first — what happened and what it means for their money. Terms like "gas," "slippage," "liquidity," "LTV," or "liquidation threshold" are introduced contextually, once they help the user understand what just happened, rather than hidden permanently. The goal is for users to eventually understand these concepts by name, not to shield them from the vocabulary forever.
- **Feels like normal money.** Balances, transactions, and confirmations should look and feel like a modern banking or investing app. The user should never feel like they've opened a developer tool.
- **Mistakes are safe and instructive.** Because the money is fake, the product can let users make real mistakes (get liquidated, mistime a swap) and turn the consequence into understanding rather than punishment.

## Long-Term Vision

The product evolves in stages, expanding realism only as fast as trust and understanding are established:

1. **Simulation (MVP)** — fake money, simulated everything, purely a learning sandbox.
2. **Testnet** — real blockchain interaction (wallets, transactions, contracts) on a public testnet, still with no real value at stake. Users start experiencing the actual mechanics underneath the simulation they already understand.
3. **Consumer product** — a simple, unified interface over real wallets, payments, swaps, lending, borrowing, investing, and tokenized real-world assets (RWAs). At this stage, most users should never need to know which chain, protocol, or contract is doing the work — that complexity stays permanently hidden unless a user deliberately chooses to look under the hood.

Across all stages, the product should feel like one continuous app to the user — the simulation, testnet, and consumer versions are steps in maturity, not separate products.

## Target User

Someone curious about crypto/DeFi but intimidated or burned by its current UX — they may have some cash-app or investing-app fluency, but little to no blockchain fluency. They want to understand what "earning yield" or "getting liquidated" actually means, without risking money or reading a whitepaper to find out.

## Success Criteria (Qualitative)

- A first-time user can complete a swap, open a yield position, borrow against collateral, and understand what happened at each step — without leaving the app or consulting outside material.
- A user who gets liquidated in the simulation understands why, and feels informed rather than punished.
- At every stage, a user who doesn't care about blockchain mechanics never has to see them; a user who does can find them.
