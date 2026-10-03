import type { RealServerConfig } from "./config";
import { evaluateCreateActivity } from "./provisioning-evidence";
import type { DispatchFingerprintVerdict, DispatchIntentVerdict, DispatchVoteVerdict, ProvisioningDispatch, RegistrationAttemptStore } from "./registration-attempts";
import { readParentActivity, resolveParentTurnkeyDeps, type ParentActivityRead, type ParentTurnkeyDeps } from "./turnkey-provisioning";

/**
 * OPERATOR-ONLY, RECORD-ONLY exact-id observation of one provisioning
 * dispatch (Provisioning Evidence Capture). Not wired into runtime.ts, any
 * route, or the onboarding / registration / login pipeline (a boundary test
 * enforces this); it runs only through the env-gated admin runner
 * test/admin/poll-provisioning-activity.admin.test.ts.
 *
 * What it does: for ONE stored dispatch that already has a recorded
 * activity id, read that activity by its exact stored id in its stored
 * parent organization, compare it with the stored request evidence, and (on
 * commit) write the observation onto the dispatch row.
 *
 * What it can never do — by construction, not by convention:
 *   - take an activity id from the operator (the id comes from the row);
 *   - list or search Turnkey, or read any organization but the stored one;
 *   - send, re-send, or re-stamp a create, or call any mutation endpoint;
 *   - change a registration attempt, an account, a passkey, or a session:
 *     its store is a three-method Pick with no such method on it.
 *
 * Option 3 is unchanged by anything recorded here: onboarding never reads a
 * dispatch row, so a recorded COMPLETED observation moves nothing. A
 * "not found" answer for a stored id is an anomaly to report — never a
 * conclusion that nothing was created.
 */
export interface ProvisioningActivityPort {
  getActivity(input: { organizationId: string; activityId: string }): Promise<ParentActivityRead>;
}

/** The only writes the poller can reach: the dispatch row's observation columns. */
export type ProvisioningPollStore = Pick<RegistrationAttemptStore, "findDispatchesByCredentialId" | "recordDispatchObservation" | "recordDispatchTerminal">;

const OPERATOR_READ_TIMEOUT_MS = 10_000;

/** Parent-key-stamped, read-only, one bounded request per call. */
export function createProvisioningActivityPort(config: RealServerConfig, deps?: ParentTurnkeyDeps): ProvisioningActivityPort {
  const resolved = resolveParentTurnkeyDeps(config, deps);
  return {
    getActivity: ({ organizationId, activityId }) => readParentActivity({ config, organizationId, activityId, timeoutMs: OPERATOR_READ_TIMEOUT_MS, deps: resolved }),
  };
}

export type ProvisioningPollReason =
  | "invalid_input"
  | "dispatch_not_found"
  | "no_activity_id"
  | "organization_mismatch"
  | "already_terminal"
  | "turnkey_read_failed"
  | "turnkey_activity_not_found"
  | "activity_identity_mismatch"
  | "observation_not_recorded";

export type ProvisioningPollReport = {
  /** refused: nothing was learned or written. pending: the activity is not terminal. terminal: COMPLETED / FAILED / REJECTED was observed. */
  outcome: "refused" | "pending" | "terminal";
  reason: ProvisioningPollReason | null;
  /** True only when this run wrote an observation. Always false on a dry run. */
  committed: boolean;
  credentialId: string;
  dispatchId: string | null;
  dispatchSeq: number | null;
  activityId: string | null;
  status: string | null;
  intentVerdict: DispatchIntentVerdict | null;
  fingerprintVerdict: DispatchFingerprintVerdict | null;
  voteVerdict: DispatchVoteVerdict | null;
  createdAtPlausible: boolean | null;
  /** Whether a COMPLETED activity's result named exactly one sub-org, root user, wallet, and address. */
  resultObserved: boolean;
};

function refuse(reason: ProvisioningPollReason, credentialId: string, dispatch: ProvisioningDispatch | null): ProvisioningPollReport {
  return {
    outcome: "refused",
    reason,
    committed: false,
    credentialId,
    dispatchId: dispatch?.id ?? null,
    dispatchSeq: dispatch?.dispatchSeq ?? null,
    activityId: dispatch?.turnkeyActivityId ?? null,
    status: dispatch?.terminalStatus ?? dispatch?.lastObservedStatus ?? null,
    intentVerdict: dispatch?.intentVerdict ?? null,
    fingerprintVerdict: dispatch?.fingerprintVerdict ?? null,
    voteVerdict: dispatch?.voteVerdict ?? null,
    createdAtPlausible: null,
    resultObserved: Boolean(dispatch?.observedSubOrganizationId),
  };
}

