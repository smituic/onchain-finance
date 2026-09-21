export type StorageAuthority =
  | "none"
  | "app-identity"
  | "public-account"
  | "wallet-signing"
  | "unknown";

export type StorageSensitivity = "public" | "app-session" | "secret" | "unknown";

export type StorageVerdict = "acceptable" | "unacceptable" | "review";

export type StorageArtifact = {
  area: "localStorage" | "sessionStorage" | "indexedDB" | "cookie";
  name: string;
  authority: StorageAuthority;
  sensitivity: StorageSensitivity;
  verdict: StorageVerdict;
  reason: string;
};

export type StorageSnapshot = {
  at: string;
  localStorage: string[];
  sessionStorage: string[];
  indexedDB: string[];
  cookies: string[];
};

const KNOWN: Record<string, Omit<StorageArtifact, "area" | "name">> = {
  "onchain-finance:mode": {
    authority: "none",
    sensitivity: "public",
    verdict: "acceptable",
    reason: "Practice/Real UI preference. No wallet-signing authority.",
  },
  "onchain-finance:simulation": {
    authority: "none",
    sensitivity: "public",
    verdict: "acceptable",
    reason: "Practice fake-money ledger. Isolated from this PoC.",
  },
  "onchain-finance:turnkey-poc:public-account": {
    authority: "public-account",
    sensitivity: "public",
    verdict: "acceptable",
    reason: "Public Turnkey/Safe identifiers only. Cannot sign.",
  },
  "onchain-finance:turnkey-poc:pending-operation": {
    authority: "none",
    sensitivity: "public",
    verdict: "acceptable",
    reason: "Public userOperationHash/transactionHash/status. Cannot sign or resend.",
  },
  "onchain-finance:turnkey-poc:operation-history": {
    authority: "none",
    sensitivity: "public",
    verdict: "acceptable",
    reason: "Public operation references and hashes.",
  },
  "onchain-finance:turnkey-poc:storage-audit": {
    authority: "none",
    sensitivity: "public",
    verdict: "acceptable",
    reason: "Key-name-only audit log for this PoC.",
  },
  ocf_turnkey_poc_session: {
    authority: "app-identity",
    sensitivity: "app-session",
    verdict: "acceptable",
    reason: "HttpOnly app session of public identifiers. Must not be JS-readable or contain signing credentials.",
  },
};

const FORBIDDEN_NAME_PATTERN =
  /session.?key|indexed.?db.?stamper|turnkey.*session|api.?private|private.?key|seed.?phrase|bearer|stamper.?key|wallet.?auth.?token/i;

export function classifyStorageArtifact(
  area: StorageArtifact["area"],
  name: string,
  options: { httpOnly?: boolean } = {},
): StorageArtifact {
  const known = KNOWN[name];
  if (known) {
    if (name === "ocf_turnkey_poc_session" && area !== "cookie") {
      return {
        area,
        name,
        authority: "unknown",
        sensitivity: "unknown",
        verdict: "unacceptable",
        reason: "App session cookie name appeared in script-accessible storage.",
      };
    }
    if (name === "ocf_turnkey_poc_session" && area === "cookie" && options.httpOnly === false) {
      return {
        area,
        name,
        authority: "app-identity",
        sensitivity: "app-session",
        verdict: "unacceptable",
        reason: "App session cookie is script-readable; it must be HttpOnly.",
      };
    }
    return { area, name, ...known };
  }

  if (FORBIDDEN_NAME_PATTERN.test(name)) {
    return {
      area,
      name,
      authority: "wallet-signing",
      sensitivity: "secret",
      verdict: "unacceptable",
      reason: "Name matches a persistent signing/session credential pattern.",
    };
  }

  return {
    area,
    name,
    authority: "unknown",
    sensitivity: "unknown",
    verdict: "review",
    reason: "Unrecognized artifact. Classify by whether it grants unattended signing, not by name alone.",
  };
}

export function evaluateStorageSnapshots(snapshots: StorageSnapshot[]): {
  artifacts: StorageArtifact[];
  failed: boolean;
  reasons: string[];
} {
  const seen = new Map<string, StorageArtifact>();
  for (const snapshot of snapshots) {
    for (const name of snapshot.localStorage) {
      seen.set(`localStorage:${name}`, classifyStorageArtifact("localStorage", name));
    }
    for (const name of snapshot.sessionStorage) {
      seen.set(`sessionStorage:${name}`, classifyStorageArtifact("sessionStorage", name));
    }
    for (const name of snapshot.indexedDB) {
      seen.set(`indexedDB:${name}`, classifyStorageArtifact("indexedDB", name));
    }
    for (const name of snapshot.cookies) {
      seen.set(`cookie:${name}`, classifyStorageArtifact("cookie", name, { httpOnly: false }));
    }
  }

  const artifacts = [...seen.values()];
  const failedArtifacts = artifacts.filter((artifact) => artifact.verdict === "unacceptable");
  return {
    artifacts,
    failed: failedArtifacts.length > 0,
    reasons: failedArtifacts.map((artifact) => `${artifact.area}:${artifact.name} — ${artifact.reason}`),
  };
}
