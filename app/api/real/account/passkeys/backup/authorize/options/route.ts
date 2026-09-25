import { disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, readJsonBody, requireRealServerConfig } from "@/lib/real/server/http";
import { prepareTurnkeyAuthorization } from "@/lib/real/server/backup-passkey-pipeline";
import { getBackupPasskeyEnrollmentStore, getRealAccountRegistry } from "@/lib/real/server/runtime";
import { readPasskeySession } from "@/app/api/real/account/passkeys/session";

/** Returns the exact activity for the browser to STAMP (never dispatch), and the session credential that must stamp it. */
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

    const result = await prepareTurnkeyAuthorization({
      config,
      registry: getRealAccountRegistry(),
      enrollments: getBackupPasskeyEnrollmentStore(),
      appUserId: authenticated.account.appUserId,
      enrollmentId: body.enrollmentId,
      sessionCredentialId: authenticated.session.credentialId,
    });
    if (result.outcome === "rejected") return jsonError(result.reason, 400);
    return Response.json({ activity: result.activity, rpId: result.rpId, authorizingCredentialId: result.authorizingCredentialId });
  } catch {
    return jsonInternalError();
  }
}
