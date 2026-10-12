import { TURNKEY_API_BASE_URL } from "@/lib/real/constants";
import { parseDatabaseUrl, unquoteEnvValue } from "../lib/real/fixtures/handles-smoke-db";

/**
 * TEST-ONLY operator safety for the three manual admin runners in this
 * directory. They are operations, not tests: unlike the disposable-branch
 * smokes they may legitimately target the REAL database, so nothing here
 * refuses a target for being real, reads `.env.local`, or falls back to
 * application configuration. What it requires instead is that the operator
 * names the database they mean to touch, and that nothing else is armed:
 *
 *  - the runner's own primary gate is exactly "1";
 *  - DATABASE_URL is supplied explicitly and passes the same strict URL
 *    grammar the smokes use (one parser — handles-smoke-db.ts);
 *  - REAL_ADMIN_EXPECTED_ENDPOINT_ID and REAL_ADMIN_EXPECTED_DATABASE_NAME
 *    equal that URL's endpoint and database exactly;
 *  - no smoke gate, no branch variable, and no REAL_ADMIN_* variable other
 *    than the ones THIS runner documents is set (another runner's gate or
 *    commit flag included).
 *
 * The expected endpoint and database name are the operator's own statement,
 * read from the Neon dashboard. This code checks that the URL matches what
 * was typed; it cannot check that anyone looked at the dashboard.
 *
 * Every function is pure over the `env` it is given and never returns,
 * throws, or logs a URL, a credential, or an identifier the operator passed.
 */
export type Env = Record<string, string | undefined>;

export const EXPECTED_ENDPOINT_ENV = "REAL_ADMIN_EXPECTED_ENDPOINT_ID";
export const EXPECTED_DATABASE_ENV = "REAL_ADMIN_EXPECTED_DATABASE_NAME";
export const COMMIT_CONFIRMATION_ENV = "REAL_ADMIN_COMMIT_CONFIRMATION";

export type AdminRunner = {
  /** Stable name; the first field of a commit confirmation. */
  name: string;
  primaryGate: string;
  commitGate: string;
  /** Every OTHER REAL_ADMIN_* variable this runner documents. Anything not listed here (or above) is a refusal. */
  variables: readonly string[];
  /** Whether a commit also needs REAL_ADMIN_COMMIT_CONFIRMATION (the backfill binds its commit to a preview digest instead). */
  confirmsCommit: boolean;
};

export const ADMIN_RUNNERS = {
  backfill: {
    name: "backfill-turnkey-authenticator-ids",
    primaryGate: "REAL_ADMIN_BACKFILL_TURNKEY_AUTHENTICATOR_IDS",
    commitGate: "REAL_ADMIN_BACKFILL_COMMIT",
    variables: ["REAL_ADMIN_BACKFILL_EXPECTED_COUNT", "REAL_ADMIN_BACKFILL_PREVIEW_DIGEST"],
    confirmsCommit: false,
  },
  poll: {
    name: "poll-provisioning-activity",
    primaryGate: "REAL_ADMIN_POLL_PROVISIONING_ACTIVITY",
    commitGate: "REAL_ADMIN_POLL_COMMIT",
    variables: ["REAL_ADMIN_CREDENTIAL_ID", "REAL_ADMIN_DISPATCH_SEQ"],
    confirmsCommit: true,
  },
  resolve: {
    name: "resolve-passkey-revocation",
    primaryGate: "REAL_ADMIN_RESOLVE_PASSKEY_REVOCATION",
    commitGate: "REAL_ADMIN_RESOLVE_COMMIT",
    variables: ["REAL_ADMIN_APP_USER_ID", "REAL_ADMIN_REVOCATION_ATTEMPT_ID"],
    confirmsCommit: true,
  },
} as const satisfies Record<string, AdminRunner>;

/** A refusal. Its message is safe to print: it names variables and rules, never values. */
export class AdminRefusal extends Error {
  constructor(runner: AdminRunner, reason: string) {
    super(`admin runner ${runner.name} refused: ${reason}`);
    this.name = "AdminRefusal";
  }
}

export type AdminTarget = { url: string; endpoint: string; database: string };
type Resolved = ({ ok: true } & AdminTarget) | { ok: false; reason: string };

const BARE_ENDPOINT = /^ep-[a-z0-9]+(-[a-z0-9]+)*$/;
const DATABASE_NAME = /^[A-Za-z0-9_-]+$/;

