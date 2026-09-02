# DESIGN.md

## Purpose

This document establishes the design *philosophy* for onchain-finance — the qualities every screen should have — without prematurely locking in exact colors, fonts, or component libraries. Those decisions should be made deliberately, once, when we're ready to commit to a visual system, not implied piecemeal through early implementation choices.

## Inspiration and Why

- **Aave, Uniswap** — trust and clarity in financial data. Numbers are legible and hierarchical, risk is communicated plainly, and the interface never feels like it's hiding something. We want that same trustworthiness, minus the protocol jargon.
- **Cash App** — warmth, personality, and simplicity applied to money. Money feels friendly, not clinical.
- **Robinhood** — calm, confident presentation of financial complexity (positions, performance, risk) at a consumer level, with strong use of motion and typography to make numbers feel alive without feeling gimmicky.

The synthesis we're after: **the trust and precision of a DeFi protocol UI, with the warmth and simplicity of a consumer finance app.**

## Core Design Principles

- **Minimal.** Every screen shows only what the user needs for the decision in front of them. If it's not needed for that decision, it's a tap away, not on screen.
- **Premium.** Generous spacing, considered type, subtle motion. Nothing should feel like a template or a dashboard thrown together from a component kit.
- **Calm.** Financial apps are stressful by default. Color, motion, and copy should lower the emotional temperature — even bad news (a liquidation, a loss) should be delivered clearly and calmly, not alarmingly.
- **Modern and mobile-first.** Design for a phone screen first; larger surfaces are an expansion, not the primary canvas.
- **Breathing room over density.** Prefer fewer things, said more clearly, over dense information-rich layouts. Resist the instinct to show "everything a power user might want" on one screen.
- **Progressive disclosure.** Default views are simple. Detail, technical terms, and protocol-level information exist one layer down, always reachable, never forced.
- **Typography does the heavy lifting.** With a restrained color palette and minimal chrome, hierarchy and personality come primarily from type — size, weight, and spacing — not from decoration.

## Deliberately Undecided (For Now)

To avoid locking in a visual identity before the product is proven, the following are **not yet decided** and should not be treated as settled by any early implementation:

- Exact color palette (hex values, theming system)
- Typeface(s)
- Iconography style
- Dark mode vs. light mode as default

Until these are decided intentionally (and this document updated), early UI work should describe these in terms of *qualities*, e.g.:

- "A restrained, mostly neutral palette with a single confident accent color used sparingly for calls to action and positive/negative financial signals."
- "One expressive, highly legible typeface pairing — a distinctive display face for numbers/headlines, a clean workhorse face for body text."
- "Icons that feel custom and quiet, not a generic default icon set."

When we do lock these in, this document should be updated with the actual decisions and rationale, and this section removed.

**Component foundation, for clarity:** shadcn/ui has been chosen (see [ARCHITECTURE.md](ARCHITECTURE.md)) as a source of accessible, unstyled primitives — dialogs, tooltips, popovers, and the like. This is an implementation detail, not a visual identity: components are copied into the codebase and restyled to match whatever this document eventually specifies, rather than kept in shadcn's default look. Choosing it does not decide any of the undecided items above.

## Education & Contextual Moments

Contextual teaching moments (tooltips, inline explainers, first-time callouts) are a core part of the product, not an afterthought — they should get the same design care as any other UI element:

- Non-intrusive: they appear near the relevant number or action, not as modals that block the task.
- Dismissible: a user who already understands a concept can dismiss it permanently without friction.
- Plain language first: the explanation leads with what it means for the user's money; technical terminology is secondary and optional.
- Visually distinct but not alarming: a teaching moment should look different from a warning or an error.

## Motion

Motion is used for feedback and continuity (confirming a swap happened, showing a balance change, transitioning between related screens) — never purely for decoration. If a transition doesn't help the user understand what just happened or where they are, cut it.
