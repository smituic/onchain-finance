import { credentialIdsEqual } from "../credential-id";
import { isValidUuid } from "../identifiers";
import type { RealAccountRecord, RealAccountRegistry } from "./registry";
import type { RealServerConfig } from "./config";
import type { PasskeyRevocationAttempt, PasskeyRevocationStore } from "./passkey-revocation-attempts";
import { listTurnkeyUserAuthenticators, readTurnkeyActivity, type TurnkeyUserAuthenticator } from "./turnkey-discovery";
import {
  COMPLETED_STATUS,
  TERMINAL_FAILURE_STATUSES,
  forwardSignedRequest,
  hasExactlyKeys,
  isExpectedEndpointUrl,
  isFreshTimestamp,
  parseSignedBody,
  parseSignedTurnkeyRequest,
  parseTimestampMs,
  resolveDispatchDeps,
  sha256Hex,
  verifyStampAuthorizedBy,
  type TurnkeyActivitySummary,
  type TurnkeyDispatchDeps,
  type TurnkeyStamp,
} from "./turnkey-signed-request";

/**
 * Passkey removal. APP DISABLED != TURNKEY REMOVED:
 *
 *   - The surviving authorizer is ALWAYS the caller's session credential
 *     (never client-selected). Removing the credential you're signed in
 *     with requires signing in with another one first.
 *   - Targets: an 'active' mapped passkey; (2g-H) a 'pending' backup whose
 *     Turnkey authenticator is already confirmed — it may already authorize,
 *     so an unfinished setup must never strand it (its dispatch moves the
 *     enrollment to 'removal_in_progress': activation impossible, slot still
 *     held; confirmDeleted makes it 'removed'); or (2g-H) a 'revoking' target
 *     whose earlier removal blocked — a NEW user-authorized retry.
 *   - prepare only records an 'authorization_needed' attempt: the target
 *     keeps its status. An app cookie alone can never disable a credential.
 *   - The survivor stamps the exact DELETE_AUTHENTICATORS body in the
 *     browser. This server verifies body/URL/stamp authorship FIRST, then
 *     in ONE per-account-locked transaction re-checks the survivor, records
 *     the exact request as dispatched, and disables the target's app login
 *     ('revoking') — committed before the bytes are raw-forwarded.
 *   - 'revoked' requires BOTH a COMPLETED delete activity naming exactly the
 *     target authenticator AND a subsequent read showing it absent. A
 *     discovery miss alone is never a deletion receipt.
 *   - ONE-WAY AFTER DISPATCH. Once a verified signed delete is accepted, the
 *     browser holds bytes it could send to Turnkey itself, so nothing we
 *     observe proves the target wasn't deleted. A dispatched target is NEVER
 *     automatically restored to 'active' — not on FAILED/REJECTED, not on a
 *     missing activity id, not on a positive getUsers read. Every outcome
 *     other than a confirmed deletion is 'blocked' for review: target stays
 *     'revoking', never claimed Removed, never retried automatically (the
 *     user may authorize a NEW attempt with a fresh survivor stamp). Before
 *     dispatch (cancelled prompt, refused stamp/body) the target stays active.
 */
const DELETE_ACTIVITY_TYPE = "ACTIVITY_TYPE_DELETE_AUTHENTICATORS";

function expectedDeleteActivity(account: RealAccountRecord, attempt: PasskeyRevocationAttempt, timestampMs: string) {
  return {
    type: DELETE_ACTIVITY_TYPE,
    timestampMs,
    organizationId: account.subOrganizationId,
    parameters: { userId: account.turnkeyUserId, authenticatorIds: [attempt.targetTurnkeyAuthenticatorId] },
  };
}

async function loadOwnedAttempt(input: { revocations: PasskeyRevocationStore; appUserId: string; credentialId: string; attemptId: string }): Promise<PasskeyRevocationAttempt | null> {
  if (!isValidUuid(input.attemptId)) return null;
  const attempt = await input.revocations.findById(input.attemptId);
  if (!attempt || attempt.appUserId !== input.appUserId || attempt.targetCredentialId !== input.credentialId) return null;
  return attempt;
}

