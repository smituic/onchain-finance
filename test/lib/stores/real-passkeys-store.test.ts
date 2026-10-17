import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 2g-H: the browser always performs a fresh step-up with the signed-in
 * passkey BEFORE asking for a backup registration challenge, and sends that
 * assertion along — the server refuses the cookie alone.
 */
const ceremonies = vi.hoisted(() => ({
  performLoginCeremony: vi.fn(),
  performRegistrationCeremony: vi.fn(),
}));

const signing = vi.hoisted(() => ({
  signDigest: vi.fn(),
  stampCreate: vi.fn(),
  stampDelete: vi.fn(),
}));

vi.mock("@/lib/real/signing/raw-sign", () => ({ signDigestViaTurnkeyRaw: signing.signDigest }));
vi.mock("@/lib/real/signing/authenticator-requests", () => ({
  stampCreateAuthenticatorsRequest: signing.stampCreate,
  stampDeleteAuthenticatorsRequest: signing.stampDelete,
}));

vi.mock("@/lib/real/account/webauthn-client", () => ({
  performLoginCeremony: ceremonies.performLoginCeremony,
  performRegistrationCeremony: ceremonies.performRegistrationCeremony,
  isWebAuthnCancellation: (error: unknown) => Boolean(error && typeof error === "object" && "name" in error && (error as { name: string }).name === "NotAllowedError"),
}));

const { createRealPasskeysStore } = await import("@/lib/stores/real-passkeys-store");
const storeModule = await import("@/lib/stores/real-passkeys-store");
const { parseSubmitRetryAfter } = await import("@/lib/stores/real-payment-store");
const passkeyCopy = await import("@/lib/real/display/passkey-status");

type Call = { url: string; method: string; body: unknown };

function stubServer() {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (url.endsWith("/backup/status")) return ok({ enrollment: null });
      if (url.endsWith("/backup/step-up/options")) return ok({ optionsJSON: { challenge: "step-up-challenge", allowCredentials: [{ id: "cred-a" }] } });
      if (url.endsWith("/backup/options")) return ok({ enrollmentId: "e1", optionsJSON: { challenge: "registration-challenge" } });
      if (url.endsWith("/backup/register")) return ok({ enrollmentId: "e1" });
      if (url.endsWith("/api/real/account/passkeys")) return ok({ passkeys: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  ceremonies.performLoginCeremony.mockReset();
  ceremonies.performRegistrationCeremony.mockReset();
  signing.signDigest.mockReset();
  signing.stampCreate.mockReset();
  signing.stampDelete.mockReset();
  vi.useRealTimers();
});

describe("real-passkeys-store — backup setup step-up (2g-H)", () => {
  it("steps up with the signed-in passkey first, then sends that assertion with the registration-options request", async () => {
    const calls = stubServer();
    ceremonies.performLoginCeremony.mockResolvedValue({ id: "cred-a", kind: "step-up-assertion" });
    ceremonies.performRegistrationCeremony.mockResolvedValue({ id: "cred-new", kind: "registration" });
    await createRealPasskeysStore().getState().continueBackupSetup();

    const posts = calls.filter((c) => c.method === "POST").map((c) => c.url.replace(/^.*\/backup\//, ""));
    expect(posts).toEqual(["step-up/options", "options", "register"]);
    expect(ceremonies.performLoginCeremony).toHaveBeenCalledWith({ challenge: "step-up-challenge", allowCredentials: [{ id: "cred-a" }] });
    expect(calls.find((c) => c.url.endsWith("/backup/options"))?.body).toEqual({ stepUp: { id: "cred-a", kind: "step-up-assertion" } });
    expect(ceremonies.performRegistrationCeremony).toHaveBeenCalledWith({ challenge: "registration-challenge" });
  });

  it("cancelling the step-up prompt asks for no registration challenge and shows no error", async () => {
    const calls = stubServer();
    ceremonies.performLoginCeremony.mockRejectedValue(Object.assign(new Error("cancelled"), { name: "NotAllowedError" }));
    const store = createRealPasskeysStore();
    await store.getState().continueBackupSetup();
    expect(calls.some((c) => c.url.endsWith("/backup/options"))).toBe(false);
    expect(ceremonies.performRegistrationCeremony).not.toHaveBeenCalled();
    expect(store.getState().setupError).toBeNull();
  });
});

describe("real-passkeys-store — a setup under review (2g-H)", () => {
  it("'Check again' only asks the server to re-read — it never requests or stamps a new authorization", async () => {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
        if (url.endsWith("/backup/status")) return ok({ enrollment: { id: "e1", state: "blocked", externalOutcome: "unknown", abandonable: false, blockReason: "needs review" } });
        if (url.endsWith("/backup/authorize/reconcile")) return ok({ outcome: "blocked", reason: "still needs review" });
        if (url.endsWith("/api/real/account/passkeys")) return ok({ passkeys: [] });
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    const store = createRealPasskeysStore();
    await store.getState().continueBackupSetup();
    const posts = calls.filter((c) => c.method === "POST").map((c) => c.url.replace(/^.*\/backup\//, ""));
    expect(posts).toEqual(["authorize/reconcile"]);
    expect(ceremonies.performLoginCeremony).not.toHaveBeenCalled();
    expect(store.getState().setupError).toBe("still needs review");
  });
});

describe("real-passkeys-store — S4 account generation guard", () => {
  type Pending = { url: string; resolve: (body: unknown) => void };

  /** Every fetch parks until the test resolves it — lets a test interleave account switches with in-flight responses. */
  function stubDeferredServer() {
    const pending: Pending[] = [];
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Promise<Response>((resolve) => {
          pending.push({ url, resolve: (body) => resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) });
        });
      }),
    );
    const take = (suffix: string) => {
      const index = pending.findIndex((p) => p.url.endsWith(suffix));
      if (index < 0) throw new Error(`no pending request for ${suffix}`);
      return pending.splice(index, 1)[0]!;
    };
    return { pending, calls, take };
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const row = (credentialId: string) => ({ credentialId, role: "primary", displayName: null, status: "active", credentialDeviceType: null, credentialBackedUp: null, createdAt: "2026-01-01T00:00:00.000Z", isCurrentSession: true, canAuthorizeRemovals: true, removal: null });

  it("reset() clears every account-specific field", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ passkeys: [row("cred-a")], enrollment: { id: "e1", state: "started", externalOutcome: "not_attempted", abandonable: true, blockReason: null } }), { status: 200 })));
    const store = createRealPasskeysStore();
    await store.getState().refresh();
    store.setState({ setupMessage: "x", setupError: "y", removalError: "z", removalMessage: { credentialId: "cred-a", text: "t" }, renameError: { credentialId: "cred-a", text: "r" } });
    expect(store.getState().passkeys).toHaveLength(1);

    store.getState().reset();
    const state = store.getState();
    expect(state).toMatchObject({ passkeys: [], enrollment: null, listStatus: "idle", listError: null, setupBusy: false, setupMessage: null, setupError: null, removalBusyCredentialId: null, removalMessage: null, removalError: null, renameBusyCredentialId: null, renameError: null });
  });

  it("a late response from account A never overwrites account B's passkey list", async () => {
    const server = stubDeferredServer();
    const store = createRealPasskeysStore();
    store.getState().bindAccount("app-user-a");
    const refreshA = store.getState().refresh();

    // Account switch while A's list is still in flight.
    store.getState().bindAccount("app-user-b");
    const aList = server.take("/api/real/account/passkeys");
    const aStatus = server.take("/backup/status");
    const refreshB = store.getState().refresh();
    server.take("/api/real/account/passkeys").resolve({ passkeys: [row("cred-b")] });
    server.take("/backup/status").resolve({ enrollment: null });
    await refreshB;
    expect(store.getState().passkeys.map((p) => p.credentialId)).toEqual(["cred-b"]);

    // A's answers finally land — and are dropped.
    aList.resolve({ passkeys: [row("cred-a")] });
    aStatus.resolve({ enrollment: { id: "a-enrollment", state: "started", externalOutcome: "not_attempted", abandonable: true, blockReason: null } });
    await refreshA;
    expect(store.getState().passkeys.map((p) => p.credentialId)).toEqual(["cred-b"]);
    expect(store.getState().enrollment).toBeNull();
    expect(store.getState().listStatus).toBe("ready");
  });

  it("within one account, an older refresh resolving late never overwrites a newer one", async () => {
    const server = stubDeferredServer();
    const store = createRealPasskeysStore();
    store.getState().bindAccount("app-user-a");
    const first = store.getState().refresh();
    const [oldList, oldStatus] = [server.take("/api/real/account/passkeys"), server.take("/backup/status")];
    const second = store.getState().refresh();
    server.take("/api/real/account/passkeys").resolve({ passkeys: [row("cred-new")] });
    server.take("/backup/status").resolve({ enrollment: null });
    await second;
    oldList.resolve({ passkeys: [row("cred-old")] });
    oldStatus.resolve({ enrollment: null });
    await first;
    expect(store.getState().passkeys.map((p) => p.credentialId)).toEqual(["cred-new"]);
  });

  it("an in-flight backup setup for account A stops at the switch — nothing more is sent under B's cookie, nothing is written to B's state", async () => {
    const server = stubDeferredServer();
    let finishCeremony: (value: unknown) => void = () => {};
    ceremonies.performLoginCeremony.mockImplementation(() => new Promise((resolve) => (finishCeremony = resolve)));
    const store = createRealPasskeysStore();
    store.getState().bindAccount("app-user-a");

    const setup = store.getState().continueBackupSetup();
    server.take("/backup/status").resolve({ enrollment: null });
    await flush();
    server.take("/backup/step-up/options").resolve({ optionsJSON: { challenge: "c" } });
    await flush();
    expect(store.getState().setupBusy).toBe(true);

    store.getState().bindAccount("app-user-b"); // e.g. signed out and a different account signed in
    finishCeremony({ id: "cred-a" });
    await setup;

    expect(server.calls.some((c) => c.url.endsWith("/backup/options"))).toBe(false);
    expect(server.pending).toHaveLength(0); // no trailing refresh either
    expect(store.getState()).toMatchObject({ setupBusy: false, setupMessage: null, setupError: null, passkeys: [] });
  });

  it("binding the SAME account again is a no-op — a remount mid-flow keeps the flow's state", () => {
    const store = createRealPasskeysStore();
    store.getState().bindAccount("app-user-a");
    store.setState({ setupBusy: true, setupMessage: "Working" });
    store.getState().bindAccount("app-user-a");
    expect(store.getState()).toMatchObject({ setupBusy: true, setupMessage: "Working" });
    store.getState().bindAccount(null);
    expect(store.getState()).toMatchObject({ setupBusy: false, setupMessage: null });
  });
});


