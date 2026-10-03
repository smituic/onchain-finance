import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, encodeAbiParameters, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { bytesToBase64Url, randomBytes } from "@/lib/real/bytes";
import type { RealServerConfig } from "@/lib/real/server/config";
import { PROVISIONING_NEEDS_REVIEW_REASON, ProvisioningStateError, runProvisioningPipeline } from "@/lib/real/server/onboarding";
import { createProvisioningActivityPort, pollProvisioningDispatch } from "@/lib/real/server/provisioning-activity-poller";
import { runProvisioningDispatch } from "@/lib/real/server/provisioning-dispatch";
import { createInMemoryRealAccountRegistry } from "@/lib/real/server/registry";
import { createInMemoryRegistrationAttemptStore, type RegistrationAttempt, type RegistrationAttemptStore } from "@/lib/real/server/registration-attempts";
import { PROVISIONING_EVIDENCE_VERSION, PROVISIONING_LIMITS, buildCreateSubOrganizationBody } from "@/lib/real/server/turnkey-provisioning";
import { sha256Hex } from "@/lib/real/server/turnkey-signed-request";
import { claimWithEvidence } from "./fixtures/provisioning-seed";
import { CREATE_PATH, FAKE_OWNER_ADDRESS, FakeParentTurnkey, GET_ACTIVITY_PATH, LIST_WALLET_ACCOUNTS_PATH, type FakeSubmitMode } from "./fixtures/turnkey-parent-fake";

/**
 * Provisioning Evidence Capture — the in-process dispatch
 * (provisioning-dispatch.ts) and its place in the onboarding pipeline.
 * Offline: in-memory stores + FakeParentTurnkey. Covers the ordering
 * invariants, the whole failure matrix, bounded polling end to end, and
 * Option 3 (an uncertain create is never resumed, whatever evidence exists).
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

const DUMMY_BYTES_RETURN = encodeAbiParameters([{ type: "bytes" }], ["0x600a600c600039600a6000f3" as Hex]);
function buildPublicClient() {
  return createPublicClient({
    chain: baseSepolia,
    transport: custom({
      request: async ({ method }: { method: string }) => {
        if (method === "eth_getCode") return "0x";
        if (method === "eth_chainId") return `0x${baseSepolia.id.toString(16)}`;
        if (method === "eth_call") return DUMMY_BYTES_RETURN;
        throw new Error(`Unexpected public RPC call in an offline test: ${method}`);
      },
    }),
  });
}

let seq = 0;
async function world(mode: FakeSubmitMode = "completed") {
  seq += 1;
  const attempts = createInMemoryRegistrationAttemptStore();
  const registry = createInMemoryRealAccountRegistry();
  const turnkey = new FakeParentTurnkey();
  turnkey.submitMode = mode;
  const credentialId = bytesToBase64Url(randomBytes(16));
  const attempt = await attempts.createVerified({
    credentialId,
    appUserId: `0b5c0c7e-6d9b-4f43-9a2e-${String(seq).padStart(12, "0")}`,
    userHandle: `handle-${seq}`,
    credentialPublicKey: `cose-${seq}`,
    counter: 0,
    transports: ["hybrid", "internal"],
    credentialDeviceType: "multiDevice",
    credentialBackedUp: true,
    registrationChallenge: `challenge-${seq}`,
    rawClientDataJson: "client-data-json",
    rawAttestationObject: "attestation-object",
  });
  const dispatch = (store: RegistrationAttemptStore = attempts, deps = turnkey.deps()) => runProvisioningDispatch({ config, attempts: store, attempt, deps });
  const rows = () => attempts.findDispatchesByCredentialId(credentialId);
  const current = async () => (await attempts.findByCredentialId(credentialId))!;
  return { attempts, registry, turnkey, attempt, credentialId, dispatch, rows, current };
}

/** A fake clock for the bounded poll: sleeping advances it, nothing waits for real. */
function fakeClock(start = 1_790_000_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    elapsed: () => t - start,
  };
}

const untouchedIdentity = { subOrganizationId: null, turnkeyUserId: null, walletId: null, walletAccountId: null, ownerAddress: null, safeAddress: null };

