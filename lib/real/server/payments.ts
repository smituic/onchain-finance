import type { Address, Hash, Hex } from "viem";
import { normalizeAddress, validateAddressCasePreserving } from "../identifiers";
import { readCashBalance } from "../chain/balance";
import type { RealPublicClient } from "../chain/client";
import { readAuthenticatedRealAccount } from "./auth";
import type { RealAccountRegistry } from "./registry";
import { exceedsAvailableBalance, exceedsPaymentCeiling, isCanonicalBaseUnitsString, isZeroBaseUnits } from "../payments/amount";
import { computeExpectedUserOperationHash } from "../payments/hash";
import { parsePreparedFieldsFromWire, type PreparedUserOperationFields, type WirePreparedFields } from "../payments/prepared-operation";
import { dispatchPreparedPayment, verifyPreparedPaymentSignature } from "../payments/submit";
import { classifyReceipt } from "../payments/reconcile";
import { fetchUserOperationReceipt, prepareCashTransferUserOperation, sendPreparedUserOperation } from "./pimlico";
import { BASE_SEPOLIA_CHAIN_ID, REAL_CASH_TOKEN } from "../constants";
import type { PaymentAttempt, PaymentAttemptPatch, PaymentAttemptState, PaymentAttemptStore } from "./payment-attempts";

/**
 * The wire/public shape of a prepared UserOperation's fields — everything a
 * browser needs to reconstruct the SafeOp typed data and sign it (see
 * lib/real/payments/client-sign.ts), and nothing else. bigint fields are
 * decimal strings, hex fields are hex strings — the same representation
 * already used in Neon (see payment-attempts.ts), so no reshaping happens
 * between storage and the wire.
 *
 * This is (not just "matches") lib/real/payments/prepared-operation.ts's
 * WirePreparedFields — the exact same type the client parses the response
 * into (lib/stores/real-payment-store.ts, lib/real/payments/client-sign.ts)
 * — imported here rather than re-declared. A live incident (2026) showed
 * why re-declaring "the same shape" twice is unsafe across an HTTP
 * boundary: a previous, independently-declared PublicPreparedFields here
 * omitted `sender` while WirePreparedFields required it, so the server sent
 * a `prepared` object short one field, `attempt.prepared.sender` was
 * `undefined` in the browser (TypeScript's `as` cast on `response.json()`
 * can't catch a runtime shape mismatch), and client-sign.ts's
 * `fields.sender.toLowerCase()` threw before ever reaching the passkey
 * ceremony. Importing the one shared type instead of a look-alike makes
 * that specific class of bug impossible to reintroduce — a missing field
 * becomes a compile error in toPublicAttempt below, not a runtime crash in
 * the browser.
 */
export type PublicPaymentAttempt = {
  id: string;
  state: PaymentAttemptState;
  recipient: string;
  amountBaseUnits: string;
  transactionHash: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
  prepared: WirePreparedFields | null;
};

function toPublicAttempt(attempt: PaymentAttempt): PublicPaymentAttempt {
  const hasPreparedFields =
    attempt.nonce !== null &&
    attempt.callData !== null &&
    attempt.callGasLimit !== null &&
    attempt.verificationGasLimit !== null &&
    attempt.preVerificationGas !== null &&
    attempt.maxFeePerGas !== null &&
    attempt.maxPriorityFeePerGas !== null;

  return {
    id: attempt.id,
    state: attempt.state,
    recipient: attempt.recipient,
    amountBaseUnits: attempt.amountBaseUnits,
    transactionHash: attempt.transactionHash,
    failureReason: attempt.failureReason,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
    prepared: hasPreparedFields
      ? {
          sender: attempt.safeAddress,
          nonce: attempt.nonce!,
          factory: attempt.factory,
          factoryData: attempt.factoryData,
          callData: attempt.callData!,
          callGasLimit: attempt.callGasLimit!,
          verificationGasLimit: attempt.verificationGasLimit!,
          preVerificationGas: attempt.preVerificationGas!,
          maxFeePerGas: attempt.maxFeePerGas!,
          maxPriorityFeePerGas: attempt.maxPriorityFeePerGas!,
          paymaster: attempt.paymaster,
          paymasterData: attempt.paymasterData,
          paymasterVerificationGasLimit: attempt.paymasterVerificationGasLimit,
          paymasterPostOpGasLimit: attempt.paymasterPostOpGasLimit,
        }
      : null,
  };
}

