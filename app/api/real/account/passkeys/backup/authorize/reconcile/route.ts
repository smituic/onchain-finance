import { CONTROL_BODY_MAX_BYTES, disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, readBoundedJsonBody, requestTooLargeResponse, requireRealServerConfig } from "@/lib/real/server/http";
import { reconcileTurnkeyEnrollment } from "@/lib/real/server/backup-passkey-pipeline";
import { getBackupPasskeyEnrollmentStore, getProviderBudgetLimiter, getRealAccountRegistry } from "@/lib/real/server/runtime";
import { readPasskeySession } from "@/app/api/real/account/passkeys/session";

/**
 * Returns 200 with an explicit { outcome, reason } for every legitimate
 * state (confirmed / pending / blocked) — the client
 * branches on `outcome`. Only a refused request ("rejected") is non-2xx.
 *
 * A reconcile the per-account Turnkey budget refused (3A-3) is ALSO a 200: the
 * stored state ("pending", or "blocked" with its reason) plus
 * `reconciliationDeferred: true` and `retryAfterSeconds`. Nothing was read or
 * changed, so it implies no finality; an ordinary answer carries neither field.
 * A limiter failure is the generic 500 with no Turnkey call.
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
    const body = rawBody as { enrollmentId?: unknown };
    if (typeof body.enrollmentId !== "string") return jsonError("An enrollmentId is required.", 400);

    const result = await reconcileTurnkeyEnrollment({
      config,
      registry: getRealAccountRegistry(),
      enrollments: getBackupPasskeyEnrollmentStore(),
      appUserId: authenticated.account.appUserId,
      enrollmentId: body.enrollmentId,
      providerBudgetLimiter: getProviderBudgetLimiter(),
    });
    if (result.outcome === "rejected") return jsonError(result.reason, 400);
    return Response.json(result);
  } catch {
    return jsonInternalError();
  }
}
