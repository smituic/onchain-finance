# Status ledger — Private Pay V1 Mainnet Pilot (delivery track)

Created 2026-11-25 on HEAD `0241bb41d04f9e2c7bbb2ba9785f3232f69bfd1b`. This is the single place that records the pilot's target, gates, workstreams and open decisions; CLAUDE.md, ROADMAP.md and ARCHITECTURE.md point here instead of repeating it. The operator runbook is [private-sepolia-staging.md](../runbooks/private-sepolia-staging.md).

**This file authorizes nothing.** Deployment is not authorized. Real Mode remains localhost-only and testnet-only. No provider configuration, new provider resource, database creation or migration, SQL, staging deployment, live provider test, mainnet read, funding, payment, authority change or tester invitation happens without a separate, bounded control-room authorization. Every freeze rule and security invariant in CLAUDE.md and `docs/status/` stands unchanged. These workstreams are new delivery work; they do not erase, renumber or reopen any historical milestone.

---

## 1. Decided product target

- **Target date: 25 December 2026 — conditional, not a guaranteed release date.**
- **A private, invitation-only Pay V1 pilot on Base Mainnet.** Friends and explicitly approved testers only. It begins with operator-only verification; two or three external testers follow only after a separate release approval. No public launch, no unrestricted registration, no automatic cohort expansion.
- **In:** passkey onboarding and login; username (handle); Receive Cash; Cash balance; Pay; payment activity and outcome; account security; reliable recovery and exit.
- **Out:** Save, Invest, Swap, Borrow.
- **North star:** "Make on-chain finance feel like normal money."
- **Constraint reconciliation (open — see decision P-10):** CLAUDE.md's Hard Constraints and ROADMAP.md's Phase 2 say Real Mode is testnet-only "for the whole of Phase 2". That wording is **not changed** by planning. It stays in force until the control room records a separate, bounded G2 approval and amends the governance text itself.

## 2. Authorization boundary

Offline planning, and offline implementation that is specifically authorized, may proceed. Each of these needs its own separate, bounded authorization (none exists today): provider configuration; new provider resources; database creation or migration; SQL execution; staging deployment; live provider testing; mainnet read-only verification; mainnet funding; mainnet payments; ownership or authority changes; external tester invitations.

## 3. Historical status reconciliation (as of 2026-11-25)

Recorded here so the pilot plan starts from one agreed baseline. Transcribed from the control room's instruction; this checkpoint verified only what `git log` shows.

| Item | Status |
|---|---|
| Milestones 0 and 1 | CLOSED |
| Milestone 2 (invitation-only / beta admission) | Previously DEFERRED; **now identified as a private-pilot admission dependency (WS-5). No M2 implementation is authorized.** |
| Milestone 3 and Milestone 3C | OPEN (3C-3c not authorized) |
| Milestone 3D | OPEN. A consolidated closure assessment is **pending** and is not declared here. |
| Overall L-2 | FORMALLY CLOSED for controlled localhost development on Base Sepolia only. L-2 E remains UNAUTHORIZED. |
| 3A (provider budgets) and 3C-2 (login-challenge uses) | Migrations APPLIED to the existing development database |
| 3C-1 (registration admission) | Implemented; migration **NOT applied** to the development database and NOT authorized |
| CCIP-Read hardening | **FORMALLY CLOSED at `0241bb41d04f9e2c7bbb2ba9785f3232f69bfd1b`** ("fix: disable unnecessary CCIP-Read lookups"; `git log` verifies the hash, the message and exactly six changed files, parent `a44e497`). Independent combined audit, reported by the control room: Verdict B, 0 Critical / High / Medium / Low, 6 accepted Info. |
| S3 operator Turnkey read deadlines | **FORMALLY CLOSED by explicit control-room decision on 2026-11-25.** Implementation commit `4a3fd5a600782b216f13b659484aac3e2383ac37` ("fix: bound S3 operator Turnkey reads"; verified against `git log`). Current independent closure assessment, reported by the control room: Verdict B, 0 Critical / High / Medium, 1 accepted Low, 4 accepted Info. **The original S3 documentation-audit result is unavailable and is not claimed to have passed.** |
| Onboarding Safe-address derivation deadline | FORMALLY CLOSED at `a44e497802efa2fcb952063b7d2004ab3f59da51` (already recorded) |

