/**
 * Normalises what the CDP SDK actually returns for a user operation into
 * the distinct identifiers the PoC must keep separate (see the PoC brief:
 * do not collapse everything into "tx hash").
 *
 * Source of truth is the installed `@coinbase/cdp-core` /
 * `@coinbase/cdp-api-client` types:
 *   - `sendUserOperation` → `{ userOperationHash }` only. No calls ID, no tx hash.
 *   - `getUserOperation` → `EvmUserOperation` with `status`, optional
 *     `transactionHash`, optional `receipts[]` (each with optional
 *     transactionHash/blockNumber/gasUsed/revert).
 * Nothing else is invented here.
 */

/** Mirrors `EvmUserOperationStatus` from the installed API client. */
export type CdpUserOperationStatus = "pending" | "signed" | "broadcast" | "complete" | "dropped" | "failed";

export const CDP_USER_OPERATION_STATUSES: readonly CdpUserOperationStatus[] = [
  "pending",
  "signed",
  "broadcast",
  "complete",
  "dropped",
  "failed",
];

/** Shape of `EvmUserOperation` we depend on (structural, so tests need no SDK). */
export type CdpUserOperationLike = {
  userOpHash: string;
  status: string;
  transactionHash?: string;
  receipts?: Array<{
    transactionHash?: string;
    blockNumber?: number;
    gasUsed?: string;
    revert?: { data: string; message: string };
  }>;
};

export type UserOperationPhase = "in-flight" | "confirmed" | "reverted" | "dropped" | "failed" | "unknown";

export type NormalizedUserOperation = {
  /** ERC-4337 user-operation hash — what `sendUserOperation` returned. Not a transaction hash. */
  userOperationHash: string;
  /** Raw SDK status string, untouched. */
  sdkStatus: string;
  /** Whether the raw status is one the installed SDK types declare. */
  isKnownStatus: boolean;
  /** Coarse lifecycle bucket for the UI. */
  phase: UserOperationPhase;
  /** Bundler transaction hash that included the user op, once known. */
  transactionHash: string | null;
  /** Receipt evidence, if the SDK returned any. */
  receipt: {
    blockNumber: number | null;
    gasUsed: string | null;
    revertMessage: string | null;
  } | null;
  /** Whether the SDK's top-level transactionHash and receipt hash agree (when both present). */
  hashesAgree: boolean | null;
};

export function isKnownCdpStatus(status: string): status is CdpUserOperationStatus {
  return (CDP_USER_OPERATION_STATUSES as readonly string[]).includes(status);
}

export function phaseForStatus(status: string, revertMessage: string | null): UserOperationPhase {
  switch (status) {
    case "pending":
    case "signed":
    case "broadcast":
      return "in-flight";
    case "complete":
      return revertMessage ? "reverted" : "confirmed";
    case "dropped":
      return "dropped";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}

export function normalizeUserOperation(op: CdpUserOperationLike): NormalizedUserOperation {
  const receipt = op.receipts?.[0] ?? null;
  const revertMessage = receipt?.revert?.message ?? null;
  const topLevelHash = op.transactionHash && op.transactionHash !== "" ? op.transactionHash : null;
  const receiptHash = receipt?.transactionHash && receipt.transactionHash !== "" ? receipt.transactionHash : null;

  return {
    userOperationHash: op.userOpHash,
    sdkStatus: op.status,
    isKnownStatus: isKnownCdpStatus(op.status),
    phase: phaseForStatus(op.status, revertMessage),
    transactionHash: topLevelHash ?? receiptHash,
    receipt: receipt
      ? {
          blockNumber: receipt.blockNumber ?? null,
          gasUsed: receipt.gasUsed ?? null,
          revertMessage,
        }
      : null,
    hashesAgree: topLevelHash && receiptHash ? topLevelHash.toLowerCase() === receiptHash.toLowerCase() : null,
  };
}

/** Whether polling should continue. */
export function isTerminalPhase(phase: UserOperationPhase): boolean {
  return phase === "confirmed" || phase === "reverted" || phase === "dropped" || phase === "failed";
}
