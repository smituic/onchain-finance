# Status ledger — Private Pay V1 Mainnet Pilot (delivery track)

Created 2026-11-25 on HEAD `0241bb41d04f9e2c7bbb2ba9785f3232f69bfd1b`; **revised 2026-11-27 on HEAD `3a5708a1d9c9ab1d3f6945c31747dc31d5d9def9`** (WS-0 closed, M3D closed for controlled localhost development, hosting research integrated, AR-3 prepared — see §10). This is the single place that records the pilot's target, gates, workstreams and open decisions; CLAUDE.md, ROADMAP.md and ARCHITECTURE.md point here instead of repeating it. The operator runbook is [private-sepolia-staging.md](../runbooks/private-sepolia-staging.md).

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

## 3. Historical status reconciliation (as of 2026-11-25; only the Milestone 3D row was changed afterward, on 2026-11-27)

*How to read the supersession notes:* the S3 and CCIP-Read rows below are **current and stand as written**. They are what supersede the older "committed, formal closure NOT established" (S3) and "implementation complete; audit PENDING; NOT closed" (CCIP-Read) wording that still sits, as a dated record, in CLAUDE.md, ROADMAP.md, ARCHITECTURE.md and the earlier archive sections. Nothing in this ledger was itself superseded for S3 or CCIP-Read.

Recorded here so the pilot plan starts from one agreed baseline. Transcribed from the control room's instruction; this checkpoint verified only what `git log` shows.

