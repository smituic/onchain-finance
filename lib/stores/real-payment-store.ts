import { create } from "zustand";
import { normalizeAddress } from "@/lib/real/identifiers";
import { exceedsAvailableBalance, exceedsPaymentCeiling, isZeroBaseUnits, MAX_PAYMENT_BASE_UNITS, parseCashInputToBaseUnits } from "@/lib/real/payments/amount";
import { formatCashBaseUnits } from "@/lib/real/display/cash";
import { REAL_CASH_TOKEN } from "@/lib/real/constants";
import { signPreparedPayment } from "@/lib/real/payments/client-sign";
import { isWebAuthnCancellation } from "@/lib/real/signing/passkey";
import type { WirePreparedFields } from "@/lib/real/payments/prepared-operation";
import { useRealAccountStore } from "./real-account-store";
import { useRealBalanceStore } from "./real-balance-store";

/**
 * Deliberately NOT imported from "viem" (would trip the noChainSdk ESLint
 * fence — lib/stores/** stays outside lib/real/**, see eslint.config.mjs):
 * every field this store touches is wire-shaped (plain strings), converted
 * to bigint/Address/Hex only inside lib/real/payments/client-sign.ts, which
 * is allowed to import viem because it lives under lib/real/**.
 */
export type RealPaymentAttemptState =
  | "prepared"
  | "awaiting_authorization"
  | "signed"
  | "submitting"
  | "submitted"
  | "confirmed"
  | "failed"
  | "cancelled"
  | "unknown";

export type RealPaymentAttempt = {
  id: string;
  state: RealPaymentAttemptState;
  recipient: string;
  amountBaseUnits: string;
  transactionHash: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
  prepared: WirePreparedFields | null;
};

export type RealPaymentStatus =
  | "idle"
  | "editing"
  | "reviewing"
  | "preparing"
  | "awaiting_authorization"
  | "submitting"
  | "submitted"
  | "confirmed"
  | "failed"
  | "unknown"
  /**
   * Pre-2f hardening: a reload-restored attempt that is provably
   * pre-dispatch (prepared/signed) but not the normal "waiting for a first
   * signature" case (that's "awaiting_authorization"). Never reachable via
   * a fresh confirmAndSend/resumeAuthorization flow — only via init()
   * restoring an attempt a crash left mid-flight. The only action offered
   * is cancel; no resend/retry.
   */
  | "stranded";

export type RealPaymentStore = {
  status: RealPaymentStatus;
  recipientInput: string;
  amountInput: string;
  attempt: RealPaymentAttempt | null;
  subOrganizationId: string | null;
  error: string | null;
  /** True only while a WebAuthn ceremony is actually in flight — distinct from status "awaiting_authorization", which is also the state a reload-restored, not-yet-resumed attempt sits in without ever having triggered a prompt. The UI uses this to tell "the passkey sheet is open right now" apart from "tap Continue to open it". */
  isAuthorizing: boolean;
  /** Reload/restore: never signs, never submits, never resends — see server/payments.ts's resolveLatestPayment. */
  init: () => Promise<void>;
  setRecipientInput: (value: string) => void;
  setAmountInput: (value: string) => void;
  review: () => void;
  editAgain: () => void;
  /** Fresh flow: prepare -> sign -> submit, from the "reviewing" status. */
  confirmAndSend: () => Promise<void>;
  /** Resume flow after a reload finds a still-awaiting_authorization attempt: sign -> submit for the SAME persisted attempt, never a new one. */
  resumeAuthorization: () => Promise<void>;
  /** Abandons an awaiting_authorization attempt so it stops occupying the account's one-active-attempt slot. */
  cancel: () => Promise<void>;
  checkStatus: () => Promise<void>;
  reset: () => void;
};

/** Mirrors lib/stores/real-account-store.ts's own `api` helper: throws Error(message) on a non-2xx response so call sites use ordinary try/catch. */
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const json = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(json.error ?? `Request failed (${response.status}).`);
  return json;
}

