import { randomUUID } from "node:crypto";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import { isGuardAbort, isUniqueViolation } from "./neon-store";
import { getInMemoryRevocationInternals, type PasskeyRevocationAttempt, type PasskeyRevocationStore, type RevocationAttemptState } from "./passkey-revocation-attempts";
import { getInMemoryRegistryInternals, type RealAccountRegistry } from "./registry";
import { sha256Hex } from "./turnkey-signed-request";

/**
 * S3 — the durable side of the OPERATOR-ONLY blocked-removal resolver
 * (passkey-revocation-resolver.ts). Never wired into runtime.ts or any route:
 * constructed only by the env-gated admin runner
 * (test/admin/resolve-passkey-revocation.admin.test.ts) and by tests.
 *
 * commitResolution is the ONE multi-row write. It locks the account row
 * FIRST (the same boundary as beginDispatch / confirmDeleted / activate),
 * re-checks every local fact the resolver relied on, then — together or not
 * at all — moves the blocked attempt to 'confirmed' (state + updated_at ONLY;
 * its own activity id/status and failure reason are never touched), the
 * target 'revoking' -> 'revoked', a pending-origin enrollment
 * 'removal_in_progress' -> 'removed', promotes a survivor exactly like
 * confirmDeleted, and appends one passkey_revocation_resolutions row. It never
 * reuses confirmDeleted — that path overwrites the activity status. No stamp,
 * body, or signing material is read into the snapshot except the stored
 * DELETE body text, which is public request data needed to re-hash it.
 */

export type ResolutionAttemptRow = {
  id: string;
  appUserId: string;
  targetCredentialId: string;
  targetTurnkeyAuthenticatorId: string;
  state: RevocationAttemptState;
  turnkeyRequestBody: string | null;
  turnkeyRequestBodySha256: string | null;
  turnkeyActivityId: string | null;
  turnkeyActivityStatus: string | null;
  failureReason: string | null;
};

export type ResolutionPasskeyRow = { credentialId: string; appUserId: string; status: string; role: string; turnkeyAuthenticatorId: string | null };

export type ResolutionSnapshot = {
  account: { appUserId: string; subOrganizationId: string; turnkeyUserId: string };
  attempt: ResolutionAttemptRow;
  /** Every attempt naming the target credential (any state), oldest first. */
  targetAttempts: ResolutionAttemptRow[];
  /** A non-cancelled attempt for the target newer than `attempt` by (created_at, id). */
  hasNewerNonCancelledAttempt: boolean;
  targetPasskey: ResolutionPasskeyRow | null;
  accountPasskeys: ResolutionPasskeyRow[];
  targetEnrollments: Array<{ id: string; appUserId: string; state: string }>;
  existingResolutionId: string | null;
};

export type ReceiptSource = "own_attempt" | "stored_attempt_body";

export type CommitResolutionInput = {
  appUserId: string;
  attemptId: string;
  targetCredentialId: string;
  targetTurnkeyAuthenticatorId: string;
  /** The attempt's own fields as the resolver read them — the commit refuses if any changed, and never writes them. */
  expected: { turnkeyActivityId: string | null; turnkeyActivityStatus: string | null; failureReason: string | null };
  receipt: { activityId: string; source: ReceiptSource; bodyAttemptId: string; bodySha256: string; turnkeyCreatedAt: string };
  activityLogHeadId: string;
  absenceFirstObservedAt: string;
  absenceLastObservedAt: string;
  survivorAuthenticatorIds: string[];
  resolverVersion: number;
};

export type CommitResolutionResult = { outcome: "committed"; resolutionId: string } | { outcome: "lost_race" };

