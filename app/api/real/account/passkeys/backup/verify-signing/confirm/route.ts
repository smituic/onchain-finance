import { disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, readJsonBody, requireRealServerConfig, retryableRateLimitedResponse } from "@/lib/real/server/http";
import { confirmSigningProof } from "@/lib/real/server/backup-passkey-pipeline";
import { TURNKEY_RECONCILE_RATE_LIMITED_MESSAGE } from "@/lib/real/server/turnkey-reconcile-budget";
import { getBackupPasskeyEnrollmentStore, getProviderBudgetLimiter, getRealAccountRegistry } from "@/lib/real/server/runtime";
import { readPasskeySession } from "@/app/api/real/account/passkeys/session";

/**
 * Proof B. Takes only the signRawPayload activity id: the server reads the
 * activity back itself (read-only) and verifies the new authenticator's
 * APPROVED vote and the signature — nothing the client claims is trusted.
 * That read is charged to the per-account Turnkey budget (3A-3); a denial is
 * a 429 with Retry-After before any read.
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
      providerBudgetLimiter: getProviderBudgetLimiter(),
    });
    if (result.outcome === "rejected") return jsonError(result.reason, 400);
    // Decided before the Turnkey read: nothing changed, so the same activity id may be sent again later.
    if (result.outcome === "rate_limited") return retryableRateLimitedResponse(TURNKEY_RECONCILE_RATE_LIMITED_MESSAGE, result.retryAfterSeconds);
    return Response.json({ active: true });
  } catch {
    return jsonInternalError();
  }
}
