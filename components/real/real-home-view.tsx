"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { PRODUCT_AREAS_BY_ID } from "@/lib/product-areas";
import { Note } from "@/components/shell/note";

/**
 * Real Mode's Home before a real account exists. An honest placeholder:
 * there is no account, no balance, and no activity to show, and it says
 * so rather than inventing any. Nothing here reads Practice state — Real
 * Mode is a parallel path, not a view over the simulation.
 */
export function RealHomeView() {
  const pay = PRODUCT_AREAS_BY_ID.pay;

  return (
    <div className="flex flex-col gap-8" data-testid="real-home">
      <section className="flex flex-col gap-2 pt-2">
        <p className="text-sm text-muted-foreground">Real Mode</p>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Your real account isn&apos;t set up yet
        </h1>
        <p className="text-sm text-muted-foreground">
          Connecting a real, blockchain-backed account is the next step. Until then there&apos;s no balance or
          activity to show here.
        </p>
      </section>

      <Note title="What Real Mode is right now">
        <p>
          An early, development-only build that runs on a test network. Test Cash has no value, and no real dollars
          are involved.
        </p>
        <p className="mt-2">Practice Mode is untouched — switch back any time from the top of the screen.</p>
      </Note>

      <section className="flex flex-col gap-3" aria-labelledby="real-next-heading">
        <h2 id="real-next-heading" className="font-heading text-sm font-medium">
          What comes first
        </h2>
        <ol className="flex flex-col gap-2 text-sm text-muted-foreground">
          <li className="rounded-xl bg-muted/60 px-4 py-3.5">A real account, set up without seed phrases or extensions.</li>
          <li className="rounded-xl bg-muted/60 px-4 py-3.5">A real test-network Cash balance.</li>
          <li className="rounded-xl bg-muted/60 px-4 py-3.5">Sending Cash, with each payment&apos;s status as it happens.</li>
        </ol>
        <p className="text-xs text-muted-foreground">Save, Invest, Swap, and Borrow stay Practice-only until after that.</p>
      </section>

      <Link
        href={pay.href}
        className="flex items-center justify-between gap-4 rounded-xl px-4 py-4 ring-1 ring-foreground/10 transition-colors hover:bg-muted"
      >
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">{pay.label} in Real Mode</span>
          <span className="text-xs text-muted-foreground">Where Real Mode starts.</span>
        </span>
        <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </Link>
    </div>
  );
}
