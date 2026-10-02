/**
 * Lifecycle for the gated S5 L2 race smoke (l2-identity-race.smoke.test.ts),
 * kept free of Neon so every guarantee below is tested offline
 * (l2-race-harness.test.ts).
 *
 * Vitest's per-test timeout is NOT cancellation: when it fires, the test's
 * async function keeps running. So a race case never relies on it. Every
 * operation the case owns has an INTERNAL deadline that actually stops the
 * I/O (an AbortSignal on HTTP, client/server timeouts on the WebSocket
 * holder, server-side cancellation of the blocked finalize backend), and the
 * case returns — pass or fail — only after its database work has been
 * observed finished or terminated. When termination cannot be proven, the
 * shared Poison trips and every later case refuses to touch the database.
 */

/** All harness budgets, in ms. `outerTestMs` is the Vitest timeout — a last-resort guard that normal teardown always beats. */
export const RACE_LIMITS = {
  outerTestMs: 60_000,
  /** The whole `run` of a case (seed, holder, finalize, monitor, assertions). */
  caseMs: 20_000,
  /** Waiting for Postgres to report finalize blocked on the holder. */
  monitorTotalMs: 10_000,
  monitorPollMs: 100,
  /** Each harness HTTP request (client-side abort)… */
  queryMs: 3_000,
  /** …which also carries a server-side SET LOCAL statement_timeout. */
  statementTimeoutMs: 2_000,
  /** Each teardown step, and each WebSocket holder operation. */
  stepMs: 3_000,
  /** The neutralize-and-clean step (its own sentinel connection, row lock, deletes, commit). */
  cleanupMs: 6_000,
  /** Server-side lock_timeout while that step waits for the attempt row (any finalize still in its transaction holds it). */
  rowLockTimeoutMs: 2_000,
  /** After an abort: how long an operation gets to PROVE it stopped before the poison trips. */
  graceMs: 1_000,
  /** Server-side backstop (holder session idle_in_transaction_session_timeout): aborts the holder even if this process dies. Above caseMs, so a live case never trips it. */
  holderIdleInTransactionMs: 40_000,
} as const;
export type RaceLimits = { [K in keyof typeof RACE_LIMITS]: number };

/** Teardown steps on the ordinary budget: cancel finalize, rollback holder, terminate holder, settle finalize, close holder, drain run. (Neutralize-and-clean has its own, cleanupMs.) */
export const TEARDOWN_STEPS = 6;

/** The longest a case can take with every deadline hit and every step using its full grace. Must stay below outerTestMs. */
export function worstCaseCaseMs(limits: RaceLimits = RACE_LIMITS): number {
  return limits.caseMs + limits.graceMs + TEARDOWN_STEPS * (limits.stepMs + limits.graceMs) + limits.cleanupMs + limits.graceMs;
}

export class DeadlineError extends Error {
  constructor(readonly label: string, ms: number) {
    super(`${label} exceeded its ${ms} ms deadline`);
    this.name = "DeadlineError";
  }
}

/** An operation that was told to stop and did not settle: we cannot prove its database work ended. */
export class UnprovenTerminationError extends Error {
  constructor(readonly label: string) {
    super(`${label} did not settle after being cancelled; its database work cannot be proven stopped`);
    this.name = "UnprovenTerminationError";
  }
}

/** Shared across a suite: once tripped, every later case refuses to run against the shared database. */
export class Poison {
  private reason: Error | null = null;
  trip(reason: Error): void {
    this.reason ??= reason;
  }
  get tripped(): Error | null {
    return this.reason;
  }
  assertHealthy(): void {
    if (this.reason) throw new Error(`refusing to touch the shared database: an earlier race case could not prove its work stopped (${this.reason.message})`);
  }
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
export type Settlement<T> = {
  promise: Promise<T>;
  /** Resolves (never rejects) when `promise` settles. */
  settled: Promise<void>;
  isSettled(): boolean;
  outcome(): Outcome<T> | undefined;
};

/** Observes a promise IMMEDIATELY, so its rejection can never go unhandled while the caller awaits something else. */
export function observe<T>(promise: Promise<T>): Settlement<T> {
  let outcome: Outcome<T> | undefined;
  const settled = promise.then(
    (value) => void (outcome = { ok: true, value }),
    (error: unknown) => void (outcome = { ok: false, error }),
  );
  return { promise, settled, isSettled: () => outcome !== undefined, outcome: () => outcome };
}

/** Starts `operation` NOW (so it can register on its signal before anything aborts it); a synchronous throw becomes a rejection. */
export function start<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
}

