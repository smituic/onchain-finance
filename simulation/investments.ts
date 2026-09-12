import type { InvestmentAssetId, InvestmentMarketState, InvestState, SimulationState } from "./types";
import { DECIMALS } from "./money";
import { applyRelativePriceChange } from "./market";

const SCALE = BigInt(10 ** DECIMALS);

export type InvestmentCategory = "Crypto" | "Treasuries" | "Stocks";
export type InvestmentRiskLevel = "lower" | "medium" | "higher";

export type InvestmentAssetDefinition = {
  id: InvestmentAssetId;
  name: string;
  category: InvestmentCategory;
  description: string;
  riskLevel: InvestmentRiskLevel;
  riskCopy: string;
  /** Short, plain-language label for one whole unit, e.g. "shares", "BTC". */
  unitLabel: string;
  /**
   * Fixed simulated price in micro-USD per whole unit, seeding
   * `InvestmentMarketState` and the "reset prices" scenario. BigInt for the
   * same reason as ASSETS in assets.ts: safe multiplication without binary
   * float error.
   */
  initialPriceMicroUsd: bigint;
};

/**
 * The curated Practice Mode investment universe — deliberately three
 * assets, not a token list, chosen to teach different risk/volatility
 * profiles. A separate namespace from AssetId (see types.ts): none of these
 * are spendable balances or enter the swap pool, and Bitcoin here is a
 * distinct curated investment product from ETH acquired in Swap.
 */
export const INVESTMENT_ASSETS: Record<InvestmentAssetId, InvestmentAssetDefinition> = {
  BTC: {
    id: "BTC",
    name: "Bitcoin",
    category: "Crypto",
    description: "The original cryptocurrency — a digital asset with a fixed, limited supply.",
    riskLevel: "higher",
    riskCopy: "Higher risk. Prices can swing sharply, in either direction, over short periods.",
    unitLabel: "BTC",
    initialPriceMicroUsd: BigInt(60_000_000_000),
  },
  BROAD: {
    id: "BROAD",
    name: "U.S. Stock Market",
    category: "Stocks",
    description: "One fund that spreads your money across many U.S. companies at once.",
    riskLevel: "medium",
    riskCopy: "Medium risk. Moves with the broader stock market — calmer than crypto, livelier than cash.",
    unitLabel: "shares",
    initialPriceMicroUsd: BigInt(500_000_000),
  },
  TBILL: {
    id: "TBILL",
    name: "Short-Term Treasuries",
    category: "Treasuries",
    description: "Short-term lending to the U.S. government — a stable, low-risk place to park money.",
    riskLevel: "lower",
    riskCopy: "Lower risk. Built to hold its value; it barely moves even when markets are volatile.",
    unitLabel: "T-bills",
    initialPriceMicroUsd: BigInt(100_000_000),
  },
};

export const INVESTMENT_ASSET_IDS = Object.keys(INVESTMENT_ASSETS) as InvestmentAssetId[];

/**
 * How far each curated investment's price moves in one Practice Mode
 * market scenario, in basis points. Direction (up/down) is applied by the
 * caller via applyRelativePriceChange. Deliberately different per asset so
 * a single "market rises/falls" scenario still teaches that risk levels
 * aren't interchangeable: Bitcoin moves the most, the broad-market fund a
 * moderate amount, Treasuries barely at all.
 */
export const INVESTMENT_MARKET_MOVE_BPS: Record<InvestmentAssetId, number> = {
  BTC: 2_500,
  BROAD: 1_000,
  TBILL: 100,
};

function createInitialHolding() {
  return { unitsHeld: 0, costBasisMicroUsd: 0 };
}

/** A new user's curated portfolio: nothing bought yet. */
export function createInitialInvestState(): InvestState {
  return {
    holdings: {
      BTC: createInitialHolding(),
      BROAD: createInitialHolding(),
      TBILL: createInitialHolding(),
    },
  };
}

/** Seeds each curated investment's simulated market price from the registry. */
export function createInitialInvestmentMarketState(): InvestmentMarketState {
  return {
    pricesMicroUsd: {
      BTC: Number(INVESTMENT_ASSETS.BTC.initialPriceMicroUsd),
      BROAD: Number(INVESTMENT_ASSETS.BROAD.initialPriceMicroUsd),
      TBILL: Number(INVESTMENT_ASSETS.TBILL.initialPriceMicroUsd),
    },
  };
}

