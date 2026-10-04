import { disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, readJsonBody, requireRealServerConfig } from "@/lib/real/server/http";
import { prepareHandleClaim } from "@/lib/real/server/handle-claim";
import { getAccountHandleStore, getChallengeStore, getRealAccountRegistry } from "@/lib/real/server/runtime";
import { readPasskeySession } from "@/app/api/real/account/passkeys/session";

/**
 * Step 1 of claiming a permanent @handle: checks the requested name and
 * mints a sign-in challenge for the SESSION credential only, bound to that
 * exact name. Availability here is advisory; /handle/claim decides.
 */
export async function POST(request: Request) {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const authenticated = await readPasskeySession(config);
    if (!authenticated) return jsonError("Not authenticated.", 401);
    const rawBody = await readJsonBody(request);
    if (rawBody === null || typeof rawBody !== "object") return jsonError("Invalid request body.", 400);
    const result = await prepareHandleClaim({
      config,
      challengeStore: getChallengeStore(),
      registry: getRealAccountRegistry(),
      handles: getAccountHandleStore(),
      appUserId: authenticated.account.appUserId,
      sessionCredentialId: authenticated.session.credentialId,
      handle: (rawBody as { handle?: unknown }).handle,
    });
    if (result.outcome === "invalid") return jsonError(result.reason, 400);
    if (result.outcome === "unavailable") return jsonError(result.reason, 409);
    if (result.outcome === "already_has_handle") return Response.json({ error: result.reason, handle: result.handle }, { status: 409 });
    if (result.outcome === "rejected") return jsonError(result.reason, 403);
    return Response.json({ handle: result.handle, optionsJSON: result.optionsJSON });
  } catch {
    return jsonInternalError();
  }
}