**M3D decisions that stay deferred and are not reopened by this checkpoint:**
- **`Retry-After` ceiling** — assessed and deferred; no numeric ceiling approved.
- **Neon database deadline implementation** — assessed and researched; deferred; no Neon timeout value or database configuration change approved.
- **UserOperation send-response-body deadline** — Verdict E accepted (deferred).
- **Backup-passkey CREATE-forward deadline** — Verdict E accepted (deferred). "CREATE-forward" here means the passkey-signed `create_authenticators` forward, **not** the initial `CREATE_SUB_ORGANIZATION_V8` call. Initial account provisioning already has a 10-second submit abort deadline. The backup forward remains unbounded and needs a separate 2g-H replay-policy decision before any deadline is introduced.
- **A proposal to reprioritize the UserOperation caller deadline was NOT approved.** The existing deferral stands until measured staging evidence or material new evidence justifies reconsidering it.

Milestone 3, Milestone 3C and Milestone 3D are **not** closed wholesale by any statement in this file. Historical archive prefixes are preserved byte for byte; later records are appended.

## 4. Workstream ledger

Status values: NOT STARTED, IN PROGRESS, BLOCKED. Review tiers are defined in §6.

| WS | Workstream | Status | What exists today (repository facts) | What is missing |
|---|---|---|---|---|
| WS-0 | Governance and protected staging runbook | **IN PROGRESS** — this documentation checkpoint; independent documentation/governance review pending | CLAUDE.md, the three status archives, this ledger, the runbook | Review, then the operator's Git checkpoint. Tier C, with domain review of security wording. |
| WS-1 | Protected Base Sepolia staging and isolated database bootstrap | NOT STARTED — runbook drafted; every live step unauthorized | No hosting project exists (no `.vercel/`, no `vercel.json`). The schema is one hand-applied, idempotent, fail-closed file (`lib/real/server/schema.sql`, 2,810 lines); a whole-file bootstrap of an empty database has not been verified as one operation. | Hosting and protection decisions; isolated database; bootstrap rehearsal; gate G0 evidence. Tier A for anything touching schema, ingress or configuration. |
| WS-2 | Turnkey authority and independent exit | NOT STARTED — research and design needed | One development parent organization; its root quorum is threshold 1 over two roots (recovery CLOSED). The shared server API key and parent authority over child organizations are recorded S5 residuals. No analysis of whether a user can exit using only their own passkey exists. | An effective direct-and-indirect parent/child authority map; a user-controlled exit design and rehearsal; a per-environment parent plan. Tier A. |
| WS-3 | Mainnet network and environment isolation | NOT STARTED — no mainnet work authorized | Base Sepolia is hard-wired: chain id 84532, the Sepolia Circle USDC address, `baseSepolia` and the Pimlico `/v2/84532/` URL appear in 13 production files (`lib/real/constants.ts`, `chain/{balance,client,entry-point}.ts`, `payments/{amount,client-sign,hash,submit}.ts`, `server/{payments,pimlico}.ts`, `stores/real-payment-store.ts`, and two `components/real` files). Env names are `BASE_SEPOLIA_*`. The only security headers are `frame-ancestors 'none'`, `X-Frame-Options`, `nosniff`; there is no script CSP, which S5 requires before any non-testnet deployment. | A scoped, audited chain-identity slice; verified mainnet token and contract identity; per-environment configuration; permanent RP ID and origins; script CSP; HSTS and cookie decisions. Tier A. |
| WS-4 | Financial exposure, sponsorship, emergency pause, operational controls | NOT STARTED | Sponsored gas through Pimlico with no sponsorship-policy id passed by the code. No gas or fee ceiling and no paymaster identity pinning (L-1 R2/R3, open). Provider budgets and dispatch ceilings are development values. One active payment per account. The Real Mode flag returns 404 for every route when off, but it is all-or-nothing, not a payment-only pause. | Numeric exposure policy (provisional until approved); sponsorship cap; an emergency pause; monitoring and alerts; incident response. Tier A. |
| WS-5 | Invitation-only admission and ongoing pilot membership | NOT STARTED — M2 dependency; no implementation authorized | Registration is open to any caller who can reach the origin, limited only by the 3C-1 global pool (30 per hour, 100 per day), which anonymous traffic can exhaust and which is **not applied** to the development database. No membership table, invitation or suspension mechanism exists. | A server-enforced approved-membership design covering registration **and** later logins, with revocation. Tier A. |
| WS-6 | Pay-only UX, Receive, recovery and withdrawal | NOT STARTED | Pay by `@handle` or address, Cash balance, history, backup passkey, "sign out everywhere" exist. There is no Receive screen; the Safe address sits in an account-details expander next to the owner address (recorded Low). Save, Invest, Swap and Borrow are Practice-only in Real Mode. | A Receive surface that shows only the Safe; real-money-truthful copy; a Pay-only Real surface; an exit path. Tier B for presentation, Tier A for anything touching identity, recovery or authority. |
| WS-7 | Operational verification and release testing | NOT STARTED | The testnet verification matrix is drafted in the runbook (§L). | Execution evidence, monitoring, incident drills, provider and legal review. |

