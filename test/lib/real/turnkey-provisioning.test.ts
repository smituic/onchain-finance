import { afterEach, describe, expect, it, vi } from "vitest";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import type { RealServerConfig } from "@/lib/real/server/config";
import { buildRegistrationResponseJSON, createFixtureAuthenticator } from "./fixtures/webauthn";

const createSubOrganizationMock = vi.fn();
const getWalletAccountsMock = vi.fn();

vi.mock("@turnkey/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@turnkey/http")>();
  return {
    ...actual,
    TurnkeyClient: vi.fn().mockImplementation(function TurnkeyClientMock() {
      return {
        createSubOrganization: createSubOrganizationMock,
        getWalletAccounts: getWalletAccountsMock,
      };
    }),
  };
});

const { provisionTurnkeyChildAccount, isDefinitiveProvisioningFailure } = await import("@/lib/real/server/turnkey-provisioning");
const { TurnkeyActivityError, TurnkeyRequestError } = await import("@turnkey/http");

const config: RealServerConfig = {
  turnkeyApiBaseUrl: "https://api.turnkey.com",
  turnkeyParentOrganizationId: "parent-org",
  turnkeyApiPublicKey: "pub",
  turnkeyApiPrivateKey: "priv",
  sessionSecret: "secret",
  rpId: "localhost",
  rpName: "Test",
  expectedOrigins: ["http://localhost:3000"],
  rpcUrl: "https://sepolia.base.org",
  pimlicoApiKey: "pim_test_key",
};

function completedActivity(result: unknown) {
  return { activity: { id: "activity-1", status: "ACTIVITY_STATUS_COMPLETED", result } };
}

function fixtureRegistration(): { registration: RegistrationResponseJSON; challengeBase64Url: string } {
  const authenticator = createFixtureAuthenticator();
  const challengeBase64Url = "fixed-test-challenge";
  const registration = buildRegistrationResponseJSON({
    authenticator,
    challenge: challengeBase64Url,
    origin: "http://localhost:3000",
    rpId: "localhost",
  });
  return { registration, challengeBase64Url };
}

