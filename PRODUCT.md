# PRODUCT.md

## Status

This document describes the product's long-term vision — what it is and why. It does not describe sequencing, current scope, or implementation status; see [ROADMAP.md](ROADMAP.md) for the phase-by-phase delivery plan.

## North Star

**Make on-chain finance feel like normal money.**

Everything in this product is judged against that sentence. If a feature makes a user feel like they need to understand blockchain to use their money, it's wrong. If it makes on-chain finance feel as ordinary as checking a banking app, it's right.

## The Problem

On-chain finance (DeFi) is powerful — programmable money, transparent markets, permissionless access — but it is inaccessible to normal people. The UX is built by and for people who already understand wallets, gas, slippage, and liquidation. Newcomers are asked to learn a vocabulary and a set of risks before they're allowed to participate at all. Courses and explainers teach concepts in the abstract, disconnected from the moment a user actually needs them.

This product's bet: people learn financial concepts best by doing them, in context, with nothing real at stake — and once they understand them, the underlying mechanics should be able to fade into the background permanently.

## The Product

The product is a single, unified consumer finance application. Users think in terms of everyday financial jobs — checking their balance, paying someone, saving, investing, swapping one asset for another, borrowing against what they own — not in terms of protocols, chains, wallets, RPCs, bridges, or DeFi primitives. Those are implementation details, not concepts a user should need to hold in their head to use their own money.

The product is organized around seven areas:

### Home
A single view of everything a user owns — cash, savings, investments, and crypto — combined into one total balance. No checking five apps to know your net worth.

### Pay
Sending, receiving, requesting, depositing, and withdrawing money. Starts with simulated and stablecoin-based transfers and grows to include real bank and payment rails, so paying a friend or a bill feels the same regardless of what's moving underneath.

### Save
A savings experience that feels like a high-yield savings account, backed underneath by lending protocols and/or tokenized yield products. Users watch a balance grow and understand where the yield comes from, without needing to pick a protocol or understand collateralization to get started.

### Invest
One portfolio for everything a user might hold — crypto, tokenized stocks and other real-world assets (RWAs), Treasuries, and funds — presented the way a normal investing app presents a portfolio, not as a list of tokens.

### Swap
Universal asset conversion. Users exchange one asset for another; the app handles routing, protocol selection, and execution, surfacing only what matters to the trade itself — rate, price impact, confirmation — unless the user asks for more.

### Borrow
Collateralized borrowing presented with understandable risk: what you're putting up, what you can borrow, and what happens if things move against you — including interactive scenarios that let a user explore that risk before (or instead of) experiencing it for real.

### Explore
A permanent space for interactive financial experiments — not lessons, courses, or quizzes — where a user manipulates a scenario directly and discovers a concept (price impact, liquidity, collateral, liquidation, stablecoins, market cap vs. liquidity) through the outcome.

## Two Modes: Practice and Real

The product always offers two modes of the same experience:

- **Practice Mode** uses simulated money. It is not a temporary onboarding phase the product graduates out of — it's a permanent way to use the app. A user can pick up any feature, at any experience level, and try it with fake money and no consequence.
- **Real Mode** presents the identical product — same screens, same flows, same language — but execution is delegated to real infrastructure underneath: wallets, smart accounts, DeFi/lending protocols, routing infrastructure, and eventually traditional payment rails. Moving from Practice to Real should feel like flipping a switch, not learning a new app.

## Abstracting Complexity

By default, the product hides the machinery of on-chain finance: which chain a transaction happens on, gas fees, bridging between chains, wallet addresses, which protocol was selected to execute a given action, and approval transactions. A user should be able to save, invest, swap, and borrow without ever being asked to make a decision about any of these.

None of this is hidden permanently. A user who wants to see what's happening underneath — which protocol, which chain, current LTV, liquidation threshold, exact execution details — can always find it, one tap away. This follows the product's core rule: **hide jargon, not concepts.** The goal is for a curious user to eventually understand these ideas by name, not to keep them in the dark forever.

## UX Philosophy

- **Learn by doing.** Every concept is introduced through an action the user takes, not a lesson they read first.
- **Progressive disclosure.** Simple by default; complexity is available a tap away for users who want it, never forced on users who don't.
- **Hide jargon, not concepts.** Users should always see plain-language explanations and consequences first — what happened and what it means for their money. Terms like "gas," "slippage," "liquidity," "LTV," or "liquidation threshold" are introduced contextually, once they help the user understand what just happened, rather than hidden permanently. The goal is for users to eventually understand these concepts by name, not to shield them from the vocabulary forever.
- **Feels like normal money.** Balances, transactions, and confirmations should look and feel like a modern banking or investing app, in both Practice and Real mode. The user should never feel like they've opened a developer tool.
- **Mistakes are safe and instructive.** Practice Mode lets users make real mistakes (get liquidated, mistime a swap) and turn the consequence into understanding rather than punishment, permanently — not just while they're new.

## What This Product Deliberately Is Not

- Not a block explorer or protocol dashboard — balances and activity are presented like a normal consumer finance app.
- Not a course, curriculum, or quiz platform — education happens through actions and experiments (Explore), not lessons.
- Never requires a user to understand which chain, wallet, or protocol is doing the work in order to participate — that information is opt-in, not required.
- Never asks a user to make a decision about gas, bridging, or protocol selection unless they've deliberately chosen to look under the hood.

## Target User

Someone curious about crypto/DeFi but intimidated or burned by its current UX — they may have some cash-app or investing-app fluency, but little to no blockchain fluency. They want to understand what "earning yield" or "getting liquidated" actually means, without risking money or reading a whitepaper to find out. Over time, the target user broadens to anyone who wants their entire financial life — spending, saving, investing, borrowing — in one place, whether or not they ever think about what's underneath.

## Success Criteria (Qualitative)

- A user can manage everyday spending, saving, investing, and borrowing in one app, and can explain in their own words what happened at each step.
- A user who experiences a liquidation — in Practice or Real mode — understands why it happened and feels informed, not punished.
- At every layer of the product, a user who doesn't care about blockchain mechanics never has to see them; a user who does can always find them.
- Moving between Practice Mode and Real Mode feels like using the same product, not switching apps.
