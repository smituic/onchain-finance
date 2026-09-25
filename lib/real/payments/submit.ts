import type { Address, Hash, Hex } from "viem";
import { BASE_SEPOLIA_CHAIN_ID, REAL_SAFE } from "../constants";
import { assertSafeOpPreflightOrThrow, verifySafeOpSignature, SafeOpPreflightError } from "./safe-op-preflight";
import { computeExpectedUserOperationHash } from "./hash";
import { toSafeOpOperation, type PreparedUserOperationFields } from "./prepared-operation";
import { classifySendError } from "./classify-send-error";
import { SAFE_OP_VALID_AFTER } from "./validity";

export type SignatureVerificationOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Independently verifies a SafeOp signature offline (the same "single gate
 * before eth_sendUserOperation" safe-op-preflight.ts documents) and
 * recomputes the expected UserOperation hash as a consistency check against
 * the stored value — both pure, no external I/O, no dispatch.
 *
 * Deliberately split from dispatchPreparedPayment below: the server
 * orchestration layer (server/payments.ts's resolveSubmitPayment) MUST
 * durably CAS-transition the attempt to "submitting" between this
 * succeeding and dispatchPreparedPayment ever being called — that
 * transition is what makes a crash between "signature verified" and
 * "eth_sendUserOperation dispatched" (or between dispatch and recording its
 * result) leave a durable, reconcile-only "submitting" row instead of an
 * ambiguous "signed" row a naive retry might treat as still-resendable.
 */
export async function verifyPreparedPaymentSignature(input: {
  fields: PreparedUserOperationFields;
  expectedOwner: Address;
  expectedUserOperationHash: Hash;
  /** The durable, server-chosen SafeOp validUntil. The signature must carry exactly this (and validAfter = SAFE_OP_VALID_AFTER) — never "whatever the client signed", which could be 0 = never expires. */
  expectedValidUntil: number;
  signature: Hex;
}): Promise<SignatureVerificationOutcome> {
  const operation = toSafeOpOperation(input.fields, { safe: input.fields.sender, entryPoint: REAL_SAFE.entryPoint.address });

  const preflight = await verifySafeOpSignature({
    chainId: BASE_SEPOLIA_CHAIN_ID,
    safe4337ModuleAddress: REAL_SAFE.module.address,
    expectedOwner: input.expectedOwner,
    safeSignature: input.signature,
    operation,
  });

  try {
    assertSafeOpPreflightOrThrow(preflight);
  } catch (error) {
    if (error instanceof SafeOpPreflightError) {
      return { ok: false, reason: `Local SafeOp signature preflight failed before submission: ${preflight.reason ?? "unknown reason"}` };
    }
    throw error;
  }

  // The recovered owner signed over the validity embedded in the signature
  // itself, so the preflight passing proves nothing about WHICH window was
  // signed — that must be pinned separately to the server's own value.
  if (preflight.validAfter !== SAFE_OP_VALID_AFTER || preflight.validUntil !== input.expectedValidUntil) {
    return { ok: false, reason: "The signed validity window does not match the prepared payment's — refusing to submit." };
  }

  const recomputedHash = computeExpectedUserOperationHash(input.fields);
  if (recomputedHash.toLowerCase() !== input.expectedUserOperationHash.toLowerCase()) {
    // Purely a local consistency check, before any external call — safe to
    // classify as a definitive, retryable failure rather than "unknown".
    return {
      ok: false,
      reason: "The recomputed UserOperation hash does not match the persisted expected hash — refusing to submit an operation that no longer matches what was prepared.",
    };
  }

  return { ok: true };
}

export type SubmitPreparedPaymentOutcome =
  | { status: "submitted"; userOperationHash: Hash }
  | { status: "failed"; reason: string }
  | { status: "unknown"; reason: string };

export type SendUserOperationFn = (input: PreparedUserOperationFields & { signature: Hex; entryPointAddress: Address }) => Promise<Hash>;

/**
 * The actual dispatch — called ONLY after the caller has durably
 * CAS-transitioned the attempt to "submitting" (see the doc comment above).
 * Once this function is called, the operation may reach the chain even if
 * the process dies before this function returns or before its result is
 * recorded — which is exactly why the durable "submitting" write must
 * happen first: a row stuck at "submitting" is reconciled via its
 * precomputed expected_user_operation_hash, never resent.
 *
 * Never trusts the bundler's acknowledgement at face value: a returned
 * userOperationHash that doesn't match the durable, precomputed expected
 * hash is treated as "unknown", not "submitted".
 */
export async function dispatchPreparedPayment(input: {
  fields: PreparedUserOperationFields;
  signature: Hex;
  expectedUserOperationHash: Hash;
  sendUserOperation: SendUserOperationFn;
}): Promise<SubmitPreparedPaymentOutcome> {
  let returnedHash: Hash;
  try {
    returnedHash = await input.sendUserOperation({
      ...input.fields,
      signature: input.signature,
      entryPointAddress: REAL_SAFE.entryPoint.address,
    });
  } catch (error) {
    const classification = classifySendError(error);
    return { status: classification.stage, reason: classification.detail };
  }

  if (returnedHash.toLowerCase() !== input.expectedUserOperationHash.toLowerCase()) {
    // The bundler DID respond, but not with the hash we expect — this is
    // exactly the kind of ambiguous post-dispatch signal the durable
    // expected_user_operation_hash exists to protect against: never trusted
    // at face value, always treated as unresolved rather than confirmed.
    return {
      status: "unknown",
      reason: "The bundler returned a UserOperation hash that did not match the expected hash — treating the outcome as unresolved rather than trusting it.",
    };
  }

  return { status: "submitted", userOperationHash: returnedHash };
}
