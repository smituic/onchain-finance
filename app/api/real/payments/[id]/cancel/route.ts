import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { asErrorMessage, disabledResponse, isRealModeEnabled, jsonError, requireRealServerConfig } from "@/lib/real/server/http";
import { resolveCancelPayment } from "@/lib/real/server/payments";
import { getPaymentAttemptStore, getRealAccountRegistry } from "@/lib/real/server/runtime";
import { REAL_SESSION_COOKIE_NAME } from "@/lib/real/server/session";

/**
 * Lets the user abandon a payment that is still awaiting_authorization
 * (e.g. after cancelling the passkey prompt) so it doesn't permanently
 * occupy the account's one-active-attempt slot. Refused for any other
 * state — once a signature may exist, cancelling is not offered.
 */
export async function POST(_request: NextRequest, ctx: RouteContext<"/api/real/payments/[id]/cancel">) {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const { id } = await ctx.params;
    const config = requireRealServerConfig();
    const store = await cookies();

    const outcome = await resolveCancelPayment({
      cookieValue: store.get(REAL_SESSION_COOKIE_NAME)?.value,
      sessionSecret: config.sessionSecret,
      registry: getRealAccountRegistry(),
      paymentStore: getPaymentAttemptStore(),
      attemptId: id,
    });

    if (outcome.outcome === "unauthenticated") return jsonError("Not authenticated.", 401);
    if (outcome.outcome === "not_found") return jsonError("Payment not found.", 404);
    if (outcome.outcome === "wrong_state") return jsonError(`This payment can no longer be cancelled (state: ${outcome.state}).`, 409);
    return Response.json({ attempt: outcome.attempt });
  } catch (error) {
    return jsonError(asErrorMessage(error), 500);
  }
}
