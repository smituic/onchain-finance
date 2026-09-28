import { WebauthnStamper } from "@turnkey/webauthn-stamper";
import { base64UrlToBytes } from "../bytes";

export const REQUIRED_USER_VERIFICATION = "required" as const;

/**
 * A fresh stamper per call is the caller's responsibility (see
 * turnkey-client.ts) — this only builds one instance. userVerification:
 * required means the WebAuthn ceremony itself cannot complete without UV.
 *
 * `allowCredentialId` (a base64url WebAuthn credential id, decoded to raw
 * bytes here — the DOM's PublicKeyCredentialDescriptor.id is a
 * BufferSource, never a string), when given, is forwarded to
 * WebauthnStamper's own `allowCredentials` — it scopes the browser's
 * credential picker to that ONE credential rather than letting the
 * platform authenticator offer whichever synced passkey it has for this RP
 * ID. Every caller that depends on proving a SPECIFIC credential passes it:
 * backup-passkey enrollment/revocation (the existing one authorizing a new
 * enrollment, the new one proving itself, a surviving one authorizing a
 * revocation) and, since Slice S1, every Real Pay signature (the payment's
 * server-bound credential) — never just "some credential this RP ID
 * recognizes". The server still proves the credential from Turnkey's own
 * record; this only keeps the prompt from offering any other passkey.
 */
export function createRequiredWebauthnStamper(rpId: string, options?: { allowCredentialId?: string }): WebauthnStamper {
  return new WebauthnStamper({
    rpId,
    userVerification: REQUIRED_USER_VERIFICATION,
    timeout: 300000,
    ...(options?.allowCredentialId ? { allowCredentials: [{ id: base64UrlToBytes(options.allowCredentialId), type: "public-key" }] } : {}),
  });
}

export function isWebAuthnCancellation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  return name === "NotAllowedError" || name === "AbortError";
}
