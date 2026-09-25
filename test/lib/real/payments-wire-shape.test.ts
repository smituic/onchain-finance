import { describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, encodeAbiParameters, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { rpcBlock } from "./fixtures/chain-block";
import { splitSafeOpSignature } from "@/lib/real/payments/safe-op-preflight";

/**
 * Regression test for a live incident: a real Batch 2d payment attempt sat
 * in Neon at `awaiting_authorization` with a real recipient/amount, but
 * tapping Continue/Approve threw "Cannot read properties of undefined
 * (reading 'toLowerCase')" client-side, BEFORE any WebAuthn ceremony or
 * /submit call. Root cause: server/payments.ts's `toPublicAttempt` built
 * its `prepared` object from an independently-declared PublicPreparedFields
 * type that omitted `sender`, while the client's WirePreparedFields (and
 * client-sign.ts's `fields.sender.toLowerCase()` consistency check)
 * required it — a shape mismatch across the HTTP boundary that no static
 * type check could catch, since the server and client never shared one
 * type. The fix makes server/payments.ts import WirePreparedFields
 * directly instead of re-declaring an equivalent shape.
 *
 * This test exercises the REAL client-side signing code
 * (lib/real/payments/client-sign.ts) against the REAL server-side
 * response-shaping code (lib/real/server/payments.ts), with an actual
 * JSON.stringify/parse round trip in between — the exact boundary the bug
 * lived at — for both the fresh /prepare path and the /latest (reload
 * restore) path, which share the same mapper.
 */

const owner = privateKeyToAccount("0x119bb329df425b685a3f3483fba01deeb1db47d608cfb051da9ad4a12995238a");

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

const DUMMY_BYTES_RETURN = encodeAbiParameters([{ type: "bytes" }], ["0x600a600c600039600a6000f3" as Hex]);
const BALANCE_OF_SELECTOR = "0x70a08231";
const DECIMALS_SELECTOR = "0x313ce567";

/** What createRealSafeAccount needs to derive/verify a Safe address offline — used (via the chain/client mock below) as the public client signPreparedPayment builds internally, exactly like the real browser would against a real RPC. */
function buildSigningPublicClient() {
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

/** What resolvePreparePayment's live balance check needs — a separate client from the one above, exactly like production (a route-supplied balance-read client vs. the client signPreparedPayment builds for itself). */
function buildBalanceCheckClient(balanceBaseUnits: bigint) {
  return createPublicClient({
    chain: baseSepolia,
    transport: custom({
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === "eth_chainId") return `0x${baseSepolia.id.toString(16)}`;
        if (method === "eth_getBlockByNumber") return rpcBlock();
        if (method === "eth_call") {
          const call = (params?.[0] ?? {}) as { data?: string };
          const selector = call.data?.slice(0, 10);
          if (selector === BALANCE_OF_SELECTOR) return encodeAbiParameters([{ type: "uint256" }], [balanceBaseUnits]);
          if (selector === DECIMALS_SELECTOR) return encodeAbiParameters([{ type: "uint8" }], [6]);
          throw new Error(`Unexpected selector: ${selector}`);
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    }),
  });
}

const signingPublicClient = buildSigningPublicClient();
vi.mock("@/lib/real/chain/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/real/chain/client")>();
  return { ...actual, createRealPublicClient: () => signingPublicClient };
});

const { createRealSafeAccount } = await import("@/lib/real/account/safe");
const SAFE_ADDRESS = (await createRealSafeAccount({ owner, publicClient: signingPublicClient })).address;

const PREPARED_OPERATION = {
  sender: SAFE_ADDRESS,
  nonce: BigInt(0),
  factory: undefined,
  factoryData: undefined,
  callData: "0x1234" as Hex,
  callGasLimit: BigInt(80_000),
  verificationGasLimit: BigInt(150_000),
  preVerificationGas: BigInt(60_000),
  maxFeePerGas: BigInt(2_000_000),
  maxPriorityFeePerGas: BigInt(1_000_000),
  paymaster: undefined,
  paymasterData: undefined,
  paymasterVerificationGasLimit: undefined,
  paymasterPostOpGasLimit: undefined,
} as const;

