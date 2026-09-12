import type {
  ActionResult,
  CompletePaymentRequestAction,
  CreatePaymentRequestAction,
  DepositCashAction,
  PayActivity,
  PaymentRequest,
  ReceivePaymentAction,
  SendPaymentAction,
  SimulationState,
  WithdrawCashAction,
} from "../types";
import { getSimulatedNow } from "../savings";
import { PAY_CONTACTS } from "../pay";

/**
 * Cash is held as USDC, which the simulation prices at exactly $1; see
 * actions/savings.ts for why that makes moving it around net-worth-neutral
 * by construction — only the sign and side of `balances.USDC` change here.
 */
const CASH_ASSET = "USDC" as const;

function validateAmount(amount: number): ActionResult | null {
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, error: "Enter an amount greater than zero.", code: "INVALID_AMOUNT" };
  }
  return null;
}

function validateContact(contactId: SendPaymentAction["contactId"]): ActionResult | null {
  if (!PAY_CONTACTS[contactId]) {
    return { ok: false, error: "Unknown contact.", code: "UNKNOWN_CONTACT" };
  }
  return null;
}

/**
 * Appends one Pay activity entry and advances the deterministic activity
 * counter. Every action below that actually moves Cash goes through this, so
 * activity ids stay sequential (`activity-1`, `activity-2`, …) regardless of
 * which action created them.
 */
function appendActivity(
  state: SimulationState,
  entry: Omit<PayActivity, "id">,
): { state: SimulationState; activity: PayActivity } {
  const activity: PayActivity = { id: `activity-${state.pay.nextActivityId}`, ...entry };
  return {
    activity,
    state: {
      ...state,
      pay: {
        ...state.pay,
        activity: [...state.pay.activity, activity],
        nextActivityId: state.pay.nextActivityId + 1,
      },
    },
  };
}

/** Sends Cash to a Practice contact — outside the tracked portfolio, so net worth drops by exactly the amount. */
export function applySendPayment(
  state: SimulationState,
  action: SendPaymentAction,
  nowMs: number,
): ActionResult {
  const invalidContact = validateContact(action.contactId);
  if (invalidContact) return invalidContact;

  const invalidAmount = validateAmount(action.amount);
  if (invalidAmount) return invalidAmount;

  if (action.amount > state.balances[CASH_ASSET]) {
    return { ok: false, error: "You don't have enough Cash to send that.", code: "INSUFFICIENT_BALANCE" };
  }

  const withBalance: SimulationState = {
    ...state,
    balances: { ...state.balances, [CASH_ASSET]: state.balances[CASH_ASSET] - action.amount },
  };
  const { state: next, activity } = appendActivity(withBalance, {
    kind: "send",
    amountMicroUsd: action.amount,
    contactId: action.contactId,
    note: action.note,
    occurredAtMs: getSimulatedNow(state, nowMs),
  });

  return { ok: true, state: next, payActivity: activity };
}

/** Simulates an incoming payment from a Practice contact — Cash and net worth both rise by exactly the amount. */
export function applyReceivePayment(
  state: SimulationState,
  action: ReceivePaymentAction,
  nowMs: number,
): ActionResult {
  const invalidContact = validateContact(action.contactId);
  if (invalidContact) return invalidContact;

  const invalidAmount = validateAmount(action.amount);
  if (invalidAmount) return invalidAmount;

  const withBalance: SimulationState = {
    ...state,
    balances: { ...state.balances, [CASH_ASSET]: state.balances[CASH_ASSET] + action.amount },
  };
  const { state: next, activity } = appendActivity(withBalance, {
    kind: "receive",
    amountMicroUsd: action.amount,
    contactId: action.contactId,
    note: action.note,
    occurredAtMs: getSimulatedNow(state, nowMs),
  });

  return { ok: true, state: next, payActivity: activity };
}