/** Resolves when `signal` aborts (never rejects); the listener is removed once it fires. */
export function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

/** Waits `ms`, or until `signal` aborts, or until `until` settles — whichever is first. Leaves no timer behind. */
export async function pause(ms: number, signal?: AbortSignal, until?: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([new Promise<void>((resolve) => (timer = setTimeout(resolve, ms))), ...(signal ? [whenAborted(signal)] : []), ...(until ? [until.then(() => undefined, () => undefined)] : [])]);
  clearTimeout(timer);
}

/**
 * A deadline that CANCELS rather than abandons. `operation` receives a signal
 * that aborts at `ms` (or when `parent` aborts) and must stop its I/O on it.
 * This settles only once the operation itself has settled. If it hasn't
 * `graceMs` after the abort, its termination can't be proven: the poison
 * trips and this rejects with UnprovenTerminationError.
 */
export async function bounded<T>(label: string, ms: number, operation: (signal: AbortSignal) => Promise<T>, options: { poison: Poison; graceMs: number; parent?: AbortSignal }): Promise<T> {
  const controller = new AbortController();
  const fromParent = () => controller.abort(options.parent?.reason ?? new DeadlineError(label, ms));
  if (options.parent?.aborted) fromParent();
  else options.parent?.addEventListener("abort", fromParent, { once: true });
  const timer = setTimeout(() => controller.abort(new DeadlineError(label, ms)), ms);
  const running = observe(start(() => operation(controller.signal)));
  try {
    await Promise.race([running.settled, whenAborted(controller.signal)]);
    if (!running.isSettled()) {
      await pause(options.graceMs, undefined, running.settled);
      if (!running.isSettled()) {
        const unproven = new UnprovenTerminationError(label);
        options.poison.trip(unproven);
        throw unproven;
      }
    }
    const outcome = running.outcome()!;
    if (outcome.ok) return outcome.value;
    throw controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason : outcome.error;
  } finally {
    clearTimeout(timer);
    options.parent?.removeEventListener("abort", fromParent);
  }
}

// ------------------------------------------------------------------ case-owned recording

export type Batch = { queries: Array<{ query: string; params: unknown[] }>; status: number; body: Record<string, unknown> | null };

/** One case's isolated collector, plus the abort for that case's own (non-harness) HTTP requests. */
export class CaseRecorder<T = Batch> {
  readonly items: T[] = [];
  private open = true;
  private readonly requests = new AbortController();
  get isOpen(): boolean {
    return this.open;
  }
  get requestSignal(): AbortSignal {
    return this.requests.signal;
  }
  push(item: T): void {
    if (this.open) this.items.push(item);
  }
  abortRequests(): void {
    this.requests.abort(new Error("race case teardown"));
  }
  close(): void {
    this.open = false;
  }
}

/** Hands each request to the case active when it STARTS — fixed for that request's life, so a late response can only reach its own (by then closed) recorder. */
export class RecordingRouter<T = Batch> {
  private active: CaseRecorder<T> | null = null;
  begin(): CaseRecorder<T> {
    if (this.active?.isOpen) throw new Error("a race case is already recording");
    this.active = new CaseRecorder<T>();
    return this.active;
  }
  end(recorder: CaseRecorder<T>): void {
    recorder.close();
    if (this.active === recorder) this.active = null;
  }
  claim(): CaseRecorder<T> | null {
    return this.active?.isOpen ? this.active : null;
  }
}

/** fetchOptions marker for the harness's OWN requests (monitor, cancel, cleanup): never recorded, never tied to a case's request abort. */
export const HARNESS_REQUEST = "l2RaceHarness";

/**
 * Wraps fetch for the suite. A non-harness request (production finalize,
 * seeding, reads) is claimed by the active case: it gets that case's abort
 * signal, and its transaction-batch response is recorded into that case only.
 */
