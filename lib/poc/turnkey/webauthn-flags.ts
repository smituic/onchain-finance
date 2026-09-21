/** WebAuthn authenticator data: 32-byte rpIdHash, then flags. UV is bit 2. */
const UV_FLAG = 0x04;
const UP_FLAG = 0x01;

export function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  if (typeof atob === "function") {
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }
  return Uint8Array.from(Buffer.from(padded, "base64"));
}

export function parseWebAuthnFlags(authenticatorDataBase64Url: string): {
  userPresent: boolean;
  userVerified: boolean;
} | null {
  try {
    const bytes = decodeBase64Url(authenticatorDataBase64Url);
    if (bytes.length < 33) return null;
    const flags = bytes[32] ?? 0;
    return {
      userPresent: (flags & UP_FLAG) === UP_FLAG,
      userVerified: (flags & UV_FLAG) === UV_FLAG,
    };
  } catch {
    return null;
  }
}

export const TURNKEY_UV_SERVER_FINDING =
  "Turnkey verifies the WebAuthn assertion against the registered credential and that clientData.challenge equals SHA-256(JSON body) as a hex string. Public docs do not state that the enclave independently rejects UV=0 if the browser produced an assertion. This PoC still requests userVerification: required so the ceremony itself should not complete without UV.";
