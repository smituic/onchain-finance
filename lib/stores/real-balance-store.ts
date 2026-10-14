import { create } from "zustand";
import { useRealAccountStore } from "./real-account-store";

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

/**
 * "rate_limited" (3A-1 Stage 2C-1): the server refused this read because the
 * account's chain-read budget is spent (HTTP 429, code "rate_limited"). It is
 * not an error in the read and not a balance of zero — there is simply no
 * balance to show until the server will answer again.
 */
export type RealBalanceStatus = "idle" | "loading" | "ready" | "unauthenticated" | "rate_limited" | "error";

export type RealBalanceStore = {
  balance: RealCashBalance | null;
  status: RealBalanceStatus;
  error: string | null;
  /**
   * The server's validated Retry-After for the current denial, in whole
   * seconds (1 … MAX_RETRY_AFTER_SECONDS). Null when there is none or it was
   * unusable — a local fallback cooldown is then in force, and nothing here
   * pretends to know how long the real wait is.
   */
  retryAfterSeconds: number | null;
  /** True while a denial's cooldown is running: Refresh/Retry sends nothing. Flipped by ONE store timer — never derived from Date.now() in a render. */
  isCoolingDown: boolean;
  fetchBalance: () => Promise<void>;
  reset: () => void;
};

/** The longest wait the server's chain-read policy can produce (its daily window). Anything longer is not a delay this policy could have sent. */
export const MAX_RETRY_AFTER_SECONDS = 86_400;
/** Used when a 429 carries no usable Retry-After: conservative, so repeated presses can't hammer a limiter that just said no. */
export const FALLBACK_COOLDOWN_MS = 60_000;

/**
 * Accepts only a plain positive whole number of seconds within the policy's
 * range: no sign, fraction, exponent, HTTP-date, list, or padding of zeros —
 * and never NaN, Infinity, zero, or an unbounded duration. Anything else is
 * null (and the caller falls back to FALLBACK_COOLDOWN_MS).
 */
export function parseRetryAfterSeconds(raw: string | null | undefined): number | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!/^[1-9]\d{0,5}$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= MAX_RETRY_AFTER_SECONDS ? seconds : null;
}

/** Who a cooldown belongs to: the signed-in account's canonical id (never a Safe address alone). */
function currentSubject(): string | null {
  return useRealAccountStore.getState().account?.appUserId ?? null;
}

