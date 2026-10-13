import { DELETE_SUBJECT_SQL, SCHEMA_EXTERNAL_DEPENDENCIES_SQL, SCHEMA_INVENTORY_SQL, SCHEMA_RESIDUE_SQL, SUBJECT_RESIDUE_SQL, type ScratchObject } from "./provider-budget-smoke";
import type { QueryDb } from "./provisioning-limits-smoke";

/**
 * TEST-ONLY, IN-MEMORY stand-in for what the provider-budget smoke's FINAL
 * CLEANUP talks to: the rows of public.real_provider_budgets and a set of
 * scratch schemas. It is not a database and proves nothing about one. It
 * understands exactly the statements the cleanup plan can build and REJECTS
 * any other, records every statement it was sent, and does only what it is
 * told: a drop of something absent, or of a schema that still holds an
 * object, is refused the way Postgres would refuse it, and any chosen
 * statement can be made to fail, to apply and lose its answer, to stall, or
 * never to answer at all.
 */
export type FakeStatement = {
  kind: "delete_subject" | "inventory" | "dependencies" | "drop_object" | "drop_schema" | "subject_residue" | "schema_residue";
  /** The subject, the schema, or `<schema>.<object>`. */
  target: string;
  text: string;
};

/**
 * Decides, per statement, how it misbehaves.
 *   error      it rejects with this; `applied: true` means it took effect first (its answer was lost).
 *   stallMs    it does nothing for this long before answering.
 *   never      it never answers at all.
 *   rows       it answers with these rows instead of its real ones (its effect, if any, still happens).
 */
export type FakeBehavior = { error?: unknown; applied?: boolean; stallMs?: number; never?: boolean; rows?: unknown };
export type FakeFailure = (statement: FakeStatement, index: number) => FakeBehavior | undefined;

type External = { foreign_keys: number; triggers: number; inheritance: number; view_references: number };
const NO_EXTERNAL: External = { foreign_keys: 0, triggers: 0, inheritance: 0, view_references: 0 };
const sqlError = (message: string, code: string) => Object.assign(new Error(message), { code });

