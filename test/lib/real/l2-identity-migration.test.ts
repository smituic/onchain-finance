import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCOUNT_IDENTITY_UNIQUE_INDEXES } from "@/lib/real/server/neon-store";

/**
 * S5 L2: the real_accounts identity-index migration (schema.sql), checked
 * statically — no Postgres runs offline. Its BEHAVIOR (every wrong
 * pre-existing definition refused, duplicates refused, clean creation,
 * idempotent rerun) is proven by l2-identity-migration.smoke.test.ts, which
 * runs this exact block against a scratch schema (gated, live).
 */
const schema = readFileSync("lib/real/server/schema.sql", "utf8");
const begin = schema.indexOf("-- BEGIN S5 L2 identity-index migration");
const end = schema.indexOf("-- END S5 L2 identity-index migration");
const block = schema.slice(begin, end);
const code = block
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const statementsOutside = (schema.slice(0, begin) + schema.slice(end))
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const COLUMNS = ["sub_organization_id", "owner_address", "safe_address"] as const;
const at = (needle: string) => {
  const i = code.indexOf(needle);
  expect(i, needle).toBeGreaterThan(-1);
  return i;
};

describe("S5 L2 identity-index migration (schema.sql structure)", () => {
  it("is ONE DO block, after every real_accounts definition/migration; it never drops, repairs, or rewrites data", () => {
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    expect(code.match(/DO \$\$/g)).toHaveLength(1);
    expect(code.match(/END \$\$;/g)).toHaveLength(1);
    expect(begin).toBeGreaterThan(schema.lastIndexOf("ALTER TABLE real_accounts"));
    expect(code).not.toMatch(/\b(DROP|DELETE|UPDATE|INSERT|TRUNCATE|ALTER|REINDEX)\b/i);
  });

  it("names its schema exactly once (the target_schema constant) — every lookup goes through it", () => {
    expect(code.match(/'public'/g)).toHaveLength(1);
    at("target_schema CONSTANT pg_catalog.text := 'public';");
    at("tbl := to_regclass(format('%I.real_accounts', target_schema));");
    at("WHERE n.nspname = target_schema AND c.relname = identity[1];");
    expect(code).not.toMatch(/to_regclass\('real_accounts/); // never an unqualified, search_path-dependent lookup
  });

  it("targets exactly the three intended (index, column) pairs, matching neon-store's identity index names", () => {
    expect([...ACCOUNT_IDENTITY_UNIQUE_INDEXES]).toEqual(COLUMNS.map((c) => `real_accounts_${c}_lower_key`));
    const pairs = [...code.matchAll(/\['(real_accounts_\w+_lower_key)', '(\w+)'\]/g)].map((m) => [m[1], m[2]]);
    expect(pairs).toEqual(COLUMNS.map((c) => [`real_accounts_${c}_lower_key`, c]));
    for (const name of ACCOUNT_IDENTITY_UNIQUE_INDEXES) expect(statementsOutside).not.toContain(name);
  });

  it("ALWAYS locks and re-checks duplicates (never skipped because the names exist), before anything is created", () => {
    expect(code).not.toMatch(/to_regclass\('real_accounts_/); // no name-existence short-circuit
    const missingTable = at("IF tbl IS NULL THEN");
    const lock = at("EXECUTE format('LOCK TABLE %s IN SHARE ROW EXCLUSIVE MODE', tbl);");
    const duplicates = at("GROUP BY pg_catalog.lower(%I) HAVING count(*) > 1");
    const raiseDuplicate = at("RAISE EXCEPTION 'S5 L2 migration refused: two accounts share a %");
    // The RAISE is guarded by exactly the duplicate probe's result — and nothing else.
    expect(code).toContain("INTO duplicate;\n    IF duplicate IS NOT NULL THEN\n      RAISE EXCEPTION 'S5 L2 migration refused: two accounts share a %");
    const create = at("CREATE UNIQUE INDEX IF NOT EXISTS %I ON %s (pg_catalog.lower(%I))");
    expect(missingTable).toBeLessThan(lock);
    expect(lock).toBeLessThan(duplicates);
    expect(duplicates).toBeLessThan(raiseDuplicate);
    expect(raiseDuplicate).toBeLessThan(create);
    // The lock is at the top level of the block, not inside a conditional.
    const beforeLock = code.slice(code.indexOf("BEGIN"), lock);
    expect(beforeLock.match(/(?<!END )\bIF\b/g)?.length).toBe(beforeLock.match(/\bEND IF;/g)?.length);
  });

  it("validates every expected index against the catalog AFTER creating — IF NOT EXISTS is never trusted", () => {
    const create = at("CREATE UNIQUE INDEX IF NOT EXISTS");
    const validate = at("FROM pg_catalog.pg_class c");
    expect(validate).toBeGreaterThan(create);
    expect(code.match(/FOREACH identity SLICE 1 IN ARRAY identities LOOP/g)).toHaveLength(3); // duplicates, create, validate
  });

  // Each required property, one by one — removing any of them fails this test.
  it.each([
    ["the object exists in the target schema", "IF ix.oid IS NULL OR col_attnum IS NULL"],
    ["it is an index (not a same-named table/sequence/view)", "OR ix.relkind IS DISTINCT FROM 'i'"],
    ["on public.real_accounts (not another table)", "OR ix.indrelid IS DISTINCT FROM tbl"],
    ["btree", "OR ix.amname IS DISTINCT FROM 'btree'"],
    ["UNIQUE", "OR ix.indisunique IS NOT TRUE"],
    ["VALID", "OR ix.indisvalid IS NOT TRUE"],
    ["READY", "OR ix.indisready IS NOT TRUE"],
    ["immediate (not deferrable)", "OR ix.indimmediate IS NOT TRUE"],
    ["not an exclusion index", "OR ix.indisexclusion IS NOT FALSE"],
    ["not partial", "OR ix.not_partial IS NOT TRUE"],
    ["exactly one column", "OR ix.indnatts IS DISTINCT FROM 1"],
    ["exactly one key column", "OR ix.indnkeyatts IS DISTINCT FROM 1"],
    ["the key is an expression, not a raw column", "OR ix.key0 IS DISTINCT FROM 0"],
    ["the expression is exactly lower(<intended column>)", "OR ix.expr IS DISTINCT FROM format('lower(%I)', identity[2])"],
    ["the expression references exactly one column", "OR ix.column_deps IS DISTINCT FROM 1"],
    ["... and it is the intended column", "OR ix.intended_column_deps IS DISTINCT FROM 1"],
    ["no dependency on anything but its own table/column (a user-defined lower(), type, collation, or opclass is always recorded; built-ins never are)", "OR ix.foreign_deps IS DISTINCT FROM 0"],
    ["the column is pg_catalog.text (the argument type lower(text) is proven for)", "OR col_type IS DISTINCT FROM 'pg_catalog.text'::pg_catalog.regtype"],
    ["default operator class (default equality)", "OR ix.opcdefault IS NOT TRUE"],
    ["deterministic collation (byte equality, no case-insensitive collation)", "OR ix.collisdeterministic IS NOT TRUE"],
  ])("validation requires: %s", (_label, predicate) => {
    const validation = code.slice(at("FROM pg_catalog.pg_class c"), at("RAISE EXCEPTION 'S5 L2 migration refused: %.% is not exactly UNIQUE"));
    expect(validation).toContain(predicate);
  });

  it("the catalog read is schema-qualified and reads the structural fields it validates", () => {
    for (const needle of [
      "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace",
      "LEFT JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid",
      "pg_catalog.pg_get_expr(i.indexprs, i.indrelid) AS expr",
      "i.indpred IS NULL AS not_partial",
      "i.indkey[0] AS key0",
      "LEFT JOIN pg_catalog.pg_opclass opc ON opc.oid = i.indclass[0]",
      "LEFT JOIN pg_catalog.pg_collation coll ON coll.oid = i.indcollation[0]",
      "d.refobjsubid = col_attnum) AS intended_column_deps,",
      "AND NOT (d.refclassid = 'pg_catalog.pg_class'::regclass AND d.refobjid = tbl)) AS foreign_deps",
      "SELECT a.attnum, a.atttypid INTO col_attnum, col_type FROM pg_catalog.pg_attribute a",
      "WHERE a.attrelid = tbl AND a.attname = identity[2] AND NOT a.attisdropped",
    ]) at(needle);
  });

  it("documents the read-only pre-checks for each identity", () => {
    const comments = schema.slice(schema.lastIndexOf("-- Slice S5 L2 hand-applied migration", begin), begin);
    for (const column of COLUMNS) expect(comments).toContain(`SELECT lower(${column}), count(*) FROM real_accounts GROUP BY 1 HAVING count(*) > 1;`);
  });
});

describe("S5 L2 M1: the migration proves it uses the BUILT-IN pg_catalog.lower(text), whatever the caller's search_path", () => {
  it("pins a trusted search_path as its FIRST statement, transaction-local, before any name is resolved", () => {
    const body = code.slice(code.indexOf("BEGIN"));
    const firstStatement = body.slice("BEGIN".length).trim().split(";")[0];
    expect(firstStatement).toBe("PERFORM pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)");
    expect(code.match(/set_config\(/g)).toHaveLength(1);
  });

  it("resolves the intended function schema-qualified, requires it to be a built-in, and requires unqualified lower(text) to resolve to it", () => {
    const resolve = at("lower_fn := pg_catalog.to_regprocedure('pg_catalog.lower(pg_catalog.text)');");
    const check = at("IF lower_fn IS NULL OR lower_fn::pg_catalog.oid >= 16384::pg_catalog.oid");
    at("OR pg_catalog.to_regprocedure('lower(text)') IS DISTINCT FROM lower_fn THEN");
    expect(at("PERFORM pg_catalog.set_config")).toBeLessThan(resolve);
    expect(resolve).toBeLessThan(check);
    expect(check).toBeLessThan(at("tbl := to_regclass("));
  });

  it("every DECLAREd type is schema-qualified (declarations resolve BEFORE the pin)", () => {
    const declare = code.slice(code.indexOf("DECLARE"), code.indexOf("BEGIN"));
    const declarations = [...declare.matchAll(/^\s+(\w+)(?: CONSTANT)? ([\w.]+(?:\[\])?)/gm)].map((m) => [m[1]!, m[2]!] as const);
    // Every variable the block declares — no exemptions, the record included.
    expect(declarations.map(([name]) => name)).toEqual(["target_schema", "identities", "tbl", "identity", "duplicate", "col_attnum", "col_type", "lower_fn", "ix"]);
    for (const [name, type] of declarations) expect(type.startsWith("pg_catalog."), `${name} ${type}`).toBe(true);
    expect(declarations).toContainEqual(["ix", "pg_catalog.record"]);
  });

  it("creates and de-duplicates with the schema-qualified built-in, never an unqualified lower()", () => {
    at("CREATE UNIQUE INDEX IF NOT EXISTS %I ON %s (pg_catalog.lower(%I))");
    at("GROUP BY pg_catalog.lower(%I) HAVING count(*) > 1");
    // Outside string literals, every lower( call is pg_catalog-qualified...
    const withoutLiterals = code.replace(/'(?:[^']|'')*'/g, "''");
    expect(withoutLiterals.match(/(?<![\w.])lower\(/g)).toBeNull();
    // ...and the unqualified spellings that do appear are data compared/resolved under the pinned path.
    at("OR ix.expr IS DISTINCT FROM format('lower(%I)', identity[2])");
    at("pg_catalog.to_regprocedure('lower(text)')");
  });

  it("never relies on a pg_depend edge to the built-in (pinned objects are not recorded), and never parses the internal node tree", () => {
    expect(code).not.toMatch(/refobjid\s*=\s*lower_fn/);
    expect(code).not.toMatch(/indexprs::(pg_catalog\.)?text|FUNCEXPR|:funcid/);
  });
});

describe("S5 L2: smoke fixtures stay compatible with the identity indexes", () => {
  const smoke = readFileSync("test/lib/real/neon-smoke.test.ts", "utf8");

  it("every real_accounts row the smoke suites write derives sub-org/owner/Safe from its own app user (smokeIdentity), never a shared literal", () => {
    const inserts = [...smoke.matchAll(/INSERT INTO real_accounts \([^)]*\)\s*VALUES \(([^;]*?)\)\s*`/g)].map((m) => m[1]!);
    expect(inserts.length).toBeGreaterThan(0);
    for (const values of inserts) {
      for (const field of ["subOrganizationId", "ownerAddress", "safeAddress"]) expect(values, values).toMatch(new RegExp(`(identity|smokeIdentity\\(\\w+\\))\\.${field}`));
    }
    expect(smoke).toMatch(/subOrganizationId: `\$\{userId\}-sub-org`/);
    expect(smoke).toMatch(/digest\("hex"\)\.slice\(0, 40\)/); // owner/Safe hashed from the app user id
  });
});
