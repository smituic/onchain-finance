import { isTurnkeyPocEnabled } from "@/lib/poc/turnkey/config";
import { normalizeAddress } from "@/lib/poc/turnkey/identifiers";
import { asErrorMessage, disabledResponse, jsonError, requireServerTurnkeyPocConfig } from "@/lib/poc/turnkey/server/http";
import { readPocSession } from "@/lib/poc/turnkey/server/session";
import { readUsdcHistory } from "@/lib/poc/turnkey/server/chain";
import type { Address } from "viem";

export async function POST(request: Request) {
  if (!isTurnkeyPocEnabled()) return disabledResponse();
  try {
    const config = requireServerTurnkeyPocConfig();
    const session = await readPocSession(config.sessionSecret);
    if (!session) return jsonError("No app session.", 401);
    const body = (await request.json()) as { safeAddress?: string };
    const safeAddress = normalizeAddress(body.safeAddress);
    if (!safeAddress) return jsonError("Safe address is required.", 400);
    const history = await readUsdcHistory({ config, safeAddress: safeAddress as Address });
    return Response.json({ history });
  } catch (error) {
    return jsonError(asErrorMessage(error), 500);
  }
}
