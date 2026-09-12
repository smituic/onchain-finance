import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createExperimentState } from "@/lib/explore/experiment-state";
import { useExperimentSimulation } from "@/lib/explore/use-experiment-simulation";

describe("useExperimentSimulation", () => {
  it("starts from the experiment's deterministic fixture", () => {
    const { result } = renderHook(() => useExperimentSimulation("liquidation"));
    expect(result.current.state).toEqual(createExperimentState("liquidation"));
    expect(result.current.version).toBe(0);
  });

  it("dispatches through the real engine and updates state on success", () => {
    const { result } = renderHook(() => useExperimentSimulation("payments"));

    act(() => {
      const outcome = result.current.dispatch({
        type: "send-payment",
        contactId: "maya",
        amount: 25_000_000,
      });
      expect(outcome.ok).toBe(true);
    });

    expect(result.current.state.balances.USDC).toBe(100_000_000 - 25_000_000);
    expect(result.current.version).toBe(1);
  });

  it("leaves state and version untouched on a failed dispatch", () => {
    const { result } = renderHook(() => useExperimentSimulation("payments"));
    const before = result.current.state;

    act(() => {
      const outcome = result.current.dispatch({
        type: "send-payment",
        contactId: "maya",
        amount: 1_000_000_000, // far more cash than the $100 fixture holds
      });
      expect(outcome.ok).toBe(false);
    });

    expect(result.current.state).toBe(before);
    expect(result.current.version).toBe(0);
  });

  it("applies multiple dispatches in the same handler in order, not against a stale closure", () => {
    const { result } = renderHook(() => useExperimentSimulation("yield"));

    act(() => {
      for (let i = 0; i < 6; i++) {
        result.current.dispatch({ type: "advance-practice-time" });
      }
    });

    expect(result.current.version).toBe(6);
    // Six 30-day steps of 4%/yr interest, compounding once per step, on $1,000.
    expect(result.current.state.savings.balance).toBe(1_019_888_870);
  });

  it("reset recreates the exact starting fixture, byte-for-byte", () => {
    const { result } = renderHook(() => useExperimentSimulation("liquidity"));
    const initial = result.current.state;

    act(() => {
      result.current.dispatch({ type: "swap", fromAsset: "ETH", toAsset: "USDC", amountIn: 2_000_000 });
    });
    expect(result.current.state).not.toEqual(initial);

    act(() => {
      result.current.reset();
    });

    expect(result.current.state).toEqual(initial);
    expect(result.current.version).toBe(0);
  });
});