describe("the happy path: evidence first, then exactly one create", () => {
  it("COMPLETED in the submit response -> created, with the full evidence row", async () => {
    const w = await world();
    const outcome = await w.dispatch();

    expect(outcome).toEqual({
      kind: "created",
      dispatchId: (await w.rows())[0]!.id,
      activityId: "activity-1",
      provisioned: { subOrganizationId: "sub-org-1", turnkeyUserId: "turnkey-user-1", walletId: "wallet-1", walletAccountId: "wallet-account-1", ownerAddress: FAKE_OWNER_ADDRESS },
    });
    expect(w.turnkey.requests.map((r) => r.path)).toEqual([CREATE_PATH, LIST_WALLET_ACCOUNTS_PATH]);

    const [row] = await w.rows();
    const sent = w.turnkey.createRequests[0]!.body;
    expect(row).toMatchObject({
      credentialId: w.credentialId,
      dispatchSeq: 1,
      evidenceVersion: PROVISIONING_EVIDENCE_VERSION,
      organizationId: "parent-org",
      stampPublicKey: "pub",
      requestBody: sent, // what was persisted IS what was sent
      requestBodySha256: sha256Hex(sent),
      turnkeyActivityId: "activity-1",
      turnkeyActivityFingerprint: `sha256:${sha256Hex(sent)}`,
      terminalStatus: "ACTIVITY_STATUS_COMPLETED",
      terminalObservedBy: "dispatch",
      observedSubOrganizationId: "sub-org-1",
      observedRootUserId: "turnkey-user-1",
      observedWalletId: "wallet-1",
      observedOwnerAddress: FAKE_OWNER_ADDRESS,
      failureCode: null,
      failureMessage: null,
      intentVerdict: "exact", // although the fake echoes the intent with its keys reordered
      fingerprintVerdict: "match",
      voteVerdict: "parent_key",
    });
    expect(row!.activityRecordedAt).toBeTruthy();
    // The claim (state + unknown outcome) was made; the identity columns are the pipeline's to write, not this function's.
    expect(await w.current()).toMatchObject({ state: "provisioning_in_flight", externalOutcome: "unknown", ...untouchedIdentity });
  });

  it("ONE clock reading: the body's timestampMs, the name suffix, the evidence timestamp, and attemptedAt are the same instant", async () => {
    const w = await world();
    let reads = 0;
    await w.dispatch(w.attempts, w.turnkey.deps({ now: () => 1_790_204_988_123 + reads++ * 1000 }));
    const [row] = await w.rows();
    const body = JSON.parse(row!.requestBody) as { timestampMs: string; organizationId: string; parameters: { subOrganizationName: string } };
    expect(body.timestampMs).toBe("1790204988123");
    expect(body.parameters.subOrganizationName).toBe(`real-${w.attempt.appUserId}-1790204988123`);
    expect(row!.requestTimestampMs).toBe(1790204988123);
    expect((await w.current()).externalProvisioningAttemptedAt).toBe(new Date(1790204988123).toISOString());
    // And it is the pure builder's output for the durable attempt fields — nothing else is mixed in.
    expect(row!.requestBody).toBe(
      buildCreateSubOrganizationBody({
        organizationId: "parent-org",
        appUserId: w.attempt.appUserId,
        timestampMs: 1790204988123,
        challengeBase64Url: w.attempt.registrationChallenge,
        credentialId: w.attempt.credentialId,
        clientDataJson: w.attempt.rawClientDataJson,
        attestationObject: w.attempt.rawAttestationObject,
        transports: w.attempt.transports,
      }),
    );
  });

  it("whole-second createdAt EARLIER than the millisecond timestamp is fine — nothing requires timestamp equality", async () => {
    const w = await world();
    expect((await w.dispatch(w.attempts, w.turnkey.deps({ now: () => 1_790_204_988_999 }))).kind).toBe("created");
    const [row] = await w.rows();
    expect(row!.turnkeyCreatedAt).toBe(new Date(1_790_204_988_000).toISOString());
    expect(new Date(row!.turnkeyCreatedAt!).getTime()).toBeLessThan(row!.requestTimestampMs);
  });

  it("no stamp, signature, or key material is ever persisted — on the dispatch row or the attempt", async () => {
    const w = await world();
    await w.dispatch();
    const stamp = w.turnkey.createRequests[0]!.headers["X-Stamp"]!;
    expect(stamp).toBeTruthy();
    const persisted = JSON.stringify([await w.rows(), await w.current()]);
    expect(persisted).not.toContain(stamp);
    expect(persisted).not.toContain(config.turnkeyApiPrivateKey);
    // The only stamp-related column is the PUBLIC key that stamped the request.
    const columns = Object.keys((await w.rows())[0]!);
    expect(columns.filter((key) => /^x?stamp|stampHeader|signature|private|secret/i.test(key))).toEqual(["stampPublicKey"]);
  });
});

describe("ordering invariants", () => {
  it("the claim and the evidence row are committed BEFORE the first Turnkey request, and the request carries the persisted bytes", async () => {
    const w = await world();
    const seen: Array<{ state: string; rows: number; bodyMatches: boolean; digestMatches: boolean }> = [];
    w.turnkey.onRequest = async (request) => {
      if (request.path !== CREATE_PATH) return;
      const rows = await w.rows();
      seen.push({
        state: (await w.current()).state,
        rows: rows.length,
        bodyMatches: rows[0]?.requestBody === request.body,
        digestMatches: rows[0]?.requestBodySha256 === sha256Hex(request.body),
      });
    };
    await w.dispatch();
    expect(seen).toEqual([{ state: "provisioning_in_flight", rows: 1, bodyMatches: true, digestMatches: true }]);
  });

  it("the activity id is recorded BEFORE the first poll and BEFORE the wallet read", async () => {
    const w = await world("pending");
    const recordedAt: Array<{ path: string; activityId: string | null }> = [];
    w.turnkey.onRequest = async (request) => {
      if (request.path === CREATE_PATH) return;
      recordedAt.push({ path: request.path, activityId: (await w.rows())[0]?.turnkeyActivityId ?? null });
    };
    expect((await w.dispatch()).kind).toBe("created");
    expect(recordedAt).toEqual([
      { path: GET_ACTIVITY_PATH, activityId: "activity-1" },
      { path: LIST_WALLET_ACCOUNTS_PATH, activityId: "activity-1" },
    ]);
  });

  it("a lost claim -> zero Turnkey requests, no evidence row", async () => {
    const w = await world();
    // Another process claimed it first (with its own evidence row).
    await claimWithEvidence(w.attempts, w.credentialId);
    const rowsBefore = await w.rows();
    expect(await w.dispatch()).toEqual({ kind: "claim_lost" });
    expect(w.turnkey.requests).toHaveLength(0);
    expect(await w.rows()).toEqual(rowsBefore);
  });

  it("concurrent dispatches of the same attempt: exactly one claim, one evidence row, one create", async () => {
    const w = await world();
    const outcomes = await Promise.all([w.dispatch(), w.dispatch(), w.dispatch()]);
    expect(outcomes.map((o) => o.kind).sort()).toEqual(["claim_lost", "claim_lost", "created"]);
    expect(w.turnkey.createRequests).toHaveLength(1);
    expect(await w.rows()).toHaveLength(1);
  });

  it.each([
    ["a different body", (d: { requestBody: string }) => ({ ...d, requestBody: `${d.requestBody} ` })],
    ["a different body WITH its own matching digest", (d: { requestBody: string }) => ({ ...d, requestBody: `${d.requestBody} `, requestBodySha256: sha256Hex(`${d.requestBody} `) })],
    ["a different digest", (d: { requestBody: string }) => ({ ...d, requestBodySha256: "0".repeat(64) })],
  ])("the store returns %s than what was built -> review with ZERO fetches (nothing is stamped or sent)", async (_label, tamper) => {
    const w = await world();
    const store: RegistrationAttemptStore = {
      ...w.attempts,
      async beginProvisioningDispatch(input) {
        const begun = await w.attempts.beginProvisioningDispatch(input);
        return begun && { ...begun, dispatch: { ...begun.dispatch, ...tamper(begun.dispatch) } };
      },
    };
    expect(await w.dispatch(store)).toEqual({ kind: "review" });
    expect(w.turnkey.requests).toHaveLength(0);
    expect(await w.current()).toMatchObject({ state: "provisioning_in_flight", externalOutcome: "unknown" });
  });

  it("a constraint failure in the claim throws, leaves the attempt 'verified', and sends nothing", async () => {
    const w = await world("failed");
    const fixed = w.turnkey.deps({ now: () => 1_790_204_988_123 });
    // First dispatch: a definitive failure, reverted through the evidence-bound operation, as the pipeline does.
    const first = await w.dispatch(w.attempts, fixed);
    if (first.kind !== "definitive_failure") throw new Error("expected a definitive failure");
    expect(await w.attempts.revertProvisioningAfterDefinitiveFailure({ credentialId: w.credentialId, dispatchId: first.dispatchId, activityId: first.activityId })).not.toBeNull();
    // A second dispatch at the SAME millisecond would be the byte-identical body: refused by the unique digest.
    await expect(runProvisioningDispatch({ config, attempts: w.attempts, attempt: await w.current(), deps: fixed })).rejects.toThrow(/already recorded/);
    expect((await w.current()).state).toBe("verified");
    expect(w.turnkey.createRequests).toHaveLength(1);
    expect(await w.rows()).toHaveLength(1);
  });
});

