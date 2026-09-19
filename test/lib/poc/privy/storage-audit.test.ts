import { describe, expect, it } from "vitest";
import {
  captureStorageSnapshot,
  classifyStorageKey,
  cookieNamesFromDocumentCookie,
  diffSnapshots,
  evaluateSecurityGate,
  type StorageSnapshot,
} from "@/lib/poc/privy/storage-audit";

function snapshot(partial: Partial<StorageSnapshot> = {}): StorageSnapshot {
  return {
    label: "test",
    capturedAtMs: 0,
    origin: "https://example.com",
    localStorage: [],
    sessionStorage: [],
    indexedDB: [],
    cookies: [],
    ...partial,
  };
}

describe("classifyStorageKey — Privy keys from the installed SDK constants", () => {
  it("marks session credentials as sensitive", () => {
    for (const key of ["privy:token", "privy:pat", "privy:refresh_token", "privy:id_token", "privy:id-token"]) {
      expect(classifyStorageKey("localStorage", key).sensitivity).toBe("sensitive");
      expect(classifyStorageKey("localStorage", key).owner).toBe("privy");
    }
  });

  it("recognises multi-user namespaced variants (user ids contain colons)", () => {
    expect(classifyStorageKey("localStorage", "privy:did:privy:abc123:token").sensitivity).toBe("sensitive");
    expect(classifyStorageKey("localStorage", "privy:did:privy:abc123:refresh_token").sensitivity).toBe("sensitive");
    expect(classifyStorageKey("localStorage", "privy:did:privy:abc123:pat").sensitivity).toBe("sensitive");
    expect(classifyStorageKey("localStorage", "privy:did:privy:abc123:id-token").sensitivity).toBe("sensitive");
  });

  it("marks guest and cross-app credentials as sensitive", () => {
    expect(classifyStorageKey("localStorage", "privy:guest:abc").sensitivity).toBe("sensitive");
    expect(classifyStorageKey("localStorage", "privy:cross-app:app1").sensitivity).toBe("sensitive");
  });

  it("marks OAuth PKCE state as transient-sensitive", () => {
    expect(classifyStorageKey("localStorage", "privy:code_verifier").sensitivity).toBe("sensitive-transient");
    expect(classifyStorageKey("localStorage", "privy:state_code").sensitivity).toBe("sensitive-transient");
  });

  it("marks analytics/bookkeeping as non-sensitive", () => {
    for (const key of ["privy:caid", "privy:sent:app:1", "privy:active-user", "privy:saved-users", "privy:connections", "privy:__session_storage__test"]) {
      expect(classifyStorageKey("localStorage", key).sensitivity).toBe("non-sensitive");
    }
  });

  it("does not assume anything about unrecognised Privy keys", () => {
    expect(classifyStorageKey("localStorage", "privy:wallet:0xabc").sensitivity).toBe("unknown");
    expect(classifyStorageKey("localStorage", "privy:something_new").sensitivity).toBe("unknown");
    expect(classifyStorageKey("localStorage", "privy:something_new").owner).toBe("privy");
  });

  it("classifies the app's own keys", () => {
    expect(classifyStorageKey("localStorage", "onchain-finance:simulation").owner).toBe("app");
    expect(classifyStorageKey("localStorage", "onchain-finance:mode").sensitivity).toBe("non-sensitive");
    expect(classifyStorageKey("localStorage", "onchain-finance:poc:privy:pending-send").sensitivity).toBe("non-sensitive");
    expect(classifyStorageKey("localStorage", "onchain-finance:future").sensitivity).toBe("unknown");
  });

  it("classifies cookies: token mirrors sensitive, privy-session a marker", () => {
    expect(classifyStorageKey("cookie", "privy-token").sensitivity).toBe("sensitive");
    expect(classifyStorageKey("cookie", "privy-refresh-token").sensitivity).toBe("sensitive");
    expect(classifyStorageKey("cookie", "privy-id-token").sensitivity).toBe("sensitive");
    expect(classifyStorageKey("cookie", "privy-session").sensitivity).toBe("marker");
    expect(classifyStorageKey("cookie", "privy-new").sensitivity).toBe("unknown");
  });

  it("classifies transitive wallet-connector libraries as third-party", () => {
    expect(classifyStorageKey("localStorage", "wagmi.store").owner).toBe("third-party");
    expect(classifyStorageKey("localStorage", "wc@2:core:0.3//keychain").sensitivity).toBe("sensitive");
    expect(classifyStorageKey("localStorage", "wc@2:core:0.3//messages").sensitivity).toBe("non-sensitive");
    expect(classifyStorageKey("localStorage", "totally-random").owner).toBe("unknown");
  });
});

