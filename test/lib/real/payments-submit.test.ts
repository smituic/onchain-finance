import { describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, encodeAbiParameters, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createInMemoryRealAccountRegistry } from "@/lib/real/server/registry";
import { createSessionPayload, serializeSession } from "@/lib/real/server/session";
import { createInMemoryPaymentAttemptStore, type PaymentAttemptPatch } from "@/lib/real/server/payment-attempts";

const SECRET = "test-session-secret";

const owner = privateKeyToAccount("0x119bb329df425b685a3f3483fba01deeb1db47d608cfb051da9ad4a12995238a");
const impostor = privateKeyToAccount("0xe3b5b13304d3d1e786145c392ddcb41c2d0c9697079968a5b9ab5b415393642f");

let signWithKey = owner;
const signRawPayloadMock = vi.fn(async (activity: unknown) => {
  const parameters = (activity as { parameters: { payload: Hex } }).parameters;
  const signature = await signWithKey.sign({ hash: parameters.payload });
  return {
    activity: {
      id: "activity-1",
      result: {
        signRawPayloadResult: {
          r: signature.slice(2, 66),
          s: signature.slice(66, 130),
          v: Number.parseInt(signature.slice(130), 16) === 27 ? "0" : "1",
        },
      },
    },
  };
});

vi.mock("@turnkey/http", () => ({
  TurnkeyClient: vi.fn().mockImplementation(function TurnkeyClientMock() {
    return { signRawPayload: signRawPayloadMock };
  }),
}));

const sendPreparedUserOperationMock = vi.fn();
const fetchUserOperationReceiptMock = vi.fn();
vi.mock("@/lib/real/server/pimlico", () => ({
  prepareCashTransferUserOperation: vi.fn(),
  sendPreparedUserOperation: (...args: unknown[]) => sendPreparedUserOperationMock(...(args as [never])),
  fetchUserOperationReceipt: (...args: unknown[]) => fetchUserOperationReceiptMock(...(args as [never])),
}));

const { resolveSubmitPayment, resolvePaymentStatus, resolveCancelPayment } = await import("@/lib/real/server/payments");
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

