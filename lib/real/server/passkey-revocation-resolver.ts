import { credentialIdsEqual, decodeCredentialId } from "../credential-id";
import { isValidUuid } from "../identifiers";
import type { RealServerConfig } from "./config";
import type { ReceiptSource, ResolutionAttemptRow, ResolutionSnapshot, RevocationResolutionStore } from "./passkey-revocation-resolution-store";
import { createParentTurnkeyClient } from "./turnkey-provisioning";
import { hasExactlyKeys, parseSignedBody, parseTimestampMs, sha256Hex } from "./turnkey-signed-request";

/**
 * S3 — OPERATOR-ONLY resolution of a BLOCKED passkey removal (R2a only).
 *
 * A blocked removal has no exit of its own: if the target authenticator is
 * already gone at Turnkey, every user-authorized retry fails there and blocks
 * again, so the target stays 'revoking' (and a pending-origin enrollment holds
 * the one-open-enrollment slot) forever. This resolver may terminalize such a
 * row ONLY when Turnkey's read-only ledger independently proves, against OUR
 * OWN durable DELETE history, that exactly this mapped authenticator was
 * deleted and remains absent:
 *
 *   1. local: the attempt is 'blocked', is the newest non-cancelled attempt
 *      for its target, nothing is in flight, the target is 'revoking' with an
 *      unchanged mapping, another active mapped passkey exists;
 *   2. R2a receipt: a COMPLETED DELETE_AUTHENTICATORS whose intent and result
 *      name exactly [target] for exactly this org/user AND whose fingerprint
 *      equals "sha256:" + the sha256 of a DELETE body WE durably stored for
 *      this same target (strictly re-validated and re-hashed). Exactly one
 *      such activity, re-read by id and identical. An external/dashboard
 *      DELETE with no stored body (R2b) is NEVER accepted;
 *   3. no activity that can carry authenticator authority at or after the
 *      receipt (same second counts) refers to the target id or credential
 *      bytes, and none is unparseable;
 *   4. absence: two full snapshots (getUsers across ALL users + the account
 *      user's getAuthenticators, which must agree exactly) show the target
 *      nowhere, every non-revoked mapped passkey present exactly once, and no
 *      unexplained authenticator on the account user;
 *   5. the activity-log head is unchanged after the second snapshot.
 *
 * Absence alone is never enough. Every read failure, malformed response,
 * partial walk, or ambiguity fails closed (no change). The fingerprint rule
 * is an EXTRA fail-closed guard — observed on live data, not a documented
 * Turnkey guarantee: if Turnkey ever changes it, rows simply stay blocked.
 *
 * This is NOT a wallet-authority path: it never sends a Turnkey mutation,
 * never forwards a signed request (it has no fetch), never signs, never
 * touches an 'active'/'pending' passkey, the owner, or the Safe. It only
 * records, locally, a deletion Turnkey already performed.
 */
export const RESOLVER_VERSION = 1;

const DELETE_TYPE = "ACTIVITY_TYPE_DELETE_AUTHENTICATORS";
const COMPLETED = "ACTIVITY_STATUS_COMPLETED";
export const ACTIVITY_PAGE_LIMIT = 100;
export const MAX_ACTIVITY_PAGES = 50;

// ---------------------------------------------------------------- the narrow read-only Turnkey port

/**
 * EXACTLY the four read-only queries the resolver needs — nothing that can
 * create, delete, approve, sign, or forward. Responses are `unknown` and
 * validated field by field below.
 */
export interface TurnkeyReadOnlyLedger {
  getActivity(input: { organizationId: string; activityId: string }): Promise<unknown>;
  getActivities(input: { organizationId: string; paginationOptions: { limit: string; after?: string } }): Promise<unknown>;
  getUsers(input: { organizationId: string }): Promise<unknown>;
  getAuthenticators(input: { organizationId: string; userId: string }): Promise<unknown>;
}

/** Wraps the parent client so the resolver never holds it — only these four bound reads escape. */
export function createReadOnlyTurnkeyLedger(config: RealServerConfig): TurnkeyReadOnlyLedger {
  const client = createParentTurnkeyClient(config);
  return Object.freeze({
    getActivity: (input: { organizationId: string; activityId: string }) => client.getActivity(input),
    getActivities: (input: { organizationId: string; paginationOptions: { limit: string; after?: string } }) => client.getActivities(input),
    getUsers: (input: { organizationId: string }) => client.getUsers(input),
    getAuthenticators: (input: { organizationId: string; userId: string }) => client.getAuthenticators(input),
  });
}

// ---------------------------------------------------------------- outcomes

export type ResolverOutcome =
  | "resolved"
  | "resolvable_dry_run"
  | "already_resolved"
  | "not_resolvable_state"
  | "no_receipt"
  | "target_still_present"
  | "inconsistent_manual_review"
  | "turnkey_read_failed"
  | "turnkey_read_incomplete"
  | "activity_log_changed"
  | "lost_race";

