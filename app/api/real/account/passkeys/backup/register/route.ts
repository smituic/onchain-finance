import { disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, readJsonBody, requireRealServerConfig } from "@/lib/real/server/http";
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
    const rawBody = await readJsonBody(request);
    if (rawBody === null) return jsonError("Invalid request body.", 400);
    const body = rawBody as { response?: RegistrationResponseJSON };
    if (!body.response) return jsonError("A WebAuthn registration response is required.", 400);

    const result = await completeBackupCredentialRegistration({
      config,
      challengeStore: getChallengeStore(),
      registry: getRealAccountRegistry(),
      enrollments: getBackupPasskeyEnrollmentStore(),
      appUserId: authenticated.account.appUserId,
      response: body.response,
    });
    if (result.outcome === "rejected") return jsonError(result.reason, 400);
    return Response.json({ enrollmentId: result.enrollmentId });
  } catch {
    return jsonInternalError();
  }
}
