import { REAL_CASH_TOKEN } from "../constants";

// Whole and/or fractional digits only — no sign, no exponent, no thousands
// separators. Rejects anything malformed outright rather than coercing it.
const AMOUNT_PATTERN = /^(\d+)(?:\.(\d+))?$/;

/** $50.00 at REAL_CASH_TOKEN's 6 decimals — see the plan's confirmed policy numbers. */
export const MAX_PAYMENT_BASE_UNITS = "50000000";

/**
 * Converts a user-entered decimal string directly into Cash's integer
 * base-unit representation, via string digit-shifting — never through
 * parseFloat or floating-point multiplication (mirrors lib/parse-amount.ts's
 * identical discipline for Practice). Returns a decimal string, not a JS
 * number, so a value can never silently lose precision — consistent with
 * lib/real/display/cash.ts's BigInt-only philosophy in the display
 * direction. Returns null for malformed, negative, or over-precise (more
 * than REAL_CASH_TOKEN.decimals fractional digits) input.
 *
 * Like lib/parse-amount.ts, this only validates *shape* — "0" parses
 * successfully to "0". Rejecting zero, over-ceiling, and over-balance
 * amounts is the caller's job (see exceedsPaymentCeiling / isZeroBaseUnits /
 * exceedsAvailableBalance below), matching Practice's PayView pattern of a
 * shape parser plus separate domain checks.
 */
export function parseCashInputToBaseUnits(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const match = AMOUNT_PATTERN.exec(trimmed);
  if (!match) return null;

  const [, wholePart, fractionalPart = ""] = match;
  if (fractionalPart.length > REAL_CASH_TOKEN.decimals) return null;

  const digits = (wholePart + fractionalPart.padEnd(REAL_CASH_TOKEN.decimals, "0")).replace(/^0+(?=\d)/, "");
  return digits;
}

export function isZeroBaseUnits(baseUnits: string): boolean {
  return /^0+$/.test(baseUnits);
}

/**
 * True only for exactly what parseCashInputToBaseUnits ever produces: "0",
 * or digits with no leading zero. The server never trusts that a client
 * actually used parseCashInputToBaseUnits to produce the amountBaseUnits it
 * sends — this independently re-validates the wire value's shape before any
 * of the numeric checks below run.
 */
export function isCanonicalBaseUnitsString(value: string): boolean {
  return /^(0|[1-9]\d*)$/.test(value);
}

/**
 * String-only comparison of two non-negative base-10 integer strings with no
 * leading zeros (which is what parseCashInputToBaseUnits/readCashBalance
 * both always produce): a longer string is always numerically larger, and
 * equal-length strings compare the same lexicographically as numerically.
 * Never routes either value through Number() or a BigInt conversion — kept
 * consistent with the project's "no float in financial input" rule even
 * though BigInt itself wouldn't be a float; there's simply no need to leave
 * the string domain for a comparison.
 */
function baseUnitsGreaterThan(a: string, b: string): boolean {
  if (a.length !== b.length) return a.length > b.length;
  return a > b;
}

export function exceedsPaymentCeiling(amountBaseUnits: string): boolean {
  return baseUnitsGreaterThan(amountBaseUnits, MAX_PAYMENT_BASE_UNITS);
}

export function exceedsAvailableBalance(amountBaseUnits: string, balanceBaseUnits: string): boolean {
  return baseUnitsGreaterThan(amountBaseUnits, balanceBaseUnits);
}
