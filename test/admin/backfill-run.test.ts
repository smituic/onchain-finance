import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { BackfillDb, BackfillRow } from "@/lib/real/server/backfill-turnkey-authenticator-ids";
import type { TurnkeyUserAuthenticator } from "@/lib/real/server/turnkey-discovery";
import { MAX_BACKFILL_WRITES, commitBackfill, previewBackfill, requireCompletedCommit, type BackfillCommitResult, type ProgressEvent } from "./backfill-run";

/**
 * Offline. The backfill runner's dry-run-first, bounded, preview-bound
 * commit — over an in-memory database that honors the Neon adapter's
 * write-once contract, and a mocked Turnkey read. Nothing here connects.
 */
const binding = { endpoint: "ep-admin-target-000004", database: "neondb" };
const cred = (n: number) => Buffer.from(`credential-${String(n).padStart(3, "0")}`).toString("base64url");
const auth = (n: number) => `authenticator-${n}`;
const row = (n: number): BackfillRow => ({ credentialId: cred(n), subOrganizationId: `sub-${n}`, turnkeyUserId: `user-${n}` });
const authenticator = (credentialId: string, authenticatorId: string): TurnkeyUserAuthenticator => ({ authenticatorId, credentialId, publicKey: "pk" });
const redacted = (n: number) => `${cred(n).slice(0, 8)}…`;

/** In-memory stand-in honoring the Neon adapter's contract: write only if still unmapped, and an authenticator maps to one credential. */
function fakeDb(rows: BackfillRow[], initial: Record<string, string> = {}) {
  const mapping = new Map<string, string | null>(rows.map((r) => [r.credentialId, null]));
  for (const [credentialId, authenticatorId] of Object.entries(initial)) mapping.set(credentialId, authenticatorId);
  const writes: Array<[string, string]> = [];
  const calls = { listUnmapped: 0, setIfUnmapped: 0 };
  let failWriteFor: string | null = null;
  const db: BackfillDb = {
    async listUnmapped() {
      calls.listUnmapped += 1;
      return rows.filter((r) => mapping.get(r.credentialId) === null);
    },
    async findCredentialByAuthenticatorId(id) {
      return [...mapping.entries()].find(([, v]) => v === id)?.[0] ?? null;
    },
    async setIfUnmapped(credentialId, authenticatorId) {
      calls.setIfUnmapped += 1;
      if (failWriteFor === credentialId) throw new Error("connection reset — outcome unknown");
      if (mapping.get(credentialId) !== null || [...mapping.values()].includes(authenticatorId)) return false;
      mapping.set(credentialId, authenticatorId);
      writes.push([credentialId, authenticatorId]);
      return true;
    },
    async readMapping(credentialId) {
      return mapping.get(credentialId) ?? null;
    },
  };
  return { db, mapping, writes, calls, rows, failWritesFor: (credentialId: string | null) => (failWriteFor = credentialId) };
}
/** Turnkey: each row's user holds exactly one authenticator for its credential, unless overridden. */
const turnkey = (overrides: Record<string, TurnkeyUserAuthenticator[] | null | Error> = {}) =>
  vi.fn(async (r: BackfillRow) => {
    const override = overrides[r.credentialId];
    if (override instanceof Error) throw override;
    if (override !== undefined) return override;
    return [authenticator(r.credentialId, auth(Number(r.turnkeyUserId.slice(5))))];
  });
const expectedDigest = (pairs: Array<[string, string]>, b = binding) =>
  createHash("sha256").update(["backfill-turnkey-authenticator-ids", `${b.endpoint}/${b.database}`, ...pairs.map(([c, a]) => `${c}\t${a}`).sort()].join("\n"), "utf8").digest("hex");

