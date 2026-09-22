import { disabledResponse, isRealModeEnabled, jsonInternalError, requireRealServerConfig } from "@/lib/real/server/http";
import { beginRegistration } from "@/lib/real/server/registration";
import { getChallengeStore } from "@/lib/real/server/runtime";

export async function POST() {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const { optionsJSON } = await beginRegistration({ config, challengeStore: getChallengeStore() });
    return Response.json({ optionsJSON });
  } catch {
    return jsonInternalError();
  }
}
