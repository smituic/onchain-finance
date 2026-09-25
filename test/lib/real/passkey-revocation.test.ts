import { afterEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64Url } from "@/lib/real/bytes";
import type { RealServerConfig } from "@/lib/real/server/config";
import { createInMemoryRealAccountRegistry, type RealAccountRegistry } from "@/lib/real/server/registry";
import { createInMemoryPasskeyRevocationStore, type PasskeyRevocationStore } from "@/lib/real/server/passkey-revocation-attempts";
import { TURNKEY_STAMP_FRESHNESS_WINDOW_MS } from "@/lib/real/server/turnkey-signed-request";
import { buildAuthenticationResponseJSON, createFixtureAuthenticator, type FixtureAuthenticator } from "./fixtures/webauthn";
import { FakeTurnkey, signRequest, stampBody } from "./fixtures/turnkey-fake";

const turnkey: { fake: FakeTurnkey | null } = { fake: null };

vi.mock("@turnkey/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@turnkey/http")>();
  return {
    ...actual,
    TurnkeyClient: vi.fn().mockImplementation(function TurnkeyClientMock() {
      return {
        getUsers: (input: { organizationId: string }) => turnkey.fake!.getUsers(input),
        getActivity: (input: { organizationId: string; activityId: string }) => turnkey.fake!.getActivity(input),
      };
    }),
  };
});

const revocation = await import("@/lib/real/server/passkey-revocation");
const { readAuthenticatedRealAccount } = await import("@/lib/real/server/auth");
const { createSessionPayload, serializeSession } = await import("@/lib/real/server/session");
const { beginLogin, completeLogin } = await import("@/lib/real/server/login");
const { createInMemoryChallengeStore } = await import("@/lib/real/server/challenge-store");
const { createInMemoryRegistrationAttemptStore } = await import("@/lib/real/server/registration-attempts");

const ORIGIN = "http://localhost:3000";
const DELETE_URL = "https://api.turnkey.com/public/v1/submit/delete_authenticators";
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

type World = {
  registry: RealAccountRegistry;
  revocations: PasskeyRevocationStore;
  fake: FakeTurnkey;
  a: FixtureAuthenticator;
  b: FixtureAuthenticator;
  clock: { now: number };
  deps: { fetchImpl: typeof fetch; now: () => number; sleep: () => Promise<void>; maxPolls: number };
};

/** An account with two ACTIVE, Turnkey-mapped passkeys: A (primary) and B (backup). */
async function world(): Promise<World> {
  const registry = createInMemoryRealAccountRegistry();
  const a = createFixtureAuthenticator();
  const b = createFixtureAuthenticator();
  await registry.createAccountWithPasskey({
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
    passkey: { credentialId: a.credentialIdBase64Url, appUserId: "app-user-1", credentialPublicKey: bytesToBase64Url(a.publicKeyCose), userHandle: "handle-a", counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false },
  });
  const enrollmentStore = (await import("@/lib/real/server/backup-passkey-enrollment")).createInMemoryBackupPasskeyEnrollmentStore(registry);
  const enrollment = (await enrollmentStore.createStarted({ appUserId: "app-user-1" }))!;
  await enrollmentStore.registerCredential({
    id: enrollment.id,
    credential: { credentialId: b.credentialIdBase64Url, userHandle: "handle-b", credentialPublicKey: bytesToBase64Url(b.publicKeyCose), counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false, registrationChallenge: "c", rawClientDataJson: "d", rawAttestationObject: "e" },
  });
  await registry.transitionPasskeyStatus({ credentialId: a.credentialIdBase64Url, from: "active", to: "active", patch: { turnkeyAuthenticatorId: "authenticator-a" } });
  await registry.transitionPasskeyStatus({ credentialId: b.credentialIdBase64Url, from: "pending", to: "active", patch: { turnkeyAuthenticatorId: "authenticator-b" } });

  const fake = new FakeTurnkey("sub-org-1", "turnkey-user-1");
  fake.addAuthenticator(a.credentialIdBase64Url, "authenticator-a");
  fake.addAuthenticator(b.credentialIdBase64Url, "authenticator-b");
  turnkey.fake = fake;
  const clock = { now: Date.now() };
  return { registry, revocations: createInMemoryPasskeyRevocationStore(registry), fake, a, b, clock, deps: { fetchImpl: fake.fetchImpl, now: () => clock.now, sleep: async () => {}, maxPolls: 1 } };
}

function prepare(w: World, target: FixtureAuthenticator, session: FixtureAuthenticator) {
  return revocation.prepareRevocation({ config, registry: w.registry, revocations: w.revocations, appUserId: "app-user-1", credentialId: target.credentialIdBase64Url, sessionCredentialId: session.credentialIdBase64Url, now: () => w.clock.now });
}

