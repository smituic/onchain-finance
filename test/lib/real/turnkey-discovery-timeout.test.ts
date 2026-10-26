import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, encodeAbiParameters, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { readFileSync } from "node:fs";
import path from "node:path";
import { bytesToBase64Url } from "@/lib/real/bytes";
import type { RealServerConfig } from "@/lib/real/server/config";
import { createInMemoryChallengeStore } from "@/lib/real/server/challenge-store";
import { createInMemoryRealAccountRegistry, getInMemoryRegistryInternals, type RealAccountRegistry } from "@/lib/real/server/registry";
import { createInMemoryBackupPasskeyEnrollmentStore, type BackupPasskeyEnrollmentStore } from "@/lib/real/server/backup-passkey-enrollment";
import { createInMemoryPasskeyRevocationStore, type PasskeyRevocationStore } from "@/lib/real/server/passkey-revocation-attempts";
import { createInMemoryPaymentAttemptStore, type PaymentAttemptPatch } from "@/lib/real/server/payment-attempts";
import { createSessionPayload, serializeSession } from "@/lib/real/server/session";
import { SAFE_OP_VALIDITY_SECONDS } from "@/lib/real/payments/validity";
import { backfillTurnkeyAuthenticatorIds, type BackfillDb } from "@/lib/real/server/backfill-turnkey-authenticator-ids";
import { buildAuthenticationResponseJSON, buildRegistrationResponseJSON, createFixtureAuthenticator, type FixtureAuthenticator } from "./fixtures/webauthn";
import { FakeTurnkey, signRequest } from "./fixtures/turnkey-fake";
import { openBudget } from "./fixtures/chain-read-budget";

/**
 * M3D-1: the two parent-key, READ-ONLY Turnkey reads (readTurnkeyActivity,
 * listTurnkeyUserAuthenticators) bound how long their CALLER waits — 5 s, a
 * local deadline around the one SDK call. It does not abort the SDK's socket,
 * retries nothing, and never reads a timeout as proof of absence:
 *
 *   readTurnkeyActivity           timeout -> null   (the existing "read failed" answer)
 *   listTurnkeyUserAuthenticators timeout -> THROWS (never null = user absent, never [] = none)
 *
 * Everything is in-process: @turnkey/http and the Pimlico adapter are mocked,
 * time is faked, and nothing touches a network, Neon or a chain.
 */

const DEADLINE_MS = 5_000;
const SECRET = "test-session-secret";
const owner = privateKeyToAccount("0x119bb329df425b685a3f3483fba01deeb1db47d608cfb051da9ad4a12995238a");
const ORIGIN = "http://localhost:3000";
const SAFE = "0xd9a4c22fb34dc74317edc8006140d66c8fa03266";
const CREATE_URL = "https://api.turnkey.com/public/v1/submit/create_authenticators";
const DELETE_URL = "https://api.turnkey.com/public/v1/submit/delete_authenticators";
const APP_USER = "app-user-1";

const config: RealServerConfig = {
  turnkeyApiBaseUrl: "https://api.turnkey.com",
  turnkeyParentOrganizationId: "parent-org",
  turnkeyApiPublicKey: "pub",
  turnkeyApiPrivateKey: "priv",
  sessionSecret: SECRET,
  rpId: "localhost",
  rpName: "Test",
  expectedOrigins: [ORIGIN],
  rpcUrl: "https://sepolia.base.org",
  pimlicoApiKey: "pim_test_key",
};

type Held = { resolve: (value: unknown) => void; reject: (error: unknown) => void };
type ReadFn = (input: never) => Promise<unknown>;

/** The one mocked TurnkeyClient: delegates to `hooks.<read>` when set, else to the stateful fake; counts every SDK call. */
const hooks: { fake: FakeTurnkey | null; getActivity: ReadFn | null; getUsers: ReadFn | null; calls: { getActivity: number; getUsers: number } } = {
  fake: null,
  getActivity: null,
  getUsers: null,
  calls: { getActivity: 0, getUsers: 0 },
};

vi.mock("@turnkey/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@turnkey/http")>();
  return {
    ...actual,
    TurnkeyClient: vi.fn().mockImplementation(function TurnkeyClientMock(_config: unknown, stamper: { allowCredentials?: Array<{ id: BufferSource }> }) {
      return {
        signRawPayload: (request: never) => hooks.fake!.signRawPayload(request, stamper),
        getActivity: (request: { organizationId: string; activityId: string }) => {
          hooks.calls.getActivity += 1;
          return hooks.getActivity ? hooks.getActivity(request as never) : hooks.fake!.getActivity(request);
        },
        getUsers: (request: { organizationId: string }) => {
          hooks.calls.getUsers += 1;
          return hooks.getUsers ? hooks.getUsers(request as never) : hooks.fake!.getUsers(request);
        },
      };
    }),
  };
});

const sendPreparedUserOperationMock = vi.fn();
const fetchUserOperationReceiptMock = vi.fn();
vi.mock("@/lib/real/server/pimlico", () => ({
  prepareCashTransferUserOperation: vi.fn(),
  sendPreparedUserOperation: (...args: unknown[]) => sendPreparedUserOperationMock(...(args as [never])),
  fetchUserOperationReceipt: (...args: unknown[]) => fetchUserOperationReceiptMock(...(args as [never])),
}));

