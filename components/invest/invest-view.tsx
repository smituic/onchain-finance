"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import {
  getInvestmentHolding,
  getInvestmentHoldings,
  getInvestPortfolio,
  getGenesisInvestmentPriceMicroUsd,
  getInvestmentPriceMicroUsd,
  INVESTMENT_ASSET_IDS,
  INVESTMENT_ASSETS,
  type InvestmentAssetId,
  type SimulationState,
} from "@/simulation";
import { useHasSimulationHydrated, useSimulationStore } from "@/lib/stores/simulation-store";
import { parseAmountToMicroUnits } from "@/lib/parse-amount";
import { formatInvestmentUnits, formatSignedPercent, formatSignedUsd, formatUsd } from "@/lib/format";
import { PRODUCT_AREAS_BY_ID } from "@/lib/product-areas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/shell/page-header";
import { ValueRow } from "@/components/shell/value-row";
import { Note } from "@/components/shell/note";
import { Expander } from "@/components/shell/expander";

type TradeMode = "buy" | "sell" | null;

export function InvestView() {
  const state = useSimulationStore((s) => s.state);
  const dispatch = useSimulationStore((s) => s.dispatch);
  const hasHydrated = useHasSimulationHydrated();
  const area = PRODUCT_AREAS_BY_ID.invest;

  const [selectedAssetId, setSelectedAssetId] = useState<InvestmentAssetId | null>(null);
  const [tradeMode, setTradeMode] = useState<TradeMode>(null);
  const [amountInput, setAmountInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  const portfolio = getInvestPortfolio(state);
  const holdings = getInvestmentHoldings(state).filter((holding) => holding.unitsHeld > 0);
  const hasAnyHoldings = holdings.length > 0;

  function selectAsset(assetId: InvestmentAssetId) {
    setSelectedAssetId(assetId);
    setTradeMode(null);
    setAmountInput("");
    setError(null);
    setReceipt(null);
  }

  function backToBrowse() {
    setSelectedAssetId(null);
    setTradeMode(null);
    setAmountInput("");
    setError(null);
  }

  function openTrade(mode: "buy" | "sell") {
    setTradeMode(mode);
    setAmountInput("");
    setError(null);
    setReceipt(null);
  }

  function closeTrade() {
    setTradeMode(null);
    setAmountInput("");
    setError(null);
  }

  function submitTrade(event: React.FormEvent) {
    event.preventDefault();
    if (!tradeMode || !selectedAssetId) return;

    const amount = parseAmountToMicroUnits(amountInput);
    if (amount === null || amount <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }

    const name = INVESTMENT_ASSETS[selectedAssetId].name;
    const result = dispatch(
      tradeMode === "buy"
        ? { type: "buy-investment", assetId: selectedAssetId, amount }
        : { type: "sell-investment", assetId: selectedAssetId, amount },
    );

    if (!result.ok) {
      setError(result.error);
      return;
    }

    const executedMicroUsd = result.investmentTrade?.amountMicroUsd ?? amount;
    setReceipt(
      tradeMode === "buy"
        ? `Bought ${formatUsd(executedMicroUsd)} of ${name}.`
        : `Sold ${formatUsd(executedMicroUsd)} of ${name}.`,
    );
    closeTrade();
  }

  function sellAll() {
    if (!selectedAssetId) return;
    const holding = getInvestmentHolding(state, selectedAssetId);
    if (holding.currentValueMicroUsd <= 0) return;

    const result = dispatch({
      type: "sell-investment",
      assetId: selectedAssetId,
      amount: holding.currentValueMicroUsd,
    });

    if (!result.ok) {
      setError(result.error);
      return;
    }

    setReceipt(`Sold all of your ${INVESTMENT_ASSETS[selectedAssetId].name}.`);
    setTradeMode(null);
    setAmountInput("");
    setError(null);
  }

  function runMarketScenario(direction: "up" | "down") {
    const result = dispatch({ type: "simulate-investment-market-move", direction });
    if (!result.ok) return;
    setError(null);
    setReceipt(direction === "up" ? "The market went up." : "The market went down.");
  }

  function resetPrices() {
    dispatch({ type: "reset-investment-prices" });
    setError(null);
    setReceipt("Prices are back to where they started.");
  }

  const pricesAtGenesis = INVESTMENT_ASSET_IDS.every(
    (assetId) => getInvestmentPriceMicroUsd(state, assetId) === getGenesisInvestmentPriceMicroUsd(assetId),
  );

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={area.label} purpose={area.purpose} />

      <section className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">Portfolio value</p>
        {hasHydrated ? (
          <p
            className="font-heading text-4xl leading-none font-semibold tracking-tight tabular-nums"
            data-testid="invest-portfolio-value"
          >
            {formatUsd(portfolio.totalValueMicroUsd)}
          </p>
        ) : (
          <div aria-hidden="true" className="h-10 w-44 animate-pulse rounded-lg bg-muted" />
        )}
        {portfolio.totalCostBasisMicroUsd > 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="invest-total-return">
            {formatSignedUsd(portfolio.totalUnrealizedGainMicroUsd)} (
            {formatSignedPercent(portfolio.totalUnrealizedGainBps)})
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Choose an investment below and try putting some simulated cash into it.
          </p>
        )}
      </section>

      {receipt ? (
        <p className="text-sm text-foreground" role="status">
          {receipt}
        </p>
      ) : null}

      {hasAnyHoldings ? (
        <section className="flex flex-col gap-3" aria-labelledby="holdings-heading">
          <h2 id="holdings-heading" className="font-heading text-sm font-medium">
            Your investments
          </h2>
          <ul className="flex flex-col gap-2">
            {holdings.map((holding) => {
              const definition = INVESTMENT_ASSETS[holding.assetId];
              return (
                <li key={holding.assetId}>
                  <button
                    type="button"
                    data-testid={`holding-${holding.assetId}`}
                    onClick={() => selectAsset(holding.assetId)}
                    className="flex w-full items-center justify-between gap-4 rounded-xl bg-muted/60 px-4 py-3.5 text-left transition-colors hover:bg-muted"
                  >
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium">{definition.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {formatInvestmentUnits(holding.unitsHeld, holding.assetId)}
                      </span>
                    </span>
                    <span className="flex flex-col items-end gap-0.5">
                      <span className="text-sm font-medium tabular-nums">
                        {formatUsd(holding.currentValueMicroUsd)}
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {formatSignedUsd(holding.unrealizedGainMicroUsd)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {selectedAssetId ? (
        <InvestmentDetail
          assetId={selectedAssetId}
          state={state}
          tradeMode={tradeMode}
          amountInput={amountInput}
          error={error}
          onBack={backToBrowse}
          onOpenTrade={openTrade}
          onCloseTrade={closeTrade}
          onAmountChange={(value) => {
            setAmountInput(value);
            setError(null);
          }}
          onSubmit={submitTrade}
          onSellAll={sellAll}
        />
      ) : (
        <section className="flex flex-col gap-3" aria-labelledby="browse-heading">
          <h2 id="browse-heading" className="font-heading text-sm font-medium">
            Browse investments
          </h2>
          <ul className="flex flex-col gap-2">
            {INVESTMENT_ASSET_IDS.map((assetId) => {
              const definition = INVESTMENT_ASSETS[assetId];
              const priceMicroUsd = getInvestmentPriceMicroUsd(state, assetId);
              return (
                <li key={assetId}>
                  <button
                    type="button"
                    data-testid={`asset-${assetId}`}
                    onClick={() => selectAsset(assetId)}
                    className="flex w-full items-center justify-between gap-4 rounded-xl px-4 py-3.5 text-left ring-1 ring-foreground/10 transition-colors hover:bg-muted"
                  >
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium">{definition.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {definition.category} · {formatUsd(priceMicroUsd)}
                      </span>
                    </span>
                    <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-3 rounded-xl border border-dashed border-border px-4 py-4">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">See the market move</p>
          <p className="text-sm text-muted-foreground">
            This is a practice scenario — it moves every investment&apos;s simulated price at once,
            each by its own amount. Nothing is bought or sold to make it happen.
          </p>
        </div>
        <div className="grid gap-2">
          <Button variant="outline" className="h-11" onClick={() => runMarketScenario("up")}>
            Market rises
          </Button>
          <Button variant="outline" className="h-11" onClick={() => runMarketScenario("down")}>
            Market falls
          </Button>
        </div>
        <Card>
          <CardContent className="divide-y divide-border py-0">
            {INVESTMENT_ASSET_IDS.map((assetId) => (
              <ValueRow
                key={assetId}
                label={INVESTMENT_ASSETS[assetId].name}
                value={formatUsd(getInvestmentPriceMicroUsd(state, assetId))}
                loading={!hasHydrated}
              />
            ))}
          </CardContent>
        </Card>
        {!pricesAtGenesis ? (
          <Button variant="link" size="sm" className="h-auto self-start p-0 text-foreground" onClick={resetPrices}>
            Reset prices
          </Button>
        ) : null}
      </section>

      <TokenizationExplainer />
    </div>
  );
}

function InvestmentDetail({
  assetId,
  state,
  tradeMode,
  amountInput,
  error,
  onBack,
  onOpenTrade,
  onCloseTrade,
  onAmountChange,
  onSubmit,
  onSellAll,
}: {
  assetId: InvestmentAssetId;
  state: SimulationState;
  tradeMode: TradeMode;
  amountInput: string;
  error: string | null;
  onBack: () => void;
  onOpenTrade: (mode: "buy" | "sell") => void;
  onCloseTrade: () => void;
  onAmountChange: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
  onSellAll: () => void;
}) {
  const definition = INVESTMENT_ASSETS[assetId];
  const holding = getInvestmentHolding(state, assetId);
  const priceMicroUsd = getInvestmentPriceMicroUsd(state, assetId);
  const cashMicroUsd = state.balances.USDC;
  const isOwned = holding.unitsHeld > 0;

  return (
    <section className="flex flex-col gap-4" aria-labelledby="detail-heading">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-auto w-fit self-start p-0 text-muted-foreground hover:text-foreground"
        onClick={onBack}
      >
        Back to all investments
      </Button>

      <div className="flex flex-col gap-1.5">
        <h2 id="detail-heading" className="font-heading text-lg font-medium">
          {definition.name}
        </h2>
        <p className="text-sm text-muted-foreground">{definition.category}</p>
        <p className="text-sm text-muted-foreground">{definition.description}</p>
        <p className="text-sm text-muted-foreground">{definition.riskCopy}</p>
      </div>

      <Card>
        <CardContent className="divide-y divide-border py-0">
          <ValueRow label="Price" value={formatUsd(priceMicroUsd)} />
          {isOwned ? (
            <>
              <ValueRow
                label="You own"
                value={formatUsd(holding.currentValueMicroUsd)}
                hint={formatInvestmentUnits(holding.unitsHeld, assetId)}
              />
              <ValueRow
                label="Return"
                value={`${formatSignedUsd(holding.unrealizedGainMicroUsd)} (${formatSignedPercent(holding.unrealizedGainBps)})`}
              />
            </>
          ) : null}
        </CardContent>
      </Card>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {tradeMode ? (
        <form className="flex flex-col gap-4" onSubmit={onSubmit}>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="invest-amount">
                {tradeMode === "buy" ? `Buy ${definition.name}` : `Sell ${definition.name}`}
              </Label>
              <span className="text-xs text-muted-foreground">
                {tradeMode === "buy" ? `${formatUsd(cashMicroUsd)} in cash` : `${formatUsd(holding.currentValueMicroUsd)} available`}
              </span>
            </div>
            <Input
              id="invest-amount"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              autoFocus
              value={amountInput}
              onChange={(event) => onAmountChange(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Button type="submit" size="lg" className="h-12 w-full">
              {tradeMode === "buy" ? "Buy" : "Sell"}
            </Button>
            {tradeMode === "sell" ? (
              <Button type="button" variant="outline" className="h-11 w-full" onClick={onSellAll}>
                Sell all
              </Button>
            ) : null}
            <Button type="button" variant="ghost" className="h-11 w-full" onClick={onCloseTrade}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <section className="flex flex-col gap-2">
          <Button size="lg" className="h-12 w-full" disabled={cashMicroUsd <= 0} onClick={() => onOpenTrade("buy")}>
            Buy
          </Button>
          {isOwned ? (
            <Button variant="outline" className="h-11 w-full" onClick={() => onOpenTrade("sell")}>
              Sell
            </Button>
          ) : null}
        </section>
      )}
    </section>
  );
}

function TokenizationExplainer() {
  return (
    <Note title="How can traditional investments exist on-chain?">
      <p>
        A financial asset — a stock, a bond, a Treasury bill — can have a digital representation that
        moves on blockchain infrastructure instead of through a traditional brokerage. That&apos;s what
        &quot;tokenization&quot; means.
      </p>
      <Expander question="Does owning a token mean I legally own the real thing?">
        <p>
          Not automatically. A token existing on a blockchain doesn&apos;t by itself give you legal
          ownership of a real-world asset. Real tokenized Treasuries, stocks, or funds depend on an
          issuer or legal structure behind the token, custody of the real asset, sometimes investor
          eligibility rules, regulation, and clear rights to redeem the token for what it represents.
        </p>
        <p>
          Everything here in Practice Mode is simulated — there is no real Bitcoin, Treasury, or fund
          behind these numbers. A future Real Mode may connect to legitimate tokenized financial
          infrastructure, but that&apos;s not built yet.
        </p>
      </Expander>
    </Note>
  );
}
