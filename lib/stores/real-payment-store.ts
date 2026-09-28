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
   * is cancel; no resend/retry. Slice S1: also an awaiting_authorization
   * attempt this session can't approve (bound to another passkey, or
   * prepared before binding existed).
   */
  | "stranded";

export type RealPaymentStore = {
  status: RealPaymentStatus;
  recipientInput: string;
  amountInput: string;
  attempt: RealPaymentAttempt | null;
  subOrganizationId: string | null;
  /** The ONE passkey the server bound this payment to (from /prepare or /latest) — the only credential the signing prompt may offer. Null means this session can't approve the attempt. */
  authorizingCredentialId: string | null;
  /**
   * A signature + Turnkey activity already produced for `attemptId` but not
   * yet accepted by /submit (the server couldn't confirm the approval yet,
   * or the request never got a definitive answer). "Continue" re-sends THIS
   * instead of prompting for the passkey again — the server's CAS still
   * allows at most one dispatch. Memory only; gone on reload.
   */
  pendingSubmission: { attemptId: string; signature: string; activityId: string } | null;
  /**
   * Part E (S2): serverNowSeconds - Math.floor(Date.now()/1000), captured
   * from the most recent /prepare, /latest, or /status response. Used only
   * to derive an ADVISORY local "now" (adjustedNowSeconds = local Date.now()
   * + this offset) for UX gates — never sent back to the server, never used
   * to extend a payment's validity. The server independently and
   * authoritatively re-checks validUntil at /submit against its own clock
   * regardless of anything the client computes.
   */
  clockOffsetSeconds: number;
  /**
   * Part B (S2): true once the current awaiting_authorization/stranded
   * attempt's own validUntil has passed (adjusted by clockOffsetSeconds),
   * but the server hasn't yet resolved it to a terminal state. Computed in
   * the store (scheduleOrRunExpiryCheck), never read from Date.now() inside
   * a component render — React components/hooks must stay pure. Drives
   * real-pay-form.tsx's presentation; never used to claim "No money moved"
   * on its own, only the terminal `failed` state (with its server-proven
   * failureReason) does that.
   */
  isAttemptPastValidity: boolean;
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

class ApiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** Mirrors lib/stores/real-account-store.ts's own `api` helper: throws Error(message) on a non-2xx response so call sites use ordinary try/catch. `retryable` marks the server's "nothing changed, try the same request again" answer. */
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const json = (await response.json()) as T & { error?: string; retryable?: boolean };
  if (!response.ok) throw new ApiError(json.error ?? `Request failed (${response.status}).`, json.retryable === true);
  return json;
}

const OTHER_PASSKEY_MESSAGE = "This payment was started with a different passkey. Cancel it and start a new payment.";
const CANCEL_LOST_RACE_MESSAGE = "This payment could not be cancelled — it may already be on its way.";
const CANCEL_UNCONFIRMED_MESSAGE = "Could not confirm whether this payment was cancelled. Check its status before trying again.";

/**
 * Part B: cadence of the follow-up /status check while an expired attempt is
 * still waiting for Base finality (~20 min behind validUntil). Deliberately
 * slow — one request per 75 s per open page, at most one timer outstanding.
 */
export const EXPIRY_FOLLOW_UP_MS = 75_000;

/** Part E: serverNowSeconds - local Date.now() — an advisory offset, never sent back to the server or used to extend validity. */
function computeClockOffsetSeconds(serverNowSeconds: number): number {
  return serverNowSeconds - Math.floor(Date.now() / 1000);
}

/**
 * Part B: pure "is this attempt past its own validUntil right now" check —
 * shared by scheduleOrRunExpiryCheck (which also decides whether to
 * schedule/run a reconciliation) and checkStatus (which only needs the flag
 * kept correct after any status-changing response, not just the ones
 * scheduleOrRunExpiryCheck itself triggers). A legacy/malformed row with no
 * finite validUntil is never "past validity" — same guarantee the server
 * enforces (payments.ts's toPublicAttempt).
 */
