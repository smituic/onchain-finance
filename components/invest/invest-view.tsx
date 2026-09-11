import Link from "next/link";
import { PRODUCT_AREAS_BY_ID } from "@/lib/product-areas";
import { formatUsd } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shell/page-header";
import { Note } from "@/components/shell/note";

/**
 * The curated set Invest will open with — deliberately a handful of
 * categories a person recognises, not a token list. Informational until the
 * investing engine exists; none of these are holdings.
 */
const PLANNED_CATEGORIES = [
  { name: "Crypto", description: "A small set of well-known crypto assets." },
  { name: "Cash equivalents", description: "Short-term government debt, held as a stable, low-risk place to park money." },
  { name: "Broad market", description: "One fund that spreads your money across many companies at once." },
];

export function InvestView() {
  const area = PRODUCT_AREAS_BY_ID.invest;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={area.label} purpose={area.purpose} />

      <section className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">Invested</p>
        <p className="font-heading text-4xl leading-none font-semibold tracking-tight tabular-nums">
          {formatUsd(0)}
        </p>
        <p className="text-sm text-muted-foreground">You haven&apos;t invested anything yet.</p>
      </section>

      <section className="flex flex-col gap-3">
        <Button size="lg" className="h-12 w-full" disabled>
          Browse investments
        </Button>
        <p className="text-sm text-muted-foreground">
          Buying and selling investments arrives with the next update.
        </p>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="planned-heading">
        <h2 id="planned-heading" className="font-heading text-sm font-medium">
          What you&apos;ll be able to invest in
        </h2>
        <ul className="flex flex-col gap-2">
          {PLANNED_CATEGORIES.map((category) => (
            <li key={category.name} className="flex flex-col gap-1 rounded-xl bg-muted/60 px-4 py-3.5">
              <span className="text-sm font-medium">{category.name}</span>
              <span className="text-sm text-muted-foreground">{category.description}</span>
            </li>
          ))}
        </ul>
      </section>

      <Note title="Already hold crypto?">
        Crypto you picked up in{" "}
        <Link href="/swap" className="text-foreground underline underline-offset-4">
          Swap
        </Link>{" "}
        shows on Home under Crypto for now. Once investing is switched on, everything you own will sit
        in one portfolio here.
      </Note>
    </div>
  );
}
