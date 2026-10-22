import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOGIN_CHALLENGE_USE_MAX_AHEAD_MS,
  LOGIN_CHALLENGE_USE_PURGE_BATCH,
  LOGIN_CHALLENGE_USE_RETENTION_MS,
  assertExpiresAtIso,
  assertNonceHex,
  classifyLoginChallengeUseRows,
  consumeLoginChallenge,
  createInMemoryLoginChallengeUseStore,
  type LoginChallengeUseStore,
} from "@/lib/real/server/login-challenge-uses";
import { createNeonLoginChallengeUseStore } from "@/lib/real/server/neon-store";

/**
 * Milestone 3C-2 — the used-marker store, its single SQL statement, and its schema block. OFFLINE ONLY: nothing here
 * executes SQL, opens a connection, or contacts a service. The Neon adapter is driven by a scripted fake of the tagged
 * template, exactly as the 3C-1 adapter tests are.
 */
const T0 = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const hex = (n: number) => n.toString(16).padStart(32, "0");
const iso = (ms: number) => new Date(ms).toISOString();
const clock = (start = T0) => {
  let now = start;
  return { now: () => now, set: (value: number) => void (now = value), advance: (ms: number) => void (now += ms) };
};

describe("input validation (before any SQL)", () => {
  it("accepts exactly 32 lowercase hex characters", () => {
    expect(assertNonceHex(hex(1))).toBe(hex(1));
    for (const bad of [undefined, null, 5, "", "A".repeat(32), "g".repeat(32), "0".repeat(31), "0".repeat(33), ` ${"0".repeat(32)}`, `${"0".repeat(32)}\n`, "0x" + "0".repeat(30), [hex(1)]]) {
      expect(() => assertNonceHex(bad), String(bad)).toThrow(/nonce/);
    }
  });

  it("accepts only an explicit-UTC ISO timestamp that round-trips", () => {
    expect(assertExpiresAtIso("2026-10-19T12:34:56.789Z")).toBe("2026-10-19T12:34:56.789Z");
    for (const bad of [undefined, null, 5, "", "2026-10-19", "2026-10-19T12:34:56Z", "2026-10-19T12:34:56.789", "2026-10-19T12:34:56.789+00:00", "2026-10-19 12:34:56.789Z", "2026-13-19T12:34:56.789Z", "2026-02-30T12:34:56.789Z", "2026-10-19T25:00:00.000Z", "2026-10-19T12:34:56.789Z; DROP", "'2026-10-19T12:34:56.789Z'"]) {
      expect(() => assertExpiresAtIso(bad), String(bad)).toThrow(/expiration/);
    }
  });
});

describe("classification of the statement's returned rows", () => {
  it("one row with live === true is consumed; live === false and zero rows are rejected", () => {
    expect(classifyLoginChallengeUseRows([{ live: true }])).toBe("consumed");
    expect(classifyLoginChallengeUseRows([{ live: false }])).toBe("rejected");
    expect(classifyLoginChallengeUseRows([])).toBe("rejected");
  });

  it("more than one row, a missing or non-boolean live, and a non-list are INVARIANT FAILURES (they throw)", () => {
    for (const bad of [[{ live: true }, { live: true }], [{ live: true }, { live: false }], [{}], [{ live: "true" }], [{ live: 1 }], [{ live: null }], [null], [undefined], ["live"], null, undefined, {}, "rows"]) {
      expect(() => classifyLoginChallengeUseRows(bad as never), JSON.stringify(bad)).toThrow(/Login challenge use refused/);
    }
  });

  it("consumeLoginChallenge returns true only for 'consumed', false for 'rejected', and throws on any other answer", async () => {
    const answer = (value: unknown): LoginChallengeUseStore => ({ consume: async () => value as never });
    const input = { nonceHex: hex(1), expiresAtIso: iso(T0) };
    expect(await consumeLoginChallenge(answer("consumed"), input)).toBe(true);
    expect(await consumeLoginChallenge(answer("rejected"), input)).toBe(false);
    for (const bad of [true, false, undefined, null, "ok", "CONSUMED", { outcome: "consumed" }]) await expect(consumeLoginChallenge(answer(bad), input)).rejects.toThrow(/unusable answer/);
  });

  it("a store that throws propagates (the caller issues no session) and is never retried", async () => {
    let calls = 0;
    const failing: LoginChallengeUseStore = { consume: async () => (calls += 1, Promise.reject(new Error("db down"))) };
    await expect(consumeLoginChallenge(failing, { nonceHex: hex(1), expiresAtIso: iso(T0) })).rejects.toThrow("db down");
    expect(calls).toBe(1);
  });

  it("invalid input never reaches the store", async () => {
    const store = { consume: vi.fn(async () => "consumed" as const) };
    await expect(consumeLoginChallenge(store, { nonceHex: "xyz", expiresAtIso: iso(T0) })).rejects.toThrow();
    await expect(consumeLoginChallenge(store, { nonceHex: hex(1), expiresAtIso: "tomorrow" })).rejects.toThrow();
    expect(store.consume).not.toHaveBeenCalled();
  });
});

