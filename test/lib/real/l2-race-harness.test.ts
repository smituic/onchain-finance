import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  bounded,
  CaseRecorder,
  DeadlineError,
  HARNESS_REQUEST,
  DIRECT_DATABASE_URL_ENV,
  observe,
  openHolder,
  Poison,
  prepareRaceSuite,
  RACE_LIMITS,
  recordingFetch,
  RecordingRouter,
  resolveDirectDatabaseUrl,
  runRaceCase,
  sessionSettingProblems,
  sessionStartupOptions,
  UnprovenTerminationError,
  waitForFinalizeBlockedBy,
  worstCaseCaseMs,
  type Batch,
  type HolderClient,
  type HolderHandle,
  type RaceHooks,
  type RaceLimits,
  type SessionSetting,
} from "./fixtures/race-harness";

/**
 * Offline proof of the S5 L2 race-smoke lifecycle (fixtures/race-harness.ts):
 * deadlines that cancel, teardown order, finalize settlement, case-owned
 * recording, holder setup cleanup, and the poison. No Neon.
 */
const FAST: RaceLimits = {
  outerTestMs: 5_000,
  caseMs: 400,
  monitorTotalMs: 120,
  monitorPollMs: 10,
  queryMs: 80,
  statementTimeoutMs: 40,
  stepMs: 80,
  cleanupMs: 120,
  rowLockTimeoutMs: 40,
  graceMs: 40,
  holderIdleInTransactionMs: 1_000,
};

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

/** A holder whose every call is logged into a shared timeline. */
function fakeHolder(log: string[], overrides: Partial<Pick<HolderHandle, "rollback" | "terminate" | "close">> = {}) {
  let open = true;
  const holder: HolderHandle = {
    pid: 4242,
    isOpen: () => open,
    commit: async () => {
      log.push("holder.commit");
      open = false;
    },
    rollback: overrides.rollback ?? (async () => {
      log.push("holder.rollback");
      open = false;
    }),
    terminate: overrides.terminate ?? (async () => {
      log.push("holder.terminate");
      open = false;
    }),
    close: overrides.close ?? (async () => void log.push("holder.close")),
  };
  return holder;
}

function hooks(log: string[], overrides: Partial<RaceHooks> = {}): RaceHooks {
  return {
    cancelBlockedBy: async (pid) => void log.push(`db.cancelBlockedBy(${pid})`),
    neutralizeAndClean: async () => void log.push("db.neutralizeAndClean"),
    onStep: (step) => log.push(`step:${step}`),
    ...overrides,
  };
}

/** A finalize stuck on the holder that settles only when its HTTP request is aborted — like the real one after teardown. */
function blockedFinalize(signal: AbortSignal) {
  return new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("finalize request aborted")), { once: true }));
}

describe("bounded(): a deadline that cancels, never abandons", () => {
  it("aborts the operation's signal at the deadline and rejects with DeadlineError only after the operation stopped", async () => {
    const poison = new Poison();
    let stopped = false;
    const started = Date.now();
    const honorsSignal = (signal: AbortSignal) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          stopped = true;
          reject(new Error("aborted"));
        });
      });
    await expect(bounded("op", 30, honorsSignal, { poison, graceMs: 50 })).rejects.toBeInstanceOf(DeadlineError);
    expect(stopped).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
    expect(poison.tripped).toBeNull();
  });

  it("an operation that ignores its signal can't be proven stopped: UnprovenTerminationError, and the poison trips", async () => {
    const poison = new Poison();
    await expect(bounded("stubborn", 20, () => new Promise(() => undefined), { poison, graceMs: 20 })).rejects.toBeInstanceOf(UnprovenTerminationError);
    expect(poison.tripped).toBeInstanceOf(UnprovenTerminationError);
  });

  it("a parent abort cancels it too", async () => {
    const parent = new AbortController();
    const done = bounded("child", 10_000, (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")))), { poison: new Poison(), graceMs: 50, parent: parent.signal });
    parent.abort(new DeadlineError("case", 1));
    await expect(done).rejects.toBeInstanceOf(DeadlineError);
  });
});