describe("provisionTurnkeyChildAccount", () => {
  afterEach(() => {
    createSubOrganizationMock.mockReset();
    getWalletAccountsMock.mockReset();
  });

  it("provisions a sub-org with the SAME verified credential's attestation, one root passkey user, threshold 1, no API keys", async () => {
    createSubOrganizationMock.mockResolvedValue(
      completedActivity({
        createSubOrganizationResultV8: {
          subOrganizationId: "sub-org-1",
          rootUserIds: ["user-1"],
          wallet: { walletId: "wallet-1", addresses: ["0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF"] },
        },
      }),
    );
    getWalletAccountsMock.mockResolvedValue({
      accounts: [{ address: "0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF", walletAccountId: "wallet-account-1" }],
    });

    const { registration, challengeBase64Url } = fixtureRegistration();
    const result = await provisionTurnkeyChildAccount({ config, challengeBase64Url, registration, appUserId: "app-user-1" });

    expect(result).toEqual({
      subOrganizationId: "sub-org-1",
      turnkeyUserId: "user-1",
      walletId: "wallet-1",
      walletAccountId: "wallet-account-1",
      ownerAddress: "0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF",
    });

    const call = createSubOrganizationMock.mock.calls[0]![0] as {
      parameters: { rootQuorumThreshold: number; rootUsers: Array<{ apiKeys: unknown[]; authenticators: Array<{ attestation: { credentialId: string } }> }> };
    };
    expect(call.parameters.rootQuorumThreshold).toBe(1);
    expect(call.parameters.rootUsers).toHaveLength(1);
    expect(call.parameters.rootUsers[0]!.apiKeys).toHaveLength(0);
    // The authenticator forwarded to Turnkey carries the SAME credentialId
    // our own server already verified — never a second passkey.
    expect(call.parameters.rootUsers[0]!.authenticators[0]!.attestation.credentialId).toBe(registration.id);
  });

  it("throws when the sub-organization result is incomplete rather than returning partial data", async () => {
    createSubOrganizationMock.mockResolvedValue(completedActivity({ createSubOrganizationResultV8: { subOrganizationId: "sub-org-1" } }));
    const { registration, challengeBase64Url } = fixtureRegistration();

    await expect(provisionTurnkeyChildAccount({ config, challengeBase64Url, registration, appUserId: "app-user-1" })).rejects.toThrow(
      /complete child wallet/,
    );
    expect(getWalletAccountsMock).not.toHaveBeenCalled();
  });

  it("throws when the provisioned wallet account cannot be located afterward", async () => {
    createSubOrganizationMock.mockResolvedValue(
      completedActivity({
        createSubOrganizationResultV8: {
          subOrganizationId: "sub-org-1",
          rootUserIds: ["user-1"],
          wallet: { walletId: "wallet-1", addresses: ["0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF"] },
        },
      }),
    );
    getWalletAccountsMock.mockResolvedValue({ accounts: [] });
    const { registration, challengeBase64Url } = fixtureRegistration();

    await expect(provisionTurnkeyChildAccount({ config, challengeBase64Url, registration, appUserId: "app-user-1" })).rejects.toThrow(
      /wallet account could not be located/,
    );
  });

  it("throws TurnkeyActivityError (not a generic Error) when Turnkey's own ledger resolves the activity to FAILED — this is the ONE signal treated as a definitive pre-creation failure", async () => {
    createSubOrganizationMock.mockResolvedValue({ activity: { id: "activity-1", type: "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V8", status: "ACTIVITY_STATUS_FAILED" } });
    const { registration, challengeBase64Url } = fixtureRegistration();

    let caught: unknown;
    try {
      await provisionTurnkeyChildAccount({ config, challengeBase64Url, registration, appUserId: "app-user-1" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TurnkeyActivityError);
    expect(isDefinitiveProvisioningFailure(caught)).toBe(true);
  });
});

describe("isDefinitiveProvisioningFailure", () => {
  it("is true only for a Turnkey activity that reached a terminal FAILED or REJECTED status", () => {
    expect(isDefinitiveProvisioningFailure(new TurnkeyActivityError({ message: "failed", activityStatus: "ACTIVITY_STATUS_FAILED" }))).toBe(true);
    expect(isDefinitiveProvisioningFailure(new TurnkeyActivityError({ message: "rejected", activityStatus: "ACTIVITY_STATUS_REJECTED" }))).toBe(true);
  });

  it("is false for every uncertain/non-terminal outcome — never classified as proof nothing was created", () => {
    // Activity accepted but stuck needing consensus/authenticators: not terminal, not proof of failure.
    expect(isDefinitiveProvisioningFailure(new TurnkeyActivityError({ message: "needs consensus", activityStatus: "ACTIVITY_STATUS_CONSENSUS_NEEDED" }))).toBe(
      false,
    );
    expect(
      isDefinitiveProvisioningFailure(new TurnkeyActivityError({ message: "needs authenticators", activityStatus: "ACTIVITY_STATUS_AUTHENTICATORS_NEEDED" })),
    ).toBe(false);
    // A non-2xx from the initial request — could be a lost response after
    // Turnkey actually did the work server-side; never treated as definitive.
    expect(isDefinitiveProvisioningFailure(new TurnkeyRequestError({ code: 500, message: "internal error", details: null }))).toBe(false);
    // Generic network/transport errors, and anything not thrown by Turnkey's own SDK.
    expect(isDefinitiveProvisioningFailure(new Error("fetch failed"))).toBe(false);
    expect(isDefinitiveProvisioningFailure(new TypeError("Network request failed"))).toBe(false);
    expect(isDefinitiveProvisioningFailure("not even an Error")).toBe(false);
    expect(isDefinitiveProvisioningFailure(null)).toBe(false);
  });
});
