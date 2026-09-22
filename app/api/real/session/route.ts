import { cookies } from "next/headers";
import { disabledResponse, isRealModeEnabled, jsonInternalError, requireRealServerConfig } from "@/lib/real/server/http";
import { readAuthenticatedRealAccount } from "@/lib/real/server/auth";
import { getRealAccountRegistry } from "@/lib/real/server/runtime";
import { REAL_SESSION_COOKIE_NAME } from "@/lib/real/server/session";

export async function GET() {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const store = await cookies();
    const authenticated = await readAuthenticatedRealAccount({
      cookieValue: store.get(REAL_SESSION_COOKIE_NAME)?.value,
      sessionSecret: config.sessionSecret,
      registry: getRealAccountRegistry(),
    });
    if (!authenticated) return Response.json({ authenticated: false });
    return Response.json({
      authenticated: true,
      appUserId: authenticated.account.appUserId,
      ownerAddress: authenticated.account.ownerAddress,
      safeAddress: authenticated.account.safeAddress,
    });
  } catch {
    return jsonInternalError();
  }
}

export async function DELETE() {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const store = await cookies();
    store.delete(REAL_SESSION_COOKIE_NAME);
    return Response.json({ authenticated: false });
  } catch {
    return jsonInternalError();
  }
}
