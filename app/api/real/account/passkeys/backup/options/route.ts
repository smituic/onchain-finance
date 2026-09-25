import { disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, requireRealServerConfig } from "@/lib/real/server/http";
import { beginBackupEnrollment } from "@/lib/real/server/backup-passkey-pipeline";
import { getBackupPasskeyEnrollmentStore, getChallengeStore, getRealAccountRegistry } from "@/lib/real/server/runtime";
import { readPasskeySession } from "@/app/api/real/account/passkeys/session";

export async function POST() {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const authenticated = await readPasskeySession(config);
    if (!authenticated) return jsonError("Not authenticated.", 401);
    const result = await beginBackupEnrollment({
      config,
      challengeStore: getChallengeStore(),
      registry: getRealAccountRegistry(),
      enrollments: getBackupPasskeyEnrollmentStore(),
      appUserId: authenticated.account.appUserId,
    });
    if (result.outcome === "already_in_progress") return jsonError(result.reason, 409);
    if (result.outcome === "rejected") return jsonError(result.reason, 400);
    return Response.json({ enrollmentId: result.enrollmentId, optionsJSON: result.optionsJSON });
  } catch {
    return jsonInternalError();
  }
}