export type PrepareRevocationResult =
  | { outcome: "ready"; attemptId: string; activity: ReturnType<typeof expectedDeleteActivity>; rpId: string; authorizingCredentialId: string }
  | { outcome: "rejected"; reason: string; code: "sign_in_with_other_passkey" | "not_removable" | "authorizer_not_eligible" | "removal_in_progress" };

export async function prepareRevocation(input: {
  config: RealServerConfig;
  registry: RealAccountRegistry;
  revocations: PasskeyRevocationStore;
  appUserId: string;
  credentialId: string;
  sessionCredentialId: string;
  now?: () => number;
}): Promise<PrepareRevocationResult> {
  const now = input.now ?? Date.now;
  if (credentialIdsEqual(input.credentialId, input.sessionCredentialId) || input.credentialId === input.sessionCredentialId) {
    return { outcome: "rejected", code: "sign_in_with_other_passkey", reason: "Sign in with a different passkey to remove this one." };
  }
  const account = await input.registry.findAccountByAppUserId(input.appUserId);
  if (!account) return { outcome: "rejected", code: "not_removable", reason: "No account found for this session." };

  // Re-offer this session's own undispatched authorization instead of piling up new ones.
  const latest = (await input.revocations.findLatestPerTarget(input.appUserId)).find((a) => a.targetCredentialId === input.credentialId);
  let attempt: PasskeyRevocationAttempt | null = latest?.state === "authorization_needed" && latest.authorizerCredentialId === input.sessionCredentialId ? latest : null;
  if (!attempt) {
    const prepared = await input.revocations.prepare({ appUserId: input.appUserId, targetCredentialId: input.credentialId, authorizerCredentialId: input.sessionCredentialId });
    if (!prepared.ok) {
      if (prepared.reason === "removal_in_progress") return { outcome: "rejected", code: "removal_in_progress", reason: "A removal for this passkey is already in progress." };
      if (prepared.reason === "authorizer_not_eligible") return { outcome: "rejected", code: "authorizer_not_eligible", reason: "The passkey you're signed in with can't authorize removals yet." };
      return { outcome: "rejected", code: "not_removable", reason: "This passkey can't be removed right now." };
    }
    attempt = prepared.attempt;
  }
  return {
    outcome: "ready",
    attemptId: attempt!.id,
    activity: expectedDeleteActivity(account, attempt!, String(now())),
    rpId: input.config.rpId,
    authorizingCredentialId: attempt!.authorizerCredentialId,
  };
}

function validateDeleteBody(body: string, account: RealAccountRecord, attempt: PasskeyRevocationAttempt): number | null {
  const parsed = parseSignedBody(body);
  if (!parsed || !hasExactlyKeys(parsed, ["type", "timestampMs", "organizationId", "parameters"])) return null;
  if (parsed.type !== DELETE_ACTIVITY_TYPE || parsed.organizationId !== account.subOrganizationId) return null;
  const timestampMs = parseTimestampMs(parsed.timestampMs);
  if (timestampMs === null) return null;
  const parameters = parsed.parameters;
  if (!hasExactlyKeys(parameters, ["userId", "authenticatorIds"]) || parameters.userId !== account.turnkeyUserId) return null;
  const ids = parameters.authenticatorIds;
  if (!Array.isArray(ids) || ids.length !== 1 || ids[0] !== attempt.targetTurnkeyAuthenticatorId) return null;
  return timestampMs;
}

export type ReconcileRevocationResult =
  | { outcome: "revoked" }
  | { outcome: "pending"; reason: string }
  | { outcome: "authorization_needed"; reason: string }
  | { outcome: "cancelled" }
  | { outcome: "blocked"; reason: string }
  | { outcome: "rejected"; reason: string };

