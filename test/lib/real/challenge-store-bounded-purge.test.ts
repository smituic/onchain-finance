import { afterEach, describe, expect, it, vi } from "vitest";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import { CHALLENGE_PURGE_BATCH_SIZE, createInMemoryChallengeStore, type ChallengePurpose } from "@/lib/real/server/challenge-store";
import { createNeonChallengeStore } from "@/lib/real/server/neon-store";

// Milestone 3E — bounded, oldest-first expired-challenge cleanup on create.
// Everything here is OFFLINE: the in-memory store and a recording SQL fake.
// Neither proves PostgreSQL locking, query-plan or deletion behavior — that
// needs separate controlled live proof.

const T0 = new Date("2026-01-01T00:00:00Z").getTime();

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Seeds `count` challenges, all created at T0, that expire one millisecond apart
 * starting at T0 + 1 (oldest = "e0"). Created at one instant so that no seeding
 * create() itself purges an earlier seed.
 */
async function seedExpired(store: ReturnType<typeof createInMemoryChallengeStore>, count: number, purposes: ChallengePurpose[] = ["login"]) {
  vi.setSystemTime(T0);
  for (let i = 0; i < count; i += 1) {
    await store.create({ challenge: `e${i}`, purpose: purposes[i % purposes.length]!, ttlMs: 1 + i });
  }
}

/** True when the challenge is still physically present, probed WITHOUT leaving it consumed-by-accident: rewind to a time it would be valid. */
async function isPresent(store: ReturnType<typeof createInMemoryChallengeStore>, challenge: string, purpose: ChallengePurpose, validAt: number) {
  const before = Date.now();
  vi.setSystemTime(validAt);
  const result = await store.consume({ challenge, purpose });
  vi.setSystemTime(before);
  return result !== null;
}

