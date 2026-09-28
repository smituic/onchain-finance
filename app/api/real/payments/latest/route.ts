import { cookies } from "next/headers";
import { disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, requireRealServerConfig } from "@/lib/real/server/http";
import { resolveLatestPayment } from "@/lib/real/server/payments";
import { getPaymentAttemptStore, getRealAccountRegistry } from "@/lib/real/server/runtime";
import { REAL_SESSION_COOKIE_NAME } from "@/lib/real/server/session";

/**
 * Reload/restore: the most recent payment attempt (any state) for the
 * authenticated account, with no side effects — never signs, never
 * submits, never resends. Takes no request body/query, same as the balance
 * route: the account is always whatever the session resolves to.
 */
export async function GET() {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const store = await cookies();

    const outcome = await resolveLatestPayment({
      cookieValue: store.get(REAL_SESSION_COOKIE_NAME)?.value,
      sessionSecret: config.sessionSecret,
      registry: getRealAccountRegistry(),
      paymentStore: getPaymentAttemptStore(),
    });

    if (outcome.outcome === "unauthenticated") return jsonError("Not authenticated.", 401);
    if (outcome.outcome === "none") return Response.json({ attempt: null });
    return Response.json({ attempt: outcome.attempt, subOrganizationId: outcome.subOrganizationId, authorizingCredentialId: outcome.authorizingCredentialId, serverNowSeconds: outcome.serverNowSeconds });
  } catch {
    return jsonInternalError();
  }
}