export function recordingFetch(realFetch: typeof fetch, router: RecordingRouter<Batch>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const marked = init !== undefined && HARNESS_REQUEST in init;
    const owner = marked ? null : router.claim();
    const forwarded: RequestInit = {};
    for (const [key, value] of Object.entries(init ?? {})) if (key !== HARNESS_REQUEST) (forwarded as Record<string, unknown>)[key] = value;
    if (owner) forwarded.signal = forwarded.signal ? AbortSignal.any([forwarded.signal, owner.requestSignal]) : owner.requestSignal;
    const response = await realFetch(input, forwarded);
    if (owner && typeof init?.body === "string") {
      const sent = JSON.parse(init.body) as { queries?: Batch["queries"] };
      if (sent.queries) owner.push({ queries: sent.queries, status: response.status, body: (await response.clone().json().catch(() => null)) as Batch["body"] });
    }
    return response;
  }) as typeof fetch;
}

// ------------------------------------------------------------------ the WebSocket holder

/** The subset of the Neon/pg `Client` the holder uses. */
export interface HolderClient {
  connect(): Promise<unknown>;
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<unknown>;
}

export interface HolderHandle {
  readonly pid: number;
  isOpen(): boolean;
  commit(signal: AbortSignal): Promise<void>;
  rollback(signal: AbortSignal): Promise<void>;
  /** Server-side: end exactly this session (its transaction aborts) when ROLLBACK can't be delivered. */
  terminate(signal: AbortSignal): Promise<void>;
  close(signal: AbortSignal): Promise<void>;
}

