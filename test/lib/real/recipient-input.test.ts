import { describe, expect, it } from "vitest";
import { INVALID_ADDRESS_MESSAGE, INVALID_HANDLE_MESSAGE, classifyRecipientInput, resolveRecipientView, type RecipientLookup } from "@/lib/real/recipient-input";

const ADDRESS = "0xAbCdEf0123456789abcdef0123456789ABCDEF01";

describe("classifyRecipientInput — the one 'To' field", () => {
  it("empty and whitespace-only input is empty", () => {
    for (const input of ["", " ", "\t\n"]) expect(classifyRecipientInput(input)).toEqual({ kind: "empty" });
  });

  it("@smit, smit, Smit, and a padded name are all the handle smit", () => {
    for (const input of ["@smit", "smit", "Smit", "@SMIT", "  smit  ", " @Smit\n"]) {
      expect(classifyRecipientInput(input), JSON.stringify(input)).toEqual({ kind: "handle", canonicalHandle: "smit" });
    }
  });

  it("a malformed name is invalid, with jargon-free feedback", () => {
    for (const input of ["@", "ab", "@@smit", "sm it", "smit!", "1smit", "smit_", "a".repeat(21), "smít", " smit"]) {
      expect(classifyRecipientInput(input), JSON.stringify(input)).toEqual({ kind: "invalid", reason: INVALID_HANDLE_MESSAGE });
    }
  });

  it("a full address is the address path, normalized, with no handle involved", () => {
    expect(classifyRecipientInput(ADDRESS)).toEqual({ kind: "address", recipient: ADDRESS.toLowerCase() });
    expect(classifyRecipientInput(`  ${ADDRESS}  `)).toEqual({ kind: "address", recipient: ADDRESS.toLowerCase() });
  });

  it("a partial or mistyped 0x input is an invalid ADDRESS — never a handle candidate", () => {
    for (const input of ["0x", "0xabc", "0xabcdef", ADDRESS.slice(0, -1), `${ADDRESS}0`, `0x${"g".repeat(40)}`, "0Xabc"]) {
      expect(classifyRecipientInput(input), input).toEqual({ kind: "invalid", reason: INVALID_ADDRESS_MESSAGE });
    }
  });
});

describe("resolveRecipientView — derived from input + lookup state", () => {
  const idle: RecipientLookup = { status: "idle" };
  const found = (overrides: Partial<Extract<RecipientLookup, { status: "found" }>> = {}): RecipientLookup => ({ status: "found", handle: "smit", displayName: "Smit Patel", isSelf: false, ...overrides });

  it("maps each lookup state for a handle input", () => {
    expect(resolveRecipientView("@smit", idle, null)).toEqual({ kind: "unresolved", handle: "smit" });
    expect(resolveRecipientView("@smit", { status: "looking_up" }, null)).toEqual({ kind: "checking", handle: "smit" });
    expect(resolveRecipientView("@smit", { status: "not_found" }, null)).toEqual({ kind: "not_found", handle: "smit" });
    expect(resolveRecipientView("@smit", { status: "error" }, null)).toEqual({ kind: "lookup_failed", handle: "smit" });
    expect(resolveRecipientView("@smit", found(), null)).toEqual({ kind: "found", handle: "smit", displayName: "Smit Patel" });
  });

  it("the account's own handle is self immediately, whatever the lookup state", () => {
    expect(resolveRecipientView(" @Smit ", idle, "smit")).toEqual({ kind: "self", handle: "smit" });
    expect(resolveRecipientView("smit", found(), "smit")).toEqual({ kind: "self", handle: "smit" });
  });

  it("a lookup that says isSelf is self", () => {
    expect(resolveRecipientView("smit", found({ isSelf: true }), null)).toEqual({ kind: "self", handle: "smit" });
  });

  it("a found result for a different handle than the input is never 'found'", () => {
    expect(resolveRecipientView("@smitty", found(), null)).toEqual({ kind: "unresolved", handle: "smitty" });
  });

  it("an address ignores lookup state and own handle entirely", () => {
    expect(resolveRecipientView(ADDRESS, found(), "smit")).toEqual({ kind: "address", recipient: ADDRESS.toLowerCase() });
  });
});
