import type { RealAccountRecord, RealAccountRegistry } from "./registry";
import { parseSession, type RealSessionPayload } from "./session";

export type AuthenticatedRealAccount = {
  session: RealSessionPayload;
  account: RealAccountRecord;
};

/**
 * The one place "does this cookie value grant access" is decided. A valid
 * signature and unexpired exp are necessary but not sufficient: the
 * credential the session was issued for must still be active in the
 * registry — revokePasskey immediately invalidates every session that
 * credential ever issued, with no separate session-revocation list to
 * maintain — and must still belong to the same appUserId the session names.
 * None of this ever authorizes wallet signing; it only identifies which
 * account's public state the caller may read.
 */
export async function readAuthenticatedRealAccount(input: {
  cookieValue: string | undefined | null;
  sessionSecret: string;
  registry: RealAccountRegistry;
}): Promise<AuthenticatedRealAccount | null> {
  const session = parseSession(input.cookieValue, input.sessionSecret);
  if (!session) return null;

  const passkey = await input.registry.findPasskeyByCredentialId(session.credentialId);
  if (!passkey || passkey.status !== "active" || passkey.appUserId !== session.appUserId) return null;

  const account = await input.registry.findAccountByAppUserId(session.appUserId);
  if (!account) return null;

  return { session, account };
}
