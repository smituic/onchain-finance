import type { NextRequest } from "next/server";
import { CONTROL_BODY_MAX_BYTES, disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, readBoundedJsonBody, requestTooLargeResponse, requireRealServerConfig } from "@/lib/real/server/http";
import { cancelRevocation } from "@/lib/real/server/passkey-revocation";
import { getPasskeyRevocationStore } from "@/lib/real/server/runtime";
import { readPasskeySession } from "@/app/api/real/account/passkeys/session";

/** Withdraws an undispatched removal — no passkey status changes, and only the session credential that started it may do this. */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/real/account/passkeys/[credentialId]/revoke/cancel">) {
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

    const result = await cancelRevocation({ revocations: getPasskeyRevocationStore(), appUserId: authenticated.account.appUserId, credentialId, attemptId: body.attemptId, sessionCredentialId: authenticated.session.credentialId });
    if (result.outcome === "rejected") return jsonError(result.reason, 409);
    return Response.json({ cancelled: true });
  } catch {
    return jsonInternalError();
  }
}