describe("failure matrix: the outcome is unknown -> review, never a retry", () => {
  it.each([
    ["transport failure before Turnkey applied anything", "network_error_before_apply", {}],
    ["response lost AFTER Turnkey applied the create", "lose_response_after_apply", {}],
    ["a non-2xx answer", "http_500", {}],
    ["a 2xx answer that cannot be parsed", "unparseable", {}],
    ["a submit timeout", "hang", { submitTimeoutMs: 15 }],
  ] as const)("%s: review; evidence row without an activity id; exactly one create; no read of any kind", async (_label, mode, limits) => {
    const w = await world(mode);
    expect(await w.dispatch(w.attempts, w.turnkey.deps({ limits }))).toEqual({ kind: "review" });
    expect(w.turnkey.requests.map((r) => r.path)).toEqual([CREATE_PATH]);
    const [row] = await w.rows();
    expect(row).toMatchObject({ requestBody: w.turnkey.createRequests[0]!.body, turnkeyActivityId: null, activityRecordedAt: null, terminalStatus: null, lastObservedStatus: null });
    expect(await w.current()).toMatchObject({ state: "provisioning_in_flight", externalOutcome: "unknown", ...untouchedIdentity });
  });

  it("activity id + PENDING until the deadline: review; the id and the last status are on the row; the poll is bounded", async () => {
    const w = await world("pending");
    w.turnkey.completeAfterReads = Number.POSITIVE_INFINITY;
    const clock = fakeClock();
    expect(await w.dispatch(w.attempts, w.turnkey.deps({ now: clock.now, sleep: clock.sleep }))).toEqual({ kind: "review" });

    expect(clock.sleeps).toEqual([500, 1000, 2000, 2000, 2000, 500]);
    expect(clock.elapsed()).toBe(PROVISIONING_LIMITS.pollBudgetMs);
    expect(w.turnkey.activityReads).toHaveLength(5);
    expect(w.turnkey.walletReads).toHaveLength(0);
    expect(w.turnkey.createRequests).toHaveLength(1);
    expect(w.turnkey.requests.every((request) => request.hasSignal)).toBe(true); // every request individually bounded
    expect((await w.rows())[0]).toMatchObject({ turnkeyActivityId: "activity-1", terminalStatus: null, lastObservedStatus: "ACTIVITY_STATUS_PENDING" });
    expect(await w.current()).toMatchObject({ state: "provisioning_in_flight", externalOutcome: "unknown" });
  });

  it("activity id + PENDING, then COMPLETED on a poll -> created", async () => {
    const w = await world("pending");
    w.turnkey.completeAfterReads = 3;
    expect((await w.dispatch()).kind).toBe("created");
    expect(w.turnkey.activityReads).toHaveLength(3);
    expect((await w.rows())[0]).toMatchObject({ terminalStatus: "ACTIVITY_STATUS_COMPLETED", terminalObservedBy: "dispatch", observedSubOrganizationId: "sub-org-1" });
  });

  it("every exact-id read is for the recorded id in the parent organization", async () => {
    const w = await world("pending");
    w.turnkey.completeAfterReads = 2;
    await w.dispatch();
    for (const read of w.turnkey.activityReads) expect(JSON.parse(read.body)).toEqual({ organizationId: "parent-org", activityId: "activity-1" });
  });

  it("the read side failing while pending (errors / not found / hung reads) is still just review", async () => {
    for (const mode of ["error", "not_found", "hang"] as const) {
      const w = await world("pending");
      w.turnkey.getActivityMode = mode;
      const clock = fakeClock();
      expect(await w.dispatch(w.attempts, w.turnkey.deps({ now: clock.now, sleep: clock.sleep, limits: { activityReadTimeoutMs: 5 } }))).toEqual({ kind: "review" });
      expect(w.turnkey.createRequests).toHaveLength(1);
      expect((await w.rows())[0]).toMatchObject({ turnkeyActivityId: "activity-1", terminalStatus: null });
    }
  });

  it("CONSENSUS_NEEDED cannot resolve by itself: no poll at all, the status is noted, review", async () => {
    const w = await world("consensus_needed");
    expect(await w.dispatch()).toEqual({ kind: "review" });
    expect(w.turnkey.activityReads).toHaveLength(0);
    expect((await w.rows())[0]).toMatchObject({ turnkeyActivityId: "activity-1", terminalStatus: null, lastObservedStatus: "ACTIVITY_STATUS_CONSENSUS_NEEDED" });
  });

  it.each(["failed", "rejected"] as const)("activity id + %s -> a DEFINITIVE failure, recorded on the evidence row with Turnkey's reason", async (mode) => {
    const w = await world(mode);
    expect(await w.dispatch()).toMatchObject({ kind: "definitive_failure", activityId: "activity-1" });
    const status = mode === "failed" ? "ACTIVITY_STATUS_FAILED" : "ACTIVITY_STATUS_REJECTED";
    expect((await w.rows())[0]).toMatchObject({
      turnkeyActivityId: "activity-1",
      terminalStatus: status,
      terminalObservedBy: "dispatch",
      failureCode: 3,
      failureMessage: "invalid authenticator attestation: ChallengeMismatch",
      observedSubOrganizationId: null,
      intentVerdict: "exact",
      fingerprintVerdict: "match",
    });
    expect(w.turnkey.requests.map((r) => r.path)).toEqual([CREATE_PATH]);
  });

  it("PENDING that later resolves to FAILED on a poll is definitive too — for this exact activity", async () => {
    const w = await world("pending");
    w.turnkey.pendingResolvesTo = "ACTIVITY_STATUS_FAILED";
    expect(await w.dispatch()).toMatchObject({ kind: "definitive_failure", activityId: "activity-1" });
    expect((await w.rows())[0]).toMatchObject({ terminalStatus: "ACTIVITY_STATUS_FAILED", failureCode: 3 });
  });

  it("an activity id that arrives with a NON-2xx answer is recorded, and its status is read back by id rather than trusted", async () => {
    const w = await world();
    const real = w.turnkey.fetchImpl;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const response = await real(url, init);
      return new URL(url).pathname === CREATE_PATH ? new Response(await response.text(), { status: 502 }) : response;
    }) as typeof fetch;
    expect((await w.dispatch(w.attempts, w.turnkey.deps({ fetchImpl }))).kind).toBe("created");
    expect(w.turnkey.requests.map((r) => r.path)).toEqual([CREATE_PATH, GET_ACTIVITY_PATH, LIST_WALLET_ACCOUNTS_PATH]);

    // ...and if it can never be read back, the status that NON-2xx answer carried is not even noted as an observation.
    const stuck = await world();
    stuck.turnkey.getActivityMode = "error";
    const clock = fakeClock();
    const realStuck = stuck.turnkey.fetchImpl;
    const non2xx = (async (url: string, init?: RequestInit) => {
      const response = await realStuck(url, init);
      return new URL(url).pathname === CREATE_PATH ? new Response(await response.text(), { status: 502 }) : response;
    }) as typeof fetch;
    expect(await stuck.dispatch(stuck.attempts, stuck.turnkey.deps({ fetchImpl: non2xx, now: clock.now, sleep: clock.sleep }))).toEqual({ kind: "review" });
    expect((await stuck.rows())[0]).toMatchObject({ turnkeyActivityId: "activity-1", terminalStatus: null, lastObservedStatus: null });
    expect(stuck.turnkey.walletReads).toHaveLength(0);
  });
});

