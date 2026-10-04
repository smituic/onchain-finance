import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import { formatHandle } from "@/lib/real/handle";

/**
 * Thin wrapper over @simplewebauthn/browser, kept instead of hand-rolling
 * navigator.credentials.create/get()'s ArrayBuffer<->base64url conversion:
 * startRegistration/startAuthentication produce exactly the
 * RegistrationResponseJSON/AuthenticationResponseJSON shapes
 * @simplewebauthn/server's verify functions expect, so the wire format
 * between browser and server is never hand-serialized on either side.
 */
export async function performRegistrationCeremony(
  optionsJSON: PublicKeyCredentialCreationOptionsJSON,
): Promise<RegistrationResponseJSON> {
  return startRegistration({ optionsJSON });
}

export async function performLoginCeremony(
  optionsJSON: PublicKeyCredentialRequestOptionsJSON,
): Promise<AuthenticationResponseJSON> {
  return startAuthentication({ optionsJSON });
}

export function isWebAuthnCancellation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String((error as { name: unknown }).name) : "";
  return name === "NotAllowedError" || name === "AbortError";
}

type SignalCurrentUserDetails = (details: { rpId: string; userId: string; name: string; displayName: string }) => Promise<void>;

/**
 * Best-effort relabel of ONE passkey in the user's passkey manager, so it
 * shows "@handle" instead of the placeholder it was created with. Uses only
 * PublicKeyCredential.signalCurrentUserDetails — never the signals that can
 * hide or remove a passkey (signalUnknownCredential,
 * signalAllAcceptedCredentials).
 *
 * `userHandle` must be the WebAuthn user.id of the credential the server JUST
 * verified (the assertion's own userHandle): user.id is per credential in
 * this app, so each passkey is relabelled only when it is itself used, on a
 * browser/provider that supports the signal.
 *
 * Presentation only, and it can never affect an outcome: feature-detected,
 * not awaited, every failure (sync or async) swallowed, no return value. An
 * unsupported browser, a missing value, or an account without a handle does
 * nothing at all.
 */
export function signalAccountLabel(input: { rpId?: string | null; userHandle?: string | null; handle?: string | null; displayName?: string | null }): void {
  try {
    if (!input.rpId || !input.userHandle || !input.handle) return;
    if (typeof PublicKeyCredential === "undefined") return;
    const signal = (PublicKeyCredential as unknown as { signalCurrentUserDetails?: SignalCurrentUserDetails }).signalCurrentUserDetails;
    if (typeof signal !== "function") return;
    const name = formatHandle(input.handle);
    void Promise.resolve(signal.call(PublicKeyCredential, { rpId: input.rpId, userId: input.userHandle, name, displayName: input.displayName || name })).catch(() => {});
  } catch {
    // Never surfaced: the label is cosmetic.
  }
}
