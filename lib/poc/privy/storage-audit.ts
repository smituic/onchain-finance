/**
 * Privy PoC — key-names-only browser storage audit and security gate.
 * DISPOSABLE (see config.ts).
 *
 * HARD RULE: this module never reads, stores, or returns a stored VALUE. It
 * works from key names, database names, and cookie names only. Anything
 * JavaScript cannot see (HttpOnly / Secure / SameSite / Domain / Path) is
 * left to the manual DevTools checklist rendered by the diagnostic page.
 *
 * Classification source of truth: the storage/cookie key constants found in
 * the installed `@privy-io/react-auth@3.44.0` bundle (privy-context chunk) and
 * `@privy-io/js-sdk-core@0.76.1`, not vendor prose. If Privy adds a key this
 * table does not know, it is reported as `unknown` and blocks a PASS.
 */

export type StorageArea = "localStorage" | "sessionStorage" | "indexedDB" | "cookie";

export type KeyOwner = "privy" | "app" | "third-party" | "unknown";

export type KeySensitivity =
  /** A credential or reusable authorisation: access/refresh/identity token, key share, guest credential. */
  | "sensitive"
  /** Sensitive only for the duration of an in-progress flow (e.g. OAuth PKCE verifier). */
  | "sensitive-transient"
  /** A presence flag with no secret content (e.g. "privy-session" = "t"). */
  | "marker"
  | "non-sensitive"
  | "unknown";

export type KeyClassification = {
  area: StorageArea;
  key: string;
  owner: KeyOwner;
  sensitivity: KeySensitivity;
  what: string;
};

export type StorageSnapshot = {
  label: string;
  capturedAtMs: number;
  origin: string;
  localStorage: string[];
  sessionStorage: string[];
  /** `null` when `indexedDB.databases()` is unavailable (older Firefox/WebKit). */
  indexedDB: string[] | null;
  /** Names of cookies visible to `document.cookie`. HttpOnly cookies never appear here. */
  cookies: string[];
};

type Rule = {
  test: (key: string) => boolean;
  owner: KeyOwner;
  sensitivity: KeySensitivity;
  what: string;
};

// Privy session keys may be namespaced per user in multi-user mode:
// `privy:<userId>:token`. The user id itself may contain ':' (did:privy:...),
// so match on the suffix.
const privySuffix = (suffix: string) => (key: string) =>
  key === `privy:${suffix}` || (key.startsWith("privy:") && key.endsWith(`:${suffix}`));

