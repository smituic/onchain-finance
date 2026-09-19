import { describe, expect, it } from "vitest";
import { classifyAccountCode, isAddress, normaliseHash, shortenHex } from "@/lib/poc/privy/identifiers";

const HASH = "0x" + "ab".repeat(32);

describe("normaliseHash", () => {
  it("accepts and lowercases a 32-byte hash", () => {
    expect(normaliseHash(HASH.toUpperCase().replace("0X", "0x"))).toEqual({ kind: "hash", value: HASH });
  });

  it("treats an empty hash as absent (sponsored sends may return '' before inclusion)", () => {
    expect(normaliseHash("")).toEqual({ kind: "absent", raw: "" });
    expect(normaliseHash("0x")).toEqual({ kind: "absent", raw: "0x" });
    expect(normaliseHash(undefined)).toEqual({ kind: "absent", raw: "" });
    expect(normaliseHash(null)).toEqual({ kind: "absent", raw: "" });
  });

  it("flags anything else as invalid rather than guessing", () => {
    expect(normaliseHash("0x1234")).toEqual({ kind: "invalid", raw: "0x1234" });
    expect(normaliseHash("not-a-hash")).toEqual({ kind: "invalid", raw: "not-a-hash" });
    // A wallet id or user op id is not a tx hash.
    expect(normaliseHash("did:privy:abc").kind).toBe("invalid");
  });
});

describe("isAddress", () => {
  it("validates 20-byte hex addresses", () => {
    expect(isAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e")).toBe(true);
    expect(isAddress("0x000000000000000000000000000000000000dEaD")).toBe(true);
    expect(isAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7")).toBe(false);
    expect(isAddress("036CbD53842c5426634e7929541eC2318f3dCF7e")).toBe(false);
  });
});

describe("classifyAccountCode", () => {
  it("reports no code for a plain EOA", () => {
    expect(classifyAccountCode(undefined)).toEqual({ kind: "none" });
    expect(classifyAccountCode("0x")).toEqual({ kind: "none" });
  });

  it("recognises an EIP-7702 delegation designator", () => {
    const delegate = "69007702c9b5a9a7cf4b8e8a1c0e9c2f4a6b8d0e";
    expect(classifyAccountCode(`0xEF0100${delegate}`)).toEqual({
      kind: "eip7702-delegation",
      delegate: `0x${delegate}`,
    });
  });

  it("reports other bytecode as a contract with its length", () => {
    expect(classifyAccountCode("0x6080604052")).toEqual({ kind: "contract", byteLength: 5 });
    // 0xef0100 prefix with the wrong length is NOT a delegation.
    expect(classifyAccountCode("0xef0100abcd").kind).toBe("contract");
  });
});

describe("shortenHex", () => {
  it("shortens long values and leaves short ones alone", () => {
    expect(shortenHex("0x036CbD53842c5426634e7929541eC2318f3dCF7e")).toBe("0x036CbD…CF7e");
    expect(shortenHex("0x1234")).toBe("0x1234");
  });
});
