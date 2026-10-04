import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const webauthn = vi.hoisted(() => ({
  performLoginCeremony: vi.fn(),
  performRegistrationCeremony: vi.fn(),
  signalAccountLabel: vi.fn(),
  cancelled: { value: false },
}));

vi.mock("@/lib/real/account/webauthn-client", () => ({
  performLoginCeremony: webauthn.performLoginCeremony,
  performRegistrationCeremony: webauthn.performRegistrationCeremony,
  signalAccountLabel: webauthn.signalAccountLabel,
  isWebAuthnCancellation: () => webauthn.cancelled.value,
}));

const { createRealAccountStore } = await import("@/lib/stores/real-account-store");

/**
 * Account Handles in the client store: the handle/display name arrive with
 * the account response, claiming is options -> passkey -> claim, and the
 * passkey relabel is attempted only AFTER a successful server answer and can
 * never change an outcome.
 */
const ACCOUNT = { appUserId: "app-user-1", ownerAddress: "0xowner", safeAddress: "0xsafe" };
const OPTIONS = { challenge: "challenge-1", rpId: "localhost", allowCredentials: [{ id: "credential-1", type: "public-key" }], userVerification: "required" };
const ASSERTION = { id: "credential-1", rawId: "credential-1", type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: "c", authenticatorData: "a", signature: "s", userHandle: "user-handle-1" } };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
function stubFetch(handler: (call: Call) => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      return handler(call);
    }),
  );
}

function signedIn(extra: Record<string, unknown> = {}) {
  const store = createRealAccountStore();
  store.setState({ account: { ...ACCOUNT, ...extra }, status: "ready", error: null });
  return store;
}

