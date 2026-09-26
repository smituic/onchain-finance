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
