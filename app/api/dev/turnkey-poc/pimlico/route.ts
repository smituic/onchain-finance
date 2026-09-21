import { isTurnkeyPocEnabled } from "@/lib/poc/turnkey/config";
import { asErrorMessage, disabledResponse, jsonError, requireServerTurnkeyPocConfig } from "@/lib/poc/turnkey/server/http";
import { proxyPimlicoRequest } from "@/lib/poc/turnkey/server/pimlico";
import { readPocSession } from "@/lib/poc/turnkey/server/session";

export async function POST(request: Request) {
  if (!isTurnkeyPocEnabled()) return disabledResponse();
  try {
    const config = requireServerTurnkeyPocConfig();
    const session = await readPocSession(config.sessionSecret);
    if (!session) return jsonError("No app session.", 401);
    const body = await request.json();
    return await proxyPimlicoRequest(config, body);
  } catch (error) {
    return jsonError(asErrorMessage(error), 400);
  }
}
