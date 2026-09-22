import { encodeFunctionData, type Address, type Hex } from "viem";

const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/**
 * The one place ERC-20 transfer calldata is built for a Cash payment — called
 * only during `prepare` (server/pimlico.ts's prepareCashTransferUserOperation),
 * never during `submit`. Submit-time (server/payments.ts's toPreparedFields)
 * reuses the persisted `callData` verbatim; it never re-derives or recomputes
 * it from `recipient`/`amountBaseUnits`. What submit independently
 * re-verifies instead is the UserOperation hash/signature over that
 * persisted calldata (see lib/real/payments/submit.ts). amountBaseUnits is a
 * decimal string (see amount.ts); it is converted to a BigInt only here, at
 * the boundary to viem's ABI encoder, never earlier.
 */
export function encodeCashTransfer(recipient: Address, amountBaseUnits: string): Hex {
  return encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: "transfer",
    args: [recipient, BigInt(amountBaseUnits)],
  });
}
