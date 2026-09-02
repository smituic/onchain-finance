import { describe, expect, it } from "vitest";
import { applyAction, createInitialState, toMicroUnits } from "@/simulation";
import type { SimulationState, SwapAction } from "@/simulation";

describe("applyAction (swap)", () => {
  it("swaps USDC for ETH at the fixed rate", () => {
    const state = createInitialState();
    const amountIn = toMicroUnits(3_000); // $3,000
    const result = applyAction(state, { type: "swap", fromAsset: "USDC", toAsset: "ETH", amountIn });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.balances.USDC).toBe(state.balances.USDC - amountIn);
    expect(result.state.balances.ETH).toBe(toMicroUnits(1)); // $3,000 / $3,000 per ETH = 1 ETH
  });

  it("swaps ETH back to USDC", () => {
    const state: SimulationState = { balances: { USDC: 0, ETH: toMicroUnits(1) } };
    const result = applyAction(state, { type: "swap", fromAsset: "ETH", toAsset: "USDC", amountIn: toMicroUnits(1) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.balances.USDC).toBe(toMicroUnits(3_000));
    expect(result.state.balances.ETH).toBe(0);
  });

  it("never returns more value than it started with on a round trip (rounding only ever loses dust)", () => {
    const state = createInitialState();
    const amountIn = toMicroUnits(3_333.333333); // deliberately awkward amount
    const toEth = applyAction(state, { type: "swap", fromAsset: "USDC", toAsset: "ETH", amountIn });
    expect(toEth.ok).toBe(true);
    if (!toEth.ok) return;

    const ethBalance = toEth.state.balances.ETH;
    const back = applyAction(toEth.state, { type: "swap", fromAsset: "ETH", toAsset: "USDC", amountIn: ethBalance });
    expect(back.ok).toBe(true);
    if (!back.ok) return;

    expect(back.state.balances.USDC).toBeLessThanOrEqual(state.balances.USDC);
  });

  it("rejects insufficient balance and leaves state untouched", () => {
    const state = createInitialState();
    const result = applyAction(state, {
      type: "swap",
      fromAsset: "USDC",
      toAsset: "ETH",
      amountIn: state.balances.USDC + 1,
    });

    expect(result).toEqual({ ok: false, error: expect.any(String), code: "INSUFFICIENT_BALANCE" });
    expect(state).toEqual(createInitialState());
  });

  it("rejects swapping an asset for itself", () => {
    const state = createInitialState();
    const result = applyAction(state, { type: "swap", fromAsset: "USDC", toAsset: "USDC", amountIn: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("SAME_ASSET");
  });

  it("rejects zero and negative amounts", () => {
    const state = createInitialState();
    for (const amountIn of [0, -1]) {
      const result = applyAction(state, { type: "swap", fromAsset: "USDC", toAsset: "ETH", amountIn });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("INVALID_AMOUNT");
    }
  });

  it("rejects unknown assets", () => {
    const state = createInitialState();
    const badAction = { type: "swap", fromAsset: "DOGE", toAsset: "ETH", amountIn: 1 } as unknown as SwapAction;
    const result = applyAction(state, badAction);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNKNOWN_ASSET");
  });

  it("is pure: does not mutate the input state and is deterministic", () => {
    const state = createInitialState();
    const originalBalances = { ...state.balances };
    const action: SwapAction = { type: "swap", fromAsset: "USDC", toAsset: "ETH", amountIn: toMicroUnits(100) };

    const first = applyAction(state, action);
    const second = applyAction(state, action);

    expect(state.balances).toEqual(originalBalances);
    expect(first).toEqual(second);
  });
});
