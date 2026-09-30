import { describe, expect, it } from "vitest";
import {
  createInMemoryRealAccountRegistry,
  DuplicateAccountError,
  DuplicateCredentialError,
  getInMemoryRegistryInternals,
  type RealAccountRecord,
  type RealPasskeyRecord,
} from "@/lib/real/server/registry";

function accountInput(overrides: Partial<Omit<RealAccountRecord, "createdAt" | "sessionEpoch">> = {}): Omit<RealAccountRecord, "createdAt" | "sessionEpoch"> {
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

type PrimaryPasskeyInput = Omit<RealPasskeyRecord, "createdAt" | "status" | "role" | "turnkeyAuthenticatorId" | "displayName">;

function passkeyInput(overrides: Partial<PrimaryPasskeyInput> = {}): PrimaryPasskeyInput {
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

  it("transitionPasskeyStatus (active -> revoking -> revoked) changes app status without deleting the account", async () => {
    const registry = createInMemoryRealAccountRegistry();
    await registry.createAccountWithPasskey({ account: accountInput(), passkey: passkeyInput() });

    expect((await registry.transitionPasskeyStatus({ credentialId: "credential-1", from: "active", to: "revoking" }))?.status).toBe("revoking");
    expect((await registry.transitionPasskeyStatus({ credentialId: "credential-1", from: "revoking", to: "revoked" }))?.status).toBe("revoked");
    expect(await registry.findAccountByAppUserId("app-user-1")).not.toBeNull();
  });

  it("transitionPasskeyStatus is a CAS: returns null (never throws) when the current status doesn't match `from`", async () => {
    const registry = createInMemoryRealAccountRegistry();
    await registry.createAccountWithPasskey({ account: accountInput(), passkey: passkeyInput() });

    expect(await registry.transitionPasskeyStatus({ credentialId: "credential-1", from: "revoking", to: "revoked" })).toBeNull();
    expect((await registry.findPasskeyByCredentialId("credential-1"))?.status).toBe("active");
  });

  it("a primary passkey is created role='primary', active, with no Turnkey mapping until one is confirmed", async () => {
    const registry = createInMemoryRealAccountRegistry();
    const { passkey } = await registry.createAccountWithPasskey({ account: accountInput(), passkey: passkeyInput() });
    expect(passkey).toMatchObject({ role: "primary", status: "active", turnkeyAuthenticatorId: null, displayName: null });
    expect(await registry.findPasskeysByAppUserId("app-user-1")).toHaveLength(1);
  });

  it("renamePasskey sets display_name on the account's own active passkey and changes nothing else", async () => {
    const registry = createInMemoryRealAccountRegistry();
    const { passkey: before } = await registry.createAccountWithPasskey({ account: accountInput(), passkey: passkeyInput() });
    await registry.transitionPasskeyStatus({ credentialId: "credential-1", from: "active", to: "active", patch: { turnkeyAuthenticatorId: "auth-1" } });

    const result = await registry.renamePasskey({ appUserId: "app-user-1", credentialId: "credential-1", displayName: "MacBook Touch ID" });

    expect(result.outcome).toBe("renamed");
    const after = await registry.findPasskeyByCredentialId("credential-1");
    expect(after).toEqual({ ...before, turnkeyAuthenticatorId: "auth-1", displayName: "MacBook Touch ID" });
  });

  it("renamePasskey on another account's credential is 'not_found' (same as missing) and leaves it untouched", async () => {
    const registry = createInMemoryRealAccountRegistry();
    await registry.createAccountWithPasskey({ account: accountInput(), passkey: passkeyInput() });
    await registry.createAccountWithPasskey({
      account: accountInput({ appUserId: "app-user-2" }),
      passkey: passkeyInput({ credentialId: "credential-2", appUserId: "app-user-2" }),
    });

    expect(await registry.renamePasskey({ appUserId: "app-user-1", credentialId: "credential-2", displayName: "Hijacked" })).toEqual({ outcome: "not_found" });
    expect(await registry.renamePasskey({ appUserId: "app-user-1", credentialId: "no-such-credential", displayName: "x" })).toEqual({ outcome: "not_found" });
    expect((await registry.findPasskeyByCredentialId("credential-2"))?.displayName).toBeNull();
  });

  it("renamePasskey refuses anything not 'active' (pending/revoking/revoked) and leaves the row untouched", async () => {
    for (const status of ["pending", "revoking", "revoked"] as const) {
      const registry = createInMemoryRealAccountRegistry();
      await registry.createAccountWithPasskey({ account: accountInput(), passkey: passkeyInput() });
      await registry.transitionPasskeyStatus({ credentialId: "credential-1", from: "active", to: status });

      expect(await registry.renamePasskey({ appUserId: "app-user-1", credentialId: "credential-1", displayName: "Old key" })).toEqual({ outcome: "not_active" });
      expect(await registry.findPasskeyByCredentialId("credential-1")).toMatchObject({ status, displayName: null });
    }
  });

  it("names are not unique: two passkeys on one account may share a name", async () => {
    const registry = createInMemoryRealAccountRegistry();
    await registry.createAccountWithPasskey({ account: accountInput(), passkey: passkeyInput() });
    const internals = getInMemoryRegistryInternals(registry);
    const primary = internals.passkeysByCredentialId.get("credential-1")!;
    internals.passkeysByCredentialId.set("credential-b", { ...primary, credentialId: "credential-b", role: "backup" });

    expect((await registry.renamePasskey({ appUserId: "app-user-1", credentialId: "credential-1", displayName: "iPhone" })).outcome).toBe("renamed");
    expect((await registry.renamePasskey({ appUserId: "app-user-1", credentialId: "credential-b", displayName: "iPhone" })).outcome).toBe("renamed");
  });

  it("never stores anything private-key- or signing-session-shaped", async () => {
    const registry = createInMemoryRealAccountRegistry();
    const { account, passkey } = await registry.createAccountWithPasskey({ account: accountInput(), passkey: passkeyInput() });
    const serialized = JSON.stringify({ account, passkey });
    expect(serialized).not.toMatch(/private|seed|sessionKey|stamper|signingKey/i);
  });
});