export type ResolverEvidence = {
  receiptActivityId: string;
  receiptSource: ReceiptSource;
  receiptBodyAttemptId: string;
  receiptTurnkeyCreatedAt: string;
  activityLogHeadId: string;
  activitiesScanned: number;
  survivorAuthenticatorIds: string[];
  absenceFirstObservedAt: string;
  absenceLastObservedAt: string;
};

export type ResolverReport = { outcome: ResolverOutcome; reason: string; committed: boolean; evidence?: ResolverEvidence };

type Failure = { ok: false; outcome: ResolverOutcome; reason: string };
const fail = (outcome: ResolverOutcome, reason: string): Failure => ({ ok: false, outcome, reason });

// ---------------------------------------------------------------- strict parsing

type Timestamp = { seconds: bigint; nanos: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Turnkey's { seconds: string, nanos: string } (numbers tolerated); an absent nanos is proto3's 0. Anything else is null. */
function parseTimestamp(value: unknown): Timestamp | null {
  if (!isRecord(value)) return null;
  const { seconds, nanos } = value;
  let s: bigint | null = null;
  if (typeof seconds === "string" && /^\d{1,15}$/.test(seconds)) s = BigInt(seconds);
  else if (typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds >= 0) s = BigInt(seconds);
  let n: number | null = null;
  if (nanos === undefined) n = 0;
  else if (typeof nanos === "string" && /^\d{1,9}$/.test(nanos)) n = Number(nanos);
  else if (typeof nanos === "number" && Number.isInteger(nanos) && nanos >= 0 && nanos < 1e9) n = nanos;
  return s === null || n === null ? null : { seconds: s, nanos: n };
}

function compareTimestamps(a: Timestamp, b: Timestamp): number {
  if (a.seconds !== b.seconds) return a.seconds < b.seconds ? -1 : 1;
  return a.nanos - b.nanos;
}

function timestampToIso(t: Timestamp): string {
  return new Date(Number(t.seconds) * 1000 + Math.floor(t.nanos / 1e6)).toISOString();
}

type LedgerActivity = {
  id: string;
  type: string;
  status: string;
  organizationId: string;
  fingerprint: string | null;
  createdAt: Timestamp;
  intent: unknown;
  result: unknown;
};

function parseLedgerActivity(value: unknown): LedgerActivity | null {
  if (!isRecord(value)) return null;
  const { id, type, status, organizationId, fingerprint, createdAt, intent, result } = value;
  if (typeof id !== "string" || !id || typeof type !== "string" || !type || typeof status !== "string" || !status || typeof organizationId !== "string") return null;
  if (fingerprint !== undefined && fingerprint !== null && typeof fingerprint !== "string") return null;
  const created = parseTimestamp(createdAt);
  if (!created) return null;
  return { id, type, status, organizationId, fingerprint: typeof fingerprint === "string" ? fingerprint : null, createdAt: created, intent, result };
}

/** Key-order-insensitive structural equality for JSON-shaped values. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && jsonEqual(a[k], b[k]));
  }
  return false;
}

const isSingleton = (value: unknown, expected: string) => Array.isArray(value) && value.length === 1 && value[0] === expected;

// ---------------------------------------------------------------- 1. local preconditions

type Context = {
  appUserId: string;
  subOrganizationId: string;
  turnkeyUserId: string;
  attempt: ResolutionAttemptRow;
  targetCredentialId: string;
  targetCredentialBytes: Uint8Array;
  targetAuthenticatorId: string;
  /** Every non-revoked, non-target, mapped passkey on the account — each must be present exactly once. */
  controls: Array<{ credentialId: string; authenticatorId: string; status: string }>;
};

