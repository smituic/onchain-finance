import type { NextRequest } from "next/server";
import { CONTROL_BODY_MAX_BYTES, disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, readBoundedJsonBody, requestTooLargeResponse, requireRealServerConfig } from "@/lib/real/server/http";
import { reconcileRevocation } from "@/lib/real/server/passkey-revocation";
import { getPasskeyRevocationStore, getProviderBudgetLimiter, getRealAccountRegistry } from "@/lib/real/server/runtime";
import { readPasskeySession } from "@/app/api/real/account/passkeys/session";

/**
 * Returns 200 with an explicit { outcome, reason } for every legitimate
 * state (revoked / pending / authorization_needed / cancelled / blocked) — the client
 * branches on `outcome`. Only a refused request ("rejected") is non-2xx.
 *
 * A reconcile the per-account Turnkey budget refused (3A-3) is ALSO a 200: the
 * plain "pending" state plus `reconciliationDeferred: true` and
 * `retryAfterSeconds`. Nothing was read or changed, so the target stays
 * revoking and no finality is implied; an ordinary answer carries neither
 * field. A limiter failure is the generic 500 with no Turnkey call.
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/real/account/passkeys/[credentialId]/revoke/reconcile">) {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const authenticated = await readPasskeySession(config);
    if (!authenticated) return jsonError("Not authenticated.", 401);
    const { credentialId } = await ctx.params;
    const bounded = await readBoundedJsonBody(request, CONTROL_BODY_MAX_BYTES);
    if (bounded.kind === "too_large") return requestTooLargeResponse();
    // An unreadable body (invalid) takes the route's existing null path and its existing 400.
    const rawBody = bounded.kind === "ok" ? bounded.value : null;
    if (rawBody === null) return jsonError("Invalid request body.", 400);
    const body = rawBody as { attemptId?: unknown };
    if (typeof body.attemptId !== "string") return jsonError("An attemptId is required.", 400);

    const result = await reconcileRevocation({
      config,
      registry: getRealAccountRegistry(),
      revocations: getPasskeyRevocationStore(),
      appUserId: authenticated.account.appUserId,
      credentialId,
      attemptId: body.attemptId,
      providerBudgetLimiter: getProviderBudgetLimiter(),
    });
    if (result.outcome === "rejected") return jsonError(result.reason, 400);
    return Response.json(result);
  } catch {
    return jsonInternalError();
  }
}
