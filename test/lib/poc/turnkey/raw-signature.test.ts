import { describe, expect, it } from "vitest";
import { keccak256, recoverAddress, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { serializeTurnkeyRawSignature } from "@/lib/poc/turnkey/raw-signature";

const OWNER_KEY: Hex = "0x119bb329df425b685a3f3483fba01deeb1db47d608cfb051da9ad4a12995238a";
const owner = privateKeyToAccount(OWNER_KEY);

describe("serializeTurnkeyRawSignature", () => {
  it.each(["2", "27", "28", "-1"])("rejects unexpected yParity %s instead of silently treating it as 1", (v) => {
    expect(() => serializeTurnkeyRawSignature({ r: "01", s: "02", v })).toThrow(/yParity/);
  });
  it("pads r and s to exactly 32 bytes even when Turnkey strips a leading zero byte", () => {
    // Regression: naively concatenating Turnkey's r/s strings (rather than
    // parsing them as bigints and re-padding) silently misaligns the
    // signature the moment Turnkey returns an unpadded value — this is
    // exactly the class of bug that would make a cryptographically valid
    // signature fail to recover for a reason having nothing to do with
    // Turnkey's actual signing key or digest.
    const shortR = "1".repeat(63); // 63 hex chars simulates a stripped leading zero nibble
    const s = "2".repeat(64);
    const result = serializeTurnkeyRawSignature({ r: shortR, s, v: "0" });

    expect(result.length).toBe(2 + 130); // "0x" + 65 bytes
    expect(result.slice(2, 66)).toBe(`0${shortR}`); // r re-padded back to 64 hex chars
    expect(result.slice(66, 130)).toBe(s);
    expect(result.slice(130)).toBe("1b"); // Turnkey v="0" (yParity) -> Ethereum v=27
  });

  it("maps Turnkey v=1 to Ethereum v=28 (0x1c)", () => {
    const r = "3".repeat(64);
    const s = "4".repeat(64);
    const result = serializeTurnkeyRawSignature({ r, s, v: "1" });
    expect(result.slice(130)).toBe("1c");
  });

  it("round-trips a real ECDSA signature through separated r/s/v and recovers the correct owner", async () => {
    const digest = keccak256(toHex("serializeTurnkeyRawSignature-roundtrip-test"));
    const originalSignature = await owner.sign({ hash: digest });

    // Split exactly as Turnkey's v1SignRawPayloadResult would hand them back:
    // separate r, s, v components (no "0x" prefix on r/s).
    const r = originalSignature.slice(2, 66);
    const s = originalSignature.slice(66, 130);
    const ethereumV = Number.parseInt(originalSignature.slice(130), 16);
    const turnkeyV = ethereumV === 27 ? "0" : "1"; // Turnkey's yParity-proxy convention

    const reconstructed = serializeTurnkeyRawSignature({ r, s, v: turnkeyV });
    expect(reconstructed.toLowerCase()).toBe(originalSignature.toLowerCase());

    const recovered = await recoverAddress({ hash: digest, signature: reconstructed });
    expect(recovered.toLowerCase()).toBe(owner.address.toLowerCase());
  });
});
