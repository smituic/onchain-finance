import { describe, expect, it } from "vitest";

/**
 * MANUAL, LIVE OPERATOR RUNNER (Provisioning Evidence Capture) — never runs
 * in normal `pnpm test`/CI. Observes exactly ONE provisioning dispatch:
 * reads the activity whose id is ALREADY STORED on that dispatch row, by
 * that exact id, in the stored parent organization
 * (lib/real/server/provisioning-activity-poller.ts), compares it with the
 * stored request evidence, and reports.
 *
 * RECORD-ONLY. Turnkey access is one read-only get_activity; nothing is
 * listed, searched, sent, re-sent, or re-stamped. No registration attempt,
 * account, passkey, or session is ever changed — an uncertain create stays
 * "needs review" whatever this observes (Option 3). The only possible
 * write is the observation on the dispatch row itself.
 *
 * DRY RUN BY DEFAULT: the read and comparison run and the report is
 * printed, but the database is not written. The observation is recorded
 * only with an explicit second opt-in, REAL_ADMIN_POLL_COMMIT=1.
 *
 * There is deliberately NO activity-id parameter (the id comes from the
 * row, never from the operator), no force/adopt/resolve option, and no
 * bulk/sweep mode: exactly one credential id (and optionally one dispatch
 * sequence number; default: that attempt's newest dispatch) per run.
 *
 * Required environment:
 *   REAL_ADMIN_POLL_PROVISIONING_ACTIVITY=1   explicit opt-in
 *   REAL_ADMIN_CREDENTIAL_ID=<credential id>  the registration attempt
 *   DATABASE_URL                              target Neon database
 *   TURNKEY_PARENT_ORGANIZATION_ID, TURNKEY_API_PUBLIC_KEY,
 *   TURNKEY_API_PRIVATE_KEY                   parent key, read-only use here
 * Also read by readRealServerConfig and therefore required, though unused
 * here: REAL_SESSION_SECRET, NEXT_PUBLIC_REAL_RP_ID, NEXT_PUBLIC_REAL_ORIGIN,
 * PIMLICO_API_KEY. Optional: TURNKEY_API_BASE_URL.
 * Optional:
 *   REAL_ADMIN_DISPATCH_SEQ=<n>               a specific dispatch of that attempt
 *   REAL_ADMIN_POLL_COMMIT=1                  record the observation (anything else = dry run)
 *
 *   REAL_ADMIN_POLL_PROVISIONING_ACTIVITY=1 REAL_ADMIN_CREDENTIAL_ID=... \
 *     DATABASE_URL=... <turnkey/app env> \
 *     pnpm exec vitest run test/admin/poll-provisioning-activity.admin.test.ts
 *
 * Prints only the outcome, a reason code, verdicts, and truncated
 * identifiers — never env values, keys, request bodies, or stamps.
 */
const enabled = process.env.REAL_ADMIN_POLL_PROVISIONING_ACTIVITY === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("ADMIN: observe ONE provisioning dispatch by its stored activity id (read-only Turnkey, dry run unless REAL_ADMIN_POLL_COMMIT=1)", () => {
  it("records at most an observation on the dispatch row; never changes an attempt, account, passkey, or session", async () => {
    const { createNeonRegistrationAttemptStore, createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const { requireRealServerConfig } = await import("@/lib/real/server/config");
    const { createProvisioningActivityPort, pollProvisioningDispatch, redactPollReport } = await import("@/lib/real/server/provisioning-activity-poller");

    const config = requireRealServerConfig();
    const commit = process.env.REAL_ADMIN_POLL_COMMIT === "1";
    const rawSeq = process.env.REAL_ADMIN_DISPATCH_SEQ?.trim();
    const report = await pollProvisioningDispatch({
      store: createNeonRegistrationAttemptStore(createNeonSqlClient(process.env.DATABASE_URL!)),
      port: createProvisioningActivityPort(config),
      parentOrganizationId: config.turnkeyParentOrganizationId,
      credentialId: process.env.REAL_ADMIN_CREDENTIAL_ID?.trim() ?? "",
      dispatchSeq: rawSeq ? Number(rawSeq) : undefined,
      commit,
    });
    console.log(JSON.stringify({ mode: commit ? "COMMIT" : "DRY RUN", ...redactPollReport(report) }, null, 2));
    // A dry run can never have written anything.
    if (!commit) expect(report.committed).toBe(false);
  });
});
