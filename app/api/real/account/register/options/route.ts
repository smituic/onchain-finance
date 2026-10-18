import { disabledResponse, isRealModeEnabled, jsonInternalError, registrationUnavailableResponse, requireRealServerConfig } from "@/lib/real/server/http";
import { beginRegistration } from "@/lib/real/server/registration";
import { getChallengeStore, getRegistrationAdmission } from "@/lib/real/server/runtime";

// Milestone 3C-1 order: disabled -> 404 (nothing charged); invalid server
// configuration -> generic 500 (nothing charged); global registration admission
// (refused -> 503; a limiter or database failure -> the generic 500 below); only
// then is a challenge minted. A refusal mints no challenge, and a challenge that
// fails after admission is never refunded. The route takes no request, so it can
// read no header, cookie, or body.
export async function POST() {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const admission = await getRegistrationAdmission().admit();
    if (!admission.admitted) return registrationUnavailableResponse(admission.retryAfterSeconds);
    const { optionsJSON } = await beginRegistration({ config, challengeStore: getChallengeStore() });
    return Response.json({ optionsJSON });
  } catch {
    return jsonInternalError();
  }
}