type Step = <T>(label: string, operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;

/**
 * pg-style client calls take no AbortSignal. On abort, close the client: the
 * socket closes, the pending call rejects, and Postgres aborts that session's
 * transaction — real cancellation, not abandonment.
 */
export async function abortable<T>(signal: AbortSignal, client: Pick<HolderClient, "end">, operation: () => Promise<T>): Promise<T> {
  const onAbort = () => void client.end().catch(() => undefined);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await operation();
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Opens transaction W and runs `statements` in it. If connecting, BEGIN, or
 * any statement fails, W is rolled back and the client closed — each bounded —
 * before the error propagates. pg client calls don't take an AbortSignal; they
 * are bounded by the client's own query_timeout/statement_timeout, and
 * `step` proves they settled.
 */
export async function openHolder(input: {
  client: HolderClient;
  statements: Array<{ text: string; params?: unknown[] }>;
  step: Step;
  /** For the failed-setup cleanup: its own budget, NOT the case's (which may be what just expired). */
  cleanupStep: Step;
  terminate: (pid: number, signal: AbortSignal) => Promise<void>;
}): Promise<HolderHandle> {
  const { client, step, cleanupStep } = input;
  let begun = false;
  let pid = Number.NaN;
  try {
    await step("holder connect", (signal) => abortable(signal, client, () => client.connect()));
    await step("holder BEGIN", (signal) => abortable(signal, client, () => client.query("BEGIN")));
    begun = true;
    pid = Number((await step("holder pid", (signal) => abortable(signal, client, () => client.query("SELECT pg_catalog.pg_backend_pid() AS pid")))).rows[0]?.pid);
    if (!Number.isInteger(pid)) throw new Error("holder backend pid unavailable");
    for (const statement of input.statements) await step("holder statement", (signal) => abortable(signal, client, () => client.query(statement.text, statement.params)));
  } catch (error) {
    const cleanup: unknown[] = [];
    if (begun) await cleanupStep("holder ROLLBACK after failed setup", (signal) => abortable(signal, client, () => client.query("ROLLBACK"))).catch((e: unknown) => void cleanup.push(e));
    await cleanupStep("holder close after failed setup", () => client.end()).catch((e: unknown) => void cleanup.push(e));
    if (cleanup.length > 0) throw new AggregateError([error, ...cleanup], "holder setup failed, and so did part of its cleanup");
    throw error;
  }
  let open = true;
  return {
    pid,
    isOpen: () => open,
    commit: async (signal) => {
      await abortable(signal, client, () => client.query("COMMIT"));
      open = false;
    },
    rollback: async (signal) => {
      await abortable(signal, client, () => client.query("ROLLBACK"));
      open = false;
    },
    terminate: async (signal) => {
      await input.terminate(pid, signal);
      open = false;
    },
    close: async () => {
      await client.end();
    },
  };
}

// ------------------------------------------------------------------ the monitor

/**
 * Deterministic wait for the proof condition: exactly one backend, running
 * finalize's claim statement, blocked by the holder. Every query is bounded;
 * the whole wait is bounded; a finalize that settles first (e.g. rejects)
 * ends the wait immediately with its outcome.
 */
export async function waitForFinalizeBlockedBy(input: {
  holderPid: number;
  finalize: Settlement<unknown>;
  query: (holderPid: number, signal: AbortSignal) => Promise<Array<{ pid: number; query: string }>>;
  step: Step;
  limits: Pick<RaceLimits, "monitorTotalMs" | "monitorPollMs">;
  signal: AbortSignal;
}): Promise<{ pid: number; query: string }> {
  const deadline = Date.now() + input.limits.monitorTotalMs;
  for (;;) {
    const settled = input.finalize.outcome();
    if (settled) throw new Error(`finalize settled before blocking on the holder (${settled.ok ? "resolved" : `rejected: ${String(settled.error)}`})`, { cause: settled.ok ? undefined : settled.error });
    if (Date.now() > deadline) throw new DeadlineError("waiting for finalize to block on the holder", input.limits.monitorTotalMs);
    const rows = await input.step("monitor query", (signal) => input.query(input.holderPid, signal));
    const waiting = rows.filter((r) => /WITH claimed AS/.test(r.query));
    if (waiting.length === 1 && rows.length === 1) return waiting[0]!;
    if (rows.length > 1) throw new Error(`unexpected backends blocked by the holder: ${rows.length}`);
    await pause(input.limits.monitorPollMs, input.signal, input.finalize.settled); // paces the poll only; the condition above is the proof
  }
}

// ------------------------------------------------------------------ one race case

export type RaceContext = {
  signal: AbortSignal;
  recorder: CaseRecorder<Batch>;
  /** Bounded (stepMs) under this case's deadline. */
  step: Step;
  /** Bounded (stepMs) on its OWN budget — for cleanup that must still run after the case deadline. */
  teardownStep: Step;
  setHolder(holder: HolderHandle): void;
  /** Starts production finalize and observes it at once. */
  startFinalize<T>(begin: () => Promise<T>): Settlement<T>;
  /** Bounded wait for a started finalize; returns its value or rethrows its error. */
  awaitFinalize<T>(settlement: Settlement<T>): Promise<T>;
};

export type RaceHooks = {
  /** Server-side cancel of every backend blocked by `holderPid` — provably this case's finalize. Preferred first measure; called only while the holder is still open. */
  cancelBlockedBy(holderPid: number, signal: AbortSignal): Promise<void>;
  /**
   * The termination PROOF, run after the holder is released: on its own
   * connection, take attempt L's row lock (FOR UPDATE, bounded by
   * lock_timeout) — finalize's FIRST statement takes the same lock, so
   * acquiring it means no finalize for L is mid-transaction — then delete L's
   * attempt and every row this case registered, and commit. From then on, a
   * finalize for L (even a request still in flight) finds no attempt and can
   * write nothing.
   */
  neutralizeAndClean(signal: AbortSignal): Promise<void>;
  /** Teardown progress, for order assertions. */
  onStep?(step: string): void;
};

/**
 * Runs one race case and returns (or rejects) only after its teardown:
 *   1. stop waiting on the case (deadline or finish);
 *   2. if the holder is open: cancel any backend it blocks (exactly our
 *      finalize — only identifiable while the holder still holds), then
 *      release it (ROLLBACK, else terminate its session server-side);
 *   3. neutralize-and-clean (the proof above); failure trips the poison;
 *   4. abort the case's own in-flight HTTP and require finalize to settle;
 *   5. close the holder client;
 *   6. stop this case's recording;
 *   7. require `run` itself to have settled.
 * A step that can't prove its work stopped trips the poison; every failure
 * is surfaced, never swallowed.
 */
export async function runRaceCase(input: { limits: RaceLimits; poison: Poison; router: RecordingRouter<Batch>; hooks: RaceHooks; run: (ctx: RaceContext) => Promise<void> }): Promise<void> {
  const { limits, poison, router, hooks } = input;
  poison.assertHealthy();
  const recorder = router.begin();
  const caseAbort = new AbortController();
  const caseTimer = setTimeout(() => caseAbort.abort(new DeadlineError("race case", limits.caseMs)), limits.caseMs);
  let holder: HolderHandle | null = null;
  let finalize: Settlement<unknown> | null = null;
  const step: Step = (label, operation) => bounded(label, limits.stepMs, operation, { poison, graceMs: limits.graceMs, parent: caseAbort.signal });
  const ctx: RaceContext = {
    signal: caseAbort.signal,
    recorder,
    step,
    teardownStep: (label, operation) => bounded(label, limits.stepMs, operation, { poison, graceMs: limits.graceMs }),
    setHolder: (h) => void (holder = h),
    startFinalize: (begin) => {
      const settlement = observe(start(begin));
      finalize = settlement;
      return settlement;
    },
    awaitFinalize: async (settlement) => {
      await step("awaiting finalize", (signal) => Promise.race([settlement.settled, whenAborted(signal)]));
      const outcome = settlement.outcome();
      if (!outcome) throw new DeadlineError("awaiting finalize", limits.stepMs);
      if (outcome.ok) return outcome.value;
      throw outcome.error;
    },
  };

  const running = observe(start(() => input.run(ctx)));
  await Promise.race([running.settled, whenAborted(caseAbort.signal)]);
  clearTimeout(caseTimer);
  if (!caseAbort.signal.aborted) caseAbort.abort(new Error("race case finished"));

  // ---- teardown: its own budgets, never the (already aborted) case signal
  const errors: unknown[] = [];
  const teardown = async (label: string, ms: number, operation: (signal: AbortSignal) => Promise<unknown>) => {
    hooks.onStep?.(label);
    try {
      await bounded(label, ms, operation, { poison, graceMs: limits.graceMs });
      return true;
    } catch (error) {
      errors.push(error);
      return false;
    }
  };
  const h = holder as HolderHandle | null;
  const f = finalize as Settlement<unknown> | null;

  if (h?.isOpen()) {
    await teardown("cancel finalize", limits.stepMs, (signal) => hooks.cancelBlockedBy(h.pid, signal));
    if (!(await teardown("rollback holder", limits.stepMs, (signal) => h.rollback(signal)))) {
      if (!(await teardown("terminate holder", limits.stepMs, (signal) => h.terminate(signal)))) poison.trip(new UnprovenTerminationError("holder transaction"));
    }
  }
  if (!(await teardown("neutralize and clean", limits.cleanupMs, (signal) => hooks.neutralizeAndClean(signal)))) {
    poison.trip(new UnprovenTerminationError("neutralize and clean (finalize may still write; rows may remain)"));
  }
  recorder.abortRequests();
  if (f && !f.isSettled()) {
    await teardown("settle finalize", limits.stepMs, (signal) => Promise.race([f.settled, whenAborted(signal)]));
    if (!f.isSettled()) {
      const unproven = new UnprovenTerminationError("finalize request");
      poison.trip(unproven);
      errors.push(unproven);
    }
  }
  if (h && !(await teardown("close holder", limits.stepMs, (signal) => h.close(signal)))) poison.trip(new UnprovenTerminationError("holder client"));
  router.end(recorder);
  hooks.onStep?.("drain run");
  await pause(limits.stepMs, undefined, running.settled);
  if (!running.isSettled()) {
    const unproven = new UnprovenTerminationError("race case body");
    poison.trip(unproven);
    errors.push(unproven);
  }

  const outcome = running.outcome();
  const failures = [...(outcome && !outcome.ok ? [outcome.error] : []), ...errors];
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `race case failed (${failures.length} errors, teardown included)`);
}

// ------------------------------------------------------------------ the direct (non-pooled) endpoint

/**
 * The race suite's ONLY database URL. It needs one direct Postgres session
 * per client (holder PID, pg_blocking_pids, session timeouts), so it never
 * falls back to DATABASE_URL — that is normally the pooled application URL.
 */
export const DIRECT_DATABASE_URL_ENV = "REAL_SMOKE_L2_DIRECT_DATABASE_URL";

export type DirectUrlCheck = { ok: true; url: string; hostname: string } | { ok: false; reason: string };

/**
 * Accepts only a parseable postgres:// or postgresql:// URL whose HOSTNAME
 * is not a Neon pooled endpoint (a hostname label ending in "-pooler", e.g.
 * ep-name-123456-pooler.us-east-2.aws.neon.tech). Only the parsed hostname is
 * inspected — never the user, password, path, or query — and a refusal names
 * at most that hostname, never the URL or its credentials.
 */
export function resolveDirectDatabaseUrl(env: Record<string, string | undefined>): DirectUrlCheck {
  const raw = env[DIRECT_DATABASE_URL_ENV]?.trim();
  if (!raw) return { ok: false, reason: `${DIRECT_DATABASE_URL_ENV} is not set (the race suite never falls back to DATABASE_URL)` };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: `${DIRECT_DATABASE_URL_ENV} is not a parseable URL` };
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return { ok: false, reason: `${DIRECT_DATABASE_URL_ENV} must be a postgres:// or postgresql:// URL` };
  const hostname = parsed.hostname.toLowerCase();
  const labels = hostname.split(".");
  if (!hostname || labels.some((label) => label === "")) return { ok: false, reason: `${DIRECT_DATABASE_URL_ENV} has no valid hostname` };
  if (labels.some((label) => label.endsWith("-pooler"))) return { ok: false, reason: `${DIRECT_DATABASE_URL_ENV} points at a POOLED Neon endpoint (${hostname}); use the direct endpoint (the same hostname without "-pooler")` };
  return { ok: true, url: raw, hostname };
}

