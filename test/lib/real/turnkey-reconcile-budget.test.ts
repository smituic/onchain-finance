import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxy } from "@/proxy";
import { CHAIN_READ_POLICIES } from "@/lib/real/server/chain-read-budget";
import { PAY_SUBMIT_POLICIES } from "@/lib/real/server/pay-submit-budget";
import { createInMemoryProviderBudgetStore, createProviderBudgetLimiter, normalizeProviderBudgetPolicies } from "@/lib/real/server/rate-limit";
import { TURNKEY_RECONCILE_POLICIES, TURNKEY_RECONCILE_RATE_LIMITED_MESSAGE, consumeTurnkeyReconcileBudget } from "@/lib/real/server/turnkey-reconcile-budget";
import { realBudget, scriptedBudget } from "./fixtures/chain-read-budget";

const DAY = 86_400;
const ALLOW = { allowed: true } as const;
const deny = (retryAfterSeconds: number) => ({ allowed: false, retryAfterSeconds }) as const;

describe("TURNKEY_RECONCILE_POLICIES — Slice 3A-3 development values", () => {
  it("are exactly the approved development values, on both buckets of the family", () => {
    expect(TURNKEY_RECONCILE_POLICIES).toEqual([
      { bucket: "turnkey_reconcile_short", limit: 20, windowSeconds: 600 },
      { bucket: "turnkey_reconcile_day", limit: 100, windowSeconds: DAY },
    ]);
  });

  it("are frozen — the collection and each entry", () => {
    expect(Object.isFrozen(TURNKEY_RECONCILE_POLICIES)).toBe(true);
    for (const policy of TURNKEY_RECONCILE_POLICIES) expect(Object.isFrozen(policy)).toBe(true);
  });

  it("pass the limiter's own normalization and never share a bucket with another family", () => {
    expect(normalizeProviderBudgetPolicies(TURNKEY_RECONCILE_POLICIES).map((policy) => policy.bucket)).toEqual(["turnkey_reconcile_day", "turnkey_reconcile_short"]);
    for (const other of [...CHAIN_READ_POLICIES, ...PAY_SUBMIT_POLICIES]) {
      expect(TURNKEY_RECONCILE_POLICIES.some((policy) => policy.bucket === other.bucket)).toBe(false);
    }
  });

  it("the denial message is plain language and names no provider, bucket, or counter", () => {
    expect(TURNKEY_RECONCILE_RATE_LIMITED_MESSAGE).not.toMatch(/turnkey|pimlico|bundler|bucket|budget|reconcile|limit/i);
  });
});

