import { createHash } from "node:crypto";

/**
 * TEST-ONLY fixture ownership for the Neon adapter smoke
 * (neon-smoke.test.ts). A run owns exactly the ids that start
 * `smoke-<runId>-`, where runId is that run's 8 lowercase hex characters;
 * its seed helper writes, and its cleanup deletes, nothing else.
 */
const RUN_ID = /^[0-9a-f]{8}$/;

export function isRunSmokeId(runId: string, id: string): boolean {
  return RUN_ID.test(runId) && id.startsWith(`smoke-${runId}-`);
}

/** Throws before the caller touches the database if ANY id is not this run's. Never echoes the id. */
export function assertRunSmokeIds(runId: string, ids: Iterable<string>): void {
  for (const id of ids) if (!isRunSmokeId(runId, id)) throw new Error("refusing to clean up a non-smoke id");
}

/**
 * The credential id of a finalize (S5 L3/L2) fixture: run-owned AND canonical
 * base64url, which finalize needs (accountMatchesAttempt compares decoded
 * bytes and fails closed on anything undecodable). The 20-character prefix
 * `smoke-<runId>-L3A--` is itself base64url and is exactly 15 bytes, so the
 * encoded id starts with it verbatim; 32 bytes of sha256(runId:suffix) follow.
 */
export function smokeFinalizeCredentialId(runId: string, suffix: string): string {
  if (!RUN_ID.test(runId)) throw new Error("smoke run id must be 8 lowercase hex characters");
  const prefix = `smoke-${runId}-L3A--`;
  const id = Buffer.concat([Buffer.from(prefix, "base64url"), createHash("sha256").update(`${runId}:${suffix}`).digest()]).toString("base64url");
  if (!id.startsWith(prefix)) throw new Error("smoke finalize credential id lost its run prefix");
  return id;
}
