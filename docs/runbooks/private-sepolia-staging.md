# Runbook — Protected, isolated Base Sepolia staging (WS-1, gate G0)

**Status: DRAFT. Nothing in this runbook is authorized to run, and no command in it has been run.** It was written from read-only inspection of this repository at HEAD `0241bb41d04f9e2c7bbb2ba9785f3232f69bfd1b` on 2026-11-25. Deployment remains NOT AUTHORIZED. Each step below needs the matching authorization request in §N, granted separately and in writing, before anyone performs it. Existing development infrastructure (the localhost app, the development Neon database and endpoint, the development Turnkey parent organization, the existing Pimlico and RPC credentials) stays untouched and is never reused for staging.

Context: [private-pay-pilot.md](../status/private-pay-pilot.md) holds the target, gates, workstreams and open decisions. This runbook covers only getting a **protected, isolated, Base Sepolia, operator-only** hosted copy to the point where its testnet behavior can be verified (G0, then the G1 rehearsal). It is not a mainnet runbook.

## How to read this document

Every statement carries one of these tags. Do not treat one kind as another.

- **[R] Verified repository fact** — read from source or the committed docs at the HEAD above. The file is named.
- **[P] Provider fact requiring public research** — about Vercel, Neon, Turnkey, Pimlico, an RPC provider or Base. **Not verified.** Nothing here claims a provider's behavior, price, limit or guarantee. Authoritative current documentation must be read first (request AR-1).
- **[D] Configuration decision requiring approval** — a choice nobody has made.
- **[L] Live verification still outstanding** — can only be established by a live check that has not been authorized or run.

**Standing rules for every step:** secrets never go into this repository, documentation, a commit, a chat message or a log (names only, always); one writer at a time; agents never stage, commit or push; spent Neon branches and run ids are never reused and an agent never deletes a branch; no blind retry after an uncertain outcome; a timeout or error is never proof that something did not happen; stop on any surprise (§M).

---

## A. Environment variables — names and purpose only

Read from `.env.example` (the template; `.env.local` was not opened) and from source. **No values appear here.**

| Name | Kind | Read by | Purpose and staging note |
|---|---|---|---|
| `NEXT_PUBLIC_REAL_MODE_ENABLED` | public, build-time | client `lib/stores/mode-store.ts`; server `lib/real/server/config.ts` (reads it at request time) | Real Mode exists only when the value is exactly `true`. Unset or anything else means Practice only [R]. Client and server read it separately; a mismatch fails closed (S5 L6) [R]. Changing the client's value needs a rebuild [R `.env.example`]. When off, every `/api/real/**` route answers 404 [R `http.ts`, `request-gate.ts`]. |
| `NEXT_PUBLIC_REAL_RP_ID` | public, build-time + server | server `config.ts`; browser `lib/stores/real-payment-store.ts` | The WebAuthn relying-party id. Must be the **exact app host**, never a parent domain (S5 M3) [R]. The browser store falls back silently to `"localhost"` if this is unset in the build [R `real-payment-store.ts:899`], so a build without it signs for the wrong RP. |
| `NEXT_PUBLIC_REAL_RP_NAME` | public | server `config.ts` | Display name shown by passkey managers on **new** passkeys only [R]. Defaults to "ON Chain Finance". |
| `NEXT_PUBLIC_REAL_ORIGIN` | public, build-time + server | server `config.ts`, `request-gate.ts` | Exact origin(s) (scheme + host + port), comma-separated. One list drives both WebAuthn `expectedOrigin` and the `/api/real/**` request gate; the gate never trusts `Host` or `X-Forwarded-Host` [R]. |
| `REAL_SESSION_SECRET` | server secret | `config.ts`, `session.ts` | HMAC key for the session cookie. Hex or base64/base64url of at least 32 random bytes; passphrases are refused [R]. Changing it signs everyone out. Must be unique to staging. |
| `TURNKEY_API_BASE_URL` | server | `config.ts` | Defaults to `https://api.turnkey.com` [R]. `lib/real/constants.ts` also hard-codes that URL for the browser stamper [R]. |
| `TURNKEY_PARENT_ORGANIZATION_ID` | server | `config.ts` | The parent organization the server provisions child organizations under. Staging needs its own (§H) [D]. |
| `TURNKEY_API_PUBLIC_KEY` | server secret-adjacent | `config.ts` | Parent API key, public half. Never register it as a child root or signing credential [R `.env.example`]. |
| `TURNKEY_API_PRIVATE_KEY` | server secret | `config.ts` | Parent API key, private half. Never exposed to the browser [R]. |
| `BASE_SEPOLIA_RPC_URL` | server | `config.ts` | Chain reads and the Safe-address derivation. Falls back to `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL`, then to the public `https://sepolia.base.org` if both are unset [R `config.ts`]. |
| `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL` | **public**, build-time | browser `real-payment-store.ts` | Compiled into the browser bundle. **Anything placed in it is public**, including a provider key [R]. |
| `DATABASE_URL` | server secret | `lib/real/server/runtime.ts` | Neon connection string. In a production build (`NODE_ENV=production`) with Real Mode on, a missing value throws; in development it silently falls back to in-memory stores that reset on restart [R]. |
| `PIMLICO_API_KEY` | server secret | `config.ts`, `pimlico.ts` | Bundler and paymaster. The key travels as an `?apikey=` query parameter in the request URL [R `pimlico.ts:19`], so any log or trace of that URL contains it. The code passes **no sponsorship-policy id** [R]. |
| `NODE_ENV` | platform | `runtime.ts`, `session.ts` | `production` makes the session cookie `Secure` and makes a missing `DATABASE_URL` fatal [R]. |

