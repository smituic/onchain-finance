import { describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, encodeAbiParameters, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { bytesToBase64Url } from "@/lib/real/bytes";
import { createInMemoryRealAccountRegistry, getInMemoryRegistryInternals } from "@/lib/real/server/registry";
import { createSessionPayload, serializeSession } from "@/lib/real/server/session";
import { createInMemoryPaymentAttemptStore, type PaymentAttemptPatch } from "@/lib/real/server/payment-attempts";
import type { RealServerConfig } from "@/lib/real/server/config";
import { SAFE_OP_VALIDITY_SECONDS } from "@/lib/real/payments/validity";
import { createFakeEntryPoint } from "./fixtures/entry-point-fake";
import { FakeTurnkey } from "./fixtures/turnkey-fake";

const SECRET = "test-session-secret";

const owner = privateKeyToAccount("0x119bb329df425b685a3f3483fba01deeb1db47d608cfb051da9ad4a12995238a");
const impostor = privateKeyToAccount("0xe3b5b13304d3d1e786145c392ddcb41c2d0c9697079968a5b9ab5b415393642f");

/** Two real-shaped (base64url, 16-byte) credential ids: P = primary, S = an active backup. */
const P = bytesToBase64Url(Uint8Array.from({ length: 16 }, (_, i) => i + 1));
const S = bytesToBase64Url(Uint8Array.from({ length: 16 }, (_, i) => 200 - i));

const CONFIG: RealServerConfig = {
  turnkeyApiBaseUrl: "https://api.turnkey.com",
  turnkeyParentOrganizationId: "parent-org",
  turnkeyApiPublicKey: "pub",
  turnkeyApiPrivateKey: "priv",
  sessionSecret: SECRET,
  rpId: "example.com",
  rpName: "Test",
  expectedOrigins: ["https://example.com"],
  rpcUrl: "https://sepolia.base.org",
  pimlicoApiKey: "pim_test_key",
};

/**
 * One stateful Turnkey stand-in serves BOTH sides, exactly as production
 * splits them: the browser's passkey-stamped signRawPayload (whose real
 * WebauthnStamper — with its real allowCredentials — is handed to the
 * constructor) and the server's parent-key, read-only getActivity/getUsers.
 */
const turnkey: { fake: FakeTurnkey | null } = { fake: null };
vi.mock("@turnkey/http", () => ({
  TurnkeyClient: vi.fn().mockImplementation(function TurnkeyClientMock(_config: unknown, stamper: { allowCredentials?: Array<{ id: BufferSource }> }) {
    return {
      signRawPayload: (request: never) => turnkey.fake!.signRawPayload(request, stamper),
      getActivity: (request: { organizationId: string; activityId: string }) => turnkey.fake!.getActivity(request),
      getUsers: (request: { organizationId: string }) => turnkey.fake!.getUsers(request),
    };
  }),
}));

const sendPreparedUserOperationMock = vi.fn();
const fetchUserOperationReceiptMock = vi.fn();
vi.mock("@/lib/real/server/pimlico", () => ({
  prepareCashTransferUserOperation: vi.fn(),
  sendPreparedUserOperation: (...args: unknown[]) => sendPreparedUserOperationMock(...(args as [never])),
  fetchUserOperationReceipt: (...args: unknown[]) => fetchUserOperationReceiptMock(...(args as [never])),
}));

const { resolveSubmitPayment, resolvePaymentStatus, resolveCancelPayment, resolveLatestPayment } = await import("@/lib/real/server/payments");
const { createVerifiedTurnkeyOwnerAccount } = await import("@/lib/real/signing/verified-account");
const { createRealSafeAccount } = await import("@/lib/real/account/safe");
const { computeExpectedUserOperationHash } = await import("@/lib/real/payments/hash");

const DUMMY_BYTES_RETURN = encodeAbiParameters([{ type: "bytes" }], ["0x600a600c600039600a6000f3" as Hex]);

function buildOfflinePublicClient() {
  return createPublicClient({
    chain: baseSepolia,
    transport: custom({
      request: async ({ method }: { method: string }) => {
        if (method === "eth_getCode") return "0x";
        if (method === "eth_chainId") return `0x${baseSepolia.id.toString(16)}`;
        if (method === "eth_call") return DUMMY_BYTES_RETURN;
        throw new Error(`Unexpected public RPC call in an offline test: ${method}`);
      },
    }),
  });
}

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

type Operation = typeof PREPARED_OPERATION;

/**
 * The REAL client signing path (verified-account.ts -> raw-sign.ts ->
 * turnkey-client.ts -> passkey.ts's stamper) over `operation`, pinned to
 * `pin` exactly like client-sign.ts pins to the bound credential — or
 * unpinned (`pin: null`), which is what a malicious client could do.
 */
async function signOperation(input: { operation?: Operation; pin: string | null; validity: { validAfter: number; validUntil: number } }) {
  let activityId: string | null = null;
  const verifiedOwner = createVerifiedTurnkeyOwnerAccount({
    rpId: "example.com",
    subOrganizationId: "sub-org-1",
    ownerAddress: owner.address,
    authorizingCredentialId: input.pin ?? undefined,
    onTurnkeyActivity: (id) => (activityId = id),
  });
  const account = await createRealSafeAccount({ owner: verifiedOwner, publicClient: buildOfflinePublicClient(), validity: input.validity });
  const signature = await account.signUserOperation({ ...(input.operation ?? PREPARED_OPERATION), sender: account.address });
  return { signature, activityId: activityId as unknown as string, safeAddress: account.address };
}

/** The activity id of the context most recently built by setup() — existing tests' submit calls pass it. */
let currentActivityId = "";

type SetupOptions = {
  storedValidUntil?: number | null;
  signedValidity?: { validAfter: number; validUntil: number };
  /** Which credential the row is bound to at prepare (null = a pre-attribution legacy row). Default P. */
  boundTo?: string | null;
  /** Which credential's session the cookie belongs to. Default P. */
  session?: string;
  /** Which credentials the simulated browser holds. Default [P, S]. */
  device?: string[];
  /** Credential the ceremony is pinned to. Default = boundTo (the real client's behavior). */
  pin?: string | null;
  operation?: Operation;
};

/** Builds a real Safe account (offline), a Turnkey-backed signature + activity over PREPARED_OPERATION through the real client signing path, and the matching durable, credential-bound PaymentAttempt row — everything resolveSubmitPayment needs to re-verify exactly like production would. */
async function setup(options: SetupOptions = {}) {
  const fake = new FakeTurnkey("sub-org-1", "turnkey-user-1");
  fake.addAuthenticator(P, "authenticator-p");
  fake.addAuthenticator(S, "authenticator-s");
  fake.walletSigner = (hash) => owner.sign({ hash });
  fake.deviceCredentials = options.device ?? [P, S];
  turnkey.fake = fake;

  const boundTo = options.boundTo === undefined ? P : options.boundTo;
  const storedValidUntil = options.storedValidUntil === undefined ? Math.floor(Date.now() / 1000) + SAFE_OP_VALIDITY_SECONDS : options.storedValidUntil;
  const signedValidity = options.signedValidity ?? { validAfter: 0, validUntil: storedValidUntil ?? 0 };
  const pin = options.pin === undefined ? boundTo : options.pin;
  const { signature, activityId, safeAddress } = await signOperation({ operation: options.operation, pin, validity: signedValidity });

  const registry = createInMemoryRealAccountRegistry();
  await registry.createAccountWithPasskey({
    account: {
      appUserId: "app-user-1",
      subOrganizationId: "sub-org-1",
      turnkeyUserId: "turnkey-user-1",
      walletId: "wallet-1",
      walletAccountId: "wallet-account-1",
      ownerAddress: owner.address,
      safeAddress,
      accountConfigVersion: 1,
    },
    passkey: {
      credentialId: P,
      appUserId: "app-user-1",
      credentialPublicKey: "cose-key-p",
      userHandle: "user-handle-1",
      counter: 0,
      transports: ["internal"],
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
    },
  });
  await registry.transitionPasskeyStatus({ credentialId: P, from: "active", to: "active", patch: { turnkeyAuthenticatorId: "authenticator-p" } });
  const primary = (await registry.findPasskeyByCredentialId(P))!;
  getInMemoryRegistryInternals(registry).passkeysByCredentialId.set(S, { ...primary, credentialId: S, credentialPublicKey: "cose-key-s", role: "backup", turnkeyAuthenticatorId: "authenticator-s" });

  const fields = { sender: safeAddress, ...PREPARED_OPERATION };
  const expectedUserOperationHash = computeExpectedUserOperationHash(fields);

  const paymentStore = createInMemoryPaymentAttemptStore(registry);
  const reserved = await paymentStore.reserve({
    appUserId: "app-user-1",
    safeAddress,
    recipient: "0x2222222222222222222222222222222222222222",
    amountBaseUnits: "1000000",
    chainId: baseSepolia.id,
    tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    authorizingCredentialId: boundTo ?? P,
  });
  if (!reserved.ok) throw new Error("expected reservation to succeed");
  // A pre-attribution legacy row: the binding column simply doesn't exist for it.
  if (boundTo === null) Object.assign(reserved.attempt, { authorizingCredentialId: null });

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
    ...(storedValidUntil === null ? {} : { validUntil: storedValidUntil, prepareBlockNumber: "47000000" }),
  };
  await paymentStore.transition({ id: reserved.attempt.id, from: "prepared", to: "awaiting_authorization", patch });

  const cookieFor = (credentialId: string) => serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId }), SECRET);
  const cookieValue = cookieFor(options.session ?? P);
  currentActivityId = activityId;
  return { registry, paymentStore, attemptId: reserved.attempt.id, signature, activityId, cookieValue, cookieFor, expectedUserOperationHash, fake, safeAddress, validUntil: storedValidUntil, patch };
}

