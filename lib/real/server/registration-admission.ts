/**
 * Milestone 3C-1 — Global Registration Admission. SERVER-ONLY.
 *
 * Gates ONE route: POST /api/real/account/register/options. It decides whether
 * a registration may START (a challenge may be minted); it takes no part in
 * registration verification, login, provisioning, or any payment authority.
 *
 * CONTROLLED DEVELOPMENT ONLY — NOT production abuse protection. One GLOBAL
 * pool is shared by everyone: 30 admitted requests per 3600 s and 100 per
 * 86400 s. Anonymous callers can exhaust it, which protects the database but
 * can temporarily keep legitimate users from starting to register. It bounds
 * the RATE of registration-attempt growth, not the lifetime number of stored
 * attempts. There is NO client-IP attribution (no header is read; no trusted
 * ingress exists), so per-source limits remain a prerequisite for public
 * registration.
 *
 * ALGORITHM: two first-admission-anchored FIXED windows in one row. An admitted
 * request charges BOTH windows; a refused request changes NEITHER counter nor
 * window. A window that has elapsed is reset by the next ADMITTED request.
 * Database time is authoritative. A fixed window can let up to about 2x its
 * limit through around a boundary — accepted.
 *
 * TWO STATEMENTS (neon-store.ts), by design:
 *   E1  one autocommit conditional UPDATE ... RETURNING. It is the ONLY thing
 *       that can grant admission: exactly one returned row means admitted.
 *   E2  only after E1 returned zero rows, a separate read-only SELECT with a
 *       fresh snapshot. It can only CLASSIFY a refusal (and time it); it never
 *       grants admission. Zero rows from E1 is not "missing": it can be an
 *       exhausted window, a lost race at a boundary, or an absent row, and only
 *       a read taken afterwards can tell them apart.
 * No read-then-write flow, no transaction wrapper, no CTE fallback.
 *
 * READ COMMITTED: the expected concurrent behaviour (concurrent UPDATEs queue
 * on the row's tuple lock, then re-check the WHERE clause and recompute the SET
 * values against the newest row version) is PostgreSQL's READ COMMITTED
 * behaviour. Nothing here sets the isolation level; under REPEATABLE READ or
 * SERIALIZABLE a concurrent UPDATE would raise a serialization failure, which
 * throws and so fails closed (never an over-admission) but would reduce
 * availability. A future disposable-Neon smoke must ASSERT the isolation level
 * actually in force; it has not been run.
 *
 * DENIAL: no counter or window is changed and no new row version is written. A
 * refused UPDATE that raced a concurrent writer may take a transient tuple lock
 * and generate a lock WAL record, and every refusal still costs a query (and
 * usually a second one, E2): this is not "zero database work".
 *
 * FAIL CLOSED: a policy that fails validation (checked BEFORE any statement), a
 * database error, a missing row, a malformed or surprising row, or an unusable
 * answer all THROW; the route answers its generic 500 and mints no challenge.
 * The row is never re-created by a request, and production never uses the
 * in-memory store (runtime.ts).
 *
 * The real_registration_admission table (schema.sql) must exist, and be
 * seeded, before this code is deployed. It has not been created anywhere yet.
 */

/** Hard ceilings the validator enforces on any policy handed to a store. */
export const REGISTRATION_ADMISSION_MAX_WINDOW_SECONDS = 86_400;
export const REGISTRATION_ADMISSION_MAX_LIMIT = 100_000;
/** E2 may report a wait up to this much beyond a window (clock drift / a start slightly in the future); anything larger is corrupt. */
export const REGISTRATION_ADMISSION_CLOCK_TOLERANCE_SECONDS = 60;

/** The one scope the table holds. Written into the SQL text, never sent as a parameter. */
export const REGISTRATION_ADMISSION_SCOPE = "register_options";