// ================================================================== 3A-3 Stage 2A: client deferral and shared wait

describe("real-passkeys-store — 3A-3 Stage 2A shared Turnkey-check wait", () => {
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const RECONCILE = "/backup/authorize/reconcile";
  const CONFIRM = "/backup/verify-signing/confirm";
  const REMOVAL_RECONCILE = "/revoke/reconcile";
  const flush = () => vi.advanceTimersByTimeAsync(0);

  const IN_FLIGHT = { id: "e1", state: "turnkey_enrollment_in_flight", externalOutcome: "unknown", abandonable: false, blockReason: null };
  const BLOCKED = { id: "e1", state: "blocked", externalOutcome: "unknown", abandonable: false, blockReason: "needs review" };
  const LOGIN_VERIFIED = { id: "e1", state: "login_verified", externalOutcome: "unknown", abandonable: false, blockReason: null };
  const PROOF = { subOrganizationId: "sub", ownerAddress: "0xabc", rpId: "localhost", authorizingCredentialId: "cred-new", digest: "0x00" };
  const PENDING_REASON = "Your authorization was sent but hasn't been confirmed yet. Check again shortly.";
  const REMOVAL_REASON = `Removal submitted, not yet confirmed. ${passkeyCopy.MAY_STILL_AUTHORIZE_NOTE}`;
  const deferred = (outcome: string, reason: string, retryAfterSeconds: unknown = 120) => ({ outcome, reason, reconciliationDeferred: true, retryAfterSeconds });

  type Handler = () => Response | Promise<Response>;
  /** Routes by URL suffix; unknown URLs throw. The list and status reads answer by default (status: no enrollment). */
  function server(handlers: Record<string, Handler>) {
    const calls: Call[] = [];
    const table: Record<string, Handler> = { "/api/real/account/passkeys": () => json({ passkeys: [] }), "/backup/status": () => json({ enrollment: null }), ...handlers };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const key = Object.keys(table).find((suffix) => url.endsWith(suffix));
        if (!key) throw new Error(`Unexpected fetch: ${url}`);
        return table[key]!();
      }),
    );
    return { calls, count: (suffix: string) => calls.filter((c) => c.url.endsWith(suffix)).length };
  }
  const parked = () => {
    let resolve: (response: Response) => void = () => {};
    const promise = new Promise<Response>((r) => (resolve = r));
    return { handler: (() => promise) as Handler, resolve };
  };

  function setup() {
    vi.useFakeTimers();
    const store = createRealPasskeysStore();
    store.getState().bindAccount("app-user-a");
    return store;
  }
  /** A store that has just been told, by the server, to wait `seconds` (via a removal-reconcile deferral). */
  async function waiting(seconds = 120) {
    const store = setup();
    const srv = server({ [REMOVAL_RECONCILE]: () => json(deferred("pending", REMOVAL_REASON, seconds)) });
    await store.getState().checkRemoval("cred-b", "r1");
    expect(store.getState()).toMatchObject({ isTurnkeyCheckWaiting: true, turnkeyCheckWaitSeconds: seconds });
    return { store, srv };
  }

  describe("reconcile deferrals (HTTP 200)", () => {
    it("backup: a deferral stops the loop after ONE request — no 1.5 s poll follows — and the state stays unconfirmed", async () => {
      const store = setup();
      const srv = server({ "/backup/status": () => json({ enrollment: IN_FLIGHT }), [RECONCILE]: () => json(deferred("pending", PENDING_REASON, 120)) });
      await store.getState().continueBackupSetup();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(srv.count(RECONCILE)).toBe(1);
      const state = store.getState();
      expect(state).toMatchObject({ isTurnkeyCheckWaiting: true, turnkeyCheckWaitSeconds: 120, setupError: null, setupBusy: false });
      expect(state.setupMessage).toBe(passkeyCopy.backupCheckWaitMessage(120));
      expect(state.setupMessage).toContain("isn't confirmed");
      expect(state.setupMessage).not.toMatch(/confirmed!|set up!|failed|removed|automatic/i);
    });

    it("control: without the deferral flag the loop still polls up to five times, spaced — unchanged", async () => {
      const store = setup();
      const srv = server({ "/backup/status": () => json({ enrollment: IN_FLIGHT }), [RECONCILE]: () => json({ outcome: "pending", reason: PENDING_REASON }) });
      const run = store.getState().continueBackupSetup();
      await flush();
      expect(srv.count(RECONCILE)).toBe(1);
      await vi.advanceTimersByTimeAsync(1499);
      expect(srv.count(RECONCILE)).toBe(1);
      await vi.advanceTimersByTimeAsync(10_000);
      await run;
      expect(srv.count(RECONCILE)).toBe(5);
      expect(store.getState()).toMatchObject({ isTurnkeyCheckWaiting: false, turnkeyCheckWaitSeconds: null, setupMessage: PENDING_REASON });
    });

    it("backup under review: the stored reason is kept as the error and the wait is added beside it", async () => {
      const store = setup();
      const srv = server({ "/backup/status": () => json({ enrollment: BLOCKED }), [RECONCILE]: () => json(deferred("blocked", "still needs review", 300)) });
      await store.getState().continueBackupSetup();
      expect(srv.count(RECONCILE)).toBe(1);
      expect(store.getState()).toMatchObject({ setupError: "still needs review", setupMessage: passkeyCopy.reviewCheckWaitMessage(300), isTurnkeyCheckWaiting: true, turnkeyCheckWaitSeconds: 300 });
      expect(ceremonies.performLoginCeremony).not.toHaveBeenCalled();
    });

    it("removal: a deferral stops after ONE request, keeps the server's reason (with its warning) and never claims removal", async () => {
      const store = setup();
      const srv = server({ [REMOVAL_RECONCILE]: () => json(deferred("pending", REMOVAL_REASON, 90)) });
      await store.getState().checkRemoval("cred-b", "r1");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(srv.count(REMOVAL_RECONCILE)).toBe(1);
      const message = store.getState().removalMessage;
      expect(message).toEqual({ credentialId: "cred-b", text: passkeyCopy.removalCheckWaitMessage(REMOVAL_REASON, 90), waitBase: REMOVAL_REASON });
      expect(message!.text).toContain(passkeyCopy.MAY_STILL_AUTHORIZE_NOTE);
      expect(message!.text).not.toBe(passkeyCopy.PASSKEY_REMOVED_MESSAGE);
      expect(store.getState().removalError).toBeNull();
    });

    it("a daily denial (86 400 s) is accepted and shown as hours, not as an error", async () => {
      const { store } = await waiting(86_400);
      expect(store.getState().removalMessage!.text).toContain("24 hours");
    });

    it("missing metadata keeps normal behavior; present-but-invalid metadata waits the 60 s fallback and invents no outcome", async () => {
      const normal = setup();
      server({ [REMOVAL_RECONCILE]: () => json({ outcome: "revoked" }) });
      await normal.getState().checkRemoval("cred-b", "r1");
      expect(normal.getState()).toMatchObject({ isTurnkeyCheckWaiting: false, removalMessage: { credentialId: "cred-b", text: passkeyCopy.PASSKEY_REMOVED_MESSAGE } });

      const bad: unknown[] = [
        { reconciliationDeferred: "yes", retryAfterSeconds: 120 },
        { reconciliationDeferred: false, retryAfterSeconds: 120 },
        { reconciliationDeferred: null, retryAfterSeconds: 120 },
        { reconciliationDeferred: true },
        { reconciliationDeferred: true, retryAfterSeconds: 0 },
        { reconciliationDeferred: true, retryAfterSeconds: -3 },
        { reconciliationDeferred: true, retryAfterSeconds: 1.5 },
        { reconciliationDeferred: true, retryAfterSeconds: "120" },
        { reconciliationDeferred: true, retryAfterSeconds: 86_401 },
        { reconciliationDeferred: true, retryAfterSeconds: null },
      ];
      for (const extra of bad) {
        const store = setup();
        const srv = server({ [REMOVAL_RECONCILE]: () => json({ outcome: "pending", reason: REMOVAL_REASON, ...(extra as object) }) });
        await store.getState().checkRemoval("cred-b", "r1");
        expect(srv.count(REMOVAL_RECONCILE), JSON.stringify(extra)).toBe(1);
        expect(store.getState().turnkeyCheckWaitSeconds, JSON.stringify(extra)).toBe(60);
        expect(store.getState().removalMessage?.text).not.toBe(passkeyCopy.PASSKEY_REMOVED_MESSAGE);
      }
    });

    it("existing terminal outcomes are unchanged: confirmed ends setup, a removal 'revoked' still says removed, a 500 is an error", async () => {
      const store = setup();
      let statusCalls = 0;
      server({ "/backup/status": () => json({ enrollment: statusCalls++ === 0 ? IN_FLIGHT : null }), [RECONCILE]: () => json({ outcome: "confirmed" }) });
      await store.getState().continueBackupSetup();
      expect(store.getState()).toMatchObject({ setupError: null, isTurnkeyCheckWaiting: false });

      const failing = setup();
      server({ [REMOVAL_RECONCILE]: () => json({ error: "Something went wrong. Please try again." }, 500) });
      await failing.getState().checkRemoval("cred-b", "r1");
      expect(failing.getState()).toMatchObject({ removalError: "Something went wrong. Please try again.", isTurnkeyCheckWaiting: false, turnkeyCheckWaitSeconds: null });
    });
  });

  describe("signing confirmation denial (HTTP 429)", () => {
    const denial = (headers: Record<string, string> = { "Retry-After": "45" }) => json({ error: "You're checking a bit often. Try again in a moment.", code: "rate_limited", retryable: true }, 429, headers);
    function confirmServer(confirm: Handler) {
      signing.signDigest.mockResolvedValue({ activityId: "act-1" });
      return server({ "/backup/status": () => json({ enrollment: LOGIN_VERIFIED }), "/backup/verify-signing/options": () => json(PROOF), [CONFIRM]: confirm });
    }

    it("a valid denial starts the shared wait from the header, is NOT an error, and fabricates no success", async () => {
      const store = setup();
      const srv = confirmServer(() => denial());
      await store.getState().continueBackupSetup();
      expect(srv.count(CONFIRM)).toBe(1);
      expect(store.getState()).toMatchObject({ isTurnkeyCheckWaiting: true, turnkeyCheckWaitSeconds: 45, setupError: null, setupMessage: passkeyCopy.signingCheckWaitMessage(45) });
      expect(store.getState().setupMessage).toContain("isn't set up yet");
    });

    it("an unrelated or malformed 429 is an ordinary error and starts no wait", async () => {
      const cases: Response[] = [
        json({ error: "Slow down." }, 429, { "Retry-After": "45" }),
        json({ error: "x", code: "other", retryable: true }, 429, { "Retry-After": "45" }),
        json({ error: "x", code: "rate_limited", retryable: false }, 429, { "Retry-After": "45" }),
        json({ error: "x", code: "rate_limited", retryable: "true" }, 429, { "Retry-After": "45" }),
        json({ error: "x", code: "rate_limited" }, 429, { "Retry-After": "45" }),
        json({ error: "x", code: "rate_limited", retryable: true }, 503, { "Retry-After": "45" }),
        json({ error: "x", code: "rate_limited", retryable: true }, 500),
      ];
      for (const response of cases) {
        const store = setup();
        confirmServer(() => response.clone());
        await store.getState().continueBackupSetup();
        expect(store.getState().isTurnkeyCheckWaiting, await response.clone().text()).toBe(false);
        expect(store.getState().setupError).not.toBeNull();
      }
    });

    it("a non-JSON 429 neither crashes parsing nor starts a wait", async () => {
      for (const body of ["Too Many Requests", ""]) {
        const store = setup();
        confirmServer(() => new Response(body, { status: 429, headers: { "Retry-After": "45", "content-type": "text/plain" } }));
        await store.getState().continueBackupSetup();
        expect(store.getState().isTurnkeyCheckWaiting).toBe(false);
        expect(store.getState().setupError).toBe("Request failed (429)");
      }
    });

    it("unusable Retry-After metadata on a VALID denial waits 60 s — never zero", async () => {
      const headers: Array<Record<string, string>> = [{}, { "Retry-After": "" }, { "Retry-After": "0" }, { "Retry-After": "-5" }, { "Retry-After": "1.5" }, { "Retry-After": "030" }, { "Retry-After": "30, 60" }, { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }, { "Retry-After": "99999999999" }, { "Retry-After": "86401" }];
      for (const header of headers) {
        const store = setup();
        confirmServer(() => denial(header));
        await store.getState().continueBackupSetup();
        expect(store.getState().turnkeyCheckWaitSeconds, JSON.stringify(header)).toBe(60);
      }
    });

    it("Retry-After parsing is exactly the payment store's strict convention", () => {
      const inputs: Array<string | null | undefined> = [undefined, null, "", "0", "1", "30", "86400", "86401", "99999", "100000", "-5", "+5", "1.5", "030", "007", "1e3", "0x10", " 30", "30 ", "30, 60", "٣٠", "Wed, 21 Oct 2026 07:28:00 GMT", "NaN", "Infinity"];
      for (const input of inputs) expect(storeModule.parseTurnkeyRetryAfter(input), String(input)).toBe(parseSubmitRetryAfter(input));
      expect(storeModule.parseTurnkeyRetryAfter("86400")).toBe(86_400);
      expect(storeModule.parseTurnkeyRetryAfter("30")).toBe(30);
    });
  });

  describe("one shared wait", () => {
    it("a backup deferral blocks removal reconciliation, and a removal deferral blocks backup reconciliation and confirmation — locally, with no request", async () => {
      // backup -> removal
      const a = setup();
      const srvA = server({ "/backup/status": () => json({ enrollment: IN_FLIGHT }), [RECONCILE]: () => json(deferred("pending", PENDING_REASON, 120)), [REMOVAL_RECONCILE]: () => json({ outcome: "revoked" }) });
      await a.getState().continueBackupSetup();
      await a.getState().checkRemoval("cred-b", "r1");
      expect(srvA.count(REMOVAL_RECONCILE)).toBe(0);
      expect(a.getState().removalMessage?.text).toContain(passkeyCopy.MAY_STILL_AUTHORIZE_NOTE);

      // removal -> backup (in flight, then under review)
      for (const enrollment of [IN_FLIGHT, BLOCKED]) {
        const { store } = await waiting(120);
        const srv = server({ "/backup/status": () => json({ enrollment }), [RECONCILE]: () => json({ outcome: "confirmed" }) });
        await store.getState().continueBackupSetup();
        expect(srv.count(RECONCILE)).toBe(0);
        expect(store.getState().setupMessage).toBeTruthy();
        expect(store.getState().isTurnkeyCheckWaiting).toBe(true);
      }
    });

    it("a wait blocks the confirmation AND the signing ceremony that would lead to it", async () => {
      const { store } = await waiting(120);
      signing.signDigest.mockResolvedValue({ activityId: "act-1" });
      const srv = server({ "/backup/status": () => json({ enrollment: LOGIN_VERIFIED }), "/backup/verify-signing/options": () => json(PROOF), [CONFIRM]: () => json({ active: true }) });
      await store.getState().continueBackupSetup();
      expect(srv.count("/backup/verify-signing/options")).toBe(0);
      expect(srv.count(CONFIRM)).toBe(0);
      expect(signing.signDigest).not.toHaveBeenCalled();
      expect(store.getState().setupMessage).toBe(passkeyCopy.signingCheckWaitMessage(120));
    });

    it("a wait that starts DURING the signing ceremony stops the confirmation request from being sent", async () => {
      const store = setup();
      signing.signDigest.mockImplementation(async () => {
        // Another check (e.g. a removal reconcile) is denied while the user is approving.
        server({ [REMOVAL_RECONCILE]: () => json(deferred("pending", REMOVAL_REASON, 200)) });
        await store.getState().checkRemoval("cred-b", "r1");
        return { activityId: "act-1" };
      });
      const confirmCalls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.endsWith("/backup/status")) return json({ enrollment: LOGIN_VERIFIED });
          if (url.endsWith("/backup/verify-signing/options")) return json(PROOF);
          if (url.endsWith(CONFIRM)) {
            confirmCalls.push(url);
            return json({ active: true });
          }
          if (url.endsWith(REMOVAL_RECONCILE)) return json(deferred("pending", REMOVAL_REASON, 200));
          if (url.endsWith("/api/real/account/passkeys")) return json({ passkeys: [] });
          throw new Error(`Unexpected fetch: ${url}`);
        }),
      );
      await store.getState().continueBackupSetup();
      expect(confirmCalls).toHaveLength(0);
      expect(store.getState().setupMessage).toBe(passkeyCopy.signingCheckWaitMessage(200));
    });

    it("the longer deadline wins in either order, and a stale timer never clears the newer one", async () => {
      for (const [first, second, expected] of [
        [60, 300, 300],
        [300, 60, 300],
      ] as const) {
        const store = setup();
        const removal = parked();
        const backup = parked();
        server({ "/backup/status": () => json({ enrollment: IN_FLIGHT }), [REMOVAL_RECONCILE]: removal.handler, [RECONCILE]: backup.handler });
        const a = store.getState().checkRemoval("cred-b", "r1");
        const b = store.getState().continueBackupSetup();
        await flush();
        removal.resolve(json(deferred("pending", REMOVAL_REASON, first)));
        await flush();
        backup.resolve(json(deferred("pending", PENDING_REASON, second)));
        await Promise.all([a, b]);
        expect(store.getState().turnkeyCheckWaitSeconds).toBe(expected);
        await vi.advanceTimersByTimeAsync(61_000);
        expect(store.getState().isTurnkeyCheckWaiting).toBe(true); // the 60 s timer did not clear the 300 s deadline
        await vi.advanceTimersByTimeAsync(240_000);
        expect(store.getState()).toMatchObject({ isTurnkeyCheckWaiting: false, turnkeyCheckWaitSeconds: null });
      }
    });

    it("at expiry the flag clears and NOTHING is sent or signed; one later manual attempt is then possible", async () => {
      const { store, srv } = await waiting(120);
      const before = srv.calls.length;
      signing.signDigest.mockResolvedValue({ activityId: "act-1" });
      await vi.advanceTimersByTimeAsync(119_000);
      expect(store.getState().isTurnkeyCheckWaiting).toBe(true);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(store.getState()).toMatchObject({ isTurnkeyCheckWaiting: false, turnkeyCheckWaitSeconds: null });
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(srv.calls.length).toBe(before);
      expect(signing.signDigest).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      await store.getState().checkRemoval("cred-b", "r1");
      expect(srv.count(REMOVAL_RECONCILE)).toBe(2); // exactly one more
    });

    it("the wait is in memory only: it never touches browser storage", async () => {
      const setItem = vi.fn();
      vi.stubGlobal("localStorage", { setItem, getItem: vi.fn(), removeItem: vi.fn() });
      vi.stubGlobal("sessionStorage", { setItem, getItem: vi.fn(), removeItem: vi.fn() });
      await waiting(120);
      expect(setItem).not.toHaveBeenCalled();
    });
  });

  describe("what a wait must NOT block", () => {
    it("the original removal submit goes through during a wait; only the follow-up reconcile is skipped, and the result stays pending", async () => {
      const { store } = await waiting(120);
      signing.stampDelete.mockResolvedValue({ stamped: true });
      const srv = server({
        "/revoke/options": () => json({ attemptId: "r2", activity: {}, rpId: "localhost", authorizingCredentialId: "cred-a" }),
        "/revoke/submit": () => json({ outcome: "pending", reason: REMOVAL_REASON }),
        [REMOVAL_RECONCILE]: () => json({ outcome: "revoked" }),
      });
      await store.getState().removePasskey("cred-c");
      expect(srv.count("/revoke/options")).toBe(1);
      expect(srv.count("/revoke/submit")).toBe(1);
      expect(signing.stampDelete).toHaveBeenCalledTimes(1);
      expect(srv.count(REMOVAL_RECONCILE)).toBe(0);
      const text = store.getState().removalMessage!.text;
      expect(text).toBe(passkeyCopy.removalCheckWaitMessage(REMOVAL_REASON, store.getState().turnkeyCheckWaitSeconds!));
      expect(text).toContain(passkeyCopy.MAY_STILL_AUTHORIZE_NOTE);
      expect(text).not.toBe(passkeyCopy.PASSKEY_REMOVED_MESSAGE);
      expect(store.getState().removalError).toBeNull();
    });

    it("setup steps that begin with step-up, registration, authorize options/submit, abandon and cancel are never gated", async () => {
      const { store } = await waiting(120);
      ceremonies.performLoginCeremony.mockResolvedValue({ id: "cred-a" });
      ceremonies.performRegistrationCeremony.mockResolvedValue({ id: "cred-new" });
      const none = server({
        "/backup/step-up/options": () => json({ optionsJSON: { challenge: "c" } }),
        "/backup/options": () => json({ optionsJSON: { challenge: "r" } }),
        "/backup/register": () => json({ enrollmentId: "e1" }),
      });
      await store.getState().continueBackupSetup();
      expect(none.calls.filter((c) => c.method === "POST").map((c) => c.url.replace(/^.*\/backup\//, ""))).toEqual(["step-up/options", "options", "register"]);

      signing.stampCreate.mockResolvedValue({ signed: true });
      const authorize = server({
        "/backup/status": () => json({ enrollment: { id: "e1", state: "credential_registered", externalOutcome: "not_attempted", abandonable: true, blockReason: null } }),
        "/backup/authorize/options": () => json({ activity: {}, rpId: "localhost", authorizingCredentialId: "cred-a" }),
        "/backup/authorize/submit": () => json({ outcome: "pending", reason: PENDING_REASON }),
        [RECONCILE]: () => json({ outcome: "confirmed" }),
      });
      await store.getState().continueBackupSetup();
      expect(authorize.count("/backup/authorize/options")).toBe(1);
      expect(authorize.count("/backup/authorize/submit")).toBe(1);
      expect(authorize.count(RECONCILE)).toBe(0);

      const others = server({ "/backup/abandon": () => json({}), "/revoke/cancel": () => json({}) });
      store.setState({ enrollment: { id: "e1", state: "credential_registered", externalOutcome: "not_attempted", abandonable: true, blockReason: null } });
      await store.getState().abandonBackupSetup();
      await store.getState().cancelRemoval("cred-b", "r1");
      expect(others.count("/backup/abandon")).toBe(1);
      expect(others.count("/revoke/cancel")).toBe(1);
      expect(store.getState().isTurnkeyCheckWaiting).toBe(true); // still waiting; none of that touched it
    });
  });

  describe("account isolation and lifecycle", () => {
    it("reset() clears the wait, the published flags and the timer", async () => {
      const { store } = await waiting(120);
      expect(vi.getTimerCount()).toBe(1);
      store.getState().reset();
      expect(store.getState()).toMatchObject({ isTurnkeyCheckWaiting: false, turnkeyCheckWaitSeconds: null });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("switching accounts clears the wait; the same account again (a remount) keeps it", async () => {
      const { store } = await waiting(120);
      store.getState().bindAccount("app-user-a");
      expect(store.getState().isTurnkeyCheckWaiting).toBe(true);
      store.getState().bindAccount("app-user-b");
      expect(store.getState()).toMatchObject({ isTurnkeyCheckWaiting: false, turnkeyCheckWaitSeconds: null });
      expect(vi.getTimerCount()).toBe(0);
      const srv = server({ [REMOVAL_RECONCILE]: () => json({ outcome: "revoked" }) });
      await store.getState().checkRemoval("cred-b", "r1");
      expect(srv.count(REMOVAL_RECONCILE)).toBe(1); // account B was never gated by A's wait
    });

    it("a late deferral or 429 from the OLD account installs no wait for the new one, and starts nothing", async () => {
      for (const kind of ["removal", "confirm"] as const) {
        const store = setup();
        const late = parked();
        signing.signDigest.mockResolvedValue({ activityId: "act-1" });
        const srv = server(
          kind === "removal"
            ? { [REMOVAL_RECONCILE]: late.handler }
            : { "/backup/status": () => json({ enrollment: LOGIN_VERIFIED }), "/backup/verify-signing/options": () => json(PROOF), [CONFIRM]: late.handler },
        );
        const action = kind === "removal" ? store.getState().checkRemoval("cred-b", "r1") : store.getState().continueBackupSetup();
        await flush();
        store.getState().bindAccount("app-user-b");
        const calls = srv.calls.length;
        late.resolve(
          kind === "removal"
            ? json(deferred("pending", REMOVAL_REASON, 3600))
            : json({ error: "x", code: "rate_limited", retryable: true }, 429, { "Retry-After": "3600" }),
        );
        await action;
        expect(store.getState()).toMatchObject({ isTurnkeyCheckWaiting: false, turnkeyCheckWaitSeconds: null, setupMessage: null, removalMessage: null, setupError: null });
        expect(vi.getTimerCount()).toBe(0);
        expect(srv.calls.length).toBe(calls); // not even the trailing refresh
      }
    });

    it("a deferral and the old account's polling loop stop together: nothing is sent after the switch", async () => {
      const store = setup();
      const first = parked();
      const srv = server({ "/backup/status": () => json({ enrollment: IN_FLIGHT }), [RECONCILE]: first.handler });
      const run = store.getState().continueBackupSetup();
      await flush();
      store.getState().bindAccount("app-user-b");
      first.resolve(json({ outcome: "pending", reason: PENDING_REASON }));
      await run;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(srv.count(RECONCILE)).toBe(1);
    });
  });

  describe("Stage 2B — the retained signing proof", () => {
    const ENROLLMENT_2 = { ...LOGIN_VERIFIED, id: "e2" };
    const validDenial = (seconds = 45) => json({ error: "You're checking a bit often. Try again in a moment.", code: "rate_limited", retryable: true }, 429, { "Retry-After": String(seconds) });
    const bad400 = () => json({ error: "The authorization proof could not be verified." }, 400);

    /** A confirmation server whose answers are scripted per call (the last repeats); every signing is a fresh activity id. */
    function proofServer(steps: Array<Handler | "network">, extra: Record<string, Handler> = {}) {
      let n = 0;
      let signed = 0;
      signing.signDigest.mockImplementation(async () => ({ activityId: `act-${++signed}` }));
      const srv = server({
        "/backup/status": () => json({ enrollment: current.enrollment }),
        "/backup/verify-signing/options": () => json(PROOF),
        [CONFIRM]: () => {
          const step = steps[Math.min(n++, steps.length - 1)]!;
          if (step === "network") throw new TypeError("Failed to fetch");
          const response = step();
          // Once the server accepts the confirmation the enrollment is active, so the status read no longer returns it.
          if (response instanceof Response && response.status === 200) current.enrollment = null;
          return response;
        },
        ...extra,
      });
      return { ...srv, confirmedIds: () => srv.calls.filter((c) => c.url.endsWith(CONFIRM)).map((c) => (c.body as { activityId: string }).activityId), optionCalls: () => srv.count("/backup/verify-signing/options") };
    }
    const current: { enrollment: unknown } = { enrollment: LOGIN_VERIFIED };
    const resume = (store: ReturnType<typeof setup>) => store.getState().continueBackupSetup();

    it("a valid budget denial keeps the activity id; after expiry ONE manual action confirms with the SAME id — no options, no signing, no submit", async () => {
      current.enrollment = LOGIN_VERIFIED;
      const store = setup();
      const srv = proofServer([() => validDenial(45), () => json({ active: true })]);
      await resume(store);
      expect(store.getState()).toMatchObject({ isTurnkeyCheckWaiting: true, turnkeyCheckWaitSeconds: 45, setupError: null });
      expect(srv.confirmedIds()).toEqual(["act-1"]);
      const sends = srv.calls.length;

      await vi.advanceTimersByTimeAsync(3_600_000); // the timer clears the flag and does nothing else
      expect(srv.calls.length).toBe(sends);
      expect(signing.signDigest).toHaveBeenCalledTimes(1);
      expect(store.getState().isTurnkeyCheckWaiting).toBe(false);

      await resume(store);
      expect(srv.confirmedIds()).toEqual(["act-1", "act-1"]);
      expect(srv.optionCalls()).toBe(1);
      expect(signing.signDigest).toHaveBeenCalledTimes(1);
      expect(srv.calls.some((c) => c.url.endsWith("/submit"))).toBe(false);
    });

    it("a wait that is still running when the user resumes sends no confirmation and no ceremony, and keeps the proof", async () => {
      current.enrollment = LOGIN_VERIFIED;
      const store = setup();
      const srv = proofServer([() => validDenial(300), () => json({ active: true })]);
      await resume(store);
      await resume(store); // still waiting
      expect(srv.confirmedIds()).toEqual(["act-1"]);
      expect(srv.optionCalls()).toBe(1);
      expect(signing.signDigest).toHaveBeenCalledTimes(1);
      expect(store.getState().setupMessage).toBe(passkeyCopy.signingCheckWaitMessage(300));
      await vi.advanceTimersByTimeAsync(300_000);
      await resume(store);
      expect(srv.confirmedIds()).toEqual(["act-1", "act-1"]);
    });

    it("500, 503, a network failure and a malformed 429 each keep the proof — and the malformed 429 starts no wait", async () => {
      const failures: Array<[string, Handler | "network"]> = [
        ["500", () => json({ error: "Something went wrong. Please try again." }, 500)],
        ["503", () => json({ error: "Try again in a moment." }, 503)],
        ["network", "network"],
        ["malformed 429", () => json({ error: "Slow down." }, 429, { "Retry-After": "30" })],
      ];
      for (const [name, failure] of failures) {
        current.enrollment = LOGIN_VERIFIED;
        const store = setup();
        const srv = proofServer([failure, () => json({ active: true })]);
        await resume(store);
        expect(store.getState().setupError, name).not.toBeNull();
        expect(store.getState().isTurnkeyCheckWaiting, name).toBe(false);
        await resume(store);
        expect(srv.confirmedIds(), name).toEqual(["act-1", "act-1"]);
        expect(srv.optionCalls(), name).toBe(1);
        expect(signing.signDigest, name).toHaveBeenCalledTimes(1);
        signing.signDigest.mockReset();
      }
    });

    it("the first and second HTTP 400 keep the proof; the THIRD discards it — with the existing error, and no automatic re-signing", async () => {
      current.enrollment = LOGIN_VERIFIED;
      const store = setup();
      const srv = proofServer([bad400, bad400, bad400, () => json({ active: true })]);
      await resume(store); // 400 #1
      await resume(store); // 400 #2
      expect(srv.confirmedIds()).toEqual(["act-1", "act-1"]);
      expect(srv.optionCalls()).toBe(1);

      await resume(store); // 400 #3 — still uses the kept id, then discards it
      expect(srv.confirmedIds()).toEqual(["act-1", "act-1", "act-1"]);
      expect(store.getState().setupError).toBe("The authorization proof could not be verified.");
      expect(srv.optionCalls()).toBe(1); // nothing re-asked, nothing re-signed, nothing re-sent on its own
      expect(signing.signDigest).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(srv.confirmedIds()).toHaveLength(3);

      await resume(store); // the next EXPLICIT action: a fresh proof (after re-reading the status)
      expect(srv.optionCalls()).toBe(2);
      expect(signing.signDigest).toHaveBeenCalledTimes(2);
      expect(srv.confirmedIds()).toEqual(["act-1", "act-1", "act-1", "act-2"]);
    });

    it("inconclusive errors neither add to nor reset the 400 count: 400, 500, network, valid 429, 400 leaves the proof; the next 400 clears it", async () => {
      current.enrollment = LOGIN_VERIFIED;
      const store = setup();
      const srv = proofServer([bad400, () => json({ error: "x" }, 500), "network", () => validDenial(30), bad400, bad400, () => json({ active: true })]);
      await resume(store); // 400 (1)
      await resume(store); // 500
      await resume(store); // network
      await resume(store); // valid 429 -> wait
      await vi.advanceTimersByTimeAsync(31_000);
      await resume(store); // 400 (2)
      expect(srv.confirmedIds()).toEqual(Array(5).fill("act-1"));
      expect(srv.optionCalls()).toBe(1);
      await resume(store); // 400 (3) -> cleared
      expect(srv.confirmedIds()).toHaveLength(6);
      await resume(store);
      expect(srv.optionCalls()).toBe(2);
      expect(srv.confirmedIds()[6]).toBe("act-2");
    });

    it("failure counts never carry between proofs: a new proof starts at zero", async () => {
      current.enrollment = LOGIN_VERIFIED;
      const store = setup();
      const srv = proofServer([bad400, bad400, bad400, bad400, bad400, () => json({ active: true })]);
      await resume(store);
      await resume(store);
      await resume(store); // cleared at the third
      await resume(store); // act-2: 400 (1 of the NEW proof)
      await resume(store); // act-2 again: 400 (2)
      expect(srv.optionCalls()).toBe(2); // act-2 was kept through two 400s
      expect(srv.confirmedIds().slice(3)).toEqual(["act-2", "act-2"]);
    });

    it("success clears the proof; a status read showing the enrollment gone, different or past login_verified discards it", async () => {
      // success
      current.enrollment = LOGIN_VERIFIED;
      let store = setup();
      let srv = proofServer([() => json({ active: true })]);
      await resume(store);
      expect(srv.confirmedIds()).toEqual(["act-1"]);

      for (const next of [null, ENROLLMENT_2, { ...LOGIN_VERIFIED, state: "active" }, { ...LOGIN_VERIFIED, state: "turnkey_authenticator_created" }]) {
        current.enrollment = LOGIN_VERIFIED;
        signing.signDigest.mockReset();
        store = setup();
        srv = proofServer([() => json({ error: "x" }, 500), () => json({ active: true })]);
        await resume(store); // 500: proof kept
        current.enrollment = next;
        await store.getState().refresh(); // a current status read that disagrees
        current.enrollment = LOGIN_VERIFIED;
        await resume(store);
        expect(srv.optionCalls(), JSON.stringify(next)).toBe(2); // not reused
        expect(srv.confirmedIds(), JSON.stringify(next)).toEqual(["act-1", "act-2"]);
      }
    });

    it("a proof is never reused for a DIFFERENT enrollment, even when the status still says login_verified", async () => {
      current.enrollment = LOGIN_VERIFIED;
      const store = setup();
      const srv = proofServer([() => json({ error: "x" }, 500), () => json({ active: true })]);
      await resume(store);
      current.enrollment = ENROLLMENT_2;
      await resume(store);
      expect(srv.calls.filter((c) => c.url.endsWith(CONFIRM)).map((c) => c.body)).toEqual([
        { enrollmentId: "e1", activityId: "act-1" },
        { enrollmentId: "e2", activityId: "act-2" },
      ]);
    });

    it("explicit abandon discards the proof", async () => {
      current.enrollment = LOGIN_VERIFIED;
      const store = setup();
      const srv = proofServer([() => json({ error: "x" }, 500), () => json({ active: true })], { "/backup/abandon": () => json({}) });
      await resume(store);
      await store.getState().abandonBackupSetup();
      await resume(store);
      expect(srv.optionCalls()).toBe(2);
    });

    it("reset and an account switch discard the proof; a same-account remount keeps it; a fresh store (hard reload) has none and nothing was persisted", async () => {
      const setItem = vi.fn();
      vi.stubGlobal("localStorage", { setItem, getItem: vi.fn(), removeItem: vi.fn() });
      vi.stubGlobal("sessionStorage", { setItem, getItem: vi.fn(), removeItem: vi.fn() });
      const fail = () => json({ error: "x" }, 500);

      // remount: same account again keeps it
      current.enrollment = LOGIN_VERIFIED;
      let store = setup();
      let srv = proofServer([fail, () => json({ active: true })]);
      await resume(store);
      store.getState().bindAccount("app-user-a");
      await resume(store);
      expect(srv.optionCalls()).toBe(1);
      expect(srv.confirmedIds()).toEqual(["act-1", "act-1"]);

      // reset / switch / reload
      const cases: Array<[string, (s: ReturnType<typeof setup>) => ReturnType<typeof setup>]> = [
        ["reset", (s) => (s.getState().reset(), s.getState().bindAccount("app-user-a"), s)],
        ["switch", (s) => (s.getState().bindAccount("app-user-b"), s)],
        ["hard reload", () => setup()],
      ];
      for (const [name, act] of cases) {
        current.enrollment = LOGIN_VERIFIED;
        signing.signDigest.mockReset();
        store = setup();
        srv = proofServer([fail, () => json({ active: true })]);
        await resume(store);
        const afterwards = act(store);
        await resume(afterwards);
        expect(srv.optionCalls(), name).toBe(2);
      }
      expect(setItem).not.toHaveBeenCalled();
    });

    it("a late signing result from the OLD account installs no proof and sends nothing", async () => {
      current.enrollment = LOGIN_VERIFIED;
      const store = setup();
      let finish: (value: { activityId: string }) => void = () => {};
      const srv = proofServer([() => json({ active: true })]);
      signing.signDigest.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
      const old = resume(store);
      await flush();
      store.getState().bindAccount("app-user-b");
      finish({ activityId: "act-old" });
      await old;
      expect(srv.confirmedIds()).toEqual([]);
      await resume(store); // account B: must make its own proof
      expect(srv.optionCalls()).toBe(2);
      expect(srv.confirmedIds()).toEqual(["act-1"]);
      expect(srv.confirmedIds()).not.toContain("act-old");
    });

    it("a stale 400 from an old lifecycle cannot count against, or clear, a newer proof", async () => {
      current.enrollment = LOGIN_VERIFIED;
      const store = setup();
      const parkedConfirm = parked();
      const srv = proofServer([parkedConfirm.handler, bad400, bad400, bad400, () => json({ active: true })]);
      const old = resume(store); // generation 1: proof act-1, confirmation parked
      await flush();
      store.getState().reset();
      store.getState().bindAccount("app-user-a"); // generation 2
      await resume(store); // proof act-2; its confirmation is the scripted 400 #1 (call 2)
      parkedConfirm.resolve(bad400()); // the OLD lifecycle's 400 lands late
      await old;
      await resume(store); // 400 #2 for act-2 — kept (a counted stale 400 would have cleared it here)
      expect(srv.optionCalls()).toBe(2);
      await resume(store); // 400 #3 clears
      await resume(store);
      expect(srv.optionCalls()).toBe(3);
      expect(srv.confirmedIds().filter((id) => id === "act-2")).toHaveLength(3);
    });

    it("a cooldown that begins WHILE signing is in flight keeps the returned id and sends no confirmation until a manual retry", async () => {
      current.enrollment = LOGIN_VERIFIED;
      const store = setup();
      const srv = proofServer([() => json({ active: true })], { [REMOVAL_RECONCILE]: () => json(deferred("pending", REMOVAL_REASON, 100)) });
      signing.signDigest.mockImplementation(async () => {
        await store.getState().checkRemoval("cred-b", "r1");
        return { activityId: "act-while-waiting" };
      });
      await resume(store);
      expect(srv.confirmedIds()).toEqual([]);
      expect(store.getState().setupMessage).toBe(passkeyCopy.signingCheckWaitMessage(100));
      await vi.advanceTimersByTimeAsync(100_000);
      expect(srv.confirmedIds()).toEqual([]); // the timer never confirms
      await resume(store);
      expect(srv.confirmedIds()).toEqual(["act-while-waiting"]);
      expect(srv.optionCalls()).toBe(1);
      expect(signing.signDigest).toHaveBeenCalledTimes(1);
    });

    it("overlapping Resume actions are one: the second does nothing, so a second signing challenge can never invalidate the first", async () => {
      current.enrollment = LOGIN_VERIFIED;
      const store = setup();
      let finish: (value: { activityId: string }) => void = () => {};
      const srv = proofServer([() => json({ active: true })]);
      signing.signDigest.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
      const first = resume(store);
      await flush();
      const callsBefore = srv.calls.length;
      await resume(store);
      expect(srv.calls.length).toBe(callsBefore);
      finish({ activityId: "act-a" });
      await first;
      expect(srv.optionCalls()).toBe(1);
      expect(srv.confirmedIds()).toEqual(["act-a"]);
    });

    it("a status read that began BEFORE the proof existed cannot discard it", async () => {
      current.enrollment = LOGIN_VERIFIED;
      const store = setup();
      const olderStatus = parked();
      let statusCalls = 0;
      const confirmGate = parked();
      const srv = proofServer([confirmGate.handler, () => json({ active: true })], {
        "/backup/status": () => (statusCalls++ === 0 ? olderStatus.handler() : json({ enrollment: current.enrollment })),
      });
      const refreshing = store.getState().refresh(); // its status read is first, and parked
      await flush();
      const run = resume(store);
      await flush();
      await flush();
      expect(srv.confirmedIds()).toEqual(["act-1"]); // proof installed, confirmation in flight
      olderStatus.resolve(json({ enrollment: null })); // the old read finally lands, disagreeing
      await refreshing;
      confirmGate.resolve(json({ error: "x" }, 500));
      await run;
      await resume(store);
      expect(srv.optionCalls()).toBe(1);
      expect(srv.confirmedIds()).toEqual(["act-1", "act-1"]);
    });

    it("existing flows are untouched: no signed submit is ever resent by any of this", async () => {
      current.enrollment = LOGIN_VERIFIED;
      const store = setup();
      const srv = proofServer([bad400, () => validDenial(30), "network", () => json({ active: true })]);
      for (let i = 0; i < 4; i += 1) {
        await resume(store);
        await vi.advanceTimersByTimeAsync(31_000);
      }
      expect(srv.calls.filter((c) => c.url.endsWith("/submit")).length).toBe(0);
    });
  });

  describe("post-Stage-2 corrections — review reason and temporary wait copy", () => {
    it("LOW-1: a setup under review keeps its STORED review reason when the shared wait refuses its check — whichever endpoint started the wait", async () => {
      const starters: Array<[string, Record<string, Handler>, (store: ReturnType<typeof setup>) => Promise<void>]> = [
        ["removal reconcile", { [REMOVAL_RECONCILE]: () => json(deferred("pending", REMOVAL_REASON, 120)) }, (store) => store.getState().checkRemoval("cred-b", "r1")],
        [
          "signing confirmation",
          { "/backup/status": () => json({ enrollment: LOGIN_VERIFIED }), "/backup/verify-signing/options": () => json(PROOF), [CONFIRM]: () => json({ error: "x", code: "rate_limited", retryable: true }, 429, { "Retry-After": "120" }) },
          (store) => store.getState().continueBackupSetup(),
        ],
      ];
      for (const [name, handlers, start] of starters) {
        const store = setup();
        signing.signDigest.mockResolvedValue({ activityId: "act-1" });
        server(handlers);
        await start(store);
        expect(store.getState().isTurnkeyCheckWaiting, name).toBe(true);

        const srv = server({ "/backup/status": () => json({ enrollment: { ...BLOCKED, blockReason: "The Turnkey-side result didn't match; review needed." } }), [RECONCILE]: () => json({ outcome: "confirmed" }) });
        await store.getState().continueBackupSetup();
        expect(srv.count(RECONCILE), name).toBe(0); // no charged request
        expect(store.getState().setupError, name).toBe("The Turnkey-side result didn't match; review needed.");
        expect(store.getState().setupMessage, name).toBe(passkeyCopy.reviewCheckWaitMessage(120));
        expect(store.getState().setupMessage, name).not.toBe(passkeyCopy.backupCheckWaitMessage(120));
        expect(store.getState().enrollment?.state, name).toBe("blocked");
      }
    });

    it("LOW-1: a review with NO stored reason falls back to the existing generic review text, never to a pending message", async () => {
      const { store } = await waiting(120);
      server({ "/backup/status": () => json({ enrollment: { ...BLOCKED, blockReason: null } }) });
      await store.getState().continueBackupSetup();
      expect(store.getState().setupError).toBe("This setup needs manual review.");
      expect(store.getState().setupMessage).toBe(passkeyCopy.reviewCheckWaitMessage(120));
    });

    it("an in-flight setup refused by the wait is still described as sent-but-unconfirmed (not as a review)", async () => {
      const { store } = await waiting(120);
      server({ "/backup/status": () => json({ enrollment: IN_FLIGHT }) });
      await store.getState().continueBackupSetup();
      expect(store.getState().setupError).toBeNull();
      expect(store.getState().setupMessage).toBe(passkeyCopy.backupCheckWaitMessage(120));
    });

    it("wait copy is dropped when the wait ends — and ONLY the wait copy: the review reason, the pending removal text and the proof stay", async () => {
      // setup under review
      const { store } = await waiting(120);
      server({ "/backup/status": () => json({ enrollment: { ...BLOCKED, blockReason: "needs review" } }) });
      await store.getState().continueBackupSetup();
      expect(store.getState().setupMessageIsWait).toBe(true);
      const removalBefore = store.getState().removalMessage;
      expect(removalBefore?.waitBase).toBe(REMOVAL_REASON);

      const before = vi.mocked(fetch).mock.calls.length;
      await vi.advanceTimersByTimeAsync(119_000);
      expect(store.getState().setupMessage).toBe(passkeyCopy.reviewCheckWaitMessage(120)); // still active
      await vi.advanceTimersByTimeAsync(2_000);
      const state = store.getState();
      expect(state).toMatchObject({ isTurnkeyCheckWaiting: false, setupMessage: null, setupMessageIsWait: false, setupError: "needs review" });
      expect(state.removalMessage).toEqual({ credentialId: "cred-b", text: REMOVAL_REASON }); // base kept, wait sentence gone
      expect(state.removalMessage!.text).toContain(passkeyCopy.MAY_STILL_AUTHORIZE_NOTE);
      expect(state.enrollment?.state).toBe("blocked");
      expect(vi.mocked(fetch).mock.calls.length).toBe(before); // nothing fetched, nothing signed
      expect(signing.signDigest).not.toHaveBeenCalled();
    });

    it("ordinary (non-wait) messages and genuine errors survive expiry untouched", async () => {
      const store = setup();
      server({ [REMOVAL_RECONCILE]: () => json(deferred("pending", REMOVAL_REASON, 60)) });
      await store.getState().checkRemoval("cred-b", "r1");
      store.setState({ setupMessage: "Your authorization was sent but isn't confirmed yet.", setupMessageIsWait: false, setupError: "Real error", removalError: "Real removal error" });
      await vi.advanceTimersByTimeAsync(61_000);
      expect(store.getState()).toMatchObject({ setupMessage: "Your authorization was sent but isn't confirmed yet.", setupError: "Real error", removalError: "Real removal error" });
    });

    it("a later message replaces wait copy and is not mistaken for it", async () => {
      const { store } = await waiting(120);
      server({ "/backup/status": () => json({ enrollment: IN_FLIGHT }) });
      await store.getState().continueBackupSetup();
      expect(store.getState().setupMessageIsWait).toBe(true);
      await vi.advanceTimersByTimeAsync(121_000);
      server({ "/backup/status": () => json({ enrollment: IN_FLIGHT }), [RECONCILE]: () => json({ outcome: "pending", reason: PENDING_REASON }) });
      const run = store.getState().continueBackupSetup();
      await vi.advanceTimersByTimeAsync(20_000);
      await run;
      expect(store.getState()).toMatchObject({ setupMessage: PENDING_REASON, setupMessageIsWait: false });
    });

    it("an extended wait keeps its copy: the older, shorter timer cannot remove it; a long wait (86 400 s) keeps it for the whole day", async () => {
      const store = setup();
      const removal = parked();
      const backup = parked();
      server({ "/backup/status": () => json({ enrollment: IN_FLIGHT }), [REMOVAL_RECONCILE]: removal.handler, [RECONCILE]: backup.handler });
      const a = store.getState().checkRemoval("cred-b", "r1");
      const b = store.getState().continueBackupSetup();
      await flush();
      removal.resolve(json(deferred("pending", REMOVAL_REASON, 60)));
      await flush();
      backup.resolve(json(deferred("pending", PENDING_REASON, 86_400)));
      await Promise.all([a, b]);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(store.getState().setupMessage).toBe(passkeyCopy.backupCheckWaitMessage(86_400));
      await vi.advanceTimersByTimeAsync(86_000_000);
      expect(store.getState().setupMessage).not.toBeNull();
      await vi.advanceTimersByTimeAsync(400_000);
      expect(store.getState()).toMatchObject({ setupMessage: null, isTurnkeyCheckWaiting: false });
    });

    it("an account switch leaves no waiting copy for the next account", async () => {
      const { store } = await waiting(120);
      server({ "/backup/status": () => json({ enrollment: IN_FLIGHT }) });
      await store.getState().continueBackupSetup();
      store.getState().bindAccount("app-user-b");
      expect(store.getState()).toMatchObject({ setupMessage: null, setupMessageIsWait: false, removalMessage: null, isTurnkeyCheckWaiting: false });
      await vi.advanceTimersByTimeAsync(200_000);
      expect(store.getState()).toMatchObject({ setupMessage: null, removalMessage: null });
    });

    it("ending a wait does not touch the retained signing proof: the next manual action confirms with the same activity id", async () => {
      const store = setup();
      signing.signDigest.mockResolvedValue({ activityId: "act-1" });
      let confirmCalls = 0;
      const srv = server({
        "/backup/status": () => json({ enrollment: confirmCalls < 2 ? LOGIN_VERIFIED : null }),
        "/backup/verify-signing/options": () => json(PROOF),
        [CONFIRM]: () => (confirmCalls++ === 0 ? json({ error: "x", code: "rate_limited", retryable: true }, 429, { "Retry-After": "30" }) : json({ active: true })),
      });
      await store.getState().continueBackupSetup();
      await vi.advanceTimersByTimeAsync(31_000);
      expect(store.getState().setupMessage).toBeNull();
      await store.getState().continueBackupSetup();
      expect(srv.calls.filter((c) => c.url.endsWith(CONFIRM)).map((c) => (c.body as { activityId: string }).activityId)).toEqual(["act-1", "act-1"]);
      expect(srv.count("/backup/verify-signing/options")).toBe(1);
      expect(signing.signDigest).toHaveBeenCalledTimes(1);
    });

    it("the original removal submit still works during a wait, and its wait copy also ends with the wait", async () => {
      const { store } = await waiting(120);
      signing.stampDelete.mockResolvedValue({ stamped: true });
      server({
        "/revoke/options": () => json({ attemptId: "r2", activity: {}, rpId: "localhost", authorizingCredentialId: "cred-a" }),
        "/revoke/submit": () => json({ outcome: "pending", reason: REMOVAL_REASON }),
      });
      await store.getState().removePasskey("cred-c");
      expect(store.getState().removalMessage?.text).toContain("You can check again");
      await vi.advanceTimersByTimeAsync(121_000);
      expect(store.getState().removalMessage).toEqual({ credentialId: "cred-c", text: REMOVAL_REASON });
    });
  });

  describe("chargedPost is the only door", () => {
    it("the three charged endpoints are posted only through chargedPost, which also refuses any other URL", async () => {
      const { readFileSync } = await import("node:fs");
      const source = readFileSync("lib/stores/real-passkeys-store.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const endpoint of ["authorize/reconcile", "verify-signing/confirm", "revoke/reconcile"]) {
        const sites = [...source.matchAll(new RegExp(`(?:post|chargedPost)(?:<[^>]*>)?\\(\\s*[^\\n]*${endpoint.replace("/", "\\/")}`, "g"))].map((m) => m[0]);
        expect(sites.length, endpoint).toBeGreaterThan(0);
        for (const site of sites) expect(site, endpoint).toMatch(/chargedPost/);
      }
      expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    });
  });
});

describe("passkey wait copy (3A-3 Stage 2A)", () => {
  it("formats waits rounding UP, never as a countdown", () => {
    const f = passkeyCopy.formatWaitDuration;
    expect([f(1), f(60), f(61), f(120), f(3599), f(3600), f(3601), f(86_400)]).toEqual(["a minute", "a minute", "2 minutes", "2 minutes", "60 minutes", "an hour", "2 hours", "24 hours"]);
    expect([f(0), f(-1), f(Number.NaN)]).toEqual(["a little while", "a little while", "a little while"]);
  });

  it("is plain language: no provider jargon, no automatic retry, no success or failure claim — and the removal warning survives", () => {
    const messages = [
      passkeyCopy.backupCheckWaitMessage(300),
      passkeyCopy.reviewCheckWaitMessage(300),
      passkeyCopy.signingCheckWaitMessage(300),
      passkeyCopy.removalCheckWaitMessage(undefined, 300),
      passkeyCopy.removalCheckWaitMessage("Removal submitted, not yet confirmed. This passkey may still be able to authorize this account until removal is confirmed.", 300),
    ];
    for (const message of messages) {
      expect(message).toContain("5 minutes");
      expect(message).not.toMatch(/turnkey|bucket|budget|gas|rpc|chain|automatic|we.ll retry|retrying|failed|error|successfully|has been removed|(?:has been|was) confirmed/i);
    }
    expect(messages[3]).toContain(passkeyCopy.MAY_STILL_AUTHORIZE_NOTE);
    expect(messages[4]).toContain("may still be able to authorize");
    expect(messages[2]).toMatch(/may be asked to approve/);
  });
});
