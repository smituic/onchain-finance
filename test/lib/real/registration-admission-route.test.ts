import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryChallengeStore, type ChallengeStore } from "@/lib/real/server/challenge-store";
import {
  REGISTRATION_ADMISSION_MAX_LIMIT,
  REGISTRATION_ADMISSION_POLICY,
  REGISTRATION_ADMISSION_SCOPE,
  createInMemoryRegistrationAdmissionStore,
  createRegistrationAdmission,
  type RegistrationAdmission,
  type RegistrationAdmissionDecision,
} from "@/lib/real/server/registration-admission";
import { REGISTRATION_UNAVAILABLE_MESSAGE, registrationUnavailableResponse } from "@/lib/real/server/http";

/**
 * Milestone 3C-1 — POST /api/real/account/register/options against the ACTUAL
 * route.ts: only the runtime getters (and, to count calls, beginRegistration)
 * are replaced. Plus the runtime selection, the static isolation guards, and
 * the schema.sql block. Offline only: no SQL is executed, no database, no network.
 */

const SECRET = "4be1c0d27a9f3e8d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170605";
const ROUTE = "@/app/api/real/account/register/options/route";

function stubEnv(overrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    NEXT_PUBLIC_REAL_MODE_ENABLED: "true",
    TURNKEY_PARENT_ORGANIZATION_ID: "parent-org",
    TURNKEY_API_PUBLIC_KEY: "public-key",
    TURNKEY_API_PRIVATE_KEY: "private-key",
    REAL_SESSION_SECRET: SECRET,
    NEXT_PUBLIC_REAL_RP_ID: "localhost",
    NEXT_PUBLIC_REAL_ORIGIN: "http://localhost:3000",
    PIMLICO_API_KEY: "pim_test_key",
    ...overrides,
  };
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value as string);
}

type Harness = { events: string[]; challengeCreates: number; admitCalls: number; beginCalls: number };

async function loadRoute(options: { env?: Record<string, string | undefined>; admission: RegistrationAdmission | ((events: string[]) => RegistrationAdmission); challengeStore?: ChallengeStore }) {
  vi.resetModules();
  stubEnv(options.env);
  const harness: Harness = { events: [], challengeCreates: 0, admitCalls: 0, beginCalls: 0 };
  const inner = options.challengeStore ?? createInMemoryChallengeStore();
  const challengeStore: ChallengeStore = {
    consume: (input) => inner.consume(input),
    create: async (input) => {
      harness.events.push("challenge.create");
      harness.challengeCreates += 1;
      return inner.create(input);
    },
  };
  const real = typeof options.admission === "function" ? options.admission(harness.events) : options.admission;
  const admission: RegistrationAdmission = {
    admit: async () => {
      harness.events.push("admission.admit");
      harness.admitCalls += 1;
      return real.admit();
    },
  };
  vi.doMock("@/lib/real/server/runtime", () => ({ getChallengeStore: () => challengeStore, getRegistrationAdmission: () => admission }));
  vi.doMock("@/lib/real/server/registration", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/real/server/registration")>();
    return {
      ...actual,
      beginRegistration: (input: Parameters<typeof actual.beginRegistration>[0]) => {
        harness.events.push("beginRegistration");
        harness.beginCalls += 1;
        return actual.beginRegistration(input);
      },
    };
  });
  const route = (await import(/* @vite-ignore */ ROUTE)) as { POST: () => Promise<Response> };
  return { post: route.POST, harness };
}

const fixed = (decision: RegistrationAdmissionDecision): RegistrationAdmission => ({ admit: async () => decision });
const throwing = (error: Error): RegistrationAdmission => ({ admit: async () => Promise.reject(error) });

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@/lib/real/server/runtime");
  vi.doUnmock("@/lib/real/server/registration");
  vi.unstubAllEnvs();
});

