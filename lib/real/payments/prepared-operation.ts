import { concatHex, type Address, type Hex } from "viem";
import { packPaymasterAndData, type SafeOpOperation } from "./safe-op-preflight";

/**
 * The exact EntryPoint-0.7 unpacked UserOperation fields a Cash payment
 * needs, shared by hash.ts (computing the deterministic UserOperation hash)
 * and submit.ts (reconstructing the SafeOp typed-data operation for the
 * independent preflight) — one shape, two pure derivations, so they can
 * never structurally diverge. `sender` is deliberately required here (never
 * optional) — every caller of this type already knows which Safe it's
 * operating on; there is no code path that should compute a hash or a
 * preflight operation without pinning it down first.
 */
export type PreparedUserOperationFields = {
  sender: Address;
  nonce: bigint;
  factory?: Address;
  factoryData?: Hex;
  callData: Hex;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymaster?: Address;
  paymasterData?: Hex;
  paymasterVerificationGasLimit?: bigint;
  paymasterPostOpGasLimit?: bigint;
};

/**
 * The wire shape of PreparedUserOperationFields — every bigint as a decimal
 * string, every Hex/Address as a string, `null` instead of `undefined` for
 * absent optional fields (JSON has no `undefined`). This is exactly what's
 * persisted in Neon (payment-attempts.ts) and exactly what crosses the
 * server<->browser boundary — server/payments.ts's PublicPaymentAttempt
 * imports THIS type directly for its `prepared` field rather than
 * re-declaring an equivalent shape, specifically so the two sides of that
 * boundary cannot structurally diverge again (see that file's doc comment
 * for the live incident this fixed: a separately-declared server-side type
 * once omitted `sender`, which TypeScript could not catch across the
 * response.json() cast). Parsed back into PreparedUserOperationFields by
 * parsePreparedFieldsFromWire below, used by both the server (submit.ts,
 * from its own durable storage) and the browser (client-sign.ts, from the
 * prepare response) so neither re-derives this conversion independently.
 */
export type WirePreparedFields = {
  sender: string;
  nonce: string;
  factory: string | null;
  factoryData: string | null;
  callData: string;
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  paymaster: string | null;
  paymasterData: string | null;
  paymasterVerificationGasLimit: string | null;
  paymasterPostOpGasLimit: string | null;
  /**
   * Unix seconds — the SafeOp validUntil the owner signs (validAfter is the
   * constant SAFE_OP_VALID_AFTER). Not a UserOperation field, so
   * parsePreparedFieldsFromWire deliberately ignores it and it never
   * affects the userOpHash; it IS part of the SafeOp EIP-712 message, and
   * the server rejects any signature that doesn't carry exactly this value.
   */
  validUntil: number;
};

export function parsePreparedFieldsFromWire(wire: WirePreparedFields): PreparedUserOperationFields {
  return {
    sender: wire.sender as Address,
    nonce: BigInt(wire.nonce),
    factory: wire.factory ? (wire.factory as Address) : undefined,
    factoryData: wire.factoryData ? (wire.factoryData as Hex) : undefined,
    callData: wire.callData as Hex,
    callGasLimit: BigInt(wire.callGasLimit),
    verificationGasLimit: BigInt(wire.verificationGasLimit),
    preVerificationGas: BigInt(wire.preVerificationGas),
    maxFeePerGas: BigInt(wire.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(wire.maxPriorityFeePerGas),
    paymaster: wire.paymaster ? (wire.paymaster as Address) : undefined,
    paymasterData: wire.paymasterData ? (wire.paymasterData as Hex) : undefined,
    paymasterVerificationGasLimit: wire.paymasterVerificationGasLimit ? BigInt(wire.paymasterVerificationGasLimit) : undefined,
    paymasterPostOpGasLimit: wire.paymasterPostOpGasLimit ? BigInt(wire.paymasterPostOpGasLimit) : undefined,
  };
}

/**
 * Derives the SafeOp EIP-712 "operation" struct (safe-op-preflight.ts's
 * SafeOpOperation) from the prepared UserOperation fields — the same
 * initCode-concatenation and paymasterAndData-packing permissionless's
 * signUserOperation performs internally, done here explicitly so the
 * independent preflight (which never calls permissionless) can reconstruct
 * an identical struct from durable, server-persisted fields alone.
 */
export function toSafeOpOperation(fields: PreparedUserOperationFields, input: { safe: Address; entryPoint: Address }): SafeOpOperation {
  return {
    safe: input.safe,
    nonce: fields.nonce,
    initCode: fields.factory && fields.factoryData ? concatHex([fields.factory, fields.factoryData]) : "0x",
    callData: fields.callData,
    verificationGasLimit: fields.verificationGasLimit,
    callGasLimit: fields.callGasLimit,
    preVerificationGas: fields.preVerificationGas,
    maxPriorityFeePerGas: fields.maxPriorityFeePerGas,
    maxFeePerGas: fields.maxFeePerGas,
    paymasterAndData: packPaymasterAndData({
      paymaster: fields.paymaster,
      paymasterVerificationGasLimit: fields.paymasterVerificationGasLimit,
      paymasterPostOpGasLimit: fields.paymasterPostOpGasLimit,
      paymasterData: fields.paymasterData,
    }),
    entryPoint: input.entryPoint,
  };
}
