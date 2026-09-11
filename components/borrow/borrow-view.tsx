"use client";

import { useState } from "react";
import Link from "next/link";
import {
  getBorrowPosition,
  getPriceMicroUsd,
  getGenesisPriceMicroUsd,
  LIQUIDATION_THRESHOLD_BPS,
  MAX_BORROW_LTV_BPS,
  type BorrowHealth,
  type LiquidationReceipt,
} from "@/simulation";
import { useHasSimulationHydrated, useSimulationStore } from "@/lib/stores/simulation-store";
import { parseAmountToMicroUnits } from "@/lib/parse-amount";
import { formatAssetAmount, formatRatePercent, formatUsd } from "@/lib/format";
import { PRODUCT_AREAS_BY_ID } from "@/lib/product-areas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/shell/page-header";
import { ValueRow } from "@/components/shell/value-row";
import { Note } from "@/components/shell/note";
import { Expander } from "@/components/shell/expander";
import { cn } from "@/lib/utils";

type FormMode = "borrow" | "repay" | "add-collateral" | "remove-collateral";

const HEALTH_COPY: Record<BorrowHealth, { label: string; detail: string; className: string }> = {
  safe: {
    label: "Healthy",
    detail: "Your ETH comfortably covers what you owe.",
    className: "bg-muted text-muted-foreground",
  },
  caution: {
    label: "Getting risky",
    detail: "If ETH keeps falling, your ETH will be sold to repay your loan.",
    className: "bg-foreground/15 text-foreground",
  },
  danger: {
    label: "Danger",
    detail: "Your ETH is close to being sold to repay your loan. Repay some now to be safe.",
    className: "bg-destructive/20 text-destructive",
  },
};

const CRASH_SCENARIOS = [
  { label: "ETH falls 10%", changeBps: -1_000 },
  { label: "ETH falls 20%", changeBps: -2_000 },
  { label: "ETH falls 40%", changeBps: -4_000 },
];