| Item | Status |
|---|---|
| Milestones 0 and 1 | CLOSED |
| Milestone 2 (invitation-only / beta admission) | Previously DEFERRED; **now identified as a private-pilot admission dependency (WS-5). No M2 implementation is authorized.** |
| Milestone 3 and Milestone 3C | OPEN (3C-3c not authorized) |
| Milestone 3D | **FORMALLY CLOSED for controlled localhost Base Sepolia development by explicit control-room decision dated 2026-11-25**, following the independent consolidated Verdict B (no commit identifies the closure; it was transcribed into this ledger on 2026-11-27). *(Superseded this ledger's own first wording "OPEN; consolidated assessment pending", which was written on 2026-11-25 before the decision reached this checkpoint.)* **Combined findings, not M3D-only:** the independent combined WS-0 / M3D assessment returned 0 Critical / 0 High / 0 Medium / 2 Low / 8 Info; those counts cover WS-0 and M3D together and are not attributed to M3D alone. (A separate audit of the AR-1 / AR-2 documentation returned Verdict B with the AR-3 preparation on HOLD, 0 Critical / 0 High / 0 Medium / 2 Low / 9 Info; it is a different audit and its findings are addressed in §10.) **Closure limitations, carried with it:** no whole-route deadline guarantee; no guarantee of remote cancellation; every deadline value stays unmeasured; the four deferrals below remain; **closing M3D is not an automatic risk acceptance for staging or mainnet** — each of those needs its own evidence and decision. No completed M3D implementation is reopened. |
| Milestone 3, Milestone 3C, Milestone 3E | **Remain open** (3C-3c not authorized; 3E NOT STARTED). L-2 E remains UNAUTHORIZED. |
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

Milestone 3 and Milestone 3C are **not** closed by any statement in this file; Milestone 3D's closure is the bounded one stated in its row. *(2026-11-25 wording "Milestone 3D … not closed wholesale" superseded for 3D only.)* Historical archive prefixes are preserved byte for byte; later records are appended. Preserve all existing security invariants and technical freeze rules.

## 4. Workstream ledger

Status values: NOT STARTED, IN PROGRESS, BLOCKED. Review tiers are defined in §6.

| WS | Workstream | Status | What exists today (repository facts) | What is missing |
|---|---|---|---|---|
| WS-0 | Governance and protected staging runbook | **CLOSED** — independently audited (Verdict B); committed and pushed by the operator at `3a5708a1d9c9ab1d3f6945c31747dc31d5d9def9` ("docs: establish private Pay pilot roadmap and staging runbook"; the hash, message and six-file inventory verified against `git log` at the 2026-11-27 preflight) | CLAUDE.md, the three status archives, this ledger, the runbook | Nothing further; later documentation revisions are tracked in §10, not by reopening WS-0. |
| WS-1 | Protected Base Sepolia staging and isolated database bootstrap | NOT STARTED — runbook revision 2 (2026-11-27) integrates the hosting and Neon public research as [W] statements and prepares the AR-3 first-deployment checklist; **no hosting, provider or database action is authorized, AR-3 included** | No hosting project exists (no `.vercel/`, no `vercel.json`). The schema is one hand-applied file (`lib/real/server/schema.sql`, 2,810 lines) of ordinary statements, three unmarked constraint-swap blocks, one repair `UPDATE` and the marked fail-closed blocks; its recorded digests use **two different boundary conventions** and several statements have no historical pin (runbook §F); a whole-file bootstrap of an empty database has not been verified as one operation. | The operator's AR-3 prerequisites (§7: commit, project and manual no-Git deployment method, plan and spend ceiling, viewers, auto-deploy / preview policy, two-factor, evidence location), then AR-3; P-3 and P-13 before AR-4 / AR-5, P-14 before affected Real-on activity, P-19 before AR-8; isolated database; bootstrap rehearsal; gate G0 evidence. Tier A for anything touching schema, ingress or configuration. |
| WS-2 | Turnkey authority and independent exit | NOT STARTED — research and design needed | One development parent organization; its root quorum is threshold 1 over two roots (recovery CLOSED). The shared server API key and parent authority over child organizations are recorded S5 residuals. No analysis of whether a user can exit using only their own passkey exists. | An effective direct-and-indirect parent/child authority map; a user-controlled exit design and rehearsal; a per-environment parent plan. Tier A. |
| WS-3 | Mainnet network and environment isolation | NOT STARTED — no mainnet work authorized | Base Sepolia is hard-wired: chain id 84532, the Sepolia Circle USDC address, `baseSepolia` and the Pimlico `/v2/84532/` URL appear in 13 production files (`lib/real/constants.ts`, `chain/{balance,client,entry-point}.ts`, `payments/{amount,client-sign,hash,submit}.ts`, `server/{payments,pimlico}.ts`, `stores/real-payment-store.ts`, and two `components/real` files). Env names are `BASE_SEPOLIA_*`. The hard-coded public Sepolia RPC fallback (`https://sepolia.base.org`) is a further network-identity site, in `lib/real/server/config.ts` (a 14th file) and again in `lib/stores/real-payment-store.ts`: a missing RPC variable silently selects it. The only security headers are `frame-ancestors 'none'`, `X-Frame-Options`, `nosniff`; there is no script CSP, which S5 requires before any non-testnet deployment. | A scoped, audited chain-identity slice; verified mainnet token and contract identity; per-environment configuration; permanent RP ID and origins; script CSP; HSTS and cookie decisions. Tier A. |
| WS-4 | Financial exposure, sponsorship, emergency pause, operational controls | NOT STARTED | Sponsored gas through Pimlico with no sponsorship-policy id passed by the code. No gas or fee ceiling and no paymaster identity pinning (L-1 R2/R3, open). Provider budgets and dispatch ceilings are development values. One active payment per account. **No durable, shared payment pause exists** (none found in server code or schema). The Real Mode flag is deployment configuration: a new flag-off deployment returns 404 on every Real route **only for that deployment**; earlier deployments keep their original configuration and credentials until retired, and nothing reverses a payment or cancels remote work already started. It is not a project-wide kill switch and not a payment-only pause (runbook §M lists the five separate layers). | Numeric exposure policy (provisional until approved); sponsorship cap; an emergency pause (P-9) and a chosen stop procedure (P-19); a spend owner and ceilings (P-18); monitoring and alerts; incident response. Tier A. |
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
- **Routine steps inside an approved request need no separate approval.** Once an authorization request (runbook §N) is granted in writing, the routine reads, checks and configuration commands its written scope plainly covers are covered by that grant; anything outside the scope or on its exclusion list, and every stop condition, still needs a decision.
- Every existing freeze rule is preserved. One writer at a time. Agents never stage, commit or push. No new approval step is added for routine implementation work, and the tiers do not relax any "don't edit without a fresh audit" rule.

## 7. Open decisions (none decided here)

| ID | Decision | Needed by |
|---|---|---|
| P-1 | Staging hostname and RP ID; whether the staging host may ever become the pilot host (the RP ID is permanent per account) | The hostname is **recorded during AR-3** (not before); the permanent RP ID and origin are decided **before any passkey enrollment** (AR-8) |
| P-2 | Whole-deployment access-protection mechanism and who can reach staging (recommended: "All Deployments"; authorized viewers named) | **Before AR-3** |
| P-3 | Isolated Neon project, region, plan, backup retention and restore test | **Before AR-4 / AR-5** (does not block AR-3) |
| P-4 | Staging Turnkey parent, root-quorum plan; the mainnet parent plan | G0 / G2 |
| P-5 | RPC provider and key restrictions per environment | G0 / G2 |
| P-6 | Pimlico staging key, sponsorship policy and caps; the mainnet gas-sponsorship model | G0 / G2 |
| P-7 | Numeric funding, payment and sponsorship limits | G2 |
| P-8 | Admission design (WS-5) and suspension | G3 |
| P-9 | Emergency-pause design | G2 |
| P-10 | How the "testnet-only for the whole of Phase 2" constraint is amended | G2 |
| P-11 | Independent user-controlled exit design | G2 |
| P-12 | Legal and provider requirements for real-money use | G3 |
| P-13 | Schema bootstrap procedure and tooling (manual digest-checked apply versus a Tier A script) | **Before AR-4 / AR-5** (does not block AR-3) |
| P-14 | Hosting function-duration handling per route | **Before any affected Real-on activity** (does not block a credential-free, Real-off deployment) |
| P-15 | Script CSP, HSTS and cookie hardening | G2 |
| P-16 | Monitoring, alerting and incident response | G2 / G3 |
| P-17 | Whether to freeze `lib/real/chain/client.ts` (left open by the CCIP-Read record) | any time |
| P-18 | **Spend owner:** a named budget owner and a written spend ceiling per provider (hosting, database, Turnkey, Pimlico, RPC); whether the hosting plan offers a project budget and what it does when reached. A hosting budget bounds hosting only — it does not bound Turnkey or Pimlico. **Owner: the operator.** | Hosting ceiling **before AR-3**; each other provider's ceiling before that provider's credential is attached |
| P-19 | **Stop procedure ("kill switch"):** which of the five layers in runbook §M (access protection, retiring old deployments, credential revocation, a durable dispatch pause, already-running operations) the operator will use, in what order, how long each takes, and the rehearsal. A flag-off redeploy alone is not one. **Owner: the operator; the control room reviews.** | Before AR-8 |

**What AR-3 itself needs** (runbook §P.2): the approved commit; the project name and the deployment method (preferred: manual, with **no connected Git repository**); the hosting plan and spend ceiling (P-18); the authorized viewers (P-2); the auto-deployment and preview policy; the operator's two-factor authentication; the evidence location. P-1 (hostname) is recorded during AR-3; P-3, P-13, P-14 and P-19 do not block a credential-free, Real-off deployment — AR-3 carries its own bounded access and failure-stop procedure.

Unless a row says otherwise, the operator proposes and the control room approves. P-7 and P-9 cannot be settled without P-18 and P-19.

## 8. Next step

*(Updated 2026-11-27; the earlier "research-only" next step is superseded.)* The control room has supplied the hosting and Neon public-documentation research (AR-1) and it is integrated in the runbook as [W] statements; it is documentation, not verification of the operator's account. The proposed next action is for the **operator to take the decisions that gate AR-3** (§7, "What AR-3 itself needs") — the approved commit, the project name, the deployment method (preferred: **manual, with no connected Git repository**, from an isolated export of the approved commit, so that no push can deploy or promote an unapproved artifact), the plan and spend ceiling (P-18), the authorized viewers, the auto-deployment and preview policy, two-factor authentication and the evidence location — and then, only if the control room grants it in writing, to run **AR-3**: one separate, credential-free, Real-off, "All Deployments"-protected hosting project and one manual deployment, ending in a deployment-inventory recheck and a stop (runbook §P). The assigned hostname is recorded during AR-3, not decided before it. AR-3 is **not** authorized by this ledger. Turnkey, Pimlico, RPC and Base-mainnet public research remains outstanding for the later requests.

## 9. Maintenance

Update this ledger when a workstream or gate changes, with the date, the evidence and the commit that identifies it (verified against `git log`). Do not copy its contents into other files. Current-status tables (§3, §4, §7) are edited in place, marking what they supersede; every change is also logged in §10, which is append-only — add new dated entries at its end and do not rewrite earlier ones.

## 10. Change log (append-only)

- **2026-11-25** — Created at HEAD `0241bb4` (documentation only).
- **2026-11-27** (HEAD `3a5708a`; documentation only; no source, test, schema, configuration or dependency change) — WS-0 marked CLOSED at `3a5708a` after a successful preflight. Milestone 3D recorded as formally closed for controlled localhost Base Sepolia development by explicit control-room decision following the independent consolidated Verdict B, with its limitations (no whole-route deadline guarantee, no remote-cancellation guarantee, unmeasured deadline values, four accepted deferrals, no automatic staging or mainnet risk acceptance); M3, M3C and M3E stay open and L-2 E stays unauthorized. Runbook revision 2: public hosting and Neon research integrated as [W] statements; the earlier "flag off plus redeploy is the kill switch" wording corrected into five separate layers (finding Low-1); the schema digest conventions corrected and the statement inventory completed, with newly calculated, not-previously-audited reference digests marked as such (finding Low-2); runtime / build-time classification of the origin and RP-name variables corrected; the Pay-submit and Handle Pay limits and the RPC fallback network-identity site added; AR-3 checklist added. P-18 (spend owner) and P-19 (stop procedure) added with the operator as owner.
- **2026-11-27, second correction** (HEAD `3a5708a`; documentation only; no source, test, schema, configuration or dependency change; nothing authorized) — after the independent audit of the AR-1 / AR-2 documentation (Verdict B; AR-3 preparation on HOLD; 0 Critical / 0 High / 0 Medium / 2 Low / 9 Info — a **separate** audit from the combined WS-0 / M3D assessment, 0 / 0 / 0 / 2 Low / 8 Info, which covers WS-0 and M3D together and is not M3D-only). **Low-1:** the Milestone 3D control-room decision is dated **2026-11-25**, not 2026-11-27 (2026-11-27 is only when it was transcribed here); corrected in the §3 row and in the new, uncommitted archive section; the committed archive prefix (174,830 bytes, SHA-256 `76ed87e1…97e3`) is unchanged. **Low-2:** the first-deployment procedure no longer imports a Git repository; the preferred initial mechanism is a manual, operator-controlled deployment of an isolated export of the exact approved commit with **no connected repository**, so no push, production or preview trigger can deploy or promote an unapproved artifact (runbook §P, rewritten); a Git-connected workflow would need its own request, verified controls and review. **Info:** the digest counts, ranges and boundaries in runbook §F corrected (nine recorded digests; repair `UPDATE` 196–203; purpose-widening and `display_name` digests exclude the trailing newline, Recipient Identity includes it); AR-3 prerequisites aligned across this ledger, the WS-1 row and the runbook; stale M3D wording explicitly superseded in CLAUDE.md and ARCHITECTURE.md with the above/below reference corrected; the S3 / CCIP-Read supersession wording clarified in §3; the unset-flag and "unverified means unprotected" handling stated; protection tests given PASS / FAIL / NOT TESTABLE-UNDETERMINED outcomes with named static paths and an attributable-denial rule; evidence is preserved before any deployment is retired.
