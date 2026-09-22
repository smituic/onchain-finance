import type { Address } from "viem";
import { validateAddressCasePreserving } from "../identifiers";
import { readCashBalance, type CashBalance } from "../chain/balance";
import type { RealPublicClient } from "../chain/client";
import { readAuthenticatedRealAccount } from "./auth";
import type { RealAccountRegistry } from "./registry";

export type BalanceOutcome =
  | { outcome: "ready"; balance: CashBalance }
  | { outcome: "unauthenticated" }
  /** Structurally shouldn't happen — a session is only ever issued for a fully-finalized (active) account (see onboarding.ts) — but the balance holder is checked explicitly rather than handed an unvalidated value regardless. */
  | { outcome: "account_not_ready" }
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
}): Promise<BalanceOutcome> {
  const authenticated = await readAuthenticatedRealAccount({
    cookieValue: input.cookieValue,
    sessionSecret: input.sessionSecret,
    registry: input.registry,
  });
  if (!authenticated) return { outcome: "unauthenticated" };

  const safeAddress = validateAddressCasePreserving(authenticated.account.safeAddress);
  if (!safeAddress) return { outcome: "account_not_ready" };

  try {
    const balance = await readCashBalance({ publicClient: input.publicClient, safeAddress: safeAddress as Address });
    return { outcome: "ready", balance };
  } catch (error) {
    // An RPC/validation failure is never converted into a balance — the
    // caller must show an explicit error state, never a false "$0.00".
    return { outcome: "read_failed", reason: error instanceof Error ? error.message : "Could not read your balance." };
  }
}
