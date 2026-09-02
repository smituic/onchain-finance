// Fixed-point integer money helpers for the simulation ledger.
//
// All simulated quantities use a uniform number of decimal places across every
// asset. This is a *simulation precision* choice — it keeps the ledger's math
// simple and float-free — and is not intended to mirror any asset's actual
// on-chain token decimals (e.g. real ETH uses 18, real USDC uses 6). Ledger
// state must never contain a float; only integer micro-units.

export const DECIMALS = 6;
const SCALE = 10 ** DECIMALS;

/** Converts a whole-unit amount (e.g. 10_000 USDC) to integer micro-units. */
export function toMicroUnits(amount: number): number {
  return Math.round(amount * SCALE);
}

/** Converts integer micro-units back to a whole-unit amount, for display. */
export function fromMicroUnits(microUnits: number): number {
  return microUnits / SCALE;
}
