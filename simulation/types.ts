// Core types for the simulation/ledger layer. See simulation/README.md for the
// framework-agnostic boundary this file lives inside.

/** The fixed set of simulated assets. Extend this union as new assets are added. */
export type AssetId = "USDC" | "ETH";

/**
 * The curated set of Practice Mode investments — a distinct namespace from
 * `AssetId`. These are never spendable/swappable balances and never enter
 * the swap pool; see simulation/investments.ts for why they're kept
 * separate rather than folded into `AssetId`.
 */
export type InvestmentAssetId = "BTC" | "TBILL" | "BROAD";

/**
 * All balances are integers in fixed-point "micro-units" (see money.ts) —
 * never floats. A balance is always >= 0.
 */
export type SimulationState = {
  balances: Record<AssetId, number>;
  pool: PoolState;
  savings: SavingsState;
  borrow: BorrowState;
  market: MarketState;
  invest: InvestState;
  investmentMarket: InvestmentMarketState;
  pay: PayState;
  /**
   * Milliseconds of simulated time the user has deliberately skipped
   * forward with Practice Mode's time control, added to wall-clock time to
   * get the simulation's "now". Lives at the top level because it's the
   * whole simulation's clock, not a savings-only concept — borrowing
   * scenarios will read the same offset.
   */
  clockOffsetMs: number;
};

/**
 * A simulated savings position. `balance` is the whole position — deposits
 * plus every bit of interest credited into it — so it's always "what the
 * user would get back if they withdrew everything right now", which keeps
 * deposits and withdrawals at arbitrary times coherent.
 * `interestEarnedTotal` is a separate lifetime counter kept for display: it
 * only ever grows, so withdrawing money doesn't erase the fact that the
 * money was earned.
 */
export type SavingsState = {
  balance: number;
  interestEarnedTotal: number;
  /** Simulated-clock timestamp (ms) that `balance` is current as of. */
  lastAccruedAt: number;
};

/**
 * A single collateralised loan: ETH pledged, Cash owed. Collateral lives
 * here rather than in `balances` so pledged ETH can't also be spent or
 * swapped — it's still the user's, but it's committed.
 *
 * Deliberately one position against one pair (ETH collateral, USDC debt)
 * rather than a lending market: the concept being taught is collateral
 * risk, and a second asset would add configuration without adding a
 * lesson. No interest accrues on the debt in this slice.
 */
export type BorrowState = {
  /** Pledged ETH, in micro-units. */
  collateralEth: number;
  /** Outstanding borrowed Cash, in micro-USD. */
  debtMicroUsd: number;
};

/**
 * Simulated market prices — the simulation's valuation/reference price for
 * each asset, which Practice Mode scenarios can move. Distinct from the
 * swap pool's spot price; see market.ts for why they're kept apart.
 */
export type MarketState = {
  pricesMicroUsd: Record<AssetId, number>;
};

/**
 * Constant-product (x*y=k) AMM reserves backing the swap action. Lives
 * alongside `balances` (not derived, not UI state) because it's mutated by
 * actions and must persist the same way balances do. A single shared
 * reserve map is the boring choice while there are exactly two assets; if a
 * third asset ever needs its own distinct pair-pool, that's the point to
 * introduce a per-pair map instead.
 */
export type PoolState = {
  reserves: Record<AssetId, number>;
};

/**
 * A single curated investment position: units held, and the remaining cost
 * basis behind them. Current value and gain/loss are always derived (see
 * investments.ts) — never stored — so they can't drift out of sync with the
 * current investment-market price.
 */
export type InvestmentHoldingState = {
  /** Fixed-point units, using the same DECIMALS precision as everything else. */
  unitsHeld: number;
  costBasisMicroUsd: number;
};

/** The user's whole curated-investment portfolio: one holding per curated asset. */
export type InvestState = {
  holdings: Record<InvestmentAssetId, InvestmentHoldingState>;
};

/**
 * Simulated market (reference) prices for the curated investment universe —
 * structurally parallel to `MarketState`, but a distinct namespace: these
 * assets are never spendable balances and never back the swap pool. See
 * investments.ts for why they're kept apart from `AssetId`/`MarketState`
 * rather than merged into them.
 */
export type InvestmentMarketState = {
  pricesMicroUsd: Record<InvestmentAssetId, number>;
};

/**
 * A fixed, clearly fictional set of Practice contacts Pay's Send/Receive/
 * Request flows move money between — a display registry, not mutable
 * financial state. See simulation/pay.ts for the definitions.
 */
export type PayContactId = "maya" | "jordan" | "alex";

export type PaymentRequestStatus = "pending" | "paid";

/**
 * A request for someone else to pay the user. Creating one never moves
 * money — only `complete-payment-request` does, exactly once, which is why
 * `status` exists at all.
 */
