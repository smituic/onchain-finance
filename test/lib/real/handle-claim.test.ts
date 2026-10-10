import { afterEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64Url } from "@/lib/real/bytes";
import { createInMemoryAccountHandleStore, type AccountHandleStore } from "@/lib/real/server/account-handles";
import { createInMemoryChallengeStore, type ChallengePurpose, type ChallengeStore } from "@/lib/real/server/challenge-store";
import type { RealServerConfig } from "@/lib/real/server/config";
import { completeHandleClaim, prepareHandleClaim, readAccountProfile, readAccountProfileBestEffort, updateAccountDisplayName } from "@/lib/real/server/handle-claim";
import { prepareBackupStepUp } from "@/lib/real/server/backup-passkey-pipeline";
import { beginLogin } from "@/lib/real/server/login";
import { createInMemoryRealAccountRegistry, getInMemoryRegistryInternals, type RealAccountRegistry } from "@/lib/real/server/registry";
import { buildAuthenticationResponseJSON, createFixtureAuthenticator, type FixtureAuthenticator } from "./fixtures/webauthn";
import { freshRateLimiter } from "./fixtures/rate-limit";

/**
 * Claiming a permanent @handle, end to end through the real
 * @simplewebauthn/server verification (genuine signatures, see
 * fixtures/webauthn.ts). Every refusal is checked to have written nothing.
 */
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

type Seat = { appUserId: string; authenticator: FixtureAuthenticator; userHandle: string };
type World = { registry: RealAccountRegistry; handles: AccountHandleStore; challengeStore: ChallengeStore; minted: Array<{ purpose: ChallengePurpose; context: unknown; ttlMs: number }>; a: Seat; a2: Seat; b: Seat };

async function world(): Promise<World> {
  const registry = createInMemoryRealAccountRegistry();
  const seat = async (n: number): Promise<Seat> => {
    const authenticator = createFixtureAuthenticator();
    const userHandle = `user-handle-${n}`;
    await registry.createAccountWithPasskey({
      account: { appUserId: `app-user-${n}`, subOrganizationId: `sub-org-${n}`, turnkeyUserId: `turnkey-user-${n}`, walletId: `wallet-${n}`, walletAccountId: `wallet-account-${n}`, ownerAddress: `0x${String(n).repeat(40)}`, safeAddress: `0x${String(n + 4).repeat(40)}`, accountConfigVersion: 1 },
      passkey: { credentialId: authenticator.credentialIdBase64Url, appUserId: `app-user-${n}`, credentialPublicKey: bytesToBase64Url(authenticator.publicKeyCose), userHandle, counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false },
    });
    return { appUserId: `app-user-${n}`, authenticator, userHandle };
  };
  const a = await seat(1);
  const b = await seat(2);
  // A second ACTIVE passkey on account 1 (a backup), with its OWN per-credential user handle.
  const second = createFixtureAuthenticator();
  const internals = getInMemoryRegistryInternals(registry);
  internals.passkeysByCredentialId.set(second.credentialIdBase64Url, {
    ...internals.passkeysByCredentialId.get(a.authenticator.credentialIdBase64Url)!,
    credentialId: second.credentialIdBase64Url,
    credentialPublicKey: bytesToBase64Url(second.publicKeyCose),
    userHandle: "user-handle-1-backup",
    role: "backup",
  });
  const inner = createInMemoryChallengeStore();
  const minted: World["minted"] = [];
  const challengeStore: ChallengeStore = {
    create: async (input) => {
      minted.push({ purpose: input.purpose, context: input.context, ttlMs: input.ttlMs });
      return inner.create(input);
    },
    consume: (input) => inner.consume(input),
  };
  return { registry, handles: createInMemoryAccountHandleStore(registry), challengeStore, minted, a, a2: { appUserId: "app-user-1", authenticator: second, userHandle: "user-handle-1-backup" }, b };
}

const prepare = (w: World, seat: Seat, handle: unknown) =>
  prepareHandleClaim({ config, challengeStore: w.challengeStore, registry: w.registry, handles: w.handles, rateLimiter: freshRateLimiter(), appUserId: seat.appUserId, sessionCredentialId: seat.authenticator.credentialIdBase64Url, handle });