async function prepareAndSign(w: World, target: FixtureAuthenticator, session: FixtureAuthenticator, opts: { signer?: FixtureAuthenticator; mutate?: (a: Record<string, unknown>) => void; url?: string } = {}) {
  const prepared = await prepare(w, target, session);
  if (prepared.outcome !== "ready") throw new Error(JSON.stringify(prepared));
  const activity = JSON.parse(JSON.stringify(prepared.activity)) as Record<string, unknown>;
  opts.mutate?.(activity);
  return { attemptId: prepared.attemptId, signed: signRequest({ authenticator: opts.signer ?? session, activity, url: opts.url ?? DELETE_URL, origin: ORIGIN, rpId: config.rpId }) };
}

function submit(w: World, target: FixtureAuthenticator, session: FixtureAuthenticator, attemptId: string, signedRequest: unknown) {
  return revocation.submitRevocation({ config, registry: w.registry, revocations: w.revocations, appUserId: "app-user-1", credentialId: target.credentialIdBase64Url, attemptId, sessionCredentialId: session.credentialIdBase64Url, signedRequest, deps: w.deps });
}

function reconcile(w: World, target: FixtureAuthenticator, attemptId: string) {
  return revocation.reconcileRevocation({ config, registry: w.registry, revocations: w.revocations, appUserId: "app-user-1", credentialId: target.credentialIdBase64Url, attemptId, deps: w.deps });
}

const status = async (w: World, who: FixtureAuthenticator) => (await w.registry.findPasskeyByCredentialId(who.credentialIdBase64Url))?.status;
const STAMP_REJECTED = "The authorization wasn't signed by your current passkey.";
const visibleAtTurnkey = async (w: World, authenticatorId: string) =>
  (await w.fake.getUsers({ organizationId: "sub-org-1" })).users[0]!.authenticators.some((a) => a.authenticatorId === authenticatorId);

/** After dispatch, attempt state and target status must always agree — and the target is never 'active' again. */
async function expectConsistent(w: World, attemptId: string, target: FixtureAuthenticator) {
  const attempt = (await w.revocations.findById(attemptId))!;
  const expected = { confirmed: "revoked", blocked: "revoking", dispatch_in_flight: "revoking" }[attempt.state as string];
  expect(expected).toBeDefined();
  expect(await status(w, target)).toBe(expected);
}

afterEach(() => {
  turnkey.fake = null;
});

describe("revocation — authority", () => {
  it("the survivor is the SESSION credential: removing the credential you're signed in with requires signing in with another one", async () => {
    const w = await world();
    const result = await prepare(w, w.a, w.a);
    expect(result).toMatchObject({ outcome: "rejected", code: "sign_in_with_other_passkey" });
    expect(await status(w, w.a)).toBe("active");
  });

  it("prepare binds the attempt to the session credential and returns only server-derived org/user/authenticator", async () => {
    const w = await world();
    const result = await prepare(w, w.b, w.a);
    if (result.outcome !== "ready") throw new Error("setup");
    expect(result.authorizingCredentialId).toBe(w.a.credentialIdBase64Url);
    expect(result.activity).toMatchObject({ type: "ACTIVITY_TYPE_DELETE_AUTHENTICATORS", organizationId: "sub-org-1", parameters: { userId: "turnkey-user-1", authenticatorIds: ["authenticator-b"] } });
  });

  it("a stolen app cookie alone cannot complete a Turnkey removal: a stamp not made by the session credential is refused and never forwarded", async () => {
    const w = await world();
    const { attemptId, signed } = await prepareAndSign(w, w.b, w.a, { signer: createFixtureAuthenticator({ credentialId: w.a.credentialId }) });
    expect((await submit(w, w.b, w.a, attemptId, signed)).outcome).toBe("rejected");
    expect(w.fake.forwarded).toHaveLength(0);
    expect(w.fake.authenticators().map((x) => x.authenticatorId)).toContain("authenticator-b");
    expect(await status(w, w.b)).toBe("active"); // a cookie alone disables nothing
  });

  it("H1: prepare/options with only an app cookie records an undispatched attempt and leaves the target fully ACTIVE", async () => {
    const w = await world();
    const session = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: w.b.credentialIdBase64Url }), config.sessionSecret);
    const prepared = await prepare(w, w.b, w.a);
    expect(prepared.outcome).toBe("ready");
    expect(await status(w, w.b)).toBe("active");
    expect(await readAuthenticatedRealAccount({ cookieValue: session, sessionSecret: config.sessionSecret, registry: w.registry })).not.toBeNull();
    expect(w.fake.forwarded).toHaveLength(0);
  });

  it("H1: a WebAuthn ceremony cancelled before submit leaves the target active, and re-opening reuses the same undispatched attempt", async () => {
    const w = await world();
    const first = await prepare(w, w.b, w.a);
    // ...user cancels the passkey prompt: nothing is submitted...
    const again = await prepare(w, w.b, w.a);
    if (first.outcome !== "ready" || again.outcome !== "ready") throw new Error("setup");
    expect(again.attemptId).toBe(first.attemptId);
    expect(await status(w, w.b)).toBe("active");
  });

  it("H1: only the session credential that owns an undispatched removal may cancel it, and cancelling changes no status", async () => {
    const w = await world();
    const prepared = await prepare(w, w.b, w.a);
    if (prepared.outcome !== "ready") throw new Error("setup");
    const cancel = (session: FixtureAuthenticator) =>
      revocation.cancelRevocation({ revocations: w.revocations, appUserId: "app-user-1", credentialId: w.b.credentialIdBase64Url, attemptId: prepared.attemptId, sessionCredentialId: session.credentialIdBase64Url });
    expect((await cancel(w.b)).outcome).toBe("rejected");
    expect((await cancel(w.a)).outcome).toBe("cancelled");
    expect(await status(w, w.b)).toBe("active");
    expect(await status(w, w.a)).toBe("active");
  });

  it("a different session credential than the one bound at prepare cannot submit", async () => {
    const w = await world();
    const c = createFixtureAuthenticator();
    const { attemptId, signed } = await prepareAndSign(w, w.b, w.a);
    expect((await revocation.submitRevocation({ config, registry: w.registry, revocations: w.revocations, appUserId: "app-user-1", credentialId: w.b.credentialIdBase64Url, attemptId, sessionCredentialId: c.credentialIdBase64Url, signedRequest: signed, deps: w.deps })).outcome).toBe("rejected");
    expect(w.fake.forwarded).toHaveLength(0);
  });

  it.each([
    ["a different target authenticator", (a: Record<string, unknown>) => ((a.parameters as Record<string, unknown>).authenticatorIds = ["authenticator-a"])],
    ["two authenticators", (a: Record<string, unknown>) => ((a.parameters as Record<string, unknown>).authenticatorIds = ["authenticator-b", "authenticator-a"])],
    ["a different organization", (a: Record<string, unknown>) => (a.organizationId = "other-org")],
    ["a different user", (a: Record<string, unknown>) => ((a.parameters as Record<string, unknown>).userId = "other-user")],
    ["a different activity type", (a: Record<string, unknown>) => (a.type = "ACTIVITY_TYPE_DELETE_USERS")],
  ])("a signed body naming %s is rejected and never forwarded", async (_label, mutate) => {
    const w = await world();
    const { attemptId, signed } = await prepareAndSign(w, w.b, w.a, { mutate });
    expect((await submit(w, w.b, w.a, attemptId, signed)).outcome).toBe("rejected");
    expect(w.fake.forwarded).toHaveLength(0);
  });

  it("an arbitrary destination URL is rejected", async () => {
    const w = await world();
    const { attemptId, signed } = await prepareAndSign(w, w.b, w.a, { url: "https://evil.example/public/v1/submit/delete_authenticators" });
    expect((await submit(w, w.b, w.a, attemptId, signed)).outcome).toBe("rejected");
    expect(w.fake.forwarded).toHaveLength(0);
  });
});

