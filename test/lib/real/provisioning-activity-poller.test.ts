import { describe, expect, it } from "vitest";
import { bytesToBase64Url, randomBytes } from "@/lib/real/bytes";
import type { RealServerConfig } from "@/lib/real/server/config";
import {
  createProvisioningActivityPort,
  pollProvisioningDispatch,
  redactPollReport,
  type ProvisioningActivityPort,
  type ProvisioningPollStore,
} from "@/lib/real/server/provisioning-activity-poller";
import { runProvisioningDispatch } from "@/lib/real/server/provisioning-dispatch";
import { createInMemoryRegistrationAttemptStore, type RegistrationAttemptStore } from "@/lib/real/server/registration-attempts";
import type { ParentActivityRead } from "@/lib/real/server/turnkey-provisioning";
import { CREATE_PATH, FAKE_OWNER_ADDRESS, FakeParentTurnkey, GET_ACTIVITY_PATH, type FakeSubmitMode } from "./fixtures/turnkey-parent-fake";

/**
 * Provisioning Evidence Capture — the OPERATOR-ONLY, RECORD-ONLY exact-id
 * poller. Offline. What matters here is as much what it cannot do as what it
 * does: one exact-id read at most, no write but the observation, and never
 * any change to the registration attempt.
 */
const config: RealServerConfig = {
  turnkeyApiBaseUrl: "https://api.turnkey.com",
  turnkeyParentOrganizationId: "parent-org",
  turnkeyApiPublicKey: "pub",
  turnkeyApiPrivateKey: "priv",
  sessionSecret: "test-secret",
  rpId: "localhost",
  rpName: "Test",
  expectedOrigins: ["http://localhost:3000"],
  rpcUrl: "https://sepolia.base.org",
  pimlicoApiKey: "pim_test_key",
};

let seq = 0;
/** An attempt left "provisioning_in_flight" by a real in-process dispatch in the given mode. */
async function stuck(mode: FakeSubmitMode = "pending") {
  seq += 1;
  const attempts = createInMemoryRegistrationAttemptStore();
  const turnkey = new FakeParentTurnkey();
  turnkey.submitMode = mode;
  turnkey.completeAfterReads = Number.POSITIVE_INFINITY;
  const credentialId = bytesToBase64Url(randomBytes(16));
  const attempt = await attempts.createVerified({
    credentialId,
    appUserId: `0b5c0c7e-6d9b-4f43-9a2e-${String(seq).padStart(12, "0")}`,
    userHandle: `handle-${seq}`,
    credentialPublicKey: `cose-${seq}`,
    counter: 0,
    transports: ["internal"],
    credentialDeviceType: "singleDevice",
    credentialBackedUp: false,
    registrationChallenge: `challenge-${seq}`,
    rawClientDataJson: "client-data-json",
    rawAttestationObject: "attestation-object",
  });
  let t = 1_790_000_000_000;
  await runProvisioningDispatch({ config, attempts, attempt, deps: turnkey.deps({ now: () => t, sleep: async (ms) => void (t += ms) }) });
  turnkey.requests.length = 0;

  const portCalls: Array<{ organizationId: string; activityId: string }> = [];
  const realPort = createProvisioningActivityPort(config, turnkey.deps());
  const port: ProvisioningActivityPort = {
    getActivity: async (input) => {
      portCalls.push(input);
      return realPort.getActivity(input);
    },
  };
  const row = async () => (await attempts.findDispatchesByCredentialId(credentialId))[0]!;
  const current = async () => (await attempts.findByCredentialId(credentialId))!;
  const poll = (overrides: Partial<Parameters<typeof pollProvisioningDispatch>[0]> = {}) =>
    pollProvisioningDispatch({ store: attempts, port, parentOrganizationId: "parent-org", credentialId, commit: false, ...overrides });
  return { attempts, turnkey, credentialId, port, portCalls, row, current, poll };
}

/** Everything durable, for "nothing changed" assertions. */
const snapshot = async (w: Awaited<ReturnType<typeof stuck>>) => ({ attempt: await w.current(), rows: await w.attempts.findDispatchesByCredentialId(w.credentialId) });

