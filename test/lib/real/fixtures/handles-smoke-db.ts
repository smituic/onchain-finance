import { existsSync, readFileSync } from "node:fs";
import type { NeonDurableStores } from "@/lib/real/server/neon-store";

/**
 * TEST-ONLY access for the gated Handles smokes
 * (handles-migration.smoke.test.ts, handles-runtime.smoke.test.ts): the one
 * target-safety check both share, and the two ways they reach the database.
 * Kept behind this small interface so each harness can be dry-run offline
 * against an in-process Postgres (by aliasing this one module) before it is
 * ever pointed at Neon.
 *
 * Both connectors use the production Neon query function / adapters, so the
 * errors and outcomes the harnesses inspect are exactly what the application
 * sees over the Neon HTTP driver.
 */
export type SmokeRow = Record<string, unknown>;

export type SmokeDb = {
  /** One statement, in its own implicit transaction. */
  q(text: string, params?: unknown[]): Promise<SmokeRow[]>;
  /** Several statements in ONE transaction (so a SET LOCAL governs what follows it). Returns each statement's rows. */
  tx(statements: string[]): Promise<SmokeRow[][]>;
};

export async function connectSmokeDb(databaseUrl: string): Promise<SmokeDb> {
  const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
  const sql = createNeonSqlClient(databaseUrl);
  return {
    q: async (text, params = []) => (await sql.query(text, params)) as SmokeRow[],
    tx: async (statements) => (await sql.transaction(statements.map((text) => sql.query(text)))) as SmokeRow[][],
  };
}

/** The application's own durable stores (the exact adapters production uses), bound to the given database. */
export async function connectSmokeStores(databaseUrl: string): Promise<NeonDurableStores> {
  const { createNeonDurableStores } = await import("@/lib/real/server/neon-store");
  return createNeonDurableStores(databaseUrl);
}

const endpointId = (hostname: string) => hostname.split(".")[0]!.replace(/-pooler$/, "");

export type TargetCheck = { ok: true } | { ok: false; reason: string };
/** A passed check together with the one URL it validated. */
export type ResolvedTarget = { ok: true; url: string } | { ok: false; reason: string };

/** The application's own env files, as text: `.env.local` (null when unreadable) and any other file Next.js loads. */
export type ActiveEnvFiles = { envLocalText: string | null; otherEnvFiles?: Readonly<Record<string, string>> };
export type TargetInput = ActiveEnvFiles & { env: Record<string, string | undefined>; gate: string; allowedGates: readonly string[] };

export const BRANCH_URL_ENV = "NEON_BRANCH_DATABASE_URL";
/** The operator's own statement of which Neon endpoint the disposable branch is — supplied separately from the URL. */
export const EXPECTED_ENDPOINT_ENV = "NEON_BRANCH_EXPECTED_ENDPOINT_ID";

/**
 * Every env file Next.js loads besides `.env.local` (its documented load
 * order: `.env.$(NODE_ENV).local`, `.env.local`, `.env.$(NODE_ENV)`, `.env`,
 * with NODE_ENV one of production / development / test). `.env.example` is
 * never loaded, so it is never read here.
 */
export const OTHER_NEXT_ENV_FILES = [".env", ".env.development", ".env.development.local", ".env.production", ".env.production.local", ".env.test", ".env.test.local"] as const;

/** The env files as they are on disk. The only place a smoke reads them; nothing here is ever logged. */
export function readActiveEnvFiles(): ActiveEnvFiles {
  const otherEnvFiles: Record<string, string> = {};
  for (const file of OTHER_NEXT_ENV_FILES) if (existsSync(file)) otherEnvFiles[file] = readFileSync(file, "utf8");
  return { envLocalText: existsSync(".env.local") ? readFileSync(".env.local", "utf8") : null, otherEnvFiles };
}

/**
 * The only connection parameters a URL may carry, each with the only values
 * it may take. Anything else (options=endpoint..., host, hostaddr, port,
 * service, ...) is refused, and so is any value that could smuggle a second
 * assignment (`sslmode=require;options=...`).
 */
