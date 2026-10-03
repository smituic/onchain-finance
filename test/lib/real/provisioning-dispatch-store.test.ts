import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { claimWithEvidence, completedObservation, failedObservation, seedTurnkeyCreatedThroughEvidence } from "./fixtures/provisioning-seed";
import {
  createInMemoryRegistrationAttemptStore,
  type DispatchTerminalObservation,
  type ProvisioningDispatch,
  type ProvisioningDispatchEvidence,
  type RegistrationAttemptStore,
} from "@/lib/real/server/registration-attempts";

/**
 * Provisioning Evidence Capture — the in-memory adapter's dispatch-evidence
 * semantics (the twin of schema.sql's constraints and the Neon adapter's
 * write-once WHERE guards; those are covered by
 * neon-provisioning-dispatch.test.ts offline and the gated smoke live).
 */
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function evidence(body: string, overrides: Partial<ProvisioningDispatchEvidence> = {}): ProvisioningDispatchEvidence {
  return { evidenceVersion: 1, organizationId: "parent-org", stampPublicKey: "02abc", requestTimestampMs: 1790204988123, requestBody: body, requestBodySha256: sha(body), ...overrides };
}

let seq = 0;
async function verified(store: RegistrationAttemptStore) {
  seq += 1;
  return store.createVerified({
    credentialId: `cred-${seq}`,
    appUserId: `app-user-${seq}`,
    userHandle: `handle-${seq}`,
    credentialPublicKey: `cose-${seq}`,
    counter: 0,
    transports: ["internal"],
    credentialDeviceType: "singleDevice",
    credentialBackedUp: false,
    registrationChallenge: `challenge-${seq}`,
    rawClientDataJson: "client-data",
    rawAttestationObject: "attestation",
  });
}

const IDENTITY = { subOrganizationId: "sub-org-1", turnkeyUserId: "turnkey-user-1", walletId: "wallet-1", walletAccountId: "wallet-account-1", ownerAddress: "0xF6C3FE6DE636f0d8f421d5485D1a64fF3628CFaF" };

const IMMUTABLE: Array<keyof ProvisioningDispatch> = ["id", "credentialId", "dispatchSeq", "evidenceVersion", "organizationId", "stampPublicKey", "requestTimestampMs", "requestBody", "requestBodySha256", "createdAt"];
const pick = (row: ProvisioningDispatch, keys: Array<keyof ProvisioningDispatch>) => Object.fromEntries(keys.map((key) => [key, row[key]]));

const completed: DispatchTerminalObservation = {
  status: "ACTIVITY_STATUS_COMPLETED",
  observedBy: "dispatch",
  turnkeyCreatedAt: "2026-09-24T00:00:00.000Z",
  observedSubOrganizationId: "sub-org-1",
  observedRootUserId: "turnkey-user-1",
  observedWalletId: "wallet-1",
  observedOwnerAddress: "0xF6C3FE6DE636f0d8f421d5485D1a64fF3628CFaF",
  failureCode: null,
  failureMessage: null,
  intentVerdict: "exact",
  fingerprintVerdict: "match",
  voteVerdict: "parent_key",
};
const failed: DispatchTerminalObservation = {
  ...completed,
  status: "ACTIVITY_STATUS_FAILED",
  observedSubOrganizationId: null,
  observedRootUserId: null,
  observedWalletId: null,
  observedOwnerAddress: null,
  failureCode: 3,
  failureMessage: "invalid authenticator attestation",
};

