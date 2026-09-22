import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { asErrorMessage, disabledResponse, isRealModeEnabled, jsonError, requireRealServerConfig } from "@/lib/real/server/http";
import { resolvePaymentHistory } from "@/lib/real/server/payment-history";
import { getPaymentAttemptStore, getRealAccountRegistry } from "@/lib/real/server/runtime";
import { REAL_SESSION_COOKIE_NAME } from "@/lib/real/server/session";

/**
 * Batch 2e: bounded, read-only payment history — imports only
 * server/payment-history.ts, never server/payments.ts, so this route never
 * pulls in the prepare/submit/status write-and-signing module graph. Takes
 * only `limit`; the account is always whatever the session resolves to,
 * same as the balance/latest routes.
 */
export async function GET(request: NextRequest) {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const store = await cookies();

    const outcome = await resolvePaymentHistory({
      cookieValue: store.get(REAL_SESSION_COOKIE_NAME)?.value,
      sessionSecret: config.sessionSecret,
      registry: getRealAccountRegistry(),
      paymentStore: getPaymentAttemptStore(),
      limitInput: request.nextUrl.searchParams.get("limit"),
    });

    if (outcome.outcome === "unauthenticated") return jsonError("Not authenticated.", 401);
    return Response.json({ entries: outcome.entries });
  } catch (error) {
    return jsonError(asErrorMessage(error), 500);
  }
}
