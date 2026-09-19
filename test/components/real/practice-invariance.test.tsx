import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import HomePage from "@/app/page";
import PayPage from "@/app/pay/page";
import SavePage from "@/app/save/page";
import InvestPage from "@/app/invest/page";
import SwapPage from "@/app/swap/page";
import BorrowPage from "@/app/borrow/page";
import ExplorePage from "@/app/explore/page";
import { ModeSwitch } from "@/components/shell/mode-switch";
import { SIMULATION_STORE_NAME, useSimulationStore } from "@/lib/stores/simulation-store";
import { useModeStore } from "@/lib/stores/mode-store";
import { createInitialState, toMicroUnits, type SimulationState } from "@/simulation";

/**
 * A deliberately non-default Practice portfolio, so this proves Real Mode
 * leaves a real user's money alone — not just an untouched default store.
 */
function buildNonDefaultMainState(): SimulationState {
  const base = createInitialState(1_700_000_000_000);
  return {
    ...base,
    balances: { ...base.balances, USDC: toMicroUnits(500), ETH: toMicroUnits(3) },
    savings: { balance: toMicroUnits(2_000), interestEarnedTotal: toMicroUnits(50), lastAccruedAt: 1_700_000_000_000 },
    borrow: { collateralEth: toMicroUnits(1), debtMicroUsd: toMicroUnits(1_000) },
  };
}

const PAGES: [string, () => React.JSX.Element][] = [
  ["Home", HomePage],
  ["Pay", PayPage],
  ["Save", SavePage],
  ["Invest", InvestPage],
  ["Swap", SwapPage],
  ["Borrow", BorrowPage],
  ["Explore", ExplorePage],
];

describe("Real Mode never touches Practice financial state", () => {
  let mainState: SimulationState;
  let storedBefore: string | null;

  beforeEach(() => {
    localStorage.clear();
    mainState = buildNonDefaultMainState();
    useSimulationStore.setState({ state: mainState, hasHydrated: true });
    // Persist once so a later, unexpected write would show up as a change.
    localStorage.setItem(SIMULATION_STORE_NAME, JSON.stringify({ state: { state: mainState }, version: 5 }));
    storedBefore = localStorage.getItem(SIMULATION_STORE_NAME);
    useModeStore.setState({ mode: "real", realModeEnabled: true, hasAcknowledgedRealIntro: true, hasHydrated: true });
  });

  function expectPracticeUntouched() {
    // Reference equality: the store's `set()` was never called at all.
    expect(useSimulationStore.getState().state).toBe(mainState);
    expect(useSimulationStore.getState().state).toEqual(mainState);
    expect(localStorage.getItem(SIMULATION_STORE_NAME)).toBe(storedBefore);
  }

  it.each(PAGES)("%s in Real Mode, with every control pressed", (_name, Page) => {
    render(<Page />);

    // Every button a Real Mode screen offers (some offer none) — including
    // "Try it in Practice", which flips mode but must not touch money.
    for (const button of screen.queryAllByRole("button")) {
      fireEvent.click(button);
    }

    expectPracticeUntouched();
  });

  it("switching Practice → Real (through the intro) → Practice → Real", () => {
    useModeStore.setState({ mode: "practice", hasAcknowledgedRealIntro: false });
    render(<ModeSwitch />);

    fireEvent.click(screen.getByRole("button", { name: "Real" }));
    fireEvent.click(screen.getByRole("button", { name: "Stay in Practice" }));
    fireEvent.click(screen.getByRole("button", { name: "Real" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to Real Mode" }));
    fireEvent.click(screen.getByRole("button", { name: "Practice" }));
    fireEvent.click(screen.getByRole("button", { name: "Real" }));

    expect(useModeStore.getState().mode).toBe("real");
    expectPracticeUntouched();
  });

  it("Practice pages render the same numbers after a round-trip through Real Mode", () => {
    const { unmount } = render(<HomePage />);
    expect(screen.getByTestId("real-home")).toBeInTheDocument();
    unmount();

    useModeStore.getState().setMode("practice");
    render(<HomePage />);

    expect(screen.getByTestId("value-row-cash")).toHaveTextContent("$500.00");
    expect(screen.getByTestId("value-row-savings")).toHaveTextContent("$2,000.00");
    expect(screen.getByTestId("value-row-borrowed")).toHaveTextContent("−$1,000.00");
    expectPracticeUntouched();
  });
});
