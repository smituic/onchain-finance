"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowDownUp } from "lucide-react";
import { applyAction, ASSETS, type AssetId } from "@/simulation";
import { useSimulationStore } from "@/lib/stores/simulation-store";
import { parseAmountToMicroUnits } from "@/lib/parse-amount";
import { formatAssetAmount, formatUsd } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const OTHER_ASSET: Record<AssetId, AssetId> = { USDC: "ETH", ETH: "USDC" };

export function SwapForm() {
  const state = useSimulationStore((s) => s.state);
  const dispatch = useSimulationStore((s) => s.dispatch);

  const [fromAsset, setFromAsset] = useState<AssetId>("USDC");
  const [amountInput, setAmountInput] = useState("");
  const [justSwapped, setJustSwapped] = useState<{ amountOut: number; toAsset: AssetId } | null>(null);

  const toAsset = OTHER_ASSET[fromAsset];
  const amountInMicroUnits = parseAmountToMicroUnits(amountInput);
  const hasEnteredAmount = amountInMicroUnits !== null && amountInMicroUnits > 0;

  const preview = hasEnteredAmount
    ? applyAction(state, { type: "swap", fromAsset, toAsset, amountIn: amountInMicroUnits })
    : null;

  const parseError = amountInput.trim() !== "" && amountInMicroUnits === null ? "Enter a valid amount." : null;
  const errorMessage = parseError ?? (preview && !preview.ok ? preview.error : null);
  const amountOut = preview?.ok ? preview.state.balances[toAsset] - state.balances[toAsset] : null;

  function handleFlip() {
    setFromAsset(toAsset);
    setAmountInput("");
    setJustSwapped(null);
  }

  function trySubmit() {
    if (amountInMicroUnits === null) return;
    const result = dispatch({ type: "swap", fromAsset, toAsset, amountIn: amountInMicroUnits });
    if (result.ok) {
      const delta = result.state.balances[toAsset] - state.balances[toAsset];
      setJustSwapped({ amountOut: delta, toAsset });
      setAmountInput("");
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col gap-6 p-6">
      <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
        ← Portfolio
      </Link>

      <Card>
        <CardHeader>
          <CardTitle>Swap</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              trySubmit();
            }}
          >
            <p className="text-sm text-muted-foreground">1 ETH = {formatUsd(Number(ASSETS.ETH.priceMicroUsd))}</p>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="amount">From {fromAsset}</Label>
                <span className="text-xs text-muted-foreground">
                  Balance: {formatAssetAmount(state.balances[fromAsset], fromAsset)}
                </span>
              </div>
              <Input
                id="amount"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                value={amountInput}
                onChange={(event) => {
                  setAmountInput(event.target.value);
                  setJustSwapped(null);
                }}
              />
            </div>

            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="self-center"
              onClick={handleFlip}
              aria-label="Flip swap direction"
            >
              <ArrowDownUp />
            </Button>

            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>To {toAsset}</span>
              <span>Balance: {formatAssetAmount(state.balances[toAsset], toAsset)}</span>
            </div>

            {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}

            {amountOut !== null && !errorMessage ? (
              <p className="text-sm text-muted-foreground">
                You&apos;ll receive ≈ {formatAssetAmount(amountOut, toAsset)}
              </p>
            ) : null}

            <Button type="submit" size="lg" disabled={!preview?.ok}>
              Swap
            </Button>

            {justSwapped ? (
              <p className="text-sm text-foreground">
                Swapped successfully — received {formatAssetAmount(justSwapped.amountOut, justSwapped.toAsset)}.
              </p>
            ) : null}
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
