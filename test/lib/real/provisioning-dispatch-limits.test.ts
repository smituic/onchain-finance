// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, encodeAbiParameters, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { bytesToBase64Url, randomBytes } from "@/lib/real/bytes";
import { createInMemoryChallengeStore } from "@/lib/real/server/challenge-store";
import type { RealServerConfig } from "@/lib/real/server/config";
import { GENERIC_SERVER_ERROR_MESSAGE } from "@/lib/real/server/http";
import { completeLogin, beginLogin } from "@/lib/real/server/login";
import {
  PROVISIONING_NEEDS_REVIEW_REASON,
  REGISTRATION_CAPACITY_REACHED_REASON,
  REGISTRATION_SETUP_EXHAUSTED_REASON,
  runProvisioningPipeline,
  type OnboardingOutcome,
} from "@/lib/real/server/onboarding";
import { runProvisioningDispatch } from "@/lib/real/server/provisioning-dispatch";
import { beginRegistration, completeRegistration } from "@/lib/real/server/registration";
import {
  PROVISIONING_ATTEMPT_DISPATCH_BUDGET,
  PROVISIONING_DAILY_WINDOW_MS,
  PROVISIONING_GLOBAL_DAILY_DISPATCH_LIMIT,
  PROVISIONING_GLOBAL_HOURLY_DISPATCH_LIMIT,
  PROVISIONING_HOURLY_WINDOW_MS,
  createInMemoryRegistrationAttemptStore,
  type DispatchTerminalStatus,
  type RegistrationAttempt,
  type RegistrationAttemptStore,
} from "@/lib/real/server/registration-attempts";
import { createInMemoryRealAccountRegistry } from "@/lib/real/server/registry";
import { claimed, completedObservation, failedObservation } from "./fixtures/provisioning-seed";
import { FAKE_OWNER_ADDRESS, FakeParentTurnkey, type FakeSubmitMode } from "./fixtures/turnkey-parent-fake";
import { buildAuthenticationResponseJSON, buildRegistrationResponseJSON, createFixtureAuthenticator } from "./fixtures/webauthn";

/**
 * Registration Abuse Protection (Milestone 1, Slice 1): the dispatch
 * ceilings. OFFLINE ONLY — the in-memory store with an injected clock, the
 * fake parent Turnkey, mocked route dependencies, and static checks of the
 * Neon statement text. Nothing here proves PostgreSQL locking or snapshot
 * behavior under real concurrency: that needs a separately authorized
 * disposable-Neon smoke. (The Neon statement's exact shape is pinned in
 * neon-provisioning-dispatch.test.ts.)
 */
const HOUR = PROVISIONING_HOURLY_WINDOW_MS;
const DAY = PROVISIONING_DAILY_WINDOW_MS;
const T0 = Date.parse("2026-10-12T00:00:00.000Z");
const IDENTITY = { subOrganizationId: "sub-org-1", turnkeyUserId: "turnkey-user-1", walletId: "wallet-1", walletAccountId: "wallet-account-1", ownerAddress: FAKE_OWNER_ADDRESS };
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

