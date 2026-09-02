# CLAUDE.md

Persistent instructions for Claude Code sessions working in this repository.

## Read First

Before doing substantive work, be aware of these documents and treat them as source of truth:

- [PRODUCT.md](PRODUCT.md) — product vision, MVP scope, UX philosophy, long-term vision
- [DESIGN.md](DESIGN.md) — design philosophy and principles
- [ARCHITECTURE.md](ARCHITECTURE.md) — architectural principles and proposed boundaries
- [ROADMAP.md](ROADMAP.md) — phased plan (MVP → testnet → consumer product)

## North Star

**Make on-chain finance feel like normal money.** Weigh every suggestion or implementation choice against this.

## Hard Constraints

- **The MVP uses fake money only.** No real funds, no real wallets, no production smart contracts, no real chain interaction of any kind, unless the user has explicitly moved the project into a later phase (see ROADMAP.md) and asked for it.
- **Hide jargon, not concepts.** Plain-language explanations and consequences come first; terms like gas, slippage, liquidity, LTV, or liquidation threshold are introduced contextually once they help the user understand what just happened, not permanently hidden. The goal is for users to eventually understand these concepts by name — don't add developer/protocol-facing language to consumer-facing surfaces "for accuracy," but don't scrub the vocabulary out of the product either.
- **This is a single-developer project.** Do not introduce abstractions, frameworks, services, or dependencies to solve problems that don't exist yet. Prefer the smallest, most boring solution that works. See ARCHITECTURE.md's principles before adding structure.
- **Design decisions are intentionally deferred.** Do not invent or lock in a color palette, typeface, or component library on your own initiative. If DESIGN.md still lists something as "deliberately undecided," ask before treating it as decided, or propose an option explicitly rather than silently picking one.
- **Don't jump phases.** Don't add testnet/wallet/chain code while the project is still in the Phase 1 (simulation) stage of ROADMAP.md, even if it seems like reasonable groundwork — confirm with the user first.

## Working Style

- Keep documentation and code concise but substantive — avoid filler.
- When a task implies a decision that one of the docs above marks as open or undecided, surface that instead of quietly deciding it yourself.
- As real architectural or design decisions get made, update ARCHITECTURE.md / DESIGN.md to reflect reality rather than leaving them purely aspirational.
- No app has been scaffolded yet as of the creation of this file — do not assume a framework, folder structure, or dependency exists until it's actually been set up in this repo.
