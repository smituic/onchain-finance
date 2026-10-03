import type { RealServerConfig } from "./config";
import { classifyTerminalEvidence, evaluateCreateActivity, type CreateActivityEvaluation, type CreateActivityExpectation } from "./provisioning-evidence";
import type { DispatchTerminalStatus, ProvisioningDispatch, RegistrationAttempt, RegistrationAttemptStore } from "./registration-attempts";
import {
  PROVISIONING_EVIDENCE_VERSION,
  buildCreateSubOrganizationBody,
  findWalletAccountId,
  isTerminalActivityStatus,
  pollParentActivityUntilTerminal,
  readParentActivity,
  resolveParentTurnkeyDeps,
  submitCreateSubOrganization,
  type ParentTurnkeyDeps,
  type ProvisionedTurnkeyAccount,
} from "./turnkey-provisioning";
import { sha256Hex, type TurnkeyActivitySummary } from "./turnkey-signed-request";

/**
 * ONE external CREATE_SUB_ORGANIZATION dispatch for one "verified" attempt,
 * with its evidence captured first (Provisioning Evidence Capture). The
 * order is the invariant:
 *
 *   build the body once -> COMMIT claim + evidence row -> verify the
 *   PERSISTED body and digest -> stamp and send that persisted string ->
 *   record the activity id before any poll or follow-up read -> bounded
 *   exact-id poll -> record the terminal observation -> compare against the
 *   evidence -> only then use the response.
 *
 * Every way this can end without a validated COMPLETED activity (or a
 * validated terminal FAILED/REJECTED for this exact activity) is "review":
 * the attempt stays "provisioning_in_flight" / "unknown". Nothing here ever
 * sends the create a second time, re-stamps a stored body, lists or searches
 * Turnkey, or adopts anything from a stored row — the evidence is written
 * for a future operator-only resolver, not read back by this pipeline.
 */
export type ProvisioningDispatchOutcome =
  /** Another request already moved the attempt off "verified": nothing was inserted, stamped, or sent. */
  | { kind: "claim_lost" }
  /** A validated COMPLETED response to our own create, plus the wallet-account read. `dispatchId`/`activityId` name the evidence the store's own CAS re-checks. */
  | { kind: "created"; provisioned: ProvisionedTurnkeyAccount; dispatchId: string; activityId: string }
  /** Turnkey's ledger resolved THIS dispatch's exact activity to FAILED/REJECTED, and that is durably recorded. */
  | { kind: "definitive_failure"; dispatchId: string; activityId: string }
  | { kind: "review" };

const POLLABLE_STATUSES = new Set(["ACTIVITY_STATUS_CREATED", "ACTIVITY_STATUS_PENDING"]);

/** One immediate retry for a write that is idempotent by construction (write-once WHERE guards). Never used for anything that reaches Turnkey. */
async function withOneRetry<T>(write: () => Promise<T>): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await write();
    } catch {
      // fall through: retry once, then give up (the caller stops in review)
    }
  }
  return null;
}

function terminalObservation(evaluation: CreateActivityEvaluation, status: DispatchTerminalStatus) {
  return {
    status,
    observedBy: "dispatch" as const,
    turnkeyCreatedAt: evaluation.turnkeyCreatedAt,
    observedSubOrganizationId: evaluation.result?.subOrganizationId ?? null,
    observedRootUserId: evaluation.result?.rootUserId ?? null,
    observedWalletId: evaluation.result?.walletId ?? null,
    observedOwnerAddress: evaluation.result?.ownerAddress ?? null,
    failureCode: evaluation.failure?.code ?? null,
    failureMessage: evaluation.failure?.message ?? null,
    intentVerdict: evaluation.intentVerdict,
    fingerprintVerdict: evaluation.fingerprintVerdict,
    voteVerdict: evaluation.voteVerdict,
  };
}