describe("revocation — last-credential concurrency", () => {
  it("racing 'remove A using B' and 'remove B using A' — both prepared and both validly stamped — can never leave zero active credentials", async () => {
    for (let i = 0; i < 20; i += 1) {
      const w = await world();
      const aByB = await prepareAndSign(w, w.a, w.b);
      const bByA = await prepareAndSign(w, w.b, w.a);
      expect(await status(w, w.a)).toBe("active");
      expect(await status(w, w.b)).toBe("active");
      const results = await Promise.all([submit(w, w.a, w.b, aByB.attemptId, aByB.signed), submit(w, w.b, w.a, bByA.attemptId, bByA.signed)]);
      expect(results.filter((r) => r.outcome === "rejected")).toHaveLength(1);
      expect(w.fake.forwarded).toHaveLength(1);
      const active = (await w.registry.findPasskeysByAppUserId("app-user-1")).filter((p) => p.status === "active" && p.turnkeyAuthenticatorId);
      expect(active).toHaveLength(1);
      expect(w.fake.authenticators()).toHaveLength(1);
    }
  });

  it("a passkey whose removal was dispatched can't authorize another removal", async () => {
    const w = await world();
    const { attemptId, signed } = await prepareAndSign(w, w.b, w.a);
    w.fake.nextMode = "pending_activity";
    await submit(w, w.b, w.a, attemptId, signed);
    expect(await status(w, w.b)).toBe("revoking");
    expect((await prepare(w, w.a, w.b)).outcome).toBe("rejected");
  });

  it("an unmapped credential (no confirmed Turnkey mapping) can neither be removed nor authorize a removal", async () => {
    const w = await world();
    const internals = (await import("@/lib/real/server/registry")).getInMemoryRegistryInternals(w.registry);
    const a = internals.passkeysByCredentialId.get(w.a.credentialIdBase64Url)!;
    internals.passkeysByCredentialId.set(a.credentialId, { ...a, turnkeyAuthenticatorId: null });
    expect((await prepare(w, w.b, w.a)).outcome).toBe("rejected");
    expect((await prepare(w, w.a, w.b)).outcome).toBe("rejected");
  });
});