describe("backfill dry run (the default)", () => {
  it("performs no writes: the real write method is never called, and the database is unchanged", async () => {
    const state = fakeDb([row(1), row(2), row(3)]);
    const before = JSON.stringify([...state.mapping]);
    const preview = await previewBackfill({ db: state.db, listAuthenticators: turnkey(), binding });
    expect(state.calls.setIfUnmapped).toBe(0);
    expect(state.writes).toEqual([]);
    expect(JSON.stringify([...state.mapping])).toBe(before);
    expect(preview.count).toBe(3);
  });

  it("reports would_map for exactly the rows a commit would attempt, with redacted credentials and a stable digest", async () => {
    const state = fakeDb([row(1), row(2)]);
    const preview = await previewBackfill({ db: state.db, listAuthenticators: turnkey(), binding });
    expect(preview.report).toEqual([
      { credential: redacted(1), outcome: "would_map" },
      { credential: redacted(2), outcome: "would_map" },
    ]);
    expect(preview.digest).toBe(expectedDigest([[cred(1), auth(1)], [cred(2), auth(2)]]));
    // Stable: the same evidence gives the same digest, whatever order the rows come back in.
    const reordered = fakeDb([row(2), row(1)]);
    expect((await previewBackfill({ db: reordered.db, listAuthenticators: turnkey(), binding })).digest).toBe(preview.digest);
    // Nothing printed can identify a credential or an authenticator in full.
    expect(JSON.stringify(preview)).not.toContain(cred(1));
    expect(JSON.stringify(preview)).not.toContain(auth(1));
  });

  it("ambiguity, no match, a missing Turnkey user, and a failed Turnkey read stay fail-closed: reported, never candidates", async () => {
    const state = fakeDb([row(1), row(2), row(3), row(4), row(5)]);
    const preview = await previewBackfill({
      db: state.db,
      binding,
      listAuthenticators: turnkey({
        [cred(1)]: [authenticator(cred(1), "a"), authenticator(cred(1), "b")],
        [cred(2)]: [authenticator(cred(9), "c")],
        [cred(3)]: null,
        [cred(4)]: new Error("turnkey unavailable"),
      }),
    });
    expect(preview.report.map((entry) => entry.outcome)).toEqual(["ambiguous", "no_match", "turnkey_user_not_found", "turnkey_read_failed", "would_map"]);
    expect(preview.count).toBe(1);
    expect(preview.digest).toBe(expectedDigest([[cred(5), auth(5)]]));
    expect(state.calls.setIfUnmapped).toBe(0);
  });

  it("an authenticator already mapped to another passkey is a conflict, not a candidate", async () => {
    const state = fakeDb([row(1), row(2)], { [cred(7)]: auth(1) });
    const preview = await previewBackfill({ db: state.db, listAuthenticators: turnkey(), binding });
    expect(preview.report).toEqual([
      { credential: redacted(1), outcome: "conflict_authenticator_already_mapped" },
      { credential: redacted(2), outcome: "would_map" },
    ]);
    expect(preview.count).toBe(1);
  });

  it("two unmapped passkeys matching the SAME authenticator: the preview shows the conflict a real run would hit, not two candidates", async () => {
    const state = fakeDb([row(1), row(2)]);
    const shared = turnkey({ [cred(1)]: [authenticator(cred(1), "shared")], [cred(2)]: [authenticator(cred(2), "shared")] });
    const preview = await previewBackfill({ db: state.db, listAuthenticators: shared, binding });
    expect(preview.report.map((entry) => entry.outcome)).toEqual(["would_map", "conflict_authenticator_already_mapped"]);
    expect(preview.count).toBe(1);
    // ...which is what the unchanged production helper does when it really writes.
    const committed = await commitBackfill({ db: state.db, listAuthenticators: shared, binding, expectedCount: "1", expectedDigest: preview.digest });
    expect(committed.status).toBe("completed");
    expect(state.writes).toEqual([[cred(1), "shared"]]);
  });

  it("the digest is bound to the database: the same candidates on another endpoint or database give a different digest", async () => {
    const pairs: Array<[string, string]> = [[cred(1), auth(1)]];
    const here = (await previewBackfill({ db: fakeDb([row(1)]).db, listAuthenticators: turnkey(), binding })).digest;
    expect(here).toBe(expectedDigest(pairs));
    for (const other of [{ ...binding, endpoint: "ep-other-000009" }, { ...binding, database: "postgres" }]) {
      expect((await previewBackfill({ db: fakeDb([row(1)]).db, listAuthenticators: turnkey(), binding: other })).digest).not.toBe(here);
    }
  });
});

