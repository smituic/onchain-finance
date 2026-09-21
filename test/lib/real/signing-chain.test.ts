import { afterEach, describe, expect, it, vi } from "vitest";
import { concatHex, createPublicClient, custom, encodeAbiParameters, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { entryPoint07Address } from "viem/account-abstraction";
import { REAL_SAFE } from "@/lib/real/constants";
import { createRealSafeAccount } from "@/lib/real/account/safe";
import { createVerifiedTurnkeyOwnerAccount } from "@/lib/real/signing/verified-account";
import { assertSafeOpPreflightOrThrow, packPaymasterAndData, verifySafeOpSignature } from "@/lib/real/payments/safe-op-preflight";

// End-to-end proof of the real proven chain: a real permissionless
// SafeSmartAccount, backed by createVerifiedTurnkeyOwnerAccount, signs a
// real SafeOp via the SAME code path production payment submission will use
// (account.signUserOperation), and the independent preflight verifies the
// result — all against an in-process transport. No fetch, no live Turnkey,
// no live chain, no live bundler. Mirrors poc/turnkey-real-account's
// sdk-submission.test.ts technique.

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

// A well-formed but otherwise arbitrary "bytes" ABI return value — enough
// for toSafeSmartAccount's proxyCreationCode() read to decode successfully
// and derive SOME deterministic Safe address. This test doesn't need that
// address to match a real on-chain deployment (verifySafeOpSignature only
// cares that the same operation.safe value is used consistently on both
// sides), only that construction succeeds fully offline.
const DUMMY_BYTES_RETURN = encodeAbiParameters([{ type: "bytes" }], ["0x600a600c600039600a6000f3" as Hex]);

function buildPublicClient() {
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

const preparedOperation = {
  nonce: BigInt(0),
  callData: "0x1234" as Hex,
  callGasLimit: BigInt(80_000),
  verificationGasLimit: BigInt(150_000),
  preVerificationGas: BigInt(60_000),
  maxFeePerGas: BigInt(2_000_000),
  maxPriorityFeePerGas: BigInt(1_000_000),
  // The local gas-estimation stub signUserOperation itself never reads —
  // required by its param type, unused by its logic (same as payment.ts's
  // prepared.signature on the PoC branch).
  signature: "0x" as Hex,
};

describe("signing chain: verified Turnkey owner -> real Safe smart account -> independent preflight", () => {
  afterEach(() => {
    signRawPayloadMock.mockClear();
    signWithKey = owner;
  });

  it("signs a real SafeOp end to end and the independent preflight recovers the same owner", async () => {
    const verifiedOwner = createVerifiedTurnkeyOwnerAccount({
      rpId: "example.com",
      subOrganizationId: "sub-org-1",
      ownerAddress: owner.address,
    });
    const account = await createRealSafeAccount({ owner: verifiedOwner, publicClient: buildPublicClient() });

    const signature = await account.signUserOperation({ ...preparedOperation, sender: account.address });

    const preflight = await verifySafeOpSignature({
      chainId: baseSepolia.id,
      safe4337ModuleAddress: REAL_SAFE.module.address,
      expectedOwner: owner.address,
      safeSignature: signature,
      operation: {
        safe: account.address,
        nonce: preparedOperation.nonce,
        initCode: "0x",
        callData: preparedOperation.callData,
        verificationGasLimit: preparedOperation.verificationGasLimit,
        callGasLimit: preparedOperation.callGasLimit,
        preVerificationGas: preparedOperation.preVerificationGas,
        maxPriorityFeePerGas: preparedOperation.maxPriorityFeePerGas,
        maxFeePerGas: preparedOperation.maxFeePerGas,
        paymasterAndData: packPaymasterAndData({}),
        entryPoint: entryPoint07Address,
      },
    });

    expect(preflight.ok).toBe(true);
    expect(preflight.recoveredAddress?.toLowerCase()).toBe(owner.address.toLowerCase());
    expect(() => assertSafeOpPreflightOrThrow(preflight)).not.toThrow();
  });

  it("also verifies correctly when the operation deploys the Safe (factory/factoryData present)", async () => {
    const verifiedOwner = createVerifiedTurnkeyOwnerAccount({
      rpId: "example.com",
      subOrganizationId: "sub-org-1",
      ownerAddress: owner.address,
    });
    const account = await createRealSafeAccount({ owner: verifiedOwner, publicClient: buildPublicClient() });

    const factory = REAL_SAFE.proxyFactoryAddress;
    const factoryData = "0xabcdef" as Hex;
    const signature = await account.signUserOperation({
      ...preparedOperation,
      sender: account.address,
      factory,
      factoryData,
    });

    const preflight = await verifySafeOpSignature({
      chainId: baseSepolia.id,
      safe4337ModuleAddress: REAL_SAFE.module.address,
      expectedOwner: owner.address,
      safeSignature: signature,
      operation: {
        safe: account.address,
        nonce: preparedOperation.nonce,
        initCode: concatHex([factory, factoryData]),
        callData: preparedOperation.callData,
        verificationGasLimit: preparedOperation.verificationGasLimit,
        callGasLimit: preparedOperation.callGasLimit,
        preVerificationGas: preparedOperation.preVerificationGas,
        maxPriorityFeePerGas: preparedOperation.maxPriorityFeePerGas,
        maxFeePerGas: preparedOperation.maxFeePerGas,
        paymasterAndData: packPaymasterAndData({}),
        entryPoint: entryPoint07Address,
      },
    });

    expect(preflight.ok).toBe(true);
  });

  it("a wrong-signer Turnkey response never reaches the preflight — createVerifiedTurnkeyOwnerAccount rejects it first (check A)", async () => {
    signWithKey = impostor;
    const verifiedOwner = createVerifiedTurnkeyOwnerAccount({
      rpId: "example.com",
      subOrganizationId: "sub-org-1",
      ownerAddress: owner.address,
    });
    const account = await createRealSafeAccount({ owner: verifiedOwner, publicClient: buildPublicClient() });

    await expect(account.signUserOperation({ ...preparedOperation, sender: account.address })).rejects.toThrow(
      /recovered/,
    );
  });
});