describe("the in-memory store — the SAME ordering as the SQL statement", () => {
  const consume = (store: LoginChallengeUseStore, n: number, expMs: number) => store.consume({ nonceHex: hex(n), expiresAtIso: iso(expMs) });

  it("records a nonce once: the first use is consumed, every later use is rejected", async () => {
    const c = clock();
    const store = createInMemoryLoginChallengeUseStore(c.now);
    expect(await consume(store, 1, T0 + 5 * MINUTE)).toBe("consumed");
    expect(await consume(store, 1, T0 + 5 * MINUTE)).toBe("rejected");
    expect(await consume(store, 1, T0 + 5 * MINUTE)).toBe("rejected");
    expect(await consume(store, 2, T0 + 5 * MINUTE)).toBe("consumed"); // another nonce is independent
    expect(store.snapshot().map((m) => m.nonceHex)).toEqual([hex(1), hex(2)]);
  });

  it("parallel uses of one nonce: exactly one consumed", async () => {
    const store = createInMemoryLoginChallengeUseStore(clock().now);
    const outcomes = await Promise.all(Array.from({ length: 60 }, () => consume(store, 7, T0 + 5 * MINUTE)));
    expect(outcomes.filter((o) => o === "consumed")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "rejected")).toHaveLength(59);
  });

  it("the pre-filter is on the store's own clock: expired and equal-to-now are rejected AND leave no marker; the 10-minute upper bound is inclusive", async () => {
    const c = clock();
    const store = createInMemoryLoginChallengeUseStore(c.now);
    expect(await consume(store, 1, T0 - 1)).toBe("rejected");
    expect(await consume(store, 2, T0)).toBe("rejected");
    expect(await consume(store, 3, T0 + 1)).toBe("consumed");
    expect(await consume(store, 4, T0 + LOGIN_CHALLENGE_USE_MAX_AHEAD_MS)).toBe("consumed");
    expect(await consume(store, 5, T0 + LOGIN_CHALLENGE_USE_MAX_AHEAD_MS + 1)).toBe("rejected");
    expect(store.snapshot().map((m) => m.nonceHex)).toEqual([hex(3), hex(4)]); // a pre-filtered request writes nothing
  });

  it("an inserted-but-expired marker is NEVER an admission: if the challenge expires between the pre-filter and RETURNING, the answer is rejected and the marker stays", async () => {
    const readings = [T0, T0, T0 + MINUTE, T0 + 2 * MINUTE]; // purge, pre-filter, used_at, RETURNING
    let i = 0;
    const store = createInMemoryLoginChallengeUseStore(() => readings[Math.min(i++, readings.length - 1)]!);
    expect(await consume(store, 9, T0 + 90_000)).toBe("rejected"); // expires at T0+90s; the post-insert reading is T0+120s
    expect(store.snapshot().map((m) => m.nonceHex)).toEqual([hex(9)]);
  });

  it("RETENTION: a marker survives for an hour past its challenge's expiry, so a replay in that window is rejected as 'already used' (and in any case as expired)", async () => {
    const c = clock();
    const store = createInMemoryLoginChallengeUseStore(c.now);
    expect(await consume(store, 1, T0 + 5 * MINUTE)).toBe("consumed");
    c.set(T0 + 5 * MINUTE + HOUR - 1); // 59m59.999s past expiry
    expect(await consume(store, 2, c.now() + 5 * MINUTE)).toBe("consumed"); // a later request runs its purge...
    expect(store.snapshot().map((m) => m.nonceHex)).toContain(hex(1)); // ...which must NOT have removed the retained marker
    expect(LOGIN_CHALLENGE_USE_RETENTION_MS).toBe(HOUR);
  });

  it("REPLAY AFTER PURGE is impossible: once a marker is purged its challenge is long expired, so the pre-filter refuses the replay", async () => {
    const c = clock();
    const store = createInMemoryLoginChallengeUseStore(c.now);
    const exp = T0 + 5 * MINUTE;
    expect(await consume(store, 1, exp)).toBe("consumed");
    c.set(exp + HOUR + MINUTE); // past the retention margin: the marker is purgeable
    expect(await consume(store, 2, c.now() + 5 * MINUTE)).toBe("consumed"); // this call's purge removes marker 1
    expect(store.snapshot().map((m) => m.nonceHex)).toEqual([hex(2)]);
    expect(await consume(store, 1, exp)).toBe("rejected"); // the replay of the consumed challenge: expired, never admitted
    expect(store.snapshot().map((m) => m.nonceHex)).toEqual([hex(2)]); // and it wrote nothing
  });

  it("the purge is BOUNDED (64 per call), oldest first, and only removes markers older than the margin", async () => {
    expect(LOGIN_CHALLENGE_USE_PURGE_BATCH).toBe(64);
    const c = clock();
    const store = createInMemoryLoginChallengeUseStore(c.now);
    for (let n = 1; n <= 100; n += 1) {
      c.set(T0 + n * 1000);
      await consume(store, n, c.now() + MINUTE);
    }
    expect(store.snapshot()).toHaveLength(100);
    c.set(T0 + 100_000 + MINUTE + HOUR + 1_000_000); // every marker is now purgeable
    await consume(store, 1000, c.now() + MINUTE);
    expect(store.snapshot()).toHaveLength(100 - 64 + 1); // 64 oldest removed, the new one added
    expect(store.snapshot().map((m) => m.nonceHex)).not.toContain(hex(1)); // the oldest went first
    expect(store.snapshot().map((m) => m.nonceHex)).toContain(hex(100)); // the newest of the old ones remains
  });

  it("it does not delete a marker for a caller: a consume of an unrelated nonce never removes a retained one", async () => {
    const c = clock();
    const store = createInMemoryLoginChallengeUseStore(c.now);
    await consume(store, 1, T0 + 5 * MINUTE);
    for (let n = 2; n < 20; n += 1) await consume(store, n, T0 + 5 * MINUTE);
    expect(store.snapshot().some((m) => m.nonceHex === hex(1))).toBe(true);
  });

  it("refuses invalid input itself", async () => {
    const store = createInMemoryLoginChallengeUseStore(clock().now);
    await expect(store.consume({ nonceHex: "nope", expiresAtIso: iso(T0) })).rejects.toThrow();
    await expect(store.consume({ nonceHex: hex(1), expiresAtIso: "nope" })).rejects.toThrow();
  });
});

