import type { Address, Hex } from "viem";
import { createRealPublicClient } from "../chain/client";
import { createRealSafeAccount } from "../account/safe";
import { createVerifiedTurnkeyOwnerAccount } from "../signing/verified-account";
import { parsePreparedFieldsFromWire, type WirePreparedFields } from "./prepared-operation";
import { hasEnoughValidityToDispatch, SAFE_OP_VALID_AFTER } from "./validity";

export const PAYMENT_EXPIRED_BEFORE_APPROVAL = "This payment expired before it was approved. Nothing was sent — start a new payment.";

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
 */
export async function signPreparedPayment(input: SignPreparedPaymentInput): Promise<Hex> {
  // UX only (the server re-checks authoritatively): never spend a passkey
  // ceremony on a payment whose signed window would be too short to send.
  if (!hasEnoughValidityToDispatch(input.fields.validUntil, Math.floor(Date.now() / 1000))) {
    throw new Error(PAYMENT_EXPIRED_BEFORE_APPROVAL);
  }
  const fields = parsePreparedFieldsFromWire(input.fields);
  const publicClient = createRealPublicClient(input.rpcUrl);
  const owner = createVerifiedTurnkeyOwnerAccount({
    rpId: input.rpId,
    subOrganizationId: input.subOrganizationId,
    ownerAddress: input.ownerAddress,
  });
  // The window is server-chosen and signed exactly — never computed here.
  const account = await createRealSafeAccount({ owner, publicClient, validity: { validAfter: SAFE_OP_VALID_AFTER, validUntil: input.fields.validUntil } });

  if (account.address.toLowerCase() !== fields.sender.toLowerCase()) {
    throw new Error("The locally-derived Safe address does not match the prepared payment's sender — refusing to sign.");
  }

  return account.signUserOperation({
    sender: account.address as Address,
    nonce: fields.nonce,
    factory: fields.factory,
    factoryData: fields.factoryData,
    callData: fields.callData,
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
}