export type ResolutionRecord = {
  id: string;
  revocationAttemptId: string;
  appUserId: string;
  targetCredentialId: string;
  targetTurnkeyAuthenticatorId: string;
  originalFailureReason: string | null;
  receiptActivityId: string;
  receiptSource: ReceiptSource;
  receiptBodyAttemptId: string;
  receiptBodySha256: string;
  receiptTurnkeyCreatedAt: string;
  activityLogHeadId: string;
  absenceFirstObservedAt: string;
  absenceLastObservedAt: string;
  observedSurvivorAuthenticatorIds: string[];
  resolverVersion: number;
  createdAt: string;
};

export interface RevocationResolutionStore {
  /** Null if the attempt or the requested account doesn't exist. Read-only. */
  loadSnapshot(input: { appUserId: string; attemptId: string }): Promise<ResolutionSnapshot | null>;
  commitResolution(input: CommitResolutionInput): Promise<CommitResolutionResult>;
}

// ---------------------------------------------------------------- Neon

type Row = Record<string, unknown>;

function toAttemptRow(row: Row): ResolutionAttemptRow {
  return {
    id: row.id as string,
    appUserId: row.app_user_id as string,
    targetCredentialId: row.target_credential_id as string,
    targetTurnkeyAuthenticatorId: row.target_turnkey_authenticator_id as string,
    state: row.state as RevocationAttemptState,
    turnkeyRequestBody: (row.turnkey_request_body as string | null) ?? null,
    turnkeyRequestBodySha256: (row.turnkey_request_body_sha256 as string | null) ?? null,
    turnkeyActivityId: (row.turnkey_activity_id as string | null) ?? null,
    turnkeyActivityStatus: (row.turnkey_activity_status as string | null) ?? null,
    failureReason: (row.failure_reason as string | null) ?? null,
  };
}

function toPasskeyRow(row: Row): ResolutionPasskeyRow {
  return {
    credentialId: row.credential_id as string,
    appUserId: row.app_user_id as string,
    status: row.status as string,
    role: row.role as string,
    turnkeyAuthenticatorId: (row.turnkey_authenticator_id as string | null) ?? null,
  };
}

/** The guard SELECTs below spell this sentinel literally (same pattern as neon-store.ts). */
const RESOLUTION_GUARD = "revocation_resolution_mismatch";

