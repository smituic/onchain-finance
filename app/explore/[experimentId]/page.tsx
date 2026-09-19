import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EXPLORE_EXPERIMENTS, EXPLORE_EXPERIMENTS_BY_ID } from "@/components/explore/experiments";
import { ExperimentView } from "@/components/explore/experiment-view";
import { ExploreModeNotice } from "@/components/explore/explore-mode-notice";
import type { ExperimentId } from "@/lib/explore/experiment-state";

export function generateStaticParams() {
  return EXPLORE_EXPERIMENTS.map((experiment) => ({ experimentId: experiment.id }));
}

function findExperiment(experimentId: string) {
  return EXPLORE_EXPERIMENTS_BY_ID[experimentId as ExperimentId] as
    | (typeof EXPLORE_EXPERIMENTS)[number]
    | undefined;
}

export async function generateMetadata({
  params,
}: PageProps<"/explore/[experimentId]">): Promise<Metadata> {
  const { experimentId } = await params;
  const experiment = findExperiment(experimentId);
  return {
    title: experiment ? `${experiment.question} — onchain-finance` : "Explore — onchain-finance",
  };
}

export default async function ExperimentPage({ params }: PageProps<"/explore/[experimentId]">) {
  const { experimentId } = await params;
  const experiment = findExperiment(experimentId);
  if (!experiment) notFound();

  // Not wrapped in ByMode: experiments always run on separate Practice money.
  return (
    <div className="flex flex-col gap-6">
      <ExploreModeNotice />
      <ExperimentView experimentId={experiment.id} />
    </div>
  );
}
