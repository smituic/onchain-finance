/**
 * Privy PoC — Base Sepolia chain reads via viem. DISPOSABLE (see config.ts).
 *
 * Reads only. These are independent of Privy's session on purpose: after a
 * reload, a sign-out, or a Privy outage, a pending payment can still be
 * reconciled from the chain by hash, and balances/code can be checked for
 * any address.
 */
import { createPublicClient, encodeFunctionData, erc20Abi, http, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC_ADDRESS } from "./config";
import { classifyAccountCode, type AccountCodeStatus, type HexHash } from "./identifiers";
import type { ReceiptLookup } from "./send-status";

export type ChainReader = {
  chainId: number;
  readEthBalance: (address: Address) => Promise<bigint>;
  readUsdcBalance: (address: Address) => Promise<bigint>;
  readAccountCode: (address: Address) => Promise<AccountCodeStatus>;
  lookupReceipt: (hash: HexHash) => Promise<ReceiptLookup>;
};

export function createChainReader(rpcUrl: string): ChainReader {
  if (baseSepolia.id !== BASE_SEPOLIA_CHAIN_ID) {
    // Defensive: viem's chain definition must match the decided network.
    throw new Error(`viem baseSepolia.id (${baseSepolia.id}) != ${BASE_SEPOLIA_CHAIN_ID}`);
  }
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });

  return {
    chainId: baseSepolia.id,
    readEthBalance: (address) => client.getBalance({ address }),
    readUsdcBalance: (address) =>
      client.readContract({
        address: BASE_SEPOLIA_USDC_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      }),
    readAccountCode: async (address) => classifyAccountCode(await client.getCode({ address })),
    lookupReceipt: async (hash) => {
      try {
        const receipt = await client.getTransactionReceipt({ hash });
        return { kind: "found", status: receipt.status, blockNumber: receipt.blockNumber, from: receipt.from };
      } catch (error) {
        // viem throws TransactionReceiptNotFoundError while the tx is unmined.
        const name = (error as { name?: string })?.name ?? "";
        if (name === "TransactionReceiptNotFoundError") return { kind: "not-found" };
        return { kind: "error", message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/** ABI-encode `transfer(to, amount)` for the USDC contract. */
export function encodeUsdcTransfer(to: Address, amountBaseUnits: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amountBaseUnits] });
}

/** Format wei as ETH for display only (never used for financial decisions). */
const WEI_PER_ETH = BigInt(10) ** BigInt(18);

export function formatEthForDisplay(wei: bigint): string {
  const whole = wei / WEI_PER_ETH;
  const fraction = (wei % WEI_PER_ETH).toString().padStart(18, "0").slice(0, 8).replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}
