import { isTurnkeyPocEnabled } from "@/lib/poc/turnkey/config";
import { asErrorMessage, disabledResponse, jsonError, requireServerTurnkeyPocConfig } from "@/lib/poc/turnkey/server/http";
import { readPocSession } from "@/lib/poc/turnkey/server/session";
import { getCanonicalOwnerAddress, runBackendNegativeTests } from "@/lib/poc/turnkey/server/turnkey";

export async function POST() {
  if (!isTurnkeyPocEnabled()) return disabledResponse();
  try {
    const config = requireServerTurnkeyPocConfig();
    const session = await readPocSession(config.sessionSecret);
    if (!session) return jsonError("No app session.", 401);

    // Re-derive the exact-case address from Turnkey rather than trusting a
    // cached value, so a failure here means "the parent credential was
    // rejected" and never "we looked up the wrong resource".
    const ownerAddress =
      (await getCanonicalOwnerAddress({
        config,
        subOrganizationId: session.subOrganizationId,
        walletId: session.walletId,
      })) ?? session.ownerAddress;

    const results = await runBackendNegativeTests({
      config,
      subOrganizationId: session.subOrganizationId,
      userId: session.userId,
      walletId: session.walletId,
      ownerAddress,
    });

    return Response.json({
      backendCanIndependentlyTransfer: false,
      allFailedAsExpected: results.every((result) => result.failedAsExpected),
      results,
    });
  } catch (error) {
    return jsonError(asErrorMessage(error), 500);
  }
}