/** A curated investment's current simulated market price, in micro-USD per whole unit. */
export function getInvestmentPriceMicroUsd(state: SimulationState, assetId: InvestmentAssetId): number {
  return state.investmentMarket.pricesMicroUsd[assetId];
}

/** The price a curated investment started at — what "reset prices" returns it to. */
export function getGenesisInvestmentPriceMicroUsd(assetId: InvestmentAssetId): number {
  return Number(INVESTMENT_ASSETS[assetId].initialPriceMicroUsd);
}

/** Moves every curated investment's price by its own scenario magnitude, in one direction. */
export function applyInvestmentMarketMove(
  state: SimulationState,
  direction: "up" | "down",
): SimulationState {
  const sign = direction === "up" ? 1 : -1;
  const nextPrices = { ...state.investmentMarket.pricesMicroUsd };
  for (const assetId of INVESTMENT_ASSET_IDS) {
    const changeBps = sign * INVESTMENT_MARKET_MOVE_BPS[assetId];
    nextPrices[assetId] = applyRelativePriceChange(nextPrices[assetId], changeBps);
  }
  return { ...state, investmentMarket: { pricesMicroUsd: nextPrices } };
}

/** Restores every curated investment's simulated price to where it started. */
export function resetInvestmentPrices(state: SimulationState): SimulationState {
  return { ...state, investmentMarket: createInitialInvestmentMarketState() };
}

/** Everything the UI needs about one holding, with no valuation math left to do. */
export type InvestmentHolding = {
  assetId: InvestmentAssetId;
  unitsHeld: number;
  costBasisMicroUsd: number;
  currentValueMicroUsd: number;
  unrealizedGainMicroUsd: number;
  /** Gain as a share of cost basis, in bps. 0 when nothing is invested. */
  unrealizedGainBps: number;
};

/**
 * A single holding's value and return, derived from state — never stored,
 * so it can't drift out of sync with the current investment-market price.
 */
export function getInvestmentHolding(
  state: SimulationState,
  assetId: InvestmentAssetId,
): InvestmentHolding {
  const holding = state.invest.holdings[assetId];
  const price = getInvestmentPriceMicroUsd(state, assetId);
  const currentValueMicroUsd = Number((BigInt(holding.unitsHeld) * BigInt(price)) / SCALE);
  const unrealizedGainMicroUsd = currentValueMicroUsd - holding.costBasisMicroUsd;
  const unrealizedGainBps =
    holding.costBasisMicroUsd > 0
      ? Number((BigInt(unrealizedGainMicroUsd) * BigInt(10_000)) / BigInt(holding.costBasisMicroUsd))
      : 0;

  return {
    assetId,
    unitsHeld: holding.unitsHeld,
    costBasisMicroUsd: holding.costBasisMicroUsd,
    currentValueMicroUsd,
    unrealizedGainMicroUsd,
    unrealizedGainBps,
  };
}

/** Every curated holding, in registry order. */
export function getInvestmentHoldings(state: SimulationState): InvestmentHolding[] {
  return INVESTMENT_ASSET_IDS.map((assetId) => getInvestmentHolding(state, assetId));
}

export type InvestPortfolio = {
  totalValueMicroUsd: number;
  totalCostBasisMicroUsd: number;
  totalUnrealizedGainMicroUsd: number;
  totalUnrealizedGainBps: number;
};

/** The whole curated-investment portfolio, aggregated across every holding. */
export function getInvestPortfolio(state: SimulationState): InvestPortfolio {
  const holdings = getInvestmentHoldings(state);
  const totalValueMicroUsd = holdings.reduce((sum, h) => sum + h.currentValueMicroUsd, 0);
  const totalCostBasisMicroUsd = holdings.reduce((sum, h) => sum + h.costBasisMicroUsd, 0);
  const totalUnrealizedGainMicroUsd = totalValueMicroUsd - totalCostBasisMicroUsd;
  const totalUnrealizedGainBps =
    totalCostBasisMicroUsd > 0
      ? Number((BigInt(totalUnrealizedGainMicroUsd) * BigInt(10_000)) / BigInt(totalCostBasisMicroUsd))
      : 0;

  return { totalValueMicroUsd, totalCostBasisMicroUsd, totalUnrealizedGainMicroUsd, totalUnrealizedGainBps };
}

/**
 * Total value of the curated-investment portfolio, in micro-USD. Lives here
 * (rather than being computed inline in valuation.ts) so net worth reads
 * from the same derivation the Invest UI does.
 */
export function getInvestmentPortfolioValueMicroUsd(state: SimulationState): number {
  return getInvestPortfolio(state).totalValueMicroUsd;
}
