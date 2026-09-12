"use client";

import { useState } from "react";
import { getInvestmentHoldings, INVESTMENT_ASSETS, type InvestmentHolding } from "@/simulation";
import { useExperimentSimulation } from "@/lib/explore/use-experiment-simulation";
import { formatSignedPercent, formatSignedUsd, formatUsd } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Note } from "@/components/shell/note";
import { Expander } from "@/components/shell/expander";
import { ExperimentShell } from "@/components/explore/experiment-shell";
import { EXPLORE_EXPERIMENTS_BY_ID } from "@/components/explore/experiments";

type MoveDirection = "up" | "down";

export function RiskExperiment() {
  const experiment = EXPLORE_EXPERIMENTS_BY_ID.risk;
  const { state, version, dispatch, reset: resetSandbox } = useExperimentSimulation("risk");
  const [appliedDirection, setAppliedDirection] = useState<MoveDirection | null>(null);

  const holdings = getInvestmentHoldings(state);

  function runScenario(direction: MoveDirection) {
    // Reset prices to genesis first, then apply this scenario's move — so
    // "the market falls" always means the same ±25% / ±10% / ±1% move,
    // whichever button (or sequence of buttons) was pressed before it.
    dispatch({ type: "reset-investment-prices" });
    const result = dispatch({ type: "simulate-investment-market-move", direction });
    if (!result.ok) return;
    setAppliedDirection(direction);
  }

  function reset() {
    resetSandbox();
    setAppliedDirection(null);
  }

  return (
    <ExperimentShell experiment={experiment} onReset={reset} canReset={version > 0}>
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-1.5">
          <p className="text-sm text-muted-foreground">$1,000 in each, same starting moment</p>
        </section>

        {appliedDirection ? (
          <Note title="What changed">
            <p>
              One event, three outcomes. The {appliedDirection === "up" ? "rise" : "fall"} moved every holding by
              its own amount — Bitcoin moved the most, Treasuries barely moved at all.
            </p>
          </Note>
        ) : null}

        <ul className="flex flex-col gap-2">
          {holdings.map((holding) => (
            <HoldingRow key={holding.assetId} holding={holding} />
          ))}
        </ul>

        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Move the market</p>
          <div className="grid gap-2">
            <Button variant="outline" className="h-11" onClick={() => runScenario("up")}>
              Market rises
            </Button>
            <Button variant="outline" className="h-11" onClick={() => runScenario("down")}>
              Market falls
            </Button>
          </div>
        </div>

        <Note title="Why not put everything in whatever grows fastest?">
          <p>
            The same move that made Bitcoin&apos;s swing the biggest works both ways — it&apos;s also what makes it
            fall the hardest. Spreading money across things that move differently is called diversification: it
            doesn&apos;t make any single asset less risky, but it keeps one bad day from deciding your whole
            portfolio.
          </p>
          <Expander question="What are these, underneath?">
            <p>
              A financial asset — a stock, a bond, a Treasury bill — can have a digital representation that moves on
              blockchain infrastructure instead of through a traditional brokerage. That&apos;s what
              &quot;tokenization&quot; means, and it changes how ownership is recorded and settled, not the
              underlying economics you just watched play out above.
            </p>
            <p>
              A token existing on a blockchain doesn&apos;t by itself give you legal ownership of a real-world
              asset. Real tokenized Treasuries, stocks, or funds depend on an issuer or legal structure behind the
              token, custody of the real asset, and clear rights to redeem the token for what it represents.
              Everything here in Practice Mode is simulated — there is no real Bitcoin, Treasury, or fund behind
              these numbers.
            </p>
          </Expander>
        </Note>
      </div>
    </ExperimentShell>
  );
}

function HoldingRow({ holding }: { holding: InvestmentHolding }) {
  const definition = INVESTMENT_ASSETS[holding.assetId];
  return (
    <li
      data-testid={`risk-holding-${holding.assetId}`}
      className="flex items-center justify-between gap-4 rounded-xl bg-muted/60 px-4 py-3.5"
    >
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{definition.name}</span>
        <span className="text-xs text-muted-foreground">{definition.riskCopy}</span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        <span className="text-sm font-medium tabular-nums">{formatUsd(holding.currentValueMicroUsd)}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatSignedUsd(holding.unrealizedGainMicroUsd)} ({formatSignedPercent(holding.unrealizedGainBps)})
        </span>
      </span>
    </li>
  );
}
