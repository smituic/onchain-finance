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
      recipientLookup: { status: "idle" },
      recipientLabel: null,
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
      if (url.includes("/status")) return jsonResponse(200, { attempt: attemptFixture({ state: "submitted" }), serverNowSeconds: 1_900_000_000 });
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

  it("approval, sending, and sent screens name the person (display name + @name) instead of the address, and prepare got only the handle", async () => {
    const { prepares } = stubRoutes({
      lookup: () => jsonResponse(200, FOUND_SMIT),
      prepare: prepareOk,
      submit: () => jsonResponse(200, { attempt: attemptFixture({ state: "confirmed", transactionHash: "0xabc123" }) }),
    });
    signPreparedPaymentMock.mockRejectedValueOnce(Object.assign(new Error("cancelled"), { name: "NotAllowedError" }));
    let finishSigning: (value: { signature: string; activityId: string }) => void = () => {};
    signPreparedPaymentMock.mockImplementationOnce(() => new Promise((resolve) => (finishSigning = resolve)));

    const input = await renderForm();
    fireEvent.change(input, { target: { value: "@smit" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-review")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    // Passkey prompt dismissed -> the pending-approval screen.
    await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());
    expect(prepares).toEqual([{ recipientHandle: "smit", amountBaseUnits: "1000000" }]);
    expect(screen.getByText("To: Smit Patel (@smit)")).toBeInTheDocument();
    expect(screen.queryByText(RECIPIENT, { exact: false })).not.toBeInTheDocument();
    expect(screen.getByText(/Only continue if you started this payment/)).toBeInTheDocument();

    // Sending.
    useRealPaymentStore.setState({ status: "submitting" });
    await waitFor(() => expect(screen.getByTestId("real-pay-sending")).toHaveTextContent("To Smit Patel (@smit)"));
    useRealPaymentStore.setState({ status: "awaiting_authorization" });

    // Continue -> sent.
    await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await act(async () => finishSigning({ signature: "0xsignature", activityId: "activity-1" }));
    await waitFor(() => expect(screen.getByTestId("real-pay-confirmed")).toBeInTheDocument());
    expect(screen.getByTestId("real-pay-confirmed")).toHaveTextContent("to Smit Patel (@smit)");
    expect(screen.getByTestId("real-pay-confirmed").textContent).not.toContain("0x3333");

    // "Send another payment" clears the label with everything else.
    fireEvent.click(screen.getByRole("button", { name: "Send another payment" }));
    expect(useRealPaymentStore.getState()).toMatchObject({ recipientLabel: null, recipientLookup: { status: "idle" }, recipientInput: "" });
  });

  it("a handle payment with no display name is named by its @name alone on the approval screen", async () => {
    stubRoutes({ lookup: () => jsonResponse(200, { ...FOUND_SMIT, displayName: null }), prepare: prepareOk });
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

  it("a label for a different attempt id is never reused — the full address is shown", async () => {
    stubRoutes({ latest: () => jsonResponse(200, { attempt: attemptFixture(), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: 1_900_000_000 }) });
    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());

    act(() => useRealPaymentStore.setState({ recipientLabel: { attemptId: "some-other-attempt", handle: "smit", displayName: "Smit Patel" } }));

    expect(screen.getByText(RECIPIENT, { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(/Smit Patel/)).not.toBeInTheDocument();
    act(() => useRealPaymentStore.getState().reset());
  });

  it("a reload-restored attempt has no label: the address is shown, as before", async () => {
    stubRoutes({ latest: () => jsonResponse(200, { attempt: attemptFixture(), subOrganizationId: "sub-org-1", authorizingCredentialId: "credential-1", serverNowSeconds: 1_900_000_000 }) });
    // Even if a label survived in memory from an earlier flow, init() drops it.
    useRealPaymentStore.setState({ recipientLabel: { attemptId: "payment-attempt-1", handle: "smit", displayName: "Smit Patel" } });
    render(<RealPayForm />);
    await waitFor(() => expect(screen.getByTestId("real-pay-resume")).toBeInTheDocument());

    expect(useRealPaymentStore.getState().recipientLabel).toBeNull();
    expect(screen.getByText(`To: ${RECIPIENT}`)).toBeInTheDocument();
    act(() => useRealPaymentStore.getState().reset());
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
      submit: () => jsonResponse(200, { attempt: attemptFixture({ state: "confirmed", transactionHash: "0xabc123" }) }),
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
    expect(useRealPaymentStore.getState().recipientLabel).toBeNull();
  });
});
