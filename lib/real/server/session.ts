import { createHmac, timingSafeEqual } from "node:crypto";
import { bytesToBase64Url, randomBytes } from "../bytes";
import { REAL_SESSION_COOKIE_NAME } from "../constants";

/**
 * Bumped from 1 to 2 by S4 (session epoch). A v1 token carries no epoch, so
 * it can never be checked against account-wide sign-out — parseSession
 * rejects it outright rather than guessing one. Every pre-S4 session
 * therefore signs in again once.
 */
export const REAL_SESSION_VERSION = 2;

/**
 * APP AUTHENTICATION scope only. This payload identifies which registry
 * account/credential the browser has an app session for — it never
 * contains anything Turnkey-related (no subOrganizationId, no walletId, no
 * ownerAddress) and it grants no signing capability. Every payment still
 * requires its own fresh Turnkey WebAuthn ceremony (see
 * signing/verified-account.ts); possessing a valid cookie only unlocks
 * "look up my own public account state" and "attempt a new payment
 * ceremony", never a signature itself.
 */
export type RealSessionPayload = {
  v: typeof REAL_SESSION_VERSION;
  appUserId: string;
  /** The credentialId that authenticated this session — re-checked against the registry's live status (active/revoked) on every read, not trusted from the cookie alone. */
  credentialId: string;
  /** Unix ms. Checked server-side in parseSession — never relies on the cookie's own maxAge, which a client could tamper with or a stale cookie could outlive. */
  exp: number;
  /** Random per-issuance nonce — the only reason two sessions for the same account/credential/exp-millisecond are guaranteed distinct tokens. Rotation ("always mint a new session on login") would otherwise be nominal only: without this, two logins completing within the same millisecond would serialize to byte-identical cookies. */
  sid: string;
  /** real_accounts.session_epoch when this session was minted. auth.ts requires it to EQUAL the account's current epoch; "Sign out everywhere" increments the account's epoch, invalidating every session issued before it at once. */
  sessionEpoch: number;
};

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const SESSION_ID_BYTE_LENGTH = 16;

/** Exactly `<base64url payload>.<base64url HMAC-SHA256>` — a SHA-256 MAC is always 43 unpadded base64url characters. Anything else (extra segments, padding, stray characters) is rejected before the MAC is even computed. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;

/**
 * REAL_SESSION_SECRET format policy. The secret must be an ENCODING of at
 * least 32 random bytes — hex, or base64/base64url — and it must decode
 * cleanly. There is no raw-text/passphrase fallback: a string's length says
 * nothing about its randomness. (The HMAC key itself is still the secret's
 * UTF-8 bytes, verbatim; this only decides which values are acceptable.)
 */
export const MIN_SESSION_SECRET_BYTES = 32;

const HEX_PATTERN = /^[0-9a-fA-F]+$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * Decodes a secret in one of the accepted encodings, or returns null.
 *
 *  - A string made only of hex digits is ALWAYS judged as hex (even length
 *    required) — never re-read as base64, which would let e.g. 63 hex
 *    characters slip through as "47 bytes of base64".
 *  - Otherwise it must be valid base64 or base64url (one alphabet, never
 *    mixed; padding optional but, if present, correct), AND canonical:
 *    re-encoding the decoded bytes must reproduce the input exactly. That
 *    rejects impossible lengths and non-zero trailing bits, which Node's
 *    lenient decoder would otherwise silently accept or drop.
 */
export function decodeSessionSecret(secret: string): Buffer | null {
  if (HEX_PATTERN.test(secret)) return secret.length % 2 === 0 ? Buffer.from(secret, "hex") : null;

  const encoding = BASE64_PATTERN.test(secret) ? "base64" : BASE64URL_PATTERN.test(secret) ? "base64url" : null;
  if (!encoding) return null;
  const unpadded = secret.replace(/=+$/, "");
  if (unpadded.length !== secret.length && secret.length % 4 !== 0) return null;
  if (unpadded.length % 4 === 1) return null;
  const decoded = Buffer.from(unpadded, encoding);
  if (decoded.toString(encoding).replace(/=+$/, "") !== unpadded) return null;
  return decoded;
}

export function isStrongSessionSecret(secret: string): boolean {
  const decoded = decodeSessionSecret(secret);
  return decoded !== null && decoded.length >= MIN_SESSION_SECRET_BYTES;
}

function encode(value: Buffer): string {
  return value.toString("base64url");
}

function sign(payload: string, secret: string): string {
  return encode(createHmac("sha256", secret).update(payload).digest());
}

function isSessionEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function createSessionPayload(input: { appUserId: string; credentialId: string; sessionEpoch: number; ttlMs?: number }): RealSessionPayload {
  if (!isSessionEpoch(input.sessionEpoch)) throw new Error("A session can only be minted at a valid account session epoch.");
  return {
    v: REAL_SESSION_VERSION,
    appUserId: input.appUserId,
    credentialId: input.credentialId,
    exp: Date.now() + (input.ttlMs ?? SESSION_TTL_MS),
    sid: bytesToBase64Url(randomBytes(SESSION_ID_BYTE_LENGTH)),
    sessionEpoch: input.sessionEpoch,
  };
}

export function serializeSession(payload: RealSessionPayload, secret: string): string {
  const encoded = encode(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${encoded}.${sign(encoded, secret)}`;
}

/** Verifies the token shape, the HMAC, the version, and the server-checked exp before ever trusting the payload. Malformed, unsigned, tampered, legacy-version, or expired values all return null — callers must treat null as "no session", not distinguish why. The epoch is only shape-checked here; auth.ts compares it to the account's current epoch. */
export function parseSession(value: string | undefined | null, secret: string): RealSessionPayload | null {
  if (!value || !TOKEN_PATTERN.test(value)) return null;
  const [encoded, mac] = value.split(".") as [string, string];

  const expected = sign(encoded, secret);
  const actualBuf = Buffer.from(mac);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(actualBuf, expectedBuf)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (record.v !== REAL_SESSION_VERSION) return null;
    if (typeof record.appUserId !== "string" || !record.appUserId) return null;
    if (typeof record.credentialId !== "string" || !record.credentialId) return null;
    if (typeof record.exp !== "number") return null;
    if (typeof record.sid !== "string" || !record.sid) return null;
    if (!isSessionEpoch(record.sessionEpoch)) return null;
    if (Date.now() > record.exp) return null;
    return {
      v: REAL_SESSION_VERSION,
      appUserId: record.appUserId,
      credentialId: record.credentialId,
      exp: record.exp,
      sid: record.sid,
      sessionEpoch: record.sessionEpoch,
    };
  } catch {
    return null;
  }
}

/** Cookie attributes shared by every route that sets/clears the session — next/headers itself stays out of lib/real/** (framework-agnostic fence), so route handlers spread these into their own cookies().set() calls. */
export function realSessionCookieOptions(): {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

export { REAL_SESSION_COOKIE_NAME };
