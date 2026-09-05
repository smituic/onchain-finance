import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { SwapForm } from "@/components/swap/swap-form";
import { useSimulationStore } from "@/lib/stores/simulation-store";
import { createInitialState, toMicroUnits } from "@/simulation";

describe("SwapForm", () => {
  beforeEach(async () => {
    localStorage.clear();
    useSimulationStore.setState({ state: createInitialState() });
    await act(async () => {
      await useSimulationStore.persist.rehydrate();
    });
  });

  it("shows a rate preview and its price impact for a valid amount", () => {
    render(<SwapForm />);
    fireEvent.change(screen.getByLabelText("From USDC"), { target: { value: "3000" } });

    expect(screen.getByText(/You'll receive/)).toHaveTextContent("You'll receive ≈ 0.961538 ETH");
    expect(screen.getByText(/reference price you'd expect/)).toHaveTextContent(
      'At today\'s reference price you\'d expect ≈ 1 ETH. This trade is large enough relative to available liquidity to move the price by 4.00% (its "price impact").',
    );
  });

  it("submits a swap and updates balances immediately", () => {
    render(<SwapForm />);
    fireEvent.change(screen.getByLabelText("From USDC"), { target: { value: "3000" } });
    fireEvent.click(screen.getByRole("button", { name: "Swap" }));

    expect(useSimulationStore.getState().state.balances.ETH).toBe(961_538);
    expect(useSimulationStore.getState().state.balances.USDC).toBe(toMicroUnits(7_000));
    expect(screen.getByText(/Swapped successfully/)).toBeInTheDocument();
  });

  it("shows the engine's error for an amount exceeding balance and leaves state unchanged", () => {
    render(<SwapForm />);
    const before = useSimulationStore.getState().state;

    fireEvent.change(screen.getByLabelText("From USDC"), { target: { value: "50000" } });

    expect(screen.getByText("Insufficient balance.")).toBeInTheDocument();
    expect(useSimulationStore.getState().state).toEqual(before);
  });
});
