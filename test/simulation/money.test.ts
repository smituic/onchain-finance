import { describe, expect, it } from "vitest";
import { DECIMALS, fromMicroUnits, toMicroUnits } from "@/simulation";

describe("money", () => {
  it("uses 6 decimal places", () => {
    expect(DECIMALS).toBe(6);
  });

  it("converts whole amounts to micro-units", () => {
    expect(toMicroUnits(10_000)).toBe(10_000_000_000);
  });

  it("converts fractional amounts to micro-units", () => {
    expect(toMicroUnits(0.5)).toBe(500_000);
  });

  it("round-trips whole and fractional amounts", () => {
    expect(fromMicroUnits(toMicroUnits(1234.56))).toBeCloseTo(1234.56, 6);
  });

  it("rounds to the nearest micro-unit rather than accumulating float drift", () => {
    expect(toMicroUnits(0.1 + 0.2)).toBe(300_000);
  });
});