const discovery = await import("@/lib/real/server/turnkey-discovery");
const { readTurnkeyActivity, listTurnkeyUserAuthenticators, matchAuthenticatorByCredentialId } = discovery;
const pipeline = await import("@/lib/real/server/backup-passkey-pipeline");
const revocation = await import("@/lib/real/server/passkey-revocation");
const { resolveSubmitPayment } = await import("@/lib/real/server/payments");
const { createVerifiedTurnkeyOwnerAccount } = await import("@/lib/real/signing/verified-account");
const { createRealSafeAccount } = await import("@/lib/real/account/safe");
const { computeExpectedUserOperationHash } = await import("@/lib/real/payments/hash");

/** Makes the next-and-all SDK calls to `kind` hang until the test settles one by hand. */
function hang(kind: "getActivity" | "getUsers"): Held[] {
  const held: Held[] = [];
  hooks[kind] = () => new Promise((resolve, reject) => held.push({ resolve, reject }));
  return held;
}

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(() => {
  hooks.fake = null;
  hooks.getActivity = null;
  hooks.getUsers = null;
  hooks.calls = { getActivity: 0, getUsers: 0 };
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
  sendPreparedUserOperationMock.mockReset();
  fetchUserOperationReceiptMock.mockReset();
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  vi.useRealTimers();
});

/** Records whether (and how) a promise settled, without ever leaving a rejection unhandled. */
function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error) => Object.assign(state, { settled: true, error }),
  );
  return state;
}