describe("failure matrix: database writes after the response", () => {
  it("recording the activity id fails every time: review — the create is NEVER re-sent, nothing is polled or read", async () => {
    const w = await world();
    let calls = 0;
    const store: RegistrationAttemptStore = {
      ...w.attempts,
      async recordDispatchActivity() {
        calls += 1;
        throw new Error("database unavailable");
      },
    };
    expect(await w.dispatch(store)).toEqual({ kind: "review" });
    expect(calls).toBe(2); // one bounded retry of the DATABASE write only
    expect(w.turnkey.requests.map((r) => r.path)).toEqual([CREATE_PATH]);
    expect((await w.rows())[0]).toMatchObject({ turnkeyActivityId: null, terminalStatus: null });
  });

  it("an activity id that could not be recorded is never polled: PENDING + a failing record -> review with ZERO exact-id reads", async () => {
    const w = await world("pending");
    const store: RegistrationAttemptStore = {
      ...w.attempts,
      async recordDispatchActivity() {
        throw new Error("database unavailable");
      },
    };
    expect(await w.dispatch(store)).toEqual({ kind: "review" });
    expect(w.turnkey.requests.map((r) => r.path)).toEqual([CREATE_PATH]);
  });

  it("a transient failure recording the activity id: the retry succeeds and the dispatch continues", async () => {
    const w = await world();
    let calls = 0;
    const store: RegistrationAttemptStore = {
      ...w.attempts,
      async recordDispatchActivity(input) {
        calls += 1;
        if (calls === 1) throw new Error("timeout");
        return w.attempts.recordDispatchActivity(input);
      },
    };
    expect((await w.dispatch(store)).kind).toBe("created");
    expect(w.turnkey.createRequests).toHaveLength(1);
  });

  it("the first write LANDED but its answer was lost: the retry sees the same id (idempotent replay) and continues", async () => {
    const w = await world();
    let calls = 0;
    const outcomes: string[] = [];
    const store: RegistrationAttemptStore = {
      ...w.attempts,
      async recordDispatchActivity(input) {
        calls += 1;
        const result = await w.attempts.recordDispatchActivity(input);
        outcomes.push(result.outcome);
        if (calls === 1) throw new Error("response lost");
        return result;
      },
    };
    expect((await w.dispatch(store)).kind).toBe("created");
    expect(outcomes).toEqual(["recorded", "already_recorded"]);
  });

  it("a DIFFERENT activity id is already recorded on the row: review, and it is not replaced", async () => {
    const w = await world();
    const store: RegistrationAttemptStore = {
      ...w.attempts,
      async recordDispatchActivity(input) {
        await w.attempts.recordDispatchActivity({ ...input, activityId: "activity-EARLIER" });
        return w.attempts.recordDispatchActivity(input);
      },
    };
    expect(await w.dispatch(store)).toEqual({ kind: "review" });
    expect((await w.rows())[0]!.turnkeyActivityId).toBe("activity-EARLIER");
    expect(w.turnkey.requests.map((r) => r.path)).toEqual([CREATE_PATH]);
  });

  it.each(["completed", "failed"] as const)("recording the terminal observation fails (%s): review — a FAILED activity is NOT treated as definitive without its record", async (mode) => {
    const w = await world(mode);
    const store: RegistrationAttemptStore = {
      ...w.attempts,
      async recordDispatchTerminal() {
        throw new Error("database unavailable");
      },
    };
    expect(await w.dispatch(store)).toEqual({ kind: "review" });
    expect(w.turnkey.walletReads).toHaveLength(0);
    expect((await w.rows())[0]).toMatchObject({ turnkeyActivityId: "activity-1", terminalStatus: null });
  });

  it("COMPLETED, then the wallet read fails (error / empty / timeout): review; the evidence stays; no identity is written", async () => {
    for (const mode of ["error", "empty", "hang"] as const) {
      const w = await world();
      w.turnkey.walletMode = mode;
      expect(await w.dispatch(w.attempts, w.turnkey.deps({ limits: { walletReadTimeoutMs: 15 } }))).toEqual({ kind: "review" });
      expect((await w.rows())[0]).toMatchObject({ terminalStatus: "ACTIVITY_STATUS_COMPLETED", observedSubOrganizationId: "sub-org-1", observedOwnerAddress: FAKE_OWNER_ADDRESS });
      expect(await w.current()).toMatchObject({ state: "provisioning_in_flight", externalOutcome: "unknown", ...untouchedIdentity });
      expect(w.turnkey.walletReads).toHaveLength(1); // not retried
    }
  });
});