describe("POST /api/real/account/register/options — ordering", () => {
  it("Real Mode disabled -> the existing 404, and the limiter is never called", async () => {
    const { post, harness } = await loadRoute({ env: { NEXT_PUBLIC_REAL_MODE_ENABLED: "false" }, admission: fixed({ admitted: true }) });
    const response = await post();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(harness.events).toEqual([]);
  });

  it("an invalid server configuration -> the generic 500, and NOTHING is charged", async () => {
    const { post, harness } = await loadRoute({ env: { TURNKEY_PARENT_ORGANIZATION_ID: "" }, admission: fixed({ admitted: true }) });
    const response = await post();
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toMatch(/TURNKEY|configuration/i);
    expect(harness.events).toEqual([]);
  });

  it("admitted -> 200 with the options, exactly ONE challenge, created AFTER admission", async () => {
    const { post, harness } = await loadRoute({ admission: fixed({ admitted: true }) });
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("optionsJSON.challenge");
    expect(harness.events).toEqual(["admission.admit", "beginRegistration", "challenge.create"]);
    expect(harness.challengeCreates).toBe(1);
  });

  it("refused -> 503 {error, code}, a valid Retry-After, and NO challenge, NO registration begun", async () => {
    const { post, harness } = await loadRoute({ admission: fixed({ admitted: false, retryAfterSeconds: 1234 }) });
    const response = await post();
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1234");
    expect(await response.json()).toEqual({ error: "We can't open new accounts right now. Please try again later.", code: "registration_unavailable" });
    expect([...response.headers.keys()].sort()).toEqual(["content-type", "retry-after"]);
    expect(harness.events).toEqual(["admission.admit"]);
    expect(harness.challengeCreates).toBe(0);
    expect(harness.beginCalls).toBe(0);
  });

  it("the 503 is not the verify routes' registration_capacity_reached, and carries no retryable field or number but the header", async () => {
    const { post } = await loadRoute({ admission: fixed({ admitted: false, retryAfterSeconds: 42 }) });
    const text = await (await post()).text();
    expect(text).not.toContain("capacity");
    expect(text).not.toContain("retryable");
    expect(text).not.toMatch(/\d/);
  });

  it("a limiter that THROWS -> the generic 500 and no challenge; the 500 never says 'unavailable'", async () => {
    const { post, harness } = await loadRoute({ admission: throwing(new Error('relation "real_registration_admission" does not exist')) });
    const response = await post();
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: "Something went wrong. Please try again." });
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(harness.challengeCreates + harness.beginCalls).toBe(0);
  });

  it("a limiter that returns malformed state -> the generic 500 and no challenge (never a 503, never an admission)", async () => {
    for (const bad of [undefined, null, {}, { admitted: "yes" }, { admitted: false }, { admitted: false, retryAfterSeconds: 0 }, { admitted: false, retryAfterSeconds: 99_999 }]) {
      const { post, harness } = await loadRoute({ admission: createRegistrationAdmission({ admit: async () => bad as never }) });
      const response = await post();
      expect(response.status, JSON.stringify(bad)).toBe(500);
      expect(harness.challengeCreates).toBe(0);
    }
  });

  it("an admission store that throws on a MISSING ROW is the generic 500 (a storage fault is not capacity exhaustion)", async () => {
    const { RegistrationAdmissionError } = await import("@/lib/real/server/registration-admission");
    const { post, harness } = await loadRoute({ admission: throwing(new RegistrationAdmissionError("missing_row", "the admission row is missing.")) });
    expect((await post()).status).toBe(500);
    expect(harness.challengeCreates).toBe(0);
  });

  it("a challenge that fails AFTER admission -> the existing generic 500, and the admission is NOT refunded", async () => {
    const store = createInMemoryRegistrationAdmissionStore(() => 1_800_000_000_000);
    const failing: ChallengeStore = { create: async () => Promise.reject(new Error("challenge store down")), consume: async () => null };
    const first = await loadRoute({ admission: createRegistrationAdmission(store), challengeStore: failing });
    expect((await first.post()).status).toBe(500);
    expect(first.harness.admitCalls).toBe(1);
    // The failed start still used one of the 30: 29 more succeed and the next is refused.
    const second = await loadRoute({ admission: createRegistrationAdmission(store) });
    for (let i = 0; i < 29; i += 1) expect((await second.post()).status, `start ${i + 2}`).toBe(200);
    expect((await second.post()).status).toBe(503);
  });

  it("end to end over the real in-memory model: 30 starts, then a 503 with Retry-After in 1..3600 and no further challenge", async () => {
    let now = 1_800_000_000_000;
    const admission = createRegistrationAdmission(createInMemoryRegistrationAdmissionStore(() => now));
    const { post, harness } = await loadRoute({ admission });
    for (let i = 0; i < 30; i += 1) {
      now += 1000;
      expect((await post()).status, `start ${i + 1}`).toBe(200);
    }
    expect(harness.challengeCreates).toBe(30);
    const refused = await post();
    expect(refused.status).toBe(503);
    const retry = Number(refused.headers.get("Retry-After"));
    expect(Number.isInteger(retry) && retry >= 1 && retry <= 3600).toBe(true);
    expect(harness.challengeCreates).toBe(30);
  });

  it("the route takes no request: it can read no header, cookie, or body", async () => {
    const { post } = await loadRoute({ admission: fixed({ admitted: true }) });
    expect(post.length).toBe(0);
  });
});

