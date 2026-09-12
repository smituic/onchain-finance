import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { PRODUCT_AREAS_BY_ID } from "@/lib/product-areas";
import { PageHeader } from "@/components/shell/page-header";
import { EXPLORE_EXPERIMENTS, type Experiment } from "@/components/explore/experiments";

export function ExploreView() {
  const area = PRODUCT_AREAS_BY_ID.explore;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={area.label} purpose={area.purpose} />

      <ul className="flex flex-col gap-3">
        {EXPLORE_EXPERIMENTS.map((experiment) => (
          <li key={experiment.id}>
            <ExperimentCard experiment={experiment} />
          </li>
        ))}
      </ul>

      <p className="text-sm leading-relaxed text-muted-foreground">
        Each experiment is something you do, not something you read.
      </p>
    </div>
  );
}

function ExperimentCard({ experiment }: { experiment: Experiment }) {
  return (
    <Link
      href={`/explore/${experiment.id}`}
      className="flex items-center justify-between gap-4 rounded-xl px-4 py-4 ring-1 ring-foreground/10 transition-colors hover:bg-muted"
    >
      <span className="flex flex-col gap-1.5">
        <span className="font-heading text-base font-medium">{experiment.question}</span>
        <span className="text-sm text-muted-foreground">{experiment.hook}</span>
      </span>
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    </Link>
  );
}
