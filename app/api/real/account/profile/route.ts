import { disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, readJsonBody, requireRealServerConfig } from "@/lib/real/server/http";
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
    const rawBody = await readJsonBody(request);
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