describe("registrationUnavailableResponse", () => {
  it("is exactly the approved body and a whole-second Retry-After", async () => {
    const response = registrationUnavailableResponse(3600);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("3600");
    expect(await response.json()).toEqual({ error: REGISTRATION_UNAVAILABLE_MESSAGE, code: "registration_unavailable" });
    expect(REGISTRATION_UNAVAILABLE_MESSAGE).toBe("We can't open new accounts right now. Please try again later.");
  });

  it("throws (the route's generic 500) rather than invent a delay", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 86_401, "5" as unknown as number]) expect(() => registrationUnavailableResponse(bad), String(bad)).toThrow();
    expect(() => registrationUnavailableResponse(1)).not.toThrow();
    expect(() => registrationUnavailableResponse(86_400)).not.toThrow();
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
    expect(() => runtime.getRegistrationAdmission()).toThrow(/DATABASE_URL/);
  });

  it("production with DATABASE_URL: builds the Neon-backed limiter without connecting", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgres://user:pass@example-host/db");
    const runtime = await import("@/lib/real/server/runtime");
    expect(() => runtime.getRegistrationAdmission()).not.toThrow();
  });

  it("development with no database: a working in-memory limiter that admits 30 and refuses the 31st", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "");
    const runtime = await import("@/lib/real/server/runtime");
    const admission = runtime.getRegistrationAdmission();
    for (let i = 0; i < 30; i += 1) expect(await admission.admit()).toEqual({ admitted: true });
    expect((await admission.admit()).admitted).toBe(false);
  });

  it("source: the Neon branch uses the durable store and never the in-memory one, which appears once, past the production throw", () => {
    const runtime = readFileSync("lib/real/server/runtime.ts", "utf8");
    const neonBranch = runtime.slice(runtime.indexOf("if (databaseUrl) {"), runtime.indexOf('if (process.env.NODE_ENV === "production")'));
    expect(neonBranch).toContain("registrationAdmission = createRegistrationAdmission(durable.registrationAdmission);");
    expect(neonBranch).not.toContain("createInMemoryRegistrationAdmissionStore");
    expect(runtime.slice(runtime.indexOf("DATABASE_URL is required in production"))).toContain("registrationAdmission = createRegistrationAdmission(createInMemoryRegistrationAdmissionStore());");
    expect(runtime.match(/createInMemoryRegistrationAdmissionStore\(\)/g)).toHaveLength(1);
    expect(runtime).toContain("&& registrationAdmission) return;");
  });
});

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