const SUB_ORG = "sub-org-1";
const readActivityInput = { config, subOrganizationId: SUB_ORG, activityId: "activity-1" };
const listInput = { config, subOrganizationId: SUB_ORG, turnkeyUserId: "turnkey-user-1" };
const completedActivity = { id: "activity-1", status: "ACTIVITY_STATUS_COMPLETED", type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2", organizationId: SUB_ORG };

// ======================================================================
// The helper, through the two real production entry points
// ======================================================================

describe("readTurnkeyActivity deadline", () => {
  it("a hanging getActivity settles the caller at exactly 5,000 ms — not before — with null, after ONE SDK call", async () => {
    vi.useFakeTimers();
    hang("getActivity");
    const state = track(readTurnkeyActivity(readActivityInput));

    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(state.settled).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(state).toMatchObject({ settled: true, value: null });
    expect(hooks.calls.getActivity).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an ordinary successful read keeps its result and leaves no timer", async () => {
    vi.useFakeTimers();
    hooks.getActivity = async () => ({ activity: completedActivity });
    const result = await readTurnkeyActivity(readActivityInput);
    expect(result).toMatchObject({ id: "activity-1", status: "ACTIVITY_STATUS_COMPLETED" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a read that answers just before the deadline is not masked", async () => {
    vi.useFakeTimers();
    const held = hang("getActivity");
    const state = track(readTurnkeyActivity(readActivityInput));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    held[0]!.resolve({ activity: completedActivity });
    await vi.advanceTimersByTimeAsync(0);
    expect(state).toMatchObject({ settled: true, value: { id: "activity-1" } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a response with no activity, and an SDK exception, keep their existing answer (null) and leave no timer", async () => {
    vi.useFakeTimers();
    hooks.getActivity = async () => ({});
    expect(await readTurnkeyActivity(readActivityInput)).toBeNull();
    hooks.getActivity = async () => {
      throw new Error("Turnkey: not found");
    };
    expect(await readTurnkeyActivity(readActivityInput)).toBeNull();
    hooks.getActivity = () => {
      throw new Error("synchronous SDK failure");
    };
    expect(await readTurnkeyActivity(readActivityInput)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(hooks.calls.getActivity).toBe(3); // one call per read, never a retry
  });

  it("never retries: after the deadline, minutes more pass with exactly one SDK call", async () => {
    vi.useFakeTimers();
    hang("getActivity");
    const state = track(readTurnkeyActivity(readActivityInput));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(state.settled).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(hooks.calls.getActivity).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a late SUCCESS after the deadline changes nothing: the caller already got null and nothing is re-delivered", async () => {
    vi.useFakeTimers();
    const held = hang("getActivity");
    const state = track(readTurnkeyActivity(readActivityInput));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(state.value).toBeNull();
    held[0]!.resolve({ activity: completedActivity });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state).toMatchObject({ settled: true, value: null });
    expect(unhandled).toEqual([]);
  });

  it("a late REJECTION after the deadline is absorbed: no unhandled rejection, no change", async () => {
    vi.useFakeTimers();
    const held = hang("getActivity");
    const state = track(readTurnkeyActivity(readActivityInput));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    held[0]!.reject(new Error("socket hang up"));
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20)); // let a would-be unhandledRejection surface
    expect(state).toMatchObject({ settled: true, value: null });
    expect(unhandled).toEqual([]);
  });
});

describe("listTurnkeyUserAuthenticators deadline", () => {
  it("a hanging getUsers settles the caller at exactly 5,000 ms — not before — by REJECTING, after ONE SDK call", async () => {
    vi.useFakeTimers();
    hang("getUsers");
    const state = track(listTurnkeyUserAuthenticators(listInput));

    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(state.settled).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);
    expect(state.error).toBeInstanceOf(Error);
    expect((state.error as Error).name).toBe("TurnkeyReadDeadlineError");
    expect(hooks.calls.getUsers).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an ordinary successful read keeps its result (authenticators, and null for an absent user) and leaves no timer", async () => {
    vi.useFakeTimers();
    hooks.getUsers = async () => ({
      users: [{ userId: "turnkey-user-1", authenticators: [{ authenticatorId: "a-1", credentialId: "Y3JlZA==", credential: { publicKey: "pk" } }, { authenticatorId: "a-2", credentialId: "b3RoZXI=" }] }],
    });
    expect(await listTurnkeyUserAuthenticators(listInput)).toEqual([
      { authenticatorId: "a-1", credentialId: "Y3JlZA==", publicKey: "pk" },
      { authenticatorId: "a-2", credentialId: "b3RoZXI=", publicKey: "" },
    ]);
    hooks.getUsers = async () => ({ users: [{ userId: "someone-else", authenticators: [] }] });
    expect(await listTurnkeyUserAuthenticators(listInput)).toBeNull(); // confirmed: the user is not in the answer
    hooks.getUsers = async () => ({ users: [{ userId: "turnkey-user-1", authenticators: [] }] });
    expect(await listTurnkeyUserAuthenticators(listInput)).toEqual([]); // confirmed: the user has none
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a timeout is distinguishable from every confirmed absence — it can never reach matchAuthenticatorByCredentialId", async () => {
    vi.useFakeTimers();
    // The two confirmed answers keep their meanings...
    expect(matchAuthenticatorByCredentialId(null, "Y3JlZA")).toEqual({ outcome: "user_not_found" });
    expect(matchAuthenticatorByCredentialId([], "Y3JlZA")).toEqual({ outcome: "not_found" });
    // ...and a timeout is neither: the call throws, so there is no value to match.
    hang("getUsers");
    const state = track(listTurnkeyUserAuthenticators(listInput));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(state.settled).toBe(true);
    expect("value" in state).toBe(false);
    expect(state.error).toBeInstanceOf(Error);
  });

  it("an SDK exception still propagates unchanged (the callers' existing handling is untouched)", async () => {
    vi.useFakeTimers();
    const failure = new Error("Turnkey: 500");
    hooks.getUsers = async () => {
      throw failure;
    };
    await expect(listTurnkeyUserAuthenticators(listInput)).rejects.toBe(failure);
    hooks.getUsers = () => {
      throw failure;
    };
    await expect(listTurnkeyUserAuthenticators(listInput)).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
    expect(hooks.calls.getUsers).toBe(2);
  });

  it("never retries: after the deadline, minutes more pass with exactly one SDK call", async () => {
    vi.useFakeTimers();
    hang("getUsers");
    const state = track(listTurnkeyUserAuthenticators(listInput));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(state.settled).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(hooks.calls.getUsers).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a late SUCCESS after the deadline cannot turn the timeout into an answer", async () => {
    vi.useFakeTimers();
    const held = hang("getUsers");
    const state = track(listTurnkeyUserAuthenticators(listInput));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    held[0]!.resolve({ users: [{ userId: "turnkey-user-1", authenticators: [] }] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect("value" in state).toBe(false);
    expect(state.error).toBeInstanceOf(Error);
    expect(unhandled).toEqual([]);
  });

  it("a late REJECTION after the deadline is absorbed: no unhandled rejection", async () => {
    vi.useFakeTimers();
    const held = hang("getUsers");
    const state = track(listTurnkeyUserAuthenticators(listInput));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    held[0]!.reject(new Error("socket hang up"));
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.settled).toBe(true);
    expect(unhandled).toEqual([]);
  });
});

// ======================================================================
// Payment authorization (S1 attribution) through resolveSubmitPayment
// ======================================================================

const PAY_P = bytesToBase64Url(Uint8Array.from({ length: 16 }, (_, i) => i + 1));
const PAY_S = bytesToBase64Url(Uint8Array.from({ length: 16 }, (_, i) => 200 - i));
const PREPARED_OPERATION = {
  nonce: BigInt(0),
  callData: "0x1234" as Hex,
  callGasLimit: BigInt(80_000),
  verificationGasLimit: BigInt(150_000),
  preVerificationGas: BigInt(60_000),
  maxFeePerGas: BigInt(2_000_000),
  maxPriorityFeePerGas: BigInt(1_000_000),
  signature: "0x" as Hex,
};

function offlinePublicClient() {
  return createPublicClient({
    chain: baseSepolia,
    transport: custom({
      request: async ({ method }: { method: string }) => {
        if (method === "eth_getCode") return "0x";
        if (method === "eth_chainId") return `0x${baseSepolia.id.toString(16)}`;
        if (method === "eth_call") return encodeAbiParameters([{ type: "bytes" }], ["0x600a600c600039600a6000f3" as Hex]);
        throw new Error(`Unexpected public RPC call in an offline test: ${method}`);
      },
    }),
  });
}

/** A credential-bound awaiting_authorization payment whose signature + Turnkey activity come from the REAL client signing path (same shape as payments-submit.test.ts). */
async function paymentSetup() {
  const fake = new FakeTurnkey("sub-org-1", "turnkey-user-1");
  fake.addAuthenticator(PAY_P, "authenticator-p");
  fake.addAuthenticator(PAY_S, "authenticator-s");
  fake.walletSigner = (hash) => owner.sign({ hash });
  fake.deviceCredentials = [PAY_P, PAY_S];
  hooks.fake = fake;

  const validUntil = Math.floor(Date.now() / 1000) + SAFE_OP_VALIDITY_SECONDS;
  let activityId: string | null = null;
  const verifiedOwner = createVerifiedTurnkeyOwnerAccount({
    rpId: "example.com",
    subOrganizationId: "sub-org-1",
    ownerAddress: owner.address,
    authorizingCredentialId: PAY_P,
    onTurnkeyActivity: (id) => (activityId = id),
  });
  const account = await createRealSafeAccount({ owner: verifiedOwner, publicClient: offlinePublicClient(), validity: { validAfter: 0, validUntil } });
  const signature = await account.signUserOperation({ ...PREPARED_OPERATION, sender: account.address });
  const safeAddress = account.address;

  const registry = createInMemoryRealAccountRegistry();
  await registry.createAccountWithPasskey({
    account: { appUserId: APP_USER, subOrganizationId: "sub-org-1", turnkeyUserId: "turnkey-user-1", walletId: "wallet-1", walletAccountId: "wallet-account-1", ownerAddress: owner.address, safeAddress, accountConfigVersion: 1 },
    passkey: { credentialId: PAY_P, appUserId: APP_USER, credentialPublicKey: "cose-key-p", userHandle: "user-handle-1", counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false },
  });
  await registry.transitionPasskeyStatus({ credentialId: PAY_P, from: "active", to: "active", patch: { turnkeyAuthenticatorId: "authenticator-p" } });
  const primary = (await registry.findPasskeyByCredentialId(PAY_P))!;
  getInMemoryRegistryInternals(registry).passkeysByCredentialId.set(PAY_S, { ...primary, credentialId: PAY_S, credentialPublicKey: "cose-key-s", role: "backup", turnkeyAuthenticatorId: "authenticator-s" });

  const expectedUserOperationHash = computeExpectedUserOperationHash({ sender: safeAddress, ...PREPARED_OPERATION });
  const paymentStore = createInMemoryPaymentAttemptStore(registry);
  const reserved = await paymentStore.reserve({
    appUserId: APP_USER,
    safeAddress,
    recipient: "0x2222222222222222222222222222222222222222",
    amountBaseUnits: "1000000",
    chainId: baseSepolia.id,
    tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    authorizingCredentialId: PAY_P,
  });
  if (!reserved.ok) throw new Error("expected reservation to succeed");
  const patch: PaymentAttemptPatch = {
    nonce: PREPARED_OPERATION.nonce.toString(),
    callData: PREPARED_OPERATION.callData,
    factory: null,
    factoryData: null,
    callGasLimit: PREPARED_OPERATION.callGasLimit.toString(),
    verificationGasLimit: PREPARED_OPERATION.verificationGasLimit.toString(),
    preVerificationGas: PREPARED_OPERATION.preVerificationGas.toString(),
    maxFeePerGas: PREPARED_OPERATION.maxFeePerGas.toString(),
    maxPriorityFeePerGas: PREPARED_OPERATION.maxPriorityFeePerGas.toString(),
    expectedUserOperationHash,
    validUntil,
    prepareBlockNumber: "47000000",
  };
  await paymentStore.transition({ id: reserved.attempt.id, from: "prepared", to: "awaiting_authorization", patch });
  const cookieValue = serializeSession(createSessionPayload({ appUserId: APP_USER, credentialId: PAY_P, sessionEpoch: 0 }), SECRET);
  const submit = () =>
    resolveSubmitPayment({
      cookieValue,
      sessionSecret: SECRET,
      registry,
      paymentStore,
      pimlicoApiKey: "pim_test_key",
      config: { ...config, rpId: "example.com", expectedOrigins: ["https://example.com"] },
      providerBudgetLimiter: openBudget(),
      activityId: activityId as unknown as string,
      attemptId: reserved.attempt.id,
      signature,
    });
  return { fake, paymentStore, attemptId: reserved.attempt.id, submit, expectedUserOperationHash };
}

describe("payment authorization (S1) under a Turnkey read timeout", () => {
  it("a hanging getActivity -> authorization_unavailable at 5 s: no later read, no claim, no Pimlico send, no state change; the same signature can be retried", async () => {
    const ctx = await paymentSetup();
    const held = hang("getActivity");
    vi.useFakeTimers();
    const state = track(ctx.submit());

    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state).toMatchObject({ settled: true, value: { outcome: "authorization_unavailable" } });

    expect(hooks.calls.getActivity).toBe(1);
    expect(hooks.calls.getUsers).toBe(0); // nothing past the failed activity read
    expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
    const row = await ctx.paymentStore.findById(ctx.attemptId);
    expect(row?.state).toBe("awaiting_authorization");
    expect(row?.turnkeySignActivityId ?? null).toBeNull();

    // A LATE successful answer is ignored for every authoritative purpose.
    held[0]!.resolve({ activity: structuredClone([...ctx.fake.activities.values()][0]!) });
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await ctx.paymentStore.findById(ctx.attemptId))?.state).toBe("awaiting_authorization");
    expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    // Retry once Turnkey answers: the unchanged row proceeds normally and dispatches exactly once.
    vi.useRealTimers();
    hooks.getActivity = null;
    sendPreparedUserOperationMock.mockResolvedValueOnce(ctx.expectedUserOperationHash);
    expect((await ctx.submit()).outcome).toBe("submitted");
    expect(sendPreparedUserOperationMock).toHaveBeenCalledTimes(1);
  });

  it("a hanging getUsers (activity read fine) -> authorization_unavailable at 5 s: no claim, no send, no state change", async () => {
    const ctx = await paymentSetup();
    const held = hang("getUsers");
    vi.useFakeTimers();
    const state = track(ctx.submit());

    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state).toMatchObject({ settled: true, value: { outcome: "authorization_unavailable" } });
    expect(hooks.calls.getActivity).toBe(1);
    expect(hooks.calls.getUsers).toBe(1);

    // A late rejection is absorbed; a late success cannot upgrade the outcome.
    held[0]!.reject(new Error("socket hang up"));
    await vi.advanceTimersByTimeAsync(1_000);
    const row = await ctx.paymentStore.findById(ctx.attemptId);
    expect(row?.state).toBe("awaiting_authorization");
    expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]);
  });

  it("a late getUsers SUCCESS after the deadline does not rescue the submit", async () => {
    const ctx = await paymentSetup();
    const held = hang("getUsers");
    vi.useFakeTimers();
    const state = track(ctx.submit());
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(state).toMatchObject({ settled: true, value: { outcome: "authorization_unavailable" } });
    held[0]!.resolve(await ctx.fake.getUsers({ organizationId: "sub-org-1" }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await ctx.paymentStore.findById(ctx.attemptId))?.state).toBe("awaiting_authorization");
    expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
  });
});

