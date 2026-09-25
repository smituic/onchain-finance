import type { NextRequest } from "next/server";
import { disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, readJsonBody, requireRealServerConfig } from "@/lib/real/server/http";
import { reconcileRevocation } from "@/lib/real/server/passkey-revocation";
import { getPasskeyRevocationStore, getRealAccountRegistry } from "@/lib/real/server/runtime";
import { readPasskeySession } from "@/app/api/real/account/passkeys/session";

/**
 * Returns 200 with an explicit { outcome, reason } for every legitimate
 * state (revoked / pending / authorization_needed / cancelled / blocked) — the client
 * branches on `outcome`. Only a refused request ("rejected") is non-2xx.
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/real/account/passkeys/[credentialId]/revoke/reconcile">) {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const authenticated = await readPasskeySession(config);
    if (!authenticated) return jsonError("Not authenticated.", 401);
    const { credentialId } = await ctx.params;
    const rawBody = await readJsonBody(request);
    if (rawBody === null) return jsonError("Invalid request body.", 400);
    const body = rawBody as { attemptId?: unknown };
    if (typeof body.attemptId !== "string") return jsonError("An attemptId is required.", 400);

    const result = await reconcileRevocation({
      config,
      registry: getRealAccountRegistry(),
      revocations: getPasskeyRevocationStore(),
      appUserId: authenticated.account.appUserId,
      credentialId,
      attemptId: body.attemptId,
    });
    if (result.outcome === "rejected") return jsonError(result.reason, 400);
    return Response.json(result);
  } catch {
    return jsonInternalError();
  }
}
