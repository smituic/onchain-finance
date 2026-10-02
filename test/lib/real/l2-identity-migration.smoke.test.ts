// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

/**
 * MANUAL, LIVE-DATABASE behavioral proof of schema.sql's S5 L2
 * identity-index migration. Runs the EXACT migration block — only its
 * `target_schema` constant swapped — against throwaway scratch schemas
 * (`l2mig_<run>_<case>`), each holding a minimal real_accounts table, then
 * drops them. It never touches `public` (asserted). Never runs in normal
 * `pnpm test`: it needs DATABASE_URL AND an explicit opt-in. Prefer a Neon
 * branch.
 *
 *   REAL_SMOKE_L2_MIGRATION=1 DATABASE_URL="postgres://..." \
 *     pnpm exec vitest run test/lib/real/l2-identity-migration.smoke.test.ts
 */
const enabled = process.env.REAL_SMOKE_L2_MIGRATION === "1" && Boolean(process.env.DATABASE_URL);
const NAMES = ["real_accounts_sub_organization_id_lower_key", "real_accounts_owner_address_lower_key", "real_accounts_safe_address_lower_key"];

const schemaSql = readFileSync("lib/real/server/schema.sql", "utf8");
const block = schemaSql.slice(schemaSql.indexOf("-- BEGIN S5 L2 identity-index migration"), schemaSql.indexOf("-- END S5 L2 identity-index migration"));
function migrationFor(schema: string): string {
  const constant = "target_schema CONSTANT pg_catalog.text := 'public';";
  expect(block.split(constant)).toHaveLength(2);
  const body = block.replace(constant, `target_schema CONSTANT pg_catalog.text := '${schema}';`);
  expect(body).not.toContain("'public'");
  return body.slice(body.indexOf("DO $$"));
}

/**
 * Scratch schema names are LOWERCASED once, here: Postgres folds an unquoted
 * CREATE SCHEMA identifier to lowercase, while the migration block quotes the
 * name it is given (format('%I', ...)), so a mixed-case name would make the
 * migration look up a schema that doesn't exist and fail for the wrong reason.
 */
function scratchSchemaName(runId: string, name: string): string {
  return `l2mig_${runId}_${name}`.toLowerCase();
}
const VALID_UNQUOTED_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

// Each: a same-named object with the WRONG definition must refuse the whole migration and never be repaired.
const WRONG_DEFINITIONS: Array<[string, (schema: string) => string]> = [
  ["non-unique index", (s) => `CREATE INDEX ${NAMES[1]} ON ${s}.real_accounts (lower(owner_address))`],
  ["unique index on the raw column", (s) => `CREATE UNIQUE INDEX ${NAMES[1]} ON ${s}.real_accounts (owner_address)`],
  ["unique lower() of the wrong column", (s) => `CREATE UNIQUE INDEX ${NAMES[1]} ON ${s}.real_accounts (lower(safe_address))`],
  ["unique index on another table", (s) => `CREATE UNIQUE INDEX ${NAMES[1]} ON ${s}.decoy (lower(owner_address))`],
  ["partial unique index", (s) => `CREATE UNIQUE INDEX ${NAMES[1]} ON ${s}.real_accounts (lower(owner_address)) WHERE app_user_id <> ''`],
  ["two-key unique index", (s) => `CREATE UNIQUE INDEX ${NAMES[1]} ON ${s}.real_accounts (lower(owner_address), app_user_id)`],
  ["unique index with an INCLUDE column", (s) => `CREATE UNIQUE INDEX ${NAMES[1]} ON ${s}.real_accounts (lower(owner_address)) INCLUDE (app_user_id)`],
  ["unique upper() instead of lower()", (s) => `CREATE UNIQUE INDEX ${NAMES[1]} ON ${s}.real_accounts (upper(owner_address))`],
  ["a same-named TABLE", (s) => `CREATE TABLE ${s}.${NAMES[1]} (x int)`],
];
const wrongCaseName = (label: string) => `wrong_${label.replace(/\W+/g, "_").slice(0, 24)}`;
const FIXED_CASE_NAMES = ["clean", "dup_sub", "dup_owner", "dup_safe", "dup_names_exist", "invalid", "mixed", "decoy_schema", "target_schema", "shadow_attack", "shadow_attack_fn", "shadow_clean", "shadow_clean_fn"];