const ALLOWED_QUERY_PARAMETERS: Record<string, RegExp> = {
  sslmode: /^(disable|allow|prefer|require|verify-ca|verify-full)$/,
  channel_binding: /^(disable|prefer|require)$/,
  connect_timeout: /^[0-9]{1,4}$/,
};
/** The whole query string, RAW: `name=value` pairs of plain characters only — no percent-encoding, `;`, `+`, whitespace, empty value, or second `=`. */
const PLAIN_QUERY = /^(\?[a-z_]+=[a-z0-9_-]+(&[a-z_]+=[a-z0-9_-]+)*)?$/;

export type ParsedUrl = { ok: true; hostname: string; endpoint: string; pooled: boolean } | { ok: false; problem: string };

/**
 * A database URL whose effective endpoint is unambiguous, or the reason it is
 * not. `new URL` does NOT lower-case a postgres:// hostname, so case is
 * handled here: a TARGET with a mixed-case hostname is refused; the trusted
 * real URL is lower-cased for comparison (`normalizeHostname`). Never returns
 * or describes the URL's credentials.
 */
export function parseDatabaseUrl(raw: string, normalizeHostname: boolean): ParsedUrl {
  if (!raw || /[\s\\]/.test(raw)) return { ok: false, problem: "is missing or not a URL" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, problem: "is missing or not a URL" };
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return { ok: false, problem: "is not a postgres:// URL" };
  // Exactly one "@": a second one makes "which part is the host" depend on the parser.
  if (raw.split("@").length !== 2) return { ok: false, problem: 'must contain exactly one "@" (credentials, then the host)' };
  if (!normalizeHostname && url.hostname !== url.hostname.toLowerCase()) return { ok: false, problem: "has a mixed-case hostname" };
  const hostname = url.hostname.toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(hostname)) return { ok: false, problem: "has no plain DNS hostname" };
  if (url.port !== "" && url.port !== "5432") return { ok: false, problem: "names a non-default port" };
  if (!/^\/[A-Za-z0-9_-]+$/.test(url.pathname) || url.hash !== "") return { ok: false, problem: "must name exactly one database and nothing after it" };
  const unsupported = { ok: false as const, problem: `carries an unsupported or repeated connection parameter (only ${Object.keys(ALLOWED_QUERY_PARAMETERS).join(", ")} with their standard values are allowed; anything else could redirect the connection)` };
  if (!PLAIN_QUERY.test(url.search)) return unsupported;
  const seen = new Set<string>();
  for (const [name, value] of url.searchParams) {
    const allowed = Object.hasOwn(ALLOWED_QUERY_PARAMETERS, name) ? ALLOWED_QUERY_PARAMETERS[name] : undefined;
    if (!allowed || seen.has(name) || !allowed.test(value)) return unsupported;
    seen.add(name);
  }
  let credentials: string;
  try {
    credentials = `${decodeURIComponent(url.username)}\n${decodeURIComponent(url.password)}`;
  } catch {
    return { ok: false, problem: "has undecodable credentials" };
  }
  if (/(endpoint|project|options)\s*=/i.test(credentials)) return { ok: false, problem: "embeds a routing override in its credentials" };
  const label = hostname.split(".")[0]!;
  return { ok: true, hostname, endpoint: endpointId(hostname), pooled: label.endsWith("-pooler") };
}

/**
 * A line terminator other than LF or CRLF: a bare carriage return, U+2028, or
 * U+2029. The dotenv parser Next.js bundles turns a bare CR into a line break
 * and lets a definition begin right after U+2028 / U+2029, so a file holding
 * one can define DATABASE_URL where the LF-based reading below sees a comment,
 * the tail of another value, or nothing at all. Such a file is REFUSED — never
 * normalized, and its odd lines never skipped.
 */
const UNSUPPORTED_LINE_TERMINATOR = /\r(?!\n)|[\u2028\u2029]/;

/** `DATABASE_URL` as a whole name: not `MY_DATABASE_URL`, `DATABASE_URL_OLD`, or `DATABASE_URL.bak` (dotenv key characters are `\w`, `.`, `-`). */
const DATABASE_URL_TOKEN = /(?<![\w.-])DATABASE_URL(?![\w.-])/;
/** The one assignment shape this checker reads: the key, `=` or `:`, and the value, all on ONE line (`export` and indentation allowed). */
const DATABASE_URL_ASSIGNMENT = /^\s*(?:export\s+)?DATABASE_URL\s*[=:](.*)$/;