**Not environment variables:** the request-body ceiling (256 KiB), the 3C-1 pool (30 per hour, 100 per day), the dispatch ceilings (5 per hour, 20 per day, 2 per attempt), the provider budgets (chain read 30 per 600 s and 200 per day; Turnkey reconcile 20 per 600 s and 100 per day) and every caller deadline are frozen code constants with no runtime override [R]. They are development values, not approved pilot limits.

**Operator-only gates, never set on a hosted deployment:** the `REAL_ADMIN_*`, `REAL_SMOKE_*` and `NEON_BRANCH_*` families gate the admin runners and Neon smoke tests under `test/` [R]. They must not exist in any hosting environment's configuration. Also the gated Neon smoke suite writes rows to whatever `DATABASE_URL` points at [R], so it must never be run against staging.

## B. Hostname and relying-party decisions

- **[R]** Passkeys are created for one RP ID and signing goes browser → Turnkey directly using it; the server's origin checks never see that request (S5 M3). The RP ID must equal the exact host.
- **[D] B1 — the staging hostname.** One dedicated hostname, owned and DNS-controlled by the operator. **[P]** whether a platform-assigned shared domain (for example a `*.vercel.app` name) is acceptable as an RP ID is unresearched; a custom domain may be required.
- **[D] B2 — a single origin.** `NEXT_PUBLIC_REAL_ORIGIN` lists exactly one `https://<staging-host>` (no port). No preview, alias or localhost origin may be added. If a second origin is ever listed it widens who can reach the passkey and the request gate.
- **[D] B3 — permanence.** A passkey belongs to its RP ID. **[P]** what Turnkey does with a child organization's authenticators if the RP ID later changes is unverified; assume changing it strands every account registered under the old one. Staging and any later mainnet host must be **different** RP IDs so no passkey is shared across environments. Decide whether the staging host may ever become the pilot host before creating a single account.
- **[L]** Confirm the browser store receives the staging RP ID at build time (the `"localhost"` fallback above), and that registration on the staging host yields a passkey bound to it.

## C. Whole-deployment access protection

