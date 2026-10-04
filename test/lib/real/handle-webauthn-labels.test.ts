import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { bytesToBase64Url } from "@/lib/real/bytes";
import { createInMemoryAccountHandleStore, type AccountHandleStore } from "@/lib/real/server/account-handles";
import { createInMemoryBackupPasskeyEnrollmentStore, type BackupPasskeyEnrollmentStore } from "@/lib/real/server/backup-passkey-enrollment";
import { createInMemoryChallengeStore, type ChallengeStore } from "@/lib/real/server/challenge-store";
import { isRealServerConfig, readRealServerConfig, type RealServerConfig } from "@/lib/real/server/config";
import { beginRegistration } from "@/lib/real/server/registration";
import { createInMemoryRealAccountRegistry, type RealAccountRegistry } from "@/lib/real/server/registry";
import { buildCreateSubOrganizationBody } from "@/lib/real/server/turnkey-provisioning";
import { buildAuthenticationResponseJSON, buildRegistrationResponseJSON, createFixtureAuthenticator, type FixtureAuthenticator } from "./fixtures/webauthn";
import { FakeTurnkey, signRequest } from "./fixtures/turnkey-fake";

/**
 * Account Handles vs. WebAuthn/Turnkey: a handle only ever changes the
 * PRESENTATION values of a new backup passkey's WebAuthn user entity
 * (user.name / user.displayName). It never changes user.id, never touches
 * primary registration, and never reaches any Turnkey request, stored
 * request body, or provisioning evidence.
 */
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

const pipeline = await import("@/lib/real/server/backup-passkey-pipeline");

const ORIGIN = "http://localhost:3000";
const OWNER = privateKeyToAccount("0x119bb329df425b685a3f3483fba01deeb1db47d608cfb051da9ad4a12995238a");
const SAFE = "0xd9a4c22fb34dc74317edc8006140d66c8fa03266";
const CREATE_URL = "https://api.turnkey.com/public/v1/submit/create_authenticators";
const APP_USER = "app-user-1";
const PRIMARY_USER_HANDLE = "primary-user-handle";
/** Distinctive on purpose, so a substring search over a Turnkey payload can't false-positive or false-negative. */
const HANDLE = "zq_handle_probe_77";
const DISPLAY_NAME = "Zq Display Probe";

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
  enrollments: BackupPasskeyEnrollmentStore;
  handles: AccountHandleStore;
  challengeStore: ChallengeStore;
  fake: FakeTurnkey;
  sent: string[];
  primary: FixtureAuthenticator;
  deps: { fetchImpl: typeof fetch; now: () => number; sleep: () => Promise<void>; maxPolls: number };
};

async function world(): Promise<World> {
  const registry = createInMemoryRealAccountRegistry();
  const primary = createFixtureAuthenticator();
  await registry.createAccountWithPasskey({
    account: { appUserId: APP_USER, subOrganizationId: "sub-org-1", turnkeyUserId: "turnkey-user-1", walletId: "wallet-1", walletAccountId: "wallet-account-1", ownerAddress: OWNER.address, safeAddress: SAFE, accountConfigVersion: 1 },
    passkey: { credentialId: primary.credentialIdBase64Url, appUserId: APP_USER, credentialPublicKey: bytesToBase64Url(primary.publicKeyCose), userHandle: PRIMARY_USER_HANDLE, counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false },
  });
  const fake = new FakeTurnkey("sub-org-1", "turnkey-user-1");
  fake.addAuthenticator(primary.credentialIdBase64Url, "authenticator-primary");
  await registry.transitionPasskeyStatus({ credentialId: primary.credentialIdBase64Url, from: "active", to: "active", patch: { turnkeyAuthenticatorId: "authenticator-primary" } });
  turnkey.fake = fake;
  const sent: string[] = [];
  const fetchImpl = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    sent.push(`${url}\n${init.body}\n${JSON.stringify(init.headers)}`);
    return fake.fetchImpl(url as never, init as never);
  }) as unknown as typeof fetch;
  return {
    registry,
    enrollments: createInMemoryBackupPasskeyEnrollmentStore(registry),
    handles: createInMemoryAccountHandleStore(registry),
    challengeStore: createInMemoryChallengeStore(),
    fake,
    sent,
    primary,
    deps: { fetchImpl, now: () => Date.now(), sleep: async () => {}, maxPolls: 1 },
  };
}