function mapAttemptStateToStatus(state: RealPaymentAttemptState): RealPaymentStatus {
  switch (state) {
    case "awaiting_authorization":
      return "awaiting_authorization";
    case "signed":
      // Pre-2f hardening: a "signed" row is now durably observable via
      // reload — resolveSubmitPayment's try/catch (server/payments.ts)
      // resolves almost every failure in this window to "failed", but a
      // process crash inside that exact window can still leave one at
      // "signed". Provably pre-dispatch (nothing was ever sent), so this
      // maps to "stranded" (cancel-only), never "submitting"/"unknown"
      // (which would wrongly imply it might already be in flight).
      return "stranded";
    case "submitting":
      // Durably reachable: the server persists this BEFORE calling the
      // bundler, specifically so a crash here survives as reconcile-only.
      // Mapped to the same "unknown" UI bucket as a genuinely ambiguous
      // outcome — from the client's perspective both mean "don't know yet,
      // check status, never resend".
      return "unknown";
    case "submitted":
      return "submitted";
    case "confirmed":
      return "confirmed";
    case "failed":
      return "failed";
    case "unknown":
      return "unknown";
    case "cancelled":
      return "editing";
    case "prepared":
      // Never durably returned by resolvePreparePayment in normal
      // operation (it always moves the row to awaiting_authorization or
      // failed before responding) — only reachable via a crash in the
      // narrow window between reserve() and that transition. Provably
      // pre-dispatch, same as "signed" above — cancel-only, not "unknown".
      return "stranded";
  }
}

async function authorizeAndSubmit(set: (partial: Partial<RealPaymentStore>) => void, get: () => RealPaymentStore): Promise<void> {
  const { attempt, subOrganizationId } = get();
  const account = useRealAccountStore.getState().account;
  if (!attempt?.prepared || !subOrganizationId || !account) {
    set({ status: "editing", error: "You're signed out." });
    return;
  }

  set({ isAuthorizing: true, error: null });
  let signature: string;
  try {
    signature = await signPreparedPayment({
      fields: attempt.prepared,
      rpId: process.env.NEXT_PUBLIC_REAL_RP_ID ?? "localhost",
      subOrganizationId,
      ownerAddress: account.ownerAddress,
      rpcUrl: process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
    });
  } catch (error) {
    if (isWebAuthnCancellation(error)) {
      // No signature, no submission, no balance mutation — clean return to
      // an editable state, exactly as the product spec requires.
      set({ status: "reviewing", isAuthorizing: false, error: null });
      return;
    }
    set({ status: "awaiting_authorization", isAuthorizing: false, error: error instanceof Error ? error.message : "Could not authorize the payment." });
    return;
  }

  set({ status: "submitting", isAuthorizing: false, error: null });
  try {
    const result = await api<{ attempt: RealPaymentAttempt }>("/api/real/payments/submit", {
      method: "POST",
      body: JSON.stringify({ attemptId: attempt.id, signature }),
    });
    set({ status: mapAttemptStateToStatus(result.attempt.state), attempt: result.attempt, error: null });
    if (result.attempt.state === "confirmed") void useRealBalanceStore.getState().fetchBalance();
  } catch (error) {
    // A thrown error here means either a definitive HTTP-level refusal or a
    // network failure after a signature exists (the request may have
    // reached the server, or even the bundler, before failing) — either way
    // this is genuinely ambiguous and must never unlock an automatic resend.
    set({ status: "unknown", error: error instanceof Error ? error.message : "Lost connection while sending the payment." });
  }
}

