import { formatHandle } from "@/lib/real/handle";

/**
 * An ACCOUNT's display name (real_accounts.display_name) — not a passkey's
 * name (real_passkeys.display_name, see passkey-name.ts). Presentation
 * metadata only: mutable, not unique, never an authentication or lookup
 * input. Shared by the profile route (authoritative) and the UI.
 *
 * The database only guards length (schema.sql); the Unicode rules below are
 * this validator's job: trimmed, NFC, at most 40 code points, no control (Cc)
 * or format (Cf) characters, no line/paragraph separators, and never starting
 * with "@". No profanity or moderation logic.
 */
export const ACCOUNT_DISPLAY_NAME_MAX_LENGTH = 40;

/** `name: null` means "no display name" (empty or whitespace-only input clears it). */
export type AccountDisplayNameValidation = { ok: true; name: string | null } | { ok: false; reason: string };

/** Bidirectional controls: ALM, LRM/RLM, the embedding/override set, and the isolate set. They can reorder how a name renders next to a handle. */
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
/**
 * Every Unicode FORMAT character (category Cf): zero-width space/joiners, word
 * joiner, soft hyphen, the byte-order mark, the bidi controls above, tag
 * characters. Invisible, so two names that render identically could differ.
 * (This also refuses emoji joined with U+200D and scripts that use the
 * zero-width non-joiner — accepted for now, in favor of unambiguous names.)
 */
const FORMAT_CHARACTERS = /\p{Cf}/u;
/** Unicode line and paragraph separators (category Zl / Zp). */
const LINE_SEPARATORS = /[\u2028\u2029]/u;

export function validateAccountDisplayName(input: unknown): AccountDisplayNameValidation {
  if (input === null || input === undefined) return { ok: true, name: null };
  if (typeof input !== "string") return { ok: false, reason: "Enter a name." };
  const name = input.trim().normalize("NFC");
  if (name.length === 0) return { ok: true, name: null };
  if (/\p{Cc}/u.test(name) || FORMAT_CHARACTERS.test(name) || BIDI_CONTROLS.test(name) || LINE_SEPARATORS.test(name)) {
    return { ok: false, reason: "Use letters, numbers, spaces, or punctuation." };
  }
  // A display name must never read as a handle ("@support"). An @ elsewhere is fine.
  if (name.startsWith("@")) return { ok: false, reason: "A name can't start with @." };
  // Code points, matching Postgres char_length — an emoji counts once.
  if ([...name].length > ACCOUNT_DISPLAY_NAME_MAX_LENGTH) return { ok: false, reason: `Use ${ACCOUNT_DISPLAY_NAME_MAX_LENGTH} characters or fewer.` };
  return { ok: true, name };
}

/** The account's heading: its display name, else its @handle, else nothing chosen yet. */
export function accountTitle(profile: { handle: string | null; displayName: string | null }): string | null {
  return profile.displayName ?? (profile.handle ? formatHandle(profile.handle) : null);
}
