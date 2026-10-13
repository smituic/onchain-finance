// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { PROVISIONING_DISPATCH_ADVISORY_LOCK_KEY } from "@/lib/real/server/neon-store";
import {
  PROVISIONING_ATTEMPT_DISPATCH_BUDGET,
  PROVISIONING_GLOBAL_DAILY_DISPATCH_LIMIT,
  PROVISIONING_GLOBAL_HOURLY_DISPATCH_LIMIT,
  type ProvisioningDispatchEvidence,
  type RegistrationAttemptStore,
} from "@/lib/real/server/registration-attempts";
import { checkDisposableTarget, connectSmokeDb, connectSmokeStores, parseDatabaseUrl, requireDisposableTargetUrl, type SmokeDb, type SmokeRow } from "./fixtures/handles-smoke-db";
import {
  assertPlainIdentifier,
  caseFailedInVitest,
  checkExactFileSelection,
  classifyClaimResult,
  concludeRun,
  createRunFixtures,
  createRunLifecycle,
  lockHolderStatements,
  requirePooledMode,
  safeEvidenceJson,
  tally,
  writeEvidenceFile,
  type ClaimObservation,
} from "./fixtures/provisioning-limits-smoke";

/**
 * MANUAL, LIVE-DATABASE proof of the provisioning dispatch ceilings
 * (Registration Abuse Protection, Milestone 1) under REAL PostgreSQL
 * concurrency, against a DISPOSABLE Neon branch.
 *
 * EXPLICITLY OPT-IN, AND NOT RUN as part of the build: its harness checks
 * below always run; every live case is skipped unless its own gate is set, and
 * then it runs only against a confirmed disposable Neon target. It must NEVER
 * be pointed at the real database.
 *
 * ITS FIRST AUTHORIZED LIVE RUN HAS COMPLETED (run a630d8ff: one controlled
 * run on one disposable Neon branch, pooled connection, PostgreSQL 18.6; all
 * ten cases passed and the run ended completed_clean — see ARCHITECTURE.md,
 * "Public Readiness Milestone 1"). DO NOT RERUN IT ON THAT BRANCH: the run
 * needs a ledger no earlier run has touched. Any future live execution
 * requires separate authorization and a FRESH disposable branch. Outside such
 * a run, nothing in this file is evidence of Neon behavior.
 *
 * WHAT IT DRIVES. The application's own Neon adapter
 * (createNeonDurableStores().attempts.beginProvisioningDispatch) — the exact
 * claim production runs — with truly concurrent HTTP requests. It makes NO
 * provider call of any kind: it never builds, stamps, or sends a create
 * request, and imports nothing that could. The production limits (5 per
 * rolling hour, 20 per rolling 24 hours, 2 per attempt) are what is tested;
 * they are never raised, disabled, or bypassed.
 *
 * DISPOSABLE BRANCH ONLY. It never reads DATABASE_URL: the target is
 * NEON_BRANCH_DATABASE_URL, and it refuses to connect unless that endpoint
 * differs from the real database's (.env.local), DATABASE_URL is not exported,
 * and no admin or other smoke gate is set.
 *
 * Milestone 0 Pass B: the run also requires NEON_BRANCH_EXPECTED_ENDPOINT_ID —
 * the branch's endpoint id, read by the operator from the Neon console — and
 * refuses to connect unless it equals the URL's endpoint exactly. Differing
 * from .env.local does not prove a branch is disposable; neither does this.
 *
 * EXACT FILE ONLY. It refuses unless Vitest was started as exactly
 * `vitest run <this file>` (optionally with the two timeout flags): no other
 * file, no name filter. A decisive case can therefore not be skipped by a
 * filter, and the last case fails unless every one before it ran.
 *
 * POOLED CONNECTION. This run requires the branch's POOLED connection string
 * (hostname `<endpoint id>-pooler...`), the form production uses, and refuses
 * a direct one before connecting. That is a rule of this smoke only.
 *
 * FRESH BRANCH, ONE RUN. The ceilings are global, so the run needs a ledger
 * with no dispatch in the last 25 hours and no smoke residue; it checks both,
 * read-only, before its first write, and refuses otherwise. It records
 * read-only table counts, content digests, and a catalog fingerprint first.
 *
 * A CLEAN RUN removes each case's fixtures (exact ids only) when that case
 * ends, and requires the database to match its pre-run baseline at the end.
 *
 * A FAILED RUN KEEPS ITS EVIDENCE. The moment a case fails, times out, or
 * ends ambiguously — or a cleanup is not confirmed — the run is poisoned for
 * good: no later case starts, no further write is made, and NOTHING is
 * deleted, so the attempts, dispatch rows, sequence numbers, and timestamps
 * that explain the failure stay on the branch. Such a branch will NOT match
 * its baseline; that is intended, and is reported as evidence preserved,
 * never as restored. Investigate it read-only and do not reuse it. A test
 * that timed out is not assumed cancelled: its database requests may still
 * complete, so nothing new is started behind it and nothing is retried.
 *
 * CLEANUP IS BOUNDED TOO. A cleanup has its own deadline, shorter than its
 * hook's timeout, and is tracked until it really settles. Every one of its
 * statements passes a gate first, so once the run is poisoned — or the
 * cleanup's deadline has passed — a cleanup that is still running sends
 * nothing further, and no case starts while one is in flight. If a cleanup
 * is interrupted part-way, the database state is UNKNOWN: some of this run's
 * rows may be gone and some may remain, and the report says exactly which
 * statements were confirmed, refused, unanswered, or never sent.
 *
 * EVIDENCE. Either way the run prints one `[provisioning-limits-smoke]` line
 * of JSON at the end and saves the same evidence to a NEW owner-only file,
 * `evidence/provisioning-limits-smoke-<run id>.json` (git-ignored; an
 * existing file is never overwritten): the connection mode, the baseline,
 * each case's outcome, the final verdict, every cleanup's per-statement
 * account, and the run's registered ids — whose presence in the database is
 * NOT verified after a failure. Never a connection string, an endpoint id, a
 * credential, or a driver's error text. A clean run whose evidence cannot be
 * saved FAILS: it is not an evidenced success.
 *
 * TEST-ONLY RE-DATING. To stand in for dispatches committed earlier (the daily
 * ceiling cannot be reached inside one hour), the run moves the created_at of
 * rows IT created through the production claim — by exact row id and exact
 * owner, a bounded number of times. It never re-dates or deletes any other
 * row. Production never changes created_at.
 *
 *   REAL_SMOKE_PROVISIONING_LIMITS=1 NEON_BRANCH_DATABASE_URL="postgres://..." NEON_BRANCH_EXPECTED_ENDPOINT_ID="ep-..." \
 *     pnpm exec vitest run test/lib/real/provisioning-limits.smoke.test.ts --testTimeout=120000 --hookTimeout=120000
 */
