import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  LOGIN_CHALLENGE_CLOCK_SKEW_MS,
  LOGIN_CHALLENGE_TOKEN_BYTES,
  LOGIN_CHALLENGE_TOKEN_CHARS,
  LOGIN_CHALLENGE_TTL_MS,
  computeLoginChallengeMac,
  deriveLoginChallengeKey,
  issueLoginChallenge,
  parseLoginChallenge,
} from "@/lib/real/server/login-challenge";
import { buildLoginOptions } from "@/lib/real/server/webauthn";
import type { RealServerConfig } from "@/lib/real/server/config";

/**
 * Milestone 3C-2 — the stateless login challenge token. Offline only: no database, no network.
 *
 * KNOWN-ANSWER VECTORS were computed OUTSIDE this code base with an independent implementation (Python's hmac/hashlib and a
 * hand-written RFC 5869 HKDF, itself checked against RFC 5869 test case 3) so these tests do not just compare the
 * implementation with itself.
 */
const SECRET = "test-secret";
const RP_ID = "localhost";
const EXP = 1_800_000_300_000;
const NOW = EXP - LOGIN_CHALLENGE_TTL_MS; // the instant that token would have been issued
const NONCE = Uint8Array.from({ length: 16 }, (_, i) => i);

const KAT = {
  key: "3f2f386e4f529feb18a13d77b4871e3adc51ddf328b58a7cf1e61c35e83d43e3",
  head: "0101000001a31860e3e0000102030405060708090a0b0c0d0e0f",
  mac: "f8439afad0fa8adbd6e8f39207a764088335bdb7cd5ba0c542c29686aab76f08",
  macOtherRp: "6307a85ca5a170c8fc5173535e438105d0ba72db14852e3daee157b29d8c7e9b", // same head, RP ID "example.com"
  token: "AQEAAAGjGGDj4AABAgMEBQYHCAkKCwwNDg_4Q5r60PqK29bo85IHp2QIgzW9t81boMVCwpaGqrdvCA",
};

const fixedRandom = () => NONCE;
const issue = (over: Partial<Parameters<typeof issueLoginChallenge>[0]> = {}) => issueLoginChallenge({ sessionSecret: SECRET, rpId: RP_ID, nowMs: NOW, random: fixedRandom, ...over });
const parse = (value: unknown, over: Partial<Parameters<typeof parseLoginChallenge>[1]> = {}) => parseLoginChallenge(value, { sessionSecret: SECRET, rpId: RP_ID, nowMs: NOW + 1000, ...over });
const bytesOf = (challenge: string) => Buffer.from(challenge, "base64url");
const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
/** A token whose MAC is recomputed for the tampered head (so only the field under test is wrong). */
function resign(mutate: (bytes: Buffer) => void, rpId = RP_ID, secret = SECRET): string {
  const bytes = bytesOf(issue().challenge);
  mutate(bytes);
  const mac = computeLoginChallengeMac(deriveLoginChallengeKey(secret), bytes.subarray(0, 26), rpId);
  mac.copy(bytes, 26);
  return encode(bytes);
}

