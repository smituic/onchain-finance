import { WEBAUTHN_ASSERTION_BODY_MAX_BYTES, disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, readBoundedJsonBody, requestTooLargeResponse, requireRealServerConfig } from "@/lib/real/server/http";
import { completeHandleClaim } from "@/lib/real/server/handle-claim";
import { getAccountHandleStore, getChallengeStore, getRealAccountRegistry } from "@/lib/real/server/runtime";
import { readPasskeySession } from "@/app/api/real/account/passkeys/session";

/**
 * Step 2: verifies the fresh assertion by the session credential over the
 * challenge /handle/options minted for exactly this name, then claims it.
 * Permanent — there is no route that changes or releases a handle.
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
    const body = rawBody as { handle?: unknown; response?: unknown };
    const result = await completeHandleClaim({
      config,
      challengeStore: getChallengeStore(),
      registry: getRealAccountRegistry(),
      handles: getAccountHandleStore(),
      appUserId: authenticated.account.appUserId,
      sessionCredentialId: authenticated.session.credentialId,
      handle: body.handle,
      response: body.response,
    });
    if (result.outcome === "rejected") return jsonError(result.reason, 403);
    if (result.outcome === "unavailable") return jsonError(result.reason, 409);
    if (result.outcome === "already_has_handle") return Response.json({ error: result.reason, handle: result.handle }, { status: 409 });
    return Response.json({ handle: result.profile.handle, displayName: result.profile.displayName });
  } catch {
    return jsonInternalError();
  }
}
