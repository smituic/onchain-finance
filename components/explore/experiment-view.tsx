"use client";

import type { ExperimentId } from "@/lib/explore/experiment-state";
import { LiquidityExperiment } from "@/components/explore/experiments/liquidity-experiment";
import { LiquidationExperiment } from "@/components/explore/experiments/liquidation-experiment";
import { YieldExperiment } from "@/components/explore/experiments/yield-experiment";
import { RiskExperiment } from "@/components/explore/experiments/risk-experiment";
import { PaymentsExperiment } from "@/components/explore/experiments/payments-experiment";

const EXPERIMENT_COMPONENTS: Record<ExperimentId, () => React.JSX.Element> = {
  liquidity: LiquidityExperiment,
  liquidation: LiquidationExperiment,
  yield: YieldExperiment,
  risk: RiskExperiment,
  payments: PaymentsExperiment,
};

/**
 * Routes an experiment id to its sandbox component. Kept separate from the
 * catalog in experiments.ts so that file (imported by Home for its
 * featured cards) never pulls all five sandbox components into that bundle.
 */
export function ExperimentView({ experimentId }: { experimentId: ExperimentId }) {
  const Component = EXPERIMENT_COMPONENTS[experimentId];
  return <Component />;
}
