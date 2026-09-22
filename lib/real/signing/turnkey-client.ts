import { TurnkeyClient } from "@turnkey/http";
import { TURNKEY_API_BASE_URL } from "../constants";
import { createRequiredWebauthnStamper } from "./passkey";

/**
 * A fresh WebauthnStamper + TurnkeyClient, constructed new for every call
 * site that needs one (see raw-sign.ts) — never held across calls, never
 * persisted. There is no Turnkey session/login credential anywhere in this
 * module; every signing request re-authorizes via WebAuthn from scratch.
 */
export function createPasskeyTurnkeyClient(rpId: string): TurnkeyClient {
  return new TurnkeyClient({ baseUrl: TURNKEY_API_BASE_URL }, createRequiredWebauthnStamper(rpId));
}