describe("backfill commit: bounded, and bound to a preview", () => {
  const preview = async (rows: BackfillRow[]) => previewBackfill({ db: fakeDb(rows).db, listAuthenticators: turnkey(), binding });

  it("with the previewed count and digest: writes exactly those candidates, each once, and reports progress as it goes", async () => {
    const rows = [row(1), row(2), row(3)];
    const seen = await preview(rows);
    const state = fakeDb(rows);
    const progress: ProgressEvent[] = [];
    const result = await commitBackfill({ db: state.db, listAuthenticators: turnkey(), binding, expectedCount: String(seen.count), expectedDigest: seen.digest, onProgress: (event) => progress.push(event) });
    expect(result).toEqual({ status: "completed", approved: 3, written: [1, 2, 3].map(redacted), notWritten: [], uncertain: null, remaining: [], report: [1, 2, 3].map((n) => ({ credential: redacted(n), outcome: "mapped" })) });
    expect(state.writes).toEqual([[cred(1), auth(1)], [cred(2), auth(2)], [cred(3), auth(3)]]);
    expect(state.calls.setIfUnmapped).toBe(3);
    expect(progress).toEqual([1, 2, 3].flatMap((n) => [{ credential: redacted(n), step: "writing" }, { credential: redacted(n), step: "mapped" }]));
  });

  it.each<[string, string | undefined, string | undefined, RegExp]>([
    ["no preview confirmation at all", undefined, undefined, /expected candidate count is missing/],
    ["a count but no digest", "2", undefined, /preview digest is missing/],
    ["a digest but no count", undefined, "f".repeat(64), /expected candidate count is missing/],
    ["a zero count", "0", "f".repeat(64), /not a positive whole number/],
    ["a negative count", "-2", "f".repeat(64), /not a positive whole number/],
    ["a malformed count", "2x", "f".repeat(64), /not a positive whole number/],
    ["a fractional count", "2.0", "f".repeat(64), /not a positive whole number/],
    ["a padded count", " 2", "f".repeat(64), /not a positive whole number/],
    ["a count with a leading zero", "02", "f".repeat(64), /not a positive whole number/],
    ["an excessive count", String(MAX_BACKFILL_WRITES + 1), "f".repeat(64), /exceeds the 25-write limit/],
    ["a huge count", "99999", "f".repeat(64), /not a positive whole number/],
    ["a malformed digest", "2", "abc", /not a sha256 hex digest/],
    ["an upper-case digest", "2", "F".repeat(64), /not a sha256 hex digest/],
  ])("refused before anything is read or written — %s", async (_name, expectedCount, digest, reason) => {
    const state = fakeDb([row(1), row(2)]);
    const reads = turnkey();
    const result = await commitBackfill({ db: state.db, listAuthenticators: reads, binding, expectedCount, expectedDigest: digest });
    expect(result.status).toBe("refused");
    if (result.status === "refused") expect(result.reason).toMatch(reason);
    expect(state.calls).toEqual({ listUnmapped: 0, setIfUnmapped: 0 });
    expect(reads).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  });

  it("expected count mismatch: refused, nothing written", async () => {
    const rows = [row(1), row(2)];
    const seen = await preview(rows);
    const state = fakeDb(rows);
    const result = await commitBackfill({ db: state.db, listAuthenticators: turnkey(), binding, expectedCount: "1", expectedDigest: seen.digest });
    expect(result).toMatchObject({ status: "refused", reason: expect.stringMatching(/candidate count no longer matches/) });
    expect(state.calls.setIfUnmapped).toBe(0);
  });

  it("candidate count over 25: refused even when the operator's count says otherwise, nothing written", async () => {
    const rows = Array.from({ length: MAX_BACKFILL_WRITES + 1 }, (_, i) => row(i + 1));
    const seen = await preview(rows);
    expect(seen.count).toBe(26);
    const state = fakeDb(rows);
    const result = await commitBackfill({ db: state.db, listAuthenticators: turnkey(), binding, expectedCount: "25", expectedDigest: seen.digest });
    expect(result).toMatchObject({ status: "refused", reason: expect.stringMatching(/candidate set exceeds the 25-write limit/) });
    expect(state.calls.setIfUnmapped).toBe(0);
    // Exactly 25 is allowed.
    const ok = Array.from({ length: MAX_BACKFILL_WRITES }, (_, i) => row(i + 1));
    const okSeen = await preview(ok);
    const okState = fakeDb(ok);
    expect((await commitBackfill({ db: okState.db, listAuthenticators: turnkey(), binding, expectedCount: "25", expectedDigest: okSeen.digest })).status).toBe("completed");
    expect(okState.writes).toHaveLength(25);
  });

  it.each<[string, (rows: BackfillRow[]) => { rows: BackfillRow[]; reads: ReturnType<typeof turnkey>; initial?: Record<string, string> }]>([
    ["a new candidate appeared (same count would be wrong; digest differs)", (rows) => ({ rows: [...rows.slice(0, 1), row(9)], reads: turnkey() })],
    ["a candidate was mapped by someone else since the preview", (rows) => ({ rows, reads: turnkey(), initial: { [cred(2)]: auth(2) } })],
    ["Turnkey now reports a different authenticator for a candidate", (rows) => ({ rows, reads: turnkey({ [cred(2)]: [authenticator(cred(2), "rotated")] }) })],
    ["Turnkey no longer matches a candidate", (rows) => ({ rows, reads: turnkey({ [cred(2)]: [] }) })],
    ["an extra candidate appeared alongside the previewed ones", (rows) => ({ rows: [...rows, row(9)], reads: turnkey() })],
  ])("candidate set changes are refused, nothing written — %s", async (_name, change) => {
    const rows = [row(1), row(2)];
    const seen = await preview(rows);
    const changed = change(rows);
    const state = fakeDb(changed.rows, changed.initial);
    const result = await commitBackfill({ db: state.db, listAuthenticators: changed.reads, binding, expectedCount: String(seen.count), expectedDigest: seen.digest });
    expect(result.status).toBe("refused");
    if (result.status === "refused") expect(result.reason).toMatch(/no longer matches/);
    expect(state.calls.setIfUnmapped).toBe(0);
    expect(state.writes).toEqual([]);
  });

  it("a preview from another database does not authorize this one", async () => {
    const rows = [row(1)];
    const elsewhere = await previewBackfill({ db: fakeDb(rows).db, listAuthenticators: turnkey(), binding: { ...binding, endpoint: "ep-other-000009" } });
    const state = fakeDb(rows);
    const result = await commitBackfill({ db: state.db, listAuthenticators: turnkey(), binding, expectedCount: "1", expectedDigest: elsewhere.digest });
    expect(result.status).toBe("refused");
    expect(state.calls.setIfUnmapped).toBe(0);
  });

  it("evidence that changes BETWEEN the recomputed preview and the write: that mapping is not written, and the run stops", async () => {
    const rows = [row(1), row(2), row(3)];
    const seen = await preview(rows);
    const state = fakeDb(rows);
    // Turnkey answers consistently for the preview pass, then reports a different authenticator for row 2 in the write pass.
    let calls = 0;
    const flaky = vi.fn(async (r: BackfillRow) => {
      calls += 1;
      return [authenticator(r.credentialId, calls > rows.length && r.credentialId === cred(2) ? "rotated" : auth(Number(r.turnkeyUserId.slice(5))))];
    });
    const result = await commitBackfill({ db: state.db, listAuthenticators: flaky, binding, expectedCount: String(seen.count), expectedDigest: seen.digest });
    expect(result).toEqual({ status: "incomplete", reason: "the evidence for a candidate changed after the preview; its mapping was not written", approved: 3, written: [redacted(1)], notWritten: [], uncertain: null, remaining: [redacted(2), redacted(3)] });
    expect(state.writes).toEqual([[cred(1), auth(1)]]); // row 2 was never written with "rotated"; row 3 was never attempted
    expect(state.calls.setIfUnmapped).toBe(1);
  });

  it("a row that became a candidate after the preview is not picked up by the write pass", async () => {
    const rows = [row(1)];
    const seen = await preview(rows);
    const state = fakeDb(rows);
    // The new unmapped row appears only once the write pass lists rows (the third listing: preview, then write).
    const original = state.db.listUnmapped.bind(state.db);
    let listings = 0;
    state.db.listUnmapped = async () => {
      listings += 1;
      return listings >= 2 ? [...(await original()), row(8)] : original();
    };
    const result = await commitBackfill({ db: state.db, listAuthenticators: turnkey(), binding, expectedCount: "1", expectedDigest: seen.digest });
    expect(result.status).toBe("completed");
    expect(state.writes).toEqual([[cred(1), auth(1)]]);
  });
});