export type RegistrationAdmissionWindow = { readonly limit: number; readonly windowSeconds: number };
export type RegistrationAdmissionPolicy = { readonly short: RegistrationAdmissionWindow; readonly day: RegistrationAdmissionWindow };

/** FROZEN. No environment override, no user-controlled number, no mutation. */
export const REGISTRATION_ADMISSION_POLICY: RegistrationAdmissionPolicy = Object.freeze({
  short: Object.freeze({ limit: 30, windowSeconds: 3_600 }),
  day: Object.freeze({ limit: 100, windowSeconds: 86_400 }),
});

/** Internal only: the route turns a refusal into a 503 with Retry-After; no count, limit, window, or key ever leaves the server. */
export type RegistrationAdmissionDecision = { admitted: true } | { admitted: false; retryAfterSeconds: number };

export type RegistrationAdmissionErrorKind = "policy" | "missing_row" | "malformed_state" | "unusable_answer";

/** Every way this module refuses to guess. The route's catch turns all of them into the same generic 500. */
export class RegistrationAdmissionError extends Error {
  constructor(
    readonly kind: RegistrationAdmissionErrorKind,
    message: string,
  ) {
    super(`Registration admission refused: ${message}`);
    this.name = "RegistrationAdmissionError";
  }
}

/** The persistence seam: one atomic admission against the given (validated-by-the-store) policy. */
export interface RegistrationAdmissionStore {
  admit(policy: RegistrationAdmissionPolicy): Promise<RegistrationAdmissionDecision>;
}

/** What the route holds: the frozen policy is not a parameter, so no caller can supply numbers. */
export interface RegistrationAdmission {
  admit(): Promise<RegistrationAdmissionDecision>;
}

const isIntInRange = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

const hasExactKeys = (value: object, keys: readonly string[]): boolean => {
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, index) => key === keys[index]);
};

function validateWindow(name: string, value: unknown): RegistrationAdmissionWindow {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !hasExactKeys(value, ["limit", "windowSeconds"])) {
    throw new RegistrationAdmissionError("policy", `the ${name} window is not exactly { limit, windowSeconds }.`);
  }
  const { limit, windowSeconds } = value as { limit: unknown; windowSeconds: unknown };
  if (!isIntInRange(limit, 1, REGISTRATION_ADMISSION_MAX_LIMIT)) throw new RegistrationAdmissionError("policy", `the ${name} limit must be a whole number from 1 to ${REGISTRATION_ADMISSION_MAX_LIMIT}.`);
  if (!isIntInRange(windowSeconds, 1, REGISTRATION_ADMISSION_MAX_WINDOW_SECONDS)) {
    throw new RegistrationAdmissionError("policy", `the ${name} window must be a whole number of seconds from 1 to ${REGISTRATION_ADMISSION_MAX_WINDOW_SECONDS}.`);
  }
  return { limit, windowSeconds };
}

/**
 * Validates EVERY policy value and returns a fresh frozen copy. Every store
 * calls this BEFORE its first statement, so a zero, negative, fractional,
 * non-finite, unsafe, mistyped, or oversized value — which could otherwise make
 * a window instantly elapsed (unlimited admission) — never reaches the database.
 * The short window must be strictly shorter than the daily window.
 */
export function validateRegistrationAdmissionPolicy(policy: unknown): RegistrationAdmissionPolicy {
  if (typeof policy !== "object" || policy === null || Array.isArray(policy) || !hasExactKeys(policy, ["day", "short"])) {
    throw new RegistrationAdmissionError("policy", "the policy is not exactly { short, day }.");
  }
  const { short, day } = policy as { short: unknown; day: unknown };
  const validShort = validateWindow("short", short);
  const validDay = validateWindow("day", day);
  if (validShort.windowSeconds >= validDay.windowSeconds) throw new RegistrationAdmissionError("policy", "the short window must be shorter than the daily window.");
  return Object.freeze({ short: Object.freeze(validShort), day: Object.freeze(validDay) });
}

