# Independent Turnkey PoC security and architecture audit

Date: 2026-09-20. Branch: `poc/turnkey-real-account`.

Scope: the actual dirty working tree, including untracked PoC implementation/tests, the tracked application/configuration diff, lockfile changes, and the installed Turnkey, permissionless, and viem code relevant to authorization and submission. The existing working tree was preserved. No reset, revert, stash, commit, push, credential creation, provisioning, funding, Turnkey signing request, or live transaction submission was performed. All newly added signing/submission tests use offline keys and in-process transports.

The supplied live transaction, balances, organization configuration, and browser-restart observations remain operator-provided evidence. This audit did not re-run those live experiments or independently query that wallet's current Turnkey/chain state. Code correctness and offline verification must not be confused with a new live attestation.

**Decision:** suitable for a local, isolated testnet PoC checkpoint with the limitations below recorded. Public deployment with the PoC enabled is blocked. The normal `pnpm build` remains environment-blocked; the Webpack production build passed with a dependency warning. This is not an unconditional all-checks-green sign-off.

## A. Findings by severity

### BLOCKER

No unresolved cryptographic/authority blocker was found for the inspected local PoC execution path. The requested default production build could not complete because Turbopack's CSS worker was denied permission to bind a local port, including on the escalation rerun. This blocks a claim that every requested verification passed, rather than proving an application build defect.

### HIGH

**H1 — Fixed: submission uncertainty could become retryable failure.** `classifyPaymentError()` in [payment-error.ts](lib/poc/turnkey/payment-error.ts) previously classified any HTTP response status as an explicit rejection. A gateway can return 502/504 after the upstream accepted the operation. `sendPayment()` in [poc-ui.tsx](app/dev/turnkey-poc/poc-ui.tsx) also applied the signing-error classifier to failures after receiving a userOperationHash, such as a storage-audit failure, marking them `failed` and unlocking Send. HTTP-only failures now remain uncertain; only recognized bundler rejections with a JSON-RPC error are terminal. Once a hash is acknowledged, subsequent local failures retain that hash and remain unresolved. Offline regression tests reproduced the HTTP misclassification before the fix and exercise the actual UI post-submission path after it.

**H2 — Open; blocks public enabled deployment: provisioning and sponsorship abuse.** [provision/route.ts](app/api/dev/turnkey-poc/provision/route.ts) accepts unauthenticated registrations and creates child organizations. It lacks access/rate limits and server-issued challenge/origin binding. [proxyPimlicoRequest()](lib/poc/turnkey/server/pimlico.ts) allows methods but forwards arbitrary method parameters; it does not bind sender, EntryPoint, token, recipient, amount, or quota to the session's account. An attacker can provision their own session and use the application's sponsorship/provisioning resources. The fixed network URL limits the upstream to Base Sepolia; it does not limit sponsorship to the intended Safe or 0.10 USDC transfer. Dashboard restrictions in `.env.example` are instructions, not verified enforcement. `isTurnkeyPocEnabled()` checks the public flag only, including in production. Keep the enabled route private/local; public use needs access controls and server-side sponsorship constraints.

### MEDIUM

**M1 — Fixed: signed request data could be persisted in error metadata.** The uncertainty branch of `classifyPaymentError()` interpolated `UserOperationExecutionError.message`. Installed viem includes the entire operation and signature in that message. `persistPending()` saves `lastError` to both active-operation and history storage. This was an already-authorized operation replay capability, not a reusable wallet key, but contradicted the intended public-metadata-only storage claim. The branch now retains a short transport cause, never the enclosing signed-request dump. Existing browser history was not erased or rewritten during this audit.

**M2 — Fixed: malformed reconciliation evidence could be confirmed.** [reconcile/route.ts](app/api/dev/turnkey-poc/reconcile/route.ts) previously interpreted missing `success`/receipt status as success and accepted a different returned hash. It now requires the requested hash, a boolean user-operation success, a valid transaction hash, a recognized receipt status, and an HTTP-success response before returning a terminal result. The UI preserves a previously observed terminal receipt when a later lookup is unavailable. This remains a bundler-trusting receipt lookup, not an independent on-chain transfer verifier.