describe("backfill commit: partial writes and uncertainty", () => {
  it("an UPDATE whose outcome is unknown STOPS the run: no later write, no retry, and the report says what completed and what is uncertain", async () => {
    const rows = [row(1), row(2), row(3), row(4)];
    const seen = await previewBackfill({ db: fakeDb(rows).db, listAuthenticators: turnkey(), binding });
    const state = fakeDb(rows);
    state.failWritesFor(cred(3));
    const progress: ProgressEvent[] = [];
    const result = await commitBackfill({ db: state.db, listAuthenticators: turnkey(), binding, expectedCount: "4", expectedDigest: seen.digest, onProgress: (event) => progress.push(event) });
    expect(result).toEqual({
      status: "incomplete",
      reason: "a write's outcome is unknown; stopped without retrying",
      approved: 4,
      written: [redacted(1), redacted(2)],
      notWritten: [],
      uncertain: redacted(3), // F: never counted as written
      remaining: [redacted(4)],
    });
    expect(() => requireCompletedCommit(result)).toThrow(/INCOMPLETE — not a success: .*approved=4 written=2 notWritten=0 uncertain=1 remaining=1/);
    expect(state.calls.setIfUnmapped).toBe(3); // rows 1, 2, and the one failed attempt on 3 — never a second attempt, never row 4
    expect(state.writes).toEqual([[cred(1), auth(1)], [cred(2), auth(2)]]);
    // Progress was reported as it happened, so the completed writes were visible before the stop.
    expect(progress).toEqual([
      { credential: redacted(1), step: "writing" },
      { credential: redacted(1), step: "mapped" },
      { credential: redacted(2), step: "writing" },
      { credential: redacted(2), step: "mapped" },
      { credential: redacted(3), step: "writing" },
    ]);
    expect(JSON.stringify(result)).not.toContain("connection reset"); // the driver's message is not echoed
  });

  it("no blind retry: running the SAME commit again after a partial write is refused, because the candidate set has changed", async () => {
    const rows = [row(1), row(2), row(3)];
    const seen = await previewBackfill({ db: fakeDb(rows).db, listAuthenticators: turnkey(), binding });
    const state = fakeDb(rows);
    state.failWritesFor(cred(2));
    expect((await commitBackfill({ db: state.db, listAuthenticators: turnkey(), binding, expectedCount: "3", expectedDigest: seen.digest })).status).toBe("incomplete");
    state.failWritesFor(null);
    const writesBefore = state.calls.setIfUnmapped;
    const again = await commitBackfill({ db: state.db, listAuthenticators: turnkey(), binding, expectedCount: "3", expectedDigest: seen.digest });
    expect(again).toMatchObject({ status: "refused", reason: expect.stringMatching(/no longer matches/) });
    expect(state.calls.setIfUnmapped).toBe(writesBefore);
    // A fresh dry run is what authorizes the remainder.
    const fresh = await previewBackfill({ db: state.db, listAuthenticators: turnkey(), binding });
    expect(fresh.count).toBe(2);
  });

  it("a concurrent mapping at write time is never overwritten: the database's own guard decides, and it is reported", async () => {
    const rows = [row(1), row(2)];
    const seen = await previewBackfill({ db: fakeDb(rows).db, listAuthenticators: turnkey(), binding });
    const state = fakeDb(rows);
    // Someone maps row 2 to a DIFFERENT authenticator after the write pass has listed it, before its UPDATE.
    const realSet = state.db.setIfUnmapped.bind(state.db);
    state.db.setIfUnmapped = async (credentialId, authenticatorId) => {
      if (credentialId === cred(2)) state.mapping.set(cred(2), "mapped-by-someone-else");
      return realSet(credentialId, authenticatorId);
    };
    const progress: ProgressEvent[] = [];
    const result = await commitBackfill({ db: state.db, listAuthenticators: turnkey(), binding, expectedCount: "2", expectedDigest: seen.digest, onProgress: (event) => progress.push(event) });
    // E: one of two approved mappings was written — that is NOT a success, and the declined row is reported as such.
    expect(result).toEqual({
      status: "incomplete",
      reason: "the database declined a write (the row was mapped, or its authenticator taken, by something else); it was not overwritten, and no further write was attempted",
      approved: 2,
      written: [redacted(1)],
      notWritten: [redacted(2)],
      uncertain: null,
      remaining: [],
    });
    expect(state.mapping.get(cred(2))).toBe("mapped-by-someone-else"); // never overwritten
    expect(state.mapping.get(cred(1))).toBe(auth(1)); // the earlier write stays written and stays reported
    expect(progress.at(-1)).toEqual({ credential: redacted(2), step: "not_written" });
    expect(() => requireCompletedCommit(result)).toThrow(/INCOMPLETE — not a success/);
  });

  it("D: a Turnkey read that fails during the write pass cannot end in success — the run stops before any further write", async () => {
    const rows = [row(1), row(2)];
    const seen = await previewBackfill({ db: fakeDb(rows).db, listAuthenticators: turnkey(), binding });
    const state = fakeDb(rows);
    let calls = 0;
    const reads = vi.fn(async (r: BackfillRow) => {
      calls += 1;
      if (calls > rows.length && r.credentialId === cred(1)) throw new Error("turnkey unavailable");
      return [authenticator(r.credentialId, auth(Number(r.turnkeyUserId.slice(5))))];
    });
    const result = await commitBackfill({ db: state.db, listAuthenticators: reads, binding, expectedCount: "2", expectedDigest: seen.digest });
    expect(result).toEqual({
      status: "incomplete",
      reason: "an approved candidate was skipped (its evidence could not be re-read, or no longer leads to a write); stopped before any further write",
      approved: 2,
      written: [],
      notWritten: [],
      uncertain: null,
      remaining: [redacted(1), redacted(2)],
    });
    expect(state.writes).toEqual([]); // row 2 was not written once the approved count had become unattainable
    expect(state.calls.setIfUnmapped).toBe(0);
  });

  it("D: the LAST candidate's Turnkey read failing leaves no later write to expose it — still incomplete, never a success", async () => {
    const rows = [row(1), row(2), row(3)];
    const seen = await previewBackfill({ db: fakeDb(rows).db, listAuthenticators: turnkey(), binding });
    const state = fakeDb(rows);
    let calls = 0;
    const reads = vi.fn(async (r: BackfillRow) => {
      calls += 1;
      if (calls > rows.length && r.credentialId === cred(3)) throw new Error("turnkey unavailable");
      return [authenticator(r.credentialId, auth(Number(r.turnkeyUserId.slice(5))))];
    });
    const result = await commitBackfill({ db: state.db, listAuthenticators: reads, binding, expectedCount: "3", expectedDigest: seen.digest });
    expect(result).toEqual({
      status: "incomplete",
      reason: "fewer mappings were written than approved (an approved candidate was skipped: its evidence could not be re-read, or no longer leads to a write)",
      approved: 3,
      written: [redacted(1), redacted(2)], // H: the rows already modified remain visible
      notWritten: [],
      uncertain: null,
      remaining: [redacted(3)],
    });
    expect(state.writes).toEqual([[cred(1), auth(1)], [cred(2), auth(2)]]);
  });

  it.each<[string, TurnkeyUserAuthenticator[] | null]>([
    ["no longer matches any authenticator", []],
    ["has become ambiguous", [authenticator(cred(2), "a"), authenticator(cred(2), "b")]],
    ["has lost its Turnkey user", null],
  ])("a candidate whose evidence %s in the write pass: incomplete, and nothing after it is written", async (_name, changed) => {
    const rows = [row(1), row(2), row(3)];
    const seen = await previewBackfill({ db: fakeDb(rows).db, listAuthenticators: turnkey(), binding });
    const state = fakeDb(rows);
    let calls = 0;
    const reads = vi.fn(async (r: BackfillRow) => {
      calls += 1;
      return calls > rows.length && r.credentialId === cred(2) ? changed : [authenticator(r.credentialId, auth(Number(r.turnkeyUserId.slice(5))))];
    });
    const result = await commitBackfill({ db: state.db, listAuthenticators: reads, binding, expectedCount: "3", expectedDigest: seen.digest });
    expect(result).toMatchObject({ status: "incomplete", approved: 3, written: [redacted(1)], notWritten: [], uncertain: null, remaining: [redacted(2), redacted(3)] });
    expect(state.writes).toEqual([[cred(1), auth(1)]]);
  });

  it("E: an approved candidate mapped by someone else between the recomputed preview and the write pass: incomplete, with NOTHING written", async () => {
    const rows = [row(1), row(2)];
    const seen = await previewBackfill({ db: fakeDb(rows).db, listAuthenticators: turnkey(), binding });
    const state = fakeDb(rows);
    const original = state.db.listUnmapped.bind(state.db);
    let listings = 0;
    state.db.listUnmapped = async () => {
      listings += 1;
      if (listings === 2) state.mapping.set(cred(1), "mapped-by-someone-else"); // after the preview's listing, before the write pass's
      return original();
    };
    const result = await commitBackfill({ db: state.db, listAuthenticators: turnkey(), binding, expectedCount: "2", expectedDigest: seen.digest });
    expect(result).toEqual({ status: "incomplete", reason: "an approved candidate is no longer unmapped; nothing was written", approved: 2, written: [], notWritten: [], uncertain: null, remaining: [redacted(1), redacted(2)] });
    expect(state.calls.setIfUnmapped).toBe(0);
    expect(state.mapping.get(cred(1))).toBe("mapped-by-someone-else");
  });

  it("the accounting always adds up to the approved count, and never names a credential in full", async () => {
    const rows = [row(1), row(2), row(3), row(4)];
    const seen = await previewBackfill({ db: fakeDb(rows).db, listAuthenticators: turnkey(), binding });
    for (const failAt of [1, 2, 3, 4]) {
      const state = fakeDb(rows);
      state.failWritesFor(cred(failAt));
      const result = await commitBackfill({ db: state.db, listAuthenticators: turnkey(), binding, expectedCount: "4", expectedDigest: seen.digest });
      expect(result.status).toBe("incomplete");
      if (result.status !== "incomplete") continue;
      expect(result.written.length + result.notWritten.length + (result.uncertain === null ? 0 : 1) + result.remaining.length).toBe(result.approved);
      expect(result.written).toEqual(rows.slice(0, failAt - 1).map((r) => `${r.credentialId.slice(0, 8)}…`));
      expect(state.calls.setIfUnmapped).toBe(failAt); // G: exactly one attempt per row up to the failure; none after, none repeated
      for (const r of rows) expect(JSON.stringify(result)).not.toContain(r.credentialId);
    }
  });
});