function checkLocal(snapshot: ResolutionSnapshot, appUserId: string): { ok: true; context: Context } | Failure {
  const { account, attempt, targetPasskey } = snapshot;
  if (account.appUserId !== appUserId || attempt.appUserId !== appUserId) return fail("not_resolvable_state", "attempt_not_owned_by_account");
  if (attempt.state !== "blocked") return fail("not_resolvable_state", `attempt_state_${attempt.state}`);
  if (!targetPasskey || targetPasskey.appUserId !== appUserId || targetPasskey.credentialId !== attempt.targetCredentialId) return fail("not_resolvable_state", "target_passkey_missing");
  if (targetPasskey.status !== "revoking") return fail("not_resolvable_state", `target_status_${targetPasskey.status}`);
  if (!attempt.targetTurnkeyAuthenticatorId || targetPasskey.turnkeyAuthenticatorId !== attempt.targetTurnkeyAuthenticatorId) return fail("not_resolvable_state", "target_mapping_changed");
  if (snapshot.targetAttempts.some((a) => a.state === "dispatch_in_flight")) return fail("not_resolvable_state", "dispatch_in_flight_exists");
  if (snapshot.hasNewerNonCancelledAttempt) return fail("not_resolvable_state", "newer_attempt_exists");
  for (const enrollment of snapshot.targetEnrollments) {
    if (enrollment.appUserId !== appUserId || (enrollment.state !== "removal_in_progress" && enrollment.state !== "active")) return fail("not_resolvable_state", "enrollment_incompatible");
  }
  const targetCredentialBytes = decodeCredentialId(attempt.targetCredentialId);
  if (!targetCredentialBytes) return fail("inconsistent_manual_review", "target_credential_id_undecodable");

  const controls = snapshot.accountPasskeys
    .filter((p) => p.credentialId !== attempt.targetCredentialId && p.status !== "revoked" && p.turnkeyAuthenticatorId !== null)
    .map((p) => ({ credentialId: p.credentialId, authenticatorId: p.turnkeyAuthenticatorId!, status: p.status }));
  if (!controls.some((c) => c.status === "active")) return fail("not_resolvable_state", "no_other_active_mapped_passkey");
  if (controls.some((c) => c.authenticatorId === attempt.targetTurnkeyAuthenticatorId)) return fail("inconsistent_manual_review", "target_authenticator_mapped_twice");
  if (controls.some((c) => !decodeCredentialId(c.credentialId))) return fail("inconsistent_manual_review", "control_credential_id_undecodable");

  return {
    ok: true,
    context: {
      appUserId,
      subOrganizationId: account.subOrganizationId,
      turnkeyUserId: account.turnkeyUserId,
      attempt,
      targetCredentialId: attempt.targetCredentialId,
      targetCredentialBytes,
      targetAuthenticatorId: attempt.targetTurnkeyAuthenticatorId,
      controls,
    },
  };
}

// ---------------------------------------------------------------- 2. candidate stored DELETE bodies (R2a)

type CandidateBody = { attemptId: string; sha256: string };

/** Only a body WE stored at dispatch, for this exact target, that strictly re-validates and re-hashes, is trusted. Returns null on a duplicate hash (ambiguous). */
function candidateBodies(snapshot: ResolutionSnapshot, context: Context): { candidates: CandidateBody[]; untrusted: number } | null {
  const candidates: CandidateBody[] = [];
  let untrusted = 0;
  for (const row of snapshot.targetAttempts) {
    if (row.appUserId !== context.appUserId || row.targetCredentialId !== context.targetCredentialId || row.targetTurnkeyAuthenticatorId !== context.targetAuthenticatorId) continue;
    if (row.turnkeyRequestBody === null && row.turnkeyRequestBodySha256 === null) continue; // never dispatched
    if (isValidStoredDeleteBody(row, context)) candidates.push({ attemptId: row.id, sha256: row.turnkeyRequestBodySha256! });
    else untrusted += 1;
  }
  if (new Set(candidates.map((c) => c.sha256)).size !== candidates.length) return null;
  return { candidates, untrusted };
}

function isValidStoredDeleteBody(row: ResolutionAttemptRow, context: Context): boolean {
  const body = row.turnkeyRequestBody;
  const storedHash = row.turnkeyRequestBodySha256;
  if (body === null || storedHash === null || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  // Hash the EXACT stored bytes — never a re-serialization.
  if (sha256Hex(body) !== storedHash) return false;
  const parsed = parseSignedBody(body);
  if (!parsed || !hasExactlyKeys(parsed, ["type", "timestampMs", "organizationId", "parameters"])) return false;
  if (parsed.type !== DELETE_TYPE || parsed.organizationId !== context.subOrganizationId || parseTimestampMs(parsed.timestampMs) === null) return false;
  const parameters = parsed.parameters;
  if (!hasExactlyKeys(parameters, ["userId", "authenticatorIds"]) || parameters.userId !== context.turnkeyUserId) return false;
  return isSingleton(parameters.authenticatorIds, context.targetAuthenticatorId);
}

// ---------------------------------------------------------------- 3. the full activity-log walk

type Walk = { ok: true; activities: LedgerActivity[]; headId: string | null };

/**
 * Newest first, 100 per page, older pages via `after` = the last id seen,
 * UNTIL AN EMPTY PAGE (a short page is never taken as the end). Any repeated
 * id, stalled cursor, over-full page, foreign-org row, malformed row,
 * createdAt that increases while walking back, or the page cap => incomplete.
 * Any read error => failed. No partial walk is ever used.
 */
async function walkActivityLog(ledger: TurnkeyReadOnlyLedger, organizationId: string): Promise<Walk | Failure> {
  const activities: LedgerActivity[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  let previous: Timestamp | null = null;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_ACTIVITY_PAGES) return fail("turnkey_read_incomplete", "activity_page_cap_exceeded");
    let response: unknown;
    try {
      response = await ledger.getActivities({ organizationId, paginationOptions: after === undefined ? { limit: String(ACTIVITY_PAGE_LIMIT) } : { limit: String(ACTIVITY_PAGE_LIMIT), after } });
    } catch {
      return fail("turnkey_read_failed", "get_activities_error");
    }
    const rows = isRecord(response) ? response.activities : undefined;
    if (!Array.isArray(rows)) return fail("turnkey_read_failed", "get_activities_malformed");
    if (rows.length === 0) break;
    if (rows.length > ACTIVITY_PAGE_LIMIT) return fail("turnkey_read_incomplete", "activity_page_over_limit");
    for (const row of rows) {
      const activity = parseLedgerActivity(row);
      if (!activity) return fail("turnkey_read_incomplete", "malformed_activity");
      if (activity.organizationId !== organizationId) return fail("turnkey_read_incomplete", "foreign_org_activity");
      if (seen.has(activity.id)) return fail("turnkey_read_incomplete", "repeated_activity_id");
      if (previous && compareTimestamps(activity.createdAt, previous) > 0) return fail("turnkey_read_incomplete", "activity_created_at_increasing");
      seen.add(activity.id);
      previous = activity.createdAt;
      activities.push(activity);
    }
    const last = activities[activities.length - 1]!.id;
    if (last === after) return fail("turnkey_read_incomplete", "activity_cursor_not_advancing");
    after = last;
  }
  return { ok: true, activities, headId: activities[0]?.id ?? null };
}

