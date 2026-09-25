import { disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, requireRealServerConfig } from "@/lib/real/server/http";
import { getPasskeyRevocationStore, getRealAccountRegistry } from "@/lib/real/server/runtime";
import { readPasskeySession } from "@/app/api/real/account/passkeys/session";

/**
 * Read-only. Every passkey on the session's own account plus, where one
 * exists, the latest removal attempt's truthful state. Never a public key,
 * signed request, stamp, or anything signing-relevant. Revoked passkeys are
 * omitted — they stay in the database as audit history (and are referenced
 * by their removal attempts), but a confirmed removal is finished and an
 * abandoned setup never reached Turnkey. Pending and revoking rows are live
 * operations and stay visible.
 */
export async function GET() {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const authenticated = await readPasskeySession(config);
    if (!authenticated) return jsonError("Not authenticated.", 401);

    const appUserId = authenticated.account.appUserId;
    const [passkeys, attempts] = await Promise.all([getRealAccountRegistry().findPasskeysByAppUserId(appUserId), getPasskeyRevocationStore().findLatestPerTarget(appUserId)]);
    const latestByTarget = new Map(attempts.map((a) => [a.targetCredentialId, a]));

    return Response.json({
      passkeys: passkeys
        .filter((p) => p.status !== "revoked")
        .map((p) => {
          const attempt = latestByTarget.get(p.credentialId);
          return {
            credentialId: p.credentialId,
            role: p.role,
            displayName: p.displayName,
            status: p.status,
            credentialDeviceType: p.credentialDeviceType,
            credentialBackedUp: p.credentialBackedUp,
            createdAt: p.createdAt,
            isCurrentSession: p.credentialId === authenticated.session.credentialId,
            canAuthorizeRemovals: p.status === "active" && p.turnkeyAuthenticatorId !== null,
            removal: attempt && attempt.state !== "cancelled" ? { attemptId: attempt.id, state: attempt.state, ownedBySession: attempt.authorizerCredentialId === authenticated.session.credentialId } : null,
          };
        }),
    });
  } catch {
    return jsonInternalError();
  }
}
