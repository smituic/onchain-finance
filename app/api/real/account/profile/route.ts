import { CONTROL_BODY_MAX_BYTES, disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, readBoundedJsonBody, requestTooLargeResponse, requireRealServerConfig } from "@/lib/real/server/http";
import { updateAccountDisplayName } from "@/lib/real/server/handle-claim";
import { getAccountHandleStore } from "@/lib/real/server/runtime";
import { readPasskeySession } from "@/app/api/real/account/passkeys/session";

/**
 * Sets or clears the session account's display name. Presentation metadata
 * only — it changes no identity, session, or authority — so an app session
 * is sufficient (no passkey confirmation). The handle is not editable here
 * or anywhere.
 */
export async function PATCH(request: Request) {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const authenticated = await readPasskeySession(config);
    if (!authenticated) return jsonError("Not authenticated.", 401);
    const bounded = await readBoundedJsonBody(request, CONTROL_BODY_MAX_BYTES);
    if (bounded.kind === "too_large") return requestTooLargeResponse();
    // An unreadable body (invalid) takes the route's existing null path and its existing 400.
    const rawBody = bounded.kind === "ok" ? bounded.value : null;
    if (rawBody === null || typeof rawBody !== "object") return jsonError("Invalid request body.", 400);
    const result = await updateAccountDisplayName({
      handles: getAccountHandleStore(),
      appUserId: authenticated.account.appUserId,
      displayName: (rawBody as { displayName?: unknown }).displayName,
    });
    if (result.outcome === "invalid") return jsonError(result.reason, 400);
    if (result.outcome === "not_found") return jsonError("Account not found.", 404);
    return Response.json({ handle: result.profile.handle, displayName: result.profile.displayName });
  } catch {
    return jsonInternalError();
  }
}
