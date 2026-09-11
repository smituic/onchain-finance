import type { AssetId, SimulationState } from "./types";
import { ASSETS } from "./assets";
import { DECIMALS } from "./money";

const SCALE = BigInt(10 ** DECIMALS);

/**
 * Value of a single asset's balance, in micro-USD, at its fixed simulated
 * price. Lives here rather than in the presentation layer so no component
 * has to multiply a balance by a price itself.
 */
export function getAssetValueMicroUsd(state: SimulationState, assetId: AssetId): number {
  const balance = BigInt(state.balances[assetId]);
  return Number((balance * ASSETS[assetId].priceMicroUsd) / SCALE);
}

/**
 * Total portfolio value across every asset, in micro-USD, using each
 * asset's fixed simulated price. Same BigInt multiply-then-divide pattern
 * as the swap action, for the same overflow/precision reasons.
 */
/**
 * Everything the user has, in micro-USD: assets held plus the savings
 * position. This is the number Home leads with. Moving money between Cash
 * and savings can't change it — Cash is USDC at exactly $1 — so only
 * interest and swap price impact ever move this total.
 */
export function getTotalBalanceMicroUsd(state: SimulationState): number {
  return getPortfolioValueMicroUsd(state) + state.savings.balance;
}

export function getPortfolioValueMicroUsd(state: SimulationState): number {
  const totalMicroUsd = (Object.keys(state.balances) as AssetId[]).reduce((sum, assetId) => {
    const balance = BigInt(state.balances[assetId]);
    const priceMicroUsd = ASSETS[assetId].priceMicroUsd;
    return sum + (balance * priceMicroUsd) / SCALE;
  }, BigInt(0));

  return Number(totalMicroUsd);
}
