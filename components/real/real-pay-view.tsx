"use client";

import { useModeStore } from "@/lib/stores/mode-store";
import { PRODUCT_AREAS_BY_ID } from "@/lib/product-areas";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shell/page-header";
import { Note } from "@/components/shell/note";
import { AccountSetup } from "@/components/real/account-setup";
import { CashBalance } from "@/components/real/cash-balance";
import { RealPayForm } from "@/components/real/real-pay-form";
import { RealPaymentHistory } from "@/components/real/real-payment-history";
import { useRealAccountStore } from "@/lib/stores/real-account-store";

/**
 * Real Mode's Pay. Pay is where Real Mode starts, so this is where account
 * setup lives; once an account exists, its real Cash balance (CashBalance)
 * and the send flow (RealPayForm, Batch 2d) are shown here.
 */
export function RealPayView() {
  const area = PRODUCT_AREAS_BY_ID.pay;
  const setMode = useModeStore((s) => s.setMode);
  const account = useRealAccountStore((s) => s.account);

  return (
    <div className="flex flex-col gap-8" data-testid="real-pay">
      <PageHeader title={area.label} purpose={area.purpose} />

      <section className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">Real Mode</p>
        <h2 className="font-heading text-xl font-semibold tracking-tight">
          {account ? "Send Cash" : "Real Pay is next"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {account
            ? "Send test Cash to another Base Sepolia address. Each payment needs a fresh passkey approval."
            : "The next step is connecting a real account and showing its real test-network Cash balance."}
        </p>
      </section>

      <CashBalance />

      {account ? <RealPayForm /> : null}

      {account ? <RealPaymentHistory /> : null}

      <AccountSetup />

      <Note title="Testnet only">
        <p>
          Real Mode runs on a test network for now. Test Cash has no value, and no real dollars move — this is the
          groundwork for the real thing, not the real thing yet.
        </p>
      </Note>

      <Button variant="outline" className="h-11 w-full" onClick={() => setMode("practice")}>
        Use Pay in Practice for now
      </Button>
    </div>
  );
}