describe("only a completed commit is a success", () => {
  const accounting = { approved: 2, written: ["aaaaaaaa…"], notWritten: [], uncertain: null, remaining: ["bbbbbbbb…"] };
  it("A: completed passes", () => {
    expect(() => requireCompletedCommit({ status: "completed", report: [], approved: 1, written: ["aaaaaaaa…"], notWritten: [], uncertain: null, remaining: [] })).not.toThrow();
  });

  it.each<[string, BackfillCommitResult, RegExp]>([
    ["B/C: incomplete", { status: "incomplete", reason: "fewer mappings were written than approved", ...accounting }, /INCOMPLETE — not a success: fewer mappings were written than approved\. approved=2 written=1 notWritten=0 uncertain=0 remaining=1\. Rows already written stay written; reconcile read-only before any new attempt\./],
    ["incomplete with an uncertain write", { status: "incomplete", reason: "a write's outcome is unknown; stopped without retrying", ...accounting, uncertain: "cccccccc…" }, /uncertain=1/],
    ["refused", { status: "refused", reason: "the candidate set no longer matches the previewed one; run a new dry run" }, /REFUSED \(nothing written\)/],
  ])("%s throws — so the runner's test fails and the process exits nonzero — without naming a credential", (_name, result, message) => {
    let thrown = "";
    try {
      requireCompletedCommit(result);
    } catch (error) {
      thrown = (error as Error).message;
    }
    expect(thrown).toMatch(message);
    expect(thrown).not.toMatch(/aaaaaaaa|bbbbbbbb|cccccccc/);
  });

  it("a real incomplete commit, taken through the runner's success rule, is a failure", async () => {
    const rows = [row(1), row(2)];
    const seen = await previewBackfill({ db: fakeDb(rows).db, listAuthenticators: turnkey(), binding });
    const state = fakeDb(rows);
    state.failWritesFor(cred(2));
    const result = await commitBackfill({ db: state.db, listAuthenticators: turnkey(), binding, expectedCount: "2", expectedDigest: seen.digest });
    expect(() => requireCompletedCommit(result)).toThrow(/INCOMPLETE/);
    // ...whereas the same candidates with every write confirmed pass.
    const clean = fakeDb(rows);
    const ok = await commitBackfill({ db: clean.db, listAuthenticators: turnkey(), binding, expectedCount: "2", expectedDigest: seen.digest });
    expect(() => requireCompletedCommit(ok)).not.toThrow();
  });
});