/** The REAL_ADMIN_* variables this runner may see: its two gates, its own documented variables, and the shared confirmations. */
function allowedAdminVariables(runner: AdminRunner): Set<string> {
  return new Set([runner.primaryGate, runner.commitGate, ...runner.variables, EXPECTED_ENDPOINT_ENV, EXPECTED_DATABASE_ENV, ...(runner.confirmsCommit ? [COMMIT_CONFIRMATION_ENV] : [])]);
}

/**
 * The confirmed admin target, or why not. In order: the primary gate; no
 * smoke gate, branch variable, or undocumented REAL_ADMIN_* variable; a
 * DATABASE_URL whose endpoint is unambiguous; the operator's expected
 * endpoint id and database name, each matching exactly. On success `url` is
 * the ONE canonical string that was validated — the only thing a runner may
 * hand to a database connector.
 */
export function resolveAdminTarget(input: { env: Env; runner: AdminRunner }): Resolved {
  const { env, runner } = input;
  if (env[runner.primaryGate] !== "1") return { ok: false, reason: `${runner.primaryGate} is not set to exactly 1` };
  const allowed = allowedAdminVariables(runner);
  for (const name of Object.keys(env).sort()) {
    if (name.startsWith("REAL_SMOKE_")) return { ok: false, reason: `a smoke gate or smoke variable is set (${name})` };
    if (name.startsWith("NEON_BRANCH_")) return { ok: false, reason: `a disposable-branch variable is set (${name})` };
    if (name.startsWith("REAL_ADMIN_") && !allowed.has(name)) return { ok: false, reason: `an admin variable this runner does not use is set (${name})` };
  }
  if (env.DATABASE_URL === undefined || env.DATABASE_URL.trim() === "") return { ok: false, reason: "DATABASE_URL is not set (the target is never taken from .env.local or any other configuration)" };
  // Canonicalized ONCE: surrounding whitespace and one balanced pair of quotes removed. Validated and returned as this exact string.
  const url = unquoteEnvValue(env.DATABASE_URL.trim());
  if (url === null) return { ok: false, reason: "DATABASE_URL has unbalanced or stray quotes" };
  const parsed = parseDatabaseUrl(url, false);
  if (!parsed.ok) return { ok: false, reason: `DATABASE_URL ${parsed.problem}` };
  const database = new URL(url).pathname.slice(1); // the parser has already required exactly one plain path segment

  const expectedEndpoint = env[EXPECTED_ENDPOINT_ENV];
  if (expectedEndpoint === undefined || expectedEndpoint === "") return { ok: false, reason: `${EXPECTED_ENDPOINT_ENV} is not set (read the endpoint id from the Neon dashboard)` };
  if (!BARE_ENDPOINT.test(expectedEndpoint) || expectedEndpoint.endsWith("-pooler")) return { ok: false, reason: `${EXPECTED_ENDPOINT_ENV} is not a bare endpoint id (ep-..., without "-pooler", quotes, or a hostname)` };
  if (expectedEndpoint !== parsed.endpoint) return { ok: false, reason: `DATABASE_URL's endpoint does not match ${EXPECTED_ENDPOINT_ENV}` };

  const expectedDatabase = env[EXPECTED_DATABASE_ENV];
  if (expectedDatabase === undefined || expectedDatabase === "") return { ok: false, reason: `${EXPECTED_DATABASE_ENV} is not set (read the database name from the Neon dashboard)` };
  if (!DATABASE_NAME.test(expectedDatabase)) return { ok: false, reason: `${EXPECTED_DATABASE_ENV} is not a plain database name` };
  if (expectedDatabase !== database) return { ok: false, reason: `DATABASE_URL's database does not match ${EXPECTED_DATABASE_ENV}` };

  return { ok: true, url, endpoint: parsed.endpoint, database };
}

/** resolveAdminTarget, or a throw. The first thing a runner does — before any import that could reach a database or Turnkey. */
export function requireAdminTarget(input: { env: Env; runner: AdminRunner }): AdminTarget {
  const resolved = resolveAdminTarget(input);
  if (!resolved.ok) throw new AdminRefusal(input.runner, resolved.reason);
  return { url: resolved.url, endpoint: resolved.endpoint, database: resolved.database };
}

/**
 * Turnkey requests from an admin runner go only to the repository's one
 * approved host (lib/real/constants.ts, also the server config's default).
 * A TURNKEY_API_BASE_URL override naming anything else is refused before any
 * request; unset, or set to exactly the approved value, is fine.
 */
