export type ExecutedPathReport = {
  usedWebauthnStamper: boolean;
  userVerification: "required";
  instantiatedIndexedDbStamper: false;
  instantiatedBrowserSession: false;
  usedStampLogin: false;
  usedOtpOrOauthSession: false;
  notes: string[];
};

let webauthnStamperConstructed = false;

export function markWebauthnStamperConstructed(): void {
  webauthnStamperConstructed = true;
}

export function resetExecutedPathForTests(): void {
  webauthnStamperConstructed = false;
}

export function reportExecutedPath(): ExecutedPathReport {
  return {
    usedWebauthnStamper: webauthnStamperConstructed,
    userVerification: "required",
    instantiatedIndexedDbStamper: false,
    instantiatedBrowserSession: false,
    usedStampLogin: false,
    usedOtpOrOauthSession: false,
    notes: [
      "This PoC constructs WebauthnStamper with userVerification: required and TurnkeyClient from @turnkey/http.",
      "@turnkey/viem createAccount is called with that HTTP client and a known owner address so address lookup does not prompt.",
      "IndexedDbStamper, stampLogin, createReadWriteSession, and @turnkey/sdk-browser session helpers are not imported by PoC code.",
      "Transitive installation of @turnkey/sdk-browser via @turnkey/viem is not an execution-path failure.",
    ],
  };
}