// ======================================================================
// Backup setup + passkey removal (real pipelines, real stores, FakeTurnkey)
// ======================================================================

type World = {
  registry: RealAccountRegistry;
  enrollments: BackupPasskeyEnrollmentStore;
  revocations: PasskeyRevocationStore;
  challengeStore: ReturnType<typeof createInMemoryChallengeStore>;
  fake: FakeTurnkey;
  primary: FixtureAuthenticator;
  clock: { now: number };
  deps: { fetchImpl: typeof fetch; now: () => number; sleep: () => Promise<void>; maxPolls: number };
};

async function world(): Promise<World> {
  const registry = createInMemoryRealAccountRegistry();
  const primary = createFixtureAuthenticator();
  await registry.createAccountWithPasskey({
    account: { appUserId: APP_USER, subOrganizationId: "sub-org-1", turnkeyUserId: "turnkey-user-1", walletId: "wallet-1", walletAccountId: "wallet-account-1", ownerAddress: owner.address, safeAddress: SAFE, accountConfigVersion: 1 },
    passkey: { credentialId: primary.credentialIdBase64Url, appUserId: APP_USER, credentialPublicKey: bytesToBase64Url(primary.publicKeyCose), userHandle: "primary-user-handle", counter: 0, transports: ["internal"], credentialDeviceType: "singleDevice", credentialBackedUp: false },
  });
  const fake = new FakeTurnkey("sub-org-1", "turnkey-user-1");
  fake.addAuthenticator(primary.credentialIdBase64Url, "authenticator-primary");
  await registry.transitionPasskeyStatus({ credentialId: primary.credentialIdBase64Url, from: "active", to: "active", patch: { turnkeyAuthenticatorId: "authenticator-primary" } });
  hooks.fake = fake;
  const clock = { now: Date.now() };
  return {
    registry,
    enrollments: createInMemoryBackupPasskeyEnrollmentStore(registry),
    revocations: createInMemoryPasskeyRevocationStore(registry),
    challengeStore: createInMemoryChallengeStore(),
    fake,
    primary,
    clock,
    deps: { fetchImpl: fake.fetchImpl, now: () => clock.now, sleep: async () => {}, maxPolls: 1 },
  };
}

