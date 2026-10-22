import { disabledResponse, isRealModeEnabled, jsonInternalError, requireRealServerConfig } from "@/lib/real/server/http";
import { beginLogin } from "@/lib/real/server/login";

// Milestone 3C-2: the challenge is a signed, expiring token minted without any database access, so this route
// performs no database request and no write for an anonymous caller. (Replay protection happens at login/verify.)
export async function POST() {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const { optionsJSON } = await beginLogin({ config });
    return Response.json({ optionsJSON });
  } catch {
    return jsonInternalError();
  }
}
