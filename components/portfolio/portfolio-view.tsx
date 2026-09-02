"use client";

import Link from "next/link";
import { getPortfolioValueMicroUsd } from "@/simulation";
import { useHasSimulationHydrated, useSimulationStore } from "@/lib/stores/simulation-store";
import { formatAssetAmount, formatUsd } from "@/lib/format";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function PortfolioView() {
  const state = useSimulationStore((s) => s.state);
  const hasHydrated = useHasSimulationHydrated();
  const totalValueMicroUsd = getPortfolioValueMicroUsd(state);

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col gap-6 p-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-normal text-muted-foreground">Portfolio value</CardTitle>
        </CardHeader>
        <CardContent>
          {hasHydrated ? (
            <p className="text-3xl font-semibold" data-testid="portfolio-value">
              {formatUsd(totalValueMicroUsd)}
            </p>
          ) : (
            <div className="h-9 w-36 animate-pulse rounded-md bg-muted" aria-hidden />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3">
          <BalanceRow label="USDC" hasHydrated={hasHydrated} value={formatAssetAmount(state.balances.USDC, "USDC")} />
          <BalanceRow label="ETH" hasHydrated={hasHydrated} value={formatAssetAmount(state.balances.ETH, "ETH")} />
        </CardContent>
      </Card>

      <Link href="/swap" className={cn(buttonVariants({ size: "lg" }), "w-full")}>
        Swap
      </Link>
    </main>
  );
}

function BalanceRow({
  label,
  value,
  hasHydrated,
}: {
  label: string;
  value: string;
  hasHydrated: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-muted-foreground">{label}</span>
      {hasHydrated ? (
        <span className="text-sm font-medium">{value}</span>
      ) : (
        <div className="h-4 w-16 animate-pulse rounded bg-muted" aria-hidden />
      )}
    </div>
  );
}
