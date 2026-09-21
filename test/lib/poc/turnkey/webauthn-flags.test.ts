import { describe, expect, it } from "vitest";
import { parseWebAuthnFlags } from "@/lib/poc/turnkey/webauthn-flags";
import { bytesToBase64Url } from "@/lib/poc/turnkey/bytes";

describe("WebAuthn UV flag parsing", () => {
  it("reads UV and UP from authenticator data", () => {
    const data = new Uint8Array(37);
    data[32] = 0x05; // UP + UV
    const encoded = bytesToBase64Url(data);
    expect(parseWebAuthnFlags(encoded)).toEqual({ userPresent: true, userVerified: true });
  });

  it("reports UV false when the bit is clear", () => {
    const data = new Uint8Array(37);
    data[32] = 0x01; // UP only
    expect(parseWebAuthnFlags(bytesToBase64Url(data))?.userVerified).toBe(false);
  });
});