/** Neon adapter for the admin runner only — never wired into runtime.ts or any route. */
export function createNeonRevocationResolutionStore(sql: NeonQueryFunction<false, false>): RevocationResolutionStore {
  return {
    async loadSnapshot({ appUserId, attemptId }) {
      // One READ ONLY, REPEATABLE READ transaction: every row below comes from one snapshot. The stamp column is never selected.
      const [accounts, attempts, targetAttempts, newer, targetPasskeys, accountPasskeys, enrollments, resolutions] = await sql.transaction(
        [
          sql`SELECT app_user_id, sub_organization_id, turnkey_user_id FROM real_accounts WHERE app_user_id = ${appUserId}`,
          sql`
            SELECT id, app_user_id, target_credential_id, target_turnkey_authenticator_id, state, turnkey_request_body, turnkey_request_body_sha256, turnkey_activity_id, turnkey_activity_status, failure_reason
            FROM passkey_revocation_attempts WHERE id = ${attemptId}
          `,
          sql`
            SELECT id, app_user_id, target_credential_id, target_turnkey_authenticator_id, state, turnkey_request_body, turnkey_request_body_sha256, turnkey_activity_id, turnkey_activity_status, failure_reason
            FROM passkey_revocation_attempts
            WHERE target_credential_id = (SELECT target_credential_id FROM passkey_revocation_attempts WHERE id = ${attemptId})
            ORDER BY created_at ASC, id ASC
          `,
          sql`
            SELECT EXISTS (
              SELECT 1 FROM passkey_revocation_attempts a JOIN passkey_revocation_attempts n ON n.target_credential_id = a.target_credential_id
              WHERE a.id = ${attemptId} AND n.id <> a.id AND n.state <> 'cancelled' AND (n.created_at, n.id) > (a.created_at, a.id)
            ) AS has_newer
          `,
          sql`
            SELECT credential_id, app_user_id, status, role, turnkey_authenticator_id FROM real_passkeys
            WHERE credential_id = (SELECT target_credential_id FROM passkey_revocation_attempts WHERE id = ${attemptId})
          `,
          sql`SELECT credential_id, app_user_id, status, role, turnkey_authenticator_id FROM real_passkeys WHERE app_user_id = ${appUserId} ORDER BY created_at ASC, credential_id ASC`,
          sql`
            SELECT id, app_user_id, state FROM backup_passkey_enrollments
            WHERE new_credential_id = (SELECT target_credential_id FROM passkey_revocation_attempts WHERE id = ${attemptId})
          `,
          sql`SELECT id FROM passkey_revocation_resolutions WHERE revocation_attempt_id = ${attemptId}`,
        ],
        { readOnly: true, isolationLevel: "RepeatableRead" },
      );
      const account = (accounts as Row[])[0];
      const attempt = (attempts as Row[])[0];
      if (!account || !attempt) return null;
      return {
        account: { appUserId: account.app_user_id as string, subOrganizationId: account.sub_organization_id as string, turnkeyUserId: account.turnkey_user_id as string },
        attempt: toAttemptRow(attempt),
        targetAttempts: (targetAttempts as Row[]).map(toAttemptRow),
        hasNewerNonCancelledAttempt: (newer as Row[])[0]?.has_newer === true,
        targetPasskey: (targetPasskeys as Row[])[0] ? toPasskeyRow((targetPasskeys as Row[])[0]!) : null,
        accountPasskeys: (accountPasskeys as Row[]).map(toPasskeyRow),
        targetEnrollments: (enrollments as Row[]).map((e) => ({ id: e.id as string, appUserId: e.app_user_id as string, state: e.state as string })),
        existingResolutionId: ((resolutions as Row[])[0]?.id as string | undefined) ?? null,
      };
    },

    async commitResolution(input) {
      const { appUserId, attemptId: id, targetCredentialId: cid, targetTurnkeyAuthenticatorId: tid, expected, receipt } = input;
      // Every statement after the claim is bound to THIS batch's claim by
      // `state = 'confirmed' AND updated_at = now()` — now() is the
      // transaction's start time, so a row confirmed by any other transaction
      // (another operator, an earlier run) never matches. A lost claim makes
      // every later statement and guard a no-op: nothing is written.
      const claimed = sql`a.id = ${id} AND a.state = 'confirmed' AND a.updated_at = now()`;
      try {
        const results = await sql.transaction([
          // 1. Account lock FIRST — the same serialization boundary as beginDispatch, confirmDeleted, and activate.
          sql`SELECT app_user_id FROM real_accounts WHERE app_user_id = ${appUserId} FOR UPDATE`,
          // 2. The claim: blocked -> confirmed, touching ONLY state and updated_at, under every local predicate.
          sql`
            UPDATE passkey_revocation_attempts a SET state = 'confirmed', updated_at = now()
            WHERE a.id = ${id} AND a.app_user_id = ${appUserId} AND a.state = 'blocked'
              AND a.target_credential_id = ${cid} AND a.target_turnkey_authenticator_id = ${tid}
              AND a.turnkey_activity_id IS NOT DISTINCT FROM ${expected.turnkeyActivityId}
              AND a.turnkey_activity_status IS NOT DISTINCT FROM ${expected.turnkeyActivityStatus}
              AND a.failure_reason IS NOT DISTINCT FROM ${expected.failureReason}
              AND EXISTS (
                SELECT 1 FROM real_passkeys t
                WHERE t.credential_id = ${cid} AND t.app_user_id = ${appUserId} AND t.status = 'revoking' AND t.turnkey_authenticator_id = ${tid}
              )
              AND NOT EXISTS (SELECT 1 FROM passkey_revocation_attempts d WHERE d.target_credential_id = ${cid} AND d.state = 'dispatch_in_flight')
              AND NOT EXISTS (
                SELECT 1 FROM passkey_revocation_attempts n
                WHERE n.target_credential_id = ${cid} AND n.id <> a.id AND n.state <> 'cancelled' AND (n.created_at, n.id) > (a.created_at, a.id)
              )
              AND EXISTS (
                SELECT 1 FROM real_passkeys s
                WHERE s.app_user_id = ${appUserId} AND s.credential_id <> ${cid} AND s.status = 'active' AND s.turnkey_authenticator_id IS NOT NULL
              )
              AND EXISTS (
                SELECT 1 FROM passkey_revocation_attempts b
                WHERE b.id = ${receipt.bodyAttemptId} AND b.app_user_id = ${appUserId}
                  AND b.target_credential_id = ${cid} AND b.target_turnkey_authenticator_id = ${tid}
                  AND b.state IN ('blocked', 'confirmed') AND b.turnkey_request_body IS NOT NULL
                  AND b.turnkey_request_body_sha256 = ${receipt.bodySha256}
                  AND encode(sha256(convert_to(b.turnkey_request_body, 'UTF8')), 'hex') = ${receipt.bodySha256}
              )
              AND NOT EXISTS (
                SELECT 1 FROM backup_passkey_enrollments e
                WHERE e.new_credential_id = ${cid} AND (e.app_user_id <> ${appUserId} OR e.state NOT IN ('removal_in_progress', 'active'))
              )
          `,
          // 3. Target revoking -> revoked.
          sql`
            UPDATE real_passkeys SET status = 'revoked'
            WHERE credential_id = (SELECT a.target_credential_id FROM passkey_revocation_attempts a WHERE ${claimed}) AND status = 'revoking'
          `,
          // 4. A pending-origin enrollment becomes terminal — the only point its one-open-enrollment slot frees.
          sql`
            UPDATE backup_passkey_enrollments SET state = 'removed', updated_at = now()
            WHERE new_credential_id = (SELECT a.target_credential_id FROM passkey_revocation_attempts a WHERE ${claimed})
              AND app_user_id = ${appUserId} AND state = 'removal_in_progress'
          `,
          // 5. Survivor promotion — exactly confirmDeleted's rule (role only).
          sql`
            UPDATE real_passkeys p SET role = 'primary'
            WHERE p.credential_id = (
                SELECT s.credential_id FROM real_passkeys s
                JOIN passkey_revocation_attempts a ON a.app_user_id = s.app_user_id
                WHERE ${claimed} AND s.status = 'active'
                ORDER BY s.created_at ASC, s.credential_id ASC LIMIT 1
              )
              AND p.role = 'backup'
              AND NOT EXISTS (SELECT 1 FROM real_passkeys q WHERE q.app_user_id = p.app_user_id AND q.role = 'primary' AND q.status <> 'revoked')
          `,
          // 6. Exactly one append-only audit row; original_failure_reason is copied from the row itself.
          sql`
            INSERT INTO passkey_revocation_resolutions (
              revocation_attempt_id, app_user_id, target_credential_id, target_turnkey_authenticator_id, original_failure_reason,
              receipt_activity_id, receipt_source, receipt_body_attempt_id, receipt_body_sha256, receipt_turnkey_created_at,
              activity_log_head_id, absence_first_observed_at, absence_last_observed_at, observed_survivor_authenticator_ids, resolver_version
            )
            SELECT a.id, a.app_user_id, a.target_credential_id, a.target_turnkey_authenticator_id, a.failure_reason,
              ${receipt.activityId}, ${receipt.source}, ${receipt.bodyAttemptId}::uuid, ${receipt.bodySha256}, ${receipt.turnkeyCreatedAt}::timestamptz,
              ${input.activityLogHeadId}, ${input.absenceFirstObservedAt}::timestamptz, ${input.absenceLastObservedAt}::timestamptz, ${input.survivorAuthenticatorIds}::text[], ${input.resolverVersion}
            FROM passkey_revocation_attempts a WHERE ${claimed}
            RETURNING id
          `,
          // 7. Rollback guards (22P02 aborts the WHOLE batch) — confirmDeleted's, plus S3's.
          sql`
            SELECT (a.state || ':revocation_resolution_mismatch')::int FROM passkey_revocation_attempts a
            WHERE ${claimed} AND NOT EXISTS (SELECT 1 FROM real_passkeys p WHERE p.credential_id = a.target_credential_id AND p.status = 'revoked')
          `,
          sql`
            SELECT (a.state || ':revocation_resolution_mismatch')::int FROM passkey_revocation_attempts a
            WHERE ${claimed} AND EXISTS (SELECT 1 FROM backup_passkey_enrollments e WHERE e.new_credential_id = a.target_credential_id AND e.state = 'removal_in_progress')
          `,
          sql`
            SELECT (a.state || ':revocation_resolution_mismatch')::int FROM passkey_revocation_attempts a
            WHERE ${claimed}
              AND EXISTS (SELECT 1 FROM real_passkeys p WHERE p.app_user_id = a.app_user_id AND p.status = 'active')
              AND NOT EXISTS (SELECT 1 FROM real_passkeys p WHERE p.app_user_id = a.app_user_id AND p.role = 'primary' AND p.status <> 'revoked')
          `,
          sql`
            SELECT (a.state || ':revocation_resolution_mismatch')::int FROM passkey_revocation_attempts a
            WHERE ${claimed} AND NOT EXISTS (SELECT 1 FROM real_passkeys p WHERE p.app_user_id = a.app_user_id AND p.status = 'active')
          `,
          sql`
            SELECT (a.state || ':revocation_resolution_mismatch')::int FROM passkey_revocation_attempts a
            WHERE ${claimed} AND NOT EXISTS (SELECT 1 FROM passkey_revocation_resolutions r WHERE r.revocation_attempt_id = a.id)
          `,
          sql`
            SELECT (a.state || ':revocation_resolution_mismatch')::int FROM passkey_revocation_attempts a
            WHERE ${claimed}
              AND (a.turnkey_activity_id IS DISTINCT FROM ${expected.turnkeyActivityId}
                OR a.turnkey_activity_status IS DISTINCT FROM ${expected.turnkeyActivityStatus}
                OR a.failure_reason IS DISTINCT FROM ${expected.failureReason})
          `,
          sql`
            SELECT (a.state || ':revocation_resolution_mismatch')::int FROM passkey_revocation_attempts a
            WHERE ${claimed} AND NOT EXISTS (
              SELECT 1 FROM passkey_revocation_attempts b
              WHERE b.id = ${receipt.bodyAttemptId} AND b.turnkey_request_body_sha256 = ${receipt.bodySha256}
                AND encode(sha256(convert_to(b.turnkey_request_body, 'UTF8')), 'hex') = ${receipt.bodySha256}
            )
          `,
        ]);
        const inserted = results[5] as Row[];
        return inserted[0] ? { outcome: "committed", resolutionId: inserted[0].id as string } : { outcome: "lost_race" };
      } catch (error) {
        if (isGuardAbort(error, RESOLUTION_GUARD) || isUniqueViolation(error, "passkey_revocation_resolutions")) return { outcome: "lost_race" };
        throw error;
      }
    },
  };
}

