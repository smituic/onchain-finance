import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "../constants";
import { normalizeTurnkeyId, validateAddressCasePreserving } from "../identifiers";
import type { PublicAuthenticator } from "../public-state";

export type PocSession = {
  v: 1;
  appUserId: string;
  subOrganizationId: string;
  userId: string;
  walletId: string;
  ownerAddress: string;
  authenticators: PublicAuthenticator[];
};

function encode(value: Buffer): string {
  return value.toString("base64url");
}

function sign(payload: string, secret: string): string {
  return encode(createHmac("sha256", secret).update(payload).digest());
}

export function serializeSession(session: PocSession, secret: string): string {
  const payload = encode(Buffer.from(JSON.stringify(session), "utf8"));
  return `${payload}.${sign(payload, secret)}`;
}

export function parseSession(value: string | undefined | null, secret: string): PocSession | null {
  if (!value) return null;
  const [payload, mac] = value.split(".");
  if (!payload || !mac) return null;
  const expected = sign(payload, secret);
  const actualBuf = Buffer.from(mac);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(actualBuf, expectedBuf)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (record.v !== 1) return null;
    const subOrganizationId = normalizeTurnkeyId(asString(record.subOrganizationId));
    const userId = normalizeTurnkeyId(asString(record.userId));
    const walletId = normalizeTurnkeyId(asString(record.walletId));
    // Turnkey's wallet resource lookup is case-sensitive — preserve exact casing.
    const ownerAddress = validateAddressCasePreserving(asString(record.ownerAddress));
    const appUserId = asString(record.appUserId);
    if (!subOrganizationId || !userId || !walletId || !ownerAddress || !appUserId) return null;
    return {
      v: 1,
      appUserId,
      subOrganizationId,
      userId,
      walletId,
      ownerAddress,
      authenticators: Array.isArray(record.authenticators)
        ? (record.authenticators as PublicAuthenticator[])
        : [],
    };
  } catch {
    return null;
  }
}

export function createSessionId(): string {
  return randomUUID();
}

export async function readPocSession(secret: string): Promise<PocSession | null> {
  const store = await cookies();
  return parseSession(store.get(SESSION_COOKIE_NAME)?.value, secret);
}

export async function writePocSession(session: PocSession, secret: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, serializeSession(session, secret), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function clearPocSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE_NAME);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
