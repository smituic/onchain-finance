# onchain-finance

**Make on-chain finance feel like normal money.**

onchain-finance is a consumer-friendly on-chain finance app, starting as a simulation using fake money and evolving toward testnet usage and, eventually, a real consumer product that abstracts away wallets, payments, swaps, lending, borrowing, investing, and tokenized real-world assets.

The MVP lets people *learn by doing*: manage a simulated portfolio, swap assets, earn simulated yield, borrow against collateral, and experience liquidation — all with fake money, with no real funds or production smart contracts involved.

## Project Status

**Phase 1 (Practice Mode) is complete.** All seven product areas are built and functional, entirely simulated with fake money:

- **Home** — a unified financial overview: cash, savings, investments, and crypto in one total balance
- **Pay** — send, receive, request, deposit, and withdraw simulated money
- **Save** — simulated savings yield, with a Practice time control to watch interest accrue
- **Invest** — a curated set of simulated investments, with market scenarios to move their prices
- **Swap** — AMM-based swaps between simulated assets, with real price impact on larger trades
- **Borrow** — collateralized borrowing against simulated ETH, including simulated liquidation
- **Explore** — isolated, interactive financial experiments (liquidity, liquidation, yield, risk, payments) that let a user cause a financial outcome themselves rather than read about it

Two rounds of post-completion product-quality cleanup are also done: Batch A (Home recent payments, clearer Swap-rate explanation, Borrow interest disclosure, Explore sandbox clarity) and Batch B (consistent consumer vocabulary — Cash instead of USDC, Buy/Sell in Invest, clearer Save/Pay wording, friendlier Swap errors).

**Phase 2 (Real Mode on a testnet) is active**, starting with Pay — a deliberate change from the earlier plan, recorded in [ROADMAP.md](ROADMAP.md). So far:

- **Practice/Real boundary (done).** A Practice / Real switch in the header, a one-time introduction on first entry, and a per-page boundary that renders each area's Practice or Real presentation. Areas with no Real implementation yet (Save, Invest, Swap, Borrow) say so and offer "Try it in Practice". Explore stays the same isolated Practice sandbox in both modes.
- **Real account, Cash balance, Pay, and payment history (done).** A real, blockchain-backed account set up with a passkey (no seed phrases or browser extensions), a real testnet Cash (USDC) balance on Base Sepolia, sending Cash with explicit preparing/awaiting-approval/sent/failed states, and a bounded, read-only view of recent payments — all live-verified against a real Neon database and Base Sepolia. See [ARCHITECTURE.md](ARCHITECTURE.md)'s Phase 2 decisions for what's built, and `.env.example` for the environment variables a real setup needs. A final Phase 2 hardening/audit pass is in progress before Swap, Save, and Borrow get their own Real Mode implementations.

Real Mode is **testnet-only** for all of Phase 2 — no mainnet, no real-value funds. Practice Mode is untouched: the simulation engine and its persistence are unchanged, and tests assert Real Mode never mutates Practice state.

### Enabling Real Mode locally

Real Mode is behind a build-time flag and is off by default, so an unconfigured build is the Phase 1 Practice-only app. To see the switch:

```bash
# .env.local (git-ignored)
NEXT_PUBLIC_REAL_MODE_ENABLED=true
```

The flag is authoritative: a browser that remembers Real Mode from an earlier build falls back to Practice when a later build has the flag off.

## Development

```bash
pnpm install
pnpm dev          # http://localhost:3000
pnpm test         # Vitest (unit + React Testing Library)
pnpm lint
pnpm exec tsc --noEmit
pnpm build
```

## Documentation

- [PRODUCT.md](PRODUCT.md) — product vision, MVP scope, UX philosophy, long-term vision
- [DESIGN.md](DESIGN.md) — design philosophy and principles
- [ARCHITECTURE.md](ARCHITECTURE.md) — architectural principles and proposed boundaries
- [ROADMAP.md](ROADMAP.md) — phased plan (MVP → testnet → consumer product)
- [CLAUDE.md](CLAUDE.md) — persistent instructions for Claude Code sessions working in this repo

## Contributing

This is currently a solo project. There is no external contribution process yet.