function isAttemptPastValidityNow(attempt: RealPaymentAttempt | null, status: RealPaymentStatus, clockOffsetSeconds: number): boolean {
  if (status !== "awaiting_authorization" && status !== "stranded") return false;
  const validUntil = attempt?.prepared?.validUntil;
  if (typeof validUntil !== "number" || !Number.isFinite(validUntil)) return false;
  return validUntil <= Math.floor(Date.now() / 1000) + clockOffsetSeconds;
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

async function authorizeAndSubmit(
  set: (partial: Partial<RealPaymentStore>) => void,
  get: () => RealPaymentStore,
  scheduleExpiryCheck: () => Promise<void>,
): Promise<void> {
  const { attempt, subOrganizationId, authorizingCredentialId, pendingSubmission, clockOffsetSeconds } = get();
  const account = useRealAccountStore.getState().account;
  if (!attempt?.prepared || !subOrganizationId || !account) {
    set({ status: "editing", error: "You're signed out." });
    return;
  }
  if (!authorizingCredentialId) {
    set({ status: "stranded", error: OTHER_PASSKEY_MESSAGE });
    return;
  }

  let signed = pendingSubmission?.attemptId === attempt.id ? pendingSubmission : null;
  if (!signed) {
    set({ isAuthorizing: true, error: null });
    try {
      const result = await signPreparedPayment({
        fields: attempt.prepared,
        rpId: process.env.NEXT_PUBLIC_REAL_RP_ID ?? "localhost",
        subOrganizationId,
        ownerAddress: account.ownerAddress,
        rpcUrl: process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
        authorizingCredentialId,
        // Part E: local Date.now() adjusted by the server-derived offset —
        // never raw local time — so a skewed browser clock can't falsely
        // refuse a payment the server would still accept.
        nowSeconds: Math.floor(Date.now() / 1000) + clockOffsetSeconds,
      });
      signed = { attemptId: attempt.id, ...result };
    } catch (error) {
      if (isWebAuthnCancellation(error)) {
        // No signature, no submission, no balance mutation — but the durable
        // row is still awaiting_authorization and still holds the account's
        // one active-payment slot. Stay on this same pending payment
        // (Continue / Cancel payment); never a fresh compose form that implies
        // nothing is pending. The attempt is not touched or re-bound.
        set({ status: "awaiting_authorization", isAuthorizing: false, error: null });
        await scheduleExpiryCheck();
        return;
      }
      set({ status: "awaiting_authorization", isAuthorizing: false, error: error instanceof Error ? error.message : "Could not authorize the payment." });
      await scheduleExpiryCheck();
      return;
    }
  }

  set({ status: "submitting", isAuthorizing: false, pendingSubmission: signed, error: null });
  try {
    const result = await api<{ attempt: RealPaymentAttempt }>("/api/real/payments/submit", {
      method: "POST",
      body: JSON.stringify({ attemptId: signed.attemptId, signature: signed.signature, activityId: signed.activityId }),
    });
    set({ status: mapAttemptStateToStatus(result.attempt.state), attempt: result.attempt, pendingSubmission: null, error: null });
    if (result.attempt.state === "confirmed") void useRealBalanceStore.getState().fetchBalance();
  } catch (error) {
    if (error instanceof ApiError && error.retryable) {
      // The server changed nothing and sent nothing. Keep the same approval
      // so "Continue" re-sends it — no second passkey prompt.
      set({ status: "awaiting_authorization", error: error.message });
      await scheduleExpiryCheck();
      return;
    }
    // A thrown error here means either a definitive HTTP-level refusal or a
    // network failure after a signature exists (the request may have
    // reached the server, or even the bundler, before failing) — either way
    // this is genuinely ambiguous and must never unlock an automatic resend.
    // The approval stays in memory: if a status check later shows the
    // attempt still awaiting, "Continue" re-sends it (the server's CAS keeps
    // that to at most one dispatch) rather than asking for a new signature.
    set({ status: "unknown", error: error instanceof Error ? error.message : "Lost connection while sending the payment." });
  }
}

export function createRealPaymentStore() {
  // Generation token: bumped by init() and reset() (mount / account switch /
  // logout). Every async path that applies a server response — init's
  // /latest, checkStatus, cancel, the expiry timer — captures it (and the
  // attempt id) before awaiting and discards its result if either changed.
  let generation = 0;
  // Part B: at most ONE outstanding expiry timer per store. Every arm clears
  // the previous one first, and init()/reset()/a successful cancel clear it.
  let expiryTimeoutId: ReturnType<typeof setTimeout> | null = null;

  function clearExpiryTimeout() {
    if (expiryTimeoutId !== null) {
      clearTimeout(expiryTimeoutId);
      expiryTimeoutId = null;
    }
  }

  return create<RealPaymentStore>()((set, get) => {
    function isExpiryRelevant(state: Pick<RealPaymentStore, "status" | "attempt">): boolean {
      const validUntil = state.attempt?.prepared?.validUntil;
      return (state.status === "awaiting_authorization" || state.status === "stranded") && typeof validUntil === "number" && Number.isFinite(validUntil);
    }

    function armExpiryTimer(delayMs: number) {
      clearExpiryTimeout();
      const attemptId = get().attempt?.id;
      const myGeneration = generation;
      expiryTimeoutId = setTimeout(
        () => {
          expiryTimeoutId = null;
          const current = get();
          if (myGeneration !== generation || current.attempt?.id !== attemptId || !isExpiryRelevant(current)) return;
          void runExpiryCheck();
        },
        // Clamped: a delay above 2^31-1 ms would overflow and fire immediately.
        Math.min(Math.max(0, delayMs), 2_147_483_647),
      );
    }

    /**
     * One /status reconciliation for an attempt believed past validUntil.
     * Base finality usually lags validUntil by ~20 min, so the first answer
     * is normally the same non-terminal attempt; in that case exactly one
     * low-frequency follow-up (EXPIRY_FOLLOW_UP_MS) is armed. Stops as soon
     * as the attempt is terminal/non-expiry-relevant, a different attempt, or
     * a different generation.
     */
    async function runExpiryCheck(): Promise<void> {
      const attemptId = get().attempt?.id;
      const myGeneration = generation;
      await get().checkStatus();
      const current = get();
      if (myGeneration !== generation || current.attempt?.id !== attemptId || !isExpiryRelevant(current)) return;
      armExpiryTimer(EXPIRY_FOLLOW_UP_MS);
    }

    /**
     * Part B (S2): if the current awaiting_authorization/stranded attempt is
     * already past validUntil, reconcile now (and follow up slowly while it
     * stays non-terminal); otherwise arm one timer for the instant validUntil
     * passes. Never a rapid poll. Returns a promise so init() can await the
     * immediate case — its first render then reflects the reconciled state.
     */
    function scheduleOrRunExpiryCheck(): Promise<void> {
      clearExpiryTimeout();
      const { attempt, status, clockOffsetSeconds } = get();
      // Computed here (plain store logic), never read from Date.now() inside
      // the component's render — see isAttemptPastValidity's doc comment.
      const pastValidity = isAttemptPastValidityNow(attempt, status, clockOffsetSeconds);
      set({ isAttemptPastValidity: pastValidity });
      if (!isExpiryRelevant({ attempt, status })) return Promise.resolve();
      if (pastValidity) return runExpiryCheck();
      const adjustedNowSeconds = Math.floor(Date.now() / 1000) + clockOffsetSeconds;
      // +1 s: the server treats an attempt as expired only strictly after validUntil.
      armExpiryTimer((attempt!.prepared!.validUntil - adjustedNowSeconds + 1) * 1000);
      return Promise.resolve();
    }

    return {
      status: "idle",
      recipientInput: "",
      amountInput: "",
      attempt: null,
      subOrganizationId: null,
      authorizingCredentialId: null,
      pendingSubmission: null,
      isAuthorizing: false,
      clockOffsetSeconds: 0,
      isAttemptPastValidity: false,
      error: null,

      init: async () => {
        const myGeneration = ++generation;
        clearExpiryTimeout();
        // Pre-2f hardening: clear any prior account's recipient/amount/
        // attempt/error as the FIRST synchronous action, before the fetch —
        // so "reset before init" holds regardless of which caller invokes
        // this (see components/real/real-pay-form.tsx's account-change
        // effect). Without this, a stale recipient/amount typed under one
        // account could survive into a different signed-in account.
        set({ status: "idle", recipientInput: "", amountInput: "", attempt: null, subOrganizationId: null, authorizingCredentialId: null, pendingSubmission: null, isAuthorizing: false, clockOffsetSeconds: 0, isAttemptPastValidity: false, error: null });
        try {
          const response = await fetch("/api/real/payments/latest");
          if (response.status === 401) {
            if (myGeneration === generation) set({ status: "editing", attempt: null, subOrganizationId: null, isAttemptPastValidity: false });
            return;
          }
          const json = (await response.json()) as {
            attempt: RealPaymentAttempt | null;
            subOrganizationId?: string | null;
            authorizingCredentialId?: string | null;
            serverNowSeconds?: number;
            error?: string;
          };
          if (!response.ok || !json.attempt) {
            if (myGeneration === generation) set({ status: "editing", attempt: null, subOrganizationId: null, isAttemptPastValidity: false });
            return;
          }
          if (myGeneration === generation) {
            // Slice S1: awaiting a signature but with no signing context means
            // this session's passkey isn't the one the payment is bound to (or
            // it predates binding) — cancel-only, never re-bound here.
            const notResumable = json.attempt.state === "awaiting_authorization" && (!json.subOrganizationId || !json.authorizingCredentialId);
            set({
              status: notResumable ? "stranded" : mapAttemptStateToStatus(json.attempt.state),
              attempt: json.attempt,
              subOrganizationId: json.subOrganizationId ?? null,
              authorizingCredentialId: json.authorizingCredentialId ?? null,
              clockOffsetSeconds: typeof json.serverNowSeconds === "number" ? computeClockOffsetSeconds(json.serverNowSeconds) : 0,
              error: notResumable ? OTHER_PASSKEY_MESSAGE : null,
            });
            await scheduleOrRunExpiryCheck();
          }
        } catch {
          if (myGeneration === generation) set({ status: "editing" });
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
          const result = await api<{ attempt: RealPaymentAttempt; subOrganizationId: string; authorizingCredentialId: string; serverNowSeconds: number }>("/api/real/payments/prepare", {
            method: "POST",
            body: JSON.stringify({ recipient, amountBaseUnits }),
          });
          set({
            status: "awaiting_authorization",
            attempt: result.attempt,
            subOrganizationId: result.subOrganizationId,
            authorizingCredentialId: result.authorizingCredentialId,
            pendingSubmission: null,
            clockOffsetSeconds: computeClockOffsetSeconds(result.serverNowSeconds),
            error: null,
          });
          await scheduleOrRunExpiryCheck();
        } catch (error) {
          set({ status: "editing", error: error instanceof Error ? error.message : "Could not prepare the payment." });
          return;
        }

        await authorizeAndSubmit(set, get, scheduleOrRunExpiryCheck);
      },

      resumeAuthorization: async () => {
        if (get().status !== "awaiting_authorization") return;
        await authorizeAndSubmit(set, get, scheduleOrRunExpiryCheck);
      },

      cancel: async () => {
        const attempt = get().attempt;
        if (!attempt) {
          set({ status: "editing" });
          return;
        }
        const myGeneration = generation;
        // A reset/account switch/new attempt while in flight: this result no longer applies.
        const isCurrent = () => myGeneration === generation && get().attempt?.id === attempt.id;

        let response: Response;
        try {
          response = await fetch(`/api/real/payments/${attempt.id}/cancel`, { method: "POST" });
        } catch {
          // Part D: a network-level failure means we don't know whether the
          // request ever reached the server — never imply cancellation
          // succeeded and never reset to a fresh editable state on a guess.
          // Preserve the existing attempt/status exactly as they were.
          if (isCurrent()) set({ error: CANCEL_UNCONFIRMED_MESSAGE });
          return;
        }
        if (!isCurrent()) return;

        if (response.ok) {
          clearExpiryTimeout();
          set({
            status: "editing",
            attempt: null,
            subOrganizationId: null,
            authorizingCredentialId: null,
            pendingSubmission: null,
            isAuthorizing: false,
            recipientInput: "",
            amountInput: "",
            isAttemptPastValidity: false,
            error: null,
          });
          return;
        }

        // Part D: a non-2xx (e.g. 409 — a concurrent submit already won the
        // race) means cancellation did NOT happen. Never show a false
        // "cancelled" state — re-fetch the real durable state instead.
        try {
          const result = await api<{ attempt: RealPaymentAttempt; serverNowSeconds: number }>(`/api/real/payments/${attempt.id}/status`);
          if (!isCurrent() || result.attempt.id !== attempt.id) return;
          set({
            status: mapAttemptStateToStatus(result.attempt.state),
            attempt: result.attempt,
            clockOffsetSeconds: computeClockOffsetSeconds(result.serverNowSeconds),
            error: CANCEL_LOST_RACE_MESSAGE,
          });
          await scheduleOrRunExpiryCheck();
        } catch {
          // Couldn't confirm the real state either — preserve what we had
          // rather than guessing in either direction.
          if (isCurrent()) set({ error: CANCEL_UNCONFIRMED_MESSAGE });
        }
      },

      checkStatus: async () => {
        const attempt = get().attempt;
        if (!attempt) return;
        // S2: captured before the await, verified after it — a response for
        // a previous generation (reset / account switch) or a previous
        // attempt is discarded entirely, never applied over the current one.
        const myGeneration = generation;
        const isCurrent = () => myGeneration === generation && get().attempt?.id === attempt.id;
        try {
          const result = await api<{ attempt: RealPaymentAttempt; serverNowSeconds: number }>(`/api/real/payments/${attempt.id}/status`);
          if (!isCurrent() || result.attempt.id !== attempt.id) return;
          const nextStatus = mapAttemptStateToStatus(result.attempt.state);
          const offset = computeClockOffsetSeconds(result.serverNowSeconds);
          set({
            status: nextStatus,
            attempt: result.attempt,
            clockOffsetSeconds: offset,
            // Recomputed here too (not only in scheduleOrRunExpiryCheck) so a
            // standalone checkStatus() call (the manual "Check status"
            // button, the post-submit one-shot check) never leaves a stale
            // isAttemptPastValidity from before this response.
            isAttemptPastValidity: isAttemptPastValidityNow(result.attempt, nextStatus, offset),
            error: null,
          });
          if (result.attempt.state === "confirmed") void useRealBalanceStore.getState().fetchBalance();
        } catch (error) {
          if (isCurrent()) set({ error: error instanceof Error ? error.message : "Could not check payment status." });
        }
      },

      reset: () => {
        generation++;
        clearExpiryTimeout();
        set({ status: "editing", attempt: null, subOrganizationId: null, authorizingCredentialId: null, pendingSubmission: null, isAuthorizing: false, recipientInput: "", amountInput: "", error: null });
      },
    };
  });
}

export const useRealPaymentStore = createRealPaymentStore();
