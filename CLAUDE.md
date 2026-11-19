# CLAUDE.md

Persistent instructions for Claude Code sessions working in this repository.

## Read First

Before doing substantive work, be aware of these documents and treat them as source of truth:

- [PRODUCT.md](PRODUCT.md) — product vision, MVP scope, UX philosophy, long-term vision
- [DESIGN.md](DESIGN.md) — design philosophy and principles
- [ARCHITECTURE.md](ARCHITECTURE.md) — architectural principles and proposed boundaries
- [ROADMAP.md](ROADMAP.md) — phased plan (MVP → testnet → consumer product)

**Mandatory topic index.** Slice-by-slice status, audit findings, frozen file hashes and per-slice rules live in `docs/status/` (moved verbatim out of this file to keep it short). Read the matching file(s) **before planning, architecture or design work, scope decisions, security audits, implementation, and documentation/status changes** — not only before modifying code. **If a task spans several topics, read ALL applicable archives; the topics overlap.**

- **Payments** — Pay UI, prepare/submit/cancel/status, calldata, UserOperation integrity, L-1a, L-2 (A+B, C-1, D-1, D-2, D-3a, D-4, D-5, D-6, D-7, D-8) → [pay-integrity-l1-l2.md](docs/status/pay-integrity-l1-l2.md)
- **Handle Pay and recipients** — `@handle` pay, recipient lookup/selection, recipient identity in history, Handle Pay A–E, the Slice E per-account limits → [phase-2-and-handles.md](docs/status/phase-2-and-handles.md) **and** [pay-integrity-l1-l2.md](docs/status/pay-integrity-l1-l2.md)
- **Rate limits and budgets** — Handle Pay lookup/prepare limits (Slice E) → [phase-2-and-handles.md](docs/status/phase-2-and-handles.md); provider budgets (chain-read, submit, Turnkey reconcile), registration/login limits, request size → [public-readiness-m1-m3.md](docs/status/public-readiness-m1-m3.md); payment submit/status behavior under a budget → also [pay-integrity-l1-l2.md](docs/status/pay-integrity-l1-l2.md)
- **Provisioning, registration and Turnkey/Safe authority** — provisioning evidence capture, account finalization, Turnkey recovery, S5 → [phase-2-and-handles.md](docs/status/phase-2-and-handles.md); registration dispatch ceilings, stateless login, passkey revocation, S3 recovery reads, provider timeouts → [public-readiness-m1-m3.md](docs/status/public-readiness-m1-m3.md)
- **Database migrations, runbooks and disposable-branch smokes** — migration safety and runbook rules → [phase-2-and-handles.md](docs/status/phase-2-and-handles.md) and [public-readiness-m1-m3.md](docs/status/public-readiness-m1-m3.md) (and [pay-integrity-l1-l2.md](docs/status/pay-integrity-l1-l2.md) where a payment slice mentions one)
- **Before modifying a security-sensitive Real Mode file or `schema.sql`** (`lib/real/**`, `app/api/real/**`, `components/real/**`, `lib/stores/real-*`, `test/lib/real/**`, `test/admin/**`, `schema.sql`): search ALL THREE `docs/status/` archives for the file's name and for any frozen-hash or fresh-audit requirement (for example `grep -rn "<file name>" docs/status/`). The topic index does not replace this search; one file can appear in several archives.

ARCHITECTURE.md holds the full record for each slice, under the section named in each status file. Historical references to "CLAUDE.md's <slice>" sections now resolve to these files.

## North Star

**Make on-chain finance feel like normal money.** Weigh every suggestion or implementation choice against this.

## Current Status

**Deployment is not authorized. Real Mode remains localhost-only, testnet-only, and not ready for public launch or mainnet.** No migration, live provider call, live database access or real payment happens without separate explicit authorization.

