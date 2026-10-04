import { describe, expect, it } from "vitest";
import { HANDLE_MAX_LENGTH, HANDLE_MIN_LENGTH, HANDLE_PATTERN, RESERVED_HANDLES, canonicalizeHandle, formatHandle, isReservedHandle } from "@/lib/real/handle";

const ok = (input: unknown) => {
  const result = canonicalizeHandle(input);
  if (!result.ok) throw new Error(`expected ${JSON.stringify(input)} to be accepted: ${result.reason}`);
  return result.handle;
};
const refused = (input: unknown) => expect(canonicalizeHandle(input).ok, JSON.stringify(input)).toBe(false);

describe("canonicalizeHandle — the one handle validator", () => {
  it("accepts the canonical form unchanged", () => {
    for (const handle of ["smit", "abc", "a1b2", "maya_chen", "a_b_c", "x9_9x", "a".repeat(20)]) expect(ok(handle)).toBe(handle);
  });

  it("canonicalizes uppercase ASCII to lowercase", () => {
    expect(ok("Smit")).toBe("smit");
    expect(ok("MAYA_Chen9")).toBe("maya_chen9");
  });

  it("removes exactly ONE leading @ — never two, never one elsewhere", () => {
    expect(ok("@smit")).toBe("smit");
    refused("@@smit");
    refused("@ smit");
    refused("smit@");
    refused("sm@it");
    refused("@");
  });

  it("trims surrounding ASCII whitespace only; anything left inside or after is refused", () => {
    expect(ok("  smit  ")).toBe("smit");
    expect(ok("\tsmit\n")).toBe("smit");
    expect(ok(" @smit\r\n")).toBe("smit");
    refused("smit\nadmin"); // newline + trailing junk
    refused("smit\n\nx");
    refused("smit x");
    refused("smit\u0000");
    refused("smit;--");
    refused("smit/../x");
  });

  it("does not treat Unicode spaces as trimmable — they are non-ASCII and refused", () => {
    refused("\u00A0smit");
    refused("smit\u2003");
    refused("\uFEFFsmit");
  });

  it("rejects every non-ASCII code point BEFORE lowercasing — nothing can case-fold into ASCII", () => {
    // U+212A KELVIN SIGN lowercases to ASCII "k"; U+0130 lowercases to "i" + U+0307.
    expect("\u212A".toLowerCase()).toBe("k");
    refused("\u212Aevin");
    refused("smit\u212A");
    refused("\u0130stanbul");
    refused("sm\u0130t");
    // U+017F LATIN SMALL LETTER LONG S uppercases to "S"; still non-ASCII.
    refused("\u017Fmit");
  });

  it("rejects fullwidth Latin (which NFKC would fold to ASCII — NFKC is never applied)", () => {
    expect("\uFF53\uFF4D\uFF49\uFF54".normalize("NFKC")).toBe("smit");
    refused("\uFF53\uFF4D\uFF49\uFF54");
    refused("smi\uFF54");
  });

  it("rejects Cyrillic and Greek look-alikes", () => {
    refused("\u0430dmin"); // Cyrillic \u0430
    refused("p\u0430y"); // Cyrillic \u0430 inside
    refused("\u0441\u043C\u0456\u0442");
    refused("\u03BFmega"); // Greek omicron
  });

  it("rejects combining marks, emoji, and astral code points", () => {
    refused("smit\u0301");
    refused("smit\u{1F600}");
    refused("\u{1D42C}mit");
  });

  it("enforces the length boundaries on the canonical form", () => {
    expect(HANDLE_MIN_LENGTH).toBe(3);
    expect(HANDLE_MAX_LENGTH).toBe(20);
    refused("");
    refused("a");
    refused("ab");
    expect(ok("abc")).toBe("abc");
    expect(ok("a".repeat(20))).toBe("a".repeat(20));
    refused("a".repeat(21));
    // The @ and surrounding whitespace don't count.
    expect(ok(` @${"a".repeat(20)} `)).toBe("a".repeat(20));
    refused("@ab");
  });

  it("enforces the underscore rules: not first, not last, never consecutive", () => {
    refused("_smit");
    refused("smit_");
    refused("sm__it");
    refused("s___t");
    refused("___");
    expect(ok("s_m_i_t")).toBe("s_m_i_t");
  });

  it("must start with a letter — so nothing numeric and nothing address-shaped", () => {
    refused("1smit");
    refused("123");
    refused("9_a");
    refused("0x1234");
    refused("0xd9a4c22fb34dc74317edc8006140d66c8fa03266");
    refused("0Xabc");
  });

  it("rejects every other ASCII character", () => {
    for (const bad of ["sm-it", "sm.it", "sm it", "smit!", "sm+it", "smit'", 'sm"it', "sm<it", "sm%it", "sm\\it"]) refused(bad);
  });

  it("rejects non-strings", () => {
    for (const bad of [null, undefined, 42, {}, [], true, ["smit"]]) refused(bad);
  });

  it("is idempotent and its output always satisfies the canonical regex", () => {
    for (const input of ["Smit", "@Maya_Chen", "  a1b2 ", "ABC"]) {
      const once = ok(input);
      expect(ok(once)).toBe(once);
      expect(HANDLE_PATTERN.test(once)).toBe(true);
    }
    expect(HANDLE_PATTERN.source).toBe("^[a-z][a-z0-9]*(_[a-z0-9]+)*$");
  });

  it("ASCII look-alikes are accepted, not folded: l/1 and o/0 stay distinct handles", () => {
    expect(ok("pau1")).toBe("pau1");
    expect(ok("paul")).toBe("paul");
    expect(ok("b0b")).not.toBe(ok("bob"));
  });

  it("formatHandle shows the canonical handle with its @", () => {
    expect(formatHandle("smit")).toBe("@smit");
  });
});

describe("reserved handles", () => {
  const REQUIRED = [
    "admin", "administrator", "support", "help", "security", "official", "staff", "team", "system", "root", "moderator", "api", "app", "null",
    "undefined", "anonymous", "me", "everyone", "onchain", "onchainfinance", "on_chain_finance", "cash", "pay", "save", "invest", "swap", "borrow",
    "explore", "home", "real", "practice", "bank", "turnkey", "safe", "base", "coinbase", "circle", "usdc", "pimlico", "wallet", "account",
    "settings", "login", "register",
  ];

  it("contains at least the required set, deduplicated", () => {
    for (const name of REQUIRED) expect(isReservedHandle(name), name).toBe(true);
    expect(new Set(RESERVED_HANDLES).size).toBe(RESERVED_HANDLES.length);
  });

  it("every reserved name is canonical — except the deliberately short 'me', which is unclaimable by length anyway", () => {
    for (const name of RESERVED_HANDLES) {
      if (name === "me") {
        expect(canonicalizeHandle(name).ok).toBe(false);
        continue;
      }
      expect(canonicalizeHandle(name), name).toEqual({ ok: true, handle: name });
    }
  });

  it("canonicalization is what makes a reserved name reachable in any spelling", () => {
    expect(isReservedHandle(ok("@Admin"))).toBe(true);
    expect(isReservedHandle(ok(" SUPPORT "))).toBe(true);
    expect(isReservedHandle("smit")).toBe(false);
  });
});
