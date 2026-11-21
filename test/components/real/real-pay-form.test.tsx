import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRealAccountStore } from "@/lib/stores/real-account-store";
import { useRealBalanceStore } from "@/lib/stores/real-balance-store";
import { useRealPaymentStore } from "@/lib/stores/real-payment-store";

const signPreparedPaymentMock = vi.fn();
vi.mock("@/lib/real/payments/client-sign", () => ({
  signPreparedPayment: (...args: unknown[]) => signPreparedPaymentMock(...(args as [never])),
}));

// L-2 D-8: the page-level tests render the real RealPayView (so the form really unmounts and remounts with the account);
// the ceremony and the three widgets that are not part of this flow are stubbed. No other test in this file renders them.
vi.mock("@/lib/real/account/webauthn-client", () => ({
  performLoginCeremony: vi.fn(async () => ({ response: { userHandle: "user-handle" } })),
  performRegistrationCeremony: vi.fn(),
  signalAccountLabel: vi.fn(),
  isWebAuthnCancellation: () => false,
}));
vi.mock("@/components/real/real-passkeys-manager", () => ({ RealPasskeysManager: () => null }));
vi.mock("@/components/real/cash-balance", () => ({ CashBalance: () => null }));
vi.mock("@/components/real/real-payment-history", () => ({ RealPaymentHistory: () => null }));

const { RealPayForm } = await import("@/components/real/real-pay-form");
const { RealPayView } = await import("@/components/real/real-pay-view");

const ACCOUNT = { appUserId: "app-user-1", ownerAddress: "0x1111111111111111111111111111111111111111", safeAddress: "0x2222222222222222222222222222222222222222" };
const RECIPIENT = "0x3333333333333333333333333333333333333333";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function routeFetch(handler: (url: string, method: string, body: unknown) => Response | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? (JSON.parse(init.body as string) as unknown) : undefined;
      const response = handler(url, method, body);
      if (!response) throw new Error(`Unhandled fetch in test: ${method} ${url}`);
      return response;
    }),
  );
}

const PREPARED_FIELDS = {
  nonce: "0",
  factory: null,
  factoryData: null,
  callData: "0xcalldata",
  callGasLimit: "80000",
  verificationGasLimit: "150000",
  preVerificationGas: "60000",
  maxFeePerGas: "2000000",
  maxPriorityFeePerGas: "1000000",
  paymaster: null,
  paymasterData: null,
  paymasterVerificationGasLimit: null,
  paymasterPostOpGasLimit: null,
};

function attemptFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "payment-attempt-1",
    state: "awaiting_authorization",
    recipient: RECIPIENT,
    recipientIdentity: null as unknown,
    amountBaseUnits: "1000000",
    transactionHash: null,
    failureReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    prepared: PREPARED_FIELDS,
    ...overrides,
  };
}

