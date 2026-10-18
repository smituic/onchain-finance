import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BRANCH_URL_ENV,
  EXPECTED_ENDPOINT_ENV,
  OTHER_NEXT_ENV_FILES,
  checkConfirmedDirectTarget,
  checkConfirmedDisposableTarget,
  checkDisposableTarget,
  confirmedDisposableTargetUrl,
  resolveConfirmedDirectTarget,
  type TargetCheck,
} from "./fixtures/handles-smoke-db";
import { DIRECT_DATABASE_URL_ENV, RACE_GATE } from "./fixtures/race-harness";

/**
 * Offline (never gated). Milestone 0 Pass B: the ONE target check behind
 * every live database smoke, and the static shape of the suites that use it.
 * Synthetic `.invalid` hosts and a mocked connector only — nothing here
 * reads a real env file or connects.
 *
 * The check proves that the URL about to be used is the endpoint the
 * operator named and is not the configured real one. It does not, and
 * cannot, prove that a branch is disposable.
 */
const GATE = "REAL_SMOKE_EXAMPLE";
const REAL_ID = "ep-real-000001";
const BRANCH_ID = "ep-smoke-branch-000002";
const hostOf = (id: string) => `${id}.c-1.us-east-2.aws.neon.invalid`;
const urlOf = (host: string, tail = "/neondb?sslmode=require&channel_binding=require", userinfo = "app:secret") => `postgresql://${userinfo}@${host}${tail}`;
const branch = urlOf(hostOf(BRANCH_ID));
const realLine = (host = hostOf(`${REAL_ID}-pooler`)) => `DATABASE_URL="${urlOf(host)}"\n`;

type Env = Record<string, string | undefined>;
const env = (extra: Env = {}): Env => ({ [GATE]: "1", [BRANCH_URL_ENV]: branch, [EXPECTED_ENDPOINT_ENV]: BRANCH_ID, ...extra });
const input = (e: Env, envLocalText: string | null = realLine(), otherEnvFiles: Record<string, string> = {}) => ({ env: e, envLocalText, otherEnvFiles, gate: GATE, allowedGates: [GATE] });
const directEnv = (extra: Env = {}): Env => ({ [RACE_GATE]: "1", [DIRECT_DATABASE_URL_ENV]: branch, [EXPECTED_ENDPOINT_ENV]: BRANCH_ID, ...extra });
const directInput = (e: Env, envLocalText: string | null = realLine()) => ({ env: e, envLocalText, otherEnvFiles: {}, gate: RACE_GATE, allowedGates: [RACE_GATE], urlEnv: DIRECT_DATABASE_URL_ENV });

// ------------------------------------------------------------------ the installed Next.js env loader, on synthetic files only

const nextEnv = createRequire(createRequire(import.meta.url).resolve("next/package.json"))("@next/env") as {
  loadEnvConfig: (dir: string, dev?: boolean, log?: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void }, forceReload?: boolean) => { parsedEnv?: Record<string, string | undefined> };
  resetEnv: () => void;
};
const SYNTHETIC_ENDPOINT = /ep-[a-z]+-\d{6}/g;

/**
 * Every synthetic endpoint id in the DATABASE_URL that Next.js PARSES from the given env files (written to a temp
 * directory; its file-only result, after variable expansion, independent of the process environment). Vitest runs
 * with NODE_ENV=test, where Next.js loads `.env.test.local`, `.env.test`, and `.env` — so those are the names to use.
 * The loader's own reset undoes what it put in the environment, and this asserts nothing synthetic is left behind;
 * the variable is never read from the environment here.
 */
function nextEndpoints(files: Record<string, string>): string[] {
  const dir = mkdtempSync(path.join(tmpdir(), "smoke-target-next-"));
  const before = Object.keys(process.env).sort();
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
    const value = nextEnv.loadEnvConfig(dir, false, { info: () => undefined, error: () => undefined }, true).parsedEnv?.DATABASE_URL;
    return [...new Set(value?.match(SYNTHETIC_ENDPOINT) ?? [])];
  } finally {
    nextEnv.resetEnv();
    rmSync(dir, { recursive: true, force: true });
    expect(Object.keys(process.env).sort()).toEqual(before); // no synthetic variable leaks into this process
  }
}
/** The single endpoint Next.js would use for a `.env` holding `text`, or a description of the oddity. */
function effectiveEndpoint(text: string): string {
  const ids = nextEndpoints({ ".env": text });
  return ids.length === 1 ? ids[0]! : ids.length === 0 ? "<none>" : `<${ids.length} endpoints in one value>`;
}

function expectRefused(result: TargetCheck, reason: RegExp) {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toMatch(reason);
    // Never a URL, a credential, or a synthetic endpoint id.
    expect(result.reason).not.toMatch(/secret|postgres(ql)?:\/\/\S|neon\.invalid|00000\d|ep-real|ep-smoke/);
  }
}

describe("confirmed target check: what is accepted", () => {
  it("the gate + a branch URL + the operator's matching endpoint id — pooled or direct, with only harmless parameters", () => {
    expect(checkConfirmedDisposableTarget(input(env()))).toEqual({ ok: true });
    expect(checkConfirmedDisposableTarget(input(env({ [BRANCH_URL_ENV]: urlOf(hostOf(`${BRANCH_ID}-pooler`)) })))).toEqual({ ok: true });
    for (const tail of ["/neondb", "/neondb?sslmode=require", "/neondb?connect_timeout=10&sslmode=require"]) {
      expect(checkConfirmedDisposableTarget(input(env({ [BRANCH_URL_ENV]: urlOf(hostOf(BRANCH_ID), tail) }))), tail).toEqual({ ok: true });
    }
    expect(checkConfirmedDisposableTarget(input(env({ [BRANCH_URL_ENV]: urlOf(`${hostOf(BRANCH_ID)}:5432`) })))).toEqual({ ok: true });
    expect(checkConfirmedDisposableTarget(input(env({ [BRANCH_URL_ENV]: `"${branch}"` })))).toEqual({ ok: true }); // a quoted env value, as before
  });

  it("the real URL may be written in any accepted dotenv form, in any letter case — it is normalized, never trusted as typed", () => {
    for (const text of [
      realLine(),
      `DATABASE_URL=${urlOf(hostOf(`${REAL_ID}-pooler`))}\n`,
      `DATABASE_URL='${urlOf(hostOf(REAL_ID))}'\n`,
      `export DATABASE_URL="${urlOf(hostOf(REAL_ID))}"\n`,
      `  DATABASE_URL = "${urlOf(hostOf(REAL_ID))}"\r\n`,
      `# DATABASE_URL="${urlOf(hostOf("ep-old-000009"))}"\n${realLine()}OTHER=1\n`,
      realLine(hostOf(`${REAL_ID}-pooler`).toUpperCase()),
    ]) {
      expect(checkConfirmedDisposableTarget(input(env(), text)), JSON.stringify(text.slice(0, 24))).toEqual({ ok: true });
    }
  });

  it("another env file may repeat the SAME real endpoint (pooled or direct form)", () => {
    expect(checkConfirmedDisposableTarget(input(env(), realLine(), { ".env.production.local": realLine(hostOf(REAL_ID)), ".env": "OTHER=1\n" }))).toEqual({ ok: true });
  });
});

describe("confirmed target check: activation", () => {
  it.each<[string, Env]>([
    ["nothing is set", {}],
    ["DATABASE_URL alone", { DATABASE_URL: branch }],
    ["the branch URL alone", { [BRANCH_URL_ENV]: branch }],
    ["the branch URL and expected id, no gate", env({ [GATE]: undefined })],
    ["the gate set to something other than 1", env({ [GATE]: "true" })],
    ["REAL_SMOKE_L2_INDEXES alone", { REAL_SMOKE_L2_INDEXES: "1", [BRANCH_URL_ENV]: branch, [EXPECTED_ENDPOINT_ENV]: BRANCH_ID }],
  ])("no explicit gate — %s", (_name, e) => expectRefused(checkConfirmedDisposableTarget(input(e)), /REAL_SMOKE_EXAMPLE is not set/));

  it.each<[string, Env, RegExp]>([
    ["the gate with only DATABASE_URL — no fallback", { [GATE]: "1", [EXPECTED_ENDPOINT_ENV]: BRANCH_ID, DATABASE_URL: branch }, /DATABASE_URL is exported/],
    ["DATABASE_URL exported beside a valid branch", env({ DATABASE_URL: branch }), /DATABASE_URL is exported/],
    ["DATABASE_URL exported but empty", env({ DATABASE_URL: "" }), /DATABASE_URL is exported/],
    ["the gate with no target", { [GATE]: "1", [EXPECTED_ENDPOINT_ENV]: BRANCH_ID }, /NEON_BRANCH_DATABASE_URL is missing or not a URL/],
    ["an unrelated smoke gate", env({ REAL_SMOKE_NEON_ADAPTER: "1" }), /an unrelated smoke gate is set/],
    ["REAL_SMOKE_L2_INDEXES beside the gate", env({ REAL_SMOKE_L2_INDEXES: "1" }), /an unrelated smoke gate is set/],
    ["the race suite's gate", env({ [RACE_GATE]: "1" }), /an unrelated smoke gate is set/],
    ["the race suite's direct URL variable", env({ [DIRECT_DATABASE_URL_ENV]: branch }), /an unrelated smoke gate is set/],
    ["an admin gate", env({ REAL_ADMIN_POLL_PROVISIONING_ACTIVITY: "1" }), /an admin gate is set/],
    ["an admin commit flag", env({ REAL_ADMIN_POLL_COMMIT: "1" }), /an admin gate is set/],
  ])("%s", (_name, e, reason) => expectRefused(checkConfirmedDisposableTarget(input(e)), reason));
});