describe("known-answer vectors", () => {
  it("HKDF-SHA256 over the UTF-8 secret, empty salt, the fixed info string, 32 bytes", () => {
    expect(deriveLoginChallengeKey(SECRET).toString("hex")).toBe(KAT.key);
  });

  it("the token is exactly the independently computed 58 bytes and 78 characters", () => {
    const issued = issue();
    expect(issued.challenge).toBe(KAT.token);
    expect(issued.challenge).toHaveLength(LOGIN_CHALLENGE_TOKEN_CHARS);
    expect(Buffer.from(issued.tokenBytes).toString("hex")).toBe(`${KAT.head}${KAT.mac}`);
    expect(issued.tokenBytes).toHaveLength(LOGIN_CHALLENGE_TOKEN_BYTES);
    expect(issued.expiresAtMs).toBe(EXP);
  });

  it("the MAC covers domain || 0x00 || head || uint16-BE length || RP ID, and the RP ID changes it", () => {
    const key = deriveLoginChallengeKey(SECRET);
    const head = Buffer.from(KAT.head, "hex");
    expect(computeLoginChallengeMac(key, head, RP_ID).toString("hex")).toBe(KAT.mac);
    expect(computeLoginChallengeMac(key, head, "example.com").toString("hex")).toBe(KAT.macOtherRp);
    // Recomputed here from the spec's byte layout with node's HMAC directly (not through the module under test).
    const manual = createHmac("sha256", key)
      .update(Buffer.concat([Buffer.from("OCF-REAL-WEBAUTHN-LOGIN-CHALLENGE", "ascii"), Buffer.from([0]), head, Buffer.from([0, RP_ID.length]), Buffer.from(RP_ID)]))
      .digest("hex");
    expect(manual).toBe(KAT.mac);
  });

  it("the key is NOT the raw session secret, and the info string separates it from anything else keyed by that secret", () => {
    expect(deriveLoginChallengeKey(SECRET).equals(Buffer.from(SECRET))).toBe(false);
    expect(deriveLoginChallengeKey(SECRET).equals(deriveLoginChallengeKey("another-secret"))).toBe(false);
    expect(deriveLoginChallengeKey(`  ${SECRET}\n`).toString("hex")).toBe(KAT.key); // the secret is trimmed first
  });
});

describe("issuance", () => {
  it("lays out version, purpose, big-endian expiration, nonce, MAC", () => {
    const bytes = Buffer.from(issue().tokenBytes);
    expect(bytes[0]).toBe(0x01);
    expect(bytes[1]).toBe(0x01);
    expect(bytes.readBigUInt64BE(2)).toBe(BigInt(EXP));
    expect([...bytes.subarray(10, 26)]).toEqual([...NONCE]);
    expect(bytes.subarray(26)).toHaveLength(32);
  });

  it("uses a fresh 16-byte cryptographic nonce each time (no repeats across 500 tokens)", () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const parsed = parseLoginChallenge(issueLoginChallenge({ sessionSecret: SECRET, rpId: RP_ID }).challenge, { sessionSecret: SECRET, rpId: RP_ID });
      if (!parsed.ok) throw new Error("a freshly issued token must parse");
      expect(parsed.nonceHex).toMatch(/^[0-9a-f]{32}$/);
      nonces.add(parsed.nonceHex);
    }
    expect(nonces.size).toBe(500);
  });

  it("refuses a nonce of the wrong size, an empty secret, a bad clock, and a bad RP ID", () => {
    expect(() => issue({ random: () => new Uint8Array(15) })).toThrow();
    expect(() => issue({ random: () => new Uint8Array(17) })).toThrow();
    expect(() => issue({ sessionSecret: "" })).toThrow();
    expect(() => issue({ sessionSecret: "   " })).toThrow();
    expect(() => issue({ nowMs: Number.NaN })).toThrow();
    expect(() => issue({ nowMs: -1 })).toThrow();
    expect(() => issue({ rpId: "" })).toThrow();
    expect(() => issue({ rpId: "a".repeat(256) })).toThrow();
    expect(() => issue({ rpId: "a".repeat(255) })).not.toThrow();
    expect(() => issue({ rpId: "é".repeat(128) })).toThrow(); // 256 UTF-8 bytes
  });
});

describe("parsing — what is accepted", () => {
  it("accepts a fresh token and returns the nonce hex, the expiration, and an explicit-UTC ISO string", () => {
    expect(parse(KAT.token)).toEqual({ ok: true, nonceHex: "000102030405060708090a0b0c0d0e0f", expiresAtMs: EXP, expiresAtIso: new Date(EXP).toISOString() });
    expect(new Date(EXP).toISOString()).toMatch(/Z$/);
  });
});

