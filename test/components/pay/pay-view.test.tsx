import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { PayView } from "@/components/pay/pay-view";
import { useSimulationStore } from "@/lib/stores/simulation-store";
import { createInitialState } from "@/simulation";

async function resetStore() {
  localStorage.clear();
  useSimulationStore.setState({ state: createInitialState() });
  await act(async () => {
    await useSimulationStore.persist.rehydrate();
  });
}

function openForm(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

function pickContact(displayName: string) {
  fireEvent.click(screen.getByRole("button", { name: displayName }));
}

function fillAmount(label: string, amount: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value: amount } });
}

function submit(label: string) {
  fireEvent.click(screen.getByRole("button", { name: label }));
}

describe("PayView", () => {
  beforeEach(() => resetStore());

  it("renders an empty Pay page with no stale placeholder copy", () => {
    render(<PayView />);

    expect(screen.getByTestId("pay-cash-headline")).toHaveTextContent("$10,000.00");
    for (const name of ["Send money", "Receive", "Request", "Add money", "Withdraw"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Send money" })).not.toBeDisabled();
    expect(screen.getByText("No activity yet")).toBeInTheDocument();
    expect(screen.queryByText(/arrives with the next update/)).not.toBeInTheDocument();
    expect(screen.queryByText("Requests")).not.toBeInTheDocument();
  });

  it("sends money to a contact, decreasing Cash and recording activity", () => {
    render(<PayView />);

    openForm("Send money");
    pickContact("Maya Chen");
    fillAmount("Send money", "50");
    submit("Send money");

    expect(screen.getByTestId("pay-cash-headline")).toHaveTextContent("$9,950.00");
    expect(screen.getByRole("status")).toHaveTextContent("Sent $50.00 to Maya Chen.");
    expect(screen.getByText("Sent to Maya Chen")).toBeInTheDocument();
    expect(screen.getByText("−$50.00")).toBeInTheDocument();
    expect(useSimulationStore.getState().state.balances.USDC).toBe(9_950_000_000);
  });

  it("refuses to send more Cash than is available", () => {
    render(<PayView />);

    openForm("Send money");
    pickContact("Maya Chen");
    fillAmount("Send money", "50000");
    submit("Send money");

    expect(screen.getByText("You don't have enough Cash to send that.")).toBeInTheDocument();
    expect(screen.getByTestId("pay-cash-headline")).toHaveTextContent("$10,000.00");
  });

  it("simulates receiving money from a contact, increasing Cash and showing the Practice handle", () => {
    render(<PayView />);

    openForm("Receive");
    expect(screen.getByText(/@practice-you/)).toBeInTheDocument();
    pickContact("Jordan Lee");
    fillAmount("Receive", "25");
    submit("Receive");

    expect(screen.getByTestId("pay-cash-headline")).toHaveTextContent("$10,025.00");
    expect(screen.getByText("Received from Jordan Lee")).toBeInTheDocument();
    expect(screen.getByText("+$25.00")).toBeInTheDocument();
  });

  it("creates a request without moving Cash, then pays it exactly once", () => {
    render(<PayView />);

    openForm("Request");
    pickContact("Alex Rivera");
    fillAmount("Request", "40");
    submit("Request");

    expect(screen.getByTestId("pay-cash-headline")).toHaveTextContent("$10,000.00");
    expect(screen.getByText("$40.00 from Alex Rivera")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Simulate Alex Rivera paying" }));

    expect(screen.getByTestId("pay-cash-headline")).toHaveTextContent("$10,040.00");
    expect(screen.getByText("Received from Alex Rivera")).toBeInTheDocument();
    expect(screen.queryByText("$40.00 from Alex Rivera")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Simulate Alex Rivera paying" })).not.toBeInTheDocument();

    const requestId = useSimulationStore.getState().state.pay.requests[0].id;
    const second = useSimulationStore.getState().dispatch({ type: "complete-payment-request", requestId });
    expect(second.ok).toBe(false);
    expect(useSimulationStore.getState().state.balances.USDC).toBe(10_040_000_000);
  });

  it("adds simulated Cash via deposit", () => {
    render(<PayView />);

    openForm("Add money");
    fillAmount("Add money", "200");
    submit("Add money");

    expect(screen.getByTestId("pay-cash-headline")).toHaveTextContent("$10,200.00");
    expect(screen.getByText("Added Cash")).toBeInTheDocument();
    expect(screen.getByText("+$200.00")).toBeInTheDocument();
  });

  it("withdraws simulated Cash", () => {
    render(<PayView />);

    openForm("Withdraw");
    fillAmount("Withdraw", "300");
    submit("Withdraw");

    expect(screen.getByTestId("pay-cash-headline")).toHaveTextContent("$9,700.00");
    expect(screen.getByText("Withdrew Cash")).toBeInTheDocument();
    expect(screen.getByText("−$300.00")).toBeInTheDocument();
  });

  it("refuses to withdraw more Cash than is available", () => {
    render(<PayView />);

    openForm("Withdraw");
    fillAmount("Withdraw", "50000");
    submit("Withdraw");

    expect(screen.getByText("You don't have enough Cash to withdraw that.")).toBeInTheDocument();
    expect(screen.getByTestId("pay-cash-headline")).toHaveTextContent("$10,000.00");
  });

  it("lists Pay activity most-recent-first with correct signed amounts", () => {
    render(<PayView />);

    openForm("Add money");
    fillAmount("Add money", "100");
    submit("Add money");

    openForm("Send money");
    pickContact("Maya Chen");
    fillAmount("Send money", "20");
    submit("Send money");

    const rows = screen.getAllByText(/Added Cash|Sent to Maya Chen/);
    expect(rows[0]).toHaveTextContent("Sent to Maya Chen");
    expect(rows[1]).toHaveTextContent("Added Cash");
  });

  it("opens the blockchain progressive-disclosure explainer", () => {
    render(<PayView />);

    expect(screen.getByText("Where is the blockchain?")).toBeInTheDocument();
    expect(screen.queryByText(/doesn.t send blockchain transactions today/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Would I need a wallet address or gas/ }));

    expect(screen.getByText(/doesn.t send blockchain transactions today/)).toBeInTheDocument();
  });
});
