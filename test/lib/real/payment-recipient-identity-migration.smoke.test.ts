// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { checkDisposableTarget as checkTarget, connectSmokeDb, requireDisposableTargetUrl, type SmokeDb } from "./fixtures/handles-smoke-db";
import { PAIR_INTEGRITY_AUDIT_SQL, pairIntegrityAuditFor } from "./fixtures/payment-recipient-audit";

/**
 * MANUAL, LIVE-DATABASE behavioral proof of schema.sql's "Payment Attempt
 * Recipient Identity" migration: three nullable columns on payment_attempts,
 * one CHECK, two NO ACTION foreign keys. Modeled on the Handles migration
 * smoke (handles-migration.smoke.test.ts) and sharing its target-safety check.
 *
 * DISPOSABLE NEON BRANCH ONLY. It never reads DATABASE_URL: the target is
 * NEON_BRANCH_DATABASE_URL, and the run refuses (before any connection)
 * unless that endpoint provably differs from the real database named in
 * .env.local, DATABASE_URL is not exported, and no admin / unrelated smoke
 * gate is set.
 *
 * Scratch stage: throwaway schemas (`prid_<run>_<case>`), each a copy of the
 * branch's own `public` tables (LIKE ... INCLUDING ALL) stripped back to the
 * pre-migration shape, get the Handles migration and then the EXACT block
 * text with only its `target_schema` constant swapped. All are dropped.
 *
 * Public stage (second gate, and only if every scratch test passed): the
 * unmodified block is applied to the BRANCH's `public` once and then once
 * more for idempotence (or rerun once, on an already-migrated branch), and
 * the Handles block is rerun after it.
 *
 * WHAT THIS DELIBERATELY SHOWS IS NOT ENFORCED: a handle paired with ANOTHER
 * account's id is accepted by the database (there is no composite foreign
 * key). Handle Pay Slice B — COMPLETE / CLOSED — derives both from the database
 * in one atomic INSERT and writes lower(a.safe_address) as the recipient; the
 * standing audit query (fixtures/payment-recipient-audit.ts) is what catches
 * a violation. Also decided for Slice B, and visible here: a claimed handle
 * can receive whether or not its account has an active passkey, so nothing in
 * this schema looks at passkey status.
 *
 *   REAL_SMOKE_PAYMENT_RECIPIENT_MIGRATION=1 REAL_SMOKE_PAYMENT_RECIPIENT_MIGRATION_PUBLIC=1 \
 *     pnpm exec vitest run test/lib/real/payment-recipient-identity-migration.smoke.test.ts
 */
const GATE = "REAL_SMOKE_PAYMENT_RECIPIENT_MIGRATION";
const PUBLIC_GATE = "REAL_SMOKE_PAYMENT_RECIPIENT_MIGRATION_PUBLIC";
const enabled = process.env[GATE] === "1" && Boolean(process.env.NEON_BRANCH_DATABASE_URL);
const publicEnabled = process.env[PUBLIC_GATE] === "1";

const TABLE = "payment_attempts";
const REGISTRY = "real_account_handles";
const COLUMNS = ["recipient_app_user_id", "recipient_handle", "recipient_display_name"] as const;
const CHECK = "payment_attempts_recipient_identity_check";
const ACCOUNT_FK = "payment_attempts_recipient_app_user_id_fkey";
const HANDLE_FK = "payment_attempts_recipient_handle_fkey";
const CHECK_EXPRESSION =
  "(recipient_handle IS NULL AND recipient_app_user_id IS NULL AND recipient_display_name IS NULL) OR (recipient_handle IS NOT NULL AND recipient_app_user_id IS NOT NULL)";
const REFUSED = /Payment recipient identity migration refused/;

// ------------------------------------------------------------------ the exact migration text

const schemaSql = readFileSync("lib/real/server/schema.sql", "utf8");
const TARGET_CONSTANT = "target_schema CONSTANT pg_catalog.text := 'public';";

function blockBetween(beginMarker: string, endMarker: string): string {
  const block = schemaSql.slice(schemaSql.indexOf(beginMarker), schemaSql.indexOf(endMarker));
  return block.slice(block.indexOf("DO $$"));
}
/** A block with only its target schema swapped. */
function retarget(block: string, schema: string): string {
  if (block.split(TARGET_CONSTANT).length !== 2) throw new Error("a migration block must contain its target constant exactly once");
  const body = block.replace(TARGET_CONSTANT, `target_schema CONSTANT pg_catalog.text := '${schema}';`);
  if (body.includes("'public'")) throw new Error("a 'public' literal survived the target swap");
  return body;
}

/** The block under test, exactly as written (the `public` form). */
const RECIPIENT_PUBLIC = blockBetween("-- BEGIN Payment Attempt Recipient Identity", "-- END Payment Attempt Recipient Identity");
/** Its prerequisite: the Handles block, and that block's own prerequisite ALTER (idempotent). */
const HANDLES_PUBLIC = blockBetween("-- BEGIN Account Handles", "-- END Account Handles");
const HANDLES_PART1 = /ALTER TABLE real_accounts ADD COLUMN IF NOT EXISTS display_name TEXT\s+CONSTRAINT real_accounts_display_name_check CHECK \([^;]*\);/.exec(schemaSql)?.[0] ?? "";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const MIGRATION_SHA256 = { recipientIdentityBlock: sha256(RECIPIENT_PUBLIC), handlesBlock: sha256(HANDLES_PUBLIC) };

const ALLOWED_GATES = [GATE, PUBLIC_GATE] as const;
const checkDisposableTarget = (input: { env: Record<string, string | undefined>; envLocalText: string | null }) => checkTarget({ ...input, gate: GATE, allowedGates: ALLOWED_GATES });

const scratchName = (runId: string, name: string) => `prid_${runId}_${name}`.toLowerCase();
const VALID_UNQUOTED_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

