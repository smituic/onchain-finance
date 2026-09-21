import { WebauthnStamper } from "@turnkey/webauthn-stamper";

export const REQUIRED_USER_VERIFICATION = "required" as const;

/**
 * A fresh stamper per call is the caller's responsibility (see
 * turnkey-client.ts) — this only builds one instance. userVerification:
 * required means the WebAuthn ceremony itself cannot complete without UV.
 */
export function createRequiredWebauthnStamper(rpId: string): WebauthnStamper {
  return new WebauthnStamper({
    rpId,
    userVerification: REQUIRED_USER_VERIFICATION,
    timeout: 300000,
  });
}

export function isWebAuthnCancellation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  return name === "NotAllowedError" || name === "AbortError";
}