describe("resolveSubmitPayment", () => {
  it("a correct signature dispatches to the bundler and the returned hash (matching the precomputed expected hash) confirms 'submitted'", async () => {
    sendPreparedUserOperationMock.mockReset();
    const { registry, paymentStore, attemptId, signature, cookieValue, expectedUserOperationHash } = await setup();
    sendPreparedUserOperationMock.mockResolvedValueOnce(expectedUserOperationHash);

    const outcome = await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", config: CONFIG, activityId: currentActivityId, attemptId, signature });

    expect(outcome.outcome).toBe("submitted");
    expect(sendPreparedUserOperationMock).toHaveBeenCalledTimes(1);
  });

  it("a valid app session with a non-hex garbage signature is refused before ever reaching the bundler — a session alone never authorizes a payment", async () => {
    sendPreparedUserOperationMock.mockReset();
    const { registry, paymentStore, attemptId, cookieValue } = await setup();

    const outcome = await resolveSubmitPayment({
      cookieValue,
      sessionSecret: SECRET,
      registry,
      paymentStore,
      pimlicoApiKey: "pim_test_key",
      config: CONFIG,
      activityId: currentActivityId,
      attemptId,
      signature: "0xnotarealsignature",
    });

    // Pre-2f hardening: "0xnotarealsignature" isn't valid hex (n/o/t/r/s/i/g/u
    // aren't hex digits) — refused by the pre-CAS hex-format check before
    // the row is ever touched, not the post-CAS "failed" path.
    expect(outcome.outcome).toBe("invalid_signature");
    expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
    const persisted = await paymentStore.findById(attemptId);
    expect(persisted?.state).toBe("awaiting_authorization");
  });

  it("pre-2f hardening: a length-valid but non-hex signature is refused the same way, before the row is ever claimed", async () => {
    sendPreparedUserOperationMock.mockReset();
    const { registry, paymentStore, attemptId, signature, cookieValue } = await setup();
    // Same total length as a real signature, but with one character
    // replaced by a non-hex digit.
    const malformed = `${signature.slice(0, 10)}z${signature.slice(11)}`;

    const outcome = await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", config: CONFIG, activityId: currentActivityId, attemptId, signature: malformed });

    expect(outcome.outcome).toBe("invalid_signature");
    expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
    const persisted = await paymentStore.findById(attemptId);
    expect(persisted?.state).toBe("awaiting_authorization");
  });

  it("pre-2f hardening: a malformed (non-UUID) attemptId is refused as not_found, never reaching the store", async () => {
    sendPreparedUserOperationMock.mockReset();
    const { registry, paymentStore, signature, cookieValue } = await setup();
    const findByIdSpy = vi.spyOn(paymentStore, "findById");

    const outcome = await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", config: CONFIG, activityId: currentActivityId, attemptId: "not-a-uuid", signature });

    expect(outcome.outcome).toBe("not_found");
    expect(findByIdSpy).not.toHaveBeenCalled();
  });

  it("pre-2f hardening: a throw between the signed and submitting CASes (e.g. a corrupted stored row) becomes a terminal failed, never a stranded 'signed' row — and the account can reserve again afterward", async () => {
    sendPreparedUserOperationMock.mockReset();
    const { registry, paymentStore, attemptId, signature, cookieValue } = await setup();
    // Corrupt the stored nonce so toPreparedFields' BigInt() parse throws —
    // a same-state transition() call is a patch-only write (from === to
    // === current state), simulating row corruption without going through
    // any real code path that could introduce it.
    await paymentStore.transition({ id: attemptId, from: "awaiting_authorization", to: "awaiting_authorization", patch: { nonce: "not-a-number" } });

    const outcome = await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", config: CONFIG, activityId: currentActivityId, attemptId, signature });

    expect(outcome.outcome).toBe("failed");
    expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
    const persisted = await paymentStore.findById(attemptId);
    expect(persisted?.state).toBe("failed");
    expect(persisted?.failureReason).toBeTruthy();
    expect(persisted?.failureReason).not.toMatch(/BigInt|SyntaxError|not-a-number/);

    // Terminal and freed — the account isn't stranded.
    const reserved = await paymentStore.reserve({
      appUserId: "app-user-1",
      safeAddress: persisted!.safeAddress,
      recipient: "0x2222222222222222222222222222222222222222",
      amountBaseUnits: "1000000",
      chainId: baseSepolia.id,
      tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      authorizingCredentialId: P,
    });
    expect(reserved.ok).toBe(true);
  });

  it("pre-2f hardening: a persisted expectedUserOperationHash that no longer matches the recomputed hash is rejected before dispatch, never resent", async () => {
    sendPreparedUserOperationMock.mockReset();
    const { registry, paymentStore, attemptId, signature, cookieValue } = await setup();
    // Leave the prepared fields and signature untouched — tamper ONLY the
    // persisted expectedUserOperationHash, via the same same-state
    // transition() patch technique as the row-corruption test above. This
    // isolates verifyPreparedPaymentSignature's dedicated recomputed-hash
    // mismatch branch (submit.ts:50-58) from the SafeOp preflight: a
    // tampered nonce would change the signed operation itself and could be
    // rejected by the preflight before ever reaching the hash comparison,
    // which would prove nothing about the intended branch.
    await paymentStore.transition({
      id: attemptId,
      from: "awaiting_authorization",
      to: "awaiting_authorization",
      patch: { expectedUserOperationHash: `0x${"ab".repeat(32)}` },
    });

    const outcome = await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", config: CONFIG, activityId: currentActivityId, attemptId, signature });

    expect(outcome.outcome).toBe("failed");
    // Nothing was ever dispatched — the mismatch is caught purely locally,
    // before eth_sendUserOperation is ever called.
    expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
    const persisted = await paymentStore.findById(attemptId);
    expect(persisted?.state).toBe("failed");
    expect(persisted?.failureReason).toBeTruthy();
    // The fixed, safe failure reason — never submit.ts's own internal
    // "recomputed hash does not match..." text.
    expect(persisted?.failureReason).not.toMatch(/recomputed|persisted expected hash/i);
  });

  it("a signature from the wrong signer is rejected by the independent preflight — never reaches the bundler", async () => {
    // createVerifiedTurnkeyOwnerAccount's own self-check (check A) already
    // refuses to ever RETURN a wrong-signer signature, so a genuine
    // wrong-signer signature can only reach the server via some other path
    // (a compromised/buggy client, or a direct API call) — modeled here by
    // signing the SAME operation shape with a plain, unwrapped impostor
    // account bound to ITS OWN (different) Safe address, exactly what an
    // attacker submitting an unrelated signature would produce.
    sendPreparedUserOperationMock.mockReset();
    const { registry, paymentStore, attemptId, cookieValue } = await setup();

    const impostorAccount = await createRealSafeAccount({ owner: impostor, publicClient: buildOfflinePublicClient() });
    const impostorSignature = await impostorAccount.signUserOperation({ ...PREPARED_OPERATION, sender: impostorAccount.address });

    const outcome = await resolveSubmitPayment({
      cookieValue,
      sessionSecret: SECRET,
      registry,
      paymentStore,
      pimlicoApiKey: "pim_test_key",
      config: CONFIG,
      activityId: currentActivityId,
      attemptId,
      signature: impostorSignature,
    });

    expect(outcome.outcome).toBe("failed");
    expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
  });

  it("a bundler ack whose returned hash does not match the precomputed expected hash is treated as unknown, never trusted", async () => {
    sendPreparedUserOperationMock.mockReset();
    const { registry, paymentStore, attemptId, signature, cookieValue } = await setup();
    sendPreparedUserOperationMock.mockResolvedValueOnce("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");

    const outcome = await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", config: CONFIG, activityId: currentActivityId, attemptId, signature });

    expect(outcome.outcome).toBe("unknown");
  });

  it("a network failure after a signature exists is unresolved (unknown), never silently treated as failed", async () => {
    sendPreparedUserOperationMock.mockReset();
    sendPreparedUserOperationMock.mockRejectedValueOnce(new Error("fetch failed"));
    const { registry, paymentStore, attemptId, signature, cookieValue } = await setup();

    const outcome = await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", config: CONFIG, activityId: currentActivityId, attemptId, signature });

    expect(outcome.outcome).toBe("unknown");
    // The precomputed hash survives the lost response — reconciliation still has a key to look up.
    const persisted = await paymentStore.findById(attemptId);
    expect(persisted?.expectedUserOperationHash).toBeTruthy();
  });

  it("never persists the raw signature anywhere in the durable attempt record", async () => {
    sendPreparedUserOperationMock.mockReset();
    const { registry, paymentStore, attemptId, signature, cookieValue, expectedUserOperationHash } = await setup();
    sendPreparedUserOperationMock.mockResolvedValueOnce(expectedUserOperationHash);

    await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", config: CONFIG, activityId: currentActivityId, attemptId, signature });

    const persisted = await paymentStore.findById(attemptId);
    expect(JSON.stringify(persisted)).not.toContain(signature);
  });

  it("A: durably CAS-transitions signed -> submitting BEFORE eth_sendUserOperation is ever called", async () => {
    sendPreparedUserOperationMock.mockReset();
    const { registry, paymentStore, attemptId, signature, cookieValue, expectedUserOperationHash } = await setup();
    sendPreparedUserOperationMock.mockImplementation(async () => {
      // Read the durable row from INSIDE the dispatch call — if the
      // pre-dispatch CAS write happened first, this must already see
      // "submitting", not "signed".
      const current = await paymentStore.findById(attemptId);
      expect(current?.state).toBe("submitting");
      return expectedUserOperationHash;
    });

    const outcome = await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", config: CONFIG, activityId: currentActivityId, attemptId, signature });

    expect(outcome.outcome).toBe("submitted");
    expect(sendPreparedUserOperationMock).toHaveBeenCalledTimes(1);
  });

  it("B: a row stuck at 'submitting' (crash after the pre-dispatch CAS but before dispatch ever ran) can never be resubmitted", async () => {
    sendPreparedUserOperationMock.mockReset();
    const { registry, paymentStore, attemptId, signature, cookieValue } = await setup();
    // Simulates the crash: manually drive the durable row to "submitting"
    // WITHOUT ever calling resolveSubmitPayment (so sendUserOperation is
    // never invoked) — modeling "the process died right after the CAS".
    await paymentStore.transition({ id: attemptId, from: "awaiting_authorization", to: "signed" });
    await paymentStore.transition({ id: attemptId, from: "signed", to: "submitting" });

    const outcome = await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", config: CONFIG, activityId: currentActivityId, attemptId, signature });

    expect(outcome.outcome).toBe("wrong_state");
    expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
  });

  it("C: a row stuck at 'submitting' because the dispatch result was never recorded is resolved via reconciliation only, never a resend", async () => {
    sendPreparedUserOperationMock.mockReset();
    fetchUserOperationReceiptMock.mockReset();
    const { registry, paymentStore, attemptId, cookieValue, expectedUserOperationHash } = await setup();
    await paymentStore.transition({ id: attemptId, from: "awaiting_authorization", to: "signed" });
    const submitting = await paymentStore.transition({ id: attemptId, from: "signed", to: "submitting" });

    // The operation actually reached the chain (a real ack happened) even
    // though the local write recording that never completed — exactly the
    // "interruption after send but before the acknowledged-state write"
    // scenario. Reconciliation must still resolve it correctly.
    fetchUserOperationReceiptMock.mockResolvedValueOnce({
      userOpHash: expectedUserOperationHash,
      sender: submitting!.safeAddress,
      success: true,
      receipt: { transactionHash: "0xabc", status: "success" },
    });

    const outcome = await resolvePaymentStatus({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", publicClient: createFakeEntryPoint({}).reader, attemptId });

    expect(outcome.outcome).toBe("ok");
    if (outcome.outcome !== "ok") return;
    expect(outcome.attempt.state).toBe("confirmed");
    expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
  });

  it("D: two concurrent /submit attempts for the same attempt — exactly one reaches sendUserOperation", async () => {
    sendPreparedUserOperationMock.mockReset();
    const { registry, paymentStore, attemptId, signature, cookieValue, expectedUserOperationHash } = await setup();
    sendPreparedUserOperationMock.mockResolvedValue(expectedUserOperationHash);

    const [first, second] = await Promise.all([
      resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", config: CONFIG, activityId: currentActivityId, attemptId, signature }),
      resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", config: CONFIG, activityId: currentActivityId, attemptId, signature }),
    ]);

    const outcomes = [first.outcome, second.outcome];
    expect(outcomes.filter((outcome) => outcome === "submitted")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "wrong_state" || outcome === "not_found")).toHaveLength(1);
    expect(sendPreparedUserOperationMock).toHaveBeenCalledTimes(1);
  });

  it("E: reconciling a 'submitting' row with no receipt yet leaves it unresolved — never triggers a resend", async () => {
    sendPreparedUserOperationMock.mockReset();
    fetchUserOperationReceiptMock.mockReset();
    const { registry, paymentStore, attemptId, cookieValue } = await setup();
    await paymentStore.transition({ id: attemptId, from: "awaiting_authorization", to: "signed" });
    await paymentStore.transition({ id: attemptId, from: "signed", to: "submitting" });
    fetchUserOperationReceiptMock.mockResolvedValueOnce(null);

    const outcome = await resolvePaymentStatus({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", publicClient: createFakeEntryPoint({}).reader, attemptId });

    expect(outcome.outcome).toBe("ok");
    if (outcome.outcome !== "ok") return;
    expect(outcome.attempt.state).toBe("submitting");
    expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
  });

  it("F: a returned-hash mismatch during dispatch moves submitting -> unknown (already exercised via the full flow above)", async () => {
    sendPreparedUserOperationMock.mockReset();
    const { registry, paymentStore, attemptId, signature, cookieValue } = await setup();
    sendPreparedUserOperationMock.mockResolvedValueOnce("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");

    const outcome = await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", config: CONFIG, activityId: currentActivityId, attemptId, signature });

    expect(outcome.outcome).toBe("unknown");
    const persisted = await paymentStore.findById(attemptId);
    expect(persisted?.state).toBe("unknown");
  });

  it("G: a definitive, recognized bundler rejection transitions submitting -> failed", async () => {
    sendPreparedUserOperationMock.mockReset();
    const { registry, paymentStore, attemptId, signature, cookieValue } = await setup();
    const bundlerRejection = Object.assign(new Error("Account not deployed"), { name: "AccountNotDeployedError" });
    const rpcRejection = Object.assign(new Error("rejected"), { name: "RpcRequestError", cause: bundlerRejection });
    sendPreparedUserOperationMock.mockRejectedValueOnce(rpcRejection);

    const outcome = await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", config: CONFIG, activityId: currentActivityId, attemptId, signature });

    expect(outcome.outcome).toBe("failed");
    const persisted = await paymentStore.findById(attemptId);
    expect(persisted?.state).toBe("failed");
  });

  it("H: a transport timeout (no recognized bundler rejection) transitions submitting -> unknown, never failed", async () => {
    sendPreparedUserOperationMock.mockReset();
    const { registry, paymentStore, attemptId, signature, cookieValue } = await setup();
    const timeoutError = Object.assign(new Error("The request took too long to respond."), { name: "TimeoutError" });
    sendPreparedUserOperationMock.mockRejectedValueOnce(timeoutError);

    const outcome = await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", config: CONFIG, activityId: currentActivityId, attemptId, signature });

    expect(outcome.outcome).toBe("unknown");
    const persisted = await paymentStore.findById(attemptId);
    expect(persisted?.state).toBe("unknown");
  });
});

/**
 * Pre-2f hardening: resolveCancelPayment now accepts "signed" (previously
 * only "awaiting_authorization"), specifically to be the last line of
 * defense against a stranded pre-dispatch attempt. These two tests prove
 * the resulting cancel-vs-submit race resolves correctly in BOTH
 * directions, using real resolveSubmitPayment/resolveCancelPayment code —
 * not a reimplementation — with a spy on paymentStore.transition as the
 * deterministic injection point (JS's single-threaded run-to-completion
 * semantics make "the call that invokes transition() first wins the CAS"
 * exact, the same technique test/lib/real/payment-attempts.test.ts's own
 * concurrent-CAS tests already rely on).
 */
describe("cancel-vs-submit races (pre-2f hardening)", () => {
  it("cancel winning the signed->cancelled CAS first makes submit's own signed->submitting CAS fail — the bundler is never called", async () => {
    sendPreparedUserOperationMock.mockReset();
    const { registry, paymentStore, attemptId, signature, cookieValue } = await setup();

    const originalTransition = paymentStore.transition.bind(paymentStore);
    const transitionSpy = vi.spyOn(paymentStore, "transition").mockImplementation(async (args) => {
      const result = await originalTransition(args);
      if (args.from === "awaiting_authorization" && args.to === "signed" && result) {
        // Simulate a concurrent cancel request arriving the instant submit's
        // own first CAS lands (the row is genuinely "signed" right now).
        const cancelOutcome = await resolveCancelPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, attemptId });
        expect(cancelOutcome.outcome).toBe("cancelled");
      }
      return result;
    });

    const outcome = await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", config: CONFIG, activityId: currentActivityId, attemptId, signature });

    expect(outcome.outcome).toBe("wrong_state");
    expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
    const persisted = await paymentStore.findById(attemptId);
    expect(persisted?.state).toBe("cancelled");
    transitionSpy.mockRestore();
  });

  it("submit winning the signed->submitting CAS first makes a concurrent cancel fail (wrong_state), and dispatch proceeds normally", async () => {
    sendPreparedUserOperationMock.mockReset();
    const { registry, paymentStore, attemptId, signature, cookieValue, expectedUserOperationHash } = await setup();
    sendPreparedUserOperationMock.mockResolvedValueOnce(expectedUserOperationHash);

    // Slice S1: signed -> submitting is now the atomic beginDispatch claim.
    const originalBeginDispatch = paymentStore.beginDispatch.bind(paymentStore);
    let cancelAttempted = false;
    const claimSpy = vi.spyOn(paymentStore, "beginDispatch").mockImplementation(async (args) => {
      const result = await originalBeginDispatch(args);
      if (result) {
        // Simulate a concurrent cancel request arriving the instant submit's
        // own second CAS lands (the row is "submitting" now).
        const cancelOutcome = await resolveCancelPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, attemptId });
        expect(cancelOutcome.outcome).toBe("wrong_state");
        cancelAttempted = true;
      }
      return result;
    });

    const outcome = await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", config: CONFIG, activityId: currentActivityId, attemptId, signature });

    expect(cancelAttempted).toBe(true);
    expect(outcome.outcome).toBe("submitted");
    expect(sendPreparedUserOperationMock).toHaveBeenCalledTimes(1);
    claimSpy.mockRestore();
  });
});

