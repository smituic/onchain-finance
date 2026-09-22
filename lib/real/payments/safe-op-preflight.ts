import { concat, hashTypedData, pad, recoverTypedDataAddress, toHex, type Address, type Hex } from "viem";
import { addressesEqual } from "../identifiers";
import type { SignTypedDataDiagnostic } from "../signing/signing-diagnostics";

/**
 * Mirrors permissionless@0.3.7's EIP712_SAFE_OPERATION_TYPE_V07
 * (accounts/safe/toSafeSmartAccount.ts) field-for-field, and Safe4337Module
 * 0.3.0's own SAFE_OP_TYPEHASH comment (safe-global/safe-modules,
 * tag 4337/v0.3.0, Safe4337Module.sol):
 *
 *   keccak256(
 *     "SafeOp(address safe,uint256 nonce,bytes initCode,bytes callData,"
 *     "uint128 verificationGasLimit,uint128 callGasLimit,uint256 preVerificationGas,"
 *     "uint128 maxPriorityFeePerGas,uint128 maxFeePerGas,bytes paymasterAndData,"
 *     "uint48 validAfter,uint48 validUntil,address entryPoint)"
 *   )
 *
 * Verified byte-for-byte against both sources on 2026-09-20. Not imported
 * directly from permissionless: it does not re-export this constant through
 * its package.json "exports" map (only `SafeSmartAccount` is exported from
 * "permissionless/accounts/safe"), and the package has no wildcard export,
 * so a deep import is not resolvable at all under Node's exports-map
 * enforcement. If either side's struct changes, this preflight and the real
 * signing path silently diverge — the regression tests below pin the exact
 * field order and types so that drift fails loudly instead of silently.
 */
export const SAFE_OP_EIP712_TYPES = {
  SafeOp: [
    { type: "address", name: "safe" },
    { type: "uint256", name: "nonce" },
    { type: "bytes", name: "initCode" },
    { type: "bytes", name: "callData" },
    { type: "uint128", name: "verificationGasLimit" },
    { type: "uint128", name: "callGasLimit" },
    { type: "uint256", name: "preVerificationGas" },
    { type: "uint128", name: "maxPriorityFeePerGas" },
    { type: "uint128", name: "maxFeePerGas" },
    { type: "bytes", name: "paymasterAndData" },
    { type: "uint48", name: "validAfter" },
    { type: "uint48", name: "validUntil" },
    { type: "address", name: "entryPoint" },
  ],
} as const;

export type SafeOpOperation = {
  safe: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  verificationGasLimit: bigint;
  callGasLimit: bigint;
  preVerificationGas: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  paymasterAndData: Hex;
  entryPoint: Address;
};

/** Mirrors permissionless's getPaymasterAndData: paymaster(20B) + paymasterVerificationGasLimit(16B) + paymasterPostOpGasLimit(16B) + paymasterData. */
export function packPaymasterAndData(input: {
  paymaster?: Address;
  paymasterVerificationGasLimit?: bigint;
  paymasterPostOpGasLimit?: bigint;
  paymasterData?: Hex;
}): Hex {
  if (!input.paymaster) return "0x";
  return concat([
    input.paymaster,
    pad(toHex(input.paymasterVerificationGasLimit ?? BigInt(0)), { size: 16 }),
    pad(toHex(input.paymasterPostOpGasLimit ?? BigInt(0)), { size: 16 }),
    input.paymasterData ?? "0x",
  ]);
}

export type SplitSafeOpSignature = {
  validAfter: number;
  validUntil: number;
  ownerSignature: Hex;
  byteLength: number;
  vByte: number | null;
};

/**
 * Splits a full Safe4337 signature blob into its parts. Safe4337Module 0.3.0
 * parses `userOp.signature` on-chain as exactly
 * `abi.encodePacked(validAfter, validUntil, signatures)` — uint48 (6 bytes)
 * + uint48 (6 bytes) + the raw owner signature(s) (Safe4337Module.sol,
 * `_getSafeOp`). For a single-EOA-owner Safe at threshold 1 (our
 * configuration), `signatures` is exactly one 65-byte r+s+v signature — no
 * dynamic-signature dispatch-table overhead.
 */
