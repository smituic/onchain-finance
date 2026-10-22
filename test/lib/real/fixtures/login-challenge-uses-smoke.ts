import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createNeonLoginChallengeUseStore } from "@/lib/real/server/neon-store";
import {
  CASE_DEADLINE_MS,
  CLEANUP_DEADLINE_MS,
  MAX_CONFIGURABLE_SCRATCH_SCHEMAS,
  VITEST_TIMEOUT_MS,
  checkRunnerTimeoutFlags,
  createRunOwnership,
  runCleanupPlan,
  sha256Hex,
  summarizeCleanup,
  type CleanupAccount,
  type CleanupGate,
  type CleanupSummary,
  type DatabaseSnapshot,
  type ProviderTableDescriptor,
  type RunOwnership,
  type ScratchObjectKind,
} from "./provider-budget-smoke";
import { planAdmissionCleanup } from "./registration-admission-smoke";
import { assertPlainIdentifier, caseFailedInVitest, checkExactFileSelection, requirePooledMode, safeEvidenceJson, type QueryDb, type SelectionCheck } from "./provisioning-limits-smoke";

/**
 * TEST-ONLY, PURE safety foundation for a FUTURE disposable-Neon smoke of the 3C-2 used-marker table
 * (real_login_challenge_uses), its migration block, and the production marker statement. Milestone 3C-2.
 *
 * NOTHING HERE CONNECTS. It reads no environment variable by itself (the smoke file passes values in), imports no
 * database driver beyond the production adapter module (whose import opens no connection), and executes no SQL, so
 * every rule is provable offline (login-challenge-uses-smoke-harness.test.ts).
 *
 * NOTHING IN THIS FILE HAS BEEN RUN AGAINST POSTGRESQL. Every SQL text below — fixture writes, catalog reads, activity
 * polls, lock holders — is unexecuted. If one is wrong, the database refuses it, the run is POISONED, and its evidence is
 * preserved.
 *
 * WHAT THIS HARNESS REUSES, UNCHANGED, from the audited Milestone 1 / 3A / 3C-1 harnesses: the exact-file rule, the
 * runner-timeout rule, the pooled-mode rule, the scratch-schema ownership registry and its RESTRICT-only drop
 * statements, the cleanup runner, the evidence content screen, and the snapshot types. What it adds is specific to 3C-2.
 *
 * TRANSPORT LIMITS, stated plainly. The repository has neither `pg` nor `ws`, so there is no interactive-transaction
 * transport. Blocking sessions are therefore SCRIPTED BATCHES over the Neon HTTP driver (`db.tx`): a lock-taking
 * statement, a sleep, and then either a commit or a deliberate division-by-zero that rolls the batch back. The
 * PRODUCTION marker statement is always issued through the production adapter over its own (separate) client.
 */

export { CASE_DEADLINE_MS, CLEANUP_DEADLINE_MS, VITEST_TIMEOUT_MS, assertPlainIdentifier, caseFailedInVitest, checkRunnerTimeoutFlags, requirePooledMode, safeEvidenceJson, sha256Hex };
export type { DatabaseSnapshot, ProviderTableDescriptor, QueryDb, RunOwnership, ScratchObjectKind };

export const LOGIN_CHALLENGE_USES_SMOKE_FILE = "test/lib/real/login-challenge-uses.smoke.test.ts";

export function checkLoginChallengeUsesFileSelection(cliArgs: unknown): SelectionCheck {
  return checkExactFileSelection(cliArgs, LOGIN_CHALLENGE_USES_SMOKE_FILE);
}

const TABLE = "real_login_challenge_uses";
const RUN_ID = /^[0-9a-f]{8}$/;
const SQL_STATE = /^[0-9A-Z]{5}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const ISO_UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

// ------------------------------------------------------------------ pinned identities

/** The independently audited migration. The harness refuses to run unless schema.sql still yields exactly this. */
export const MIGRATION_IDENTITY = { name: "Login Challenge Uses", length: 15_070, sha256: "00ff39691a33436ce75d2ff33534983bd408c95574ee4ad8ad9ff6bcdcbf1d1e" } as const;
/** The earlier evidence-bearing blocks, which must remain byte-for-byte unchanged. */
export const EARLIER_MIGRATION_IDENTITIES = [
  { name: "Registration Admission", length: 13_101, sha256: "b269ebcc0953efce79c7504ec451237eca3dc1bc4d67996d7179b5eba26ac91f" },
  { name: "Handle Pay Rate Limits", length: 11_680, sha256: "78c5557d5b615805f0eb8c63e62d09eccffc792c95f9e2782f9af48d92d1513d" },
  { name: "Provider Budgets", length: 11_820, sha256: "8213b46c2f859fb3c8c5457d34d3dff682508d401fcf82b9169b84333c67a5f5" },
] as const;

export type MigrationBlock = { name: string; statement: string; length: number; sha256: string };

/** The block's single DO statement, by the repository's extraction convention (first opening token to last closing END). Throws unless the block appears exactly once. */
export function extractMigrationBlock(schemaText: string, name: string): MigrationBlock {
  const begin = `-- BEGIN ${name}`;
  const end = `-- END ${name}`;
  if (schemaText.split(begin).length !== 2 || schemaText.split(end).length !== 2) throw new Error(`login challenge uses smoke: the ${name} block was not found exactly once in schema.sql`);
  const section = schemaText.slice(schemaText.indexOf(begin), schemaText.indexOf(end));
  const start = section.indexOf("DO $$");
  const finish = section.lastIndexOf("END $$;");
  if (start < 0 || finish < start || section.split("DO $$").length !== 2) throw new Error(`login challenge uses smoke: the ${name} block does not hold exactly one statement`);
  const statement = section.slice(start, finish + "END $$;".length);
  return { name, statement, length: statement.length, sha256: sha256Hex(statement) };
}

export type IdentityCheck = { ok: true } | { ok: false; reason: string };

/** The new block AND the three earlier ones must have exactly the pinned length and digest; anything else refuses (before any database work). */
export function checkMigrationIdentities(schemaText: string): IdentityCheck {
  try {
    for (const expected of [MIGRATION_IDENTITY, ...EARLIER_MIGRATION_IDENTITIES]) {
      const found = extractMigrationBlock(schemaText, expected.name);
      if (found.length !== expected.length || found.sha256 !== expected.sha256) return { ok: false, reason: `the ${expected.name} migration statement differs from its pinned identity` };
    }
    if (schemaText.indexOf("-- BEGIN Provisioning Evidence Capture") < schemaText.indexOf(`-- END ${MIGRATION_IDENTITY.name}`)) return { ok: false, reason: "the Provisioning Evidence block no longer follows the Login Challenge Uses block" };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String((error as Error).message) };
  }
}

export const normalizeSql = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * The audited marker statement, written HERE by hand (never derived from the production text). $1 nonce hex, $2 expiration
 * (the production adapter binds it three times; the numbered form below names it once per use).
 */
export const MARKER_SQL_REFERENCE = `
WITH purged AS (
  DELETE FROM real_login_challenge_uses d
  WHERE d.nonce IN (
    SELECT p.nonce
    FROM real_login_challenge_uses p
    WHERE p.expires_at < now() - interval '1 hour'
    ORDER BY p.expires_at
    LIMIT 64
    FOR UPDATE SKIP LOCKED
  )
)
INSERT INTO real_login_challenge_uses AS u (nonce, expires_at, used_at)
SELECT decode($1::text, 'hex'), $2::timestamptz, clock_timestamp()
WHERE $2::timestamptz > clock_timestamp()
  AND $2::timestamptz <= clock_timestamp() + interval '10 minutes'
ON CONFLICT (nonce) DO NOTHING
RETURNING (u.expires_at > clock_timestamp()) AS live`;

/** The reference in the `$`-joined form a tagged template yields (every $n becomes a bare `$`). */
export const MARKER_SQL_REFERENCE_TEMPLATE = normalizeSql(MARKER_SQL_REFERENCE).replace(/\$[0-9]+/g, "$");
export const MARKER_SQL_REFERENCE_SHA256 = sha256Hex(MARKER_SQL_REFERENCE_TEMPLATE);

export type CapturedMarkerSql = {
  /** The statement exactly as the production adapter produced it, with numbered parameters $1..$n (for db.q). */
  numbered: string;
  /** The `$`-joined, whitespace-normalized form (what the offline adapter tests pin). */
  template: string;
  values: unknown[];
};

/**
 * Obtains the production marker statement FROM THE PRODUCTION ADAPTER ITSELF: createNeonLoginChallengeUseStore is run against a
 * recording fake of the tagged template, so what is captured is the text the adapter really builds — never a re-typed copy.
 * Nothing is executed and nothing connects.
 */
export async function captureProductionMarkerSql(): Promise<CapturedMarkerSql> {
  let captured: { strings: string[]; values: unknown[] } | null = null;
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    captured = { strings: [...strings], values };
    return [{ live: true }];
  }) as never;
  await createNeonLoginChallengeUseStore(sql).consume({ nonceHex: "0".repeat(32), expiresAtIso: "2026-01-01T00:00:00.000Z" });
  const got = captured as { strings: string[]; values: unknown[] } | null;
  if (!got) throw new Error("login challenge uses smoke: the production adapter built no statement");
  const numbered = got.strings.reduce((text, part, index) => text + part + (index < got.values.length ? `$${index + 1}` : ""), "");
  return { numbered, template: normalizeSql(got.strings.join("$")), values: got.values };
}

/** Whether a captured production statement is exactly the pinned reference (whitespace-normalized) with the expected parameter shape. */
export function checkProductionMarkerSql(captured: CapturedMarkerSql): IdentityCheck {
  if (captured.template !== MARKER_SQL_REFERENCE_TEMPLATE) return { ok: false, reason: "the production marker statement differs from its pinned reference" };
  if (sha256Hex(captured.template) !== MARKER_SQL_REFERENCE_SHA256) return { ok: false, reason: "the production marker statement's digest differs" };
  if (captured.values.length !== 4 || captured.values[0] !== "0".repeat(32) || captured.values.slice(1).some((value) => value !== "2026-01-01T00:00:00.000Z")) return { ok: false, reason: "the production marker statement's bound values differ in shape" };
  return { ok: true };
}

/**
 * The SAME production statement aimed at a scratch table: only the three `real_login_challenge_uses` names are qualified with a
 * schema this run owns. Used ONLY to prove PostgreSQL's native error for a table without its unique index. Refuses unless
 * exactly three names were qualified and nothing else changed.
 */
export function markerSqlForSchema(numbered: string, ownership: RunOwnership, schema: string): string {
  ownership.assertOwnedSchema(schema);
  const target = `${assertPlainIdentifier(schema)}.${TABLE}`;
  const occurrences = numbered.split(TABLE).length - 1;
  if (occurrences !== 3) throw new Error("login challenge uses smoke: the production statement does not name the marker table exactly three times");
  const scratch = numbered.split(TABLE).join(target);
  if (scratch.split(target).length - 1 !== 3 || scratch.replace(new RegExp(`${schema}\\.${TABLE}`, "g"), TABLE) !== numbered) throw new Error("login challenge uses smoke: the scratch statement differs from the production statement by more than the table qualification");
  return scratch;
}

/**
 * The ORIGINAL, UNSAFE candidate (purge `expires_at < now()`, insert `WHERE exp > now()`, no post-insert check). It exists ONLY to
 * show, against a registered scratch table, that the interleaving the harness builds really can re-admit a consumed challenge —
 * so the production statement's rejection of it is meaningful. It is never executed against `public`.
 */
export function unsafeCandidateSql(ownership: RunOwnership, schema: string): string {
  ownership.assertOwnedSchema(schema);
  const t = `${assertPlainIdentifier(schema)}.${TABLE}`;
  return `WITH purged AS (DELETE FROM ${t} d WHERE d.expires_at < now()) INSERT INTO ${t} AS u (nonce, expires_at, used_at) SELECT decode($1::text, 'hex'), $2::timestamptz, clock_timestamp() WHERE $2::timestamptz > now() ON CONFLICT (nonce) DO NOTHING RETURNING true AS live`;
}

// ------------------------------------------------------------------ source identity and run authorization

export type SourceIdentity = { parts: Record<string, string>; digest: string; shortDigest: string };

/** The shared helper modules the harness really runs through (target check, pooled/exact-file rules, ownership, cleanup, evidence screen, ids). */
export const SHARED_HELPER_FILES = {
  providerBudgetSmoke: "test/lib/real/fixtures/provider-budget-smoke.ts",
  registrationAdmissionSmoke: "test/lib/real/fixtures/registration-admission-smoke.ts",
  provisioningLimitsSmoke: "test/lib/real/fixtures/provisioning-limits-smoke.ts",
  handlesSmokeDb: "test/lib/real/fixtures/handles-smoke-db.ts",
  smokeRunIds: "test/lib/real/fixtures/smoke-run-ids.ts",
} as const;
export type SharedHelperName = keyof typeof SHARED_HELPER_FILES;

/**
 * The pieces of neon-store.ts that decide HOW the harness reaches the database: the isolation constant, the client factory, and the
 * store-wiring function. (The marker adapter itself is hashed separately.) Throws unless all three are found.
 */
export function extractNeonClientSource(neonStoreText: string): string {
  const pieces: string[] = [];
  const constant = /export const NEON_TRANSACTION_ISOLATION_LEVEL = [^\n]*\n/.exec(neonStoreText)?.[0];
  if (!constant) throw new Error("login challenge uses smoke: the Neon isolation constant was not found");
  pieces.push(constant);
  for (const name of ["createNeonSqlClient", "createNeonDurableStores"]) {
    const start = neonStoreText.indexOf(`export function ${name}(`);
    const end = neonStoreText.indexOf("\n}\n", start);
    if (start < 0 || end < start) throw new Error(`login challenge uses smoke: ${name} was not found`);
    pieces.push(neonStoreText.slice(start, end + 3));
  }
  return pieces.join("\n");
}

/**
 * One digest over everything the operator's confirmation must be tied to: the migration, the pinned marker statement, the exact
 * source of the production adapter function, the two production login-challenge modules, the Neon client factory and store wiring,
 * the shared helper modules the run goes through, AND the two harness files that drive it. Any change to one of them after audit
 * changes the digest, so a stale confirmation can never authorize different code. (A HEAD pin would break at the operator's own
 * checkpoint; this does not.) It is a statement about CODE, never about the database: it is not evidence that the target is a
 * freshly created disposable branch.
 */