async function ready(w: World, seat: Seat, handle: string) {
  const prepared = await prepare(w, seat, handle);
  if (prepared.outcome !== "ready") throw new Error(JSON.stringify(prepared));
  return prepared;
}

function assertion(seat: Seat, challenge: string, opts: { userHandle?: string | null; userVerified?: boolean; origin?: string; rpId?: string } = {}) {
  return buildAuthenticationResponseJSON({
    authenticator: seat.authenticator,
    challenge,
    origin: opts.origin ?? ORIGIN,
    rpId: opts.rpId ?? config.rpId,
    userHandle: opts.userHandle === null ? undefined : (opts.userHandle ?? seat.userHandle),
    userVerified: opts.userVerified,
  });
}

const complete = (w: World, seat: Seat, handle: unknown, response: unknown) =>
  completeHandleClaim({ config, challengeStore: w.challengeStore, registry: w.registry, handles: w.handles, appUserId: seat.appUserId, sessionCredentialId: seat.authenticator.credentialIdBase64Url, handle, response });

async function nothingClaimed(w: World, handle = "smit") {
  expect(await w.handles.findHandle(handle)).toBeNull();
  for (const seat of [w.a, w.b]) expect(await w.handles.findProfileByAppUserId(seat.appUserId)).toEqual({ handle: null, displayName: null });
}

afterEach(() => vi.useRealTimers());

describe("prepareHandleClaim — options", () => {
  it("canonicalizes the handle and mints ONE challenge: purpose handle_claim, ~5 minutes, context { appUserId, credentialId, handle }", async () => {
    const w = await world();
    const prepared = await ready(w, w.a, " @Smit ");
    expect(prepared.handle).toBe("smit");
    expect(w.minted).toEqual([{ purpose: "handle_claim", ttlMs: 5 * 60 * 1000, context: { appUserId: "app-user-1", credentialId: w.a.authenticator.credentialIdBase64Url, handle: "smit" } }]);
  });

  it("the passkey prompt is pinned to the SESSION credential only, with user verification required", async () => {
    const w = await world();
    const { optionsJSON } = await ready(w, w.a2, "smit");
    expect(optionsJSON.allowCredentials?.map((c) => c.id)).toEqual([w.a2.authenticator.credentialIdBase64Url]);
    expect(optionsJSON.userVerification).toBe("required");
    expect(optionsJSON.rpId).toBe("localhost");
  });

  it("a malformed handle is refused with its reason and nothing is minted", async () => {
    const w = await world();
    for (const bad of ["ab", "_smit", "sm__it", "0xabc", "sm\u0131t", "\u212Aevin", "@@smit", "smit\nadmin", null, 42, undefined]) {
      expect((await prepare(w, w.a, bad)).outcome, String(bad)).toBe("invalid");
    }
    expect(w.minted).toHaveLength(0);
  });

  it("reserved and taken names get the SAME answer, and nothing is minted", async () => {
    const w = await world();
    await w.handles.claim({ handle: "taken", appUserId: "app-user-2", credentialId: w.b.authenticator.credentialIdBase64Url });
    const reserved = await prepare(w, w.a, "Admin");
    const taken = await prepare(w, w.a, "taken");
    expect(reserved).toEqual({ outcome: "unavailable", reason: "That name isn't available. Try another." });
    expect(taken).toEqual(reserved);
    expect(w.minted).toHaveLength(0);
  });

  it("an account that already has a handle gets no challenge — for the same name or any other", async () => {
    const w = await world();
    await w.handles.claim({ handle: "smit", appUserId: "app-user-1", credentialId: w.a.authenticator.credentialIdBase64Url });
    for (const handle of ["smit", "another"]) {
      expect(await prepare(w, w.a, handle)).toMatchObject({ outcome: "already_has_handle", handle: "smit" });
    }
    expect(w.minted).toHaveLength(0);
  });

  it("a session credential that is not active, or not this account's, gets no challenge", async () => {
    const w = await world();
    const internals = getInMemoryRegistryInternals(w.registry);
    const id = w.a.authenticator.credentialIdBase64Url;
    for (const status of ["pending", "revoking", "revoked"] as const) {
      internals.passkeysByCredentialId.set(id, { ...internals.passkeysByCredentialId.get(id)!, status });
      expect((await prepare(w, w.a, "smit")).outcome).toBe("rejected");
    }
    // Account 1's session naming account 2's credential.
    expect((await prepareHandleClaim({ config, challengeStore: w.challengeStore, registry: w.registry, handles: w.handles, rateLimiter: freshRateLimiter(), appUserId: "app-user-1", sessionCredentialId: w.b.authenticator.credentialIdBase64Url, handle: "smit" })).outcome).toBe("rejected");
    expect(w.minted).toHaveLength(0);
  });
});

