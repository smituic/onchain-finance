// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, encodeAbiParameters, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { bytesToBase64Url, randomBytes } from "@/lib/real/bytes";
import { createInMemoryChallengeStore } from "@/lib/real/server/challenge-store";
import type { RealServerConfig } from "@/lib/real/server/config";
import { GENERIC_SERVER_ERROR_MESSAGE } from "@/lib/real/server/http";
import { beginLogin, completeLogin } from "@/lib/real/server/login";
import { createInMemoryLoginChallengeUseStore, type LoginChallengeUseStore } from "@/lib/real/server/login-challenge-uses";
import { createNeonDurableStores } from "@/lib/real/server/neon-store";
import { REGISTRATION_CAPACITY_REACHED_REASON, REGISTRATION_SETUP_EXHAUSTED_REASON, runProvisioningPipeline, type OnboardingOutcome } from "@/lib/real/server/onboarding";
import { runProvisioningDispatch } from "@/lib/real/server/provisioning-dispatch";
import { beginRegistration, completeRegistration } from "@/lib/real/server/registration";
import {
  PROVISIONING_ATTEMPT_DISPATCH_BUDGET,
  PROVISIONING_DAILY_WINDOW_MS,
  PROVISIONING_GLOBAL_DAILY_DISPATCH_LIMIT,
  PROVISIONING_GLOBAL_HOURLY_DISPATCH_LIMIT,
  PROVISIONING_HOURLY_WINDOW_MS,
  createInMemoryRegistrationAttemptStore,
  type RegistrationAttempt,
  type RegistrationAttemptStore,
} from "@/lib/real/server/registration-attempts";
import { createInMemoryRealAccountRegistry } from "@/lib/real/server/registry";
import { createHash } from "node:crypto";
import { claimed, failedObservation } from "./fixtures/provisioning-seed";
import { FakeParentTurnkey } from "./fixtures/turnkey-parent-fake";
import { buildAuthenticationResponseJSON, buildRegistrationResponseJSON, createFixtureAuthenticator } from "./fixtures/webauthn";

/**
 * Milestone 3C-3a: the ADVISORY, read-only provisioning refusal pre-check (peekProvisioningDispatchRefusal), run once at the start of
 * runProvisioningDispatch. OFFLINE ONLY — the in-memory store with an injected clock, the fake parent Turnkey, mocked route
 * dependencies, the real Neon driver with fetch intercepted (nothing leaves the process), and static checks of the statement text. Nothing
 * here proves PostgreSQL snapshot or locking behavior; that needs a separately authorized disposable-branch run. The pre-check can only
 * REFUSE; the locked claim remains the sole authority for admission.
 */
const HOUR = PROVISIONING_HOURLY_WINDOW_MS;
const DAY = PROVISIONING_DAILY_WINDOW_MS;
const T0 = Date.parse("2026-10-22T00:00:00.000Z");
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const ORIGIN = "http://localhost:3000";

