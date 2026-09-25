import type { NextRequest } from "next/server";
import { disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, requireRealServerConfig } from "@/lib/real/server/http";
import { prepareRevocation } from "@/lib/real/server/passkey-revocation";
import { getPasskeyRevocationStore, getRealAccountRegistry } from "@/lib/real/server/runtime";
import { readPasskeySession } from "@/app/api/real/account/passkeys/session";

/**
 * The surviving authorizer is the session credential — never a
 * client-supplied value. Records an undispatched removal (the target stays
 * fully active) and returns the exact DELETE activity for that session
 * credential to stamp.
 */
export async function POST(_request: NextRequest, ctx: RouteContext<"/api/real/account/passkeys/[credentialId]/revoke/options">) {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const authenticated = await readPasskeySession(config);
    if (!authenticated) return jsonError("Not authenticated.", 401);
    const { credentialId } = await ctx.params;
    const result = await prepareRevocation({
      config,
      registry: getRealAccountRegistry(),
      revocations: getPasskeyRevocationStore(),
      appUserId: authenticated.account.appUserId,
      credentialId,
      sessionCredentialId: authenticated.session.credentialId,
    });
    if (result.outcome === "rejected") return Response.json({ error: result.reason, code: result.code }, { status: 409 });
    return Response.json({ attemptId: result.attemptId, activity: result.activity, rpId: result.rpId, authorizingCredentialId: result.authorizingCredentialId });
  } catch {
    return jsonInternalError();
  }
}