describe("RealPayForm", () => {
  beforeEach(() => {
    useRealAccountStore.setState({ account: null, status: "idle", error: null, hasHydrated: true });
    useRealBalanceStore.setState({ balance: { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" }, status: "ready", error: null });
    useRealPaymentStore.setState({
      status: "idle",
      recipientInput: "",
      recipientLookup: { status: "idle" },
      amountInput: "",
      attempt: null,
      subOrganizationId: null,
      authorizingCredentialId: null,
      pendingSubmission: null,
      isAuthorizing: false,
      clockOffsetSeconds: 0,
      isAttemptPastValidity: false,
      error: null,
    });
    signPreparedPaymentMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("renders nothing when there is no signed-in account", () => {
    const { container } = render(<RealPayForm />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the recipient/amount form when there's no in-flight payment", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    routeFetch((url, method) => {
      if (url.endsWith("/api/real/payments/latest") && method === "GET") return jsonResponse(200, { attempt: null });
      return null;
    });

    render(<RealPayForm />);

    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
    expect(screen.getByLabelText("To")).toBeInTheDocument();
    expect(screen.getByLabelText("Amount")).toBeInTheDocument();
  });

  it("reload restores a still-awaiting_authorization payment WITHOUT ever invoking the passkey ceremony", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    routeFetch((url, method) => {
      if (url.endsWith("/api/real/payments/latest") && method === "GET") {
        return jsonResponse(200, { attempt: attemptFixture(), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1" });
      }
      return null;
    });

    render(<RealPayForm />);

    await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel payment" })).toBeInTheDocument();
    expect(signPreparedPaymentMock).not.toHaveBeenCalled();
  });

  it("S2: dismissing the passkey prompt stays on the SAME pending payment (full recipient, warning, Continue, Cancel payment) — no fresh compose/Edit path, no submit", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    let submitCalled = false;
    let cancelCalled = false;
    routeFetch((url, method, body) => {
      if (url.endsWith("/api/real/payments/latest") && method === "GET") return jsonResponse(200, { attempt: null });
      if (url.endsWith("/api/real/payments/prepare") && method === "POST") {
        return jsonResponse(200, {
          attempt: attemptFixture({ recipient: (body as { recipient: string }).recipient }),
          subOrganizationId: "sub-org-1",
          authorizingCredentialId: "credential-1",
          serverNowSeconds: 1_900_000_000,
        });
      }
      if (url.endsWith("/api/real/payments/submit") && method === "POST") {
        submitCalled = true;
        return jsonResponse(200, { attempt: attemptFixture({ state: "submitted" }) });
      }
      if (url.endsWith("/api/real/payments/payment-attempt-1/cancel") && method === "POST") {
        cancelCalled = true;
        return jsonResponse(200, { attempt: attemptFixture({ state: "cancelled" }) });
      }
      return null;
    });
    const cancellationError = Object.assign(new Error("cancelled"), { name: "NotAllowedError" });
    signPreparedPaymentMock.mockRejectedValueOnce(cancellationError);

    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("To"), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));

    await waitFor(() => expect(screen.getByTestId("real-pay-review")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());
    expect(useRealPaymentStore.getState()).toMatchObject({ status: "awaiting_authorization", attempt: { id: "payment-attempt-1", state: "awaiting_authorization" } });
    expect(screen.getByText(RECIPIENT, { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/Only continue if you started this payment/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("real-pay-form")).not.toBeInTheDocument();
    expect(submitCalled).toBe(false);

    // Only a real, successful cancel frees the compose form.
    fireEvent.click(screen.getByRole("button", { name: "Cancel payment" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
    expect(cancelCalled).toBe(true);
    expect(useRealPaymentStore.getState().attempt).toBeNull();
  });

  it("a confirmed payment shows 'Sent' and refreshes the real Cash balance", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    let balanceFetchCount = 0;
    routeFetch((url, method) => {
      if (url.endsWith("/api/real/payments/latest") && method === "GET") return jsonResponse(200, { attempt: null });
      if (url.endsWith("/api/real/payments/prepare") && method === "POST") {
        return jsonResponse(200, { attempt: attemptFixture(), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1" });
      }
      if (url.endsWith("/api/real/payments/submit") && method === "POST") {
        // L-2 D-7: submit never answers "confirmed" in HTTP 200 — it answers "submitted", and the existing status path establishes "confirmed".
        return jsonResponse(200, { attempt: attemptFixture({ state: "submitted", transactionHash: "0xabc123" }) });
      }
      if (url.includes("/status") && method === "GET") {
        return jsonResponse(200, { attempt: attemptFixture({ state: "confirmed", transactionHash: "0xabc123" }), serverNowSeconds: 1_900_000_000 });
      }
      if (url.endsWith("/api/real/account/balance") && method === "GET") {
        balanceFetchCount += 1;
        return jsonResponse(200, { token: "USDC", decimals: 6, balanceBaseUnits: "19000000" });
      }
      return null;
    });
    signPreparedPaymentMock.mockResolvedValueOnce({ signature: "0xsignature", activityId: "activity-1" });

    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("To"), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-review")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(screen.getByTestId("real-pay-confirmed")).toBeInTheDocument());
    expect(screen.getByText("Sent")).toBeInTheDocument();
    await waitFor(() => expect(balanceFetchCount).toBeGreaterThan(0));
  });

  it("duplicate clicks on Approve cannot fire two prepares", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    let prepareCallCount = 0;
    routeFetch((url, method) => {
      if (url.endsWith("/api/real/payments/latest") && method === "GET") return jsonResponse(200, { attempt: null });
      if (url.endsWith("/api/real/payments/prepare") && method === "POST") {
        prepareCallCount += 1;
        return jsonResponse(200, { attempt: attemptFixture(), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1" });
      }
      return null;
    });
    signPreparedPaymentMock.mockImplementation(() => new Promise(() => {})); // never resolves — keeps status at "awaiting_authorization"/isAuthorizing

    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("To"), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-review")).toBeInTheDocument());

    const approveButton = screen.getByRole("button", { name: "Approve" });
    fireEvent.click(approveButton);
    fireEvent.click(approveButton);
    fireEvent.click(approveButton);

    await waitFor(() => expect(screen.getByTestId("real-pay-authorizing")).toBeInTheDocument());
    expect(prepareCallCount).toBe(1);
  });

  it("pre-2f hardening: A -> logout -> B clears the recipient/amount fields before B's own data loads", async () => {
    const ACCOUNT_B = { appUserId: "app-user-2", ownerAddress: "0x4444444444444444444444444444444444444444", safeAddress: "0x5555555555555555555555555555555555555555" };
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    routeFetch((url, method) => {
      if (url.endsWith("/api/real/payments/latest") && method === "GET") return jsonResponse(200, { attempt: null });
      return null;
    });

    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("To"), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.00" } });
    expect(screen.getByLabelText("To")).toHaveValue(RECIPIENT);

    act(() => {
      useRealAccountStore.setState({ account: null, status: "signed-out" });
    });
    act(() => {
      useRealAccountStore.setState({ account: ACCOUNT_B, status: "ready" });
    });

    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
    expect(screen.getByLabelText("To")).toHaveValue("");
    expect(screen.getByLabelText("Amount")).toHaveValue("");
  });

  it("pre-2f hardening: a restored 'signed' attempt shows the stranded (cancel-only) state, never Continue/resend", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    routeFetch((url, method) => {
      if (url.endsWith("/api/real/payments/latest") && method === "GET") {
        return jsonResponse(200, { attempt: attemptFixture({ state: "signed" }), subOrganizationId: null });
      }
      return null;
    });

    render(<RealPayForm />);

    await waitFor(() => expect(screen.getByTestId("real-pay-stranded")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel payment" })).toBeInTheDocument();
  });

  it("Slice S1: the server-bound passkey reaches the signing call, and the Turnkey activity id reaches /submit", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    const submitBodies: unknown[] = [];
    routeFetch((url, method, body) => {
      if (url.endsWith("/api/real/payments/latest") && method === "GET") return jsonResponse(200, { attempt: null });
      if (url.endsWith("/api/real/payments/prepare") && method === "POST") {
        // A client-typed credential is never sent: prepare's body is recipient + amount only.
        expect(Object.keys(body as object).sort()).toEqual(["amountBaseUnits", "recipient"]);
        return jsonResponse(200, { attempt: attemptFixture(), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-P" });
      }
      if (url.endsWith("/api/real/payments/submit") && method === "POST") {
        submitBodies.push(body);
        return jsonResponse(200, { attempt: attemptFixture({ state: "submitted" }) });
      }
      return null;
    });
    signPreparedPaymentMock.mockResolvedValueOnce({ signature: "0xsignature", activityId: "activity-P-1" });

    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("To"), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-review")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(submitBodies).toHaveLength(1));
    expect(signPreparedPaymentMock).toHaveBeenCalledWith(expect.objectContaining({ authorizingCredentialId: "credential-P" }));
    expect(submitBodies[0]).toEqual({ attemptId: "payment-attempt-1", signature: "0xsignature", activityId: "activity-P-1" });
  });

  it("Slice S1: a payment bound to a different passkey restores as cancel-only with an explanation — never a Continue that would sign", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    routeFetch((url, method) => {
      // What /latest returns when the session's passkey isn't the payment's bound one.
      if (url.endsWith("/api/real/payments/latest") && method === "GET") return jsonResponse(200, { attempt: attemptFixture(), subOrganizationId: null, authorizingCredentialId: null });
      return null;
    });

    render(<RealPayForm />);

    await waitFor(() => expect(screen.getByTestId("real-pay-stranded")).toBeInTheDocument());
    expect(screen.getByText(/started with a different passkey/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    expect(signPreparedPaymentMock).not.toHaveBeenCalled();
  });

  it("Slice S1: when the server can't confirm the approval yet, Continue re-sends the SAME approval — no second passkey prompt", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    const submitBodies: unknown[] = [];
    routeFetch((url, method, body) => {
      if (url.endsWith("/api/real/payments/latest") && method === "GET") return jsonResponse(200, { attempt: null });
      if (url.endsWith("/api/real/payments/prepare") && method === "POST") {
        return jsonResponse(200, { attempt: attemptFixture(), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-P" });
      }
      if (url.endsWith("/api/real/payments/submit") && method === "POST") {
        submitBodies.push(body);
        if (submitBodies.length === 1) return jsonResponse(503, { error: "We couldn't confirm your passkey approval yet. Try again in a moment.", retryable: true });
        return jsonResponse(200, { attempt: attemptFixture({ state: "submitted" }) });
      }
      return null;
    });
    signPreparedPaymentMock.mockResolvedValueOnce({ signature: "0xsignature", activityId: "activity-P-1" });

    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("To"), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-review")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());
    expect(screen.getByText(/couldn't confirm your passkey approval yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(submitBodies).toHaveLength(2));
    expect(submitBodies[1]).toEqual(submitBodies[0]);
    expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
  });

  it("Part C (S2): the resume screen shows the FULL recipient address and a stolen-cookie warning, not only a 4+4 shortened form", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    routeFetch((url, method) => {
      if (url.endsWith("/api/real/payments/latest") && method === "GET") {
        return jsonResponse(200, { attempt: attemptFixture(), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: 1_900_000_000 });
      }
      return null;
    });

    render(<RealPayForm />);

    await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());
    expect(screen.getByText(RECIPIENT, { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/Only continue if you started this payment/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });

  it("Part B (S2): an already-expired awaiting_authorization attempt auto-reconciles and shows the expiry-confirming copy, not the ordinary resume prompt", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    const validUntil = 1_900_000_600;
    let statusCallCount = 0;
    routeFetch((url, method) => {
      if (url.endsWith("/api/real/payments/latest") && method === "GET") {
        return jsonResponse(200, {
          attempt: attemptFixture({ prepared: { ...PREPARED_FIELDS, validUntil } }),
          subOrganizationId: "sub-org-1",
          authorizingCredentialId: "credential-1",
          serverNowSeconds: validUntil + 100,
        });
      }
      if (url.includes("/status") && method === "GET") {
        statusCallCount += 1;
        return jsonResponse(200, {
          attempt: attemptFixture({ state: "failed", failureReason: "This payment expired before it was included on-chain. No money moved.", prepared: { ...PREPARED_FIELDS, validUntil } }),
          serverNowSeconds: validUntil + 100,
        });
      }
      return null;
    });

    render(<RealPayForm />);

    await waitFor(() => expect(screen.getByTestId("real-pay-failed")).toBeInTheDocument());
    expect(statusCallCount).toBe(1);
    expect(screen.getByText(/No money moved/)).toBeInTheDocument();
  });

  it("S2: an expired attempt still awaiting finality shows neutral pre-proof copy — never 'No money moved' or 'nothing moved'", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    const validUntil = 1_900_000_600;
    const stillPending = () =>
      jsonResponse(200, {
        attempt: attemptFixture({ prepared: { ...PREPARED_FIELDS, validUntil } }),
        subOrganizationId: "sub-org-1",
        authorizingCredentialId: "credential-1",
        serverNowSeconds: validUntil + 100,
      });
    routeFetch((url, method) => {
      if (url.endsWith("/api/real/payments/latest") && method === "GET") return stillPending();
      if (url.includes("/status") && method === "GET") return stillPending(); // finality hasn't caught up yet
      return null;
    });

    render(<RealPayForm />);

    await waitFor(() => expect(screen.getByText(/approval window expired/)).toBeInTheDocument());
    expect(screen.getByText(/waiting for final confirmation before showing the final result/)).toBeInTheDocument();
    expect(screen.queryByText(/no money moved/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/nothing moved/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel payment" })).toBeInTheDocument();
    act(() => useRealPaymentStore.getState().reset()); // clear the pending follow-up timer
  });

  it("Part B (S2): a still-valid awaiting_authorization attempt shows the ordinary resume prompt with Continue, not the expiry copy", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    const validUntil = 1_900_000_600;
    routeFetch((url, method) => {
      if (url.endsWith("/api/real/payments/latest") && method === "GET") {
        return jsonResponse(200, {
          attempt: attemptFixture({ prepared: { ...PREPARED_FIELDS, validUntil } }),
          subOrganizationId: "sub-org-1",
          authorizingCredentialId: "credential-1",
          serverNowSeconds: validUntil - 500,
        });
      }
      return null;
    });

    render(<RealPayForm />);

    await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
    expect(screen.queryByText(/confirming nothing moved/)).not.toBeInTheDocument();
  });

  it("Slice S1: a prepare response with no bound passkey never reaches the signing call — cancel-only", async () => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready" });
    routeFetch((url, method) => {
      if (url.endsWith("/api/real/payments/latest") && method === "GET") return jsonResponse(200, { attempt: null });
      if (url.endsWith("/api/real/payments/prepare") && method === "POST") return jsonResponse(200, { attempt: attemptFixture(), subOrganizationId: "sub-org-1" });
      return null;
    });

    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("To"), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-review")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(screen.getByTestId("real-pay-stranded")).toBeInTheDocument());
    expect(signPreparedPaymentMock).not.toHaveBeenCalled();
  });
});

/** Handle Pay Slice C — one "To" field: an @name is looked up on blur / Review; an address goes straight through. */
describe("RealPayForm — Slice C: paying by @name", () => {
  const FOUND_SMIT = { found: true, handle: "smit", displayName: "Smit Patel", isSelf: false };

  beforeEach(() => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready", error: null, hasHydrated: true });
    useRealBalanceStore.setState({ balance: { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" }, status: "ready", error: null });
    useRealPaymentStore.getState().reset();
    useRealPaymentStore.setState({ status: "idle" });
    signPreparedPaymentMock.mockReset();
    vi.unstubAllGlobals();
  });

  type Routes = {
    latest?: () => Response;
    lookup?: (body: { handle: string }) => Response;
    prepare?: (body: unknown) => Response;
    submit?: () => Response;
    status?: () => Response;
  };

  function stubRoutes(routes: Routes) {
    const lookups: unknown[] = [];
    const prepares: unknown[] = [];
    routeFetch((url, method, body) => {
      if (url.endsWith("/api/real/payments/latest") && method === "GET") return routes.latest?.() ?? jsonResponse(200, { attempt: null });
      if (url.endsWith("/api/real/recipients/lookup") && method === "POST" && routes.lookup) {
        lookups.push(body);
        return routes.lookup(body as { handle: string });
      }
      if (url.endsWith("/api/real/payments/prepare") && method === "POST" && routes.prepare) {
        prepares.push(body);
        return routes.prepare(body);
      }
      if (url.endsWith("/api/real/payments/submit") && method === "POST" && routes.submit) return routes.submit();
      if (url.endsWith("/api/real/account/balance")) return jsonResponse(200, { token: "USDC", decimals: 6, balanceBaseUnits: "19000000" });
      if (url.includes("/status")) return routes.status?.() ?? jsonResponse(200, { attempt: attemptFixture({ state: "submitted" }), serverNowSeconds: 1_900_000_000 });
      return null;
    });
    return { lookups, prepares };
  }

  const prepareOk = () => jsonResponse(200, { attempt: attemptFixture(), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: 1_900_000_000 });

  async function renderForm() {
    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
    return screen.getByLabelText("To");
  }

  it("the field is labelled 'To', hints @name only, and turns off capitalization/correction/spellcheck", async () => {
    stubRoutes({});
    const input = await renderForm();

    expect(input).toHaveAttribute("placeholder", "@name");
    expect(input).toHaveAttribute("autocapitalize", "none");
    expect(input).toHaveAttribute("autocorrect", "off");
    expect(input).toHaveAttribute("spellcheck", "false");
    expect(input).toHaveAttribute("aria-describedby", "real-pay-recipient-status");
    expect(screen.getByTestId("real-pay-recipient-status")).toHaveAttribute("role", "status");
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(screen.getByTestId("real-pay-form").textContent).not.toMatch(/0x|address|wallet|Sepolia/i);
  });

  it("typing sends nothing; blur checks the name once and shows the display name with its @name", async () => {
    let release: (response: Response) => void = () => {};
    const { lookups } = stubRoutes({});
    const input = await renderForm();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/api/real/recipients/lookup")) {
        lookups.push(JSON.parse(init?.body as string));
        return new Promise<Response>((resolve) => (release = resolve));
      }
      throw new Error(`Unhandled fetch in test: ${String(url)}`);
    });

    for (const value of ["@", "@s", "@sm", "@smi", "@Smit"]) fireEvent.change(input, { target: { value } });
    expect(lookups).toHaveLength(0);
    expect(screen.getByTestId("real-pay-recipient-status")).toBeEmptyDOMElement();

    fireEvent.blur(input);
    expect(lookups).toEqual([{ handle: "smit" }]);
    expect(screen.getByText("Checking…")).toBeInTheDocument();

    await act(async () => release(jsonResponse(200, FOUND_SMIT)));
    const status = screen.getByTestId("real-pay-recipient-status");
    expect(status).toHaveTextContent("Smit Patel");
    expect(status).toHaveTextContent("@smit");
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).toHaveValue("@Smit"); // the typed text is left alone
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Review" })); // focus is not moved

    fireEvent.blur(input);
    expect(lookups).toHaveLength(1);
  });

  it("a found name with no display name shows the @name alone", async () => {
    stubRoutes({ lookup: () => jsonResponse(200, { ...FOUND_SMIT, displayName: null }) });
    const input = await renderForm();
    fireEvent.change(input, { target: { value: "smit" } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByTestId("real-pay-recipient-status")).toHaveTextContent(/^@smit$/));
  });

  it("not found: says so, marks the field invalid, and Review stays on the form", async () => {
    const { lookups } = stubRoutes({ lookup: () => jsonResponse(200, { found: false }) });
    const input = await renderForm();
    fireEvent.change(input, { target: { value: "@nobody" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.00" } });
    fireEvent.blur(input);

    await waitFor(() => expect(screen.getByText("We couldn't find anyone with that name.")).toBeInTheDocument());
    expect(input).toHaveAttribute("aria-invalid", "true");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByTestId("real-pay-form")).toBeInTheDocument();
    expect(lookups).toHaveLength(1);

    // Editing clears it straight away.
    fireEvent.change(input, { target: { value: "@nobod" } });
    expect(screen.queryByText("We couldn't find anyone with that name.")).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("a failed check says to try again, and the next blur retries", async () => {
    let calls = 0;
    stubRoutes({ lookup: () => (++calls === 1 ? jsonResponse(500, { error: "Something went wrong." }) : jsonResponse(200, FOUND_SMIT)) });
    const input = await renderForm();
    fireEvent.change(input, { target: { value: "@smit" } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByText("Couldn't check that name. Try again.")).toBeInTheDocument());

    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByTestId("real-pay-recipient-status")).toHaveTextContent("Smit Patel"));
    expect(calls).toBe(2);
  });

  it("your own @name: 'That's your own @name.' with no request, and Review refuses", async () => {
    useRealAccountStore.setState({ account: { ...ACCOUNT, handle: "smit", displayName: "Smit Patel" } });
    const { lookups } = stubRoutes({});
    const input = await renderForm();
    fireEvent.change(input, { target: { value: "@Smit" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.00" } });
    expect(screen.queryByText("That's your own @smit.")).not.toBeInTheDocument(); // not while typing

    fireEvent.blur(input);
    expect(screen.getByText("That's your own @smit.")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByTestId("real-pay-form")).toBeInTheDocument();
    expect(screen.getAllByText("That's your own @smit.")).toHaveLength(1); // not repeated as a second error line
    expect(lookups).toHaveLength(0);
  });

  it("a malformed name gets feedback after blur (not while typing) and is never looked up", async () => {
    const { lookups } = stubRoutes({});
    const input = await renderForm();
    fireEvent.change(input, { target: { value: "@s" } });
    expect(screen.queryByText("Enter a valid @name.")).not.toBeInTheDocument();
    fireEvent.blur(input);
    expect(screen.getByText("Enter a valid @name.")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(lookups).toHaveLength(0);
  });

  it("a partial 0x input is address feedback, never a name lookup", async () => {
    const { lookups } = stubRoutes({});
    const input = await renderForm();
    fireEvent.change(input, { target: { value: "0x3333" } });
    fireEvent.blur(input);
    expect(screen.getByText("Enter a valid account address.")).toBeInTheDocument();
    expect(lookups).toHaveLength(0);
  });

  it("pressing Review with an unchecked @name looks it up, then shows display name + @name on the review screen", async () => {
    const { lookups } = stubRoutes({ lookup: () => jsonResponse(200, FOUND_SMIT) });
    const input = await renderForm();
    fireEvent.change(input, { target: { value: "smit" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.00" } });
    fireEvent.submit(screen.getByTestId("real-pay-form")); // Enter in a field: no blur happened

    await waitFor(() => expect(screen.getByTestId("real-pay-review")).toBeInTheDocument());
    expect(lookups).toEqual([{ handle: "smit" }]);
    const review = screen.getByTestId("real-pay-review");
    expect(review).toHaveTextContent("Smit Patel");
    expect(review).toHaveTextContent("@smit");
    expect(review.textContent).not.toMatch(/0x/);
  });

  it("the review screen shows the @name alone when there is no display name", async () => {
    stubRoutes({ lookup: () => jsonResponse(200, { ...FOUND_SMIT, displayName: null }) });
    const input = await renderForm();
    fireEvent.change(input, { target: { value: "@smit" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));

    await waitFor(() => expect(screen.getByTestId("real-pay-review")).toBeInTheDocument());
    expect(screen.getByText("@smit")).toBeInTheDocument();
    expect(screen.getByTestId("real-pay-review").textContent).not.toMatch(/0x|null/);
  });

  // ---- Slice D: after prepare, the recipient's name comes from attempt.recipientIdentity (the server's stored snapshot).
  const STORED = { handle: "smit", displayName: "Smit P. (stored)" };
  const restored = (overrides: Record<string, unknown> = {}) => () =>
    jsonResponse(200, { attempt: attemptFixture(overrides), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: 1_900_000_000 });

  it("Review shows the advisory lookup; after prepare the approval, sending, and sent screens show the attempt's AUTHORITATIVE identity — the stored snapshot wins over the lookup's name", async () => {
    const { prepares, lookups } = stubRoutes({
      lookup: () => jsonResponse(200, FOUND_SMIT), // advisory: "Smit Patel"
      prepare: () => jsonResponse(200, { attempt: attemptFixture({ recipientIdentity: STORED }), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: 1_900_000_000 }),
      // L-2 D-7: submit answers "submitted"; the existing status path establishes "confirmed".
      submit: () => jsonResponse(200, { attempt: attemptFixture({ state: "submitted", transactionHash: "0xabc123", recipientIdentity: STORED }) }),
      status: () => jsonResponse(200, { attempt: attemptFixture({ state: "confirmed", transactionHash: "0xabc123", recipientIdentity: STORED }), serverNowSeconds: 1_900_000_000 }),
    });
    signPreparedPaymentMock.mockRejectedValueOnce(Object.assign(new Error("cancelled"), { name: "NotAllowedError" }));
    let finishSigning: (value: { signature: string; activityId: string }) => void = () => {};
    signPreparedPaymentMock.mockImplementationOnce(() => new Promise((resolve) => (finishSigning = resolve)));

    const input = await renderForm();
    fireEvent.change(input, { target: { value: "@smit" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));

    // Before prepare there is no attempt: Review shows what the lookup said.
    await waitFor(() => expect(screen.getByTestId("real-pay-review")).toBeInTheDocument());
    expect(screen.getByTestId("real-pay-review")).toHaveTextContent("Smit Patel");
    expect(screen.getByTestId("real-pay-review")).toHaveTextContent("@smit");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    // Passkey prompt dismissed -> the pending-approval screen, now from the attempt.
    await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());
    expect(prepares).toEqual([{ recipientHandle: "smit", amountBaseUnits: "1000000" }]);
    expect(screen.getByText("To: Smit P. (stored) (@smit)")).toBeInTheDocument();
    expect(screen.queryByText(/Smit Patel/)).not.toBeInTheDocument();
    expect(screen.queryByText(RECIPIENT, { exact: false })).not.toBeInTheDocument();
    expect(screen.getByText(/Only continue if you started this payment/)).toBeInTheDocument();

    // Sending.
    act(() => useRealPaymentStore.setState({ status: "submitting" }));
    expect(screen.getByTestId("real-pay-sending")).toHaveTextContent("To Smit P. (stored) (@smit)");
    act(() => useRealPaymentStore.setState({ status: "awaiting_authorization" }));

    // Continue -> sent.
    await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await act(async () => finishSigning({ signature: "0xsignature", activityId: "activity-1" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-confirmed")).toBeInTheDocument());
    expect(screen.getByTestId("real-pay-confirmed")).toHaveTextContent("to Smit P. (stored) (@smit)");
    expect(screen.getByTestId("real-pay-confirmed").textContent).not.toContain("0x3333");
    expect(lookups).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Send another payment" }));
    expect(useRealPaymentStore.getState()).toMatchObject({ attempt: null, recipientLookup: { status: "idle" }, recipientInput: "" });
  });

  it("a handle payment with no display name is named by its @name alone on the approval screen", async () => {
    stubRoutes({
      lookup: () => jsonResponse(200, { ...FOUND_SMIT, displayName: null }),
      prepare: () => jsonResponse(200, { attempt: attemptFixture({ recipientIdentity: { handle: "smit", displayName: null } }), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: 1_900_000_000 }),
    });
    signPreparedPaymentMock.mockRejectedValueOnce(Object.assign(new Error("cancelled"), { name: "NotAllowedError" }));
    const input = await renderForm();
    fireEvent.change(input, { target: { value: "@smit" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-review")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(screen.getByText("To: @smit")).toBeInTheDocument());
    act(() => useRealPaymentStore.getState().reset());
  });

  it("RELOAD: a restored handle payment waiting for approval shows Name (@handle) and the warning — from /latest alone, with no lookup", async () => {
    const { lookups } = stubRoutes({ latest: restored({ recipientIdentity: STORED }) });
    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());

    expect(screen.getByText("To: Smit P. (stored) (@smit)")).toBeInTheDocument();
    expect(screen.queryByText(RECIPIENT, { exact: false })).not.toBeInTheDocument();
    expect(screen.getByText(/Only continue if you started this payment/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
    expect(lookups).toHaveLength(0);
    expect(useRealPaymentStore.getState()).toMatchObject({ recipientInput: "", recipientLookup: { status: "idle" } });
    expect(signPreparedPaymentMock).not.toHaveBeenCalled();
    act(() => useRealPaymentStore.getState().reset());
  });

  it("RELOAD: a restored handle payment with no display name shows '@handle' alone", async () => {
    stubRoutes({ latest: restored({ recipientIdentity: { handle: "smit", displayName: null } }) });
    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());
    expect(screen.getByText("To: @smit")).toBeInTheDocument();
    expect(screen.queryByText(RECIPIENT, { exact: false })).not.toBeInTheDocument();
    act(() => useRealPaymentStore.getState().reset());
  });

  it("RELOAD: a restored confirmed handle payment shows 'Sent … to Name (@handle)' from the stored snapshot", async () => {
    const { lookups } = stubRoutes({ latest: restored({ state: "confirmed", prepared: null, transactionHash: "0xabc123", recipientIdentity: { handle: "smit", displayName: "Smit Patel" } }) });
    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-confirmed")).toBeInTheDocument());
    expect(screen.getByTestId("real-pay-confirmed")).toHaveTextContent("$1.00 to Smit Patel (@smit)");
    expect(screen.getByTestId("real-pay-confirmed").textContent).not.toContain("0x3333");
    expect(lookups).toHaveLength(0);
  });

  it("RELOAD: a restored submitted handle payment keeps its name through the status check that confirms it", async () => {
    stubRoutes({
      latest: restored({ state: "submitted", prepared: null, recipientIdentity: STORED }),
      status: () => jsonResponse(200, { attempt: attemptFixture({ state: "confirmed", prepared: null, transactionHash: "0xabc123", recipientIdentity: STORED }), serverNowSeconds: 1_900_000_000 }),
    });
    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-confirmed")).toBeInTheDocument());
    expect(screen.getByTestId("real-pay-confirmed")).toHaveTextContent("to Smit P. (stored) (@smit)");
    expect(useRealPaymentStore.getState().attempt).toMatchObject({ state: "confirmed", recipientIdentity: STORED });
  });

  it("ADDRESS: a restored address payment still shows the FULL address on approval and the shortened one when sent — never a name", async () => {
    stubRoutes({ latest: restored({ recipientIdentity: null }) });
    const first = render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());
    expect(screen.getByText(`To: ${RECIPIENT}`)).toBeInTheDocument();
    expect(screen.getByText(/Only continue if you started this payment/)).toBeInTheDocument();
    expect(screen.getByTestId("real-pay-resume").textContent).not.toContain("@");
    act(() => useRealPaymentStore.getState().reset());
    first.unmount();

    useRealPaymentStore.setState({ status: "idle" });
    stubRoutes({ latest: restored({ state: "confirmed", prepared: null, transactionHash: "0xabc123", recipientIdentity: null }) });
    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-confirmed")).toBeInTheDocument());
    expect(screen.getByTestId("real-pay-confirmed")).toHaveTextContent("$1.00 to 0x3333…3333");
    expect(screen.getByTestId("real-pay-confirmed").textContent).not.toContain("@");
  });

  it("a malformed recipientIdentity from the server falls back to the address — nothing is repaired or half-shown", async () => {
    const malformed: unknown[] = [
      { handle: "@smit", displayName: "Smit Patel" },
      { handle: "Smit", displayName: "Smit Patel" },
      { displayName: "Smit Patel" },
      { handle: "smit" },
      { handle: "smit", displayName: "" },
      { handle: "smit", displayName: 7 },
      { handle: "smit", displayName: "Smit Patel", appUserId: "app-user-2" },
      "smit",
      undefined,
    ];
    for (const recipientIdentity of malformed) {
      useRealPaymentStore.setState({ status: "idle" });
      stubRoutes({ latest: restored({ recipientIdentity }) });
      const view = render(<RealPayForm />);
      await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());
      expect(screen.getByText(`To: ${RECIPIENT}`), JSON.stringify(recipientIdentity)).toBeInTheDocument();
      expect(screen.getByTestId("real-pay-resume").textContent, JSON.stringify(recipientIdentity)).not.toMatch(/Smit|@|app-user/);
      act(() => useRealPaymentStore.getState().reset());
      view.unmount();
    }
  });

  it("prepare 404 after a found name: back on the form with the text kept and the server's message", async () => {
    stubRoutes({ lookup: () => jsonResponse(200, FOUND_SMIT), prepare: () => jsonResponse(404, { error: "We couldn't find anyone with that name." }) });
    const input = await renderForm();
    fireEvent.change(input, { target: { value: "@smit" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-review")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
    expect(screen.getByLabelText("To")).toHaveValue("@smit");
    expect(screen.getByText("We couldn't find anyone with that name.")).toBeInTheDocument();
    expect(screen.queryByText("Smit Patel")).not.toBeInTheDocument();
  });

  it("direct address: neutral helper, zero lookups, shortened address on review and on the sent screen, unchanged prepare body", async () => {
    const { lookups, prepares } = stubRoutes({
      lookup: () => jsonResponse(200, FOUND_SMIT),
      prepare: prepareOk,
      // L-2 D-7: submit answers "submitted"; the existing status path establishes "confirmed".
      submit: () => jsonResponse(200, { attempt: attemptFixture({ state: "submitted", transactionHash: "0xabc123" }) }),
      status: () => jsonResponse(200, { attempt: attemptFixture({ state: "confirmed", transactionHash: "0xabc123" }), serverNowSeconds: 1_900_000_000 }),
    });
    signPreparedPaymentMock.mockResolvedValueOnce({ signature: "0xsignature", activityId: "activity-1" });
    const input = await renderForm();
    fireEvent.change(input, { target: { value: RECIPIENT } });
    fireEvent.blur(input);
    expect(screen.getByText("Sending to account address 0x3333…3333")).toBeInTheDocument();
    expect(input).not.toHaveAttribute("aria-invalid");

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByTestId("real-pay-review")).toBeInTheDocument(); // synchronous — no waitFor
    expect(screen.getByTestId("real-pay-review")).toHaveTextContent("0x3333…3333");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(screen.getByTestId("real-pay-confirmed")).toBeInTheDocument());
    expect(screen.getByTestId("real-pay-confirmed")).toHaveTextContent("to 0x3333…3333");
    expect(lookups).toHaveLength(0);
    expect(prepares).toEqual([{ recipient: RECIPIENT, amountBaseUnits: "1000000" }]);
    expect(useRealPaymentStore.getState().attempt).toMatchObject({ recipientIdentity: null });
    expect(screen.getByTestId("real-pay-confirmed").textContent).not.toContain("@");
  });

  // ---- Slice E: rate limiting, as the person sees it.
  it("a rate-limited name check says 'Too many tries. Try again later.' — not the generic failure — and never retries by itself", async () => {
    const { lookups } = stubRoutes({ lookup: () => jsonResponse(429, { error: "Too many tries. Try again later.", code: "rate_limited" }) });
    const input = await renderForm();
    fireEvent.change(input, { target: { value: "@smit" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.00" } });
    fireEvent.blur(input);

    await waitFor(() => expect(screen.getByText("Too many tries. Try again later.")).toBeInTheDocument());
    expect(screen.queryByText("Couldn't check that name. Try again.")).not.toBeInTheDocument();
    expect(screen.getByTestId("real-pay-recipient-status")).toHaveTextContent(/^Too many tries\. Try again later\.$/);
    expect(screen.getByTestId("real-pay-form").textContent).not.toMatch(/429|rate.?limit|Retry-After|seconds/i); // no HTTP jargon, no countdown
    expect(lookups).toHaveLength(1);

    // Leaving the field again does not ask again; nothing happens in the background.
    fireEvent.blur(input);
    fireEvent.blur(input);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(lookups).toHaveLength(1);

    // Review asks once more (an explicit press), stays on the form, and shows the message once.
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(lookups).toHaveLength(2));
    expect(screen.getByTestId("real-pay-form")).toBeInTheDocument();
    expect(screen.queryByTestId("real-pay-review")).not.toBeInTheDocument();
    expect(screen.getAllByText("Too many tries. Try again later.")).toHaveLength(1);

    // Editing clears it straight away.
    fireEvent.change(input, { target: { value: "@smi" } });
    expect(screen.queryByText("Too many tries. Try again later.")).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("a rate-limited prepare returns to the form with the server's message, the name still resolved, and no second prepare", async () => {
    const { prepares, lookups } = stubRoutes({
      lookup: () => jsonResponse(200, FOUND_SMIT),
      prepare: () => jsonResponse(429, { error: "You're going a bit fast. Try again later.", code: "rate_limited" }),
    });
    const input = await renderForm();
    fireEvent.change(input, { target: { value: "@smit" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-review")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
    expect(screen.getByText("You're going a bit fast. Try again later.")).toBeInTheDocument();
    expect(screen.queryByText("We couldn't find anyone with that name.")).not.toBeInTheDocument();
    expect(screen.getByLabelText("To")).toHaveValue("@smit");
    expect(screen.getByTestId("real-pay-recipient-status")).toHaveTextContent("Smit Patel"); // still resolved
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(prepares).toHaveLength(1);
    expect(lookups).toHaveLength(1);
    expect(signPreparedPaymentMock).not.toHaveBeenCalled();
  });
});

/**
 * 3A-1 Stage 2A: the page's side of status-polling safety — it reports
 * visibility, cleans up on unmount, and offers a cooldown-limited manual
 * check. The timer arithmetic itself is covered in real-payment-store.test.ts.
 */
describe("RealPayForm — 3A-1 Stage 2A: status polling safety", () => {
  const VALID_UNTIL = 1_900_000_600;

  function setVisibility(state: "visible" | "hidden") {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  beforeEach(() => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready", error: null, hasHydrated: true });
    useRealBalanceStore.setState({ balance: { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" }, status: "ready", error: null });
    useRealPaymentStore.getState().reset();
    useRealPaymentStore.setState({ status: "idle" });
    signPreparedPaymentMock.mockReset();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    Reflect.deleteProperty(document, "visibilityState");
  });

  /** A restored `submitted` attempt (or an expired awaiting one) and a /status that never resolves it. */
  function stubServer(kind: "submitted" | "expired") {
    const statusCalls: string[] = [];
    routeFetch((url, method) => {
      if (url.endsWith("/api/real/payments/latest") && method === "GET") {
        return kind === "submitted"
          ? jsonResponse(200, { attempt: attemptFixture({ state: "submitted", prepared: null }), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: 1_900_000_000 })
          : jsonResponse(200, {
              attempt: attemptFixture({ prepared: { ...PREPARED_FIELDS, validUntil: VALID_UNTIL } }),
              subOrganizationId: "sub-org-1",
              authorizingCredentialId: "credential-1",
              serverNowSeconds: VALID_UNTIL + 100,
            });
      }
      if (url.includes("/status") && method === "GET") {
        statusCalls.push(url);
        return kind === "submitted"
          ? jsonResponse(200, { attempt: attemptFixture({ state: "submitted", prepared: null }), serverNowSeconds: 1_900_000_000 })
          : jsonResponse(200, { attempt: attemptFixture({ prepared: { ...PREPARED_FIELDS, validUntil: VALID_UNTIL } }), serverNowSeconds: VALID_UNTIL + 100 });
      }
      return null;
    });
    return statusCalls;
  }

  it("a hidden page starts no automatic status check; becoming visible runs exactly one", async () => {
    setVisibility("hidden");
    const statusCalls = stubServer("submitted");

    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-sending")).toBeInTheDocument());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(statusCalls).toHaveLength(0);

    await act(async () => setVisibility("visible"));
    await waitFor(() => expect(statusCalls).toHaveLength(1));
    await act(async () => {
      setVisibility("hidden");
      setVisibility("visible");
    });
    expect(statusCalls).toHaveLength(1);
  });

  it("unmounting the form stops its automatic work: no status request starts afterwards, and nothing is cancelled", async () => {
    setVisibility("visible");
    const statusCalls = stubServer("submitted");

    const { unmount } = render(<RealPayForm />);
    await waitFor(() => expect(statusCalls).toHaveLength(1));
    unmount();

    await useRealPaymentStore.getState().checkStatus(); // a stale caller after unmount
    await useRealPaymentStore.getState().checkSubmittedStatus();
    await act(async () => setVisibility("hidden"));
    await act(async () => setVisibility("visible"));

    expect(statusCalls).toHaveLength(1);
    // The payment itself was not touched: still the submitted attempt, never reset or finalized.
    expect(useRealPaymentStore.getState().attempt?.state).toBe("submitted");
    expect(useRealPaymentStore.getState().status).toBe("submitted");
  });

  it("Check status: one press sends one request, then the control is disabled ('Checked just now') and extra presses send nothing", async () => {
    setVisibility("visible");
    const statusCalls = stubServer("submitted");

    render(<RealPayForm />);
    const button = await screen.findByRole("button", { name: "Check status" });
    await waitFor(() => expect(statusCalls).toHaveLength(1)); // the automatic post-submit check

    fireEvent.click(button);
    await waitFor(() => expect(statusCalls).toHaveLength(2));
    const cooling = await screen.findByRole("button", { name: "Checked just now" });
    expect(cooling).toBeDisabled();
    fireEvent.click(cooling);
    fireEvent.click(cooling);
    expect(statusCalls).toHaveLength(2);
    // Still an unresolved payment — not shown as failed or finished.
    expect(screen.getByTestId("real-pay-sending")).toBeInTheDocument();
  });

  it("when the automatic follow-ups run out, the page says it is still waiting and keeps a manual Check status — never a failure", async () => {
    setVisibility("visible");
    const statusCalls = stubServer("expired");

    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByText(/approval window expired/)).toBeInTheDocument());
    await waitFor(() => expect(statusCalls).toHaveLength(1));
    // While follow-ups are still scheduled there is no extra control.
    expect(screen.queryByRole("button", { name: "Check status" })).not.toBeInTheDocument();

    act(() => useRealPaymentStore.setState({ isFollowUpExhausted: true }));

    expect(screen.getByText(/still waiting for an update/)).toBeInTheDocument();
    expect(screen.queryByText(/failed|no money moved|nothing moved/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel payment" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    await waitFor(() => expect(statusCalls).toHaveLength(2));
    expect(screen.getByRole("button", { name: "Checked just now" })).toBeDisabled();
    // No protocol vocabulary in the copy.
    expect(document.body.textContent).not.toMatch(/UserOperation|bundler|RPC|Pimlico|bucket|budget/i);
  });
  it("LOW-1: when follow-ups run out while the validity flag is still stale-false, the pending payment keeps its Check status — on both the approval and the cancel-only screens", async () => {
    setVisibility("visible");
    for (const state of ["awaiting_authorization", "signed"]) {
      const statusCalls: string[] = [];
      routeFetch((url, method) => {
        if (url.endsWith("/api/real/payments/latest") && method === "GET") {
          return jsonResponse(200, {
            attempt: attemptFixture({ state, prepared: { ...PREPARED_FIELDS, validUntil: VALID_UNTIL } }),
            subOrganizationId: "sub-org-1",
            authorizingCredentialId: "credential-1",
            serverNowSeconds: VALID_UNTIL - 1_000, // far from expiry: the flag is false
          });
        }
        if (url.includes("/status") && method === "GET") {
          statusCalls.push(url);
          return jsonResponse(500, { error: "Could not check payment status." });
        }
        return null;
      });

      const { unmount } = render(<RealPayForm />);
      await waitFor(() => expect(screen.getByTestId(state === "signed" ? "real-pay-stranded" : "real-pay-resume")).toBeInTheDocument());
      expect(screen.queryByRole("button", { name: "Check status" }), state).not.toBeInTheDocument();

      act(() => useRealPaymentStore.setState({ isFollowUpExhausted: true, isAttemptPastValidity: false }));

      const button = screen.getByRole("button", { name: "Check status" });
      expect(screen.getByRole("button", { name: "Cancel payment" })).toBeInTheDocument();
      expect(screen.queryByText(/failed|no money moved/i)).not.toBeInTheDocument();
      fireEvent.click(button);
      await waitFor(() => expect(statusCalls).toHaveLength(1));
      // The refusal is reported; the payment is neither finished nor failed, and the control comes back after its cooldown.
      await waitFor(() => expect(screen.getByRole("button", { name: "Checked just now" })).toBeDisabled());
      expect(useRealPaymentStore.getState().status).toBe(state === "signed" ? "stranded" : "awaiting_authorization");
      fireEvent.click(screen.getByRole("button", { name: "Checked just now" }));
      expect(statusCalls).toHaveLength(1);
      unmount();
    }
  });
});

/**
 * 3A-1 Stage 2C-2: what the Pay screen says when the server declines a status
 * check, and what its balance line says when there is no balance to show.
 */
describe("RealPayForm — 3A-1 Stage 2C-2: deferral and balance line", () => {
  function setVisibilityVisible() {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  }

  beforeEach(() => {
    setVisibilityVisible();
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready", error: null, hasHydrated: true });
    useRealBalanceStore.setState({ balance: { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" }, status: "ready", error: null, retryAfterSeconds: null, isCoolingDown: false });
    useRealPaymentStore.getState().reset();
    useRealPaymentStore.setState({ status: "idle" });
    signPreparedPaymentMock.mockReset();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    Reflect.deleteProperty(document, "visibilityState");
  });

  async function renderEditing() {
    routeFetch((url, method) => (url.endsWith("/api/real/payments/latest") && method === "GET" ? jsonResponse(200, { attempt: null }) : null));
    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
  }

  it("AJ-AN. with no balance the amount line says why — loading, refresh restriction, failure, signed out — and never shows a number or $0.00", async () => {
    await renderEditing();
    const cases: Array<[Partial<ReturnType<typeof useRealBalanceStore.getState>>, RegExp]> = [
      [{ status: "idle" }, /Checking your balance/],
      [{ status: "loading" }, /Checking your balance/],
      [{ status: "rate_limited", retryAfterSeconds: 600, isCoolingDown: true }, /Balance unavailable right now/],
      [{ status: "error", error: "Could not read your balance." }, /Couldn.t check your balance/],
      [{ status: "unauthenticated" }, /Sign in to see your balance/],
    ];
    for (const [state, expected] of cases) {
      act(() => useRealBalanceStore.setState({ balance: null, error: null, ...state }));
      expect(screen.getByText(expected), JSON.stringify(state)).toBeInTheDocument();
      expect(screen.queryByText(/\$0\.00|0\.00 available/)).not.toBeInTheDocument();
      expect(screen.queryByText(/available$/)).not.toBeInTheDocument();
    }
    // The restriction wording is plain: no counters, windows, or provider words.
    act(() => useRealBalanceStore.setState({ balance: null, status: "rate_limited" }));
    expect(screen.getByText("Balance unavailable right now").textContent).not.toMatch(/rate|limit|429|budget|RPC|chain/i);
  });

  it("a real balance still reads '$20.00 available' — the line only changes when there is none", async () => {
    await renderEditing();
    expect(screen.getByText("$20.00 available")).toBeInTheDocument();
  });

  it("a deferred status answer says the check is paused — not failed, not finished — and keeps the control for later", async () => {
    let statusCalls = 0;
    routeFetch((url, method) => {
      if (url.endsWith("/api/real/payments/latest") && method === "GET") {
        return jsonResponse(200, { attempt: attemptFixture({ state: "submitted", prepared: null }), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: 1_900_000_000 });
      }
      if (url.includes("/status") && method === "GET") {
        statusCalls += 1;
        return jsonResponse(200, { attempt: attemptFixture({ state: "submitted", prepared: null }), serverNowSeconds: 1_900_000_000, reconciliationDeferred: true, retryAfterSeconds: 600 });
      }
      return null;
    });

    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByText(/can.t check for an update right now/)).toBeInTheDocument());
    expect(statusCalls).toBe(1);

    expect(screen.getByTestId("real-pay-sending")).toBeInTheDocument();
    expect(screen.queryByText(/failed|no money moved|could not be sent|cancel/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/UserOperation|bundler|RPC|Pimlico|bucket|budget|429|rate_limited/i);
    // The server's pause is not "just now": the label says when, not what happened.
    const button = screen.getByRole("button", { name: "Check available later" });
    expect(button).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Checked just now" })).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(statusCalls).toBe(1);
    expect(useRealPaymentStore.getState()).toMatchObject({ status: "submitted", isStatusDeferred: true, statusRetryAfterSeconds: 600 });
  });

  it("an unusable deferral shows the generic message and leaves the last reliable payment on screen", async () => {
    routeFetch((url, method) => {
      if (url.endsWith("/api/real/payments/latest") && method === "GET") {
        return jsonResponse(200, { attempt: attemptFixture({ state: "submitted", prepared: null }), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: 1_900_000_000 });
      }
      if (url.includes("/status") && method === "GET") {
        return jsonResponse(200, { attempt: attemptFixture({ state: "failed", failureReason: "No money moved.", prepared: null }), serverNowSeconds: 1_900_000_000, reconciliationDeferred: true });
      }
      return null;
    });
    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByText(/couldn.t check on this payment just now/i)).toBeInTheDocument());
    expect(screen.getByTestId("real-pay-sending")).toBeInTheDocument();
    expect(screen.queryByTestId("real-pay-failed")).not.toBeInTheDocument();
    expect(screen.queryByText(/No money moved/)).not.toBeInTheDocument();
  });
  // ---- Stage 2C.3 ---------------------------------------------------------

  /** A restored submitted attempt whose /status answers with the given extra fields. */
  function stubSubmitted(extra: Record<string, unknown>, counter: { calls: number }) {
    routeFetch((url, method) => {
      if (url.endsWith("/api/real/payments/latest") && method === "GET") {
        return jsonResponse(200, { attempt: attemptFixture({ state: "submitted", prepared: null }), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: 1_900_000_000 });
      }
      if (url.includes("/status") && method === "GET") {
        counter.calls += 1;
        return jsonResponse(200, { attempt: attemptFixture({ state: "submitted", prepared: null }), serverNowSeconds: 1_900_000_000, reconciliationDeferred: false, ...extra });
      }
      return null;
    });
  }

  it("LOW-1: an ordinary cooldown still reads 'Checked just now' — and a server pause of 600 s or 24 h reads 'Check available later'", async () => {
    // Ordinary: a settled answer, then the manual press's own 30 s cooldown.
    const ordinary = { calls: 0 };
    stubSubmitted({}, ordinary);
    const first = render(<RealPayForm />);
    await waitFor(() => expect(ordinary.calls).toBe(1));
    fireEvent.click(await screen.findByRole("button", { name: "Check status" }));
    expect(await screen.findByRole("button", { name: "Checked just now" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Check available later" })).not.toBeInTheDocument();
    first.unmount();

    for (const seconds of [600, 86_400]) {
      useRealPaymentStore.getState().reset();
      useRealPaymentStore.setState({ status: "idle" });
      const deferred = { calls: 0 };
      stubSubmitted({ reconciliationDeferred: true, retryAfterSeconds: seconds }, deferred);
      const view = render(<RealPayForm />);
      const button = await screen.findByRole("button", { name: "Check available later" });
      expect(button, String(seconds)).toBeDisabled();
      expect(screen.queryByRole("button", { name: "Checked just now" })).not.toBeInTheDocument();
      fireEvent.click(button);
      expect(deferred.calls).toBe(1);
      view.unmount();
    }
  });

  it("LOW-1: at the deadline the control returns as 'Check status', enabled — never before, and nothing is requested meanwhile", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const counter = { calls: 0 };
      stubSubmitted({ reconciliationDeferred: true, retryAfterSeconds: 600 }, counter);
      const flush = () =>
        act(async () => {
          for (let i = 0; i < 20; i++) await Promise.resolve();
        });
      render(<RealPayForm />);
      await flush();
      expect(counter.calls).toBe(1);
      expect(screen.getByRole("button", { name: "Check available later" })).toBeDisabled();

      await act(async () => {
        vi.advanceTimersByTime(599_999);
      });
      expect(screen.getByRole("button", { name: "Check available later" })).toBeDisabled();
      expect(counter.calls).toBe(1);

      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      const ready = screen.getByRole("button", { name: "Check status" });
      expect(ready).toBeEnabled();
      expect(counter.calls).toBe(1); // nothing fires by itself

      fireEvent.click(ready);
      await flush();
      expect(counter.calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("LOW-2: when the first status read itself delivers 'submitted', the status-change effect does not send a second read", async () => {
    const validUntil = 1_900_000_600;
    let statusCalls = 0;
    routeFetch((url, method) => {
      if (url.endsWith("/api/real/payments/latest") && method === "GET") {
        return jsonResponse(200, {
          attempt: attemptFixture({ prepared: { ...PREPARED_FIELDS, validUntil } }),
          subOrganizationId: "sub-org-1",
          authorizingCredentialId: "credential-1",
          serverNowSeconds: validUntil + 100, // already expired: the form reconciles on mount
        });
      }
      if (url.includes("/status") && method === "GET") {
        statusCalls += 1;
        return jsonResponse(200, { attempt: attemptFixture({ state: "submitted", prepared: { ...PREPARED_FIELDS, validUntil } }), serverNowSeconds: validUntil + 100, reconciliationDeferred: false });
      }
      return null;
    });

    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-sending")).toBeInTheDocument());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(statusCalls).toBe(1);
    expect(useRealPaymentStore.getState().status).toBe("submitted");
  });

  it("LOW-2: a restored submitted attempt (no read delivered it) still gets exactly one check on mount", async () => {
    const counter = { calls: 0 };
    stubSubmitted({}, counter);
    render(<RealPayForm />);
    await waitFor(() => expect(counter.calls).toBe(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(counter.calls).toBe(1);
  });
  // ---- closeout -----------------------------------------------------------

  it("closeout: React Strict Mode's double mount (mount, cleanup, mount) leaves one working lifecycle — one status read, no leaked work", async () => {
    const counter = { calls: 0 };
    stubSubmitted({}, counter);
    const fetchMock = vi.mocked(globalThis.fetch);

    const view = render(
      <StrictMode>
        <RealPayForm />
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByTestId("real-pay-sending")).toBeInTheDocument());
    await waitFor(() => expect(counter.calls).toBeGreaterThanOrEqual(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    // The first (discarded) lifecycle's work was abandoned; the surviving one read once.
    expect(counter.calls).toBe(1);
    expect(useRealPaymentStore.getState().status).toBe("submitted");
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url).includes("/submit") || String(url).includes("/prepare") || (init as RequestInit | undefined)?.method === "POST")).toHaveLength(0);

    // The page still works: the control is live, and unmounting cleans up.
    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    await waitFor(() => expect(counter.calls).toBe(2));
    view.unmount();
    await useRealPaymentStore.getState().checkStatus();
    expect(counter.calls).toBe(2);
  });
});

/**
 * 3A-2 Stage 2: what the person sees when the server refuses a send because the
 * account has tried too often. The refusal is decided before any provider work,
 * so the payment is exactly as it was: still waiting for their approval.
 */
describe("RealPayForm — 3A-2 Stage 2: submit wait", () => {
  const JARGON = /turnkey|pimlico|provider|bucket|budget|rate.?limit|\b429\b|useroperation|bundler|entrypoint|retry-after/i;

  beforeEach(() => {
    useRealPaymentStore.getState().reset();
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready", error: null, hasHydrated: true });
    useRealBalanceStore.setState({ balance: { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" }, status: "ready", error: null });
    useRealPaymentStore.setState({ status: "idle", attempt: null, pendingSubmission: null, isAuthorizing: false, error: null });
    signPreparedPaymentMock.mockReset();
    signPreparedPaymentMock.mockResolvedValue({ signature: "0xsig", activityId: "activity-1" });
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    useRealPaymentStore.getState().reset();
    vi.unstubAllGlobals();
  });

  function stubServer(options: { secondsToExpiry: number; retryAfter: string | null }) {
    const now = Math.floor(Date.now() / 1000);
    const validUntil = now + options.secondsToExpiry;
    const calls = { submit: 0, cancel: 0 };
    routeFetch((url, method) => {
      if (url.endsWith("/api/real/payments/latest") && method === "GET") {
        return jsonResponse(200, {
          attempt: attemptFixture({ prepared: { ...PREPARED_FIELDS, validUntil } }),
          subOrganizationId: "sub-org-1",
          authorizingCredentialId: "credential-1",
          serverNowSeconds: now,
        });
      }
      if (url.endsWith("/api/real/payments/submit") && method === "POST") {
        calls.submit += 1;
        return new Response(
          JSON.stringify({ error: "Too many tries right now. Wait a moment, then tap Continue.", code: "rate_limited", retryable: true }),
          { status: 429, headers: { "content-type": "application/json", ...(options.retryAfter === null ? {} : { "Retry-After": options.retryAfter }) } },
        );
      }
      if (url.endsWith("/cancel") && method === "POST") {
        calls.cancel += 1;
        return jsonResponse(200, { attempt: attemptFixture({ state: "cancelled", prepared: null }) });
      }
      if (url.includes("/status")) return jsonResponse(200, { attempt: attemptFixture({ prepared: { ...PREPARED_FIELDS, validUntil } }), serverNowSeconds: Math.floor(Date.now() / 1000), reconciliationDeferred: false });
      return null;
    });
    return calls;
  }

  it("a short wait: Continue is disabled, the wording is plain, Cancel stays available, and nothing is sent again", async () => {
    const calls = stubServer({ secondsToExpiry: 1000, retryAfter: "30" });
    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-submit-wait")).toBeInTheDocument());

    expect(screen.getByTestId("real-pay-submit-wait")).toHaveTextContent("Too many attempts right now. You can try again shortly.");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel payment" })).toBeEnabled();
    expect(screen.queryByText(/tap Continue/i)).toBeNull();
    expect(screen.getByTestId("real-pay-resume").textContent).not.toMatch(JARGON);
    expect(useRealPaymentStore.getState()).toMatchObject({ status: "awaiting_authorization", pendingSubmission: { signature: "0xsig" } });

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(calls.submit).toBe(1);
    expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
  });

  it("a longer wait says roughly how long, without a countdown and without jargon", async () => {
    stubServer({ secondsToExpiry: 100_000, retryAfter: "1500" });
    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-submit-wait")).toBeInTheDocument());

    expect(screen.getByTestId("real-pay-submit-wait")).toHaveTextContent("You can try again in about 25 minutes.");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(screen.getByTestId("real-pay-resume").textContent).not.toMatch(JARGON);
  });

  it("a day-long wait is described in hours", async () => {
    stubServer({ secondsToExpiry: 200_000, retryAfter: "86400" });
    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-submit-wait")).toBeInTheDocument());
    expect(screen.getByTestId("real-pay-submit-wait")).toHaveTextContent("about 24 hours");
  });

  it("when the wait outlasts the approval: says so, promises nothing, offers no Continue — Cancel remains and works", async () => {
    const calls = stubServer({ secondsToExpiry: 100, retryAfter: "600" });
    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-approval-expiring")).toBeInTheDocument());

    expect(screen.getByTestId("real-pay-approval-expiring")).toHaveTextContent("This payment approval will expire before you can try again. You can cancel this payment and start a new one later.");
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.queryByText(/Only continue if you started this payment/)).toBeNull();
    expect(screen.queryByText(/sent|failed/i)).toBeNull();
    expect(screen.getByTestId("real-pay-resume").textContent).not.toMatch(JARGON);

    fireEvent.click(screen.getByRole("button", { name: "Cancel payment" }));
    await waitFor(() => expect(calls.cancel).toBe(1));
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
  });

  it("when the wait ends, Continue is available again and nothing was sent on its own", async () => {
    const calls = stubServer({ secondsToExpiry: 1000, retryAfter: "1" });
    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled());

    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled(), { timeout: 3000 });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    expect(calls.submit).toBe(1);
    expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("real-pay-submit-wait")).toBeNull();
  });

  it("when the wait ends but the approval cannot be used any more, Continue is NOT offered again — Cancel remains", async () => {
    // 30 s of approval left, a 1 s wait: the dispatch margin is already gone.
    const calls = stubServer({ secondsToExpiry: 30, retryAfter: "1" });
    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-approval-expiring")).toBeInTheDocument());

    // Wait out the 1 s wait (real timers), then a little more.
    await waitFor(() => expect(useRealPaymentStore.getState().isSubmitCoolingDown).toBe(false), { timeout: 3000 });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    expect(screen.getByTestId("real-pay-approval-expiring")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel payment" })).toBeEnabled();
    expect(calls.submit).toBe(1);
    expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
  });

  it("a new payment after the old one was cancelled elsewhere shows no wait, and Continue is not held by the old attempt", async () => {
    const now = Math.floor(Date.now() / 1000);
    const validUntil = now + 1000;
    const calls = { submit: 0 };
    routeFetch((url, method, body) => {
      if (url.endsWith("/api/real/payments/latest") && method === "GET") {
        return jsonResponse(200, { attempt: attemptFixture({ prepared: { ...PREPARED_FIELDS, validUntil } }), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: now });
      }
      if (url.endsWith("/api/real/payments/submit") && method === "POST") {
        calls.submit += 1;
        return new Response(JSON.stringify({ error: "Too many tries right now. Wait a moment, then tap Continue.", code: "rate_limited", retryable: true }), { status: 429, headers: { "content-type": "application/json", "Retry-After": "600" } });
      }
      if (url.includes("/payment-attempt-1/status")) {
        return jsonResponse(200, { attempt: attemptFixture({ state: "cancelled", prepared: { ...PREPARED_FIELDS, validUntil } }), serverNowSeconds: Math.floor(Date.now() / 1000), reconciliationDeferred: false });
      }
      if (url.endsWith("/api/real/payments/prepare") && method === "POST") {
        expect(body).toMatchObject({ recipient: RECIPIENT });
        return jsonResponse(200, {
          attempt: attemptFixture({ id: "payment-attempt-2", prepared: { ...PREPARED_FIELDS, validUntil } }),
          subOrganizationId: "sub-org-1",
          authorizingCredentialId: "credential-1",
          serverNowSeconds: Math.floor(Date.now() / 1000),
        });
      }
      return null;
    });
    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-submit-wait")).toBeInTheDocument());

    // The payment is cancelled elsewhere and the existing status read sees it.
    await act(async () => {
      await useRealPaymentStore.getState().checkStatus();
    });
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());

    // A new payment, through the form, with the passkey sheet dismissed so it waits for approval.
    signPreparedPaymentMock.mockReset();
    signPreparedPaymentMock.mockRejectedValue(Object.assign(new Error("dismissed"), { name: "NotAllowedError" }));
    fireEvent.change(screen.getByLabelText("To"), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-review")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());

    expect(useRealPaymentStore.getState().attempt?.id).toBe("payment-attempt-2");
    expect(screen.queryByTestId("real-pay-submit-wait")).toBeNull();
    expect(screen.queryByTestId("real-pay-approval-expiring")).toBeNull();
    expect(screen.queryByText(/Too many attempts/)).toBeNull();
    // Ordinary rules still apply: the safety line, Cancel, and a live Continue.
    expect(screen.getByText("Only continue if you started this payment.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel payment" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    expect(calls.submit).toBe(1); // only the first attempt's refused submit; the new one was never sent on its own
  });

  it("a remount during the wait keeps Continue disabled", async () => {
    const calls = stubServer({ secondsToExpiry: 1000, retryAfter: "300" });
    const first = render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-submit-wait")).toBeInTheDocument());
    first.unmount();

    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-submit-wait")).toBeInTheDocument());

    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(calls.submit).toBe(1);
    expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * L-2 D-1: after a prepare that ended without a trustworthy answer the form
 * shows a recovery notice and "Check payment status" instead of Review. Nothing
 * is retried, read or cancelled by itself; the check is one explicit GET
 * /latest per click. A fake server only — no network, no passkey, no provider.
 */
describe("RealPayForm — L-2 D-1: unresolved prepare recovery", () => {
  const UNCERTAIN = "We couldn't confirm whether your payment was set up. Check its status before trying again.";
  const IN_PROGRESS = "A payment may already be in progress. Check its status before trying again.";
  const CHECK_FAILED = "We couldn't check right now. Try again in a moment.";
  const NONE = "No payment is waiting. You can review your payment again.";
  const C1_BODY = { error: "We couldn't confirm this payment's setup. No money was sent by this request. Refresh the app to check its status before trying again.", code: "prepare_outcome_uncertain" };

  type Handler = (n: number) => Response | Promise<Response>;
  type Key = "latest" | "prepare" | "cancel" | "submit" | "status";

  beforeEach(() => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready", error: null, hasHydrated: true });
    useRealBalanceStore.setState({ balance: { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" }, status: "ready", error: null });
    useRealPaymentStore.getState().reset();
    useRealPaymentStore.setState({ status: "idle" });
    signPreparedPaymentMock.mockReset();
    vi.unstubAllGlobals();
  });

  function held() {
    let resolve: (response: Response) => void = () => {};
    const promise = new Promise<Response>((res) => (resolve = res));
    return { promise, resolve };
  }

  function stub(handlers: Partial<Record<Key, Handler>>) {
    const calls: Array<{ key: Key; method: string }> = [];
    const counts: Record<Key, number> = { latest: 0, prepare: 0, cancel: 0, submit: 0, status: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/api/real/account/balance")) return jsonResponse(200, { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" });
        const key: Key | null = url.endsWith("/api/real/payments/latest") ? "latest" : url.endsWith("/api/real/payments/prepare") ? "prepare" : url.endsWith("/cancel") ? "cancel" : url.endsWith("/api/real/payments/submit") ? "submit" : url.endsWith("/status") ? "status" : null;
        const handler = key ? handlers[key] : undefined;
        if (!key || !handler) throw new Error(`Unhandled fetch in test: ${method} ${url}`);
        calls.push({ key, method });
        counts[key] += 1;
        return handler(counts[key]);
      }),
    );
    return { calls, count: (key: Key) => calls.filter((call) => call.key === key).length };
  }

  const active = (state: string, overrides: Record<string, unknown> = {}) => attemptFixture({ id: "payment-attempt-1", state, ...overrides });
  const latestOf = (state: string, extra: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) => () =>
    jsonResponse(200, { attempt: active(state, overrides), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: Math.floor(Date.now() / 1000), ...extra });

  /** Types an address payment and approves it; `prepare` decides how the request ends. */
  async function unresolved(prepare: Handler, others: Partial<Record<Key, Handler>> = {}, amount = "1.00") {
    const api = stub({ latest: () => jsonResponse(200, { attempt: null }), prepare, ...others });
    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("To"), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: amount } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-review")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-prepare-recovery")).toBeInTheDocument());
    return api;
  }

  /** `others.latest` serves the second and later reads; the first (mount) read says "no payment". */
  const afterMount = (next: Handler): Handler => (n) => (n === 1 ? jsonResponse(200, { attempt: null }) : next(n));

  it.each([
    ["the C-1 uncertainty reply", () => jsonResponse(500, C1_BODY), UNCERTAIN],
    ["a generic HTTP 500", () => jsonResponse(500, { error: "Something went wrong." }), UNCERTAIN],
    ["a network failure", () => { throw new TypeError("Failed to fetch"); }, UNCERTAIN],
    ["an unreadable reply", () => new Response("<html>", { status: 502 }), UNCERTAIN],
    ["an HTTP 409", () => jsonResponse(409, { error: "You already have a payment in progress." }), IN_PROGRESS],
  ] as const)("%s: fixed notice, Check payment status instead of Review, typed text kept, nothing happens by itself", async (_name, prepare, copy) => {
    const api = await unresolved(prepare as Handler);

    expect(screen.getByText(copy)).toBeInTheDocument();
    expect(screen.queryByText(/Failed to fetch|Something went wrong|couldn't confirm this payment's setup/)).toBeNull();
    expect(screen.getByRole("button", { name: "Check payment status" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
    expect(screen.getByLabelText("To")).toHaveValue(RECIPIENT);
    expect(screen.getByLabelText("Amount")).toHaveValue("1.00");
    // Only the mount read and the one prepare happened; no retry, cancel, status or signing.
    expect(api.count("latest")).toBe(1);
    expect(api.count("prepare")).toBe(1);
    expect(api.count("cancel") + api.count("status") + api.count("submit")).toBe(0);
    expect(signPreparedPaymentMock).not.toHaveBeenCalled();
  });

  it("a known preparation failure (502 with a message) keeps the ordinary form: Review, the server's message, no check", async () => {
    stub({ latest: () => jsonResponse(200, { attempt: null }), prepare: () => jsonResponse(502, { error: "We couldn't prepare that payment. Please try again." }) });
    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("To"), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-review")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByText("We couldn't prepare that payment. Please try again.")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check payment status" })).toBeNull();
  });

  it("editing the recipient or amount does not bring Review back, and pressing Enter starts nothing", async () => {
    const api = await unresolved(() => jsonResponse(500, C1_BODY));

    fireEvent.change(screen.getByLabelText("To"), { target: { value: "0x4444444444444444444444444444444444444444" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "2.00" } });
    fireEvent.submit(screen.getByTestId("real-pay-form"));

    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
    expect(screen.getByRole("button", { name: "Check payment status" })).toBeInTheDocument();
    expect(screen.getByText(UNCERTAIN)).toBeInTheDocument();
    expect(screen.queryByTestId("real-pay-review")).toBeNull();
    expect(api.count("prepare")).toBe(1);
  });

  it("shows a loading state while the check runs, and rapid clicks send one GET /latest", async () => {
    const gate = held();
    const api = await unresolved(() => jsonResponse(500, C1_BODY), { latest: afterMount(() => gate.promise) });

    const button = screen.getByRole("button", { name: "Check payment status" });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled());
    expect(api.count("latest")).toBe(2); // the mount read + exactly one check
    expect(api.count("prepare")).toBe(1);

    await act(async () => gate.resolve(jsonResponse(200, { attempt: null })));
    await waitFor(() => expect(screen.getByText(NONE)).toBeInTheDocument());
    expect(api.count("latest")).toBe(2);
  });

  it("no payment: says so, keeps the typed text, restores Review", async () => {
    await unresolved(() => jsonResponse(500, C1_BODY), { latest: afterMount(() => jsonResponse(200, { attempt: null })) });

    fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));

    await waitFor(() => expect(screen.getByText(NONE)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Check payment status" })).toBeNull();
    expect(screen.queryByText(UNCERTAIN)).toBeNull();
    expect(screen.getByLabelText("To")).toHaveValue(RECIPIENT);
    expect(screen.getByLabelText("Amount")).toHaveValue("1.00");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-review")).toBeInTheDocument());
  });

  it.each(["confirmed", "failed", "cancelled"] as const)("an old %s payment is not shown as this form's result: no 'Sent', no failure screen, the form returns", async (state) => {
    await unresolved(() => jsonResponse(500, C1_BODY), { latest: afterMount(latestOf(state, {}, { transactionHash: "0xabc" })) });
    fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));

    await waitFor(() => expect(screen.getByText(NONE)).toBeInTheDocument());
    expect(screen.queryByTestId("real-pay-confirmed")).toBeNull();
    expect(screen.queryByTestId("real-pay-failed")).toBeNull();
    expect(screen.queryByText("Sent")).toBeNull();
    expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();
  });

  it.each([
    ["HTTP 500", () => jsonResponse(500, { error: "boom" })],
    ["a network failure", () => { throw new TypeError("Failed to fetch"); }],
    ["an unreadable reply", () => new Response("<html>", { status: 200 })],
  ] as const)("a failed check (%s): says so plainly, keeps the requirement and the text, never claims 'no payment'; a later click can succeed", async (_name, latest) => {
    await unresolved(() => jsonResponse(500, C1_BODY), { latest: afterMount((n) => (n === 2 ? (latest as Handler)(n) : jsonResponse(200, { attempt: null }))) });

    fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));
    await waitFor(() => expect(screen.getByText(CHECK_FAILED)).toBeInTheDocument());
    expect(screen.getByText(UNCERTAIN)).toBeInTheDocument();
    expect(screen.queryByText(NONE)).toBeNull();
    expect(screen.queryByText(/Failed to fetch|boom/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
    expect(screen.getByLabelText("To")).toHaveValue(RECIPIENT);
    expect(screen.getByRole("button", { name: "Check payment status" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));
    await waitFor(() => expect(screen.getByText(NONE)).toBeInTheDocument());
  });

  describe("an active payment is adopted from the server's record", () => {
    it("prepared: the stranded screen shows the stored amount and recipient (not the typed ones), Cancel, no Continue", async () => {
      // The form said 5.00; the server's payment is 1.00 to RECIPIENT. The screen must show the server's.
      await unresolved(() => jsonResponse(500, C1_BODY), { latest: afterMount(latestOf("prepared", {}, { amountBaseUnits: "1000000", recipient: "0x3333333333333333333333333333333333333333" })) }, "5.00");
      fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));

      await waitFor(() => expect(screen.getByTestId("real-pay-stranded")).toBeInTheDocument());
      expect(screen.getByTestId("real-pay-stranded-details")).toHaveTextContent("$1.00 to 0x3333…3333");
      expect(screen.getByTestId("real-pay-stranded-details")).not.toHaveTextContent("5.00");
      expect(screen.getByRole("button", { name: "Cancel payment" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
      expect(signPreparedPaymentMock).not.toHaveBeenCalled();
    });

    it("a payment to an @name shows the stored name, not an address", async () => {
      await unresolved(() => jsonResponse(500, C1_BODY), { latest: afterMount(latestOf("prepared", {}, { recipientIdentity: { handle: "smit", displayName: "Smit Patel" } })) });
      fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));
      await waitFor(() => expect(screen.getByTestId("real-pay-stranded-details")).toHaveTextContent("to Smit Patel (@smit)"));
      expect(screen.getByTestId("real-pay-stranded-details")).not.toHaveTextContent("0x3333");
    });

    it("awaiting_authorization with the server's signing context: the normal resume screen, and no passkey prompt", async () => {
      await unresolved(() => jsonResponse(500, C1_BODY), { latest: afterMount(latestOf("awaiting_authorization")) });
      fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));

      await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Cancel payment" })).toBeEnabled();
      expect(signPreparedPaymentMock).not.toHaveBeenCalled();
    });

    it("awaiting_authorization without that context: cancel-only (the existing different-passkey screen)", async () => {
      await unresolved(() => jsonResponse(500, C1_BODY), { latest: afterMount(latestOf("awaiting_authorization", { subOrganizationId: null, authorizingCredentialId: null })) });
      fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));

      await waitFor(() => expect(screen.getByTestId("real-pay-stranded")).toBeInTheDocument());
      expect(screen.getByText(/different passkey/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
      expect(screen.getByRole("button", { name: "Cancel payment" })).toBeInTheDocument();
    });

    it("signed: cancel-only, with the stored details", async () => {
      await unresolved(() => jsonResponse(500, C1_BODY), { latest: afterMount(latestOf("signed")) });
      fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));
      await waitFor(() => expect(screen.getByTestId("real-pay-stranded")).toBeInTheDocument());
      expect(screen.getByTestId("real-pay-stranded-details")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Cancel payment" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    });

    it.each(["submitting", "unknown"] as const)("%s: the 'we're checking' screen with Check status, and NO Cancel", async (state) => {
      await unresolved(() => jsonResponse(500, C1_BODY), { latest: afterMount(latestOf(state)) });
      fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));

      await waitFor(() => expect(screen.getByTestId("real-pay-unknown")).toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Check status" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Cancel/ })).toBeNull();
      expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
    });

    it("submitted: the 'Sending…' screen with Check status, and NO Cancel", async () => {
      await unresolved(() => jsonResponse(500, C1_BODY), { latest: afterMount(latestOf("submitted")), status: () => jsonResponse(200, { attempt: active("submitted"), serverNowSeconds: Math.floor(Date.now() / 1000) }) });
      fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));

      await waitFor(() => expect(screen.getByTestId("real-pay-sending")).toBeInTheDocument());
      expect(screen.queryByRole("button", { name: /Cancel/ })).toBeNull();
      expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
    });
  });

  describe("Cancel", () => {
    it("is disabled while its request is pending and repeated clicks send one request", async () => {
      const gate = held();
      const api = await unresolved(() => jsonResponse(500, C1_BODY), { latest: afterMount(latestOf("prepared")), cancel: () => gate.promise });
      fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));
      await waitFor(() => expect(screen.getByTestId("real-pay-stranded")).toBeInTheDocument());

      const cancelButton = screen.getByRole("button", { name: "Cancel payment" });
      fireEvent.click(cancelButton);
      fireEvent.click(cancelButton);
      fireEvent.click(cancelButton);

      await waitFor(() => expect(screen.getByRole("button", { name: "Cancel payment" })).toBeDisabled());
      expect(api.count("cancel")).toBe(1);

      await act(async () => gate.resolve(jsonResponse(200, { attempt: active("cancelled") })));
      await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
      expect(api.count("cancel")).toBe(1);
    });

    it("the approval screen's Cancel has the same guard", async () => {
      const gate = held();
      const api = stub({ latest: latestOf("awaiting_authorization"), cancel: () => gate.promise });
      render(<RealPayForm />);
      await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());

      const cancelButton = screen.getByRole("button", { name: "Cancel payment" });
      fireEvent.click(cancelButton);
      fireEvent.click(cancelButton);
      await waitFor(() => expect(screen.getByRole("button", { name: "Cancel payment" })).toBeDisabled());
      expect(api.count("cancel")).toBe(1);

      await act(async () => gate.resolve(jsonResponse(200, { attempt: active("cancelled") })));
      await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
    });

    it("a refused or lost cancel re-enables the button without releasing the payment", async () => {
      stub({ latest: latestOf("prepared"), cancel: () => { throw new TypeError("Failed to fetch"); } });
      render(<RealPayForm />);
      await waitFor(() => expect(screen.getByTestId("real-pay-stranded")).toBeInTheDocument());

      fireEvent.click(screen.getByRole("button", { name: "Cancel payment" }));
      await waitFor(() => expect(screen.getByText(/Could not confirm whether this payment was cancelled/)).toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Cancel payment" })).toBeEnabled();
      expect(screen.getByTestId("real-pay-stranded")).toBeInTheDocument();
    });
  });

  it("a restored stranded payment (reload path) also shows its stored amount and recipient", async () => {
    stub({ latest: latestOf("prepared") });
    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-stranded-details")).toHaveTextContent("$1.00 to 0x3333…3333"));
  });

  it("unmounting during a check discards the late answer; a remount starts clean from the server's own record", async () => {
    const gate = held();
    const api = await unresolved(() => jsonResponse(500, C1_BODY), { latest: afterMount((n) => (n === 2 ? gate.promise : jsonResponse(200, { attempt: null }))) });
    fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));
    await waitFor(() => expect(api.count("latest")).toBe(2));

    cleanup();
    await act(async () => gate.resolve(latestOf("prepared")()));

    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
    expect(screen.queryByTestId("real-pay-stranded")).toBeNull();
    expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();
    expect(api.count("cancel") + api.count("submit")).toBe(0);
  });
});

/**
 * L-2 D-3a: when the page cannot tell what the latest payment is (the initial
 * GET /latest failed, was unreadable, or never answered), it offers no payment
 * form at all — only fixed copy and an explicit "Check again".
 */
describe("RealPayForm — L-2 D-3a: initial payment check unavailable", () => {
  const HEADLINE = "We couldn't check your payments right now.";
  const DETAIL = "Check again before starting a new payment.";
  const RAW_TEXT = /Failed to fetch|boom|Unexpected|JSON|html|Service Unavailable|Not authenticated|longer than usual|abort/i;
  const ACCOUNT_B = { appUserId: "app-user-2", ownerAddress: "0x4444444444444444444444444444444444444444", safeAddress: "0x5555555555555555555555555555555555555555" };

  type Handler = (n: number) => Response | Promise<Response>;
  type Key = "latest" | "prepare" | "cancel" | "submit" | "status" | "lookup";

  beforeEach(() => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready", error: null, hasHydrated: true });
    useRealBalanceStore.setState({ balance: { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" }, status: "ready", error: null });
    useRealPaymentStore.getState().reset();
    useRealPaymentStore.setState({ status: "idle" });
    signPreparedPaymentMock.mockReset();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function held() {
    let resolve: (response: Response) => void = () => {};
    const promise = new Promise<Response>((res) => (resolve = res));
    return { promise, resolve };
  }

  /** Every request is recorded, including one no handler expects. */
  function stub(handlers: Partial<Record<Key, Handler>>) {
    const calls: Array<{ key: Key | "other"; method: string }> = [];
    const counts: Record<Key, number> = { latest: 0, prepare: 0, cancel: 0, submit: 0, status: 0, lookup: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/api/real/account/balance")) return jsonResponse(200, { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" });
        const key: Key | null = url.endsWith("/api/real/payments/latest")
          ? "latest"
          : url.endsWith("/api/real/payments/prepare")
            ? "prepare"
            : url.endsWith("/cancel")
              ? "cancel"
              : url.endsWith("/api/real/payments/submit")
                ? "submit"
                : url.endsWith("/status")
                  ? "status"
                  : url.endsWith("/api/real/recipients/lookup")
                    ? "lookup"
                    : null;
        calls.push({ key: key ?? "other", method });
        const handler = key ? handlers[key] : undefined;
        if (!key || !handler) throw new Error(`Unhandled fetch in test: ${method} ${url}`);
        counts[key] += 1;
        return handler(counts[key]);
      }),
    );
    return { calls, count: (key: Key) => calls.filter((call) => call.key === key).length, keys: () => calls.map((call) => call.key) };
  }

  const none = () => jsonResponse(200, { attempt: null });
  const failing = () => jsonResponse(500, { error: "boom" });
  const latestOf = (state: string, extra: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) => () =>
    jsonResponse(200, { attempt: attemptFixture({ state, ...overrides }), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: Math.floor(Date.now() / 1000), ...extra });

  /** Mounts the form with a first read that fails; later reads are `next`. */
  async function mountUnavailable(next: Handler = none, others: Partial<Record<Key, Handler>> = {}) {
    const api = stub({ latest: (n) => (n === 1 ? failing() : next(n)), ...others });
    const view = render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-status-unavailable")).toBeInTheDocument());
    return { api, view };
  }

  function expectNoPaymentControls() {
    expect(screen.queryByTestId("real-pay-form")).toBeNull();
    expect(screen.queryByLabelText("To")).toBeNull();
    expect(screen.queryByLabelText("Amount")).toBeNull();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    for (const name of ["Review", "Approve", "Send", "Continue", "Edit", "Cancel payment", "Check payment status", "Check status", "Try again", "Send another payment"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  }

  it("shows the exact approved headline and supporting text, one 'Check again' button, and no payment controls", async () => {
    const { api, view } = await mountUnavailable();

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent(HEADLINE);
    expect(notice).toHaveTextContent(DETAIL);
    expect(screen.getByText(HEADLINE)).toBeInTheDocument();
    expect(screen.getByText(DETAIL)).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
    expectNoPaymentControls();
    expect(view.container.querySelector("form")).toBeNull();
    // Only the mount read happened: no retry, and nothing else, by itself.
    expect(api.keys()).toEqual(["latest"]);
    expect(signPreparedPaymentMock).not.toHaveBeenCalled();
  });

  it.each([
    ["HTTP 500", () => jsonResponse(500, { error: "boom" })],
    ["HTTP 404", () => jsonResponse(404, { error: "boom" })],
    ["HTTP 503 with an HTML body", () => new Response("<html>Service Unavailable</html>", { status: 503 })],
    ["a network failure", () => {
      throw new TypeError("Failed to fetch");
    }],
    ["an HTTP 200 that is not JSON", () => new Response("<html>", { status: 200 })],
    ["a reply with no attempt key", () => jsonResponse(200, {})],
    ["an attempt of an unknown state", () => jsonResponse(200, { attempt: attemptFixture({ state: "mystery" }) })],
    ["an attempt with no id", () => jsonResponse(200, { attempt: attemptFixture({ id: "" }) })],
  ] as const)("%s on mount: the unavailable screen, with no raw fetch, JSON or server text and no payment form", async (_name, latest) => {
    const api = stub({ latest: latest as Handler });
    const view = render(<RealPayForm />);

    await waitFor(() => expect(screen.getByTestId("real-pay-status-unavailable")).toBeInTheDocument());
    expect(screen.getByText(HEADLINE)).toBeInTheDocument();
    expect(view.container.textContent).not.toMatch(RAW_TEXT);
    expect(view.container.textContent).toBe(`${HEADLINE}${DETAIL}Check again`);
    expectNoPaymentControls();
    expect(api.keys()).toEqual(["latest"]);
  });

  it("HTTP 401 on mount is unchanged: the ordinary form, not the unavailable screen", async () => {
    stub({ latest: () => jsonResponse(401, { error: "Not authenticated." }) });
    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
    expect(screen.queryByTestId("real-pay-status-unavailable")).toBeNull();
  });

  it("Check again: shows the loading skeleton while it runs, rapid clicks send one GET, and a clean answer brings the form back", async () => {
    const gate = held();
    const { api } = await mountUnavailable(() => gate.promise);

    const button = screen.getByRole("button", { name: "Check again" });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
      fireEvent.click(button);
    });

    await waitFor(() => expect(screen.getByTestId("real-pay-form-loading")).toBeInTheDocument());
    expect(screen.queryByTestId("real-pay-status-unavailable")).toBeNull();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    expectNoPaymentControls();
    expect(api.count("latest")).toBe(2); // the mount read + exactly one retry

    await act(async () => gate.resolve(none()));
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
    expect(screen.getByLabelText("To")).toHaveValue("");
    expect(screen.getByLabelText("Amount")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();
    expect(screen.queryByText(HEADLINE)).toBeNull();
    expect(api.keys()).toEqual(["latest", "latest"]);
  });

  it("a retry that fails again keeps the unavailable screen — one GET per press, and still no raw text", async () => {
    const { api, view } = await mountUnavailable((n) => {
      if (n === 2) throw new TypeError("Failed to fetch");
      return n === 3 ? new Response("<html>", { status: 200 }) : none();
    });

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(api.count("latest")).toBe(2));
    await waitFor(() => expect(screen.getByTestId("real-pay-status-unavailable")).toBeInTheDocument());
    expect(view.container.textContent).toBe(`${HEADLINE}${DETAIL}Check again`);

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(api.count("latest")).toBe(3));
    await waitFor(() => expect(screen.getByTestId("real-pay-status-unavailable")).toBeInTheDocument());
    expect(view.container.textContent).not.toMatch(RAW_TEXT);
    expectNoPaymentControls();

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
    expect(api.keys()).toEqual(["latest", "latest", "latest", "latest"]);
  });

  describe("a successful retry restores the screen for whatever the server has", () => {
    it("a payment waiting for approval: the resume screen, with no passkey prompt", async () => {
      const { api } = await mountUnavailable(latestOf("awaiting_authorization"));
      fireEvent.click(screen.getByRole("button", { name: "Check again" }));
      await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
      expect(screen.getByText("Only continue if you started this payment.")).toBeInTheDocument();
      expect(signPreparedPaymentMock).not.toHaveBeenCalled();
      expect(api.keys()).toEqual(["latest", "latest"]);
    });

    it("a payment bound to another passkey: cancel-only", async () => {
      await mountUnavailable(latestOf("awaiting_authorization", { subOrganizationId: null, authorizingCredentialId: null }));
      fireEvent.click(screen.getByRole("button", { name: "Check again" }));
      await waitFor(() => expect(screen.getByTestId("real-pay-stranded")).toBeInTheDocument());
      expect(screen.getByText(/different passkey/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    });

    it.each(["prepared", "signed"] as const)("%s: cancel-only, with the stored amount and recipient", async (state) => {
      await mountUnavailable(latestOf(state));
      fireEvent.click(screen.getByRole("button", { name: "Check again" }));
      await waitFor(() => expect(screen.getByTestId("real-pay-stranded-details")).toHaveTextContent("$1.00 to 0x3333…3333"));
      expect(screen.getByRole("button", { name: "Cancel payment" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    });

    it.each(["submitting", "unknown"] as const)("%s: the 'we're checking' screen, with no Cancel", async (state) => {
      await mountUnavailable(latestOf(state));
      fireEvent.click(screen.getByRole("button", { name: "Check again" }));
      await waitFor(() => expect(screen.getByTestId("real-pay-unknown")).toBeInTheDocument());
      expect(screen.queryByRole("button", { name: "Cancel payment" })).toBeNull();
    });

    it("submitted: 'Sending…', followed only by the usual read-only status check", async () => {
      const { api } = await mountUnavailable(latestOf("submitted", {}, { prepared: null }), {
        status: () => jsonResponse(200, { attempt: attemptFixture({ state: "submitted", prepared: null }), serverNowSeconds: Math.floor(Date.now() / 1000) }),
      });
      fireEvent.click(screen.getByRole("button", { name: "Check again" }));
      await waitFor(() => expect(screen.getByTestId("real-pay-sending")).toBeInTheDocument());
      await waitFor(() => expect(api.count("status")).toBe(1));
      expect(api.calls.every((call) => call.method === "GET")).toBe(true);
      expect(api.count("prepare") + api.count("submit") + api.count("cancel")).toBe(0);
    });

    it("confirmed: 'Sent', exactly as a reload shows it", async () => {
      await mountUnavailable(latestOf("confirmed", {}, { transactionHash: "0xabc" }));
      fireEvent.click(screen.getByRole("button", { name: "Check again" }));
      await waitFor(() => expect(screen.getByTestId("real-pay-confirmed")).toBeInTheDocument());
      expect(screen.getByText("Sent")).toBeInTheDocument();
    });

    it("failed: the failure screen with the stored reason", async () => {
      await mountUnavailable(latestOf("failed", {}, { failureReason: "This payment expired before it was sent." }));
      fireEvent.click(screen.getByRole("button", { name: "Check again" }));
      await waitFor(() => expect(screen.getByTestId("real-pay-failed")).toBeInTheDocument());
      expect(screen.getByText("This payment expired before it was sent.")).toBeInTheDocument();
    });

    it("cancelled: the ordinary form", async () => {
      await mountUnavailable(latestOf("cancelled"));
      fireEvent.click(screen.getByRole("button", { name: "Check again" }));
      await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();
    });
  });

  it("Enter (or any key) cannot start a payment while unavailable: there is no form to submit and nothing is prepared", async () => {
    const { api, view } = await mountUnavailable(none, { prepare: () => jsonResponse(200, {}), lookup: () => jsonResponse(200, { found: false }) });
    // Even with values a previous screen might have left in the store.
    act(() => {
      useRealPaymentStore.getState().setRecipientInput(RECIPIENT);
      useRealPaymentStore.getState().setAmountInput("1.00");
    });

    const button = screen.getByRole("button", { name: "Check again" });
    expect(button).toHaveAttribute("type", "button");
    for (const target of [button, view.container, document.body]) {
      fireEvent.keyDown(target, { key: "Enter", code: "Enter" });
      fireEvent.keyPress(target, { key: "Enter", code: "Enter", charCode: 13 });
      fireEvent.keyUp(target, { key: "Enter", code: "Enter" });
    }
    await act(async () => {
      await useRealPaymentStore.getState().review();
      await useRealPaymentStore.getState().confirmAndSend();
    });

    expect(view.container.querySelector("form")).toBeNull();
    expect(screen.getByTestId("real-pay-status-unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("real-pay-review")).toBeNull();
    expect(api.keys()).toEqual(["latest"]);
    expect(signPreparedPaymentMock).not.toHaveBeenCalled();
  });

  it("a mount read that never answers shows the skeleton until the 45-second deadline, then the unavailable screen — and nothing retries by itself", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const api = stub({ latest: () => new Promise<Response>(() => {}) });
    const flush = () =>
      act(async () => {
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });
    render(<RealPayForm />);
    await flush();
    expect(screen.getByTestId("real-pay-form-loading")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(44_999);
    });
    await flush();
    expect(screen.getByTestId("real-pay-form-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("real-pay-status-unavailable")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flush();
    expect(screen.getByText(HEADLINE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
    expectNoPaymentControls();

    await act(async () => {
      vi.advanceTimersByTime(60 * 60 * 1000);
    });
    await flush();
    expect(api.keys()).toEqual(["latest"]);
    expect(screen.getByText(HEADLINE)).toBeInTheDocument();
  });

  it("switching to another account while unavailable loads that account's own answer; signing out shows nothing", async () => {
    const { api, view } = await mountUnavailable(none);

    act(() => useRealAccountStore.setState({ account: ACCOUNT_B }));
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
    expect(screen.queryByTestId("real-pay-status-unavailable")).toBeNull();
    expect(api.count("latest")).toBe(2);

    act(() => useRealAccountStore.setState({ account: null }));
    expect(view.container).toBeEmptyDOMElement();
  });

  it("unmounting during a retry discards its late answer; a remount reads the server itself", async () => {
    const gate = held();
    const { api } = await mountUnavailable((n) => (n === 2 ? gate.promise : none()));
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(api.count("latest")).toBe(2));

    cleanup();
    await act(async () => gate.resolve(latestOf("prepared")()));
    expect(useRealPaymentStore.getState().attempt).toBeNull();

    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
    expect(screen.queryByTestId("real-pay-stranded")).toBeNull();
    expect(api.count("latest")).toBe(3);
    expect(api.count("cancel") + api.count("submit") + api.count("prepare")).toBe(0);
  });

  it("React Strict Mode's double mount with a failing read still ends on the unavailable screen, and Check again works", async () => {
    const api = stub({ latest: (n) => (n <= 2 ? failing() : none()) });
    render(
      <StrictMode>
        <RealPayForm />
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByTestId("real-pay-status-unavailable")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
    expect(api.calls.every((call) => call.key === "latest" && call.method === "GET")).toBe(true);
  });

  describe("D-1's 'Check payment status' experience is unchanged", () => {
    const UNCERTAIN = "We couldn't confirm whether your payment was set up. Check its status before trying again.";
    const CHECK_FAILED = "We couldn't check right now. Try again in a moment.";

    it("an unresolved prepare still shows the D-1 notice on the form; a failed D-1 check stays there — never the D-3a screen", async () => {
      const api = stub({ latest: (n) => (n === 1 ? none() : failing()), prepare: () => jsonResponse(500, { error: "Something went wrong." }) });
      render(<RealPayForm />);
      await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText("To"), { target: { value: RECIPIENT } });
      fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.00" } });
      fireEvent.click(screen.getByRole("button", { name: "Review" }));
      await waitFor(() => expect(screen.getByTestId("real-pay-review")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      await waitFor(() => expect(screen.getByTestId("real-pay-prepare-recovery")).toBeInTheDocument());

      expect(screen.getByText(UNCERTAIN)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));
      await waitFor(() => expect(screen.getByText(CHECK_FAILED)).toBeInTheDocument());

      expect(screen.getByTestId("real-pay-form")).toBeInTheDocument();
      expect(screen.queryByTestId("real-pay-status-unavailable")).toBeNull();
      expect(screen.queryByText(HEADLINE)).toBeNull();
      expect(screen.getByRole("button", { name: "Check payment status" })).toBeEnabled();
      expect(screen.getByLabelText("To")).toHaveValue(RECIPIENT);
      expect(screen.getByLabelText("Amount")).toHaveValue("1.00");
      expect(api.keys()).toEqual(["latest", "prepare", "latest"]);
    });
  });
});

/**
 * L-2 D-2: the one definitive prepare 409 (HTTP 409 + code "account_not_ready")
 * returns to the ordinary form with fixed copy — no recovery block, Review still
 * there, the typed text kept. Every other 409 keeps D-1's "Check payment
 * status". A fake server only — no network, no passkey, no provider.
 */
describe("RealPayForm — L-2 D-2: prepare refused because the account can't send", () => {
  const NOT_READY = "We can't send payments from this account right now. This payment wasn't started.";
  const SERVER_SENTENCE = "Your account isn't fully set up yet.";
  const NOT_READY_BODY = { error: SERVER_SENTENCE, code: "account_not_ready" };
  const UNCERTAIN = "We couldn't confirm whether your payment was set up. Check its status before trying again.";
  const IN_PROGRESS = "A payment may already be in progress. Check its status before trying again.";
  const NONE = "No payment is waiting. You can review your payment again.";

  type Handler = (n: number) => Response | Promise<Response>;
  type Key = "latest" | "prepare" | "cancel" | "submit" | "status" | "lookup";

  beforeEach(() => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready", error: null, hasHydrated: true });
    useRealBalanceStore.setState({ balance: { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" }, status: "ready", error: null });
    useRealPaymentStore.getState().reset();
    useRealPaymentStore.setState({ status: "idle" });
    signPreparedPaymentMock.mockReset();
    vi.unstubAllGlobals();
  });

  /** Every request is recorded, including one no handler expects. */
  function stub(handlers: Partial<Record<Key, Handler>>) {
    const calls: Array<{ key: Key | "other"; method: string }> = [];
    const counts: Record<Key, number> = { latest: 0, prepare: 0, cancel: 0, submit: 0, status: 0, lookup: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/api/real/account/balance")) return jsonResponse(200, { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" });
        const key: Key | null = url.endsWith("/api/real/payments/latest")
          ? "latest"
          : url.endsWith("/api/real/payments/prepare")
            ? "prepare"
            : url.endsWith("/cancel")
              ? "cancel"
              : url.endsWith("/api/real/payments/submit")
                ? "submit"
                : url.endsWith("/status")
                  ? "status"
                  : url.endsWith("/api/real/recipients/lookup")
                    ? "lookup"
                    : null;
        calls.push({ key: key ?? "other", method });
        const handler = key ? handlers[key] : undefined;
        if (!key || !handler) throw new Error(`Unhandled fetch in test: ${method} ${url}`);
        counts[key] += 1;
        return handler(counts[key]);
      }),
    );
    return { calls, count: (key: Key) => calls.filter((call) => call.key === key).length, keys: () => calls.map((call) => call.key) };
  }

  const none = () => jsonResponse(200, { attempt: null });

  async function typeAndReview(amount = "1.00") {
    fireEvent.change(screen.getByLabelText("To"), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: amount } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-review")).toBeInTheDocument());
  }

  /** Mounts the form, types an address payment and approves it; `prepare` decides how the request ends. */
  async function approve(prepare: Handler, others: Partial<Record<Key, Handler>> = {}) {
    const api = stub({ latest: none, prepare, ...others });
    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
    await typeAndReview();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    return api;
  }

  it("shows the fixed message on the ordinary form: no recovery block, Review available, typed values kept, the server's wording never displayed", async () => {
    const api = await approve(() => jsonResponse(409, NOT_READY_BODY));

    await waitFor(() => expect(screen.getByText(NOT_READY)).toBeInTheDocument());

    expect(screen.getByTestId("real-pay-form")).toBeInTheDocument();
    expect(screen.queryByTestId("real-pay-prepare-recovery")).toBeNull();
    expect(screen.queryByRole("button", { name: "Check payment status" })).toBeNull();
    expect(screen.queryByTestId("real-pay-prepare-none")).toBeNull();
    expect(screen.queryByTestId("real-pay-status-unavailable")).toBeNull();
    expect(screen.queryByTestId("real-pay-review")).toBeNull();
    expect(screen.getByRole("button", { name: "Review" })).toBeEnabled();
    expect(screen.getByLabelText("To")).toHaveValue(RECIPIENT);
    expect(screen.getByLabelText("Amount")).toHaveValue("1.00");
    // Fixed client copy only: not the server's sentence, not D-1's notices, no code.
    expect(screen.queryByText(SERVER_SENTENCE)).toBeNull();
    expect(screen.queryByText(/fully set up|account_not_ready|Request failed/)).toBeNull();
    expect(screen.queryByText(IN_PROGRESS)).toBeNull();
    expect(screen.queryByText(UNCERTAIN)).toBeNull();
    for (const name of ["Approve", "Continue", "Cancel payment", "Check again", "Check status", "Try again"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    // The mount read and the one prepare — nothing else, and nothing by itself.
    expect(api.keys()).toEqual(["latest", "prepare"]);
    expect(signPreparedPaymentMock).not.toHaveBeenCalled();
  });

  it("the server's sentence does not matter: a different one still shows only the fixed message", async () => {
    await approve(() => jsonResponse(409, { error: "Internal: safe_address failed validation for app-user-1", code: "account_not_ready" }));

    await waitFor(() => expect(screen.getByText(NOT_READY)).toBeInTheDocument());

    expect(screen.queryByText(/safe_address|app-user-1|Internal/)).toBeNull();
    expect(screen.getByRole("button", { name: "Review" })).toBeEnabled();
  });

  it("a second explicit Review and Approve sends exactly one further prepare; the same refusal shows the same form again", async () => {
    const api = await approve(() => jsonResponse(409, NOT_READY_BODY));
    await waitFor(() => expect(screen.getByText(NOT_READY)).toBeInTheDocument());
    expect(api.count("prepare")).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-review")).toBeInTheDocument());
    // Opening Review prepares nothing and drops the old message.
    expect(api.count("prepare")).toBe(1);
    expect(screen.queryByText(NOT_READY)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByText(NOT_READY)).toBeInTheDocument());

    expect(api.keys()).toEqual(["latest", "prepare", "prepare"]);
    expect(screen.getByRole("button", { name: "Review" })).toBeEnabled();
    expect(screen.queryByTestId("real-pay-prepare-recovery")).toBeNull();
    expect(screen.getByLabelText("To")).toHaveValue(RECIPIENT);
    expect(screen.getByLabelText("Amount")).toHaveValue("1.00");
    expect(signPreparedPaymentMock).not.toHaveBeenCalled();
  });

  it("editing a field clears the message and keeps Review", async () => {
    await approve(() => jsonResponse(409, NOT_READY_BODY));
    await waitFor(() => expect(screen.getByText(NOT_READY)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "2.00" } });

    expect(screen.queryByText(NOT_READY)).toBeNull();
    expect(screen.getByRole("button", { name: "Review" })).toBeEnabled();
    expect(screen.queryByTestId("real-pay-prepare-recovery")).toBeNull();
  });

  it.each([
    ["no code", { error: "You already have a payment in progress." }],
    ["the account sentence without the code", { error: SERVER_SENTENCE }],
    ["code 'payment_in_progress'", { error: "You already have a payment in progress.", code: "payment_in_progress" }],
    ["an unknown code", { error: SERVER_SENTENCE, code: "account_locked" }],
    ["the code in the wrong case", { error: SERVER_SENTENCE, code: "ACCOUNT_NOT_READY" }],
    ["a non-string code", { error: SERVER_SENTENCE, code: 409 }],
  ] as const)("an HTTP 409 with %s still shows D-1's recovery: the in-progress notice and Check payment status instead of Review", async (_name, body) => {
    const api = await approve(() => jsonResponse(409, body));

    await waitFor(() => expect(screen.getByTestId("real-pay-prepare-recovery")).toBeInTheDocument());

    expect(screen.getByText(IN_PROGRESS)).toBeInTheDocument();
    expect(screen.queryByText(NOT_READY)).toBeNull();
    expect(screen.queryByText(SERVER_SENTENCE)).toBeNull();
    expect(screen.getByRole("button", { name: "Check payment status" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
    expect(screen.getByLabelText("To")).toHaveValue(RECIPIENT);
    expect(screen.getByLabelText("Amount")).toHaveValue("1.00");
    expect(api.keys()).toEqual(["latest", "prepare"]);
    expect(signPreparedPaymentMock).not.toHaveBeenCalled();
  });

  it.each([
    ["an HTTP 500 carrying the code", () => jsonResponse(500, NOT_READY_BODY)],
    ["an HTTP 409 with an unreadable body", () => new Response("<html>409</html>", { status: 409 })],
    ["a network failure", () => { throw new TypeError("Failed to fetch"); }],
  ] as const)("%s is still an unresolved prepare: the uncertain notice and Check payment status, never the refusal", async (_name, prepare) => {
    const api = await approve(prepare as Handler);

    await waitFor(() => expect(screen.getByTestId("real-pay-prepare-recovery")).toBeInTheDocument());

    expect(screen.getByText(UNCERTAIN)).toBeInTheDocument();
    expect(screen.queryByText(NOT_READY)).toBeNull();
    expect(screen.queryByText(/Failed to fetch|fully set up/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
    expect(api.keys()).toEqual(["latest", "prepare"]);
  });

  it("a real in-progress 409 still needs the explicit check, which shows the server's active payment — the refusal copy never appears", async () => {
    const api = await approve(() => jsonResponse(409, { error: "You already have a payment in progress." }), {
      latest: (n) => (n === 1 ? none() : jsonResponse(200, { attempt: attemptFixture({ state: "prepared", prepared: null }), subOrganizationId: null, authorizingCredentialId: null, serverNowSeconds: Math.floor(Date.now() / 1000) })),
    });
    await waitFor(() => expect(screen.getByTestId("real-pay-prepare-recovery")).toBeInTheDocument());
    expect(api.count("latest")).toBe(1); // nothing was checked automatically

    fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));

    await waitFor(() => expect(screen.getByTestId("real-pay-stranded")).toBeInTheDocument());
    expect(screen.queryByText(NOT_READY)).toBeNull();
    expect(api.keys()).toEqual(["latest", "prepare", "latest"]);
    expect(signPreparedPaymentMock).not.toHaveBeenCalled();
  });

  it("the old loop ends on the form: in-progress 409 -> check finds nothing -> Review -> the refusal, with Review (not another check) on offer", async () => {
    const api = await approve((n) => (n === 1 ? jsonResponse(409, { error: "You already have a payment in progress." }) : jsonResponse(409, NOT_READY_BODY)));
    await waitFor(() => expect(screen.getByTestId("real-pay-prepare-recovery")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));
    await waitFor(() => expect(screen.getByText(NONE)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-review")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByText(NOT_READY)).toBeInTheDocument());

    expect(screen.queryByTestId("real-pay-prepare-recovery")).toBeNull();
    expect(screen.queryByText(NONE)).toBeNull();
    expect(screen.getByRole("button", { name: "Review" })).toBeEnabled();
    expect(api.keys()).toEqual(["latest", "prepare", "latest", "prepare"]);
  });

  it("a remount starts clean: the message is gone and the page does its one ordinary first read", async () => {
    const api = await approve(() => jsonResponse(409, NOT_READY_BODY));
    await waitFor(() => expect(screen.getByText(NOT_READY)).toBeInTheDocument());

    cleanup();
    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());

    expect(screen.queryByText(NOT_READY)).toBeNull();
    expect(screen.getByRole("button", { name: "Review" })).toBeEnabled();
    expect(api.keys()).toEqual(["latest", "prepare", "latest"]);
  });
});

/**
 * L-2 D-4: a submit the server refuses with the exact pair "HTTP 409 + code
 * 'wrong_passkey'" shows the existing cancel-only screen directly — the one a
 * reload would give — instead of "we're checking on this payment". Every other
 * failed submit keeps the existing checking screen, with fixed copy as its
 * detail instead of the server's sentence or raw network/parse text. The
 * component itself is unchanged. A fake server only — no network, no passkey,
 * no provider.
 */
describe("RealPayForm — L-2 D-4: submit refused for another passkey, and unconfirmed submits", () => {
  const OTHER_PASSKEY = "This payment was started with a different passkey. Cancel it and start a new payment.";
  const NEUTRAL = "We couldn't confirm whether this payment was sent. Check its status before trying again.";
  const WRONG_PASSKEY_BODY = { error: OTHER_PASSKEY, code: "wrong_passkey" };
  const CANCEL_LOST_RACE = "This payment could not be cancelled — it may already be on its way.";
  /** The checking screen's own fixed wording — outside this slice, and pinned here as unchanged. */
  const UNKNOWN_HEADLINE = "We're checking on this payment";
  const UNKNOWN_DETAIL = "It may have already gone through. We'll show the result here once we know — sending another payment is disabled until this one resolves.";
  /** The cancel-only screen's own fixed wording before its approval window ends. D-4 did not change it; L-2 D-5 later replaced it (it no longer says the payment was never sent). */
  const STRANDED_HEADLINE = "This payment can’t be continued here";
  const STRANDED_DETAIL = "This payment may still go through. Select Cancel payment and wait for the result before starting another payment.";
  const RAW_TEXT = /Failed to fetch|Cannot read|Unexpected|not valid JSON|Not authenticated|Payment not found|no longer awaiting|\(state:|could not be verified|Something went wrong|Request failed|wrong_passkey|wrong_state|awaiting_authorization|TypeError|SyntaxError/;
  const APPROVAL = { attemptId: "payment-attempt-1", signature: "0xsig-d4", activityId: "activity-d4" };

  type Handler = (n: number) => Response | Promise<Response>;
  type Key = "latest" | "prepare" | "cancel" | "submit" | "status" | "lookup";

  beforeEach(() => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready", error: null, hasHydrated: true });
    useRealBalanceStore.setState({ balance: { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" }, status: "ready", error: null });
    useRealPaymentStore.getState().reset();
    useRealPaymentStore.setState({ status: "idle" });
    // Self-contained: this suite installs its own passkey approval for every test.
    signPreparedPaymentMock.mockReset();
    signPreparedPaymentMock.mockResolvedValue({ signature: APPROVAL.signature, activityId: APPROVAL.activityId });
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    cleanup();
    useRealPaymentStore.getState().reset();
    signPreparedPaymentMock.mockReset();
  });

  /** Every request is recorded, including one no handler expects. */
  function stub(handlers: Partial<Record<Key, Handler>>) {
    const calls: Array<{ key: Key | "other"; method: string; body: unknown }> = [];
    const counts: Record<Key, number> = { latest: 0, prepare: 0, cancel: 0, submit: 0, status: 0, lookup: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/api/real/account/balance")) return jsonResponse(200, { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" });
        const key: Key | null = url.endsWith("/api/real/payments/latest")
          ? "latest"
          : url.endsWith("/api/real/payments/prepare")
            ? "prepare"
            : url.endsWith("/cancel")
              ? "cancel"
              : url.endsWith("/api/real/payments/submit")
                ? "submit"
                : url.endsWith("/status")
                  ? "status"
                  : url.endsWith("/api/real/recipients/lookup")
                    ? "lookup"
                    : null;
        calls.push({ key: key ?? "other", method, body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined });
        const handler = key ? handlers[key] : undefined;
        if (!key || !handler) throw new Error(`Unhandled fetch in test: ${method} ${url}`);
        counts[key] += 1;
        return handler(counts[key]);
      }),
    );
    return { calls, count: (key: Key) => calls.filter((call) => call.key === key).length, keys: () => calls.map((call) => call.key) };
  }

  const none = () => jsonResponse(200, { attempt: null });
  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const wrongPasskey = () => jsonResponse(409, WRONG_PASSKEY_BODY);
  const statusOf = (state: string) => jsonResponse(200, { attempt: attemptFixture({ state }), serverNowSeconds: nowSeconds(), reconciliationDeferred: false });

  /** Mounts the form, types an address payment, approves it (one passkey approval) and lets `submit` decide how the send ends. */
  async function send(submit: Handler, others: Partial<Record<Key, Handler>> = {}, attempt: Record<string, unknown> = {}) {
    const api = stub({
      latest: none,
      prepare: () => jsonResponse(200, { attempt: attemptFixture(attempt), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: nowSeconds() }),
      submit,
      ...others,
    });
    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("To"), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-review")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    return api;
  }

  const absentButtons = (names: string[]) => {
    for (const name of names) expect(screen.queryByRole("button", { name }), name).toBeNull();
  };

  describe("the exact refusal shows the existing cancel-only screen", () => {
    it("amount, recipient, the explanation and Cancel — no Continue, no Check status, no checking screen, and nothing sent by itself", async () => {
      const api = await send(wrongPasskey);

      await waitFor(() => expect(screen.getByTestId("real-pay-stranded")).toBeInTheDocument());

      expect(screen.getByTestId("real-pay-stranded-details")).toHaveTextContent("$1.00 to 0x3333…3333");
      expect(screen.getByText(OTHER_PASSKEY)).toBeInTheDocument();
      // The screen's own wording: the neutral L-2 D-5 copy — the refusal proves only that THIS request sent nothing.
      expect(screen.getByText(STRANDED_HEADLINE)).toBeInTheDocument();
      expect(screen.getByText(STRANDED_DETAIL)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Cancel payment" })).toBeEnabled();
      absentButtons(["Continue", "Check status", "Review", "Approve", "Edit", "Try again", "Check payment status", "Check again", "Send another payment"]);
      for (const id of ["real-pay-unknown", "real-pay-resume", "real-pay-authorizing", "real-pay-sending", "real-pay-form", "real-pay-review", "real-pay-failed", "real-pay-confirmed", "real-pay-status-unavailable"]) {
        expect(screen.queryByTestId(id), id).toBeNull();
      }
      expect(screen.queryByText(NEUTRAL)).toBeNull();
      expect(screen.queryByText(UNKNOWN_HEADLINE)).toBeNull();
      expect(screen.queryByText(/may have already gone through/)).toBeNull();
      // The mount read, one prepare, one submit of the one approval — nothing else, and nothing by itself.
      expect(api.keys()).toEqual(["latest", "prepare", "submit"]);
      expect(api.calls[2]!.body).toEqual(APPROVAL);
      expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
      // What the screen stands on: no credential and no approval left to sign or re-send with; the account context kept.
      expect(useRealPaymentStore.getState()).toMatchObject({ status: "stranded", authorizingCredentialId: null, pendingSubmission: null, isAuthorizing: false, subOrganizationId: "sub-org-1" });
    });

    it("a handle payment names the person from the server's stored attempt", async () => {
      await send(wrongPasskey, {}, { recipientIdentity: { handle: "smit", displayName: "Smit Patel" } });

      await waitFor(() => expect(screen.getByTestId("real-pay-stranded-details")).toHaveTextContent("$1.00 to Smit Patel (@smit)"));
      expect(screen.getByTestId("real-pay-stranded-details")).not.toHaveTextContent("0x3333");
      expect(screen.getByRole("button", { name: "Cancel payment" })).toBeEnabled();
      absentButtons(["Continue", "Check status"]);
    });

    it("the server's sentence does not matter: a different one still shows only the client's own explanation", async () => {
      await send(() => jsonResponse(409, { error: "Internal: credential-backup != credential-1 for app-user-1", code: "wrong_passkey" }));

      await waitFor(() => expect(screen.getByTestId("real-pay-stranded")).toBeInTheDocument());

      expect(screen.getByText(OTHER_PASSKEY)).toBeInTheDocument();
      expect(screen.queryByText(/credential-backup|app-user-1|Internal/)).toBeNull();
    });

    it("is the same screen a reload gives for a payment bound to another passkey", async () => {
      const api = await send(wrongPasskey, {
        // What /latest answers once the session's passkey is not the payment's: the attempt, with no signing context.
        latest: (n) => (n === 1 ? none() : jsonResponse(200, { attempt: attemptFixture(), subOrganizationId: null, authorizingCredentialId: null, serverNowSeconds: nowSeconds() })),
      });
      await waitFor(() => expect(screen.getByTestId("real-pay-stranded")).toBeInTheDocument());
      const direct = screen.getByTestId("real-pay-stranded").textContent;

      cleanup();
      render(<RealPayForm />);
      await waitFor(() => expect(screen.getByTestId("real-pay-stranded")).toBeInTheDocument());

      expect(screen.getByTestId("real-pay-stranded").textContent).toBe(direct);
      expect(direct).toContain(OTHER_PASSKEY);
      expect(api.keys()).toEqual(["latest", "prepare", "submit", "latest"]);
      expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
    });

    it("Cancel is the user's own action: one request when pressed, and the server's 'yes' brings the empty form back", async () => {
      const api = await send(wrongPasskey, { cancel: () => jsonResponse(200, { attempt: attemptFixture({ state: "cancelled" }) }) });
      await waitFor(() => expect(screen.getByTestId("real-pay-stranded")).toBeInTheDocument());
      expect(api.count("cancel")).toBe(0);

      fireEvent.click(screen.getByRole("button", { name: "Cancel payment" }));

      await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
      expect(api.keys()).toEqual(["latest", "prepare", "submit", "cancel"]);
      expect(api.calls[3]).toMatchObject({ method: "POST" });
      expect(screen.getByLabelText("To")).toHaveValue("");
      expect(screen.getByLabelText("Amount")).toHaveValue("");
      expect(screen.queryByText(OTHER_PASSKEY)).toBeNull();
      expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
    });

    it("a refused Cancel (the payment was sent from another session) shows the server's state through the existing status read — never 'cancelled'", async () => {
      const api = await send(wrongPasskey, { cancel: () => jsonResponse(409, { error: "This payment can no longer be cancelled." }), status: () => statusOf("submitted") });
      await waitFor(() => expect(screen.getByTestId("real-pay-stranded")).toBeInTheDocument());

      fireEvent.click(screen.getByRole("button", { name: "Cancel payment" }));

      await waitFor(() => expect(screen.getByTestId("real-pay-sending")).toBeInTheDocument());
      expect(screen.getByText(CANCEL_LOST_RACE)).toBeInTheDocument();
      expect(screen.queryByTestId("real-pay-form")).toBeNull();
      expect(screen.queryByTestId("real-pay-stranded")).toBeNull();
      expect(api.count("cancel")).toBe(1);
      expect(api.count("submit")).toBe(1);
      expect(api.calls.filter((call) => call.method !== "GET").map((call) => call.key)).toEqual(["prepare", "submit", "cancel"]);
    });

    it("if a later status answer shows the payment as waiting again, Continue leads straight back to cancel-only: no passkey prompt, no request", async () => {
      const api = await send(wrongPasskey, { cancel: () => jsonResponse(409, { error: "Not now." }), status: () => statusOf("awaiting_authorization") });
      await waitFor(() => expect(screen.getByTestId("real-pay-stranded")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: "Cancel payment" }));
      await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());
      const requests = api.calls.length;

      fireEvent.click(screen.getByRole("button", { name: "Continue" }));

      await waitFor(() => expect(screen.getByTestId("real-pay-stranded")).toBeInTheDocument());
      expect(screen.getByText(OTHER_PASSKEY)).toBeInTheDocument();
      absentButtons(["Continue"]);
      expect(api.calls).toHaveLength(requests);
      expect(api.count("submit")).toBe(1);
      expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("every other failed submit keeps the checking screen, with fixed copy as its detail", () => {
    const OTHERS: Array<[string, Handler]> = [
      ["an HTTP 409 with no code (wrong_state)", () => jsonResponse(409, { error: "This payment is no longer awaiting authorization (state: submitted)." })],
      ["an HTTP 409 with the passkey sentence but no code", () => jsonResponse(409, { error: OTHER_PASSKEY })],
      ["an HTTP 409 with the code in the wrong case", () => jsonResponse(409, { error: OTHER_PASSKEY, code: "WRONG_PASSKEY" })],
      ["an HTTP 409 with a padded code", () => jsonResponse(409, { error: OTHER_PASSKEY, code: "wrong_passkey " })],
      ["an HTTP 409 with a non-string code", () => jsonResponse(409, { error: OTHER_PASSKEY, code: 409 })],
      ["an HTTP 409 with an unreadable body", () => new Response("<html>409 wrong_passkey</html>", { status: 409 })],
      ["an HTTP 500 carrying the code", () => jsonResponse(500, WRONG_PASSKEY_BODY)],
      // L-2 D-8: HTTP 401 / 404 left this list — they have their own fixed wording and actions (see the D-8 section).
      ["an HTTP 400", () => jsonResponse(400, { error: "This payment's signature could not be verified." })],
      ["an HTTP 500", () => jsonResponse(500, { error: "Something went wrong. Please try again." })],
      [
        "a network failure",
        () => {
          throw new TypeError("Failed to fetch");
        },
      ],
      ["an HTTP 200 with no attempt", () => jsonResponse(200, {})],
      ["an HTTP 200 that is not JSON", () => new Response("<html>ok</html>", { status: 200 })],
    ];

    it.each(OTHERS)("%s: the checking screen, the fixed detail, Check status — no Cancel, no Review, no raw text", async (_name, submit) => {
      const api = await send(submit);

      await waitFor(() => expect(screen.getByTestId("real-pay-unknown")).toBeInTheDocument());

      expect(screen.getByText(NEUTRAL)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled();
      absentButtons(["Cancel payment", "Review", "Continue", "Approve", "Edit", "Try again", "Check payment status", "Check again", "Send another payment"]);
      for (const id of ["real-pay-stranded", "real-pay-resume", "real-pay-form", "real-pay-review", "real-pay-failed", "real-pay-confirmed"]) {
        expect(screen.queryByTestId(id), id).toBeNull();
      }
      // Fixed client copy only.
      expect(screen.queryByText(RAW_TEXT)).toBeNull();
      expect(screen.getByTestId("real-pay-unknown").textContent).not.toMatch(RAW_TEXT);
      expect(screen.queryByText(OTHER_PASSKEY)).toBeNull();
      // The checking screen's own wording is exactly what it was (a separate, open copy question).
      expect(screen.getByText(UNKNOWN_HEADLINE)).toBeInTheDocument();
      expect(screen.getByText(UNKNOWN_DETAIL)).toBeInTheDocument();
      expect(screen.getByTestId("real-pay-unknown").textContent).toBe(`${UNKNOWN_HEADLINE}${UNKNOWN_DETAIL}${NEUTRAL}Check status`);
      // Nothing was checked, cancelled or re-sent by itself.
      expect(api.keys()).toEqual(["latest", "prepare", "submit"]);
      expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
      expect(useRealPaymentStore.getState()).toMatchObject({ status: "unknown", pendingSubmission: APPROVAL, authorizingCredentialId: "credential-1" });
    });

    it("Check status is one explicit read; a payment found still waiting can be continued with the SAME approval — no second passkey prompt", async () => {
      const api = await send((n) => (n === 1 ? jsonResponse(409, { error: "This payment is no longer awaiting authorization (state: signed)." }) : jsonResponse(200, { attempt: attemptFixture({ state: "submitted" }) })), {
        status: (n) => (n === 1 ? statusOf("awaiting_authorization") : statusOf("submitted")),
      });
      await waitFor(() => expect(screen.getByTestId("real-pay-unknown")).toBeInTheDocument());
      expect(api.count("status")).toBe(0);

      fireEvent.click(screen.getByRole("button", { name: "Check status" }));
      await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());
      expect(api.count("status")).toBe(1);
      expect(screen.queryByText(NEUTRAL)).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Continue" }));

      await waitFor(() => expect(screen.getByTestId("real-pay-sending")).toBeInTheDocument());
      expect(api.calls.filter((call) => call.key === "submit").map((call) => call.body)).toEqual([APPROVAL, APPROVAL]);
      expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
      expect(api.count("cancel")).toBe(0);
    });
  });

  describe("what did not change", () => {
    it("the retryable 503 still returns to the waiting screen with its message and Continue", async () => {
      const api = await send(() => jsonResponse(503, { error: "We couldn't confirm your passkey approval yet. Try again in a moment.", retryable: true }));

      await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());

      expect(screen.getByText(/couldn't confirm your passkey approval yet/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Cancel payment" })).toBeEnabled();
      expect(screen.queryByTestId("real-pay-stranded")).toBeNull();
      expect(screen.queryByTestId("real-pay-unknown")).toBeNull();
      expect(api.keys()).toEqual(["latest", "prepare", "submit"]);
    });

    it("the submit budget's 429 still shows its wait on the waiting screen", async () => {
      const api = await send(
        () => new Response(JSON.stringify({ error: "Too many tries right now. Wait a moment, then tap Continue.", code: "rate_limited", retryable: true }), { status: 429, headers: { "content-type": "application/json", "Retry-After": "120" } }),
        {},
        // An approval window comfortably longer than the wait, so the wait (not "this approval will expire") is what shows.
        { prepared: { ...PREPARED_FIELDS, validUntil: nowSeconds() + 3_600 } },
      );

      await waitFor(() => expect(screen.getByTestId("real-pay-submit-wait")).toBeInTheDocument());

      expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
      expect(screen.queryByTestId("real-pay-stranded")).toBeNull();
      expect(screen.queryByTestId("real-pay-unknown")).toBeNull();
      expect(screen.queryByText(/tap Continue/)).toBeNull();
      expect(api.keys()).toEqual(["latest", "prepare", "submit"]);
    });

    it("an accepted submit still shows Sending…", async () => {
      await send(() => jsonResponse(200, { attempt: attemptFixture({ state: "submitted" }) }), { status: () => statusOf("submitted") });

      await waitFor(() => expect(screen.getByTestId("real-pay-sending")).toBeInTheDocument());

      expect(screen.queryByTestId("real-pay-stranded")).toBeNull();
      expect(screen.queryByTestId("real-pay-unknown")).toBeNull();
      expect(screen.queryByText(NEUTRAL)).toBeNull();
    });

    it("a dismissed passkey prompt still stays on the same pending payment, with nothing sent", async () => {
      signPreparedPaymentMock.mockReset();
      signPreparedPaymentMock.mockRejectedValue(Object.assign(new Error("dismissed"), { name: "NotAllowedError" }));
      const api = await send(wrongPasskey);

      await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());

      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
      expect(screen.queryByTestId("real-pay-stranded")).toBeNull();
      expect(api.keys()).toEqual(["latest", "prepare"]);
    });
  });
});

/**
 * L-2 D-5: the cancel-only ("stranded") screen used to say "This payment didn’t
 * go through" / "It was never sent. You can safely cancel it and try again." No
 * way of reaching that screen can promise that: another session may still send
 * the payment, and a Cancel may lose that race. Before the approval window ends
 * the screen now says only what holds on every path — the payment can't be
 * continued here, it may still go through, cancel and wait for the result.
 * Two string literals changed in the component. The expired wording, the
 * controls, the store, the server and every request are exactly as they were.
 */
describe("RealPayForm — L-2 D-5: stranded screen copy safety", () => {
  const HEADLINE = "This payment can’t be continued here";
  const DETAIL = "This payment may still go through. Select Cancel payment and wait for the result before starting another payment.";
  /** The wording once the approval window has ended — not part of this slice, pinned here as unchanged. */
  const EXPIRED_HEADLINE = "This payment’s approval window expired";
  const EXPIRED_DETAIL = "We’re waiting for final confirmation before showing the final result. This can take a while.";
  const STILL_WAITING = "This is taking longer than usual. Your payment is still waiting for an update.";
  /** What the card must no longer claim (compared in lower case). */
  const OLD_CLAIMS = ["didn’t go through", "didn't go through", "never sent", "safely cancel", "try again"];
  const OTHER_PASSKEY = "This payment was started with a different passkey. Cancel it and start a new payment.";
  const CANCEL_LOST_RACE = "This payment could not be cancelled — it may already be on its way.";
  const CANCEL_UNCONFIRMED = "Could not confirm whether this payment was cancelled. Check its status before trying again.";
  const C1_BODY = { error: "We couldn't confirm this payment's setup. No money was sent by this request. Refresh the app to check its status before trying again.", code: "prepare_outcome_uncertain" };
  const APPROVAL = { attemptId: "payment-attempt-1", signature: "0xsig-d5", activityId: "activity-d5" };
  const ADDRESS_DETAILS = "$1.00 to 0x3333…3333";
  const NO_CONTEXT = { subOrganizationId: null, authorizingCredentialId: null };
  const CONTEXT = { subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1" };

  type Handler = (n: number) => Response | Promise<Response>;
  type Key = "latest" | "prepare" | "cancel" | "submit" | "status" | "lookup";
  type Overrides = Record<string, unknown>;

  beforeEach(() => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready", error: null, hasHydrated: true });
    useRealBalanceStore.setState({ balance: { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" }, status: "ready", error: null });
    useRealPaymentStore.getState().reset();
    useRealPaymentStore.setState({ status: "idle" });
    // Self-contained: this suite installs its own passkey approval for every test.
    signPreparedPaymentMock.mockReset();
    signPreparedPaymentMock.mockResolvedValue({ signature: APPROVAL.signature, activityId: APPROVAL.activityId });
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    cleanup();
    useRealPaymentStore.getState().reset(); // also drops any expiry or follow-up timer a test left armed
    signPreparedPaymentMock.mockReset();
    vi.useRealTimers();
  });

  /** Every request is recorded, including one no handler expects. */
  function stub(handlers: Partial<Record<Key, Handler>>) {
    const calls: Array<{ key: Key | "other"; method: string; body: unknown }> = [];
    const counts: Record<Key, number> = { latest: 0, prepare: 0, cancel: 0, submit: 0, status: 0, lookup: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.endsWith("/api/real/account/balance")) return jsonResponse(200, { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" });
        const key: Key | null = url.endsWith("/api/real/payments/latest")
          ? "latest"
          : url.endsWith("/api/real/payments/prepare")
            ? "prepare"
            : url.endsWith("/cancel")
              ? "cancel"
              : url.endsWith("/api/real/payments/submit")
                ? "submit"
                : url.endsWith("/status")
                  ? "status"
                  : url.endsWith("/api/real/recipients/lookup")
                    ? "lookup"
                    : null;
        calls.push({ key: key ?? "other", method, body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined });
        const handler = key ? handlers[key] : undefined;
        if (!key || !handler) throw new Error(`Unhandled fetch in test: ${method} ${url}`);
        counts[key] += 1;
        return handler(counts[key]);
      }),
    );
    return {
      calls,
      count: (key: Key) => calls.filter((call) => call.key === key).length,
      keys: () => calls.map((call) => call.key),
      /** Everything that could change a payment: the requests that are not reads. */
      writes: () => calls.filter((call) => call.method !== "GET").map((call) => call.key),
    };
  }
  type Api = ReturnType<typeof stub>;

  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const none = () => jsonResponse(200, { attempt: null });
  /** What the server stores once a payment has reached approval: a window that is still comfortably open. */
  const openWindow = (): Overrides => ({ prepared: { ...PREPARED_FIELDS, validUntil: nowSeconds() + 3_600 } });
  /** A payment stopped between its reservation and its preparation carries no prepared fields, and so no window at all. */
  const halfPrepared = (attempt: Overrides): Overrides => ({ ...attempt, prepared: null });
  const latestOf =
    (state: string, attempt: Overrides = {}, context: Overrides = CONTEXT): Handler =>
    () =>
      jsonResponse(200, { attempt: attemptFixture({ state, ...attempt }), ...context, serverNowSeconds: nowSeconds() });
  const statusOf =
    (state: string, attempt: Overrides = {}): Handler =>
    () =>
      jsonResponse(200, { attempt: attemptFixture({ state, ...attempt }), serverNowSeconds: nowSeconds(), reconciliationDeferred: false });
  const prepareOk =
    (attempt: Overrides = {}, context: Overrides = CONTEXT): Handler =>
    () =>
      jsonResponse(200, { attempt: attemptFixture(attempt), ...context, serverNowSeconds: nowSeconds() });
  const wrongPasskey: Handler = () => jsonResponse(409, { error: OTHER_PASSKEY, code: "wrong_passkey" });
  const cancelRefused: Handler = () => jsonResponse(409, { error: "This payment can no longer be cancelled." });
  const cancelled: Handler = () => jsonResponse(200, { attempt: attemptFixture({ state: "cancelled" }) });

  function mount(handlers: Partial<Record<Key, Handler>>): Api {
    const api = stub(handlers);
    render(<RealPayForm />);
    return api;
  }

  /** Mounts the form (no payment yet), types an address payment and presses Approve; the handlers decide the rest. */
  async function approve(handlers: Partial<Record<Key, Handler>>): Promise<Api> {
    const api = stub({ latest: none, ...handlers });
    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("To"), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-review")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    return api;
  }

  /** D-1's explicit check after an unresolved prepare: the second GET /latest answers `found`. */
  async function checkAfterUnresolvedPrepare(found: Handler): Promise<Api> {
    const api = await approve({ latest: (n) => (n === 1 ? none() : found(n)), prepare: () => jsonResponse(500, C1_BODY) });
    await waitFor(() => expect(screen.getByTestId("real-pay-prepare-recovery")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));
    return api;
  }

  const stranded = () => screen.getByTestId("real-pay-stranded");
  /** The card itself: the headline, the detail, the payment's own line (and nothing about the controls or the error line below it). */
  const card = () => stranded().firstElementChild as HTMLElement;
  const onStranded = () => waitFor(() => expect(stranded()).toBeInTheDocument());
  /** Long enough for anything the screen would start by itself to have started. */
  const quiet = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  /** Under fake timers: lets every already-answered request and its follow-on work finish. */
  const settle = () =>
    act(async () => {
      for (let i = 0; i < 100; i++) await Promise.resolve();
    });
  const advance = async (ms: number) => {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
    await settle();
  };

  function expectNeutralCard(details: string) {
    expect(screen.getByText(HEADLINE)).toBeInTheDocument();
    expect(screen.getByText(DETAIL)).toBeInTheDocument();
    expect(screen.getByTestId("real-pay-stranded-details")).toHaveTextContent(details);
    // The whole card, in order: nothing else is on it.
    expect(card().textContent).toBe(`${HEADLINE}${DETAIL}${details}`);
    const text = card().textContent!.toLowerCase();
    for (const claim of OLD_CLAIMS) expect(text, claim).not.toContain(claim);
    expect(screen.queryByText(EXPIRED_HEADLINE)).toBeNull();
    expect(screen.queryByText(EXPIRED_DETAIL)).toBeNull();
  }

  function expectExpiredCard(details: string, extra = "") {
    expect(screen.getByText(EXPIRED_HEADLINE)).toBeInTheDocument();
    expect(screen.getByText(EXPIRED_DETAIL)).toBeInTheDocument();
    expect(card().textContent).toBe(`${EXPIRED_HEADLINE}${EXPIRED_DETAIL}${details}${extra}`);
    expect(screen.queryByText(HEADLINE)).toBeNull();
    expect(screen.queryByText(DETAIL)).toBeNull();
    expect(stranded().textContent).not.toContain("may still go through");
  }

  /** Cancel payment is the screen's only control. */
  function expectCancelOnly() {
    expect(screen.getByRole("button", { name: "Cancel payment" })).toBeEnabled();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    for (const name of ["Continue", "Review", "Approve", "Edit", "Check status", "Checked just now", "Check available later", "Check payment status", "Check again", "Try again", "Send another payment"]) {
      expect(screen.queryByRole("button", { name }), name).toBeNull();
    }
    for (const id of ["real-pay-form", "real-pay-review", "real-pay-preparing", "real-pay-resume", "real-pay-authorizing", "real-pay-sending", "real-pay-unknown", "real-pay-failed", "real-pay-confirmed", "real-pay-status-unavailable", "real-pay-prepare-recovery"]) {
      expect(screen.queryByTestId(id), id).toBeNull();
    }
  }

  /**
   * The eight ways the screen is reached (P1–P8 of the D-5 scope audit), each
   * driven through the form and the fake server exactly as the existing suites
   * do — the store is never set by hand. `keys` is every request the path
   * makes, in order; `signs` is how many passkey approvals it involves.
   */
  type Path = { name: string; arrive: (attempt: Overrides) => Promise<Api>; keys: Array<Key | "other">; signs: number; error: string | null; onlyWithoutWindow?: true };
  const PATHS: Path[] = [
    {
      name: "P1 — the submit is refused for another passkey (the exact coded 409)",
      arrive: (attempt) => approve({ prepare: prepareOk(attempt), submit: wrongPasskey }),
      keys: ["latest", "prepare", "submit"],
      signs: 1,
      error: OTHER_PASSKEY,
    },
    {
      name: "P2 — a reload finds a payment waiting for approval, with no signing context for this session",
      arrive: async (attempt) => mount({ latest: latestOf("awaiting_authorization", attempt, NO_CONTEXT) }),
      keys: ["latest"],
      signs: 0,
      error: OTHER_PASSKEY,
    },
    {
      name: "P2 — the same answer to D-1's explicit check",
      arrive: (attempt) => checkAfterUnresolvedPrepare(latestOf("awaiting_authorization", attempt, NO_CONTEXT)),
      keys: ["latest", "prepare", "latest"],
      signs: 0,
      error: OTHER_PASSKEY,
    },
    {
      name: "P3 — Approve with no authorizing passkey in the prepare answer",
      arrive: (attempt) => approve({ prepare: prepareOk(attempt, { subOrganizationId: "sub-org-1" }) }),
      keys: ["latest", "prepare"],
      signs: 0,
      error: OTHER_PASSKEY,
    },
    {
      name: "P3 — Continue after the refusal, once a status read shows the payment waiting again",
      arrive: async (attempt) => {
        const api = await approve({ prepare: prepareOk(attempt), submit: wrongPasskey, cancel: cancelRefused, status: statusOf("awaiting_authorization", attempt) });
        await onStranded();
        fireEvent.click(screen.getByRole("button", { name: "Cancel payment" }));
        await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());
        fireEvent.click(screen.getByRole("button", { name: "Continue" }));
        return api;
      },
      keys: ["latest", "prepare", "submit", "cancel", "status"],
      signs: 1,
      error: OTHER_PASSKEY,
    },
    {
      name: "P4 — a reload finds a prepared payment",
      arrive: async (attempt) => mount({ latest: latestOf("prepared", halfPrepared(attempt)) }),
      keys: ["latest"],
      signs: 0,
      error: null,
      onlyWithoutWindow: true,
    },
    {
      name: "P4 — D-1's explicit check finds a prepared payment",
      arrive: (attempt) => checkAfterUnresolvedPrepare(latestOf("prepared", halfPrepared(attempt))),
      keys: ["latest", "prepare", "latest"],
      signs: 0,
      error: null,
      onlyWithoutWindow: true,
    },
    {
      name: "P5 — a reload finds a signed payment",
      arrive: async (attempt) => mount({ latest: latestOf("signed", attempt) }),
      keys: ["latest"],
      signs: 0,
      error: null,
    },
    {
      name: "P5 — D-1's explicit check finds a signed payment",
      arrive: (attempt) => checkAfterUnresolvedPrepare(latestOf("signed", attempt)),
      keys: ["latest", "prepare", "latest"],
      signs: 0,
      error: null,
    },
    {
      name: "P6 — Check status (after an unconfirmed submit) reads a signed payment",
      arrive: async (attempt) => {
        const api = await approve({ prepare: prepareOk(attempt), submit: () => jsonResponse(500, { error: "Something went wrong. Please try again." }), status: statusOf("signed", attempt) });
        await waitFor(() => expect(screen.getByTestId("real-pay-unknown")).toBeInTheDocument());
        fireEvent.click(screen.getByRole("button", { name: "Check status" }));
        return api;
      },
      keys: ["latest", "prepare", "submit", "status"],
      signs: 1,
      error: null,
    },
    {
      // D-10: the old P6-prepared path (a payment this page had approved, answered as 'prepared') cannot be produced by the server — see the re-scoped
      // test below. The stranded copy it covered stays covered, here, by an HONEST read: a reserved payment (prepared, no fields) answered the same way.
      name: "P6b — Check status reads a reserved payment (state prepared, no prepared fields)",
      arrive: async (attempt) => {
        const api = mount({ latest: latestOf("prepared", halfPrepared(attempt)), status: statusOf("prepared", halfPrepared(attempt)) });
        await onStranded();
        await act(async () => void (await useRealPaymentStore.getState().checkStatus()));
        return api;
      },
      keys: ["latest", "status"],
      signs: 0,
      error: null,
      onlyWithoutWindow: true,
    },
    {
      name: "P7 — Cancel is refused on the approval screen and the read that follows shows a signed payment",
      arrive: async (attempt) => {
        const api = mount({ latest: latestOf("awaiting_authorization", attempt), cancel: cancelRefused, status: statusOf("signed", attempt) });
        await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());
        fireEvent.click(screen.getByRole("button", { name: "Cancel payment" }));
        return api;
      },
      keys: ["latest", "cancel", "status"],
      signs: 0,
      error: CANCEL_LOST_RACE,
    },
    {
      name: "P7 — Cancel is refused on this screen and the read that follows shows the payment still prepared",
      arrive: async (attempt) => {
        const api = mount({ latest: latestOf("prepared", halfPrepared(attempt)), cancel: cancelRefused, status: statusOf("prepared", halfPrepared(attempt)) });
        await onStranded();
        fireEvent.click(screen.getByRole("button", { name: "Cancel payment" }));
        return api;
      },
      keys: ["latest", "cancel", "status"],
      signs: 0,
      error: CANCEL_LOST_RACE,
      onlyWithoutWindow: true,
    },
    {
      name: "P8 — the submit answers with a stale signed payment",
      arrive: (attempt) => approve({ prepare: prepareOk(attempt), submit: () => jsonResponse(200, { attempt: attemptFixture({ state: "signed", ...attempt }) }) }),
      keys: ["latest", "prepare", "submit"],
      signs: 1,
      error: null,
    },
  ];

  describe.each([
    ["while the approval window is still open", true],
    ["with no stored approval window (an older or half-prepared payment)", false],
  ] as const)("every way onto the screen shows the same neutral wording — %s", (_name, withWindow) => {
    it.each(PATHS.filter((path) => !(withWindow && path.onlyWithoutWindow)))("$name", async (path) => {
      const api = await path.arrive(withWindow ? openWindow() : {});

      await onStranded();
      if (path.error !== null) await waitFor(() => expect(screen.getByText(path.error!)).toBeInTheDocument());
      await quiet();

      // A, C, E: the new headline and detail, the payment's own amount and recipient, and none of the old claims.
      expectNeutralCard(ADDRESS_DETAILS);
      // G, H, I: Cancel payment and nothing else — no Continue, no Review, no Check status.
      expectCancelOnly();
      // The whole screen: the card, the path's own (unchanged) explanation if it has one, and the one button.
      expect(stranded().textContent).toBe(`${HEADLINE}${DETAIL}${ADDRESS_DETAILS}${path.error ?? ""}Cancel payment`);
      // J: showing the screen asked for nothing — these are exactly the requests that led here.
      expect(api.keys()).toEqual(path.keys);
      expect(signPreparedPaymentMock).toHaveBeenCalledTimes(path.signs);
      expect(useRealPaymentStore.getState()).toMatchObject({ status: "stranded", isAttemptPastValidity: false, isAuthorizing: false, isCancelling: false });
    });
  });

  it("P6 (re-scoped by D-10) — after an unconfirmed submit, a Check status answer of 'prepared' carrying the prepared fields cannot come from the server: fixed message, the unknown screen and the payment stay", async () => {
    const UNUSABLE = "We couldn’t check on this payment just now. Try again in a little while.";
    const api = await approve({ prepare: prepareOk({}), submit: () => jsonResponse(500, { error: "Something went wrong. Please try again." }), status: statusOf("prepared", {}) });
    await waitFor(() => expect(screen.getByTestId("real-pay-unknown")).toBeInTheDocument());
    const before = structuredClone(useRealPaymentStore.getState().attempt);
    expect(before).toMatchObject({ id: "payment-attempt-1", state: "awaiting_authorization" });

    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    await waitFor(() => expect(screen.getByText(UNUSABLE)).toBeInTheDocument());
    await quiet();

    // No transition to the stranded screen, no crash, the fixed neutral copy, and the original payment untouched.
    expect(screen.getByTestId("real-pay-unknown")).toBeInTheDocument();
    expect(screen.queryByTestId("real-pay-stranded")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Cannot read|TypeError|Unexpected|Failed to fetch|Unhandled fetch/);
    expect(useRealPaymentStore.getState()).toMatchObject({ status: "unknown", error: UNUSABLE, sessionRecovery: null, isStatusDeferred: true, authorizingCredentialId: "credential-1", subOrganizationId: "sub-org-1" });
    expect(useRealPaymentStore.getState().attempt).toEqual(before);
    // Exactly the requests that led here plus the one read: nothing was signed, submitted, cancelled or prepared again.
    expect(api.keys()).toEqual(["latest", "prepare", "submit", "status"]);
    expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
  });

  describe("the payment's own line is unchanged", () => {
    it.each([
      ["a name and its @handle", { handle: "smit", displayName: "Smit Patel" }, "$1.00 to Smit Patel (@smit)"],
      ["an @handle with no name", { handle: "smit", displayName: null }, "$1.00 to @smit"],
    ] as const)("F — %s, from the server's stored attempt", async (_name, recipientIdentity, details) => {
      mount({ latest: latestOf("signed", { ...openWindow(), recipientIdentity }) });

      await onStranded();

      expectNeutralCard(details);
      expect(screen.getByTestId("real-pay-stranded-details")).not.toHaveTextContent("0x3333");
      expectCancelOnly();
    });

    it("E — the amount and recipient come from the stored attempt, never from what was typed into the form", async () => {
      // The form said 5.00 to another address; the server's payment is 1.00 to RECIPIENT.
      const api = stub({ latest: (n) => (n === 1 ? none() : latestOf("signed", openWindow())(n)), prepare: () => jsonResponse(500, C1_BODY) });
      render(<RealPayForm />);
      await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText("To"), { target: { value: "0x4444444444444444444444444444444444444444" } });
      fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5.00" } });
      fireEvent.click(screen.getByRole("button", { name: "Review" }));
      await waitFor(() => expect(screen.getByTestId("real-pay-review")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      await waitFor(() => expect(screen.getByTestId("real-pay-prepare-recovery")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));

      await onStranded();

      expectNeutralCard(ADDRESS_DETAILS);
      expect(stranded().textContent).not.toMatch(/5\.00|0x4444/);
      expect(api.keys()).toEqual(["latest", "prepare", "latest"]);
    });
  });

  describe("D — once the approval window has ended, the wording is exactly what it was", () => {
    it("a payment found already past its window: the unchanged expiry headline and detail, Cancel payment, and the one status read it always made", async () => {
      const validUntil = 1_900_000_600;
      const attempt = { prepared: { ...PREPARED_FIELDS, validUntil } };
      const expired = (state: string) => () => jsonResponse(200, { attempt: attemptFixture({ state, ...attempt }), ...CONTEXT, serverNowSeconds: validUntil + 100 });
      const api = mount({ latest: expired("signed"), status: expired("signed") });

      await waitFor(() => expect(screen.getByText(EXPIRED_HEADLINE)).toBeInTheDocument());
      await quiet();

      expectExpiredCard(ADDRESS_DETAILS);
      expect(stranded().textContent).toBe(`${EXPIRED_HEADLINE}${EXPIRED_DETAIL}${ADDRESS_DETAILS}Cancel payment`);
      // While the automatic follow-ups are still scheduled there is no extra control.
      expectCancelOnly();
      expect(api.keys()).toEqual(["latest", "status"]);
      expect(useRealPaymentStore.getState()).toMatchObject({ status: "stranded", isAttemptPastValidity: true, isFollowUpExhausted: false });
    });

    it("a payment to a name, found already past its window: the same unchanged wording above the name line", async () => {
      const validUntil = 1_900_000_600;
      const attempt = { prepared: { ...PREPARED_FIELDS, validUntil }, recipientIdentity: { handle: "smit", displayName: "Smit Patel" } };
      const expired = () => jsonResponse(200, { attempt: attemptFixture({ state: "signed", ...attempt }), ...CONTEXT, serverNowSeconds: validUntil + 100 });
      mount({ latest: expired, status: expired });

      await waitFor(() => expect(screen.getByText(EXPIRED_HEADLINE)).toBeInTheDocument());

      expectExpiredCard("$1.00 to Smit Patel (@smit)");
      expectCancelOnly();
    });

    it("the same screen switches at the window's end — neutral wording until then, the unchanged expiry wording after — with the one status read it always made", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const attempt = { prepared: { ...PREPARED_FIELDS, validUntil: nowSeconds() + 600 } };
      const api = stub({ latest: latestOf("signed", attempt), status: statusOf("signed", attempt) });
      render(<RealPayForm />);
      await settle();

      expectNeutralCard(ADDRESS_DETAILS);
      expectCancelOnly();
      expect(api.keys()).toEqual(["latest"]);

      // One millisecond before the store's own timer (the window's end, plus the second the server allows).
      await advance(600_999);
      expectNeutralCard(ADDRESS_DETAILS);
      expect(api.keys()).toEqual(["latest"]);

      await advance(1);
      expectExpiredCard(ADDRESS_DETAILS);
      expectCancelOnly();
      expect(api.keys()).toEqual(["latest", "status"]);
      expect(api.writes()).toEqual([]);
    });
  });

  describe("I — Check status appears only where it already did", () => {
    it("after the window ends: not while follow-ups are scheduled; once all eight have run, with the still-waiting line — and then nothing more by itself", async () => {
      const { followUpDelayMs, MAX_AUTOMATIC_FOLLOW_UPS } = await import("@/lib/stores/real-payment-store");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const validUntil = nowSeconds() - 100;
      const attempt = { prepared: { ...PREPARED_FIELDS, validUntil } };
      const api = stub({ latest: latestOf("signed", attempt), status: statusOf("signed", attempt) });
      render(<RealPayForm />);
      await settle();

      expectExpiredCard(ADDRESS_DETAILS);
      expectCancelOnly();
      expect(api.keys()).toEqual(["latest", "status"]);

      for (let i = 0; i < MAX_AUTOMATIC_FOLLOW_UPS; i++) {
        expect(screen.queryByRole("button", { name: "Check status" }), `before follow-up ${i + 1}`).toBeNull();
        await advance(followUpDelayMs(i));
        expect(api.count("status"), `after follow-up ${i + 1}`).toBe(i + 2);
      }

      expectExpiredCard(ADDRESS_DETAILS, STILL_WAITING);
      expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Cancel payment" })).toBeEnabled();
      expect(stranded().textContent).toBe(`${EXPIRED_HEADLINE}${EXPIRED_DETAIL}${ADDRESS_DETAILS}${STILL_WAITING}Check statusCancel payment`);

      // Exhausted: no automatic request of any kind, however long the page stays open.
      await advance(24 * 60 * 60 * 1000);
      expect(api.count("status")).toBe(MAX_AUTOMATIC_FOLLOW_UPS + 1);

      // The manual check is one read per press.
      fireEvent.click(screen.getByRole("button", { name: "Check status" }));
      await settle();
      expect(api.count("status")).toBe(MAX_AUTOMATIC_FOLLOW_UPS + 2);
      expect(screen.getByRole("button", { name: "Checked just now" })).toBeDisabled();
      expect(api.writes()).toEqual([]);
      expectExpiredCard(ADDRESS_DETAILS, STILL_WAITING);
    });

    it("before the window ends: only if the follow-ups have already run out (the existing stale-flag case), beside the neutral wording", async () => {
      const api = mount({ latest: latestOf("signed", openWindow()), status: statusOf("signed", openWindow()) });
      await onStranded();
      expectCancelOnly();

      // The same way the existing LOW-1 test reaches it: the follow-up budget is spent while the validity flag is still false.
      act(() => useRealPaymentStore.setState({ isFollowUpExhausted: true, isAttemptPastValidity: false }));

      expect(card().textContent).toBe(`${HEADLINE}${DETAIL}${ADDRESS_DETAILS}${STILL_WAITING}`);
      expect(stranded().textContent).toBe(`${HEADLINE}${DETAIL}${ADDRESS_DETAILS}${STILL_WAITING}Check statusCancel payment`);
      expect(api.keys()).toEqual(["latest"]);

      fireEvent.click(screen.getByRole("button", { name: "Check status" }));
      await waitFor(() => expect(api.count("status")).toBe(1));
      await waitFor(() => expect(screen.getByRole("button", { name: "Checked just now" })).toBeDisabled());
      expect(api.keys()).toEqual(["latest", "status"]);
      expect(screen.getByText(HEADLINE)).toBeInTheDocument();
      expect(screen.getByText(DETAIL)).toBeInTheDocument();
    });
  });

  describe("J — showing the screen sends nothing", () => {
    it("an open window: no request for as long as the window lasts", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const attempt = { prepared: { ...PREPARED_FIELDS, validUntil: nowSeconds() + 3_600 } };
      const api = stub({ latest: latestOf("signed", attempt) });
      render(<RealPayForm />);
      await settle();
      expectNeutralCard(ADDRESS_DETAILS);

      await advance(3_600_000); // up to the window's end; the store's own timer is one second later

      expect(api.keys()).toEqual(["latest"]);
      expectNeutralCard(ADDRESS_DETAILS);
      expectCancelOnly();
      expect(signPreparedPaymentMock).not.toHaveBeenCalled();
    });

    it("no stored window (a prepared payment): no request and no change of wording, however long the page stays open", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const api = stub({ latest: latestOf("prepared", halfPrepared({})) });
      render(<RealPayForm />);
      await settle();
      expectNeutralCard(ADDRESS_DETAILS);

      await advance(7 * 24 * 60 * 60 * 1000);

      // Such a payment never reaches the expiry wording (stale prepared rows are a separate, open question — L-2 E).
      expect(api.keys()).toEqual(["latest"]);
      expectNeutralCard(ADDRESS_DETAILS);
      expectCancelOnly();
    });
  });

  describe("Cancel is exactly what it was", () => {
    it("K — the server's 'yes' brings the empty form back: one POST, sent only when pressed", async () => {
      const api = mount({ latest: latestOf("signed", openWindow()), cancel: cancelled });
      await onStranded();
      await quiet();
      expect(api.count("cancel")).toBe(0);

      fireEvent.click(screen.getByRole("button", { name: "Cancel payment" }));

      await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
      expect(api.keys()).toEqual(["latest", "cancel"]);
      expect(api.calls[1]).toMatchObject({ key: "cancel", method: "POST", body: undefined });
      expect(screen.getByLabelText("To")).toHaveValue("");
      expect(screen.getByLabelText("Amount")).toHaveValue("");
      expect(screen.getByRole("button", { name: "Review" })).toBeEnabled();
      expect(screen.queryByTestId("real-pay-stranded")).toBeNull();
      expect(document.body.textContent).not.toContain(HEADLINE);
      expect(document.body.textContent).not.toContain(DETAIL);
      expect(useRealPaymentStore.getState()).toMatchObject({ status: "editing", attempt: null, error: null });
      expect(signPreparedPaymentMock).not.toHaveBeenCalled();
    });

    it("L — a refused Cancel whose follow-up read shows the payment sent: 'Sending…' with the lost-race line, never the form and never 'cancelled'", async () => {
      const api = mount({ latest: latestOf("signed", openWindow()), cancel: cancelRefused, status: statusOf("submitted", openWindow()) });
      await onStranded();
      expectNeutralCard(ADDRESS_DETAILS);

      fireEvent.click(screen.getByRole("button", { name: "Cancel payment" }));

      await waitFor(() => expect(screen.getByTestId("real-pay-sending")).toBeInTheDocument());
      await quiet();
      expect(screen.getByText(CANCEL_LOST_RACE)).toBeInTheDocument();
      expect(screen.queryByTestId("real-pay-stranded")).toBeNull();
      expect(screen.queryByTestId("real-pay-form")).toBeNull();
      expect(screen.queryByRole("button", { name: "Cancel payment" })).toBeNull();
      expect(document.body.textContent).not.toContain(HEADLINE);
      // One Cancel, the one read that follows a refusal, and nothing else.
      expect(api.keys()).toEqual(["latest", "cancel", "status"]);
      expect(api.writes()).toEqual(["cancel"]);
      expect(useRealPaymentStore.getState()).toMatchObject({ status: "submitted" });
    });

    it("M — a refused Cancel, and a second one inside the same wait: the neutral wording stands beside the refusal, and there is one follow-up read, not two", async () => {
      const api = mount({ latest: latestOf("signed", openWindow()), cancel: cancelRefused, status: statusOf("signed", openWindow()) });
      await onStranded();

      fireEvent.click(screen.getByRole("button", { name: "Cancel payment" }));
      await waitFor(() => expect(screen.getByText(CANCEL_LOST_RACE)).toBeInTheDocument());
      await waitFor(() => expect(screen.getByRole("button", { name: "Cancel payment" })).toBeEnabled());
      const afterFirst = `${HEADLINE}${DETAIL}${ADDRESS_DETAILS}${CANCEL_LOST_RACE}Cancel payment`;
      expect(stranded().textContent).toBe(afterFirst);
      expect(api.keys()).toEqual(["latest", "cancel", "status"]);

      fireEvent.click(screen.getByRole("button", { name: "Cancel payment" }));
      await waitFor(() => expect(api.count("cancel")).toBe(2));
      await waitFor(() => expect(screen.getByRole("button", { name: "Cancel payment" })).toBeEnabled());
      await quiet();

      // Still the same payment, the same wording and the same refusal: "may still go through" and "may already be on its way" agree.
      expectNeutralCard(ADDRESS_DETAILS);
      expect(stranded().textContent).toBe(afterFirst);
      expect(api.keys()).toEqual(["latest", "cancel", "status", "cancel"]);
      expect(useRealPaymentStore.getState()).toMatchObject({ status: "stranded", error: CANCEL_LOST_RACE });
    });

    it.each([
      [
        "the Cancel request itself fails on the network",
        {
          cancel: () => {
            throw new TypeError("Failed to fetch");
          },
        },
        ["latest", "cancel"],
      ],
      ["the Cancel is refused and the read that follows fails", { cancel: cancelRefused, status: () => jsonResponse(500, { error: "boom" }) }, ["latest", "cancel", "status"]],
    ] as Array<[string, Partial<Record<Key, Handler>>, string[]]>)("N — %s: the payment stays as it is, with the existing unconfirmed line and no raw text", async (_name, handlers, keys) => {
      const api = mount({ latest: latestOf("signed", openWindow()), ...handlers });
      await onStranded();

      fireEvent.click(screen.getByRole("button", { name: "Cancel payment" }));

      await waitFor(() => expect(screen.getByText(CANCEL_UNCONFIRMED)).toBeInTheDocument());
      await waitFor(() => expect(screen.getByRole("button", { name: "Cancel payment" })).toBeEnabled());
      await quiet();
      expectNeutralCard(ADDRESS_DETAILS);
      expectCancelOnly();
      expect(stranded().textContent).toBe(`${HEADLINE}${DETAIL}${ADDRESS_DETAILS}${CANCEL_UNCONFIRMED}Cancel payment`);
      expect(document.body.textContent).not.toMatch(/Failed to fetch|boom|TypeError/);
      expect(api.keys()).toEqual(keys);
      expect(useRealPaymentStore.getState()).toMatchObject({ status: "stranded" });
      expect(useRealPaymentStore.getState().attempt).toMatchObject({ id: "payment-attempt-1", state: "signed" });
    });
  });

  it("O — after the wrong-passkey refusal nothing is signed or sent again: not by waiting, not at the window's end, not by calling the store directly", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const attempt = { prepared: { ...PREPARED_FIELDS, validUntil: nowSeconds() + 600 } };
    const api = stub({ latest: none, prepare: prepareOk(attempt), submit: wrongPasskey, status: statusOf("awaiting_authorization", attempt) });
    render(<RealPayForm />);
    await settle();
    fireEvent.change(screen.getByLabelText("To"), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await settle();

    expectNeutralCard(ADDRESS_DETAILS);
    expectCancelOnly();
    expect(screen.getByText(OTHER_PASSKEY)).toBeInTheDocument();
    expect(api.keys()).toEqual(["latest", "prepare", "submit"]);
    expect(api.calls[2]!.body).toEqual(APPROVAL);
    expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
    expect(useRealPaymentStore.getState()).toMatchObject({ status: "stranded", authorizingCredentialId: null, pendingSubmission: null, isAuthorizing: false });

    // The store refuses too: neither action has anything to do from this screen.
    await act(async () => {
      await useRealPaymentStore.getState().resumeAuthorization();
      await useRealPaymentStore.getState().confirmAndSend();
    });
    await settle();
    expect(api.keys()).toEqual(["latest", "prepare", "submit"]);

    // Up to the window's end: nothing at all.
    await advance(600_999);
    expect(api.keys()).toEqual(["latest", "prepare", "submit"]);
    expectNeutralCard(ADDRESS_DETAILS);

    // At its end and afterwards: the existing read-only status checks, and only those.
    await advance(1);
    await advance(75_000);
    expect(api.keys()).toEqual(["latest", "prepare", "submit", "status", "status"]);
    expect(api.writes()).toEqual(["prepare", "submit"]);
    expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  describe("P — the other screens are what they were, and the new wording is on none of them", () => {
    const D1_UNCERTAIN = "We couldn't confirm whether your payment was set up. Check its status before trying again.";
    const D2_ACCOUNT_NOT_READY = "We can't send payments from this account right now. This payment wasn't started.";
    const D3A_HEADLINE = "We couldn't check your payments right now.";
    const D3A_DETAIL = "Check again before starting a new payment.";
    const EXPIRED_REASON = "This payment expired before it was included on-chain. No money moved.";

    const SCREENS: Array<{ name: string; arrive: () => Promise<unknown>; testId: string; texts: string[]; buttons: string[] }> = [
      { name: "the ordinary form", arrive: async () => mount({ latest: none }), testId: "real-pay-form", texts: [], buttons: ["Review"] },
      { name: "D-1: an unresolved preparation", arrive: () => approve({ prepare: () => jsonResponse(500, C1_BODY) }), testId: "real-pay-prepare-recovery", texts: [D1_UNCERTAIN], buttons: ["Check payment status"] },
      {
        name: "D-2: the account can't send",
        arrive: () => approve({ prepare: () => jsonResponse(409, { error: "Your account isn't fully set up yet.", code: "account_not_ready" }) }),
        testId: "real-pay-form",
        texts: [D2_ACCOUNT_NOT_READY],
        buttons: ["Review"],
      },
      { name: "D-3a: the first payment check is unavailable", arrive: async () => mount({ latest: () => jsonResponse(500, { error: "boom" }) }), testId: "real-pay-status-unavailable", texts: [D3A_HEADLINE, D3A_DETAIL], buttons: ["Check again"] },
      {
        name: "a payment waiting for this session's approval",
        arrive: async () => mount({ latest: latestOf("awaiting_authorization", openWindow()) }),
        testId: "real-pay-resume",
        texts: ["A payment is waiting for your approval", "Only continue if you started this payment."],
        buttons: ["Continue", "Cancel payment"],
      },
      { name: "a payment being checked", arrive: async () => mount({ latest: latestOf("submitting") }), testId: "real-pay-unknown", texts: ["We're checking on this payment"], buttons: ["Check status"] },
      { name: "a payment being sent", arrive: async () => mount({ latest: latestOf("submitted"), status: statusOf("submitted") }), testId: "real-pay-sending", texts: ["Sending…"], buttons: [] },
      { name: "a failed payment", arrive: async () => mount({ latest: latestOf("failed", { failureReason: EXPIRED_REASON }) }), testId: "real-pay-failed", texts: [EXPIRED_REASON], buttons: ["Try again"] },
      { name: "a sent payment", arrive: async () => mount({ latest: latestOf("confirmed", { transactionHash: "0xabc" }) }), testId: "real-pay-confirmed", texts: ["Sent"], buttons: ["Send another payment"] },
    ];

    it.each(SCREENS)("$name", async ({ arrive, testId, texts, buttons }) => {
      await arrive();

      await waitFor(() => {
        expect(screen.getByTestId(testId)).toBeInTheDocument();
        for (const text of texts) expect(screen.getByText(text)).toBeInTheDocument();
      });
      for (const name of buttons) expect(screen.getByRole("button", { name }), name).toBeInTheDocument();
      expect(screen.queryByTestId("real-pay-stranded")).toBeNull();
      expect(document.body.textContent).not.toContain(HEADLINE);
      expect(document.body.textContent).not.toContain(DETAIL);
      expect(document.body.textContent).not.toContain("may still go through");
    });
  });

  it("Q — Practice Mode is untouched: showing the screen and cancelling from it never writes Practice state or its storage", async () => {
    const { SIMULATION_STORE_NAME, useSimulationStore } = await import("@/lib/stores/simulation-store");
    const practiceBefore = useSimulationStore.getState().state;
    const storedBefore = localStorage.getItem(SIMULATION_STORE_NAME);

    mount({ latest: latestOf("signed", openWindow()), cancel: cancelled });
    await onStranded();
    expectNeutralCard(ADDRESS_DETAILS);
    fireEvent.click(screen.getByRole("button", { name: "Cancel payment" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());

    // Reference equality: the Practice store's set() was never called, and nothing was persisted.
    expect(useSimulationStore.getState().state).toBe(practiceBefore);
    expect(localStorage.getItem(SIMULATION_STORE_NAME)).toBe(storedBefore);
  });
});

describe("RealPayForm — L-2 D-6: bounded submit wait", () => {
  const NEUTRAL = "We couldn't confirm whether this payment was sent. Check its status before trying again.";
  const UNKNOWN_HEADLINE = "We're checking on this payment";
  const UNKNOWN_DETAIL = "It may have already gone through. We'll show the result here once we know — sending another payment is disabled until this one resolves.";
  const OTHER_PASSKEY = "This payment was started with a different passkey. Cancel it and start a new payment.";
  const RAW_TEXT = /Failed to fetch|Cannot read|Unexpected|not valid JSON|Not authenticated|Payment not found|no longer awaiting|\(state:|Something went wrong|Request failed|wrong_passkey|TypeError|SyntaxError|aborted/;
  const APPROVAL = { attemptId: "payment-attempt-1", signature: "0xsig-d6", activityId: "activity-d6" };
  const DEADLINE = 60_000;

  type Handler = (n: number) => Response | Promise<Response>;
  type Key = "latest" | "prepare" | "cancel" | "submit" | "status" | "balance";

  beforeEach(() => {
    // Real time keeps flowing (so waitFor's polling works); the 60 s deadline is crossed by advancing the fake clock.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready", error: null, hasHydrated: true });
    useRealBalanceStore.setState({ balance: { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" }, status: "ready", error: null });
    useRealPaymentStore.getState().reset();
    useRealPaymentStore.setState({ status: "idle" });
    signPreparedPaymentMock.mockReset();
    signPreparedPaymentMock.mockResolvedValue({ signature: APPROVAL.signature, activityId: APPROVAL.activityId });
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    cleanup();
    useRealPaymentStore.getState().reset();
    signPreparedPaymentMock.mockReset();
    vi.useRealTimers();
  });

  function stub(handlers: Partial<Record<Key, Handler>>) {
    const calls: Array<{ key: Key | "other"; method: string; body: unknown }> = [];
    const counts: Record<Key, number> = { latest: 0, prepare: 0, cancel: 0, submit: 0, status: 0, balance: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        const key: Key | null = url.endsWith("/api/real/payments/latest")
          ? "latest"
          : url.endsWith("/api/real/payments/prepare")
            ? "prepare"
            : url.endsWith("/cancel")
              ? "cancel"
              : url.endsWith("/api/real/payments/submit")
                ? "submit"
                : url.endsWith("/status")
                  ? "status"
                  : url.endsWith("/api/real/account/balance")
                    ? "balance"
                    : null;
        calls.push({ key: key ?? "other", method, body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined });
        const handler = key ? handlers[key] : undefined;
        if (!key || !handler) throw new Error(`Unhandled fetch in test: ${method} ${url}`);
        counts[key] += 1;
        return handler(counts[key]);
      }),
    );
    return { calls, count: (key: Key) => calls.filter((call) => call.key === key).length, keys: () => calls.map((call) => call.key) };
  }

  function held() {
    let resolve: (response: Response) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const promise = new Promise<Response>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const statusOf = (state: string) => jsonResponse(200, { attempt: attemptFixture({ state }), serverNowSeconds: nowSeconds(), reconciliationDeferred: false });
  const absentButtons = (names: string[]) => {
    for (const name of names) expect(screen.queryByRole("button", { name }), name).toBeNull();
  };
  const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

  /** Mounts the form and approves an address payment (one passkey approval); POST /submit is answered by `submit`. */
  async function send(submit: Handler, others: Partial<Record<Key, Handler>> = {}) {
    const api = stub({
      latest: () => jsonResponse(200, { attempt: null }),
      prepare: () => jsonResponse(200, { attempt: attemptFixture(), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: nowSeconds() }),
      balance: () => jsonResponse(200, { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" }),
      submit,
      ...others,
    });
    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("To"), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-review")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    return api;
  }

  it("before 60 s the form says 'Sending…' with no way to act; at 60 s the existing checking screen appears with Check status", async () => {
    const gate = held();
    const api = await send(() => gate.promise);
    await waitFor(() => expect(screen.getByTestId("real-pay-sending")).toBeInTheDocument());
    expect(screen.getByText("Sending…")).toBeInTheDocument();
    absentButtons(["Check status", "Continue", "Cancel payment", "Review", "Approve"]);

    // (The exact 60 s boundary is pinned in the store tests; with real time also flowing here, a 2 s margin keeps this one stable.)
    await advance(DEADLINE - 2_000);
    expect(screen.getByTestId("real-pay-sending")).toBeInTheDocument();
    expect(screen.queryByTestId("real-pay-unknown")).toBeNull();

    await advance(4_000);

    expect(screen.getByTestId("real-pay-unknown")).toBeInTheDocument();
    expect(screen.getByText(UNKNOWN_HEADLINE)).toBeInTheDocument();
    expect(screen.getByText(UNKNOWN_DETAIL)).toBeInTheDocument();
    expect(screen.getByText(NEUTRAL)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled();
    // Nothing that acts on the payment, or starts another one, is offered here.
    absentButtons(["Review", "Continue", "Cancel payment", "Approve", "Edit", "Try again", "Send another payment", "Check payment status", "Check again"]);
    for (const id of ["real-pay-sending", "real-pay-resume", "real-pay-stranded", "real-pay-form", "real-pay-review", "real-pay-failed", "real-pay-confirmed", "real-pay-status-unavailable"]) {
      expect(screen.queryByTestId(id), id).toBeNull();
    }
    expect(screen.queryByText("Sending…")).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(RAW_TEXT);
    // The mount read, one prepare, one submit of the one approval — nothing else, and nothing by itself.
    expect(api.keys()).toEqual(["latest", "prepare", "submit"]);
    expect(api.calls[2]!.body).toEqual(APPROVAL);
    expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
    expect(useRealPaymentStore.getState()).toMatchObject({ status: "unknown", pendingSubmission: APPROVAL, authorizingCredentialId: "credential-1" });

    gate.resolve(jsonResponse(200, { attempt: attemptFixture({ state: "failed", failureReason: "nope" }) }));
  });

  it("a late answer after the checking screen appeared changes nothing on screen and asks for nothing", async () => {
    const gate = held();
    const api = await send(() => gate.promise);
    await waitFor(() => expect(screen.getByTestId("real-pay-sending")).toBeInTheDocument());
    await advance(DEADLINE);
    expect(screen.getByTestId("real-pay-unknown")).toBeInTheDocument();
    const before = document.body.innerHTML;

    gate.resolve(jsonResponse(200, { attempt: attemptFixture({ state: "confirmed", transactionHash: "0xabc" }) }));
    await advance(1_000);

    expect(screen.getByTestId("real-pay-unknown")).toBeInTheDocument();
    expect(document.body.innerHTML).toBe(before);
    expect(screen.queryByTestId("real-pay-confirmed")).toBeNull();
    expect(api.keys()).toEqual(["latest", "prepare", "submit"]); // no status read, no balance refresh
  });

  it("Check status 'still waiting for approval' leads to Continue: the retained approval is re-sent — no second passkey prompt, exactly one more submit", async () => {
    const gate = held();
    const api = await send((n) => (n === 1 ? gate.promise : statusOf("submitted")), {
      status: () => jsonResponse(200, { attempt: attemptFixture(), serverNowSeconds: nowSeconds(), reconciliationDeferred: false }),
    });
    await waitFor(() => expect(screen.getByTestId("real-pay-sending")).toBeInTheDocument());
    await advance(DEADLINE);
    expect(screen.getByTestId("real-pay-unknown")).toBeInTheDocument();
    expect(api.count("submit")).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());
    expect(api.count("status")).toBe(1);
    expect(api.count("submit")).toBe(1); // checking is not sending

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-sending")).toBeInTheDocument());

    expect(api.count("submit")).toBe(2);
    expect(api.calls.filter((call) => call.key === "submit").map((call) => call.body)).toEqual([APPROVAL, APPROVAL]);
    expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
    gate.resolve(jsonResponse(500, { error: "late" }));
  });

  it.each([
    ["submitted", "real-pay-sending"],
    ["failed", "real-pay-failed"],
    ["confirmed", "real-pay-confirmed"],
  ] as const)("Check status after the checking screen can show a '%s' payment", async (state, testId) => {
    const gate = held();
    const api = await send(() => gate.promise, { status: () => statusOf(state) });
    await waitFor(() => expect(screen.getByTestId("real-pay-sending")).toBeInTheDocument());
    await advance(DEADLINE);
    expect(screen.getByTestId("real-pay-unknown")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Check status" }));

    await waitFor(() => expect(screen.getByTestId(testId)).toBeInTheDocument());
    expect(screen.queryByTestId("real-pay-unknown")).toBeNull();
    expect(api.count("submit")).toBe(1);
    gate.resolve(jsonResponse(409, { error: OTHER_PASSKEY, code: "wrong_passkey" }));
  });

  it("a prompt open longer than the deadline does not show the checking screen", async () => {
    let approve: (value: { signature: string; activityId: string }) => void = () => {};
    signPreparedPaymentMock.mockReset();
    signPreparedPaymentMock.mockReturnValue(new Promise((resolve) => (approve = resolve)));
    const gate = held();
    const api = await send(() => gate.promise);
    await waitFor(() => expect(screen.getByTestId("real-pay-authorizing")).toBeInTheDocument());

    await advance(5 * DEADLINE);
    expect(screen.getByTestId("real-pay-authorizing")).toBeInTheDocument();
    expect(screen.queryByTestId("real-pay-unknown")).toBeNull();
    expect(api.count("submit")).toBe(0);

    await act(async () => approve({ signature: APPROVAL.signature, activityId: APPROVAL.activityId }));
    await waitFor(() => expect(screen.getByTestId("real-pay-sending")).toBeInTheDocument());
    await advance(DEADLINE - 2_000);
    expect(screen.getByTestId("real-pay-sending")).toBeInTheDocument();
    await advance(4_000);
    expect(screen.getByTestId("real-pay-unknown")).toBeInTheDocument();
    gate.resolve(jsonResponse(500, { error: "late" }));
  });

  it("a timely answer is exactly what it always was, and the clock passing afterwards changes nothing", async () => {
    const api = await send(() => jsonResponse(200, { attempt: attemptFixture({ state: "submitted" }) }), { status: () => statusOf("submitted") });
    await waitFor(() => expect(screen.getByTestId("real-pay-sending")).toBeInTheDocument());
    const requests = api.calls.length;

    await advance(10 * DEADLINE);

    expect(screen.getByTestId("real-pay-sending")).toBeInTheDocument();
    expect(screen.queryByTestId("real-pay-unknown")).toBeNull();
    expect(api.count("submit")).toBe(1);
    expect(api.calls.length).toBeGreaterThanOrEqual(requests); // the existing post-submit status check may follow; no second submit ever
  });
});

/**
 * L-2 D-7: what the person sees when POST /submit answers HTTP 200 with
 * something that is not this payment's own attempt in a showable shape. The
 * page says only that it could not confirm; Check status is the way forward and
 * asks about the ORIGINAL payment. Mocked fetch only: no network, provider or
 * passkey.
 */
describe("RealPayForm — L-2 D-7: malformed submit response recovery", () => {
  const NEUTRAL = "We couldn't confirm whether this payment was sent. Check its status before trying again.";
  const UNKNOWN_HEADLINE = "We're checking on this payment";
  const MARKER = "D7-RAW-MARKER-must-never-be-shown";
  const APPROVAL = { attemptId: "payment-attempt-1", signature: "0xsig-d7", activityId: "activity-d7" };
  const RAW_TEXT = /Cannot read|Unexpected|not valid JSON|Objects are not valid|\[object Object\]|undefined|TypeError|wrong_passkey/;

  type Handler = (n: number) => Response | Promise<Response>;
  type Key = "latest" | "prepare" | "submit" | "status" | "balance" | "cancel";

  beforeEach(() => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready", error: null, hasHydrated: true });
    useRealBalanceStore.setState({ balance: { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" }, status: "ready", error: null });
    useRealPaymentStore.getState().reset();
    useRealPaymentStore.setState({ status: "idle" });
    signPreparedPaymentMock.mockReset();
    signPreparedPaymentMock.mockResolvedValue({ signature: APPROVAL.signature, activityId: APPROVAL.activityId });
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    cleanup();
    useRealPaymentStore.getState().reset();
    signPreparedPaymentMock.mockReset();
  });

  function stub(handlers: Partial<Record<Key, Handler>>) {
    const calls: Array<{ key: Key | "other"; url: string; method: string; body: unknown }> = [];
    const counts: Record<Key, number> = { latest: 0, prepare: 0, submit: 0, status: 0, balance: 0, cancel: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        const key: Key | null = url.endsWith("/api/real/payments/latest")
          ? "latest"
          : url.endsWith("/api/real/payments/prepare")
            ? "prepare"
            : url.endsWith("/cancel")
              ? "cancel"
              : url.endsWith("/api/real/payments/submit")
                ? "submit"
                : url.endsWith("/status")
                  ? "status"
                  : url.endsWith("/api/real/account/balance")
                    ? "balance"
                    : null;
        calls.push({ key: key ?? "other", url, method, body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined });
        const handler = key ? handlers[key] : undefined;
        if (!key || !handler) throw new Error(`Unhandled fetch in test: ${method} ${url}`);
        counts[key] += 1;
        return handler(counts[key]);
      }),
    );
    return { calls, count: (key: Key) => calls.filter((call) => call.key === key).length, keys: () => calls.map((call) => call.key) };
  }

  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const statusOf = (state: string) => jsonResponse(200, { attempt: attemptFixture({ state }), serverNowSeconds: nowSeconds(), reconciliationDeferred: false });
  const absentButtons = (names: string[]) => {
    for (const name of names) expect(screen.queryByRole("button", { name }), name).toBeNull();
  };

  async function send(submit: Handler, others: Partial<Record<Key, Handler>> = {}) {
    const api = stub({
      latest: () => jsonResponse(200, { attempt: null }),
      prepare: () => jsonResponse(200, { attempt: attemptFixture(), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: nowSeconds() }),
      submit,
      ...others,
    });
    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("To"), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-review")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    return api;
  }

  const MALFORMED: Array<[string, unknown]> = [
    ["an unknown state", { attempt: attemptFixture({ state: "teleported", failureReason: MARKER }) }],
    ["an empty attempt object", { attempt: {} }],
    ["a wrong-id 'submitted' attempt", { attempt: attemptFixture({ id: "payment-attempt-evil", state: "submitted", failureReason: MARKER }) }],
    ["a disallowed 'confirmed' state", { attempt: attemptFixture({ state: "confirmed", transactionHash: "0xabc123", failureReason: MARKER }) }],
    ["a disallowed 'cancelled' state", { attempt: attemptFixture({ state: "cancelled", failureReason: MARKER }) }],
    ["a disallowed 'awaiting_authorization' state", { attempt: attemptFixture({ state: "awaiting_authorization", failureReason: MARKER }) }],
    ["an object failureReason on a 'failed' attempt", { attempt: attemptFixture({ state: "failed", failureReason: { message: MARKER } }) }],
    ["a missing attempt", { note: MARKER }],
  ];

  it.each(MALFORMED)("%s: the existing checking screen renders — Check status offered, nothing sent, nothing false, nothing raw", async (_name, body) => {
    const api = await send(() => jsonResponse(200, body));

    await waitFor(() => expect(screen.getByTestId("real-pay-unknown")).toBeInTheDocument());
    expect(screen.getByText(UNKNOWN_HEADLINE)).toBeInTheDocument();
    expect(screen.getByText(NEUTRAL)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled();
    absentButtons(["Review", "Continue", "Cancel payment", "Approve", "Edit", "Try again", "Send another payment"]);
    for (const id of ["real-pay-sending", "real-pay-resume", "real-pay-stranded", "real-pay-form", "real-pay-review", "real-pay-failed", "real-pay-confirmed", "real-pay-status-unavailable"]) {
      expect(screen.queryByTestId(id), id).toBeNull();
    }
    expect(screen.queryByText("Sent")).toBeNull();
    expect(screen.queryByText("Sending…")).toBeNull();
    const text = document.body.textContent ?? "";
    expect(text.length).toBeGreaterThan(0); // not a blank section
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain("0xabc123");
    expect(text).not.toMatch(RAW_TEXT);
    // The mount read, one prepare, one submit of the one approval — nothing else, and nothing by itself.
    expect(api.keys()).toEqual(["latest", "prepare", "submit"]);
    expect(api.calls[2]!.body).toEqual(APPROVAL);
    expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
    expect(useRealPaymentStore.getState()).toMatchObject({ status: "unknown", error: NEUTRAL, pendingSubmission: APPROVAL, authorizingCredentialId: "credential-1", subOrganizationId: "sub-org-1" });
    expect(useRealPaymentStore.getState().attempt).toMatchObject({ id: "payment-attempt-1", state: "awaiting_authorization" });
  });

  it("Check status asks about the ORIGINAL payment id, never the one the malformed answer carried", async () => {
    const api = await send(() => jsonResponse(200, { attempt: attemptFixture({ id: "payment-attempt-evil", state: "submitted" }) }), { status: () => statusOf("submitted") });
    await waitFor(() => expect(screen.getByTestId("real-pay-unknown")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    await waitFor(() => expect(api.count("status")).toBe(1));

    const statusCall = api.calls.find((call) => call.key === "status")!;
    expect(statusCall.url).toContain("/payment-attempt-1/status");
    expect(api.calls.some((call) => call.url.includes("payment-attempt-evil"))).toBe(false);
    expect(api.count("submit")).toBe(1);
    expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
  });

  it("Check status 'still waiting' -> explicit Continue re-sends the SAME retained approval — no second passkey prompt", async () => {
    let submits = 0;
    const api = await send(
      () => {
        submits += 1;
        return submits === 1 ? jsonResponse(200, { attempt: attemptFixture({ state: "teleported" }) }) : jsonResponse(200, { attempt: attemptFixture({ state: "submitted" }) });
      },
      { status: () => statusOf("awaiting_authorization") },
    );
    await waitFor(() => expect(screen.getByTestId("real-pay-unknown")).toBeInTheDocument());
    absentButtons(["Continue"]); // not offered until the server says the payment is still waiting

    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());
    expect(api.count("submit")).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(api.count("submit")).toBe(2));

    expect(api.calls.filter((call) => call.key === "submit").map((call) => call.body)).toEqual([APPROVAL, APPROVAL]);
    expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
  });

  it("Check status can establish 'confirmed' through the existing status path after a rejected answer", async () => {
    const api = await send(() => jsonResponse(200, { attempt: attemptFixture({ state: "confirmed", transactionHash: "0xabc123" }) }), {
      status: () => jsonResponse(200, { attempt: attemptFixture({ state: "confirmed", transactionHash: "0xabc123" }), serverNowSeconds: nowSeconds(), reconciliationDeferred: false }),
      balance: () => jsonResponse(200, { token: "USDC", decimals: 6, balanceBaseUnits: "19000000" }),
    });
    await waitFor(() => expect(screen.getByTestId("real-pay-unknown")).toBeInTheDocument());
    expect(screen.queryByText("Sent")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Check status" }));

    await waitFor(() => expect(screen.getByTestId("real-pay-confirmed")).toBeInTheDocument());
    expect(screen.getByText("Sent")).toBeInTheDocument();
    expect(api.count("submit")).toBe(1);
  });

  it("an honest answer is unchanged: 'failed' with a reason shows the failed screen with that reason", async () => {
    await send(() => jsonResponse(200, { attempt: attemptFixture({ state: "failed", failureReason: "The payment could not be sent." }) }));
    await waitFor(() => expect(screen.getByTestId("real-pay-failed")).toBeInTheDocument());
    expect(screen.getByText("The payment could not be sent.")).toBeInTheDocument();
    expect(screen.queryByTestId("real-pay-unknown")).toBeNull();
  });

  it("an honest 'submitted' answer is unchanged: the sending screen, then the existing status check", async () => {
    const api = await send(() => jsonResponse(200, { attempt: attemptFixture({ state: "submitted" }) }), { status: () => statusOf("submitted") });
    await waitFor(() => expect(screen.getByTestId("real-pay-sending")).toBeInTheDocument());
    expect(screen.queryByTestId("real-pay-unknown")).toBeNull();
    expect(api.count("submit")).toBe(1);
  });
});

describe("RealPayForm — L-2 D-8: HTTP 401 / 404 recovery", () => {
  const SIGNED_OUT = "You're signed out, so we can't confirm this payment yet. Sign in again to check its status.";
  const NOT_ACCESSIBLE = "We can't check this payment with the current sign-in. It may still have gone through. Check that you're using the account that started it.";
  const NEUTRAL = "We couldn't confirm whether this payment was sent. Check its status before trying again.";
  const UNKNOWN_HEADLINE = "We're checking on this payment";
  const STILL_SIGNED_IN = "You're signed in. You can check this payment's status again.";
  const SESSION_CHECK_FAILED = "We couldn't check your sign-in just now. Try again in a moment.";
  const APPROVAL = { attemptId: "payment-attempt-1", signature: "0xsig-d8", activityId: "activity-d8" };
  const RAW_TEXT = /Not authenticated|Payment not found|Failed to fetch|Unexpected|not valid JSON|session-gone/;
  const NOT_SENT_CLAIM = /wasn't sent|was not sent|not sent|never sent|didn't go through|did not go through|no money moved|nothing was sent/i;
  const ACCOUNT_B = { appUserId: "app-user-2", ownerAddress: "0x4444444444444444444444444444444444444444", safeAddress: "0x5555555555555555555555555555555555555555" };
  const PAYMENT_KEYS = ["latest", "prepare", "submit", "status", "cancel", "balance"] as const;

  type Handler = (n: number) => Response | Promise<Response>;
  type Key = "latest" | "prepare" | "submit" | "status" | "balance" | "cancel" | "session" | "signout" | "loginOptions" | "loginVerify";

  beforeEach(() => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready", error: null, hasHydrated: true });
    useRealBalanceStore.setState({ balance: { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" }, status: "ready", error: null });
    useRealPaymentStore.getState().reset();
    useRealPaymentStore.setState({ status: "idle" });
    signPreparedPaymentMock.mockReset();
    signPreparedPaymentMock.mockResolvedValue({ signature: APPROVAL.signature, activityId: APPROVAL.activityId });
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    cleanup();
    useRealPaymentStore.getState().reset();
    useRealAccountStore.setState({ account: null, status: "idle", error: null });
    signPreparedPaymentMock.mockReset();
    vi.restoreAllMocks();
  });

  const sessionOf = (account: typeof ACCOUNT | typeof ACCOUNT_B) => jsonResponse(200, { authenticated: true, ...account });
  const signedOutSession = () => jsonResponse(200, { authenticated: false });

  function stub(handlers: Partial<Record<Key, Handler>>) {
    const calls: Array<{ key: Key | "other"; url: string; method: string; body: unknown }> = [];
    const counts = {} as Record<Key, number>;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        const key: Key | null = url.endsWith("/api/real/payments/latest")
          ? "latest"
          : url.endsWith("/api/real/payments/prepare")
            ? "prepare"
            : url.endsWith("/cancel")
              ? "cancel"
              : url.endsWith("/api/real/payments/submit")
                ? "submit"
                : url.endsWith("/status")
                  ? "status"
                  : url.endsWith("/api/real/account/balance")
                    ? "balance"
                    : url.endsWith("/api/real/session")
                      ? method === "DELETE"
                        ? "signout"
                        : "session"
                      : url.endsWith("/api/real/account/login/options")
                        ? "loginOptions"
                        : url.endsWith("/api/real/account/login/verify")
                          ? "loginVerify"
                          : null;
        calls.push({ key: key ?? "other", url, method, body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined });
        const handler = key ? handlers[key] : undefined;
        if (!key || !handler) throw new Error(`Unhandled fetch in test: ${method} ${url}`);
        counts[key] = (counts[key] ?? 0) + 1;
        return handler(counts[key]);
      }),
    );
    const count = (key: Key) => calls.filter((call) => call.key === key).length;
    return {
      calls,
      count,
      keys: () => calls.map((call) => call.key),
      /** Requests that concern payments or money — nothing of these may follow a session check. */
      paymentRequests: () => calls.filter((call) => (PAYMENT_KEYS as readonly string[]).includes(call.key)).length,
    };
  }

  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const unauthenticated = () => jsonResponse(401, { error: "Not authenticated." });
  const notFound = () => jsonResponse(404, { error: "Payment not found." });
  const absentButtons = (names: string[]) => {
    for (const name of names) expect(screen.queryByRole("button", { name }), name).toBeNull();
  };
  const NO_PAYMENT_ACTIONS = ["Review", "Continue", "Cancel payment", "Approve", "Edit", "Try again", "Send another payment", "Check payment status", "Check again"];

  /** The whole page, as Pay renders it: the form only while an account exists, and the account setup below it. */
  function renderPage() {
    return render(<RealPayView />);
  }

  /** The page after an Approve whose submit ended with `submit`, leaving the unknown screen with the full signing context. */
  async function afterSubmit(submit: Handler, others: Partial<Record<Key, Handler>> = {}) {
    const api = stub({
      session: () => sessionOf(ACCOUNT),
      latest: () => jsonResponse(200, { attempt: null }),
      prepare: () => jsonResponse(200, { attempt: attemptFixture(), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: nowSeconds() }),
      submit,
      ...others,
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("To"), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-review")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-unknown")).toBeInTheDocument());
    return api;
  }

  /** The page restored on an unknown payment (the server says it is still being sent), as after a reload. */
  async function restoredUnknown(others: Partial<Record<Key, Handler>>) {
    const api = stub({
      session: () => sessionOf(ACCOUNT),
      latest: () => jsonResponse(200, { attempt: attemptFixture({ state: "unknown", prepared: null }), serverNowSeconds: nowSeconds() }),
      ...others,
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("real-pay-unknown")).toBeInTheDocument());
    return api;
  }

  /** What every D-8 unknown screen must be: the unchanged checking screen, fixed copy only, no payment action but Check status. */
  function expectUnknownScreen(message: string, afterPress = false) {
    const unknown = screen.getByTestId("real-pay-unknown");
    expect(screen.getByText(UNKNOWN_HEADLINE)).toBeInTheDocument();
    expect(screen.getByText(message)).toBeInTheDocument();
    // Check status stays the page's own control; right after a press the existing cooldown (unchanged by D-8) shows instead.
    if (afterPress) expect(screen.getByRole("button", { name: "Checked just now" })).toBeDisabled();
    else expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled();
    absentButtons(NO_PAYMENT_ACTIONS);
    for (const id of ["real-pay-stranded", "real-pay-resume", "real-pay-form", "real-pay-review", "real-pay-failed", "real-pay-confirmed", "real-pay-sending", "real-pay-status-unavailable"]) {
      expect(screen.queryByTestId(id), id).toBeNull();
    }
    expect(unknown.textContent).not.toMatch(RAW_TEXT);
    expect(unknown.textContent).not.toMatch(NOT_SENT_CLAIM);
    expect(screen.queryByText("Sent")).toBeNull();
  }

  describe("the unknown screen", () => {
    it("submit HTTP 401: fixed signed-out copy, 'Sign in again' and Check status — nothing raw, nothing false, nothing sent twice", async () => {
      const api = await afterSubmit(unauthenticated);

      expectUnknownScreen(SIGNED_OUT);
      expect(screen.getByRole("button", { name: "Sign in again" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Check account" })).toBeNull();
      expect(api.calls.filter((call) => call.key !== "session").map((call) => call.key)).toEqual(["latest", "prepare", "submit"]);
      expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
      expect(useRealPaymentStore.getState()).toMatchObject({ status: "unknown", sessionRecovery: "signed_out", pendingSubmission: APPROVAL, authorizingCredentialId: "credential-1", subOrganizationId: "sub-org-1" });
      expect(useRealPaymentStore.getState().attempt).toMatchObject({ id: "payment-attempt-1", state: "awaiting_authorization" });
    });

    it("submit HTTP 404: fixed neutral copy, 'Check account' as the secondary action — no 'Sign in again', no claim that nothing was sent", async () => {
      const api = await afterSubmit(notFound);

      expectUnknownScreen(NOT_ACCESSIBLE);
      expect(screen.getByRole("button", { name: "Check account" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();
      expect(screen.getByText(/It may still have gone through\./)).toBeInTheDocument();
      expect(api.calls.filter((call) => call.key !== "session").map((call) => call.key)).toEqual(["latest", "prepare", "submit"]);
      expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
      expect(useRealPaymentStore.getState()).toMatchObject({ status: "unknown", sessionRecovery: "not_accessible", pendingSubmission: APPROVAL });
    });

    it("manual Check status 401: the same screen, signed-out copy and 'Sign in again'; the payment stays as it was", async () => {
      const api = await restoredUnknown({ status: unauthenticated });
      expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull(); // no marker before anything was refused
      expect(screen.queryByRole("button", { name: "Check account" })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Check status" }));
      await waitFor(() => expect(screen.getByText(SIGNED_OUT)).toBeInTheDocument());

      expectUnknownScreen(SIGNED_OUT, true);
      expect(screen.getByRole("button", { name: "Sign in again" })).toBeEnabled();
      expect(api.count("status")).toBe(1);
      expect(useRealPaymentStore.getState().attempt).toMatchObject({ id: "payment-attempt-1", state: "unknown" });
      expect(api.count("submit") + api.count("prepare") + api.count("cancel") + api.count("balance")).toBe(0);
      expect(signPreparedPaymentMock).not.toHaveBeenCalled();
    });

    it("manual Check status 404: neutral copy and 'Check account'; the payment is not shown as failed, cancelled or editable", async () => {
      const api = await restoredUnknown({ status: notFound });

      fireEvent.click(screen.getByRole("button", { name: "Check status" }));
      await waitFor(() => expect(screen.getByText(NOT_ACCESSIBLE)).toBeInTheDocument());

      expectUnknownScreen(NOT_ACCESSIBLE, true);
      expect(screen.getByRole("button", { name: "Check account" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();
      expect(useRealPaymentStore.getState()).toMatchObject({ status: "unknown", sessionRecovery: "not_accessible" });
      expect(api.count("status")).toBe(1);
    });

    it.each([
      ["HTTP 500", () => jsonResponse(500, { error: "Something went wrong." })],
      ["HTTP 403", () => jsonResponse(403, { error: "Forbidden." })],
      ["a network failure", () => Promise.reject(new TypeError("Failed to fetch"))],
    ] as Array<[string, Handler]>)("a status read that fails with %s offers neither session action", async (_name, status) => {
      await restoredUnknown({ status });

      fireEvent.click(screen.getByRole("button", { name: "Check status" }));
      await waitFor(() => expect(useRealPaymentStore.getState().error).not.toBeNull());

      expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Check account" })).toBeNull();
      expect(useRealPaymentStore.getState().sessionRecovery).toBeNull();
    });

    it("a submit that fails the generic way offers neither session action (the unknown screen is exactly what it was)", async () => {
      await afterSubmit(() => jsonResponse(500, { error: "Something went wrong." }));
      expectUnknownScreen(NEUTRAL);
      expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Check account" })).toBeNull();
    });

    it("on the sending screen the fixed copy replaces the raw text, and (L-2 D-9) the matching sign-in action is now offered there too", async () => {
      stub({
        session: () => sessionOf(ACCOUNT),
        latest: () => jsonResponse(200, { attempt: attemptFixture({ state: "submitted", prepared: null }), serverNowSeconds: nowSeconds() }),
        status: unauthenticated,
      });
      renderPage();
      await waitFor(() => expect(screen.getByTestId("real-pay-sending")).toBeInTheDocument());
      await waitFor(() => expect(screen.getByText(SIGNED_OUT)).toBeInTheDocument());

      expect(screen.getByTestId("real-pay-sending").textContent).not.toMatch(RAW_TEXT);
      expect(screen.getByText("Sending…")).toBeInTheDocument();
      // L-2 D-9 (supersedes the D-8 boundary "unknown screen only"): the Sending screen offers the same explicit session check.
      expect(screen.getByRole("button", { name: "Sign in again" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Check account" })).toBeNull();
      expect(useRealPaymentStore.getState().status).toBe("submitted");
    });
  });

  describe("'Sign in again' (401)", () => {
    it("is exactly one session check: no payment request, no signature, no sign-out — and with a still-valid session the screen stays, with a plain note", async () => {
      const api = await afterSubmit(unauthenticated);
      const sessionsBefore = api.count("session");
      const requestsBefore = api.calls.length;
      // Every payment action is replaced by a spy for the click, so a call the store would quietly ignore on this screen is still caught.
      const ACTIONS = ["resumeAuthorization", "confirmAndSend", "cancel", "checkStatus", "checkPreparedPayment", "checkPaymentsAgain", "review", "init", "reset"] as const;
      const originals = Object.fromEntries(ACTIONS.map((name) => [name, useRealPaymentStore.getState()[name]]));
      const spies = Object.fromEntries(ACTIONS.map((name) => [name, vi.fn()]));
      useRealPaymentStore.setState(spies as never);
      try {
        fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
        await waitFor(() => expect(screen.getByTestId("real-pay-session-note")).toBeInTheDocument());
        for (const name of ACTIONS) expect(spies[name], name).not.toHaveBeenCalled();
      } finally {
        useRealPaymentStore.setState(originals as never);
      }

      expect(api.count("session")).toBe(sessionsBefore + 1);
      expect(api.calls.slice(requestsBefore).map((call) => call.key)).toEqual(["session"]);
      expect(api.count("signout")).toBe(0);
      expect(api.count("submit")).toBe(1);
      expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("real-pay-session-note").textContent).toBe(STILL_SIGNED_IN);
      expectUnknownScreen(SIGNED_OUT);
      // Nothing is repeated by itself afterwards.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(api.calls.slice(requestsBefore).map((call) => call.key)).toEqual(["session"]);
      expect(useRealPaymentStore.getState()).toMatchObject({ status: "unknown", pendingSubmission: APPROVAL, sessionRecovery: "signed_out" });
    });

    it("pressing Check status afterwards drops the note, so it never contradicts a fresh 'signed out' answer", async () => {
      await afterSubmit(unauthenticated, { status: unauthenticated });
      fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
      await waitFor(() => expect(screen.getByTestId("real-pay-session-note")).toBeInTheDocument());

      fireEvent.click(screen.getByRole("button", { name: "Check status" }));

      await waitFor(() => expect(screen.queryByTestId("real-pay-session-note")).toBeNull());
      expect(screen.getByText(SIGNED_OUT)).toBeInTheDocument();
    });

    it("a repeated press while the check is running is ignored — one session request, a busy label", async () => {
      let release: (response: Response) => void = () => {};
      let sessionCalls = 0;
      const api = await afterSubmit(unauthenticated, {
        session: () => {
          sessionCalls += 1;
          return sessionCalls === 1 ? sessionOf(ACCOUNT) : new Promise<Response>((resolve) => (release = resolve));
        },
      });
      const sessionsBefore = api.count("session");

      const button = screen.getByRole("button", { name: "Sign in again" });
      // All three presses land before the page can re-render (one batch), so only the handler's own guard stands between them and three requests.
      act(() => {
        fireEvent.click(button);
        fireEvent.click(button);
        fireEvent.click(button);
      });
      await waitFor(() => expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled());

      expect(api.count("session")).toBe(sessionsBefore + 1);
      release(sessionOf(ACCOUNT));
      await waitFor(() => expect(screen.getByTestId("real-pay-session-note")).toBeInTheDocument());
      expect(api.count("session")).toBe(sessionsBefore + 1);
    });

    it("a session check that fails (HTTP 500) leaves the screen and the account as they were, with a plain note", async () => {
      let sessionCalls = 0;
      const api = await afterSubmit(unauthenticated, { session: () => (++sessionCalls === 1 ? sessionOf(ACCOUNT) : jsonResponse(500, { error: "Something went wrong." })) });

      fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
      await waitFor(() => expect(screen.getByTestId("real-pay-session-note")).toBeInTheDocument());

      expect(screen.getByTestId("real-pay-session-note").textContent).toBe(SESSION_CHECK_FAILED);
      expect(useRealAccountStore.getState().account).toMatchObject({ appUserId: ACCOUNT.appUserId });
      expectUnknownScreen(SIGNED_OUT);
      expect(api.count("signout")).toBe(0);
    });

    it("unmounting while the check is in flight is safe: nothing is thrown, logged or requested afterwards", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      let release: (response: Response) => void = () => {};
      let sessionCalls = 0;
      const api = await afterSubmit(unauthenticated, { session: () => (++sessionCalls === 1 ? sessionOf(ACCOUNT) : new Promise<Response>((resolve) => (release = resolve))) });
      const requestsBefore = api.calls.length;

      fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
      await waitFor(() => expect(api.calls.length).toBe(requestsBefore + 1));
      cleanup();
      release(sessionOf(ACCOUNT));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(api.calls.slice(requestsBefore).map((call) => call.key)).toEqual(["session"]);
      expect(errors).not.toHaveBeenCalled();
      expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
    });

    describe("when the session is gone (authenticated: false)", () => {
      /** The server no longer knows this browser; a later sign-in is answered by `signInAs`. */
      async function signedOutPage(signInAs: typeof ACCOUNT | typeof ACCOUNT_B, latestAfter: Handler) {
        let signedOut = false;
        const api = await afterSubmit(unauthenticated, {
          session: () => (signedOut ? signedOutSession() : sessionOf(ACCOUNT)),
          latest: (n) => (n === 1 ? jsonResponse(200, { attempt: null }) : latestAfter(n)),
          loginOptions: () => jsonResponse(200, { optionsJSON: { rpId: "localhost", challenge: "c" } }),
          loginVerify: () => jsonResponse(200, signInAs),
        });
        signedOut = true;
        return api;
      }

      it("the existing login appears and the Pay form unmounts — and the click itself sent nothing about the payment", async () => {
        const api = await signedOutPage(ACCOUNT, () => jsonResponse(200, { attempt: null }));
        const requestsBefore = api.calls.length;

        fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
        await waitFor(() => expect(screen.getByTestId("real-account-setup")).toBeInTheDocument());

        expect(screen.getByRole("button", { name: "I already have an account" })).toBeEnabled();
        for (const id of ["real-pay-unknown", "real-pay-form", "real-pay-review", "real-pay-resume", "real-pay-stranded"]) expect(screen.queryByTestId(id), id).toBeNull();
        expect(api.calls.slice(requestsBefore).map((call) => call.key)).toEqual(["session"]);
        expect(api.count("signout")).toBe(0);
        expect(api.count("submit")).toBe(1);
        expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
        // The form's own cleanup ran: no sign-in prompt is left behind in the payment store.
        expect(useRealPaymentStore.getState().sessionRecovery).toBeNull();
      });

      it("signing in as the SAME account: the form re-reads /latest, restores the payment from the server, and sends or signs nothing by itself", async () => {
        const api = await signedOutPage(ACCOUNT, () => jsonResponse(200, { attempt: attemptFixture({ state: "unknown", prepared: null }), serverNowSeconds: nowSeconds() }));
        fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
        await waitFor(() => expect(screen.getByTestId("real-account-setup")).toBeInTheDocument());
        const latestBefore = api.count("latest");

        fireEvent.click(screen.getByRole("button", { name: "I already have an account" }));
        await waitFor(() => expect(screen.getByTestId("real-pay-unknown")).toBeInTheDocument());

        expect(api.count("latest")).toBe(latestBefore + 1);
        expect(screen.getByText(UNKNOWN_HEADLINE)).toBeInTheDocument();
        expect(screen.queryByText(SIGNED_OUT)).toBeNull();
        expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();
        expect(useRealPaymentStore.getState()).toMatchObject({ status: "unknown", sessionRecovery: null, pendingSubmission: null, error: null });
        expect(useRealPaymentStore.getState().attempt).toMatchObject({ id: "payment-attempt-1", state: "unknown" });
        expect(api.count("submit")).toBe(1);
        expect(api.count("prepare")).toBe(1);
        expect(api.count("cancel")).toBe(0);
        expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
      });

      it("a payment the server still shows as waiting after sign-in asks for a NEW approval — the old one is not reused", async () => {
        const api = await signedOutPage(ACCOUNT, () => jsonResponse(200, { attempt: attemptFixture(), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: nowSeconds() }));
        fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
        await waitFor(() => expect(screen.getByTestId("real-account-setup")).toBeInTheDocument());
        fireEvent.click(screen.getByRole("button", { name: "I already have an account" }));
        await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());
        expect(useRealPaymentStore.getState().pendingSubmission).toBeNull();
        expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
        expect(api.count("submit")).toBe(1);

        signPreparedPaymentMock.mockResolvedValueOnce({ signature: "0xsig-new", activityId: "activity-new" });
        const submitsBefore = api.count("submit");
        fireEvent.click(screen.getByRole("button", { name: "Continue" }));
        await waitFor(() => expect(signPreparedPaymentMock).toHaveBeenCalledTimes(2));
        // The explicit Continue asked for a fresh passkey approval and sent THAT one — never the in-memory one from before the sign-out.
        await waitFor(() => expect(api.count("submit")).toBe(submitsBefore + 1));
        expect(api.calls.filter((call) => call.key === "submit").at(-1)!.body).toEqual({ attemptId: "payment-attempt-1", signature: "0xsig-new", activityId: "activity-new" });
      });

      it("signing in as a DIFFERENT account: the old payment, approval and wording do not appear, and only that account's own /latest is read", async () => {
        const api = await signedOutPage(ACCOUNT_B, () => jsonResponse(200, { attempt: null }));
        fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
        await waitFor(() => expect(screen.getByTestId("real-account-setup")).toBeInTheDocument());
        const before = api.calls.length;

        fireEvent.click(screen.getByRole("button", { name: "I already have an account" }));
        await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());

        expect(useRealAccountStore.getState().account).toMatchObject({ appUserId: ACCOUNT_B.appUserId });
        expect(screen.queryByTestId("real-pay-unknown")).toBeNull();
        expect(screen.queryByText(SIGNED_OUT)).toBeNull();
        expect(useRealPaymentStore.getState()).toMatchObject({ status: "editing", attempt: null, pendingSubmission: null, authorizingCredentialId: null, subOrganizationId: null, sessionRecovery: null, error: null });
        const after = api.calls.slice(before).filter((call) => (PAYMENT_KEYS as readonly string[]).includes(call.key));
        expect(after.map((call) => call.key)).toEqual(["latest"]);
        expect(api.calls.slice(before).some((call) => call.url.includes("payment-attempt-1"))).toBe(false);
        expect(api.count("submit")).toBe(1);
        expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe("'Check account' (404) — it only checks the session", () => {
    it("with the same account still signed in: one session request, a plain note, nothing else — and no promise of switching accounts", async () => {
      const api = await afterSubmit(notFound);
      const requestsBefore = api.calls.length;

      fireEvent.click(screen.getByRole("button", { name: "Check account" }));
      await waitFor(() => expect(screen.getByTestId("real-pay-session-note")).toBeInTheDocument());

      expect(api.calls.slice(requestsBefore).map((call) => call.key)).toEqual(["session"]);
      expect(screen.getByTestId("real-pay-session-note").textContent).toBe(STILL_SIGNED_IN);
      expectUnknownScreen(NOT_ACCESSIBLE);
      expect(screen.getByRole("button", { name: "Check account" })).toBeEnabled();
      expect(api.count("signout")).toBe(0);
      expect(api.count("loginOptions")).toBe(0);
      expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
      expect(useRealAccountStore.getState().account).toMatchObject({ appUserId: ACCOUNT.appUserId });
    });

    it("when the browser's real session belongs to ANOTHER account: the page follows that session — it shows that account, never the old payment, and never claims to restore the first one", async () => {
      let sessionCalls = 0;
      const api = await afterSubmit(notFound, {
        session: () => (++sessionCalls === 1 ? sessionOf(ACCOUNT) : sessionOf(ACCOUNT_B)),
        latest: () => jsonResponse(200, { attempt: null }),
      });
      const before = api.calls.length;

      fireEvent.click(screen.getByRole("button", { name: "Check account" }));
      await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());

      expect(useRealAccountStore.getState().account).toMatchObject({ appUserId: ACCOUNT_B.appUserId, safeAddress: ACCOUNT_B.safeAddress });
      expect(screen.queryByTestId("real-pay-unknown")).toBeNull();
      expect(screen.queryByText(NOT_ACCESSIBLE)).toBeNull();
      expect(screen.queryByRole("button", { name: "Check account" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();
      expect(useRealPaymentStore.getState()).toMatchObject({ status: "editing", attempt: null, pendingSubmission: null, authorizingCredentialId: null, subOrganizationId: null, sessionRecovery: null, error: null });
      // The session check, then the new account's own /latest — nothing about the old payment, no sign-out, no new sign-in.
      expect(api.calls.slice(before).map((call) => call.key)).toEqual(["session", "latest"]);
      expect(api.calls.slice(before).some((call) => call.url.includes("payment-attempt-1"))).toBe(false);
      expect(api.count("signout")).toBe(0);
      expect(api.count("loginOptions")).toBe(0);
      expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
    });

    it("with the session gone: the existing login appears, exactly as for 'Sign in again'", async () => {
      let sessionCalls = 0;
      await afterSubmit(notFound, { session: () => (++sessionCalls === 1 ? sessionOf(ACCOUNT) : signedOutSession()) });

      fireEvent.click(screen.getByRole("button", { name: "Check account" }));

      await waitFor(() => expect(screen.getByTestId("real-account-setup")).toBeInTheDocument());
      expect(screen.queryByTestId("real-pay-unknown")).toBeNull();
    });
  });
});

describe("RealPayForm — L-2 D-9: Pay session recovery completion", () => {
  const SIGNED_OUT = "You're signed out, so we can't confirm this payment yet. Sign in again to check its status.";
  const NOT_ACCESSIBLE = "We can't check this payment with the current sign-in. It may still have gone through. Check that you're using the account that started it.";
  const STILL_SIGNED_IN = "You're signed in. You can check this payment's status again.";
  const SIGNED_IN_ONLY = "You're signed in.";
  const SESSION_CHECK_FAILED = "We couldn't check your sign-in just now. Try again in a moment.";
  const RAW_TEXT = /Not authenticated|Payment not found|Failed to fetch|Unexpected|not valid JSON|session-gone/;
  const FALSE_CLAIMS = /wasn't sent|was not sent|not sent|never sent|didn't go through|did not go through|no money moved|nothing was sent|has been sent|was sent|switched|signed in as/i;
  const ACCOUNT_B = { appUserId: "app-user-2", ownerAddress: "0x4444444444444444444444444444444444444444", safeAddress: "0x5555555555555555555555555555555555555555" };
  const CONTEXT = { subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1" };
  const ACTIONS = ["resumeAuthorization", "confirmAndSend", "cancel", "checkStatus", "checkPreparedPayment", "checkPaymentsAgain", "review", "init", "reset"] as const;

  type Handler = (n: number) => Response | Promise<Response>;
  type Key = "latest" | "prepare" | "submit" | "status" | "balance" | "cancel" | "session";
  type Reason = { code: 401 | 404; marker: "signed_out" | "not_accessible"; message: string; label: "Sign in again" | "Check account"; other: "Sign in again" | "Check account"; respond: Handler };
  const REASONS: Reason[] = [
    { code: 401, marker: "signed_out", message: SIGNED_OUT, label: "Sign in again", other: "Check account", respond: () => jsonResponse(401, { error: "Not authenticated." }) },
    { code: 404, marker: "not_accessible", message: NOT_ACCESSIBLE, label: "Check account", other: "Sign in again", respond: () => jsonResponse(404, { error: "Payment not found." }) },
  ];

  beforeEach(() => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready", error: null, hasHydrated: true });
    useRealBalanceStore.setState({ balance: { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" }, status: "ready", error: null });
    useRealPaymentStore.getState().reset();
    useRealPaymentStore.setState({ status: "idle" });
    signPreparedPaymentMock.mockReset();
    signPreparedPaymentMock.mockResolvedValue({ signature: "0xsig-d9", activityId: "activity-d9" });
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    cleanup();
    useRealPaymentStore.getState().reset();
    useRealAccountStore.setState({ account: null, status: "idle", error: null });
    signPreparedPaymentMock.mockReset();
    vi.restoreAllMocks();
  });

  const sessionOf = (account: typeof ACCOUNT | typeof ACCOUNT_B) => jsonResponse(200, { authenticated: true, ...account });
  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const openWindow = () => ({ ...PREPARED_FIELDS, validUntil: nowSeconds() + 3_600 });
  const latestJson = (attempt: unknown) => jsonResponse(200, { attempt, ...CONTEXT, serverNowSeconds: nowSeconds() });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => (resolve = res));
    return { promise, resolve };
  }

  function stub(handlers: Partial<Record<Key, Handler>>) {
    const calls: Array<{ key: Key | "other"; url: string; method: string }> = [];
    const counts = {} as Record<Key, number>;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        const key: Key | null = url.endsWith("/api/real/payments/latest")
          ? "latest"
          : url.endsWith("/api/real/payments/prepare")
            ? "prepare"
            : url.endsWith("/cancel")
              ? "cancel"
              : url.endsWith("/api/real/payments/submit")
                ? "submit"
                : url.endsWith("/status")
                  ? "status"
                  : url.endsWith("/api/real/account/balance")
                    ? "balance"
                    : url.endsWith("/api/real/session")
                      ? "session"
                      : null;
        calls.push({ key: key ?? "other", url, method });
        const handler = key ? handlers[key] : undefined;
        if (!key || !handler) throw new Error(`Unhandled fetch in test: ${method} ${url}`);
        counts[key] = (counts[key] ?? 0) + 1;
        return handler(counts[key]);
      }),
    );
    const count = (key: Key) => calls.filter((call) => call.key === key).length;
    return { calls, count, keysSince: (from: number) => calls.slice(from).map((call) => call.key) };
  }

  const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 15))));
  const button = (name: string) => screen.getByRole("button", { name });
  const noButton = (name: string) => expect(screen.queryByRole("button", { name }), name).toBeNull();
  const noNote = () => {
    expect(screen.queryByTestId("real-pay-session-note")).toBeNull();
    expect(screen.queryByText(/You're signed in/)).toBeNull();
  };
  const follows = (first: Element, second: Element) => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
  const markerState = (reason: Reason) => useRealPaymentStore.setState({ sessionRecovery: reason.marker, error: reason.message });

  /** The unknown screen, restored from the server, with the fixed 401 / 404 wording already on it (the marker set as the store sets it). */
  async function unknownWithMarker(reason: Reason, handlers: Partial<Record<Key, Handler>>, latest?: Handler) {
    const api = stub({ latest: latest ?? (() => latestJson(attemptFixture({ state: "unknown", prepared: null }))), ...handlers });
    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-unknown")).toBeInTheDocument());
    act(() => markerState(reason));
    expect(screen.getByText(reason.message)).toBeInTheDocument();
    return api;
  }

  describe("the three screens now offer the matching session action", () => {
    type Variant = { name: string; screen: "sending" | "awaiting" | "stranded"; testId: string; checkStatus: boolean; real: boolean };
    const VARIANTS: Variant[] = [
      { name: "Sending (submitted), automatic status read", screen: "sending", testId: "real-pay-sending", checkStatus: true, real: true },
      { name: "Awaiting authorization, no Check status button yet", screen: "awaiting", testId: "real-pay-resume", checkStatus: false, real: false },
      { name: "Awaiting authorization, Check status shown", screen: "awaiting", testId: "real-pay-resume", checkStatus: true, real: true },
      { name: "Stranded, no Check status button yet", screen: "stranded", testId: "real-pay-stranded", checkStatus: false, real: false },
      { name: "Stranded, Check status shown", screen: "stranded", testId: "real-pay-stranded", checkStatus: true, real: true },
    ];

    function latestFor(screen: Variant["screen"]) {
      if (screen === "sending") return () => latestJson(attemptFixture({ state: "submitted", prepared: null }));
      if (screen === "awaiting") return () => latestJson(attemptFixture({ prepared: openWindow() }));
      return () => latestJson(attemptFixture({ state: "signed", prepared: openWindow() }));
    }

    /** Arrives at the screen with the fixed wording: by a real 401 / 404 status read where Check status exists, by the marker alone where it does not. */
    async function arrive(variant: Variant, reason: Reason, extra: Partial<Record<Key, Handler>> = {}) {
      const api = stub({ latest: latestFor(variant.screen), status: reason.respond, session: () => sessionOf(ACCOUNT), ...extra });
      render(<RealPayForm />);
      await waitFor(() => expect(screen.getByTestId(variant.testId)).toBeInTheDocument());
      if (variant.screen === "sending") {
        await waitFor(() => expect(screen.getByText(reason.message)).toBeInTheDocument());
      } else if (variant.checkStatus) {
        act(() => useRealPaymentStore.setState({ isFollowUpExhausted: true }));
        fireEvent.click(button("Check status"));
        await waitFor(() => expect(screen.getByText(reason.message)).toBeInTheDocument());
      } else {
        act(() => markerState(reason));
      }
      return api;
    }

    describe.each(VARIANTS)("$name", (variant) => {
      it.each(REASONS)("HTTP $code: fixed wording, the matching control, exactly one session check per press and nothing else", async (reason) => {
        const api = await arrive(variant, reason);
        const before = useRealPaymentStore.getState();
        const requestsBefore = api.calls.length;
        const statusReadsBefore = api.count("status");

        // The screen, its wording and the buttons that were there before.
        const root = screen.getByTestId(variant.testId);
        expect(root.textContent).not.toMatch(RAW_TEXT);
        expect(root.textContent).not.toMatch(FALSE_CLAIMS);
        expect(screen.getByRole("button", { name: reason.label })).toBeEnabled();
        noButton(reason.other);
        const checkStatusLabel = variant.checkStatus ? /^(Checked just now|Check status)$/ : null;
        if (checkStatusLabel) expect(screen.getByRole("button", { name: checkStatusLabel })).toBeInTheDocument();
        else expect(screen.queryByRole("button", { name: /Check status|Checked just now|Check available later/ })).toBeNull();
        if (variant.screen === "awaiting") {
          expect(button("Continue")).toBeEnabled();
          expect(button("Cancel payment")).toBeEnabled();
        } else if (variant.screen === "stranded") {
          noButton("Continue");
          expect(button("Cancel payment")).toBeEnabled();
        } else {
          noButton("Continue");
          noButton("Cancel payment");
        }
        // Placement: under the error, above the screen's own controls.
        const control = button(reason.label);
        expect(follows(screen.getByText(reason.message), control)).toBe(true);
        for (const own of ["Continue", "Cancel payment", "Check status", "Checked just now"]) {
          const other = screen.queryByRole("button", { name: own });
          if (other) expect(follows(control, other), own).toBe(true);
        }
        if (variant.screen === "sending") expect(control.className).toContain("h-7");
        else expect(control.className).toContain("w-full");

        // Every payment action is replaced by a spy for the press, so a call the store would quietly ignore here is still caught.
        const originals = Object.fromEntries(ACTIONS.map((name) => [name, useRealPaymentStore.getState()[name]]));
        const spies = Object.fromEntries(ACTIONS.map((name) => [name, vi.fn()]));
        useRealPaymentStore.setState(spies as never);
        try {
          fireEvent.click(control);
          await waitFor(() => expect(screen.getByTestId("real-pay-session-note")).toBeInTheDocument());
          for (const name of ACTIONS) expect(spies[name], name).not.toHaveBeenCalled();
        } finally {
          useRealPaymentStore.setState(originals as never);
        }

        // One session GET; no payment request, status read, signing, submit, Cancel, prepare, init or sign-out.
        expect(api.keysSince(requestsBefore)).toEqual(["session"]);
        expect(api.count("status")).toBe(statusReadsBefore);
        expect(signPreparedPaymentMock).not.toHaveBeenCalled();
        // The note says only what the session check found, and only as much as this screen can follow up on.
        expect(screen.getByTestId("real-pay-session-note").textContent).toBe(variant.checkStatus ? STILL_SIGNED_IN : SIGNED_IN_ONLY);
        expect(screen.getByTestId(variant.testId).textContent).not.toMatch(FALSE_CLAIMS);
        expect(screen.getByText(reason.message)).toBeInTheDocument();
        // The payment is exactly where it was.
        const after = useRealPaymentStore.getState();
        expect(after.status).toBe(before.status);
        expect(after.attempt).toBe(before.attempt);
        expect(after.sessionRecovery).toBe(reason.marker);
        expect(after.isFollowUpExhausted).toBe(before.isFollowUpExhausted);
        expect(screen.getByRole("button", { name: reason.label })).toBeEnabled();
        // Nothing follows by itself.
        await settle();
        expect(api.keysSince(requestsBefore)).toEqual(["session"]);
      });
    });
  });

  describe("no recovery control without a reason to show one", () => {
    it.each(["sending", "awaiting", "stranded", "unknown"] as const)("%s screen: no marker, no action", async (screenName) => {
      const attempt = {
        sending: attemptFixture({ state: "submitted", prepared: null }),
        awaiting: attemptFixture({ prepared: openWindow() }),
        stranded: attemptFixture({ state: "signed", prepared: openWindow() }),
        unknown: attemptFixture({ state: "unknown", prepared: null }),
      }[screenName];
      stub({ latest: () => latestJson(attempt), status: () => jsonResponse(500, { error: "Something went wrong." }) });
      render(<RealPayForm />);
      await waitFor(() => expect(screen.getByTestId({ sending: "real-pay-sending", awaiting: "real-pay-resume", stranded: "real-pay-stranded", unknown: "real-pay-unknown" }[screenName])).toBeInTheDocument());
      await settle();
      noButton("Sign in again");
      noButton("Check account");
      expect(screen.queryByTestId("real-pay-session-note")).toBeNull();
    });

    it("a failed status read that is neither 401 nor 404 leaves a screen without the action", async () => {
      stub({ latest: () => latestJson(attemptFixture({ state: "submitted", prepared: null })), status: () => jsonResponse(500, { error: "Something went wrong." }) });
      render(<RealPayForm />);
      await waitFor(() => expect(useRealPaymentStore.getState().error).not.toBeNull());
      noButton("Sign in again");
      noButton("Check account");
    });

    // The marker may outlive some branches (accepted residual); the control is shown only where a payment is actually waiting on a sign-in.
    it.each([
      ["Confirmed", { status: "confirmed", attempt: attemptFixture({ state: "confirmed", prepared: null, transactionHash: "0xabc" }) }, "real-pay-confirmed"],
      ["Failed", { status: "failed", attempt: attemptFixture({ state: "failed", prepared: null, failureReason: "This payment could not be sent." }) }, "real-pay-failed"],
      ["Editing", { status: "editing", attempt: null }, "real-pay-form"],
      ["Reviewing", { status: "reviewing", attempt: null, recipientInput: RECIPIENT, amountInput: "1.00" }, "real-pay-review"],
      ["Preparing", { status: "preparing", attempt: null }, "real-pay-preparing"],
      ["Passkey prompt", { status: "awaiting_authorization", attempt: attemptFixture({ prepared: openWindow() }), isAuthorizing: true }, "real-pay-authorizing"],
      ["Status unavailable", { status: "status_unavailable", attempt: null }, "real-pay-status-unavailable"],
    ] as Array<[string, Record<string, unknown>, string]>)("%s: no control and no note, even with a marker in memory", async (_name, state, testId) => {
      stub({ latest: () => jsonResponse(200, { attempt: null }) });
      render(<RealPayForm />);
      await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
      act(() => useRealPaymentStore.setState({ ...state, sessionRecovery: "signed_out", error: SIGNED_OUT } as never));
      await waitFor(() => expect(screen.getByTestId(testId)).toBeInTheDocument());
      noButton("Sign in again");
      noButton("Check account");
      expect(screen.queryByTestId("real-pay-session-note")).toBeNull();
    });
  });

  describe("the unknown screen keeps its D-8 layout", () => {
    it("'Sign in again' above Check status; 'Check account' below it", async () => {
      await unknownWithMarker(REASONS[0], {});
      expect(follows(button("Sign in again"), button("Check status"))).toBe(true);
      cleanup();
      useRealPaymentStore.getState().reset();
      await unknownWithMarker(REASONS[1], {});
      expect(follows(button("Check status"), button("Check account"))).toBe(true);
      noButton("Sign in again");
    });
  });

  describe("every Check status button drops the older note, and calls the store action exactly once", () => {
    const SCREENS = [
      ["unknown", "real-pay-unknown", () => attemptFixture({ state: "unknown", prepared: null }), {}],
      ["sending", "real-pay-sending", () => attemptFixture({ state: "submitted", prepared: null }), {}],
      ["awaiting", "real-pay-resume", () => attemptFixture({ prepared: openWindow() }), { isFollowUpExhausted: true }],
      ["stranded", "real-pay-stranded", () => attemptFixture({ state: "signed", prepared: openWindow() }), { isFollowUpExhausted: true }],
    ] as const;
    it.each(SCREENS)("%s screen", async (_name, testId, attempt, extra) => {
      const api = stub({ latest: () => latestJson(attempt()), status: () => jsonResponse(500, { error: "Something went wrong." }), session: () => sessionOf(ACCOUNT) });
      render(<RealPayForm />);
      await waitFor(() => expect(screen.getByTestId(testId)).toBeInTheDocument());
      await settle();
      act(() => useRealPaymentStore.setState({ ...extra, ...markerPatch(REASONS[0]) } as never));
      fireEvent.click(button("Sign in again"));
      await waitFor(() => expect(screen.getByTestId("real-pay-session-note")).toBeInTheDocument());

      const original = useRealPaymentStore.getState().checkStatus;
      const checkStatus = vi.fn(async () => {});
      act(() => useRealPaymentStore.setState({ checkStatus } as never));
      try {
        fireEvent.click(screen.getByRole("button", { name: "Check status" }));
        await waitFor(() => expect(screen.queryByTestId("real-pay-session-note")).toBeNull());
        expect(checkStatus).toHaveBeenCalledTimes(1);
      } finally {
        // The store outlives the test: put the real action back.
        useRealPaymentStore.setState({ checkStatus: original });
      }
      noNote();
      expect(api.count("session")).toBe(1);
    });
    function markerPatch(reason: Reason) {
      return { sessionRecovery: reason.marker, error: reason.message };
    }
  });

  describe("the note cannot outlive the status or the attempt it was written for", () => {
    it("a note shown on 'unknown' does not come back after the status leaves and returns", async () => {
      await unknownWithMarker(REASONS[0], { session: () => sessionOf(ACCOUNT) });
      fireEvent.click(button("Sign in again"));
      await waitFor(() => expect(screen.getByTestId("real-pay-session-note")).toBeInTheDocument());

      act(() => useRealPaymentStore.setState({ status: "stranded" }));
      noNote();
      act(() => useRealPaymentStore.setState({ status: "unknown" }));

      noNote();
      expect(screen.getByText(SIGNED_OUT)).toBeInTheDocument();
    });

    it("a note written for one attempt is not shown for another, nor when the first attempt returns", async () => {
      await unknownWithMarker(REASONS[0], { session: () => sessionOf(ACCOUNT) });
      fireEvent.click(button("Sign in again"));
      await waitFor(() => expect(screen.getByTestId("real-pay-session-note")).toBeInTheDocument());
      const first = useRealPaymentStore.getState().attempt!;

      act(() => useRealPaymentStore.setState({ attempt: { ...first, id: "payment-attempt-2" } }));
      noNote();
      act(() => useRealPaymentStore.setState({ attempt: first }));
      noNote();
    });

    it("the payment's status changing while the session check runs: no note, now or when the status comes back", async () => {
      const gate = deferred<Response>();
      await unknownWithMarker(REASONS[0], { session: () => gate.promise });
      fireEvent.click(button("Sign in again"));
      await waitFor(() => expect(button("Checking…")).toBeDisabled());

      act(() => useRealPaymentStore.setState({ status: "stranded" }));
      await act(async () => gate.resolve(sessionOf(ACCOUNT)));
      noNote();
      act(() => useRealPaymentStore.setState({ status: "unknown" }));
      await settle();

      noNote();
      expect(screen.getByRole("button", { name: "Sign in again" })).toBeEnabled();
    });

    it("the attempt changing while the session check runs: no note", async () => {
      const gate = deferred<Response>();
      await unknownWithMarker(REASONS[0], { session: () => gate.promise });
      fireEvent.click(button("Sign in again"));
      await waitFor(() => expect(button("Checking…")).toBeDisabled());
      const first = useRealPaymentStore.getState().attempt!;

      act(() => useRealPaymentStore.setState({ attempt: { ...first, id: "payment-attempt-2" } }));
      act(() => useRealPaymentStore.setState({ attempt: first }));
      await act(async () => gate.resolve(sessionOf(ACCOUNT)));
      await settle();

      noNote();
    });

    it("a reset while the session check runs: the editing form, no note", async () => {
      const gate = deferred<Response>();
      const api = await unknownWithMarker(REASONS[0], { session: () => gate.promise });
      fireEvent.click(button("Sign in again"));
      await waitFor(() => expect(button("Checking…")).toBeDisabled());
      const requestsBefore = api.calls.length;

      act(() => useRealPaymentStore.getState().reset());
      await act(async () => gate.resolve(sessionOf(ACCOUNT)));
      await settle();

      expect(screen.getByTestId("real-pay-form")).toBeInTheDocument();
      noNote();
      noButton("Sign in again");
      expect(api.keysSince(requestsBefore)).toEqual([]);
    });

    it("the marker clearing while the session check runs: no note", async () => {
      const gate = deferred<Response>();
      await unknownWithMarker(REASONS[0], { session: () => gate.promise });
      fireEvent.click(button("Sign in again"));
      await waitFor(() => expect(button("Checking…")).toBeDisabled());

      act(() => useRealPaymentStore.setState({ sessionRecovery: null, error: null }));
      await act(async () => gate.resolve(sessionOf(ACCOUNT)));
      act(() => useRealPaymentStore.setState({ sessionRecovery: "signed_out", error: SIGNED_OUT }));

      noNote();
    });
  });

  describe("races between the session check and Check status", () => {
    it.each(REASONS)("HTTP $code: the session check starts first, Check status answers again, then the session returns — no contradicting note", async (reason) => {
      const session = deferred<Response>();
      const api = await unknownWithMarker(reason, { session: () => session.promise, status: reason.respond });
      fireEvent.click(button(reason.label));
      await waitFor(() => expect(button("Checking…")).toBeDisabled());

      fireEvent.click(button("Check status"));
      await waitFor(() => expect(api.count("status")).toBe(1));
      await settle();
      await act(async () => session.resolve(sessionOf(ACCOUNT)));
      await waitFor(() => expect(button(reason.label)).toBeEnabled());
      await settle();

      noNote();
      expect(screen.getByText(reason.message)).toBeInTheDocument();
      expect(api.count("session")).toBe(1);
      expect(api.count("status")).toBe(1);
    });

    it.each(REASONS)("HTTP $code: Check status starts first and answers late; the note shown meanwhile is gone when the answer arrives", async (reason) => {
      const status = deferred<Response>();
      const api = await unknownWithMarker(reason, { session: () => sessionOf(ACCOUNT), status: () => status.promise });
      fireEvent.click(button("Check status"));
      await waitFor(() => expect(api.count("status")).toBe(1));
      fireEvent.click(button(reason.label));
      await waitFor(() => expect(screen.getByTestId("real-pay-session-note")).toBeInTheDocument());

      await act(async () => status.resolve(reason.respond(1) as Response));
      await settle();

      noNote();
      expect(screen.getByText(reason.message)).toBeInTheDocument();
    });

    it("Check status answers late with a different status: the old note does not follow it", async () => {
      const status = deferred<Response>();
      const api = await unknownWithMarker(REASONS[0], { session: () => sessionOf(ACCOUNT), status: () => status.promise }, () => latestJson(attemptFixture({ state: "unknown", prepared: openWindow() })));
      fireEvent.click(button("Check status"));
      await waitFor(() => expect(api.count("status")).toBe(1));
      fireEvent.click(button("Sign in again"));
      await waitFor(() => expect(screen.getByTestId("real-pay-session-note")).toBeInTheDocument());

      await act(async () => status.resolve(latestJson(attemptFixture({ prepared: openWindow() }))));
      await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());

      noNote();
    });

    it.each(REASONS)("HTTP $code: the session check pending, Check status shows 'awaiting', the session returns, Continue is pressed and the submit is refused — the old note does not come back", async (reason) => {
      const session = deferred<Response>();
      const api = await unknownWithMarker(
        reason,
        {
          session: () => session.promise,
          status: () => latestJson(attemptFixture({ prepared: openWindow() })),
          submit: reason.respond,
        },
        () => latestJson(attemptFixture({ state: "unknown", prepared: openWindow() })),
      );
      fireEvent.click(button(reason.label));
      await waitFor(() => expect(button("Checking…")).toBeDisabled());
      fireEvent.click(button("Check status"));
      await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());
      await act(async () => session.resolve(sessionOf(ACCOUNT)));
      await settle();
      noNote();
      const readsBefore = api.count("status");

      fireEvent.click(button("Continue"));
      await waitFor(() => expect(screen.getByTestId("real-pay-unknown")).toBeInTheDocument());
      await settle();

      expect(screen.getByText(reason.message)).toBeInTheDocument();
      noNote();
      expect(api.count("submit")).toBe(1);
      expect(api.count("status")).toBe(readsBefore);
      expect(api.count("session")).toBe(1);
      expect(signPreparedPaymentMock).toHaveBeenCalledTimes(1);
    });

    it("Check status stays usable while the session request hangs", async () => {
      const session = deferred<Response>();
      const api = await unknownWithMarker(REASONS[0], { session: () => session.promise, status: () => jsonResponse(500, { error: "Something went wrong." }) });
      fireEvent.click(button("Sign in again"));
      await waitFor(() => expect(button("Checking…")).toBeDisabled());

      expect(button("Check status")).toBeEnabled();
      fireEvent.click(button("Check status"));
      await waitFor(() => expect(api.count("status")).toBe(1));
      expect(button("Checking…")).toBeDisabled();
      expect(api.count("session")).toBe(1);
      await act(async () => session.resolve(sessionOf(ACCOUNT)));
    });

    it("on the Sending screen, too: Check status is enabled and works while the session request hangs", async () => {
      const session = deferred<Response>();
      const api = stub({ latest: () => latestJson(attemptFixture({ state: "submitted", prepared: null })), status: REASONS[0].respond, session: () => session.promise });
      render(<RealPayForm />);
      await waitFor(() => expect(screen.getByText(SIGNED_OUT)).toBeInTheDocument());
      fireEvent.click(button("Sign in again"));
      await waitFor(() => expect(button("Checking…")).toBeDisabled());
      const reads = api.count("status");

      expect(button("Check status")).toBeEnabled();
      fireEvent.click(button("Check status"));
      await waitFor(() => expect(api.count("status")).toBe(reads + 1));
      await act(async () => session.resolve(sessionOf(ACCOUNT)));
      await settle();
      noNote();
    });
  });

  describe("other interleavings", () => {
    it("the account switches while both the session check and Check status are in flight: nothing of the first account is shown", async () => {
      const session = deferred<Response>();
      const status = deferred<Response>();
      const api = await unknownWithMarker(
        REASONS[0],
        { session: () => session.promise, status: () => status.promise },
        undefined,
      );
      // The other account's own payment read.
      const latestCalls: number[] = [];
      vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/real/session")) return session.promise;
        if (url.endsWith("/status")) return status.promise;
        if (url.endsWith("/api/real/payments/latest")) {
          latestCalls.push(1);
          return jsonResponse(200, { attempt: null });
        }
        throw new Error(`Unhandled fetch in test: ${url}`);
      });
      fireEvent.click(button("Sign in again"));
      await waitFor(() => expect(button("Checking…")).toBeDisabled());
      fireEvent.click(button("Check status"));
      await settle();

      await act(async () => session.resolve(sessionOf(ACCOUNT_B)));
      await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
      await act(async () => status.resolve(REASONS[0].respond(1) as Response));
      await settle();

      expect(useRealAccountStore.getState().account).toMatchObject({ appUserId: ACCOUNT_B.appUserId });
      noNote();
      expect(screen.queryByText(SIGNED_OUT)).toBeNull();
      expect(screen.queryByTestId("real-pay-unknown")).toBeNull();
      noButton("Sign in again");
      noButton("Check account");
      expect(useRealPaymentStore.getState()).toMatchObject({ status: "editing", attempt: null, pendingSubmission: null, sessionRecovery: null, error: null });
      expect(latestCalls.length).toBe(1);
      expect(api.count("submit")).toBe(0);
      expect(signPreparedPaymentMock).not.toHaveBeenCalled();
    });

    it("unmounting while the session check and a status read are in flight is safe: nothing thrown, logged or requested afterwards", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const session = deferred<Response>();
      const status = deferred<Response>();
      const api = await unknownWithMarker(REASONS[0], { session: () => session.promise, status: () => status.promise });
      fireEvent.click(button("Sign in again"));
      await waitFor(() => expect(button("Checking…")).toBeDisabled());
      fireEvent.click(button("Check status"));
      await waitFor(() => expect(api.count("status")).toBe(1));
      const requestsBefore = api.calls.length;

      cleanup();
      session.resolve(sessionOf(ACCOUNT));
      status.resolve(REASONS[0].respond(1) as Response);
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(api.calls.length).toBe(requestsBefore);
      expect(errors).not.toHaveBeenCalled();
      expect(signPreparedPaymentMock).not.toHaveBeenCalled();
    });

    it.each(["awaiting", "stranded"] as const)("%s screen: a session network failure leaves the screen as it was, with only the fixed neutral note", async (screenName) => {
      const api = stub({
        latest: () => latestJson(screenName === "awaiting" ? attemptFixture({ prepared: openWindow() }) : attemptFixture({ state: "signed", prepared: openWindow() })),
        session: () => Promise.reject(new TypeError("Failed to fetch")),
      });
      render(<RealPayForm />);
      await waitFor(() => expect(screen.getByTestId(screenName === "awaiting" ? "real-pay-resume" : "real-pay-stranded")).toBeInTheDocument());
      act(() => markerState(REASONS[0]));
      const requestsBefore = api.calls.length;

      fireEvent.click(button("Sign in again"));
      await waitFor(() => expect(screen.getByTestId("real-pay-session-note")).toBeInTheDocument());

      expect(screen.getByTestId("real-pay-session-note").textContent).toBe(SESSION_CHECK_FAILED);
      expect(screen.queryByText(/signed in/i)).toBeNull();
      expect(document.body.textContent).not.toMatch(RAW_TEXT);
      expect(api.keysSince(requestsBefore)).toEqual(["session"]);
      expect(button("Sign in again")).toBeEnabled();
      expect(useRealAccountStore.getState().account).toMatchObject({ appUserId: ACCOUNT.appUserId });
    });

    it.each(["sending", "awaiting", "stranded"] as const)("%s screen: repeated presses make one session request while the check runs", async (screenName) => {
      const session = deferred<Response>();
      const attempt = { sending: attemptFixture({ state: "submitted", prepared: null }), awaiting: attemptFixture({ prepared: openWindow() }), stranded: attemptFixture({ state: "signed", prepared: openWindow() }) }[screenName];
      const api = stub({ latest: () => latestJson(attempt), status: REASONS[0].respond, session: () => session.promise });
      render(<RealPayForm />);
      await waitFor(() => expect(screen.getByTestId({ sending: "real-pay-sending", awaiting: "real-pay-resume", stranded: "real-pay-stranded" }[screenName])).toBeInTheDocument());
      act(() => markerState(REASONS[0]));
      const control = button("Sign in again");

      act(() => {
        fireEvent.click(control);
        fireEvent.click(control);
        fireEvent.click(control);
      });
      await waitFor(() => expect(button("Checking…")).toBeDisabled());
      fireEvent.click(button("Checking…"));

      expect(api.count("session")).toBe(1);
      await act(async () => session.resolve(sessionOf(ACCOUNT)));
      await waitFor(() => expect(screen.getByTestId("real-pay-session-note")).toBeInTheDocument());
      expect(api.count("session")).toBe(1);
    });

    it("a different account's session on the Awaiting screen: the page follows it; the first account's payment and wording are gone", async () => {
      let latestCalls = 0;
      const api = stub({
        latest: () => (++latestCalls === 1 ? latestJson(attemptFixture({ prepared: openWindow() })) : jsonResponse(200, { attempt: null })),
        session: () => sessionOf(ACCOUNT_B),
      });
      render(<RealPayForm />);
      await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());
      act(() => markerState(REASONS[1]));

      fireEvent.click(button("Check account"));
      await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());

      noNote();
      expect(screen.queryByText(NOT_ACCESSIBLE)).toBeNull();
      expect(screen.queryByText(/0x3333/)).toBeNull();
      expect(useRealPaymentStore.getState()).toMatchObject({ attempt: null, pendingSubmission: null, sessionRecovery: null });
      expect(api.count("cancel") + api.count("submit") + api.count("prepare")).toBe(0);
      expect(signPreparedPaymentMock).not.toHaveBeenCalled();
    });
  });

  describe("what the page says while a status read is still pending", () => {
    it.each(REASONS)("HTTP $code: a session check that began before the Check status press leaves no note while that read is pending, nor after it answers", async (reason) => {
      const session = deferred<Response>();
      const status = deferred<Response>();
      const api = await unknownWithMarker(reason, { session: () => session.promise, status: () => status.promise });
      fireEvent.click(button(reason.label));
      await waitFor(() => expect(button("Checking…")).toBeDisabled());
      fireEvent.click(button("Check status"));
      await waitFor(() => expect(api.count("status")).toBe(1));

      await act(async () => session.resolve(sessionOf(ACCOUNT)));
      await waitFor(() => expect(button(reason.label)).toBeEnabled());
      await settle();
      noNote(); // the read is still pending: a note now would sit next to wording it is about to be replaced by

      await act(async () => status.resolve(reason.respond(1) as Response));
      await settle();
      noNote();
      expect(screen.getByText(reason.message)).toBeInTheDocument();
    });

    it("the marker clearing after the note was written takes the note with it", async () => {
      await unknownWithMarker(REASONS[0], { session: () => sessionOf(ACCOUNT) });
      fireEvent.click(button("Sign in again"));
      await waitFor(() => expect(screen.getByTestId("real-pay-session-note")).toBeInTheDocument());

      act(() => useRealPaymentStore.setState({ sessionRecovery: null, error: null }));
      expect(screen.queryByTestId("real-pay-session-note")).toBeNull();
      noButton("Sign in again");
      act(() => useRealPaymentStore.setState({ sessionRecovery: "signed_out", error: SIGNED_OUT }));

      noNote();
    });

    it("the Sending screen without a Check status button says only 'You're signed in.'", async () => {
      stub({ latest: () => latestJson(attemptFixture({ state: "submitted", prepared: null })), status: () => jsonResponse(500, { error: "Something went wrong." }), session: () => sessionOf(ACCOUNT) });
      render(<RealPayForm />);
      await waitFor(() => expect(screen.getByTestId("real-pay-sending")).toBeInTheDocument());
      await settle();
      act(() => useRealPaymentStore.setState({ status: "submitting", sessionRecovery: "signed_out", error: SIGNED_OUT }));
      noButton("Check status");
      noButton("Checked just now");

      fireEvent.click(button("Sign in again"));
      await waitFor(() => expect(screen.getByTestId("real-pay-session-note")).toBeInTheDocument());

      expect(screen.getByTestId("real-pay-session-note").textContent).toBe(SIGNED_IN_ONLY);
      noButton("Check status");
      expect(screen.getByTestId("real-pay-sending").textContent).not.toMatch(FALSE_CLAIMS);
    });
  });
});

/**
 * L-2 D-10: a GET /status HTTP 200 that is not an honest answer about the payment this page holds must never blank the Pay
 * screen, throw while rendering, show a false Sent or Failed, print the server's or the engine's text, or replace the
 * payment the page holds. The screen keeps its payment and its controls and shows the fixed message; Check status keeps
 * asking about the original attempt id. The production form is unchanged by D-10: these tests only prove it copes with
 * what the store now hands it.
 */
describe("RealPayForm — L-2 D-10: malformed status answers", () => {
  const UNUSABLE = "We couldn’t check on this payment just now. Try again in a little while.";
  const CONTEXT = { subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1" };
  const HELD_ID = "payment-attempt-1";
  const LEAKS = /FOREIGN|refunded-by-bank|engine-secret|0xdead|Cannot read|TypeError|Unexpected|not valid JSON|Failed to fetch|Unhandled fetch/;

  type Handler = (n: number) => Response | Promise<Response>;
  type Key = "latest" | "prepare" | "submit" | "status" | "balance" | "cancel";

  beforeEach(() => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready", error: null, hasHydrated: true });
    useRealBalanceStore.setState({ balance: { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" }, status: "ready", error: null });
    useRealPaymentStore.getState().reset();
    useRealPaymentStore.setState({ status: "idle" });
    signPreparedPaymentMock.mockReset();
    signPreparedPaymentMock.mockResolvedValue({ signature: "0xsig-d10", activityId: "activity-d10" });
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    cleanup();
    useRealPaymentStore.getState().reset();
    useRealAccountStore.setState({ account: null, status: "idle", error: null });
    signPreparedPaymentMock.mockReset();
    vi.restoreAllMocks();
  });

  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const openWindow = () => ({ ...PREPARED_FIELDS, validUntil: nowSeconds() + 3_600 });
  const held = (state: string) => attemptFixture({ state, prepared: openWindow() });
  const latestJson = (attempt: unknown) => jsonResponse(200, { attempt, ...CONTEXT, serverNowSeconds: nowSeconds() });
  const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 15))));

  function stub(handlers: Partial<Record<Key, Handler>>) {
    const calls: Array<{ key: Key | "other"; url: string; method: string }> = [];
    const counts = {} as Record<Key, number>;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        const key: Key | null = url.endsWith("/api/real/payments/latest")
          ? "latest"
          : url.endsWith("/api/real/payments/prepare")
            ? "prepare"
            : url.endsWith("/cancel")
              ? "cancel"
              : url.endsWith("/api/real/payments/submit")
                ? "submit"
                : url.endsWith("/status")
                  ? "status"
                  : url.endsWith("/api/real/account/balance")
                    ? "balance"
                    : null;
        calls.push({ key: key ?? "other", url, method });
        const handler = key ? handlers[key] : undefined;
        if (!key || !handler) throw new Error(`Unhandled fetch in test: ${method} ${url}`);
        counts[key] = (counts[key] ?? 0) + 1;
        return handler(counts[key]);
      }),
    );
    return { calls, keys: () => calls.map((call) => call.key), count: (key: Key) => calls.filter((call) => call.key === key).length };
  }

  /** What each malformed answer is: the server's honest answer for the held payment, damaged in one way. */
  const MALFORMED: Array<[string, () => unknown]> = [
    ["a null body", () => null],
    ["no attempt", () => ({ serverNowSeconds: nowSeconds(), reconciliationDeferred: false })],
    ["attempt: null", () => ({ attempt: null, serverNowSeconds: nowSeconds(), reconciliationDeferred: false })],
    ["an array instead of an attempt", () => ({ attempt: [held("confirmed")], serverNowSeconds: nowSeconds(), reconciliationDeferred: false })],
    ["a confirmed payment with another id", () => ({ attempt: attemptFixture({ state: "confirmed", id: "payment-FOREIGN", transactionHash: "0xabc", prepared: openWindow() }), serverNowSeconds: nowSeconds(), reconciliationDeferred: false })],
    ["a confirmed payment to another recipient", () => ({ attempt: attemptFixture({ state: "confirmed", recipient: "0xdead000000000000000000000000000000000001", transactionHash: "0xabc", prepared: openWindow() }), serverNowSeconds: nowSeconds(), reconciliationDeferred: false })],
    ["a confirmed payment for another amount", () => ({ attempt: attemptFixture({ state: "confirmed", amountBaseUnits: "9999999", transactionHash: "0xabc", prepared: openWindow() }), serverNowSeconds: nowSeconds(), reconciliationDeferred: false })],
    ["a failed payment whose reason is an object", () => ({ attempt: attemptFixture({ state: "failed", failureReason: { raw: "engine-secret" }, prepared: openWindow() }), serverNowSeconds: nowSeconds(), reconciliationDeferred: false })],
    ["a state the page does not know", () => ({ attempt: attemptFixture({ state: "refunded-by-bank", prepared: openWindow() }), serverNowSeconds: nowSeconds(), reconciliationDeferred: false })],
    ["the prepared fields dropped", () => ({ attempt: attemptFixture({ state: "confirmed", transactionHash: "0xabc", prepared: null }), serverNowSeconds: nowSeconds(), reconciliationDeferred: false })],
    ["no server clock", () => ({ attempt: held("confirmed"), reconciliationDeferred: false })],
  ];

  type Screen = "sending" | "unknown" | "awaiting" | "stranded";
  const SCREENS: Array<[Screen, string]> = [
    ["sending", "real-pay-sending"],
    ["unknown", "real-pay-unknown"],
    ["awaiting", "real-pay-resume"],
    ["stranded", "real-pay-stranded"],
  ];

  /** Brings the page to `screen` for the held payment, then asks for its status once; returns what the page did. */
  async function reach(screen: Screen, status: Handler) {
    const handlers: Partial<Record<Key, Handler>> = { status };
    if (screen === "sending") handlers.latest = () => latestJson(held("submitted"));
    else if (screen === "stranded") handlers.latest = () => latestJson(held("signed"));
    else handlers.latest = () => latestJson(held("awaiting_authorization"));
    if (screen === "unknown") handlers.submit = () => jsonResponse(500, { error: "Something went wrong. Please try again." });
    const api = stub(handlers);
    render(<RealPayForm />);
    await waitFor(() => expect(screen === "unknown" ? screen_("real-pay-resume") : screen_(testId(screen))).toBeInTheDocument());
    if (screen === "unknown") {
      fireEvent.click(screen_button("Continue"));
      await waitFor(() => expect(screen_("real-pay-unknown")).toBeInTheDocument());
    }
    return api;
  }
  const testId = (s: Screen) => SCREENS.find(([name]) => name === s)![1];
  const screen_ = (id: string) => screen.getByTestId(id);
  const screen_button = (name: string) => screen.getByRole("button", { name });

  /**
   * The user's own way to ask: the Check status button on the unknown screen, the store action where the screen has none.
   * The Sending screen reads once by itself when it appears (the post-submit check), which is the same read.
   */
  async function askForStatus(s: Screen) {
    if (s === "unknown") fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    else if (s !== "sending") await act(async () => void (await useRealPaymentStore.getState().checkStatus()));
  }

  describe.each(SCREENS)("the %s screen", (name, id) => {
    it.each(MALFORMED)("%s: the screen stays, shows the fixed message, and the payment is untouched", async (_case, body) => {
      const api = await reach(name, () => jsonResponse(200, body()));
      const before = structuredClone(useRealPaymentStore.getState().attempt);
      const statusBefore = useRealPaymentStore.getState().status;
      const signsBefore = signPreparedPaymentMock.mock.calls.length;
      expect(before).toMatchObject({ id: HELD_ID });

      await askForStatus(name);
      await waitFor(() => expect(screen.getByText(UNUSABLE)).toBeInTheDocument());
      await settle();

      // Still the same screen — not blank, not a thrown render, not Sent, not Failed.
      expect(screen.getByTestId(id)).toBeInTheDocument();
      expect(screen.queryByTestId("real-pay-confirmed")).toBeNull();
      expect(screen.queryByTestId("real-pay-failed")).toBeNull();
      expect(screen.queryByTestId("real-pay-form")).toBeNull();
      expect(document.body.textContent).not.toMatch(LEAKS);
      // The payment the page holds is exactly the one it held, with its approval and context.
      const after = useRealPaymentStore.getState();
      expect(after.attempt).toEqual(before);
      expect(after.status).toBe(statusBefore);
      expect(after.authorizingCredentialId).toBe("credential-1");
      expect(after.subOrganizationId).toBe("sub-org-1");
      expect(after.error).toBe(UNUSABLE);
      expect(after.sessionRecovery).toBeNull();
      // Check status asked about the original payment — once — and nothing was prepared, cancelled, balance-read or sent again.
      expect(api.calls.filter((call) => call.key === "status").map((call) => call.url)).toEqual([`/api/real/payments/${HELD_ID}/status`]);
      expect(api.keys().filter((key) => key !== "latest" && key !== "status" && key !== "submit")).toEqual([]);
      expect(api.count("submit")).toBe(name === "unknown" ? 1 : 0);
      expect(signPreparedPaymentMock.mock.calls.length).toBe(signsBefore);
    });

    it("keeps the controls that belong to the screen", async () => {
      const api = await reach(name, () => jsonResponse(200, null));
      await askForStatus(name);
      await waitFor(() => expect(screen.getByText(UNUSABLE)).toBeInTheDocument());
      await settle();

      if (name === "awaiting") {
        expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
        expect(screen.getByRole("button", { name: "Cancel payment" })).toBeEnabled();
        expect(screen.getByText(new RegExp(RECIPIENT))).toBeInTheDocument();
      } else if (name === "stranded") {
        expect(screen.getByRole("button", { name: "Cancel payment" })).toBeEnabled();
        expect(screen.getByTestId("real-pay-stranded-details").textContent).toMatch(/to /);
      } else {
        // The one Check status button is unavailable for now (the 60 s fallback), and pressing it sends nothing.
        const check = screen.getByRole("button", { name: /Check available later|Checked just now/ });
        expect(check).toBeDisabled();
        fireEvent.click(check);
        await settle();
      }
      expect(api.count("status")).toBe(1);
      expect(api.count("submit")).toBe(name === "unknown" ? 1 : 0);
    });
  });

  it("an honest answer on the same screens still adopts the payment (the new check does not hide real results)", async () => {
    for (const [name, id] of SCREENS) {
      cleanup();
      useRealPaymentStore.getState().reset();
      useRealPaymentStore.setState({ status: "idle" });
      const api = await reach(name, () => jsonResponse(200, { attempt: held("confirmed"), serverNowSeconds: nowSeconds(), reconciliationDeferred: false }));
      await askForStatus(name);
      await waitFor(() => expect(screen.getByTestId("real-pay-confirmed")).toBeInTheDocument());
      expect(screen.queryByTestId(id)).toBeNull();
      expect(screen.queryByText(UNUSABLE)).toBeNull();
      expect(api.count("status")).toBe(1);
    }
  });
});

/**
 * L-2 D-11: a POST /cancel HTTP 200 that is not an honest "this payment was cancelled" must never send the user back to an
 * empty form (as if the payment were gone) or print the engine's or the server's text. The screen keeps its payment, its
 * approval context and its controls and shows the existing fixed "Could not confirm whether this payment was cancelled…"
 * message; pressing Cancel again is the user's own new request. The production form is unchanged by D-11: these tests only
 * prove it copes with what the store now hands it. They do not cover the stranded screen's wording (a separate item).
 */
describe("RealPayForm — L-2 D-11: malformed Cancel answers", () => {
  const CANCEL_UNCONFIRMED = "Could not confirm whether this payment was cancelled. Check its status before trying again.";
  const SIGNED_OUT = "You're signed out, so we can't confirm this payment yet. Sign in again to check its status.";
  const CONTEXT = { subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1" };
  const HELD_ID = "payment-attempt-1";
  const LEAKS = /FOREIGN|refunded-by-bank|engine-secret|0xdead|Cannot read|TypeError|SyntaxError|Unexpected|not valid JSON|Failed to fetch|Unhandled fetch/;
  /** Checked after the fixed message (which itself says "was cancelled") is removed: nothing may claim the payment is cancelled. */
  const FALSE_CANCELLED = /was cancelled|has been cancelled|is cancelled|payment cancelled|cancelled/i;

  type Handler = (n: number) => Response | Promise<Response>;
  type Key = "latest" | "cancel" | "status" | "submit" | "prepare" | "balance";

  beforeEach(() => {
    useRealAccountStore.setState({ account: ACCOUNT, status: "ready", error: null, hasHydrated: true });
    useRealBalanceStore.setState({ balance: { token: "USDC", decimals: 6, balanceBaseUnits: "20000000" }, status: "ready", error: null });
    useRealPaymentStore.getState().reset();
    useRealPaymentStore.setState({ status: "idle" });
    signPreparedPaymentMock.mockReset();
    signPreparedPaymentMock.mockResolvedValue({ signature: "0xsig-d11", activityId: "activity-d11" });
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    cleanup();
    useRealPaymentStore.getState().reset();
    useRealAccountStore.setState({ account: null, status: "idle", error: null });
    signPreparedPaymentMock.mockReset();
    vi.restoreAllMocks();
  });

  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const openWindow = () => ({ ...PREPARED_FIELDS, validUntil: nowSeconds() + 3_600 });
  const latestJson = (attempt: unknown) => jsonResponse(200, { attempt, ...CONTEXT, serverNowSeconds: nowSeconds() });
  const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 15))));
  const cancelledBody = (over: Record<string, unknown> = {}) => ({ attempt: attemptFixture({ state: "cancelled", prepared: openWindow(), ...over }) });

  function stub(handlers: Partial<Record<Key, Handler>>) {
    const calls: Array<{ key: Key | "other"; url: string; method: string }> = [];
    const counts = {} as Record<Key, number>;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        const key: Key | null = url.endsWith("/api/real/payments/latest")
          ? "latest"
          : url.endsWith("/api/real/payments/prepare")
            ? "prepare"
            : url.endsWith("/cancel")
              ? "cancel"
              : url.endsWith("/api/real/payments/submit")
                ? "submit"
                : url.endsWith("/status")
                  ? "status"
                  : url.endsWith("/api/real/account/balance")
                    ? "balance"
                    : null;
        calls.push({ key: key ?? "other", url, method });
        const handler = key ? handlers[key] : undefined;
        if (!key || !handler) throw new Error(`Unhandled fetch in test: ${method} ${url}`);
        counts[key] = (counts[key] ?? 0) + 1;
        return handler(counts[key]);
      }),
    );
    return { calls, keys: () => calls.map((call) => call.key), count: (key: Key) => calls.filter((call) => call.key === key).length };
  }

  type Screen = "approval" | "stranded";
  const SCREENS: Array<[Screen, string]> = [
    ["approval", "real-pay-resume"],
    ["stranded", "real-pay-stranded"],
  ];
  const latestFor = (screen: Screen) => () => latestJson(attemptFixture({ state: screen === "approval" ? "awaiting_authorization" : "signed", prepared: openWindow() }));

  async function arrive(screen: Screen, cancel: Handler) {
    const api = stub({ latest: latestFor(screen), cancel });
    render(<RealPayForm />);
    await waitFor(() => expect(screen_(screen === "approval" ? "real-pay-resume" : "real-pay-stranded")).toBeInTheDocument());
    return api;
  }
  const screen_ = (id: string) => screen.getByTestId(id);
  const pressCancel = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Cancel payment" }));
    await settle();
  };
  /** The payment's own card (amount and recipient), as the user reads it. */
  const paymentLine = (id: string) => screen.getByTestId(id).firstElementChild!.textContent;

  const MALFORMED: Array<[string, () => Response]> = [
    ["an empty body", () => new Response("", { status: 200 })],
    ["an HTML body", () => new Response("<html>engine-secret</html>", { status: 200 })],
    ["attempt: null", () => jsonResponse(200, { attempt: null })],
    ["another payment's cancelled answer", () => jsonResponse(200, cancelledBody({ id: "payment-FOREIGN" }))],
    ["a payment that is not cancelled", () => jsonResponse(200, cancelledBody({ state: "submitted", transactionHash: null }))],
    ["a cancelled answer for another recipient", () => jsonResponse(200, cancelledBody({ recipient: "0xdead000000000000000000000000000000000001" }))],
    ["a cancelled answer for another amount", () => jsonResponse(200, cancelledBody({ amountBaseUnits: "9999999" }))],
    ["a cancelled answer carrying a transaction hash", () => jsonResponse(200, cancelledBody({ transactionHash: "0xabc" }))],
  ];

  describe.each(SCREENS)("the %s screen", (name, id) => {
    it.each(MALFORMED)("%s: the payment, its controls and the fixed message stay; no form, no false cancellation", async (_case, answer) => {
      const api = await arrive(name, () => answer());
      const lineBefore = paymentLine(id);
      const attemptBefore = structuredClone(useRealPaymentStore.getState().attempt);
      expect(lineBefore).toMatch(/1/); // the amount

      await pressCancel();

      expect(screen.getByTestId(id)).toBeInTheDocument();
      expect(screen.queryByTestId("real-pay-form")).toBeNull();
      expect(screen.queryByTestId("real-pay-confirmed")).toBeNull();
      expect(screen.queryByTestId("real-pay-failed")).toBeNull();
      expect(screen.getByText(CANCEL_UNCONFIRMED)).toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(LEAKS);
      expect(document.body.textContent?.replace(CANCEL_UNCONFIRMED, "")).not.toMatch(FALSE_CANCELLED);
      // The same payment, same card, same controls — Cancel is available again; Continue only where it was offered.
      expect(paymentLine(id)).toBe(lineBefore);
      expect(useRealPaymentStore.getState().attempt).toEqual(attemptBefore);
      expect(useRealPaymentStore.getState()).toMatchObject({ status: name === "approval" ? "awaiting_authorization" : "stranded", ...CONTEXT, isCancelling: false, error: CANCEL_UNCONFIRMED });
      expect(screen.getByRole("button", { name: "Cancel payment" })).toBeEnabled();
      if (name === "approval") expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
      else expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
      // One Cancel POST for this payment and nothing else; nothing is signed or sent, and nothing follows by itself.
      await settle();
      expect(api.keys()).toEqual(["latest", "cancel"]);
      expect(api.calls[1]).toEqual({ key: "cancel", url: `/api/real/payments/${HELD_ID}/cancel`, method: "POST" });
      expect(signPreparedPaymentMock).not.toHaveBeenCalled();
    });

    it("the D-9 session control stays beside the fixed message when its marker is set", async () => {
      const api = await arrive(name, () => jsonResponse(200, { attempt: null }));
      act(() => useRealPaymentStore.setState({ sessionRecovery: "signed_out", error: SIGNED_OUT }));
      expect(screen.getByRole("button", { name: "Sign in again" })).toBeInTheDocument();

      await pressCancel();

      expect(screen.getByText(CANCEL_UNCONFIRMED)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Sign in again" })).toBeEnabled();
      expect(useRealPaymentStore.getState().sessionRecovery).toBe("signed_out");
      expect(screen.getByTestId(id)).toBeInTheDocument();
      expect(screen.queryByTestId("real-pay-form")).toBeNull();
      expect(api.keys()).toEqual(["latest", "cancel"]);
    });

    it("a second press is the user's own new request: after a malformed answer, an honest one returns to the form", async () => {
      const api = await arrive(name, (n) => (n === 1 ? jsonResponse(200, { attempt: null }) : jsonResponse(200, cancelledBody())));
      await pressCancel();
      expect(screen.getByText(CANCEL_UNCONFIRMED)).toBeInTheDocument();
      expect(api.count("cancel")).toBe(1);

      await pressCancel();

      expect(api.count("cancel")).toBe(2);
      expect(screen.getByTestId("real-pay-form")).toBeInTheDocument();
      expect(screen.queryByTestId(id)).toBeNull();
      expect(screen.queryByText(CANCEL_UNCONFIRMED)).toBeNull();
    });

    it("an honest cancelled answer still returns to the form exactly as before (no leftover payment, no message)", async () => {
      const api = await arrive(name, () => jsonResponse(200, cancelledBody()));
      await pressCancel();

      expect(screen.getByTestId("real-pay-form")).toBeInTheDocument();
      expect(screen.queryByTestId(id)).toBeNull();
      expect(screen.queryByText(CANCEL_UNCONFIRMED)).toBeNull();
      expect(useRealPaymentStore.getState()).toMatchObject({ status: "editing", attempt: null, subOrganizationId: null, authorizingCredentialId: null, pendingSubmission: null, error: null });
      expect(api.keys()).toEqual(["latest", "cancel"]);
      expect(signPreparedPaymentMock).not.toHaveBeenCalled();
    });

    it("an honest answer that ignores fields the check does not read (no prepared, no clock, an odd reason) still returns to the form", async () => {
      await arrive(name, () => jsonResponse(200, cancelledBody({ prepared: "n/a", failureReason: 5 })));
      await pressCancel();
      expect(screen.getByTestId("real-pay-form")).toBeInTheDocument();
      expect(screen.queryByText(CANCEL_UNCONFIRMED)).toBeNull();
    });

    it("while the answer's body is still being read the Cancel button stays disabled and a click sends nothing more", async () => {
      let release: (value: unknown) => void = () => {};
      const body = new Promise<unknown>((resolve) => (release = resolve));
      const api = await arrive(name, () => ({ ok: true, status: 200, headers: new Headers(), json: () => body }) as unknown as Response);

      fireEvent.click(screen.getByRole("button", { name: "Cancel payment" }));
      await settle();
      expect(screen.getByRole("button", { name: "Cancel payment" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Cancel payment" }));
      await settle();
      expect(api.count("cancel")).toBe(1);

      release(cancelledBody());
      await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
      expect(api.count("cancel")).toBe(1);
    });
  });
});