export function computeSourceIdentity(input: { schemaText: string; neonStoreText: string; loginChallengeText: string; loginChallengeUsesText: string; harnessSmokeText: string; harnessFixtureText: string; sharedHelpers: Record<SharedHelperName, string> }): SourceIdentity {
  const adapterStart = input.neonStoreText.indexOf("export function createNeonLoginChallengeUseStore");
  const adapterEnd = input.neonStoreText.indexOf("\n}\n", adapterStart);
  if (adapterStart < 0 || adapterEnd < adapterStart) throw new Error("login challenge uses smoke: the production adapter function was not found");
  const helperNames = Object.keys(SHARED_HELPER_FILES) as SharedHelperName[];
  const given = input.sharedHelpers as Record<string, unknown> | null;
  if (!given || Object.keys(given).sort().join(",") !== [...helperNames].sort().join(",") || helperNames.some((name) => typeof given[name] !== "string" || given[name] === "")) throw new Error("login challenge uses smoke: every shared helper module must be supplied, and nothing else");
  const parts: Record<string, string> = {
    migration: extractMigrationBlock(input.schemaText, MIGRATION_IDENTITY.name).sha256,
    markerSqlReference: MARKER_SQL_REFERENCE_SHA256,
    adapterSource: sha256Hex(input.neonStoreText.slice(adapterStart, adapterEnd + 2)),
    neonClientSource: sha256Hex(extractNeonClientSource(input.neonStoreText)),
    loginChallengeModule: sha256Hex(input.loginChallengeText),
    loginChallengeUsesModule: sha256Hex(input.loginChallengeUsesText),
    harnessSmoke: sha256Hex(input.harnessSmokeText),
    harnessFixture: sha256Hex(input.harnessFixtureText),
  };
  for (const name of helperNames) parts[name] = sha256Hex(input.sharedHelpers[name]);
  const digest = sha256Hex(Object.entries(parts).map(([name, value]) => `${name}=${value}`).join("\n"));
  return { parts, digest, shortDigest: digest.slice(0, 16) };
}

/** The Neon console's endpoint id for the branch, as the operator states it (the same variable the shared target check requires). */
export const EXPECTED_ENDPOINT_ENV = "NEON_BRANCH_EXPECTED_ENDPOINT_ID";
const ENDPOINT_ID = /^ep-[a-z0-9]+(-[a-z0-9]+)+$/;

/**
 * The confirmation string the operator must supply for ONE run: the run id and a token over (the source digest, the expected
 * endpoint, the run id). It names no secret. It binds the run to the audited code, to the specific disposable endpoint, and to
 * this run id, so a confirmation for another branch, another run, or other code authorizes nothing here.
 */
export function expectedConfirmation(identity: SourceIdentity, runId: string, endpointId: string): string {
  if (!RUN_ID.test(runId) || !ENDPOINT_ID.test(endpointId)) throw new Error("login challenge uses smoke: a confirmation needs a well-formed run id and endpoint id");
  return `${runId}:${sha256Hex(`${identity.digest}|${endpointId}|${runId}`).slice(0, 16)}`;
}

/** Run ids already spent by earlier smokes: never reusable, even if an operator picked one by accident. */
/**
 * What the evidence says about the target. Matching the operator's expected endpoint proves only that the URL and the operator's statement agree;
 * it is NOT proof that the branch was freshly created or is disposable. That requires the operator's own, independent Neon-console evidence.
 */
export const TARGET_PROOF_STATUS = "the connection target agreed with the operator-supplied expected endpoint before any connection; this is NOT proof that the branch is newly created or disposable, which rests on the operator's separate Neon console evidence";

export const KNOWN_SPENT_RUN_IDS = ["ced714ee", "c20ffc87", "6d32fdf8", "a630d8ff"] as const;
export const RUN_ID_ENV = "LOGIN_CHALLENGE_SMOKE_RUN_ID";
export const CONFIRM_ENV = "LOGIN_CHALLENGE_SMOKE_CONFIRM";

export type RunAuthorization = { ok: true; runId: string } | { ok: false; reason: string };

/**
 * The operator's SEPARATE confirmation for one specific run: an 8-hex run id the operator chose, and the confirmation string
 * `expectedConfirmation` (run id, plus a token over the audited code, the expected endpoint, and the run id). Both must be
 * present, well-formed, unspent, and consistent with the code and endpoint about to be used. Reasons name no secret and never echo
 * a supplied value.
 */
export function checkRunAuthorization(input: { env: Record<string, string | undefined>; identity: SourceIdentity; evidenceDirectory: string; fileExists?: (file: string) => boolean }): RunAuthorization {
  const runId = input.env[RUN_ID_ENV];
  const confirm = input.env[CONFIRM_ENV];
  const endpoint = input.env[EXPECTED_ENDPOINT_ENV];
  if (runId === undefined || runId === "") return { ok: false, reason: `${RUN_ID_ENV} is not set` };
  if (!RUN_ID.test(runId)) return { ok: false, reason: `${RUN_ID_ENV} must be exactly 8 lowercase hex characters` };
  if ((KNOWN_SPENT_RUN_IDS as readonly string[]).includes(runId)) return { ok: false, reason: `${RUN_ID_ENV} names a run id that an earlier smoke already spent` };
  if (endpoint === undefined || !ENDPOINT_ID.test(endpoint)) return { ok: false, reason: `${EXPECTED_ENDPOINT_ENV} is not set to a well-formed endpoint id` };
  if (confirm === undefined || confirm === "") return { ok: false, reason: `${CONFIRM_ENV} is not set (the operator's separate confirmation for this run)` };
  if (confirm !== expectedConfirmation(input.identity, runId, endpoint)) return { ok: false, reason: `${CONFIRM_ENV} does not match this run id, this endpoint, and the source identity about to run` };
  const exists = input.fileExists ?? existsSync;
  for (const stage of ["start", "final"] as const) if (exists(path.join(input.evidenceDirectory, `login-challenge-uses-smoke-${runId}-${stage}.json`))) return { ok: false, reason: "evidence already exists for this run id; a run id is never reused" };
  return { ok: true, runId };
}

// ------------------------------------------------------------------ repository state (recorded, never pinned)

export type GitHead = { ok: true; branch: string; commit: string } | { ok: false; reason: string };

/** The commit a ref names inside a packed-refs file, or null. */
export function findPackedRef(packedRefsText: string, ref: string): string | null {
  for (const line of packedRefsText.split("\n")) {
    const match = /^([0-9a-f]{40}) (\S+)$/.exec(line.trim());
    if (match && match[2] === ref) return match[1]!;
  }
  return null;
}

/**
 * The branch and commit the working tree is on, from the contents of `.git/HEAD` and the ref it names (read by the caller; no git
 * command is run). A detached or unreadable HEAD is REFUSED: the run's evidence must be attributable to a named branch and a
 * commit. Nothing pins WHICH branch or commit — the operator's checkpoint legitimately moves HEAD, so the confirmation is bound to
 * the content of the audited files instead (the source identity) — but the branch and commit are recorded in the evidence.
 */
export function parseGitHead(headText: string, readRef: (ref: string) => string | null): GitHead {
  const match = /^ref: (refs\/heads\/[A-Za-z0-9._\/-]{1,200})\n?$/.exec(headText);
  if (!match) return { ok: false, reason: "the repository HEAD is detached or unreadable" };
  const commit = readRef(match[1]!)?.trim() ?? "";
  if (!/^[0-9a-f]{40}$/.test(commit)) return { ok: false, reason: "the repository HEAD names a branch with no readable commit" };
  return { ok: true, branch: match[1]!.slice("refs/heads/".length), commit };
}

// ------------------------------------------------------------------ budgets

/**
 * Hard, CUMULATIVE ceilings for one run. Never raised at run time; a plan that exceeds one is refused before anything is sent.
 *
 * TIMING, stated plainly. There is NO per-operation timeout and NO request cancellation: an issued statement is tracked until it
 * really settles, and nothing aborts one (an abort could turn an uncertain write into an apparent clean failure). What exists is
 * (1) a CASE deadline (`caseDeadlineMs`) that bounds how long the harness WAITS for a case, (2) a whole-run deadline
 * (`runDeadlineMs`) after which no further operation is admitted, and (3) a cleanup and a comparison deadline. When one fires the
 * run is poisoned, and whatever was still in flight is reported as unsettled: the harness cannot know whether it later took effect.
 * Nothing is retried.
 */
export const CEILINGS = {
  operations: 2_000,
  /** 60 simultaneous marker requests, plus one lock holder, plus one activity poll, plus margin. */
  concurrent: 64,
  fixtureStatements: 90,
  fixtureRows: 700,
  scratchSchemas: 60,
  polls: 400,
  caseDeadlineMs: CASE_DEADLINE_MS,
  runDeadlineMs: 15 * 60 * 1000,
  cleanupOperations: 340,
} as const;

export type ScenarioPlan = { name: string; operations: number; fixtureStatements: number; fixtureRows: number; polls: number; concurrent: number; scratchSchemas: number };
export type BudgetTotals = { operations: number; fixtureStatements: number; fixtureRows: number; polls: number; concurrent: number; scratchSchemas: number; cleanupOperations: number };
export type BudgetCheck = { ok: boolean; totals: BudgetTotals; violations: string[] };

/**
 * The preflight budget: the sum of every scenario's DECLARED worst case, against the ceilings. Cleanup is estimated from the
 * scratch-schema count (an inventory read, a dependency read, a drop of each object, and the schema's own drop) plus the marker
 * cleanup. A plan with a non-integer or negative figure, a duplicate scenario, or any total above its ceiling is refused.
 */
export function planBudget(inventory: readonly ScenarioPlan[], ceilings: { [K in keyof typeof CEILINGS]: number } = CEILINGS): BudgetCheck {
  const violations: string[] = [];
  const names = new Set<string>();
  const totals: BudgetTotals = { operations: 0, fixtureStatements: 0, fixtureRows: 0, polls: 0, concurrent: 0, scratchSchemas: 0, cleanupOperations: 0 };
  for (const scenario of inventory) {
    if (typeof scenario.name !== "string" || scenario.name === "" || names.has(scenario.name)) violations.push("a scenario name is missing or duplicated");
    names.add(scenario.name);
    for (const key of ["operations", "fixtureStatements", "fixtureRows", "polls", "concurrent", "scratchSchemas"] as const) {
      const value = scenario[key];
      if (!Number.isSafeInteger(value) || value < 0) violations.push(`scenario "${scenario.name}" declares a non-whole or negative ${key}`);
    }
    totals.operations += scenario.operations;
    totals.fixtureStatements += scenario.fixtureStatements;
    totals.fixtureRows += scenario.fixtureRows;
    totals.polls += scenario.polls;
    totals.scratchSchemas += scenario.scratchSchemas;
    totals.concurrent = Math.max(totals.concurrent, scenario.concurrent);
  }
  // Per scratch schema: inventory + dependency read + up to 2 object drops + the schema drop = 5; plus the schema residue read, the marker
  // deletions (at most NONCE_REGISTRY_CAP markers, 100 per statement), and the marker residue read. The live cleanup meter enforces the same ceiling.
  totals.cleanupOperations = totals.scratchSchemas * 5 + 1 + Math.ceil(NONCE_REGISTRY_CAP / MARKER_DELETE_CHUNK) + 1;
  if (totals.operations > ceilings.operations) violations.push(`planned operations ${totals.operations} exceed the ceiling ${ceilings.operations}`);
  if (totals.concurrent > ceilings.concurrent) violations.push(`planned concurrency ${totals.concurrent} exceeds the ceiling ${ceilings.concurrent}`);
  if (totals.fixtureStatements > ceilings.fixtureStatements) violations.push(`planned fixture statements ${totals.fixtureStatements} exceed the ceiling ${ceilings.fixtureStatements}`);
  if (totals.fixtureRows > ceilings.fixtureRows) violations.push(`planned fixture rows ${totals.fixtureRows} exceed the ceiling ${ceilings.fixtureRows}`);
  if (totals.scratchSchemas > ceilings.scratchSchemas) violations.push(`planned scratch schemas ${totals.scratchSchemas} exceed the ceiling ${ceilings.scratchSchemas}`);
  if (totals.polls > ceilings.polls) violations.push(`planned polls ${totals.polls} exceed the ceiling ${ceilings.polls}`);
  if (totals.cleanupOperations > ceilings.cleanupOperations) violations.push(`planned cleanup operations ${totals.cleanupOperations} exceed the ceiling ${ceilings.cleanupOperations}`);
  for (const [name, value] of Object.entries(ceilings)) if (!Number.isSafeInteger(value) || value < 1) violations.push(`ceiling ${name} is not a positive whole number`);
  return { ok: violations.length === 0, totals, violations };
}

// ------------------------------------------------------------------ run-owned marker nonces

/**
 * Every marker this run writes or expects is a nonce THIS run minted: 32 hex characters starting with the run id, derived from a
 * label. They are registered before use, capped, and the final cleanup deletes EXACTLY this list (never a pattern).
 */
/** The most markers one run may mint (its cleanup deletes them in chunks of MARKER_DELETE_CHUNK). */
export const NONCE_REGISTRY_CAP = 600;
export const MARKER_DELETE_CHUNK = 100;
export function createNonceRegistry(runId: string, max = NONCE_REGISTRY_CAP) {
  if (!RUN_ID.test(runId)) throw new Error("login challenge uses smoke: the run id must be 8 lowercase hex characters");
  const owned: string[] = [];
  const mint = (label: string): string => `${runId}${sha256Hex(`${runId}:${label}`).slice(0, 24)}`;
  return {
    /** Registers (and returns) the nonce for a label. A label is used once. */
    register(label: string): string {
      if (typeof label !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(label) || label.length > 60) throw new Error("login challenge uses smoke: a nonce label must be lowercase letters, digits, and single hyphens");
      if (owned.length >= max) throw new Error("login challenge uses smoke: this run reached its nonce limit; refusing to register more");
      const nonce = mint(label);
      if (owned.includes(nonce)) throw new Error("login challenge uses smoke: a nonce label was used twice");
      owned.push(nonce);
      return nonce;
    },
    /** Registers `count` nonces `<label>-<n>` and returns them in order. */
    registerMany(label: string, count: number): string[] {
      if (!Number.isSafeInteger(count) || count < 1 || count > max) throw new Error("login challenge uses smoke: bad nonce count");
      return Array.from({ length: count }, (_, index) => this.register(`${label}-${index + 1}`));
    },
    assertOwned(nonceHex: string): string {
      if (typeof nonceHex !== "string" || !HEX32.test(nonceHex) || !nonceHex.startsWith(runId) || !owned.includes(nonceHex)) throw new Error("login challenge uses smoke: refusing to touch a marker this run does not own");
      return nonceHex;
    },
    owned: (): string[] => [...owned],
    count: (): number => owned.length,
  };
}
export type NonceRegistry = ReturnType<typeof createNonceRegistry>;

// ------------------------------------------------------------------ fixture statements (ALL of them; the smoke file builds no write of its own on `public`)

export function assertIsoUtc(value: unknown): string {
  if (typeof value !== "string" || !ISO_UTC.test(value) || new Date(value).toISOString() !== value) throw new Error("login challenge uses smoke: not an explicit-UTC ISO timestamp");
  return value;
}
const hexOf = (value: unknown): string => {
  if (typeof value !== "string" || !HEX32.test(value)) throw new Error("login challenge uses smoke: not a 32-hex-character nonce");
  return value;
};
const wholeSeconds = (value: unknown, min: number, max: number): number => {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error("login challenge uses smoke: seconds out of range");
  return value as number;
};