/** Adds simulated Cash from outside the app. Not tied to any contact. */
export function applyDepositCash(
  state: SimulationState,
  action: DepositCashAction,
  nowMs: number,
): ActionResult {
  const invalidAmount = validateAmount(action.amount);
  if (invalidAmount) return invalidAmount;

  const withBalance: SimulationState = {
    ...state,
    balances: { ...state.balances, [CASH_ASSET]: state.balances[CASH_ASSET] + action.amount },
  };
  const { state: next, activity } = appendActivity(withBalance, {
    kind: "deposit",
    amountMicroUsd: action.amount,
    occurredAtMs: getSimulatedNow(state, nowMs),
  });

  return { ok: true, state: next, payActivity: activity };
}

/** Removes simulated Cash from the app. */
export function applyWithdrawCash(
  state: SimulationState,
  action: WithdrawCashAction,
  nowMs: number,
): ActionResult {
  const invalidAmount = validateAmount(action.amount);
  if (invalidAmount) return invalidAmount;

  if (action.amount > state.balances[CASH_ASSET]) {
    return {
      ok: false,
      error: "You don't have enough Cash to withdraw that.",
      code: "INSUFFICIENT_BALANCE",
    };
  }

  const withBalance: SimulationState = {
    ...state,
    balances: { ...state.balances, [CASH_ASSET]: state.balances[CASH_ASSET] - action.amount },
  };
  const { state: next, activity } = appendActivity(withBalance, {
    kind: "withdraw",
    amountMicroUsd: action.amount,
    occurredAtMs: getSimulatedNow(state, nowMs),
  });

  return { ok: true, state: next, payActivity: activity };
}

/**
 * Creates a pending request for a Practice contact to pay the user. Moves no
 * money and touches no activity — only `complete-payment-request` does.
 */
export function applyCreatePaymentRequest(
  state: SimulationState,
  action: CreatePaymentRequestAction,
  nowMs: number,
): ActionResult {
  const invalidContact = validateContact(action.contactId);
  if (invalidContact) return invalidContact;

  const invalidAmount = validateAmount(action.amount);
  if (invalidAmount) return invalidAmount;

  const request: PaymentRequest = {
    id: `request-${state.pay.nextRequestId}`,
    contactId: action.contactId,
    amountMicroUsd: action.amount,
    status: "pending",
    note: action.note,
    createdAtMs: getSimulatedNow(state, nowMs),
  };

  return {
    ok: true,
    state: {
      ...state,
      pay: {
        ...state.pay,
        requests: [...state.pay.requests, request],
        nextRequestId: state.pay.nextRequestId + 1,
      },
    },
    paymentRequest: request,
  };
}

/**
 * Simulates a pending request being paid: Cash rises exactly once, the
 * request is marked paid, and a normal "receive" activity is recorded rather
 * than inventing a separate movement type. Rejects a request that's already
 * paid, or doesn't exist, so it can never pay out twice.
 */
export function applyCompletePaymentRequest(
  state: SimulationState,
  action: CompletePaymentRequestAction,
  nowMs: number,
): ActionResult {
  const request = state.pay.requests.find((r) => r.id === action.requestId);
  if (!request) {
    return { ok: false, error: "That request doesn't exist.", code: "UNKNOWN_REQUEST" };
  }
  if (request.status === "paid") {
    return { ok: false, error: "That request has already been paid.", code: "REQUEST_ALREADY_PAID" };
  }

  const simulatedNow = getSimulatedNow(state, nowMs);
  const paidRequest: PaymentRequest = { ...request, status: "paid", paidAtMs: simulatedNow };

  const withBalanceAndRequest: SimulationState = {
    ...state,
    balances: {
      ...state.balances,
      [CASH_ASSET]: state.balances[CASH_ASSET] + request.amountMicroUsd,
    },
    pay: {
      ...state.pay,
      requests: state.pay.requests.map((r) => (r.id === request.id ? paidRequest : r)),
    },
  };

  const { state: next, activity } = appendActivity(withBalanceAndRequest, {
    kind: "receive",
    amountMicroUsd: request.amountMicroUsd,
    contactId: request.contactId,
    note: request.note,
    occurredAtMs: simulatedNow,
  });

  return { ok: true, state: next, payActivity: activity, paymentRequest: paidRequest };
}