describe("refusals that never reach Turnkey", () => {
  it("invalid input", async () => {
    const w = await stuck();
    expect(await w.poll({ credentialId: "" })).toMatchObject({ outcome: "refused", reason: "invalid_input", committed: false });
    expect(await w.poll({ parentOrganizationId: "" })).toMatchObject({ outcome: "refused", reason: "invalid_input" });
    for (const dispatchSeq of [0, -1, 1.5, Number.NaN]) expect(await w.poll({ dispatchSeq })).toMatchObject({ outcome: "refused", reason: "invalid_input" });
    expect(w.portCalls).toEqual([]);
  });

  it("no dispatch for that credential, or no such sequence number", async () => {
    const w = await stuck();
    expect(await w.poll({ credentialId: "unknown-credential" })).toMatchObject({ outcome: "refused", reason: "dispatch_not_found" });
    expect(await w.poll({ dispatchSeq: 2 })).toMatchObject({ outcome: "refused", reason: "dispatch_not_found" });
    expect(w.portCalls).toEqual([]);
  });

  it("a dispatch WITHOUT a recorded activity id is never searched for: refused, zero reads", async () => {
    const w = await stuck("lose_response_after_apply"); // Turnkey did create it — and the poller still does not go looking
    expect((await w.row()).turnkeyActivityId).toBeNull();
    const before = await snapshot(w);
    expect(await w.poll({ commit: true })).toMatchObject({ outcome: "refused", reason: "no_activity_id", committed: false, activityId: null });
    expect(w.portCalls).toEqual([]);
    expect(w.turnkey.requests).toEqual([]);
    expect(await snapshot(w)).toEqual(before);
  });

  it("the stored organization must be the configured parent organization", async () => {
    const w = await stuck();
    expect(await w.poll({ parentOrganizationId: "some-other-org", commit: true })).toMatchObject({ outcome: "refused", reason: "organization_mismatch" });
    expect(w.portCalls).toEqual([]);
  });

  it("an already-terminal dispatch: nothing left to record, zero reads", async () => {
    const w = await stuck("failed");
    expect((await w.row()).terminalStatus).toBe("ACTIVITY_STATUS_FAILED");
    expect(await w.poll({ commit: true })).toMatchObject({ outcome: "refused", reason: "already_terminal", status: "ACTIVITY_STATUS_FAILED", committed: false });
    expect(w.portCalls).toEqual([]);
  });
});

describe("the one read: the stored activity id, in the stored organization", () => {
  it("reads exactly once, by exactly the stored id — and the wire request is a get_activity for that id only", async () => {
    const w = await stuck();
    await w.poll();
    expect(w.portCalls).toEqual([{ organizationId: "parent-org", activityId: "activity-1" }]);
    expect(w.turnkey.requests.map((r) => r.path)).toEqual([GET_ACTIVITY_PATH]);
    expect(JSON.parse(w.turnkey.requests[0]!.body)).toEqual({ organizationId: "parent-org", activityId: "activity-1" });
    expect(w.turnkey.requests[0]!.hasSignal).toBe(true);
  });

  it("the operator cannot supply an activity id: the function takes none", async () => {
    const w = await stuck();
    // @ts-expect-error — there is deliberately no activityId input
    await w.poll({ activityId: "activity-INJECTED" });
    expect(w.portCalls).toEqual([{ organizationId: "parent-org", activityId: "activity-1" }]);
  });

  it("'not found' for a STORED id is an anomaly — reported, nothing written, no conclusion drawn", async () => {
    const w = await stuck();
    w.turnkey.getActivityMode = "not_found";
    const before = await snapshot(w);
    expect(await w.poll({ commit: true })).toMatchObject({ outcome: "refused", reason: "turnkey_activity_not_found", committed: false });
    expect(await snapshot(w)).toEqual(before);
    expect((await w.current()).state).toBe("provisioning_in_flight");
  });

  it("a read error or timeout: refused, nothing written, not retried", async () => {
    const w = await stuck();
    w.turnkey.getActivityMode = "error";
    const before = await snapshot(w);
    expect(await w.poll({ commit: true })).toMatchObject({ outcome: "refused", reason: "turnkey_read_failed" });
    expect(w.portCalls).toHaveLength(1);
    expect(await snapshot(w)).toEqual(before);
  });

  it.each([
    ["another activity id", { id: "activity-OTHER" }],
    ["another organization", { organizationId: "another-org" }],
    ["another activity type", { type: "ACTIVITY_TYPE_CREATE_USERS_V3" }],
  ])("an answer naming %s is not this dispatch's activity: refused, nothing written", async (_label, patch) => {
    const w = await stuck();
    w.turnkey.completeAfterReads = 1;
    w.turnkey.transformActivity = (activity) => ({ ...activity, ...patch });
    const before = await snapshot(w);
    expect(await w.poll({ commit: true })).toMatchObject({ outcome: "refused", reason: "activity_identity_mismatch", committed: false });
    expect(await snapshot(w)).toEqual(before);
  });
});

