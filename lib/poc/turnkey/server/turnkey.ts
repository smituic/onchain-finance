import { ApiKeyStamper } from "@turnkey/api-key-stamper";
import { TurnkeyClient, createActivityPoller } from "@turnkey/http";
import { ETHEREUM_WALLET_ACCOUNT } from "../constants";
import type { ServerTurnkeyPocConfig } from "../config";
import type { PublicAuthenticator } from "../public-state";
import type { ChildConfigEvidence } from "../security-gate";

export function createParentTurnkeyClient(config: ServerTurnkeyPocConfig): TurnkeyClient {
  return new TurnkeyClient(
    { baseUrl: config.apiBaseUrl },
    new ApiKeyStamper({
      apiPublicKey: config.apiPublicKey,
      apiPrivateKey: config.apiPrivateKey,
    }),
  );
}

export async function provisionChildSubOrganization(input: {
  config: ServerTurnkeyPocConfig;
  /** Base64url (no padding) — must equal clientDataJSON.challenge from the attestation. */
  challengeBase64Url: string;
  attestation: {
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
}): Promise<{
  subOrganizationId: string;
  userId: string;
  walletId: string;
  ownerAddress: string;
  authenticators: PublicAuthenticator[];
  child: ChildConfigEvidence;
}> {
  const client = createParentTurnkeyClient(input.config);
  const poller = createActivityPoller({
    client,
    requestFn: client.createSubOrganization.bind(client),
  });

  const activity = await poller({
    type: "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V8",
    timestampMs: String(Date.now()),
    organizationId: input.config.parentOrganizationId,
    parameters: {
      subOrganizationName: `ocf-turnkey-poc-${Date.now()}`,
      rootQuorumThreshold: 1,
      rootUsers: [
        {
          userName: "end-user",
          apiKeys: [],
          authenticators: [
            {
              authenticatorName: "user-passkey",
              challenge: input.challengeBase64Url,
              attestation: input.attestation,
            },
          ],
          oauthProviders: [],
        },
      ],
      wallet: {
        walletName: "owner",
        accounts: [ETHEREUM_WALLET_ACCOUNT],
      },
      disableEmailAuth: true,
      disableEmailRecovery: true,
      disableSmsAuth: true,
      disableOtpEmailAuth: true,
    },
  });

  const result = activity.result.createSubOrganizationResultV8;
  const subOrganizationId = result?.subOrganizationId;
  const userId = result?.rootUserIds?.[0];
  const walletId = result?.wallet?.walletId;
  const ownerAddress = result?.wallet?.addresses?.[0];
  if (!subOrganizationId || !userId || !walletId || !ownerAddress) {
    throw new Error("Turnkey createSubOrganization did not return a complete child wallet.");
  }

  const inspection = await inspectChildOrganization({
    config: input.config,
    subOrganizationId,
    walletId,
    expectedUserId: userId,
  });

  return {
    subOrganizationId,
    userId,
    walletId,
    ownerAddress,
    authenticators: inspection.authenticators,
    child: inspection.child,
  };
}

/**
 * The canonical, exact-case address Turnkey holds for this wallet's
 * Ethereum account — re-derived from the existing sub-org/wallet via
 * Turnkey's own getWalletAccounts, never from anything the app has cached.
 * Use this to recover from a locally-corrupted (e.g. lowercased) address
 * without provisioning a new child org or authenticator.
 */
export async function getCanonicalOwnerAddress(input: {
  config: ServerTurnkeyPocConfig;
  subOrganizationId: string;
  walletId: string;
}): Promise<string | null> {
  const client = createParentTurnkeyClient(input.config);
  const { accounts } = await client.getWalletAccounts({
    organizationId: input.subOrganizationId,
    walletId: input.walletId,
  });
  const account =
    accounts.find(
      (candidate) =>
        candidate.path === ETHEREUM_WALLET_ACCOUNT.path && candidate.curve === ETHEREUM_WALLET_ACCOUNT.curve,
    ) ?? accounts[0];
  return account?.address ?? null;
}

export type WalletAccountMatch = {
  found: boolean;
  walletAccountId: string | null;
  walletId: string | null;
  path: string | null;
  curve: string | null;
  isKnownWallet: boolean;
};

/**
 * Read-only: searches EVERY wallet account across this child sub-org (not
 * just the one Ethereum account normally used) for a case-insensitive
 * address match. Creates and signs nothing. Used to determine whether an
 * unexpected recovered signer address belongs to this wallet, a different
 * account within the same sub-org, or is not a Turnkey account at all.
 */
export async function findWalletAccountByAddress(input: {
  config: ServerTurnkeyPocConfig;
  subOrganizationId: string;
  knownWalletId: string;
  address: string;
}): Promise<WalletAccountMatch> {
  const client = createParentTurnkeyClient(input.config);
  const { accounts } = await client.getWalletAccounts({
    organizationId: input.subOrganizationId,
  });

  const target = input.address.toLowerCase();
  const match = accounts.find((candidate) => candidate.address?.toLowerCase() === target);

  if (!match) {
    return { found: false, walletAccountId: null, walletId: null, path: null, curve: null, isKnownWallet: false };
  }

  return {
    found: true,
    walletAccountId: match.walletAccountId,
    walletId: match.walletId,
    path: match.path,
    curve: match.curve,
    isKnownWallet: match.walletId === input.knownWalletId,
  };
}

export async function inspectChildOrganization(input: {
  config: ServerTurnkeyPocConfig;
  subOrganizationId: string;
  walletId: string;
  expectedUserId?: string;
}): Promise<{
  authenticators: PublicAuthenticator[];
  child: ChildConfigEvidence;
  users: Array<{ userId: string; userName: string; apiKeyCount: number; authenticatorCount: number; oauthProviderCount: number }>;
  ownerAddress: string | null;
}> {
  const client = createParentTurnkeyClient(input.config);
  const [organization, users, ownerAddress] = await Promise.all([
    client.getOrganization({ organizationId: input.subOrganizationId }),
    client.getUsers({ organizationId: input.subOrganizationId }),
    getCanonicalOwnerAddress({ config: input.config, subOrganizationId: input.subOrganizationId, walletId: input.walletId }),
  ]);

  const rootQuorum = organization.organizationData.rootQuorum;
  const listedUsers = users.users ?? [];
  const authenticators: PublicAuthenticator[] = [];

  for (const user of listedUsers) {
    const details = await client.getAuthenticators({
      organizationId: input.subOrganizationId,
      userId: user.userId,
    });
    for (const authenticator of details.authenticators ?? []) {
      authenticators.push({
        authenticatorId: authenticator.authenticatorId,
        authenticatorName: authenticator.authenticatorName,
        credentialId: authenticator.credentialId,
        transports: authenticator.transports ?? [],
      });
    }
  }

  const apiKeyCount = listedUsers.reduce((sum, user) => sum + (user.apiKeys?.length ?? 0), 0);
  const oauthProviderCount = listedUsers.reduce((sum, user) => sum + (user.oauthProviders?.length ?? 0), 0);
  const sessionCredentialCount = listedUsers.reduce((sum, user) => {
    const fromKeys = (user.apiKeys ?? []).filter((key) =>
      key.credential?.type === "CREDENTIAL_TYPE_READ_WRITE_SESSION_KEY_P256" ||
      key.credential?.type === "CREDENTIAL_TYPE_LOGIN" ||
      key.credential?.type === "CREDENTIAL_TYPE_OTP_AUTH_KEY_P256" ||
      key.credential?.type === "CREDENTIAL_TYPE_EMAIL_AUTH_KEY_P256" ||
      key.credential?.type === "CREDENTIAL_TYPE_OAUTH_KEY_P256",
    ).length;
    return sum + fromKeys;
  }, 0);
  const backendApiKeyOnChild = listedUsers.some((user) =>
    (user.apiKeys ?? []).some((key) => key.credential?.publicKey === input.config.apiPublicKey),
  );

  return {
    authenticators,
    child: {
      rootUserCount: rootQuorum?.userIds?.length ?? listedUsers.length,
      rootUserIds: rootQuorum?.userIds ?? listedUsers.map((user) => user.userId),
      rootThreshold: rootQuorum?.threshold ?? 0,
      authenticatorCount: authenticators.length,
      apiKeyCount,
      oauthProviderCount,
      sessionCredentialCount,
      backendApiKeyOnChild,
      extraRootUsers: (rootQuorum?.userIds?.length ?? listedUsers.length) !== 1,
    },
    ownerAddress,
    users: listedUsers.map((user) => ({
      userId: user.userId,
      userName: user.userName,
      apiKeyCount: user.apiKeys?.length ?? 0,
      authenticatorCount: user.authenticators?.length ?? 0,
      oauthProviderCount: user.oauthProviders?.length ?? 0,
    })),
  };
}

export type NegativeTestResult = {
  name: string;
  attempted: string;
  failedAsExpected: boolean;
  error: string | null;
};

export async function runBackendNegativeTests(input: {
  config: ServerTurnkeyPocConfig;
  subOrganizationId: string;
  userId: string;
  walletId: string;
  ownerAddress: string;
}): Promise<NegativeTestResult[]> {
  const client = createParentTurnkeyClient(input.config);
  const attempts: Array<{ name: string; attempted: string; run: () => Promise<unknown> }> = [
    {
      name: "signRawPayload",
      attempted: "Sign as the child's Ethereum owner using the parent API key",
      run: () =>
        client.signRawPayload({
          type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
          timestampMs: String(Date.now()),
          organizationId: input.subOrganizationId,
          parameters: {
            signWith: input.ownerAddress,
            payload: "00",
            encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
            hashFunction: "HASH_FUNCTION_NO_OP",
          },
        }),
    },
    {
      name: "createApiKeys",
      attempted: "Add the parent API public key as a child signing credential",
      run: () =>
        client.createApiKeys({
          type: "ACTIVITY_TYPE_CREATE_API_KEYS_V2",
          timestampMs: String(Date.now()),
          organizationId: input.subOrganizationId,
          parameters: {
            userId: input.userId,
            apiKeys: [
              {
                apiKeyName: "parent-must-not-be-added",
                publicKey: input.config.apiPublicKey,
                curveType: "API_KEY_CURVE_P256",
              },
            ],
          },
        }),
    },
    {
      name: "updateRootQuorum",
      attempted: "Alter the child root quorum from the parent credential",
      run: () =>
        client.updateRootQuorum({
          type: "ACTIVITY_TYPE_UPDATE_ROOT_QUORUM",
          timestampMs: String(Date.now()),
          organizationId: input.subOrganizationId,
          parameters: {
            threshold: 1,
            userIds: [input.userId],
          },
        }),
    },
    {
      name: "exportWallet",
      attempted: "Export the child's wallet mnemonic",
      run: () =>
        client.exportWallet({
          type: "ACTIVITY_TYPE_EXPORT_WALLET",
          timestampMs: String(Date.now()),
          organizationId: input.subOrganizationId,
          parameters: {
            walletId: input.walletId,
            targetPublicKey: input.config.apiPublicKey,
          },
        }),
    },
  ];

  const results: NegativeTestResult[] = [];
  for (const attempt of attempts) {
    try {
      await attempt.run();
      results.push({
        name: attempt.name,
        attempted: attempt.attempted,
        failedAsExpected: false,
        error: null,
      });
    } catch (error) {
      results.push({
        name: attempt.name,
        attempted: attempt.attempted,
        failedAsExpected: true,
        error: error instanceof Error ? error.message : "rejected",
      });
    }
  }
  return results;
}