describe("the production helper is used unchanged (static)", () => {
  const source = readFileSync("test/admin/backfill-run.ts", "utf8");
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");

  it("both passes run backfillTurnkeyAuthenticatorIds; nothing here matches authenticators or decides conflicts itself", () => {
    expect(code.match(/await backfillTurnkeyAuthenticatorIds\(/g)).toHaveLength(2);
    expect(code).not.toMatch(/matchAuthenticatorByCredentialId|credentialIdsEqual|UPDATE |INSERT |DELETE /);
  });

  it("the preview wrapper cannot write: the real setIfUnmapped is referenced exactly once, inside the guarded commit path", () => {
    expect(code.match(/db\.setIfUnmapped\(/g)).toHaveLength(1);
    const previewPart = code.slice(code.indexOf("async function computePreview("), code.indexOf("export async function previewBackfill("));
    expect(previewPart).not.toContain("db.setIfUnmapped");
    const commitPart = code.slice(code.indexOf("export async function commitBackfill("));
    expect(commitPart.indexOf("if (confirmed.get(credentialId) !== authenticatorId) halt(")).toBeLessThan(commitPart.indexOf("db.setIfUnmapped("));
    expect(commitPart.indexOf("if (attempted.has(credentialId)) halt(")).toBeLessThan(commitPart.indexOf("db.setIfUnmapped("));
    expect(commitPart.indexOf("const preview = await computePreview(input);")).toBeLessThan(commitPart.indexOf("const guarded: BackfillDb = {"));
  });

  it("the production helper's own guarantees are still in its source", () => {
    const helper = readFileSync("lib/real/server/backfill-turnkey-authenticator-ids.ts", "utf8");
    expect(helper).toContain("WHERE credential_id = ${credentialId} AND turnkey_authenticator_id IS NULL");
    expect(helper).toContain('if (code === "23505") return false;');
    expect(helper).toContain("const match = matchAuthenticatorByCredentialId(authenticators, row.credentialId);");
    expect(helper).toContain('entry("conflict_authenticator_already_mapped");');
  });
});
