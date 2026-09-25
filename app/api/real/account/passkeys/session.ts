import { cookies } from "next/headers";
import { readAuthenticatedRealAccount, type AuthenticatedRealAccount } from "@/lib/real/server/auth";
import type { RealServerConfig } from "@/lib/real/server/config";
import { getRealAccountRegistry } from "@/lib/real/server/runtime";
import { REAL_SESSION_COOKIE_NAME } from "@/lib/real/server/session";

/**
 * Every passkey-management route requires a live app session. The session
 * only identifies the account and WHICH credential signed in — it never
 * authorizes a Turnkey mutation (that always needs a fresh child WebAuthn
 * stamp, verified server-side against that same session credential).
 */
export async function readPasskeySession(config: RealServerConfig): Promise<AuthenticatedRealAccount | null> {
  const store = await cookies();
  return readAuthenticatedRealAccount({
    cookieValue: store.get(REAL_SESSION_COOKIE_NAME)?.value,
    sessionSecret: config.sessionSecret,
    registry: getRealAccountRegistry(),
  });
}
