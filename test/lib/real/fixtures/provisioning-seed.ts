import { createHash, randomUUID } from "node:crypto";
import type { DispatchTerminalObservation, ProvisionedIdentity, RegistrationAttempt, RegistrationAttemptStore } from "@/lib/real/server/registration-attempts";

/**
 * "provisioning_in_flight" is claim-only: a test can no longer push an
 * attempt through it with transition(). These helpers walk the SAME store
 * operations production uses — claim + evidence, the activity id, an
 * in-process terminal observation, then the evidence-bound exit — with a
 * synthetic request body (the store checks its digest, not its content).
 */
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export async function claimWithEvidence(attempts: RegistrationAttemptStore, credentialId: string) {
  const body = JSON.stringify({ seed: credentialId, nonce: randomUUID() });
  const begun = await attempts.beginProvisioningDispatch({
    credentialId,
    attemptedAt: new Date().toISOString(),
    evidence: { evidenceVersion: 1, organizationId: "parent-org", stampPublicKey: "pub", requestTimestampMs: Date.now(), requestBody: body, requestBodySha256: sha256(body) },
  });
  if (!begun) throw new Error("seed: the attempt was not 'verified'");
  const activityId = `activity-${randomUUID()}`;
  const recorded = await attempts.recordDispatchActivity({ dispatchId: begun.dispatch.id, activityId, fingerprint: `sha256:${sha256(body)}` });
  if (recorded.outcome !== "recorded") throw new Error("seed: activity id not recorded");
  return { dispatchId: begun.dispatch.id, activityId };
}

export function completedObservation(identity: ProvisionedIdentity, overrides: Partial<DispatchTerminalObservation> = {}): DispatchTerminalObservation {
  return {
    status: "ACTIVITY_STATUS_COMPLETED",
    observedBy: "dispatch",
    turnkeyCreatedAt: new Date().toISOString(),
    observedSubOrganizationId: identity.subOrganizationId,
    observedRootUserId: identity.turnkeyUserId,
    observedWalletId: identity.walletId,
    observedOwnerAddress: identity.ownerAddress,
    failureCode: null,
    failureMessage: null,
    intentVerdict: "exact",
    fingerprintVerdict: "match",
    voteVerdict: "parent_key",
    ...overrides,
  };
}

export function failedObservation(overrides: Partial<DispatchTerminalObservation> = {}): DispatchTerminalObservation {
  return {
    status: "ACTIVITY_STATUS_FAILED",
    observedBy: "dispatch",
    turnkeyCreatedAt: new Date().toISOString(),
    observedSubOrganizationId: null,
    observedRootUserId: null,
    observedWalletId: null,
    observedOwnerAddress: null,
    failureCode: 3,
    failureMessage: "invalid authenticator attestation: ChallengeMismatch",
    intentVerdict: "exact",
    fingerprintVerdict: "match",
    voteVerdict: "parent_key",
    ...overrides,
  };
}

/** A 'verified' attempt walked to "turnkey_created" through the production evidence path. */
export async function seedTurnkeyCreatedThroughEvidence(attempts: RegistrationAttemptStore, credentialId: string, identity: ProvisionedIdentity): Promise<RegistrationAttempt> {
  const { dispatchId, activityId } = await claimWithEvidence(attempts, credentialId);
  const terminal = await attempts.recordDispatchTerminal({ dispatchId, activityId, observation: completedObservation(identity) });
  if (terminal.outcome !== "recorded") throw new Error("seed: terminal observation not recorded");
  const created = await attempts.advanceProvisioningToTurnkeyCreated({ credentialId, dispatchId, activityId, identity });
  if (!created) throw new Error("seed: advance refused");
  return created;
}

/** A 'verified' attempt taken through one in-process definitive failure and back to 'verified' (externalOutcome definitive_failure). */
export async function seedDefinitiveFailure(attempts: RegistrationAttemptStore, credentialId: string): Promise<RegistrationAttempt> {
  const { dispatchId, activityId } = await claimWithEvidence(attempts, credentialId);
  await attempts.recordDispatchTerminal({ dispatchId, activityId, observation: failedObservation() });
  const reverted = await attempts.revertProvisioningAfterDefinitiveFailure({ credentialId, dispatchId, activityId });
  if (!reverted) throw new Error("seed: revert refused");
  return reverted;
}
