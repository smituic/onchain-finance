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

export function BorrowView() {
  const state = useSimulationStore((s) => s.state);
  const hasHydrated = useHasSimulationHydrated();
  const area = PRODUCT_AREAS_BY_ID.borrow;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={area.label} purpose={area.purpose} />

      <section className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">Borrowed</p>
        <p className="font-heading text-4xl leading-none font-semibold tracking-tight tabular-nums">
          {formatUsd(0)}
        </p>
        <p className="text-sm text-muted-foreground">You don&apos;t owe anything.</p>
      </section>

      <section className="flex flex-col gap-3">
        <Button size="lg" className="h-12 w-full" disabled>
          Borrow money
        </Button>
        <Button variant="outline" className="h-11 w-full" disabled>
          Repay
        </Button>
        <p className="text-sm text-muted-foreground">
          Borrowing and repaying arrives with the next update.
        </p>
      </section>

      <Card>
        <CardContent className="divide-y divide-border py-0">
          <ValueRow
            label="Crypto you could put up"
            value={formatUsd(getAssetValueMicroUsd(state, "ETH"))}
            hint="Nothing is locked up right now"
            loading={!hasHydrated}
          />
          <ValueRow label="Available to borrow" value="—" hint="Set once borrowing is switched on" muted />
        </CardContent>
      </Card>

      <Note title="How borrowing will work">
        You keep what you own and put it up as a guarantee, then borrow against it — no credit check,
        and you can pay it back whenever. The catch: if what you put up drops far enough in value, some
        of it gets sold to cover what you owe. Before you borrow anything, you&apos;ll be able to test
        exactly that — move the market yourself and watch what happens to your position.
      </Note>
    </div>
  );
}
