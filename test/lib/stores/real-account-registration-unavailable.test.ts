import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const webauthn = vi.hoisted(() => ({
  performLoginCeremony: vi.fn(),
  performRegistrationCeremony: vi.fn(),
  signalAccountLabel: vi.fn(),
}));

vi.mock("@/lib/real/account/webauthn-client", () => ({
  performLoginCeremony: webauthn.performLoginCeremony,
  performRegistrationCeremony: webauthn.performRegistrationCeremony,
  signalAccountLabel: webauthn.signalAccountLabel,
  isWebAuthnCancellation: () => false,
}));

const { createRealAccountStore } = await import("@/lib/stores/real-account-store");

/**
 * Milestone 3C-1 client compatibility: the existing register() already shows the
 * server's own message for a non-OK options answer. A 503 from the global
 * registration admission must therefore surface as that plain message, start NO
 * passkey ceremony, call nothing else, and never be retried by the client. No
 * client code changed for this.
 */
const MESSAGE = "We can't open new accounts right now. Please try again later.";

beforeEach(() => {
  webauthn.performRegistrationCeremony.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ error: MESSAGE, code: "registration_unavailable" }), { status: 503, headers: { "content-type": "application/json", "Retry-After": "1800" } })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("register() when the registration pool is used up (503)", () => {
  it("shows the server's plain message, makes exactly one request, and never starts a passkey ceremony", async () => {
    const store = createRealAccountStore();
    await store.getState().register();
    expect(store.getState()).toMatchObject({ status: "error", error: MESSAGE, account: null });
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual(["/api/real/account/register/options"]);
    expect(webauthn.performRegistrationCeremony).not.toHaveBeenCalled();
  });

  it("does not retry on its own — not after the Retry-After, not ever", async () => {
    vi.useFakeTimers();
    const store = createRealAccountStore();
    await store.getState().register();
    await vi.advanceTimersByTimeAsync(2 * 3600 * 1000);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(store.getState().status).toBe("error");
  });

  it("the message has no jargon, no number, and no countdown", () => {
    expect(MESSAGE).not.toMatch(/\d|rate|limit|quota|429|503|passkey|retry/i);
  });
});
