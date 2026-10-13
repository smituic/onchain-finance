import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isRunSmokeId } from "./smoke-run-ids";

/**
 * TEST-ONLY, PURE helpers for the provisioning dispatch-ceiling smoke
 * (provisioning-limits.smoke.test.ts). Nothing here connects, reads the
 * environment, or imports a database or provider module — so every guard can
 * be proven offline (provisioning-limits-smoke-harness.test.ts) before the
 * smoke is ever pointed at a disposable Neon branch.
 *
 * Three things live here:
 *   1. the exact-file selection check (the smoke runs only as the one file
 *      Vitest was asked to run, with no test-name filter);
 *   2. the run's ownership registry — the ONLY source of ids for any
 *      statement that re-dates or deletes a row;
 *   3. the classification of a claim's outcome, so a database error or a
 *      lost connection is never counted as a refusal;
 *   4. the run's lifecycle — once a case fails, times out, or ends
 *      ambiguously, the run is POISONED for good: no later case starts, no
 *      further write is made, and nothing is deleted, so the rows that explain
 *      the failure stay on the disposable branch for read-only investigation;
 *   5. the pooled-connection requirement for this run.
 */

declare module "vitest" {
  interface ProvidedContext {
    /** The main Vitest process's own command-line arguments (vitest.config.mts). Never an environment value. */
    vitestCliArgs: string[];
  }
}

export const PROVISIONING_LIMITS_SMOKE_FILE = "test/lib/real/provisioning-limits.smoke.test.ts";

export type SelectionCheck = { ok: true } | { ok: false; reason: string };

/** The only flags the smoke may be run with: per-test and per-hook timeouts, in `--name=value` form. Anything else — a name filter, a reporter, a second file — is a refusal. */
const ALLOWED_FLAG = /^--(testTimeout|hookTimeout)=[0-9]{1,6}$/;

/**
 * Whether Vitest was started as exactly `vitest run <this file> [timeouts]`.
 * A wider run could interleave other suites with a test that depends on a
 * quiet, globally shared ledger; a narrower one (`-t`, `--testNamePattern`)
 * could skip a decisive case and still exit green. Unknown arguments fail
 * closed, including an argument list that was never provided at all.
 */
export function checkExactFileSelection(cliArgs: unknown, file: string = PROVISIONING_LIMITS_SMOKE_FILE): SelectionCheck {
  if (!Array.isArray(cliArgs) || cliArgs.some((arg) => typeof arg !== "string")) return { ok: false, reason: "the Vitest command line is not available to this run" };
  const args = cliArgs as string[];
  if (args[0] !== "run") return { ok: false, reason: 'it must be started with "vitest run" (no watch mode, no other command)' };
  const rest = args.slice(1);
  const files = rest.filter((arg) => !arg.startsWith("-"));
  const flags = rest.filter((arg) => arg.startsWith("-"));
  if (files.length !== 1 || (files[0] !== file && files[0] !== `./${file}`)) return { ok: false, reason: "it must be the ONE test file selected on the command line, by its exact path" };
  for (const flag of flags) if (!ALLOWED_FLAG.test(flag)) return { ok: false, reason: "only --testTimeout=<ms> and --hookTimeout=<ms> may accompany it (a name filter or any other option could skip a decisive case)" };
  return { ok: true };
}

const RUN_ID = /^[0-9a-f]{8}$/;
const SUFFIX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Hard ceilings on what ONE run may ever create or re-date — CUMULATIVE over
 * the whole run, never refilled when a finished case's fixtures are removed.
 * The ten prepared cases create 89 attempts and re-date 40 rows between them;
 * a run that would exceed either ceiling stops instead.
 */
export const MAX_RUN_ATTEMPTS = 100;
export const MAX_RUN_BACKDATES = 60;
/** A row may be re-dated by at most this much in one step (just over the daily window). */
export const MAX_BACKDATE_SECONDS = 26 * 60 * 60;

export type Statement = { text: string; params: unknown[] };
export type CleanupStatement = Statement & { credentialId: string; target: "dispatchRows" | "attemptRow" };

/**
 * One run's fixtures, by exact id. A credential id is owned only if THIS
 * registry generated it; a dispatch row is owned only if the production claim
 * returned it for an owned credential id. Every write helper below takes its
 * ids from here and refuses anything else — nothing is ever selected by a
 * prefix pattern, a timestamp, or a status.
 */