async function begin(w: World, withHandles: boolean | (() => AccountHandleStore)) {
  const prepared = await pipeline.prepareBackupStepUp({ config, challengeStore: w.challengeStore, registry: w.registry, appUserId: APP_USER, sessionCredentialId: w.primary.credentialIdBase64Url });
  if (prepared.outcome !== "ready") throw new Error(JSON.stringify(prepared));
  const stepUpResponse = buildAuthenticationResponseJSON({ authenticator: w.primary, challenge: prepared.optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId, userHandle: PRIMARY_USER_HANDLE });
  const begun = await pipeline.beginBackupEnrollment({
    config,
    challengeStore: w.challengeStore,
    registry: w.registry,
    enrollments: w.enrollments,
    ...(withHandles === false ? {} : { handles: withHandles === true ? () => w.handles : withHandles }),
    appUserId: APP_USER,
    sessionCredentialId: w.primary.credentialIdBase64Url,
    stepUpResponse,
  });
  if (begun.outcome !== "started") throw new Error(JSON.stringify(begun));
  return begun;
}

const claim = (w: World) => w.handles.claim({ handle: HANDLE, appUserId: APP_USER, credentialId: w.primary.credentialIdBase64Url });

afterEach(() => {
  turnkey.fake = null;
});

describe("backup passkey WebAuthn labels", () => {
  it("WITHOUT a handle the naming is exactly what it always was", async () => {
    const w = await world();
    const begun = await begin(w, true);
    const placeholder = `real-backup-${begun.enrollmentId.slice(0, 8)}`;
    expect(begun.optionsJSON.user.name).toBe(placeholder);
    expect(begun.optionsJSON.user.displayName).toBe(placeholder);
  });

  it("without the handle store at all (older callers) the naming is also unchanged", async () => {
    const w = await world();
    await claim(w);
    const begun = await begin(w, false);
    expect(begun.optionsJSON.user.name).toBe(`real-backup-${begun.enrollmentId.slice(0, 8)}`);
  });

  it("a display name alone (no handle) does not change the naming", async () => {
    const w = await world();
    await w.handles.setDisplayName({ appUserId: APP_USER, displayName: DISPLAY_NAME });
    const begun = await begin(w, true);
    expect(begun.optionsJSON.user.name).toBe(`real-backup-${begun.enrollmentId.slice(0, 8)}`);
    expect(begun.optionsJSON.user.displayName).toBe(begun.optionsJSON.user.name);
  });

  it("WITH a handle: user.name = '@handle' and user.displayName = '@handle' when no display name is set", async () => {
    const w = await world();
    await claim(w);
    const begun = await begin(w, true);
    expect(begun.optionsJSON.user.name).toBe(`@${HANDLE}`);
    expect(begun.optionsJSON.user.displayName).toBe(`@${HANDLE}`);
  });

  it("WITH a handle and a display name: user.name = '@handle', user.displayName = the display name", async () => {
    const w = await world();
    await claim(w);
    await w.handles.setDisplayName({ appUserId: APP_USER, displayName: DISPLAY_NAME });
    const begun = await begin(w, true);
    expect(begun.optionsJSON.user.name).toBe(`@${HANDLE}`);
    expect(begun.optionsJSON.user.displayName).toBe(DISPLAY_NAME);
  });

  it("user.id stays a fresh random per-credential value — never derived from the handle, the account id, or the primary's user handle", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 4; i += 1) {
      const w = await world();
      await claim(w);
      const begun = await begin(w, true);
      const id = begun.optionsJSON.user.id;
      expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
      expect(id).not.toBe(PRIMARY_USER_HANDLE);
      expect(id).not.toBe(bytesToBase64Url(new TextEncoder().encode(HANDLE)));
      expect(id).not.toBe(bytesToBase64Url(new TextEncoder().encode(APP_USER)));
      ids.add(id);
    }
    expect(ids.size).toBe(4);
  });

  it("the new credential's STORED user handle is that random user.id; the primary's stored user handle is never rewritten", async () => {
    const w = await world();
    await claim(w);
    const begun = await begin(w, true);
    const backup = createFixtureAuthenticator();
    const registered = await pipeline.completeBackupCredentialRegistration({
      config,
      challengeStore: w.challengeStore,
      registry: w.registry,
      enrollments: w.enrollments,
      appUserId: APP_USER,
      sessionCredentialId: w.primary.credentialIdBase64Url,
      response: buildRegistrationResponseJSON({ authenticator: backup, challenge: begun.optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId }),
    });
    expect(registered.outcome).toBe("registered");
    expect((await w.registry.findPasskeyByCredentialId(backup.credentialIdBase64Url))!.userHandle).toBe(begun.optionsJSON.user.id);
    expect((await w.registry.findPasskeyByCredentialId(w.primary.credentialIdBase64Url))!.userHandle).toBe(PRIMARY_USER_HANDLE);
  });
});

