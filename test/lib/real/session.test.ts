import { describe, expect, it } from "vitest";
import { createSessionPayload, parseSession, realSessionCookieOptions, serializeSession } from "@/lib/real/server/session";

const SECRET = "test-session-secret";

describe("real session serialize/parse", () => {
  it("round-trips a valid session", () => {
    const payload = createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1" });
    const cookie = serializeSession(payload, SECRET);
    const parsed = parseSession(cookie, SECRET);

    expect(parsed).toEqual(payload);
  });

  it("never contains anything Turnkey/signing-shaped — app identity only", () => {
    const payload = createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1" });
    const cookie = serializeSession(payload, SECRET);
    expect(Object.keys(payload).sort()).toEqual(["appUserId", "credentialId", "exp", "sid", "v"]);
    expect(cookie).not.toMatch(/subOrganization|walletId|ownerAddress|safeAddress|turnkey/i);
  });

  it("two sessions minted for the same account/credential are always distinct tokens (per-issuance nonce)", () => {
    const first = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1" }), SECRET);
    const second = serializeSession(createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1" }), SECRET);
    expect(first).not.toBe(second);
  });

  it("rejects a tampered payload (signature mismatch)", () => {
    const payload = createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1" });
    const cookie = serializeSession(payload, SECRET);
    const [encoded] = cookie.split(".");
    const tampered = `${encoded}.${"a".repeat(43)}`;

    expect(parseSession(tampered, SECRET)).toBeNull();
  });

  it("rejects a payload signed with a different secret", () => {
    const payload = createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1" });
    const cookie = serializeSession(payload, SECRET);

    expect(parseSession(cookie, "a-different-secret")).toBeNull();
  });

  it("rejects an expired session even with a valid signature (server-checked exp, not just cookie maxAge)", () => {
    const payload = createSessionPayload({ appUserId: "app-user-1", credentialId: "credential-1", ttlMs: -1 });
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

  it("rejects a differently-versioned payload even with a valid signature", () => {
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
