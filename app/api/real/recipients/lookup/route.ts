import { RECIPIENT_PROBE_RATE_LIMITED_MESSAGE, disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, rateLimitedResponse, readJsonBody, requireRealServerConfig } from "@/lib/real/server/http";
import { resolveHandleRecipient, toPublicRecipientLookup } from "@/lib/real/server/handle-recipient";
import { getAccountHandleStore, getRateLimiter } from "@/lib/real/server/runtime";
import { readPasskeySession } from "@/app/api/real/account/passkeys/session";

/**
 * Advisory, exact-match recipient discovery by @handle for a signed-in Real
 * account. No prefix search, no listing, no lookup by app user id or address.
 * It answers only { found, handle, displayName, isSelf }: the recipient's Safe
 * and app user id stay on the server.
 *
 * Slice E: each well-formed lookup is charged to the caller's own
 * recipient-probe budget (20 per 10 minutes, 100 per day, shared with the
 * handle-claim options step and handle payment prepare) after the handle is
 * validated and before anything is read. Over budget is a 429 with
 * Retry-After and no lookup. A limiter failure is the generic 500 — never an
 * unmetered lookup.
 *
 * Per-account only: there is no per-IP or global limit, so resistance to
 * many accounts still has to come from registration before a public or
 * mainnet deployment.
 */
export async function POST(request: Request) {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const authenticated = await readPasskeySession(config);
    if (!authenticated) return jsonError("Not authenticated.", 401);
    const rawBody = await readJsonBody(request);
    if (rawBody === null || typeof rawBody !== "object") return jsonError("Invalid request body.", 400);
    const result = await resolveHandleRecipient({
      handles: getAccountHandleStore(),
      rateLimiter: getRateLimiter(),
      handle: (rawBody as { handle?: unknown }).handle,
      currentAppUserId: authenticated.account.appUserId,
    });
    if (result.outcome === "malformed") return jsonError(result.reason, 400);
    if (result.outcome === "rate_limited") return rateLimitedResponse(RECIPIENT_PROBE_RATE_LIMITED_MESSAGE, result.retryAfterSeconds);
    return Response.json(toPublicRecipientLookup(result));
  } catch {
    return jsonInternalError();
  }
}
