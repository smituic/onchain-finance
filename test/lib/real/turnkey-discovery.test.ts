import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bytesToBase64Url } from "@/lib/real/bytes";
import * as turnkeyReads from "@/lib/real/server/turnkey-discovery";
import { strictCanonicalTurnkeyPublicKeyBytes, turnkeyPublicKeysEqual } from "@/lib/real/server/turnkey-discovery";
import { createFixtureAuthenticator } from "./fixtures/webauthn";

// A real P-256 COSE_Key (77 bytes, like the live keys).
const passkey = createFixtureAuthenticator();
const COSE_KEY = bytesToBase64Url(passkey.publicKeyCose);
const OTHER_COSE_KEY = bytesToBase64Url(createFixtureAuthenticator().publicKeyCose);

describe("S5 L2: strictCanonicalTurnkeyPublicKeyBytes / turnkeyPublicKeysEqual", () => {
  it("accepts the canonical unpadded base64url of the key bytes and returns those exact bytes", () => {
    expect(COSE_KEY).toHaveLength(103); // a 77-byte P-256 COSE_Key, the live shape
    expect(strictCanonicalTurnkeyPublicKeyBytes(COSE_KEY)).toEqual(new Uint8Array(passkey.publicKeyCose));
    expect(turnkeyPublicKeysEqual(COSE_KEY, COSE_KEY)).toBe(true);
  });

  it.each<[string, unknown]>([
    ["non-string", 42],
    ["null", null],
    ["empty", ""],
    ["padded", `${COSE_KEY}=`],
    ["standard-base64 alphabet", COSE_KEY.replace(/[A-Za-z0-9]/, "+")],
    ["leading whitespace", ` ${COSE_KEY}`],
    ["trailing newline", `${COSE_KEY}\n`],
    ["impossible length (len % 4 === 1)", "AAAAA"],
    ["non-zero spare bits (a second spelling of the same bytes)", "AB"],
    ["hex/SEC1-looking", `02${"ab".repeat(32)}`],
  ])("rejects %s", (_label, value) => {
    expect(strictCanonicalTurnkeyPublicKeyBytes(value)).toBeNull();
    expect(turnkeyPublicKeysEqual(value, COSE_KEY)).toBe(false);
  });

  it("is case-sensitive: changing only letter case never matches", () => {
    const flipped = COSE_KEY.replace(/[a-z]/, (c) => c.toUpperCase());
    expect(flipped).not.toBe(COSE_KEY);
    expect(turnkeyPublicKeysEqual(flipped, COSE_KEY)).toBe(false);
    expect(turnkeyPublicKeysEqual(COSE_KEY.toUpperCase(), COSE_KEY)).toBe(false);
    expect(turnkeyPublicKeysEqual(COSE_KEY.toLowerCase(), COSE_KEY)).toBe(false);
  });

  it("different bytes never match", () => {
    expect(turnkeyPublicKeysEqual(OTHER_COSE_KEY, COSE_KEY)).toBe(false);
  });
});


const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), "utf8");
const sourcesUnder = (dir: string) =>
  readdirSync(path.resolve(process.cwd(), dir), { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => [`${dir}/${f}`, read(`${dir}/${f}`)] as const);

describe("turnkey-discovery.ts source", () => {
  it("is server-only: imports nothing from React/Next/Zustand", () => {
    const source = read("lib/real/server/turnkey-discovery.ts");
    expect(source).not.toContain('from "react"');
    expect(source).not.toContain('from "next"');
    expect(source).not.toContain('from "zustand"');
  });

  it("is never imported by the login flow", () => {
    const loginSource = read("lib/real/server/login.ts");
    expect(loginSource).not.toContain("turnkey-discovery");
  });

  it("S5 L2 (Option 3): exports ONLY the shared read/compare helpers — no sub-org discovery or adoption primitive", () => {
    expect(Object.keys(turnkeyReads).sort()).toEqual(["listTurnkeyUserAuthenticators", "matchAuthenticatorByCredentialId", "readTurnkeyActivity", "strictCanonicalTurnkeyPublicKeyBytes", "turnkeyPublicKeysEqual"]);
  });

  it("S5 L2 (Option 3): nothing in lib/real or app searches Turnkey for a sub-org by credential, or names the removed discovery API", () => {
    for (const [file, text] of [...sourcesUnder("lib/real"), ...sourcesUnder("app")]) {
      expect(text, file).not.toMatch(/\.getSubOrgIds\(|list_suborgs|discoverAccountByCredentialId|evaluateCandidate|DISCOVERY_PAGE_LIMIT/);
    }
  });

  it("S5 L2: no case-folding key normalizer survives anywhere in lib/real", () => {
    for (const [file, text] of sourcesUnder("lib/real")) expect(text, file).not.toContain("normalizeTurnkeyPublicKey");
  });
});
