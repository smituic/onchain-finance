import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HANDLE_MAX_LENGTH, HANDLE_MIN_LENGTH, HANDLE_PATTERN, RESERVED_HANDLES, canonicalizeHandle } from "@/lib/real/handle";
import { ACCOUNT_HANDLE_OWNER_KEY, ACCOUNT_HANDLE_PRIMARY_KEY } from "@/lib/real/server/neon-store";

/**
 * Account Handles: schema.sql's handle registry, checked STATICALLY — no
 * Postgres runs offline. Its BEHAVIOR (clean creation, idempotent rerun, every
 * wrong pre-existing object refused, the triggers actually refusing
 * UPDATE/DELETE/TRUNCATE, the collation/regex semantics on Neon) is proven by
 * handles-migration.smoke.test.ts, which runs this exact block against a
 * disposable Neon branch (gated, live).
 */
const schema = readFileSync("lib/real/server/schema.sql", "utf8");
const begin = schema.indexOf("-- BEGIN Account Handles");
const end = schema.indexOf("-- END Account Handles");
const raw = schema.slice(begin, end);
const code = raw
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const flat = code.replace(/\s+/g, " ");
const definition = (/\$definition\$([\s\S]*?)\$definition\$/.exec(raw)?.[1] ?? "")
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .replace(/\s+/g, " ");
// The later Payment Attempt Recipient Identity block is carved out: it names the registry, but only as a foreign-key TARGET
// (payment-recipient-identity-schema.test.ts proves it alters nothing but payment_attempts, and that this block's text is unchanged).
const recipientBegin = schema.indexOf("-- BEGIN Payment Attempt Recipient Identity");
const recipientEnd = schema.indexOf("-- END Payment Attempt Recipient Identity");
const statementsOutside = (schema.slice(0, begin) + schema.slice(end, recipientBegin) + schema.slice(recipientEnd))
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const at = (needle: string) => {
  const i = flat.indexOf(needle);
  expect(i, needle).toBeGreaterThan(-1);
  return i;
};

