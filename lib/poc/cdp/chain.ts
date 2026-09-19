import { createPublicClient, erc20Abi, http, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { BASE_SEPOLIA_CHAIN_ID, USDC_ADDRESS } from "./constants";

/**
 * Read-only Base Sepolia access for the PoC via viem. No signing happens
 * here — the smart account signs through CDP. Disposable diagnostic code.
 */

if (baseSepolia.id !== BASE_SEPOLIA_CHAIN_ID) {
  // Guards against a viem upgrade silently changing what "baseSepolia" means.
  throw new Error(`viem baseSepolia chain id ${baseSepolia.id} != expected ${BASE_SEPOLIA_CHAIN_ID}`);
}

// Base Sepolia is an OP-stack chain with its own formatters (e.g. deposit
// transactions), so its client type is narrower than viem's bare PublicClient.
// Derive the type from the factory instead of naming it.
function buildClient(rpcUrl: string | null) {
  return createPublicClient({ chain: baseSepolia, transport: http(rpcUrl ?? undefined) });
}
type BaseSepoliaClient = ReturnType<typeof buildClient>;

let client: BaseSepoliaClient | null = null;
let clientRpcUrl: string | null | undefined;

export function getBaseSepoliaClient(rpcUrl: string | null): BaseSepoliaClient {
  if (!client || clientRpcUrl !== rpcUrl) {
    client = buildClient(rpcUrl);
    clientRpcUrl = rpcUrl;
  }
  return client;
}

export type AccountChainState = {
  chainId: number;
  /** The chain id the RPC actually reports, so a misconfigured RPC is visible. */
  rpcChainId: number;
  ethWei: bigint;
  usdcBaseUnits: bigint;
  /** Whether contract code exists at the smart-account address (ERC-4337 accounts deploy on first user op). */
  isDeployed: boolean;
  blockNumber: bigint;
};

export async function readAccountChainState(address: Address, rpcUrl: string | null): Promise<AccountChainState> {
  const c = getBaseSepoliaClient(rpcUrl);
  const [rpcChainId, ethWei, usdcBaseUnits, code, blockNumber] = await Promise.all([
    c.getChainId(),
    c.getBalance({ address }),
    c.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    c.getCode({ address }),
    c.getBlockNumber(),
  ]);
  return {
    chainId: BASE_SEPOLIA_CHAIN_ID,
    rpcChainId,
    ethWei,
    usdcBaseUnits,
    isDeployed: code !== undefined && code !== "0x",
    blockNumber,
  };
}

export type ChainReceiptSummary = {
  status: "success" | "reverted";
  blockNumber: bigint;
  gasUsed: bigint;
  from: Address;
  to: Address | null;
  /** Number of logs, as a coarse sign the ERC-20 Transfer event fired. */
  logCount: number;
};

/** Independent confirmation of a transaction hash straight from the chain, not via CDP. */
export async function readTransactionReceipt(hash: Hex, rpcUrl: string | null): Promise<ChainReceiptSummary | null> {
  const c = getBaseSepoliaClient(rpcUrl);
  try {
    const r = await c.getTransactionReceipt({ hash });
    return {
      status: r.status,
      blockNumber: r.blockNumber,
      gasUsed: r.gasUsed,
      from: r.from,
      to: r.to ?? null,
      logCount: r.logs.length,
    };
  } catch (error) {
    // viem throws TransactionReceiptNotFoundError while pending.
    if (error instanceof Error && /not.*found|could not be found/i.test(error.message)) return null;
    throw error;
  }
}

export { USDC_ADDRESS };