export function createRealBalanceStore() {
  // Pre-2f hardening: a monotonically increasing generation token. A request
  // started under one account can resolve after a newer fetchBalance() call
  // or a reset() (account switch/logout) has already run — without this, its
  // stale result could overwrite fresher (or intentionally cleared) state.
  // Each fetchBalance() captures the generation current at its own start;
  // reset() and every subsequent fetchBalance() bump it, so a stale response
  // fails its check and becomes a no-op instead of a clobber.
  //
  // Deliberately NOT deduplicated beyond that: a second call can exist
  // precisely because something just changed (a payment confirmed), and
  // joining a read that began before the change would return the old balance.
  // Latest-request-wins keeps every call fresh; the cooldown below is what
  // stops repeated requests once the server has said no.
  let generation = 0;

  // One cooldown at most, owned by the account that was refused. `subject` is
  // null only when nobody is signed in (store-only use) — such a cooldown is
  // never carried across a reset().
  let cooldown: { untilMs: number; subject: string | null; serverSeconds: number | null } | null = null;
  let cooldownTimer: ReturnType<typeof setTimeout> | null = null;

  function clearCooldownTimer() {
    if (cooldownTimer !== null) {
      clearTimeout(cooldownTimer);
      cooldownTimer = null;
    }
  }

  function clearCooldown() {
    clearCooldownTimer();
    cooldown = null;
  }

  /** The cooldown, only if it is unexpired AND belongs to whoever is signed in now. A stale one is dropped on sight. */
  function activeCooldown() {
    if (cooldown && cooldown.subject === currentSubject() && Date.now() < cooldown.untilMs) return cooldown;
    if (cooldown) clearCooldown();
    return null;
  }

  return create<RealBalanceStore>()((set, get) => {
    function startCooldown(serverSeconds: number | null) {
      clearCooldownTimer();
      const ms = serverSeconds === null ? FALLBACK_COOLDOWN_MS : serverSeconds * 1000;
      const mine = { untilMs: Date.now() + ms, subject: currentSubject(), serverSeconds };
      cooldown = mine;
      // ONE timer, bounded by the policy's longest window (< 2^31 ms), replaced
      // by the next denial and cleared by any reset that drops the cooldown.
      cooldownTimer = setTimeout(() => {
        cooldownTimer = null;
        if (cooldown === mine) set({ isCoolingDown: false });
      }, ms);
    }

    return {
      balance: null,
      status: "idle",
      error: null,
      retryAfterSeconds: null,
      isCoolingDown: false,

      fetchBalance: async () => {
        // A cooldown that is still running means the server just refused this
        // account: send nothing, and say so (once — repeated presses re-render nothing).
        const waiting = activeCooldown();
        if (waiting) {
          if (get().status !== "rate_limited" && get().status !== "error") {
            set({ status: "rate_limited", balance: null, error: null, retryAfterSeconds: waiting.serverSeconds, isCoolingDown: true });
          }
          return;
        }

        const myGeneration = ++generation;
        set({ status: "loading", error: null, retryAfterSeconds: null, isCoolingDown: false });
        try {
          const response = await fetch("/api/real/account/balance");
          if (response.status === 401) {
            if (myGeneration === generation) {
              clearCooldown();
              set({ status: "unauthenticated", balance: null, error: null, retryAfterSeconds: null, isCoolingDown: false });
            }
            return;
          }
          if (response.status === 429) {
            // The server's own budget refusal. Its body is read defensively: a
            // 429 from anywhere else (no JSON, no code) is still "slow down",
            // but is shown as an ordinary failure rather than as our budget.
            let body: { code?: unknown; error?: unknown } | null = null;
            try {
              body = (await response.json()) as { code?: unknown; error?: unknown };
            } catch {
              body = null;
            }
            if (myGeneration !== generation) return;
            const isBudgetDenial = body?.code === "rate_limited";
            const serverSeconds = parseRetryAfterSeconds(response.headers?.get?.("Retry-After"));
            startCooldown(serverSeconds);
            if (isBudgetDenial) {
              set({ status: "rate_limited", balance: null, error: null, retryAfterSeconds: serverSeconds, isCoolingDown: true });
            } else {
              set({ status: "error", balance: null, error: typeof body?.error === "string" ? body.error : "Could not read your balance (429).", retryAfterSeconds: null, isCoolingDown: true });
            }
            return;
          }
          const json = (await response.json()) as (RealCashBalance & { error?: string }) | { error: string };
          if (!response.ok) {
            // An RPC/read failure is a distinct state from "$0.00" — never
            // fall back to displaying a zero balance here.
            if (myGeneration === generation) {
              set({ status: "error", balance: null, error: "error" in json ? json.error : `Could not read your balance (${response.status}).`, retryAfterSeconds: null, isCoolingDown: false });
            }
            return;
          }
          if (myGeneration === generation) {
            clearCooldown();
            set({ balance: json as RealCashBalance, status: "ready", error: null, retryAfterSeconds: null, isCoolingDown: false });
          }
        } catch (error) {
          if (myGeneration === generation) {
            set({ status: "error", balance: null, error: error instanceof Error ? error.message : "Could not read your balance.", retryAfterSeconds: null, isCoolingDown: false });
          }
        }
      },

      reset: () => {
        generation++;
        // The balance is always dropped (account isolation). A cooldown is only
        // a fact about the server's budget for ONE signed-in account, so it
        // survives a reset (navigation, remount) for that same account and for
        // no one else: another account, or nobody, starts clean.
        const kept = cooldown && cooldown.subject !== null && cooldown.subject === currentSubject() && Date.now() < cooldown.untilMs ? cooldown : null;
        if (!kept) clearCooldown();
        set({ balance: null, status: "idle", error: null, retryAfterSeconds: kept ? kept.serverSeconds : null, isCoolingDown: kept !== null });
      },
    };
  });
}

export const useRealBalanceStore = createRealBalanceStore();
