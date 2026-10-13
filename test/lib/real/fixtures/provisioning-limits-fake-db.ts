import type { QueryDb } from "./provisioning-limits-smoke";

/**
 * TEST-ONLY, IN-MEMORY stand-in for the two provisioning tables, for the
 * OFFLINE lifecycle tests of the provisioning dispatch-ceiling smoke. It is
 * not a database and proves nothing about one: it understands exactly the
 * three statements the smoke's cleanup sends and REJECTS any other, records
 * every statement it was sent, and can be told to fail a chosen one.
 */
const DELETE_DISPATCHES = "DELETE FROM registration_provisioning_dispatches WHERE credential_id = $1 RETURNING id";
const DELETE_ATTEMPT = "DELETE FROM registration_attempts WHERE credential_id = $1 RETURNING credential_id";
const RESIDUE = "SELECT (SELECT count(*) FROM registration_attempts WHERE credential_id LIKE $1)::int AS attempts, (SELECT count(*) FROM registration_provisioning_dispatches WHERE credential_id LIKE $1)::int AS dispatches";

export type FakeStatement = { kind: "delete_dispatches" | "delete_attempt" | "residue"; param: string };
/**
 * Decides, per statement, how it misbehaves.
 *   error      it rejects with this; `applied: true` means it took effect first (its answer was lost).
 *   stallMs    it does nothing for this long before answering — standing in for a request the
 *              caller has stopped waiting for but the database is still working on.
 */
export type FakeFailure = (statement: FakeStatement, index: number) => { error?: unknown; applied?: boolean; stallMs?: number } | undefined;

export function createFakeLedgerDb() {
  const attempts = new Set<string>();
  /** dispatch id -> credential id */
  const dispatches = new Map<string, string>();
  const log: FakeStatement[] = [];
  let failure: FakeFailure | null = null;
  /** Statements currently stalled (sent, not yet answered). */
  let stalled = 0;
  /** Statements that were stalled and have since been answered, in the order they settled. */
  const settledAfterStall: FakeStatement[] = [];

  const apply = (statement: FakeStatement): Array<Record<string, unknown>> => {
    if (statement.kind === "delete_dispatches") {
      const removed = [...dispatches].filter(([, credentialId]) => credentialId === statement.param).map(([id]) => id);
      for (const id of removed) dispatches.delete(id);
      return removed.map((id) => ({ id }));
    }
    if (statement.kind === "delete_attempt") {
      if ([...dispatches.values()].includes(statement.param)) throw Object.assign(new Error('update or delete on table "registration_attempts" violates foreign key constraint'), { code: "23503" });
      return attempts.delete(statement.param) ? [{ credential_id: statement.param }] : [];
    }
    const prefix = statement.param.replace(/%$/, "");
    return [{ attempts: [...attempts].filter((id) => id.startsWith(prefix)).length, dispatches: [...dispatches.values()].filter((id) => id.startsWith(prefix)).length }];
  };

  const db: QueryDb = {
    async q(text, params = []) {
      const kind = text === DELETE_DISPATCHES ? "delete_dispatches" : text === DELETE_ATTEMPT ? "delete_attempt" : text === RESIDUE ? "residue" : null;
      if (kind === null || params.length !== 1 || typeof params[0] !== "string") throw new Error("fake ledger: a statement the cleanup is not allowed to send");
      const statement: FakeStatement = { kind, param: params[0] };
      log.push(statement);
      const behave = failure?.(statement, log.length - 1);
      if (behave?.stallMs !== undefined) {
        stalled += 1;
        await new Promise<void>((resolve) => setTimeout(resolve, behave.stallMs));
        stalled -= 1;
        settledAfterStall.push(statement);
      }
      if (behave && "error" in behave && behave.error !== undefined) {
        if (behave.applied) apply(statement);
        throw behave.error;
      }
      return apply(statement);
    },
  };

  return {
    db,
    attempts,
    dispatches,
    log,
    /** What a fixture write would have created: one attempt and `count` dispatch rows for it. */
    seed(credentialId: string, dispatchIds: string[]): void {
      attempts.add(credentialId);
      for (const id of dispatchIds) dispatches.set(id, credentialId);
    },
    failWhen(next: FakeFailure | null): void {
      failure = next;
    },
    deletes: (): FakeStatement[] => log.filter((statement) => statement.kind !== "residue"),
    stalled: (): number => stalled,
    settledAfterStall,
  };
}
export type FakeLedgerDb = ReturnType<typeof createFakeLedgerDb>;