let seq = 0;
function ledger(start = T0) {
  const clock = { t: start };
  const store = createInMemoryRegistrationAttemptStore({ now: () => clock.t });
  const verified = async () => {
    seq += 1;
    return store.createVerified({
      credentialId: bytesToBase64Url(randomBytes(16)),
      appUserId: `1c7d2e3f-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      userHandle: `limit-handle-${seq}`,
      credentialPublicKey: `cose-${seq}`,
      counter: 0,
      transports: ["internal"],
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
      registrationChallenge: `challenge-${seq}`,
      rawClientDataJson: "client-data-json",
      rawAttestationObject: "attestation-object",
    });
  };
  const claim = (credentialId: string) => {
    seq += 1;
    const body = `limit-body-${seq}`;
    return store.beginProvisioningDispatch({
      credentialId,
      attemptedAt: new Date(clock.t).toISOString(),
      evidence: { evidenceVersion: 1, organizationId: "parent-org", stampPublicKey: "pub", requestTimestampMs: clock.t, requestBody: body, requestBodySha256: sha(body) },
    });
  };
  /** `count` committed dispatches at the current clock reading, each on its own fresh attempt. */
  const fill = async (count: number) => {
    for (let i = 0; i < count; i += 1) claimed(await claim((await verified()).credentialId));
  };
  /** One committed dispatch on a fresh attempt, resolved the given way (or left open). */
  const dispatchEnding = async (ending: "open" | "uncertain_with_id" | DispatchTerminalStatus) => {
    const attempt = await verified();
    const { dispatch } = claimed(await claim(attempt.credentialId));
    if (ending === "open") return attempt;
    const activityId = `activity-${dispatch.id}`;
    await store.recordDispatchActivity({ dispatchId: dispatch.id, activityId, fingerprint: null });
    if (ending === "uncertain_with_id") return attempt;
    await store.recordDispatchTerminal({ dispatchId: dispatch.id, activityId, observation: ending === "ACTIVITY_STATUS_COMPLETED" ? completedObservation(IDENTITY) : failedObservation({ status: ending }) });
    if (ending === "ACTIVITY_STATUS_COMPLETED") await store.advanceProvisioningToTurnkeyCreated({ credentialId: attempt.credentialId, dispatchId: dispatch.id, activityId, identity: IDENTITY });
    else await store.revertProvisioningAfterDefinitiveFailure({ credentialId: attempt.credentialId, dispatchId: dispatch.id, activityId });
    return attempt;
  };
  /** A claimed dispatch taken through a proven definitive failure, back to 'verified'. */
  const failDefinitively = async (credentialId: string) => {
    const { dispatch } = claimed(await claim(credentialId));
    const activityId = `activity-${dispatch.id}`;
    await store.recordDispatchActivity({ dispatchId: dispatch.id, activityId, fingerprint: null });
    await store.recordDispatchTerminal({ dispatchId: dispatch.id, activityId, observation: failedObservation() });
    expect(await store.revertProvisioningAfterDefinitiveFailure({ credentialId, dispatchId: dispatch.id, activityId })).toMatchObject({ state: "verified", externalOutcome: "definitive_failure" });
  };
  const total = async (credentialIds: string[]) => (await Promise.all(credentialIds.map((id) => store.findDispatchesByCredentialId(id)))).flat().length;
  return { clock, store, verified, claim, fill, dispatchEnding, failDefinitively, total };
}

describe("the limits are code constants", () => {
  it("5 per rolling hour, 20 per rolling 24 hours, 2 per attempt — and no environment variable can change them", () => {
    expect(PROVISIONING_GLOBAL_HOURLY_DISPATCH_LIMIT).toBe(5);
    expect(PROVISIONING_GLOBAL_DAILY_DISPATCH_LIMIT).toBe(20);
    expect(PROVISIONING_ATTEMPT_DISPATCH_BUDGET).toBe(2);
    expect(HOUR).toBe(3_600_000);
    expect(DAY).toBe(86_400_000);
    for (const file of ["lib/real/server/registration-attempts.ts", "lib/real/server/provisioning-dispatch.ts", "lib/real/server/onboarding.ts"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/process\.env/);
    }
    const claim = /async beginProvisioningDispatch\([\s\S]*?\n    \},\n/.exec(readFileSync("lib/real/server/neon-store.ts", "utf8"))?.[0] ?? "";
    expect(claim).not.toBe("");
    expect(claim).not.toMatch(/process\.env/);
  });
});

describe("global hourly ceiling: 5 committed dispatches per rolling hour", () => {
  it.each([0, 4])("with %i dispatches in the last hour, the next claim is admitted", async (existing) => {
    const w = ledger();
    await w.fill(existing);
    expect((await w.claim((await w.verified()).credentialId)).outcome).toBe("claimed");
  });

  it("the 5th is admitted; the 6th is refused, and so is every one after it", async () => {
    const w = ledger();
    await w.fill(4);
    expect((await w.claim((await w.verified()).credentialId)).outcome).toBe("claimed");
    for (let i = 0; i < 3; i += 1) expect(await w.claim((await w.verified()).credentialId)).toEqual({ outcome: "global_capacity_reached" });
  });

  it("boundary: a dispatch counts while createdAt > admission - 1h — one millisecond short of the hour still counts, exactly one hour old does not", async () => {
    const w = ledger();
    await w.fill(5);
    const waiting = await w.verified();
    w.clock.t = T0 + HOUR - 1;
    expect(await w.claim(waiting.credentialId)).toEqual({ outcome: "global_capacity_reached" });
    w.clock.t = T0 + HOUR;
    expect((await w.claim(waiting.credentialId)).outcome).toBe("claimed");
  });

  it("rolling, not a fixed block: capacity returns one dispatch at a time as each one ages out", async () => {
    const w = ledger();
    for (let i = 0; i < 5; i += 1) {
      w.clock.t = T0 + i * 60_000; // one a minute
      await w.fill(1);
    }
    w.clock.t = T0 + HOUR; // only the first has aged out
    expect((await w.claim((await w.verified()).credentialId)).outcome).toBe("claimed");
    expect(await w.claim((await w.verified()).credentialId)).toEqual({ outcome: "global_capacity_reached" });
    w.clock.t = T0 + HOUR + 60_000; // now the second has too
    expect((await w.claim((await w.verified()).credentialId)).outcome).toBe("claimed");
    expect(await w.claim((await w.verified()).credentialId)).toEqual({ outcome: "global_capacity_reached" });
  });

  it("rows older than the window do not count toward the hour", async () => {
    const w = ledger();
    await w.fill(5);
    w.clock.t = T0 + 2 * HOUR;
    await w.fill(5); // all five admitted: the earlier five are outside the hour
    expect(await w.claim((await w.verified()).credentialId)).toEqual({ outcome: "global_capacity_reached" });
  });

  it("a row dated in the future (a clock that stepped back) still counts — never extra capacity", async () => {
    const w = ledger();
    await w.fill(5);
    w.clock.t = T0 - 10 * 60_000;
    expect(await w.claim((await w.verified()).credentialId)).toEqual({ outcome: "global_capacity_reached" });
  });
});

describe("global daily ceiling: 20 committed dispatches per rolling 24 hours", () => {
  /** `count` dispatches, never more than 5 in any hour: batches of five, 61 minutes apart. Returns the time of the first. */
  async function spread(w: ReturnType<typeof ledger>, count: number) {
    for (let i = 0; i < count; i += 1) {
      w.clock.t = T0 + Math.floor(i / 5) * 61 * 60_000;
      await w.fill(1);
    }
  }

  it.each([0, 19])("with %i dispatches in the last 24 hours (hourly ceiling clear), the next claim is admitted", async (existing) => {
    const w = ledger();
    await spread(w, existing);
    w.clock.t = T0 + 6 * HOUR;
    expect((await w.claim((await w.verified()).credentialId)).outcome).toBe("claimed");
  });

  it("the 20th is admitted; the 21st is refused although the hourly ceiling is clear", async () => {
    const w = ledger();
    await spread(w, 19);
    w.clock.t = T0 + 6 * HOUR;
    expect((await w.claim((await w.verified()).credentialId)).outcome).toBe("claimed"); // the 20th
    w.clock.t = T0 + 8 * HOUR; // nothing in the last hour at all
    expect(await w.claim((await w.verified()).credentialId)).toEqual({ outcome: "global_capacity_reached" });
  });

  it("boundary: one millisecond short of 24 hours still counts; exactly 24 hours old does not", async () => {
    const w = ledger();
    await spread(w, 20); // five at T0, then +61m, +122m, +183m
    const waiting = await w.verified();
    w.clock.t = T0 + DAY - 1;
    expect(await w.claim(waiting.credentialId)).toEqual({ outcome: "global_capacity_reached" });
    w.clock.t = T0 + DAY; // the five from T0 age out together
    expect((await w.claim(waiting.credentialId)).outcome).toBe("claimed");
  });

  it("interaction: the hourly ceiling refuses while the daily one has room, and the daily one refuses while the hourly one has room", async () => {
    const hourly = ledger();
    await hourly.fill(5); // 5 in the hour, 5 in the day
    expect(await hourly.claim((await hourly.verified()).credentialId)).toEqual({ outcome: "global_capacity_reached" });

    const daily = ledger();
    await spread(daily, 20);
    daily.clock.t = T0 + 12 * HOUR; // 0 in the hour, 20 in the day
    expect(await daily.claim((await daily.verified()).credentialId)).toEqual({ outcome: "global_capacity_reached" });
  });

  it("at most 5 x 24 = 120 could ever fit the hourly ceiling in a day; the daily ceiling holds it to 20", async () => {
    const w = ledger();
    let admitted = 0;
    for (let minute = 0; minute < 24 * 60; minute += 5) {
      w.clock.t = T0 + minute * 60_000;
      if ((await w.claim((await w.verified()).credentialId)).outcome === "claimed") admitted += 1;
    }
    expect(admitted).toBe(20);
  });
});

describe("every committed dispatch counts, whatever became of it", () => {
  it.each([
    ["still open, nothing sent yet (a crash right after the claim committed)", "open"],
    ["sent, outcome unknown (timeout / lost response)", "uncertain_with_id"],
    ["COMPLETED", "ACTIVITY_STATUS_COMPLETED"],
    ["FAILED (a proven definitive failure)", "ACTIVITY_STATUS_FAILED"],
    ["REJECTED", "ACTIVITY_STATUS_REJECTED"],
  ] as const)("five dispatches that are each %s fill the hourly ceiling", async (_label, ending) => {
    const w = ledger();
    for (let i = 0; i < 5; i += 1) await w.dispatchEnding(ending);
    expect(await w.claim((await w.verified()).credentialId)).toEqual({ outcome: "global_capacity_reached" });
  });

  it("a mix of outcomes is counted row by row — successful accounts are not what is counted", async () => {
    const w = ledger();
    for (const ending of ["open", "uncertain_with_id", "ACTIVITY_STATUS_COMPLETED", "ACTIVITY_STATUS_FAILED", "ACTIVITY_STATUS_REJECTED"] as const) await w.dispatchEnding(ending);
    expect(await w.claim((await w.verified()).credentialId)).toEqual({ outcome: "global_capacity_reached" });
  });

  it("no refund: a definitive failure's retry spends a SECOND unit of global capacity", async () => {
    const w = ledger();
    const attempt = await w.verified();
    await w.failDefinitively(attempt.credentialId); // 1
    await w.fill(3); // 4
    expect((await w.claim(attempt.credentialId)).outcome).toBe("claimed"); // 5: the retry
    expect(await w.claim((await w.verified()).credentialId)).toEqual({ outcome: "global_capacity_reached" });
  });
});

describe("per-attempt budget: 2 committed dispatches, ever", () => {
  it("first claim: admitted, sequence 1", async () => {
    const w = ledger();
    const attempt = await w.verified();
    expect(claimed(await w.claim(attempt.credentialId)).dispatch.dispatchSeq).toBe(1);
  });

  it("a definitive failure permits exactly one more: the second claim is admitted, sequence 2", async () => {
    const w = ledger();
    const attempt = await w.verified();
    await w.failDefinitively(attempt.credentialId);
    expect(claimed(await w.claim(attempt.credentialId)).dispatch.dispatchSeq).toBe(2);
  });

  it("a second definitive failure exhausts the budget: the third claim is refused, now and on every later try, and writes nothing", async () => {
    const w = ledger();
    const attempt = await w.verified();
    await w.failDefinitively(attempt.credentialId);
    await w.failDefinitively(attempt.credentialId);
    const before = { attempt: await w.store.findByCredentialId(attempt.credentialId), rows: await w.store.findDispatchesByCredentialId(attempt.credentialId) };
    expect(before.attempt).toMatchObject({ state: "verified", externalOutcome: "definitive_failure" });
    for (let i = 0; i < 4; i += 1) expect(await w.claim(attempt.credentialId)).toEqual({ outcome: "attempt_budget_exhausted" });
    expect(await w.store.findByCredentialId(attempt.credentialId)).toEqual(before.attempt);
    expect(await w.store.findDispatchesByCredentialId(attempt.credentialId)).toEqual(before.rows);
    expect(before.rows.map((row) => row.dispatchSeq)).toEqual([1, 2]);
  });

  it("the budget is permanent: no amount of waiting restores it, though the global windows have long since emptied", async () => {
    const w = ledger();
    const attempt = await w.verified();
    await w.failDefinitively(attempt.credentialId);
    await w.failDefinitively(attempt.credentialId);
    w.clock.t = T0 + 30 * DAY;
    expect(await w.claim(attempt.credentialId)).toEqual({ outcome: "attempt_budget_exhausted" });
    // ...while a different attempt is admitted at that same moment.
    expect((await w.claim((await w.verified()).credentialId)).outcome).toBe("claimed");
  });

  it("the budget is durable evidence, not request state: a 'new' store handle over the same data still refuses", async () => {
    const w = ledger();
    const attempt = await w.verified();
    await w.failDefinitively(attempt.credentialId);
    await w.failDefinitively(attempt.credentialId);
    const sameData: RegistrationAttemptStore = { ...w.store };
    seq += 1;
    const body = `limit-body-${seq}`;
    expect(await sameData.beginProvisioningDispatch({ credentialId: attempt.credentialId, attemptedAt: new Date(T0).toISOString(), evidence: { evidenceVersion: 1, organizationId: "parent-org", stampPublicKey: "pub", requestTimestampMs: T0, requestBody: body, requestBodySha256: sha(body) } })).toEqual({
      outcome: "attempt_budget_exhausted",
    });
  });

  it("no refund after an uncertain outcome: the attempt is in flight, so it cannot claim at all — and its row keeps counting", async () => {
    const w = ledger();
    const attempt = await w.dispatchEnding("uncertain_with_id");
    expect(await w.claim(attempt.credentialId)).toEqual({ outcome: "claim_lost" });
    expect(await w.store.findByCredentialId(attempt.credentialId)).toMatchObject({ state: "provisioning_in_flight", externalOutcome: "unknown" });
    expect(await w.store.findDispatchesByCredentialId(attempt.credentialId)).toHaveLength(1);
  });

  it("both exhausted: the permanent answer wins over the temporary one", async () => {
    const w = ledger();
    const attempt = await w.verified();
    await w.failDefinitively(attempt.credentialId);
    await w.failDefinitively(attempt.credentialId);
    await w.fill(3); // the hourly ceiling is now full too
    expect(await w.claim((await w.verified()).credentialId)).toEqual({ outcome: "global_capacity_reached" });
    expect(await w.claim(attempt.credentialId)).toEqual({ outcome: "attempt_budget_exhausted" });
  });

  it("repeated and concurrent claims for one attempt can never exceed 2 rows", async () => {
    const w = ledger();
    const attempt = await w.verified();
    for (let round = 0; round < 4; round += 1) {
      const results = await Promise.all([1, 2, 3, 4].map(() => w.claim(attempt.credentialId)));
      const won = results.filter((result) => result.outcome === "claimed");
      expect(won.length).toBeLessThanOrEqual(1);
      if (won[0]?.outcome === "claimed") {
        const { dispatch } = won[0];
        const activityId = `activity-${dispatch.id}`;
        await w.store.recordDispatchActivity({ dispatchId: dispatch.id, activityId, fingerprint: null });
        await w.store.recordDispatchTerminal({ dispatchId: dispatch.id, activityId, observation: failedObservation() });
        await w.store.revertProvisioningAfterDefinitiveFailure({ credentialId: attempt.credentialId, dispatchId: dispatch.id, activityId });
      }
    }
    expect((await w.store.findDispatchesByCredentialId(attempt.credentialId)).map((row) => row.dispatchSeq)).toEqual([1, 2]);
  });
});

describe("a refusal changes nothing", () => {
  async function refusedBy(kind: "global_capacity_reached" | "attempt_budget_exhausted", priorOutcome: "not_attempted" | "definitive_failure") {
    const w = ledger();
    const attempt = await w.verified();
    if (kind === "attempt_budget_exhausted") {
      await w.failDefinitively(attempt.credentialId);
      await w.failDefinitively(attempt.credentialId);
    } else {
      if (priorOutcome === "definitive_failure") await w.failDefinitively(attempt.credentialId);
      await w.fill(priorOutcome === "definitive_failure" ? 4 : 5);
    }
    return { w, attempt };
  }

  it.each([
    ["global_capacity_reached", "not_attempted"],
    ["global_capacity_reached", "definitive_failure"],
    ["attempt_budget_exhausted", "definitive_failure"],
  ] as const)("%s (externalOutcome %s): the attempt stays 'verified' with its outcome, timestamps, and identity untouched; no row; no sequence number used", async (kind, priorOutcome) => {
    const { w, attempt } = await refusedBy(kind, priorOutcome);
    const before = { attempt: (await w.store.findByCredentialId(attempt.credentialId))!, rows: await w.store.findDispatchesByCredentialId(attempt.credentialId) };
    expect(before.attempt).toMatchObject({ state: "verified", externalOutcome: priorOutcome });

    w.clock.t += 1_000;
    expect(await w.claim(attempt.credentialId)).toEqual({ outcome: kind });

    expect(await w.store.findByCredentialId(attempt.credentialId)).toEqual(before.attempt); // state, externalOutcome, externalProvisioningAttemptedAt, updatedAt — all of it
    expect(await w.store.findDispatchesByCredentialId(attempt.credentialId)).toEqual(before.rows);
  });

  it("a refused claim does not consume the sequence number: the next admitted claim is the very next one", async () => {
    const { w, attempt } = await refusedBy("global_capacity_reached", "definitive_failure");
    for (let i = 0; i < 3; i += 1) expect(await w.claim(attempt.credentialId)).toEqual({ outcome: "global_capacity_reached" });
    w.clock.t = T0 + HOUR + 1_000;
    expect(claimed(await w.claim(attempt.credentialId)).dispatch.dispatchSeq).toBe(2);
  });

  it("a refused claim does not consume global capacity either: only the admitted five are in the ledger", async () => {
    const w = ledger();
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const attempt = await w.verified();
      ids.push(attempt.credentialId);
      await w.claim(attempt.credentialId);
    }
    expect(await w.total(ids)).toBe(5);
  });

  it("a refusal comes before evidence validation, so a refused claim cannot throw its way into a different answer", async () => {
    const w = ledger();
    await w.fill(5);
    const attempt = await w.verified();
    expect(await w.store.beginProvisioningDispatch({ credentialId: attempt.credentialId, attemptedAt: new Date(T0).toISOString(), evidence: { evidenceVersion: 1, organizationId: "parent-org", stampPublicKey: "pub", requestTimestampMs: T0, requestBody: "x", requestBodySha256: "not-a-digest" } })).toEqual({
      outcome: "global_capacity_reached",
    });
  });

  it("a claim that throws (rolled back) consumes nothing: the attempt stays 'verified' and the ceiling still has its room", async () => {
    const w = ledger();
    await w.fill(4);
    const attempt = await w.verified();
    await expect(w.store.beginProvisioningDispatch({ credentialId: attempt.credentialId, attemptedAt: new Date(T0).toISOString(), evidence: { evidenceVersion: 1, organizationId: "parent-org", stampPublicKey: "pub", requestTimestampMs: T0, requestBody: "x", requestBodySha256: sha("y") } })).rejects.toThrow(
      /Provisioning dispatch evidence/,
    );
    expect(await w.store.findByCredentialId(attempt.credentialId)).toMatchObject({ state: "verified", externalOutcome: "not_attempted" });
    expect(await w.store.findDispatchesByCredentialId(attempt.credentialId)).toEqual([]);
    expect((await w.claim(attempt.credentialId)).outcome).toBe("claimed"); // the 5th is still available
    expect(await w.claim((await w.verified()).credentialId)).toEqual({ outcome: "global_capacity_reached" });
  });
});

describe("states that may never claim still never claim — with capacity to spare", () => {
  it.each(["provisioning_in_flight", "turnkey_created", "active", "blocked"] as const)("%s -> claim_lost, no row, no state change", async (state) => {
    const w = ledger();
    const registry = createInMemoryRealAccountRegistry();
    const attempt = state === "provisioning_in_flight" ? await w.dispatchEnding("uncertain_with_id") : await w.dispatchEnding("ACTIVITY_STATUS_COMPLETED");
    if (state === "blocked") await w.store.transition({ credentialId: attempt.credentialId, from: "turnkey_created", to: "blocked", patch: { blockReason: "x" } });
    if (state === "active") expect(await w.store.finalize({ credentialId: attempt.credentialId, registry, safeAddress: `0x${"5".repeat(40)}`, safeOwnerAddress: FAKE_OWNER_ADDRESS, accountConfigVersion: 1 })).not.toBeNull();
    const before = { attempt: await w.store.findByCredentialId(attempt.credentialId), rows: await w.store.findDispatchesByCredentialId(attempt.credentialId) };
    expect(before.attempt?.state).toBe(state);
    expect(await w.claim(attempt.credentialId)).toEqual({ outcome: "claim_lost" });
    expect(await w.store.findByCredentialId(attempt.credentialId)).toEqual(before.attempt);
    expect(await w.store.findDispatchesByCredentialId(attempt.credentialId)).toEqual(before.rows);
  });

  it("an unknown credential -> claim_lost", async () => {
    const w = ledger();
    expect(await w.claim("no-such-credential")).toEqual({ outcome: "claim_lost" });
  });

  it("stale concurrent requests: one wins, the rest are claim_lost — never a second row, never a capacity answer", async () => {
    const w = ledger();
    const attempt = await w.verified();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => w.claim(attempt.credentialId)));
    expect(results.map((result) => result.outcome).sort()).toEqual(["claim_lost", "claim_lost", "claim_lost", "claim_lost", "claimed"]);
    expect(await w.store.findDispatchesByCredentialId(attempt.credentialId)).toHaveLength(1);
  });

  it("an attempt's sequence numbers are always exactly 1..n through the store's API, and both stores treat anything else as an error — never extra capacity", async () => {
    const w = ledger();
    const attempt = await w.verified();
    await w.failDefinitively(attempt.credentialId);
    await w.failDefinitively(attempt.credentialId);
    expect((await w.store.findDispatchesByCredentialId(attempt.credentialId)).map((row) => row.dispatchSeq)).toEqual([1, 2]);
    // No API can produce a gap, so the inconsistent case is pinned at the source: it throws / aborts before any budget or capacity answer.
    expect(readFileSync("lib/real/server/registration-attempts.ts", "utf8")).toContain('if (ownMaxSeq !== own.length) throw new Error("Provisioning dispatch ledger is inconsistent for this attempt.");');
    const neon = readFileSync("lib/real/server/neon-store.ts", "utf8");
    expect(neon.indexOf("WHEN l.own_max_seq <> l.own_count THEN 'ledger_inconsistent'")).toBeGreaterThan(0);
    expect(neon.indexOf("WHEN l.own_max_seq <> l.own_count THEN 'ledger_inconsistent'")).toBeLessThan(neon.indexOf("THEN 'attempt_budget_exhausted'"));
    expect(neon).toContain('if (decision === "ledger_inconsistent") throw new Error("Provisioning dispatch ledger is inconsistent for this attempt.");');
  });
});

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
const ORIGIN = "http://localhost:3000";

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

/** The pipeline over an in-memory ledger and the fake parent Turnkey. */
function pipelineWorld() {
  const w = ledger();
  const registry = createInMemoryRealAccountRegistry();
  const turnkey = new FakeParentTurnkey();
  const run = (attempt: RegistrationAttempt, attempts: RegistrationAttemptStore = w.store) =>
    runProvisioningPipeline({ config, registry, attempts, attempt, publicClient: buildPublicClient(), provisioningDeps: turnkey.deps() });
  const current = async (credentialId: string) => (await w.store.findByCredentialId(credentialId))!;
  return { ...w, registry, turnkey, run, current };
}

const CAPACITY: OnboardingOutcome = { outcome: "capacity_reached", reason: REGISTRATION_CAPACITY_REACHED_REASON };
const EXHAUSTED: OnboardingOutcome = { outcome: "setup_exhausted", reason: REGISTRATION_SETUP_EXHAUSTED_REASON };

describe("through the dispatch and the pipeline: a refusal reaches no provider", () => {
  it("global capacity reached: the dispatch reports it with ZERO Turnkey requests, and the pipeline says 'not right now' — attempt untouched", async () => {
    const w = pipelineWorld();
    await w.fill(5);
    const attempt = await w.verified();
    expect(await runProvisioningDispatch({ config, attempts: w.store, attempt, deps: w.turnkey.deps() })).toEqual({ kind: "capacity_reached" });
    expect(await w.run(attempt)).toEqual(CAPACITY);
    expect(w.turnkey.requests).toHaveLength(0);
    expect(await w.current(attempt.credentialId)).toEqual(attempt);
    expect(await w.store.findDispatchesByCredentialId(attempt.credentialId)).toEqual([]);
    expect(await w.registry.findAccountByAppUserId(attempt.appUserId)).toBeNull();
    expect(await w.registry.findPasskeyByCredentialId(attempt.credentialId)).toBeNull();
  });

  it("the same attempt is admitted later, with no new registration: the ceiling was temporary", async () => {
    const w = pipelineWorld();
    await w.fill(5);
    const attempt = await w.verified();
    expect(await w.run(attempt)).toEqual(CAPACITY);
    w.clock.t = T0 + HOUR;
    expect((await w.run(await w.current(attempt.credentialId))).outcome).toBe("verified");
    expect(w.turnkey.createRequests).toHaveLength(1);
    expect((await w.store.findDispatchesByCredentialId(attempt.credentialId)).map((row) => row.dispatchSeq)).toEqual([1]);
  });

  it("the pipeline does not retry, loop, or re-read on a refusal: one claim attempt per run", async () => {
    const w = pipelineWorld();
    await w.fill(5);
    const attempt = await w.verified();
    const begin = vi.fn(w.store.beginProvisioningDispatch);
    const find = vi.fn(w.store.findByCredentialId);
    expect(await w.run(attempt, { ...w.store, beginProvisioningDispatch: begin, findByCredentialId: find })).toEqual(CAPACITY);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(find).not.toHaveBeenCalled();
  });

  it("two definitive failures: the first invites a retry, the second says setup could not be finished — and a third run sends nothing", async () => {
    const w = pipelineWorld();
    const attempt = await w.verified();
    w.turnkey.submitQueue.push("failed", "rejected");
    expect(await w.run(attempt)).toEqual({ outcome: "pending", reason: "Account setup failed and can be retried. Try again in a moment." });
    expect(await w.run(await w.current(attempt.credentialId))).toEqual(EXHAUSTED);
    expect(await w.current(attempt.credentialId)).toMatchObject({ state: "verified", externalOutcome: "definitive_failure" });
    expect(w.turnkey.createRequests).toHaveLength(2);

    const before = { attempt: await w.current(attempt.credentialId), rows: await w.store.findDispatchesByCredentialId(attempt.credentialId) };
    w.clock.t = T0 + 3 * DAY;
    for (let i = 0; i < 3; i += 1) expect(await w.run(await w.current(attempt.credentialId))).toEqual(EXHAUSTED);
    expect(w.turnkey.createRequests).toHaveLength(2); // the working create that is queued next is never reached
    expect(await w.current(attempt.credentialId)).toEqual(before.attempt);
    expect(await w.store.findDispatchesByCredentialId(attempt.credentialId)).toEqual(before.rows);
    expect(await w.registry.findAccountByAppUserId(attempt.appUserId)).toBeNull();
  });

  it("the second dispatch may still succeed: a definitive failure followed by a completed create activates the account", async () => {
    const w = pipelineWorld();
    const attempt = await w.verified();
    w.turnkey.submitQueue.push("failed");
    expect((await w.run(attempt)).outcome).toBe("pending");
    expect((await w.run(await w.current(attempt.credentialId))).outcome).toBe("verified");
    expect(await w.current(attempt.credentialId)).toMatchObject({ state: "active" });
  });

  it.each([
    ["a submit timeout", "hang"],
    ["a transport error", "network_error_before_apply"],
    ["a lost response after the create applied", "lose_response_after_apply"],
    ["a non-2xx answer", "http_500"],
    ["an unparseable answer", "unparseable"],
  ] as Array<[string, FakeSubmitMode]>)("%s after the dispatch: needs review exactly as before, the capacity stays spent, and no later run dispatches again", async (_label, mode) => {
    const w = pipelineWorld();
    await w.fill(4);
    const attempt = await w.verified();
    w.turnkey.submitMode = mode;
    const deps = w.turnkey.deps({ limits: { submitTimeoutMs: 15 } });
    expect(await runProvisioningPipeline({ config, registry: w.registry, attempts: w.store, attempt, publicClient: buildPublicClient(), provisioningDeps: deps })).toEqual({ outcome: "pending", reason: PROVISIONING_NEEDS_REVIEW_REASON });
    expect(await w.current(attempt.credentialId)).toMatchObject({ state: "provisioning_in_flight", externalOutcome: "unknown" });

    // The uncertain dispatch was the 5th: it is not refunded.
    const other = await w.verified();
    expect(await w.run(other)).toEqual(CAPACITY);
    // And the uncertain attempt itself is never dispatched again — review, not a capacity or budget answer.
    w.turnkey.submitMode = "completed";
    const creates = w.turnkey.createRequests.length;
    w.clock.t = T0 + 2 * DAY;
    for (let i = 0; i < 3; i += 1) expect(await w.run(await w.current(attempt.credentialId))).toEqual({ outcome: "pending", reason: PROVISIONING_NEEDS_REVIEW_REASON });
    expect(w.turnkey.createRequests).toHaveLength(creates);
    expect(await w.store.findDispatchesByCredentialId(attempt.credentialId)).toHaveLength(1);
  });

  it("a process crash right after the claim committed: the capacity is spent, nothing was sent, and the attempt is in review — not retried", async () => {
    const w = pipelineWorld();
    await w.fill(4);
    const attempt = await w.verified();
    const crashing: RegistrationAttemptStore = {
      ...w.store,
      async beginProvisioningDispatch(input) {
        await w.store.beginProvisioningDispatch(input); // committed...
        throw new Error("process died"); // ...and the caller never learns it
      },
    };
    await expect(w.run(attempt, crashing)).rejects.toThrow("process died");
    expect(w.turnkey.requests).toHaveLength(0);
    expect(await w.current(attempt.credentialId)).toMatchObject({ state: "provisioning_in_flight", externalOutcome: "unknown" });
    expect(await w.run(await w.current(attempt.credentialId))).toEqual({ outcome: "pending", reason: PROVISIONING_NEEDS_REVIEW_REASON });
    expect(await w.run(await w.verified())).toEqual(CAPACITY); // that was the 5th
    expect(w.turnkey.requests).toHaveLength(0);
  });

  it("the claim transaction rolling back (a database error) is THROWN — never reported as capacity, never a dispatch — and consumes nothing", async () => {
    const w = pipelineWorld();
    await w.fill(4);
    const attempt = await w.verified();
    const failing: RegistrationAttemptStore = {
      ...w.store,
      async beginProvisioningDispatch() {
        throw new Error("connection terminated");
      },
    };
    await expect(w.run(attempt, failing)).rejects.toThrow("connection terminated");
    expect(w.turnkey.requests).toHaveLength(0);
    expect(await w.current(attempt.credentialId)).toEqual(attempt);
    expect((await w.run(attempt)).outcome).toBe("verified"); // the 5th unit was still there
  });

  it("a lost claim keeps its old handling: re-read once and report the durable state", async () => {
    const w = pipelineWorld();
    const attempt = await w.dispatchEnding("uncertain_with_id");
    // A stale 'verified' view of an attempt another request already claimed.
    expect(await w.run({ ...(await w.current(attempt.credentialId)), state: "verified", externalOutcome: "not_attempted" })).toEqual({ outcome: "pending", reason: PROVISIONING_NEEDS_REVIEW_REASON });
    expect(w.turnkey.requests).toHaveLength(0);
  });

  it("blocked and active attempts never reach the claim, whatever the ceilings say", async () => {
    const w = pipelineWorld();
    await w.fill(5);
    const begin = vi.fn(w.store.beginProvisioningDispatch);
    const store = { ...w.store, beginProvisioningDispatch: begin };
    const attempt = await w.verified();
    expect((await w.run({ ...attempt, state: "blocked", blockReason: "manual" }, store)).outcome).toBe("blocked");
    expect((await w.run({ ...attempt, state: "active" }, store)).outcome).toBe("rejected"); // no account rows: fails closed
    expect((await w.run({ ...attempt, state: "provisioning_in_flight" }, store)).outcome).toBe("pending");
    expect(begin).not.toHaveBeenCalled();
    expect(w.turnkey.requests).toHaveLength(0);
  });

  it("no ceiling outcome can ever carry a session or an account", () => {
    for (const outcome of [CAPACITY, EXHAUSTED]) expect(Object.keys(outcome).sort()).toEqual(["outcome", "reason"]);
  });
});

describe("registration, then continuing by signing in", () => {
  async function register(w: ReturnType<typeof pipelineWorld>) {
    const challengeStore = createInMemoryChallengeStore();
    const authenticator = createFixtureAuthenticator();
    const { optionsJSON } = await beginRegistration({ config, challengeStore });
    const result = await completeRegistration({ config, challengeStore, registry: w.registry, attempts: w.store, publicClient: buildPublicClient(), provisioningDeps: w.turnkey.deps(), response: buildRegistrationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId }) });
    const credentialId = authenticator.credentialIdBase64Url;
    const login = async () => {
      const { optionsJSON: loginOptions } = await beginLogin({ config, challengeStore });
      const userHandle = (await w.store.findByCredentialId(credentialId))!.userHandle;
      return completeLogin({ config, challengeStore, registry: w.registry, attempts: w.store, publicClient: buildPublicClient(), provisioningDeps: w.turnkey.deps(), response: buildAuthenticationResponseJSON({ authenticator, challenge: loginOptions.challenge, origin: ORIGIN, rpId: config.rpId, userHandle }) });
    };
    return { result, credentialId, login };
  }

  it("registering while the ceiling is full: the passkey's attempt IS saved ('verified'), nothing is sent, and there is no session", async () => {
    const w = pipelineWorld();
    await w.fill(5);
    const r = await register(w);
    expect(r.result).toEqual(CAPACITY);
    expect(await w.store.findByCredentialId(r.credentialId)).toMatchObject({ state: "verified", externalOutcome: "not_attempted", externalProvisioningAttemptedAt: null });
    expect(await w.store.findDispatchesByCredentialId(r.credentialId)).toEqual([]);
    expect(w.turnkey.requests).toHaveLength(0);
  });

  it("repeated sign-in while the ceiling is still full: the same answer every time, nothing sent, nothing changed but the passkey counter", async () => {
    const w = pipelineWorld();
    await w.fill(5);
    const r = await register(w);
    for (let i = 0; i < 4; i += 1) expect(await r.login()).toEqual(CAPACITY);
    expect(await w.store.findByCredentialId(r.credentialId)).toMatchObject({ state: "verified", externalOutcome: "not_attempted" });
    expect(await w.store.findDispatchesByCredentialId(r.credentialId)).toEqual([]);
    expect(w.turnkey.requests).toHaveLength(0);
  });

  it("signing in once the ceiling has room finishes the SAME attempt — one create, one account", async () => {
    const w = pipelineWorld();
    await w.fill(5);
    const r = await register(w);
    w.clock.t = T0 + HOUR;
    const result = await r.login();
    expect(result.outcome).toBe("verified");
    expect(w.turnkey.createRequests).toHaveLength(1);
    expect(await w.store.findByCredentialId(r.credentialId)).toMatchObject({ state: "active" });
  });

  it("the ceiling fills between registration's failure and the sign-in that would retry it: the retry waits, and its budget is not spent", async () => {
    const w = pipelineWorld();
    w.turnkey.submitQueue.push("failed");
    const r = await register(w);
    expect(r.result.outcome).toBe("pending");
    await w.fill(4); // with the failed dispatch, five in the hour
    expect(await r.login()).toEqual(CAPACITY);
    expect(await w.store.findByCredentialId(r.credentialId)).toMatchObject({ state: "verified", externalOutcome: "definitive_failure" });
    expect(await w.store.findDispatchesByCredentialId(r.credentialId)).toHaveLength(1);
    w.clock.t = T0 + HOUR;
    expect((await r.login()).outcome).toBe("verified");
    expect((await w.store.findDispatchesByCredentialId(r.credentialId)).map((row) => row.dispatchSeq)).toEqual([1, 2]);
  });

  it("an exhausted attempt: every sign-in gets the final answer and sends nothing — however long it waits", async () => {
    const w = pipelineWorld();
    w.turnkey.submitQueue.push("failed", "failed");
    const r = await register(w);
    expect(r.result.outcome).toBe("pending");
    expect(await r.login()).toEqual(EXHAUSTED);
    w.clock.t = T0 + 10 * DAY;
    for (let i = 0; i < 3; i += 1) expect(await r.login()).toEqual(EXHAUSTED);
    expect(w.turnkey.createRequests).toHaveLength(2);
    expect(await w.registry.findPasskeyByCredentialId(r.credentialId)).toBeNull();
  });

  it("an uncertain create stays needs-review on every sign-in, even with both ceilings full", async () => {
    const w = pipelineWorld();
    w.turnkey.submitMode = "network_error_before_apply";
    const r = await register(w);
    expect(r.result).toEqual({ outcome: "pending", reason: PROVISIONING_NEEDS_REVIEW_REASON });
    await w.fill(4);
    w.turnkey.submitMode = "completed";
    for (let i = 0; i < 3; i += 1) expect(await r.login()).toEqual({ outcome: "pending", reason: PROVISIONING_NEEDS_REVIEW_REASON });
    expect(w.turnkey.createRequests).toHaveLength(1);
  });
});

describe("the verify routes", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("next/headers");
    vi.doUnmock("@/lib/real/server/runtime");
    vi.doUnmock("@/lib/real/server/registration");
    vi.doUnmock("@/lib/real/server/login");
    vi.unstubAllEnvs();
  });

  async function load(outcome: OnboardingOutcome | Error) {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_REAL_MODE_ENABLED", "true");
    vi.stubEnv("TURNKEY_PARENT_ORGANIZATION_ID", "parent-org");
    vi.stubEnv("TURNKEY_API_PUBLIC_KEY", "public-key");
    vi.stubEnv("TURNKEY_API_PRIVATE_KEY", "private-key");
    vi.stubEnv("REAL_SESSION_SECRET", "4be1c0d27a9f3e8d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170605");
    vi.stubEnv("NEXT_PUBLIC_REAL_RP_ID", "localhost");
    vi.stubEnv("NEXT_PUBLIC_REAL_ORIGIN", ORIGIN);
    vi.stubEnv("PIMLICO_API_KEY", "pim_test_key");
    const cookiesSet: string[] = [];
    const complete = async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    };
    vi.doMock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: (name: string) => void cookiesSet.push(name), delete: () => undefined }) }));
    vi.doMock("@/lib/real/server/runtime", () => ({ getRealAccountRegistry: () => ({}), getChallengeStore: () => ({}), getRegistrationAttemptStore: () => ({}), getAccountHandleStore: () => ({}) }));
    vi.doMock("@/lib/real/server/registration", () => ({ completeRegistration: complete }));
    vi.doMock("@/lib/real/server/login", () => ({ completeLogin: complete }));
    const post = (url: string) => new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response: { id: "x" } }) });
    const register = await import("@/app/api/real/account/register/verify/route");
    const login = await import("@/app/api/real/account/login/verify/route");
    return {
      cookiesSet,
      routes: [
        ["register", () => register.POST(post("/api/real/account/register/verify"))],
        ["login", () => login.POST(post("/api/real/account/login/verify"))],
      ] as const,
    };
  }

  it("global capacity -> 503 with the plain 'not right now' message and code registration_capacity_reached; no cookie, no Retry-After, no numbers", async () => {
    const loaded = await load(CAPACITY);
    for (const [name, call] of loaded.routes) {
      const response = await call();
      expect(response.status, name).toBe(503);
      expect(await response.json(), name).toEqual({ error: REGISTRATION_CAPACITY_REACHED_REASON, code: "registration_capacity_reached" });
      expect(response.headers.get("Retry-After"), name).toBeNull();
    }
    expect(loaded.cookiesSet).toEqual([]);
  });

  it("exhausted attempt -> 409 with the 'couldn't finish' message and code registration_setup_exhausted — not a 429 or 503, not a rate limit", async () => {
    const loaded = await load(EXHAUSTED);
    for (const [name, call] of loaded.routes) {
      const response = await call();
      expect(response.status, name).toBe(409);
      expect(await response.json(), name).toEqual({ error: REGISTRATION_SETUP_EXHAUSTED_REASON, code: "registration_setup_exhausted" });
      expect(response.headers.get("Retry-After"), name).toBeNull();
    }
    expect(loaded.cookiesSet).toEqual([]);
  });

  it("needs-review keeps its own answer: 503, the review message, and no code", async () => {
    const loaded = await load({ outcome: "pending", reason: PROVISIONING_NEEDS_REVIEW_REASON });
    for (const [name, call] of loaded.routes) {
      const response = await call();
      expect(response.status, name).toBe(503);
      expect(await response.json(), name).toEqual({ error: PROVISIONING_NEEDS_REVIEW_REASON });
    }
  });

  it("a database failure is the generic 500 — never the capacity message, never a capacity code", async () => {
    const loaded = await load(new Error('relation "registration_provisioning_dispatches" does not exist'));
    for (const [name, call] of loaded.routes) {
      const response = await call();
      expect(response.status, name).toBe(500);
      expect(await response.json(), name).toEqual({ error: GENERIC_SERVER_ERROR_MESSAGE });
    }
    expect(loaded.cookiesSet).toEqual([]);
  });
});

describe("the copy is ordinary language", () => {
  it("names no vendor, mechanism, limit, count, or window, and promises no automatic retry", () => {
    for (const message of [REGISTRATION_CAPACITY_REACHED_REASON, REGISTRATION_SETUP_EXHAUSTED_REASON]) {
      expect(message).not.toMatch(/turnkey|postgres|neon|database|dispatch|sequence|advisory|lock|gas|safe\b|sub-?org|quota|limit|rate|\d/i);
      expect(message).not.toMatch(/minute|hour|seconds|automatically|shortly|in a moment/i);
    }
    expect(REGISTRATION_CAPACITY_REACHED_REASON).toBe('We can\'t open new accounts right now. Your passkey is saved. Please try again later using "I already have an account."');
    expect(REGISTRATION_SETUP_EXHAUSTED_REASON).toBe("We couldn't finish setting up this account. Trying again with this passkey won't work.");
    // The exhausted message must not read as temporary, and must not send anyone to a support channel that does not exist.
    expect(REGISTRATION_SETUP_EXHAUSTED_REASON).not.toMatch(/later|try again|right now|wait|support|contact/i);
  });
});

/** Every tracked-style source file under the given roots (no node_modules, no build output). */
function sources(roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|mts|mjs|js|sql)$/.test(name)) out.push(full);
    }
  };
  for (const root of roots) walk(root);
  return out;
}

describe("static boundaries (source text only — not a proof of database behavior)", () => {
  const neon = readFileSync("lib/real/server/neon-store.ts", "utf8");
  const claim = /async beginProvisioningDispatch\([\s\S]*?\n    \},\n/.exec(neon)?.[0] ?? "";

  it("ONE insertion path: the only INSERT into the dispatch ledger in application code is the claim's", () => {
    const hits = sources(["lib", "app", "components"]).filter((file) => /INSERT\s+INTO\s+registration_provisioning_dispatches/i.test(readFileSync(file, "utf8")));
    expect(hits).toEqual(["lib/real/server/neon-store.ts"]);
    expect(neon.match(/INSERT\s+INTO\s+registration_provisioning_dispatches/gi)).toHaveLength(1);
    expect(claim.match(/INSERT\s+INTO\s+registration_provisioning_dispatches/gi)).toHaveLength(1);
    // ...and the only writer of 'provisioning_in_flight' is that same statement.
    expect(neon.match(/SET state = 'provisioning_in_flight'/g)).toHaveLength(1);
    expect(claim).toContain("SET state = 'provisioning_in_flight'");
  });

  it("no code path deletes or re-dates a ledger row (capacity is never refunded)", () => {
    for (const file of sources(["lib", "app"])) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/DELETE\s+FROM\s+registration_provisioning_dispatches/i);
    }
    const updates = [...neon.matchAll(/UPDATE registration_provisioning_dispatches\s+SET([\s\S]*?)WHERE/g)].map((match) => match[1]!);
    expect(updates.length).toBeGreaterThan(0);
    for (const set of updates) expect(set).not.toMatch(/\bcreated_at\b|\bcredential_id\b|\bdispatch_seq\b/);
  });

  it("statement order inside the one batch: row lock -> advisory lock -> decide/claim/insert -> read-back", () => {
    const order = ["FOR UPDATE`", "pg_advisory_xact_lock(", "WITH admission AS MATERIALIZED", "clock_timestamp()", "ledger AS MATERIALIZED", "verdict AS MATERIALIZED", "claimed AS (", "inserted AS (", "SELECT * FROM registration_provisioning_dispatches WHERE credential_id"].map((marker) => claim.indexOf(marker));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(claim.match(/sql\.transaction\(/g)).toHaveLength(1);
    // Each lock is a whole statement by itself (so the counting statement starts, and takes its snapshot, after both).
    expect(claim).toMatch(/sql`SELECT credential_id FROM registration_attempts WHERE credential_id = \$\{credentialId\} FOR UPDATE`,\n\s+sql`SELECT pg_catalog\.pg_advisory_xact_lock\(\$\{PROVISIONING_DISPATCH_ADVISORY_LOCK_KEY\}::bigint\)`,\n\s+sql`\n\s+WITH admission/);
    // No capacity read before the batch, and none after it.
    expect(claim.match(/\bawait\b/g)).toHaveLength(1);
  });

  it("the advisory lock is transaction-scoped and dedicated: no session lock anywhere, and the key is used in exactly one place", () => {
    for (const file of sources(["lib", "app"])) {
      const text = readFileSync(file, "utf8");
      if (!file.endsWith("neon-store.ts")) expect(text, file).not.toMatch(/pg_advisory|PROVISIONING_DISPATCH_ADVISORY_LOCK_KEY/);
    }
    const sqlOnly = neon.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(sqlOnly).not.toMatch(/pg_advisory_lock|pg_try_advisory|pg_advisory_unlock/);
    expect(sqlOnly.match(/PROVISIONING_DISPATCH_ADVISORY_LOCK_KEY/g)).toHaveLength(2); // its definition, and the claim
    // Every other advisory lock is a payment lock keyed by a 32-bit hashtext() — a different key range entirely.
    const locks = [...sqlOnly.matchAll(/pg_advisory_xact_lock\((.+)\)/g)].map((match) => match[1]!.trim());
    expect(locks).toHaveLength(3);
    expect(locks.filter((arg) => arg.includes("PROVISIONING_DISPATCH_ADVISORY_LOCK_KEY"))).toHaveLength(1);
    expect(locks.filter((arg) => !arg.includes("PROVISIONING_DISPATCH_ADVISORY_LOCK_KEY")).every((arg) => arg === "hashtext(${input.appUserId})::bigint")).toBe(true);
  });

  it("the transaction isolation pin is unchanged: READ COMMITTED, no per-call override on the claim", () => {
    expect(neon).toContain('export const NEON_TRANSACTION_ISOLATION_LEVEL = "ReadCommitted" as const;');
    expect(claim).not.toMatch(/isolationLevel|Serializable|RepeatableRead/);
  });

  it("the pipeline answers a refusal with a plain return — no recursion, no store call, no new registration", () => {
    const onboarding = readFileSync("lib/real/server/onboarding.ts", "utf8");
    expect(onboarding).toContain('if (dispatched.kind === "capacity_reached") return { outcome: "capacity_reached", reason: REGISTRATION_CAPACITY_REACHED_REASON };');
    expect(onboarding).toContain('if (dispatched.kind === "attempt_budget_exhausted") return { outcome: "setup_exhausted", reason: REGISTRATION_SETUP_EXHAUSTED_REASON };');
    const dispatch = readFileSync("lib/real/server/provisioning-dispatch.ts", "utf8");
    const claimIndex = dispatch.indexOf("attempts.beginProvisioningDispatch(");
    const refusals = dispatch.indexOf('if (begun.outcome === "attempt_budget_exhausted")');
    const send = dispatch.indexOf("await submitCreateSubOrganization(");
    expect(claimIndex).toBeGreaterThan(0);
    expect(refusals).toBeGreaterThan(claimIndex);
    expect(send).toBeGreaterThan(refusals); // every refusal returns before the one place a create is sent
    expect(dispatch.match(/submitCreateSubOrganization\(/g)).toHaveLength(1);
  });

  it("this slice left the schema, the simulation engine, and the options route alone", () => {
    const options = readFileSync("app/api/real/account/register/options/route.ts", "utf8");
    expect(options).not.toMatch(/capacity|PROVISIONING_|registration_provisioning_dispatches/);
    expect(readFileSync("lib/real/server/schema.sql", "utf8")).not.toMatch(/5711486127619329878/);
  });
});
