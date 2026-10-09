import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PAIR_INTEGRITY_AUDIT_SQL, pairIntegrityAuditFor } from "./fixtures/payment-recipient-audit";

/**
 * Payment Attempt Recipient Identity: schema.sql's additive payment_attempts
 * migration, checked STATICALLY — no Postgres runs offline. Its BEHAVIOR
 * (clean apply, idempotent rerun, the CHECK and both foreign keys actually
 * refusing rows, every wrong pre-existing object refused) is what
 * payment-recipient-identity-migration.smoke.test.ts proves against a
 * disposable Neon branch (gated, live).
 *
 * This migration is schema only. Handle Pay Slice B — which will write these
 * columns — is NOT built. Three things are decided for it and recorded here
 * so they are not lost:
 *   1. PAIR INTEGRITY is the application's job: the database does not tie
 *      recipient_handle to recipient_app_user_id, so Slice B derives both
 *      from the database inside one atomic INSERT, never from the client.
 *   2. ADDRESS NORMALIZATION: payment_attempts.recipient is lowercase and
 *      real_accounts.safe_address is case-preserving, so Slice B inserts
 *      lower(a.safe_address).
 *   3. PAYABILITY: a claimed handle with a valid account/Safe can receive
 *      Cash whether or not it currently has an active passkey — receiving and
 *      authenticating are separate concerns. Slice B removes the
 *      active-passkey condition from authoritative resolution and aligns the
 *      advisory lookup. Nothing in the lookup changes in this migration.
 */
const schema = readFileSync("lib/real/server/schema.sql", "utf8");
const BEGIN = "-- BEGIN Payment Attempt Recipient Identity";
const END = "-- END Payment Attempt Recipient Identity";
const begin = schema.indexOf(BEGIN);
const end = schema.indexOf(END);
const raw = schema.slice(begin, end);
const withoutComments = (text: string) =>
  text
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
const code = withoutComments(raw);
const flat = code.replace(/\s+/g, " ");
const comments = raw
  .split("\n")
  .filter((line) => line.trim().startsWith("--"))
  .map((line) => line.trim().replace(/^--\s?/, ""))
  .join(" ")
  .replace(/\s+/g, " ");
const sqlOutside = withoutComments(schema.slice(0, begin) + schema.slice(end));
const at = (needle: string) => {
  const i = flat.indexOf(needle);
  expect(i, needle).toBeGreaterThan(-1);
  return i;
};
const COLUMNS = ["recipient_app_user_id", "recipient_handle", "recipient_display_name"] as const;
const CHECK_NAME = "payment_attempts_recipient_identity_check";
const ACCOUNT_FK = "payment_attempts_recipient_app_user_id_fkey";
const HANDLE_FK = "payment_attempts_recipient_handle_fkey";
const CHECK_EXPRESSION =
  "(recipient_handle IS NULL AND recipient_app_user_id IS NULL AND recipient_display_name IS NULL) OR (recipient_handle IS NOT NULL AND recipient_app_user_id IS NOT NULL)";
/** The Handles block's executed text, as proven and applied (ARCHITECTURE.md, "Human-Readable Account Identity (Handles)"). */
const HANDLES_BLOCK_SHA256 = "34c1f258736a9e7ec14e4f6f1f20d8247e06c0890885fedb328ae3259c8d8add";

