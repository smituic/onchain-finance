/**
 * The finite validity window every Real Pay SafeOp is signed with. Pure —
 * no clock or chain access here; callers pass the time source explicitly.
 *
 * Why these numbers (not arbitrary):
 *
 * - `validUntil = 0` means "never expires" in our exact stack: Safe4337Module
 *   0.3.0 passes the signature's validAfter/validUntil straight into
 *   validationData, and EntryPoint v0.7's _parseValidationData maps
 *   validUntil == 0 to type(uint48).max (verified against both upstream
 *   sources). Nothing else we control bounded a signed SafeOp — and every
 *   payment gets its own nonce KEY (viem's nonceKeyManager, sequence 0), so
 *   a later payment never invalidates an earlier signature either.
 * - 600 s: the EntryPoint enforces the INTERSECTION of the account's and the
 *   paymaster's windows, and Pimlico's sponsorship signature already
 *   expires exactly 600 s after prepare (observed on every live attempt), so
 *   a longer window buys nothing for sponsored operations. A shorter one
 *   would start failing real passkey ceremonies (observed prepare ->
 *   confirmed: 8 s to ~3 min). 600 s keeps today's effective limit but makes
 *   it OURS: enforced at submit, independent of a third party's policy, and
 *   known to reconciliation.
 * - validAfter = 0: there is no reason to delay validity, and a non-zero
 *   value would only add clock-skew failure modes.
 * - 60 s dispatch margin: time for bundler simulation, mempool, and
 *   inclusion on 2 s blocks, plus server/chain clock skew. Skew is safe in
 *   both directions — refusing early sends nothing; sending late is rejected
 *   on-chain (AA22 expired) and nothing moves.
 */
export const SAFE_OP_VALIDITY_SECONDS = 600;
export const SAFE_OP_VALID_AFTER = 0;
export const SAFE_OP_MIN_REMAINING_AT_DISPATCH_SECONDS = 60;

/** Anchored to the chain's own clock (a block timestamp) — the clock the EntryPoint enforces against. */
export function computeValidUntil(chainTimestampSeconds: bigint): number {
  return Number(chainTimestampSeconds) + SAFE_OP_VALIDITY_SECONDS;
}

/** False (never dispatch) when too little of the window remains — or when there is no finite window at all. */
export function hasEnoughValidityToDispatch(validUntil: number | null, nowSeconds: number): boolean {
  if (validUntil === null || !Number.isSafeInteger(validUntil) || validUntil <= 0) return false;
  return validUntil - nowSeconds >= SAFE_OP_MIN_REMAINING_AT_DISPATCH_SECONDS;
}

/** EntryPoint v0.7 NonceManager: key = nonce >> 64 (uint192), sequence = low 64 bits. */
export function splitUserOperationNonce(nonce: bigint): { key: bigint; sequence: bigint } {
  return { key: nonce >> BigInt(64), sequence: nonce & ((BigInt(1) << BigInt(64)) - BigInt(1)) };
}
