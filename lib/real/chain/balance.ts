import type { Address } from "viem";
import { BASE_SEPOLIA_CHAIN_ID, REAL_CASH_TOKEN } from "../constants";
import type { RealPublicClient } from "./client";

const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

export type CashBalance = {
  token: "USDC";
  decimals: number;
  /** Exact base-unit amount (uint256, as returned by balanceOf) — a decimal string, never a float. */
  balanceBaseUnits: string;
};

/**
 * A read-only ERC20 balance read for the CASH token, scoped to Base
 * Sepolia and the configured Circle testnet USDC contract — both fixed by
 * REAL_CASH_TOKEN, never by a caller-supplied address. No signing, no
 * Turnkey, no Pimlico, no UserOperation: this only ever calls
 * PublicClient.getChainId/readContract.
 *
 * Validates the RPC endpoint is actually Base Sepolia (a live getChainId
 * call, not just the locally-configured chain object, since a misconfigured
 * BASE_SEPOLIA_RPC_URL could silently point elsewhere) and that the
 * contract's own decimals() still matches REAL_CASH_TOKEN.decimals, so a
 * balance is never silently shown for the wrong network or token.
 */
export async function readCashBalance(input: { publicClient: RealPublicClient; safeAddress: Address }): Promise<CashBalance> {
  const chainId = await input.publicClient.getChainId();
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(`Expected Base Sepolia (chain id ${BASE_SEPOLIA_CHAIN_ID}), but the configured RPC reports chain id ${chainId}.`);
  }

  const [balanceBaseUnits, decimals] = await Promise.all([
    input.publicClient.readContract({
      address: REAL_CASH_TOKEN.address,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [input.safeAddress],
    }),
    input.publicClient.readContract({
      address: REAL_CASH_TOKEN.address,
      abi: ERC20_BALANCE_ABI,
      functionName: "decimals",
    }),
  ]);

  if (decimals !== REAL_CASH_TOKEN.decimals) {
    throw new Error(`Expected ${REAL_CASH_TOKEN.decimals}-decimal USDC, but the contract reports ${decimals} decimals.`);
  }

  return { token: REAL_CASH_TOKEN.symbol, decimals, balanceBaseUnits: balanceBaseUnits.toString() };
}
