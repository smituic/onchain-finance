import { describe, expect, it } from "vitest";
import { parseSession, serializeSession, type PocSession } from "@/lib/poc/turnkey/server/session";

const secret = "test-session-secret";

const baseSession: PocSession = {
  v: 1,
  appUserId: "11111111-1111-4111-8111-111111111111",
  subOrganizationId: "22222222-2222-4222-8222-222222222222",
  userId: "33333333-3333-4333-8333-333333333333",
  walletId: "44444444-4444-4444-8444-444444444444",
  ownerAddress: "0xf6C3fe6De636F0D8f421D5485d1a64Ff3628CfaF",
  authenticators: [],
};

describe("PoC app-session cookie", () => {
  it("round-trips the exact owner-address casing Turnkey returned", () => {
    // This is the source of the backend negative-sign-test false failure:
    // parseSession used to lowercase ownerAddress on every read, so the
    // cookie's own correctly-cased value never reached signWith.
    const token = serializeSession(baseSession, secret);
    const parsed = parseSession(token, secret);
    expect(parsed?.ownerAddress).toBe(baseSession.ownerAddress);
    expect(parsed?.ownerAddress).not.toBe(baseSession.ownerAddress.toLowerCase());
  });

  it("rejects a tampered payload and holds no signing authority on its own", () => {
    const token = serializeSession(baseSession, secret);
    const [payload] = token.split(".");
    expect(parseSession(`${payload}.tampered-mac`, secret)).toBeNull();
    expect(parseSession(token, "wrong-secret")).toBeNull();
    expect(JSON.stringify(baseSession)).not.toMatch(/private|seed|stamper|apiKey/i);
  });
});