// ---------------------------------------------------------------- 4. the exact receipt

function isExactDeleteReceipt(activity: LedgerActivity, context: Context): boolean {
  if (activity.organizationId !== context.subOrganizationId || activity.type !== DELETE_TYPE || activity.status !== COMPLETED) return false;
  if (!hasExactlyKeys(activity.intent, ["deleteAuthenticatorsIntent"]) || !hasExactlyKeys(activity.result, ["deleteAuthenticatorsResult"])) return false;
  const intent = activity.intent.deleteAuthenticatorsIntent;
  const result = activity.result.deleteAuthenticatorsResult;
  if (!hasExactlyKeys(intent, ["userId", "authenticatorIds"]) || intent.userId !== context.turnkeyUserId || !isSingleton(intent.authenticatorIds, context.targetAuthenticatorId)) return false;
  return hasExactlyKeys(result, ["authenticatorIds"]) && isSingleton(result.authenticatorIds, context.targetAuthenticatorId);
}

type Receipt = { activity: LedgerActivity; body: CandidateBody; source: ReceiptSource };

function findReceipt(activities: LedgerActivity[], candidates: CandidateBody[], context: Context): { ok: true; receipt: Receipt } | Failure {
  const byHash = new Map(candidates.map((c) => [`sha256:${c.sha256}`, c]));
  const bound = activities.filter((a) => a.fingerprint !== null && byHash.has(a.fingerprint));
  // One stored body must never correspond to more than one Turnkey activity (any type/status).
  const perBody = new Map<string, number>();
  for (const a of bound) perBody.set(a.fingerprint!, (perBody.get(a.fingerprint!) ?? 0) + 1);
  if ([...perBody.values()].some((n) => n > 1)) return fail("inconsistent_manual_review", "stored_body_matches_multiple_activities");
  const receipts = bound.filter((a) => isExactDeleteReceipt(a, context));
  if (receipts.length === 0) return fail("no_receipt", bound.length === 0 ? "no_activity_for_stored_bodies" : "no_exact_completed_receipt");
  if (receipts.length > 1) return fail("inconsistent_manual_review", "multiple_receipts");
  const activity = receipts[0]!;
  const body = byHash.get(activity.fingerprint!)!;
  const ownId = context.attempt.turnkeyActivityId;
  if (ownId !== null && ownId === activity.id) {
    if (body.attemptId !== context.attempt.id) return fail("inconsistent_manual_review", "own_activity_bound_to_another_body");
    return { ok: true, receipt: { activity, body, source: "own_attempt" } };
  }
  // The receipt came from the resolved attempt's OWN body but a different id is recorded on it: contradictory.
  if (body.attemptId === context.attempt.id && ownId !== null) return fail("inconsistent_manual_review", "own_body_receipt_differs_from_recorded_activity");
  return { ok: true, receipt: { activity, body, source: "stored_attempt_body" } };
}

async function rereadReceipt(ledger: TurnkeyReadOnlyLedger, context: Context, listed: LedgerActivity): Promise<{ ok: true } | Failure> {
  let response: unknown;
  try {
    response = await ledger.getActivity({ organizationId: context.subOrganizationId, activityId: listed.id });
  } catch {
    return fail("turnkey_read_failed", "get_activity_error");
  }
  const reread = parseLedgerActivity(isRecord(response) ? response.activity : undefined);
  if (!reread) return fail("turnkey_read_failed", "get_activity_malformed");
  const same =
    reread.id === listed.id &&
    reread.organizationId === listed.organizationId &&
    reread.type === listed.type &&
    reread.status === listed.status &&
    reread.fingerprint === listed.fingerprint &&
    compareTimestamps(reread.createdAt, listed.createdAt) === 0 &&
    jsonEqual(reread.intent, listed.intent) &&
    jsonEqual(reread.result, listed.result);
  return same ? { ok: true } : fail("inconsistent_manual_review", "receipt_reread_mismatch");
}