describe("parsing — what is refused (all before any database access: this module has none)", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 5],
    ["an array", [KAT.token]],
    ["an object", { challenge: KAT.token }],
    ["a Uint8Array", new Uint8Array(58)],
  ])("a non-string: %s", (_name, value) => expect(parse(value)).toEqual({ ok: false, reason: "not_a_string" }));

  it("the wrong length: empty, short, long, padded, doubled", () => {
    for (const value of ["", KAT.token.slice(1), KAT.token.slice(0, 77), `${KAT.token}A`, `${KAT.token}=`, `${KAT.token}==`, KAT.token + KAT.token]) {
      expect(parse(value), String(value.length)).toEqual({ ok: false, reason: "bad_length" });
    }
  });

  it("characters outside the base64url alphabet, including standard-base64 '+' '/' and whitespace", () => {
    for (const bad of ["+", "/", " ", "=", "\n", "é", "\u0000"]) {
      expect(parse(`${KAT.token.slice(0, 77)}${bad}`), JSON.stringify(bad)).toMatchObject({ ok: false });
      expect(parse(`${KAT.token.slice(0, 77)}${bad}`)).not.toMatchObject({ ok: true });
    }
    expect(parse(KAT.token.replace(/_/, "/"))).toEqual({ ok: false, reason: "bad_characters" });
    expect(parse(KAT.token.replace(/-|_/, "+"))).toEqual({ ok: false, reason: "bad_characters" });
  });

  it("a non-canonical encoding of the same 58 bytes (the last character carries 4 padding bits that must be zero)", () => {
    const last = KAT.token[77]!;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const sibling = alphabet[(alphabet.indexOf(last) + 1) % 64]!; // differs only in the trailing bits' neighbour value
    const variant = `${KAT.token.slice(0, 77)}${sibling}`;
    // Decodes to the same 58 bytes or fails — either way it must NOT be accepted, because re-encoding differs from the string.
    expect(bytesOf(variant).toString("base64url") === variant).toBe(false);
    expect(parse(variant).ok).toBe(false);
  });

  it("a wrong version and a wrong purpose, even when correctly signed", () => {
    expect(parse(resign((b) => void (b[0] = 0x02)))).toEqual({ ok: false, reason: "bad_version" });
    expect(parse(resign((b) => void (b[0] = 0x00)))).toEqual({ ok: false, reason: "bad_version" });
    expect(parse(resign((b) => void (b[1] = 0x02)))).toEqual({ ok: false, reason: "bad_purpose" });
    expect(parse(resign((b) => void (b[1] = 0x00)))).toEqual({ ok: false, reason: "bad_purpose" });
  });

  it("an expiration that is not a safe integer, even when correctly signed", () => {
    expect(parse(resign((b) => b.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1), 2)))).toEqual({ ok: false, reason: "bad_expiration" });
    expect(parse(resign((b) => b.writeBigUInt64BE(BigInt("0xffffffffffffffff"), 2)))).toEqual({ ok: false, reason: "bad_expiration" });
  });

  it("a forged MAC: every single-bit flip of the MAC, the nonce, the expiration, and the header is refused", () => {
    const original = bytesOf(KAT.token);
    for (let byte = 0; byte < LOGIN_CHALLENGE_TOKEN_BYTES; byte += 1) {
      for (const bit of [0, 7]) {
        const flipped = Buffer.from(original);
        flipped[byte] = flipped[byte]! ^ (1 << bit);
        const result = parse(encode(flipped));
        expect(result.ok, `byte ${byte} bit ${bit}`).toBe(false);
      }
    }
  });

  it("a modified expiration under the ORIGINAL MAC", () => {
    const bytes = bytesOf(KAT.token);
    bytes.writeBigUInt64BE(BigInt(EXP + 60_000), 2);
    expect(parse(encode(bytes))).toEqual({ ok: false, reason: "bad_mac" });
  });

  it("a token for another RP ID, another secret, or a truncated MAC", () => {
    expect(parse(KAT.token, { rpId: "example.com" })).toEqual({ ok: false, reason: "bad_mac" });
    expect(parse(KAT.token, { sessionSecret: "rotated-secret" })).toEqual({ ok: false, reason: "bad_mac" });
    expect(parse(KAT.token.slice(0, 70))).toMatchObject({ ok: false });
    // 58-byte token whose MAC tail is zeroed.
    const zeroed = bytesOf(KAT.token);
    zeroed.fill(0, 26);
    expect(parse(encode(zeroed))).toEqual({ ok: false, reason: "bad_mac" });
  });

  it("an RP ID that is empty or oversize is refused", () => {
    expect(parse(KAT.token, { rpId: "" })).toEqual({ ok: false, reason: "bad_rp_id" });
    expect(parse(KAT.token, { rpId: "a".repeat(256) })).toEqual({ ok: false, reason: "bad_rp_id" });
  });

  it("key rotation: a token minted under the old secret is refused under the new one, and vice versa (no old-key fallback)", () => {
    const oldToken = issue({ sessionSecret: "old-secret" }).challenge;
    expect(parse(oldToken, { sessionSecret: "old-secret" }).ok).toBe(true);
    expect(parse(oldToken, { sessionSecret: "new-secret" })).toEqual({ ok: false, reason: "bad_mac" });
    expect(parse(issue({ sessionSecret: "new-secret" }).challenge, { sessionSecret: "old-secret" })).toEqual({ ok: false, reason: "bad_mac" });
  });
});