describe("static isolation", () => {
  it("the admission module is imported only by the Neon adapter and the runtime; its getter is used only by the one route", () => {
    expect(naming(/from\s+["'][^"']*\/registration-admission["']/)).toEqual(["lib/real/server/neon-store.ts", "lib/real/server/runtime.ts"]);
    expect(naming(/getRegistrationAdmission\b/)).toEqual(["app/api/real/account/register/options/route.ts", "lib/real/server/runtime.ts"]);
    expect(naming(/registrationUnavailableResponse\b/)).toEqual(["app/api/real/account/register/options/route.ts", "lib/real/server/http.ts"]);
    // Mentioned in prose by the module and the runtime's getter; in CODE (a SQL statement) only by the Neon adapter.
    expect(naming(/real_registration_admission/)).toEqual(["lib/real/server/neon-store.ts", "lib/real/server/registration-admission.ts", "lib/real/server/runtime.ts"]);
    expect(sources.filter((file) => /real_registration_admission/.test(codeOf(readFileSync(file, "utf8"))))).toEqual(["lib/real/server/neon-store.ts"]);
  });

  it("the verify, login, handle, passkey, payment, and session routes know nothing of admission", () => {
    const others = sources.filter((file) => file.startsWith("app/api/real/") && file !== "app/api/real/account/register/options/route.ts");
    for (const file of others) expect(readFileSync(file, "utf8"), file).not.toMatch(/registration-admission|getRegistrationAdmission|registration_unavailable/);
    for (const file of ["lib/real/server/registration.ts", "lib/real/server/login.ts", "lib/real/server/onboarding.ts", "lib/real/server/provisioning-dispatch.ts", "lib/real/server/registration-attempts.ts", "lib/real/server/rate-limit.ts"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/registration-admission|RegistrationAdmission/);
    }
  });

  it("no request header, address, cookie, or body is read by the route, the admission module, or the adapter", () => {
    const route = codeOf(readFileSync("app/api/real/account/register/options/route.ts", "utf8"));
    const moduleCode = codeOf(readFileSync("lib/real/server/registration-admission.ts", "utf8"));
    const neon = readFileSync("lib/real/server/neon-store.ts", "utf8");
    const adapter = codeOf(neon.slice(neon.indexOf("export function createNeonRegistrationAdmissionStore"), neon.indexOf("export type NeonDurableStores")));
    const forbidden = /x-forwarded|x-real-ip|forwarded|\bheaders\b|cookies|request\.ip|\bip\b|remoteAddress|socket|readJsonBody|readBoundedJsonBody|await request|new Request|process\.env/i;
    for (const [name, code] of Object.entries({ route, moduleCode, adapter })) {
      expect(code.length, name).toBeGreaterThan(300);
      // The helper's Retry-After header is built in http.ts, so the word "headers" cannot appear here at all.
      expect(code, name).not.toMatch(forbidden);
    }
    expect(route).toContain("export async function POST() {");
  });

  it("the policy is frozen, constant, and has no override path", () => {
    const text = readFileSync("lib/real/server/registration-admission.ts", "utf8");
    expect(text).toContain("Object.freeze({ limit: 30, windowSeconds: 3_600 })");
    expect(text).toContain("Object.freeze({ limit: 100, windowSeconds: 86_400 })");
    expect(codeOf(text)).not.toMatch(/process\.env|import\.meta\.env/);
    expect(REGISTRATION_ADMISSION_POLICY).toEqual({ short: { limit: 30, windowSeconds: 3600 }, day: { limit: 100, windowSeconds: 86_400 } });
    // The only caller of the wrapper's admit() passes no numbers.
    expect(readFileSync("app/api/real/account/register/options/route.ts", "utf8")).toContain("getRegistrationAdmission().admit()");
  });

  it("the adapter never uses a transaction, a CTE, a lock, or a second table, and writes only the one table", () => {
    const neon = readFileSync("lib/real/server/neon-store.ts", "utf8");
    const adapter = codeOf(neon.slice(neon.indexOf("export function createNeonRegistrationAdmissionStore"), neon.indexOf("export type NeonDurableStores")));
    expect(adapter).not.toMatch(/sql\.transaction|\bWITH\b|FOR UPDATE|FOR NO KEY|LOCK TABLE|advisory|BEGIN|COMMIT/i);
    expect(adapter.match(/\bsql`/g)).toHaveLength(2); // E1 and E2, each its own autocommit request
    expect(adapter.match(/real_registration_admission/g)).toHaveLength(2);
    expect(adapter.match(/\bUPDATE real_registration_admission\b/g)).toHaveLength(1);
    expect(adapter).not.toMatch(/INSERT|DELETE/);
    expect(adapter.indexOf("validateRegistrationAdmissionPolicy(rawPolicy)")).toBeLessThan(adapter.indexOf("sql`"));
  });

  it("the module documents the READ COMMITTED assumption and the honest denial semantics", () => {
    const text = readFileSync("lib/real/server/registration-admission.ts", "utf8");
    expect(text).toContain("READ COMMITTED");
    expect(text).toContain("must ASSERT the isolation level");
    expect(text).toContain("transient tuple lock");
    expect(text).toContain("not \"zero database work\"");
    expect(text).toContain("NOT production abuse protection");
  });
});

describe("schema.sql — the Registration Admission block (static; nothing here runs SQL)", () => {
  const schema = readFileSync("lib/real/server/schema.sql", "utf8");
  const BEGIN = "-- BEGIN Registration Admission";
  const END = "-- END Registration Admission";
  const raw = schema.slice(schema.indexOf(BEGIN), schema.indexOf(END));
  const statementOf = (text: string) => text.slice(text.indexOf("DO $$"), text.lastIndexOf("END $$;") + "END $$;".length);
  const statement = statementOf(raw);
  const code = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  const flat = code.replace(/\s+/g, " ");
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const section = (name: string) => schema.slice(schema.indexOf(`-- BEGIN ${name}`), schema.indexOf(`-- END ${name}`));

  it("is ONE new DO block, directly after Provider Budgets and before Provisioning Evidence (which stays last)", () => {
    expect(schema.split(BEGIN)).toHaveLength(2);
    expect(schema.split(END)).toHaveLength(2);
    expect(schema).toContain(`-- END Provider Budgets\n\n${BEGIN}\n`);
    expect(schema).toContain(`${END}\n\n-- BEGIN Provisioning Evidence Capture\n`);
    expect(schema.trimEnd().endsWith("-- END Provisioning Evidence Capture")).toBe(true);
    expect(code.trim().startsWith("DO $$")).toBe(true);
    expect(code.trim().endsWith("END $$;")).toBe(true);
    expect(code.match(/DO \$\$/g)).toHaveLength(1);
    expect(raw.split("DO $$")).toHaveLength(2); // the header never spells out the opening token
    expect(raw.match(/END \$\$;/g)).toHaveLength(1);
  });

  it("the migration statement's length and SHA-256 are pinned (and recorded in its own header)", () => {
    expect(statement).toHaveLength(13_101);
    expect(sha(statement)).toBe("b269ebcc0953efce79c7504ec451237eca3dc1bc4d67996d7179b5eba26ac91f");
    expect(raw.replace(/\n-- /g, " ")).toContain("SHA-256 b269ebcc0953efce79c7504ec451237eca3dc1bc4d67996d7179b5eba26ac91f, 13101 characters.");
  });

  it("the existing evidence-bearing statements are byte-for-byte unchanged", () => {
    const sliceE = statementOf(section("Handle Pay Rate Limits"));
    expect(sliceE).toHaveLength(11_680);
    expect(sha(sliceE)).toBe("78c5557d5b615805f0eb8c63e62d09eccffc792c95f9e2782f9af48d92d1513d");
    const providerBudgets = statementOf(section("Provider Budgets"));
    expect(providerBudgets).toHaveLength(11_820);
    expect(sha(providerBudgets)).toBe("8213b46c2f859fb3c8c5457d34d3dff682508d401fcf82b9169b84333c67a5f5");
    for (const marker of ["-- BEGIN Account Handles", "-- END Account Handles", "-- BEGIN Payment Attempt Recipient Identity", "-- END Payment Attempt Recipient Identity", "-- BEGIN Provisioning Evidence Capture", "-- BEGIN Handle Pay Rate Limits", "-- BEGIN Provider Budgets"]) {
      expect(schema.split(marker), marker).toHaveLength(2);
    }
    // And neither earlier block mentions the new table.
    expect(sliceE + providerBudgets).not.toMatch(/registration_admission/);
  });

  it("defines exactly the five columns and four constraints, nothing else", () => {
    const definition = flat.slice(flat.indexOf("$definition$") + 12, flat.lastIndexOf("$definition$")).trim();
    expect(definition).toBe(
      [
        'scope TEXT COLLATE "C" NOT NULL,',
        "short_window_start TIMESTAMPTZ NOT NULL,",
        "short_hits INTEGER NOT NULL,",
        "day_window_start TIMESTAMPTZ NOT NULL,",
        "day_hits INTEGER NOT NULL,",
        "CONSTRAINT real_registration_admission_pkey PRIMARY KEY (scope),",
        "CONSTRAINT real_registration_admission_scope_check CHECK (scope = 'register_options'),",
        "CONSTRAINT real_registration_admission_short_hits_check CHECK (short_hits >= 0 AND short_hits <= 100000),",
        "CONSTRAINT real_registration_admission_day_hits_check CHECK (day_hits >= 0 AND day_hits <= 100000)",
      ].join(" "),
    );
    expect(flat).toContain("target_schema CONSTANT pg_catalog.text := 'public';");
    expect(flat).toContain("table_name CONSTANT pg_catalog.text := 'real_registration_admission';");
    expect(raw.match(/'public'/g)).toHaveLength(1);
  });

  it("agrees with the code: the scope literal and the counter bound are the module's, and the SQL writes the same table and scope", () => {
    expect(REGISTRATION_ADMISSION_SCOPE).toBe("register_options");
    expect(flat).toContain("seed_scope CONSTANT pg_catalog.text := 'register_options';");
    expect(flat).toContain(`short_hits <= ${REGISTRATION_ADMISSION_MAX_LIMIT}`);
    expect(flat).toContain(`day_hits <= ${REGISTRATION_ADMISSION_MAX_LIMIT}`);
    const neon = readFileSync("lib/real/server/neon-store.ts", "utf8");
    expect(neon.match(/WHERE a\.scope = 'register_options'/g)).toHaveLength(2);
    // The policy numbers are parameters, never in the schema.
    expect(code).not.toMatch(/\b3600\b|\b86400\b|\b30\b(?!\))/);
  });

  it("stores nothing about any request and adds no foreign key, secondary index, trigger, or default", () => {
    expect(code).not.toMatch(/handle|recipient|safe_address|display_name|\bip\b|inet|session|email|passkey|turnkey|app_user_id|account_id|header/i);
    const definition = flat.slice(flat.indexOf("$definition$") + 12, flat.lastIndexOf("$definition$"));
    expect(definition).not.toMatch(/REFERENCES|FOREIGN KEY|INDEX|TRIGGER|DEFAULT|GENERATED|UNIQUE/i);
    expect(code).not.toMatch(/\bCREATE (UNIQUE )?INDEX\b|\bCREATE TRIGGER\b|\bCREATE RULE\b|\bALTER\b|\bTRUNCATE\b|\bGRANT\b|\bDELETE\b|\bUPDATE\b/i);
  });

  it("executes exactly: create-if-absent, the temporary reference, the seed, a seed check, and dropping only the temporary reference", () => {
    const executed = [...code.matchAll(/EXECUTE format\(\s*'([^']*)'/g)].map((match) => match[1]!);
    expect(executed).toEqual([
      "CREATE TABLE IF NOT EXISTS %I.%I (%s)",
      "DROP TABLE IF EXISTS pg_temp.%I",
      "CREATE TEMPORARY TABLE %I (%s) ON COMMIT DROP",
      "INSERT INTO %I.%I (scope, short_window_start, short_hits, day_window_start, day_hits) VALUES (%L, %L::pg_catalog.timestamptz, 0, %L::pg_catalog.timestamptz, 0) ON CONFLICT (scope) DO NOTHING",
      "SELECT pg_catalog.count(*), pg_catalog.count(*) FILTER (WHERE scope = %L) FROM %I.%I",
      "DROP TABLE pg_temp.%I",
    ]);
    // No permanent DROP anywhere.
    for (const drop of code.match(/\bDROP (?:TABLE|INDEX|CONSTRAINT|COLUMN|SCHEMA|TRIGGER|VIEW)\b[^;']*/g) ?? []) expect(drop).toMatch(/pg_temp\./);
    expect(code.match(/\bDROP TABLE\b/g)).toHaveLength(2);
    expect(code.match(/INSERT INTO/g)).toHaveLength(1);
  });

  it("seeds ONLY after every structural proof, idempotently, and proves exactly one seed row", () => {
    const insert = code.indexOf("INSERT INTO %I.%I");
    for (const proof of ["pg_inherits", "relrowsecurity", "pg_trigger", "pg_rewrite", "confrelid = tbl", "contype NOT IN ('c', 'p', 'n')", "has unexpected index(es)", "pg_depend", "pg_get_constraintdef", "tc.atttypid = rc.atttypid"]) {
      expect(code.indexOf(proof), proof).toBeGreaterThan(-1);
      expect(code.indexOf(proof), proof).toBeLessThan(insert);
    }
    expect(code.indexOf("CREATE TABLE IF NOT EXISTS")).toBeLessThan(code.indexOf("pg_catalog.pg_class c WHERE c.relnamespace = ns AND c.relname = table_name"));
    expect(code.match(/ON CONFLICT \(scope\) DO NOTHING/g)).toHaveLength(1);
    expect(code).not.toMatch(/DO UPDATE/i);
    expect(flat).toContain("seed_epoch CONSTANT pg_catalog.text := '1970-01-01 00:00:00+00';");
    const afterInsert = code.slice(insert);
    expect(afterInsert).toContain("seed_total IS DISTINCT FROM 1 OR seed_match IS DISTINCT FROM 1");
    expect(afterInsert.indexOf("seed_total IS DISTINCT FROM 1")).toBeLessThan(afterInsert.indexOf("DROP TABLE pg_temp.%I"));
  });

  it("is fail-closed: search_path pinned first, every refusal RAISEs under one prefix, and the structural proofs are all present", () => {
    expect(flat.slice(flat.indexOf(" BEGIN ") + 1)).toMatch(/^BEGIN PERFORM pg_catalog\.set_config\('search_path', 'pg_catalog, pg_temp', true\);/);
    const raises = [...code.matchAll(/RAISE EXCEPTION '([^']*)'/g)].map((match) => match[1]!);
    expect(raises.length).toBeGreaterThanOrEqual(13);
    for (const message of raises) expect(message).toMatch(/^Registration admission migration refused: /);
    for (const proof of ["pg_inherits", "relrowsecurity", "pg_policy", "pg_trigger", "pg_rewrite", "convalidated", "confrelid = tbl", "contype NOT IN ('c', 'p', 'n')", "indisprimary", "indnullsnotdistinct", "has unexpected index(es)", "pg_depend", "attcollation >= 16384"]) expect(code, proof).toContain(proof);
  });

  it("is the Slice E statement with only the intended differences (same proofs, different table, five-column definition, final seed)", () => {
    const sliceE = statementOf(section("Handle Pay Rate Limits"));
    const normalize = (text: string) =>
      text
        .replace(/real_rate_limits/g, "T")
        .replace(/real_registration_admission/g, "T")
        .replace(/Rate limit migration refused/g, "REFUSED")
        .replace(/Registration admission migration refused/g, "REFUSED");
    const proofLines = (text: string) => normalize(text).split("\n").map((line) => line.trim()).filter((line) => /pg_catalog\.(pg_|count)|RAISE|IF |THEN|END IF|FOR r IN|LOOP|AND |OR /.test(line));
    const slice = new Set(proofLines(sliceE));
    // Every proof line of Slice E is still in the new statement; the new one adds only its own.
    const mine = new Set(proofLines(statement));
    const missing = [...slice].filter((line) => !mine.has(line));
    expect(missing.filter((line) => !/bucket, subject, window_start, hits/.test(line))).toEqual([]);
  });

  it("documents that it is NOT applied, what a rerun does, and the operator-only reseed", () => {
    expect(raw).toContain("NOT APPLIED ANYWHERE");
    expect(raw).toContain("never been parsed or run by PostgreSQL");
    expect(raw).toContain("does not authorize applying it");
    expect(raw).toContain("PRESERVES live counters");
    expect(raw).toContain("RESETS registration capacity");
    expect(raw).toContain("The application never creates or repairs this row");
    expect(raw).toContain("DROP TABLE real_registration_admission");
  });
});
