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
 * ID. raw-sign.ts's ordinary payment-signing call never passes it (today
 * there is only ever one primary credential to choose from); backup-passkey
 * enrollment/revocation (lib/real/signing/enroll-authenticator.ts) always
 * does, because those flows depend on cryptographically proving a SPECIFIC
 * credential — the existing one authorizing a new enrollment, the new one
 * proving itself during verification, or a surviving one authorizing a
 * revocation — not just "some credential this RP ID recognizes".
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