/** One owned marker, with explicit timestamps. $1 nonce hex, $2 expires_at, $3 used_at. */
export const INSERT_MARKER_SQL = `INSERT INTO public.${TABLE} (nonce, expires_at, used_at) VALUES (decode($1::text, 'hex'), $2::timestamptz, $3::timestamptz)`;
/** Many owned markers, aged by the database clock: $1 hex nonces in order, $2 base seconds. The n-th nonce (1-based) expired base + n seconds ago, so a HIGHER position is OLDER; used_at is five minutes earlier still. */
export const INSERT_AGED_MARKERS_SQL = `INSERT INTO public.${TABLE} (nonce, expires_at, used_at) SELECT decode(u.x, 'hex'), now() - make_interval(secs => $2::int + u.n::int), now() - make_interval(secs => $2::int + u.n::int + 300) FROM unnest($1::text[]) WITH ORDINALITY AS u(x, n)`;
/** Deletes EXACTLY the listed owned markers. $1 hex nonces. */
export const DELETE_OWNED_MARKERS_SQL = `DELETE FROM public.${TABLE} WHERE encode(nonce, 'hex') = ANY($1::text[]) RETURNING encode(nonce, 'hex') AS nonce`;
export const COUNT_MARKERS_SQL = `SELECT count(*)::int AS n FROM public.${TABLE}`;
/** How many of the listed owned markers exist. $1 hex nonces. */
export const COUNT_OWNED_PRESENT_SQL = `SELECT count(*)::int AS n FROM public.${TABLE} WHERE encode(nonce, 'hex') = ANY($1::text[])`;
/** Which of the listed owned markers exist, oldest-expiry first. $1 hex nonces. */
export const LIST_OWNED_PRESENT_SQL = `SELECT encode(nonce, 'hex') AS nonce FROM public.${TABLE} WHERE encode(nonce, 'hex') = ANY($1::text[]) ORDER BY expires_at, nonce`;
/** One owned marker's stored row, read back. $1 nonce hex. */
export const READ_MARKER_SQL = `SELECT octet_length(nonce)::int AS nonce_bytes, (expires_at AT TIME ZONE 'UTC')::text AS expires_utc, (used_at <= clock_timestamp()) AS used_not_future, (expires_at - used_at) AS lifetime FROM public.${TABLE} WHERE encode(nonce, 'hex') = $1::text`;
/** The database clock in epoch milliseconds (bigint arrives as a string; the caller converts). */
export const DB_CLOCK_SQL = `SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS ms`;
/** Reads that distinguish a transaction-start clock from the wall clock; a RESULT row is returned by each of the three statements of one batch. */
export const CLOCK_BATCH = ["SELECT now() AS tx_start", "SELECT pg_catalog.pg_sleep(1)", "SELECT now() AS tx_start_again, clock_timestamp() AS wall, (clock_timestamp() - now()) >= interval '900 milliseconds' AS wall_moved"] as const;
/** Transport probe: a boolean computed by the database arrives as a JavaScript boolean. */
export const BOOLEAN_PROBE_SQL = `SELECT (now() >= now()) AS yes, (now() < now()) AS no`;

/** A sleeping lock holder that ROLLS BACK by dividing by zero (SQLSTATE 22012) after the sleep. The runtime error is not constant-folded away. */
const ROLLBACK_TAIL = "SELECT 1 / (SELECT count(*) FROM pg_catalog.pg_class WHERE false)::int";

/** `public.<table>`, or `<owned scratch schema>.<table>` — the only two relations a holder or fixture may name. */
function relationFor(ownership: RunOwnership | null, schema: string): string {
  if (schema === "public") return `public.${TABLE}`;
  if (ownership === null) throw new Error("login challenge uses smoke: a scratch relation needs the run's ownership registry");
  ownership.assertOwnedSchema(schema);
  return `${assertPlainIdentifier(schema)}.${TABLE}`;
}

/** Holder: inserts the nonce UNCOMMITTED, sleeps, then rolls back. Blocks a concurrent insert of the same nonce until it ends. */
export function holderInsertAndRollback(nonceHex: string, expiresIso: string, sleepSeconds: number): string[] {
  return [`INSERT INTO public.${TABLE} (nonce, expires_at, used_at) VALUES (decode('${hexOf(nonceHex)}', 'hex'), '${assertIsoUtc(expiresIso)}'::timestamptz, clock_timestamp())`, `SELECT pg_catalog.pg_sleep(${wholeSeconds(sleepSeconds, 1, 30)})`, ROLLBACK_TAIL];
}
/** Holder: deletes the owned marker UNCOMMITTED (a stand-in for another transaction's purge), sleeps, then COMMITS. `schema` is `public` or a scratch schema this run owns. */
export function holderDeleteAndCommit(nonceHex: string, sleepSeconds: number, schema = "public", ownership: RunOwnership | null = null): string[] {
  return [`DELETE FROM ${relationFor(ownership, schema)} WHERE nonce = decode('${hexOf(nonceHex)}', 'hex')`, `SELECT pg_catalog.pg_sleep(${wholeSeconds(sleepSeconds, 1, 30)})`];
}

/** A scratch relation only: `public` is refused here, so a scratch builder can never write to the real table. */
function scratchRelation(ownership: RunOwnership, schema: string): string {
  if (schema === "public") throw new Error("login challenge uses smoke: a scratch builder never names public");
  return relationFor(ownership, schema);
}

/** One marker row inserted into a scratch table this run owns (explicit values, never defaults). `nonceBytesHex` is the raw bytes, so a wrong-length nonce can be built to prove the CHECK. */
export function scratchInsertSql(ownership: RunOwnership, schema: string, row: { nonceBytesHex: string; expires: string; used: string }): string {
  if (typeof row.nonceBytesHex !== "string" || (row.nonceBytesHex !== "NULL" && !/^([0-9a-f]{2}){0,64}$/.test(row.nonceBytesHex))) throw new Error("login challenge uses smoke: not a hex byte string");
  const stamp = (value: string) => (value === "NULL" ? "NULL" : value === "now()" ? "pg_catalog.now()" : `'${assertIsoUtc(value)}'::timestamptz`);
  const nonce = row.nonceBytesHex === "NULL" ? "NULL" : `decode('${row.nonceBytesHex}', 'hex')`;
  return `INSERT INTO ${scratchRelation(ownership, schema)} (nonce, expires_at, used_at) VALUES (${nonce}, ${stamp(row.expires)}, ${stamp(row.used)})`;
}
/** The rows of a scratch table this run owns, as hex, ordered. */
export function scratchRowsSql(ownership: RunOwnership, schema: string): string {
  return `SELECT encode(nonce, 'hex') AS nonce, octet_length(nonce)::int AS nonce_bytes FROM ${scratchRelation(ownership, schema)} ORDER BY nonce`;
}
/**
 * The scripted race timing, in ONE place. The challenge expires RACE_EXPIRY_OFFSET_MS after a database-clock reading taken at the start of the
 * case; the holder sleeps RACE_HOLDER_SLEEP_SECONDS and then releases. The sleep must outlast the expiry by at least RACE_MIN_RELEASE_MARGIN_MS,
 * and the expiry must leave the replay time to start and block before it (RACE_MIN_REPLAY_WINDOW_MS after the holder-wait deadline).
 */
export const RACE_EXPIRY_OFFSET_MS = 16_000;
export const RACE_HOLDER_SLEEP_SECONDS = 20;
export const RACE_MIN_RELEASE_MARGIN_MS = 2_000;
export const RACE_MIN_REPLAY_WINDOW_MS = 4_000;
/** Whether the scripted race can work at all: release after expiry with margin, and expiry after the longest wait for the holder plus a replay window. */
export function checkRaceScript(input: { expiryOffsetMs: number; holderSleepSeconds: number; holderWaitMs: number }): IdentityCheck {
  const { expiryOffsetMs, holderSleepSeconds, holderWaitMs } = input;
  if (![expiryOffsetMs, holderSleepSeconds, holderWaitMs].every((value) => Number.isSafeInteger(value) && value > 0)) return { ok: false, reason: "the race script has a non-positive or non-whole timing" };
  if (holderSleepSeconds * 1000 < expiryOffsetMs + RACE_MIN_RELEASE_MARGIN_MS) return { ok: false, reason: "the holder's sleep does not outlast the expiry by the required margin" };
  if (expiryOffsetMs < holderWaitMs + RACE_MIN_REPLAY_WINDOW_MS) return { ok: false, reason: "the expiry leaves no replay window after the longest wait for the holder" };
  return { ok: true };
}

/** Holder (commit): like holderDeleteAndCommit, but its batch also reads the DATABASE clock first and last, so the release is MEASURED server-side. */
export function holderDeleteAndCommitTimed(nonceHex: string, sleepSeconds: number, schema = "public", ownership: RunOwnership | null = null): string[] {
  return [DB_CLOCK_SQL, ...holderDeleteAndCommit(nonceHex, sleepSeconds, schema, ownership), DB_CLOCK_SQL];
}
/** The two database-clock readings of a timed commit holder's batch (epoch ms), or null when its result does not have exactly that shape. */
export function parseTimedHolderResult(batch: unknown): { startedMs: number; releasedMs: number } | null {
  if (!Array.isArray(batch) || batch.length !== 4) return null;
  const read = (statement: unknown): number | null => {
    const row = Array.isArray(statement) && statement.length === 1 ? (statement[0] as { ms?: unknown } | null) : null;
    const value = typeof row?.ms === "string" || typeof row?.ms === "number" ? Number(row.ms) : Number.NaN;
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  };
  const startedMs = read(batch[0]);
  const releasedMs = read(batch[3]);
  return startedMs !== null && releasedMs !== null && releasedMs >= startedMs ? { startedMs, releasedMs } : null;
}

export type EvidenceBasis = "MEASURED" | "INFERRED_FROM_SCRIPTED_ORDER" | "NOT_OBSERVED";
export type TimedFact<T> = { basis: EvidenceBasis; value: T | null; note: string };
const fact = <T>(basis: EvidenceBasis, value: T | null, note: string): TimedFact<T> => ({ basis, value, note });

/**
 * The race timing evidence for ONE scenario, with every item labelled by how it is known. MEASURED means the database (or a poll of it) produced
 * the value; INFERRED_FROM_SCRIPTED_ORDER means it follows only from the script the harness sent; NOT_OBSERVED means no value exists and none is
 * claimed. A COMMIT holder's start and release come from database-clock reads INSIDE its batch (MEASURED; the release reading is taken just before
 * the commit, so the commit is at or after it). A ROLLBACK holder's batch ends in an error, which discards its results, so its start and release
 * instants are NOT_OBSERVED; what is measured instead is that the request's own statement, after its lock wait, found the challenge expired.
 */
export function raceTimingEvidence(input: {
  expiryIso: string;
  expiryOffsetMs: number;
  intendedHolderSleepSeconds: number;
  holderKind: "commit" | "rollback";
  holderSleepingSeenBeforeReplay: number;
  replayBlockedSeen: number;
  timed: { startedMs: number; releasedMs: number } | null;
  dbClockAfterCollectMs: number;
  expiredAtStatementPostCheck: boolean | null;
}) {
  const expiryMs = Date.parse(assertIsoUtc(input.expiryIso));
  const timed = input.holderKind === "commit" ? input.timed : null;
  return {
    expiry: fact("MEASURED", input.expiryIso, "computed from a database-clock reading taken at the start of the case plus the offset below"),
    expiryOffsetMs: fact("INFERRED_FROM_SCRIPTED_ORDER", input.expiryOffsetMs, "the harness chose it"),
    intendedHolderSleepSeconds: fact("INFERRED_FROM_SCRIPTED_ORDER", input.intendedHolderSleepSeconds, "the sleep the holder's script contains"),
    scriptedReleaseMarginMs: fact("INFERRED_FROM_SCRIPTED_ORDER", input.intendedHolderSleepSeconds * 1000 - input.expiryOffsetMs, "sleep minus expiry offset; the holder starts shortly after the clock reading, so this is approximate"),
    holderSleepingSeen: fact("MEASURED", input.holderSleepingSeenBeforeReplay, "sessions seen sleeping in pg_stat_activity before the replay was launched"),
    replayBlockedSeen: fact("MEASURED", input.replayBlockedSeen, "sessions seen waiting on a lock while running the marker statement"),
    holderStartedDbMs: timed ? fact("MEASURED", timed.startedMs, "database clock read inside the holder's batch, first statement") : fact<number>("NOT_OBSERVED", null, input.holderKind === "rollback" ? "a rollback holder's results are discarded by the deliberate error" : "no timed result was supplied"),
    holderReleasedDbMs: timed ? fact("MEASURED", timed.releasedMs, "database clock read inside the holder's batch, last statement before the commit") : fact<number>("NOT_OBSERVED", null, input.holderKind === "rollback" ? "a rollback holder's results are discarded by the deliberate error" : "no timed result was supplied"),
    releaseAfterExpiry: timed ? fact("MEASURED", timed.releasedMs > expiryMs, "the holder's in-batch clock reading, taken just before its commit, is later than the expiry") : fact<boolean>("NOT_OBSERVED", null, "the release instant was not observed"),
    dbClockAfterCollectMs: fact("MEASURED", input.dbClockAfterCollectMs, "an UPPER bound for the release instant, read after the holder was collected"),
    expiredAtStatementPostCheck: input.expiredAtStatementPostCheck === null ? fact<boolean>("NOT_OBSERVED", null, "not applicable") : fact("MEASURED", input.expiredAtStatementPostCheck, "the request ended rejected AND its marker row exists, so its own post-insert check, after the lock wait, found the challenge expired"),
  };
}
/** Every labelled fact is internally consistent: MEASURED and INFERRED carry a value, NOT_OBSERVED carries none. */
export function raceTimingConsistent(evidence: Record<string, TimedFact<unknown>>): boolean {
  return Object.values(evidence).every((item) => (item.basis === "NOT_OBSERVED" ? item.value === null : item.value !== null && item.value !== undefined) && typeof item.note === "string" && item.note !== "");
}

/** Holder: takes SHARE ROW EXCLUSIVE on the marker table (blocking every insert and delete), sleeps, then commits. Used as a START GATE so many requests are provably in flight together. */
export function holderTableGate(sleepSeconds: number): string[] {
  return [`LOCK TABLE public.${TABLE} IN SHARE ROW EXCLUSIVE MODE`, `SELECT pg_catalog.pg_sleep(${wholeSeconds(sleepSeconds, 1, 30)})`];
}
/** Holder: row-locks the listed owned markers (FOR UPDATE), sleeps, then commits. Every nonce is validated hex. */
export function holderRowLocks(nonces: readonly string[], sleepSeconds: number): string[] {
  if (nonces.length < 1 || nonces.length > 64) throw new Error("login challenge uses smoke: 1 to 64 markers may be row-locked");
  const list = nonces.map((nonce) => `'${hexOf(nonce)}'`).join(", ");
  return [`SELECT 1 FROM public.${TABLE} WHERE encode(nonce, 'hex') = ANY(ARRAY[${list}]) FOR UPDATE`, `SELECT pg_catalog.pg_sleep(${wholeSeconds(sleepSeconds, 1, 30)})`];
}

/** Another session of this database is inside a sleep: a lock holder is holding. */
export const HOLDER_ACTIVE_SQL = `SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE datname = pg_catalog.current_database() AND pid <> pg_catalog.pg_backend_pid() AND state = 'active' AND query LIKE '%pg_sleep%' AND query NOT LIKE '%pg_stat_activity%'`;
/** Other sessions waiting on a LOCK while running the production marker statement (its text begins with the purge CTE; leading whitespace allowed). */
export const MARKER_WAITERS_SQL = `SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE datname = pg_catalog.current_database() AND pid <> pg_catalog.pg_backend_pid() AND wait_event_type = 'Lock' AND query ~ '^\\s*WITH purged AS'`;
/**
 * Whether THIS session can read ITS OWN entry in pg_stat_activity (pid = its own backend). It says nothing about other sessions: that the role can see
 * OTHER sessions' sleeping holders and lock waiters is established only by the race cases' polls, which poison the run when they see nothing.
 */
export const CAN_SEE_ACTIVITY_SQL = `SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE pid = pg_catalog.pg_backend_pid()`;

