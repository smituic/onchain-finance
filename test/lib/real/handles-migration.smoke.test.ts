// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { HANDLE_PATTERN, RESERVED_HANDLES, canonicalizeHandle } from "@/lib/real/handle";
import { ACCOUNT_HANDLE_OWNER_KEY, ACCOUNT_HANDLE_PRIMARY_KEY } from "@/lib/real/server/neon-store";
import { checkDisposableTarget as checkTarget, connectSmokeDb, requireDisposableTargetUrl, type SmokeDb } from "./fixtures/handles-smoke-db";

/**
 * MANUAL, LIVE-DATABASE behavioral proof of schema.sql's Account Handles
 * migration: the challenge-purpose widening, the part-1
 * `real_accounts.display_name` ALTER, and the fail-closed "Account Handles"
 * block. Modeled on provisioning-dispatch-migration.smoke.test.ts.
 *
 * DISPOSABLE NEON BRANCH ONLY. It never reads DATABASE_URL: the target is
 * NEON_BRANCH_DATABASE_URL, and the run refuses (before any connection)
 * unless that endpoint provably differs from the real database named in
 * .env.local, DATABASE_URL is not exported, and no admin / unrelated smoke
 * gate is set. Setting DATABASE_URL alone can therefore never run this file,
 * and this file's gate runs nothing else.
 *
 * Scratch stage: throwaway schemas (`hmig_<run>_<case>`), each a copy of the
 * branch's own `public` prerequisite tables (LIKE ... INCLUDING ALL) plus
 * fixture rows, get the EXACT migration text with only its target swapped
 * (the block's `target_schema` constant; the ALTER schema-qualified; the
 * purpose block run under a scratch-only search_path). All are dropped.
 *
 * Public stage (second gate, and only if every scratch test passed): on a
 * branch whose `public` is still pre-migration, the unmodified migration text
 * is applied once, then once more for idempotence; on an already-migrated
 * branch (a re-proof of the current text) it is rerun once and must change
 * nothing. This file never claims a handle — the runtime smoke
 * (handles-runtime.smoke.test.ts) does that, on the same disposable branch.
 *
 *   REAL_SMOKE_HANDLES_MIGRATION=1 REAL_SMOKE_HANDLES_MIGRATION_PUBLIC=1 \
 *     pnpm exec vitest run test/lib/real/handles-migration.smoke.test.ts
 */
const GATE = "REAL_SMOKE_HANDLES_MIGRATION";
const PUBLIC_GATE = "REAL_SMOKE_HANDLES_MIGRATION_PUBLIC";
const enabled = process.env[GATE] === "1" && Boolean(process.env.NEON_BRANCH_DATABASE_URL);
const publicEnabled = process.env[PUBLIC_GATE] === "1";

const TABLE = "real_account_handles";
const PASSKEY_KEY = "real_passkeys_app_user_credential_key";
const ACCOUNT_FK = "real_account_handles_app_user_id_fkey";
const CLAIMER_FK = "real_account_handles_claimed_by_fkey";
const GUARD_FUNCTION = "real_account_handles_refuse_change";
const ROW_GUARD = "real_account_handles_immutable_row";
const TRUNCATE_GUARD = "real_account_handles_immutable_truncate";
const DISPLAY_NAME_CHECK = "real_accounts_display_name_check";
const REFUSED = /Account handles migration refused/;
const GUARD_MESSAGE = /real_account_handles is append-only/;
const PRE_EXISTING_PURPOSES = ["registration", "login", "backup_registration", "backup_login_verification", "backup_step_up"];

// ------------------------------------------------------------------ the exact migration text

const schemaSql = readFileSync("lib/real/server/schema.sql", "utf8");

/** 1. The challenge-purpose widening: the one DO block right after the webauthn_challenges definition. */
const purposeStart = schemaSql.indexOf("DO $$", schemaSql.indexOf("-- Batch 2g hand-applied migration: widen the purpose CHECK"));
const PURPOSE_BLOCK = schemaSql.slice(purposeStart, schemaSql.indexOf("END $$;", purposeStart) + "END $$;".length);

/** 2. Part 1: the display_name ALTER, exactly as written. */
const PART1 = /ALTER TABLE real_accounts ADD COLUMN IF NOT EXISTS display_name TEXT\s+CONSTRAINT real_accounts_display_name_check CHECK \([^;]*\);/.exec(schemaSql)?.[0] ?? "";

/** 3. The Handles block. */
const handlesBlock = schemaSql.slice(schemaSql.indexOf("-- BEGIN Account Handles"), schemaSql.indexOf("-- END Account Handles"));
const TARGET_CONSTANT = "target_schema CONSTANT pg_catalog.text := 'public';";
const HANDLES_PUBLIC = handlesBlock.slice(handlesBlock.indexOf("DO $$"));
/** The block's own column/constraint definition (everything but the two foreign keys). */
const DEFINITION = /\$definition\$([\s\S]*?)\$definition\$/.exec(handlesBlock)?.[1] ?? "";

/** The exact Handles block with only its target schema swapped. */
function handlesFor(schema: string): string {
  if (handlesBlock.split(TARGET_CONSTANT).length !== 2) throw new Error("the Handles block must contain its target constant exactly once");
  const body = handlesBlock.replace(TARGET_CONSTANT, `target_schema CONSTANT pg_catalog.text := '${schema}';`);
  if (body.includes("'public'")) throw new Error("a 'public' literal survived the target swap");
  return body.slice(body.indexOf("DO $$"));
}

/** Part 1 with only its table schema-qualified. */
function part1For(schema: string): string {
  if (PART1.split("ALTER TABLE real_accounts ").length !== 2) throw new Error("part 1 must name real_accounts exactly once");
  return PART1.replace("ALTER TABLE real_accounts ", `ALTER TABLE ${schema}.real_accounts `);
}

const SEEDED_RESERVED = RESERVED_HANDLES.filter((name) => canonicalizeHandle(name).ok).sort();

/** SHA-256 of each exact piece of migration text this run executes (the `public` form; scratch runs swap only the target). */
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const MIGRATION_SHA256 = { purposeBlock: sha256(PURPOSE_BLOCK), part1Alter: sha256(PART1), handlesBlock: sha256(HANDLES_PUBLIC) };

// ------------------------------------------------------------------ target safety (pure; checked BEFORE any connection)

const ALLOWED_GATES = [GATE, PUBLIC_GATE] as const;
/** The shared target check (fixtures/handles-smoke-db.ts), bound to this smoke's gates. */
const checkDisposableTarget = (input: { env: Record<string, string | undefined>; envLocalText: string | null }) => checkTarget({ ...input, gate: GATE, allowedGates: ALLOWED_GATES });

const scratchName = (runId: string, name: string) => `hmig_${runId}_${name}`.toLowerCase();
const VALID_UNQUOTED_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

