import { isTurnkeyPocEnabled } from "@/lib/poc/turnkey/config";
import { normalizeAddress } from "@/lib/poc/turnkey/identifiers";
import { asErrorMessage, disabledResponse, jsonError, requireServerTurnkeyPocConfig } from "@/lib/poc/turnkey/server/http";
import { readPocSession } from "@/lib/poc/turnkey/server/session";
import { findWalletAccountByAddress } from "@/lib/poc/turnkey/server/turnkey";

/**
 * Read-only diagnostic: does this address belong to any Turnkey wallet
 * account in the current child sub-org? Creates and signs nothing.
 */
export async function POST(request: Request) {
  if (!isTurnkeyPocEnabled()) return disabledResponse();
  try {
    const config = requireServerTurnkeyPocConfig();
    const session = await readPocSession(config.sessionSecret);
    if (!session) return jsonError("No app session.", 401);

    const body = (await request.json()) as { address?: string };
    const address = normalizeAddress(body.address);
    if (!address) return jsonError("A valid 0x… address is required.", 400);

    const match = await findWalletAccountByAddress({
      config,
      subOrganizationId: session.subOrganizationId,
      knownWalletId: session.walletId,
      address,
    });

    return Response.json({ address, match });
  } catch (error) {
    return jsonError(asErrorMessage(error), 500);
  }
}