const creates = (w: World) => w.fake.forwarded.filter((f) => f.url === CREATE_URL);
const deletes = (w: World) => w.fake.forwarded.filter((f) => f.url === DELETE_URL);

async function stepUpAndBegin(w: World) {
  const prepared = await pipeline.prepareBackupStepUp({ config, challengeStore: w.challengeStore, registry: w.registry, appUserId: APP_USER, sessionCredentialId: w.primary.credentialIdBase64Url });
  if (prepared.outcome !== "ready") throw new Error(JSON.stringify(prepared));
  const handle = (await w.registry.findPasskeyByCredentialId(w.primary.credentialIdBase64Url))!.userHandle;
  const stepUpResponse = buildAuthenticationResponseJSON({ authenticator: w.primary, challenge: prepared.optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId, userHandle: handle });
  const begun = await pipeline.beginBackupEnrollment({ config, challengeStore: w.challengeStore, registry: w.registry, enrollments: w.enrollments, appUserId: APP_USER, sessionCredentialId: w.primary.credentialIdBase64Url, stepUpResponse });
  if (begun.outcome !== "started") throw new Error(JSON.stringify(begun));
  return begun;
}

async function toRegistered(w: World) {
  const begun = await stepUpAndBegin(w);
  const backup = createFixtureAuthenticator();
  const response = buildRegistrationResponseJSON({ authenticator: backup, challenge: begun.optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId });
  const registered = await pipeline.completeBackupCredentialRegistration({ config, challengeStore: w.challengeStore, registry: w.registry, enrollments: w.enrollments, appUserId: APP_USER, sessionCredentialId: w.primary.credentialIdBase64Url, response });
  if (registered.outcome !== "registered") throw new Error(JSON.stringify(registered));
  return { enrollmentId: begun.enrollmentId, backup };
}

async function signedCreate(w: World, enrollmentId: string) {
  const prepared = await pipeline.prepareTurnkeyAuthorization({ config, registry: w.registry, enrollments: w.enrollments, appUserId: APP_USER, enrollmentId, sessionCredentialId: w.primary.credentialIdBase64Url, now: () => w.clock.now });
  if (prepared.outcome !== "ready") throw new Error(JSON.stringify(prepared));
  return signRequest({ authenticator: w.primary, activity: prepared.activity, url: CREATE_URL, origin: ORIGIN, rpId: config.rpId });
}

const reconcileCreate = (w: World, enrollmentId: string) =>
  pipeline.reconcileTurnkeyEnrollment({ config, registry: w.registry, enrollments: w.enrollments, appUserId: APP_USER, enrollmentId, providerBudgetLimiter: openBudget(), deps: w.deps });

/** The state submit leaves after a lost first response: exact request recorded, no activity id, replay not yet claimed. */
async function toUnansweredCreate(w: World) {
  const { enrollmentId, backup } = await toRegistered(w);
  const signed = await signedCreate(w, enrollmentId);
  await w.enrollments.transition({
    id: enrollmentId,
    from: "credential_registered",
    to: "turnkey_enrollment_in_flight",
    patch: { externalOutcome: "unknown", turnkeyRequestEndpoint: "create_authenticators", turnkeyRequestBody: signed.body, turnkeyRequestBodySha256: "h", turnkeyRequestTimestampMs: Number(JSON.parse(signed.body).timestampMs), turnkeyRequestStamp: JSON.stringify(signed.stamp) },
  });
  return { enrollmentId, backup };
}

