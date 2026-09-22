import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { asErrorMessage, disabledResponse, isRealModeEnabled, jsonError, requireRealServerConfig } from "@/lib/real/server/http";
import { resolvePaymentStatus } from "@/lib/real/server/payments";
import { getPaymentAttemptStore, getRealAccountRegistry } from "@/lib/real/server/runtime";
import { REAL_SESSION_COOKIE_NAME } from "@/lib/real/server/session";

/**
 * Reconciles a submitted/unknown attempt against the bundler by its
 * precomputed expected_user_operation_hash — see
 * lib/real/server/payments.ts's resolvePaymentStatus. Read-only from the
 * client's perspective (it never signs or resubmits); the only mutation is
 * moving the durable attempt to confirmed/failed on an unambiguous receipt.
 */
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/real/payments/[id]/status">) {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const { id } = await ctx.params;
    const config = requireRealServerConfig();
    const store = await cookies();

    const outcome = await resolvePaymentStatus({
      cookieValue: store.get(REAL_SESSION_COOKIE_NAME)?.value,
      sessionSecret: config.sessionSecret,
      registry: getRealAccountRegistry(),
      paymentStore: getPaymentAttemptStore(),
      pimlicoApiKey: config.pimlicoApiKey,
      attemptId: id,
    });

    if (outcome.outcome === "unauthenticated") return jsonError("Not authenticated.", 401);
    if (outcome.outcome === "not_found") return jsonError("Payment not found.", 404);
    return Response.json({ attempt: outcome.attempt });
  } catch (error) {
    return jsonError(asErrorMessage(error), 500);
  }
}