describe("revocation — confirmation standard (completed delete activity AND confirmed absence)", () => {
  it("dispatch is durably recorded as in flight BEFORE the POST, and the exact signed bytes are forwarded", async () => {
    const w = await world();
    const { attemptId, signed } = await prepareAndSign(w, w.b, w.a);
    let atForward: unknown = null;
    w.fake.onForward = async () => {
      atForward = await w.revocations.findById(attemptId);
    };
    expect((await submit(w, w.b, w.a, attemptId, signed)).outcome).toBe("revoked");
    expect(atForward).toMatchObject({ state: "dispatch_in_flight", turnkeyRequestBody: signed.body });
    expect(w.fake.forwarded[0]).toMatchObject({ url: DELETE_URL, body: signed.body });
  });

  it("completed delete + confirmed absence => Removed; the removed credential can't sign in and its old sessions are rejected; the survivor still works", async () => {
    const w = await world();
    const oldSession = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: w.b.credentialIdBase64Url }), config.sessionSecret);
    const survivorSession = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: w.a.credentialIdBase64Url }), config.sessionSecret);
    const { attemptId, signed } = await prepareAndSign(w, w.b, w.a);
    expect((await submit(w, w.b, w.a, attemptId, signed)).outcome).toBe("revoked");
    expect(await status(w, w.b)).toBe("revoked");
    expect(await readAuthenticatedRealAccount({ cookieValue: oldSession, sessionSecret: config.sessionSecret, registry: w.registry })).toBeNull();
    expect(await readAuthenticatedRealAccount({ cookieValue: survivorSession, sessionSecret: config.sessionSecret, registry: w.registry })).not.toBeNull();

    const challengeStore = createInMemoryChallengeStore();
    const attempts = createInMemoryRegistrationAttemptStore();
    const login = async (who: FixtureAuthenticator, handle: string) => {
      const { optionsJSON } = await beginLogin({ config, challengeStore });
      const response = buildAuthenticationResponseJSON({ authenticator: who, challenge: optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId, userHandle: handle });
      return (await completeLogin({ config, challengeStore, registry: w.registry, attempts, response })).outcome;
    };
    expect(await login(w.b, "handle-b")).toBe("rejected");
    expect(await login(w.a, "handle-a")).toBe("verified");
  });

  it("once a verified removal is dispatched ('revoking'), the target's sessions are rejected — but it is NOT reported as removed", async () => {
    const w = await world();
    const session = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: w.b.credentialIdBase64Url }), config.sessionSecret);
    const { attemptId, signed } = await prepareAndSign(w, w.b, w.a);
    w.fake.nextMode = "pending_activity";
    await submit(w, w.b, w.a, attemptId, signed);
    expect(await readAuthenticatedRealAccount({ cookieValue: session, sessionSecret: config.sessionSecret, registry: w.registry })).toBeNull();
    expect(await status(w, w.b)).toBe("revoking");
  });

  it("completed delete but the authenticator is still visible (propagation lag) => pending, never Removed", async () => {
    const w = await world();
    const { attemptId, signed } = await prepareAndSign(w, w.b, w.a);
    const originalGetUsers = w.fake.getUsers;
    const snapshot = w.fake.authenticators().slice();
    w.fake.getUsers = async () => ({ users: [{ userId: "turnkey-user-1", authenticators: snapshot }] });
    expect((await submit(w, w.b, w.a, attemptId, signed)).outcome).toBe("pending");
    expect(await status(w, w.b)).toBe("revoking");
    w.fake.getUsers = originalGetUsers;
    expect((await reconcile(w, w.b, attemptId)).outcome).toBe("revoked");
  });

  it("a FAILED delete activity with the target no longer observed is contradictory: blocked for review, still not Removed", async () => {
    const w = await world();
    const { attemptId, signed } = await prepareAndSign(w, w.b, w.a);
    w.fake.nextMode = "fail_activity";
    w.fake.onForward = () => {
      w.fake.users.set("turnkey-user-1", w.fake.authenticators().filter((x) => x.authenticatorId !== "authenticator-b"));
    };
    expect((await submit(w, w.b, w.a, attemptId, signed)).outcome).toBe("blocked");
    expect(await status(w, w.b)).toBe("revoking");
  });

  it("a dispatched removal can't be cancelled", async () => {
    const w = await world();
    const { attemptId, signed } = await prepareAndSign(w, w.b, w.a);
    w.fake.nextMode = "pending_activity";
    await submit(w, w.b, w.a, attemptId, signed);
    expect((await revocation.cancelRevocation({ revocations: w.revocations, appUserId: "app-user-1", credentialId: w.b.credentialIdBase64Url, attemptId, sessionCredentialId: w.a.credentialIdBase64Url })).outcome).toBe("rejected");
    expect(await status(w, w.b)).toBe("revoking");
  });

  it("exact-bytes binding: a body re-serialized after stamping (same JSON meaning, different bytes) is rejected and never forwarded", async () => {
    for (const reserialize of [(b: string) => JSON.stringify(JSON.parse(b), null, 1), (b: string) => {
      const o = JSON.parse(b) as Record<string, unknown>;
      return JSON.stringify(Object.fromEntries(Object.entries(o).reverse()));
    }]) {
      const w = await world();
      const { attemptId, signed } = await prepareAndSign(w, w.b, w.a);
      const altered = reserialize(signed.body);
      expect(altered).not.toBe(signed.body);
      expect(JSON.parse(altered)).toEqual(JSON.parse(signed.body));
      // Same meaning passes every semantic check; only the stamp — bound to the exact bytes — refuses it.
      expect(await submit(w, w.b, w.a, attemptId, { ...signed, body: altered })).toEqual({ outcome: "rejected", reason: STAMP_REJECTED });
      expect(w.fake.forwarded).toHaveLength(0);
      expect(await status(w, w.b)).toBe("active");
    }
  });

  it("the account's owner and Safe are unchanged by a completed removal", async () => {
    const w = await world();
    const before = await w.registry.findAccountByAppUserId("app-user-1");
    const { attemptId, signed } = await prepareAndSign(w, w.b, w.a);
    await submit(w, w.b, w.a, attemptId, signed);
    expect(await w.registry.findAccountByAppUserId("app-user-1")).toEqual(before);
  });
});

