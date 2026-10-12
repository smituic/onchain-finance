// @vitest-environment node
import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * Offline, PROCESS-LEVEL proof for the three admin runners: each is run in a
 * real child Vitest process, restricted to its own file, with a sanitized
 * environment and synthetic values only.
 *
 * No child can reach a database or Turnkey: every case here ends in a
 * refusal that is thrown before the runner loads a connector or its server
 * config, the only database host is `.invalid`, and no Turnkey or
 * application credential is ever passed. A fully authorized run is
 * deliberately NOT among the cases.
 */
const A = "test/admin/";
const RUNNERS: Array<{ name: string; file: string; gate: string; commit: string; own: Record<string, string> }> = [
  { name: "backfill", file: `${A}backfill-turnkey-authenticator-ids.admin.test.ts`, gate: "REAL_ADMIN_BACKFILL_TURNKEY_AUTHENTICATOR_IDS", commit: "REAL_ADMIN_BACKFILL_COMMIT", own: {} },
  { name: "poll", file: `${A}poll-provisioning-activity.admin.test.ts`, gate: "REAL_ADMIN_POLL_PROVISIONING_ACTIVITY", commit: "REAL_ADMIN_POLL_COMMIT", own: { REAL_ADMIN_CREDENTIAL_ID: "synthetic-credential", REAL_ADMIN_DISPATCH_SEQ: "1" } },
  { name: "resolve", file: `${A}resolve-passkey-revocation.admin.test.ts`, gate: "REAL_ADMIN_RESOLVE_PASSKEY_REVOCATION", commit: "REAL_ADMIN_RESOLVE_COMMIT", own: { REAL_ADMIN_APP_USER_ID: "synthetic-user", REAL_ADMIN_REVOCATION_ATTEMPT_ID: "synthetic-attempt" } },
];
const ENDPOINT = "ep-synthetic-000009";
const SYNTHETIC_URL = `postgresql://app:synthetic@${ENDPOINT}.c-1.neon.invalid/neondb`;
const PROCESS_TIMEOUT_MS = 120_000;
/** A gate with everything the target check needs — so each case below fails on exactly the one thing it changes. */
const confirmed = (runner: (typeof RUNNERS)[number]) => ({ [runner.gate]: "1", DATABASE_URL: SYNTHETIC_URL, REAL_ADMIN_EXPECTED_ENDPOINT_ID: ENDPOINT, REAL_ADMIN_EXPECTED_DATABASE_NAME: "neondb", ...runner.own });

/** A child Vitest run with ONLY the given variables: every inherited gate, target, and credential is dropped first. */
function runVitest(files: string[], extra: Record<string, string>): Promise<{ code: number; output: string }> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || /^(VITEST|REAL_SMOKE_|REAL_ADMIN_|NEON_|DATABASE_URL$|TURNKEY_|PIMLICO_|REAL_SESSION_|NEXT_PUBLIC_REAL_)/.test(name)) continue;
    env[name] = value;
  }
  return new Promise((resolve) => {
    execFile(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...files], { env: { ...env, ...extra } as NodeJS.ProcessEnv, timeout: PROCESS_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, output: `${stdout}\n${stderr}` });
    });
  });
}

const summary = (output: string) => /Tests\s+([^\n]*)/.exec(output)?.[1] ?? "";
/** What reaching a database, Turnkey, or the server config would print. None may appear. */
const REACHED_SOMETHING = /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|getaddrinfo|NeonDbError|api\.turnkey|Real Mode is|is required|misconfigured|TURNKEY_PARENT/i;

function expectRefused(result: { code: number; output: string }, runner: (typeof RUNNERS)[number], reason: RegExp) {
  expect(result.code, summary(result.output)).not.toBe(0);
  expect(result.output).toMatch(new RegExp(`admin runner [a-z-]+ refused: `));
  expect(result.output).toMatch(reason);
  expect(result.output).toMatch(/Test Files\s+1 failed/);
  expect(summary(result.output)).toMatch(/1 failed/);
  expect(result.output).not.toMatch(REACHED_SOMETHING);
  expect(result.output).not.toContain("synthetic"); // never the URL, its credential, or an operator-supplied identifier
  expect(result.output).not.toContain(".invalid");
  expect(runner.file.startsWith(A)).toBe(true);
}

