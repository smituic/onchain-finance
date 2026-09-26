import { disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, requireRealServerConfig } from "@/lib/real/server/http";
import { prepareBackupStepUp } from "@/lib/real/server/backup-passkey-pipeline";
import { getChallengeStore, getRealAccountRegistry } from "@/lib/real/server/runtime";
import { readPasskeySession } from "@/app/api/real/account/passkeys/session";

/**
 * 2g-H step-up: sign-in options scoped to the CURRENT SESSION CREDENTIAL
 * only. Its fresh assertion is required by /backup/options before any backup
 * registration challenge is minted — an app cookie alone never gets one.
 */
export async function POST() {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const authenticated = await readPasskeySession(config);
    if (!authenticated) return jsonError("Not authenticated.", 401);
    const result = await prepareBackupStepUp({
      config,
      challengeStore: getChallengeStore(),
      registry: getRealAccountRegistry(),
      appUserId: authenticated.account.appUserId,
      sessionCredentialId: authenticated.session.credentialId,
    });
    if (result.outcome === "rejected") return jsonError(result.reason, 400);
    return Response.json({ optionsJSON: result.optionsJSON });
  } catch {
    return jsonInternalError();
  }
}