const WEB_STORAGE_RULES: Rule[] = [
  {
    test: privySuffix("token"),
    owner: "privy",
    sensitivity: "sensitive",
    what: "Privy customer access token (bearer JWT). Gates retrieval of the wallet auth share, i.e. it is a reusable signing authorisation for its lifetime.",
  },
  {
    test: privySuffix("pat"),
    owner: "privy",
    sensitivity: "sensitive",
    what: "Privy-scoped access token (bearer).",
  },
  {
    test: privySuffix("refresh_token"),
    owner: "privy",
    sensitivity: "sensitive",
    what: "Privy refresh token. Mints new access tokens for ~30 days. (In server-cookie mode Privy may store the literal placeholder \"deprecated\" here — verify manually; this audit does not read values.)",
  },
  {
    // js-sdk-core@0.76.1 writes `privy:id-token` (hyphen). The React SDK also
    // exports IDENTITY_TOKEN_STORAGE_KEY = `privy:id_token` (underscore). Match both.
    test: (k) => privySuffix("id-token")(k) || privySuffix("id_token")(k),
    owner: "privy",
    sensitivity: "sensitive",
    what: "Privy identity token (signed user-identity JWT for your backend).",
  },
  {
    test: (k) => k.startsWith("privy:guest:"),
    owner: "privy",
    sensitivity: "sensitive",
    what: "Privy guest-account credential.",
  },
  {
    test: (k) => k.startsWith("privy:cross-app:"),
    owner: "privy",
    sensitivity: "sensitive",
    what: "Cross-app provider access token.",
  },
  {
    test: (k) => k === "privy:code_verifier" || k === "privy:state_code",
    owner: "privy",
    sensitivity: "sensitive-transient",
    what: "OAuth PKCE verifier/state for an in-progress OAuth login. Should be cleared after the flow completes.",
  },
  {
    test: (k) => k === "privy:headless_oauth" || k === "privy:oauth_disable_signup",
    owner: "privy",
    sensitivity: "non-sensitive",
    what: "OAuth flow flags.",
  },
  {
    test: (k) => k === "privy:caid" || k.startsWith("privy:sent:"),
    owner: "privy",
    sensitivity: "non-sensitive",
    what: "Privy client analytics id / event de-duplication marker.",
  },
  {
    test: (k) => k === "privy:active-user" || k === "privy:saved-users",
    owner: "privy",
    sensitivity: "non-sensitive",
    what: "Multi-user session bookkeeping (user ids, not credentials).",
  },
  {
    test: (k) => k === "privy:connections" || k === "privy:connectors",
    owner: "privy",
    sensitivity: "non-sensitive",
    what: "External-wallet connector history (unused by this PoC).",
  },
  {
    test: (k) => k === "privy:__session_storage__test",
    owner: "privy",
    sensitivity: "non-sensitive",
    what: "Storage-availability probe.",
  },
  {
    test: (k) => k === "privy:wallet" || k.startsWith("privy:wallet:"),
    owner: "privy",
    sensitivity: "unknown",
    what: "Privy wallet-scoped key on the app origin. Contents unclassified — inspect manually (expected to be metadata, not key material; key shares live on the iframe origin).",
  },
  {
    test: (k) => k.startsWith("privy:") || k.startsWith("privy-"),
    owner: "privy",
    sensitivity: "unknown",
    what: "Privy key not in this audit's table. Inspect manually before declaring PASS.",
  },
  {
    test: (k) => k === "onchain-finance:simulation" || k === "onchain-finance:mode",
    owner: "app",
    sensitivity: "non-sensitive",
    what: "Practice ledger / mode preference (fake money, no credentials).",
  },
  {
    test: (k) => k === "onchain-finance:poc:privy:pending-send",
    owner: "app",
    sensitivity: "non-sensitive",
    what: "PoC pending-send record: public chain facts only.",
  },
  {
    test: (k) => k.startsWith("onchain-finance:"),
    owner: "app",
    sensitivity: "unknown",
    what: "App key not in this audit's table.",
  },
  {
    test: (k) => k.startsWith("wc@2:") && k.includes("keychain"),
    owner: "third-party",
    sensitivity: "sensitive",
    what: "WalletConnect keychain (symmetric session keys). Should not exist — this PoC uses no external wallets.",
  },
  {
    test: (k) => k.startsWith("__next") || k.startsWith("__nextjs"),
    owner: "third-party",
    sensitivity: "non-sensitive",
    what: "Next.js development tooling (dev server only).",
  },
  {
    test: (k) =>
      k.startsWith("wc@2:") ||
      k.startsWith("WALLETCONNECT_") ||
      k.startsWith("wagmi.") ||
      k.startsWith("-walletlink:") ||
      k.startsWith("cbwsdk.") ||
      k.startsWith("@appkit") ||
      k.startsWith("@w3m") ||
      k.startsWith("WCM_") ||
      k.startsWith("base-acc-sdk") ||
      k.startsWith("-CBWSDK"),
    owner: "third-party",
    sensitivity: "non-sensitive",
    what: "Wallet-connector library state pulled in transitively by @privy-io/react-auth (unused by this PoC).",
  },
];

const COOKIE_RULES: Rule[] = [
  {
    test: (k) => k === "privy-token",
    owner: "privy",
    sensitivity: "sensitive",
    what: "Access token as a cookie. If it is visible here it is NOT HttpOnly (client-written mirror).",
  },
  {
    test: (k) => k === "privy-refresh-token",
    owner: "privy",
    sensitivity: "sensitive",
    what: "Refresh token as a cookie. If visible here it is NOT HttpOnly.",
  },
  {
    test: (k) => k === "privy-id-token",
    owner: "privy",
    sensitivity: "sensitive",
    what: "Identity token as a cookie. If visible here it is NOT HttpOnly.",
  },
  {
    test: (k) => k === "privy-session",
    owner: "privy",
    sensitivity: "marker",
    what: "Presence marker (value is the literal \"t\"). Tells the SDK a refresh may be possible.",
  },
  {
    test: (k) => k.startsWith("privy"),
    owner: "privy",
    sensitivity: "unknown",
    what: "Privy cookie not in this audit's table.",
  },
];

const UNKNOWN: Omit<Rule, "test"> = {
  owner: "unknown",
  sensitivity: "unknown",
  what: "Not recognised by this audit.",
};

export function classifyStorageKey(area: StorageArea, key: string): KeyClassification {
  const rules = area === "cookie" ? COOKIE_RULES : WEB_STORAGE_RULES;
  const rule = rules.find((r) => r.test(key)) ?? UNKNOWN;
  return { area, key, owner: rule.owner, sensitivity: rule.sensitivity, what: rule.what };
}

export function classifySnapshot(snapshot: StorageSnapshot): KeyClassification[] {
  return [
    ...snapshot.localStorage.map((k) => classifyStorageKey("localStorage", k)),
    ...snapshot.sessionStorage.map((k) => classifyStorageKey("sessionStorage", k)),
    ...(snapshot.indexedDB ?? []).map((k) => classifyStorageKey("indexedDB", k)),
    ...snapshot.cookies.map((k) => classifyStorageKey("cookie", k)),
  ];
}

export type GateFinding = {
  severity: "fail" | "block" | "info";
  message: string;
};

export type SecurityGateResult = {
  result: "PASS" | "FAIL" | "BLOCKED";
  findings: GateFinding[];
};