export function createRealPaymentStore() {
  return create<RealPaymentStore>()((set, get) => ({
    status: "idle",
    recipientInput: "",
    amountInput: "",
    attempt: null,
    subOrganizationId: null,
    isAuthorizing: false,
    error: null,

    init: async () => {
      // Pre-2f hardening: clear any prior account's recipient/amount/
      // attempt/error as the FIRST synchronous action, before the fetch —
      // so "reset before init" holds regardless of which caller invokes
      // this (see components/real/real-pay-form.tsx's account-change
      // effect). Without this, a stale recipient/amount typed under one
      // account could survive into a different signed-in account.
      set({ status: "idle", recipientInput: "", amountInput: "", attempt: null, subOrganizationId: null, isAuthorizing: false, error: null });
      try {
        const response = await fetch("/api/real/payments/latest");
        if (response.status === 401) {
          set({ status: "editing", attempt: null, subOrganizationId: null });
          return;
        }
        const json = (await response.json()) as { attempt: RealPaymentAttempt | null; subOrganizationId?: string | null; error?: string };
        if (!response.ok || !json.attempt) {
          set({ status: "editing", attempt: null, subOrganizationId: null });
          return;
        }
        set({
          status: mapAttemptStateToStatus(json.attempt.state),
          attempt: json.attempt,
          subOrganizationId: json.subOrganizationId ?? null,
        });
      } catch {
        set({ status: "editing" });
      }
    },

    setRecipientInput: (value) => set({ recipientInput: value, error: null }),
    setAmountInput: (value) => set({ amountInput: value, error: null }),

    review: () => {
      const { recipientInput, amountInput } = get();
      const recipient = normalizeAddress(recipientInput);
      if (!recipient) {
        set({ error: "Enter a valid recipient address." });
        return;
      }
      const amountBaseUnits = parseCashInputToBaseUnits(amountInput);
      if (!amountBaseUnits || isZeroBaseUnits(amountBaseUnits)) {
        set({ error: "Enter an amount greater than zero." });
        return;
      }
      if (exceedsPaymentCeiling(amountBaseUnits)) {
        set({ error: `Payments are limited to ${formatCashBaseUnits(MAX_PAYMENT_BASE_UNITS, REAL_CASH_TOKEN.decimals)} each for now.` });
        return;
      }
      const balance = useRealBalanceStore.getState().balance;
      if (balance && exceedsAvailableBalance(amountBaseUnits, balance.balanceBaseUnits)) {
        set({ error: "That's more than your available Cash." });
        return;
      }
      set({ status: "reviewing", error: null });
    },

    editAgain: () => set({ status: "editing", error: null }),

    confirmAndSend: async () => {
      if (get().status !== "reviewing") return; // guards a double-tap from re-firing prepare
      const recipient = normalizeAddress(get().recipientInput);
      const amountBaseUnits = parseCashInputToBaseUnits(get().amountInput);
      if (!recipient || !amountBaseUnits) {
        set({ status: "editing", error: "Enter a valid recipient and amount." });
        return;
      }

      set({ status: "preparing", error: null });
      try {
        const result = await api<{ attempt: RealPaymentAttempt; subOrganizationId: string }>("/api/real/payments/prepare", {
          method: "POST",
          body: JSON.stringify({ recipient, amountBaseUnits }),
        });
        set({ status: "awaiting_authorization", attempt: result.attempt, subOrganizationId: result.subOrganizationId, error: null });
      } catch (error) {
        set({ status: "editing", error: error instanceof Error ? error.message : "Could not prepare the payment." });
        return;
      }

      await authorizeAndSubmit(set, get);
    },

    resumeAuthorization: async () => {
      if (get().status !== "awaiting_authorization") return;
      await authorizeAndSubmit(set, get);
    },

    cancel: async () => {
      const attempt = get().attempt;
      if (!attempt) {
        set({ status: "editing" });
        return;
      }
      try {
        await fetch(`/api/real/payments/${attempt.id}/cancel`, { method: "POST" });
      } catch {
        // Best-effort — the attempt may already be terminal server-side
        // (e.g. it resolved between the last read and this call); either
        // way, the client returns to a fresh editable state.
      }
      set({ status: "editing", attempt: null, subOrganizationId: null, isAuthorizing: false, recipientInput: "", amountInput: "", error: null });
    },

    checkStatus: async () => {
      const attempt = get().attempt;
      if (!attempt) return;
      try {
        const result = await api<{ attempt: RealPaymentAttempt }>(`/api/real/payments/${attempt.id}/status`);
        set({ status: mapAttemptStateToStatus(result.attempt.state), attempt: result.attempt, error: null });
        if (result.attempt.state === "confirmed") void useRealBalanceStore.getState().fetchBalance();
      } catch (error) {
        set({ error: error instanceof Error ? error.message : "Could not check payment status." });
      }
    },

    reset: () => set({ status: "editing", attempt: null, subOrganizationId: null, isAuthorizing: false, recipientInput: "", amountInput: "", error: null }),
  }));
}

export const useRealPaymentStore = createRealPaymentStore();
