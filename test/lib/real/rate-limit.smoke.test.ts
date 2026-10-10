// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADDRESS_PREPARE_POLICIES, HANDLE_PREPARE_POLICIES, RECIPIENT_PROBE_POLICIES, createRateLimiter, normalizeRateLimitPolicies, type RateLimitBucket, type RateLimitPolicy, type RateLimitStore } from "@/lib/real/server/rate-limit";
import { checkDisposableTarget, connectSmokeDb, connectSmokeStores, requireDisposableTargetUrl, type SmokeDb } from "./fixtures/handles-smoke-db";

/**
 * MANUAL, LIVE-DATABASE proof of Handle Pay Slice E's rate-limit table and its
 * ONE-statement limiter, against a DISPOSABLE Neon branch.
 *
 * NOT RUN as part of the build (its harness checks below always run; the gated
 * parts are skipped). It was run ONCE against a disposable Neon branch
 * (PostgreSQL 18.6) on 2026-10-10 — 17/17, with the timeout flags below —
 * before the migration was applied to the real database. Executing it again is
 * a separate, separately authorized step. It must NEVER be pointed at the real
 * database.
 *
 * DISPOSABLE BRANCH ONLY. It never reads DATABASE_URL: the target is
 * NEON_BRANCH_DATABASE_URL, and it refuses to connect unless that endpoint
 * differs from the real database's (.env.local), DATABASE_URL is not exported,
 * and no admin or other smoke gate is set.
 *
 * TWO GATES.
 *   REAL_SMOKE_RATE_LIMIT=1          — the migration block in a run-unique
 *     SCRATCH schema (A, B, and tampered look-alikes). Touches nothing in
 *     `public`; drops only its own scratch schemas.
 *   REAL_SMOKE_RATE_LIMIT_PUBLIC=1   — additionally applies the block to the
 *     branch's `public` (first apply + idempotent rerun) and drives the REAL
 *     adapter (createNeonDurableStores().rateLimits) with truly concurrent
 *     calls (C–G). Every row it writes carries one run-unique subject prefix
 *     and is deleted at the end; no other table is read or written.
 *
 * Run it with BOTH timeout flags (Vitest's 5 s / 10 s defaults are too tight for
 * live network round trips, and an infrastructure timeout must never be read as
 * a limiter failure):
 *
 *   REAL_SMOKE_RATE_LIMIT=1 REAL_SMOKE_RATE_LIMIT_PUBLIC=1 pnpm exec vitest run test/lib/real/rate-limit.smoke.test.ts --testTimeout=30000 --hookTimeout=30000
 */
const GATE = "REAL_SMOKE_RATE_LIMIT";
const PUBLIC_GATE = "REAL_SMOKE_RATE_LIMIT_PUBLIC";
const ALLOWED_GATES = [GATE, PUBLIC_GATE] as const;
const enabled = process.env[GATE] === "1" && Boolean(process.env.NEON_BRANCH_DATABASE_URL);
const publicEnabled = enabled && process.env[PUBLIC_GATE] === "1";

const SCHEMA_PATH = "lib/real/server/schema.sql";
const BEGIN = "-- BEGIN Handle Pay Rate Limits";
const END = "-- END Handle Pay Rate Limits";
const TARGET_LINE = "target_schema CONSTANT pg_catalog.text := 'public';";

/** The executed statement: the block's single DO statement, exactly as schema.sql has it. */
function migrationBlock(): string {
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  const section = schema.slice(schema.indexOf(BEGIN), schema.indexOf(END));
  const start = section.indexOf("DO $$");
  const end = section.lastIndexOf("END $$;");
  if (schema.split(BEGIN).length !== 2 || start < 0 || end < 0) throw new Error("the rate-limit block was not found exactly once in schema.sql");
  return section.slice(start, end + "END $$;".length);
}
/** The same statement with ONLY its target-schema constant swapped. */
function migrationBlockFor(schemaName: string): string {
  const block = migrationBlock();
  if (block.split(TARGET_LINE).length !== 2) throw new Error("the block does not have exactly one target-schema constant");
  return block.replace(TARGET_LINE, `target_schema CONSTANT pg_catalog.text := '${schemaName}';`);
}