// Offline (never gated): the harness itself.
describe("payment recipient identity migration smoke harness", () => {
  it("extracts exactly the block under test and its prerequisites, as written in schema.sql", () => {
    for (const block of [RECIPIENT_PUBLIC, HANDLES_PUBLIC]) {
      expect(block.startsWith("DO $$")).toBe(true);
      expect(block.trimEnd().endsWith("END $$;")).toBe(true);
      expect(block.match(/\bDO \$\$/g)).toHaveLength(1);
      expect(block).toContain(TARGET_CONSTANT);
      expect(schemaSql).toContain(block);
    }
    expect(RECIPIENT_PUBLIC).toContain(`check_expression CONSTANT pg_catalog.text :=\n    '${CHECK_EXPRESSION}';`);
    expect(RECIPIENT_PUBLIC).not.toMatch(/owner_?address/i);
    const swapped = retarget(RECIPIENT_PUBLIC, "prid_test");
    expect(swapped).toContain("target_schema CONSTANT pg_catalog.text := 'prid_test';");
    expect(swapped.replace("'prid_test'", "'public'")).toBe(RECIPIENT_PUBLIC); // only the one constant differs
    expect(HANDLES_PART1).toContain("ADD COLUMN IF NOT EXISTS display_name TEXT");
    expect(HANDLES_PART1.split("ALTER TABLE real_accounts ")).toHaveLength(2);
    expect(MIGRATION_SHA256.recipientIdentityBlock).toMatch(/^[0-9a-f]{64}$/);
  });

  it("every scratch schema name is a lowercase, valid unquoted identifier", () => {
    const runId = randomUUID().replace(/-/g, "").slice(0, 8);
    for (const name of ["main", "hostile", "no_registry", "partial"]) expect(scratchName(runId, name)).toMatch(VALID_UNQUOTED_IDENTIFIER);
  });

  it("the gate is its own: DATABASE_URL alone never enables this file, and it is never read as a connection target", () => {
    const source = readFileSync("test/lib/real/payment-recipient-identity-migration.smoke.test.ts", "utf8");
    expect(source).toContain('const enabled = process.env[GATE] === "1" && Boolean(process.env.NEON_BRANCH_DATABASE_URL);');
    expect(source.match(/process\.env\.DATABASE_URL/g)).toBeNull();
    for (const other of ["test/lib/real/neon-smoke.test.ts", "test/lib/real/provisioning-dispatch-migration.smoke.test.ts", "test/lib/real/l2-identity-migration.smoke.test.ts", "test/lib/real/handles-migration.smoke.test.ts", "test/lib/real/handles-runtime.smoke.test.ts"]) {
      expect(readFileSync(other, "utf8"), other).not.toContain(GATE);
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
      ["the branch URL is missing", { env: env({ NEON_BRANCH_DATABASE_URL: undefined }), envLocalText: real }],
      [".env.local is unreadable", { env: env(), envLocalText: null }],
      ["the branch IS the real database", { env: env({ NEON_BRANCH_DATABASE_URL: "postgresql://app:secret@ep-real-000001-pooler.us-east-2.aws.neon.tech/neondb" }), envLocalText: real }],
      ["the branch is the real endpoint's direct (non-pooled) form", { env: env({ NEON_BRANCH_DATABASE_URL: "postgresql://app:secret@ep-real-000001.us-east-2.aws.neon.tech/neondb" }), envLocalText: real }],
    ])("refuses when %s", (_label, input) => {
      const result = checkDisposableTarget(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).not.toMatch(/secret|postgresql:\/\//);
    });
  });
});

// ------------------------------------------------------------------ live

const LIVE_TIMEOUT_MS = 180_000;
type Failure = { code: string | null; constraint: string | null; message: string };