**Why this comes before any credential:** the app has **no caller authentication in front of registration**. The request gate checks `Origin`, `Sec-Fetch-Site`, `Referer` and `Content-Type`; it does not identify who is calling [R `request-gate.ts`]. Anyone who can reach the origin can start registration, bounded only by the 3C-1 global pool, which they can exhaust [R]. Registration creates real provider-side resources (Turnkey child organizations). Protection must therefore be at the platform layer and cover everything.

- **[R]** No hosting project exists: no `.vercel/` directory, no `vercel.json` [R].
- **[D] C1** — choose the mechanism (platform deployment protection, an IP allow-list, an authenticating proxy, or another) and who holds the bypass or credential. Treat any bypass link or token as a secret.
- **[P] C2 — to research before choosing:** which protection modes the platform offers; whether they cover the production custom domain, every per-deployment URL, preview URLs and branch aliases; whether direct requests to `/api/real/**` are covered; what plan the protection needs; how automation or a bypass works and how it can leak.
- **Coverage that must hold [L]:** from an unauthenticated client outside the operator's network, **each** of these is refused before reaching the app: the staging hostname; every `*.vercel.app`-style deployment URL for that project; every preview and branch alias; a direct `GET` and `POST` to `/api/real/session`, `/api/real/account/register/options` and `/api/real/account/login/options`; static assets. Record the status codes and any redirect target.
- **[L]** The protection layer must not break WebAuthn or the request gate: confirm a passkey ceremony completes through it and that `Origin` and `Sec-Fetch-Site` reach the app unchanged.
- **[L]** Confirm the platform's CDN does **not** cache authenticated `/api/real/**` GET responses. The app sets no explicit `Cache-Control: no-store` on them and whether Next adds one is unverified [R ARCHITECTURE.md, S5 "Also noted"].

## D. Starting with Real Mode disabled and paid credentials detached

Order matters. Nothing paid or identity-bearing is attached until protection is proven.

1. **[D]** Create the hosting project with **only** `NEXT_PUBLIC_REAL_MODE_ENABLED=false` (or unset) and the public RP/origin values. **No** `TURNKEY_*`, `PIMLICO_API_KEY`, `DATABASE_URL`, `REAL_SESSION_SECRET` or RPC key is set. **[R]** With the flag off the client is Practice-only and every `/api/real/**` route answers 404; the Turnkey, Pimlico and database code paths are not reached.
2. **[L]** Prove §C coverage on this credential-free deployment. Prove headers: `Content-Security-Policy: frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` are present [R `next.config.ts`]. Record that there is **no** script CSP and **no** HSTS from the app [R].
3. Only after §C, §E and §K evidence and the approvals in §N, attach in this order, least costly and least authoritative first: the isolated database (§E–§G), the session secret, the RPC key, the Turnkey staging parent, and **last** the Pimlico key. Then turn the flag on through a rebuild and redeploy.
4. **Detaching is two actions, not one.** Turning the flag off and redeploying stops the app from using credentials, but it does not revoke them. Revocation happens at each provider (§M).
5. **[R]** Keep `NODE_ENV=production` for staging builds so the cookie is `Secure` and a missing database fails closed instead of silently using memory.

## E. Fresh isolated Neon database