export function requireApprovedTurnkeyHost(input: { env: Env; runner: AdminRunner }): void {
  const override = input.env.TURNKEY_API_BASE_URL;
  if (override !== undefined && override.trim() !== "" && override.trim() !== TURNKEY_API_BASE_URL) {
    throw new AdminRefusal(input.runner, "TURNKEY_API_BASE_URL overrides the approved Turnkey API host");
  }
}

/** The same rule, on the resolved server config a runner is about to use (belt and braces: this is the value requests are built from). */
export function requireApprovedTurnkeyConfig(input: { config: { turnkeyApiBaseUrl: string }; runner: AdminRunner }): void {
  if (input.config.turnkeyApiBaseUrl !== TURNKEY_API_BASE_URL) throw new AdminRefusal(input.runner, "the resolved Turnkey API host is not the approved one");
}

/** The exact confirmation a commit of `operation` on `target` requires. Never printed by a runner: the operator composes it. */
export function commitConfirmation(runner: AdminRunner, target: Pick<AdminTarget, "endpoint" | "database">, operation: readonly string[]): string {
  return [runner.name, `${target.endpoint}/${target.database}`, ...operation].join(":");
}

/**
 * Whether this run commits. Dry run unless the runner's own commit flag is
 * exactly "1" — and a commit flag is never honored on its own:
 *
 *  - any other value of the flag ("0", "true", "yes", empty) is a refusal,
 *    not a silent dry run;
 *  - a runner that confirms commits also needs REAL_ADMIN_COMMIT_CONFIRMATION
 *    to equal commitConfirmation(...) exactly, which names the runner, the
 *    endpoint and database, and the one operation — so a flag left exported
 *    from an earlier run, or meant for another target, commits nothing;
 *  - a confirmation set WITHOUT the commit flag is refused too (stale state).
 */
export function requireCommitDecision(input: { env: Env; runner: AdminRunner; target: Pick<AdminTarget, "endpoint" | "database">; operation: readonly string[] }): boolean {
  const { env, runner } = input;
  const flag = env[runner.commitGate];
  const confirmation = runner.confirmsCommit ? env[COMMIT_CONFIRMATION_ENV] : undefined;
  if (flag === undefined) {
    if (confirmation !== undefined) throw new AdminRefusal(runner, `${COMMIT_CONFIRMATION_ENV} is set without ${runner.commitGate}; unset it for a dry run`);
    return false;
  }
  if (flag !== "1") throw new AdminRefusal(runner, `${runner.commitGate} must be exactly 1, or unset for a dry run`);
  if (!runner.confirmsCommit) return true;
  if (input.operation.some((part) => part === "" || part.includes(":"))) throw new AdminRefusal(runner, "the operation's identifiers are missing or malformed, so a commit cannot be confirmed");
  if (confirmation === undefined || confirmation === "") throw new AdminRefusal(runner, `${runner.commitGate} is set but ${COMMIT_CONFIRMATION_ENV} is not; a commit must name its runner, endpoint/database, and operation`);
  if (confirmation !== commitConfirmation(runner, input.target, input.operation)) throw new AdminRefusal(runner, `${COMMIT_CONFIRMATION_ENV} does not match this runner, target, and operation`);
  return true;
}

/** A dispatch sequence number as the poller accepts it: a positive whole number, written plainly. */
const DISPATCH_SEQ = /^[1-9][0-9]{0,8}$/;

/**
 * The poll runner's selection and commit decision, together, because they
 * depend on each other: WHICH dispatch a commit records must be fixed by the
 * operator, not re-resolved at commit time.
 *
 *  - `rawSeq` absent selects the attempt's newest dispatch ("latest"). That
 *    is allowed for a DRY RUN only: between a dry run and a commit a newer
 *    dispatch can appear, and "latest" would then silently mean a different
 *    one. A commit therefore requires an explicit sequence — asking for one
 *    with "latest" is refused even when the confirmation says "latest".
 *  - A malformed sequence is refused in either mode.
 *  - The confirmation still names the runner, endpoint/database, credential,
 *    that exact sequence, and "quiescent".
 *
 * An explicit sequence fixes the target; it does NOT show that provisioning
 * is quiescent. That remains the operator's own assessment.
 */
