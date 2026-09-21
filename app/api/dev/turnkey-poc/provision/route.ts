import { isTurnkeyPocEnabled } from "@/lib/poc/turnkey/config";
import { asErrorMessage, disabledResponse, jsonError, requireServerTurnkeyPocConfig } from "@/lib/poc/turnkey/server/http";
import { createSessionId, writePocSession } from "@/lib/poc/turnkey/server/session";
import { provisionChildSubOrganization } from "@/lib/poc/turnkey/server/turnkey";

export async function POST(request: Request) {
  if (!isTurnkeyPocEnabled()) return disabledResponse();

  try {
    const config = requireServerTurnkeyPocConfig();
    const body = (await request.json()) as {
      challengeBase64Url?: string;
      attestation?: {
        credentialId: string;
        clientDataJson: string;
        attestationObject: string;
        transports: Array<
          | "AUTHENTICATOR_TRANSPORT_BLE"
          | "AUTHENTICATOR_TRANSPORT_INTERNAL"
          | "AUTHENTICATOR_TRANSPORT_NFC"
          | "AUTHENTICATOR_TRANSPORT_USB"
          | "AUTHENTICATOR_TRANSPORT_HYBRID"
        >;
      };
    };

    if (!body.challengeBase64Url || !body.attestation?.credentialId || !body.attestation.clientDataJson || !body.attestation.attestationObject) {
      return jsonError("Passkey attestation is required.", 400);
    }

    const provisioned = await provisionChildSubOrganization({
      config,
      challengeBase64Url: body.challengeBase64Url,
      attestation: {
        ...body.attestation,
        transports: body.attestation.transports?.length
          ? body.attestation.transports
          : ["AUTHENTICATOR_TRANSPORT_INTERNAL"],
      },
    });

    await writePocSession(
      {
        v: 1,
        appUserId: createSessionId(),
        subOrganizationId: provisioned.subOrganizationId,
        userId: provisioned.userId,
        walletId: provisioned.walletId,
        ownerAddress: provisioned.ownerAddress,
        authenticators: provisioned.authenticators,
      },
      config.sessionSecret,
    );

    return Response.json({
      appIdentity: "created",
      subOrganizationId: provisioned.subOrganizationId,
      userId: provisioned.userId,
      walletId: provisioned.walletId,
      ownerAddress: provisioned.ownerAddress,
      authenticators: provisioned.authenticators,
      child: provisioned.child,
    });
  } catch (error) {
    return jsonError(asErrorMessage(error), 500);
  }
}
