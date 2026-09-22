"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Expander } from "@/components/shell/expander";
import { useRealAccountStore } from "@/lib/stores/real-account-store";
import { useRealBalanceStore } from "@/lib/stores/real-balance-store";
import { useRealPaymentStore } from "@/lib/stores/real-payment-store";
import { CASH_LABEL, formatCashBaseUnits } from "@/lib/real/display/cash";
import { REAL_CASH_TOKEN } from "@/lib/real/constants";
import { exceedsAvailableBalance, parseCashInputToBaseUnits } from "@/lib/real/payments/amount";
import { normalizeAddress } from "@/lib/real/identifiers";

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatAmount(amountBaseUnits: string): string {
  return formatCashBaseUnits(amountBaseUnits, REAL_CASH_TOKEN.decimals);
}

/**
 * Real Pay's send flow (Batch 2d) — Cash / recipient / amount / review /
 * approve / sending / sent throughout, no USDC/Safe/UserOperation/
 * EntryPoint/Pimlico/gas/calldata in the primary copy (that detail lives
 * behind the Expander for the confirmed state, developer-only). Renders
 * nothing until an account exists — AccountSetup/CashBalance own that state.
 */
export function RealPayForm() {
  const account = useRealAccountStore((s) => s.account);
  const balance = useRealBalanceStore((s) => s.balance);

  const status = useRealPaymentStore((s) => s.status);
  const recipientInput = useRealPaymentStore((s) => s.recipientInput);
  const amountInput = useRealPaymentStore((s) => s.amountInput);
  const attempt = useRealPaymentStore((s) => s.attempt);
  const isAuthorizing = useRealPaymentStore((s) => s.isAuthorizing);
  const error = useRealPaymentStore((s) => s.error);
  const init = useRealPaymentStore((s) => s.init);
  const setRecipientInput = useRealPaymentStore((s) => s.setRecipientInput);
  const setAmountInput = useRealPaymentStore((s) => s.setAmountInput);
  const review = useRealPaymentStore((s) => s.review);
  const editAgain = useRealPaymentStore((s) => s.editAgain);
  const confirmAndSend = useRealPaymentStore((s) => s.confirmAndSend);
  const resumeAuthorization = useRealPaymentStore((s) => s.resumeAuthorization);
  const cancel = useRealPaymentStore((s) => s.cancel);
  const checkStatus = useRealPaymentStore((s) => s.checkStatus);
  const reset = useRealPaymentStore((s) => s.reset);

  useEffect(() => {
    // Pre-2f hardening: the else branch matters — without it, logging out
    // (account -> null) left this store's recipient/amount/attempt/error
    // untouched, so they could survive into whatever account signs in
    // next. init() itself also resets first (see real-payment-store.ts),
    // so "reset before init" holds either way this effect fires.
    if (account) {
      void init();
    } else {
      reset();
    }
    // Re-check only when the signed-in account itself changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.safeAddress]);

  useEffect(() => {
    // A freshly-submitted operation is usually confirmed within a few
    // seconds on testnet — one best-effort check, not a polling loop. The
    // user (or a later mount) can always tap "Check status" again.
    if (status === "submitted") void checkStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  if (!account) return null;

  if (status === "idle") {
    return <div aria-busy="true" aria-label="Loading" className="h-24 animate-pulse rounded-xl bg-muted/60" data-testid="real-pay-form-loading" />;
  }

  const amountBaseUnits = parseCashInputToBaseUnits(amountInput);
  const insufficientLive = Boolean(balance && amountBaseUnits && exceedsAvailableBalance(amountBaseUnits, balance.balanceBaseUnits));

  if (status === "editing") {
    return (
      <form
        className="flex flex-col gap-4"
        data-testid="real-pay-form"
        onSubmit={(event) => {
          event.preventDefault();
          review();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="real-pay-recipient">Recipient</Label>
          <Input
            id="real-pay-recipient"
            autoComplete="off"
            placeholder="0x…"
            value={recipientInput}
            onChange={(event) => setRecipientInput(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="real-pay-amount">Amount</Label>
            <span className="text-xs text-muted-foreground">
              {balance ? `${formatAmount(balance.balanceBaseUnits)} available` : "Checking your balance…"}
            </span>
          </div>
          <Input
            id="real-pay-amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={amountInput}
            onChange={(event) => setAmountInput(event.target.value)}
          />
          {insufficientLive ? <p className="text-sm text-destructive">That&apos;s more than your available Cash.</p> : null}
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <Button type="submit" size="lg" className="h-12 w-full">
          Review
        </Button>
      </form>
    );
  }

  if (status === "reviewing") {
    return (
      <div className="flex flex-col gap-4" data-testid="real-pay-review">
        <div className="flex flex-col gap-2 rounded-xl bg-muted/60 px-4 py-3.5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Recipient</span>
            <span className="font-medium">{short(normalizeAddress(recipientInput) ?? recipientInput.trim())}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Amount</span>
            <span className="font-medium">{amountBaseUnits ? formatAmount(amountBaseUnits) : "—"}</span>
          </div>
          {balance && amountBaseUnits ? (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{CASH_LABEL} remaining</span>
              <span className="font-medium">{formatAmount(subtractBaseUnits(balance.balanceBaseUnits, amountBaseUnits))}</span>
            </div>
          ) : null}
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <div className="flex flex-col gap-2">
          <Button size="lg" className="h-12 w-full" onClick={() => void confirmAndSend()}>
            Approve
          </Button>
          <Button variant="ghost" className="h-11 w-full" onClick={editAgain}>
            Edit
          </Button>
        </div>
      </div>
    );
  }

  if (status === "preparing") {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl bg-muted/60 px-4 py-6 text-center" role="status" data-testid="real-pay-preparing">
        <p className="text-sm font-medium">Preparing your payment…</p>
      </div>
    );
  }

  if (status === "awaiting_authorization") {
    if (isAuthorizing) {
      return (
        <div className="flex flex-col items-center gap-2 rounded-xl bg-muted/60 px-4 py-6 text-center" role="status" data-testid="real-pay-authorizing">
          <p className="text-sm font-medium">Confirm with your passkey…</p>
          <p className="text-xs text-muted-foreground">Follow the prompt from your device.</p>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-4" data-testid="real-pay-resume">
        <div className="flex flex-col gap-2 rounded-xl bg-muted/60 px-4 py-3.5">
          <p className="text-sm font-medium">A payment is waiting for your approval</p>
          {attempt ? (
            <p className="text-sm text-muted-foreground">
              {formatAmount(attempt.amountBaseUnits)} to {short(attempt.recipient)}
            </p>
          ) : null}
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="flex flex-col gap-2">
          <Button size="lg" className="h-12 w-full" onClick={() => void resumeAuthorization()}>
            Continue
          </Button>
          <Button variant="ghost" className="h-11 w-full" onClick={() => void cancel()}>
            Cancel payment
          </Button>
        </div>
      </div>
    );
  }

  if (status === "stranded") {
    return (
      <div className="flex flex-col gap-4" data-testid="real-pay-stranded">
        <div className="flex flex-col gap-1 rounded-xl bg-muted/60 px-4 py-3.5">
          <p className="text-sm font-medium">This payment didn&apos;t go through</p>
          <p className="text-sm text-muted-foreground">It was never sent. You can safely cancel it and try again.</p>
        </div>
        <Button variant="outline" className="h-11 w-full" onClick={() => void cancel()}>
          Cancel payment
        </Button>
      </div>
    );
  }

  if (status === "submitting" || status === "submitted") {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl bg-muted/60 px-4 py-6 text-center" role="status" data-testid="real-pay-sending">
        <p className="text-sm font-medium">Sending…</p>
        {status === "submitted" ? (
          <Button variant="outline" size="sm" onClick={() => void checkStatus()}>
            Check status
          </Button>
        ) : null}
      </div>
    );
  }

  if (status === "confirmed" && attempt) {
    return (
      <div className="flex flex-col gap-4" data-testid="real-pay-confirmed">
        <div className="flex flex-col gap-1 rounded-xl bg-muted/60 px-4 py-3.5" role="status">
          <p className="text-sm font-medium">Sent</p>
          <p className="text-sm text-muted-foreground">
            {formatAmount(attempt.amountBaseUnits)} to {short(attempt.recipient)}
          </p>
        </div>
        {attempt.transactionHash ? (
          <Expander question="See transaction details">
            <p>Transaction: {attempt.transactionHash}</p>
          </Expander>
        ) : null}
        <Button variant="outline" className="h-11 w-full" onClick={reset}>
          Send another payment
        </Button>
      </div>
    );
  }

  if (status === "failed") {
    return (
      <div className="flex flex-col gap-4" data-testid="real-pay-failed">
        <p className="text-sm text-destructive">{attempt?.failureReason ?? error ?? "This payment could not be sent."}</p>
        <Button className="h-11 w-full" onClick={reset}>
          Try again
        </Button>
      </div>
    );
  }

  if (status === "unknown") {
    return (
      <div className="flex flex-col gap-4" data-testid="real-pay-unknown">
        <div className="flex flex-col gap-1 rounded-xl bg-muted/60 px-4 py-3.5">
          <p className="text-sm font-medium">We&apos;re checking on this payment</p>
          <p className="text-sm text-muted-foreground">
            It may have already gone through. We&apos;ll show the result here once we know — sending another payment is
            disabled until this one resolves.
          </p>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button variant="outline" className="h-11 w-full" onClick={() => void checkStatus()}>
          Check status
        </Button>
      </div>
    );
  }

  return null;
}

/** Both operands are non-negative base-10 integer strings — safe as a BigInt subtraction purely for a display-only "remaining" figure (never used to authorize anything; the server independently re-checks the live balance at prepare time). */
function subtractBaseUnits(balance: string, amount: string): string {
  const result = BigInt(balance) - BigInt(amount);
  return result > BigInt(0) ? result.toString() : "0";
}