export function createRunFixtures(runId: string) {
  if (!RUN_ID.test(runId)) throw new Error("provisioning limits smoke: the run id must be 8 lowercase hex characters");
  const credentialIds = new Set<string>();
  /** Every id ever minted, so a removed fixture's id can never be minted (and so owned) a second time. */
  const everMinted = new Set<string>();
  /** dispatch id -> its owned credential id */
  const dispatchOwners = new Map<string, string>();
  let backdates = 0;
  /** Every credential id this run ever minted — not reduced by forget(). */
  let minted = 0;

  const assertOwnedCredential = (credentialId: string): void => {
    // Both: registered by this run AND of this run's shape. Never echoes the id.
    if (!credentialIds.has(credentialId) || !isRunSmokeId(runId, credentialId)) throw new Error("provisioning limits smoke: refusing to touch a credential id this run does not own");
  };

  return {
    runId,
    /** Mints and registers a new run-owned credential id, BEFORE any row is created for it. */
    newCredentialId(suffix: string): string {
      if (!SUFFIX.test(suffix)) throw new Error("provisioning limits smoke: a fixture suffix must be lowercase letters, digits, and single hyphens");
      if (minted >= MAX_RUN_ATTEMPTS) throw new Error("provisioning limits smoke: this run reached its fixture limit; refusing to create more");
      const credentialId = `smoke-${runId}-pl-${suffix}`;
      if (credentialIds.has(credentialId) || everMinted.has(credentialId)) throw new Error("provisioning limits smoke: a fixture suffix was used twice");
      minted += 1;
      everMinted.add(credentialId);
      credentialIds.add(credentialId);
      return credentialId;
    },
    appUserIdFor(credentialId: string): string {
      assertOwnedCredential(credentialId);
      return `${credentialId}-user`;
    },
    /** A run-unique request body for an owned credential (request_body_sha256 is unique across the whole table) and its digest. */
    evidenceFor(credentialId: string, label: string) {
      assertOwnedCredential(credentialId);
      if (!SUFFIX.test(label)) throw new Error("provisioning limits smoke: a body label must be lowercase letters, digits, and single hyphens");
      const requestBody = `{"smoke":"${credentialId}","label":"${label}"}`;
      return { evidenceVersion: 1, organizationId: "smoke-parent-org", stampPublicKey: "smoke-02abc", requestTimestampMs: 1_790_204_988_123, requestBody, requestBodySha256: createHash("sha256").update(requestBody, "utf8").digest("hex") };
    },
    /** Records a dispatch row the production claim (or this run's own lock-holder fixture) created for an owned credential. */
    registerDispatch(dispatchId: string, credentialId: string): void {
      assertOwnedCredential(credentialId);
      if (!UUID.test(dispatchId)) throw new Error("provisioning limits smoke: a dispatch id must be a lowercase UUID");
      const existing = dispatchOwners.get(dispatchId);
      if (existing !== undefined && existing !== credentialId) throw new Error("provisioning limits smoke: a dispatch id cannot change owner");
      dispatchOwners.set(dispatchId, credentialId);
    },
    assertOwnedCredential,
    assertOwnedDispatch(dispatchId: string, credentialId: string): void {
      assertOwnedCredential(credentialId);
      if (dispatchOwners.get(dispatchId) !== credentialId) throw new Error("provisioning limits smoke: refusing to touch a dispatch row this run does not own");
    },
    ownedCredentialIds: (): string[] => [...credentialIds],
    mintedCount: (): number => minted,
    ownedDispatchIds: (): string[] => [...dispatchOwners.keys()],

    /**
     * TEST-ONLY re-dating of ONE run-owned dispatch row: moves its created_at
     * back by `seconds`, to stand in for a dispatch committed earlier. Exact
     * id AND exact owner in the WHERE clause; the caller must see exactly one
     * row come back. Bounded per step and per run.
     */
    backdateStatement(dispatchId: string, credentialId: string, seconds: number): Statement {
      this.assertOwnedDispatch(dispatchId, credentialId);
      if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > MAX_BACKDATE_SECONDS) throw new Error("provisioning limits smoke: a backdate must be a whole number of seconds within the bound");
      if (backdates >= MAX_RUN_BACKDATES) throw new Error("provisioning limits smoke: this run reached its backdate limit; refusing to re-date more");
      backdates += 1;
      return {
        text: "UPDATE registration_provisioning_dispatches SET created_at = created_at - pg_catalog.make_interval(secs => $3::int) WHERE id = $1::uuid AND credential_id = $2 RETURNING id",
        params: [dispatchId, credentialId, seconds],
      };
    },

    /**
     * The whole cleanup, as exact-id statements: for each owned credential,
     * its dispatch rows, then its attempt row. One id per statement. Dispatch
     * rows go first (they reference the attempt).
     */
    cleanupStatements(): CleanupStatement[] {
      const statements: CleanupStatement[] = [];
      for (const credentialId of credentialIds) {
        assertOwnedCredential(credentialId);
        statements.push({ credentialId, target: "dispatchRows", text: "DELETE FROM registration_provisioning_dispatches WHERE credential_id = $1 RETURNING id", params: [credentialId] });
        statements.push({ credentialId, target: "attemptRow", text: "DELETE FROM registration_attempts WHERE credential_id = $1 RETURNING credential_id", params: [credentialId] });
      }
      return statements;
    },
    /**
     * Forgets EXACTLY the given ids (and their dispatch rows) — called only
     * for ids one cleanup has conclusively accounted for: both of its deletes
     * confirmed and its residue read clean. Never "everything": an id that
     * another case registered, or whose cleanup is unknown, stays registered
     * so it can still be reconciled read-only.
     */
    forget(ids: readonly string[]): void {
      for (const credentialId of ids) {
        assertOwnedCredential(credentialId);
        credentialIds.delete(credentialId);
        for (const [dispatchId, owner] of dispatchOwners) if (owner === credentialId) dispatchOwners.delete(dispatchId);
      }
    },
  };
}
export type RunFixtures = ReturnType<typeof createRunFixtures>;

/**
 * The lock-holder batch for the waiter cases, as plain statements for ONE
 * transaction (the shared smoke connector's tx()). Every value interpolated
 * here is checked first: the lock key is digits, ids are this run's own, and
 * numbers are bounded integers — nothing else can reach the SQL text.
 *
 *   1. take the provisioning claim's own transaction-scoped advisory lock;
 *   2. (optional) re-date one owned row so that it leaves the given window
 *      `expiresInSeconds` after this instant — i.e. WHILE the lock is held;
 *   3. (optional) insert one fixture dispatch row for an owned, never-claimed
 *      attempt — the "earlier transaction's committed dispatch";
 *   4. hold the lock for `holdSeconds`;
 *   5. read the clock one last time, just before the commit releases the lock.
 */