describe("revocation — app role after a confirmed removal (metadata only)", () => {
  const passkey = async (w: World, who: FixtureAuthenticator) => (await w.registry.findPasskeyByCredentialId(who.credentialIdBase64Url))!;

  it("removing the primary using the backup: target revoked (row kept), sole survivor promoted to primary — nothing else about it changes", async () => {
    const w = await world();
    const accountBefore = await w.registry.findAccountByAppUserId("app-user-1");
    const survivorBefore = await passkey(w, w.b);
    expect(survivorBefore.role).toBe("backup");

    const { attemptId, signed } = await prepareAndSign(w, w.a, w.b);
    expect((await submit(w, w.a, w.b, attemptId, signed)).outcome).toBe("revoked");

    // Revoked row is history, never deleted — and still what the attempt points at.
    expect(await passkey(w, w.a)).toMatchObject({ status: "revoked", role: "primary", turnkeyAuthenticatorId: "authenticator-a" });
    expect((await w.revocations.findById(attemptId))).toMatchObject({ state: "confirmed", targetCredentialId: w.a.credentialIdBase64Url });
    // Promotion is role only: identity, status, Turnkey mapping, key material, owner and Safe unchanged.
    expect(await passkey(w, w.b)).toEqual({ ...survivorBefore, role: "primary" });
    expect(await w.registry.findAccountByAppUserId("app-user-1")).toEqual(accountBefore);
    expect(w.fake.forwarded).toHaveLength(1); // only the one delete — promotion makes no Turnkey call
  });

  it("removing the backup while the primary stays active: no promotion, the primary stays primary", async () => {
    const w = await world();
    const { attemptId, signed } = await prepareAndSign(w, w.b, w.a);
    expect((await submit(w, w.b, w.a, attemptId, signed)).outcome).toBe("revoked");
    expect(await passkey(w, w.a)).toMatchObject({ status: "active", role: "primary" });
    expect(await passkey(w, w.b)).toMatchObject({ status: "revoked", role: "backup" });
  });

  it("a dispatched but unconfirmed primary removal promotes nothing yet (the old primary may still authorize)", async () => {
    const w = await world();
    const { attemptId, signed } = await prepareAndSign(w, w.a, w.b);
    w.fake.nextMode = "pending_activity";
    await submit(w, w.a, w.b, attemptId, signed);
    expect(await passkey(w, w.a)).toMatchObject({ status: "revoking", role: "primary" });
    expect((await passkey(w, w.b)).role).toBe("backup");
  });

  it("after the promotion, adding another passkey creates it as backup and the promoted survivor stays primary", async () => {
    const w = await world();
    const { attemptId, signed } = await prepareAndSign(w, w.a, w.b);
    await submit(w, w.a, w.b, attemptId, signed);

    const c = createFixtureAuthenticator();
    const enrollments = (await import("@/lib/real/server/backup-passkey-enrollment")).createInMemoryBackupPasskeyEnrollmentStore(w.registry);
    const enrollment = (await enrollments.createStarted({ appUserId: "app-user-1" }))!;
    await enrollments.registerCredential({
      id: enrollment.id,
      credential: { credentialId: c.credentialIdBase64Url, userHandle: "handle-c", credentialPublicKey: bytesToBase64Url(c.publicKeyCose), counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false, registrationChallenge: "c", rawClientDataJson: "d", rawAttestationObject: "e" },
    });
    await w.registry.transitionPasskeyStatus({ credentialId: c.credentialIdBase64Url, from: "pending", to: "active", patch: { turnkeyAuthenticatorId: "authenticator-c" } });

    expect(await passkey(w, c)).toMatchObject({ status: "active", role: "backup" });
    expect(await passkey(w, w.b)).toMatchObject({ status: "active", role: "primary" });
  });

  it("a pending setup in progress during a primary removal is never promoted — the active survivor is", async () => {
    const w = await world();
    const { attemptId, signed } = await prepareAndSign(w, w.a, w.b);
    w.fake.nextMode = "pending_activity";
    await submit(w, w.a, w.b, attemptId, signed);

    const c = createFixtureAuthenticator();
    const enrollments = (await import("@/lib/real/server/backup-passkey-enrollment")).createInMemoryBackupPasskeyEnrollmentStore(w.registry);
    const enrollment = (await enrollments.createStarted({ appUserId: "app-user-1" }))!;
    await enrollments.registerCredential({
      id: enrollment.id,
      credential: { credentialId: c.credentialIdBase64Url, userHandle: "handle-c", credentialPublicKey: bytesToBase64Url(c.publicKeyCose), counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false, registrationChallenge: "c", rawClientDataJson: "d", rawAttestationObject: "e" },
    });

    const activityId = (await w.revocations.findById(attemptId))!.turnkeyActivityId!;
    Object.assign(w.fake.activities.get(activityId)!, { status: "ACTIVITY_STATUS_COMPLETED", result: { deleteAuthenticatorsResult: { authenticatorIds: ["authenticator-a"] } } });
    w.fake.users.set("turnkey-user-1", w.fake.authenticators().filter((x) => x.authenticatorId !== "authenticator-a"));

    expect((await reconcile(w, w.a, attemptId)).outcome).toBe("revoked");
    expect(await passkey(w, w.b)).toMatchObject({ status: "active", role: "primary" });
    expect(await passkey(w, c)).toMatchObject({ status: "pending", role: "backup" });
  });
});