// ------------------------------------------------------------------------------------------------------------------
// The Neon statement, pinned in full against a reference written HERE (never derived from the captured text).
// ------------------------------------------------------------------------------------------------------------------
const normalizeSql = (text: string) => text.replace(/\s+/g, " ").trim();

/** The audited marker statement. $1 nonce hex, $2 expiration ISO (used three times). */
const REFERENCE_SQL = `
WITH purged AS (
  DELETE FROM real_login_challenge_uses d
  WHERE d.nonce IN (
    SELECT p.nonce
    FROM real_login_challenge_uses p
    WHERE p.expires_at < now() - interval '1 hour'
    ORDER BY p.expires_at
    LIMIT 64
    FOR UPDATE SKIP LOCKED
  )
)
INSERT INTO real_login_challenge_uses AS u (nonce, expires_at, used_at)
SELECT decode($1::text, 'hex'), $2::timestamptz, clock_timestamp()
WHERE $2::timestamptz > clock_timestamp()
  AND $2::timestamptz <= clock_timestamp() + interval '10 minutes'
ON CONFLICT (nonce) DO NOTHING
RETURNING (u.expires_at > clock_timestamp()) AS live`;

function asTemplate(reference: string): { text: string; order: number[] } {
  const order: number[] = [];
  const text = normalizeSql(reference).replace(/\$([0-9]+)/g, (_m, n: string) => (order.push(Number(n)), "$"));
  return { text, order };
}

function scriptedSql(result: unknown[] | Error) {
  const calls: { text: string; values: unknown[] }[] = [];
  let transactionUsed = 0;
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join("$").replace(/\s+/g, " ").trim(), values });
      if (result instanceof Error) throw result;
      return result;
    },
    { transaction: () => (transactionUsed += 1, Promise.reject(new Error("sql.transaction must never be used"))) },
  ) as never;
  return { sql, calls, transactionUsed: () => transactionUsed };
}
const NONCE = "000102030405060708090a0b0c0d0e0f";
const EXP = "2026-10-19T12:34:56.789Z";

