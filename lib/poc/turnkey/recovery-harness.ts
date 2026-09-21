import type { PendingOperation } from "./public-state";

/**
 * DEV-ONLY reconciliation test harness. Manufactures a LOCAL, unresolved
 * ("unknown") representation of an already-confirmed operation's known
 * userOperationHash, so "Reconcile pending" can be exercised deterministically
 * against the real bundler/chain lookup without ever sending another live
 * payment. Both functions in this module are pure data transforms over
 * PendingOperation — this file imports nothing from ./account, ./payment,
 * ./sign-probe, ./verified-account, ./raw-sign, "permissionless",
 * "@turnkey/http", "@turnkey/viem", or "@turnkey/webauthn-stamper", so it is
 * architecturally incapable of signing, prompting WebAuthn, or submitting
 * anything — not merely "didn't happen to call it this run".
 */

/**
 * Finds the operation to simulate a recovery of: the active pending pointer
 * if it is itself already confirmed with a known hash, otherwise the most
 * recent confirmed-with-hash entry in history. Returns null when neither
 * exists — the caller must not offer the simulation control in that case.
 */
export function findSourceForSimulatedRecovery(
  pending: PendingOperation | null,
  history: PendingOperation[],
): PendingOperation | null {
  // Never replace a real unresolved payment with a resolved historical one:
  // that would erase the active send-blocking record.
  if (pending && pending.status !== "confirmed" && pending.status !== "failed") return null;
  if (pending && pending.status === "confirmed" && pending.userOperationHash) return pending;
  return history.find((op) => op.status === "confirmed" && op.userOperationHash) ?? null;
}

/**
 * Returns a new, unresolved ("unknown") PendingOperation that preserves the
 * source's userOperationHash but clears transactionHash/receiptStatus — the
 * exact shape "Reconcile pending" needs to have something to resolve. Uses a
 * brand-new id (never the source's own id): rememberOperation dedups history
 * by id, so persisting this under the source's id would silently overwrite
 * the real confirmed history entry the moment it's saved as "unknown".
 * simulatedRecoveryOf records the relationship instead, so storage/history
 * stay traceable rather than showing an unexplained duplicate.
 */
export function simulateUnresolvedKnownHash(source: PendingOperation): PendingOperation {
  if (!source.userOperationHash) {
    throw new Error("Cannot simulate an unresolved known-hash state without a userOperationHash.");
  }
  return {
    id: `sim-recovery-${source.id}-${Date.now()}`,
    status: "unknown",
    recipient: source.recipient,
    amountUsdc: source.amountUsdc,
    userOperationHash: source.userOperationHash,
    transactionHash: null,
    receiptStatus: null,
    submittedAt: source.submittedAt,
    lastError: null,
    autoResend: false,
    simulatedRecoveryOf: source.id,
  };
}