export async function submitRevocation(input: {
  config: RealServerConfig;
  registry: RealAccountRegistry;
  revocations: PasskeyRevocationStore;
  appUserId: string;
  credentialId: string;
  attemptId: string;
  sessionCredentialId: string;
  signedRequest: unknown;
  deps?: TurnkeyDispatchDeps;
}): Promise<ReconcileRevocationResult> {
  const { now } = resolveDispatchDeps(input.deps);
  const attempt = await loadOwnedAttempt(input);
  if (!attempt) return { outcome: "rejected", reason: "Unknown removal." };
  if (attempt.state !== "authorization_needed") return { outcome: "rejected", reason: "This removal was already submitted — check its status instead." };
  if (attempt.authorizerCredentialId !== input.sessionCredentialId) return { outcome: "rejected", reason: "This removal must be authorized by the passkey that started it." };

  const account = await input.registry.findAccountByAppUserId(input.appUserId);
  if (!account) return { outcome: "rejected", reason: "No account found for this session." };
  const authorizer = await input.registry.findPasskeyByCredentialId(attempt.authorizerCredentialId);
  if (!authorizer || authorizer.appUserId !== input.appUserId || authorizer.status !== "active" || !authorizer.turnkeyAuthenticatorId) {
    return { outcome: "rejected", reason: "The authorizing passkey is no longer active." };
  }

  const signed = parseSignedTurnkeyRequest(input.signedRequest);
  if (!signed || !isExpectedEndpointUrl(input.config, "delete_authenticators", signed.url)) return { outcome: "rejected", reason: "The signed request is not acceptable." };
  const timestampMs = validateDeleteBody(signed.body, account, attempt);
  if (timestampMs === null) return { outcome: "rejected", reason: "The signed request does not match this removal." };
  if (!isFreshTimestamp(timestampMs, now())) return { outcome: "rejected", reason: "The signed request has expired. Please authorize again." };
  const stampCheck = await verifyStampAuthorizedBy({ config: input.config, body: signed.body, stamp: signed.stamp, credential: authorizer });
  if (!stampCheck.ok) return { outcome: "rejected", reason: "The authorization wasn't signed by your current passkey." };

  // Only now — stamp and body verified — does anything change passkey
  // status: one locked transaction re-checks the survivor, records the exact
  // request, and disables the target's app login, committed before the POST.
  const claimed = await input.revocations.beginDispatch({
    id: attempt.id,
    patch: {
      turnkeyRequestBody: signed.body,
      turnkeyRequestBodySha256: sha256Hex(signed.body),
      turnkeyRequestTimestampMs: timestampMs,
      turnkeyRequestStamp: JSON.stringify(signed.stamp),
      externalAttemptedAt: new Date(now()).toISOString(),
    },
  });
  if (!claimed) return { outcome: "rejected", reason: "This removal can't proceed: it was already submitted, it needs a fresh approval, or your passkey or this one changed. Check status and try again." };
  await input.registry.updateAuthenticatorCounter({ credentialId: authorizer.credentialId, counter: stampCheck.newCounter });

  const forwarded = await forwardSignedRequest({ config: input.config, endpoint: "delete_authenticators", body: signed.body, stamp: signed.stamp, fetchImpl: input.deps?.fetchImpl });
  if (forwarded.kind === "activity") {
    await input.revocations.recordActivity({ id: claimed.id, activityId: forwarded.activity.id, activityStatus: forwarded.activity.status });
  }
  return reconcileRevocation(input);
}

function isPresent(authenticators: TurnkeyUserAuthenticator[], attempt: PasskeyRevocationAttempt): boolean {
  return authenticators.some((a) => a.authenticatorId === attempt.targetTurnkeyAuthenticatorId || credentialIdsEqual(a.credentialId, attempt.targetCredentialId));
}

function deleteResultIsExactlyTarget(activity: TurnkeyActivitySummary, attempt: PasskeyRevocationAttempt): boolean {
  const result = activity.raw.result as { deleteAuthenticatorsResult?: { authenticatorIds?: unknown } } | undefined;
  const ids = result?.deleteAuthenticatorsResult?.authenticatorIds;
  return Array.isArray(ids) && ids.length === 1 && ids[0] === attempt.targetTurnkeyAuthenticatorId;
}

