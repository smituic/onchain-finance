/**
 * 'backup_registration'/'backup_login_verification' are Batch 2g's
 * backup-passkey purposes — see schema.sql's identical CHECK constraint
 * comment for why they're kept distinct from 'registration'/'login'.
 * 'backup_step_up' (2g-H) is the fresh session-credential assertion that must
 * precede every backup registration challenge. 'handle_claim' is the fresh
 * session-credential assertion that must precede a permanent @handle claim
 * (server/handle-claim.ts) — its own purpose, never backup_step_up.
 */
export type ChallengePurpose = "registration" | "login" | "backup_registration" | "backup_login_verification" | "backup_step_up" | "handle_claim";

export type StoredChallenge = {
  challenge: string;
  purpose: ChallengePurpose;
  createdAt: number;
  expiresAt: number;
  /**
   * Opaque server-side context associated with the pending ceremony (e.g.
   * registration's freshly-minted appUserId/userHandle) — carried from
   * create() to consume() keyed by the challenge itself, never by anything
   * client-supplied, so the caller never has to trust an echoed identifier.
   */
  context: unknown;
};

/**
 * Short-lived, one-time, purpose-bound WebAuthn challenges. Vendor-neutral —
 * route handlers depend on this interface, never on a specific backing
 * store, so tests can inject an in-memory adapter (see
 * createInMemoryChallengeStore) without a database.
 *
 * The challenge VALUE itself is minted by @simplewebauthn/server's own
 * generateRegistrationOptions/generateAuthenticationOptions (see
 * server/webauthn.ts) — this store never generates one itself. Passing a
 * pre-minted string into those functions' own `challenge` option would get
 * silently UTF-8-reinterpreted rather than used as raw bytes, so the
 * challenge this store records must always be optionsJSON.challenge as
 * returned by the library, captured after the fact.
 */
export interface ChallengeStore {
  /** Records an already-minted challenge (with context, if any) with a TTL. S4/3E: also purges up to CHALLENGE_PURGE_BATCH_SIZE (64) challenges already past their expiry, oldest first — no scheduled cleanup job exists, and a backlog drains over later creates. */
  create(input: { challenge: string; purpose: ChallengePurpose; ttlMs: number; context?: unknown }): Promise<StoredChallenge>;
  /**
   * Atomically looks up and removes a challenge. Returns null (never
   * throws) for anything that isn't a live, matching-purpose, unexpired,
   * not-already-consumed challenge — the caller (registration/login
   * verification) must treat null as "reject the request", not distinguish
   * why, so a client can't use the failure reason to probe challenge state.
   */
  consume(input: { challenge: string; purpose: ChallengePurpose }): Promise<StoredChallenge | null>;
}

/**
 * Milestone 3E: the most expired challenges one create() may delete. The Neon
 * adapter's SQL carries the same number as a literal (a test keeps them equal).
 */
export const CHALLENGE_PURGE_BATCH_SIZE = 64;

export function createInMemoryChallengeStore(): ChallengeStore {
  const challenges = new Map<string, StoredChallenge>();

  return {
    async create({ challenge, purpose, ttlMs, context }) {
      const now = Date.now();
      // Same bounded opportunistic purge as the Neon adapter: at most
      // CHALLENGE_PURGE_BATCH_SIZE already-expired challenges (oldest expiry
      // first; the stable sort keeps insertion order for ties) are dropped per
      // create. An expired entry left behind is never consumable — consume()
      // checks expiry itself.
      const expired = [...challenges.values()].filter((record) => record.expiresAt < now).sort((a, b) => a.expiresAt - b.expiresAt);
      for (const record of expired.slice(0, CHALLENGE_PURGE_BATCH_SIZE)) challenges.delete(record.challenge);
      const record: StoredChallenge = { challenge, purpose, createdAt: now, expiresAt: now + ttlMs, context };
      challenges.set(challenge, record);
      return record;
    },
    async consume({ challenge, purpose }) {
      const record = challenges.get(challenge);
      // Delete unconditionally once looked up — a challenge is single-use
      // whether or not this specific consume call ends up accepting it, so
      // a wrong-purpose or expired challenge can never be retried either.
      challenges.delete(challenge);
      if (!record) return null;
      if (record.purpose !== purpose) return null;
      if (Date.now() > record.expiresAt) return null;
      return record;
    },
  };
}
