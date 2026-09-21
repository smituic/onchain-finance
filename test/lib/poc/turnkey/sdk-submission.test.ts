import { describe, expect, it, vi } from "vitest";
import { createSmartAccountClient } from "permissionless";
import { toSafeSmartAccount } from "permissionless/accounts";
import { createPublicClient, custom, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { formatUserOperationRequest } from "viem/account-abstraction";
import { SAFE_POC } from "@/lib/poc/turnkey/constants";
import { signVerifyAndSubmit } from "@/lib/poc/turnkey/payment";
import { instrumentSignTypedData, type SignTypedDataDiagnostic } from "@/lib/poc/turnkey/signing-diagnostics";

// Real SDK signing, packing, preparation, and transport formatting; all I/O
// is an in-process allowlist. No fetch, Turnkey, or live submission.
describe("installed Safe/viem submission boundary", () => {
  it.each([false, true])("preserves every preflighted field (factory present: %s)", async (deploying) => {
    const owner = privateKeyToAccount("0x119bb329df425b685a3f3483fba01deeb1db47d608cfb051da9ad4a12995238a");
    const signDiagnosticRef: { current: SignTypedDataDiagnostic | null } = { current: null };
    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: custom({ request: async ({ method }) => {
        if (method === "eth_getCode") return "0x6080";
        throw new Error(`Unexpected public RPC: ${method}`);
      } }),
    });
    const account = await toSafeSmartAccount({
      client: publicClient,
      address: "0xd9a4c22fb34dc74317edc8006140d66c8fa03266",
      owners: [instrumentSignTypedData(owner, (value) => { signDiagnosticRef.current = value; })],
      version: SAFE_POC.version,
      entryPoint: SAFE_POC.entryPoint,
      safe4337ModuleAddress: SAFE_POC.module.address,
      threshold: BigInt(1),
    });
    const request = vi.fn(async ({ method }: { method: string; params?: unknown }) => {
      if (method === "eth_sendUserOperation") return `0x${"ab".repeat(32)}`;
      throw new Error(`Unexpected bundler RPC: ${method}`);
    });
    const paymaster = { getPaymasterData: vi.fn(), getPaymasterStubData: vi.fn() };
    const smartAccountClient = createSmartAccountClient({
      account, chain: baseSepolia, client: publicClient,
      bundlerTransport: custom({ request }), paymaster,
    });
    const prepared = {
      sender: account.address,
      nonce: BigInt(3), callData: "0x1234" as Hex,
      factory: deploying ? SAFE_POC.proxyFactoryAddress : undefined,
      factoryData: deploying ? "0x5678" as Hex : undefined,
      callGasLimit: BigInt(80000), verificationGasLimit: BigInt(150000),
      preVerificationGas: BigInt(60000), maxFeePerGas: BigInt(2000000), maxPriorityFeePerGas: BigInt(1000000),
      paymaster: "0x1111111111111111111111111111111111111111" as const,
      paymasterData: "0xabcd" as Hex,
      paymasterVerificationGasLimit: BigInt(40000), paymasterPostOpGasLimit: BigInt(30000),
      signature: "0x" as Hex,
    };
    const before = { ...prepared };
    const result = await signVerifyAndSubmit({ account, smartAccountClient, prepared, expectedOwner: owner.address, signDiagnosticRef });
    expect(result.preflight.ok).toBe(true);
    expect(result.digestsMatch).toBe(true);
    expect(prepared).toEqual(before);
    expect(paymaster.getPaymasterData).not.toHaveBeenCalled();
    expect(paymaster.getPaymasterStubData).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    const sent = request.mock.calls[0][0].params as [Record<string, unknown>, string];
    expect(sent[1]).toBe(SAFE_POC.entryPoint.address);
    expect(sent[0]).toEqual(formatUserOperationRequest({ ...before, signature: sent[0].signature as Hex }));
    expect((sent[0].signature as string).length).toBe(2 + 77 * 2);
    expect(sent[0].signature).toBe(`0x${"0".repeat(24)}${result.signDiagnostic!.signature.slice(2)}`);
  });
});
