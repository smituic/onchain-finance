import { cookies } from "next/headers";
import { disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, readJsonBody, requireRealServerConfig } from "@/lib/real/server/http";
import { resolveSubmitPayment } from "@/lib/real/server/payments";
import { getPaymentAttemptStore, getRealAccountRegistry } from "@/lib/real/server/runtime";
import { REAL_SESSION_COOKIE_NAME } from "@/lib/real/server/session";

/**
 * Takes only { attemptId, signature, activityId } — every other
 * UserOperation field comes from the server's own persisted attempt row,
 * never re-trusted from the client, and activityId is only a locator for the
 * Turnkey read-back that proves which passkey approved it
 * (lib/real/server/payment-authorization.ts). A valid app session alone is
 * never enough: the signature must independently verify (SafeOp preflight)
 * against the canonical owner AND be the payment's bound passkey's Turnkey
 * approval of exactly this payment before eth_sendUserOperation is ever called.
 * Always returns 200 for a definitive outcome (submitted/failed/unknown) —
 * "unknown" is not an error status, it's a real, expected outcome the
 * client must handle by disabling resend and offering to check status.
 */
export async function POST(request: Request) {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const rawBody = await readJsonBody(request);
    if (rawBody === null) return jsonError("Invalid request body.", 400);
    const body = rawBody as { attemptId?: unknown; signature?: unknown; activityId?: unknown };
    const store = await cookies();

    const outcome = await resolveSubmitPayment({
      cookieValue: store.get(REAL_SESSION_COOKIE_NAME)?.value,
      sessionSecret: config.sessionSecret,
      registry: getRealAccountRegistry(),
      paymentStore: getPaymentAttemptStore(),
      pimlicoApiKey: config.pimlicoApiKey,
      config,
      attemptId: body.attemptId,
      signature: body.signature,
      activityId: body.activityId,
    });

    switch (outcome.outcome) {
      case "unauthenticated":
        return jsonError("Not authenticated.", 401);
      case "not_found":
        return jsonError("Payment not found.", 404);
      case "invalid_signature":
        return jsonError("This payment's signature could not be verified.", 400);
      case "wrong_state":
        return jsonError(`This payment is no longer awaiting authorization (state: ${outcome.state}).`, 409);
      case "wrong_passkey":
        return jsonError("This payment was started with a different passkey. Cancel it and start a new payment.", 409);
      case "authorization_unavailable":
        // Nothing changed and nothing was sent — the same signature may be retried.
        return Response.json({ error: "We couldn't confirm your passkey approval yet. Try again in a moment.", retryable: true }, { status: 503 });
      case "submitted":
      case "failed":
      case "unknown":
        return Response.json({ attempt: outcome.attempt });
    }
  } catch {
    return jsonInternalError();
  }
}