/** A database integer: a JS safe integer, or (defensively) a string of digits. Anything else is not a counter. */
function asInteger(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value === "string" && /^-?[0-9]{1,15}$/.test(value)) return Number(value);
  return null;
}

function singleRow(rows: unknown): Record<string, unknown> {
  if (!Array.isArray(rows)) throw new RegistrationAdmissionError("malformed_state", "the database did not return a list of rows.");
  if (rows.length === 0) throw new RegistrationAdmissionError("missing_row", "the admission row is missing.");
  if (rows.length > 1) throw new RegistrationAdmissionError("malformed_state", "the database returned more than one admission row.");
  const row: unknown = rows[0];
  if (typeof row !== "object" || row === null || Array.isArray(row)) throw new RegistrationAdmissionError("malformed_state", "the admission row is not an object.");
  return row as Record<string, unknown>;
}

/**
 * E1's answer. Exactly ONE row is an admission, and only if both returned
 * counters are whole numbers within 1..their window's current limit (an admitted
 * request has always just been counted, so 0 and anything above the limit are
 * impossible). Zero rows is NOT handled here — it means "not admitted" and goes
 * to E2; the caller must not call this with it.
 */
export function interpretAdmittedRows(policy: RegistrationAdmissionPolicy, rows: unknown): { admitted: true } {
  const row = singleRow(rows);
  const shortHits = asInteger(row.short_hits);
  const dayHits = asInteger(row.day_hits);
  if (shortHits === null || dayHits === null || shortHits < 1 || shortHits > policy.short.limit || dayHits < 1 || dayHits > policy.day.limit) {
    throw new RegistrationAdmissionError("malformed_state", "an admission returned counters that are not possible.");
  }
  return { admitted: true };
}

function hitsOf(value: unknown): number {
  const hits = asInteger(value);
  if (hits === null || hits < 0 || hits > REGISTRATION_ADMISSION_MAX_LIMIT) throw new RegistrationAdmissionError("malformed_state", "a stored counter is not a whole number in range.");
  return hits;
}

/** NULL means "that window has elapsed"; otherwise 1..windowSeconds + tolerance, clamped to the window. Undefined, zero, negative, fractional, or larger is corrupt. */
function waitOf(value: unknown, windowSeconds: number): number | null {
  if (value === null) return null;
  const wait = asInteger(value);
  if (wait === null || wait < 1 || wait > windowSeconds + REGISTRATION_ADMISSION_CLOCK_TOLERANCE_SECONDS) {
    throw new RegistrationAdmissionError("malformed_state", "a reported wait is not a whole number of seconds in range.");
  }
  return Math.min(wait, windowSeconds);
}

/**
 * E2's answer, after E1 returned zero rows. ALWAYS a refusal (or a throw) —
 * never an admission. A window is exhausted when it has NOT elapsed and its
 * counter has reached the CURRENT limit (a counter above a lowered limit is
 * legitimate and counts as exhausted). Retry-After is the LONGEST exhausted
 * wait; if neither window looks exhausted, capacity changed between E1 and E2
 * (a window rolled, or a limit was raised), so the refusal stands and the
 * advice is 1 second. Zero rows (the singleton is missing), several rows, or
 * any malformed field throws.
 */
export function classifyRegistrationDenial(policy: RegistrationAdmissionPolicy, rows: unknown): { admitted: false; retryAfterSeconds: number } {
  const row = singleRow(rows);
  const shortHits = hitsOf(row.short_hits);
  const dayHits = hitsOf(row.day_hits);
  const shortWait = waitOf(row.short_wait, policy.short.windowSeconds);
  const dayWait = waitOf(row.day_wait, policy.day.windowSeconds);
  let retryAfterSeconds = 0;
  if (shortWait !== null && shortHits >= policy.short.limit) retryAfterSeconds = Math.max(retryAfterSeconds, shortWait);
  if (dayWait !== null && dayHits >= policy.day.limit) retryAfterSeconds = Math.max(retryAfterSeconds, dayWait);
  return { admitted: false, retryAfterSeconds: retryAfterSeconds === 0 ? 1 : retryAfterSeconds };
}

