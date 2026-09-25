import type { TSignedRequest, TurnkeyApiTypes } from "@turnkey/http";
import { createPasskeyTurnkeyClient } from "./turnkey-client";

/**
 * BROWSER-EXECUTED, STAMP-ONLY. Produces the exact Turnkey-stamped request
 * (TSignedRequest: body string, WebAuthn stamp header, url) for a
 * createAuthenticators / deleteAuthenticators activity, using a fresh
 * WebAuthn ceremony scoped to ONE specific existing credential. It NEVER
 * dispatches the request: the server validates it, records it durably, and
 * raw-forwards those exact bytes (lib/real/server/turnkey-signed-request.ts).
 *
 * The activity comes from the server, built from durable state; the browser
 * only refreshes timestampMs immediately before the ceremony so the stamp
 * is as fresh as possible (the server re-validates everything, including
 * freshness).
 */
export type CreateAuthenticatorsActivity = TurnkeyApiTypes["v1CreateAuthenticatorsRequest"];
export type DeleteAuthenticatorsActivity = TurnkeyApiTypes["v1DeleteAuthenticatorsRequest"];

export async function stampCreateAuthenticatorsRequest(input: { rpId: string; authorizingCredentialId: string; activity: CreateAuthenticatorsActivity }): Promise<TSignedRequest> {
  const client = createPasskeyTurnkeyClient(input.rpId, { allowCredentialId: input.authorizingCredentialId });
  return client.stampCreateAuthenticators({ ...input.activity, timestampMs: String(Date.now()) });
}

export async function stampDeleteAuthenticatorsRequest(input: { rpId: string; authorizingCredentialId: string; activity: DeleteAuthenticatorsActivity }): Promise<TSignedRequest> {
  const client = createPasskeyTurnkeyClient(input.rpId, { allowCredentialId: input.authorizingCredentialId });
  return client.stampDeleteAuthenticators({ ...input.activity, timestampMs: String(Date.now()) });
}
