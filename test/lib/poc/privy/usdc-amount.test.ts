import { describe, expect, it } from "vitest";
import { formatUsdcAmount, parseUsdcAmount } from "@/lib/poc/privy/usdc-amount";

describe("parseUsdcAmount", () => {
  it("parses the PoC test amount exactly", () => {
    expect(parseUsdcAmount("0.10")).toEqual({ ok: true, baseUnits: BigInt(100000) });
    expect(parseUsdcAmount("0.1")).toEqual({ ok: true, baseUnits: BigInt(100000) });
    expect(parseUsdcAmount(".1")).toEqual({ ok: false, error: "Use digits and at most one decimal point." });
  });

  it("handles whole numbers, full precision and whitespace", () => {
    expect(parseUsdcAmount("1")).toEqual({ ok: true, baseUnits: BigInt(1000000) });
    expect(parseUsdcAmount(" 12.345678 ")).toEqual({ ok: true, baseUnits: BigInt(12345678) });
    expect(parseUsdcAmount("0.000001")).toEqual({ ok: true, baseUnits: BigInt(1) });
  });

  it("never goes through floating point (values that would round badly)", () => {
    expect(parseUsdcAmount("0.3")).toEqual({ ok: true, baseUnits: BigInt(300000) });
    expect(parseUsdcAmount("1.1")).toEqual({ ok: true, baseUnits: BigInt(1100000) });
    expect(parseUsdcAmount("123456789012345.678901")).toEqual({ ok: true, baseUnits: BigInt("123456789012345678901") });
  });

  it("rejects too many decimals, zero, negatives, and junk", () => {
    expect(parseUsdcAmount("0.1234567").ok).toBe(false);
    expect(parseUsdcAmount("0").ok).toBe(false);
    expect(parseUsdcAmount("0.000000").ok).toBe(false);
    expect(parseUsdcAmount("-1").ok).toBe(false);
    expect(parseUsdcAmount("1e6").ok).toBe(false);
    expect(parseUsdcAmount("").ok).toBe(false);
    expect(parseUsdcAmount("1,000").ok).toBe(false);
  });
});

describe("formatUsdcAmount", () => {
  it("formats base units as money-like decimals", () => {
    expect(formatUsdcAmount(BigInt(100000))).toBe("0.10");
    expect(formatUsdcAmount(BigInt(0))).toBe("0.00");
    expect(formatUsdcAmount(BigInt(1))).toBe("0.000001");
    expect(formatUsdcAmount(BigInt(12345678))).toBe("12.345678");
    expect(formatUsdcAmount(BigInt(5000000))).toBe("5.00");
    expect(formatUsdcAmount(BigInt(-250000))).toBe("-0.25");
  });

  it("round-trips through parse", () => {
    for (const s of ["0.10", "3.00", "0.000001", "999999.999999"]) {
      const parsed = parseUsdcAmount(s);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(formatUsdcAmount(parsed.baseUnits)).toBe(s);
    }
  });
});