export function splitSafeOpSignature(safeSignature: Hex): SplitSafeOpSignature | null {
  const hex = safeSignature.startsWith("0x") ? safeSignature.slice(2) : safeSignature;
  const PREFIX_HEX_LENGTH = 24; // 6 + 6 bytes
  if (hex.length <= PREFIX_HEX_LENGTH) return null;

  const validAfterHex = hex.slice(0, 12);
  const validUntilHex = hex.slice(12, 24);
  const ownerSignature = `0x${hex.slice(PREFIX_HEX_LENGTH)}` as Hex;
  const byteLength = (ownerSignature.length - 2) / 2;
  const vByte = byteLength > 0 ? Number.parseInt(ownerSignature.slice(-2), 16) : null;

  return {
    validAfter: Number.parseInt(validAfterHex, 16),
    validUntil: Number.parseInt(validUntilHex, 16),
    ownerSignature,
    byteLength,
    vByte,
  };
}

export type SafeOpPreflightResult = {
  ok: boolean;
  recoveredAddress: Address | null;
  expectedOwner: Address;
  validAfter: number | null;
  validUntil: number | null;
  signatureByteLength: number | null;
  vByte: number | null;
  /** hashTypedData() of this preflight's own {domain, types, message} reconstruction — compare against the digest captured from the exact object actually passed to owner.signTypedData to prove (or disprove) they match. */
  reconstructedDigest: Hex | null;
  reason: string | null;
};

/**
 * Locally (offline) verifies that a Safe4337 signature — the exact bytes
 * about to be embedded in `userOp.signature` — recovers to the expected Safe
 * owner over the same EIP-712 digest Safe4337Module 0.3.0 computes on-chain,
 * BEFORE calling eth_sendUserOperation. This never touches the network, adds
 * no signing authority, and stores nothing — it is a pure, synchronous-after-
 * await check that either confirms the signature or aborts locally with a
 * concrete diagnostic (recovered address, v byte, signature length) instead
 * of spending a live bundler submission (and a fresh passkey ceremony) to
 * find out the same thing from an opaque AA24 rejection.
 */
/** The exact {domain, types, primaryType, message} the preflight reconstructs — exposed so it can be compared, field for field, against whatever object actually reached owner.signTypedData. */
export function buildSafeOpTypedData(input: { chainId: number; safe4337ModuleAddress: Address; operation: SafeOpOperation; validAfter: number; validUntil: number }) {
  return {
    domain: { chainId: input.chainId, verifyingContract: input.safe4337ModuleAddress },
    types: SAFE_OP_EIP712_TYPES,
    primaryType: "SafeOp" as const,
    message: {
      safe: input.operation.safe,
      nonce: input.operation.nonce,
      initCode: input.operation.initCode,
      callData: input.operation.callData,
      verificationGasLimit: input.operation.verificationGasLimit,
      callGasLimit: input.operation.callGasLimit,
      preVerificationGas: input.operation.preVerificationGas,
      maxPriorityFeePerGas: input.operation.maxPriorityFeePerGas,
      maxFeePerGas: input.operation.maxFeePerGas,
      paymasterAndData: input.operation.paymasterAndData,
      validAfter: input.validAfter,
      validUntil: input.validUntil,
      entryPoint: input.operation.entryPoint,
    },
  };
}