const config: RealServerConfig = {
  turnkeyApiBaseUrl: "https://api.turnkey.com",
  turnkeyParentOrganizationId: "parent-org",
  turnkeyApiPublicKey: "pub",
  turnkeyApiPrivateKey: "priv",
  sessionSecret: "test-secret",
  rpId: "localhost",
  rpName: "Test",
  expectedOrigins: [ORIGIN],
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
function ledger(start = T0) {
  const clock = { t: start };
  const store = createInMemoryRegistrationAttemptStore({ now: () => clock.t });
  const verified = async () => {
    seq += 1;
    return store.createVerified({
      credentialId: bytesToBase64Url(randomBytes(16)),
      appUserId: `5c7d2e3f-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      userHandle: `precheck-handle-${seq}`,
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
    const body = `precheck-body-${seq}`;
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
  /** A claimed dispatch taken through a proven definitive failure, back to 'verified'. */
  const failDefinitively = async (credentialId: string) => {
    const { dispatch } = claimed(await claim(credentialId));
    const activityId = `activity-${dispatch.id}`;
    await store.recordDispatchActivity({ dispatchId: dispatch.id, activityId, fingerprint: null });
    await store.recordDispatchTerminal({ dispatchId: dispatch.id, activityId, observation: failedObservation() });
    expect(await store.revertProvisioningAfterDefinitiveFailure({ credentialId, dispatchId: dispatch.id, activityId })).toMatchObject({ state: "verified" });
  };
  const peek = (credentialId: string) => store.peekProvisioningDispatchRefusal({ credentialId });
  return { clock, store, verified, claim, fill, failDefinitively, peek };
}

const PROCEED = { outcome: "proceed" } as const;
const BUDGET = { outcome: "attempt_budget_exhausted" } as const;
const CAPACITY_PEEK = { outcome: "global_capacity_reached" } as const;

describe("A–E, G, W: the in-memory pre-check decides like the claim, writes nothing, and uses its injected clock", () => {
  it("A: an attempt whose consistent ledger already holds its full budget of dispatches -> attempt_budget_exhausted", async () => {
    const w = ledger();
    const attempt = await w.verified();
    expect(await w.peek(attempt.credentialId)).toEqual(PROCEED);
    await w.failDefinitively(attempt.credentialId);
    expect(await w.peek(attempt.credentialId)).toEqual(PROCEED); // one of two used
    await w.failDefinitively(attempt.credentialId);
    expect(PROVISIONING_ATTEMPT_DISPATCH_BUDGET).toBe(2);
    expect(await w.peek(attempt.credentialId)).toEqual(BUDGET);
    expect(await w.claim(attempt.credentialId)).toEqual({ outcome: "attempt_budget_exhausted" }); // the claim agrees
  });

  it("A: the attempt's own budget outranks a full global ceiling (the permanent truth is told first), exactly as in the claim", async () => {
    const w = ledger();
    const attempt = await w.verified();
    await w.failDefinitively(attempt.credentialId);
    await w.failDefinitively(attempt.credentialId);
    await w.fill(3); // with the attempt's own two, five in the hour
    expect(await w.peek(attempt.credentialId)).toEqual(BUDGET);
    expect(await w.claim(attempt.credentialId)).toEqual({ outcome: "attempt_budget_exhausted" });
  });

  it("B: five dispatches in the rolling hour -> global_capacity_reached; four -> proceed", async () => {
    const w = ledger();
    await w.fill(4);
    const attempt = await w.verified();
    expect(await w.peek(attempt.credentialId)).toEqual(PROCEED);
    await w.fill(1);
    expect(PROVISIONING_GLOBAL_HOURLY_DISPATCH_LIMIT).toBe(5);
    expect(await w.peek(attempt.credentialId)).toEqual(CAPACITY_PEEK);
  });

  it("C: twenty dispatches in the rolling 24 hours (hourly clear) -> global_capacity_reached; nineteen -> proceed", async () => {
    const w = ledger();
    const spread = async (count: number) => {
      for (let i = 0; i < count; i += 1) {
        w.clock.t = T0 + Math.floor(i / 5) * 61 * 60_000; // never more than five in any hour
        await w.fill(1);
      }
    };
    await spread(19);
    w.clock.t = T0 + 6 * HOUR;
    const attempt = await w.verified();
    expect(await w.peek(attempt.credentialId)).toEqual(PROCEED);
    w.clock.t = T0 + 4 * 61 * 60_000; // the batch window of the last five
    await w.fill(1);
    w.clock.t = T0 + 6 * HOUR;
    expect(PROVISIONING_GLOBAL_DAILY_DISPATCH_LIMIT).toBe(20);
    expect(await w.peek(attempt.credentialId)).toEqual(CAPACITY_PEEK);
  });

  it("D: the hourly window is strict `>` — one millisecond short of an hour still counts, exactly one hour old does not (±1 ms)", async () => {
    const w = ledger();
    await w.fill(5);
    const attempt = await w.verified();
    for (const [offset, expected] of [
      [HOUR - 1, CAPACITY_PEEK],
      [HOUR, PROCEED],
      [HOUR + 1, PROCEED],
    ] as const) {
      w.clock.t = T0 + offset;
      expect(await w.peek(attempt.credentialId), `+${offset} ms`).toEqual(expected);
    }
  });

  it("D: the daily window is strict `>` too (±1 ms), independent of the hourly one", async () => {
    const w = ledger();
    for (let i = 0; i < 20; i += 1) {
      w.clock.t = T0 + Math.floor(i / 5) * 61 * 60_000;
      await w.fill(1);
    }
    const attempt = await w.verified();
    const oldest = T0; // the first batch of five is the oldest
    for (const [offset, expected] of [
      [DAY - 1, CAPACITY_PEEK],
      [DAY, PROCEED], // the oldest five are exactly a day old; fifteen remain
    ] as const) {
      w.clock.t = oldest + offset;
      expect(await w.peek(attempt.credentialId), `+${offset} ms`).toEqual(expected);
    }
  });

  it("E: rows dated in the future (a clock that stepped back) still count — never extra capacity — for both windows, like the claim", async () => {
    const w = ledger();
    w.clock.t = T0 + 3 * HOUR;
    await w.fill(5);
    w.clock.t = T0;
    const attempt = await w.verified();
    expect(await w.peek(attempt.credentialId)).toEqual(CAPACITY_PEEK);
    expect(await w.claim(attempt.credentialId)).toEqual({ outcome: "global_capacity_reached" });
  });

  it("every dispatch row counts whatever its terminal status (open, uncertain, completed, failed): none is refunded", async () => {
    const w = ledger();
    const open = await w.verified();
    claimed(await w.claim(open.credentialId)); // open, no activity id
    await w.fill(2);
    const failed = await w.verified();
    await w.failDefinitively(failed.credentialId); // terminal FAILED, reverted to verified
    const waiting = await w.verified();
    expect(await w.peek(waiting.credentialId)).toEqual(PROCEED); // 4 so far
    await w.fill(1);
    expect(await w.peek(waiting.credentialId)).toEqual(CAPACITY_PEEK);
  });

  it("G: a missing attempt, and an attempt that is not 'verified' -> proceed, leaving the claim to report claim_lost", async () => {
    const w = ledger();
    await w.fill(5); // even with a full ceiling: a lost claim is the claim's to report
    expect(await w.peek("no-such-credential")).toEqual(PROCEED);
    const lost = await w.verified();
    w.clock.t = T0 + HOUR; // capacity returns; claim it
    claimed(await w.claim(lost.credentialId));
    expect((await w.store.findByCredentialId(lost.credentialId))?.state).toBe("provisioning_in_flight");
    expect(await w.peek(lost.credentialId)).toEqual(PROCEED);
    expect(await w.claim(lost.credentialId)).toEqual({ outcome: "claim_lost" });
    expect(await w.claim("no-such-credential")).toEqual({ outcome: "claim_lost" });
  });

  it("W: it writes NOTHING — the attempt, every ledger row and the clock reading are untouched, however often it is called", async () => {
    const w = ledger();
    await w.fill(5);
    const attempt = await w.verified();
    const before = { attempt: await w.store.findByCredentialId(attempt.credentialId), rows: await w.store.findDispatchesByCredentialId(attempt.credentialId), all: await Promise.all([attempt].map((a) => w.store.findDispatchesByCredentialId(a.credentialId))) };
    for (let i = 0; i < 5; i += 1) await w.peek(attempt.credentialId);
    expect(await w.store.findByCredentialId(attempt.credentialId)).toEqual(before.attempt);
    expect(await w.store.findDispatchesByCredentialId(attempt.credentialId)).toEqual(before.rows);
    expect(await w.claim(attempt.credentialId)).toEqual({ outcome: "global_capacity_reached" }); // and a refusal after peeks wrote nothing either
  });

  it("W/T: PROPERTY — over a long deterministic sequence of clock steps (±1 ms at both windows), the pre-check refuses exactly when the claim refuses, and 'proceed' is never an admission", async () => {
    const w = ledger();
    const steps = [0, 1, 59 * 60_000, HOUR - 1, 1, HOUR, 1, 11 * HOUR, DAY - 1, 1, 0, 0, 7 * 60_000, HOUR + 1, 0, DAY];
    let sawAdmit = 0;
    let sawCapacity = 0;
    let sawBudget = 0;
    for (let round = 0; round < 80; round += 1) {
      w.clock.t += steps[round % steps.length]!;
      const attempt = await w.verified();
      if (round % 7 === 3) {
        // Spend this attempt's budget with two proven definitive failures — each only while the claim itself would admit.
        for (let cycle = 0; cycle < PROVISIONING_ATTEMPT_DISPATCH_BUDGET; cycle += 1) {
          const first = await w.claim(attempt.credentialId);
          if (first.outcome !== "claimed") break;
          const activityId = `activity-${first.dispatch.id}`;
          await w.store.recordDispatchActivity({ dispatchId: first.dispatch.id, activityId, fingerprint: null });
          await w.store.recordDispatchTerminal({ dispatchId: first.dispatch.id, activityId, observation: failedObservation() });
          await w.store.revertProvisioningAfterDefinitiveFailure({ credentialId: attempt.credentialId, dispatchId: first.dispatch.id, activityId });
        }
      }
      const peeked = await w.peek(attempt.credentialId);
      const claim = await w.claim(attempt.credentialId);
      if (claim.outcome === "attempt_budget_exhausted" || claim.outcome === "global_capacity_reached") {
        expect(peeked, `round ${round}`).toEqual({ outcome: claim.outcome });
        if (claim.outcome === "global_capacity_reached") sawCapacity += 1;
        else sawBudget += 1;
      } else {
        // claimed, or claim_lost: the pre-check did not refuse (it granted nothing — the claim decided).
        expect(peeked, `round ${round}`).toEqual(PROCEED);
        if (claim.outcome === "claimed") sawAdmit += 1;
      }
    }
    // The sequence really exercised every branch.
    expect(sawAdmit).toBeGreaterThan(2);
    expect(sawCapacity).toBeGreaterThan(2);
    expect(sawBudget).toBeGreaterThan(0);
  });

  it("W: the in-memory store reads its INJECTED clock (not the wall clock) for the pre-check", async () => {
    const w = ledger(Date.parse("2001-01-01T00:00:00.000Z")); // far from 'now'
    await w.fill(5);
    const attempt = await w.verified();
    expect(await w.peek(attempt.credentialId)).toEqual(CAPACITY_PEEK);
    w.clock.t += HOUR;
    expect(await w.peek(attempt.credentialId)).toEqual(PROCEED);
  });
});

/** The pipeline over an in-memory ledger and the fake parent Turnkey. */
function pipelineWorld() {
  const w = ledger();
  const registry = createInMemoryRealAccountRegistry();
  const turnkey = new FakeParentTurnkey();
  const run = (attempt: RegistrationAttempt, attempts: RegistrationAttemptStore = w.store) => runProvisioningPipeline({ config, registry, attempts, attempt, publicClient: buildPublicClient(), provisioningDeps: turnkey.deps() });
  const current = async (credentialId: string) => (await w.store.findByCredentialId(credentialId))!;
  return { ...w, registry, turnkey, run, current };
}
const CAPACITY: OnboardingOutcome = { outcome: "capacity_reached", reason: REGISTRATION_CAPACITY_REACHED_REASON };
const EXHAUSTED: OnboardingOutcome = { outcome: "setup_exhausted", reason: REGISTRATION_SETUP_EXHAUSTED_REASON };

describe("H–L, R, V: the dispatch asks first, refuses early, fails closed, and never lets 'proceed' admit", () => {
  it("R/V: an early refusal returns the existing outcome with NO claim, NO request body (the clock is never read), NO provider call and NO durable write", async () => {
    const w = pipelineWorld();
    await w.fill(5);
    const attempt = await w.verified();
    const events: string[] = [];
    const store: RegistrationAttemptStore = {
      ...w.store,
      peekProvisioningDispatchRefusal: async (input) => (events.push("peek"), w.store.peekProvisioningDispatchRefusal(input)),
      beginProvisioningDispatch: async (input) => (events.push("begin"), w.store.beginProvisioningDispatch(input)),
    };
    const deps = w.turnkey.deps({ now: () => (events.push("now"), w.clock.t) });
    expect(await runProvisioningDispatch({ config, attempts: store, attempt, deps })).toEqual({ kind: "capacity_reached" });
    expect(events).toEqual(["peek"]);
    expect(w.turnkey.requests).toHaveLength(0);
    expect(await w.current(attempt.credentialId)).toEqual(attempt);
    expect(await w.store.findDispatchesByCredentialId(attempt.credentialId)).toEqual([]);

    // The permanent refusal maps to its own existing outcome the same way.
    const spent = await w.verified();
    w.clock.t = T0 + HOUR;
    await w.failDefinitively(spent.credentialId);
    await w.failDefinitively(spent.credentialId);
    events.length = 0;
    const exhausted = (await w.store.findByCredentialId(spent.credentialId))!;
    expect(await runProvisioningDispatch({ config, attempts: store, attempt: exhausted, deps })).toEqual({ kind: "attempt_budget_exhausted" });
    expect(events).toEqual(["peek"]);
  });

  it("V: when the pre-check does not refuse, the order is pre-check -> request body (clock) -> claim, and the claim is what admits", async () => {
    const w = pipelineWorld();
    const attempt = await w.verified();
    const events: string[] = [];
    const store: RegistrationAttemptStore = {
      ...w.store,
      peekProvisioningDispatchRefusal: async (input) => (events.push("peek"), w.store.peekProvisioningDispatchRefusal(input)),
      beginProvisioningDispatch: async (input) => (events.push("begin"), w.store.beginProvisioningDispatch(input)),
    };
    const outcome = await runProvisioningDispatch({ config, attempts: store, attempt, deps: w.turnkey.deps({ now: () => (events.push("now"), w.clock.t) }) });
    expect(outcome.kind).toBe("created");
    expect(events.slice(0, 3)).toEqual(["peek", "now", "begin"]);
    expect(events.filter((event) => event === "peek")).toHaveLength(1);
    expect(events.filter((event) => event === "begin")).toHaveLength(1);
    expect(w.turnkey.createRequests).toHaveLength(1);
    expect((await w.store.findDispatchesByCredentialId(attempt.credentialId)).map((row) => row.dispatchSeq)).toEqual([1]);
  });

  it("J: 'proceed' admits nothing by itself — with a pre-check that always says proceed, the claim still refuses a full ceiling, a spent budget, and a lost claim", async () => {
    const w = pipelineWorld();
    await w.fill(5);
    const alwaysProceed: RegistrationAttemptStore = { ...w.store, peekProvisioningDispatchRefusal: async () => PROCEED };
    const full = await w.verified();
    expect(await runProvisioningDispatch({ config, attempts: alwaysProceed, attempt: full, deps: w.turnkey.deps() })).toEqual({ kind: "capacity_reached" });
    w.clock.t = T0 + HOUR;
    const spent = await w.verified();
    await w.failDefinitively(spent.credentialId);
    await w.failDefinitively(spent.credentialId);
    expect(await runProvisioningDispatch({ config, attempts: alwaysProceed, attempt: (await w.store.findByCredentialId(spent.credentialId))!, deps: w.turnkey.deps() })).toEqual({ kind: "attempt_budget_exhausted" });
    const taken = await w.verified();
    claimed(await w.claim(taken.credentialId));
    expect(await runProvisioningDispatch({ config, attempts: alwaysProceed, attempt: taken, deps: w.turnkey.deps() })).toEqual({ kind: "claim_lost" });
    expect(w.turnkey.requests).toHaveLength(0);
  });

  it("K: a commit between the pre-check and the claim is decided by the CLAIM — the stale 'proceed' is refused, no provider call, no state change", async () => {
    const w = pipelineWorld();
    await w.fill(4);
    const attempt = await w.verified();
    const racing: RegistrationAttemptStore = {
      ...w.store,
      async peekProvisioningDispatchRefusal(input) {
        const seen = await w.store.peekProvisioningDispatchRefusal(input); // proceed: four dispatches so far
        await w.fill(1); // ...and another request commits the fifth before our claim runs
        return seen;
      },
    };
    expect(await w.run(attempt, racing)).toEqual(CAPACITY);
    expect(w.turnkey.requests).toHaveLength(0);
    expect(await w.current(attempt.credentialId)).toEqual(attempt);
    expect(await w.store.findDispatchesByCredentialId(attempt.credentialId)).toEqual([]);
  });

  it("K: the opposite stale answer — the pre-check refuses at T1 although the claim would have admitted at T2 (a dispatch aged out) — is the documented advisory early denial: nothing changes, and the attempt is resumable", async () => {
    const w = pipelineWorld();
    await w.fill(5);
    const attempt = await w.verified();
    const peeks: string[] = [];
    const store: RegistrationAttemptStore = {
      ...w.store,
      peekProvisioningDispatchRefusal: async (input) => {
        const seen = await w.store.peekProvisioningDispatchRefusal(input);
        peeks.push(seen.outcome);
        return seen;
      },
    };
    expect(await w.run(attempt, store)).toEqual(CAPACITY); // refused at T1
    expect(peeks).toEqual(["global_capacity_reached"]);
    w.clock.t = T0 + HOUR; // T2: the window rolled; the claim would now admit
    expect(await w.current(attempt.credentialId)).toEqual(attempt); // untouched, still verified
    expect((await w.run(await w.current(attempt.credentialId), store)).outcome).toBe("verified");
    expect(peeks).toEqual(["global_capacity_reached", "proceed"]);
    expect(w.turnkey.createRequests).toHaveLength(1);
  });

  it("L: a capacity-refused attempt resumes with the SAME attempt when capacity returns — two pre-checks, one claim, one create, no new registration", async () => {
    const w = pipelineWorld();
    await w.fill(5);
    const attempt = await w.verified();
    const peek = vi.fn(w.store.peekProvisioningDispatchRefusal);
    const begin = vi.fn(w.store.beginProvisioningDispatch);
    const store = { ...w.store, peekProvisioningDispatchRefusal: peek, beginProvisioningDispatch: begin };
    expect(await w.run(attempt, store)).toEqual(CAPACITY);
    expect(await w.run(await w.current(attempt.credentialId), store)).toEqual(CAPACITY);
    w.clock.t = T0 + HOUR;
    expect((await w.run(await w.current(attempt.credentialId), store)).outcome).toBe("verified");
    expect(peek).toHaveBeenCalledTimes(3);
    expect(begin).toHaveBeenCalledTimes(1); // refusals never reached the claim; the admitted run did, once
    expect(w.turnkey.createRequests).toHaveLength(1);
    expect((await w.store.findDispatchesByCredentialId(attempt.credentialId)).map((row) => row.dispatchSeq)).toEqual([1]);
  });

  it("H: a pre-check read FAILURE is thrown out of the pipeline — no claim, no request body, no provider call, nothing changed, and no 'proceed' after the failure", async () => {
    const w = pipelineWorld();
    const attempt = await w.verified();
    const begin = vi.fn(w.store.beginProvisioningDispatch);
    const now = vi.fn(() => w.clock.t);
    const failing: RegistrationAttemptStore = { ...w.store, beginProvisioningDispatch: begin, peekProvisioningDispatchRefusal: async () => Promise.reject(new Error("connection terminated")) };
    await expect(runProvisioningPipeline({ config, registry: w.registry, attempts: failing, attempt, publicClient: buildPublicClient(), provisioningDeps: w.turnkey.deps({ now }) })).rejects.toThrow("connection terminated");
    expect(begin).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(w.turnkey.requests).toHaveLength(0);
    expect(await w.current(attempt.credentialId)).toEqual(attempt);
    expect(await w.store.findDispatchesByCredentialId(attempt.credentialId)).toEqual([]);
    expect((await w.run(attempt)).outcome).toBe("verified"); // nothing was spent: the same attempt still works
  });

  it.each([
    ["an unknown outcome", { outcome: "admit" }],
    ["the claim's own admission shape", { outcome: "claimed" }],
    ["a missing outcome", {}],
    ["null", null],
    ["undefined", undefined],
    ["a string", "proceed"],
  ])("I: %s from the pre-check fails closed — thrown, no claim, no provider call", async (_label, answer) => {
    const w = pipelineWorld();
    const attempt = await w.verified();
    const begin = vi.fn(w.store.beginProvisioningDispatch);
    const odd = { ...w.store, beginProvisioningDispatch: begin, peekProvisioningDispatchRefusal: async () => answer as never } satisfies RegistrationAttemptStore;
    await expect(runProvisioningDispatch({ config, attempts: odd, attempt, deps: w.turnkey.deps() })).rejects.toThrow();
    expect(begin).not.toHaveBeenCalled();
    expect(w.turnkey.requests).toHaveLength(0);
    expect(await w.current(attempt.credentialId)).toEqual(attempt);
  });

  it("F: an inconsistent ledger is NOT hidden behind a refusal — the pre-check proceeds and the claim's error surfaces (no admission, no provider call)", async () => {
    const w = pipelineWorld();
    await w.fill(5); // a full ceiling that a naive pre-check would answer first
    const attempt = await w.verified();
    const inconsistent: RegistrationAttemptStore = {
      ...w.store,
      peekProvisioningDispatchRefusal: async () => PROCEED, // what the pre-check says for an inconsistent ledger
      async beginProvisioningDispatch() {
        throw new Error("Provisioning dispatch ledger is inconsistent for this attempt.");
      },
    };
    await expect(runProvisioningDispatch({ config, attempts: inconsistent, attempt, deps: w.turnkey.deps() })).rejects.toThrow(/ledger is inconsistent/);
    expect(w.turnkey.requests).toHaveLength(0);
  });

  it("Q: definitive failures and uncertain states keep their handling; only a 'verified' attempt ever reaches the pre-check", async () => {
    const w = pipelineWorld();
    const peek = vi.fn(w.store.peekProvisioningDispatchRefusal);
    const store = { ...w.store, peekProvisioningDispatchRefusal: peek };
    // A definitive failure -> a retryable answer; the second -> exhausted; a third run sends nothing.
    const attempt = await w.verified();
    w.turnkey.submitQueue.push("failed", "rejected");
    expect(await w.run(attempt, store)).toEqual({ outcome: "pending", reason: "Account setup failed and can be retried. Try again in a moment." });
    expect(await w.run(await w.current(attempt.credentialId), store)).toEqual(EXHAUSTED);
    expect(w.turnkey.createRequests).toHaveLength(2);
    const asked = peek.mock.calls.length;
    expect(await w.run(await w.current(attempt.credentialId), store)).toEqual(EXHAUSTED);
    expect(w.turnkey.createRequests).toHaveLength(2);
    expect(peek.mock.calls.length).toBe(asked + 1); // exhausted-by-the-pre-check, no claim, no provider
    // An uncertain create (a lost response) stays in review and its attempt is never asked about again.
    const uncertain = await w.verified();
    w.turnkey.submitMode = "lose_response_after_apply";
    const outcome = await w.run(uncertain, store);
    expect(outcome.outcome).toBe("pending");
    expect(await w.current(uncertain.credentialId)).toMatchObject({ state: "provisioning_in_flight", externalOutcome: "unknown" });
    const beforeReview = peek.mock.calls.length;
    w.turnkey.submitMode = "completed";
    for (let i = 0; i < 3; i += 1) expect((await w.run(await w.current(uncertain.credentialId), store)).outcome).toBe("pending");
    expect(peek.mock.calls.length).toBe(beforeReview); // an in-flight attempt never reaches the pre-check
    // Blocked / active / in-flight views never reach it either.
    const other = await w.verified();
    for (const view of [{ ...other, state: "blocked" as const, blockReason: "manual" }, { ...other, state: "active" as const }, { ...other, state: "provisioning_in_flight" as const }]) await w.run(view, store);
    expect(peek.mock.calls.length).toBe(beforeReview);
  });
});

describe("M, N, O, P: registration and sign-in keep their responses and their ordering", () => {
  async function register(w: ReturnType<typeof pipelineWorld>, store: RegistrationAttemptStore = w.store) {
    const challengeStore = createInMemoryChallengeStore();
    const events: string[] = [];
    const baseUses = createInMemoryLoginChallengeUseStore();
    const loginChallengeUses: LoginChallengeUseStore = { consume: async (input) => (events.push("consume"), baseUses.consume(input)) };
    const authenticator = createFixtureAuthenticator();
    const { optionsJSON } = await beginRegistration({ config, challengeStore });
    const result = await completeRegistration({ config, challengeStore, registry: w.registry, attempts: store, publicClient: buildPublicClient(), provisioningDeps: w.turnkey.deps(), response: buildRegistrationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId }) });
    const credentialId = authenticator.credentialIdBase64Url;
    const login = async (attempts: RegistrationAttemptStore = store) => {
      const { optionsJSON: loginOptions } = await beginLogin({ config });
      const userHandle = (await w.store.findByCredentialId(credentialId))!.userHandle;
      return completeLogin({ config, loginChallengeUses, registry: w.registry, attempts, publicClient: buildPublicClient(), provisioningDeps: w.turnkey.deps(), response: buildAuthenticationResponseJSON({ authenticator, challenge: loginOptions.challenge, origin: ORIGIN, rpId: config.rpId, userHandle }) });
    };
    return { result, credentialId, login, events };
  }

  it("M: registration while the ceiling is full — the same 'not right now' answer as before, the passkey's attempt saved 'verified', nothing sent", async () => {
    const w = pipelineWorld();
    await w.fill(5);
    const r = await register(w);
    expect(r.result).toEqual(CAPACITY);
    expect(await w.store.findByCredentialId(r.credentialId)).toMatchObject({ state: "verified", externalOutcome: "not_attempted", externalProvisioningAttemptedAt: null });
    expect(await w.store.findDispatchesByCredentialId(r.credentialId)).toEqual([]);
    expect(w.turnkey.requests).toHaveLength(0);
  });

  it("M: registration with room is unchanged — one pre-check, one claim, one create, an active account", async () => {
    const w = pipelineWorld();
    const peek = vi.fn(w.store.peekProvisioningDispatchRefusal);
    const begin = vi.fn(w.store.beginProvisioningDispatch);
    const r = await register(w, { ...w.store, peekProvisioningDispatchRefusal: peek, beginProvisioningDispatch: begin });
    expect(r.result.outcome).toBe("verified");
    expect(peek).toHaveBeenCalledTimes(1);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(w.turnkey.createRequests).toHaveLength(1);
    expect(await w.store.findByCredentialId(r.credentialId)).toMatchObject({ state: "active" });
  });

  it("N/O: pending-registration sign-in — the same refusal answers; the challenge is consumed FIRST, then the counter, THEN the pre-check; nothing is sent", async () => {
    const w = pipelineWorld();
    await w.fill(5);
    const r = await register(w);
    const events: string[] = [];
    const watched: RegistrationAttemptStore = {
      ...w.store,
      updateCounter: async (input) => (events.push("updateCounter"), w.store.updateCounter(input)),
      peekProvisioningDispatchRefusal: async (input) => (events.push("peek"), w.store.peekProvisioningDispatchRefusal(input)),
      beginProvisioningDispatch: async (input) => (events.push("begin"), w.store.beginProvisioningDispatch(input)),
    };
    r.events.length = 0;
    const answer = await r.login(watched);
    expect(answer).toEqual(CAPACITY);
    expect(r.events).toEqual(["consume"]);
    expect(events).toEqual(["updateCounter", "peek"]); // consume (above) precedes both; the counter precedes the pre-check; the claim is never reached
    expect(w.turnkey.requests).toHaveLength(0);
    expect(await w.store.findByCredentialId(r.credentialId)).toMatchObject({ state: "verified", externalOutcome: "not_attempted" });
  });

  it("N: a replayed login assertion is still refused by the one-time challenge, before any counter or pre-check", async () => {
    const w = pipelineWorld();
    await w.fill(5);
    const challengeStore = createInMemoryChallengeStore();
    const authenticator = createFixtureAuthenticator();
    const { optionsJSON } = await beginRegistration({ config, challengeStore });
    await completeRegistration({ config, challengeStore, registry: w.registry, attempts: w.store, publicClient: buildPublicClient(), provisioningDeps: w.turnkey.deps(), response: buildRegistrationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId }) });
    const uses = createInMemoryLoginChallengeUseStore();
    const { optionsJSON: login } = await beginLogin({ config });
    const userHandle = (await w.store.findByCredentialId(authenticator.credentialIdBase64Url))!.userHandle;
    const response = buildAuthenticationResponseJSON({ authenticator, challenge: login.challenge, origin: ORIGIN, rpId: config.rpId, userHandle });
    const peek = vi.fn(w.store.peekProvisioningDispatchRefusal);
    const store = { ...w.store, peekProvisioningDispatchRefusal: peek };
    const input = { config, loginChallengeUses: uses, registry: w.registry, attempts: store, publicClient: buildPublicClient(), provisioningDeps: w.turnkey.deps(), response };
    expect(await completeLogin(input)).toEqual(CAPACITY);
    expect(peek).toHaveBeenCalledTimes(1);
    const replay = await completeLogin(input);
    expect(replay.outcome).toBe("rejected");
    expect(peek).toHaveBeenCalledTimes(1); // the replay never reached the pre-check
  });

  it("P: an ACTIVE-passkey sign-in never reaches the provisioning pre-check", async () => {
    const w = pipelineWorld();
    const peek = vi.fn(w.store.peekProvisioningDispatchRefusal);
    const store = { ...w.store, peekProvisioningDispatchRefusal: peek };
    const r = await register(w, store);
    expect(r.result.outcome).toBe("verified");
    expect(peek).toHaveBeenCalledTimes(1); // registration's own, before its create
    const result = await r.login(store);
    expect(result.outcome).toBe("verified");
    expect(peek).toHaveBeenCalledTimes(1); // the active sign-in asked nothing
  });
});

describe("the verify routes keep their mapping: capacity 503, exhausted 409, a pre-check failure the generic 500", () => {
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
    vi.doMock("@/lib/real/server/runtime", () => ({ getRealAccountRegistry: () => ({}), getChallengeStore: () => ({}), getRegistrationAttemptStore: () => ({}), getAccountHandleStore: () => ({}), getLoginChallengeUses: () => ({}) }));
    vi.doMock("@/lib/real/server/registration", () => ({ completeRegistration: complete }));
    vi.doMock("@/lib/real/server/login", () => ({ completeLogin: complete }));
    const post = (url: string) => new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response: { id: "x" } }) });
    const register = await import("@/app/api/real/account/register/verify/route");
    const login = await import("@/app/api/real/account/login/verify/route");
    return { cookiesSet, routes: [["register", () => register.POST(post("/api/real/account/register/verify"))], ["login", () => login.POST(post("/api/real/account/login/verify"))]] as const };
  }

  it("M/N: capacity -> 503 with the unchanged message and code, no Retry-After; exhausted -> 409 with the unchanged code, no Retry-After", async () => {
    for (const [outcome, status, code] of [[CAPACITY, 503, "registration_capacity_reached"], [EXHAUSTED, 409, "registration_setup_exhausted"]] as const) {
      const loaded = await load(outcome);
      for (const [name, call] of loaded.routes) {
        const response = await call();
        expect(response.status, name).toBe(status);
        expect(await response.json(), name).toEqual({ error: (outcome as { reason: string }).reason, code });
        expect(response.headers.get("Retry-After"), name).toBeNull();
      }
      expect(loaded.cookiesSet).toEqual([]);
    }
  });

  it("H: a pre-check failure (any database error out of the pipeline) is the generic 500 — never the capacity message, never a capacity code, no cookie", async () => {
    const loaded = await load(new Error("connection terminated"));
    for (const [name, call] of loaded.routes) {
      const response = await call();
      expect(response.status, name).toBe(500);
      expect(await response.json(), name).toEqual({ error: GENERIC_SERVER_ERROR_MESSAGE });
    }
    expect(loaded.cookiesSet).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------- the Neon statement

const DATABASE_URL = "postgresql://user:pass@ep-precheck-test-000000.us-east-2.aws.neon.tech/neondb";
const CREDENTIAL_ID = "Y3JlZGVudGlhbC1pZA";
type Sent = { queries: Array<{ query: string; params: unknown[] }> | null; single: { query: string; params: unknown[] } | null; isolation: string | null };
let sent: Sent[] = [];
let respond: (request: Sent) => Response;

beforeEach(() => {
  sent = [];
  vi.stubGlobal("fetch", async (_url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as { queries?: Sent["queries"]; query?: string; params?: unknown[] };
    const request: Sent = { queries: body.queries ?? null, single: body.query ? { query: body.query, params: body.params ?? [] } : null, isolation: new Headers(init?.headers).get("Neon-Batch-Isolation-Level") };
    sent.push(request);
    return respond(request);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function result(rows: Array<Record<string, unknown>>) {
  const names = Object.keys(rows[0] ?? {});
  return { fields: names.map((name) => ({ name, dataTypeID: 25 })), rows: rows.map((row) => names.map((name) => (row[name] === null ? null : String(row[name])))) };
}
const decisionAnswer = (decision: string | null) => Response.json(result([{ decision }]));
const neonStore = () => createNeonDurableStores(DATABASE_URL).attempts;
const peekNeon = () => neonStore().peekProvisioningDispatchRefusal({ credentialId: CREDENTIAL_ID });
const flat = (query: string) => query.replace(/\s+/g, " ").trim();

describe("S–U: the Neon pre-check is ONE read-only autocommit SELECT that mirrors the claim's ledger and CASE", () => {
  it("sends exactly ONE single statement — not a batch, no transaction wrapper, no per-call isolation override — and nothing else", async () => {
    respond = () => decisionAnswer("admit");
    expect(await peekNeon()).toEqual(PROCEED);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.queries).toBeNull();
    expect(sent[0]!.single).not.toBeNull();
    expect(sent[0]!.isolation).toBeNull();
  });

  it("S: the statement contains no write, no row lock, no advisory lock, no explicit locking, and one database-clock reading", async () => {
    respond = () => decisionAnswer("admit");
    await peekNeon();
    const text = flat(sent[0]!.single!.query);
    expect(text).toMatch(/^WITH admission AS MATERIALIZED \( SELECT pg_catalog\.clock_timestamp\(\) AS at \), ledger AS MATERIALIZED \(/);
    expect(text).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|COPY|CREATE|ALTER|DROP|GRANT|LOCK)\b/i);
    expect(text).not.toMatch(/FOR\s+(UPDATE|NO KEY UPDATE|SHARE|KEY SHARE)|SKIP LOCKED|NOWAIT/i);
    expect(text).not.toMatch(/advisory|pg_advisory|set_config|SET\s+LOCAL|BEGIN|COMMIT/i);
    expect(text.match(/clock_timestamp\(\)/g)).toHaveLength(1);
    expect(text).not.toMatch(/\bnow\(\)|statement_timestamp|transaction_timestamp/);
    expect(text).toMatch(/^WITH [\s\S]*SELECT CASE .* END AS decision FROM ledger l$/);
    // Bound parameters only: the credential three times, then the three M1 constants.
    expect(sent[0]!.single!.params).toEqual([CREDENTIAL_ID, CREDENTIAL_ID, CREDENTIAL_ID, String(PROVISIONING_ATTEMPT_DISPATCH_BUDGET), String(PROVISIONING_GLOBAL_HOURLY_DISPATCH_LIMIT), String(PROVISIONING_GLOBAL_DAILY_DISPATCH_LIMIT)]); // the driver sends numbers as text; the statement casts them ::int
    expect([PROVISIONING_ATTEMPT_DISPATCH_BUDGET, PROVISIONING_GLOBAL_HOURLY_DISPATCH_LIMIT, PROVISIONING_GLOBAL_DAILY_DISPATCH_LIMIT]).toEqual([2, 5, 20]);
  });

  it("T: its ledger CTE and CASE are byte-for-byte the claim's (same windows, strict `>`, every row, MAX/COUNT consistency, precedence, parameter numbers)", async () => {
    respond = (request) => (request.queries ? Response.json({ results: [] }) : decisionAnswer("admit"));
    await peekNeon();
    const peekText = flat(sent[0]!.single!.query);
    // The claim's statement as it goes over the wire (a batch: its third statement).
    respond = () => Response.json({ results: [result([{ credential_id: CREDENTIAL_ID }]), result([{ pg_advisory_xact_lock: "" }]), { fields: [{ name: "decision", dataTypeID: 25 }], rows: [["claim_lost"]] }, result([{ id: "x" }])] });
    await neonStore().beginProvisioningDispatch({ credentialId: CREDENTIAL_ID, attemptedAt: "2026-10-22T00:00:00.000Z", evidence: { evidenceVersion: 1, organizationId: "parent-org", stampPublicKey: "pub", requestTimestampMs: 1, requestBody: "b", requestBodySha256: sha("b") } });
    const claimText = flat(sent[1]!.queries![2]!.query);
    const block = (text: string, from: RegExp, to: RegExp) => {
      const start = text.search(from);
      const rest = text.slice(start);
      const end = rest.search(to);
      expect(start, String(from)).toBeGreaterThanOrEqual(0);
      expect(end, String(to)).toBeGreaterThan(0);
      return rest.slice(0, end);
    };
    const peekAdmission = block(peekText, /^WITH admission/, /, ledger AS MATERIALIZED/);
    const claimAdmission = block(claimText, /^WITH admission/, /, ledger AS MATERIALIZED/);
    expect(peekAdmission).toBe(claimAdmission);
    const peekLedger = block(peekText, /ledger AS MATERIALIZED/, /\) SELECT CASE/);
    const claimLedger = block(claimText, /ledger AS MATERIALIZED/, /\), verdict AS MATERIALIZED/);
    expect(peekLedger).toBe(claimLedger);
    const peekCase = block(peekText, /CASE WHEN l\.attempt_state/, / END AS decision/);
    const claimCase = block(claimText, /CASE WHEN l\.attempt_state/, / END AS decision/);
    expect(peekCase).toBe(claimCase);
    // Precedence, spelled out: lost claim, inconsistent ledger, attempt budget, global capacity, otherwise possible.
    const order = ["'claim_lost'", "'ledger_inconsistent'", "'attempt_budget_exhausted'", "'global_capacity_reached'", "ELSE 'admit'"].map((marker) => peekCase.indexOf(marker));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(peekLedger).toContain("d.created_at > admission.at - interval '1 hour'");
    expect(peekLedger).toContain("d.created_at > admission.at - interval '24 hours'");
    expect(peekLedger).toContain("COALESCE(MAX(d.dispatch_seq), 0)");
    expect(peekLedger).not.toMatch(/terminal_status|external_outcome|real_accounts|created_at >= /);
  });

  it("maps every server decision: the two refusals pass through; claim_lost, ledger_inconsistent, and admit are all 'proceed' (the claim reports or decides them)", async () => {
    for (const [decision, expected] of [
      ["attempt_budget_exhausted", BUDGET],
      ["global_capacity_reached", CAPACITY_PEEK],
      ["claim_lost", PROCEED],
      ["ledger_inconsistent", PROCEED],
      ["admit", PROCEED],
    ] as const) {
      respond = () => decisionAnswer(decision);
      expect(await peekNeon(), decision).toEqual(expected);
    }
  });

  it("I: no row, two rows, a null decision, or an unknown decision all THROW — and a database error does too; there is never a silent 'proceed'", async () => {
    const answers: Array<[string, () => Response]> = [
      ["no row", () => Response.json({ fields: [{ name: "decision", dataTypeID: 25 }], rows: [] })],
      ["two rows", () => Response.json({ fields: [{ name: "decision", dataTypeID: 25 }], rows: [["admit"], ["admit"]] })],
      ["a null decision", () => decisionAnswer(null)],
      ["an unknown decision", () => decisionAnswer("claimed")],
      ["an empty decision", () => decisionAnswer("")],
      ["a server error", () => new Response(JSON.stringify({ message: "boom" }), { status: 500 })],
      ["a transport failure", () => Promise.reject(new Error("fetch failed")) as unknown as Response],
    ];
    for (const [label, answer] of answers) {
      respond = answer;
      await expect(peekNeon(), label).rejects.toThrow();
    }
  });

  it("U: the OCF_PROV advisory lock, the row lock and the transaction stay ONLY in the authoritative claim", () => {
    const neon = readFileSync("lib/real/server/neon-store.ts", "utf8");
    const code = neon.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const claim = /async beginProvisioningDispatch\([\s\S]*?\n    \},\n/.exec(code)?.[0] ?? "";
    const peek = /async peekProvisioningDispatchRefusal\([\s\S]*?\n    \},\n/.exec(code)?.[0] ?? "";
    expect(claim).not.toBe("");
    expect(peek).not.toBe("");
    expect(claim.match(/PROVISIONING_DISPATCH_ADVISORY_LOCK_KEY/g)).toHaveLength(1);
    expect(code.match(/PROVISIONING_DISPATCH_ADVISORY_LOCK_KEY/g)).toHaveLength(2); // its definition, and the claim
    expect(peek).not.toMatch(/PROVISIONING_DISPATCH_ADVISORY_LOCK_KEY|advisory|FOR UPDATE|sql\.transaction|INSERT|UPDATE|DELETE/i);
    expect(peek.match(/\bawait\b/g)).toHaveLength(1);
    expect(peek.match(/sql`/g)).toHaveLength(1);
    // The claim is unchanged in shape: a transaction of four statements whose first two are the locks.
    expect(claim.match(/sql\.transaction\(/g)).toHaveLength(1);
    expect(claim).toMatch(/sql`SELECT credential_id FROM registration_attempts WHERE credential_id = \$\{credentialId\} FOR UPDATE`,\n\s+sql`SELECT pg_catalog\.pg_advisory_xact_lock\(\$\{PROVISIONING_DISPATCH_ADVISORY_LOCK_KEY\}::bigint\)`,/);
  });
});

