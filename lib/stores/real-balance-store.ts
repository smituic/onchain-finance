import { create } from "zustand";

/**
 * Narrow, unpersisted: the balance shown here is public chain data, never
 * authority for anything, and re-fetching is cheap — so unlike
 * real-account-store.ts's `account`, there is no localStorage cache to keep
 * honest across reloads. Every mount asks the server fresh, and the server
 * always re-derives the Safe address from the session (see
 * lib/real/server/balance.ts) rather than trusting anything cached here.
 */
export type RealCashBalance = {
  token: "USDC";
  decimals: number;
  balanceBaseUnits: string;
};

export type RealBalanceStatus = "idle" | "loading" | "ready" | "unauthenticated" | "error";

export type RealBalanceStore = {
  balance: RealCashBalance | null;
  status: RealBalanceStatus;
  error: string | null;
  fetchBalance: () => Promise<void>;
  reset: () => void;
};

export function createRealBalanceStore() {
  // Pre-2f hardening: a monotonically increasing generation token. A request
  // started under one account can resolve after a newer fetchBalance() call
  // or a reset() (account switch/logout) has already run — without this, its
  // stale result could overwrite fresher (or intentionally cleared) state.
  // Each fetchBalance() captures the generation current at its own start;
  // reset() and every subsequent fetchBalance() bump it, so a stale response
  // fails its check and becomes a no-op instead of a clobber.
  let generation = 0;

  return create<RealBalanceStore>()((set) => ({
    balance: null,
    status: "idle",
    error: null,

    fetchBalance: async () => {
      const myGeneration = ++generation;
      set({ status: "loading", error: null });
      try {
        const response = await fetch("/api/real/account/balance");
        if (response.status === 401) {
          if (myGeneration === generation) set({ status: "unauthenticated", balance: null, error: null });
          return;
        }
        const json = (await response.json()) as (RealCashBalance & { error?: string }) | { error: string };
        if (!response.ok) {
          // An RPC/read failure is a distinct state from "$0.00" — never
          // fall back to displaying a zero balance here.
          if (myGeneration === generation) set({ status: "error", balance: null, error: "error" in json ? json.error : `Could not read your balance (${response.status}).` });
          return;
        }
        if (myGeneration === generation) set({ balance: json as RealCashBalance, status: "ready", error: null });
      } catch (error) {
        if (myGeneration === generation) set({ status: "error", balance: null, error: error instanceof Error ? error.message : "Could not read your balance." });
      }
    },

    reset: () => {
      generation++;
      set({ balance: null, status: "idle", error: null });
    },
  }));
}

export const useRealBalanceStore = createRealBalanceStore();
