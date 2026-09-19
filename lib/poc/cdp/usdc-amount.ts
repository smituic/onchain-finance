import { USDC_DECIMALS } from "./constants";

/**
 * USDC amount conversion for the PoC, as bigint base units (6 decimals).
 *
 * Same string-digit-shifting approach as lib/parse-amount.ts — never through
 * floating point — but returning bigint because that is what an ERC-20
 * `transfer(address,uint256)` call takes. Deliberately not shared with the
 * Practice parser: the two layers are parallel, and this one is disposable.
 *
 * BigInt() calls rather than literals keep this compiling under the repo's
 * ES2017 target (ARCHITECTURE.md defers the ES2020 decision).
 */

const AMOUNT_PATTERN = /^(\d+)(?:\.(\d+))?$/;
const BASE_UNITS_PER_USDC = BigInt(10) ** BigInt(USDC_DECIMALS);

/** "1.5" → 1500000n. Null for malformed, negative, or over-precise input. */
export function parseUsdcAmount(raw: string): bigint | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const match = AMOUNT_PATTERN.exec(trimmed);
  if (!match) return null;

  const [, wholePart, fractionalPart = ""] = match;
  if (fractionalPart.length > USDC_DECIMALS) return null;

  return BigInt(wholePart + fractionalPart.padEnd(USDC_DECIMALS, "0"));
}

/** 1500000n → "1.50". Always shows two decimals; more only when needed, never trailing beyond that. */
export function formatUsdcAmount(baseUnits: bigint): string {
  const negative = baseUnits < BigInt(0);
  const abs = negative ? -baseUnits : baseUnits;
  const whole = abs / BASE_UNITS_PER_USDC;
  const fraction = (abs % BASE_UNITS_PER_USDC).toString().padStart(USDC_DECIMALS, "0");

  // Keep at least 2 fractional digits, drop trailing zeros beyond that.
  const trimmedFraction = fraction.replace(/0+$/, "").padEnd(2, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${trimmedFraction}`;
}

/** Wei → ETH string with up to 18 decimals, trailing zeros trimmed (for a diagnostic readout). */
export function formatEth(wei: bigint): string {
  const unit = BigInt(10) ** BigInt(18);
  const whole = wei / unit;
  const fraction = (wei % unit).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole.toString()}.${fraction}`;
}