// ---------------------------------------------------------------- 5. later authenticator authority

/**
 * Every activity type whose intent can register a WebAuthn authenticator —
 * enumerated from @turnkey/http 6.5.0's generated schema (every v1Intent
 * member that transitively contains v1AuthenticatorParams /
 * v1AuthenticatorParamsV2). API keys, sessions, OTP/OAuth/email auth never
 * register a WebAuthn credential, so they cannot restore THIS credential's
 * authority.
 */
export const AUTHORITY_ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  "ACTIVITY_TYPE_CREATE_AUTHENTICATORS",
  "ACTIVITY_TYPE_CREATE_AUTHENTICATORS_V2",
  "ACTIVITY_TYPE_CREATE_USERS",
  "ACTIVITY_TYPE_CREATE_USERS_V2",
  "ACTIVITY_TYPE_CREATE_USERS_V3",
  "ACTIVITY_TYPE_CREATE_USERS_V4",
  "ACTIVITY_TYPE_ACCEPT_INVITATION",
  "ACTIVITY_TYPE_ACCEPT_INVITATION_V2",
  "ACTIVITY_TYPE_RECOVER_USER",
  "ACTIVITY_TYPE_CREATE_ORGANIZATION",
  "ACTIVITY_TYPE_CREATE_ORGANIZATION_V2",
  "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION",
  "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V2",
  "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V3",
  "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V4",
  "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V5",
  "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V6",
  "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V7",
  "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V8",
]);

/** v1AuthenticatorParams: the credential id is attestation.id AND attestation.rawId (both must decode). */
function credentialsFromParamsV1(params: unknown): string[] | null {
  if (!isRecord(params) || !isRecord(params.attestation)) return null;
  const { id, rawId } = params.attestation;
  return typeof id === "string" && typeof rawId === "string" ? [id, rawId] : null;
}

/** v1AuthenticatorParamsV2: the credential id is attestation.credentialId. */
function credentialsFromParamsV2(params: unknown): string[] | null {
  if (!isRecord(params) || !isRecord(params.attestation)) return null;
  const { credentialId } = params.attestation;
  return typeof credentialId === "string" ? [credentialId] : null;
}

function fromList(list: unknown, each: (params: unknown) => string[] | null): string[] | null {
  if (!Array.isArray(list)) return null;
  const out: string[] = [];
  for (const params of list) {
    const ids = each(params);
    if (!ids) return null;
    out.push(...ids);
  }
  return out;
}

/** users[].authenticators[] / rootUsers[].authenticators[] — a user without an authenticators array is malformed, not "none". */
function fromUsers(users: unknown, each: (params: unknown) => string[] | null): string[] | null {
  if (!Array.isArray(users)) return null;
  const out: string[] = [];
  for (const user of users) {
    if (!isRecord(user)) return null;
    const ids = fromList(user.authenticators, each);
    if (!ids) return null;
    out.push(...ids);
  }
  return out;
}

/** Explicit per-intent parsers (paths from the SDK schema). Each returns every credential id the intent registers, or null if malformed. */
const AUTHORITY_INTENT_PARSERS: Record<string, (intent: Record<string, unknown>) => string[] | null> = {
  createOrganizationIntent: (i) => credentialsFromParamsV1(i.rootAuthenticator),
  createOrganizationIntentV2: (i) => credentialsFromParamsV2(i.rootAuthenticator),
  createAuthenticatorsIntent: (i) => fromList(i.authenticators, credentialsFromParamsV1),
  createAuthenticatorsIntentV2: (i) => fromList(i.authenticators, credentialsFromParamsV2),
  createUsersIntent: (i) => fromUsers(i.users, credentialsFromParamsV1),
  createUsersIntentV2: (i) => fromUsers(i.users, credentialsFromParamsV2),
  createUsersIntentV3: (i) => fromUsers(i.users, credentialsFromParamsV2),
  createUsersIntentV4: (i) => fromUsers(i.users, credentialsFromParamsV2),
  acceptInvitationIntent: (i) => credentialsFromParamsV1(i.authenticator),
  acceptInvitationIntentV2: (i) => credentialsFromParamsV2(i.authenticator),
  recoverUserIntent: (i) => credentialsFromParamsV2(i.authenticator),
  createSubOrganizationIntent: (i) => credentialsFromParamsV2(i.rootAuthenticator),
  createSubOrganizationIntentV2: (i) => fromUsers(i.rootUsers, credentialsFromParamsV2),
  createSubOrganizationIntentV3: (i) => fromUsers(i.rootUsers, credentialsFromParamsV2),
  createSubOrganizationIntentV4: (i) => fromUsers(i.rootUsers, credentialsFromParamsV2),
  createSubOrganizationIntentV5: (i) => fromUsers(i.rootUsers, credentialsFromParamsV2),
  createSubOrganizationIntentV6: (i) => fromUsers(i.rootUsers, credentialsFromParamsV2),
  createSubOrganizationIntentV7: (i) => fromUsers(i.rootUsers, credentialsFromParamsV2),
  createSubOrganizationIntentV8: (i) => fromUsers(i.rootUsers, credentialsFromParamsV2),
};