// Offline (never gated): every scratch schema this suite can create is a valid, already-lowercase unquoted identifier.
describe("S5 L2 migration smoke harness: scratch schema names", () => {
  it("are lowercase, valid unquoted identifiers that Postgres will not fold — including the mixed-case labels", () => {
    const runId = randomUUID().replace(/-/g, "").slice(0, 8);
    const names = [...FIXED_CASE_NAMES, ...WRONG_DEFINITIONS.map(([label]) => wrongCaseName(label))].map((name) => scratchSchemaName(runId, name));
    expect(WRONG_DEFINITIONS.some(([label]) => wrongCaseName(label) !== wrongCaseName(label).toLowerCase())).toBe(true); // the case this guards
    for (const name of names) {
      expect(name, name).toMatch(VALID_UNQUOTED_IDENTIFIER);
      expect(name, name).toBe(name.toLowerCase());
    }
    expect(new Set(names).size).toBe(names.length);
  });
});

/** Live cases make many Neon round trips (schema setup, migration, catalog reads); well beyond Vitest's 5 s default. */
const LIVE_TIMEOUT_MS = 60_000;

describe.skipIf(!enabled)("S5 L2 identity-index migration — behavior against scratch schemas (live)", () => {
  const runId = randomUUID().replace(/-/g, "").slice(0, 8);
  const schemas = new Set<string>();
  const sqlFn = async () => {
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    return createNeonSqlClient(process.env.DATABASE_URL!);
  };
  const q = async (text: string, params: unknown[] = []) => (await sqlFn()).query(text, params) as Promise<Array<Record<string, unknown>>>;

  afterAll(async () => {
    for (const schema of schemas) await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }, LIVE_TIMEOUT_MS);

  /** A fresh scratch schema with a minimal real_accounts and the given rows. */
  async function scratch(name: string, rows: Array<[string, string, string, string]> = [["u1", "sub-1", "0xaa", "0xbb"], ["u2", "sub-2", "0xcc", "0xdd"]]) {
    const schema = scratchSchemaName(runId, name);
    expect(schema).toMatch(VALID_UNQUOTED_IDENTIFIER);
    schemas.add(schema);
    await q(`CREATE SCHEMA ${schema}`);
    await q(`CREATE TABLE ${schema}.real_accounts (app_user_id text PRIMARY KEY, sub_organization_id text NOT NULL, owner_address text NOT NULL, safe_address text NOT NULL)`);
    for (const row of rows) await q(`INSERT INTO ${schema}.real_accounts VALUES ($1, $2, $3, $4)`, row);
    return schema;
  }
  const migrate = (schema: string) => q(migrationFor(schema));
  const indexes = async (schema: string) =>
    (await q(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'i' AND c.relname LIKE 'real_accounts_%_lower_key' ORDER BY 1`, [schema])).map((r) => r.relname);
  const refused = (schema: string, why: RegExp) => expect(migrate(schema)).rejects.toThrow(why);
  const objects = (schema: string) =>
    q(`SELECT c.relname, c.relkind, pg_get_indexdef(c.oid) AS def FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 ORDER BY 1`, [schema]);

  /** A schema holding a look-alike IMMUTABLE lower(text) that returns its input unchanged, and the hostile search_path that puts it before pg_catalog. */
  async function shadowLower(name: string) {
    const shadow = scratchSchemaName(runId, name);
    expect(shadow).toMatch(VALID_UNQUOTED_IDENTIFIER);
    schemas.add(shadow);
    await q(`CREATE SCHEMA ${shadow}`);
    await q(`CREATE FUNCTION ${shadow}.lower(text) RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT $1'`);
    return { shadow, hostile: `SET LOCAL search_path = ${shadow}, pg_catalog` };
  }
  /** Runs statements in ONE transaction, so the hostile SET LOCAL governs everything after it. */
  const inOneTransaction = async (...statements: string[]) => {
    const sql = await sqlFn();
    return (await sql.transaction(statements.map((text) => sql.query(text)))) as Array<Array<Record<string, unknown>>>;
  };

  it("clean data: creates exactly the three correct indexes; a rerun succeeds and changes nothing; they then enforce case-insensitive uniqueness", async () => {
    const schema = await scratch("clean");
    await migrate(schema);
    expect(await indexes(schema)).toEqual([...NAMES].sort());
    const defs = await q(`SELECT indexdef FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname`, [schema]);
    expect(defs.filter((d) => /_lower_key/.test(String(d.indexdef))).map((d) => String(d.indexdef).replace(/^.* USING /, ""))).toEqual(["btree (lower(owner_address))", "btree (lower(safe_address))", "btree (lower(sub_organization_id))"]);
    await migrate(schema);
    expect(await indexes(schema)).toEqual([...NAMES].sort());
    await expect(q(`INSERT INTO ${schema}.real_accounts VALUES ('u3', 'SUB-1', '0xee', '0xff')`)).rejects.toThrow(/real_accounts_sub_organization_id_lower_key/);
  }, LIVE_TIMEOUT_MS);

  it.each([
    ["sub_organization_id", [["u1", "sub-1", "0xaa", "0xbb"], ["u2", "SUB-1", "0xcc", "0xdd"]]],
    ["owner_address", [["u1", "sub-1", "0xAA", "0xbb"], ["u2", "sub-2", "0xaa", "0xdd"]]],
    ["safe_address", [["u1", "sub-1", "0xaa", "0xBB"], ["u2", "sub-2", "0xcc", "0xbb"]]],
  ] as Array<[string, Array<[string, string, string, string]>]>)("a case-insensitive duplicate %s is refused and nothing is created", async (column, rows) => {
    const schema = await scratch(`dup_${column.split("_")[0]}`, rows);
    await refused(schema, new RegExp(`share a ${column}`));
    expect(await indexes(schema)).toEqual([]);
  }, LIVE_TIMEOUT_MS);

  it("duplicate checks still run when all three names already exist (as wrong, non-unique indexes over duplicate data)", async () => {
    const schema = await scratch("dup_names_exist", [["u1", "sub-1", "0xAA", "0xbb"], ["u2", "sub-2", "0xaa", "0xdd"]]);
    for (const [name, col] of [[NAMES[0], "sub_organization_id"], [NAMES[1], "owner_address"], [NAMES[2], "safe_address"]]) await q(`CREATE INDEX ${name} ON ${schema}.real_accounts (lower(${col}))`);
    await refused(schema, /share a owner_address/);
  }, LIVE_TIMEOUT_MS);

  it.each(WRONG_DEFINITIONS)("same expected name, %s -> refused; the wrong object is left untouched; nothing else is created", async (label, create) => {
    const schema = await scratch(wrongCaseName(label));
    await q(`CREATE TABLE ${schema}.decoy (owner_address text NOT NULL)`);
    await q(create(schema));
    const before = await objects(schema);
    await refused(schema, /is not exactly UNIQUE \(lower\(owner_address\)\)/);
    expect(await objects(schema)).toEqual(before);
  }, LIVE_TIMEOUT_MS);

  it("an INVALID (failed concurrent build) index with the expected name -> refused", async () => {
    const schema = await scratch("invalid", [["u1", "sub-1", "0xaa", "0xbb"], ["u2", "sub-2", "0xAA", "0xdd"]]);
    await expect(q(`CREATE UNIQUE INDEX CONCURRENTLY ${NAMES[1]} ON ${schema}.real_accounts (lower(owner_address))`)).rejects.toThrow();
    expect((await q(`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`, [schema, NAMES[1]]))[0]?.indisvalid).toBe(false);
    await q(`DELETE FROM ${schema}.real_accounts WHERE app_user_id = 'u2'`);
    await refused(schema, /is not exactly UNIQUE \(lower\(owner_address\)\)/);
  }, LIVE_TIMEOUT_MS);

  it("one correct, one wrong, one missing -> refused as a whole: the missing one is NOT left behind, the wrong one is not repaired", async () => {
    const schema = await scratch("mixed");
    await q(`CREATE UNIQUE INDEX ${NAMES[0]} ON ${schema}.real_accounts (lower(sub_organization_id))`);
    await q(`CREATE INDEX ${NAMES[1]} ON ${schema}.real_accounts (lower(owner_address))`);
    await refused(schema, /owner_address/);
    expect(await indexes(schema)).toEqual([NAMES[1], NAMES[0]].sort());
  }, LIVE_TIMEOUT_MS);

  it("M1 ATTACK: a same-named UNIQUE index built on a look-alike lower(text) is refused — even under a hostile search_path where it deparses exactly like the built-in", async () => {
    const schema = await scratch("shadow_attack");
    const { shadow, hostile } = await shadowLower("shadow_attack_fn");
    await q(`CREATE UNIQUE INDEX ${NAMES[1]} ON ${schema}.real_accounts (${shadow}.lower(owner_address))`);

    // The trap is real: under the hostile path the look-alike deparses as plain lower(owner_address)...
    const [, trap] = await inOneTransaction(
      hostile,
      `SELECT pg_catalog.pg_get_expr(i.indexprs, i.indrelid) AS expr FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '${schema}' AND c.relname = '${NAMES[1]}'`,
    );
    expect(trap![0]?.expr).toBe("lower(owner_address)");
    // ...and, unlike a built-in, the user-defined function IS recorded as a dependency.
    const deps = await q(`SELECT count(*)::int AS n FROM pg_depend WHERE classid = 'pg_class'::regclass AND refclassid = 'pg_proc'::regclass AND refobjid = $1::regprocedure`, [`${shadow}.lower(text)`]);
    expect(deps[0]?.n).toBe(1);

    const before = await objects(schema);
    await expect(inOneTransaction(hostile, migrationFor(schema))).rejects.toThrow(/is not exactly UNIQUE \(lower\(owner_address\)\)/);
    await expect(migrate(schema)).rejects.toThrow(/is not exactly UNIQUE \(lower\(owner_address\)\)/); // and under a normal path
    expect(await objects(schema)).toEqual(before); // the wrong object untouched; the two missing indexes NOT left behind
  }, LIVE_TIMEOUT_MS);

  it("M1 CLEAN under the same hostile search_path: the migration builds indexes on the built-in lower (no function dependency) that reject case-only duplicates", async () => {
    const schema = await scratch("shadow_clean");
    const { hostile } = await shadowLower("shadow_clean_fn");

    await inOneTransaction(hostile, migrationFor(schema));

    expect(await indexes(schema)).toEqual([...NAMES].sort());
    const procDeps = await q(
      `SELECT count(*)::int AS n FROM pg_depend d JOIN pg_class c ON c.oid = d.objid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE d.classid = 'pg_class'::regclass AND n.nspname = $1 AND c.relname = ANY($2) AND d.refclassid = 'pg_proc'::regclass`,
      [schema, NAMES],
    );
    expect(procDeps[0]?.n).toBe(0);
    // Functional proof: the identity look-alike would accept these; the built-in folds case and refuses them.
    await expect(q(`INSERT INTO ${schema}.real_accounts VALUES ('u3', 'SUB-1', '0x01', '0x02')`)).rejects.toThrow(/real_accounts_sub_organization_id_lower_key/);
    await expect(q(`INSERT INTO ${schema}.real_accounts VALUES ('u4', 'sub-4', '0xAA', '0x03')`)).rejects.toThrow(/real_accounts_owner_address_lower_key/);
    await expect(q(`INSERT INTO ${schema}.real_accounts VALUES ('u5', 'sub-5', '0x04', '0xBB')`)).rejects.toThrow(/real_accounts_safe_address_lower_key/);
  }, LIVE_TIMEOUT_MS);

  it("a correct-looking index of the same name in ANOTHER schema never counts: the target's own index is created and validated", async () => {
    const decoy = await scratch("decoy_schema");
    const schema = await scratch("target_schema");
    for (const [name, col] of [[NAMES[0], "sub_organization_id"], [NAMES[1], "owner_address"], [NAMES[2], "safe_address"]]) await q(`CREATE UNIQUE INDEX ${name} ON ${decoy}.real_accounts (lower(${col}))`);
    await migrate(schema);
    expect(await indexes(schema)).toEqual([...NAMES].sort());
  }, LIVE_TIMEOUT_MS);
});