// ---------------------------------------------------------------- in-memory

/**
 * Mirrors the Neon adapter synchronously (no await between check and write),
 * so it is atomic against concurrent callers in this single-threaded adapter.
 * Every predicate and guard is evaluated on the proposed next state BEFORE
 * anything is written: a refusal changes nothing.
 */
export function createInMemoryRevocationResolutionStore(
  registry: RealAccountRegistry,
  revocations: PasskeyRevocationStore,
): RevocationResolutionStore & { resolutions: ResolutionRecord[] } {
  const { accountsByAppUserId, passkeysByCredentialId, backupEnrollmentMaps } = getInMemoryRegistryInternals(registry);
  const { attempts } = getInMemoryRevocationInternals(revocations);
  const resolutions: ResolutionRecord[] = [];

  const toRow = (a: PasskeyRevocationAttempt): ResolutionAttemptRow => ({
    id: a.id,
    appUserId: a.appUserId,
    targetCredentialId: a.targetCredentialId,
    targetTurnkeyAuthenticatorId: a.targetTurnkeyAuthenticatorId,
    state: a.state,
    turnkeyRequestBody: a.turnkeyRequestBody,
    turnkeyRequestBodySha256: a.turnkeyRequestBodySha256,
    turnkeyActivityId: a.turnkeyActivityId,
    turnkeyActivityStatus: a.turnkeyActivityStatus,
    failureReason: a.failureReason,
  });
  const byCreated = (x: { createdAt: string; id: string }, y: { createdAt: string; id: string }) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id);
  const isNewer = (n: { createdAt: string; id: string }, a: { createdAt: string; id: string }) => byCreated(n, a) > 0;
  const enrollmentsFor = (credentialId: string) => backupEnrollmentMaps.flatMap((map) => [...map.values()].filter((e) => e.newCredentialId === credentialId).map((enrollment) => ({ map, enrollment })));
  const passkeyRow = (p: { credentialId: string; appUserId: string; status: string; role: string; turnkeyAuthenticatorId: string | null }): ResolutionPasskeyRow => ({
    credentialId: p.credentialId,
    appUserId: p.appUserId,
    status: p.status,
    role: p.role,
    turnkeyAuthenticatorId: p.turnkeyAuthenticatorId,
  });

  return {
    resolutions,

    async loadSnapshot({ appUserId, attemptId }) {
      const account = accountsByAppUserId.get(appUserId);
      const attempt = attempts.get(attemptId);
      if (!account || !attempt) return null;
      const forTarget = [...attempts.values()].filter((a) => a.targetCredentialId === attempt.targetCredentialId).sort(byCreated);
      const target = passkeysByCredentialId.get(attempt.targetCredentialId);
      return {
        account: { appUserId: account.appUserId, subOrganizationId: account.subOrganizationId, turnkeyUserId: account.turnkeyUserId },
        attempt: toRow(attempt),
        targetAttempts: forTarget.map(toRow),
        hasNewerNonCancelledAttempt: forTarget.some((n) => n.id !== attempt.id && n.state !== "cancelled" && isNewer(n, attempt)),
        targetPasskey: target ? passkeyRow(target) : null,
        accountPasskeys: [...passkeysByCredentialId.values()]
          .filter((p) => p.appUserId === appUserId)
          .sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.credentialId.localeCompare(y.credentialId))
          .map(passkeyRow),
        targetEnrollments: enrollmentsFor(attempt.targetCredentialId).map(({ enrollment }) => ({ id: enrollment.id, appUserId: enrollment.appUserId, state: enrollment.state })),
        existingResolutionId: resolutions.find((r) => r.revocationAttemptId === attemptId)?.id ?? null,
      };
    },

    async commitResolution(input) {
      const { appUserId, attemptId, targetCredentialId: cid, targetTurnkeyAuthenticatorId: tid, expected, receipt } = input;
      if (!accountsByAppUserId.has(appUserId)) return { outcome: "lost_race" };
      const attempt = attempts.get(attemptId);
      const target = passkeysByCredentialId.get(cid);
      const accountPasskeys = [...passkeysByCredentialId.values()].filter((p) => p.appUserId === appUserId);
      const bodyAttempt = attempts.get(receipt.bodyAttemptId);
      const enrollments = enrollmentsFor(cid);
      const claimable =
        attempt &&
        attempt.appUserId === appUserId &&
        attempt.state === "blocked" &&
        attempt.targetCredentialId === cid &&
        attempt.targetTurnkeyAuthenticatorId === tid &&
        attempt.turnkeyActivityId === expected.turnkeyActivityId &&
        attempt.turnkeyActivityStatus === expected.turnkeyActivityStatus &&
        attempt.failureReason === expected.failureReason &&
        target?.appUserId === appUserId &&
        target.status === "revoking" &&
        target.turnkeyAuthenticatorId === tid &&
        ![...attempts.values()].some((d) => d.targetCredentialId === cid && d.state === "dispatch_in_flight") &&
        ![...attempts.values()].some((n) => n.targetCredentialId === cid && n.id !== attempt.id && n.state !== "cancelled" && isNewer(n, attempt)) &&
        accountPasskeys.some((s) => s.credentialId !== cid && s.status === "active" && s.turnkeyAuthenticatorId !== null) &&
        bodyAttempt?.appUserId === appUserId &&
        bodyAttempt.targetCredentialId === cid &&
        bodyAttempt.targetTurnkeyAuthenticatorId === tid &&
        (bodyAttempt.state === "blocked" || bodyAttempt.state === "confirmed") &&
        bodyAttempt.turnkeyRequestBody !== null &&
        bodyAttempt.turnkeyRequestBodySha256 === receipt.bodySha256 &&
        sha256Hex(bodyAttempt.turnkeyRequestBody) === receipt.bodySha256 &&
        enrollments.every(({ enrollment }) => enrollment.appUserId === appUserId && (enrollment.state === "removal_in_progress" || enrollment.state === "active")) &&
        !resolutions.some((r) => r.revocationAttemptId === attemptId || r.receiptActivityId === receipt.activityId);
      if (!claimable) return { outcome: "lost_race" };

      // Proposed next state, then the same guards as the Neon batch — all before any write.
      const nextStatus = new Map(accountPasskeys.map((p) => [p.credentialId, p.status]));
      nextStatus.set(cid, "revoked");
      const hasPrimary = accountPasskeys.some((p) => p.role === "primary" && nextStatus.get(p.credentialId) !== "revoked");
      const promote = hasPrimary
        ? null
        : (accountPasskeys
            .filter((p) => nextStatus.get(p.credentialId) === "active")
            .sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.credentialId.localeCompare(y.credentialId))[0] ?? null);
      const activeRemains = [...nextStatus.values()].some((s) => s === "active");
      if (!activeRemains) return { outcome: "lost_race" };
      if (!hasPrimary && activeRemains && (!promote || promote.role !== "backup")) return { outcome: "lost_race" };

      const now = new Date().toISOString();
      attempts.set(attempt.id, { ...attempt, state: "confirmed", updatedAt: now });
      passkeysByCredentialId.set(cid, { ...target, status: "revoked" });
      for (const { map, enrollment } of enrollments) {
        if (enrollment.state === "removal_in_progress") map.set(enrollment.id, { ...enrollment, state: "removed", updatedAt: now });
      }
      if (promote) passkeysByCredentialId.set(promote.credentialId, { ...promote, role: "primary" });
      const record: ResolutionRecord = {
        id: randomUUID(),
        revocationAttemptId: attempt.id,
        appUserId,
        targetCredentialId: cid,
        targetTurnkeyAuthenticatorId: tid,
        originalFailureReason: attempt.failureReason,
        receiptActivityId: receipt.activityId,
        receiptSource: receipt.source,
        receiptBodyAttemptId: receipt.bodyAttemptId,
        receiptBodySha256: receipt.bodySha256,
        receiptTurnkeyCreatedAt: receipt.turnkeyCreatedAt,
        activityLogHeadId: input.activityLogHeadId,
        absenceFirstObservedAt: input.absenceFirstObservedAt,
        absenceLastObservedAt: input.absenceLastObservedAt,
        observedSurvivorAuthenticatorIds: [...input.survivorAuthenticatorIds],
        resolverVersion: input.resolverVersion,
        createdAt: now,
      };
      resolutions.push(record);
      return { outcome: "committed", resolutionId: record.id };
    },
  };
}
