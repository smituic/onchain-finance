import { describe, expect, it } from "vitest";
import { ACCOUNT_DISPLAY_NAME_MAX_LENGTH, accountTitle, validateAccountDisplayName } from "@/lib/real/display/account-name";

const name = (input: unknown) => {
  const result = validateAccountDisplayName(input);
  if (!result.ok) throw new Error(`expected ${JSON.stringify(input)} to be accepted: ${result.reason}`);
  return result.name;
};
const refused = (input: unknown) => expect(validateAccountDisplayName(input).ok, JSON.stringify(input)).toBe(false);

describe("validateAccountDisplayName — the account's display name", () => {
  it("trims, and keeps ordinary names — including non-Latin scripts and emoji", () => {
    expect(name("  Maya Chen  ")).toBe("Maya Chen");
    expect(name("Søren")).toBe("Søren");
    expect(name("山田 太郎")).toBe("山田 太郎");
    expect(name("Zo\u00EB 🌱")).toBe("Zo\u00EB 🌱");
    expect(name("O'Brien-Smith, Jr.")).toBe("O'Brien-Smith, Jr.");
  });

  it("normalizes to NFC", () => {
    const decomposed = "Zoe\u0308"; // e + combining diaeresis
    expect(decomposed).not.toBe("Zo\u00EB");
    expect(name(decomposed)).toBe("Zo\u00EB");
    expect(name("Zo\u00EB")).toBe("Zo\u00EB");
  });

  it("empty, whitespace-only, null, and undefined all mean 'no display name' (NULL)", () => {
    for (const input of ["", "   ", "\t\n", "\u00A0\u2003", null, undefined]) expect(name(input)).toBeNull();
  });

  it("allows at most 40 Unicode CODE POINTS (an emoji counts once), measured after NFC", () => {
    expect(ACCOUNT_DISPLAY_NAME_MAX_LENGTH).toBe(40);
    expect(name("a".repeat(40))).toBe("a".repeat(40));
    refused("a".repeat(41));
    expect(name("😀".repeat(40))).toBe("😀".repeat(40)); // 80 UTF-16 units, 40 code points
    refused("😀".repeat(41));
    // 40 decomposed pairs are 80 code points raw but 40 after NFC.
    expect(name("e\u0301".repeat(40))).toBe("\u00E9".repeat(40));
  });

  it("rejects control characters (Cc)", () => {
    for (const bad of ["Maya\u0000Chen", "Maya\nChen", "Maya\tChen", "Maya\u007FChen", "Maya\u0085Chen", "Ma\u001Bya"]) refused(bad);
  });

  it("rejects every bidirectional control character", () => {
    for (const code of [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
      refused(`Maya${String.fromCodePoint(code)}Chen`);
    }
    // The classic spoof: right-to-left override making "@evil" read differently.
    refused("Support \u202Elive@");
  });

  it("rejects Unicode line and paragraph separators inside a name", () => {
    refused("Maya\u2028Chen");
    refused("Maya\u2029Chen");
  });

  it("rejects non-strings", () => {
    for (const bad of [42, {}, [], true]) refused(bad);
  });

  it("rejects EVERY Unicode format character (Cf) — invisible characters that make two names look identical", () => {
    const named: Array<[string, number]> = [
      ["zero-width space", 0x200b],
      ["zero-width non-joiner", 0x200c],
      ["zero-width joiner", 0x200d],
      ["word joiner", 0x2060],
      ["soft hyphen", 0x00ad],
      ["byte-order mark / zero-width no-break space", 0xfeff],
      ["Arabic letter mark", 0x061c],
      ["left-to-right mark", 0x200e],
      ["right-to-left override", 0x202e],
      ["first strong isolate", 0x2068],
      ["invisible times", 0x2062],
      ["Mongolian vowel separator", 0x180e],
      ["interlinear annotation anchor", 0xfff9],
      ["language tag", 0xe0001],
      ["tag latin small letter a", 0xe0061],
    ];
    for (const [label, code] of named) {
      expect(/\p{Cf}/u.test(String.fromCodePoint(code)), label).toBe(true);
      refused(`Maya${String.fromCodePoint(code)}Chen`);
    }
    // At the very edge, the one format character JavaScript's trim() treats as whitespace (U+FEFF) is trimmed away — the stored name is clean either way.
    expect(name("Maya\uFEFF")).toBe("Maya");
    refused("Maya\u200B"); // every other one is refused at the edge too
    // "Alice" and "Ali<ZWSP>ce" must not both be storable.
    expect(name("Alice")).toBe("Alice");
    refused("Ali\u200Bce");
    refused("Ali\u2060ce");
    refused("Ali\u00ADce");
  });

  it("a leading format character is refused, never silently trimmed into a different name", () => {
    refused("\u200BAlice");
    refused("\u2060@support"); // can't hide a leading @ behind an invisible character either
    refused("\u00AD@alice");
  });

  it("rejects a display name beginning with @ — it must never read as a handle", () => {
    for (const bad of ["@support", "@alice", "@", "@ Alice", "  @support  ", "@@x", "\t@admin"]) refused(bad);
    expect(validateAccountDisplayName("@support")).toEqual({ ok: false, reason: "A name can't start with @." });
  });

  it("an @ elsewhere in an ordinary name is fine", () => {
    expect(name("Alice @ Home")).toBe("Alice @ Home");
    expect(name("alice@example.com")).toBe("alice@example.com");
    expect(name("A@")).toBe("A@");
  });

  it("still accepts ordinary Unicode names across scripts, with marks, punctuation, and single-code-point emoji", () => {
    for (const valid of ["Jos\u00E9 Álvarez", "Nguyễn Thị Minh", "Иван Петров", "Αλέξανδρος", "محمد علي", "דוד כהן", "李小龙", "さくら", "김민준", "सीता", "Ægir Þórsson", "D'Arcy O’Neil-Smith", "Dr. J. R. R. Tolkien III", "Zo\u00EB 🌱", "Ren\u00E9e 🎉🎉"]) {
      expect(name(valid), valid).toBe(valid.normalize("NFC"));
    }
  });

  it("has no profanity or moderation logic", () => {
    expect(name("Darn Heck")).toBe("Darn Heck");
  });
});

describe("accountTitle", () => {
  it("prefers the display name, then the @handle, then nothing", () => {
    expect(accountTitle({ handle: "smit", displayName: "Smit Patel" })).toBe("Smit Patel");
    expect(accountTitle({ handle: "smit", displayName: null })).toBe("@smit");
    expect(accountTitle({ handle: null, displayName: null })).toBeNull();
  });
});
