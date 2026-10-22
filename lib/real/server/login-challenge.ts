import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { randomBytes } from "../bytes";

/**
 * Milestone 3C-2 — STATELESS, SIGNED LOGIN CHALLENGES. SERVER-ONLY.
 *
 * POST /api/real/account/login/options used to write one webauthn_challenges
 * row per anonymous request (plus a cleanup DELETE): unbounded anonymous
 * database write amplification. The challenge is now a 58-byte signed,
 * expiring token that this module mints and checks WITHOUT any database access.
 * Replay protection is NOT here: it is the used-marker table
 * (login-challenge-uses.ts), written only AFTER a successful WebAuthn
 * verification. A valid MAC proves only "the server issued this, for this RP ID,
 * and it has not expired" — never that it has not been used.
 *
 * TOKEN (58 bytes; the wire form is its canonical UNPADDED base64url, exactly 78 characters):
 *   offset  0      1 byte   version = 0x01
 *   offset  1      1 byte   purpose = 0x01 (login only; no other ceremony can ever accept it)
 *   offset  2..9   8 bytes  expiration, unsigned big-endian, milliseconds since the epoch
 *   offset 10..25  16 bytes cryptographically random nonce
 *   offset 26..57  32 bytes HMAC-SHA256, never truncated
 *
 * MAC INPUT: the ASCII bytes "OCF-REAL-WEBAUTHN-LOGIN-CHALLENGE", 0x00, token
 * bytes 0..25, the RP ID's UTF-8 length as a uint16 big-endian (1..255), then the
 * RP ID's UTF-8 bytes. The domain string, the purpose byte, and the RP ID make a
 * token valid for exactly one ceremony kind and one relying party.
 *
 * KEY: HKDF-SHA256 over the UTF-8 bytes of the (validated, trimmed)
 * REAL_SESSION_SECRET, empty salt, info
 * "OCF-REAL-WEBAUTHN-LOGIN-CHALLENGE/HMAC-SHA256-KEY/v1", 32 bytes out — never
 * the raw session secret itself, so the session-cookie HMAC and this MAC are
 * independent keys. No new environment variable and no old-key fallback:
 * rotating REAL_SESSION_SECRET invalidates every outstanding login challenge
 * (as it already ends every session). Neither the secret nor the derived key is
 * ever returned, logged, or thrown inside a message.
 *
 * WEBAUTHN: @simplewebauthn/server treats a STRING challenge as UTF-8 text, so
 * the 58 token BYTES (a Uint8Array) are handed to option generation; the
 * library's own optionsJSON.challenge is then exactly canonicalBase64url(token),
 * which is also the string a browser echoes back in clientDataJSON.
 *
 * EXPIRY: the application clock check here is ADVISORY (a cheap pre-filter that
 * runs before any database access). PostgreSQL's clock is authoritative when the
 * used marker is written.
 */

export const LOGIN_CHALLENGE_VERSION = 0x01;
export const LOGIN_CHALLENGE_PURPOSE_LOGIN = 0x01;
export const LOGIN_CHALLENGE_TOKEN_BYTES = 58;
export const LOGIN_CHALLENGE_TOKEN_CHARS = 78;
export const LOGIN_CHALLENGE_NONCE_BYTES = 16;
/** A login challenge is valid for five minutes. */
export const LOGIN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** The application-side precheck tolerates this much clock difference before refusing an expiration that is too far ahead. */
export const LOGIN_CHALLENGE_CLOCK_SKEW_MS = 120 * 1000;

const MAC_DOMAIN = "OCF-REAL-WEBAUTHN-LOGIN-CHALLENGE";
const KEY_INFO = "OCF-REAL-WEBAUTHN-LOGIN-CHALLENGE/HMAC-SHA256-KEY/v1";
const HEAD_BYTES = 26; // version + purpose + expiration + nonce
const MAC_BYTES = 32;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** The RP ID bytes that enter the MAC, or null when the RP ID is not 1..255 UTF-8 bytes. */
function rpIdBytes(rpId: unknown): Buffer | null {
  if (typeof rpId !== "string") return null;
  const bytes = Buffer.from(rpId, "utf8");
  return bytes.length >= 1 && bytes.length <= 255 ? bytes : null;
}

/** HKDF-SHA256(secret) -> the 32-byte login-challenge MAC key. Throws on an empty secret. */
export function deriveLoginChallengeKey(sessionSecret: string): Buffer {
  if (typeof sessionSecret !== "string") throw new Error("Login challenge key derivation refused: no secret.");
  const ikm = Buffer.from(sessionSecret.trim(), "utf8");
  if (ikm.length === 0) throw new Error("Login challenge key derivation refused: no secret.");
  return Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), Buffer.from(KEY_INFO, "ascii"), 32));
}

/** HMAC-SHA256 over the domain-separated input described in the file comment. `head` is token bytes 0..25. */
export function computeLoginChallengeMac(key: Uint8Array, head: Uint8Array, rpId: string): Buffer {
  const rp = rpIdBytes(rpId);
  if (!rp || head.length !== HEAD_BYTES) throw new Error("Login challenge MAC refused: bad input.");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(rp.length, 0);
  return createHmac("sha256", key)
    .update(Buffer.concat([Buffer.from(MAC_DOMAIN, "ascii"), Buffer.from([0x00]), Buffer.from(head), length, rp]))
    .digest();
}