describe("the handle never reaches Turnkey", () => {
  it("backup enrollment with a claimed handle: absent from the authenticator activity, the signed request, everything sent, and the stored request body", async () => {
    const w = await world();
    await claim(w);
    await w.handles.setDisplayName({ appUserId: APP_USER, displayName: DISPLAY_NAME });
    const begun = await begin(w, true);
    expect(begun.optionsJSON.user.name).toBe(`@${HANDLE}`); // the label IS in the WebAuthn options ...
    const backup = createFixtureAuthenticator();
    const registered = await pipeline.completeBackupCredentialRegistration({
      config,
      challengeStore: w.challengeStore,
      registry: w.registry,
      enrollments: w.enrollments,
      appUserId: APP_USER,
      sessionCredentialId: w.primary.credentialIdBase64Url,
      response: buildRegistrationResponseJSON({ authenticator: backup, challenge: begun.optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId }),
    });
    if (registered.outcome !== "registered") throw new Error(JSON.stringify(registered));

    const prepared = await pipeline.prepareTurnkeyAuthorization({ config, registry: w.registry, enrollments: w.enrollments, appUserId: APP_USER, enrollmentId: begun.enrollmentId, sessionCredentialId: w.primary.credentialIdBase64Url });
    if (prepared.outcome !== "ready") throw new Error(JSON.stringify(prepared));
    const activity = JSON.stringify(prepared.activity);
    // ... and nowhere in what Turnkey is asked to do. The authenticator keeps its opaque name.
    expect(activity).toContain(`"authenticatorName":"backup-${begun.enrollmentId.slice(0, 8)}"`);
    for (const needle of [HANDLE, DISPLAY_NAME, "@"]) expect(activity).not.toContain(needle);

    const signed = signRequest({ authenticator: w.primary, activity: prepared.activity, url: CREATE_URL, origin: ORIGIN, rpId: config.rpId });
    const submitted = await pipeline.submitTurnkeyAuthorization({ config, registry: w.registry, enrollments: w.enrollments, appUserId: APP_USER, enrollmentId: begun.enrollmentId, sessionCredentialId: w.primary.credentialIdBase64Url, signedRequest: signed, deps: w.deps });
    expect(submitted.outcome).toBe("confirmed");

    expect(w.sent.length).toBeGreaterThan(0);
    for (const request of w.sent) for (const needle of [HANDLE, DISPLAY_NAME]) expect(request).not.toContain(needle);

    // The durable enrollment row (request body, hash, activity, every other column) carries no handle either.
    const enrollment = JSON.stringify(await w.enrollments.findById(begun.enrollmentId));
    for (const needle of [HANDLE, DISPLAY_NAME]) expect(enrollment).not.toContain(needle);
    // Nor do the passkey rows — a passkey's name is its own (real_passkeys.display_name), not the account's.
    const passkeys = JSON.stringify(await w.registry.findPasskeysByAppUserId(APP_USER));
    for (const needle of [HANDLE, DISPLAY_NAME]) expect(passkeys).not.toContain(needle);
  });

  it("the sub-organization create body (the provisioning evidence) has no handle or display-name input, and its shape is unchanged", () => {
    const body = buildCreateSubOrganizationBody({ organizationId: "parent-org", appUserId: APP_USER, timestampMs: 1790204988123, challengeBase64Url: "challenge", credentialId: "credential", clientDataJson: "client-data", attestationObject: "attestation", transports: ["internal"] });
    const parsed = JSON.parse(body) as { parameters: { subOrganizationName: string; rootUsers: Array<{ userName: string; authenticators: Array<{ authenticatorName: string }> }>; wallet: { walletName: string } } };
    expect(parsed.parameters.subOrganizationName).toBe(`real-${APP_USER}-1790204988123`);
    expect(parsed.parameters.rootUsers[0]!.userName).toBe("end-user");
    expect(parsed.parameters.rootUsers[0]!.authenticators[0]!.authenticatorName).toBe("user-passkey");
    expect(parsed.parameters.wallet.walletName).toBe("owner");
    expect(buildCreateSubOrganizationBody.length).toBe(1); // one input object — and it has no profile field (compile-time: see the call above)
  });

  it("no Turnkey, provisioning, signing, registration, login, session, or auth module imports the handle modules (static)", () => {
    const root = process.cwd();
    const handleModules = /from "(?:\.\.?\/)+(?:handle|account-handles|handle-claim|display\/account-name)"|from "@\/lib\/real\/(?:handle|server\/account-handles|server\/handle-claim|display\/account-name)"/;
    const files = [
      ...["turnkey-provisioning", "turnkey-signed-request", "turnkey-discovery", "provisioning-dispatch", "provisioning-evidence", "provisioning-activity-poller", "onboarding", "registration", "registration-attempts", "login", "session", "auth", "webauthn", "passkey-revocation", "passkey-revocation-attempts", "passkey-revocation-resolver", "payments", "payment-authorization", "backup-passkey-enrollment"].map((name) => `lib/real/server/${name}.ts`),
      ...readdirSync(path.join(root, "lib/real/signing")).map((name) => `lib/real/signing/${name}`),
      ...readdirSync(path.join(root, "lib/real/payments")).map((name) => `lib/real/payments/${name}`),
    ];
    expect(files.length).toBeGreaterThan(25);
    for (const file of files) expect(readFileSync(path.join(root, file), "utf8"), file).not.toMatch(handleModules);
    // The one pipeline that does read the profile uses it for buildRegistrationOptions and nothing else.
    const pipelineSource = readFileSync(path.join(root, "lib/real/server/backup-passkey-pipeline.ts"), "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");
    expect(pipelineSource.match(/\bprofile\b/g)).toHaveLength(4); // read once; used for the label (handle, twice) and the display name
    // ... read ONLY through the best-effort helper: the pipeline never calls the store itself.
    expect(pipelineSource).toContain("const profile = input.handles ? await readAccountProfileBestEffort({ handles: input.handles, appUserId: input.appUserId }) : null;");
    expect(pipelineSource).not.toMatch(/findProfileByAppUserId|findHandle\(|\.claim\(|setDisplayName/);
    expect(pipelineSource.match(/\blabel\b/g)).toHaveLength(4); // declared once, used for userName and userDisplayName only
  });
});

/** Every way the profile read can fail. Each must look exactly like "this account has no handle". */
function brokenProfileStores(w: World): Array<[string, () => AccountHandleStore]> {
  return [
    [
      "the store cannot be constructed",
      () => {
        throw new Error("Real Mode is misconfigured: DATABASE_URL is required in production");
      },
    ],
    [
      "the read throws synchronously",
      () => ({
        ...w.handles,
        findProfileByAppUserId: () => {
          throw new TypeError("fetch failed");
        },
      }),
    ],
    ["the read rejects (e.g. the registry table is missing)", () => ({ ...w.handles, findProfileByAppUserId: async () => Promise.reject(new Error('relation "real_account_handles" does not exist')) })],
    ["the store getter returns nothing", () => undefined as unknown as AccountHandleStore],
  ];
}

describe("N1 — the backup-passkey profile read is best-effort", () => {
  it.each([0, 1, 2, 3])("failure kind %i: enrollment still starts, with EXACTLY the pre-Handles naming, a fresh random user.id, and no extra step-up", async (index) => {
    const w = await world();
    // The account HAS a claimed handle and a display name — the failing read must not surface either.
    await claim(w);
    await w.handles.setDisplayName({ appUserId: APP_USER, displayName: DISPLAY_NAME });
    const minted: string[] = [];
    const inner = w.challengeStore;
    w.challengeStore = { create: async (input) => (minted.push(input.purpose), inner.create(input)), consume: (input) => inner.consume(input) };
    const [label, handles] = brokenProfileStores(w)[index]!;

    const begun = await begin(w, handles); // ONE step-up, answered once, inside begin()
    expect(begun.outcome, label).toBe("started");
    const placeholder = `real-backup-${begun.enrollmentId.slice(0, 8)}`;
    expect(begun.optionsJSON.user.name).toBe(placeholder);
    expect(begun.optionsJSON.user.displayName).toBe(placeholder);
    expect(begun.optionsJSON.user.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(begun.optionsJSON.user.id).not.toBe(PRIMARY_USER_HANDLE);
    expect(JSON.stringify(begun.optionsJSON)).not.toContain(HANDLE);
    expect(JSON.stringify(begun.optionsJSON)).not.toContain(DISPLAY_NAME);
    // Exactly one step-up challenge and one registration challenge: the failed enrichment asked for nothing more.
    expect(minted).toEqual(["backup_step_up", "backup_registration"]);
    // Everything else about the options is what a no-handle account gets.
    expect(begun.optionsJSON.rp).toEqual({ name: "Test", id: "localhost" });
    expect(begun.optionsJSON.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
    expect(begun.optionsJSON.excludeCredentials?.map((c) => c.id)).toEqual([w.primary.credentialIdBase64Url]);
  });

  it("the fallback is byte-for-byte what an account with NO handle gets (same store working, no handle claimed)", async () => {
    const working = await world();
    const reference = await begin(working, true);
    const failing = await world();
    await claim(failing);
    const fallback = await begin(failing, brokenProfileStores(failing)[2]![1]);
    const shape = (b: typeof reference) => ({ ...b.optionsJSON, challenge: "<challenge>", user: { ...b.optionsJSON.user, id: "<random>", name: b.optionsJSON.user.name.replace(b.enrollmentId.slice(0, 8), "<id8>"), displayName: b.optionsJSON.user.displayName.replace(b.enrollmentId.slice(0, 8), "<id8>") }, excludeCredentials: "<the primary>" });
    expect(shape(fallback)).toEqual(shape(reference));
    expect(shape(fallback).user).toEqual({ id: "<random>", name: "real-backup-<id8>", displayName: "real-backup-<id8>" });
  });

  it("after a failed profile read the whole setup still completes, and no handle or display name reaches Turnkey, the stored request, or the passkey's identity", async () => {
    const w = await world();
    await claim(w);
    await w.handles.setDisplayName({ appUserId: APP_USER, displayName: DISPLAY_NAME });
    const begun = await begin(w, brokenProfileStores(w)[2]![1]);
    const backup = createFixtureAuthenticator();
    const registered = await pipeline.completeBackupCredentialRegistration({
      config,
      challengeStore: w.challengeStore,
      registry: w.registry,
      enrollments: w.enrollments,
      appUserId: APP_USER,
      sessionCredentialId: w.primary.credentialIdBase64Url,
      response: buildRegistrationResponseJSON({ authenticator: backup, challenge: begun.optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId }),
    });
    if (registered.outcome !== "registered") throw new Error(JSON.stringify(registered));
    const prepared = await pipeline.prepareTurnkeyAuthorization({ config, registry: w.registry, enrollments: w.enrollments, appUserId: APP_USER, enrollmentId: begun.enrollmentId, sessionCredentialId: w.primary.credentialIdBase64Url });
    if (prepared.outcome !== "ready") throw new Error(JSON.stringify(prepared));
    const activity = JSON.stringify(prepared.activity);
    expect(activity).toContain(`"authenticatorName":"backup-${begun.enrollmentId.slice(0, 8)}"`);
    const signed = signRequest({ authenticator: w.primary, activity: prepared.activity, url: CREATE_URL, origin: ORIGIN, rpId: config.rpId });
    const submitted = await pipeline.submitTurnkeyAuthorization({ config, registry: w.registry, enrollments: w.enrollments, appUserId: APP_USER, enrollmentId: begun.enrollmentId, sessionCredentialId: w.primary.credentialIdBase64Url, signedRequest: signed, deps: w.deps });
    expect(submitted.outcome).toBe("confirmed");

    const stored = await w.registry.findPasskeyByCredentialId(backup.credentialIdBase64Url);
    // The passkey's cryptographic identity is the authenticator's own: credential id, public key, and the random per-credential user handle.
    expect(stored).toMatchObject({ credentialId: backup.credentialIdBase64Url, credentialPublicKey: bytesToBase64Url(backup.publicKeyCose), userHandle: begun.optionsJSON.user.id, displayName: null });
    expect((await w.registry.findPasskeyByCredentialId(w.primary.credentialIdBase64Url))!.userHandle).toBe(PRIMARY_USER_HANDLE);
    const artifacts = [activity, signed.body, JSON.stringify(signed.stamp), ...w.sent, JSON.stringify(await w.enrollments.findById(begun.enrollmentId)), JSON.stringify(await w.registry.findPasskeysByAppUserId(APP_USER))];
    expect(w.sent.length).toBeGreaterThan(0);
    for (const artifact of artifacts) for (const needle of [HANDLE, DISPLAY_NAME]) expect(artifact).not.toContain(needle);
  });

  it("a WORKING profile read with a claimed handle keeps the intended @handle labeling (through the same thunk)", async () => {
    const w = await world();
    await claim(w);
    let reads = 0;
    const withName = await begin(w, () => ((reads += 1), w.handles));
    expect(withName.optionsJSON.user).toMatchObject({ name: `@${HANDLE}`, displayName: `@${HANDLE}` });
    expect(reads).toBe(1); // the store is obtained once per enrollment start, lazily
    const w2 = await world();
    await claim(w2);
    await w2.handles.setDisplayName({ appUserId: APP_USER, displayName: DISPLAY_NAME });
    expect((await begin(w2, true)).optionsJSON.user).toMatchObject({ name: `@${HANDLE}`, displayName: DISPLAY_NAME });
  });

  it("the profile store is not touched at all when the step-up fails — enrichment never precedes authentication", async () => {
    const w = await world();
    let reads = 0;
    const result = await pipeline.beginBackupEnrollment({
      config,
      challengeStore: w.challengeStore,
      registry: w.registry,
      enrollments: w.enrollments,
      handles: () => ((reads += 1), w.handles),
      appUserId: APP_USER,
      sessionCredentialId: w.primary.credentialIdBase64Url,
      stepUpResponse: { id: w.primary.credentialIdBase64Url, response: { clientDataJSON: "x" } },
    });
    expect(result.outcome).toBe("step_up_failed");
    expect(reads).toBe(0);
  });
});

describe("primary registration is unchanged", () => {
  it("still uses the placeholder name, the same value as displayName, and a random 32-byte user.id — and takes no handle input", async () => {
    const challengeStore = createInMemoryChallengeStore();
    const { optionsJSON } = await beginRegistration({ config, challengeStore });
    expect(optionsJSON.user.name).toMatch(/^real-[0-9a-f]{8}$/);
    expect(optionsJSON.user.displayName).toBe(optionsJSON.user.name);
    expect(optionsJSON.user.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(optionsJSON.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
  });
});

describe("RP presentation name", () => {
  const env = {
    TURNKEY_PARENT_ORGANIZATION_ID: "parent-org",
    TURNKEY_API_PUBLIC_KEY: "pub",
    TURNKEY_API_PRIVATE_KEY: "priv",
    REAL_SESSION_SECRET: "7f3c9a1e5b2d4f60a8c7e9b1d3f5a7c90e2b4d6f8a1c3e5b7d9f0a2c4e6b8d0f",
    NEXT_PUBLIC_REAL_RP_ID: "localhost",
    NEXT_PUBLIC_REAL_ORIGIN: "http://localhost:3000",
    PIMLICO_API_KEY: "pim_test_key",
  };

  it("defaults to 'ON Chain Finance'; the RP ID and expected origins are untouched by it", async () => {
    const resolved = readRealServerConfig(env);
    if (!isRealServerConfig(resolved)) throw new Error(resolved.error);
    expect(resolved.rpName).toBe("ON Chain Finance");
    expect(resolved.rpId).toBe("localhost");
    expect(resolved.expectedOrigins).toEqual(["http://localhost:3000"]);
    const { optionsJSON } = await beginRegistration({ config: resolved, challengeStore: createInMemoryChallengeStore() });
    expect(optionsJSON.rp).toEqual({ name: "ON Chain Finance", id: "localhost" });
  });

  it("an explicit NEXT_PUBLIC_REAL_RP_NAME still wins, and .env.example documents the new name", () => {
    const resolved = readRealServerConfig({ ...env, NEXT_PUBLIC_REAL_RP_NAME: "Custom" });
    if (!isRealServerConfig(resolved)) throw new Error(resolved.error);
    expect(resolved.rpName).toBe("Custom");
    const example = readFileSync(path.join(process.cwd(), ".env.example"), "utf8");
    expect(example).toContain('NEXT_PUBLIC_REAL_RP_NAME="ON Chain Finance"');
    expect(example).toContain("NEXT_PUBLIC_REAL_RP_ID=localhost");
    expect(example).toContain("NEXT_PUBLIC_REAL_ORIGIN=http://localhost:3000");
  });
});