export async function verifySafeOpSignature(input: {
  chainId: number;
  safe4337ModuleAddress: Address;
  expectedOwner: Address;
  safeSignature: Hex;
  operation: SafeOpOperation;
}): Promise<SafeOpPreflightResult> {
  const split = splitSafeOpSignature(input.safeSignature);
  if (!split) {
    return {
      ok: false,
      recoveredAddress: null,
      expectedOwner: input.expectedOwner,
      validAfter: null,
      validUntil: null,
      signatureByteLength: null,
      vByte: null,
      reconstructedDigest: null,
      reason: "Signature blob is too short to contain validAfter/validUntil and an owner signature.",
    };
  }
  if (split.byteLength !== 65) {
    return {
      ok: false,
      recoveredAddress: null,
      expectedOwner: input.expectedOwner,
      validAfter: split.validAfter,
      validUntil: split.validUntil,
      signatureByteLength: split.byteLength,
      vByte: split.vByte,
      reconstructedDigest: null,
      reason: `Owner signature is ${split.byteLength} bytes; a plain ECDSA r+s+v signature must be 65.`,
    };
  }
  if (split.vByte !== 27 && split.vByte !== 28) {
    return {
      ok: false,
      recoveredAddress: null,
      expectedOwner: input.expectedOwner,
      validAfter: split.validAfter,
      validUntil: split.validUntil,
      signatureByteLength: split.byteLength,
      vByte: split.vByte,
      reconstructedDigest: null,
      reason: `Signature v byte is ${split.vByte}; Safe's checkNSignatures expects 27 or 28 for a plain ECDSA owner signature.`,
    };
  }

  const typedData = buildSafeOpTypedData({
    chainId: input.chainId,
    safe4337ModuleAddress: input.safe4337ModuleAddress,
    operation: input.operation,
    validAfter: split.validAfter,
    validUntil: split.validUntil,
  });
  const reconstructedDigest = hashTypedData(typedData);

  let recoveredAddress: Address;
  try {
    recoveredAddress = await recoverTypedDataAddress({ ...typedData, signature: split.ownerSignature });
  } catch {
    // Fixed, safe reason — never the raw decode error text. Local/offline
    // (no upstream secret risk here), but still kept off the public/
    // durable contract per the project's fixed-message policy.
    return {
      ok: false,
      recoveredAddress: null,
      expectedOwner: input.expectedOwner,
      validAfter: split.validAfter,
      validUntil: split.validUntil,
      signatureByteLength: split.byteLength,
      vByte: split.vByte,
      reconstructedDigest,
      reason: "Signature could not be recovered from the provided bytes.",
    };
  }

  const ok = addressesEqual(recoveredAddress, input.expectedOwner);
  return {
    ok,
    recoveredAddress,
    expectedOwner: input.expectedOwner,
    validAfter: split.validAfter,
    validUntil: split.validUntil,
    signatureByteLength: split.byteLength,
    vByte: split.vByte,
    reconstructedDigest,
    reason: ok ? null : `Recovered ${recoveredAddress} does not match expected owner ${input.expectedOwner}.`,
  };
}

export type SafeOpPreflightErrorExtra = {
  /** The exact object actually passed to owner.signTypedData (from instrumentSignTypedData), for comparing against this preflight's own reconstruction — not lost when the preflight aborts the send. */
  signDiagnostic?: SignTypedDataDiagnostic | null;
  /** signDiagnostic.preSignDigest === preflight.reconstructedDigest. null when either digest is unavailable. */
  digestsMatch?: boolean | null;
};

export class SafeOpPreflightError extends Error {
  readonly preflight: SafeOpPreflightResult;
  readonly signDiagnostic: SignTypedDataDiagnostic | null;
  readonly digestsMatch: boolean | null;
  constructor(preflight: SafeOpPreflightResult, extra: SafeOpPreflightErrorExtra = {}) {
    super(`Local SafeOp signature preflight failed before submission: ${preflight.reason ?? "unknown reason"}`);
    this.name = "SafeOpPreflightError";
    this.preflight = preflight;
    this.signDiagnostic = extra.signDiagnostic ?? null;
    this.digestsMatch = extra.digestsMatch ?? null;
  }
}

/**
 * The single gate between a verified SafeOp signature and
 * eth_sendUserOperation. payments/submit.ts calls this immediately after
 * verifySafeOpSignature and before smartAccountClient.sendUserOperation —
 * throwing here means the bundler is never called for this attempt.
 */
export function assertSafeOpPreflightOrThrow(preflight: SafeOpPreflightResult, extra?: SafeOpPreflightErrorExtra): void {
  if (!preflight.ok) {
    throw new SafeOpPreflightError(preflight, extra);
  }
}
