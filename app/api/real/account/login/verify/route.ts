import { cookies } from "next/headers";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, readJsonBody, requireRealServerConfig } from "@/lib/real/server/http";
import { completeLogin } from "@/lib/real/server/login";
import { getChallengeStore, getRealAccountRegistry, getRegistrationAttemptStore } from "@/lib/real/server/runtime";
import { REAL_SESSION_COOKIE_NAME, realSessionCookieOptions } from "@/lib/real/server/session";

export async function POST(request: Request) {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const rawBody = await readJsonBody(request);
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

    const store = await cookies();
    store.set(REAL_SESSION_COOKIE_NAME, result.sessionCookie, realSessionCookieOptions());

    return Response.json({
      appUserId: result.account.appUserId,
      ownerAddress: result.account.ownerAddress,
      safeAddress: result.account.safeAddress,
    });
  } catch {
    return jsonInternalError();
  }
}
