import { describe, expect, it } from "vitest";
import {
  createInMemoryRealAccountRegistry,
  DuplicateAccountError,
  DuplicateCredentialError,
  type RealAccountRecord,
  type RealPasskeyRecord,
} from "@/lib/real/server/registry";

function accountInput(overrides: Partial<Omit<RealAccountRecord, "createdAt">> = {}): Omit<RealAccountRecord, "createdAt"> {
  return {
    appUserId: "app-user-1",
    subOrganizationId: "sub-org-1",
    turnkeyUserId: "turnkey-user-1",
    walletId: "wallet-1",
    walletAccountId: "wallet-account-1",
    ownerAddress: "0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF",
    safeAddress: "0xd9a4c22fb34dc74317edc8006140d66c8fa03266",
    accountConfigVersion: 1,
    ...overrides,
  };
}

function passkeyInput(overrides: Partial<Omit<RealPasskeyRecord, "createdAt" | "status">> = {}): Omit<RealPasskeyRecord, "createdAt" | "status"> {
  return {
    credentialId: "credential-1",
    appUserId: "app-user-1",
    credentialPublicKey: "cose-key-base64url",
    userHandle: "user-handle-1",
    counter: 0,
    transports: ["internal"],
    credentialDeviceType: "singleDevice",
    credentialBackedUp: false,
    ...overrides,
  };
}

describe("createInMemoryRealAccountRegistry", () => {
  it("creates an account and passkey together, both findable afterward", async () => {
    const registry = createInMemoryRealAccountRegistry();
    const { account, passkey } = await registry.createAccountWithPasskey({ account: accountInput(), passkey: passkeyInput() });

    expect(account.appUserId).toBe("app-user-1");
    expect(passkey.status).toBe("active");
    expect(await registry.findAccountByAppUserId("app-user-1")).toEqual(account);
    expect(await registry.findPasskeyByCredentialId("credential-1")).toEqual(passkey);
  });

  it("rejects a duplicate credentialId without creating a second account", async () => {
    const registry = createInMemoryRealAccountRegistry();
    await registry.createAccountWithPasskey({ account: accountInput(), passkey: passkeyInput() });

    await expect(
      registry.createAccountWithPasskey({
        account: accountInput({ appUserId: "app-user-2" }),
        passkey: passkeyInput({ appUserId: "app-user-2" }), // same credentialId
      }),
    ).rejects.toBeInstanceOf(DuplicateCredentialError);

    expect(await registry.findAccountByAppUserId("app-user-2")).toBeNull();
  });

  it("rejects a duplicate appUserId (never overwrites an existing app identity)", async () => {
    const registry = createInMemoryRealAccountRegistry();
    const original = await registry.createAccountWithPasskey({ account: accountInput(), passkey: passkeyInput() });

    await expect(
      registry.createAccountWithPasskey({
        account: accountInput({ safeAddress: "0x0000000000000000000000000000000000000099" }),
        passkey: passkeyInput({ credentialId: "credential-2" }),
      }),
    ).rejects.toBeInstanceOf(DuplicateAccountError);

    expect(await registry.findAccountByAppUserId("app-user-1")).toEqual(original.account);
    expect(await registry.findPasskeyByCredentialId("credential-2")).toBeNull();
  });

  it("findAccountByAppUserId / findPasskeyByCredentialId return null for anything unknown", async () => {
    const registry = createInMemoryRealAccountRegistry();
    expect(await registry.findAccountByAppUserId("nobody")).toBeNull();
    expect(await registry.findPasskeyByCredentialId("nothing")).toBeNull();
  });

  it("updateAuthenticatorCounter updates only the counter", async () => {
    const registry = createInMemoryRealAccountRegistry();
    await registry.createAccountWithPasskey({ account: accountInput(), passkey: passkeyInput({ counter: 0 }) });

    await registry.updateAuthenticatorCounter({ credentialId: "credential-1", counter: 7 });

    const passkey = await registry.findPasskeyByCredentialId("credential-1");
    expect(passkey?.counter).toBe(7);
    expect(passkey?.status).toBe("active");
  });

  it("revokePasskey marks the passkey revoked without deleting the account", async () => {
    const registry = createInMemoryRealAccountRegistry();
    await registry.createAccountWithPasskey({ account: accountInput(), passkey: passkeyInput() });

    await registry.revokePasskey("credential-1");

    const passkey = await registry.findPasskeyByCredentialId("credential-1");
    expect(passkey?.status).toBe("revoked");
    expect(await registry.findAccountByAppUserId("app-user-1")).not.toBeNull();
  });

  it("never stores anything private-key- or signing-session-shaped", async () => {
    const registry = createInMemoryRealAccountRegistry();
    const { account, passkey } = await registry.createAccountWithPasskey({ account: accountInput(), passkey: passkeyInput() });
    const serialized = JSON.stringify({ account, passkey });
    expect(serialized).not.toMatch(/private|seed|sessionKey|stamper|signingKey/i);
  });
});