// ------------------------------------------------------------------ the malformed look-alikes: a purpose-built consistency checker

/** The three intended columns, in order. */
export const INTENDED_COLUMNS = ["nonce", "expires_at", "used_at"] as const;
export type Step = { register?: [ScratchObjectKind, string]; sql: string };

const withoutQuotes = (text: string) => text.replace(/'(?:[^']|'')*'/g, "''").replace(/"[^"]*"/g, "");
const tokensOf = (text: string): string[] => withoutQuotes(text).toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? [];

function closingParen(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("unbalanced parentheses or quotes");
}
function splitTopLevel(body: string): string[] {
  if (body.trim() === "") return [];
  const items: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      items.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (depth !== 0 || quote !== null) throw new Error("unbalanced parentheses or quotes");
  items.push(body.slice(start).trim());
  if (items.some((item) => item === "")) throw new Error("an empty table-definition item");
  return items;
}

export type VariantAnalysis = { issues: string[]; tables: Map<string, Set<string>>; created: Array<{ kind: ScratchObjectKind; name: string }> };
const ident = "[a-z0-9_]+";
const qualified = `${ident}\\.${ident}`;

/**
 * Evaluates ONE look-alike's steps, in order, WITHOUT a database. `issues` is empty only for a variant whose every statement is a
 * recognized form, whose constraints / indexes / added constraints / generated columns name no intended column that their own
 * table lacks (the exact defect that poisoned the first 3C-1 run: SQLSTATE 42703 at FIXTURE construction), whose created objects
 * are exactly the registered ones, and which creates the relation the migration will inspect.
 *
 * LIMITS: a purpose-built splitter, not a SQL parser. It fails closed on anything it does not recognize. It checks references to
 * the THREE intended column names only (plus duplicate columns); it cannot decide type compatibility, index-expression
 * immutability, operator-class availability, or any other fact only PostgreSQL knows. Those risks are why the live run builds
 * each fixture as its own, separately classified step before the migration is ever invoked.
 */
export function analyseVariant(schema: string, steps: readonly Step[]): VariantAnalysis {
  const issues: string[] = [];
  const tables = new Map<string, Set<string>>();
  const functions = new Set<string>();
  const views = new Set<string>();
  const created: VariantAnalysis["created"] = [];
  const registered: Array<{ kind: ScratchObjectKind; name: string }> = [];
  const bare = (name: string) => name.slice(name.indexOf(".") + 1);
  const intended = (token: string) => (INTENDED_COLUMNS as readonly string[]).includes(token);
  const checkRefs = (where: string, table: string, text: string, skip?: string) => {
    const defined = tables.get(table);
    if (!defined) return void issues.push(`${where}: refers to a table (${table}) this variant has not created`);
    for (const token of tokensOf(text)) if (intended(token) && token !== skip && !defined.has(token)) issues.push(`${where}: names column ${token}, which ${table} does not define`);
  };

  for (const step of steps) {
    const sql = step.sql;
    if (step.register) registered.push({ kind: step.register[0], name: step.register[1] });
    if (/^CREATE (UNLOGGED )?TABLE\b/.test(sql)) {
      const head = new RegExp(`^CREATE (?:UNLOGGED )?TABLE (${qualified}) \\(`).exec(sql);
      if (!head) {
        issues.push("an unrecognized CREATE TABLE form");
        continue;
      }
      const name = head[1]!;
      let items: string[];
      let tail: string;
      try {
        const close = closingParen(sql, head[0].length - 1);
        items = splitTopLevel(sql.slice(head[0].length, close));
        tail = sql.slice(close + 1).trim();
      } catch (error) {
        issues.push(`${name}: ${(error as Error).message}`);
        continue;
      }
      if (tail !== "" && !/^PARTITION BY HASH \(nonce\)$/.test(tail) && !new RegExp(`^INHERITS \\(${qualified}\\)$`).test(tail)) issues.push(`${name}: an unrecognized table tail`);
      const columns = new Set<string>();
      const constraints: string[] = [];
      const columnItems: Array<{ name: string; text: string }> = [];
      for (const item of items) {
        if (/^CONSTRAINT /i.test(item) || /^(PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY)\b/i.test(item)) constraints.push(item);
        else {
          const columnName = /^([a-z_][a-z0-9_]*) /.exec(item)?.[1];
          if (!columnName) issues.push(`${name}: an unrecognized table-definition item`);
          else if (columns.has(columnName)) issues.push(`${name}: column ${columnName} is defined twice`);
          else {
            columns.add(columnName);
            columnItems.push({ name: columnName, text: item });
          }
        }
      }
      tables.set(name, columns);
      created.push({ kind: "table", name: bare(name) });
      for (const constraint of constraints) checkRefs(`${name} constraint`, name, constraint.replace(new RegExp(`REFERENCES ${qualified} \\([^)]*\\)`, "i"), ""));
      // A generated column or a default may name another column.
      for (const column of columnItems) if (/GENERATED|DEFAULT/i.test(column.text)) checkRefs(`${name} column ${column.name}`, name, column.text, column.name);
    } else if (/^CREATE VIEW\b/.test(sql)) {
      const view = new RegExp(`^CREATE VIEW (${qualified}) AS SELECT `).exec(sql)?.[1];
      if (!view) issues.push("an unrecognized CREATE VIEW form");
      else {
        views.add(view);
        created.push({ kind: "view", name: bare(view) });
      }
    } else if (/^CREATE FUNCTION\b/.test(sql)) {
      const fn = new RegExp(`^CREATE FUNCTION (${qualified})\\(\\) RETURNS trigger LANGUAGE plpgsql AS \\$lcu\\$ .* \\$lcu\\$$`).exec(sql)?.[1];
      if (!fn) issues.push("an unrecognized CREATE FUNCTION form");
      else {
        functions.add(fn);
        created.push({ kind: "function", name: bare(fn) });
      }
    } else if (/^CREATE (UNIQUE )?INDEX\b/.test(sql)) {
      const match = new RegExp(`^CREATE (?:UNIQUE )?INDEX (${ident}) ON (${qualified})(?: USING (btree|hash))? \\((.*?)\\)(?: WITH \\([^)]*\\))?(?: WHERE (.*))?$`).exec(sql);
      if (!match) issues.push("an unrecognized CREATE INDEX form");
      else {
        checkRefs("an index", match[2]!, match[4]!);
        if (match[5]) checkRefs("an index predicate", match[2]!, match[5]);
      }
    } else if (/^ALTER TABLE\b/.test(sql)) {
      const add = new RegExp(`^ALTER TABLE (${qualified}) ADD CONSTRAINT ${ident} (.*?)( NOT VALID)?$`).exec(sql);
      const rls = new RegExp(`^ALTER TABLE (${qualified}) ENABLE ROW LEVEL SECURITY$`).exec(sql);
      if (add) checkRefs("an added constraint", add[1]!, add[2]!);
      else if (rls) {
        if (!tables.has(rls[1]!)) issues.push(`${rls[1]}: row-level security enabled on a table this variant has not created`);
      } else issues.push("an unrecognized ALTER TABLE form");
    } else if (/^CREATE POLICY\b/.test(sql)) {
      const target = new RegExp(`^CREATE POLICY ${ident} ON (${qualified}) USING \\(true\\)$`).exec(sql)?.[1];
      if (!target) issues.push("an unrecognized CREATE POLICY form");
      else if (!tables.has(target)) issues.push(`${target}: a policy on a table this variant has not created`);
    } else if (/^CREATE RULE\b/.test(sql)) {
      const target = new RegExp(`^CREATE RULE ${ident} AS ON INSERT TO (${qualified}) DO ALSO NOTHING$`).exec(sql)?.[1];
      if (!target) issues.push("an unrecognized CREATE RULE form");
      else if (!tables.has(target)) issues.push(`${target}: a rule on a table this variant has not created`);
    } else if (/^CREATE TRIGGER\b/.test(sql)) {
      const match = new RegExp(`^CREATE TRIGGER ${ident} BEFORE INSERT ON (${qualified}) FOR EACH ROW EXECUTE FUNCTION (${qualified})\\(\\)$`).exec(sql);
      if (!match) issues.push("an unrecognized CREATE TRIGGER form");
      else {
        if (!tables.has(match[1]!)) issues.push(`${match[1]}: a trigger on a table this variant has not created`);
        if (!functions.has(match[2]!)) issues.push(`${match[2]}: a trigger calling a function this variant has not created`);
      }
    } else issues.push("an unrecognized statement kind (not accepted silently)");
  }
  const target = `${schema}.${TABLE}`;
  if (!tables.has(target) && !views.has(target)) issues.push("the variant never creates the relation the migration will inspect");
  const key = (entry: { kind: string; name: string }) => `${entry.kind}:${entry.name}`;
  const made = created.map(key).sort();
  const owned = registered.map(key).sort();
  if (made.join("|") !== owned.join("|")) issues.push(`created objects [${made.join(", ")}] differ from the registered ones [${owned.join(", ")}]`);
  return { issues, tables, created };
}

// ------------------------------------------------------------------ outcomes

type Settled = { status: "fulfilled"; value: unknown } | { status: "rejected"; reason: unknown };

export const sqlStateOf = (error: unknown): string | null => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && SQL_STATE.test(code) ? code : null;
};
const constraintOf = (error: unknown): string | null => {
  const reason = error as { constraint?: unknown; message?: unknown } | null;
  const named = reason && typeof reason.constraint === "string" && reason.constraint ? reason.constraint : (/constraint "([a-z0-9_]+)"/.exec(String(reason?.message ?? ""))?.[1] ?? null);
  return named && /^[a-z0-9_]+$/.test(named) ? named : null;
};

/**
 * How one marker request ended. Only `consumed` and `rejected` are answers. Everything else is an explicit non-answer and is
 * NEVER counted as a rejection:
 *   invariant_failure  the application's own fail-closed error (a malformed answer).
 *   database_error     PostgreSQL answered with an error: the statement did not apply.
 *   no_answer          nothing recognisable came back: the write may or may not have happened.
 */
export type MarkerOutcome =
  | { kind: "consumed" }
  | { kind: "rejected" }
  | { kind: "invariant_failure" }
  | { kind: "database_error"; sqlState: string; constraint: string | null }
  | { kind: "no_answer" };

export function classifyMarker(settled: Settled): MarkerOutcome {
  if (settled.status === "fulfilled") {
    if (settled.value === "consumed") return { kind: "consumed" };
    if (settled.value === "rejected") return { kind: "rejected" };
    return { kind: "no_answer" };
  }
  const sqlState = sqlStateOf(settled.reason);
  if (sqlState !== null) return { kind: "database_error", sqlState, constraint: constraintOf(settled.reason) };
  if (/^Login challenge use refused: /.test(String((settled.reason as { message?: unknown } | null)?.message ?? ""))) return { kind: "invariant_failure" };
  return { kind: "no_answer" };
}

export function tallyOutcomes(outcomes: readonly MarkerOutcome[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) counts[outcome.kind] = (counts[outcome.kind] ?? 0) + 1;
  return counts;
}

// ------------------------------------------------------------------ baseline plus expected delta

/** The one table a clean run leaves behind, as the post-run read must describe it — and EMPTY. */
export const EXPECTED_MARKER_TABLE: ProviderTableDescriptor = {
  columns: [
    { name: "nonce", type: "bytea", notNull: true, collation: null },
    { name: "expires_at", type: "timestamp with time zone", notNull: true, collation: null },
    { name: "used_at", type: "timestamp with time zone", notNull: true, collation: null },
  ],
  constraints: [
    { name: "real_login_challenge_uses_nonce_length_check", type: "c", columns: ["nonce"] },
    { name: "real_login_challenge_uses_pkey", type: "p", columns: ["nonce"] },
  ],
  indexes: ["real_login_challenge_uses_expires_at_idx", "real_login_challenge_uses_pkey"],
  triggers: 0,
  foreignKeysOut: 0,
  foreignKeysIn: 0,
  policies: 0,
  rowSecurity: false,
  rows: 0,
};

export const DELTA_MEASURED = ["every public table's row count, content digest, and shape digest", "the names of the non-system schemas", `the structure and (empty) contents of public.${TABLE}`] as const;
export const DELTA_NOT_MEASURED = ["functions, sequences, views, types, and extensions", "roles, grants, and database settings", "the contents of any schema other than public", "anything another session changed and changed back during the run"] as const;

export type DeltaVerdict = {
  ok: boolean;
  verdict: "baseline_plus_expected_delta" | "delta_mismatch";
  differences: string[];
  expectedDelta: { tableAdded: string; rows: 0 };
  measured: readonly string[];
  notMeasured: readonly string[];
};

const isFingerprint = (value: unknown): boolean => {
  const f = value as { rows?: unknown; contentDigest?: unknown; shapeDigest?: unknown } | null;
  return !!f && typeof f === "object" && Number.isSafeInteger(f.rows) && (f.rows as number) >= 0 && typeof f.contentDigest === "string" && typeof f.shapeDigest === "string" && f.shapeDigest !== "";
};
const isSnapshot = (value: unknown): value is DatabaseSnapshot => {
  const s = value as DatabaseSnapshot | null;
  return !!s && typeof s === "object" && !!s.tables && typeof s.tables === "object" && Object.values(s.tables).every(isFingerprint) && Array.isArray(s.schemas) && s.schemas.every((name) => typeof name === "string") && new Set(s.schemas).size === s.schemas.length;
};
const canonicalDescriptor = (descriptor: ProviderTableDescriptor): string =>
  JSON.stringify({
    columns: descriptor.columns.map((column) => [column.name, column.type, column.notNull, column.collation]),
    constraints: [...descriptor.constraints].map((constraint) => [constraint.name, constraint.type, constraint.columns]).sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
    indexes: [...descriptor.indexes].sort(),
    counts: [descriptor.triggers, descriptor.foreignKeysOut, descriptor.foreignKeysIn, descriptor.policies, descriptor.rowSecurity, descriptor.rows],
  });

/**
 * Compares the post-run database with its pre-run baseline, EXPECTING exactly one difference: `public.real_login_challenge_uses`
 * now exists, with the intended structure, and EMPTY (every marker the run owned is gone). Everything else measured must be
 * identical. Anything unreadable or malformed is a mismatch, never a pass.
 */
