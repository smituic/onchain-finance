import { BASE_SEPOLIA_CHAIN_ID, CASH_USDC } from "./constants";
import { normalizeAddress } from "./identifiers";
import { parseUsdcToUnits } from "./usdc";

export type PaymentRequestIdentity = {
  chainId: number;
  token: string;
  recipient: string;
  amountUnits: string;
};

export function canonicalPaymentRequest(input: {
  chainId?: number;
  token?: string;
  recipient: string;
  amountUsdc: string;
}): PaymentRequestIdentity | null {
  const recipient = normalizeAddress(input.recipient);
  const amount = parseUsdcToUnits(input.amountUsdc);
  const token = normalizeAddress(input.token ?? CASH_USDC.address);
  const chainId = input.chainId ?? BASE_SEPOLIA_CHAIN_ID;
  if (!recipient || amount === null || !token) return null;
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) return null;
  return {
    chainId,
    token,
    recipient,
    amountUnits: amount.toString(),
  };
}

export function paymentRequestsEqual(a: PaymentRequestIdentity, b: PaymentRequestIdentity): boolean {
  return (
    a.chainId === b.chainId &&
    a.token === b.token &&
    a.recipient === b.recipient &&
    a.amountUnits === b.amountUnits
  );
}

export function describePaymentMutation(
  authorized: PaymentRequestIdentity,
  attempted: PaymentRequestIdentity,
): string[] {
  const changes: string[] = [];
  if (authorized.recipient !== attempted.recipient) changes.push("recipient");
  if (authorized.amountUnits !== attempted.amountUnits) changes.push("amount");
  if (authorized.chainId !== attempted.chainId) changes.push("chain");
  if (authorized.token !== attempted.token) changes.push("token");
  return changes;
}
