import { formatUsd } from "@/lib/format";

/**
 * Below this gap between Swap's pool execution price and Practice's market
 * valuation price, calling out the difference would be noise rather than
 * education — mirrors PRICE_IMPACT_EXPLAINER_THRESHOLD_BPS's role in
 * price-impact-note.tsx. A UI-layer display threshold only; it doesn't
 * change either price.
 */
const DIVERGENCE_EXPLAINER_THRESHOLD_BPS = 100;

/**
 * How far the pool's execution price has drifted from the market valuation
 * price, in basis points, unsigned. Pure so it's cheap to test on its own —
 * it doesn't recompute either price, only compares the two callers already
 * have.
 */
export function getRateDivergenceBps(marketPriceMicroUsd: number, poolPriceMicroUsd: number): number {
  if (marketPriceMicroUsd <= 0) return 0;
  const diff = Math.abs(poolPriceMicroUsd - marketPriceMicroUsd);
  return Math.round((diff * 10_000) / marketPriceMicroUsd);
}

/**
 * Explains, calmly, when Swap's rate and ETH's Practice valuation have
 * drifted apart — which can happen because a Borrow crash scenario moves
 * the market price without trading against the pool, or a large swap moves
 * the pool without touching the market price. See ARCHITECTURE.md and
 * simulation/README.md for why the two prices are deliberately separate.
 */
export function RateDivergenceNote({
  marketPriceMicroUsd,
  poolPriceMicroUsd,
}: {
  marketPriceMicroUsd: number;
  poolPriceMicroUsd: number;
}) {
  const divergenceBps = getRateDivergenceBps(marketPriceMicroUsd, poolPriceMicroUsd);
  if (divergenceBps < DIVERGENCE_EXPLAINER_THRESHOLD_BPS) return null;

  return (
    <p className="text-xs text-muted-foreground">
      ETH is valued at {formatUsd(marketPriceMicroUsd)} elsewhere in Practice. Swap rates come from
      the trading pool and can differ.
    </p>
  );
}