/**
 * A WebSocket session's server-side timeouts as its startup `options`
 * ("-c name=ms ..."). Neon's proxy forwards `options` to Postgres but drops
 * pg's separate statement_timeout / lock_timeout /
 * idle_in_transaction_session_timeout startup parameters (seen live: the
 * preflight read 0 / 0 / the server's own default). Applied at session start,
 * before any statement — never a SET. lock_timeout only when the caller asks.
 */
export function sessionStartupOptions(limits: Pick<RaceLimits, "statementTimeoutMs" | "holderIdleInTransactionMs">, extra: { lock_timeout?: number } = {}): string {
  const settings: Array<[string, number | undefined]> = [
    ["statement_timeout", limits.statementTimeoutMs],
    ["idle_in_transaction_session_timeout", limits.holderIdleInTransactionMs],
    ["lock_timeout", extra.lock_timeout],
  ];
  return settings
    .filter((entry): entry is [string, number] => entry[1] !== undefined)
    .map(([name, ms]) => {
      if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error(`${name} must be a positive whole number of ms, got ${String(ms)}`);
      return `-c ${name}=${ms}`;
    })
    .join(" ");
}

/** One row of pg_settings for the current session: `setting` in the GUC's base `unit`. */
export type SessionSetting = { name: string; setting: string; unit: string | null };

