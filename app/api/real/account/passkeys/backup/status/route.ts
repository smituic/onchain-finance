import { disabledResponse, isRealModeEnabled, jsonError, jsonInternalError, requireRealServerConfig } from "@/lib/real/server/http";
import { getActiveBackupEnrollment } from "@/lib/real/server/backup-passkey-pipeline";
import { getBackupPasskeyEnrollmentStore } from "@/lib/real/server/runtime";
import { readPasskeySession } from "@/app/api/real/account/passkeys/session";

/** Resume source of truth: the durable enrollment row's position, never anything the browser remembered. */
export async function GET() {
  if (!isRealModeEnabled()) return disabledResponse();
  try {
    const config = requireRealServerConfig();
    const authenticated = await readPasskeySession(config);
    if (!authenticated) return jsonError("Not authenticated.", 401);
    const enrollment = await getActiveBackupEnrollment({ enrollments: getBackupPasskeyEnrollmentStore(), appUserId: authenticated.account.appUserId });
    return Response.json({ enrollment });
  } catch {
    return jsonInternalError();
  }
}
