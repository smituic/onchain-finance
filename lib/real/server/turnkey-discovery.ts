import { credentialIdsEqual } from "../credential-id";
import { createParentTurnkeyClient } from "./turnkey-provisioning";
import { summarizeActivity, type TurnkeyActivitySummary } from "./turnkey-signed-request";
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

export type TurnkeyUserAuthenticator = { authenticatorId: string; credentialId: string; publicKey: string };

/**
 * SERVER-ONLY, parent-key-stamped, READ-ONLY: the current authenticators of
 * exactly one Turnkey user in one child sub-organization, or null if that
 * user isn't present in the response. Parent-key authority here is the
 * same read access turnkey-discovery already had (getUsers) — it never
 * creates, deletes, or approves anything.
 */
export async function listTurnkeyUserAuthenticators(input: {
  config: RealServerConfig;
  subOrganizationId: string;
  turnkeyUserId: string;
}): Promise<TurnkeyUserAuthenticator[] | null> {
  const client = createParentTurnkeyClient(input.config);
  const { users } = await client.getUsers({ organizationId: input.subOrganizationId });
  const user = (users ?? []).find((candidate) => candidate.userId === input.turnkeyUserId);
  if (!user) return null;
  return (user.authenticators ?? []).map((authenticator) => ({
    authenticatorId: authenticator.authenticatorId,
    credentialId: authenticator.credentialId,
    publicKey: authenticator.credential?.publicKey ?? "",
  }));
}

export type AuthenticatorMatch =
  | { outcome: "found"; authenticator: TurnkeyUserAuthenticator }
  | { outcome: "not_found" }
  | { outcome: "ambiguous"; authenticatorIds: string[] }
  | { outcome: "user_not_found" };

/**
 * Matches by DECODED CREDENTIAL-ID BYTES (credential-id.ts), never raw
 * string equality — Turnkey's and WebAuthn's encodings of the same id need
 * not be byte-identical strings. More than one match is reported, never
 * resolved silently. "not_found" is a single read with no read-after-write
 * guarantee: callers must never treat it as proof something was or wasn't
 * created/deleted on its own.
 */
export function matchAuthenticatorByCredentialId(authenticators: TurnkeyUserAuthenticator[] | null, credentialId: string): AuthenticatorMatch {
  if (!authenticators) return { outcome: "user_not_found" };
  const matches = authenticators.filter((authenticator) => credentialIdsEqual(authenticator.credentialId, credentialId));
  if (matches.length === 0) return { outcome: "not_found" };
  if (matches.length > 1) return { outcome: "ambiguous", authenticatorIds: matches.map((m) => m.authenticatorId) };
  return { outcome: "found", authenticator: matches[0]! };
}

/** The one comparison form for Turnkey public keys (a vote's `publicKey` vs an authenticator's `credential.publicKey`) — both are Turnkey-reported strings; anything else is "". */
export function normalizeTurnkeyPublicKey(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** SERVER-ONLY, parent-key-stamped, READ-ONLY poll of one child activity — never a resubmission of the mutation it describes. Returns null on any read failure (the caller stays pending). */
export async function readTurnkeyActivity(input: { config: RealServerConfig; subOrganizationId: string; activityId: string }): Promise<TurnkeyActivitySummary | null> {
  try {
    const client = createParentTurnkeyClient(input.config);
    const response = await client.getActivity({ organizationId: input.subOrganizationId, activityId: input.activityId });
    return summarizeActivity(response.activity);
  } catch {
    return null;
  }
}