describe("the Neon adapter — ONE autocommit statement, pinned in full", () => {
  it("the captured statement equals the audited reference (whitespace-normalized), in full", async () => {
    const { sql, calls } = scriptedSql([{ live: true }]);
    await createNeonLoginChallengeUseStore(sql).consume({ nonceHex: NONCE, expiresAtIso: EXP });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe(asTemplate(REFERENCE_SQL).text);
  });

  it("the values are bound parameters in the reference's order: the nonce hex once, the expiration ISO three times (select, and both bounds)", async () => {
    const { sql, calls } = scriptedSql([{ live: true }]);
    await createNeonLoginChallengeUseStore(sql).consume({ nonceHex: NONCE, expiresAtIso: EXP });
    const byNumber: Record<number, string> = { 1: NONCE, 2: EXP };
    expect(calls[0]!.values).toEqual(asTemplate(REFERENCE_SQL).order.map((n) => byNumber[n]));
    expect(asTemplate(REFERENCE_SQL).order).toEqual([1, 2, 2, 2]);
    // Nothing else: no token, credential, user, address, or secret.
    expect(calls[0]!.values).toHaveLength(4);
  });

  it("it is ONE statement: no transaction, no separate purge, no lock statement, no UPDATE of a marker", async () => {
    const { sql, calls, transactionUsed } = scriptedSql([{ live: true }]);
    await createNeonLoginChallengeUseStore(sql).consume({ nonceHex: NONCE, expiresAtIso: EXP });
    const text = calls[0]!.text;
    expect(text.split(";").filter((part) => part.trim() !== "")).toHaveLength(1);
    expect(text.replace("FOR UPDATE SKIP LOCKED", "")).not.toMatch(/\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b|\bSAVEPOINT\b|\bUPDATE\b|DO UPDATE|\bTRUNCATE\b|\bLOCK TABLE\b|webauthn_challenges/i);
    expect(text.match(/real_login_challenge_uses/g)).toHaveLength(3); // the purge's DELETE and sub-select, and the INSERT
    expect(text).toContain("FOR UPDATE SKIP LOCKED"); // the purge takes row locks without waiting
    expect(text).toContain("interval '1 hour'"); // the retention margin
    expect(text).toContain("LIMIT 64");
    expect(text).toContain("ON CONFLICT (nonce) DO NOTHING");
    expect(transactionUsed()).toBe(0);
  });

  it("classifies the answer: live true consumed; live false and zero rows rejected; anything malformed throws", async () => {
    const answer = async (rows: unknown[]) => createNeonLoginChallengeUseStore(scriptedSql(rows).sql).consume({ nonceHex: NONCE, expiresAtIso: EXP });
    expect(await answer([{ live: true }])).toBe("consumed");
    expect(await answer([{ live: false }])).toBe("rejected");
    expect(await answer([])).toBe("rejected");
    await expect(answer([{ live: true }, { live: true }])).rejects.toThrow();
    await expect(answer([{}])).rejects.toThrow();
    await expect(answer([{ live: "t" }])).rejects.toThrow();
  });

  it("a database error (including a missing table or a missing unique index) propagates as itself — never a rejection, never a consumption — and is not retried", async () => {
    for (const error of [Object.assign(new Error('relation "real_login_challenge_uses" does not exist'), { code: "42P01" }), Object.assign(new Error("no unique constraint matching ON CONFLICT"), { code: "42P10" }), new Error("fetch failed")]) {
      const { sql, calls } = scriptedSql(error);
      await expect(createNeonLoginChallengeUseStore(sql).consume({ nonceHex: NONCE, expiresAtIso: EXP })).rejects.toBe(error);
      expect(calls).toHaveLength(1);
    }
  });

  it("invalid inputs make ZERO database calls", async () => {
    for (const input of [
      { nonceHex: "", expiresAtIso: EXP },
      { nonceHex: NONCE.toUpperCase(), expiresAtIso: EXP },
      { nonceHex: `${NONCE}00`, expiresAtIso: EXP },
      { nonceHex: NONCE, expiresAtIso: "" },
      { nonceHex: NONCE, expiresAtIso: "2026-10-19T12:34:56Z" },
      { nonceHex: NONCE, expiresAtIso: "now()" },
      { nonceHex: "'; DROP TABLE x; --", expiresAtIso: EXP },
    ]) {
      const { sql, calls } = scriptedSql([{ live: true }]);
      await expect(createNeonLoginChallengeUseStore(sql).consume(input as never), JSON.stringify(input)).rejects.toThrow();
      expect(calls).toHaveLength(0);
    }
  });

  it("mutation sensitivity: the exact comparison rejects representative bad statements (in-memory strings only)", async () => {
    const { sql, calls } = scriptedSql([{ live: true }]);
    await createNeonLoginChallengeUseStore(sql).consume({ nonceHex: NONCE, expiresAtIso: EXP });
    const original = calls[0]!.text;
    const reference = asTemplate(REFERENCE_SQL).text;
    expect(original).toBe(reference);
    const mutations: Array<[string, (text: string) => string]> = [
      ["purge threshold becomes now() (the unsafe original candidate)", (t) => t.replace("p.expires_at < now() - interval '1 hour'", "p.expires_at < now()")],
      ["purge margin shortened to a minute", (t) => t.replace("interval '1 hour'", "interval '1 minute'")],
      ["purge no longer bounded", (t) => t.replace(" LIMIT 64", "")],
      ["purge limit raised", (t) => t.replace("LIMIT 64", "LIMIT 6400")],
      ["purge waits on locks (SKIP LOCKED removed)", (t) => t.replace(" SKIP LOCKED", "")],
      ["purge not ordered oldest-first", (t) => t.replace(" ORDER BY p.expires_at", "")],
      ["conflict updates the marker", (t) => t.replace("DO NOTHING", "DO UPDATE SET used_at = clock_timestamp()")],
      ["conflict clause removed", (t) => t.replace(" ON CONFLICT (nonce) DO NOTHING", "")],
      ["RETURNING no longer checks expiry after the insert", (t) => t.replace("RETURNING (u.expires_at > clock_timestamp()) AS live", "RETURNING true AS live")],
      ["RETURNING uses the transaction-start clock", (t) => t.replace("RETURNING (u.expires_at > clock_timestamp())", "RETURNING (u.expires_at > now())")],
      ["insert pre-filter uses the transaction-start clock", (t) => t.replace("WHERE $::timestamptz > clock_timestamp()", "WHERE $::timestamptz > now()")],
      ["insert pre-filter drops the upper bound", (t) => t.replace(" AND $::timestamptz <= clock_timestamp() + interval '10 minutes'", "")],
      ["upper bound widened", (t) => t.replace("interval '10 minutes'", "interval '10 days'")],
      ["comparison made inclusive", (t) => t.replace("$::timestamptz > clock_timestamp() AND", "$::timestamptz >= clock_timestamp() AND")],
      ["nonce decoded as base64", (t) => t.replace("decode($::text, 'hex')", "decode($::text, 'base64')")],
      ["marker keyed by the expiration instead of the nonce", (t) => t.replace("ON CONFLICT (nonce)", "ON CONFLICT (expires_at)")],
      ["wrong table", (t) => t.replace("INSERT INTO real_login_challenge_uses", "INSERT INTO webauthn_challenges")],
      ["an appended second statement", (t) => `${t}; DELETE FROM real_login_challenge_uses`],
    ];
    for (const [name, apply] of mutations) {
      const mutated = apply(original);
      expect(mutated, name).not.toBe(original); // a mutation that changed nothing would prove nothing
      expect(normalizeSql(mutated) === reference, name).toBe(false);
    }
    expect(mutations.length).toBeGreaterThanOrEqual(15);
  });
});

