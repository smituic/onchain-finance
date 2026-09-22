import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { REAL_ACCOUNT_CONFIG_VERSION } from "../constants";
import { createRealPublicClient } from "../chain/client";
import { createRealSafeAccount, type SafeAccountPublicClient } from "../account/safe";
import { createVerifiedTurnkeyOwnerAccount } from "../signing/verified-account";
import type { RealAccountRecord, RealAccountRegistry } from "./registry";
import type { RegistrationAttempt, RegistrationAttemptStore } from "./registration-attempts";
import type { RealServerConfig } from "./config";
import { isDefinitiveProvisioningFailure, provisionTurnkeyChildAccount } from "./turnkey-provisioning";
import { discoverAccountByCredentialId } from "./turnkey-discovery";
import { createSessionPayload, serializeSession } from "./session";

export type OnboardingOutcome =
  | { outcome: "verified"; sessionCookie: string; account: RealAccountRecord }
  /** Durable state exists and is recoverable, but not active yet — never "safe to blindly retry", never a session. */
  | { outcome: "pending"; reason: string }
  /** Turnkey discovery found more than one possible match — never guessed; needs manual review. */
  | { outcome: "blocked"; reason: string }
  /** No durable onboarding state exists for this attempt (or it can never proceed) — distinct from "pending". */
  | { outcome: "rejected"; reason: string };

function issueSession(account: RealAccountRecord, credentialId: string, config: RealServerConfig): string {
  return serializeSession(createSessionPayload({ appUserId: account.appUserId, credentialId }), config.sessionSecret);
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
 * registration-attempts.ts's state-machine doc comment. A zero-match
 * Turnkey discovery result is explicitly NOT treated as proof the earlier
 * call failed (discovery carries no read-after-write consistency
 * guarantee), so it leaves the attempt exactly where it was: unresolved,
 * reported as "pending", never retried automatically. This mirrors the
 * payment philosophy: uncertainty is reconciled, never blindly repeated.
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

  if (attempt.state === "active") {
    const account = await input.registry.findAccountByAppUserId(attempt.appUserId);
    if (!account) return { outcome: "rejected", reason: "Account record is missing despite an active registration attempt." };
    return { outcome: "verified", sessionCookie: issueSession(account, attempt.credentialId, input.config), account };
  }

  if (attempt.state === "provisioning_in_flight") {
    // The earlier external call's outcome is unknown. Discovery is the
    // ONLY thing allowed to move this attempt forward from here — this
    // branch never falls through into a fresh provisionTurnkeyChildAccount
    // call, at zero-match or otherwise.
    const discovery = await discoverAccountByCredentialId({ config: input.config, credentialId: attempt.credentialId });

    if (discovery.outcome === "ambiguous_suborg" || discovery.outcome === "ambiguous_wallet_account") {
      const reason = "Turnkey discovery found more than one possible match for this passkey; manual review is required.";
      const blocked = await input.attempts.transition({
        credentialId: attempt.credentialId,
        from: "provisioning_in_flight",
        to: "blocked",
        patch: { blockReason: reason },
      });
      return { outcome: "blocked", reason: blocked?.blockReason ?? reason };
    }

    if (discovery.outcome === "match" && discovery.match.walletId && discovery.match.walletAccountId && discovery.match.ownerAddress) {
      // Reconcile the already-created Turnkey account into this attempt —
      // never provision again for it.
      const patch: Parameters<RegistrationAttemptStore["transition"]>[0]["patch"] = {
        subOrganizationId: discovery.match.subOrganizationId,
        walletId: discovery.match.walletId,
        walletAccountId: discovery.match.walletAccountId,
        ownerAddress: discovery.match.ownerAddress,
        externalOutcome: "confirmed_created",
      };
      if (discovery.match.userId) patch.turnkeyUserId = discovery.match.userId;
      const advanced = await input.attempts.transition({
        credentialId: attempt.credentialId,
        from: "provisioning_in_flight",
        to: "turnkey_created",
        patch,
      });
      attempt = advanced ?? ((await input.attempts.findByCredentialId(attempt.credentialId)) ?? attempt);
    } else {
      // Zero matches (or an incomplete match): NOT proof the earlier call
      // never landed — Turnkey's discovery read has no read-after-write
      // consistency guarantee. The attempt stays "provisioning_in_flight",
      // externalOutcome stays "unknown". Resolution is bounded retry (a
      // later call re-runs this same discovery check) or a manual/admin
      // decision, both outside Batch 2b's automatic path — never another
      // createSubOrganization call from here.
      return {
        outcome: "pending",
        reason: "Account setup could not yet be confirmed. This may resolve automatically — try again shortly, or use \"I already have an account\" later.",
      };
    }
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
      // / externalOutcome "unknown" (already recorded above). This is
      // recoverable only via discovery-based reconciliation later, never
      // reported as a definitive failure and never retried automatically.
      return { outcome: "pending", reason: "Account setup is still in progress. Try again in a moment, or use \"I already have an account\" to resume." };
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

  const owner = createVerifiedTurnkeyOwnerAccount({
    rpId: input.config.rpId,
    subOrganizationId: attempt.subOrganizationId,
    ownerAddress: attempt.ownerAddress,
  });
  const publicClient = input.publicClient ?? createRealPublicClient(input.config.rpcUrl);
  const safeAccount = await createRealSafeAccount({ owner, publicClient });

  const finalized = await input.attempts.finalize({
    credentialId: attempt.credentialId,
    registry: input.registry,
    safeAddress: safeAccount.address,
    accountConfigVersion: REAL_ACCOUNT_CONFIG_VERSION,
  });

  if (!finalized) {
    // Lost the finalize race, or the attempt moved under us — someone else
    // may have already finished it.
    const account = await input.registry.findAccountByAppUserId(attempt.appUserId);
    if (account) return { outcome: "verified", sessionCookie: issueSession(account, attempt.credentialId, input.config), account };
    return { outcome: "pending", reason: "Account setup is still finishing. Try again shortly." };
  }

  return { outcome: "verified", sessionCookie: issueSession(finalized.account, attempt.credentialId, input.config), account: finalized.account };
}
