import { canonicalizeHandle } from "../handle";
import type { AccountHandleStore } from "./account-handles";

/**
 * Handle -> recipient, for ADVISORY discovery only (Slice A). It decides
 * nothing about a payment: the authoritative resolution at payment time is
 * separate, later work.
 *
 * The resolved destination is ALWAYS handle -> app_user_id ->
 * real_accounts.safe_address (the Safe is the account). It is never the
 * Turnkey owner address — the store read this uses doesn't select that column.
 *
 * `appUserId` and `safeAddress` are SERVER-ONLY: the public response is built
 * by toPublicRecipientLookup, which names its fields explicitly and passes
 * neither through.
 *
 * A reserved handle, an unclaimed one, and an account that can't currently be
 * paid (the store's usability rule) are all one `not_found` — callers cannot
 * tell them apart.
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
  /** The handle is the caller's own account (compared by durable app_user_id, not by address). */
  | ({ outcome: "self" } & ResolvedHandleRecipient)
  | ({ outcome: "ok" } & ResolvedHandleRecipient);

export async function resolveHandleRecipient(input: { handles: AccountHandleStore; handle: unknown; currentAppUserId: string }): Promise<ResolveHandleRecipientResult> {
  const canonical = canonicalizeHandle(input.handle);
  if (!canonical.ok) return { outcome: "malformed", reason: canonical.reason };

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

/** The ONLY shape the lookup route returns. Explicit fields — never a spread of the resolved recipient. Not defined for `malformed` (that is a 400). */
export function toPublicRecipientLookup(result: Exclude<ResolveHandleRecipientResult, { outcome: "malformed" }>): PublicRecipientLookup {
  if (result.outcome === "not_found") return { found: false };
  return { found: true, handle: result.canonicalHandle, displayName: result.displayName, isSelf: result.outcome === "self" };
}