export async function pollProvisioningDispatch(input: {
  store: ProvisioningPollStore;
  port: ProvisioningActivityPort;
  /** The CONFIGURED parent organization; the stored one must equal it. */
  parentOrganizationId: string;
  credentialId: string;
  /** Omitted: the attempt's newest dispatch. */
  dispatchSeq?: number;
  /** false (the default for the runner): read and compare, write nothing. */
  commit: boolean;
}): Promise<ProvisioningPollReport> {
  const { store, credentialId } = input;
  if (!credentialId || !input.parentOrganizationId) return refuse("invalid_input", credentialId, null);
  if (input.dispatchSeq !== undefined && (!Number.isSafeInteger(input.dispatchSeq) || input.dispatchSeq < 1)) return refuse("invalid_input", credentialId, null);

  const dispatches = await store.findDispatchesByCredentialId(credentialId);
  const dispatch = input.dispatchSeq === undefined ? dispatches[dispatches.length - 1] : dispatches.find((row) => row.dispatchSeq === input.dispatchSeq);
  if (!dispatch) return refuse("dispatch_not_found", credentialId, null);
  // No recorded id means nothing to look up: this poller never searches for one.
  if (!dispatch.turnkeyActivityId) return refuse("no_activity_id", credentialId, dispatch);
  if (dispatch.organizationId !== input.parentOrganizationId) return refuse("organization_mismatch", credentialId, dispatch);
  // The terminal observation is write-once; there is nothing left to record.
  if (dispatch.terminalStatus !== null) return refuse("already_terminal", credentialId, dispatch);

  const activityId = dispatch.turnkeyActivityId;
  const read = await input.port.getActivity({ organizationId: dispatch.organizationId, activityId });
  if (read.kind === "not_found") return refuse("turnkey_activity_not_found", credentialId, dispatch);
  if (read.kind !== "activity") return refuse("turnkey_read_failed", credentialId, dispatch);

  const evaluation = evaluateCreateActivity(read.activity, {
    activityId,
    organizationId: dispatch.organizationId,
    requestBody: dispatch.requestBody,
    requestBodySha256: dispatch.requestBodySha256,
    stampPublicKey: dispatch.stampPublicKey,
    requestTimestampMs: dispatch.requestTimestampMs,
  });
  // Not this dispatch's activity: never written down as if it were.
  if (evaluation.identity !== "ok") return refuse("activity_identity_mismatch", credentialId, dispatch);

  const report: ProvisioningPollReport = {
    outcome: evaluation.terminalStatus === null ? "pending" : "terminal",
    reason: null,
    committed: false,
    credentialId,
    dispatchId: dispatch.id,
    dispatchSeq: dispatch.dispatchSeq,
    activityId,
    status: evaluation.status,
    intentVerdict: evaluation.intentVerdict,
    fingerprintVerdict: evaluation.fingerprintVerdict,
    voteVerdict: evaluation.voteVerdict,
    createdAtPlausible: evaluation.createdAtPlausible,
    resultObserved: evaluation.result !== null,
  };
  if (!input.commit) return report;

  if (evaluation.terminalStatus === null) {
    const recorded = await store.recordDispatchObservation({ dispatchId: dispatch.id, activityId, status: evaluation.status.slice(0, 100) });
    return recorded ? { ...report, committed: true } : { ...report, reason: "observation_not_recorded" };
  }

  const recorded = await store.recordDispatchTerminal({
    dispatchId: dispatch.id,
    activityId,
    observation: {
      status: evaluation.terminalStatus,
      observedBy: "operator_poll",
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
    },
  });
  return recorded.outcome === "recorded" ? { ...report, committed: true } : { ...report, reason: "observation_not_recorded" };
}

function truncate(value: string | null): string | null {
  return value === null ? null : value.length <= 8 ? value : `${value.slice(0, 8)}…`;
}

/** What the runner prints: outcome, reason, verdicts, and truncated identifiers — never a request body, a key, or a stamp. */
export function redactPollReport(report: ProvisioningPollReport): ProvisioningPollReport {
  return { ...report, credentialId: truncate(report.credentialId) ?? "", dispatchId: truncate(report.dispatchId), activityId: truncate(report.activityId) };
}
