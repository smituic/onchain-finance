import type { Address, Hex } from "viem";
import { createRealPublicClient } from "../chain/client";
import { createRealSafeAccount } from "../account/safe";
import { REAL_CASH_TOKEN } from "../constants";
import { normalizeAddress } from "../identifiers";
import { createVerifiedTurnkeyOwnerAccount } from "../signing/verified-account";
import { isCanonicalBaseUnitsString, isZeroBaseUnits } from "./amount";
import { parsePreparedFieldsFromWire, type WirePreparedFields } from "./prepared-operation";
import { encodeCashTransfer } from "./transfer";
import { hasEnoughValidityToDispatch, SAFE_OP_VALID_AFTER } from "./validity";

export const PAYMENT_EXPIRED_BEFORE_APPROVAL = "This payment expired before it was approved. Nothing was sent — start a new payment.";

/**
 * L-1b: the one fixed message for a payment whose signed contents could not be
 * verified against the held payment (an unusable expected recipient or amount,
 * a local encoding that could not complete, or prepared callData that is not
 * exactly the Cash transfer of that amount to that recipient). Thrown before
 * any signing request, so no passkey prompt is shown and nothing is signed.
 * Says nothing about whether the payment exists, failed or was sent.
 */
export const PAYMENT_DETAILS_UNVERIFIED = "We couldn't verify this payment's details. You can cancel it.";

/** L-1b: the held payment's own intent, as plain strings (the store's attempt.recipient / attempt.amountBaseUnits). */
export type ExpectedPaymentIntent = {
  recipient: string;
  amountBaseUnits: string;
};

export type SignPreparedPaymentInput = {
  /** Wire-shaped (every field a plain string) so callers outside lib/real/**
   * — the payment store in lib/stores/** — never need to import viem's
   * Address/Hex types themselves (lib/stores/** is fenced off from chain
   * SDKs, same as any other non-lib/real/** layer; see eslint.config.mjs). */
  fields: WirePreparedFields;
  rpId: string;
  subOrganizationId: string;
  ownerAddress: string;
  rpcUrl: string;
  /** Slice S1: the server-bound passkey for this payment (from /prepare or /latest) — the only credential the prompt may offer. */
  authorizingCredentialId: string;
  /**
   * Part E (S2): unix seconds to use for the UX-only pre-signing validity
   * check below, in place of raw `Date.now()`. Callers should pass their own
   * clock ADJUSTED by a server-derived offset (serverNowSeconds from
   * /prepare or /latest, captured once and combined with local elapsed
   * time) so a skewed local wall clock can't falsely refuse a payment that's
   * actually still well inside its window. Defaults to `Date.now()` when
   * omitted (e.g. existing callers/tests). Advisory only — the server
   * independently and authoritatively re-checks at /submit regardless.
   */
  nowSeconds?: number;
  /**
   * L-1b (required — there is no unchecked form): the recipient and amount of
   * the held payment this signature is for. The Cash transfer actually signed
   * is rebuilt locally from these two values and must equal `fields.callData`
   * exactly, or nothing is signed (PAYMENT_DETAILS_UNVERIFIED).
   */
  expected: ExpectedPaymentIntent;
};

/**
 * L-1b: the held recipient and amount, read ONCE as primitives and validated —
 * never re-read from the caller's object later. The recipient must be exactly
 * 0x + 40 hex (any case; no surrounding whitespace, nothing repaired) and is
 * lower-cased for ABI encoding, where case carries no meaning. The amount must
 * be the canonical, non-zero base-unit digit string the server issues (no sign,
 * no leading zero, no fraction). Null for anything else.
 */
function captureExpectedIntent(expected: unknown): { recipient: Address; amountBaseUnits: string } | null {
  if (!expected || typeof expected !== "object") return null;
  const { recipient, amountBaseUnits } = expected as { recipient?: unknown; amountBaseUnits?: unknown };
  if (typeof recipient !== "string" || typeof amountBaseUnits !== "string") return null;
  if (recipient !== recipient.trim()) return null;
  const canonicalRecipient = normalizeAddress(recipient);
  if (!canonicalRecipient) return null;
  if (!isCanonicalBaseUnitsString(amountBaseUnits) || isZeroBaseUnits(amountBaseUnits)) return null;
  return { recipient: canonicalRecipient as Address, amountBaseUnits };
}

export type SignedPreparedPayment = {
  signature: Hex;
  /** Turnkey's activity for the one passkey approval — sent to /submit as a locator the server verifies. */
  activityId: string;
};

