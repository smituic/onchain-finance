import { cookies } from "next/headers";
import { asErrorMessage, disabledResponse, isRealModeEnabled, jsonError, requireRealServerConfig } from "@/lib/real/server/http";
import { resolveAuthenticatedCashBalance } from "@/lib/real/server/balance";
import { getRealAccountRegistry } from "@/lib/real/server/runtime";
import { REAL_SESSION_COOKIE_NAME } from "@/lib/real/server/session";
import { createRealPublicClient } from "@/lib/real/chain/client";

/**
 * Read-only. Takes no request body/query — the Safe address it reads is
 * always the one the HttpOnly session resolves to server-side (see
 * server/balance.ts), never anything a client could supply.
 */
export async function GET() {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const store = await cookies();
    const outcome = await resolveAuthenticatedCashBalance({
      cookieValue: store.get(REAL_SESSION_COOKIE_NAME)?.value,
      sessionSecret: config.sessionSecret,
      registry: getRealAccountRegistry(),
      publicClient: createRealPublicClient(config.rpcUrl),
    });

    if (outcome.outcome === "unauthenticated") return jsonError("Not authenticated.", 401);
    if (outcome.outcome === "account_not_ready") return jsonError("Your account isn't fully set up yet.", 409);
    if (outcome.outcome === "read_failed") return jsonError(outcome.reason, 502);

    return Response.json(outcome.balance);
  } catch (error) {
    return jsonError(asErrorMessage(error), 500);
  }
}