export function lockHolderStatements(
  fixtures: RunFixtures,
  input: {
    lockKey: string;
    holdSeconds: number;
    expire?: { dispatchId: string; credentialId: string; window: "1 hour" | "24 hours"; expiresInSeconds: number };
    insert?: { credentialId: string; label: string };
  },
): string[] {
  if (!/^[0-9]{1,19}$/.test(input.lockKey)) throw new Error("provisioning limits smoke: the lock key must be a plain positive integer");
  if (!Number.isSafeInteger(input.holdSeconds) || input.holdSeconds < 1 || input.holdSeconds > 10) throw new Error("provisioning limits smoke: the lock may be held for 1 to 10 seconds");
  const statements = [`SELECT pg_catalog.pg_advisory_xact_lock(${input.lockKey}::bigint)`];
  if (input.expire) {
    const { dispatchId, credentialId, window, expiresInSeconds } = input.expire;
    fixtures.assertOwnedDispatch(dispatchId, credentialId);
    if (window !== "1 hour" && window !== "24 hours") throw new Error("provisioning limits smoke: unknown window");
    if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds >= input.holdSeconds) throw new Error("provisioning limits smoke: the row must leave its window while the lock is still held");
    statements.push(
      `UPDATE registration_provisioning_dispatches SET created_at = pg_catalog.clock_timestamp() - interval '${window}' + interval '${expiresInSeconds} seconds' WHERE id = '${dispatchId}'::uuid AND credential_id = '${credentialId}' RETURNING created_at + interval '${window}' AS expires_at`,
    );
  }
  if (input.insert) {
    const { credentialId, label } = input.insert;
    const evidence = fixtures.evidenceFor(credentialId, label);
    // The body is JSON built from checked tokens only; it contains no single quote.
    if (evidence.requestBody.includes("'")) throw new Error("provisioning limits smoke: a fixture body may not contain a quote");
    statements.push(
      `INSERT INTO registration_provisioning_dispatches (credential_id, dispatch_seq, evidence_version, organization_id, stamp_public_key, request_timestamp_ms, request_body, request_body_sha256, created_at, updated_at) SELECT '${credentialId}', 1, 1, '${evidence.organizationId}', '${evidence.stampPublicKey}', ${evidence.requestTimestampMs}, '${evidence.requestBody}', '${evidence.requestBodySha256}', t.at, t.at FROM (SELECT pg_catalog.clock_timestamp() AS at) t RETURNING id, created_at`,
    );
  }
  statements.push(`SELECT pg_catalog.pg_sleep(${input.holdSeconds})`);
  statements.push("SELECT pg_catalog.clock_timestamp() AS released_after");
  return statements;
}

/** How one claim call ended. Only `claimed` and the three named refusals are answers; everything else is an explicit non-answer. */
export type ClaimObservation =
  | { kind: "claimed"; dispatchId: string; dispatchSeq: number; createdAt: string; attemptUpdatedAt: string }
  | { kind: "claim_lost" | "attempt_budget_exhausted" | "global_capacity_reached" }
  /** The database answered with an error: the batch rolled back. */
  | { kind: "database_error"; code: string; detail: "lock_timeout" | "statement_timeout" | "deadlock" | "constraint" | "other"; constraint: string | null; message: string }
  /** No answer reached us: the claim may or may not have committed. Never retried, never counted as a refusal. */
  | { kind: "uncertain"; message: string };

const REFUSALS = new Set(["claim_lost", "attempt_budget_exhausted", "global_capacity_reached"]);

/** Classifies a settled claim. Unknown result shapes are `uncertain`, never a refusal. Messages are truncated and carry no URL. */
export function classifyClaimResult(settled: { status: "fulfilled"; value: unknown } | { status: "rejected"; reason: unknown }): ClaimObservation {
  if (settled.status === "fulfilled") {
    const value = settled.value as { outcome?: unknown; dispatch?: { id?: unknown; dispatchSeq?: unknown; createdAt?: unknown }; attempt?: { updatedAt?: unknown } } | null;
    if (value && typeof value.outcome === "string" && REFUSALS.has(value.outcome) && Object.keys(value).length === 1) return { kind: value.outcome as "claim_lost" | "attempt_budget_exhausted" | "global_capacity_reached" };
    if (value && value.outcome === "claimed" && typeof value.dispatch?.id === "string" && typeof value.dispatch.dispatchSeq === "number" && typeof value.dispatch.createdAt === "string" && typeof value.attempt?.updatedAt === "string") {
      return { kind: "claimed", dispatchId: value.dispatch.id, dispatchSeq: value.dispatch.dispatchSeq, createdAt: value.dispatch.createdAt, attemptUpdatedAt: value.attempt.updatedAt };
    }
    return { kind: "uncertain", message: "the claim returned a result this harness does not recognize" };
  }
  const reason = settled.reason as { code?: unknown; message?: unknown; constraint?: unknown } | null;
  const code = reason && typeof reason.code === "string" ? reason.code : "";
  const message = String(reason && typeof reason.message === "string" ? reason.message : reason).replace(/postgres(ql)?:\/\/\S+/gi, "[url]").slice(0, 200);
  // A five-character SQLSTATE means Postgres itself answered: the transaction rolled back.
  if (/^[0-9A-Z]{5}$/.test(code)) {
    const detail = code === "55P03" ? "lock_timeout" : code === "57014" ? "statement_timeout" : code === "40P01" ? "deadlock" : code.startsWith("23") ? "constraint" : "other";
    // The violated constraint, as the server named it (the driver's own field, else the quoted name in the message).
    const named = reason && typeof reason.constraint === "string" && reason.constraint ? reason.constraint : (/constraint "([a-z0-9_]+)"/.exec(message)?.[1] ?? null);
    return { kind: "database_error", code, detail, constraint: named && /^[a-z0-9_]+$/.test(named) ? named : null, message };
  }
  return { kind: "uncertain", message };
}

/** Counts by kind — for asserting "exactly N admitted, M refused, and NOTHING else". */
export function tally(observations: readonly ClaimObservation[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const observation of observations) counts[observation.kind] = (counts[observation.kind] ?? 0) + 1;
  return counts;
}

