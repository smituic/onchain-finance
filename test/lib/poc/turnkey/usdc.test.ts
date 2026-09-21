import { describe, expect, it } from "vitest";
import { formatUsdcFromUnits, parseUsdcToUnits } from "@/lib/poc/turnkey/usdc";

describe("USDC / Cash parsing", () => {
  it("parses 0.10 USDC as 100000 base units", () => {
    expect(parseUsdcToUnits("0.10")).toBe(BigInt(100000));
    expect(parseUsdcToUnits("0.1")).toBe(BigInt(100000));
  });

  it("rejects over-precise or malformed amounts", () => {
    expect(parseUsdcToUnits("0.1234567")).toBeNull();
    expect(parseUsdcToUnits("-0.10")).toBeNull();
    expect(parseUsdcToUnits("1e2")).toBeNull();
    expect(parseUsdcToUnits("")).toBeNull();
  });

  it("formats base units back without floating point", () => {
    expect(formatUsdcFromUnits(BigInt(100000))).toBe("0.1");
    expect(formatUsdcFromUnits(BigInt(0))).toBe("0");
  });
});