/** Submit through the real pipeline with the given fake mode. */
async function submitCreate(w: World, enrollmentId: string, mode: "ok" | "pending_activity") {
  w.fake.nextMode = mode;
  const result = await pipeline.submitTurnkeyAuthorization({ config, registry: w.registry, enrollments: w.enrollments, appUserId: APP_USER, enrollmentId, sessionCredentialId: w.primary.credentialIdBase64Url, signedRequest: await signedCreate(w, enrollmentId), deps: w.deps });
  w.fake.nextMode = "ok";
  return result;
}

describe("backup setup reconcile under a Turnkey read timeout", () => {
  it("no activity id yet: the replay is claimed and forwarded ONCE; a hanging getUsers then rejects at 5 s, and repeated timed-out reconciles never forward another create", async () => {
    const w = await world();
    const { enrollmentId } = await toUnansweredCreate(w);
    w.fake.nextMode = "lose_response_before_apply"; // the one claimed replay gets no answer: still no activity id
    const held = hang("getUsers");
    vi.useFakeTimers();

    for (let round = 1; round <= 3; round += 1) {
      const state = track(reconcileCreate(w, enrollmentId));
      await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
      expect(state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(state.settled).toBe(true);
      expect(state.error).toBeInstanceOf(Error); // inconclusive: surfaces as the route's generic failure, never as pending-absent or confirmed
      expect(creates(w)).toHaveLength(1); // the one claimed replay; a timeout adds none
      expect(await w.enrollments.findById(enrollmentId)).toMatchObject({ state: "turnkey_enrollment_in_flight", turnkeyRequestReplayed: true, turnkeyActivityId: null });
    }
    expect(hooks.calls.getUsers).toBe(3); // one SDK call per reconcile, never a retry
    expect(vi.getTimerCount()).toBe(0);

    // A late success changes nothing; the next fresh read is what decides.
    held[0]!.resolve({ users: [{ userId: "turnkey-user-1", authenticators: [] }] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await w.enrollments.findById(enrollmentId)).toMatchObject({ state: "turnkey_enrollment_in_flight" });
    expect(creates(w)).toHaveLength(1);
  });

  it("an activity id is recorded and getActivity hangs: the reconcile is a truthful pending at 5 s — no forward, no transition, nothing blocked; a late COMPLETED answer is ignored", async () => {
    const w = await world();
    const { enrollmentId } = await toRegistered(w);
    expect((await submitCreate(w, enrollmentId, "pending_activity")).outcome).toBe("pending");
    const before = (await w.enrollments.findById(enrollmentId))!;
    expect(before.turnkeyActivityId).toBeTruthy();
    const forwarded = w.fake.forwarded.length;

    hooks.calls = { getActivity: 0, getUsers: 0 }; // count only the reconcile under test
    const held = hang("getActivity");
    vi.useFakeTimers();
    const state = track(reconcileCreate(w, enrollmentId));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state).toMatchObject({ settled: true, value: { outcome: "pending" } });

    expect(w.fake.forwarded).toHaveLength(forwarded);
    expect(hooks.calls.getActivity).toBe(1);
    expect(hooks.calls.getUsers).toBe(0);
    expect(await w.enrollments.findById(enrollmentId)).toEqual(before);

    held[0]!.resolve({ activity: { ...structuredClone(w.fake.activities.get(before.turnkeyActivityId!)!), status: "ACTIVITY_STATUS_COMPLETED" } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await w.enrollments.findById(enrollmentId)).toEqual(before);
    expect(w.fake.forwarded).toHaveLength(forwarded);
  });

  it("a blocked setup under review: a hanging getUsers is not a miss — it stays blocked, nothing is confirmed, no create is forwarded", async () => {
    const w = await world();
    const { enrollmentId } = await toRegistered(w);
    expect((await submitCreate(w, enrollmentId, "pending_activity")).outcome).toBe("pending");
    await w.enrollments.transition({ id: enrollmentId, from: "turnkey_enrollment_in_flight", to: "blocked", patch: { blockReason: "needs review", turnkeyRequestStamp: null } });
    const before = (await w.enrollments.findById(enrollmentId))!;
    const forwarded = w.fake.forwarded.length;

    hang("getUsers");
    vi.useFakeTimers();
    const state = track(reconcileCreate(w, enrollmentId));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(state.settled).toBe(true);
    expect(state.error).toBeInstanceOf(Error);
    expect(await w.enrollments.findById(enrollmentId)).toEqual(before);
    expect(w.fake.forwarded).toHaveLength(forwarded);
  });
});

async function toLoginVerified(w: World) {
  const { enrollmentId, backup } = await toRegistered(w);
  expect((await submitCreate(w, enrollmentId, "ok")).outcome).toBe("confirmed");
  const a = await pipeline.prepareBackupLoginVerification({ config, challengeStore: w.challengeStore, enrollments: w.enrollments, appUserId: APP_USER, enrollmentId });
  if (a.outcome !== "ready") throw new Error(JSON.stringify(a));
  const pending = (await w.enrollments.findById(enrollmentId))!;
  const response = buildAuthenticationResponseJSON({ authenticator: backup, challenge: a.optionsJSON.challenge, origin: ORIGIN, rpId: config.rpId, userHandle: pending.userHandle! });
  const verified = await pipeline.confirmBackupLoginVerification({ config, challengeStore: w.challengeStore, registry: w.registry, enrollments: w.enrollments, appUserId: APP_USER, response });
  expect(verified.outcome).toBe("verified");
  return { enrollmentId, backup };
}

async function seedProofB(w: World, enrollmentId: string) {
  const prepared = await pipeline.prepareSigningProof({ config, registry: w.registry, enrollments: w.enrollments, appUserId: APP_USER, enrollmentId });
  if (prepared.outcome !== "ready") throw new Error(JSON.stringify(prepared));
  const enrollment = (await w.enrollments.findById(enrollmentId))!;
  const signature = await owner.sign({ hash: prepared.digest as Hex });
  const id = `sign-${Math.random().toString(16).slice(2)}`;
  w.fake.addActivity({
    id,
    status: "ACTIVITY_STATUS_COMPLETED",
    organizationId: "sub-org-1",
    type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
    intent: { signRawPayloadIntentV2: { signWith: owner.address, payload: prepared.digest, encoding: "PAYLOAD_ENCODING_HEXADECIMAL", hashFunction: "HASH_FUNCTION_NO_OP" } },
    result: { signRawPayloadResult: { r: signature.slice(2, 66), s: signature.slice(66, 130), v: Number.parseInt(signature.slice(130), 16) === 27 ? "00" : "01" } },
    votes: [{ selection: "VOTE_SELECTION_APPROVED", activityId: id, userId: "turnkey-user-1", publicKey: enrollment.turnkeyAuthenticatorPublicKey }],
  });
  return id;
}

const confirmProofB = (w: World, enrollmentId: string, activityId: string) =>
  pipeline.confirmSigningProof({ config, registry: w.registry, enrollments: w.enrollments, appUserId: APP_USER, enrollmentId, activityId, providerBudgetLimiter: openBudget() });

describe("signing-proof confirmation under a Turnkey read timeout", () => {
  it("a hanging getActivity is a retryable rejection at 5 s: the enrollment is NOT activated, and the same activity id then activates it once Turnkey answers", async () => {
    const w = await world();
    const { enrollmentId } = await toLoginVerified(w);
    const activityId = await seedProofB(w, enrollmentId);

    hooks.calls = { getActivity: 0, getUsers: 0 };
    const held = hang("getActivity");
    vi.useFakeTimers();
    const state = track(confirmProofB(w, enrollmentId, activityId));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state).toMatchObject({ settled: true, value: { outcome: "rejected", reason: "The authorization proof could not be verified." } });
    expect((await w.enrollments.findById(enrollmentId))?.state).toBe("login_verified");
    expect(hooks.calls.getActivity).toBe(1);

    held[0]!.resolve({ activity: structuredClone(w.fake.activities.get(activityId)!) }); // late success: ignored
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await w.enrollments.findById(enrollmentId))?.state).toBe("login_verified");

    vi.useRealTimers();
    hooks.getActivity = null;
    expect((await confirmProofB(w, enrollmentId, activityId)).outcome).toBe("active");
  });
});