describe("runRaceCase teardown", () => {
  it("1+2+3: a monitor timeout stops the case and tears down IN ORDER — cancel, release holder, neutralize, settle finalize, close — before the case rejects", async () => {
    const log: string[] = [];
    const router = new RecordingRouter<Batch>();
    let settlement: ReturnType<typeof observe> | null = null;
    let holder: HolderHandle | null = null;
    const result = runRaceCase({
      limits: FAST,
      poison: new Poison(),
      router,
      hooks: hooks(log),
      run: async (ctx) => {
        holder = fakeHolder(log);
        ctx.setHolder(holder);
        settlement = ctx.startFinalize(() => blockedFinalize(ctx.recorder.requestSignal));
        await waitForFinalizeBlockedBy({ holderPid: holder.pid, finalize: settlement, query: async () => [], step: ctx.step, limits: FAST, signal: ctx.signal });
      },
    });
    await expect(result).rejects.toBeInstanceOf(DeadlineError);
    expect(log).toEqual([
      "step:cancel finalize",
      "db.cancelBlockedBy(4242)",
      "step:rollback holder",
      "holder.rollback",
      "step:neutralize and clean",
      "db.neutralizeAndClean",
      "step:settle finalize",
      "step:close holder",
      "holder.close",
      "step:drain run",
    ]);
    expect(holder!.isOpen()).toBe(false); // 2: released
    expect(settlement!.isSettled()).toBe(true); // 3: finalize settled before the case returned
    expect(router.claim()).toBeNull(); // recording ended
  });

  it("3: a finalize that won't settle even after its request is aborted can't be proven stopped — the case fails loudly and the poison trips", async () => {
    const poison = new Poison();
    const result = runRaceCase({
      limits: FAST,
      poison,
      router: new RecordingRouter(),
      hooks: hooks([]),
      run: async (ctx) => {
        ctx.setHolder(fakeHolder([]));
        ctx.startFinalize(() => new Promise(() => undefined));
        throw new Error("assertion failed midway");
      },
    });
    await expect(result).rejects.toThrow(AggregateError);
    await result.catch((error: AggregateError) => {
      expect(error.errors.map((e: Error) => e.message)).toEqual(expect.arrayContaining(["assertion failed midway", expect.stringContaining("finalize request")]));
    });
    expect(poison.tripped).toBeInstanceOf(UnprovenTerminationError);
  });

  it("an ordinary assertion failure still runs the full teardown and rethrows the ORIGINAL error", async () => {
    const log: string[] = [];
    const failure = new Error("expected 2 batches");
    await expect(
      runRaceCase({
        limits: FAST,
        poison: new Poison(),
        router: new RecordingRouter(),
        hooks: hooks(log),
        run: async (ctx) => {
          ctx.setHolder(fakeHolder(log));
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(log).toContain("holder.rollback");
    expect(log).toContain("db.neutralizeAndClean");
    expect(log).toContain("holder.close");
  });

  it("ROLLBACK that fails falls back to terminating the session; if both fail, the poison trips", async () => {
    const log: string[] = [];
    const poison = new Poison();
    const failing = fakeHolder(log, {
      rollback: async () => {
        throw new Error("socket gone");
      },
      terminate: async () => {
        throw new Error("terminate failed");
      },
    });
    await expect(runRaceCase({ limits: FAST, poison, router: new RecordingRouter(), hooks: hooks(log), run: async (ctx) => ctx.setHolder(failing) })).rejects.toBeInstanceOf(AggregateError);
    expect(log).toEqual(expect.arrayContaining(["step:rollback holder", "step:terminate holder"]));
    expect(poison.tripped?.message).toMatch(/holder transaction/);
  });

  it("7: a cleanup failure is surfaced (the passing case FAILS) and trips the poison — never silently ignored", async () => {
    const poison = new Poison();
    const cleanupError = new Error("DELETE failed");
    await expect(
      runRaceCase({ limits: FAST, poison, router: new RecordingRouter(), hooks: hooks([], { neutralizeAndClean: async () => Promise.reject(cleanupError) }), run: async () => undefined }),
    ).rejects.toBe(cleanupError);
    expect(poison.tripped?.message).toMatch(/neutralize and clean/);
  });

  it("a poisoned suite refuses every later case before it touches anything", async () => {
    const poison = new Poison();
    poison.trip(new Error("earlier case"));
    const run = vi.fn();
    const router = new RecordingRouter<Batch>();
    await expect(runRaceCase({ limits: FAST, poison, router, hooks: hooks([]), run })).rejects.toThrow(/refusing to touch the shared database/);
    expect(run).not.toHaveBeenCalled();
    expect(router.claim()).toBeNull();
  });

  it("a successful case (holder committed, finalize settled) only neutralizes, closes, and drains", async () => {
    const log: string[] = [];
    await runRaceCase({
      limits: FAST,
      poison: new Poison(),
      router: new RecordingRouter(),
      hooks: hooks(log),
      run: async (ctx) => {
        const holder = fakeHolder(log);
        ctx.setHolder(holder);
        const settlement = ctx.startFinalize(async () => null);
        await holder.commit(ctx.signal);
        expect(await ctx.awaitFinalize(settlement)).toBeNull();
      },
    });
    expect(log).toEqual(["holder.commit", "step:neutralize and clean", "db.neutralizeAndClean", "step:close holder", "holder.close", "step:drain run"]);
  });
});

describe("waitForFinalizeBlockedBy", () => {
  it("6: a finalize rejection while monitoring is observed IMMEDIATELY (not after the poll interval), carrying its error", async () => {
    const finalizeFailure = new Error("23505 surfaced early");
    const settlement = observe(new Promise((_, reject) => setTimeout(() => reject(finalizeFailure), 20)));
    const started = Date.now();
    const wait = waitForFinalizeBlockedBy({
      holderPid: 1,
      finalize: settlement,
      query: async () => [],
      step: (label, operation) => bounded(label, 100, operation, { poison: new Poison(), graceMs: 50 }),
      limits: { monitorTotalMs: 5_000, monitorPollMs: 2_000 },
      signal: new AbortController().signal,
    });
    await expect(wait).rejects.toThrow(/finalize settled before blocking on the holder \(rejected: Error: 23505 surfaced early\)/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("every monitor query is bounded: a stalled query is cancelled and the wait rejects within its budget", async () => {
    const poison = new Poison();
    let cancelled = false;
    const wait = waitForFinalizeBlockedBy({
      holderPid: 1,
      finalize: observe(new Promise(() => undefined)),
      query: (_pid, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => ((cancelled = true), reject(new Error("aborted"))))),
      step: (label, operation) => bounded(label, 30, operation, { poison, graceMs: 30 }),
      limits: { monitorTotalMs: 10_000, monitorPollMs: 10 },
      signal: new AbortController().signal,
    });
    await expect(wait).rejects.toBeInstanceOf(DeadlineError);
    expect(cancelled).toBe(true);
    expect(poison.tripped).toBeNull();
  });

  it("succeeds only on the exact proof condition: one backend, running finalize's claim, blocked by the holder", async () => {
    const responses = [[], [{ pid: 9, query: "SELECT 1" }], [{ pid: 7, query: "WITH claimed AS (UPDATE ...)" }]];
    const waiter = await waitForFinalizeBlockedBy({
      holderPid: 1,
      finalize: observe(new Promise(() => undefined)),
      query: async () => responses.shift() ?? [],
      step: (label, operation) => bounded(label, 100, operation, { poison: new Poison(), graceMs: 50 }),
      limits: { monitorTotalMs: 5_000, monitorPollMs: 1 },
      signal: new AbortController().signal,
    });
    expect(waiter).toEqual({ pid: 7, query: "WITH claimed AS (UPDATE ...)" });
  });
});

describe("4: case-owned recording", () => {
  const batchBody = JSON.stringify({ queries: [{ query: "SELECT 1", params: [] }] });

  it("a delayed response from case A can never land in case B's recorder", async () => {
    const router = new RecordingRouter<Batch>();
    const gate = deferred<Response>();
    const fetchImpl = recordingFetch(() => gate.promise, router);
    const a = router.begin();
    const inFlight = fetchImpl("https://neon/sql", { method: "POST", body: batchBody });
    router.end(a);
    const b = router.begin();
    gate.resolve(Response.json({ ok: true }));
    await inFlight;
    expect(b.items).toEqual([]);
    expect(a.items).toEqual([]); // A was closed before its late response arrived
    router.end(b);
  });

  it("only one case can record at a time", () => {
    const router = new RecordingRouter<Batch>();
    router.begin();
    expect(() => router.begin()).toThrow(/already recording/);
  });

  it("the case's requests carry its abort signal; harness-marked requests are neither recorded nor tied to it", async () => {
    const router = new RecordingRouter<Batch>();
    const seen: Array<RequestInit | undefined> = [];
    const fetchImpl = recordingFetch(async (_input, init) => (seen.push(init), Response.json({})), router);
    const recorder = router.begin();
    await fetchImpl("https://neon/sql", { method: "POST", body: batchBody });
    await fetchImpl("https://neon/sql", { method: "POST", body: batchBody, [HARNESS_REQUEST]: true } as RequestInit);
    expect(recorder.items).toHaveLength(1);
    expect(seen[0]?.signal?.aborted).toBe(false);
    expect(seen[1]?.signal).toBeUndefined();
    expect(seen[1] && HARNESS_REQUEST in seen[1]).toBe(false); // the marker never reaches fetch
    recorder.abortRequests();
    expect(seen[0]?.signal?.aborted).toBe(true);
  });

  it("a closed recorder ignores pushes", () => {
    const recorder = new CaseRecorder<number>();
    recorder.push(1);
    recorder.close();
    recorder.push(2);
    expect(recorder.items).toEqual([1]);
  });
});

describe("5: holder setup failure leaves nothing open", () => {
  function fakeClient(log: string[], failOn: string): HolderClient {
    return {
      connect: async () => {
        log.push("connect");
        if (failOn === "connect") throw new Error("connect failed");
      },
      query: async (text) => {
        log.push(text.split(" ")[0]!);
        if (text.startsWith(failOn)) throw new Error(`${failOn} failed`);
        return { rows: [{ pid: 77 }] };
      },
      end: async () => void log.push("end"),
    };
  }
  const step = <T,>(label: string, operation: (signal: AbortSignal) => Promise<T>) => bounded(label, 100, operation, { poison: new Poison(), graceMs: 50 });

  it("a failing INSERT rolls W back and closes the client before the error propagates", async () => {
    const log: string[] = [];
    await expect(openHolder({ client: fakeClient(log, "INSERT"), statements: [{ text: "INSERT INTO real_accounts" }], step, cleanupStep: step, terminate: async () => undefined })).rejects.toThrow("INSERT failed");
    expect(log).toEqual(["connect", "BEGIN", "SELECT", "INSERT", "ROLLBACK", "end"]);
  });

  it("a failed connect closes the client (nothing to roll back)", async () => {
    const log: string[] = [];
    await expect(openHolder({ client: fakeClient(log, "connect"), statements: [], step, cleanupStep: step, terminate: async () => undefined })).rejects.toThrow("connect failed");
    expect(log).toEqual(["connect", "end"]);
  });

  it("a cleanup that also fails is reported alongside the setup error, not swallowed", async () => {
    const client: HolderClient = { connect: async () => undefined, query: async (text) => (text === "BEGIN" ? { rows: [] } : Promise.reject(new Error(`${text} failed`))), end: async () => Promise.reject(new Error("end failed")) };
    await expect(openHolder({ client, statements: [], step, cleanupStep: step, terminate: async () => undefined })).rejects.toBeInstanceOf(AggregateError);
  });
});

describe("8: internal deadlines always beat the outer Vitest timeout", () => {
  it("the worst-case case (every deadline hit, every grace used) finishes before outerTestMs", () => {
    expect(worstCaseCaseMs(RACE_LIMITS)).toBeLessThan(RACE_LIMITS.outerTestMs);
    expect(RACE_LIMITS.monitorTotalMs).toBeLessThan(RACE_LIMITS.caseMs);
    expect(RACE_LIMITS.statementTimeoutMs).toBeLessThan(RACE_LIMITS.queryMs);
    expect(RACE_LIMITS.rowLockTimeoutMs).toBeLessThan(RACE_LIMITS.cleanupMs);
    // The server-side holder backstop must never fire during a live case, only after the process is gone.
    expect(RACE_LIMITS.holderIdleInTransactionMs).toBeGreaterThan(RACE_LIMITS.caseMs);
  });

  it("the gated race smoke uses exactly these limits for its Vitest timeout, and runs every case through runRaceCase", () => {
    const smoke = readFileSync("test/lib/real/l2-identity-race.smoke.test.ts", "utf8");
    expect(smoke).toContain("const LIVE_TIMEOUT_MS = RACE_LIMITS.outerTestMs;");
    expect(smoke.match(/runRaceCase\(/g)?.length).toBeGreaterThanOrEqual(1);
    expect(smoke).not.toMatch(/let recording\b/); // no suite-shared mutable recording
  });
});

// ================================================================== M3: the direct (non-pooled) endpoint

const USER = "alice_app_owner";
const PASSWORD = "s3cr3t-Pa55w0rd";
const DIRECT_HOST = "ep-cool-name-123456.us-east-2.aws.neon.tech";
const POOLED_HOST = "ep-cool-name-123456-pooler.us-east-2.aws.neon.tech";
const urlFor = (host: string, user = USER, password = PASSWORD, tail = "/neondb?sslmode=require") => `postgres://${user}:${password}@${host}${tail}`;
const direct = (value: string | undefined) => resolveDirectDatabaseUrl({ [DIRECT_DATABASE_URL_ENV]: value });

describe("M3: the race suite requires its own DIRECT database URL", () => {
  it("the variable is REAL_SMOKE_L2_DIRECT_DATABASE_URL", () => {
    expect(DIRECT_DATABASE_URL_ENV).toBe("REAL_SMOKE_L2_DIRECT_DATABASE_URL");
  });

  it("1: a missing (or blank) direct URL is refused", () => {
    for (const value of [undefined, "", "   "]) {
      const check = direct(value);
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.reason).toMatch(/REAL_SMOKE_L2_DIRECT_DATABASE_URL is not set/);
    }
  });

  it.each([
    ["free text", "not a url"],
    ["a bare hostname", DIRECT_HOST],
    ["credentials but no host", `postgres://${USER}:${PASSWORD}@/neondb`],
    ["no host at all", "postgres:///neondb"],
    ["a non-postgres scheme", `https://${DIRECT_HOST}/neondb`],
    ["a hostname with an empty label", `postgres://${USER}:${PASSWORD}@ep-x..aws.neon.tech/neondb`],
  ])("2: a malformed direct URL (%s) is refused", (_label, value) => {
    expect(direct(value).ok).toBe(false);
  });

  it.each([
    ["the Neon pooled endpoint", urlFor(POOLED_HOST)],
    ["postgresql:// scheme", urlFor(POOLED_HOST).replace("postgres://", "postgresql://")],
    ["an explicit port", urlFor(`${POOLED_HOST}:5432`)],
    // Node does not lowercase the hostname of a postgres:// URL; the check must.
    ["an UPPER-CASE hostname", urlFor(POOLED_HOST.toUpperCase())],
    ["no credentials", `postgres://${POOLED_HOST}/neondb`],
  ])("3: a \"-pooler\" Neon hostname is refused (%s)", (_label, value) => {
    const check = direct(value);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/POOLED Neon endpoint/);
  });

  it.each([
    ["postgres://", urlFor(DIRECT_HOST)],
    ["postgresql://", urlFor(DIRECT_HOST).replace("postgres://", "postgresql://")],
    ["an explicit port", urlFor(`${DIRECT_HOST}:5432`)],
    ["surrounding whitespace", `  ${urlFor(DIRECT_HOST)}\n`],
  ])("4: a valid direct Neon hostname is accepted (%s), returning the URL untouched and its hostname", (_label, value) => {
    expect(direct(value)).toEqual({ ok: true, url: value.trim(), hostname: DIRECT_HOST });
  });

  it("5: DATABASE_URL alone never satisfies the suite — direct-looking or pooled, it is simply not read", () => {
    for (const DATABASE_URL of [urlFor(DIRECT_HOST), urlFor(POOLED_HOST)]) {
      const check = resolveDirectDatabaseUrl({ DATABASE_URL });
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.reason).toMatch(/never falls back to DATABASE_URL/);
    }
    // And a pooled DATABASE_URL beside a valid direct URL changes nothing: only the dedicated variable is used.
    expect(resolveDirectDatabaseUrl({ DATABASE_URL: urlFor(POOLED_HOST), [DIRECT_DATABASE_URL_ENV]: urlFor(DIRECT_HOST) })).toMatchObject({ ok: true, hostname: DIRECT_HOST });
  });

  it("6: only the parsed HOSTNAME decides — \"-pooler\" in the user, password, database, or query never does", () => {
    const decoys = [
      urlFor(DIRECT_HOST, "svc-pooler", PASSWORD),
      urlFor(DIRECT_HOST, USER, "pw-pooler"),
      urlFor(DIRECT_HOST, USER, "p@ss-pooler"), // an unencoded "@" in the password
      urlFor(DIRECT_HOST, USER, PASSWORD, "/db-pooler"),
      urlFor(DIRECT_HOST, USER, PASSWORD, "/neondb?options=project%3Dx-pooler"),
      urlFor(DIRECT_HOST, `ep-fake-1-pooler.aws.neon.tech`, PASSWORD), // a pooled-LOOKING username
    ];
    for (const value of decoys) expect(direct(value), value.replace(PASSWORD, "…")).toMatchObject({ ok: true, hostname: DIRECT_HOST });
    // ...and innocent-looking credentials can't hide a pooled host.
    expect(direct(urlFor(POOLED_HOST, "direct", "direct")).ok).toBe(false);
  });

  it("7: a refusal never exposes the URL, the user, or the password — at most the hostname", () => {
    const refusals = [
      urlFor(POOLED_HOST),
      urlFor(POOLED_HOST.toUpperCase()),
      `postgres://${USER}:${PASSWORD}@/neondb`,
      `https://${USER}:${PASSWORD}@${DIRECT_HOST}/neondb`,
      `postgres://${USER}:${PASSWORD}@ep-x..aws.neon.tech/neondb`,
      `${USER}:${PASSWORD} is not a url`,
    ];
    for (const value of refusals) {
      const check = direct(value);
      expect(check.ok).toBe(false);
      if (check.ok) continue;
      expect(check.reason).not.toContain(PASSWORD);
      expect(check.reason).not.toContain(USER);
      expect(check.reason).not.toContain("@"); // no userinfo of any kind
      expect(check.reason).not.toContain("neondb"); // nor the path/query
      expect(check.reason).not.toContain("sslmode");
      expect(check.reason).not.toContain(value);
    }
    const pooled = direct(urlFor(POOLED_HOST));
    if (!pooled.ok) expect(pooled.reason).toContain(POOLED_HOST); // the one thing it may name
  });
});

describe("M3: session settings must be proven applied, from pg_settings", () => {
  const applicationName = "l2race_abcd1234_preflight";
  const msSettings = { statement_timeout: 2_000, lock_timeout: 2_000, idle_in_transaction_session_timeout: 40_000 };
  const applied: SessionSetting[] = [
    { name: "application_name", setting: applicationName, unit: null },
    { name: "statement_timeout", setting: "2000", unit: "ms" },
    { name: "lock_timeout", setting: "2000", unit: "ms" },
    { name: "idle_in_transaction_session_timeout", setting: "40000", unit: "ms" },
  ];
  const withRow = (name: string, patch: Partial<SessionSetting> | null) => applied.flatMap((row) => (row.name !== name ? [row] : patch ? [{ ...row, ...patch }] : []));

  it("accepts exactly the intended values", () => {
    expect(sessionSettingProblems(applied, { applicationName, msSettings })).toEqual([]);
  });

  it.each<[string, SessionSetting[], RegExp]>([
    ["application_name not applied (a pooler's own name)", withRow("application_name", { setting: "pgbouncer" }), /application_name was not applied/],
    ["application_name missing", withRow("application_name", null), /application_name was not applied/],
    ["idle_in_transaction_session_timeout left at 0 (disabled)", withRow("idle_in_transaction_session_timeout", { setting: "0" }), /idle_in_transaction_session_timeout is 0 ms, expected 40000 ms/],
    ["statement_timeout left at 0", withRow("statement_timeout", { setting: "0" }), /statement_timeout is 0 ms/],
    ["lock_timeout a different value", withRow("lock_timeout", { setting: "5000" }), /lock_timeout is 5000 ms, expected 2000 ms/],
    ["a timeout row missing", withRow("lock_timeout", null), /lock_timeout is missing/],
    ["a timeout reported in another unit (never guessed)", withRow("statement_timeout", { setting: "2", unit: "s" }), /statement_timeout has unexpected unit s/],
  ])("refuses: %s", (_label, rows, problem) => {
    expect(sessionSettingProblems(rows, { applicationName, msSettings }).join("; ")).toMatch(problem);
  });

  it("an intended bound of 0 is never accepted as 'applied'", () => {
    expect(sessionSettingProblems(withRow("lock_timeout", { setting: "0" }), { applicationName, msSettings: { ...msSettings, lock_timeout: 0 } }).join("; ")).toMatch(/lock_timeout is 0 ms/);
  });

  it("refuses what Neon's proxy left behind when the timeouts were sent as separate startup parameters (seen live)", () => {
    const dropped = applied.map((row) => (row.name === "application_name" ? row : { ...row, setting: row.name === "idle_in_transaction_session_timeout" ? "300000" : "0" }));
    expect(sessionSettingProblems(dropped, { applicationName, msSettings })).toEqual([
      "statement_timeout is 0 ms, expected 2000 ms",
      "lock_timeout is 0 ms, expected 2000 ms",
      "idle_in_transaction_session_timeout is 300000 ms, expected 40000 ms",
    ]);
  });
});

describe("session timeouts travel as startup `options` (the channel Neon's proxy forwards)", () => {
  /** "-c name=ms -c name=ms" -> { name: ms }; throws on any other shape. */
  const parse = (options: string) => {
    const tokens = options.split(" ");
    expect(tokens.length % 2).toBe(0);
    return Object.fromEntries(
      Array.from({ length: tokens.length / 2 }, (_, i) => {
        expect(tokens[i * 2]).toBe("-c");
        const [, name, ms] = /^([a-z_]+)=([1-9][0-9]*)$/.exec(tokens[i * 2 + 1]!)!;
        return [name!, Number(ms)];
      }),
    );
  };

  it("probe/sentinel shape: all three timeouts, from RACE_LIMITS", () => {
    const options = sessionStartupOptions(RACE_LIMITS, { lock_timeout: RACE_LIMITS.rowLockTimeoutMs });
    expect(options).toBe("-c statement_timeout=2000 -c idle_in_transaction_session_timeout=40000 -c lock_timeout=2000");
    expect(parse(options)).toEqual({ statement_timeout: RACE_LIMITS.statementTimeoutMs, idle_in_transaction_session_timeout: RACE_LIMITS.holderIdleInTransactionMs, lock_timeout: RACE_LIMITS.rowLockTimeoutMs });
  });

  it("holder shape: no lock_timeout unless the caller asks for one", () => {
    for (const options of [sessionStartupOptions(RACE_LIMITS), sessionStartupOptions(RACE_LIMITS, {}), sessionStartupOptions(RACE_LIMITS, { lock_timeout: undefined })]) {
      expect(options).toBe("-c statement_timeout=2000 -c idle_in_transaction_session_timeout=40000");
      expect(options).not.toContain("lock_timeout");
    }
  });

  it("every value comes from its own input, none is hard-coded or swapped", () => {
    expect(sessionStartupOptions({ statementTimeoutMs: 1_234, holderIdleInTransactionMs: 56_789 }, { lock_timeout: 777 })).toBe("-c statement_timeout=1234 -c idle_in_transaction_session_timeout=56789 -c lock_timeout=777");
    expect(sessionStartupOptions({ statementTimeoutMs: 1, holderIdleInTransactionMs: 2 })).toBe("-c statement_timeout=1 -c idle_in_transaction_session_timeout=2");
  });

  const good = { statementTimeoutMs: 2_000, holderIdleInTransactionMs: 40_000 };
  it.each([0, -1, -2_000, 1.5, 0.1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e21])("rejects %s for every timeout — nothing is rounded, clamped, or silently dropped", (bad) => {
    expect(() => sessionStartupOptions({ ...good, statementTimeoutMs: bad })).toThrow(/statement_timeout must be a positive whole number of ms/);
    expect(() => sessionStartupOptions({ ...good, holderIdleInTransactionMs: bad })).toThrow(/idle_in_transaction_session_timeout must be a positive whole number of ms/);
    expect(() => sessionStartupOptions(good, { lock_timeout: bad })).toThrow(/lock_timeout must be a positive whole number of ms/);
  });

  it("the preflight session sends exactly what the guard then requires the server to report", () => {
    const sent = parse(sessionStartupOptions(RACE_LIMITS, { lock_timeout: RACE_LIMITS.rowLockTimeoutMs }));
    // The guard's own expectation, as the race smoke spells it out (independently of the helper).
    const msSettings = { statement_timeout: RACE_LIMITS.statementTimeoutMs, lock_timeout: RACE_LIMITS.rowLockTimeoutMs, idle_in_transaction_session_timeout: RACE_LIMITS.holderIdleInTransactionMs };
    expect(sent).toEqual(msSettings);
    const applicationName = "l2race_abcd1234_preflight";
    const reported: SessionSetting[] = [{ name: "application_name", setting: applicationName, unit: null }, ...Object.entries(sent).map(([name, ms]) => ({ name, setting: String(ms), unit: "ms" }))];
    expect(sessionSettingProblems(reported, { applicationName, msSettings })).toEqual([]);
    // A holder-shaped session (no lock_timeout sent) would NOT satisfy the preflight's expectation.
    const holder = parse(sessionStartupOptions(RACE_LIMITS));
    const holderReported: SessionSetting[] = [{ name: "application_name", setting: applicationName, unit: null }, ...Object.entries({ lock_timeout: 0, ...holder }).map(([name, ms]) => ({ name, setting: String(ms), unit: "ms" }))];
    expect(sessionSettingProblems(holderReported, { applicationName, msSettings })).toEqual(["lock_timeout is 0 ms, expected 2000 ms"]);
  });
});

describe("M3: prepareRaceSuite refuses BEFORE anything is patched or written", () => {
  const applicationName = "l2race_abcd1234_preflight";
  const msSettings = { statement_timeout: 2_000, lock_timeout: 2_000, idle_in_transaction_session_timeout: 40_000 };
  const applied: SessionSetting[] = [
    { name: "application_name", setting: applicationName, unit: null },
    { name: "statement_timeout", setting: "2000", unit: "ms" },
    { name: "lock_timeout", setting: "2000", unit: "ms" },
    { name: "idle_in_transaction_session_timeout", setting: "40000", unit: "ms" },
  ];
  function prepare(env: Record<string, string | undefined>, rows: SessionSetting[] = applied) {
    const log: string[] = [];
    const result = prepareRaceSuite({
      env,
      applicationName,
      msSettings,
      readSessionSettings: async (url) => (log.push(`probe:${new URL(url).hostname}`), rows),
      activate: (url) => void log.push(`activate:${new URL(url).hostname}`),
    });
    return { log, result };
  }

  it.each([
    ["missing", {}],
    ["only DATABASE_URL set", { DATABASE_URL: urlFor(DIRECT_HOST) }],
    ["malformed", { [DIRECT_DATABASE_URL_ENV]: "not a url" }],
    ["pooled", { [DIRECT_DATABASE_URL_ENV]: urlFor(POOLED_HOST) }],
  ])("a %s direct URL: no session is even opened, and the suite is never activated", async (_label, env) => {
    const { log, result } = prepare(env);
    await expect(result).rejects.toThrow(/refused before any database work/);
    expect(log).toEqual([]);
    await result.catch((error: Error) => {
      expect(error.message).not.toContain(PASSWORD);
      expect(error.message).not.toContain(USER);
    });
  });

  it("settings the server did not apply: the read-only probe ran, but the suite is never activated", async () => {
    const { log, result } = prepare({ [DIRECT_DATABASE_URL_ENV]: urlFor(DIRECT_HOST) }, applied.map((row) => (row.name === "idle_in_transaction_session_timeout" ? { ...row, setting: "0" } : row)));
    await expect(result).rejects.toThrow(/refused before any write: the ep-cool-name-123456\.us-east-2\.aws\.neon\.tech session did not apply its settings \(idle_in_transaction_session_timeout is 0 ms/);
    expect(log).toEqual([`probe:${DIRECT_HOST}`]);
    await result.catch((error: Error) => expect(error.message).not.toContain(PASSWORD));
  });

  it("a probe that fails (e.g. the endpoint rejects the startup settings) also leaves the suite unactivated", async () => {
    const log: string[] = [];
    const result = prepareRaceSuite({
      env: { [DIRECT_DATABASE_URL_ENV]: urlFor(DIRECT_HOST) },
      applicationName,
      msSettings,
      readSessionSettings: async () => Promise.reject(new Error("unsupported startup parameter")),
      activate: () => void log.push("activate"),
    });
    await expect(result).rejects.toThrow("unsupported startup parameter");
    expect(log).toEqual([]);
  });

  it("a valid direct URL whose session applied everything: probe first, THEN activate — with that exact URL", async () => {
    const { log, result } = prepare({ DATABASE_URL: urlFor(POOLED_HOST), [DIRECT_DATABASE_URL_ENV]: urlFor(DIRECT_HOST) });
    await result;
    expect(log).toEqual([`probe:${DIRECT_HOST}`, `activate:${DIRECT_HOST}`]);
  });
});

describe("8: the race smoke reads ONLY the dedicated direct variable for its database clients", () => {
  const smoke = readFileSync("test/lib/real/l2-identity-race.smoke.test.ts", "utf8");
  const code = smoke
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

  it("never reads DATABASE_URL, and its gate does not depend on it", () => {
    expect(code).not.toMatch(/DATABASE_URL(?!_ENV)/);
    expect(code).not.toMatch(/process\.env\.(?!REAL_SMOKE_L2_INDEXES\b)\w+/);
    expect(code).toContain('const enabled = process.env.REAL_SMOKE_L2_INDEXES === "1";');
  });

  it("gets its URL only through prepareRaceSuite(process.env), and activation is the only place that sets it or patches fetch", () => {
    expect(code).toContain("await prepareRaceSuite({");
    expect(code).toContain("env: process.env,");
    expect(code.match(/directUrl = /g)).toHaveLength(1);
    expect(code.match(/globalThis\.fetch = recordingFetch\(/g)).toHaveLength(1);
    const activate = code.slice(code.indexOf("activate: (url) => {"));
    expect(activate.indexOf("directUrl = url;")).toBeGreaterThan(-1);
    expect(activate.indexOf("directUrl = url;")).toBeLessThan(activate.indexOf("globalThis.fetch = recordingFetch("));
  });

  it("every client — production stores, harness HTTP, and WebSocket sessions — connects with the validated URL", () => {
    // Every Neon HTTP client/store construction in the file is given the validated URL — no exceptions.
    const constructions = code.match(/createNeon(?:SqlClient|DurableStores)\(/g) ?? [];
    const withValidatedUrl = code.match(/createNeon(?:SqlClient|DurableStores)\(databaseUrl\(\)\)/g) ?? [];
    expect(constructions.length).toBeGreaterThanOrEqual(3);
    expect(withValidatedUrl).toHaveLength(constructions.length);
    // One WebSocket constructor, fed only by wsClient's connectionString (default: the validated URL).
    expect(code.match(/new Client\(\{/g)).toHaveLength(1);
    expect(code).toMatch(/new Client\(\{\s*connectionString,/);
    expect(code).toContain("connectionString: string = databaseUrl()");
    // databaseUrl() itself refuses until activation.
    expect(code).toMatch(/const databaseUrl = \(\) => \{\s*if \(!directUrl\) throw new Error\(/);
    // Holder, sentinel, and preflight sessions; the only explicit connection string is the preflight's just-validated `url`.
    const sessions = code.match(/await wsClient\(.*\)/g) ?? [];
    expect(sessions).toHaveLength(3);
    expect(sessions.filter((call) => /\}, \w+\)/.test(call))).toEqual(["await wsClient(applicationName, { lock_timeout: RACE_LIMITS.rowLockTimeoutMs }, url)"]);
  });

  it("afterAll does nothing when the suite was refused (nothing was patched or written)", () => {
    expect(code).toMatch(/afterAll\(async \(\) => \{\s*if \(!directUrl\) return;/);
  });

  it("WebSocket sessions get their timeouts ONLY through startup options — no dropped startup fields, no SET", () => {
    const client = /new Client\(\{([^}]*)\}\)/.exec(code)![1]!;
    const fields = client.split("\n").map((line) => line.trim()).filter(Boolean);
    expect(fields).toEqual([
      "connectionString,",
      "application_name: applicationName,",
      "connectionTimeoutMillis: RACE_LIMITS.stepMs,",
      "query_timeout: RACE_LIMITS.stepMs,",
      "options: sessionStartupOptions(RACE_LIMITS, extra),",
    ]);
    // Session-level SET never reaches a WebSocket client; the only SET in the file is the HTTP transactions' SET LOCAL.
    expect(code).not.toMatch(/client\.query\(\s*["'`]\s*SET\b/i);
    expect(code.match(/\bSET (?!state\b)\w+/g)).toEqual(["SET LOCAL"]);
  });

  it("the preflight still proves all three timeouts from pg_settings before the suite is activated", () => {
    expect(code).toContain("msSettings: { statement_timeout: RACE_LIMITS.statementTimeoutMs, lock_timeout: RACE_LIMITS.rowLockTimeoutMs, idle_in_transaction_session_timeout: RACE_LIMITS.holderIdleInTransactionMs },");
    expect(code).toContain("FROM pg_catalog.pg_settings WHERE name IN ('application_name', 'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout')");
    const preflight = code.slice(code.indexOf("await prepareRaceSuite({"), code.indexOf("activate: (url) => {"));
    expect(preflight).toContain("await wsClient(applicationName, { lock_timeout: RACE_LIMITS.rowLockTimeoutMs }, url)");
  });
});