export async function runProvisioningDispatch(input: {
  config: RealServerConfig;
  attempts: RegistrationAttemptStore;
  /** Must be read as "verified"; the claim below is what actually decides. */
  attempt: RegistrationAttempt;
  deps?: ParentTurnkeyDeps;
}): Promise<ProvisioningDispatchOutcome> {
  const { config, attempts, attempt } = input;
  const deps = resolveParentTurnkeyDeps(config, input.deps);

  // 1-2. ONE clock reading, ONE body, its digest over the exact UTF-8 bytes.
  const timestampMs = deps.now();
  const body = buildCreateSubOrganizationBody({
    organizationId: config.turnkeyParentOrganizationId,
    appUserId: attempt.appUserId,
    timestampMs,
    challengeBase64Url: attempt.registrationChallenge,
    credentialId: attempt.credentialId,
    clientDataJson: attempt.rawClientDataJson,
    attestationObject: attempt.rawAttestationObject,
    transports: attempt.transports,
  });
  const bodySha256 = sha256Hex(body);

  // 3-4. Claim + evidence, committed together, before any stamp or fetch. If
  // that TRANSACTION fails (e.g. a constraint), it throws out of here with the
  // attempt still "verified". If it committed but its response was lost, it
  // also throws — then the claim and evidence are durable, nothing was sent,
  // and the attempt is in review (fail closed).
  const begun = await attempts.beginProvisioningDispatch({
    credentialId: attempt.credentialId,
    attemptedAt: new Date(timestampMs).toISOString(),
    evidence: {
      evidenceVersion: PROVISIONING_EVIDENCE_VERSION,
      organizationId: config.turnkeyParentOrganizationId,
      stampPublicKey: config.turnkeyApiPublicKey,
      requestTimestampMs: timestampMs,
      requestBody: body,
      requestBodySha256: bodySha256,
    },
  });
  if (!begun) return { kind: "claim_lost" };
  const dispatch: ProvisioningDispatch = begun.dispatch;

  // 5. From here on only the PERSISTED body is used. It must be the string we
  // built, and its digest is recomputed independently of the stored column.
  const persistedBody = dispatch.requestBody;
  if (persistedBody !== body || dispatch.requestBodySha256 !== bodySha256 || sha256Hex(persistedBody) !== bodySha256) return { kind: "review" };

  // 6. Stamp and send exactly that string. Once.
  const submitted = await submitCreateSubOrganization({ config, body: persistedBody, deps });
  if (submitted.kind !== "activity") return { kind: "review" };

  const expectation: CreateActivityExpectation = {
    activityId: submitted.activity.id,
    organizationId: dispatch.organizationId,
    requestBody: persistedBody,
    requestBodySha256: bodySha256,
    stampPublicKey: dispatch.stampPublicKey,
    requestTimestampMs: dispatch.requestTimestampMs,
  };
  const activityId = submitted.activity.id;

  // 7-8. The activity id is recorded BEFORE any poll or follow-up read. Only
  // the database write may be retried; a different id already recorded, or a
  // write that cannot be confirmed, stops here.
  const submittedEvaluation = evaluateCreateActivity(submitted.activity, expectation);
  const recorded = await withOneRetry(() => attempts.recordDispatchActivity({ dispatchId: dispatch.id, activityId, fingerprint: submittedEvaluation.fingerprint }));
  if (!recorded || (recorded.outcome !== "recorded" && recorded.outcome !== "already_recorded")) return { kind: "review" };

  // 9. Bounded exact-id polling, only while the activity can still resolve
  // by itself. A status carried by a non-2xx answer is never trusted as is.
  let activity: TurnkeyActivitySummary = submitted.activity;
  /** Whether `activity.status` came from a 2xx answer (the submit's, or a read-back by id). */
  let statusTrusted = submitted.httpOk;
  let terminal = submitted.httpOk && isTerminalActivityStatus(activity.status);
  if (!terminal && (!submitted.httpOk || POLLABLE_STATUSES.has(activity.status))) {
    const polled = await pollParentActivityUntilTerminal({
      activityId,
      read: (timeoutMs) => readParentActivity({ config, organizationId: dispatch.organizationId, activityId, timeoutMs, deps }),
      now: deps.now,
      sleep: deps.sleep,
      limits: deps.limits,
    });
    if (polled.activity) {
      activity = polled.activity;
      statusTrusted = true;
    }
    terminal = polled.terminal;
  }
  if (!terminal) {
    // Best effort, metadata only: the outcome stays unknown either way.
    if (statusTrusted) await withOneRetry(() => attempts.recordDispatchObservation({ dispatchId: dispatch.id, activityId, status: activity.status.slice(0, 100) }));
    return { kind: "review" };
  }

  // 10-11. The terminal observation is recorded (write-once) only for the
  // exact id / organization / type; anything else is not this dispatch's
  // activity and is not written down as if it were.
  const evaluation = evaluateCreateActivity(activity, expectation);
  if (evaluation.identity !== "ok" || evaluation.terminalStatus === null) return { kind: "review" };
  const status = evaluation.terminalStatus;
  const terminalRecord = await withOneRetry(() => attempts.recordDispatchTerminal({ dispatchId: dispatch.id, activityId, observation: terminalObservation(evaluation, status) }));
  const terminalRecorded =
    terminalRecord !== null &&
    (terminalRecord.outcome === "recorded" ||
      // Our own first write landed but its answer was lost; the retry found it.
      (terminalRecord.outcome === "already_terminal" && terminalRecord.dispatch.terminalStatus === status && terminalRecord.dispatch.terminalObservedBy === "dispatch"));
  if (!terminalRecorded) return { kind: "review" };

  // 12-15. What this terminal activity proves about OUR request
  // (classifyTerminalEvidence): a COMPLETED needs an exact intent and a usable
  // result; a FAILED/REJECTED is definitive only when positively tied to our
  // body. Anything else — including a mismatch — acts on neither outcome.
  const decision = classifyTerminalEvidence(evaluation);
  if (decision.kind === "review") return { kind: "review" };
  if (decision.kind === "definitive_failure") return { kind: "definitive_failure", dispatchId: dispatch.id, activityId };
  const result = decision.result;

  // 16. The one follow-up read, bounded, bound to exactly the account the
  // validated result names. Any failure or disagreement stops in review.
  const walletAccountId = await findWalletAccountId({ config, subOrganizationId: result.subOrganizationId, walletId: result.walletId, ownerAddress: result.ownerAddress, deps });
  if (!walletAccountId) return { kind: "review" };

  return {
    kind: "created",
    dispatchId: dispatch.id,
    activityId,
    provisioned: { subOrganizationId: result.subOrganizationId, turnkeyUserId: result.rootUserId, walletId: result.walletId, walletAccountId, ownerAddress: result.ownerAddress },
  };
}