describe("revocation — one-way after dispatch: a dispatched target is never automatically restored", () => {
  it.each(["ACTIVITY_STATUS_FAILED", "ACTIVITY_STATUS_REJECTED"])(
    "first-forward %s with the target observed PRESENT => blocked, target stays revoking (the browser could have sent the same signed bytes itself)",
    async (terminal) => {
      const w = await world();
      const session = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: w.b.credentialIdBase64Url }), config.sessionSecret);
      const { attemptId, signed } = await prepareAndSign(w, w.b, w.a);
      w.fake.nextMode = "pending_activity";
      await submit(w, w.b, w.a, attemptId, signed);
      expect(w.fake.forwarded).toHaveLength(1); // exactly one send, from our own first forward
      w.fake.activities.get((await w.revocations.findById(attemptId))!.turnkeyActivityId!)!.status = terminal;
      expect(await visibleAtTurnkey(w, "authenticator-b")).toBe(true);

      const result = await reconcile(w, w.b, attemptId);
      expect(result.outcome).toBe("blocked");
      expect(await w.revocations.findById(attemptId)).toMatchObject({ state: "blocked", failureReason: "delete_activity_failed", turnkeyActivityStatus: terminal });
      expect(await status(w, w.b)).toBe("revoking"); // not Active, not Removed
      expect(await readAuthenticatedRealAccount({ cookieValue: session, sessionSecret: config.sessionSecret, registry: w.registry })).toBeNull();
      expect((await prepare(w, w.b, w.a)).outcome).toBe("rejected"); // no automatic (or manual) new delete
      expect(w.fake.forwarded).toHaveLength(1);
      expect(await reconcile(w, w.b, attemptId)).toEqual(result); // stable
    },
  );

  it("1: the delete lands but every response is lost (no activity id) and getUsers still shows the target => NEVER restored to active; blocked for review, not Removed, no new deletion", async () => {
    const w = await world();
    const { attemptId, signed } = await prepareAndSign(w, w.b, w.a);
    w.fake.lagReads = true;
    w.fake.nextMode = "lose_response_after_apply";
    expect((await submit(w, w.b, w.a, attemptId, signed)).outcome).toBe("pending");
    expect(w.fake.authenticators().map((a) => a.authenticatorId)).not.toContain("authenticator-b"); // it really was deleted...
    expect(await visibleAtTurnkey(w, "authenticator-b")).toBe(true); // ...but a stale read still shows it

    w.clock.now += TURNKEY_STAMP_FRESHNESS_WINDOW_MS + 1;
    const forwards = w.fake.forwarded.length;
    const result = await reconcile(w, w.b, attemptId);
    expect(result.outcome).toBe("blocked");
    expect(await w.revocations.findById(attemptId)).toMatchObject({ state: "blocked", failureReason: "no_activity_receipt", turnkeyActivityId: null, turnkeyRequestStamp: null });
    expect(await status(w, w.b)).toBe("revoking"); // not Active, not Removed
    expect(w.fake.forwarded).toHaveLength(forwards); // no replay, no re-stamp after the window
    expect((await prepare(w, w.b, w.a)).outcome).toBe("rejected"); // no silent new deletion
    expect(await reconcile(w, w.b, attemptId)).toEqual(result); // stable
  });

  it("2: the same-body replay returns FAILED with the target present => blocked, target stays revoking", async () => {
    // Whether or not the original actually landed, the outcome is the same.
    for (const firstMode of ["lose_response_after_apply", "lose_response_before_apply"] as const) {
      const w = await world();
      const { attemptId, signed } = await prepareAndSign(w, w.b, w.a);
      w.fake.lagReads = true;
      w.fake.dedupeByBody = false;
      w.fake.modeQueue = [firstMode, "fail_activity"];
      const result = await submit(w, w.b, w.a, attemptId, signed);
      expect(w.fake.forwarded.map((f) => f.body)).toEqual([signed.body, signed.body]);
      expect(result).toMatchObject({ outcome: "blocked" });
      const attempt = (await w.revocations.findById(attemptId))!;
      expect(attempt).toMatchObject({ state: "blocked", failureReason: "delete_activity_failed" });
      expect(w.fake.activities.get(attempt.turnkeyActivityId!)?.status).toBe("ACTIVITY_STATUS_FAILED");
      expect(await visibleAtTurnkey(w, "authenticator-b")).toBe(true);
      expect(await status(w, w.b)).toBe("revoking");
    }
  });

  it("a replay racing the first forward, with the first forward then reporting FAILED => blocked, target stays revoking", async () => {
    const w = await world();
    const { attemptId, signed } = await prepareAndSign(w, w.b, w.a);
    w.fake.lagReads = true;
    w.fake.dedupeByBody = false;
    // Forward #1 (submit) triggers a concurrent reconcile whose replay lands the
    // delete with its response lost; forward #1 itself then comes back FAILED.
    w.fake.modeQueue = ["lose_response_after_apply", "fail_activity"];
    w.fake.onForward = async () => {
      if (w.fake.forwarded.length === 1) await reconcile(w, w.b, attemptId);
    };
    expect((await submit(w, w.b, w.a, attemptId, signed)).outcome).toBe("blocked");
    expect(w.fake.authenticators().map((a) => a.authenticatorId)).not.toContain("authenticator-b"); // really deleted...
    expect(await visibleAtTurnkey(w, "authenticator-b")).toBe(true); // ...but a stale read shows it
    expect(await status(w, w.b)).toBe("revoking");
  });

  it("recordActivity is first-writer-wins: a concurrent replay's activity id never overwrites the recorded one", async () => {
    const w = await world();
    const { attemptId, signed } = await prepareAndSign(w, w.b, w.a);
    w.fake.nextMode = "lose_response_before_apply";
    await submit(w, w.b, w.a, attemptId, signed);
    expect(await w.revocations.recordActivity({ id: attemptId, activityId: "first", activityStatus: "ACTIVITY_STATUS_PENDING" })).toMatchObject({ turnkeyActivityId: "first", turnkeyRequestStamp: null });
    expect(await w.revocations.recordActivity({ id: attemptId, activityId: "other", activityStatus: "ACTIVITY_STATUS_COMPLETED" })).toBeNull();
    expect((await w.revocations.findById(attemptId))?.turnkeyActivityId).toBe("first");
  });

  it("4: COMPLETED but getUsers still shows the target (lag) => stays revoking/unconfirmed across reconciles — neither Active nor Removed; 5: once it reads absent => Removed", async () => {
    const w = await world();
    const { attemptId, signed } = await prepareAndSign(w, w.b, w.a);
    w.fake.lagReads = true;
    expect((await submit(w, w.b, w.a, attemptId, signed)).outcome).toBe("pending");
    for (let i = 0; i < 3; i += 1) {
      expect((await reconcile(w, w.b, attemptId)).outcome).toBe("pending");
      expect((await w.revocations.findById(attemptId))?.state).toBe("dispatch_in_flight");
      expect(await status(w, w.b)).toBe("revoking");
    }
    w.fake.propagate();
    expect((await reconcile(w, w.b, attemptId)).outcome).toBe("revoked");
    expect(await status(w, w.b)).toBe("revoked");
  });

  it("6: no activity id and the target reads ABSENT => still not Removed without a completed delete receipt; blocked for review", async () => {
    const w = await world();
    const { attemptId, signed } = await prepareAndSign(w, w.b, w.a);
    w.fake.nextMode = "lose_response_before_apply";
    await submit(w, w.b, w.a, attemptId, signed);
    w.fake.users.set("turnkey-user-1", w.fake.authenticators().filter((x) => x.authenticatorId !== "authenticator-b")); // vanished out of band
    w.clock.now += TURNKEY_STAMP_FRESHNESS_WINDOW_MS + 1;
    expect((await reconcile(w, w.b, attemptId)).outcome).toBe("blocked");
    expect(await status(w, w.b)).toBe("revoking");
    expect((await w.revocations.findById(attemptId))?.state).toBe("blocked");
  });

  it("6: BEFORE dispatch — a cancelled prompt, an explicit cancel, or a refused authorization — the target stays active", async () => {
    const w = await world();
    const prepared = await prepare(w, w.b, w.a); // ...then the WebAuthn prompt is cancelled: nothing submitted
    if (prepared.outcome !== "ready") throw new Error("setup");
    expect(await status(w, w.b)).toBe("active");

    const forged = await prepareAndSign(w, w.b, w.a, { signer: createFixtureAuthenticator({ credentialId: w.a.credentialId }) });
    expect((await submit(w, w.b, w.a, forged.attemptId, forged.signed)).outcome).toBe("rejected");
    expect(await status(w, w.b)).toBe("active");

    const cancelled = await revocation.cancelRevocation({ revocations: w.revocations, appUserId: "app-user-1", credentialId: w.b.credentialIdBase64Url, attemptId: prepared.attemptId, sessionCredentialId: w.a.credentialIdBase64Url });
    expect(cancelled.outcome).toBe("cancelled");
    expect(await status(w, w.b)).toBe("active");
    expect(w.fake.forwarded).toHaveLength(0);
  });

  it("an unknown outcome still inside the replay window stays pending (replayed byte-for-byte, never re-stamped)", async () => {
    const w = await world();
    const { attemptId, signed } = await prepareAndSign(w, w.b, w.a);
    w.fake.nextMode = "lose_response_before_apply";
    expect((await submit(w, w.b, w.a, attemptId, signed)).outcome).toBe("pending");
    expect((await reconcile(w, w.b, attemptId)).outcome).toBe("pending");
    expect(new Set(w.fake.forwarded.map((f) => f.body))).toEqual(new Set([signed.body]));
    expect(await status(w, w.b)).toBe("revoking");
  });

  it.each([
    [
      "first-forward FAILED, target present",
      (w: World) => {
        w.fake.nextMode = "pending_activity";
      },
      (w: World, activityId: string) => {
        w.fake.activities.get(activityId)!.status = "ACTIVITY_STATUS_FAILED";
      },
      false,
    ],
    [
      "first-forward COMPLETED, target absent",
      (w: World) => {
        w.fake.nextMode = "pending_activity";
      },
      (w: World, activityId: string) => {
        Object.assign(w.fake.activities.get(activityId)!, { status: "ACTIVITY_STATUS_COMPLETED", result: { deleteAuthenticatorsResult: { authenticatorIds: ["authenticator-b"] } } });
        w.fake.users.set("turnkey-user-1", w.fake.authenticators().filter((x) => x.authenticatorId !== "authenticator-b"));
      },
      false,
    ],
    [
      "no activity id, window expired",
      (w: World) => {
        w.fake.nextMode = "lose_response_before_apply";
      },
      () => {},
      true,
    ],
  ])("concurrent reconciles of the same uncertain attempt converge on ONE outcome (%s)", async (_label, arrange, resolve, expire) => {
    for (let round = 0; round < 5; round += 1) {
      const w = await world();
      const { attemptId, signed } = await prepareAndSign(w, w.b, w.a);
      arrange(w);
      await submit(w, w.b, w.a, attemptId, signed);
      resolve(w, (await w.revocations.findById(attemptId))!.turnkeyActivityId ?? "");
      if (expire) w.clock.now += TURNKEY_STAMP_FRESHNESS_WINDOW_MS + 1;
      const results = await Promise.all(Array.from({ length: 4 }, () => reconcile(w, w.b, attemptId)));
      expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
      await expectConsistent(w, attemptId, w.b);
    }
  });
});