describe("ordinary execution never activates an admin runner", () => {
  it("DATABASE_URL, both confirmations, every commit flag and confirmation — but no primary gate: all three stay skipped, exit 0", async () => {
    const result = await runVitest(RUNNERS.map((runner) => runner.file), {
      DATABASE_URL: SYNTHETIC_URL,
      REAL_ADMIN_EXPECTED_ENDPOINT_ID: ENDPOINT,
      REAL_ADMIN_EXPECTED_DATABASE_NAME: "neondb",
      REAL_ADMIN_BACKFILL_COMMIT: "1",
      REAL_ADMIN_POLL_COMMIT: "1",
      REAL_ADMIN_RESOLVE_COMMIT: "1",
      REAL_ADMIN_COMMIT_CONFIRMATION: "yes",
    });
    expect(result.code, summary(result.output)).toBe(0);
    expect(summary(result.output)).toMatch(/^3 skipped \(3\)/);
    expect(result.output).not.toMatch(/refused|failed/);
    expect(result.output).not.toMatch(REACHED_SOMETHING);
  }, PROCESS_TIMEOUT_MS);
});

describe.concurrent.each(RUNNERS)("admin runner $name: an armed gate without a complete, isolated confirmation FAILS — before any database or provider call", (runner) => {
  it("the primary gate alone (no target): nonzero, refused", async () => {
    expectRefused(await runVitest([runner.file], { [runner.gate]: "1" }), runner, /DATABASE_URL is not set/);
  }, PROCESS_TIMEOUT_MS);

  it("gate + DATABASE_URL, no endpoint confirmation: nonzero, refused", async () => {
    expectRefused(await runVitest([runner.file], { [runner.gate]: "1", DATABASE_URL: SYNTHETIC_URL, ...runner.own }), runner, /REAL_ADMIN_EXPECTED_ENDPOINT_ID is not set/);
  }, PROCESS_TIMEOUT_MS);

  it("a wrong endpoint confirmation: nonzero, refused", async () => {
    expectRefused(await runVitest([runner.file], { ...confirmed(runner), REAL_ADMIN_EXPECTED_ENDPOINT_ID: "ep-other-000001" }), runner, /endpoint does not match REAL_ADMIN_EXPECTED_ENDPOINT_ID/);
  }, PROCESS_TIMEOUT_MS);

  it("a wrong database-name confirmation: nonzero, refused", async () => {
    expectRefused(await runVitest([runner.file], { ...confirmed(runner), REAL_ADMIN_EXPECTED_DATABASE_NAME: "postgres" }), runner, /database does not match REAL_ADMIN_EXPECTED_DATABASE_NAME/);
  }, PROCESS_TIMEOUT_MS);

  it("conflicting gates — another runner's gate, a smoke gate, a branch variable: each refuses", async () => {
    const other = RUNNERS.find((candidate) => candidate.name !== runner.name)!;
    const results = await Promise.all([
      runVitest([runner.file], { ...confirmed(runner), [other.gate]: "1" }),
      runVitest([runner.file], { ...confirmed(runner), [other.commit]: "1" }),
      runVitest([runner.file], { ...confirmed(runner), REAL_SMOKE_NEON_ADAPTER: "1" }),
      runVitest([runner.file], { ...confirmed(runner), NEON_BRANCH_DATABASE_URL: SYNTHETIC_URL }),
    ]);
    expectRefused(results[0]!, runner, /an admin variable this runner does not use is set/);
    expectRefused(results[1]!, runner, /an admin variable this runner does not use is set/);
    expectRefused(results[2]!, runner, /a smoke gate or smoke variable is set/);
    expectRefused(results[3]!, runner, /a disposable-branch variable is set/);
  }, PROCESS_TIMEOUT_MS);

  it("a non-approved Turnkey host: refused before any provider request", async () => {
    expectRefused(await runVitest([runner.file], { ...confirmed(runner), TURNKEY_API_BASE_URL: "https://api.turnkey.example" }), runner, /TURNKEY_API_BASE_URL overrides the approved Turnkey API host/);
  }, PROCESS_TIMEOUT_MS);

  it("a commit flag that cannot be honored (wrong value, or no matching confirmation): refused, never a silent dry run", async () => {
    const results = await Promise.all([
      runVitest([runner.file], { ...confirmed(runner), [runner.commit]: "true" }),
      ...(runner.name === "backfill"
        ? [runVitest([runner.file], { ...confirmed(runner), REAL_ADMIN_BACKFILL_EXPECTED_COUNT: "1" })]
        : [runVitest([runner.file], { ...confirmed(runner), [runner.commit]: "1" }), runVitest([runner.file], { ...confirmed(runner), [runner.commit]: "1", REAL_ADMIN_COMMIT_CONFIRMATION: "yes" })]),
    ]);
    expectRefused(results[0]!, runner, /must be exactly 1, or unset for a dry run/);
    if (runner.name === "poll") {
      // L-1: a poll commit must name an explicit dispatch sequence; "latest" (no sequence) is refused, whatever the confirmation says.
      const { REAL_ADMIN_DISPATCH_SEQ: _seq, ...withoutSeq } = confirmed(runner);
      void _seq;
      const [noSeq, latestConfirmed, malformed, padded, paddedCommit, leadingZero] = await Promise.all([
        runVitest([runner.file], { ...withoutSeq, [runner.commit]: "1" }),
        runVitest([runner.file], { ...withoutSeq, [runner.commit]: "1", REAL_ADMIN_COMMIT_CONFIRMATION: `poll-provisioning-activity:${ENDPOINT}/neondb:synthetic-credential:latest:quiescent` }),
        runVitest([runner.file], { ...confirmed(runner), REAL_ADMIN_DISPATCH_SEQ: "latest" }),
        // L-B: the sequence is taken exactly as given — padding is refused, never trimmed into "1".
        runVitest([runner.file], { ...confirmed(runner), REAL_ADMIN_DISPATCH_SEQ: " 1 " }),
        runVitest([runner.file], { ...confirmed(runner), REAL_ADMIN_DISPATCH_SEQ: " 1 ", [runner.commit]: "1", REAL_ADMIN_COMMIT_CONFIRMATION: `poll-provisioning-activity:${ENDPOINT}/neondb:synthetic-credential:1:quiescent` }),
        runVitest([runner.file], { ...confirmed(runner), REAL_ADMIN_DISPATCH_SEQ: "01" }),
      ]);
      expectRefused(noSeq!, runner, /REAL_ADMIN_POLL_COMMIT is set without REAL_ADMIN_DISPATCH_SEQ/);
      expectRefused(latestConfirmed!, runner, /"latest" is for dry runs only/);
      expectRefused(malformed!, runner, /REAL_ADMIN_DISPATCH_SEQ is not a positive whole number/);
      expectRefused(padded!, runner, /REAL_ADMIN_DISPATCH_SEQ is not a positive whole number/);
      expectRefused(paddedCommit!, runner, /REAL_ADMIN_DISPATCH_SEQ is not a positive whole number/);
      expectRefused(leadingZero!, runner, /REAL_ADMIN_DISPATCH_SEQ is not a positive whole number/);
      // The plain form "1" (what confirmed() carries) passes the sequence check: those runs above were refused for
      // their commit flag or confirmation, never for the sequence.
      for (const result of results) expect(result.output).not.toMatch(/REAL_ADMIN_DISPATCH_SEQ is not a positive whole number/);
    }
    if (runner.name === "backfill") expectRefused(results[1]!, runner, /a preview count or digest is set without REAL_ADMIN_BACKFILL_COMMIT/);
    else {
      expectRefused(results[1]!, runner, /is set but REAL_ADMIN_COMMIT_CONFIRMATION is not/);
      expectRefused(results[2]!, runner, /REAL_ADMIN_COMMIT_CONFIRMATION does not match this runner, target, and operation/);
    }
  }, PROCESS_TIMEOUT_MS);
});