type Definitions = { ok: true; values: string[] } | { ok: false; problem: string };

/**
 * The `DATABASE_URL` definitions in an env file's text, under a STRICT SUBSET
 * of dotenv — not a reimplementation of it. Refusing an unusual file is fine;
 * reading one differently from Next.js is not, so:
 *
 *  - Only a complete single-line assignment counts (`DATABASE_URL=value` or
 *    `DATABASE_URL: value`, with or without `export` and indentation).
 *  - ANY other non-comment line that names DATABASE_URL is a refusal, never
 *    ignored. dotenv's key pattern can span lines (`DATABASE_URL`, then
 *    `=value` on a later line, is one definition to it), and such a name is
 *    always at the start of a line — so a name this function cannot read as
 *    a whole assignment is exactly a definition it might be missing.
 *  - Lines are LF / CRLF only: the caller must first refuse any text with an
 *    UNSUPPORTED_LINE_TERMINATOR.
 *
 * The values are raw (trimmed, still quoted); realDefinition() below applies
 * the rest of the subset to each. A line Next.js would NOT treat as a
 * definition (one swallowed by another variable's multi-line quoted value)
 * still counts here, which can only add a refusal.
 */
function databaseUrlDefinitions(text: string): Definitions {
  const values: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || !DATABASE_URL_TOKEN.test(line)) continue;
    const assignment = DATABASE_URL_ASSIGNMENT.exec(line);
    if (!assignment) return { ok: false, problem: "names DATABASE_URL on a line that is not one complete assignment (a declaration split across lines, or a reference to it)" };
    values.push(assignment[1]!.trim());
  }
  return { ok: true, values };
}

