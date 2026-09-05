import { describe, expect, it } from "vitest";
import { applyAction, createInitialState, toMicroUnits } from "@/simulation";
import type { SwapAction } from "@/simulation";

describe("applyAction (swap)", () => {
  it("swaps USDC for ETH against the pool, at less than the reference price", () => {
    const state = createInitialState();
    const amountIn = toMicroUnits(10_000); // the user's full starting balance

    const result = applyAction(state, { type: "swap", fromAsset: "USDC", toAsset: "ETH", amountIn });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.balances.USDC).toBe(0);
    expect(result.state.balances.ETH).toBe(2_941_176);
    expect(result.swap).toEqual({
      amountOut: 2_941_176,
      referenceAmountOut: 3_333_333,
      referencePriceMicroUsd: 3_000_000_000,
      executionPriceMicroUsd: 3_400_000_544,
      priceImpactBps: 1_333,
    });
  });

  it("updates the pool's reserves in the direction of the trade", () => {
    const state = createInitialState();
    const amountIn = toMicroUnits(1_000);

    const result = applyAction(state, { type: "swap", fromAsset: "USDC", toAsset: "ETH", amountIn });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.pool.reserves.USDC).toBe(state.pool.reserves.USDC + amountIn);
    expect(result.state.pool.reserves.ETH).toBe(state.pool.reserves.ETH - result.swap!.amountOut);
  });

  it("swaps ETH back to USDC, below the reference price", () => {
    const state = { balances: { USDC: 0, ETH: toMicroUnits(1) }, pool: createInitialState().pool };
    const result = applyAction(state, { type: "swap", fromAsset: "ETH", toAsset: "USDC", amountIn: toMicroUnits(1) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.balances.USDC).toBe(2_884_615_384);
    expect(result.state.balances.ETH).toBe(0);
    expect(result.swap!.executionPriceMicroUsd).toBeLessThan(result.swap!.referencePriceMicroUsd);
    expect(result.swap!.priceImpactBps).toBeGreaterThan(0);
  });

  it("produces a larger price impact for a larger trade, in either direction", () => {
    const state = createInitialState();
    const small = applyAction(state, { type: "swap", fromAsset: "USDC", toAsset: "ETH", amountIn: toMicroUnits(100) });
    const large = applyAction(state, {
      type: "swap",
      fromAsset: "USDC",
      toAsset: "ETH",
      amountIn: toMicroUnits(10_000),
    });

    expect(small.ok).toBe(true);
    expect(large.ok).toBe(true);
    if (!small.ok || !large.ok) return;
    expect(large.swap!.priceImpactBps).toBeGreaterThan(small.swap!.priceImpactBps);
  });

  it("does not report spurious double-digit impact for a tiny (one-cent) trade", () => {
    const state = createInitialState();

    const usdcToEth = applyAction(state, {
      type: "swap",
      fromAsset: "USDC",
      toAsset: "ETH",
      amountIn: toMicroUnits(0.01),
    });
    expect(usdcToEth.ok).toBe(true);
    if (!usdcToEth.ok) return;
    expect(usdcToEth.swap!.priceImpactBps).toBe(0);

    const state2 = { balances: { USDC: 0, ETH: toMicroUnits(1) }, pool: createInitialState().pool };
    const ethToUsdc = applyAction(state2, {
      type: "swap",
      fromAsset: "ETH",
      toAsset: "USDC",
      amountIn: toMicroUnits(0.01),
    });
    expect(ethToUsdc.ok).toBe(true);
    if (!ethToUsdc.ok) return;
    expect(ethToUsdc.swap!.priceImpactBps).toBeLessThan(10); // well under 0.1%, not double digits
  });

  it("price impact increases monotonically from a tiny trade up to the user's full balance", () => {
    const state = createInitialState();
    const amounts = [0.01, 1, 10, 100, 1_000, 10_000];
    const impacts = amounts.map((usd) => {
      const result = applyAction(state, { type: "swap", fromAsset: "USDC", toAsset: "ETH", amountIn: toMicroUnits(usd) });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      return result.swap!.priceImpactBps;
    });

    expect(impacts).toEqual([0, 0, 1, 13, 133, 1_333]);
    for (let i = 1; i < impacts.length; i++) {
      expect(impacts[i]).toBeGreaterThanOrEqual(impacts[i - 1]);
    }
  });

  it("never lets a trade's execution price beat the pool's k invariant (reserves product never decreases)", () => {
    const state = createInitialState();
    const before = BigInt(state.pool.reserves.USDC) * BigInt(state.pool.reserves.ETH);

    const result = applyAction(state, {
      type: "swap",
      fromAsset: "USDC",
      toAsset: "ETH",
      amountIn: toMicroUnits(3_333.333333), // deliberately awkward amount
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = BigInt(result.state.pool.reserves.USDC) * BigInt(result.state.pool.reserves.ETH);
    expect(after >= before).toBe(true);
  });

  it("never returns more value than it started with on a round trip (rounding + price impact only ever lose value)", () => {
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

  it("rejects an amount too small to produce any output at current liquidity", () => {
    const state = createInitialState();
    const result = applyAction(state, { type: "swap", fromAsset: "USDC", toAsset: "ETH", amountIn: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_AMOUNT");
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