describe("activity validation gates the in-process success AND the definitive failure", () => {
  it.each([
    ["organization", { organizationId: "another-org" }],
    ["type", { type: "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V7" }],
  ])("a %s mismatch: review; the terminal observation is NOT written as if it were this dispatch's", async (_label, patch) => {
    const w = await world();
    w.turnkey.transformActivity = (activity) => ({ ...activity, ...patch });
    expect(await w.dispatch()).toEqual({ kind: "review" });
    expect((await w.rows())[0]).toMatchObject({ turnkeyActivityId: "activity-1", terminalStatus: null, observedSubOrganizationId: null });
    expect(w.turnkey.walletReads).toHaveLength(0);
  });

  it("a poll answer naming ANOTHER activity id is never taken for this dispatch's activity", async () => {
    const w = await world("pending");
    const real = w.turnkey.fetchImpl;
    let served = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const response = await real(url, init);
      if (new URL(url).pathname !== GET_ACTIVITY_PATH) return response;
      served += 1;
      const json = (await response.json()) as { activity: Record<string, unknown> };
      return Response.json({ activity: { ...json.activity, id: "activity-OTHER" } });
    }) as typeof fetch;
    const clock = fakeClock();
    expect(await w.dispatch(w.attempts, w.turnkey.deps({ fetchImpl, now: clock.now, sleep: clock.sleep }))).toEqual({ kind: "review" });
    expect(served).toBeGreaterThan(0);
    expect((await w.rows())[0]).toMatchObject({ turnkeyActivityId: "activity-1", terminalStatus: null });
  });

  it("a semantic intent mismatch on a COMPLETED activity: review, verdict recorded, never 'created'", async () => {
    const w = await world();
    w.turnkey.transformActivity = (activity) => {
      const intent = activity.intent as { createSubOrganizationIntentV8: { rootUsers: Array<{ apiKeys: unknown[] }> } };
      intent.createSubOrganizationIntentV8.rootUsers[0]!.apiKeys.push({ apiKeyName: "extra", publicKey: "02ff" });
      return activity;
    };
    expect(await w.dispatch()).toEqual({ kind: "review" });
    expect((await w.rows())[0]).toMatchObject({ terminalStatus: "ACTIVITY_STATUS_COMPLETED", intentVerdict: "mismatch", fingerprintVerdict: "match" });
    expect(w.turnkey.walletReads).toHaveLength(0);
    expect(await w.current()).toMatchObject({ state: "provisioning_in_flight", ...untouchedIdentity });
  });

  it("a recognized fingerprint that is NOT our digest: review, verdict recorded", async () => {
    const w = await world();
    w.turnkey.transformActivity = (activity) => ({ ...activity, fingerprint: `sha256:${"1".repeat(64)}` });
    expect(await w.dispatch()).toEqual({ kind: "review" });
    expect((await w.rows())[0]).toMatchObject({ terminalStatus: "ACTIVITY_STATUS_COMPLETED", fingerprintVerdict: "mismatch", intentVerdict: "exact", turnkeyActivityFingerprint: `sha256:${"1".repeat(64)}` });
    expect(w.turnkey.walletReads).toHaveLength(0);
  });

  it("an UNRECOGNIZED fingerprint form is stored verbatim, marked, and does not by itself stop a matching activity", async () => {
    const w = await world();
    w.turnkey.transformActivity = (activity) => ({ ...activity, fingerprint: "blake3:abcdef" });
    expect((await w.dispatch()).kind).toBe("created");
    expect((await w.rows())[0]).toMatchObject({ turnkeyActivityFingerprint: "blake3:abcdef", fingerprintVerdict: "unrecognized_form", intentVerdict: "exact" });
    // Our own digest is unaffected: it is a separate column with a separate meaning.
    expect((await w.rows())[0]!.requestBodySha256).toBe(sha256Hex(w.turnkey.createRequests[0]!.body));
  });

  it.each([
    ["missing", null],
    ["two root users", { createSubOrganizationResultV8: { subOrganizationId: "s", wallet: { walletId: "w", addresses: [FAKE_OWNER_ADDRESS] }, rootUserIds: ["a", "b"] } }],
    ["no wallet", { createSubOrganizationResultV8: { subOrganizationId: "s", rootUserIds: ["a"] } }],
  ])("a COMPLETED activity whose result is %s: review, with no observed ids", async (_label, result) => {
    const w = await world();
    w.turnkey.transformActivity = (activity) => ({ ...activity, result });
    expect(await w.dispatch()).toEqual({ kind: "review" });
    expect((await w.rows())[0]).toMatchObject({ terminalStatus: "ACTIVITY_STATUS_COMPLETED", observedSubOrganizationId: null, observedOwnerAddress: null });
    expect(w.turnkey.walletReads).toHaveLength(0);
  });

  it("a FAILED activity that does not match what we sent is NOT a definitive failure (it proves nothing about our request)", async () => {
    const w = await world("failed");
    w.turnkey.transformActivity = (activity) => ({ ...activity, fingerprint: `sha256:${"2".repeat(64)}` });
    expect(await w.dispatch()).toEqual({ kind: "review" });
    expect((await w.rows())[0]).toMatchObject({ terminalStatus: "ACTIVITY_STATUS_FAILED", fingerprintVerdict: "mismatch" });
  });
});