async function addActiveBackup(w: World) {
  const created = await toLoginVerified(w);
  expect((await confirmProofB(w, created.enrollmentId, await seedProofB(w, created.enrollmentId))).outcome).toBe("active");
  return created;
}

async function signedRemoval(w: World, target: FixtureAuthenticator) {
  const prepared = await revocation.prepareRevocation({ config, registry: w.registry, revocations: w.revocations, appUserId: APP_USER, credentialId: target.credentialIdBase64Url, sessionCredentialId: w.primary.credentialIdBase64Url, now: () => w.clock.now });
  if (prepared.outcome !== "ready") throw new Error(JSON.stringify(prepared));
  return { attemptId: prepared.attemptId, signed: signRequest({ authenticator: w.primary, activity: prepared.activity, url: DELETE_URL, origin: ORIGIN, rpId: config.rpId }) };
}

const submitRemoval = (w: World, target: FixtureAuthenticator, attemptId: string, signedRequest: unknown) =>
  revocation.submitRevocation({ config, registry: w.registry, revocations: w.revocations, appUserId: APP_USER, credentialId: target.credentialIdBase64Url, attemptId, sessionCredentialId: w.primary.credentialIdBase64Url, signedRequest, deps: w.deps });

const reconcileRemoval = (w: World, target: FixtureAuthenticator, attemptId: string) =>
  revocation.reconcileRevocation({ config, registry: w.registry, revocations: w.revocations, appUserId: APP_USER, credentialId: target.credentialIdBase64Url, attemptId, providerBudgetLimiter: openBudget(), deps: w.deps });

