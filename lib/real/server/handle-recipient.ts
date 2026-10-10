import { canonicalizeHandle } from "../handle";
import type { AccountHandleStore } from "./account-handles";
import { RECIPIENT_PROBE_POLICIES, type RateLimiter } from "./rate-limit";

/**
 * Handle -> recipient, for ADVISORY discovery only (Slice A). It decides
 * nothing about a payment: the authoritative resolution happens again at
 * prepare, inside the payment reservation itself (PaymentAttemptStore.
 * reserveHandlePayment, Slice B) — this lookup is never the authority.
 *
 * The resolved destination is ALWAYS handle -> app_user_id ->
 * real_accounts.safe_address (the Safe is the account). It is never the
 * Turnkey owner address — the store read this uses doesn't select that column.
 *
 * `appUserId` and `safeAddress` are SERVER-ONLY: the public response is built
 * by toPublicRecipientLookup, which names its fields explicitly and passes
 * neither through.
 *
 * A reserved handle, an unclaimed one, and an account with no valid Safe
 * address (the store's usability rule — passkeys are NOT part of it) are all
 * one `not_found` — callers cannot tell them apart.
 *
 * Slice E: every lookup of a well-formed handle is charged to the CALLER's
 * recipient-probe budget AFTER the handle is canonicalized and BEFORE the
 * store is read — found and not-found cost the same, a malformed handle costs
 * nothing, and a denied caller causes no read at all. The limiter is told
 * only the caller's own app_user_id, never the handle.
 */
export type ResolvedHandleRecipient = {
  canonicalHandle: string;
  displayName: string | null;
  appUserId: string;
  safeAddress: string;
};

export type ResolveHandleRecipientResult =
  | { outcome: "malformed"; reason: string }
  | { outcome: "not_found" }
  /** Slice E: the caller's probe budget is spent. The store was not read. */
  | { outcome: "rate_limited"; retryAfterSeconds: number }
  /** The handle is the caller's own account (compared by durable app_user_id, not by address). */
  | ({ outcome: "self" } & ResolvedHandleRecipient)
  | ({ outcome: "ok" } & ResolvedHandleRecipient);

export async function resolveHandleRecipient(input: { handles: AccountHandleStore; rateLimiter: RateLimiter; handle: unknown; currentAppUserId: string }): Promise<ResolveHandleRecipientResult> {
  const canonical = canonicalizeHandle(input.handle);
  if (!canonical.ok) return { outcome: "malformed", reason: canonical.reason };

  const admitted = await input.rateLimiter.consume({ subject: input.currentAppUserId, policies: RECIPIENT_PROBE_POLICIES });
  if (!admitted.allowed) return { outcome: "rate_limited", retryAfterSeconds: admitted.retryAfterSeconds };

  const payable = await input.handles.findPayableAccountByHandle(canonical.handle);
  if (!payable) return { outcome: "not_found" };

  const recipient: ResolvedHandleRecipient = {
    canonicalHandle: payable.handle,
    displayName: payable.displayName,
    appUserId: payable.appUserId,
    safeAddress: payable.safeAddress,
  };
  return { outcome: payable.appUserId === input.currentAppUserId ? "self" : "ok", ...recipient };
}

export type PublicRecipientLookup = { found: false } | { found: true; handle: string; displayName: string | null; isSelf: boolean };

/** The ONLY shape the lookup route returns for a lookup that ran. Explicit fields — never a spread of the resolved recipient. Not defined for `malformed` (a 400) or `rate_limited` (a 429). */
export function toPublicRecipientLookup(result: Exclude<ResolveHandleRecipientResult, { outcome: "malformed" | "rate_limited" }>): PublicRecipientLookup {
  if (result.outcome === "not_found") return { found: false };
  return { found: true, handle: result.canonicalHandle, displayName: result.displayName, isSelf: result.outcome === "self" };
}

/**
 * Handle Pay Slice B — who a payment is for, as the CLIENT stated it, parsed
 * ONCE at the route into exactly one of these shapes (payments.ts imports only
 * this type, never a handle module).
 *
 *  - `address`: the legacy path; `value` is untrusted and still `unknown`.
 *  - `handle`: `handle` is a string that was ALREADY in canonical form as
 *    received ("smit"), verified here.
 *  - `invalid_handle`: a handle was named but is not strictly canonical.
 *
 * Nothing else a client could send (an app user id, a Safe address, a display
 * name) is read: the recipient identity of a handle payment is derived by the
 * payment store, from the handle alone.
 */
export type PrepareRecipientSelector = { kind: "address"; value: unknown } | { kind: "handle"; handle: string } | { kind: "invalid_handle" };

/**
 * The prepare wire contract: EXACTLY ONE of `recipient` (an address) or
 * `recipientHandle`. Both present, neither present, or a body that isn't an
 * object is null (invalid_recipient) — never "pick one". A present-but-wrong-
 * typed value (null, a number) still counts as present, so it can't be used to
 * hide a second selector.
 *
 * Prepare is strict where the advisory lookup is forgiving: the handle must
 * already BE its canonical form. "@smit", "Smit", " smit ", and every other
 * spelling that merely canonicalizes to a handle are `invalid_handle` — the
 * browser is expected to send the canonical handle it got back from lookup.
 */
export function parsePrepareRecipientSelector(body: unknown): PrepareRecipientSelector | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { recipient, recipientHandle } = body as { recipient?: unknown; recipientHandle?: unknown };
  const hasAddress = recipient !== undefined;
  const hasHandle = recipientHandle !== undefined;
  if (hasAddress === hasHandle) return null;
  if (hasAddress) return { kind: "address", value: recipient };
  if (typeof recipientHandle !== "string") return { kind: "invalid_handle" };
  const canonical = canonicalizeHandle(recipientHandle);
  return canonical.ok && canonical.handle === recipientHandle ? { kind: "handle", handle: canonical.handle } : { kind: "invalid_handle" };
}
