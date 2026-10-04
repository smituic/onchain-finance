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
export const stripQuotes = (value: string) => value.trim().replace(/^["']|["']$/g, "");

export type TargetCheck = { ok: true } | { ok: false; reason: string };

/**
 * Proves a smoke may connect: its own gate is set, DATABASE_URL is NOT
 * exported, no admin gate and no smoke gate other than `allowedGates` is set,
 * and NEON_BRANCH_DATABASE_URL names an endpoint that differs from the real
 * database's (.env.local). Pure; never returns or logs a URL.
 */
export function checkDisposableTarget(input: { env: Record<string, string | undefined>; envLocalText: string | null; gate: string; allowedGates: readonly string[] }): TargetCheck {
  const { env, envLocalText, gate, allowedGates } = input;
  if (env[gate] !== "1") return { ok: false, reason: `${gate} is not set` };
  if (env.DATABASE_URL !== undefined) return { ok: false, reason: "DATABASE_URL is exported; this smoke only ever uses NEON_BRANCH_DATABASE_URL" };
  for (const name of Object.keys(env)) {
    if (name.startsWith("REAL_ADMIN_")) return { ok: false, reason: `an admin gate is set (${name})` };
    if (name.startsWith("REAL_SMOKE_") && !allowedGates.includes(name)) return { ok: false, reason: `an unrelated smoke gate is set (${name})` };
  }
  let branch: URL;
  try {
    branch = new URL(stripQuotes(env.NEON_BRANCH_DATABASE_URL ?? ""));
  } catch {
    return { ok: false, reason: "NEON_BRANCH_DATABASE_URL is missing or not a URL" };
  }
  if (envLocalText === null) return { ok: false, reason: ".env.local is not readable, so the real database's endpoint cannot be compared" };
  const realLine = /^DATABASE_URL=(.*)$/m.exec(envLocalText)?.[1];
  if (!realLine) return { ok: false, reason: ".env.local names no DATABASE_URL, so the real database's endpoint cannot be compared" };
  let real: URL;
  try {
    real = new URL(stripQuotes(realLine));
  } catch {
    return { ok: false, reason: ".env.local's DATABASE_URL is not a URL" };
  }
  if (!branch.hostname || branch.hostname === real.hostname) return { ok: false, reason: "the branch hostname equals the real database's hostname" };
  if (endpointId(branch.hostname) === endpointId(real.hostname)) return { ok: false, reason: "the branch endpoint equals the real database's endpoint (pooled/direct forms of the same endpoint)" };
  return { ok: true };
}

/** The ONLY way a smoke obtains its connection string: the check above, against the live environment, or a throw. */
export function requireDisposableTargetUrl(gate: string, allowedGates: readonly string[]): string {
  const check = checkDisposableTarget({ env: process.env, envLocalText: existsSync(".env.local") ? readFileSync(".env.local", "utf8") : null, gate, allowedGates });
  if (!check.ok) throw new Error(`Handles smoke refused to connect: ${check.reason}`);
  return stripQuotes(process.env.NEON_BRANCH_DATABASE_URL!);
}
