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
  | "removal_submitted"
  | "removal_needs_review"
  | "removed";

/**
 * 'revoking' only ever follows a verified, dispatched removal — an app
 * session alone can't produce it. An undispatched removal leaves the passkey
 * fully active.
 */
export function passkeyDisplayState(input: { status: PasskeyStatus; removalState: RemovalAttemptState | null }): PasskeyDisplayState {
  switch (input.status) {
    case "active":
      return input.removalState === "authorization_needed" ? "removal_not_authorized" : "active";
    case "pending":
      return "setup_in_progress";
    case "revoked":
      return "removed";
    case "revoking":
      return input.removalState === "blocked" ? "removal_needs_review" : "removal_submitted";
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
