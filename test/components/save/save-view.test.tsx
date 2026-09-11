import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { SaveView } from "@/components/save/save-view";
import { useSimulationStore } from "@/lib/stores/simulation-store";
import { createInitialState, toMicroUnits } from "@/simulation";

async function resetStore() {
  localStorage.clear();
  useSimulationStore.setState({ state: createInitialState() });
  await act(async () => {
    await useSimulationStore.persist.rehydrate();
  });
}

function addMoney(amount: string) {
  fireEvent.click(screen.getByRole("button", { name: "Add money" }));
  fireEvent.change(screen.getByLabelText("Add to savings"), { target: { value: amount } });
  fireEvent.click(screen.getByRole("button", { name: "Add money" }));
}

describe("SaveView", () => {
  beforeEach(resetStore);

  it("shows an empty position and the current rate", () => {
    render(<SaveView />);

    expect(screen.getByTestId("savings-balance")).toHaveTextContent("$0.00");
    expect(screen.getByTestId("value-row-current-rate")).toHaveTextContent("4.00% a year");
    expect(screen.getByTestId("value-row-interest-earned")).toHaveTextContent("$0.00");
  });

  it("adds money, moving it out of cash and into savings", () => {
    render(<SaveView />);
    addMoney("1000");

    expect(screen.getByTestId("savings-balance")).toHaveTextContent("$1,000.00");
    expect(useSimulationStore.getState().state.savings.balance).toBe(toMicroUnits(1_000));
    expect(useSimulationStore.getState().state.balances.USDC).toBe(toMicroUnits(9_000));
    expect(screen.getByRole("status")).toHaveTextContent("Moved $1,000.00 into savings.");
  });

  it("rejects an amount larger than the user's cash, leaving state untouched", () => {
    render(<SaveView />);
    const before = useSimulationStore.getState().state;

    addMoney("50000");

    expect(screen.getByText("You don't have that much cash.")).toBeInTheDocument();
    expect(useSimulationStore.getState().state).toEqual(before);
  });

  it("rejects a zero or unparseable amount", () => {
    render(<SaveView />);

    fireEvent.click(screen.getByRole("button", { name: "Add money" }));
    fireEvent.change(screen.getByLabelText("Add to savings"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Add money" }));

    expect(screen.getByText("Enter an amount greater than zero.")).toBeInTheDocument();
    expect(useSimulationStore.getState().state.savings.balance).toBe(0);
  });

  it("withdraws money back into cash", () => {
    render(<SaveView />);
    addMoney("1000");

    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    fireEvent.change(screen.getByLabelText("Withdraw from savings"), { target: { value: "400" } });
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));

    expect(screen.getByTestId("savings-balance")).toHaveTextContent("$600.00");
    expect(useSimulationStore.getState().state.balances.USDC).toBe(toMicroUnits(9_400));
    expect(screen.getByRole("status")).toHaveTextContent("Moved $400.00 back to cash.");
  });

  it("cannot withdraw from an empty position", () => {
    render(<SaveView />);
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeDisabled();
  });

  it("earns visible interest when the user skips a month ahead", () => {
    render(<SaveView />);
    addMoney("1000");

    expect(screen.getByTestId("value-row-interest-earned")).toHaveTextContent("$0.00");

    fireEvent.click(screen.getByRole("button", { name: "See one month later" }));

    // 4.00% a year on $1,000, for 30 days.
    expect(screen.getByTestId("value-row-interest-earned")).toHaveTextContent("$3.29");
    expect(screen.getByTestId("savings-balance")).toHaveTextContent("$1,003.29");
    expect(screen.getByRole("status")).toHaveTextContent("A month went by — you earned $3.29");
  });

  it("is explicit that skipping ahead simulates time", () => {
    render(<SaveView />);
    addMoney("1000");
    fireEvent.click(screen.getByRole("button", { name: "See one month later" }));

    expect(screen.getByText(/skipped ahead 1 month in Practice Mode/)).toBeInTheDocument();
  });

  it("explains where interest comes from, with the real-money detail a tap away", () => {
    render(<SaveView />);

    expect(screen.getByText("Where does the interest come from?")).toBeInTheDocument();
    expect(screen.getByText(/made available to people who want to borrow/)).toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: /what about real money/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/in open markets rather than inside one bank/)).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/in open markets rather than inside one bank/)).toBeInTheDocument();
  });
});