- **CLOSED:** Phase 2 testnet Real Mode foundation and the S5 security closeout; Turnkey parent/dashboard recovery; Handles; Handle Pay Slices A–E; Milestones 0, 1, 3A (3A-0 to 3A-3) and 3B; 3C-1, 3C-2, 3C-3a and 3C-3b; 3D-1 and 3D-2; R0, the login-envelope, challenge-purge, nonce-CAS and DELETE-forward-deadline hardening slices; Payment Integrity (CallData Binding), L-1a (with its compatibility record), L-2 A+B, C-1, D-1, D-3a, D-2 and D-4.
- **S3 operator-read deadlines — committed, formal closure NOT established:** the implementation was committed at `4a3fd5a` ("fix: bound S3 operator Turnkey reads"), but ARCHITECTURE.md and ROADMAP.md at HEAD still say its documentation audit and the operator's manual checkpoint are PENDING and that it is not closed, and no later commit records a closure. Treat it as committed implementation, not a closed slice; do not mark it closed without that record.
- **L-2 D-5 (stranded-screen copy) — CLOSED:** two Pay-form string literals plus tests; committed at `06ce25770cd19266bd9e5464ccf369af8ef0bd17`; the independent technical audit is recorded in committed history, the documentation-audit pass is operator-reported. It addresses D-4 Low-1 only; broader L-2 D stays OPEN. Details: [pay-integrity-l1-l2.md](docs/status/pay-integrity-l1-l2.md).
- **L-2 D-6 (bounded submit wait) — CLOSED:** client-only 60 s deadline on the Pay submit request (the POST is **not** aborted and the payment may still be sent; the user presses Check status). Implementation `b8ec81ec188bcef3ef3e6336d1e1fca348ccc51b`; closure-status records `38c44de4d86d0031406216b3ed3bf9434d7ed6ba`; final reconciliation `4e9af335a7b8db5c8c9e53bec92a5824548ceaea` (verified against `git log`). Its payment-store hash `c8f967ac…cb62` was frozen until D-7. Broader L-2 D stays OPEN. Details: [pay-integrity-l1-l2.md](docs/status/pay-integrity-l1-l2.md).
- **L-2 D-7 (malformed submit-response recovery) — CLOSED:** the Pay store adopts a submit HTTP 200 only if it is this request's own attempt (exact id; an allowed state — never `confirmed`, which comes only from the status path; the held recipient and amount; showable `failureReason` / `transactionHash`); anything else goes to the existing `unknown` state with the fixed message, with no automatic status read, retry, signing, Cancel or refresh. Committed at `365e516589d93867be5a0a771de5d71fb28a231d` ("fix: validate Pay submit responses before recovery", verified against `git log`; seven files: the store, its two test files and the four D-7 documentation records); the independent audit pass is operator-reported. Its store hash `8cb392f8…723d` was frozen until D-8. Broader L-2 D stays OPEN. Details: [pay-integrity-l1-l2.md](docs/status/pay-integrity-l1-l2.md).
- **L-2 D-8 (HTTP 401 / 404 Pay recovery) — implemented, offline-verified; audit and Git checkpoint PENDING; NOT closed:** an exact `ApiError` HTTP 401 / 404 from a Pay submit or status read shows fixed wording (401 "You're signed out…"; 404 "…It may still have gone through…"), never the server's text, and sets a memory-only `sessionRecovery` marker; the payment keeps its screen and status (submit 401/404 enter the existing `unknown` state) with the attempt, approval and account context kept, and nothing is requested, signed, retried, cancelled or refreshed by itself. The unknown screen then offers **Sign in again** (401) or **Check account** (404): exactly one explicit `checkSession()` through the existing account store — never a payment request, signing or sign-out, and never a switch back to the account that started the payment (a 404 can only show which account the browser's session belongs to; getting back to the original account is NOT solved). After a sign-in, `init()` re-reads `/latest` and no in-memory approval is reused. Two production files (`lib/stores/real-payment-store.ts`, `components/real/real-pay-form.tsx`) plus two test files; the action is offered on the unknown screen only. Closed only after one independent combined technical/documentation audit **and** the operator's verified commit and push (no commit hash exists; none is invented). Non-JSON error bodies, malformed Check status / Cancel / prepare / latest answers and the other screens' missing sign-in action stay OPEN. Details: [pay-integrity-l1-l2.md](docs/status/pay-integrity-l1-l2.md).
- **OPEN:** Milestone 3 as a whole; Milestone 3C (3C-3c is not authorized; ingress-dependent work is deferred to deployment planning); Milestone 3D; broader L-2 (C and D).
- **NOT STARTED / NOT AUTHORIZED:** Milestone 3E (authenticated write limits); L-2 E (stale prepared-row recovery). **DEFERRED:** Milestone 2 (invitation-only / beta registration admission).
- **Application-database migrations (localhost `production` Neon branch, endpoint `ep-shy-art-b5mrwl87`, database `neondb`):** **3A provider budgets (`real_provider_budgets`) — APPLIED** (the audited 11820-character statement, SHA-256 `8213b46c…3c67a5f5`, ran exactly once on 2026-11-17; the executor's read-only catalog checks matched the design; the operator then **reported** Cash balances load on Home and Pay — operator-reported, no new payment, no agent observation; its zero rows were counted before that check, so it is not claimed empty now). **3C-2 login-challenge uses — APPLIED** (once, 2026-11-16; 15070 characters, SHA-256 `00ff3969…bcdcbf1d1e`; operator confirmed primary and backup passkey login; record committed at `f313d61`). **3C-1 registration admission (`real_registration_admission`) — NOT applied, NOT authorized:** registration start fails closed (generic 500) until it is. Never add a bypass or migrate without authorization. Keep distinct each slice's closure, its disposable-branch smoke, the later migration and the manual check; none is deployment or public readiness. The 3A migration record is committed at `a4e8849`. Details: the dated operational updates at the end of [public-readiness-m1-m3.md](docs/status/public-readiness-m1-m3.md), and ARCHITECTURE.md's 3A-3 and 3C-2 sections.
- Do not start a slice, or build groundwork for one, before the user scopes it. Phase and milestone numbering is unchanged.

## Standing Rules

These cross-cutting rules apply to most tasks. Slice-specific rules and frozen hashes are in `docs/status/`. (Git conduct is in Working Style; Practice Mode, testnet-only and SDK boundaries are in Hard Constraints.)

- **Safe is the account; Turnkey is signing and Safe-owner infrastructure.** The Turnkey owner/root is not the user account. Never fund the Turnkey owner or tell a user to.
- **Never auto-adopt an uncertain Turnkey account.** Restoring any such recovery needs an operator-only provenance resolver for the exact attempt, scoped as its own slice. Compare Turnkey public keys exactly; never lowercase them.
- **No casual Safe-owner rotation, and no new Turnkey parent, child-organization migration or root-authority change** without an explicit, separately audited design (see the Turnkey recovery record in `docs/status/phase-2-and-handles.md`).
- **No blind retry, resend or re-dispatch after an uncertain outcome** of a UserOperation, a Turnkey provisioning dispatch, a passkey-signed Turnkey create/delete forward, or a database write. Each signed forward happens only under its durable claim (a removal DELETE: exactly one forward per claimed attempt; backup-passkey create: its one claimed, byte-identical replay) and is never re-submitted with the same body automatically. An uncertain provisioning dispatch is never retried, re-sent or adopted automatically; restoring any such recovery needs the operator-only provenance resolver described above, as its own slice. No cleanup after an uncertain final write. No network calls inside DB transactions (account finalization especially).
- **A timeout, exception, transport error or unavailable read is never proof of absence, rollback or non-execution.** It must not be treated as confirmation that something did not happen, was not sent, or can safely be repeated. (This does not forbid an explicit, operator-only, separately authorized recovery procedure that gathers its own authoritative evidence.)
- **No automatic or unapproved Pay recovery actions:** no automatic prepare, Cancel, signing, payment retry or submission. Recovery steps are explicit user actions. A client status check is not a payment authorization or dispatch action; server-side status reconciliation may perform guarded, state-conditional writes and consume a provider-read budget.
- **Payment state changes are exact-id, literal-source-state compare-and-set; one active payment per account.** The recipient and amount are legitimate inputs to prepare; once reserved, the stored reservation is the only authority for the payment's intent (recipient, amount, token, target, value, operation), never the request body, the browser or a provider response again.
- **Only the locally encoded Pay calldata derived from the approved reservation is trusted.** Never treat paymaster-, bundler- or other provider-returned `callData` or fields as authorization authority.
- **No reusable signing secrets in browser storage** (memory only, and only for the current attempt). **No credential, signing secret, API key or connection string belongs in project documentation**, and never read, copy or expose secret files as part of a documentation task.
- **Authentication and signing authorization stay separate.** A session, a handle or a lookup never authorizes a payment; a payment needs the bound passkey's own approval, verified server-side.
- **Registration activation goes only through its finalize path;** there is no generic activation transition.
- **Evidence and spent resources are protected.** Files under `evidence/` are private, git-ignored evidence: never modify, move, copy, stage, commit or paste them (the archives record no exception). Spent Neon branches and run ids are never reused; no further SQL against them; an agent never deletes a branch.
- **Security-sensitive changes need an independent audit** before the operator's checkpoint. Hashes marked "don't edit without a fresh audit" stay frozen.
- **Live operations need separate authorization:** live database or provider access, deployment, migrations and any real payment.
- Known unrelated flaky tests (the Practice `simulation-store` race, the "FIX 3" ordering test) are not fixed as part of feature work.

## Hard Constraints

- **Practice Mode uses fake money only and stays unchanged.** Do not modify `simulation/**`, `lib/stores/simulation-store.ts`, Practice financial semantics, or the Practice persistence version for Real Mode work. Practice and Real are parallel paths (see ARCHITECTURE.md); real financial state never goes through the simulation engine.
- **Real Mode is testnet-only.** No mainnet, no real-value funds, no production custody, for the whole of Phase 2. Nothing in the app may hold private keys or seed phrases, and nothing may store them in Zustand or browser persistence.
- **Blockchain SDKs live only in `lib/real/**`** (and secret-holding route handlers under `app/api/real/**`). Components, pages, and stores use `lib/real`'s interface. ESLint enforces this; don't work around it.
- **The Real Mode feature flag (`NEXT_PUBLIC_REAL_MODE_ENABLED`) is authoritative.** The client enforces it in one place, `lib/stores/mode-store.ts` (build-time value). The server enforces it at runtime in `lib/real/server/config.ts` (every `app/api/real/**` route and the request gate). Don't add per-page or per-component flag checks.
- **External facts about SDKs, networks, and services are candidates until verified.** ARCHITECTURE.md marks them as such; don't document or code them as settled without checking current sources first.
- **Hide jargon, not concepts.** Plain-language explanations and consequences come first; terms like gas, slippage, liquidity, LTV, or liquidation threshold are introduced contextually once they help the user understand what just happened, not permanently hidden. The goal is for users to eventually understand these concepts by name — don't add developer/protocol-facing language to consumer-facing surfaces "for accuracy," but don't scrub the vocabulary out of the product either.
- **This is a single-developer project.** Do not introduce abstractions, frameworks, services, or dependencies to solve problems that don't exist yet. Prefer the smallest, most boring solution that works. See ARCHITECTURE.md's principles before adding structure.
- **Design decisions are intentionally deferred.** Do not invent or lock in a color palette, typeface, or component library on your own initiative. If DESIGN.md still lists something as "deliberately undecided," ask before treating it as decided, or propose an option explicitly rather than silently picking one.
- **Don't jump batches.** Build only the ROADMAP.md batch the user has authorized — no wallet, RPC, contract, or transaction code as "groundwork" for a later batch, even if it seems reasonable. Confirm with the user first.

## Working Style

- Keep documentation and code concise but substantive — avoid filler.
- Git belongs to the operator: no coding agent stages, commits, pushes, fetches, pulls, merges, rebases or resets. Don't assume a commit or push happened without evidence from `git log`.
- When a task implies a decision that one of the docs above marks as open or undecided, surface that instead of quietly deciding it yourself.
- As real architectural or design decisions get made, update ARCHITECTURE.md / DESIGN.md to reflect reality rather than leaving them purely aspirational.
- The app is a Next.js (App Router) project — see ARCHITECTURE.md for the stack and the folder-level boundaries (`simulation/`, `lib/real/`, `lib/stores/`, `components/`). Don't assume a dependency exists until it's in `package.json`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
