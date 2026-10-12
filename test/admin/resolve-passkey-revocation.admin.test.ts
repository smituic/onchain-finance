import { describe, expect, it } from "vitest";
import { ADMIN_RUNNERS, requireAdminTarget, requireApprovedTurnkeyConfig, requireApprovedTurnkeyHost, requireCommitDecision, requireCommitOutcome } from "./admin-target";

/**
 * MANUAL, LIVE OPERATOR RUNNER (Slice S3) — never runs in normal
 * `pnpm test`/CI. Resolves exactly ONE blocked passkey removal using the R2a
 * evidence model (lib/real/server/passkey-revocation-resolver.ts). Turnkey
 * access is read-only (getActivities / getActivity / getUsers /
 * getAuthenticators through a four-method port); nothing is ever sent,
 * signed, or forwarded to Turnkey.
 *
 * DRY RUN BY DEFAULT: every read and check runs and the report is printed,
 * but the database is not written. The one database write — the dedicated,
 * account-locked resolution commit — happens only with an explicit second
 * opt-in, REAL_ADMIN_RESOLVE_COMMIT=1, and the commit run redoes every read
 * itself (a previous dry run's output is never reused).
 *
 * A COMMIT needs, besides REAL_ADMIN_RESOLVE_COMMIT=1, a confirmation naming
 * this runner, the target, and the one operation (a commit flag alone — for
 * instance one left set from an earlier run — is refused, not honored):
 *   REAL_ADMIN_COMMIT_CONFIRMATION=resolve-passkey-revocation:<endpoint id>/<database>:<app user id>:<revocation attempt id>
 *
 * OPERATOR SAFETY (Milestone 0; test/admin/admin-target.ts). This runner may
 * target the real database, so it runs ONLY when, in the same command:
 *   - its primary gate is exactly 1;
 *   - DATABASE_URL is given explicitly (never taken from .env.local);
 *   - REAL_ADMIN_EXPECTED_ENDPOINT_ID and REAL_ADMIN_EXPECTED_DATABASE_NAME
 *     equal that URL's endpoint id and database name exactly — read both
 *     from the Neon dashboard, not out of the URL;
 *   - no REAL_SMOKE_* or NEON_BRANCH_* variable, and no REAL_ADMIN_*
 *     variable other than this runner's own, is set;
 *   - TURNKEY_API_BASE_URL is unset or exactly the approved host.
 * With the primary gate set, anything missing or mismatched FAILS the run
 * (it is never skipped green), before any database or Turnkey call.
 * Pass every variable inline on ONE command that names ONLY this file. Do
 * not `export` gates or commit flags: an exported gate also arms this runner
 * during an unrelated whole-suite `pnpm test`, which no check here can see.
 *
 * A COMMIT THAT DOES NOT COMMIT FAILS THE RUN. If REAL_ADMIN_RESOLVE_COMMIT=1
 * was accepted but the report says committed=false, the report is still
 * printed in full and the run then exits nonzero, saying which it was:
 * already resolved before this run (a no-op, not a new write and not a data
 * error), a state that is uncertain or changed underneath the run (read
 * again first), or a commit the evidence did not allow. Nothing is retried.
 *
 * There is deliberately NO force/trust/skip/mark-revoked option, no
 * credential-id-only mode, and no bulk/sweep mode: exactly one app user id
 * and one revocation attempt id per run. The operator supplies identifiers
 * only — never evidence.
 *
 * Required environment:
 *   REAL_ADMIN_RESOLVE_PASSKEY_REVOCATION=1   explicit opt-in
 *   REAL_ADMIN_APP_USER_ID=<uuid>             the account
 *   REAL_ADMIN_REVOCATION_ATTEMPT_ID=<uuid>   the BLOCKED attempt to resolve
 *   DATABASE_URL                              target Neon database
 *   TURNKEY_PARENT_ORGANIZATION_ID, TURNKEY_API_PUBLIC_KEY,
 *   TURNKEY_API_PRIVATE_KEY                   parent key, read-only use here
 * Also read by readRealServerConfig and therefore required, though unused
 * here: REAL_SESSION_SECRET, NEXT_PUBLIC_REAL_RP_ID, NEXT_PUBLIC_REAL_ORIGIN,
 * PIMLICO_API_KEY. TURNKEY_API_BASE_URL: leave unset (or exactly the approved host).
 *   REAL_ADMIN_EXPECTED_ENDPOINT_ID=ep-...    the endpoint, from the Neon dashboard
 *   REAL_ADMIN_EXPECTED_DATABASE_NAME=...     the database, from the Neon dashboard
 * Optional:
 *   REAL_ADMIN_RESOLVE_COMMIT=1               actually commit (unset = dry run; any other value is refused)
 *   REAL_ADMIN_COMMIT_CONFIRMATION=...        required with the commit flag (see above)
 *
 *   REAL_ADMIN_RESOLVE_PASSKEY_REVOCATION=1 REAL_ADMIN_APP_USER_ID=... REAL_ADMIN_REVOCATION_ATTEMPT_ID=... \
 *     DATABASE_URL=... REAL_ADMIN_EXPECTED_ENDPOINT_ID=ep-... REAL_ADMIN_EXPECTED_DATABASE_NAME=... <turnkey/app env> \
 *     pnpm exec vitest run test/admin/resolve-passkey-revocation.admin.test.ts
 *
 * Prints only the outcome, a reason code, and truncated identifiers — never
 * env values, keys, request bodies, or stamps.
 */
