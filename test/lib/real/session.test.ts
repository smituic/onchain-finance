import { createHmac, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MIN_SESSION_SECRET_BYTES,
  REAL_SESSION_VERSION,
  createSessionPayload,
  decodeSessionSecret,
  isStrongSessionSecret,
  parseSession,
  realSessionCookieOptions,
  serializeSession,
} from "@/lib/real/server/session";
import { isRealServerConfig, readRealServerConfig } from "@/lib/real/server/config";

const SECRET = "test-session-secret";

describe("real session serialize/parse", () => {
  it("round-trips a valid session", () => {
    const payload = createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 });
    const cookie = serializeSession(payload, SECRET);
    const parsed = parseSession(cookie, SECRET);

    expect(parsed).toEqual(payload);
  });

  it("never contains anything Turnkey/signing-shaped — app identity only", () => {
    const payload = createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 });
    const cookie = serializeSession(payload, SECRET);
    expect(Object.keys(payload).sort()).toEqual(["appUserId", "credentialId", "exp", "sessionEpoch", "sid", "v"]);
    expect(cookie).not.toMatch(/subOrganization|walletId|ownerAddress|safeAddress|turnkey/i);
  });

  it("two sessions minted for the same account/credential are always distinct tokens (per-issuance nonce)", () => {
    const first = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);
    const second = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 }), SECRET);
    expect(first).not.toBe(second);
  });

  it("rejects a tampered payload (signature mismatch)", () => {
    const payload = createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 });
    const cookie = serializeSession(payload, SECRET);
    const [encoded] = cookie.split(".");
    const tampered = `${encoded}.${"a".repeat(43)}`;

    expect(parseSession(tampered, SECRET)).toBeNull();
  });

  it("rejects a payload signed with a different secret", () => {
    const payload = createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 0 });
    const cookie = serializeSession(payload, SECRET);

    expect(parseSession(cookie, "a-different-secret")).toBeNull();
  });

  it("rejects an expired session even with a valid signature (server-checked exp, not just cookie maxAge)", () => {
    const payload = createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", ttlMs: -1, sessionEpoch: 0 });
    const cookie = serializeSession(payload, SECRET);

    expect(parseSession(cookie, SECRET)).toBeNull();
  });

  it("rejects malformed values without throwing", () => {
    expect(parseSession(undefined, SECRET)).toBeNull();
    expect(parseSession(null, SECRET)).toBeNull();
    expect(parseSession("", SECRET)).toBeNull();
    expect(parseSession("not-a-valid-cookie", SECRET)).toBeNull();
    expect(parseSession("a.b.c", SECRET)).toBeNull();
  });

  it("rejects a shape-mismatched payload (missing sid) even with a valid signature", () => {
    const cookie = serializeSession(
      { v: 1, appUserId: "x", credentialId: "y", exp: Date.now() + 10_000 } as unknown as ReturnType<typeof createSessionPayload>,
      SECRET,
    );
    expect(parseSession(cookie, SECRET)).toBeNull();
  });

  it("rejects a current-version payload that is missing its sessionEpoch, even with a valid signature", () => {
    const cookie = serializeSession(
      { v: 2, appUserId: "x", credentialId: "y", exp: Date.now() + 10_000, sid: "abc" } as unknown as ReturnType<typeof createSessionPayload>,
      SECRET,
    );
    expect(parseSession(cookie, SECRET)).toBeNull();
  });

  it("cookie options are HttpOnly, SameSite=Lax, and scoped to the whole app", () => {
    const options = realSessionCookieOptions();
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
    expect(options.maxAge).toBeGreaterThan(0);
  });
});

/** Signs an arbitrary JSON payload exactly the way serializeSession does — for forging well-signed-but-wrong-shape tokens. */
function signRaw(payload: unknown, secret = SECRET): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
}

