import type { Address, Hash, Hex } from "viem";
import { addressesEqual, isValidUuid, normalizeAddress, validateAddressCasePreserving } from "../identifiers";
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
 * Pre-2f hardening: fixed, safe messages for every failure path in this
 * file — never `error.message`/`error.shortMessage` from an upstream call.
 * viem's HttpRequestError/RpcRequestError embeds the request URL (and, for
 * Pimlico, its API key query param) in `.message`; raw upstream text must
 * never be persisted to `failure_reason` or returned in a response.
 */
const SAFE_BALANCE_CHECK_FAILED = "Could not check your balance right now. Try again in a moment.";
const SAFE_PREPARE_FAILED = "Could not prepare this payment right now. Try again in a moment.";
const SAFE_SENDER_MISMATCH = "Could not prepare this payment — your account isn't set up correctly.";
const SAFE_SIGNATURE_INVALID = "This payment's signature could not be verified.";
const SAFE_INTERNAL_ERROR = "Something went wrong while sending this payment. It was not sent.";

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
  } catch {
    // Never the raw upstream error — a viem RPC failure's .message can
    // embed the request URL (and any API key in it). See SAFE_* above.
    return { outcome: "balance_check_failed", reason: SAFE_BALANCE_CHECK_FAILED };
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
  } catch {
    // Never the raw upstream error — prepareCashTransferUserOperation calls
    // Pimlico over an API-key-bearing URL; a viem HttpRequestError/
    // RpcRequestError's .message can embed that URL verbatim. See SAFE_*.
    await input.paymentStore.transition({ id: reserved.attempt.id, from: "prepared", to: "failed", patch: { failureReason: SAFE_PREPARE_FAILED } });
    return { outcome: "prepare_failed", reason: SAFE_PREPARE_FAILED };
  }

  // Defense in depth: prepareCashTransferUserOperation derives its own
  // sender (permissionless's computed Safe address from ownerAddress) —
  // this must match the durable, session-derived safeAddress the rest of
  // this function already trusts. A mismatch would mean building/signing a
  // UserOperation for a different smart account than the one on record;
  // fail closed before the user is ever asked to sign.
  if (!addressesEqual(prepared.sender, safeAddress)) {
    await input.paymentStore.transition({ id: reserved.attempt.id, from: "prepared", to: "failed", patch: { failureReason: SAFE_SENDER_MISMATCH } });
    return { outcome: "prepare_failed", reason: SAFE_SENDER_MISMATCH };
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
  | { outcome: "invalid_signature" }
  | { outcome: "wrong_state"; state: PaymentAttemptState }
  | { outcome: "submitted"; attempt: PublicPaymentAttempt }
  | { outcome: "failed"; attempt: PublicPaymentAttempt }
  | { outcome: "unknown"; attempt: PublicPaymentAttempt };

/** A Safe4337 signature is always `0x` + an even number of hex digits (validAfter/validUntil prefix + a packed owner signature). Checked BEFORE the awaiting_authorization -> signed CAS so structurally-malformed input never even claims the row — see safe-op-preflight.ts's splitSafeOpSignature for the more detailed, post-CAS shape checks this doesn't replace. */
const HEX_SIGNATURE_PATTERN = /^0x[0-9a-fA-F]+$/;
function isWellFormedHexSignature(value: string): boolean {
  return HEX_SIGNATURE_PATTERN.test(value) && (value.length - 2) % 2 === 0;
}

/**
 * A valid app session alone is never enough to reach here successfully: the
 * caller must also supply a signature that independently verifies (via
 * verifyPreparedPaymentSignature's SafeOp preflight) against the canonical
 * owner — nothing about the HttpOnly cookie itself produces or approves a
 * signature.
 *
 * Ordering, in one line: structural hex-format validation
 * (isWellFormedHexSignature, above) happens before transition 1 below
 * (awaiting_authorization -> signed); cryptographic signature verification
 * happens after transition 1 and before transition 2 (signed -> submitting).
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
 *
 * Pre-2f hardening: everything between transition 1 and transition 2 —
 * `toPreparedFields` (unguarded BigInt parsing of the stored row) and
 * `verifyPreparedPaymentSignature` (can re-throw a non-preflight error) —
 * used to run outside any try/catch here. A throw in that window left the
 * row stranded at "signed" forever: not resendable (CAS source no longer
 * "awaiting_authorization"), not reconcilable (RECONCILABLE_STATES below is
 * submitting/submitted/unknown, never "signed"), and — since cancel only
 * accepted "awaiting_authorization" — not cancellable either, permanently
 * blocking the account's one-active-attempt slot. Two things now close
 * this: a pre-CAS hex-format check on the signature (so structurally
 * malformed input never even claims the row), and wrapping the whole
 * signed-window in try/catch (so anything else that throws still reaches a
 * durable, terminal "failed" — see the catch below). Cancel separately now
 * accepts "signed" too (resolveCancelPayment) as the last line of defense.
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
  if (!isValidUuid(input.attemptId)) return { outcome: "not_found" };
  if (!isWellFormedHexSignature(input.signature)) return { outcome: "invalid_signature" };

  const attempt = await input.paymentStore.findById(input.attemptId);
  if (!attempt || attempt.appUserId !== authenticated.account.appUserId) return { outcome: "not_found" };
  if (attempt.state !== "awaiting_authorization") return { outcome: "wrong_state", state: attempt.state };

  const claimed = await input.paymentStore.transition({ id: attempt.id, from: "awaiting_authorization", to: "signed" });
  if (!claimed) return { outcome: "wrong_state", state: attempt.state };

  let fields: PreparedUserOperationFields;
  let submitting: PaymentAttempt | null;
  try {
    const ownerAddress = validateAddressCasePreserving(authenticated.account.ownerAddress);
    if (!ownerAddress || !claimed.expectedUserOperationHash) {
      const updated = await input.paymentStore.transition({
        id: claimed.id,
        from: "signed",
        to: "failed",
        patch: { failureReason: SAFE_SIGNATURE_INVALID },
      });
      return { outcome: "failed", attempt: toPublicAttempt(updated ?? claimed) };
    }

    fields = toPreparedFields(claimed);
    const verification = await verifyPreparedPaymentSignature({
      fields,
      expectedOwner: ownerAddress as Address,
      expectedUserOperationHash: claimed.expectedUserOperationHash as Hash,
      signature: input.signature as Hex,
    });

    if (!verification.ok) {
      // Nothing was ever dispatched — a definitive, retryable failure.
      const updated = await input.paymentStore.transition({ id: claimed.id, from: "signed", to: "failed", patch: { failureReason: SAFE_SIGNATURE_INVALID } });
      return { outcome: "failed", attempt: toPublicAttempt(updated ?? claimed) };
    }

    // The signature independently verified. Durably record "we are about to
    // dispatch" BEFORE ever calling the bundler — see the doc comment above.
    submitting = await input.paymentStore.transition({ id: claimed.id, from: "signed", to: "submitting" });
  } catch {
    // Anything unexpected in this window (a corrupted stored row, an
    // unrecognized signature-recovery failure, ...) becomes a terminal,
    // safe failure — never a raw exception, and never a row stuck at
    // "signed". Nothing was dispatched.
    const updated = await input.paymentStore.transition({ id: claimed.id, from: "signed", to: "failed", patch: { failureReason: SAFE_INTERNAL_ERROR } });
    return { outcome: "failed", attempt: toPublicAttempt(updated ?? claimed) };
  }

  if (!submitting) {
    // Lost the signed -> submitting CAS — most likely a concurrent cancel
    // won first (resolveCancelPayment now accepts "signed"). Either way,
    // refuse rather than dispatch against a state we can no longer account
    // for; never re-attempt the CAS or the dispatch.
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
  if (!isValidUuid(input.attemptId)) return { outcome: "not_found" };

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
 * Pre-2f hardening: cancellable states expanded from just
 * awaiting_authorization to every pre-dispatch state — prepared,
 * awaiting_authorization, and signed. Nothing dispatched to the bundler in
 * any of these states, so abandoning them is always safe; this is also the
 * user's only way to clear an attempt that got stranded at "signed" by a
 * crash resolveSubmitPayment's try/catch didn't fully absorb (e.g. the
 * process died before that catch itself could run). submitting/submitted/
 * unknown are deliberately excluded — the operation may already be on its
 * way to (or already on) the chain, so those are never cancellable, only
 * reconcilable (resolvePaymentStatus).
 */
const CANCELLABLE_STATES: readonly PaymentAttemptState[] = ["prepared", "awaiting_authorization", "signed"];

/**
 * CAS's from the attempt's OWN current state, not a hardcoded one — this is
 * what makes the cancel-vs-submit race resolve correctly regardless of
 * which one reads the row first: if a concurrent resolveSubmitPayment has
 * already moved signed -> submitting by the time this CAS runs, `from`
 * (read moments ago) not matching current reality makes the transition
 * fail, this returns wrong_state, and the bundler is never touched by
 * cancel. Conversely, if this CAS wins first (signed -> cancelled),
 * resolveSubmitPayment's own signed -> submitting CAS then fails and it
 * never dispatches either — see payments-cancel.test.ts's race tests.
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
  if (!isValidUuid(input.attemptId)) return { outcome: "not_found" };

  const attempt = await input.paymentStore.findById(input.attemptId);
  if (!attempt || attempt.appUserId !== authenticated.account.appUserId) return { outcome: "not_found" };
  if (!CANCELLABLE_STATES.includes(attempt.state)) return { outcome: "wrong_state", state: attempt.state };

  const updated = await input.paymentStore.transition({ id: attempt.id, from: attempt.state, to: "cancelled" });
  if (!updated) {
    // Lost a race (e.g. a concurrent signed -> submitting CAS already won)
    // — re-read for the true current state rather than guessing.
    const current = await input.paymentStore.findById(attempt.id);
    return { outcome: "wrong_state", state: current?.state ?? attempt.state };
  }

  return { outcome: "cancelled", attempt: toPublicAttempt(updated) };
}