- **[D] E1 — a new, empty Neon project and database.** Not the development project, and **not a branch of it**. **[P]** Neon branches start as copies of their parent's data, which would carry development accounts, identity mappings and handles into staging; confirm the semantics, but the requirement stands regardless: staging begins from a catalog with no application tables and no copied data.
- **[R]** The existing development database is the localhost `production` branch, endpoint `ep-shy-art-b5mrwl87`, database `neondb`. Staging's endpoint must differ from it; compare the endpoint id before any apply (the admin runners already require an exact expected endpoint and database name [R]).
- **[R]** Runtime access uses `@neondatabase/serverless` 1.1.0 over HTTP, with the READ COMMITTED isolation level pinned in code (`createNeonSqlClient`); the earlier brand-new-branch smoke runs recorded READ COMMITTED on the pooled endpoint [R]. The earlier real-database migration applies used the **direct (non-pooled)** endpoint [R ARCHITECTURE.md, handles record]. **[D]** use the same split: a direct endpoint for the operator's apply, the pooled one for `DATABASE_URL`.
- **[D]** Two roles if Neon allows it: an owner role for the operator's migrations and a runtime role for the app. **[R]** the app issues no DDL at runtime (`neon-store.ts` contains no `CREATE`/`ALTER`), but whether the runtime role can safely be limited to data access is unverified [L].
- **[P]** Plan, compute limits, storage, retention window and point-in-time restore. **[L]** a restore must be tested before external-tester funding (gate G3).
- **[R]** Spent branches and run ids are never reused; refer to disposable branches by run id; an agent never deletes a branch.
- **Evidence before bootstrap [L]:** the connection reaches the intended new endpoint; the database is empty (no application tables); the engine version and default isolation level are recorded. Evidence files go to the git-ignored `evidence/` folder and are never pasted anywhere.

## F. Existing schema and bootstrap order

- **[R]** The schema is one file, `lib/real/server/schema.sql` (2,810 lines). It is hand-applied: ordinary `CREATE ... IF NOT EXISTS` and `ALTER ... IF NOT EXISTS` statements, then marked, idempotent, fail-closed `DO $$` blocks, in this file order (the file itself, not this summary, is authoritative): (1) the base tables `webauthn_challenges`, `registration_attempts`, `real_accounts`, `real_passkeys`, backup enrollments, revocation attempts and resolutions and `payment_attempts`, with their later additive columns and indexes interleaved as the file orders them (the 2g-H one-open index, S1 attribution, finite expiry, the S4 session epoch, the account `display_name` column); (2) the S5 L2 identity indexes; (3) **Account Handles** (including the reserved-name seed); (4) **Payment Attempt Recipient Identity**; (5) **Handle Pay Rate Limits**; (6) **Provider Budgets**; (7) **Registration Admission** (seeds its one row); (8) **Login Challenge Uses**; (9) **Provisioning Evidence Capture**.
- **[R]** Each `DO` block carries a recorded SHA-256 and character count in the docs (for example Provider Budgets 11,820 characters `8213b46c…3c67a5f5`, Registration Admission 13,101 `b269ebcc…ac91f`, Login Challenge Uses 15,070 `00ff3969…bcdcbf1d1e`, Handle Pay Rate Limits 11,680 `78c5557d…`, Provisioning Evidence 20,422 `6931570b…`). Those statements are evidence-bearing and must not change.
- **[R]** Comments inside `schema.sql` about where a block "has been applied" are historical and in places stale (the Registration Admission and Login Challenge Uses headers still say "NOT APPLIED ANYWHERE"). They are not edited here; the status archives are the current record.
- **[L / not verified]** Applying the **whole file** to an empty database as one operation has not been shown in this repository; the smoke tests prove blocks one at a time through scratch schemas and a disposable branch's `public` schema, using a block extractor in test fixtures. **[D] P-13:** whether the operator applies each extracted statement by hand with a SHA-256 check against the recorded digest, or a Tier A script does it. No such tool exists as a documented command, and none may be run ad hoc.
- **Required rehearsal (G0 evidence) [L]:** first on a brand-new disposable database that is not staging, apply in file order, then re-run to prove idempotence, then run read-only catalog checks that every expected table, index, constraint and seed row exists. Only then repeat on the staging database.

## G. Migration prerequisites

With Real Mode on and the code at HEAD, **every** table below must exist and be correct before the first real request. Each route fails closed (generic 500, or a 4xx/5xx refusal) without its table; none is created by the app [R].

