/**
 * Safe inspection of script-accessible browser storage for the security
 * audit. Reports KEY/DATABASE/COOKIE NAMES ONLY — never values. There is no
 * code path here that reads a stored value.
 *
 * What this cannot see (and says so): HttpOnly cookies are invisible to
 * `document.cookie` by design — that is the property we want the CDP refresh
 * token to have. Their presence must be confirmed manually in DevTools
 * (Application → Cookies) or from the Set-Cookie response headers.
 */

export type StorageSnapshot = {
  takenAt: string;
  label: string;
  localStorageKeys: string[];
  sessionStorageKeys: string[];
  /** null when `indexedDB.databases()` is unavailable (Firefox < 126, some WebKit). */
  indexedDbNames: string[] | null;
  /** Names of cookies visible to script. HttpOnly cookies never appear here. */
  cookieNames: string[];
};

/**
 * Storage keys the installed `@coinbase/cdp-core@0.0.126` web build can write
 * (found by reading `dist/esm`). Used to flag CDP-owned keys in the audit UI.
 */
export const CDP_KNOWN_STORAGE_KEYS = {
  /** The refresh-token "mirror" — written whenever a verify/refresh response body carries `refreshToken`. Sensitive. */
  refreshTokenMirror: "cdp_refresh_token",
  /** CSRF state for an in-progress OAuth redirect. Not a credential. */
  oauthPendingFlowId: "cdp_oauth_pending_flow_id",
  /** Zustand persist store used only by `createCDPEmbeddedWallet` (EIP-1193 provider); holds chainId + user object. */
  providerStore: "cdp-provider-store",
} as const;

/** Keys whose presence in script-accessible storage fails the PoC's security gate. */
export const CDP_SENSITIVE_STORAGE_KEYS: readonly string[] = [CDP_KNOWN_STORAGE_KEYS.refreshTokenMirror];

function storageKeys(storage: Pick<Storage, "length" | "key"> | undefined): string[] {
  if (!storage) return [];
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key !== null) keys.push(key);
  }
  return keys.sort();
}

/** Parses `document.cookie` into names only. Never returns values. */
export function cookieNamesFromCookieString(cookieString: string): string[] {
  if (cookieString.trim() === "") return [];
  return cookieString
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair !== "")
    .map((pair) => {
      const eq = pair.indexOf("=");
      return eq === -1 ? pair : pair.slice(0, eq);
    })
    .sort();
}

export type StorageAuditSources = {
  localStorage?: Pick<Storage, "length" | "key">;
  sessionStorage?: Pick<Storage, "length" | "key">;
  cookieString?: string;
  listIndexedDbNames?: () => Promise<string[] | null>;
  now?: () => Date;
};

export async function takeStorageSnapshot(label: string, sources: StorageAuditSources): Promise<StorageSnapshot> {
  const indexedDbNames = sources.listIndexedDbNames ? await sources.listIndexedDbNames() : null;
  return {
    takenAt: (sources.now ?? (() => new Date()))().toISOString(),
    label,
    localStorageKeys: storageKeys(sources.localStorage),
    sessionStorageKeys: storageKeys(sources.sessionStorage),
    indexedDbNames,
    cookieNames: cookieNamesFromCookieString(sources.cookieString ?? ""),
  };
}

/** The real browser sources. Only call from client code. */
export function browserStorageSources(): StorageAuditSources {
  return {
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    cookieString: document.cookie,
    listIndexedDbNames: async () => {
      if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return null;
      try {
        const dbs = await indexedDB.databases();
        return dbs.map((db) => db.name ?? "(unnamed)").sort();
      } catch {
        return null;
      }
    },
  };
}

export type StorageGateResult = {
  verdict: "pass" | "fail";
  /** Sensitive CDP keys found in localStorage or sessionStorage. */
  sensitiveKeysFound: string[];
};

/** Applies the hard gate: any sensitive CDP key in script-accessible storage is a FAIL. */
export function evaluateStorageGate(snapshot: StorageSnapshot): StorageGateResult {
  const scriptAccessible = new Set([...snapshot.localStorageKeys, ...snapshot.sessionStorageKeys]);
  const sensitiveKeysFound = CDP_SENSITIVE_STORAGE_KEYS.filter((key) => scriptAccessible.has(key));
  return { verdict: sensitiveKeysFound.length === 0 ? "pass" : "fail", sensitiveKeysFound };
}

/** Keys present in `after` but not `before` — what an action added. */
export function diffKeys(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: after.filter((k) => !b.has(k)),
    removed: before.filter((k) => !a.has(k)),
  };
}
