import { describe, expect, it } from "vitest";
import { PASSKEY_NAME_MAX_LENGTH, passkeyDisplayName, validatePasskeyDisplayName } from "@/lib/real/display/passkey-name";

describe("validatePasskeyDisplayName", () => {
  it("trims surrounding whitespace", () => {
    expect(validatePasskeyDisplayName("  MacBook Touch ID  ")).toEqual({ ok: true, name: "MacBook Touch ID" });
  });

  it("rejects empty and whitespace-only names", () => {
    expect(validatePasskeyDisplayName("").ok).toBe(false);
    expect(validatePasskeyDisplayName("   \t ").ok).toBe(false);
  });

  it("rejects non-strings", () => {
    for (const input of [undefined, null, 42, {}, ["iPhone"]]) expect(validatePasskeyDisplayName(input).ok).toBe(false);
  });

  it(`accepts exactly ${PASSKEY_NAME_MAX_LENGTH} characters and rejects one more`, () => {
    expect(validatePasskeyDisplayName("a".repeat(PASSKEY_NAME_MAX_LENGTH)).ok).toBe(true);
    expect(validatePasskeyDisplayName("a".repeat(PASSKEY_NAME_MAX_LENGTH + 1)).ok).toBe(false);
  });

  it("counts characters the way Postgres char_length does (an emoji counts once)", () => {
    expect(validatePasskeyDisplayName("🔑".repeat(PASSKEY_NAME_MAX_LENGTH)).ok).toBe(true);
  });

  it("rejects control characters such as newlines", () => {
    expect(validatePasskeyDisplayName("iPhone\nYubiKey").ok).toBe(false);
    expect(validatePasskeyDisplayName("iPhone\u0000").ok).toBe(false);
  });

  it("allows duplicate-looking, punctuation, and non-Latin names", () => {
    expect(validatePasskeyDisplayName("Smit's iPhone (work)").ok).toBe(true);
    expect(validatePasskeyDisplayName("ノートパソコン").ok).toBe(true);
  });
});

describe("passkeyDisplayName", () => {
  it("falls back to the role label for rows that were never named", () => {
    expect(passkeyDisplayName({ displayName: null, role: "primary" })).toBe("Primary passkey");
    expect(passkeyDisplayName({ displayName: null, role: "backup" })).toBe("Backup passkey");
  });

  it("prefers the user's name", () => {
    expect(passkeyDisplayName({ displayName: "YubiKey", role: "backup" })).toBe("YubiKey");
  });
});