export function compareWithExpectedMarkerDelta(input: { before: unknown; after: unknown; markerTable: unknown; ownedSchemas: readonly string[] }): DeltaVerdict {
  const differences: string[] = [];
  const done = (): DeltaVerdict => ({ ok: differences.length === 0, verdict: differences.length === 0 ? "baseline_plus_expected_delta" : "delta_mismatch", differences, expectedDelta: { tableAdded: `public.${TABLE}`, rows: 0 }, measured: DELTA_MEASURED, notMeasured: DELTA_NOT_MEASURED });
  if (!isSnapshot(input.before) || !isSnapshot(input.after)) {
    differences.push("a snapshot is missing or malformed");
    return done();
  }
  const { before, after } = input;
  const has = (snapshot: DatabaseSnapshot, table: string) => Object.hasOwn(snapshot.tables, table);
  if (has(before, TABLE)) differences.push(`baseline: public.${TABLE} already existed before the run`);
  if (!has(before, "real_rate_limits")) differences.push("baseline: public.real_rate_limits was not measured before the run");
  for (const schema of input.ownedSchemas) if (before.schemas.includes(schema)) differences.push("baseline: a run-owned scratch schema existed before the run");
  for (const table of Object.keys(before.tables).sort()) {
    if (table === TABLE) continue;
    if (!has(after, table)) {
      differences.push(`table removed: ${table}`);
      continue;
    }
    const was = before.tables[table]!;
    const is = after.tables[table]!;
    if (was.shapeDigest !== is.shapeDigest) differences.push(`catalog shape changed: ${table}`);
    if (was.rows !== is.rows || was.contentDigest !== is.contentDigest) differences.push(`contents changed: ${table}`);
  }
  for (const table of Object.keys(after.tables).sort()) if (table !== TABLE && !has(before, table)) differences.push(`unexpected new table: ${table}`);
  if (!has(after, TABLE)) differences.push(`expected delta missing: public.${TABLE} does not exist after the run`);
  else if (after.tables[TABLE]!.rows !== 0) differences.push(`expected delta wrong: public.${TABLE} is not empty`);
  let described: string | null = null;
  try {
    described = canonicalDescriptor(input.markerTable as ProviderTableDescriptor);
  } catch {
    described = null;
  }
  if (described !== canonicalDescriptor(EXPECTED_MARKER_TABLE)) differences.push(`expected delta wrong: public.${TABLE} does not match the intended descriptor (structure, or not empty)`);
  for (const schema of input.ownedSchemas) if (after.schemas.includes(schema)) differences.push("a run-owned scratch schema remains");
  if ([...before.schemas].sort().join("\n") !== [...after.schemas].sort().join("\n")) differences.push("the set of schemas changed");
  return done();
}

// ------------------------------------------------------------------ evidence

export const START_EVIDENCE_FIELDS = ["runId", "repository", "sourceIdentity", "migrationIdentity", "markerSqlIdentity", "targetProofStatus", "server", "connectionMode", "scenarioInventory", "plannedBudget", "fingerprintsBefore"] as const;
export const FINAL_EVIDENCE_FIELDS = [
  "runId",
  "repository",
  "sourceIdentity",
  "migrationIdentity",
  "markerSqlIdentity",
  "targetProofStatus",
  "server",
  "connectionMode",
  "scenarioInventory",
  "plannedBudget",
  "actualBudget",
  "casesExecuted",
  "casesNotExecuted",
  "markerTallies",
  "fixtureReport",
  "migrationRefusals",
  "observations",
  "cleanup",
  "fingerprintsBefore",
  "fingerprintsAfter",
  "expectedDelta",
  "unknownOperations",
  "inFlightOperations",
  "disposition",
] as const;
export type EvidenceStage = "start" | "final";
export type EvidenceResult = { ok: true; file: string } | { ok: false; reason: "invalid_run_id" | "incomplete" | "unsafe_content" | "directory_not_private" | "already_exists" | "write_failed"; code: string | null };

export function missingEvidenceFields(stage: EvidenceStage, evidence: unknown): string[] {
  const required: readonly string[] = stage === "start" ? START_EVIDENCE_FIELDS : FINAL_EVIDENCE_FIELDS;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return [...required];
  const record = evidence as Record<string, unknown>;
  const missing = required.filter((field) => !Object.hasOwn(record, field) || record[field] === undefined);
  if (!missing.includes("runId") && (typeof record.runId !== "string" || !RUN_ID.test(record.runId))) missing.push("runId");
  return missing;
}

const UNSAFE_EXTRA = /token|bearer|authorization|credential/i;

/**
 * Saves one evidence record as `<directory>/login-challenge-uses-smoke-<run id>-<stage>.json`. The name is built from a validated
 * run id and a fixed stage word; the record must be complete for its stage and pass the content screen (plus a few extra words);
 * the directory must be the owner's alone (created 0700 if absent — an existing one others can enter is REFUSED, never
 * re-permissioned); the file is created exclusively (never overwritten) with mode 0600, read back. Returns a classification —
 * never an error message.
 */
export function writeLoginChallengeUsesEvidence(input: { directory: string; runId: string; stage: EvidenceStage; evidence: unknown }): EvidenceResult {
  if (!RUN_ID.test(input.runId) || (input.stage !== "start" && input.stage !== "final")) return { ok: false, reason: "invalid_run_id", code: null };
  if (missingEvidenceFields(input.stage, input.evidence).length > 0 || (input.evidence as { runId?: unknown }).runId !== input.runId) return { ok: false, reason: "incomplete", code: null };
  const json = safeEvidenceJson(input.evidence);
  if (json === null || UNSAFE_EXTRA.test(json)) return { ok: false, reason: "unsafe_content", code: null };
  const file = path.join(input.directory, `login-challenge-uses-smoke-${input.runId}-${input.stage}.json`);
  try {
    mkdirSync(input.directory, { recursive: true, mode: 0o700 });
    if ((statSync(input.directory).mode & 0o077) !== 0) return { ok: false, reason: "directory_not_private", code: null };
    writeFileSync(file, json, { flag: "wx", mode: 0o600 });
    if ((statSync(file).mode & 0o777) !== 0o600) return { ok: false, reason: "write_failed", code: "MODE" };
  } catch (error) {
    const code = String((error as { code?: unknown } | null)?.code ?? "");
    return { ok: false, reason: code === "EEXIST" ? "already_exists" : "write_failed", code: /^[A-Z0-9_]{1,24}$/.test(code) ? code : null };
  }
  return { ok: true, file };
}

// ------------------------------------------------------------------ run lifecycle

export type LifecycleState = "NOT_STARTED" | "PREFLIGHT" | "ARMED" | "RUNNING" | "CLEANUP" | "COMPLETED_CLEAN" | "COMPLETED_DELTA_MISMATCH" | "POISONED";
export type OperationRecord = { what: string; phase: "preflight" | "case" | "verify"; mode: "read" | "write" };
export type TrackedRead = <T>(what: string, operation: () => Promise<T>) => Promise<T>;
export type Launched = { what: string; done: Promise<Settled> };
export type MigrationRefusal = { case: string | null; what: string; sqlState: string };
export type FixtureRecord = { case: string | null; what: string; constructed: boolean };

export type FinalReport = {
  outcome: "NOT_STARTED" | "COMPLETED_CLEAN" | "COMPLETED_DELTA_MISMATCH" | "POISONED";
  disposition: "not_started" | "baseline_plus_expected_delta" | "delta_mismatch" | "poisoned_evidence_preserved";
  completeRestoration: false;
  poisoned: string | null;
  executed: string[];
  notExecuted: string[];
  inFlightOperations: string[];
  unknownOperations: string[];
  actualBudget: { operations: number; fixtureStatements: number; fixtureRows: number; polls: number; maxConcurrent: number; scratchSchemas: number };
  markerTallies: Record<string, Record<string, number>>;
  fixtureReport: FixtureRecord[];
  migrationRefusals: MigrationRefusal[];
  observations: Record<string, unknown>;
  cleanup: { attempted: boolean; accepted: boolean; skipped: string | null; inFlight: boolean; schemaSummary: CleanupSummary | null; stopped: CleanupAccount["stopped"]; markersDeleted: number | null; markerResidue: number | null; statementsPlanned: number | null; statementsIssued: number; statementsRefused: number; statementCeiling: number };
  ownedSchemas: string[];
  ownedMarkers: number;
  delta: DeltaVerdict | null;
  action: string;
};

const INVESTIGATE = "Investigate the disposable branch read-only. Do not reuse or automatically repair the branch.";
const PREFIX = "login challenge uses smoke";
class CleanupSwitchedOff extends Error {}

/**
 * The ONLY door through which a cleanup statement reaches the database. A statement is refused (never sent) when the cleanup is switched off; otherwise it is
 * COUNTED before dispatch, and once the ceiling is reached every further statement is refused without being sent (and `onExhausted` runs). Nothing is retried.
 */
export function createMeteredCleanupGate(input: { active: () => boolean; meter: ReturnType<typeof createCleanupMeter>; db: QueryDb; onExhausted: () => void }): CleanupGate {
  return {
    active: input.active,
    q: (text, params) => {
      if (!input.active()) return Promise.reject(new CleanupSwitchedOff("cleanup switched off"));
      if (!input.meter.take()) {
        input.onExhausted();
        return Promise.reject(new CleanupSwitchedOff("cleanup statement ceiling reached"));
      }
      return input.db.q(text, params);
    },
  };
}

/**
 * Counts every cleanup statement BEFORE it is dispatched. `take()` is true for the first `limit` statements and false for every one
 * after, forever; a false answer means the statement must not be sent. The limit is the approved cleanup ceiling, never raised.
 */
export function createCleanupMeter(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`${PREFIX}: the cleanup statement ceiling must be a positive whole number`);
  let issued = 0;
  let refused = 0;
  return {
    take(): boolean {
      if (issued >= limit) {
        refused += 1;
        return false;
      }
      issued += 1;
      return true;
    },
    issued: (): number => issued,
    refused: (): number => refused,
    limit: (): number => limit,
  };
}

/**
 * The run's one state machine. Rules, none of which can be undone during a run:
 *   - `poison` is permanent and keeps its FIRST reason. It is set by a failed preflight check, a case that throws or outlives its
 *     deadline, any database answer that is not the one the call expects, a lost answer, an operation attempted in the wrong state,
 *     a cleanup that is not confirmed, a budget limit reached, the whole-run deadline, and a failure the runner reports.
 *   - A FIXTURE that cannot be constructed is a HARNESS FAILURE (poison reason begins "HARNESS FAILURE"): it is never reported as, or
 *     mistaken for, a migration refusal. A migration refusal counts only when the fixture was constructed first and the database
 *     answered with one of the SQLSTATEs the scenario names.
 *   - Nothing may be written before `arm`, which needs every preflight check passed, nothing unsettled, and the start evidence saved.
 *   - Every operation is tracked from the moment it is issued until it REALLY settles. Nothing is ever retried.
 *   - There is ONE cleanup, at the end, attempted at most once, and only after every expected case completed with nothing unsettled.
 */