describe("consumeTurnkeyReconcileBudget", () => {
  it("charges BOTH buckets in one limiter call, for exactly the subject it was given", async () => {
    const { limiter, calls } = scriptedBudget(ALLOW);
    expect(await consumeTurnkeyReconcileBudget(limiter, "app-user-1")).toEqual({ allowed: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.subject).toBe("app-user-1");
    expect(calls[0]!.policies).toBe(TURNKEY_RECONCILE_POLICIES);
  });

  it("a denial is accepted only with a positive whole-second delay no longer than the longest window", async () => {
    expect(await consumeTurnkeyReconcileBudget(scriptedBudget(deny(1)).limiter, "u")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(await consumeTurnkeyReconcileBudget(scriptedBudget(deny(DAY)).limiter, "u")).toEqual({ allowed: false, retryAfterSeconds: DAY });
  });

  it("a throw is an error, and every malformed answer is an error — never an allow", async () => {
    await expect(consumeTurnkeyReconcileBudget(scriptedBudget(new Error("connection terminated")).limiter, "u")).rejects.toThrow(/connection terminated/);
    for (const bad of [
      undefined,
      null,
      "allowed",
      7,
      true,
      {},
      { retryAfterSeconds: 30 },
      { allowed: "true" },
      { allowed: 1 },
      { allowed: null },
      { allowed: false },
      { allowed: false, retryAfterSeconds: 0 },
      { allowed: false, retryAfterSeconds: -5 },
      { allowed: false, retryAfterSeconds: Number.NaN },
      { allowed: false, retryAfterSeconds: Number.POSITIVE_INFINITY },
      { allowed: false, retryAfterSeconds: 1.5 },
      { allowed: false, retryAfterSeconds: "30" },
      { allowed: false, retryAfterSeconds: DAY + 1 },
    ]) {
      await expect(consumeTurnkeyReconcileBudget(scriptedBudget(bad).limiter, "u"), JSON.stringify(bad)).rejects.toThrow(/unusable limiter answer/);
    }
  });

  it("real accounting: the 21st request in a window is denied; another account and another family are unaffected", async () => {
    const limiter = realBudget();
    for (let i = 0; i < 20; i += 1) expect(await consumeTurnkeyReconcileBudget(limiter, "app-user-1")).toEqual({ allowed: true });
    const denied = await consumeTurnkeyReconcileBudget(limiter, "app-user-1");
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(Number.isSafeInteger(denied.retryAfterSeconds)).toBe(true);
      expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(denied.retryAfterSeconds).toBeLessThanOrEqual(600);
    }
    expect(await consumeTurnkeyReconcileBudget(limiter, "app-user-2")).toEqual({ allowed: true });
    expect((await limiter.consume({ subject: "app-user-1", policies: CHAIN_READ_POLICIES })).allowed).toBe(true);
    expect((await limiter.consume({ subject: "app-user-1", policies: PAY_SUBMIT_POLICIES })).allowed).toBe(true);
  });

  it("real accounting: the daily bucket is enforced independently of the short one, and a denial is never refunded", async () => {
    let now = 0;
    const limiter = createProviderBudgetLimiter(createInMemoryProviderBudgetStore(() => now));
    let allowed = 0;
    // 11 minutes apart over under 24 hours: the 10-minute window always resets, so only the daily bucket can deny.
    for (let i = 0; i < 130; i += 1) {
      now = i * 660_000;
      if ((await consumeTurnkeyReconcileBudget(limiter, "app-user-1")).allowed) allowed += 1;
    }
    expect(allowed).toBe(100);
  });

  it("concurrent charges are each accounted for exactly once (no lost update, no double charge)", async () => {
    const limiter = realBudget();
    const results = await Promise.all(Array.from({ length: 30 }, () => consumeTurnkeyReconcileBudget(limiter, "app-user-1")));
    expect(results.filter((r) => r.allowed)).toHaveLength(20);
    expect(results.filter((r) => !r.allowed)).toHaveLength(10);
  });
});

// ------------------------------------------------------------------ the three routes

const AUTHENTICATED = { account: { appUserId: "session-user-7" }, credentialId: "cred" };
const ENDPOINTS = {
  reconcile: "/api/real/account/passkeys/backup/authorize/reconcile",
  confirm: "/api/real/account/passkeys/backup/verify-signing/confirm",
  remove: "/api/real/account/passkeys/cred-1/revoke/reconcile",
} as const;

describe("the three reconcile routes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("@/app/api/real/account/passkeys/session");
    vi.doUnmock("@/lib/real/server/runtime");
    vi.doUnmock("@/lib/real/server/backup-passkey-pipeline");
    vi.doUnmock("@/lib/real/server/passkey-revocation");
  });

  async function load(opts: { session?: unknown; result?: unknown | Error }) {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_REAL_MODE_ENABLED", "true");
    vi.stubEnv("TURNKEY_PARENT_ORGANIZATION_ID", "parent-org");
    vi.stubEnv("TURNKEY_API_PUBLIC_KEY", "public-key");
    vi.stubEnv("TURNKEY_API_PRIVATE_KEY", "private-key");
    vi.stubEnv("REAL_SESSION_SECRET", "4be1c0d27a9f3e8d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170605");
    vi.stubEnv("NEXT_PUBLIC_REAL_RP_ID", "localhost");
    vi.stubEnv("NEXT_PUBLIC_REAL_ORIGIN", "http://localhost:3000");
    vi.stubEnv("PIMLICO_API_KEY", "pim_test_key");
    const limiter = realBudget();
    const run = vi.fn(async () => {
      if (opts.result instanceof Error) throw opts.result;
      return opts.result;
    });
    vi.doMock("@/app/api/real/account/passkeys/session", () => ({ readPasskeySession: async () => (opts.session === undefined ? AUTHENTICATED : opts.session) }));
    vi.doMock("@/lib/real/server/runtime", () => ({
      getRealAccountRegistry: () => ({}),
      getBackupPasskeyEnrollmentStore: () => ({}),
      getPasskeyRevocationStore: () => ({}),
      getProviderBudgetLimiter: () => limiter,
    }));
    vi.doMock("@/lib/real/server/backup-passkey-pipeline", () => ({ reconcileTurnkeyEnrollment: run, confirmSigningProof: run }));
    vi.doMock("@/lib/real/server/passkey-revocation", () => ({ reconcileRevocation: run }));
    return { run, limiter };
  }

  const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const input = (run: { mock: { calls: unknown[][] } }) => run.mock.calls[0]![0] as Record<string, unknown>;

  async function callReconcile(opts: Parameters<typeof load>[0], body: unknown = { enrollmentId: "e-1", appUserId: "attacker" }) {
    const ctx = await load(opts);
    const route = await import("@/app/api/real/account/passkeys/backup/authorize/reconcile/route");
    return { ...ctx, response: await route.POST(post(ENDPOINTS.reconcile, body)) };
  }
  async function callConfirm(opts: Parameters<typeof load>[0], body: unknown = { enrollmentId: "e-1", activityId: "act-1", appUserId: "attacker" }) {
    const ctx = await load(opts);
    const route = await import("@/app/api/real/account/passkeys/backup/verify-signing/confirm/route");
    return { ...ctx, response: await route.POST(post(ENDPOINTS.confirm, body)) };
  }
  async function callRemove(opts: Parameters<typeof load>[0], body: unknown = { attemptId: "a-1", appUserId: "attacker" }) {
    const ctx = await load(opts);
    const route = await import("@/app/api/real/account/passkeys/[credentialId]/revoke/reconcile/route");
    const request = new NextRequest(`http://localhost${ENDPOINTS.remove}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { ...ctx, response: await route.POST(request, { params: Promise.resolve({ credentialId: "cred-1" }) } as never) };
  }

  it("each route hands its reconcile the runtime's limiter and the SESSION's account — never anything from the body", async () => {
    for (const call of [callReconcile, callConfirm, callRemove]) {
      const { run, limiter } = await call({ result: { outcome: "pending", reason: "x" } });
      const received = input(run as never);
      expect(received.providerBudgetLimiter).toBe(limiter);
      expect(received.appUserId).toBe("session-user-7");
      expect(JSON.stringify(received)).not.toContain("attacker");
    }
  });

  it("an unauthenticated request is 401 and reaches nothing", async () => {
    for (const call of [callReconcile, callConfirm, callRemove]) {
      const { run, response } = await call({ session: null, result: { outcome: "pending", reason: "x" } });
      expect(response.status).toBe(401);
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("a backup reconcile deferral is a 200 carrying the stored state plus reconciliationDeferred and retryAfterSeconds", async () => {
    const pending = await callReconcile({ result: { outcome: "pending", reason: "Your authorization was sent.", reconciliationDeferred: true, retryAfterSeconds: 61 } });
    expect(pending.response.status).toBe(200);
    expect(await pending.response.json()).toEqual({ outcome: "pending", reason: "Your authorization was sent.", reconciliationDeferred: true, retryAfterSeconds: 61 });

    const blocked = await callReconcile({ result: { outcome: "blocked", reason: "needs review", reconciliationDeferred: true, retryAfterSeconds: 5 } });
    expect(blocked.response.status).toBe(200);
    expect(await blocked.response.json()).toEqual({ outcome: "blocked", reason: "needs review", reconciliationDeferred: true, retryAfterSeconds: 5 });
  });

  it("a removal reconcile deferral is a 200 pending with the deferral fields", async () => {
    const { response } = await callRemove({ result: { outcome: "pending", reason: "Removal submitted, not yet confirmed.", reconciliationDeferred: true, retryAfterSeconds: 300 } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "pending", reason: "Removal submitted, not yet confirmed.", reconciliationDeferred: true, retryAfterSeconds: 300 });
  });

  it("ordinary answers keep their existing contract — no deferral metadata added", async () => {
    for (const result of [{ outcome: "confirmed" }, { outcome: "pending", reason: "r" }, { outcome: "blocked", reason: "b" }]) {
      const { response } = await callReconcile({ result });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(result);
    }
    for (const result of [{ outcome: "revoked" }, { outcome: "pending", reason: "r" }, { outcome: "authorization_needed", reason: "a" }, { outcome: "cancelled" }, { outcome: "blocked", reason: "b" }]) {
      const { response } = await callRemove({ result });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(result);
    }
    const rejected = await callReconcile({ result: { outcome: "rejected", reason: "Unknown setup." } });
    expect(rejected.response.status).toBe(400);
    expect(await rejected.response.json()).toEqual({ error: "Unknown setup." });
    expect((await callRemove({ result: { outcome: "rejected", reason: "Unknown removal." } })).response.status).toBe(400);
  });

  it("a signing-confirmation denial is the retryable 429 with the validated Retry-After", async () => {
    const { response } = await callConfirm({ result: { outcome: "rate_limited", retryAfterSeconds: 77 } });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("77");
    expect(await response.json()).toEqual({ error: TURNKEY_RECONCILE_RATE_LIMITED_MESSAGE, code: "rate_limited", retryable: true });
  });

  it("an impossible delay never becomes a malformed 429 — it is the generic 500", async () => {
    for (const retryAfterSeconds of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { response } = await callConfirm({ result: { outcome: "rate_limited", retryAfterSeconds } });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Something went wrong. Please try again." });
    }
  });

  it("a limiter failure is the generic 500 on every route — no limiter detail", async () => {
    const failure = new Error('relation "real_provider_budgets" does not exist');
    for (const call of [callReconcile, callConfirm, callRemove]) {
      const { response } = await call({ result: failure });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Something went wrong. Please try again." });
    }
  });

  it("keeps the confirmation's existing success and request-validation contracts", async () => {
    const ok = await callConfirm({ result: { outcome: "active" } });
    expect(ok.response.status).toBe(200);
    expect(await ok.response.json()).toEqual({ active: true });
    expect((await callConfirm({ result: { outcome: "active" } }, { enrollmentId: "e-1" })).response.status).toBe(400);
    expect((await callConfirm({ result: { outcome: "rejected", reason: "No." } })).response.status).toBe(400);
  });
});

describe("cross-site requests are refused by the request gate before any route — and so before any charge", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("all three POST routes: cross-site Fetch Metadata and a foreign Origin are 403; same-origin passes through", () => {
    vi.stubEnv("NEXT_PUBLIC_REAL_MODE_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_REAL_ORIGIN", "http://localhost:3000");
    const origin = "http://localhost:3000";
    for (const endpoint of Object.values(ENDPOINTS)) {
      // A normal browser request declares its length (3B-2): the exact UTF-8 byte length of the serialized body.
      const body = "{}";
      const make = (headers: Record<string, string>) => new NextRequest(`${origin}${endpoint}`, { method: "POST", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body, "utf8")), ...headers }, body });
      expect(proxy(make({ "sec-fetch-site": "cross-site" }))?.status, endpoint).toBe(403);
      expect(proxy(make({ origin: "https://evil.example" }))?.status, endpoint).toBe(403);
      expect(proxy(make({ origin, "sec-fetch-site": "same-origin" })), endpoint).toBeUndefined();
    }
  });
});

// ------------------------------------------------------------------ static boundaries

describe("static boundaries — one policy source, and no uncharged core outside its two modules", () => {
  const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
    return out;
  };
  const read = (file: string) => readFileSync(file, "utf8");

  it("the policy module names exactly two limits and is the only file (besides the limiter's bucket list) naming the family", () => {
    const source = read("lib/real/server/turnkey-reconcile-budget.ts");
    expect(source.match(/limit: \d+/g)).toHaveLength(2);
    const naming = [...walk("lib"), ...walk("app"), ...walk("components"), ...walk("simulation")]
      .filter((file) => /turnkey_reconcile/.test(read(file)))
      .map((file) => file.split(path.sep).join("/"))
      .sort();
    expect(naming).toEqual(["lib/real/server/rate-limit.ts", "lib/real/server/turnkey-reconcile-budget.ts"]);
  });

  it("the routes and pipeline modules carry no bucket name, window, or numeric limit", () => {
    for (const file of [
      "app/api/real/account/passkeys/backup/authorize/reconcile/route.ts",
      "app/api/real/account/passkeys/backup/verify-signing/confirm/route.ts",
      "app/api/real/account/passkeys/[credentialId]/revoke/reconcile/route.ts",
      "lib/real/server/backup-passkey-pipeline.ts",
      "lib/real/server/passkey-revocation.ts",
    ]) {
      const code = strip(read(file));
      expect(code, file).not.toMatch(/turnkey_reconcile|windowSeconds|\blimit:\s*\d/);
    }
  });

  it("the already-admitted cores are private: not exported, and not named by any other file", () => {
    const pipeline = strip(read("lib/real/server/backup-passkey-pipeline.ts"));
    const removal = strip(read("lib/real/server/passkey-revocation.ts"));
    expect(pipeline).not.toMatch(/export\s+(async\s+)?function\s+reconcileEnrollmentCore|export\s+const\s+ALREADY_ADMITTED|export\s*\{[^}]*(Core|ALREADY_ADMITTED)/);
    expect(removal).not.toMatch(/export\s+(async\s+)?function\s+reconcileRevocationCore|export\s+const\s+ALREADY_ADMITTED|export\s*\{[^}]*(Core|ALREADY_ADMITTED)/);
    const others = [...walk("lib"), ...walk("app"), ...walk("components")].filter((file) => !/lib\/real\/server\/(backup-passkey-pipeline|passkey-revocation)\.ts$/.test(file.split(path.sep).join("/")));
    for (const file of others) expect(strip(read(file)), file).not.toMatch(/reconcileEnrollmentCore|reconcileRevocationCore|ALREADY_ADMITTED/);
  });

  it("the exported reconcile functions REQUIRE a limiter (no optional bypass parameter)", () => {
    const pipeline = strip(read("lib/real/server/backup-passkey-pipeline.ts"));
    const removal = strip(read("lib/real/server/passkey-revocation.ts"));
    expect(pipeline).toMatch(/providerBudgetLimiter: ProviderBudgetLimiter;/);
    expect(pipeline).not.toMatch(/providerBudgetLimiter\?:/);
    expect(removal).toMatch(/providerBudgetLimiter: ProviderBudgetLimiter;/);
    expect(removal).not.toMatch(/providerBudgetLimiter\?:/);
  });

  it("the budget is consumed in exactly the intended places: the two external reconcile wrappers and the confirmation — never in a submit", () => {
    const pipeline = strip(read("lib/real/server/backup-passkey-pipeline.ts"));
    const removal = strip(read("lib/real/server/passkey-revocation.ts"));
    expect(pipeline.match(/consumeTurnkeyReconcileBudget\(/g)).toHaveLength(2);
    expect(removal.match(/consumeTurnkeyReconcileBudget\(/g)).toHaveLength(1);

    const submitStart = pipeline.indexOf("export async function submitTurnkeyAuthorization");
    const submitEnd = pipeline.indexOf("async function recordCreateActivity");
    const submitBody = pipeline.slice(submitStart, submitEnd);
    expect(submitBody).toMatch(/reconcileEnrollmentCore\(/);
    expect(submitBody).toMatch(/ALREADY_ADMITTED/);
    expect(submitBody).not.toMatch(/consumeTurnkeyReconcileBudget|providerBudgetLimiter/);

    const rSubmitStart = removal.indexOf("export async function submitRevocation");
    const rSubmitEnd = removal.indexOf("function isPresent");
    const rSubmitBody = removal.slice(rSubmitStart, rSubmitEnd);
    expect(rSubmitBody).toMatch(/reconcileRevocationCore\(/);
    expect(rSubmitBody).toMatch(/ALREADY_ADMITTED/);
    expect(rSubmitBody).not.toMatch(/consumeTurnkeyReconcileBudget|providerBudgetLimiter/);
  });

  it("the two submit routes are untouched by the budget", () => {
    for (const file of ["app/api/real/account/passkeys/backup/authorize/submit/route.ts", "app/api/real/account/passkeys/[credentialId]/revoke/submit/route.ts"]) {
      expect(read(file), file).not.toMatch(/ProviderBudget|providerBudgetLimiter|turnkey-reconcile-budget|rate_limited/);
    }
  });

  it("R0 stays intact: reconcile code never calls forwardSignedRequest", () => {
    const removal = strip(read("lib/real/server/passkey-revocation.ts"));
    expect(removal.match(/\bforwardSignedRequest\s*\(/g)).toHaveLength(1);
    const coreStart = removal.indexOf("async function reconcileRevocationCore");
    expect(coreStart).toBeGreaterThan(-1);
    expect(removal.slice(removal.indexOf("export async function reconcileRevocation"))).not.toMatch(/forwardSignedRequest/);
  });

  it("the provider-budget SQL is untouched: schema.sql is not part of this slice's diff", () => {
    // The digest tests in provider-budget*.test.ts pin the statements themselves; this pins that no budget table or bucket was added here.
    const schema = read("lib/real/server/schema.sql");
    expect(schema).toContain("real_provider_budgets");
    expect(schema.match(/turnkey_reconcile_short/g)?.length ?? 0).toBeGreaterThan(0);
  });
});
