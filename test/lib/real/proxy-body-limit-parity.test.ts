import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REAL_API_MAX_BODY_BYTES } from "@/lib/real/server/request-gate";

/**
 * Milestone 3B-2: the proxy body-copy limit Next.js applies and the declared-
 * length ceiling the request gate enforces must be the same number. Next.js
 * copies a proxied request body only up to `experimental.proxyClientMaxBodySize`
 * and then keeps just the prefix; the gate's job is to make sure no request
 * larger than that ever reaches a route. This file loads the configuration the
 * way Next.js itself does, in a separate offline Node process (no server, no
 * network, no provider), and compares.
 */

const root = path.resolve(__dirname, "../../..");

/** Runs Next's own config loader for each phase and prints the normalized limit. Nothing else is touched. */
const LOADER = `
const { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } = require("next/constants");
const loadConfig = require("next/dist/server/config").default;
const { defaultConfig } = require("next/dist/server/config-shared");
(async () => {
  const out = { defaultLimit: defaultConfig.experimental.proxyClientMaxBodySize, phases: {} };
  for (const phase of [PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER]) {
    const config = await loadConfig(phase, process.cwd());
    out.phases[phase] = { limit: config.experimental.proxyClientMaxBodySize, type: typeof config.experimental.proxyClientMaxBodySize };
  }
  process.stdout.write("RESULT:" + JSON.stringify(out));
})().catch((error) => { process.stderr.write(String(error && error.stack || error)); process.exit(1); });
`;

function loadNextConfigLimits(): { defaultLimit: number; phases: Record<string, { limit: number; type: string }> } {
  const stdout = execFileSync(process.execPath, ["-e", LOADER], { cwd: root, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  const line = stdout.split("\n").find((entry) => entry.startsWith("RESULT:"));
  if (!line) throw new Error("the Next.js config loader printed no result");
  return JSON.parse(line.slice("RESULT:".length));
}

describe("proxy body-copy limit parity (loaded by Next.js's own config loader)", () => {
  const loaded = loadNextConfigLimits();

  it("Next.js accepts next.config.ts and normalizes the limit to the gate's constant in every phase", () => {
    expect(Object.keys(loaded.phases)).toHaveLength(3);
    for (const [phase, result] of Object.entries(loaded.phases)) {
      expect(result, phase).toEqual({ limit: REAL_API_MAX_BODY_BYTES, type: "number" });
    }
  });

  it("the explicit value equals the framework's own default, so the copy limit was not lowered or raised", () => {
    expect(loaded.defaultLimit).toBe(10_485_760);
    expect(REAL_API_MAX_BODY_BYTES).toBe(loaded.defaultLimit);
  });

  it("the framework limit is not below the gate ceiling", () => {
    for (const result of Object.values(loaded.phases)) expect(result.limit).toBeGreaterThanOrEqual(REAL_API_MAX_BODY_BYTES);
  });
});

describe("next.config.ts takes the limit from the gate's constant", () => {
  const source = readFileSync(path.join(root, "next.config.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("imports the constant from the request gate and uses it as the only value", () => {
    expect(source).toContain('import { REAL_API_MAX_BODY_BYTES } from "./lib/real/server/request-gate";');
    expect(source).toMatch(/proxyClientMaxBodySize:\s*REAL_API_MAX_BODY_BYTES,/);
  });

  it("contains no independently maintained size literal", () => {
    expect(source).not.toMatch(/10485760|10_485_760|10 \* 1024|1024 \* 1024|"10mb"|'10mb'|"10 MB"/i);
    expect(source.match(/proxyClientMaxBodySize/g)).toHaveLength(1);
  });

  it("does not also set the deprecated middlewareClientMaxBodySize (Next.js refuses both)", () => {
    expect(source).not.toContain("middlewareClientMaxBodySize");
  });
});
