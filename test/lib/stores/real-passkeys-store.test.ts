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

vi.mock("@/lib/real/account/webauthn-client", () => ({
  performLoginCeremony: ceremonies.performLoginCeremony,
  performRegistrationCeremony: ceremonies.performRegistrationCeremony,
  isWebAuthnCancellation: (error: unknown) => Boolean(error && typeof error === "object" && "name" in error && (error as { name: string }).name === "NotAllowedError"),
}));

const { createRealPasskeysStore } = await import("@/lib/stores/real-passkeys-store");

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
