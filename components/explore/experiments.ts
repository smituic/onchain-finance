import type { ExperimentId } from "@/lib/explore/experiment-state";
import type { ProductAreaId } from "@/lib/product-areas";

/**
 * Explore's single source of truth: one entry per interactive experiment.
 * The route is always derived as /explore/<id> (see
 * app/explore/[experimentId]/page.tsx) — there is no separate href to drift
 * out of sync with an id, and every entry here is playable inside Explore
 * itself, never a link-only placeholder.
 */
export type Experiment = {
  id: ExperimentId;
  /** The question the experiment answers — the entry point's title. */
  question: string;
  /** What the user will actually do, in one line. Not a summary of an answer. */
  hook: string;
  /** The full feature area this experiment's mechanics come from, for its "Open full X" link. */
  areaId: ProductAreaId;
};

export const EXPLORE_EXPERIMENTS: Experiment[] = [
  {
    id: "liquidity",
    question: "You own $30,000 of ETH. Can you sell it for $30,000?",
    hook: "Sell a little, then sell it all, and compare what actually lands in your account.",
    areaId: "swap",
  },
  {
    id: "liquidation",
    question: "What happens if ETH falls?",
    hook: "You've borrowed against ETH. Drop the price and watch the loan.",
    areaId: "borrow",
  },
  {
    id: "yield",
    question: "What does a 4% annual rate look like over time?",
    hook: "Put $1,000 in savings and skip ahead, a few months at a time.",
    areaId: "save",
  },
  {
    id: "risk",
    question: "Why not put everything in whatever grows fastest?",
    hook: "Buy three different investments, then move the market once.",
    areaId: "invest",
  },
  {
    id: "payments",
    question: "What actually happens when you send money?",
    hook: "Send $25, then request $25, and see which one actually moves money.",
    areaId: "pay",
  },
];

export const EXPLORE_EXPERIMENTS_BY_ID = Object.fromEntries(
  EXPLORE_EXPERIMENTS.map((experiment) => [experiment.id, experiment]),
) as Record<ExperimentId, Experiment>;
