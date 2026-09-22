/**
 * Presentation-only, same boundary as cash.ts's "USDC -> Cash" rename: the
 * state machine's own vocabulary (lib/real/server/payment-attempts.ts's
 * PaymentAttemptState) never appears as primary UI copy. This union is a
 * deliberate duplicate of that 9-state list — the same duplication
 * lib/stores/real-payment-store.ts's RealPaymentAttemptState already makes,
 * so a client-facing module never imports the server-only type.
 */
export type PaymentDisplayState =
  | "prepared"
  | "awaiting_authorization"
  | "signed"
  | "submitting"
  | "submitted"
  | "confirmed"
  | "failed"
  | "cancelled"
  | "unknown";

/**
 * Batch 2e's required consumer-language mapping. No UserOperation/
 * EntryPoint/Pimlico/Safe/gas/calldata anywhere in the output.
 */
export function paymentStatusLabel(state: PaymentDisplayState): string {
  switch (state) {
    case "confirmed":
      return "Sent";
    case "submitted":
    case "submitting":
      return "Sending";
    case "unknown":
      return "Checking status";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "awaiting_authorization":
    case "prepared":
    case "signed":
      return "Pending approval";
  }
}
