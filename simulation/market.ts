import type { AssetId, MarketState, SimulationState } from "./types";
import { ASSETS } from "./assets";

const BPS_DIVISOR = BigInt(10_000);

/**
 * The simulated market (reference) price of each asset, seeded from the
 * genesis prices in assets.ts.
 *
 * This is the simulation's *valuation* price — what an asset is considered
 * to be worth — and it's deliberately distinct from the swap pool's spot
 * price in pool.ts, which is an *execution* price derived from reserves.
 * Real systems draw the same line (an oracle price for valuation and
 * collateral, a pool price for filling trades), and keeping them separate
 * is what lets a Borrow crash scenario re-price collateral without
 * secretly trading against the pool or moving its liquidity.
 */
export function createInitialMarketState(): MarketState {
  return {
    pricesMicroUsd: {
      USDC: Number(ASSETS.USDC.priceMicroUsd),
      ETH: Number(ASSETS.ETH.priceMicroUsd),
    },
  };
}

/** The asset's current simulated market price, in micro-USD per whole unit. */
export function getPriceMicroUsd(state: SimulationState, assetId: AssetId): number {
  return state.market.pricesMicroUsd[assetId];
}

/** The price an asset started at — what "reset" returns it to. */
export function getGenesisPriceMicroUsd(assetId: AssetId): number {
  return Number(ASSETS[assetId].priceMicroUsd);
}

/**
 * Moves a price by a relative amount in basis points (-4_000 = a 40% fall),
 * floored, and never all the way to zero — a worthless asset would make
 * ratios against it undefined.
 */
export function applyRelativePriceChange(priceMicroUsd: number, changeBps: number): number {
  const next = (BigInt(priceMicroUsd) * BigInt(10_000 + changeBps)) / BPS_DIVISOR;
  return next > BigInt(0) ? Number(next) : 1;
}
