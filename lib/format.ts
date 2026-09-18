import { fromMicroUnits, INVESTMENT_ASSETS, type AssetId, type InvestmentAssetId } from "@/simulation";

const usdFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Formats integer micro-USD as a display currency string, e.g. "$10,000.00". */
export function formatUsd(amountMicroUsd: number): string {
  return usdFormatter.format(fromMicroUnits(amountMicroUsd));
}

const DISPLAY_ASSET_SYMBOL: Record<AssetId, string> = { USDC: "Cash", ETH: "ETH" };

/**
 * Consumer-facing label for an asset — "Cash" for USDC, "ETH" as-is. Domain
 * truth (AssetId, ASSETS[...].symbol) stays "USDC"; this is presentation only.
 */
export function displayAssetSymbol(assetId: AssetId): string {
  return DISPLAY_ASSET_SYMBOL[assetId];
}

/** Formats an asset's integer micro-units as a display amount, e.g. "1.5 ETH". */
export function formatAssetAmount(amountMicroUnits: number, assetId: AssetId): string {
  const amount = fromMicroUnits(amountMicroUnits).toLocaleString("en-US", { maximumFractionDigits: 6 });
  return `${amount} ${displayAssetSymbol(assetId)}`;
}

/** Formats a curated investment's integer micro-units as a display amount, e.g. "0.008333 BTC". */
export function formatInvestmentUnits(unitsMicroUnits: number, assetId: InvestmentAssetId): string {
  const amount = fromMicroUnits(unitsMicroUnits).toLocaleString("en-US", { maximumFractionDigits: 6 });
  return `${amount} ${INVESTMENT_ASSETS[assetId].unitLabel}`;
}

/** Formats an annual interest rate in basis points, e.g. 400 → "4.00%". */
export function formatRatePercent(rateBps: number): string {
  return `${(rateBps / 100).toFixed(2)}%`;
}

/** Formats a SwapReceipt's integer priceImpactBps for display, e.g. "11.76%". */
export function formatPriceImpactPercent(priceImpactBps: number): string {
  return `${(priceImpactBps / 100).toFixed(2)}%`;
}

/** Formats integer micro-USD with an explicit sign, e.g. "+$12.34" / "−$12.34". */
export function formatSignedUsd(amountMicroUsd: number): string {
  const formatted = formatUsd(Math.abs(amountMicroUsd));
  if (amountMicroUsd > 0) return `+${formatted}`;
  if (amountMicroUsd < 0) return `−${formatted}`;
  return formatted;
}

/** Formats a gain/loss in basis points with an explicit sign, e.g. "+4.20%". */
export function formatSignedPercent(bps: number): string {
  const formatted = formatRatePercent(Math.abs(bps));
  if (bps > 0) return `+${formatted}`;
  if (bps < 0) return `−${formatted}`;
  return formatted;
}