describe("S4: session token v2 (session epoch)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("a valid v2 token round-trips with its epoch", () => {
    const payload = createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", sessionEpoch: 7 });
    expect(payload.v).toBe(2);
    expect(REAL_SESSION_VERSION).toBe(2);
    expect(parseSession(serializeSession(payload, SECRET), SECRET)).toEqual(payload);
  });

  it("a legacy v1 token — correctly signed, unexpired, well-formed for v1 — is rejected after the version bump", () => {
    const legacy = signRaw({ v: 1, appUserId: "app-user-1", credentialId: "credential-1", exp: Date.now() + 60_000, sid: "legacy-sid" });
    expect(parseSession(legacy, SECRET)).toBeNull();
    // Even a v1 token that somehow carries an epoch is refused by version.
    const legacyWithEpoch = signRaw({ v: 1, appUserId: "app-user-1", credentialId: "credential-1", exp: Date.now() + 60_000, sid: "legacy-sid", sessionEpoch: 0 });
    expect(parseSession(legacyWithEpoch, SECRET)).toBeNull();
  });

  it("an unknown future version is rejected", () => {
    const future = signRaw({ v: 3, appUserId: "a", credentialId: "c", exp: Date.now() + 60_000, sid: "s", sessionEpoch: 0 });
    expect(parseSession(future, SECRET)).toBeNull();
  });

  it("rejects a non-integer, negative, unsafe, or non-numeric epoch even with a valid signature", () => {
    for (const sessionEpoch of [-1, 1.5, "0", null, Number.MAX_SAFE_INTEGER + 1]) {
      const token = signRaw({ v: 2, appUserId: "a", credentialId: "c", exp: Date.now() + 60_000, sid: "s", sessionEpoch });
      expect(parseSession(token, SECRET)).toBeNull();
    }
  });

  it("never mints a session at an invalid epoch", () => {
    expect(() => createSessionPayload({ appUserId: "a", credentialId: "c", sessionEpoch: -1 })).toThrow();
    expect(() => createSessionPayload({ appUserId: "a", credentialId: "c", sessionEpoch: Number.NaN })).toThrow();
  });

  it("accepts exactly <payload>.<mac>: extra segments, empty segments, padding, and stray characters are all rejected", () => {
    const valid = serializeSession(createSessionPayload({ appUserId: "a", credentialId: "c", sessionEpoch: 0 }), SECRET);
    expect(parseSession(valid, SECRET)).not.toBeNull();
    const [encoded, mac] = valid.split(".") as [string, string];
    for (const malformed of [
      `${valid}.extra`,
      `${valid}.`,
      `.${valid}`,
      `${encoded}.${mac}.${mac}`,
      `${encoded}..${mac}`,
      `${encoded}.${mac}=`,
      `${encoded}=.${mac}`,
      ` ${valid}`,
      `${valid} `,
      `${encoded}.${mac.slice(0, -1)}`,
      `${encoded}!.${mac}`,
    ]) {
      expect(parseSession(malformed, SECRET)).toBeNull();
    }
  });

  it("MAC comparison stays constant-time (node:crypto timingSafeEqual on equal-length buffers)", async () => {
    const source = await import("node:fs").then((fs) => fs.readFileSync("lib/real/server/session.ts", "utf8"));
    expect(source).toMatch(/timingSafeEqual\(actualBuf, expectedBuf\)/);
    expect(source).not.toMatch(/mac\s*===\s*expected|expected\s*===\s*mac/);
  });

  it("cookie hardening preserved: Secure in production, no Domain attribute", () => {
    vi.stubEnv("NODE_ENV", "production");
    const production = realSessionCookieOptions();
    expect(production.secure).toBe(true);
    expect(production).not.toHaveProperty("domain");
    vi.stubEnv("NODE_ENV", "development");
    expect(realSessionCookieOptions().secure).toBe(false);
  });
});

