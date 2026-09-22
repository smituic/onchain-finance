import { disabledResponse, isRealModeEnabled, jsonInternalError, requireRealServerConfig } from "@/lib/real/server/http";
import { beginLogin } from "@/lib/real/server/login";
import { getChallengeStore } from "@/lib/real/server/runtime";

export async function POST() {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const { optionsJSON } = await beginLogin({ config, challengeStore: getChallengeStore() });
    return Response.json({ optionsJSON });
  } catch {
    return jsonInternalError();
  }
}
