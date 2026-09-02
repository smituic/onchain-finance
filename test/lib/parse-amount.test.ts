import { describe, expect, it } from "vitest";
import { parseAmountToMicroUnits } from "@/lib/parse-amount";

describe("parseAmountToMicroUnits", () => {
  it("parses whole numbers", () => {
    expect(parseAmountToMicroUnits("100")).toBe(100_000_000);
  });

  it("parses a small fractional amount exactly", () => {
    expect(parseAmountToMicroUnits("0.1")).toBe(100_000);
  });

  it("parses the smallest representable unit exactly", () => {
    expect(parseAmountToMicroUnits("0.000001")).toBe(1);
  });

  it("parses a value using all 6 fractional digits exactly", () => {
    expect(parseAmountToMicroUnits("123.456789")).toBe(123_456_789);
  });

  it("parses zero successfully — the engine rejects zero-value swaps, not the parser", () => {
    expect(parseAmountToMicroUnits("0")).toBe(0);
  });

  it("trims surrounding whitespace", () => {
    expect(parseAmountToMicroUnits("  12  ")).toBe(12_000_000);
  });

  it("rejects empty input", () => {
    expect(parseAmountToMicroUnits("")).toBeNull();
    expect(parseAmountToMicroUnits("   ")).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(parseAmountToMicroUnits("abc")).toBeNull();
    expect(parseAmountToMicroUnits("1.2.3")).toBeNull();
    expect(parseAmountToMicroUnits("5.")).toBeNull();
    expect(parseAmountToMicroUnits("1e5")).toBeNull();
    expect(parseAmountToMicroUnits("$5")).toBeNull();
  });

  it("rejects negative input", () => {
    expect(parseAmountToMicroUnits("-5")).toBeNull();
    expect(parseAmountToMicroUnits("-0.5")).toBeNull();
  });

  it("rejects more than 6 fractional digits rather than rounding", () => {
    expect(parseAmountToMicroUnits("1.1234567")).toBeNull();
    expect(parseAmountToMicroUnits("0.0000001")).toBeNull();
  });
});
