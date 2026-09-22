import { readAuthenticatedRealAccount } from "./auth";
import type { RealAccountRegistry } from "./registry";
import type { PaymentAttempt, PaymentAttemptState, PaymentAttemptStore } from "./payment-attempts";

/**
 * Batch 2e: a physically separate read module from server/payments.ts on
 * purpose. payments.ts owns prepare/submit/status orchestration and
 * everything that comes with it — Pimlico, signing verification,
 * reconciliation. Pulling history through that module would make the read
 * path structurally depend on the write/signing module graph even if no
 * history code actually called into it. This file may depend only on
 * session/account resolution (readAuthenticatedRealAccount,
 * RealAccountRegistry) and the PaymentAttemptStore read method — nothing
 * from lib/real/payments/**, lib/real/signing/**, or server/pimlico.ts.
 * Enforced both by what this file simply doesn't import, and by an explicit
 * source-scan test (test/lib/real/boundary.test.ts's "Batch 2e boundary"
 * suite).
 */

/**
 * Deliberately thinner than server/payments.ts's PublicPaymentAttempt, which
 * carries `prepared: WirePreparedFields | null` (nonce/calldata/gas/
 * paymaster — needed only to sign, never to display history). failureReason
 * is excluded too: it remains an internal field (now always one of a small
 * set of fixed, safe strings — see server/payments.ts's SAFE_* constants),
 * and history only ever needs the mapped status label
 * (lib/real/display/payment-status.ts), never the internal reason.
 */
export type PaymentHistoryEntry = {
  id: string;
  recipient: string;
  amountBaseUnits: string;
  state: PaymentAttemptState;
  transactionHash: string | null;
  createdAt: string;
  updatedAt: string;
};

export function toPaymentHistoryEntry(attempt: PaymentAttempt): PaymentHistoryEntry {
  return {
    id: attempt.id,
    recipient: attempt.recipient,
    amountBaseUnits: attempt.amountBaseUnits,
    state: attempt.state,
    transactionHash: attempt.transactionHash,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
  };
}

export const PAYMENT_HISTORY_DEFAULT_LIMIT = 10;
export const PAYMENT_HISTORY_MAX_LIMIT = 25;

/**
 * Clamps, never rejects: missing/invalid input falls back to the default,
 * anything above the max is capped at it. Keeps the route free of a
 * separate "bad limit" error path — the client never has to handle one.
 */
export function clampHistoryLimit(input: string | null | undefined): number {
  if (input === null || input === undefined) return PAYMENT_HISTORY_DEFAULT_LIMIT;
  const parsed = Number.parseInt(input, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return PAYMENT_HISTORY_DEFAULT_LIMIT;
  return Math.min(parsed, PAYMENT_HISTORY_MAX_LIMIT);
}

export type PaymentHistoryOutcome = { outcome: "unauthenticated" } | { outcome: "ok"; entries: PaymentHistoryEntry[] };

/**
 * No request body, no account/appUserId parameter at all — the only input
 * is `limitInput` (the raw `limit` query string). The account is always
 * whatever the session resolves to, same as resolveLatestPayment/
 * resolveAuthenticatedCashBalance — a caller cannot name another account's
 * history even in principle.
 */
export async function resolvePaymentHistory(input: {
  cookieValue: string | undefined | null;
  sessionSecret: string;
  registry: RealAccountRegistry;
  paymentStore: PaymentAttemptStore;
  limitInput: string | null | undefined;
}): Promise<PaymentHistoryOutcome> {
  const authenticated = await readAuthenticatedRealAccount({
    cookieValue: input.cookieValue,
    sessionSecret: input.sessionSecret,
    registry: input.registry,
  });
  if (!authenticated) return { outcome: "unauthenticated" };

  const limit = clampHistoryLimit(input.limitInput);
  const attempts = await input.paymentStore.findRecentByAppUserId({ appUserId: authenticated.account.appUserId, limit });
  return { outcome: "ok", entries: attempts.map(toPaymentHistoryEntry) };
}