describe("through the onboarding pipeline", () => {
  const run = (w: Awaited<ReturnType<typeof world>>, attempt: RegistrationAttempt, attempts: RegistrationAttemptStore = w.attempts) =>
    runProvisioningPipeline({ config, registry: w.registry, attempts, attempt, publicClient: buildPublicClient(), provisioningDeps: w.turnkey.deps() });

  it("created -> turnkey_created -> finalize -> active: identity comes from the in-process response", async () => {
    const w = await world();
    const result = await run(w, w.attempt);
    expect(result.outcome).toBe("verified");
    expect(await w.current()).toMatchObject({ state: "active", externalOutcome: "confirmed_created", subOrganizationId: "sub-org-1", turnkeyUserId: "turnkey-user-1", walletId: "wallet-1", walletAccountId: "wallet-account-1", ownerAddress: FAKE_OWNER_ADDRESS });
    expect(await w.rows()).toHaveLength(1);
  });

  it("a definitive failure reverts to 'verified'; the next run is a NEW dispatch row and the first is preserved unchanged", async () => {
    const w = await world();
    w.turnkey.submitQueue.push("failed");
    expect(await run(w, w.attempt)).toEqual({ outcome: "pending", reason: "Account setup failed and can be retried. Try again in a moment." });
    expect(await w.current()).toMatchObject({ state: "verified", externalOutcome: "definitive_failure" });
    const firstRows = await w.rows();
    expect(firstRows).toHaveLength(1);

    expect((await run(w, await w.current())).outcome).toBe("verified");
    const rows = await w.rows();
    expect(rows.map((row) => [row.dispatchSeq, row.terminalStatus, row.turnkeyActivityId])).toEqual([
      [1, "ACTIVITY_STATUS_FAILED", "activity-1"],
      [2, "ACTIVITY_STATUS_COMPLETED", "activity-2"],
    ]);
    expect(rows[0]).toEqual(firstRows[0]); // the failed dispatch's evidence is untouched
    expect(rows[1]!.requestBody).not.toBe(rows[0]!.requestBody);
    expect(rows[1]!.requestBodySha256).not.toBe(rows[0]!.requestBodySha256);
    expect(w.turnkey.createRequests.map((r) => r.body)).toEqual([rows[0]!.requestBody, rows[1]!.requestBody]);
  });

  it("L4: the turnkey_created write genuinely fails (attempt still in flight): review now AND later — a fixed diagnostic, never resumed from the evidence row", async () => {
    const w = await world();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing: RegistrationAttemptStore = {
      ...w.attempts,
      async advanceProvisioningToTurnkeyCreated() {
        throw new Error("database unavailable");
      },
    };
    expect(await run(w, w.attempt, failing)).toEqual({ outcome: "pending", reason: PROVISIONING_NEEDS_REVIEW_REASON });
    expect(warn.mock.calls).toEqual([["[real-onboarding] turnkey_created_write_failed"]]);
    expect(await w.current()).toMatchObject({ state: "provisioning_in_flight", externalOutcome: "unknown", ...untouchedIdentity });
    expect((await w.rows())[0]).toMatchObject({ terminalStatus: "ACTIVITY_STATUS_COMPLETED", observedSubOrganizationId: "sub-org-1" });

    const requestsBefore = w.turnkey.requests.length;
    // The database is healthy again; the evidence says COMPLETED; it still does not continue.
    expect(await run(w, await w.current())).toEqual({ outcome: "pending", reason: PROVISIONING_NEEDS_REVIEW_REASON });
    expect(w.turnkey.requests).toHaveLength(requestsBefore);
    expect(await w.registry.findAccountByAppUserId(w.attempt.appUserId)).toBeNull();
    warn.mockRestore();
  });

  it("L4: the write is REFUSED (CAS matched nothing) and the attempt is still in flight: review, with its own marker", async () => {
    const w = await world();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const refusing: RegistrationAttemptStore = { ...w.attempts, advanceProvisioningToTurnkeyCreated: async () => null };
    expect(await run(w, w.attempt, refusing)).toEqual({ outcome: "pending", reason: PROVISIONING_NEEDS_REVIEW_REASON });
    expect(warn.mock.calls).toEqual([["[real-onboarding] turnkey_created_write_refused"]]);
    warn.mockRestore();
  });

  it("L4: the write COMMITTED but its answer was lost: the read-back shows the exact identity, and the ordinary finalize path continues", async () => {
    const w = await world();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lossy: RegistrationAttemptStore = {
      ...w.attempts,
      async advanceProvisioningToTurnkeyCreated(input) {
        const committed = await w.attempts.advanceProvisioningToTurnkeyCreated(input);
        expect(committed?.state).toBe("turnkey_created");
        throw new Error("response lost");
      },
    };
    const result = await run(w, w.attempt, lossy);
    expect(result.outcome).toBe("verified");
    expect(await w.current()).toMatchObject({ state: "active", subOrganizationId: "sub-org-1", ownerAddress: FAKE_OWNER_ADDRESS });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("L4: committed, answer lost, and ANOTHER request already finalized it: resumes the exact account (never a second one)", async () => {
    const w = await world();
    const lossy: RegistrationAttemptStore = {
      ...w.attempts,
      async advanceProvisioningToTurnkeyCreated(input) {
        const committed = (await w.attempts.advanceProvisioningToTurnkeyCreated(input))!;
        // A concurrent login resumes the turnkey_created attempt and finalizes it.
        expect((await runProvisioningPipeline({ config, registry: w.registry, attempts: w.attempts, attempt: committed, publicClient: buildPublicClient() })).outcome).toBe("verified");
        throw new Error("response lost");
      },
    };
    const result = await run(w, w.attempt, lossy);
    expect(result.outcome).toBe("verified");
    expect(await w.registry.findAccountByAppUserId(w.attempt.appUserId)).toMatchObject({ subOrganizationId: "sub-org-1" });
  });

  it.each([
    ["back in 'verified'", (a: RegistrationAttempt) => ({ ...a, state: "verified" as const })],
    ["turnkey_created with a DIFFERENT identity", (a: RegistrationAttempt) => ({ ...a, state: "turnkey_created" as const, subOrganizationId: "sub-org-OTHER", turnkeyUserId: "u", walletId: "w", walletAccountId: "wa", ownerAddress: FAKE_OWNER_ADDRESS })],
    ["in flight but with an identity already written", (a: RegistrationAttempt) => ({ ...a, subOrganizationId: "sub-org-1" })],
    ["missing entirely", () => null],
  ])("L4: a read-back that contradicts this request (%s) is an INTERNAL integrity error — thrown, never 'pending', never a continuation", async (_label, contradict) => {
    const w = await world();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let advanced = false;
    const contradictory: RegistrationAttemptStore = {
      ...w.attempts,
      async advanceProvisioningToTurnkeyCreated() {
        advanced = true;
        throw new Error("ambiguous");
      },
      async findByCredentialId(credentialId) {
        const real = await w.attempts.findByCredentialId(credentialId);
        return advanced && real ? contradict(real) : real;
      },
    };
    const outcome = run(w, w.attempt, contradictory);
    await expect(outcome).rejects.toBeInstanceOf(ProvisioningStateError);
    await expect(outcome).rejects.toMatchObject({ code: "turnkey_created_state_contradiction" });
    expect(error.mock.calls).toEqual([["[real-onboarding] turnkey_created_state_contradiction"]]);
    expect(await w.registry.findAccountByAppUserId(w.attempt.appUserId)).toBeNull();
    error.mockRestore();
  });

  it("L4: the read-back itself fails: thrown as a distinct internal error — the commit is never guessed", async () => {
    const w = await world();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let advanced = false;
    const blind: RegistrationAttemptStore = {
      ...w.attempts,
      async advanceProvisioningToTurnkeyCreated() {
        advanced = true;
        throw new Error("ambiguous");
      },
      async findByCredentialId(credentialId) {
        if (advanced) throw new Error("database unavailable");
        return w.attempts.findByCredentialId(credentialId);
      },
    };
    await expect(run(w, w.attempt, blind)).rejects.toMatchObject({ name: "ProvisioningStateError", code: "turnkey_created_reread_failed" });
    expect(error.mock.calls).toEqual([["[real-onboarding] turnkey_created_reread_failed"]]);
    expect(await w.current()).toMatchObject({ state: "provisioning_in_flight", ...untouchedIdentity });
    error.mockRestore();
  });

  it("L1: a definitive failure whose evidence-bound revert is refused stays in review (with a marker) — no retry is enabled", async () => {
    const w = await world("failed");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const refusing: RegistrationAttemptStore = { ...w.attempts, revertProvisioningAfterDefinitiveFailure: async () => null };
    expect(await run(w, w.attempt, refusing)).toEqual({ outcome: "pending", reason: PROVISIONING_NEEDS_REVIEW_REASON });
    expect(warn.mock.calls).toEqual([["[real-onboarding] definitive_failure_revert_refused"]]);
    expect(await w.current()).toMatchObject({ state: "provisioning_in_flight", externalOutcome: "unknown" });
    warn.mockRestore();
  });

  it("the diagnostics never carry an identifier, a body, or a key", () => {
    const source = readFileSync("lib/real/server/onboarding.ts", "utf8");
    const calls = source.match(/console\[level\]\([^)]*\)/g) ?? [];
    expect(calls).toEqual(["console[level](`[real-onboarding] ${marker}`)"]);
    expect(source.match(/\bconsole\./g)).toBeNull(); // the one helper is the only console use
  });

  it.each(["network_error_before_apply", "lose_response_after_apply", "http_500", "unparseable"] as const)("%s: the pipeline reports needs-review and creates no account", async (mode) => {
    const w = await world(mode);
    expect(await run(w, w.attempt)).toEqual({ outcome: "pending", reason: PROVISIONING_NEEDS_REVIEW_REASON });
    expect(await w.registry.findAccountByAppUserId(w.attempt.appUserId)).toBeNull();
    expect(await w.registry.findPasskeyByCredentialId(w.credentialId)).toBeNull();
  });
});

describe("Option 3: 'provisioning_in_flight' makes ZERO Turnkey calls — whatever the evidence row says", () => {
  /** A stuck attempt whose dispatch row has a recorded activity id (the create was accepted, then never resolved in-process). */
  async function stuckWithActivityId() {
    const w = await world("pending");
    w.turnkey.completeAfterReads = Number.POSITIVE_INFINITY;
    const clock = fakeClock();
    expect(await w.dispatch(w.attempts, w.turnkey.deps({ now: clock.now, sleep: clock.sleep }))).toEqual({ kind: "review" });
    return w;
  }
  const resume = (w: Awaited<ReturnType<typeof world>>, attempt: RegistrationAttempt) =>
    runProvisioningPipeline({ config, registry: w.registry, attempts: w.attempts, attempt, publicClient: buildPublicClient(), provisioningDeps: w.turnkey.deps() });

  it("an uncertain attempt with a recorded activity id: review, zero requests, nothing changes — on every later run", async () => {
    const w = await stuckWithActivityId();
    const before = { attempt: await w.current(), rows: await w.rows(), requests: w.turnkey.requests.length };
    for (let i = 0; i < 3; i += 1) expect(await resume(w, await w.current())).toEqual({ outcome: "pending", reason: PROVISIONING_NEEDS_REVIEW_REASON });
    expect(w.turnkey.requests).toHaveLength(before.requests);
    expect(await w.current()).toEqual(before.attempt);
    expect(await w.rows()).toEqual(before.rows);
  });

  it("STILL zero calls when the dispatch row holds a COMPLETED operator observation with a full, matching result", async () => {
    const w = await stuckWithActivityId();
    // Turnkey finishes the create; the operator poller records it (the one read it is allowed).
    w.turnkey.completeAfterReads = 1;
    const report = await pollProvisioningDispatch({
      store: w.attempts,
      port: createProvisioningActivityPort(config, w.turnkey.deps()),
      parentOrganizationId: "parent-org",
      credentialId: w.credentialId,
      commit: true,
    });
    expect(report).toMatchObject({ outcome: "terminal", committed: true, status: "ACTIVITY_STATUS_COMPLETED", intentVerdict: "exact", fingerprintVerdict: "match", resultObserved: true });
    expect((await w.rows())[0]).toMatchObject({
      terminalStatus: "ACTIVITY_STATUS_COMPLETED",
      terminalObservedBy: "operator_poll",
      observedSubOrganizationId: "sub-org-1",
      observedRootUserId: "turnkey-user-1",
      observedWalletId: "wallet-1",
      observedOwnerAddress: FAKE_OWNER_ADDRESS,
    });

    const before = { attempt: await w.current(), rows: await w.rows(), requests: w.turnkey.requests.length };
    expect(before.attempt).toMatchObject({ state: "provisioning_in_flight", externalOutcome: "unknown", ...untouchedIdentity });

    expect(await resume(w, before.attempt)).toEqual({ outcome: "pending", reason: PROVISIONING_NEEDS_REVIEW_REASON });

    expect(w.turnkey.requests).toHaveLength(before.requests); // no get_activity, no wallet read, no create
    expect(await w.current()).toEqual(before.attempt); // observed ids were NOT adopted
    expect(await w.rows()).toEqual(before.rows);
    expect(await w.registry.findAccountByAppUserId(w.attempt.appUserId)).toBeNull();
    expect(await w.registry.findPasskeyByCredentialId(w.credentialId)).toBeNull();
  });

  it("a later FAILED operator observation does NOT move the attempt back to 'verified' — no second create", async () => {
    const w = await stuckWithActivityId();
    w.turnkey.completeAfterReads = 1;
    w.turnkey.pendingResolvesTo = "ACTIVITY_STATUS_FAILED";
    const report = await pollProvisioningDispatch({ store: w.attempts, port: createProvisioningActivityPort(config, w.turnkey.deps()), parentOrganizationId: "parent-org", credentialId: w.credentialId, commit: true });
    expect(report).toMatchObject({ outcome: "terminal", committed: true, status: "ACTIVITY_STATUS_FAILED" });

    expect(await w.current()).toMatchObject({ state: "provisioning_in_flight", externalOutcome: "unknown" });
    expect(await resume(w, await w.current())).toEqual({ outcome: "pending", reason: PROVISIONING_NEEDS_REVIEW_REASON });
    expect(w.turnkey.createRequests).toHaveLength(1);
  });
});

describe("L2: a COMPLETED create needs an EXACT intent; a definitive failure needs a positive tie to our body", () => {
  const addEchoedKey = <T extends Record<string, unknown>>(activity: T): T => {
    (activity.intent as { createSubOrganizationIntentV8: Record<string, unknown> }).createSubOrganizationIntentV8.verificationToken = null;
    return activity;
  };

  it("COMPLETED + fields_only + a MATCHING fingerprint: review (recorded as evidence), no wallet read, no identity", async () => {
    const w = await world();
    w.turnkey.transformActivity = addEchoedKey;
    expect(await w.dispatch()).toEqual({ kind: "review" });
    expect((await w.rows())[0]).toMatchObject({ terminalStatus: "ACTIVITY_STATUS_COMPLETED", intentVerdict: "fields_only", fingerprintVerdict: "match" });
    expect(w.turnkey.walletReads).toHaveLength(0);
    expect(await w.current()).toMatchObject({ state: "provisioning_in_flight", ...untouchedIdentity });
  });

  it("FAILED + fields_only + a MATCHING recognized fingerprint: definitive — and the pipeline's evidence-bound revert accepts it", async () => {
    const w = await world("failed");
    w.turnkey.transformActivity = addEchoedKey;
    const outcome = await runProvisioningPipeline({ config, registry: w.registry, attempts: w.attempts, attempt: w.attempt, publicClient: buildPublicClient(), provisioningDeps: w.turnkey.deps() });
    expect(outcome).toEqual({ outcome: "pending", reason: "Account setup failed and can be retried. Try again in a moment." });
    expect(await w.current()).toMatchObject({ state: "verified", externalOutcome: "definitive_failure" });
  });

  it("FAILED + fields_only + an UNRECOGNIZED fingerprint: review, never definitive", async () => {
    const w = await world("rejected");
    w.turnkey.transformActivity = (activity) => ({ ...addEchoedKey(activity), fingerprint: "blake3:abc" });
    expect(await w.dispatch()).toEqual({ kind: "review" });
    expect((await w.rows())[0]).toMatchObject({ terminalStatus: "ACTIVITY_STATUS_REJECTED", intentVerdict: "fields_only", fingerprintVerdict: "unrecognized_form" });
  });
});

describe("L3: the wallet-account read must describe EXACTLY the created account", () => {
  const variants: Array<[string, (accounts: Array<Record<string, unknown>>) => Array<Record<string, unknown>>]> = [
    ["an extra account", (a) => [...a, { ...a[0], walletAccountId: "wallet-account-extra" }]],
    ["no account", () => []],
    ["a different address", (a) => [{ ...a[0], address: "0x1111111111111111111111111111111111111111" }]],
    ["a malformed address", (a) => [{ ...a[0], address: "0x1234" }]],
    ["a different derivation path", (a) => [{ ...a[0], path: "m/44'/60'/0'/0/1" }]],
    ["a different curve", (a) => [{ ...a[0], curve: "CURVE_ED25519" }]],
    ["a different address format", (a) => [{ ...a[0], addressFormat: "ADDRESS_FORMAT_SOLANA" }]],
    ["a different path format", (a) => [{ ...a[0], pathFormat: "PATH_FORMAT_OTHER" }]],
    ["a different wallet id", (a) => [{ ...a[0], walletId: "wallet-OTHER" }]],
    ["a different organization", (a) => [{ ...a[0], organizationId: "sub-org-OTHER" }]],
    ["no organization field", (a) => [{ ...a[0], organizationId: undefined }]],
    ["no wallet account id", (a) => [{ ...a[0], walletAccountId: "" }]],
  ];

  it.each(variants)("%s -> review, nothing written to the attempt", async (_label, transform) => {
    const w = await world();
    w.turnkey.transformWalletAccounts = transform;
    expect(await w.dispatch()).toEqual({ kind: "review" });
    expect(w.turnkey.walletReads).toHaveLength(1);
    expect(await w.current()).toMatchObject({ state: "provisioning_in_flight", ...untouchedIdentity });
  });

  it("the exact single expected account -> created, with its id; the read names the created sub-org and wallet", async () => {
    const w = await world();
    expect(await w.dispatch()).toMatchObject({ kind: "created", provisioned: { walletAccountId: "wallet-account-1" } });
    expect(JSON.parse(w.turnkey.walletReads[0]!.body)).toEqual({ organizationId: "sub-org-1", walletId: "wallet-1" });
  });

  it("an address differing ONLY in hex case is the same 20-byte account and is accepted (case is not identity); the result's own spelling is what is stored", async () => {
    const w = await world();
    w.turnkey.transformWalletAccounts = (a) => [{ ...a[0], address: String(a[0]!.address).toLowerCase() }];
    expect(await w.dispatch()).toMatchObject({ kind: "created", provisioned: { ownerAddress: FAKE_OWNER_ADDRESS } });
  });
});
