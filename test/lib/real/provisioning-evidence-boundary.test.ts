import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Provisioning Evidence Capture — structural boundaries. These read source
 * and schema text; they prove what CANNOT happen because no code path for it
 * exists (the behavioural proofs are in provisioning-dispatch.test.ts and
 * provisioning-activity-poller.test.ts).
 */
const ROOT = process.cwd();
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
/** Source with comment lines and block comments removed, so a rule can name a thing its own doc comment explains is absent. */
const code = (file: string) =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

function listFilesRecursive(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? listFilesRecursive(full) : [full];
  });
}

const runtimeSources = ["app", "components", "lib", "simulation"]
  .flatMap((dir) => listFilesRecursive(path.join(ROOT, dir)))
  .filter((file) => /\.(ts|tsx)$/.test(file))
  .map((file) => path.relative(ROOT, file));

const POLLER = "lib/real/server/provisioning-activity-poller.ts";
const DISPATCH = "lib/real/server/provisioning-dispatch.ts";
const EVIDENCE = "lib/real/server/provisioning-evidence.ts";
const TRANSPORT = "lib/real/server/turnkey-provisioning.ts";
const ONBOARDING = "lib/real/server/onboarding.ts";
const RUNNER = "test/admin/poll-provisioning-activity.admin.test.ts";

