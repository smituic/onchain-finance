import { describe, expect, it } from "vitest";
import {
  computeValidUntil,
  hasEnoughValidityToDispatch,
  SAFE_OP_MIN_REMAINING_AT_DISPATCH_SECONDS,
  SAFE_OP_VALID_AFTER,
  SAFE_OP_VALIDITY_SECONDS,
  splitUserOperationNonce,
} from "@/lib/real/payments/validity";

describe("SafeOp validity window", () => {
  it("is finite, never 0 (= never expires in EntryPoint v0.7), and never longer than Pimlico's 600 s sponsorship", () => {
    expect(SAFE_OP_VALIDITY_SECONDS).toBeGreaterThan(SAFE_OP_MIN_REMAINING_AT_DISPATCH_SECONDS);
    expect(SAFE_OP_VALIDITY_SECONDS).toBeLessThanOrEqual(600);
    expect(SAFE_OP_VALID_AFTER).toBe(0);
    expect(computeValidUntil(BigInt(1_900_000_000))).toBe(1_900_000_000 + SAFE_OP_VALIDITY_SECONDS);
  });

  it("dispatch needs at least the margin left; no window (null/0) never dispatches", () => {
    const validUntil = 1_900_000_600;
    expect(hasEnoughValidityToDispatch(validUntil, validUntil - SAFE_OP_MIN_REMAINING_AT_DISPATCH_SECONDS)).toBe(true);
    expect(hasEnoughValidityToDispatch(validUntil, validUntil - SAFE_OP_MIN_REMAINING_AT_DISPATCH_SECONDS + 1)).toBe(false);
    expect(hasEnoughValidityToDispatch(validUntil, validUntil + 1)).toBe(false);
    expect(hasEnoughValidityToDispatch(null, 0)).toBe(false);
    expect(hasEnoughValidityToDispatch(0, 0)).toBe(false);
    expect(hasEnoughValidityToDispatch(Number.NaN, 0)).toBe(false);
  });

  it("splits an EntryPoint v0.7 nonce into its uint192 key and uint64 sequence (live-shaped value)", () => {
    const key = BigInt("0x1a0d5d70cd9");
    expect(splitUserOperationNonce((key << BigInt(64)) | BigInt(3))).toEqual({ key, sequence: BigInt(3) });
    expect(splitUserOperationNonce(BigInt("33025095892748469342255938797568"))).toEqual({ key, sequence: BigInt(0) });
  });
});