/**
 * The one place a store/component touches signing for a payment: rebuilds
 * the identical Safe smart account object the server used to derive
 * `fields` (same owner, same public client construction) and calls its
 * `signUserOperation` — driving the already-proven Batch 2a pipeline
 * (createVerifiedTurnkeyOwnerAccount's self-verifying signTypedData: a
 * fresh WebAuthn ceremony every call, hashTypedData -> Turnkey
 * signRawPayload -> recoverTypedDataAddress, throwing on any mismatch)
 * followed by permissionless's own Safe4337 signature packing
 * (validAfter/validUntil prefixing). This is the exact path
 * test/lib/real/signing-chain.test.ts already proves end to end offline.
 *
 * A WebAuthn cancellation (lib/real/signing/passkey.ts's
 * isWebAuthnCancellation) or a VerifiedSignTypedDataError both reject from
 * here — the caller must treat either as "no signature, nothing to submit",
 * never call /submit for it.
 *
 * Re-derives account.address locally and checks it against fields.sender as
 * a cheap, local consistency check before ever asking for a signature — a
 * mismatch here means the server's prepared fields don't belong to this
 * owner, and signing must not proceed.
 *
 * Slice S1: the ceremony is pinned to `authorizingCredentialId` (no chooser
 * offering another passkey), and exactly one Turnkey approval must have
 * produced the signature — its activity id is returned for /submit. Still a
 * fresh WebAuthn ceremony per payment; nothing is kept or stored.
 *
 * L-1b: after the sender check, the exact Safe execution of
 * transfer(expected.recipient, expected.amountBaseUnits) on REAL_CASH_TOKEN
 * (value 0, CALL) is rebuilt by THIS account's own encoder — the same
 * algorithm the server used at prepare (server/pimlico.ts) — and must be
 * strictly equal to the prepared callData; that locally built value is what is
 * signed. A mismatch (or an unusable expected intent, or an encoding that
 * cannot complete) throws PAYMENT_DETAILS_UNVERIFIED before signUserOperation,
 * so no Turnkey request, WebAuthn prompt or signature is ever made for it.
 * This does not revoke a signature that already exists, and it checks only
 * the transfer content — not gas, fee, paymaster, factory, nonce or window.
 */
export async function signPreparedPayment(input: SignPreparedPaymentInput): Promise<SignedPreparedPayment> {
  if (!input.authorizingCredentialId) throw new Error("This payment has no approving passkey — refusing to sign.");
  // UX only (the server re-checks authoritatively): never spend a passkey
  // ceremony on a payment whose signed window would be too short to send.
  // nowSeconds defaults to raw Date.now() only when the caller has no
  // server-derived offset to apply (see SignPreparedPaymentInput.nowSeconds).
  if (!hasEnoughValidityToDispatch(input.fields.validUntil, input.nowSeconds ?? Math.floor(Date.now() / 1000))) {
    throw new Error(PAYMENT_EXPIRED_BEFORE_APPROVAL);
  }
  // L-1b: captured and validated synchronously, before any await below.
  const expected = captureExpectedIntent(input.expected);
  if (!expected) throw new Error(PAYMENT_DETAILS_UNVERIFIED);
  const fields = parsePreparedFieldsFromWire(input.fields);
  const publicClient = createRealPublicClient(input.rpcUrl);
  const activityIds: string[] = [];
  const owner = createVerifiedTurnkeyOwnerAccount({
    rpId: input.rpId,
    subOrganizationId: input.subOrganizationId,
    ownerAddress: input.ownerAddress,
    authorizingCredentialId: input.authorizingCredentialId,
    onTurnkeyActivity: (activityId) => activityIds.push(activityId),
  });
  // The window is server-chosen and signed exactly — never computed here.
  const account = await createRealSafeAccount({ owner, publicClient, validity: { validAfter: SAFE_OP_VALID_AFTER, validUntil: input.fields.validUntil } });

  if (account.address.toLowerCase() !== fields.sender.toLowerCase()) {
    throw new Error("The locally-derived Safe address does not match the prepared payment's sender — refusing to sign.");
  }

  // L-1b: the transfer this signature authorizes, rebuilt locally (no network
  // for a single call on this account configuration). Raw encoder errors are
  // never shown; any failure is the same fixed refusal.
  let expectedCallData: Hex;
  try {
    expectedCallData = await account.encodeCalls([{ to: REAL_CASH_TOKEN.address, data: encodeCashTransfer(expected.recipient, expected.amountBaseUnits), value: BigInt(0) }]);
  } catch {
    throw new Error(PAYMENT_DETAILS_UNVERIFIED);
  }
  // Strict, full-string equality — no case-folding, prefix or partial decode.
  if (fields.callData !== expectedCallData) throw new Error(PAYMENT_DETAILS_UNVERIFIED);

  const signature = await account.signUserOperation({
    sender: account.address as Address,
    nonce: fields.nonce,
    factory: fields.factory,
    factoryData: fields.factoryData,
    // L-1b: the verified, locally built value — never the response's string.
    callData: expectedCallData,
    callGasLimit: fields.callGasLimit,
    verificationGasLimit: fields.verificationGasLimit,
    preVerificationGas: fields.preVerificationGas,
    maxFeePerGas: fields.maxFeePerGas,
    maxPriorityFeePerGas: fields.maxPriorityFeePerGas,
    paymaster: fields.paymaster,
    paymasterData: fields.paymasterData,
    paymasterVerificationGasLimit: fields.paymasterVerificationGasLimit,
    paymasterPostOpGasLimit: fields.paymasterPostOpGasLimit,
    // Required by the param type, ignored by signUserOperation's own logic
    // (it computes the real signature) — same as
    // signing-chain.test.ts's preparedOperation.signature.
    signature: "0x" as Hex,
  });
  if (activityIds.length !== 1) throw new Error("Expected exactly one passkey approval for this payment — refusing to submit.");
  return { signature, activityId: activityIds[0]! };
}
