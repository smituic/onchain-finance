import type { AssetId } from "./types";

export type AssetDefinition = {
  id: AssetId;
  symbol: string;
  name: string;
  /**
   * Fixed simulated price in micro-USD per whole unit of the asset. Static
   * for Phase 1 — not fetched, not time-varying. BigInt so swap math can
   * multiply without risking float error or exceeding Number's safe range.
   */
  priceMicroUsd: bigint;
};

export const ASSETS: Record<AssetId, AssetDefinition> = {
  USDC: {
    id: "USDC",
    symbol: "USDC",
    name: "USD Coin (simulated)",
    // BigInt(...) rather than a 1_000_000n literal: this project's tsconfig
    // targets ES2017, which supports the BigInt type but not literal syntax.
    priceMicroUsd: BigInt(1_000_000),
  },
  ETH: {
    id: "ETH",
    symbol: "ETH",
    name: "Ethereum (simulated)",
    priceMicroUsd: BigInt(3_000_000_000),
  },
};