describe.skipIf(!enabled)("Payment Attempt Recipient Identity migration — behavior against a DISPOSABLE Neon branch (live)", () => {
  const runId = randomUUID().replace(/-/g, "").slice(0, 8);
  const schemas = new Set<string>();
  const facts: Record<string, unknown> = { runId };
  let failures = 0;
  /** Whether the branch's `public` already carries this migration / the Handles registry (decided by the environment probe). */
  let publicMigrated = false;
  let publicHasRegistry = false;
  let connection: Promise<SmokeDb> | null = null;

  /** The ONLY way this file obtains a connection: the target check runs first, every time. */
  function db(): Promise<SmokeDb> {
    if (!connection) connection = connectSmokeDb(requireDisposableTargetUrl(GATE, ALLOWED_GATES));
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

  /** Everything catalog-visible in one schema, in one round trip. Object identities are oids (as text). */
  async function snapshot(schema: string) {
    const [row] = await q(
      `SELECT
        (SELECT coalesce(json_agg(x ORDER BY x.relname), '[]')::text FROM (
          SELECT c.relname, c.relkind::text AS relkind, c.oid::text AS oid
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r', 'i', 'v', 'm', 'S', 'p', 'f')) x) AS classes,
        (SELECT coalesce(json_agg(x ORDER BY x.tbl, x.conname), '[]')::text FROM (
          SELECT c.relname AS tbl, k.conname, k.contype::text AS contype, k.oid::text AS oid, k.convalidated, k.condeferrable, k.condeferred, pg_get_constraintdef(k.oid) AS def
          FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1) x) AS constraints,
        (SELECT coalesce(json_agg(x ORDER BY x.indexname), '[]')::text FROM (
          SELECT i.tablename, i.indexname, i.indexdef FROM pg_indexes i WHERE i.schemaname = $1) x) AS indexes,
        (SELECT coalesce(json_agg(x ORDER BY x.tbl, x.tgname), '[]')::text FROM (
          SELECT c.relname AS tbl, g.tgname, g.oid::text AS oid, g.tgenabled::text AS tgenabled, g.tgtype::int AS tgtype
          FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT g.tgisinternal) x) AS triggers,
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
      classes: parse<{ relname: string; relkind: string; oid: string }>(row!.classes),
      constraints: parse<{ tbl: string; conname: string; contype: string; oid: string; convalidated: boolean; condeferrable: boolean; condeferred: boolean; def: string }>(row!.constraints),
      indexes: parse<{ tablename: string; indexname: string; indexdef: string }>(row!.indexes),
      triggers: parse<{ tbl: string; tgname: string; oid: string; tgenabled: string; tgtype: number }>(row!.triggers),
      columns: parse<{ tbl: string; attnum: number; attname: string; type: string; attnotnull: boolean; collname: string | null; attidentity: string; attgenerated: string; def: string | null }>(row!.columns),
    };
  }
  type Snapshot = Awaited<ReturnType<typeof snapshot>>;

  const recipientColumns = (snap: Snapshot) => snap.columns.filter((c) => c.tbl === TABLE && (COLUMNS as readonly string[]).includes(c.attname));
  const recipientConstraints = (snap: Snapshot) => snap.constraints.filter((k) => k.tbl === TABLE && [CHECK, ACCOUNT_FK, HANDLE_FK].includes(k.conname));
  /** No object of this migration exists in the schema. */
  function expectNoRecipientObjects(snap: Snapshot) {
    expect(recipientColumns(snap)).toEqual([]);
    expect(recipientConstraints(snap)).toEqual([]);
  }

  /** count + order-independent content hash of a table over a FIXED column list. */
  async function contentHash(schema: string, table: string, columns: string[]) {
    const rowText = `ROW(${columns.map((c) => `"${c}"`).join(", ")})::text`;
    const [row] = await q(`SELECT count(*)::text AS n, coalesce(md5(string_agg(md5(${rowText}), ',' ORDER BY md5(${rowText}))), '') AS h FROM ${schema}."${table}"`);
    return `${row!.n}:${row!.h}`;
  }
  async function dataHashes(schema: string, snap: Snapshot, { withoutRecipientColumns = false } = {}) {
    const out: Record<string, string> = {};
    for (const table of snap.classes.filter((c) => c.relkind === "r").map((c) => c.relname)) {
      const columns = snap.columns.filter((c) => c.tbl === table && !(withoutRecipientColumns && table === TABLE && (COLUMNS as readonly string[]).includes(c.attname))).map((c) => c.attname);
      out[table] = await contentHash(schema, table, columns);
    }
    return out;
  }

  // Fixture identities are unique per run (the L2 unique indexes on real_accounts are copied into every scratch schema).
  const address = (label: string) => `0x${createHash("sha256").update(`${runId}:${label}`).digest("hex").slice(0, 40)}`;
  const A = `prid-${runId}-a`; // owns @prid_alice; its Safe is stored MIXED-CASE
  const B = `prid-${runId}-b`; // owns @prid_bob
  const C = `prid-${runId}-c`; // owns @prid_carol, and has NO active passkey (only a revoked one)
  const D = `prid-${runId}-d`; // no handle, no passkey — only ever a recipient id
  const SAFE_A = `0xAbCdEf${address("safe-a").slice(8)}`;
  const SAFE: Record<string, string> = { [A]: SAFE_A, [B]: address("safe-b"), [C]: address("safe-c"), [D]: address("safe-d") };
  const ACCOUNT_COLUMNS = "(app_user_id, sub_organization_id, turnkey_user_id, wallet_id, wallet_account_id, owner_address, safe_address, account_config_version)";
  const PASSKEY_COLUMNS = "(credential_id, app_user_id, credential_public_key, user_handle, counter, status, role)";

  /**
   * A fresh scratch schema: copies of the branch's own `public` tables, the
   * foreign keys LIKE does not copy, fixture accounts/passkeys, and — unless
   * `registry` is false — the Handles migration plus three claimed handles.
   * The payment_attempts copy is ALWAYS stripped back to the pre-migration
   * shape, so every case starts without the three columns whatever the
   * branch's `public` looks like. `copyRows` also copies the branch's
   * existing account, passkey, and payment rows.
   */
  async function scratch(name: string, { copyRows = false, registry = true } = {}) {
    const schema = scratchName(runId, name);
    expect(schema).toMatch(VALID_UNQUOTED_IDENTIFIER);
    schemas.add(schema);
    const account = (id: string) => `('${id}', '${id}-sub-org', '${id}-turnkey-user', '${id}-wallet', '${id}-wallet-account', '${address(`owner-${id}`)}', '${SAFE[id]}', 1)`;
    const passkey = (id: string, owner: string, status: string) => `('${id}', '${owner}', 'prid-cose-${id}', 'prid-user-handle-${id}', 0, '${status}', 'primary')`;
    await tx(
      `CREATE SCHEMA ${schema}`,
      `CREATE TABLE ${schema}.real_accounts (LIKE public.real_accounts INCLUDING ALL)`,
      `CREATE TABLE ${schema}.real_passkeys (LIKE public.real_passkeys INCLUDING ALL)`,
      `CREATE TABLE ${schema}.${TABLE} (LIKE public.${TABLE} INCLUDING ALL)`,
      `ALTER TABLE ${schema}.${TABLE} ${COLUMNS.map((c) => `DROP COLUMN IF EXISTS ${c}`).join(", ")}`,
      // LIKE copies the Handles block's passkey key under a generated name; the block must create its own (it proves the composite key uses exactly that one).
      `DO $strip$ DECLARE k record; BEGIN FOR k IN SELECT c.conname FROM pg_catalog.pg_constraint c WHERE c.conrelid = '${schema}.real_passkeys'::regclass AND c.contype = 'u' AND pg_catalog.pg_get_constraintdef(c.oid) = 'UNIQUE (app_user_id, credential_id)' LOOP EXECUTE format('ALTER TABLE ${schema}.real_passkeys DROP CONSTRAINT %I', k.conname); END LOOP; END $strip$`,
      `ALTER TABLE ${schema}.real_passkeys ADD CONSTRAINT real_passkeys_app_user_id_fkey FOREIGN KEY (app_user_id) REFERENCES ${schema}.real_accounts (app_user_id)`,
      `ALTER TABLE ${schema}.${TABLE} ADD CONSTRAINT payment_attempts_app_user_id_fkey FOREIGN KEY (app_user_id) REFERENCES ${schema}.real_accounts (app_user_id)`,
      ...(copyRows ? [`INSERT INTO ${schema}.real_accounts SELECT * FROM public.real_accounts`, `INSERT INTO ${schema}.real_passkeys SELECT * FROM public.real_passkeys`] : []),
      `INSERT INTO ${schema}.real_accounts ${ACCOUNT_COLUMNS} VALUES ${[A, B, C, D].map(account).join(", ")}`,
      `INSERT INTO ${schema}.real_passkeys ${PASSKEY_COLUMNS} VALUES ${passkey(`${A}-cred`, A, "active")}, ${passkey(`${B}-cred`, B, "active")}, ${passkey(`${C}-cred`, C, "revoked")}`,
    );
    if (copyRows) {
      const columns = (await q(`SELECT a.attname FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [`${schema}.${TABLE}`])).map((r) => `"${String(r.attname)}"`).join(", ");
      await q(`INSERT INTO ${schema}.${TABLE} (${columns}) SELECT ${columns} FROM public.${TABLE}`);
    }
    if (registry) {
      await q(HANDLES_PART1.replace("ALTER TABLE real_accounts ", `ALTER TABLE ${schema}.real_accounts `));
      await q(retarget(HANDLES_PUBLIC, schema));
      await q(
        `INSERT INTO ${schema}.${REGISTRY} (handle, kind, app_user_id, claimed_by_credential_id) VALUES
          ('prid_alice', 'claimed', '${A}', '${A}-cred'), ('prid_bob', 'claimed', '${B}', '${B}-cred'), ('prid_carol', 'claimed', '${C}', '${C}-cred')`,
      );
    }
    return schema;
  }

  const apply = (schema: string) => q(retarget(RECIPIENT_PUBLIC, schema));

  /** One terminal payment row (terminal, so the one-active-per-account index never interferes). Returns its id. */
  async function pay(schema: string, recipient: { handle?: string | null; appUserId?: string | null; displayName?: string | null; address?: string } = {}, sender = B) {
    const named = Object.keys(recipient).some((k) => k !== "address");
    const base = "app_user_id, safe_address, recipient, amount_base_units, chain_id, token_address, state";
    const baseValues = [sender, SAFE[sender]!.toLowerCase(), recipient.address ?? address("external"), "10000", 84532, address("token"), "confirmed"];
    const rows = named
      ? await q(`INSERT INTO ${schema}.${TABLE} (${base}, recipient_handle, recipient_app_user_id, recipient_display_name) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`, [
          ...baseValues,
          recipient.handle ?? null,
          recipient.appUserId ?? null,
          recipient.displayName ?? null,
        ])
      : await q(`INSERT INTO ${schema}.${TABLE} (${base}) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`, baseValues);
    return String(rows[0]!.id);
  }

  /** Independent verification of the final structure in `schema` (the clean scratch apply, the recovered partial apply, and `public`). */
  async function verifyStructure(schema: string) {
    const snap = await snapshot(schema);
    expect(recipientColumns(snap).map((c) => ({ name: c.attname, type: c.type, notNull: c.attnotnull, collation: c.collname, def: c.def, identity: c.attidentity, generated: c.attgenerated }))).toEqual([
      { name: "recipient_app_user_id", type: "text", notNull: false, collation: "default", def: null, identity: "", generated: "" },
      { name: "recipient_handle", type: "text", notNull: false, collation: "C", def: null, identity: "", generated: "" },
      { name: "recipient_display_name", type: "text", notNull: false, collation: "default", def: null, identity: "", generated: "" },
    ]);
    expect(snap.columns.filter((c) => c.tbl === TABLE && c.attname === "recipient_kind")).toEqual([]);

    const keys = recipientConstraints(snap);
    expect(keys.map((k) => k.conname).sort()).toEqual([ACCOUNT_FK, HANDLE_FK, CHECK].sort());
    for (const key of keys) expect(key, key.conname).toMatchObject({ convalidated: true, condeferrable: false, condeferred: false });
    const check = keys.find((k) => k.conname === CHECK)!;
    expect(check.contype).toBe("c");
    expect(check.def).toMatch(/^CHECK \(/);
    expect(check.def).toMatch(/recipient_handle IS NULL.*recipient_app_user_id IS NULL.*recipient_display_name IS NULL.* OR .*recipient_handle IS NOT NULL.*recipient_app_user_id IS NOT NULL/);
    expect(check.def).not.toMatch(/NOT VALID|NOT ENFORCED|NO INHERIT|length/i);
    // NO ACTION is the default and is not printed: an exact match also proves there is no ON UPDATE / ON DELETE clause.
    const ref = `(?:${schema}\\.)?`;
    expect(keys.find((k) => k.conname === ACCOUNT_FK)!.def).toMatch(new RegExp(`^FOREIGN KEY \\(recipient_app_user_id\\) REFERENCES ${ref}real_accounts\\(app_user_id\\)$`));
    expect(keys.find((k) => k.conname === HANDLE_FK)!.def).toMatch(new RegExp(`^FOREIGN KEY \\(recipient_handle\\) REFERENCES ${ref}real_account_handles\\(handle\\)$`));
    const fks = await q(
      `SELECT k.conname, k.confupdtype::text AS upd, k.confdeltype::text AS del, k.confmatchtype::text AS match, rc.relname AS ref_table,
              (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = k.confrelid AND a.attnum = k.confkey[1]) AS ref_column, array_length(k.conkey, 1) AS width,
              (SELECT r.conname FROM pg_constraint r WHERE r.conindid = k.conindid AND r.conrelid = k.confrelid AND r.contype IN ('p', 'u')) AS ref_key
       FROM pg_constraint k JOIN pg_class rc ON rc.oid = k.confrelid WHERE k.conrelid = $1::regclass AND k.contype = 'f' AND k.conname = ANY($2) ORDER BY k.conname`,
      [`${schema}.${TABLE}`, [ACCOUNT_FK, HANDLE_FK]],
    );
    expect(fks).toEqual([
      { conname: ACCOUNT_FK, upd: "a", del: "a", match: "s", ref_table: "real_accounts", ref_column: "app_user_id", width: 1, ref_key: "real_accounts_pkey" },
      { conname: HANDLE_FK, upd: "a", del: "a", match: "s", ref_table: REGISTRY, ref_column: "handle", width: 1, ref_key: "real_account_handles_pkey" },
    ]);
    // No index covers a recipient identity column, and no user trigger exists on the table.
    for (const index of snap.indexes.filter((i) => i.tablename === TABLE)) for (const column of COLUMNS) expect(index.indexdef, index.indexname).not.toContain(column);
    expect(snap.triggers.filter((t) => t.tbl === TABLE)).toEqual([]);
    // The registry keeps exactly its own two keys, two guard triggers, and two indexes — no UNIQUE (handle, app_user_id) appeared.
    expect(snap.constraints.filter((k) => k.tbl === REGISTRY && ["p", "u"].includes(k.contype)).map((k) => k.def).sort()).toEqual(["PRIMARY KEY (handle)", "UNIQUE (app_user_id)"]);
    expect(snap.indexes.filter((i) => i.tablename === REGISTRY).map((i) => i.indexname).sort()).toEqual(["real_account_handles_app_user_id_key", "real_account_handles_pkey"]);
    expect(snap.triggers.filter((t) => t.tbl === REGISTRY).map((t) => t.tgname).sort()).toEqual(["real_account_handles_immutable_row", "real_account_handles_immutable_truncate"]);
    expect(await q(`SELECT c.relname FROM pg_class c WHERE c.relname = 'payment_attempts_recipient_identity_reference'`)).toEqual([]);
    return snap;
  }

  /** Running `run` must be refused, and leave the schema's whole catalog EXACTLY as it was. */
  async function expectRefusedUnchanged(schema: string, run: () => Promise<unknown>, why: RegExp = REFUSED) {
    const before = await snapshot(schema);
    const refusal = await failure(run());
    expect(refusal.message).toMatch(why);
    expect(await snapshot(schema)).toEqual(before);
    return refusal;
  }

  afterAll(async () => {
    try {
      for (const schema of schemas) await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      const left = await q(`SELECT nspname FROM pg_namespace WHERE nspname LIKE $1`, [`prid\\_${runId}\\_%`]);
      facts.scratchSchemasLeft = left.length;
      facts.failures = failures;
      expect(left).toEqual([]);
    } finally {
      const path = process.env.PAYMENT_RECIPIENT_SMOKE_FACTS_PATH;
      if (path) writeFileSync(path, `${JSON.stringify(facts, null, 2)}\n`);
      console.log(`PAYMENT_RECIPIENT_SMOKE_FACTS ${JSON.stringify(facts)}`);
    }
  }, LIVE_TIMEOUT_MS);

  // ================================================================ 1. environment

  live("environment probe: server, role, and the branch's public prerequisites (recorded, no secrets)", async () => {
    const [env] = await q(
      `SELECT version() AS version, current_setting('server_version') AS server_version, current_user::text AS role,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS rolsuper, current_schema()::text AS current_schema`,
    );
    facts.environment = env;
    facts.migrationSha256 = MIGRATION_SHA256;
    expect(env!.current_schema).toBe("public");
    const pre = await snapshot("public");
    const tables = pre.classes.filter((c) => c.relkind === "r").map((c) => c.relname);
    for (const required of [TABLE, "real_accounts", "real_passkeys"]) expect(tables, `public.${required} must exist on the branch`).toContain(required);
    publicHasRegistry = tables.includes(REGISTRY);
    publicMigrated = recipientColumns(pre).length > 0;
    facts.publicState = { registry: publicHasRegistry, recipientIdentity: publicMigrated ? "already migrated" : "pre-migration" };
    if (publicMigrated) await verifyStructure("public");
    else expectNoRecipientObjects(pre);
  });

  // ================================================================ 2. clean apply; old rows; no backfill

  let mainBefore: Snapshot;
  let mainRowsBefore: Record<string, string> = {};

  live("clean scratch apply (1): the columns, the CHECK, and both keys appear; nothing else changes; old rows survive with all three NULL and nothing is back-filled (15, 16)", async () => {
    const schema = await scratch("main", { copyRows: true });
    // Two legacy rows of our own, on top of whatever the branch had.
    await pay(schema);
    await pay(schema, {}, A);
    mainBefore = await snapshot(schema);
    expectNoRecipientObjects(mainBefore);
    mainRowsBefore = await dataHashes(schema, mainBefore);
    facts.scratchPaymentRowsBefore = mainRowsBefore[TABLE]!.split(":")[0];

    await apply(schema);
    const after = await verifyStructure(schema);

    // Every pre-existing row is byte-identical over its pre-existing columns ...
    expect(await dataHashes(schema, after, { withoutRecipientColumns: true })).toEqual(mainRowsBefore);
    // ... and every one of them has all three new columns NULL: nothing was back-filled.
    const [filled] = await q(`SELECT count(*)::int AS rows, count(*) FILTER (WHERE recipient_handle IS NOT NULL OR recipient_app_user_id IS NOT NULL OR recipient_display_name IS NOT NULL)::int AS filled FROM ${schema}.${TABLE}`);
    expect(filled!.rows).toBeGreaterThanOrEqual(2);
    expect(filled!.filled).toBe(0);
    // Structurally, ONLY this migration's objects are new: every other object keeps its identity and definition.
    const strip = (snap: Snapshot) => ({
      classes: snap.classes,
      constraints: snap.constraints.filter((k) => !recipientConstraints(snap).includes(k)),
      indexes: snap.indexes,
      triggers: snap.triggers,
      columns: snap.columns.filter((c) => !recipientColumns(snap).includes(c)),
    });
    expect(strip(after)).toEqual(strip(mainBefore));
    expect(after.indexes).toEqual(mainBefore.indexes); // no new index
  });

  live("a legacy / address payment stays valid (2): an INSERT that does not name the columns, and one that names them all NULL", async () => {
    const schema = scratchName(runId, "main");
    const unnamed = await pay(schema);
    const explicit = await pay(schema, { handle: null, appUserId: null, displayName: null });
    const rows = await q(`SELECT recipient_handle, recipient_app_user_id, recipient_display_name FROM ${schema}.${TABLE} WHERE id = ANY($1::uuid[])`, [[unnamed, explicit]]);
    expect(rows).toEqual([
      { recipient_handle: null, recipient_app_user_id: null, recipient_display_name: null },
      { recipient_handle: null, recipient_app_user_id: null, recipient_display_name: null },
    ]);
  });

  live("the CHECK refuses a handle alone (3), an account alone (4), and a display name alone or with only one of the two (5)", async () => {
    const schema = scratchName(runId, "main");
    for (const [label, recipient] of [
      ["handle only", { handle: "prid_alice" }],
      ["account only", { appUserId: A }],
      ["display name only", { displayName: "Alice" }],
      ["handle + display name", { handle: "prid_alice", displayName: "Alice" }],
      ["account + display name", { appUserId: A, displayName: "Alice" }],
    ] as const) {
      expect(await failure(pay(schema, recipient)), label).toMatchObject({ code: "23514", constraint: CHECK });
    }
  });

  live("a handle payment is accepted with a NULL display name (6) and with one — including for an account that has no active passkey", async () => {
    const schema = scratchName(runId, "main");
    const noName = await pay(schema, { handle: "prid_alice", appUserId: A, address: SAFE_A.toLowerCase() });
    const named = await pay(schema, { handle: "prid_bob", appUserId: B, displayName: "Bob B", address: SAFE[B] }, A);
    // DECIDED FOR SLICE B: receiving does not depend on being able to sign in. @prid_carol's only passkey is revoked.
    expect(await q(`SELECT status FROM ${schema}.real_passkeys WHERE app_user_id = $1`, [C])).toEqual([{ status: "revoked" }]);
    const carol = await pay(schema, { handle: "prid_carol", appUserId: C, address: SAFE[C] });
    const rows = await q(`SELECT id::text AS id, recipient_handle, recipient_display_name FROM ${schema}.${TABLE} WHERE id = ANY($1::uuid[])`, [[noName, named, carol]]);
    expect(rows.find((r) => r.id === noName)).toMatchObject({ recipient_handle: "prid_alice", recipient_display_name: null });
    expect(rows.find((r) => r.id === named)).toMatchObject({ recipient_handle: "prid_bob", recipient_display_name: "Bob B" });
    expect(rows.find((r) => r.id === carol)).toMatchObject({ recipient_handle: "prid_carol" });
    expect(await q(pairIntegrityAuditFor(schema))).toEqual([]); // all three are correct pairs with the right Safe
  });

  live("both foreign keys refuse what they should: an unknown handle (7), an unknown account (8); a reserved handle exists as a row, so only the audit catches it", async () => {
    const schema = scratchName(runId, "main");
    expect(await failure(pay(schema, { handle: "prid_nobody", appUserId: A }))).toMatchObject({ code: "23503", constraint: HANDLE_FK });
    expect(await failure(pay(schema, { handle: "PRID_ALICE", appUserId: A }))).toMatchObject({ code: "23503", constraint: HANDLE_FK }); // exact, case-sensitive ("C")
    expect(await failure(pay(schema, { handle: "prid_alice", appUserId: `prid-${runId}-nobody` }))).toMatchObject({ code: "23503", constraint: ACCOUNT_FK });
    // A RESERVED name is a registry row, so the key alone accepts it: pair integrity is Slice B's job, and the audit flags it.
    const reserved = await pay(schema, { handle: "admin", appUserId: A, address: SAFE_A.toLowerCase() });
    expect((await q(pairIntegrityAuditFor(schema))).map((r) => String(r.id))).toEqual([reserved]);
    await q(`DELETE FROM ${schema}.${TABLE} WHERE id = $1`, [reserved]);
  });

  live("KNOWN NOT ENFORCED (10): a valid handle paired with ANOTHER valid account is accepted by the database — and is exactly what the audit query returns", async () => {
    const schema = scratchName(runId, "main");
    expect(await q(pairIntegrityAuditFor(schema))).toEqual([]);
    // @prid_alice belongs to A; the row claims B.
    const mismatched = await pay(schema, { handle: "prid_alice", appUserId: B, address: SAFE[B] });
    // The right pair, but the money went to an address that is not that account's Safe.
    const wrongAddress = await pay(schema, { handle: "prid_bob", appUserId: B, address: address("somewhere-else") }, A);
    expect((await q(pairIntegrityAuditFor(schema))).map((r) => String(r.id)).sort()).toEqual([mismatched, wrongAddress].sort());
    facts.pairIntegrity = "NOT enforced by the database (by design); the audit query returned exactly the two bad rows";
    await q(`DELETE FROM ${schema}.${TABLE} WHERE id = ANY($1::uuid[])`, [[mismatched, wrongAddress]]);
    expect(await q(pairIntegrityAuditFor(schema))).toEqual([]);
    expect(pairIntegrityAuditFor(schema).replace(new RegExp(`${schema}\\.`, "g"), "")).toBe(PAIR_INTEGRITY_AUDIT_SQL);
  });

  live("the shape Slice B must use: one INSERT ... SELECT deriving account, handle, name, and lower(safe_address) from the database — audit-clean even for a mixed-case Safe", async () => {
    const schema = scratchName(runId, "main");
    // ILLUSTRATIVE ONLY — Slice B's real statement is not written. It shows the three invariants hold together under this schema.
    const derive = (handle: string) =>
      q(
        `INSERT INTO ${schema}.${TABLE} (app_user_id, safe_address, recipient, amount_base_units, chain_id, token_address, state, recipient_app_user_id, recipient_handle, recipient_display_name)
         SELECT $1, $2, lower(a.safe_address), '10000', 84532, $3, 'confirmed', a.app_user_id, h.handle, a.display_name
         FROM ${schema}.${REGISTRY} h JOIN ${schema}.real_accounts a ON a.app_user_id = h.app_user_id
         WHERE h.handle = $4 AND h.kind = 'claimed' RETURNING recipient, recipient_app_user_id, recipient_handle`,
        [B, SAFE[B], address("token"), handle],
      );
    expect(SAFE_A).not.toBe(SAFE_A.toLowerCase());
    expect(await derive("prid_alice")).toEqual([{ recipient: SAFE_A.toLowerCase(), recipient_app_user_id: A, recipient_handle: "prid_alice" }]);
    expect(await derive("prid_carol")).toEqual([{ recipient: SAFE[C], recipient_app_user_id: C, recipient_handle: "prid_carol" }]); // no active passkey: still payable
    expect(await derive("admin")).toEqual([]); // reserved: no row, so nothing is inserted
    expect(await derive("prid_nobody")).toEqual([]);
    expect(await q(pairIntegrityAuditFor(schema))).toEqual([]);
  });

  live("NO ACTION (9): a referenced recipient account cannot be deleted or re-keyed, and a referenced handle cannot be removed even with the registry's own guards off", async () => {
    const schema = scratchName(runId, "main");
    // D is ONLY a recipient id here (no handle, no passkey, never a sender), so nothing but the recipient key protects it.
    // (Pairing D with @prid_alice is the mismatch the database knowingly permits.)
    const row = await pay(schema, { handle: "prid_alice", appUserId: D, address: SAFE[D] });
    expect(await failure(q(`DELETE FROM ${schema}.real_accounts WHERE app_user_id = $1`, [D]))).toMatchObject({ code: "23503", constraint: ACCOUNT_FK });
    expect(await failure(q(`UPDATE ${schema}.real_accounts SET app_user_id = app_user_id || '-x' WHERE app_user_id = $1`, [D]))).toMatchObject({ code: "23503", constraint: ACCOUNT_FK });
    expect(await q(`SELECT recipient_app_user_id FROM ${schema}.${TABLE} WHERE id = $1`, [row])).toEqual([{ recipient_app_user_id: D }]); // not cascaded, not nulled
    // The registry's own triggers refuse UPDATE/DELETE first. With them disabled IN THIS SCRATCH COPY ONLY, the foreign key itself is what refuses.
    const guarded = await failure(q(`DELETE FROM ${schema}.${REGISTRY} WHERE handle = 'prid_alice'`));
    expect(guarded.message).toMatch(/real_account_handles is append-only/);
    const deleted = await failure(tx(`ALTER TABLE ${schema}.${REGISTRY} DISABLE TRIGGER USER`, `DELETE FROM ${schema}.${REGISTRY} WHERE handle = 'prid_alice'`));
    const updated = await failure(tx(`ALTER TABLE ${schema}.${REGISTRY} DISABLE TRIGGER USER`, `UPDATE ${schema}.${REGISTRY} SET handle = 'prid_alice2' WHERE handle = 'prid_alice'`));
    expect(deleted).toMatchObject({ code: "23503", constraint: HANDLE_FK });
    expect(updated).toMatchObject({ code: "23503", constraint: HANDLE_FK });
    // Those transactions rolled back: the guards are still enabled and the handle is still there.
    expect((await snapshot(schema)).triggers.filter((t) => t.tbl === REGISTRY).map((t) => t.tgenabled)).toEqual(["O", "O"]);
    expect(await q(`SELECT handle FROM ${schema}.${REGISTRY} WHERE handle = 'prid_alice'`)).toEqual([{ handle: "prid_alice" }]);
    await q(`DELETE FROM ${schema}.${TABLE} WHERE id = $1`, [row]);
    await q(`DELETE FROM ${schema}.real_accounts WHERE app_user_id = $1`, [D]); // unreferenced now: deletable, so the refusal above was this key's
    await q(`INSERT INTO ${schema}.real_accounts ${ACCOUNT_COLUMNS} VALUES ('${D}', '${D}-sub-org', '${D}-turnkey-user', '${D}-wallet', '${D}-wallet-account', '${address(`owner-${D}`)}', '${SAFE[D]}', 1)`);
  });

  live("idempotence (11): a second run changes no identity, definition, or row; and the Handles block still reruns cleanly AFTER this migration (17)", async () => {
    const schema = scratchName(runId, "main");
    const before = await snapshot(schema);
    const rowsBefore = await dataHashes(schema, before);
    await apply(schema);
    expect(await snapshot(schema)).toEqual(before); // oids included: nothing was dropped and re-created
    await q(retarget(HANDLES_PUBLIC, schema));
    expect(await snapshot(schema)).toEqual(before);
    await apply(schema);
    const after = await verifyStructure(schema);
    expect(after).toEqual(before);
    expect(await dataHashes(schema, after)).toEqual(rowsBefore);
  });

  // ================================================================ 3. fail-closed

  live("without the Handles registry the block refuses, and the columns it had just added are rolled back", async () => {
    const schema = await scratch("no_registry", { registry: false });
    const refusal = await expectRefusedUnchanged(schema, () => apply(schema));
    expect(refusal.message).toMatch(/real_account_handles is missing or is not an ordinary, permanent, non-partition table/);
    expectNoRecipientObjects(await snapshot(schema));
  });

  describe("a wrong pre-existing object is REFUSED, left exactly as it was, and never repaired", () => {
    const hostile = () => scratchName(runId, "hostile");
    const table = () => `${hostile()}.${TABLE}`;
    const addColumns = () => `ALTER TABLE ${table()} ADD COLUMN recipient_app_user_id TEXT, ADD COLUMN recipient_handle TEXT COLLATE "C", ADD COLUMN recipient_display_name TEXT`;
    const addCheck = () => `ALTER TABLE ${table()} ADD CONSTRAINT ${CHECK} CHECK (${CHECK_EXPRESSION})`;
    /** Scratch-only cleanup between cases: the three named constraints (one may not depend on any column), then the columns. */
    const dropColumns = () => `ALTER TABLE ${table()} ${[...[CHECK, ACCOUNT_FK, HANDLE_FK].map((k) => `DROP CONSTRAINT IF EXISTS ${k}`), ...COLUMNS.map((c) => `DROP COLUMN IF EXISTS ${c}`)].join(", ")}`;
    let clean: Snapshot;

    /** Plant `setup`, expect the refusal with the catalog untouched, then remove it and confirm the scratch schema is back to `clean`'s shape. */
    async function refuses(setup: string[], teardown: string[]) {
      await tx(...setup);
      await expectRefusedUnchanged(hostile(), () => apply(hostile()));
      await tx(...teardown);
      const now = await snapshot(hostile());
      expectNoRecipientObjects(now);
      expect(now.indexes).toEqual(clean.indexes);
      expect(now.triggers).toEqual(clean.triggers);
    }

    live("setup: a scratch schema with the registry and no recipient identity object", async () => {
      await scratch("hostile");
      clean = await snapshot(hostile());
      expectNoRecipientObjects(clean);
    });

    // (12) Each wrong column shape. The block adds the OTHER two columns first, so the rollback is exercised every time.
    for (const [label, definition] of [
      ["the handle column with the default collation instead of \"C\"", "recipient_handle TEXT"],
      ["the account column with \"C\" collation", 'recipient_app_user_id TEXT COLLATE "C"'],
      ["the display name with \"C\" collation", 'recipient_display_name TEXT COLLATE "C"'],
      ["varchar(20) instead of text", 'recipient_handle VARCHAR(20) COLLATE "C"'],
      ["unbounded varchar instead of text", "recipient_display_name VARCHAR"],
      ["uuid instead of text", "recipient_app_user_id UUID"],
      ["an array", 'recipient_handle TEXT[] COLLATE "C"'],
      ["NOT NULL", "recipient_display_name TEXT NOT NULL"],
      ["a DEFAULT", "recipient_display_name TEXT DEFAULT ''"],
      ["a stored generated column", "recipient_app_user_id TEXT GENERATED ALWAYS AS (app_user_id) STORED"],
    ] as const) {
      live(`wrong pre-existing column (12) — ${label}`, async () => {
        await refuses([`ALTER TABLE ${table()} ADD COLUMN ${definition}`], [dropColumns()]);
      });
    }

    // (13) A same-named CHECK that is weaker, different, or not validated.
    for (const [label, definition] of [
      ["always true", "CHECK (true)"],
      ["only the first branch", "CHECK (recipient_handle IS NULL AND recipient_app_user_id IS NULL AND recipient_display_name IS NULL)"],
      ["a handle no longer requires an account", "CHECK ((recipient_handle IS NULL AND recipient_app_user_id IS NULL AND recipient_display_name IS NULL) OR recipient_handle IS NOT NULL)"],
      ["the display name left out of the all-NULL branch", "CHECK ((recipient_handle IS NULL AND recipient_app_user_id IS NULL) OR (recipient_handle IS NOT NULL AND recipient_app_user_id IS NOT NULL))"],
      ["the intended expression, NOT VALID", `CHECK (${CHECK_EXPRESSION}) NOT VALID`],
      ["the intended expression, NO INHERIT", `CHECK (${CHECK_EXPRESSION}) NO INHERIT`],
    ] as const) {
      live(`weaker same-named CHECK (13) — ${label}`, async () => {
        await refuses([addColumns(), `ALTER TABLE ${table()} ADD CONSTRAINT ${CHECK} ${definition}`], [dropColumns()]);
      });
    }

    live("same-named CHECK that is NOT ENFORCED (13; PostgreSQL 18+ — recorded as skipped where the syntax does not exist)", async () => {
      await tx(addColumns());
      const planted = await q(`ALTER TABLE ${table()} ADD CONSTRAINT ${CHECK} CHECK (${CHECK_EXPRESSION}) NOT ENFORCED`).then(
        () => true,
        () => false,
      );
      facts.notEnforcedCheck = planted ? "refused" : "syntax unavailable on this server (skipped)";
      if (planted) await expectRefusedUnchanged(hostile(), () => apply(hostile()));
      await tx(dropColumns());
    });

    // (14) A same-named foreign key that cascades, nulls, defers, is not validated, or points elsewhere.
    const account = (clause: string) => `ALTER TABLE ${table()} ADD CONSTRAINT ${ACCOUNT_FK} FOREIGN KEY (recipient_app_user_id) REFERENCES ${hostile()}.real_accounts (app_user_id) ${clause}`;
    const handle = (clause: string) => `ALTER TABLE ${table()} ADD CONSTRAINT ${HANDLE_FK} FOREIGN KEY (recipient_handle) REFERENCES ${hostile()}.${REGISTRY} (handle) ${clause}`;
    for (const [label, statement] of [
      ["account key ON DELETE CASCADE", () => account("ON DELETE CASCADE")],
      ["account key ON UPDATE CASCADE", () => account("ON UPDATE CASCADE")],
      ["account key ON DELETE SET NULL", () => account("ON DELETE SET NULL")],
      ["account key ON DELETE RESTRICT", () => account("ON DELETE RESTRICT")],
      ["account key DEFERRABLE INITIALLY DEFERRED", () => account("DEFERRABLE INITIALLY DEFERRED")],
      ["account key DEFERRABLE", () => account("DEFERRABLE")],
      ["account key NOT VALID", () => account("NOT VALID")],
      ["account key MATCH FULL", () => account("MATCH FULL")],
      ["account key from the wrong column", () => `ALTER TABLE ${table()} ADD CONSTRAINT ${ACCOUNT_FK} FOREIGN KEY (recipient_display_name) REFERENCES ${hostile()}.real_accounts (app_user_id)`],
      ["account key to the wrong table", () => `ALTER TABLE ${table()} ADD CONSTRAINT ${ACCOUNT_FK} FOREIGN KEY (recipient_app_user_id) REFERENCES ${hostile()}.real_passkeys (credential_id)`],
      ["a CHECK under the account key's name", () => `ALTER TABLE ${table()} ADD CONSTRAINT ${ACCOUNT_FK} CHECK (recipient_app_user_id IS NULL OR recipient_app_user_id <> '')`],
      ["handle key ON DELETE CASCADE", () => handle("ON DELETE CASCADE")],
      ["handle key ON UPDATE CASCADE", () => handle("ON UPDATE CASCADE")],
      ["handle key ON DELETE SET NULL", () => handle("ON DELETE SET NULL")],
      ["handle key NOT VALID", () => handle("NOT VALID")],
      ["handle key to the account table", () => `ALTER TABLE ${table()} ADD CONSTRAINT ${HANDLE_FK} FOREIGN KEY (recipient_handle) REFERENCES ${hostile()}.real_accounts (app_user_id)`],
    ] as const) {
      live(`wrong same-named foreign key (14) — ${label}`, async () => {
        await refuses([addColumns(), addCheck(), statement()], [dropColumns()]);
      });
    }

    // Anything ELSE hanging off the three columns, under any name.
    for (const [label, statement, cleanup] of [
      ["a second, cascading foreign key under another name", () => `ALTER TABLE ${table()} ADD CONSTRAINT prid_extra_fk FOREIGN KEY (recipient_app_user_id) REFERENCES ${hostile()}.real_accounts (app_user_id) ON DELETE CASCADE`, null],
      ["a second CHECK on the display name", () => `ALTER TABLE ${table()} ADD CONSTRAINT prid_extra_check CHECK (recipient_display_name IS NULL OR recipient_display_name <> '')`, null],
      ["an index on the handle column", () => `CREATE INDEX prid_extra_idx ON ${table()} (recipient_handle)`, null],
      ["an expression index over the account column", () => `CREATE INDEX prid_extra_expr_idx ON ${table()} (lower(recipient_app_user_id))`, null],
      ["a view reading the display name", () => `CREATE VIEW ${hostile()}.prid_extra_view AS SELECT id, recipient_display_name FROM ${table()}`, () => `DROP VIEW ${hostile()}.prid_extra_view`],
    ] as const) {
      live(`an unexpected dependent object — ${label}`, async () => {
        await refuses([addColumns(), statement()], [...(cleanup ? [cleanup()] : []), dropColumns()]);
      });
    }

    live("partial failure is recoverable: a hostile key is refused, the cause is removed by hand, and a clean run completes", async () => {
      await tx(addColumns(), addCheck(), account("ON DELETE CASCADE"));
      await expectRefusedUnchanged(hostile(), () => apply(hostile()));
      await q(`ALTER TABLE ${table()} DROP CONSTRAINT ${ACCOUNT_FK}`);
      await apply(hostile()); // the hand-made columns and CHECK are exactly the intended ones, so they are accepted and only the keys are added
      await verifyStructure(hostile());
      const before = await snapshot(hostile());
      await apply(hostile());
      expect(await snapshot(hostile())).toEqual(before);
    });
  });

  // ================================================================ 4. the branch's public

  it.skipIf(!publicEnabled)(
    "DISPOSABLE BRANCH public: the unmodified block applies (or reruns), existing rows are untouched and not back-filled, a second run changes nothing, and the Handles block reruns after it",
    async () => {
      if (failures > 0) throw new Error(`the public apply was NOT attempted: ${failures} scratch test(s) failed`);
      try {
        if (!publicHasRegistry) throw new Error("the branch's public has no real_account_handles: apply the Account Handles migration to the branch first");
        const before = await snapshot("public");
        const rowsBefore = await dataHashes("public", before, { withoutRecipientColumns: true });
        await q(RECIPIENT_PUBLIC);
        const after = await verifyStructure("public");
        expect(await dataHashes("public", after, { withoutRecipientColumns: true })).toEqual(rowsBefore);
        if (publicMigrated) expect(after).toEqual(before);
        else {
          const [filled] = await q(`SELECT count(*) FILTER (WHERE recipient_handle IS NOT NULL OR recipient_app_user_id IS NOT NULL OR recipient_display_name IS NOT NULL)::int AS filled FROM public.${TABLE}`);
          expect(filled!.filled).toBe(0);
        }
        const rowsAfter = await dataHashes("public", after);
        await q(RECIPIENT_PUBLIC);
        expect(await snapshot("public")).toEqual(after);
        await q(HANDLES_PUBLIC);
        expect(await snapshot("public")).toEqual(after);
        expect(await dataHashes("public", after)).toEqual(rowsAfter);
        expect(await q(PAIR_INTEGRITY_AUDIT_SQL)).toEqual([]);
        facts.publicApply = { state: publicMigrated ? "rerun on an already-migrated public" : "first apply + idempotent rerun", paymentRows: rowsAfter[TABLE]!.split(":")[0], auditRows: 0 };
      } catch (error) {
        failures += 1;
        throw error;
      }
    },
    LIVE_TIMEOUT_MS,
  );
});
