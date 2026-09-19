import { describe, expect, it } from "vitest";
import { formatEth, formatUsdcAmount, parseUsdcAmount } from "@/lib/poc/cdp/usdc-amount";

describe("parseUsdcAmount", () => {
  it("parses whole and fractional amounts into 6-decimal base units", () => {
    expect(parseUsdcAmount("1")).toBe(BigInt(1_000_000));
    expect(parseUsdcAmount("0.10")).toBe(BigInt(100_000));
    expect(parseUsdcAmount("0.000001")).toBe(BigInt(1));
    expect(parseUsdcAmount("123.456789")).toBe(BigInt(123_456_789));
    expect(parseUsdcAmount("  2.5 ")).toBe(BigInt(2_500_000));
  });

  it("parses zero (the caller decides whether zero is allowed)", () => {
    expect(parseUsdcAmount("0")).toBe(BigInt(0));
  });

  it("rejects malformed, negative, or over-precise input", () => {
    expect(parseUsdcAmount("")).toBeNull();
    expect(parseUsdcAmount("-1")).toBeNull();
    expect(parseUsdcAmount("1e3")).toBeNull();
    expect(parseUsdcAmount("1,000")).toBeNull();
    expect(parseUsdcAmount("0.0000001")).toBeNull();
    expect(parseUsdcAmount(".5")).toBeNull();
    expect(parseUsdcAmount("abc")).toBeNull();
  });

  it("handles amounts far beyond Number precision exactly", () => {
    expect(parseUsdcAmount("123456789012345678.123456")).toBe(BigInt("123456789012345678123456"));
  });
});

describe("formatUsdcAmount", () => {
  it("shows at least two decimals and trims beyond that", () => {
    expect(formatUsdcAmount(BigInt(1_000_000))).toBe("1.00");
    expect(formatUsdcAmount(BigInt(100_000))).toBe("0.10");
    expect(formatUsdcAmount(BigInt(1))).toBe("0.000001");
    expect(formatUsdcAmount(BigInt(123_456_789))).toBe("123.456789");
    expect(formatUsdcAmount(BigInt(0))).toBe("0.00");
  });

  it("round-trips with the parser", () => {
    for (const s of ["0.10", "7.00", "0.000001", "1000.25"]) {
      expect(formatUsdcAmount(parseUsdcAmount(s)!)).toBe(s);
    }
  });

  it("formats negatives (defensive; balances are never negative)", () => {
    expect(formatUsdcAmount(BigInt(-1_500_000))).toBe("-1.50");
  });
});

describe("formatEth", () => {
  it("formats wei with trailing zeros trimmed", () => {
    expect(formatEth(BigInt(0))).toBe("0");
    expect(formatEth(BigInt("1000000000000000000"))).toBe("1");
    expect(formatEth(BigInt("1500000000000000"))).toBe("0.0015");
    expect(formatEth(BigInt(1))).toBe("0.000000000000000001");
  });
});