**M3 — Fixed: recovery simulation could overwrite an unresolved real operation.** `findSourceForSimulatedRecovery()` in [recovery-harness.ts](lib/poc/turnkey/recovery-harness.ts) formerly selected an older confirmed history entry even when the active payment was unresolved. Simulating and reconciling that historical entry could replace the active send-blocking pointer. It now refuses simulation while an unresolved operation exists.

**M4 — Open: Gate 1 diagnostics overstate what they establish.** `runBackendNegativeTests()` in [server/turnkey.ts](lib/poc/turnkey/server/turnkey.ts) marks every exception as `failedAsExpected`, including network failures, invalid requests, and resource lookup errors. Its raw-sign test supplies a one-byte payload, so a payload validation failure is not proof of authorization denial. The route also hardcodes `backendCanIndependentlyTransfer: false`, regardless of results. These mutation probes can really add a key/export a wallet if unexpectedly authorized; they were not invoked during this audit. Use explicit authorization-denied outcomes, otherwise report inconclusive; inspect existing actual responses rather than blindly re-running mutation probes.

`evaluateSecurityGate()` in [security-gate.ts](lib/poc/turnkey/security-gate.ts) does not require the cancellation or negative tests to have run. It accepts more than one authenticator. `inspectChildOrganization()` accepts `expectedUserId` but does not compare it to root membership, and it does not inspect policies or recovery-feature state. `reportExecutedPath()` in [executed-path.ts](lib/poc/turnkey/executed-path.ts) records stamper construction, not successful stamping; its forbidden-path fields are constants. The UI's Gate 1 PASS is partial local evidence, not a complete security certificate, and does not gate Send. The inspected code's actual authority boundary is stronger evidence than those flags.

**M5 — Open: client public configuration is not correctly inlined.** [readPublicTurnkeyPocConfig()](lib/poc/turnkey/config.ts) defaults its argument to `process.env` and reads public keys via that alias. The production browser chunk retains these lookups, including `NEXT_PUBLIC_TURNKEY_RP_ID`, rather than the configured values. Next's browser environment object does not populate them. Localhost/default RPC works; custom host/RP/RPC deployments can silently use localhost/defaults. Use direct `process.env.NEXT_PUBLIC_*` references when building the default object, retaining the injected argument for unit tests. This was documented rather than changing deployment configuration during the audit.

**M6 — Open PoC limits: recovery coordination and provenance.** Pending/history storage in [public-state.ts](lib/poc/turnkey/public-state.ts) is a single origin-wide pointer, not account-keyed or coordinated across tabs. The UI has no `storage` listener/cross-tab lock. Reload does not auto-send, but two open tabs are not a global duplicate-payment guard. `clearUnresolvedPayment()` is an explicit manual escape hatch, not proof the transfer never occurred. `readUsdcHistory()` in [server/chain.ts](lib/poc/turnkey/server/chain.ts) covers only the last 50,000 blocks, so an empty history is not proof of lifetime non-execution. The UI also restores local identifiers without fully matching the cookie's organization/wallet identifiers, and logout leaves in-memory history until remount. Broader account switching/recovery needs stronger binding; the tested single-account flow does not establish it.

### LOW

**L1 — Fixed: fresh-runtime Gate 1 false FAIL.** [describeGate1Banner()](lib/poc/turnkey/gate-banners.ts) recognized only the missing harmless-sign probe. A fresh runtime also resets the constructed-stamper marker, producing a second reason. Both are now recognized as absent runtime evidence, only when identity exists and probes have not run. Any additional authority violation still produces FAIL. The security evaluator itself was not relaxed; no historical PASS was fabricated.

**L2 — Fixed: stale recovery wording and Send availability.** [poc-ui.tsx](app/dev/turnkey-poc/poc-ui.tsx) now describes the simulation's origin and says when reconciliation restored the confirmed receipt. It no longer claims the receipt is currently cleared after confirmation. Send is disabled during busy actions and has an in-flight guard against repeated same-component invocation.