describe("S4: REAL_SESSION_SECRET format policy (hex or base64/base64url of >= 32 bytes, nothing else)", () => {
  const baseEnv = {
    TURNKEY_PARENT_ORGANIZATION_ID: "org",
    TURNKEY_API_PUBLIC_KEY: "pub",
    TURNKEY_API_PRIVATE_KEY: "priv",
    NEXT_PUBLIC_REAL_RP_ID: "localhost",
    NEXT_PUBLIC_REAL_ORIGIN: "http://localhost:3000",
    PIMLICO_API_KEY: "pim",
  };

  // Fixed values, so no case can pass or fail by chance.
  const HEX_64 = "7f3c9a1e5b2d4f60a8c7e9b1d3f5a7c90e2b4d6f8a1c3e5b7d9f0a2c4e6b8d0f"; // the local secret's shape: 64 hex chars = 32 bytes
  const BYTES_32 = Buffer.alloc(32, 0xfb); // encodes with '+', '/', '-', '_' — never mistakable for hex
  const B64_32 = BYTES_32.toString("base64"); // 44 chars, padded
  const B64URL_32 = BYTES_32.toString("base64url"); // 43 chars, unpadded

  it("fixtures are what they claim", () => {
    expect(MIN_SESSION_SECRET_BYTES).toBe(32);
    expect(HEX_64).toMatch(/^[0-9a-f]{64}$/);
    expect(B64_32).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(B64URL_32).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("ACCEPTS: 64 hex chars (32 bytes), longer hex, base64 and base64url of exactly 32 bytes, and longer encodings", () => {
    const accepted = [
      HEX_64,
      HEX_64.toUpperCase(),
      HEX_64 + HEX_64, // 64 bytes
      B64_32,
      B64URL_32,
      `${B64URL_32}=`, // base64url with its (optional) padding
      Buffer.alloc(48, 0xfb).toString("base64"),
      Buffer.alloc(64, 0xfb).toString("base64url"),
    ];
    for (const secret of accepted) expect(isStrongSessionSecret(secret), secret).toBe(true);
    for (let i = 0; i < 25; i += 1) {
      for (const encoding of ["hex", "base64", "base64url"] as const) expect(isStrongSessionSecret(randomBytes(32).toString(encoding))).toBe(true);
    }
  });

  it("decodes to exactly the encoded bytes", () => {
    expect(decodeSessionSecret(HEX_64)?.equals(Buffer.from(HEX_64, "hex"))).toBe(true);
    expect(decodeSessionSecret(B64_32)?.equals(BYTES_32)).toBe(true);
    expect(decodeSessionSecret(B64URL_32)?.equals(BYTES_32)).toBe(true);
  });

  it("REJECTS passphrases and raw text however long — no UTF-8 byte-length fallback", () => {
    for (const secret of [
      "correct horse battery staple!!!!",
      "please-change-this-session-secret!",
      "change me please this is long enough!!",
      "🔒".repeat(8), // 32 UTF-8 bytes
      "test-secret",
      "route-handler-test-secret",
    ]) {
      expect(isStrongSessionSecret(secret), secret).toBe(false);
      expect(decodeSessionSecret(secret), secret).toBeNull();
    }
    expect(Buffer.byteLength("🔒".repeat(8), "utf8")).toBe(32);
  });

  it("REJECTS 63 hex characters — an all-hex string is judged ONLY as hex, never re-read as base64", () => {
    const hex63 = HEX_64.slice(0, 63);
    expect(isStrongSessionSecret(hex63)).toBe(false);
    // As base64 this exact string would even decode canonically to 47 bytes; the hex-first rule is what refuses it.
    expect(Buffer.from(hex63, "base64").toString("base64").replace(/=+$/, "")).toBe(hex63);
    expect(isStrongSessionSecret(HEX_64.slice(0, 62))).toBe(false); // 31 bytes, even length
  });

  it("REJECTS malformed hex", () => {
    for (const secret of [
      HEX_64.match(/../g)!.join(":"), // colon-separated
      `${HEX_64.slice(0, 32)} ${HEX_64.slice(32)}`, // inner space
      `${HEX_64}\n`, // trailing newline (config trims edges; the parser itself never does)
      `0x${HEX_64}`, // 0x-prefixed: not hex, and not a canonical base64 string either
    ]) {
      expect(isStrongSessionSecret(secret), JSON.stringify(secret)).toBe(false);
    }
  });

  it("REJECTS malformed and non-canonical base64/base64url", () => {
    const lastChar = B64URL_32.at(-1)!;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const nonCanonical = B64URL_32.slice(0, -1) + alphabet[alphabet.indexOf(lastChar) + 1];
    // Node's lenient decoder silently drops the extra bits — the round-trip check is what refuses it.
    expect(Buffer.from(nonCanonical, "base64url").equals(BYTES_32)).toBe(true);

    for (const secret of [
      nonCanonical,
      B64_32.replace("+", "-"), // mixes the base64 and base64url alphabets
      `${B64_32}=`, // too much padding
      B64_32.slice(0, -1) + "==", // wrong padding for this length
      `${B64_32.slice(0, 20)}=${B64_32.slice(21)}`, // padding in the middle
      `${B64URL_32}AA`, // 45 chars: an impossible length (4n + 1)
      "=".repeat(44),
      `${B64_32.slice(0, 22)} ${B64_32.slice(22)}`, // inner whitespace
    ]) {
      expect(isStrongSessionSecret(secret), secret).toBe(false);
      expect(decodeSessionSecret(secret), secret).toBeNull();
    }
  });

  it("REJECTS valid base64 and base64url that decode to fewer than 32 bytes", () => {
    for (const length of [31, 24, 16]) {
      const bytes = Buffer.alloc(length, 0xfb);
      for (const encoding of ["base64", "base64url"] as const) {
        const secret = bytes.toString(encoding);
        expect(decodeSessionSecret(secret)?.length, secret).toBe(length); // well-formed…
        expect(isStrongSessionSecret(secret), secret).toBe(false); // …but too short
      }
    }
  });

  it("readRealServerConfig fails closed on a weak or malformed secret — naming the variable, never echoing its value", () => {
    for (const weak of ["hunter2-hunter2-hunter2", "correct horse battery staple!!!!", HEX_64.slice(0, 63)]) {
      const result = readRealServerConfig({ ...baseEnv, REAL_SESSION_SECRET: weak });
      expect(isRealServerConfig(result)).toBe(false);
      if (isRealServerConfig(result)) return;
      expect(result.error).toMatch(/REAL_SESSION_SECRET is too weak or malformed/);
      expect(result.error).not.toContain(weak);
    }
  });

  it("readRealServerConfig accepts the local secret's 64-hex shape and base64/base64url secrets", () => {
    for (const strong of [HEX_64, B64_32, B64URL_32]) {
      expect(isRealServerConfig(readRealServerConfig({ ...baseEnv, REAL_SESSION_SECRET: strong }))).toBe(true);
    }
  });
});
