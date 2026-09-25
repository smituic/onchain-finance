import { disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, readJsonBody, requireRealServerConfig } from "@/lib/real/server/http";
import { submitTurnkeyAuthorization } from "@/lib/real/server/backup-passkey-pipeline";
import { getBackupPasskeyEnrollmentStore, getRealAccountRegistry } from "@/lib/real/server/runtime";
import { readPasskeySession } from "@/app/api/real/account/passkeys/session";

/**
 * Returns 200 with an explicit { outcome, reason } for every legitimate
 * state (confirmed / pending / failed_retryable / blocked) — the client
 * branches on `outcome`. Only a refused request ("rejected") is non-2xx.
*
 * Accepts the browser's child-stamped createAuthenticators request. The
 * server validates it, records it durably as in-flight, and only then
 * raw-forwards the exact bytes to Turnkey — see submitTurnkeyAuthorization.
 */
export async function POST(request: Request) {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const authenticated = await readPasskeySession(config);
    if (!authenticated) return jsonError("Not authenticated.", 401);
    const rawBody = await readJsonBody(request);
    if (rawBody === null) return jsonError("Invalid request body.", 400);
    const body = rawBody as { enrollmentId?: unknown; signedRequest?: unknown };
    if (typeof body.enrollmentId !== "string") return jsonError("An enrollmentId is required.", 400);

    const result = await submitTurnkeyAuthorization({
      config,
      registry: getRealAccountRegistry(),
      enrollments: getBackupPasskeyEnrollmentStore(),
      appUserId: authenticated.account.appUserId,
      enrollmentId: body.enrollmentId,
      sessionCredentialId: authenticated.session.credentialId,
      signedRequest: body.signedRequest,
    });
    if (result.outcome === "rejected") return jsonError(result.reason, 400);
    return Response.json(result);
  } catch {
    return jsonInternalError();
  }
}
