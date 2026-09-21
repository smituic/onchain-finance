import { describe, expect, it, vi } from "vitest";
import { encodePacked, type Address, type Hex } from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { signVerifyAndSubmit } from "@/lib/poc/turnkey/payment";
import { SafeOpPreflightError, SAFE_OP_EIP712_TYPES } from "@/lib/poc/turnkey/safe-op-preflight";
import type { SignTypedDataDiagnostic } from "@/lib/poc/turnkey/signing-diagnostics";

// Same deterministic local test keys used in safe-op-preflight.test.ts — not
// funded, not secret, used only to produce real, verifiable ECDSA signatures
// offline.
const OWNER_KEY: Hex = "0x119bb329df425b685a3f3483fba01deeb1db47d608cfb051da9ad4a12995238a";
const OTHER_KEY: Hex = "0xe3b5b13304d3d1e786145c392ddcb41c2d0c9697079968a5b9ab5b415393642f";
const owner = privateKeyToAccount(OWNER_KEY);
const impostor = privateKeyToAccount(OTHER_KEY);

const CHAIN_ID = 84532;
const SAFE4337_MODULE: Address = "0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226";
const SAFE_ADDRESS: Address = "0xd9a4c22fb34dc74317edc8006140d66c8fa03266";
const VALID_AFTER = 0;
const VALID_UNTIL = 0;

const prepared = {
  sender: SAFE_ADDRESS,
  nonce: BigInt(0),
  callData:
    "0xa9059cbb000000000000000000000000c27d4743bc9839ba15c9982b17143d6039b2d5b00000000000000000000000000000000000000000000000000000000000186a0" as Hex,
  verificationGasLimit: BigInt(150_000),
  callGasLimit: BigInt(80_000),
  preVerificationGas: BigInt(60_000),
  maxPriorityFeePerGas: BigInt(1_000_000),
  maxFeePerGas: BigInt(2_000_000),
  signature: "0x" as Hex, // the local gas-estimation stub — signVerifyAndSubmit never reads this field
};

/** Signs a SafeOp exactly as permissionless's signUserOperation.ts does, then packs it as Safe4337Module expects: validAfter(6B) || validUntil(6B) || ownerSignature. */
async function signSafeOpAs(signer: typeof owner): Promise<Hex> {
  const ownerSignature = await signer.signTypedData({
    domain: { chainId: CHAIN_ID, verifyingContract: SAFE4337_MODULE },
    types: SAFE_OP_EIP712_TYPES,
    primaryType: "SafeOp",
    message: {
      safe: SAFE_ADDRESS,
      nonce: prepared.nonce,
      initCode: "0x" as Hex,
      callData: prepared.callData,
      verificationGasLimit: prepared.verificationGasLimit,
      callGasLimit: prepared.callGasLimit,
      preVerificationGas: prepared.preVerificationGas,
      maxPriorityFeePerGas: prepared.maxPriorityFeePerGas,
      maxFeePerGas: prepared.maxFeePerGas,
      paymasterAndData: "0x" as Hex,
      validAfter: VALID_AFTER,
      validUntil: VALID_UNTIL,
      entryPoint: entryPoint07Address,
    },
  });
  return encodePacked(["uint48", "uint48", "bytes"], [VALID_AFTER, VALID_UNTIL, ownerSignature]);
}

function emptySignDiagnosticRef(): { current: SignTypedDataDiagnostic | null } {
  return { current: null };
}

describe("signVerifyAndSubmit — the gate between signing and eth_sendUserOperation", () => {
  it("never calls smartAccountClient.sendUserOperation when account.signUserOperation throws (the verified signTypedData path rejecting a bad Turnkey signature)", async () => {
    const sendUserOperation = vi.fn();
    const signingError = new Error("Turnkey-signed EIP-712 signature recovered the wrong owner.");
    const account = {
      address: SAFE_ADDRESS,
      signUserOperation: vi.fn().mockRejectedValue(signingError),
    };

    await expect(
      signVerifyAndSubmit({
        account,
        smartAccountClient: { sendUserOperation },
        prepared,
        expectedOwner: owner.address,
        signDiagnosticRef: emptySignDiagnosticRef(),
      }),
    ).rejects.toBe(signingError);

    expect(sendUserOperation).not.toHaveBeenCalled();
  });

  it("never calls smartAccountClient.sendUserOperation when the signed SafeOp does not recover to the expected owner (defense-in-depth preflight, independent of signTypedData's own check)", async () => {
    const sendUserOperation = vi.fn();
    // A real, validly-formed signature — just from the wrong key. Simulates
    // a bug in signVerifyAndSubmit's own preflight reconstruction, or any
    // other way a bad signature could reach this point despite the signer's
    // own internal check.
    const badSignature = await signSafeOpAs(impostor);
    const account = {
      address: SAFE_ADDRESS,
      signUserOperation: vi.fn().mockResolvedValue(badSignature),
    };

    await expect(
      signVerifyAndSubmit({
        account,
        smartAccountClient: { sendUserOperation },
        prepared,
        expectedOwner: owner.address,
        signDiagnosticRef: emptySignDiagnosticRef(),
      }),
    ).rejects.toBeInstanceOf(SafeOpPreflightError);

    expect(sendUserOperation).not.toHaveBeenCalled();
  });

  it("calls smartAccountClient.sendUserOperation exactly once, with the real signature attached, when the signature is valid", async () => {
    const goodSignature = await signSafeOpAs(owner);
    const sendUserOperation = vi.fn().mockResolvedValue("0xuserophash");
    const account = {
      address: SAFE_ADDRESS,
      signUserOperation: vi.fn().mockResolvedValue(goodSignature),
    };

    const result = await signVerifyAndSubmit({
      account,
      smartAccountClient: { sendUserOperation },
      prepared,
      expectedOwner: owner.address,
      signDiagnosticRef: emptySignDiagnosticRef(),
    });

    expect(result.userOperationHash).toBe("0xuserophash");
    expect(result.preflight.ok).toBe(true);
    expect(sendUserOperation).toHaveBeenCalledTimes(1);
    expect(sendUserOperation).toHaveBeenCalledWith({ ...prepared, signature: goodSignature });
  });
});