const RUNNER = ADMIN_RUNNERS.resolve;
const enabled = process.env.REAL_ADMIN_RESOLVE_PASSKEY_REVOCATION === "1";

describe.skipIf(!enabled)("ADMIN: resolve ONE blocked passkey removal (R2a, read-only Turnkey, dry run unless REAL_ADMIN_RESOLVE_COMMIT=1)", () => {
  it("terminalizes the attempt only on complete R2a evidence; otherwise changes nothing", async () => {
    // Refusals first: nothing below this block can reach a database or Turnkey until the target and environment are confirmed.
    const target = requireAdminTarget({ env: process.env, runner: RUNNER });
    requireApprovedTurnkeyHost({ env: process.env, runner: RUNNER });
    const appUserId = process.env.REAL_ADMIN_APP_USER_ID ?? "";
    const revocationAttemptId = process.env.REAL_ADMIN_REVOCATION_ATTEMPT_ID ?? "";
    const commit = requireCommitDecision({ env: process.env, runner: RUNNER, target, operation: [appUserId, revocationAttemptId] });

    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const { requireRealServerConfig } = await import("@/lib/real/server/config");
    const { createReadOnlyTurnkeyLedger, redactReport, resolveBlockedRevocation } = await import("@/lib/real/server/passkey-revocation-resolver");
    const { createNeonRevocationResolutionStore } = await import("@/lib/real/server/passkey-revocation-resolution-store");

    const config = requireRealServerConfig();
    requireApprovedTurnkeyConfig({ config, runner: RUNNER });
    const report = await resolveBlockedRevocation({
      // S5 (L4): the commit's account lock relies on READ COMMITTED — pinned by createNeonSqlClient.
      store: createNeonRevocationResolutionStore(createNeonSqlClient(target.url)),
      ledger: createReadOnlyTurnkeyLedger(config),
      appUserId,
      revocationAttemptId,
      commit,
    });
    console.log(JSON.stringify({ mode: commit ? "COMMIT" : "DRY RUN", endpoint: target.endpoint, database: target.database, ...redactReport(report) }, null, 2));
    // A dry run can never have written anything.
    expect(report.committed).toBe(commit && report.outcome === "resolved");
    // A requested commit that committed nothing is NOT a success: the report above stays printed, and this throws
    // (nonzero exit), naming the outcome and whether it was already resolved, uncertain, or declined. Nothing is retried.
    requireCommitOutcome({ runner: RUNNER, commit, report });
  });
});
