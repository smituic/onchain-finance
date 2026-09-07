"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { AssetId, SwapReceipt } from "@/simulation";
import { formatAssetAmount, formatPriceImpactPercent } from "@/lib/format";
import { Button } from "@/components/ui/button";

/**
 * Below this, a trade's execution is close enough to the pool's reference
 * price that explaining "why did I receive less" would be noise rather than
 * education. A UI-layer display threshold only — not a change to swap math.
 */
const PRICE_IMPACT_EXPLAINER_THRESHOLD_BPS = 10;

export function PriceImpactNote({ receipt, toAsset }: { receipt: SwapReceipt; toAsset: AssetId }) {
  const [expanded, setExpanded] = useState(false);

  if (receipt.priceImpactBps < PRICE_IMPACT_EXPLAINER_THRESHOLD_BPS) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 text-sm text-muted-foreground">
      <p>You&apos;re getting a little less than the current rate — larger trades move the price more.</p>

      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto self-start p-0 text-foreground"
        aria-expanded={expanded}
        aria-controls="price-impact-detail"
        onClick={() => setExpanded((value) => !value)}
      >
        Why did I receive less?
        <ChevronDown aria-hidden="true" className={expanded ? "size-4 rotate-180" : "size-4"} />
      </Button>

      {expanded ? (
        <div id="price-impact-detail" className="flex flex-col gap-1">
          <p>
            At the current rate, you&apos;d expect ≈ {formatAssetAmount(receipt.referenceAmountOut, toAsset)}. This
            trade receives {formatAssetAmount(receipt.amountOut, toAsset)} instead.
          </p>
          <p>
            Trades are filled from the pool&apos;s available funds. The larger your trade is compared with
            what&apos;s available, the more the price moves against you.
          </p>
          <p>
            This is called price impact. Here, it moved the price by{" "}
            {formatPriceImpactPercent(receipt.priceImpactBps)}.
          </p>
        </div>
      ) : null}
    </div>
  );
}
