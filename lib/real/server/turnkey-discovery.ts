import { createParentTurnkeyClient } from "./turnkey-provisioning";
import type { RealServerConfig } from "./config";

export type TurnkeyDiscoveryMatch = {
  subOrganizationId: string;
  userId: string | null;
  walletId: string | null;
  walletAccountId: string | null;
  ownerAddress: string | null;
};

export type TurnkeyDiscoveryResult =
  | { outcome: "no_match" }
  | { outcome: "ambiguous_suborg"; subOrganizationIds: string[] }
  | { outcome: "ambiguous_wallet_account"; subOrganizationId: string; candidateAddresses: string[] }
  | { outcome: "match"; match: TurnkeyDiscoveryMatch };

/**
 * SERVER-ONLY, parent-key-stamped, read-only. This is reconciliation and
 * migration-sanity tooling — "does Turnkey's own record of this credential
 * agree with our registry" — never a login path. It must never be sufficient
 * by itself to mint an app session: nothing in server/session.ts or the
 * login route calls this. It never assumes exactly one match at any level
 * (sub-org or wallet account) and never picks "the first" when there is
 * more than one — ambiguity is reported, not resolved silently.
 */
export async function discoverAccountByCredentialId(input: {
  config: RealServerConfig;
  credentialId: string;
}): Promise<TurnkeyDiscoveryResult> {
  const client = createParentTurnkeyClient(input.config);
  const { organizationIds } = await client.getSubOrgIds({
    organizationId: input.config.turnkeyParentOrganizationId,
    filterType: "CREDENTIAL_ID",
    filterValue: input.credentialId,
  });

  if (organizationIds.length === 0) return { outcome: "no_match" };
  if (organizationIds.length > 1) return { outcome: "ambiguous_suborg", subOrganizationIds: organizationIds };

  const subOrganizationId = organizationIds[0]!;
  const [users, walletAccounts] = await Promise.all([
    client.getUsers({ organizationId: subOrganizationId }),
    client.getWalletAccounts({ organizationId: subOrganizationId }),
  ]);

  const userId = users.users?.[0]?.userId ?? null;
  const accounts = walletAccounts.accounts ?? [];

  if (accounts.length === 0) {
    return { outcome: "match", match: { subOrganizationId, userId, walletId: null, walletAccountId: null, ownerAddress: null } };
  }
  if (accounts.length > 1) {
    return {
      outcome: "ambiguous_wallet_account",
      subOrganizationId,
      candidateAddresses: accounts.flatMap((account) => (account.address ? [account.address] : [])),
    };
  }

  const account = accounts[0]!;
  return {
    outcome: "match",
    match: {
      subOrganizationId,
      userId,
      walletId: account.walletId ?? null,
      walletAccountId: account.walletAccountId ?? null,
      ownerAddress: account.address ?? null,
    },
  };
}
