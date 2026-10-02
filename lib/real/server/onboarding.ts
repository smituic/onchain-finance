import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { REAL_ACCOUNT_CONFIG_VERSION } from "../constants";
import { createRealPublicClient } from "../chain/client";
import { createRealSafeAccount, type SafeAccountPublicClient } from "../account/safe";
import { createVerifiedTurnkeyOwnerAccount } from "../signing/verified-account";
import type { RealAccountRecord, RealAccountRegistry } from "./registry";
import { accountMatchesAttempt, type RegistrationAttempt, type RegistrationAttemptStore } from "./registration-attempts";
import type { RealServerConfig } from "./config";
import { isDefinitiveProvisioningFailure, provisionTurnkeyChildAccount } from "./turnkey-provisioning";
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

/** Reconstructs the RegistrationResponseJSON shape provisionTurnkeyChildAccount needs, from durable public ceremony artifacts — never from anything re-derived or guessed. */
function rebuildRegistrationResponse(attempt: RegistrationAttempt): RegistrationResponseJSON {
  return {
    id: attempt.credentialId,
    rawId: attempt.credentialId,
    response: {
      clientDataJSON: attempt.rawClientDataJson,
      attestationObject: attempt.rawAttestationObject,
      transports: attempt.transports ?? undefined,
    },
    clientExtensionResults: {},
    type: "public-key",
  };
}

/**
 * The single place that drives a registration attempt forward — used by
 * BOTH completeRegistration (right after the durable pre-commit) and
 * completeLogin (when a login assertion proves possession of a credential
 * whose account activation was interrupted).
 *
 * The critical safety property: once an attempt's externalOutcome becomes
 * "unknown" (state "provisioning_in_flight"), this function can NEVER reach
 * provisionTurnkeyChildAccount again for it automatically — see
 * registration-attempts.ts's state-machine doc comment.
 *
 * S5 L2 (Option 3): nor does it ever ADOPT anything for such an attempt. An
 * account is bound only from the response to OUR OWN create call. When that
 * response was lost, finding a Turnkey sub-org that contains the credential
 * proves membership — not that our request created it, nor that no other
 * authority (imported/exported wallet, recovery, keys, policies) exists in
 * it — so the attempt stays "provisioning_in_flight", reported as needing
 * review, with no Turnkey call at all. Resolution is a future operator-only
 * resolver, which first needs exact dispatch evidence.
 *
 * Finalize blocks an attempt whose sub-org/owner/Safe another account holds.
 */
export async function runProvisioningPipeline(input: {
  config: RealServerConfig;
  registry: RealAccountRegistry;
  attempts: RegistrationAttemptStore;
  attempt: RegistrationAttempt;
  publicClient?: SafeAccountPublicClient;
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
    // The only state from which a createSubOrganization call may begin:
    // externalOutcome is "not_attempted" (first try) or "definitive_failure"
    // (Turnkey itself proved the previous attempt created nothing). Mark
    // the call as dispatched — durably, BEFORE actually calling out — so a
    // crash between this write and the network call still durably shows
    // "unknown", never "not_attempted", to the next process that reads it.
    const claimed = await input.attempts.transition({
      credentialId: attempt.credentialId,
      from: "verified",
      to: "provisioning_in_flight",
      patch: { externalOutcome: "unknown", externalProvisioningAttemptedAt: new Date().toISOString() },
    });
    if (!claimed) {
      // Lost a race to another concurrent request — re-read and recurse
      // once rather than assuming our stale view is still accurate.
      const fresh = await input.attempts.findByCredentialId(attempt.credentialId);
      if (!fresh) return { outcome: "rejected", reason: "Registration attempt could not be found." };
      return runProvisioningPipeline({ ...input, attempt: fresh });
    }
    attempt = claimed;

    let provisioned;
    try {
      provisioned = await provisionTurnkeyChildAccount({
        config: input.config,
        challengeBase64Url: attempt.registrationChallenge,
        registration: rebuildRegistrationResponse(attempt),
        appUserId: attempt.appUserId,
      });
    } catch (error) {
      if (isDefinitiveProvisioningFailure(error)) {
        // Turnkey's own activity ledger resolved this specific attempt to a
        // terminal FAILED/REJECTED status — proof no child was created.
        // Safe to revert to "verified" so a later call may try again.
        await input.attempts.transition({
          credentialId: attempt.credentialId,
          from: "provisioning_in_flight",
          to: "verified",
          patch: { externalOutcome: "definitive_failure" },
        });
        return { outcome: "pending", reason: "Account setup failed and can be retried. Try again in a moment." };
      }
      // Outcome unknown — the attempt durably stays "provisioning_in_flight"
      // / externalOutcome "unknown" (already recorded above): never reported
      // as a definitive failure, never retried, never adopted (Option 3).
      return { outcome: "pending", reason: PROVISIONING_NEEDS_REVIEW_REASON };
    }

    const advanced = await input.attempts.transition({
      credentialId: attempt.credentialId,
      from: "provisioning_in_flight",
      to: "turnkey_created",
      patch: {
        subOrganizationId: provisioned.subOrganizationId,
        turnkeyUserId: provisioned.turnkeyUserId,
        walletId: provisioned.walletId,
        walletAccountId: provisioned.walletAccountId,
        ownerAddress: provisioned.ownerAddress,
        externalOutcome: "confirmed_created",
      },
    });
    attempt = advanced ?? ((await input.attempts.findByCredentialId(attempt.credentialId)) ?? attempt);
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
