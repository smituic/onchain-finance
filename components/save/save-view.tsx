"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  getAssetValueMicroUsd,
  getPracticeMonthsElapsed,
  SAVINGS_ANNUAL_RATE_BPS,
} from "@/simulation";
import { useHasSimulationHydrated, useSimulationStore } from "@/lib/stores/simulation-store";
import { parseAmountToMicroUnits } from "@/lib/parse-amount";
import { formatRatePercent, formatUsd } from "@/lib/format";
import { PRODUCT_AREAS_BY_ID } from "@/lib/product-areas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/shell/page-header";
import { ValueRow } from "@/components/shell/value-row";
import { Note } from "@/components/shell/note";

type TransferMode = "deposit" | "withdraw";

export function SaveView() {
  const state = useSimulationStore((s) => s.state);
  const dispatch = useSimulationStore((s) => s.dispatch);
  const hasHydrated = useHasSimulationHydrated();
  const area = PRODUCT_AREAS_BY_ID.save;

  const [mode, setMode] = useState<TransferMode | null>(null);
  const [amountInput, setAmountInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  const cashMicroUsd = getAssetValueMicroUsd(state, "USDC");
  const savings = state.savings;
  const monthsSkipped = getPracticeMonthsElapsed(state);

  function openTransfer(next: TransferMode) {
    setMode(next);
    setAmountInput("");
    setError(null);
    setReceipt(null);
  }

  function closeTransfer() {
    setMode(null);
    setAmountInput("");
    setError(null);
  }

  function submitTransfer(event: React.FormEvent) {
    event.preventDefault();
    if (!mode) return;

    const amount = parseAmountToMicroUnits(amountInput);
    if (amount === null || amount <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }

    const result = dispatch(
      mode === "deposit"
        ? { type: "deposit-to-savings", amount }
        : { type: "withdraw-from-savings", amount },
    );

    if (!result.ok) {
      setError(result.error);
      return;
    }

    setReceipt(
      mode === "deposit"
        ? `Moved ${formatUsd(amount)} into savings.`
        : `Moved ${formatUsd(amount)} back to Cash.`,
    );
    closeTransfer();
  }

  function advanceTime() {
    const before = useSimulationStore.getState().state.savings.interestEarnedTotal;
    const result = dispatch({ type: "advance-practice-time" });
    if (!result.ok) return;

    const earned = useSimulationStore.getState().state.savings.interestEarnedTotal - before;
    setError(null);
    setReceipt(
      earned > 0
        ? `A month went by — you earned ${formatUsd(earned)} in interest.`
        : "A month went by. Move money to savings to start earning interest.",
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={area.label} purpose={area.purpose} />

      <section className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">In savings</p>
        {hasHydrated ? (
          <p
            className="font-heading text-4xl leading-none font-semibold tracking-tight tabular-nums"
            data-testid="savings-balance"
          >
            {formatUsd(savings.balance)}
          </p>
        ) : (
          <div aria-hidden="true" className="h-10 w-44 animate-pulse rounded-lg bg-muted" />
        )}
        <p className="text-sm text-muted-foreground">
          Earning {formatRatePercent(SAVINGS_ANNUAL_RATE_BPS)} a year, added to your balance as time
          passes.
        </p>
      </section>

      {receipt ? (
        <p className="text-sm text-foreground" role="status">
          {receipt}
        </p>
      ) : null}

      {mode ? (
        <form className="flex flex-col gap-4" onSubmit={submitTransfer}>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="savings-amount">
                {mode === "deposit" ? "Move to savings" : "Move to Cash"}
              </Label>
              <span className="text-xs text-muted-foreground">
                {mode === "deposit"
                  ? `${formatUsd(cashMicroUsd)} in Cash`
                  : `${formatUsd(savings.balance)} in savings`}
              </span>
            </div>
            <Input
              id="savings-amount"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              autoFocus
              value={amountInput}
              onChange={(event) => {
                setAmountInput(event.target.value);
                setError(null);
              }}
            />
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <div className="flex flex-col gap-2">
            <Button type="submit" size="lg" className="h-12 w-full">
              {mode === "deposit" ? "Move to savings" : "Move to Cash"}
            </Button>
            <Button type="button" variant="ghost" className="h-11 w-full" onClick={closeTransfer}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <section className="flex flex-col gap-2">
          <Button size="lg" className="h-12 w-full" onClick={() => openTransfer("deposit")}>
            Move to savings
          </Button>
          <Button
            variant="outline"
            className="h-11 w-full"
            disabled={savings.balance <= 0}
            onClick={() => openTransfer("withdraw")}
          >
            Move to Cash
          </Button>
        </section>
      )}

      <Card>
        <CardContent className="divide-y divide-border py-0">
          <ValueRow
            label="Interest earned"
            value={formatUsd(savings.interestEarnedTotal)}
            hint="Since you started saving"
            loading={!hasHydrated}
          />
          <ValueRow
            label="Current rate"
            value={`${formatRatePercent(SAVINGS_ANNUAL_RATE_BPS)} a year`}
          />
          <ValueRow
            label="Available to move"
            value={formatUsd(cashMicroUsd)}
            hint="Your Cash"
            loading={!hasHydrated}
          />
        </CardContent>
      </Card>

      <section className="flex flex-col gap-3 rounded-xl border border-dashed border-border px-4 py-4">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">Skip ahead</p>
          <p className="text-sm text-muted-foreground">
            Interest is slow in real life. Jump the clock forward to watch it add up — only time moves,
            nothing else.
          </p>
        </div>
        <Button variant="outline" className="h-11 w-full" onClick={advanceTime}>
          See one month later
        </Button>
        {monthsSkipped > 0 ? (
          <p className="text-xs text-muted-foreground">
            You&apos;ve skipped ahead {monthsSkipped} {monthsSkipped === 1 ? "month" : "months"} in
            Practice Mode.
          </p>
        ) : null}
      </section>

      <InterestExplainer />
    </div>
  );
}

function InterestExplainer() {
  const [expanded, setExpanded] = useState(false);

  return (
    <Note title="Where does the interest come from?">
      <p>
        Practice Mode credits interest at a fixed, simulated rate — right now{" "}
        {formatRatePercent(SAVINGS_ANNUAL_RATE_BPS)} a year, added to your balance as time passes. Your
        money here isn&apos;t going anywhere or being lent to anyone.
      </p>
      <Button
        type="button"
        variant="link"
        size="sm"
        className="mt-2 h-auto self-start p-0 text-foreground"
        aria-expanded={expanded}
        aria-controls="savings-real-mode-detail"
        onClick={() => setExpanded((value) => !value)}
      >
        What about real money?
        <ChevronDown aria-hidden="true" className={expanded ? "size-4 rotate-180" : "size-4"} />
      </Button>
      {expanded ? (
        <p id="savings-real-mode-detail" className="mt-2">
          With real money, yield like this can come from somewhere real — often other people paying to
          borrow the same money you&apos;ve set aside, in open markets where the rate moves with how much
          people want to borrow. That causal market isn&apos;t modeled in Practice Mode today; the rate
          here is fixed so it&apos;s easy to predict and check. You&apos;d still see the same shape: a
          balance, a rate, and money you can take out whenever you want.
        </p>
      ) : null}
    </Note>
  );
}
