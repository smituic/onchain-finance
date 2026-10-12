import { describe, expect, it } from "vitest";
import { ADMIN_RUNNERS, requireAdminTarget, requireApprovedTurnkeyConfig, requireApprovedTurnkeyHost, requireCommitOutcome, requirePollCommitDecision } from "./admin-target";

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
 * A COMMIT needs, besides REAL_ADMIN_POLL_COMMIT=1, an EXPLICIT dispatch
 * sequence and a confirmation naming this runner, the target, and that one
 * dispatch (a commit flag alone — for instance one left set from an earlier
 * run — is refused, not honored):
 *   REAL_ADMIN_DISPATCH_SEQ=<n>
 *   REAL_ADMIN_COMMIT_CONFIRMATION=poll-provisioning-activity:<endpoint id>/<database>:<credential id>:<n>:quiescent
 *
 * A COMMIT THAT DOES NOT COMMIT FAILS THE RUN. If REAL_ADMIN_POLL_COMMIT=1
 * was accepted but the report says committed=false, the report is still
 * printed in full and the run then exits nonzero, saying which it was:
 * already processed before this run (the dispatch already has its terminal
 * observation — a no-op, not a new write and not a data error), a state
 * that is uncertain or changed underneath the run (read again first), or
 * a commit the evidence did not allow. Nothing is retried.
 *
 * The sequence is taken EXACTLY as given: a plain positive whole number
 * ("1"). Padding (" 1 "), a leading zero ("01"), or anything else is
 * refused, not tidied up.
 *
 * "LATEST" IS DRY-RUN ONLY. Without REAL_ADMIN_DISPATCH_SEQ the runner looks
 * at the attempt's newest dispatch, which is fine for looking around — but a
 * newer dispatch can appear between a dry run and a commit, and "latest"
 * would then mean a different one. So a commit without an explicit sequence
 * is refused, and a dry run of "latest" is NOT a preview for a commit.
 * Operator sequence:
 *   1. Identify the exact dispatch sequence.
 *   2. Dry run with REAL_ADMIN_DISPATCH_SEQ set to it.
 *   3. Review that dry run's evidence.
 *   4. Separately authorize the commit against the SAME explicit sequence.
 * An explicit sequence fixes which dispatch is recorded. It does not show
 * that no registration is in flight (next paragraph).
 *
 * DO NOT COMMIT WHILE A REGISTRATION MAY STILL BE IN FLIGHT. A committed
 * observation can be recorded ahead of the application's own in-process
 * terminal observation for the same dispatch. Commit only in a known
 * operator-recovery situation where no in-process provisioning request for
 * that attempt can still be running; the trailing "quiescent" is the
 * operator's statement of exactly that, and NOTHING here verifies it. If
 * you are not sure, do not commit. A dry run never authorizes a commit.
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
 * PIMLICO_API_KEY. TURNKEY_API_BASE_URL: leave unset (or exactly the approved host).
 *   REAL_ADMIN_EXPECTED_ENDPOINT_ID=ep-...    the endpoint, from the Neon dashboard
 *   REAL_ADMIN_EXPECTED_DATABASE_NAME=...     the database, from the Neon dashboard
 * Optional:
 *   REAL_ADMIN_DISPATCH_SEQ=<n>               a specific dispatch of that attempt (REQUIRED for a commit; omit only to dry-run the newest)
 *   REAL_ADMIN_POLL_COMMIT=1                  record the observation (unset = dry run; any other value is refused)
 *   REAL_ADMIN_COMMIT_CONFIRMATION=...        required with the commit flag (see above)
 *
 *   REAL_ADMIN_POLL_PROVISIONING_ACTIVITY=1 REAL_ADMIN_CREDENTIAL_ID=... \
 *     DATABASE_URL=... REAL_ADMIN_EXPECTED_ENDPOINT_ID=ep-... REAL_ADMIN_EXPECTED_DATABASE_NAME=... <turnkey/app env> \
 *     pnpm exec vitest run test/admin/poll-provisioning-activity.admin.test.ts
 *
 * Prints only the outcome, a reason code, verdicts, and truncated
 * identifiers — never env values, keys, request bodies, or stamps.
 */
const RUNNER = ADMIN_RUNNERS.poll;
const enabled = process.env.REAL_ADMIN_POLL_PROVISIONING_ACTIVITY === "1";

describe.skipIf(!enabled)("ADMIN: observe ONE provisioning dispatch by its stored activity id (read-only Turnkey, dry run unless REAL_ADMIN_POLL_COMMIT=1)", () => {
  it("records at most an observation on the dispatch row; never changes an attempt, account, passkey, or session", async () => {
    // Refusals first: nothing below this block can reach a database or Turnkey until the target and environment are confirmed.
    const target = requireAdminTarget({ env: process.env, runner: RUNNER });
    requireApprovedTurnkeyHost({ env: process.env, runner: RUNNER });
    const credentialId = process.env.REAL_ADMIN_CREDENTIAL_ID?.trim() ?? "";
    // Exactly as given: a padded or otherwise non-canonical sequence is refused, never trimmed into a valid one.
    const rawSeq = process.env.REAL_ADMIN_DISPATCH_SEQ;
    // A commit must name ONE explicit dispatch sequence; "latest" (no sequence) is a dry-run-only selector.
    const { commit, dispatchSeq } = requirePollCommitDecision({ env: process.env, runner: RUNNER, target, credentialId, rawSeq });

    const { createNeonRegistrationAttemptStore, createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    const { requireRealServerConfig } = await import("@/lib/real/server/config");
    const { createProvisioningActivityPort, pollProvisioningDispatch, redactPollReport } = await import("@/lib/real/server/provisioning-activity-poller");

    const config = requireRealServerConfig();
    requireApprovedTurnkeyConfig({ config, runner: RUNNER });
    const report = await pollProvisioningDispatch({
      store: createNeonRegistrationAttemptStore(createNeonSqlClient(target.url)),
      port: createProvisioningActivityPort(config),
      parentOrganizationId: config.turnkeyParentOrganizationId,
      credentialId,
      dispatchSeq,
      commit,
    });
    console.log(JSON.stringify({ mode: commit ? "COMMIT" : "DRY RUN", selector: dispatchSeq === undefined ? "latest (dry run only; not a preview for a commit)" : `dispatch ${dispatchSeq}`, endpoint: target.endpoint, database: target.database, ...redactPollReport(report) }, null, 2));
    // A dry run can never have written anything.
    if (!commit) expect(report.committed).toBe(false);
    // A requested commit that committed nothing is NOT a success: the report above stays printed, and this throws
    // (nonzero exit), naming the outcome and whether it was already processed, uncertain, or declined. Nothing is retried.
    requireCommitOutcome({ runner: RUNNER, commit, report });
  });
});
