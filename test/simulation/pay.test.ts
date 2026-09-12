import { describe, expect, it } from "vitest";
import {
  applyAction,
  createInitialState,
  getNetWorthMicroUsd,
  PAY_CONTACTS,
  toMicroUnits,
  type SendPaymentAction,
  type SimulationState,
} from "@/simulation";

const T0 = 1_700_000_000_000;

function base(): SimulationState {
  return createInitialState(T0);
}

function act(state: SimulationState, action: Parameters<typeof applyAction>[1]) {
  const result = applyAction(state, action, T0);
  if (!result.ok) throw new Error(`action failed: ${result.error}`);
  return result;
}

describe("Pay contacts", () => {
  it("defines exactly Maya, Jordan, and Alex", () => {
    expect(Object.keys(PAY_CONTACTS).sort()).toEqual(["alex", "jordan", "maya"]);
    expect(PAY_CONTACTS.maya).toEqual({ id: "maya", displayName: "Maya Chen", handle: "@maya" });
    expect(PAY_CONTACTS.jordan).toEqual({ id: "jordan", displayName: "Jordan Lee", handle: "@jordan" });
    expect(PAY_CONTACTS.alex).toEqual({ id: "alex", displayName: "Alex Rivera", handle: "@alex" });
  });
});

describe("initial state", () => {
  it("starts with no requests, no activity, and counters at 1", () => {
    const state = base();
    expect(state.pay).toEqual({ requests: [], activity: [], nextRequestId: 1, nextActivityId: 1 });
  });
});