const STILL_MAY_AUTHORIZE = "This passkey may still be able to authorize this account until removal is confirmed.";
const NOT_AUTHORIZED = "Removal hasn't been authorized yet — this passkey is still fully active.";
const PENDING = `Removal submitted, not yet confirmed. ${STILL_MAY_AUTHORIZE}`;
const NEEDS_REVIEW = `Sign-in with this passkey stays off. ${STILL_MAY_AUTHORIZE}`;
const BLOCKED_REASONS: Record<string, string> = {
  no_activity_receipt: `We couldn't confirm whether this removal reached Turnkey; manual review is required. ${NEEDS_REVIEW}`,
  delete_activity_failed: `Turnkey reported this removal as not completed, but that can't prove the passkey wasn't removed another way; manual review is required. ${NEEDS_REVIEW}`,
  activity_mismatch: `The Turnkey activity doesn't match this removal; manual review is required. ${NEEDS_REVIEW}`,
  delete_result_mismatch: `Turnkey's removal result doesn't name this passkey; manual review is required. ${NEEDS_REVIEW}`,
};

/** The truthful result for an attempt's CURRENT durable state — also used after losing a race to a concurrent reconcile. */
function describeAttempt(attempt: PasskeyRevocationAttempt): ReconcileRevocationResult {
  if (attempt.state === "confirmed") return { outcome: "revoked" };
  if (attempt.state === "cancelled") return { outcome: "cancelled" };
  if (attempt.state === "blocked") return { outcome: "blocked", reason: BLOCKED_REASONS[attempt.failureReason ?? ""] ?? `This removal needs manual review. ${NEEDS_REVIEW}` };
  if (attempt.state === "authorization_needed") return { outcome: "authorization_needed", reason: NOT_AUTHORIZED };
  return { outcome: "pending", reason: PENDING };
}

async function blockAttempt(revocations: PasskeyRevocationStore, attempt: PasskeyRevocationAttempt, failureReason: string): Promise<ReconcileRevocationResult> {
  const blocked = await revocations.transition({ id: attempt.id, from: "dispatch_in_flight", to: "blocked", patch: { failureReason, turnkeyRequestStamp: null } });
  return describeAttempt(blocked ?? (await revocations.findById(attempt.id)) ?? attempt);
}

/** After a lost CAS the other writer's outcome is the truth — report it, never a guess. */
async function describeLatest(revocations: PasskeyRevocationStore, attempt: PasskeyRevocationAttempt): Promise<ReconcileRevocationResult> {
  return describeAttempt((await revocations.findById(attempt.id)) ?? attempt);
}

/**
 * Reconciles an in-flight removal using only: a byte-identical replay while
 * fresh (never a re-stamp), read-only getActivity polling, and read-only
 * getUsers. Exactly two exits from 'dispatch_in_flight': 'confirmed' (BOTH
 * halves of the deletion evidence) or 'blocked'. Never back to 'active'.
 * Every state change is a CAS from 'dispatch_in_flight', so concurrent
 * reconciles converge on whichever outcome committed first.
 */