describe("completeHandleClaim — verify and claim", () => {
  it("happy path: a fresh assertion by the session credential claims exactly the handle the challenge was minted for", async () => {
    const w = await world();
    const { optionsJSON } = await ready(w, w.a, "Smit");
    const result = await complete(w, w.a, "smit", assertion(w.a, optionsJSON.challenge));
    expect(result).toEqual({ outcome: "claimed", profile: { handle: "smit", displayName: null } });
    expect(await w.handles.findHandle("smit")).toEqual({ handle: "smit", kind: "claimed", appUserId: "app-user-1" });
  });

  it("the body's handle may be spelled differently but must canonicalize to the bound one; the stored value is the context's", async () => {
    const w = await world();
    const { optionsJSON } = await ready(w, w.a, "smit");
    expect((await complete(w, w.a, " @SMIT ", assertion(w.a, optionsJSON.challenge))).outcome).toBe("claimed");
    expect((await w.handles.findProfileByAppUserId("app-user-1"))!.handle).toBe("smit");
  });

  it("works with a backup passkey as the session credential, using THAT credential's own user handle", async () => {
    const w = await world();
    const { optionsJSON } = await ready(w, w.a2, "smit");
    expect((await complete(w, w.a2, "smit", assertion(w.a2, optionsJSON.challenge))).outcome).toBe("claimed");
  });

  it("updates the authenticator counter by the existing rule", async () => {
    const w = await world();
    const { optionsJSON } = await ready(w, w.a, "smit");
    w.a.authenticator.counter = 7;
    await complete(w, w.a, "smit", assertion(w.a, optionsJSON.challenge));
    expect((await w.registry.findPasskeyByCredentialId(w.a.authenticator.credentialIdBase64Url))!.counter).toBe(7);
  });

  it("WRONG HANDLE: an assertion obtained for one handle can never claim another", async () => {
    const w = await world();
    const { optionsJSON } = await ready(w, w.a, "smit");
    for (const other of ["smitty", "admin", "", null, undefined, 7, "smit2"]) {
      const fresh = await world();
      const minted = await ready(fresh, fresh.a, "smit");
      expect((await complete(fresh, fresh.a, other, assertion(fresh.a, minted.optionsJSON.challenge))).outcome, String(other)).toBe("rejected");
      await nothingClaimed(fresh);
      expect(await fresh.handles.findHandle("smitty")).toBeNull();
    }
    // The untouched world's challenge is still usable for the bound handle only.
    expect((await complete(w, w.a, "smit", assertion(w.a, optionsJSON.challenge))).outcome).toBe("claimed");
  });

  it("WRONG ACCOUNT: a challenge minted for account 1 is useless under account 2's session", async () => {
    const w = await world();
    const { optionsJSON } = await ready(w, w.a, "smit");
    // B answers A's challenge with B's own (valid) passkey, under B's session.
    expect((await complete(w, w.b, "smit", assertion(w.b, optionsJSON.challenge))).outcome).toBe("rejected");
    await nothingClaimed(w);
  });

  it("WRONG CREDENTIAL: only the credential the challenge names — the session credential — is accepted", async () => {
    // (1) Same account, challenge minted for the primary's session, completed under the backup's session.
    let w = await world();
    let minted = await ready(w, w.a, "smit");
    expect((await complete(w, w.a2, "smit", assertion(w.a2, minted.optionsJSON.challenge))).outcome).toBe("rejected");
    await nothingClaimed(w);
    // (2) The primary's session, but the assertion comes from the account's OTHER active passkey.
    w = await world();
    minted = await ready(w, w.a, "smit");
    expect((await complete(w, w.a, "smit", assertion(w.a2, minted.optionsJSON.challenge))).outcome).toBe("rejected");
    await nothingClaimed(w);
    // (3) The response claims the session credential's id but is signed by another key.
    w = await world();
    minted = await ready(w, w.a, "smit");
    const forged = assertion(w.b, minted.optionsJSON.challenge, { userHandle: w.a.userHandle });
    forged.id = w.a.authenticator.credentialIdBase64Url;
    forged.rawId = w.a.authenticator.credentialIdBase64Url;
    expect((await complete(w, w.a, "smit", forged)).outcome).toBe("rejected");
    await nothingClaimed(w);
  });

  it("credential ids are compared by decoded bytes: a padded/standard-base64 spelling of the same id is accepted, a raw-string look-alike is not", async () => {
    let w = await world();
    let minted = await ready(w, w.a, "smit");
    const padded = assertion(w.a, minted.optionsJSON.challenge);
    const std = Buffer.from(w.a.authenticator.credentialId).toString("base64");
    padded.id = std;
    padded.rawId = std;
    expect((await complete(w, w.a, "smit", padded)).outcome).toBe("claimed");
    w = await world();
    minted = await ready(w, w.a, "smit");
    const wrong = assertion(w.a, minted.optionsJSON.challenge);
    wrong.id = `${w.a.authenticator.credentialIdBase64Url}A`;
    expect((await complete(w, w.a, "smit", wrong)).outcome).toBe("rejected");
    await nothingClaimed(w);
  });

  it("WRONG PURPOSE: a login or backup step-up challenge can never claim a handle, and a handle_claim challenge is burned by the attempt", async () => {
    const w = await world();
    const login = await beginLogin({ config, challengeStore: w.challengeStore });
    expect((await complete(w, w.a, "smit", assertion(w.a, login.optionsJSON.challenge))).outcome).toBe("rejected");
    const stepUp = await prepareBackupStepUp({ config, challengeStore: w.challengeStore, registry: w.registry, appUserId: "app-user-1", sessionCredentialId: w.a.authenticator.credentialIdBase64Url });
    if (stepUp.outcome !== "ready") throw new Error("setup");
    expect((await complete(w, w.a, "smit", assertion(w.a, stepUp.optionsJSON.challenge))).outcome).toBe("rejected");
    await nothingClaimed(w);
    // ...and the reverse: a handle_claim challenge is not a backup step-up or a login challenge.
    const { optionsJSON } = await ready(w, w.a, "smit");
    expect(await w.challengeStore.consume({ challenge: optionsJSON.challenge, purpose: "backup_step_up" })).toBeNull();
    expect((await complete(w, w.a, "smit", assertion(w.a, optionsJSON.challenge))).outcome).toBe("rejected"); // burned by the wrong-purpose consume
    await nothingClaimed(w);
  });

  it("REPLAY: a challenge is single-use — the same assertion again is refused, even after a failed first attempt", async () => {
    const w = await world();
    const first = await ready(w, w.a, "smit");
    const response = assertion(w.a, first.optionsJSON.challenge);
    expect((await complete(w, w.a, "wrong_name", response)).outcome).toBe("rejected"); // consumed on a failed attempt too
    expect((await complete(w, w.a, "smit", response)).outcome).toBe("rejected");
    await nothingClaimed(w);
    const second = await ready(w, w.a, "smit");
    const good = assertion(w.a, second.optionsJSON.challenge);
    expect((await complete(w, w.a, "smit", good)).outcome).toBe("claimed");
    expect((await complete(w, w.a, "smit", good)).outcome).toBe("rejected"); // the consumed challenge never works twice
  });

  it("EXPIRY: a challenge older than its 5-minute window is refused", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-03T12:00:00Z"), toFake: ["Date"] });
    const w = await world();
    const { optionsJSON } = await ready(w, w.a, "smit");
    const response = assertion(w.a, optionsJSON.challenge);
    vi.setSystemTime(new Date("2026-10-03T12:05:01Z"));
    expect((await complete(w, w.a, "smit", response)).outcome).toBe("rejected");
    await nothingClaimed(w);
  });

  it("REVOKED / INACTIVE PASSKEY: a credential that stopped being active after the challenge was minted cannot claim", async () => {
    for (const status of ["pending", "revoking", "revoked"] as const) {
      const w = await world();
      const { optionsJSON } = await ready(w, w.a, "smit");
      const internals = getInMemoryRegistryInternals(w.registry);
      const id = w.a.authenticator.credentialIdBase64Url;
      internals.passkeysByCredentialId.set(id, { ...internals.passkeysByCredentialId.get(id)!, status });
      expect((await complete(w, w.a, "smit", assertion(w.a, optionsJSON.challenge))).outcome, status).toBe("rejected");
      await nothingClaimed(w);
    }
  });

  it("the store's own active-credential re-check is the last word: a revocation landing after verification still stops the claim", async () => {
    const w = await world();
    const { optionsJSON } = await ready(w, w.a, "smit");
    const internals = getInMemoryRegistryInternals(w.registry);
    const id = w.a.authenticator.credentialIdBase64Url;
    const registry: RealAccountRegistry = {
      ...w.registry,
      // Revoked in the window between the assertion verifying and the insert.
      updateAuthenticatorCounter: async (input) => {
        await w.registry.updateAuthenticatorCounter(input);
        internals.passkeysByCredentialId.set(id, { ...internals.passkeysByCredentialId.get(id)!, status: "revoking" });
      },
    };
    const result = await completeHandleClaim({ config, challengeStore: w.challengeStore, registry, handles: w.handles, appUserId: "app-user-1", sessionCredentialId: id, handle: "smit", response: assertion(w.a, optionsJSON.challenge) });
    expect(result.outcome).toBe("rejected");
    await nothingClaimed(w);
  });

  it("USER HANDLE MISMATCH: the assertion's userHandle must equal the credential's stored per-credential user handle", async () => {
    for (const userHandle of ["attacker-handle", "user-handle-1-backup", "user-handle-2", null]) {
      const w = await world();
      const { optionsJSON } = await ready(w, w.a, "smit");
      expect((await complete(w, w.a, "smit", assertion(w.a, optionsJSON.challenge, { userHandle }))).outcome, String(userHandle)).toBe("rejected");
      await nothingClaimed(w);
    }
  });

  it("user verification, origin, and RP ID are still enforced by the existing WebAuthn verification", async () => {
    for (const opts of [{ userVerified: false }, { origin: "https://evil.example" }, { rpId: "evil.example" }]) {
      const w = await world();
      const { optionsJSON } = await ready(w, w.a, "smit");
      expect((await complete(w, w.a, "smit", assertion(w.a, optionsJSON.challenge, opts))).outcome, JSON.stringify(opts)).toBe("rejected");
      await nothingClaimed(w);
    }
  });

  it("MALFORMED ASSERTION: every broken shape is a clean refusal, never a throw", async () => {
    const w = await world();
    const { optionsJSON } = await ready(w, w.a, "smit");
    const good = assertion(w.a, optionsJSON.challenge);
    const broken: unknown[] = [
      null,
      undefined,
      "string",
      42,
      [],
      {},
      { id: 7, response: {} },
      { id: good.id },
      { id: good.id, response: null },
      { id: good.id, response: {} },
      { id: good.id, response: { clientDataJSON: 5 } },
      { id: good.id, response: { clientDataJSON: "!!!not-base64url!!!" } },
      { id: good.id, response: { clientDataJSON: bytesToBase64Url(new TextEncoder().encode("not json")) } },
      { id: good.id, response: { clientDataJSON: bytesToBase64Url(new TextEncoder().encode("{}")) } },
    ];
    for (const response of broken) expect((await complete(w, w.a, "smit", response)).outcome).toBe("rejected");
    // A well-formed envelope around a tampered signature / authenticator data (each on a fresh challenge).
    for (const tamper of [
      (r: typeof good) => ({ ...r, response: { ...r.response, signature: bytesToBase64Url(new Uint8Array(64)) } }),
      (r: typeof good) => ({ ...r, response: { ...r.response, authenticatorData: "AAAA" } }),
      (r: typeof good) => ({ ...r, response: { ...r.response, signature: undefined } }),
    ]) {
      const minted = await ready(w, w.a, "smit");
      expect((await complete(w, w.a, "smit", tamper(assertion(w.a, minted.optionsJSON.challenge)))).outcome).toBe("rejected");
    }
    await nothingClaimed(w);
  });

  it("a tampered challenge CONTEXT can never smuggle a different, non-canonical, or reserved handle into the insert", async () => {
    for (const context of [
      { appUserId: "app-user-1", handle: "smit" }, // no credentialId
      { appUserId: "app-user-1", credentialId: "", handle: "smit" },
      { credentialId: "x", handle: "smit" },
      { appUserId: "", credentialId: "x", handle: "smit" },
      { appUserId: "app-user-1", credentialId: "x", handle: "" },
      { appUserId: "app-user-1", credentialId: "x" }, // no handle
      { appUserId: "app-user-1", credentialId: "x", handle: null },
      { appUserId: 1, credentialId: "x", handle: "smit" },
      "smit",
      null,
      ["app-user-1"],
    ]) {
      const w = await world();
      const login = await beginLogin({ config, challengeStore: createInMemoryChallengeStore() });
      await w.challengeStore.create({ challenge: login.optionsJSON.challenge, purpose: "handle_claim", ttlMs: 60_000, context });
      expect((await complete(w, w.a, "smit", assertion(w.a, login.optionsJSON.challenge))).outcome).toBe("rejected");
      await nothingClaimed(w);
    }
    for (const handle of ["Smit", "admin", "sm", "_smit", 7]) {
      const w = await world();
      const login = await beginLogin({ config, challengeStore: createInMemoryChallengeStore() });
      await w.challengeStore.create({ challenge: login.optionsJSON.challenge, purpose: "handle_claim", ttlMs: 60_000, context: { appUserId: "app-user-1", credentialId: w.a.authenticator.credentialIdBase64Url, handle } });
      expect((await complete(w, w.a, handle, assertion(w.a, login.optionsJSON.challenge))).outcome, String(handle)).toBe("rejected");
      await nothingClaimed(w);
      expect(await w.handles.findProfileByAppUserId("app-user-1")).toEqual({ handle: null, displayName: null });
    }
  });

  it("RACE, two accounts / one handle: both hold valid challenges; exactly one claim wins and the loser is told it's unavailable", async () => {
    const w = await world();
    const forA = await ready(w, w.a, "smit");
    const forB = await ready(w, w.b, "smit"); // advisory check passed for both
    const results = await Promise.all([complete(w, w.a, "smit", assertion(w.a, forA.optionsJSON.challenge)), complete(w, w.b, "smit", assertion(w.b, forB.optionsJSON.challenge))]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["claimed", "unavailable"]);
    const owner = (await w.handles.findHandle("smit"))!.appUserId;
    expect([(await w.handles.findProfileByAppUserId("app-user-1"))!.handle, (await w.handles.findProfileByAppUserId("app-user-2"))!.handle].filter(Boolean)).toEqual(["smit"]);
    expect(["app-user-1", "app-user-2"]).toContain(owner);
  });

  it("RACE, one account / two handles: both challenges valid; exactly one handle is kept, forever", async () => {
    const w = await world();
    const first = await ready(w, w.a, "smit");
    const second = await ready(w, w.a2, "smitty"); // the same account's other passkey, other browser
    const results = await Promise.all([complete(w, w.a, "smit", assertion(w.a, first.optionsJSON.challenge)), complete(w, w.a2, "smitty", assertion(w.a2, second.optionsJSON.challenge))]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["already_has_handle", "claimed"]);
    const kept = (await w.handles.findProfileByAppUserId("app-user-1"))!.handle!;
    expect(results.find((r) => r.outcome === "already_has_handle")).toMatchObject({ handle: kept });
    expect(await w.handles.findHandle(kept === "smit" ? "smitty" : "smit")).toBeNull();
  });

  it("IDEMPOTENT lost-response retry: two valid claims of the SAME handle by the same account both succeed, with one row", async () => {
    const w = await world();
    const first = await ready(w, w.a, "smit");
    const second = await ready(w, w.a, "smit"); // minted before the first claim landed (e.g. a second tab)
    expect((await complete(w, w.a, "smit", assertion(w.a, first.optionsJSON.challenge))).outcome).toBe("claimed");
    expect(await complete(w, w.a, "smit", assertion(w.a, second.optionsJSON.challenge))).toEqual({ outcome: "claimed", profile: { handle: "smit", displayName: null } });
    // After that, options itself reports the handle the account owns instead of minting.
    expect(await prepare(w, w.a, "smit")).toMatchObject({ outcome: "already_has_handle", handle: "smit" });
  });

  it("a handle taken between options and claim -> unavailable; the account keeps no handle and can choose another", async () => {
    const w = await world();
    const { optionsJSON } = await ready(w, w.a, "smit");
    await w.handles.claim({ handle: "smit", appUserId: "app-user-2", credentialId: w.b.authenticator.credentialIdBase64Url });
    expect(await complete(w, w.a, "smit", assertion(w.a, optionsJSON.challenge))).toEqual({ outcome: "unavailable", reason: "That name isn't available. Try another." });
    expect((await w.handles.findProfileByAppUserId("app-user-1"))!.handle).toBeNull();
    const next = await ready(w, w.a, "smit_p");
    expect((await complete(w, w.a, "smit_p", assertion(w.a, next.optionsJSON.challenge))).outcome).toBe("claimed");
  });

  it("an unexpected store failure propagates (the route answers a generic 500) — it is never reported as a claim", async () => {
    const w = await world();
    const { optionsJSON } = await ready(w, w.a, "smit");
    const handles: AccountHandleStore = { ...w.handles, claim: async () => Promise.reject(Object.assign(new Error("duplicate key"), { code: "23505", constraint: "real_passkeys_pkey" })) };
    await expect(completeHandleClaim({ config, challengeStore: w.challengeStore, registry: w.registry, handles, appUserId: "app-user-1", sessionCredentialId: w.a.authenticator.credentialIdBase64Url, handle: "smit", response: assertion(w.a, optionsJSON.challenge) })).rejects.toMatchObject({ code: "23505" });
    await nothingClaimed(w);
  });
});