// ------------------------------------------------------------------------------------------------------------------
// schema.sql — the Login Challenge Uses block (static; nothing here runs SQL)
// ------------------------------------------------------------------------------------------------------------------
describe("schema.sql — the Login Challenge Uses block (static; nothing here runs SQL)", () => {
  const schema = readFileSync("lib/real/server/schema.sql", "utf8");
  const BEGIN = "-- BEGIN Login Challenge Uses";
  const END = "-- END Login Challenge Uses";
  const section = (name: string) => schema.slice(schema.indexOf(`-- BEGIN ${name}`), schema.indexOf(`-- END ${name}`));
  const statementOf = (text: string) => text.slice(text.indexOf("DO $$"), text.lastIndexOf("END $$;") + "END $$;".length);
  const raw = section("Login Challenge Uses");
  const statement = statementOf(raw);
  const code = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  const flat = code.replace(/\s+/g, " ");
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");

  it("is ONE new DO block, between Registration Admission and Provisioning Evidence (which stays last)", () => {
    expect(schema.split(BEGIN)).toHaveLength(2);
    expect(schema.split(END)).toHaveLength(2);
    expect(schema).toContain(`-- END Registration Admission\n\n${BEGIN}\n`);
    expect(schema).toContain(`${END}\n\n-- BEGIN Provisioning Evidence Capture\n`);
    expect(schema.trimEnd().endsWith("-- END Provisioning Evidence Capture")).toBe(true);
    expect(code.trim().startsWith("DO $$")).toBe(true);
    expect(code.trim().endsWith("END $$;")).toBe(true);
    expect(code.match(/DO \$\$/g)).toHaveLength(1);
    expect(raw.split("DO $$")).toHaveLength(2); // the header never spells out the opening token
    expect(raw.match(/END \$\$;/g)).toHaveLength(1);
    expect(raw.match(/'public'/g)).toHaveLength(1);
  });

  it("the new statement's length and SHA-256 are pinned (and recorded in its own header); the three earlier statements are byte-for-byte unchanged", () => {
    expect(statement).toHaveLength(15_070);
    expect(sha(statement)).toBe("00ff39691a33436ce75d2ff33534983bd408c95574ee4ad8ad9ff6bcdcbf1d1e");
    expect(raw.replace(/\n-- /g, " ")).toContain("SHA-256 00ff39691a33436ce75d2ff33534983bd408c95574ee4ad8ad9ff6bcdcbf1d1e, 15070 characters.");
    const evidence: Array<[string, number, string]> = [
      ["Registration Admission", 13_101, "b269ebcc0953efce79c7504ec451237eca3dc1bc4d67996d7179b5eba26ac91f"],
      ["Handle Pay Rate Limits", 11_680, "78c5557d5b615805f0eb8c63e62d09eccffc792c95f9e2782f9af48d92d1513d"],
      ["Provider Budgets", 11_820, "8213b46c2f859fb3c8c5457d34d3dff682508d401fcf82b9169b84333c67a5f5"],
    ];
    for (const [name, length, digest] of evidence) {
      const earlier = statementOf(section(name));
      expect(earlier, name).toHaveLength(length);
      expect(sha(earlier), name).toBe(digest);
      expect(earlier, name).not.toMatch(/real_login_challenge_uses/);
    }
  });

  it("defines exactly the three columns, the named primary key, and the 16-byte nonce CHECK — no defaults", () => {
    const definition = flat.slice(flat.indexOf("$definition$") + 12, flat.lastIndexOf("$definition$")).trim();
    expect(definition).toBe(
      [
        "nonce BYTEA NOT NULL,",
        "expires_at TIMESTAMPTZ NOT NULL,",
        "used_at TIMESTAMPTZ NOT NULL,",
        "CONSTRAINT real_login_challenge_uses_pkey PRIMARY KEY (nonce),",
        "CONSTRAINT real_login_challenge_uses_nonce_length_check CHECK (octet_length(nonce) = 16)",
      ].join(" "),
    );
    expect(definition).not.toMatch(/DEFAULT|GENERATED|UNLOGGED|REFERENCES|FOREIGN|UNIQUE|TRIGGER/i);
    expect(flat).toContain("table_name CONSTANT pg_catalog.text := 'real_login_challenge_uses';");
    expect(flat).toContain("index_name CONSTANT pg_catalog.text := 'real_login_challenge_uses_expires_at_idx';");
    expect(flat).toContain("index_definition CONSTANT pg_catalog.text := 'USING btree (expires_at)';");
  });

  it("stores nothing identifying: no credential, user, IP, session, token, or purpose column", () => {
    expect(code).not.toMatch(/credential|app_user|\bip\b|inet|session|email|passkey|turnkey|purpose|handle|safe_address/i);
  });

  it("executes exactly: the table, the expiry index, the temporary reference and its index — and writes no rows at all", () => {
    const executed = [...code.matchAll(/EXECUTE format\(\s*'([^']*)'/g)].map((match) => match[1]!);
    expect(executed).toEqual([
      "CREATE TABLE IF NOT EXISTS %I.%I (%s)",
      "CREATE INDEX IF NOT EXISTS %I ON %I.%I %s",
      "DROP TABLE IF EXISTS pg_temp.%I",
      "CREATE TEMPORARY TABLE %I (%s) ON COMMIT DROP",
      "CREATE INDEX %I ON pg_temp.%I %s",
      "DROP TABLE pg_temp.%I",
    ]);
    // A rerun therefore PRESERVES every used marker: there is no INSERT, UPDATE, DELETE, or TRUNCATE of the table anywhere.
    expect(code).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b|\bALTER\b|\bGRANT\b|ON CONFLICT/i);
    for (const drop of code.match(/\bDROP (?:TABLE|INDEX|CONSTRAINT|COLUMN|SCHEMA)\b[^;']*/g) ?? []) expect(drop).toMatch(/pg_temp\./);
    expect(code.match(/\bDROP TABLE\b/g)).toHaveLength(2);
    // The expiry index is created only after the table's own relation checks.
    expect(code.indexOf("CREATE INDEX IF NOT EXISTS")).toBeGreaterThan(code.indexOf("use a type or collation that is not a built-in base type/collation"));
  });

  it("is fail-closed: search_path pinned first, one refusal prefix, and every structural proof is present", () => {
    expect(flat.slice(flat.indexOf(" BEGIN ") + 1)).toMatch(/^BEGIN PERFORM pg_catalog\.set_config\('search_path', 'pg_catalog, pg_temp', true\);/);
    const raises = [...code.matchAll(/RAISE EXCEPTION '([^']*)'/g)].map((match) => match[1]!);
    expect(raises.length).toBeGreaterThanOrEqual(13);
    for (const message of raises) expect(message).toMatch(/^Login challenge uses migration refused: /);
    for (const proof of ["pg_inherits", "relrowsecurity", "pg_policy", "pg_trigger", "pg_rewrite", "convalidated", "confrelid = tbl", "contype NOT IN ('c', 'p', 'n')", "indisprimary", "indnullsnotdistinct", "has unexpected index(es)", "pg_depend", "attcollation >= 16384", "relpersistence IS DISTINCT FROM 'p'", "relispartition IS NOT FALSE"]) {
      expect(code, proof).toContain(proof);
    }
  });

  it("proves the expiry index structurally: btree, non-unique, not primary, valid, ready, permanent, no options, one key column, no expression or predicate, reference opclass/collation/options", () => {
    for (const clause of [
      "ix.relkind IS DISTINCT FROM 'i'",
      "ix.relpersistence IS DISTINCT FROM 'p'",
      "ix.reloptions IS NOT NULL",
      "ix.indrelid IS DISTINCT FROM tbl",
      "am.amname = 'btree'",
      "ix.relam IS DISTINCT FROM rx.relam",
      "ix.indisunique IS NOT FALSE",
      "ix.indisprimary IS NOT FALSE",
      "ix.indisvalid IS NOT TRUE",
      "ix.indisready IS NOT TRUE",
      "ix.indimmediate IS NOT TRUE",
      "ix.indisexclusion IS NOT FALSE",
      "ix.indnatts IS DISTINCT FROM 1",
      "ix.indnkeyatts IS DISTINCT FROM 1",
      "ix.key0 IS DISTINCT FROM own_expires",
      "ix.no_exprs IS NOT TRUE",
      "ix.no_pred IS NOT TRUE",
      "ix.opclasses IS DISTINCT FROM rx.opclasses",
      "ix.collations IS DISTINCT FROM rx.collations",
      "ix.options IS DISTINCT FROM rx.options",
    ]) {
      expect(flat, clause).toContain(clause);
    }
    // Reference index created from the SAME definition constant as the real one.
    expect(flat).toContain("CREATE INDEX %I ON pg_temp.%I %s', reference_name || '_expires_at', reference_name, index_definition");
    // "No other index": everything but the primary key's backing index and the expiry index is refused; the index's own dependencies are checked.
    expect(flat).toContain("i.indexrelid IS DISTINCT FROM ix.oid AND i.indexrelid NOT IN (SELECT c2.conindid FROM pg_catalog.pg_constraint c2 WHERE c2.conrelid = tbl AND c2.contype = 'p')");
    expect(flat).toContain("d.objid = ix.oid");
  });

  it("does not touch any other table or block, and the 'login' purpose stays in the existing webauthn_challenges CHECK (dormant, kept for compatibility)", () => {
    expect(code).not.toMatch(/webauthn_challenges|payment_attempts|real_accounts|real_passkeys|registration_|real_rate_limits|real_provider_budgets/);
    expect(schema).toMatch(/CHECK \(purpose IN \('registration', 'login', 'backup_registration'/);
    for (const marker of ["-- BEGIN Account Handles", "-- BEGIN Payment Attempt Recipient Identity", "-- BEGIN Handle Pay Rate Limits", "-- BEGIN Provider Budgets", "-- BEGIN Registration Admission", "-- BEGIN Provisioning Evidence Capture"]) {
      expect(schema.split(marker), marker).toHaveLength(2);
    }
  });

  it("the header says it is NOT applied, how rollback works (never delete markers), and the deployment order", () => {
    expect(raw).toContain("NOT APPLIED ANYWHERE");
    expect(raw).toContain("never been parsed or run by PostgreSQL");
    expect(raw).toContain("Do NOT delete or truncate used markers");
    expect(raw).toContain("BEFORE the new login/verify code is deployed");
    expect(raw).toContain("PRESERVES every marker");
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Static wiring and isolation
// ------------------------------------------------------------------------------------------------------------------
const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
};
const sources = [...walk("lib"), ...walk("app"), ...walk("components"), ...walk("simulation")].map((file) => file.split(path.sep).join("/"));
const naming = (pattern: RegExp) => sources.filter((file) => pattern.test(readFileSync(file, "utf8"))).sort();
const codeOf = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

describe("static wiring and cross-ceremony isolation", () => {
  it("the used-marker modules are imported only by login.ts, the Neon adapter, and the runtime; the getter only by the verify route", () => {
    expect(naming(/from\s+["'][^"']*\/login-challenge-uses["']/)).toEqual(["lib/real/server/login.ts", "lib/real/server/neon-store.ts", "lib/real/server/runtime.ts"]);
    expect(naming(/from\s+["'][^"']*\/login-challenge["']/)).toEqual(["lib/real/server/login.ts"]);
    expect(naming(/getLoginChallengeUses\b/)).toEqual(["app/api/real/account/login/verify/route.ts", "lib/real/server/runtime.ts"]);
    expect(naming(/real_login_challenge_uses/).filter((file) => /real_login_challenge_uses/.test(codeOf(readFileSync(file, "utf8"))))).toEqual(["lib/real/server/neon-store.ts"]);
  });

  it("login/options touches no store, no runtime, no challenge store, and no database module at all", () => {
    const route = codeOf(readFileSync("app/api/real/account/login/options/route.ts", "utf8"));
    expect(route).not.toMatch(/runtime|ChallengeStore|getChallengeStore|neon|registry|attempts|rate-?limit|headers|cookies|x-forwarded/i);
    expect(route).toContain("await beginLogin({ config })");
    const login = codeOf(readFileSync("lib/real/server/login.ts", "utf8"));
    const begin = login.slice(login.indexOf("export async function beginLogin"), login.indexOf("export type CompleteLoginResult"));
    expect(begin).not.toMatch(/challengeStore|ChallengeStore|registry|attempts|sql|await .*\.(create|consume|find)/);
  });

  it("login.ts no longer imports the database ChallengeStore and issues/consumes no 'login' purpose challenge anywhere in the code base", () => {
    const login = readFileSync("lib/real/server/login.ts", "utf8");
    expect(login).not.toMatch(/challenge-store|ChallengeStore|purpose: "login"/);
    // The only mention of the dormant 'login' purpose is its type/schema/CHECK compatibility: nothing CREATES one.
    for (const file of sources) {
      if (file === "lib/real/server/challenge-store.ts") continue;
      expect(codeOf(readFileSync(file, "utf8")), file).not.toMatch(/purpose:\s*["']login["']/);
    }
    expect(readFileSync("lib/real/server/challenge-store.ts", "utf8")).toContain('"registration" | "login" | "backup_registration"'); // type unchanged
  });

  it("the verify route passes the used-marker store and NO challenge store; registration, step-up, handle, backup and revocation still use the database ChallengeStore", () => {
    const verify = codeOf(readFileSync("app/api/real/account/login/verify/route.ts", "utf8"));
    expect(verify).toContain("loginChallengeUses: getLoginChallengeUses(),");
    expect(verify).not.toMatch(/getChallengeStore|challengeStore/);
    expect(naming(/getChallengeStore\b/).filter((file) => file.startsWith("app/"))).not.toContain("app/api/real/account/login/options/route.ts");
    expect(naming(/getChallengeStore\b/).filter((file) => file.startsWith("app/"))).not.toContain("app/api/real/account/login/verify/route.ts");
    for (const route of ["app/api/real/account/register/options/route.ts", "app/api/real/account/register/verify/route.ts"]) expect(readFileSync(route, "utf8"), route).toContain("getChallengeStore");
    const registration = readFileSync("lib/real/server/registration.ts", "utf8");
    expect(registration).toContain('purpose: "registration"');
    expect(registration).not.toMatch(/login-challenge/);
  });

  it("the token is verified with the ordinary session secret through HKDF only — the raw secret is never the MAC key — and nothing is logged", () => {
    const token = codeOf(readFileSync("lib/real/server/login-challenge.ts", "utf8"));
    expect(token).toContain('hkdfSync("sha256"');
    expect(token).not.toMatch(/createHmac\("sha256", (?:input\.)?sessionSecret/);
    expect(token).not.toMatch(/console\.|process\.env|localStorage|document\./);
    expect(token.match(/createHmac\(/g)).toHaveLength(1);
    expect(token).toContain("timingSafeEqual(presented, expected)");
  });

  it("the marker is written only after verification: completeLogin consumes after the signature, userVerified, and (active branch) status/userHandle checks, and before the counter update, account lookup, session, and pipeline", () => {
    const login = codeOf(readFileSync("lib/real/server/login.ts", "utf8"));
    const consumeAt = [...login.matchAll(/consumeLoginChallenge\(/g)].map((m) => m.index!);
    expect(consumeAt).toHaveLength(2); // one per branch
    const split = login.indexOf("const attempt = await input.attempts.findByCredentialId(");
    const active = login.slice(login.indexOf("const passkey = await"), split);
    const pending = login.slice(split);
    const order = (text: string, needles: string[]) => needles.map((needle) => text.indexOf(needle));
    const activeOrder = order(active, ["passkey.status !== \"active\"", "responseUserHandle", "await verifyLogin(", "userVerified", "consumeLoginChallenge(", "updateAuthenticatorCounter(", "findAccountByAppUserId(", "serializeSession("]);
    expect(activeOrder.every((at) => at >= 0)).toBe(true);
    expect([...activeOrder].sort((a, b) => a - b)).toEqual(activeOrder);
    const pendingOrder = order(pending, ["findByCredentialId(", "responseUserHandle", "await verifyLogin(", "userVerified", "consumeLoginChallenge(", "attempts.updateCounter(", "runProvisioningPipeline("]);
    expect(pendingOrder.every((at) => at >= 0)).toBe(true);
    expect([...pendingOrder].sort((a, b) => a - b)).toEqual(pendingOrder);
    // The token is only PARSED (no database) before any of this.
    expect(login.indexOf("parseLoginChallenge(")).toBeLessThan(login.indexOf("findPasskeyByCredentialId("));
    // The marker call is never wrapped in a transaction by the caller.
    expect(login).not.toMatch(/transaction\(/);
  });

  it("the Neon marker statement is never wrapped in a transaction and is the only statement of the adapter", () => {
    const neon = readFileSync("lib/real/server/neon-store.ts", "utf8");
    const adapter = codeOf(neon.slice(neon.indexOf("export function createNeonLoginChallengeUseStore"), neon.indexOf("/**\n * Milestone 3C-1 — the durable global registration-admission counters")));
    expect(adapter).not.toMatch(/sql\.transaction|BEGIN|COMMIT/);
    expect(adapter.match(/\bsql`/g)).toHaveLength(1);
    expect(adapter).toContain("assertNonceHex(input.nonceHex)");
    expect(adapter.indexOf("assertExpiresAtIso(input.expiresAtIso)")).toBeLessThan(adapter.indexOf("sql`"));
  });
});

describe("runtime selection", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("production without DATABASE_URL: the getter throws (no in-memory fallback)", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "");
    const runtime = await import("@/lib/real/server/runtime");
    expect(() => runtime.getLoginChallengeUses()).toThrow(/DATABASE_URL/);
  });

  it("production with a database configured builds the Neon-backed store without connecting; development gets the in-memory one", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgres://user:pass@example-host/db");
    const prod = await import("@/lib/real/server/runtime");
    expect(() => prod.getLoginChallengeUses()).not.toThrow();
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "");
    const dev = await import("@/lib/real/server/runtime");
    expect(await dev.getLoginChallengeUses().consume({ nonceHex: hex(5), expiresAtIso: iso(Date.now() + 5 * MINUTE) })).toBe("consumed");
    expect(await dev.getLoginChallengeUses().consume({ nonceHex: hex(5), expiresAtIso: iso(Date.now() + 5 * MINUTE) })).toBe("rejected");
  });

  it("source: the Neon branch uses the durable store and never the in-memory one, which appears once, past the production throw", () => {
    const runtime = readFileSync("lib/real/server/runtime.ts", "utf8");
    const neonBranch = runtime.slice(runtime.indexOf("if (databaseUrl) {"), runtime.indexOf('if (process.env.NODE_ENV === "production")'));
    expect(neonBranch).toContain("loginChallengeUses = durable.loginChallengeUses;");
    expect(neonBranch).not.toContain("createInMemoryLoginChallengeUseStore");
    expect(runtime.slice(runtime.indexOf("DATABASE_URL is required in production"))).toContain("loginChallengeUses = createInMemoryLoginChallengeUseStore();");
    expect(runtime.match(/createInMemoryLoginChallengeUseStore\(\)/g)).toHaveLength(1);
  });
});

