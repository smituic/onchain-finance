export const OPERATION_STATUSES = [
  "preparing",
  "awaiting-passkey",
  "signed",
  "sponsored",
  "submitted",
  "pending",
  "confirmed",
  "failed",
  "unknown",
] as const;

export type OperationStatus = (typeof OPERATION_STATUSES)[number];

const STATUS_SET = new Set<string>(OPERATION_STATUSES);

export function isOperationStatus(value: string): value is OperationStatus {
  return STATUS_SET.has(value);
}

export function normalizeOperationStatus(value: string | null | undefined): OperationStatus {
  if (!value) return "unknown";
  const trimmed = value.trim().toLowerCase();
  if (isOperationStatus(trimmed)) return trimmed;
  if (trimmed === "success" || trimmed === "mined" || trimmed === "included") return "confirmed";
  if (trimmed === "reverted" || trimmed === "error") return "failed";
  if (trimmed === "timeout" || trimmed === "dropped" || trimmed === "not_found") return "unknown";
  return "unknown";
}

/** A transport timeout is uncertainty, not on-chain failure. */
export function statusAfterTransportUncertainty(current: OperationStatus): OperationStatus {
  if (current === "confirmed" || current === "failed") return current;
  if (current === "submitted" || current === "pending" || current === "sponsored") return "unknown";
  return "unknown";
}
