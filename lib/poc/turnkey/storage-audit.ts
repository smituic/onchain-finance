import { STORAGE_AUDIT_STORAGE_KEY } from "./constants";
import type { StorageSnapshot } from "./storage";

function cookieNamesFromDocument(): string[] {
  if (typeof document === "undefined" || !document.cookie) return [];
  return document.cookie
    .split(";")
    .map((part) => part.trim().split("=")[0])
    .filter((name): name is string => Boolean(name));
}

export async function captureStorageSnapshot(at: string): Promise<StorageSnapshot> {
  const indexedDBNames =
    typeof indexedDB !== "undefined" && "databases" in indexedDB
      ? (await indexedDB.databases()).flatMap((database) => (database.name ? [database.name] : []))
      : [];

  return {
    at,
    localStorage: typeof localStorage === "undefined" ? [] : Object.keys(localStorage).sort(),
    sessionStorage: typeof sessionStorage === "undefined" ? [] : Object.keys(sessionStorage).sort(),
    indexedDB: indexedDBNames.sort(),
    cookies: cookieNamesFromDocument().sort(),
  };
}

export function loadStorageAuditLog(): StorageSnapshot[] {
  if (typeof localStorage === "undefined") return [];
  const raw = localStorage.getItem(STORAGE_AUDIT_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as StorageSnapshot[]) : [];
  } catch {
    return [];
  }
}

export function rememberStorageSnapshot(snapshot: StorageSnapshot): StorageSnapshot[] {
  const next = [...loadStorageAuditLog().filter((item) => item.at !== snapshot.at), snapshot];
  localStorage.setItem(STORAGE_AUDIT_STORAGE_KEY, JSON.stringify(next));
  return next;
}
