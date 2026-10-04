import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const webauthn = vi.hoisted(() => ({ performLoginCeremony: vi.fn(), signalAccountLabel: vi.fn() }));
vi.mock("@/lib/real/account/webauthn-client", () => ({
  performLoginCeremony: webauthn.performLoginCeremony,
  performRegistrationCeremony: vi.fn(),
  signalAccountLabel: webauthn.signalAccountLabel,
  isWebAuthnCancellation: () => false,
}));

const { AccountIdentity, HANDLE_PERMANENCE_WARNING } = await import("@/components/real/account-identity");
const { RealHomeView } = await import("@/components/real/real-home-view");
const { useRealAccountStore } = await import("@/lib/stores/real-account-store");

const ACCOUNT = { appUserId: "app-user-1", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222" };
const OPTIONS = { challenge: "challenge-1", rpId: "localhost" };
const ASSERTION = { id: "credential-1", response: { userHandle: "user-handle-1" } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let calls: Array<{ url: string; method: string; body: unknown }> = [];
let respond: (url: string) => Response;

function signIn(extra: Record<string, unknown> = {}) {
  useRealAccountStore.setState({ account: { ...ACCOUNT, ...extra }, status: "ready", error: null, hasHydrated: true, profileBusy: false, profileError: null });
}

beforeEach(() => {
  calls = [];
  respond = (url) => (url.endsWith("/handle/options") ? json({ handle: "smit", optionsJSON: OPTIONS }) : json({ handle: "smit", displayName: null }));
  webauthn.performLoginCeremony.mockReset().mockResolvedValue(ASSERTION);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return respond(String(input));
    }),
  );
  signIn();
});
afterEach(() => vi.unstubAllGlobals());

