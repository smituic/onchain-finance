import { describe, expect, it } from "vitest";
import {
  addressesEqual,
  normalizeAddress,
  normalizeHash,
  normalizeTurnkeyId,
  validateAddressCasePreserving,
} from "@/lib/poc/turnkey/identifiers";

describe("identifier normalization", () => {
  it("lowercases valid addresses and rejects junk", () => {
    expect(normalizeAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e")).toBe(
      "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    );
    expect(normalizeAddress("036cbd53842c5426634e7929541ec2318f3dcf7e")).toBeNull();
    expect(normalizeAddress("")).toBeNull();
  });

  it("normalizes 32-byte hashes", () => {
    const hash = "0x" + "ab".repeat(32);
    expect(normalizeHash(hash.toUpperCase().replace("0X", "0x"))).toBe(hash);
    expect(normalizeHash("0x1234")).toBeNull();
  });

  it("accepts Turnkey UUIDs only", () => {
    expect(normalizeTurnkeyId("11111111-1111-4111-8111-111111111111")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(normalizeTurnkeyId("not-a-uuid")).toBeNull();
  });

  it("compares addresses case-insensitively", () => {
    expect(
      addressesEqual("0x036CbD53842c5426634e7929541eC2318f3dCF7e", "0x036cbd53842c5426634e7929541ec2318f3dcf7e"),
    ).toBe(true);
  });

  it("preserves exact casing for Turnkey wallet addresses (case-sensitive resource lookup)", () => {
    // This is a regression guard for Turnkey error code 5 ("Could not find
    // any resource to sign with. Addresses are case sensitive.") — the
    // owner address must come back byte-for-byte identical, never lowered.
    const mixedCase = "0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF";
    expect(validateAddressCasePreserving(mixedCase)).toBe(mixedCase);
    expect(validateAddressCasePreserving(mixedCase)).not.toBe(mixedCase.toLowerCase());
  });

  it("still validates Turnkey address shape and rejects junk", () => {
    expect(validateAddressCasePreserving("not-an-address")).toBeNull();
    expect(validateAddressCasePreserving(null)).toBeNull();
    expect(validateAddressCasePreserving("  0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF  ")).toBe(
      "0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF",
    );
  });
});