describe("in-memory: bounded purge", () => {
  it("the batch size is 64", () => {
    expect(CHALLENGE_PURGE_BATCH_SIZE).toBe(64);
  });

  it("no expired rows: nothing is removed and the new challenge is stored", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const store = createInMemoryChallengeStore();
    await store.create({ challenge: "live", purpose: "login", ttlMs: 60_000 });
    await store.create({ challenge: "next", purpose: "login", ttlMs: 60_000 });
    expect(await store.consume({ challenge: "live", purpose: "login" })).not.toBeNull();
    expect(await store.consume({ challenge: "next", purpose: "login" })).not.toBeNull();
  });

  it("one expired row is removed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const store = createInMemoryChallengeStore();
    await store.create({ challenge: "old", purpose: "login", ttlMs: 1 });
    vi.setSystemTime(T0 + 10);
    await store.create({ challenge: "trigger", purpose: "login", ttlMs: 60_000 });
    // Had "old" been left in place it would be consumable when the clock is rewound.
    expect(await isPresent(store, "old", "login", T0)).toBe(false);
  });

  it("with more than 64 expired rows, exactly the OLDEST 64 are removed and the rest are retained", async () => {
    vi.useFakeTimers();
    const store = createInMemoryChallengeStore();
    await seedExpired(store, 70);
    vi.setSystemTime(T0 + 10_000);
    await store.create({ challenge: "trigger", purpose: "login", ttlMs: 60_000 });

    for (let i = 0; i < 64; i += 1) expect(await isPresent(store, `e${i}`, "login", T0 + i), `e${i} should be purged`).toBe(false);
    for (let i = 64; i < 70; i += 1) expect(await isPresent(store, `e${i}`, "login", T0 + i), `e${i} should be retained`).toBe(true);
  });

  it("exactly 64 expired rows are all removed", async () => {
    vi.useFakeTimers();
    const store = createInMemoryChallengeStore();
    await seedExpired(store, 64);
    vi.setSystemTime(T0 + 10_000);
    await store.create({ challenge: "trigger", purpose: "login", ttlMs: 60_000 });
    for (let i = 0; i < 64; i += 1) expect(await isPresent(store, `e${i}`, "login", T0 + i)).toBe(false);
  });

  it("selects by expiry, not insertion order", async () => {
    vi.useFakeTimers();
    const store = createInMemoryChallengeStore();
    // 65 rows inserted newest-expiry first: the single row left behind must be the NEWEST expiry.
    for (let i = 64; i >= 0; i -= 1) {
      vi.setSystemTime(T0);
      await store.create({ challenge: `r${i}`, purpose: "login", ttlMs: 1 + i });
    }
    vi.setSystemTime(T0 + 10_000);
    await store.create({ challenge: "trigger", purpose: "login", ttlMs: 60_000 });
    expect(await isPresent(store, "r64", "login", T0 + 1)).toBe(true);
    for (let i = 0; i < 64; i += 1) expect(await isPresent(store, `r${i}`, "login", T0 + 1), `r${i}`).toBe(false);
  });

  it("live challenges are never removed, even alongside a large expired backlog", async () => {
    vi.useFakeTimers();
    const store = createInMemoryChallengeStore();
    vi.setSystemTime(T0);
    await store.create({ challenge: "live", purpose: "registration", ttlMs: 3_600_000 });
    await seedExpired(store, 100);
    vi.setSystemTime(T0 + 10_000);
    await store.create({ challenge: "trigger", purpose: "login", ttlMs: 60_000 });
    expect(await store.consume({ challenge: "live", purpose: "registration" })).not.toBeNull();
  });

  it("the purge is purpose-independent: expired rows of every purpose are removed oldest-first", async () => {
    vi.useFakeTimers();
    const store = createInMemoryChallengeStore();
    const purposes: ChallengePurpose[] = ["registration", "login", "backup_registration", "backup_login_verification", "backup_step_up", "handle_claim"];
    await seedExpired(store, 66, purposes);
    vi.setSystemTime(T0 + 10_000);
    await store.create({ challenge: "trigger", purpose: "login", ttlMs: 60_000 });
    for (let i = 0; i < 64; i += 1) expect(await isPresent(store, `e${i}`, purposes[i % purposes.length]!, T0 + i)).toBe(false);
    for (let i = 64; i < 66; i += 1) expect(await isPresent(store, `e${i}`, purposes[i % purposes.length]!, T0 + i)).toBe(true);
  });

  it("strict boundary: a challenge expiring exactly now is not purged; one millisecond earlier is", async () => {
    vi.useFakeTimers();
    const store = createInMemoryChallengeStore();
    vi.setSystemTime(T0);
    await store.create({ challenge: "at-now", purpose: "login", ttlMs: 1_000 });
    await store.create({ challenge: "just-before", purpose: "login", ttlMs: 999 });
    vi.setSystemTime(T0 + 1_000);
    await store.create({ challenge: "trigger", purpose: "login", ttlMs: 60_000 });
    expect(await isPresent(store, "just-before", "login", T0)).toBe(false);
    expect(await store.consume({ challenge: "at-now", purpose: "login" })).not.toBeNull();
  });

  it("an expired challenge is rejected even though physical cleanup was deferred", async () => {
    vi.useFakeTimers();
    const store = createInMemoryChallengeStore();
    await seedExpired(store, 70);
    vi.setSystemTime(T0 + 10_000);
    await store.create({ challenge: "trigger", purpose: "login", ttlMs: 60_000 });
    // e69 is expired and still physically present (past the 64-row batch), yet not consumable.
    expect(await store.consume({ challenge: "e69", purpose: "login" })).toBeNull();
  });

  it("a wrong-purpose consume burns the challenge, and a replay is rejected", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const store = createInMemoryChallengeStore();
    await store.create({ challenge: "c", purpose: "registration", ttlMs: 60_000 });
    expect(await store.consume({ challenge: "c", purpose: "login" })).toBeNull();
    expect(await store.consume({ challenge: "c", purpose: "registration" })).toBeNull();

    await store.create({ challenge: "d", purpose: "login", ttlMs: 60_000 });
    expect(await store.consume({ challenge: "d", purpose: "login" })).not.toBeNull();
    expect(await store.consume({ challenge: "d", purpose: "login" })).toBeNull();
  });

  it("sequential creates gradually drain a backlog, 64 at a time", async () => {
    vi.useFakeTimers();
    // consume() is destructive, so each checkpoint replays the sequence on a fresh store and probes only at the end.
    const remainingAfter = async (creates: number) => {
      const store = createInMemoryChallengeStore();
      await seedExpired(store, 150);
      for (let n = 0; n < creates; n += 1) {
        vi.setSystemTime(T0 + 10_000);
        await store.create({ challenge: `t${n}`, purpose: "login", ttlMs: 1 });
      }
      let count = 0;
      for (let i = 0; i < 150; i += 1) if (await isPresent(store, `e${i}`, "login", T0)) count += 1;
      return count;
    };
    expect(await remainingAfter(0)).toBe(150);
    expect(await remainingAfter(1)).toBe(86);
    expect(await remainingAfter(2)).toBe(22);
    expect(await remainingAfter(3)).toBe(0);
  });

  it("concurrent creates with distinct challenge values all succeed and each stays consumable exactly once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const store = createInMemoryChallengeStore();
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.create({ challenge: `c${i}`, purpose: "login", ttlMs: 60_000 })));
    for (let i = 0; i < 20; i += 1) {
      expect(await store.consume({ challenge: `c${i}`, purpose: "login" })).not.toBeNull();
      expect(await store.consume({ challenge: `c${i}`, purpose: "login" })).toBeNull();
    }
  });

  it("concurrent consume of one challenge: exactly one success (in-memory only — not a PostgreSQL proof)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const store = createInMemoryChallengeStore();
    await store.create({ challenge: "race", purpose: "login", ttlMs: 60_000 });
    const results = await Promise.all(Array.from({ length: 8 }, () => store.consume({ challenge: "race", purpose: "login" })));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });
});