const GATE = "REAL_SMOKE_PROVISIONING_LIMITS";
const ALLOWED_GATES = [GATE] as const;
const enabled = process.env[GATE] === "1";

/** Never more than this many claims in flight at once. */
const MAX_CONCURRENCY = 8;
const LIVE_TIMEOUT_MS = 120_000;
/** The run's own deadline for one case — shorter than the test timeout, so the run is poisoned BEFORE the runner gives up on the case. */
const CASE_DEADLINE_MS = 90_000;
/** The run's own deadline for one cleanup — shorter than the hook timeout, for the same reason. */
const CLEANUP_DEADLINE_MS = 60_000;
/** Where the run's evidence is saved: a fixed, git-ignored directory. The file name is built from the run id alone. */
const EVIDENCE_DIRECTORY = "evidence";
const HOUR_S = 60 * 60;

/** Every live case, in order. The final case fails unless exactly these ran. */
const EXPECTED_CASES = [
  "A. six different attempts, four dispatches already in the hour",
  "B. empty window, seven different attempts",
  "C. one attempt, six simultaneous claims",
  "D. per-attempt budget",
  "E. daily ceiling",
  "F. lock waiter sees the holder's committed dispatch",
  "G. a rolled-back claim consumes nothing",
  "H. a capacity refusal changes nothing",
  "I. admission timestamp: the hourly window is evaluated after the lock",
  "I. admission timestamp: the daily window is evaluated after the lock",
] as const;

