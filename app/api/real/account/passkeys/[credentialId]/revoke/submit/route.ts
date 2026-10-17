import type { NextRequest } from "next/server";
import { SIGNED_TURNKEY_REQUEST_BODY_MAX_BYTES, disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, readBoundedJsonBody, requestTooLargeResponse, requireRealServerConfig } from "@/lib/real/server/http";
import { submitRevocation } from "@/lib/real/server/passkey-revocation";
import { getPasskeyRevocationStore, getRealAccountRegistry } from "@/lib/real/server/runtime";
import { readPasskeySession } from "@/app/api/real/account/passkeys/session";

/**
 * Returns 200 with an explicit { outcome, reason } for every legitimate
 * state (revoked / pending / authorization_needed / cancelled / blocked) — the client
 * branches on `outcome`. Only a refused request ("rejected") is non-2xx.
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/real/account/passkeys/[credentialId]/revoke/submit">) {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const authenticated = await readPasskeySession(config);
    if (!authenticated) return jsonError("Not authenticated.", 401);
    const { credentialId } = await ctx.params;
    const bounded = await readBoundedJsonBody(request, SIGNED_TURNKEY_REQUEST_BODY_MAX_BYTES);
    if (bounded.kind === "too_large") return requestTooLargeResponse();
    // An unreadable body (invalid) takes the route's existing null path and its existing 400.
    const rawBody = bounded.kind === "ok" ? bounded.value : null;
    if (rawBody === null) return jsonError("Invalid request body.", 400);
    const body = rawBody as { attemptId?: unknown; signedRequest?: unknown };
    if (typeof body.attemptId !== "string") return jsonError("An attemptId is required.", 400);

    const result = await submitRevocation({
      config,
      registry: getRealAccountRegistry(),
      revocations: getPasskeyRevocationStore(),
      appUserId: authenticated.account.appUserId,
      credentialId,
      attemptId: body.attemptId,
      sessionCredentialId: authenticated.session.credentialId,
      signedRequest: body.signedRequest,
    });
    if (result.outcome === "rejected") return jsonError(result.reason, 400);
    return Response.json(result);
  } catch {
    return jsonInternalError();
  }
}
