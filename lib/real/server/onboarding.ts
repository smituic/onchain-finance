import { REAL_ACCOUNT_CONFIG_VERSION } from "../constants";
import { createRealPublicClient } from "../chain/client";
import { createRealSafeAccount, type SafeAccountPublicClient } from "../account/safe";
import { createVerifiedTurnkeyOwnerAccount } from "../signing/verified-account";
import type { RealAccountRecord, RealAccountRegistry } from "./registry";
import { accountMatchesAttempt, type ProvisionedIdentity, type RegistrationAttempt, type RegistrationAttemptStore } from "./registration-attempts";
import type { RealServerConfig } from "./config";
import { runProvisioningDispatch } from "./provisioning-dispatch";
import type { ParentTurnkeyDeps } from "./turnkey-provisioning";
import { createSessionPayload, serializeSession } from "./session";

export type OnboardingOutcome =
  | { outcome: "verified"; sessionCookie: string; account: RealAccountRecord }
  /** Durable state exists but is not active — never "safe to blindly retry", never a session. Includes an uncertain create awaiting review (PROVISIONING_NEEDS_REVIEW_REASON). */
  | { outcome: "pending"; reason: string }
  /** Positively known not to be safely completable (an identity conflict at finalize) — never guessed; manual review. */
  | { outcome: "blocked"; reason: string }
  /** No durable onboarding state exists for this attempt (or it can never proceed) — distinct from "pending". */
  | { outcome: "rejected"; reason: string };

/**
 * S5 L2 (Option 3): the honest answer for an attempt whose
 * CREATE_SUB_ORGANIZATION outcome is unknown. Nothing automatic can resolve
 * it — not a retry, not a login — so it never says "try again shortly".
 */
export const PROVISIONING_NEEDS_REVIEW_REASON =
  "Account setup couldn't be confirmed, so it needs review before it can continue. Trying again won't resolve it.";

function issueSession(account: RealAccountRecord, credentialId: string, config: RealServerConfig): string {
  return serializeSession(createSessionPayload({ appUserId: account.appUserId, credentialId, sessionEpoch: account.sessionEpoch }), config.sessionSecret);
}

/**
 * S5 L3: an "active" attempt resumes ONLY onto the exact account + passkey
 * finalize wrote for it (accountMatchesAttempt). Missing or mismatched rows
 * fail closed — no session, never "whatever account has this appUserId".
 */
async function resumeActiveAttempt(registry: RealAccountRegistry, attempt: RegistrationAttempt, config: RealServerConfig): Promise<OnboardingOutcome> {
  const [account, passkey] = await Promise.all([registry.findAccountByAppUserId(attempt.appUserId), registry.findPasskeyByCredentialId(attempt.credentialId)]);
  if (!account || !passkey || !accountMatchesAttempt(attempt, account, passkey)) {
    return { outcome: "rejected", reason: "This registration's account records are missing or don't match it." };
  }
  return { outcome: "verified", sessionCookie: issueSession(account, passkey.credentialId, config), account };
}

/**
 * The durable attempt contradicts what this request just did, or could not be
 * re-read after an ambiguous write: an INTERNAL failure, never ordinary
 * Turnkey uncertainty. Thrown (the route answers 500), never reported as
 * "pending", and never treated as permission to continue.
 */
export class ProvisioningStateError extends Error {
  constructor(readonly code: "turnkey_created_reread_failed" | "turnkey_created_state_contradiction") {
    super(`Registration provisioning state error: ${code}`);
    this.name = "ProvisioningStateError";
  }
}

/**
 * The project has no logging layer, and the routes return fixed messages, so
 * these fixed markers are the only server-side trace of which branch ran.
 * They never carry an identifier, a body, an attestation, a stamp, or a key.
 */
type ProvisioningDiagnostic = "definitive_failure_revert_refused" | "turnkey_created_write_failed" | "turnkey_created_write_refused" | "turnkey_created_reread_failed" | "turnkey_created_state_contradiction";
function provisioningDiagnostic(level: "warn" | "error", marker: ProvisioningDiagnostic): void {
  console[level](`[real-onboarding] ${marker}`);
}

function hasNoIdentity(attempt: RegistrationAttempt): boolean {
  return attempt.subOrganizationId === null && attempt.turnkeyUserId === null && attempt.walletId === null && attempt.walletAccountId === null && attempt.ownerAddress === null;
}