describe("finite SafeOp expiry at submit", () => {
  const submit = (ctx: Awaited<ReturnType<typeof setup>>, overrides: { signature?: Hex; now?: () => number } = {}) =>
    resolveSubmitPayment({
      cookieValue: ctx.cookieValue,
      sessionSecret: SECRET,
      registry: ctx.registry,
      paymentStore: ctx.paymentStore,
      pimlicoApiKey: "pim_test_key",
      config: CONFIG,
      activityId: ctx.activityId,
      attemptId: ctx.attemptId,
      signature: overrides.signature ?? ctx.signature,
      now: overrides.now,
    });

  it("a validly-signed but UNBOUNDED SafeOp (validUntil = 0, 'never expires') is refused and never dispatched — the window is the server's, not the client's", async () => {
    sendPreparedUserOperationMock.mockReset();
    const ctx = await setup({ signedValidity: { validAfter: 0, validUntil: 0 } });

    const outcome = await submit(ctx);

    expect(outcome.outcome).toBe("failed");
    expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
    expect((await ctx.paymentStore.findById(ctx.attemptId))?.state).toBe("failed");
  });

  it("a signature over a DIFFERENT finite window (longer, or a non-zero validAfter) is refused and never dispatched", async () => {
    for (const signedValidity of [{ validAfter: 0, validUntil: Math.floor(Date.now() / 1000) + 86_400 }, { validAfter: 1, validUntil: Math.floor(Date.now() / 1000) + SAFE_OP_VALIDITY_SECONDS }]) {
      sendPreparedUserOperationMock.mockReset();
      const stored = Math.floor(Date.now() / 1000) + SAFE_OP_VALIDITY_SECONDS;
      const ctx = await setup({ storedValidUntil: stored, signedValidity: { ...signedValidity, validUntil: signedValidity.validAfter === 1 ? stored : signedValidity.validUntil } });

      expect((await submit(ctx)).outcome).toBe("failed");
      expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
    }
  });

  it("fewer than 60 s of the signed window left: refused as expired before dispatch — nothing sent, slot freed", async () => {
    sendPreparedUserOperationMock.mockReset();
    const ctx = await setup();
    const validUntil = (await ctx.paymentStore.findById(ctx.attemptId))!.validUntil!;

    const outcome = await submit(ctx, { now: () => (validUntil - 59) * 1000 });

    expect(outcome.outcome).toBe("failed");
    if (outcome.outcome === "failed") expect(outcome.attempt.failureReason).toMatch(/expired before it could be sent/);
    expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
  });

  it("exactly 60 s left is still enough to dispatch (boundary)", async () => {
    sendPreparedUserOperationMock.mockReset();
    const ctx = await setup();
    sendPreparedUserOperationMock.mockResolvedValueOnce(ctx.expectedUserOperationHash);
    const validUntil = (await ctx.paymentStore.findById(ctx.attemptId))!.validUntil!;

    expect((await submit(ctx, { now: () => (validUntil - 60) * 1000 })).outcome).toBe("submitted");
    expect(sendPreparedUserOperationMock).toHaveBeenCalledTimes(1);
  });

  it("a legacy row with no window is never offered for signing and never dispatched, even with a (0-window) signature that verifies", async () => {
    sendPreparedUserOperationMock.mockReset();
    const ctx = await setup({ storedValidUntil: null });

    const latest = await resolveLatestPayment({ cookieValue: ctx.cookieValue, sessionSecret: SECRET, registry: ctx.registry, paymentStore: ctx.paymentStore });
    expect(latest.outcome === "ok" && latest.attempt.prepared).toBeNull();

    expect((await submit(ctx)).outcome).toBe("failed");
    expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
  });
});

