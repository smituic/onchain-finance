import { describe, expect, it } from "vitest";
import { createInitialState } from "@/simulation";

describe("createInitialState", () => {
  it("starts with exactly $10,000 in USDC", () => {
    const state = createInitialState();
    expect(state.balances.USDC).toBe(10_000_000_000);
  });

  it("starts with zero ETH", () => {
    const state = createInitialState();
    expect(state.balances.ETH).toBe(0);
  });

  it("has only non-negative integer balances", () => {
    const state = createInitialState();
    for (const balance of Object.values(state.balances)) {
      expect(Number.isInteger(balance)).toBe(true);
      expect(balance).toBeGreaterThanOrEqual(0);
    }
  });
});