const prepareCashTransferUserOperationMock: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<typeof PREPARED_OPERATION>>> = vi.fn(async () => ({
  ...PREPARED_OPERATION,
}));
vi.mock("@/lib/real/server/pimlico", () => ({
  prepareCashTransferUserOperation: (...args: unknown[]) => prepareCashTransferUserOperationMock(...(args as [never])),
  sendPreparedUserOperation: vi.fn(),
  fetchUserOperationReceipt: vi.fn(),
}));

const { resolvePreparePayment, resolveLatestPayment } = await import("@/lib/real/server/payments");
const { signPreparedPayment, PAYMENT_EXPIRED_BEFORE_APPROVAL } = await import("@/lib/real/payments/client-sign");
const { createInMemoryRealAccountRegistry } = await import("@/lib/real/server/registry");
const { createInMemoryPaymentAttemptStore } = await import("@/lib/real/server/payment-attempts");
const { createSessionPayload, serializeSession } = await import("@/lib/real/server/session");

const SECRET = "test-session-secret";
const RECIPIENT = "0x596196A3D57cE744C835B9FE888B0c5631217eA8";

async function seedAccount() {
  const registry = createInMemoryRealAccountRegistry();
  await registry.createAccountWithPasskey({
    account: {
      appUserId: "app-user-1",
      subOrganizationId: "sub-org-1",
      turnkeyUserId: "turnkey-user-1",
      walletId: "wallet-1",
      walletAccountId: "wallet-account-1",
      ownerAddress: owner.address,
      safeAddress: SAFE_ADDRESS,
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
  return registry;
}

/** Simulates the actual HTTP transport — a plain object goes out, plain JSON comes back — exactly the boundary the live bug crossed. */
function throughJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("live incident regression: prepared-fields wire shape must survive the HTTP boundary intact", () => {
  it("a fresh /prepare response carries a defined `sender` and signPreparedPayment succeeds — no 'Cannot read properties of undefined' crash", async () => {
    signWithKey = owner;
    prepareCashTransferUserOperationMock.mockClear();
    signRawPayloadMock.mockClear();
    const registry = await seedAccount();
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1" }), SECRET);
    const paymentStore = createInMemoryPaymentAttemptStore();

    const prepared = await resolvePreparePayment({
      cookieValue,
      sessionSecret: SECRET,
      registry,
      paymentStore,
      publicClient: buildBalanceCheckClient(BigInt(20_000_000)),
      pimlicoApiKey: "pim_test_key",
      recipientInput: RECIPIENT,
      amountBaseUnitsInput: "10000",
    });

    expect(prepared.outcome).toBe("ready");
    if (prepared.outcome !== "ready") return;

    // Exactly what crosses the wire — never trust the in-process object.
    const wireAttempt = throughJson(prepared.attempt);
    expect(wireAttempt.prepared?.sender).toBeTruthy();
    expect(wireAttempt.prepared?.sender.toLowerCase()).toBe(SAFE_ADDRESS.toLowerCase());

    const signature = await signPreparedPayment({
      fields: wireAttempt.prepared!,
      rpId: "localhost",
      subOrganizationId: prepared.subOrganizationId,
      ownerAddress: owner.address,
      rpcUrl: "http://unused.invalid",
    });
    expect(signature).toMatch(/^0x[0-9a-f]+$/i);
    // The browser signed EXACTLY the server-chosen finite window — never 0 (= never expires).
    expect(wireAttempt.prepared!.validUntil).toBeGreaterThan(0);
    expect(splitSafeOpSignature(signature)).toMatchObject({ validAfter: 0, validUntil: wireAttempt.prepared!.validUntil });
  });

  it("a payment restored through /latest (simulating a reload) also carries a defined `sender` and signs successfully — the exact live-incident path, no auto-submit", async () => {
    signWithKey = owner;
    prepareCashTransferUserOperationMock.mockClear();
    signRawPayloadMock.mockClear();
    const registry = await seedAccount();
    const cookieValue = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1" }), SECRET);
    const paymentStore = createInMemoryPaymentAttemptStore();

    const prepared = await resolvePreparePayment({
      cookieValue,
      sessionSecret: SECRET,
      registry,
      paymentStore,
      publicClient: buildBalanceCheckClient(BigInt(20_000_000)),
      pimlicoApiKey: "pim_test_key",
      recipientInput: RECIPIENT,
      amountBaseUnitsInput: "10000",
    });
    expect(prepared.outcome).toBe("ready");
    if (prepared.outcome !== "ready") return;

    // Simulates a page reload: a brand-new request that only calls
    // /api/real/payments/latest — no prepare, no signing, no submit.
    const latest = await resolveLatestPayment({ cookieValue, sessionSecret: SECRET, registry, paymentStore });
    expect(latest.outcome).toBe("ok");
    if (latest.outcome !== "ok") return;
    expect(latest.attempt.state).toBe("awaiting_authorization");
    expect(latest.subOrganizationId).toBe("sub-org-1");

    const wireAttempt = throughJson(latest.attempt);
    expect(wireAttempt.prepared?.sender).toBeTruthy();

    // The user's "Continue" tap — a real signing attempt, still no /submit call.
    const signature = await signPreparedPayment({
      fields: wireAttempt.prepared!,
      rpId: "localhost",
      subOrganizationId: latest.subOrganizationId!,
      ownerAddress: owner.address,
      rpcUrl: "http://unused.invalid",
    });
    expect(signature).toMatch(/^0x[0-9a-f]+$/i);
  });

  it("reproduces the exact live crash when `sender` is missing from the wire object — proving what the fix closed", async () => {
    // A plain wire-shaped object (all strings, as it would actually arrive
    // over JSON) with `sender` omitted — the exact defect the live incident
    // had: every other field present, sender missing.
    const brokenFields = {
      nonce: "0",
      factory: null,
      factoryData: null,
      callData: "0x1234",
      callGasLimit: "80000",
      verificationGasLimit: "150000",
      preVerificationGas: "60000",
      maxFeePerGas: "2000000",
      maxPriorityFeePerGas: "1000000",
      paymaster: null,
      paymasterData: null,
      paymasterVerificationGasLimit: null,
      paymasterPostOpGasLimit: null,
      validUntil: Math.floor(Date.now() / 1000) + 600,
    };

    await expect(
      signPreparedPayment({
        fields: brokenFields as never,
        rpId: "localhost",
        subOrganizationId: "sub-org-1",
        ownerAddress: owner.address,
        rpcUrl: "http://unused.invalid",
      }),
    ).rejects.toThrow(/reading 'toLowerCase'|Cannot read propert/);
  });

  it("finite expiry: a wire object with no window, or one too close to expiry, is refused BEFORE any passkey ceremony", async () => {
    const base = {
      sender: SAFE_ADDRESS,
      nonce: "0",
      factory: null,
      factoryData: null,
      callData: "0x1234",
      callGasLimit: "80000",
      verificationGasLimit: "150000",
      preVerificationGas: "60000",
      maxFeePerGas: "2000000",
      maxPriorityFeePerGas: "1000000",
      paymaster: null,
      paymasterData: null,
      paymasterVerificationGasLimit: null,
      paymasterPostOpGasLimit: null,
    };
    const sign = (fields: unknown) => signPreparedPayment({ fields: fields as never, rpId: "localhost", subOrganizationId: "sub-org-1", ownerAddress: owner.address, rpcUrl: "http://unused.invalid" });
    signRawPayloadMock.mockClear();

    await expect(sign(base)).rejects.toThrow(PAYMENT_EXPIRED_BEFORE_APPROVAL);
    await expect(sign({ ...base, validUntil: Math.floor(Date.now() / 1000) + 30 })).rejects.toThrow(PAYMENT_EXPIRED_BEFORE_APPROVAL);
    expect(signRawPayloadMock).not.toHaveBeenCalled();
  });
});
