import { cookies } from "next/headers";
import { PAYMENT_PREPARE_RATE_LIMITED_MESSAGE, disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, rateLimitedResponse, readJsonBody, requireRealServerConfig } from "@/lib/real/server/http";
import { parsePrepareRecipientSelector } from "@/lib/real/server/handle-recipient";
import { resolvePreparePayment } from "@/lib/real/server/payments";
import { getPaymentAttemptStore, getRateLimiter, getRealAccountRegistry } from "@/lib/real/server/runtime";
import { REAL_SESSION_COOKIE_NAME } from "@/lib/real/server/session";
import { createRealPublicClient } from "@/lib/real/chain/client";

/**
 * Validates and reserves a Cash payment intent, then asks Pimlico to
 * sponsor it — the server derives the sender (Safe address), token, and
 * chain itself; the client supplies only ONE recipient selector (an address,
 * or a canonical @handle's name) and an amount. See
 * lib/real/server/payments.ts's resolvePreparePayment for the full ordering
 * (cheap validation -> rate limit -> live balance check -> atomic reserve ->
 * external Pimlico prepare) and lib/real/payments/amount.ts for the $50 ceiling.
 *
 * Two different 429s: `rate_limited` (Slice E — too many prepares or handle
 * probes in a window; carries `code` and Retry-After, and nothing was done)
 * and the payment quota `quota_exceeded`, whose body is unchanged.
 */
export async function POST(request: Request) {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const rawBody = await readJsonBody(request);
    if (rawBody === null) return jsonError("Invalid request body.", 400);
    // Exactly one of { recipient } (an address) or { recipientHandle }, parsed
    // once here. Only those two keys and amountBaseUnits are ever read from the
    // body: no client-supplied app user id, Safe address, or display name can
    // reach a payment.
    const recipient = parsePrepareRecipientSelector(rawBody);
    const body = rawBody as { amountBaseUnits?: unknown };
    const store = await cookies();

    const outcome = await resolvePreparePayment({
      cookieValue: store.get(REAL_SESSION_COOKIE_NAME)?.value,
      sessionSecret: config.sessionSecret,
      registry: getRealAccountRegistry(),
      paymentStore: getPaymentAttemptStore(),
      rateLimiter: getRateLimiter(),
      publicClient: createRealPublicClient(config.rpcUrl),
      pimlicoApiKey: config.pimlicoApiKey,
      recipient,
      amountBaseUnitsInput: body.amountBaseUnits,
    });

    switch (outcome.outcome) {
      case "unauthenticated":
        return jsonError("Not authenticated.", 401);
      case "account_not_ready":
        return jsonError("Your account isn't fully set up yet.", 409);
      case "invalid_recipient":
        return jsonError("Enter a valid recipient address.", 400);
      case "invalid_recipient_handle":
        return jsonError("Enter a valid @name.", 400);
      case "recipient_not_found":
        return jsonError("We couldn't find anyone with that name.", 404);
      case "self_payment":
        return jsonError("You can't pay yourself.", 400);
      case "invalid_amount":
        return jsonError("Enter a valid Cash amount.", 400);
      case "rate_limited":
        return rateLimitedResponse(PAYMENT_PREPARE_RATE_LIMITED_MESSAGE, outcome.retryAfterSeconds);
      case "balance_check_failed":
        return jsonError(outcome.reason, 502);
      case "insufficient_balance":
        return jsonError("That's more than your available Cash.", 400);
      case "quota_exceeded":
        return jsonError("You've reached the payment limit for now. Try again later.", 429);
      case "payment_in_progress":
        return jsonError("You already have a payment in progress.", 409);
      case "prepare_failed":
        return jsonError(outcome.reason, 502);
      case "ready":
        return Response.json({ attempt: outcome.attempt, subOrganizationId: outcome.subOrganizationId, authorizingCredentialId: outcome.authorizingCredentialId, serverNowSeconds: outcome.serverNowSeconds });
    }
  } catch {
    return jsonInternalError();
  }
}
