"use client";

import { getAssetValueMicroUsd } from "@/simulation";
import { useHasSimulationHydrated, useSimulationStore } from "@/lib/stores/simulation-store";
import { formatUsd } from "@/lib/format";
import { PRODUCT_AREAS_BY_ID } from "@/lib/product-areas";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/shell/page-header";
import { ValueRow } from "@/components/shell/value-row";
import { Note } from "@/components/shell/note";

export function SaveView() {
  const state = useSimulationStore((s) => s.state);
  const hasHydrated = useHasSimulationHydrated();
  const area = PRODUCT_AREAS_BY_ID.save;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={area.label} purpose={area.purpose} />

      <section className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">In savings</p>
        <p className="font-heading text-4xl leading-none font-semibold tracking-tight tabular-nums">
          {formatUsd(0)}
        </p>
        <p className="text-sm text-muted-foreground">You haven&apos;t set anything aside yet.</p>
      </section>

      <section className="flex flex-col gap-3">
        <Button size="lg" className="h-12 w-full" disabled>
          Add money
        </Button>
        <Button variant="outline" className="h-11 w-full" disabled>
          Withdraw
        </Button>
        <p className="text-sm text-muted-foreground">
          Adding and withdrawing money arrives with the next update.
        </p>
      </section>

      <Card>
        <CardContent className="divide-y divide-border py-0">
          <ValueRow
            label="Available to add"
            value={formatUsd(getAssetValueMicroUsd(state, "USDC"))}
            hint="Your cash"
            loading={!hasHydrated}
          />
          <ValueRow label="Interest earned" value={formatUsd(0)} muted />
          <ValueRow label="Current rate" value="—" hint="Set once saving is switched on" muted />
        </CardContent>
      </Card>

      <Note title="Where the growth comes from">
        Money you save doesn&apos;t sit still — it&apos;s lent out to people who want to borrow, and they
        pay to borrow it. That payment is what makes your balance grow. You&apos;ll see the rate before
        you put anything in, and you can take your money out whenever you want.
      </Note>
    </div>
  );
}
