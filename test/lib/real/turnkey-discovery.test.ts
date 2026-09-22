import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealServerConfig } from "@/lib/real/server/config";

const getSubOrgIdsMock = vi.fn();
const getUsersMock = vi.fn();
const getWalletAccountsMock = vi.fn();

vi.mock("@turnkey/http", () => ({
  TurnkeyClient: vi.fn().mockImplementation(function TurnkeyClientMock() {
    return {
      getSubOrgIds: getSubOrgIdsMock,
      getUsers: getUsersMock,
      getWalletAccounts: getWalletAccountsMock,
    };
  }),
}));

const { discoverAccountByCredentialId } = await import("@/lib/real/server/turnkey-discovery");

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

describe("discoverAccountByCredentialId — reconciliation only, never sufficient to authenticate", () => {
  afterEach(() => {
    getSubOrgIdsMock.mockReset();
    getUsersMock.mockReset();
    getWalletAccountsMock.mockReset();
  });

  it("calls getSubOrgIds filtered by CREDENTIAL_ID against the parent organization", async () => {
    getSubOrgIdsMock.mockResolvedValue({ organizationIds: [] });
    await discoverAccountByCredentialId({ config, credentialId: "cred-1" });

    expect(getSubOrgIdsMock).toHaveBeenCalledWith({
      organizationId: "parent-org",
      filterType: "CREDENTIAL_ID",
      filterValue: "cred-1",
    });
  });

  it("reports no_match on zero sub-organizations, without inspecting anything further", async () => {
    getSubOrgIdsMock.mockResolvedValue({ organizationIds: [] });
    const result = await discoverAccountByCredentialId({ config, credentialId: "cred-1" });

    expect(result).toEqual({ outcome: "no_match" });
    expect(getUsersMock).not.toHaveBeenCalled();
    expect(getWalletAccountsMock).not.toHaveBeenCalled();
  });

  it("reports ambiguous_suborg on multiple sub-organization matches — never picks the first", async () => {
    getSubOrgIdsMock.mockResolvedValue({ organizationIds: ["org-a", "org-b"] });
    const result = await discoverAccountByCredentialId({ config, credentialId: "cred-1" });

    expect(result).toEqual({ outcome: "ambiguous_suborg", subOrganizationIds: ["org-a", "org-b"] });
    expect(getWalletAccountsMock).not.toHaveBeenCalled();
  });

  it("reports ambiguous_wallet_account when the single matched sub-org has more than one wallet account", async () => {
    getSubOrgIdsMock.mockResolvedValue({ organizationIds: ["org-a"] });
    getUsersMock.mockResolvedValue({ users: [{ userId: "user-1" }] });
    getWalletAccountsMock.mockResolvedValue({
      accounts: [{ address: "0x1111111111111111111111111111111111111111" }, { address: "0x2222222222222222222222222222222222222222" }],
    });

    const result = await discoverAccountByCredentialId({ config, credentialId: "cred-1" });

    expect(result).toEqual({
      outcome: "ambiguous_wallet_account",
      subOrganizationId: "org-a",
      candidateAddresses: ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"],
    });
  });

  it("reports a match with the single wallet account's identifiers when everything resolves uniquely", async () => {
    getSubOrgIdsMock.mockResolvedValue({ organizationIds: ["org-a"] });
    getUsersMock.mockResolvedValue({ users: [{ userId: "user-1" }] });
    getWalletAccountsMock.mockResolvedValue({
      accounts: [{ address: "0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF", walletId: "wallet-1", walletAccountId: "wallet-account-1" }],
    });

    const result = await discoverAccountByCredentialId({ config, credentialId: "cred-1" });

    expect(result).toEqual({
      outcome: "match",
      match: {
        subOrganizationId: "org-a",
        userId: "user-1",
        walletId: "wallet-1",
        walletAccountId: "wallet-account-1",
        ownerAddress: "0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF",
      },
    });
  });

  it("reports a match with null wallet fields when the sub-org has zero wallet accounts (does not assume one exists)", async () => {
    getSubOrgIdsMock.mockResolvedValue({ organizationIds: ["org-a"] });
    getUsersMock.mockResolvedValue({ users: [{ userId: "user-1" }] });
    getWalletAccountsMock.mockResolvedValue({ accounts: [] });

    const result = await discoverAccountByCredentialId({ config, credentialId: "cred-1" });

    expect(result).toEqual({
      outcome: "match",
      match: { subOrganizationId: "org-a", userId: "user-1", walletId: null, walletAccountId: null, ownerAddress: null },
    });
  });
});

describe("turnkey-discovery.ts source", () => {
  it("is server-only: never imported by any client-facing module, and imports nothing from React/Next/Zustand", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const source = readFileSync(path.resolve(process.cwd(), "lib/real/server/turnkey-discovery.ts"), "utf8");
    expect(source).not.toContain('from "react"');
    expect(source).not.toContain('from "next"');
    expect(source).not.toContain('from "zustand"');
  });

  it("is never imported by the login flow — discovery is reconciliation-only, never sufficient to mint a session", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const loginSource = readFileSync(path.resolve(process.cwd(), "lib/real/server/login.ts"), "utf8");
    expect(loginSource).not.toContain("turnkey-discovery");
    expect(loginSource).not.toContain("discoverAccountByCredentialId");
  });
});