function identityEquals(attempt: RegistrationAttempt, identity: ProvisionedIdentity): boolean {
  return (
    attempt.subOrganizationId === identity.subOrganizationId &&
    attempt.turnkeyUserId === identity.turnkeyUserId &&
    attempt.walletId === identity.walletId &&
    attempt.walletAccountId === identity.walletAccountId &&
    attempt.ownerAddress === identity.ownerAddress
  );
}

/** Test seam for the parent-key Turnkey transport (fetch / stamp / clock); production passes nothing. Re-exported so registration.ts and login.ts never import a Turnkey module themselves. */
export type ProvisioningDeps = ParentTurnkeyDeps;

/**
 * The single place that drives a registration attempt forward — used by
 * BOTH completeRegistration (right after the durable pre-commit) and
 * completeLogin (when a login assertion proves possession of a credential
 * whose account activation was interrupted).
 *
 * The critical safety property: once an attempt's externalOutcome becomes
 * "unknown" (state "provisioning_in_flight"), this function can NEVER
 * dispatch a create again for it automatically — see
 * registration-attempts.ts's state-machine doc comment.
 *
 * S5 L2 (Option 3): nor does it ever ADOPT anything for such an attempt. An
 * account is bound only from the response to OUR OWN create call. When that
 * response was lost, finding a Turnkey sub-org that contains the credential
 * proves membership — not that our request created it, nor that no other
 * authority (imported/exported wallet, recovery, keys, policies) exists in
 * it — so the attempt stays "provisioning_in_flight", reported as needing
 * review, with no Turnkey call at all. Resolution is a future operator-only
 * resolver.
 *
 * Provisioning Evidence Capture gives that resolver exact dispatch evidence
 * (provisioning-dispatch.ts) and changes nothing above: the
 * "provisioning_in_flight" branch never reads a dispatch row, whatever it
 * holds — not even a recorded COMPLETED observation.
 *
 * Finalize blocks an attempt whose sub-org/owner/Safe another account holds.
 */
