import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRealAccountStore } from "@/lib/stores/real-account-store";
import { useRealBalanceStore } from "@/lib/stores/real-balance-store";
import { useRealPaymentStore } from "@/lib/stores/real-payment-store";

const signPreparedPaymentMock = vi.fn();
vi.mock("@/lib/real/payments/client-sign", () => ({
  signPreparedPayment: (...args: unknown[]) => signPreparedPaymentMock(...(args as [never])),
}));

const { RealPayForm } = await import("@/components/real/real-pay-form");

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
    expect(screen.getByLabelText("Recipient")).toBeInTheDocument();
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

    fireEvent.change(screen.getByLabelText("Recipient"), { target: { value: RECIPIENT } });
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
        return jsonResponse(200, { attempt: attemptFixture({ state: "confirmed", transactionHash: "0xabc123" }) });
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

    fireEvent.change(screen.getByLabelText("Recipient"), { target: { value: RECIPIENT } });
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
    fireEvent.change(screen.getByLabelText("Recipient"), { target: { value: RECIPIENT } });
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

    fireEvent.change(screen.getByLabelText("Recipient"), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.00" } });
    expect(screen.getByLabelText("Recipient")).toHaveValue(RECIPIENT);

    act(() => {
      useRealAccountStore.setState({ account: null, status: "signed-out" });
    });
    act(() => {
      useRealAccountStore.setState({ account: ACCOUNT_B, status: "ready" });
    });

    await waitFor(() => expect(screen.getByTestId("real-pay-form")).toBeInTheDocument());
    expect(screen.getByLabelText("Recipient")).toHaveValue("");
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
    fireEvent.change(screen.getByLabelText("Recipient"), { target: { value: RECIPIENT } });
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
    fireEvent.change(screen.getByLabelText("Recipient"), { target: { value: RECIPIENT } });
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
          attempt: attemptFixture({ state: "failed", failureReason: "This payment expired before it was included on-chain. No money moved.", prepared: null }),
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
    fireEvent.change(screen.getByLabelText("Recipient"), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-review")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(screen.getByTestId("real-pay-stranded")).toBeInTheDocument());
    expect(signPreparedPaymentMock).not.toHaveBeenCalled();
  });
});
