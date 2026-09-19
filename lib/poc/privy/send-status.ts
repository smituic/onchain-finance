/**
 * Privy PoC — send lifecycle model and reload reconciliation. DISPOSABLE
 * (see config.ts). Pure logic here; the browser I/O lives in
 * `pending-send-storage.ts`.
 *
 * Status vocabulary (deliberately distinct):
 *   preparing        — building the request; nothing has left the device.
 *   awaiting-user    — the wallet UI is asking the user to approve.
 *   submitted        — Privy accepted the request; a transaction hash exists.
 *   pending          — the hash is known but no receipt yet.
 *   confirmed        — receipt with status "success".
 *   failed           — receipt with status "reverted", or Privy rejected before
 *                      any submission.
 *   unknown          — transport-uncertain: the request may or may not have
 *                      been broadcast (e.g. reload mid-approval, or the SDK
 *                      returned no hash). Never auto-resend from here.
 *
 * A timeout is never mapped to `failed`.
 */
import { normaliseHash, type HexHash } from "./identifiers";

export type SendStatus =
  | "preparing"
  | "awaiting-user"
  | "submitted"
  | "pending"
  | "confirmed"
  | "failed"
  | "unknown";

export type PendingSendRecord = {
  /** Client-generated, so a record exists before any hash does. */
  clientRequestId: string;
  chainId: number;
  /** Sending account address (public). */
  from: `0x${string}`;
  to: `0x${string}`;
  /** USDC base units, as a decimal string (bigint is not JSON-serialisable). */
  amountBaseUnits: string;
  status: SendStatus;
  transactionHash: HexHash | null;
  createdAtMs: number;
  updatedAtMs: number;
  /**
   * Public receipt facts once known. `from` is the address that paid for the
   * enclosing transaction — for a sponsored user operation this is the
   * bundler, not the user's account, which is the on-chain evidence of
   * sponsorship.
   */
  receipt: { blockNumber: string; status: "success" | "reverted"; from: string | null } | null;
  note: string | null;
};

export function createPendingSendRecord(input: {
  clientRequestId: string;
  chainId: number;
  from: `0x${string}`;
  to: `0x${string}`;
  amountBaseUnits: bigint;
  nowMs: number;
}): PendingSendRecord {
  return {
    clientRequestId: input.clientRequestId,
    chainId: input.chainId,
    from: input.from,
    to: input.to,
    amountBaseUnits: input.amountBaseUnits.toString(),
    status: "preparing",
    transactionHash: null,
    createdAtMs: input.nowMs,
    updatedAtMs: input.nowMs,
    receipt: null,
    note: null,
  };
}

export function withStatus(
  record: PendingSendRecord,
  status: SendStatus,
  nowMs: number,
  note: string | null = record.note,
): PendingSendRecord {
  return { ...record, status, note, updatedAtMs: nowMs };
}

/**
 * Interpret what `sendTransaction` resolved with. The React SDK only returns
 * `{ hash }`; for sponsored (user-operation) sends the hash may legitimately be
 * empty until inclusion. An absent hash is transport-uncertain, not a failure.
 */
export function applySendResult(
  record: PendingSendRecord,
  rawHash: string | null | undefined,
  nowMs: number,
): PendingSendRecord {
  const normalised = normaliseHash(rawHash);
  switch (normalised.kind) {
    case "hash":
      return {
        ...record,
        status: "submitted",
        transactionHash: normalised.value,
        note: null,
        updatedAtMs: nowMs,
      };
    case "absent":
      return withStatus(
        record,
        "unknown",
        nowMs,
        "Privy resolved without a transaction hash. The operation may still be in flight (sponsored sends are user operations). Check balances/explorer; do not resend.",
      );
    case "invalid":
      return withStatus(
        record,
        "unknown",
        nowMs,
        "Privy returned an identifier that is not a 32-byte transaction hash. Treat as uncertain; do not resend.",
      );
  }
}

