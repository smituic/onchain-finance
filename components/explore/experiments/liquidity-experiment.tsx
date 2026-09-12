"use client";

import { useState } from "react";
import {
  getAssetValueMicroUsd,
  getPoolSpotPriceMicroUsd,
  getPriceMicroUsd,
  toMicroUnits,
  type SwapReceipt,
} from "@/simulation";
import { useExperimentSimulation } from "@/lib/explore/use-experiment-simulation";
import { formatAssetAmount, formatPriceImpactPercent, formatUsd } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ValueRow } from "@/components/shell/value-row";
import { Note } from "@/components/shell/note";
import { Expander } from "@/components/shell/expander";
import { ExperimentShell } from "@/components/explore/experiment-shell";
import { EXPLORE_EXPERIMENTS_BY_ID } from "@/components/explore/experiments";

type Sale = { ethSoldMicroUnits: number; receipt: SwapReceipt };

const HALF_ETH = toMicroUnits(0.5);
const TWO_ETH = toMicroUnits(2);

export function LiquidityExperiment() {
  const experiment = EXPLORE_EXPERIMENTS_BY_ID.liquidity;
  const { state, version, dispatch, reset: resetSandbox } = useExperimentSimulation("liquidity");
  const [lastSale, setLastSale] = useState<Sale | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ethBalance = state.balances.ETH;
  const ethValueMicroUsd = getAssetValueMicroUsd(state, "ETH");
  const marketPriceMicroUsd = getPriceMicroUsd(state, "ETH");
  // Selling ETH into the pool only ever grows its ETH reserve (the swap
  // pays ETH in), so it can never hit zero here and this is always defined.
  const poolSpotMicroUsd = getPoolSpotPriceMicroUsd(state.pool);

  function sell(amountIn: number) {
    if (amountIn <= 0 || amountIn > ethBalance) return;
    const result = dispatch({ type: "swap", fromAsset: "ETH", toAsset: "USDC", amountIn });
    if (!result.ok || !result.swap) {
      setError(!result.ok ? result.error : "That trade produced no output at current liquidity.");
      return;
    }
    setError(null);
    setLastSale({ ethSoldMicroUnits: amountIn, receipt: result.swap });
  }

  function reset() {
    resetSandbox();
    setLastSale(null);
    setError(null);
  }

  return (
    <ExperimentShell experiment={experiment} onReset={reset} canReset={version > 0}>
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">Your ETH, at the going rate</p>
          <p className="font-heading text-4xl leading-none font-semibold tracking-tight tabular-nums">
            {formatUsd(ethValueMicroUsd)}
          </p>
          <p className="text-sm text-muted-foreground">
            {formatAssetAmount(ethBalance, "ETH")} at {formatUsd(marketPriceMicroUsd)} per ETH.
          </p>
        </section>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        {lastSale ? (
          <Note title="What changed">
            <p>
              At the going rate, that {formatAssetAmount(lastSale.ethSoldMicroUnits, "ETH")} looked like it should
              bring back about {formatUsd(lastSale.receipt.referenceAmountOut)}. It actually brought back{" "}
              {formatUsd(lastSale.receipt.amountOut)} —{" "}
              {formatUsd(lastSale.receipt.referenceAmountOut - lastSale.receipt.amountOut)} less, a{" "}
              {formatPriceImpactPercent(lastSale.receipt.priceImpactBps)} price impact.
            </p>
          </Note>
        ) : null}

        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Sell some ETH</p>
          <div className="grid gap-2">
            <Button
              variant="outline"
              className="h-11"
              disabled={ethBalance < HALF_ETH}
              onClick={() => sell(HALF_ETH)}
            >
              Sell 0.5 ETH
            </Button>
            <Button
              variant="outline"
              className="h-11"
              disabled={ethBalance < TWO_ETH}
              onClick={() => sell(TWO_ETH)}
            >
              Sell 2 ETH
            </Button>
            <Button
              variant="outline"
              className="h-11"
              disabled={ethBalance <= 0}
              onClick={() => sell(ethBalance)}
            >
              Sell all remaining ETH
            </Button>
          </div>
        </div>

        <Card>
          <CardContent className="divide-y divide-border py-0">
            <ValueRow label="ETH remaining" value={formatAssetAmount(ethBalance, "ETH")} />
            <ValueRow
              label="Pool price now"
              value={formatUsd(poolSpotMicroUsd)}
              hint="What the next small trade would get"
            />
          </CardContent>
        </Card>

        <Note title="Why didn't I get the full value?">
          <p>
            Trades are filled from a pool of funds sitting right there, not from every buyer in the world at once.
            The bigger your trade is compared with what&apos;s in the pool, the more the price moves against you
            while your own trade is filling.
          </p>
          <Expander question="Why does this matter for something 'valuable'?">
            <p>
              A price only tells you what the last small trade cleared at. It doesn&apos;t promise that your whole
              position can sell at that price — that depends on how much liquidity is sitting behind it. Something
              can be genuinely valuable and still be hard to sell all at once.
            </p>
            <p>
              This gap between a quoted price and what a large trade actually receives is called price impact. Here
              it&apos;s driven by the pool&apos;s liquidity — the more of an asset (and its pair) sitting in the pool,
              the smaller the impact of any one trade.
            </p>
          </Expander>
        </Note>
      </div>
    </ExperimentShell>
  );
}