describe("recording: observations only, on the dispatch row only", () => {
  it("DRY RUN (the default) never writes — pending or terminal", async () => {
    const w = await stuck();
    const before = await snapshot(w);
    expect(await w.poll()).toMatchObject({ outcome: "pending", status: "ACTIVITY_STATUS_PENDING", committed: false, reason: null });
    w.turnkey.completeAfterReads = 1;
    expect(await w.poll()).toMatchObject({ outcome: "terminal", status: "ACTIVITY_STATUS_COMPLETED", committed: false, intentVerdict: "exact", fingerprintVerdict: "match", voteVerdict: "parent_key", resultObserved: true, createdAtPlausible: true });
    expect(await snapshot(w)).toEqual(before);
  });

  it("commit + still pending: only lastObserved* moves", async () => {
    const w = await stuck();
    const before = await w.row();
    expect(await w.poll({ commit: true })).toMatchObject({ outcome: "pending", committed: true });
    const after = await w.row();
    expect(after.lastObservedStatus).toBe("ACTIVITY_STATUS_PENDING");
    expect({ ...after, lastObservedAt: null, updatedAt: "" }).toEqual({ ...before, lastObservedAt: null, updatedAt: "" });
    expect(after.terminalStatus).toBeNull();
  });

  it("commit + COMPLETED: the terminal observation is recorded once, marked operator_poll; a second run finds nothing left to do", async () => {
    const w = await stuck();
    w.turnkey.completeAfterReads = 1;
    const attemptBefore = await w.current();
    expect(await w.poll({ commit: true })).toMatchObject({ outcome: "terminal", committed: true, status: "ACTIVITY_STATUS_COMPLETED" });
    expect(await w.row()).toMatchObject({
      terminalStatus: "ACTIVITY_STATUS_COMPLETED",
      terminalObservedBy: "operator_poll",
      observedSubOrganizationId: "sub-org-1",
      observedRootUserId: "turnkey-user-1",
      observedWalletId: "wallet-1",
      observedOwnerAddress: FAKE_OWNER_ADDRESS,
      intentVerdict: "exact",
      fingerprintVerdict: "match",
      voteVerdict: "parent_key",
    });
    // The registration attempt is exactly as it was: still uncertain, no identity adopted.
    expect(await w.current()).toEqual(attemptBefore);
    expect(attemptBefore).toMatchObject({ state: "provisioning_in_flight", externalOutcome: "unknown", subOrganizationId: null, ownerAddress: null });

    const rowAfter = await w.row();
    expect(await w.poll({ commit: true })).toMatchObject({ outcome: "refused", reason: "already_terminal" });
    expect(w.portCalls).toHaveLength(1);
    expect(await w.row()).toEqual(rowAfter);
  });

  it.each(["ACTIVITY_STATUS_FAILED", "ACTIVITY_STATUS_REJECTED"] as const)("commit + %s: recorded with Turnkey's reason — and the attempt is NOT moved back to 'verified'", async (status) => {
    const w = await stuck();
    w.turnkey.completeAfterReads = 1;
    w.turnkey.pendingResolvesTo = status;
    expect(await w.poll({ commit: true })).toMatchObject({ outcome: "terminal", committed: true, status, resultObserved: false });
    expect(await w.row()).toMatchObject({ terminalStatus: status, terminalObservedBy: "operator_poll", failureCode: 3, observedSubOrganizationId: null });
    expect(await w.current()).toMatchObject({ state: "provisioning_in_flight", externalOutcome: "unknown" });
  });

  it("a terminal activity that does NOT match the stored evidence is still recorded — as evidence, with the mismatch verdicts", async () => {
    const w = await stuck();
    w.turnkey.completeAfterReads = 1;
    w.turnkey.transformActivity = (activity) => {
      (activity.intent as { createSubOrganizationIntentV8: { rootQuorumThreshold: number } }).createSubOrganizationIntentV8.rootQuorumThreshold = 2;
      return { ...activity, fingerprint: `sha256:${"3".repeat(64)}`, votes: [] };
    };
    expect(await w.poll({ commit: true })).toMatchObject({ outcome: "terminal", committed: true, intentVerdict: "mismatch", fingerprintVerdict: "mismatch", voteVerdict: "other" });
    expect(await w.row()).toMatchObject({ terminalStatus: "ACTIVITY_STATUS_COMPLETED", intentVerdict: "mismatch", fingerprintVerdict: "mismatch", voteVerdict: "other" });
    expect((await w.current()).state).toBe("provisioning_in_flight");
  });

  it("whole-second createdAt earlier than the request timestamp is plausible; a wildly different one is only flagged, never a refusal", async () => {
    const w = await stuck();
    w.turnkey.completeAfterReads = 1;
    expect((await w.poll()).createdAtPlausible).toBe(true);
    w.turnkey.transformActivity = (activity) => ({ ...activity, createdAt: { seconds: "1", nanos: "0" } });
    expect(await w.poll()).toMatchObject({ outcome: "terminal", createdAtPlausible: false });
  });

  it("a specific dispatch can be selected by its sequence number; the default is the newest", async () => {
    const w = await stuck("failed"); // dispatch 1: terminal FAILED
    const [first] = await w.attempts.findDispatchesByCredentialId(w.credentialId);
    expect(await w.attempts.revertProvisioningAfterDefinitiveFailure({ credentialId: w.credentialId, dispatchId: first!.id, activityId: first!.turnkeyActivityId! })).not.toBeNull();
    w.turnkey.submitMode = "pending";
    let t = 1_790_000_100_000;
    await runProvisioningDispatch({ config, attempts: w.attempts, attempt: await w.current(), deps: w.turnkey.deps({ now: () => t, sleep: async (ms) => void (t += ms) }) });
    w.turnkey.requests.length = 0;

    expect(await w.poll({ dispatchSeq: 1 })).toMatchObject({ outcome: "refused", reason: "already_terminal", dispatchSeq: 1 });
    expect(await w.poll()).toMatchObject({ outcome: "pending", dispatchSeq: 2, activityId: "activity-2" });
    expect(w.portCalls).toEqual([{ organizationId: "parent-org", activityId: "activity-2" }]);
  });
});