**L3 — Fixed: permissive recovery-bit parsing.** [serializeTurnkeyRawSignature()](lib/poc/turnkey/raw-signature.ts) mapped every nonzero `v` to 28. Turnkey's expected format is yParity 0/1; other values now throw. Both recovery checks already prevented an incorrect signature from reaching submission, so this was malformed-response hardening rather than a demonstrated signing bypass.

**L4 — Open diagnostic limitations.** [storage-audit.ts](lib/poc/turnkey/storage-audit.ts) inspects storage names, not contents, and reports an empty IndexedDB list when enumeration is unavailable. Unknown names receive `review` but do not fail the storage gate. `inspectSafe()` in [account.ts](lib/poc/turnkey/account.ts) checks bytecode presence and reports configured owner/threshold/module/version; it does not read those settings from the deployed Safe. The negative/replay diagnostic routes also need a narrower exposure model before public deployment; the replay route permits arbitrary Turnkey paths and checks hostname without requiring HTTPS. No parent credential is attached to replay requests.

## B. Signing-path verdict — PASS for the inspected financial path

`createVerifiedTurnkeyOwnerAccount().signTypedData()` hashes the supplied definition with viem `hashTypedData`, sends that exact digest to `signDigestViaTurnkeyRaw()`, and recovers against the original typed data before returning. The raw helper sends hexadecimal payload encoding and `HASH_FUNCTION_NO_OP`, preserving `ownerAddress` case in `signWith`. This matches the [Turnkey raw-sign API](https://docs.turnkey.com/api-reference/activities/sign-raw-payload).

`serializeTurnkeyRawSignature()` parses and pads each r/s component to 32 bytes, maps yParity 0/1 to 27/28, and rejects unexpected parity. There is no extra Ethereum personal-message prefix or second digest hash in this path. The WebAuthn stamper's SHA-256 of the JSON request is a separate authorization challenge; it does not replace the EIP-712 digest being signed.

`verifySafeOpSignature()` independently reconstructs typed data from the prepared operation, parses the packed 6-byte validAfter + 6-byte validUntil + 65-byte owner signature, checks plain-ECDSA v, and recovers the expected owner. Its field order/types, domain and packed validity layout match the [Safe4337Module 0.3.0 source](https://raw.githubusercontent.com/safe-global/safe-modules/4337/v0.3.0/modules/4337/contracts/Safe4337Module.sol). `digestsMatch` is diagnostic rather than an explicit submission gate, but successful recovery over the independently reconstructed digest provides the substantive check.

No application mutation of the operation between signing/preflight/submission was found. The known broken adapter remains only for optional diagnostic comparison and inherited non-financial methods; the actual SafeOp financial path uses the override. This audit did not re-prove the vendor adapter defect live.

## C. Persistence and authority verdict — PASS for code architecture; live state remains supplied evidence

`provisionChildSubOrganization()` requests one root user, threshold 1, one attested authenticator, no API keys/OAuth, one Ethereum wallet account, and disabled email/SMS/OTP auth/recovery features. The parent key is not installed on the child. The [Turnkey sub-organization model](https://docs.turnkey.com/features/sub-organizations) grants the parent read-only visibility; it does not inherit child signing/root control. No application code introduces a delegated/session signer.

`createPasskeyTurnkeyClient()` and the installed `WebauthnStamper.stamp()` reach `navigator.credentials.get` for each raw-sign request with `userVerification: required`; `TurnkeyClient.request()` awaits stamping before fetch. Cancellation therefore precedes signing/submission. UV enforcement by the browser is requested; independent enclave enforcement of UV=1 is not established here, as the existing UI disclosure correctly states.

`writePocSession()` sets HttpOnly, SameSite=Lax, Secure in production, and stores HMAC-authenticated public identifiers. Possession alone does not sign the child wallet. It does grant application/proxy access; it should not be described as authority-free in an unrestricted deployment. The signed payload lacks a server-checked expiry, so browser maxAge is not a server replay deadline.

Normal public-account/pending/history persistence contains identifiers, hashes, status and diagnostics, not private keys or reusable signing credentials. The signed-error dump exception was fixed. No configured server secret value was found in 205 Git candidate files or 54 generated browser-static assets. `.env.local` remains Git-ignored. This value scan is evidence for these configured secrets, not an exhaustive proof against every possible future leak.

## D. Safe/ERC-4337 verdict — PASS with an SDK preparation nuance

`createPocSafeAccount()` pins Safe 1.4.1, the single owner, threshold 1, saltNonce 0, Safe4337Module 0.3.0 at `0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226`, EntryPoint 0.7 at `0x0000000071727De22E5E9d8BAf0edAc6f37da032`, singleton/factory/module-setup addresses, and MultiSend setup. The installed permissionless initializer enables the module and installs it as fallback handler; setup payment defaults are zero. No additional owner/module/setup transaction is supplied by the application.

`sendSponsoredCashTransfer()` prepares one zero-native-value Circle test-USDC transfer on Base Sepolia, including sponsorship/factory/gas data, before requesting financial signing. Stub signatures are local estimation data. Factory/factoryData and paymaster gas/data are included in SafeOp verification.

Installed viem `sendUserOperation()` DOES call `prepareUserOperation()` again when an account is supplied. Thus a literal claim of “no preparation helper after signing” is false. However, populated fees/nonce/gas/paymaster address/signature prevent re-estimation/re-sponsorship/re-signing in this configuration. The new [sdk-submission.test.ts](test/lib/poc/turnkey/sdk-submission.test.ts) uses real permissionless signing/packing and real viem preparation/formatting with an offline transport: all signed wire fields and the full signature are identical, for operations with and without factory data. There is exactly one submission transport invocation. Installed viem explicitly sets `retryCount: 0` for it. Pin/retest this invariant on SDK upgrades.

The initializer was source-reviewed; this audit did not independently attest the live Safe's owners, threshold, enabled modules or deployed bytecode/version through chain reads.

## E. Recovery/failure verdict — PASS for the corrected single-account, single-tab PoC

Cancellation or verified-signature failure propagates before `sendUserOperation`. Independent preflight failure also throws before submission. Recognized bundler rejections are terminal; ambiguous outcomes stay unresolved and block Send. Known-hash recovery uses only `eth_getUserOperationReceipt`, never preparation/signing/submission. Its route was exercised offline with repeated, missing, malformed, mismatched, unsuccessful and HTTP-failure responses.

The recovery harness consists of synchronous data transforms; it cannot sign or submit and now cannot replace an unresolved record. Reload restores public records and performs only session/inspection reads. No automatic resend was found. Repeated successful recovery is idempotent by record ID; transient subsequent failures retain previously observed terminal evidence. Manual clearing, cross-tab races, lost local storage, bundler trust and finite history remain explicit limitations; see M6.

## F. PoC isolation verdict — PASS in the current dependency graph

All new account/payment code is under `lib/poc/turnkey`, `app/dev/turnkey-poc`, and `app/api/dev/turnkey-poc`. No tracked change touches the Practice engine, production Real implementation, Pay/Home pages, or stores. The existing root layout now uses `AppFrame`, which retains `AppShell` for product routes and omits it on the PoC route. `StoreHydration` still runs at the root as before.

The page and every API handler check the PoC flag; disabled returns not-found/404. Page/layout declare noindex/nofollow. No product navigation link was added. Storage keys have a dedicated namespace. ESLint restricts PoC imports of Practice/stores, though it is not a complete bidirectional or relative-import security boundary. Default `.env.example` flag is false. “Dev-only” means flag-isolated here, not enforcement of NODE_ENV=development; see H2.

## G. Test-quality concerns

The original 497 count included the whole application's tests, not 497 independent Turnkey security checks.

- `payment.test.ts` mocked `signUserOperation` and `sendUserOperation`; it proved local ordering but could not prove viem's actual preparation/wire behavior. Its signer reused `SAFE_OP_EIP712_TYPES`, so a shared schema error could pass. The new real-SDK transport test reduces this gap; the contract source was independently compared.
- `verified-account.test.ts` and `raw-sign.test.ts` mock Turnkey and sign offline. They establish local hashing/recovery and request fields, not Turnkey authorization, browser biometric behavior, enclave UV policy, or the reported live adapter failure.
- `request-binding.test.ts` compares local objects. Its equality/mutation helpers are not the enforcement mechanism in the payment pipeline and do not test a real assertion replay.
- Negative-test errors, static executed-path flags, and name-only storage checks do not prove the strong claims discussed in M4/L4. `session.test.ts` checks HMAC behavior, not actual Set-Cookie attributes in a browser.
- Source-string assertions in `sign-probe.test.ts`, `verified-account.test.ts`, and `recovery-harness.test.ts` are limited regression fences, not exhaustive capability analysis.
- The original UI recovery tests mocked `/reconcile`; they did not execute the real route. The new route tests cover it offline. The old banner tests supplied only one ephemeral reason, missing the actual restart state; the added component test reproduces fresh-runtime evidence.
- `test/setup.ts` implements localStorage as an object of methods; `Object.keys(localStorage)` does not enumerate stored key names there as it does in a browser. These tests do not independently validate browser storage snapshots or full restart behavior.
- `account-metadata.test.ts` pins constants, not deployed contract state. `chain.test.ts` proves block window arithmetic, not complete historical transfer discovery. `status.test.ts` alone did not prove the UI used its terminal-state-preserving helper; it now does on reconciliation failure.

## H. Files changed during this audit

Implementation: `lib/poc/turnkey/gate-banners.ts` (both runtime-reset reasons); `lib/poc/turnkey/payment-error.ts` (conservative outcomes and no signed-request dump); `lib/poc/turnkey/raw-signature.ts` (strict yParity); `lib/poc/turnkey/recovery-harness.ts` (protect unresolved pointer); `app/api/dev/turnkey-poc/reconcile/route.ts` (validate receipt evidence); `app/dev/turnkey-poc/poc-ui.tsx` (retain acknowledged hash, prevent busy/repeated send, preserve terminal receipt, truthful simulation wording).

Tests updated: `test/lib/poc/turnkey/{gate-banners,payment-error,raw-signature,recovery-harness}.test.ts` and `test/app/dev/turnkey-poc/poc-ui.test.tsx`. Tests added: `test/lib/poc/turnkey/sdk-submission.test.ts` and `test/lib/poc/turnkey/reconcile-route.test.ts`. This report is also new. No package versions, environment configuration, core signing architecture, production feature code, or live state were changed by the audit.

## I. Final verification

| Check | Result |
| --- | --- |
| `pnpm test` | PASS: 523/523 tests, 66 files |
| `pnpm lint` | PASS |
| `pnpm exec tsc --noEmit` | PASS |
| `pnpm build` | BLOCKED by Turbopack CSS worker local-port permission error; same result on escalation rerun |
| `pnpm build --webpack` | PASS, with transitive ox dynamic-import warning and Node localStorage experimental warnings |
| `git diff --check` | PASS |
| Configured secret-value scan | No matches in Git candidates or generated browser-static files |

The lock diff was scanned across all 1,563 added and 21 removed lines; it adds the declared SDK dependency trees and peer resolutions, with no custom tarball, Git URL, local-link or override additions detected. Transitive IndexedDB/session SDK installation is not evidence of its execution. A complete dependency-CVE or supply-chain audit was not performed.

## J. Checkpoint / commit / push decision

**Local PoC checkpoint/commit: YES, with this audit's limitations retained.** The signing workaround is sound for the reviewed path; the identified submission/recovery defects have targeted fixes and offline coverage. Keep `.env.local` excluded.

**Push as an audit-green completed branch: conditional on a successful plain `pnpm build` in an environment that permits Turbopack's worker.** A code-only PoC push to a repository that does not deploy an enabled public PoC is distinct from production approval. **Public deployment with the flag enabled: BLOCK**, until H2 and the deployment/configuration limitations are addressed. No commit or push was performed.
