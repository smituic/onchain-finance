import { CONTROL_BODY_MAX_BYTES, disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, readBoundedJsonBody, requestTooLargeResponse, requireRealServerConfig } from "@/lib/real/server/http";
import { abandonBackupEnrollment } from "@/lib/real/server/backup-passkey-pipeline";
import { getBackupPasskeyEnrollmentStore } from "@/lib/real/server/runtime";
import { readPasskeySession } from "@/app/api/real/account/passkeys/session";

/** Cancels setup — only while no Turnkey attempt is outstanding (never an uncertain one). */
export async function POST(request: Request) {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const authenticated = await readPasskeySession(config);
    if (!authenticated) return jsonError("Not authenticated.", 401);
    const bounded = await readBoundedJsonBody(request, CONTROL_BODY_MAX_BYTES);
    if (bounded.kind === "too_large") return requestTooLargeResponse();
    // An unreadable body (invalid) takes the route's existing null path and its existing 400.
    const rawBody = bounded.kind === "ok" ? bounded.value : null;
    if (rawBody === null) return jsonError("Invalid request body.", 400);
    const body = rawBody as { enrollmentId?: unknown };
    if (typeof body.enrollmentId !== "string") return jsonError("An enrollmentId is required.", 400);

    const result = await abandonBackupEnrollment({ enrollments: getBackupPasskeyEnrollmentStore(), appUserId: authenticated.account.appUserId, enrollmentId: body.enrollmentId });
    if (result.outcome === "rejected") return jsonError(result.reason, 409);
    return Response.json({ abandoned: true });
  } catch {
    return jsonInternalError();
  }
}
