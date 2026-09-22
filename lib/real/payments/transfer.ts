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
 * The one place ERC-20 transfer calldata is built for a Cash payment. Both
 * `prepare` (constructing the real call) and `submit` (reconstructing the
 * expected calldata to compare against, independent of anything the client
 * sends) call this same function — there is no second implementation for
 * either side to silently drift from. amountBaseUnits is a decimal string
 * (see amount.ts); it is converted to a BigInt only here, at the boundary to
 * viem's ABI encoder, never earlier.
 */
export function encodeCashTransfer(recipient: Address, amountBaseUnits: string): Hex {
  return encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: "transfer",
    args: [recipient, BigInt(amountBaseUnits)],
  });
}
