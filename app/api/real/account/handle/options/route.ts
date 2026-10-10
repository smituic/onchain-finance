import { RECIPIENT_PROBE_RATE_LIMITED_MESSAGE, disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, rateLimitedResponse, readJsonBody, requireRealServerConfig } from "@/lib/real/server/http";
import { prepareHandleClaim } from "@/lib/real/server/handle-claim";
import { getAccountHandleStore, getChallengeStore, getRateLimiter, getRealAccountRegistry } from "@/lib/real/server/runtime";
import { readPasskeySession } from "@/app/api/real/account/passkeys/session";

/**
 * Step 1 of claiming a permanent @handle: checks the requested name and
 * mints a sign-in challenge for the SESSION credential only, bound to that
 * exact name. Availability here is advisory; /handle/claim decides.
 *
 * Slice E: because it answers whether a name is taken, each well-formed
 * request is charged to the caller's recipient-probe budget (shared with the
 * recipient lookup) before the availability read. Over budget is a 429 with
 * Retry-After, no read, and no challenge.
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
      rateLimiter: getRateLimiter(),
      appUserId: authenticated.account.appUserId,
      sessionCredentialId: authenticated.session.credentialId,
      handle: (rawBody as { handle?: unknown }).handle,
    });
    if (result.outcome === "invalid") return jsonError(result.reason, 400);
    if (result.outcome === "rate_limited") return rateLimitedResponse(RECIPIENT_PROBE_RATE_LIMITED_MESSAGE, result.retryAfterSeconds);
    if (result.outcome === "unavailable") return jsonError(result.reason, 409);
    if (result.outcome === "already_has_handle") return Response.json({ error: result.reason, handle: result.handle }, { status: 409 });
    if (result.outcome === "rejected") return jsonError(result.reason, 403);
    return Response.json({ handle: result.handle, optionsJSON: result.optionsJSON });
  } catch {
    return jsonInternalError();
  }
}