describe("what the poller structurally cannot do", () => {
  it("works with a store that has ONLY the three dispatch methods — any attempt/account write would throw", async () => {
    const w = await stuck();
    w.turnkey.completeAfterReads = 1;
    const allowed = new Set(["findDispatchesByCredentialId", "recordDispatchObservation", "recordDispatchTerminal"]);
    const touched: string[] = [];
    const narrow = new Proxy(w.attempts as RegistrationAttemptStore, {
      get(target, property, receiver) {
        const name = String(property);
        if (!allowed.has(name)) throw new Error(`the poller reached for store.${name}`);
        touched.push(name);
        return Reflect.get(target, property, receiver);
      },
    }) as ProvisioningPollStore;
    expect(await w.poll({ store: narrow, commit: true })).toMatchObject({ outcome: "terminal", committed: true });
    expect(touched.sort()).toEqual(["findDispatchesByCredentialId", "recordDispatchTerminal"]);
  });

  it("works with a port that has ONLY getActivity, and calls nothing else on Turnkey — never a create, a list, or a wallet read", async () => {
    const w = await stuck();
    w.turnkey.completeAfterReads = 1;
    const answers: ParentActivityRead[] = [];
    const port = new Proxy({} as ProvisioningActivityPort, {
      get(_target, property) {
        if (property !== "getActivity") throw new Error(`the poller reached for port.${String(property)}`);
        return async (input: { organizationId: string; activityId: string }) => {
          const answer = await w.port.getActivity(input);
          answers.push(answer);
          return answer;
        };
      },
    });
    await w.poll({ port, commit: true });
    expect(answers).toHaveLength(1);
    expect(w.turnkey.requests.map((r) => r.path)).toEqual([GET_ACTIVITY_PATH]);
    expect(w.turnkey.requests.some((r) => r.path === CREATE_PATH)).toBe(false);
  });

  it("the printed report carries truncated identifiers and no body, key, or stamp", async () => {
    const w = await stuck();
    w.turnkey.completeAfterReads = 1;
    const report = await w.poll();
    const redacted = redactPollReport({ ...report, activityId: "01a0d088-1234-4abc-8def-000000000000" });
    expect(redacted.activityId).toBe("01a0d088…");
    expect(redacted.credentialId.length).toBeLessThanOrEqual(9);
    const printed = JSON.stringify(redacted);
    expect(printed).not.toContain((await w.row()).requestBody);
    expect(printed).not.toMatch(/client-data-json|attestation-object|fake-parent-stamp|"priv"/);
    expect(Object.keys(report).sort()).toEqual(
      ["activityId", "committed", "createdAtPlausible", "credentialId", "dispatchId", "dispatchSeq", "fingerprintVerdict", "intentVerdict", "outcome", "reason", "resultObserved", "status", "voteVerdict"].sort(),
    );
  });
});