/** Converts a durable, string-shaped attempt row back into the bigint/hex fields submit.ts and hash.ts operate on. Throws if called before prepare has populated these — a programming error, not a user-facing outcome. */
function toPreparedFields(attempt: PaymentAttempt): PreparedUserOperationFields {
  if (
    attempt.nonce === null ||
    attempt.callData === null ||
    attempt.callGasLimit === null ||
    attempt.verificationGasLimit === null ||
    attempt.preVerificationGas === null ||
    attempt.maxFeePerGas === null ||
    attempt.maxPriorityFeePerGas === null
  ) {
    throw new Error(`Payment attempt ${attempt.id} is missing required prepared fields.`);
  }
  const sender = validateAddressCasePreserving(attempt.safeAddress);
  if (!sender) throw new Error(`Payment attempt ${attempt.id} has an invalid safeAddress.`);

  return parsePreparedFieldsFromWire({
    sender,
    nonce: attempt.nonce,
    factory: attempt.factory,
    factoryData: attempt.factoryData,
    callData: attempt.callData,
    callGasLimit: attempt.callGasLimit,
    verificationGasLimit: attempt.verificationGasLimit,
    preVerificationGas: attempt.preVerificationGas,
    maxFeePerGas: attempt.maxFeePerGas,
    maxPriorityFeePerGas: attempt.maxPriorityFeePerGas,
    paymaster: attempt.paymaster,
    paymasterData: attempt.paymasterData,
    paymasterVerificationGasLimit: attempt.paymasterVerificationGasLimit,
    paymasterPostOpGasLimit: attempt.paymasterPostOpGasLimit,
  });
}

export type PreparePaymentOutcome =
  | { outcome: "unauthenticated" }
  | { outcome: "account_not_ready" }
  | { outcome: "invalid_recipient" }
  | { outcome: "invalid_amount" }
  | { outcome: "balance_check_failed"; reason: string }
  | { outcome: "insufficient_balance" }
  | { outcome: "quota_exceeded" }
  | { outcome: "payment_in_progress" }
  | { outcome: "prepare_failed"; reason: string }
  | { outcome: "ready"; attempt: PublicPaymentAttempt; subOrganizationId: string };

/**
 * The one place a payment intent is validated and turned into a sponsored,
 * durable UserOperation. Every authority-sensitive value is server-derived,
 * never client-supplied: the Safe sender comes from the authenticated
 * session (never a request field), the token/chain are the hardcoded
 * REAL_CASH_TOKEN/BASE_SEPOLIA_CHAIN_ID, and the calldata is built inside
 * prepareCashTransferUserOperation itself, never accepted pre-built.
 *
 * Ordering matters: cheap, no-DB-write validation (session, recipient/amount
 * shape, live balance) happens BEFORE the atomic reserve() call, so
 * malformed or unauthenticated traffic never creates a row; the (expensive,
 * external) Pimlico prepareUserOperation call happens AFTER a successful
 * reserve(), so a failed external prepare still consumes the intended
 * attempt (and its quota slot) rather than leaving no trace.
 */
