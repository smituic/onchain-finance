import { disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, readJsonBody, requireRealServerConfig } from "@/lib/real/server/http";
import { prepareBackupLoginVerification } from "@/lib/real/server/backup-passkey-pipeline";
import { getBackupPasskeyEnrollmentStore, getChallengeStore } from "@/lib/real/server/runtime";
import { readPasskeySession } from "@/app/api/real/account/passkeys/session";

export async function POST(request: Request) {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const authenticated = await readPasskeySession(config);
    if (!authenticated) return jsonError("Not authenticated.", 401);
    const rawBody = await readJsonBody(request);
    if (rawBody === null) return jsonError("Invalid request body.", 400);
    const body = rawBody as { enrollmentId?: unknown };
    if (typeof body.enrollmentId !== "string") return jsonError("An enrollmentId is required.", 400);

    const result = await prepareBackupLoginVerification({
      config,
      challengeStore: getChallengeStore(),
      enrollments: getBackupPasskeyEnrollmentStore(),
      appUserId: authenticated.account.appUserId,
      enrollmentId: body.enrollmentId,
    });
    if (result.outcome === "rejected") return jsonError(result.reason, 400);
    return Response.json({ optionsJSON: result.optionsJSON });
  } catch {
    return jsonInternalError();
  }
}
