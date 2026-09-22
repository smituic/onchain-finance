import { createHmac, timingSafeEqual } from "node:crypto";
import { bytesToBase64Url, randomBytes } from "../bytes";
import { REAL_SESSION_COOKIE_NAME } from "../constants";

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
  v: 1;
  appUserId: string;
  /** The credentialId that authenticated this session — re-checked against the registry's live status (active/revoked) on every read, not trusted from the cookie alone. */
  credentialId: string;
  /** Unix ms. Checked server-side in parseSession — never relies on the cookie's own maxAge, which a client could tamper with or a stale cookie could outlive. */
  exp: number;
  /** Random per-issuance nonce — the only reason two sessions for the same account/credential/exp-millisecond are guaranteed distinct tokens. Rotation ("always mint a new session on login") would otherwise be nominal only: without this, two logins completing within the same millisecond would serialize to byte-identical cookies. */
  sid: string;
};

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const SESSION_ID_BYTE_LENGTH = 16;

function encode(value: Buffer): string {
  return value.toString("base64url");
}

function sign(payload: string, secret: string): string {
  return encode(createHmac("sha256", secret).update(payload).digest());
}

export function createSessionPayload(input: { appUserId: string; credentialId: string; ttlMs?: number }): RealSessionPayload {
  return {
    v: 1,
    appUserId: input.appUserId,
    credentialId: input.credentialId,
    exp: Date.now() + (input.ttlMs ?? SESSION_TTL_MS),
    sid: bytesToBase64Url(randomBytes(SESSION_ID_BYTE_LENGTH)),
  };
}

export function serializeSession(payload: RealSessionPayload, secret: string): string {
  const encoded = encode(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${encoded}.${sign(encoded, secret)}`;
}

/** Verifies the HMAC and the server-checked exp before ever trusting the payload. Malformed, unsigned, tampered, or expired values all return null — callers must treat null as "no session", not distinguish why. */
export function parseSession(value: string | undefined | null, secret: string): RealSessionPayload | null {
  if (!value) return null;
  const [encoded, mac] = value.split(".");
  if (!encoded || !mac) return null;

  const expected = sign(encoded, secret);
  const actualBuf = Buffer.from(mac);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(actualBuf, expectedBuf)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (record.v !== 1) return null;
    if (typeof record.appUserId !== "string" || !record.appUserId) return null;
    if (typeof record.credentialId !== "string" || !record.credentialId) return null;
    if (typeof record.exp !== "number") return null;
    if (typeof record.sid !== "string" || !record.sid) return null;
    if (Date.now() > record.exp) return null;
    return { v: 1, appUserId: record.appUserId, credentialId: record.credentialId, exp: record.exp, sid: record.sid };
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
