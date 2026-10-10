import type { Address, Hash, Hex } from "viem";
import { addressesEqual, isValidUuid, normalizeAddress, validateAddressCasePreserving } from "../identifiers";
import { readCashBalance } from "../chain/balance";
import type { RealPublicClient } from "../chain/client";
import { readAuthenticatedRealAccount } from "./auth";
import type { RealAccountRegistry } from "./registry";
import { exceedsAvailableBalance, exceedsPaymentCeiling, isCanonicalBaseUnitsString, isZeroBaseUnits } from "../payments/amount";
import { computeExpectedUserOperationHash } from "../payments/hash";
import { parsePreparedFieldsFromWire, type PreparedUserOperationFields, type WirePreparedFields } from "../payments/prepared-operation";
import { computeExpectedSafeOpDigest, dispatchPreparedPayment, verifyPreparedPaymentSignature } from "../payments/submit";
import { splitSafeOpSignature } from "../payments/safe-op-preflight";
import { credentialIdsEqual } from "../credential-id";
import { classifyReceipt } from "../payments/reconcile";
import { computeValidUntil, hasEnoughValidityToDispatch } from "../payments/validity";
import { readLatestBlockClock, readUserOperationChainState, type EntryPointReader } from "../chain/entry-point";
import { fetchUserOperationReceipt, prepareCashTransferUserOperation, sendPreparedUserOperation } from "./pimlico";
import { BASE_SEPOLIA_CHAIN_ID, REAL_CASH_TOKEN } from "../constants";
import { DuplicateSignActivityError, toPublicRecipientIdentity, type PaymentAttempt, type PaymentAttemptPatch, type PaymentAttemptState, type PaymentAttemptStore, type PublicRecipientIdentity } from "./payment-attempts";
import { isWellFormedActivityId, verifyPaymentAuthorization } from "./payment-authorization";
import { ADDRESS_PREPARE_POLICIES, HANDLE_PREPARE_POLICIES, type RateLimiter } from "./rate-limit";
import type { RealServerConfig } from "./config";
import type { PrepareRecipientSelector } from "./handle-recipient";

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
const SAFE_EXPIRED_BEFORE_SEND = "This payment expired before it could be sent. Nothing was sent — start a new payment.";
const SAFE_EXPIRED_UNINCLUDED = "This payment expired before it was included on-chain. No money moved.";
const SAFE_REVERTED = "The bundler reported the operation reverted on-chain.";
const SAFE_UNATTRIBUTED = "This payment was started before a security update and can't be sent. Nothing was sent — start a new payment.";
const SAFE_AUTHORIZATION_REJECTED = "This payment's passkey approval could not be verified. Nothing was sent — start a new payment.";
const SAFE_AUTHORIZER_NOT_ACTIVE = "The passkey that approved this payment was removed before it could be sent. Nothing was sent.";

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
  /** Slice D: the handle a handle payment was addressed to, with its stored display-name snapshot; null for an address payment. Presentation only — nothing reads it back as authority. */
  recipientIdentity: PublicRecipientIdentity | null;
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
    attempt.maxPriorityFeePerGas !== null &&
    // A legacy row with no finite window is never offered for signing.
    attempt.validUntil !== null;

  return {
    id: attempt.id,
    state: attempt.state,
    recipient: attempt.recipient,
    recipientIdentity: toPublicRecipientIdentity(attempt),
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
          validUntil: attempt.validUntil!,
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
    attempt.maxPriorityFeePerGas === null ||
    attempt.validUntil === null
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
    validUntil: attempt.validUntil,
  });
}