/** The decision a store reports must be exactly an admission or a refusal with a usable delay; anything else throws. A throw is never an admission. */
function parseDecision(decision: unknown, policy: RegistrationAdmissionPolicy): RegistrationAdmissionDecision {
  if (typeof decision === "object" && decision !== null) {
    const { admitted, retryAfterSeconds } = decision as { admitted?: unknown; retryAfterSeconds?: unknown };
    if (admitted === true) return { admitted: true };
    const longest = Math.max(policy.short.windowSeconds, policy.day.windowSeconds);
    if (admitted === false && isIntInRange(retryAfterSeconds, 1, longest)) return { admitted: false, retryAfterSeconds };
  }
  throw new RegistrationAdmissionError("unusable_answer", "the store gave an answer that is neither an admission nor a usable refusal.");
}

export function createRegistrationAdmission(store: RegistrationAdmissionStore): RegistrationAdmission {
  return {
    async admit() {
      const policy = validateRegistrationAdmissionPolicy(REGISTRATION_ADMISSION_POLICY);
      return parseDecision(await store.admit(policy), policy);
    },
  };
}

export type InMemoryRegistrationAdmissionState = { shortStartMs: number; shortHits: number; dayStartMs: number; dayHits: number };

/**
 * Unit tests and local development ONLY — one process, lost on restart, and
 * never selected in production (runtime.ts fails closed without a database).
 * The SAME rules as the SQL: both windows anchored by the first ADMITTED
 * request (an unseeded window counts as elapsed), a request admitted only if
 * each window has elapsed or is under its limit, both windows charged together,
 * a refusal changing nothing, and the refusal classified by the very same
 * classifyRegistrationDenial the Neon adapter uses. `nowMs` is injectable.
 */
export function createInMemoryRegistrationAdmissionStore(nowMs: () => number = Date.now): RegistrationAdmissionStore & { snapshot(): InMemoryRegistrationAdmissionState } {
  const state = { shortStartMs: Number.NEGATIVE_INFINITY, shortHits: 0, dayStartMs: Number.NEGATIVE_INFINITY, dayHits: 0 };
  return {
    /** Test visibility only: a copy of the counters and window starts. */
    snapshot: () => ({ ...state }),
    async admit(rawPolicy) {
      const policy = validateRegistrationAdmissionPolicy(rawPolicy);
      const now = nowMs();
      const shortElapsed = state.shortStartMs + policy.short.windowSeconds * 1000 <= now;
      const dayElapsed = state.dayStartMs + policy.day.windowSeconds * 1000 <= now;
      if ((shortElapsed || state.shortHits < policy.short.limit) && (dayElapsed || state.dayHits < policy.day.limit)) {
        if (shortElapsed) {
          state.shortStartMs = now;
          state.shortHits = 1;
        } else state.shortHits += 1;
        if (dayElapsed) {
          state.dayStartMs = now;
          state.dayHits = 1;
        } else state.dayHits += 1;
        return interpretAdmittedRows(policy, [{ short_hits: state.shortHits, day_hits: state.dayHits }]);
      }
      const waitFor = (startMs: number, windowSeconds: number, elapsed: boolean) => (elapsed ? null : Math.max(1, Math.ceil((startMs + windowSeconds * 1000 - now) / 1000)));
      return classifyRegistrationDenial(policy, [
        {
          short_hits: state.shortHits,
          day_hits: state.dayHits,
          short_wait: waitFor(state.shortStartMs, policy.short.windowSeconds, shortElapsed),
          day_wait: waitFor(state.dayStartMs, policy.day.windowSeconds, dayElapsed),
        },
      ]);
    },
  };
}
