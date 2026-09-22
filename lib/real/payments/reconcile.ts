import type { Address, Hash } from "viem";

export type UserOperationReceiptLike = {
  userOpHash: Hash;
  sender: Address;
  success: boolean;
  receipt: {
    transactionHash: Hash;
    status: "success" | "reverted";
  };
};

export type ReconcileOutcome =
  | { outcome: "confirmed"; transactionHash: Hash }
  | { outcome: "failed"; transactionHash: Hash }
  | { outcome: "unresolved" };

/**
 * Mirrors poc/turnkey-real-account's audit-fixed M2 logic
 * (TURNKEY_POC_AUDIT.md): a receipt only ever counts as confirmed/failed
 * when its own userOpHash matches the expected (precomputed, durable —
 * never client-supplied) hash, its sender matches the expected Safe, and it
 * carries a genuine boolean `success` plus a real transaction hash and
 * status. Anything else — no receipt yet, a hash/sender mismatch, a
 * malformed shape — stays "unresolved" rather than being treated as proof
 * of either outcome. A zero/missing receipt is never proof of failure, and
 * a receipt for the wrong operation is never proof of success.
 */
export function classifyReceipt(receipt: UserOperationReceiptLike | null, expected: { userOperationHash: Hash; sender: Address }): ReconcileOutcome {
  if (!receipt) return { outcome: "unresolved" };
  if (receipt.userOpHash.toLowerCase() !== expected.userOperationHash.toLowerCase()) return { outcome: "unresolved" };
  if (receipt.sender.toLowerCase() !== expected.sender.toLowerCase()) return { outcome: "unresolved" };
  if (typeof receipt.success !== "boolean") return { outcome: "unresolved" };
  if (!receipt.receipt?.transactionHash) return { outcome: "unresolved" };
  if (receipt.receipt.status !== "success" && receipt.receipt.status !== "reverted") return { outcome: "unresolved" };

  return receipt.success && receipt.receipt.status === "success"
    ? { outcome: "confirmed", transactionHash: receipt.receipt.transactionHash }
    : { outcome: "failed", transactionHash: receipt.receipt.transactionHash };
}
