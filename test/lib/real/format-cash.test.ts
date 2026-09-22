import { describe, expect, it } from "vitest";
import { formatCashBaseUnits } from "@/lib/real/display/cash";

describe("formatCashBaseUnits", () => {
  it("formats a zero balance as $0.00", () => {
    expect(formatCashBaseUnits("0", 6)).toBe("$0.00");
  });

  it("formats a whole-dollar 6-decimal USDC amount", () => {
    expect(formatCashBaseUnits("20000000", 6)).toBe("$20.00");
  });

  it("formats a sub-dollar 6-decimal amount", () => {
    expect(formatCashBaseUnits("500000", 6)).toBe("$0.50");
  });

  it("formats a large balance with thousands separators", () => {
    expect(formatCashBaseUnits("1234567890000", 6)).toBe("$1,234,567.89");
  });

  it("rounds sub-cent dust down when below half a cent", () => {
    expect(formatCashBaseUnits("1", 6)).toBe("$0.00"); // $0.000001
  });

  it("rounds half a cent up (round-half-up)", () => {
    expect(formatCashBaseUnits("15000", 6)).toBe("$0.02"); // $0.015 -> $0.02
  });

  it("never routes the amount through a float — an amount beyond Number.MAX_SAFE_INTEGER base units still formats exactly", () => {
    // 2^53 - 1 = 9007199254740991; add enough extra base units that a
    // float would lose precision, and confirm the exact expected string.
    expect(formatCashBaseUnits("9007199254740993000000", 6)).toBe("$9,007,199,254,740,993.00");
  });

  it("throws on a non-integer-string input rather than silently coercing", () => {
    expect(() => formatCashBaseUnits("12.5", 6)).toThrow();
    expect(() => formatCashBaseUnits("-5", 6)).toThrow();
    expect(() => formatCashBaseUnits("abc", 6)).toThrow();
  });

  it("throws on an invalid decimals value", () => {
    expect(() => formatCashBaseUnits("100", -1)).toThrow();
    expect(() => formatCashBaseUnits("100", 1.5)).toThrow();
  });
});
