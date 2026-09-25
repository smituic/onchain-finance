import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RealPasskeysManager } from "@/components/real/real-passkeys-manager";
import { MAY_STILL_AUTHORIZE_NOTE } from "@/lib/real/display/passkey-status";

type Passkey = Record<string, unknown>;

function passkey(overrides: Passkey): Passkey {
  return {
    credentialId: "cred-a",
    role: "primary",
    displayName: null,
    status: "active",
    credentialDeviceType: "singleDevice",
    credentialBackedUp: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    isCurrentSession: true,
    canAuthorizeRemovals: true,
    removal: null,
    ...overrides,
  };
}

function stubServer(passkeys: Passkey[], enrollment: Record<string, unknown> | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (url.endsWith("/api/real/account/passkeys")) return ok({ passkeys });
      if (url.endsWith("/api/real/account/passkeys/backup/status")) return ok({ enrollment });
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RealPasskeysManager", () => {
  it("a pending backup passkey never hides Resume — setup resumes from the durable enrollment", async () => {
    stubServer(
      [passkey({}), passkey({ credentialId: "cred-b", role: "backup", status: "pending", isCurrentSession: false })],
      { id: "e1", state: "turnkey_enrollment_in_flight", externalOutcome: "unknown", abandonable: false, blockReason: null },
    );
    render(<RealPasskeysManager />);
    expect(await screen.findByRole("button", { name: "Resume backup passkey setup" })).toBeTruthy();
    expect(screen.getByText("Setup in progress")).toBeTruthy();
    // An uncertain Turnkey attempt is never offered for cancellation.
    expect(screen.queryByRole("button", { name: "Cancel setup" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a backup passkey" })).toBeNull();
  });

  it("a pre-dispatch setup can be cancelled", async () => {
    stubServer([passkey({})], { id: "e1", state: "credential_registered", externalOutcome: "not_attempted", abandonable: true, blockReason: null });
    render(<RealPasskeysManager />);
    expect(await screen.findByRole("button", { name: "Cancel setup" })).toBeTruthy();
  });

  it("'has a ready backup' counts ACTIVE credentials only: one active passkey still offers Add", async () => {
    stubServer([passkey({})], null);
    render(<RealPasskeysManager />);
    expect(await screen.findByRole("button", { name: "Add a backup passkey" })).toBeTruthy();
  });

  it("an unconfirmed removal is never shown as removed and always carries the may-still-authorize note", async () => {
    stubServer(
      [passkey({}), passkey({ credentialId: "cred-b", role: "backup", status: "revoking", isCurrentSession: false, removal: { attemptId: "r1", state: "dispatch_in_flight", ownedBySession: true } })],
      null,
    );
    render(<RealPasskeysManager />);
    expect(await screen.findByText("Removal submitted — not yet confirmed")).toBeTruthy();
    expect(screen.getByText(MAY_STILL_AUTHORIZE_NOTE)).toBeTruthy();
    expect(screen.queryByText("Removed")).toBeNull();
    expect(screen.getByRole("button", { name: "Check removal status" })).toBeTruthy();
  });

  it("an undispatched removal leaves the passkey ACTIVE — the owning session gets Authorize/Cancel, no may-still-authorize warning", async () => {
    stubServer(
      [passkey({}), passkey({ credentialId: "cred-b", role: "backup", isCurrentSession: false, removal: { attemptId: "r1", state: "authorization_needed", ownedBySession: true } })],
      null,
    );
    render(<RealPasskeysManager />);
    expect(await screen.findByText("Active — removal not authorized yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Authorize removal" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel removal" })).toBeTruthy();
    expect(screen.queryByText(MAY_STILL_AUTHORIZE_NOTE)).toBeNull();
    expect(screen.queryByText(/Removing…/)).toBeNull();
  });

  it("another session's undispatched removal can't be authorized or cancelled from here", async () => {
    stubServer(
      [passkey({}), passkey({ credentialId: "cred-b", role: "backup", isCurrentSession: false, removal: { attemptId: "r1", state: "authorization_needed", ownedBySession: false } })],
      null,
    );
    render(<RealPasskeysManager />);
    expect(await screen.findByText("Active — removal not authorized yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Authorize removal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel removal" })).toBeNull();
  });

  it("a removal with an unknowable outcome (blocked for review) is neither Active nor Removed, keeps the may-still-authorize note, and offers no new removal", async () => {
    stubServer(
      [passkey({}), passkey({ credentialId: "cred-b", role: "backup", status: "revoking", isCurrentSession: false, removal: { attemptId: "r1", state: "blocked", ownedBySession: true } })],
      null,
    );
    render(<RealPasskeysManager />);
    expect(await screen.findByText("Removal needs review")).toBeTruthy();
    const row = within(screen.getAllByTestId("real-passkey-row")[1]!);
    expect(row.getByText(MAY_STILL_AUTHORIZE_NOTE)).toBeTruthy();
    expect(row.queryByText("Removed")).toBeNull();
    expect(row.queryByText(/^Active/)).toBeNull();
    expect(row.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(row.queryByRole("button", { name: "Authorize removal" })).toBeNull();
  });

  it("the signed-in passkey can't be removed from its own session; copy never claims backup is weaker or loss is recoverable", async () => {
    stubServer([passkey({}), passkey({ credentialId: "cred-b", role: "backup", isCurrentSession: false })], null);
    render(<RealPasskeysManager />);
    await waitFor(() => expect(screen.getAllByTestId("real-passkey-row")).toHaveLength(2));
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(1);
    expect(screen.getByText("To remove this passkey, sign in with a different one.")).toBeTruthy();
    expect(screen.getByText("Primary and backup passkeys have the same access to this account.")).toBeTruthy();
    expect(screen.getByText(/can't currently be recovered/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/never lose access|guaranteed recovery|prevents theft/i);
  });
});

describe("RealPasskeysManager — names", () => {
  it("a named passkey shows its name with the role; an unnamed (older) one falls back to the role label", async () => {
    stubServer([passkey({ displayName: "MacBook Touch ID" }), passkey({ credentialId: "cred-b", role: "backup", isCurrentSession: false })], null);
    render(<RealPasskeysManager />);
    const rows = await screen.findAllByTestId("real-passkey-row");
    expect(within(rows[0]!).getByText("MacBook Touch ID (signed in)")).toBeTruthy();
    expect(within(rows[0]!).getByText("Primary passkey · Active")).toBeTruthy();
    expect(within(rows[1]!).getByText("Backup passkey")).toBeTruthy();
    expect(within(rows[1]!).getByText("Active")).toBeTruthy();
  });

  it("Rename is offered only on active passkeys — never pending, revoking, or removed", async () => {
    stubServer(
      [
        passkey({}),
        passkey({ credentialId: "cred-b", role: "backup", status: "pending", isCurrentSession: false }),
        passkey({ credentialId: "cred-c", role: "backup", status: "revoking", isCurrentSession: false, removal: { attemptId: "r1", state: "dispatch_in_flight", ownedBySession: true } }),
        passkey({ credentialId: "cred-d", role: "backup", status: "revoked", isCurrentSession: false, removal: { attemptId: "r2", state: "confirmed", ownedBySession: true } }),
      ],
      null,
    );
    render(<RealPasskeysManager />);
    const rows = await screen.findAllByTestId("real-passkey-row");
    expect(within(rows[0]!).getByRole("button", { name: "Rename" })).toBeTruthy();
    for (const row of rows.slice(1)) expect(within(row).queryByRole("button", { name: "Rename" })).toBeNull();
  });

  it("saving sends the trimmed name to the rename route and shows it after refresh", async () => {
    let name: string | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (url.endsWith("/api/real/account/passkeys/cred-a") && init?.method === "PATCH") {
        name = (JSON.parse(String(init.body)) as { displayName: string }).displayName;
        return ok({ passkey: { credentialId: "cred-a", displayName: name } });
      }
      if (url.endsWith("/api/real/account/passkeys")) return ok({ passkeys: [passkey({ displayName: name })] });
      if (url.endsWith("/api/real/account/passkeys/backup/status")) return ok({ enrollment: null });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RealPasskeysManager />);

    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Passkey name" }), { target: { value: "  YubiKey  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("YubiKey (signed in)")).toBeTruthy();
    expect(name).toBe("YubiKey");
    expect(screen.queryByRole("textbox", { name: "Passkey name" })).toBeNull();
  });

  it("an empty name is refused in the browser without calling the server", async () => {
    stubServer([passkey({})], null);
    render(<RealPasskeysManager />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    const callsBefore = vi.mocked(fetch).mock.calls.length;
    fireEvent.change(screen.getByRole("textbox", { name: "Passkey name" }), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Enter a name for this passkey.")).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.length).toBe(callsBefore);
    expect(screen.getByRole("textbox", { name: "Passkey name" })).toBeTruthy();
  });

  it("after the primary is removed, the sole survivor shows its name and 'Primary · Active'; a revoked row never renders", async () => {
    stubServer(
      [
        passkey({ credentialId: "old-primary", status: "revoked", isCurrentSession: false, removal: { attemptId: "r1", state: "confirmed", ownedBySession: true } }),
        passkey({ credentialId: "survivor", role: "primary", displayName: "YubiKey" }),
      ],
      null,
    );
    render(<RealPasskeysManager />);
    expect(await screen.findByText("YubiKey (signed in)")).toBeTruthy();
    const rows = screen.getAllByTestId("real-passkey-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText("Primary passkey · Active")).toBeTruthy();
    expect(screen.queryByText("Removed")).toBeNull();
    expect(screen.queryByText(/Backup passkey/)).toBeNull();
    expect(screen.getByRole("button", { name: "Add a backup passkey" })).toBeTruthy();
  });

  it("the removal dialog names the passkey being removed", async () => {
    stubServer([passkey({}), passkey({ credentialId: "cred-b", role: "backup", displayName: "Old iPhone", isCurrentSession: false })], null);
    render(<RealPasskeysManager />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Remove “Old iPhone”?")).toBeTruthy();
  });
});