/**
 * Slice S1 — Real Pay credential attribution. Every positive case below runs
 * the REAL client signing path against the stateful fake Turnkey; every
 * negative case mutates exactly ONE field of a genuine recorded activity (or
 * substitutes a genuine activity from somewhere else), so each guard in
 * server/payment-authorization.ts is exercised in isolation — none of the
 * expected values come from the helper under test.
 */
describe("Slice S1 — payment credential attribution", () => {
  type Ctx = Awaited<ReturnType<typeof setup>>;
  const submitAs = (ctx: Ctx, overrides: { cookieValue?: string; signature?: string; activityId?: unknown; now?: () => number } = {}) =>
    resolveSubmitPayment({
      cookieValue: overrides.cookieValue ?? ctx.cookieValue,
      sessionSecret: SECRET,
      registry: ctx.registry,
      paymentStore: ctx.paymentStore,
      pimlicoApiKey: "pim_test_key",
      config: CONFIG,
      attemptId: ctx.attemptId,
      signature: overrides.signature ?? ctx.signature,
      activityId: "activityId" in overrides ? overrides.activityId : ctx.activityId,
      now: overrides.now,
    });
  const sendOk = (ctx: Ctx) => {
    sendPreparedUserOperationMock.mockReset();
    sendPreparedUserOperationMock.mockResolvedValue(ctx.expectedUserOperationHash);
  };
  const row = (ctx: Ctx) => ctx.paymentStore.findById(ctx.attemptId);

  async function expectRejectedNothingSent(ctx: Ctx, outcome: Awaited<ReturnType<typeof submitAs>>) {
    expect(outcome.outcome).toBe("failed");
    if (outcome.outcome === "failed") expect(outcome.attempt.failureReason).toMatch(/passkey approval could not be verified/);
    expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
    const persisted = await row(ctx);
    expect(persisted).toMatchObject({ state: "failed", turnkeySignActivityId: null, authorizationVerifiedAt: null, authorizingCredentialId: P });
  }

  it("P-bound payment approved by P: the ceremony was pinned to exactly [P]; the verified activity is recorded; exactly one dispatch", async () => {
    const ctx = await setup();
    sendOk(ctx);

    expect(ctx.fake.signCeremonies).toEqual([{ allowCredentials: [P] }]);
    const outcome = await submitAs(ctx);

    expect(outcome.outcome).toBe("submitted");
    expect(sendPreparedUserOperationMock).toHaveBeenCalledTimes(1);
    const persisted = await row(ctx);
    expect(persisted).toMatchObject({ state: "submitted", authorizingCredentialId: P, turnkeySignActivityId: ctx.activityId });
    expect(persisted?.authorizationVerifiedAt).toBeTruthy();
  });

  it("S-bound payment from S's session, approved by S, is sent — and attributed to S, not P", async () => {
    const ctx = await setup({ boundTo: S, session: S });
    sendOk(ctx);

    expect(ctx.fake.signCeremonies).toEqual([{ allowCredentials: [S] }]);
    expect((await submitAs(ctx)).outcome).toBe("submitted");
    expect(await row(ctx)).toMatchObject({ authorizingCredentialId: S, turnkeySignActivityId: ctx.activityId });
    expect(ctx.fake.activities.get(ctx.activityId)!.votes).toEqual([expect.objectContaining({ publicKey: ctx.fake.authenticators().find((a) => a.authenticatorId === "authenticator-s")!.credential.publicKey })]);
  });

  it("the server's expected digest is exactly what the real signing path handed Turnkey (independent derivation)", async () => {
    const { computeExpectedSafeOpDigest } = await import("@/lib/real/payments/submit");
    const ctx = await setup();
    const sentPayload = (ctx.fake.activities.get(ctx.activityId)!.intent as { signRawPayloadIntentV2: { payload: string } }).signRawPayloadIntentV2.payload;
    expect(computeExpectedSafeOpDigest({ sender: ctx.safeAddress, ...PREPARED_OPERATION }, ctx.validUntil!)).toBe(sentPayload);
  });

  it("a device holding only S cannot approve a P-bound payment — the pinned prompt offers nothing and no activity is created", async () => {
    const ctx = await setup();
    ctx.fake.deviceCredentials = [S];
    const before = ctx.fake.activities.size;

    await expect(signOperation({ pin: P, validity: { validAfter: 0, validUntil: ctx.validUntil! } })).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(ctx.fake.activities.size).toBe(before);
    expect(ctx.fake.signCeremonies.at(-1)).toEqual({ allowCredentials: [P] });
  });

  it("a malicious (unpinned) client's approval by S, over the RIGHT digest, is rejected for a P-bound payment — nothing sent", async () => {
    const ctx = await setup({ pin: null, device: [S, P] });
    sendOk(ctx);
    expect(ctx.fake.signCeremonies).toEqual([{ allowCredentials: [] }]); // unpinned: the device picked S

    await expectRejectedNothingSent(ctx, await submitAs(ctx));
  });

  it("a DIFFERENT valid owner signature over this exact digest is rejected: the dispatched bytes must be the attributed activity's own output", async () => {
    // Turnkey's ECDSA need not be deterministic, so e.g. S approving the same
    // digest could yield another valid owner signature; paired with P's
    // activity id it would pass every other check. Modeled here by the
    // standard malleation of P's own signature (s -> n - s, flipped v): same
    // digest, still recovers the owner, not the activity's bytes.
    const ctx = await setup();
    sendOk(ctx);
    const N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
    const prefix = ctx.signature.slice(0, 2 + 24);
    const r = ctx.signature.slice(26, 90);
    const sValue = BigInt(`0x${ctx.signature.slice(90, 154)}`);
    const v = Number.parseInt(ctx.signature.slice(154, 156), 16);
    const malleated = `${prefix}${r}${(N - sValue).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}` as Hex;
    const { recoverAddress } = await import("viem");
    const { computeExpectedSafeOpDigest } = await import("@/lib/real/payments/submit");
    const digest = computeExpectedSafeOpDigest({ sender: ctx.safeAddress, ...PREPARED_OPERATION }, ctx.validUntil!);
    expect(await recoverAddress({ hash: digest, signature: `0x${malleated.slice(26)}` as Hex })).toBe(owner.address); // genuinely valid

    await expectRejectedNothingSent(ctx, await submitAs(ctx, { signature: malleated }));
  });

  it("an approval by P for ANOTHER payment's digest is rejected — both with this payment's signature and with the other one's", async () => {
    for (const useOtherSignature of [false, true]) {
      const ctx = await setup();
      sendOk(ctx);
      const other = await signOperation({ operation: { ...PREPARED_OPERATION, callData: "0x5678" }, pin: P, validity: { validAfter: 0, validUntil: ctx.validUntil! } });

      await expectRejectedNothingSent(ctx, await submitAs(ctx, { activityId: other.activityId, ...(useOtherSignature ? { signature: other.signature } : {}) }));
    }
  });

  /** The recorded Turnkey activity, as the tests below edit it. */
  type MutableActivity = {
    organizationId: string;
    type: string;
    status: string;
    intent: { signRawPayloadIntentV2?: Record<string, string> };
    votes: Array<Record<string, string>>;
    result: { signRawPayloadResult?: Record<string, string> };
  };
  const recorded = (ctx: Ctx) => ctx.fake.activities.get(ctx.activityId) as unknown as MutableActivity;

  describe("independent adversarial activity fixtures — one field changed, everything else genuine", () => {
    const WRONG_KEY = `02${"11".repeat(32)}`;
    const sKey = (fake: FakeTurnkey) => fake.authenticators().find((a) => a.authenticatorId === "authenticator-s")!.credential.publicKey;
    const cases: Array<[string, (activity: MutableActivity, fake: FakeTurnkey) => void]> = [
      ["organizationId is another org's", (a) => (a.organizationId = "other-sub-org")],
      ["type is a different signing activity", (a) => (a.type = "ACTIVITY_TYPE_SIGN_RAW_PAYLOADS")],
      ["status FAILED", (a) => (a.status = "ACTIVITY_STATUS_FAILED")],
      ["status REJECTED", (a) => (a.status = "ACTIVITY_STATUS_REJECTED")],
      ["intent payload is another digest", (a) => (a.intent.signRawPayloadIntentV2!.payload = `0x${"ab".repeat(32)}`)],
      ["intent signWith is another address", (a) => (a.intent.signRawPayloadIntentV2!.signWith = impostor.address)],
      ["intent re-hashes the payload", (a) => (a.intent.signRawPayloadIntentV2!.hashFunction = "HASH_FUNCTION_KECCAK256")],
      ["intent encoding is text", (a) => (a.intent.signRawPayloadIntentV2!.encoding = "PAYLOAD_ENCODING_TEXT_UTF8")],
      ["vote publicKey is another key", (a) => (a.votes[0].publicKey = WRONG_KEY)],
      ["vote publicKey is S's key", (a, fake) => (a.votes[0].publicKey = sKey(fake))],
      ["vote userId is another Turnkey user", (a) => (a.votes[0].userId = "other-turnkey-user")],
      ["vote is for another activity", (a) => (a.votes[0].activityId = "some-other-activity")],
      ["vote was a rejection", (a) => (a.votes[0].selection = "VOTE_SELECTION_REJECTED")],
      ["two approvals (P and another key) — ambiguous", (a) => a.votes.push({ ...a.votes[0], id: "vote-2", publicKey: WRONG_KEY })],
      ["result r altered", (a) => (a.result.signRawPayloadResult!.r = "1".repeat(64))],
      ["result v not a yParity", (a) => (a.result.signRawPayloadResult!.v = "1b")],
    ];

    it.each(cases)("%s → rejected, failed, nothing sent, nothing recorded", async (_label, mutate) => {
      const ctx = await setup();
      sendOk(ctx);
      mutate(recorded(ctx), ctx.fake);

      await expectRejectedNothingSent(ctx, await submitAs(ctx));
    });

    it("the SAME genuine activity with only case/whitespace changes to the vote key is still accepted (Proof B's normalization)", async () => {
      const ctx = await setup();
      sendOk(ctx);
      const vote = recorded(ctx).votes[0]!;
      vote.publicKey = ` ${vote.publicKey.toUpperCase()} `;

      expect((await submitAs(ctx)).outcome).toBe("submitted");
    });

    it.each([
      ["status PENDING", (a: MutableActivity) => (a.status = "ACTIVITY_STATUS_PENDING")],
      ["status CONSENSUS_NEEDED", (a: MutableActivity) => (a.status = "ACTIVITY_STATUS_CONSENSUS_NEEDED")],
    ])("%s → unavailable: nothing changes, nothing sent", async (_label, mutate) => {
      const ctx = await setup();
      sendOk(ctx);
      mutate(recorded(ctx));

      expect((await submitAs(ctx)).outcome).toBe("authorization_unavailable");
      expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
      expect(await row(ctx)).toMatchObject({ state: "awaiting_authorization", turnkeySignActivityId: null });
    });
  });

  /**
   * Audit fix 1 — ABSENT/unreadable proof data is "unavailable" (nothing
   * changes, nothing sent, the same approval may be retried); PRESENT but
   * contradicting data is "rejected". Each row edits exactly one field of the
   * genuine recorded activity (or getUsers' record) both ways.
   */
  describe("missing vs wrong — every field the proof uses", () => {
    type Edit = (a: MutableActivity, fake: FakeTurnkey) => void;
    const intentOf = (a: MutableActivity) => a.intent.signRawPayloadIntentV2!;
    const resultOf = (a: MutableActivity) => a.result.signRawPayloadResult!;
    const pAuthenticator = (fake: FakeTurnkey) => fake.authenticators().find((x) => x.authenticatorId === "authenticator-p")!;
    const OTHER_KEY = `03${"42".repeat(32)}`;
    const matrix: Array<[string, Edit, Edit]> = [
      ["activity organizationId", (a) => delete (a as Partial<MutableActivity>).organizationId, (a) => (a.organizationId = "other-sub-org")],
      ["activity type", (a) => delete (a as Partial<MutableActivity>).type, (a) => (a.type = "ACTIVITY_TYPE_SIGN_TRANSACTION_V2")],
      ["activity intent", (a) => delete (a as Partial<MutableActivity>).intent, (a) => (intentOf(a).payload = `0x${"cd".repeat(32)}`)],
      ["signRawPayloadIntentV2 object", (a) => (a.intent = {}), (a) => (intentOf(a).signWith = impostor.address)],
      ["intent payload", (a) => delete intentOf(a).payload, (a) => (intentOf(a).payload = `0x${"ab".repeat(32)}`)],
      ["intent signWith", (a) => delete intentOf(a).signWith, (a) => (intentOf(a).signWith = impostor.address)],
      ["intent hashFunction", (a) => delete intentOf(a).hashFunction, (a) => (intentOf(a).hashFunction = "HASH_FUNCTION_SHA256")],
      ["intent encoding", (a) => delete intentOf(a).encoding, (a) => (intentOf(a).encoding = "PAYLOAD_ENCODING_TEXT_UTF8")],
      ["votes array", (a) => delete (a as Partial<MutableActivity>).votes, (a) => (a.votes = [{ ...a.votes[0]!, selection: "VOTE_SELECTION_REJECTED" }])],
      ["votes present but empty ([] = no proof, not proof of refusal)", (a) => (a.votes = []), (a) => a.votes.push({ ...a.votes[0]!, id: "vote-2", publicKey: OTHER_KEY })],
      ["vote entry", (a) => (a.votes = [null as unknown as Record<string, string>]), (a) => (a.votes[0]!.selection = "VOTE_SELECTION_REJECTED")],
      ["vote selection", (a) => delete a.votes[0]!.selection, (a) => (a.votes[0]!.selection = "VOTE_SELECTION_REJECTED")],
      ["vote activityId", (a) => delete a.votes[0]!.activityId, (a) => (a.votes[0]!.activityId = "another-activity")],
      ["vote userId", (a) => delete a.votes[0]!.userId, (a) => (a.votes[0]!.userId = "another-turnkey-user")],
      ["vote publicKey", (a) => delete a.votes[0]!.publicKey, (a) => (a.votes[0]!.publicKey = OTHER_KEY)],
      ["activity result", (a) => delete (a as Partial<MutableActivity>).result, (a) => (resultOf(a).s = "2".repeat(64))],
      ["signRawPayloadResult object", (a) => (a.result = {}), (a) => (resultOf(a).r = "1".repeat(64))],
      ["result r", (a) => delete resultOf(a).r, (a) => (resultOf(a).r = "zz")],
      ["result s", (a) => delete resultOf(a).s, (a) => (resultOf(a).s = "1".repeat(64))],
      ["result v", (a) => delete resultOf(a).v, (a) => (resultOf(a).v = "7")],
      ["matched authenticator credential.publicKey (getUsers)", (_a, fake) => (pAuthenticator(fake).credential = {} as { publicKey: string }), (_a, fake) => (pAuthenticator(fake).credential.publicKey = OTHER_KEY)],
    ];

    it.each(matrix)("%s: MISSING → unavailable — nothing changes, nothing sent", async (_field, missing) => {
      const ctx = await setup();
      sendOk(ctx);
      missing(recorded(ctx), ctx.fake);

      expect((await submitAs(ctx)).outcome).toBe("authorization_unavailable");
      expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
      expect(await row(ctx)).toMatchObject({ state: "awaiting_authorization", turnkeySignActivityId: null, authorizationVerifiedAt: null });
    });

    it.each(matrix)("%s: WRONG → rejected — failed, nothing sent, nothing recorded", async (_field, _missing, wrong) => {
      const ctx = await setup();
      sendOk(ctx);
      wrong(recorded(ctx), ctx.fake);

      await expectRejectedNothingSent(ctx, await submitAs(ctx));
    });

    it("the activity record itself unreadable (no status) → unavailable", async () => {
      const ctx = await setup();
      sendOk(ctx);
      delete (recorded(ctx) as Partial<MutableActivity>).status;

      expect((await submitAs(ctx)).outcome).toBe("authorization_unavailable");
      expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
    });

    it("present-and-wrong wins over missing: another digest with the organization missing is still rejected", async () => {
      const ctx = await setup();
      sendOk(ctx);
      delete (recorded(ctx) as Partial<MutableActivity>).organizationId;
      intentOf(recorded(ctx)).payload = `0x${"ab".repeat(32)}`;

      await expectRejectedNothingSent(ctx, await submitAs(ctx));
    });

    it("after 'unavailable' for missing data, the SAME approval is sent exactly once when Turnkey's record is complete — no second ceremony", async () => {
      const ctx = await setup();
      sendOk(ctx);
      const saved = structuredClone(recorded(ctx).votes);
      delete (recorded(ctx) as Partial<MutableActivity>).votes;
      expect((await submitAs(ctx)).outcome).toBe("authorization_unavailable");

      recorded(ctx).votes = saved;
      expect((await submitAs(ctx)).outcome).toBe("submitted");
      expect(sendPreparedUserOperationMock).toHaveBeenCalledTimes(1);
      expect(ctx.fake.signCeremonies).toHaveLength(1);
    });
  });

  /** Audit fix 2 — a vote key must identify ONE credential of the user. */
  describe("public-key ambiguity", () => {
    it("P and S are different credentials but Turnkey lists the SAME public key for both: a vote with that key can't attribute P — rejected, zero sends", async () => {
      const ctx = await setup();
      sendOk(ctx);
      const [p, sAuth] = [ctx.fake.authenticators().find((a) => a.authenticatorId === "authenticator-p")!, ctx.fake.authenticators().find((a) => a.authenticatorId === "authenticator-s")!];
      sAuth.credential.publicKey = p.credential.publicKey.toUpperCase(); // same key, different spelling
      expect(p.credentialId).not.toBe(sAuth.credentialId);

      await expectRejectedNothingSent(ctx, await submitAs(ctx));
    });

    it("two Turnkey authenticators with the bound credential's exact id bytes remain ambiguous — rejected, zero sends", async () => {
      const ctx = await setup();
      sendOk(ctx);
      ctx.fake.addAuthenticator(P, "authenticator-p-duplicate");

      await expectRejectedNothingSent(ctx, await submitAs(ctx));
    });
  });

  it("an activity id that doesn't exist (or isn't readable in this org) is unavailable, never trusted — nothing changes", async () => {
    const ctx = await setup();
    sendOk(ctx);

    expect((await submitAs(ctx, { activityId: "no-such-activity" })).outcome).toBe("authorization_unavailable");
    expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
    expect((await row(ctx))?.state).toBe("awaiting_authorization");
  });

  it.each([[""], ["../../x"], ["a".repeat(129)], [42], [null], [undefined]])("a malformed activity id %j is refused before the row is touched", async (activityId) => {
    const ctx = await setup();
    sendOk(ctx);
    const findSpy = vi.spyOn(ctx.paymentStore, "findById");

    expect((await submitAs(ctx, { activityId })).outcome).toBe("invalid_signature");
    expect(findSpy).not.toHaveBeenCalled();
    expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
  });

  it("Turnkey lookup failing (getActivity, then getUsers) changes nothing; once it recovers, the SAME signature + activity is sent exactly once — no second passkey ceremony", async () => {
    const ctx = await setup();
    sendOk(ctx);
    const realGetActivity = ctx.fake.getActivity;
    const realGetUsers = ctx.fake.getUsers;
    ctx.fake.getActivity = async () => {
      throw new Error("503 from Turnkey");
    };
    expect((await submitAs(ctx)).outcome).toBe("authorization_unavailable");
    ctx.fake.getActivity = realGetActivity;
    ctx.fake.getUsers = async () => {
      throw new Error("timeout");
    };
    expect((await submitAs(ctx)).outcome).toBe("authorization_unavailable");
    expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
    expect(await row(ctx)).toMatchObject({ state: "awaiting_authorization", turnkeySignActivityId: null });

    ctx.fake.getUsers = realGetUsers;
    expect((await submitAs(ctx)).outcome).toBe("submitted");
    expect(sendPreparedUserOperationMock).toHaveBeenCalledTimes(1);
    expect(ctx.fake.signCeremonies).toHaveLength(1);
  });

  it("the bound credential not (yet) visible in getUsers is unavailable, never a pass", async () => {
    const ctx = await setup();
    sendOk(ctx);
    ctx.fake.users.set("turnkey-user-1", ctx.fake.authenticators().filter((a) => a.authenticatorId !== "authenticator-p"));

    expect((await submitAs(ctx)).outcome).toBe("authorization_unavailable");
    expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
  });

  it("the bound credential mapped by the registry to a DIFFERENT Turnkey authenticator is rejected", async () => {
    const ctx = await setup();
    sendOk(ctx);
    getInMemoryRegistryInternals(ctx.registry).passkeysByCredentialId.set(P, { ...(await ctx.registry.findPasskeyByCredentialId(P))!, turnkeyAuthenticatorId: "authenticator-s" });

    await expectRejectedNothingSent(ctx, await submitAs(ctx));
  });

  it("an unmapped primary (turnkeyAuthenticatorId still null, as for accounts not yet backfilled) is still proven by credential-id BYTES and sent", async () => {
    const ctx = await setup();
    sendOk(ctx);
    getInMemoryRegistryInternals(ctx.registry).passkeysByCredentialId.set(P, { ...(await ctx.registry.findPasskeyByCredentialId(P))!, turnkeyAuthenticatorId: null });

    expect((await submitAs(ctx)).outcome).toBe("submitted");
  });

  it("one approval never authorizes two payments: a second row with the IDENTICAL digest can't reuse a recorded activity", async () => {
    const ctx = await setup();
    sendOk(ctx);
    expect((await submitAs(ctx)).outcome).toBe("submitted");
    await ctx.paymentStore.transition({ id: ctx.attemptId, from: "submitted", to: "confirmed" });

    const original = (await row(ctx))!;
    const twin = await ctx.paymentStore.reserve({ ...original, authorizingCredentialId: P });
    if (!twin.ok) throw new Error("expected a second reservation");
    await ctx.paymentStore.transition({ id: twin.attempt.id, from: "prepared", to: "awaiting_authorization", patch: ctx.patch });

    const outcome = await submitAs({ ...ctx, attemptId: twin.attempt.id });

    expect(outcome.outcome).toBe("failed");
    expect(sendPreparedUserOperationMock).toHaveBeenCalledTimes(1); // only the original
    expect(await ctx.paymentStore.findById(twin.attempt.id)).toMatchObject({ state: "failed", turnkeySignActivityId: null });
  });

  it("a duplicate submit with the same activity after success is refused (wrong_state) — still exactly one dispatch", async () => {
    const ctx = await setup();
    sendOk(ctx);
    expect((await submitAs(ctx)).outcome).toBe("submitted");
    expect((await submitAs(ctx)).outcome).toBe("wrong_state");
    expect(sendPreparedUserOperationMock).toHaveBeenCalledTimes(1);
  });

  describe("session changes never re-bind a payment", () => {
    it("prepared under P; the app session is now S: submit (even with P's genuine approval) is refused without touching the row; /latest gives S no signing context", async () => {
      const ctx = await setup();
      sendOk(ctx);
      const sCookie = ctx.cookieFor(S);

      expect((await submitAs(ctx, { cookieValue: sCookie })).outcome).toBe("wrong_passkey");
      expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
      expect(await row(ctx)).toMatchObject({ state: "awaiting_authorization", authorizingCredentialId: P, turnkeySignActivityId: null });

      const latestS = await resolveLatestPayment({ cookieValue: sCookie, sessionSecret: SECRET, registry: ctx.registry, paymentStore: ctx.paymentStore });
      expect(latestS).toMatchObject({ outcome: "ok", subOrganizationId: null, authorizingCredentialId: null });
      const latestP = await resolveLatestPayment({ cookieValue: ctx.cookieValue, sessionSecret: SECRET, registry: ctx.registry, paymentStore: ctx.paymentStore });
      expect(latestP).toMatchObject({ outcome: "ok", subOrganizationId: "sub-org-1", authorizingCredentialId: P });

      // S may still cancel it (cancelling moves no money) — the only way forward from S is a NEW payment.
      expect((await resolveCancelPayment({ cookieValue: sCookie, sessionSecret: SECRET, registry: ctx.registry, paymentStore: ctx.paymentStore, attemptId: ctx.attemptId })).outcome).toBe("cancelled");
    });

    it("prepared under P, approved by S (a session switch before signing) and submitted from S's session: refused — never re-bound to S", async () => {
      const ctx = await setup({ pin: S, session: S });
      sendOk(ctx);

      expect((await submitAs(ctx)).outcome).toBe("wrong_passkey");
      expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
      expect((await row(ctx))?.authorizingCredentialId).toBe(P);
    });

    it("a binding that isn't the registry's exact credential key (impossible under Neon's FK) fails closed at the atomic dispatch claim — nothing sent", async () => {
      const ctx = await setup();
      sendOk(ctx);
      // Same credential BYTES (so the session<->binding byte comparison and the
      // Turnkey proof both pass), but not the registry's key spelling.
      Object.assign((await row(ctx))!, { authorizingCredentialId: Buffer.from(P, "base64url").toString("base64") });

      expect((await submitAs(ctx)).outcome).toBe("failed");
      expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
    });
  });

  describe("revocation", () => {
    it("P revoked after prepare, before signing: P's session is gone (unauthenticated) and S's is the wrong passkey — nothing sent", async () => {
      const ctx = await setup();
      sendOk(ctx);
      await ctx.registry.transitionPasskeyStatus({ credentialId: P, from: "active", to: "revoking" });

      expect((await submitAs(ctx)).outcome).toBe("unauthenticated");
      expect((await submitAs(ctx, { cookieValue: ctx.cookieFor(S) })).outcome).toBe("wrong_passkey");
      expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
    });

    it("P's removal starts AFTER its approval was verified but before dispatch: refused at the last step — nothing sent, the proven approval kept as evidence", async () => {
      const ctx = await setup();
      sendOk(ctx);
      const originalTransition = ctx.paymentStore.transition.bind(ctx.paymentStore);
      vi.spyOn(ctx.paymentStore, "transition").mockImplementation(async (args) => {
        const result = await originalTransition(args);
        if (args.from === "awaiting_authorization" && args.to === "signed" && result) await ctx.registry.transitionPasskeyStatus({ credentialId: P, from: "active", to: "revoking" });
        return result;
      });

      const outcome = await submitAs(ctx);

      expect(outcome.outcome).toBe("failed");
      if (outcome.outcome === "failed") expect(outcome.attempt.failureReason).toMatch(/removed before it could be sent/);
      expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
      expect(await row(ctx)).toMatchObject({ state: "failed", turnkeySignActivityId: ctx.activityId, authorizingCredentialId: P });
    });

    it("renaming, then revoking, the approving passkey never erases the payment's attribution — the revoked passkey row stays as evidence", async () => {
      const ctx = await setup();
      sendOk(ctx);
      expect((await submitAs(ctx)).outcome).toBe("submitted");

      expect((await ctx.registry.renamePasskey({ appUserId: "app-user-1", credentialId: P, displayName: "Old phone" })).outcome).toBe("renamed");
      await ctx.registry.transitionPasskeyStatus({ credentialId: P, from: "active", to: "revoking" });
      await ctx.registry.transitionPasskeyStatus({ credentialId: P, from: "revoking", to: "revoked" });

      expect(await row(ctx)).toMatchObject({ authorizingCredentialId: P, turnkeySignActivityId: ctx.activityId });
      expect(await ctx.registry.findPasskeyByCredentialId(P)).toMatchObject({ status: "revoked", displayName: "Old phone" });
    });
  });

  /** Audit fix 3 — "still active" and "may dispatch" are one atomic claim. */
  describe("atomic active-at-dispatch claim", () => {
    const revokeP = (ctx: Ctx) => ctx.registry.transitionPasskeyStatus({ credentialId: P, from: "active", to: "revoking" });

    it("a removal that commits immediately BEFORE the dispatch claim: the claim fails — no send, row failed, approval kept as evidence", async () => {
      const ctx = await setup();
      sendOk(ctx);
      const original = ctx.paymentStore.beginDispatch.bind(ctx.paymentStore);
      vi.spyOn(ctx.paymentStore, "beginDispatch").mockImplementation(async (args) => {
        await revokeP(ctx); // lands between every earlier check and the claim itself
        return original(args);
      });

      const outcome = await submitAs(ctx);

      expect(outcome.outcome).toBe("failed");
      if (outcome.outcome === "failed") expect(outcome.attempt.failureReason).toMatch(/removed before it could be sent/);
      expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
      expect(await row(ctx)).toMatchObject({ state: "failed", turnkeySignActivityId: ctx.activityId });
    });

    it("a removal that commits immediately AFTER the dispatch claim doesn't unsend it: exactly one send", async () => {
      const ctx = await setup();
      sendOk(ctx);
      const original = ctx.paymentStore.beginDispatch.bind(ctx.paymentStore);
      vi.spyOn(ctx.paymentStore, "beginDispatch").mockImplementation(async (args) => {
        const claimed = await original(args);
        await revokeP(ctx);
        return claimed;
      });

      expect((await submitAs(ctx)).outcome).toBe("submitted");
      expect(sendPreparedUserOperationMock).toHaveBeenCalledTimes(1);
      expect((await ctx.registry.findPasskeyByCredentialId(P))?.status).toBe("revoking");
    });

    it("a cancel that wins while the dispatch claim is pending: the claim fails, the row stays cancelled, no send", async () => {
      const ctx = await setup();
      sendOk(ctx);
      const original = ctx.paymentStore.beginDispatch.bind(ctx.paymentStore);
      vi.spyOn(ctx.paymentStore, "beginDispatch").mockImplementation(async (args) => {
        expect((await resolveCancelPayment({ cookieValue: ctx.cookieValue, sessionSecret: SECRET, registry: ctx.registry, paymentStore: ctx.paymentStore, attemptId: ctx.attemptId })).outcome).toBe("cancelled");
        return original(args);
      });

      expect(await submitAs(ctx)).toMatchObject({ outcome: "wrong_state", state: "cancelled" });
      expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
    });

    it("status reconciliation racing the claim never dispatches: a pre-expiry signed row is left alone, then sent once", async () => {
      const ctx = await setup();
      sendOk(ctx);
      const original = ctx.paymentStore.beginDispatch.bind(ctx.paymentStore);
      vi.spyOn(ctx.paymentStore, "beginDispatch").mockImplementation(async (args) => {
        const status = await resolvePaymentStatus({ cookieValue: ctx.cookieValue, sessionSecret: SECRET, registry: ctx.registry, paymentStore: ctx.paymentStore, pimlicoApiKey: "pim_test_key", publicClient: createFakeEntryPoint({}).reader, attemptId: ctx.attemptId });
        expect(status.outcome === "ok" && status.attempt.state).toBe("signed");
        return original(args);
      });

      expect((await submitAs(ctx)).outcome).toBe("submitted");
      expect(sendPreparedUserOperationMock).toHaveBeenCalledTimes(1);
    });
  });

  /** Audit fix 4 — a lost claim reports the row's fresh durable state. */
  it("two overlapping submits that BOTH pass verification: exactly one dispatch, and the loser reports the real current state, never the stale 'awaiting_authorization'", async () => {
    const ctx = await setup();
    sendOk(ctx);
    // Barrier: neither submit's Turnkey read returns until both are past the
    // pre-claim state check, so both genuinely race the claim.
    const realGetActivity = ctx.fake.getActivity;
    let arrived = 0;
    let release!: () => void;
    const bothArrived = new Promise<void>((resolve) => (release = resolve));
    ctx.fake.getActivity = async (request) => {
      arrived += 1;
      if (arrived === 2) release();
      await bothArrived;
      return realGetActivity(request);
    };
    const claimSpy = vi.spyOn(ctx.paymentStore, "transition");

    const outcomes = await Promise.all([submitAs(ctx), submitAs(ctx)]);

    expect(arrived).toBe(2);
    expect(claimSpy.mock.calls.filter(([args]) => args.from === "awaiting_authorization" && args.to === "signed")).toHaveLength(2); // both reached the claim
    expect(sendPreparedUserOperationMock).toHaveBeenCalledTimes(1);
    const loser = outcomes.find((o) => o.outcome !== "submitted");
    expect(outcomes.filter((o) => o.outcome === "submitted")).toHaveLength(1);
    expect(loser?.outcome).toBe("wrong_state");
    if (loser?.outcome === "wrong_state") expect(loser.state).not.toBe("awaiting_authorization");
  });

  it("a legacy row with NO binding fails closed — never signed for, never dispatched, never back-filled", async () => {
    const ctx = await setup({ boundTo: null });
    sendOk(ctx);

    const latest = await resolveLatestPayment({ cookieValue: ctx.cookieValue, sessionSecret: SECRET, registry: ctx.registry, paymentStore: ctx.paymentStore });
    expect(latest).toMatchObject({ outcome: "ok", subOrganizationId: null, authorizingCredentialId: null });

    const outcome = await submitAs(ctx);
    expect(outcome.outcome).toBe("failed");
    if (outcome.outcome === "failed") expect(outcome.attempt.failureReason).toMatch(/before a security update/);
    expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
    expect(await row(ctx)).toMatchObject({ authorizingCredentialId: null, turnkeySignActivityId: null, authorizationVerifiedAt: null });
  });

  it("the payment expires WHILE its approval is being verified: refused after the Turnkey reads, before dispatch", async () => {
    const ctx = await setup();
    sendOk(ctx);
    const clock = { ms: (ctx.validUntil! - 120) * 1000 };
    const realGetActivity = ctx.fake.getActivity;
    ctx.fake.getActivity = async (request) => {
      clock.ms = (ctx.validUntil! - 30) * 1000; // a slow read eats the dispatch margin
      return realGetActivity(request);
    };

    const outcome = await submitAs(ctx, { now: () => clock.ms });

    expect(outcome.outcome).toBe("failed");
    if (outcome.outcome === "failed") expect(outcome.attempt.failureReason).toMatch(/expired before it could be sent/);
    expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
  });

  it("the claim write failing after verification sends nothing and leaves the row resumable; a retry with the SAME approval then sends once", async () => {
    const ctx = await setup();
    sendOk(ctx);
    const originalTransition = ctx.paymentStore.transition.bind(ctx.paymentStore);
    const spy = vi.spyOn(ctx.paymentStore, "transition").mockImplementationOnce(async (args) => {
      if (args.from === "awaiting_authorization" && args.to === "signed") throw new Error("connection reset");
      return originalTransition(args);
    });

    await expect(submitAs(ctx)).rejects.toThrow("connection reset"); // route -> fixed 500
    expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
    expect(await row(ctx)).toMatchObject({ state: "awaiting_authorization", turnkeySignActivityId: null });

    spy.mockRestore();
    expect((await submitAs(ctx)).outcome).toBe("submitted");
    expect(sendPreparedUserOperationMock).toHaveBeenCalledTimes(1);
  });

  it("browser crash after Turnkey signed but before /submit: the unsubmitted approval is never used; resuming approves again (same operation, same nonce) and exactly one is sent", async () => {
    const ctx = await setup(); // approval A exists at Turnkey but /submit never happened
    sendOk(ctx);
    const resumed = await signOperation({ pin: P, validity: { validAfter: 0, validUntil: ctx.validUntil! } });

    expect((await submitAs(ctx, { signature: resumed.signature, activityId: resumed.activityId })).outcome).toBe("submitted");
    expect((await submitAs(ctx)).outcome).toBe("wrong_state"); // A can no longer be used
    expect(sendPreparedUserOperationMock).toHaveBeenCalledTimes(1);
    expect((await row(ctx))?.turnkeySignActivityId).toBe(resumed.activityId);
  });
});