export type PreparePaymentOutcome =
  | { outcome: "unauthenticated" }
  | { outcome: "account_not_ready" }
  | { outcome: "invalid_recipient" }
  /** A handle that is not already in canonical form. Refused before anything is reserved. */
  | { outcome: "invalid_recipient_handle" }
  /** Reserved, nonexistent, missing account, or invalid Safe — deliberately indistinguishable. */
  | { outcome: "recipient_not_found" }
  /** The handle is the payer's own account. (A direct address is not checked — unchanged.) */
  | { outcome: "self_payment" }
  | { outcome: "invalid_amount" }
  /** Slice E: the payer's prepare (or, for a handle, probe) budget is spent. Nothing was read, reserved, or sent. Distinct from quota_exceeded, the payment quota. */
  | { outcome: "rate_limited"; retryAfterSeconds: number }
  | { outcome: "balance_check_failed"; reason: string }
  | { outcome: "insufficient_balance" }
  | { outcome: "quota_exceeded" }
  | { outcome: "payment_in_progress" }
  | { outcome: "prepare_failed"; reason: string }
  /** serverNowSeconds: see PaymentStatusOutcome's doc comment — same server wall clock, same advisory-only purpose. */
  | { outcome: "ready"; attempt: PublicPaymentAttempt; subOrganizationId: string; authorizingCredentialId: string; serverNowSeconds: number };

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
 *
 * Slice S1: the attempt is bound, at creation, to the ONE passkey that may
 * approve it — the app session's own credential, just re-checked active and
 * owned by this account (readAuthenticatedRealAccount). Never a
 * client-supplied id; never changed afterwards.
 *
 * Slice E: once the request is authenticated and well-formed (account ready,
 * one valid selector, a valid amount) it is charged to the payer's own rate
 * budget — BEFORE the balance read, the block-clock read, the reservation
 * (and, for a handle, the recipient resolution inside it), and Pimlico. An
 * address payment draws on the prepare budget; a handle payment draws on the
 * prepare AND the recipient-probe budgets, because its refusals tell an
 * existing handle from a missing one. A denied request does none of that work
 * and creates no attempt. This changes no payment authority and none of the
 * outcomes below it.
 */
