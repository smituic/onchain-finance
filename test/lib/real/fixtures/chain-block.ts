/**
 * A minimal JSON-RPC block for offline `custom(...)` transports, so
 * resolvePreparePayment's chain-clock read (chain/entry-point.ts's
 * readLatestBlockClock) can be answered without a live RPC. The default
 * timestamp is "now" because the browser signing path checks the resulting
 * validUntil against the real clock.
 */
export const TEST_PREPARE_BLOCK_NUMBER = BigInt(47_000_000);

export function rpcBlock(input: { number?: bigint; timestamp?: bigint } = {}) {
  const number = input.number ?? TEST_PREPARE_BLOCK_NUMBER;
  const timestamp = input.timestamp ?? BigInt(Math.floor(Date.now() / 1000));
  return {
    number: `0x${number.toString(16)}`,
    timestamp: `0x${timestamp.toString(16)}`,
    hash: `0x${"ab".repeat(32)}`,
    parentHash: `0x${"cd".repeat(32)}`,
    baseFeePerGas: "0x1",
    gasLimit: "0x1c9c380",
    gasUsed: "0x0",
    transactions: [],
  };
}
