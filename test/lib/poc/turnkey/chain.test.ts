import { describe, expect, it } from "vitest";
import { computeBlockWindows } from "@/lib/poc/turnkey/server/chain";

describe("computeBlockWindows", () => {
  it("splits a range wider than maxRange into consecutive, non-overlapping windows", () => {
    // Regression: /api/dev/turnkey-poc/history returned HTTP 500 on every
    // call because it queried eth_getLogs over a single 50,000-block range.
    // Base's hosted RPC rejects any eth_getLogs span over 10,000 blocks
    // (error -32614), so that request always failed — whether or not any
    // transfers existed.
    const windows = computeBlockWindows(BigInt(0), BigInt(25_000), BigInt(10_000));
    expect(windows).toEqual([
      { fromBlock: BigInt(0), toBlock: BigInt(9_999) },
      { fromBlock: BigInt(10_000), toBlock: BigInt(19_999) },
      { fromBlock: BigInt(20_000), toBlock: BigInt(25_000) },
    ]);
    // No window ever exceeds the provider's maximum span.
    for (const window of windows) {
      expect(window.toBlock - window.fromBlock + BigInt(1)).toBeLessThanOrEqual(BigInt(10_000));
    }
  });

  it("returns a single window when the range already fits", () => {
    expect(computeBlockWindows(BigInt(100), BigInt(200), BigInt(10_000))).toEqual([
      { fromBlock: BigInt(100), toBlock: BigInt(200) },
    ]);
  });

  it("returns a single window covering exactly one block", () => {
    expect(computeBlockWindows(BigInt(42), BigInt(42), BigInt(10_000))).toEqual([{ fromBlock: BigInt(42), toBlock: BigInt(42) }]);
  });

  it("returns no windows when fromBlock is after toBlock", () => {
    expect(computeBlockWindows(BigInt(50), BigInt(10), BigInt(10_000))).toEqual([]);
  });

  it("rejects a non-positive maxRange instead of looping forever", () => {
    expect(() => computeBlockWindows(BigInt(0), BigInt(100), BigInt(0))).toThrow();
    expect(() => computeBlockWindows(BigInt(0), BigInt(100), BigInt(-1))).toThrow();
  });
});