describe("send-payment", () => {
  it("moves Cash and net worth by exactly -amount, and records a send activity", () => {
    const amount = toMicroUnits(50);
    const result = act(base(), { type: "send-payment", contactId: "maya", amount, note: "lunch" });

    expect(result.state.balances.USDC).toBe(toMicroUnits(10_000) - amount);
    expect(getNetWorthMicroUsd(result.state)).toBe(getNetWorthMicroUsd(base()) - amount);
    expect(result.payActivity).toEqual({
      id: "activity-1",
      kind: "send",
      amountMicroUsd: amount,
      contactId: "maya",
      note: "lunch",
      occurredAtMs: T0,
    });
    expect(result.state.pay.activity).toEqual([result.payActivity]);
    expect(result.state.pay.nextActivityId).toBe(2);
  });

  it("omits note when none is given", () => {
    const result = act(base(), { type: "send-payment", contactId: "maya", amount: toMicroUnits(10) });
    expect(result.payActivity?.note).toBeUndefined();
  });

  it("rejects zero and negative amounts", () => {
    for (const amount of [0, -5]) {
      const result = applyAction(base(), { type: "send-payment", contactId: "maya", amount }, T0);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("INVALID_AMOUNT");
    }
  });

  it("rejects sending more Cash than available", () => {
    const state = base();
    const result = applyAction(
      state,
      { type: "send-payment", contactId: "maya", amount: state.balances.USDC + 1 },
      T0,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INSUFFICIENT_BALANCE");
  });

  it("rejects an unknown contact", () => {
    const badAction = {
      type: "send-payment",
      contactId: "nobody",
      amount: toMicroUnits(10),
    } as unknown as SendPaymentAction;
    const result = applyAction(base(), badAction, T0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNKNOWN_CONTACT");
  });
});

describe("receive-payment", () => {
  it("moves Cash and net worth by exactly +amount, and records a receive activity", () => {
    const amount = toMicroUnits(75);
    const result = act(base(), { type: "receive-payment", contactId: "jordan", amount });

    expect(result.state.balances.USDC).toBe(toMicroUnits(10_000) + amount);
    expect(getNetWorthMicroUsd(result.state)).toBe(getNetWorthMicroUsd(base()) + amount);
    expect(result.payActivity?.kind).toBe("receive");
    expect(result.payActivity?.contactId).toBe("jordan");
  });

  it("rejects zero/negative amounts and an unknown contact", () => {
    expect(applyAction(base(), { type: "receive-payment", contactId: "alex", amount: 0 }, T0).ok).toBe(false);
    const badAction = {
      type: "receive-payment",
      contactId: "nobody",
      amount: toMicroUnits(10),
    } as unknown as SendPaymentAction;
    const result = applyAction(base(), badAction, T0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNKNOWN_CONTACT");
  });
});

describe("deposit-cash", () => {
  it("increases Cash and net worth by exactly amount, with no contact on the activity", () => {
    const amount = toMicroUnits(200);
    const result = act(base(), { type: "deposit-cash", amount });

    expect(result.state.balances.USDC).toBe(toMicroUnits(10_000) + amount);
    expect(getNetWorthMicroUsd(result.state)).toBe(getNetWorthMicroUsd(base()) + amount);
    expect(result.payActivity).toEqual({
      id: "activity-1",
      kind: "deposit",
      amountMicroUsd: amount,
      occurredAtMs: T0,
    });
  });

  it("rejects zero/negative amounts", () => {
    const result = applyAction(base(), { type: "deposit-cash", amount: 0 }, T0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_AMOUNT");
  });
});

describe("withdraw-cash", () => {
  it("decreases Cash and net worth by exactly amount", () => {
    const amount = toMicroUnits(300);
    const result = act(base(), { type: "withdraw-cash", amount });

    expect(result.state.balances.USDC).toBe(toMicroUnits(10_000) - amount);
    expect(getNetWorthMicroUsd(result.state)).toBe(getNetWorthMicroUsd(base()) - amount);
    expect(result.payActivity?.kind).toBe("withdraw");
  });

  it("rejects withdrawing more Cash than available", () => {
    const state = base();
    const result = applyAction(state, { type: "withdraw-cash", amount: state.balances.USDC + 1 }, T0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INSUFFICIENT_BALANCE");
  });
});

describe("create-payment-request", () => {
  it("moves neither Cash nor net worth, and stores a pending request with a deterministic id", () => {
    const amount = toMicroUnits(40);
    const result = act(base(), { type: "create-payment-request", contactId: "alex", amount, note: "rent" });

    expect(result.state.balances.USDC).toBe(toMicroUnits(10_000));
    expect(getNetWorthMicroUsd(result.state)).toBe(getNetWorthMicroUsd(base()));
    expect(result.paymentRequest).toEqual({
      id: "request-1",
      contactId: "alex",
      amountMicroUsd: amount,
      status: "pending",
      note: "rent",
      createdAtMs: T0,
    });
    expect(result.state.pay.requests).toEqual([result.paymentRequest]);
    expect(result.state.pay.activity).toEqual([]);
  });

  it("assigns sequential ids across multiple requests", () => {
    let state = base();
    state = act(state, { type: "create-payment-request", contactId: "alex", amount: toMicroUnits(10) }).state;
    state = act(state, { type: "create-payment-request", contactId: "jordan", amount: toMicroUnits(20) }).state;

    expect(state.pay.requests.map((r) => r.id)).toEqual(["request-1", "request-2"]);
  });

  it("rejects zero/negative amounts and an unknown contact", () => {
    expect(applyAction(base(), { type: "create-payment-request", contactId: "alex", amount: 0 }, T0).ok).toBe(
      false,
    );
    const badAction = {
      type: "create-payment-request",
      contactId: "nobody",
      amount: toMicroUnits(10),
    } as unknown as SendPaymentAction;
    const result = applyAction(base(), badAction, T0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNKNOWN_CONTACT");
  });
});

describe("complete-payment-request", () => {
  function withPendingRequest() {
    const created = act(base(), {
      type: "create-payment-request",
      contactId: "jordan",
      amount: toMicroUnits(60),
      note: "groceries",
    });
    return { state: created.state, requestId: created.paymentRequest!.id };
  }

  it("increases Cash and net worth by exactly the request's amount, once", () => {
    const { state, requestId } = withPendingRequest();
    const result = act(state, { type: "complete-payment-request", requestId });

    expect(result.state.balances.USDC).toBe(toMicroUnits(10_000) + toMicroUnits(60));
    expect(getNetWorthMicroUsd(result.state)).toBe(getNetWorthMicroUsd(state) + toMicroUnits(60));
    expect(result.paymentRequest?.status).toBe("paid");
    expect(result.paymentRequest?.paidAtMs).toBe(T0);
  });

  it("creates a receive activity carrying the request's contact, amount, and note", () => {
    const { state, requestId } = withPendingRequest();
    const result = act(state, { type: "complete-payment-request", requestId });

    expect(result.payActivity).toEqual({
      id: "activity-1",
      kind: "receive",
      amountMicroUsd: toMicroUnits(60),
      contactId: "jordan",
      note: "groceries",
      occurredAtMs: T0,
    });
  });

  it("cannot be completed twice", () => {
    const { state, requestId } = withPendingRequest();
    const first = act(state, { type: "complete-payment-request", requestId });

    const second = applyAction(first.state, { type: "complete-payment-request", requestId }, T0);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("REQUEST_ALREADY_PAID");
    expect(second.error).toBe("That request has already been paid.");

    // Nothing further moves on the failed second attempt.
    expect(first.state.balances.USDC).toBe(toMicroUnits(10_000) + toMicroUnits(60));
    expect(first.state.pay.activity.length).toBe(1);
  });

  it("rejects an unknown request id", () => {
    const result = applyAction(base(), { type: "complete-payment-request", requestId: "request-999" }, T0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNKNOWN_REQUEST");
  });
});

describe("activity ordering and ids", () => {
  it("appends activity ids sequentially in creation order across mixed action types", () => {
    let state = base();
    state = act(state, { type: "deposit-cash", amount: toMicroUnits(10) }).state;
    state = act(state, { type: "send-payment", contactId: "maya", amount: toMicroUnits(5) }).state;
    const requestId = act(state, { type: "create-payment-request", contactId: "alex", amount: toMicroUnits(1) })
      .paymentRequest!.id;
    state = act(state, { type: "create-payment-request", contactId: "alex", amount: toMicroUnits(1) }).state;
    state = act(state, { type: "complete-payment-request", requestId }).state;

    expect(state.pay.activity.map((a) => a.id)).toEqual(["activity-1", "activity-2", "activity-3"]);
    expect(state.pay.activity.map((a) => a.kind)).toEqual(["deposit", "send", "receive"]);
    expect(state.pay.nextActivityId).toBe(4);
  });
});

describe("deterministic time", () => {
  it("stamps activity and requests with the simulated clock, including any advanced Practice time", () => {
    const state = { ...base(), clockOffsetMs: 5_000 };
    const result = act(state, { type: "send-payment", contactId: "maya", amount: toMicroUnits(1) });
    expect(result.payActivity?.occurredAtMs).toBe(T0 + 5_000);

    const requestResult = act(state, { type: "create-payment-request", contactId: "maya", amount: toMicroUnits(1) });
    expect(requestResult.paymentRequest?.createdAtMs).toBe(T0 + 5_000);
  });
});

describe("preserves everything else", () => {
  it("leaves the swap pool, ETH market price, savings, borrow, invest, investment-market prices, and the clock untouched", () => {
    const state = base();

    const results = [
      act(state, { type: "send-payment", contactId: "maya", amount: toMicroUnits(10) }),
      act(state, { type: "receive-payment", contactId: "jordan", amount: toMicroUnits(10) }),
      act(state, { type: "deposit-cash", amount: toMicroUnits(10) }),
      act(state, { type: "withdraw-cash", amount: toMicroUnits(10) }),
      act(state, { type: "create-payment-request", contactId: "alex", amount: toMicroUnits(10) }),
    ];

    for (const result of results) {
      expect(result.state.pool).toEqual(state.pool);
      expect(result.state.market).toEqual(state.market);
      expect(result.state.savings).toEqual(state.savings);
      expect(result.state.borrow).toEqual(state.borrow);
      expect(result.state.invest).toEqual(state.invest);
      expect(result.state.investmentMarket).toEqual(state.investmentMarket);
      expect(result.state.clockOffsetMs).toBe(state.clockOffsetMs);
    }
  });
});
