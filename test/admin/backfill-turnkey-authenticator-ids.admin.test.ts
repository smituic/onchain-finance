import { describe, expect, it } from "vitest";
import type { BackfillRow } from "@/lib/real/server/backfill-turnkey-authenticator-ids";
import { ADMIN_RUNNERS, AdminRefusal, requireAdminTarget, requireApprovedTurnkeyConfig, requireApprovedTurnkeyHost, requireCommitDecision } from "./admin-target";
import { MAX_BACKFILL_WRITES, commitBackfill, previewBackfill, requireCompletedCommit } from "./backfill-run";

/**
 * MANUAL, LIVE ADMINISTRATIVE RUNNER — never runs in normal `pnpm test`/CI.
 * It is skipped unless the operator sets an explicit opt-in flag IN ADDITION
 * to the credentials (a DATABASE_URL alone — e.g. from a dev .env — must
 * never trigger a write). Turnkey access is read-only; the only database
 * write is the no-overwrite UPDATE in createNeonBackfillDb.
 *
 * DRY RUN BY DEFAULT (test/admin/backfill-run.ts): the database and Turnkey
 * are read exactly as a real run would, every row's outcome is printed with
 * `would_map` where a write would be attempted, and NOTHING is written. The
 * dry run ends with the candidate count and a preview digest.
 *
 * A COMMIT needs all three, taken from a dry run on the SAME database:
 *   REAL_ADMIN_BACKFILL_COMMIT=1
 *   REAL_ADMIN_BACKFILL_EXPECTED_COUNT=<count>     1..25 writes per run
 *   REAL_ADMIN_BACKFILL_PREVIEW_DIGEST=<sha256>
 * It recomputes the preview first and refuses, writing nothing, if the count
 * or digest differs (the candidate set changed) or exceeds 25. It then
 * writes only those candidates, each at most once. A candidate is a write
 * that will be ATTEMPTED, not a promised result: the database's own
 * write-once guard still decides each row.
 *
 * A COMMIT SUCCEEDS ONLY IF EVERY APPROVED MAPPING WAS CONFIRMED WRITTEN.
 * Anything less ends as "incomplete" and FAILS the run (nonzero exit): a
 * candidate no longer unmapped, evidence that could not be re-read or that
 * changed, a write the database declined, or a write whose outcome is
 * unknown. It stops at the first of these — no further write, no retry, no
 * overwrite — and prints, with redacted ids: `written` (confirmed; those
 * rows ARE modified and stay modified — this is not one transaction),
 * `notWritten` (the database confirmed no write), `uncertain` (unknown), and
 * `remaining` (never attempted). Do NOT simply run it again: first read the
 * database to reconcile, then run a new dry run, and commit only its new
 * count and digest.
 *
 * More than 25 candidates cannot be committed in one run, and there is no
 * automatic batching: a dry run reporting more than 25 cannot be committed
 * as it stands.
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
 * Required environment (all must be set):
 *   REAL_ADMIN_BACKFILL_TURNKEY_AUTHENTICATOR_IDS=1   explicit opt-in
 *   DATABASE_URL                                       target Neon database
 *   TURNKEY_PARENT_ORGANIZATION_ID
 *   TURNKEY_API_PUBLIC_KEY
 *   TURNKEY_API_PRIVATE_KEY                            parent key, read-only use here
 * Also read by readRealServerConfig and therefore required, though unused by
 * the backfill itself: REAL_SESSION_SECRET, NEXT_PUBLIC_REAL_RP_ID,
 * NEXT_PUBLIC_REAL_ORIGIN, PIMLICO_API_KEY. TURNKEY_API_BASE_URL: leave unset (or exactly the approved host).
 *
 * Dry run:
 *   REAL_ADMIN_BACKFILL_TURNKEY_AUTHENTICATOR_IDS=1 DATABASE_URL=... \
 *     REAL_ADMIN_EXPECTED_ENDPOINT_ID=ep-... REAL_ADMIN_EXPECTED_DATABASE_NAME=... <turnkey/app env> \
 *     pnpm exec vitest run test/admin/backfill-turnkey-authenticator-ids.admin.test.ts
 * Commit: the same command, plus REAL_ADMIN_BACKFILL_COMMIT=1,
 *   REAL_ADMIN_BACKFILL_EXPECTED_COUNT=..., REAL_ADMIN_BACKFILL_PREVIEW_DIGEST=...
 *
 * Prints only per-row outcomes with truncated credential ids — never env
 * values or keys.
 */
