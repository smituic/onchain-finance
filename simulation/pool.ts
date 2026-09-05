import type { AssetId, PoolState } from "./types";
import { DECIMALS, toMicroUnits } from "./money";

const SCALE = BigInt(10 ** DECIMALS);

/**
 * Genesis reserves for the USDC/ETH pool: 75,000 USDC / 25 ETH — exactly
 * $3,000/ETH at the pool's marginal price, matching the reference price
 * shown before any swap. Sized so a small trade (~$100) barely moves the
 * price, while a trade at the full $10,000 starting balance shows a clearly
 * noticeable (~12%) shortfall versus that reference price — the discovery
 * this slice is meant to produce.
 */
export function createInitialPoolReserves(): Record<AssetId, number> {
  return {
    USDC: toMicroUnits(75_000),
    ETH: toMicroUnits(25),
  };
}

/**
 * The pool's current marginal USD price of 1 whole ETH, derived from
 * reserves. Valid only because USDC is pegged $1 and is the pool's other
 * asset — this numeraire trick doesn't generalize to a non-stable pair
 * without rework, which is fine while USDC/ETH is the only pair.
 */
export function getPoolSpotPriceMicroUsd(pool: PoolState): number {
  const usdcReserve = BigInt(pool.reserves.USDC);
  const ethReserve = BigInt(pool.reserves.ETH);
  return Number((usdcReserve * SCALE) / ethReserve);
}
