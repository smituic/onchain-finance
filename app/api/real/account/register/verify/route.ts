import { cookies } from "next/headers";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { WEBAUTHN_REGISTRATION_BODY_MAX_BYTES, disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, readBoundedJsonBody, requestTooLargeResponse, requireRealServerConfig } from "@/lib/real/server/http";
import { completeRegistration } from "@/lib/real/server/registration";
import { getChallengeStore, getRealAccountRegistry, getRegistrationAttemptStore } from "@/lib/real/server/runtime";
import { REAL_SESSION_COOKIE_NAME, realSessionCookieOptions } from "@/lib/real/server/session";

export async function POST(request: Request) {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const bounded = await readBoundedJsonBody(request, WEBAUTHN_REGISTRATION_BODY_MAX_BYTES);
    if (bounded.kind === "too_large") return requestTooLargeResponse();
    // An unreadable body (invalid) takes the route's existing null path and its existing 400.
    const rawBody = bounded.kind === "ok" ? bounded.value : null;
    if (rawBody === null) return jsonError("Invalid request body.", 400);
    const body = rawBody as { response?: RegistrationResponseJSON };
    if (!body.response) return jsonError("A WebAuthn registration response is required.", 400);

    const result = await completeRegistration({
      config,
      challengeStore: getChallengeStore(),
      registry: getRealAccountRegistry(),
      attempts: getRegistrationAttemptStore(),
      response: body.response,
    });

    if (result.outcome === "rejected") return jsonError(result.reason, 400);
    if (result.outcome === "blocked") return jsonError(result.reason, 409);
    // 503, not 2xx: the client's api() helper treats any non-2xx as an
    // error to surface, and a "pending" outcome must never be mistaken for
    // a successful { appUserId, ownerAddress, safeAddress } response.
    if (result.outcome === "pending") return jsonError(result.reason, 503);

    // Registration Abuse Protection. Neither is a session, and neither is
    // "pending": the first is temporary (503, like any not-now answer here),
    // the second is final for this attempt (409, like "blocked"). The `code`
    // tells them apart; no count, limit, or retry time is ever sent.
    if (result.outcome === "capacity_reached") return Response.json({ error: result.reason, code: "registration_capacity_reached" }, { status: 503 });
    if (result.outcome === "setup_exhausted") return Response.json({ error: result.reason, code: "registration_setup_exhausted" }, { status: 409 });

    const store = await cookies();
    store.set(REAL_SESSION_COOKIE_NAME, result.sessionCookie, realSessionCookieOptions());

    return Response.json({
      appUserId: result.account.appUserId,
      ownerAddress: result.account.ownerAddress,
      safeAddress: result.account.safeAddress,
      // A just-registered account cannot own a handle or a display name yet, so
      // nothing is looked up: no profile-store failure can exist on this path.
      handle: null,
      displayName: null,
    });
  } catch {
    return jsonInternalError();
  }
}
