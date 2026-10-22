/**
 * Milestone 3C-2 — the used-marker store for stateless login challenges.
 * SERVER-ONLY.
 *
 * A login challenge (login-challenge.ts) is signed and expiring but carries no
 * server state, so single use is enforced HERE: after — and only after — a
 * login assertion has been cryptographically verified and every pre-marker
 * acceptance check passed, the challenge's 16-byte nonce is recorded in the
 * dedicated real_login_challenge_uses table (schema.sql, "Login Challenge Uses"
 * block). A nonce can be recorded once: the primary key is the single-use
 * enforcement. Nothing anonymous ever writes here — a forged, malformed,
 * expired, or failing-assertion request causes ZERO marker writes — and nothing
 * in this module ever deletes a marker on behalf of a caller (only the bounded
 * purge inside the insert statement removes markers, and only long after they
 * can matter).
 *
 * This table is deliberately NOT webauthn_challenges and never reuses it.
 *
 * THE STATEMENT (neon-store.ts) is ONE autocommit statement: a bounded,
 * SKIP LOCKED purge of markers expired for more than an HOUR, and the insert.
 * Never wrap it in a transaction, never split the purge from the insert. The
 * one-hour margin is what makes cleanup safe: a replay can only be accepted if
 * its marker is absent, and a marker is only purged when its challenge expired
 * so long ago that no admissible (application-prechecked, database-checked)
 * challenge can match it — even if a request stalled with a stale
 * transaction-start now() while another session purged. The insert additionally
 * checks expiry against the database's clock, and RETURNING checks it AGAIN
 * after the insert: an inserted-but-already-expired marker is NEVER an
 * admission. ASSUMPTION (documented, not proven offline): the database clock
 * does not move backward by anything near an hour; a backward step of that size
 * is outside this design. The replay-after-purge race and its correction need
 * disposable-Neon verification; none has been run.
 *
 * OUTCOMES. Exactly one returned row with live === true: consumed. Exactly one
 * with live === false: the challenge expired (rejected, and the marker stays).
 * Zero rows: already used, expired, or pre-filtered (rejected). Anything else —
 * several rows, a missing or non-boolean live, a database error — is an
 * INVARIANT FAILURE that throws; the login route answers its generic 500 and no
 * session is issued. An uncertain write is NEVER retried.
 *
 * ROLLING DEPLOYMENT. The table must exist before the new verification code
 * runs (without it every login answers the generic 500 — fail closed). Old and
 * new login code never share a challenge: there is no fallback to database login
 * challenges. Do not delete or truncate used markers on rollback.
 *
 * NOT DEPLOYABLE YET: the migration has not been applied to any database.
 */

export type LoginChallengeUseOutcome = "consumed" | "rejected";

/** The persistence seam. Inputs are already validated by consumeLoginChallenge; a store throws on any invariant failure. */
export interface LoginChallengeUseStore {
  consume(input: { nonceHex: string; expiresAtIso: string }): Promise<LoginChallengeUseOutcome>;
}

/** Expired markers are kept this long past their expiry before a purge may remove them. */
export const LOGIN_CHALLENGE_USE_RETENTION_MS = 60 * 60 * 1000;
/** The most markers one insert statement may purge. */
export const LOGIN_CHALLENGE_USE_PURGE_BATCH = 64;
/** The database refuses an expiration further ahead than this (a real token is at most about 5 minutes ahead). */
export const LOGIN_CHALLENGE_USE_MAX_AHEAD_MS = 10 * 60 * 1000;

const NONCE_HEX = /^[0-9a-f]{32}$/;
const ISO_UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

/** Throws unless `value` is exactly 32 lowercase hex characters (a 16-byte nonce). */
export function assertNonceHex(value: unknown): string {
  if (typeof value !== "string" || !NONCE_HEX.test(value)) throw new Error("Login challenge use refused: the nonce is not 32 lowercase hex characters.");
  return value;
}

/** Throws unless `value` is an explicit-UTC ISO timestamp (milliseconds, trailing Z) that round-trips exactly. */
export function assertExpiresAtIso(value: unknown): string {
  if (typeof value !== "string" || !ISO_UTC.test(value)) throw new Error("Login challenge use refused: the expiration is not an explicit-UTC ISO timestamp.");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw new Error("Login challenge use refused: the expiration is not a valid timestamp.");
  return value;
}