export type IssuedLoginChallenge = {
  /** The 58 token bytes — what option generation must be given (never the string). */
  tokenBytes: Uint8Array<ArrayBuffer>;
  /** canonicalBase64url(tokenBytes), 78 characters: exactly what optionsJSON.challenge must equal. */
  challenge: string;
  expiresAtMs: number;
};

/** Mints a fresh signed challenge. No database, no network, no state. `now` and `random` are test seams only. */
export function issueLoginChallenge(input: { sessionSecret: string; rpId: string; nowMs?: number; random?: (length: number) => Uint8Array }): IssuedLoginChallenge {
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Login challenge issuance refused: bad clock.");
  const nonce = (input.random ?? randomBytes)(LOGIN_CHALLENGE_NONCE_BYTES);
  if (!(nonce instanceof Uint8Array) || nonce.length !== LOGIN_CHALLENGE_NONCE_BYTES) throw new Error("Login challenge issuance refused: bad nonce.");
  const expiresAtMs = nowMs + LOGIN_CHALLENGE_TTL_MS;
  const tokenBytes = new Uint8Array(LOGIN_CHALLENGE_TOKEN_BYTES);
  tokenBytes[0] = LOGIN_CHALLENGE_VERSION;
  tokenBytes[1] = LOGIN_CHALLENGE_PURPOSE_LOGIN;
  new DataView(tokenBytes.buffer).setBigUint64(2, BigInt(expiresAtMs), false);
  tokenBytes.set(nonce, 10);
  const mac = computeLoginChallengeMac(deriveLoginChallengeKey(input.sessionSecret), tokenBytes.subarray(0, HEAD_BYTES), input.rpId);
  tokenBytes.set(mac, HEAD_BYTES);
  return { tokenBytes, challenge: Buffer.from(tokenBytes).toString("base64url"), expiresAtMs };
}

export type ParsedLoginChallenge = {
  /** The 16-byte nonce, as lowercase hex (32 characters): the used-marker key. */
  nonceHex: string;
  expiresAtMs: number;
  /** Explicit-UTC ISO timestamp of the authenticated expiration, e.g. 2026-10-19T12:34:56.789Z. */
  expiresAtIso: string;
};

/** Why a challenge was refused — for tests ONLY. Never sent to a client, never logged with the token. */
export type LoginChallengeRefusal = "not_a_string" | "bad_length" | "bad_characters" | "not_canonical" | "bad_version" | "bad_purpose" | "bad_expiration" | "bad_rp_id" | "bad_mac" | "expired" | "too_far_ahead";

export type LoginChallengeParse = ({ ok: true } & ParsedLoginChallenge) | { ok: false; reason: LoginChallengeRefusal };

/**
 * Checks a challenge string WITHOUT touching a database. In order: shape (a
 * 78-character unpadded base64url string that is the CANONICAL encoding of
 * exactly 58 bytes), version, purpose, expiration, RP ID, MAC (constant time),
 * and finally the advisory application-clock window. Malformed input fails
 * here, before any database request.
 */
export function parseLoginChallenge(value: unknown, input: { sessionSecret: string; rpId: string; nowMs?: number }): LoginChallengeParse {
  if (typeof value !== "string") return { ok: false, reason: "not_a_string" };
  if (value.length !== LOGIN_CHALLENGE_TOKEN_CHARS) return { ok: false, reason: "bad_length" };
  if (!BASE64URL.test(value)) return { ok: false, reason: "bad_characters" };
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== LOGIN_CHALLENGE_TOKEN_BYTES || bytes.toString("base64url") !== value) return { ok: false, reason: "not_canonical" };
  if (bytes[0] !== LOGIN_CHALLENGE_VERSION) return { ok: false, reason: "bad_version" };
  if (bytes[1] !== LOGIN_CHALLENGE_PURPOSE_LOGIN) return { ok: false, reason: "bad_purpose" };
  const expiration = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(2, false);
  if (expiration > MAX_SAFE) return { ok: false, reason: "bad_expiration" };
  const expiresAtMs = Number(expiration);
  if (!rpIdBytes(input.rpId)) return { ok: false, reason: "bad_rp_id" };
  let expected: Buffer;
  try {
    expected = computeLoginChallengeMac(deriveLoginChallengeKey(input.sessionSecret), bytes.subarray(0, HEAD_BYTES), input.rpId);
  } catch {
    return { ok: false, reason: "bad_mac" };
  }
  const presented = bytes.subarray(HEAD_BYTES, HEAD_BYTES + MAC_BYTES);
  if (presented.length !== MAC_BYTES || expected.length !== MAC_BYTES || !timingSafeEqual(presented, expected)) return { ok: false, reason: "bad_mac" };
  const nowMs = input.nowMs ?? Date.now();
  if (!(expiresAtMs > nowMs)) return { ok: false, reason: "expired" };
  if (expiresAtMs > nowMs + LOGIN_CHALLENGE_TTL_MS + LOGIN_CHALLENGE_CLOCK_SKEW_MS) return { ok: false, reason: "too_far_ahead" };
  return { ok: true, nonceHex: bytes.subarray(10, 26).toString("hex"), expiresAtMs, expiresAtIso: new Date(expiresAtMs).toISOString() };
}
