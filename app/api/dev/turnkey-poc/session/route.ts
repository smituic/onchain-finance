import { isTurnkeyPocEnabled } from "@/lib/poc/turnkey/config";
import { disabledResponse, jsonError, requireServerTurnkeyPocConfig } from "@/lib/poc/turnkey/server/http";
import { clearPocSession, readPocSession } from "@/lib/poc/turnkey/server/session";
import { SESSION_COOKIE_NAME } from "@/lib/poc/turnkey/constants";

export async function GET() {
  if (!isTurnkeyPocEnabled()) return disabledResponse();
  try {
    const config = requireServerTurnkeyPocConfig();
    const session = await readPocSession(config.sessionSecret);
    if (!session) {
      return Response.json({
        authenticated: false,
        cookie: { name: SESSION_COOKIE_NAME, httpOnly: true, jsReadable: false },
      });
    }
    return Response.json({
      authenticated: true,
      appUserId: session.appUserId,
      subOrganizationId: session.subOrganizationId,
      userId: session.userId,
      walletId: session.walletId,
      ownerAddress: session.ownerAddress,
      authenticators: session.authenticators,
      cookie: { name: SESSION_COOKIE_NAME, httpOnly: true, jsReadable: false },
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Session unavailable.", 500);
  }
}

export async function DELETE() {
  if (!isTurnkeyPocEnabled()) return disabledResponse();
  await clearPocSession();
  return Response.json({ authenticated: false });
}