// Offline (never gated): the harness itself. The pure guards are proven in provisioning-limits-smoke-harness.test.ts.
describe("provisioning limits smoke harness", () => {
  const source = readFileSync("test/lib/real/provisioning-limits.smoke.test.ts", "utf8");
  const uncommented = source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");
  // Everything except this offline block (whose own assertions quote the code they look for).
  const live = uncommented.slice(uncommented.indexOf("\ndescribe.skipIf(!enabled)"));
  const code = uncommented.slice(0, uncommented.indexOf('\ndescribe("provisioning limits smoke harness"')) + live;

  it("is gated by its OWN variable only and never reads DATABASE_URL", () => {
    expect(code).toContain('const enabled = process.env[GATE] === "1";');
    expect(code.match(/process\.env\b[.[]\w+\]?/g)).toEqual(["process.env[GATE]"]);
    expect(code).not.toMatch(/DATABASE_URL/);
  });

  it("the target check refuses: no gate, DATABASE_URL exported, any other smoke/admin gate, the real endpoint (pooled or direct), or a missing branch URL", () => {
    const real = 'DATABASE_URL="postgresql://app:secret@ep-real-000001-pooler.neon.invalid/neondb"\n';
    const branch = "postgresql://app:secret@ep-branch-000002.neon.invalid/neondb";
    const check = (env: Record<string, string | undefined>) => checkDisposableTarget({ env, envLocalText: real, gate: GATE, allowedGates: ALLOWED_GATES });
    expect(check({ [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch })).toEqual({ ok: true });
    for (const env of [
      { NEON_BRANCH_DATABASE_URL: branch },
      { REAL_SMOKE_PROVISIONING_DISPATCH: "1", NEON_BRANCH_DATABASE_URL: branch }, // the adapter smoke's sub-gate is not this gate
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch, DATABASE_URL: branch },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch, REAL_SMOKE_NEON_ADAPTER: "1" },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch, REAL_SMOKE_PROVISIONING_DISPATCH: "1" },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch, REAL_SMOKE_RATE_LIMIT: "1" },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch, REAL_ADMIN_POLL_PROVISIONING_ACTIVITY: "1" },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: "postgresql://app:secret@ep-real-000001.neon.invalid/neondb" },
      { [GATE]: "1", NEON_BRANCH_DATABASE_URL: "postgresql://app:secret@ep-real-000001-pooler.neon.invalid/neondb" },
      { [GATE]: "1" },
    ]) {
      expect(check(env).ok, JSON.stringify(Object.keys(env))).toBe(false);
    }
  });

  it("the live block's first hook checks the target, then the exact-file selection, and only then connects", () => {
    const hook = /\n  beforeAll\(async \(\) => \{\n([\s\S]*?)\n  \}, LIVE_TIMEOUT_MS\);/.exec(code)?.[1] ?? "";
    const target = hook.indexOf("const url = requireDisposableTargetUrl(GATE, ALLOWED_GATES);");
    const mode = hook.indexOf("const mode = requirePooledMode(parseDatabaseUrl(url, false));");
    const modeRefusal = hook.indexOf("if (!mode.ok) throw new Error(`Provisioning limits smoke refused before any database work: ${mode.reason}`);");
    const selection = hook.indexOf('const selection = checkExactFileSelection(inject("vitestCliArgs"));');
    const refusal = hook.indexOf("if (!selection.ok) throw new Error(`Provisioning limits smoke refused before any database work: ${selection.reason}`);");
    const connect = hook.indexOf("connectSmokeDb(url)");
    expect(target).toBe(hook.search(/\S/));
    // The pooled-mode rule reads the URL the shared check already validated, through the shared parser — no second parser here.
    expect(mode).toBeGreaterThan(target);
    expect(modeRefusal).toBeGreaterThan(mode);
    expect(selection).toBeGreaterThan(modeRefusal);
    expect(code).not.toMatch(/new URL\([^)]*\)\.(hostname|host)\b|-pooler/);
    // The run is armed only at the very end of the read-only preflight.
    expect(hook.indexOf("lifecycle.arm();")).toBeGreaterThan(hook.indexOf("baseline = before;"));
    expect(code.match(/lifecycle\.arm\(\)/g)).toHaveLength(1);
    expect(refusal).toBeGreaterThan(selection);
    const label = hook.indexOf("console.log(`[provisioning-limits-smoke] connection_mode: ${mode.mode}`);");
    expect(label).toBeGreaterThan(refusal); // printed only once nothing can refuse any more
    expect(label).toBeLessThan(connect);
    expect(connect).toBeGreaterThan(refusal);
    expect(hook.indexOf("connectSmokeStores(url)")).toBeGreaterThan(refusal);
    // One live block, and it is the only place a connector is called.
    expect(code.match(/^describe\.skipIf\(/gm)).toEqual(["describe.skipIf("]);
    expect(uncommented.match(/^describe\(/gm)).toHaveLength(1); // this offline block is the only ungated one
    expect(code).toContain('describe.skipIf(!enabled)("provisioning dispatch ceilings — real concurrency (DISPOSABLE BRANCH ONLY)", () => {');
    expect(code.match(/connectSmoke(?:Db|Stores)\(/g)).toHaveLength(2);
    expect(code).not.toMatch(/createNeon\w+\(|\bneon\(/);
  });

  it("no case can be skipped: no only/skip/todo, every case is registered through liveCase, and the last test requires them all", () => {
    expect(code).not.toMatch(/\b(it|describe|test)\.(only|skip|todo|fails)\b/);
    expect(code).not.toMatch(/\bskipIf\b(?!\(!enabled\))/);
    const registered = [...code.matchAll(/^  liveCase\("([^"]+)"/gm)].map((match) => match[1]);
    expect(registered).toEqual([...EXPECTED_CASES]);
    expect(code).toContain('it("every decisive case ran, exactly once, in order", () => {');
    expect(code).toContain("expect(lifecycle.executed()).toEqual([...EXPECTED_CASES]);");
    expect(code).toContain("expect(lifecycle.poisoned()).toBeNull();");
    // Inside the live block the only tests are the cases and that final check.
    expect(live.match(/\n  it\(/g)).toHaveLength(1);
  });

  it("the hooks are thin calls into the run lifecycle: a failed, timed-out, or ambiguous case is never cleaned up, and nothing later runs", () => {
    // One lifecycle, whose cleanup is the exact-owner removal — the ONLY place that removal is named.
    expect(code).toContain("const lifecycle = createRunLifecycle({ expectedCases: EXPECTED_CASES, caseDeadlineMs: CASE_DEADLINE_MS, cleanupDeadlineMs: CLEANUP_DEADLINE_MS, fixtures, db: () => db });");
    // Cleanup is the lifecycle's alone: this file can neither build nor send a cleanup statement, nor forget a fixture.
    expect(code.match(/removeOwnedFixtures|cleanupStatements|\.forget\(|openGate/g)).toBeNull();
    // The run poisons itself before the runner's timeout abandons a case — or a cleanup.
    expect(CASE_DEADLINE_MS).toBeLessThan(LIVE_TIMEOUT_MS);
    expect(CLEANUP_DEADLINE_MS).toBeLessThan(LIVE_TIMEOUT_MS);
    // Every case body — its first database read included — runs INSIDE runCase, which refuses first.
    expect(code).toContain("    it(name, () => lifecycle.runCase(name, async () => {\n      expect(await windowCounts(), ");
    expect(live.match(/\bit\(/g)).toHaveLength(2); // liveCase's, and the final completeness check
    // After every test: the lifecycle decides, with the runner's own verdict on the test handed to it.
    expect(code).toContain("  afterEach((context) => lifecycle.afterCase({ reportedFailed: caseFailedInVitest(context) }), LIVE_TIMEOUT_MS);");
    expect(code.match(/afterEach\(/g)).toHaveLength(1);
    // The end of the run sends no cleanup and no write; it reports, and claims a restored database only for a clean run.
    const end = /\n  afterAll\(async \(\) => \{\n([\s\S]*?)\n  \}, LIVE_TIMEOUT_MS\);/.exec(code)?.[1] ?? "";
    expect(end).toContain("const final = await lifecycle.finish({");
    expect(end).not.toMatch(/\.q\(|\.tx\(|store\.|claim\(|backdate\(|attempt\(/);
    // The verdict needs BOTH a clean lifecycle and a saved evidence file; a failure to save throws and does nothing else.
    expect(end).toContain("const saved = writeEvidenceFile({ directory: EVIDENCE_DIRECTORY, runId: fixtures.runId, evidence });");
    expect(end).toContain("const verdict = concludeRun(final, saved);");
    expect(end.trimEnd().endsWith("if (!verdict.pass) throw new Error(verdict.message);")).toBe(true);
    // Its only file write is that evidence copy: a fixed git-ignored directory, a name the helper builds from the run id.
    expect(code).toContain('const EVIDENCE_DIRECTORY = "evidence";');
    expect(code.match(/writeFileSync|mkdirSync|appendFileSync|createWriteStream/g)).toBeNull();
    expect(code.match(/writeEvidenceFile\(/g)).toHaveLength(1);
    expect(readFileSync(".gitignore", "utf8")).toMatch(/^\/evidence\/$/m);
    // What is printed has passed the same content check as what is saved.
    expect(end).toMatch(/console\.log\(`\[provisioning-limits-smoke\] \$\{safeEvidenceJson\(/);
    expect(end.match(/console\.log\(/g)).toHaveLength(1);
    expect(code.match(/afterAll\(/g)).toHaveLength(1);
    // Every write goes through the lifecycle's gate, so a poisoned run — or an abandoned body — cannot write.
    const storeWrites = code.match(/\bstore\.(?!beginProvisioningDispatch\b)\w+\(/g) ?? [];
    expect(storeWrites.sort()).toEqual(["store.createVerified(", "store.recordDispatchActivity(", "store.recordDispatchTerminal(", "store.revertProvisioningAfterDefinitiveFailure("]);
    expect(code.match(/lifecycle\.write\("[^"]+", \(\) =>\s*store\.\w+\(/g)).toHaveLength(storeWrites.length);
    expect(code.match(/lifecycle\.write\(/g)).toHaveLength(5);
    expect(code).toContain('    lifecycle.beforeWrite("a provisioning claim");\n    const evidence');
    expect(code).toContain('    lifecycle.beforeWrite("the lock-holder transaction");\n    const holding = db.tx(holder);');
    expect(code.match(/db\.tx\(/g)).toHaveLength(1);
    expect(code.match(/db\.q\(statement\.text, statement\.params\)/g)).toHaveLength(1);
    // A lost answer or an unexpected database error ends the run at once: nothing is claimed after it.
    expect(code).toContain('if (observation.kind === "uncertain") throw lifecycle.uncertain("a provisioning claim whose answer never arrived");');
    expect(code).toContain('if (observation.kind === "database_error" && !options.expectDatabaseError) throw lifecycle.uncertain(');
    expect(code.match(/expectDatabaseError: true/g)).toHaveLength(1); // case G only
  });

  it("every decisive claim goes through the production adapter's claim, and concurrency is bounded", () => {
    expect(code.match(/\.beginProvisioningDispatch\(/g)).toHaveLength(1);
    expect(code).toContain("store.beginProvisioningDispatch({ credentialId, attemptedAt: new Date().toISOString(), evidence })");
    expect(code).toContain("store = (await connectSmokeStores(url)).attempts;");
    expect(code).toContain('if (credentialIds.length > MAX_CONCURRENCY) throw new Error("provisioning limits smoke: too many simultaneous claims");');
    expect(MAX_CONCURRENCY).toBeLessThanOrEqual(8);
    // No retry of a claim anywhere: one call site, never inside a loop that repeats on failure.
    expect(code).not.toMatch(/retry|again\(/i);
  });

  it("it makes no provider call and touches nothing but the two provisioning tables (static)", () => {
    const imports = [...source.matchAll(/^(?:import [^\n]*|\}) from "([^"]+)";$/gm)].map((match) => match[1]).sort();
    expect(imports).toEqual(["./fixtures/handles-smoke-db", "./fixtures/provisioning-limits-smoke", "@/lib/real/server/neon-store", "@/lib/real/server/registration-attempts", "node:crypto", "node:fs", "vitest"].sort());
    // Needles are assembled from parts so this test's own text can't match them.
    for (const needle of ["submitCreate" + "SubOrganization", "runProvisioning" + "Dispatch", "runProvisioning" + "Pipeline", "turnkey-" + "provisioning", "@turn" + "key/", "pim" + "lico", "fet" + "ch(", "createRealSafe" + "Account", "prepareCash" + "Transfer", "complete" + "Registration", "/api/" + "real"]) {
      expect(code.toLowerCase(), needle).not.toContain(needle.toLowerCase());
    }
    for (const table of ["payment" + "_attempts", "real" + "_accounts", "real" + "_passkeys", "real_account" + "_handles", "real_rate" + "_limits", "webauthn" + "_challenges"]) expect(code, table).not.toContain(table);
    for (const needle of ["ALTER " + "TABLE", "DROP " + "TABLE", "CREATE " + "INDEX", "CREATE " + "TABLE", "TRUNC" + "ATE", "DISABLE " + "TRIGGER", "session_replication" + "_role", "SET " + "LOCAL", "lock_" + "timeout"]) {
      expect(code.toUpperCase(), needle).not.toContain(needle.toUpperCase());
    }
    // This file writes NO row-changing SQL of its own: every write statement comes from the ownership registry or the production store.
    expect(code).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b/);
    const fixture = readFileSync("test/lib/real/fixtures/provisioning-limits-smoke.ts", "utf8");
    expect([...fixture.matchAll(/^(?:import [^\n]*|\}) from "([^"]+)";$/gm)].map((match) => match[1]).sort()).toEqual(["./smoke-run-ids", "node:crypto", "node:fs", "node:path"]);
    expect(fixture).not.toMatch(/\bimport\(|\brequire\(/);
    expect(source).not.toMatch(/\bimport\(|\brequire\(/);
  });

  it("the header says it is opt-in, records its one authorized live run, forbids a rerun without a fresh branch and new authorization, and documents the confirmed-target variables", () => {
    expect(source).toContain("EXPLICITLY OPT-IN, AND NOT RUN as part of the build");
    expect(source).toContain("ITS FIRST AUTHORIZED LIVE RUN HAS COMPLETED (run a630d8ff:");
    expect(source).toContain("DO NOT RERUN IT ON THAT BRANCH");
    expect(source).toContain("Any future live execution\n * requires separate authorization and a FRESH disposable branch.");
    expect(source).toContain("It must NEVER\n * be pointed at the real database.");
    // The obsolete claim is gone, and nothing in the header invites an unauthorized or repeated run.
    expect(source).not.toContain("NEVER RUN AT " + "ALL");
    // Recording that it ran changed nothing about when it runs: still skipped without its own gate.
    expect(code).toContain('describe.skipIf(!enabled)("provisioning dispatch ceilings — real concurrency (DISPOSABLE BRANCH ONLY)", () => {');
    expect(source).toContain('NEON_BRANCH_EXPECTED_ENDPOINT_ID="ep-..."');
    expect(source).toContain("Milestone 0 Pass B: the run also requires NEON_BRANCH_EXPECTED_ENDPOINT_ID");
    expect([PROVISIONING_GLOBAL_HOURLY_DISPATCH_LIMIT, PROVISIONING_GLOBAL_DAILY_DISPATCH_LIMIT, PROVISIONING_ATTEMPT_DISPATCH_BUDGET]).toEqual([5, 20, 2]);
  });
});

describe.skipIf(!enabled)("provisioning dispatch ceilings — real concurrency (DISPOSABLE BRANCH ONLY)", () => {
  const fixtures = createRunFixtures(randomUUID().replace(/-/g, "").slice(0, 8));
  const ownedPattern = `smoke-${fixtures.runId}-pl-%`;
  let db: SmokeDb;
  let store: RegistrationAttemptStore;
  let baseline: unknown = null;
  const lifecycle = createRunLifecycle({ expectedCases: EXPECTED_CASES, caseDeadlineMs: CASE_DEADLINE_MS, cleanupDeadlineMs: CLEANUP_DEADLINE_MS, fixtures, db: () => db });
  const report: Record<string, unknown> = { runId: fixtures.runId, cases: {} as Record<string, unknown> };
  let activitySeq = 0;

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const at = (value: unknown) => new Date(value as string | Date).getTime();
  const one = (rows: SmokeRow[]): SmokeRow => {
    if (rows.length !== 1) throw new Error(`provisioning limits smoke: expected exactly one row, got ${rows.length}`);
    return rows[0]!;
  };

  /** Read-only: every public table's row count and content digest, plus one fingerprint of the public catalog. */
  async function snapshot() {
    const tables = (await db.q("SELECT c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname")).map((row) => assertPlainIdentifier(row.name));
    const contents: Record<string, { n: unknown; digest: unknown }> = {};
    for (const table of tables) {
      const row = one(await db.q(`SELECT count(*)::int AS n, COALESCE(pg_catalog.md5(pg_catalog.string_agg(pg_catalog.md5(t::text), '' ORDER BY pg_catalog.md5(t::text))), '') AS digest FROM public.${table} t`));
      contents[table] = { n: row.n, digest: row.digest };
    }
    const catalog = one(
      await db.q(
        `SELECT pg_catalog.md5(pg_catalog.string_agg(x, '|' ORDER BY x)) AS digest FROM (
           SELECT 'col:' || c.relname || ':' || a.attname || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text AS x
             FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
           UNION ALL
           SELECT 'con:' || k.conrelid::regclass::text || ':' || k.conname || ':' || pg_catalog.pg_get_constraintdef(k.oid) FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_namespace n ON n.oid = k.connamespace WHERE n.nspname = 'public'
           UNION ALL
           SELECT 'idx:' || i.indexdef FROM pg_catalog.pg_indexes i WHERE i.schemaname = 'public'
         ) s`,
      ),
    ).digest;
    return { tables, contents, catalog };
  }

  /** The ledger as the claim sees it, read with the database clock; `foreign` is every recent row this run does not own. */
  const windowCounts = async () => {
    const row = one(
      await db.q(
        `SELECT count(*) FILTER (WHERE created_at > pg_catalog.clock_timestamp() - interval '1 hour')::int AS hour,
                count(*) FILTER (WHERE created_at > pg_catalog.clock_timestamp() - interval '24 hours')::int AS day,
                count(*) FILTER (WHERE credential_id NOT LIKE $1)::int AS foreign_rows
           FROM registration_provisioning_dispatches WHERE created_at > pg_catalog.clock_timestamp() - interval '25 hours'`,
        [ownedPattern],
      ),
    );
    return { hour: row.hour, day: row.day, foreign: row.foreign_rows };
  };

  /** One attempt's row and its dispatch rows, as digests — for "nothing changed" comparisons. */
  const fingerprint = async (credentialId: string) => {
    fixtures.assertOwnedCredential(credentialId);
    const attempt = one(await db.q("SELECT pg_catalog.md5(a::text) AS digest, a.state, a.external_outcome FROM registration_attempts a WHERE a.credential_id = $1", [credentialId]));
    const rows = one(await db.q("SELECT count(*)::int AS n, COALESCE(pg_catalog.max(d.dispatch_seq), 0)::int AS max_seq, COALESCE(pg_catalog.md5(pg_catalog.string_agg(pg_catalog.md5(d::text), '' ORDER BY d.dispatch_seq)), '') AS digest FROM registration_provisioning_dispatches d WHERE d.credential_id = $1", [credentialId]));
    return { attempt: attempt.digest, state: attempt.state, externalOutcome: attempt.external_outcome, rows: rows.n, maxSeq: rows.max_seq, rowsDigest: rows.digest };
  };

  /** A fresh 'verified' attempt under a run-owned id (registered BEFORE the row exists). */
  async function attempt(suffix: string): Promise<string> {
    lifecycle.beforeWrite("creating a fixture attempt");
    const credentialId = fixtures.newCredentialId(suffix);
    await lifecycle.write("creating a fixture attempt", () =>
      store.createVerified({
        credentialId,
        appUserId: fixtures.appUserIdFor(credentialId),
        userHandle: "smoke-user-handle",
        credentialPublicKey: "smoke-public-key",
        counter: 0,
        transports: ["internal"],
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
        registrationChallenge: "smoke-registration-challenge",
        rawClientDataJson: "smoke-client-data",
        rawAttestationObject: "smoke-attestation-object",
      }),
    );
    return credentialId;
  }
  const attempts = async (count: number, prefix: string) => {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) ids.push(await attempt(`${prefix}-${i}`));
    return ids;
  };

  /**
   * ONE production claim, never repeated. A lost answer poisons the run on the
   * spot — the claim may have committed, so nothing further is claimed. A
   * database error does the same unless this call is the one case that
   * expects the database to refuse it (`expectDatabaseError`).
   */
  async function claim(credentialId: string, label: string, options: { evidence?: ProvisioningDispatchEvidence; expectDatabaseError?: boolean } = {}): Promise<ClaimObservation> {
    fixtures.assertOwnedCredential(credentialId);
    lifecycle.beforeWrite("a provisioning claim");
    const evidence = options.evidence ?? fixtures.evidenceFor(credentialId, label);
    const [settled] = await Promise.allSettled([store.beginProvisioningDispatch({ credentialId, attemptedAt: new Date().toISOString(), evidence })]);
    const observation = classifyClaimResult(settled!);
    if (observation.kind === "claimed") fixtures.registerDispatch(observation.dispatchId, credentialId);
    if (observation.kind === "uncertain") throw lifecycle.uncertain("a provisioning claim whose answer never arrived");
    if (observation.kind === "database_error" && !options.expectDatabaseError) throw lifecycle.uncertain(`a provisioning claim that the database rejected with ${observation.code}`);
    return observation;
  }
  const admitted = async (credentialId: string, label: string) => {
    const observation = await claim(credentialId, label);
    if (observation.kind !== "claimed") throw new Error(`provisioning limits smoke: a claim that had to be admitted was not (${JSON.stringify(observation)})`);
    return observation;
  };
  /** Simultaneous claims, one per credential id (the same id may repeat). Bounded. */
  const together = (credentialIds: string[], label: string) => {
    if (credentialIds.length > MAX_CONCURRENCY) throw new Error("provisioning limits smoke: too many simultaneous claims");
    return Promise.all(credentialIds.map((credentialId, index) => claim(credentialId, `${label}-${index}`)));
  };

  /** `count` dispatches committed just now, one per fresh attempt, sequentially, through the production claim. */
  async function recent(count: number, prefix: string) {
    const made: Array<{ credentialId: string; dispatchId: string }> = [];
    for (const credentialId of await attempts(count, prefix)) made.push({ credentialId, dispatchId: (await admitted(credentialId, "prior")).dispatchId });
    return made;
  }
  /** Moves ONE run-owned dispatch row's created_at back (see the header). Exactly one row must change. */
  async function backdate(dispatchId: string, credentialId: string, seconds: number) {
    lifecycle.beforeWrite("re-dating a fixture row");
    const statement = fixtures.backdateStatement(dispatchId, credentialId, seconds);
    one(await lifecycle.write("re-dating a fixture row", () => db.q(statement.text, statement.params)));
  }
  /** `count` dispatches that the ledger shows as committed between 2 and 23 hours ago, never two in the same hour. */
  async function history(count: number, prefix: string) {
    const made: Array<{ credentialId: string; dispatchId: string; ageSeconds: number }> = [];
    for (let i = 0; i < count; i += 1) {
      const credentialId = await attempt(`${prefix}-${i}`);
      const { dispatchId } = await admitted(credentialId, "history");
      const ageSeconds = 2 * HOUR_S + i * 70 * 60;
      await backdate(dispatchId, credentialId, ageSeconds);
      made.push({ credentialId, dispatchId, ageSeconds });
    }
    return made;
  }

  /** A claimed dispatch taken through a proven, in-process definitive failure, back to 'verified'. Store operations only. */
  async function failDefinitively(credentialId: string, dispatchId: string) {
    fixtures.assertOwnedDispatch(dispatchId, credentialId);
    activitySeq += 1;
    const activityId = `smoke-${fixtures.runId}-pl-activity-${activitySeq}`;
    expect((await lifecycle.write("recording a fixture activity id", () => store.recordDispatchActivity({ dispatchId, activityId, fingerprint: null }))).outcome).toBe("recorded");
    const terminal = await lifecycle.write("recording a fixture terminal observation", () =>
      store.recordDispatchTerminal({
        dispatchId,
        activityId,
        observation: { status: "ACTIVITY_STATUS_FAILED", observedBy: "dispatch", turnkeyCreatedAt: null, observedSubOrganizationId: null, observedRootUserId: null, observedWalletId: null, observedOwnerAddress: null, failureCode: 3, failureMessage: "smoke failure", intentVerdict: "exact", fingerprintVerdict: "match", voteVerdict: "parent_key" },
      }),
    );
    expect(terminal.outcome).toBe("recorded");
    expect(await lifecycle.write("reverting a fixture attempt after its definitive failure", () => store.revertProvisioningAfterDefinitiveFailure({ credentialId, dispatchId, activityId }))).toMatchObject({ state: "verified", externalOutcome: "definitive_failure" });
  }

  /** Who holds, and who is waiting for, the provisioning claim's advisory lock right now (read-only). */
  const lockState = async () => {
    const row = one(
      await db.q(
        "SELECT count(*) FILTER (WHERE granted)::int AS held, count(*) FILTER (WHERE NOT granted)::int AS waiting FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND objsubid = 1 AND ((classid::bigint << 32) | objid::bigint) = $1::bigint",
        [PROVISIONING_DISPATCH_ADVISORY_LOCK_KEY],
      ),
    );
    return { held: row.held as number, waiting: row.waiting as number };
  };
  /** Bounded polling of a read-only condition; running out is an explicit failure, never a pass. */
  async function waitFor(what: string, condition: () => Promise<boolean>) {
    for (let i = 0; i < 80; i += 1) {
      if (await condition()) return;
      await sleep(100);
    }
    throw new Error(`provisioning limits smoke: timed out waiting for ${what}`);
  }
  /**
   * Starts a lock-holder transaction, waits until it visibly holds the claim's
   * lock, starts ONE production claim, and waits until that claim is visibly
   * queued behind the lock — while the holder still holds it. Returns both
   * once they finish.
   */
  async function behindTheLock(holder: string[], waiterCredentialId: string) {
    lifecycle.beforeWrite("the lock-holder transaction");
    const holding = db.tx(holder);
    // If the holder fails early the waits below would otherwise hide it. Its transaction may or may not have committed.
    let holderFailed: unknown = null;
    holding.catch((error) => {
      holderFailed = error;
      lifecycle.poison("the lock-holder transaction failed; whether it committed is unknown");
    });
    await waitFor("the holder to take the provisioning lock", async () => holderFailed !== null || (await lockState()).held === 1);
    if (holderFailed) throw holderFailed;
    const waiting = claim(waiterCredentialId, "waiter");
    waiting.catch(() => undefined); // if a wait below gives up first, the claim's own failure is already recorded as poison
    let queued = { held: 0, waiting: 0 };
    await waitFor("the claim to queue behind the provisioning lock", async () => {
      queued = await lockState();
      return holderFailed !== null || (queued.held === 1 && queued.waiting === 1);
    });
    if (holderFailed) throw holderFailed;
    const holderRows = await holding;
    const waiter = await waiting;
    return { holderRows, waiter, queued };
  }

  /**
   * A live case. Everything it does to the database happens inside
   * lifecycle.runCase, which refuses before the body — before any database
   * activity — once the run is poisoned or an earlier case is still running.
   */
  function liveCase(name: (typeof EXPECTED_CASES)[number], body: () => Promise<Record<string, unknown>>) {
    it(name, () => lifecycle.runCase(name, async () => {
      expect(await windowCounts(), "the ledger must be quiet before each case").toEqual({ hour: 0, day: 0, foreign: 0 });
      (report.cases as Record<string, unknown>)[name] = await body();
      expect((await windowCounts()).foreign, "no dispatch from outside this run may appear during a case").toBe(0);
    }), LIVE_TIMEOUT_MS);
  }

  beforeAll(async () => {
    const url = requireDisposableTargetUrl(GATE, ALLOWED_GATES);
    const mode = requirePooledMode(parseDatabaseUrl(url, false));
    if (!mode.ok) throw new Error(`Provisioning limits smoke refused before any database work: ${mode.reason}`);
    const selection = checkExactFileSelection(inject("vitestCliArgs"));
    if (!selection.ok) throw new Error(`Provisioning limits smoke refused before any database work: ${selection.reason}`);
    // Every refusal is behind us. The label only — never the connection string.
    console.log(`[provisioning-limits-smoke] connection_mode: ${mode.mode}`);
    db = await connectSmokeDb(url);
    store = (await connectSmokeStores(url)).attempts;

    // Everything below is READ-ONLY, and all of it happens before the first write.
    const server = one(await db.q("SELECT pg_catalog.current_database() AS database, pg_catalog.current_setting('server_version') AS version, pg_catalog.current_setting('default_transaction_isolation') AS isolation, pg_catalog.pg_is_in_recovery() AS in_recovery"));
    if (server.database !== new URL(url).pathname.slice(1)) throw new Error("Provisioning limits smoke refused before any write: the connected database is not the one the confirmed URL names.");
    if (server.in_recovery !== false) throw new Error("Provisioning limits smoke refused before any write: the target is a read replica.");
    const before = await snapshot();
    for (const required of ["registration_attempts", "registration_provisioning_dispatches"]) {
      if (!before.tables.includes(required)) throw new Error(`Provisioning limits smoke refused before any write: public.${required} does not exist (apply schema.sql first).`);
    }
    const residue = one(await db.q("SELECT (SELECT count(*) FROM registration_attempts WHERE credential_id LIKE 'smoke-%')::int AS attempts, (SELECT count(*) FROM registration_provisioning_dispatches WHERE credential_id LIKE 'smoke-%')::int AS dispatches"));
    if (residue.attempts !== 0 || residue.dispatches !== 0) throw new Error("Provisioning limits smoke refused before any write: this branch holds smoke residue from another run. Use a fresh disposable branch.");
    const recentRows = one(await db.q("SELECT count(*)::int AS n FROM registration_provisioning_dispatches WHERE created_at > pg_catalog.clock_timestamp() - interval '25 hours'"));
    if (recentRows.n !== 0) throw new Error("Provisioning limits smoke refused before any write: this branch already holds provisioning dispatches from the last 25 hours. Use a fresh disposable branch.");
    const lock = await lockState();
    if (lock.held !== 0 || lock.waiting !== 0) throw new Error("Provisioning limits smoke refused before any write: something else holds or awaits the provisioning lock on this branch.");
    baseline = before;
    lifecycle.arm();
    Object.assign(report, { connection_mode: mode.mode, server: { database: server.database, version: server.version, defaultIsolation: server.isolation }, baseline: before });
  }, LIVE_TIMEOUT_MS);

  // After EVERY test. Cleans up only after a case that finished cleanly; otherwise it deletes nothing (see the header).
  afterEach((context) => lifecycle.afterCase({ reportedFailed: caseFailedInVitest(context) }), LIVE_TIMEOUT_MS);

  // The end of the run: no database write, no cleanup, and no read at all once the run is poisoned.
  afterAll(async () => {
    let after: unknown = null;
    const final = await lifecycle.finish({
      verifyBaseline: async () => {
        after = await snapshot();
        return JSON.stringify(after) === JSON.stringify(baseline);
      },
    });
    if (final.outcome === "not_started") return;
    // Evidence for review: counts, digests, outcomes, this run's own fixture ids, SQLSTATEs. Never a URL, an endpoint
    // id, a credential, or a driver's error text. Saved to a new owner-only file (never overwriting one), and printed.
    const evidence = { ...report, final, after };
    const saved = writeEvidenceFile({ directory: EVIDENCE_DIRECTORY, runId: fixtures.runId, evidence });
    const verdict = concludeRun(final, saved);
    console.log(`[provisioning-limits-smoke] ${safeEvidenceJson({ ...evidence, evidenceFile: saved.ok ? "saved" : saved.reason, verdict: verdict.verdict }) ?? '{"evidence":"withheld: it failed the content check"}'}`);
    // Fails for a poisoned run, a baseline mismatch, AND a clean run whose evidence could not be saved. Nothing else happens here.
    if (!verdict.pass) throw new Error(verdict.message);
  }, LIVE_TIMEOUT_MS);

  liveCase("A. six different attempts, four dispatches already in the hour", async () => {
    await recent(4, "a-prior");
    expect(await windowCounts()).toEqual({ hour: 4, day: 4, foreign: 0 });
    const racers = await attempts(6, "a-racer");
    const results = await together(racers, "a");
    expect(tally(results)).toEqual({ claimed: 1, global_capacity_reached: 5 });
    expect(await windowCounts()).toEqual({ hour: PROVISIONING_GLOBAL_HOURLY_DISPATCH_LIMIT, day: 5, foreign: 0 });
    // Exactly one racer has a row; the refused five are untouched 'verified' attempts with none.
    const states = await Promise.all(racers.map(fingerprint));
    expect(states.filter((state) => state.rows === 1 && state.state === "provisioning_in_flight")).toHaveLength(1);
    expect(states.filter((state) => state.rows === 0 && state.state === "verified" && state.externalOutcome === "not_attempted")).toHaveLength(5);
    return { tally: tally(results) };
  });

  liveCase("B. empty window, seven different attempts", async () => {
    const racers = await attempts(7, "b-racer");
    const results = await together(racers, "b");
    expect(tally(results)).toEqual({ claimed: 5, global_capacity_reached: 2 });
    expect(await windowCounts()).toEqual({ hour: 5, day: 5, foreign: 0 });
    // And it stays full: one more, alone, is refused.
    expect((await claim(await attempt("b-late"), "late")).kind).toBe("global_capacity_reached");
    expect(await windowCounts()).toEqual({ hour: 5, day: 5, foreign: 0 });
    return { tally: tally(results) };
  });

  liveCase("C. one attempt, six simultaneous claims", async () => {
    const credentialId = await attempt("c-only");
    const results = await together(Array.from({ length: 6 }, () => credentialId), "c");
    expect(tally(results)).toEqual({ claimed: 1, claim_lost: 5 });
    expect(await fingerprint(credentialId)).toMatchObject({ state: "provisioning_in_flight", externalOutcome: "unknown", rows: 1, maxSeq: 1 });
    expect(await windowCounts()).toEqual({ hour: 1, day: 1, foreign: 0 });
    return { tally: tally(results) };
  });

  liveCase("D. per-attempt budget", async () => {
    const credentialId = await attempt("d-only");
    const first = await admitted(credentialId, "first");
    expect(first.dispatchSeq).toBe(1);
    await failDefinitively(credentialId, first.dispatchId);
    const second = await admitted(credentialId, "second");
    expect(second.dispatchSeq).toBe(PROVISIONING_ATTEMPT_DISPATCH_BUDGET);
    await failDefinitively(credentialId, second.dispatchId);

    const before = await fingerprint(credentialId);
    expect(before).toMatchObject({ state: "verified", externalOutcome: "definitive_failure", rows: 2, maxSeq: 2 });
    const third = await together(Array.from({ length: 4 }, () => credentialId), "third");
    expect(tally(third)).toEqual({ attempt_budget_exhausted: 4 });
    expect((await claim(credentialId, "fourth")).kind).toBe("attempt_budget_exhausted");
    // Refusal purity: the attempt row and both dispatch rows are byte-for-byte what they were.
    expect(await fingerprint(credentialId)).toEqual(before);
    // The global ceilings had room throughout (2 of 5), so the budget alone decided.
    expect(await windowCounts()).toEqual({ hour: 2, day: 2, foreign: 0 });
    return { tally: tally(third) };
  });

  liveCase("E. daily ceiling", async () => {
    const past = await history(PROVISIONING_GLOBAL_DAILY_DISPATCH_LIMIT - 1, "e-history");
    expect(await windowCounts()).toEqual({ hour: 0, day: 19, foreign: 0 });
    // Three at once with the hourly ceiling wide open (0 of 5): only the daily ceiling can refuse.
    const racers = await attempts(3, "e-racer");
    const results = await together(racers, "e");
    expect(tally(results)).toEqual({ claimed: 1, global_capacity_reached: 2 });
    expect(await windowCounts()).toEqual({ hour: 1, day: PROVISIONING_GLOBAL_DAILY_DISPATCH_LIMIT, foreign: 0 });
    // The 21st, alone: refused, and unchanged by it.
    const late = await attempt("e-late");
    const lateBefore = await fingerprint(late);
    expect((await claim(late, "late")).kind).toBe("global_capacity_reached");
    expect(await fingerprint(late)).toEqual(lateBefore);
    // Rolling: once the oldest of the 19 is more than 24 hours old, exactly one more is admitted.
    const oldest = past[past.length - 1]!;
    expect(oldest.ageSeconds).toBe(23 * HOUR_S);
    await backdate(oldest.dispatchId, oldest.credentialId, 2 * HOUR_S);
    expect(await windowCounts()).toEqual({ hour: 1, day: 19, foreign: 0 });
    expect((await claim(late, "after-expiry")).kind).toBe("claimed");
    expect((await claim(await attempt("e-last"), "last")).kind).toBe("global_capacity_reached");
    expect(await windowCounts()).toEqual({ hour: 2, day: 20, foreign: 0 });
    return { tally: tally(results) };
  });

  liveCase("F. lock waiter sees the holder's committed dispatch", async () => {
    await recent(4, "f-prior");
    const holderCredentialId = await attempt("f-holder");
    const waiterCredentialId = await attempt("f-waiter");
    const waiterBefore = await fingerprint(waiterCredentialId);
    // The holder takes the claim's own lock, commits the hour's FIFTH dispatch, and only then lets go.
    const { holderRows, waiter, queued } = await behindTheLock(
      lockHolderStatements(fixtures, { lockKey: PROVISIONING_DISPATCH_ADVISORY_LOCK_KEY, holdSeconds: 5, insert: { credentialId: holderCredentialId, label: "holder" } }),
      waiterCredentialId,
    );
    fixtures.registerDispatch(String(one(holderRows[1]!).id), holderCredentialId);
    expect(queued).toEqual({ held: 1, waiting: 1 });
    // The waiter's transaction began while the ledger still showed four. Had its count used a snapshot
    // from before the lock was granted it would have been admitted as a sixth; it must see five and refuse.
    expect(waiter.kind).toBe("global_capacity_reached");
    expect(await fingerprint(waiterCredentialId)).toEqual(waiterBefore);
    expect(await windowCounts()).toEqual({ hour: 5, day: 5, foreign: 0 });
    return { waiter: waiter.kind, queued };
  });

  liveCase("G. a rolled-back claim consumes nothing", async () => {
    const prior = await recent(4, "g-prior");
    const credentialId = await attempt("g-target");
    const before = await fingerprint(credentialId);
    // A claim the ceilings admit, whose INSERT then violates a constraint (a body digest already on the ledger): the whole transaction rolls back.
    const duplicate = await claim(credentialId, "duplicate", { evidence: fixtures.evidenceFor(prior[0]!.credentialId, "prior"), expectDatabaseError: true });
    expect(duplicate).toMatchObject({ kind: "database_error", code: "23505", detail: "constraint", constraint: "registration_provisioning_dispatches_body_sha256_key" });
    expect(await fingerprint(credentialId)).toEqual(before);
    expect(await windowCounts()).toEqual({ hour: 4, day: 4, foreign: 0 });
    // The fifth unit is still there, and it is the last.
    expect((await admitted(credentialId, "valid")).dispatchSeq).toBe(1);
    expect((await claim(await attempt("g-late"), "late")).kind).toBe("global_capacity_reached");
    expect(await windowCounts()).toEqual({ hour: 5, day: 5, foreign: 0 });
    return { rolledBack: duplicate.kind };
  });

  liveCase("H. a capacity refusal changes nothing", async () => {
    // One attempt that already failed once (so it holds sequence 1 and a definitive_failure outcome), and one never tried.
    const retried = await attempt("h-retried");
    await failDefinitively(retried, (await admitted(retried, "first")).dispatchId);
    await recent(4, "h-prior");
    const untried = await attempt("h-untried");
    expect(await windowCounts()).toEqual({ hour: 5, day: 5, foreign: 0 });
    const before = { retried: await fingerprint(retried), untried: await fingerprint(untried) };
    const ledgerBefore = one(await db.q("SELECT count(*)::int AS n, pg_catalog.md5(pg_catalog.string_agg(pg_catalog.md5(d::text), '' ORDER BY d.id::text)) AS digest FROM registration_provisioning_dispatches d WHERE d.credential_id LIKE $1", [ownedPattern]));

    const results = await together([retried, untried, retried, untried], "h");
    expect(tally(results)).toEqual({ global_capacity_reached: 4 });

    expect({ retried: await fingerprint(retried), untried: await fingerprint(untried) }).toEqual(before);
    expect(before.retried).toMatchObject({ state: "verified", externalOutcome: "definitive_failure", rows: 1, maxSeq: 1 }); // sequence 2 was not consumed
    expect(before.untried).toMatchObject({ state: "verified", externalOutcome: "not_attempted", rows: 0, maxSeq: 0 });
    expect(one(await db.q("SELECT count(*)::int AS n, pg_catalog.md5(pg_catalog.string_agg(pg_catalog.md5(d::text), '' ORDER BY d.id::text)) AS digest FROM registration_provisioning_dispatches d WHERE d.credential_id LIKE $1", [ownedPattern]))).toEqual(ledgerBefore);
    return { tally: tally(results) };
  });

  /**
   * Shared by both timestamp cases. The ledger is exactly AT a ceiling, and one
   * owned row is set — by the holder, under the lock, on the database clock —
   * to leave that window while the lock is still held. A claim that began
   * before that instant and is admitted after it proves the window was
   * evaluated at the post-lock admission time, not at transaction start.
   */
  async function admittedOnlyAfterTheLock(window: "1 hour" | "24 hours", boundary: { credentialId: string; dispatchId: string }, waiterCredentialId: string) {
    const { holderRows, waiter, queued } = await behindTheLock(
      lockHolderStatements(fixtures, { lockKey: PROVISIONING_DISPATCH_ADVISORY_LOCK_KEY, holdSeconds: 7, expire: { ...boundary, window, expiresInSeconds: 3 } }),
      waiterCredentialId,
    );
    expect(queued).toEqual({ held: 1, waiting: 1 });
    const expiresAt = at(one(holderRows[1]!).expires_at);
    const releasedAfter = at(one(holderRows[3]!).released_after);
    if (waiter.kind !== "claimed") throw new Error(`provisioning limits smoke: the waiter was not admitted (${JSON.stringify(waiter)}) — with a post-lock admission time the boundary row had already left the window`);
    const transactionStart = at(waiter.attemptUpdatedAt); // the claim sets the attempt's updated_at = now(), i.e. transaction start
    const admission = at(waiter.createdAt);
    // Inconclusive is a FAILURE, not a pass: the claim must have begun while the boundary row still counted.
    if (!(transactionStart < expiresAt)) throw new Error("provisioning limits smoke: inconclusive timing — the waiting claim's transaction began after the boundary row left its window. Not retried.");
    expect(expiresAt).toBeLessThanOrEqual(releasedAfter);
    expect(admission).toBeGreaterThan(releasedAfter); // created_at was read after the holder's last clock reading: post-lock
    expect(admission - transactionStart).toBeGreaterThan(1_000);
    // The persisted row: created_at is that admission instant, and equals its own updated_at.
    const row = one(await db.q("SELECT d.created_at, d.updated_at, (d.created_at = d.updated_at) AS same FROM registration_provisioning_dispatches d WHERE d.id = $1::uuid AND d.credential_id = $2", [waiter.dispatchId, waiterCredentialId]));
    expect(row.same).toBe(true);
    expect(at(row.created_at)).toBe(admission);
    return { queued, transactionStartBeforeExpiryMs: expiresAt - transactionStart, admittedAfterReleaseMs: admission - releasedAfter };
  }

  liveCase("I. admission timestamp: the hourly window is evaluated after the lock", async () => {
    const prior = await recent(5, "ih-prior");
    expect(await windowCounts()).toEqual({ hour: 5, day: 5, foreign: 0 });
    const waiterCredentialId = await attempt("ih-waiter");
    const result = await admittedOnlyAfterTheLock("1 hour", prior[0]!, waiterCredentialId);
    expect(await windowCounts()).toEqual({ hour: 5, day: 6, foreign: 0 });
    return result;
  });

  liveCase("I. admission timestamp: the daily window is evaluated after the lock", async () => {
    await history(PROVISIONING_GLOBAL_DAILY_DISPATCH_LIMIT - 1, "id-history");
    const boundary = (await recent(1, "id-boundary"))[0]!;
    expect(await windowCounts()).toEqual({ hour: 1, day: 20, foreign: 0 });
    const waiterCredentialId = await attempt("id-waiter");
    const result = await admittedOnlyAfterTheLock("24 hours", boundary, waiterCredentialId);
    expect(await windowCounts()).toEqual({ hour: 1, day: 20, foreign: 0 });
    return result;
  });

  it("every decisive case ran, exactly once, in order", () => {
    expect(lifecycle.poisoned()).toBeNull();
    expect(lifecycle.inFlight()).toBeNull();
    expect(lifecycle.cleanupInFlight()).toBeNull();
    expect(lifecycle.executed()).toEqual([...EXPECTED_CASES]);
  });
});
