import { describe, expect, it } from "vitest";
import { encodePacked, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  SAFE_OP_EIP712_TYPES,
  SafeOpPreflightError,
  assertSafeOpPreflightOrThrow,
  packPaymasterAndData,
  splitSafeOpSignature,
  verifySafeOpSignature,
  type SafeOpOperation,
} from "@/lib/real/payments/safe-op-preflight";

// Deterministic local test private keys (sha256 of a fixed label) — not
// funded, not secret, used only to produce real, verifiable ECDSA
// signatures offline for this test file.
const TEST_PRIVATE_KEY: Hex = "0x119bb329df425b685a3f3483fba01deeb1db47d608cfb051da9ad4a12995238a";
const OTHER_PRIVATE_KEY: Hex = "0xe3b5b13304d3d1e786145c392ddcb41c2d0c9697079968a5b9ab5b415393642f";
const owner = privateKeyToAccount(TEST_PRIVATE_KEY);

const CHAIN_ID = 84532;
const SAFE4337_MODULE: Address = "0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226";
const ENTRY_POINT_07: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

const baseOperation: SafeOpOperation = {
  safe: "0xd9a4c22fb34dc74317edc8006140d66c8fa03266",
  nonce: BigInt(0),
  initCode: "0x",
  callData: "0xa9059cbb000000000000000000000000c27d4743bc9839ba15c9982b17143d6039b2d5b00000000000000000000000000000000000000000000000000000000000186a0",
  verificationGasLimit: BigInt(150_000),
  callGasLimit: BigInt(80_000),
  preVerificationGas: BigInt(60_000),
  maxPriorityFeePerGas: BigInt(1_000_000),
  maxFeePerGas: BigInt(2_000_000),
  paymasterAndData: "0x",
  entryPoint: ENTRY_POINT_07,
};

const VALID_AFTER = 0;
const VALID_UNTIL = 0;

/** Signs a SafeOp exactly as permissionless's signUserOperation.ts does, then packs it as Safe4337Module expects: validAfter(6B) || validUntil(6B) || ownerSignature. */
async function signSafeOp(op: SafeOpOperation, validAfter = VALID_AFTER, validUntil = VALID_UNTIL): Promise<Hex> {
  const ownerSignature = await owner.signTypedData({
    domain: { chainId: CHAIN_ID, verifyingContract: SAFE4337_MODULE },
    types: SAFE_OP_EIP712_TYPES,
    primaryType: "SafeOp",
    message: { ...op, validAfter, validUntil },
  });
  return encodePacked(["uint48", "uint48", "bytes"], [validAfter, validUntil, ownerSignature]);
}

