/**
 * Privy PoC — integer-only USDC amount handling. DISPOSABLE (see config.ts).
 *
 * USDC has 6 decimals. Amounts are parsed from decimal strings into base
 * units (bigint) with string arithmetic only — no floating point anywhere in
 * the financial path.
 */
import { USDC_DECIMALS } from "./config";

export type UsdcParseResult =
  | { ok: true; baseUnits: bigint }
  | { ok: false; error: string };

const DECIMAL_PATTERN = /^(\d+)(?:\.(\d*))?$/;

// `BigInt(...)` rather than `10n` literals: tsconfig targets ES2017 and
// ARCHITECTURE.md defers the ES2020 decision to when a bigint-heavy
// dependency actually lands in the product. This branch is disposable.
const ZERO = BigInt(0);
const USDC_UNIT = BigInt(10) ** BigInt(USDC_DECIMALS);

/** Parse a human-entered decimal USDC amount ("0.10") into base units (100000n). */
export function parseUsdcAmount(input: string): UsdcParseResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, error: "Enter an amount." };

  const match = DECIMAL_PATTERN.exec(trimmed);
  if (!match) return { ok: false, error: "Use digits and at most one decimal point." };

  const whole = match[1];
  const fraction = match[2] ?? "";
  if (fraction.length > USDC_DECIMALS) {
    return { ok: false, error: `Cash (USDC) supports at most ${USDC_DECIMALS} decimal places.` };
  }

  const paddedFraction = fraction.padEnd(USDC_DECIMALS, "0");
  const baseUnits = BigInt(whole) * USDC_UNIT + BigInt(paddedFraction);
  if (baseUnits === ZERO) return { ok: false, error: "Amount must be greater than zero." };

  return { ok: true, baseUnits };
}

/** Format base units (100000n) as a decimal string ("0.10"), trimming trailing zeros to at least 2 places. */
export function formatUsdcAmount(baseUnits: bigint): string {
  const negative = baseUnits < ZERO;
  const abs = negative ? -baseUnits : baseUnits;
  const whole = abs / USDC_UNIT;
  const fraction = (abs % USDC_UNIT).toString().padStart(USDC_DECIMALS, "0");
  // Keep at least two decimals for money-like display, drop the rest if zero.
  let trimmed = fraction.replace(/0+$/, "");
  if (trimmed.length < 2) trimmed = fraction.slice(0, 2);
  return `${negative ? "-" : ""}${whole.toString()}.${trimmed}`;
}