describe("beginProvisioningDispatch: ONE step — the claim and the evidence row, or neither", () => {
  it("claims verified -> provisioning_in_flight / unknown and inserts exactly one row holding the exact body", async () => {
    const store = createInMemoryRegistrationAttemptStore();
    const attempt = await verified(store);
    const begun = await store.beginProvisioningDispatch({ credentialId: attempt.credentialId, attemptedAt: "2026-09-24T00:00:00.000Z", evidence: evidence("body-A") });

    expect(begun?.attempt).toMatchObject({ state: "provisioning_in_flight", externalOutcome: "unknown", externalProvisioningAttemptedAt: "2026-09-24T00:00:00.000Z" });
    expect(begun?.dispatch).toMatchObject({ credentialId: attempt.credentialId, dispatchSeq: 1, requestBody: "body-A", requestBodySha256: sha("body-A"), turnkeyActivityId: null, terminalStatus: null, lastObservedStatus: null });
    expect(await store.findByCredentialId(attempt.credentialId)).toEqual(begun?.attempt);
    expect(await store.findDispatchesByCredentialId(attempt.credentialId)).toEqual([begun?.dispatch]);
  });

  it.each(["provisioning_in_flight", "turnkey_created", "blocked"] as const)("an attempt that is not 'verified' (%s): null, no new row", async (state) => {
    const store = createInMemoryRegistrationAttemptStore();
    const attempt = await verified(store);
    if (state === "provisioning_in_flight") await claimWithEvidence(store, attempt.credentialId);
    else {
      await seedTurnkeyCreatedThroughEvidence(store, attempt.credentialId, IDENTITY);
      if (state === "blocked") await store.transition({ credentialId: attempt.credentialId, from: "turnkey_created", to: "blocked", patch: { blockReason: "x" } });
    }
    const before = await store.findDispatchesByCredentialId(attempt.credentialId);
    expect(await store.beginProvisioningDispatch({ credentialId: attempt.credentialId, attemptedAt: new Date().toISOString(), evidence: evidence(`body-${state}`) })).toBeNull();
    expect(await store.findDispatchesByCredentialId(attempt.credentialId)).toEqual(before);
    expect(await store.beginProvisioningDispatch({ credentialId: "no-such-credential", attemptedAt: new Date().toISOString(), evidence: evidence("body-x") })).toBeNull();
  });

  it.each([
    ["a digest that is not 64 lowercase hex", evidence("b1", { requestBodySha256: sha("b1").toUpperCase() })],
    ["a digest of some OTHER bytes", evidence("b2", { requestBodySha256: sha("b2 ") })],
    ["an empty body", { ...evidence("b3"), requestBody: "", requestBodySha256: sha("") }],
    ["a non-integer timestamp", evidence("b4", { requestTimestampMs: 1.5 })],
    ["a missing organization id", evidence("b5", { organizationId: "" })],
  ])("%s: throws, the attempt stays 'verified', nothing is inserted", async (_label, bad) => {
    const store = createInMemoryRegistrationAttemptStore();
    const attempt = await verified(store);
    await expect(store.beginProvisioningDispatch({ credentialId: attempt.credentialId, attemptedAt: new Date().toISOString(), evidence: bad })).rejects.toThrow(/Provisioning dispatch evidence/);
    expect((await store.findByCredentialId(attempt.credentialId))?.state).toBe("verified");
    expect(await store.findDispatchesByCredentialId(attempt.credentialId)).toEqual([]);
  });

  it("a body digest that already exists on ANY dispatch is refused — the same request is never recorded twice", async () => {
    const store = createInMemoryRegistrationAttemptStore();
    const first = await verified(store);
    const second = await verified(store);
    await store.beginProvisioningDispatch({ credentialId: first.credentialId, attemptedAt: new Date().toISOString(), evidence: evidence("same-body") });
    await expect(store.beginProvisioningDispatch({ credentialId: second.credentialId, attemptedAt: new Date().toISOString(), evidence: evidence("same-body") })).rejects.toThrow(/already recorded/);
    expect((await store.findByCredentialId(second.credentialId))?.state).toBe("verified");
  });

  it("at most ONE open dispatch per attempt: with a dispatch unresolved, no API can return the attempt to 'verified' — so no second row can ever be claimed", async () => {
    const store = createInMemoryRegistrationAttemptStore();
    const attempt = await verified(store);
    const { dispatchId, activityId } = await claimWithEvidence(store, attempt.credentialId);
    await expect(store.transition({ credentialId: attempt.credentialId, from: "provisioning_in_flight", to: "verified" })).rejects.toThrow(/provisioning_in_flight/);
    expect(await store.revertProvisioningAfterDefinitiveFailure({ credentialId: attempt.credentialId, dispatchId, activityId })).toBeNull(); // not terminal
    expect(await store.beginProvisioningDispatch({ credentialId: attempt.credentialId, attemptedAt: new Date().toISOString(), evidence: evidence("open-2") })).toBeNull();
    expect((await store.findByCredentialId(attempt.credentialId))?.state).toBe("provisioning_in_flight");
    expect(await store.findDispatchesByCredentialId(attempt.credentialId)).toHaveLength(1);
  });

  it("dispatch_seq counts up per attempt; a later dispatch never overwrites or alters an earlier one", async () => {
    const store = createInMemoryRegistrationAttemptStore();
    const attempt = await verified(store);
    const one = (await store.beginProvisioningDispatch({ credentialId: attempt.credentialId, attemptedAt: new Date().toISOString(), evidence: evidence("seq-1") }))!.dispatch;
    await store.recordDispatchActivity({ dispatchId: one.id, activityId: "activity-1", fingerprint: null });
    await store.recordDispatchTerminal({ dispatchId: one.id, activityId: "activity-1", observation: failed });
    expect(await store.revertProvisioningAfterDefinitiveFailure({ credentialId: attempt.credentialId, dispatchId: one.id, activityId: "activity-1" })).toMatchObject({ state: "verified", externalOutcome: "definitive_failure" });
    const firstAfterFailure = (await store.findDispatchesByCredentialId(attempt.credentialId))[0];

    const two = (await store.beginProvisioningDispatch({ credentialId: attempt.credentialId, attemptedAt: new Date().toISOString(), evidence: evidence("seq-2") }))!.dispatch;
    expect(two.dispatchSeq).toBe(2);
    expect(two.id).not.toBe(one.id);
    const rows = await store.findDispatchesByCredentialId(attempt.credentialId);
    expect(rows.map((row) => row.dispatchSeq)).toEqual([1, 2]);
    expect(rows[0]).toEqual(firstAfterFailure);
    // Another attempt's sequence is independent.
    const other = await verified(store);
    expect((await store.beginProvisioningDispatch({ credentialId: other.credentialId, attemptedAt: new Date().toISOString(), evidence: evidence("other-1") }))!.dispatch.dispatchSeq).toBe(1);
  });

  it("concurrent claims for one attempt: exactly one wins", async () => {
    const store = createInMemoryRegistrationAttemptStore();
    const attempt = await verified(store);
    const results = await Promise.all(["c1", "c2", "c3", "c4"].map((body) => store.beginProvisioningDispatch({ credentialId: attempt.credentialId, attemptedAt: new Date().toISOString(), evidence: evidence(body) })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.findDispatchesByCredentialId(attempt.credentialId)).toHaveLength(1);
  });
});

async function begun(body = `body-${Math.random()}`) {
  const store = createInMemoryRegistrationAttemptStore();
  const attempt = await verified(store);
  const { dispatch } = (await store.beginProvisioningDispatch({ credentialId: attempt.credentialId, attemptedAt: new Date().toISOString(), evidence: evidence(body) }))!;
  const row = async () => (await store.findDispatchesByCredentialId(attempt.credentialId))[0]!;
  return { store, attempt, dispatch, row };
}

describe("recordDispatchActivity: first writer wins", () => {
  it("records the id and Turnkey's fingerprint verbatim; a replay of the SAME id is idempotent and changes nothing", async () => {
    const w = await begun();
    const first = await w.store.recordDispatchActivity({ dispatchId: w.dispatch.id, activityId: "activity-1", fingerprint: "sha256:abc" });
    expect(first).toMatchObject({ outcome: "recorded", dispatch: { turnkeyActivityId: "activity-1", turnkeyActivityFingerprint: "sha256:abc" } });
    const snapshot = await w.row();
    expect(snapshot.activityRecordedAt).toBeTruthy();

    const replay = await w.store.recordDispatchActivity({ dispatchId: w.dispatch.id, activityId: "activity-1", fingerprint: "sha256:DIFFERENT" });
    expect(replay.outcome).toBe("already_recorded");
    expect(await w.row()).toEqual(snapshot); // not even the fingerprint is rewritten
  });

  it("a DIFFERENT id can never replace the recorded one", async () => {
    const w = await begun();
    await w.store.recordDispatchActivity({ dispatchId: w.dispatch.id, activityId: "activity-1", fingerprint: null });
    const snapshot = await w.row();
    const second = await w.store.recordDispatchActivity({ dispatchId: w.dispatch.id, activityId: "activity-2", fingerprint: "x" });
    expect(second).toMatchObject({ outcome: "mismatch", dispatch: { turnkeyActivityId: "activity-1" } });
    expect(await w.row()).toEqual(snapshot);
  });

  it("an unknown dispatch is 'not_found'; one activity id cannot be recorded on two dispatches", async () => {
    const w = await begun();
    expect(await w.store.recordDispatchActivity({ dispatchId: "00000000-0000-4000-8000-000000000000", activityId: "a", fingerprint: null })).toEqual({ outcome: "not_found" });
    await w.store.recordDispatchActivity({ dispatchId: w.dispatch.id, activityId: "activity-shared", fingerprint: null });
    const other = await verified(w.store);
    const second = (await w.store.beginProvisioningDispatch({ credentialId: other.credentialId, attemptedAt: new Date().toISOString(), evidence: evidence("another-body") }))!.dispatch;
    await expect(w.store.recordDispatchActivity({ dispatchId: second.id, activityId: "activity-shared", fingerprint: null })).rejects.toThrow(/unique/);
    expect((await w.store.findDispatchesByCredentialId(other.credentialId))[0]!.turnkeyActivityId).toBeNull();
  });
});

describe("recordDispatchTerminal: write-once, tied to the recorded activity id", () => {
  it("refuses without a recorded activity id, and for any other id", async () => {
    const w = await begun();
    expect((await w.store.recordDispatchTerminal({ dispatchId: w.dispatch.id, activityId: "activity-1", observation: completed })).outcome).toBe("activity_mismatch");
    await w.store.recordDispatchActivity({ dispatchId: w.dispatch.id, activityId: "activity-1", fingerprint: null });
    expect((await w.store.recordDispatchTerminal({ dispatchId: w.dispatch.id, activityId: "activity-2", observation: completed })).outcome).toBe("activity_mismatch");
    expect((await w.row()).terminalStatus).toBeNull();
    expect(await w.store.recordDispatchTerminal({ dispatchId: "00000000-0000-4000-8000-000000000000", activityId: "activity-1", observation: completed })).toEqual({ outcome: "not_found" });
  });

  it("records the terminal group once; a second terminal observation (same or different) rewrites nothing", async () => {
    const w = await begun();
    await w.store.recordDispatchActivity({ dispatchId: w.dispatch.id, activityId: "activity-1", fingerprint: "sha256:abc" });
    const first = await w.store.recordDispatchTerminal({ dispatchId: w.dispatch.id, activityId: "activity-1", observation: completed });
    expect(first).toMatchObject({ outcome: "recorded", dispatch: { terminalStatus: "ACTIVITY_STATUS_COMPLETED", terminalObservedBy: "dispatch", observedSubOrganizationId: "sub-org-1", lastObservedStatus: "ACTIVITY_STATUS_COMPLETED" } });
    const snapshot = await w.row();

    for (const observation of [completed, failed, { ...completed, observedBy: "operator_poll" as const, observedSubOrganizationId: "sub-org-OTHER" }]) {
      expect((await w.store.recordDispatchTerminal({ dispatchId: w.dispatch.id, activityId: "activity-1", observation })).outcome).toBe("already_terminal");
      expect(await w.row()).toEqual(snapshot);
    }
  });

  it("the constraint twins: observed result ids only with COMPLETED, a failure only with FAILED/REJECTED, a bounded failure message", async () => {
    const w = await begun();
    await w.store.recordDispatchActivity({ dispatchId: w.dispatch.id, activityId: "activity-1", fingerprint: null });
    const record = (observation: DispatchTerminalObservation) => w.store.recordDispatchTerminal({ dispatchId: w.dispatch.id, activityId: "activity-1", observation });
    await expect(record({ ...failed, observedSubOrganizationId: "sub-org-1" })).rejects.toThrow(/COMPLETED/);
    await expect(record({ ...completed, failureCode: 3 })).rejects.toThrow(/FAILED\/REJECTED/);
    await expect(record({ ...failed, failureMessage: "m".repeat(501) })).rejects.toThrow(/too long/);
    expect((await w.row()).terminalStatus).toBeNull();
    expect((await record({ ...failed, failureMessage: "m".repeat(500) })).outcome).toBe("recorded");
  });
});

describe("recordDispatchObservation: mutable metadata only", () => {
  it("needs the recorded activity id, only touches lastObserved*, and stops once the dispatch is terminal", async () => {
    const w = await begun();
    expect(await w.store.recordDispatchObservation({ dispatchId: w.dispatch.id, activityId: "activity-1", status: "ACTIVITY_STATUS_PENDING" })).toBe(false);
    await w.store.recordDispatchActivity({ dispatchId: w.dispatch.id, activityId: "activity-1", fingerprint: null });
    const before = await w.row();
    expect(await w.store.recordDispatchObservation({ dispatchId: w.dispatch.id, activityId: "activity-OTHER", status: "ACTIVITY_STATUS_PENDING" })).toBe(false);
    expect(await w.store.recordDispatchObservation({ dispatchId: w.dispatch.id, activityId: "activity-1", status: "ACTIVITY_STATUS_PENDING" })).toBe(true);
    const after = await w.row();
    expect({ ...after, lastObservedStatus: null, lastObservedAt: null, updatedAt: "" }).toEqual({ ...before, lastObservedStatus: null, lastObservedAt: null, updatedAt: "" });
    expect(after.lastObservedStatus).toBe("ACTIVITY_STATUS_PENDING");

    await w.store.recordDispatchTerminal({ dispatchId: w.dispatch.id, activityId: "activity-1", observation: completed });
    expect(await w.store.recordDispatchObservation({ dispatchId: w.dispatch.id, activityId: "activity-1", status: "ACTIVITY_STATUS_PENDING" })).toBe(false);
    expect((await w.row()).lastObservedStatus).toBe("ACTIVITY_STATUS_COMPLETED");
  });
});

describe("the request evidence is immutable", () => {
  it("no store operation changes an immutable column, whatever it is asked to record", async () => {
    const w = await begun("immutable-body");
    const original = pick(await w.row(), IMMUTABLE);
    await w.store.recordDispatchActivity({ dispatchId: w.dispatch.id, activityId: "activity-1", fingerprint: "sha256:abc" });
    await w.store.recordDispatchActivity({ dispatchId: w.dispatch.id, activityId: "activity-2", fingerprint: "x" });
    await w.store.recordDispatchObservation({ dispatchId: w.dispatch.id, activityId: "activity-1", status: "ACTIVITY_STATUS_PENDING" });
    await w.store.recordDispatchTerminal({ dispatchId: w.dispatch.id, activityId: "activity-1", observation: completed });
    await w.store.recordDispatchTerminal({ dispatchId: w.dispatch.id, activityId: "activity-1", observation: failed });
    await w.store.revertProvisioningAfterDefinitiveFailure({ credentialId: w.attempt.credentialId, dispatchId: w.dispatch.id, activityId: "activity-1" });
    await w.store.advanceProvisioningToTurnkeyCreated({ credentialId: w.attempt.credentialId, dispatchId: w.dispatch.id, activityId: "activity-1", identity: IDENTITY });
    await w.store.updateCounter({ credentialId: w.attempt.credentialId, counter: 9 });
    expect(pick(await w.row(), IMMUTABLE)).toEqual(original);
    expect(original.requestBody).toBe("immutable-body");
  });

  it("rows handed out are copies: mutating one cannot change the stored evidence", async () => {
    const w = await begun("copy-body");
    const handed = await w.row();
    handed.requestBody = "tampered";
    handed.requestBodySha256 = "0".repeat(64);
    w.dispatch.requestBody = "tampered-too";
    expect((await w.row()).requestBody).toBe("copy-body");
    expect((await w.row()).requestBodySha256).toBe(sha("copy-body"));
  });

  it("the store interface offers no way to write request evidence after the insert", () => {
    const methods = Object.keys(createInMemoryRegistrationAttemptStore()).sort();
    expect(methods).toEqual(
      [
        "advanceProvisioningToTurnkeyCreated",
        "beginProvisioningDispatch",
        "createVerified",
        "finalize",
        "findByCredentialId",
        "findDispatchesByCredentialId",
        "recordDispatchActivity",
        "recordDispatchObservation",
        "recordDispatchTerminal",
        "revertProvisioningAfterDefinitiveFailure",
        "transition",
        "updateCounter",
      ].sort(),
    );
  });
});

describe("L1: 'provisioning_in_flight' is claim-only", () => {
  it("the generic transition() can neither enter nor leave it — for any partner state", async () => {
    const store = createInMemoryRegistrationAttemptStore();
    const attempt = await verified(store);
    for (const from of ["verified", "turnkey_created", "blocked"] as const) {
      await expect(store.transition({ credentialId: attempt.credentialId, from, to: "provisioning_in_flight" }), from).rejects.toThrow(/only through beginProvisioningDispatch/);
    }
    await claimWithEvidence(store, attempt.credentialId);
    for (const to of ["verified", "turnkey_created", "blocked"] as const) {
      await expect(store.transition({ credentialId: attempt.credentialId, from: "provisioning_in_flight", to }), to).rejects.toThrow(/only through beginProvisioningDispatch/);
    }
    // "active" stays finalize-only.
    await expect(store.transition({ credentialId: attempt.credentialId, from: "provisioning_in_flight", to: "active" })).rejects.toThrow(/only through finalize/);
    expect((await store.findByCredentialId(attempt.credentialId))?.state).toBe("provisioning_in_flight");
  });
});

describe("L1: revertProvisioningAfterDefinitiveFailure — only on the in-process evidence of a definitive failure", () => {
  async function terminal(observation: DispatchTerminalObservation) {
    const store = createInMemoryRegistrationAttemptStore();
    const attempt = await verified(store);
    const ids = await claimWithEvidence(store, attempt.credentialId);
    await store.recordDispatchTerminal({ ...ids, observation });
    const revert = (overrides: Partial<{ dispatchId: string; activityId: string; credentialId: string }> = {}) =>
      store.revertProvisioningAfterDefinitiveFailure({ credentialId: attempt.credentialId, ...ids, ...overrides });
    return { store, attempt, ids, revert };
  }

  it.each(["ACTIVITY_STATUS_FAILED", "ACTIVITY_STATUS_REJECTED"] as const)("an exact in-process %s reverts to 'verified' / definitive_failure", async (status) => {
    const w = await terminal(failedObservation({ status }));
    expect(await w.revert()).toMatchObject({ state: "verified", externalOutcome: "definitive_failure" });
  });

  it("fields_only intent reverts only with a MATCHING fingerprint", async () => {
    expect(await (await terminal(failedObservation({ intentVerdict: "fields_only", fingerprintVerdict: "match" }))).revert()).not.toBeNull();
    expect(await (await terminal(failedObservation({ intentVerdict: "fields_only", fingerprintVerdict: "unrecognized_form" }))).revert()).toBeNull();
    expect(await (await terminal(failedObservation({ intentVerdict: "exact", fingerprintVerdict: "unrecognized_form" }))).revert()).not.toBeNull();
  });

  it.each([
    ["an operator-recorded FAILED", failedObservation({ observedBy: "operator_poll" })],
    ["an intent mismatch", failedObservation({ intentVerdict: "mismatch" })],
    ["a fingerprint mismatch", failedObservation({ fingerprintVerdict: "mismatch" })],
    ["a COMPLETED activity", completedObservation(IDENTITY)],
  ])("%s can NOT revert: null, attempt unchanged", async (_label, observation) => {
    const w = await terminal(observation);
    expect(await w.revert()).toBeNull();
    expect((await w.store.findByCredentialId(w.attempt.credentialId))?.state).toBe("provisioning_in_flight");
  });

  it("an activity-id mismatch, another dispatch id, or another attempt can NOT revert", async () => {
    const w = await terminal(failedObservation());
    expect(await w.revert({ activityId: "activity-OTHER" })).toBeNull();
    expect(await w.revert({ dispatchId: "00000000-0000-4000-8000-000000000000" })).toBeNull();
    const other = await verified(w.store);
    expect(await w.revert({ credentialId: other.credentialId })).toBeNull();
    expect((await w.store.findByCredentialId(w.attempt.credentialId))?.state).toBe("provisioning_in_flight");
  });

  it("a non-terminal dispatch can NOT revert", async () => {
    const store = createInMemoryRegistrationAttemptStore();
    const attempt = await verified(store);
    const ids = await claimWithEvidence(store, attempt.credentialId);
    expect(await store.revertProvisioningAfterDefinitiveFailure({ credentialId: attempt.credentialId, ...ids })).toBeNull();
  });

  it("a STALE dispatch (not the attempt's newest) can NOT revert, and a revert is single-use", async () => {
    const w = await terminal(failedObservation());
    expect(await w.revert()).not.toBeNull();
    expect(await w.revert()).toBeNull(); // the attempt is no longer in flight
    // A new dispatch: the old FAILED evidence no longer speaks for the attempt.
    const second = await claimWithEvidence(w.store, w.attempt.credentialId);
    await w.store.recordDispatchTerminal({ ...second, observation: failedObservation({ observedBy: "operator_poll" }) });
    expect(await w.revert()).toBeNull();
    expect((await w.store.findByCredentialId(w.attempt.credentialId))?.state).toBe("provisioning_in_flight");
  });
});

describe("L1: advanceProvisioningToTurnkeyCreated — only on the in-process evidence of a validated COMPLETED", () => {
  async function completed(observation: DispatchTerminalObservation) {
    const store = createInMemoryRegistrationAttemptStore();
    const attempt = await verified(store);
    const ids = await claimWithEvidence(store, attempt.credentialId);
    await store.recordDispatchTerminal({ ...ids, observation });
    const advance = (identity = IDENTITY, overrides: Partial<{ dispatchId: string; activityId: string }> = {}) =>
      store.advanceProvisioningToTurnkeyCreated({ credentialId: attempt.credentialId, ...ids, ...overrides, identity });
    return { store, attempt, advance };
  }

  it("exact in-process COMPLETED with matching observed ids -> turnkey_created with the given identity", async () => {
    const w = await completed(completedObservation(IDENTITY));
    expect(await w.advance()).toMatchObject({ state: "turnkey_created", externalOutcome: "confirmed_created", ...IDENTITY });
  });

  it.each([
    ["fields_only intent (even with a matching fingerprint)", completedObservation(IDENTITY, { intentVerdict: "fields_only" })],
    ["an operator-recorded COMPLETED", completedObservation(IDENTITY, { observedBy: "operator_poll" })],
    ["a fingerprint mismatch", completedObservation(IDENTITY, { fingerprintVerdict: "mismatch" })],
    ["a FAILED activity", failedObservation()],
  ])("%s can NOT advance", async (_label, observation) => {
    const w = await completed(observation);
    expect(await w.advance()).toBeNull();
    expect((await w.store.findByCredentialId(w.attempt.credentialId))?.state).toBe("provisioning_in_flight");
  });

  it.each(["subOrganizationId", "turnkeyUserId", "walletId", "ownerAddress"] as const)("an identity whose %s differs from the observed evidence can NOT advance", async (field) => {
    const w = await completed(completedObservation(IDENTITY));
    expect(await w.advance({ ...IDENTITY, [field]: field === "ownerAddress" ? IDENTITY.ownerAddress.toLowerCase() : `${IDENTITY[field]}-other` })).toBeNull();
    expect((await w.store.findByCredentialId(w.attempt.credentialId))).toMatchObject({ state: "provisioning_in_flight", subOrganizationId: null });
  });

  it("another activity id or dispatch id can NOT advance; an advance is single-use", async () => {
    const w = await completed(completedObservation(IDENTITY));
    expect(await w.advance(IDENTITY, { activityId: "activity-OTHER" })).toBeNull();
    expect(await w.advance(IDENTITY, { dispatchId: "00000000-0000-4000-8000-000000000000" })).toBeNull();
    expect(await w.advance()).not.toBeNull();
    expect(await w.advance()).toBeNull();
  });
});