describe("revocation — duplicate JSON member names in the signed body", () => {
  const variants: Array<[string, (body: string) => string]> = [
    ["a root duplicate", (b) => b.replace('"organizationId":"sub-org-1"', '"organizationId":"other-org","organizationId":"sub-org-1"')],
    // Grok's example: our last-key-wins parse sees TARGET, another parser could see SURVIVOR.
    ["a nested duplicate", (b) => b.replace('"authenticatorIds":["authenticator-b"]', '"authenticatorIds":["authenticator-a"],"authenticatorIds":["authenticator-b"]')],
    ["an escaped spelling of the same name", (b) => b.replace('"authenticatorIds":["authenticator-b"]', '"authenticatorIds":["authenticator-a"],"authenticator\\u0049ds":["authenticator-b"]')],
  ];

  it.each(variants)("%s is rejected before semantic validation, state is unchanged, and nothing is forwarded — even though it is validly stamped and JSON.parse reads it as the correct removal", async (_label, alter) => {
    const w = await world();
    const { attemptId, signed } = await prepareAndSign(w, w.b, w.a);
    const body = alter(signed.body);
    expect(body).not.toBe(signed.body);
    expect(JSON.parse(body)).toEqual(JSON.parse(signed.body)); // last-key-wins view passes every semantic check
    const duplicated = { ...signed, body, stamp: stampBody({ authenticator: w.a, body, origin: ORIGIN, rpId: config.rpId }) }; // genuinely signed bytes
    expect(await submit(w, w.b, w.a, attemptId, duplicated)).toEqual({ outcome: "rejected", reason: "The signed request is not acceptable." });
    expect(w.fake.forwarded).toHaveLength(0);
    expect(await status(w, w.b)).toBe("active");
    expect(await status(w, w.a)).toBe("active");
    expect((await w.revocations.findById(attemptId))?.state).toBe("authorization_needed");
  });
});