/** Builds a real Safe account (offline) and a real, valid signature over PREPARED_OPERATION, plus a matching durable PaymentAttempt row and registry — everything resolveSubmitPayment needs to independently re-verify the signature exactly like production would. */
async function setup(options: { signAs?: typeof owner } = {}) {
  signWithKey = options.signAs ?? owner;
  const verifiedOwner = createVerifiedTurnkeyOwnerAccount({ rpId: "example.com", subOrganizationId: "sub-org-1", ownerAddress: owner.address });
  const account = await createRealSafeAccount({ owner: verifiedOwner, publicClient: buildOfflinePublicClient() });
  const signature = await account.signUserOperation({ ...PREPARED_OPERATION, sender: account.address });

  const registry = createInMemoryRealAccountRegistry();
  await registry.createAccountWithPasskey({
    account: {
      appUserId: "app-user-1",
      subOrganizationId: "sub-org-1",
      turnkeyUserId: "turnkey-user-1",
      walletId: "wallet-1",
      walletAccountId: "wallet-account-1",
      ownerAddress: owner.address,
      safeAddress: account.address,
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

  const fields = { sender: account.address, ...PREPARED_OPERATION };
  const expectedUserOperationHash = computeExpectedUserOperationHash(fields);

  const paymentStore = createInMemoryPaymentAttemptStore();
  const reserved = await paymentStore.reserve({
    appUserId: "app-user-1",
    safeAddress: account.address,
    recipient: "0x2222222222222222222222222222222222222222",
    amountBaseUnits: "1000000",
    chainId: baseSepolia.id,
    tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
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
  };
  await paymentStore.transition({ id: reserved.attempt.id, from: "prepared", to: "awaiting_authorization", patch });

  const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1" }), SECRET);
  return { registry, paymentStore, attemptId: reserved.attempt.id, signature, cookieValue, expectedUserOperationHash };
}

describe("resolveSubmitPayment", () => {
  it("a correct signature dispatches to the bundler and the returned hash (matching the precomputed expected hash) confirms 'submitted'", async () => {
    sendPreparedUserOperationMock.mockReset();
    const { registry, paymentStore, attemptId, signature, cookieValue, expectedUserOperationHash } = await setup();
    sendPreparedUserOperationMock.mockResolvedValueOnce(expectedUserOperationHash);

    const outcome = await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", attemptId, signature });

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

    const outcome = await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", attemptId, signature: malformed });

    expect(outcome.outcome).toBe("invalid_signature");
    expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
    const persisted = await paymentStore.findById(attemptId);
    expect(persisted?.state).toBe("awaiting_authorization");
  });

  it("pre-2f hardening: a malformed (non-UUID) attemptId is refused as not_found, never reaching the store", async () => {
    sendPreparedUserOperationMock.mockReset();
    const { registry, paymentStore, signature, cookieValue } = await setup();
    const findByIdSpy = vi.spyOn(paymentStore, "findById");

    const outcome = await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", attemptId: "not-a-uuid", signature });

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

    const outcome = await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", attemptId, signature });

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

    const outcome = await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", attemptId, signature });

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

    const outcome = await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", attemptId, signature });

    expect(outcome.outcome).toBe("unknown");
  });

  it("a network failure after a signature exists is unresolved (unknown), never silently treated as failed", async () => {
    sendPreparedUserOperationMock.mockReset();
    sendPreparedUserOperationMock.mockRejectedValueOnce(new Error("fetch failed"));
    const { registry, paymentStore, attemptId, signature, cookieValue } = await setup();

    const outcome = await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", attemptId, signature });

    expect(outcome.outcome).toBe("unknown");
    // The precomputed hash survives the lost response — reconciliation still has a key to look up.
    const persisted = await paymentStore.findById(attemptId);
    expect(persisted?.expectedUserOperationHash).toBeTruthy();
  });

  it("never persists the raw signature anywhere in the durable attempt record", async () => {
    sendPreparedUserOperationMock.mockReset();
    const { registry, paymentStore, attemptId, signature, cookieValue, expectedUserOperationHash } = await setup();
    sendPreparedUserOperationMock.mockResolvedValueOnce(expectedUserOperationHash);

    await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", attemptId, signature });

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

    const outcome = await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", attemptId, signature });

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

    const outcome = await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", attemptId, signature });

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

    const outcome = await resolvePaymentStatus({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", attemptId });

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
      resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", attemptId, signature }),
      resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", attemptId, signature }),
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

    const outcome = await resolvePaymentStatus({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", attemptId });

    expect(outcome.outcome).toBe("ok");
    if (outcome.outcome !== "ok") return;
    expect(outcome.attempt.state).toBe("submitting");
    expect(sendPreparedUserOperationMock).not.toHaveBeenCalled();
  });

  it("F: a returned-hash mismatch during dispatch moves submitting -> unknown (already exercised via the full flow above)", async () => {
    sendPreparedUserOperationMock.mockReset();
    const { registry, paymentStore, attemptId, signature, cookieValue } = await setup();
    sendPreparedUserOperationMock.mockResolvedValueOnce("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");

    const outcome = await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", attemptId, signature });

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

    const outcome = await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", attemptId, signature });

    expect(outcome.outcome).toBe("failed");
    const persisted = await paymentStore.findById(attemptId);
    expect(persisted?.state).toBe("failed");
  });

  it("H: a transport timeout (no recognized bundler rejection) transitions submitting -> unknown, never failed", async () => {
    sendPreparedUserOperationMock.mockReset();
    const { registry, paymentStore, attemptId, signature, cookieValue } = await setup();
    const timeoutError = Object.assign(new Error("The request took too long to respond."), { name: "TimeoutError" });
    sendPreparedUserOperationMock.mockRejectedValueOnce(timeoutError);

    const outcome = await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", attemptId, signature });

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

    const outcome = await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", attemptId, signature });

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

    const originalTransition = paymentStore.transition.bind(paymentStore);
    const transitionSpy = vi.spyOn(paymentStore, "transition").mockImplementation(async (args) => {
      const result = await originalTransition(args);
      if (args.from === "signed" && args.to === "submitting" && result) {
        // Simulate a concurrent cancel request arriving the instant submit's
        // own second CAS lands (the row is "submitting" now).
        const cancelOutcome = await resolveCancelPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, attemptId });
        expect(cancelOutcome.outcome).toBe("wrong_state");
      }
      return result;
    });

    const outcome = await resolveSubmitPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore, pimlicoApiKey: "pim_test_key", attemptId, signature });

    expect(outcome.outcome).toBe("submitted");
    expect(sendPreparedUserOperationMock).toHaveBeenCalledTimes(1);
    transitionSpy.mockRestore();
  });
});