export async function runProvisioningPipeline(input: {
  config: RealServerConfig;
  registry: RealAccountRegistry;
  attempts: RegistrationAttemptStore;
  attempt: RegistrationAttempt;
  publicClient?: SafeAccountPublicClient;
  provisioningDeps?: ProvisioningDeps;
}): Promise<OnboardingOutcome> {
  let attempt = input.attempt;

  if (attempt.state === "blocked") {
    return { outcome: "blocked", reason: attempt.blockReason ?? "This registration requires manual review." };
  }

  if (attempt.state === "active") return resumeActiveAttempt(input.registry, attempt, input.config);

  if (attempt.state === "provisioning_in_flight") {
    // The earlier create's outcome is unknown. No Turnkey read, no adoption,
    // no second create, no state change: review only (Option 3).
    return { outcome: "pending", reason: PROVISIONING_NEEDS_REVIEW_REASON };
  }

  if (attempt.state === "verified") {
    // The only state from which a createSubOrganization dispatch may begin:
    // externalOutcome is "not_attempted" (first try) or "definitive_failure"
    // (Turnkey itself proved the previous dispatch created nothing). The
    // claim — "provisioning_in_flight" / "unknown" — and the exact request
    // evidence are committed together, durably, BEFORE anything is stamped
    // or sent, so a crash at any later point still durably shows "unknown",
    // never "not_attempted", to the next process that reads it.
    const dispatched = await runProvisioningDispatch({ config: input.config, attempts: input.attempts, attempt, deps: input.provisioningDeps });

    if (dispatched.kind === "claim_lost") {
      // Lost a race to another concurrent request — nothing was dispatched.
      // Re-read and recurse once rather than assuming our stale view is
      // still accurate.
      const fresh = await input.attempts.findByCredentialId(attempt.credentialId);
      if (!fresh) return { outcome: "rejected", reason: "Registration attempt could not be found." };
      return runProvisioningPipeline({ ...input, attempt: fresh });
    }

    if (dispatched.kind === "definitive_failure") {
      // Turnkey's own activity ledger resolved this dispatch's exact activity
      // to a terminal FAILED/REJECTED status (already recorded on its
      // evidence row) — proof no child was created. The store's dedicated CAS
      // re-checks that recorded in-process evidence before reverting to
      // "verified", so a later call may dispatch again, as a NEW evidence row.
      const reverted = await input.attempts.revertProvisioningAfterDefinitiveFailure({ credentialId: attempt.credentialId, dispatchId: dispatched.dispatchId, activityId: dispatched.activityId });
      if (!reverted) {
        provisioningDiagnostic("warn", "definitive_failure_revert_refused");
        return { outcome: "pending", reason: PROVISIONING_NEEDS_REVIEW_REASON };
      }
      return { outcome: "pending", reason: "Account setup failed and can be retried. Try again in a moment." };
    }

    if (dispatched.kind === "review") {
      // Outcome unknown, or the activity could not be shown to match what we
      // sent — the attempt durably stays "provisioning_in_flight" /
      // externalOutcome "unknown" (recorded by the claim): never reported as
      // a definitive failure, never retried, never adopted (Option 3).
      return { outcome: "pending", reason: PROVISIONING_NEEDS_REVIEW_REASON };
    }

    const { provisioned } = dispatched;
    let advanced: RegistrationAttempt | null = null;
    let advanceThrew = false;
    try {
      advanced = await input.attempts.advanceProvisioningToTurnkeyCreated({
        credentialId: attempt.credentialId,
        dispatchId: dispatched.dispatchId,
        activityId: dispatched.activityId,
        identity: provisioned,
      });
    } catch {
      advanceThrew = true;
    }
    if (!advanced) {
      // Ambiguous: the write threw (it may or may not have committed), or its
      // CAS matched nothing. Read the attempt back — never guess either way.
      let fresh: RegistrationAttempt | null;
      try {
        fresh = await input.attempts.findByCredentialId(attempt.credentialId);
      } catch {
        provisioningDiagnostic("error", "turnkey_created_reread_failed");
        throw new ProvisioningStateError("turnkey_created_reread_failed");
      }
      if (fresh && fresh.state === "provisioning_in_flight" && hasNoIdentity(fresh)) {
        // The write genuinely did not happen: still unfinished, so review —
        // never resumed from the evidence row (Option 3).
        provisioningDiagnostic("warn", advanceThrew ? "turnkey_created_write_failed" : "turnkey_created_write_refused");
        return { outcome: "pending", reason: PROVISIONING_NEEDS_REVIEW_REASON };
      }
      if (fresh && (fresh.state === "turnkey_created" || fresh.state === "active" || fresh.state === "blocked") && identityEquals(fresh, provisioned)) {
        // The write committed and only its answer was lost (another request
        // may even have finalized or blocked it since): continue from the
        // durable state through the ordinary path.
        return runProvisioningPipeline({ ...input, attempt: fresh });
      }
      // Anything else contradicts what this request just did.
      provisioningDiagnostic("error", "turnkey_created_state_contradiction");
      throw new ProvisioningStateError("turnkey_created_state_contradiction");
    }
    attempt = advanced;
  }

  if (attempt.state !== "turnkey_created" || !attempt.ownerAddress || !attempt.subOrganizationId) {
    return { outcome: "pending", reason: "Account setup is still in progress." };
  }

  // The Safe is derived (network reads) BEFORE finalize, from this read of
  // the owner. finalize's CAS re-checks the LOCKED attempt's owner against
  // exactly this value, so a Safe derived for a stale owner never commits.
  const safeOwnerAddress = attempt.ownerAddress;
  const owner = createVerifiedTurnkeyOwnerAccount({
    rpId: input.config.rpId,
    subOrganizationId: attempt.subOrganizationId,
    ownerAddress: safeOwnerAddress,
  });
  const publicClient = input.publicClient ?? createRealPublicClient(input.config.rpcUrl);
  const safeAccount = await createRealSafeAccount({ owner, publicClient });

  const finalized = await input.attempts.finalize({
    credentialId: attempt.credentialId,
    registry: input.registry,
    safeAddress: safeAccount.address,
    safeOwnerAddress,
    accountConfigVersion: REAL_ACCOUNT_CONFIG_VERSION,
  });

  if (!finalized) {
    // Nothing was written by this call. Re-read the ATTEMPT (not the
    // account): another call may have finished it, it may have moved, or
    // finalize itself blocked it on an identity conflict.
    const fresh = await input.attempts.findByCredentialId(attempt.credentialId);
    if (fresh?.state === "active") return resumeActiveAttempt(input.registry, fresh, input.config);
    if (fresh?.state === "blocked") return { outcome: "blocked", reason: fresh.blockReason ?? "This registration requires manual review." };
    return { outcome: "pending", reason: "Account setup is still finishing. Try again shortly." };
  }

  return { outcome: "verified", sessionCookie: issueSession(finalized.account, attempt.credentialId, input.config), account: finalized.account };
}