export function BorrowView() {
  const state = useSimulationStore((s) => s.state);
  const dispatch = useSimulationStore((s) => s.dispatch);
  const hasHydrated = useHasSimulationHydrated();
  const area = PRODUCT_AREAS_BY_ID.borrow;

  const [mode, setMode] = useState<FormMode | null>(null);
  const [amountInput, setAmountInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [liquidation, setLiquidation] = useState<LiquidationReceipt | null>(null);

  const position = getBorrowPosition(state);
  const ethPriceMicroUsd = getPriceMicroUsd(state, "ETH");
  const genesisEthPriceMicroUsd = getGenesisPriceMicroUsd("ETH");
  const freeEth = state.balances.ETH;
  const hasAnyEth = freeEth > 0 || position.collateralEth > 0;

  function openForm(next: FormMode) {
    setMode(next);
    setAmountInput("");
    setError(null);
    setReceipt(null);
    setLiquidation(null);
  }

  function closeForm() {
    setMode(null);
    setAmountInput("");
    setError(null);
  }

  function submitForm(event: React.FormEvent) {
    event.preventDefault();
    if (!mode) return;

    const amount = parseAmountToMicroUnits(amountInput);
    if (amount === null || amount <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }

    const result = dispatch(
      mode === "borrow"
        ? { type: "borrow-cash", amount }
        : mode === "repay"
          ? { type: "repay-cash", amount }
          : mode === "add-collateral"
            ? { type: "add-collateral", amount }
            : { type: "remove-collateral", amount },
    );

    if (!result.ok) {
      setError(result.error);
      return;
    }

    setReceipt(
      mode === "borrow"
        ? `Borrowed ${formatUsd(amount)}. It's in your cash now.`
        : mode === "repay"
          ? `Repaid ${formatUsd(amount)}.`
          : mode === "add-collateral"
            ? `Set aside ${formatAssetAmount(amount, "ETH")} for your loan.`
            : `Took back ${formatAssetAmount(amount, "ETH")}.`,
    );
    closeForm();
  }

  function runScenario(changeBps: number) {
    const result = dispatch({ type: "simulate-eth-price-change", changeBps });
    if (!result.ok) return;

    setError(null);
    setMode(null);
    setLiquidation(result.liquidation ?? null);
    setReceipt(
      result.liquidation
        ? null
        : `ETH is now ${formatUsd(useSimulationStore.getState().state.market.pricesMicroUsd.ETH)}.`,
    );
  }

  function resetPrice() {
    dispatch({ type: "reset-eth-price" });
    setLiquidation(null);
    setError(null);
    setReceipt(`ETH is back to ${formatUsd(genesisEthPriceMicroUsd)}.`);
  }

  const health = HEALTH_COPY[position.health];
  const hasDebt = position.debtMicroUsd > 0;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={area.label} purpose={area.purpose} />

      {/* Above the position, and outside the has-ETH branch: liquidating a
          fully pledged position leaves the user with no ETH, and the
          explanation of what just happened must not disappear with it. */}
      {liquidation ? <LiquidationNotice receipt={liquidation} /> : null}

      {/* Debt outlives the collateral when a sale falls short, so the
          position stays on screen whenever anything is still owed. */}
      {!hasAnyEth && !hasDebt ? (
        <NeedsEthEmptyState />
      ) : (
        <>
          <section className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">{hasDebt ? "You owe" : "You could borrow"}</p>
            {hasHydrated ? (
              <p
                className="font-heading text-4xl leading-none font-semibold tracking-tight tabular-nums"
                data-testid="borrow-headline"
              >
                {formatUsd(hasDebt ? position.debtMicroUsd : position.availableToBorrowMicroUsd)}
              </p>
            ) : (
              <div aria-hidden="true" className="h-10 w-44 animate-pulse rounded-lg bg-muted" />
            )}

            {hasDebt ? (
              <div className="flex flex-col gap-1.5">
                <span
                  data-testid="position-health"
                  className={cn(
                    "w-fit rounded-full px-3 py-1 text-xs font-medium",
                    health.className,
                  )}
                >
                  {health.label}
                </span>
                <p className="text-sm text-muted-foreground">
                  {position.collateralEth <= 0
                    ? "This is left over after your ETH was sold. There's nothing set aside behind it — repay it from your cash."
                    : health.detail}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Against the {formatAssetAmount(position.collateralEth, "ETH")} you&apos;ve set aside.
              </p>
            )}
          </section>

          {receipt ? (
            <p className="text-sm text-foreground" role="status">
              {receipt}
            </p>
          ) : null}

          {mode ? (
            <TransferForm
              mode={mode}
              amountInput={amountInput}
              error={error}
              availableHint={
                mode === "borrow"
                  ? `${formatUsd(position.availableToBorrowMicroUsd)} available`
                  : mode === "repay"
                    ? `${formatUsd(position.debtMicroUsd)} owed`
                    : mode === "add-collateral"
                      ? `${formatAssetAmount(freeEth, "ETH")} free`
                      : `${formatAssetAmount(position.collateralEth, "ETH")} set aside`
              }
              onChange={(value) => {
                setAmountInput(value);
                setError(null);
              }}
              onSubmit={submitForm}
              onCancel={closeForm}
            />
          ) : (
            <section className="flex flex-col gap-2">
              <Button
                size="lg"
                className="h-12 w-full"
                disabled={position.availableToBorrowMicroUsd <= 0}
                onClick={() => openForm("borrow")}
              >
                Borrow cash
              </Button>
              {hasDebt ? (
                <Button variant="outline" className="h-11 w-full" onClick={() => openForm("repay")}>
                  Repay
                </Button>
              ) : null}
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="ghost"
                  className="h-11"
                  disabled={freeEth <= 0}
                  onClick={() => openForm("add-collateral")}
                >
                  Set aside ETH
                </Button>
                <Button
                  variant="ghost"
                  className="h-11"
                  disabled={position.collateralEth <= 0}
                  onClick={() => openForm("remove-collateral")}
                >
                  Take back ETH
                </Button>
              </div>
            </section>
          )}

          <Card>
            <CardContent className="divide-y divide-border py-0">
              <ValueRow
                label="ETH set aside"
                value={formatUsd(position.collateralValueMicroUsd)}
                hint={formatAssetAmount(position.collateralEth, "ETH")}
                loading={!hasHydrated}
              />
              <ValueRow
                label="Borrowed"
                value={formatUsd(position.debtMicroUsd)}
                muted={!hasDebt}
                loading={!hasHydrated}
              />
              <ValueRow
                label="Available to borrow"
                value={formatUsd(position.availableToBorrowMicroUsd)}
                muted={position.availableToBorrowMicroUsd === 0}
                loading={!hasHydrated}
              />
              {hasDebt && position.liquidationPriceMicroUsd !== null ? (
                <ValueRow
                  label="Your ETH gets sold if it falls below"
                  value={formatUsd(position.liquidationPriceMicroUsd)}
                  hint={`ETH is ${formatUsd(ethPriceMicroUsd)} now`}
                  loading={!hasHydrated}
                />
              ) : null}
            </CardContent>
          </Card>
        </>
      )}

      <section className="flex flex-col gap-3 rounded-xl border border-dashed border-border px-4 py-4">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">What if ETH falls?</p>
          <p className="text-sm text-muted-foreground">
            Move ETH&apos;s simulated price and watch what it does to your loan. This is a practice
            scenario — it changes ETH&apos;s price everywhere in the app, and nothing is bought or
            sold to make it happen.
          </p>
        </div>
        <div className="grid gap-2">
          {CRASH_SCENARIOS.map((scenario) => (
            <Button
              key={scenario.changeBps}
              variant="outline"
              className="h-11"
              onClick={() => runScenario(scenario.changeBps)}
            >
              {scenario.label}
            </Button>
          ))}
        </div>
        <div className="flex items-center justify-between gap-4">
          <p className="text-xs text-muted-foreground">
            ETH is {formatUsd(ethPriceMicroUsd)}
            {ethPriceMicroUsd !== genesisEthPriceMicroUsd
              ? ` · started at ${formatUsd(genesisEthPriceMicroUsd)}`
              : ""}
          </p>
          {ethPriceMicroUsd !== genesisEthPriceMicroUsd ? (
            <Button variant="link" size="sm" className="h-auto p-0 text-foreground" onClick={resetPrice}>
              Reset price
            </Button>
          ) : null}
        </div>
      </section>

      <Note title="Borrowing without selling">
        <p>
          Setting ETH aside lets you get cash without giving up your ETH — you keep it, and you get it
          back when you repay.
        </p>
        <div className="mt-3 flex flex-col gap-3">
          <Expander question="Why can I only borrow part of my ETH's value?">
            <p>
              ETH&apos;s price moves, so the app only lets you borrow up to{" "}
              {formatRatePercent(MAX_BORROW_LTV_BPS)} of what your ETH is worth. That gap is a cushion:
              if ETH drops, there&apos;s still plenty behind your loan.
            </p>
            <p>
              The share of your ETH&apos;s value that you&apos;ve borrowed is called loan-to-value, or
              LTV.
            </p>
          </Expander>
          <Expander question="What happens if ETH falls?">
            <p>
              Your ETH is worth less, so your loan takes up a bigger share of it. If what you owe
              passes {formatRatePercent(LIQUIDATION_THRESHOLD_BPS)} of what your ETH is worth, your ETH
              is sold automatically to repay the loan, and whatever is left over comes back to you as
              cash.
            </p>
            <p>
              That automatic sale is called liquidation, and the{" "}
              {formatRatePercent(LIQUIDATION_THRESHOLD_BPS)} line is the liquidation threshold. Repaying
              some of your loan, or setting aside more ETH, moves you further away from it.
            </p>
          </Expander>
        </div>
      </Note>
    </div>
  );
}