describe("evaluateSecurityGate", () => {
  const ctx = { authenticated: true, isLocalhost: false };

  it("is BLOCKED before there is an authenticated session to judge", () => {
    const gate = evaluateSecurityGate(snapshot(), { authenticated: false, isLocalhost: false });
    expect(gate.result).toBe("BLOCKED");
  });

  it("FAILS when a Privy access or refresh token is in localStorage (the SDK default)", () => {
    const gate = evaluateSecurityGate(snapshot({ localStorage: ["privy:token", "privy:refresh_token", "privy:caid"] }), ctx);
    expect(gate.result).toBe("FAIL");
    const failing = gate.findings.filter((f) => f.severity === "fail").map((f) => f.message);
    expect(failing).toHaveLength(2);
    expect(failing.join("\n")).toMatch(/privy:token/);
    expect(failing.join("\n")).toMatch(/privy:refresh_token/);
    // Values are never part of the output.
    expect(JSON.stringify(gate)).not.toMatch(/eyJ/);
  });

  it("FAILS on the js-sdk-core identity-token key (hyphen) as well as the React SDK's underscore alias", () => {
    expect(evaluateSecurityGate(snapshot({ localStorage: ["privy:id-token"] }), ctx).result).toBe("FAIL");
    expect(evaluateSecurityGate(snapshot({ localStorage: ["privy:id_token"] }), ctx).result).toBe("FAIL");
  });

  it("FAILS on sessionStorage too — temporary is not the same as safe", () => {
    const gate = evaluateSecurityGate(snapshot({ sessionStorage: ["privy:token"] }), ctx);
    expect(gate.result).toBe("FAIL");
    expect(gate.findings[0].message).toMatch(/^sessionStorage:/);
  });

  it("FAILS when a token cookie is visible to JavaScript (i.e. not HttpOnly)", () => {
    const gate = evaluateSecurityGate(snapshot({ cookies: ["privy-token", "privy-session"] }), ctx);
    expect(gate.result).toBe("FAIL");
    expect(gate.findings.find((f) => f.severity === "fail")?.message).toMatch(/NOT HttpOnly/);
  });

  it("FAILS if PKCE state lingers after login", () => {
    expect(evaluateSecurityGate(snapshot({ localStorage: ["privy:code_verifier"] }), ctx).result).toBe("FAIL");
    expect(evaluateSecurityGate(snapshot({ localStorage: ["privy:code_verifier"] }), { ...ctx, authenticated: false }).result).toBe("BLOCKED");
  });

  it("is BLOCKED (not PASS) when an unclassified Privy key is present", () => {
    const gate = evaluateSecurityGate(snapshot({ localStorage: ["privy:caid", "privy:wallet:0xabc"] }), ctx);
    expect(gate.result).toBe("BLOCKED");
  });

  it("PASSES a clean authenticated snapshot on a real domain, with the marker cookie", () => {
    const gate = evaluateSecurityGate(
      snapshot({ localStorage: ["privy:caid", "onchain-finance:mode"], cookies: ["privy-session"] }),
      ctx,
    );
    expect(gate.result).toBe("PASS");
    expect(gate.findings.map((f) => f.message).join("\n")).toMatch(/consistent with server-set/);
  });

  it("annotates localhost results as non-conclusive for production cookie mode", () => {
    const gate = evaluateSecurityGate(snapshot({ localStorage: ["privy:caid"] }), { authenticated: true, isLocalhost: true });
    expect(gate.result).toBe("PASS");
    expect(gate.findings.some((f) => f.severity === "info" && /localhost/.test(f.message))).toBe(true);
  });

  it("notes when IndexedDB enumeration is unavailable", () => {
    const gate = evaluateSecurityGate(snapshot({ indexedDB: null }), ctx);
    expect(gate.findings.some((f) => /indexedDB\.databases/.test(f.message))).toBe(true);
  });
});

describe("diffSnapshots", () => {
  it("reports added and removed keys per area", () => {
    const before = snapshot({ localStorage: ["a"], cookies: ["privy-session"] });
    const after = snapshot({ localStorage: ["a", "privy:token"], cookies: [] });
    expect(diffSnapshots(before, after)).toEqual({
      added: [{ area: "localStorage", key: "privy:token" }],
      removed: [{ area: "cookie", key: "privy-session" }],
    });
  });
});

describe("cookieNamesFromDocumentCookie", () => {
  it("returns names only, never values", () => {
    expect(cookieNamesFromDocumentCookie("privy-session=t; privy-token=eyJabc.def.ghi; flag")).toEqual([
      "privy-session",
      "privy-token",
      "flag",
    ]);
    expect(cookieNamesFromDocumentCookie("")).toEqual([]);
  });
});

describe("captureStorageSnapshot", () => {
  it("captures key names without values", async () => {
    localStorage.setItem("privy:token", "SECRET-VALUE-SHOULD-NOT-APPEAR");
    localStorage.setItem("onchain-finance:mode", "{}");
    try {
      const snap = await captureStorageSnapshot("TEST");
      expect(snap.label).toBe("TEST");
      expect(snap.localStorage).toEqual(["onchain-finance:mode", "privy:token"]);
      expect(JSON.stringify(snap)).not.toMatch(/SECRET-VALUE/);
    } finally {
      localStorage.removeItem("privy:token");
      localStorage.removeItem("onchain-finance:mode");
    }
  });
});
