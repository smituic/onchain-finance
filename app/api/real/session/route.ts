import { cookies } from "next/headers";
import { disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, requireRealServerConfig } from "@/lib/real/server/http";
import { readAuthenticatedRealAccount } from "@/lib/real/server/auth";
import { readAccountProfileBestEffort } from "@/lib/real/server/handle-claim";
import { getAccountHandleStore, getRealAccountRegistry } from "@/lib/real/server/runtime";
import { REAL_SESSION_COOKIE_NAME } from "@/lib/real/server/session";

export async function GET() {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const store = await cookies();
    const cookieValue = store.get(REAL_SESSION_COOKIE_NAME)?.value;
    const authenticated = await readAuthenticatedRealAccount({
      cookieValue,
      sessionSecret: config.sessionSecret,
      registry: getRealAccountRegistry(),
    });
    if (!authenticated) {
      // A cookie that no longer grants access (legacy version, expired,
      // revoked credential, older epoch, tampered) is cleared rather than
      // resent on every request. Registry/database errors throw instead and
      // land in the 500 below, so a transient failure never clears a
      // cookie that is still valid.
      if (cookieValue !== undefined) store.delete(REAL_SESSION_COOKIE_NAME);
      return Response.json({ authenticated: false });
    }
    // Human-readable identity is looked up here, for the response only — it is
    // never in the session cookie and auth.ts never reads it. Best-effort: the
    // session is already authenticated above, and a failure to read this
    // presentation metadata never signs anyone out or fails the check.
    const profile = await readAccountProfileBestEffort({ handles: getAccountHandleStore, appUserId: authenticated.account.appUserId });
    return Response.json({
      authenticated: true,
      appUserId: authenticated.account.appUserId,
      ownerAddress: authenticated.account.ownerAddress,
      safeAddress: authenticated.account.safeAddress,
      handle: profile.handle,
      displayName: profile.displayName,
    });
  } catch {
    return jsonInternalError();
  }
}

/**
 * "Sign out everywhere" (S4) — ACCOUNT-WIDE, not just this browser. Order
 * matters: the account's session epoch is incremented FIRST, which makes
 * every session ever issued for the account (this one included) invalid
 * server-side; only then is this browser's cookie cleared. If clearing the
 * cookie fails, every token is still dead — GET above clears the leftover
 * on the next check. If the increment fails, nothing was revoked, so the
 * cookie is left alone and the caller gets an error, never a false success.
 */
export async function DELETE() {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const store = await cookies();
    const cookieValue = store.get(REAL_SESSION_COOKIE_NAME)?.value;
    const registry = getRealAccountRegistry();
    const authenticated = await readAuthenticatedRealAccount({ cookieValue, sessionSecret: config.sessionSecret, registry });
    if (!authenticated) {
      if (cookieValue !== undefined) store.delete(REAL_SESSION_COOKIE_NAME);
      return jsonError("Not authenticated.", 401);
    }

    const sessionEpoch = await registry.incrementSessionEpoch(authenticated.account.appUserId);
    if (sessionEpoch === null) return jsonInternalError();

    try {
      store.delete(REAL_SESSION_COOKIE_NAME);
    } catch {
      // The account-wide sign-out already happened; see the doc comment.
    }
    return Response.json({ authenticated: false, signedOutEverywhere: true });
  } catch {
    return jsonInternalError();
  }
}
