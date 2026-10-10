import { canonicalizeHandle, formatHandle } from "../handle";

/**
 * Presentation-only (Handle Pay Slice D): how the recipient of a payment is
 * shown to its payer — on the approval, sending, and sent screens and in
 * Recent activity. One place, so those surfaces cannot drift apart.
 *
 * `recipientIdentity` is the server's stored snapshot for a handle payment
 * ({ handle, displayName }) and null for an address payment. It arrives over
 * HTTP, so it is validated here before anything is shown, and anything that
 * is not exactly a well-formed identity falls back to the address. Nothing is
 * repaired or guessed: a handle is never derived from an address, and a
 * display name is never shown without its handle.
 */
export type PaymentRecipientIdentity = { handle: string; displayName: string | null };

export type PaymentRecipientDisplay =
  | { kind: "handle"; handle: string; displayName: string | null; label: string }
  | { kind: "address"; label: string };

export function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Strict on purpose (fail closed): an object with exactly the two keys
 * `handle` and `displayName`, a handle that is already its own canonical
 * form, and a display name that is null or a non-blank string. Anything else
 * — a missing or extra key, "@smit", "Smit", an empty name — is not an
 * identity.
 */
export function readRecipientIdentity(value: unknown): PaymentRecipientIdentity | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("handle") || !keys.includes("displayName")) return null;
  const { handle, displayName } = value as { handle: unknown; displayName: unknown };
  if (typeof handle !== "string") return null;
  const canonical = canonicalizeHandle(handle);
  if (!canonical.ok || canonical.handle !== handle) return null;
  if (displayName !== null && (typeof displayName !== "string" || displayName.trim() === "")) return null;
  return { handle, displayName };
}

/** "Smit Patel (@smit)", or "@smit" when there is no display name. */
export function formatRecipientIdentity(identity: PaymentRecipientIdentity): string {
  return identity.displayName === null ? formatHandle(identity.handle) : `${identity.displayName} (${formatHandle(identity.handle)})`;
}

export function describePaymentRecipient(payment: { recipient: string; recipientIdentity?: unknown }): PaymentRecipientDisplay {
  const identity = readRecipientIdentity(payment.recipientIdentity);
  if (!identity) return { kind: "address", label: shortenAddress(payment.recipient) };
  return { kind: "handle", handle: identity.handle, displayName: identity.displayName, label: formatRecipientIdentity(identity) };
}
