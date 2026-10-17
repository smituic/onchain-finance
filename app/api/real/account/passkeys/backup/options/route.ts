import { WEBAUTHN_ASSERTION_BODY_MAX_BYTES, disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, readBoundedJsonBody, requestTooLargeResponse, requireRealServerConfig } from "@/lib/real/server/http";
import { beginBackupEnrollment } from "@/lib/real/server/backup-passkey-pipeline";
import { getAccountHandleStore, getBackupPasskeyEnrollmentStore, getChallengeStore, getRealAccountRegistry } from "@/lib/real/server/runtime";
import { readPasskeySession } from "@/app/api/real/account/passkeys/session";

/**
 * Mints (or re-mints) the backup registration challenge — only after the
 * body's `stepUp` assertion (from /backup/step-up/options) verifies as a
 * fresh, user-verified assertion by the session credential (2g-H).
 */
export async function POST(request: Request) {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const authenticated = await readPasskeySession(config);
    if (!authenticated) return jsonError("Not authenticated.", 401);
    const bounded = await readBoundedJsonBody(request, WEBAUTHN_ASSERTION_BODY_MAX_BYTES);
    if (bounded.kind === "too_large") return requestTooLargeResponse();
    // An unreadable body (invalid) takes the route's existing null path and its existing 400.
    const rawBody = bounded.kind === "ok" ? bounded.value : null;
    if (rawBody === null || typeof rawBody !== "object") return jsonError("Invalid request body.", 400);
    const result = await beginBackupEnrollment({
      config,
      challengeStore: getChallengeStore(),
      registry: getRealAccountRegistry(),
      enrollments: getBackupPasskeyEnrollmentStore(),
      // A thunk, read best-effort: the handle only labels the new passkey, so a profile-store failure never fails the setup.
      handles: getAccountHandleStore,
      appUserId: authenticated.account.appUserId,
      sessionCredentialId: authenticated.session.credentialId,
      stepUpResponse: (rawBody as { stepUp?: unknown }).stepUp,
    });
    if (result.outcome === "step_up_failed") return jsonError(result.reason, 403);
    if (result.outcome === "already_in_progress") return jsonError(result.reason, 409);
    if (result.outcome === "rejected") return jsonError(result.reason, 400);
    return Response.json({ enrollmentId: result.enrollmentId, optionsJSON: result.optionsJSON });
  } catch {
    return jsonInternalError();
  }
}
