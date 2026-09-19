/**
 * Privy PoC — browser persistence for the single pending-send record.
 * DISPOSABLE (see config.ts).
 *
 * Stores PUBLIC chain facts only (see `PendingSendRecord`). This is the one
 * localStorage key the PoC itself writes, and the storage audit classifies it
 * as non-sensitive app data.
 */
import { PENDING_SEND_STORAGE_KEY } from "./config";
import { parsePendingSendRecord, type PendingSendRecord } from "./send-status";

export function loadPendingSend(): PendingSendRecord | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PENDING_SEND_STORAGE_KEY);
    if (raw === null) return null;
    return parsePendingSendRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function savePendingSend(record: PendingSendRecord): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PENDING_SEND_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage unavailable (private mode / quota). The in-memory record still drives the UI.
  }
}

export function clearPendingSend(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(PENDING_SEND_STORAGE_KEY);
  } catch {
    // ignore
  }
}