export async function reconcileRevocation(input: {
  config: RealServerConfig;
  registry: RealAccountRegistry;
  revocations: PasskeyRevocationStore;
  appUserId: string;
  credentialId: string;
  attemptId: string;
  deps?: TurnkeyDispatchDeps;
}): Promise<ReconcileRevocationResult> {
  const deps = resolveDispatchDeps(input.deps);
  let attempt = await loadOwnedAttempt(input);
  if (!attempt) return { outcome: "rejected", reason: "Unknown removal." };
  if (attempt.state !== "dispatch_in_flight") return describeAttempt(attempt);

  const account = await input.registry.findAccountByAppUserId(input.appUserId);
  if (!account) return { outcome: "rejected", reason: "No account found for this session." };
  const readAuthenticators = () => listTurnkeyUserAuthenticators({ config: input.config, subOrganizationId: account.subOrganizationId, turnkeyUserId: account.turnkeyUserId });

  if (!attempt.turnkeyActivityId) {
    const fresh = attempt.turnkeyRequestTimestampMs !== null && isFreshTimestamp(attempt.turnkeyRequestTimestampMs, deps.now());
    if (fresh && attempt.turnkeyRequestBody && attempt.turnkeyRequestStamp) {
      const stamp = JSON.parse(attempt.turnkeyRequestStamp) as TurnkeyStamp;
      const replayed = await forwardSignedRequest({ config: input.config, endpoint: "delete_authenticators", body: attempt.turnkeyRequestBody, stamp, fetchImpl: deps.fetchImpl });
      if (replayed.kind === "activity") {
        await input.revocations.recordActivity({ id: attempt.id, activityId: replayed.activity.id, activityStatus: replayed.activity.status });
      }
    } else if (!fresh && attempt.turnkeyRequestStamp) {
      await input.revocations.transition({ id: attempt.id, from: "dispatch_in_flight", to: "dispatch_in_flight", patch: { turnkeyRequestStamp: null } });
    }
    attempt = (await input.revocations.findById(attempt.id)) ?? attempt;
    if (attempt.state !== "dispatch_in_flight") return describeAttempt(attempt);

    if (!attempt.turnkeyActivityId) {
      if (fresh) return { outcome: "pending", reason: PENDING };
      // The request can no longer be replayed and never yielded an activity
      // id. It may have landed (response lost) — a getUsers read showing the
      // target present may simply be stale, and a miss is no receipt. The
      // outcome is unknowable from here: review, never Active, never Removed.
      return blockAttempt(input.revocations, attempt, "no_activity_receipt");
    }
  }

  let activity: TurnkeyActivitySummary | null = null;
  for (let poll = 0; poll < deps.maxPolls; poll += 1) {
    if (poll > 0) await deps.sleep(deps.pollIntervalMs);
    activity = await readTurnkeyActivity({ config: input.config, subOrganizationId: account.subOrganizationId, activityId: attempt.turnkeyActivityId! });
    if (activity && (activity.status === COMPLETED_STATUS || TERMINAL_FAILURE_STATUSES.has(activity.status))) break;
  }
  if (!activity) return { outcome: "pending", reason: PENDING };
  if (activity.id !== attempt.turnkeyActivityId || activity.organizationId !== account.subOrganizationId || activity.type !== DELETE_ACTIVITY_TYPE) {
    return blockAttempt(input.revocations, attempt, "activity_mismatch");
  }
  if (activity.status !== attempt.turnkeyActivityStatus) {
    await input.revocations.transition({ id: attempt.id, from: "dispatch_in_flight", to: "dispatch_in_flight", patch: { turnkeyActivityStatus: activity.status } });
  }

  if (TERMINAL_FAILURE_STATUSES.has(activity.status)) {
    // This activity failed, but the same signed bytes may have reached Turnkey
    // another way (a lost original, a concurrent replay, or the browser
    // itself) — and a positive getUsers read may be stale. Not a restore signal.
    return blockAttempt(input.revocations, attempt, "delete_activity_failed");
  }
  if (activity.status !== COMPLETED_STATUS) return { outcome: "pending", reason: PENDING };

  if (!deleteResultIsExactlyTarget(activity, attempt)) {
    return blockAttempt(input.revocations, attempt, "delete_result_mismatch");
  }
  const authenticators = await readAuthenticators();
  if (!authenticators || isPresent(authenticators, attempt)) {
    return { outcome: "pending", reason: `Turnkey completed the removal; waiting to confirm it's gone. ${STILL_MAY_AUTHORIZE}` };
  }
  const confirmed = await input.revocations.confirmDeleted({ id: attempt.id, turnkeyActivityStatus: activity.status });
  return confirmed ? { outcome: "revoked" } : describeLatest(input.revocations, attempt);
}

export type CancelRevocationResult = { outcome: "cancelled" } | { outcome: "rejected"; reason: string };

/**
 * Withdraws an undispatched removal. Changes no passkey status (the target
 * never left 'active'), and only the session credential that owns the
 * attempt may withdraw it.
 */
export async function cancelRevocation(input: { revocations: PasskeyRevocationStore; appUserId: string; credentialId: string; attemptId: string; sessionCredentialId: string }): Promise<CancelRevocationResult> {
  const attempt = await loadOwnedAttempt(input);
  if (!attempt) return { outcome: "rejected", reason: "Unknown removal." };
  if (attempt.authorizerCredentialId !== input.sessionCredentialId) return { outcome: "rejected", reason: "Only the passkey that started this removal can cancel it." };
  if (attempt.state !== "authorization_needed") return { outcome: "rejected", reason: "This removal was already submitted and can't be cancelled until it's resolved." };
  const cancelled = await input.revocations.transition({ id: attempt.id, from: "authorization_needed", to: "cancelled" });
  return cancelled ? { outcome: "cancelled" } : { outcome: "rejected", reason: "This removal changed; check its status and try again." };
}
