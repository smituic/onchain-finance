import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { TURNKEY_API_BASE_URL } from "@/lib/real/constants";
import type { ResolverReport } from "@/lib/real/server/passkey-revocation-resolver";
import {
  ADMIN_RUNNERS,
  AdminCommitNotApplied,
  AdminRefusal,
  COMMIT_CONFIRMATION_ENV,
  EXPECTED_DATABASE_ENV,
  EXPECTED_ENDPOINT_ENV,
  classifyNotCommitted,
  commitConfirmation,
  requireAdminTarget,
  requireApprovedTurnkeyConfig,
  requireApprovedTurnkeyHost,
  requireCommitDecision,
  requireCommitOutcome,
  resolveAdminTarget,
  type AdminRunner,
  type Env,
} from "./admin-target";

/**
 * Offline. The operator-confirmation contract of the three manual admin
 * runners. Synthetic `.invalid` hosts and mocked connectors only — nothing
 * here connects, and no runner is executed.
 */
const ENDPOINT = "ep-admin-target-000004";
const DATABASE = "neondb";
const host = (id: string) => `${id}.c-1.us-east-2.aws.neon.invalid`;
const urlOf = (hostname: string, tail = `/${DATABASE}?sslmode=require&channel_binding=require`, userinfo = "app:secret") => `postgresql://${userinfo}@${hostname}${tail}`;
const URL_DIRECT = urlOf(host(ENDPOINT));
const RUNNERS = Object.values(ADMIN_RUNNERS) as AdminRunner[];
const base = (runner: AdminRunner, extra: Env = {}): Env => ({ [runner.primaryGate]: "1", DATABASE_URL: URL_DIRECT, [EXPECTED_ENDPOINT_ENV]: ENDPOINT, [EXPECTED_DATABASE_ENV]: DATABASE, ...extra });

function expectRefused(result: ReturnType<typeof resolveAdminTarget>, reason: RegExp) {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toMatch(reason);
    expect(result.reason).not.toMatch(/secret|postgres(ql)?:\/\/\S|neon\.invalid|00000\d|ep-admin/); // never a URL, a credential, or an identifier
  }
}

