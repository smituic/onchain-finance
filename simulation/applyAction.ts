import type { Action, ActionResult, SimulationState } from "./types";
import { applySwap } from "./actions/swap";
import {
  applyAccrueSavings,
  applyAdvancePracticeTime,
  applyDepositToSavings,
  applyWithdrawFromSavings,
} from "./actions/savings";
import {
  applyAddCollateral,
  applyBorrowCash,
  applyRemoveCollateral,
  applyRepayCash,
  applyResetEthPrice,
  applySimulateEthPriceChange,
} from "./actions/borrow";
import {
  applyBuyInvestment,
  applyResetInvestmentPrices,
  applySellInvestment,
  applySimulateInvestmentMarketMove,
} from "./actions/invest";
import {
  applyCompletePaymentRequest,
  applyCreatePaymentRequest,
  applyDepositCash,
  applyReceivePayment,
  applySendPayment,
  applyWithdrawCash,
} from "./actions/pay";

/**
 * Single entry point into the simulation ledger. Pure: never mutates state.
 *
 * `nowMs` is wall-clock time, passed in rather than read inside the engine
 * so time-dependent actions (savings interest) stay deterministic and
 * testable. It defaults to the real clock for convenience at call sites —
 * like the swap preview — that aren't time-dependent at all.
 */
export function applyAction(
  state: SimulationState,
  action: Action,
  nowMs: number = Date.now(),
): ActionResult {
  switch (action.type) {
    case "swap":
      return applySwap(state, action);
    case "deposit-to-savings":
      return applyDepositToSavings(state, action, nowMs);
    case "withdraw-from-savings":
      return applyWithdrawFromSavings(state, action, nowMs);
    case "accrue-savings":
      return applyAccrueSavings(state, nowMs);
    case "advance-practice-time":
      return applyAdvancePracticeTime(state, nowMs);
    case "add-collateral":
      return applyAddCollateral(state, action);
    case "remove-collateral":
      return applyRemoveCollateral(state, action);
    case "borrow-cash":
      return applyBorrowCash(state, action);
    case "repay-cash":
      return applyRepayCash(state, action);
    case "simulate-eth-price-change":
      return applySimulateEthPriceChange(state, action);
    case "reset-eth-price":
      return applyResetEthPrice(state);
    case "buy-investment":
      return applyBuyInvestment(state, action);
    case "sell-investment":
      return applySellInvestment(state, action);
    case "simulate-investment-market-move":
      return applySimulateInvestmentMarketMove(state, action);
    case "reset-investment-prices":
      return applyResetInvestmentPrices(state);
    case "send-payment":
      return applySendPayment(state, action, nowMs);
    case "receive-payment":
      return applyReceivePayment(state, action, nowMs);
    case "create-payment-request":
      return applyCreatePaymentRequest(state, action, nowMs);
    case "complete-payment-request":
      return applyCompletePaymentRequest(state, action, nowMs);
    case "deposit-cash":
      return applyDepositCash(state, action, nowMs);
    case "withdraw-cash":
      return applyWithdrawCash(state, action, nowMs);
  }
}
