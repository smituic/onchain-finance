/**
 * The ONE handle canonicalizer/validator, shared by the claim routes
 * (authoritative) and the claim UI (instant feedback). Must match
 * schema.sql's real_account_handles format CHECK.
 *
 * A handle is a permanent, public, human-readable name for a Real account.
 * It has NO authentication authority and never enters a Turnkey request; it
 * only ever resolves to an account's Safe.
 *
 * Canonical form: stored WITHOUT "@", lowercase ASCII, 3–20 characters of
 * a-z 0-9 _, starting with a letter, with no leading, trailing, or
 * consecutive underscores.
 *
 * ASCII look-alikes (l/1, o/0) are accepted on purpose rather than folded:
 * wherever a handle identifies a payee it is shown next to the display name.
 */
export const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 20;
export const HANDLE_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/**
 * Names no account may claim. schema.sql seeds each one as an immutable
 * `reserved` row, so the database refuses them even if this list is bypassed
 * (the two lists are kept identical by a test).
 */
export const RESERVED_HANDLES: readonly string[] = [
  "admin",
  "administrator",
  "support",
  "help",
  "security",
  "official",
  "staff",
  "team",
  "system",
  "root",
  "moderator",
  "api",
  "app",
  "null",
  "undefined",
  "anonymous",
  "me",
  "everyone",
  "onchain",
  "onchainfinance",
  "on_chain_finance",
  "cash",
  "pay",
  "save",
  "invest",
  "swap",
  "borrow",
  "explore",
  "home",
  "real",
  "practice",
  "bank",
  "turnkey",
  "safe",
  "base",
  "coinbase",
  "circle",
  "usdc",
  "pimlico",
  "wallet",
  "account",
  "settings",
  "login",
  "register",
];

const RESERVED = new Set(RESERVED_HANDLES);

export type HandleValidation = { ok: true; handle: string } | { ok: false; reason: string };

const ASCII_WHITESPACE_EDGES = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;
const NON_ASCII = /[^\x00-\x7F]/;

/**
 * Order matters and is fixed:
 *   1. trim surrounding ASCII whitespace only (space, tab, LF, CR, FF, VT) —
 *      not String.prototype.trim, which also strips Unicode spaces;
 *   2. remove at most ONE leading "@";
 *   3. reject any non-ASCII code point BEFORE any case conversion — so
 *      nothing like U+212A (Kelvin sign) or U+0130 can lowercase into ASCII;
 *   4. lowercase (ASCII only by now);
 *   5. validate the canonical form.
 * Never NFKC, never Unicode case folding.
 */
export function canonicalizeHandle(input: unknown): HandleValidation {
  if (typeof input !== "string") return { ok: false, reason: "Enter a name." };
  const trimmed = input.replace(ASCII_WHITESPACE_EDGES, "");
  const bare = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (bare.length === 0) return { ok: false, reason: "Enter a name." };
  if (NON_ASCII.test(bare)) return { ok: false, reason: "Use only letters a–z, numbers, and underscores." };
  const handle = bare.toLowerCase();
  if (!/^[a-z0-9_]+$/.test(handle)) return { ok: false, reason: "Use only letters a–z, numbers, and underscores." };
  if (handle.length < HANDLE_MIN_LENGTH) return { ok: false, reason: `Use at least ${HANDLE_MIN_LENGTH} characters.` };
  if (handle.length > HANDLE_MAX_LENGTH) return { ok: false, reason: `Use ${HANDLE_MAX_LENGTH} characters or fewer.` };
  if (!/^[a-z]/.test(handle)) return { ok: false, reason: "Start with a letter." };
  if (!HANDLE_PATTERN.test(handle)) return { ok: false, reason: "Underscores can't be first, last, or next to each other." };
  return { ok: true, handle };
}

export function isReservedHandle(handle: string): boolean {
  return RESERVED.has(handle);
}

/** How a canonical handle is shown everywhere: with its "@". */
export function formatHandle(handle: string): string {
  return `@${handle}`;
}