/** Field names that only appear where an authenticator is being registered — seen under an UNKNOWN intent, the shape is unrecognized authority. */
const AUTHORITY_FIELD_NAMES = new Set(["attestation", "authenticator", "authenticators", "rootAuthenticator"]);

function containsAuthorityField(value: unknown, depth = 0): boolean {
  if (depth > 32) return true; // unreasonably deep: treat as unrecognized, fail closed
  if (Array.isArray(value)) return value.some((v) => containsAuthorityField(v, depth + 1));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, v]) => AUTHORITY_FIELD_NAMES.has(key) || containsAuthorityField(v, depth + 1));
}

function containsString(value: unknown, needle: string, depth = 0): boolean {
  if (depth > 32) return true;
  if (value === needle) return true;
  if (Array.isArray(value)) return value.some((v) => containsString(v, needle, depth + 1));
  return isRecord(value) && Object.values(value).some((v) => containsString(v, needle, depth + 1));
}

/**
 * Refuses if any activity at OR AFTER the receipt's server createdAt (same
 * second counts — createdAt is whole seconds on the live API) could have
 * re-granted authority to the target id or credential bytes, or can't be
 * parsed well enough to rule that out. Every status counts: a pending create
 * may still complete.
 */
function checkLaterAuthority(activities: LedgerActivity[], receipt: LedgerActivity, context: Context): { ok: true } | Failure {
  for (const activity of activities) {
    if (activity.id === receipt.id || activity.createdAt.seconds < receipt.createdAt.seconds) continue;
    const intentKeys = isRecord(activity.intent) ? Object.keys(activity.intent) : [];
    const knownKeys = intentKeys.filter((k) => k in AUTHORITY_INTENT_PARSERS);
    const bearing = AUTHORITY_ACTIVITY_TYPES.has(activity.type) || knownKeys.length > 0;
    if (!bearing) {
      if (containsAuthorityField(activity.intent)) return fail("inconsistent_manual_review", "unrecognized_authority_shape_after_receipt");
      continue;
    }
    if (!isRecord(activity.intent) || intentKeys.length !== 1 || knownKeys.length !== 1) return fail("inconsistent_manual_review", "malformed_authority_activity_after_receipt");
    const intent = activity.intent[knownKeys[0]!];
    const credentialIds = isRecord(intent) ? AUTHORITY_INTENT_PARSERS[knownKeys[0]!]!(intent) : null;
    if (!credentialIds || credentialIds.some((id) => !decodeCredentialId(id))) return fail("inconsistent_manual_review", "malformed_authority_activity_after_receipt");
    if (credentialIds.some((id) => credentialIdsEqual(id, context.targetCredentialId))) return fail("inconsistent_manual_review", "target_credential_readded_after_receipt");
    if (containsString(activity.intent, context.targetAuthenticatorId) || containsString(activity.result, context.targetAuthenticatorId)) {
      return fail("inconsistent_manual_review", "target_authenticator_readded_after_receipt");
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------- 6. absence

type AuthenticatorView = { authenticatorId: string; credentialId: string; bytes: string };

function parseAuthenticators(value: unknown): AuthenticatorView[] | null {
  if (!Array.isArray(value)) return null;
  const out: AuthenticatorView[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.authenticatorId !== "string" || !item.authenticatorId) return null;
    const bytes = decodeCredentialId(item.credentialId);
    if (!bytes) return null;
    out.push({ authenticatorId: item.authenticatorId, credentialId: item.credentialId as string, bytes: Buffer.from(bytes).toString("hex") });
  }
  return out;
}

type Absence = { ok: true; survivorAuthenticatorIds: string[] };

async function observeAbsence(ledger: TurnkeyReadOnlyLedger, context: Context): Promise<Absence | Failure> {
  let usersResponse: unknown;
  let authenticatorsResponse: unknown;
  try {
    usersResponse = await ledger.getUsers({ organizationId: context.subOrganizationId });
    authenticatorsResponse = await ledger.getAuthenticators({ organizationId: context.subOrganizationId, userId: context.turnkeyUserId });
  } catch {
    return fail("turnkey_read_failed", "authenticator_read_error");
  }
  const users = isRecord(usersResponse) ? usersResponse.users : undefined;
  if (!Array.isArray(users)) return fail("turnkey_read_failed", "get_users_malformed");
  const parsedUsers: Array<{ userId: string; authenticators: AuthenticatorView[] }> = [];
  for (const user of users) {
    if (!isRecord(user) || typeof user.userId !== "string" || !user.userId) return fail("turnkey_read_failed", "get_users_malformed");
    const authenticators = parseAuthenticators(user.authenticators);
    if (!authenticators) return fail("turnkey_read_failed", "get_users_malformed");
    parsedUsers.push({ userId: user.userId, authenticators });
  }
  const accountUsers = parsedUsers.filter((u) => u.userId === context.turnkeyUserId);
  if (accountUsers.length !== 1) return fail("inconsistent_manual_review", accountUsers.length === 0 ? "account_user_missing" : "account_user_duplicated");
  const fromUsers = accountUsers[0]!.authenticators;
  const fromAuthenticators = parseAuthenticators(isRecord(authenticatorsResponse) ? authenticatorsResponse.authenticators : undefined);
  if (!fromAuthenticators) return fail("turnkey_read_failed", "get_authenticators_malformed");

  // The two views of the account user must agree EXACTLY (as multisets).
  const key = (a: AuthenticatorView) => `${a.authenticatorId}|${a.bytes}`;
  const left = fromUsers.map(key).sort();
  const right = fromAuthenticators.map(key).sort();
  if (left.length !== right.length || left.some((k, i) => k !== right[i])) return fail("inconsistent_manual_review", "authenticator_views_disagree");
  if (new Set(fromUsers.map((a) => a.authenticatorId)).size !== fromUsers.length) return fail("inconsistent_manual_review", "duplicate_authenticator_id");
  if (new Set(fromUsers.map((a) => a.bytes)).size !== fromUsers.length) return fail("inconsistent_manual_review", "duplicate_credential_bytes");

  // The target must appear NOWHERE — under any user, by id or by credential bytes.
  const targetBytes = Buffer.from(context.targetCredentialBytes).toString("hex");
  for (const user of parsedUsers) {
    if (user.authenticators.some((a) => a.authenticatorId === context.targetAuthenticatorId)) return fail("target_still_present", "target_authenticator_id_present");
    if (user.authenticators.some((a) => a.bytes === targetBytes)) return fail("target_still_present", "target_credential_bytes_present");
  }

  // Positive controls: every non-revoked mapped passkey is present exactly once, bytes exact.
  for (const control of context.controls) {
    const matches = fromUsers.filter((a) => a.authenticatorId === control.authenticatorId);
    if (matches.length !== 1) return fail("inconsistent_manual_review", "expected_authenticator_missing");
    if (!credentialIdsEqual(matches[0]!.credentialId, control.credentialId)) return fail("inconsistent_manual_review", "expected_authenticator_credential_mismatch");
  }
  if (fromUsers.some((a) => !context.controls.some((c) => c.authenticatorId === a.authenticatorId))) return fail("inconsistent_manual_review", "unexplained_authenticator");
  return { ok: true, survivorAuthenticatorIds: context.controls.map((c) => c.authenticatorId).sort() };
}

// ---------------------------------------------------------------- 7. head freshness

async function readHead(ledger: TurnkeyReadOnlyLedger, organizationId: string): Promise<{ ok: true; headId: string | null } | Failure> {
  let response: unknown;
  try {
    response = await ledger.getActivities({ organizationId, paginationOptions: { limit: "1" } });
  } catch {
    return fail("turnkey_read_failed", "head_read_error");
  }
  const rows = isRecord(response) ? response.activities : undefined;
  if (!Array.isArray(rows) || rows.length > 1) return fail("turnkey_read_failed", "head_read_malformed");
  if (rows.length === 0) return { ok: true, headId: null };
  const head = parseLedgerActivity(rows[0]);
  return head ? { ok: true, headId: head.id } : fail("turnkey_read_failed", "head_read_malformed");
}

// ---------------------------------------------------------------- orchestration

/**
 * Read local state -> read Turnkey (no DB lock held; Neon's HTTP driver
 * can't hold one across a network call anyway) -> ONE account-locked,
 * fully re-checked commit, only when `commit` is true. A dry run performs
 * every read and check and writes nothing.
 */
export async function resolveBlockedRevocation(input: {
  store: RevocationResolutionStore;
  ledger: TurnkeyReadOnlyLedger;
  appUserId: string;
  revocationAttemptId: string;
  commit: boolean;
  now?: () => number;
}): Promise<ResolverReport> {
  const now = input.now ?? Date.now;
  const report = (outcome: ResolverOutcome, reason: string, evidence?: ResolverEvidence): ResolverReport => ({ outcome, reason, committed: outcome === "resolved", ...(evidence ? { evidence } : {}) });
  const refuse = (f: Failure) => report(f.outcome, f.reason);

  if (!isValidUuid(input.appUserId) || !isValidUuid(input.revocationAttemptId)) return report("not_resolvable_state", "invalid_identifier");
  const snapshot = await input.store.loadSnapshot({ appUserId: input.appUserId, attemptId: input.revocationAttemptId });
  if (!snapshot) return report("not_resolvable_state", "unknown_account_or_attempt");
  if (snapshot.attempt.appUserId === input.appUserId && snapshot.attempt.state === "confirmed" && snapshot.existingResolutionId) return report("already_resolved", "resolution_exists");

  const local = checkLocal(snapshot, input.appUserId);
  if (!local.ok) return refuse(local);
  const context = local.context;

  const bodies = candidateBodies(snapshot, context);
  if (!bodies) return report("inconsistent_manual_review", "duplicate_stored_body_hash");
  if (bodies.candidates.length === 0) return report("no_receipt", "no_trusted_stored_delete_body");

  const walk = await walkActivityLog(input.ledger, context.subOrganizationId);
  if (!walk.ok) return refuse(walk);
  if (walk.headId === null) return report("no_receipt", "empty_activity_log");

  const found = findReceipt(walk.activities, bodies.candidates, context);
  if (!found.ok) return refuse(found);
  const { receipt } = found;
  const reread = await rereadReceipt(input.ledger, context, receipt.activity);
  if (!reread.ok) return refuse(reread);

  const later = checkLaterAuthority(walk.activities, receipt.activity, context);
  if (!later.ok) return refuse(later);

  const first = await observeAbsence(input.ledger, context);
  if (!first.ok) return refuse(first);
  const absenceFirstObservedAt = new Date(now()).toISOString();

  // Immediately before the commit phase: a SECOND full snapshot (no sleep is a safety predicate), then the head.
  const second = await observeAbsence(input.ledger, context);
  if (!second.ok) return refuse(second);
  const absenceLastObservedAt = new Date(now()).toISOString();
  if (second.survivorAuthenticatorIds.join(",") !== first.survivorAuthenticatorIds.join(",")) return report("inconsistent_manual_review", "absence_snapshots_differ");

  const head = await readHead(input.ledger, context.subOrganizationId);
  if (!head.ok) return refuse(head);
  if (head.headId !== walk.headId) return report("activity_log_changed", "activity_head_moved_rerun_required");

  const evidence: ResolverEvidence = {
    receiptActivityId: receipt.activity.id,
    receiptSource: receipt.source,
    receiptBodyAttemptId: receipt.body.attemptId,
    receiptTurnkeyCreatedAt: timestampToIso(receipt.activity.createdAt),
    activityLogHeadId: walk.headId,
    activitiesScanned: walk.activities.length,
    survivorAuthenticatorIds: second.survivorAuthenticatorIds,
    absenceFirstObservedAt,
    absenceLastObservedAt,
  };
  if (!input.commit) return report("resolvable_dry_run", "all_evidence_satisfied_no_write", evidence);

  const committed = await input.store.commitResolution({
    appUserId: context.appUserId,
    attemptId: context.attempt.id,
    targetCredentialId: context.targetCredentialId,
    targetTurnkeyAuthenticatorId: context.targetAuthenticatorId,
    expected: { turnkeyActivityId: context.attempt.turnkeyActivityId, turnkeyActivityStatus: context.attempt.turnkeyActivityStatus, failureReason: context.attempt.failureReason },
    receipt: { activityId: receipt.activity.id, source: receipt.source, bodyAttemptId: receipt.body.attemptId, bodySha256: receipt.body.sha256, turnkeyCreatedAt: evidence.receiptTurnkeyCreatedAt },
    activityLogHeadId: walk.headId,
    absenceFirstObservedAt,
    absenceLastObservedAt,
    survivorAuthenticatorIds: second.survivorAuthenticatorIds,
    resolverVersion: RESOLVER_VERSION,
  });
  if (committed.outcome === "committed") return report("resolved", "committed", evidence);
  const after = await input.store.loadSnapshot({ appUserId: input.appUserId, attemptId: input.revocationAttemptId });
  if (after?.attempt.state === "confirmed" && after.existingResolutionId) return report("already_resolved", "resolved_concurrently");
  return report("lost_race", "local_state_changed_before_commit");
}

/** Operator output: truncated identifiers only — never bodies, stamps, keys, or credentials. */
export function redactReport(report: ResolverReport): Record<string, unknown> {
  const short = (value: string) => `${value.slice(0, 8)}…`;
  const evidence = report.evidence;
  return {
    outcome: report.outcome,
    reason: report.reason,
    committed: report.committed,
    ...(evidence
      ? {
          receiptActivity: short(evidence.receiptActivityId),
          receiptSource: evidence.receiptSource,
          receiptBodyAttempt: short(evidence.receiptBodyAttemptId),
          receiptTurnkeyCreatedAt: evidence.receiptTurnkeyCreatedAt,
          activityLogHead: short(evidence.activityLogHeadId),
          activitiesScanned: evidence.activitiesScanned,
          survivors: evidence.survivorAuthenticatorIds.map(short),
          absenceFirstObservedAt: evidence.absenceFirstObservedAt,
          absenceLastObservedAt: evidence.absenceLastObservedAt,
        }
      : {}),
  };
}
