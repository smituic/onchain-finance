import { describe, expect, it } from "vitest";

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
 * PIMLICO_API_KEY. Optional: TURNKEY_API_BASE_URL.
 * Optional:
 *   REAL_ADMIN_RESOLVE_COMMIT=1               actually commit (anything else = dry run)
 *
 *   REAL_ADMIN_RESOLVE_PASSKEY_REVOCATION=1 REAL_ADMIN_APP_USER_ID=... REAL_ADMIN_REVOCATION_ATTEMPT_ID=... \
 *     DATABASE_URL=... <turnkey/app env> \
 *     pnpm exec vitest run test/admin/resolve-passkey-revocation.admin.test.ts
 *
 * Prints only the outcome, a reason code, and truncated identifiers — never
 * env values, keys, request bodies, or stamps.
 */
const enabled = process.env.REAL_ADMIN_RESOLVE_PASSKEY_REVOCATION === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("ADMIN: resolve ONE blocked passkey removal (R2a, read-only Turnkey, dry run unless REAL_ADMIN_RESOLVE_COMMIT=1)", () => {
  it("terminalizes the attempt only on complete R2a evidence; otherwise changes nothing", async () => {
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const { requireRealServerConfig } = await import("@/lib/real/server/config");
    const { createReadOnlyTurnkeyLedger, redactReport, resolveBlockedRevocation } = await import("@/lib/real/server/passkey-revocation-resolver");
    const { createNeonRevocationResolutionStore } = await import("@/lib/real/server/passkey-revocation-resolution-store");

    const commit = process.env.REAL_ADMIN_RESOLVE_COMMIT === "1";
    const report = await resolveBlockedRevocation({
      // S5 (L4): the commit's account lock relies on READ COMMITTED — pinned by createNeonSqlClient.
      store: createNeonRevocationResolutionStore(createNeonSqlClient(process.env.DATABASE_URL!)),
      ledger: createReadOnlyTurnkeyLedger(requireRealServerConfig()),
      appUserId: process.env.REAL_ADMIN_APP_USER_ID ?? "",
      revocationAttemptId: process.env.REAL_ADMIN_REVOCATION_ATTEMPT_ID ?? "",
      commit,
    });
    console.log(JSON.stringify({ mode: commit ? "COMMIT" : "DRY RUN", ...redactReport(report) }, null, 2));
    // A dry run can never have written anything.
    expect(report.committed).toBe(commit && report.outcome === "resolved");
  });
});
