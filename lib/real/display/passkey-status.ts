/**
 * Presentation-only, same boundary as payment-status.ts: the registry's and
 * revocation state machine's own vocabulary never appears as primary UI
 * copy, and no Turnkey/root-user/child-org jargon appears at all.
 *
 * Truthfulness rules (Batch 2g): a passkey whose removal isn't confirmed is
 * never called "removed" — app sign-in being disabled is not the same as
 * losing Turnkey authority. Primary/backup are labels only; both have the
 * same access.
 */
export type PasskeyStatus = "pending" | "active" | "revoking" | "revoked";
export type PasskeyRole = "primary" | "backup";
export type RemovalAttemptState = "authorization_needed" | "dispatch_in_flight" | "confirmed" | "cancelled" | "blocked";

export type PasskeyDisplayState =
  | "active"
  | "removal_not_authorized"
  | "setup_in_progress"
  /** 2g-H: pending, but its wallet access was already granted — not harmless; removable. */
  | "setup_incomplete"
  /** 2g-H: pending after a create may have reached the wallet provider, outcome not confirmed — not harmless; under review. */
  | "setup_needs_review"
  | "removal_submitted"
  | "removal_needs_review"
  | "removed";

/**
 * 'revoking' only ever follows a verified, dispatched removal — an app
 * session alone can't produce it. An undispatched removal leaves the passkey
 * fully active. A pending passkey whose wallet access was already granted
 * (`walletAccess: granted`) is "setup incomplete"; one whose create may have
 * reached the wallet (`uncertain`, or no answer) is "setup needs review" — never
 * "harmless in progress".
 */
export type WalletAccess = "none" | "uncertain" | "granted";

export function passkeyDisplayState(input: { status: PasskeyStatus; removalState: RemovalAttemptState | null; walletAccess?: WalletAccess }): PasskeyDisplayState {
  switch (input.status) {
    case "active":
      return input.removalState === "authorization_needed" ? "removal_not_authorized" : "active";
    case "pending":
      // Never optimistic: an unknown/missing answer is treated as "may authorize".
      if (input.walletAccess === "granted") return "setup_incomplete";
      if (input.walletAccess === "none") return "setup_in_progress";
      return "setup_needs_review";
    case "revoked":
      return "removed";
    case "revoking":
      // Only an in-flight delete is "submitted"; a blocked one — or a retry not yet authorized — still needs review.
      return input.removalState === "dispatch_in_flight" ? "removal_submitted" : "removal_needs_review";
  }
}

export function passkeyRoleLabel(role: PasskeyRole): string {
  return role === "primary" ? "Primary passkey" : "Backup passkey";
}

export function passkeyStateLabel(state: PasskeyDisplayState): string {
  switch (state) {
    case "active":
      return "Active";
    case "removal_not_authorized":
      return "Active — removal not authorized yet";
    case "setup_in_progress":
      return "Setup in progress";
    case "setup_incomplete":
      return "Setup incomplete";
    case "setup_needs_review":
      return "Setup needs review";
    case "removal_submitted":
      return "Removal submitted — not yet confirmed";
    case "removal_needs_review":
      return "Removal needs review";
    case "removed":
      return "Removed";
  }
}

/** Shown once a removal is confirmed (both halves of the evidence) — the passkey then leaves the list. */
export const PASSKEY_REMOVED_MESSAGE = "Passkey removed.";

/** 2g-H: a pending passkey that already has wallet access. Plain language — no Turnkey/authenticator jargon. */
export const SETUP_INCOMPLETE_NOTE =
  "Setup isn't finished, but this passkey may already be able to approve payments on this account. If you can't finish setting it up on that device, remove it.";

/** 2g-H: a pending passkey whose setup may or may not have reached the wallet. */
export const SETUP_NEEDS_REVIEW_NOTE = "We couldn't confirm whether this setup went through. This passkey may already be able to approve payments on this account.";

/** 2g-H: the account-level explanation while a not-yet-finished backup is being removed. */
export const BACKUP_REMOVAL_PENDING_NOTE = "A backup passkey that wasn't finished is being removed. You can add another one once the removal is confirmed.";

/** Shown for every state where app sign-in is off but Turnkey removal isn't confirmed. */
export const MAY_STILL_AUTHORIZE_NOTE = "This passkey may still be able to authorize this account until removal is confirmed.";

export function mayStillAuthorize(state: PasskeyDisplayState): boolean {
  return state === "removal_submitted" || state === "removal_needs_review";
}

/** The one truthful sentence about what a backup passkey does — never "you can never lose access", "protects you if both are lost", "prevents theft", or "guaranteed recovery". */
export const BACKUP_PASSKEY_EXPLANATION =
  "A backup passkey gives you another way to access and authorize this account if one credential becomes unavailable.";

export const EQUAL_AUTHORITY_NOTE = "Primary and backup passkeys have the same access to this account.";

export const TOTAL_LOSS_NOTE = "If every passkey on this account is lost, the account can't currently be recovered.";
