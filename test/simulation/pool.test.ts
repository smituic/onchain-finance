import { describe, expect, it } from "vitest";
import { createInitialPoolReserves, getPoolSpotPriceMicroUsd, toMicroUnits } from "@/simulation";

describe("createInitialPoolReserves", () => {
  it("starts at exactly 75,000 USDC / 25 ETH", () => {
    const reserves = createInitialPoolReserves();
    expect(reserves.USDC).toBe(toMicroUnits(75_000));
    expect(reserves.ETH).toBe(toMicroUnits(25));
  });
});

describe("getPoolSpotPriceMicroUsd", () => {
  it("is exactly $3,000/ETH at genesis reserves", () => {
    const price = getPoolSpotPriceMicroUsd({ reserves: createInitialPoolReserves() });
    expect(price).toBe(3_000_000_000);
  });

  it("rises when USDC reserves grow relative to ETH", () => {
    const price = getPoolSpotPriceMicroUsd({
      reserves: { USDC: toMicroUnits(150_000), ETH: toMicroUnits(25) },
    });
    expect(price).toBe(6_000_000_000);
  });
});
