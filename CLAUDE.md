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

## Current Phase

**Phase 2 (testnet Real Mode) is active** — see ROADMAP.md for the batch order, which deliberately starts with Pay. Batch 1 (the Practice/Real boundary) and Batches 2a–2e (the signing/account foundation, account provisioning and restoration, Cash balance, Real Pay, and Real Pay history) are built and live-verified. A final Phase 2 hardening pass (prompted by independent security audits) is in progress; Batch 2f (the final repo-wide audit, docs, PR, and merge) is next and begins only when the user authorizes it.

## Hard Constraints

- **Practice Mode uses fake money only and stays unchanged.** Do not modify `simulation/**`, `lib/stores/simulation-store.ts`, Practice financial semantics, or the Practice persistence version for Real Mode work. Practice and Real are parallel paths (see ARCHITECTURE.md); real financial state never goes through the simulation engine.
- **Real Mode is testnet-only.** No mainnet, no real-value funds, no production custody, for the whole of Phase 2. Nothing in the app may hold private keys or seed phrases, and nothing may store them in Zustand or browser persistence.
- **Blockchain SDKs live only in `lib/real/**`** (and secret-holding route handlers under `app/api/real/**`). Components, pages, and stores use `lib/real`'s interface. ESLint enforces this; don't work around it.
- **The Real Mode feature flag (`NEXT_PUBLIC_REAL_MODE_ENABLED`) is authoritative** and is enforced in one place, `lib/stores/mode-store.ts`. Don't add per-page or per-component flag checks.
- **External facts about SDKs, networks, and services are candidates until verified.** ARCHITECTURE.md marks them as such; don't document or code them as settled without checking current sources first.
- **Hide jargon, not concepts.** Plain-language explanations and consequences come first; terms like gas, slippage, liquidity, LTV, or liquidation threshold are introduced contextually once they help the user understand what just happened, not permanently hidden. The goal is for users to eventually understand these concepts by name — don't add developer/protocol-facing language to consumer-facing surfaces "for accuracy," but don't scrub the vocabulary out of the product either.
- **This is a single-developer project.** Do not introduce abstractions, frameworks, services, or dependencies to solve problems that don't exist yet. Prefer the smallest, most boring solution that works. See ARCHITECTURE.md's principles before adding structure.
- **Design decisions are intentionally deferred.** Do not invent or lock in a color palette, typeface, or component library on your own initiative. If DESIGN.md still lists something as "deliberately undecided," ask before treating it as decided, or propose an option explicitly rather than silently picking one.
- **Don't jump batches.** Build only the ROADMAP.md batch the user has authorized — no wallet, RPC, contract, or transaction code as "groundwork" for a later batch, even if it seems reasonable. Confirm with the user first.

## Working Style

- Keep documentation and code concise but substantive — avoid filler.
- When a task implies a decision that one of the docs above marks as open or undecided, surface that instead of quietly deciding it yourself.
- As real architectural or design decisions get made, update ARCHITECTURE.md / DESIGN.md to reflect reality rather than leaving them purely aspirational.
- The app is a Next.js (App Router) project — see ARCHITECTURE.md for the stack and the folder-level boundaries (`simulation/`, `lib/real/`, `lib/stores/`, `components/`). Don't assume a dependency exists until it's in `package.json`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