function NeedsEthEmptyState() {
  return (
    <Note title="You need ETH first">
      <p>
        Borrowing here works by setting aside something you own — ETH — and borrowing cash against it,
        without having to sell it.
      </p>
      <p className="mt-2">
        <Link href="/swap" className="text-foreground underline underline-offset-4">
          Get some ETH in Swap
        </Link>{" "}
        and come back.
      </p>
    </Note>
  );
}

function LiquidationNotice({ receipt }: { receipt: LiquidationReceipt }) {
  const owedBefore = receipt.debtClearedMicroUsd + receipt.remainingDebtMicroUsd;
  const hasShortfall = receipt.remainingDebtMicroUsd > 0;

  return (
    <div
      data-testid="liquidation-notice"
      className="flex flex-col gap-2 rounded-xl bg-destructive/15 px-4 py-4 text-sm leading-relaxed"
    >
      <p className="font-medium text-destructive">Your ETH was sold to repay your loan</p>
      <p className="text-muted-foreground">
        ETH fell to {formatUsd(receipt.ethPriceMicroUsd)}, which left your{" "}
        {formatAssetAmount(receipt.collateralSoldEth, "ETH")} worth{" "}
        {formatUsd(receipt.collateralValueMicroUsd)} — too little to safely cover the{" "}
        {formatUsd(owedBefore)} you owed.
      </p>
      {hasShortfall ? (
        <p className="text-muted-foreground">
          Selling it raised {formatUsd(receipt.debtClearedMicroUsd)}, which wasn&apos;t enough to pay
          off the loan. You still owe {formatUsd(receipt.remainingDebtMicroUsd)}, and there&apos;s no
          ETH left behind it — repay it from your cash.
        </p>
      ) : (
        <p className="text-muted-foreground">
          It was sold, your loan is cleared, and the {formatUsd(receipt.returnedToCashMicroUsd)} left
          over went to your cash.
        </p>
      )}
      <p className="text-muted-foreground">
        This is what liquidation means: your ETH is gone, so you won&apos;t gain anything if the price
        recovers.
      </p>
    </div>
  );
}

function TransferForm({
  mode,
  amountInput,
  error,
  availableHint,
  onChange,
  onSubmit,
  onCancel,
}: {
  mode: FormMode;
  amountInput: string;
  error: string | null;
  availableHint: string;
  onChange: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
  onCancel: () => void;
}) {
  const label =
    mode === "borrow"
      ? "Borrow cash"
      : mode === "repay"
        ? "Repay"
        : mode === "add-collateral"
          ? "Set aside ETH"
          : "Take back ETH";

  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="borrow-amount">{label}</Label>
          <span className="text-xs text-muted-foreground">{availableHint}</span>
        </div>
        <Input
          id="borrow-amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          autoFocus
          value={amountInput}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="flex flex-col gap-2">
        <Button type="submit" size="lg" className="h-12 w-full">
          {label}
        </Button>
        <Button type="button" variant="ghost" className="h-11 w-full" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
