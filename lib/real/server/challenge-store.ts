export type ChallengePurpose = "registration" | "login";

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
  /** Records an already-minted challenge (with context, if any) with a TTL. */
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

export function createInMemoryChallengeStore(): ChallengeStore {
  const challenges = new Map<string, StoredChallenge>();

  return {
    async create({ challenge, purpose, ttlMs, context }) {
      const now = Date.now();
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