export function requirePollCommitDecision(input: { env: Env; runner: AdminRunner; target: Pick<AdminTarget, "endpoint" | "database">; credentialId: string; rawSeq: string | undefined }): { commit: boolean; dispatchSeq: number | undefined } {
  const { env, runner, rawSeq } = input;
  if (rawSeq !== undefined && rawSeq !== "" && !DISPATCH_SEQ.test(rawSeq)) throw new AdminRefusal(runner, "REAL_ADMIN_DISPATCH_SEQ is not a positive whole number");
  const dispatchSeq = rawSeq ? Number(rawSeq) : undefined;
  if (env[runner.commitGate] !== undefined && dispatchSeq === undefined) {
    throw new AdminRefusal(runner, `${runner.commitGate} is set without REAL_ADMIN_DISPATCH_SEQ; a commit must name one explicit dispatch sequence ("latest" is for dry runs only)`);
  }
  const commit = requireCommitDecision({ env, runner, target: input.target, operation: [input.credentialId, dispatchSeq === undefined ? "latest" : String(dispatchSeq), "quiescent"] });
  return { commit, dispatchSeq };
}

/** What a poll or resolve report says about itself; both production report types carry exactly these. */
export type CommitReport = { outcome: string; reason: string | null; committed: boolean };
export type NotCommittedKind = "previously_processed" | "state_uncertain_or_changed" | "declined";

/**
 * Why a requested commit wrote nothing, read from the report's OWN outcome
 * and reason codes (nothing is inferred beyond them):
 *
 *  - previously_processed: the work was already done before this run (poll:
 *    the dispatch already has its terminal observation; resolve: the attempt
 *    already has its resolution). A benign no-op — NOT corruption, and NOT a
 *    new write by this run.
 *  - state_uncertain_or_changed: a provider read failed or was incomplete, or
 *    the row changed underneath the run, so this run cannot say what the
 *    current state is. Read again before any new attempt.
 *  - declined: the evidence or input did not allow a commit; nothing changed.
 */
const NOT_COMMITTED: Record<string, { previouslyProcessed: readonly string[]; uncertainOrChanged: readonly string[] }> = {
  [ADMIN_RUNNERS.poll.name]: { previouslyProcessed: ["refused/already_terminal"], uncertainOrChanged: ["refused/turnkey_read_failed", "pending/observation_not_recorded", "terminal/observation_not_recorded"] },
  [ADMIN_RUNNERS.resolve.name]: { previouslyProcessed: ["already_resolved"], uncertainOrChanged: ["turnkey_read_failed", "turnkey_read_incomplete", "activity_log_changed", "lost_race"] },
};

export function classifyNotCommitted(runner: AdminRunner, report: CommitReport): NotCommittedKind {
  const table = NOT_COMMITTED[runner.name];
  // The poll report's outcome is coarse (refused / pending / terminal), so its reason code is part of the key; the resolver's outcome is specific on its own.
  const key = runner.name === ADMIN_RUNNERS.poll.name ? `${report.outcome}/${report.reason ?? ""}` : report.outcome;
  if (table?.previouslyProcessed.includes(key)) return "previously_processed";
  if (table?.uncertainOrChanged.includes(key)) return "state_uncertain_or_changed";
  return "declined";
}

/** A requested commit that committed nothing. Its message carries only the report's outcome and reason codes. */
export class AdminCommitNotApplied extends Error {
  constructor(
    runner: AdminRunner,
    readonly kind: NotCommittedKind,
    readonly report: CommitReport,
  ) {
    const meaning =
      kind === "previously_processed"
        ? "already processed before this run: a no-op, not a new write and not a data error"
        : kind === "state_uncertain_or_changed"
          ? "the current state is uncertain or changed underneath this run: read again before any new attempt"
          : "the evidence or input did not allow a commit: nothing was changed";
    super(`admin runner ${runner.name}: a COMMIT was requested but NOTHING was committed by this run — outcome=${report.outcome} reason=${report.reason ?? "none"} (${meaning}). Not retried.`);
    this.name = "AdminCommitNotApplied";
  }
}

/**
 * The last step of a poll or resolve run. A run that asked for a commit is a
 * success ONLY if the report says it committed; otherwise this throws, which
 * fails the runner's test, so the process exits nonzero — after the full
 * redacted report has already been printed. A dry run is a success exactly
 * when it wrote nothing. Pure: it reads the report it is given and calls
 * nothing, so it cannot retry, re-read, or write.
 */
export function requireCommitOutcome(input: { runner: AdminRunner; commit: boolean; report: CommitReport }): void {
  const { runner, commit, report } = input;
  if (!commit) {
    if (report.committed) throw new Error(`admin runner ${runner.name}: a DRY RUN reported a write (outcome=${report.outcome})`);
    return;
  }
  if (report.committed) return;
  throw new AdminCommitNotApplied(runner, classifyNotCommitted(runner, report), { outcome: report.outcome, reason: report.reason, committed: false });
}