const P = (bucket: RateLimitBucket, limit: number, windowSeconds: number): RateLimitPolicy => ({ bucket, limit, windowSeconds });

// Offline (never gated): the harness itself.
describe("rate-limit smoke harness", () => {
  const source = readFileSync("test/lib/real/rate-limit.smoke.test.ts", "utf8");
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");

  it("is gated by its OWN variables and never reads DATABASE_URL", () => {
    expect(source).toContain('const enabled = process.env[GATE] === "1" && Boolean(process.env.NEON_BRANCH_DATABASE_URL);');
    expect(source).toContain('const publicEnabled = enabled && process.env[PUBLIC_GATE] === "1";');
    expect(source.match(/process\.env\.DATABASE_URL/g)).toBeNull();
    for (const other of [
      "test/lib/real/neon-smoke.test.ts",
      "test/lib/real/handles-migration.smoke.test.ts",
      "test/lib/real/handles-runtime.smoke.test.ts",
      "test/lib/real/handle-pay-reserve.smoke.test.ts",
      "test/lib/real/payment-recipient-identity-migration.smoke.test.ts",
      "test/lib/real/provisioning-dispatch-migration.smoke.test.ts",
      "test/lib/real/l2-identity-migration.smoke.test.ts",
      "test/lib/real/l2-identity-race.smoke.test.ts",
    ]) {
      expect(readFileSync(other, "utf8"), other).not.toContain("REAL_SMOKE_RATE_LIMIT");
    }
  });

  it("the target check refuses: no gate, DATABASE_URL exported, any other smoke/admin gate, the real endpoint (pooled or direct), or a missing branch URL", () => {
    const real = 'DATABASE_URL="postgresql://app:secret@ep-real-000001-pooler.us-east-2.aws.neon.tech/neondb"\n';
    const branch = "postgresql://app:secret@ep-branch-000002.us-east-2.aws.neon.tech/neondb";
    const check = (env: Record<string, string | undefined>) => checkDisposableTarget({ env, envLocalText: real, gate: GATE, allowedGates: ALLOWED_GATES });
    expect(check({ [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch })).toEqual({ ok: true });
    expect(check({ [GATE]: "1", [PUBLIC_GATE]: "1", NEON_BRANCH_DATABASE_URL: branch })).toEqual({ ok: true });
    for (const env of [
      { NEON_BRANCH_DATABASE_URL: branch },
      { [PUBLIC_GATE]: "1", NEON_BRANCH_DATABASE_URL: branch }, // the public gate alone is not enough
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch, DATABASE_URL: branch },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch, REAL_SMOKE_HANDLE_PAY_RESERVE: "1" },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch, REAL_SMOKE_PAYMENT_RECIPIENT_MIGRATION: "1" },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch, REAL_ADMIN_RESOLVE_PASSKEY_REVOCATION: "1" },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: "postgresql://app:secret@ep-real-000001.us-east-2.aws.neon.tech/neondb" },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: "postgresql://app:secret@ep-real-000001-pooler.us-east-2.aws.neon.tech/neondb" },
      { [GATE]: "1" },
    ]) {
      expect(check(env).ok, JSON.stringify(env)).toBe(false);
    }
  });

  it("the only connection path is the checked disposable target, and no other environment variable names a database", () => {
    expect(code).toContain("requireDisposableTargetUrl(GATE, ALLOWED_GATES)");
    expect(code).not.toMatch(/process\.env\.(DATABASE_URL|NEON_REAL|NEON_REAL_MIGRATION)/);
    expect(code).not.toMatch(/neon\(/); // no ad-hoc client: only the shared smoke connectors
  });

  it("it executes exactly schema.sql's block (only the target-schema constant swapped for a scratch schema) and writes ONLY to real_rate_limits (static)", () => {
    const block = migrationBlock();
    expect(block.startsWith("DO $$")).toBe(true);
    expect(block.endsWith("END $$;")).toBe(true);
    expect(block.match(/DO \$\$/g)).toHaveLength(1);
    const scratch = migrationBlockFor("rl_smoke_x");
    expect(scratch).toContain("target_schema CONSTANT pg_catalog.text := 'rl_smoke_x';");
    expect(scratch.replace("'rl_smoke_x'", "'public'")).toBe(block);
    expect(scratch).not.toContain("'public'");

    // Needles are assembled from parts so this test's own text can't match them.
    const others = ["payment" + "_attempts", "real_account" + "_handles", "real" + "_accounts", "real" + "_passkeys", "registration" + "_attempts", "webauthn" + "_challenges"];
    for (const table of others) expect(code, table).not.toContain(table);
    for (const needle of ["ALTER " + "TABLE", "DROP " + "TABLE", "CREATE " + "INDEX", "DISABLE " + "TRIGGER", "DROP " + "TRIGGER", "session_replication" + "_role", "TRUNC" + "ATE"]) {
      expect(code.toUpperCase(), needle).not.toContain(needle.toUpperCase());
    }
    // The ONLY row removal is the bounded cleanup of this run's own rows; the only schemas dropped are its own scratch schemas.
    const deletes = [...code.matchAll(new RegExp("DELETE" + " FROM [^`\"']+", "gi"))].map((match) => match[0].replace(/\s+/g, " ").trim());
    expect(deletes).toEqual(["DELETE" + " FROM public.real_rate_limits WHERE subject LIKE $1 RETURNING bucket"]);
    const drops = [...code.matchAll(new RegExp("DROP" + " SCHEMA [^`\"']+", "gi"))].map((match) => match[0]);
    expect(drops.length).toBeGreaterThan(0);
    const ownScratchOnly = new RegExp("^DROP" + " SCHEMA (IF EXISTS )?\\$\\{(scratch|tampered)\\} CASCADE$");
    for (const drop of drops) expect(drop).toMatch(ownScratchOnly);
    // Never a payment, Turnkey, Pimlico, or browser step.
    for (const external of ["prepareCashTransfer" + "UserOperation", "Turnkey" + "Request", "resolvePrepare" + "Payment", "resolveSubmit" + "Payment"]) expect(code, external).not.toContain(external);
  });

  it("scratch schema names are run-unique, lower-case identifiers that can never be `public`", () => {
    const name = `rl_smoke_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    expect(name).toMatch(/^rl_smoke_[0-9a-f]{12}$/);
    expect(name).not.toBe("public");
  });
});

// ---------------------------------------------------------------- A, B: the migration block, in a SCRATCH schema
describe.skipIf(!enabled)("rate-limit migration — scratch schema (DISPOSABLE BRANCH ONLY)", () => {
  const runId = randomUUID().replace(/-/g, "").slice(0, 12);
  const scratch = `rl_smoke_${runId}`;
  const tampered = `rl_smoke_${runId}_t`;
  let db: SmokeDb;

  const refuses = async (statement: string) => {
    try {
      await db.q(statement);
      return null;
    } catch (error) {
      return String((error as Error).message);
    }
  };

  beforeAll(async () => {
    db = await connectSmokeDb(requireDisposableTargetUrl(GATE, ALLOWED_GATES));
    await db.q(`CREATE SCHEMA ${scratch}`);
    await db.q(`CREATE SCHEMA ${tampered}`);
  });

  afterAll(async () => {
    if (!db) return;
    await db.q(`DROP SCHEMA IF EXISTS ${scratch} CASCADE`);
    await db.q(`DROP SCHEMA IF EXISTS ${tampered} CASCADE`);
  });

  it("A. applies cleanly, and reruns idempotently (with and without rows)", async () => {
    await db.q(migrationBlockFor(scratch));
    await db.q(migrationBlockFor(scratch));
    await db.q(`INSERT INTO ${scratch}.real_rate_limits (bucket, subject, window_start, hits) VALUES ('pay_prepare_day', 'smoke', now(), 1)`);
    await db.q(migrationBlockFor(scratch));
    expect(await db.q(`SELECT bucket, subject, hits FROM ${scratch}.real_rate_limits`)).toEqual([{ bucket: "pay_prepare_day", subject: "smoke", hits: 1 }]);
  });

  it("A. the table is exactly four columns, one primary key, two CHECKs — no foreign key, no other index, no trigger", async () => {
    const columns = await db.q(
      `SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null, co.collname AS collation
         FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation AND a.attname = 'bucket'
        WHERE a.attrelid = '${scratch}.real_rate_limits'::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
    );
    expect(columns).toEqual([
      { name: "bucket", type: "text", not_null: true, collation: "C" },
      { name: "subject", type: "text", not_null: true, collation: null },
      { name: "window_start", type: "timestamp with time zone", not_null: true, collation: null },
      { name: "hits", type: "integer", not_null: true, collation: null },
    ]);
    const constraints = await db.q(`SELECT conname, contype FROM pg_catalog.pg_constraint WHERE conrelid = '${scratch}.real_rate_limits'::regclass AND contype <> 'n' ORDER BY conname`);
    expect(constraints).toEqual([
      { conname: "real_rate_limits_bucket_check", contype: "c" },
      { conname: "real_rate_limits_hits_check", contype: "c" },
      { conname: "real_rate_limits_pkey", contype: "p" },
    ]);
    expect(await db.q(`SELECT count(*)::int AS n FROM pg_catalog.pg_constraint WHERE confrelid = '${scratch}.real_rate_limits'::regclass`)).toEqual([{ n: 0 }]);
    expect(await db.q(`SELECT count(*)::int AS n FROM pg_catalog.pg_index WHERE indrelid = '${scratch}.real_rate_limits'::regclass`)).toEqual([{ n: 1 }]);
    expect(await db.q(`SELECT count(*)::int AS n FROM pg_catalog.pg_trigger WHERE tgrelid = '${scratch}.real_rate_limits'::regclass AND NOT tgisinternal`)).toEqual([{ n: 0 }]);
  });

  it("B. the CHECKs and the primary key are enforced", async () => {
    expect(await refuses(`INSERT INTO ${scratch}.real_rate_limits VALUES ('not_a_bucket', 's', now(), 1)`)).toMatch(/real_rate_limits_bucket_check/);
    expect(await refuses(`INSERT INTO ${scratch}.real_rate_limits VALUES ('RECIPIENT_PROBE_SHORT', 's', now(), 1)`)).toMatch(/real_rate_limits_bucket_check/);
    expect(await refuses(`INSERT INTO ${scratch}.real_rate_limits VALUES ('recipient_probe_short', 's', now(), 0)`)).toMatch(/real_rate_limits_hits_check/);
    expect(await refuses(`INSERT INTO ${scratch}.real_rate_limits VALUES ('pay_prepare_day', 'smoke', now(), 1)`)).toMatch(/real_rate_limits_pkey/);
    expect(await refuses(`INSERT INTO ${scratch}.real_rate_limits (bucket, subject, hits) VALUES ('pay_prepare_short', 's', 1)`)).toMatch(/window_start/); // no default
    for (const bucket of ["recipient_probe_short", "recipient_probe_day", "pay_prepare_short"]) {
      expect(await refuses(`INSERT INTO ${scratch}.real_rate_limits VALUES ('${bucket}', 'smoke', now(), 1)`), bucket).toBeNull();
    }
  });

  it("A. FAIL-CLOSED: a same-named table of the wrong shape is refused and left exactly as it was", async () => {
    await db.q(`CREATE TABLE ${tampered}.real_rate_limits (bucket TEXT COLLATE "C" NOT NULL, subject TEXT NOT NULL, window_start TIMESTAMPTZ NOT NULL, hits INTEGER NOT NULL, target_handle TEXT, CONSTRAINT real_rate_limits_pkey PRIMARY KEY (bucket, subject))`);
    expect(await refuses(migrationBlockFor(tampered))).toMatch(/Rate limit migration refused/);
    expect(await db.q(`SELECT count(*)::int AS n FROM pg_catalog.pg_attribute WHERE attrelid = '${tampered}.real_rate_limits'::regclass AND attnum > 0 AND NOT attisdropped`)).toEqual([{ n: 5 }]);
  });
});