## 5. Release gates

Each gate needs its own written control-room approval; passing one never opens the next.

- **G0 — Protected and isolated Base Sepolia staging.**
- **G1 — Complete testnet payment and recovery/exit rehearsal.**
- **G2 — Separately approved operator-only mainnet payment and exit.**
- **G3 — Two or three explicitly approved external testers, after all external-release gates below.**
- **G4 — Separately approved cohort expansion.**

**Before any real-money funding (G2), establish:** the effective direct and indirect Turnkey parent/child authority; reliable user-controlled exit; the correct permanent RP ID and origins; verified network and contract identity; environment and database isolation; bounded sponsorship and operator exposure; financial policy and an emergency pause; a successful testnet rehearsal.

**Before external tester funding (G3), also establish:** server-enforced approved membership; a Safe-only funding destination; tested backup and recovery; a usable exit; truthful real-money UI; monitoring and incident response; applicable provider and legal requirements (not assessed here).

**Numeric funding, payment and sponsorship limits are PROVISIONAL and not approved. No number in this repository or in these documents is a pilot limit.** The existing code values (per-account provider budgets, the 3C-1 pool, dispatch ceilings, the 256 KiB body ceiling) are development values only.

## 6. Engineering process (tiered review)

- **Tier A — financial, identity, authentication, concurrency, recovery, chain configuration, migrations, ingress and security controls.** Approved scope or design → Builder → independent combined audit → the operator's manual Git checkpoint.
- **Tier B — routine non-sensitive product work, operational presentation, tooling.** Focused implementation and review.
- **Tier C — ordinary documentation and runbooks.** Appropriate review without repeated audit cycles. Security-sensitive wording and governance still get domain review.
- Every existing freeze rule is preserved. One writer at a time. Agents never stage, commit or push. No new approval step is added for routine implementation work, and the tiers do not relax any "don't edit without a fresh audit" rule.

## 7. Open decisions (none decided here)

| ID | Decision | Needed by |
|---|---|---|
| P-1 | Staging hostname and RP ID; whether the staging host may ever become the pilot host (the RP ID is permanent per account) | G0 |
| P-2 | Whole-deployment access-protection mechanism and who can reach staging | G0 |
| P-3 | Isolated Neon project, region, plan, backup retention and restore test | G0 |
| P-4 | Staging Turnkey parent, root-quorum plan; the mainnet parent plan | G0 / G2 |
| P-5 | RPC provider and key restrictions per environment | G0 / G2 |
| P-6 | Pimlico staging key, sponsorship policy and caps; the mainnet gas-sponsorship model | G0 / G2 |
| P-7 | Numeric funding, payment and sponsorship limits | G2 |
| P-8 | Admission design (WS-5) and suspension | G3 |
| P-9 | Emergency-pause design | G2 |
| P-10 | How the "testnet-only for the whole of Phase 2" constraint is amended | G2 |
| P-11 | Independent user-controlled exit design | G2 |
| P-12 | Legal and provider requirements for real-money use | G3 |
| P-13 | Schema bootstrap procedure and tooling (manual digest-checked apply versus a Tier A script) | G0 |
| P-14 | Hosting function-duration handling per route | G0 |
| P-15 | Script CSP, HSTS and cookie hardening | G2 |
| P-16 | Monitoring, alerting and incident response | G2 / G3 |
| P-17 | Whether to freeze `lib/real/chain/client.ts` (left open by the CCIP-Read record) | any time |

## 8. Next step

The proposed next action is **research-only**, not hosting work: a public-documentation research record for the provider facts the runbook marks `[P]` (hosting protection, duration, environment handling and cost; Neon branching, retention and pricing; Turnkey authority and pricing; Pimlico policy and caps; Base mainnet identity). It needs its own authorization because this checkpoint had no network. See runbook §N, request AR-1.

## 9. Maintenance

Update this ledger when a workstream or gate changes, with the date, the evidence and the commit that identifies it (verified against `git log`). Do not copy its contents into other files. Append new dated entries below this line; do not rewrite earlier ones.
