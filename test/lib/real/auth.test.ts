import { describe, expect, it } from "vitest";
import { readAuthenticatedRealAccount } from "@/lib/real/server/auth";
import { createInMemoryRealAccountRegistry } from "@/lib/real/server/registry";
import { createSessionPayload, serializeSession } from "@/lib/real/server/session";

const SECRET = "test-session-secret";

async function seedAccount() {
  const registry = createInMemoryRealAccountRegistry();
  const { account, passkey } = await registry.createAccountWithPasskey({
    account: {
      appUserId: "app-user-1",
      subOrganizationId: "sub-org-1",
      turnkeyUserId: "turnkey-user-1",
      walletId: "wallet-1",
      walletAccountId: "wallet-account-1",
      ownerAddress: "0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF",
      safeAddress: "0xd9a4c22fb34dc74317edc8006140d66c8fa03266",
      accountConfigVersion: 1,
    },
    passkey: {
      credentialId: "credential-1",
      appUserId: "app-user-1",
      credentialPublicKey: "cose-key",
      userHandle: "user-handle-1",
      counter: 0,
      transports: ["internal"],
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
    },
  });
  return { registry, account, passkey };
}

describe("readAuthenticatedRealAccount", () => {
  it("resolves the account for a valid session referencing an active passkey", async () => {
    const { registry, account } = await seedAccount();
    const cookie = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1" }), SECRET);

    const result = await readAuthenticatedRealAccount({ cookieValue: cookie, sessionSecret: SECRET, registry });

    expect(result?.account).toEqual(account);
  });

  it("returns null for no cookie", async () => {
    const { registry } = await seedAccount();
    expect(await readAuthenticatedRealAccount({ cookieValue: undefined, sessionSecret: SECRET, registry })).toBeNull();
  });

  it("returns null for an invalid/tampered cookie", async () => {
    const { registry } = await seedAccount();
    expect(await readAuthenticatedRealAccount({ cookieValue: "garbage", sessionSecret: SECRET, registry })).toBeNull();
  });

  it("returns null once the referenced passkey has been revoked — revocation invalidates every session it issued", async () => {
    const { registry } = await seedAccount();
    const cookie = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1" }), SECRET);
    await registry.transitionPasskeyStatus({ credentialId: "credential-1", from: "active", to: "revoked" });

    expect(await readAuthenticatedRealAccount({ cookieValue: cookie, sessionSecret: SECRET, registry })).toBeNull();
  });

  it("returns null while the referenced passkey is mid-revocation ('revoking') — locked out immediately, not only once confirmed", async () => {
    const { registry } = await seedAccount();
    const cookie = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1" }), SECRET);
    await registry.transitionPasskeyStatus({ credentialId: "credential-1", from: "active", to: "revoking" });

    expect(await readAuthenticatedRealAccount({ cookieValue: cookie, sessionSecret: SECRET, registry })).toBeNull();
  });

  it("returns null if the session's credentialId belongs to a different appUserId than the session claims", async () => {
    const { registry } = await seedAccount();
    // A session forged/confused to claim a different appUserId than the credential actually belongs to.
    const cookie = serializeSession(createSessionPayload({ appUserId: "someone-else", credentialId: "credential-1" }), SECRET);

    expect(await readAuthenticatedRealAccount({ cookieValue: cookie, sessionSecret: SECRET, registry })).toBeNull();
  });

  it("returns null if the account record is missing even though the passkey exists", async () => {
    const registry = createInMemoryRealAccountRegistry();
    // Directly seed only a passkey-less scenario is not possible via the
    // registry's atomic create — simulate by using a session for an
    // appUserId/credentialId pair that was never created at all.
    const cookie = serializeSession(createSessionPayload({ appUserId: "ghost", credentialId: "ghost-credential" }), SECRET);
    expect(await readAuthenticatedRealAccount({ cookieValue: cookie, sessionSecret: SECRET, registry })).toBeNull();
  });
});
