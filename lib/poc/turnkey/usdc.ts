const AMOUNT_PATTERN = /^(\d+)(?:\.(\d+))?$/;

/**
 * Parses a decimal USDC/Cash amount into base units (6 decimals) using
 * string digit-shifting — never parseFloat.
 */
export function parseUsdcToUnits(raw: string, decimals = 6): bigint | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const match = AMOUNT_PATTERN.exec(trimmed);
  if (!match) return null;

  const wholePart = match[1] ?? "0";
  const fractionalPart = match[2] ?? "";
  if (fractionalPart.length > decimals) return null;

  const digits = `${wholePart}${fractionalPart.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
  try {
    return BigInt(digits);
  } catch {
    return null;
  }
}

export function formatUsdcFromUnits(units: bigint, decimals = 6): string {
  const negative = units < BigInt(0);
  const absolute = negative ? -units : units;
  const padded = absolute.toString().padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  const rendered = fraction.length > 0 ? `${whole}.${fraction}` : whole;
  return negative ? `-${rendered}` : rendered;
}
