"use client";

import { useState } from "react";
import { getPracticeMonthsElapsed, SAVINGS_ANNUAL_RATE_BPS } from "@/simulation";
import { useExperimentSimulation } from "@/lib/explore/use-experiment-simulation";
import { formatRatePercent, formatUsd } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ValueRow } from "@/components/shell/value-row";
import { Note } from "@/components/shell/note";
import { Expander } from "@/components/shell/expander";
import { ExperimentShell } from "@/components/explore/experiment-shell";
import { EXPLORE_EXPERIMENTS_BY_ID } from "@/components/explore/experiments";

// Each button jumps to an exact total of Practice steps from the fixture's
// $1,000 deposit — resetting first, then advancing — so "12 months" always
// shows the same number regardless of what was clicked before it, the same
// way the Liquidation and Risk experiments treat their own scenarios.
const TIME_CONTROLS = [
  { label: "1 month", steps: 1 },
  { label: "6 months", steps: 6 },
  { label: "12 months", steps: 12 },
];

export function YieldExperiment() {
  const experiment = EXPLORE_EXPERIMENTS_BY_ID.yield;
  const { state, version, dispatch, reset: resetSandbox } = useExperimentSimulation("yield");
  const [appliedLabel, setAppliedLabel] = useState<string | null>(null);

  const monthsElapsed = getPracticeMonthsElapsed(state);

  function jumpTo(steps: number, label: string) {
    resetSandbox();
    let ok = true;
    for (let i = 0; i < steps; i++) {
      const result = dispatch({ type: "advance-practice-time" });
      if (!result.ok) ok = false;
    }
    setAppliedLabel(ok ? label : null);
  }

  function reset() {
    resetSandbox();
    setAppliedLabel(null);
  }

  return (
    <ExperimentShell experiment={experiment} onReset={reset} canReset={version > 0}>
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">In savings</p>
          <p className="font-heading text-4xl leading-none font-semibold tracking-tight tabular-nums">
            {formatUsd(state.savings.balance)}
          </p>
          <p className="text-sm text-muted-foreground">
            Started at $1,000, earning {formatRatePercent(SAVINGS_ANNUAL_RATE_BPS)} a year.
          </p>
        </section>

        {appliedLabel ? (
          <Note title="What changed">
            <p>
              After {appliedLabel} of Practice time, you&apos;ve earned {formatUsd(state.savings.interestEarnedTotal)}{" "}
              in interest. {monthsElapsed <= 1 ? "Barely anything yet — this is slow at first." : "It adds up the longer it sits."}
            </p>
          </Note>
        ) : null}

        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Skip ahead</p>
          <div className="grid gap-2">
            {TIME_CONTROLS.map((control) => (
              <Button
                key={control.label}
                variant="outline"
                className="h-11"
                onClick={() => jumpTo(control.steps, control.label)}
              >
                {control.label}
              </Button>
            ))}
          </div>
        </div>

        <Card>
          <CardContent className="divide-y divide-border py-0">
            <ValueRow
              label="Interest earned"
              value={formatUsd(state.savings.interestEarnedTotal)}
              hint="Since the deposit"
            />
            <ValueRow label="Practice time skipped" value={`${monthsElapsed} ${monthsElapsed === 1 ? "step" : "steps"}`} />
          </CardContent>
        </Card>

        <Note title="Is this exactly 4.00% a year?">
          <p>
            Practice Mode credits interest at a fixed 4% annual rate, but time here moves in 30-day
            Practice steps rather than tracking exact calendar months or a real year.
          </p>
          <Expander question="Does interest earn interest here?">
            <p>
              Each step adds interest on your balance as it stands at that moment — so interest credited
              in an earlier step earns its own interest in the next one. That&apos;s compounding once per
              step, not continuously the way a real account might calculate it.
            </p>
          </Expander>
        </Note>
      </div>
    </ExperimentShell>
  );
}