describe("passkey-removal reconcile under a Turnkey read timeout (R0)", () => {
  it("an activity id is recorded and getActivity hangs: a truthful pending at 5 s with NO second delete forwarded; the target stays revoking", async () => {
    const w = await world();
    const added = await addActiveBackup(w);
    const { attemptId, signed } = await signedRemoval(w, added.backup);
    w.fake.nextMode = "pending_activity";
    expect((await submitRemoval(w, added.backup, attemptId, signed)).outcome).toBe("pending");
    w.fake.nextMode = "ok";
    expect(deletes(w)).toHaveLength(1);
    const before = (await w.revocations.findById(attemptId))!;
    expect(before.turnkeyActivityId).toBeTruthy();

    hooks.calls = { getActivity: 0, getUsers: 0 };
    const held = hang("getActivity");
    vi.useFakeTimers();
    for (let round = 0; round < 2; round += 1) {
      const state = track(reconcileRemoval(w, added.backup, attemptId));
      await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
      expect(state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(state).toMatchObject({ settled: true, value: { outcome: "pending" } });
      expect(deletes(w)).toHaveLength(1); // R0: the original submit is the only forward
      expect(await w.revocations.findById(attemptId)).toEqual(before);
      expect((await w.registry.findPasskeyByCredentialId(added.backup.credentialIdBase64Url))?.status).toBe("revoking");
    }
    expect(hooks.calls.getActivity).toBe(2);

    // A late COMPLETED answer cannot confirm a deletion.
    held[0]!.resolve({ activity: { ...structuredClone(w.fake.activities.get(before.turnkeyActivityId!)!), status: "ACTIVITY_STATUS_COMPLETED" } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await w.revocations.findById(attemptId)).toEqual(before);
    expect((await w.registry.findPasskeyByCredentialId(added.backup.credentialIdBase64Url))?.status).toBe("revoking");
  });

  it("the delete completed but the absence read (getUsers) hangs: the timeout is NOT read as 'authenticator gone' — nothing is confirmed, no second delete; a real read later confirms", async () => {
    const w = await world();
    const added = await addActiveBackup(w);
    const { attemptId, signed } = await signedRemoval(w, added.backup);
    w.fake.nextMode = "pending_activity";
    expect((await submitRemoval(w, added.backup, attemptId, signed)).outcome).toBe("pending");
    w.fake.nextMode = "ok";
    const attempt = (await w.revocations.findById(attemptId))!;

    // Turnkey now reports the delete COMPLETED and the authenticator really is gone — but the next getUsers never answers.
    const targetAuthenticator = (await w.registry.findPasskeyByCredentialId(added.backup.credentialIdBase64Url))!.turnkeyAuthenticatorId!;
    const activity = w.fake.activities.get(attempt.turnkeyActivityId!)!;
    activity.status = "ACTIVITY_STATUS_COMPLETED";
    activity.result = { deleteAuthenticatorsResult: { authenticatorIds: [targetAuthenticator] } };
    w.fake.users.set("turnkey-user-1", w.fake.authenticators().filter((a) => a.authenticatorId !== targetAuthenticator));

    hang("getUsers");
    vi.useFakeTimers();
    const state = track(reconcileRemoval(w, added.backup, attemptId));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(state.settled).toBe(true);
    // Whatever the exact outcome shape, a removal is never claimed without an authoritative absence read.
    if (state.error === undefined) expect((state.value as { outcome: string }).outcome).not.toBe("revoked");
    expect((await w.registry.findPasskeyByCredentialId(added.backup.credentialIdBase64Url))?.status).toBe("revoking");
    expect(deletes(w)).toHaveLength(1);

    vi.useRealTimers();
    hooks.getUsers = null;
    expect((await reconcileRemoval(w, added.backup, attemptId)).outcome).toBe("revoked");
    expect(deletes(w)).toHaveLength(1);
  });
});

// ======================================================================
// Operator-only callers
// ======================================================================

describe("operator-only callers under a Turnkey read timeout", () => {
  it("the authenticator-id backfill reports turnkey_read_failed — never turnkey_user_not_found or no_match — and writes nothing", async () => {
    const writes: string[] = [];
    const db: BackfillDb = {
      listUnmapped: async () => [{ credentialId: "Y3JlZGVudGlhbC1pZC0x", subOrganizationId: SUB_ORG, turnkeyUserId: "turnkey-user-1" }],
      findCredentialByAuthenticatorId: async () => (writes.push("find"), null),
      setIfUnmapped: async () => (writes.push("set"), true),
      readMapping: async () => (writes.push("read"), null),
    };
    hang("getUsers");
    vi.useFakeTimers();
    const state = track(backfillTurnkeyAuthenticatorIds({ db, listAuthenticators: (row) => listTurnkeyUserAuthenticators({ config, subOrganizationId: row.subOrganizationId, turnkeyUserId: row.turnkeyUserId }) }));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state).toMatchObject({ settled: true, value: [{ outcome: "turnkey_read_failed" }] });
    expect(writes).toEqual([]);
    expect(hooks.calls.getUsers).toBe(1);
  });

  it("the operator-only revocation resolver does not use these two reads at all (its own bounded snapshots are untouched)", () => {
    const source = readFileSync(path.resolve(process.cwd(), "lib/real/server/passkey-revocation-resolver.ts"), "utf8");
    expect(source).not.toContain("turnkey-discovery");
    expect(source).not.toMatch(/listTurnkeyUserAuthenticators|readTurnkeyActivity/);
  });
});

// ======================================================================
// Scope guards
// ======================================================================

describe("scope", () => {
  it("the module still exports only the shared read/compare helpers (the deadline helper and its error stay private)", () => {
    expect(Object.keys(discovery).sort()).toEqual(["listTurnkeyUserAuthenticators", "matchAuthenticatorByCredentialId", "readTurnkeyActivity", "strictCanonicalTurnkeyPublicKeyBytes", "turnkeyPublicKeysEqual"]);
  });

  it("both reads go through the one deadline helper, which does no retry and no signed forwarding", () => {
    const source = readFileSync(path.resolve(process.cwd(), "lib/real/server/turnkey-discovery.ts"), "utf8");
    expect(source.match(/function withReadDeadline</g)).toHaveLength(1);
    expect(source.match(/withReadDeadline\(/g)).toHaveLength(2); // the two reads
    expect(source).toMatch(/withReadDeadline\(\(\) => client\.getUsers\(/);
    expect(source).toMatch(/withReadDeadline\(\(\) => client\.getActivity\(/);
    expect(source).not.toMatch(/forwardSignedRequest|\bfetch\(|\bwhile \(|\bretry/i);
  });
});