export function createLoginChallengeUsesLifecycle(input: {
  expectedCases: readonly string[];
  requiredPreflightChecks: readonly string[];
  caseDeadlineMs: number;
  cleanupDeadlineMs: number;
  preflightDeadlineMs?: number;
  ownership: RunOwnership;
  nonces: NonceRegistry;
  ceilings?: { [K in keyof typeof CEILINGS]: number };
  now?: () => number;
}) {
  const ceilings = input.ceilings ?? CEILINGS;
  const now = input.now ?? Date.now;
  const preflightDeadlineMs = input.preflightDeadlineMs ?? input.caseDeadlineMs;
  for (const ms of [input.caseDeadlineMs, input.cleanupDeadlineMs, preflightDeadlineMs]) if (!Number.isSafeInteger(ms) || ms < 1) throw new Error(`${PREFIX}: a deadline must be a positive whole number of milliseconds`);
  if (input.expectedCases.length === 0 || new Set(input.expectedCases).size !== input.expectedCases.length) throw new Error(`${PREFIX}: the expected cases must be a non-empty list of distinct names`);
  if (input.requiredPreflightChecks.length === 0 || new Set(input.requiredPreflightChecks).size !== input.requiredPreflightChecks.length) throw new Error(`${PREFIX}: the required preflight checks must be a non-empty list of distinct names`);
  const startedAt = now();

  let phase: Exclude<LifecycleState, "POISONED"> = "NOT_STARTED";
  let poisoned: string | null = null;
  let caseInFlight: string | null = null;
  let preflightInFlight = false;
  let preflightTimer: ReturnType<typeof setTimeout> | undefined;
  let onPreflightExpired: ((error: Error) => void) | null = null;
  let verifying = false;
  let verifyInFlight = false;
  let operationSeq = 0;
  let issued = 0;
  let fixtureStatements = 0;
  let fixtureRows = 0;
  let polls = 0;
  let maxConcurrent = 0;
  const operations = new Map<number, OperationRecord>();
  const unknownOperations: string[] = [];
  const passedChecks = new Set<string>();
  const executed: string[] = [];
  const tallies: Record<string, Record<string, number>> = {};
  const migrationRefusals: MigrationRefusal[] = [];
  const fixtureReport: FixtureRecord[] = [];
  const observations: Record<string, unknown> = {};
  const cleanup: { attempted: boolean; accepted: boolean; skipped: string | null; inFlight: boolean; account: CleanupAccount | null; markersDeleted: number | null; markerResidue: number | null; planned: number | null; meter: ReturnType<typeof createCleanupMeter> } = { attempted: false, accepted: false, skipped: null, inFlight: false, account: null, markersDeleted: null, markerResidue: null, planned: null, meter: createCleanupMeter(ceilings.cleanupOperations) };

  const poison = (reason: string): void => {
    if (poisoned === null) poisoned = reason;
    input.ownership.seal("the run is poisoned");
  };
  const refusal = (what: string) => new Error(`${PREFIX}: ${what} refused — the run is poisoned (${String(poisoned)}). A failed live run stops here; it is never retried automatically.`);

  const admit = (what: string, mode: "read" | "write", count = 1): OperationRecord["phase"] => {
    if (poisoned !== null) throw refusal(what);
    if (now() - startedAt > ceilings.runDeadlineMs) {
      poison("the whole-run deadline passed");
      throw refusal(what);
    }
    if (verifying) {
      if (mode === "write") {
        poison(`a write (${what}) was attempted during the post-run comparison`);
        throw refusal(what);
      }
    } else if (phase === "PREFLIGHT") {
      if (mode === "write") {
        poison(`a write (${what}) was attempted before the run was armed`);
        throw refusal(what);
      }
    } else if (phase !== "RUNNING" || caseInFlight === null) {
      poison(`a database operation (${what}) was attempted outside a running case (${phase})`);
      throw refusal(what);
    }
    if (issued + count > ceilings.operations) {
      poison("the run reached its operation limit");
      throw refusal(what);
    }
    if (operations.size + count > ceilings.concurrent) {
      poison(`a request (${what}) would exceed the concurrency ceiling`);
      throw refusal(what);
    }
    return verifying ? "verify" : phase === "PREFLIGHT" ? "preflight" : "case";
  };
  const issue = <T>(record: OperationRecord, operation: () => Promise<T>): Promise<T> => {
    const id = (operationSeq += 1);
    issued += 1;
    operations.set(id, record);
    maxConcurrent = Math.max(maxConcurrent, operations.size);
    let pending: Promise<T>;
    try {
      pending = Promise.resolve(operation());
    } catch (error) {
      pending = Promise.reject(error);
    }
    const tracked = pending.finally(() => void operations.delete(id));
    tracked.catch(() => undefined);
    return tracked;
  };
  const settle = async <T>(record: OperationRecord, operation: () => Promise<T>): Promise<Settled> => {
    try {
      return { status: "fulfilled", value: await issue(record, operation) };
    } catch (reason) {
      return { status: "rejected", reason };
    }
  };
  const fail = (what: string, reason: unknown): Error => {
    const sqlState = sqlStateOf(reason);
    if (sqlState !== null) poison(`the database refused ${what} (SQLSTATE ${sqlState})`);
    else {
      unknownOperations.push(what);
      poison(`no answer for ${what}; it may or may not have taken effect`);
    }
    return refusal(`continuing after ${what} was`);
  };
  const plain = async <T>(what: string, mode: "read" | "write", operation: () => Promise<T>): Promise<T> => {
    const settled = await settle({ what, phase: admit(what, mode), mode }, operation);
    if (settled.status === "rejected") throw fail(what, settled.reason);
    if (poisoned !== null) throw refusal(`using the answer to ${what} was`);
    return settled.value as T;
  };
  const tally = (outcome: MarkerOutcome): void => {
    const bucket = (tallies[caseInFlight ?? ""] ??= {});
    const key = outcome.kind === "database_error" ? `database_error:${outcome.sqlState}` : outcome.kind;
    bucket[key] = (bucket[key] ?? 0) + 1;
  };
  const noteMarker = (what: string, outcome: MarkerOutcome, allowedSqlStates: readonly string[]): void => {
    if (outcome.kind === "consumed" || outcome.kind === "rejected") tally(outcome);
    else if (outcome.kind === "database_error" && allowedSqlStates.includes(outcome.sqlState)) tally(outcome);
    else if (outcome.kind === "database_error") poison(`a marker request (${what}) was refused by the database (SQLSTATE ${outcome.sqlState}); that is not a rejection`);
    else if (outcome.kind === "invariant_failure") poison(`a marker request (${what}) failed closed on a malformed answer; that is not a rejection`);
    else {
      unknownOperations.push(what);
      poison(`no usable answer for a marker request (${what}); it may or may not have been recorded`);
    }
  };

  return {
    state: (): LifecycleState => (poisoned !== null ? "POISONED" : phase),
    poison,
    poisoned: (): string | null => poisoned,
    executed: (): string[] => [...executed],
    inFlightOperations: (): string[] => [...operations.values()].map((record) => record.what),
    inFlightCount: (): number => operations.size,
    caseInFlight: (): string | null => caseInFlight,
    cleanupInFlight: (): boolean => cleanup.inFlight,
    operationsIssued: (): number => issued,
    actualBudget: () => ({ operations: issued, fixtureStatements, fixtureRows, polls, maxConcurrent, scratchSchemas: input.ownership.ownedSchemas().length }),
    /** Records a non-secret observation (an overlap count, a clamped timing) for the evidence. Never affects the verdict by itself. */
    observe(key: string, value: unknown): void {
      observations[key] = value;
    },

    beginPreflight(): void {
      if (poisoned !== null) throw refusal("the preflight");
      if (phase !== "NOT_STARTED") {
        poison("the preflight was started twice");
        throw refusal("the preflight");
      }
      phase = "PREFLIGHT";
      preflightTimer = setTimeout(() => {
        if (phase !== "PREFLIGHT") return;
        poison(`the preflight exceeded its ${preflightDeadlineMs} ms deadline; a read it issued may still be running`);
        onPreflightExpired?.(new Error(`${PREFIX}: the preflight exceeded its deadline. Nothing was written, and nothing is retried.`));
      }, preflightDeadlineMs);
      (preflightTimer as { unref?: () => void }).unref?.();
    },
    async runPreflight<T>(body: () => Promise<T>): Promise<T> {
      this.beginPreflight();
      preflightInFlight = true;
      const tracked = Promise.resolve()
        .then(body)
        .then(
          (value) => {
            preflightInFlight = false;
            return value;
          },
          (error: unknown) => {
            poison("the preflight failed");
            preflightInFlight = false;
            throw error;
          },
        );
      tracked.catch(() => undefined);
      const expired = new Promise<never>((_, reject) => void (onPreflightExpired = reject));
      expired.catch(() => undefined);
      const value = await Promise.race([tracked, expired]);
      if (poisoned !== null) throw refusal("completing the preflight was");
      if (phase === "PREFLIGHT") {
        poison("the preflight ended without arming the run");
        throw refusal("completing the preflight was");
      }
      return value;
    },
    preflightCheck(name: string, passed: boolean): void {
      if (poisoned !== null) throw refusal(`the preflight check "${name}"`);
      if (phase !== "PREFLIGHT" || !input.requiredPreflightChecks.includes(name) || passedChecks.has(name)) {
        poison(`the preflight check "${name}" was not expected here`);
        throw refusal(`the preflight check "${name}"`);
      }
      if (passed !== true) {
        poison(`the preflight check "${name}" did not pass`);
        throw refusal(`the preflight check "${name}"`);
      }
      passedChecks.add(name);
    },
    arm(start: { startEvidence: EvidenceResult }): void {
      if (poisoned !== null) throw refusal("arming the run");
      const missing = input.requiredPreflightChecks.filter((name) => !passedChecks.has(name));
      if (phase !== "PREFLIGHT" || missing.length > 0) poison(phase !== "PREFLIGHT" ? "arming was attempted outside the preflight" : `arming was attempted with ${missing.length} preflight check(s) not passed`);
      else if (operations.size > 0) poison("arming was attempted while a preflight read was still unsettled");
      else if (!start?.startEvidence || start.startEvidence.ok !== true) poison("arming was attempted without saved start evidence");
      if (poisoned !== null) throw refusal("arming the run");
      clearTimeout(preflightTimer);
      phase = "ARMED";
    },

    /** One read. Allowed in the preflight and inside a case. Any failure poisons; it is never repeated. */
    read: <T>(what: string, operation: () => Promise<T>): Promise<T> => plain(what, "read", operation),
    /** One write to a scratch schema or the migration block (any outcome but success poisons). */
    write: <T>(what: string, operation: () => Promise<T>): Promise<T> => plain(what, "write", operation),
    /**
     * Constructs ONE piece of a look-alike FIXTURE. If the database refuses it the scenario cannot test the migration at all, so this
     * is a HARNESS FAILURE and the run is poisoned with that reason — never a migration refusal, never a pass.
     */
    async buildFixture<T>(what: string, operation: () => Promise<T>): Promise<T> {
      const settled = await settle({ what, phase: admit(what, "write"), mode: "write" }, operation);
      if (settled.status === "rejected") {
        fixtureReport.push({ case: caseInFlight, what, constructed: false });
        const sqlState = sqlStateOf(settled.reason);
        poison(`HARNESS FAILURE: the fixture could not be constructed (${what})${sqlState ? ` — SQLSTATE ${sqlState}` : " — no answer"}; the migration was never tested for this scenario`);
        if (sqlState === null) unknownOperations.push(what);
        throw refusal(`continuing after the fixture construction (${what}) failed was`);
      }
      fixtureReport.push({ case: caseInFlight, what, constructed: true });
      if (poisoned !== null) throw refusal(`using the answer to ${what} was`);
      return settled.value as T;
    },
    /** One write to the PUBLIC marker table by the harness (a fixture row set): counted by statement and by row against the budget. */
    async fixtureWrite<T>(what: string, rows: number, operation: () => Promise<T>): Promise<T> {
      if (!Number.isSafeInteger(rows) || rows < 0) {
        poison(`a fixture write (${what}) declared a bad row count`);
        throw refusal(what);
      }
      if (fixtureStatements + 1 > ceilings.fixtureStatements || fixtureRows + rows > ceilings.fixtureRows) {
        poison("the run reached its fixture-write budget");
        throw refusal(what);
      }
      fixtureStatements += 1;
      fixtureRows += rows;
      return plain(what, "write", operation);
    },
    /** One read of pg_stat_activity: counted against the poll budget. */
    async poll<T>(what: string, operation: () => Promise<T>): Promise<T> {
      if (polls + 1 > ceilings.polls) {
        poison("the run reached its limit of activity polls");
        throw refusal(what);
      }
      polls += 1;
      return plain(what, "read", operation);
    },
    /**
     * The migration is EXPECTED TO REFUSE (the fixture was constructed first). Passes only for one of the SQLSTATEs this scenario
     * names; success, any other SQLSTATE, and a lost answer poison with a reason that begins "UNEXPECTED MIGRATION RESULT".
     */
    async expectMigrationRefusal(what: string, operation: () => Promise<unknown>, allowedSqlStates: readonly string[]): Promise<{ sqlState: string; constraint: string | null }> {
      if (allowedSqlStates.length === 0 || !allowedSqlStates.every((code) => typeof code === "string" && SQL_STATE.test(code))) {
        poison(`an expected migration refusal (${what}) named no valid SQLSTATE`);
        throw refusal(what);
      }
      const settled = await settle({ what, phase: admit(what, "write"), mode: "write" }, operation);
      if (settled.status === "fulfilled") {
        poison(`UNEXPECTED MIGRATION RESULT: ${what} was expected to be refused, and was accepted`);
        throw refusal(`continuing after ${what} was`);
      }
      const sqlState = sqlStateOf(settled.reason);
      if (sqlState === null) throw fail(what, settled.reason);
      if (!allowedSqlStates.includes(sqlState)) {
        poison(`UNEXPECTED MIGRATION RESULT: ${what} was refused with SQLSTATE ${sqlState}, which this scenario does not allow`);
        throw refusal(`continuing after ${what} was`);
      }
      if (poisoned !== null) throw refusal(`using the answer to ${what} was`);
      migrationRefusals.push({ case: caseInFlight, what, sqlState });
      return { sqlState, constraint: constraintOf(settled.reason) };
    },
    /** A write the DATABASE must refuse (a constraint check on a scratch table), with one of the named SQLSTATEs. */
    async expectDatabaseRefusal(what: string, operation: () => Promise<unknown>, allowedSqlStates: readonly string[]): Promise<{ sqlState: string; constraint: string | null }> {
      const settled = await settle({ what, phase: admit(what, "write"), mode: "write" }, operation);
      if (settled.status === "fulfilled") {
        poison(`${what} was expected to be refused by the database, and was not`);
        throw refusal(`continuing after ${what} was`);
      }
      const sqlState = sqlStateOf(settled.reason);
      if (sqlState === null) throw fail(what, settled.reason);
      if (!allowedSqlStates.includes(sqlState)) {
        poison(`the database refused ${what} with SQLSTATE ${sqlState}, which this scenario does not allow`);
        throw refusal(`continuing after ${what} was`);
      }
      migrationRefusals.push({ case: caseInFlight, what, sqlState });
      return { sqlState, constraint: constraintOf(settled.reason) };
    },

    /** One marker request. Returns only `consumed` or `rejected`; any other outcome poisons — it is never a rejection. */
    async consume(what: string, operation: () => Promise<unknown>): Promise<"consumed" | "rejected"> {
      const outcome = classifyMarker(await settle({ what, phase: admit(what, "write"), mode: "write" }, operation));
      noteMarker(what, outcome, []);
      if (poisoned !== null || (outcome.kind !== "consumed" && outcome.kind !== "rejected")) throw refusal(`continuing after ${what} was`);
      return outcome.kind;
    },
    /** One marker request the DATABASE is expected to fail with one of these SQLSTATEs (a missing table, a missing unique index). Anything else poisons. */
    async expectMarkerDatabaseError(what: string, operation: () => Promise<unknown>, allowedSqlStates: readonly string[]): Promise<{ sqlState: string }> {
      const outcome = classifyMarker(await settle({ what, phase: admit(what, "write"), mode: "write" }, operation));
      if (outcome.kind !== "database_error") {
        noteMarker(what, outcome, []);
        poison(`${what} was expected to fail with a database error (${allowedSqlStates.join(" or ")}) and did not`);
        throw refusal(`continuing after ${what} was`);
      }
      noteMarker(what, outcome, allowedSqlStates);
      if (poisoned !== null) throw refusal(`continuing after ${what} was`);
      return { sqlState: outcome.sqlState };
    },

    /**
     * Starts ONE tracked operation WITHOUT waiting for it (a lock holder, or a marker request in flight). The caller MUST collect it
     * before its case returns; a case that returns with an uncollected launch is poisoned. The concurrency ceiling is enforced here.
     */
    launch(what: string, operation: () => Promise<unknown>): Launched {
      const record: OperationRecord = { what, phase: admit(what, "write"), mode: "write" };
      return { what, done: settle(record, operation) };
    },
    /** Collects a lock holder that must COMMIT. */
    async collectHolderCommitted(launched: Launched): Promise<unknown> {
      const settled = await launched.done;
      if (settled.status === "rejected") throw fail(launched.what, settled.reason);
      if (poisoned !== null) throw refusal(`using the answer to ${launched.what} was`);
      return settled.value;
    },
    /** Collects a lock holder that must ROLL BACK through its deliberate division by zero (SQLSTATE 22012). */
    async collectHolderRolledBack(launched: Launched): Promise<void> {
      const settled = await launched.done;
      if (settled.status === "fulfilled") {
        poison(`the lock holder (${launched.what}) was expected to roll back and committed`);
        throw refusal(`continuing after ${launched.what} was`);
      }
      const sqlState = sqlStateOf(settled.reason);
      if (sqlState !== "22012") {
        if (sqlState === null) throw fail(launched.what, settled.reason);
        poison(`the lock holder (${launched.what}) ended with SQLSTATE ${sqlState}, not the deliberate 22012 rollback`);
        throw refusal(`continuing after ${launched.what} was`);
      }
      if (poisoned !== null) throw refusal(`using the answer to ${launched.what} was`);
    },
    /** Collects a launched marker request as an outcome (consumed/rejected only, or a named database error). */
    async collectMarker(launched: Launched, allowedSqlStates: readonly string[] = []): Promise<MarkerOutcome> {
      const outcome = classifyMarker(await launched.done);
      noteMarker(launched.what, outcome, allowedSqlStates);
      if (poisoned !== null) throw refusal(`continuing after ${launched.what} was`);
      return outcome;
    },
    /** Collects a launched UNSAFE-CANDIDATE request (rows or a database error): an observation only; it never poisons on its own result. */
    async collectRaw(launched: Launched): Promise<{ rows: unknown } | { sqlState: string | null }> {
      const settled = await launched.done;
      if (settled.status === "rejected") {
        const sqlState = sqlStateOf(settled.reason);
        if (sqlState === null) throw fail(launched.what, settled.reason);
        poison(`the contrast request (${launched.what}) was refused by the database (SQLSTATE ${sqlState})`);
        throw refusal(`continuing after ${launched.what} was`);
      }
      return { rows: settled.value };
    },

    async runCase<T>(name: string, body: () => Promise<T>): Promise<T> {
      if (poisoned !== null) throw refusal(`"${name}" was not run: starting it was`);
      if (phase === "NOT_STARTED" || phase === "PREFLIGHT") throw new Error(`${PREFIX}: not run — the run is not armed, so nothing may be written`);
      if (caseInFlight !== null) poison(`"${caseInFlight}" was still running when "${name}" was about to start`);
      else if (phase !== "ARMED") poison(`"${name}" was about to start in state ${phase}`);
      if (operations.size > 0) poison(`${operations.size} operation(s) were still unsettled when "${name}" was about to start`);
      if (input.expectedCases[executed.length] !== name) poison(`"${name}" is not the next expected case`);
      if (poisoned !== null) throw refusal(`"${name}" was not run: starting it was`);
      phase = "RUNNING";
      caseInFlight = name;
      const tracked = body().then(
        (value) => {
          if (caseInFlight === name) caseInFlight = null;
          return value;
        },
        (error: unknown) => {
          poison(`"${name}" failed`);
          if (caseInFlight === name) caseInFlight = null;
          throw error;
        },
      );
      tracked.catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          poison(`"${name}" exceeded its ${input.caseDeadlineMs} ms deadline; its database requests may still be running or may still complete`);
          reject(new Error(`${PREFIX}: "${name}" exceeded its deadline. Its outcome is uncertain; nothing is retried.`));
        }, input.caseDeadlineMs);
      });
      try {
        const value = await Promise.race([tracked, deadline]);
        if (poisoned !== null) throw refusal(`"${name}" was not counted as run: completing it was`);
        if (operations.size > 0) {
          poison(`"${name}" returned with ${operations.size} operation(s) still unsettled`);
          throw refusal(`"${name}" was not counted as run: completing it was`);
        }
        executed.push(name);
        phase = "ARMED";
        return value;
      } finally {
        clearTimeout(timer);
      }
    },
    afterCase(observed: { reportedFailed: boolean }): void {
      if (phase === "NOT_STARTED" || phase === "PREFLIGHT") return;
      if (caseInFlight !== null) poison(`"${caseInFlight}" was still running when its test ended (it timed out or was abandoned); its database requests may still complete`);
      if (observed.reportedFailed) poison("the test runner reported a test as failed");
    },

    /**
     * The ONE cleanup. Sends something only when the run is armed, clean, complete, and idle; attempted at most once. It removes
     * (1) the registered scratch objects and schemas, RESTRICT only, then (2) EXACTLY the markers this run registered, then reads
     * the table's total row count, which must be ZERO. Any step not confirmed poisons the run.
     */
    async runFinalCleanup(db: QueryDb): Promise<void> {
      const skip = (reason: string): void => {
        if (cleanup.skipped === null && !cleanup.attempted) cleanup.skipped = reason;
      };
      if (phase === "NOT_STARTED" || phase === "PREFLIGHT") return skip("the run never armed; nothing was written");
      if (cleanup.attempted) poison("a second final cleanup was attempted");
      if (caseInFlight !== null) poison(`"${caseInFlight}" was still running when the final cleanup was due`);
      if (operations.size > 0) poison(`${operations.size} operation(s) were still unsettled when the final cleanup was due`);
      if (poisoned === null && (phase !== "ARMED" || executed.length !== input.expectedCases.length)) poison("the final cleanup was due before every expected case had completed");
      if (poisoned !== null) return skip(`nothing was sent: ${poisoned}`);

      // The WHOLE cleanup is counted before any statement is sent: the planned scratch steps, the marker deletions (exact registered list, in chunks), and the
      // two residue reads. A plan over the approved ceiling is refused outright — a half-finished cleanup would leave the branch in a worse, less known state.
      const owned = input.nonces.owned();
      const account = planAdmissionCleanup(input.ownership);
      cleanup.planned = account.steps.length + Math.ceil(owned.length / MARKER_DELETE_CHUNK) + 1;
      if (cleanup.planned > cleanup.meter.limit()) {
        poison(`the final cleanup needs ${cleanup.planned} statements, over its ${cleanup.meter.limit()}-statement ceiling; nothing was sent and the branch is unverified`);
        return skip(`nothing was sent: ${String(poisoned)}`);
      }
      cleanup.attempted = true;
      phase = "CLEANUP";
      input.ownership.seal("the final cleanup began");
      cleanup.account = account;
      let expired = false;
      const gate = createMeteredCleanupGate({
        active: () => poisoned === null && !expired,
        meter: cleanup.meter,
        db,
        onExhausted: () => poison(`the final cleanup reached its ${cleanup.meter.limit()}-statement ceiling; the next statement was NOT sent and the cleanup is unverified`),
      });
      cleanup.inFlight = true;
      const tracked = (async () => {
        await runCleanupPlan(input.ownership, gate, account, () => operations.size + (caseInFlight === null ? 0 : 1));
        if (account.stopped !== null || summarizeCleanup(account).status !== "confirmed") return;
        // The markers: exactly the registered list, in chunks of 100, then the residue read.
        let deleted = 0;
        for (let i = 0; i < owned.length; i += MARKER_DELETE_CHUNK) {
          const chunk = owned.slice(i, i + MARKER_DELETE_CHUNK);
          const rows = (await gate.q(DELETE_OWNED_MARKERS_SQL, [chunk])) as Array<{ nonce?: unknown }>;
          if (!Array.isArray(rows) || rows.some((row) => typeof row?.nonce !== "string" || !chunk.includes(row.nonce)) || new Set(rows.map((row) => row.nonce)).size !== rows.length) throw new Error("marker cleanup returned an unexpected row");
          deleted += rows.length;
        }
        cleanup.markersDeleted = deleted;
        const residue = (await gate.q(COUNT_MARKERS_SQL, [])) as Array<{ n?: unknown }>;
        const n = residue.length === 1 ? residue[0]?.n : null;
        cleanup.markerResidue = typeof n === "number" && Number.isSafeInteger(n) ? n : null;
      })().then(
        () => undefined,
        () => void (account.stopped = account.stopped ?? "a_step_failed"),
      );
      void tracked.then(() => void (cleanup.inFlight = false));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          poison(`the final cleanup exceeded its ${input.cleanupDeadlineMs} ms deadline; a statement it already issued may still complete`);
          reject(new Error(`${PREFIX}: the final cleanup exceeded its deadline. No further cleanup statement will be sent; what was already issued may still complete. Nothing is retried.`));
        }, input.cleanupDeadlineMs);
      });
      try {
        await Promise.race([tracked, deadline]);
      } finally {
        clearTimeout(timer);
      }
      const summary = summarizeCleanup(account);
      if (summary.status !== "confirmed" || account.stopped !== null || cleanup.markersDeleted === null || cleanup.markerResidue !== 0) {
        poison(`the final cleanup was not confirmed (schema steps ${summary.status}; markers deleted ${String(cleanup.markersDeleted)}; marker residue ${String(cleanup.markerResidue)})`);
        throw new Error(`${PREFIX}: the final cleanup was not confirmed. No further cleanup will be attempted; the database state is unknown.`);
      }
      if (poisoned !== null) throw refusal("counting the cleanup as done was");
      cleanup.accepted = true;
    },

    async finish(end: { compare: (read: TrackedRead) => Promise<DeltaVerdict>; deadlineMs?: number }): Promise<FinalReport> {
      const verifyDeadlineMs = end.deadlineMs ?? input.cleanupDeadlineMs;
      if (!Number.isSafeInteger(verifyDeadlineMs) || verifyDeadlineMs < 1) throw new Error(`${PREFIX}: a deadline must be a positive whole number of milliseconds`);
      let delta: DeltaVerdict | null = null;
      const report = (outcome: FinalReport["outcome"], disposition: FinalReport["disposition"], action: string): FinalReport => ({
        outcome,
        disposition,
        completeRestoration: false,
        poisoned,
        executed: [...executed],
        notExecuted: input.expectedCases.filter((name) => !executed.includes(name)),
        inFlightOperations: [...[...operations.values()].map((record) => record.what), ...(preflightInFlight ? ["the preflight"] : []), ...(caseInFlight !== null ? [`case body: ${caseInFlight}`] : []), ...(cleanup.inFlight ? ["the final cleanup"] : []), ...(verifyInFlight ? ["the post-run comparison"] : [])],
        unknownOperations: [...unknownOperations],
        actualBudget: { operations: issued, fixtureStatements, fixtureRows, polls, maxConcurrent, scratchSchemas: input.ownership.ownedSchemas().length },
        markerTallies: Object.fromEntries(Object.entries(tallies).map(([name, tallyOfCase]) => [name, { ...tallyOfCase }])),
        fixtureReport: fixtureReport.map((entry) => ({ ...entry })),
        migrationRefusals: migrationRefusals.map((entry) => ({ ...entry })),
        observations: { ...observations },
        cleanup: { attempted: cleanup.attempted, accepted: cleanup.accepted, skipped: cleanup.skipped, inFlight: cleanup.inFlight, schemaSummary: cleanup.account ? summarizeCleanup(cleanup.account) : null, stopped: cleanup.account?.stopped ?? null, markersDeleted: cleanup.markersDeleted, markerResidue: cleanup.markerResidue, statementsPlanned: cleanup.planned, statementsIssued: cleanup.meter.issued(), statementsRefused: cleanup.meter.refused(), statementCeiling: cleanup.meter.limit() },
        ownedSchemas: input.ownership.ownedSchemas(),
        ownedMarkers: input.nonces.count(),
        delta,
        action,
      });
      if (poisoned === null && (phase === "NOT_STARTED" || phase === "PREFLIGHT")) return report("NOT_STARTED", "not_started", "Nothing was written.");
      if (caseInFlight !== null) poison(`"${caseInFlight}" was still running at the end of the run`);
      if (operations.size > 0) poison(`${operations.size} operation(s) were still unsettled at the end of the run`);
      if (cleanup.inFlight) poison("the final cleanup was still in flight at the end of the run");
      if (poisoned === null && executed.length !== input.expectedCases.length) poison("not every expected case ran");
      if (poisoned === null && !cleanup.accepted) poison("the final cleanup was never confirmed");
      if (poisoned === null) {
        verifying = true;
        verifyInFlight = true;
        const tracked = Promise.resolve().then(() => end.compare((what, operation) => plain(what, "read", operation)));
        void tracked.then(
          () => void (verifyInFlight = false),
          () => void (verifyInFlight = false),
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            poison(`the post-run comparison exceeded its ${verifyDeadlineMs} ms deadline; a read it issued may still be running`);
            reject(new Error(`${PREFIX}: the post-run comparison exceeded its deadline.`));
          }, verifyDeadlineMs);
        });
        try {
          delta = await Promise.race([tracked, deadline]);
        } catch {
          delta = null;
          poison("the post-run comparison could not be read");
        } finally {
          clearTimeout(timer);
          verifying = false;
        }
        if (poisoned === null && delta !== null) {
          if (delta.ok === true && delta.verdict === "baseline_plus_expected_delta" && delta.differences.length === 0) {
            phase = "COMPLETED_CLEAN";
            return report("COMPLETED_CLEAN", "baseline_plus_expected_delta", `None. Every case ran, the cleanup was confirmed, and the database is at its baseline PLUS the expected delta: public.${TABLE} now exists, empty. It was not restored to its pre-run state, and only what the comparison lists as measured was verified.`);
          }
          phase = "COMPLETED_DELTA_MISMATCH";
          return report("COMPLETED_DELTA_MISMATCH", "delta_mismatch", `Every case ran and the cleanup was confirmed, but the database does NOT match its baseline plus the expected delta. ${INVESTIGATE}`);
        }
      }
      const action = !cleanup.attempted
        ? `The run is poisoned. No cleanup was started, so the harness itself removed none of the schemas or markers it registered — but their presence was not verified (see actualBudget for the writes issued), and a request still in flight may have changed things. ${INVESTIGATE}`
        : `The database state is unknown after this failure: the final cleanup was started and not confirmed, so some run-owned schemas or markers may be gone and some may remain (see cleanup). ${INVESTIGATE}`;
      return report("POISONED", "poisoned_evidence_preserved", action);
    },
  };
}
export type LoginChallengeUsesLifecycle = ReturnType<typeof createLoginChallengeUsesLifecycle>;

