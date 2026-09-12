"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import {
  getAssetValueMicroUsd,
  getCryptoValueMicroUsd,
  getInvestmentPortfolioValueMicroUsd,
  getNetWorthMicroUsd,
} from "@/simulation";
import { useHasSimulationHydrated, useSimulationStore } from "@/lib/stores/simulation-store";
import { formatAssetAmount, formatUsd } from "@/lib/format";
import { HOME_ACTION_AREA_IDS, PRODUCT_AREAS_BY_ID } from "@/lib/product-areas";
import { Card, CardContent } from "@/components/ui/card";
import { ValueRow } from "@/components/shell/value-row";
import { EXPLORE_EXPERIMENTS } from "@/components/explore/experiments";

export function HomeView() {
  const state = useSimulationStore((s) => s.state);
  const hasHydrated = useHasSimulationHydrated();

  const cashMicroUsd = getAssetValueMicroUsd(state, "USDC");
  const cryptoMicroUsd = getCryptoValueMicroUsd(state);
  const savingsMicroUsd = state.savings.balance;
  const investmentsMicroUsd = getInvestmentPortfolioValueMicroUsd(state);
  const debtMicroUsd = state.borrow.debtMicroUsd;
  const totalMicroUsd = getNetWorthMicroUsd(state);
  const collateralEth = state.borrow.collateralEth;

  const featuredExperiments = EXPLORE_EXPERIMENTS.slice(0, 2);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-2 pt-2">
        {/* "What you're worth" rather than a balance: once money is
            borrowed, the headline has to net out what's owed. */}
        <p className="text-sm text-muted-foreground">
          {debtMicroUsd > 0 ? "What you're worth" : "Total balance"}
        </p>
        {hasHydrated ? (
          <p
            className="font-heading text-[2.75rem] leading-none font-semibold tracking-tight tabular-nums"
            data-testid="total-balance"
          >
            {formatUsd(totalMicroUsd)}
          </p>
        ) : (
          <div aria-hidden="true" className="h-11 w-52 animate-pulse rounded-lg bg-muted" />
        )}
        <p className="text-sm text-muted-foreground">
          {debtMicroUsd > 0
            ? "Everything you hold, minus what you owe."
            : "Simulated money you can experiment with freely."}
        </p>
      </section>

      <section aria-label="Actions">
        <ul className="grid grid-cols-5 gap-1">
          {HOME_ACTION_AREA_IDS.map((id) => {
            const area = PRODUCT_AREAS_BY_ID[id];
            const Icon = area.icon;
            return (
              <li key={area.id}>
                <Link
                  href={area.href}
                  className="flex flex-col items-center gap-2 rounded-xl px-1 py-3 text-xs font-medium transition-colors hover:bg-muted"
                >
                  <span className="flex size-11 items-center justify-center rounded-full bg-muted">
                    <Icon aria-hidden="true" className="size-5" />
                  </span>
                  {area.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="balances-heading">
        <h2 id="balances-heading" className="font-heading text-sm font-medium">
          Balances
        </h2>
        <Card>
          <CardContent className="divide-y divide-border py-0">
            <ValueRow
              label="Cash"
              hint={hasHydrated ? formatAssetAmount(state.balances.USDC, "USDC") : undefined}
              value={formatUsd(cashMicroUsd)}
              loading={!hasHydrated}
            />
            <ValueRow
              label="Savings"
              value={formatUsd(savingsMicroUsd)}
              hint={savingsMicroUsd > 0 ? "Earning interest" : "Not started yet"}
              loading={!hasHydrated}
              muted={savingsMicroUsd === 0}
            />
            <ValueRow
              label="Investments"
              value={formatUsd(investmentsMicroUsd)}
              hint={investmentsMicroUsd > 0 ? "Across your investments" : "Not started yet"}
              loading={!hasHydrated}
              muted={investmentsMicroUsd === 0}
            />
            <ValueRow
              label="Crypto"
              hint={
                hasHydrated
                  ? formatAssetAmount(state.balances.ETH + collateralEth, "ETH") +
                    (collateralEth > 0 ? " · some set aside for your loan" : "")
                  : undefined
              }
              value={formatUsd(cryptoMicroUsd)}
              loading={!hasHydrated}
            />
            {debtMicroUsd > 0 ? (
              <ValueRow
                label="Borrowed"
                value={`−${formatUsd(debtMicroUsd)}`}
                hint="What you owe"
                loading={!hasHydrated}
              />
            ) : null}
          </CardContent>
        </Card>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="explore-heading">
        <div className="flex items-baseline justify-between">
          <h2 id="explore-heading" className="font-heading text-sm font-medium">
            Try something
          </h2>
          <Link href="/explore" className="text-xs text-muted-foreground hover:text-foreground">
            All experiments
          </Link>
        </div>
        <ul className="flex flex-col gap-2">
          {featuredExperiments.map((experiment) => (
            <li key={experiment.id}>
              <Link
                href={`/explore/${experiment.id}`}
                className="flex items-center justify-between gap-4 rounded-xl bg-muted/60 px-4 py-3.5 transition-colors hover:bg-muted"
              >
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{experiment.question}</span>
                  <span className="text-xs text-muted-foreground">{experiment.hook}</span>
                </span>
                <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="activity-heading">
        <h2 id="activity-heading" className="font-heading text-sm font-medium">
          Recent activity
        </h2>
        <div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-border px-6 py-10 text-center">
          <p className="text-sm font-medium">No activity yet</p>
          <p className="text-sm text-muted-foreground">
            Money you move in Practice Mode will show up here.
          </p>
        </div>
      </section>
    </div>
  );
}
