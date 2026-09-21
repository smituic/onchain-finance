export type ChildConfigEvidence = {
  rootUserCount: number;
  rootUserIds: string[];
  rootThreshold: number;
  authenticatorCount: number;
  apiKeyCount: number;
  oauthProviderCount: number;
  sessionCredentialCount: number;
  backendApiKeyOnChild: boolean;
  extraRootUsers: boolean;
};

export type SigningPathEvidence = {
  usedWebauthnStamper: boolean;
  userVerification: "required" | "preferred" | "discouraged" | "unknown";
  instantiatedIndexedDbStamper: boolean;
  instantiatedBrowserSession: boolean;
  usedStampLogin: boolean;
  usedOtpOrOauthSession: boolean;
};

export type SecurityGateInput = {
  child: ChildConfigEvidence;
  signingPath: SigningPathEvidence;
  storageFailed: boolean;
  storageReasons: string[];
  passkeyRegistered: boolean;
  harmlessSignProduced: boolean;
  cancelledSignProducedSignature: boolean;
};

export type SecurityGateResult = {
  passed: boolean;
  reasons: string[];
};

export function evaluateSecurityGate(input: SecurityGateInput): SecurityGateResult {
  const reasons: string[] = [];

  if (!input.passkeyRegistered) reasons.push("No new user passkey was registered.");
  if (input.child.rootUserCount !== 1) reasons.push("Child org must have exactly one root user.");
  if (input.child.rootThreshold !== 1) reasons.push("Child root quorum threshold must be 1.");
  if (input.child.extraRootUsers) reasons.push("Child org has extra root users beyond the end user.");
  if (input.child.backendApiKeyOnChild) reasons.push("Backend/parent API key is present on the child user.");
  if (input.child.apiKeyCount !== 0) reasons.push("Child user has API keys; the passkey must be the only signing credential.");
  if (input.child.oauthProviderCount !== 0) reasons.push("Child user has OAuth providers registered.");
  if (input.child.sessionCredentialCount !== 0) {
    reasons.push("Child user has a persistent Turnkey session/login credential.");
  }
  if (input.child.authenticatorCount < 1) reasons.push("Child user has no WebAuthn authenticator.");

  if (!input.signingPath.usedWebauthnStamper) reasons.push("Signing path did not use the WebAuthn stamper.");
  if (input.signingPath.userVerification !== "required") {
    reasons.push(`User verification is ${input.signingPath.userVerification}; it must be required.`);
  }
  if (input.signingPath.instantiatedIndexedDbStamper) reasons.push("IndexedDB stamper was instantiated.");
  if (input.signingPath.instantiatedBrowserSession) reasons.push("A persistent browser signing session was instantiated.");
  if (input.signingPath.usedStampLogin) reasons.push("stampLogin / persistent Turnkey session was used.");
  if (input.signingPath.usedOtpOrOauthSession) reasons.push("OTP/OAuth signing-session helper was used.");

  if (input.storageFailed) reasons.push(...input.storageReasons);
  if (!input.harmlessSignProduced) reasons.push("Harmless passkey-bound signing probe did not produce a signature.");
  if (input.cancelledSignProducedSignature) reasons.push("Cancelled WebAuthn still produced a signature.");

  return { passed: reasons.length === 0, reasons };
}

/**
 * Wraps evaluateSecurityGate for a UI that may not have fresh child
 * evidence yet (before the first inspection, or right after a reload that
 * hasn't re-fetched it). Missing evidence is reported as "not yet
 * inspected" rather than fed into evaluateSecurityGate as a fabricated
 * worst-case child — doing that would print a specific, false-sounding
 * authority violation (e.g. "must have exactly one root user") for a state
 * that is actually just "unknown". The security model itself
 * (evaluateSecurityGate) is unchanged: this never weakens a real failure,
 * it only stops manufacturing one out of absent data.
 */
export function evaluateSecurityGateOrIncomplete(
  input: Omit<SecurityGateInput, "child"> & { child: ChildConfigEvidence | null },
): SecurityGateResult {
  if (!input.child) {
    return { passed: false, reasons: ["Child organization has not been inspected yet in this session."] };
  }
  return evaluateSecurityGate({ ...input, child: input.child });
}
