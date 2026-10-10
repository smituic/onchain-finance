import { describe, expect, it } from "vitest";
import { describePaymentRecipient, formatRecipientIdentity, readRecipientIdentity, shortenAddress } from "@/lib/real/display/payment-recipient";

const ADDRESS = "0x1234567890abcdef1234567890abcdef1234abcd";
const SHORT = "0x1234…abcd";

describe("describePaymentRecipient — how a payment's recipient is shown (Slice D)", () => {
  it("a handle payment with a display name is 'Name (@handle)'", () => {
    expect(describePaymentRecipient({ recipient: ADDRESS, recipientIdentity: { handle: "smit", displayName: "Smit Patel" } })).toEqual({
      kind: "handle",
      handle: "smit",
      displayName: "Smit Patel",
      label: "Smit Patel (@smit)",
    });
  });

  it("a handle payment with no display name is '@handle' alone", () => {
    expect(describePaymentRecipient({ recipient: ADDRESS, recipientIdentity: { handle: "smit", displayName: null } })).toEqual({ kind: "handle", handle: "smit", displayName: null, label: "@smit" });
  });

  it("an address payment (null, or no identity field at all) is the shortened address", () => {
    expect(describePaymentRecipient({ recipient: ADDRESS, recipientIdentity: null })).toEqual({ kind: "address", label: SHORT });
    expect(describePaymentRecipient({ recipient: ADDRESS })).toEqual({ kind: "address", label: SHORT });
    expect(shortenAddress(ADDRESS)).toBe(SHORT);
  });

  it("a malformed or non-canonical handle falls back to the address — it is never repaired into a handle", () => {
    for (const handle of ["@smit", "Smit", "SMIT", " smit", "smit ", "sm", "", "a".repeat(21), "smit_", "1smit", "sm it", "smít", null, undefined, 7, {}, ["smit"]]) {
      const shown = describePaymentRecipient({ recipient: ADDRESS, recipientIdentity: { handle, displayName: "Smit Patel" } });
      expect(shown, JSON.stringify(handle)).toEqual({ kind: "address", label: SHORT });
      expect(JSON.stringify(shown)).not.toMatch(/smit|Smit Patel|@/i);
    }
  });

  it("an invalid display name (wrong type, empty, or blank) falls back to the address — a handle is never shown with a made-up name", () => {
    for (const displayName of [undefined, 0, false, {}, ["Smit"], "", "   ", "\n"]) {
      expect(describePaymentRecipient({ recipient: ADDRESS, recipientIdentity: { handle: "smit", displayName } }), JSON.stringify(displayName)).toEqual({ kind: "address", label: SHORT });
    }
  });

  it("anything that is not exactly { handle, displayName } falls back to the address (fail closed)", () => {
    const notIdentities: unknown[] = [
      "smit",
      "@smit",
      42,
      true,
      [],
      [{ handle: "smit", displayName: null }],
      {},
      { handle: "smit" }, // displayName missing
      { displayName: "Smit Patel" }, // a name with no handle is never shown
      { handle: "smit", displayName: null, appUserId: "app-user-2" }, // an extra key
      { handle: "smit", displayName: "Smit Patel", safeAddress: ADDRESS },
      { handle: "smit", displayName: null, recipient: ADDRESS },
    ];
    for (const recipientIdentity of notIdentities) {
      expect(readRecipientIdentity(recipientIdentity), JSON.stringify(recipientIdentity)).toBeNull();
      expect(describePaymentRecipient({ recipient: ADDRESS, recipientIdentity }), JSON.stringify(recipientIdentity)).toEqual({ kind: "address", label: SHORT });
    }
  });

  it("never derives a handle from the address: an address payment to a known account's Safe is still an address", () => {
    const shown = describePaymentRecipient({ recipient: ADDRESS, recipientIdentity: null });
    expect(shown.kind).toBe("address");
    expect(shown.label).not.toContain("@");
  });

  it("reads only the two fields: the returned identity is a fresh { handle, displayName }", () => {
    const identity = readRecipientIdentity({ handle: "maya_chen", displayName: "Maya Chen" });
    expect(identity).toEqual({ handle: "maya_chen", displayName: "Maya Chen" });
    expect(Object.keys(identity!).sort()).toEqual(["displayName", "handle"]);
    expect(formatRecipientIdentity(identity!)).toBe("Maya Chen (@maya_chen)");
    expect(formatRecipientIdentity({ handle: "maya_chen", displayName: null })).toBe("@maya_chen");
  });
});