describe("static boundaries of the integration", () => {
  const dispatch = readFileSync("lib/real/server/provisioning-dispatch.ts", "utf8");
  const code = dispatch.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");

  it("the pre-check is the FIRST thing runProvisioningDispatch does: before the Turnkey dependencies, the request body, its digest, and the claim", () => {
    const peek = code.indexOf("attempts.peekProvisioningDispatchRefusal(");
    const order = ["resolveParentTurnkeyDeps(", "deps.now()", "buildCreateSubOrganizationBody(", "sha256Hex(body)", "attempts.beginProvisioningDispatch("].map((needle) => code.indexOf(needle, peek));
    expect(peek).toBeGreaterThan(code.indexOf("export async function runProvisioningDispatch("));
    expect(order.every((index) => index > peek)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(code.match(/peekProvisioningDispatchRefusal\(/g)).toHaveLength(1);
    expect(code.match(/beginProvisioningDispatch\(/g)).toHaveLength(1);
    expect(code.match(/submitCreateSubOrganization\(/g)).toHaveLength(1);
  });

  it("a refusal returns before anything is built, and an unexpected pre-check answer throws — there is no path from the pre-check to an admission", () => {
    const start = code.indexOf("const peek = await attempts.peekProvisioningDispatchRefusal");
    const block = code.slice(start, code.indexOf("const deps = resolveParentTurnkeyDeps"));
    expect(block).toContain('if (peek.outcome === "attempt_budget_exhausted") return { kind: "attempt_budget_exhausted" };');
    expect(block).toContain('if (peek.outcome === "global_capacity_reached") return { kind: "capacity_reached" };');
    expect(block).toContain('if (peek.outcome !== "proceed") throw new Error("Provisioning dispatch pre-check returned no usable decision.");');
    expect(block).not.toMatch(/created|claimed|dispatch:|try\s*\{|catch/);
    // The pre-check has no `claimed` outcome in its type and no way to return a dispatch.
    const attempts = readFileSync("lib/real/server/registration-attempts.ts", "utf8");
    expect(attempts).toContain('export type ProvisioningDispatchPeek = { outcome: "proceed" } | { outcome: "attempt_budget_exhausted" } | { outcome: "global_capacity_reached" };');
  });

  it("the pipeline, the routes, the schema, the claim's constants and every limit are untouched", () => {
    const onboarding = readFileSync("lib/real/server/onboarding.ts", "utf8");
    expect(onboarding).not.toMatch(/peekProvisioningDispatchRefusal/);
    expect(onboarding).toContain('if (dispatched.kind === "capacity_reached") return { outcome: "capacity_reached", reason: REGISTRATION_CAPACITY_REACHED_REASON };');
    expect(onboarding).toContain('if (dispatched.kind === "attempt_budget_exhausted") return { outcome: "setup_exhausted", reason: REGISTRATION_SETUP_EXHAUSTED_REASON };');
    for (const route of ["app/api/real/account/register/verify/route.ts", "app/api/real/account/login/verify/route.ts"]) expect(readFileSync(route, "utf8"), route).not.toMatch(/peekProvisioningDispatchRefusal|Retry-After/);
    expect(readFileSync("lib/real/server/schema.sql", "utf8")).not.toMatch(/peekProvisioning/);
    expect([PROVISIONING_GLOBAL_HOURLY_DISPATCH_LIMIT, PROVISIONING_GLOBAL_DAILY_DISPATCH_LIMIT, PROVISIONING_ATTEMPT_DISPATCH_BUDGET, HOUR, DAY]).toEqual([5, 20, 2, 3_600_000, 86_400_000]);
  });
});