/** A dotenv value with its one matching pair of quotes removed; null when the quoting is unbalanced. */
export function unquoteEnvValue(value: string): string | null {
  const quote = value[0];
  if (quote === '"' || quote === "'" || quote === "`") {
    if (value.length < 2 || value[value.length - 1] !== quote) return null;
    const inner = value.slice(1, -1);
    return inner.includes(quote) ? null : inner;
  }
  return /["'`]/.test(value) ? null : value;
}

type RealTarget = { ok: true; hostname: string; endpoint: string } | { ok: false; reason: string };
type FileDefinition = { ok: true; target: { hostname: string; endpoint: string } | null } | { ok: false; reason: string; malformed?: true };

/**
 * One env file's DATABASE_URL, read under the strict subset: no definition
 * (target null), exactly one literal single-line URL, or a refusal. A value
 * holding `$` is refused outright — Next.js expands `$NAME` / `${NAME}` (in
 * any quoting) AFTER parsing, so the endpoint it ends up using need not be
 * the one written; nothing here expands, rebuilds, or looks the name up.
 */
function fileDefinition(file: string, text: string): FileDefinition {
  const definitions = databaseUrlDefinitions(text);
  if (!definitions.ok) return { ok: false, reason: `${file} ${definitions.problem}, so the real database's endpoint is ambiguous` };
  if (definitions.values.length === 0) return { ok: true, target: null };
  if (definitions.values.length > 1) return { ok: false, reason: `${file} defines DATABASE_URL more than once, so the real database's endpoint is ambiguous` };
  const raw = definitions.values[0]!;
  if (raw.includes("$")) return { ok: false, reason: `${file}'s DATABASE_URL contains "$" (variable expansion), so the real database's endpoint is ambiguous` };
  const value = unquoteEnvValue(raw);
  const parsed = value === null || value.includes("#") ? null : parseDatabaseUrl(value, true);
  if (!parsed) return { ok: false, malformed: true, reason: `${file}'s DATABASE_URL is not a URL` };
  if (!parsed.ok) return { ok: false, malformed: true, reason: parsed.problem === "is missing or not a URL" ? `${file}'s DATABASE_URL is not a URL` : `${file}'s DATABASE_URL ${parsed.problem}` };
  return { ok: true, target: { hostname: parsed.hostname, endpoint: parsed.endpoint } };
}

/**
 * The real database's endpoint, established unambiguously or not at all:
 * `.env.local` must hold exactly ONE active DATABASE_URL, and any other env
 * file Next.js loads may only repeat that same endpoint.
 */
function realTarget(files: ActiveEnvFiles): RealTarget {
  if (files.envLocalText === null) return { ok: false, reason: ".env.local is not readable, so the real database's endpoint cannot be compared" };
  // Every active env file, whether or not a DATABASE_URL is visible in it: an unsupported terminator is exactly what could hide one.
  for (const [file, text] of [[".env.local", files.envLocalText] as const, ...Object.entries(files.otherEnvFiles ?? {})]) {
    if (UNSUPPORTED_LINE_TERMINATOR.test(text)) return { ok: false, reason: `${file} contains a line terminator other than LF or CRLF (a bare carriage return, U+2028, or U+2029), so the real database's endpoint is ambiguous` };
  }
  const local = fileDefinition(".env.local", files.envLocalText);
  if (!local.ok) return local;
  if (!local.target) return { ok: false, reason: ".env.local names no DATABASE_URL, so the real database's endpoint cannot be compared" };
  for (const [file, text] of Object.entries(files.otherEnvFiles ?? {})) {
    const other = fileDefinition(file, text);
    if (!other.ok) return other.malformed ? { ok: false, reason: `${file}'s DATABASE_URL cannot be read unambiguously, so the real database's endpoint is ambiguous` } : other;
    if (other.target && other.target.endpoint !== local.target.endpoint) return { ok: false, reason: `${file} and .env.local define DATABASE_URL for different endpoints, so the real database's endpoint is ambiguous` };
  }
  return { ok: true, hostname: local.target.hostname, endpoint: local.target.endpoint };
}

/**
 * The one target check behind every exported form. In order: the suite's own
 * gate; DATABASE_URL not exported; no admin gate and no smoke gate outside
 * `allowedGates`; a target URL whose endpoint is unambiguous; the real
 * endpoint established unambiguously; the target is not the real endpoint;
 * (direct suites) the target is not pooled; (confirmed suites) the
 * operator's expected endpoint id matches exactly. Pure; never returns or
 * logs a URL, a credential, or an endpoint id.
 */
function resolveTarget(input: TargetInput, options: { urlEnv: string; requireDirect: boolean; confirm: boolean }): ResolvedTarget {
  const { env, gate, allowedGates } = input;
  const { urlEnv } = options;
  if (env[gate] !== "1") return { ok: false, reason: `${gate} is not set` };
  if (env.DATABASE_URL !== undefined) return { ok: false, reason: `DATABASE_URL is exported; this smoke only ever uses ${urlEnv}` };
  for (const name of Object.keys(env)) {
    if (name.startsWith("REAL_ADMIN_")) return { ok: false, reason: `an admin gate is set (${name})` };
    if (name.startsWith("REAL_SMOKE_") && name !== urlEnv && !allowedGates.includes(name)) return { ok: false, reason: `an unrelated smoke gate is set (${name})` };
  }
  // Canonicalized ONCE, here: surrounding whitespace and one balanced pair of quotes removed. This exact
  // string is what gets validated below and what the caller is handed — nothing re-derives it afterwards.
  const url = unquoteEnvValue((env[urlEnv] ?? "").trim());
  if (url === null) return { ok: false, reason: `${urlEnv} has unbalanced or stray quotes` };
  const target = parseDatabaseUrl(url, false);
  if (!target.ok) return { ok: false, reason: `${urlEnv} ${target.problem}` };
  const real = realTarget(input);
  if (!real.ok) return real;
  if (target.hostname === real.hostname) return { ok: false, reason: "the branch hostname equals the real database's hostname" };
  if (target.endpoint === real.endpoint) return { ok: false, reason: "the branch endpoint equals the real database's endpoint (pooled/direct forms of the same endpoint)" };
  if (options.requireDirect && target.pooled) return { ok: false, reason: `${urlEnv} points at a pooled endpoint; this suite needs the direct one` };
  if (!options.confirm) return { ok: true, url };
  const expected = env[EXPECTED_ENDPOINT_ENV];
  if (expected === undefined || expected === "") return { ok: false, reason: `${EXPECTED_ENDPOINT_ENV} is not set (read the disposable branch's endpoint id from the Neon console)` };
  if (!/^ep-[a-z0-9]+(-[a-z0-9]+)*$/.test(expected) || expected.endsWith("-pooler")) return { ok: false, reason: `${EXPECTED_ENDPOINT_ENV} is not a bare endpoint id (ep-..., without "-pooler", quotes, or a hostname)` };
  if (expected === real.endpoint) return { ok: false, reason: `${EXPECTED_ENDPOINT_ENV} names the real database's endpoint` };
  if (expected !== target.endpoint) return { ok: false, reason: `the branch endpoint does not match ${EXPECTED_ENDPOINT_ENV}` };
  return { ok: true, url };
}

/** A check's verdict without the URL — what the exported `check*` forms return. */
const verdict = (resolved: ResolvedTarget): TargetCheck => (resolved.ok ? { ok: true } : resolved);

/**
 * The target check WITHOUT operator confirmation: gate, no exported
 * DATABASE_URL, no other gate, an unambiguous NEON_BRANCH_DATABASE_URL, and
 * an endpoint that differs from the real database's. Kept for the suites'
 * own offline matrices; nothing connects on this alone — every connection
 * goes through a confirmed form below.
 */
export function checkDisposableTarget(input: TargetInput): TargetCheck {
  return verdict(resolveTarget(input, { urlEnv: BRANCH_URL_ENV, requireDirect: false, confirm: false }));
}

/**
 * checkDisposableTarget PLUS operator confirmation: NEON_BRANCH_EXPECTED_ENDPOINT_ID
 * must be a bare endpoint id (`ep-...`, never the pooled form), must not be
 * the real database's endpoint, and must equal the branch URL's endpoint
 * exactly.
 *
 * What this proves: the URL about to be used is the endpoint the operator
 * named, and is not the configured real endpoint. What it CANNOT prove: that
 * the endpoint is disposable. A URL says nothing about that, so the operator
 * must read the id from the Neon console (never copy it out of the URL).
 */
export function checkConfirmedDisposableTarget(input: TargetInput): TargetCheck {
  return verdict(resolveTarget(input, { urlEnv: BRANCH_URL_ENV, requireDirect: false, confirm: true }));
}

/**
 * The confirmed check for a suite that needs one DIRECT (non-pooled) session
 * URL in its own variable (`urlEnv`) instead of NEON_BRANCH_DATABASE_URL.
 * Same rules and the same limits on what it proves.
 */
export function checkConfirmedDirectTarget(input: TargetInput & { urlEnv: string }): TargetCheck {
  return verdict(resolveConfirmedDirectTarget(input));
}

/**
 * The same direct check, returning the confirmed URL itself: the exact string
 * that was validated, for the caller to connect with. A caller must use THIS
 * url — never its own reading of the environment variable.
 */
export function resolveConfirmedDirectTarget(input: TargetInput & { urlEnv: string }): ResolvedTarget {
  return resolveTarget(input, { urlEnv: input.urlEnv, requireDirect: true, confirm: true });
}

/** The confirmed target's connection string for the given inputs, or a throw. Reads nothing but its input. */
export function confirmedDisposableTargetUrl(input: TargetInput, refusal = "Neon smoke refused to connect"): string {
  const resolved = resolveTarget(input, { urlEnv: BRANCH_URL_ENV, requireDirect: false, confirm: true });
  if (!resolved.ok) throw new Error(`${refusal}: ${resolved.reason}`);
  return resolved.url; // the string that was validated — not a second reading of the environment
}

/** The ONLY way the adapter smoke obtains its connection string: the confirmed check against the live environment, or a throw. */
export function requireConfirmedDisposableTargetUrl(gate: string, allowedGates: readonly string[]): string {
  return confirmedDisposableTargetUrl({ env: process.env, ...readActiveEnvFiles(), gate, allowedGates });
}

/**
 * The ONLY way the disposable-branch smokes obtain their connection string.
 * It is the CONFIRMED check (Milestone 0 Pass B): the operator's
 * NEON_BRANCH_EXPECTED_ENDPOINT_ID is required here too, or it throws.
 */
export function requireDisposableTargetUrl(gate: string, allowedGates: readonly string[]): string {
  return confirmedDisposableTargetUrl({ env: process.env, ...readActiveEnvFiles(), gate, allowedGates }, "Handles smoke refused to connect");
}