/** A public-schema table name as the catalog returned it, safe to place in a statement — or a throw. */
export function assertPlainIdentifier(name: unknown): string {
  if (typeof name !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error("provisioning limits smoke: a table name from the catalog is not a plain identifier; refusing to build a statement from it");
  return name;
}

// ------------------------------------------------------------------ connection mode

/** The shape handles-smoke-db.ts's parseDatabaseUrl returns — the ONE URL reading; nothing here parses a URL again. */
export type ParsedTarget = { ok: true; hostname: string; endpoint: string; pooled: boolean } | { ok: false; problem: string };
export type ModeCheck = { ok: true; mode: "pooled" } | { ok: false; reason: string };

/**
 * The first concurrency run must use the branch's POOLED connection string —
 * the form production uses — so that what is proven is the pooled path. This
 * is a local rule of this one smoke, applied to the target the shared check
 * already validated and confirmed; it adds a refusal and removes none. The
 * hostname's first label must be exactly `<endpoint id>-pooler`, once. Never
 * returns or describes the URL.
 */
export function requirePooledMode(parsed: ParsedTarget): ModeCheck {
  if (!parsed.ok) return { ok: false, reason: "the confirmed target could not be read" };
  const label = parsed.hostname.split(".")[0] ?? "";
  if (!parsed.pooled || !label.endsWith("-pooler")) return { ok: false, reason: 'this run requires the disposable branch\'s POOLED connection string (hostname "<endpoint id>-pooler..."), the form production uses; a direct connection string is refused' };
  if (!/^ep-[a-z0-9]+(-[a-z0-9]+)*$/.test(parsed.endpoint) || parsed.endpoint.endsWith("-pooler") || label !== `${parsed.endpoint}-pooler`) return { ok: false, reason: "the pooled hostname is not exactly <endpoint id>-pooler" };
  return { ok: true, mode: "pooled" };
}

// ------------------------------------------------------------------ exact-owner cleanup

/** The only database capability cleanup needs: one parameterized statement at a time. */
export type QueryDb = { q(text: string, params?: unknown[]): Promise<Array<Record<string, unknown>>> };

/**
 * A database handle that can be switched off. Cleanup is handed ONLY this:
 * `q` refuses, without sending anything, once `active()` is false — so a
 * cleanup loop that keeps running after it was abandoned cannot write.
 */
export type CleanupGate = { active(): boolean; q: QueryDb["q"] };
export const openGate = (db: QueryDb): CleanupGate => ({ active: () => true, q: (text, params) => db.q(text, params) });

class CleanupStopped extends Error {}

/**
 * What is KNOWN about one statement.
 *   confirmed             the database answered: it applied.
 *   refused_by_database   the database answered with an error: it did not apply.
 *   no_answer             it was sent and its answer never arrived: it may or may not have applied.
 *   in_flight             it was sent and has not settled yet: it may still apply.
 *   not_attempted         it was never sent.
 */
export type StatementOutcome = "confirmed" | "refused_by_database" | "no_answer" | "in_flight" | "not_attempted";

/**
 * One cleanup's running account, filled in AS statements settle — including
 * after the hook that started it gave up waiting. Holds no error text: only
 * outcomes, counts, and a SQLSTATE.
 */
export type CleanupProgress = {
  credentials: Array<{ credentialId: string; dispatchRows: StatementOutcome; attemptRow: StatementOutcome }>;
  /** The final read-only look for this run's rows. */
  residue: "not_read" | "in_flight" | "clean" | "rows_remain" | "refused_by_database" | "no_answer";
  residueCounts: { attempts: number; dispatches: number } | null;
  /** SQLSTATE of a statement the database refused, when it gave one. */
  sqlState: string | null;
  /** Why the loop ended before its end, if it did. */
  stopped: null | "a_statement_failed" | "switched_off";
};

export type CleanupSummary = {
  /**
   *   confirmed   every delete was confirmed and the look found nothing left.
   *   incomplete  the database refused something, or rows remain, or statements were never sent — nothing is in doubt.
   *   uncertain   at least one issued statement has no known outcome.
   */
  status: "confirmed" | "incomplete" | "uncertain";
  statements: { total: number; confirmed: number; refusedByDatabase: number; noAnswer: number; inFlight: number; notAttempted: number };
  residue: CleanupProgress["residue"];
  /** True while an issued request has no known outcome: it may still take effect. */
  mayStillComplete: boolean;
};

const isSqlState = (error: unknown): boolean => /^[0-9A-Z]{5}$/.test(String((error as { code?: unknown } | null)?.code ?? ""));
const sqlStateOf = (error: unknown): string | null => (isSqlState(error) ? String((error as { code: unknown }).code) : null);

export function beginCleanupProgress(fixtures: RunFixtures): CleanupProgress {
  return { credentials: fixtures.ownedCredentialIds().map((credentialId) => ({ credentialId, dispatchRows: "not_attempted", attemptRow: "not_attempted" })), residue: "not_read", residueCounts: null, sqlState: null, stopped: null };
}

export function summarizeCleanup(progress: CleanupProgress): CleanupSummary {
  const outcomes = progress.credentials.flatMap((entry) => [entry.dispatchRows, entry.attemptRow]);
  const count = (outcome: StatementOutcome) => outcomes.filter((value) => value === outcome).length;
  const statements = { total: outcomes.length, confirmed: count("confirmed"), refusedByDatabase: count("refused_by_database"), noAnswer: count("no_answer"), inFlight: count("in_flight"), notAttempted: count("not_attempted") };
  const mayStillComplete = statements.inFlight > 0 || statements.noAnswer > 0 || progress.residue === "in_flight";
  const status = statements.confirmed === statements.total && progress.residue === "clean" ? "confirmed" : mayStillComplete || progress.residue === "no_answer" ? "uncertain" : "incomplete";
  return { status, statements, residue: progress.residue, mayStillComplete };
}

/**
 * Removes exactly the fixtures the registry holds, one exact id per
 * statement, in order — and STOPS at the first statement that fails, or the
 * moment its gate is switched off. Before EACH statement it re-checks the
 * gate and the id's ownership. It never retries, never widens a statement,
 * and never throws. The registry forgets an id only when this whole cleanup
 * is confirmed: every delete answered, and the final look found nothing.
 */
export async function removeOwnedFixtures(fixtures: RunFixtures, gate: CleanupGate, progress: CleanupProgress = beginCleanupProgress(fixtures)): Promise<CleanupProgress> {
  const statements = fixtures.cleanupStatements();
  const entryFor = (credentialId: string) => progress.credentials.find((entry) => entry.credentialId === credentialId);
  for (const statement of statements) {
    const entry = entryFor(statement.credentialId);
    if (!gate.active() || !entry) {
      progress.stopped = "switched_off";
      return progress;
    }
    fixtures.assertOwnedCredential(statement.credentialId);
    entry[statement.target] = "in_flight";
    try {
      await gate.q(statement.text, statement.params);
      entry[statement.target] = "confirmed";
    } catch (error) {
      if (error instanceof CleanupStopped) {
        entry[statement.target] = "not_attempted";
        progress.stopped = "switched_off";
        return progress;
      }
      entry[statement.target] = isSqlState(error) ? "refused_by_database" : "no_answer";
      progress.sqlState = sqlStateOf(error);
      progress.stopped = "a_statement_failed";
      return progress;
    }
  }
  if (!gate.active()) {
    progress.stopped = "switched_off";
    return progress;
  }
  progress.residue = "in_flight";
  try {
    // Read-only. A pattern is used ONLY here, to look — never to delete.
    const row = (await gate.q("SELECT (SELECT count(*) FROM registration_attempts WHERE credential_id LIKE $1)::int AS attempts, (SELECT count(*) FROM registration_provisioning_dispatches WHERE credential_id LIKE $1)::int AS dispatches", [`smoke-${fixtures.runId}-pl-%`]))[0];
    const attempts = Number(row?.attempts);
    const dispatches = Number(row?.dispatches);
    if (!row || !Number.isSafeInteger(attempts) || !Number.isSafeInteger(dispatches)) {
      progress.residue = "no_answer";
      return progress;
    }
    progress.residueCounts = { attempts, dispatches };
    progress.residue = attempts === 0 && dispatches === 0 ? "clean" : "rows_remain";
  } catch (error) {
    if (error instanceof CleanupStopped) {
      progress.residue = "not_read";
      progress.stopped = "switched_off";
      return progress;
    }
    progress.residue = isSqlState(error) ? "refused_by_database" : "no_answer";
    progress.sqlState = progress.sqlState ?? sqlStateOf(error);
    return progress;
  }
  // Forget only what THIS cleanup conclusively removed, and only if it is still the authorized one.
  if (progress.residue === "clean" && gate.active()) fixtures.forget(progress.credentials.map((entry) => entry.credentialId));
  return progress;
}

// ------------------------------------------------------------------ run lifecycle

/** Whether Vitest itself has recorded the just-finished test as failed (an assertion, a thrown error, or ITS timeout). Unreadable state counts as failed. */
export function caseFailedInVitest(context: unknown): boolean {
  const result = (context as { task?: { result?: { state?: unknown; errors?: unknown } } } | null | undefined)?.task?.result;
  if (!result || typeof result !== "object") return true;
  if (Array.isArray(result.errors) && result.errors.length > 0) return true;
  return result.state !== "pass" && result.state !== "run";
}

/** One afterEach: either why nothing was sent, or the live account of what was. */
export type CleanupRecord = {
  after: string | null;
  skipped: string | null;
  progress: CleanupProgress | null;
  /**
   * True ONLY when the lifecycle itself saw this cleanup finish, confirmed,
   * inside its deadline. A cleanup that was interrupted stays `false` for
   * good — even if its last statement later answers and its account then
   * reads as complete — because by then the run had already moved on.
   */
  accepted: boolean;
};
export type ReportedCleanup = { after: string | null; skipped: string | null; accepted: boolean; summary: CleanupSummary | null; credentials: CleanupProgress["credentials"]; residueCounts: CleanupProgress["residueCounts"]; sqlState: string | null };

export type FinalReport = {
  outcome: "not_started" | "completed_clean" | "completed_baseline_mismatch" | "poisoned_evidence_preserved";
  /** True ONLY when every case ran, every cleanup was confirmed, and the post-run baseline comparison passed. */
  databaseRestored: boolean;
  baselineCompared: boolean;
  poisoned: string | null;
  stillInFlight: { caseBody: string | null; cleanup: string | null };
  executed: string[];
  notExecuted: string[];
  /**
   * Identifiers minted by this run that no cleanup has confirmed removed.
   * Their CURRENT database presence has NOT been verified: after a partial
   * cleanup some of their rows may already be gone (see `cleanups`).
   */
  registryCredentialIds: string[];
  cleanups: ReportedCleanup[];
  /**
   * Totals over every cleanup the lifecycle did NOT accept as confirmed (one
   * that was interrupted, refused, or left in doubt). `confirmed` here means
   * "that statement DID delete its rows". All zero only when no cleanup was
   * interrupted.
   */
  unconfirmedCleanup: { cleanups: number; confirmed: number; refusedByDatabase: number; noAnswer: number; inFlight: number; notAttempted: number; residue: CleanupProgress["residue"] | null; mayStillComplete: boolean };
  action: string;
};

const INVESTIGATE = "Investigate the disposable branch read-only. Do not reuse or automatically repair the branch.";

/**
 * The run's one state machine. Rules, none of which can be undone during a run:
 *
 *   - `poison` is permanent. It is set by a case that throws, by a case or a
 *     cleanup that outlives its deadline, by a write that fails, by an
 *     uncertain outcome, by a cleanup that is not confirmed, and by any
 *     overlap between a case body and a cleanup.
 *   - A case starts only if the run is armed, not poisoned, NO earlier case
 *     body is in flight, NO cleanup is in flight, and the previous case's
 *     cleanup was confirmed — checked before the body, i.e. before any
 *     database activity of that case.
 *   - Anything abandoned (its await timed out) is NOT assumed cancelled: a
 *     body or a cleanup stays "in flight" until it really settles.
 *   - Cleanup runs only after a case that finished cleanly, through a gate
 *     this lifecycle can switch off. The gate is checked before EVERY
 *     statement, so once the run is poisoned or the cleanup's deadline has
 *     passed, a cleanup loop that is still running sends nothing further.
 *   - A poisoned run is never cleaned up — not by this hook, not by a later
 *     one, not at the end — and a cleanup that was not confirmed is never
 *     sent again.
 */
export function createRunLifecycle(input: { expectedCases: readonly string[]; caseDeadlineMs: number; cleanupDeadlineMs: number; fixtures: RunFixtures; db: () => QueryDb }) {
  for (const ms of [input.caseDeadlineMs, input.cleanupDeadlineMs]) if (!Number.isSafeInteger(ms) || ms < 1) throw new Error("provisioning limits smoke: a deadline must be a positive whole number of milliseconds");
  let armed = false;
  let poisoned: string | null = null;
  let inFlight: string | null = null;
  /** The case whose cleanup is being sent right now — set before the first statement, cleared only when the cleanup really settles. */
  let cleanupInFlight: string | null = null;
  /** A case that ran and whose cleanup has not yet been confirmed. */
  let awaitingCleanup: string | null = null;
  let cleanupInvocation = 0;
  let lastCase: string | null = null;
  const executed: string[] = [];
  const cleanups: CleanupRecord[] = [];

  const poison = (reason: string): void => {
    if (poisoned === null) poisoned = reason; // the FIRST reason is kept; nothing ever clears it
  };
  const refusal = (what: string) => new Error(`provisioning limits smoke: ${what} refused — the run is poisoned (${String(poisoned)}). A failed live run stops here; it is never retried automatically.`);
  const record = (entry: Omit<CleanupRecord, "after" | "accepted">): CleanupRecord => {
    const full = { after: lastCase, accepted: false, ...entry };
    cleanups.push(full);
    return full;
  };

  return {
    /** Called once, after the read-only preflight passed and the baseline was recorded. */
    arm(): void {
      armed = true;
    },
    isArmed: (): boolean => armed,
    poison,
    poisoned: (): string | null => poisoned,
    inFlight: (): string | null => inFlight,
    cleanupInFlight: (): string | null => cleanupInFlight,
    executed: (): string[] => [...executed],
    cleanups: (): CleanupRecord[] => [...cleanups],

    /** Runs one live case. Refuses BEFORE calling `body` unless the run is armed, clean, idle, and cleaned up. */
    async runCase<T>(name: string, body: () => Promise<T>): Promise<T> {
      if (!armed) throw new Error("provisioning limits smoke: not run — the read-only preflight did not pass, so nothing may be written");
      if (inFlight !== null) poison(`"${inFlight}" was still running when "${name}" was about to start`);
      if (cleanupInFlight !== null) poison(`the cleanup after "${cleanupInFlight}" was still in flight when "${name}" was about to start; its statements may still complete`);
      if (awaitingCleanup !== null) poison(`the cleanup after "${awaitingCleanup}" was never confirmed before "${name}" was about to start`);
      if (!input.expectedCases.includes(name) || executed.includes(name)) poison(`"${name}" is not an expected case, or was started twice`);
      if (poisoned !== null) throw refusal(`"${name}" was not run: starting it was`);

      inFlight = name;
      lastCase = name;
      // The body stays in flight until IT settles — never merely because nobody is awaiting it any more.
      const tracked = body().then(
        (value) => {
          if (inFlight === name) inFlight = null;
          return value;
        },
        (error: unknown) => {
          poison(`"${name}" failed`);
          if (inFlight === name) inFlight = null;
          throw error;
        },
      );
      tracked.catch(() => undefined); // an abandoned body's late failure is already recorded as poison
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          poison(`"${name}" exceeded its ${input.caseDeadlineMs} ms deadline; its database requests may still be running or may still complete`);
          reject(new Error(`provisioning limits smoke: "${name}" exceeded its deadline. Its outcome is uncertain; nothing is retried.`));
        }, input.caseDeadlineMs);
      });
      try {
        const value = await Promise.race([tracked, deadline]);
        // A helper inside the body may have poisoned the run and had its error swallowed: still a failure.
        if (poisoned !== null) throw refusal(`"${name}" was not counted as run: completing it was`);
        executed.push(name);
        awaitingCleanup = name;
        return value;
      } finally {
        clearTimeout(timer);
      }
    },

    /** Before ANY write to the database. Throws — without touching anything — once the run is poisoned, a cleanup is in flight, or no case is running. */
    beforeWrite(what: string): void {
      if (!armed) throw new Error(`provisioning limits smoke: ${what} refused — the preflight did not pass`);
      if (cleanupInFlight !== null) poison(`a write (${what}) was attempted while the cleanup after "${cleanupInFlight}" was in flight`);
      if (poisoned !== null) throw refusal(what);
      if (inFlight === null) {
        poison(`a write (${what}) was attempted outside a running case`);
        throw refusal(what);
      }
    },
    /** One write. A failure poisons the run: it is never repeated, and no other write follows it. */
    async write<T>(what: string, operation: () => Promise<T>): Promise<T> {
      this.beforeWrite(what);
      try {
        return await operation();
      } catch (error) {
        poison(`a database operation failed (${what})`);
        throw error;
      }
    },
    /** An outcome that cannot be told apart from "it may have committed". Poisons; returns the error to throw. */
    uncertain(what: string): Error {
      poison(`uncertain outcome (${what}); the write may or may not have committed`);
      return refusal(`continuing after ${what} was`);
    },

    /**
     * After every test. Cleans up ONLY after a case that finished cleanly;
     * in every other situation it sends nothing. Resolves quietly when it
     * skips (the case itself is already reported as failed); throws when a
     * cleanup it started was not confirmed, or outlived its deadline.
     */
    async afterCase(observed: { reportedFailed: boolean }): Promise<CleanupRecord> {
      if (!armed) return record({ skipped: "the run never started", progress: null });
      if (cleanupInFlight !== null) poison(`the cleanup after "${cleanupInFlight}" was still in flight when another cleanup was due; its statements may still complete`);
      if (inFlight !== null) poison(`"${inFlight}" was still running when its cleanup was due (it timed out or was abandoned); its database requests may still complete`);
      if (observed.reportedFailed) poison(`the test runner reported ${lastCase === null ? "a test" : `"${lastCase}"`} as failed`);
      if (poisoned !== null) return record({ skipped: `nothing was sent: ${poisoned}`, progress: null });

      // Everything below is synchronous up to the first statement: the marker is set BEFORE any asynchronous work.
      const invocation = (cleanupInvocation += 1);
      const owner = lastCase ?? "(no case)";
      let expired = false;
      const database = input.db();
      const gate: CleanupGate = {
        // Checked before every statement: still clean, still inside its deadline, and still the one authorized cleanup.
        active: () => poisoned === null && !expired && cleanupInvocation === invocation,
        q: (text, params) => (gate.active() ? database.q(text, params) : Promise.reject(new CleanupStopped("cleanup switched off"))),
      };
      const progress = beginCleanupProgress(input.fixtures);
      const entry = record({ skipped: null, progress });
      cleanupInFlight = owner;
      // In flight until the loop ITSELF settles — never merely because the deadline passed or the hook was abandoned.
      const tracked = removeOwnedFixtures(input.fixtures, gate, progress).then(
        () => undefined,
        () => void (progress.stopped = progress.stopped ?? "a_statement_failed"),
      );
      void tracked.then(() => {
        if (cleanupInvocation === invocation) cleanupInFlight = null;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          poison(`the cleanup after "${owner}" exceeded its ${input.cleanupDeadlineMs} ms deadline; a statement it already issued may still complete`);
          reject(new Error(`provisioning limits smoke: the cleanup after "${owner}" exceeded its deadline. No further cleanup statement will be sent; what was already issued may still complete. Nothing is retried.`));
        }, input.cleanupDeadlineMs);
      });
      try {
        await Promise.race([tracked, deadline]);
      } finally {
        clearTimeout(timer);
      }
      const summary = summarizeCleanup(progress);
      if (summary.status !== "confirmed") {
        poison(`the cleanup after "${owner}" was ${summary.status} (${summary.statements.confirmed} of ${summary.statements.total} statements confirmed)`);
        throw new Error(`provisioning limits smoke: the cleanup after "${owner}" was ${summary.status}. No further cleanup will be attempted; the database state is unknown.`);
      }
      if (poisoned !== null) throw refusal("counting this cleanup as done was"); // poisoned from elsewhere while it ran
      entry.accepted = true;
      awaitingCleanup = null;
      return entry;
    },

    /**
     * The end of the run. Makes NO write, sends no cleanup, and — once the
     * run is poisoned — reads nothing either. The baseline is compared only
     * for a run that is clean and complete; a poisoned run is never reported
     * as restored.
     */
    async finish(end: { verifyBaseline: () => Promise<boolean> }): Promise<FinalReport> {
      const reported = (): ReportedCleanup[] =>
        cleanups.map((entry) => ({ after: entry.after, skipped: entry.skipped, accepted: entry.accepted, summary: entry.progress ? summarizeCleanup(entry.progress) : null, credentials: entry.progress ? entry.progress.credentials.map((credential) => ({ ...credential })) : [], residueCounts: entry.progress?.residueCounts ?? null, sqlState: entry.progress?.sqlState ?? null }));
      const base = () => {
        const all = reported();
        // Judged by what the lifecycle ACCEPTED at the time — never by an account that only completed later.
        const open = all.filter((entry) => entry.summary !== null && !entry.accepted).map((entry) => entry.summary!);
        const sum = (pick: (statements: CleanupSummary["statements"]) => number) => open.reduce((total, summary) => total + pick(summary.statements), 0);
        return {
          poisoned,
          stillInFlight: { caseBody: inFlight, cleanup: cleanupInFlight },
          executed: [...executed],
          notExecuted: input.expectedCases.filter((name) => !executed.includes(name)),
          registryCredentialIds: input.fixtures.ownedCredentialIds(),
          cleanups: all,
          unconfirmedCleanup: {
            cleanups: open.length,
            confirmed: sum((s) => s.confirmed),
            refusedByDatabase: sum((s) => s.refusedByDatabase),
            noAnswer: sum((s) => s.noAnswer),
            inFlight: sum((s) => s.inFlight),
            notAttempted: sum((s) => s.notAttempted),
            residue: open.length > 0 ? open[open.length - 1]!.residue : null,
            mayStillComplete: open.some((summary) => summary.mayStillComplete),
          },
        };
      };
      if (!armed) return { outcome: "not_started", databaseRestored: false, baselineCompared: false, ...base(), action: "Nothing was written." };
      if (inFlight !== null) poison(`"${inFlight}" was still running at the end of the run`);
      if (cleanupInFlight !== null) poison(`the cleanup after "${cleanupInFlight}" was still in flight at the end of the run`);
      if (poisoned === null && base().notExecuted.length > 0) poison("not every expected case ran");
      if (poisoned === null && awaitingCleanup !== null) poison(`the cleanup after "${awaitingCleanup}" was never confirmed`);
      if (poisoned === null) {
        let unchanged = false;
        try {
          unchanged = await end.verifyBaseline();
        } catch {
          poison("the post-run baseline comparison could not be read");
        }
        if (poisoned === null) {
          return unchanged
            ? { outcome: "completed_clean", databaseRestored: true, baselineCompared: true, ...base(), action: "None. Every case ran, every cleanup was confirmed, and the database matches its pre-run baseline." }
            : { outcome: "completed_baseline_mismatch", databaseRestored: false, baselineCompared: true, ...base(), action: `Every case ran and every cleanup was confirmed, but the database does NOT match its pre-run baseline. ${INVESTIGATE}` };
        }
      }
      const facts = base();
      const u = facts.unconfirmedCleanup;
      const action =
        u.cleanups === 0
          ? `The run is poisoned. No cleanup was started after the failure, so the harness itself deleted none of the rows of the identifiers in registryCredentialIds — but their presence was not verified, and a request that was still in flight may have changed them. The database was NOT restored and will not match its pre-run baseline. ${INVESTIGATE}`
          : `The database state is unknown after this failure. Some run-owned rows may have been deleted, and some may remain. A cleanup was interrupted; of its delete statements — confirmed (those rows ARE deleted): ${u.confirmed}; refused by the database: ${u.refusedByDatabase}; sent with no known outcome${u.mayStillComplete ? " (may still complete)" : ""}: ${u.noAnswer + u.inFlight}; never sent: ${u.notAttempted}. Its final look for leftover rows: ${String(u.residue)}. The database was NOT restored. ${INVESTIGATE}`;
      return { outcome: "poisoned_evidence_preserved", databaseRestored: false, baselineCompared: false, ...facts, action };
    },
  };
}
export type RunLifecycle = ReturnType<typeof createRunLifecycle>;

