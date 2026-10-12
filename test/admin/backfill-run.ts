import { createHash } from "node:crypto";
import { backfillTurnkeyAuthenticatorIds, type BackfillDb, type BackfillOutcome, type BackfillRow } from "@/lib/real/server/backfill-turnkey-authenticator-ids";
import type { TurnkeyUserAuthenticator } from "@/lib/real/server/turnkey-discovery";

/**
 * TEST-ONLY orchestration of the authenticator-id backfill for its admin
 * runner: DRY RUN by default, and a commit that is bounded and bound to a
 * preview. The matching, conflict, and write-once rules are NOT reimplemented
 * here — both passes run the production helper
 * (lib/real/server/backfill-turnkey-authenticator-ids.ts) unchanged, through
 * a `BackfillDb` that wraps the real one:
 *
 *  - PREVIEW: the wrapper has no path to the real `setIfUnmapped`. Where the
 *    helper would write, the wrapper records the (credential, authenticator)
 *    pair as a candidate instead — and remembers it, so a second credential
 *    that matches the same authenticator is reported as the conflict a real
 *    run would hit, not as a second candidate.
 *  - COMMIT: the preview is recomputed first and must equal the operator's
 *    expected count and digest. Then the helper runs again over ONLY those
 *    candidates, and the wrapper lets a write through only if it is exactly
 *    a confirmed pair, at most once each.
 *
 * A candidate is a write the commit would ATTEMPT. It is not a prediction of
 * the result: the database's own guard (`turnkey_authenticator_id IS NULL`,
 * the unique index) still decides, and a row mapped by someone else in
 * between is reported as such, never overwritten.
 */
export const MAX_BACKFILL_WRITES = 25;

export type ListAuthenticators = (row: BackfillRow) => Promise<TurnkeyUserAuthenticator[] | null>;
/** Which database the preview is for; part of the digest, so a preview of one database never authorizes a commit on another. */
export type BackfillBinding = { endpoint: string; database: string };
export type PreviewOutcome = Exclude<BackfillOutcome, "mapped"> | "would_map";
export type BackfillPreview = {
  report: Array<{ credential: string; outcome: PreviewOutcome }>;
  /** How many writes a commit would attempt. */
  count: number;
  /** sha256 over the binding and the exact sorted (credential id, authenticator id) pairs. */
  digest: string;
};
export type ProgressEvent = { credential: string; step: "writing" | "mapped" | "not_written" };

const redact = (credentialId: string) => `${credentialId.slice(0, 8)}…`;

function previewDigest(binding: BackfillBinding, candidates: ReadonlyMap<string, string>): string {
  const pairs = [...candidates].map(([credentialId, authenticatorId]) => `${credentialId}\t${authenticatorId}`).sort();
  return createHash("sha256").update(["backfill-turnkey-authenticator-ids", `${binding.endpoint}/${binding.database}`, ...pairs].join("\n"), "utf8").digest("hex");
}

async function computePreview(input: { db: BackfillDb; listAuthenticators: ListAuthenticators; binding: BackfillBinding }): Promise<BackfillPreview & { candidates: Map<string, string> }> {
  const { db } = input;
  const candidates = new Map<string, string>();
  const claimedBy = new Map<string, string>(); // authenticator id -> the candidate credential that would take it
  const readOnly: BackfillDb = {
    listUnmapped: () => db.listUnmapped(),
    findCredentialByAuthenticatorId: async (authenticatorId) => (await db.findCredentialByAuthenticatorId(authenticatorId)) ?? claimedBy.get(authenticatorId) ?? null,
    // The ONLY write the helper can make. In a preview it is recorded, never performed: this object holds no reference to db.setIfUnmapped.
    setIfUnmapped: async (credentialId, authenticatorId) => {
      candidates.set(credentialId, authenticatorId);
      claimedBy.set(authenticatorId, credentialId);
      return true;
    },
    readMapping: (credentialId) => db.readMapping(credentialId),
  };
  const report = (await backfillTurnkeyAuthenticatorIds({ db: readOnly, listAuthenticators: input.listAuthenticators })).map((entry) => ({ credential: entry.credential, outcome: entry.outcome === "mapped" ? ("would_map" as const) : entry.outcome }));
  return { report, count: candidates.size, digest: previewDigest(input.binding, candidates), candidates };
}

