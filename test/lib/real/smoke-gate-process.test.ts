// @vitest-environment node
import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * Offline, PROCESS-LEVEL proof (Milestone 0 Pass B, finding L1): each live
 * smoke is run in a real child Vitest process with synthetic values only.
 *   - gate set, target missing        -> the run FAILS (never a silent green skip)
 *   - gate set, confirmation missing  -> the run FAILS
 *   - no gate, DATABASE_URL exported  -> every live test stays skipped
 * Nothing here can connect: the only URLs are `.invalid` hosts, and every
 * failing case is refused before a connector is built. A child reads the
 * repository's own env files only as the target check does — to compare the
 * real endpoint — and prints none of it.
 */
const R = "test/lib/real/";
const SUITES: Array<[string, string]> = [
  [`${R}neon-smoke.test.ts`, "REAL_SMOKE_NEON_ADAPTER"],
  [`${R}l2-identity-migration.smoke.test.ts`, "REAL_SMOKE_L2_MIGRATION"],
  [`${R}provisioning-dispatch-migration.smoke.test.ts`, "REAL_SMOKE_PROVISIONING_MIGRATION"],
  [`${R}l2-identity-race.smoke.test.ts`, "REAL_SMOKE_L2_RACE"],
  [`${R}handles-migration.smoke.test.ts`, "REAL_SMOKE_HANDLES_MIGRATION"],
  [`${R}handles-runtime.smoke.test.ts`, "REAL_SMOKE_HANDLES_RUNTIME"],
  [`${R}payment-recipient-identity-migration.smoke.test.ts`, "REAL_SMOKE_PAYMENT_RECIPIENT_MIGRATION"],
  [`${R}handle-pay-reserve.smoke.test.ts`, "REAL_SMOKE_HANDLE_PAY_RESERVE"],
  [`${R}rate-limit.smoke.test.ts`, "REAL_SMOKE_RATE_LIMIT"],
  [`${R}provisioning-limits.smoke.test.ts`, "REAL_SMOKE_PROVISIONING_LIMITS"],
  [`${R}provider-budget.smoke.test.ts`, "REAL_SMOKE_PROVIDER_BUDGET"],
];
/** The five suites finding L1 was about (they used to skip when their gate was set without a branch URL), and every disposable-branch suite added since. */
const L1_SUITES = SUITES.slice(4);
const SYNTHETIC_URL = "postgresql://app:synthetic@ep-synthetic-000009.c-1.neon.invalid/neondb";
const PROCESS_TIMEOUT_MS = 120_000;

/** A child Vitest run with ONLY the given smoke/database variables: every inherited gate, target, and credential is dropped first. */
function runVitest(files: string[], extra: Record<string, string>): Promise<{ code: number; output: string }> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || /^(VITEST|REAL_SMOKE_|REAL_ADMIN_|NEON_|DATABASE_URL$|TURNKEY_|PIMLICO_|HANDLES_SMOKE_|PAYMENT_RECIPIENT_SMOKE_)/.test(name)) continue;
    env[name] = value;
  }
  return new Promise((resolve) => {
    execFile(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...files], { env: { ...env, ...extra } as NodeJS.ProcessEnv, timeout: PROCESS_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, output: `${stdout}\n${stderr}` });
    });
  });
}

const REFUSAL = /refused to connect: |refused before any database work: /;
/** What a real connection attempt to a synthetic host would print. None may appear. */
const CONNECTION_ATTEMPT = /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|getaddrinfo|NeonDbError|WebSocket/i;
const summary = (output: string) => /Tests\s+([^\n]*)/.exec(output)?.[1] ?? "";
/** A refusal in a block's first hook fails the FILE (its tests are then reported as skipped); a refusal inside a test fails that test. Either way the file fails. */
const FILE_FAILED = /Test Files\s+1 failed/;

describe.concurrent("a set gate without a valid target FAILS the run — no silent skip, no connection", () => {
  it.each(SUITES)("%s: gate set, no target URL at all -> nonzero exit, refused", async (file, gate) => {
    const { code, output } = await runVitest([file], { [gate]: "1" });
    expect(code, summary(output)).not.toBe(0);
    expect(output).toMatch(REFUSAL);
    expect(output).toMatch(/(NEON_BRANCH_DATABASE_URL is missing or not a URL|REAL_SMOKE_L2_DIRECT_DATABASE_URL is not set)/);
    expect(output).toMatch(FILE_FAILED);
    expect(output).not.toMatch(/Test Files\s+\d+ passed/);
    expect(output).not.toMatch(CONNECTION_ATTEMPT);
    expect(output).not.toContain("synthetic");
  }, PROCESS_TIMEOUT_MS);

  it.each(L1_SUITES)("%s: gate + a branch URL, no operator confirmation -> nonzero exit, refused before any connection", async (file, gate) => {
    const { code, output } = await runVitest([file], { [gate]: "1", NEON_BRANCH_DATABASE_URL: SYNTHETIC_URL });
    expect(code, summary(output)).not.toBe(0);
    expect(output).toMatch(REFUSAL);
    expect(output).toMatch(FILE_FAILED);
    expect(output).not.toMatch(/Test Files\s+\d+ passed/);
    expect(output).not.toMatch(CONNECTION_ATTEMPT);
    // Never the URL or its credential, whatever the refusal was.
    expect(output).not.toContain("synthetic");
  }, PROCESS_TIMEOUT_MS);
});

describe("without a gate nothing live runs, whatever else is exported", () => {
  it("DATABASE_URL, a branch URL, an expected endpoint id and a direct URL — but no gate: every live test is skipped, exit 0", async () => {
    const { code, output } = await runVitest(
      SUITES.map(([file]) => file),
      { DATABASE_URL: SYNTHETIC_URL, NEON_BRANCH_DATABASE_URL: SYNTHETIC_URL, NEON_BRANCH_EXPECTED_ENDPOINT_ID: "ep-synthetic-000009", REAL_SMOKE_L2_DIRECT_DATABASE_URL: SYNTHETIC_URL },
    );
    expect(code, summary(output)).toBe(0);
    expect(summary(output)).toMatch(/passed/);
    expect(summary(output)).toMatch(/\d+ skipped/);
    expect(summary(output)).not.toMatch(/failed/);
    expect(output).not.toMatch(REFUSAL);
    expect(output).not.toMatch(CONNECTION_ATTEMPT);
  }, PROCESS_TIMEOUT_MS);
});