export type PaymentRequest = {
  id: string;
  contactId: PayContactId;
  amountMicroUsd: number;
  status: PaymentRequestStatus;
  note?: string;
  createdAtMs: number;
  paidAtMs?: number;
};

export type PayActivityKind = "send" | "receive" | "deposit" | "withdraw";

/**
 * A completed Pay money movement. Unlike PaymentRequest, every activity
 * entry represents Cash that has actually moved — a paid request creates one
 * of these (kind "receive") rather than inventing a separate movement type.
 */
export type PayActivity = {
  id: string;
  kind: PayActivityKind;
  amountMicroUsd: number;
  contactId?: PayContactId;
  note?: string;
  occurredAtMs: number;
};

/** Pay's local state: pending/completed requests, local activity, and deterministic ID counters. */
export type PayState = {
  requests: PaymentRequest[];
  activity: PayActivity[];
  nextRequestId: number;
  nextActivityId: number;
};

/** Sends Cash to a Practice contact, outside the tracked portfolio. */
export type SendPaymentAction = {
  type: "send-payment";
  contactId: PayContactId;
  amount: number;
  note?: string;
};

/** Simulates an incoming payment from a Practice contact. */
export type ReceivePaymentAction = {
  type: "receive-payment";
  contactId: PayContactId;
  amount: number;
  note?: string;
};

/** Creates a pending request for a Practice contact to pay the user. Moves no money. */
export type CreatePaymentRequestAction = {
  type: "create-payment-request";
  contactId: PayContactId;
  amount: number;
  note?: string;
};

/** Simulates a pending request being paid. Can only succeed once per request. */
export type CompletePaymentRequestAction = {
  type: "complete-payment-request";
  requestId: string;
};

/** Adds simulated Cash from outside the app (Practice Mode's "add money" control). */
export type DepositCashAction = {
  type: "deposit-cash";
  amount: number;
};

/** Removes simulated Cash from the app. */
export type WithdrawCashAction = {
  type: "withdraw-cash";
  amount: number;
};

export type SwapAction = {
  type: "swap";
  fromAsset: AssetId;
  toAsset: AssetId;
  /** Amount of fromAsset to spend, in micro-units. */
  amountIn: number;
};

/** Moves Cash into savings. Amount is in micro-units of USDC (= micro-USD). */
export type DepositToSavingsAction = {
  type: "deposit-to-savings";
  amount: number;
};

/** Moves money out of savings and back into Cash, in micro-USD. */
export type WithdrawFromSavingsAction = {
  type: "withdraw-from-savings";
  amount: number;
};

/**
 * Brings the savings position up to date with the current time. Dispatched
 * at read/lifecycle boundaries (notably after the store rehydrates) so
 * interest appears without a timer constantly mutating the ledger.
 */
export type AccrueSavingsAction = {
  type: "accrue-savings";
};

/**
 * Practice Mode's time control: jumps the simulation's clock forward by one
 * step so a user can watch interest arrive without waiting a real month.
 */
export type AdvancePracticeTimeAction = {
  type: "advance-practice-time";
};

/** Pledges ETH from the user's balance as collateral, in ETH micro-units. */
export type AddCollateralAction = {
  type: "add-collateral";
  amount: number;
};

/** Returns pledged ETH to the user's balance, in ETH micro-units. */
export type RemoveCollateralAction = {
  type: "remove-collateral";
  amount: number;
};

/** Borrows Cash against pledged collateral, in micro-USD. */
export type BorrowCashAction = {
  type: "borrow-cash";
  amount: number;
};

/** Pays borrowed Cash back, in micro-USD. */
export type RepayCashAction = {
  type: "repay-cash";
  amount: number;
};

/**
 * Practice Mode's market control: moves ETH's simulated market price by a
 * relative amount (-4_000 = a 40% fall) so a user can find out what a
 * crash does to their loan. Re-prices collateral only — it never trades
 * against the swap pool or touches its liquidity.
 */
export type SimulateEthPriceChangeAction = {
  type: "simulate-eth-price-change";
  changeBps: number;
};

/** Puts ETH's simulated market price back where it started. */
export type ResetEthPriceAction = {
  type: "reset-eth-price";
};

/**
 * Buys a curated investment with Cash. `amount` is the Cash the user wants
 * to spend, in micro-USD — the same convention as `DepositToSavingsAction`.
 * The engine converts this to whole fixed-point units at the current price
 * and settles the *executed* cost (which can be slightly less than
 * `amount` after flooring to whole units), never the requested amount
 * itself; see investments.ts.
 */
export type BuyInvestmentAction = {
  type: "buy-investment";
  assetId: InvestmentAssetId;
  amount: number;
};

