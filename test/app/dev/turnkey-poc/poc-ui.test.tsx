import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnkeyPocUi } from "@/app/dev/turnkey-poc/poc-ui";
import { privateKeyToAccount } from "viem/accounts";
import * as verifiedAccount from "@/lib/poc/turnkey/verified-account";
import * as payment from "@/lib/poc/turnkey/payment";
import * as storageAudit from "@/lib/poc/turnkey/storage-audit";
import { resetExecutedPathForTests } from "@/lib/poc/turnkey/executed-path";
import {
  loadOperationHistory,
  loadPendingOperation,
  parsePublicAccountState,
  rememberOperation,
  savePendingOperation,
  savePublicAccount,
  type PendingOperation,
} from "@/lib/poc/turnkey/public-state";

const provisionedAccount = {
  appUserId: "app-user",
  subOrganizationId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  walletId: "33333333-3333-4333-8333-333333333333",
  ownerAddress: "0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF",
  safeAddress: "0xd9a4c22fb34dc74317edc8006140d66c8fa03266",
  authenticators: [],
};

describe("TurnkeyPocUi — Send 0.10 Cash must never silently no-op", () => {
  beforeEach(() => {
    localStorage.clear();
    const account = parsePublicAccountState(provisionedAccount);
    savePublicAccount(account!);

    // Only the mount-time session check is expected to hit the network. Any
    // other fetch (balances, provision, pimlico, ...) means a click reached
    // past a prerequisite it should have been blocked by — which is the
    // exact bug being regression-tested here: a click that silently starts
    // work (or silently does nothing) instead of being visibly blocked.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/dev/turnkey-poc/session")) {
          return new Response(JSON.stringify({ authenticated: false }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`Unexpected network call to ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("disables the button and shows a visible reason when no recipient is set, instead of silently doing nothing on click", async () => {
    render(<TurnkeyPocUi />);

    const sendButton = await screen.findByRole("button", { name: "Send 0.10 Cash" });
    await screen.findByText("Send 0.10 Cash is disabled: Enter a recipient address to enable Send 0.10 Cash.");
    expect(sendButton).toBeDisabled();

    const fetchCallsBeforeClick = vi.mocked(fetch).mock.calls.length;
    fireEvent.click(sendButton);
    // A disabled button must not start any work: no additional fetch (no
    // balance read, no Pimlico call) and no passkey ceremony is triggered.
    expect(vi.mocked(fetch).mock.calls.length).toBe(fetchCallsBeforeClick);
  });

  it("keeps the button disabled with a distinct reason for a malformed recipient", async () => {
    render(<TurnkeyPocUi />);
    const sendButton = await screen.findByRole("button", { name: "Send 0.10 Cash" });
    await screen.findByLabelText("Recipient");

    fireEvent.change(screen.getByLabelText("Recipient"), { target: { value: "not-an-address" } });

    expect(sendButton).toBeDisabled();
    expect(
      screen.getByText("Send 0.10 Cash is disabled: Recipient must be a valid 0x… Ethereum address."),
    ).toBeInTheDocument();
  });

  it("enables the button once a valid recipient is entered", async () => {
    render(<TurnkeyPocUi />);
    const sendButton = await screen.findByRole("button", { name: "Send 0.10 Cash" });
    await screen.findByLabelText("Recipient");

    fireEvent.change(screen.getByLabelText("Recipient"), {
      target: { value: "0x0000000000000000000000000000000000000099" },
    });

    expect(sendButton).not.toBeDisabled();
    expect(screen.queryByText(/Send 0\.10 Cash is disabled/)).not.toBeInTheDocument();
  });
});

describe("TurnkeyPocUi — an unresolved prior payment blocks a new send", () => {
  beforeEach(() => {
    localStorage.clear();
    const account = parsePublicAccountState(provisionedAccount);
    savePublicAccount(account!);
    // Mirrors the exact stuck state from the live incident: a fresh WebAuthn
    // ceremony was approved, but the bundler response never came back, so
    // there is no userOperationHash — status stays "unknown".
    savePendingOperation({
      id: "op-stuck",
      status: "unknown",
      recipient: "0xc27d4743bc9839ba15c9982b17143d6039b2d5b0",
      amountUsdc: "0.10",
      userOperationHash: null,
      transactionHash: null,
      receiptStatus: null,
      submittedAt: "2026-01-01T00:00:00.000Z",
      lastError: "Signing succeeded, but the bundler response was lost to a network/transport failure.",
      autoResend: false,
      simulatedRecoveryOf: null,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/dev/turnkey-poc/session")) {
          return new Response(JSON.stringify({ authenticated: false }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`Unexpected network call to ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps Send 0.10 Cash disabled with a visible reason even with a valid recipient, until the operation is resolved", async () => {
    render(<TurnkeyPocUi />);
    const sendButton = await screen.findByRole("button", { name: "Send 0.10 Cash" });
    await screen.findByLabelText("Recipient");

    fireEvent.change(screen.getByLabelText("Recipient"), {
      target: { value: "0x0000000000000000000000000000000000000099" },
    });

    expect(sendButton).toBeDisabled();
    expect(screen.getByText(/A previous payment is unresolved \(status: unknown\)/)).toBeInTheDocument();

    const fetchCallsBeforeClick = vi.mocked(fetch).mock.calls.length;
    fireEvent.click(sendButton);
    expect(vi.mocked(fetch).mock.calls.length).toBe(fetchCallsBeforeClick);
  });

  it("unblocks sending after the user explicitly clears the unresolved payment — never automatically", async () => {
    render(<TurnkeyPocUi />);
    const sendButton = await screen.findByRole("button", { name: "Send 0.10 Cash" });
    fireEvent.change(await screen.findByLabelText("Recipient"), {
      target: { value: "0x0000000000000000000000000000000000000099" },
    });
    expect(sendButton).toBeDisabled();

    const clearButton = await screen.findByRole("button", { name: "Clear unresolved payment" });
    expect(clearButton).not.toBeDisabled();
    fireEvent.click(clearButton);

    expect(await screen.findByText(/Cleared the unresolved payment record/)).toBeInTheDocument();
    expect(sendButton).not.toBeDisabled();
    expect(screen.queryByText(/A previous payment is unresolved/)).not.toBeInTheDocument();
  });
});

describe("TurnkeyPocUi — Gate 3 DEV-ONLY reconciliation harness", () => {
  const CONFIRMED_HASH = "0x" + "e5".repeat(32);
  const CONFIRMED_TX = "0x" + "a2".repeat(32);

  const confirmedOperation: PendingOperation = {
    id: "op-confirmed-1",
    status: "confirmed",
    recipient: "0xc27d4743bc9839ba15c9982b17143d6039b2d5b0",
    amountUsdc: "0.10",
    userOperationHash: CONFIRMED_HASH,
    transactionHash: CONFIRMED_TX,
    receiptStatus: "success",
    submittedAt: "2026-01-01T00:00:00.000Z",
    lastError: null,
    autoResend: false,
    simulatedRecoveryOf: null,
  };

  const balancesResponse = {
    ownerEth: "0",
    safeEth: "0",
    ownerUsdc: "0",
    safeUsdc: "19900000",
    recipientUsdc: "100000",
    safeDeployed: true,
    safeBytecode: "0x60",
  };

  beforeEach(() => {
    localStorage.clear();
    const account = parsePublicAccountState(provisionedAccount);
    savePublicAccount(account!);
    // Mirrors the real post-Gate-2 state: the confirmed operation is both
    // the active pending pointer and already recorded in history — exactly
    // what persistPending does for a real confirmed payment.
    savePendingOperation(confirmedOperation);
    rememberOperation(confirmedOperation);

    // Allow-list fetch stub: any URL not explicitly handled here throws,
    // so a stray Turnkey/Pimlico/session/signing call during any of these
    // interactions fails the test immediately rather than passing silently.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/dev/turnkey-poc/session")) {
          return new Response(JSON.stringify({ authenticated: false }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/api/dev/turnkey-poc/balances")) {
          return new Response(JSON.stringify(balancesResponse), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/api/dev/turnkey-poc/reconcile")) {
          const body = JSON.parse(String(init?.body)) as { userOperationHash?: string };
          expect(body.userOperationHash).toBe(CONFIRMED_HASH);
          return new Response(
            JSON.stringify({
              status: "confirmed",
              userOperationHash: CONFIRMED_HASH,
              transactionHash: CONFIRMED_TX,
              receiptStatus: "success",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected network call to ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("simulating an unresolved known-hash state makes zero network calls and enables Reconcile pending", async () => {
    render(<TurnkeyPocUi />);
    const simulateButton = await screen.findByRole("button", { name: "Simulate unresolved known-hash state" });
    await waitFor(() => expect(simulateButton).not.toBeDisabled());

    const fetchCallsBeforeClick = vi.mocked(fetch).mock.calls.length;
    fireEvent.click(simulateButton);

    expect(
      await screen.findByText(/simulated a local unresolved \(status=unknown\) recovery copy of confirmed operation op-confirmed-1/),
    ).toBeInTheDocument();
    // Only assertion that matters for "no signing/submission occurred": no
    // fetch at all happened as a result of this click.
    expect(vi.mocked(fetch).mock.calls.length).toBe(fetchCallsBeforeClick);

    expect(screen.getByText(CONFIRMED_HASH)).toBeInTheDocument();
    const reconcileButton = screen.getByRole("button", { name: "Reconcile pending" });
    expect(reconcileButton).not.toBeDisabled();
  });

  it("Reconcile pending queries the known hash and restores the confirmed transaction — never a resend", async () => {
    render(<TurnkeyPocUi />);
    const simulateButton = await screen.findByRole("button", { name: "Simulate unresolved known-hash state" });
    await waitFor(() => expect(simulateButton).not.toBeDisabled());
    fireEvent.click(simulateButton);

    const reconcileButton = await screen.findByRole("button", { name: "Reconcile pending" });
    await waitFor(() => expect(reconcileButton).not.toBeDisabled());
    fireEvent.click(reconcileButton);

    expect(await screen.findByText(new RegExp(`Reconciled userOperationHash=${CONFIRMED_HASH}`))).toBeInTheDocument();
    expect(screen.getByText(CONFIRMED_TX)).toBeInTheDocument();
    expect(screen.getByText(/Reconciliation restored its confirmed transaction and receipt/)).toBeInTheDocument();

    const reconcileCalls = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith("/reconcile"));
    expect(reconcileCalls).toHaveLength(1);

    // The historical confirmed record must still be present and untouched.
    const history = loadOperationHistory();
    const original = history.find((item) => item.id === "op-confirmed-1");
    expect(original).toEqual(confirmedOperation);
  });

  it("reconciling again is idempotent — same confirmed result, no duplicate submission endpoint ever hit", async () => {
    render(<TurnkeyPocUi />);
    const simulateButton = await screen.findByRole("button", { name: "Simulate unresolved known-hash state" });
    await waitFor(() => expect(simulateButton).not.toBeDisabled());
    fireEvent.click(simulateButton);

    const reconcileButton = await screen.findByRole("button", { name: "Reconcile pending" });
    await waitFor(() => expect(reconcileButton).not.toBeDisabled());
    fireEvent.click(reconcileButton);
    await screen.findByText(new RegExp(`Reconciled userOperationHash=${CONFIRMED_HASH}`));

    fireEvent.click(reconcileButton);
    await waitFor(() => {
      const reconcileCalls = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith("/reconcile"));
      expect(reconcileCalls).toHaveLength(2);
    });

    // Still exactly the same confirmed tx — the allow-listed fetch stub
    // above throws on any URL other than session/balances/reconcile, so a
    // second reconcile reaching for a submission/signing endpoint would
    // have already failed the test.
    expect(screen.getByText(CONFIRMED_TX)).toBeInTheDocument();
  });

  it("retains the previously confirmed receipt when a later lookup fails", async () => {
    render(<TurnkeyPocUi />);
    const button = await screen.findByRole("button", { name: "Reconcile pending" });
    await waitFor(() => expect(button).not.toBeDisabled());
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Lookup timed out"));
    fireEvent.click(button);
    await screen.findByText(/previously observed terminal receipt is retained/);
    expect(loadPendingOperation()?.status).toBe("confirmed");
    expect(loadPendingOperation()?.transactionHash).toBe(CONFIRMED_TX);
  });
});

describe("TurnkeyPocUi — audit regressions", () => {
  beforeEach(() => {
    localStorage.clear();
    resetExecutedPathForTests();
    savePublicAccount(parsePublicAccountState(provisionedAccount)!);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/session")) return Response.json({ authenticated: true });
      if (url.endsWith("/inspect")) return Response.json({
        ownerAddress: provisionedAccount.ownerAddress,
        child: { rootUserCount: 1, rootUserIds: [provisionedAccount.userId], rootThreshold: 1,
          authenticatorCount: 1, apiKeyCount: 0, oauthProviderCount: 0, sessionCredentialCount: 0,
          backendApiKeyOnChild: false, extraRootUsers: false },
      });
      if (url.endsWith("/balances")) return Response.json({ ownerEth: "0", safeEth: "0", ownerUsdc: "0", safeUsdc: "19900000", recipientUsdc: "100000", safeDeployed: true, safeBytecode: "0x60" });
      throw new Error(`Unexpected network call: ${url}`);
    }));
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("shows missing runtime evidence after a fresh runtime and successful child inspection", async () => {
    render(<TurnkeyPocUi />);
    expect(await screen.findByText(/Runtime evidence not re-run after reload/)).toBeInTheDocument();
    expect(screen.queryByText(/INCOMPLETE \/ FAIL/)).not.toBeInTheDocument();
  });

  it("keeps the acknowledged hash unknown and Send blocked if post-submission storage audit fails", async () => {
    const owner = privateKeyToAccount("0x119bb329df425b685a3f3483fba01deeb1db47d608cfb051da9ad4a12995238a");
    vi.spyOn(verifiedAccount, "createVerifiedTurnkeyOwnerAccount").mockResolvedValue(owner);
    const hash = `0x${"ab".repeat(32)}` as const;
    const send = vi.spyOn(payment, "sendSponsoredCashTransfer").mockResolvedValue({
      safeAddress: provisionedAccount.safeAddress as `0x${string}`, userOperationHash: hash,
      signDiagnostic: null, digestsMatch: true,
      preflight: { ok: true, expectedOwner: owner.address, recoveredAddress: owner.address,
        validAfter: 0, validUntil: 0, signatureByteLength: 65, vByte: 27,
        reconstructedDigest: hash, reason: null },
    });
    render(<TurnkeyPocUi />);
    await screen.findByText(/Runtime evidence not re-run after reload/);
    vi.spyOn(storageAudit, "captureStorageSnapshot").mockRejectedValueOnce(new Error("IndexedDB unavailable"));
    fireEvent.change(screen.getByLabelText("Recipient"), { target: { value: "0x0000000000000000000000000000000000000099" } });
    fireEvent.click(screen.getByRole("button", { name: "Send 0.10 Cash" }));
    await waitFor(() => expect(loadPendingOperation()?.status).toBe("unknown"));
    expect(loadPendingOperation()?.userOperationHash).toBe(hash);
    expect(screen.getByRole("button", { name: "Send 0.10 Cash" })).toBeDisabled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("disables Send while another action is busy", async () => {
    render(<TurnkeyPocUi />);
    await screen.findByText(/Runtime evidence not re-run after reload/);
    fireEvent.change(screen.getByLabelText("Recipient"), { target: { value: "0x0000000000000000000000000000000000000099" } });
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "Refresh balances" }));
    expect(screen.getByRole("button", { name: "Send 0.10 Cash" })).toBeDisabled();
  });
});
