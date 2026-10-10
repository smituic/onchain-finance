"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Expander } from "@/components/shell/expander";
import { useRealAccountStore } from "@/lib/stores/real-account-store";
import { useRealPaymentHistoryStore, type PaymentHistoryEntry } from "@/lib/stores/real-payment-history-store";
import { formatCashBaseUnits } from "@/lib/real/display/cash";
import { paymentStatusLabel } from "@/lib/real/display/payment-status";
import { describePaymentRecipient } from "@/lib/real/display/payment-recipient";
import { formatHandle } from "@/lib/real/handle";
import { normalizeHash } from "@/lib/real/identifiers";
import { BASE_SEPOLIA_EXPLORER_TX_BASE_URL, REAL_CASH_TOKEN } from "@/lib/real/constants";

/** Only ever called after a client-side fetch resolves (see the loading branch below) — never during a server-rendered first paint — so a fixed locale is enough to keep this hydration-safe without any extra "mounted" gating. */
function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function HistoryRow({ entry }: { entry: PaymentHistoryEntry }) {
  // normalizeHash enforces ^0x[0-9a-fA-F]{64}$ (lib/real/identifiers.ts) —
  // an absent or malformed hash renders neither the raw text nor the
  // explorer link, and the link is only ever built from this validated,
  // normalized value, never the raw field.
  const validTxHash = normalizeHash(entry.transactionHash);
  // Slice D: a handle payment is shown by the name it was sent to (the
  // payment's own stored snapshot, whatever its outcome); an address payment
  // by its address. Nothing is looked up, and an address is never turned
  // into a name.
  const recipient = describePaymentRecipient(entry);

  return (
    <li data-testid={`real-payment-history-row-${entry.id}`} className="flex flex-col gap-1 rounded-xl bg-muted/60 px-4 py-3.5">
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm font-medium">{formatCashBaseUnits(entry.amountBaseUnits, REAL_CASH_TOKEN.decimals)}</span>
        <span className="text-sm font-medium">{paymentStatusLabel(entry.state)}</span>
      </div>
      <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
        {recipient.kind === "handle" ? (
          // A long display name truncates; the @handle beside it never does.
          <span className="flex min-w-0 gap-1" data-testid="real-payment-history-recipient" title={recipient.label}>
            <span className="shrink-0">To</span>
            {recipient.displayName !== null ? <span className="min-w-0 truncate">{recipient.displayName}</span> : null}
            <span className="shrink-0">{recipient.displayName !== null ? `(${formatHandle(recipient.handle)})` : formatHandle(recipient.handle)}</span>
          </span>
        ) : (
          <span data-testid="real-payment-history-recipient">To {recipient.label}</span>
        )}
        <span className="shrink-0">{formatWhen(entry.createdAt)}</span>
      </div>
      {validTxHash ? (
        <Expander question="See transaction details">
          <p className="break-all">Transaction: {validTxHash}</p>
          <a
            href={`${BASE_SEPOLIA_EXPLORER_TX_BASE_URL}/${validTxHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground underline underline-offset-2"
          >
            View on Base Sepolia explorer
          </a>
        </Expander>
      ) : null}
    </li>
  );
}

/**
 * Batch 2e: a bounded, read-only view over payment_attempts — "payments
 * made through this app," not a chain-wide activity feed. Strictly passive:
 * Refresh only re-fetches this list; there is no per-row status check and
 * nothing here ever calls /prepare, /submit, /cancel, or /status. Renders
 * nothing until an account exists, same gating CashBalance/RealPayForm use.
 */
export function RealPaymentHistory() {
  const account = useRealAccountStore((s) => s.account);
  const entries = useRealPaymentHistoryStore((s) => s.entries);
  const status = useRealPaymentHistoryStore((s) => s.status);
  const error = useRealPaymentHistoryStore((s) => s.error);
  const fetchHistory = useRealPaymentHistoryStore((s) => s.fetchHistory);
  const reset = useRealPaymentHistoryStore((s) => s.reset);

  useEffect(() => {
    // Pre-2f hardening: reset unconditionally first — see cash-balance.tsx's
    // identical fix for why a truthy-to-truthy address switch needs this
    // too, not just the truthy-to-falsy (logout) case.
    reset();
    if (account) void fetchHistory();
    // Re-fetch only when the signed-in Safe address itself changes — not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.safeAddress]);

  if (!account) return null;

  return (
    <section className="flex flex-col gap-3" data-testid="real-payment-history" aria-labelledby="real-payment-history-heading">
      <div className="flex items-baseline justify-between">
        <h2 id="real-payment-history-heading" className="font-heading text-sm font-medium">
          Recent activity
        </h2>
        {status === "ready" ? (
          <Button variant="ghost" size="sm" className="h-auto p-0 text-xs text-muted-foreground hover:text-foreground" onClick={() => void fetchHistory()}>
            Refresh
          </Button>
        ) : null}
      </div>

      {status === "idle" || status === "loading" ? (
        <div aria-busy="true" aria-label="Loading your recent payments" className="h-16 animate-pulse rounded-xl bg-muted/60" />
      ) : status === "unauthenticated" ? (
        <p className="text-sm text-muted-foreground">Sign in to see your recent payments.</p>
      ) : status === "error" ? (
        <div className="flex items-center gap-3">
          <p className="text-sm text-destructive">Couldn&apos;t load your recent payments{error ? `: ${error}` : "."}</p>
          <Button variant="outline" size="sm" onClick={() => void fetchHistory()}>
            Retry
          </Button>
        </div>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No payments yet — Cash you send will show up here.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {entries.map((entry) => (
            <HistoryRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </section>
  );
}