describe("Account Handles migration (schema.sql structure)", () => {
  it("is ONE DO block between the L2 block and the provisioning-evidence block (which stays last), with ONE target-schema constant", () => {
    expect(begin).toBeGreaterThan(schema.indexOf("-- END S5 L2 identity-index migration"));
    expect(end).toBeGreaterThan(begin);
    expect(schema.indexOf("-- BEGIN Provisioning Evidence Capture")).toBeGreaterThan(end);
    expect(schema.trimEnd().endsWith("-- END Provisioning Evidence Capture")).toBe(true);
    expect(code.trim().startsWith("DO $$")).toBe(true);
    expect(code.trim().endsWith("END $$;")).toBe(true);
    expect(code.match(/DO \$\$/g)).toHaveLength(1);
    expect(raw.match(/'public'/g)).toHaveLength(1);
    at("target_schema CONSTANT pg_catalog.text := 'public';");
    // Nothing outside the block touches the registry or its supporting key (the one carved-out block only references the registry).
    expect(recipientBegin).toBeGreaterThan(end);
    expect(recipientEnd).toBeGreaterThan(recipientBegin);
    expect(statementsOutside).not.toMatch(/real_account_handles|real_passkeys_app_user_credential_key/);
    expect(schema.slice(recipientBegin, recipientEnd)).not.toMatch(/real_passkeys_app_user_credential_key|ALTER TABLE [^ ]*real_account_handles|ON [^ ]*real_account_handles/);
  });

  it("pins search_path first and schema-qualifies every declared type", () => {
    const body = flat.slice(flat.indexOf("$definition$; "));
    expect(body.slice(body.indexOf(" BEGIN ") + 1)).toMatch(/^BEGIN PERFORM pg_catalog\.set_config\('search_path', 'pg_catalog, pg_temp', true\);/);
    const declarations = flat.slice(flat.indexOf("DECLARE"), flat.indexOf("$guard$"));
    for (const [, type] of declarations.matchAll(/ [a-z_]+ CONSTANT ([a-z_.]+) :=/g)) expect(type, type).toMatch(/^pg_catalog\./);
    expect(flat).not.toMatch(/to_regclass\(/);
  });

  it("the handle column is TEXT COLLATE \"C\", the primary key, and the format CHECK is the validator's twin under C collation", () => {
    expect(definition).toContain('handle TEXT COLLATE "C" NOT NULL,');
    expect(definition).toContain("CONSTRAINT real_account_handles_pkey PRIMARY KEY (handle),");
    expect(definition).toContain(
      `CONSTRAINT real_account_handles_format_check CHECK (octet_length(handle) = char_length(handle) AND char_length(handle) BETWEEN ${HANDLE_MIN_LENGTH} AND ${HANDLE_MAX_LENGTH} AND (handle COLLATE "C") ~ '${HANDLE_PATTERN.source}')`,
    );
    expect(ACCOUNT_HANDLE_PRIMARY_KEY).toBe("real_account_handles_pkey");
  });

  it("kind is NOT NULL and constrained to reserved | claimed; created_at is NOT NULL DEFAULT now()", () => {
    expect(definition).toContain("kind TEXT NOT NULL,");
    expect(definition).toContain("CONSTRAINT real_account_handles_kind_check CHECK (kind IN ('reserved', 'claimed')),");
    expect(definition).toContain("created_at TIMESTAMPTZ NOT NULL DEFAULT now(),");
  });

  it("owner/kind CHECK: reserved => both owner columns NULL; claimed => both NOT NULL", () => {
    expect(definition).toContain("app_user_id TEXT,");
    expect(definition).toContain("claimed_by_credential_id TEXT,");
    expect(definition).toContain(
      "CONSTRAINT real_account_handles_owner_check CHECK ((kind = 'reserved' AND app_user_id IS NULL AND claimed_by_credential_id IS NULL) OR (kind = 'claimed' AND app_user_id IS NOT NULL AND claimed_by_credential_id IS NOT NULL))",
    );
  });

  it("an account owns at most one handle: UNIQUE (app_user_id), named as neon-store expects", () => {
    expect(definition).toContain("CONSTRAINT real_account_handles_app_user_id_key UNIQUE (app_user_id),");
    expect(ACCOUNT_HANDLE_OWNER_KEY).toBe("real_account_handles_app_user_id_key");
  });

  it("adds UNIQUE (app_user_id, credential_id) on real_passkeys only when absent, then proves it from the catalog", () => {
    at("passkey_key_name CONSTANT pg_catalog.text := 'real_passkeys_app_user_credential_key';");
    const guard = at("IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = passkeys_tbl AND k.conname = passkey_key_name) THEN");
    const add = at("EXECUTE format('ALTER TABLE %I.real_passkeys ADD CONSTRAINT %I UNIQUE (app_user_id, credential_id)', target_schema, passkey_key_name);");
    const prove = at("k.contype = 'u' AND k.convalidated AND NOT k.condeferrable AND k.conkey = ARRAY[passkeys_app_user, passkeys_credential]::pg_catalog.int2[];");
    expect(guard).toBeLessThan(add);
    expect(add).toBeLessThan(prove);
    expect(prove).toBeLessThan(at("CREATE TABLE IF NOT EXISTS"));
  });

  it("both foreign keys are NO ACTION — the composite one targets real_passkeys(app_user_id, credential_id); nothing cascades or sets NULL", () => {
    at(
      "CONSTRAINT %I FOREIGN KEY (app_user_id) REFERENCES %I.real_accounts (app_user_id) ON UPDATE NO ACTION ON DELETE NO ACTION, CONSTRAINT %I FOREIGN KEY (app_user_id, claimed_by_credential_id) REFERENCES %I.real_passkeys (app_user_id, credential_id) ON UPDATE NO ACTION ON DELETE NO ACTION)'",
    );
    at("account_fk_name CONSTANT pg_catalog.text := 'real_account_handles_app_user_id_fkey';");
    at("claimer_fk_name CONSTANT pg_catalog.text := 'real_account_handles_claimed_by_fkey';");
    expect(code).not.toMatch(/\bCASCADE\b/i);
    expect(code).not.toMatch(/SET\s+NULL/i);
    expect(code).not.toMatch(/SET\s+DEFAULT/i);
    // ... and each is then proven: NO ACTION ('a') both ways, MATCH SIMPLE, not deferrable, exact columns.
    expect(flat.match(/k\.confupdtype = 'a' AND k\.confdeltype = 'a' AND k\.confmatchtype = 's'/g)).toHaveLength(2);
    at("k.conkey = ARRAY[own_app_user, own_claimer]::pg_catalog.int2[] AND k.confkey = ARRAY[passkeys_app_user, passkeys_credential]::pg_catalog.int2[];");
    at("IF claimer_fk.oid IS NULL OR claimer_fk.conindid IS DISTINCT FROM passkey_key.conindid THEN");
    at("k.contype = 'f' AND k.oid NOT IN (account_fk.oid, claimer_fk.oid)"); // no third foreign key
  });

  it("immutability: a guard function plus BEFORE UPDATE OR DELETE (row) and BEFORE TRUNCATE (statement) triggers, created only if missing and then proven", () => {
    const body = /\$guard\$([\s\S]*?)\$guard\$/.exec(raw)?.[1] ?? "";
    expect(body).toContain("RAISE EXCEPTION 'real_account_handles is append-only: a handle is never changed, removed, or recycled.';");
    expect(body.replace(/\s+/g, " ").trim()).toMatch(/^BEGIN RAISE EXCEPTION '[^']+'; END;$/); // it does nothing else — never RETURN NEW/OLD
    const createFunction = at("EXECUTE format('CREATE FUNCTION %I.%I() RETURNS pg_catalog.trigger LANGUAGE plpgsql AS %L', target_schema, guard_function_name, guard_function_body);");
    const proveFunction = at("AND NOT p.prosecdef AND p.proconfig IS NULL AND p.prosrc = guard_function_body;");
    const rowTrigger = at("EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION %I.%I()', row_guard_name,");
    const truncateTrigger = at("EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION %I.%I()', truncate_guard_name,");
    const proveTriggers = at("((g.tgname = row_guard_name AND g.tgtype = 27) OR (g.tgname = truncate_guard_name AND g.tgtype = 34))) <> 2");
    expect(createFunction).toBeLessThan(proveFunction);
    expect(proveFunction).toBeLessThan(rowTrigger);
    expect(rowTrigger).toBeLessThan(truncateTrigger);
    expect(truncateTrigger).toBeLessThan(proveTriggers);
    at("g.tgfoid = guard_fn AND g.tgenabled = 'O' AND g.tgqual IS NULL");
    at("(SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger g WHERE g.tgrelid = tbl AND NOT g.tgisinternal) <> 2"); // and no other user trigger
    expect(code).not.toMatch(/CREATE OR REPLACE/i); // a wrong pre-existing function is refused, never replaced
  });

  it("never drops, rebuilds, or rewrites anything real: the only DROPs are the pg_temp reference copy, and there is no UPDATE or DELETE statement", () => {
    expect([...flat.matchAll(/\bDROP\b[^;]*;/g)].map((m) => m[0])).toEqual([
      "DROP TABLE IF EXISTS pg_temp.%I', display_name_reference_name);",
      "DROP', display_name_reference_name, display_name_definition);",
      "DROP TABLE pg_temp.%I', display_name_reference_name);",
      "DROP TABLE IF EXISTS pg_temp.%I', reference_name);",
      "DROP', reference_name, definition);",
      "DROP TABLE pg_temp.%I', reference_name);",
    ]);
    // The ONLY ALTER in the block adds the unique key on real_passkeys — real_accounts is never altered here.
    expect([...flat.matchAll(/ALTER TABLE [^ ]+/g)].map((m) => m[0])).toEqual(["ALTER TABLE %I.real_passkeys"]);
    const withoutTriggerDdl = flat.replace(/BEFORE UPDATE OR DELETE ON/g, "").replace(/ON UPDATE NO ACTION ON DELETE NO ACTION/g, "");
    expect(withoutTriggerDdl).not.toMatch(/\b(UPDATE|DELETE FROM|TRUNCATE TABLE|REINDEX)\b/);
    expect(flat.match(/RAISE EXCEPTION 'Account handles migration refused:/g)!.length).toBeGreaterThanOrEqual(17);
  });

  it("proves the table against a reference copy and refuses foreign indexes and dependencies (same convention as the evidence block)", () => {
    at("EXECUTE format('CREATE TEMPORARY TABLE %I (%s) ON COMMIT DROP', reference_name, definition);");
    at("tc.atttypid = rc.atttypid AND tc.atttypmod = rc.atttypmod AND tc.attcollation = rc.attcollation");
    at("AND pg_catalog.pg_get_constraintdef(k.oid) = r.def");
    at("has unexpected index(es) %");
    at("has a constraint or default depending on an object other than its own columns (%)");
    at("has row-level security enabled or forced, or a policy");
    at("is not an ordinary, permanent, non-partition table");
  });

  it("seeds the reserved names as 'reserved' rows with ON CONFLICT (handle) DO NOTHING — never DO UPDATE — and refuses if one is not a reserved row", () => {
    const seeded = [...(/reserved_handles CONSTANT pg_catalog\.text\[\] := ARRAY\[([\s\S]*?)\];/.exec(code)?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]);
    // Exactly the application list, minus names the format CHECK already makes impossible to store.
    const storable = RESERVED_HANDLES.filter((name) => canonicalizeHandle(name).ok);
    expect(seeded).toEqual(storable);
    expect(RESERVED_HANDLES.filter((name) => !storable.includes(name))).toEqual(["me"]);
    expect(new Set(seeded).size).toBe(seeded.length);
    for (const name of seeded) expect(HANDLE_PATTERN.test(name) && name.length >= HANDLE_MIN_LENGTH && name.length <= HANDLE_MAX_LENGTH, name).toBe(true);
    at("EXECUTE format('INSERT INTO %I.%I (handle, kind) SELECT h, ''reserved'' FROM pg_catalog.unnest($1) AS h ON CONFLICT (handle) DO NOTHING', target_schema, table_name) USING reserved_handles;");
    expect(code).not.toMatch(/DO UPDATE/i);
    expect(code.match(/ON CONFLICT/g)).toHaveLength(1);
    at("WHERE NOT EXISTS (SELECT 1 FROM %I.%I x WHERE x.handle = h AND x.kind = ''reserved'')");
    at("RAISE EXCEPTION 'Account handles migration refused: reserved name(s) % are not reserved rows");
  });
});

describe("Account Handles: the rest of the schema change", () => {
  const sqlOnly = schema
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  it("'handle_claim' is its own challenge purpose in BOTH the table definition and the purpose-CHECK migration", () => {
    const lists = [...sqlOnly.matchAll(/CHECK \(purpose IN \(([^)]*)\)\)/g)].map((m) => m[1]);
    expect(lists).toHaveLength(2);
    for (const list of lists) expect(list).toBe("'registration', 'login', 'backup_registration', 'backup_login_verification', 'backup_step_up', 'handle_claim'");
  });

  it("real_accounts.display_name is nullable with a structural length guard under an explicitly NAMED constraint, in the table and as an idempotent ALTER placed BEFORE the L2 block", () => {
    const guard = "CONSTRAINT real_accounts_display_name_check CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 40)";
    const table = /CREATE TABLE IF NOT EXISTS real_accounts \(([\s\S]*?)\n\);/.exec(sqlOnly)?.[1] ?? "";
    expect(table.replace(/\s+/g, " ")).toContain(`display_name TEXT ${guard},`);
    const alter = sqlOnly.replace(/\s+/g, " ").indexOf(`ALTER TABLE real_accounts ADD COLUMN IF NOT EXISTS display_name TEXT ${guard};`);
    expect(alter).toBeGreaterThan(-1);
    // The proof's reference column is built from exactly the text the ALTER adds.
    expect(flat).toContain(`display_name_definition CONSTANT pg_catalog.text := 'display_name TEXT ${guard}';`);
    // The column is added in exactly one place; nothing else in the file alters, drops, or re-types it.
    expect(sqlOnly.match(/ALTER TABLE real_accounts[^;]*display_name/g)).toHaveLength(1);
    expect(sqlOnly).not.toMatch(/DROP (COLUMN|CONSTRAINT)[^;]*display_name/i);
    expect(sqlOnly).not.toMatch(/ALTER COLUMN display_name/i);
    expect(schema.lastIndexOf("ALTER TABLE real_accounts")).toBeLessThan(schema.indexOf("-- BEGIN S5 L2 identity-index migration"));
    // Never unique, never indexed.
    expect(sqlOnly).not.toMatch(/INDEX[^;]*display_name/i);
  });

  it("no handle column exists on real_accounts, real_passkeys, registration_attempts, or the provisioning evidence table", () => {
    for (const table of ["real_accounts", "real_passkeys", "registration_attempts", "backup_passkey_enrollments"]) {
      const body = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(sqlOnly)?.[1] ?? "";
      expect(body.length, table).toBeGreaterThan(0);
      expect(body, table).not.toMatch(/^\s*handle\s/m);
    }
    const evidence = schema.slice(schema.indexOf("-- BEGIN Provisioning Evidence Capture"), schema.indexOf("-- END Provisioning Evidence Capture"));
    expect(evidence).not.toMatch(/real_account_handles|\bhandle\b/);
  });
});

describe("Account Handles step 0: real_accounts.display_name is PROVEN, never trusted by name (static)", () => {
  const stepStart = flat.indexOf("EXECUTE format('DROP TABLE IF EXISTS pg_temp.%I', display_name_reference_name);");
  const stepEnd = flat.indexOf("EXECUTE format('DROP TABLE pg_temp.%I', display_name_reference_name);");
  const step = flat.slice(stepStart, stepEnd);
  const columnRaise = step.indexOf("RAISE EXCEPTION 'Account handles migration refused: %.real_accounts.display_name is missing or is not exactly a nullable TEXT column");
  const columnCondition = step.slice(step.indexOf("IF dn.attnum IS NULL"), columnRaise);
  const checkRaise = step.indexOf("RAISE EXCEPTION 'Account handles migration refused: % on %.real_accounts is missing, not validated, or not exactly the intended length CHECK");
  const checkLookup = step.slice(step.indexOf("SELECT k.oid INTO dn_check"), checkRaise);
  const dependencyRaise = step.indexOf("RAISE EXCEPTION 'Account handles migration refused: % on %.real_accounts depends on an object other than real_accounts (%)");

  it("runs inside the fail-closed Handles block, after the search_path pin and BEFORE anything is created or altered", () => {
    expect(stepStart).toBeGreaterThan(flat.indexOf("PERFORM pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true);"));
    expect(stepEnd).toBeGreaterThan(stepStart);
    for (const created of ["ALTER TABLE %I.real_passkeys ADD CONSTRAINT", "CREATE TABLE IF NOT EXISTS %I.%I", "CREATE FUNCTION", "CREATE TRIGGER", "INSERT INTO"]) {
      expect(flat.indexOf(created), created).toBeGreaterThan(stepEnd);
    }
    expect(columnRaise).toBeGreaterThan(-1);
    expect(checkRaise).toBeGreaterThan(columnRaise);
    expect(dependencyRaise).toBeGreaterThan(checkRaise);
  });

  it("looks the column up on exactly <target_schema>.real_accounts, by catalog — never by search_path", () => {
    at("SELECT c.oid INTO accounts_tbl FROM pg_catalog.pg_class c WHERE c.relnamespace = ns AND c.relname = 'real_accounts' AND c.relkind = 'r';");
    expect(step).toContain("INTO dn FROM pg_catalog.pg_attribute a WHERE a.attrelid = accounts_tbl AND a.attname = 'display_name' AND a.attnum > 0 AND NOT a.attisdropped;");
    expect(step).toContain("EXECUTE format('CREATE TEMPORARY TABLE %I (%s) ON COMMIT DROP', display_name_reference_name, display_name_definition);");
    expect(step).not.toMatch(/to_regclass|'public'/);
  });

  // Each hostile pre-existing shape, and the exact predicate that makes the block RAISE for it.
  it.each([
    ["the column is missing", "dn.attnum IS NULL"],
    ["a wrong type (varchar, citext, a domain over text, ...)", "dn.atttypid IS DISTINCT FROM 'pg_catalog.text'::pg_catalog.regtype"],
    ["a type that differs from this server's own TEXT reference", "dn.atttypid IS DISTINCT FROM dn_ref.atttypid"],
    ["a type modifier", "dn.atttypmod IS DISTINCT FROM dn_ref.atttypmod"],
    ["a non-default collation (COLLATE \"C\", a user collation)", "dn.attcollation IS DISTINCT FROM dn_ref.attcollation"],
    ["an array column (text[])", "dn.attndims IS DISTINCT FROM dn_ref.attndims"],
    ["NOT NULL", "dn.attnotnull IS NOT FALSE"],
    ["a DEFAULT (or a generated expression, which is stored as one)", "dn.atthasdef IS NOT FALSE"],
    ["an IDENTITY column", "dn.attidentity IS DISTINCT FROM dn_ref.attidentity"],
    ["a GENERATED column", "dn.attgenerated IS DISTINCT FROM dn_ref.attgenerated"],
    ["a default expression row, whatever atthasdef says", "EXISTS (SELECT 1 FROM pg_catalog.pg_attrdef ad WHERE ad.adrelid = accounts_tbl AND ad.adnum = dn.attnum)"],
  ])("hostile column — %s — is refused", (_case, predicate) => {
    expect(columnCondition, predicate).toContain(predicate);
    // Every predicate is an OR-term of the ONE condition guarding the RAISE (no AND could mask it).
    expect(columnCondition).not.toMatch(/\bAND\b(?![^(]*\))/);
  });

  it.each([
    ["the CHECK is missing, or has another name", "k.conrelid = accounts_tbl AND k.conname = display_name_check_name AND k.contype = 'c'"],
    ["a NOT VALID CHECK", "AND k.convalidated"],
    ["a deferrable constraint", "AND NOT k.condeferrable AND NOT k.condeferred"],
    ["a NO INHERIT mismatch", "AND k.connoinherit = dn_ref.connoinherit"],
    ["a CHECK on another column, or on several", "AND k.conkey = ARRAY[dn.attnum]::pg_catalog.int2[]"],
    ["a weakened or differently-bounded CHECK (e.g. BETWEEN 0 AND 4000, or TRUE), or one calling a look-alike char_length", "AND pg_catalog.pg_get_constraintdef(k.oid) = dn_ref.def"],
  ])("hostile constraint — %s — is refused", (_case, predicate) => {
    expect(checkLookup, predicate).toContain(predicate);
    expect(step).toContain("IF dn_ref.oid IS NULL OR dn_check.oid IS NULL THEN RAISE EXCEPTION 'Account handles migration refused: % on %.real_accounts is missing, not validated, or not exactly the intended length CHECK");
  });

  it("the expected definition is whatever THIS server deparses for the intended text — never a hand-copied string", () => {
    expect(step).toContain("SELECT k.oid, k.connoinherit, pg_catalog.pg_get_constraintdef(k.oid) AS def INTO dn_ref FROM pg_catalog.pg_constraint k WHERE k.conrelid = display_name_ref AND k.conname = display_name_check_name AND k.contype = 'c';");
    expect(step).not.toMatch(/char_length/); // the block itself never spells the expression out; it only compares deparsed forms
  });

  it("a look-alike dependency (a user-defined function, operator, type, or collation in any schema) is refused: the CHECK may depend on real_accounts only", () => {
    expect(step).toContain("WHERE d.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass AND d.objid = dn_check.oid AND NOT (d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.refobjid = accounts_tbl);");
    expect(step).toContain("IF bad IS NOT NULL THEN RAISE EXCEPTION 'Account handles migration refused: % on %.real_accounts depends on an object other than real_accounts (%)");
  });

  it("never alters, drops, replaces, or validates the column or constraint into compliance", () => {
    expect(step).not.toMatch(/\bALTER\b|\bADD\b|\bVALIDATE\b|\bUPDATE\b|\bDELETE\b|CREATE OR REPLACE/);
    expect([...step.matchAll(/\bDROP\b[^;]*;/g)].map((m) => m[0])).toEqual([
      "DROP TABLE IF EXISTS pg_temp.%I', display_name_reference_name);",
      "DROP', display_name_reference_name, display_name_definition);",
    ]);
    expect(step.match(/RAISE EXCEPTION/g)).toHaveLength(3);
    expect(step.match(/Nothing was changed; review and resolve by hand \(never altered or dropped\)\./g)).toHaveLength(3);
  });

  it("is not exact about the REST of real_accounts: unrelated extra columns or CHECKs are not this step's business", () => {
    // It inspects only the one column and the one named constraint.
    expect(step.match(/a\.attname = 'display_name'/g)).toHaveLength(2); // the reference and the target
    expect(step).not.toMatch(/unexpected (column|constraint|index)/);
  });
});
