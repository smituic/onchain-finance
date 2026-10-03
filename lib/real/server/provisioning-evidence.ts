import {
  DISPATCH_FAILURE_MESSAGE_MAX_LENGTH,
  DISPATCH_FINGERPRINT_MAX_LENGTH,
  DISPATCH_TERMINAL_STATUSES,
  type DispatchFingerprintVerdict,
  type DispatchIntentVerdict,
  type DispatchTerminalStatus,
  type DispatchVoteVerdict,
} from "./registration-attempts";
import { parseSignedBody, type TurnkeyActivitySummary } from "./turnkey-signed-request";

/**
 * PURE comparison of one Turnkey CREATE_SUB_ORGANIZATION activity against
 * the dispatch evidence this app persisted before sending it. No network, no
 * keys, no store — shared by the in-process dispatch
 * (provisioning-dispatch.ts) and the record-only operator poller
 * (provisioning-activity-poller.ts).
 *
 * What a read-only probe of the live parent organization established (8 of
 * 8 CREATE_SUB_ORGANIZATION_V8 activities), and what this module therefore
 * relies on or deliberately does NOT rely on:
 *
 *   - `intent.createSubOrganizationIntentV8` holds the same fields and
 *     values as the request's `parameters`, with the KEYS REORDERED. So the
 *     comparison is structural and key-order-insensitive — serialized
 *     strings are never compared.
 *   - `fingerprint` was "sha256:" + sha256 of the exact request body. That
 *     is Turnkey's value in Turnkey's format: it is compared with OUR digest
 *     only while it has exactly that form. Any other form is recorded as
 *     "unrecognized_form" and decides nothing.
 *   - `createdAt` is whole seconds and can be EARLIER than the request's own
 *     millisecond timestamp. It is never compared for equality.
 */
const CREATE_ACTIVITY_TYPE = "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V8";
const RECOGNIZED_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Turnkey's documented request-validity window (timestampMs at most 1 hour
 * old, at most 5 minutes ahead) plus a second each way for createdAt's
 * whole-second truncation. Used only for a recorded plausibility flag.
 */
const CREATED_AT_EARLIEST_MS = 5 * 60 * 1000 + 1000;
const CREATED_AT_LATEST_MS = 60 * 60 * 1000 + 1000;

export type CreateActivityExpectation = {
  /** The activity id already recorded for this dispatch; null only while evaluating the submit response that first reveals it. */
  activityId: string | null;
  organizationId: string;
  requestBody: string;
  requestBodySha256: string;
  stampPublicKey: string;
  requestTimestampMs: number;
};

export type ObservedCreateResult = { subOrganizationId: string; rootUserId: string; walletId: string; ownerAddress: string };

