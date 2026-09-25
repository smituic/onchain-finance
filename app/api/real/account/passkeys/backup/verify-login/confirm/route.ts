import { disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, readJsonBody, requireRealServerConfig } from "@/lib/real/server/http";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { confirmBackupLoginVerification } from "@/lib/real/server/backup-passkey-pipeline";
import { getBackupPasskeyEnrollmentStore, getChallengeStore, getRealAccountRegistry } from "@/lib/real/server/runtime";
import { readPasskeySession } from "@/app/api/real/account/passkeys/session";

/** Proof A. Evidence for the enrollment only — deliberately never sets a session cookie. */
export async function POST(request: Request) {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const authenticated = await readPasskeySession(config);
    if (!authenticated) return jsonError("Not authenticated.", 401);
    const rawBody = await readJsonBody(request);
    if (rawBody === null) return jsonError("Invalid request body.", 400);
    const body = rawBody as { response?: AuthenticationResponseJSON };
    if (!body.response) return jsonError("A WebAuthn sign-in response is required.", 400);

    const result = await confirmBackupLoginVerification({
      config,
      challengeStore: getChallengeStore(),
      registry: getRealAccountRegistry(),
      enrollments: getBackupPasskeyEnrollmentStore(),
      appUserId: authenticated.account.appUserId,
      response: body.response,
    });
    if (result.outcome === "rejected") return jsonError(result.reason, 400);
    return Response.json({ verified: true });
  } catch {
    return jsonInternalError();
  }
}
