import { createPublicClient, erc20Abi, http, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { CASH_USDC } from "../constants";
import type { ServerTurnkeyPocConfig } from "../config";

export function createServerPublicClient(config: ServerTurnkeyPocConfig) {
  return createPublicClient({
    chain: baseSepolia,
    transport: http(config.rpcUrl),
  });
}

export async function readPocBalances(input: {
  config: ServerTurnkeyPocConfig;
  ownerAddress: Address;
  safeAddress: Address;
  recipient?: Address;
}) {
  const client = createServerPublicClient(input.config);
  const [ownerEth, safeEth, ownerUsdc, safeUsdc, safeCode, recipientUsdc] = await Promise.all([
    client.getBalance({ address: input.ownerAddress }),
    client.getBalance({ address: input.safeAddress }),
    client.readContract({
      address: CASH_USDC.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [input.ownerAddress],
    }),
    client.readContract({
      address: CASH_USDC.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [input.safeAddress],
    }),
    client.getCode({ address: input.safeAddress }),
    input.recipient
      ? client.readContract({
          address: CASH_USDC.address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [input.recipient],
        })
      : Promise.resolve(null),
  ]);

  return {
    chainId: baseSepolia.id,
    ownerEth: ownerEth.toString(),
    safeEth: safeEth.toString(),
    ownerUsdc: ownerUsdc.toString(),
    safeUsdc: safeUsdc.toString(),
    recipientUsdc: recipientUsdc === null ? null : recipientUsdc.toString(),
    safeDeployed: Boolean(safeCode && safeCode !== "0x"),
    safeBytecode: (safeCode && safeCode !== "0x" ? safeCode : null) as Hex | null,
  };
}

const transferEvent = erc20Abi.find((item) => item.type === "event" && item.name === "Transfer");

// Base's hosted public RPC (the default for this PoC — see config.ts) rejects
// any eth_getLogs call spanning more than 10,000 blocks with error -32614
// ("eth_getLogs is limited to a 10,000 range"). A 50,000-block lookback in a
// single request always exceeded that and made /history fail on every call,
// with or without any matching transfers. Query in <=10,000-block windows
// instead so this works against Base's own default RPC.
const MAX_GET_LOGS_BLOCK_RANGE = BigInt(10_000);
const USDC_HISTORY_LOOKBACK_BLOCKS = BigInt(50_000);

/** Pure — splits [fromBlock, toBlock] into inclusive windows no wider than maxRange. Exported for direct testing. */
export function computeBlockWindows(fromBlock: bigint, toBlock: bigint, maxRange: bigint): Array<{ fromBlock: bigint; toBlock: bigint }> {
  if (maxRange <= BigInt(0)) throw new Error("maxRange must be positive.");
  if (fromBlock > toBlock) return [];

  const windows: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = start + maxRange - BigInt(1) < toBlock ? start + maxRange - BigInt(1) : toBlock;
    windows.push({ fromBlock: start, toBlock: end });
    start = end + BigInt(1);
  }
  return windows;
}

async function getLogsWindowed(
  client: ReturnType<typeof createServerPublicClient>,
  params: {
    address: Address;
    event: NonNullable<typeof transferEvent>;
    args: Record<string, Address>;
    fromBlock: bigint;
    toBlock: bigint;
  },
) {
  const windows = computeBlockWindows(params.fromBlock, params.toBlock, MAX_GET_LOGS_BLOCK_RANGE);
  const chunks = await Promise.all(
    windows.map((window) =>
      client.getLogs({
        address: params.address,
        event: params.event,
        args: params.args,
        fromBlock: window.fromBlock,
        toBlock: window.toBlock,
      }),
    ),
  );
  return chunks.flat();
}

export async function readUsdcHistory(input: {
  config: ServerTurnkeyPocConfig;
  safeAddress: Address;
}) {
  if (!transferEvent || transferEvent.type !== "event") return [];
  const client = createServerPublicClient(input.config);
  const latest = await client.getBlockNumber();
  const fromBlock = latest > USDC_HISTORY_LOOKBACK_BLOCKS ? latest - USDC_HISTORY_LOOKBACK_BLOCKS : BigInt(0);

  const [outgoing, incoming] = await Promise.all([
    getLogsWindowed(client, { address: CASH_USDC.address, event: transferEvent, args: { from: input.safeAddress }, fromBlock, toBlock: latest }),
    getLogsWindowed(client, { address: CASH_USDC.address, event: transferEvent, args: { to: input.safeAddress }, fromBlock, toBlock: latest }),
  ]);

  return [...outgoing, ...incoming]
    .map((log) => ({
      direction: log.args.from?.toLowerCase() === input.safeAddress.toLowerCase() ? "outgoing" : "incoming",
      from: log.args.from,
      to: log.args.to,
      value: log.args.value?.toString() ?? "0",
      transactionHash: log.transactionHash,
      blockNumber: log.blockNumber.toString(),
    }))
    .sort((a, b) => Number(b.blockNumber) - Number(a.blockNumber));
}