| Migration | Needed for | If missing |
|---|---|---|
| Base tables, S1/S4/S5 L2 columns and indexes | Registration, login, passkeys, payments | Routes fail |
| Account Handles (incl. reserved seed) | Claiming a handle; name display | Claim and name save answer 500 |
| Payment Attempt Recipient Identity | Pay prepare (handle and address) | Prepare fails closed |
| Handle Pay Rate Limits (Slice E) | Recipient lookup and prepare limits | Limiter fails closed |
| **Provider Budgets (3A)** | Balance, payment status, submit and Turnkey reconcile reads | Those routes fail closed |
| **Registration Admission (3C-1)** + its seed row | Starting any registration | Every registration start answers the generic 500 |
| **Login Challenge Uses (3C-2)** | Every login | Every login answers the generic 500; no session |
| Provisioning Evidence Capture | Registration dispatch claim | No registration can dispatch |

- **[R]** Status on the **development** database: 3A and 3C-2 applied; 3C-1 not applied and not authorized. **Nothing in this runbook touches the development database.** A new staging database has none of them applied, so **all** are applied there, including 3C-1.
- **[R]** 3C-1's global pool (30 per hour, 100 per day) is anonymous-exhaustible and is not invitation control. For operator-only staging behind §C protection it is acceptable [D]; for any external tester it is not (WS-5).
- **[D]** Apply nothing until the P-13 procedure, the rehearsal in §F and the authorization in §N exist. After applying, verification is read-only catalog checks against the recorded digests and the expected seed rows (one admission row; reserved handles).

## H. Isolated provider and session configuration

- **Turnkey.** **[D]** a **new parent organization for staging**, separate from the development parent; its own server API key, never registered as a child root or signing credential [R `.env.example`]. **[D]** the staging parent's root users and quorum, with a tested recovery path **before** the first account is created (the development parent once had a working server key and no usable dashboard credential; recovery took Turnkey Support) [R status archive]. **[P]** pricing, rate limits and quotas for child organizations and signing activities (unresearched in this repository), and whether a parent can read or act on a child's wallet. **[R]** the app's own caps: 5 dispatches per hour, 20 per day, 2 per attempt [R].
- **Pimlico.** **[D]** a separate staging key restricted to Base Sepolia. **[P]** key-level spending caps, domain or IP restrictions, whether sponsorship applies to every UserOperation the key sees, and billing alerts. **[R]** no gas or fee ceiling and no paymaster-identity pin exists in code (L-1 R2/R3, open); the code-side bounds on sponsored spend found in this inspection are one active payment per account, the prepare rate limit and the structural sponsorship checks (L-1a); none is a spending cap [R].
- **RPC.** **[D]** a dedicated staging endpoint. **[R]** the server needs the `finalized` block tag, because "no money moved" is concluded only from finalized state (S2); the provider must serve it [L]. **[R]** the chain id is checked as 84532 before any proof is read (S5 M1). **[D]** because the browser bundle carries its own RPC URL, use a key that is safe to expose (or the public endpoint) there, and keep the server key separate.
- **Session secret.** **[D]** generate a fresh value outside the repository, store it only in the hosting platform's secret store, never reuse the development value. **[P]** whether the platform offers write-only or "sensitive" variables.
- **[L]** After configuration, a names-only check (not values) that no development credential, endpoint or organization id is present anywhere in the staging environment.

## I. Provider cost controls

- **[R]** Cost levers in code are development values only: provisioning dispatch ceilings, 3C-1 pool, per-account chain-read and reconcile budgets, one active payment per account, 256 KiB body ceiling. None is an approved pilot limit.
- **[D]** a named budget owner and a written weekly spend ceiling per provider **before** any credential is attached. **[P]** which providers support hard caps (as opposed to alerts), usage dashboards, and billing alerts; the cost of function invocations, bandwidth, Neon compute, RPC requests, Turnkey activities and Pimlico sponsorship (including whether Base Sepolia sponsorship is billed at all).
- **[D]** a kill switch the operator can use in minutes: flag off plus redeploy, then provider-side key revocation (§M). **[L]** rehearse it once before any tester.
- **[R]** Reads that cost provider calls are metered per account (3A), but anonymous registration is metered only globally, so §C protection is also the cost control for anonymous traffic.

