import { describe, expect, it } from "vitest";
import { credentialIdsEqual, decodeCredentialId } from "@/lib/real/credential-id";

// Bytes chosen so the encodings exercise both alphabet-specific characters (+/ vs -_) and padding.
const BYTES = new Uint8Array([0xfb, 0xff, 0xbf, 0x01, 0x02]);
const B64URL_UNPADDED = "-_-_AQI";
const B64URL_PADDED = "-_-_AQI=";
const B64_STD_PADDED = "+/+/AQI=";
const B64_STD_UNPADDED = "+/+/AQI";

describe("credential-id normalization — byte comparison only", () => {
  it("decodes base64url and standard base64, padded or not, to the same bytes", () => {
    for (const encoded of [B64URL_UNPADDED, B64URL_PADDED, B64_STD_PADDED, B64_STD_UNPADDED]) {
      expect(decodeCredentialId(encoded)).toEqual(BYTES);
    }
  });

  it("padded vs unpadded compare equal", () => {
    expect(credentialIdsEqual(B64URL_UNPADDED, B64URL_PADDED)).toBe(true);
  });

  it("base64 vs base64url alphabets compare equal", () => {
    expect(credentialIdsEqual(B64URL_UNPADDED, B64_STD_PADDED)).toBe(true);
  });

  it("a one-byte difference never matches", () => {
    expect(credentialIdsEqual("-_-_AQI", "-_-_AQM")).toBe(false);
  });

  it("different lengths never match (no prefix matching)", () => {
    expect(credentialIdsEqual("-_-_AQI", "-_-_AQIB")).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["mixed alphabets", "-_+/AQI"],
    ["illegal character", "-_-_AQ!"],
    ["impossible length", "A"],
    ["padding in the middle", "AQ=I"],
    ["excess padding", "AQI==="],
    ["padding with wrong total length", "AQ="],
    ["non-canonical trailing bits", "AB"],
    ["not a string", 12345],
    ["null", null],
  ])("malformed (%s) fails closed — no decode, no match", (_label, value) => {
    expect(decodeCredentialId(value)).toBeNull();
    expect(credentialIdsEqual(value, value)).toBe(false);
    expect(credentialIdsEqual(value, B64URL_UNPADDED)).toBe(false);
  });

  it("never falls back to raw string equality when a side is undecodable", () => {
    expect(credentialIdsEqual("not base64!!", "not base64!!")).toBe(false);
  });
});
