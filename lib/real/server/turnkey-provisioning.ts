import { ApiKeyStamper } from "@turnkey/api-key-stamper";
import { TurnkeyActivityError, TurnkeyClient, createActivityPoller } from "@turnkey/http";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { REAL_WALLET_ACCOUNT } from "../constants";
import type { RealServerConfig } from "./config";

/**
 * The ONLY error shape treated as proof that no child sub-organization was
 * created. `@turnkey/http`'s createActivityPoller throws TurnkeyActivityError
 * with activityStatus ACTIVITY_STATUS_FAILED/REJECTED only after it already
 * received a real activity id back from Turnkey and then observed Turnkey's
 * own ledger resolve that specific activity to a terminal non-success
 * status — this is Turnkey's own durable answer, not an inference we're
 * making about network behavior. Every other failure (a network error or
 * timeout from the initial request, any TurnkeyRequestError regardless of
 * its HTTP status, ACTIVITY_STATUS_CONSENSUS_NEEDED/AUTHENTICATORS_NEEDED,
 * or anything else) leaves the true outcome unknown and must never be
 * treated as proof nothing was created.
 *
 * Checked at @turnkey/http 6.5.0 (installed version) for an official
 * idempotency key / client request identifier on createSubOrganization —
 * none exists (no "idempoten*" anywhere in the package). There is nothing
 * to rely on there; this activity-status check is the only durable signal
 * this SDK version offers.
 */
export function isDefinitiveProvisioningFailure(error: unknown): boolean {
  if (!(error instanceof TurnkeyActivityError)) return false;
  return error.activityStatus === "ACTIVITY_STATUS_FAILED" || error.activityStatus === "ACTIVITY_STATUS_REJECTED";
}

/**
 * The server-only parent Turnkey client, holding the parent API key. This
 * key must never become a child API key, never become child root authority,
 * never sign a child wallet transaction, and never reach browser code — it
 * only ever calls parent-scoped, server-side activities (provisioning here;
 * read-only discovery in turnkey-discovery.ts).
 */
export function createParentTurnkeyClient(config: RealServerConfig): TurnkeyClient {
  return new TurnkeyClient(
    { baseUrl: config.turnkeyApiBaseUrl },
    new ApiKeyStamper({ apiPublicKey: config.turnkeyApiPublicKey, apiPrivateKey: config.turnkeyApiPrivateKey }),
  );
}

type TurnkeyAuthenticatorTransport =
  | "AUTHENTICATOR_TRANSPORT_BLE"
  | "AUTHENTICATOR_TRANSPORT_INTERNAL"
  | "AUTHENTICATOR_TRANSPORT_NFC"
  | "AUTHENTICATOR_TRANSPORT_USB"
  | "AUTHENTICATOR_TRANSPORT_HYBRID";

function toTurnkeyTransport(transport: string): TurnkeyAuthenticatorTransport {
  switch (transport) {
    case "ble":
      return "AUTHENTICATOR_TRANSPORT_BLE";
    case "nfc":
      return "AUTHENTICATOR_TRANSPORT_NFC";
    case "usb":
      return "AUTHENTICATOR_TRANSPORT_USB";
    case "hybrid":
      return "AUTHENTICATOR_TRANSPORT_HYBRID";
    default:
      return "AUTHENTICATOR_TRANSPORT_INTERNAL";
  }
}

export type ProvisionedTurnkeyAccount = {
  subOrganizationId: string;
  turnkeyUserId: string;
  walletId: string;
  walletAccountId: string;
  ownerAddress: string;
};

/**
 * Provisions a Turnkey child sub-organization from the SAME WebAuthn
 * registration ceremony our own server already verified independently (see
 * server/webauthn.ts's verifyRegistration) — never a second, Turnkey-only
 * passkey. Call this only after that verification has already succeeded;
 * this function does not re-verify the ceremony itself, it forwards the
 * already-verified attestation fields as Turnkey's own authenticator record.
 *
 * Root model, unchanged from the audited PoC: one root user (the passkey),
 * threshold 1, no API keys, no OAuth/email/SMS auth or recovery. The parent
 * credential used to call this never becomes a child API key or root user.
 */
export async function provisionTurnkeyChildAccount(input: {
  config: RealServerConfig;
  challengeBase64Url: string;
  registration: RegistrationResponseJSON;
  appUserId: string;
}): Promise<ProvisionedTurnkeyAccount> {
  const client = createParentTurnkeyClient(input.config);
  const poller = createActivityPoller({
    client,
    requestFn: client.createSubOrganization.bind(client),
  });

  const activity = await poller({
    type: "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V8",
    timestampMs: String(Date.now()),
    organizationId: input.config.turnkeyParentOrganizationId,
    parameters: {
      subOrganizationName: `real-${input.appUserId}-${Date.now()}`,
      rootQuorumThreshold: 1,
      rootUsers: [
        {
          userName: "end-user",
          apiKeys: [],
          authenticators: [
            {
              authenticatorName: "user-passkey",
              challenge: input.challengeBase64Url,
              attestation: {
                credentialId: input.registration.id,
                clientDataJson: input.registration.response.clientDataJSON,
                attestationObject: input.registration.response.attestationObject,
                transports: (input.registration.response.transports ?? ["internal"]).map(toTurnkeyTransport),
              },
            },
          ],
          oauthProviders: [],
        },
      ],
      wallet: {
        walletName: "owner",
        accounts: [REAL_WALLET_ACCOUNT],
      },
      disableEmailAuth: true,
      disableEmailRecovery: true,
      disableSmsAuth: true,
      disableOtpEmailAuth: true,
    },
  });

  const result = activity.result.createSubOrganizationResultV8;
  const subOrganizationId = result?.subOrganizationId;
  const turnkeyUserId = result?.rootUserIds?.[0];
  const walletId = result?.wallet?.walletId;
  const ownerAddress = result?.wallet?.addresses?.[0];
  if (!subOrganizationId || !turnkeyUserId || !walletId || !ownerAddress) {
    throw new Error("Turnkey createSubOrganization did not return a complete child wallet.");
  }

  // createSubOrganization's own result only returns the derived address, not
  // the walletAccountId — one follow-up read against the just-created
  // sub-org (still parent-key-stamped, still no browser WebAuthn involved).
  const walletAccountId = await findWalletAccountId({
    config: input.config,
    subOrganizationId,
    walletId,
    ownerAddress,
  });
  if (!walletAccountId) {
    throw new Error("Provisioned wallet account could not be located after creation.");
  }

  return { subOrganizationId, turnkeyUserId, walletId, walletAccountId, ownerAddress };
}

async function findWalletAccountId(input: {
  config: RealServerConfig;
  subOrganizationId: string;
  walletId: string;
  ownerAddress: string;
}): Promise<string | null> {
  const client = createParentTurnkeyClient(input.config);
  const { accounts } = await client.getWalletAccounts({
    organizationId: input.subOrganizationId,
    walletId: input.walletId,
  });
  const match = accounts.find((account) => account.address?.toLowerCase() === input.ownerAddress.toLowerCase());
  return match?.walletAccountId ?? null;
}