## J. Hosting duration, request framing, cookies, headers and CSP

- **Duration.** **[R]** no route exports a `maxDuration` and there is no `vercel.json`. Caller deadlines exist in code (15 s Safe derivation, 25 s Pimlico preparation, 15 s receipt read, 10 s / 15 s / 20 s chain reads, 10 s DELETE forward, 10 s initial provisioning submit) but they are logical caller timers, not route deadlines. A Pay prepare runs several separately bounded stages (balance read up to 15 s, clock read up to 10 s, preparation up to 25 s) plus database access that has no caller deadline, so no single timer bounds the route (an inference from the M3D records, not a measurement). **[P]** the platform's default and maximum function duration for the chosen plan and runtime. **[D] P-14** per-route duration policy. **[L]** observe real prepare, submit, status and registration durations on staging; do not infer them.
- **Request framing.** **[R]** the 256 KiB ceiling is enforced by the gate on the declared `Content-Length` and by `proxyClientMaxBodySize`; a larger declared length is refused. **[P / L]** the platform and CDN must forward `Content-Length` and must not buffer or rewrite bodies; test HTTP/2 and HTTP/3; test Firefox and Safari; measure real passkey registration payloads (the docs record a 64 KiB WebAuthn registration limit never measured on real authenticators).
- **Cookies.** **[R]** `ocf_real_session`: HttpOnly, `SameSite=Lax`, `Secure` only when `NODE_ENV=production`, 7-day lifetime, not a `__Host-` cookie. **[D] P-15** whether to move to `__Host-`. **[L]** confirm in a real browser that the attributes arrive as expected through the hosting layer.
- **Headers.** **[R]** only `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`. No HSTS from the app (left to the host). **[P]** whether the platform adds HSTS. **[D] P-15** HSTS decision.
- **Script CSP.** **[R]** none exists. S5 records a full script CSP as required before any non-testnet or public deployment; it is therefore a **G2 prerequisite**, not a G0 one, and staging must not be described as having it.
- **[R]** A client-side build-time value (`NEXT_PUBLIC_*`) is fixed by the build, so each rebuild for staging must carry exactly the staging values.

## K. Evidence required before enabling Real