export async function resolvePreparePayment(input: {
  cookieValue: string | undefined | null;
  sessionSecret: string;
  registry: RealAccountRegistry;
  paymentStore: PaymentAttemptStore;
  /** Slice E: required, so no caller can prepare a payment unmetered. Told only the payer's app_user_id — never the recipient. */
  rateLimiter: RateLimiter;
  publicClient: RealPublicClient;
  pimlicoApiKey: string;
  /**
   * The parsed recipient selector (handle-recipient.ts's parsePrepareRecipientSelector,
   * run at the route). null = the request named zero or two recipients, refused as
   * invalid_recipient AFTER authentication. This module deliberately imports no handle
   * module: handle syntax is checked at the edge, and a `handle` selector arrives
   * already verified canonical.
   */
  recipient: PrepareRecipientSelector | null;
  amountBaseUnitsInput: unknown;
  /** Unix ms. Injectable for tests — the server's own wall clock, same one resolveSubmitPayment's dispatch-margin check uses. */
  now?: () => number;
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

  // Exactly one recipient selector. No recipient VARIABLE survives this block:
  // after reservation the only recipient authority is reserved.attempt.recipient.
  let target: { kind: "address"; address: string } | { kind: "handle"; handle: string };
  if (!input.recipient) return { outcome: "invalid_recipient" };
  if (input.recipient.kind === "address") {
    if (typeof input.recipient.value !== "string") return { outcome: "invalid_recipient" };
    const address = normalizeAddress(input.recipient.value);
    if (!address) return { outcome: "invalid_recipient" };
    target = { kind: "address", address };
  } else if (input.recipient.kind === "handle") {
    target = { kind: "handle", handle: input.recipient.handle };
  } else {
    return { outcome: "invalid_recipient_handle" };
  }

  if (typeof input.amountBaseUnitsInput !== "string") return { outcome: "invalid_amount" };
  const amountBaseUnits = input.amountBaseUnitsInput;
  if (!isCanonicalBaseUnitsString(amountBaseUnits) || isZeroBaseUnits(amountBaseUnits) || exceedsPaymentCeiling(amountBaseUnits)) {
    return { outcome: "invalid_amount" };
  }

  const admitted = await input.rateLimiter.consume({
    subject: authenticated.account.appUserId,
    policies: target.kind === "handle" ? HANDLE_PREPARE_POLICIES : ADDRESS_PREPARE_POLICIES,
  });
  if (!admitted.allowed) return { outcome: "rate_limited", retryAfterSeconds: admitted.retryAfterSeconds };

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

  // The SafeOp's finite window is anchored to the chain's own clock (the one
  // the EntryPoint enforces), read before any row exists — a failed read
  // leaves no trace and nothing is prepared (fail closed).
  let chainClock: { number: bigint; timestamp: bigint };
  try {
    chainClock = await readLatestBlockClock(input.publicClient);
  } catch {
    return { outcome: "prepare_failed", reason: SAFE_PREPARE_FAILED };
  }

  const payment = {
    appUserId: authenticated.account.appUserId,
    safeAddress,
    amountBaseUnits,
    chainId: BASE_SEPOLIA_CHAIN_ID,
    tokenAddress: REAL_CASH_TOKEN.address,
    authorizingCredentialId: authenticated.passkey.credentialId,
  };
  // An address payment goes through reserve() (identity snapshot all NULL, no
  // handle lookup); a handle payment goes through reserveHandlePayment(), which
  // resolves the recipient inside the reservation. Neither is told anything
  // about the other.
  const reserved =
    target.kind === "address"
      ? await input.paymentStore.reserve({ ...payment, recipient: target.address })
      : await input.paymentStore.reserveHandlePayment({ ...payment, recipientHandle: target.handle });
  if (!reserved.ok) return { outcome: reserved.reason };

  // THE single recipient source for the Safe transfer, for address AND handle
  // payments: what the store actually recorded. Re-validated before it is
  // encoded; if it is somehow unusable, fail closed — never derive another.
  const attemptRecipient = normalizeAddress(reserved.attempt.recipient);
  if (!attemptRecipient) {
    await input.paymentStore.transition({ id: reserved.attempt.id, from: "prepared", to: "failed", patch: { failureReason: SAFE_PREPARE_FAILED } });
    return { outcome: "prepare_failed", reason: SAFE_PREPARE_FAILED };
  }

  let prepared: PreparedUserOperationFields;
  try {
    prepared = await prepareCashTransferUserOperation({
      publicClient: input.publicClient,
      pimlicoApiKey: input.pimlicoApiKey,
      ownerAddress: ownerAddress as Address,
      recipient: attemptRecipient as Address,
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
    validUntil: computeValidUntil(chainClock.timestamp),
    prepareBlockNumber: chainClock.number.toString(),
  };

  const updated = await input.paymentStore.transition({ id: reserved.attempt.id, from: "prepared", to: "awaiting_authorization", patch });
  if (!updated) {
    return { outcome: "prepare_failed", reason: "Could not persist the prepared payment." };
  }

  return {
    outcome: "ready",
    attempt: toPublicAttempt(updated),
    subOrganizationId: authenticated.account.subOrganizationId,
    authorizingCredentialId: authenticated.passkey.credentialId,
    serverNowSeconds: Math.floor((input.now ?? Date.now)() / 1000),
  };
}

export type SubmitPaymentOutcome =
  | { outcome: "unauthenticated" }
  | { outcome: "not_found" }
  | { outcome: "invalid_signature" }
  | { outcome: "wrong_state"; state: PaymentAttemptState }
  /** The session's passkey is not the one this payment is bound to. Nothing changes; the payment can only be cancelled (or approved from its own passkey's session). */
  | { outcome: "wrong_passkey" }
  /** Turnkey couldn't confirm the approval right now. Nothing changes and nothing is sent; the SAME signature may be retried — no new passkey prompt needed. */
  | { outcome: "authorization_unavailable" }
  | { outcome: "submitted"; attempt: PublicPaymentAttempt }
  | { outcome: "failed"; attempt: PublicPaymentAttempt }
  | { outcome: "unknown"; attempt: PublicPaymentAttempt };

/** A Safe4337 signature is always `0x` + an even number of hex digits (validAfter/validUntil prefix + a packed owner signature). Checked BEFORE the awaiting_authorization -> signed CAS so structurally-malformed input never even claims the row — see safe-op-preflight.ts's splitSafeOpSignature for the more detailed, post-CAS shape checks this doesn't replace. */
const HEX_SIGNATURE_PATTERN = /^0x[0-9a-fA-F]+$/;
function isWellFormedHexSignature(value: string): boolean {
  return HEX_SIGNATURE_PATTERN.test(value) && (value.length - 2) % 2 === 0;
}

/** A definitive refusal found before the row is claimed: awaiting_authorization -> failed, nothing sent. A lost CAS (concurrent cancel/submit/expiry) reports the true current state. */
async function failBeforeClaim(store: PaymentAttemptStore, attempt: PaymentAttempt, reason: string): Promise<SubmitPaymentOutcome> {
  const updated = await store.transition({ id: attempt.id, from: "awaiting_authorization", to: "failed", patch: { failureReason: reason } });
  if (updated) return { outcome: "failed", attempt: toPublicAttempt(updated) };
  const current = await store.findById(attempt.id);
  return { outcome: "wrong_state", state: current?.state ?? attempt.state };
}

/**
 * A valid app session alone is never enough to reach here successfully: the
 * caller must also supply a signature that independently verifies (via
 * verifyPreparedPaymentSignature's SafeOp preflight) against the canonical
 * owner — nothing about the HttpOnly cookie itself produces or approves a
 * signature.
 *
 * Slice S1 — credential attribution, BEFORE the row is claimed:
 *   - the attempt must be bound (authorizingCredentialId; legacy unbound
 *     rows fail closed and are never back-filled);
 *   - the session's own credential must BE that binding (compared as
 *     decoded bytes) — another passkey's session is refused without
 *     touching the row, so a payment is never silently re-bound;
 *   - verifyPaymentAuthorization must prove, from Turnkey's records, that
 *     the bound passkey approved signing exactly this row's SafeOp digest
 *     and that the submitted owner signature is that activity's signature.
 *     "unavailable" changes nothing (the same signature may be retried);
 *     "rejected" fails the attempt, nothing sent.
 * The verified activity id is recorded (write-once, unique across payments)
 * by transition 1 itself, so a claimed row always names its approval.
 *
 * Ordering: structural checks (hex signature, activity-id shape) -> the
 * attribution above (Turnkey reads) -> transition 1 (awaiting_authorization
 * -> signed) -> expiry + SafeOp preflight -> transition 2 (signed ->
 * submitting, atomically only while the bound passkey is still active —
 * PaymentAttemptStore.beginDispatch) -> dispatch. Expiry is checked AFTER
 * the Turnkey reads, so time spent verifying can't carry a stale payment
 * past the dispatch margin.
 *
 * Two separate CAS transitions guard dispatch, not one:
 *
 *  1. awaiting_authorization -> signed — the duplicate-submit guard: a second
 *     concurrent call for the same attempt id finds it no longer
 *     "awaiting_authorization" and backs off.
 *  2. signed -> submitting (beginDispatch: also requires the bound passkey
 *     still active, in the same serialized step), AFTER the signature has
 *     independently verified (preflight + recomputed-hash check) but BEFORE
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
 * Pre-2f hardening: everything that can throw on a stored row or a
 * signature (toPreparedFields' BigInt parsing, signature recovery) runs
 * inside a try/catch that ends in a durable, terminal "failed" — never a
 * raw exception and never a row stranded at "signed". Cancel also accepts
 * "signed" (resolveCancelPayment) as the last line of defense.
 */
export async function resolveSubmitPayment(input: {
  cookieValue: string | undefined | null;
  sessionSecret: string;
  registry: RealAccountRegistry;
  paymentStore: PaymentAttemptStore;
  pimlicoApiKey: string;
  /** Parent-key, read-only Turnkey access for the attribution proof. */
  config: RealServerConfig;
  attemptId: unknown;
  signature: unknown;
  /** The Turnkey signRawPayload activity id the browser got back — a locator only; verified server-side before anything is trusted. */
  activityId: unknown;
  /** Unix ms. Injectable for tests; the dispatch-margin check is safe under clock skew in both directions (see validity.ts). */
  now?: () => number;
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
  if (!isWellFormedActivityId(input.activityId)) return { outcome: "invalid_signature" };
  const activityId = input.activityId;

  const attempt = await input.paymentStore.findById(input.attemptId);
  if (!attempt || attempt.appUserId !== authenticated.account.appUserId) return { outcome: "not_found" };
  if (attempt.state !== "awaiting_authorization") return { outcome: "wrong_state", state: attempt.state };

  if (!attempt.authorizingCredentialId) return failBeforeClaim(input.paymentStore, attempt, SAFE_UNATTRIBUTED);
  // The session credential was just re-checked active and owned by this
  // account, so on a byte match its registry row IS the bound passkey's.
  if (!credentialIdsEqual(authenticated.passkey.credentialId, attempt.authorizingCredentialId)) return { outcome: "wrong_passkey" };

  let fields: PreparedUserOperationFields;
  let expectedDigest: Hex;
  let ownerSignature: Hex;
  try {
    if (attempt.validUntil === null) return failBeforeClaim(input.paymentStore, attempt, SAFE_EXPIRED_BEFORE_SEND);
    fields = toPreparedFields(attempt);
    expectedDigest = computeExpectedSafeOpDigest(fields, attempt.validUntil);
    const split = splitSafeOpSignature(input.signature as Hex);
    if (!split || split.byteLength !== 65) return failBeforeClaim(input.paymentStore, attempt, SAFE_SIGNATURE_INVALID);
    ownerSignature = split.ownerSignature;
  } catch {
    return failBeforeClaim(input.paymentStore, attempt, SAFE_INTERNAL_ERROR);
  }

  const authorization = await verifyPaymentAuthorization({
    config: input.config,
    account: authenticated.account,
    passkey: authenticated.passkey,
    activityId,
    expectedDigest,
    ownerSignature,
  });
  if (authorization.outcome === "unavailable") return { outcome: "authorization_unavailable" };
  if (authorization.outcome === "rejected") return failBeforeClaim(input.paymentStore, attempt, SAFE_AUTHORIZATION_REJECTED);

  let claimed: PaymentAttempt | null;
  try {
    claimed = await input.paymentStore.transition({
      id: attempt.id,
      from: "awaiting_authorization",
      to: "signed",
      patch: { turnkeySignActivityId: activityId, authorizationVerifiedAt: new Date().toISOString() },
    });
  } catch (error) {
    // Already recorded as another payment's approval — never twice. Nothing was written.
    if (error instanceof DuplicateSignActivityError) return failBeforeClaim(input.paymentStore, attempt, SAFE_AUTHORIZATION_REJECTED);
    throw error;
  }
  if (!claimed) {
    // Lost to a concurrent submit/cancel/expiry — report the row's actual
    // durable state now, never the stale pre-claim one.
    const current = await input.paymentStore.findById(attempt.id);
    return { outcome: "wrong_state", state: current?.state ?? attempt.state };
  }

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

    // A finite window with enough left to be sent, or nothing is dispatched.
    // Only local work and one registry read sit between here and the
    // pre-dispatch CAS, far inside the dispatch margin. Refusing sends
    // nothing; the signature is discarded with the request.
    const nowSeconds = Math.floor((input.now ?? Date.now)() / 1000);
    if (!hasEnoughValidityToDispatch(claimed.validUntil, nowSeconds)) {
      const updated = await input.paymentStore.transition({ id: claimed.id, from: "signed", to: "failed", patch: { failureReason: SAFE_EXPIRED_BEFORE_SEND } });
      return { outcome: "failed", attempt: toPublicAttempt(updated ?? claimed) };
    }

    const verification = await verifyPreparedPaymentSignature({
      fields,
      expectedOwner: ownerAddress as Address,
      expectedUserOperationHash: claimed.expectedUserOperationHash as Hash,
      expectedValidUntil: claimed.validUntil!,
      signature: input.signature as Hex,
    });

    if (!verification.ok) {
      // Nothing was ever dispatched — a definitive, retryable failure.
      const updated = await input.paymentStore.transition({ id: claimed.id, from: "signed", to: "failed", patch: { failureReason: SAFE_SIGNATURE_INVALID } });
      return { outcome: "failed", attempt: toPublicAttempt(updated ?? claimed) };
    }

    // The signature independently verified. Durably record "we are about to
    // dispatch" BEFORE ever calling the bundler — see the doc comment above —
    // in ONE atomic step with the revocation-after-signing policy: the claim
    // succeeds only while the approving passkey is still `active`, serialized
    // against passkey removal (PaymentAttemptStore.beginDispatch). A removal
    // that commits first stops our dispatch; one that commits after the claim
    // doesn't retroactively unsend it. (Neither revokes the signature itself:
    // the owner key is shared by every passkey and the SafeOp stays valid
    // until validUntil for anyone holding it.)
    submitting = await input.paymentStore.beginDispatch({ id: claimed.id });
    if (!submitting) {
      const current = await input.paymentStore.findById(claimed.id);
      if (current?.state === "signed") {
        // Still ours to resolve: the claim failed only because the passkey is no longer active.
        const updated = await input.paymentStore.transition({ id: claimed.id, from: "signed", to: "failed", patch: { failureReason: SAFE_AUTHORIZER_NOT_ACTIVE } });
        if (updated) return { outcome: "failed", attempt: toPublicAttempt(updated) };
      }
    }
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

export type PaymentStatusOutcome =
  | { outcome: "unauthenticated" }
  | { outcome: "not_found" }
  /**
   * Part E (S2): serverNowSeconds is this server's OWN wall clock
   * (Date.now(), the same clock resolveSubmitPayment's dispatch-margin check
   * is judged against) — never the chain's clock. It lets the client
   * compute an advisory local-clock offset for its own pre-signing UX gate;
   * the server remains independently authoritative at /submit regardless.
   */
  | { outcome: "ok"; attempt: PublicPaymentAttempt; serverNowSeconds: number };

const RECONCILABLE_STATES: readonly PaymentAttemptState[] = ["submitting", "submitted", "unknown"];

/**
 * Never dispatched by US — but the server can't know the browser never
 * signed (it may have signed and crashed before /submit), so "not submitted"
 * is never treated as "can't land". These resolve only through the same
 * EntryPoint proof as dispatched rows, and only once validUntil has passed.
 * Without this, an abandoned prepare held the account's one active-payment
 * slot until the user explicitly cancelled it.
 */
const PRE_DISPATCH_EXPIRABLE_STATES: readonly PaymentAttemptState[] = ["awaiting_authorization", "signed"];

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
 * leaves the attempt exactly where it was. Pre-dispatch rows
 * (awaiting_authorization/signed) past validUntil are resolved by the same
 * EntryPoint proof only — see PRE_DISPATCH_EXPIRABLE_STATES.
 */
export async function resolvePaymentStatus(input: {
  cookieValue: string | undefined | null;
  sessionSecret: string;
  registry: RealAccountRegistry;
  paymentStore: PaymentAttemptStore;
  pimlicoApiKey: string;
  /** Read-only EntryPoint access for bundler-independent reconciliation (chain/entry-point.ts). */
  publicClient: EntryPointReader;
  attemptId: string;
  /** Unix ms. Only a pre-filter for pre-dispatch rows (skip chain reads before validUntil) — never the proof. */
  now?: () => number;
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

  const nowSeconds = Math.floor((input.now ?? Date.now)() / 1000);

  if (PRE_DISPATCH_EXPIRABLE_STATES.includes(attempt.state)) {
    if (attempt.validUntil === null || nowSeconds <= attempt.validUntil) return { outcome: "ok", attempt: toPublicAttempt(attempt), serverNowSeconds: nowSeconds };
    const resolution = await reconcileAgainstEntryPoint(input.publicClient, attempt);
    if (!resolution) return { outcome: "ok", attempt: toPublicAttempt(attempt), serverNowSeconds: nowSeconds };
    // CAS from the row's own state: a concurrent submit (awaiting -> signed
    // -> submitting) or cancel that got there first simply wins, and submit's
    // own expiry check refuses to dispatch past validUntil anyway.
    const updated = await input.paymentStore.transition({ id: attempt.id, from: attempt.state, to: resolution.to, patch: resolution.patch });
    return { outcome: "ok", attempt: toPublicAttempt(updated ?? attempt), serverNowSeconds: nowSeconds };
  }

  if (!RECONCILABLE_STATES.includes(attempt.state) || !attempt.expectedUserOperationHash) {
    return { outcome: "ok", attempt: toPublicAttempt(attempt), serverNowSeconds: nowSeconds };
  }

  const receipt = await fetchUserOperationReceipt({
    pimlicoApiKey: input.pimlicoApiKey,
    userOperationHash: attempt.expectedUserOperationHash as Hash,
  }).catch(() => null);

  const classification = classifyReceipt(receipt, {
    userOperationHash: attempt.expectedUserOperationHash as Hash,
    sender: attempt.safeAddress as Address,
  });

  let resolution: { to: PaymentAttemptState; patch: PaymentAttemptPatch } | null = null;
  if (classification.outcome === "confirmed") {
    // Explicitly clears any failure_reason a prior "unknown" resolution left
    // behind (e.g. an earlier submit-time send ambiguity) — a row that ends
    // up confirmed must not carry stale failure metadata. See neon-store.ts's
    // has()-guarded CASE WHEN: an explicit null here is what makes this
    // clear, as opposed to merely omitting the field.
    resolution = { to: "confirmed", patch: { transactionHash: classification.transactionHash, failureReason: null } };
  } else if (classification.outcome === "failed") {
    resolution = { to: "failed", patch: { transactionHash: classification.transactionHash, failureReason: SAFE_REVERTED } };
  } else {
    resolution = await reconcileAgainstEntryPoint(input.publicClient, attempt);
  }

  if (!resolution) return { outcome: "ok", attempt: toPublicAttempt(attempt), serverNowSeconds: nowSeconds };
  const updated = await input.paymentStore.transition({ id: attempt.id, from: attempt.state, to: resolution.to, patch: resolution.patch });
  return { outcome: "ok", attempt: toPublicAttempt(updated ?? attempt), serverNowSeconds: nowSeconds };
}

/**
 * When the bundler has no answer, ask the EntryPoint directly (see
 * chain/entry-point.ts): the operation's own nonce lane plus its
 * UserOperationEvent prove inclusion, and an unconsumed nonce at a
 * finalized block past validUntil proves it can never land — so a lost
 * bundler, a lost response, or a restart can't leave local state silently
 * disagreeing with the chain forever. Never dispatches anything. Legacy
 * rows without a window, and any read error, stay exactly as they are.
 */
async function reconcileAgainstEntryPoint(client: EntryPointReader, attempt: PaymentAttempt): Promise<{ to: PaymentAttemptState; patch: PaymentAttemptPatch } | null> {
  if (attempt.validUntil === null || attempt.prepareBlockNumber === null || attempt.nonce === null || !attempt.expectedUserOperationHash) return null;
  const sender = validateAddressCasePreserving(attempt.safeAddress);
  if (!sender) return null;
  try {
    const state = await readUserOperationChainState(client, {
      sender: sender as Address,
      nonce: BigInt(attempt.nonce),
      userOperationHash: attempt.expectedUserOperationHash as Hash,
      prepareBlockNumber: BigInt(attempt.prepareBlockNumber),
      validUntil: attempt.validUntil,
    });
    if (state.kind === "included") {
      // Same explicit-clear reasoning as resolvePaymentStatus's bundler-receipt branch above.
      return state.success
        ? { to: "confirmed", patch: { transactionHash: state.transactionHash, failureReason: null } }
        : { to: "failed", patch: { transactionHash: state.transactionHash, failureReason: SAFE_REVERTED } };
    }
    if (state.kind === "expired_unincluded") return { to: "failed", patch: { failureReason: SAFE_EXPIRED_UNINCLUDED } };
    return null;
  } catch {
    return null;
  }
}

export type LatestPaymentOutcome =
  | { outcome: "unauthenticated" }
  | { outcome: "none" }
  /** serverNowSeconds: see PaymentStatusOutcome's doc comment — same server wall clock, same advisory-only purpose. */
  | { outcome: "ok"; attempt: PublicPaymentAttempt; subOrganizationId: string | null; authorizingCredentialId: string | null; serverNowSeconds: number };

/**
 * Reload/restore: returns the most recent attempt (any state) for the
 * authenticated account with no side effects — never signs, never submits,
 * never resends. subOrganizationId/authorizingCredentialId (the signing
 * context) are only included when the attempt is still awaiting a signature
 * AND is bound to this session's own passkey — the only case whose UI may
 * resume signing. An unbound (legacy) attempt, or one bound to another
 * passkey, comes back with no signing context: cancel-only, never re-bound.
 */
export async function resolveLatestPayment(input: {
  cookieValue: string | undefined | null;
  sessionSecret: string;
  registry: RealAccountRegistry;
  paymentStore: PaymentAttemptStore;
  /** Unix ms. Injectable for tests — the server's own wall clock, same one resolveSubmitPayment's dispatch-margin check uses. */
  now?: () => number;
}): Promise<LatestPaymentOutcome> {
  const authenticated = await readAuthenticatedRealAccount({
    cookieValue: input.cookieValue,
    sessionSecret: input.sessionSecret,
    registry: input.registry,
  });
  if (!authenticated) return { outcome: "unauthenticated" };

  const attempt = await input.paymentStore.findLatestByAppUserId(authenticated.account.appUserId);
  if (!attempt) return { outcome: "none" };

  const resumable =
    attempt.state === "awaiting_authorization" && attempt.authorizingCredentialId !== null && credentialIdsEqual(attempt.authorizingCredentialId, authenticated.passkey.credentialId);
  return {
    outcome: "ok",
    attempt: toPublicAttempt(attempt),
    subOrganizationId: resumable ? authenticated.account.subOrganizationId : null,
    authorizingCredentialId: resumable ? attempt.authorizingCredentialId : null,
    serverNowSeconds: Math.floor((input.now ?? Date.now)() / 1000),
  };
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
