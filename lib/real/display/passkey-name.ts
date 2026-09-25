import { passkeyRoleLabel, type PasskeyRole } from "@/lib/real/display/passkey-status";

/**
 * A passkey's user-chosen name is presentation metadata only — never a
 * credential's identity, never unique, never an authorization input. Shared
 * by the rename route (authoritative) and the manager UI (instant feedback).
 * Must match schema.sql's display_name CHECK.
 */
export const PASSKEY_NAME_MAX_LENGTH = 40;

export type PasskeyNameValidation = { ok: true; name: string } | { ok: false; reason: string };

export function validatePasskeyDisplayName(input: unknown): PasskeyNameValidation {
  if (typeof input !== "string") return { ok: false, reason: "A name is required." };
  const name = input.normalize("NFC").trim();
  if (name.length === 0) return { ok: false, reason: "Enter a name for this passkey." };
  if (/\p{Cc}/u.test(name)) return { ok: false, reason: "Use letters, numbers, spaces, or punctuation." };
  // Code points, matching Postgres char_length — an emoji counts once.
  if ([...name].length > PASSKEY_NAME_MAX_LENGTH) return { ok: false, reason: `Use ${PASSKEY_NAME_MAX_LENGTH} characters or fewer.` };
  return { ok: true, name };
}

/** Rows never renamed (including everything created before names existed) fall back to their role label. */
export function passkeyDisplayName(passkey: { displayName: string | null; role: PasskeyRole }): string {
  return passkey.displayName ?? passkeyRoleLabel(passkey.role);
}
