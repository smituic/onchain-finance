// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

/**
 * MANUAL, LIVE-DATABASE behavioral proof of schema.sql's "Provisioning
 * Evidence Capture" migration. Runs the EXACT block — only its
 * `target_schema` constant swapped — against throwaway scratch schemas
 * (`pdmig_<run>_<case>`), each holding a minimal registration_attempts table,
 * then drops them. It never touches `public` (asserted). Never runs in normal
 * `pnpm test`: it needs DATABASE_URL AND an explicit opt-in. Use a disposable
 * Neon BRANCH, never the application database.
 *
 * What it must prove: a correct object is accepted (clean creation, and an
 * idempotent rerun that changes nothing); every same-named object of the
 * wrong shape is REFUSED, left exactly as it was, and never repaired — not
 * merely that `IF NOT EXISTS` skips. It also settles the one PROVISIONAL
 * item: whether Neon accepts and enforces the body-digest CHECK.
 *
 *   REAL_SMOKE_PROVISIONING_MIGRATION=1 DATABASE_URL="<disposable branch>" \
 *     pnpm exec vitest run test/lib/real/provisioning-dispatch-migration.smoke.test.ts
 */
const enabled = process.env.REAL_SMOKE_PROVISIONING_MIGRATION === "1" && Boolean(process.env.DATABASE_URL);
const TABLE = "registration_provisioning_dispatches";
const ONE_OPEN = "registration_provisioning_dispatches_one_open_idx";
const FK = "registration_provisioning_dispatches_credential_id_fkey";
const REFUSED = /Provisioning evidence migration refused/;

const schemaSql = readFileSync("lib/real/server/schema.sql", "utf8");
const block = schemaSql.slice(schemaSql.indexOf("-- BEGIN Provisioning Evidence Capture"), schemaSql.indexOf("-- END Provisioning Evidence Capture"));
const TARGET_CONSTANT = "target_schema CONSTANT pg_catalog.text := 'public';";

/** The exact migration with only its target schema swapped. */
function migrationFor(schema: string): string {
  expect(block.split(TARGET_CONSTANT)).toHaveLength(2);
  const body = block.replace(TARGET_CONSTANT, `target_schema CONSTANT pg_catalog.text := '${schema}';`);
  expect(body).not.toContain("'public'");
  return body.slice(body.indexOf("DO $$"));
}

/** The block's own column/constraint definition (everything but the foreign key). */
const DEFINITION = /\$definition\$([\s\S]*?)\$definition\$/.exec(block)?.[1] ?? "";

const scratchName = (runId: string, name: string) => `pdmig_${runId}_${name}`.toLowerCase();
const VALID_UNQUOTED_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const CASES = ["clean", "view", "matview", "inhchild", "inhparent", "rls", "forcerls", "policy", "extraidx", "extraexpridx", "extradomain", "extraenum", "extradefault", "extraok", "coltype", "notnull", "weakcheck", "nocheck", "idxnonunique", "idxpred", "idxothertable", "idxkeys", "fkcascade", "fkother", "fkother_target", "nullsnd", "trigger", "notvalid", "noattempts", "shadowfn", "shadow_attack", "shadow_clean", "shadow_attack_tbl", "shadow_clean_tbl"];

// Offline (never gated): the harness itself.
describe("provisioning dispatch migration smoke harness", () => {
  it("the block is ONE DO statement with exactly one 'public' target constant, and the swap leaves no 'public' behind", () => {
    const sqlOnly = block
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim();
    expect(sqlOnly.startsWith("DO $$")).toBe(true);
    expect(sqlOnly.endsWith("END $$;")).toBe(true);
    expect(sqlOnly.match(/\bDO \$\$/g)).toHaveLength(1);
    expect(migrationFor("pdmig_test")).toContain("target_schema CONSTANT pg_catalog.text := 'pdmig_test';");
    expect(DEFINITION).toContain("CONSTRAINT registration_provisioning_dispatches_body_digest_check");
    expect(DEFINITION).not.toMatch(/REFERENCES/);
  });

  it("every scratch schema name is a lowercase, valid unquoted identifier, and they are distinct", () => {
    const runId = randomUUID().replace(/-/g, "").slice(0, 8);
    const names = CASES.map((name) => scratchName(runId, name));
    for (const name of names) expect(name, name).toMatch(VALID_UNQUOTED_IDENTIFIER);
    expect(new Set(names).size).toBe(names.length);
  });
});