export async function resolvePreparePayment(input: {
  cookieValue: string | undefined | null;
  sessionSecret: string;
  registry: RealAccountRegistry;
  paymentStore: PaymentAttemptStore;
  publicClient: RealPublicClient;
  pimlicoApiKey: string;
  recipientInput: unknown;
  amountBaseUnitsInput: unknown;
}): Promise<PreparePaymentOutcome> {
  const authenticated = await readAuthenticatedRealAccount({
    cookieValue: input.cookieValue,
    sessionSecret: input.sessionSecret,
    registry: input.registry,
  });
  if (!authenticated) return { outcome: "unauthenticated" };

  const safeAddress = validateAddressCasePreserving(authenticated.account.safeAddress);
  const ownerAddress = validateAddressCasePreserving(authenticated.account.ownerAddress);
  if (!safeAddress || !ownerAddress) return { outcome: "account_not_ready" };

  if (typeof input.recipientInput !== "string") return { outcome: "invalid_recipient" };
  const recipient = normalizeAddress(input.recipientInput);
  if (!recipient) return { outcome: "invalid_recipient" };

  if (typeof input.amountBaseUnitsInput !== "string") return { outcome: "invalid_amount" };
  const amountBaseUnits = input.amountBaseUnitsInput;
  if (!isCanonicalBaseUnitsString(amountBaseUnits) || isZeroBaseUnits(amountBaseUnits) || exceedsPaymentCeiling(amountBaseUnits)) {
    return { outcome: "invalid_amount" };
  }

  let balanceBaseUnits: string;
  try {
    const balance = await readCashBalance({ publicClient: input.publicClient, safeAddress: safeAddress as Address });
    balanceBaseUnits = balance.balanceBaseUnits;
  } catch (error) {
    return { outcome: "balance_check_failed", reason: error instanceof Error ? error.message : "Could not read your balance." };
  }
  if (exceedsAvailableBalance(amountBaseUnits, balanceBaseUnits)) {
    return { outcome: "insufficient_balance" };
  }

  const reserved = await input.paymentStore.reserve({
    appUserId: authenticated.account.appUserId,
    safeAddress,
    recipient,
    amountBaseUnits,
    chainId: BASE_SEPOLIA_CHAIN_ID,
    tokenAddress: REAL_CASH_TOKEN.address,
  });
  if (!reserved.ok) return { outcome: reserved.reason };

  let prepared: PreparedUserOperationFields;
  try {
    prepared = await prepareCashTransferUserOperation({
      publicClient: input.publicClient,
      pimlicoApiKey: input.pimlicoApiKey,
      ownerAddress: ownerAddress as Address,
      recipient: recipient as Address,
      amountBaseUnits,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Could not prepare the payment.";
    await input.paymentStore.transition({ id: reserved.attempt.id, from: "prepared", to: "failed", patch: { failureReason: reason } });
    return { outcome: "prepare_failed", reason };
  }

  const expectedUserOperationHash = computeExpectedUserOperationHash(prepared);
  const patch: PaymentAttemptPatch = {
    nonce: prepared.nonce.toString(),
    callData: prepared.callData,
    factory: prepared.factory ?? null,
    factoryData: prepared.factoryData ?? null,
    callGasLimit: prepared.callGasLimit.toString(),
    verificationGasLimit: prepared.verificationGasLimit.toString(),
    preVerificationGas: prepared.preVerificationGas.toString(),
    maxFeePerGas: prepared.maxFeePerGas.toString(),
    maxPriorityFeePerGas: prepared.maxPriorityFeePerGas.toString(),
    paymaster: prepared.paymaster ?? null,
    paymasterData: prepared.paymasterData ?? null,
    paymasterVerificationGasLimit: prepared.paymasterVerificationGasLimit?.toString() ?? null,
    paymasterPostOpGasLimit: prepared.paymasterPostOpGasLimit?.toString() ?? null,
    expectedUserOperationHash,
  };

  const updated = await input.paymentStore.transition({ id: reserved.attempt.id, from: "prepared", to: "awaiting_authorization", patch });
  if (!updated) {
    return { outcome: "prepare_failed", reason: "Could not persist the prepared payment." };
  }

  return { outcome: "ready", attempt: toPublicAttempt(updated), subOrganizationId: authenticated.account.subOrganizationId };
}

export type SubmitPaymentOutcome =
  | { outcome: "unauthenticated" }
  | { outcome: "not_found" }
  | { outcome: "wrong_state"; state: PaymentAttemptState }
  | { outcome: "submitted"; attempt: PublicPaymentAttempt }
  | { outcome: "failed"; attempt: PublicPaymentAttempt }
  | { outcome: "unknown"; attempt: PublicPaymentAttempt };

/**
 * A valid app session alone is never enough to reach here successfully: the
 * caller must also supply a signature that independently verifies (via
 * verifyPreparedPaymentSignature's SafeOp preflight) against the canonical
 * owner — nothing about the HttpOnly cookie itself produces or approves a
 * signature.
 *
 * Two separate CAS transitions guard this function, not one:
 *
 *  1. awaiting_authorization -> signed, before the signature is even
 *     inspected — the first duplicate-submit guard: a second concurrent
 *     call for the same attempt id finds it no longer
 *     "awaiting_authorization" and backs off immediately.
 *  2. signed -> submitting, AFTER the signature has independently verified
 *     (preflight + recomputed-hash check) but BEFORE
 *     dispatchPreparedPayment is ever called. This is what closes the
 *     crash window between "we're about to call eth_sendUserOperation" and
 *     "we know what happened": if the process dies anywhere from here
 *     through recording the dispatch result, the durable row is left at
 *     "submitting" — reconciled later via its precomputed
 *     expected_user_operation_hash (resolvePaymentStatus treats
 *     "submitting" exactly like "unknown": never resent, only reconciled)
 *     — never re-read as a resendable "signed" row.
 *
 * Only the caller that wins transition 2 may ever call
 * dispatchPreparedPayment for this attempt.
 */
export async function resolveSubmitPayment(input: {
  cookieValue: string | undefined | null;
  sessionSecret: string;
  registry: RealAccountRegistry;
  paymentStore: PaymentAttemptStore;
  pimlicoApiKey: string;
  attemptId: unknown;
  signature: unknown;
}): Promise<SubmitPaymentOutcome> {
  const authenticated = await readAuthenticatedRealAccount({
    cookieValue: input.cookieValue,
    sessionSecret: input.sessionSecret,
    registry: input.registry,
  });
  if (!authenticated) return { outcome: "unauthenticated" };

  if (typeof input.attemptId !== "string" || typeof input.signature !== "string") return { outcome: "not_found" };

  const attempt = await input.paymentStore.findById(input.attemptId);
  if (!attempt || attempt.appUserId !== authenticated.account.appUserId) return { outcome: "not_found" };
  if (attempt.state !== "awaiting_authorization") return { outcome: "wrong_state", state: attempt.state };

  const claimed = await input.paymentStore.transition({ id: attempt.id, from: "awaiting_authorization", to: "signed" });
  if (!claimed) return { outcome: "wrong_state", state: attempt.state };

  const ownerAddress = validateAddressCasePreserving(authenticated.account.ownerAddress);
  if (!ownerAddress || !claimed.expectedUserOperationHash) {
    const updated = await input.paymentStore.transition({
      id: claimed.id,
      from: "signed",
      to: "failed",
      patch: { failureReason: "Account or prepared payment state is invalid." },
    });
    return { outcome: "failed", attempt: toPublicAttempt(updated ?? claimed) };
  }

  const fields = toPreparedFields(claimed);
  const verification = await verifyPreparedPaymentSignature({
    fields,
    expectedOwner: ownerAddress as Address,
    expectedUserOperationHash: claimed.expectedUserOperationHash as Hash,
    signature: input.signature as Hex,
  });

  if (!verification.ok) {
    // Nothing was ever dispatched — a definitive, retryable failure.
    const updated = await input.paymentStore.transition({ id: claimed.id, from: "signed", to: "failed", patch: { failureReason: verification.reason } });
    return { outcome: "failed", attempt: toPublicAttempt(updated ?? claimed) };
  }

  // The signature independently verified. Durably record "we are about to
  // dispatch" BEFORE ever calling the bundler — see the doc comment above.
  const submitting = await input.paymentStore.transition({ id: claimed.id, from: "signed", to: "submitting" });
  if (!submitting) {
    // Should not happen (this caller is the only one that could be holding
    // "signed" for this attempt, per the CAS above) — refuse rather than
    // dispatch against a state we can no longer account for.
    const current = await input.paymentStore.findById(claimed.id);
    return { outcome: "wrong_state", state: current?.state ?? claimed.state };
  }

  const outcome = await dispatchPreparedPayment({
    fields,
    signature: input.signature as Hex,
    expectedUserOperationHash: submitting.expectedUserOperationHash as Hash,
    sendUserOperation: (params) =>
      sendPreparedUserOperation({ pimlicoApiKey: input.pimlicoApiKey, fields: params, signature: params.signature }),
  });

  if (outcome.status === "failed") {
    const updated = await input.paymentStore.transition({ id: submitting.id, from: "submitting", to: "failed", patch: { failureReason: outcome.reason } });
    return { outcome: "failed", attempt: toPublicAttempt(updated ?? submitting) };
  }
  if (outcome.status === "unknown") {
    const updated = await input.paymentStore.transition({ id: submitting.id, from: "submitting", to: "unknown", patch: { failureReason: outcome.reason } });
    return { outcome: "unknown", attempt: toPublicAttempt(updated ?? submitting) };
  }

  const updated = await input.paymentStore.transition({ id: submitting.id, from: "submitting", to: "submitted" });
  return { outcome: "submitted", attempt: toPublicAttempt(updated ?? submitting) };
}

export type PaymentStatusOutcome = { outcome: "unauthenticated" } | { outcome: "not_found" } | { outcome: "ok"; attempt: PublicPaymentAttempt };

const RECONCILABLE_STATES: readonly PaymentAttemptState[] = ["submitting", "submitted", "unknown"];

/**
 * Reconciles a submitting/submitted/unknown attempt against the bundler by
 * the PRECOMPUTED expected_user_operation_hash — never anything
 * client-supplied — so this works identically after a page reload, a
 * server restart, or a completely lost /submit response. "submitting" is
 * included deliberately: a row stuck there (the process died somewhere
 * between the durable pre-dispatch CAS and recording the dispatch result)
 * gets reconciled exactly the same way "unknown" does — NEVER by calling
 * dispatchPreparedPayment again. Only ever moves an attempt to
 * confirmed/failed on an unambiguous receipt (see reconcile.ts's
 * classifyReceipt); anything else (including no receipt at all — e.g. a
 * "submitting" row where the send never actually reached the network)
 * leaves the attempt exactly where it was.
 */
export async function resolvePaymentStatus(input: {
  cookieValue: string | undefined | null;
  sessionSecret: string;
  registry: RealAccountRegistry;
  paymentStore: PaymentAttemptStore;
  pimlicoApiKey: string;
  attemptId: string;
}): Promise<PaymentStatusOutcome> {
  const authenticated = await readAuthenticatedRealAccount({
    cookieValue: input.cookieValue,
    sessionSecret: input.sessionSecret,
    registry: input.registry,
  });
  if (!authenticated) return { outcome: "unauthenticated" };

  const attempt = await input.paymentStore.findById(input.attemptId);
  if (!attempt || attempt.appUserId !== authenticated.account.appUserId) return { outcome: "not_found" };

  if (!RECONCILABLE_STATES.includes(attempt.state) || !attempt.expectedUserOperationHash) {
    return { outcome: "ok", attempt: toPublicAttempt(attempt) };
  }

  const receipt = await fetchUserOperationReceipt({
    pimlicoApiKey: input.pimlicoApiKey,
    userOperationHash: attempt.expectedUserOperationHash as Hash,
  }).catch(() => null);

  const classification = classifyReceipt(receipt, {
    userOperationHash: attempt.expectedUserOperationHash as Hash,
    sender: attempt.safeAddress as Address,
  });

  if (classification.outcome === "unresolved") {
    return { outcome: "ok", attempt: toPublicAttempt(attempt) };
  }

  const nextState: PaymentAttemptState = classification.outcome === "confirmed" ? "confirmed" : "failed";
  const patch: PaymentAttemptPatch =
    nextState === "confirmed"
      ? { transactionHash: classification.transactionHash }
      : { transactionHash: classification.transactionHash, failureReason: "The bundler reported the operation reverted on-chain." };

  const updated = await input.paymentStore.transition({ id: attempt.id, from: attempt.state, to: nextState, patch });
  return { outcome: "ok", attempt: toPublicAttempt(updated ?? attempt) };
}

export type LatestPaymentOutcome =
  | { outcome: "unauthenticated" }
  | { outcome: "none" }
  | { outcome: "ok"; attempt: PublicPaymentAttempt; subOrganizationId: string | null };

/**
 * Reload/restore: returns the most recent attempt (any state) for the
 * authenticated account with no side effects — never signs, never submits,
 * never resends. subOrganizationId is only included when the attempt is
 * still awaiting a signature (the only state whose UI has a signing action
 * to resume).
 */
export async function resolveLatestPayment(input: {
  cookieValue: string | undefined | null;
  sessionSecret: string;
  registry: RealAccountRegistry;
  paymentStore: PaymentAttemptStore;
}): Promise<LatestPaymentOutcome> {
  const authenticated = await readAuthenticatedRealAccount({
    cookieValue: input.cookieValue,
    sessionSecret: input.sessionSecret,
    registry: input.registry,
  });
  if (!authenticated) return { outcome: "unauthenticated" };

  const attempt = await input.paymentStore.findLatestByAppUserId(authenticated.account.appUserId);
  if (!attempt) return { outcome: "none" };

  const subOrganizationId = attempt.state === "awaiting_authorization" ? authenticated.account.subOrganizationId : null;
  return { outcome: "ok", attempt: toPublicAttempt(attempt), subOrganizationId };
}

export type CancelPaymentOutcome =
  | { outcome: "unauthenticated" }
  | { outcome: "not_found" }
  | { outcome: "wrong_state"; state: PaymentAttemptState }
  | { outcome: "cancelled"; attempt: PublicPaymentAttempt };

/**
 * Lets a user abandon an attempt that is still awaiting_authorization —
 * e.g. after cancelling the passkey prompt and deciding not to retry —
 * without leaving it stuck occupying the account's one-active-attempt slot
 * forever. Only valid from awaiting_authorization: once a signature exists
 * (signed/submitting/submitted/unknown), cancelling would be meaningless or
 * unsafe (the operation may already be on its way to the chain).
 */
export async function resolveCancelPayment(input: {
  cookieValue: string | undefined | null;
  sessionSecret: string;
  registry: RealAccountRegistry;
  paymentStore: PaymentAttemptStore;
  attemptId: string;
}): Promise<CancelPaymentOutcome> {
  const authenticated = await readAuthenticatedRealAccount({
    cookieValue: input.cookieValue,
    sessionSecret: input.sessionSecret,
    registry: input.registry,
  });
  if (!authenticated) return { outcome: "unauthenticated" };

  const attempt = await input.paymentStore.findById(input.attemptId);
  if (!attempt || attempt.appUserId !== authenticated.account.appUserId) return { outcome: "not_found" };

  const updated = await input.paymentStore.transition({ id: attempt.id, from: "awaiting_authorization", to: "cancelled" });
  if (!updated) return { outcome: "wrong_state", state: attempt.state };

  return { outcome: "cancelled", attempt: toPublicAttempt(updated) };
}