// ---------------------------------------------------------------- C–G: the REAL adapter, truly concurrent, on the branch's `public`
describe.skipIf(!publicEnabled)("rate-limit adapter — concurrency on the branch's public schema (DISPOSABLE BRANCH ONLY)", () => {
  const prefix = `rl-smoke-${randomUUID().replace(/-/g, "").slice(0, 12)}-`;
  const subject = (name: string) => `${prefix}${name}`;
  let db: SmokeDb;
  let store: RateLimitStore;
  let foreignRowsBefore: unknown;

  const foreignRows = async () => (await db.q("SELECT count(*)::int AS n FROM public.real_rate_limits WHERE subject NOT LIKE $1", [`${prefix}%`]))[0];
  const rowsOf = async (name: string) =>
    Object.fromEntries((await db.q('SELECT bucket, hits FROM public.real_rate_limits WHERE subject = $1 ORDER BY bucket COLLATE "C"', [subject(name)])).map((row) => [row.bucket as string, row.hits as number]));
  /** `count` consume() calls issued together; resolves to how many were allowed. Any rejection (e.g. a deadlock) fails the test. */
  const burst = async (name: string, policies: readonly RateLimitPolicy[], count: number) => {
    const limiter = createRateLimiter(store);
    const decisions = await Promise.all(Array.from({ length: count }, () => limiter.consume({ subject: subject(name), policies })));
    return decisions.filter((decision) => decision.allowed).length;
  };

  beforeAll(async () => {
    const url = requireDisposableTargetUrl(GATE, ALLOWED_GATES);
    db = await connectSmokeDb(url);
    store = (await connectSmokeStores(url)).rateLimits;
    // First apply (or a no-op if the branch already has it), then the idempotent rerun.
    await db.q(migrationBlock());
    await db.q(migrationBlock());
    foreignRowsBefore = await foreignRows();
  });

  afterAll(async () => {
    if (!db) return;
    await db.q("DELETE FROM public.real_rate_limits WHERE subject LIKE $1 RETURNING bucket", [`${prefix}%`]);
  });

  it("C. one subject, one bucket, limit N: N+K truly concurrent calls yield EXACTLY N allowed, and the count stops at N+1", async () => {
    const N = 7;
    const K = 18;
    expect(await burst("c", [P("recipient_probe_short", N, 600)], N + K)).toBe(N);
    expect(await rowsOf("c")).toEqual({ recipient_probe_short: N + 1 });
    // Still denied, and still capped, afterwards.
    expect(await burst("c", [P("recipient_probe_short", N, 600)], 5)).toBe(0);
    expect(await rowsOf("c")).toEqual({ recipient_probe_short: N + 1 });
  });

  it("D. two independent subjects, bursting at the same time, each get their own N", async () => {
    const N = 6;
    const policies = [P("pay_prepare_short", N, 600)];
    const [first, second] = await Promise.all([burst("d1", policies, N + 10), burst("d2", policies, N + 10)]);
    expect([first, second]).toEqual([N, N]);
    expect(await rowsOf("d1")).toEqual({ pay_prepare_short: N + 1 });
    expect(await rowsOf("d2")).toEqual({ pay_prepare_short: N + 1 });
  });

  it("E. lookup-style two-bucket charges stay exact under concurrency: allowed = the tighter limit, both counters exact", async () => {
    const policies = [P("recipient_probe_short", 5, 600), P("recipient_probe_day", 12, 86_400)];
    expect(await burst("e", policies, 9)).toBe(5);
    // Every request charged BOTH buckets — including the 4 that were denied by the short one.
    expect(await rowsOf("e")).toEqual({ recipient_probe_day: 9, recipient_probe_short: 6 });
    expect(await burst("e", policies, 9)).toBe(0);
    expect(await rowsOf("e")).toEqual({ recipient_probe_day: 13, recipient_probe_short: 6 });
  });

  it("F. handle-prepare-style four-bucket charges stay exact under concurrency", async () => {
    const policies = [P("recipient_probe_short", 4, 600), P("recipient_probe_day", 30, 86_400), P("pay_prepare_short", 6, 600), P("pay_prepare_day", 30, 86_400)];
    expect(await burst("f", policies, 11)).toBe(4);
    expect(await rowsOf("f")).toEqual({ pay_prepare_day: 11, pay_prepare_short: 7, recipient_probe_day: 11, recipient_probe_short: 5 });
  });

  it("G. MIXED: lookups (2 buckets) and handle prepares (4 buckets, sharing those 2) for the SAME subject, all at once — no deadlock, exact counters", async () => {
    const probe = [P("recipient_probe_short", 50, 600), P("recipient_probe_day", 50, 86_400)];
    const handlePrepare = [...probe, P("pay_prepare_short", 50, 600), P("pay_prepare_day", 50, 86_400)];
    const limiter = createRateLimiter(store);
    const M = 12;
    for (let round = 0; round < 3; round++) {
      // Interleaved, and listed in opposite orders, so the only thing keeping the lock order consistent is the limiter's own sort.
      const calls = Array.from({ length: M }, (_, i) => [
        limiter.consume({ subject: subject("g"), policies: i % 2 ? probe : [...probe].reverse() }),
        limiter.consume({ subject: subject("g"), policies: i % 2 ? [...handlePrepare].reverse() : handlePrepare }),
      ]).flat();
      const decisions = await Promise.all(calls); // a deadlock (40P01) would reject here
      // Rounds 0 and 1 stay inside every limit (probe rows reach 24, then 48 of 50); round 2 crosses the probe limit, so some are denied.
      if (round < 2) expect(decisions.every((decision) => decision.allowed), `round ${round}`).toBe(true);
      else expect(decisions.some((decision) => !decision.allowed)).toBe(true);
    }
    // 3 rounds x 12 of each: the shared probe rows were charged by BOTH kinds, the prepare rows only by prepares — capped at limit + 1.
    expect(await rowsOf("g")).toEqual({ pay_prepare_day: 36, pay_prepare_short: 36, recipient_probe_day: 51, recipient_probe_short: 51 });
  });

  it("the production policies behave as specified through the real adapter (sequential)", async () => {
    const limiter = createRateLimiter(store);
    const outcomes: boolean[] = [];
    for (let i = 0; i < 21; i++) outcomes.push((await limiter.consume({ subject: subject("p"), policies: RECIPIENT_PROBE_POLICIES })).allowed);
    expect(outcomes).toEqual([...Array.from({ length: 20 }, () => true), false]);
    const denied = await limiter.consume({ subject: subject("p"), policies: HANDLE_PREPARE_POLICIES });
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(Number.isInteger(denied.retryAfterSeconds)).toBe(true);
      expect(denied.retryAfterSeconds).toBeGreaterThan(0);
      expect(denied.retryAfterSeconds).toBeLessThanOrEqual(600); // only the SHORT probe bucket is exceeded
    }
    // The address-prepare budget is separate: still open.
    expect(await limiter.consume({ subject: subject("p"), policies: ADDRESS_PREPARE_POLICIES })).toEqual({ allowed: true });
    // The adapter reports its rows in the canonical order.
    expect((await store.consume({ subject: subject("o"), policies: normalizeRateLimitPolicies(HANDLE_PREPARE_POLICIES) })).map((state) => state.bucket)).toEqual(["pay_prepare_day", "pay_prepare_short", "recipient_probe_day", "recipient_probe_short"]);
  });

  it("an elapsed window resets: after the window is moved into the past (this run's own row only), the next request is hits = 1", async () => {
    const policies = [P("pay_prepare_short", 2, 600)];
    expect(await burst("r", policies, 5)).toBe(2);
    await db.q("UPDATE public.real_rate_limits SET window_start = now() - interval '601 seconds' WHERE subject = $1", [subject("r")]);
    expect(await burst("r", policies, 1)).toBe(1);
    expect(await rowsOf("r")).toEqual({ pay_prepare_short: 1 });
  });

  it("only this run's own rows were written: every other row in the table is untouched", async () => {
    expect(await foreignRows()).toEqual(foreignRowsBefore);
    const mine = await db.q("SELECT DISTINCT subject FROM public.real_rate_limits WHERE subject LIKE $1", [`${prefix}%`]);
    expect(mine.length).toBeGreaterThan(0);
    for (const row of mine) expect(String(row.subject).startsWith(prefix)).toBe(true);
  });
});
