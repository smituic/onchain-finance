import { describe, expect, it, vi } from "vitest";
import type { RealServerConfig } from "@/lib/real/server/config";
import { createInMemoryChallengeStore } from "@/lib/real/server/challenge-store";
import { createInMemoryRealAccountRegistry } from "@/lib/real/server/registry";
import { createInMemoryRegistrationAttemptStore } from "@/lib/real/server/registration-attempts";
import { bytesToBase64Url } from "@/lib/real/bytes";
import { buildAuthenticationResponseJSON, buildRegistrationResponseJSON, createFixtureAuthenticator } from "./fixtures/webauthn";

/**
 * Pre-2f hardening: login.ts and registration.ts used to forward
 * @simplewebauthn/server's own caught error.message straight into a
 * "rejected" reason. Every other rejection reason in both files was already
 * a fixed string; this proves the two verification catch blocks now are too
 * — a library error, however it's worded, never reaches the client.
 */
const SENSITIVE_TEXT = "internal-diagnostic-detail-should-never-leak-8f3c";

const verifyAuthenticationResponseMock = vi.fn();
const verifyRegistrationResponseMock = vi.fn();

vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return {
    ...actual,
    verifyAuthenticationResponse: (...args: unknown[]) => verifyAuthenticationResponseMock(...(args as [never])),
    verifyRegistrationResponse: (...args: unknown[]) => verifyRegistrationResponseMock(...(args as [never])),
  };
});

const { beginLogin, completeLogin } = await import("@/lib/real/server/login");
const { beginRegistration, completeRegistration } = await import("@/lib/real/server/registration");

const ORIGIN = "http://localhost:3000";
const config: RealServerConfig = {
  turnkeyApiBaseUrl: "https://api.turnkey.com",
  turnkeyParentOrganizationId: "parent-org",
  turnkeyApiPublicKey: "pub",
  turnkeyApiPrivateKey: "priv",
  sessionSecret: "test-secret",
  rpId: "localhost",
  rpName: "Test",
  expectedOrigins: [ORIGIN],
  rpcUrl: "https://sepolia.base.org",
  pimlicoApiKey: "pim_test_key",
};

const USER_HANDLE = "user-handle-1";

describe("WebAuthn verification failures never leak the underlying library error text (pre-2f hardening)", () => {
  it("completeLogin returns the fixed message, never @simplewebauthn/server's own error.message, for an active passkey", async () => {
    verifyAuthenticationResponseMock.mockRejectedValueOnce(new Error(SENSITIVE_TEXT));

    const authenticator = createFixtureAuthenticator();
    const registry = createInMemoryRealAccountRegistry();
    await registry.createAccountWithPasskey({
      account: {
        appUserId: "app-user-1",
        subOrganizationId: "sub-org-1",
        turnkeyUserId: "turnkey-user-1",
        walletId: "wallet-1",
        walletAccountId: "wallet-account-1",
        ownerAddress: "0xF6C3FE6DE636f0d8f421d5485D1a64fF3628CFaF",
        safeAddress: "0xd9a4c22fb34dc74317edc8006140d66c8fa03266",
        accountConfigVersion: 1,
      },
      passkey: {
        credentialId: authenticator.credentialIdBase64Url,
        appUserId: "app-user-1",
        credentialPublicKey: bytesToBase64Url(authenticator.publicKeyCose),
        userHandle: USER_HANDLE,
        counter: authenticator.counter,
        transports: ["internal"],
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
      },
    });
    const challengeStore = createInMemoryChallengeStore();
    const attempts = createInMemoryRegistrationAttemptStore();

    const { optionsJSON } = await beginLogin({ config, challengeStore });
    const response = buildAuthenticationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId, userHandle: USER_HANDLE });

    const result = await completeLogin({ config, challengeStore, registry, attempts, response });

    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.reason).not.toContain(SENSITIVE_TEXT);
    expect(result.reason).toBe("Login could not be verified.");
  });

  it("completeLogin returns the fixed message, never leaked library text, on the pending-registration-recovery path", async () => {
    verifyAuthenticationResponseMock.mockRejectedValueOnce(new Error(SENSITIVE_TEXT));

    const authenticator = createFixtureAuthenticator();
    const registry = createInMemoryRealAccountRegistry();
    const challengeStore = createInMemoryChallengeStore();
    const attempts = createInMemoryRegistrationAttemptStore();
    // No active passkey exists for this credential — only a pending,
    // independently-verified registration attempt — so completeLogin takes
    // the second (recovery) branch, which has its own separate catch block.
    await attempts.createVerified({
      credentialId: authenticator.credentialIdBase64Url,
      appUserId: "app-user-1",
      userHandle: USER_HANDLE,
      credentialPublicKey: bytesToBase64Url(authenticator.publicKeyCose),
      counter: authenticator.counter,
      transports: ["internal"],
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
      registrationChallenge: "reg-challenge-placeholder",
      rawClientDataJson: "x",
      rawAttestationObject: "x",
    });

    const { optionsJSON } = await beginLogin({ config, challengeStore });
    const response = buildAuthenticationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId, userHandle: USER_HANDLE });

    const result = await completeLogin({ config, challengeStore, registry, attempts, response });

    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.reason).not.toContain(SENSITIVE_TEXT);
    expect(result.reason).toBe("Login could not be verified.");
  });

  it("completeRegistration returns the fixed message, never @simplewebauthn/server's own error.message", async () => {
    verifyRegistrationResponseMock.mockRejectedValueOnce(new Error(SENSITIVE_TEXT));

    const authenticator = createFixtureAuthenticator();
    const registry = createInMemoryRealAccountRegistry();
    const challengeStore = createInMemoryChallengeStore();
    const attempts = createInMemoryRegistrationAttemptStore();

    const { optionsJSON } = await beginRegistration({ config, challengeStore });
    const response = buildRegistrationResponseJSON({ authenticator, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId });

    const result = await completeRegistration({ config, challengeStore, registry, attempts, response });

    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.reason).not.toContain(SENSITIVE_TEXT);
    expect(result.reason).toBe("Registration could not be verified.");
  });
});
