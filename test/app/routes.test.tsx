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
import { useModeStore } from "@/lib/stores/mode-store";
import { createInitialState } from "@/simulation";

describe("product routes", () => {
  beforeEach(async () => {
    localStorage.clear();
    useSimulationStore.setState({ state: createInitialState() });
    // Practice, as a build without Real Mode configured would be.
    useModeStore.setState({ mode: "practice", realModeEnabled: false, hasAcknowledgedRealIntro: false, hasHydrated: false });
    await act(async () => {
      await useModeStore.persist.rehydrate();
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

  describe("in Real Mode", () => {
    beforeEach(() => {
      useModeStore.setState({ mode: "real", realModeEnabled: true, hasAcknowledgedRealIntro: true, hasHydrated: true });
    });

    it("renders the Real Home placeholder, with no Practice balances and nothing invented", () => {
      render(<HomePage />);

      expect(screen.getByTestId("real-home")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Your real account isn't set up yet" })).toBeInTheDocument();
      expect(screen.getByText(/test network/)).toBeInTheDocument();
      expect(screen.queryByText("Total balance")).not.toBeInTheDocument();
      expect(screen.queryByTestId("total-balance")).not.toBeInTheDocument();
      expect(screen.queryByText(/\$10,000\.00/)).not.toBeInTheDocument();
    });

    it("renders the Real Pay placeholder without Practice contacts, balance, or activity", () => {
      render(<PayPage />);

      expect(screen.getByTestId("real-pay")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Real Pay is next" })).toBeInTheDocument();
      expect(screen.getByText("Testnet only")).toBeInTheDocument();
      expect(screen.queryByTestId("pay-cash-headline")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Send money" })).not.toBeInTheDocument();
      expect(screen.queryByText("Maya Chen")).not.toBeInTheDocument();
    });

    it.each([
      ["Save", SavePage, "Move to savings"],
      ["Invest", InvestPage, "Buy"],
      ["Swap", SwapPage, "Swap"],
      ["Borrow", BorrowPage, "Get some ETH in Swap"],
    ] as const)("renders %s as Practice-only, without its Practice controls", (label, Page, practiceControl) => {
      render(<Page />);

      expect(screen.getByRole("heading", { name: label })).toBeInTheDocument();
      expect(screen.getByText(`${label} is Practice-only for now.`)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Try it in Practice" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: practiceControl })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: practiceControl })).not.toBeInTheDocument();
    });

    it("'Try it in Practice' leaves the user on the same area, now in Practice", () => {
      render(<SavePage />);

      fireEvent.click(screen.getByRole("button", { name: "Try it in Practice" }));

      expect(useModeStore.getState().mode).toBe("practice");
      expect(screen.getByRole("button", { name: "Move to savings" })).toBeInTheDocument();
      expect(screen.queryByText("Save is Practice-only for now.")).not.toBeInTheDocument();
    });

    it("keeps Explore as the same Practice sandbox and says so", () => {
      render(<ExplorePage />);

      expect(screen.getByRole("heading", { name: "Explore" })).toBeInTheDocument();
      expect(screen.getByText(/Explore always uses its own separate Practice money/)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /What happens if ETH falls\?/ })).toBeInTheDocument();
    });
  });

  it("does not mention Real Mode on Explore while in Practice", () => {
    render(<ExplorePage />);
    expect(screen.queryByText(/Explore always uses its own separate Practice money/)).not.toBeInTheDocument();
  });
});