describe("verifySafeOpSignature", () => {
  it("recovers a real, validly-signed SafeOp signature to the expected owner", async () => {
    const safeSignature = await signSafeOp(baseOperation);

    const result = await verifySafeOpSignature({
      chainId: CHAIN_ID,
      safe4337ModuleAddress: SAFE4337_MODULE,
      expectedOwner: owner.address,
      safeSignature,
      operation: baseOperation,
    });

    expect(result.ok).toBe(true);
    expect(result.recoveredAddress?.toLowerCase()).toBe(owner.address.toLowerCase());
    expect(result.signatureByteLength).toBe(65);
    expect([27, 28]).toContain(result.vByte);
    expect(result.reason).toBeNull();
  });

  it("detects a v byte Safe's checkNSignatures would reject (not 27/28)", async () => {
    const validSignature = await signSafeOp(baseOperation);
    const split = splitSafeOpSignature(validSignature)!;
    // Corrupt only the v byte (last byte) to an invalid value — this is the
    // exact "wrong v/format" case: prove it's detected before ever comparing
    // recovered addresses, rather than blindly renormalizing it.
    const corruptedOwnerSig = (split.ownerSignature.slice(0, -2) + "00") as Hex;
    const corruptedSafeSignature = encodePacked(["uint48", "uint48", "bytes"], [VALID_AFTER, VALID_UNTIL, corruptedOwnerSig]);

    const result = await verifySafeOpSignature({
      chainId: CHAIN_ID,
      safe4337ModuleAddress: SAFE4337_MODULE,
      expectedOwner: owner.address,
      safeSignature: corruptedSafeSignature,
      operation: baseOperation,
    });

    expect(result.ok).toBe(false);
    expect(result.vByte).toBe(0);
    expect(result.reason).toContain("v byte");
  });

  it("detects that a changed typed-data field after signing invalidates recovery", async () => {
    // Sign over the original operation, then verify against a mutated one —
    // this is exactly "no field may change after signing": if callData (or
    // any other signed field) differs from what was actually signed, the
    // digest differs and recovery must not match the owner.
    const safeSignature = await signSafeOp(baseOperation);
    const mutatedOperation: SafeOpOperation = { ...baseOperation, callData: `${baseOperation.callData}00` as Hex };

    const result = await verifySafeOpSignature({
      chainId: CHAIN_ID,
      safe4337ModuleAddress: SAFE4337_MODULE,
      expectedOwner: owner.address,
      safeSignature,
      operation: mutatedOperation,
    });

    expect(result.ok).toBe(false);
    expect(result.recoveredAddress?.toLowerCase()).not.toBe(owner.address.toLowerCase());
  });

  it("detects a signature that recovers to the wrong owner", async () => {
    const otherOwner = privateKeyToAccount(OTHER_PRIVATE_KEY);
    const safeSignature = await signSafeOp(baseOperation);

    const result = await verifySafeOpSignature({
      chainId: CHAIN_ID,
      safe4337ModuleAddress: SAFE4337_MODULE,
      expectedOwner: otherOwner.address,
      safeSignature,
      operation: baseOperation,
    });

    expect(result.ok).toBe(false);
    expect(result.recoveredAddress?.toLowerCase()).toBe(owner.address.toLowerCase());
    expect(result.reason).toContain("does not match expected owner");
  });
});

describe("packPaymasterAndData", () => {
  it("packs paymaster + gas limits + data, matching permissionless's getPaymasterAndData layout", () => {
    const packed = packPaymasterAndData({
      paymaster: "0x1111111111111111111111111111111111111111",
      paymasterVerificationGasLimit: BigInt(1000),
      paymasterPostOpGasLimit: BigInt(2000),
      paymasterData: "0xabcd",
    });
    // 0x + 20-byte paymaster + 16-byte limit + 16-byte limit + data
    expect(packed).toBe(
      "0x1111111111111111111111111111111111111111" +
        "000000000000000000000000000003e8" +
        "000000000000000000000000000007d0" +
        "abcd",
    );
  });

  it("returns 0x when there is no paymaster", () => {
    expect(packAndDataWithoutPaymaster()).toBe("0x");
  });
});

function packAndDataWithoutPaymaster() {
  return packPaymasterAndData({});
}

describe("assertSafeOpPreflightOrThrow — the gate before eth_sendUserOperation", () => {
  it("throws SafeOpPreflightError, carrying the diagnostic, when the preflight failed", async () => {
    const safeSignature = await signSafeOp(baseOperation);
    const mutatedOperation: SafeOpOperation = { ...baseOperation, nonce: baseOperation.nonce + BigInt(1) };
    const failed = await verifySafeOpSignature({
      chainId: CHAIN_ID,
      safe4337ModuleAddress: SAFE4337_MODULE,
      expectedOwner: owner.address,
      safeSignature,
      operation: mutatedOperation,
    });

    expect(failed.ok).toBe(false);
    let thrown: unknown;
    try {
      assertSafeOpPreflightOrThrow(failed);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SafeOpPreflightError);
    expect((thrown as InstanceType<typeof SafeOpPreflightError>).preflight.ok).toBe(false);
  });

  it("does not throw when the preflight passed — this is the only path that reaches sendUserOperation in payments/submit.ts", async () => {
    const safeSignature = await signSafeOp(baseOperation);
    const passed = await verifySafeOpSignature({
      chainId: CHAIN_ID,
      safe4337ModuleAddress: SAFE4337_MODULE,
      expectedOwner: owner.address,
      safeSignature,
      operation: baseOperation,
    });
    expect(passed.ok).toBe(true);
    expect(() => assertSafeOpPreflightOrThrow(passed)).not.toThrow();
  });
});
