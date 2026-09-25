import type { NeonQueryFunction } from "@neondatabase/serverless";
import { matchAuthenticatorByCredentialId, type TurnkeyUserAuthenticator } from "./turnkey-discovery";

/**
 * Administrative backfill of real_passkeys.turnkey_authenticator_id for
 * passkeys written before that column existed (every pre-Batch-2g primary).
 * Without it a passkey can neither be removed nor authorize a removal.
 *
 *   - Turnkey is READ-ONLY here (getUsers via the parent key's existing
 *     read authority); nothing is created, deleted, or approved.
 *   - A row is written only for exactly one decoded-credential-id-BYTES
 *     match; zero or several matches are reported, never written.
 *   - The UPDATE requires turnkey_authenticator_id IS NULL, so it never
 *     overwrites; an existing different mapping, or an authenticator already
 *     mapped to another passkey, is reported as a conflict.
 *   - Rerunnable. Reports carry only truncated credential ids — no secrets.
 *
 * Run only via the env-gated admin runner
 * (test/admin/backfill-turnkey-authenticator-ids.admin.test.ts).
 */

export type BackfillRow = { credentialId: string; subOrganizationId: string; turnkeyUserId: string };

export interface BackfillDb {
  listUnmapped(): Promise<BackfillRow[]>;
  /** The credential already mapped to this Turnkey authenticator, if any. */
  findCredentialByAuthenticatorId(authenticatorId: string): Promise<string | null>;
  /** Writes only if still unmapped; false if the row was mapped concurrently (or the id is taken). */
  setIfUnmapped(credentialId: string, authenticatorId: string): Promise<boolean>;
  readMapping(credentialId: string): Promise<string | null>;
}

export type BackfillOutcome =
  | "mapped"
  | "already_mapped_same"
  | "conflict_existing_mapping"
  | "conflict_authenticator_already_mapped"
  | "no_match"
  | "ambiguous"
  | "turnkey_user_not_found"
  | "turnkey_read_failed";

export type BackfillReportEntry = { credential: string; outcome: BackfillOutcome };

function redact(credentialId: string): string {
  return `${credentialId.slice(0, 8)}…`;
}

export async function backfillTurnkeyAuthenticatorIds(input: {
  db: BackfillDb;
  listAuthenticators: (row: BackfillRow) => Promise<TurnkeyUserAuthenticator[] | null>;
}): Promise<BackfillReportEntry[]> {
  const report: BackfillReportEntry[] = [];
  for (const row of await input.db.listUnmapped()) {
    const entry = (outcome: BackfillOutcome) => report.push({ credential: redact(row.credentialId), outcome });

    let authenticators: TurnkeyUserAuthenticator[] | null;
    try {
      authenticators = await input.listAuthenticators(row);
    } catch {
      entry("turnkey_read_failed");
      continue;
    }
    const match = matchAuthenticatorByCredentialId(authenticators, row.credentialId);
    if (match.outcome === "user_not_found") entry("turnkey_user_not_found");
    else if (match.outcome === "not_found") entry("no_match");
    else if (match.outcome === "ambiguous") entry("ambiguous");
    else {
      const authenticatorId = match.authenticator.authenticatorId;
      const mappedTo = await input.db.findCredentialByAuthenticatorId(authenticatorId);
      if (mappedTo !== null && mappedTo !== row.credentialId) {
        entry("conflict_authenticator_already_mapped");
        continue;
      }
      if (await input.db.setIfUnmapped(row.credentialId, authenticatorId)) {
        entry("mapped");
        continue;
      }
      const current = await input.db.readMapping(row.credentialId);
      entry(current === authenticatorId ? "already_mapped_same" : "conflict_existing_mapping");
    }
  }
  return report;
}

/** Neon adapter for the admin runner only — never wired into runtime.ts or any route. */
export function createNeonBackfillDb(sql: NeonQueryFunction<false, false>): BackfillDb {
  return {
    async listUnmapped() {
      const rows = (await sql`
        SELECT p.credential_id, a.sub_organization_id, a.turnkey_user_id
        FROM real_passkeys p JOIN real_accounts a ON a.app_user_id = p.app_user_id
        WHERE p.turnkey_authenticator_id IS NULL AND p.status IN ('active', 'revoking')
        ORDER BY p.created_at
      `) as Array<Record<string, string>>;
      return rows.map((r) => ({ credentialId: r.credential_id!, subOrganizationId: r.sub_organization_id!, turnkeyUserId: r.turnkey_user_id! }));
    },
    async findCredentialByAuthenticatorId(authenticatorId) {
      const rows = (await sql`SELECT credential_id FROM real_passkeys WHERE turnkey_authenticator_id = ${authenticatorId}`) as Array<Record<string, string>>;
      return rows[0]?.credential_id ?? null;
    },
    async setIfUnmapped(credentialId, authenticatorId) {
      try {
        const rows = (await sql`
          UPDATE real_passkeys SET turnkey_authenticator_id = ${authenticatorId}
          WHERE credential_id = ${credentialId} AND turnkey_authenticator_id IS NULL
          RETURNING credential_id
        `) as unknown[];
        return rows.length === 1;
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
        if (code === "23505") return false;
        throw error;
      }
    },
    async readMapping(credentialId) {
      const rows = (await sql`SELECT turnkey_authenticator_id FROM real_passkeys WHERE credential_id = ${credentialId}`) as Array<Record<string, string | null>>;
      return rows[0]?.turnkey_authenticator_id ?? null;
    },
  };
}
