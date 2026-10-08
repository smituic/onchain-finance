import { disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, readJsonBody, requireRealServerConfig } from "@/lib/real/server/http";
import { resolveHandleRecipient, toPublicRecipientLookup } from "@/lib/real/server/handle-recipient";
import { getAccountHandleStore } from "@/lib/real/server/runtime";
import { readPasskeySession } from "@/app/api/real/account/passkeys/session";

/**
 * Advisory, exact-match recipient discovery by @handle for a signed-in Real
 * account. No prefix search, no listing, no lookup by app user id or address.
 * It answers only { found, handle, displayName, isSelf }: the recipient's Safe
 * and app user id stay on the server.
 *
 * TESTNET ONLY: there is no shared, durable rate limiter yet, so this route
 * is not ready for a public or mainnet deployment. Per-account, per-IP, and
 * global limits must exist before one.
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
      handle: (rawBody as { handle?: unknown }).handle,
      currentAppUserId: authenticated.account.appUserId,
    });
    if (result.outcome === "malformed") return jsonError(result.reason, 400);
    return Response.json(toPublicRecipientLookup(result));
  } catch {
    return jsonInternalError();
  }
}
