"use client";

import { getAssetValueMicroUsd } from "@/simulation";
import { useHasSimulationHydrated, useSimulationStore } from "@/lib/stores/simulation-store";
import { formatUsd } from "@/lib/format";
import { PRODUCT_AREAS_BY_ID } from "@/lib/product-areas";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shell/page-header";
import { Note } from "@/components/shell/note";

export function PayView() {
  const state = useSimulationStore((s) => s.state);
  const hasHydrated = useHasSimulationHydrated();
  const area = PRODUCT_AREAS_BY_ID.pay;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={area.label} purpose={area.purpose} />

      <section className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">Ready to spend</p>
        {hasHydrated ? (
          <p className="font-heading text-4xl leading-none font-semibold tracking-tight tabular-nums">
            {formatUsd(getAssetValueMicroUsd(state, "USDC"))}
          </p>
        ) : (
          <div aria-hidden="true" className="h-10 w-44 animate-pulse rounded-lg bg-muted" />
        )}
      </section>

      <section className="flex flex-col gap-3">
        <Button size="lg" className="h-12 w-full" disabled>
          Send money
        </Button>
        <div className="grid grid-cols-3 gap-2">
          <Button variant="outline" className="h-11" disabled>
            Request
          </Button>
          <Button variant="outline" className="h-11" disabled>
            Add money
          </Button>
          <Button variant="outline" className="h-11" disabled>
            Cash out
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Sending and requesting money arrives with the next update.
        </p>
      </section>

      <Note title="What you'll be able to do">
        Send money to someone, ask them for it, and move money in and out of your balance — with
        simulated money first, so a mistake costs nothing.
      </Note>
    </div>
  );
}
