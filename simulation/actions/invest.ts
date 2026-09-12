import type {
  ActionResult,
  BuyInvestmentAction,
  SellInvestmentAction,
  SimulateInvestmentMarketMoveAction,
  SimulationState,
} from "../types";
import { DECIMALS } from "../money";
import {
  applyInvestmentMarketMove,
  getInvestmentPriceMicroUsd,
  INVESTMENT_ASSETS,
  resetInvestmentPrices,
} from "../investments";

const SCALE = BigInt(10 ** DECIMALS);

function validateAmount(amount: number): ActionResult | null {
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, error: "Enter an amount greater than zero.", code: "INVALID_AMOUNT" };
  }
  return null;
}

/**
 * Buys a curated investment with Cash. The requested `amount` is floored to
 * whole fixed-point units at the current price, and the *executed* cost of
 * those units — never the requested amount — is what actually moves: cash
 * decrease and cost-basis increase are the exact same number, computed the
 * same way, so a buy cannot change net worth even by rounding dust. Any
 * remainder from flooring (e.g. requesting $500 of an asset priced such
 * that whole units only cost $499.98) simply stays in cash.
 */
export function applyBuyInvestment(state: SimulationState, action: BuyInvestmentAction): ActionResult {
  const definition = INVESTMENT_ASSETS[action.assetId];
  if (!definition) {
    return { ok: false, error: "Unknown investment.", code: "UNKNOWN_ASSET" };
  }

  const invalid = validateAmount(action.amount);
  if (invalid) return invalid;

  if (action.amount > state.balances.USDC) {
    return { ok: false, error: "You don't have that much cash.", code: "INSUFFICIENT_BALANCE" };
  }

  const priceMicroUsd = getInvestmentPriceMicroUsd(state, action.assetId);
  const unitsBig = (BigInt(action.amount) * SCALE) / BigInt(priceMicroUsd);
  if (unitsBig <= BigInt(0)) {
    return {
      ok: false,
      error: "That's too little to buy any units at the current price.",
      code: "INVALID_AMOUNT",
    };
  }

  const executedMicroUsd = Number((unitsBig * BigInt(priceMicroUsd)) / SCALE);
  const units = Number(unitsBig);
  const holding = state.invest.holdings[action.assetId];

  return {
    ok: true,
    state: {
      ...state,
      balances: { ...state.balances, USDC: state.balances.USDC - executedMicroUsd },
      invest: {
        holdings: {
          ...state.invest.holdings,
          [action.assetId]: {
            unitsHeld: holding.unitsHeld + units,
            costBasisMicroUsd: holding.costBasisMicroUsd + executedMicroUsd,
          },
        },
      },
    },
    investmentTrade: {
      assetId: action.assetId,
      unitsTraded: units,
      amountMicroUsd: executedMicroUsd,
      priceMicroUsd,
    },
  };
}

/**
 * Sells part or all of a curated investment position. The requested
 * `amount` is floored to whole fixed-point units at the current price
 * (capped at what's held); the *executed* proceeds of those units — never
 * the requested amount — is what actually credits Cash, so a sell cannot
 * change net worth even by rounding dust. Requesting at least the
 * position's full current value sells everything and zeroes the position
 * exactly, sidestepping any proportional-cost-basis rounding.
 */
export function applySellInvestment(state: SimulationState, action: SellInvestmentAction): ActionResult {
  const definition = INVESTMENT_ASSETS[action.assetId];
  if (!definition) {
    return { ok: false, error: "Unknown investment.", code: "UNKNOWN_ASSET" };
  }

  const invalid = validateAmount(action.amount);
  if (invalid) return invalid;

  const holding = state.invest.holdings[action.assetId];
  if (holding.unitsHeld <= 0) {
    return { ok: false, error: "You don't own any of this yet.", code: "INSUFFICIENT_BALANCE" };
  }

  const priceMicroUsd = getInvestmentPriceMicroUsd(state, action.assetId);
  const currentValueMicroUsd = Number((BigInt(holding.unitsHeld) * BigInt(priceMicroUsd)) / SCALE);
  if (action.amount > currentValueMicroUsd) {
    return { ok: false, error: "You don't have that much invested.", code: "INSUFFICIENT_BALANCE" };
  }

  const requestedUnitsBig = (BigInt(action.amount) * SCALE) / BigInt(priceMicroUsd);
  const unitsSoldBig =
    requestedUnitsBig >= BigInt(holding.unitsHeld) ? BigInt(holding.unitsHeld) : requestedUnitsBig;

  if (unitsSoldBig <= BigInt(0)) {
    return {
      ok: false,
      error: "That's too little to sell at the current price.",
      code: "INVALID_AMOUNT",
    };
  }

  const unitsSold = Number(unitsSoldBig);
  const isFullSale = unitsSold >= holding.unitsHeld;

  // A full sale closes the position exactly — proceeds are the position's
  // whole current value and cost basis is zeroed outright, rather than
  // computed proportionally, which sidesteps rounding a proportional
  // removal could otherwise leave as unreachable dust.
  const proceedsMicroUsd = isFullSale
    ? currentValueMicroUsd
    : Number((unitsSoldBig * BigInt(priceMicroUsd)) / SCALE);
  const costBasisRemovedMicroUsd = isFullSale
    ? holding.costBasisMicroUsd
    : Number((BigInt(holding.costBasisMicroUsd) * unitsSoldBig) / BigInt(holding.unitsHeld));

  const realizedGainMicroUsd = proceedsMicroUsd - costBasisRemovedMicroUsd;

  return {
    ok: true,
    state: {
      ...state,
      balances: { ...state.balances, USDC: state.balances.USDC + proceedsMicroUsd },
      invest: {
        holdings: {
          ...state.invest.holdings,
          [action.assetId]: isFullSale
            ? { unitsHeld: 0, costBasisMicroUsd: 0 }
            : {
                unitsHeld: holding.unitsHeld - unitsSold,
                costBasisMicroUsd: holding.costBasisMicroUsd - costBasisRemovedMicroUsd,
              },
        },
      },
    },
    investmentTrade: {
      assetId: action.assetId,
      unitsTraded: unitsSold,
      amountMicroUsd: proceedsMicroUsd,
      priceMicroUsd,
      realizedGainMicroUsd,
    },
  };
}

/** Moves every curated investment's simulated price by its own scenario magnitude. */
export function applySimulateInvestmentMarketMove(
  state: SimulationState,
  action: SimulateInvestmentMarketMoveAction,
): ActionResult {
  return { ok: true, state: applyInvestmentMarketMove(state, action.direction) };
}

/** Restores every curated investment's simulated price to where it started. */
export function applyResetInvestmentPrices(state: SimulationState): ActionResult {
  return { ok: true, state: resetInvestmentPrices(state) };
}