/**
 * The marker statement's returned rows -> an outcome, or a throw. Used by the
 * Neon adapter; the in-memory model produces the same shapes.
 */
export function classifyLoginChallengeUseRows(rows: unknown): LoginChallengeUseOutcome {
  if (!Array.isArray(rows)) throw new Error("Login challenge use refused: the store did not return a list of rows.");
  if (rows.length === 0) return "rejected";
  if (rows.length > 1) throw new Error("Login challenge use refused: the marker statement returned more than one row.");
  const row: unknown = rows[0];
  const live = typeof row === "object" && row !== null ? (row as { live?: unknown }).live : undefined;
  if (live === true) return "consumed";
  if (live === false) return "rejected";
  throw new Error("Login challenge use refused: the marker statement's live flag is missing or not a boolean.");
}

/**
 * Atomically records a verified login challenge as used. Returns true ONLY when
 * the marker was newly recorded and the challenge was still live by the
 * database's clock; false for an already-used, expired, or pre-filtered
 * challenge. Throws — and the caller must issue no session and enter no
 * provisioning — on invalid input, a database error, or any malformed answer.
 */
export async function consumeLoginChallenge(store: LoginChallengeUseStore, challenge: { nonceHex: string; expiresAtIso: string }): Promise<boolean> {
  const nonceHex = assertNonceHex(challenge.nonceHex);
  const expiresAtIso = assertExpiresAtIso(challenge.expiresAtIso);
  const outcome: unknown = await store.consume({ nonceHex, expiresAtIso });
  if (outcome === "consumed") return true;
  if (outcome === "rejected") return false;
  throw new Error("Login challenge use refused: the store gave an unusable answer.");
}

export type InMemoryLoginChallengeUseStore = LoginChallengeUseStore & {
  /** Test visibility only. */
  snapshot(): Array<{ nonceHex: string; expiresAtMs: number; usedAtMs: number }>;
};

/**
 * Unit tests and local development ONLY — one process, lost on restart, and
 * never selected in production (runtime.ts fails closed without a database).
 * The SAME ordering as the SQL statement: a bounded purge of markers expired
 * for more than an hour (oldest first, at most 64), then the database-clock
 * pre-filter (expiry in the future and within 10 minutes), then an insert that
 * does nothing on a conflict, then a SECOND clock reading that decides `live`.
 * An inserted marker whose challenge has meanwhile expired is kept and refused.
 * It claims no stronger concurrency than the real adapter: JavaScript is single
 * threaded, so each consume is atomic here. `nowMs` is injectable.
 */
export function createInMemoryLoginChallengeUseStore(nowMs: () => number = Date.now): InMemoryLoginChallengeUseStore {
  const markers = new Map<string, { expiresAtMs: number; usedAtMs: number }>();
  return {
    snapshot: () => [...markers.entries()].map(([nonceHex, marker]) => ({ nonceHex, ...marker })),
    async consume(input) {
      const nonceHex = assertNonceHex(input.nonceHex);
      const expiresAtMs = Date.parse(assertExpiresAtIso(input.expiresAtIso));
      // Bounded purge: only markers expired for more than the retention margin, oldest first.
      const purgeBefore = nowMs() - LOGIN_CHALLENGE_USE_RETENTION_MS;
      const stale = [...markers.entries()].filter(([, marker]) => marker.expiresAtMs < purgeBefore).sort((a, b) => a[1].expiresAtMs - b[1].expiresAtMs).slice(0, LOGIN_CHALLENGE_USE_PURGE_BATCH);
      for (const [key] of stale) markers.delete(key);
      // Pre-filter on the database clock: not yet expired, and not implausibly far ahead.
      const now = nowMs();
      if (!(expiresAtMs > now && expiresAtMs <= now + LOGIN_CHALLENGE_USE_MAX_AHEAD_MS)) return "rejected";
      if (markers.has(nonceHex)) return "rejected"; // ON CONFLICT DO NOTHING: no row returned
      markers.set(nonceHex, { expiresAtMs, usedAtMs: nowMs() });
      // RETURNING checks expiry once more, after the insert.
      return classifyLoginChallengeUseRows([{ live: expiresAtMs > nowMs() }]);
    },
  };
}
