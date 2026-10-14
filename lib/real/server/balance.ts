import type { Address } from "viem";
import { validateAddressCasePreserving } from "../identifiers";
import { readCashBalance, type CashBalance } from "../chain/balance";
import type { RealPublicClient } from "../chain/client";
import { readAuthenticatedRealAccount } from "./auth";
import { consumeChainReadBudget } from "./chain-read-budget";
import type { ProviderBudgetLimiter } from "./rate-limit";
import type { RealAccountRegistry } from "./registry";

/** Fixed, safe message — never the raw upstream RPC error (see the catch below). */
const SAFE_BALANCE_READ_FAILED = "Could not read your balance right now. Try again in a moment.";

export type BalanceOutcome =
  | { outcome: "ready"; balance: CashBalance }
  | { outcome: "unauthenticated" }
  /** Structurally shouldn't happen — a session is only ever issued for a fully-finalized (active) account (see onboarding.ts) — but the balance holder is checked explicitly rather than handed an unvalidated value regardless. */
  | { outcome: "account_not_ready" }
  /** The account's chain-read budget is spent: no RPC was made and no balance is claimed. The delay is a validated whole number of seconds. */
  | { outcome: "rate_limited"; retryAfterSeconds: number }
  | { outcome: "read_failed"; reason: string };

/**
 * The one place "whose balance does this request get" is decided. The Safe
 * address ALWAYS comes from the durable account the HttpOnly session
 * resolves to (via readAuthenticatedRealAccount) — there is no input
 * parameter here a caller could use to name a different address. No
 * signing, no Turnkey, no Pimlico: this is a read path only.
 */
export async function resolveAuthenticatedCashBalance(input: {
  cookieValue: string | undefined | null;
  sessionSecret: string;
  registry: RealAccountRegistry;
  publicClient: RealPublicClient;
  /** Required: a caller cannot reach the RPC read without a budget decision. */
  providerBudgetLimiter: ProviderBudgetLimiter;
}): Promise<BalanceOutcome> {
  const authenticated = await readAuthenticatedRealAccount({
    cookieValue: input.cookieValue,
    sessionSecret: input.sessionSecret,
    registry: input.registry,
  });
  if (!authenticated) return { outcome: "unauthenticated" };

  const safeAddress = validateAddressCasePreserving(authenticated.account.safeAddress);
  if (!safeAddress) return { outcome: "account_not_ready" };

  // Authenticated, account resolved, Safe validated — and only now charged,
  // immediately before the one provider-bound read. Deliberately OUTSIDE the
  // try below: a limiter failure is a server error (the route's generic 500),
  // never a "read_failed" and never an allow.
  const budget = await consumeChainReadBudget(input.providerBudgetLimiter, authenticated.account.appUserId);
  if (!budget.allowed) return { outcome: "rate_limited", retryAfterSeconds: budget.retryAfterSeconds };

  try {
    const balance = await readCashBalance({ publicClient: input.publicClient, safeAddress: safeAddress as Address });
    return { outcome: "ready", balance };
  } catch {
    // An RPC/validation failure is never converted into a balance — the
    // caller must show an explicit error state, never a false "$0.00". The
    // reason is a fixed, safe message, never the raw error: a viem
    // HttpRequestError/RpcRequestError's .message can embed the RPC
    // request URL (and any API key in it).
    return { outcome: "read_failed", reason: SAFE_BALANCE_READ_FAILED };
  }
}