describe("confirmed target check: endpoint identity", () => {
  it.each<[string, Env, RegExp]>([
    ["missing expected endpoint", env({ [EXPECTED_ENDPOINT_ENV]: undefined }), /NEON_BRANCH_EXPECTED_ENDPOINT_ID is not set/],
    ["empty expected endpoint", env({ [EXPECTED_ENDPOINT_ENV]: "" }), /NEON_BRANCH_EXPECTED_ENDPOINT_ID is not set/],
    ["wrong endpoint", env({ [EXPECTED_ENDPOINT_ENV]: "ep-other-000003" }), /does not match/],
    ["a prefix of the endpoint", env({ [EXPECTED_ENDPOINT_ENV]: "ep-smoke-branch" }), /does not match/],
    ["the expected id in upper case", env({ [EXPECTED_ENDPOINT_ENV]: BRANCH_ID.toUpperCase() }), /not a bare endpoint id/],
    ["the expected id in its pooled form", env({ [EXPECTED_ENDPOINT_ENV]: `${BRANCH_ID}-pooler` }), /not a bare endpoint id/],
    ["the expected id as a hostname", env({ [EXPECTED_ENDPOINT_ENV]: hostOf(BRANCH_ID) }), /not a bare endpoint id/],
    ["the expected id padded", env({ [EXPECTED_ENDPOINT_ENV]: `${BRANCH_ID} ` }), /not a bare endpoint id/],
    ["the real endpoint, pooled, confirmed as itself", env({ [BRANCH_URL_ENV]: urlOf(hostOf(`${REAL_ID}-pooler`)), [EXPECTED_ENDPOINT_ENV]: REAL_ID }), /equals the real database's/],
    ["the real endpoint, direct, confirmed as itself", env({ [BRANCH_URL_ENV]: urlOf(hostOf(REAL_ID)), [EXPECTED_ENDPOINT_ENV]: REAL_ID }), /equals the real database's/],
    ["the real endpoint in another region's hostname", env({ [BRANCH_URL_ENV]: urlOf(`${REAL_ID}.c-9.eu-west-1.aws.neon.invalid`), [EXPECTED_ENDPOINT_ENV]: REAL_ID }), /equals the real database's/],
    ["the expected id naming the real endpoint", env({ [EXPECTED_ENDPOINT_ENV]: REAL_ID }), /names the real database's endpoint/],
  ])("%s", (_name, e, reason) => expectRefused(checkConfirmedDisposableTarget(input(e)), reason));

  it("pooled and direct forms are ONE endpoint: the real endpoint is refused whichever form each side uses", () => {
    for (const realHost of [hostOf(REAL_ID), hostOf(`${REAL_ID}-pooler`)]) {
      for (const targetHost of [hostOf(REAL_ID), hostOf(`${REAL_ID}-pooler`)]) {
        expectRefused(checkConfirmedDisposableTarget(input(env({ [BRANCH_URL_ENV]: urlOf(targetHost), [EXPECTED_ENDPOINT_ENV]: REAL_ID }), realLine(realHost))), /equals the real database's/);
      }
    }
  });
});

describe("confirmed target check: hostname case cannot bypass the refusal", () => {
  const variants = [hostOf(REAL_ID).toUpperCase(), hostOf(`${REAL_ID}-pooler`).toUpperCase(), hostOf(REAL_ID).replace("ep-real", "Ep-Real"), hostOf(`${REAL_ID}-POOLER`), hostOf(REAL_ID).replace("neon", "NEON")];

  it.each(variants)("a mixed-case TARGET hostname is refused outright: %s", (host) => {
    expect(new URL(urlOf(host)).hostname).toBe(host); // the reason this needs handling: postgres:// hostnames are not lower-cased by URL
    for (const expected of [REAL_ID, BRANCH_ID]) expectRefused(checkConfirmedDisposableTarget(input(env({ [BRANCH_URL_ENV]: urlOf(host), [EXPECTED_ENDPOINT_ENV]: expected }))), /mixed-case hostname/);
    expectRefused(checkDisposableTarget(input(env({ [BRANCH_URL_ENV]: urlOf(host) }))), /mixed-case hostname/);
  });

  it.each(variants)("a mixed-case REAL hostname still matches the lower-case target: %s", (host) => {
    for (const targetHost of [hostOf(REAL_ID), hostOf(`${REAL_ID}-pooler`)]) {
      expectRefused(checkConfirmedDisposableTarget(input(env({ [BRANCH_URL_ENV]: urlOf(targetHost), [EXPECTED_ENDPOINT_ENV]: REAL_ID }), realLine(host))), /equals the real database's/);
      expectRefused(checkDisposableTarget(input(env({ [BRANCH_URL_ENV]: urlOf(targetHost) }), realLine(host))), /equals the real database's/);
    }
  });

  it("a mixed-case branch hostname is refused even when it is NOT the real endpoint", () => {
    expectRefused(checkConfirmedDisposableTarget(input(env({ [BRANCH_URL_ENV]: urlOf(hostOf(BRANCH_ID).toUpperCase()) }))), /mixed-case hostname/);
  });
});

describe("confirmed target check: the real endpoint must be unambiguous", () => {
  const other = `DATABASE_URL="${urlOf(hostOf("ep-other-000009"))}"\n`;
  it.each<[string, string | null, RegExp]>([
    [".env.local unreadable", null, /\.env\.local is not readable/],
    ["no definition", "OTHER=1\n", /names no DATABASE_URL/],
    ["only a commented definition", `# ${realLine()}`, /names no DATABASE_URL/],
    ["two different definitions", realLine() + other, /more than once/],
    ["two different definitions, the real one last", other + realLine(), /more than once/],
    ["the same definition twice", realLine() + realLine(), /more than once/],
    ["one plain and one export definition", `${realLine()}export ${other}`, /more than once/],
    ["one plain and one indented definition", `${realLine()}   ${other}`, /more than once/],
    ["an empty definition", "DATABASE_URL=\n", /is not a URL/],
    ["free text", "DATABASE_URL=not a url\n", /is not a URL/],
    ["an unbalanced quote", `DATABASE_URL="${urlOf(hostOf(REAL_ID))}\n`, /is not a URL/],
    ["a value with a trailing inline comment", `DATABASE_URL=${urlOf(hostOf(REAL_ID))} # prod\n`, /is not a URL/],
    ["a variable reference", "DATABASE_URL=$OTHER_DATABASE_URL\n", /contains "\$" \(variable expansion\)/],
    ["a non-postgres scheme", `DATABASE_URL="https://${hostOf(REAL_ID)}/neondb"\n`, /is not a postgres:\/\/ URL/],
    ["a routing override in the real URL", `DATABASE_URL="${urlOf(hostOf(REAL_ID), "/neondb?options=endpoint%3Dep-elsewhere-000008")}"\n`, /unsupported or repeated connection parameter/],
    ["two @ in the real URL", `DATABASE_URL="postgresql://app:se@cret@${hostOf(REAL_ID)}/neondb"\n`, /exactly one "@"/],
  ])("%s", (_name, text, reason) => {
    expectRefused(checkConfirmedDisposableTarget(input(env(), text)), reason);
    expectRefused(checkDisposableTarget(input(env(), text)), reason);
  });

  // The colon form dotenv also accepts (`DATABASE_URL: value`). A parser that saw only `=` would compare against a stale value.
  const colon = (host: string, prefix = "") => `${prefix}DATABASE_URL: "${urlOf(host)}"\n`;
  it("a single colon-form definition IS the real endpoint: it is found, and it is refused as a target", () => {
    for (const text of [colon(hostOf(REAL_ID)), colon(hostOf(`${REAL_ID}-pooler`), "export "), `  DATABASE_URL : ${urlOf(hostOf(REAL_ID))}\n`, `DATABASE_URL:${urlOf(hostOf(REAL_ID))}\n`]) {
      expect(checkConfirmedDisposableTarget(input(env(), text)), JSON.stringify(text.slice(0, 20))).toEqual({ ok: true });
      expectRefused(checkConfirmedDisposableTarget(input(env({ [BRANCH_URL_ENV]: urlOf(hostOf(REAL_ID)), [EXPECTED_ENDPOINT_ENV]: REAL_ID }), text)), /equals the real database's/);
    }
  });

  it.each<[string, string, RegExp]>([
    ["A: one equals-form and one colon-form definition", realLine() + colon(hostOf("ep-other-000009")), /more than once/],
    ["B: two colon-form definitions", colon(hostOf(REAL_ID)) + colon(hostOf("ep-other-000009")), /more than once/],
    ["B: the same colon-form definition twice", colon(hostOf(REAL_ID)) + colon(hostOf(REAL_ID)), /more than once/],
    ["C: a stale equals-form value, then the effective colon-form real value", `DATABASE_URL="${urlOf(hostOf("ep-stale-000007"))}"\n${colon(hostOf(REAL_ID))}`, /more than once/],
    ["D: the effective colon-form real value, then a stale equals-form value", `${colon(hostOf(REAL_ID))}DATABASE_URL="${urlOf(hostOf("ep-stale-000007"))}"\n`, /more than once/],
    ["an export colon-form beside an equals-form", realLine() + colon(hostOf("ep-other-000009"), "export "), /more than once/],
    ["an indented colon-form beside an equals-form", realLine() + colon(hostOf("ep-other-000009"), "   "), /more than once/],
    ["a colon-form with no space beside an equals-form", `${realLine()}DATABASE_URL:${urlOf(hostOf("ep-other-000009"))}\n`, /more than once/],
    ["a malformed colon-form value", "DATABASE_URL: not a url\n", /is not a URL/],
    ["an empty colon-form value", "DATABASE_URL:\n", /is not a URL/],
    ["an unbalanced quote in a colon-form value", `DATABASE_URL: "${urlOf(hostOf(REAL_ID))}\n`, /is not a URL/],
  ])("colon-form definitions — %s", (_name, text, reason) => {
    // In cases C and D the target IS the effective real endpoint: it must never be accepted on the strength of the stale line.
    for (const target of [branch, urlOf(hostOf(REAL_ID)), urlOf(hostOf("ep-stale-000007"))]) {
      const expected = new URL(target).hostname.split(".")[0]!;
      expectRefused(checkConfirmedDisposableTarget(input(env({ [BRANCH_URL_ENV]: target, [EXPECTED_ENDPOINT_ENV]: expected }), text)), reason);
      expectRefused(checkDisposableTarget(input(env({ [BRANCH_URL_ENV]: target }), text)), reason);
    }
  });

  it("E: commented colon-form definitions are ignored — they neither count as a duplicate nor stand in for a missing one", () => {
    const commented = `# ${colon(hostOf("ep-old-000009"))}  # ${colon(hostOf("ep-older-000008"), "export ")}#DATABASE_URL: x\n`;
    expect(checkConfirmedDisposableTarget(input(env(), commented + realLine()))).toEqual({ ok: true });
    expect(checkConfirmedDisposableTarget(input(env(), commented + colon(hostOf(REAL_ID))))).toEqual({ ok: true });
    expectRefused(checkConfirmedDisposableTarget(input(env(), commented)), /names no DATABASE_URL/);
  });

  it.each<[string, Record<string, string>, RegExp]>([
    ["F: a colon-form definition for a different endpoint in .env", { ".env": colon(hostOf("ep-other-000009")) }, /different endpoints/],
    ["F: an export colon-form for a different endpoint in .env.production.local", { ".env.production.local": colon(hostOf("ep-other-000009"), "export ") }, /different endpoints/],
    ["F: equals-form plus colon-form in another file", { ".env.development": realLine() + colon(hostOf(REAL_ID)) }, /\.env\.development defines DATABASE_URL more than once/],
    ["F: a malformed colon-form in another file", { ".env.test": "DATABASE_URL: not a url\n" }, /cannot be read unambiguously/],
  ])("colon-form definitions in other active env files — %s", (_name, files, reason) => {
    expectRefused(checkConfirmedDisposableTarget(input(env(), realLine(), files)), reason);
    expectRefused(checkConfirmedDisposableTarget(input(env(), colon(hostOf(REAL_ID)), files)), reason);
  });

  it("F: another active env file may repeat the same endpoint in colon form", () => {
    expect(checkConfirmedDisposableTarget(input(env(), realLine(), { ".env": colon(hostOf(REAL_ID)) }))).toEqual({ ok: true });
  });

  it.each<[string, Record<string, string>, RegExp]>([
    ["a different endpoint in .env", { ".env": other }, /\.env and \.env\.local define DATABASE_URL for different endpoints/],
    ["a different endpoint in .env.production.local", { ".env.production.local": other }, /different endpoints/],
    ["a different endpoint in .env.development", { ".env.development": `export ${other}` }, /different endpoints/],
    ["two definitions in another file", { ".env.production": realLine() + realLine() }, /\.env\.production defines DATABASE_URL more than once/],
    ["an unreadable definition in another file", { ".env.test.local": "DATABASE_URL=not a url\n" }, /cannot be read unambiguously/],
    ["a routing override in another file", { ".env": `DATABASE_URL="${urlOf(hostOf(REAL_ID), "/neondb?host=elsewhere.invalid")}"\n` }, /cannot be read unambiguously/],
  ])("conflicting environment files — %s", (_name, files, reason) => {
    expectRefused(checkConfirmedDisposableTarget(input(env(), realLine(), files)), reason);
  });

  it("covers every env file Next.js loads besides .env.local, and never .env.example", () => {
    expect([...OTHER_NEXT_ENV_FILES].sort()).toEqual([".env", ".env.development", ".env.development.local", ".env.production", ".env.production.local", ".env.test", ".env.test.local"]);
    for (const file of OTHER_NEXT_ENV_FILES) expectRefused(checkConfirmedDisposableTarget(input(env(), realLine(), { [file]: other })), /different endpoints/);
    const fixture = codeOf("test/lib/real/fixtures/handles-smoke-db.ts");
    expect(fixture.match(/readFileSync\(([^,)]*)/g)).toEqual(["readFileSync(file", 'readFileSync(".env.local"']);
    expect(fixture).not.toContain(".env.example");
  });
});

// N1: dotenv (as Next.js bundles it) breaks lines on a bare CR and lets a definition start after U+2028 / U+2029.
// A reading that only knows LF / CRLF can therefore miss the EFFECTIVE definition; such a file is refused outright.
describe("confirmed target check: unusual line terminators cannot hide a DATABASE_URL definition", () => {
  const STALE_ID = "ep-stale-000007";
  const def = (id: string, form: "=" | ":" = "=") => (form === "=" ? `DATABASE_URL="${urlOf(hostOf(id))}"` : `DATABASE_URL: "${urlOf(hostOf(id))}"`);
  const SEPARATORS: Array<[string, string]> = [
    ["a standalone CR", "\r"],
    ["U+2028", "\u2028"],
    ["U+2029", "\u2029"],
  ];
  const TERMINATOR = /line terminator other than LF or CRLF/;
  /** Every way the checker could be asked about this text: the branch, and the two endpoints the text mentions, each confirmed as itself. */
  const refusedForEveryTarget = (text: string, reason: RegExp, otherEnvFiles: Record<string, string> = {}, envLocalText = text) => {
    for (const id of [BRANCH_ID, REAL_ID, STALE_ID]) {
      const e = env({ [BRANCH_URL_ENV]: urlOf(hostOf(id)), [EXPECTED_ENDPOINT_ENV]: id });
      expectRefused(checkConfirmedDisposableTarget(input(e, envLocalText, otherEnvFiles)), reason);
      expectRefused(checkDisposableTarget(input(e, envLocalText, otherEnvFiles)), reason);
      expectRefused(checkConfirmedDirectTarget({ ...directInput(directEnv({ [DIRECT_DATABASE_URL_ENV]: urlOf(hostOf(id)), [EXPECTED_ENDPOINT_ENV]: id }), envLocalText), otherEnvFiles }), reason);
    }
  };

  it("A: a single LF-terminated definition is accepted — with or without the final newline, among other LF lines", () => {
    for (const text of [`${def(REAL_ID)}\n`, def(REAL_ID), `# header\n\nOTHER=1\n${def(REAL_ID)}\nLAST=2\n`, `${def(REAL_ID, ":")}\n`]) {
      expect(checkConfirmedDisposableTarget(input(env(), text)), JSON.stringify(text.slice(0, 12))).toEqual({ ok: true });
    }
  });

  it("B: a single CRLF-terminated definition is accepted, and the CR is not part of its value", () => {
    for (const text of [`${def(REAL_ID)}\r\n`, `# header\r\n\r\nOTHER=1\r\n${def(REAL_ID)}\r\nLAST=2\r\n`, `OTHER=1\r\n${def(REAL_ID, ":")}`, `export ${def(REAL_ID)}\r\n`]) {
      expect(checkConfirmedDisposableTarget(input(env(), text)), JSON.stringify(text.slice(0, 12))).toEqual({ ok: true });
      // ...and it is still recognized as the real endpoint.
      expectRefused(checkConfirmedDisposableTarget(input(env({ [BRANCH_URL_ENV]: urlOf(hostOf(REAL_ID)), [EXPECTED_ENDPOINT_ENV]: REAL_ID }), text)), /equals the real database's/);
    }
  });

  it("C: two definitions separated by CRLF are still a duplicate (either form, either order)", () => {
    for (const text of [`${def(STALE_ID)}\r\n${def(REAL_ID)}\r\n`, `${def(REAL_ID)}\r\n${def(STALE_ID)}`, `${def(STALE_ID)}\r\n${def(REAL_ID, ":")}\r\n`, `${def(REAL_ID, ":")}\r\n${def(REAL_ID, ":")}\r\n`]) {
      refusedForEveryTarget(text, /more than once/);
    }
  });

  it.each(SEPARATORS)("D/E/F: %s between a stale and the real definition is refused (either order, either form, with or without LF around it)", (_name, separator) => {
    for (const text of [
      `${def(STALE_ID)}${separator}${def(REAL_ID)}\n`,
      `${def(REAL_ID)}${separator}${def(STALE_ID)}\n`,
      `${def(STALE_ID)}${separator}${def(REAL_ID, ":")}`,
      `${def(STALE_ID, ":")}${separator}${def(REAL_ID)}\n`,
      `${def(STALE_ID)}\n${separator}${def(REAL_ID)}\n`,
      `OTHER=1\n${def(STALE_ID)}${separator}export ${def(REAL_ID)}\r\n`,
    ]) {
      refusedForEveryTarget(text, TERMINATOR);
    }
  });

  it.each(SEPARATORS)("G: %s after a commented line cannot hide a later active definition", (_name, separator) => {
    for (const text of [
      `${def(STALE_ID)}\n# rotated${separator}${def(REAL_ID)}\n`,
      `# ${def("ep-old-000009")}${separator}${def(REAL_ID)}\n${def(STALE_ID)}\n`,
      `#${separator}${def(REAL_ID)}\n`,
      `# note${separator}${def(REAL_ID, ":")}\n${def(STALE_ID)}\n`,
    ]) {
      refusedForEveryTarget(text, TERMINATOR);
    }
  });

  it.each(SEPARATORS)("%s anywhere in .env.local is refused — even where no DATABASE_URL is involved, and never by skipping the line", (_name, separator) => {
    for (const text of [`OTHER=1${separator}MORE=2\n${def(REAL_ID)}\n`, `${def(REAL_ID)}\n# trailing${separator}`, `${separator}${def(REAL_ID)}\n`, `${def(REAL_ID)}${separator}`, `${def(REAL_ID)}\r${separator === "\r" ? "" : "\n"}${separator}\n`]) {
      refusedForEveryTarget(text, TERMINATOR);
    }
  });

  it.each(SEPARATORS)("H: %s in ANY other active env file is refused, whatever that file appears to define", (_name, separator) => {
    for (const file of OTHER_NEXT_ENV_FILES) {
      for (const text of [`# note${separator}${def(STALE_ID)}\n`, `${def(REAL_ID)}${separator}${def(STALE_ID)}\n`, `OTHER=1${separator}MORE=2\n`, `# same endpoint${separator}${def(REAL_ID)}\n`]) {
        refusedForEveryTarget(text, new RegExp(`^${file.replace(/\./g, "\\.")} contains a line terminator other than LF or CRLF`), { [file]: text }, realLine());
      }
    }
    // LF / CRLF in another file is unaffected.
    expect(checkConfirmedDisposableTarget(input(env(), realLine(), { ".env": `OTHER=1\r\n${def(REAL_ID)}\r\n`, ".env.production": "OTHER=1\nMORE=2\n" }))).toEqual({ ok: true });
  });

  it.each(SEPARATORS)("J: with %s, the real endpoint is never accepted as disposable on the strength of the line the checker can see", (_name, separator) => {
    // The visible LF line names a stale endpoint; the effective definition (after the separator) names the real one.
    const text = `${def(STALE_ID)}\n# rotated${separator}${def(REAL_ID)}\n`;
    const connect = vi.fn();
    const target = input(env({ [BRANCH_URL_ENV]: urlOf(hostOf(REAL_ID)), [EXPECTED_ENDPOINT_ENV]: REAL_ID }), text);
    expect(() => connect(confirmedDisposableTargetUrl(target))).toThrow(TERMINATOR);
    expect(connect).not.toHaveBeenCalled();
    expect(resolveConfirmedDirectTarget({ ...directInput(directEnv({ [DIRECT_DATABASE_URL_ENV]: urlOf(hostOf(REAL_ID)), [EXPECTED_ENDPOINT_ENV]: REAL_ID }), text), otherEnvFiles: {} })).not.toHaveProperty("url");
  });

  // The reason for the rule, checked against the parser Next.js actually ships (synthetic files in a temp directory only).
  describe("compared with the installed Next.js env loader", () => {
    it("LF and CRLF: the loader and the checker agree on a single definition", () => {
      for (const text of [`${def(REAL_ID)}\n`, `${def(REAL_ID)}\r\n`, `OTHER=1\r\n${def(REAL_ID, ":")}\r\n`]) {
        expect(effectiveEndpoint(text)).toBe(REAL_ID);
        expectRefused(checkConfirmedDisposableTarget(input(env({ [BRANCH_URL_ENV]: urlOf(hostOf(REAL_ID)), [EXPECTED_ENDPOINT_ENV]: REAL_ID }), text)), /equals the real database's/);
      }
    });

    it.each(SEPARATORS)("%s after a comment: the loader's effective DATABASE_URL is a definition an LF-only reading cannot see — and the checker refuses the file", (_name, separator) => {
      const text = `${def(STALE_ID)}\n# rotated${separator}${def(REAL_ID)}\n`;
      // Next.js uses the REAL endpoint here...
      expect(effectiveEndpoint(text)).toBe(REAL_ID);
      // ...while an LF-only, comment-skipping reading (what the checker did before N1) finds only the stale one.
      const visible = text.split(/\r?\n/).filter((line) => /^\s*(?:export\s+)?DATABASE_URL\s*[=:]/.test(line));
      expect(visible).toHaveLength(1);
      expect(visible[0]).toContain(STALE_ID);
      refusedForEveryTarget(text, TERMINATOR);
    });

    it("a standalone CR between two definitions: the loader takes the SECOND; the checker refuses the file", () => {
      const text = `${def(STALE_ID)}\r${def(REAL_ID)}\n`;
      expect(effectiveEndpoint(text)).toBe(REAL_ID);
      refusedForEveryTarget(text, TERMINATOR);
    });
  });
});

// N2 / N3: the checker reads a STRICT SUBSET of dotenv — one literal, single-line assignment — and refuses the rest.
describe("confirmed target check: the strict single-line, literal subset", () => {
  const STALE_ID = "ep-stale-000007";
  const url = (id: string) => urlOf(hostOf(id), "/neondb");
  const SPLIT = /names DATABASE_URL on a line that is not one complete assignment/;
  const EXPANSION = /contains "\$" \(variable expansion\)/;

  /** No target that names an endpoint Next.js would use may be accepted: not for .env.local, not for the direct form, not before a connector. */
  function neverAcceptsWhatNextUses(text: string, otherEnvFiles: Record<string, string> = {}, envLocalText = text, nextFiles: Record<string, string> = { ".env": text }) {
    const effective = nextEndpoints(nextFiles);
    for (const id of new Set([...effective, REAL_ID, STALE_ID])) {
      const e = env({ [BRANCH_URL_ENV]: url(id), [EXPECTED_ENDPOINT_ENV]: id });
      const result = checkConfirmedDisposableTarget(input(e, envLocalText, otherEnvFiles));
      if (effective.includes(id)) expect(result.ok, `accepted ${id}, which Next.js uses`).toBe(false);
      const connect = vi.fn();
      if (!result.ok) {
        expect(() => connect(confirmedDisposableTargetUrl(input(e, envLocalText, otherEnvFiles)))).toThrow(/refused to connect/);
        expect(connect).not.toHaveBeenCalled();
      }
    }
    return effective;
  }
  /** The file is refused for EVERY target (so it can never be the basis for accepting one), through every check form. */
  function refusedOutright(text: string, reason: RegExp, otherEnvFiles: Record<string, string> = {}, envLocalText = text) {
    for (const id of [BRANCH_ID, REAL_ID, STALE_ID]) {
      const e = env({ [BRANCH_URL_ENV]: url(id), [EXPECTED_ENDPOINT_ENV]: id });
      expectRefused(checkConfirmedDisposableTarget(input(e, envLocalText, otherEnvFiles)), reason);
      expectRefused(checkDisposableTarget(input(e, envLocalText, otherEnvFiles)), reason);
      expectRefused(checkConfirmedDirectTarget({ ...directInput(directEnv({ [DIRECT_DATABASE_URL_ENV]: url(id), [EXPECTED_ENDPOINT_ENV]: id }), envLocalText), otherEnvFiles }), reason);
      const connect = vi.fn();
      // The thrown message carries a "... refused to connect: " prefix, so a ^-anchored reason is matched after it.
      const anchored = reason.source.startsWith("^");
      expect(() => connect(confirmedDisposableTargetUrl(input(e, envLocalText, otherEnvFiles)))).toThrow(new RegExp(`refused to connect: ${anchored ? reason.source.slice(1) : `.*${reason.source}`}`));
      expect(connect).not.toHaveBeenCalled();
    }
  }

  describe("N2: a declaration split across lines", () => {
    it.each<[string, string]>([
      ["A: DATABASE_URL on one line and =value on the next", `DATABASE_URL\n=${url(REAL_ID)}\n`],
      ["A: the same, quoted", `DATABASE_URL\n="${url(REAL_ID)}"\n`],
      ["A: the same, with spaces around the break", `DATABASE_URL  \n  = ${url(REAL_ID)}\n`],
      ["B: the same with CRLF", `DATABASE_URL\r\n=${url(REAL_ID)}\r\n`],
      ["C: the same with a blank line between", `DATABASE_URL\n\n=${url(REAL_ID)}\n`],
      ["C: the same with two blank CRLF lines", `DATABASE_URL\r\n\r\n\r\n=${url(REAL_ID)}\r\n`],
      ["D: export on its own line, then the name, then =value", `export\nDATABASE_URL\n=${url(REAL_ID)}\n`],
      ["D: export and the name together, =value on the next line", `export DATABASE_URL\n=${url(REAL_ID)}\n`],
      ["an indented name with =value on the next line", `   DATABASE_URL\n=${url(REAL_ID)}\n`],
    ])("%s — Next.js uses it; the checker refuses the file", (_name, text) => {
      expect(effectiveEndpoint(text)).toBe(REAL_ID);
      refusedOutright(text, SPLIT);
      neverAcceptsWhatNextUses(text);
    });

    it.each<[string, string]>([
      ["E: a stale single-line definition, then a split effective one", `DATABASE_URL="${url(STALE_ID)}"\nDATABASE_URL\n="${url(REAL_ID)}"\n`],
      ["E: the same, with other lines between", `DATABASE_URL=${url(STALE_ID)}\nOTHER=1\n# rotated\nDATABASE_URL\n=${url(REAL_ID)}\n`],
      ["E: the same, export split", `DATABASE_URL=${url(STALE_ID)}\nexport DATABASE_URL\n=${url(REAL_ID)}\n`],
    ])("%s — the visible line names the stale endpoint, Next.js uses the real one, the checker refuses", (_name, text) => {
      expect(effectiveEndpoint(text)).toBe(REAL_ID);
      // What the checker read before N2: only the complete single-line assignment.
      expect(text.split(/\r?\n/).filter((line) => /^\s*(?:export\s+)?DATABASE_URL\s*[=:]/.test(line))).toEqual([expect.stringContaining(STALE_ID)]);
      refusedOutright(text, SPLIT);
      neverAcceptsWhatNextUses(text);
    });

    it.each<[string, string]>([
      ["F: a split definition first, then a single-line one", `DATABASE_URL\n="${url(STALE_ID)}"\nDATABASE_URL="${url(REAL_ID)}"\n`],
      ["F: a split REAL definition first, then a stale single-line one", `DATABASE_URL\n="${url(REAL_ID)}"\nDATABASE_URL="${url(STALE_ID)}"\n`],
    ])("%s — refused whichever one Next.js ends up using", (_name, text) => {
      expect([REAL_ID, STALE_ID]).toContain(effectiveEndpoint(text));
      refusedOutright(text, SPLIT);
      neverAcceptsWhatNextUses(text);
    });

    it("G: a split definition in each other active env file is refused, naming that file", () => {
      for (const file of OTHER_NEXT_ENV_FILES) {
        for (const text of [`DATABASE_URL\n=${url(STALE_ID)}\n`, `DATABASE_URL\r\n\r\n="${url(REAL_ID)}"\r\n`, `export DATABASE_URL\n=${url(STALE_ID)}\n`]) {
          refusedOutright(text, new RegExp(`^${file.replace(/\./g, "\\.")} names DATABASE_URL on a line that is not one complete assignment`), { [file]: text }, realLine());
        }
      }
      // Against the loader, with the file names it reads under NODE_ENV=test: the higher-priority file's split definition wins.
      const split = `DATABASE_URL\n=${url(REAL_ID)}\n`;
      expect(nextEndpoints({ ".env.test.local": split, ".env": `DATABASE_URL=${url(STALE_ID)}\n` })).toEqual([REAL_ID]);
      refusedOutright(split, /^\.env\.test\.local names DATABASE_URL on a line/, { ".env.test.local": split }, `DATABASE_URL=${url(STALE_ID)}\n`);
    });

    it("H: unrelated names are not DATABASE_URL — no false refusal, and they are never read as the definition", () => {
      const noise = [
        `MY_DATABASE_URL=${url(STALE_ID)}`,
        `DATABASE_URL_OLD=${url(STALE_ID)}`,
        `DATABASE_URL.bak=${url(STALE_ID)}`,
        `X-DATABASE_URL=${url(STALE_ID)}`,
        `DATABASE_URL-2: ${url(STALE_ID)}`,
        "MY_DATABASE_URL",
        "DATABASE_URL_OLD",
        "export NEON_DATABASE_URL_POOLED",
        `OTHER=uses-MY_DATABASE_URL-here`,
        "# DATABASE_URL",
        "   # export DATABASE_URL",
        `# DATABASE_URL\n# =${url(STALE_ID)}`,
      ].join("\n");
      const text = `${noise}\nDATABASE_URL="${url(REAL_ID)}"\n${noise}\n`;
      expect(effectiveEndpoint(text)).toBe(REAL_ID);
      expect(checkConfirmedDisposableTarget(input(env(), text))).toEqual({ ok: true });
      expectRefused(checkConfirmedDisposableTarget(input(env({ [BRANCH_URL_ENV]: url(REAL_ID), [EXPECTED_ENDPOINT_ENV]: REAL_ID }), text)), /equals the real database's/);
      // The stale endpoint those names mention is NOT the real one, so it is not what gets refused as "real".
      expect(checkConfirmedDisposableTarget(input(env({ [BRANCH_URL_ENV]: url(STALE_ID), [EXPECTED_ENDPOINT_ENV]: STALE_ID }), text))).toEqual({ ok: true });
      // With only the look-alikes, there is no DATABASE_URL at all.
      expectRefused(checkConfirmedDisposableTarget(input(env(), `${noise}\n`)), /names no DATABASE_URL/);
    });

    it.each<[string, string]>([
      ["the bare name", "DATABASE_URL\n"],
      ["the bare name at the end of the file", `DATABASE_URL="${url(REAL_ID)}"\nDATABASE_URL`],
      ["export and the bare name", "export DATABASE_URL\n"],
      ["a mention of it in another variable's value", `DATABASE_URL="${url(REAL_ID)}"\nOTHER=see DATABASE_URL above\n`],
      ["a reference to it from another variable", `DATABASE_URL="${url(REAL_ID)}"\nOTHER=\${DATABASE_URL}\n`],
      ["the name after other text on the line", `DATABASE_URL="${url(REAL_ID)}"\nFOO=1 DATABASE_URL=${url(STALE_ID)}\n`],
      ["an upper-case EXPORT", `EXPORT DATABASE_URL=${url(REAL_ID)}\n`],
      ["a doubled export", `export export DATABASE_URL=${url(REAL_ID)}\n`],
      ["a name with a trailing word", `DATABASE_URL x=${url(REAL_ID)}\n`],
    ])("any other non-comment line naming DATABASE_URL is refused, never skipped — %s", (_name, text) => {
      refusedOutright(text, SPLIT);
      neverAcceptsWhatNextUses(text);
    });

    it.each<[string, string, RegExp]>([
      ["= and the value on the next line (quoted)", `DATABASE_URL=\n"${url(REAL_ID)}"\n`, /is not a URL/],
      ["= and the value on the next line (unquoted)", `DATABASE_URL=\n${url(REAL_ID)}\n`, /is not a URL/],
      [": and the value on the next line", `DATABASE_URL:\n${url(REAL_ID)}\n`, /is not a URL/],
      ["a quoted value that closes on a later line", `DATABASE_URL="${url(REAL_ID)}\n"\n`, /is not a URL/],
      ["a quoted value that opens on its own line", `DATABASE_URL="\n${url(REAL_ID)}"\n`, /is not a URL/],
      ["a value followed by a comment", `DATABASE_URL=${url(REAL_ID)} # prod\n`, /is not a URL/],
      ["a quoted value followed by a comment", `DATABASE_URL="${url(REAL_ID)}" # prod\n`, /is not a URL/],
      ["a # inside the value", `DATABASE_URL=${url(REAL_ID)}#\n`, /is not a URL/],
      ["a quoted # at the end of the value", `DATABASE_URL="${url(REAL_ID)}#"\n`, /is not a URL/],
      ["a # that cuts the credentials off the host", `DATABASE_URL=postgresql://app:se#cret@${hostOf(STALE_ID)}/neondb\n`, /is not a URL/],
      ["an escape sequence in a double-quoted value", `DATABASE_URL="${url(REAL_ID)}\\n"\n`, /is not a URL/],
    ])("a value the checker cannot read as one literal on that line is refused — %s", (_name, text, reason) => {
      refusedOutright(text, reason);
      neverAcceptsWhatNextUses(text);
    });
  });

  describe("N3: variable expansion", () => {
    const REAL_TAIL = `${hostOf(REAL_ID)}/neondb`;
    /** A stale-looking literal whose password reference, once expanded, moves the host to the real endpoint. */
    const hijack = (reference: string, quote = "") => `PW=secret@${REAL_TAIL}?x=\nDATABASE_URL=${quote}postgresql://app:${reference}@${hostOf(STALE_ID)}/neondb${quote}\n`;

    it.each<[string, string]>([
      ["I: $PW in a password", hijack("$PW")],
      ["J: ${PW} in a password", hijack("${PW}")],
      ["M: $PW inside double quotes", hijack("$PW", '"')],
      ["M: ${PW} inside double quotes", hijack("${PW}", '"')],
      ["L: $PW inside single quotes", hijack("$PW", "'")],
      ["L: ${PW} inside single quotes", hijack("${PW}", "'")],
      ["${PW} inside backticks", hijack("${PW}", "`")],
      ["K: $PW in a username", `PW=app:secret@${REAL_TAIL}?x=\nDATABASE_URL=postgresql://$PW:secret@${hostOf(STALE_ID)}/neondb\n`],
      ["K: ${PW} in a username", `PW=app:secret@${REAL_TAIL}?x=\nDATABASE_URL="postgresql://\${PW}:secret@${hostOf(STALE_ID)}/neondb"\n`],
      ["N: $H as the hostname", `H=${hostOf(REAL_ID)}\nDATABASE_URL=postgresql://app:secret@$H/neondb\n`],
      ["N: ${H} as the endpoint label", `H=${REAL_ID}\nDATABASE_URL="postgresql://app:secret@\${H}.c-1.us-east-2.aws.neon.invalid/neondb"\n`],
      ["N: a default value as the hostname", `DATABASE_URL=postgresql://app:secret@\${UNSET_SYNTHETIC_HOST:-${hostOf(REAL_ID)}}/neondb\n`],
      ["the whole value from another variable", `REAL_URL=${url(REAL_ID)}\nDATABASE_URL=$REAL_URL\n`],
      ["the whole value from another variable, defined later", `DATABASE_URL=\${REAL_URL}\nREAL_URL=${url(REAL_ID)}\n`],
      ["a reference in the database name", `DB=neondb\nDATABASE_URL=postgresql://app:secret@${hostOf(REAL_ID)}/$DB\n`],
      ["a reference in a query parameter", `MODE=require\nDATABASE_URL=${url(REAL_ID)}?sslmode=$MODE\n`],
      ["an unresolved reference", `DATABASE_URL=postgresql://app:$NOT_DEFINED_SYNTHETIC@${hostOf(REAL_ID)}/neondb\n`],
      ["an escaped dollar", `DATABASE_URL=postgresql://app:se\\$cret@${hostOf(REAL_ID)}/neondb\n`],
      ["a lone dollar in the password", `DATABASE_URL="postgresql://app:se$@${hostOf(REAL_ID)}/neondb"\n`],
    ])("%s — refused before any connector, whatever Next.js makes of it", (_name, text) => {
      refusedOutright(text, EXPANSION);
      neverAcceptsWhatNextUses(text);
    });

    it.each<[string, string]>([
      ["O: $PW", hijack("$PW")],
      ["O: ${PW}", hijack("${PW}")],
      ["O: ${PW} in double quotes", hijack("${PW}", '"')],
    ])("%s — the literal names a stale endpoint, but Next.js connects to the REAL one after expansion", (_name, text) => {
      // Written, the URL's host is the stale endpoint...
      expect(text).toContain(`@${hostOf(STALE_ID)}/neondb`);
      // ...but the loader's expanded value puts the real endpoint first, as the host.
      const effective = nextEndpoints({ ".env": text });
      expect(effective[0]).toBe(REAL_ID);
      // So the real endpoint must never be accepted as disposable on the strength of that literal.
      const connect = vi.fn();
      const target = input(env({ [BRANCH_URL_ENV]: url(REAL_ID), [EXPECTED_ENDPOINT_ENV]: REAL_ID }), text);
      expect(() => connect(confirmedDisposableTargetUrl(target))).toThrow(EXPANSION);
      expect(connect).not.toHaveBeenCalled();
      refusedOutright(text, EXPANSION);
    });

    it("single quotes do not protect a value: the installed loader expands inside every quoting style", () => {
      for (const quote of ['"', "'", "`", ""]) {
        expect(nextEndpoints({ ".env": hijack("${PW}", quote) }), JSON.stringify(quote)).toContain(REAL_ID);
      }
    });

    it("P: the same patterns in each other active env file are refused, naming that file", () => {
      for (const file of OTHER_NEXT_ENV_FILES) {
        for (const text of [hijack("$PW"), hijack("${PW}", '"'), hijack("${PW}", "'"), `H=${hostOf(REAL_ID)}\nDATABASE_URL=postgresql://app:secret@$H/neondb\n`, `DATABASE_URL=$REAL_URL\n`]) {
          refusedOutright(text, new RegExp(`^${file.replace(/\./g, "\\.")}'s DATABASE_URL contains "\\$"`), { [file]: text }, realLine());
        }
      }
      // Against the loader: an expansion in the higher-priority file decides the endpoint, over a literal in `.env`.
      expect(nextEndpoints({ ".env.test.local": hijack("${PW}"), ".env": `DATABASE_URL=${url(STALE_ID)}\n` })[0]).toBe(REAL_ID);
    });

    it("a `$` in ANOTHER variable is not refused — only DATABASE_URL's own value is constrained", () => {
      const text = `OTHER=$HOME/x\nNOTE="costs $5"\nDATABASE_URL="${url(REAL_ID)}"\n`;
      expect(effectiveEndpoint(text)).toBe(REAL_ID);
      expect(checkConfirmedDisposableTarget(input(env(), text))).toEqual({ ok: true });
      expectRefused(checkConfirmedDisposableTarget(input(env({ [BRANCH_URL_ENV]: url(REAL_ID), [EXPECTED_ENDPOINT_ENV]: REAL_ID }), text)), /equals the real database's/);
    });
  });

  // The contract itself, checked mechanically against the installed loader over a generated corpus: for EVERY text,
  // no endpoint that Next.js would use may be accepted as a disposable target. (Refusing more than Next.js needs is fine.)
  describe("differential check against the installed Next.js env loader", () => {
    // Each case makes thousands of loader calls (a temp directory apiece). That is ~2 s alone, but well past Vitest's
    // 5 s default when the full suite's child-process tests are running beside it — so the budget is explicit.
    const DIFFERENTIAL_TIMEOUT_MS = 120_000;
    const keys = ["DATABASE_URL", "export DATABASE_URL", "  DATABASE_URL", "\tDATABASE_URL", "export\nDATABASE_URL", "export  \n\n  DATABASE_URL", "﻿DATABASE_URL", " DATABASE_URL", "\fDATABASE_URL", "　export DATABASE_URL"];
    const separators = ["=", " = ", ": ", ":", ":\t", "\n=", "\r\n=", "\n\n=", " \n = ", "=\n", "= \n ", ":\n", ": \n", "\n: ", "\f=", "\u000b=", " =", "= ", " : ", "\n=\n"];
    const values = (id: string) => [url(id), `"${url(id)}"`, `'${url(id)}'`, `\`${url(id)}\``, `"\n${url(id)}\n"`, `${url(id)} # c`, `"${url(id)}" # c`, `${url(id)}#c`, `"${url(id)}"x`, `""${url(id)}""`, `"${url(id)}'`, ` ${url(id)} `, `${url(id)}\\`, `"${url(id)}\\n"`];
    const definitions = (id: string) => keys.flatMap((key) => separators.flatMap((separator) => values(id).map((value) => `${key}${separator}${value}`)));
    const real = definitions(REAL_ID);
    const plainStale = `DATABASE_URL="${url(STALE_ID)}"`;
    // [context, wrapper, whether the checker can accept anything at all there (never, once a second definition is visible)]
    const contexts: Array<[string, (definition: string) => string, boolean]> = [
      ["alone", (d) => `${d}\n`, true],
      ["alone, CRLF", (d) => `${d.replace(/\n/g, "\r\n")}\r\n`, true],
      ["after a stale single-line definition", (d) => `${plainStale}\n${d}\n`, false],
      ["before a stale single-line definition", (d) => `${d}\n${plainStale}\n`, false],
      ["after a comment and a blank line", (d) => `# DATABASE_URL=${url(STALE_ID)}\n\n${d}\n`, true],
      ["after an unterminated quote in another variable", (d) => `OTHER="open\n${d}\n`, true],
      ["inside another variable's multi-line quoted value, stale outside", (d) => `OTHER="\n${d}\n"\n${plainStale}\n`, false],
      ["outside, with a stale definition inside another variable's multi-line value", (d) => `OTHER="\n${plainStale}\n"\n${d}\n`, false],
      ["after a line that ends in a backslash", (d) => `OTHER=x\\\n${d}\n`, true],
    ];

    it.each(contexts)("%s: no endpoint the loader uses is ever accepted", (_name, wrap, canAccept) => {
      let loaderDefined = 0;
      let accepted = 0;
      for (const definition of real) {
        const text = wrap(definition);
        if (/\r(?!\n)/.test(text)) continue; // bare CR is N1's refusal; the CRLF context above rewrites every LF
        const effective = nextEndpoints({ ".env": text });
        if (effective.length > 0) loaderDefined += 1;
        for (const id of new Set([...effective, REAL_ID, STALE_ID])) {
          const result = checkConfirmedDisposableTarget(input(env({ [BRANCH_URL_ENV]: url(id), [EXPECTED_ENDPOINT_ENV]: id }), text));
          if (effective.includes(id)) expect(result.ok, `accepted ${id}, which Next.js uses, for ${JSON.stringify(text)}`).toBe(false);
          if (result.ok) accepted += 1;
        }
      }
      // The corpus really exercises the loader, and the subset is not so strict that nothing is ever accepted.
      expect(loaderDefined).toBeGreaterThan(real.length / 4);
      if (canAccept) expect(accepted).toBeGreaterThan(0);
      else expect(accepted).toBe(0);
    }, DIFFERENTIAL_TIMEOUT_MS);

    it("two active files: no endpoint the loader uses is accepted, whichever file wins", () => {
      const sample = real.filter((_, index) => index % 7 === 0);
      for (const definition of sample) {
        for (const [high, low] of [
          [`${definition}\n`, `${plainStale}\n`],
          [`${plainStale}\n`, `${definition}\n`],
        ] as const) {
          const effective = nextEndpoints({ ".env.test.local": high, ".env": low });
          for (const id of new Set([...effective, REAL_ID, STALE_ID])) {
            // The checker's view: one file as .env.local, the other as another active env file — both ways round.
            for (const [local, other] of [[high, low], [low, high]] as const) {
              const result = checkConfirmedDisposableTarget(input(env({ [BRANCH_URL_ENV]: url(id), [EXPECTED_ENDPOINT_ENV]: id }), local, { ".env": other }));
              if (effective.includes(id)) expect(result.ok, `accepted ${id} for ${JSON.stringify([high, low])}`).toBe(false);
            }
          }
        }
      }
    }, DIFFERENTIAL_TIMEOUT_MS);

    it("expansion corpus: no endpoint the loader uses is accepted", () => {
      const references = ["$V", "${V}", "${V:-x}", "${UNSET_SYNTHETIC:-$V}", "\\$V", "$V$V", "${V}suffix"];
      const assignments = [`V=${hostOf(REAL_ID)}`, `V=secret@${hostOf(REAL_ID)}/neondb?x=`, `V=${url(REAL_ID)}`, `V=${REAL_ID}`, `V="${hostOf(REAL_ID)}"`, `V='${url(REAL_ID)}'`];
      const templates = (r: string) => [r, `postgresql://app:secret@${r}/neondb`, `postgresql://app:${r}@${hostOf(STALE_ID)}/neondb`, `postgresql://${r}:secret@${hostOf(STALE_ID)}/neondb`, `postgresql://app:secret@${r}.c-1.us-east-2.aws.neon.invalid/neondb`, `${url(STALE_ID)}?sslmode=${r}`];
      let usedReal = 0;
      for (const assignment of assignments) {
        for (const reference of references) {
          for (const template of templates(reference)) {
            for (const quote of ["", '"', "'", "`"]) {
              for (const text of [`${assignment}\nDATABASE_URL=${quote}${template}${quote}\n`, `DATABASE_URL=${quote}${template}${quote}\n${assignment}\n`]) {
                const effective = nextEndpoints({ ".env": text });
                if (effective.includes(REAL_ID)) usedReal += 1;
                for (const id of new Set([...effective, REAL_ID, STALE_ID])) {
                  const result = checkConfirmedDisposableTarget(input(env({ [BRANCH_URL_ENV]: url(id), [EXPECTED_ENDPOINT_ENV]: id }), text));
                  expect(result.ok, `accepted ${id} for ${JSON.stringify(text)}`).toBe(false); // every one holds a `$`
                }
              }
            }
          }
        }
      }
      expect(usedReal).toBeGreaterThan(100); // expansion really does move the endpoint in this corpus
    }, DIFFERENTIAL_TIMEOUT_MS);
  });
});

describe("confirmed target check: connection-routing overrides", () => {
  const withTail = (tail: string) => env({ [BRANCH_URL_ENV]: urlOf(hostOf(BRANCH_ID), tail) });
  it.each<[string, Env, RegExp]>([
    ["options=endpoint (Neon endpoint override)", withTail(`/neondb?options=endpoint%3D${REAL_ID}`), /unsupported or repeated connection parameter/],
    ["options=project", withTail("/neondb?options=project%3Dsomething"), /unsupported or repeated connection parameter/],
    ["host=", withTail(`/neondb?host=${hostOf(REAL_ID)}`), /unsupported or repeated connection parameter/],
    ["hostaddr=", withTail("/neondb?hostaddr=192.0.2.1"), /unsupported or repeated connection parameter/],
    ["port=", withTail("/neondb?port=6543"), /unsupported or repeated connection parameter/],
    ["service=", withTail("/neondb?service=prod"), /unsupported or repeated connection parameter/],
    ["dbname=", withTail("/neondb?dbname=other"), /unsupported or repeated connection parameter/],
    ["an unknown parameter", withTail("/neondb?sslmode=require&x=1"), /unsupported or repeated connection parameter/],
    ["an allowed parameter repeated", withTail("/neondb?sslmode=require&sslmode=disable"), /unsupported or repeated connection parameter/],
    ["an upper-case parameter name", withTail("/neondb?OPTIONS=endpoint%3Dx"), /unsupported or repeated connection parameter/],
    // L4: an allowed NAME is not enough — its value cannot carry a second assignment or anything encoded.
    ["sslmode=require;options=endpoint=...", withTail(`/neondb?sslmode=require;options=endpoint=${REAL_ID}`), /unsupported or repeated connection parameter/],
    ["the same, percent-encoded", withTail(`/neondb?sslmode=require%3Boptions%3Dendpoint%3D${REAL_ID}`), /unsupported or repeated connection parameter/],
    ["a semicolon separator between parameters", withTail("/neondb?sslmode=require;channel_binding=require"), /unsupported or repeated connection parameter/],
    ["a value with a space", withTail("/neondb?sslmode=require options"), /missing or not a URL/],
    ["a value with an encoded space", withTail("/neondb?sslmode=require%20options%3Dx"), /unsupported or repeated connection parameter/],
    ["a value with a plus (form-encoded space)", withTail("/neondb?sslmode=require+options"), /unsupported or repeated connection parameter/],
    ["a second assignment inside a value", withTail("/neondb?sslmode=require=options"), /unsupported or repeated connection parameter/],
    ["an encoded ampersand smuggling a parameter", withTail("/neondb?sslmode=require%26options%3Dendpoint"), /unsupported or repeated connection parameter/],
    ["an encoded parameter name", withTail("/neondb?%6Fptions=x"), /unsupported or repeated connection parameter/],
    ["a well-formed but non-standard sslmode value", withTail("/neondb?sslmode=endpoint-ep-real"), /unsupported or repeated connection parameter/],
    ["an upper-case value", withTail("/neondb?sslmode=REQUIRE"), /unsupported or repeated connection parameter/],
    ["a non-standard channel_binding value", withTail("/neondb?channel_binding=options"), /unsupported or repeated connection parameter/],
    ["a non-numeric connect_timeout", withTail("/neondb?connect_timeout=10s"), /unsupported or repeated connection parameter/],
    ["an oversized connect_timeout", withTail("/neondb?connect_timeout=100000"), /unsupported or repeated connection parameter/],
    ["an empty value", withTail("/neondb?sslmode="), /unsupported or repeated connection parameter/],
    ["a bare name", withTail("/neondb?sslmode"), /unsupported or repeated connection parameter/],
    ["a trailing ampersand", withTail("/neondb?sslmode=require&"), /unsupported or repeated connection parameter/],
    ["a non-default port", env({ [BRANCH_URL_ENV]: urlOf(`${hostOf(BRANCH_ID)}:6543`) }), /non-default port/],
    ["no database name", withTail(""), /exactly one database/],
    ["a nested path", withTail("/neondb/extra"), /exactly one database/],
    ["a fragment", withTail("/neondb#frag"), /exactly one database/],
    ["a second @ (host depends on the parser)", env({ [BRANCH_URL_ENV]: `postgresql://app:secret@${hostOf(REAL_ID)}@${hostOf(BRANCH_ID)}/neondb` }), /exactly one "@"/],
    ["an endpoint override in the password", env({ [BRANCH_URL_ENV]: urlOf(hostOf(BRANCH_ID), "/neondb", `app:endpoint%3D${REAL_ID}%24secret`) }), /routing override in its credentials/],
    ["an options override in the username", env({ [BRANCH_URL_ENV]: urlOf(hostOf(BRANCH_ID), "/neondb", "options%3Dx:secret") }), /routing override in its credentials/],
    ["a backslash", env({ [BRANCH_URL_ENV]: `postgresql://app:secret@${hostOf(BRANCH_ID)}\\@x/neondb` }), /missing or not a URL/],
    ["whitespace inside the URL", env({ [BRANCH_URL_ENV]: branch.replace("@", "@ ") }), /missing or not a URL/],
    ["an IPv6 literal host", env({ [BRANCH_URL_ENV]: "postgresql://app:secret@[2001:db8::1]/neondb" }), /no plain DNS hostname/],
    ["a single-label host", env({ [BRANCH_URL_ENV]: `postgresql://app:secret@${BRANCH_ID}/neondb` }), /no plain DNS hostname/],
    ["a non-postgres scheme", env({ [BRANCH_URL_ENV]: `https://${hostOf(BRANCH_ID)}/neondb` }), /is not a postgres:\/\/ URL/],
  ])("%s", (_name, e, reason) => {
    expectRefused(checkConfirmedDisposableTarget(input(e)), reason);
    expectRefused(checkDisposableTarget(input(e)), reason);
  });
});

describe("confirmed DIRECT target check (the race suite's own URL variable)", () => {
  it("accepts the race gate + a direct URL + the matching endpoint id", () => {
    expect(checkConfirmedDirectTarget(directInput(directEnv()))).toEqual({ ok: true });
  });

  it.each<[string, Env, RegExp]>([
    ["no race gate", directEnv({ [RACE_GATE]: undefined }), /REAL_SMOKE_L2_RACE is not set/],
    ["REAL_SMOKE_L2_INDEXES without the race gate", directEnv({ [RACE_GATE]: undefined, REAL_SMOKE_L2_INDEXES: "1" }), /REAL_SMOKE_L2_RACE is not set/],
    ["REAL_SMOKE_L2_INDEXES beside the race gate", directEnv({ REAL_SMOKE_L2_INDEXES: "1" }), /an unrelated smoke gate is set/],
    ["DATABASE_URL exported", directEnv({ DATABASE_URL: branch }), /DATABASE_URL is exported/],
    ["only NEON_BRANCH_DATABASE_URL — never a substitute for the direct URL", { [RACE_GATE]: "1", [BRANCH_URL_ENV]: branch, [EXPECTED_ENDPOINT_ENV]: BRANCH_ID }, /REAL_SMOKE_L2_DIRECT_DATABASE_URL is missing or not a URL/],
    ["a pooled URL", directEnv({ [DIRECT_DATABASE_URL_ENV]: urlOf(hostOf(`${BRANCH_ID}-pooler`)) }), /pooled endpoint/],
    ["no expected endpoint id", directEnv({ [EXPECTED_ENDPOINT_ENV]: undefined }), /NEON_BRANCH_EXPECTED_ENDPOINT_ID is not set/],
    ["a wrong expected endpoint id", directEnv({ [EXPECTED_ENDPOINT_ENV]: "ep-other-000003" }), /does not match/],
    ["the real endpoint", directEnv({ [DIRECT_DATABASE_URL_ENV]: urlOf(hostOf(REAL_ID)), [EXPECTED_ENDPOINT_ENV]: REAL_ID }), /equals the real database's/],
    ["the real endpoint in upper case", directEnv({ [DIRECT_DATABASE_URL_ENV]: urlOf(hostOf(REAL_ID).toUpperCase()), [EXPECTED_ENDPOINT_ENV]: REAL_ID }), /mixed-case hostname/],
    ["a routing override", directEnv({ [DIRECT_DATABASE_URL_ENV]: urlOf(hostOf(BRANCH_ID), `/neondb?options=endpoint%3D${REAL_ID}`) }), /unsupported or repeated connection parameter/],
  ])("%s", (_name, e, reason) => expectRefused(checkConfirmedDirectTarget(directInput(e)), reason));

  it("refuses when the real endpoint is ambiguous", () => {
    expectRefused(checkConfirmedDirectTarget(directInput(directEnv(), realLine() + realLine())), /more than once/);
    expectRefused(checkConfirmedDirectTarget(directInput(directEnv(), null)), /\.env\.local is not readable/);
  });
});

describe("no connection before verification, and no DATABASE_URL fallback", () => {
  const refused: Array<[string, ReturnType<typeof input>]> = [
    ["DATABASE_URL alone", input({ DATABASE_URL: branch })],
    ["no explicit gate", input(env({ [GATE]: undefined }))],
    ["the gate with only DATABASE_URL", input({ [GATE]: "1", [EXPECTED_ENDPOINT_ENV]: BRANCH_ID, DATABASE_URL: branch })],
    ["missing expected endpoint", input(env({ [EXPECTED_ENDPOINT_ENV]: undefined }))],
    ["wrong endpoint", input(env({ [EXPECTED_ENDPOINT_ENV]: "ep-other-000003" }))],
    ["the real endpoint", input(env({ [BRANCH_URL_ENV]: urlOf(hostOf(REAL_ID)), [EXPECTED_ENDPOINT_ENV]: REAL_ID }))],
    ["a mixed-case hostname", input(env({ [BRANCH_URL_ENV]: urlOf(hostOf(REAL_ID).toUpperCase()) }))],
    ["duplicate real definitions", input(env(), realLine() + realLine())],
    ["a conflicting env file", input(env(), realLine(), { ".env": `DATABASE_URL="${urlOf(hostOf("ep-other-000009"))}"\n` })],
    ["a routing override", input(env({ [BRANCH_URL_ENV]: urlOf(hostOf(BRANCH_ID), `/neondb?options=endpoint%3D${REAL_ID}`) }))],
    ["an unrelated smoke gate", input(env({ REAL_SMOKE_L2_INDEXES: "1" }))],
    ["an admin gate", input(env({ REAL_ADMIN_RESOLVE_PASSKEY_REVOCATION: "1" }))],
  ];

  it.each(refused)("%s: the refusal throws before the connector is called, and no other URL is handed to it", (_name, refusedInput) => {
    const connect = vi.fn();
    for (const prefix of ["Neon smoke refused to connect", "Handles smoke refused to connect"]) {
      let message = "";
      try {
        connect(confirmedDisposableTargetUrl(refusedInput, prefix));
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message.startsWith(`${prefix}: `)).toBe(true);
      expect(message).not.toMatch(/secret|postgres(ql)?:\/\/\S/);
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it("a confirmed target hands the connector the branch URL and nothing else", () => {
    const connect = vi.fn();
    connect(confirmedDisposableTargetUrl(input(env())));
    expect(connect.mock.calls).toEqual([[branch]]);
  });

  // L3: the string that is validated is the string that is returned — for both the branch and the direct form.
  it.each<[string, string]>([
    ["as written", branch],
    ["with surrounding whitespace", `  ${branch}\t`],
    ["in one balanced pair of double quotes", `"${branch}"`],
    ["in one balanced pair of single quotes", `'${branch}'`],
    ["quoted, with surrounding whitespace", ` "${branch}" `],
  ])("the URL handed out is exactly the validated one — %s", (_name, raw) => {
    expect(confirmedDisposableTargetUrl(input(env({ [BRANCH_URL_ENV]: raw })))).toBe(branch);
    expect(resolveConfirmedDirectTarget(directInput(directEnv({ [DIRECT_DATABASE_URL_ENV]: raw })))).toEqual({ ok: true, url: branch });
  });

  it.each<[string, string]>([
    ["a trailing quote", `${branch}"`],
    ["a leading quote", `"${branch}`],
    ["mismatched quotes", `"${branch}'`],
    ["mismatched quotes, reversed", `'${branch}"`],
    ["a trailing backtick", `${branch}\``],
    ["doubled quotes", `""${branch}""`],
    ["a quote inside the URL", branch.replace("/neondb", '/neon"db')],
    ["whitespace inside the quotes", `" ${branch}"`],
  ])("ambiguous quoting fails closed, and no URL is handed out — %s", (_name, raw) => {
    const connect = vi.fn();
    expect(() => connect(confirmedDisposableTargetUrl(input(env({ [BRANCH_URL_ENV]: raw }))))).toThrow(/refused to connect: NEON_BRANCH_DATABASE_URL (has unbalanced or stray quotes|is missing or not a URL)$/);
    expect(connect).not.toHaveBeenCalled();
    const direct = resolveConfirmedDirectTarget(directInput(directEnv({ [DIRECT_DATABASE_URL_ENV]: raw })));
    expect(direct.ok).toBe(false);
    expect(direct).not.toHaveProperty("url");
  });
});

// ------------------------------------------------------------------ the suites themselves (static)

const read = (file: string) => readFileSync(file, "utf8");
const codeOf = (file: string) =>
  read(file)
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
const R = "test/lib/real/";
const MIGRATION_SMOKES: Array<[string, string]> = [
  [`${R}l2-identity-migration.smoke.test.ts`, "REAL_SMOKE_L2_MIGRATION"],
  [`${R}provisioning-dispatch-migration.smoke.test.ts`, "REAL_SMOKE_PROVISIONING_MIGRATION"],
];
const RACE_SMOKE = `${R}l2-identity-race.smoke.test.ts`;
const ADAPTER_SMOKE = `${R}neon-smoke.test.ts`;
const DISPOSABLE_SMOKES: Array<[string, string[]]> = [
  [`${R}handles-migration.smoke.test.ts`, ["REAL_SMOKE_HANDLES_MIGRATION", "REAL_SMOKE_HANDLES_MIGRATION_PUBLIC"]],
  [`${R}handles-runtime.smoke.test.ts`, ["REAL_SMOKE_HANDLES_RUNTIME"]],
  [`${R}payment-recipient-identity-migration.smoke.test.ts`, ["REAL_SMOKE_PAYMENT_RECIPIENT_MIGRATION", "REAL_SMOKE_PAYMENT_RECIPIENT_MIGRATION_PUBLIC"]],
  [`${R}handle-pay-reserve.smoke.test.ts`, ["REAL_SMOKE_HANDLE_PAY_RESERVE"]],
  [`${R}rate-limit.smoke.test.ts`, ["REAL_SMOKE_RATE_LIMIT", "REAL_SMOKE_RATE_LIMIT_PUBLIC"]],
  [`${R}provisioning-limits.smoke.test.ts`, ["REAL_SMOKE_PROVISIONING_LIMITS"]],
  [`${R}provider-budget.smoke.test.ts`, ["REAL_SMOKE_PROVIDER_BUDGET"]],
  [`${R}registration-admission.smoke.test.ts`, ["REAL_SMOKE_REGISTRATION_ADMISSION"]],
];
/** Every live suite family: its file, and the smoke gates it may run with. */
const FAMILIES: Array<[string, string[]]> = [
  [ADAPTER_SMOKE, ["REAL_SMOKE_NEON_ADAPTER", "REAL_SMOKE_PROVISIONING_DISPATCH", "REAL_SMOKE_L2_INDEXES"]],
  ...MIGRATION_SMOKES.map(([file, gate]): [string, string[]] => [file, [gate]]),
  [RACE_SMOKE, [RACE_GATE]],
  ...DISPOSABLE_SMOKES,
];

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? testFiles(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe("the two migration smokes (static)", () => {
  it.each(MIGRATION_SMOKES)("%s: its own gate only, a branch target through the confirmed check, refusal first, guarded cleanup", (file, gate) => {
    const code = codeOf(file);
    expect(code).toContain(`const GATE = "${gate}";`);
    expect(code).toContain("const ALLOWED_GATES = [GATE] as const;");
    expect(code).toContain('const enabled = process.env[GATE] === "1";');
    expect(code.match(/process\.env\b[.[]\w+\]?/g)).toEqual(["process.env[GATE]"]);
    expect(code).not.toMatch(/DATABASE_URL/);
    // One source of a connection string, and the one connector is handed exactly that.
    expect(code.match(/requireConfirmedDisposableTargetUrl\(/g)).toHaveLength(1);
    expect(code).toContain("if (!confirmedTargetUrl) confirmedTargetUrl = requireConfirmedDisposableTargetUrl(GATE, ALLOWED_GATES);");
    expect(code.match(/createNeon\w+\([^\n]*/g)).toEqual(["createNeonSqlClient(targetUrl());"]);
    expect(code).not.toMatch(/\bneon\(/);
    // The live block refuses in its first hook, and its cleanup connects to nothing after a refusal.
    expect(code).toMatch(/\ndescribe\.skipIf\(!enabled\)\([^\n]*\n  beforeAll\(\(\) => void targetUrl\(\)\);\n/);
    expect(code.match(/^describe\.skipIf\(/gm)).toHaveLength(1);
    expect(code.match(/afterAll\(async \(\) => \{\n[^\n]*/g)).toEqual(["afterAll(async () => {\n    if (!confirmedTargetUrl) return;"]);
  });

  it.each(MIGRATION_SMOKES)("%s: still runs the EXACT schema.sql block with only its target schema swapped", (file) => {
    const code = codeOf(file);
    expect(code).toContain('readFileSync("lib/real/server/schema.sql", "utf8")');
    expect(code).toMatch(/target_schema CONSTANT pg_catalog\.text := 'public';/);
    expect(code).toContain("const migrate = (schema: string) => q(migrationFor(schema));");
  });
});

describe("the race smoke (static)", () => {
  const code = codeOf(RACE_SMOKE);
  it("is enabled only by its own gate, and hands the env files to the provenance check", () => {
    expect(code).toContain('const enabled = process.env.REAL_SMOKE_L2_RACE === "1";');
    expect(code.match(/process\.env\.\w+/g)).toEqual(["process.env.REAL_SMOKE_L2_RACE"]);
    expect(code).not.toContain("REAL_SMOKE_L2_INDEXES");
    expect(code).toContain("envFiles: readActiveEnvFiles(),");
    expect(code).toContain("if (!directUrl) return;"); // cleanup after a refusal touches nothing
  });

  it("prepareRaceSuite checks provenance after the URL shape and BEFORE the session probe", () => {
    const harness = read(`${R}fixtures/race-harness.ts`);
    const body = harness.slice(harness.indexOf("export async function prepareRaceSuite("));
    const shape = body.indexOf("resolveDirectDatabaseUrl(input.env)");
    const provenance = body.indexOf("resolveConfirmedDirectTarget({ env: input.env, ...input.envFiles, gate: RACE_GATE, allowedGates: [RACE_GATE], urlEnv: DIRECT_DATABASE_URL_ENV })");
    expect(shape).toBeGreaterThan(-1);
    expect(provenance).toBeGreaterThan(shape);
    expect(provenance).toBeLessThan(body.indexOf("input.readSessionSettings("));
    expect(body.indexOf("input.readSessionSettings(")).toBeLessThan(body.indexOf("input.activate("));
    // L3: the probe and the activation are handed the VALIDATED url — the shape check's own reading is never used to connect.
    const bodyCode = body.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    expect(bodyCode).toContain("const url = provenance.url;");
    expect(bodyCode).toContain("await input.readSessionSettings(url)");
    expect(bodyCode).toContain("input.activate(url);");
    expect(bodyCode).not.toContain("check.url");
    expect(bodyCode.match(/\.url\b/g)).toEqual([".url"]);
  });
});

describe("the disposable-branch smokes (static)", () => {
  it.each(DISPOSABLE_SMOKES)("%s: every connection comes from the shared, now-confirmed helper; the header documents the new variable", (file, gates) => {
    const source = read(file);
    const code = codeOf(file);
    expect(code).toContain(`const GATE = "${gates[0]}";`);
    // L1: the gate ALONE enables the live blocks, so a set gate with no target fails instead of skipping.
    expect(code.match(/^const enabled = [^\n]*/m)?.[0]).toBe('const enabled = process.env[GATE] === "1";');
    expect(code).not.toMatch(/process\.env\.NEON_BRANCH_DATABASE_URL|process\.env\[BRANCH_URL_ENV\]/);
    expect(code).not.toMatch(/process\.env\.DATABASE_URL/);
    const sources = code.match(/requireDisposableTargetUrl\([^)]*\)/g) ?? [];
    expect(sources.length).toBeGreaterThanOrEqual(1);
    for (const call of sources) expect(call).toBe("requireDisposableTargetUrl(GATE, ALLOWED_GATES)");
    const connectors = code.match(/connectSmoke(?:Db|Stores)\(/g) ?? [];
    expect(connectors.length).toBeGreaterThanOrEqual(1);
    expect(code.match(/connectSmoke(?:Db|Stores)\((?:requireDisposableTargetUrl\(GATE, ALLOWED_GATES\)|url)\)/g)).toHaveLength(connectors.length);
    for (const [, value] of code.matchAll(/const url = ([^;]*);/g)) expect(value).toBe("requireDisposableTargetUrl(GATE, ALLOWED_GATES)");
    expect(code).not.toMatch(/createNeon\w+\(|\bneon\(/);
    expect(source).toContain(`${EXPECTED_ENDPOINT_ENV}="ep-..."`);
    expect(source).toContain("Milestone 0 Pass B: the run also requires NEON_BRANCH_EXPECTED_ENDPOINT_ID");
  });

  it("the shared helper they call IS the confirmed check", () => {
    const fixture = read(`${R}fixtures/handles-smoke-db.ts`);
    const helper = /export function requireDisposableTargetUrl\([\s\S]*?\n\}/.exec(fixture)?.[0] ?? "";
    expect(helper).toContain('return confirmedDisposableTargetUrl({ env: process.env, ...readActiveEnvFiles(), gate, allowedGates }, "Handles smoke refused to connect");');
    const confirmed = /export function confirmedDisposableTargetUrl\([\s\S]*?\n\}/.exec(fixture)?.[0] ?? "";
    expect(confirmed).toContain("const resolved = resolveTarget(input, { urlEnv: BRANCH_URL_ENV, requireDirect: false, confirm: true });");
    expect(confirmed.indexOf("throw new Error")).toBeLessThan(confirmed.indexOf("return resolved.url;"));
    // Every exported form is the one implementation; the only unconfirmed call is the pure check, which never yields a URL.
    expect(fixture.match(/resolveTarget\(input, \{[^}]*\}\)/g)).toHaveLength(4);
    expect(fixture.match(/confirm: false/g)).toHaveLength(1);
    expect(fixture).toContain("return verdict(resolveTarget(input, { urlEnv: BRANCH_URL_ENV, requireDirect: false, confirm: false }));");
    // L3: the URL handed out is the validated string itself — the environment variable is read in exactly one place.
    expect(fixture.match(/env\[urlEnv\]/g)).toHaveLength(1);
    expect(fixture).not.toMatch(/env\[BRANCH_URL_ENV\]|env\.NEON_BRANCH_DATABASE_URL|stripQuotes/);
  });
});

describe("smoke gates never collide (static + behavior)", () => {
  it("no test reads DATABASE_URL from the environment itself — so DATABASE_URL alone activates no live suite", () => {
    const readers = testFiles("test").filter((file) => /process\.env\.DATABASE_URL|process\.env\[["']DATABASE_URL["']\]/.test(codeOf(file)));
    expect(readers).toEqual([]);
    // The three admin runners are the only files meant to use it, and they receive it only as a confirmed target
    // (test/admin/admin-target.ts): gated on their own primary gate alone, never on the presence of DATABASE_URL.
    for (const name of ["backfill-turnkey-authenticator-ids", "poll-provisioning-activity", "resolve-passkey-revocation"]) {
      const runner = codeOf(path.join("test", "admin", `${name}.admin.test.ts`));
      expect(runner, name).toContain("const target = requireAdminTarget({ env: process.env, runner: RUNNER });");
      expect(runner.match(/^const enabled = [^\n]*/m)?.[0], name).toMatch(/^const enabled = process\.env\.REAL_ADMIN_[A-Z_]+ === "1";$/);
      expect(runner, name).not.toMatch(/DATABASE_URL/);
    }
  });

  it("REAL_SMOKE_L2_INDEXES is read only by the adapter smoke, as a sub-gate under its own gate", () => {
    const readers = testFiles("test").filter((file) => /process\.env\.REAL_SMOKE_L2_INDEXES/.test(codeOf(file)));
    expect(readers).toEqual([path.join("test", "lib", "real", "neon-smoke.test.ts")]);
    const adapter = codeOf(ADAPTER_SMOKE);
    expect(adapter.match(/skipIf\(!process\.env\.REAL_SMOKE_L2_INDEXES\)/g)).toHaveLength(2); // two `it`s inside a block that is itself skipIf(!enabled)
    expect(adapter).toContain('const enabled = process.env[GATE] === "1";');
  });

  it("every live suite has its own primary gate, and each file names the gates it may run with", () => {
    const primaries = FAMILIES.map(([, gates]) => gates[0]!);
    expect(new Set(primaries).size).toBe(FAMILIES.length);
    for (const [file, gates] of FAMILIES) for (const gate of gates) expect(read(file), `${file} ${gate}`).toContain(gate);
    // ...and no suite's code names another family's primary gate as something it reads.
    for (const [file] of FAMILIES) {
      for (const [otherFile, otherGates] of FAMILIES) {
        if (otherFile !== file) expect(codeOf(file), `${file} reads ${otherGates[0]}`).not.toContain(`process.env.${otherGates[0]}`);
      }
    }
  });

  it("two families' gates in one process: BOTH refuse (branch-target suites)", () => {
    const branchFamilies = FAMILIES.filter(([file]) => file !== RACE_SMOKE);
    for (const [file, gates] of branchFamilies) {
      const own = Object.fromEntries(gates.map((gate) => [gate, "1"]));
      const base = { ...own, [BRANCH_URL_ENV]: branch, [EXPECTED_ENDPOINT_ENV]: BRANCH_ID };
      const check = (e: Env) => checkConfirmedDisposableTarget({ env: e, envLocalText: realLine(), otherEnvFiles: {}, gate: gates[0]!, allowedGates: gates });
      expect(check(base), file).toEqual({ ok: true });
      for (const [otherFile, otherGates] of FAMILIES) {
        if (otherFile === file) continue;
        expectRefused(check({ ...base, [otherGates[0]!]: "1" }), /an unrelated smoke gate is set/);
      }
      expectRefused(check({ ...base, REAL_ADMIN_BACKFILL_TURNKEY_AUTHENTICATOR_IDS: "1" }), /an admin gate is set/);
    }
  });

  it("the race suite refuses beside any other family's gate, and they refuse beside its gate or its URL variable", () => {
    for (const [file, gates] of FAMILIES) {
      if (file === RACE_SMOKE) continue;
      expectRefused(checkConfirmedDirectTarget(directInput(directEnv({ [gates[0]!]: "1" }))), /an unrelated smoke gate is set/);
    }
    expectRefused(checkConfirmedDirectTarget(directInput(directEnv({ REAL_ADMIN_POLL_COMMIT: "1" }))), /an admin gate is set/);
  });

  it("the allowed-gate lists in the files are exactly the families above", () => {
    expect(codeOf(ADAPTER_SMOKE)).toContain('const ALLOWED_GATES = [GATE, "REAL_SMOKE_PROVISIONING_DISPATCH", "REAL_SMOKE_L2_INDEXES"] as const;');
    for (const [file, gates] of DISPOSABLE_SMOKES) expect(codeOf(file), file).toContain(gates.length === 2 ? "const ALLOWED_GATES = [GATE, PUBLIC_GATE] as const;" : "const ALLOWED_GATES = [GATE] as const;");
  });
});
