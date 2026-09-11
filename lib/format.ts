import { ASSETS, fromMicroUnits, type AssetId } from "@/simulation";

const usdFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Formats integer micro-USD as a display currency string, e.g. "$10,000.00". */
export function formatUsd(amountMicroUsd: number): string {
  return usdFormatter.format(fromMicroUnits(amountMicroUsd));
}

/** Formats an asset's integer micro-units as a display amount, e.g. "1.5 ETH". */
export function formatAssetAmount(amountMicroUnits: number, assetId: AssetId): string {
  const amount = fromMicroUnits(amountMicroUnits).toLocaleString("en-US", { maximumFractionDigits: 6 });
  return `${amount} ${ASSETS[assetId].symbol}`;
}

/** Formats an annual interest rate in basis points, e.g. 400 → "4.00%". */
export function formatRatePercent(rateBps: number): string {
  return `${(rateBps / 100).toFixed(2)}%`;
}

/** Formats a SwapReceipt's integer priceImpactBps for display, e.g. "11.76%". */
export function formatPriceImpactPercent(priceImpactBps: number): string {
  return `${(priceImpactBps / 100).toFixed(2)}%`;
}