describe("parsing — the advisory application-clock window", () => {
  it("exp > now is required: equality is expired, one millisecond earlier is live", () => {
    expect(parse(KAT.token, { nowMs: EXP })).toEqual({ ok: false, reason: "expired" });
    expect(parse(KAT.token, { nowMs: EXP + 1 })).toEqual({ ok: false, reason: "expired" });
    expect(parse(KAT.token, { nowMs: EXP - 1 }).ok).toBe(true);
  });

  it("exp <= now + 5 minutes + 120 seconds: equality is accepted, one millisecond more is refused", () => {
    const limit = LOGIN_CHALLENGE_TTL_MS + LOGIN_CHALLENGE_CLOCK_SKEW_MS;
    expect(limit).toBe(7 * 60 * 1000);
    expect(parse(KAT.token, { nowMs: EXP - limit }).ok).toBe(true);
    expect(parse(KAT.token, { nowMs: EXP - limit - 1 })).toEqual({ ok: false, reason: "too_far_ahead" });
  });

  it("a token issued now is live for exactly five minutes", () => {
    const issuedAt = 1_800_000_000_000;
    const { challenge } = issue({ nowMs: issuedAt });
    expect(parse(challenge, { nowMs: issuedAt }).ok).toBe(true);
    expect(parse(challenge, { nowMs: issuedAt + LOGIN_CHALLENGE_TTL_MS - 1 }).ok).toBe(true);
    expect(parse(challenge, { nowMs: issuedAt + LOGIN_CHALLENGE_TTL_MS })).toEqual({ ok: false, reason: "expired" });
  });
});

describe("WebAuthn compatibility (@simplewebauthn/server 14.0.2)", () => {
  const config = { rpId: RP_ID, rpName: "Test", expectedOrigins: ["http://localhost:3000"] } as unknown as RealServerConfig;

  it("passing the 58 BYTES makes optionsJSON.challenge exactly the canonical base64url of those bytes", async () => {
    const issued = issue();
    const options = await buildLoginOptions({ config, challenge: issued.tokenBytes });
    expect(options.challenge).toBe(issued.challenge);
    expect(options.challenge).toBe(KAT.token);
    expect(options.allowCredentials).toBeUndefined(); // discoverable-credential login is preserved
    expect(options.userVerification).toBe("required");
    expect(options.rpId).toBe(RP_ID);
  });

  it("passing the base64url STRING instead would silently change the challenge (UTF-8 re-encoding) — which is why bytes are required", async () => {
    // Direct library call, to document the trap this design avoids.
    const { generateAuthenticationOptions } = await import("@simplewebauthn/server");
    const wrong = await generateAuthenticationOptions({ rpID: RP_ID, challenge: KAT.token });
    expect(wrong.challenge).not.toBe(KAT.token);
    // The wrong value cannot parse as a login challenge.
    expect(parse(wrong.challenge).ok).toBe(false);
  });

  it("a Uint8Array round trip: bytes -> options -> string -> bytes is lossless", async () => {
    const issued = issue();
    const options = await buildLoginOptions({ config, challenge: issued.tokenBytes });
    expect([...bytesOf(options.challenge)]).toEqual([...issued.tokenBytes]);
  });
});
