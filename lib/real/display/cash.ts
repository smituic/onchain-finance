/**
 * Presentation-only: the "USDC -> Cash" consumer rename and its display
 * formatting live here, never in the domain/chain layer (lib/real/chain,
 * lib/real/constants) — same boundary Practice Mode's lib/format.ts keeps
 * for its own asset-symbol renames.
 */
export const CASH_LABEL = "Cash";

/**
 * Formats an exact base-unit balance (a decimal string, e.g. what
 * lib/real/chain/balance.ts's readCashBalance returns) as consumer-facing
 * money, e.g. "$0.00" / "$20.00". Integer/BigInt math only, start to
 * finish — never routes the amount through a JS float, so a balance near or
 * beyond Number.MAX_SAFE_INTEGER base units still formats exactly.
 */
export function formatCashBaseUnits(balanceBaseUnits: string, decimals: number): string {
  if (!/^\d+$/.test(balanceBaseUnits)) {
    throw new Error("balanceBaseUnits must be a non-negative integer string.");
  }
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error("decimals must be a non-negative integer.");
  }

  // BigInt(...) calls, not `n`-suffixed literals: the project's TypeScript
  // target is ES2017 (see ARCHITECTURE.md), which doesn't support BigInt
  // literal syntax — this stays exact without requiring that target bump.
  const units = BigInt(balanceBaseUnits);
  const hundred = BigInt(100);
  const scale = BigInt(10) ** BigInt(decimals);

  // Round to the nearest whole cent (round-half-up) via integer division —
  // never a float division anywhere in this computation.
  const totalCentsNumerator = units * hundred;
  let totalCents = totalCentsNumerator / scale;
  const remainder = totalCentsNumerator % scale;
  if (remainder * BigInt(2) >= scale) totalCents += BigInt(1);

  const dollars = totalCents / hundred;
  const cents = totalCents % hundred;
  return `$${dollars.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}