/** DRY RUN. Reads the database and Turnkey exactly as a real run would, and writes nothing. */
export async function previewBackfill(input: { db: BackfillDb; listAuthenticators: ListAuthenticators; binding: BackfillBinding }): Promise<BackfillPreview> {
  const { report, count, digest } = await computePreview(input);
  return { report, count, digest };
}

/** How an approved candidate ended up. Credentials are redacted; nothing here is inferred — each list holds only what was observed. */
export type BackfillAccounting = {
  /** How many writes the operator approved (the preview's candidate count). */
  approved: number;
  /** The database confirmed the write. These rows ARE modified, whatever happened afterwards. */
  written: string[];
  /** The database confirmed NO write (already mapped, or the authenticator was taken) — never overwritten. */
  notWritten: string[];
  /** The one write whose outcome is unknown, if any. It may or may not have been applied. */
  uncertain: string | null;
  /** Approved candidates this run never attempted to write. */
  remaining: string[];
};

export type BackfillCommitResult =
  | { status: "refused"; reason: string; preview?: Pick<BackfillPreview, "count" | "digest"> }
  | ({ status: "completed"; report: Array<{ credential: string; outcome: BackfillOutcome }> } & BackfillAccounting)
  | ({ status: "incomplete"; reason: string } & BackfillAccounting);

/**
 * COMMIT. Refuses — with nothing written — unless `expectedCount` is a whole
 * number from 1 to MAX_BACKFILL_WRITES, `expectedDigest` is a sha256 hex
 * digest, and a freshly recomputed preview has exactly that count and digest.
 * Then writes only those candidates.
 *
 * "completed" means EVERY approved mapping was confirmed written. Anything
 * less is "incomplete", never a success: the accounting says which rows were
 * written (they stay written — this is not one transaction and nothing is
 * rolled back), which the database declined, which one is uncertain, and
 * which were never attempted. Once the approved count can no longer be
 * reached, no further write is attempted: an approved candidate that is no
 * longer unmapped, one whose evidence could not be re-read or changed, a
 * write the database declined, or a write whose outcome is unknown each
 * STOP the run. Nothing is retried and nothing is overwritten.
 */