describe("a handle has no authentication authority", () => {
  it("claiming one changes nothing a login reads: the passkey's user handle, public key, status, and the account record are untouched", async () => {
    const w = await world();
    const id = w.a.authenticator.credentialIdBase64Url;
    const before = { passkey: await w.registry.findPasskeyByCredentialId(id), account: await w.registry.findAccountByAppUserId("app-user-1") };
    const { optionsJSON } = await ready(w, w.a, "smit");
    await complete(w, w.a, "smit", assertion(w.a, optionsJSON.challenge));
    const after = { passkey: await w.registry.findPasskeyByCredentialId(id), account: await w.registry.findAccountByAppUserId("app-user-1") };
    expect(after.account).toEqual(before.account);
    expect(after.passkey).toEqual(before.passkey); // counter stayed 0 (both-zero authenticator), userHandle unchanged
    expect(after.passkey!.userHandle).toBe("user-handle-1");
  });
});

describe("display name service", () => {
  it("validates, stores, clears, and reports the profile; an account without a handle can still have a name", async () => {
    const w = await world();
    expect(await updateAccountDisplayName({ handles: w.handles, appUserId: "app-user-1", displayName: "  Zoe\u0308 Chen " })).toEqual({ outcome: "updated", profile: { handle: null, displayName: "Zo\u00EB Chen" } });
    expect(await readAccountProfile({ handles: w.handles, appUserId: "app-user-1" })).toEqual({ handle: null, displayName: "Zo\u00EB Chen" });
    expect(await updateAccountDisplayName({ handles: w.handles, appUserId: "app-user-1", displayName: "   " })).toEqual({ outcome: "updated", profile: { handle: null, displayName: null } });
    expect((await updateAccountDisplayName({ handles: w.handles, appUserId: "app-user-1", displayName: "a".repeat(41) })).outcome).toBe("invalid");
    expect((await updateAccountDisplayName({ handles: w.handles, appUserId: "app-user-1", displayName: "Maya\u202EChen" })).outcome).toBe("invalid");
    for (const bad of ["@support", "@alice", "Ali\u200Bce", "Ali\u2060ce", "Ali\u00ADce"]) {
      expect((await updateAccountDisplayName({ handles: w.handles, appUserId: "app-user-1", displayName: bad })).outcome, bad).toBe("invalid");
    }
    expect((await w.handles.findProfileByAppUserId("app-user-1"))!.displayName).toBeNull(); // nothing invalid was stored
    expect((await updateAccountDisplayName({ handles: w.handles, appUserId: "nobody", displayName: "x" })).outcome).toBe("not_found");
  });

  it("an EMPTY-handle context naming the real session credential is still refused, even with an empty body handle", async () => {
    const w = await world();
    const login = await beginLogin({ config, challengeStore: createInMemoryChallengeStore() });
    await w.challengeStore.create({ challenge: login.optionsJSON.challenge, purpose: "handle_claim", ttlMs: 60_000, context: { appUserId: "app-user-1", credentialId: w.a.authenticator.credentialIdBase64Url, handle: "" } });
    expect((await complete(w, w.a, "", assertion(w.a, login.optionsJSON.challenge))).outcome).toBe("rejected");
    await nothingClaimed(w);
  });

  it("readAccountProfile never throws for an unknown account — it is simply empty", async () => {
    const w = await world();
    expect(await readAccountProfile({ handles: w.handles, appUserId: "nobody" })).toEqual({ handle: null, displayName: null });
  });

  it("readAccountProfileBestEffort: returns the profile when it can, and an empty one for ANY failure — the store throwing, rejecting, or not being buildable", async () => {
    const w = await world();
    await w.handles.claim({ handle: "smit", appUserId: "app-user-1", credentialId: w.a.authenticator.credentialIdBase64Url });
    await w.handles.setDisplayName({ appUserId: "app-user-1", displayName: "Smit" });
    expect(await readAccountProfileBestEffort({ handles: () => w.handles, appUserId: "app-user-1" })).toEqual({ handle: "smit", displayName: "Smit" });
    const empty = { handle: null, displayName: null };
    const failures: Array<() => AccountHandleStore> = [
      () => {
        throw new Error("Real Mode is misconfigured: DATABASE_URL is required in production");
      },
      () => ({ ...w.handles, findProfileByAppUserId: async () => Promise.reject(new Error('relation "real_account_handles" does not exist')) }),
      () => ({
        ...w.handles,
        findProfileByAppUserId: () => {
          throw new TypeError("fetch failed");
        },
      }),
      () => undefined as unknown as AccountHandleStore,
    ];
    for (const handles of failures) expect(await readAccountProfileBestEffort({ handles, appUserId: "app-user-1" })).toEqual(empty);
  });

  it("the strict readAccountProfile still throws — it is what the claim routes use, and they fail closed", async () => {
    const w = await world();
    const handles: AccountHandleStore = { ...w.handles, findProfileByAppUserId: async () => Promise.reject(new Error("db down")) };
    await expect(readAccountProfile({ handles, appUserId: "app-user-1" })).rejects.toThrow("db down");
    await expect(prepareHandleClaim({ config, challengeStore: w.challengeStore, registry: w.registry, handles, rateLimiter: freshRateLimiter(), appUserId: "app-user-1", sessionCredentialId: w.a.authenticator.credentialIdBase64Url, handle: "smit" })).rejects.toThrow("db down");
    expect(w.minted).toHaveLength(0);
  });
});