export type CreateActivityEvaluation = {
  identity: "ok" | "id_mismatch" | "organization_mismatch" | "type_mismatch";
  status: string;
  terminalStatus: DispatchTerminalStatus | null;
  /** Turnkey's fingerprint verbatim (null if absent, not a string, or implausibly long). */
  fingerprint: string | null;
  fingerprintVerdict: DispatchFingerprintVerdict;
  intentVerdict: DispatchIntentVerdict;
  voteVerdict: DispatchVoteVerdict;
  turnkeyCreatedAt: string | null;
  /** null when createdAt is unreadable. Informational only — never a gate. */
  createdAtPlausible: boolean | null;
  /** Non-null only for a COMPLETED activity whose result names exactly one sub-org, one root user, one wallet, and one address. */
  result: ObservedCreateResult | null;
  failure: { code: number | null; message: string | null } | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

/** Everything in `sent` appears, unchanged, in `echoed`; `echoed` may carry extra object keys (never extra or reordered array elements). */
function covers(sent: unknown, echoed: unknown): boolean {
  if (Array.isArray(sent)) return Array.isArray(echoed) && echoed.length === sent.length && sent.every((item, index) => covers(item, echoed[index]));
  if (isRecord(sent)) return isRecord(echoed) && Object.keys(sent).every((key) => Object.prototype.hasOwnProperty.call(echoed, key) && covers(sent[key], echoed[key]));
  return sent === echoed;
}

/** The persisted request body, strictly parsed (duplicate member names fail closed). null if it is not a V8 create request with an object `parameters`. */
export function readDispatchRequestBody(body: string): { type: string; timestampMs: string; organizationId: string; parameters: Record<string, unknown> } | null {
  const parsed = parseSignedBody(body);
  if (!parsed) return null;
  const { type, timestampMs, organizationId, parameters } = parsed;
  if (type !== CREATE_ACTIVITY_TYPE || typeof timestampMs !== "string" || typeof organizationId !== "string" || !isRecord(parameters)) return null;
  return { type, timestampMs, organizationId, parameters };
}

/**
 * "exact": the activity carries only the V8 create intent, and it equals
 * what we sent, key order aside. "fields_only": everything we sent is echoed
 * unchanged but the echo has keys we did not send. Anything else — including
 * a missing intent or a second intent member — is "mismatch".
 */
export function compareIntent(requestBody: string, intent: unknown): DispatchIntentVerdict {
  const request = readDispatchRequestBody(requestBody);
  if (!request || !isRecord(intent)) return "mismatch";
  const members = Object.keys(intent);
  if (members.length !== 1 || members[0] !== "createSubOrganizationIntentV8") return "mismatch";
  const echoed = intent.createSubOrganizationIntentV8;
  if (!isRecord(echoed)) return "mismatch";
  if (JSON.stringify(canonicalize(request.parameters)) === JSON.stringify(canonicalize(echoed))) return "exact";
  return covers(request.parameters, echoed) ? "fields_only" : "mismatch";
}

export function compareFingerprint(requestBodySha256: string, fingerprint: unknown): DispatchFingerprintVerdict {
  if (typeof fingerprint !== "string" || !RECOGNIZED_FINGERPRINT.test(fingerprint)) return "unrecognized_form";
  return fingerprint === `sha256:${requestBodySha256}` ? "match" : "mismatch";
}

/** "parent_key": exactly one vote, an approval, by the key that stamped this dispatch — and, if the vote echoes a message, that message is the exact body. */
function compareVote(expected: CreateActivityExpectation, votes: unknown): DispatchVoteVerdict {
  if (!Array.isArray(votes) || votes.length !== 1 || !isRecord(votes[0])) return "other";
  const vote = votes[0];
  if (vote.selection !== "VOTE_SELECTION_APPROVED" || vote.publicKey !== expected.stampPublicKey) return "other";
  if (vote.message !== undefined && vote.message !== null && vote.message !== expected.requestBody) return "other";
  return "parent_key";
}

function readCreatedAtMs(createdAt: unknown): number | null {
  if (!isRecord(createdAt) || typeof createdAt.seconds !== "string" || !/^\d{1,12}$/.test(createdAt.seconds)) return null;
  return Number(createdAt.seconds) * 1000;
}

function readResult(result: unknown): ObservedCreateResult | null {
  if (!isRecord(result) || !isRecord(result.createSubOrganizationResultV8)) return null;
  const { subOrganizationId, rootUserIds, wallet } = result.createSubOrganizationResultV8;
  if (typeof subOrganizationId !== "string" || !subOrganizationId) return null;
  if (!Array.isArray(rootUserIds) || rootUserIds.length !== 1 || typeof rootUserIds[0] !== "string" || !rootUserIds[0]) return null;
  if (!isRecord(wallet) || typeof wallet.walletId !== "string" || !wallet.walletId) return null;
  if (!Array.isArray(wallet.addresses) || wallet.addresses.length !== 1 || typeof wallet.addresses[0] !== "string" || !EVM_ADDRESS.test(wallet.addresses[0])) return null;
  return { subOrganizationId, rootUserId: rootUserIds[0], walletId: wallet.walletId, ownerAddress: wallet.addresses[0] };
}

function readFailure(failure: unknown): { code: number | null; message: string | null } | null {
  if (!isRecord(failure)) return null;
  return {
    code: typeof failure.code === "number" && Number.isSafeInteger(failure.code) && Math.abs(failure.code) <= 2_147_483_647 ? failure.code : null,
    // Bounded; a cut that lands inside a surrogate pair drops the orphaned half rather than storing malformed text.
    message: typeof failure.message === "string" ? failure.message.slice(0, DISPATCH_FAILURE_MESSAGE_MAX_LENGTH).replace(/[\uD800-\uDBFF]$/, "") : null,
  };
}

export function evaluateCreateActivity(activity: TurnkeyActivitySummary, expected: CreateActivityExpectation): CreateActivityEvaluation {
  const raw = activity.raw;
  const identity =
    expected.activityId !== null && activity.id !== expected.activityId
      ? "id_mismatch"
      : activity.organizationId !== expected.organizationId
        ? "organization_mismatch"
        : activity.type !== CREATE_ACTIVITY_TYPE
          ? "type_mismatch"
          : "ok";
  const terminalStatus = (DISPATCH_TERMINAL_STATUSES as readonly string[]).includes(activity.status) ? (activity.status as DispatchTerminalStatus) : null;
  const createdAtMs = readCreatedAtMs(raw.createdAt);
  return {
    identity,
    status: activity.status,
    terminalStatus,
    fingerprint: typeof raw.fingerprint === "string" && raw.fingerprint.length <= DISPATCH_FINGERPRINT_MAX_LENGTH ? raw.fingerprint : null,
    fingerprintVerdict: compareFingerprint(expected.requestBodySha256, raw.fingerprint),
    intentVerdict: compareIntent(expected.requestBody, raw.intent),
    voteVerdict: compareVote(expected, raw.votes),
    turnkeyCreatedAt: createdAtMs === null ? null : new Date(createdAtMs).toISOString(),
    createdAtPlausible:
      createdAtMs === null ? null : createdAtMs >= expected.requestTimestampMs - CREATED_AT_EARLIEST_MS && createdAtMs <= expected.requestTimestampMs + CREATED_AT_LATEST_MS,
    result: terminalStatus === "ACTIVITY_STATUS_COMPLETED" ? readResult(raw.result) : null,
    failure: terminalStatus === "ACTIVITY_STATUS_FAILED" || terminalStatus === "ACTIVITY_STATUS_REJECTED" ? readFailure(raw.failure) : null,
  };
}

/**
 * What a terminal activity proves about THIS dispatch — the in-process rule,
 * strongly typed. A positive mismatch (identity, recognized fingerprint, or
 * intent) always fails closed.
 *
 *   COMPLETED            only with an EXACT intent and a usable result. Keys
 *                        we did not send ("fields_only") are review even with
 *                        a matching fingerprint: a new server-echoed field
 *                        must never silently become part of an activated
 *                        account.
 *   FAILED / REJECTED    definitive with an exact intent, or with
 *                        "fields_only" ONLY when the recognized fingerprint
 *                        positively matches our persisted body. An
 *                        unrecognized fingerprint never turns "fields_only"
 *                        into a definitive failure.
 *
 * An unrecognized fingerprint FORM alone decides nothing (Turnkey may change
 * its format). Kept in step with registration-attempts.ts's
 * dispatchProvesCreated / dispatchProvesDefinitiveFailure, which the store
 * re-checks on the recorded row.
 */
export type TerminalEvidenceDecision =
  | { kind: "completed"; result: ObservedCreateResult }
  | { kind: "definitive_failure" }
  | { kind: "review"; reason: "not_this_activity" | "not_terminal" | "fingerprint_mismatch" | "intent_mismatch" | "intent_not_exact" | "result_unusable" };

export function classifyTerminalEvidence(evaluation: CreateActivityEvaluation): TerminalEvidenceDecision {
  if (evaluation.identity !== "ok") return { kind: "review", reason: "not_this_activity" };
  if (evaluation.terminalStatus === null) return { kind: "review", reason: "not_terminal" };
  if (evaluation.fingerprintVerdict === "mismatch") return { kind: "review", reason: "fingerprint_mismatch" };
  if (evaluation.intentVerdict === "mismatch") return { kind: "review", reason: "intent_mismatch" };
  if (evaluation.terminalStatus === "ACTIVITY_STATUS_COMPLETED") {
    if (evaluation.intentVerdict !== "exact") return { kind: "review", reason: "intent_not_exact" };
    return evaluation.result ? { kind: "completed", result: evaluation.result } : { kind: "review", reason: "result_unusable" };
  }
  if (evaluation.intentVerdict === "exact" || evaluation.fingerprintVerdict === "match") return { kind: "definitive_failure" };
  return { kind: "review", reason: "intent_not_exact" };
}
