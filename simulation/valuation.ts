import type { AssetId, SimulationState } from "./types";
import { DECIMALS } from "./money";
import { getPriceMicroUsd } from "./market";
import { getCollateralValueMicroUsd } from "./borrow";
import { getInvestmentPortfolioValueMicroUsd } from "./investments";

const SCALE = BigInt(10 ** DECIMALS);

/**
 * Value of a single asset's spendable balance, in micro-USD, at its current
 * simulated market price. Lives here rather than in the presentation layer
 * so no component has to multiply a balance by a price itself.
 *
 * Note this covers the balance the user can freely spend; ETH pledged as
 * loan collateral is counted by getCryptoValueMicroUsd below.
 */
export function getAssetValueMicroUsd(state: SimulationState, assetId: AssetId): number {
  const balance = BigInt(state.balances[assetId]);
  const price = BigInt(getPriceMicroUsd(state, assetId));
  return Number((balance * price) / SCALE);
}

/**
 * Total value of spendable balances across every asset, in micro-USD.
 * Excludes savings and pledged collateral. Same BigInt
 * multiply-then-divide pattern as the swap action, for the same
 * overflow/precision reasons.
 */
export function getPortfolioValueMicroUsd(state: SimulationState): number {
  const totalMicroUsd = (Object.keys(state.balances) as AssetId[]).reduce((sum, assetId) => {
    const balance = BigInt(state.balances[assetId]);
    const price = BigInt(getPriceMicroUsd(state, assetId));
    return sum + (balance * price) / SCALE;
  }, BigInt(0));

  return Number(totalMicroUsd);
}

/**
 * All the crypto the user owns, held or pledged. Collateral is still
 * theirs — it's committed to a loan, not sold — so Home counts it here and
 * shows what's owed against it as a separate liability.
 */
export function getCryptoValueMicroUsd(state: SimulationState): number {
  return getAssetValueMicroUsd(state, "ETH") + getCollateralValueMicroUsd(state);
}

/**
 * What the user is actually worth: everything they hold — spendable
 * balances, savings, curated investments, and pledged collateral — minus
 * what they owe.
 *
 * Borrowing hands the user Cash and an equal debt, so it can't move this
 * number; neither can moving Cash into savings, nor repaying a loan, nor
 * buying or selling a curated investment at its current price (both settle
 * cash and holding value by the exact same executed amount — see
 * investments.ts). Only interest earned, swap price impact, and changes in
 * the market price of what they hold do.
 */
export function getNetWorthMicroUsd(state: SimulationState): number {
  return (
    getPortfolioValueMicroUsd(state) +
    state.savings.balance +
    getCollateralValueMicroUsd(state) +
    getInvestmentPortfolioValueMicroUsd(state) -
    state.borrow.debtMicroUsd
  );
}