type Call = { text: string; values: unknown[] };

function recordingSql(behavior: () => Promise<unknown[]> = () => Promise.resolve([])) {
  const calls: Call[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("$?").replace(/\s+/g, " ").trim(), values });
    return behavior();
  }) as unknown as NeonQueryFunction<false, false>;
  return { sql, calls };
}

const EXPECTED_SQL =
  "WITH purged AS ( DELETE FROM webauthn_challenges d WHERE d.challenge IN ( SELECT p.challenge FROM webauthn_challenges p WHERE p.expires_at < $? ORDER BY p.expires_at LIMIT 64 FOR UPDATE SKIP LOCKED ) ) " +
  "INSERT INTO webauthn_challenges (challenge, purpose, context, expires_at) VALUES ($?, $?, $?, $?)";

describe("Neon: bounded purge SQL structure (offline pin — not proof of PostgreSQL behavior)", () => {
  it("create sends exactly this one statement, with the cutoff first and the original INSERT arguments", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-01T00:00:00Z");
    vi.setSystemTime(now);
    const { sql, calls } = recordingSql();
    const result = await createNeonChallengeStore(sql).create({ challenge: "c1", purpose: "handle_claim", ttlMs: 300_000, context: { a: 1 } });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe(EXPECTED_SQL);
    expect(calls[0]!.values).toEqual([now.toISOString(), "c1", "handle_claim", JSON.stringify({ a: 1 }), new Date(now.getTime() + 300_000).toISOString()]);
    expect(result).toEqual({ challenge: "c1", purpose: "handle_claim", createdAt: now.getTime(), expiresAt: now.getTime() + 300_000, context: { a: 1 } });
  });

  it("the SQL literal limit equals CHALLENGE_PURGE_BATCH_SIZE", async () => {
    const { sql, calls } = recordingSql();
    await createNeonChallengeStore(sql).create({ challenge: "c", purpose: "login", ttlMs: 1_000 });
    expect(calls[0]!.text).toContain(`LIMIT ${CHALLENGE_PURGE_BATCH_SIZE} FOR UPDATE SKIP LOCKED`);
  });

  it("no transaction, separate cleanup statement, purpose filter, or extra predicate", async () => {
    const { sql, calls } = recordingSql();
    await createNeonChallengeStore(sql).create({ challenge: "c", purpose: "login", ttlMs: 1_000 });
    const text = calls[0]!.text;
    expect(text.replace("FOR UPDATE SKIP LOCKED", "")).not.toMatch(/\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b|\bSAVEPOINT\b|\bUPDATE\b|\bTRUNCATE\b|\bLOCK TABLE\b|\bnow\(\)|clock_timestamp/i);
    expect(text.match(/WHERE/g)).toHaveLength(2); // the DELETE's IN-subselect link and the cutoff
    expect(text.match(/expires_at < \$\?/g)).toHaveLength(1);
    expect(text).not.toMatch(/purpose\s*(=|IN|<>|!=)/i);
  });

  it("drift detection: each mutation of the production statement no longer matches the pin", async () => {
    const { sql, calls } = recordingSql();
    await createNeonChallengeStore(sql).create({ challenge: "c", purpose: "login", ttlMs: 1_000 });
    const actual = calls[0]!.text;
    expect(actual).toBe(EXPECTED_SQL);
    const mutations: [string, (t: string) => string][] = [
      ["unbounded", (t) => t.replace(" LIMIT 64", "")],
      ["limit raised", (t) => t.replace("LIMIT 64", "LIMIT 6400")],
      ["not oldest-first", (t) => t.replace(" ORDER BY p.expires_at", "")],
      ["waits on locks", (t) => t.replace(" SKIP LOCKED", "")],
      ["no row locks", (t) => t.replace(" FOR UPDATE SKIP LOCKED", "")],
      ["non-strict cutoff", (t) => t.replace("expires_at < $?", "expires_at <= $?")],
      ["database-clock cutoff", (t) => t.replace("expires_at < $?", "expires_at < now()")],
      ["purpose-filtered", (t) => t.replace("WHERE p.expires_at", "WHERE p.purpose = 'login' AND p.expires_at")],
    ];
    for (const [name, mutate] of mutations) {
      const mutated = mutate(actual);
      expect(mutated, `${name}: mutation must change the text`).not.toBe(actual);
      expect(mutated, `${name}: mutated text must not satisfy the pin`).not.toBe(EXPECTED_SQL);
    }
  });

  it("consume is unchanged: one atomic DELETE ... RETURNING by challenge, expiry checked after", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const rowFor = (expiresAt: number, purpose = "login") => [{ purpose, context: null, created_at: new Date(T0 - 1_000).toISOString(), expires_at: new Date(expiresAt).toISOString() }];
    const { sql, calls } = recordingSql(() => Promise.resolve(rowFor(T0 - 1)));
    const store = createNeonChallengeStore(sql);
    // An expired row (still present because cleanup was deferred) is returned by the DELETE but rejected.
    expect(await store.consume({ challenge: "x", purpose: "login" })).toBeNull();
    expect(calls[0]!.text).toBe("DELETE FROM webauthn_challenges WHERE challenge = $? RETURNING purpose, context, created_at, expires_at");

    const live = createNeonChallengeStore(recordingSql(() => Promise.resolve(rowFor(T0 + 1_000))).sql);
    expect((await live.consume({ challenge: "x", purpose: "login" }))?.challenge).toBe("x");
    // Wrong purpose: the DELETE already burned the row; the caller gets null.
    const wrong = createNeonChallengeStore(recordingSql(() => Promise.resolve(rowFor(T0 + 1_000, "registration"))).sql);
    expect(await wrong.consume({ challenge: "x", purpose: "login" })).toBeNull();
  });
});

describe("Neon: failure behavior", () => {
  it("a database failure propagates unchanged and is never retried", async () => {
    const failure = new Error("connection reset");
    const { sql, calls } = recordingSql(() => Promise.reject(failure));
    await expect(createNeonChallengeStore(sql).create({ challenge: "c", purpose: "login", ttlMs: 1_000 })).rejects.toBe(failure);
    expect(calls).toHaveLength(1);
  });

  it("a synchronous throw from the client also propagates with a single attempt", async () => {
    let attempts = 0;
    const sql = (() => {
      attempts += 1;
      throw new Error("boom");
    }) as unknown as NeonQueryFunction<false, false>;
    await expect(createNeonChallengeStore(sql).create({ challenge: "c", purpose: "login", ttlMs: 1_000 })).rejects.toThrow("boom");
    expect(attempts).toBe(1);
  });
});