// Offline (never gated): the harness itself.
describe("handles migration smoke harness", () => {
  it("extracts exactly the three migration components, as written in schema.sql", () => {
    expect(PURPOSE_BLOCK.startsWith("DO $$")).toBe(true);
    expect(PURPOSE_BLOCK.match(/DO \$\$/g)).toHaveLength(1);
    expect(PURPOSE_BLOCK).toContain("ALTER TABLE webauthn_challenges ADD CONSTRAINT webauthn_challenges_purpose_check");
    expect(PURPOSE_BLOCK).toContain("'backup_step_up', 'handle_claim'));");
    expect(PURPOSE_BLOCK).not.toMatch(/real_passkeys|backup_passkey_enrollments/);
    expect(schemaSql).toContain(PURPOSE_BLOCK);

    expect(PART1).toBe("ALTER TABLE real_accounts ADD COLUMN IF NOT EXISTS display_name TEXT\n  CONSTRAINT real_accounts_display_name_check CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 40);");
    expect(part1For("hmig_x")).toBe(PART1.replace("real_accounts ADD", "hmig_x.real_accounts ADD"));

    const sqlOnly = handlesBlock
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim();
    expect(sqlOnly.startsWith("DO $$")).toBe(true);
    expect(sqlOnly.endsWith("END $$;")).toBe(true);
    expect(sqlOnly.match(/\bDO \$\$/g)).toHaveLength(1);
    expect(HANDLES_PUBLIC).toContain(TARGET_CONSTANT);
    const swapped = handlesFor("hmig_test");
    expect(swapped).toContain("target_schema CONSTANT pg_catalog.text := 'hmig_test';");
    // Only the one constant differs.
    expect(swapped.replace("'hmig_test'", "'public'")).toBe(HANDLES_PUBLIC);
    expect(DEFINITION).toContain("CONSTRAINT real_account_handles_format_check");
    expect(DEFINITION).not.toMatch(/REFERENCES/);
  });

  it("the expected SQL seed is the application's reserved list minus the one name too short to store", () => {
    expect(RESERVED_HANDLES.filter((name) => !SEEDED_RESERVED.includes(name))).toEqual(["me"]);
    expect(SEEDED_RESERVED).toHaveLength(RESERVED_HANDLES.length - 1);
  });

  it("every scratch schema name is a lowercase, valid unquoted identifier", () => {
    const runId = randomUUID().replace(/-/g, "").slice(0, 8);
    for (const name of ["main", "fmt", "dn_user_collation", "h_reserved_claimed", "partial"]) expect(scratchName(runId, name)).toMatch(VALID_UNQUOTED_IDENTIFIER);
  });

  it("the gate is handle-specific: DATABASE_URL alone, or another smoke's gate, never enables this file", () => {
    const source = readFileSync("test/lib/real/handles-migration.smoke.test.ts", "utf8");
    expect(source).toContain('const enabled = process.env[GATE] === "1" && Boolean(process.env.NEON_BRANCH_DATABASE_URL);');
    expect(source.match(/process\.env\.DATABASE_URL/g)).toBeNull(); // never read as a connection target
    for (const other of ["test/lib/real/neon-smoke.test.ts", "test/lib/real/provisioning-dispatch-migration.smoke.test.ts", "test/lib/real/l2-identity-migration.smoke.test.ts", "test/lib/real/l2-identity-race.smoke.test.ts"]) {
      const text = readFileSync(other, "utf8");
      expect(text, other).not.toContain(GATE);
      expect(text, other).not.toContain("NEON_BRANCH_DATABASE_URL");
    }
  });

  describe("target safety check", () => {
    const real = "DATABASE_URL=\"postgresql://app:secret@ep-real-000001-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require\"\n";
    const branch = "postgresql://app:secret@ep-branch-000002-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require";
    const env = (extra: Record<string, string | undefined> = {}) => ({ [GATE]: "1", NEON_BRANCH_DATABASE_URL: branch, ...extra });

    it("accepts a branch whose endpoint differs from the real database's", () => {
      expect(checkDisposableTarget({ env: env(), envLocalText: real })).toEqual({ ok: true });
      expect(checkDisposableTarget({ env: env({ [PUBLIC_GATE]: "1" }), envLocalText: real })).toEqual({ ok: true });
    });

    it.each([
      ["the gate is not set", { env: { NEON_BRANCH_DATABASE_URL: branch }, envLocalText: real }],
      ["DATABASE_URL is exported (even to the branch itself)", { env: env({ DATABASE_URL: branch }), envLocalText: real }],
      ["an admin gate is set", { env: env({ REAL_ADMIN_POLL_PROVISIONING_ACTIVITY: "1" }), envLocalText: real }],
      ["an unrelated smoke gate is set", { env: env({ REAL_SMOKE_PROVISIONING_MIGRATION: "1" }), envLocalText: real }],
      ["the Handles RUNTIME smoke's gate is set (the two never run together)", { env: env({ REAL_SMOKE_HANDLES_RUNTIME: "1" }), envLocalText: real }],
      ["the branch URL is missing", { env: env({ NEON_BRANCH_DATABASE_URL: undefined }), envLocalText: real }],
      ["the branch URL is not a URL", { env: env({ NEON_BRANCH_DATABASE_URL: "not a url" }), envLocalText: real }],
      [".env.local is unreadable", { env: env(), envLocalText: null }],
      [".env.local names no DATABASE_URL", { env: env(), envLocalText: "OTHER=1\n" }],
      ["the branch IS the real database", { env: env({ NEON_BRANCH_DATABASE_URL: "postgresql://app:secret@ep-real-000001-pooler.us-east-2.aws.neon.tech/neondb" }), envLocalText: real }],
      ["the branch is the real endpoint's direct (non-pooled) form", { env: env({ NEON_BRANCH_DATABASE_URL: "postgresql://app:secret@ep-real-000001.us-east-2.aws.neon.tech/neondb" }), envLocalText: real }],
    ])("refuses when %s", (_label, input) => {
      const result = checkDisposableTarget(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).not.toMatch(/secret|postgresql:\/\//); // a reason never carries a URL
    });
  });
});

// ------------------------------------------------------------------ live

const LIVE_TIMEOUT_MS = 180_000;
type Failure = { code: string | null; constraint: string | null; message: string };

describe.skipIf(!enabled)("Account Handles migration — behavior against a DISPOSABLE Neon branch (live)", () => {
  const runId = randomUUID().replace(/-/g, "").slice(0, 8);
  const schemas = new Set<string>();
  const facts: Record<string, unknown> = { runId };
  let failures = 0;
  /** Whether the branch's `public` already carries the migration (decided by the environment probe). */
  let publicMigrated = false;
  let connection: Promise<SmokeDb> | null = null;

  /** The ONLY way this file obtains a connection: the target check runs first, every time. */
  function db(): Promise<SmokeDb> {
    if (!connection) {
      connection = connectSmokeDb(requireDisposableTargetUrl(GATE, ALLOWED_GATES));
    }
    return connection;
  }
  const q = async (text: string, params: unknown[] = []) => (await db()).q(text, params);
  const tx = async (...statements: string[]) => (await db()).tx(statements);

  /** A test that counts its own failure — the public stage runs only if this stays 0. */
  const live = (name: string, fn: () => Promise<void>) =>
    it(
      name,
      async () => {
        try {
          await fn();
        } catch (error) {
          failures += 1;
          throw error;
        }
      },
      LIVE_TIMEOUT_MS,
    );

  /** Resolves with the database's refusal; throws if the statement unexpectedly succeeded. */
  async function failure(run: Promise<unknown>): Promise<Failure> {
    try {
      await run;
    } catch (error) {
      const e = error as { code?: unknown; constraint?: unknown; message?: unknown };
      return { code: typeof e.code === "string" ? e.code : null, constraint: typeof e.constraint === "string" && e.constraint ? e.constraint : null, message: String(e.message ?? "") };
    }
    throw new Error("expected the statement to be refused, but it succeeded");
  }

  const tableOf = (schema: string) => `${schema}.${TABLE}`;

  /** Everything catalog-visible in one schema, in one round trip. Object identities are oids (as text). */
  async function snapshot(schema: string) {
    const [row] = await q(
      `SELECT
        (SELECT coalesce(json_agg(x ORDER BY x.relname), '[]')::text FROM (
          SELECT c.relname, c.relkind::text AS relkind, c.oid::text AS oid, c.relrowsecurity, c.relforcerowsecurity
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r', 'i', 'v', 'm', 'S', 'p', 'f')) x) AS classes,
        (SELECT coalesce(json_agg(x ORDER BY x.tbl, x.conname), '[]')::text FROM (
          SELECT c.relname AS tbl, k.conname, k.contype::text AS contype, k.oid::text AS oid, k.convalidated, pg_get_constraintdef(k.oid) AS def
          FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1) x) AS constraints,
        (SELECT coalesce(json_agg(x ORDER BY x.indexname), '[]')::text FROM (
          SELECT i.tablename, i.indexname, i.indexdef FROM pg_indexes i WHERE i.schemaname = $1) x) AS indexes,
        (SELECT coalesce(json_agg(x ORDER BY x.tbl, x.tgname), '[]')::text FROM (
          SELECT c.relname AS tbl, g.tgname, g.oid::text AS oid, g.tgenabled::text AS tgenabled, g.tgtype::int AS tgtype, pg_get_triggerdef(g.oid) AS def
          FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT g.tgisinternal) x) AS triggers,
        (SELECT coalesce(json_agg(x ORDER BY x.proname, x.oid), '[]')::text FROM (
          SELECT p.proname, p.oid::text AS oid, md5(p.prosrc) AS src, p.prosecdef, p.proconfig::text AS proconfig, l.lanname, p.prorettype::regtype::text AS rettype, p.pronargs::int AS pronargs
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang WHERE n.nspname = $1) x) AS functions,
        (SELECT coalesce(json_agg(x ORDER BY x.tbl, x.attnum), '[]')::text FROM (
          SELECT c.relname AS tbl, a.attnum::int AS attnum, a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull, co.collname,
                 a.attidentity::text AS attidentity, a.attgenerated::text AS attgenerated, pg_get_expr(d.adbin, d.adrelid) AS def
          FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_collation co ON co.oid = a.attcollation LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE n.nspname = $1 AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped) x) AS columns`,
      [schema],
    );
    const parse = <T>(value: unknown) => JSON.parse(String(value)) as T[];
    return {
      classes: parse<{ relname: string; relkind: string; oid: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(row!.classes),
      constraints: parse<{ tbl: string; conname: string; contype: string; oid: string; convalidated: boolean; def: string }>(row!.constraints),
      indexes: parse<{ tablename: string; indexname: string; indexdef: string }>(row!.indexes),
      triggers: parse<{ tbl: string; tgname: string; oid: string; tgenabled: string; tgtype: number; def: string }>(row!.triggers),
      functions: parse<{ proname: string; oid: string; src: string; prosecdef: boolean; proconfig: string | null; lanname: string; rettype: string; pronargs: number }>(row!.functions),
      columns: parse<{ tbl: string; attnum: number; attname: string; type: string; attnotnull: boolean; collname: string | null; attidentity: string; attgenerated: string; def: string | null }>(row!.columns),
    };
  }
  type Snapshot = Awaited<ReturnType<typeof snapshot>>;

  /** No Handles object of any kind exists in the schema. */
  function expectNoHandlesObjects(snap: Snapshot) {
    expect(snap.classes.filter((c) => c.relname.startsWith(TABLE))).toEqual([]);
    expect(snap.classes.filter((c) => c.relname === PASSKEY_KEY)).toEqual([]);
    expect(snap.constraints.filter((k) => k.conname === PASSKEY_KEY)).toEqual([]);
    expect(snap.functions.filter((f) => f.proname === GUARD_FUNCTION)).toEqual([]);
    expect(snap.triggers.filter((t) => t.tgname === ROW_GUARD || t.tgname === TRUNCATE_GUARD)).toEqual([]);
  }

  /** count + order-independent content hash of a table over a FIXED column list. */
  async function contentHash(schema: string, table: string, columns: string[]) {
    const rowText = `ROW(${columns.map((c) => `"${c}"`).join(", ")})::text`;
    const [row] = await q(`SELECT count(*)::text AS n, coalesce(md5(string_agg(md5(${rowText}), ',' ORDER BY md5(${rowText}))), '') AS h FROM ${schema}."${table}"`);
    return `${row!.n}:${row!.h}`;
  }
  async function dataHashes(schema: string, snap: Snapshot) {
    const out: Record<string, string> = {};
    for (const table of snap.classes.filter((c) => c.relkind === "r").map((c) => c.relname)) {
      out[table] = await contentHash(schema, table, snap.columns.filter((c) => c.tbl === table).map((c) => c.attname));
    }
    return out;
  }

  const ACCOUNT_COLUMNS = "(app_user_id, sub_organization_id, turnkey_user_id, wallet_id, wallet_account_id, owner_address, safe_address, account_config_version)";
  const PASSKEY_COLUMNS = "(credential_id, app_user_id, credential_public_key, user_handle, counter, status, role)";
  const A = "hs-acct-a";
  const B = "hs-acct-b";
  const C = "hs-acct-c";

  /**
   * A fresh scratch schema: copies of the branch's own `public` prerequisite
   * tables (their live, pre-migration shape), the passkey->account foreign
   * key that LIKE does not copy, and fixture accounts/passkeys.
   * `copyRows` also copies the branch's existing account/passkey rows.
   *
   * When the branch's `public` ALREADY carries the migration (a re-proof run),
   * the copies are stripped back to the pre-migration shape first — the
   * display_name column, the passkey unique key, and the widened purpose
   * CHECK are removed from the SCRATCH copies only — so every case below still
   * exercises the migration from a pre-migration starting point.
   */
  async function scratch(name: string, { copyRows = false, passkeyFk = true } = {}) {
    const schema = scratchName(runId, name);
    expect(schema).toMatch(VALID_UNQUOTED_IDENTIFIER);
    schemas.add(schema);
    const account = (id: string, n: number) => `('${id}', 'hs-sub-org-${n}', 'hs-turnkey-user-${n}', 'hs-wallet-${n}', 'hs-wallet-account-${n}', '0x${String(n).repeat(40)}', '0x${String(n + 3).repeat(40)}', 1)`;
    const passkey = (id: string, owner: string, status: string, role: string) => `('${id}', '${owner}', 'hs-cose-${id}', 'hs-user-handle-${id}', 0, '${status}', '${role}')`;
    await tx(
      `CREATE SCHEMA ${schema}`,
      `CREATE TABLE ${schema}.webauthn_challenges (LIKE public.webauthn_challenges INCLUDING ALL)`,
      `CREATE TABLE ${schema}.real_accounts (LIKE public.real_accounts INCLUDING ALL)`,
      `CREATE TABLE ${schema}.real_passkeys (LIKE public.real_passkeys INCLUDING ALL)`,
      ...(passkeyFk ? [`ALTER TABLE ${schema}.real_passkeys ADD CONSTRAINT real_passkeys_app_user_id_fkey FOREIGN KEY (app_user_id) REFERENCES ${schema}.real_accounts (app_user_id)`] : []),
      ...(copyRows ? [`INSERT INTO ${schema}.real_accounts SELECT * FROM public.real_accounts`, `INSERT INTO ${schema}.real_passkeys SELECT * FROM public.real_passkeys`] : []),
      ...(publicMigrated
        ? [
            `ALTER TABLE ${schema}.real_accounts DROP COLUMN display_name`,
            `DO $strip$ DECLARE k record; BEGIN FOR k IN SELECT c.conname FROM pg_catalog.pg_constraint c WHERE c.conrelid = '${schema}.real_passkeys'::regclass AND c.contype = 'u' AND pg_catalog.pg_get_constraintdef(c.oid) = 'UNIQUE (app_user_id, credential_id)' LOOP EXECUTE format('ALTER TABLE ${schema}.real_passkeys DROP CONSTRAINT %I', k.conname); END LOOP; END $strip$`,
            `ALTER TABLE ${schema}.webauthn_challenges DROP CONSTRAINT webauthn_challenges_purpose_check, ADD CONSTRAINT webauthn_challenges_purpose_check CHECK (purpose IN (${PRE_EXISTING_PURPOSES.map((p) => `'${p}'`).join(", ")}))`,
          ]
        : []),
      `INSERT INTO ${schema}.real_accounts ${ACCOUNT_COLUMNS} VALUES ${account(A, 1)}, ${account(B, 2)}, ${account(C, 3)}`,
      `INSERT INTO ${schema}.real_passkeys ${PASSKEY_COLUMNS} VALUES ${passkey("hs-cred-a", A, "active", "primary")}, ${passkey("hs-cred-a2", A, "active", "backup")}, ${passkey("hs-cred-b", B, "active", "primary")}, ${passkey("hs-cred-c", C, "revoked", "primary")}, ${passkey("hs-cred-c2", C, "pending", "backup")}, ${passkey("hs-cred-c3", C, "revoking", "backup")}`,
    );
    return schema;
  }

  const applyPurpose = (schema: string) => tx(`SET LOCAL search_path = ${schema}, pg_catalog`, PURPOSE_BLOCK);
  const applyPart1 = (schema: string) => q(part1For(schema));
  const applyHandles = (schema: string) => q(handlesFor(schema));
  /** The intended order: purpose widening, part 1, the Handles block. */
  async function applyAll(schema: string) {
    await applyPurpose(schema);
    await applyPart1(schema);
    await applyHandles(schema);
  }

  /** The adapter's own claim statement (neon-store.ts), schema-qualified. Returns the inserted rows. */
  const claim = (schema: string, handle: string, appUserId: string, credentialId: string) =>
    q(
      `INSERT INTO ${tableOf(schema)} (handle, kind, app_user_id, claimed_by_credential_id)
       SELECT $1, 'claimed', p.app_user_id, p.credential_id FROM ${schema}.real_passkeys p
       WHERE p.credential_id = $2 AND p.app_user_id = $3 AND p.status = 'active' RETURNING handle`,
      [handle, credentialId, appUserId],
    );

  /** Independent verification of the final structure in `schema` — used for the clean scratch apply, the recovered partial apply, and `public`. */
  async function verifyStructure(schema: string) {
    const snap = await snapshot(schema);
    const ref = `(?:${schema}\\.)?`;

    // real_accounts.display_name
    const displayName = snap.columns.find((c) => c.tbl === "real_accounts" && c.attname === "display_name");
    expect(displayName).toMatchObject({ type: "text", attnotnull: false, collname: "default", attidentity: "", attgenerated: "", def: null });
    const displayNameCheck = snap.constraints.find((k) => k.tbl === "real_accounts" && k.conname === DISPLAY_NAME_CHECK);
    expect(displayNameCheck).toMatchObject({ contype: "c", convalidated: true });
    expect(displayNameCheck!.def).toContain("display_name IS NULL");
    expect(displayNameCheck!.def).toContain("char_length(display_name) >= 1");
    expect(displayNameCheck!.def).toContain("char_length(display_name) <= 40");

    // The key the composite foreign key references.
    expect(snap.constraints.find((k) => k.tbl === "real_passkeys" && k.conname === PASSKEY_KEY)).toMatchObject({ contype: "u", convalidated: true, def: "UNIQUE (app_user_id, credential_id)" });

    // Columns.
    expect(snap.columns.filter((c) => c.tbl === TABLE).map((c) => ({ name: c.attname, type: c.type, notNull: c.attnotnull, collation: c.collname, def: c.def }))).toEqual([
      { name: "handle", type: "text", notNull: true, collation: "C", def: null },
      { name: "kind", type: "text", notNull: true, collation: "default", def: null },
      { name: "app_user_id", type: "text", notNull: false, collation: "default", def: null },
      { name: "claimed_by_credential_id", type: "text", notNull: false, collation: "default", def: null },
      { name: "created_at", type: "timestamp with time zone", notNull: true, collation: null, def: "now()" },
    ]);

    // Constraints (NOT NULL constraints, where the server catalogs them, are covered by the columns above).
    const keys = snap.constraints.filter((k) => k.tbl === TABLE && k.contype !== "n");
    expect(keys.map((k) => k.conname).sort()).toEqual(
      ["real_account_handles_pkey", "real_account_handles_app_user_id_key", "real_account_handles_kind_check", "real_account_handles_format_check", "real_account_handles_owner_check", ACCOUNT_FK, CLAIMER_FK].sort(),
    );
    for (const key of keys) expect(key.convalidated, key.conname).toBe(true);
    const def = (name: string) => keys.find((k) => k.conname === name)!.def;
    expect(def("real_account_handles_pkey")).toBe("PRIMARY KEY (handle)");
    expect(def("real_account_handles_app_user_id_key")).toBe("UNIQUE (app_user_id)");
    expect(def("real_account_handles_kind_check")).toMatch(/'reserved'.*'claimed'/);
    const format = def("real_account_handles_format_check");
    expect(format).toContain("octet_length(handle) = char_length(handle)");
    expect(format).toMatch(/char_length\(handle\) >= 3/);
    expect(format).toMatch(/char_length\(handle\) <= 20/);
    expect(format).toContain('COLLATE "C"');
    expect(format).toContain(`'${HANDLE_PATTERN.source}'`);
    const owner = def("real_account_handles_owner_check");
    expect(owner).toMatch(/kind = 'reserved'.*app_user_id IS NULL.*claimed_by_credential_id IS NULL/);
    expect(owner).toMatch(/kind = 'claimed'.*app_user_id IS NOT NULL.*claimed_by_credential_id IS NOT NULL/);
    // NO ACTION is the default and is not printed: an exact match also proves there is no ON UPDATE / ON DELETE clause.
    expect(def(ACCOUNT_FK)).toMatch(new RegExp(`^FOREIGN KEY \\(app_user_id\\) REFERENCES ${ref}real_accounts\\(app_user_id\\)$`));
    expect(def(CLAIMER_FK)).toMatch(new RegExp(`^FOREIGN KEY \\(app_user_id, claimed_by_credential_id\\) REFERENCES ${ref}real_passkeys\\(app_user_id, credential_id\\)$`));
    const fks = await q(
      `SELECT k.conname, k.confupdtype::text AS upd, k.confdeltype::text AS del, k.confmatchtype::text AS match, k.condeferrable, rc.relname AS ref_table,
              (SELECT r.conname FROM pg_constraint r WHERE r.conindid = k.conindid AND r.conrelid = k.confrelid AND r.contype IN ('p', 'u')) AS ref_key
       FROM pg_constraint k JOIN pg_class rc ON rc.oid = k.confrelid WHERE k.conrelid = $1::regclass AND k.contype = 'f' ORDER BY k.conname`,
      [tableOf(schema)],
    );
    expect(fks).toEqual([
      { conname: ACCOUNT_FK, upd: "a", del: "a", match: "s", condeferrable: false, ref_table: "real_accounts", ref_key: "real_accounts_pkey" },
      { conname: CLAIMER_FK, upd: "a", del: "a", match: "s", condeferrable: false, ref_table: "real_passkeys", ref_key: PASSKEY_KEY },
    ]);

    // Indexes: only the two constraint-backing ones.
    expect(snap.indexes.filter((i) => i.tablename === TABLE).map((i) => i.indexname).sort()).toEqual(["real_account_handles_app_user_id_key", "real_account_handles_pkey"]);
    const table = snap.classes.find((c) => c.relname === TABLE);
    expect(table).toMatchObject({ relkind: "r", relrowsecurity: false, relforcerowsecurity: false });

    // Guards.
    const guard = snap.functions.filter((f) => f.proname === GUARD_FUNCTION);
    expect(guard).toHaveLength(1);
    expect(guard[0]).toMatchObject({ prosecdef: false, proconfig: null, lanname: "plpgsql", rettype: "trigger", pronargs: 0 });
    const triggers = snap.triggers.filter((t) => t.tbl === TABLE);
    expect(triggers.map((t) => ({ name: t.tgname, type: t.tgtype, enabled: t.tgenabled }))).toEqual([
      { name: ROW_GUARD, type: 27, enabled: "O" },
      { name: TRUNCATE_GUARD, type: 34, enabled: "O" },
    ]);
    expect(triggers[0]!.def).toMatch(/BEFORE DELETE OR UPDATE ON .* FOR EACH ROW EXECUTE FUNCTION .*real_account_handles_refuse_change\(\)$/);
    expect(triggers[1]!.def).toMatch(/BEFORE TRUNCATE ON .* FOR EACH STATEMENT EXECUTE FUNCTION .*real_account_handles_refuse_change\(\)$/);

    // Reserved seeds: exactly the expected set, all `reserved`, no owner. 'me' is not seeded.
    const reserved = await q(`SELECT handle, kind, app_user_id, claimed_by_credential_id FROM ${tableOf(schema)} WHERE kind = 'reserved' ORDER BY handle`);
    expect(reserved.map((r) => r.handle)).toEqual(SEEDED_RESERVED);
    for (const row of reserved) expect(row).toMatchObject({ kind: "reserved", app_user_id: null, claimed_by_credential_id: null });
    expect(reserved.map((r) => r.handle)).not.toContain("me");
    return snap;
  }

  /** Running `run` must be refused, and leave the schema's whole catalog EXACTLY as it was. */
  async function expectRefusedUnchanged(schema: string, run: () => Promise<unknown>, why: RegExp) {
    const before = await snapshot(schema);
    const refusal = await failure(run());
    expect(refusal.message).toMatch(why);
    expect(await snapshot(schema)).toEqual(before);
    return { before, refusal };
  }

  afterAll(async () => {
    try {
      for (const schema of schemas) await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      const left = await q(`SELECT nspname FROM pg_namespace WHERE nspname LIKE $1`, [`hmig\\_${runId}\\_%`]);
      facts.scratchSchemasLeft = left.length;
      const [activity] = await q(
        `SELECT (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state LIKE 'idle in transaction%') AS idle_in_transaction,
                (SELECT count(*)::int FROM pg_locks WHERE NOT granted) AS ungranted_locks,
                (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname LIKE 'pg_temp%' AND c.relname LIKE 'real_account%reference') AS leftover_reference_tables`,
      );
      facts.cleanup = activity;
      facts.failures = failures;
      expect(left).toEqual([]);
      expect(activity).toEqual({ idle_in_transaction: 0, ungranted_locks: 0, leftover_reference_tables: 0 });
    } finally {
      const path = process.env.HANDLES_SMOKE_FACTS_PATH;
      if (path) writeFileSync(path, `${JSON.stringify(facts, null, 2)}\n`);
      console.log(`HANDLES_SMOKE_FACTS ${JSON.stringify(facts)}`);
    }
  }, LIVE_TIMEOUT_MS);

  // ================================================================ 1. environment

  live("environment probe: server, role, privileges, and the branch's public prerequisites (recorded, no secrets)", async () => {
    const [env] = await q(
      `SELECT version() AS version, current_setting('server_version') AS server_version, current_user::text AS role, session_user::text AS session_role,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS rolsuper,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS rolbypassrls,
              (SELECT rolreplication FROM pg_roles WHERE rolname = current_user) AS rolreplication,
              (SELECT coalesce(string_agg(g.rolname, ',' ORDER BY g.rolname), '') FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles me ON me.oid = m.member WHERE me.rolname = current_user) AS member_of,
              has_database_privilege(current_user, current_database(), 'TEMP') AS temp_privilege,
              has_database_privilege(current_user, current_database(), 'CREATE') AS create_privilege,
              current_setting('search_path') AS search_path, current_schema()::text AS current_schema,
              current_setting('session_replication_role') AS session_replication_role,
              (SELECT to_jsonb(d) ->> 'datcollate' FROM pg_database d WHERE d.datname = current_database()) AS datcollate,
              (SELECT to_jsonb(d) ->> 'datlocprovider' FROM pg_database d WHERE d.datname = current_database()) AS datlocprovider`,
    );
    facts.environment = env;
    facts.migrationSha256 = MIGRATION_SHA256;
    const owners = await q(
      `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, (pg_get_userbyid(c.relowner) = current_user::text) AS owned_by_current_role
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`,
    );
    facts.publicTableOwners = owners;
    const names = owners.map((o) => o.relname);
    for (const required of ["webauthn_challenges", "real_accounts", "real_passkeys"]) expect(names, `public.${required} must exist on the branch`).toContain(required);
    // The branch's public is in exactly one of two states: PRE-migration (a first apply), or ALREADY migrated and unused (a re-proof).
    const pre = await snapshot("public");
    publicMigrated = pre.classes.some((c) => c.relname === TABLE);
    facts.publicState = publicMigrated ? "already migrated" : "pre-migration";
    if (publicMigrated) {
      await verifyStructure("public");
      expect(await q(`SELECT kind, count(*)::int AS n FROM public.${TABLE} GROUP BY kind`)).toEqual([{ kind: "reserved", n: SEEDED_RESERVED.length }]); // 43 reserved, ZERO claimed
    } else {
      expectNoHandlesObjects(pre);
      expect(pre.columns.filter((c) => c.tbl === "real_accounts" && c.attname === "display_name")).toEqual([]);
    }
    expect(env!.current_schema).toBe("public");
    facts.publicPurposeCheckBefore = pre.constraints.filter((k) => k.tbl === "webauthn_challenges" && k.contype === "c").map((k) => ({ conname: k.conname, def: k.def }));
  });

  // ================================================================ 2 + 3. clean scratch apply, catalog

  const mainRowHashBefore: Record<string, string> = {};
  const mainColumnsBefore: Record<string, string[]> = {};

  live("clean scratch apply: purpose widening, part 1, the Handles block — in order; existing rows untouched", async () => {
    const schema = await scratch("main", { copyRows: true });
    const before = await snapshot(schema);
    expectNoHandlesObjects(before);
    // Whatever the branch's public looks like, the scratch copy starts in the PRE-migration shape.
    expect(before.columns.filter((c) => c.tbl === "real_accounts" && c.attname === "display_name")).toEqual([]);
    expect(before.constraints.filter((k) => k.tbl === "real_passkeys" && k.def === "UNIQUE (app_user_id, credential_id)")).toEqual([]);
    expect(before.constraints.filter((k) => k.tbl === "webauthn_challenges" && k.contype === "c").map((k) => k.def.includes("'handle_claim'"))).toEqual([false]);
    for (const table of ["real_accounts", "real_passkeys", "webauthn_challenges"]) {
      mainColumnsBefore[table] = before.columns.filter((c) => c.tbl === table).map((c) => c.attname);
      mainRowHashBefore[table] = await contentHash(schema, table, mainColumnsBefore[table]!);
    }
    facts.scratchRowCountsBefore = Object.fromEntries(Object.entries(mainRowHashBefore).map(([table, value]) => [table, value.split(":")[0]]));

    await applyPurpose(schema);
    await applyPart1(schema);
    const afterPart1 = await snapshot(schema);
    expectNoHandlesObjects(afterPart1); // part 1 creates nothing but the column and its CHECK
    expect(afterPart1.columns.find((c) => c.tbl === "real_accounts" && c.attname === "display_name")).toMatchObject({ type: "text", attnotnull: false, def: null });
    await applyHandles(schema);

    for (const table of ["real_accounts", "real_passkeys", "webauthn_challenges"]) {
      expect(await contentHash(schema, table, mainColumnsBefore[table]!), table).toBe(mainRowHashBefore[table]);
    }
    const [nulls] = await q(`SELECT count(*)::int AS n FROM ${schema}.real_accounts WHERE display_name IS NOT NULL`);
    expect(nulls!.n).toBe(0);
    // The reference copies lived only inside the migration's own transaction.
    expect(await q(`SELECT c.relname FROM pg_class c WHERE c.relname IN ('real_account_handles_reference', 'real_accounts_display_name_reference')`)).toEqual([]);
  });

  live("challenge purposes: every pre-existing purpose and handle_claim are accepted; an unknown purpose is refused", async () => {
    const schema = scratchName(runId, "main");
    for (const purpose of [...PRE_EXISTING_PURPOSES, "handle_claim"]) {
      await q(`INSERT INTO ${schema}.webauthn_challenges (challenge, purpose, expires_at) VALUES ($1, $2, now() + interval '5 minutes')`, [`hs-challenge-${purpose}`, purpose]);
    }
    const unknown = await failure(q(`INSERT INTO ${schema}.webauthn_challenges (challenge, purpose, expires_at) VALUES ('hs-challenge-x', 'handle_claim_x', now())`));
    expect(unknown).toMatchObject({ code: "23514", constraint: "webauthn_challenges_purpose_check" });
    const checks = (await snapshot(schema)).constraints.filter((k) => k.tbl === "webauthn_challenges" && k.contype === "c");
    expect(checks.map((k) => k.conname)).toEqual(["webauthn_challenges_purpose_check"]);
    expect(checks[0]!.def).toContain("'handle_claim'");
    facts.purposeUnknownRefusal = unknown.code;
  });

  live("catalog structure, independently read: display_name, the handle column, kind/owner, keys, both foreign keys, guards, reserved seeds", async () => {
    const schema = scratchName(runId, "main");
    const snap = await verifyStructure(schema);
    facts.scratchStructure = {
      handleColumn: snap.columns.find((c) => c.tbl === TABLE && c.attname === "handle"),
      formatCheck: snap.constraints.find((k) => k.conname === "real_account_handles_format_check")?.def,
      ownerCheck: snap.constraints.find((k) => k.conname === "real_account_handles_owner_check")?.def,
      kindCheck: snap.constraints.find((k) => k.conname === "real_account_handles_kind_check")?.def,
      displayNameCheck: snap.constraints.find((k) => k.conname === DISPLAY_NAME_CHECK)?.def,
      triggers: snap.triggers.filter((t) => t.tbl === TABLE).map((t) => ({ tgname: t.tgname, tgenabled: t.tgenabled, tgtype: t.tgtype, def: t.def.replace(new RegExp(schema, "g"), "<schema>") })),
      guardFunction: snap.functions.filter((f) => f.proname === GUARD_FUNCTION).map((f) => ({ prosecdef: f.prosecdef, proconfig: f.proconfig, lanname: f.lanname, rettype: f.rettype, pronargs: f.pronargs })),
      pkeyIndex: snap.indexes.find((i) => i.indexname === "real_account_handles_pkey")?.indexdef.replace(new RegExp(schema, "g"), "<schema>"),
      reservedCount: SEEDED_RESERVED.length,
    };
  });

  // ================================================================ 4. format behavior

  live("format: the database refuses exactly what the application validator refuses, and accepts canonical handles", async () => {
    const schema = await scratch("fmt");
    await applyAll(schema);
    const insertReserved = (handle: string) => q(`INSERT INTO ${tableOf(schema)} (handle, kind) VALUES ($1, 'reserved')`, [handle]);

    const kelvin = String.fromCodePoint(0x212a);
    const eAcute = String.fromCodePoint(0xe9);
    const rejected: Array<[string, string]> = [
      ["uppercase", "Smit"],
      ["a lone e-acute", eAcute],
      ["e-acute inside three characters", `sm${eAcute}`],
      ["multibyte (CJK)", String.fromCodePoint(0x65e5, 0x672c, 0x8a9e)],
      ["multibyte (emoji)", `smit${String.fromCodePoint(0x1f600)}`],
      ["Kelvin sign", `${kelvin}evin`],
      ["dotless i", `sm${String.fromCodePoint(0x131)}t`],
      ["fullwidth Latin", String.fromCodePoint(0xff53, 0xff4d, 0xff49, 0xff54)],
      ["Cyrillic a", `${String.fromCodePoint(0x430)}dmin`],
      ["leading underscore", "_ab"],
      ["trailing underscore", "ab_"],
      ["consecutive underscores", "a__b"],
      ["two characters", "ab"],
      ["twenty-one characters", "a".repeat(21)],
      ["leading digit", "1abc"],
      ["address-shaped", "0xabc"],
      ["a leading @", "@smit"],
      ["a space", "sm it"],
      ["a hyphen", "sm-it"],
      ["a trailing newline", "smit\n"],
      ["an empty string", ""],
    ];
    const sqlstates = new Set<string>();
    for (const [label, handle] of rejected) {
      const validated = canonicalizeHandle(handle);
      expect(validated.ok && validated.handle === handle, `${label}: the application validator must not accept this as-is`).toBe(false);
      const refusal = await failure(insertReserved(handle));
      expect(refusal, label).toMatchObject({ code: "23514", constraint: "real_account_handles_format_check" });
      sqlstates.add(refusal.code!);
    }
    facts.formatCheckSqlstate = [...sqlstates];

    const accepted = ["abc", "smit", "a1b2", "maya_chen", "a_b_c", "x9_9x", "a".repeat(20), "pau1", "paul"];
    for (const handle of accepted) {
      expect(canonicalizeHandle(handle)).toEqual({ ok: true, handle });
      expect(await insertReserved(handle)).toEqual([]);
    }
    const [count] = await q(`SELECT count(*)::int AS n FROM ${tableOf(schema)} WHERE handle = ANY($1::text[])`, [accepted]);
    expect(count!.n).toBe(accepted.length);

    // kind / owner CHECKs.
    expect(await failure(q(`INSERT INTO ${tableOf(schema)} (handle, kind) VALUES ('kindtest', 'other')`))).toMatchObject({ code: "23514", constraint: "real_account_handles_kind_check" });
    expect(await failure(q(`INSERT INTO ${tableOf(schema)} (handle, kind) VALUES ('ownertest', 'claimed')`))).toMatchObject({ code: "23514", constraint: "real_account_handles_owner_check" });
    expect(await failure(q(`INSERT INTO ${tableOf(schema)} (handle, kind, app_user_id) VALUES ('ownertest', 'claimed', '${A}')`))).toMatchObject({ code: "23514", constraint: "real_account_handles_owner_check" });
    expect(await failure(q(`INSERT INTO ${tableOf(schema)} (handle, kind, app_user_id, claimed_by_credential_id) VALUES ('ownertest', 'reserved', '${A}', 'hs-cred-a')`))).toMatchObject({ code: "23514", constraint: "real_account_handles_owner_check" });
    expect(await failure(q(`INSERT INTO ${tableOf(schema)} (handle) VALUES ('nokind')`))).toMatchObject({ code: "23502" });
    // Uniqueness is exact-byte under "C": a reserved name can't be re-inserted.
    expect(await failure(insertReserved("admin"))).toMatchObject({ code: "23505", constraint: ACCOUNT_HANDLE_PRIMARY_KEY });
  });

  // ================================================================ 6. relational behavior (before the immutability checks, so claimed rows exist)

  live("claims: the adapter's INSERT ... SELECT, both 23505 constraints by exact name, 23503 on every foreign key, zero rows for a non-active passkey", async () => {
    const schema = scratchName(runId, "main");
    // Zero rows — never an error — when the credential is not an ACTIVE passkey of that account.
    for (const [credential, owner] of [["hs-cred-c", C], ["hs-cred-c2", C], ["hs-cred-c3", C], ["hs-cred-b", A], ["no-such-credential", A], ["hs-cred-a", "no-such-account"]] as const) {
      expect(await claim(schema, "hs_nobody", owner, credential), `${credential} / ${owner}`).toEqual([]);
    }
    expect(await q(`SELECT 1 FROM ${tableOf(schema)} WHERE handle = 'hs_nobody'`)).toEqual([]);

    expect(await claim(schema, "hs_alpha", A, "hs-cred-a")).toEqual([{ handle: "hs_alpha" }]);
    expect(await q(`SELECT handle, kind, app_user_id, claimed_by_credential_id FROM ${tableOf(schema)} WHERE handle = 'hs_alpha'`)).toEqual([{ handle: "hs_alpha", kind: "claimed", app_user_id: A, claimed_by_credential_id: "hs-cred-a" }]);

    // Another account, same handle -> the primary key, by exact name, in the driver's `.constraint`.
    const taken = await failure(claim(schema, "hs_alpha", B, "hs-cred-b"));
    expect(taken).toMatchObject({ code: "23505", constraint: ACCOUNT_HANDLE_PRIMARY_KEY });
    expect(taken.constraint).toBe("real_account_handles_pkey");
    // The same account, a second handle -> the owner key, by exact name.
    const second = await failure(claim(schema, "hs_beta", A, "hs-cred-a2"));
    expect(second).toMatchObject({ code: "23505", constraint: ACCOUNT_HANDLE_OWNER_KEY });
    expect(second.constraint).toBe("real_account_handles_app_user_id_key");
    // The same account, the same handle (the lost-response retry): one of the two — recorded.
    const retry = await failure(claim(schema, "hs_alpha", A, "hs-cred-a"));
    expect(retry.code).toBe("23505");
    expect([ACCOUNT_HANDLE_PRIMARY_KEY, ACCOUNT_HANDLE_OWNER_KEY]).toContain(retry.constraint);
    // A reserved name is taken, too.
    expect(await failure(claim(schema, "admin", B, "hs-cred-b"))).toMatchObject({ code: "23505", constraint: ACCOUNT_HANDLE_PRIMARY_KEY });
    facts.uniqueViolations = { otherAccountSameHandle: taken.constraint, sameAccountSecondHandle: second.constraint, sameAccountSameHandle: retry.constraint, driverExposesConstraintField: true };

    // Composite foreign key: a credential that belongs to ANOTHER account.
    const crossAccount = await failure(q(`INSERT INTO ${tableOf(schema)} (handle, kind, app_user_id, claimed_by_credential_id) VALUES ('hs_gamma', 'claimed', '${B}', 'hs-cred-a')`));
    expect(crossAccount).toMatchObject({ code: "23503", constraint: CLAIMER_FK });
    const noAccount = await failure(q(`INSERT INTO ${tableOf(schema)} (handle, kind, app_user_id, claimed_by_credential_id) VALUES ('hs_gamma', 'claimed', 'no-such-account', 'hs-cred-a')`));
    expect(noAccount.code).toBe("23503");
    expect([ACCOUNT_FK, CLAIMER_FK]).toContain(noAccount.constraint);

    // NO ACTION: neither the owning account nor the claiming passkey can be deleted or re-keyed.
    const deleteAccount = await failure(q(`DELETE FROM ${schema}.real_accounts WHERE app_user_id = '${A}'`));
    expect(deleteAccount.code).toBe("23503");
    const deletePasskey = await failure(q(`DELETE FROM ${schema}.real_passkeys WHERE credential_id = 'hs-cred-a'`));
    expect(deletePasskey).toMatchObject({ code: "23503", constraint: CLAIMER_FK });
    const rekeyPasskey = await failure(q(`UPDATE ${schema}.real_passkeys SET app_user_id = '${B}' WHERE credential_id = 'hs-cred-a'`));
    expect(rekeyPasskey).toMatchObject({ code: "23503", constraint: CLAIMER_FK });
    const rekeyAccount = await failure(q(`UPDATE ${schema}.real_accounts SET app_user_id = 'hs-acct-renamed' WHERE app_user_id = '${A}'`));
    expect(rekeyAccount.code).toBe("23503");
    facts.foreignKeyViolations = { crossAccountCredential: crossAccount.constraint, unknownAccount: noAccount.constraint, deleteAccount: deleteAccount.constraint, deletePasskey: deletePasskey.constraint, rekeyPasskey: rekeyPasskey.constraint, rekeyAccount: rekeyAccount.constraint };
    // The row survived all of it.
    expect(await q(`SELECT app_user_id, claimed_by_credential_id FROM ${tableOf(schema)} WHERE handle = 'hs_alpha'`)).toEqual([{ app_user_id: A, claimed_by_credential_id: "hs-cred-a" }]);

    // A passkey's STATUS may still change (revocation is by status, never by delete) — the key columns are what the foreign key guards.
    expect(await q(`UPDATE ${schema}.real_passkeys SET status = 'revoking' WHERE credential_id = 'hs-cred-a' RETURNING status`)).toEqual([{ status: "revoking" }]);
    expect(await q(`UPDATE ${schema}.real_accounts SET display_name = 'Hs Alpha' WHERE app_user_id = '${A}' RETURNING display_name`)).toEqual([{ display_name: "Hs Alpha" }]);
    expect(await failure(q(`UPDATE ${schema}.real_accounts SET display_name = $1 WHERE app_user_id = '${A}'`, ["x".repeat(41)]))).toMatchObject({ code: "23514", constraint: DISPLAY_NAME_CHECK });
    expect(await failure(q(`UPDATE ${schema}.real_accounts SET display_name = '' WHERE app_user_id = '${A}'`))).toMatchObject({ code: "23514", constraint: DISPLAY_NAME_CHECK });
  });

  live("deleting an account that owns a handle is refused BY THE HANDLE'S OWN foreign key (a schema without the passkey->account key isolates it)", async () => {
    const schema = await scratch("acctfk", { passkeyFk: false });
    await applyAll(schema);
    expect(await claim(schema, "hs_alpha", A, "hs-cred-a")).toEqual([{ handle: "hs_alpha" }]);
    const refusal = await failure(q(`DELETE FROM ${schema}.real_accounts WHERE app_user_id = '${A}'`));
    expect(refusal).toMatchObject({ code: "23503", constraint: ACCOUNT_FK });
    // An account with no handle is unaffected by the registry.
    expect(await q(`DELETE FROM ${schema}.real_passkeys WHERE app_user_id = '${C}' RETURNING credential_id`)).toHaveLength(3);
    expect(await q(`DELETE FROM ${schema}.real_accounts WHERE app_user_id = '${C}' RETURNING app_user_id`)).toEqual([{ app_user_id: C }]);
  });

  // ================================================================ 5. immutability

  live("immutability: UPDATE, DELETE, and TRUNCATE each raise the guard — for reserved and claimed rows alike; re-seeding fires nothing", async () => {
    const schema = scratchName(runId, "main");
    const before = await contentHash(schema, TABLE, ["handle", "kind", "app_user_id", "claimed_by_credential_id", "created_at"]);
    const attempts: Array<[string, string]> = [
      ["UPDATE a reserved row", `UPDATE ${tableOf(schema)} SET kind = 'claimed', app_user_id = '${B}', claimed_by_credential_id = 'hs-cred-b' WHERE handle = 'admin'`],
      ["UPDATE a claimed row's handle", `UPDATE ${tableOf(schema)} SET handle = 'hs_renamed' WHERE handle = 'hs_alpha'`],
      ["UPDATE a claimed row's owner", `UPDATE ${tableOf(schema)} SET app_user_id = '${B}', claimed_by_credential_id = 'hs-cred-b' WHERE handle = 'hs_alpha'`],
      ["a no-op UPDATE", `UPDATE ${tableOf(schema)} SET kind = kind WHERE handle = 'admin'`],
      ["UPDATE every row", `UPDATE ${tableOf(schema)} SET created_at = now()`],
      ["DELETE a reserved row", `DELETE FROM ${tableOf(schema)} WHERE handle = 'admin'`],
      ["DELETE a claimed row", `DELETE FROM ${tableOf(schema)} WHERE handle = 'hs_alpha'`],
      ["DELETE every row", `DELETE FROM ${tableOf(schema)}`],
      ["TRUNCATE", `TRUNCATE ${tableOf(schema)}`],
      ["TRUNCATE ... CASCADE", `TRUNCATE ${tableOf(schema)} CASCADE`],
    ];
    const guardStates = new Set<string>();
    for (const [label, statement] of attempts) {
      const refusal = await failure(q(statement));
      expect(refusal.message, label).toMatch(GUARD_MESSAGE);
      guardStates.add(String(refusal.code));
    }
    facts.guardSqlstate = [...guardStates];
    expect([...guardStates]).toEqual(["P0001"]);
    // An INSERT ... ON CONFLICT DO UPDATE is an update too.
    expect((await failure(q(`INSERT INTO ${tableOf(schema)} (handle, kind) VALUES ('admin', 'reserved') ON CONFLICT (handle) DO UPDATE SET created_at = now()`))).message).toMatch(GUARD_MESSAGE);
    expect(await contentHash(schema, TABLE, ["handle", "kind", "app_user_id", "claimed_by_credential_id", "created_at"])).toBe(before);

    // Re-running the block re-seeds with ON CONFLICT DO NOTHING: no guard fires, nothing changes.
    await applyHandles(schema);
    expect(await contentHash(schema, TABLE, ["handle", "kind", "app_user_id", "claimed_by_credential_id", "created_at"])).toBe(before);
  });

  // ================================================================ session_replication_role (recorded either way)

  live("session_replication_role: whether this role may set it, and whether the guards still fire under 'replica' (a recorded residual)", async () => {
    const schema = await scratch("repl");
    await applyAll(schema);
    await claim(schema, "hs_alpha", A, "hs-cred-a");
    const REPLICA = "SET LOCAL session_replication_role = replica";
    const result: Record<string, unknown> = {};
    try {
      const rows = await tx(REPLICA, "SELECT current_setting('session_replication_role') AS v");
      result.setPermitted = rows[1]?.[0]?.v === "replica";
    } catch (error) {
      const e = error as { code?: unknown; message?: unknown };
      result.setPermitted = false;
      result.setRefusal = { code: e.code ?? null, message: String(e.message ?? "").slice(0, 200) };
    }
    if (result.setPermitted) {
      const attempt = async (statement: string) => {
        try {
          const rows = await tx(REPLICA, statement);
          return { guardFired: false, rows: rows[1]?.length ?? 0 };
        } catch (error) {
          const e = error as { code?: unknown; message?: unknown };
          return { guardFired: GUARD_MESSAGE.test(String(e.message ?? "")), code: e.code ?? null };
        }
      };
      result.update = await attempt(`UPDATE ${tableOf(schema)} SET created_at = created_at WHERE handle = 'admin' RETURNING handle`);
      result.delete = await attempt(`DELETE FROM ${tableOf(schema)} WHERE handle = 'admin' RETURNING handle`);
      result.truncate = await attempt(`TRUNCATE ${tableOf(schema)}`);
      // The setting is transaction-local: the next statement is back in the default mode.
      const [after] = await q("SELECT current_setting('session_replication_role') AS v");
      result.modeAfter = after!.v;
      expect(after!.v).toBe("origin");
    }
    facts.sessionReplicationRole = result;
    expect(typeof result.setPermitted).toBe("boolean");
  });

  // ================================================================ 7. hostile display_name

  const CORRECT_CHECK = "CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 40)";
  const named = (check: string) => `CONSTRAINT ${DISPLAY_NAME_CHECK} ${check}`;
  const COLUMN_REFUSAL = /display_name is missing or is not exactly a nullable TEXT column/;
  const CHECK_REFUSAL = /real_accounts_display_name_check on \S+real_accounts is missing, not validated, or not exactly the intended length CHECK/;

  type DisplayNameCase = { name: string; label: string; setup: (s: string) => string[]; why: RegExp; part1?: "noop" | "refused" | "skip" | "hostile-path" };
  const displayNameCases: DisplayNameCase[] = [
    { name: "dn_missing", label: "the column is missing entirely (part 1 never ran)", setup: () => [], why: COLUMN_REFUSAL, part1: "skip" },
    { name: "dn_varchar", label: "VARCHAR(40)", setup: (s) => [`ALTER TABLE ${s}.real_accounts ADD COLUMN display_name VARCHAR(40) ${named(CORRECT_CHECK)}`], why: COLUMN_REFUSAL },
    { name: "dn_domain", label: "a domain over TEXT", setup: (s) => [`CREATE DOMAIN ${s}.dn_text AS TEXT`, `ALTER TABLE ${s}.real_accounts ADD COLUMN display_name ${s}.dn_text ${named(CORRECT_CHECK)}`], why: COLUMN_REFUSAL },
    { name: "dn_array", label: "TEXT[]", setup: (s) => [`ALTER TABLE ${s}.real_accounts ADD COLUMN display_name TEXT[] ${named("CHECK (display_name IS NULL OR cardinality(display_name) BETWEEN 1 AND 40)")}`], why: COLUMN_REFUSAL },
    { name: "dn_c_collation", label: 'a built-in but wrong collation (COLLATE "C")', setup: (s) => [`ALTER TABLE ${s}.real_accounts ADD COLUMN display_name TEXT COLLATE "C" ${named(CORRECT_CHECK)}`], why: COLUMN_REFUSAL },
    { name: "dn_user_collation", label: "a user-defined collation", setup: (s) => [`CREATE COLLATION ${s}.dn_collation FROM pg_catalog."C"`, `ALTER TABLE ${s}.real_accounts ADD COLUMN display_name TEXT COLLATE ${s}.dn_collation ${named(CORRECT_CHECK)}`], why: COLUMN_REFUSAL },
    { name: "dn_not_null", label: "NOT NULL", setup: (s) => [`ALTER TABLE ${s}.real_accounts ADD COLUMN display_name TEXT NOT NULL DEFAULT 'x' ${named(CORRECT_CHECK)}`, `ALTER TABLE ${s}.real_accounts ALTER COLUMN display_name DROP DEFAULT`], why: COLUMN_REFUSAL },
    { name: "dn_default", label: "a DEFAULT", setup: (s) => [`ALTER TABLE ${s}.real_accounts ADD COLUMN display_name TEXT DEFAULT 'Anonymous' ${named(CORRECT_CHECK)}`], why: COLUMN_REFUSAL },
    { name: "dn_generated", label: "a GENERATED column", setup: (s) => [`ALTER TABLE ${s}.real_accounts ADD COLUMN display_name TEXT GENERATED ALWAYS AS (left(safe_address, 10)) STORED ${named(CORRECT_CHECK)}`], why: COLUMN_REFUSAL },
    { name: "dn_identity", label: "an IDENTITY column (necessarily not TEXT)", setup: (s) => [`ALTER TABLE ${s}.real_accounts ADD COLUMN display_name INTEGER GENERATED ALWAYS AS IDENTITY`], why: COLUMN_REFUSAL },
    { name: "dn_no_check", label: "the CHECK is missing", setup: (s) => [`ALTER TABLE ${s}.real_accounts ADD COLUMN display_name TEXT`], why: CHECK_REFUSAL },
    { name: "dn_other_name", label: "the right CHECK under another name", setup: (s) => [`ALTER TABLE ${s}.real_accounts ADD COLUMN display_name TEXT CONSTRAINT dn_len ${CORRECT_CHECK}`], why: CHECK_REFUSAL },
    { name: "dn_weak_check", label: "a weakened length (0-4000)", setup: (s) => [`ALTER TABLE ${s}.real_accounts ADD COLUMN display_name TEXT ${named("CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 0 AND 4000)")}`], why: CHECK_REFUSAL },
    { name: "dn_half_check", label: "a same-named CHECK with a different definition (no upper bound)", setup: (s) => [`ALTER TABLE ${s}.real_accounts ADD COLUMN display_name TEXT ${named("CHECK (display_name IS NULL OR char_length(display_name) >= 1)")}`], why: CHECK_REFUSAL },
    { name: "dn_true_check", label: "a same-named CHECK (true)", setup: (s) => [`ALTER TABLE ${s}.real_accounts ADD COLUMN display_name TEXT`, `ALTER TABLE ${s}.real_accounts ADD ${named("CHECK (true)")}`], why: CHECK_REFUSAL },
    { name: "dn_not_valid", label: "the right CHECK, NOT VALID", setup: (s) => [`ALTER TABLE ${s}.real_accounts ADD COLUMN display_name TEXT`, `ALTER TABLE ${s}.real_accounts ADD ${named(CORRECT_CHECK)} NOT VALID`], why: CHECK_REFUSAL },
    { name: "dn_wrong_column", label: "the named CHECK is on another column", setup: (s) => [`ALTER TABLE ${s}.real_accounts ADD COLUMN display_name TEXT`, `ALTER TABLE ${s}.real_accounts ADD ${named("CHECK (wallet_id IS NULL OR char_length(wallet_id) BETWEEN 1 AND 40)")}`], why: CHECK_REFUSAL },
    { name: "dn_two_columns", label: "the named CHECK also constrains a second column", setup: (s) => [`ALTER TABLE ${s}.real_accounts ADD COLUMN display_name TEXT`, `ALTER TABLE ${s}.real_accounts ADD ${named("CHECK ((display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 40) AND wallet_id IS NOT NULL)")}`], why: CHECK_REFUSAL },
    {
      name: "dn_lookalike",
      label: "the named CHECK calls a look-alike char_length in the scratch schema",
      setup: (s) => [`CREATE FUNCTION ${s}.char_length(text) RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT 1'`, `ALTER TABLE ${s}.real_accounts ADD COLUMN display_name TEXT ${named(`CHECK (display_name IS NULL OR ${s}.char_length(display_name) BETWEEN 1 AND 40)`)}`],
      why: /real_accounts_display_name_check on \S+real_accounts (is missing, not validated, or not exactly|depends on an object other than real_accounts)/,
    },
    {
      name: "dn_hostile_path",
      label: "part 1 itself ran under a hostile search_path, binding a look-alike char_length",
      setup: (s) => [`CREATE FUNCTION ${s}.char_length(text) RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT 1'`],
      why: /real_accounts_display_name_check on \S+real_accounts (is missing, not validated, or not exactly|depends on an object other than real_accounts)/,
      part1: "hostile-path",
    },
    { name: "dn_name_squat", label: "the constraint NAME is taken while the column is absent (part 1 itself fails)", setup: (s) => [`ALTER TABLE ${s}.real_accounts ADD ${named("CHECK (wallet_id <> '')")}`], why: COLUMN_REFUSAL, part1: "refused" },
  ];

  describe("a hostile pre-existing display_name is REFUSED, left exactly as it was, and nothing of the Handles block is created", () => {
    for (const testCase of displayNameCases) {
      live(`${testCase.name}: ${testCase.label}`, async () => {
        const schema = await scratch(testCase.name);
        const setup = testCase.setup(schema);
        if (setup.length > 0) await tx(...setup);
        const mode = testCase.part1 ?? "noop";
        if (mode === "hostile-path") {
          // The hostile state IS what part 1 creates under that path — so it is created first, then proven refused.
          await tx(`SET LOCAL search_path = ${schema}, pg_catalog`, part1For(schema));
        }
        const before = await snapshot(schema);
        expectNoHandlesObjects(before);
        const hostileColumn = before.columns.find((c) => c.tbl === "real_accounts" && c.attname === "display_name") ?? null;
        const hostileChecks = before.constraints.filter((k) => k.tbl === "real_accounts" && k.contype === "c");

        if (mode === "noop") {
          await applyPart1(schema); // IF NOT EXISTS: the column's name exists, so this does nothing at all
          expect(await snapshot(schema)).toEqual(before);
        } else if (mode === "refused") {
          const refusal = await failure(applyPart1(schema));
          expect(refusal.code).toBe("42710"); // duplicate_object: the name is taken
          expect(await snapshot(schema)).toEqual(before);
        }
        const refusal = await failure(applyHandles(schema));
        expect(refusal.message).toMatch(REFUSED);
        expect(refusal.message).toMatch(testCase.why);
        const after = await snapshot(schema);
        expect(after).toEqual(before); // the hostile object is untouched, by identity and definition
        expect(after.columns.find((c) => c.tbl === "real_accounts" && c.attname === "display_name") ?? null).toEqual(hostileColumn);
        expect(after.constraints.filter((k) => k.tbl === "real_accounts" && k.contype === "c")).toEqual(hostileChecks);
        expectNoHandlesObjects(after);
      });
    }

    live("dn_extras_ok: unrelated extras on real_accounts (another column, another CHECK on display_name) are TOLERATED — the apply succeeds", async () => {
      const schema = await scratch("dn_extras_ok");
      await applyPurpose(schema);
      await applyPart1(schema);
      await tx(`ALTER TABLE ${schema}.real_accounts ADD COLUMN operator_note TEXT`, `ALTER TABLE ${schema}.real_accounts ADD CONSTRAINT dn_not_x CHECK (display_name IS DISTINCT FROM 'x')`);
      await applyHandles(schema);
      await verifyStructure(schema);
    });
  });

  // ================================================================ 8. hostile Handles objects

  const fn = (s: string) => `${s}.${GUARD_FUNCTION}()`;
  type HandlesCase = { name: string; label: string; wrong: (s: string) => string[]; why: RegExp };
  const afterCleanApply: HandlesCase[] = [
    { name: "h_coltype", label: "a column of the wrong type", wrong: (s) => [`ALTER TABLE ${tableOf(s)} ALTER COLUMN kind TYPE VARCHAR(20)`], why: /column\(s\) kind differ/ },
    { name: "h_collation", label: 'the handle column no longer COLLATE "C"', wrong: (s) => [`ALTER TABLE ${tableOf(s)} ALTER COLUMN handle TYPE TEXT COLLATE "default"`], why: /column\(s\) handle differ/ },
    { name: "h_nullable", label: "a required column made nullable", wrong: (s) => [`ALTER TABLE ${tableOf(s)} ALTER COLUMN kind DROP NOT NULL`], why: /column\(s\) kind differ/ },
    {
      name: "h_fk_cascade",
      label: "the composite foreign key re-created ON DELETE CASCADE",
      wrong: (s) => [`ALTER TABLE ${tableOf(s)} DROP CONSTRAINT ${CLAIMER_FK}, ADD CONSTRAINT ${CLAIMER_FK} FOREIGN KEY (app_user_id, claimed_by_credential_id) REFERENCES ${s}.real_passkeys (app_user_id, credential_id) ON DELETE CASCADE`],
      why: /real_account_handles_claimed_by_fkey is not exactly/,
    },
    {
      name: "h_fk_set_null",
      label: "the account foreign key re-created ON DELETE SET NULL",
      wrong: (s) => [`ALTER TABLE ${tableOf(s)} DROP CONSTRAINT ${ACCOUNT_FK}, ADD CONSTRAINT ${ACCOUNT_FK} FOREIGN KEY (app_user_id) REFERENCES ${s}.real_accounts (app_user_id) ON DELETE SET NULL`],
      why: /real_account_handles_app_user_id_fkey is not exactly/,
    },
    {
      name: "h_fk_update_cascade",
      label: "the account foreign key re-created ON UPDATE CASCADE",
      wrong: (s) => [`ALTER TABLE ${tableOf(s)} DROP CONSTRAINT ${ACCOUNT_FK}, ADD CONSTRAINT ${ACCOUNT_FK} FOREIGN KEY (app_user_id) REFERENCES ${s}.real_accounts (app_user_id) ON UPDATE CASCADE`],
      why: /real_account_handles_app_user_id_fkey is not exactly/,
    },
    {
      name: "h_fk_single",
      label: "the composite foreign key replaced by one on credential_id alone (no account binding)",
      wrong: (s) => [`ALTER TABLE ${tableOf(s)} DROP CONSTRAINT ${CLAIMER_FK}, ADD CONSTRAINT ${CLAIMER_FK} FOREIGN KEY (claimed_by_credential_id) REFERENCES ${s}.real_passkeys (credential_id)`],
      why: /real_account_handles_claimed_by_fkey is not exactly/,
    },
    { name: "h_fk_extra", label: "an extra foreign key", wrong: (s) => [`ALTER TABLE ${tableOf(s)} ADD CONSTRAINT extra_fk FOREIGN KEY (claimed_by_credential_id) REFERENCES ${s}.real_passkeys (credential_id)`], why: /has an unexpected foreign key/ },
    { name: "h_trigger_extra", label: "an extra, unexpected trigger", wrong: (s) => [`CREATE TRIGGER rewrite_handles BEFORE UPDATE ON ${tableOf(s)} FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()`], why: /has an unexpected user trigger or a rule/ },
    { name: "h_index_extra", label: "an extra, unexpected index", wrong: (s) => [`CREATE INDEX hx_extra ON ${tableOf(s)} (kind)`], why: /has unexpected index\(es\) hx_extra/ },
    { name: "h_fn_body", label: "the guard function's body altered (it now lets changes through)", wrong: (s) => [`CREATE OR REPLACE FUNCTION ${fn(s)} RETURNS trigger LANGUAGE plpgsql AS $f$BEGIN RETURN COALESCE(NEW, OLD); END;$f$`], why: /is not exactly the intended guard function/ },
    { name: "h_fn_secdef", label: "the guard function made SECURITY DEFINER", wrong: (s) => [`ALTER FUNCTION ${fn(s)} SECURITY DEFINER`], why: /is not exactly the intended guard function/ },
    { name: "h_fn_config", label: "the guard function given a SET clause", wrong: (s) => [`ALTER FUNCTION ${fn(s)} SET search_path = pg_catalog`], why: /is not exactly the intended guard function/ },
    { name: "h_trigger_disabled", label: "the row guard DISABLED", wrong: (s) => [`ALTER TABLE ${tableOf(s)} DISABLE TRIGGER ${ROW_GUARD}`], why: /does not have exactly the two intended immutability triggers/ },
    { name: "h_trigger_replica", label: "the truncate guard set ENABLE REPLICA (it would not fire normally)", wrong: (s) => [`ALTER TABLE ${tableOf(s)} ENABLE REPLICA TRIGGER ${TRUNCATE_GUARD}`], why: /does not have exactly the two intended immutability triggers/ },
    {
      name: "h_trigger_event",
      label: "the row guard replaced by a same-named trigger that covers UPDATE only",
      wrong: (s) => [`DROP TRIGGER ${ROW_GUARD} ON ${tableOf(s)}`, `CREATE TRIGGER ${ROW_GUARD} BEFORE UPDATE ON ${tableOf(s)} FOR EACH ROW EXECUTE FUNCTION ${fn(s)}`],
      why: /does not have exactly the two intended immutability triggers/,
    },
    {
      name: "h_trigger_when",
      label: "the row guard replaced by a same-named trigger with a WHEN clause",
      wrong: (s) => [`DROP TRIGGER ${ROW_GUARD} ON ${tableOf(s)}`, `CREATE TRIGGER ${ROW_GUARD} BEFORE UPDATE OR DELETE ON ${tableOf(s)} FOR EACH ROW WHEN (OLD.kind = 'claimed') EXECUTE FUNCTION ${fn(s)}`],
      why: /does not have exactly the two intended immutability triggers/,
    },
    {
      name: "h_weak_format",
      label: "a same-named format CHECK that allows anything",
      wrong: (s) => [`ALTER TABLE ${tableOf(s)} DROP CONSTRAINT real_account_handles_format_check, ADD CONSTRAINT real_account_handles_format_check CHECK (true)`],
      why: /constraint real_account_handles_format_check/,
    },
    { name: "h_no_owner_key", label: "the one-handle-per-account key dropped", wrong: (s) => [`ALTER TABLE ${tableOf(s)} DROP CONSTRAINT real_account_handles_app_user_id_key`], why: /constraint real_account_handles_app_user_id_key/ },
    { name: "h_rls", label: "row-level security enabled", wrong: (s) => [`ALTER TABLE ${tableOf(s)} ENABLE ROW LEVEL SECURITY`], why: /has row-level security enabled or forced, or a policy/ },
    { name: "h_rule", label: "a rewrite rule on the table", wrong: (s) => [`CREATE RULE swallow_updates AS ON UPDATE TO ${tableOf(s)} DO INSTEAD NOTHING`], why: /has an unexpected user trigger or a rule/ },
  ];

  describe("a wrong pre-existing Handles object is REFUSED, left exactly as it was, and never repaired", () => {
    for (const testCase of afterCleanApply) {
      live(`${testCase.name}: ${testCase.label}`, async () => {
        const schema = await scratch(testCase.name);
        await applyAll(schema);
        await tx(...testCase.wrong(schema));
        await expectRefusedUnchanged(schema, () => applyHandles(schema), testCase.why);
      });
    }

    live("h_view: a same-named VIEW before the first run — refused, and nothing (not even the passkey key) is left behind", async () => {
      const schema = await scratch("h_view");
      await applyPart1(schema);
      await q(`CREATE VIEW ${tableOf(schema)} AS SELECT 1 AS handle`);
      const { before } = await expectRefusedUnchanged(schema, () => applyHandles(schema), /is not an ordinary, permanent, non-partition table/);
      expect(before.constraints.filter((k) => k.conname === PASSKEY_KEY)).toEqual([]);
      expect((await snapshot(schema)).functions.filter((f) => f.proname === GUARD_FUNCTION)).toEqual([]);
    });

    live("h_key_order: a same-named unique key on real_passkeys with the columns in the WRONG order — refused before the table is created", async () => {
      const schema = await scratch("h_key_order");
      await applyPart1(schema);
      await q(`ALTER TABLE ${schema}.real_passkeys ADD CONSTRAINT ${PASSKEY_KEY} UNIQUE (credential_id, app_user_id)`);
      await expectRefusedUnchanged(schema, () => applyHandles(schema), /real_passkeys_app_user_credential_key is not exactly UNIQUE \(app_user_id, credential_id\)/);
      expect((await snapshot(schema)).classes.filter((c) => c.relname === TABLE)).toEqual([]);
    });

    live("h_key_index: a same-named plain INDEX (not a constraint) on real_passkeys — refused, nothing created", async () => {
      const schema = await scratch("h_key_index");
      await applyPart1(schema);
      await q(`CREATE UNIQUE INDEX ${PASSKEY_KEY} ON ${schema}.real_passkeys (app_user_id, credential_id)`);
      const before = await snapshot(schema);
      const refusal = await failure(applyHandles(schema));
      facts.sameNamedIndexRefusal = { code: refusal.code, message: refusal.message.slice(0, 160) };
      expect(await snapshot(schema)).toEqual(before);
      expect(before.classes.filter((c) => c.relname === TABLE)).toEqual([]);
    });

    live("h_reserved_claimed: a CLAIMED row already occupies a reserved name — refused; the row is preserved and no guard is installed", async () => {
      const schema = await scratch("h_reserved_claimed");
      await applyPart1(schema);
      await tx(
        `ALTER TABLE ${schema}.real_passkeys ADD CONSTRAINT ${PASSKEY_KEY} UNIQUE (app_user_id, credential_id)`,
        `CREATE TABLE ${tableOf(schema)} (${DEFINITION}, CONSTRAINT ${ACCOUNT_FK} FOREIGN KEY (app_user_id) REFERENCES ${schema}.real_accounts (app_user_id), CONSTRAINT ${CLAIMER_FK} FOREIGN KEY (app_user_id, claimed_by_credential_id) REFERENCES ${schema}.real_passkeys (app_user_id, credential_id))`,
        `INSERT INTO ${tableOf(schema)} (handle, kind, app_user_id, claimed_by_credential_id) VALUES ('admin', 'claimed', '${A}', 'hs-cred-a')`,
      );
      const rowBefore = await q(`SELECT handle, kind, app_user_id, claimed_by_credential_id, created_at::text AS created_at FROM ${tableOf(schema)}`);
      await expectRefusedUnchanged(schema, () => applyHandles(schema), /reserved name\(s\) admin are not reserved rows/);
      // The whole block rolled back: no seed row, no function, no trigger — and the claimed row is exactly as it was.
      expect(await q(`SELECT handle, kind, app_user_id, claimed_by_credential_id, created_at::text AS created_at FROM ${tableOf(schema)}`)).toEqual(rowBefore);
      const after = await snapshot(schema);
      expect(after.functions.filter((f) => f.proname === GUARD_FUNCTION)).toEqual([]);
      expect(after.triggers).toEqual([]);
    });

    live("h_extra_ok: an extra, unrelated built-in column on the registry is TOLERATED — the rerun is accepted and changes nothing", async () => {
      const schema = await scratch("h_extra_ok");
      await applyAll(schema);
      await q(`ALTER TABLE ${tableOf(schema)} ADD COLUMN operator_note TEXT`);
      const before = await snapshot(schema);
      await applyHandles(schema);
      expect(await snapshot(schema)).toEqual(before);
    });

    live("h_trigger_missing: a MISSING guard trigger is created again by the rerun (create-if-missing, like the first apply) — recorded", async () => {
      const schema = await scratch("h_trigger_missing");
      await applyAll(schema);
      await q(`DROP TRIGGER ${TRUNCATE_GUARD} ON ${tableOf(schema)}`);
      expect((await snapshot(schema)).triggers.map((t) => t.tgname)).toEqual([ROW_GUARD]);
      await applyHandles(schema);
      await verifyStructure(schema);
      facts.missingTriggerRecreatedOnRerun = true;
    });
  });

  // ================================================================ 9. partial failure, then recovery

  live("partial failure is recoverable: purpose + part 1 land, the Handles block refuses, the cause is removed, and a clean rerun completes", async () => {
    const schema = await scratch("partial");
    const pristine = await snapshot(schema);
    // The condition that will make the LATER block fail: a wrong same-named key on real_passkeys.
    await q(`ALTER TABLE ${schema}.real_passkeys ADD CONSTRAINT ${PASSKEY_KEY} UNIQUE (credential_id, app_user_id)`);

    await applyPurpose(schema);
    await applyPart1(schema);
    const refusal = await failure(applyHandles(schema));
    expect(refusal.message).toMatch(/real_passkeys_app_user_credential_key is not exactly UNIQUE/);

    // Exactly the additive part-1 / purpose changes remain — nothing of the Handles block.
    const partial = await snapshot(schema);
    expect(partial.classes.filter((c) => c.relname.startsWith(TABLE))).toEqual([]);
    expect(partial.functions).toEqual(pristine.functions);
    expect(partial.triggers).toEqual(pristine.triggers);
    expect(partial.columns.filter((c) => !(c.tbl === "real_accounts" && c.attname === "display_name"))).toEqual(pristine.columns);
    expect(partial.columns.find((c) => c.tbl === "real_accounts" && c.attname === "display_name")).toMatchObject({ type: "text", attnotnull: false, def: null });
    const names = (snap: Snapshot) => snap.constraints.filter((k) => !(k.tbl === "webauthn_challenges" && k.contype === "c")).map((k) => `${k.tbl}.${k.conname}`).sort();
    expect(names(partial)).toEqual([...names(pristine), `real_accounts.${DISPLAY_NAME_CHECK}`, `real_passkeys.${PASSKEY_KEY}`].sort());
    expect(partial.constraints.find((k) => k.conname === PASSKEY_KEY)!.def).toBe("UNIQUE (credential_id, app_user_id)"); // the hostile key is untouched
    expect(partial.constraints.filter((k) => k.tbl === "webauthn_challenges" && k.contype === "c").map((k) => k.def.includes("'handle_claim'"))).toEqual([true]);
    await q(`INSERT INTO ${schema}.webauthn_challenges (challenge, purpose, expires_at) VALUES ('hs-partial', 'handle_claim', now() + interval '5 minutes')`);

    // Correct the cause by hand, then rerun the whole sequence.
    await q(`ALTER TABLE ${schema}.real_passkeys DROP CONSTRAINT ${PASSKEY_KEY}`);
    await applyAll(schema);
    await verifyStructure(schema);
    expect(await claim(schema, "hs_alpha", A, "hs-cred-a")).toEqual([{ handle: "hs_alpha" }]);
  });

  // ================================================================ 10. idempotence

  /** Object identities/definitions with the ONE thing the existing purpose block replaces by design (its CHECK's oid) masked. */
  const stable = (snap: Snapshot) => ({ ...snap, constraints: snap.constraints.map((k) => (k.tbl === "webauthn_challenges" && k.conname === "webauthn_challenges_purpose_check" ? { ...k, oid: "<replaced by the purpose block on every run>" } : k)) });

  live("idempotence: one more full run on the successful scratch install changes no identity, definition, seed, or fixture row", async () => {
    const schema = scratchName(runId, "main");
    const before = await snapshot(schema);
    const data = await dataHashes(schema, before);
    await applyAll(schema);
    const after = await snapshot(schema);
    expect(stable(after)).toEqual(stable(before));
    expect(await dataHashes(schema, after)).toEqual(data);
    await verifyStructure(schema);
    const purposeOid = (snap: Snapshot) => snap.constraints.find((k) => k.conname === "webauthn_challenges_purpose_check")!.oid;
    facts.scratchIdempotence = { identicalExceptPurposeCheckOid: true, purposeCheckRecreated: purposeOid(before) !== purposeOid(after) };
  });

  // ================================================================ 11. public, on the same disposable branch

  it.skipIf(!publicEnabled)(
    "PUBLIC (disposable branch): applied once — additive objects only, existing data unchanged — then once more, changing nothing (or, on an already-migrated branch, one rerun that changes nothing)",
    async () => {
      if (failures > 0) throw new Error(`the public apply was NOT attempted: ${failures} scratch test(s) failed`);
      try {
        if (publicMigrated) {
          // RE-PROOF on a branch whose public already carries the migration: one rerun of the CURRENT text must change nothing.
          const resolvedNow = await q(
            `SELECT current_schema()::text AS current_schema,
                    (SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = 'webauthn_challenges'::regclass) AS challenges_schema,
                    (SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = 'real_accounts'::regclass) AS accounts_schema`,
          );
          expect(resolvedNow).toEqual([{ current_schema: "public", challenges_schema: "public", accounts_schema: "public" }]);
          const installed = await verifyStructure("public");
          const dataInstalled = await dataHashes("public", installed);
          await q(PURPOSE_BLOCK);
          await q(PART1);
          await q(HANDLES_PUBLIC);
          const rerun = await verifyStructure("public");
          expect(stable(rerun)).toEqual(stable(installed));
          expect(await dataHashes("public", rerun)).toEqual(dataInstalled);
          expect(await q(`SELECT kind, count(*)::int AS n FROM public.${TABLE} GROUP BY kind`)).toEqual([{ kind: "reserved", n: SEEDED_RESERVED.length }]);
          facts.publicApply = {
            mode: "rerun on an already-migrated public",
            rerunIdentical: true,
            tablesChecked: Object.keys(dataInstalled).length,
            rowCounts: Object.fromEntries(Object.entries(dataInstalled).map(([table, value]) => [table, Number(value.split(":")[0])])),
            reservedRows: SEEDED_RESERVED.length,
            claimedRows: 0,
          };
          return;
        }
        const resolved = await q(
          `SELECT current_schema()::text AS current_schema,
                  (SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = 'webauthn_challenges'::regclass) AS challenges_schema,
                  (SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = 'real_accounts'::regclass) AS accounts_schema`,
        );
        expect(resolved).toEqual([{ current_schema: "public", challenges_schema: "public", accounts_schema: "public" }]); // the unqualified statements target public

        const before = await snapshot("public");
        expectNoHandlesObjects(before);
        const dataBefore = await dataHashes("public", before);
        const tablesBefore = before.classes.filter((c) => c.relkind === "r").map((c) => c.relname);

        // The finalized migration, exactly as written in schema.sql, in order. Once.
        await q(PURPOSE_BLOCK);
        await q(PART1);
        await q(HANDLES_PUBLIC);

        const after = await verifyStructure("public");
        const key = <T extends { oid: string }>(rows: T[]) => new Map(rows.map((row) => [row.oid, row]));
        // Classes: nothing removed or replaced; exactly the four new relations.
        for (const [oid, row] of key(before.classes)) expect(key(after.classes).get(oid), row.relname).toEqual(row);
        expect(after.classes.filter((c) => !key(before.classes).has(c.oid)).map((c) => `${c.relkind}:${c.relname}`).sort()).toEqual(
          [`r:${TABLE}`, "i:real_account_handles_pkey", "i:real_account_handles_app_user_id_key", `i:${PASSKEY_KEY}`].sort(),
        );
        // Constraints: every pre-existing one is identical, except the purpose CHECK the existing block replaces by design.
        const purposeChecks = (snap: Snapshot) => snap.constraints.filter((k) => k.tbl === "webauthn_challenges" && k.contype === "c");
        for (const [oid, row] of key(before.constraints)) {
          if (purposeChecks(before).some((k) => k.oid === oid)) continue;
          expect(key(after.constraints).get(oid), `${row.tbl}.${row.conname}`).toEqual(row);
        }
        expect(purposeChecks(after).map((k) => k.conname)).toEqual(["webauthn_challenges_purpose_check"]);
        for (const purpose of [...PRE_EXISTING_PURPOSES, "handle_claim"]) expect(purposeChecks(after)[0]!.def).toContain(`'${purpose}'`);
        const addedConstraints = after.constraints.filter((k) => !key(before.constraints).has(k.oid) && k.tbl !== TABLE && !(k.tbl === "webauthn_challenges" && k.contype === "c"));
        expect(addedConstraints.map((k) => `${k.tbl}.${k.conname}`).sort()).toEqual([`real_accounts.${DISPLAY_NAME_CHECK}`, `real_passkeys.${PASSKEY_KEY}`]);
        // Indexes, triggers, functions, columns: only additions, and only the intended ones.
        expect(after.indexes.filter((i) => !before.indexes.some((b) => b.indexname === i.indexname)).map((i) => i.indexname).sort()).toEqual(["real_account_handles_app_user_id_key", "real_account_handles_pkey", PASSKEY_KEY].sort());
        for (const index of before.indexes) expect(after.indexes.find((i) => i.indexname === index.indexname), index.indexname).toEqual(index);
        expect(after.triggers.filter((t) => !key(before.triggers).has(t.oid)).map((t) => `${t.tbl}.${t.tgname}`)).toEqual([`${TABLE}.${ROW_GUARD}`, `${TABLE}.${TRUNCATE_GUARD}`]);
        for (const [oid, row] of key(before.triggers)) expect(key(after.triggers).get(oid), row.tgname).toEqual(row);
        expect(after.functions.filter((f) => !key(before.functions).has(f.oid)).map((f) => f.proname)).toEqual([GUARD_FUNCTION]);
        for (const [oid, row] of key(before.functions)) expect(key(after.functions).get(oid), row.proname).toEqual(row);
        const columnKey = (c: Snapshot["columns"][number]) => `${c.tbl}.${c.attname}`;
        expect(after.columns.filter((c) => !before.columns.some((b) => columnKey(b) === columnKey(c)) && c.tbl !== TABLE).map(columnKey)).toEqual(["real_accounts.display_name"]);
        for (const column of before.columns) expect(after.columns.find((c) => columnKey(c) === columnKey(column)), columnKey(column)).toEqual(column);

        // Existing application data: every pre-existing table, over its pre-existing columns, is byte-for-byte what it was.
        const hashNow = async () => {
          const out: Record<string, string> = {};
          for (const table of tablesBefore) out[table] = await contentHash("public", table, before.columns.filter((c) => c.tbl === table).map((c) => c.attname));
          return out;
        };
        expect(await hashNow()).toEqual(dataBefore);
        expect(await q(`SELECT count(*)::int AS n FROM public.real_accounts WHERE display_name IS NOT NULL`)).toEqual([{ n: 0 }]);
        // The registry holds the reserved seeds and nothing else: no handle was claimed.
        expect(await q(`SELECT kind, count(*)::int AS n FROM public.${TABLE} GROUP BY kind`)).toEqual([{ kind: "reserved", n: SEEDED_RESERVED.length }]);

        // The one intended idempotence rerun.
        const handlesData = await contentHash("public", TABLE, ["handle", "kind", "app_user_id", "claimed_by_credential_id", "created_at"]);
        await q(PURPOSE_BLOCK);
        await q(PART1);
        await q(HANDLES_PUBLIC);
        const rerun = await verifyStructure("public");
        expect(stable(rerun)).toEqual(stable(after));
        expect(await hashNow()).toEqual(dataBefore);
        expect(await contentHash("public", TABLE, ["handle", "kind", "app_user_id", "claimed_by_credential_id", "created_at"])).toBe(handlesData);
        expect(await q(`SELECT kind, count(*)::int AS n FROM public.${TABLE} GROUP BY kind`)).toEqual([{ kind: "reserved", n: SEEDED_RESERVED.length }]);

        facts.publicApply = {
          applied: true,
          rerunIdentical: true,
          tablesChecked: tablesBefore.length,
          rowCounts: Object.fromEntries(Object.entries(dataBefore).map(([table, value]) => [table, Number(value.split(":")[0])])),
          newRelations: after.classes.filter((c) => !key(before.classes).has(c.oid)).map((c) => `${c.relkind}:${c.relname}`).sort(),
          reservedRows: SEEDED_RESERVED.length,
          claimedRows: 0,
        };
      } catch (error) {
        failures += 1;
        throw error;
      }
    },
    LIVE_TIMEOUT_MS,
  );
});
