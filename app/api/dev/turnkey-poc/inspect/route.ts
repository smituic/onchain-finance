import { isTurnkeyPocEnabled } from "@/lib/poc/turnkey/config";
import { asErrorMessage, disabledResponse, jsonError, requireServerTurnkeyPocConfig } from "@/lib/poc/turnkey/server/http";
import { readPocSession } from "@/lib/poc/turnkey/server/session";
import { inspectChildOrganization } from "@/lib/poc/turnkey/server/turnkey";

export async function GET() {
  if (!isTurnkeyPocEnabled()) return disabledResponse();
  try {
    const config = requireServerTurnkeyPocConfig();
    const session = await readPocSession(config.sessionSecret);
    if (!session) return jsonError("No app session.", 401);

    const inspection = await inspectChildOrganization({
      config,
      subOrganizationId: session.subOrganizationId,
      walletId: session.walletId,
      expectedUserId: session.userId,
    });

    return Response.json({
      parentOrganizationIdPresent: Boolean(config.parentOrganizationId),
      parentCredentialExposedToClient: false,
      subOrganizationId: session.subOrganizationId,
      users: inspection.users,
      authenticators: inspection.authenticators,
      child: inspection.child,
      // Re-derived from Turnkey's own getWalletAccounts, not from anything
      // cached client-side — lets the UI self-heal a locally corrupted
      // (e.g. lowercased) owner address without reprovisioning.
      ownerAddress: inspection.ownerAddress,
    });
  } catch (error) {
    return jsonError(asErrorMessage(error), 500);
  }
}
