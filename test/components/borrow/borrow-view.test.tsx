import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { BorrowView } from "@/components/borrow/borrow-view";
import { useSimulationStore } from "@/lib/stores/simulation-store";
import { formatUsd } from "@/lib/format";
import { createInitialState, toMicroUnits } from "@/simulation";

async function resetStore({ eth = 0 }: { eth?: number } = {}) {
  localStorage.clear();
  const base = createInitialState();
  useSimulationStore.setState({
    state: { ...base, balances: { ...base.balances, ETH: toMicroUnits(eth) } },
  });
  await act(async () => {
    await useSimulationStore.persist.rehydrate();
  });
}

function submitForm(openButton: string, submitButton: string, amount: string, label: string) {
  fireEvent.click(screen.getByRole("button", { name: openButton }));
  fireEvent.change(screen.getByLabelText(label), { target: { value: amount } });
  fireEvent.click(screen.getByRole("button", { name: submitButton }));
}

function pledge(eth: string) {
  submitForm("Set aside ETH", "Set aside ETH", eth, "Set aside ETH");
}

function borrow(usd: string) {
  submitForm("Borrow cash", "Borrow cash", usd, "Borrow cash");
}

describe("BorrowView", () => {
  describe("without any ETH", () => {
    beforeEach(() => resetStore());

    it("explains what's needed and points at Swap instead of faking collateral", () => {
      render(<BorrowView />);

      expect(screen.getByText("You need ETH first")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Get some ETH in Swap" })).toHaveAttribute(
        "href",
        "/swap",
      );
      expect(screen.queryByTestId("borrow-headline")).not.toBeInTheDocument();
    });
  });

  describe("holding 2 ETH", () => {
    beforeEach(() => resetStore({ eth: 2 }));

    it("reflects the user's actual ETH once it's set aside", () => {
      render(<BorrowView />);
      pledge("1");

      expect(screen.getByTestId("value-row-eth-set-aside")).toHaveTextContent("$3,000.00");
      expect(screen.getByTestId("value-row-eth-set-aside")).toHaveTextContent("1 ETH");
      expect(useSimulationStore.getState().state.balances.ETH).toBe(toMicroUnits(1));
    });

    it("shows borrowing capacity at half the collateral's value", () => {
      render(<BorrowView />);
      pledge("1");

      expect(screen.getByTestId("borrow-headline")).toHaveTextContent("$1,500.00");
      expect(screen.getByTestId("value-row-available-to-borrow")).toHaveTextContent("$1,500.00");
    });

    it("borrows cash, reducing what's left available", () => {
      render(<BorrowView />);
      pledge("1");
      borrow("1000");

      expect(useSimulationStore.getState().state.borrow.debtMicroUsd).toBe(toMicroUnits(1_000));
      expect(useSimulationStore.getState().state.balances.USDC).toBe(toMicroUnits(11_000));
      expect(screen.getByTestId("borrow-headline")).toHaveTextContent("$1,000.00");
      expect(screen.getByTestId("value-row-available-to-borrow")).toHaveTextContent("$500.00");
      expect(screen.getByRole("status")).toHaveTextContent("Borrowed $1,000.00");
    });

    it("refuses to lend beyond what the collateral supports", () => {
      render(<BorrowView />);
      pledge("1");
      borrow("2000");

      expect(screen.getByText("That's more than your ETH can safely support.")).toBeInTheDocument();
      expect(useSimulationStore.getState().state.borrow.debtMicroUsd).toBe(0);
    });

    it("shows position health and the price the collateral would be sold at", () => {
      render(<BorrowView />);
      pledge("1");
      borrow("1500");

      expect(screen.getByTestId("position-health")).toHaveTextContent("Healthy");
      expect(
        screen.getByTestId("value-row-your-eth-gets-sold-if-it-falls-below"),
      ).toHaveTextContent("$2,000.00");
    });

    it("repays, clearing the debt while keeping the collateral", () => {
      render(<BorrowView />);
      pledge("1");
      borrow("1000");

      submitForm("Repay", "Repay", "1000", "Repay");

      expect(useSimulationStore.getState().state.borrow.debtMicroUsd).toBe(0);
      expect(useSimulationStore.getState().state.borrow.collateralEth).toBe(toMicroUnits(1));
      expect(useSimulationStore.getState().state.balances.USDC).toBe(toMicroUnits(10_000));
    });

    it("will not hand back collateral a loan still needs", () => {
      render(<BorrowView />);
      pledge("1");
      borrow("1500");

      submitForm("Take back ETH", "Take back ETH", "1", "Take back ETH");

      expect(screen.getByText(/would leave your loan unsafe/)).toBeInTheDocument();
      expect(useSimulationStore.getState().state.borrow.collateralEth).toBe(toMicroUnits(1));
    });

    it("makes a mild fall change the position's health without selling anything", () => {
      render(<BorrowView />);
      pledge("1");
      borrow("1500");

      fireEvent.click(screen.getByRole("button", { name: "ETH falls 20%" }));

      expect(screen.getByTestId("position-health")).toHaveTextContent("Getting risky");
      expect(screen.queryByTestId("liquidation-notice")).not.toBeInTheDocument();
      expect(useSimulationStore.getState().state.borrow.collateralEth).toBe(toMicroUnits(1));
    });

    it("liquidates on a crash, and explains what happened in the user's numbers", () => {
      render(<BorrowView />);
      pledge("1");
      borrow("1500");

      fireEvent.click(screen.getByRole("button", { name: "ETH falls 40%" }));

      const notice = screen.getByTestId("liquidation-notice");
      expect(notice).toHaveTextContent("Your ETH was sold to repay your loan");
      expect(notice).toHaveTextContent("$1,800.00");
      expect(notice).toHaveTextContent("$1,500.00");
      expect(notice).toHaveTextContent("$300.00");

      const state = useSimulationStore.getState().state;
      expect(state.borrow).toEqual({ collateralEth: 0, debtMicroUsd: 0 });
      expect(state.balances.USDC).toBe(toMicroUnits(11_800));
    });

    it("still explains the liquidation when every last bit of ETH was pledged", () => {
      render(<BorrowView />);
      pledge("2");
      borrow("3000");

      fireEvent.click(screen.getByRole("button", { name: "ETH falls 40%" }));

      // The user now holds no ETH at all, but the explanation of what just
      // happened to it must not be replaced by the "you need ETH" state.
      expect(useSimulationStore.getState().state.balances.ETH).toBe(0);
      expect(screen.getByTestId("liquidation-notice")).toHaveTextContent(
        "Your ETH was sold to repay your loan",
      );
    });

    it("says plainly when the sale didn't cover the loan and debt is left over", () => {
      render(<BorrowView />);
      pledge("2");
      borrow("3000");

      // -20% is survivable; a further -40% leaves 2 ETH worth $2,880
      // against $3,000 of debt, so the sale can't cover it.
      fireEvent.click(screen.getByRole("button", { name: "ETH falls 20%" }));
      fireEvent.click(screen.getByRole("button", { name: "ETH falls 40%" }));

      const notice = screen.getByTestId("liquidation-notice");
      expect(notice).toHaveTextContent(/still owe/);
      expect(notice).not.toHaveTextContent(/your loan is cleared/);

      const state = useSimulationStore.getState().state;
      expect(state.borrow.collateralEth).toBe(0);
      expect(state.borrow.debtMicroUsd).toBeGreaterThan(0);

      // The leftover debt stays on screen rather than being replaced by the
      // "you need ETH first" state, and can still be repaid.
      expect(screen.getByTestId("borrow-headline")).toHaveTextContent(
        formatUsd(state.borrow.debtMicroUsd),
      );
      expect(screen.getByText(/left over after your ETH was sold/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Repay" })).toBeInTheDocument();
    });

    it("puts the simulated price back on reset", () => {
      render(<BorrowView />);
      pledge("1");
      fireEvent.click(screen.getByRole("button", { name: "ETH falls 40%" }));
      expect(useSimulationStore.getState().state.market.pricesMicroUsd.ETH).toBe(
        toMicroUnits(1_800),
      );

      fireEvent.click(screen.getByRole("button", { name: "Reset price" }));

      expect(useSimulationStore.getState().state.market.pricesMicroUsd.ETH).toBe(
        toMicroUnits(3_000),
      );
    });

    it("explains the safety buffer and liquidation a tap away", () => {
      render(<BorrowView />);

      const toggle = screen.getByRole("button", { name: /why can i only borrow part/i });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText(/called loan-to-value/)).not.toBeInTheDocument();

      fireEvent.click(toggle);
      expect(screen.getByText(/called loan-to-value/)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /what happens if eth falls/i }));
      expect(screen.getByText(/is called liquidation/)).toBeInTheDocument();
    });

    it("does not claim a price scenario changes ETH's price everywhere in the app, and doesn't imply debt itself shrinks", () => {
      render(<BorrowView />);

      expect(screen.queryByText(/everywhere in the app/)).not.toBeInTheDocument();
      expect(
        screen.getByText(/changes what your ETH is worth and how risky your loan is, not Swap's rate/),
      ).toBeInTheDocument();
    });

    it("discloses that Practice loans don't charge interest", () => {
      render(<BorrowView />);
      expect(
        screen.getByText("Practice loans don't charge interest. Real borrowing usually does."),
      ).toBeInTheDocument();
    });
  });
});
