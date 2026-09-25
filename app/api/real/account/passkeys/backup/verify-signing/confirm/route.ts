import { disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, readJsonBody, requireRealServerConfig } from "@/lib/real/server/http";
import { confirmSigningProof } from "@/lib/real/server/backup-passkey-pipeline";
import { getBackupPasskeyEnrollmentStore, getRealAccountRegistry } from "@/lib/real/server/runtime";
import { readPasskeySession } from "@/app/api/real/account/passkeys/session";

/**
 * Proof B. Takes only the signRawPayload activity id: the server reads the
 * activity back itself (read-only) and verifies the new authenticator's
 * APPROVED vote and the signature — nothing the client claims is trusted.
 */
export async function POST(request: Request) {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const authenticated = await readPasskeySession(config);
    if (!authenticated) return jsonError("Not authenticated.", 401);
    const rawBody = await readJsonBody(request);
    if (rawBody === null) return jsonError("Invalid request body.", 400);
    const body = rawBody as { enrollmentId?: unknown; activityId?: unknown };
    if (typeof body.enrollmentId !== "string") return jsonError("An enrollmentId is required.", 400);
    if (typeof body.activityId !== "string" || !body.activityId) return jsonError("An activityId is required.", 400);

    const result = await confirmSigningProof({
      config,
      registry: getRealAccountRegistry(),
      enrollments: getBackupPasskeyEnrollmentStore(),
      appUserId: authenticated.account.appUserId,
      enrollmentId: body.enrollmentId,
      activityId: body.activityId,
    });
    if (result.outcome === "rejected") return jsonError(result.reason, 400);
    return Response.json({ active: true });
  } catch {
    return jsonInternalError();
  }
}
