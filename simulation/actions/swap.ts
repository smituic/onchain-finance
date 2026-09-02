import type { ActionResult, SimulationState, SwapAction } from "../types";
import { ASSETS } from "../assets";

/**
 * v0 swap: a fixed-rate conversion between two simulated assets' static
 * prices. Zero fee, zero slippage, zero price impact — those mechanics are
 * deliberately deferred to a later iteration. Output is floored, so a swap
 * can only ever lose rounding dust, never create value.
 */
export function applySwap(state: SimulationState, action: SwapAction): ActionResult {
  const { fromAsset, toAsset, amountIn } = action;

  const fromDefinition = ASSETS[fromAsset];
  const toDefinition = ASSETS[toAsset];
  if (!fromDefinition || !toDefinition) {
    return { ok: false, error: "Unknown asset.", code: "UNKNOWN_ASSET" };
  }

  if (fromAsset === toAsset) {
    return { ok: false, error: "Cannot swap an asset for itself.", code: "SAME_ASSET" };
  }

  if (!Number.isInteger(amountIn) || amountIn <= 0) {
    return {
      ok: false,
      error: "Swap amount must be a positive whole number of micro-units.",
      code: "INVALID_AMOUNT",
    };
  }

  const fromBalance = state.balances[fromAsset];
  if (amountIn > fromBalance) {
    return { ok: false, error: "Insufficient balance.", code: "INSUFFICIENT_BALANCE" };
  }

  const amountOut = computeSwapOutput(amountIn, fromDefinition.priceMicroUsd, toDefinition.priceMicroUsd);

  return {
    ok: true,
    state: {
      balances: {
        ...state.balances,
        [fromAsset]: fromBalance - amountIn,
        [toAsset]: state.balances[toAsset] + amountOut,
      },
    },
  };
}

/**
 * Uses BigInt for the multiply-then-divide so the intermediate value can't
 * exceed Number's safe integer range or pick up float error; the result is
 * converted back to Number since balances themselves stay well within it.
 */
function computeSwapOutput(amountIn: number, fromPriceMicroUsd: bigint, toPriceMicroUsd: bigint): number {
  const amountOutBig = (BigInt(amountIn) * fromPriceMicroUsd) / toPriceMicroUsd;
  return Number(amountOutBig);
}