All of this is **[L]**, recorded in the git-ignored `evidence/` folder (or the operator's private store), none pasted into docs:

1. Written authorization for the specific step (§N), with its bounds.
2. Protection coverage matrix from §C, from outside the operator's network, with status codes.
3. Hostname, RP ID and origin recorded; a build proven to carry the staging values; DNS and TLS in place.
4. Proof the deployment, with Real off and no secrets, serves only Practice and returns 404 on `/api/real/**` (through protection).
5. New Neon endpoint differs from the development endpoint; the database was empty; the rehearsal on a disposable database passed; the digest check for each applied block matched; read-only catalog verification passed; seed rows present.
6. Names-only configuration inventory showing only staging resources; no `REAL_ADMIN_*`, `REAL_SMOKE_*` or `NEON_BRANCH_*` in hosting; no development credential.
7. Turnkey staging parent, its root quorum and a tested recovery path; Pimlico and RPC staging keys; spend ceilings and alerts set.
8. A rehearsed kill switch (§M).
9. A named operator, a named reviewer and an agreed stop list.

## L. Testnet end-to-end verification matrix (G0 → G1)

Run only on staging, only by the operator, only with testnet Cash, only after §K. Each row records: date, build id, account, observed result, evidence reference. Expected results come from the repository; any deviation is a finding, not a retry.

| # | Scenario | Expected (from repository) | Notes |
|---|---|---|---|
| L1 | New registration | Registration start admitted by the 3C-1 pool; a passkey is created for the staging RP ID; a Turnkey child organization and wallet are created once; the account ends `active` only through finalize; session cookie set | One dispatch row with exact request evidence. A failure mid-way must **not** be retried by hand; an uncertain create stays "needs review" (never auto-adopted). |
| L2 | Login | Fresh passkey assertion, single-use login marker recorded (3C-2), session issued | A second use of the same challenge is refused. |
| L3 | Handle claim | One permanent lowercase `@name` (3–20 chars) after a fresh passkey confirmation; never changed or released | Handles are immutable; use a staging-only name pattern, assume it is consumed forever on this database. |
| L4 | Safe identity | The account's Safe address is derived and stored; the Turnkey owner address is never offered as a destination | Compare the shown address to an independent derivation. **There is no Receive screen** [R]: the address is in an account-details expander next to the owner address. Record that as a UX finding. |
| L5 | Funding | Testnet Cash sent **only** to the Safe address | **[P]** the faucet and its limits. Never fund the owner address. |
| L6 | Balance | Cash balance reads through the chain-read budget; a read failure shows an error, never zero | Check the 3A budget behavior on rapid refresh ("checking a bit often"). |
| L7 | First Pay from an undeployed Safe | Prepare re-checks balance and chain clock, builds the UserOperation with the Safe's factory fields, the browser rebuilds and compares calldata before the single passkey prompt, bundler accepts, status reaches `confirmed` | **[R]** the L-1a live observation covered one deployed Safe; this path has no recorded live observation under the current validators. **[L]** this row is a required G1 item. |
| L8 | Pay by `@handle` | Server re-resolves the handle to the Safe at prepare; history shows the handle and name | Wrong or unknown handle returns the same "couldn't find" result. |
| L9 | Pay by address | Address validated; payment confirmed; history shows the address | Also the first exit-path evidence (see L15). |
| L10 | Receipt and reconciliation | Status moves through awaiting authorization → submitted → confirmed; transaction link opens the Base Sepolia explorer; reload resumes the same state; "no money moved" is concluded only from finalized chain state | Observe, do not force. |
| L11 | Cancel and uncertain outcomes | Cancel before signing frees the slot; the client waits are bounded (Prepare 60 s, Cancel 45 s, Submit 60 s); an uncertain result never triggers an automatic retry, prepare, signing or cancel | Observation only. **Fault injection and forced timeouts on staging are not authorized by this runbook.** A prepared row has no automatic expiry (L-2 E) and can block that account; plan a throwaway account for this row. |
| L12 | Backup passkey | Fresh step-up with the current passkey, then second passkey registered; both sign in; removal needs the other passkey and completes only after confirmed absence | Enrollment and removal use Turnkey writes; an uncertain one is never replayed automatically (except the single recorded backup-create replay). |
| L13 | Second-device login and authorization | Login on a second device with the backup (or a synced passkey); a payment there is approved by that credential, attributed to it | **[P / L]** passkey sync behavior across the operator's devices and managers is outside the app. |
| L14 | Revocation and sign out everywhere | Removing a passkey blocks its later use; "Sign out everywhere" ends every session; an in-flight submit may still complete with its own approval | The session epoch ends sessions, not in-flight approvals [R]. |
| L15 | Exit feasibility | (a) Move the whole Cash balance to an address the operator controls, through the app. (b) **Independent exit:** document, without executing, what a user holding only their passkey could do if this app were unavailable | (a) is a testnet check. (b) is the WS-2 research question and **is not answered by this repository**: it depends on Turnkey parent/child authority and what a passkey can sign without our server. Gate G2 requires the answer. |

Also record, as findings and not as pass/fail: that no sponsorship ceiling exists in code, the copy shown to a person during uncertain states, and the time every step took.

## M. Stop conditions and rollback

**Stop immediately and do not continue the step, when any of these is true:** any staging URL, alias or `/api/real/**` path is reachable without the protection; a secret appears in a log, response, repo file or chat; the connected database endpoint is not the new one; any block's digest does not match; the RPC reports a chain id other than 84532 or cannot serve `finalized`; an unexpected provider charge or a rising spend alert; more than one active payment or any duplicate payment; a payment state the app cannot explain; a Turnkey create whose outcome is uncertain; the flag, origin or RP ID in the build differs from the record; the kill switch fails its rehearsal; the reviewer or operator is unavailable.

**Rollback ladder** (use the lowest rung that is enough; record each):

1. Set `NEXT_PUBLIC_REAL_MODE_ENABLED` false and redeploy (the app answers 404 on every Real route; stored rows are untouched).
2. Revoke the Pimlico key at the provider (stops sponsored sends).
3. Revoke the Turnkey staging API key at the provider (stops provisioning and reconcile reads).
4. Rotate `REAL_SESSION_SECRET` (signs everyone out).
5. Remove `DATABASE_URL` from the hosting configuration; with Real off nothing reads it.
6. Tighten or remove the hosting project's access, per the §C mechanism.

**What rollback cannot undo:** Turnkey child organizations already created; handles already claimed (immutable, never recycled); passkeys already registered; on-chain transactions; sponsored spend. The staging database is abandoned rather than cleaned — no deleting, truncating or "tidying" rows to hide an incident. An uncertain payment, provisioning dispatch, passkey forward or database write is investigated with authoritative evidence and an explicit operator procedure, never blindly retried.

## N. Future operator authorization requests

Each request is a separate, bounded, written decision. None exists yet. A grant never carries over to the next.

| ID | Request | Would authorize | Excludes |
|---|---|---|---|
| **AR-1** | Provider documentation research | Reading current public documentation (hosting protection, duration, env handling, pricing; Neon branching, retention, pricing; Turnkey authority and pricing; Pimlico policies and caps; Base mainnet identity) and writing a research record, no accounts | Creating any account, project or resource; any credential |
| AR-2 | Decisions P-1, P-2, P-3, P-13, P-14 | Recording the hostname, protection mechanism, database plan, bootstrap procedure and duration policy | Any live action |
| AR-3 | Hosting project with Real off, no secrets, protection on | One project, the public values only, §C and §D steps 1–2, and the coverage matrix | Any credential, database, provider |
| AR-4 | Disposable bootstrap rehearsal | One brand-new disposable Neon database, §F rehearsal, evidence, then abandoned | The development database; the staging database |
| AR-5 | Create and bootstrap the staging database | New Neon database, apply in order with digest checks, read-only verification | Provider credentials; Real on |
| AR-6 | Turnkey staging parent and recovery test | New parent organization, root quorum, tested recovery | Reusing the development parent |
| AR-7 | Pimlico and RPC staging keys with caps and alerts | Keys restricted to Base Sepolia | Any mainnet key |
| AR-8 | First Real-on build for the operator only | One build with staging values; one operator registration (L1–L4) | Funding; any tester |
| AR-9 | Testnet funding and matrix L5–L15 | Testnet Cash to one Safe; the matrix; kill-switch rehearsal | Forced faults; mainnet |
| AR-10 | G0 / G1 review | An independent combined review of the evidence and a written gate decision | G2 or anything mainnet |

Mainnet read-only verification, funding, payments, ownership or authority changes, and any external invitation each need their own request after G1; they are out of scope here.

## O. Consolidated open lists

**Provider facts to research (AR-1) [P]:** hosting protection modes, scope and plan; function duration; environment-variable handling and secrecy; platform HSTS, CDN caching and `Content-Length` forwarding; shared-domain RP ID suitability; Neon branch semantics, retention, restore, roles, pricing; Turnkey authority, pricing, limits, behavior if the RP ID changes, and what a passkey can sign without our server; Pimlico caps, restrictions, sponsorship on Base Sepolia and mainnet; RPC `finalized` support, quotas and key restrictions; Circle testnet faucet limits; Base mainnet token and contract identity (later).

**Decisions (see the ledger §7):** P-1 to P-6, P-13, P-14, P-15 for staging; P-7 to P-12, P-16, P-17 later.

**Live verification outstanding [L]:** everything in §C, §D 2, §E, §F rehearsal, §G verification, §H inventory, §J observations, §K, §L and the kill-switch rehearsal. None has been performed.