/** The run's verdict: it passes ONLY when the lifecycle ended COMPLETED_CLEAN with the baseline-plus-expected-delta disposition AND both evidence records were saved. */
export function concludeLoginChallengeUsesRun(final: FinalReport, saved: { start: EvidenceResult; final: EvidenceResult }): { pass: boolean; verdict: "clean_and_evidenced" | "clean_but_not_evidenced" | "not_clean"; message: string } {
  const evidenced = saved.start.ok && saved.final.ok;
  if (final.outcome !== "COMPLETED_CLEAN" || final.disposition !== "baseline_plus_expected_delta" || final.poisoned !== null) return { pass: false, verdict: "not_clean", message: `${PREFIX}: ${final.outcome}. ${final.action}${evidenced ? "" : " An evidence record was also NOT saved."}` };
  if (!evidenced) return { pass: false, verdict: "clean_but_not_evidenced", message: `${PREFIX}: every case ran and the database is at its baseline plus the expected delta, but an evidence record was NOT saved, so this is not an evidenced successful run. Nothing is retried and the database is not touched again.` };
  return { pass: true, verdict: "clean_and_evidenced", message: `${PREFIX}: completed clean (baseline plus expected delta), evidence saved.` };
}

// ------------------------------------------------------------------ the look-alike tables and the registration sequence (moved here so the offline replay uses the very definitions the live run uses)

const INDEX = "real_login_challenge_uses_expires_at_idx";
// The look-alike tables: the intended definition, in parts, so each variant differs from it in exactly one way.
export const COLUMNS = {
  nonce: "nonce BYTEA NOT NULL",
  expires: "expires_at TIMESTAMPTZ NOT NULL",
  used: "used_at TIMESTAMPTZ NOT NULL",
};
export const PRIMARY_KEY = "CONSTRAINT real_login_challenge_uses_pkey PRIMARY KEY (nonce)";
export const LENGTH_CHECK = "CONSTRAINT real_login_challenge_uses_nonce_length_check CHECK (octet_length(nonce) = 16)";
export const tableDdl = (schema: string, parts: readonly string[], options: { prefix?: string; tail?: string } = {}) => `CREATE ${options.prefix ?? ""}TABLE ${schema}.real_login_challenge_uses (${parts.join(", ")})${options.tail ?? ""}`;
export type PartOverrides = Partial<Record<"nonce" | "expires" | "used" | "pk" | "lengthCheck", string | null>>;
export const exact = (overrides: PartOverrides = {}, extra: readonly string[] = []): string[] => {
  const parts = { ...COLUMNS, pk: PRIMARY_KEY, lengthCheck: LENGTH_CHECK, ...overrides };
  return [parts.nonce, parts.expires, parts.used, ...extra.filter((part) => !part.startsWith("CONSTRAINT")), parts.pk, parts.lengthCheck, ...extra.filter((part) => part.startsWith("CONSTRAINT"))].filter((part): part is string => typeof part === "string");
};
export type Variant = { suffix: string; what: string; steps: (schema: string) => Step[]; /** The SQLSTATEs this look-alike may be refused with. Default: the migration's own RAISE (P0001). */ allowed?: readonly string[] };
export const lookAlike = (sql: string): Step => ({ register: ["table", TABLE], sql });
export const expiryIndex = (s: string, definition = "USING btree (expires_at)", prefix = ""): Step => ({ sql: `CREATE ${prefix}INDEX ${INDEX} ON ${s}.${TABLE} ${definition}` });
export const standard = (s: string, overrides: PartOverrides = {}, extra: readonly string[] = []): Step[] => [lookAlike(tableDdl(s, exact(overrides, extra))), expiryIndex(s)];

/**
 * Group A: column and constraint look-alikes. Each is ONE marker table (plus, where the defect needs it, a scratch parent or
 * child) wholly inside its own scratch schema. A column removed is removed together with every constraint that names it, so the
 * database never refuses the FIXTURE: PostgreSQL's own refusal of a fixture would poison the run as a HARNESS FAILURE.
 *
 * Two of them cannot get past the migration's CREATE INDEX before its own guard (a missing expires_at has nothing to index; a JSON
 * column has no btree operator class), so for those the migration is refused by PostgreSQL itself (42703, 42704) — still a refusal,
 * still unchanged, and named explicitly in `allowed`.
 */
