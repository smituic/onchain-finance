import { bytesToBase64Url } from "./bytes";

const BASE64URL_BODY = /^[A-Za-z0-9_-]+$/;
const BASE64_BODY = /^[A-Za-z0-9+/]+$/;

/**
 * Decodes a WebAuthn/Turnkey credential id to raw bytes, accepting base64url
 * or standard base64, with or without padding. Returns null — never a
 * best-effort guess — for anything malformed: mixed alphabets, misplaced or
 * excess padding, an impossible length, or a non-canonical encoding (spare
 * trailing bits set, which would let two different strings decode to the
 * same bytes).
 */
export function decodeCredentialId(value: unknown): Uint8Array | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const padIndex = trimmed.indexOf("=");
  const body = padIndex === -1 ? trimmed : trimmed.slice(0, padIndex);
  const padding = padIndex === -1 ? "" : trimmed.slice(padIndex);
  if (!body || !/^=*$/.test(padding) || padding.length > 2) return null;
  if (padding && (body.length + padding.length) % 4 !== 0) return null;
  if (body.length % 4 === 1) return null;

  const isUrl = BASE64URL_BODY.test(body);
  const isStd = BASE64_BODY.test(body);
  if (!isUrl && !isStd) return null;

  const normalized = isUrl ? body : body.replace(/\+/g, "-").replace(/\//g, "_");
  let bytes: Uint8Array;
  try {
    const std = normalized.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(std + "===".slice((std.length + 3) % 4));
    bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;
  if (bytesToBase64Url(bytes) !== normalized) return null;
  return bytes;
}

/** Exact byte equality of two decoded credential ids. Either side undecodable is NO MATCH — never a raw-string fallback. */
export function credentialIdsEqual(a: unknown, b: unknown): boolean {
  const left = decodeCredentialId(a);
  const right = decodeCredentialId(b);
  if (!left || !right || left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}