const DROP_OBJECT = /^DROP (TABLE|VIEW) ([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*) RESTRICT$/;
const DROP_FUNCTION = /^DROP FUNCTION ([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\(\) RESTRICT$/;
const DROP_SCHEMA = /^DROP SCHEMA ([a-z_][a-z0-9_]*) RESTRICT$/;

export function createFakeBudgetDb() {
  /** subject -> its buckets */
  const rows = new Map<string, Set<string>>();
  const schemas = new Map<string, { objects: ScratchObject[]; external: External }>();
  const log: FakeStatement[] = [];
  let failure: FakeFailure | null = null;
  /** Statements sent and not yet answered. */
  let pending = 0;
  /** Statements that were stalled and have since been answered, in the order they settled. */
  const settledAfterStall: FakeStatement[] = [];

  const recognize = (text: string, params: unknown[]): { statement: FakeStatement; kind: ScratchObject["kind"] | null; names: string[] } | null => {
    const one = params.length === 1 && typeof params[0] === "string" ? params[0] : null;
    const list = params.length === 1 && Array.isArray(params[0]) && params[0].every((name) => typeof name === "string") ? (params[0] as string[]) : null;
    if (text === DELETE_SUBJECT_SQL && one !== null) return { statement: { kind: "delete_subject", target: one, text }, kind: null, names: [] };
    if (text === SCHEMA_INVENTORY_SQL && one !== null) return { statement: { kind: "inventory", target: one, text }, kind: null, names: [] };
    if (text === SCHEMA_EXTERNAL_DEPENDENCIES_SQL && one !== null) return { statement: { kind: "dependencies", target: one, text }, kind: null, names: [] };
    if (text === SUBJECT_RESIDUE_SQL && list !== null) return { statement: { kind: "subject_residue", target: "owned subjects", text }, kind: null, names: list };
    if (text === SCHEMA_RESIDUE_SQL && list !== null) return { statement: { kind: "schema_residue", target: "owned schemas", text }, kind: null, names: list };
    if (params.length !== 0) return null;
    const object = DROP_OBJECT.exec(text);
    if (object) return { statement: { kind: "drop_object", target: `${object[2]}.${object[3]}`, text }, kind: object[1] === "VIEW" ? "view" : "table", names: [object[2]!, object[3]!] };
    const fn = DROP_FUNCTION.exec(text);
    if (fn) return { statement: { kind: "drop_object", target: `${fn[1]}.${fn[2]}`, text }, kind: "function", names: [fn[1]!, fn[2]!] };
    const schema = DROP_SCHEMA.exec(text);
    if (schema) return { statement: { kind: "drop_schema", target: schema[1]!, text }, kind: null, names: [schema[1]!] };
    return null;
  };

  const apply = (found: NonNullable<ReturnType<typeof recognize>>): Array<Record<string, unknown>> => {
    const { statement, kind, names } = found;
    switch (statement.kind) {
      case "delete_subject": {
        const buckets = [...(rows.get(statement.target) ?? [])];
        rows.delete(statement.target);
        return buckets.map((bucket) => ({ bucket }));
      }
      case "inventory":
        return (schemas.get(statement.target)?.objects ?? []).map((object) => ({ kind: object.kind, name: object.name }));
      case "dependencies":
        return [{ ...(schemas.get(statement.target)?.external ?? NO_EXTERNAL) }];
      case "subject_residue":
        return [{ n: names.reduce((total, subject) => total + (rows.get(subject)?.size ?? 0), 0) }];
      case "schema_residue":
        return [{ n: names.filter((name) => schemas.has(name)).length }];
      case "drop_object": {
        const schema = schemas.get(names[0]!);
        if (!schema) throw sqlError(`schema "${names[0]}" does not exist`, "3F000");
        const index = schema.objects.findIndex((object) => object.kind === kind && object.name === names[1]);
        if (index < 0) throw sqlError(`${kind} "${names[1]}" does not exist`, kind === "function" ? "42883" : "42P01");
        schema.objects.splice(index, 1);
        return [];
      }
      case "drop_schema": {
        const schema = schemas.get(names[0]!);
        if (!schema) throw sqlError(`schema "${names[0]}" does not exist`, "3F000");
        if (schema.objects.length > 0) throw sqlError(`cannot drop schema ${names[0]} because other objects depend on it`, "2BP01");
        schemas.delete(names[0]!);
        return [];
      }
    }
  };

  const db: QueryDb = {
    async q(text, params = []) {
      const found = recognize(text, params);
      if (found === null) throw new Error("fake budget db: a statement the cleanup is not allowed to send");
      log.push(found.statement);
      const behave = failure?.(found.statement, log.length - 1);
      pending += 1;
      try {
        if (behave?.never) await new Promise<never>(() => undefined);
        if (behave?.stallMs !== undefined) {
          await new Promise<void>((resolve) => setTimeout(resolve, behave.stallMs));
          settledAfterStall.push(found.statement);
        }
        if (behave && "error" in behave && behave.error !== undefined) {
          if (behave.applied) apply(found);
          throw behave.error;
        }
        const answer = apply(found);
        return behave && "rows" in behave ? (behave.rows as Array<Record<string, unknown>>) : answer;
      } finally {
        pending -= 1;
      }
    },
  };

  return {
    db,
    log,
    /** Puts budget rows in place, as if the production store had charged them. */
    seedRows(subject: string, buckets: readonly string[]): void {
      rows.set(subject, new Set([...(rows.get(subject) ?? []), ...buckets]));
    },
    /** Puts a schema and its objects in place, as if the run had created them. */
    seedSchema(schema: string, objects: readonly ScratchObject[] = [], external: Partial<External> = {}): void {
      schemas.set(schema, { objects: objects.map((object) => ({ ...object })), external: { ...NO_EXTERNAL, ...external } });
    },
    failWhen(next: FakeFailure | null): void {
      failure = next;
    },
    rowsOf: (subject: string): string[] => [...(rows.get(subject) ?? [])].sort(),
    subjects: (): string[] => [...rows.keys()].sort(),
    schemaNames: (): string[] => [...schemas.keys()].sort(),
    objectsIn: (schema: string): ScratchObject[] => (schemas.get(schema)?.objects ?? []).map((object) => ({ ...object })),
    pending: (): number => pending,
    settledAfterStall: (): FakeStatement[] => [...settledAfterStall],
    /** Every statement sent that changes something. */
    writes: (): FakeStatement[] => log.filter((statement) => statement.kind === "delete_subject" || statement.kind === "drop_object" || statement.kind === "drop_schema"),
  };
}
export type FakeBudgetDb = ReturnType<typeof createFakeBudgetDb>;