const openClaim = () => fireEvent.click(screen.getByRole("button", { name: "Choose a name" }));
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("AccountIdentity — an account with no @name", () => {
  it("shows a skippable 'Choose your @name' card; nothing about the account is blocked by it", () => {
    render(<AccountIdentity />);
    expect(screen.getByTestId("real-handle-card")).toBeTruthy();
    expect(screen.getByText("Choose your @name")).toBeTruthy();
    expect(screen.getByText(/You can do this later/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByTestId("real-handle-card")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("the claim form: one @-prefixed field, the rules, a second entry, and the permanence warning — before any passkey prompt", () => {
    render(<AccountIdentity />);
    openClaim();
    expect(screen.getByLabelText("Choose your @name")).toBeTruthy();
    expect(screen.getByLabelText("Type it again")).toBeTruthy();
    expect(screen.getByText(/3–20 characters. Letters a–z, numbers, and underscores. Start with a letter./)).toBeTruthy();
    expect(HANDLE_PERMANENCE_WARNING).toBe("This is how people will find you to pay you. You can't change it later.");
    expect(screen.getByText(HANDLE_PERMANENCE_WARNING)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Confirm with passkey" }) as HTMLButtonElement).disabled).toBe(true);
    expect(webauthn.performLoginCeremony).not.toHaveBeenCalled();
  });

  it("the button stays disabled until the name is valid AND the second entry matches exactly", () => {
    render(<AccountIdentity />);
    openClaim();
    const button = () => screen.getByRole("button", { name: "Confirm with passkey" }) as HTMLButtonElement;
    type("Choose your @name", "sm");
    expect(screen.getByText("Use at least 3 characters.")).toBeTruthy();
    expect(button().disabled).toBe(true);
    type("Choose your @name", "smit");
    expect(button().disabled).toBe(true); // nothing typed again yet
    type("Type it again", "smitt");
    expect(screen.getByText("The two names don't match.")).toBeTruthy();
    expect(button().disabled).toBe(true);
    type("Type it again", "smit");
    expect(button().disabled).toBe(false);
    expect(screen.getByText("@smit")).toBeTruthy(); // exactly what will be claimed is shown before confirming
  });

  it("the final summary shows the CANONICAL handle the claim will submit, directly above the passkey button, with the permanence warning still visible", () => {
    render(<AccountIdentity />);
    openClaim();
    expect(screen.queryByTestId("real-handle-summary")).toBeNull(); // nothing to confirm yet
    type("Choose your @name", "  @Smit_Patel ");
    expect(screen.queryByTestId("real-handle-summary")).toBeNull(); // the second entry hasn't been typed
    type("Type it again", "smit_patel");
    const summary = screen.getByTestId("real-handle-summary");
    expect(screen.getByTestId("real-handle-summary-handle").textContent).toBe("@smit_patel"); // canonical, not what was typed
    expect(summary.textContent).toContain("Your name will be @smit_patel");
    expect(summary.textContent).toContain("confirm with your passkey");
    // The summary is the element immediately before the action buttons, and the button is the passkey confirmation.
    const actions = summary.nextElementSibling as HTMLElement;
    expect(actions.querySelector("button[type='submit']")?.textContent).toBe("Confirm with passkey");
    // The permanence warning is still on screen, above it.
    const warning = screen.getByText(HANDLE_PERMANENCE_WARNING);
    expect(warning.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The summary disappears again the moment the entries stop matching.
    type("Type it again", "smit_patel2");
    expect(screen.queryByTestId("real-handle-summary")).toBeNull();
    expect(webauthn.performLoginCeremony).not.toHaveBeenCalled();
  });

  it("a stale 'isn't available' error clears the moment either entry is edited — locally, with no request", async () => {
    respond = () => json({ error: "That name isn't available. Try another." }, 409);
    render(<AccountIdentity />);
    openClaim();
    type("Choose your @name", "taken");
    type("Type it again", "taken");
    fireEvent.click(screen.getByRole("button", { name: "Confirm with passkey" }));
    // 1. the unavailable result shows its error.
    expect(await screen.findByText("That name isn't available. Try another.")).toBeTruthy();
    const requestsAfterTheClaim = calls.length;
    expect(requestsAfterTheClaim).toBe(1);

    // 2. editing the handle clears it (the fields themselves are untouched, and the form stays open).
    type("Choose your @name", "taken2");
    expect(screen.queryByText("That name isn't available. Try another.")).toBeNull();
    expect((screen.getByLabelText("Choose your @name") as HTMLInputElement).value).toBe("taken2");
    expect(screen.getByTestId("real-handle-form")).toBeTruthy();

    // 3. editing the confirmation clears it too: bring the error back, then edit the other field.
    type("Choose your @name", "taken");
    type("Type it again", "taken");
    fireEvent.click(screen.getByRole("button", { name: "Confirm with passkey" }));
    expect(await screen.findByText("That name isn't available. Try another.")).toBeTruthy();
    const requestsAfterTheSecondClaim = calls.length;
    type("Type it again", "takenn");
    expect(screen.queryByText("That name isn't available. Try another.")).toBeNull();
    expect(screen.getByText("The two names don't match.")).toBeTruthy(); // the live mismatch hint is a different message and still works

    // 4. clearing stale UI state made no network request, and edits alone never prompt for a passkey or claim anything.
    expect(calls.length).toBe(requestsAfterTheSecondClaim);
    expect(calls.map((c) => c.url)).toEqual(["/api/real/account/handle/options", "/api/real/account/handle/options"]);
    expect(useRealAccountStore.getState().account).toEqual(ACCOUNT);
    expect(webauthn.performLoginCeremony).not.toHaveBeenCalled();
    expect(useRealAccountStore.getState().profileError).toBeNull();
  });

  it("editing does not clear anything when there is no error, and typing is not busy-blocked by it", () => {
    render(<AccountIdentity />);
    openClaim();
    type("Choose your @name", "abc");
    type("Type it again", "abd");
    expect(screen.getByText("The two names don't match.")).toBeTruthy();
    expect(useRealAccountStore.getState().profileError).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("confirming asks for the passkey and claims; the @name then replaces the card", async () => {
    render(<AccountIdentity />);
    openClaim();
    type("Choose your @name", "Smit");
    type("Type it again", "smit");
    fireEvent.click(screen.getByRole("button", { name: "Confirm with passkey" }));
    await waitFor(() => expect(useRealAccountStore.getState().account?.handle).toBe("smit"));
    expect(webauthn.performLoginCeremony).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.url)).toEqual(["/api/real/account/handle/options", "/api/real/account/handle/claim"]);
    expect(calls[0]!.body).toEqual({ handle: "smit" });
    await waitFor(() => expect(screen.queryByTestId("real-handle-form")).toBeNull());
    expect(screen.queryByTestId("real-handle-card")).toBeNull();
    expect(screen.getByTestId("real-account-display-name").textContent).toBe("@smit");
  });

  it("a taken name shows the server's message and keeps the form open with the entries intact", async () => {
    respond = () => json({ error: "That name isn't available. Try another." }, 409);
    render(<AccountIdentity />);
    openClaim();
    type("Choose your @name", "smit");
    type("Type it again", "smit");
    fireEvent.click(screen.getByRole("button", { name: "Confirm with passkey" }));
    expect(await screen.findByText("That name isn't available. Try another.")).toBeTruthy();
    expect((screen.getByLabelText("Choose your @name") as HTMLInputElement).value).toBe("smit");
    expect(webauthn.performLoginCeremony).not.toHaveBeenCalled();
    expect(useRealAccountStore.getState().account).toEqual(ACCOUNT);
  });

  it("Cancel closes the form without any request", () => {
    render(<AccountIdentity />);
    openClaim();
    type("Choose your @name", "smit");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("real-handle-form")).toBeNull();
    expect(screen.getByTestId("real-handle-card")).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
});

describe("AccountIdentity — names", () => {
  it("with a display name and an @name: the display name leads, the @name sits under it, and there is no claim card or way to change the @name", () => {
    signIn({ handle: "smit", displayName: "Smit Patel" });
    render(<AccountIdentity />);
    expect(screen.getByTestId("real-account-display-name").textContent).toBe("Smit Patel");
    expect(screen.getByTestId("real-account-handle").textContent).toBe("@smit");
    expect(screen.queryByTestId("real-handle-card")).toBeNull();
    expect(screen.queryByRole("button", { name: "Choose a name" })).toBeNull();
    expect(screen.queryByText(/change.*@name|edit.*@name/i)).toBeNull();
  });

  it("the display name is editable with no passkey prompt, and can be cleared", async () => {
    signIn({ handle: "smit" });
    respond = () => json({ handle: "smit", displayName: "Smit Patel" });
    render(<AccountIdentity />);
    fireEvent.click(screen.getByRole("button", { name: "Add your name" }));
    type("Your name", "Smit Patel");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByTestId("real-account-display-name").textContent).toBe("Smit Patel"));
    expect(calls).toEqual([{ url: "/api/real/account/profile", method: "PATCH", body: { displayName: "Smit Patel" } }]);
    expect(webauthn.performLoginCeremony).not.toHaveBeenCalled();
    respond = () => json({ handle: "smit", displayName: null });
    fireEvent.click(screen.getByRole("button", { name: "Edit name" }));
    type("Your name", "");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByTestId("real-account-display-name").textContent).toBe("@smit"));
    expect(calls[1]!.body).toEqual({ displayName: null });
  });

  it("an account can have a display name without ever choosing an @name", () => {
    signIn({ displayName: "Smit Patel" });
    render(<AccountIdentity />);
    expect(screen.getByTestId("real-account-display-name").textContent).toBe("Smit Patel");
    expect(screen.queryByTestId("real-account-handle")).toBeNull();
    expect(screen.getByTestId("real-handle-card")).toBeTruthy();
  });

  it("renders nothing when signed out", () => {
    useRealAccountStore.setState({ account: null, status: "signed-out" });
    const { container } = render(<AccountIdentity />);
    expect(container.innerHTML).toBe("");
  });
});

describe("Real Home heading", () => {
  beforeEach(() => {
    respond = (url) => {
      if (url === "/api/real/session") return json({ authenticated: true, ...useRealAccountStore.getState().account });
      if (url.endsWith("/api/real/account/passkeys")) return json({ passkeys: [] });
      if (url.endsWith("/backup/status")) return json({ enrollment: null });
      return json({ error: "x" }, 500);
    };
  });

  it("an account with no name reads exactly as before", () => {
    render(<RealHomeView />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Your real account");
  });

  it("leads with the display name, with the @name beside it; addresses stay behind 'See account details'", () => {
    signIn({ handle: "smit", displayName: "Smit Patel" });
    render(<RealHomeView />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Smit Patel");
    expect(screen.getAllByText("@smit").length).toBeGreaterThan(0);
    expect(screen.queryByText(new RegExp(ACCOUNT.safeAddress))).toBeNull();
    expect(screen.queryByText(new RegExp(ACCOUNT.ownerAddress))).toBeNull();
  });

  it("with only an @name, the @name is the heading", () => {
    signIn({ handle: "smit" });
    render(<RealHomeView />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("@smit");
  });
});