describe("the operator poller is unreachable at runtime", () => {
  it.each(runtimeSources.filter((file) => file !== POLLER).map((file) => [file] as const))("%s never imports the provisioning activity poller", (file) => {
    expect(read(file)).not.toMatch(/["'][^"']*provisioning-activity-poller["']/);
  });

  it("runtime.ts, every /api/real route, and the onboarding / registration / login modules are among the files checked", () => {
    for (const file of ["lib/real/server/runtime.ts", ONBOARDING, "lib/real/server/registration.ts", "lib/real/server/login.ts", DISPATCH, "app/api/real/account/register/verify/route.ts", "app/api/real/account/login/verify/route.ts"]) {
      expect(runtimeSources).toContain(file);
    }
    expect(read("lib/real/server/runtime.ts")).not.toMatch(/pollProvisioningDispatch|ProvisioningActivityPort|provisioning-activity-poller/);
  });

  it("only the env-gated admin runner imports it, and that runner takes no activity id and no force/adopt option", () => {
    const importers = listFilesRecursive(path.join(ROOT, "test"))
      .map((file) => path.relative(ROOT, file))
      .filter((file) => /["'][^"']*provisioning-activity-poller["']/.test(read(file)));
    expect(importers.filter((file) => file.startsWith("test/admin/"))).toEqual([RUNNER]);
    const runner = read(RUNNER);
    expect(runner).toMatch(/describe\.skipIf\(!enabled\)/);
    expect(runner).toMatch(/REAL_ADMIN_POLL_PROVISIONING_ACTIVITY === "1"/);
    expect(runner).toMatch(/const commit = process\.env\.REAL_ADMIN_POLL_COMMIT === "1"/);
    // The only identifiers an operator can pass: one credential id, optionally one dispatch sequence number.
    const envNames = [...new Set([...code(RUNNER).matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((match) => match[1]))].sort();
    expect(envNames).toEqual(["DATABASE_URL", "REAL_ADMIN_CREDENTIAL_ID", "REAL_ADMIN_DISPATCH_SEQ", "REAL_ADMIN_POLL_COMMIT", "REAL_ADMIN_POLL_PROVISIONING_ACTIVITY"]);
    expect(code(RUNNER)).not.toMatch(/ACTIVITY_ID|FORCE|ADOPT|RESOLVE|SWEEP|activityId/);
  });
});

describe("the operator poller has exactly one Turnkey capability: get one activity by its stored id", () => {
  const source = code(POLLER);

  it("its Turnkey port declares EXACTLY getActivity", () => {
    const port = /export interface ProvisioningActivityPort \{([\s\S]*?)\n\}/.exec(read(POLLER))?.[1] ?? "";
    expect([...port.matchAll(/^\s+(\w+)\(/gm)].map((match) => match[1])).toEqual(["getActivity"]);
  });

  it("its store type is EXACTLY the three dispatch-observation methods", () => {
    const pick = /export type ProvisioningPollStore = Pick<RegistrationAttemptStore, ([^>]+)>/.exec(read(POLLER))?.[1] ?? "";
    expect([...pick.matchAll(/"(\w+)"/g)].map((match) => match[1]).sort()).toEqual(["findDispatchesByCredentialId", "recordDispatchObservation", "recordDispatchTerminal"]);
  });

  it("from the transport module it imports ONLY the exact-id read (and the dependency resolver) — never the create, the builder, or a client", () => {
    const imported = /import \{([^}]+)\} from "\.\/turnkey-provisioning";/.exec(read(POLLER))?.[1] ?? "";
    expect(imported.split(",").map((name) => name.trim().replace(/^type\s+/, "")).sort()).toEqual(["ParentActivityRead", "ParentTurnkeyDeps", "readParentActivity", "resolveParentTurnkeyDeps"]);
    expect([...read(POLLER).matchAll(/from "([^"]+)"/g)].map((match) => match[1]).sort()).toEqual(["./config", "./provisioning-evidence", "./registration-attempts", "./turnkey-provisioning"]);
  });

  it("contains no create, re-send, list, search, mutation, stamping, or attempt/account/session path", () => {
    for (const forbidden of [
      /\bsubmitCreateSubOrganization\b/,
      /\bbuildCreateSubOrganizationBody\b/,
      /\bbeginProvisioningDispatch\b/,
      /\brecordDispatchActivity\b/,
      /\bfindWalletAccountId\b/,
      /\bpollParentActivityUntilTerminal\b/,
      /\bcreateParentTurnkeyClient\b/,
      /\bfetch\s*\(/,
      /\/public\/v1\//,
      /\bgetActivities\b/,
      /\bgetSubOrgIds\b/,
      /\bgetUsers\b/,
      /\bstamp\w*\s*\(/,
      /\.transition\s*\(/,
      /\.finalize\s*\(/,
      /\bcreateVerified\b/,
      /\bupdateCounter\b/,
      /\bfindByCredentialId\b/,
      /\bcreateAccountWithPasskey\b|\bRealAccountRegistry\b/,
      /\bserializeSession\b|\bcreateSessionPayload\b/,
      /@turnkey\//,
    ]) {
      expect(source, String(forbidden)).not.toMatch(forbidden);
    }
    // One read per run: a single call site, not in a loop.
    expect(source.match(/\.getActivity\s*\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/\b(for|while)\s*\(/);
  });

  it("the exact-id read it uses takes an organization id and an activity id and nothing else", () => {
    const signature = /export async function readParentActivity\(input: \{([\s\S]*?)\}\): Promise<ParentActivityRead>/.exec(read(TRANSPORT))?.[1] ?? "";
    expect([...signature.matchAll(/^\s+(\w+)\??:/gm)].map((match) => match[1]).sort()).toEqual(["activityId", "config", "deps", "organizationId", "timeoutMs"]);
  });
});

describe("Option 3 is structurally unchanged", () => {
  const onboarding = code(ONBOARDING);

  it("the 'provisioning_in_flight' branch is a single return of the review reason — no call of any kind", () => {
    const branch = /if \(attempt\.state === "provisioning_in_flight"\) \{([\s\S]*?)\n  \}/.exec(onboarding)?.[1] ?? "";
    expect(branch.trim()).toBe("return { outcome: \"pending\", reason: PROVISIONING_NEEDS_REVIEW_REASON };");
  });

  it("onboarding / registration / login never read a dispatch row or an observed result id, and never read Turnkey themselves", () => {
    for (const file of [ONBOARDING, "lib/real/server/registration.ts", "lib/real/server/login.ts"]) {
      const source = code(file);
      for (const forbidden of [/findDispatchesByCredentialId/, /\bobserved[A-Z]\w*/, /\bterminalStatus\b/, /readParentActivity/, /pollParentActivityUntilTerminal/, /recordDispatch\w+/, /provisioning-evidence/]) {
        expect(source, `${file} ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });

  it("observed result ids are WRITTEN in exactly two places (the dispatch and the poller) and READ back by no pipeline code", () => {
    const users = runtimeSources.filter((file) => /\bobservedSubOrganizationId\b/.test(code(file))).sort();
    expect(users).toEqual([POLLER, DISPATCH, "lib/real/server/neon-store.ts", "lib/real/server/registration-attempts.ts"].sort());
    // In the dispatch they are only ever assigned from the in-process evaluation, never read from a stored row.
    expect(code(DISPATCH)).not.toMatch(/dispatch\.observed|\.dispatch\.observed|row\.observed/);
    // No statement anywhere copies an observed_* column into registration_attempts.
    const neon = code("lib/real/server/neon-store.ts");
    const attemptUpdates = neon.match(/UPDATE\s+registration_attempts[\s\S]*?(?:RETURNING|`)/g) ?? [];
    expect(attemptUpdates.length).toBeGreaterThanOrEqual(4); // transition, updateCounter, the claim, finalize
    // advanceProvisioningToTurnkeyCreated COMPARES observed_* (in its WHERE); no statement ASSIGNS them to the attempt.
    for (const statement of attemptUpdates) {
      const setClause = statement.slice(statement.indexOf("SET"), statement.indexOf("WHERE"));
      expect(setClause).not.toMatch(/observed_|registration_provisioning_dispatches/);
    }
  });

  it("the create is dispatched from exactly one call site, never inside a retry or a loop, and nothing re-sends a stored body", () => {
    const callers = runtimeSources.filter((file) => /\bsubmitCreateSubOrganization\s*\(/.test(code(file)));
    expect(callers.sort()).toEqual([DISPATCH, TRANSPORT].sort()); // the definition and its one caller
    const dispatch = code(DISPATCH);
    expect(dispatch.match(/\bsubmitCreateSubOrganization\s*\(/g)).toHaveLength(1);
    expect(dispatch).not.toMatch(/withOneRetry\(\s*\(\)\s*=>\s*submitCreateSubOrganization/);
    expect(dispatch).not.toMatch(/\b(for|while)\s*\([^)]*\)\s*\{[^}]*submitCreateSubOrganization/);
    // The only thing wrapped in the one-retry helper is a store write.
    const wrappedCalls = dispatch.match(/withOneRetry\(\(\) => [^)]*\)/g) ?? [];
    expect(wrappedCalls).toHaveLength(3);
    for (const wrapped of wrappedCalls) expect(wrapped).toMatch(/withOneRetry\(\(\) => attempts\.recordDispatch(Activity|Terminal|Observation)\(/);
    // The submit path string exists in one module only.
    expect(runtimeSources.filter((file) => read(file).includes("/public/v1/submit/create_sub_organization"))).toEqual([TRANSPORT]);
  });

  it("the SDK's unbounded poller and its re-serializing create are gone from the app", () => {
    for (const file of runtimeSources) {
      const source = code(file);
      expect(source, file).not.toMatch(/\bcreateActivityPoller\b/);
      expect(source, file).not.toMatch(/\.createSubOrganization\s*\(/);
      expect(source, file).not.toMatch(/\.stampCreateSubOrganization\s*\(/);
    }
  });
});

describe("the evidence comparison is pure", () => {
  it("provisioning-evidence.ts has no network, no key, no store, and no Turnkey client", () => {
    const source = code(EVIDENCE);
    expect([...read(EVIDENCE).matchAll(/from "([^"]+)"/g)].map((match) => match[1]).sort()).toEqual(["./registration-attempts", "./turnkey-signed-request"]);
    for (const forbidden of [/\bfetch\s*\(/, /\bawait\b/, /\basync\b/, /@turnkey\//, /apiPrivateKey|turnkeyApiPrivateKey/, /Date\.now/]) expect(source, String(forbidden)).not.toMatch(forbidden);
    // Intent is compared structurally; the only strings compared are the fingerprint (in its recognized form) and the vote's echoed body.
    expect(source).not.toMatch(/JSON\.stringify\([^)]*intent[^)]*\)\s*===/);
  });
});

describe("no stamp, signature, or private key is ever persisted", () => {
  const schema = read("lib/real/server/schema.sql");
  const block = schema.slice(schema.indexOf("-- BEGIN Provisioning Evidence Capture"), schema.indexOf("-- END Provisioning Evidence Capture"));
  const table = /\$definition\$([\s\S]*?)\$definition\$/.exec(block)?.[1] ?? "";
  const columns = table
    .split("\n")
    .map((line) => /^\s{4}([a-z_0-9]+)\s+[A-Z]/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name) && name !== "CONSTRAINT");

  it("schema.sql's dispatch table has exactly the documented columns — the only stamp-related one is the PUBLIC key", () => {
    expect(columns).toEqual([
      "id",
      "credential_id",
      "dispatch_seq",
      "evidence_version",
      "organization_id",
      "stamp_public_key",
      "request_timestamp_ms",
      "request_body",
      "request_body_sha256",
      "created_at",
      "turnkey_activity_id",
      "turnkey_activity_fingerprint",
      "activity_recorded_at",
      "terminal_status",
      "terminal_observed_at",
      "terminal_observed_by",
      "turnkey_created_at",
      "observed_sub_organization_id",
      "observed_root_user_id",
      "observed_wallet_id",
      "observed_owner_address",
      "failure_code",
      "failure_message",
      "intent_verdict",
      "fingerprint_verdict",
      "vote_verdict",
      "last_observed_status",
      "last_observed_at",
      "updated_at",
    ]);
    expect(columns.filter((name) => /stamp|signature|private|secret|api_key/.test(name) && !/timestamp/.test(name))).toEqual(["stamp_public_key"]);
  });

  it("the ProvisioningDispatch type has a field for every column and nothing stamp- or key-shaped beyond the public key", () => {
    const type = /export type ProvisioningDispatch = \{([\s\S]*?)\n\};/.exec(read("lib/real/server/registration-attempts.ts"))?.[1] ?? "";
    const fields = [...type.matchAll(/^\s+(\w+):/gm)].map((match) => match[1]!);
    const toSnake = (name: string) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`).replace(/sha256/, "sha256");
    expect(fields.map(toSnake)).toEqual(columns);
    expect(fields.filter((name) => /stamp|signature|private|secret/i.test(name) && !/timestamp/i.test(name))).toEqual(["stampPublicKey"]);
  });

  it("the transport never returns, logs, or stores the stamp: it exists only as a request header inside one function", () => {
    const transport = code(TRANSPORT);
    expect(transport.match(/stampHeaderValue/g)).toHaveLength(1); // the header assignment
    expect(transport).not.toMatch(/console\./);
    for (const file of [DISPATCH, POLLER, EVIDENCE, "lib/real/server/neon-store.ts"]) {
      if (file === "lib/real/server/neon-store.ts") continue; // other tables' child-stamp columns are a different (2g) mechanism
      expect(code(file), file).not.toMatch(/stampHeader|X-Stamp/);
    }
    const dispatchSql = [...code("lib/real/server/neon-store.ts").matchAll(/registration_provisioning_dispatches[\s\S]*?`/g)].map((match) => match[0]).join("\n");
    expect(dispatchSql).not.toMatch(/turnkey_request_stamp|stamp_header/);
  });
});

describe("M1: schema.sql's dispatch-table migration is fail-closed (static)", () => {
  const schema = read("lib/real/server/schema.sql");
  const raw = schema.slice(schema.indexOf("-- BEGIN Provisioning Evidence Capture"), schema.indexOf("-- END Provisioning Evidence Capture"));
  const sqlOnly = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const flat = sqlOnly.replace(/\s+/g, " ");
  const definition = (/\$definition\$([\s\S]*?)\$definition\$/.exec(raw)?.[1] ?? "").replace(/\s+/g, " ");

  it("is ONE DO block at the end of the file, after the L2 block, with ONE target-schema constant ('public')", () => {
    expect(schema.indexOf("-- BEGIN Provisioning Evidence Capture")).toBeGreaterThan(schema.indexOf("-- END S5 L2 identity-index migration"));
    expect(schema.trimEnd().endsWith("-- END Provisioning Evidence Capture")).toBe(true);
    expect(sqlOnly.trim().startsWith("DO $$")).toBe(true);
    expect(sqlOnly.trim().endsWith("END $$;")).toBe(true);
    expect(raw.split("target_schema CONSTANT pg_catalog.text := 'public';")).toHaveLength(2);
    expect(raw.match(/'public'/g)).toHaveLength(1);
  });

  it("pins search_path FIRST, schema-qualifies every declared type, and resolves the schema/table by catalog lookup", () => {
    const body = flat.slice(flat.indexOf("BEGIN "));
    expect(body).toMatch(/^BEGIN PERFORM pg_catalog\.set_config\('search_path', 'pg_catalog, pg_temp', true\);/);
    const declarations = flat.slice(flat.indexOf("DECLARE"), flat.indexOf(" BEGIN "));
    for (const [, type] of declarations.matchAll(/ [a-z_]+ (?:CONSTANT )?([a-z_.]+)(?: :=|;)/g)) {
      if (type === "record") continue;
      expect(type, type).toMatch(/^pg_catalog\./);
    }
    expect(flat).toContain("SELECT n.oid INTO ns FROM pg_catalog.pg_namespace n WHERE n.nspname = target_schema;");
    expect(flat).toContain("WHERE c.relnamespace = ns AND c.relname = 'registration_attempts' AND c.relkind = 'r'");
    expect(flat).not.toMatch(/to_regclass\(/); // no search_path-dependent name resolution of the target objects
  });

  it("creates only what is missing, by format(%I) — and everything after it is proof, not trust", () => {
    expect(flat).toContain("EXECUTE format('CREATE TABLE IF NOT EXISTS %I.%I (%s, CONSTRAINT %I FOREIGN KEY (credential_id) REFERENCES %I.registration_attempts (credential_id))'");
    expect(flat).toContain("EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I.%I %s', one_open_name, target_schema, table_name, one_open_definition);");
    expect(flat).toContain("one_open_definition CONSTANT pg_catalog.text := '(credential_id) WHERE terminal_status IS NULL';");
    // The reference copy: the same definition, temporary, dropped in-transaction.
    expect(flat).toContain("EXECUTE format('CREATE TEMPORARY TABLE %I (%s) ON COMMIT DROP', reference_name, definition);");
    // The only DROPs are of that pg_temp reference — nothing real is ever dropped or rebuilt.
    expect([...flat.matchAll(/\bDROP\b[^;]*;/g)].map((m) => m[0])).toEqual([
      "DROP TABLE IF EXISTS pg_temp.%I', reference_name);",
      "DROP', reference_name, definition);", // the reference's own ON COMMIT DROP
      "DROP TABLE pg_temp.%I', reference_name);",
    ]);
    expect(flat).not.toMatch(/\b(ALTER|DELETE|TRUNCATE|CREATE EXTENSION|CREATE OR REPLACE)\b/i);
  });

  it("every explicitly named object the migration introduces fits PostgreSQL's 63-byte identifier limit — none is silently truncated (live smoke finding)", () => {
    const MAX_BYTES = 63;
    const bytes = (name: string) => Buffer.byteLength(name, "utf8");
    // Every CONSTRAINT name in the definition and the DO block (the table's own, and the foreign key's via fk_name below).
    const constraintNames = [...sqlOnly.matchAll(/\bCONSTRAINT\s+([a-z_0-9]+)/g)].map((m) => m[1]!);
    // 26 literal CONSTRAINT names in the definition (4 keys + 22 CHECKs); the foreign key's name comes from fk_name, below.
    expect(constraintNames).toHaveLength(26);
    // The named-constant objects: table, reference copy, foreign key, and the one-open index.
    const constants = Object.fromEntries([...sqlOnly.matchAll(/\b(table_name|reference_name|fk_name|one_open_name)\s+CONSTANT\s+pg_catalog\.text\s*:=\s*'([a-z_0-9]+)'/g)].map((m) => [m[1]!, m[2]!]));
    expect(Object.keys(constants).sort()).toEqual(["fk_name", "one_open_name", "reference_name", "table_name"]);
    // Names built at run time: the reference copy's own one-open index (reference_name || '_one_open').
    expect(flat).toContain("reference_name || '_one_open'");
    const derived = [`${constants.reference_name}_one_open`];
    // And every identifier-shaped token that carries the table's prefix, wherever it appears in executable SQL.
    const tokens = [...new Set(sqlOnly.match(/registration_provisioning_dispatches[a-z_0-9]*/g) ?? [])];

    const all = [...new Set([...constraintNames, ...Object.values(constants), ...derived, ...tokens])];
    const tooLong = all.filter((name) => bytes(name) > MAX_BYTES).map((name) => `${bytes(name)} bytes: ${name}`);
    expect(tooLong).toEqual([]);
    // The guard really sees the whole set (a regression that renames everything away from the prefix would otherwise pass vacuously).
    expect(all).toHaveLength(31); // 26 constraints + table + reference copy + foreign key + one-open index + the reference's derived index
    // No prefix-carrying token exists outside the named set (so nothing unnamed or mistyped escapes the length check).
    expect(tokens.filter((token) => !constraintNames.includes(token) && !Object.values(constants).includes(token))).toEqual([]);
    expect(Math.max(...all.map(bytes))).toBeLessThanOrEqual(MAX_BYTES);
    // Names are unique, so no two could ever collide.
    expect(new Set(constraintNames).size).toBe(constraintNames.length);
    // The two names the live smoke found truncated are the short forms now.
    expect(constraintNames).toContain("registration_provisioning_dispatches_terminal_needs_id_check");
    expect(constraintNames).toContain("registration_provisioning_dispatches_fingerprint_length_check");
    expect(constraintNames).not.toContain("registration_provisioning_dispatches_terminal_needs_activity_check");
    expect(constraintNames).not.toContain("registration_provisioning_dispatches_turnkey_activity_fingerprint_check");
  });

  it("the block's statement extraction is unambiguous, and the statement is byte-identical to the one applied to the real Neon database", () => {
    // The apply/smoke tooling extracts from the FIRST occurrence of the opening token, so no comment may spell it out.
    expect(raw.split("DO $$")).toHaveLength(2);
    expect(raw.split("END $$;")).toHaveLength(2);
    const statement = raw.slice(raw.indexOf("DO $$")).trim();
    expect(statement.startsWith("DO $$")).toBe(true);
    expect(statement.endsWith("END $$;")).toBe(true);
    // Pinned to what was executed live (disposable branch, then the real database). A change to the statement is a NEW
    // migration: it must be re-reviewed, re-smoked on a disposable branch, and applied deliberately — then this pin updated.
    // Comment-only edits ABOVE the statement leave it, and this hash, unchanged.
    expect(statement).toHaveLength(20422);
    expect(createHash("sha256").update(statement, "utf8").digest("hex")).toBe("6931570baead529509ecd80005ab27499ae11b4ebf2f20610c9f75c69abedde2");
  });

  it("M-1: validates the relation IMMEDIATELY after CREATE TABLE IF NOT EXISTS — before the one-open index DDL or any other statement touches it", () => {
    const createTable = flat.indexOf("EXECUTE format('CREATE TABLE IF NOT EXISTS %I.%I");
    const createIndex = flat.indexOf("EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I.%I %s'");
    const relationCheck = flat.indexOf("t.relkind IS DISTINCT FROM 'r'");
    expect(createTable).toBeGreaterThan(0);
    expect(relationCheck).toBeGreaterThan(createTable);
    expect(createIndex).toBeGreaterThan(relationCheck);
    // Between the two DDL statements: catalog reads and RAISEs only.
    const createTableEnd = flat.indexOf("target_schema, table_name, definition, fk_name, target_schema);", createTable);
    expect(createTableEnd).toBeGreaterThan(createTable);
    const between = flat.slice(createTableEnd, createIndex);
    expect(between).not.toMatch(/\bEXECUTE\b/);
    expect(between).not.toMatch(/\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE)\b/);
    for (const fragment of [
      "t.relkind IS DISTINCT FROM 'r' OR t.relpersistence IS DISTINCT FROM 'p' OR t.relispartition IS NOT FALSE",
      "FROM pg_catalog.pg_inherits i WHERE i.inhrelid = tbl OR i.inhparent = tbl",
      "t.relrowsecurity IS NOT FALSE OR t.relforcerowsecurity IS NOT FALSE OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy pol WHERE pol.polrelid = tbl)",
      "FROM pg_catalog.pg_trigger g WHERE g.tgrelid = tbl AND NOT g.tgisinternal",
      "FROM pg_catalog.pg_rewrite w WHERE w.ev_class = tbl",
      "ty.typtype IS DISTINCT FROM 'b' OR ty.oid >= 16384 OR a.attcollation >= 16384",
    ]) {
      const at = flat.indexOf(fragment);
      expect(at, fragment).toBeGreaterThan(createTable);
      expect(at, fragment).toBeLessThan(createIndex);
    }
    expect(flat).toContain("WHERE k.conrelid = tbl AND NOT k.convalidated");
  });

  it("L-1: refuses ANY index on the table beyond the reference constraints' backing indexes and the one-open index", () => {
    expect(flat).toContain("FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = tbl AND i.indexrelid IS DISTINCT FROM ix.oid");
    expect(flat).toContain("k.conname IN (SELECT rk.conname FROM pg_catalog.pg_constraint rk WHERE rk.conrelid = ref AND rk.contype IN ('u', 'p'))");
    expect(flat).toMatch(/has unexpected index\(es\) %/);
  });

  it("validates every reference column (type, typmod, collation, NOT NULL, identity/generated, default) and every reference constraint by name and definition", () => {
    for (const fragment of [
      "tc.atttypid = rc.atttypid AND tc.atttypmod = rc.atttypmod AND tc.attcollation = rc.attcollation",
      "tc.attnotnull = rc.attnotnull AND tc.attidentity = rc.attidentity AND tc.attgenerated = rc.attgenerated",
      "pg_catalog.pg_get_expr(td.adbin, td.adrelid) IS NOT DISTINCT FROM pg_catalog.pg_get_expr(rd.adbin, rd.adrelid)",
      "FROM pg_catalog.pg_constraint k WHERE k.conrelid = ref AND k.contype IN ('c', 'u', 'p')",
      "pg_catalog.pg_get_constraintdef(k.oid) = r.def",
      "ti.indnullsnotdistinct = ri.indnullsnotdistinct",
      "ti.indclass::pg_catalog.text = ri.indclass::pg_catalog.text",
    ]) {
      expect(flat, fragment).toContain(fragment);
    }
  });

  it("validates the foreign key structurally: credential_id -> <target>.registration_attempts(credential_id), NO ACTION, MATCH SIMPLE, not deferrable, through a unique index on exactly that column", () => {
    for (const fragment of [
      "k.conname = fk_name AND k.contype = 'f' AND k.convalidated AND NOT k.condeferrable",
      "k.confrelid = attempts_tbl AND k.confupdtype = 'a' AND k.confdeltype = 'a' AND k.confmatchtype = 's'",
      "k.conkey = ARRAY[own_credential]::pg_catalog.int2[] AND k.confkey = ARRAY[attempts_credential]::pg_catalog.int2[]",
      "i.indrelid = attempts_tbl AND i.indisunique AND i.indisvalid AND i.indnkeyatts = 1 AND i.indkey[0] = attempts_credential",
    ]) {
      expect(flat, fragment).toContain(fragment);
    }
  });

  it("validates the one-open index: on THIS table, btree, UNIQUE, valid, ready, immediate, not exclusion, exactly (credential_id), no expression, the reference predicate", () => {
    for (const fragment of [
      "ix.relkind IS DISTINCT FROM 'i' OR ix.indrelid IS DISTINCT FROM tbl",
      "am.amname = 'btree'",
      "ix.indisunique IS NOT TRUE OR ix.indisprimary IS NOT FALSE OR ix.indisvalid IS NOT TRUE OR ix.indisready IS NOT TRUE",
      "ix.indimmediate IS NOT TRUE OR ix.indisexclusion IS NOT FALSE",
      "ix.indnatts IS DISTINCT FROM 1 OR ix.indnkeyatts IS DISTINCT FROM 1 OR ix.key0 IS DISTINCT FROM own_credential OR ix.no_exprs IS NOT TRUE",
      "ix.pred IS NULL OR ix.pred IS DISTINCT FROM r.pred",
    ]) {
      expect(flat, fragment).toContain(fragment);
    }
  });

  it("refuses ANY dependency of a constraint, default, or the one-open index on something other than this table (and, for the FK only, registration_attempts and its index)", () => {
    expect(flat).toContain("AND NOT (d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.refobjid = tbl)");
    expect(flat).toContain("d.objid = fk.oid AND d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.refobjid IN (attempts_tbl, fk.conindid)");
  });

  it("every refusal RAISEs (rolling the block back) and says nothing is auto-dropped", () => {
    expect((sqlOnly.match(/RAISE EXCEPTION 'Provisioning evidence migration refused:/g) ?? []).length).toBeGreaterThanOrEqual(10);
    expect(sqlOnly).not.toMatch(/RAISE (NOTICE|WARNING)/);
  });

  it("the definition: every constraint named, the uniqueness and consistency rules intact, and the provisional digest CHECK on built-ins", () => {
    for (const fragment of [
      "CONSTRAINT registration_provisioning_dispatches_pkey PRIMARY KEY (id)",
      "CONSTRAINT registration_provisioning_dispatches_seq_key UNIQUE (credential_id, dispatch_seq)",
      "CONSTRAINT registration_provisioning_dispatches_body_sha256_key UNIQUE (request_body_sha256)",
      "CONSTRAINT registration_provisioning_dispatches_activity_id_key UNIQUE (turnkey_activity_id)",
      "CONSTRAINT registration_provisioning_dispatches_request_body_sha256_check CHECK (request_body_sha256 ~ '^[0-9a-f]{64}$')",
      "CONSTRAINT registration_provisioning_dispatches_body_digest_check CHECK (request_body_sha256 = encode(sha256(convert_to(request_body, 'UTF8')), 'hex'))",
      "CHECK ((turnkey_activity_id IS NULL) = (activity_recorded_at IS NULL) AND (turnkey_activity_fingerprint IS NULL OR turnkey_activity_id IS NOT NULL))",
      "CHECK (terminal_status IS NULL OR turnkey_activity_id IS NOT NULL)",
      "CHECK ((terminal_status IS NULL) = (terminal_observed_at IS NULL) AND (terminal_status IS NULL) = (terminal_observed_by IS NULL)",
      "CHECK (terminal_status IS NOT DISTINCT FROM 'ACTIVITY_STATUS_COMPLETED' OR (observed_sub_organization_id IS NULL AND observed_root_user_id IS NULL AND observed_wallet_id IS NULL AND observed_owner_address IS NULL))",
      "OR (terminal_status IS NOT NULL AND terminal_status IN ('ACTIVITY_STATUS_FAILED', 'ACTIVITY_STATUS_REJECTED')))",
      "CONSTRAINT registration_provisioning_dispatches_failure_message_check CHECK (char_length(failure_message) <= 500)",
      "CHECK (terminal_status IN ('ACTIVITY_STATUS_COMPLETED', 'ACTIVITY_STATUS_FAILED', 'ACTIVITY_STATUS_REJECTED'))",
      "CHECK (terminal_observed_by IN ('dispatch', 'operator_poll'))",
    ]) {
      expect(definition, fragment).toContain(fragment);
    }
    // No unnamed (auto-named) constraint: every CHECK/UNIQUE/PRIMARY KEY follows a CONSTRAINT <name>.
    expect(definition.match(/\b(CHECK|UNIQUE|PRIMARY KEY)\b/g)?.length).toBe(definition.match(/CONSTRAINT registration_provisioning_dispatches_\w+ (CHECK|UNIQUE|PRIMARY KEY)\b/g)?.length);
    expect(definition).not.toMatch(/REFERENCES/); // the FK is only on the real table (a temporary reference can't have one)
    expect(raw).toMatch(/Neon accepted and enforced\s+-- the CHECK/); // live-verified, no longer provisional
    expect(raw).not.toMatch(/PROVISIONAL|NOT applied to Neon|has NOT run/);
  });
});

describe("L5: the provisioning adapter smoke refuses BEFORE its first write, and its cleanup cannot strand fixtures (static)", () => {
  const source = read("test/lib/real/neon-smoke.test.ts");
  const block = source.slice(source.indexOf('describe.skipIf(!process.env.DATABASE_URL || process.env.REAL_SMOKE_PROVISIONING_DISPATCH !== "1")'));
  const code = block
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  it("is gated on DATABASE_URL AND its own opt-in", () => {
    expect(block.length).toBeGreaterThan(0);
    expect(block).toMatch(/^describe\.skipIf\(!process\.env\.DATABASE_URL \|\| process\.env\.REAL_SMOKE_PROVISIONING_DISPATCH !== "1"\)/);
  });

  it("a read-only beforeAll preflight checks the table and throws before anything is written; the flag is set only after it passes", () => {
    const preflight = /beforeAll\(async \(\) => \{([\s\S]*?)\n  \}\);/.exec(code)?.[1] ?? "";
    expect(preflight).toContain("to_regclass('registration_provisioning_dispatches')");
    expect(preflight).toMatch(/throw new Error\("Provisioning dispatch smoke refused:/);
    expect(preflight.indexOf("throw new Error")).toBeLessThan(preflight.indexOf("prerequisitesMet = true"));
    expect(preflight).not.toMatch(/\b(INSERT|UPDATE|DELETE|createVerified|beginProvisioningDispatch)\b/);
  });

  it("every fixture write goes through ONE helper, which refuses unless the preflight passed and registers the smoke id for cleanup first", () => {
    expect(code.match(/\.createVerified\(/g)).toHaveLength(1);
    const helper = /async function verifiedAttempt\(suffix: string\) \{([\s\S]*?)\n  \}/.exec(code)?.[1] ?? "";
    const guard = helper.indexOf("if (!prerequisitesMet) throw");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(helper.indexOf("cleanupCredentialIds.add"));
    expect(helper.indexOf("cleanupCredentialIds.add")).toBeLessThan(helper.indexOf(".createVerified("));
    expect(helper).toContain("const credentialId = `smoke-${runId}-pd-${suffix}`;");
    // The only direct SQL write on registration_attempts is scoped to this run's smoke ids.
    const directWrites = code.match(/UPDATE registration_attempts[^\n]*/g) ?? [];
    expect(directWrites).toHaveLength(1);
    for (const statement of directWrites) expect(statement).toContain("LIKE ${`smoke-${runId}-pd-%`}");
  });

  it("cleanup deletes dispatch rows and attempt rows in SEPARATE try blocks, only for smoke ids, and reports every failure", () => {
    const cleanup = /afterAll\(async \(\) => \{([\s\S]*?)\n  \}\);/.exec(code)?.[1] ?? "";
    expect(cleanup).toMatch(/if \(!id\.startsWith\(`smoke-\$\{runId\}-pd-`\)\) throw/);
    const tries = cleanup.match(/try \{\s*await sql`DELETE FROM (\w+)/g) ?? [];
    expect(tries.map((t) => t.split("DELETE FROM ")[1])).toEqual(["registration_provisioning_dispatches", "registration_attempts"]);
    expect(cleanup).toContain("expect(failures).toEqual([]);");
  });
});
