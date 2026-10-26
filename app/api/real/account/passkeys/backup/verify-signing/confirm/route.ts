import { CONTROL_BODY_MAX_BYTES, disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, readBoundedJsonBody, requestTooLargeResponse, requireRealServerConfig, retryableRateLimitedResponse } from "@/lib/real/server/http";
import { confirmSigningProof } from "@/lib/real/server/backup-passkey-pipeline";
import { TURNKEY_RECONCILE_RATE_LIMITED_MESSAGE } from "@/lib/real/server/turnkey-reconcile-budget";
import { getBackupPasskeyEnrollmentStore, getProviderBudgetLimiter, getRealAccountRegistry } from "@/lib/real/server/runtime";
import { readPasskeySession } from "@/app/api/real/account/passkeys/session";

const SIGNING_CONFIRMATION_UNAVAILABLE_MESSAGE = "We couldn't check your approval just now. Try again in a moment.";

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
    const bounded = await readBoundedJsonBody(request, CONTROL_BODY_MAX_BYTES);
    if (bounded.kind === "too_large") return requestTooLargeResponse();
    // An unreadable body (invalid) takes the route's existing null path and its existing 400.
    const rawBody = bounded.kind === "ok" ? bounded.value : null;
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
    // M3D-2: the activity could not be read (no usable evidence). Nothing changed; the client keeps its proof and may confirm again.
    // Deliberately no `code` and no Retry-After: a 503 is not a rate limit, and the client must not count it as a rejection.
    if (result.outcome === "unavailable") return Response.json({ error: SIGNING_CONFIRMATION_UNAVAILABLE_MESSAGE, retryable: true }, { status: 503 });
    return Response.json({ active: true });
  } catch {
    return jsonInternalError();
  }
}
