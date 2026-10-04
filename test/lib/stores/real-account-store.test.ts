import { afterEach, describe, expect, it, vi } from "vitest";

const ceremonies = vi.hoisted(() => ({
  performLoginCeremony: vi.fn(),
  performRegistrationCeremony: vi.fn(),
}));

vi.mock("@/lib/real/account/webauthn-client", () => ({
  performLoginCeremony: ceremonies.performLoginCeremony,
  performRegistrationCeremony: ceremonies.performRegistrationCeremony,
  isWebAuthnCancellation: () => false,
  signalAccountLabel: () => {},
}));

const { ALREADY_SIGNED_OUT_MESSAGE, SIGN_OUT_EVERYWHERE_FAILED_MESSAGE, createRealAccountStore } = await import("@/lib/stores/real-account-store");

const ACCOUNT_A = { appUserId: "app-user-a", ownerAddress: "0xowner-a", safeAddress: "0xsafe-a" };
const ACCOUNT_B = { appUserId: "app-user-b", ownerAddress: "0xowner-b", safeAddress: "0xsafe-b" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function signedIn() {
  const store = createRealAccountStore();
  store.setState({ account: ACCOUNT_A, status: "ready", error: null });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
  ceremonies.performLoginCeremony.mockReset();
});

describe("real-account-store — Sign out everywhere (S4, F6-A)", () => {
  it("sends DELETE /api/real/session and shows signed-out only once the server confirms", async () => {
    const fetchMock = vi.fn(async () => json({ authenticated: false, signedOutEverywhere: true }));
    vi.stubGlobal("fetch", fetchMock);
    const store = signedIn();
    const pending = store.getState().logout();
    expect(store.getState()).toMatchObject({ status: "signing-out", account: ACCOUNT_A });
    await pending;
    expect(fetchMock).toHaveBeenCalledWith("/api/real/session", { method: "DELETE" });
    expect(store.getState()).toMatchObject({ account: null, status: "signed-out", error: null });
  });

  it("a server failure is never presented as a successful sign-out: the account stays, with an honest error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Something went wrong. Please try again." }, 500)));
    const store = signedIn();
    await store.getState().logout();
    expect(store.getState()).toMatchObject({ account: ACCOUNT_A, status: "ready", error: SIGN_OUT_EVERYWHERE_FAILED_MESSAGE });
  });

  it("a network failure likewise keeps the account and says so", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    const store = signedIn();
    await store.getState().logout();
    expect(store.getState()).toMatchObject({ account: ACCOUNT_A, status: "ready", error: SIGN_OUT_EVERYWHERE_FAILED_MESSAGE });
  });

  it("401 (this browser's session was already dead): signed out locally, with a message that other devices were NOT signed out from here", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Not authenticated." }, 401)));
    const store = signedIn();
    await store.getState().logout();
    expect(store.getState()).toMatchObject({ account: null, status: "signed-out", error: ALREADY_SIGNED_OUT_MESSAGE });
  });
});

describe("real-account-store — stale session responses (S4, F6-E)", () => {
  it("a session check that resolves after sign-out can't bring the old account back", async () => {
    let answerCheck: (r: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return Promise.resolve(json({ authenticated: false, signedOutEverywhere: true }));
      return new Promise<Response>((resolve) => (answerCheck = resolve));
    }));
    const store = signedIn();
    const check = store.getState().checkSession();
    await store.getState().logout();
    answerCheck(json({ authenticated: true, ...ACCOUNT_A }));
    await check;
    expect(store.getState()).toMatchObject({ account: null, status: "signed-out" });
  });

  it("an account-A session check resolving after an account-B login never overwrites B", async () => {
    let answerCheck: (r: Response) => void = () => {};
    ceremonies.performLoginCeremony.mockResolvedValue({ id: "cred-b" });
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url === "/api/real/session") return new Promise<Response>((resolve) => (answerCheck = resolve));
      if (url.endsWith("/login/options")) return Promise.resolve(json({ optionsJSON: { challenge: "c" } }));
      if (url.endsWith("/login/verify")) return Promise.resolve(json(ACCOUNT_B));
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    const store = createRealAccountStore();
    const check = store.getState().checkSession();
    await store.getState().login();
    expect(store.getState().account).toEqual(ACCOUNT_B);
    answerCheck(json({ authenticated: true, ...ACCOUNT_A }));
    await check;
    expect(store.getState()).toMatchObject({ account: ACCOUNT_B, status: "ready" });
  });

  it("a sign-out result landing after a newer login is dropped", async () => {
    let answerDelete: (r: Response) => void = () => {};
    ceremonies.performLoginCeremony.mockResolvedValue({ id: "cred-b" });
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Promise<Response>((resolve) => (answerDelete = resolve));
      if (url.endsWith("/login/options")) return Promise.resolve(json({ optionsJSON: { challenge: "c" } }));
      if (url.endsWith("/login/verify")) return Promise.resolve(json(ACCOUNT_B));
      throw new Error(`Unexpected fetch: ${url}`);
    }));
    const store = signedIn();
    const logout = store.getState().logout();
    await store.getState().login();
    answerDelete(json({ error: "boom" }, 500));
    await logout;
    expect(store.getState()).toMatchObject({ account: ACCOUNT_B, status: "ready", error: null });
  });
});