/** How Privy's rejection should be classified: before broadcast it is a clean failure. */
export function applySendError(
  record: PendingSendRecord,
  message: string,
  nowMs: number,
): PendingSendRecord {
  // If we already hold a hash the request left the device; an error afterwards is uncertain.
  if (record.transactionHash) return withStatus(record, "unknown", nowMs, message);
  return withStatus(record, "failed", nowMs, message);
}

export type ReceiptLookup =
  | { kind: "found"; status: "success" | "reverted"; blockNumber: bigint; from: string | null }
  | { kind: "not-found" }
  | { kind: "error"; message: string };

/**
 * Reconcile a record against a chain read. Reads are independent of Privy's
 * session, so this works after reload and after sign-out.
 */
export function reconcileWithReceipt(
  record: PendingSendRecord,
  lookup: ReceiptLookup,
  nowMs: number,
): PendingSendRecord {
  if (!record.transactionHash) {
    return withStatus(
      record,
      record.status === "preparing" || record.status === "awaiting-user" || record.status === "unknown"
        ? "unknown"
        : record.status,
      nowMs,
      "No transaction hash was recorded, so the chain cannot be queried for this request. Verify via balance change; do not resend.",
    );
  }
  switch (lookup.kind) {
    case "found":
      return {
        ...record,
        status: lookup.status === "success" ? "confirmed" : "failed",
        receipt: { blockNumber: lookup.blockNumber.toString(), status: lookup.status, from: lookup.from },
        note: null,
        updatedAtMs: nowMs,
      };
    case "not-found":
      return withStatus(record, "pending", nowMs, "Hash known; no receipt yet.");
    case "error":
      // A read error is not a chain outcome. Keep the previous status, record the note.
      return withStatus(record, record.status === "submitted" ? "pending" : record.status, nowMs, `Read error: ${lookup.message}`);
  }
}

/** A record found on load is "recovered": status is whatever we last knew, flagged for reconciliation. */
export function describeRecoveredRecord(record: PendingSendRecord): string {
  switch (record.status) {
    case "confirmed":
      return "Recovered a confirmed payment record.";
    case "failed":
      return "Recovered a failed payment record.";
    case "pending":
    case "submitted":
      return "Recovered an in-flight payment with a transaction hash. Reconcile from chain; do not resend.";
    default:
      return "Recovered a payment record with no transaction hash. Its outcome is uncertain; check balances before doing anything else. Do not resend.";
  }
}

function parseReceipt(value: unknown): PendingSendRecord["receipt"] {
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.blockNumber !== "string" || (r.status !== "success" && r.status !== "reverted")) return null;
  return {
    blockNumber: r.blockNumber,
    status: r.status,
    from: typeof r.from === "string" ? r.from : null,
  };
}

/** Validate an unknown JSON value as a PendingSendRecord (storage may be stale or edited). */
export function parsePendingSendRecord(value: unknown): PendingSendRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const statuses: SendStatus[] = ["preparing", "awaiting-user", "submitted", "pending", "confirmed", "failed", "unknown"];
  if (
    typeof v.clientRequestId !== "string" ||
    typeof v.chainId !== "number" ||
    typeof v.from !== "string" ||
    typeof v.to !== "string" ||
    typeof v.amountBaseUnits !== "string" ||
    !/^\d+$/.test(v.amountBaseUnits) ||
    typeof v.status !== "string" ||
    !statuses.includes(v.status as SendStatus) ||
    typeof v.createdAtMs !== "number" ||
    typeof v.updatedAtMs !== "number"
  ) {
    return null;
  }
  const hash = v.transactionHash;
  const hashNorm = typeof hash === "string" ? normaliseHash(hash) : null;
  return {
    clientRequestId: v.clientRequestId,
    chainId: v.chainId,
    from: v.from as `0x${string}`,
    to: v.to as `0x${string}`,
    amountBaseUnits: v.amountBaseUnits,
    status: v.status as SendStatus,
    transactionHash: hashNorm?.kind === "hash" ? hashNorm.value : null,
    createdAtMs: v.createdAtMs,
    updatedAtMs: v.updatedAtMs,
    receipt: parseReceipt(v.receipt),
    note: typeof v.note === "string" ? v.note : null,
  };
}
