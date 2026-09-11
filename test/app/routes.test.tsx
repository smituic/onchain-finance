import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import HomePage from "@/app/page";
import PayPage from "@/app/pay/page";
import SavePage from "@/app/save/page";
import InvestPage from "@/app/invest/page";
import SwapPage from "@/app/swap/page";
import BorrowPage from "@/app/borrow/page";
import ExplorePage from "@/app/explore/page";
import { useSimulationStore } from "@/lib/stores/simulation-store";
import { createInitialState } from "@/simulation";

describe("product routes", () => {
  beforeEach(async () => {
    localStorage.clear();
    useSimulationStore.setState({ state: createInitialState() });
    await act(async () => {
      await useSimulationStore.persist.rehydrate();
    });
  });

  it("renders Home", () => {
    render(<HomePage />);
    expect(screen.getByText("Total balance")).toBeInTheDocument();
  });

  it("renders Pay with its primary action", () => {
    render(<PayPage />);
    expect(screen.getByRole("heading", { name: "Pay" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send money" })).toBeInTheDocument();
  });

  it("renders Save with its primary action and where-interest-comes-from explanation", () => {
    render(<SavePage />);
    expect(screen.getByRole("heading", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add money" })).toBeInTheDocument();
    expect(screen.getByText("Where does the interest come from?")).toBeInTheDocument();
  });

  it("renders Invest with its primary action and curated categories", () => {
    render(<InvestPage />);
    expect(screen.getByRole("heading", { name: "Invest" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Browse investments" })).toBeInTheDocument();
    expect(screen.getByText("Crypto")).toBeInTheDocument();
    expect(screen.getByText("Broad market")).toBeInTheDocument();
  });

  it("renders Borrow with its primary action", () => {
    render(<BorrowPage />);
    expect(screen.getByRole("heading", { name: "Borrow" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Borrow money" })).toBeInTheDocument();
  });

  it("renders Explore's experiments as entry points, not lessons", () => {
    render(<ExplorePage />);
    expect(screen.getByRole("heading", { name: "Explore" })).toBeInTheDocument();
    expect(screen.getByText("Why do large trades move prices?")).toBeInTheDocument();
    expect(screen.getByText("What happens if ETH falls 40%?")).toBeInTheDocument();
    expect(screen.getByText("Where does lending yield come from?")).toBeInTheDocument();
    expect(screen.getByText("Why can a valuable token still be hard to sell?")).toBeInTheDocument();
  });

  it("renders Swap inside the shell with its trading behaviour intact", () => {
    render(<SwapPage />);
    expect(screen.getByRole("heading", { name: "Swap" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("From USDC"), { target: { value: "3000" } });
    expect(screen.getByText(/You'll receive/)).toHaveTextContent("You'll receive ≈ 0.961538 ETH");

    fireEvent.click(screen.getByRole("button", { name: "Swap" }));
    expect(useSimulationStore.getState().state.balances.ETH).toBe(961_538);
  });
});
