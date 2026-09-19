import { describe, expect, it } from "vitest";
import {
  CDP_KNOWN_STORAGE_KEYS,
  cookieNamesFromCookieString,
  diffKeys,
  evaluateStorageGate,
  takeStorageSnapshot,
  type StorageSnapshot,
} from "@/lib/poc/cdp/storage-audit";

function fakeStorage(entries: Record<string, string>): Pick<Storage, "length" | "key"> {
  const keys = Object.keys(entries);
  return { length: keys.length, key: (i) => keys[i] ?? null };
}

const FIXED_NOW = new Date("2026-09-19T07:00:00.000Z");

describe("cookieNamesFromCookieString", () => {
  it("returns names only, sorted, never values", () => {
    const names = cookieNamesFromCookieString("zeta=secret-value-1; alpha=another=with=equals;  flagonly ");
    expect(names).toEqual(["alpha", "flagonly", "zeta"]);
    expect(names.join(" ")).not.toContain("secret");
  });

  it("handles an empty cookie string", () => {
    expect(cookieNamesFromCookieString("")).toEqual([]);
    expect(cookieNamesFromCookieString("   ")).toEqual([]);
  });
});

describe("takeStorageSnapshot", () => {
  it("captures key names from every source and no values", async () => {
    const snap = await takeStorageSnapshot("t", {
      localStorage: fakeStorage({ "onchain-finance:mode": '{"mode":"real"}', cdp_oauth_pending_flow_id: "flow-123" }),
      sessionStorage: fakeStorage({ tmp: "v" }),
      cookieString: "a=1; b=2",
      listIndexedDbNames: async () => ["some-db"],
      now: () => FIXED_NOW,
    });
    expect(snap).toEqual<StorageSnapshot>({
      takenAt: FIXED_NOW.toISOString(),
      label: "t",
      localStorageKeys: ["cdp_oauth_pending_flow_id", "onchain-finance:mode"],
      sessionStorageKeys: ["tmp"],
      indexedDbNames: ["some-db"],
      cookieNames: ["a", "b"],
    });
    expect(JSON.stringify(snap)).not.toContain("flow-123");
    expect(JSON.stringify(snap)).not.toContain('"real"');
  });

  it("reports IndexedDB as null when the browser cannot enumerate databases", async () => {
    const snap = await takeStorageSnapshot("t", { listIndexedDbNames: async () => null, now: () => FIXED_NOW });
    expect(snap.indexedDbNames).toBeNull();
    expect(snap.localStorageKeys).toEqual([]);
  });
});

describe("evaluateStorageGate", () => {
  const base: StorageSnapshot = {
    takenAt: FIXED_NOW.toISOString(),
    label: "t",
    localStorageKeys: [],
    sessionStorageKeys: [],
    indexedDbNames: null,
    cookieNames: [],
  };

  it("passes when only non-sensitive keys are present", () => {
    const r = evaluateStorageGate({
      ...base,
      localStorageKeys: ["onchain-finance:mode", CDP_KNOWN_STORAGE_KEYS.oauthPendingFlowId, CDP_KNOWN_STORAGE_KEYS.providerStore],
    });
    expect(r).toEqual({ verdict: "pass", sensitiveKeysFound: [] });
  });

  it("fails when the CDP refresh-token mirror is in localStorage", () => {
    const r = evaluateStorageGate({ ...base, localStorageKeys: [CDP_KNOWN_STORAGE_KEYS.refreshTokenMirror] });
    expect(r.verdict).toBe("fail");
    expect(r.sensitiveKeysFound).toEqual(["cdp_refresh_token"]);
  });

  it("fails when it is in sessionStorage too", () => {
    const r = evaluateStorageGate({ ...base, sessionStorageKeys: [CDP_KNOWN_STORAGE_KEYS.refreshTokenMirror] });
    expect(r.verdict).toBe("fail");
  });

  it("does not treat a same-named script-visible cookie as a storage failure (cookies are audited manually for HttpOnly)", () => {
    const r = evaluateStorageGate({ ...base, cookieNames: ["cdp_refresh_token"] });
    expect(r.verdict).toBe("pass");
  });
});

describe("diffKeys", () => {
  it("reports what an action added and removed", () => {
    expect(diffKeys(["a", "b"], ["b", "c"])).toEqual({ added: ["c"], removed: ["a"] });
    expect(diffKeys([], [])).toEqual({ added: [], removed: [] });
  });
});