/**
 * Proves the server honored the session settings the harness relies on —
 * read from pg_settings (numeric value in its base unit), never by parsing
 * SHOW's display text. Returns every mismatch; empty means all applied.
 */
export function sessionSettingProblems(rows: SessionSetting[], expected: { applicationName: string; msSettings: Record<string, number> }): string[] {
  const byName = new Map(rows.map((row) => [row.name, row]));
  const problems: string[] = [];
  const app = byName.get("application_name");
  if (app?.setting !== expected.applicationName) problems.push("application_name was not applied");
  for (const [name, ms] of Object.entries(expected.msSettings)) {
    const row = byName.get(name);
    if (!row) problems.push(`${name} is missing from pg_settings`);
    else if (row.unit !== "ms") problems.push(`${name} has unexpected unit ${String(row.unit)}`);
    else if (Number(row.setting) !== ms || ms <= 0) problems.push(`${name} is ${row.setting} ms, expected ${ms} ms`);
  }
  return problems;
}

/**
 * The race suite's whole beforeAll, in the only safe order:
 *   1. validate the direct URL — pure, no I/O;
 *   2. READ-ONLY session probe on that endpoint: the server must have applied
 *      the application_name and every timeout the harness relies on;
 *   3. only then `activate` (hand the suite its URL, patch fetch).
 * Any refusal throws BEFORE `activate`, so nothing has been patched, seeded,
 * or written. Messages carry at most the hostname — never the URL.
 */
export async function prepareRaceSuite(input: {
  env: Record<string, string | undefined>;
  applicationName: string;
  msSettings: Record<string, number>;
  /** Opens a session on `url` with those settings and returns its pg_settings rows. Must not write. */
  readSessionSettings: (url: string) => Promise<SessionSetting[]>;
  activate: (url: string) => void;
}): Promise<void> {
  const check = resolveDirectDatabaseUrl(input.env);
  if (!check.ok) throw new Error(`race suite refused before any database work: ${check.reason}`);
  const problems = sessionSettingProblems(await input.readSessionSettings(check.url), { applicationName: input.applicationName, msSettings: input.msSettings });
  if (problems.length > 0) throw new Error(`race suite refused before any write: the ${check.hostname} session did not apply its settings (${problems.join("; ")})`);
  input.activate(check.url);
}
