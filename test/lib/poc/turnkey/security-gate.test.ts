import { describe, expect, it } from "vitest";
import { evaluateSecurityGate, evaluateSecurityGateOrIncomplete } from "@/lib/poc/turnkey/security-gate";

const passingChild = {
  rootUserCount: 1,
  rootUserIds: ["11111111-1111-4111-8111-111111111111"],
  rootThreshold: 1,
  authenticatorCount: 1,
  apiKeyCount: 0,
  oauthProviderCount: 0,
  sessionCredentialCount: 0,
  backendApiKeyOnChild: false,
  extraRootUsers: false,
};

const passingPath = {
  usedWebauthnStamper: true,
  userVerification: "required" as const,
  instantiatedIndexedDbStamper: false,
  instantiatedBrowserSession: false,
  usedStampLogin: false,
  usedOtpOrOauthSession: false,
};

describe("security gate", () => {
  it("passes only the direct-passkey ownership model", () => {
    expect(
      evaluateSecurityGate({
        child: passingChild,
        signingPath: passingPath,
        storageFailed: false,
        storageReasons: [],
        passkeyRegistered: true,
        harmlessSignProduced: true,
        cancelledSignProducedSignature: false,
      }).passed,
    ).toBe(true);
  });

  it("fails if the backend is a child signing credential or UV is only preferred", () => {
    expect(
      evaluateSecurityGate({
        child: { ...passingChild, backendApiKeyOnChild: true, apiKeyCount: 1 },
        signingPath: passingPath,
        storageFailed: false,
        storageReasons: [],
        passkeyRegistered: true,
        harmlessSignProduced: true,
        cancelledSignProducedSignature: false,
      }).passed,
    ).toBe(false);

    expect(
      evaluateSecurityGate({
        child: passingChild,
        signingPath: { ...passingPath, userVerification: "preferred" },
        storageFailed: false,
        storageReasons: [],
        passkeyRegistered: true,
        harmlessSignProduced: true,
        cancelledSignProducedSignature: false,
      }).passed,
    ).toBe(false);
  });
});

describe("security gate diagnostic state (UI wrapper)", () => {
  const rest = {
    signingPath: passingPath,
    storageFailed: false,
    storageReasons: [],
    passkeyRegistered: true,
    harmlessSignProduced: true,
    cancelledSignProducedSignature: false,
  };

  it("reports missing child evidence as 'not yet inspected', not a fabricated authority violation", () => {
    // Regression: before this fix, a null/not-yet-fetched child was fed into
    // evaluateSecurityGate as a worst-case fake (rootUserCount: 0,
    // extraRootUsers: true), which printed the specific, false-sounding
    // "Child org must have exactly one root user." This must never claim a
    // specific violation for data that simply hasn't been fetched yet.
    const result = evaluateSecurityGateOrIncomplete({ ...rest, child: null });
    expect(result.passed).toBe(false);
    expect(result.reasons).toEqual(["Child organization has not been inspected yet in this session."]);
    expect(result.reasons.join(" ")).not.toMatch(/exactly one root user/);
  });

  it("evaluates real child evidence exactly like evaluateSecurityGate once it has been inspected", () => {
    // A prior failed sign probe (harmlessSignProduced: false) must not erase
    // or override otherwise-valid, already-fetched child inspection
    // diagnostics — the real child evidence still drives the result.
    const withFailedSign = evaluateSecurityGateOrIncomplete({
      ...rest,
      harmlessSignProduced: false,
      child: passingChild,
    });
    expect(withFailedSign.passed).toBe(false);
    expect(withFailedSign.reasons).toEqual(["Harmless passkey-bound signing probe did not produce a signature."]);
    expect(withFailedSign.reasons.join(" ")).not.toMatch(/exactly one root user/);

    expect(evaluateSecurityGateOrIncomplete({ ...rest, child: passingChild })).toEqual(
      evaluateSecurityGate({ ...rest, child: passingChild }),
    );
  });
});