const LIVE_TIMEOUT_MS = 90_000;

describe.skipIf(!enabled)("Provisioning Evidence Capture migration — behavior against scratch schemas (live)", () => {
  const runId = randomUUID().replace(/-/g, "").slice(0, 8);
  const schemas = new Set<string>();
  const sqlFn = async () => {
    const { createNeonSqlClient } = await import("@/lib/real/server/neon-store");
    return createNeonSqlClient(process.env.DATABASE_URL!);
  };
  const q = async (text: string, params: unknown[] = []) => (await sqlFn()).query(text, params) as Promise<Array<Record<string, unknown>>>;
  /** Runs statements in ONE transaction, so a hostile SET LOCAL governs everything after it. */
  const inOneTransaction = async (...statements: string[]) => {
    const sql = await sqlFn();
    return (await sql.transaction(statements.map((text) => sql.query(text)))) as Array<Array<Record<string, unknown>>>;
  };
  const publicTable = async () => (await q(`SELECT to_regclass('public.${TABLE}')::text AS t`))[0]!.t;
  let publicBefore: unknown = "unread";

  afterAll(async () => {
    for (const schema of schemas) await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    const left = await q(`SELECT nspname FROM pg_namespace WHERE nspname LIKE $1`, [`pdmig_${runId}_%`]);
    expect(left).toEqual([]);
    if (publicBefore !== "unread") expect(await publicTable()).toBe(publicBefore); // `public` is exactly as it was
  }, LIVE_TIMEOUT_MS);

  /** A fresh scratch schema with a minimal registration_attempts table. */
  async function scratch(name: string, { attempts = true } = {}) {
    if (publicBefore === "unread") publicBefore = await publicTable();
    const schema = scratchName(runId, name);
    expect(schema).toMatch(VALID_UNQUOTED_IDENTIFIER);
    schemas.add(schema);
    await q(`CREATE SCHEMA ${schema}`);
    if (attempts) {
      await q(`CREATE TABLE ${schema}.registration_attempts (credential_id TEXT PRIMARY KEY)`);
      await q(`INSERT INTO ${schema}.registration_attempts VALUES ('cred-a'), ('cred-b'), ('cred-c'), ('cred-d')`);
    }
    return schema;
  }
  const migrate = (schema: string) => q(migrationFor(schema));
  const tableOf = (schema: string) => `${schema}.${TABLE}`;
  const relation = async (schema: string, name: string) => (await q(`SELECT c.oid::int AS oid, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`, [schema, name]))[0] ?? null;
  const constraintDef = async (schema: string, name: string) =>
    (await q(`SELECT pg_get_constraintdef(k.oid) AS def FROM pg_constraint k WHERE k.conrelid = $1::regclass AND k.conname = $2`, [tableOf(schema), name]))[0]?.def ?? null;
  const indexDef = async (schema: string, name: string) => (await q(`SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`, [schema, name]))[0]?.indexdef ?? null;
  const catalog = (schema: string) =>
    q(
      `SELECT c.relname, c.relkind, c.oid::int AS oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname LIKE 'registration_provisioning_dispatches%' ORDER BY 1`,
      [schema],
    );
  const constraints = (schema: string) => q(`SELECT conname, contype, oid::int AS oid FROM pg_constraint WHERE conrelid = $1::regclass AND contype <> 'n' ORDER BY conname`, [tableOf(schema)]);

  /** A correct, migrated scratch schema — the starting point for "correct object, then made wrong" cases. */
  async function migrated(name: string) {
    const schema = await scratch(name);
    await migrate(schema);
    return schema;
  }

  /** Re-running the migration on a wrong object must refuse, and leave everything EXACTLY as it was. */
  async function expectRefusedUnchanged(schema: string, why: RegExp = REFUSED) {
    const [beforeObjects, beforeConstraints] = [await catalog(schema), await constraints(schema).catch(() => [])];
    await expect(migrate(schema)).rejects.toThrow(why);
    expect(await catalog(schema)).toEqual(beforeObjects);
    expect(await constraints(schema).catch(() => [])).toEqual(beforeConstraints);
  }

  const insert = (schema: string, credentialId: string, seq: number, body: string, digest = sha(body)) =>
    q(
      `INSERT INTO ${tableOf(schema)} (credential_id, dispatch_seq, evidence_version, organization_id, stamp_public_key, request_timestamp_ms, request_body, request_body_sha256) VALUES ($1, $2, 1, 'parent-org', '02abc', 1790204988123, $3, $4) RETURNING id`,
      [credentialId, seq, body, digest],
    );
  const setActivity = (schema: string, id: unknown, activityId: string) => q(`UPDATE ${tableOf(schema)} SET turnkey_activity_id = $2, activity_recorded_at = now() WHERE id = $1`, [id, activityId]);
  const setTerminal = (schema: string, id: unknown, status: string, extra = "") =>
    q(`UPDATE ${tableOf(schema)} SET terminal_status = $2, terminal_observed_at = now(), terminal_observed_by = 'dispatch', intent_verdict = 'exact', fingerprint_verdict = 'match', vote_verdict = 'parent_key' ${extra} WHERE id = $1`, [id, status]);

  describe("a correct object is accepted", () => {
    it(
      "clean creation: the table, its five indexes, and every named constraint — DDL accepted INCLUDING the provisional body-digest CHECK",
      async () => {
        const schema = await migrated("clean");
        expect((await catalog(schema)).map((row) => `${row.relkind}:${row.relname}`).sort()).toEqual(
          [
            "r:registration_provisioning_dispatches",
            "i:registration_provisioning_dispatches_pkey",
            "i:registration_provisioning_dispatches_seq_key",
            "i:registration_provisioning_dispatches_body_sha256_key",
            "i:registration_provisioning_dispatches_activity_id_key",
            "i:registration_provisioning_dispatches_one_open_idx",
          ].sort(),
        );
        const names = (await constraints(schema)).map((row) => row.conname);
        for (const name of [FK, "registration_provisioning_dispatches_body_digest_check", "registration_provisioning_dispatches_terminal_group_check", "registration_provisioning_dispatches_failure_check"]) expect(names).toContain(name);
        // The reference copy lived only in this migration's transaction.
        expect(await q(`SELECT c.relname FROM pg_class c WHERE c.relname = 'registration_provisioning_dispatches_reference'`)).toEqual([]);
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "idempotent: re-running on the correct objects is accepted and changes nothing (same oids) — this alone does NOT show fail-closed (the refusal cases below do)",
      async () => {
        const schema = scratchName(runId, "clean");
        const [objects, keys] = [await catalog(schema), await constraints(schema)];
        await migrate(schema);
        await migrate(schema);
        expect(await catalog(schema)).toEqual(objects);
        expect(await constraints(schema)).toEqual(keys);
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "the digest CHECK: Postgres's sha256 of the stored body equals the application's (ASCII, escapes, multi-byte); a digest of other bytes or a non-canonical spelling is refused",
      async () => {
        const schema = scratchName(runId, "clean");
        const bodies = [
          '{"type":"ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V8","parameters":{"path":"m/44\'/60\'/0\'/0/0"}}',
          '{"quote":"\\"","backslash":"\\\\","newline":"\\n","unicodeEscape":"\\u0000"}',
          '{"multibyte":"é ✓ 日本 😀"}',
        ];
        for (const [index, body] of bodies.entries()) {
          const [{ id }] = (await insert(schema, "cred-a", 100 + index, body)) as [{ id: string }];
          const [row] = await q(`SELECT request_body, octet_length(request_body) AS bytes, encode(sha256(convert_to(request_body, 'UTF8')), 'hex') AS db_digest FROM ${tableOf(schema)} WHERE id = $1`, [id]);
          expect(row!.request_body).toBe(body);
          expect(Number(row!.bytes)).toBe(Buffer.byteLength(body, "utf8"));
          expect(row!.db_digest).toBe(sha(body));
          await setActivity(schema, id, `act-digest-${index}`);
          await setTerminal(schema, id, "ACTIVITY_STATUS_FAILED");
        }
        await expect(insert(schema, "cred-b", 1, "body-wrong", sha("body-wrong "))).rejects.toThrow(/registration_provisioning_dispatches_body_digest_check/);
        await expect(insert(schema, "cred-b", 1, "body-upper", sha("body-upper").toUpperCase())).rejects.toThrow(/check constraint/);
        await expect(insert(schema, "cred-b", 1, "", sha(""))).rejects.toThrow(/check constraint/);
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "uniqueness, the one-open index, the foreign key, and the consistency CHECKs are enforced",
      async () => {
        const schema = scratchName(runId, "clean");
        const [{ id: first }] = (await insert(schema, "cred-c", 1, "body-c-1")) as [{ id: string }];
        await expect(insert(schema, "cred-c", 2, "body-c-2")).rejects.toThrow(/registration_provisioning_dispatches_one_open_idx/);
        await expect(insert(schema, "cred-d", 1, "body-c-1")).rejects.toThrow(/registration_provisioning_dispatches_body_sha256_key/);
        await expect(setTerminal(schema, first, "ACTIVITY_STATUS_COMPLETED")).rejects.toThrow(/terminal_needs_id_check/);
        await setActivity(schema, first, "act-c-1");
        await expect(setTerminal(schema, first, "ACTIVITY_STATUS_FAILED", ", observed_wallet_id = 'w'")).rejects.toThrow(/observed_result_check/);
        await expect(setTerminal(schema, first, "ACTIVITY_STATUS_COMPLETED", ", failure_message = 'x'")).rejects.toThrow(/failure_check/);
        await setTerminal(schema, first, "ACTIVITY_STATUS_FAILED", ", failure_code = 3, failure_message = 'x'");
        await expect(insert(schema, "cred-c", 1, "body-c-2")).rejects.toThrow(/registration_provisioning_dispatches_seq_key/);
        const [{ id: second }] = (await insert(schema, "cred-c", 2, "body-c-2")) as [{ id: string }];
        await expect(setActivity(schema, second, "act-c-1")).rejects.toThrow(/registration_provisioning_dispatches_activity_id_key/);
        await insert(schema, "cred-d", 1, "body-d-1"); // a second row without an activity id: NULLs stay distinct
        await expect(insert(schema, "no-such-credential", 1, "body-orphan")).rejects.toThrow(/foreign key/);
      },
      LIVE_TIMEOUT_MS,
    );
  });

  describe("a same-named object of the wrong shape is REFUSED, left as it was, and never repaired", () => {
    it.each([
      ["view", "a same-named VIEW", (t: string) => `CREATE VIEW ${t} AS SELECT 1 AS id`, "v"],
      ["matview", "a same-named MATERIALIZED VIEW", (t: string) => `CREATE MATERIALIZED VIEW ${t} AS SELECT 1 AS id`, "m"],
    ] as const)(
      "%s: %s — refused by the explicit relation check that runs right after CREATE TABLE IF NOT EXISTS, before ANY index DDL",
      async (name, _label, wrong, relkind) => {
        const schema = await scratch(name);
        await q(wrong(tableOf(schema)));
        await expectRefusedUnchanged(schema, /is not an ordinary, permanent, non-partition table/);
        expect((await relation(schema, TABLE))?.relkind).toBe(relkind);
        expect(await relation(schema, ONE_OPEN)).toBeNull(); // the index DDL was never reached
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "inhchild: the table has an inheritance CHILD (whose rows would bypass its uniqueness) — refused",
      async () => {
        const schema = await migrated("inhchild");
        await q(`CREATE TABLE ${schema}.evidence_child () INHERITS (${tableOf(schema)})`);
        await expectRefusedUnchanged(schema, /takes part in table inheritance/);
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "inhparent: the table is itself an inheritance child of another table — refused",
      async () => {
        const schema = await migrated("inhparent");
        await q(`CREATE TABLE ${schema}.evidence_parent (credential_id TEXT)`);
        await q(`ALTER TABLE ${tableOf(schema)} INHERIT ${schema}.evidence_parent`);
        await expectRefusedUnchanged(schema, /takes part in table inheritance/);
      },
      LIVE_TIMEOUT_MS,
    );

    it.each([
      ["rls", "row-level security ENABLED", (t: string) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`],
      ["forcerls", "row-level security FORCED (not enabled)", (t: string) => `ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`],
      ["policy", "a policy present (RLS not enabled)", (t: string) => `CREATE POLICY hide_rows ON ${t} USING (false)`],
    ] as const)(
      "%s: %s — refused (no hidden-row semantics)",
      async (name, _label, wrong) => {
        const schema = await migrated(name);
        await q(wrong(tableOf(schema)));
        await expectRefusedUnchanged(schema, /has row-level security enabled or forced, or a policy/);
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "extraidx: an extra plain index — refused",
      async () => {
        const schema = await migrated("extraidx");
        await q(`CREATE INDEX evidence_extra_idx ON ${tableOf(schema)} (request_body_sha256)`);
        await expectRefusedUnchanged(schema, /has unexpected index\(es\) evidence_extra_idx/);
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "extraexpridx: an extra EXPRESSION index calling a user-defined function on every write — refused",
      async () => {
        const schema = await migrated("extraexpridx");
        await q(`CREATE FUNCTION ${schema}.evil_len(text) RETURNS int LANGUAGE sql IMMUTABLE AS 'SELECT length($1)'`);
        await q(`CREATE INDEX evidence_expr_idx ON ${tableOf(schema)} (${schema}.evil_len(request_body))`);
        await expectRefusedUnchanged(schema, /has unexpected index\(es\) evidence_expr_idx/);
      },
      LIVE_TIMEOUT_MS,
    );

    it.each([
      ["extradomain", "an extra column of a user-defined DOMAIN (its CHECK runs on insert)", (s: string) => [`CREATE DOMAIN ${s}.evil_text AS TEXT CHECK (VALUE <> 'x')`, `ALTER TABLE ${s}.${TABLE} ADD COLUMN extra ${s}.evil_text`]],
      ["extraenum", "an extra column of a user-defined ENUM", (s: string) => [`CREATE TYPE ${s}.evil_enum AS ENUM ('a')`, `ALTER TABLE ${s}.${TABLE} ADD COLUMN extra ${s}.evil_enum`]],
    ] as const)(
      "%s: %s — refused",
      async (name, _label, wrong) => {
        const schema = await migrated(name);
        for (const statement of wrong(schema)) await q(statement);
        await expectRefusedUnchanged(schema, /column\(s\) extra use a type or collation that is not a built-in/);
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "extradefault: an extra built-in column whose DEFAULT calls a user-defined function (runs on every insert) — refused by the dependency rule",
      async () => {
        const schema = await migrated("extradefault");
        await q(`CREATE FUNCTION ${schema}.evil_default() RETURNS text LANGUAGE sql VOLATILE AS $f$SELECT 'x'$f$`);
        await q(`ALTER TABLE ${tableOf(schema)} ADD COLUMN extra TEXT DEFAULT ${schema}.evil_default()`);
        await expectRefusedUnchanged(schema, /depending on an object other than its own columns/);
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "extraok: an extra, unrelated column of a built-in type with no default is TOLERATED — the rerun is accepted and changes nothing",
      async () => {
        const schema = await migrated("extraok");
        await q(`ALTER TABLE ${tableOf(schema)} ADD COLUMN operator_note TEXT`);
        const [objects, keys] = [await catalog(schema), await constraints(schema)];
        await migrate(schema);
        expect(await catalog(schema)).toEqual(objects);
        expect(await constraints(schema)).toEqual(keys);
      },
      LIVE_TIMEOUT_MS,
    );

    it.each([
      ["coltype", "a column of the wrong type", (t: string) => `ALTER TABLE ${t} ALTER COLUMN dispatch_seq TYPE BIGINT`, /column\(s\) dispatch_seq differ/],
      ["notnull", "a required column made nullable", (t: string) => `ALTER TABLE ${t} ALTER COLUMN request_body DROP NOT NULL`, /column\(s\) request_body differ/],
      ["nocheck", "a required CHECK missing", (t: string) => `ALTER TABLE ${t} DROP CONSTRAINT registration_provisioning_dispatches_failure_check`, /constraint registration_provisioning_dispatches_failure_check/],
      [
        "weakcheck",
        "a same-named CHECK with a weaker definition",
        (t: string) => `ALTER TABLE ${t} DROP CONSTRAINT registration_provisioning_dispatches_body_digest_check, ADD CONSTRAINT registration_provisioning_dispatches_body_digest_check CHECK (true)`,
        /constraint registration_provisioning_dispatches_body_digest_check/,
      ],
      [
        "nullsnd",
        "a same-named UNIQUE that is NULLS NOT DISTINCT",
        (t: string) => `ALTER TABLE ${t} DROP CONSTRAINT registration_provisioning_dispatches_activity_id_key, ADD CONSTRAINT registration_provisioning_dispatches_activity_id_key UNIQUE NULLS NOT DISTINCT (turnkey_activity_id)`,
        /registration_provisioning_dispatches_activity_id_key/,
      ],
      [
        "notvalid",
        "a same-named CHECK added NOT VALID",
        (t: string) => `ALTER TABLE ${t} DROP CONSTRAINT registration_provisioning_dispatches_request_body_check, ADD CONSTRAINT registration_provisioning_dispatches_request_body_check CHECK (request_body <> '') NOT VALID`,
        /not validated/,
      ],
      ["fkcascade", "the foreign key re-created ON DELETE CASCADE", (t: string) => `ALTER TABLE ${t} DROP CONSTRAINT ${FK}, ADD CONSTRAINT ${FK} FOREIGN KEY (credential_id) REFERENCES ${t.split(".")[0]}.registration_attempts (credential_id) ON DELETE CASCADE`, /credential_id_fkey is not exactly/],
      ["trigger", "a user trigger on the table", (t: string) => `CREATE TRIGGER rewrite_evidence BEFORE INSERT ON ${t} FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()`, /has a user trigger or a rule/],
    ] as const)(
      "%s: %s",
      async (name, _label, wrong, why) => {
        const schema = await migrated(name);
        await q(wrong(tableOf(schema)));
        const before = { digest: await constraintDef(schema, "registration_provisioning_dispatches_body_digest_check"), fk: await constraintDef(schema, FK) };
        await expectRefusedUnchanged(schema, why);
        expect({ digest: await constraintDef(schema, "registration_provisioning_dispatches_body_digest_check"), fk: await constraintDef(schema, FK) }).toEqual(before);
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "fkother: the foreign key pointing at ANOTHER schema's registration_attempts",
      async () => {
        const other = await scratch("fkother_target");
        const schema = await migrated("fkother");
        await q(`ALTER TABLE ${tableOf(schema)} DROP CONSTRAINT ${FK}, ADD CONSTRAINT ${FK} FOREIGN KEY (credential_id) REFERENCES ${other}.registration_attempts (credential_id)`);
        await expectRefusedUnchanged(schema, /credential_id_fkey is not exactly/);
        expect(await constraintDef(schema, FK)).toContain(`${other}.registration_attempts`);
      },
      LIVE_TIMEOUT_MS,
    );

    it.each([
      ["idxnonunique", "a NON-unique same-named index", (t: string) => `CREATE INDEX ${ONE_OPEN} ON ${t} (credential_id) WHERE terminal_status IS NULL`],
      ["idxpred", "a same-named UNIQUE index with the WRONG predicate", (t: string) => `CREATE UNIQUE INDEX ${ONE_OPEN} ON ${t} (credential_id) WHERE terminal_status IS NOT NULL`],
      ["idxkeys", "a same-named UNIQUE index on extra key columns", (t: string) => `CREATE UNIQUE INDEX ${ONE_OPEN} ON ${t} (credential_id, id) WHERE terminal_status IS NULL`],
    ] as const)(
      "%s: %s",
      async (name, _label, wrong) => {
        const schema = await migrated(name);
        await q(`DROP INDEX ${schema}.${ONE_OPEN}`);
        await q(wrong(tableOf(schema)));
        const before = await indexDef(schema, ONE_OPEN);
        await expectRefusedUnchanged(schema, /is not exactly UNIQUE \(credential_id\) WHERE terminal_status IS NULL/);
        expect(await indexDef(schema, ONE_OPEN)).toBe(before);
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "idxothertable: a same-named UNIQUE index on ANOTHER table, before the first run — refused, and the table is not left behind",
      async () => {
        const schema = await scratch("idxothertable");
        await q(`CREATE TABLE ${schema}.decoy (credential_id TEXT, terminal_status TEXT)`);
        await q(`CREATE UNIQUE INDEX ${ONE_OPEN} ON ${schema}.decoy (credential_id) WHERE terminal_status IS NULL`);
        await expect(migrate(schema)).rejects.toThrow(/is not exactly UNIQUE \(credential_id\)/);
        expect(await relation(schema, TABLE)).toBeNull(); // the whole block rolled back
        expect(await indexDef(schema, ONE_OPEN)).toContain(`${schema}.decoy`);
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "noattempts: no registration_attempts table in the target schema — refused, nothing created",
      async () => {
        const schema = await scratch("noattempts", { attempts: false });
        await expect(migrate(schema)).rejects.toThrow(/registration_attempts is not an ordinary table/);
        expect(await relation(schema, TABLE)).toBeNull();
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "shadowfn: a same-named digest CHECK calling a look-alike sha256 in another schema — refused (definition and dependency)",
      async () => {
        const schema = await migrated("shadowfn");
        const shadow = scratchName(runId, "shadow_attack");
        schemas.add(shadow);
        await q(`CREATE SCHEMA ${shadow}`);
        await q(`CREATE FUNCTION ${shadow}.sha256(bytea) RETURNS bytea LANGUAGE sql IMMUTABLE AS 'SELECT ''\\x00''::bytea'`);
        await q(
          `ALTER TABLE ${tableOf(schema)} DROP CONSTRAINT registration_provisioning_dispatches_body_digest_check, ADD CONSTRAINT registration_provisioning_dispatches_body_digest_check CHECK (request_body_sha256 = encode(${shadow}.sha256(convert_to(request_body, 'UTF8')), 'hex'))`,
        );
        await expectRefusedUnchanged(schema, /registration_provisioning_dispatches_body_digest_check|depending on an object other than its own columns/);
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      "under a HOSTILE search_path (a look-alike sha256 first): a wrong table built through it is refused, and a clean run still binds the built-in",
      async () => {
        const shadow = scratchName(runId, "shadow_clean");
        schemas.add(shadow);
        await q(`CREATE SCHEMA ${shadow}`);
        await q(`CREATE FUNCTION ${shadow}.sha256(bytea) RETURNS bytea LANGUAGE sql IMMUTABLE AS 'SELECT ''\\x00''::bytea'`);
        const hostile = `SET LOCAL search_path = ${shadow}, pg_catalog`;

        // ATTACK: the block's own definition text, resolved under the hostile path, binds the look-alike.
        const attacked = await scratch("shadow_attack_tbl");
        await inOneTransaction(hostile, `CREATE TABLE ${tableOf(attacked)} (${DEFINITION}, CONSTRAINT ${FK} FOREIGN KEY (credential_id) REFERENCES ${attacked}.registration_attempts (credential_id))`);
        await expect(inOneTransaction(hostile, migrationFor(attacked))).rejects.toThrow(REFUSED);

        // CLEAN under the same hostile path: the pinned migration binds the built-in, so a correct digest is accepted.
        const clean = await scratch("shadow_clean_tbl");
        await inOneTransaction(hostile, migrationFor(clean));
        const deps = await q(
          `SELECT count(*)::int AS n FROM pg_depend d JOIN pg_constraint k ON d.classid = 'pg_constraint'::regclass AND d.objid = k.oid WHERE k.conrelid = $1::regclass AND d.refclassid = 'pg_proc'::regclass`,
          [tableOf(clean)],
        );
        expect(deps[0]!.n).toBe(0);
        await insert(clean, "cred-a", 1, "body-clean");
      },
      LIVE_TIMEOUT_MS,
    );
  });
});