export const GROUP_A1: Variant[] = [
  { suffix: "a01", what: "an extra column", steps: (s) => standard(s, {}, ["extra_note TEXT"]) },
  { suffix: "a02", what: "no nonce column (and none of its constraints)", steps: (s) => standard(s, { nonce: null, pk: null, lengthCheck: null }) },
  { suffix: "a03", what: "no expires_at column (so no expiry index can exist)", steps: (s) => [lookAlike(tableDdl(s, exact({ expires: null })))], allowed: ["42703"] },
  { suffix: "a04", what: "no used_at column", steps: (s) => standard(s, { used: null }) },
  { suffix: "a05", what: "nonce as TEXT", steps: (s) => standard(s, { nonce: "nonce TEXT NOT NULL" }) },
  { suffix: "a06", what: "expires_at as TIMESTAMP without time zone", steps: (s) => standard(s, { expires: "expires_at TIMESTAMP NOT NULL" }) },
  { suffix: "a07", what: "expires_at as TEXT", steps: (s) => standard(s, { expires: "expires_at TEXT NOT NULL" }) },
  { suffix: "a08", what: "expires_at as JSON (no btree operator class)", steps: (s) => [lookAlike(tableDdl(s, exact({ expires: "expires_at JSON NOT NULL" })))], allowed: ["42704"] },
  { suffix: "a09", what: "a nullable expires_at", steps: (s) => standard(s, { expires: "expires_at TIMESTAMPTZ" }) },
  { suffix: "a10", what: "a nullable used_at", steps: (s) => standard(s, { used: "used_at TIMESTAMPTZ" }) },
  { suffix: "a11", what: "a default on used_at", steps: (s) => standard(s, { used: "used_at TIMESTAMPTZ NOT NULL DEFAULT now()" }) },
  { suffix: "a12", what: "a generated used_at", steps: (s) => standard(s, { used: "used_at TIMESTAMPTZ GENERATED ALWAYS AS (expires_at) STORED NOT NULL" }) },
  { suffix: "a13", what: "no primary key", steps: (s) => standard(s, { pk: null }) },
  { suffix: "a14", what: "the primary key under the wrong name", steps: (s) => standard(s, { pk: "CONSTRAINT lcu_wrong_pkey PRIMARY KEY (nonce)" }) },
];
export const GROUP_A2: Variant[] = [
  { suffix: "a15", what: "the primary key over two columns", steps: (s) => standard(s, { pk: "CONSTRAINT real_login_challenge_uses_pkey PRIMARY KEY (nonce, expires_at)" }) },
  { suffix: "a16", what: "a unique constraint instead of a primary key", steps: (s) => standard(s, { pk: "CONSTRAINT real_login_challenge_uses_pkey UNIQUE (nonce)" }) },
  { suffix: "a17", what: "a deferrable primary key", steps: (s) => standard(s, { pk: "CONSTRAINT real_login_challenge_uses_pkey PRIMARY KEY (nonce) DEFERRABLE" }) },
  { suffix: "a18", what: "no length CHECK", steps: (s) => standard(s, { lengthCheck: null }) },
  { suffix: "a19", what: "a length CHECK of 15 bytes", steps: (s) => standard(s, { lengthCheck: "CONSTRAINT real_login_challenge_uses_nonce_length_check CHECK (octet_length(nonce) = 15)" }) },
  { suffix: "a20", what: "a length CHECK admitting 15 or 16 bytes", steps: (s) => standard(s, { lengthCheck: "CONSTRAINT real_login_challenge_uses_nonce_length_check CHECK (octet_length(nonce) IN (15, 16))" }) },
  { suffix: "a21", what: "the length CHECK under the wrong name", steps: (s) => standard(s, { lengthCheck: "CONSTRAINT lcu_wrong_length_check CHECK (octet_length(nonce) = 16)" }) },
  { suffix: "a22", what: "a NO INHERIT length CHECK", steps: (s) => standard(s, { lengthCheck: "CONSTRAINT real_login_challenge_uses_nonce_length_check CHECK (octet_length(nonce) = 16) NO INHERIT" }) },
  { suffix: "a23", what: "an extra CHECK", steps: (s) => standard(s, {}, ["CONSTRAINT lcu_extra_check CHECK (expires_at > used_at)"]) },
  {
    suffix: "a24",
    what: "a length CHECK that is not validated",
    steps: (s) => [
      lookAlike(tableDdl(s, exact({ lengthCheck: null }))),
      expiryIndex(s),
      { sql: `ALTER TABLE ${s}.${TABLE} ADD CONSTRAINT real_login_challenge_uses_nonce_length_check CHECK (octet_length(nonce) = 16) NOT VALID` },
    ],
  },
  {
    suffix: "a25",
    what: "a foreign key to another scratch table",
    steps: (s) => [{ register: ["table", "lcu_parent"], sql: `CREATE TABLE ${s}.lcu_parent (nonce BYTEA PRIMARY KEY)` }, lookAlike(tableDdl(s, exact({}, [`CONSTRAINT lcu_out_fk FOREIGN KEY (nonce) REFERENCES ${s}.lcu_parent (nonce)`]))), expiryIndex(s)],
  },
  {
    suffix: "a26",
    what: "another scratch table referencing it",
    steps: (s) => [lookAlike(tableDdl(s, exact())), expiryIndex(s), { register: ["table", "lcu_child"], sql: `CREATE TABLE ${s}.lcu_child (nonce BYTEA, CONSTRAINT lcu_in_fk FOREIGN KEY (nonce) REFERENCES ${s}.${TABLE} (nonce))` }],
  },
  { suffix: "a27", what: "a nullable nonce (and no primary key, which would force NOT NULL)", steps: (s) => standard(s, { nonce: "nonce BYTEA", pk: null }) },
  { suffix: "a28", what: "used_at as TIMESTAMP without time zone", steps: (s) => standard(s, { used: "used_at TIMESTAMP NOT NULL" }) },
];

export const GROUP_A: Variant[] = [...GROUP_A1, ...GROUP_A2];

/**
 * Group B: expiry-index and table-level look-alikes. The expiry index is built here under the migration's exact name but in a wrong
 * shape (`IF NOT EXISTS` trusts only the name), or the name is taken by something else; or the table itself is not ordinary.
 * Every object each one needs is created INSIDE the same scratch schema and registered before it exists, in dependency order.
 */
export const GROUP_B: Variant[] = [
  { suffix: "b01", what: "an extra index on used_at", steps: (s) => [...standard(s), { sql: `CREATE INDEX lcu_extra_idx ON ${s}.${TABLE} USING btree (used_at)` }] },
  { suffix: "b02", what: "a UNIQUE expiry index", steps: (s) => [lookAlike(tableDdl(s, exact())), expiryIndex(s, "USING btree (expires_at)", "UNIQUE ")] },
  { suffix: "b03", what: "the expiry index on the wrong column", steps: (s) => [lookAlike(tableDdl(s, exact())), expiryIndex(s, "USING btree (used_at)")] },
  { suffix: "b04", what: "the expiry index over two columns", steps: (s) => [lookAlike(tableDdl(s, exact())), expiryIndex(s, "USING btree (expires_at, used_at)")] },
  { suffix: "b05", what: "a partial expiry index", steps: (s) => [lookAlike(tableDdl(s, exact())), expiryIndex(s, "USING btree (expires_at) WHERE (expires_at IS NOT NULL)")] },
  { suffix: "b06", what: "an expression expiry index", steps: (s) => [lookAlike(tableDdl(s, exact())), expiryIndex(s, "USING btree ((expires_at AT TIME ZONE 'UTC'))")] },
  { suffix: "b07", what: "a hash expiry index", steps: (s) => [lookAlike(tableDdl(s, exact())), expiryIndex(s, "USING hash (expires_at)")] },
  { suffix: "b08", what: "a descending expiry index", steps: (s) => [lookAlike(tableDdl(s, exact())), expiryIndex(s, "USING btree (expires_at DESC)")] },
  { suffix: "b09", what: "an expiry index with NULLS FIRST", steps: (s) => [lookAlike(tableDdl(s, exact())), expiryIndex(s, "USING btree (expires_at ASC NULLS FIRST)")] },
  { suffix: "b10", what: "an expiry index with a storage option", steps: (s) => [lookAlike(tableDdl(s, exact())), expiryIndex(s, "USING btree (expires_at) WITH (fillfactor = 70)")] },
  {
    suffix: "b11",
    what: "the expiry index name held by an index on another table",
    steps: (s) => [lookAlike(tableDdl(s, exact())), { register: ["table", "lcu_other"], sql: `CREATE TABLE ${s}.lcu_other (expires_at TIMESTAMPTZ)` }, { sql: `CREATE INDEX ${INDEX} ON ${s}.lcu_other USING btree (expires_at)` }],
  },
  { suffix: "b12", what: "the expiry index name held by a table", steps: (s) => [lookAlike(tableDdl(s, exact())), { register: ["table", INDEX], sql: `CREATE TABLE ${s}.${INDEX} (x INT)` }] },
  { suffix: "b13", what: "row-level security enabled", steps: (s) => [...standard(s), { sql: `ALTER TABLE ${s}.${TABLE} ENABLE ROW LEVEL SECURITY` }] },
  { suffix: "b14", what: "a policy without row-level security", steps: (s) => [...standard(s), { sql: `CREATE POLICY lcu_policy ON ${s}.${TABLE} USING (true)` }] },
  {
    suffix: "b15",
    what: "a view under the table's name",
    steps: (s) => [{ register: ["view", TABLE], sql: `CREATE VIEW ${s}.${TABLE} AS SELECT decode('00', 'hex') AS nonce, pg_catalog.now() AS expires_at, pg_catalog.now() AS used_at` }],
  },
  {
    suffix: "b16",
    what: "a trigger calling a scratch function",
    steps: (s) => [
      { register: ["function", "lcu_trigger_fn"], sql: `CREATE FUNCTION ${s}.lcu_trigger_fn() RETURNS trigger LANGUAGE plpgsql AS $lcu$ BEGIN RETURN NEW; END $lcu$` },
      ...standard(s),
      { sql: `CREATE TRIGGER lcu_trigger BEFORE INSERT ON ${s}.${TABLE} FOR EACH ROW EXECUTE FUNCTION ${s}.lcu_trigger_fn()` },
    ],
  },
  { suffix: "b17", what: "a rule", steps: (s) => [...standard(s), { sql: `CREATE RULE lcu_rule AS ON INSERT TO ${s}.${TABLE} DO ALSO NOTHING` }] },
  {
    suffix: "b18",
    what: "an inheritance child of another scratch table",
    steps: (s) => [{ register: ["table", "lcu_parent"], sql: `CREATE TABLE ${s}.lcu_parent ()` }, lookAlike(tableDdl(s, exact(), { tail: ` INHERITS (${s}.lcu_parent)` })), expiryIndex(s)],
  },
  {
    suffix: "b19",
    what: "an inheritance parent of another scratch table",
    steps: (s) => [lookAlike(tableDdl(s, exact())), expiryIndex(s), { register: ["table", "lcu_child"], sql: `CREATE TABLE ${s}.lcu_child () INHERITS (${s}.${TABLE})` }],
  },
  { suffix: "b20", what: "a partitioned table", steps: (s) => [lookAlike(tableDdl(s, exact(), { tail: " PARTITION BY HASH (nonce)" }))] },
  { suffix: "b21", what: "an unlogged table", steps: (s) => [lookAlike(tableDdl(s, exact(), { prefix: "UNLOGGED " })), expiryIndex(s)] },
];

/** Exact hand-built copies that the block must ACCEPT (it creates the index when absent, and keeps what the copy holds). */
export const CONTROL_WITH_INDEX: Variant = { suffix: "ctlidx", what: "an exact hand-built copy with its expiry index", steps: (s) => [lookAlike(tableDdl(s, exact())), expiryIndex(s)] };
export const CONTROL_WITHOUT_INDEX: Variant = { suffix: "ctlnoidx", what: "an exact hand-built copy without its expiry index", steps: (s) => [lookAlike(tableDdl(s, exact()))] };
/** The M11 table: the three intended columns and nothing else — in particular NO unique key on nonce. */
export const NO_KEY_TABLE = (s: string): Step[] => [lookAlike(tableDdl(s, [COLUMNS.nonce, COLUMNS.expires, COLUMNS.used]))];
/** M8: an exact hand-built copy on which the original unsafe candidate is contrasted. */
export const CONTRAST_VARIANT: Variant = { suffix: "contrast", what: "an exact hand-built copy for the contrast", steps: (s) => [lookAlike(tableDdl(s, exact()))] };
/** M11: the three intended columns and NO unique key. */
export const NO_KEY_VARIANT: Variant = { suffix: "nokey", what: "a copy without its unique key", steps: NO_KEY_TABLE };

// ------------------------------------------------------------------ the scratch-schema registration sequence

/** One scratch schema this run registers, and the objects registered inside it, in registration order. */
export type RegistrationPlan = { suffix: string; objects: ReadonlyArray<readonly [ScratchObjectKind, string]> };
const PLAN_SCHEMA = "pb_smoke_00000000_plan";
/** The scratch schema S2 applies the migration in: the migration (not the harness) creates its table, which is registered before the block runs. */
export const APPLY_PLAN: RegistrationPlan = { suffix: "apply", objects: [["table", TABLE]] };
export const registrationOf = (variant: Variant): RegistrationPlan => ({ suffix: variant.suffix, objects: variant.steps(PLAN_SCHEMA).flatMap((step) => (step.register ? [[step.register[0], step.register[1]] as const] : [])) });
/**
 * EVERY scratch schema the live run registers, in the exact order its cases register them: S2 (the apply schema), S4a (both
 * controls, then a01-a14), S4b (a15-a28), S5 (b01-b21), M8 (the contrast copy), and M11 (the copy without its key).
 */
export const REGISTRATION_ORDER: readonly RegistrationPlan[] = [APPLY_PLAN, CONTROL_WITH_INDEX, CONTROL_WITHOUT_INDEX, ...GROUP_A1, ...GROUP_A2, ...GROUP_B, CONTRAST_VARIANT, NO_KEY_VARIANT].map((entry) => ("steps" in entry ? registrationOf(entry) : entry));

/** The scratch-schema capacity the live run asks the shared registry for: its 54 planned schemas plus a small margin, never above the shared hard cap of 60. */
export const SCRATCH_SCHEMA_REGISTRY_CAPACITY = 56;
/** The ONE place the live run's ownership registry is built (the live file calls it; the offline replay calls it too). */
export function createLoginChallengeUsesOwnership(runId: string): RunOwnership {
  return createRunOwnership(runId, { maxScratchSchemas: SCRATCH_SCHEMA_REGISTRY_CAPACITY });
}
/** Registers one plan's schema and its objects, exactly as the live run does (the schema first, then each object). Returns the schema name. */
export function registerPlan(ownership: RunOwnership, plan: RegistrationPlan): string {
  const schema = ownership.registerScratchSchema(plan.suffix);
  for (const [kind, name] of plan.objects) ownership.registerScratchObject(schema, kind, name);
  return schema;
}
/** The registry must hold every planned schema, and may never be configured above the shared hard cap. */
export function checkScratchCapacity(plannedSchemas: number, capacity: number): IdentityCheck {
  if (!Number.isSafeInteger(plannedSchemas) || plannedSchemas < 0 || !Number.isSafeInteger(capacity) || capacity < 1) return { ok: false, reason: "the scratch-schema plan or capacity is malformed" };
  if (capacity > MAX_CONFIGURABLE_SCRATCH_SCHEMAS) return { ok: false, reason: `the scratch-schema capacity ${capacity} exceeds the shared hard cap ${MAX_CONFIGURABLE_SCRATCH_SCHEMAS}` };
  if (plannedSchemas > capacity) return { ok: false, reason: `the run plans ${plannedSchemas} scratch schemas but its registry holds only ${capacity}` };
  return { ok: true };
}

