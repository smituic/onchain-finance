import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSetup } from "@/components/real/account-setup";
import { SIGN_OUT_EVERYWHERE_FAILED_MESSAGE, useRealAccountStore } from "@/lib/stores/real-account-store";
import { useRealPasskeysStore } from "@/lib/stores/real-passkeys-store";

const ACCOUNT_A = { appUserId: "app-user-a", ownerAddress: "0xowner-a", safeAddress: "0xsafe-a" };
const ACCOUNT_B = { appUserId: "app-user-b", ownerAddress: "0xowner-b", safeAddress: "0xsafe-b" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function row(credentialId: string, displayName: string) {
  return { credentialId, role: "primary", displayName, status: "active", credentialDeviceType: null, credentialBackedUp: null, createdAt: "2026-01-01T00:00:00.000Z", isCurrentSession: true, canAuthorizeRemovals: true, removal: null };
}

/** The server's view: whichever account the cookie currently names, and how DELETE answers. */
const server = { account: ACCOUNT_A as typeof ACCOUNT_A | null, deleteStatus: 200, passkeysDelay: null as Promise<void> | null };

beforeEach(() => {
  server.account = ACCOUNT_A;
  server.deleteStatus = 200;
  server.passkeysDelay = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/real/session" && init?.method === "DELETE") {
        if (server.deleteStatus !== 200) return json({ error: "Something went wrong. Please try again." }, server.deleteStatus);
        server.account = null;
        return json({ authenticated: false, signedOutEverywhere: true });
      }
      if (url === "/api/real/session") return json(server.account ? { authenticated: true, ...server.account } : { authenticated: false });
      if (url.endsWith("/api/real/account/passkeys")) {
        const owner = server.account;
        if (server.passkeysDelay) await server.passkeysDelay;
        return json({ passkeys: owner ? [row(`cred-${owner.appUserId}`, `Key of ${owner.appUserId}`)] : [] });
      }
      if (url.endsWith("/backup/status")) return json({ enrollment: null });
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
  useRealPasskeysStore.getState().reset();
  useRealAccountStore.setState({ account: ACCOUNT_A, status: "idle", error: null, hasHydrated: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AccountSetup — Sign out everywhere (S4)", () => {
  it("labels the action as account-wide — never a bare 'Sign out'", async () => {
    render(<AccountSetup />);
    expect(await screen.findByRole("button", { name: "Sign out everywhere" })).toBeTruthy();
    expect(screen.getByText(/on this device and on every other device/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("success: returns to create/restore, and the passkey list is cleared with the account", async () => {
    render(<AccountSetup />);
    expect(await screen.findByText(/Key of app-user-a/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out everywhere" }));
    expect(await screen.findByRole("button", { name: "Create your account" })).toBeTruthy();
    expect(useRealAccountStore.getState().account).toBeNull();
    expect(useRealPasskeysStore.getState().passkeys).toEqual([]);
  });

  it("failure: stays signed in and says so — never shows the signed-out screen", async () => {
    server.deleteStatus = 500;
    render(<AccountSetup />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out everywhere" }));
    expect(await screen.findByText(SIGN_OUT_EVERYWHERE_FAILED_MESSAGE)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out everywhere" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create your account" })).toBeNull();
    expect(useRealAccountStore.getState().account).toEqual(ACCOUNT_A);
  });
});

describe("AccountSetup — account switch cleanup (S4)", () => {
  it("switching A -> B shows only B's passkeys, and A's late list response never reappears", async () => {
    render(<AccountSetup />);
    expect(await screen.findByText(/Key of app-user-a/)).toBeTruthy();

    // A refresh for A is in flight (held) when the account changes to B.
    let release: () => void = () => {};
    server.passkeysDelay = new Promise<void>((resolve) => (release = resolve));
    const lateA = useRealPasskeysStore.getState().refresh();
    server.passkeysDelay = null;

    server.account = ACCOUNT_B;
    act(() => {
      useRealAccountStore.setState({ account: ACCOUNT_B, status: "ready" });
    });
    await waitFor(() => expect(screen.getByText(/Key of app-user-b/)).toBeTruthy());
    expect(screen.queryByText(/Key of app-user-a/)).toBeNull();

    await act(async () => {
      release();
      await lateA;
    });
    expect(screen.queryByText(/Key of app-user-a/)).toBeNull();
    expect(useRealPasskeysStore.getState().passkeys.map((p) => p.credentialId)).toEqual(["cred-app-user-b"]);
  });
});
