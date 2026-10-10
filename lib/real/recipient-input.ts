import { canonicalizeHandle } from "./handle";
import { normalizeAddress } from "./identifiers";

/**
 * Handle Pay Slice C — what the ONE "To" field on Real Pay currently holds.
 * Pure and browser-safe: it reads no store, makes no request, and never turns
 * a handle into an address (only the server does that, at prepare).
 *
 * Deliberately outside lib/real/payments/** — that tree imports no handle
 * module.
 */
export type RecipientInputClassification =
  | { kind: "empty" }
  | { kind: "address"; recipient: string }
  | { kind: "handle"; canonicalHandle: string }
  | { kind: "invalid"; reason: string };

export const INVALID_ADDRESS_MESSAGE = "Enter a valid account address.";
export const INVALID_HANDLE_MESSAGE = "Enter a valid @name.";
export const RECIPIENT_NOT_FOUND_MESSAGE = "We couldn't find anyone with that name.";
export const RECIPIENT_LOOKUP_FAILED_MESSAGE = "Couldn't check that name. Try again.";
/** Slice E: the name check was refused because this account has checked too many names for now. No countdown, no automatic retry. */
export const RECIPIENT_LOOKUP_RATE_LIMITED_MESSAGE = "Too many tries. Try again later.";

export function ownHandleMessage(handle: string): string {
  return `That's your own @${handle}.`;
}

/**
 * Anything that starts like an address ("0x…") is judged ONLY as an address:
 * a partial or mistyped one is invalid, never a handle candidate. Everything
 * else goes through the shared handle canonicalizer ("@smit", "Smit", and
 * " smit " are all the handle `smit`).
 */
export function classifyRecipientInput(input: string): RecipientInputClassification {
  const trimmed = input.trim();
  if (trimmed === "") return { kind: "empty" };
  if (/^0x/i.test(trimmed)) {
    const recipient = normalizeAddress(trimmed);
    return recipient ? { kind: "address", recipient } : { kind: "invalid", reason: INVALID_ADDRESS_MESSAGE };
  }
  // The raw input, not `trimmed`: the canonicalizer strips ASCII whitespace only.
  const canonical = canonicalizeHandle(input);
  return canonical.ok ? { kind: "handle", canonicalHandle: canonical.handle } : { kind: "invalid", reason: INVALID_HANDLE_MESSAGE };
}

/**
 * The advisory lookup's state for the CURRENT recipient input (any edit
 * resets it to idle). `found` keeps exactly the three public fields — never
 * an app user id, a Safe address, or anything else the server might send.
 */
export type RecipientLookup =
  | { status: "idle" }
  | { status: "looking_up" }
  | { status: "found"; handle: string; displayName: string | null; isSelf: boolean }
  | { status: "not_found" }
  | { status: "error" }
  | { status: "rate_limited" };

/** Everything the store and the form need to know about the recipient, derived from the input + the lookup state. */
export type RecipientView =
  | { kind: "empty" }
  | { kind: "invalid"; message: string }
  | { kind: "address"; recipient: string }
  | { kind: "self"; handle: string }
  | { kind: "unresolved"; handle: string }
  | { kind: "checking"; handle: string }
  | { kind: "found"; handle: string; displayName: string | null }
  | { kind: "not_found"; handle: string }
  | { kind: "lookup_failed"; handle: string }
  | { kind: "lookup_rate_limited"; handle: string };

/**
 * `found` is returned only when the lookup's handle IS the input's canonical
 * handle and it isn't the payer — the one state from which a handle payment
 * may be reviewed or prepared. `ownHandle` (the signed-in account's own
 * handle, when known) short-circuits to `self` without a lookup. Advisory
 * only: prepare re-resolves the handle and enforces self-payment itself.
 */
export function resolveRecipientView(input: string, lookup: RecipientLookup, ownHandle: string | null): RecipientView {
  const classified = classifyRecipientInput(input);
  if (classified.kind === "empty") return { kind: "empty" };
  if (classified.kind === "invalid") return { kind: "invalid", message: classified.reason };
  if (classified.kind === "address") return { kind: "address", recipient: classified.recipient };

  const handle = classified.canonicalHandle;
  if (ownHandle !== null && ownHandle === handle) return { kind: "self", handle };
  switch (lookup.status) {
    case "idle":
      return { kind: "unresolved", handle };
    case "looking_up":
      return { kind: "checking", handle };
    case "not_found":
      return { kind: "not_found", handle };
    case "error":
      return { kind: "lookup_failed", handle };
    case "rate_limited":
      return { kind: "lookup_rate_limited", handle };
    case "found":
      if (lookup.handle !== handle) return { kind: "unresolved", handle };
      return lookup.isSelf ? { kind: "self", handle } : { kind: "found", handle, displayName: lookup.displayName };
  }
}
