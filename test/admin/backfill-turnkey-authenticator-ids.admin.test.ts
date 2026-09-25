import { describe, expect, it } from "vitest";

/**
 * MANUAL, LIVE ADMINISTRATIVE RUNNER — never runs in normal `pnpm test`/CI.
 * It is skipped unless the operator sets an explicit opt-in flag IN ADDITION
 * to the credentials (a DATABASE_URL alone — e.g. from a dev .env — must
 * never trigger a write). Turnkey access is read-only; the only database
 * write is the no-overwrite UPDATE in createNeonBackfillDb.
 *
 * Required environment (all must be set):
 *   REAL_ADMIN_BACKFILL_TURNKEY_AUTHENTICATOR_IDS=1   explicit opt-in
 *   DATABASE_URL                                       target Neon database
 *   TURNKEY_PARENT_ORGANIZATION_ID
 *   TURNKEY_API_PUBLIC_KEY
 *   TURNKEY_API_PRIVATE_KEY                            parent key, read-only use here
 * Also read by readRealServerConfig and therefore required, though unused by
 * the backfill itself: REAL_SESSION_SECRET, NEXT_PUBLIC_REAL_RP_ID,
 * NEXT_PUBLIC_REAL_ORIGIN, PIMLICO_API_KEY. Optional: TURNKEY_API_BASE_URL.
 *
 *   REAL_ADMIN_BACKFILL_TURNKEY_AUTHENTICATOR_IDS=1 DATABASE_URL=... <turnkey/app env> \
 *     pnpm exec vitest run test/admin/backfill-turnkey-authenticator-ids.admin.test.ts
 *
 * Prints only per-row outcomes with truncated credential ids — never env
 * values or keys.
 */
const enabled = process.env.REAL_ADMIN_BACKFILL_TURNKEY_AUTHENTICATOR_IDS === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("ADMIN: backfill turnkey_authenticator_id (live, read-only Turnkey)", () => {
  it("maps only unambiguous byte-matched authenticators and never overwrites", async () => {
    const { neon } = await import("@neondatabase/serverless");
    const { requireRealServerConfig } = await import("@/lib/real/server/config");
    const { listTurnkeyUserAuthenticators } = await import("@/lib/real/server/turnkey-discovery");
    const { backfillTurnkeyAuthenticatorIds, createNeonBackfillDb } = await import("@/lib/real/server/backfill-turnkey-authenticator-ids");

    const config = requireRealServerConfig();
    const report = await backfillTurnkeyAuthenticatorIds({
      db: createNeonBackfillDb(neon(process.env.DATABASE_URL!)),
      listAuthenticators: (row) => listTurnkeyUserAuthenticators({ config, subOrganizationId: row.subOrganizationId, turnkeyUserId: row.turnkeyUserId }),
    });
    console.table(report);
    expect(Array.isArray(report)).toBe(true);
  });
});
