import { describe, expect, it } from "vitest";
import {
  exceedsAvailableBalance,
  exceedsPaymentCeiling,
  isCanonicalBaseUnitsString,
  isZeroBaseUnits,
  MAX_PAYMENT_BASE_UNITS,
  parseCashInputToBaseUnits,
} from "@/lib/real/payments/amount";

describe("parseCashInputToBaseUnits", () => {
  it("parses a valid 6-decimal amount into base units", () => {
    expect(parseCashInputToBaseUnits("12.345678")).toBe("12345678");
  });

  it("parses a whole-dollar amount", () => {
    expect(parseCashInputToBaseUnits("20")).toBe("20000000");
  });

  it("parses zero shape-wise (rejecting zero is the caller's job)", () => {
    expect(parseCashInputToBaseUnits("0")).toBe("0");
    expect(isZeroBaseUnits(parseCashInputToBaseUnits("0")!)).toBe(true);
    expect(isZeroBaseUnits(parseCashInputToBaseUnits("0.00")!)).toBe(true);
  });

  it("rejects a negative amount", () => {
    expect(parseCashInputToBaseUnits("-5")).toBeNull();
    expect(parseCashInputToBaseUnits("-0.01")).toBeNull();
  });

  it("rejects more than 6 fractional decimals", () => {
    expect(parseCashInputToBaseUnits("1.1234567")).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(parseCashInputToBaseUnits("")).toBeNull();
    expect(parseCashInputToBaseUnits("abc")).toBeNull();
    expect(parseCashInputToBaseUnits("1.2.3")).toBeNull();
    expect(parseCashInputToBaseUnits("1e5")).toBeNull();
    expect(parseCashInputToBaseUnits("$5")).toBeNull();
  });

  it("never routes the amount through parseFloat or a JS number for large values", () => {
    // 6 decimals of a value well past Number.MAX_SAFE_INTEGER when scaled —
    // parseFloat/Number-based math would silently lose precision here.
    const result = parseCashInputToBaseUnits("90071992547409.99");
    expect(result).toBe("90071992547409990000");
  });
});

describe("isCanonicalBaseUnitsString", () => {
  it("accepts exactly what parseCashInputToBaseUnits produces", () => {
    expect(isCanonicalBaseUnitsString("0")).toBe(true);
    expect(isCanonicalBaseUnitsString("20000000")).toBe(true);
  });

  it("rejects leading zeros, signs, and decimals", () => {
    expect(isCanonicalBaseUnitsString("00")).toBe(false);
    expect(isCanonicalBaseUnitsString("01")).toBe(false);
    expect(isCanonicalBaseUnitsString("-1")).toBe(false);
    expect(isCanonicalBaseUnitsString("1.5")).toBe(false);
    expect(isCanonicalBaseUnitsString("")).toBe(false);
  });
});

describe("exceedsPaymentCeiling", () => {
  it("$50.00 exactly is allowed, one base unit over is not", () => {
    expect(MAX_PAYMENT_BASE_UNITS).toBe("50000000");
    expect(exceedsPaymentCeiling("50000000")).toBe(false);
    expect(exceedsPaymentCeiling("50000001")).toBe(true);
  });

  it("a small amount never exceeds the ceiling", () => {
    expect(exceedsPaymentCeiling("1")).toBe(false);
  });
});

describe("exceedsAvailableBalance", () => {
  it("an amount equal to the balance is allowed", () => {
    expect(exceedsAvailableBalance("20000000", "20000000")).toBe(false);
  });

  it("an amount greater than the balance is rejected", () => {
    expect(exceedsAvailableBalance("20000001", "20000000")).toBe(true);
  });

  it("compares by numeric magnitude, not string length coincidence", () => {
    expect(exceedsAvailableBalance("999999999", "1000000000")).toBe(false);
    expect(exceedsAvailableBalance("1000000000", "999999999")).toBe(true);
  });
});