describe("Payment Attempt Recipient Identity migration (schema.sql structure)", () => {
  it("is ONE DO block AFTER the Handles block and before the provisioning-evidence block (which stays last), with ONE target-schema constant", () => {
    expect(begin).toBeGreaterThan(schema.indexOf("-- END Account Handles"));
    expect(end).toBeGreaterThan(begin);
    expect(schema.indexOf("-- BEGIN Provisioning Evidence Capture")).toBeGreaterThan(end);
    expect(schema.trimEnd().endsWith("-- END Provisioning Evidence Capture")).toBe(true);
    expect(schema.split(BEGIN)).toHaveLength(2);
    expect(schema.split(END)).toHaveLength(2);
    expect(code.trim().startsWith("DO $$")).toBe(true);
    expect(code.trim().endsWith("END $$;")).toBe(true);
    expect(code.match(/DO \$\$/g)).toHaveLength(1);
    expect(raw.match(/'public'/g)).toHaveLength(1);
    at("target_schema CONSTANT pg_catalog.text := 'public';");
    at("table_name CONSTANT pg_catalog.text := 'payment_attempts';");
  });

  it("does not modify the closed Handles block: its executed text still has the proven SHA-256", () => {
    const handles = schema.slice(schema.indexOf("-- BEGIN Account Handles"), schema.indexOf("-- END Account Handles"));
    expect(createHash("sha256").update(handles.slice(handles.indexOf("DO $$")), "utf8").digest("hex")).toBe(HANDLES_BLOCK_SHA256);
  });

  it("pins search_path first and schema-qualifies every declared type", () => {
    expect(flat.slice(flat.indexOf(" BEGIN ") + 1)).toMatch(/^BEGIN PERFORM pg_catalog\.set_config\('search_path', 'pg_catalog, pg_temp', true\);/);
    const declarations = flat.slice(flat.indexOf("DECLARE"), flat.indexOf(" BEGIN "));
    const types = [...declarations.matchAll(/ [a-z_]+ (?:CONSTANT )?([a-z_.0-9]+(?:\[\])?)(?: :=|;)/g)].map((m) => m[1]!);
    expect(types.length).toBeGreaterThanOrEqual(25);
    for (const type of types) expect(type === "record" || type.startsWith("pg_catalog."), type).toBe(true);
    expect(flat).not.toMatch(/to_regclass\(/);
  });

  it("requires payment_attempts, real_accounts, and real_account_handles to be ordinary, permanent, non-partition tables BEFORE anything is added", () => {
    const ordinary = "c.relkind = 'r' AND c.relpersistence = 'p' AND NOT c.relispartition;";
    at(`SELECT c.oid INTO tbl FROM pg_catalog.pg_class c WHERE c.relnamespace = ns AND c.relname = table_name AND ${ordinary}`);
    at(`SELECT c.oid INTO accounts_tbl FROM pg_catalog.pg_class c WHERE c.relnamespace = ns AND c.relname = 'real_accounts' AND ${ordinary}`);
    at(`SELECT c.oid INTO handles_tbl FROM pg_catalog.pg_class c WHERE c.relnamespace = ns AND c.relname = 'real_account_handles' AND ${ordinary}`);
    const refuse = at("IF tbl IS NULL OR accounts_tbl IS NULL OR handles_tbl IS NULL THEN RAISE EXCEPTION");
    at("IF EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid = tbl OR i.inhparent = tbl) THEN RAISE EXCEPTION");
    expect(refuse).toBeLessThan(at("ADD COLUMN IF NOT EXISTS"));
  });
});

describe("the three columns", () => {
  const definitions = [...(/column_definitions CONSTANT pg_catalog\.text\[\] := ARRAY\[([\s\S]*?)\];/.exec(code)?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]);

  it("are exactly recipient_app_user_id TEXT, recipient_handle TEXT COLLATE \"C\", recipient_display_name TEXT — nullable, no default", () => {
    expect(definitions).toEqual(["recipient_app_user_id TEXT", 'recipient_handle TEXT COLLATE "C"', "recipient_display_name TEXT"]);
    for (const definition of definitions) expect(definition).not.toMatch(/NOT NULL|DEFAULT|GENERATED|IDENTITY|REFERENCES|CHECK|UNIQUE|PRIMARY/i);
    expect(definitions.map((d) => d!.split(" ")[0])).toEqual([...COLUMNS]);
  });

  it("each is added with ADD COLUMN IF NOT EXISTS from that one list, and the reference copy is built from the same text", () => {
    at("FOREACH column_definition IN ARRAY column_definitions LOOP EXECUTE format('ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS %s', target_schema, table_name, column_definition); END LOOP;");
    at("EXECUTE format('CREATE TEMPORARY TABLE %I (%s, CONSTRAINT %I CHECK (%s)) ON COMMIT DROP', reference_name, pg_catalog.array_to_string(column_definitions, ', '), check_name, check_expression);");
    expect(flat.match(/ADD COLUMN/g)).toHaveLength(1);
  });

  it("there is no fourth column: no recipient_kind, and no other recipient_* name anywhere in the block's SQL", () => {
    expect(code).not.toMatch(/recipient_kind/);
    const named = new Set([...code.matchAll(/\brecipient_[a-z_]+\b/g)].map((m) => m[0]));
    expect([...named].sort()).toEqual([...COLUMNS].sort());
    // The rejection is recorded, so nobody re-adds it.
    expect(comments).toContain("There is no `recipient_kind` column");
  });

  it("the original CREATE TABLE is not edited to duplicate them, and nothing else in schema.sql names them", () => {
    const table = /CREATE TABLE IF NOT EXISTS payment_attempts \(([\s\S]*?)\n\);/.exec(schema)?.[1] ?? "";
    expect(table).toContain("recipient                            TEXT NOT NULL,");
    for (const column of COLUMNS) {
      expect(table, column).not.toContain(column);
      expect(sqlOutside, column).not.toContain(column);
    }
    for (const name of [CHECK_NAME, ACCOUNT_FK, HANDLE_FK]) expect(sqlOutside, name).not.toContain(name);
  });

  // Each wrong pre-existing shape, and the exact predicate that makes the block RAISE for it.
  const proofStart = flat.indexOf("IF tc.attnum IS NULL OR rc.attnum IS NULL");
  const condition = flat.slice(proofStart, flat.indexOf("THEN RAISE EXCEPTION", proofStart));
  it.each([
    ["the column is missing", "tc.attnum IS NULL"],
    ["a wrong type (varchar, uuid, citext, a domain over text, ...)", "tc.atttypid IS DISTINCT FROM 'pg_catalog.text'::pg_catalog.regtype"],
    ["a type that differs from this server's own TEXT reference", "tc.atttypid IS DISTINCT FROM rc.atttypid"],
    ["a type modifier", "tc.atttypmod IS DISTINCT FROM rc.atttypmod"],
    ["an array column (text[])", "tc.attndims IS DISTINCT FROM rc.attndims"],
    ["a collation other than the reference's", "tc.attcollation IS DISTINCT FROM rc.attcollation"],
    ['a collation other than the built-in one intended ("C" for the handle, the default for the others)', "tc.attcollation IS DISTINCT FROM expected_collation"],
    ["NOT NULL", "tc.attnotnull IS NOT FALSE"],
    ["a DEFAULT (or a generated expression, which is stored as one)", "tc.atthasdef IS NOT FALSE"],
    ["an IDENTITY column", "tc.attidentity IS DISTINCT FROM rc.attidentity"],
    ["a GENERATED column", "tc.attgenerated IS DISTINCT FROM rc.attgenerated"],
    ["a default expression row, whatever atthasdef says", "EXISTS (SELECT 1 FROM pg_catalog.pg_attrdef ad WHERE ad.adrelid = tbl AND ad.adnum = tc.attnum)"],
  ])("hostile column — %s — is refused", (_case, predicate) => {
    expect(proofStart).toBeGreaterThan(at("ADD COLUMN IF NOT EXISTS"));
    expect(condition, predicate).toContain(predicate);
    // Every predicate is an OR-term of the ONE condition guarding the RAISE (no AND could mask it).
    expect(condition).not.toMatch(/\bAND\b(?![^(]*\))/);
  });

  it("the handle column must be exactly pg_catalog's \"C\" collation; the other two exactly pg_catalog's default", () => {
    at("SELECT co.oid INTO c_collation FROM pg_catalog.pg_collation co JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace WHERE cn.nspname = 'pg_catalog' AND co.collname = 'C';");
    at("SELECT co.oid INTO default_collation FROM pg_catalog.pg_collation co JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace WHERE cn.nspname = 'pg_catalog' AND co.collname = 'default';");
    at("expected_collation := CASE WHEN col = 'recipient_handle' THEN c_collation ELSE default_collation END;");
  });
});

describe("the CHECK", () => {
  it(`is named ${CHECK_NAME}, added only when no constraint has that name, from one expression`, () => {
    at(`check_name CONSTANT pg_catalog.text := '${CHECK_NAME}';`);
    at(`check_expression CONSTANT pg_catalog.text := '${CHECK_EXPRESSION}';`);
    const guard = at("IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = tbl AND k.conname = check_name) THEN");
    const add = at("EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK (%s)', target_schema, table_name, check_name, check_expression);");
    expect(guard).toBeLessThan(add);
    expect(add).toBeLessThan(at("INTO ck FROM pg_catalog.pg_constraint k"));
  });

  it("semantics: all three NULL (an address payment), or handle AND account both set (display name optional) — and nothing else", () => {
    // The expression is plain IS [NOT] NULL / AND / OR over the three columns, so it can be evaluated exactly.
    const js = CHECK_EXPRESSION.replace(/(\w+) IS NOT NULL/g, "(v.$1 !== null)").replace(/(\w+) IS NULL/g, "(v.$1 === null)").replace(/\bAND\b/g, "&&").replace(/\bOR\b/g, "||");
    expect(js).not.toMatch(/\bIS\b|\bNULL\b|\bNOT\b/);
    const allows = new Function("v", `return ${js};`) as (v: Record<string, string | null>) => boolean;
    const accepted: string[] = [];
    for (const handle of [null, "smit"]) {
      for (const account of [null, "app-user-1"]) {
        for (const name of [null, "Smit Patel"]) {
          const row = { recipient_handle: handle, recipient_app_user_id: account, recipient_display_name: name };
          expect(allows(row), JSON.stringify(row)).toBe((handle === null && account === null && name === null) || (handle !== null && account !== null));
          if (allows(row)) accepted.push(`${handle ? "H" : "-"}${account ? "A" : "-"}${name ? "N" : "-"}`);
        }
      }
    }
    // Exactly three of the eight states: legacy/address, handle payment without a name, handle payment with one.
    expect(accepted).toEqual(["---", "HA-", "HAN"]);
  });

  it("is proven: validated, enforced, not deferrable, over exactly the three columns, and equal to this server's own deparse of the intended text", () => {
    const start = flat.indexOf("SELECT k.oid INTO ck FROM pg_catalog.pg_constraint k");
    const lookup = flat.slice(start, flat.indexOf("IF ck_ref.oid IS NULL OR ck.oid IS NULL THEN"));
    for (const predicate of [
      "k.conrelid = tbl AND k.conname = check_name AND k.contype = 'c'",
      "AND k.convalidated AND NOT k.condeferrable AND NOT k.condeferred",
      "AND COALESCE((pg_catalog.to_jsonb(k) ->> 'conenforced')::pg_catalog.bool, true)",
      "AND k.connoinherit = ck_ref.connoinherit",
      "FROM pg_catalog.unnest(ARRAY[own_app_user, own_handle, own_display_name]::pg_catalog.int2[]) AS v(attnum))",
      "AND pg_catalog.pg_get_constraintdef(k.oid) = ck_ref.def;",
    ]) {
      expect(lookup, predicate).toContain(predicate);
    }
    at("SELECT k.oid, k.connoinherit, pg_catalog.pg_get_constraintdef(k.oid) AS def INTO ck_ref FROM pg_catalog.pg_constraint k WHERE k.conrelid = ref AND k.conname = check_name AND k.contype = 'c';");
    at("WHERE d.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass AND d.objid = ck.oid AND NOT (d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.refobjid = tbl);");
  });

  it("adds no second display-name length rule (the name is bounded where it is written)", () => {
    expect(code).not.toMatch(/char_length|octet_length|\blength\(|BETWEEN/i);
    expect(flat.match(/ADD CONSTRAINT %I CHECK/g)).toHaveLength(1);
  });
});

describe("the two foreign keys", () => {
  it("are named, direct, single-column, and NO ACTION on update and delete — each added only when no constraint has that name", () => {
    at(`account_fk_name CONSTANT pg_catalog.text := '${ACCOUNT_FK}';`);
    at(`handle_fk_name CONSTANT pg_catalog.text := '${HANDLE_FK}';`);
    const accountGuard = at("IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = tbl AND k.conname = account_fk_name) THEN");
    const accountAdd = at(
      "EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (recipient_app_user_id) REFERENCES %I.real_accounts (app_user_id) ON UPDATE NO ACTION ON DELETE NO ACTION', target_schema, table_name, account_fk_name, target_schema);",
    );
    const handleGuard = at("IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = tbl AND k.conname = handle_fk_name) THEN");
    const handleAdd = at(
      "EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (recipient_handle) REFERENCES %I.real_account_handles (handle) ON UPDATE NO ACTION ON DELETE NO ACTION', target_schema, table_name, handle_fk_name, target_schema);",
    );
    expect(accountGuard).toBeLessThan(accountAdd);
    expect(handleGuard).toBeLessThan(handleAdd);
    expect(flat.match(/FOREIGN KEY \(/g)).toHaveLength(2);
    expect(flat.match(/ON UPDATE NO ACTION ON DELETE NO ACTION/g)).toHaveLength(2);
  });

  it("nothing cascades, sets NULL, defers, or skips validation; there is no composite key and no new unique key", () => {
    expect(code).not.toMatch(/\bCASCADE\b/);
    expect(code).not.toMatch(/SET\s+NULL/);
    expect(code).not.toMatch(/SET\s+DEFAULT/);
    expect(code).not.toMatch(/\bRESTRICT\b/);
    expect(code).not.toMatch(/\bDEFERRABLE\b|\bINITIALLY\b/);
    expect(code).not.toMatch(/NOT VALID|NOT ENFORCED|\bVALIDATE\b/);
    expect(code).not.toMatch(/MATCH (FULL|PARTIAL)/);
    expect(code).not.toMatch(/\bUNIQUE\b|PRIMARY KEY/);
    expect(flat).not.toMatch(/FOREIGN KEY \([a-z_]+,/); // never two source columns
    // The decision not to add UNIQUE (handle, app_user_id) to the closed registry is recorded.
    expect(comments).toContain("PAIR INTEGRITY IS NOT ENFORCED HERE");
  });

  it.each([
    ["account", "account_fk", "account_fk_name", "accounts_tbl", "own_app_user", "accounts_app_user"],
    ["handle", "handle_fk", "handle_fk_name", "handles_tbl", "own_handle", "handles_handle"],
  ])("the %s key is proven structurally: target table and column, NO ACTION both ways, MATCH SIMPLE, validated, enforced, not deferrable, and a plain unique index behind it", (_label, record, name, target, own, targetColumn) => {
    const start = flat.indexOf(`SELECT k.oid, k.conindid INTO ${record} FROM pg_catalog.pg_constraint k`);
    expect(start).toBeGreaterThan(at("ON UPDATE NO ACTION ON DELETE NO ACTION"));
    const proof = flat.slice(start, flat.indexOf("THEN RAISE EXCEPTION", start));
    for (const predicate of [
      `k.conrelid = tbl AND k.conname = ${name} AND k.contype = 'f'`,
      "AND k.convalidated AND NOT k.condeferrable AND NOT k.condeferred",
      "AND COALESCE((pg_catalog.to_jsonb(k) ->> 'conenforced')::pg_catalog.bool, true)",
      "AND NOT COALESCE((pg_catalog.to_jsonb(k) ->> 'conperiod')::pg_catalog.bool, false)",
      `AND k.confrelid = ${target} AND k.confupdtype = 'a' AND k.confdeltype = 'a' AND k.confmatchtype = 's'`,
      `AND k.conkey = ARRAY[${own}]::pg_catalog.int2[] AND k.confkey = ARRAY[${targetColumn}]::pg_catalog.int2[];`,
      `IF ${record}.oid IS NULL OR NOT EXISTS (`,
      `i.indexrelid = ${record}.conindid AND i.indrelid = ${target}`,
      "AND i.indisunique AND i.indisvalid AND i.indisready AND i.indimmediate AND NOT i.indisexclusion",
      `AND i.indnatts = 1 AND i.indnkeyatts = 1 AND i.indkey[0] = ${targetColumn} AND i.indexprs IS NULL AND i.indpred IS NULL)`,
    ]) {
      expect(proof, predicate).toContain(predicate);
    }
  });
});

describe("no index, no trigger, no backfill, nothing repaired", () => {
  it("creates nothing but the columns, the CHECK, the two keys, and a pg_temp reference copy", () => {
    expect([...flat.matchAll(/ALTER TABLE [^ ]+ [A-Z ]+/g)].map((m) => m[0].trim())).toEqual([
      "ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS",
      "ALTER TABLE %I.%I ADD CONSTRAINT",
      "ALTER TABLE %I.%I ADD CONSTRAINT",
      "ALTER TABLE %I.%I ADD CONSTRAINT",
    ]);
    expect([...flat.matchAll(/\bCREATE\b [A-Z ]+/g)].map((m) => m[0].trim())).toEqual(["CREATE TEMPORARY TABLE"]);
    expect(code).not.toMatch(/\bINDEX\b|\bTRIGGER\b|\bFUNCTION\b|\bPROCEDURE\b|\bVIEW\b|\bPOLICY\b|\bRULE\b/);
  });

  it("writes no row: no INSERT, UPDATE, DELETE, TRUNCATE, or COPY — so nothing is back-filled", () => {
    const withoutFkClauses = flat.replace(/ON UPDATE NO ACTION ON DELETE NO ACTION/g, "");
    expect(withoutFkClauses).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|COPY|MERGE)\b/);
    expect(comments).toContain("No default, no backfill, no new index, no trigger.");
  });

  it("never drops, rebuilds, or alters an existing object into compliance: the only DROPs are the pg_temp reference copy", () => {
    expect([...flat.matchAll(/\bDROP\b[^;]*;/g)].map((m) => m[0])).toEqual([
      "DROP TABLE IF EXISTS pg_temp.%I', reference_name);",
      "DROP', reference_name, pg_catalog.array_to_string(column_definitions, ', '), check_name, check_expression);",
      "DROP TABLE pg_temp.%I', reference_name);",
    ]);
    expect(code).not.toMatch(/ALTER COLUMN|DROP COLUMN|DROP CONSTRAINT|RENAME|CREATE OR REPLACE|REINDEX/i);
    expect(flat.match(/RAISE EXCEPTION 'Payment recipient identity migration refused:/g)!.length).toBeGreaterThanOrEqual(9);
    expect(flat.match(/RAISE EXCEPTION/g)!.length).toBe(flat.match(/RAISE EXCEPTION 'Payment recipient identity migration refused:/g)!.length);
    expect(code).not.toMatch(/EXCEPTION\s+WHEN/); // no handler: any error aborts the whole block
  });

  it("refuses anything else that depends on the three columns (an index, trigger, view, policy, or a second constraint)", () => {
    at(
      "WHERE d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.refobjid = tbl AND d.refobjsubid IN (own_app_user, own_handle, own_display_name) AND NOT (d.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass AND d.objid IN (ck.oid, account_fk.oid, handle_fk.oid));",
    );
    at("an unexpected object (%) depends on a recipient identity column of %.%");
  });

  it("no index anywhere in schema.sql covers a recipient identity column", () => {
    const indexes = [...withoutComments(schema).matchAll(/CREATE (?:UNIQUE )?INDEX[^;]*;/g)].map((m) => m[0]);
    expect(indexes.length).toBeGreaterThan(0);
    for (const index of indexes) for (const column of COLUMNS) expect(index, column).not.toContain(column);
  });
});

describe("boundaries", () => {
  it("never mentions the Turnkey owner address — not in SQL, not in a comment", () => {
    expect(raw).not.toMatch(/owner_?address/i);
    expect(comments).toContain("A recipient is always the account's Safe.");
  });

  it("touches the Handles registry only as a foreign-key target: no DDL on real_account_handles or real_accounts", () => {
    expect([...code.matchAll(/real_account_handles/g)]).toHaveLength(5); // the table lookup, the key's REFERENCES, and three refusal messages
    expect(flat).toContain("c.relname = 'real_account_handles'");
    expect(flat).toContain("REFERENCES %I.real_account_handles (handle)");
    expect(code).not.toMatch(/ALTER TABLE [^ ]*real_account|ON [^ ]*real_account_handles|real_passkeys/);
  });

  it("records the standing pair-integrity audit query, verbatim", () => {
    const normalize = (text: string) => text.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
    expect(normalize(comments)).toContain(`${normalize(PAIR_INTEGRITY_AUDIT_SQL)};`);
    expect(PAIR_INTEGRITY_AUDIT_SQL).toMatch(/^SELECT p\.id\b/);
    expect(PAIR_INTEGRITY_AUDIT_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(PAIR_INTEGRITY_AUDIT_SQL).not.toMatch(/owner_?address/i);
    const scratch = pairIntegrityAuditFor("s1");
    expect(scratch).toContain("FROM s1.payment_attempts p");
    expect(scratch).toContain("LEFT JOIN s1.real_account_handles h");
    expect(scratch).toContain("LEFT JOIN s1.real_accounts a");
    expect(scratch.replace(/s1\./g, "")).toBe(PAIR_INTEGRITY_AUDIT_SQL);
  });

  it("records what Slice B must do, so it is not lost: derive the pair in one INSERT, lower(a.safe_address), and the payability decision", () => {
    expect(comments).toContain("Slice B must therefore derive BOTH values from the database inside the one atomic INSERT (never from the client)");
    expect(comments).toContain("must write the recipient address as lower(a.safe_address)");
    expect(comments).toContain("payment_attempts.recipient is normalized lowercase, while real_accounts.safe_address is stored case-preserving");
    expect(comments).toContain("can RECEIVE Cash whether or not it currently has an active passkey");
    expect(comments).toContain("WITHOUT THIS MIGRATION, Slice B fails CLOSED");
    expect(comments).toContain("Hand-applied, idempotent, FAIL-CLOSED. CLOSED / COMPLETE:");
    expect(comments).toContain("was applied EXACTLY ONCE to the real Neon database's `public` schema");
    expect(comments).not.toContain("NOT YET APPLIED TO ANY NEON DATABASE");
  });
});

describe("today's code is untouched by the expanded schema", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
    return out;
  };
  const NAMES = /recipient_app_user_id|recipient_handle|recipient_display_name|recipientAppUserId|recipientHandle|recipientDisplayName/;

  it("Slice B: the recipient identity SNAPSHOT is named in exactly the two payment-store files — never in a route, the browser, a component, history, or any other server module", () => {
    const sources = [...walk("lib"), ...walk("app"), ...walk("components")];
    expect(sources.length).toBeGreaterThan(50);
    const normalized = (file: string) => file.split(path.sep).join("/");
    const files = (pattern: RegExp) => sources.filter((file) => pattern.test(readFileSync(file, "utf8"))).map(normalized).sort();
    // The two columns / fields that exist only as the stored snapshot:
    expect(files(/recipient_app_user_id|recipient_display_name|recipientAppUserId|recipientDisplayName/)).toEqual(["lib/real/server/neon-store.ts", "lib/real/server/payment-attempts.ts"]);
    // The handle column itself (an exact identifier — `invalid_recipient_handle` is an outcome name, not the column):
    expect(files(/(?<![A-Za-z0-9_])recipient_handle(?![A-Za-z0-9_])/)).toEqual(["lib/real/server/neon-store.ts"]);
    // `recipientHandle` is also the prepare wire/service input name; it appears only along the prepare path and the store, and in no history/status/latest/component/browser file.
    expect(files(/(?<![A-Za-z0-9_])recipientHandle(?![A-Za-z0-9_])/)).toEqual([
      "app/api/real/payments/prepare/route.ts",
      "lib/real/server/handle-recipient.ts",
      "lib/real/server/neon-store.ts",
      "lib/real/server/payment-attempts.ts",
      "lib/real/server/payments.ts",
    ]);
  });

  it("the payment adapter stays explicit: reserve() names its INSERT columns (the three identity columns explicitly NULL) and the row mapper names every field it reads", () => {
    const store = readFileSync("lib/real/server/neon-store.ts", "utf8");
    const flatStore = store.replace(/\s+/g, " ");
    const INSERT_COLUMNS =
      "INSERT INTO payment_attempts (app_user_id, safe_address, recipient, amount_base_units, chain_id, token_address, state, authorizing_credential_id, recipient_app_user_id, recipient_handle, recipient_display_name)";
    expect(flatStore.split(INSERT_COLUMNS)).toHaveLength(3); // reserve() and reserveHandlePayment(), and no third writer
    expect(flatStore).toContain("'prepared', ${input.authorizingCredentialId}, NULL::text, NULL::text, NULL::text FROM _counts");
    const mapper = store.slice(store.indexOf("function toPaymentAttempt(row: Row): PaymentAttempt {"));
    const body = mapper.slice(0, mapper.indexOf("\n}\n"));
    expect(body.length).toBeGreaterThan(200);
    expect(body).not.toMatch(/\.\.\.row/); // never a spread, so an extra column cannot leak into a PaymentAttempt
    expect(body).toContain("row.recipient");
    for (const column of ["row.recipient_app_user_id", "row.recipient_handle", "row.recipient_display_name"]) expect(body).toContain(column);
  });

  it("Slice B: the advisory lookup no longer applies the provisional active-passkey rule — only a claimed handle and a valid Safe address", () => {
    const store = readFileSync("lib/real/server/neon-store.ts", "utf8");
    const start = store.indexOf("async findPayableAccountByHandle");
    const read = store.slice(start, store.indexOf("async findProfileByAppUserId", start)).replace(/\s+/g, " ");
    expect(start).toBeGreaterThan(-1);
    expect(read).not.toContain("real_passkeys");
    expect(read).toContain("h.kind = 'claimed' AND a.safe_address ~ '^0x[0-9a-fA-F]{40}$'");
  });

  it("Practice Mode is untouched: nothing under simulation/ or lib/stores knows about payment_attempts or a recipient identity", () => {
    const practice = [...walk("simulation"), ...walk("lib/stores")];
    expect(practice.length).toBeGreaterThan(5);
    for (const file of practice) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(NAMES);
      expect(text, file).not.toMatch(/payment_attempts|real_account_handles/);
    }
  });
});
