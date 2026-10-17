import { cookies } from "next/headers";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { WEBAUTHN_ASSERTION_BODY_MAX_BYTES, disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, readBoundedJsonBody, requestTooLargeResponse, requireRealServerConfig } from "@/lib/real/server/http";
import { completeLogin } from "@/lib/real/server/login";
import { readAccountProfileBestEffort } from "@/lib/real/server/handle-claim";
import { getAccountHandleStore, getChallengeStore, getRealAccountRegistry, getRegistrationAttemptStore } from "@/lib/real/server/runtime";
import { REAL_SESSION_COOKIE_NAME, realSessionCookieOptions } from "@/lib/real/server/session";

export async function POST(request: Request) {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const bounded = await readBoundedJsonBody(request, WEBAUTHN_ASSERTION_BODY_MAX_BYTES);
    if (bounded.kind === "too_large") return requestTooLargeResponse();
    // An unreadable body (invalid) takes the route's existing null path and its existing 400.
    const rawBody = bounded.kind === "ok" ? bounded.value : null;
    if (rawBody === null) return jsonError("Invalid request body.", 400);
    const body = rawBody as { response?: AuthenticationResponseJSON };
    if (!body.response) return jsonError("A WebAuthn login response is required.", 400);

    const result = await completeLogin({
      config,
      challengeStore: getChallengeStore(),
      registry: getRealAccountRegistry(),
      attempts: getRegistrationAttemptStore(),
      response: body.response,
    });

    if (result.outcome === "rejected") return jsonError(result.reason, 401);
    if (result.outcome === "blocked") return jsonError(result.reason, 409);
    // 503, not 2xx — see register/verify's identical reasoning: a
    // "pending" outcome must never be mistaken for a successful account response.
    if (result.outcome === "pending") return jsonError(result.reason, 503);

    // Registration Abuse Protection. Neither is a session, and neither is
    // "pending": the first is temporary (503, like any not-now answer here),
    // the second is final for this attempt (409, like "blocked"). The `code`
    // tells them apart; no count, limit, or retry time is ever sent.
    if (result.outcome === "capacity_reached") return Response.json({ error: result.reason, code: "registration_capacity_reached" }, { status: 503 });
    if (result.outcome === "setup_exhausted") return Response.json({ error: result.reason, code: "registration_setup_exhausted" }, { status: 409 });

    const store = await cookies();
    store.set(REAL_SESSION_COOKIE_NAME, result.sessionCookie, realSessionCookieOptions());

    // Sign-in is already complete and its session issued. The handle / display
    // name are response enrichment only: if they can't be read, the login still
    // succeeds, with none. Never part of the session cookie.
    const profile = await readAccountProfileBestEffort({ handles: getAccountHandleStore, appUserId: result.account.appUserId });

    return Response.json({
      appUserId: result.account.appUserId,
      ownerAddress: result.account.ownerAddress,
      safeAddress: result.account.safeAddress,
      handle: profile.handle,
      displayName: profile.displayName,
    });
  } catch {
    return jsonInternalError();
  }
}