beforeEach(() => {
  calls = [];
  webauthn.cancelled.value = false;
  webauthn.performLoginCeremony.mockReset().mockResolvedValue(ASSERTION);
  webauthn.signalAccountLabel.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("account responses carry optional handle / displayName", () => {
  it("checkSession: a response with no handle keeps the account exactly its old shape", async () => {
    stubFetch(() => json({ authenticated: true, ...ACCOUNT, handle: null, displayName: null }));
    const store = createRealAccountStore();
    await store.getState().checkSession();
    expect(store.getState().account).toEqual(ACCOUNT);
  });

  it("checkSession: an older server response without the fields at all is fine", async () => {
    stubFetch(() => json({ authenticated: true, ...ACCOUNT }));
    const store = createRealAccountStore();
    await store.getState().checkSession();
    expect(store.getState()).toMatchObject({ account: ACCOUNT, status: "ready" });
  });

  it("checkSession: picks up the handle and display name — and never signals (no credential was just verified)", async () => {
    stubFetch(() => json({ authenticated: true, ...ACCOUNT, handle: "smit", displayName: "Smit Patel" }));
    const store = createRealAccountStore();
    await store.getState().checkSession();
    expect(store.getState().account).toEqual({ ...ACCOUNT, handle: "smit", displayName: "Smit Patel" });
    expect(webauthn.signalAccountLabel).not.toHaveBeenCalled();
  });

  it("only public profile fields are persisted — nothing new beyond handle/displayName", async () => {
    stubFetch(() => json({ authenticated: true, ...ACCOUNT, handle: "smit", displayName: "Smit Patel", secret: "x" }));
    const store = createRealAccountStore();
    await store.getState().checkSession();
    expect(Object.keys(store.getState().account!).sort()).toEqual(["appUserId", "displayName", "handle", "ownerAddress", "safeAddress"]);
  });
});

describe("login — the relabel signal", () => {
  const loginFetch = (account: Record<string, unknown>, verifyStatus = 200) =>
    stubFetch((call) => (call.url.endsWith("/login/options") ? json({ optionsJSON: OPTIONS }) : json(verifyStatus === 200 ? account : { error: "Login could not be verified." }, verifyStatus)));

  it("after a SUCCESSFUL login with a handle: signals once, with the just-verified credential's own userHandle and the server's values", async () => {
    loginFetch({ ...ACCOUNT, handle: "smit", displayName: "Smit Patel" });
    const store = createRealAccountStore();
    await store.getState().login();
    expect(store.getState()).toMatchObject({ status: "ready", account: { ...ACCOUNT, handle: "smit", displayName: "Smit Patel" } });
    expect(webauthn.signalAccountLabel).toHaveBeenCalledTimes(1);
    expect(webauthn.signalAccountLabel).toHaveBeenCalledWith({ rpId: "localhost", userHandle: "user-handle-1", handle: "smit", displayName: "Smit Patel" });
  });

  it("an existing account with NO handle logs in exactly as before (the helper is handed a null handle and does nothing)", async () => {
    loginFetch({ ...ACCOUNT, handle: null, displayName: null });
    const store = createRealAccountStore();
    await store.getState().login();
    expect(store.getState()).toMatchObject({ status: "ready", account: ACCOUNT, error: null });
    expect(webauthn.signalAccountLabel.mock.calls.every(([input]) => !input.handle)).toBe(true);
  });

  it("a FAILED login never signals", async () => {
    loginFetch({}, 401);
    const store = createRealAccountStore();
    await store.getState().login();
    expect(store.getState().status).toBe("error");
    expect(webauthn.signalAccountLabel).not.toHaveBeenCalled();
  });

  it("the signal can never change the login outcome — even if the helper itself throws", async () => {
    loginFetch({ ...ACCOUNT, handle: "smit", displayName: null });
    // The real helper never throws (see signal-account-label.test.ts); this proves the caller needs nothing from it.
    webauthn.signalAccountLabel.mockReturnValue(undefined);
    const store = createRealAccountStore();
    await store.getState().login();
    expect(store.getState()).toMatchObject({ status: "ready", error: null, account: { ...ACCOUNT, handle: "smit" } });
  });

  it("registration never signals (a brand-new account has no handle)", async () => {
    webauthn.performRegistrationCeremony.mockResolvedValue({ id: "credential-1", response: {} });
    stubFetch((call) => (call.url.endsWith("/register/options") ? json({ optionsJSON: { challenge: "c" } }) : json({ ...ACCOUNT, handle: null, displayName: null })));
    const store = createRealAccountStore();
    await store.getState().register();
    expect(store.getState()).toMatchObject({ status: "ready", account: ACCOUNT });
    expect(webauthn.signalAccountLabel).not.toHaveBeenCalled();
  });
});

describe("claimHandle", () => {
  const happy = () =>
    stubFetch((call) => {
      if (call.url.endsWith("/handle/options")) return json({ handle: "smit", optionsJSON: OPTIONS });
      if (call.url.endsWith("/handle/claim")) return json({ handle: "smit", displayName: null });
      throw new Error(`unexpected ${call.url}`);
    });

  it("options -> passkey -> claim; the canonical handle is what is sent; the account gains it; status is untouched", async () => {
    happy();
    const store = signedIn();
    const pending = store.getState().claimHandle(" @Smit ");
    expect(store.getState().profileBusy).toBe(true);
    expect(await pending).toBe(true);
    expect(calls.map((c) => [c.method, c.url])).toEqual([["POST", "/api/real/account/handle/options"], ["POST", "/api/real/account/handle/claim"]]);
    expect(calls[0]!.body).toEqual({ handle: "smit" });
    expect(calls[1]!.body).toEqual({ handle: "smit", response: ASSERTION });
    expect(webauthn.performLoginCeremony).toHaveBeenCalledWith(OPTIONS);
    expect(store.getState()).toMatchObject({ account: { ...ACCOUNT, handle: "smit" }, status: "ready", profileBusy: false, profileError: null });
  });

  it("signals only AFTER the server confirmed the claim, with that passkey's userHandle and the returned handle", async () => {
    const order: string[] = [];
    stubFetch((call) => {
      order.push(call.url);
      return call.url.endsWith("/handle/options") ? json({ handle: "smit", optionsJSON: OPTIONS }) : json({ handle: "smit", displayName: "Smit Patel" });
    });
    webauthn.signalAccountLabel.mockImplementation(() => void order.push("signal"));
    const store = signedIn({ displayName: "Smit Patel" });
    await store.getState().claimHandle("smit");
    expect(order).toEqual(["/api/real/account/handle/options", "/api/real/account/handle/claim", "signal"]);
    expect(webauthn.signalAccountLabel).toHaveBeenCalledWith({ rpId: "localhost", userHandle: "user-handle-1", handle: "smit", displayName: "Smit Patel" });
  });

  it("an invalid handle is refused locally — no request, no passkey prompt", async () => {
    stubFetch(() => json({}));
    const store = signedIn();
    for (const bad of ["ab", "_smit", "0xabc", "sm\u0131t"]) expect(await store.getState().claimHandle(bad)).toBe(false);
    expect(calls).toHaveLength(0);
    expect(webauthn.performLoginCeremony).not.toHaveBeenCalled();
    expect(store.getState().profileError).toBeTruthy();
    expect(store.getState().account).toEqual(ACCOUNT);
  });

  it("unavailable at options: the server's message is shown; no passkey prompt, no claim, no signal", async () => {
    stubFetch(() => json({ error: "That name isn't available. Try another." }, 409));
    const store = signedIn();
    expect(await store.getState().claimHandle("smit")).toBe(false);
    expect(store.getState()).toMatchObject({ profileBusy: false, profileError: "That name isn't available. Try another.", account: ACCOUNT });
    expect(webauthn.performLoginCeremony).not.toHaveBeenCalled();
    expect(webauthn.signalAccountLabel).not.toHaveBeenCalled();
  });

  it("claim refused (lost race / failed confirmation): the account gains nothing and nothing is signalled", async () => {
    for (const [status, error] of [[409, "That name isn't available. Try another."], [403, "Couldn't confirm it's you. Try again."], [500, "Something went wrong. Please try again."]] as const) {
      stubFetch((call) => (call.url.endsWith("/handle/options") ? json({ handle: "smit", optionsJSON: OPTIONS }) : json({ error }, status)));
      const store = signedIn();
      expect(await store.getState().claimHandle("smit")).toBe(false);
      expect(store.getState()).toMatchObject({ profileBusy: false, profileError: error, account: ACCOUNT });
    }
    expect(webauthn.signalAccountLabel).not.toHaveBeenCalled();
  });

  it("dismissing the passkey prompt is not an error; nothing was claimed", async () => {
    stubFetch(() => json({ handle: "smit", optionsJSON: OPTIONS }));
    webauthn.cancelled.value = true;
    webauthn.performLoginCeremony.mockRejectedValue(Object.assign(new Error("cancelled"), { name: "NotAllowedError" }));
    const store = signedIn();
    expect(await store.getState().claimHandle("smit")).toBe(false);
    expect(store.getState()).toMatchObject({ profileBusy: false, profileError: null, account: ACCOUNT });
    expect(calls).toHaveLength(1);
  });

  it("LOST RESPONSE: the claim's answer never arrives; the retry finds the account already owns that handle and treats it as success", async () => {
    let attempt = 0;
    stubFetch((call) => {
      if (call.url.endsWith("/handle/options")) {
        attempt += 1;
        return attempt === 1 ? json({ handle: "smit", optionsJSON: OPTIONS }) : json({ error: "This account already has a name, and it can't be changed.", handle: "smit" }, 409);
      }
      throw new TypeError("Failed to fetch"); // the claim landed server-side, the answer was lost
    });
    const store = signedIn();
    expect(await store.getState().claimHandle("smit")).toBe(false);
    expect(store.getState()).toMatchObject({ profileBusy: false, account: ACCOUNT });
    expect(store.getState().profileError).toBeTruthy();
    expect(await store.getState().claimHandle("smit")).toBe(true);
    expect(store.getState()).toMatchObject({ profileBusy: false, profileError: null, account: { ...ACCOUNT, handle: "smit" } });
  });

  it("already has a DIFFERENT handle: it is shown, with the server's message — never presented as the new name", async () => {
    stubFetch(() => json({ error: "This account already has a name, and it can't be changed.", handle: "first" }, 409));
    const store = signedIn();
    expect(await store.getState().claimHandle("second")).toBe(false);
    expect(store.getState()).toMatchObject({ account: { ...ACCOUNT, handle: "first" }, profileError: "This account already has a name, and it can't be changed." });
  });

  it("a sign-out (or account switch) during the claim: the late result is never written into the new state", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    stubFetch(async (call) => {
      if (call.url.endsWith("/handle/options")) return json({ handle: "smit", optionsJSON: OPTIONS });
      if (call.url.endsWith("/handle/claim")) {
        await gate;
        return json({ handle: "smit", displayName: null });
      }
      return json({ authenticated: false, signedOutEverywhere: true });
    });
    const store = signedIn();
    const pending = store.getState().claimHandle("smit");
    await vi.waitFor(() => expect(calls.some((c) => c.url.endsWith("/handle/claim"))).toBe(true));
    await store.getState().logout();
    release();
    expect(await pending).toBe(false);
    expect(store.getState()).toMatchObject({ account: null, status: "signed-out", profileBusy: false });
  });

  it("signed out: does nothing", async () => {
    stubFetch(() => json({}));
    const store = createRealAccountStore();
    expect(await store.getState().claimHandle("smit")).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("saveDisplayName", () => {
  it("PATCHes the validated name with the session alone — no passkey prompt — and updates the account", async () => {
    stubFetch(() => json({ handle: null, displayName: "Zo\u00EB" }));
    const store = signedIn();
    expect(await store.getState().saveDisplayName("  Zoe\u0308 ")).toBe(true);
    expect(calls).toEqual([{ url: "/api/real/account/profile", method: "PATCH", body: { displayName: "Zo\u00EB" } }]);
    expect(webauthn.performLoginCeremony).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ account: { ...ACCOUNT, displayName: "Zo\u00EB" }, profileBusy: false, profileError: null });
  });

  it("an empty name clears it (sent as null) and the account returns to its bare shape", async () => {
    stubFetch(() => json({ handle: null, displayName: null }));
    const store = signedIn({ displayName: "Old" });
    expect(await store.getState().saveDisplayName("   ")).toBe(true);
    expect(calls[0]!.body).toEqual({ displayName: null });
    expect(store.getState().account).toEqual(ACCOUNT);
  });

  it("an invalid name is refused locally; a server failure keeps the old name and says so", async () => {
    stubFetch(() => json({ error: "Something went wrong. Please try again." }, 500));
    const store = signedIn({ displayName: "Old" });
    expect(await store.getState().saveDisplayName("a".repeat(41))).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await store.getState().saveDisplayName("New")).toBe(false);
    expect(store.getState()).toMatchObject({ account: { ...ACCOUNT, displayName: "Old" }, profileBusy: false, profileError: "Something went wrong. Please try again." });
  });

  it("never changes the handle", async () => {
    stubFetch(() => json({ handle: "smit", displayName: "New" }));
    const store = signedIn({ handle: "smit" });
    await store.getState().saveDisplayName("New");
    expect(store.getState().account).toEqual({ ...ACCOUNT, handle: "smit", displayName: "New" });
  });
});
