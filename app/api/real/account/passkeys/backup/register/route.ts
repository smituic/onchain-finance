import { WEBAUTHN_REGISTRATION_BODY_MAX_BYTES, disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, readBoundedJsonBody, requestTooLargeResponse, requireRealServerConfig } from "@/lib/real/server/http";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { completeBackupCredentialRegistration } from "@/lib/real/server/backup-passkey-pipeline";
import { getBackupPasskeyEnrollmentStore, getChallengeStore, getRealAccountRegistry } from "@/lib/real/server/runtime";
import { readPasskeySession } from "@/app/api/real/account/passkeys/session";

export async function POST(request: Request) {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const authenticated = await readPasskeySession(config);
    if (!authenticated) return jsonError("Not authenticated.", 401);
    const bounded = await readBoundedJsonBody(request, WEBAUTHN_REGISTRATION_BODY_MAX_BYTES);
    if (bounded.kind === "too_large") return requestTooLargeResponse();
    // An unreadable body (invalid) takes the route's existing null path and its existing 400.
    const rawBody = bounded.kind === "ok" ? bounded.value : null;
    if (rawBody === null) return jsonError("Invalid request body.", 400);
    const body = rawBody as { response?: RegistrationResponseJSON };
    if (!body.response) return jsonError("A WebAuthn registration response is required.", 400);

    const result = await completeBackupCredentialRegistration({
      config,
      challengeStore: getChallengeStore(),
      registry: getRealAccountRegistry(),
      enrollments: getBackupPasskeyEnrollmentStore(),
      appUserId: authenticated.account.appUserId,
      sessionCredentialId: authenticated.session.credentialId,
      response: body.response,
    });
    if (result.outcome === "rejected") return jsonError(result.reason, 400);
    return Response.json({ enrollmentId: result.enrollmentId });
  } catch {
    return jsonInternalError();
  }
}
