"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useRealAccountStore } from "@/lib/stores/real-account-store";
import { useRealBalanceStore } from "@/lib/stores/real-balance-store";
import { CASH_LABEL, formatCashBaseUnits } from "@/lib/real/display/cash";

/**
 * How long a server-given wait is, in plain words. Always rounded UP and never
 * softer than the truth: a daily limit reads as hours, not "a moment".
 */
export function describeWait(seconds: number): string {
  if (seconds < 60) return "in less than a minute";
  if (seconds < 3_600) {
    const minutes = Math.ceil(seconds / 60);
    return minutes === 1 ? "in about a minute" : `in about ${minutes} minutes`;
  }
  const hours = Math.ceil(seconds / 3_600);
  return hours === 1 ? "in about an hour" : `in about ${hours} hours`;
}

/**
 * The real (Base Sepolia) Cash balance for the signed-in account — read-only,
 * no signing, no Turnkey/Pimlico involvement. Renders nothing when there's
 * no account yet (AccountSetup already owns that state); "account not ready"
 * and "not authenticated" are the same visible state from here (nothing to
 * show), since this component only ever fetches once an account exists.
 */
export function CashBalance() {
  const account = useRealAccountStore((s) => s.account);
  const balance = useRealBalanceStore((s) => s.balance);
  const status = useRealBalanceStore((s) => s.status);
  const error = useRealBalanceStore((s) => s.error);
  const retryAfterSeconds = useRealBalanceStore((s) => s.retryAfterSeconds);
  const isCoolingDown = useRealBalanceStore((s) => s.isCoolingDown);
  const fetchBalance = useRealBalanceStore((s) => s.fetchBalance);
  const reset = useRealBalanceStore((s) => s.reset);

  useEffect(() => {
    // Pre-2f hardening: reset unconditionally first — a truthy-to-truthy
    // switch to a DIFFERENT safeAddress used to skip straight to
    // fetchBalance() (status stays "ready" with the PRIOR account's
    // balance until the new fetch resolves); resetting first closes that
    // window instead of relying on fetchBalance's own "loading" flip.
    reset();
    if (account) void fetchBalance();
    // Re-fetch only when the signed-in Safe address itself changes (sign
    // in/out/restore) — not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.safeAddress]);

  if (!account) return null;

  return (
    <section className="flex flex-col gap-1" data-testid="real-cash-balance" aria-labelledby="real-cash-heading">
      <p id="real-cash-heading" className="text-sm text-muted-foreground">
        {CASH_LABEL}
      </p>

      {status === "idle" || status === "loading" ? (
        <div aria-busy="true" aria-label="Loading your balance" className="h-9 w-32 animate-pulse rounded-lg bg-muted/60" />
      ) : status === "ready" && balance ? (
        <div className="flex items-center gap-3">
          <p className="font-heading text-3xl font-semibold tracking-tight">{formatCashBaseUnits(balance.balanceBaseUnits, balance.decimals)}</p>
          <Button variant="outline" size="sm" onClick={() => void fetchBalance()}>
            Refresh
          </Button>
        </div>
      ) : status === "unauthenticated" ? (
        <p className="text-sm text-muted-foreground">Sign in to see your balance.</p>
      ) : status === "rate_limited" ? (
        // The server's own refusal — not a failed read and never a zero. The
        // wait shown is the server's, in honest units; with none, no promise.
        <div className="flex items-center gap-3" data-testid="real-cash-balance-limited">
          <p className="text-sm text-muted-foreground">
            Your balance can&apos;t be refreshed right now.{" "}
            {isCoolingDown ? (retryAfterSeconds !== null ? `Try again ${describeWait(retryAfterSeconds)}.` : "Try again in a little while.") : "You can try again."}
          </p>
          <Button variant="outline" size="sm" disabled={isCoolingDown} onClick={() => void fetchBalance()}>
            Try again
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <p className="text-sm text-destructive">Couldn&apos;t load your balance{error ? `: ${error}` : "."}</p>
          <Button variant="outline" size="sm" disabled={isCoolingDown} onClick={() => void fetchBalance()}>
            Retry
          </Button>
        </div>
      )}
    </section>
  );
}