// ------------------------------------------------------------------ evidence file

/** Anything that could name the database or a secret. Evidence holding any of these is not written or printed. */
const UNSAFE_EVIDENCE = /postgres(?:ql)?:\/\/|\bep-[a-z0-9]+(?:-[a-z0-9]+)+|-pooler\b|neon\.tech|\.aws\.|password|api[_-]?key|private[_-]?key|secret/i;

export type EvidenceWrite = { ok: true; file: string } | { ok: false; reason: "invalid_run_id" | "unsafe_content" | "already_exists" | "write_failed"; code: string | null };

/** The evidence as one JSON string, or null when it is not serializable or holds something it must never hold. */
export function safeEvidenceJson(evidence: unknown): string | null {
  let json: string;
  try {
    json = JSON.stringify(evidence);
  } catch {
    return null;
  }
  return typeof json === "string" && !UNSAFE_EVIDENCE.test(json) ? json : null;
}

/**
 * Saves one run's evidence as `<directory>/provisioning-limits-smoke-<run id>.json`.
 * The name is built from a validated 8-hex run id and nothing else (no path
 * can be smuggled in); the file is created exclusively (an existing file is
 * NEVER overwritten) and readable by its owner only. Returns a classification
 * — never an error message, never a path outside `directory`.
 */