const RUNNER = ADMIN_RUNNERS.backfill;
const enabled = process.env.REAL_ADMIN_BACKFILL_TURNKEY_AUTHENTICATOR_IDS === "1";

describe.skipIf(!enabled)("ADMIN: backfill turnkey_authenticator_id (live, read-only Turnkey, dry run unless REAL_ADMIN_BACKFILL_COMMIT=1)", () => {
  it("maps only unambiguous byte-matched authenticators and never overwrites", async () => {
    // Refusals first: nothing below this block can reach a database or Turnkey until the target and environment are confirmed.
    const target = requireAdminTarget({ env: process.env, runner: RUNNER });
    requireApprovedTurnkeyHost({ env: process.env, runner: RUNNER });
    const commit = requireCommitDecision({ env: process.env, runner: RUNNER, target, operation: [] });
    const expectedCount = process.env.REAL_ADMIN_BACKFILL_EXPECTED_COUNT;
    const expectedDigest = process.env.REAL_ADMIN_BACKFILL_PREVIEW_DIGEST;
    if (!commit && (expectedCount !== undefined || expectedDigest !== undefined)) {
      throw new AdminRefusal(RUNNER, "a preview count or digest is set without REAL_ADMIN_BACKFILL_COMMIT; unset them for a dry run");
    }

    const { neon } = await import("@neondatabase/serverless");
    const { requireRealServerConfig } = await import("@/lib/real/server/config");
    const { listTurnkeyUserAuthenticators } = await import("@/lib/real/server/turnkey-discovery");
    const { createNeonBackfillDb } = await import("@/lib/real/server/backfill-turnkey-authenticator-ids");

    const config = requireRealServerConfig();
    requireApprovedTurnkeyConfig({ config, runner: RUNNER });
    const run = {
      db: createNeonBackfillDb(neon(target.url)),
      listAuthenticators: (row: BackfillRow) => listTurnkeyUserAuthenticators({ config, subOrganizationId: row.subOrganizationId, turnkeyUserId: row.turnkeyUserId }),
      binding: { endpoint: target.endpoint, database: target.database },
    };
    console.log(JSON.stringify({ mode: commit ? "COMMIT" : "DRY RUN", endpoint: target.endpoint, database: target.database }));

    if (!commit) {
      const preview = await previewBackfill(run);
      console.table(preview.report);
      console.log(JSON.stringify({ mode: "DRY RUN", wouldAttempt: preview.count, previewDigest: preview.digest, maxPerRun: MAX_BACKFILL_WRITES, written: 0 }, null, 2));
      expect(preview.report.every((entry) => (entry.outcome as string) !== "mapped")).toBe(true); // a dry run never reports a write
      return;
    }

    // Each write is reported as it happens, so an interrupted run still shows what completed.
    const result = await commitBackfill({ ...run, expectedCount, expectedDigest, onProgress: (event) => console.log(JSON.stringify(event)) });
    if (result.status === "completed") console.table(result.report);
    console.log(JSON.stringify({ mode: "COMMIT", ...result, report: undefined }, null, 2));
    // "completed" = every approved mapping confirmed written. "refused" wrote nothing. "incomplete" is NOT a success: the rows
    // in `written` are modified and stay so, `uncertain` may be, `notWritten` and `remaining` are not. None of it is retried here.
    requireCompletedCommit(result); // throws unless completed, so anything else fails this run (nonzero exit)
    expect(result.status).toBe("completed");
  });
});
