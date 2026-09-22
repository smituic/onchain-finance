import { create } from "zustand";
import type { RealPaymentAttemptState } from "./real-payment-store";

/**
 * Batch 2e: read-only, unpersisted, fetch-only — mirrors
 * real-balance-store.ts's shape exactly. Only one action, fetchHistory,
 * used for both the initial load and the manual Refresh button; there is
 * deliberately no checkStatus/reconcile action here — this store must never
 * call anything but GET /api/real/payments/history.
 */
export type PaymentHistoryEntry = {
  id: string;
  recipient: string;
  amountBaseUnits: string;
  state: RealPaymentAttemptState;
  transactionHash: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RealPaymentHistoryStatus = "idle" | "loading" | "ready" | "unauthenticated" | "error";

export type RealPaymentHistoryStore = {
  entries: PaymentHistoryEntry[];
  status: RealPaymentHistoryStatus;
  error: string | null;
  fetchHistory: () => Promise<void>;
  reset: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createRealPaymentHistoryStore() {
  return create<RealPaymentHistoryStore>()((set) => ({
    entries: [],
    status: "idle",
    error: null,

    fetchHistory: async () => {
      set({ status: "loading", error: null });
      try {
        const response = await fetch("/api/real/payments/history?limit=10");
        if (response.status === 401) {
          set({ status: "unauthenticated", entries: [], error: null });
          return;
        }
        // The body is untrusted shape until proven otherwise — never assert
        // it into a type and trust it. A response that fails to parse as
        // JSON at all falls through to the same "malformed" handling below
        // (body stays null, isRecord(null) is false).
        const body: unknown = await response.json().catch(() => null);

        if (!response.ok) {
          const message = isRecord(body) && typeof body.error === "string" ? body.error : `Could not load your recent payments (${response.status}).`;
          set({ status: "error", error: message });
          return;
        }

        // A 200 that isn't shaped like { entries: [...] } is malformed, not
        // empty — coercing it to [] would render a false "no payments yet"
        // for what might actually be a server bug hiding real history.
        if (!isRecord(body) || !Array.isArray(body.entries)) {
          set({ status: "error", error: "Received an unexpected response while loading your recent payments." });
          return;
        }

        set({ entries: body.entries as PaymentHistoryEntry[], status: "ready", error: null });
      } catch (error) {
        set({ status: "error", error: error instanceof Error ? error.message : "Could not load your recent payments." });
      }
    },

    reset: () => set({ entries: [], status: "idle", error: null }),
  }));
}

export const useRealPaymentHistoryStore = createRealPaymentHistoryStore();