export async function commitBackfill(input: {
  db: BackfillDb;
  listAuthenticators: ListAuthenticators;
  binding: BackfillBinding;
  expectedCount: string | undefined;
  expectedDigest: string | undefined;
  onProgress?: (event: ProgressEvent) => void;
}): Promise<BackfillCommitResult> {
  const { db, expectedCount, expectedDigest } = input;
  if (expectedCount === undefined || !/^[1-9][0-9]{0,3}$/.test(expectedCount)) return { status: "refused", reason: "the expected candidate count is missing or not a positive whole number (take it from a dry run)" };
  if (Number(expectedCount) > MAX_BACKFILL_WRITES) return { status: "refused", reason: `the expected candidate count exceeds the ${MAX_BACKFILL_WRITES}-write limit per run` };
  if (expectedDigest === undefined || !/^[0-9a-f]{64}$/.test(expectedDigest)) return { status: "refused", reason: "the preview digest is missing or not a sha256 hex digest (take it from a dry run)" };

  const preview = await computePreview(input);
  const seen = { count: preview.count, digest: preview.digest };
  if (preview.count > MAX_BACKFILL_WRITES) return { status: "refused", reason: `the candidate set exceeds the ${MAX_BACKFILL_WRITES}-write limit per run`, preview: seen };
  if (preview.count !== Number(expectedCount)) return { status: "refused", reason: "the candidate count no longer matches the expected count; run a new dry run", preview: seen };
  if (preview.digest !== expectedDigest) return { status: "refused", reason: "the candidate set no longer matches the previewed one; run a new dry run", preview: seen };

  const confirmed = preview.candidates;
  const attempted = new Set<string>();
  const written: string[] = [];
  const notWritten: string[] = [];
  const state: { uncertain: string | null; stop: string | null; order: string[] } = { uncertain: null, stop: null, order: [] };
  const halt = (reason: string): never => {
    state.stop = reason;
    throw new Error(reason);
  };
  const accounting = (): BackfillAccounting => ({
    approved: confirmed.size,
    written: written.map(redact),
    notWritten: notWritten.map(redact),
    uncertain: state.uncertain === null ? null : redact(state.uncertain),
    remaining: [...confirmed.keys()].filter((credentialId) => !written.includes(credentialId) && !notWritten.includes(credentialId) && credentialId !== state.uncertain).map(redact),
  });
  const guarded: BackfillDb = {
    // Only the confirmed candidates: a row that became a candidate after the preview is not picked up by this run.
    listUnmapped: async () => {
      const rows = (await db.listUnmapped()).filter((row) => confirmed.has(row.credentialId));
      state.order = rows.map((row) => row.credentialId);
      if (rows.length !== confirmed.size) halt("an approved candidate is no longer unmapped; nothing was written");
      return rows;
    },
    findCredentialByAuthenticatorId: (authenticatorId) => db.findCredentialByAuthenticatorId(authenticatorId),
    setIfUnmapped: async (credentialId, authenticatorId) => {
      if (confirmed.get(credentialId) !== authenticatorId) halt("the evidence for a candidate changed after the preview; its mapping was not written");
      if (attempted.has(credentialId)) halt("a candidate was offered for a second write; it was not retried");
      // The helper takes the rows in order. Reaching this one while an earlier approved candidate was never offered for
      // a write means that one was skipped (its evidence could not be re-read, or no longer leads to a write).
      if (state.order[attempted.size] !== credentialId) halt("an approved candidate was skipped (its evidence could not be re-read, or no longer leads to a write); stopped before any further write");
      attempted.add(credentialId);
      input.onProgress?.({ credential: redact(credentialId), step: "writing" });
      let ok: boolean;
      try {
        ok = await db.setIfUnmapped(credentialId, authenticatorId);
      } catch {
        state.uncertain = credentialId;
        return halt("a write's outcome is unknown; stopped without retrying");
      }
      if (!ok) {
        notWritten.push(credentialId);
        input.onProgress?.({ credential: redact(credentialId), step: "not_written" });
        return halt("the database declined a write (the row was mapped, or its authenticator taken, by something else); it was not overwritten, and no further write was attempted");
      }
      written.push(credentialId);
      input.onProgress?.({ credential: redact(credentialId), step: "mapped" });
      return true;
    },
    readMapping: (credentialId) => db.readMapping(credentialId),
  };
  let report: Array<{ credential: string; outcome: BackfillOutcome }>;
  try {
    report = await backfillTurnkeyAuthenticatorIds({ db: guarded, listAuthenticators: input.listAuthenticators });
  } catch {
    // Anything that interrupts the write pass ends it: a read that failed mid-run is not retried either.
    return { status: "incomplete", reason: state.stop ?? "the run was interrupted by a database read error; stopped without retrying", ...accounting() };
  }
  // The helper finished without a stop — but that alone is not success: a trailing candidate can be skipped with no later write to expose it.
  if (written.length !== confirmed.size) return { status: "incomplete", reason: "fewer mappings were written than approved (an approved candidate was skipped: its evidence could not be re-read, or no longer leads to a write)", ...accounting() };
  return { status: "completed", report, ...accounting() };
}

/**
 * The runner's last step: a commit is a success ONLY when it completed. A
 * refused or incomplete commit throws — which fails the runner's test and so
 * the process exits nonzero — with a message that names the outcome and
 * counts, never a credential.
 */
export function requireCompletedCommit(result: BackfillCommitResult): void {
  if (result.status === "completed") return;
  if (result.status === "refused") throw new Error(`backfill commit REFUSED (nothing written): ${result.reason}`);
  throw new Error(
    `backfill commit INCOMPLETE — not a success: ${result.reason}. approved=${result.approved} written=${result.written.length} notWritten=${result.notWritten.length} uncertain=${result.uncertain === null ? 0 : 1} remaining=${result.remaining.length}. Rows already written stay written; reconcile read-only before any new attempt.`,
  );
}
