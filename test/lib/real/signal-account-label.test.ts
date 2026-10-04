import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { signalAccountLabel } from "@/lib/real/account/webauthn-client";

/**
 * The best-effort passkey relabel. It may only ever call
 * PublicKeyCredential.signalCurrentUserDetails, and nothing it does — or
 * fails to do — can be observed by its caller.
 */
const INPUT = { rpId: "localhost", userHandle: "dXNlci1oYW5kbGU", handle: "smit", displayName: "Smit Patel" };

function installPublicKeyCredential(value: unknown) {
  vi.stubGlobal("PublicKeyCredential", value);
}

afterEach(() => vi.unstubAllGlobals());

describe("signalAccountLabel", () => {
  it("UNSUPPORTED: no PublicKeyCredential at all -> does nothing, returns undefined, never throws", () => {
    installPublicKeyCredential(undefined);
    expect(signalAccountLabel(INPUT)).toBeUndefined();
  });

  it("UNSUPPORTED: PublicKeyCredential without signalCurrentUserDetails -> does nothing — and never falls back to another signal", () => {
    const unknownCredential = vi.fn();
    const allAccepted = vi.fn();
    installPublicKeyCredential({ signalUnknownCredential: unknownCredential, signalAllAcceptedCredentials: allAccepted });
    expect(signalAccountLabel(INPUT)).toBeUndefined();
    expect(unknownCredential).not.toHaveBeenCalled();
    expect(allAccepted).not.toHaveBeenCalled();
  });

  it("SUCCEEDS: calls signalCurrentUserDetails once with the credential's own user id, '@handle', and the display name", () => {
    const signal = vi.fn(async () => {});
    const others = { signalUnknownCredential: vi.fn(), signalAllAcceptedCredentials: vi.fn() };
    installPublicKeyCredential({ signalCurrentUserDetails: signal, ...others });
    expect(signalAccountLabel(INPUT)).toBeUndefined(); // returns immediately — nothing to await
    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith({ rpId: "localhost", userId: "dXNlci1oYW5kbGU", name: "@smit", displayName: "Smit Patel" });
    expect(others.signalUnknownCredential).not.toHaveBeenCalled();
    expect(others.signalAllAcceptedCredentials).not.toHaveBeenCalled();
  });

  it("without a display name, displayName falls back to '@handle'", () => {
    const signal = vi.fn(async () => {});
    installPublicKeyCredential({ signalCurrentUserDetails: signal });
    signalAccountLabel({ ...INPUT, displayName: null });
    signalAccountLabel({ ...INPUT, displayName: undefined });
    signalAccountLabel({ ...INPUT, displayName: "" });
    for (const call of signal.mock.calls) expect(call).toEqual([{ rpId: "localhost", userId: "dXNlci1oYW5kbGU", name: "@smit", displayName: "@smit" }]);
  });

  it("is called with PublicKeyCredential as `this` (a detached static would throw in browsers)", () => {
    const seen: unknown[] = [];
    const credential = {
      signalCurrentUserDetails(this: unknown) {
        seen.push(this);
        return Promise.resolve();
      },
    };
    installPublicKeyCredential(credential);
    signalAccountLabel(INPUT);
    expect(seen).toEqual([credential]);
  });

  it("no handle, no user handle, or no RP ID -> never signals (an account without a handle is never relabelled)", () => {
    const signal = vi.fn(async () => {});
    installPublicKeyCredential({ signalCurrentUserDetails: signal });
    for (const missing of [{ handle: null }, { handle: undefined }, { handle: "" }, { userHandle: undefined }, { userHandle: null }, { userHandle: "" }, { rpId: undefined }, { rpId: "" }]) {
      signalAccountLabel({ ...INPUT, ...missing });
    }
    expect(signal).not.toHaveBeenCalled();
  });

  it("THROWS synchronously -> swallowed", () => {
    installPublicKeyCredential({
      signalCurrentUserDetails: () => {
        throw new TypeError("not allowed");
      },
    });
    expect(() => signalAccountLabel(INPUT)).not.toThrow();
  });

  it("REJECTS asynchronously -> swallowed, with no unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      installPublicKeyCredential({ signalCurrentUserDetails: () => Promise.reject(new DOMException("nope", "SecurityError")) });
      expect(() => signalAccountLabel(INPUT)).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("a signal that never settles does not block the caller", () => {
    installPublicKeyCredential({ signalCurrentUserDetails: () => new Promise(() => {}) });
    expect(signalAccountLabel(INPUT)).toBeUndefined();
  });

  it("returns a non-promise even if the browser returns a non-promise or a getter throws", () => {
    installPublicKeyCredential({ signalCurrentUserDetails: () => undefined });
    expect(signalAccountLabel(INPUT)).toBeUndefined();
    installPublicKeyCredential(
      Object.defineProperty({}, "signalCurrentUserDetails", {
        get() {
          throw new Error("hostile getter");
        },
      }),
    );
    expect(() => signalAccountLabel(INPUT)).not.toThrow();
  });

  it("the codebase uses ONLY signalCurrentUserDetails — never the signals that can hide or remove a passkey, and never the library's generic sendSignal (static)", () => {
    const client = readFileSync("lib/real/account/webauthn-client.ts", "utf8");
    const code = client
      .split("\n")
      .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/**"))
      .join("\n");
    expect(code).toContain("signalCurrentUserDetails");
    expect(code).not.toMatch(/signalUnknownCredential|signalAllAcceptedCredentials|sendSignal/);
    for (const file of ["lib/stores/real-account-store.ts", "lib/stores/real-passkeys-store.ts", "components/real/account-identity.tsx", "components/real/account-setup.tsx"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/signalUnknownCredential|signalAllAcceptedCredentials|sendSignal|signalCurrentUserDetails/);
    }
  });
});
