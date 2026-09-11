import type { ActionResult, SimulationState, SwapAction, SwapReceipt } from "../types";
import { ASSETS } from "../assets";
import { DECIMALS } from "../money";
import { getPoolSpotPriceMicroUsd } from "../pool";

const SCALE = BigInt(10 ** DECIMALS);

// Fees are zero this slice. A future fee would shrink amountIn
// (amountInAfterFee = amountIn * (10_000 - feeBps) / 10_000) before it
// enters the constant-product formula below, and would accrue to the
// pool's reserves rather than being paid out — not built as a configurable
// parameter now since there's only one case (no fee) to support.

/**
 * Swap executed against a constant-product (x*y=k) simulated liquidity
 * pool — not a fixed rate. A trade's output depends on its size relative to
 * the pool's reserves: small trades land close to the pool's spot price,
 * large trades receive materially less value (or worse proceeds, selling)
 * than that spot price alone would suggest. See SwapReceipt for the numbers
 * returned so the UI can explain this without recomputing the math itself.
 * Fees are zero this slice. Output is floored, so a trade can only ever
 * lose rounding dust to the pool, never create value.
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

  const reserveInBefore = BigInt(state.pool.reserves[fromAsset]);
  const reserveOutBefore = BigInt(state.pool.reserves[toAsset]);
  const amountInBig = BigInt(amountIn);

  const referencePriceMicroUsd = getPoolSpotPriceMicroUsd(state.pool);

  const amountOutBig = (reserveOutBefore * amountInBig) / (reserveInBefore + amountInBig);
  const referenceAmountOutBig = (reserveOutBefore * amountInBig) / reserveInBefore;

  const amountOut = Number(amountOutBig);
  if (amountOut <= 0) {
    return {
      ok: false,
      error: "Swap amount is too small to produce any output at current liquidity.",
      code: "INVALID_AMOUNT",
    };
  }
  const referenceAmountOut = Number(referenceAmountOutBig);

  const usdcAmount = fromAsset === "USDC" ? amountIn : amountOut;
  const ethAmount = fromAsset === "ETH" ? amountIn : amountOut;
  const executionPriceMicroUsd = Number((BigInt(usdcAmount) * SCALE) / BigInt(ethAmount));

  // priceImpactBps is derived from the exact continuous constant-product
  // curve (reserves + amountIn only), not from the already-floored amountOut
  // or executionPriceMicroUsd above. For USDC/ETH with zero fees, the
  // fractional gap between a trade's average execution price and the
  // pre-trade USDC-per-ETH spot price reduces to a closed form:
  //   buying ETH (USDC -> ETH):  amountIn / reserveUSDC
  //   selling ETH (ETH -> USDC): amountIn / (reserveETH + amountIn)
  // Computing it this way keeps it exact and monotonic even for trades so
  // small that amountOut floors to a tiny integer, where dividing through
  // that rounded output would otherwise amplify noise into a spurious
  // double-digit "impact" for a trade that barely moves the price at all.
  const priceImpactBpsBig =
    fromAsset === "USDC"
      ? (amountInBig * BigInt(10_000)) / reserveInBefore
      : (amountInBig * BigInt(10_000)) / (reserveInBefore + amountInBig);
  const priceImpactBps = Number(priceImpactBpsBig);

  const swap: SwapReceipt = {
    amountOut,
    referenceAmountOut,
    referencePriceMicroUsd,
    executionPriceMicroUsd,
    priceImpactBps,
  };

  return {
    ok: true,
    state: {
      ...state,
      balances: {
        ...state.balances,
        [fromAsset]: fromBalance - amountIn,
        [toAsset]: state.balances[toAsset] + amountOut,
      },
      pool: {
        reserves: {
          ...state.pool.reserves,
          [fromAsset]: Number(reserveInBefore + amountInBig),
          [toAsset]: Number(reserveOutBefore - amountOutBig),
        },
      },
    },
    swap,
  };
}
