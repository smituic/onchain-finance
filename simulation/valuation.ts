import type { AssetId, SimulationState } from "./types";
import { ASSETS } from "./assets";
import { DECIMALS } from "./money";

const SCALE = BigInt(10 ** DECIMALS);

/**
 * Total portfolio value across every asset, in micro-USD, using each
 * asset's fixed simulated price. Same BigInt multiply-then-divide pattern
 * as the swap action, for the same overflow/precision reasons.
 */
export function getPortfolioValueMicroUsd(state: SimulationState): number {
  const totalMicroUsd = (Object.keys(state.balances) as AssetId[]).reduce((sum, assetId) => {
    const balance = BigInt(state.balances[assetId]);
    const priceMicroUsd = ASSETS[assetId].priceMicroUsd;
    return sum + (balance * priceMicroUsd) / SCALE;
  }, BigInt(0));

  return Number(totalMicroUsd);
}