export function writeEvidenceFile(input: { directory: string; runId: string; evidence: unknown }): EvidenceWrite {
  if (!RUN_ID.test(input.runId)) return { ok: false, reason: "invalid_run_id", code: null };
  const json = safeEvidenceJson(input.evidence);
  if (json === null) return { ok: false, reason: "unsafe_content", code: null };
  const file = path.join(input.directory, `provisioning-limits-smoke-${input.runId}.json`);
  try {
    mkdirSync(input.directory, { recursive: true, mode: 0o700 });
    writeFileSync(file, json, { flag: "wx", mode: 0o600 });
  } catch (error) {
    const code = String((error as { code?: unknown } | null)?.code ?? "");
    return { ok: false, reason: code === "EEXIST" ? "already_exists" : "write_failed", code: /^[A-Z0-9_]{1,24}$/.test(code) ? code : null };
  }
  return { ok: true, file };
}

/**
 * The run's verdict: it passes ONLY when the lifecycle ended clean AND its
 * evidence was durably saved. A clean run whose evidence could not be saved
 * is a failure — reported, never retried, and never a reason to touch the
 * database again.
 */
export function concludeRun(final: FinalReport, saved: EvidenceWrite): { pass: boolean; verdict: "clean_and_evidenced" | "clean_but_not_evidenced" | "not_clean"; message: string } {
  if (final.outcome !== "completed_clean" || !final.databaseRestored) return { pass: false, verdict: "not_clean", message: `provisioning limits smoke: ${final.outcome}. ${final.action}${saved.ok ? "" : ` The evidence file was also NOT saved (${saved.reason}).`}` };
  if (!saved.ok) return { pass: false, verdict: "clean_but_not_evidenced", message: `provisioning limits smoke: every case ran and the database matches its baseline, but the evidence file was NOT saved (${saved.reason}), so this is not an evidenced successful run. Nothing is retried and the database is not touched again.` };
  return { pass: true, verdict: "clean_and_evidenced", message: "provisioning limits smoke: completed clean, evidence saved." };
}