describe.each(RUNNERS)("admin target confirmation — $name", (runner) => {
  it("accepts its gate + an explicit DATABASE_URL + the matching endpoint id and database name, and returns that exact URL", () => {
    for (const [given, canonical] of [
      [URL_DIRECT, URL_DIRECT],
      [urlOf(host(`${ENDPOINT}-pooler`)), urlOf(host(`${ENDPOINT}-pooler`))], // the application's pooled URL is a legitimate target
      [`  ${URL_DIRECT}\t`, URL_DIRECT],
      [`"${URL_DIRECT}"`, URL_DIRECT],
      [urlOf(host(ENDPOINT), `/${DATABASE}`), urlOf(host(ENDPOINT), `/${DATABASE}`)],
    ] as const) {
      expect(resolveAdminTarget({ env: base(runner, { DATABASE_URL: given }), runner })).toEqual({ ok: true, url: canonical, endpoint: ENDPOINT, database: DATABASE });
    }
    expect(requireAdminTarget({ env: base(runner), runner })).toEqual({ url: URL_DIRECT, endpoint: ENDPOINT, database: DATABASE });
  });

  it("accepts every variable THIS runner documents, alongside the target", () => {
    const own = Object.fromEntries([runner.commitGate, ...runner.variables, ...(runner.confirmsCommit ? [COMMIT_CONFIRMATION_ENV] : [])].map((name) => [name, "x"]));
    expect(resolveAdminTarget({ env: base(runner, own), runner }).ok).toBe(true);
  });

  it("a real endpoint is NOT refused for being real, and no env file is consulted", () => {
    // Nothing distinguishes "real" here: the operator names the endpoint, whatever it is.
    const source = readFileSync("test/admin/admin-target.ts", "utf8");
    const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
    expect(code).not.toMatch(/readActiveEnvFiles|readFileSync|existsSync|node:fs|process\.env/); // no file, and no ambient environment, is ever read
    expect(resolveAdminTarget({ env: base(runner), runner }).ok).toBe(true);
  });

  it.each<[string, (r: AdminRunner) => Env, RegExp]>([
    ["no primary gate", (r) => base(r, { [r.primaryGate]: undefined }), /is not set to exactly 1/],
    ["DATABASE_URL alone", () => ({ DATABASE_URL: URL_DIRECT }), /is not set to exactly 1/],
    ["DATABASE_URL and both confirmations, no gate", (r) => base(r, { [r.primaryGate]: undefined }), /is not set to exactly 1/],
    ["the commit flag without the primary gate", (r) => base(r, { [r.primaryGate]: undefined, [r.commitGate]: "1" }), /is not set to exactly 1/],
    ["the primary gate set to true", (r) => base(r, { [r.primaryGate]: "true" }), /is not set to exactly 1/],
    ["the primary gate padded", (r) => base(r, { [r.primaryGate]: " 1" }), /is not set to exactly 1/],
    ["missing target", (r) => base(r, { DATABASE_URL: undefined }), /DATABASE_URL is not set/],
    ["empty target", (r) => base(r, { DATABASE_URL: "  " }), /DATABASE_URL is not set/],
    ["missing expected endpoint", (r) => base(r, { [EXPECTED_ENDPOINT_ENV]: undefined }), /REAL_ADMIN_EXPECTED_ENDPOINT_ID is not set/],
    ["empty expected endpoint", (r) => base(r, { [EXPECTED_ENDPOINT_ENV]: "" }), /REAL_ADMIN_EXPECTED_ENDPOINT_ID is not set/],
    ["missing expected database name", (r) => base(r, { [EXPECTED_DATABASE_ENV]: undefined }), /REAL_ADMIN_EXPECTED_DATABASE_NAME is not set/],
    ["empty expected database name", (r) => base(r, { [EXPECTED_DATABASE_ENV]: "" }), /REAL_ADMIN_EXPECTED_DATABASE_NAME is not set/],
    ["endpoint mismatch", (r) => base(r, { [EXPECTED_ENDPOINT_ENV]: "ep-other-000009" }), /endpoint does not match/],
    ["endpoint prefix", (r) => base(r, { [EXPECTED_ENDPOINT_ENV]: "ep-admin-target" }), /endpoint does not match/],
    ["expected endpoint in its pooled form", (r) => base(r, { [EXPECTED_ENDPOINT_ENV]: `${ENDPOINT}-pooler` }), /not a bare endpoint id/],
    ["expected endpoint as a hostname", (r) => base(r, { [EXPECTED_ENDPOINT_ENV]: host(ENDPOINT) }), /not a bare endpoint id/],
    ["expected endpoint in upper case", (r) => base(r, { [EXPECTED_ENDPOINT_ENV]: ENDPOINT.toUpperCase() }), /not a bare endpoint id/],
    ["expected endpoint padded", (r) => base(r, { [EXPECTED_ENDPOINT_ENV]: `${ENDPOINT} ` }), /not a bare endpoint id/],
    ["database-name mismatch", (r) => base(r, { [EXPECTED_DATABASE_ENV]: "postgres" }), /database does not match/],
    ["database name differing only in case", (r) => base(r, { [EXPECTED_DATABASE_ENV]: "NeonDB" }), /database does not match/],
    ["database name with a path", (r) => base(r, { [EXPECTED_DATABASE_ENV]: "neondb/x" }), /not a plain database name/],
    ["another database on the right endpoint", (r) => base(r, { DATABASE_URL: urlOf(host(ENDPOINT), "/other") }), /database does not match/],
    ["malformed URL", (r) => base(r, { DATABASE_URL: "not a url" }), /DATABASE_URL is missing or not a URL/],
    ["a non-postgres scheme", (r) => base(r, { DATABASE_URL: `https://${host(ENDPOINT)}/${DATABASE}` }), /is not a postgres:\/\/ URL/],
    ["a trailing quote", (r) => base(r, { DATABASE_URL: `${URL_DIRECT}"` }), /unbalanced or stray quotes/],
    ["mismatched quotes", (r) => base(r, { DATABASE_URL: `"${URL_DIRECT}'` }), /unbalanced or stray quotes/],
    ["mixed-case hostname", (r) => base(r, { DATABASE_URL: urlOf(host(ENDPOINT).toUpperCase()) }), /mixed-case hostname/],
    ["mixed-case endpoint label", (r) => base(r, { DATABASE_URL: urlOf(host(ENDPOINT).replace("ep-admin", "Ep-Admin")) }), /mixed-case hostname/],
    ["routing override: options=endpoint", (r) => base(r, { DATABASE_URL: urlOf(host(ENDPOINT), `/${DATABASE}?options=endpoint%3Dep-other-000009`) }), /unsupported or repeated connection parameter/],
    ["routing override: host=", (r) => base(r, { DATABASE_URL: urlOf(host(ENDPOINT), `/${DATABASE}?host=${host("ep-other-000009")}`) }), /unsupported or repeated connection parameter/],
    ["routing override smuggled in a value", (r) => base(r, { DATABASE_URL: urlOf(host(ENDPOINT), `/${DATABASE}?sslmode=require;options=endpoint=ep-other-000009`) }), /unsupported or repeated connection parameter/],
    ["routing override in the password", (r) => base(r, { DATABASE_URL: urlOf(host(ENDPOINT), `/${DATABASE}`, "app:endpoint%3Dep-other-000009%24x") }), /routing override in its credentials/],
    ["a second @", (r) => base(r, { DATABASE_URL: `postgresql://app:secret@${host("ep-other-000009")}@${host(ENDPOINT)}/${DATABASE}` }), /exactly one "@"/],
    ["a non-default port", (r) => base(r, { DATABASE_URL: urlOf(`${host(ENDPOINT)}:6543`) }), /non-default port/],
    ["a smoke gate", (r) => base(r, { REAL_SMOKE_NEON_ADAPTER: "1" }), /a smoke gate or smoke variable is set/],
    ["a smoke sub-gate", (r) => base(r, { REAL_SMOKE_L2_INDEXES: "1" }), /a smoke gate or smoke variable is set/],
    ["the race suite's direct URL", (r) => base(r, { REAL_SMOKE_L2_DIRECT_DATABASE_URL: URL_DIRECT }), /a smoke gate or smoke variable is set/],
    ["a smoke gate set to 0", (r) => base(r, { REAL_SMOKE_RATE_LIMIT: "0" }), /a smoke gate or smoke variable is set/],
    ["a branch URL", (r) => base(r, { NEON_BRANCH_DATABASE_URL: URL_DIRECT }), /a disposable-branch variable is set/],
    ["a branch expected-endpoint id", (r) => base(r, { NEON_BRANCH_EXPECTED_ENDPOINT_ID: ENDPOINT }), /a disposable-branch variable is set/],
    ["an unknown admin variable", (r) => base(r, { REAL_ADMIN_FUTURE_FLAG: "1" }), /an admin variable this runner does not use is set/],
    ["an unknown admin commit-like flag", (r) => base(r, { REAL_ADMIN_COMMIT: "1" }), /an admin variable this runner does not use is set/],
  ])("refuses: %s", (_name, makeEnv, reason) => {
    expectRefused(resolveAdminTarget({ env: makeEnv(runner), runner }), reason);
  });

  it("refuses every OTHER runner's gate, commit flag, and variables — only its own are allowed", () => {
    for (const other of RUNNERS) {
      if (other.name === runner.name) continue;
      const foreign = [other.primaryGate, other.commitGate, ...other.variables].filter((name) => name !== runner.primaryGate && name !== runner.commitGate && !runner.variables.includes(name));
      expect(foreign.length).toBeGreaterThanOrEqual(2);
      for (const name of foreign) expectRefused(resolveAdminTarget({ env: base(runner, { [name]: "1" }), runner }), /an admin variable this runner does not use is set/);
    }
    if (!runner.confirmsCommit) expectRefused(resolveAdminTarget({ env: base(runner, { [COMMIT_CONFIRMATION_ENV]: "x" }), runner }), /an admin variable this runner does not use is set/);
  });

  it("every refusal throws before a connector or a provider is reached, with a secret-free message", () => {
    const connect = vi.fn();
    const provider = vi.fn();
    for (const env of [
      base(runner, { [EXPECTED_ENDPOINT_ENV]: undefined }),
      base(runner, { [EXPECTED_DATABASE_ENV]: "postgres" }),
      base(runner, { [EXPECTED_ENDPOINT_ENV]: "ep-other-000009" }),
      base(runner, { REAL_SMOKE_NEON_ADAPTER: "1" }),
      base(runner, { DATABASE_URL: urlOf(host(ENDPOINT).toUpperCase()) }),
      { DATABASE_URL: URL_DIRECT },
    ]) {
      let message = "";
      try {
        const target = requireAdminTarget({ env, runner });
        requireApprovedTurnkeyHost({ env, runner });
        connect(target.url);
        provider();
      } catch (error) {
        expect(error).toBeInstanceOf(AdminRefusal);
        message = (error as Error).message;
      }
      expect(message.startsWith(`admin runner ${runner.name} refused: `)).toBe(true);
      expect(message).not.toMatch(/secret|postgres(ql)?:\/\/\S|neon\.invalid|00000\d/);
    }
    expect(connect).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it("the Turnkey host is pinned: an override naming any other host is refused before a provider call", () => {
    for (const env of [base(runner), base(runner, { TURNKEY_API_BASE_URL: TURNKEY_API_BASE_URL }), base(runner, { TURNKEY_API_BASE_URL: ` ${TURNKEY_API_BASE_URL} ` }), base(runner, { TURNKEY_API_BASE_URL: "" })]) {
      expect(() => requireApprovedTurnkeyHost({ env, runner })).not.toThrow();
    }
    const provider = vi.fn();
    for (const override of ["https://api.turnkey.invalid", "http://api.turnkey.com", "https://api.turnkey.com/", "https://api.turnkey.com.evil.invalid", "https://API.turnkey.com", "https://api.turnkey.com:8443", "https://api.turnkey.com?x=1", "api.turnkey.com"]) {
      expect(() => {
        requireApprovedTurnkeyHost({ env: base(runner, { TURNKEY_API_BASE_URL: override }), runner });
        provider();
      }, override).toThrow(/TURNKEY_API_BASE_URL overrides the approved Turnkey API host/);
    }
    expect(provider).not.toHaveBeenCalled();
    expect(() => requireApprovedTurnkeyConfig({ config: { turnkeyApiBaseUrl: TURNKEY_API_BASE_URL }, runner })).not.toThrow();
    expect(() => requireApprovedTurnkeyConfig({ config: { turnkeyApiBaseUrl: "https://api.turnkey.invalid" }, runner })).toThrow(/not the approved one/);
  });
});

describe("the approved Turnkey host is the repository's own", () => {
  it("is lib/real/constants.ts's value, which is also the server config's default", () => {
    expect(TURNKEY_API_BASE_URL).toBe("https://api.turnkey.com");
    expect(readFileSync("lib/real/server/config.ts", "utf8")).toContain('env.TURNKEY_API_BASE_URL?.trim() || "https://api.turnkey.com"');
    expect(readFileSync("test/admin/admin-target.ts", "utf8")).toContain('import { TURNKEY_API_BASE_URL } from "@/lib/real/constants";');
  });
});

describe("commit decision", () => {
  const target = { endpoint: ENDPOINT, database: DATABASE };
  const poll = ADMIN_RUNNERS.poll;
  const resolve = ADMIN_RUNNERS.resolve;
  const backfill = ADMIN_RUNNERS.backfill;
  const pollOperation = ["cred-abc_123", "latest", "quiescent"];
  const resolveOperation = ["3f58e923-0000-4000-8000-000000000001", "9a1b2c3d-0000-4000-8000-000000000002"];
  const decide = (runner: AdminRunner, env: Env, operation: readonly string[]) => requireCommitDecision({ env, runner, target, operation });

  it("the confirmation names the runner, the endpoint and database, and the one operation", () => {
    expect(commitConfirmation(poll, target, pollOperation)).toBe(`poll-provisioning-activity:${ENDPOINT}/${DATABASE}:cred-abc_123:latest:quiescent`);
    expect(commitConfirmation(resolve, target, resolveOperation)).toBe(`resolve-passkey-revocation:${ENDPOINT}/${DATABASE}:${resolveOperation[0]}:${resolveOperation[1]}`);
  });

  it("dry run when no commit flag is set", () => {
    expect(decide(poll, {}, pollOperation)).toBe(false);
    expect(decide(resolve, {}, resolveOperation)).toBe(false);
    expect(decide(backfill, {}, [])).toBe(false);
  });

  it("commits only with the flag exactly 1 AND the exact confirmation", () => {
    expect(decide(poll, { [poll.commitGate]: "1", [COMMIT_CONFIRMATION_ENV]: commitConfirmation(poll, target, pollOperation) }, pollOperation)).toBe(true);
    expect(decide(resolve, { [resolve.commitGate]: "1", [COMMIT_CONFIRMATION_ENV]: commitConfirmation(resolve, target, resolveOperation) }, resolveOperation)).toBe(true);
    // The backfill's commit is bound to its preview digest instead (backfill-run.ts), so the flag alone passes THIS step.
    expect(decide(backfill, { [backfill.commitGate]: "1" }, [])).toBe(true);
  });

  it.each<[string, AdminRunner, readonly string[]]>([
    ["poll", poll, pollOperation],
    ["resolve", resolve, resolveOperation],
  ])("%s: a stale or mis-aimed commit is refused, never silently downgraded or honored", (_name, runner, operation) => {
    const good = commitConfirmation(runner, target, operation);
    const refusals: Array<[string, Env, RegExp]> = [
      ["the commit flag alone (missing commit confirmation)", { [runner.commitGate]: "1" }, /is set but REAL_ADMIN_COMMIT_CONFIRMATION is not/],
      ["an empty confirmation", { [runner.commitGate]: "1", [COMMIT_CONFIRMATION_ENV]: "" }, /is set but REAL_ADMIN_COMMIT_CONFIRMATION is not/],
      ["a generic yes", { [runner.commitGate]: "1", [COMMIT_CONFIRMATION_ENV]: "yes" }, /does not match this runner, target, and operation/],
      ["a confirmation for another endpoint", { [runner.commitGate]: "1", [COMMIT_CONFIRMATION_ENV]: commitConfirmation(runner, { endpoint: "ep-other-000009", database: DATABASE }, operation) }, /does not match/],
      ["a confirmation for another database", { [runner.commitGate]: "1", [COMMIT_CONFIRMATION_ENV]: commitConfirmation(runner, { endpoint: ENDPOINT, database: "postgres" }, operation) }, /does not match/],
      ["a confirmation for another operation", { [runner.commitGate]: "1", [COMMIT_CONFIRMATION_ENV]: commitConfirmation(runner, target, [...operation.slice(0, -1), "other"]) }, /does not match/],
      ["the other runner's confirmation", { [runner.commitGate]: "1", [COMMIT_CONFIRMATION_ENV]: commitConfirmation(runner === poll ? resolve : poll, target, operation) }, /does not match/],
      ["a padded confirmation", { [runner.commitGate]: "1", [COMMIT_CONFIRMATION_ENV]: ` ${good}` }, /does not match/],
      ["a confirmation in another letter case", { [runner.commitGate]: "1", [COMMIT_CONFIRMATION_ENV]: good.toUpperCase() }, /does not match/],
      ["the flag set to true", { [runner.commitGate]: "true", [COMMIT_CONFIRMATION_ENV]: good }, /must be exactly 1, or unset for a dry run/],
      ["the flag set to 0", { [runner.commitGate]: "0" }, /must be exactly 1, or unset for a dry run/],
      ["the flag set to an empty string", { [runner.commitGate]: "" }, /must be exactly 1, or unset for a dry run/],
      ["a confirmation left set without the flag", { [COMMIT_CONFIRMATION_ENV]: good }, /is set without/],
    ];
    for (const [name, env, reason] of refusals) {
      const write = vi.fn();
      expect(() => {
        if (decide(runner, env, operation)) write();
      }, name).toThrow(reason);
      expect(write, name).not.toHaveBeenCalled();
    }
  });

  it("the confirmation never appears in a refusal, and neither do the operation's identifiers", () => {
    for (const [runner, operation] of [[poll, pollOperation], [resolve, resolveOperation]] as const) {
      let message = "";
      try {
        decide(runner, { [runner.commitGate]: "1", [COMMIT_CONFIRMATION_ENV]: "wrong-secret-looking-value" }, operation);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/does not match/);
      for (const leak of ["wrong-secret-looking-value", ...operation.filter((part) => part !== "latest" && part !== "quiescent"), ENDPOINT]) expect(message).not.toContain(leak);
    }
  });

  it("a commit whose operation identifiers are missing cannot be confirmed at all", () => {
    for (const operation of [["", "latest", "quiescent"], ["a:b", "latest", "quiescent"]]) {
      expect(() => decide(poll, { [poll.commitGate]: "1", [COMMIT_CONFIRMATION_ENV]: commitConfirmation(poll, target, operation) }, operation)).toThrow(/identifiers are missing or malformed/);
    }
    expect(() => decide(resolve, { [resolve.commitGate]: "1", [COMMIT_CONFIRMATION_ENV]: commitConfirmation(resolve, target, ["", ""]) }, ["", ""])).toThrow(/identifiers are missing or malformed/);
  });

  it("poll: the dispatch in the confirmation is the dispatch that runs — a confirmation for 'latest' does not commit dispatch 2, or the reverse", () => {
    const forLatest = commitConfirmation(poll, target, ["cred-abc_123", "latest", "quiescent"]);
    const forTwo = commitConfirmation(poll, target, ["cred-abc_123", "2", "quiescent"]);
    expect(() => decide(poll, { [poll.commitGate]: "1", [COMMIT_CONFIRMATION_ENV]: forLatest }, ["cred-abc_123", "2", "quiescent"])).toThrow(/does not match/);
    expect(() => decide(poll, { [poll.commitGate]: "1", [COMMIT_CONFIRMATION_ENV]: forTwo }, ["cred-abc_123", "latest", "quiescent"])).toThrow(/does not match/);
    // ...and it must carry the operator's statement that no registration is in flight.
    expect(() => decide(poll, { [poll.commitGate]: "1", [COMMIT_CONFIRMATION_ENV]: forLatest.replace(/:quiescent$/, "") }, ["cred-abc_123", "latest", "quiescent"])).toThrow(/does not match/);
  });
});

// L-A: a run that asked for a commit succeeds only if the report says it committed.
describe("commit outcome: a requested commit that wrote nothing is not a success", () => {
  const poll = ADMIN_RUNNERS.poll;
  const resolve = ADMIN_RUNNERS.resolve;
  /** Synthetic resolver reports, in the production report's own type and outcome codes. */
  const resolver = (outcome: ResolverReport["outcome"], reason: string): ResolverReport => ({ outcome, reason, committed: outcome === "resolved" });

  it("resolve dry run stays successful, and writes nothing", () => {
    for (const report of [resolver("resolvable_dry_run", "evidence_complete"), resolver("no_receipt", "no_receipt"), resolver("already_resolved", "resolution_exists")]) {
      expect(() => requireCommitOutcome({ runner: resolve, commit: false, report })).not.toThrow();
    }
  });

  it("resolve commit with committed=true succeeds", () => {
    expect(() => requireCommitOutcome({ runner: resolve, commit: true, report: resolver("resolved", "evidence_complete") })).not.toThrow();
  });

  it.each<[ResolverReport["outcome"], string, "previously_processed" | "state_uncertain_or_changed" | "declined", RegExp]>([
    ["already_resolved", "resolution_exists", "previously_processed", /already processed before this run: a no-op, not a new write and not a data error/],
    ["already_resolved", "resolved_concurrently", "previously_processed", /already processed before this run/],
    ["turnkey_read_failed", "turnkey_read_failed", "state_uncertain_or_changed", /uncertain or changed underneath this run: read again/],
    ["turnkey_read_incomplete", "page_limit", "state_uncertain_or_changed", /uncertain or changed/],
    ["activity_log_changed", "head_moved", "state_uncertain_or_changed", /uncertain or changed/],
    ["lost_race", "lost_race", "state_uncertain_or_changed", /uncertain or changed/],
    ["not_resolvable_state", "attempt_not_blocked", "declined", /did not allow a commit: nothing was changed/],
    ["no_receipt", "no_receipt", "declined", /did not allow a commit/],
    ["target_still_present", "target_present", "declined", /did not allow a commit/],
    ["inconsistent_manual_review", "inconsistent", "declined", /did not allow a commit/],
    ["resolvable_dry_run", "evidence_complete", "declined", /did not allow a commit/],
  ])("resolve commit with committed=false fails — %s (%s) is reported as %s", (outcome, reason, kind, meaning) => {
    const report = resolver(outcome, reason);
    const before = JSON.stringify(report);
    let thrown: unknown;
    try {
      requireCommitOutcome({ runner: resolve, commit: true, report });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AdminCommitNotApplied);
    const failure = thrown as AdminCommitNotApplied;
    expect(failure.kind).toBe(kind);
    expect(classifyNotCommitted(resolve, report)).toBe(kind);
    expect(failure.message).toMatch(meaning);
    expect(failure.message).toContain(`a COMMIT was requested but NOTHING was committed by this run — outcome=${outcome} reason=${reason} `);
    expect(failure.message).toContain("Not retried.");
    expect(failure.report).toEqual({ outcome, reason, committed: false });
    expect(JSON.stringify(report)).toBe(before); // the report the runner already printed is left exactly as it was
  });

  it("a previously processed result is never described as a new write, a data error, or an uncertain state", () => {
    for (const [runner, report] of [[resolve, resolver("already_resolved", "resolution_exists")], [poll, { outcome: "refused", reason: "already_terminal", committed: false }]] as const) {
      let message = "";
      try {
        requireCommitOutcome({ runner, commit: true, report });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/not a new write and not a data error/);
      expect(message).not.toMatch(/uncertain|corrupt|did not allow/);
    }
  });

  it("a dry run that reports a write is itself a failure", () => {
    expect(() => requireCommitOutcome({ runner: resolve, commit: false, report: { outcome: "resolved", reason: "evidence_complete", committed: true } })).toThrow(/a DRY RUN reported a write/);
    expect(() => requireCommitOutcome({ runner: poll, commit: false, report: { outcome: "terminal", reason: null, committed: true } })).toThrow(/a DRY RUN reported a write/);
  });

  it("the check is pure: it has no dependency to call, so it cannot retry, re-read, or write", () => {
    const source = readFileSync("test/admin/admin-target.ts", "utf8");
    const body = source.slice(source.indexOf("export function requireCommitOutcome("));
    expect(body).not.toMatch(/await |import\(|fetch|\bstore\.|\bport\.|\bledger\./);
    expect(requireCommitOutcome.length).toBe(1);
  });
});

describe("the three runners use the contract (static)", () => {
  const code = (file: string) =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
  const FILES: Array<[string, AdminRunner, string]> = [
    ["test/admin/backfill-turnkey-authenticator-ids.admin.test.ts", ADMIN_RUNNERS.backfill, "backfill"],
    ["test/admin/poll-provisioning-activity.admin.test.ts", ADMIN_RUNNERS.poll, "poll"],
    ["test/admin/resolve-passkey-revocation.admin.test.ts", ADMIN_RUNNERS.resolve, "resolve"],
  ];

  it.each(FILES)("%s: enabled by its primary gate alone; target, host, and commit decision come first; connectors get only target.url", (file, runner, key) => {
    const source = code(file);
    expect(source).toContain(`const RUNNER = ADMIN_RUNNERS.${key};`);
    expect(source).toContain(`const enabled = process.env.${runner.primaryGate} === "1";`);
    expect(source.match(/describe\.skipIf\(!enabled\)\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/DATABASE_URL/);
    const body = source.slice(source.indexOf("describe.skipIf(!enabled)("));
    const target = body.indexOf("const target = requireAdminTarget({ env: process.env, runner: RUNNER });");
    const hostCheck = body.indexOf("requireApprovedTurnkeyHost({ env: process.env, runner: RUNNER });");
    const decision = key === "poll" ? body.indexOf("const { commit, dispatchSeq } = requirePollCommitDecision({ env: process.env, runner: RUNNER, target, credentialId, rawSeq });") : body.indexOf("const commit = requireCommitDecision({ env: process.env, runner: RUNNER, target, operation:");
    const firstImport = body.indexOf("await import(");
    expect(target).toBeGreaterThan(-1);
    expect(hostCheck).toBeGreaterThan(target);
    expect(decision).toBeGreaterThan(hostCheck);
    expect(firstImport).toBeGreaterThan(decision); // nothing that can reach a database or Turnkey is even loaded before the refusals
    expect(body.indexOf("requireApprovedTurnkeyConfig({ config, runner: RUNNER });")).toBeGreaterThan(body.indexOf("requireRealServerConfig()"));
    // Every connector is handed the validated URL, and the commit flag is never read directly.
    const connectors = body.match(/\b(neon|createNeonSqlClient)\(([^()]*)\)/g) ?? [];
    expect(connectors.length).toBe(1);
    expect(connectors[0]).toMatch(/\((target\.url)\)$/);
    expect(body).not.toContain(`process.env.${runner.commitGate}`);
    expect(body).not.toMatch(/process\.env\.REAL_ADMIN_COMMIT_CONFIRMATION|process\.env\.TURNKEY_/);
  });

  it("each runner reads from the environment only its own documented variables", () => {
    for (const [file, runner] of FILES) {
      const names = [...new Set([...code(file).matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((match) => match[1]!))].sort();
      const allowed = [runner.primaryGate, ...runner.variables].sort();
      for (const name of names) expect(allowed, `${file} reads ${name}`).toContain(name);
      expect(names).toContain(runner.primaryGate);
    }
  });

  it("the backfill is dry-run first: the plain production helper is not called by the runner, and a commit goes through the bounded path", () => {
    const source = code(FILES[0]![0]);
    expect(source).not.toMatch(/\bbackfillTurnkeyAuthenticatorIds\(/);
    expect(source).toContain("const preview = await previewBackfill(run);");
    expect(source).toContain("const result = await commitBackfill({ ...run, expectedCount, expectedDigest, onProgress:");
    expect(source.indexOf("if (!commit) {")).toBeLessThan(source.indexOf("await commitBackfill("));
    // ...and only a COMPLETED commit passes: the success check is the last thing the commit path does.
    expect(source).toContain("requireCompletedCommit(result);");
    expect(source.indexOf("requireCompletedCommit(result);")).toBeGreaterThan(source.indexOf("await commitBackfill("));
    expect(source).toContain('expect(result.status).toBe("completed");');
    expect(source).toContain("binding: { endpoint: target.endpoint, database: target.database },");
  });

  it("poll and resolve end by requiring the commit outcome — after the report is printed, with no call after it", () => {
    for (const [file] of FILES.slice(1)) {
      const source = code(file);
      const print = source.indexOf("console.log(JSON.stringify({ mode: commit ?");
      const outcome = source.indexOf("requireCommitOutcome({ runner: RUNNER, commit, report });");
      expect(print).toBeGreaterThan(-1);
      expect(outcome).toBeGreaterThan(print); // the full redacted report is on screen before a failure is raised
      expect(source.slice(outcome)).not.toMatch(/await |pollProvisioningDispatch\(|resolveBlockedRevocation\(/); // nothing runs after it: no retry, no compensating write
      expect(source.match(/pollProvisioningDispatch\(|resolveBlockedRevocation\(/g)).toHaveLength(1);
    }
  });

  it("the poll runner takes the dispatch sequence exactly as given — never trimmed", () => {
    const poll = code(FILES[1]![0]);
    expect(poll).toContain("const rawSeq = process.env.REAL_ADMIN_DISPATCH_SEQ;");
    expect(poll).not.toMatch(/REAL_ADMIN_DISPATCH_SEQ\?\.trim\(\)|rawSeq\.trim\(\)|rawSeq\?\.trim\(\)/);
  });

  it("poll and resolve keep their dry-run default and their one-operation shape", () => {
    const poll = code(FILES[1]![0]);
    expect(poll).toContain("const { commit, dispatchSeq } = requirePollCommitDecision({ env: process.env, runner: RUNNER, target, credentialId, rawSeq });");
    expect(poll).toMatch(/\n      dispatchSeq,\n/); // the poller is handed the sequence the decision validated, nothing re-derived
    expect(poll).not.toMatch(/Number\(rawSeq\)/);
    expect(poll).toContain("if (!commit) expect(report.committed).toBe(false);");
    const resolve = code(FILES[2]![0]);
    expect(resolve).toContain("operation: [appUserId, revocationAttemptId]");
    expect(resolve).toContain('expect(report.committed).toBe(commit && report.outcome === "resolved");');
    expect(resolve).toMatch(/createNeonRevocationResolutionStore\(createNeonSqlClient\(target\.url\)\)/);
  });
});
