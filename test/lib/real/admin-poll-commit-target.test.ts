import { describe, expect, it, vi } from "vitest";
import { pollProvisioningDispatch, type ProvisioningActivityPort, type ProvisioningPollStore } from "@/lib/real/server/provisioning-activity-poller";
import { ADMIN_RUNNERS, AdminCommitNotApplied, AdminRefusal, COMMIT_CONFIRMATION_ENV, commitConfirmation, requireCommitDecision, requireCommitOutcome, requirePollCommitDecision, type Env } from "../../admin/admin-target";

/**
 * Offline. Which dispatch a poll commit records (Milestone 0, admin audit
 * finding L-1) — the runner's selection rule, and the PRODUCTION poller run
 * behind it with a mocked store and Turnkey port. Synthetic values only.
 *
 * This file lives here, not under test/admin/, on purpose: the only file in
 * test/admin/ allowed to import the provisioning activity poller is the
 * gated runner itself (provisioning-evidence-boundary.test.ts).
 */
const ENDPOINT = "ep-admin-target-000004";
const DATABASE = "neondb";

// L-1: WHICH dispatch a poll commit records is fixed by the operator. "latest" is re-resolved on every run, so it can
// only ever be a dry-run selector — never the basis of a commit, and never a preview for one.
describe("poll: a commit names one explicit dispatch sequence", () => {
  const poll = ADMIN_RUNNERS.poll;
  const target = { endpoint: ENDPOINT, database: DATABASE };
  const CRED = "cred-abc_123";
  const confirmationFor = (seq: string, credentialId = CRED, t = target) => commitConfirmation(poll, t, [credentialId, seq, "quiescent"]);
  const decide = (env: Env, rawSeq: string | undefined, credentialId = CRED) => requirePollCommitDecision({ env, runner: poll, target, credentialId, rawSeq });
  const commitEnv = (seq: string, extra: Env = {}): Env => ({ [poll.commitGate]: "1", [COMMIT_CONFIRMATION_ENV]: confirmationFor(seq), ...extra });

  it("A: a dry run may inspect latest (no sequence), or one explicit sequence", () => {
    expect(decide({}, undefined)).toEqual({ commit: false, dispatchSeq: undefined });
    expect(decide({}, "")).toEqual({ commit: false, dispatchSeq: undefined });
    expect(decide({}, "3")).toEqual({ commit: false, dispatchSeq: 3 });
  });

  it("B: a commit without REAL_ADMIN_DISPATCH_SEQ is refused", () => {
    for (const rawSeq of [undefined, ""]) {
      expect(() => decide({ [poll.commitGate]: "1" }, rawSeq)).toThrow(/REAL_ADMIN_POLL_COMMIT is set without REAL_ADMIN_DISPATCH_SEQ; a commit must name one explicit dispatch sequence/);
    }
  });

  it("C: a commit using latest is refused — even with a confirmation that says latest, which the old rule would have honored", () => {
    const latestConfirmation = confirmationFor("latest");
    expect(requireCommitDecision({ env: { [poll.commitGate]: "1", [COMMIT_CONFIRMATION_ENV]: latestConfirmation }, runner: poll, target, operation: [CRED, "latest", "quiescent"] })).toBe(true); // the generic check alone
    expect(() => decide({ [poll.commitGate]: "1", [COMMIT_CONFIRMATION_ENV]: latestConfirmation }, undefined)).toThrow(/"latest" is for dry runs only/);
    // The word itself is not a sequence either.
    expect(() => decide({ [poll.commitGate]: "1", [COMMIT_CONFIRMATION_ENV]: latestConfirmation }, "latest")).toThrow(/not a positive whole number/);
  });

  it("D: a commit with an explicit valid sequence and its exact confirmation passes the authorization preflight", () => {
    expect(decide(commitEnv("1"), "1")).toEqual({ commit: true, dispatchSeq: 1 });
    expect(decide(commitEnv("27"), "27")).toEqual({ commit: true, dispatchSeq: 27 });
  });

  it.each(["0", "-1", "1.0", "01", "1e3", " 1", "1 ", " 1 ", "\t1", "1\n", "0x1", "one", "1;2", "9999999999"])("a malformed sequence %j is refused in either mode", (rawSeq) => {
    expect(() => decide({}, rawSeq)).toThrow(/REAL_ADMIN_DISPATCH_SEQ is not a positive whole number/);
    expect(() => decide(commitEnv(rawSeq), rawSeq)).toThrow(/REAL_ADMIN_DISPATCH_SEQ is not a positive whole number/);
  });

  it("E: a confirmation for another sequence is refused", () => {
    expect(() => decide(commitEnv("2"), "1")).toThrow(/does not match this runner, target, and operation/);
    expect(() => decide(commitEnv("1"), "2")).toThrow(/does not match/);
    expect(() => decide(commitEnv("1"), "11")).toThrow(/does not match/);
    expect(() => decide({ [poll.commitGate]: "1", [COMMIT_CONFIRMATION_ENV]: confirmationFor("latest") }, "1")).toThrow(/does not match/);
  });

  it("F: a confirmation for another credential is refused", () => {
    expect(() => decide({ [poll.commitGate]: "1", [COMMIT_CONFIRMATION_ENV]: confirmationFor("1", "cred-other") }, "1")).toThrow(/does not match/);
    expect(() => decide(commitEnv("1"), "1", "cred-other")).toThrow(/does not match/);
    expect(() => decide(commitEnv("1"), "1", "")).toThrow(/identifiers are missing or malformed/);
  });

  it("G: a confirmation for another endpoint or database is refused", () => {
    for (const other of [{ endpoint: "ep-other-000009", database: DATABASE }, { endpoint: ENDPOINT, database: "postgres" }]) {
      expect(() => decide({ [poll.commitGate]: "1", [COMMIT_CONFIRMATION_ENV]: confirmationFor("1", CRED, other) }, "1")).toThrow(/does not match/);
    }
  });

  it("the quiescent statement and the exact commit flag are still required", () => {
    expect(() => decide({ [poll.commitGate]: "1", [COMMIT_CONFIRMATION_ENV]: confirmationFor("1").replace(/:quiescent$/, "") }, "1")).toThrow(/does not match/);
    expect(() => decide({ [poll.commitGate]: "1" }, "1")).toThrow(/is set but REAL_ADMIN_COMMIT_CONFIRMATION is not/);
    expect(() => decide({ [poll.commitGate]: "true", [COMMIT_CONFIRMATION_ENV]: confirmationFor("1") }, "1")).toThrow(/must be exactly 1, or unset for a dry run/);
    expect(() => decide({ [COMMIT_CONFIRMATION_ENV]: confirmationFor("1") }, "1")).toThrow(/is set without/);
  });

  // H and I, through the PRODUCTION poller with a mocked store and Turnkey port. The dispatches carry no activity id,
  // so the poller stops at its own "no_activity_id" refusal: that shows which dispatch it selected without any provider
  // request or write being possible — and both are counted anyway.
  function world(seqs: number[]) {
    const rows = seqs.map((dispatchSeq) => ({ id: `dispatch-${dispatchSeq}`, credentialId: CRED, dispatchSeq, turnkeyActivityId: null, organizationId: "parent-org", terminalStatus: null }));
    const store = {
      findDispatchesByCredentialId: vi.fn(async () => [...rows].sort((a, b) => a.dispatchSeq - b.dispatchSeq)),
      recordDispatchObservation: vi.fn(),
      recordDispatchTerminal: vi.fn(),
    };
    const port = { getActivity: vi.fn() };
    const run = async (env: Env, rawSeq: string | undefined) => {
      const { commit, dispatchSeq } = decide(env, rawSeq); // exactly what the runner does before it builds anything
      return pollProvisioningDispatch({ store: store as unknown as ProvisioningPollStore, port: port as unknown as ProvisioningActivityPort, parentOrganizationId: "parent-org", credentialId: CRED, dispatchSeq, commit });
    };
    const add = (dispatchSeq: number) => rows.push({ id: `dispatch-${dispatchSeq}`, credentialId: CRED, dispatchSeq, turnkeyActivityId: null, organizationId: "parent-org", terminalStatus: null });
    const writes = () => store.recordDispatchObservation.mock.calls.length + store.recordDispatchTerminal.mock.calls.length;
    return { store, port, run, add, writes };
  }

  it("H: a newly appearing dispatch cannot silently change the commit target", async () => {
    const w = world([1]);
    // The operator's dry run of "latest" looks at dispatch 1...
    expect((await w.run({}, undefined)).dispatchSeq).toBe(1);
    // ...then a newer dispatch appears.
    w.add(2);
    // "latest" now means dispatch 2 — which is exactly why it cannot authorize a commit:
    expect((await w.run({}, undefined)).dispatchSeq).toBe(2);
    await expect(w.run({ [poll.commitGate]: "1", [COMMIT_CONFIRMATION_ENV]: confirmationFor("latest") }, undefined)).rejects.toThrow(/"latest" is for dry runs only/);
    // A commit confirmed for dispatch 1 still selects dispatch 1, not the newer one...
    const committed = await w.run(commitEnv("1"), "1");
    expect(committed.dispatchSeq).toBe(1);
    expect(committed.dispatchId).toBe("dispatch-1");
    // ...and a confirmation for dispatch 1 never commits dispatch 2.
    await expect(w.run(commitEnv("1"), "2")).rejects.toThrow(/does not match/);
    expect(w.writes()).toBe(0);
    expect(w.port.getActivity).not.toHaveBeenCalled();
  });

  it("I: every refusal happens before the store or the provider is touched — zero reads, zero writes, zero provider requests", async () => {
    const w = world([1, 2]);
    const refusals: Array<[Env, string | undefined, RegExp]> = [
      [{ [poll.commitGate]: "1" }, undefined, /without REAL_ADMIN_DISPATCH_SEQ/],
      [{ [poll.commitGate]: "1", [COMMIT_CONFIRMATION_ENV]: confirmationFor("latest") }, undefined, /"latest" is for dry runs only/],
      [commitEnv("2"), "1", /does not match/],
      [{ [poll.commitGate]: "1", [COMMIT_CONFIRMATION_ENV]: confirmationFor("1", "cred-other") }, "1", /does not match/],
      [{ [poll.commitGate]: "1", [COMMIT_CONFIRMATION_ENV]: confirmationFor("1", CRED, { endpoint: "ep-other-000009", database: DATABASE }) }, "1", /does not match/],
      [{ [poll.commitGate]: "1" }, "1", /REAL_ADMIN_COMMIT_CONFIRMATION is not/],
      [commitEnv("0"), "0", /not a positive whole number/],
      [{}, "1x", /not a positive whole number/],
      [{ [poll.commitGate]: "yes", [COMMIT_CONFIRMATION_ENV]: confirmationFor("1") }, "1", /must be exactly 1/],
    ];
    for (const [env, rawSeq, reason] of refusals) await expect(w.run(env, rawSeq), String(reason)).rejects.toThrow(reason);
    expect(w.store.findDispatchesByCredentialId).not.toHaveBeenCalled();
    expect(w.writes()).toBe(0);
    expect(w.port.getActivity).not.toHaveBeenCalled();
  });

  it("refusals name no credential, endpoint, or confirmation", () => {
    for (const [env, rawSeq] of [[{ [poll.commitGate]: "1" }, undefined], [commitEnv("2"), "1"], [{}, "1x"]] as Array<[Env, string | undefined]>) {
      let message = "";
      try {
        decide(env, rawSeq);
      } catch (error) {
        expect(error).toBeInstanceOf(AdminRefusal);
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      for (const leak of [CRED, ENDPOINT, "quiescent:", confirmationFor("2")]) expect(message).not.toContain(leak);
    }
  });

  // L-B: the sequence is validated exactly as given. Padding is refused, never tidied into a valid sequence — and that
  // holds before the store or the provider is touched.
  it("a whitespace-padded sequence is refused before any store read or provider request; the plain form is accepted", async () => {
    const w = world([1, 2]);
    for (const padded of [" 1 ", " 1", "1 ", "\t1\t", "1\r\n", "01"]) {
      await expect(w.run({}, padded), JSON.stringify(padded)).rejects.toThrow(/REAL_ADMIN_DISPATCH_SEQ is not a positive whole number/);
      await expect(w.run(commitEnv("1"), padded), JSON.stringify(padded)).rejects.toThrow(/REAL_ADMIN_DISPATCH_SEQ is not a positive whole number/);
    }
    expect(w.store.findDispatchesByCredentialId).not.toHaveBeenCalled();
    expect(w.port.getActivity).not.toHaveBeenCalled();
    expect(w.writes()).toBe(0);
    expect((await w.run({}, "1")).dispatchSeq).toBe(1);
    expect((await w.run(commitEnv("1"), "1")).dispatchSeq).toBe(1);
  });
});

// L-A, through the PRODUCTION poller with a mocked store and Turnkey port: what a run reports, and whether it may exit successfully.
describe("poll: a requested commit that commits nothing fails the run", () => {
  const poll = ADMIN_RUNNERS.poll;
  const CRED = "cred-abc_123";
  /** One dispatch, already terminal or with no activity id — the two states the poller settles without any Turnkey evidence. */
  function world(dispatch: { terminalStatus: string | null; turnkeyActivityId: string | null }) {
    const row = { id: "dispatch-1", credentialId: CRED, dispatchSeq: 1, organizationId: "parent-org", lastObservedStatus: null, ...dispatch };
    const store = { findDispatchesByCredentialId: vi.fn(async () => [row]), recordDispatchObservation: vi.fn(), recordDispatchTerminal: vi.fn() };
    const port = { getActivity: vi.fn() };
    const run = (commit: boolean) => pollProvisioningDispatch({ store: store as unknown as ProvisioningPollStore, port: port as unknown as ProvisioningActivityPort, parentOrganizationId: "parent-org", credentialId: CRED, dispatchSeq: 1, commit });
    return { store, port, run, writes: () => store.recordDispatchObservation.mock.calls.length + store.recordDispatchTerminal.mock.calls.length };
  }

  it("dry run of an already-terminal dispatch: successful, nothing written", async () => {
    const w = world({ terminalStatus: "ACTIVITY_STATUS_COMPLETED", turnkeyActivityId: "activity-1" });
    const report = await w.run(false);
    expect(report).toMatchObject({ outcome: "refused", reason: "already_terminal", committed: false, dispatchSeq: 1 });
    expect(() => requireCommitOutcome({ runner: poll, commit: false, report })).not.toThrow();
    expect(w.writes()).toBe(0);
  });

  it("COMMIT of an already-terminal dispatch: committed=false, reported as previously processed — a failed run, not a new write and not a data error", async () => {
    const w = world({ terminalStatus: "ACTIVITY_STATUS_COMPLETED", turnkeyActivityId: "activity-1" });
    const report = await w.run(true);
    const printed = JSON.stringify(report); // what the runner prints before the outcome check
    expect(report).toMatchObject({ outcome: "refused", reason: "already_terminal", committed: false });
    let thrown: unknown;
    try {
      requireCommitOutcome({ runner: poll, commit: true, report });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AdminCommitNotApplied);
    expect((thrown as AdminCommitNotApplied).kind).toBe("previously_processed");
    expect((thrown as Error).message).toMatch(/outcome=refused reason=already_terminal \(already processed before this run: a no-op, not a new write and not a data error\)\. Not retried\./);
    expect((thrown as Error).message).not.toContain(CRED);
    expect(JSON.stringify(report)).toBe(printed); // the report is preserved
    // No further call of any kind: one read by the poller itself, no write, no provider request, no retry.
    expect(w.store.findDispatchesByCredentialId).toHaveBeenCalledTimes(1);
    expect(w.writes()).toBe(0);
    expect(w.port.getActivity).not.toHaveBeenCalled();
  });

  it("COMMIT where the evidence does not allow one (no stored activity id): a failed run, reported as declined — not as previously processed", async () => {
    const w = world({ terminalStatus: null, turnkeyActivityId: null });
    const report = await w.run(true);
    expect(report).toMatchObject({ outcome: "refused", reason: "no_activity_id", committed: false });
    expect(() => requireCommitOutcome({ runner: poll, commit: true, report })).toThrow(/outcome=refused reason=no_activity_id \(the evidence or input did not allow a commit: nothing was changed\)/);
    expect(w.writes()).toBe(0);
    expect(w.port.getActivity).not.toHaveBeenCalled();
  });

  it.each<[string, { outcome: "refused" | "pending" | "terminal"; reason: string | null; committed: boolean }, RegExp | null]>([
    ["a recorded pending observation", { outcome: "pending", reason: null, committed: true }, null],
    ["a recorded terminal observation", { outcome: "terminal", reason: null, committed: true }, null],
    ["a pending observation the store did not record", { outcome: "pending", reason: "observation_not_recorded", committed: false }, /uncertain or changed underneath this run: read again/],
    ["a terminal observation the store did not record", { outcome: "terminal", reason: "observation_not_recorded", committed: false }, /uncertain or changed underneath this run/],
    ["a failed Turnkey read", { outcome: "refused", reason: "turnkey_read_failed", committed: false }, /uncertain or changed underneath this run/],
    ["an activity that is not this dispatch's", { outcome: "refused", reason: "activity_identity_mismatch", committed: false }, /did not allow a commit/],
    ["a missing dispatch", { outcome: "refused", reason: "dispatch_not_found", committed: false }, /did not allow a commit/],
  ])("poll commit — %s: success only when committed=true", (_name, report, failure) => {
    if (failure === null) expect(() => requireCommitOutcome({ runner: poll, commit: true, report })).not.toThrow();
    else expect(() => requireCommitOutcome({ runner: poll, commit: true, report })).toThrow(failure);
  });
});
