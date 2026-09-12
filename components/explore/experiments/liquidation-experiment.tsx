"use client";

import { useState } from "react";
import {
  getBorrowPosition,
  getGenesisPriceMicroUsd,
  getPriceMicroUsd,
  LIQUIDATION_THRESHOLD_BPS,
  MAX_BORROW_LTV_BPS,
  type BorrowHealth,
  type LiquidationReceipt,
} from "@/simulation";
import { useExperimentSimulation } from "@/lib/explore/use-experiment-simulation";
import { formatAssetAmount, formatRatePercent, formatUsd } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ValueRow } from "@/components/shell/value-row";
import { Note } from "@/components/shell/note";
import { Expander } from "@/components/shell/expander";
import { ExperimentShell } from "@/components/explore/experiment-shell";
import { EXPLORE_EXPERIMENTS_BY_ID } from "@/components/explore/experiments";
import { cn } from "@/lib/utils";

const HEALTH_COPY: Record<BorrowHealth, { label: string; className: string }> = {
  safe: { label: "Healthy", className: "bg-muted text-muted-foreground" },
  caution: { label: "Getting risky", className: "bg-foreground/15 text-foreground" },
  danger: { label: "Danger", className: "bg-destructive/20 text-destructive" },
};

// Every scenario is measured from the fixture's own starting price, never
// compounded from wherever the previous click left it — see runScenario.
const DROP_SCENARIOS = [
  { label: "ETH falls 20%", changeBps: -2_000 },
  { label: "ETH falls 30%", changeBps: -3_000 },
  { label: "ETH falls 40%", changeBps: -4_000 },
];

export function LiquidationExperiment() {
  const experiment = EXPLORE_EXPERIMENTS_BY_ID.liquidation;
  const { state, version, dispatch, reset: resetSandbox } = useExperimentSimulation("liquidation");
  const [liquidation, setLiquidation] = useState<LiquidationReceipt | null>(null);
  const [appliedLabel, setAppliedLabel] = useState<string | null>(null);

  const position = getBorrowPosition(state);
  const ethPriceMicroUsd = getPriceMicroUsd(state, "ETH");
  const genesisEthPriceMicroUsd = getGenesisPriceMicroUsd("ETH");
  const health = HEALTH_COPY[position.health];

  function runScenario(changeBps: number, label: string) {
    // Reset to ETH's starting price first, so "30% falls further than 20%"
    // stays true regardless of what was clicked before it.
    dispatch({ type: "reset-eth-price" });
    const result = dispatch({ type: "simulate-eth-price-change", changeBps });
    if (!result.ok) return;
    setLiquidation(result.liquidation ?? null);
    setAppliedLabel(label);
  }

  function reset() {
    resetSandbox();
    setLiquidation(null);
    setAppliedLabel(null);
  }

  return (
    <ExperimentShell experiment={experiment} onReset={reset} canReset={version > 0}>
      <div className="flex flex-col gap-6">
        {liquidation ? <LiquidationOutcome receipt={liquidation} /> : null}

        <Card>
          <CardContent className="divide-y divide-border py-0">
            <ValueRow label="ETH price" value={formatUsd(ethPriceMicroUsd)} />
            <ValueRow
              label="Your ETH"
              value={formatUsd(position.collateralValueMicroUsd)}
              hint={formatAssetAmount(position.collateralEth, "ETH")}
            />
            <ValueRow label="You owe" value={formatUsd(position.debtMicroUsd)} />
            {position.debtMicroUsd > 0 && position.collateralEth > 0 ? (
              <div
                data-testid="position-health"
                className="flex items-center justify-between gap-4 py-2.5"
              >
                <span className={cn("w-fit rounded-full px-3 py-1 text-xs font-medium", health.className)}>
                  {health.label}
                </span>
                {position.liquidationPriceMicroUsd !== null ? (
                  <span className="text-xs text-muted-foreground">
                    Sold below {formatUsd(position.liquidationPriceMicroUsd)}
                  </span>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>

        {!liquidation && appliedLabel ? (
          <Note title="What changed">
            <p>
              Your ETH is worth {formatUsd(position.collateralValueMicroUsd)} now. You still owe{" "}
              {formatUsd(position.debtMicroUsd)} — debt doesn&apos;t shrink when prices fall, so the loan takes up a
              bigger share of what&apos;s behind it.
            </p>
          </Note>
        ) : null}

        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Drop the price</p>
          <div className="grid gap-2">
            {DROP_SCENARIOS.map((scenario) => (
              <Button
                key={scenario.label}
                variant="outline"
                className="h-11"
                disabled={position.collateralEth <= 0}
                onClick={() => runScenario(scenario.changeBps, scenario.label)}
              >
                {scenario.label}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Each button measures the drop from ETH&apos;s starting price of {formatUsd(genesisEthPriceMicroUsd)} —
            not from wherever the last click left it.
          </p>
        </div>

        <Note title="Why can I only borrow part of my ETH's value?">
          <p>
            The gap between what you can borrow ({formatRatePercent(MAX_BORROW_LTV_BPS)} of your ETH&apos;s value)
            and where liquidation happens ({formatRatePercent(LIQUIDATION_THRESHOLD_BPS)}) is a cushion — room for
            the price to move against you before your ETH gets sold automatically.
          </p>
          <Expander question="What's that ratio called?">
            <p>
              The share of your ETH&apos;s value that you&apos;ve borrowed is called loan-to-value, or LTV. The{" "}
              {formatRatePercent(LIQUIDATION_THRESHOLD_BPS)} line where your ETH gets sold is the liquidation
              threshold.
            </p>
          </Expander>
        </Note>
      </div>
    </ExperimentShell>
  );
}

function LiquidationOutcome({ receipt }: { receipt: LiquidationReceipt }) {
  const hasShortfall = receipt.remainingDebtMicroUsd > 0;
  return (
    <div
      data-testid="experiment-liquidation-notice"
      className="flex flex-col gap-2 rounded-xl bg-destructive/15 px-4 py-4 text-sm leading-relaxed"
    >
      <p className="font-medium text-destructive">Your ETH was sold to repay your loan</p>
      <p className="text-muted-foreground">
        ETH fell to {formatUsd(receipt.ethPriceMicroUsd)}. Selling your{" "}
        {formatAssetAmount(receipt.collateralSoldEth, "ETH")} raised {formatUsd(receipt.collateralValueMicroUsd)}
        {hasShortfall
          ? `, which wasn't enough to cover what you owed. ${formatUsd(receipt.remainingDebtMicroUsd)} is still owed, with no ETH left behind it.`
          : `. Your loan is cleared, and ${formatUsd(receipt.returnedToCashMicroUsd)} came back to you as cash.`}
      </p>
      <p className="text-muted-foreground">
        This is liquidation: your ETH is gone, so you won&apos;t gain anything if the price recovers.
      </p>
    </div>
  );
}
