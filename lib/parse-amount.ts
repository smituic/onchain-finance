import { DECIMALS } from "@/simulation";

// Whole and/or fractional digits only — no sign, no exponent, no thousands
// separators. Rejects anything malformed outright rather than coercing it.
const AMOUNT_PATTERN = /^(\d+)(?:\.(\d+))?$/;

/**
 * Converts a user-entered decimal string directly into the ledger's integer
 * micro-unit representation, via string digit-shifting — never through
 * parseFloat or floating-point multiplication, so it can't introduce binary
 * floating-point error into financial input. Returns null for malformed,
 * negative, or over-precise (more than DECIMALS fractional digits) input;
 * callers should treat null as "not a valid amount", not silently round.
 *
 * "0" parses successfully to 0 — this parser only validates *shape*; the
 * simulation engine remains responsible for rejecting a zero-value swap.
 */
export function parseAmountToMicroUnits(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const match = AMOUNT_PATTERN.exec(trimmed);
  if (!match) return null;

  const [, wholePart, fractionalPart = ""] = match;
  if (fractionalPart.length > DECIMALS) return null;

  const digits = (wholePart + fractionalPart.padEnd(DECIMALS, "0")).replace(/^0+(?=\d)/, "");
  const microUnits = Number(digits);

  if (!Number.isSafeInteger(microUnits)) return null;
  return microUnits;
}