export type SecurityGateContext = {
  /** Only an authenticated session can be judged; before that there is nothing to audit. */
  authenticated: boolean;
  isLocalhost: boolean;
};

/**
 * Evaluate the hard requirement: no sensitive credential in JS-readable
 * persistent storage. `sessionStorage` is judged by the same rule (it is
 * still script-readable); the finding says which area it was.
 */
export function evaluateSecurityGate(
  snapshot: StorageSnapshot,
  ctx: SecurityGateContext,
): SecurityGateResult {
  const findings: GateFinding[] = [];
  const classified = classifySnapshot(snapshot);

  if (!ctx.authenticated) {
    findings.push({
      severity: "block",
      message: "No authenticated Privy session in this snapshot — sign in, then capture again.",
    });
  }

  for (const c of classified) {
    if (c.sensitivity === "sensitive") {
      findings.push({
        severity: "fail",
        message: `${c.area}: "${c.key}" — ${c.what}`,
      });
    } else if (c.sensitivity === "sensitive-transient") {
      findings.push({
        severity: ctx.authenticated ? "fail" : "info",
        message: `${c.area}: "${c.key}" — ${c.what}${ctx.authenticated ? " Still present after login: treat as a leak." : ""}`,
      });
    } else if (c.sensitivity === "unknown" && c.owner !== "third-party") {
      findings.push({
        severity: "block",
        message: `${c.area}: "${c.key}" — ${c.what}`,
      });
    }
  }

  if (snapshot.indexedDB === null) {
    findings.push({
      severity: "info",
      message: "indexedDB.databases() is unavailable in this browser; check the Application panel manually.",
    });
  }

  const sessionMarker = snapshot.cookies.includes("privy-session");
  const refreshInStorage = snapshot.localStorage.some((k) => privySuffix("refresh_token")(k));
  if (sessionMarker && !refreshInStorage) {
    findings.push({
      severity: "info",
      message:
        "privy-session marker present with no privy:refresh_token in localStorage — consistent with server-set (HttpOnly) cookie mode. Confirm HttpOnly/Secure/SameSite/Domain in DevTools.",
    });
  }

  if (ctx.isLocalhost) {
    findings.push({
      severity: "info",
      message:
        "Running on localhost. Privy's server-set HttpOnly cookie mode is only exercised on a verified production domain, so a clean result here does not prove production behaviour.",
    });
  }

  if (findings.some((f) => f.severity === "fail")) return { result: "FAIL", findings };
  if (findings.some((f) => f.severity === "block")) return { result: "BLOCKED", findings };
  return { result: "PASS", findings };
}

export type SnapshotDiff = {
  added: { area: StorageArea; key: string }[];
  removed: { area: StorageArea; key: string }[];
};

export function diffSnapshots(before: StorageSnapshot, after: StorageSnapshot): SnapshotDiff {
  const areas: ("localStorage" | "sessionStorage")[] = ["localStorage", "sessionStorage"];
  const added: SnapshotDiff["added"] = [];
  const removed: SnapshotDiff["removed"] = [];
  const compare = (area: StorageArea, b: string[], a: string[]) => {
    const bs = new Set(b);
    const as = new Set(a);
    for (const k of as) if (!bs.has(k)) added.push({ area, key: k });
    for (const k of bs) if (!as.has(k)) removed.push({ area, key: k });
  };
  for (const area of areas) compare(area, before[area], after[area]);
  compare("indexedDB", before.indexedDB ?? [], after.indexedDB ?? []);
  compare("cookie", before.cookies, after.cookies);
  return { added, removed };
}

/** Parse `document.cookie` into names only. Never returns values. */
export function cookieNamesFromDocumentCookie(cookieHeader: string): string[] {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const eq = part.indexOf("=");
      return eq === -1 ? part : part.slice(0, eq);
    })
    .filter((name) => name.length > 0);
}

/** Browser I/O: capture key/database/cookie NAMES. Values are never touched. */
export async function captureStorageSnapshot(label: string): Promise<StorageSnapshot> {
  const keysOf = (storage: Storage | undefined): string[] => {
    if (!storage) return [];
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key !== null) keys.push(key);
    }
    return keys.sort();
  };

  let indexedDbNames: string[] | null = null;
  try {
    if (typeof indexedDB !== "undefined" && typeof indexedDB.databases === "function") {
      const dbs = await indexedDB.databases();
      indexedDbNames = dbs.map((db) => db.name ?? "(unnamed)").sort();
    }
  } catch {
    indexedDbNames = null;
  }

  return {
    label,
    capturedAtMs: Date.now(),
    origin: typeof window !== "undefined" ? window.location.origin : "",
    localStorage: keysOf(typeof window !== "undefined" ? window.localStorage : undefined),
    sessionStorage: keysOf(typeof window !== "undefined" ? window.sessionStorage : undefined),
    indexedDB: indexedDbNames,
    cookies: cookieNamesFromDocumentCookie(typeof document !== "undefined" ? document.cookie : "").sort(),
  };
}