/**
 * Sells part or all of a curated investment position. `amount` is how much
 * value, in micro-USD, the user wants back — the engine converts this to
 * whole fixed-point units at the current price and credits the *executed*
 * proceeds of those units, never the requested amount itself. Requesting
 * (at least) the position's full current value sells everything and zeroes
 * the position exactly.
 */
export type SellInvestmentAction = {
  type: "sell-investment";
  assetId: InvestmentAssetId;
  amount: number;
};

/**
 * Practice Mode's investment market control: moves every curated
 * investment's simulated price by its own deterministic magnitude (see
 * INVESTMENT_MARKET_MOVE_BPS in investments.ts) — Bitcoin moves the most,
 * the broad-market fund a moderate amount, Treasuries the least. Touches
 * only `investmentMarket`; never the swap pool, ETH's market price,
 * savings, borrowing, or the Practice clock.
 */
export type SimulateInvestmentMarketMoveAction = {
  type: "simulate-investment-market-move";
  direction: "up" | "down";
};

/** Puts every curated investment's simulated price back where it started. */
export type ResetInvestmentPricesAction = {
  type: "reset-investment-prices";
};

/** Grows as more mechanics are added. */
export type Action =
  | SwapAction
  | DepositToSavingsAction
  | WithdrawFromSavingsAction
  | AccrueSavingsAction
  | AdvancePracticeTimeAction
  | AddCollateralAction
  | RemoveCollateralAction
  | BorrowCashAction
  | RepayCashAction
  | SimulateEthPriceChangeAction
  | ResetEthPriceAction
  | BuyInvestmentAction
  | SellInvestmentAction
  | SimulateInvestmentMarketMoveAction
  | ResetInvestmentPricesAction
  | SendPaymentAction
  | ReceivePaymentAction
  | CreatePaymentRequestAction
  | CompletePaymentRequestAction
  | DepositCashAction
  | WithdrawCashAction;

export type SimulationErrorCode =
  | "SAME_ASSET"
  | "INVALID_AMOUNT"
  | "INSUFFICIENT_BALANCE"
  | "UNKNOWN_ASSET"
  | "EXCEEDS_BORROW_LIMIT"
  | "EXCEEDS_DEBT"
  | "WOULD_BE_UNSAFE"
  | "UNKNOWN_CONTACT"
  | "UNKNOWN_REQUEST"
  | "REQUEST_ALREADY_PAID";

/**
 * Everything the UI needs to explain a swap's execution without
 * recomputing AMM math itself. `amountOut` is what the trade actually
 * produced; `referenceAmountOut` is what the same `amountIn` would have
 * produced at the pre-trade pool spot price with zero impact — the gap
 * between the two is what a large trade "costs" relative to that price.
 * `priceImpactBps` is always a positive magnitude (how much worse the
 * average execution price is than the pre-trade spot price), regardless of
 * swap direction.
 */
export type SwapReceipt = {
  amountOut: number;
  referenceAmountOut: number;
  referencePriceMicroUsd: number;
  executionPriceMicroUsd: number;
  priceImpactBps: number;
};

/**
 * What a liquidation did, so the UI can explain it in the user's own
 * numbers rather than re-deriving them.
 *
 * Exactly one of the last two is non-zero: if the sale raised more than was
 * owed, the excess is `returnedToCashMicroUsd`; if it raised less, the part
 * it couldn't cover is `remainingDebtMicroUsd` and is still owed.
 */
export type LiquidationReceipt = {
  collateralSoldEth: number;
  collateralValueMicroUsd: number;
  /** How much debt the sale actually paid off. */
  debtClearedMicroUsd: number;
  returnedToCashMicroUsd: number;
  remainingDebtMicroUsd: number;
  /** The ETH price the collateral was sold at. */
  ethPriceMicroUsd: number;
};

/**
 * What a buy or sell of a curated investment actually executed, so the UI
 * can explain a trade in the user's own numbers without recomputing the
 * fixed-point math. `amountMicroUsd` is the *executed* cash moved (spent on
 * a buy, received on a sell) — which can be slightly less than what the
 * user requested once the request is floored to whole units; see
 * investments.ts. `realizedGainMicroUsd` is present only for sells.
 */
export type InvestmentTradeReceipt = {
  assetId: InvestmentAssetId;
  unitsTraded: number;
  amountMicroUsd: number;
  priceMicroUsd: number;
  realizedGainMicroUsd?: number;
};

export type ActionResult =
  | {
      ok: true;
      state: SimulationState;
      swap?: SwapReceipt;
      liquidation?: LiquidationReceipt;
      investmentTrade?: InvestmentTradeReceipt;
      payActivity?: PayActivity;
      paymentRequest?: PaymentRequest;
    }
  | { ok: false; error: string; code: SimulationErrorCode };
