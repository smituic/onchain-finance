import type { NextRequest } from "next/server";
import { validatePasskeyDisplayName } from "@/lib/real/display/passkey-name";
import { disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, readJsonBody, requireRealServerConfig } from "@/lib/real/server/http";
import { getRealAccountRegistry } from "@/lib/real/server/runtime";
import { readPasskeySession } from "@/app/api/real/account/passkeys/session";

/**
 * Renames one of the session account's own ACTIVE passkeys. The name is
 * presentation metadata only — it changes no identity, status, or authority —
 * so an app session is sufficient (no WebAuthn stamp). Another account's
 * credential gets the same 404 as a missing one.
 */
export async function PATCH(request: NextRequest, ctx: RouteContext<"/api/real/account/passkeys/[credentialId]">) {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const authenticated = await readPasskeySession(config);
    if (!authenticated) return jsonError("Not authenticated.", 401);
    const { credentialId } = await ctx.params;
    const rawBody = await readJsonBody(request);
    if (rawBody === null || typeof rawBody !== "object") return jsonError("Invalid request body.", 400);
    const validation = validatePasskeyDisplayName((rawBody as { displayName?: unknown }).displayName);
    if (!validation.ok) return jsonError(validation.reason, 400);

    const result = await getRealAccountRegistry().renamePasskey({ appUserId: authenticated.account.appUserId, credentialId, displayName: validation.name });
    if (result.outcome === "not_found") return jsonError("Passkey not found.", 404);
    if (result.outcome === "not_active") return jsonError("Only an active passkey can be renamed.", 409);
    return Response.json({ passkey: { credentialId: result.passkey.credentialId, displayName: result.passkey.displayName } });
  } catch {
    return jsonInternalError();
  }
}
