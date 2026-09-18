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
    expect(screen.getByRole("button", { name: "Move to savings" })).toBeInTheDocument();
    expect(screen.getByText("Where does the interest come from?")).toBeInTheDocument();
  });

  it("renders Invest with the curated universe and its primary action", () => {
    render(<InvestPage />);
    expect(screen.getByRole("heading", { name: "Invest" })).toBeInTheDocument();
    expect(screen.getByTestId("asset-BTC")).toHaveTextContent("Bitcoin");
    expect(screen.getByTestId("asset-BROAD")).toHaveTextContent("U.S. Stock Market");
    expect(screen.getByTestId("asset-TBILL")).toHaveTextContent("Short-Term Treasuries");
  });

  it("renders Borrow, pointing a user with no ETH at Swap", () => {
    render(<BorrowPage />);
    expect(screen.getByRole("heading", { name: "Borrow" })).toBeInTheDocument();
    expect(screen.getByText("You need ETH first")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Get some ETH in Swap" })).toHaveAttribute(
      "href",
      "/swap",
    );
  });

  it("renders Explore's experiments as entry points, not lessons", () => {
    render(<ExplorePage />);
    expect(screen.getByRole("heading", { name: "Explore" })).toBeInTheDocument();

    const expected: [string, string][] = [
      ["You own $30,000 of ETH. Can you sell it for $30,000?", "/explore/liquidity"],
      ["What happens if ETH falls?", "/explore/liquidation"],
      ["What does a 4% annual rate look like over time?", "/explore/yield"],
      ["Why not put everything in whatever grows fastest?", "/explore/risk"],
      ["What actually happens when you send money?", "/explore/payments"],
    ];
    for (const [question, href] of expected) {
      expect(screen.getByRole("link", { name: new RegExp(question.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) })).toHaveAttribute(
        "href",
        href,
      );
    }
  });

  it("renders Swap inside the shell with its trading behaviour intact", () => {
    render(<SwapPage />);
    expect(screen.getByRole("heading", { name: "Swap" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("From Cash"), { target: { value: "3000" } });
    expect(screen.getByText(/You'll receive/)).toHaveTextContent("You'll receive ≈ 0.961538 ETH");

    fireEvent.click(screen.getByRole("button", { name: "Swap" }));
    expect(useSimulationStore.getState().state.balances.ETH).toBe(961_538);
  });
});
